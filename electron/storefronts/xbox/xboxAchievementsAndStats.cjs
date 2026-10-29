'use strict';

/**
 * Xbox Live Bulk `TitleHub` Summaries, `Achievements v2` + Legacy `v1` (Xbox 360 / GFWL PC)
 * Schema Mapper, and `UserStats` `MinutesPlayed` Batch Telemetry (`xboxAchievementsAndStats.cjs`).
 *
 * NOTE ON STRICT ACTIVE-ACCESS GATE:
 * `fetchXboxTitleHubSummaries` returns decorator maps (`byTitleId`, `byPfn`, `byProductId`) and
 * played-signal sets (`playedProductIds`, `playedPfns`, `playedTitleIds`). It NEVER admits games
 * into the library on its own!
 */

const TITLEHUB_BASE_URL = 'https://titlehub.xboxlive.com';
const ACHIEVEMENTS_BASE_URL = 'https://achievements.xboxlive.com';
const USERSTATS_BATCH_URL = 'https://userstats.xboxlive.com/batch';
const XBOX_HTTP_TIMEOUT_MS = 20_000;

function buildXboxFetchSignal(callerSignal, timeoutMs = XBOX_HTTP_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (callerSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([callerSignal, timeoutSignal]);
  }
  return callerSignal || timeoutSignal;
}

function resolveDefaultXboxLocale(explicitLocale) {
  if (typeof explicitLocale === 'string' && explicitLocale.trim()) {
    return explicitLocale.trim();
  }
  try {
    const reqElectron = require('electron');
    const appLocale = reqElectron?.app?.getLocale?.();
    if (typeof appLocale === 'string' && appLocale.trim()) {
      const trimmed = appLocale.trim();
      if (trimmed.includes('-')) return trimmed;
      const country = String(reqElectron?.app?.getLocaleCountryCode?.() || '').trim().toUpperCase();
      if (/^[a-z]{2}$/i.test(trimmed) && /^[A-Z]{2}$/.test(country)) {
        return `${trimmed.toLowerCase()}-${country}`;
      }
      if (/^[a-z]{2}$/i.test(trimmed) && trimmed.toLowerCase() === 'en') {
        return 'en-US';
      }
    }
  } catch {}
  return 'en-US';
}

function isValidNonSentinelTimestamp(rawTs) {
  if (!rawTs || typeof rawTs !== 'string') return false;
  const trimmed = rawTs.trim();
  if (!trimmed) return false;
  if (
    trimmed.startsWith('0001-') ||
    trimmed.startsWith('1601-') ||
    trimmed.startsWith('1753-') ||
    trimmed.startsWith('1900-') ||
    trimmed.startsWith('1970-01-01T00:00:00')
  ) {
    return false;
  }
  const parsed = Date.parse(trimmed);
  return !Number.isNaN(parsed) && parsed > 946684800000; // > 2000-01-01
}

function normalizeHttpsUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let u = rawUrl.trim();
  if (!u) return '';
  if (u.startsWith('//')) u = `https:${u}`;
  else if (u.startsWith('http://')) u = `https://${u.slice(7)}`;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function classifyRarityTier(globalPercentage, rawCategory = '') {
  const cat = String(rawCategory || '').trim().toLowerCase();
  if (typeof globalPercentage === 'number' && Number.isFinite(globalPercentage)) {
    if (globalPercentage < 5) return 'ultra_rare';
    if (globalPercentage < 15) return 'rare';
    if (globalPercentage < 50) return 'uncommon';
    return 'common';
  }
  if (cat === 'rare') return 'rare';
  return 'common';
}

function normalizeTitleIdString(rawTitleId) {
  if (rawTitleId === null || rawTitleId === undefined) return '';
  const str = String(rawTitleId).trim();
  if (!str) return '';
  if (/^0x[0-9a-f]+$/i.test(str)) {
    return String(parseInt(str, 16) >>> 0);
  }
  return str;
}

