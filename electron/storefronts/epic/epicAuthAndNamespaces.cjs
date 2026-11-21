// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { loadSavedTokensAsync, saveTokensAsync } = require('../tokenVault.cjs');
const { normalizeChainedHandoffId } = require('../../launcher/chainedPublisherLaunchers.cjs');
const {
  EPIC_CLIENT_AUTH,
  buildStoreFetchSignal,
  buildPlatformStoreUserAgent,
  extractVerifiedOAuthCode,
  resolveStoreVaultOptions,
  resolveSafeLegendaryMetaFilePath,
  runSingleFlightTokenRenewal,
  setBoundedCacheEntry,
} = require('../sync/storeSyncShared.cjs');

const MAX_EPIC_NAMESPACE_CACHE_APPS = 4096;
const MAX_EPIC_NAMESPACE_INDEX_KEYS = 12288;
const EPIC_CLOUD_ASSETS_CACHE_TTL_MS = 30 * 60_000;
const EPIC_CLOUD_ASSETS_ERROR_BACKOFF_MS = 15_000;

/** @type {Map<string, { appName?: string, namespace: string, catalogItemId?: string, title?: string }>} */
const epicAppNamespaceCache = new Map();
/** @type {Map<string, string>} */
const epicAppNamespaceSecondaryIndex = new Map();
/** Scoped by resolved directory path so test-isolated roots never collide with global state. */
/** @type {Set<string>} */
const scannedLocalEpicMetadataRoots = new Set();

/** @type {string | null} */
let cachedEpicClientToken = null;
let cachedEpicClientTokenExpiry = 0;
let epicCloudAssetsFetchedAtMs = 0;
let epicCloudAssetsRetryAfterMs = 0;
/** @type {Promise<void> | null} */
let inFlightEpicCloudAssetsPromise = null;

/**
 * Exchange Epic Authorization Code for Access & Refresh Tokens.
 *
 * @param {string} code
 * @param {Record<string, any>} [options]
 */
async function exchangeEpicCode(code, options = {}) {
  const fetchImpl = typeof options?.fetchFn === 'function' ? options.fetchFn : fetch;
  const vaultOpts = resolveStoreVaultOptions(options);
  const cleanCode = extractVerifiedOAuthCode(code, [
    'www.epicgames.com',
    'store.epicgames.com',
    'epicgames.com',
    'localhost',
    '127.0.0.1',
  ]);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: cleanCode,
    token_type: 'eg1',
  });

  const res = await fetchImpl(
    'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token',
    {
      method: 'POST',
      headers: {
        Authorization: `basic ${EPIC_CLIENT_AUTH}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': buildPlatformStoreUserAgent('EpicGamesLauncher'),
      },
      body: body.toString(),
      signal: buildStoreFetchSignal(options?.signal),
    }
  );

  if (!res.ok) {
    throw new Error(`Epic token exchange failed (HTTP ${res.status})`);
  }

  const data = /** @type {Record<string, any>} */ (await res.json());
  if (!data.access_token) {
    throw new Error('Epic token response missing access_token');
  }

  await saveTokensAsync('epic', data, vaultOpts);
  return data;
}

/**
 * Automatically renew Epic Games access token using refresh_token.
 * Deduplicates single-flight per `epic:${resolvedVaultPath}` using SHA-256 refresh keys and
 * isolated caller `AbortSignal`s.
 *
 * @param {string} refreshToken
 * @param {Record<string, any>} [options]
 */
async function renewEpicTokens(refreshToken, options = {}) {
  const fetchImpl = typeof options?.fetchFn === 'function' ? options.fetchFn : fetch;
  return runSingleFlightTokenRenewal({
    storefrontId: 'epic',
    refreshToken,
    options,
    performRefresh: async (effectiveRefreshToken, internalSignal) => {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: effectiveRefreshToken,
        token_type: 'eg1',
      });

      const res = await fetchImpl(
        'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token',
        {
          method: 'POST',
          headers: {
            Authorization: `basic ${EPIC_CLIENT_AUTH}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': buildPlatformStoreUserAgent('EpicGamesLauncher'),
          },
          body: body.toString(),
          signal: internalSignal,
        }
      );

      if (!res.ok) {
        throw new Error(`Failed to renew Epic token (HTTP ${res.status})`);
      }

      return /** @type {Record<string, any>} */ (await res.json());
    },
  });
}

