// @ts-check
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const {
  isAllowedHttpsHost,
  assertSafePublicHttpsUrlSyntax,
  assertSafePublicHttpsUrl,
} = require('../../launcher/securityAndPathUtils.cjs');
const { loadSavedTokensAsync, saveTokensAsync } = require('../tokenVault.cjs');
const { classifyNonGameStorefrontItem } = require('../nonGameClassifier.cjs');
const storefrontLocalCacheFederator = require('../../launcher/storefrontLocalCacheFederator.cjs');
const {
  GOG_CLIENT_ID,
  GOG_CLIENT_SECRET,
  GOG_REDIRECT_URI,
  buildStoreFetchSignal,
  buildPlatformStoreUserAgent,
  resolveDefaultStoreLocaleAndCountry,
  extractVerifiedOAuthCode,
  resolveStoreVaultOptions,
  runSingleFlightTokenRenewal,
  attachStoreSyncCallMetadata,
  classifyAchievementRarityTier,
  readBoundedResponseBuffer,
} = require('../sync/storeSyncShared.cjs');

const inflateAsync = promisify(zlib.inflate);

const MAX_GOG_CLIENT_ID_CACHE_ENTRIES = 2000;
const MAX_GOG_MANIFEST_COMPRESSED_BYTES = 2 * 1024 * 1024; // 2 MB cap (C2)
const MAX_GOG_MANIFEST_INFLATED_BYTES = 4 * 1024 * 1024; // 4 MB zlib inflate cap (C2)
const GOG_MANIFEST_ALLOWED_HOSTS = Object.freeze(['gog.com', 'gog-statics.com']);
const MAX_GOG_ACHIEVEMENT_PAGES = 20;
const MAX_GOG_OWNED_PAGES = 100;

/** @type {Map<string, string>} */
const gogClientIdCache = new Map();

/**
 * @param {string} productId
 * @param {string} clientId
 */
function setBoundedGogClientIdCache(productId, clientId) {
  const key = String(productId || '').trim();
  const val = String(clientId || '').trim();
  if (!key || !val) return;
  if (gogClientIdCache.has(key)) gogClientIdCache.delete(key);
  gogClientIdCache.set(key, val);
  while (gogClientIdCache.size > MAX_GOG_CLIENT_ID_CACHE_ENTRIES) {
    const oldest = gogClientIdCache.keys().next().value;
    if (oldest === undefined) break;
    gogClientIdCache.delete(oldest);
  }
}

/**
 * Exchange GOG Authorization Code for Access & Refresh Tokens via POST form body (never query string).
 *
 * @param {string} code
 * @param {Record<string, any>} [options]
 */
async function exchangeGogCode(code, options = {}) {
  const fetchImpl = typeof options?.fetchFn === 'function' ? options.fetchFn : fetch;
  const vaultOpts = resolveStoreVaultOptions(options);
  const cleanCode = extractVerifiedOAuthCode(code, ['embed.gog.com', 'auth.gog.com', 'www.gog.com']);
  const body = new URLSearchParams({
    client_id: GOG_CLIENT_ID,
    client_secret: GOG_CLIENT_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: GOG_REDIRECT_URI,
    code: cleanCode,
  });

  const res = await fetchImpl('https://auth.gog.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': buildPlatformStoreUserAgent('GOGGalaxy/2.0'),
    },
    body: body.toString(),
    signal: buildStoreFetchSignal(options?.signal),
  });

  if (!res.ok) {
    throw new Error(`GOG token exchange failed (HTTP ${res.status})`);
  }

  const data = /** @type {Record<string, any>} */ (await res.json());
  if (!data.access_token) {
    throw new Error('GOG token response missing access_token');
  }

  const persisted =
    !data.expires_at && Number(data.expires_in) > 0
      ? { ...data, expires_at: new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() }
      : data;

  await saveTokensAsync('gog', persisted, vaultOpts);
  return persisted;
}

/**
 * Automatically renew GOG access token using refresh_token via POST form body.
 * Deduplicates single-flight per `gog:${resolvedVaultPath}` using SHA-256 refresh keys and
 * isolated caller `AbortSignal`s.
 *
 * @param {string} refreshToken
 * @param {Record<string, any>} [options]
 */
async function renewGogTokens(refreshToken, options = {}) {
  const fetchImpl = typeof options?.fetchFn === 'function' ? options.fetchFn : fetch;
  return runSingleFlightTokenRenewal({
    storefrontId: 'gog',
    refreshToken,
    options,
    performRefresh: async (effectiveRefreshToken, internalSignal) => {
      const body = new URLSearchParams({
        client_id: GOG_CLIENT_ID,
        client_secret: GOG_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: effectiveRefreshToken,
      });
      const res = await fetchImpl('https://auth.gog.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': buildPlatformStoreUserAgent('GOGGalaxy/2.0'),
        },
        body: body.toString(),
        signal: internalSignal,
      });

      if (!res.ok) {
        throw new Error(`Failed to renew GOG token (HTTP ${res.status})`);
      }

      return /** @type {Record<string, any>} */ (await res.json());
    },
  });
}

/**
 * Normalize GOG avatar URLs (handling protocol-relative `//images.gog-statics.com/<hash>`).
 *
 * @param {any} rawAvatar
 * @param {any} [avatarsObj]
 * @returns {string | undefined}
 */
function normalizeGogAvatarUrl(rawAvatar, avatarsObj) {
  const candidates = [];
  if (avatarsObj && typeof avatarsObj === 'object') {
    candidates.push(
      avatarsObj.menu_user_av_big2,
      avatarsObj.menu_user_av_big,
      avatarsObj.large_2x,
      avatarsObj.large,
      avatarsObj.sdk_img_184,
      avatarsObj.medium_2x,
      avatarsObj.medium,
      avatarsObj.menu_big_2,
      avatarsObj.menu_big,
      avatarsObj.menu_user_av_small2,
      avatarsObj.menu_user_av_small,
      avatarsObj.small_2x,
      avatarsObj.small
    );
  }
  if (rawAvatar && typeof rawAvatar === 'object') {
    candidates.push(
      rawAvatar.large_2x,
      rawAvatar.large,
      rawAvatar.sdk_img_184,
      rawAvatar.medium_2x,
      rawAvatar.medium,
      rawAvatar.menu_big_2,
      rawAvatar.menu_big,
      rawAvatar.menu_user_av_big2,
      rawAvatar.menu_user_av_big,
      rawAvatar.small_2x,
      rawAvatar.small
    );
  } else if (typeof rawAvatar === 'string' && rawAvatar.trim()) {
    candidates.push(rawAvatar.trim());
  }

  for (const cand of candidates) {
    if (typeof cand !== 'string' || !cand.trim()) continue;
    let url = cand.trim();
    if (url.startsWith('//')) {
      url = `https:${url}`;
    } else if (url.startsWith('http://')) {
      url = `https://${url.slice(7)}`;
    }
    if (/^https:\/\/images\.gog(-statics)?\.com\/[0-9a-f]{32,64}$/i.test(url)) {
      url = `${url}_menu_user_av_big2.jpg`;
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && parsed.hostname) {
        return parsed.toString();
      }
    } catch {}
  }
  return undefined;
}

/**
 * Fetch GOG Account Details.
 *
 * @param {string} accessToken
 * @param {Record<string, any>} [options]
 */