// ============================================================================
// 1. Bulk `TitleHub` Achievement & Engagement Decorator
// ============================================================================

function parseTitleHubEntry(entry, syncedAt = new Date().toISOString()) {
  if (!entry || typeof entry !== 'object') return null;

  const titleId = normalizeTitleIdString(entry.titleId);
  const pfn = String(entry.pfn || entry.packageFamilyName || '').trim();
  const productId = String(entry.modernTitleId || entry.productId || entry.bingId || '')
    .trim()
    .toUpperCase();
  const scid = String(entry.serviceConfigId || '').trim() || undefined;
  const name = String(entry.name || '').trim();

  const ach = entry.achievement && typeof entry.achievement === 'object' ? entry.achievement : null;
  const rawLastPlayed =
    entry.titleHistory?.lastTimePlayed || entry.lastTimePlayed || '';
  const lastTimePlayed = isValidNonSentinelTimestamp(rawLastPlayed)
    ? new Date(Date.parse(rawLastPlayed)).toISOString()
    : undefined;

  let summary = undefined;
  if (ach) {
    const unlocked = Number(ach.currentAchievements || 0) || 0;
    const totalRaw = Number(ach.totalAchievements || 0) || 0;
    const earnedGs = Number(ach.currentGamerscore || 0) || 0;
    const totalGs = Number(ach.totalGamerscore || 0) || 0;
    const pctRaw = Number(ach.progressPercentage || 0) || 0;

    // Derive total achievement count when TitleHub omits `totalAchievements` on 0%-unlocked games
    const total =
      totalRaw > 0
        ? totalRaw
        : unlocked > 0 && pctRaw > 0
          ? Math.max(unlocked, Math.round((unlocked / pctRaw) * 100))
          : 0;

    if (total > 0 || totalGs > 0 || unlocked > 0) {
      const percentage =
        total > 0
          ? Math.min(100, Math.round((unlocked / total) * 100))
          : Math.min(100, Math.round(pctRaw));
      summary = {
        unlocked,
        total,
        percentage,
        gamerscore: {
          earned: earnedGs,
          total: totalGs,
        },
        isMastered: (total > 0 && unlocked >= total) || (totalGs > 0 && earnedGs >= totalGs),
        ...(lastTimePlayed && unlocked > 0 ? { lastUnlockedAt: lastTimePlayed } : {}),
        source: 'live_cloud_api',
        syncedAt,
      };
    }
  }

  return {
    titleId,
    pfn,
    productId: /^[A-Z0-9]{12}$/.test(productId) ? productId : '',
    scid,
    name,
    lastTimePlayed,
    wasPlayed: Boolean(
      entry.titleHistory?.lastTimePlayed &&
        isValidNonSentinelTimestamp(entry.titleHistory.lastTimePlayed)
    ),
    summary,
  };
}

/**
 * Fetches bulk Xbox achievement summaries, `SCID`s, and `lastTimePlayed` timestamps from `TitleHub`
 * (`titlehistory` + optional `/titles/batch` for unplayed `pfns[]`).
 *
 * @param {{
 *   xuid: string,
 *   authorizationHeader: string,
 *   pfns?: string[],
 *   locale?: string,
 *   skipHistory?: boolean,
 *   signal?: AbortSignal,
 *   fetchImpl?: typeof fetch,
 *   customFetch?: typeof fetch,
 * }} [params]
 */