/**
 * Extract Epic `customAttributes` (supporting both `[{ key, value }]` array shape and
 * `{ Key: { value } | string }` object shape) into a normalized case-insensitive key lookup.
 *
 * @param {unknown} rawAttrs
 * @returns {Record<string, string>}
 */
function extractEpicCustomAttributesMap(rawAttrs) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!rawAttrs || typeof rawAttrs !== 'object') return out;
  if (Array.isArray(rawAttrs)) {
    for (const entry of rawAttrs) {
      if (!entry || typeof entry !== 'object') continue;
      const k = String(entry.key ?? entry.name ?? '').trim();
      const rawVal = entry.value;
      const v =
        rawVal && typeof rawVal === 'object'
          ? String(rawVal.value ?? '').trim()
          : String(rawVal ?? '').trim();
      if (k && v) {
        out[k] = v;
        out[k.toLowerCase()] = v;
      }
    }
    return out;
  }
  for (const [kRaw, entry] of Object.entries(rawAttrs)) {
    const k = String(kRaw || '').trim();
    if (!k) continue;
    const v =
      entry && typeof entry === 'object'
        ? String(/** @type {any} */ (entry).value ?? '').trim()
        : String(entry ?? '').trim();
    if (v) {
      out[k] = v;
      out[k.toLowerCase()] = v;
    }
  }
  return out;
}

/**
 * Resolve Epic third-party partner launcher handoff (`'ea'` | `'ubisoft'`) from one or more
 * `customAttributes` objects/arrays.
 *
 * @param {...unknown} attrSources
 * @returns {{
 *   chainedLauncherHandoff: 'ea' | 'ubisoft',
 *   externalStorefrontHandoff: 'ea' | 'ubisoft',
 *   chainedHandoffTopology: 'partner_launcher_link',
 *   epicPartnerRegistryPath?: string,
 *   epicPartnerRegistryKey?: string
 * } | null}
 */
function resolveEpicPartnerChainedHandoff(...attrSources) {
  let thirdPartyManagedApp = '';
  let partnerLinkType = '';
  let registryPath = '';
  let registryKey = '';

  for (const src of attrSources) {
    if (!src) continue;
    const map = extractEpicCustomAttributesMap(src);
    if (!thirdPartyManagedApp && map.thirdpartymanagedapp) {
      thirdPartyManagedApp = map.thirdpartymanagedapp;
    }
    if (!partnerLinkType && map.partnerlinktype) {
      partnerLinkType = map.partnerlinktype;
    }
    if (!registryPath && map.registrypath) {
      registryPath = map.registrypath;
    }
    if (!registryKey && map.registrykey) {
      registryKey = map.registrykey;
    }
  }

  const normalized =
    normalizeChainedHandoffId(thirdPartyManagedApp) ||
    normalizeChainedHandoffId(partnerLinkType);
  if (normalized !== 'ea' && normalized !== 'ubisoft') {
    return null;
  }

  return {
    chainedLauncherHandoff: normalized,
    externalStorefrontHandoff: normalized,
    chainedHandoffTopology: 'partner_launcher_link',
    ...(registryPath ? { epicPartnerRegistryPath: registryPath } : {}),
    ...(registryKey ? { epicPartnerRegistryKey: registryKey } : {}),
  };
}

/**
 * Read `customAttributes` from local Legendary `metadata/<appName>.json` with strict path containment.
 *
 * @param {string} appName
 * @param {string[]} [baseDirs]
 * @returns {Record<string, any> | null}
 */
function readLocalLegendaryCustomAttributes(appName, baseDirs = []) {
  const cleanApp = String(appName || '')
    .replace(/^epic-/i, '')
    .trim();
  if (!cleanApp || !Array.isArray(baseDirs) || baseDirs.length === 0) return null;
  for (const baseDir of baseDirs) {
    const directFile = resolveSafeLegendaryMetaFilePath(baseDir, cleanApp);
    if (!directFile) continue;
    if (fs.existsSync(directFile)) {
      try {
        const json = JSON.parse(fs.readFileSync(directFile, 'utf-8'));
        const attrs = json?.metadata?.customAttributes || json?.customAttributes;
        if (attrs && typeof attrs === 'object') return attrs;
      } catch {}
    }
  }
  return null;
}

/**
 * Async variant of `readLocalLegendaryCustomAttributes` with strict path containment.
 *
 * @param {string} appName
 * @param {string[]} [baseDirs]
 * @returns {Promise<Record<string, any> | null>}
 */