async function fetchGogAccount(accessToken, options = {}) {
  const fetchImpl = typeof options?.fetchFn === 'function' ? options.fetchFn : fetch;
  const vaultOpts = resolveStoreVaultOptions(options);
  const res = await fetchImpl('https://menu.gog.com/v1/account/basic', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': buildPlatformStoreUserAgent('GOGGalaxy/2.0'),
    },
    signal: buildStoreFetchSignal(options?.signal),
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`GOG account token expired (${res.status})`);
    }
    return {
      username: 'GOG User',
      avatarUrl: undefined,
    };
  }

  const data = /** @type {any} */ (await res.json());
  let username = data.username || 'GOG User';
  const userId = data.userId;
  let avatarUrl = normalizeGogAvatarUrl(data.avatar, data.avatars);

  if ((!avatarUrl || username === 'GOG User') && userId) {
    try {
      const userRes = await fetchImpl(`https://users.gog.com/users/${encodeURIComponent(userId)}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': buildPlatformStoreUserAgent('GOGGalaxy/2.0'),
        },
        signal: buildStoreFetchSignal(options?.signal),
      });
      if (userRes.ok) {
        const userJson = /** @type {any} */ (await userRes.json());
        if (userJson?.username && username === 'GOG User') {
          username = userJson.username;
        }
        const fallbackAvatar = normalizeGogAvatarUrl(userJson?.avatar, userJson?.avatars);
        if (fallbackAvatar) {
          avatarUrl = fallbackAvatar;
        }
      }
    } catch {}
  }

  try {
    const existing = await loadSavedTokensAsync(vaultOpts);
    if (existing?.gog && typeof existing.gog === 'object') {
      await saveTokensAsync(
        'gog',
        {
          ...existing.gog,
          user_id: userId || existing.gog.user_id,
          username: username !== 'GOG User' ? username : existing.gog.username,
          avatarUrl: avatarUrl || existing.gog.avatarUrl,
        },
        vaultOpts
      );
    }
  } catch {}

  return {
    username,
    userId,
    avatarUrl,
  };
}

/**
 * Universal zero-auth GOG `productId -> clientId` resolution via `content-system.gog.com`
 * v2 builds + async `zlib.inflate` manifest, hardened with host allowlist, public HTTPS SSRF check,
 * 2 MB compressed download cap, and 4 MB `zlib.inflate` output cap (`C2`).
 *
 * @param {string | number} productId
 * @param {Record<string, any>} [options]
 * @returns {Promise<string | null>}
 */
async function resolveGogClientId(productId, options = {}) {
  const cleanProductId = String(productId || '')
    .replace(/^gog[-_]/i, '')
    .trim();
  if (!cleanProductId || !/^\d+$/.test(cleanProductId)) {
    return null;
  }

  if (!options.forceRefresh && gogClientIdCache.has(cleanProductId)) {
    const cached = gogClientIdCache.get(cleanProductId) || null;
    if (cached) {
      gogClientIdCache.delete(cleanProductId);
      gogClientIdCache.set(cleanProductId, cached);
    }
    return cached;
  }

  const hasCustomFetch = typeof options?.fetchFn === 'function';
  const fetchImpl = hasCustomFetch ? options.fetchFn : fetch;
  const headers = {
    Accept: 'application/json',
    'User-Agent': buildPlatformStoreUserAgent('GOGGalaxy/2.0'),
  };

  const MAX_GOG_MANIFEST_REDIRECTS = 3;
  /**
   * @param {string} initialUrl
   * @param {Record<string, string>} reqHeaders
   * @returns {Promise<any | null>}
   */
  const fetchGogAllowlistedHttps = async (initialUrl, reqHeaders) => {
    let currentUrl = String(initialUrl || '').trim();
    for (let hop = 0; hop <= MAX_GOG_MANIFEST_REDIRECTS; hop++) {
      if (!isAllowedHttpsHost(currentUrl, GOG_MANIFEST_ALLOWED_HOSTS)) {
        console.warn('Blocked non-GOG manifest link host during clientId resolution');
        return null;
      }
      assertSafePublicHttpsUrlSyntax(currentUrl);
      if (!hasCustomFetch || options.enforceDnsCheck === true) {
        await assertSafePublicHttpsUrl(
          currentUrl,
          typeof options.dnsLookup === 'function' ? { dnsLookup: options.dnsLookup } : {}
        );
      }

      const res = await fetchImpl(currentUrl, {
        headers: reqHeaders,
        redirect: 'manual',
        signal: buildStoreFetchSignal(options?.signal),
      });
      const status = Number(res?.status || 0);
      if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
        const locationHeader =
          res?.headers && typeof res.headers.get === 'function'
            ? res.headers.get('location')
            : '';
        try {
          await res?.body?.cancel?.();
        } catch {}
        if (
          !locationHeader ||
          !String(locationHeader).trim() ||
          hop >= MAX_GOG_MANIFEST_REDIRECTS
        ) {
          return null;
        }
        currentUrl = new URL(String(locationHeader).trim(), currentUrl).toString();
        continue;
      }

      return res;
    }
    return null;
  };

  for (const osName of ['windows', 'osx', 'linux']) {
    try {
      const buildsUrl = `https://content-system.gog.com/products/${encodeURIComponent(
        cleanProductId
      )}/os/${osName}/builds?generation=2`;
      const buildsRes = await fetchGogAllowlistedHttps(buildsUrl, headers);
      if (!buildsRes || !buildsRes.ok) continue;
      const buildsData = await buildsRes.json();
      const firstItem = Array.isArray(buildsData?.items) ? buildsData.items[0] : null;
      const link = typeof firstItem?.link === 'string' ? firstItem.link.trim() : '';
      if (!link) continue;

      const manifestRes = await fetchGogAllowlistedHttps(link, {
        'User-Agent': buildPlatformStoreUserAgent('GOGGalaxy/2.0'),
      });
      if (!manifestRes || !manifestRes.ok) continue;

      const compressedBuf = await readBoundedResponseBuffer(
        manifestRes,
        MAX_GOG_MANIFEST_COMPRESSED_BYTES
      );
      if (!compressedBuf || compressedBuf.length === 0) continue;

      let manifestText = '';
      if (compressedBuf[0] === 0x7b) {
        manifestText = compressedBuf.toString('utf8');
      } else {
        const inflated = await inflateAsync(compressedBuf, {
          maxOutputLength: MAX_GOG_MANIFEST_INFLATED_BYTES,
        });
        manifestText = inflated.toString('utf8');
      }

      const manifest = JSON.parse(manifestText);
      const clientId = String(manifest?.clientId || '').trim();
      if (clientId) {
        setBoundedGogClientIdCache(cleanProductId, clientId);
        return clientId;
      }
    } catch {
      // Try next OS build or fall through cleanly on SSRF/zlib/network error
    }
  }

  return null;
}

/**
 * Extract a balanced JSON array literal `[ ... ]` starting at `bracketStartIndex`.
 *
 * @param {string} text
 * @param {number} bracketStartIndex
 * @returns {string | null}
 */
function extractBalancedJsonArray(text, bracketStartIndex) {
  if (text[bracketStartIndex] !== '[') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = bracketStartIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) {
        return text.slice(bracketStartIndex, i + 1);
      }
    }
  }
  return null;
}

/**
 * Normalize GOG achievement image URLs (`//` or `http://` -> `https://`) while blocking non-HTTPS schemes.
 *
 * @param {unknown} rawUrl
 * @returns {string}
 */
function normalizeGogImageUrl(rawUrl) {
  const clean = String(rawUrl || '').trim();
  if (!clean) return '';
  let candidate = clean;
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  else if (candidate.startsWith('http://')) candidate = `https://${candidate.slice(7)}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || !parsed.hostname) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

/**
 * Paginates `gameplay.gog.com/clients/<clientId>/users/<userId>/achievements` across all
 * `page_token` pages (capped at `MAX_GOG_ACHIEVEMENT_PAGES`, guarded by `seenPageTokens`) and
 * deduplicates items by `achievement_id` / `id` / `achievement_key`.
 *
 * @param {{
 *   fetchImpl: typeof fetch,
 *   clientId: string,
 *   userId: string,
 *   tokenToUse: string,
 *   locale: string,
 *   signal?: AbortSignal,
 * }} params
 * @returns {Promise<{ ok: boolean, authExpired?: boolean, notFound?: boolean, status?: number, items?: any[], totalCount?: number }>}
 */
async function fetchPaginatedGogGameplayAchievements({
  fetchImpl,
  clientId,
  userId,
  tokenToUse,
  locale,
  signal,
}) {
  /** @type {any[]} */
  const collected = [];
  const seenKeys = new Set();
  /** @type {Map<string, number>} */
  const seenIndexByKey = new Map();
  const seenPageTokens = new Set();
  let totalCount = 0;
  let pageToken = '';
  const authHeader = tokenToUse.startsWith('Bearer ') ? tokenToUse : `Bearer ${tokenToUse}`;

  for (let page = 0; page < MAX_GOG_ACHIEVEMENT_PAGES; page++) {
    const gpUrl = `https://gameplay.gog.com/clients/${encodeURIComponent(
      clientId
    )}/users/${encodeURIComponent(userId)}/achievements${
      pageToken ? `?page_token=${encodeURIComponent(pageToken)}` : ''
    }`;
    const gpRes = await fetchImpl(gpUrl, {
      headers: {
        Authorization: authHeader,
        'X-GOG-Lc': locale,
        'User-Agent': buildPlatformStoreUserAgent('GOGGalaxy/2.0'),
      },
      signal: buildStoreFetchSignal(signal),
    });
    if (gpRes.status === 401 || gpRes.status === 403) {
      return { ok: false, authExpired: true, status: gpRes.status };
    }
    if (gpRes.status === 404) {
      return { ok: false, notFound: true, status: 404 };
    }
    if (!gpRes.ok) {
      return { ok: false, status: gpRes.status };
    }
    const gpData = /** @type {any} */ (await gpRes.json());
    const pageItems = Array.isArray(gpData?.items) ? gpData.items : [];
    if (typeof gpData?.total_count === 'number' && gpData.total_count > totalCount) {
      totalCount = gpData.total_count;
    }
    let addedOnPage = 0;
    for (const item of pageItems) {
      const itemKey =
        (item?.achievement_id !== undefined &&
          item?.achievement_id !== null &&
          String(item.achievement_id).trim()) ||
        (item?.id !== undefined && item?.id !== null && String(item.id).trim()) ||
        (item?.achievement_key !== undefined &&
          item?.achievement_key !== null &&
          String(item.achievement_key).trim()) ||
        '';
      if (itemKey) {
        if (seenKeys.has(itemKey)) {
          const existingIdx = seenIndexByKey.get(itemKey);
          if (
            existingIdx !== undefined &&
            !collected[existingIdx]?.date_unlocked &&
            item?.date_unlocked
          ) {
            collected[existingIdx] = item;
          }
          continue;
        }
        seenKeys.add(itemKey);
        seenIndexByKey.set(itemKey, collected.length);
      }
      collected.push(item);
      addedOnPage++;
    }
    const nextToken = typeof gpData?.page_token === 'string' ? gpData.page_token.trim() : '';
    if (
      !nextToken ||
      nextToken === pageToken ||
      seenPageTokens.has(nextToken) ||
      pageItems.length === 0 ||
      addedOnPage === 0 ||
      (totalCount > 0 && collected.length >= totalCount)
    ) {
      break;
    }
    seenPageTokens.add(nextToken);
    pageToken = nextToken;
  }

  return { ok: true, items: collected, totalCount: Math.max(collected.length, totalCount) };
}

/**
 * Parse `window.profilesData.achievements` from `www.gog.com/u/<username>/game/<productId>`,
 * converting Unix seconds `unlockDate * 1000` into ISO timestamps.
 *
 * @param {string} html
 * @param {string} cleanProductId
 * @param {string} [preferredUserId]
 */
function parseGogProfileAchievementsHtml(html, cleanProductId, preferredUserId = '') {
  if (typeof html !== 'string' || !html) return [];
  const markerMatch = html.match(/window\.profilesData\.achievements\s*=\s*/);
  if (!markerMatch || markerMatch.index === undefined) return [];
  const arrStart = html.indexOf('[', markerMatch.index + markerMatch[0].length);
  if (arrStart === -1) return [];
  const rawJsonArr = extractBalancedJsonArray(html, arrStart);
  if (!rawJsonArr) return [];

  let list;
  try {
    list = JSON.parse(rawJsonArr);
  } catch {
    return [];
  }
  if (!Array.isArray(list) || list.length === 0) return [];

  return list
    .filter((entry) => entry && typeof entry === 'object' && entry.achievement)
    .map((entry, idx) => {
      const ach = entry.achievement;
      if (ach.clientId && cleanProductId) {
        setBoundedGogClientIdCache(cleanProductId, String(ach.clientId));
      }
      const statsObj = entry.stats && typeof entry.stats === 'object' ? entry.stats : {};
      const userStat =
        (preferredUserId && statsObj[preferredUserId]) ||
        Object.values(statsObj).find((s) => s && typeof s === 'object') ||
        null;
      const isUnlocked = Boolean(userStat?.isUnlocked);
      const rawDate = Number(userStat?.unlockDate ?? 0);
      const unlockedAtMs =
        isUnlocked && Number.isFinite(rawDate) && rawDate > 0
          ? rawDate > 1e12
            ? rawDate
            : rawDate * 1000
          : undefined;
      const unlockedAtIso = unlockedAtMs ? new Date(unlockedAtMs).toISOString() : undefined;
      const rawRarity = Number(ach.rarity);
      const globalPercentage =
        ach.rarity !== undefined && ach.rarity !== null && Number.isFinite(rawRarity)
          ? Number(rawRarity.toFixed(1))
          : undefined;
      const iconUnlockedUrl = normalizeGogImageUrl(ach.imageUrlUnlocked || ach.image_url_unlocked);
      const iconLockedUrl =
        normalizeGogImageUrl(ach.imageUrlLocked || ach.image_url_locked) || iconUnlockedUrl;
      const achId = String(ach.id || ach.achievement_id || `gog_ach_${idx + 1}`);
      const achKey = String(ach.achievement_key || ach.key || achId);

      return {
        id: `gog:${cleanProductId}:${achId}`,
        achievement_id: achId,
        achievement_key: achKey,
        apiName: achKey,
        name: String(ach.name || `Achievement #${idx + 1}`),
        description: String(ach.description || '').trim() || undefined,
        unlocked: isUnlocked,
        isUnlocked,
        ...(unlockedAtIso ? { unlockedAt: unlockedAtIso, date_unlocked: unlockedAtIso } : {}),
        iconUnlockedUrl,
        iconLockedUrl,
        image_url_unlocked: iconUnlockedUrl,
        image_url_locked: iconLockedUrl,
        ...(globalPercentage !== undefined
          ? {
              globalPercentage,
              rarity: globalPercentage,
              rarityTier: classifyAchievementRarityTier(globalPercentage),
            }
          : {}),
        visible: ach.visible !== false,
        isSecret: ach.visible === false,
        storefrontId: 'gog',
      };
    });
}