async function fetchXboxTitleHubSummaries(params = /** @type {any} */ ({})) {
  const {
    xuid,
    authorizationHeader,
    pfns = [],
    skipHistory = false,
  } = params;
  const locale = resolveDefaultXboxLocale(params.locale);
  const fetchImpl = params.customFetch || params.fetchImpl || globalThis.fetch;

  const byTitleId = {};
  const byPfn = {};
  const byProductId = {};
  const achievementsMap = {};
  const playedProductIds = new Set();
  const playedPfns = new Set();
  const playedTitleIds = new Set();

  if (!xuid || !authorizationHeader || typeof fetchImpl !== 'function') {
    return {
      byTitleId,
      byPfn,
      byProductId,
      achievementsMap,
      playedProductIds: [],
      playedPfns: [],
      playedTitleIds: [],
    };
  }

  const syncedAt = new Date().toISOString();
  const headers = {
    Authorization: authorizationHeader,
    'x-xbl-contract-version': '2',
    Accept: 'application/json',
    'Accept-Language': locale,
  };

  const registerParsed = (parsed, fromHistory = false) => {
    if (!parsed) return;
    if (fromHistory || parsed.wasPlayed) {
      if (parsed.productId) playedProductIds.add(parsed.productId);
      if (parsed.pfn) playedPfns.add(parsed.pfn.toLowerCase());
      if (parsed.titleId) playedTitleIds.add(parsed.titleId);
    }

    if (parsed.titleId) {
      byTitleId[parsed.titleId] = {
        ...(byTitleId[parsed.titleId] || {}),
        ...parsed,
        summary: parsed.summary || byTitleId[parsed.titleId]?.summary,
      };
    }
    if (parsed.pfn) {
      const pLower = parsed.pfn.toLowerCase();
      byPfn[pLower] = {
        ...(byPfn[pLower] || {}),
        ...parsed,
        summary: parsed.summary || byPfn[pLower]?.summary,
      };
    }
    if (parsed.productId) {
      byProductId[parsed.productId] = {
        ...(byProductId[parsed.productId] || {}),
        ...parsed,
        summary: parsed.summary || byProductId[parsed.productId]?.summary,
      };
    }

    if (parsed.summary) {
      if (parsed.productId) {
        achievementsMap[parsed.productId] = parsed.summary;
        achievementsMap[`xbox-${parsed.productId}`] = parsed.summary;
        achievementsMap[parsed.productId.toLowerCase()] = parsed.summary;
      }
      if (parsed.titleId) {
        achievementsMap[parsed.titleId] = parsed.summary;
      }
      if (parsed.pfn) {
        achievementsMap[parsed.pfn.toLowerCase()] = parsed.summary;
      }
      if (parsed.name) {
        const lowerName = parsed.name.toLowerCase().trim();
        achievementsMap[lowerName] = parsed.summary;
      }
    }
  };

  // 1. Played history (`titlehistory`)
  if (!skipHistory) {
    try {
      const historyUrl = `${TITLEHUB_BASE_URL}/users/xuid(${encodeURIComponent(xuid)})/titles/titlehistory/decoration/achievement,scid,image,detail,productId?maxItems=1000`;
      const res = await fetchImpl(historyUrl, {
        method: 'GET',
        headers,
        signal: buildXboxFetchSignal(params.signal),
      });
      if (res.ok) {
        const json = await res.json();
        const titles = Array.isArray(json?.titles) ? json.titles : [];
        for (const item of titles) {
          registerParsed(parseTitleHubEntry(item, syncedAt), true);
        }
      }
    } catch {}
  }

  // 2. Batch lookup for unplayed PFNs so unplayed owned games still get `0 / total` achievements & SCIDs
  const missingPfns = Array.from(
    new Set(
      (pfns || [])
        .map((p) => String(p || '').trim())
        .filter((p) => p && !byPfn[p.toLowerCase()])
    )
  );

  if (missingPfns.length > 0) {
    for (let i = 0; i < missingPfns.length; i += 100) {
      const chunk = missingPfns.slice(i, i + 100);
      try {
        const batchUrl = `${TITLEHUB_BASE_URL}/users/xuid(${encodeURIComponent(xuid)})/titles/batch/decoration/achievement,scid,detail`;
        const res = await fetchImpl(batchUrl, {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ pfns: chunk }),
          signal: buildXboxFetchSignal(params.signal),
        });
        if (res.ok) {
          const json = await res.json();
          const titles = Array.isArray(json?.titles) ? json.titles : [];
          for (const item of titles) {
            registerParsed(parseTitleHubEntry(item, syncedAt), false);
          }
        }
      } catch {}
    }
  }

  return {
    byTitleId,
    byPfn,
    byProductId,
    achievementsMap,
    playedProductIds: Array.from(playedProductIds),
    playedPfns: Array.from(playedPfns),
    playedTitleIds: Array.from(playedTitleIds),
  };
}