async function readLocalLegendaryCustomAttributesAsync(appName, baseDirs = []) {
  const cleanApp = String(appName || '')
    .replace(/^epic-/i, '')
    .trim();
  if (!cleanApp || !Array.isArray(baseDirs) || baseDirs.length === 0) return null;
  for (const baseDir of baseDirs) {
    const directFile = resolveSafeLegendaryMetaFilePath(baseDir, cleanApp);
    if (!directFile) continue;
    try {
      const raw = await fs.promises.readFile(directFile, 'utf-8');
      const json = JSON.parse(raw);
      const attrs = json?.metadata?.customAttributes || json?.customAttributes;
      if (attrs && typeof attrs === 'object') return attrs;
    } catch {}
  }
  return null;
}

/**
 * @param {{ appName?: string, namespace?: string, catalogItemId?: string, title?: string }} [mapping]
 */
function registerEpicNamespaceMapping({ appName, namespace, catalogItemId, title } = {}) {
  if (!namespace) return;
  const entry = {
    appName: appName ? String(appName).trim() : undefined,
    namespace: String(namespace).trim(),
    catalogItemId: catalogItemId ? String(catalogItemId).trim() : undefined,
    title: title ? String(title).trim() : undefined,
  };
  const appLower = entry.appName ? entry.appName.toLowerCase() : '';
  const catLower = entry.catalogItemId ? entry.catalogItemId.toLowerCase() : '';
  const normTitle = entry.title ? entry.title.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  const canonicalKey = appLower
    ? `app:${appLower}`
    : catLower
      ? `cat:${catLower}`
      : normTitle
        ? `title:${normTitle}`
        : '';
  if (!canonicalKey) return;

  setBoundedCacheEntry(epicAppNamespaceCache, canonicalKey, entry, MAX_EPIC_NAMESPACE_CACHE_APPS);
  if (appLower) {
    setBoundedCacheEntry(
      epicAppNamespaceSecondaryIndex,
      `app:${appLower}`,
      canonicalKey,
      MAX_EPIC_NAMESPACE_INDEX_KEYS
    );
  }
  if (catLower) {
    setBoundedCacheEntry(
      epicAppNamespaceSecondaryIndex,
      `cat:${catLower}`,
      canonicalKey,
      MAX_EPIC_NAMESPACE_INDEX_KEYS
    );
  }
  if (normTitle) {
    setBoundedCacheEntry(
      epicAppNamespaceSecondaryIndex,
      `title:${normTitle}`,
      canonicalKey,
      MAX_EPIC_NAMESPACE_INDEX_KEYS
    );
  }
}

/**
 * @param {string} lookupKey
 */
function getEpicNamespaceByLookupKey(lookupKey) {
  if (!lookupKey) return null;
  if (epicAppNamespaceCache.has(lookupKey)) {
    return epicAppNamespaceCache.get(lookupKey) || null;
  }
  const canonicalKey = epicAppNamespaceSecondaryIndex.get(lookupKey);
  if (canonicalKey && epicAppNamespaceCache.has(canonicalKey)) {
    return epicAppNamespaceCache.get(canonicalKey) || null;
  }
  return null;
}

/**
 * @param {boolean} [forceClientCredentials]
 * @param {Record<string, any>} [options]
 * @returns {Promise<string | null>}
 */