/**
 * Fetch full per-achievement unlocks, timestamps, rarity & icons for a single GOG game (`Task 10a`).
 * Public `www.gog.com` HTML fallback NEVER transmits `Authorization: Bearer` headers.
 *
 * @param {Record<string, any>} [payload]
 * @param {Record<string, any>} [options]
 */
async function fetchGogDetailedGameAchievements(payload = {}, options = {}) {
  const fetchImpl = typeof options?.fetchFn === 'function' ? options.fetchFn : fetch;
  const vaultOpts = resolveStoreVaultOptions(options?.userDataDir ? options : payload);
  const cleanProductId = String(payload.productId || payload.platformGameId || payload.gameId || '')
    .replace(/^gog[-_]/i, '')
    .trim();

  if (!cleanProductId) return null;

  const { locale } = resolveDefaultStoreLocaleAndCountry(options);
  /** @type {Record<string, any>} */
  let savedGog = {};
  if (!options.accessToken || !options.userId || !options.username) {
    try {
      const saved = await loadSavedTokensAsync(vaultOpts);
      savedGog = saved?.gog || {};
    } catch {}
  }

  let accessToken = String(options.accessToken || savedGog.access_token || '').trim();
  let refreshToken = String(options.refreshToken || savedGog.refresh_token || '').trim();
  let userId = String(options.userId || savedGog.user_id || '').trim();
  let username = String(options.username || savedGog.username || '').trim();
  const rawExpiresAt = options.expiresAt || savedGog.expires_at;
  const expiresAtMs = rawExpiresAt ? Date.parse(String(rawExpiresAt)) : NaN;

  // Proactive GOG token renewal when within 60s of expiry
  if (
    refreshToken &&
    (!accessToken || (!Number.isNaN(expiresAtMs) && expiresAtMs - Date.now() < 60_000))
  ) {
    try {
      const renewed = await renewGogTokens(refreshToken, {
        ...options,
        ...vaultOpts,
        preferVaultRefreshToken: true,
      });
      accessToken = String(renewed?.access_token || accessToken).trim();
      refreshToken = String(renewed?.refresh_token || refreshToken).trim();
      userId = String(renewed?.user_id || userId).trim();
    } catch {}
  }

  // Hydrate missing userId/username if token is present
  if (accessToken && (!userId || !username || username === 'GOG User')) {
    try {
      const acc = await fetchGogAccount(accessToken, { ...options, ...vaultOpts });
      if (acc?.userId) userId = String(acc.userId).trim();
      if (acc?.username && acc.username !== 'GOG User') username = String(acc.username).trim();
    } catch {
      if (refreshToken) {
        try {
          const renewed = await renewGogTokens(refreshToken, {
            ...options,
            ...vaultOpts,
            preferVaultRefreshToken: true,
          });
          accessToken = String(renewed?.access_token || accessToken).trim();
          refreshToken = String(renewed?.refresh_token || refreshToken).trim();
          const acc = await fetchGogAccount(accessToken, { ...options, ...vaultOpts });
          if (acc?.userId) userId = String(acc.userId).trim();
          if (acc?.username && acc.username !== 'GOG User') username = String(acc.username).trim();
        } catch {}
      }
    }
  }

  const clientId =
    String(payload.clientId || options.clientId || '').trim() ||
    (await resolveGogClientId(cleanProductId, options));

  const syncedAt = new Date().toISOString();

  // 1. Primary: Paginated `gameplay.gog.com/clients/<clientId>/users/<userId>/achievements`
  if (clientId && userId && accessToken) {
    try {
      let gpResult = await fetchPaginatedGogGameplayAchievements({
        fetchImpl,
        clientId,
        userId,
        tokenToUse: accessToken,
        locale,
        signal: options?.signal,
      });
      if (gpResult.authExpired && refreshToken) {
        try {
          const renewed = await renewGogTokens(refreshToken, {
            ...options,
            ...vaultOpts,
            preferVaultRefreshToken: true,
          });
          if (renewed?.access_token) {
            accessToken = String(renewed.access_token).trim();
            gpResult = await fetchPaginatedGogGameplayAchievements({
              fetchImpl,
              clientId,
              userId,
              tokenToUse: accessToken,
              locale,
              signal: options?.signal,
            });
          }
        } catch {}
      }

      if (gpResult.ok && Array.isArray(gpResult.items)) {
        const mapped = gpResult.items.map((item, idx) => {
          const achId = String(item?.achievement_id || item?.id || `gog_${idx + 1}`);
          const achKey = String(item?.achievement_key || achId);
          const rawUnlocked = item?.date_unlocked;
          const isUnlocked = Boolean(rawUnlocked);
          let unlockedAt = undefined;
          if (isUnlocked) {
            if (typeof rawUnlocked === 'number' && Number.isFinite(rawUnlocked) && rawUnlocked > 0) {
              unlockedAt = new Date(
                rawUnlocked > 1e12 ? rawUnlocked : rawUnlocked * 1000
              ).toISOString();
            } else if (typeof rawUnlocked === 'string' && rawUnlocked.trim()) {
              const parsed = Date.parse(rawUnlocked);
              unlockedAt = !Number.isNaN(parsed)
                ? new Date(parsed).toISOString()
                : rawUnlocked.trim();
            }
          }
          const rawRarity = Number(item?.rarity);
          const globalPercentage =
            item?.rarity !== undefined && item?.rarity !== null && Number.isFinite(rawRarity)
              ? Number(rawRarity.toFixed(1))
              : undefined;
          const iconUnlockedUrl = normalizeGogImageUrl(
            item?.image_url_unlocked || item?.imageUrlUnlocked
          );
          const iconLockedUrl =
            normalizeGogImageUrl(item?.image_url_locked || item?.imageUrlLocked) ||
            iconUnlockedUrl;

          return {
            id: `gog:${cleanProductId}:${achId}`,
            achievement_id: achId,
            achievement_key: achKey,
            apiName: achKey,
            name: String(item?.name || `Achievement #${idx + 1}`),
            description: String(item?.description || '').trim() || undefined,
            unlocked: isUnlocked,
            isUnlocked,
            ...(unlockedAt ? { unlockedAt, date_unlocked: unlockedAt } : {}),
            iconUnlockedUrl,
            iconLockedUrl,
            image_url_unlocked: iconUnlockedUrl,
            image_url_locked: iconLockedUrl,
            ...(globalPercentage !== undefined
              ? {
                  globalPercentage,
                  rarity: globalPercentage,
                  rarityTier: classifyAchievementRarityTier(globalPercentage),
                }
              : {}),
            visible: item?.visible !== false,
            isSecret: item?.visible === false,
            storefrontId: 'gog',
          };
        });

        const total = mapped.length;
        const unlocked = mapped.filter((a) => a.unlocked).length;
        const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
        return {
          storefrontId: 'gog',
          storefrontName: 'GOG GALAXY',
          total,
          totalCount: total,
          unlocked,
          percentage,
          isMastered: total > 0 && unlocked >= total,
          achievements: mapped,
          items: mapped,
          syncedAt,
          source: 'live_cloud',
          unlockPrecision: 'exact',
          supportsAchievements: total > 0,
          cacheVersion: 2,
        };
      }
    } catch {}
  }

  // 2. Secondary Fallback: Public `GET www.gog.com/u/<username>/game/<productId>` HTML scrape
  // NEVER transmit `Authorization: Bearer` headers to public HTML endpoints!
  if (username && username !== 'GOG User') {
    try {
      const pageUrl = `https://www.gog.com/u/${encodeURIComponent(username)}/game/${encodeURIComponent(
        cleanProductId
      )}`;
      const pageRes = await fetchImpl(pageUrl, {
        headers: {
          'User-Agent': buildPlatformStoreUserAgent('GOGGalaxy/2.0'),
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: buildStoreFetchSignal(options?.signal),
      });
      if (pageRes.ok) {
        const html = await pageRes.text();
        const mapped = parseGogProfileAchievementsHtml(html, cleanProductId, userId);
        if (mapped.length > 0) {
          const total = mapped.length;
          const unlocked = mapped.filter((a) => a.unlocked).length;
          const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
          return {
            storefrontId: 'gog',
            storefrontName: 'GOG GALAXY',
            total,
            totalCount: total,
            unlocked,
            percentage,
            isMastered: total > 0 && unlocked >= total,
            achievements: mapped,
            items: mapped,
            syncedAt,
            source: 'live_cloud',
            unlockPrecision: 'exact',
            supportsAchievements: true,
            cacheVersion: 2,
          };
        }
      }
    } catch {}
  }

  return null;
}

/**
 * Fetch exact achievements summary for a single GOG game using paginated Galaxy gameplay API
 * (`page_token`) or public user profile page (never sending `Authorization` to public HTML).
 *
 * @param {string} accessToken
 * @param {string} username
 * @param {string} userId
 * @param {string | number} gameId
 * @param {string} gameTitle
 * @param {number | undefined} fallbackPercentage
 * @param {Record<string, any>} [options]
 */
async function fetchGogGameAchievementDetail(
  accessToken,
  username,
  userId,
  gameId,
  gameTitle,
  fallbackPercentage,
  options = {}
) {
  const fetchImpl = typeof options?.fetchFn === 'function' ? options.fetchFn : fetch;
  const cleanId = String(gameId).replace(/^gog[-_]/i, '').trim();
  const { locale } = resolveDefaultStoreLocaleAndCountry(options);

  // 1. Try GOG Galaxy official gameplay achievements API with full `page_token` pagination
  if (userId && accessToken) {
    /** @param {string} clientIdCandidate */
    const queryGameplaySummary = async (clientIdCandidate) => {
      const gpResult = await fetchPaginatedGogGameplayAchievements({
        fetchImpl,
        clientId: clientIdCandidate,
        userId,
        tokenToUse: accessToken,
        locale,
        signal: options?.signal,
      });
      if (gpResult.authExpired) {
        if (options && typeof options === 'object' && options._authState) {
          options._authState.authExpired = true;
        }
        return { authExpired: true };
      }
      if (gpResult.ok && Array.isArray(gpResult.items)) {
        const items = gpResult.items;
        const total = items.length || Number(gpResult.totalCount || 0);
        if (total > 0) {
          const unlocked = items.filter((a) => Boolean(a?.date_unlocked)).length;
          const percentage = Math.round((unlocked / total) * 100);
          return {
            hit: {
              unlocked,
              total,
              percentage,
              isMastered: unlocked >= total,
              source: 'live_cloud_api',
              syncedAt: new Date().toISOString(),
            },
          };
        }
        return { empty: true };
      }
      return { notFound: true };
    };

    try {
      const cachedClientId = gogClientIdCache.get(cleanId);
      const firstResult = await queryGameplaySummary(cachedClientId || cleanId);
      if (firstResult.hit) {
        return firstResult.hit;
      }
      if (!cachedClientId && !firstResult.authExpired) {
        const resolvedClientId = await resolveGogClientId(cleanId, options);
        if (resolvedClientId && resolvedClientId !== cleanId) {
          const secondResult = await queryGameplaySummary(resolvedClientId);
          if (secondResult.hit) {
            return secondResult.hit;
          }
        }
      }
    } catch {}
  }

  // 2. Try public GOG profile game page HTML (`window.profilesData.achievements`) — NO Bearer header!
  if (username) {
    try {
      const pageUrl = `https://www.gog.com/u/${encodeURIComponent(username)}/game/${encodeURIComponent(cleanId)}`;
      const pageRes = await fetchImpl(pageUrl, {
        headers: {
          'User-Agent': buildPlatformStoreUserAgent('GOGGalaxy/2.0'),
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: buildStoreFetchSignal(options?.signal),
      });
      if (pageRes.ok) {
        const html = await pageRes.text();
        const parsedList = parseGogProfileAchievementsHtml(html, cleanId, userId);
        if (parsedList.length > 0) {
          const total = parsedList.length;
          const unlocked = parsedList.filter((a) => a.unlocked).length;
          const percentage = Math.round((unlocked / total) * 100);
          return {
            unlocked,
            total,
            percentage,
            isMastered: unlocked >= total,
            source: 'live_cloud_xml',
            syncedAt: new Date().toISOString(),
          };
        }
      }
    } catch {}
  }

  // 3. Fallback using percentage if > 0 (never fabricate a fake total count like 35)
  if (typeof fallbackPercentage === 'number' && fallbackPercentage > 0) {
    return {
      unlocked: 0,
      total: 0,
      percentage: Math.round(fallbackPercentage),
      isMastered: fallbackPercentage >= 100,
      source: 'live_cloud_xml',
      syncedAt: new Date().toISOString(),
    };
  }

  return null;
}

/**
 * Fetch GOG User Achievements and Playtime Stats across paginated profile stats,
 * or for a single targeted game when `options.productId` / `options.gameId` is provided.
 *
 * @param {string} accessToken
 * @param {string} username
 * @param {string} userId
 * @param {Record<string, any>} [options]
 */
async function fetchGogAchievements(accessToken, username, userId, options = {}) {
  const fetchImpl = typeof options?.fetchFn === 'function' ? options.fetchFn : fetch;
  /** @type {Record<string, any>} */
  const achievementsMap = {};
  /** @type {Map<string, any>} */
  const statsMap = new Map();

  const rawTargetProductId = String(options?.productId || options?.gameId || '')
    .replace(/^gog[-_]/i, '')
    .trim();

  let resolvedUsername = username;
  let resolvedUserId = userId;
  if (rawTargetProductId) {
    if (!resolvedUserId && (!resolvedUsername || resolvedUsername === 'GOG User') && accessToken) {
      try {
        const acc = await fetchGogAccount(accessToken, options);
        if (acc.username && acc.username !== 'GOG User') resolvedUsername = acc.username;
        if (acc.userId) resolvedUserId = acc.userId;
      } catch {}
    }

    if (!resolvedUserId && !resolvedUsername) {
      return { achievements: achievementsMap, stats: statsMap };
    }

    const authState = { authExpired: false };
    const detail = await fetchGogGameAchievementDetail(
      accessToken,
      resolvedUsername,
      resolvedUserId,
      rawTargetProductId,
      options?.title || '',
      undefined,
      { ...options, _authState: authState }
    );
    if (detail) {
      achievementsMap[rawTargetProductId] = detail;
      achievementsMap[`gog-${rawTargetProductId}`] = detail;
      if (typeof options?.title === 'string' && options.title.trim()) {
        const lowerTitle = options.title.toLowerCase().trim();
        const normTitle = lowerTitle.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
        achievementsMap[lowerTitle] = detail;
        achievementsMap[normTitle] = detail;
      }
    }
    const targetedResult = { achievements: achievementsMap, stats: statsMap };
    if (authState.authExpired) {
      try {
        Object.defineProperty(targetedResult, 'authExpired', {
          value: true,
          enumerable: false,
          configurable: true,
        });
      } catch {}
    }
    return targetedResult;
  }

  if ((!resolvedUsername || resolvedUsername === 'GOG User' || !resolvedUserId) && accessToken) {
    try {
      const acc = await fetchGogAccount(accessToken, options);
      if (acc.username && acc.username !== 'GOG User') resolvedUsername = acc.username;
      if (acc.userId) resolvedUserId = acc.userId;
    } catch {}
  }

  if (!resolvedUsername) {
    return { achievements: achievementsMap, stats: statsMap };
  }

  /** @type {Record<string, string>} */
  const statsHeaders = {
    'User-Agent': buildPlatformStoreUserAgent('GOGGalaxy/2.0'),
    Accept: 'application/json',
  };

  /** @param {any} statsObj */
  const extractUserStat = (statsObj) => {
    if (!statsObj || Array.isArray(statsObj)) return undefined;
    if (typeof statsObj.playtime === 'number' || typeof statsObj.achievementsPercentage === 'number') {
      return statsObj;
    }
    return Object.values(statsObj)[0];
  };

  const fetchAchievementStatsPass = async () => {
    const passStats = new Map();
    try {
      let currentPage = 1;
      let totalPages = 1;
      let keepPaging = true;
      /** @type {Array<{ strId: string, title: string, pct: number }>} */
      const pendingDetailItems = [];

      while (currentPage <= totalPages && keepPaging && currentPage <= 10) {
        const url = `https://www.gog.com/u/${encodeURIComponent(resolvedUsername)}/games/stats?sort=percent_of_unlocked_achievements&order=desc&page=${currentPage}`;
        const res = await fetchImpl(url, {
          headers: statsHeaders,
          signal: buildStoreFetchSignal(options?.signal),
        });
        if (!res.ok) break;

        const data = /** @type {any} */ (await res.json());
        totalPages = data?.pages || 1;
        const items = data?._embedded?.items || [];
        if (items.length === 0) break;

        for (const item of items) {
          const game = item.game;
          if (!game?.id) continue;
          const strId = String(game.id);
          const userStat = extractUserStat(item.stats);

          if (userStat) {
            passStats.set(strId, {
              playtime: userStat.playtime || 0,
              lastSession: userStat.lastSession || null,
              achievementsPercentage: userStat.achievementsPercentage,
            });
          }

          const pct = userStat?.achievementsPercentage;
          if (typeof pct === 'number' && pct > 0) {
            pendingDetailItems.push({ strId, title: game.title, pct });
          } else if (pct === 0 || !userStat) {
            keepPaging = false;
          }
        }

        currentPage++;
      }

      const GOG_DETAIL_CONCURRENCY = 6;
      for (let i = 0; i < pendingDetailItems.length; i += GOG_DETAIL_CONCURRENCY) {
        const batch = pendingDetailItems.slice(i, i + GOG_DETAIL_CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map(async (entry) => ({
            entry,
            detail: await fetchGogGameAchievementDetail(
              accessToken,
              resolvedUsername,
              resolvedUserId,
              entry.strId,
              entry.title,
              entry.pct,
              options
            ),
          }))
        );
        for (const { entry, detail } of batchResults) {
          if (!detail) continue;
          achievementsMap[entry.strId] = detail;
          achievementsMap[`gog-${entry.strId}`] = detail;
          if (entry.title) {
            const lowerTitle = entry.title.toLowerCase().trim();
            const normTitle = lowerTitle.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
            achievementsMap[lowerTitle] = detail;
            achievementsMap[normTitle] = detail;
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('GOG achievement stats fetch warning:', msg);
    }
    return passStats;
  };

  const fetchRecentPlaytimePass = async () => {
    const recentStats = new Map();
    try {
      let ptPage = 1;
      let ptTotalPages = 1;
      let keepPtPaging = true;
      while (ptPage <= ptTotalPages && keepPtPaging && ptPage <= 5) {
        const ptUrl = `https://www.gog.com/u/${encodeURIComponent(resolvedUsername)}/games/stats?sort=recent_playtime&order=desc&page=${ptPage}`;
        const ptRes = await fetchImpl(ptUrl, {
          headers: statsHeaders,
          signal: buildStoreFetchSignal(options?.signal),
        });
        if (!ptRes.ok) break;
        const ptData = /** @type {any} */ (await ptRes.json());
        ptTotalPages = Number(ptData?.pages || 1) || 1;
        const items = ptData?._embedded?.items || [];
        if (items.length === 0) break;
        for (const item of items) {
          if (!item.game?.id) continue;
          const strId = String(item.game.id);
          const userStat = extractUserStat(item.stats);
          if (!userStat || (!userStat.playtime && !userStat.lastSession)) {
            keepPtPaging = false;
            break;
          }
          if (!recentStats.has(strId)) {
            recentStats.set(strId, {
              playtime: userStat.playtime || 0,
              lastSession: userStat.lastSession || null,
              achievementsPercentage: userStat.achievementsPercentage,
            });
          }
        }
        ptPage++;
      }
    } catch {}
    return recentStats;
  };

  const [achPassStats, recentPassStats] = await Promise.all([
    fetchAchievementStatsPass(),
    fetchRecentPlaytimePass(),
  ]);

  for (const [k, v] of achPassStats.entries()) {
    statsMap.set(k, v);
  }
  for (const [k, v] of recentPassStats.entries()) {
    if (!statsMap.has(k)) {
      statsMap.set(k, v);
    }
  }

  return { achievements: achievementsMap, stats: statsMap };
}

/**
 * @param {Record<string, any>} [options]
 * @returns {string[]}
 */
function resolveCandidateGalaxyDbPaths(options = {}) {
  if (options.galaxyDbPath && typeof options.galaxyDbPath === 'string') {
    return [options.galaxyDbPath];
  }
  const hasExplicitHome = Boolean(options.homedir);
  const homeDir = options.homedir || process.env.HOME || process.env.USERPROFILE || os.homedir();
  const candidates = [];
  if (homeDir) {
    candidates.push(
      path.join(homeDir, 'Users/Shared/GOG.com/Galaxy/storage/galaxy-2.0.db'),
      path.join(homeDir, 'Library/Application Support/GOG.com/Galaxy/storage/galaxy-2.0.db'),
      path.join(homeDir, 'ProgramData/GOG.com/Galaxy/storage/galaxy-2.0.db')
    );
  }
  if (!hasExplicitHome) {
    if (process.platform === 'darwin') {
      candidates.push('/Users/Shared/GOG.com/Galaxy/storage/galaxy-2.0.db');
    } else if (process.platform === 'win32') {
      const progData = process.env.PROGRAMDATA || '';
      if (progData) {
        candidates.push(path.join(progData, 'GOG.com', 'Galaxy', 'storage', 'galaxy-2.0.db'));
      }
    }
  }
  return Array.from(new Set(candidates));
}

/**
 * Parse GOG `worksOn` / `osCompatibility` arrays or objects into normalized OS flags.
 * Returns `null` when `works` is empty or resolves to `{ windows: false, mac: false, linux: false }`.
 *
 * @param {any} works
 * @returns {{ windows: boolean, mac: boolean, linux: boolean } | null}
 */
function parseGogOsFlags(works) {
  if (!works) return null;
  if (Array.isArray(works)) {
    if (works.length === 0) return null;
    const lowerSet = new Set(works.map((w) => String(w || '').trim().toLowerCase()));
    const flags = {
      windows: lowerSet.has('windows') || lowerSet.has('win') || lowerSet.has('pc'),
      mac: lowerSet.has('osx') || lowerSet.has('mac') || lowerSet.has('macos'),
      linux: lowerSet.has('linux'),
    };
    if (!flags.windows && !flags.mac && !flags.linux) return null;
    return flags;
  }
  if (typeof works === 'object') {
    const hasWinKey = works.Windows !== undefined || works.windows !== undefined;
    const hasMacKey =
      works.Mac !== undefined ||
      works.mac !== undefined ||
      works.OSX !== undefined ||
      works.osx !== undefined;
    const hasLinuxKey = works.Linux !== undefined || works.linux !== undefined;
    if (!hasWinKey && !hasMacKey && !hasLinuxKey) return null;
    const flags = {
      windows: Boolean(works.Windows ?? works.windows ?? false),
      mac: Boolean(works.Mac ?? works.mac ?? works.OSX ?? works.osx ?? false),
      linux: Boolean(works.Linux ?? works.linux ?? false),
    };
    if (!flags.windows && !flags.mac && !flags.linux) return null;
    return flags;
  }
  return null;
}

/**
 * Opens `galaxy-2.0.db` (`{ readOnly: true }`) ONCE per GOG sync run, bulk-loads all `gog_*`
 * `GamePieces` rows into a Map, and closes the SQLite handle immediately in `finally`.
 *
 * @param {Record<string, any>} [options]
 */
function bulkLoadLocalGalaxyMetadataMap(options = {}) {
  /** @type {Map<string, Record<string, any>>} */
  const byId = new Map();
  let openedDb = false;

  const dbPaths = resolveCandidateGalaxyDbPaths(options);
  const existingDbPath = dbPaths.find((p) => p && fs.existsSync(p));
  if (!existingDbPath) {
    return { byId, openedDb: false };
  }

  let DatabaseSync = null;
  try {
    const sqliteMod = require('node:sqlite');
    DatabaseSync =
      sqliteMod && typeof sqliteMod.DatabaseSync === 'function' ? sqliteMod.DatabaseSync : null;
  } catch {}
  if (!DatabaseSync) {
    return { byId, openedDb: false };
  }

  let galaxyDb = null;
  try {
    galaxyDb = new DatabaseSync(existingDbPath, { open: true, readOnly: true });
    openedDb = true;

    /** @type {any[]} */
    let rows = [];
    try {
      rows = galaxyDb
        .prepare(
          `SELECT gp.releaseKey AS releaseKey, gpt.type AS pieceType, gp.value AS value
           FROM GamePieces gp
           LEFT JOIN GamePieceTypes gpt ON gpt.id = gp.gamePieceTypeId
           WHERE gp.releaseKey LIKE 'gog_%'`
        )
        .all();
    } catch {
      rows = galaxyDb
        .prepare(
          `SELECT releaseKey, '' AS pieceType, value
           FROM GamePieces
           WHERE releaseKey LIKE 'gog_%'`
        )
        .all();
    }

    for (const row of rows) {
      const relKey = String(row?.releaseKey || '');
      if (!relKey.startsWith('gog_')) continue;
      const gogId = relKey.slice(4).trim();
      if (!gogId || typeof row.value !== 'string') continue;

      let valObj;
      try {
        valObj = JSON.parse(row.value);
      } catch {
        continue;
      }
      if (!valObj || typeof valObj !== 'object') continue;

      /** @type {Record<string, any>} */
      const cur = byId.get(gogId) || {
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      if (valObj.background && !cur.headerImage) {
        cur.headerImage = normalizeGogImageUrl(valObj.background);
      }
      if (valObj.verticalCover && !cur.capsuleImage) {
        cur.capsuleImage = normalizeGogImageUrl(valObj.verticalCover);
      }
      if ((valObj.summary || valObj.description) && !cur.shortDescription) {
        cur.shortDescription = String(valObj.summary || valObj.description).trim();
      }
      if (Array.isArray(valObj.developers) && cur.developers.length === 0) {
        cur.developers = valObj.developers.filter(
          (/** @type {unknown} */ x) => typeof x === 'string' && x.trim()
        );
      }
      if (Array.isArray(valObj.publishers) && cur.publishers.length === 0) {
        cur.publishers = valObj.publishers.filter(
          (/** @type {unknown} */ x) => typeof x === 'string' && x.trim()
        );
      }
      if (Array.isArray(valObj.genres) && cur.genres.length === 0) {
        cur.genres = valObj.genres
          .map((/** @type {any} */ g) => (typeof g === 'string' ? g : g?.name || ''))
          .filter(Boolean);
      }
      if (Array.isArray(valObj.themes) && cur.tags.length === 0) {
        cur.tags = valObj.themes
          .map((/** @type {any} */ t) => (typeof t === 'string' ? t : t?.name || ''))
          .filter(Boolean);
      }
      if (valObj.releaseDate && !cur.releaseDate) {
        if (typeof valObj.releaseDate === 'number' && valObj.releaseDate > 0) {
          const ms = valObj.releaseDate > 1e11 ? valObj.releaseDate : valObj.releaseDate * 1000;
          cur.releaseDate = new Date(ms).toISOString().slice(0, 10);
        } else if (typeof valObj.releaseDate === 'string') {
          cur.releaseDate = valObj.releaseDate.slice(0, 10);
        }
      }
      if (typeof valObj.criticsScore === 'number' && valObj.criticsScore > 0 && !cur.reviewScore) {
        cur.reviewScore = Math.round(valObj.criticsScore);
      }
      const works = valObj.worksOn || valObj.osCompatibility;
      if (!cur.platforms) {
        const parsedOs = parseGogOsFlags(works);
        if (parsedOs) {
          cur.platforms = parsedOs;
        }
      }

      byId.set(gogId, cur);
    }
  } catch {
    // Non-fatal if local Galaxy DB is locked or malformed
  } finally {
    if (galaxyDb) {
      try {
        galaxyDb.close();
      } catch {}
    }
  }

  return { byId, openedDb };
}

/**
 * Fetch GOG owned library using `embed.gog.com/account/getFilteredProducts`.
 * Sets `completedAllPages = false` whenever pagination was truncated (`totalPages > 100`) or failed.
 *
 * @param {string} accessToken
 * @param {string} username
 * @param {string} userId
 * @param {Record<string, any>} [options]
 */
async function fetchGogOwnedGames(accessToken, username, userId, options = {}) {
  const fetchImpl = typeof options?.fetchFn === 'function' ? options.fetchFn : fetch;
  /** @type {any[]} */
  const games = [];
  /** @type {any[]} */
  const suppressedItems = [];
  let encounteredNetworkOrServerFailure = false;
  let completedAllPages = false;
  let abortedPaginationEarly = false;

  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    return attachStoreSyncCallMetadata(
      games,
      fetchGogOwnedGames,
      { authoritativeComplete: false, achievementsMap: {}, suppressedItems },
      options
    );
  }

  const achievementsPromise = fetchGogAchievements(accessToken, username, userId, options).catch(
    () => ({ achievements: {}, stats: new Map() })
  );

  // Open local `galaxy-2.0.db` (`{ readOnly: true }`) at most ONCE before iterating GOG titles
  const { byId: bulkGalaxyMetaMap, openedDb: galaxyDbOpenedOnce } =
    bulkLoadLocalGalaxyMetadataMap(options);

  const gogProductHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': buildPlatformStoreUserAgent('GOGGalaxy/2.0'),
  };

  /** @type {any[]} */
  const collectedProducts = [];
  /** @type {Error | null} */
  let unauthorizedError = null;

  try {
    /** @param {number} pageNum */
    const fetchGogProductsPage = async (pageNum) => {
      const url = `https://embed.gog.com/account/getFilteredProducts?hasHiddenProducts=false&isDefault=true&mediaType=1&page=${pageNum}&limit=100`;
      const res = await fetchImpl(url, {
        headers: gogProductHeaders,
        signal: buildStoreFetchSignal(options?.signal),
      });
      if (!res.ok) {
        return { ok: false, status: res.status, data: null };
      }
      const data = /** @type {any} */ (await res.json());
      return { ok: true, status: res.status, data };
    };

    const page1 = await fetchGogProductsPage(1);
    if (!page1.ok) {
      if (page1.status === 401 || page1.status === 403) {
        unauthorizedError = new Error(`GOG getFilteredProducts unauthorized (${page1.status})`);
      } else {
        encounteredNetworkOrServerFailure = true;
        abortedPaginationEarly = true;
        console.warn(`GOG getFilteredProducts page 1 returned status ${page1.status}`);
      }
    } else {
      const data1 = page1.data || {};
      const totalPages =
        typeof data1.totalPages === 'number' && data1.totalPages >= 0 ? data1.totalPages : 1;
      if (totalPages === 0) {
        completedAllPages = true;
      } else {
        if (Array.isArray(data1.products)) {
          collectedProducts.push(...data1.products);
        }
        const hitPageCap = totalPages > MAX_GOG_OWNED_PAGES;
        const maxPage = Math.min(totalPages, MAX_GOG_OWNED_PAGES);
        const GOG_PRODUCTS_CONCURRENCY = 4;
        for (let startPage = 2; startPage <= maxPage; startPage += GOG_PRODUCTS_CONCURRENCY) {
          const endPage = Math.min(maxPage, startPage + GOG_PRODUCTS_CONCURRENCY - 1);
          const pageNums = [];
          for (let pNum = startPage; pNum <= endPage; pNum++) {
            pageNums.push(pNum);
          }
          const batchResults = await Promise.all(
            pageNums.map(async (pNum) => {
              try {
                return { pNum, ...(await fetchGogProductsPage(pNum)) };
              } catch (err) {
                return { pNum, ok: false, status: 0, error: err, data: null };
              }
            })
          );
          for (const pageRes of batchResults) {
            if (!pageRes.ok) {
              encounteredNetworkOrServerFailure = true;
              abortedPaginationEarly = true;
              if (pageRes.status) {
                console.warn(
                  `GOG getFilteredProducts page ${pageRes.pNum} returned status ${pageRes.status}`
                );
              }
              break;
            }
            if (Array.isArray(pageRes.data?.products)) {
              collectedProducts.push(...pageRes.data.products);
            }
          }
          if (abortedPaginationEarly) break;
        }
        if (!abortedPaginationEarly && !encounteredNetworkOrServerFailure && !hitPageCap) {
          completedAllPages = true;
        } else if (hitPageCap) {
          completedAllPages = false;
        }
      }
    }
  } catch (err) {
    encounteredNetworkOrServerFailure = true;
    completedAllPages = false;
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Error fetching GOG products:', msg);
  }

  const { achievements: achievementsMap, stats: playtimeMap } = await achievementsPromise;

  if (unauthorizedError) {
    attachStoreSyncCallMetadata(
      games,
      fetchGogOwnedGames,
      { authoritativeComplete: false, achievementsMap, suppressedItems },
      options
    );
    throw unauthorizedError;
  }

  for (const p of collectedProducts) {
    if (p?.isHidden === true) continue;
    const title = (p.title || '').trim();
    if (!title) continue;

    const rawCover = p.image
      ? p.image.startsWith('http')
        ? p.image
        : `https:${p.image}.jpg`
      : '';
    const coverUrl =
      normalizeGogImageUrl(rawCover) || 'https://images.gog-statics.com/avatars/default.png';

    const strId = String(p.id);
    const stats = playtimeMap.get(strId) || {};
    const lowerTitle = title.toLowerCase().trim();
    const normTitle = lowerTitle.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
    const gameAch =
      achievementsMap[strId] ||
      achievementsMap[`gog-${strId}`] ||
      achievementsMap[lowerTitle] ||
      achievementsMap[normTitle];

    const nonGameReason = classifyNonGameStorefrontItem({
      title,
      platformId: 'gog',
      platformGameId: strId,
      isDlc: false,
    });
    if (nonGameReason) {
      const rawGame = {
        id: `gog-${p.id}`,
        title,
        originalStoreTitle: title,
        sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
        isVerifiedEntitlement: true,
        platforms: [
          {
            platformId: 'gog',
            platformGameId: strId,
            originalTitle: title,
            installed: false,
            playtimeMinutes: stats.playtime || 0,
            lastPlayed: stats.lastSession || undefined,
          },
        ],
        headerImage: coverUrl,
        capsuleImage: '',
        shortDescription: '',
        releaseDate: '',
        developers: [],
        publishers: [],
        genres: p.category ? [p.category] : [],
        tags: ['GOG', 'DRM-Free'],
      };
      suppressedItems.push({
        id: `gog-${p.id}`,
        rawTitle: title,
        platformId: 'gog',
        platformGameId: strId,
        reason: nonGameReason,
        reasonCategory: 'non_game_filter',
        rawGame,
      });
      continue;
    }

    const rawWorksOn = p.worksOn || p.os;
    const resolvedOsPlatforms = parseGogOsFlags(rawWorksOn) || undefined;
    const resolvedNativePlatforms = resolvedOsPlatforms
      ? [
          ...(resolvedOsPlatforms.windows ? ['windows'] : []),
          ...(resolvedOsPlatforms.mac ? ['mac'] : []),
        ]
      : undefined;

    const localGogMeta = galaxyDbOpenedOnce
      ? bulkGalaxyMetaMap.get(strId) || null
      : storefrontLocalCacheFederator.resolveLocalGogMetadata(strId, options);
    const effectiveOsPlatforms =
      resolvedOsPlatforms ||
      parseGogOsFlags(localGogMeta?.platforms) || { windows: true, mac: false, linux: false };
    const effectiveNativePlatforms = effectiveOsPlatforms
      ? [
          ...(effectiveOsPlatforms.windows ? ['windows'] : []),
          ...(effectiveOsPlatforms.mac ? ['mac'] : []),
        ]
      : resolvedNativePlatforms;

    const headerImg = localGogMeta?.headerImage || coverUrl;
    const capsuleImg = localGogMeta?.capsuleImage || '';

    games.push({
      id: `gog-${p.id}`,
      title,
      sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
      steamAppId: undefined,
      isVerifiedEntitlement: true,
      ...(effectiveNativePlatforms && effectiveNativePlatforms.length > 0
        ? { nativePlatforms: effectiveNativePlatforms }
        : {}),
      ...(effectiveOsPlatforms ? { worksOn: effectiveOsPlatforms } : {}),
      platforms: [
        {
          platformId: 'gog',
          platformGameId: strId,
          installed: false,
          playtimeMinutes: stats.playtime || 0,
          lastPlayed: stats.lastSession || undefined,
          achievements: gameAch || undefined,
          ...(effectiveOsPlatforms ? { platforms: effectiveOsPlatforms } : {}),
        },
      ],
      headerImage: headerImg,
      capsuleImage: capsuleImg,
      shortDescription: localGogMeta?.shortDescription || '',
      releaseDate: localGogMeta?.releaseDate || '',
      developers: localGogMeta?.developers || [],
      publishers: localGogMeta?.publishers || [],
      genres:
        localGogMeta?.genres && localGogMeta.genres.length > 0
          ? localGogMeta.genres
          : p.category
            ? [p.category]
            : [],
      tags:
        localGogMeta?.tags && localGogMeta.tags.length > 0
          ? Array.from(new Set(['GOG', 'DRM-Free', ...localGogMeta.tags]))
          : ['GOG', 'DRM-Free'],
      rating: p.rating ? p.rating * 20 : localGogMeta?.reviewScore,
    });
  }

  const gogAuthoritative = Boolean(completedAllPages && !encounteredNetworkOrServerFailure);
  return attachStoreSyncCallMetadata(
    games,
    fetchGogOwnedGames,
    { authoritativeComplete: gogAuthoritative, achievementsMap, suppressedItems },
    options
  );
}

function trimGogSyncMemory() {
  /** @type {any} */ (fetchGogOwnedGames).lastAchievementsMap = null;
  /** @type {any} */ (fetchGogOwnedGames).lastSuppressedItems = null;
  /** @type {any} */ (fetchGogOwnedGames).lastAuthoritativeComplete = null;
}

module.exports = {
  exchangeGogCode,
  renewGogTokens,
  normalizeGogAvatarUrl,
  fetchGogAccount,
  parseGogOsFlags,
  bulkLoadLocalGalaxyMetadataMap,
  fetchGogOwnedGames,
  resolveGogClientId,
  parseGogProfileAchievementsHtml,
  fetchGogDetailedGameAchievements,
  fetchGogGameAchievementDetail,
  fetchGogAchievements,
  trimGogSyncMemory,
};