// ============================================================================
// 2. `UserStats` `MinutesPlayed` Batch Telemetry (with Deduplication!)
// ============================================================================

/**
 * Extracts per-`titleId` `MinutesPlayed` from a `userstats.xboxlive.com/batch` JSON payload,
 * strictly deduplicating (`Math.max`) across `groups[].statlistscollection[]` and root
 * `statlistscollection[]` so playtime is NEVER doubled!
 *
 * @param {any} json
 * @returns {Map<string, number>}
 */
function extractMinutesPlayedFromUserStats(json) {
  const result = new Map();
  if (!json || typeof json !== 'object') return result;

  const collections = [];
  if (Array.isArray(json.statlistscollection)) {
    collections.push(...json.statlistscollection);
  }
  if (Array.isArray(json.groups)) {
    for (const grp of json.groups) {
      if (Array.isArray(grp?.statlistscollection)) {
        collections.push(...grp.statlistscollection);
      }
    }
  }

  for (const col of collections) {
    const stats = Array.isArray(col?.stats) ? col.stats : [];
    for (const stat of stats) {
      const name = String(stat?.name || '').trim().toLowerCase();
      if (name !== 'minutesplayed') continue;
      const tid = normalizeTitleIdString(stat?.titleid ?? stat?.titleId);
      if (!tid) continue;
      const val = Math.round(Number(stat?.value || 0));
      if (!Number.isFinite(val) || val <= 0) continue;
      const prev = result.get(tid) || 0;
      if (val > prev) {
        result.set(tid, val);
      }
    }
  }

  return result;
}

/**
 * Fetches `MinutesPlayed` across batches of 50 `titleId`s via `POST https://userstats.xboxlive.com/batch`.
 */