async function getEpicCatalogAccessToken(forceClientCredentials = false, options = {}) {
  const fetchImpl = typeof options?.fetchFn === 'function' ? options.fetchFn : fetch;
  if (!forceClientCredentials) {
    try {
      const vaultOpts = resolveStoreVaultOptions(options);
      const saved = (await loadSavedTokensAsync(vaultOpts))?.epic;
      if (saved?.access_token) {
        const expiresAtMs = saved.expires_at ? new Date(saved.expires_at).getTime() : 0;
        if (expiresAtMs && expiresAtMs - Date.now() < 60000 && saved.refresh_token) {
          try {
            const renewed = await renewEpicTokens(saved.refresh_token, options);
            if (renewed?.access_token) return renewed.access_token;
          } catch {}
        } else if (!expiresAtMs || expiresAtMs > Date.now()) {
          return saved.access_token;
        }
      }
    } catch {}
  }

  if (!options?.fetchFn && cachedEpicClientToken && Date.now() < cachedEpicClientTokenExpiry) {
    return cachedEpicClientToken;
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      token_type: 'eg1',
    });
    const res = await fetchImpl(
      'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token',
      {
        method: 'POST',
        headers: {
          Authorization: `basic ${EPIC_CLIENT_AUTH}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': buildPlatformStoreUserAgent('EpicGamesLauncher'),
        },
        body: body.toString(),
        signal: buildStoreFetchSignal(options?.signal),
      }
    );
    if (res.ok) {
      const data = /** @type {any} */ (await res.json());
      if (data?.access_token) {
        if (!options?.fetchFn) {
          cachedEpicClientToken = data.access_token;
          cachedEpicClientTokenExpiry = Date.now() + ((data.expires_in || 3600) - 120) * 1000;
        }
        return data.access_token;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('Failed to obtain Epic client_credentials token:', msg);
  }

  return null;
}

/**
 * @param {Record<string, any>} [options]
 * @returns {string[]}
 */
function getLocalLegendaryBaseDirs(options = {}) {
  if (Array.isArray(options?.legendaryBaseDirs)) {
    return options.legendaryBaseDirs;
  }
  const hasExplicitIsolation = Boolean(options?.homedir || options?.userDataDir);
  const homeDir = options?.homedir || process.env.HOME || process.env.USERPROFILE || '';
  const userDataDir =
    options?.userDataDir ||
    (() => {
      if (hasExplicitIsolation) return '';
      try {
        return app ? app.getPath('userData') : '';
      } catch {
        return '';
      }
    })();

  const candidates = [
    homeDir ? path.join(homeDir, '.config/legendary') : '',
    homeDir ? path.join(homeDir, 'Library/Application Support/heroic/legendaryConfig/legendary') : '',
    userDataDir ? path.join(userDataDir, 'legendaryConfig/legendary') : '',
    !hasExplicitIsolation && homeDir
      ? path.join(homeDir, 'Library/Application Support/one-launcher/legendaryConfig/legendary')
      : '',
    !hasExplicitIsolation && homeDir
      ? path.join(homeDir, 'Library/Application Support/One Launcher/legendaryConfig/legendary')
      : '',
    !hasExplicitIsolation && process.env.APPDATA
      ? path.join(process.env.APPDATA, 'one-launcher/legendaryConfig/legendary')
      : '',
    !hasExplicitIsolation && process.env.APPDATA
      ? path.join(process.env.APPDATA, 'heroic/legendaryConfig/legendary')
      : '',
    homeDir ? path.join(homeDir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary') : '',
  ].filter(Boolean);

  return Array.from(new Set(candidates));
}

/**
 * @param {string[]} [baseDirs]
 * @returns {Set<string>}
 */
function extractEpicMacSupportFromLegendaryDirs(baseDirs = getLocalLegendaryBaseDirs()) {
  /** @type {Set<string>} */
  const macEpicAppIds = new Set();
  const dirs = Array.isArray(baseDirs) ? baseDirs : getLocalLegendaryBaseDirs();
  for (const baseDir of dirs) {
    if (!baseDir || !fs.existsSync(baseDir)) continue;
    const assetsFile = path.join(baseDir, 'assets.json');
    if (fs.existsSync(assetsFile)) {
      try {
        const assetsJson = JSON.parse(fs.readFileSync(assetsFile, 'utf-8'));
        const macList = Array.isArray(assetsJson?.Mac)
          ? assetsJson.Mac
          : Array.isArray(assetsJson)
            ? assetsJson.filter(
                (/** @type {any} */ it) =>
                  String(it?.platform || '').toLowerCase() === 'mac' ||
                  Boolean(it?.asset_infos?.Mac && Object.keys(it.asset_infos.Mac).length > 0)
              )
            : [];
        for (const a of macList) {
          const an = String(a?.app_name || a?.appName || '').toLowerCase().trim();
          const cid = String(a?.catalog_item_id || a?.catalogItemId || '').toLowerCase().trim();
          const aid = String(a?.asset_id || a?.assetId || '').toLowerCase().trim();
          if (an) macEpicAppIds.add(an);
          if (cid) macEpicAppIds.add(cid);
          if (aid) macEpicAppIds.add(aid);
        }
      } catch {}
    }

    const metaDir = path.join(baseDir, 'metadata');
    if (fs.existsSync(metaDir)) {
      try {
        const files = fs.readdirSync(metaDir).filter((f) => f.endsWith('.json'));
        for (const f of files) {
          try {
            const json = JSON.parse(fs.readFileSync(path.join(metaDir, f), 'utf-8'));
            const an = String(json?.app_name || f.replace(/\.json$/i, ''))
              .toLowerCase()
              .trim();
            const cid = String(json?.metadata?.id || json?.catalog_item_id || json?.id || '')
              .toLowerCase()
              .trim();
            const partnerHandoff = resolveEpicPartnerChainedHandoff(
              json?.metadata?.customAttributes,
              json?.customAttributes
            );
            if (partnerHandoff) {
              if (an) macEpicAppIds.delete(an);
              if (cid) macEpicAppIds.delete(cid);
              continue;
            }
            const hasMacAssetInfo = Boolean(
              json?.asset_infos?.Mac && Object.keys(json.asset_infos.Mac).length > 0
            );
            const releaseInfo = json?.metadata?.releaseInfo || json?.releaseInfo;
            const hasMacRelease =
              Array.isArray(releaseInfo) &&
              releaseInfo.some(
                (/** @type {any} */ r) =>
                  r &&
                  Array.isArray(r.platform) &&
                  r.platform.some((/** @type {any} */ p) => /^mac$/i.test(String(p)))
              );
            if (hasMacAssetInfo || hasMacRelease) {
              if (an) macEpicAppIds.add(an);
              if (cid) macEpicAppIds.add(cid);
            }
          } catch {}
        }
      } catch {}
    }
  }
  return macEpicAppIds;
}

/**
 * Async `fs.promises` variant of `extractEpicMacSupportFromLegendaryDirs`.
 *
 * @param {string[]} [baseDirs]
 * @returns {Promise<Set<string>>}
 */
async function extractEpicMacSupportFromLegendaryDirsAsync(baseDirs = getLocalLegendaryBaseDirs()) {
  /** @type {Set<string>} */
  const macEpicAppIds = new Set();
  const dirs = Array.isArray(baseDirs) ? baseDirs : getLocalLegendaryBaseDirs();
  for (const baseDir of dirs) {
    if (!baseDir) continue;
    try {
      await fs.promises.access(baseDir);
    } catch {
      continue;
    }

    const assetsFile = path.join(baseDir, 'assets.json');
    try {
      const assetsRaw = await fs.promises.readFile(assetsFile, 'utf-8');
      const assetsJson = JSON.parse(assetsRaw);
      const macList = Array.isArray(assetsJson?.Mac)
        ? assetsJson.Mac
        : Array.isArray(assetsJson)
          ? assetsJson.filter(
              (/** @type {any} */ it) =>
                String(it?.platform || '').toLowerCase() === 'mac' ||
                Boolean(it?.asset_infos?.Mac && Object.keys(it.asset_infos.Mac).length > 0)
            )
          : [];
      for (const a of macList) {
        const an = String(a?.app_name || a?.appName || '').toLowerCase().trim();
        const cid = String(a?.catalog_item_id || a?.catalogItemId || '').toLowerCase().trim();
        const aid = String(a?.asset_id || a?.assetId || '').toLowerCase().trim();
        if (an) macEpicAppIds.add(an);
        if (cid) macEpicAppIds.add(cid);
        if (aid) macEpicAppIds.add(aid);
      }
    } catch {}

    const metaDir = path.join(baseDir, 'metadata');
    /** @type {string[]} */
    let files = [];
    try {
      files = (await fs.promises.readdir(metaDir)).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    const META_CONCURRENCY = 16;
    for (let i = 0; i < files.length; i += META_CONCURRENCY) {
      const chunk = files.slice(i, i + META_CONCURRENCY);
      const parsedChunk = await Promise.all(
        chunk.map(async (f) => {
          try {
            const raw = await fs.promises.readFile(path.join(metaDir, f), 'utf-8');
            return { f, json: JSON.parse(raw) };
          } catch {
            return null;
          }
        })
      );
      for (const entry of parsedChunk) {
        if (!entry) continue;
        const { f, json } = entry;
        const an = String(json?.app_name || f.replace(/\.json$/i, ''))
          .toLowerCase()
          .trim();
        const cid = String(json?.metadata?.id || json?.catalog_item_id || json?.id || '')
          .toLowerCase()
          .trim();
        const partnerHandoff = resolveEpicPartnerChainedHandoff(
          json?.metadata?.customAttributes,
          json?.customAttributes
        );
        if (partnerHandoff) {
          if (an) macEpicAppIds.delete(an);
          if (cid) macEpicAppIds.delete(cid);
          continue;
        }
        const hasMacAssetInfo = Boolean(
          json?.asset_infos?.Mac && Object.keys(json.asset_infos.Mac).length > 0
        );
        const releaseInfo = json?.metadata?.releaseInfo || json?.releaseInfo;
        const hasMacRelease =
          Array.isArray(releaseInfo) &&
          releaseInfo.some(
            (/** @type {any} */ r) =>
              r &&
              Array.isArray(r.platform) &&
              r.platform.some((/** @type {any} */ p) => /^mac$/i.test(String(p)))
          );
        if (hasMacAssetInfo || hasMacRelease) {
          if (an) macEpicAppIds.add(an);
          if (cid) macEpicAppIds.add(cid);
        }
      }
    }
  }
  return macEpicAppIds;
}

/**
 * Resolves Epic `namespace` & `catalogItemId` from cache, local Legendary metadata (strictly
 * contained against path traversal, scoped per resolved root dir), Epic Launcher manifests
 * (without hardcoded `C:\ProgramData`), and cloud assets API.
 *
 * @param {Record<string, any>} [payload]
 * @param {Record<string, any>} [options]
 */
async function resolveEpicNamespaceAndIds(payload = {}, options = {}) {
  const fetchImpl =
    typeof options?.fetchFn === 'function'
      ? options.fetchFn
      : typeof payload?.fetchFn === 'function'
        ? payload.fetchFn
        : fetch;
  const effectiveOpts = options?.userDataDir || options?.homedir || options?.legendaryBaseDirs
    ? options
    : payload;
  const vaultOpts = resolveStoreVaultOptions(effectiveOpts);
  const rawAppName = String(payload.appName || payload.platformGameId || payload.slug || '')
    .replace(/^epic-/i, '')
    .trim();
  const normTitle = String(payload.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  if (payload.namespace && String(payload.namespace).trim()) {
    return {
      namespace: String(payload.namespace).trim(),
      catalogItemId: payload.catalogItemId ? String(payload.catalogItemId).trim() : null,
      appName: rawAppName || null,
    };
  }

  const lookupInCache = () => {
    if (rawAppName) {
      const byApp = getEpicNamespaceByLookupKey('app:' + rawAppName.toLowerCase());
      if (byApp) return byApp;
    }
    if (payload.catalogItemId) {
      const byCat = getEpicNamespaceByLookupKey('cat:' + String(payload.catalogItemId).toLowerCase());
      if (byCat) return byCat;
    }
    if (normTitle) {
      const byTitle = getEpicNamespaceByLookupKey('title:' + normTitle);
      if (byTitle) return byTitle;
    }
    return null;
  };

  let cached = lookupInCache();
  if (cached?.namespace) return cached;

  // 2. Check direct Legendary metadata/<appName>.json with strict containment
  const legendaryBaseDirs = getLocalLegendaryBaseDirs(effectiveOpts);
  if (rawAppName) {
    for (const baseDir of legendaryBaseDirs) {
      const metaFile = resolveSafeLegendaryMetaFilePath(baseDir, rawAppName);
      if (!metaFile) continue;
      try {
        const json = JSON.parse(await fs.promises.readFile(metaFile, 'utf-8'));
        const ns = json?.metadata?.namespace || json?.namespace;
        const catId = json?.metadata?.id || json?.catalog_item_id;
        const t = json?.app_title || json?.metadata?.title;
        if (ns) {
          registerEpicNamespaceMapping({
            appName: json?.app_name || rawAppName,
            namespace: ns,
            catalogItemId: catId,
            title: t,
          });
          cached = lookupInCache();
          if (cached?.namespace) return cached;
        }
      } catch {}
    }
  }

  // Scope local metadata scans by resolved root path (fixing global boolean test-isolation bleed)
  for (const baseDir of legendaryBaseDirs) {
    if (!baseDir) continue;
    const resolvedBase = path.resolve(baseDir);
    if (scannedLocalEpicMetadataRoots.has(resolvedBase)) continue;
    scannedLocalEpicMetadataRoots.add(resolvedBase);

    const assetsFile = path.join(baseDir, 'assets.json');
    try {
      const assetsJson = JSON.parse(await fs.promises.readFile(assetsFile, 'utf-8'));
      for (const list of Object.values(assetsJson || {})) {
        if (Array.isArray(list)) {
          for (const item of list) {
            registerEpicNamespaceMapping({
              appName: item?.app_name || item?.appName,
              namespace: item?.namespace,
              catalogItemId: item?.catalog_item_id || item?.catalogItemId,
              title: item?.app_title || item?.title,
            });
          }
        }
      }
    } catch {}

    const entitlementsFile = path.join(baseDir, 'entitlements.json');
    try {
      const entJson = JSON.parse(await fs.promises.readFile(entitlementsFile, 'utf-8'));
      if (Array.isArray(entJson)) {
        for (const item of entJson) {
          if (!item || typeof item !== 'object') continue;
          const rawTitle = String(item.entitlementName || '').trim();
          const safeTitle =
            rawTitle && !/^[0-9a-f]{24,}$/i.test(rawTitle) ? rawTitle : undefined;
          registerEpicNamespaceMapping({
            namespace: item.namespace,
            catalogItemId: item.catalogItemId || item.catalog_item_id,
            title: safeTitle,
          });
        }
      }
    } catch {}

    const installedFile = path.join(baseDir, 'installed.json');
    try {
      const instJson = JSON.parse(await fs.promises.readFile(installedFile, 'utf-8'));
      for (const item of Object.values(instJson || {})) {
        if (item && typeof item === 'object') {
          const rec = /** @type {Record<string, any>} */ (item);
          registerEpicNamespaceMapping({
            appName: rec.app_name || rec.appName,
            namespace: rec.namespace,
            catalogItemId: rec.catalog_item_id || rec.catalogItemId,
            title: rec.title || rec.app_title,
          });
        }
      }
    } catch {}

    const metaDir = path.join(baseDir, 'metadata');
    try {
      const files = (await fs.promises.readdir(metaDir)).filter((f) => f.endsWith('.json'));
      const META_CONCURRENCY = 16;
      for (let i = 0; i < files.length; i += META_CONCURRENCY) {
        const chunk = files.slice(i, i + META_CONCURRENCY);
        const parsedChunk = await Promise.all(
          chunk.map(async (f) => {
            try {
              const raw = await fs.promises.readFile(path.join(metaDir, f), 'utf-8');
              return { f, json: JSON.parse(raw) };
            } catch {
              return null;
            }
          })
        );
        for (const entry of parsedChunk) {
          if (!entry) continue;
          registerEpicNamespaceMapping({
            appName: entry.json?.app_name || entry.f.replace(/\.json$/i, ''),
            namespace: entry.json?.metadata?.namespace || entry.json?.namespace,
            catalogItemId: entry.json?.metadata?.id || entry.json?.catalog_item_id,
            title: entry.json?.app_title || entry.json?.metadata?.title,
          });
        }
      }
    } catch {}
  }

  // 3. Check local Epic Games Launcher Manifests/*.item (scoped by root, avoiding hardcoded C:\ProgramData)
  const hasExplicitIsolation = Boolean(
    options?.homedir ||
      options?.userDataDir ||
      Array.isArray(options?.legendaryBaseDirs) ||
      payload?.homedir ||
      payload?.userDataDir ||
      Array.isArray(payload?.legendaryBaseDirs)
  );
  const homeDir =
    options?.homedir || payload?.homedir || process.env.HOME || process.env.USERPROFILE || '';
  const winProgramData =
    !hasExplicitIsolation && process.platform === 'win32'
      ? String(process.env.PROGRAMDATA || '').trim()
      : '';
  const manifestDirs = [
    homeDir
      ? path.join(homeDir, 'Library/Application Support/Epic/EpicGamesLauncher/Data/Manifests')
      : '',
    winProgramData
      ? path.join(winProgramData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
      : '',
  ].filter(Boolean);

  for (const mDir of manifestDirs) {
    const resolvedManifestDir = path.resolve(mDir);
    if (scannedLocalEpicMetadataRoots.has(resolvedManifestDir)) continue;
    scannedLocalEpicMetadataRoots.add(resolvedManifestDir);
    try {
      const itemFiles = (await fs.promises.readdir(mDir)).filter((f) => f.endsWith('.item'));
      for (const f of itemFiles) {
        try {
          const json = JSON.parse(await fs.promises.readFile(path.join(mDir, f), 'utf-8'));
          registerEpicNamespaceMapping({
            appName: json?.AppName,
            namespace: json?.CatalogNamespace,
            catalogItemId: json?.CatalogItemId,
            title: json?.DisplayName,
          });
        } catch {}
      }
    } catch {}
  }

  cached = lookupInCache();
  if (cached?.namespace) return cached;

  // 4. Query public assets list if user has a saved Epic token (TTL-cached & retryable on failure)
  const nowMs = Date.now();
  const cloudAssetsFresh =
    epicCloudAssetsFetchedAtMs > 0 && nowMs - epicCloudAssetsFetchedAtMs < EPIC_CLOUD_ASSETS_CACHE_TTL_MS;
  if (!cloudAssetsFresh && nowMs >= epicCloudAssetsRetryAfterMs) {
    if (!inFlightEpicCloudAssetsPromise) {
      inFlightEpicCloudAssetsPromise = (async () => {
        const savedEpic = (await loadSavedTokensAsync(vaultOpts))?.epic;
        if (!savedEpic?.access_token) return;
        try {
          const authOpts = { ...effectiveOpts, fetchFn: fetchImpl };
          let token = await getEpicCatalogAccessToken(false, authOpts);
          if (!token) return;
          let assetsRes = await fetchImpl(
            'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/Windows?label=Live',
            {
              headers: {
                Authorization: `bearer ${token}`,
                'User-Agent': buildPlatformStoreUserAgent('EpicGamesLauncher'),
              },
              signal: buildStoreFetchSignal(options?.signal),
            }
          );
          if ((assetsRes.status === 401 || assetsRes.status === 403) && savedEpic.refresh_token) {
            try {
              const renewed = await renewEpicTokens(savedEpic.refresh_token, authOpts);
              token = renewed.access_token;
              assetsRes = await fetchImpl(
                'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/Windows?label=Live',
                {
                  headers: {
                    Authorization: `bearer ${token}`,
                    'User-Agent': buildPlatformStoreUserAgent('EpicGamesLauncher'),
                  },
                  signal: buildStoreFetchSignal(options?.signal),
                }
              );
            } catch {}
          }
          if (assetsRes.ok) {
            const assetsList = await assetsRes.json();
            if (Array.isArray(assetsList)) {
              for (const asset of assetsList) {
                registerEpicNamespaceMapping({
                  appName: asset?.appName,
                  namespace: asset?.namespace,
                  catalogItemId: asset?.catalogItemId,
                });
              }
              epicCloudAssetsFetchedAtMs = Date.now();
              epicCloudAssetsRetryAfterMs = 0;
              return;
            }
          }
          epicCloudAssetsRetryAfterMs = Date.now() + EPIC_CLOUD_ASSETS_ERROR_BACKOFF_MS;
        } catch {
          epicCloudAssetsRetryAfterMs = Date.now() + EPIC_CLOUD_ASSETS_ERROR_BACKOFF_MS;
        }
      })().finally(() => {
        inFlightEpicCloudAssetsPromise = null;
      });
    }
    await inFlightEpicCloudAssetsPromise;
  }

  cached = lookupInCache();
  if (cached?.namespace) return cached;

  return {
    namespace: payload.namespace || null,
    catalogItemId: payload.catalogItemId || null,
    appName: rawAppName || null,
  };
}

function resetEpicCloudAuthState() {
  epicCloudAssetsFetchedAtMs = 0;
  epicCloudAssetsRetryAfterMs = 0;
  cachedEpicClientToken = null;
  cachedEpicClientTokenExpiry = 0;
}

function trimEpicAuthAndNamespaceMemory() {
  epicCloudAssetsFetchedAtMs = 0;
  epicCloudAssetsRetryAfterMs = 0;
  scannedLocalEpicMetadataRoots.clear();
  while (epicAppNamespaceCache.size > MAX_EPIC_NAMESPACE_CACHE_APPS) {
    const oldestKey = epicAppNamespaceCache.keys().next().value;
    if (oldestKey === undefined) break;
    epicAppNamespaceCache.delete(oldestKey);
  }
  while (epicAppNamespaceSecondaryIndex.size > MAX_EPIC_NAMESPACE_INDEX_KEYS) {
    const oldestKey = epicAppNamespaceSecondaryIndex.keys().next().value;
    if (oldestKey === undefined) break;
    epicAppNamespaceSecondaryIndex.delete(oldestKey);
  }
}

module.exports = {
  exchangeEpicCode,
  renewEpicTokens,
  extractEpicCustomAttributesMap,
  resolveEpicPartnerChainedHandoff,
  readLocalLegendaryCustomAttributes,
  readLocalLegendaryCustomAttributesAsync,
  registerEpicNamespaceMapping,
  getEpicNamespaceByLookupKey,
  getEpicCatalogAccessToken,
  getLocalLegendaryBaseDirs,
  extractEpicMacSupportFromLegendaryDirs,
  extractEpicMacSupportFromLegendaryDirsAsync,
  resolveEpicNamespaceAndIds,
  resetEpicCloudAuthState,
  trimEpicAuthAndNamespaceMemory,
};