async function fetchXboxPlaytimeBatch(params = {}) {
  const { xuid, authorizationHeader, titleIds = [] } = params;
  const fetchImpl = params.customFetch || params.fetchImpl || globalThis.fetch;
  const combined = new Map();

  const cleanTitleIds = Array.from(
    new Set(
      (titleIds || [])
        .map((t) => normalizeTitleIdString(t))
        .filter((t) => /^\d+$/.test(t) && t !== '0')
    )
  );

  if (!xuid || !authorizationHeader || cleanTitleIds.length === 0 || typeof fetchImpl !== 'function') {
    return combined;
  }

  for (let i = 0; i < cleanTitleIds.length; i += 50) {
    const batch = cleanTitleIds.slice(i, i + 50);
    // Do NOT include `groups: [{ name: 'Hero', ... }]` here: `userstats.xboxlive.com/batch`
    // rejects batches > 10 `Hero` groups with HTTP 400 InvalidRequestError, whereas `stats`
    // (`MinutesPlayed`) alone succeeds for up to 50 titles per batch!
    const body = {
      arrangebyfield: 'xuid',
      xuids: [String(xuid)],
      stats: batch.map((tid) => ({ name: 'MinutesPlayed', titleId: tid })),
    };

    try {
      const res = await fetchImpl(USERSTATS_BATCH_URL, {
        method: 'POST',
        headers: {
          Authorization: authorizationHeader,
          'x-xbl-contract-version': '2',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: buildXboxFetchSignal(params.signal),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const map = extractMinutesPlayedFromUserStats(json);
      for (const [tid, mins] of map.entries()) {
        const prev = combined.get(tid) || 0;
        if (mins > prev) combined.set(tid, mins);
      }
    } catch {}
  }

  return combined;
}

// ============================================================================
// 3. Detailed Per-Game Achievements (`v2` Modern + `v1` Xbox 360 / GFWL PC)
// ============================================================================

/**
 * Maps a modern Xbox Live `v2` (`x-xbl-contract-version: 2`) achievement record to One Launcher's
 * `DetailedAchievement` contract (including both canonical fields and legacy renderer aliases).
 */
function mapXboxV2Achievement(ach, titleId = '') {
  const cleanTitleId = normalizeTitleIdString(
    titleId || ach?.titleAssociations?.[0]?.id || ''
  );
  const rawId = String(ach?.id ?? '').trim() || '0';
  const compositeId = cleanTitleId ? `xbox:${cleanTitleId}:${rawId}` : `xbox:${rawId}`;

  const unlocked = String(ach?.progressState || '').trim().toLowerCase() === 'achieved';
  const isSecret = Boolean(ach?.isSecret);

  const rawName = String(ach?.name || '').trim();
  const name =
    isSecret && !unlocked && !rawName
      ? 'Secret Achievement'
      : rawName || (isSecret && !unlocked ? 'Secret Achievement' : `Achievement ${rawId}`);

  const description = unlocked
    ? String(ach?.description || ach?.lockedDescription || '').trim()
    : isSecret
      ? 'Continue playing to unlock this secret achievement.'
      : String(ach?.lockedDescription || ach?.description || '').trim();

  const rawTime = ach?.progression?.timeUnlocked;
  const unlockedAt =
    unlocked && isValidNonSentinelTimestamp(rawTime)
      ? new Date(Date.parse(rawTime)).toISOString()
      : undefined;

  let gamerscore = 0;
  if (Array.isArray(ach?.rewards)) {
    const gsReward = ach.rewards.find(
      (r) => String(r?.type || '').trim().toLowerCase() === 'gamerscore'
    );
    if (gsReward && gsReward.value !== undefined) {
      gamerscore = parseInt(String(gsReward.value), 10) || 0;
    }
  } else if (ach?.gamerscore !== undefined) {
    gamerscore = Number(ach.gamerscore) || 0;
  }

  const assets = Array.isArray(ach?.mediaAssets) ? ach.mediaAssets : [];
  const iconAsset =
    assets.find((a) => String(a?.type || '').toLowerCase() === 'icon' && a?.url) ||
    assets.find((a) => a?.url) ||
    null;
  const iconUrl = normalizeHttpsUrl(iconAsset?.url || '');

  const rawPct = ach?.rarity?.currentPercentage;
  const globalPercentage =
    rawPct !== undefined && rawPct !== null && Number.isFinite(Number(rawPct))
      ? Number(Number(rawPct).toFixed(1))
      : undefined;
  const rarityTier = classifyRarityTier(globalPercentage, ach?.rarity?.currentCategory);

  let progress = undefined;
  if (!unlocked && Array.isArray(ach?.progression?.requirements) && ach.progression.requirements.length > 0) {
    const req = ach.progression.requirements[0];
    const current = Number(req?.current || 0);
    const max = Number(req?.target || 0);
    if (Number.isFinite(current) && Number.isFinite(max) && max > 0) {
      progress = {
        current,
        max,
        percentage: Math.min(100, Math.round((current / max) * 100)),
      };
    }
  }

  return {
    id: compositeId,
    apiName: rawId,
    name,
    description,
    unlocked,
    unlockedAt,
    unlockTime: unlockedAt,
    iconUnlockedUrl: iconUrl,
    iconLockedUrl: iconUrl || undefined,
    iconUrl,
    iconGrayUrl: iconUrl || undefined,
    globalPercentage,
    globalPercent: globalPercentage,
    rarityTier,
    ...(progress ? { progress } : {}),
    isSecret,
    isHidden: isSecret,
    gamerscore,
    storefrontId: 'xbox',
  };
}

/**
 * Maps a legacy Xbox 360 / Games for Windows Live `v1` (`x-xbl-contract-version: 1`) achievement record
 * to One Launcher's `DetailedAchievement` contract, synthesizing tile icon URLs via
 * `https://image-ssl.xboxlive.com/global/t.{titleIdHex8}/ach/0/{imageIdHex}`.
 */
function mapXboxV1Achievement(ach, titleId = '') {
  const cleanTitleId = normalizeTitleIdString(titleId || ach?.titleId || '');
  const rawId = String(ach?.id ?? '').trim() || '0';
  const compositeId = cleanTitleId ? `xbox:${cleanTitleId}:${rawId}` : `xbox:${rawId}`;

  const unlocked = Boolean(ach?.unlocked || ach?.unlockedOnline);
  const isSecret = Boolean(ach?.isSecret);

  const rawName = String(ach?.name || '').trim();
  const name =
    isSecret && !unlocked
      ? 'Secret Achievement'
      : rawName || `Achievement ${rawId}`;

  const description = unlocked
    ? String(ach?.description || ach?.lockedDescription || '').trim()
    : isSecret
      ? 'Continue playing to unlock this secret achievement.'
      : String(ach?.lockedDescription || ach?.description || '').trim();

  const rawTime = ach?.timeUnlocked;
  const unlockedAt =
    unlocked && isValidNonSentinelTimestamp(rawTime)
      ? new Date(Date.parse(rawTime)).toISOString()
      : undefined;

  const gamerscore = Number(ach?.gamerscore || 0) || 0;

  let iconUrl = normalizeHttpsUrl(ach?.imageUnlockedUrl || ach?.mediaAssets?.[0]?.url || '');
  if (!iconUrl && cleanTitleId && /^\d+$/.test(cleanTitleId) && ach?.imageId !== undefined) {
    const titleHex8 = (Number(cleanTitleId) >>> 0).toString(16).padStart(8, '0');
    const imgHex = (Number(ach.imageId) >>> 0).toString(16);
    iconUrl = `https://image-ssl.xboxlive.com/global/t.${titleHex8}/ach/0/${imgHex}`;
  }

  const rawPct = ach?.rarity?.currentPercentage ?? ach?.rarityPercentage;
  const globalPercentage =
    rawPct !== undefined && rawPct !== null && Number.isFinite(Number(rawPct))
      ? Number(Number(rawPct).toFixed(1))
      : undefined;

  return {
    id: compositeId,
    apiName: rawId,
    name,
    description,
    unlocked,
    unlockedAt,
    unlockTime: unlockedAt,
    iconUnlockedUrl: iconUrl,
    iconLockedUrl: normalizeHttpsUrl(ach?.imageLockedUrl || '') || iconUrl || undefined,
    iconUrl,
    iconGrayUrl: normalizeHttpsUrl(ach?.imageLockedUrl || '') || iconUrl || undefined,
    globalPercentage,
    globalPercent: globalPercentage,
    rarityTier: classifyRarityTier(globalPercentage, ach?.rarity?.currentCategory),
    isSecret,
    isHidden: isSecret,
    gamerscore,
    storefrontId: 'xbox',
  };
}

function buildAchievementsContainer(mappedList, schemaVersion = 'v2') {
  const total = mappedList.length;
  const unlocked = mappedList.filter((a) => a.unlocked).length;
  const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
  const totalGamerscore = mappedList.reduce((acc, a) => acc + (a.gamerscore || 0), 0);
  const earnedGamerscore = mappedList.reduce(
    (acc, a) => acc + (a.unlocked ? a.gamerscore || 0 : 0),
    0
  );

  return {
    storefrontId: 'xbox',
    storefrontName: 'Xbox',
    total,
    unlocked,
    percentage,
    isMastered: total > 0 && unlocked >= total,
    gamerscore: { earned: earnedGamerscore, total: totalGamerscore },
    totalGamerscore,
    earnedGamerscore,
    achievements: mappedList,
    syncedAt: new Date().toISOString(),
    source: 'live_cloud',
    supportsAchievements: total > 0,
    schemaVersion,
  };
}

/**
 * Fetches detailed per-game Xbox achievements via `v2` (`achievements`) with automatic `v1`
 * (`titleachievements`) fallback for legacy Xbox 360 / GFWL PC titles.
 *
 * @param {{
 *   xuid: string,
 *   titleId: string | number,
 *   authorizationHeader: string,
 *   locale?: string,
 *   signal?: AbortSignal,
 *   fetchImpl?: typeof fetch,
 *   customFetch?: typeof fetch,
 * }} [params]
 */
async function fetchXboxDetailedAchievements(params = /** @type {any} */ ({})) {
  const {
    xuid,
    titleId: rawTitleId,
    authorizationHeader,
  } = params;
  const locale = resolveDefaultXboxLocale(params.locale);
  const fetchImpl = params.customFetch || params.fetchImpl || globalThis.fetch;

  const cleanTitleId = normalizeTitleIdString(rawTitleId);
  if (!xuid || !cleanTitleId || !authorizationHeader || typeof fetchImpl !== 'function') {
    return buildAchievementsContainer([], 'v2');
  }

  // 1. Primary: Modern `v2` (`x-xbl-contract-version: 2`)
  try {
    const v2Raw = [];
    let ct = '';
    for (let page = 0; page < 5; page++) {
      const url = `${ACHIEVEMENTS_BASE_URL}/users/xuid(${encodeURIComponent(xuid)})/achievements?titleId=${encodeURIComponent(cleanTitleId)}&maxItems=1000${ct ? `&continuationToken=${encodeURIComponent(ct)}` : ''}`;
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: authorizationHeader,
          'x-xbl-contract-version': '2',
          Accept: 'application/json',
          'Accept-Language': locale,
        },
        signal: buildXboxFetchSignal(params.signal),
      });
      if (!res.ok) break;
      const json = await res.json();
      const items = Array.isArray(json?.achievements) ? json.achievements : [];
      v2Raw.push(...items);
      const nextCt = json?.pagingInfo?.continuationToken || '';
      if (!nextCt || nextCt === ct || items.length === 0) break;
      ct = nextCt;
    }

    if (v2Raw.length > 0) {
      const mapped = v2Raw.map((a) => mapXboxV2Achievement(a, cleanTitleId));
      return buildAchievementsContainer(mapped, 'v2');
    }
  } catch {}

  // 2. Fallback: Legacy `v1` (`titleachievements`, `x-xbl-contract-version: 1`) for Xbox 360 / GFWL PC
  try {
    const v1Url = `${ACHIEVEMENTS_BASE_URL}/users/xuid(${encodeURIComponent(xuid)})/titleachievements?titleId=${encodeURIComponent(cleanTitleId)}&maxItems=1000`;
    const v1Res = await fetchImpl(v1Url, {
      method: 'GET',
      headers: {
        Authorization: authorizationHeader,
        'x-xbl-contract-version': '1',
        Accept: 'application/json',
        'Accept-Language': locale,
      },
      signal: buildXboxFetchSignal(params.signal),
    });
    if (v1Res.ok) {
      const v1Json = await v1Res.json();
      const items = Array.isArray(v1Json?.achievements) ? v1Json.achievements : [];
      if (items.length > 0) {
        const mapped = items.map((a) => mapXboxV1Achievement(a, cleanTitleId));
        return buildAchievementsContainer(mapped, 'v1');
      }
    }
  } catch {}

  return buildAchievementsContainer([], 'v2');
}

module.exports = {
  resolveDefaultXboxLocale,
  isValidNonSentinelTimestamp,
  normalizeTitleIdString,
  parseTitleHubEntry,
  fetchXboxTitleHubSummaries,
  extractMinutesPlayedFromUserStats,
  fetchXboxPlaytimeBatch,
  mapXboxV2Achievement,
  mapXboxV1Achievement,
  buildAchievementsContainer,
  fetchXboxDetailedAchievements,
};
