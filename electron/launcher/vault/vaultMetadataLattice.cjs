// @ts-check
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { normalizePublisherLauncherId } = require('../../utils/windowsRegistryDiscovery.cjs');
const { classifyNonGameStorefrontItem } = require('../../storefronts/nonGameClassifier.cjs');

const STANDALONE_LAUNCHER_UTILITY_TITLE_RE =
  /^(?:minecraft\s+launcher|ea\s+app|ubisoft\s+connect|rockstar\s+games\s+launcher|battle\.net|riot\s+client|gog\s+galaxy|epic\s+games\s+launcher)$/i;

/**
 * @param {unknown} title
 * @param {any[] | null | undefined} platforms
 * @returns {boolean}
 */
function isStandaloneStorefrontLauncherUtility(title, platforms) {
  const cleanTitle = String(title || '').trim();
  if (cleanTitle && STANDALONE_LAUNCHER_UTILITY_TITLE_RE.test(cleanTitle)) {
    return Boolean(
      classifyNonGameStorefrontItem({
        title: cleanTitle,
        platformId: String(platforms?.[0]?.platformId || '').toLowerCase() || 'xbox',
        platformGameId: String(platforms?.[0]?.platformGameId || ''),
        isDlc: false,
      })
    );
  }
  if (
    Array.isArray(platforms) &&
    platforms.length > 0 &&
    platforms.every((ep) =>
      String(ep?.packageFamilyName || '')
        .trim()
        .toLowerCase()
        .startsWith('microsoft.4297127d64ec6')
    )
  ) {
    return true;
  }
  return false;
}

/** @type {Record<string, number>} */
const QUALITY_RANK = {
  skeleton_fallback: 0,
  local_federated: 1,
  storefront_native: 2,
  scraped: 3,
  authoritative: 4,
};
const METADATA_QUALITY_RANK = QUALITY_RANK;

const REJECTED_VIDEO_URL_RE = /\.(?:mp4|webm|m3u8|ts|mkv|mov|avi|mpd|ogv)(?:$|[?#])/i;
const REJECTED_VIDEO_MIME_RE =
  /^(?:video\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;

/**
 * Adaptive 404 retry schedule (NEVER Infinity so fixed/re-listed store pages always self-heal):
 * - 1st 404: 6 hours
 * - 2nd 404: 24 hours
 * - 3rd 404: 7 days
 * - 4th+ 404: 30 days
 *
 * @param {number} failureCount
 * @returns {number}
 */
function computeAdaptive404DelayMs(failureCount) {
  const count = Math.max(1, Math.floor(Number(failureCount) || 1));
  if (count === 1) return 6 * 60 * 60 * 1000;
  if (count === 2) return 24 * 60 * 60 * 1000;
  if (count === 3) return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

/**
 * Detects WAF / bot-protection challenge responses (Cloudflare, Akamai, PerimeterX, CAPTCHA)
 * or HTTP 429 / 403 blocks so transient blocks never poison 404 or metadata state.
 *
 * @param {number | undefined | null} status
 * @param {string | Buffer | null | undefined} bodySample
 * @param {Record<string, any> | Headers | null | undefined} headers
 * @returns {boolean}
 */
function isWafOrChallengeResponse(status, bodySample, headers) {
  /** @param {string} name */
  const getHeader = (name) => {
    if (!headers) return '';
    if (typeof headers.get === 'function') {
      return String(headers.get(name) || '');
    }
    const h = /** @type {Record<string, any>} */ (headers);
    return String(h[name] || h[name.toLowerCase()] || '');
  };

  if (getHeader('cf-mitigated')) return true;
  if (status === 429) return true;

  let sampleStr = '';
  if (typeof bodySample === 'string') {
    sampleStr = bodySample.slice(0, 4096);
  } else if (Buffer.isBuffer(bodySample)) {
    sampleStr = bodySample.subarray(0, 4096).toString('utf8');
  }

  if (
    sampleStr &&
    /cf-chl-bypass|cf-browser-verification|Just a moment\.\.\.|Attention Required! \| Cloudflare|Access Denied[\s\S]{0,200}Reference #|Reference #\d+\.\w+|PerimeterX|px-captcha|g-recaptcha|hcaptcha/i.test(
      sampleStr
    )
  ) {
    return true;
  }

  return status === 403;
}

/**
 * @param {Record<string, any> | Headers | null | undefined} headers
 * @returns {number}
 */
function parseRetryAfterMs(headers) {
  if (!headers) return 0;
  let raw = '';
  if (typeof headers.get === 'function') {
    raw = String(headers.get('retry-after') || '');
  } else {
    const h = /** @type {Record<string, any>} */ (headers);
    raw = String(h['retry-after'] || h['Retry-After'] || '');
  }
  raw = raw.trim();
  if (!raw) return 0;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs > 0) {
    return Math.min(24 * 60 * 60 * 1000, Math.round(secs * 1000));
  }
  const parsedDate = Date.parse(raw);
  if (!Number.isNaN(parsedDate)) {
    const diff = parsedDate - Date.now();
    if (diff > 0) {
      return Math.min(24 * 60 * 60 * 1000, diff);
    }
  }
  return 0;
}

/**
 * @param {unknown} url
 * @returns {boolean}
 */
function isRejectedVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return REJECTED_VIDEO_URL_RE.test(url.trim());
}

/**
 * @param {unknown} url
 * @returns {string}
 */
function normalizeComparableMediaUrl(url) {
  const clean = String(url || '').trim();
  if (!clean) return '';
  return clean.replace(
    /^https?:\/\/(?:shared\.(?:akamai|fastly)\.steamstatic\.com|cdn\.(?:cloudflare|akamai)\.steamstatic\.com|steamcdn-a\.akamaihd\.net)\//i,
    'https://steamstatic.canonical/'
  );
}

const ASSET_IDENTITY_QUERY_KEYS = new Set([
  'url',
  'w',
  'h',
  'width',
  'height',
  'mode',
  'format',
  'fmt',
]);

/**
 * Normalizes an asset source URL for identity comparison across sync cycles.
 *
 * @param {unknown} url
 * @returns {string}
 */
function normalizeAssetIdentityUrl(url) {
  const comparable = normalizeComparableMediaUrl(url);
  if (!comparable) return '';
  try {
    const parsed = new URL(comparable);
    const host = parsed.hostname.toLowerCase();
    let pathname =
      parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : parsed.pathname;
    if (host === 'steamstatic.canonical' && /^\/steam\/apps\//i.test(pathname)) {
      pathname = pathname.replace(/^\/steam\/apps\//i, '/store_item_assets/steam/apps/');
    }
    /** @type {string[]} */
    const keptParams = [];
    for (const [k, v] of parsed.searchParams.entries()) {
      const keyLower = k.toLowerCase();
      if (ASSET_IDENTITY_QUERY_KEYS.has(keyLower)) {
        keptParams.push(`${keyLower}=${v}`);
      }
    }
    keptParams.sort();
    return `https://${host}${pathname}${keptParams.length > 0 ? `?${keptParams.join('&')}` : ''}`;
  } catch {
    return comparable;
  }
}

/**
 * Pure byte-level GIF87a/GIF89a multi-frame detector so animated GIFs are NEVER flattened
 * by `nativeImage.toJPEG`.
 *
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isAnimatedGifBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 14) return false;
  if (
    buf[0] !== 0x47 ||
    buf[1] !== 0x49 ||
    buf[2] !== 0x46 ||
    buf[3] !== 0x38 ||
    (buf[4] !== 0x37 && buf[4] !== 0x39) ||
    buf[5] !== 0x61
  ) {
    return false;
  }

  const len = buf.length;
  const packed = buf[10];
  let offset = 13;
  if (packed & 0x80) {
    offset += 3 * (1 << ((packed & 0x07) + 1));
  }

  /** @param {number} startPos */
  const skipSubBlocks = (startPos) => {
    let pos = startPos;
    while (pos < len) {
      const blockSize = buf[pos++];
      if (blockSize === 0) return pos;
      pos += blockSize;
    }
    return len;
  };

  let imageFrames = 0;
  let gceBlocks = 0;
  let parseClean = true;

  while (offset < len) {
    const introducer = buf[offset++];
    if (introducer === 0x3b) {
      break;
    }
    if (introducer === 0x21) {
      if (offset >= len) break;
      const extLabel = buf[offset++];
      if (extLabel === 0xf9) {
        gceBlocks++;
      }
      offset = skipSubBlocks(offset);
      continue;
    }
    if (introducer === 0x2c) {
      imageFrames++;
      if (imageFrames >= 2) return true;
      if (offset + 9 > len) break;
      const localPacked = buf[offset + 8];
      offset += 9;
      if (localPacked & 0x80) {
        offset += 3 * (1 << ((localPacked & 0x07) + 1));
      }
      if (offset >= len) break;
      offset += 1;
      offset = skipSubBlocks(offset);
      continue;
    }
    parseClean = false;
    break;
  }

  if (imageFrames >= 2) return true;
  if (!parseClean && gceBlocks >= 2) return true;

  let structuralGceCount = 0;
  for (let i = 13; i + 7 < len; i++) {
    if (buf[i] === 0x21 && buf[i + 1] === 0xf9 && buf[i + 2] === 0x04 && buf[i + 7] === 0x00) {
      structuralGceCount++;
      if (structuralGceCount >= 2) return true;
      i += 7;
    }
  }

  return false;
}

/**
 * @param {any} game
 * @returns {boolean}
 */
function hasXboxPlatform(game) {
  if (!game || typeof game !== 'object') return false;
  const gid = String(game.id || game.gameId || '').trim().toLowerCase();
  if (gid.startsWith('xbox-') || gid.startsWith('xbox_')) return true;
  if (String(game.platform || '').trim().toLowerCase() === 'xbox') return true;
  if (game.xboxProductId) return true;
  if (Array.isArray(game.platforms)) {
    return game.platforms.some((/** @type {any} */ p) =>
      typeof p === 'string'
        ? p.trim().toLowerCase() === 'xbox'
        : Boolean(p && typeof p === 'object' && String(p.platformId || '').toLowerCase() === 'xbox')
    );
  }
  return false;
}

/**
 * @param {any} gameObj
 * @param {any[] | null} [platformsArr]
 * @returns {string[]}
 */
function extractXboxBigIdsFromGame(gameObj, platformsArr) {
  /** @type {Set<string>} */
  const found = new Set();
  /** @param {unknown} raw */
  const addCandidate = (raw) => {
    const clean = String(raw || '')
      .replace(/^xbox[-_:]/i, '')
      .trim()
      .toUpperCase();
    if (/^[A-Z0-9]{12}$/.test(clean)) {
      found.add(clean);
    }
  };

  if (gameObj && typeof gameObj === 'object') {
    addCandidate(gameObj.xboxProductId);
  }
  const plats = Array.isArray(platformsArr)
    ? platformsArr
    : Array.isArray(gameObj?.platforms)
      ? gameObj.platforms
      : [];
  for (const p of plats) {
    if (!p || typeof p !== 'object') continue;
    if (p.xboxProductId) addCandidate(p.xboxProductId);
    if (String(p.platformId || '').toLowerCase() === 'xbox') {
      addCandidate(p.platformGameId);
      addCandidate(p.storefrontAppId);
    }
  }
  return Array.from(found);
}

/**
 * @param {any} req
 * @returns {boolean}
 */
function hasVaultReqContent(req) {
  return Boolean(
    req &&
      typeof req === 'object' &&
      ((typeof req.minimum === 'string' && req.minimum.trim().length > 0) ||
        (typeof req.recommended === 'string' && req.recommended.trim().length > 0))
  );
}

/**
 * @param {any} incomingReq
 * @param {any} existingReq
 */
function mergeVaultSystemRequirements(incomingReq, existingReq) {
  if (!hasVaultReqContent(existingReq)) return incomingReq;
  if (!hasVaultReqContent(incomingReq)) return existingReq;
  const nextMin =
    typeof incomingReq.minimum === 'string' && incomingReq.minimum.trim().length > 0
      ? incomingReq.minimum
      : existingReq.minimum;
  const nextRec =
    typeof incomingReq.recommended === 'string' && incomingReq.recommended.trim().length > 0
      ? incomingReq.recommended
      : existingReq.recommended;
  if (nextMin === incomingReq.minimum && nextRec === incomingReq.recommended) {
    return incomingReq;
  }
  return {
    ...(nextMin !== undefined ? { minimum: nextMin } : {}),
    ...(nextRec !== undefined ? { recommended: nextRec } : {}),
  };
}

/**
 * @param {any} incomingObj
 * @param {any} existingObj
 */
function carryForwardVaultRequirements(incomingObj, existingObj) {
  if (
    !incomingObj ||
    typeof incomingObj !== 'object' ||
    !existingObj ||
    typeof existingObj !== 'object' ||
    incomingObj.__quotaSlimmed === true ||
    incomingObj.__digestOnly === true ||
    existingObj.__quotaSlimmed === true ||
    existingObj.__digestOnly === true
  ) {
    return;
  }

  const mergedWin = mergeVaultSystemRequirements(
    incomingObj.systemRequirements,
    existingObj.systemRequirements
  );
  if (mergedWin && mergedWin !== incomingObj.systemRequirements) {
    incomingObj.systemRequirements = mergedWin;
  }
  if (!incomingObj.pcRequirementsHtml && existingObj.pcRequirementsHtml) {
    incomingObj.pcRequirementsHtml = existingObj.pcRequirementsHtml;
  }

  const samePositiveAppId =
    Number(incomingObj.appId) > 0 &&
    Number(existingObj.appId) > 0 &&
    Number(incomingObj.appId) === Number(existingObj.appId);
  const sameSource =
    Boolean(incomingObj.enrichedSource) &&
    incomingObj.enrichedSource === existingObj.enrichedSource;
  const canCarryMac =
    samePositiveAppId ||
    sameSource ||
    (incomingObj.enrichedSource !== 'xbox' &&
      (incomingObj.platforms?.mac === true ||
        (!incomingObj.platforms && existingObj.platforms?.mac === true)));
  const canCarryLinux =
    samePositiveAppId ||
    sameSource ||
    (incomingObj.enrichedSource !== 'xbox' &&
      (incomingObj.platforms?.linux === true ||
        (!incomingObj.platforms && existingObj.platforms?.linux === true)));

  if (canCarryMac) {
    const mergedMac = mergeVaultSystemRequirements(
      incomingObj.macRequirements,
      existingObj.macRequirements
    );
    if (mergedMac && mergedMac !== incomingObj.macRequirements) {
      incomingObj.macRequirements = mergedMac;
    }
  }
  if (canCarryLinux) {
    const mergedLinux = mergeVaultSystemRequirements(
      incomingObj.linuxRequirements,
      existingObj.linuxRequirements
    );
    if (mergedLinux && mergedLinux !== incomingObj.linuxRequirements) {
      incomingObj.linuxRequirements = mergedLinux;
    }
  }
}

/**
 * @param {unknown} url
 * @returns {URL | null}
 */
function parseHttpCriticUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} url
 * @returns {boolean}
 */
function isXboxCriticHostUrl(url) {
  const parsed = parseHttpCriticUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'xbox.com' || host.endsWith('.xbox.com');
}

/**
 * @param {unknown} url
 * @returns {boolean}
 */
function isOpenCriticHostUrl(url) {
  const parsed = parseHttpCriticUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'opencritic.com' || host.endsWith('.opencritic.com');
}

/**
 * @param {unknown} url
 * @returns {boolean}
 */
function isMetacriticHostUrl(url) {
  const parsed = parseHttpCriticUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'metacritic.com' || host.endsWith('.metacritic.com');
}

/**
 * Returns `true` when `url` is a Metacritic host URL whose pathname targets `/user-reviews`.
 *
 * @param {unknown} url
 * @returns {boolean}
 */
function isMetacriticUserReviewsUrl(url) {
  const parsed = parseHttpCriticUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  if (host !== 'metacritic.com' && !host.endsWith('.metacritic.com')) {
    return false;
  }
  return /\/user-reviews(?:\/|$)/i.test(parsed.pathname || '');
}

/**
 * Computes the monotonic review-source authority rank for a persisted `critic_json` object:
 * - 5: User override (`options.isUserOverride === true` / `isUserOverride === true` / `userOverride === true` / `tier === 'override'`)
 * - 4: Metacritic press consensus (`source === 'metacritic'`, or untagged Metacritic press URL without `/user-reviews/` or user-score-only marker)
 * - 3: OpenCritic press consensus (`source === 'opencritic'`, or unknown source with OpenCritic host URL)
 * - 2: High-sample community consensus (`metacritic_user` with `numReviews >= 25`, or `steam` with `numReviews >= 10`)
 * - 1: Storefront/low-sample fallback (`gog`/`epic`/`xbox`/`custom`, unknown/untagged legacy objects, or low-sample `metacritic_user`/`steam`)
 * - 0: Empty, null, or invalid (`!Number.isFinite(score) || score <= 0 || score > 100`)
 *
 * Strictly mirrors `getReviewSourceAuthorityRank` / `parseVaultCriticScore` in `src/services/critic/criticUtils.ts`.
 *
 * @param {unknown} criticObj
 * @param {{ isUserOverride?: boolean }} [options]
 * @returns {number}
 */
function getCriticAuthorityRank(criticObj, options) {
  if (!criticObj || typeof criticObj !== 'object' || Array.isArray(criticObj)) {
    return 0;
  }
  const obj = /** @type {Record<string, any>} */ (criticObj);
  const score = typeof obj.score === 'number' ? obj.score : NaN;
  if (!Number.isFinite(score) || score <= 0 || score > 100) {
    return 0;
  }
  if (
    Boolean(options && options.isUserOverride) ||
    obj.isUserOverride === true ||
    obj.userOverride === true ||
    obj.tier === 'override'
  ) {
    return 5;
  }
  const source = typeof obj.source === 'string' ? obj.source.trim().toLowerCase() : '';
  const rawReviews =
    typeof obj.numReviews === 'number' && Number.isFinite(obj.numReviews)
      ? obj.numReviews
      : typeof obj.reviewCount === 'number' && Number.isFinite(obj.reviewCount)
        ? obj.reviewCount
        : 0;
  const numReviews = rawReviews > 0 ? rawReviews : 0;

  if (source === 'metacritic') {
    return 4;
  }
  if (source === 'opencritic') {
    return 3;
  }
  if (source === 'metacritic_user') {
    return numReviews >= 25 ? 2 : 1;
  }
  if (source === 'steam') {
    return numReviews >= 10 ? 2 : 1;
  }
  if (source === 'gog' || source === 'epic' || source === 'xbox' || source === 'custom') {
    return 1;
  }

  const idLower = String(obj.id || '').trim().toLowerCase();
  if (idLower.startsWith('xbox-') || isXboxCriticHostUrl(obj.url)) {
    return 1;
  }
  if (isOpenCriticHostUrl(obj.url)) {
    return 3;
  }

  // Untagged Metacritic classification: `/user-reviews/`, `mc-user-` ID, or numeric `userScoreRaw`
  // without press Metascore MUST classify as `metacritic_user` (rank 2 if >=25 else 1), NEVER press `4`!
  const hasUserScoreRaw = typeof obj.userScoreRaw === 'number' && Number.isFinite(obj.userScoreRaw);
  const parsedUrl = parseHttpCriticUrl(obj.url);
  const isMcHost = isMetacriticHostUrl(obj.url);
  const isMcCriticReviewsPath = Boolean(
    isMcHost && parsedUrl && /\/critic-reviews(?:\/|$)/i.test(parsedUrl.pathname || '')
  );

  if (
    idLower.startsWith('mc-user-') ||
    isMetacriticUserReviewsUrl(obj.url) ||
    (hasUserScoreRaw && !isMcCriticReviewsPath)
  ) {
    return numReviews >= 25 ? 2 : 1;
  }

  if (isMcHost) {
    return 4;
  }

  return 1;
}

/**
 * Validates that an `enriched_json` object carries a trustworthy Metacritic score anchor
 * (`score > 0`) and is NOT a legacy `local_federated` GOG star-rating masquerading as Metacritic.
 *
 * @param {unknown} enrichedObj
 * @returns {boolean}
 */
function isTrustedEnrichedMetacritic(enrichedObj) {
  if (!enrichedObj || typeof enrichedObj !== 'object' || Array.isArray(enrichedObj)) {
    return false;
  }
  const obj = /** @type {Record<string, any>} */ (enrichedObj);
  if (!obj.metacritic || typeof obj.metacritic !== 'object') {
    return false;
  }
  const score = Number(obj.metacritic.score);
  if (!Number.isFinite(score) || score <= 0) {
    return false;
  }
  const mcUrl = typeof obj.metacritic.url === 'string' ? obj.metacritic.url.trim() : '';
  const hasRealMetacriticUrl = /metacritic\.com/i.test(mcUrl);
  if (hasRealMetacriticUrl) {
    return true;
  }
  const isGogLocalFederated =
    obj.metadataQuality === 'local_federated' &&
    (Boolean(obj.gogId) || obj.enrichedSource === 'gog' || !(Number(obj.appId) > 0));
  if (isGogLocalFederated) {
    return false;
  }
  if (obj.enrichedSource === 'gog' && !hasRealMetacriticUrl) {
    return false;
  }
  return true;
}

/**
 * Checks whether an `enriched_json.reviewSummary` carries actual review counts or positive percentage.
 *
 * @param {unknown} summary
 * @returns {boolean}
 */
function hasMeaningfulVaultReviewSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return false;
  }
  const s = /** @type {Record<string, any>} */ (summary);
  const totalReviews = Number(s.totalReviews ?? 0);
  const reviewScore = Number(s.reviewScore ?? 0);
  const positivePercent = Number(s.positivePercent ?? 0);
  return (
    (Number.isFinite(totalReviews) && totalReviews > 0) ||
    (Number.isFinite(reviewScore) &&
      reviewScore > 0 &&
      Number.isFinite(positivePercent) &&
      positivePercent > 0)
  );
}

/**
 * Carries forward existing trusted `enriched_json.metacritic` (excluding legacy GOG local_federated
 * star ratings) and meaningful `enriched_json.reviewSummary` across same-rank or lower-rank upserts.
 *
 * @param {Record<string, any>} incomingObj
 * @param {Record<string, any>} existingObj
 */
function carryForwardVaultCriticAndReviewFields(incomingObj, existingObj) {
  if (
    !incomingObj ||
    typeof incomingObj !== 'object' ||
    !existingObj ||
    typeof existingObj !== 'object' ||
    incomingObj.__quotaSlimmed === true ||
    incomingObj.__digestOnly === true ||
    existingObj.__quotaSlimmed === true ||
    existingObj.__digestOnly === true
  ) {
    return;
  }

  const hasDifferentPositiveAppId =
    Number(incomingObj.appId) > 0 &&
    Number(existingObj.appId) > 0 &&
    Number(incomingObj.appId) !== Number(existingObj.appId);
  if (hasDifferentPositiveAppId) {
    return;
  }

  if (!isTrustedEnrichedMetacritic(incomingObj) && isTrustedEnrichedMetacritic(existingObj)) {
    incomingObj.metacritic = existingObj.metacritic;
  }

  if (
    !hasMeaningfulVaultReviewSummary(incomingObj.reviewSummary) &&
    hasMeaningfulVaultReviewSummary(existingObj.reviewSummary)
  ) {
    incomingObj.reviewSummary = existingObj.reviewSummary;
  }
}

/**
 * @param {unknown} list
 * @param {string} placeholder
 * @returns {boolean}
 */
function hasVaultNonPlaceholderStrings(list, placeholder) {
  return Boolean(
    Array.isArray(list) &&
      list.some((item) => typeof item === 'string' && item.trim().length > 0 && item !== placeholder)
  );
}

/**
 * Infers truthful `MetadataQuality` for `OfflineVaultService`, preventing Xbox DisplayCatalog
 * baseline synopses and `__quotaSlimmed` projections from poisoning `vault_games` as `'authoritative'`.
 *
 * @param {any} game
 * @param {any} enriched
 * @returns {string}
 */
function inferVaultMetadataQuality(game, enriched) {
  if (!enriched || typeof enriched !== 'object') {
    const explicitGameQuality = String(game?.metadataQuality || '').trim();
    if (
      explicitGameQuality &&
      Object.prototype.hasOwnProperty.call(QUALITY_RANK, explicitGameQuality)
    ) {
      return explicitGameQuality;
    }
    return 'skeleton_fallback';
  }

  // Universal C8 Lattice Invariant: __quotaSlimmed and __digestOnly projections are ALWAYS Rank 0 (`skeleton_fallback`)
  if (enriched.__quotaSlimmed === true || enriched.__digestOnly === true) {
    return 'skeleton_fallback';
  }

  const explicitQuality = String(
    enriched.metadataQuality || game?.metadataQuality || ''
  ).trim();
  const enrichedSource = String(enriched.enrichedSource || '').trim().toLowerCase();
  const gameId = String(game?.id || game?.gameId || '').trim();
  const numericAppId = Number(enriched.appId);
  const hasPositiveAppId = Number.isFinite(numericAppId) && numericAppId > 0;

  if (explicitQuality === 'storefront_native' || enrichedSource === 'xbox') {
    return 'storefront_native';
  }

  if (
    explicitQuality === 'skeleton_fallback' ||
    explicitQuality === 'local_federated' ||
    explicitQuality === 'scraped'
  ) {
    return explicitQuality;
  }

  if (explicitQuality === 'authoritative') {
    if (
      (!gameId.startsWith('steam-') || hasPositiveAppId) &&
      (!hasXboxPlatform(game) || hasPositiveAppId)
    ) {
      return 'authoritative';
    }
    return 'storefront_native';
  }

  if (
    hasPositiveAppId &&
    ((Array.isArray(enriched.screenshots) && enriched.screenshots.length > 0) ||
      (typeof enriched.detailedDescription === 'string' &&
        enriched.detailedDescription.length > 120))
  ) {
    return 'authoritative';
  }

  if (!hasPositiveAppId && (hasXboxPlatform(game) || gameId.startsWith('steam-'))) {
    return 'storefront_native';
  }

  if (enriched.shortDescription || enriched.detailedDescription) {
    return 'scraped';
  }

  return 'skeleton_fallback';
}

/**
 * @param {unknown} gameId
 * @param {unknown} role
 * @param {unknown} ordinal
 * @param {unknown} sourceUrl
 * @returns {string}
 */
function buildAssetUrlKey(gameId, role, ordinal, sourceUrl) {
  const cleanGameId = String(gameId || '').trim();
  const cleanRole = String(role || 'cover').trim();
  const cleanOrd = Math.max(0, Math.floor(Number(ordinal) || 0));
  const cleanUrl = String(sourceUrl || '').trim();
  const isUrlKeyedRole =
    cleanUrl &&
    (cleanRole === 'inline_img' ||
      cleanRole === 'inline_poster' ||
      cleanRole === 'achievement_icon' ||
      (cleanRole === 'icon' && cleanOrd > 0));
  if (isUrlKeyedRole) {
    const urlHash = crypto.createHash('sha256').update(cleanUrl).digest('hex').slice(0, 32);
    return `${cleanGameId || 'url'}::${cleanRole}::${urlHash}`;
  }
  if (cleanGameId) {
    return `${cleanGameId}::${cleanRole}::${cleanOrd}`;
  }
  const urlHash = crypto.createHash('sha256').update(cleanUrl).digest('hex').slice(0, 32);
  return `url::${cleanRole}::${urlHash}`;
}

/**
 * Normalizes an explicit user media override flag (`ov`) from `ol-media://` or IPC params.
 * @param {unknown} rawOv
 * @returns {boolean}
 */
function isExplicitOverrideParam(rawOv) {
  if (rawOv === true || rawOv === 1) return true;
  if (typeof rawOv === 'number') return rawOv > 0;
  if (typeof rawOv === 'string') {
    const norm = rawOv.trim().toLowerCase();
    return Boolean(
      norm && norm !== '0' && norm !== 'false' && norm !== 'null' && norm !== 'undefined'
    );
  }
  return false;
}

/**
 * @param {string} hostname
 * @param {string[]} allowedDomains
 * @returns {boolean}
 */
function matchesCdnHost(hostname, allowedDomains) {
  const clean = String(hostname || '').trim().toLowerCase();
  if (!clean) return false;
  for (const dom of allowedDomains) {
    if (clean === dom || clean.endsWith(`.${dom}`)) {
      return true;
    }
  }
  return false;
}

const WINDOWS_ONLY_CHAINED_HANDOFFS = new Set(['ea', 'ubisoft', 'rockstar', 'riot']);
const EPIC_EA_DRM_NOTICE_RE =
  /\b(?:(?:The\s+)?EA\s+app|Origin(?:\s+client)?)\s+software\s+installation\s+and\s+background\s+use\s+required/i;

/**
 * Normalize raw publisher handoff strings stored in vault platform/game records.
 *
 * @param {unknown} raw
 * @returns {'ubisoft' | 'ea' | 'bnet' | 'rockstar' | 'riot' | null}
 */
function normalizeVaultChainedHandoffId(raw) {
  if (typeof raw !== 'string') return null;
  return normalizePublisherLauncherId(raw);
}

const CANONICAL_XBOX_CHAINED_PUBLISHER_META = Object.freeze({
  ea: Object.freeze({
    externalLauncher: 'EA App',
    externalLauncherUrl: 'https://www.ea.com/ea-app',
  }),
  ubisoft: Object.freeze({
    externalLauncher: 'Ubisoft Connect',
    externalLauncherUrl: 'https://www.ubisoft.com/ubisoft-connect',
  }),
  bnet: Object.freeze({
    externalLauncher: 'Battle.net',
    externalLauncherUrl: 'https://download.battle.net/',
  }),
  rockstar: Object.freeze({
    externalLauncher: 'Rockstar Games Launcher',
    externalLauncherUrl: 'https://socialclub.rockstargames.com/rockstar-games-launcher',
  }),
  riot: Object.freeze({
    externalLauncher: 'Riot Client',
    externalLauncherUrl: 'https://www.riotgames.com/',
  }),
});

/**
 * Builds the full 13-field platform-sanitization context shared across `runStartupSelfHeal`,
 * `upsertGames`, and `getCatalogSnapshot` so zero game-level delivery/anti-cheat/size fields drift.
 *
 * @param {Record<string, any> | null | undefined} gameOrSummary
 * @param {Record<string, any> | null | undefined} primaryEnriched
 * @param {Record<string, any> | null | undefined} [secondaryEnriched]
 */
function buildVaultPlatformSanitizeContext(gameOrSummary, primaryEnriched, secondaryEnriched = null) {
  const g = gameOrSummary && typeof gameOrSummary === 'object' ? gameOrSummary : {};
  const e1 = primaryEnriched && typeof primaryEnriched === 'object' ? primaryEnriched : null;
  const e2 = secondaryEnriched && typeof secondaryEnriched === 'object' ? secondaryEnriched : null;

  return {
    drmNotice: e1?.drmNotice || e2?.drmNotice || g.drmNotice || null,
    gameChainedLauncherHandoff:
      g.chainedLauncherHandoff || g.chainedRequiresLauncherHandoff || null,
    gameExternalStorefrontHandoff: g.externalStorefrontHandoff || null,
    gameExternalLauncher: g.externalLauncher || e1?.externalLauncher || e2?.externalLauncher || null,
    gameExternalLauncherUrl:
      g.externalLauncherUrl || e1?.externalLauncherUrl || e2?.externalLauncherUrl || null,
    gameIsExternalLauncherStubPackage:
      typeof g.isExternalLauncherStubPackage === 'boolean'
        ? g.isExternalLauncherStubPackage
        : typeof e1?.isExternalLauncherStubPackage === 'boolean'
          ? e1.isExternalLauncherStubPackage
          : typeof e2?.isExternalLauncherStubPackage === 'boolean'
            ? e2.isExternalLauncherStubPackage
            : undefined,
    gameXboxBottleCompatibilityReason:
      g.xboxBottleCompatibilityReason ||
      e1?.xboxBottleCompatibilityReason ||
      e2?.xboxBottleCompatibilityReason ||
      null,
    gameMaxDownloadSizeBytes:
      g.maxDownloadSizeBytes ?? e1?.maxDownloadSizeBytes ?? e2?.maxDownloadSizeBytes ?? null,
    gamePcMaxInstallSizeBytes:
      g.pcMaxInstallSizeBytes ?? e1?.pcMaxInstallSizeBytes ?? e2?.pcMaxInstallSizeBytes ?? null,
    gameRequiresKernelAntiCheat:
      typeof g.requiresKernelAntiCheat === 'boolean'
        ? g.requiresKernelAntiCheat
        : typeof e1?.requiresKernelAntiCheat === 'boolean'
          ? e1.requiresKernelAntiCheat
          : typeof e2?.requiresKernelAntiCheat === 'boolean'
            ? e2.requiresKernelAntiCheat
            : undefined,
    gameKernelAntiCheatName:
      g.kernelAntiCheatName ||
      g.antiCheatName ||
      e1?.kernelAntiCheatName ||
      e1?.antiCheatName ||
      e2?.kernelAntiCheatName ||
      e2?.antiCheatName ||
      null,
  };
}

/**
 * Pure self-healing sanitizer for a single storefront platform entry in `vault_games`.
 *
 * @param {any} p
 * @param {{
 *   hasEnrichedJson?: boolean,
 *   drmNotice?: string | null,
 *   isSinglePlatform?: boolean,
 *   gameChainedLauncherHandoff?: string | null,
 *   gameExternalStorefrontHandoff?: string | null,
 *   gameExternalLauncher?: string | null,
 *   gameExternalLauncherUrl?: string | null,
 *   gameIsExternalLauncherStubPackage?: boolean,
 *   gameXboxBottleCompatibilityReason?: string | null,
 *   gameMaxDownloadSizeBytes?: number | null,
 *   gamePcMaxInstallSizeBytes?: number | null,
 *   gameRequiresKernelAntiCheat?: boolean,
 *   gameKernelAntiCheatName?: string | null
 * } | null} [context=null]
 * @returns {{ entry: any, repaired: boolean }}
 */
function sanitizeVaultPlatformEntry(p, context = null) {
  if (!p || typeof p !== 'object') {
    return { entry: p, repaired: false };
  }
  const pid = String(p.platformId || p.id || '').trim().toLowerCase();
  const hasEnrichedJson = Boolean(context?.hasEnrichedJson);
  let current = p;
  let repaired = false;
  const ensureCloned = () => {
    if (current === p) {
      current = { ...p };
    }
  };

  const isPhysicallyInstalled = Boolean(
    current.installed ||
      (typeof current.installPath === 'string' && current.installPath.trim()) ||
      (typeof current.executablePath === 'string' && current.executablePath.trim())
  );
  if (!isPhysicallyInstalled && pid === 'xbox') {
    if (current.ownershipType === 'subscription' && current.subscriptionExpired === true) {
      return { entry: null, repaired: true };
    }
    if (current.version !== undefined) {
      ensureCloned();
      delete current.version;
      repaired = true;
    }
  }

  let canonicalHandoff =
    normalizeVaultChainedHandoffId(p.chainedLauncherHandoff) ||
    normalizeVaultChainedHandoffId(p.chainedRequiresLauncherHandoff) ||
    normalizeVaultChainedHandoffId(p.externalStorefrontHandoff) ||
    (pid === 'xbox' ? normalizeVaultChainedHandoffId(p.externalLauncher) : null) ||
    ((pid === 'xbox' || pid === 'epic') && context?.isSinglePlatform
      ? normalizeVaultChainedHandoffId(
          context?.gameChainedLauncherHandoff ||
            context?.gameExternalStorefrontHandoff ||
            (pid === 'xbox' ? context?.gameExternalLauncher : null)
        )
      : null);

  let inferredEpicPartnerLink = false;
  if (pid === 'epic' && !canonicalHandoff) {
    const effectiveDrmNotice = String(p.drmNotice || context?.drmNotice || '').trim();
    if (effectiveDrmNotice && EPIC_EA_DRM_NOTICE_RE.test(effectiveDrmNotice)) {
      canonicalHandoff = 'ea';
      inferredEpicPartnerLink = true;
    }
  }

  // Preserve and backfill all 8 platform-level delivery, compatibility, size, and anti-cheat fields
  if (context?.isSinglePlatform) {
    if (
      typeof current.isExternalLauncherStubPackage !== 'boolean' &&
      typeof context.gameIsExternalLauncherStubPackage === 'boolean'
    ) {
      ensureCloned();
      current.isExternalLauncherStubPackage = context.gameIsExternalLauncherStubPackage;
      repaired = true;
    }
    if (
      (!current.externalLauncher || !String(current.externalLauncher).trim()) &&
      typeof context.gameExternalLauncher === 'string' &&
      context.gameExternalLauncher.trim()
    ) {
      ensureCloned();
      current.externalLauncher = context.gameExternalLauncher.trim();
      repaired = true;
    }
    if (
      (!current.externalLauncherUrl || !String(current.externalLauncherUrl).trim()) &&
      typeof context.gameExternalLauncherUrl === 'string' &&
      /^https:\/\//i.test(context.gameExternalLauncherUrl.trim())
    ) {
      ensureCloned();
      current.externalLauncherUrl = context.gameExternalLauncherUrl.trim();
      repaired = true;
    }
    if (
      (!current.xboxBottleCompatibilityReason ||
        !String(current.xboxBottleCompatibilityReason).trim()) &&
      typeof context.gameXboxBottleCompatibilityReason === 'string' &&
      context.gameXboxBottleCompatibilityReason.trim()
    ) {
      ensureCloned();
      current.xboxBottleCompatibilityReason = context.gameXboxBottleCompatibilityReason.trim();
      repaired = true;
    }
    if (
      !(Number(current.maxDownloadSizeBytes) > 0) &&
      typeof context.gameMaxDownloadSizeBytes === 'number' &&
      Number.isFinite(context.gameMaxDownloadSizeBytes) &&
      context.gameMaxDownloadSizeBytes > 0
    ) {
      ensureCloned();
      current.maxDownloadSizeBytes = Math.round(context.gameMaxDownloadSizeBytes);
      repaired = true;
    }
    if (
      !(Number(current.pcMaxInstallSizeBytes) > 0) &&
      typeof context.gamePcMaxInstallSizeBytes === 'number' &&
      Number.isFinite(context.gamePcMaxInstallSizeBytes) &&
      context.gamePcMaxInstallSizeBytes > 0
    ) {
      ensureCloned();
      current.pcMaxInstallSizeBytes = Math.round(context.gamePcMaxInstallSizeBytes);
      repaired = true;
    }
    if (
      typeof current.requiresKernelAntiCheat !== 'boolean' &&
      typeof context.gameRequiresKernelAntiCheat === 'boolean'
    ) {
      ensureCloned();
      current.requiresKernelAntiCheat = context.gameRequiresKernelAntiCheat;
      repaired = true;
    }
    if (
      (!current.kernelAntiCheatName || !String(current.kernelAntiCheatName).trim()) &&
      typeof context.gameKernelAntiCheatName === 'string' &&
      context.gameKernelAntiCheatName.trim()
    ) {
      ensureCloned();
      current.kernelAntiCheatName = context.gameKernelAntiCheatName.trim();
      repaired = true;
    }
  }

  if (canonicalHandoff) {
    if (
      current.chainedLauncherHandoff !== canonicalHandoff ||
      current.externalStorefrontHandoff !== canonicalHandoff
    ) {
      ensureCloned();
      current.chainedLauncherHandoff = canonicalHandoff;
      current.externalStorefrontHandoff = canonicalHandoff;
      repaired = true;
    }
    if (pid === 'xbox') {
      if (current.chainedHandoffTopology !== 'publisher_managed') {
        ensureCloned();
        current.chainedHandoffTopology = 'publisher_managed';
        repaired = true;
      }
      const canonicalPubMeta =
        /** @type {Record<string, { externalLauncher: string, externalLauncherUrl: string }>} */ (
          CANONICAL_XBOX_CHAINED_PUBLISHER_META
        )[canonicalHandoff];
      if (canonicalPubMeta) {
        if (
          typeof current.externalLauncher !== 'string' ||
          !current.externalLauncher.trim()
        ) {
          ensureCloned();
          current.externalLauncher = canonicalPubMeta.externalLauncher;
          repaired = true;
        }
        if (
          typeof current.externalLauncherUrl !== 'string' ||
          !/^https:\/\//i.test(current.externalLauncherUrl.trim())
        ) {
          ensureCloned();
          current.externalLauncherUrl = canonicalPubMeta.externalLauncherUrl;
          repaired = true;
        }
      }
    }
    if (
      pid === 'epic' &&
      (inferredEpicPartnerLink || canonicalHandoff === 'ea' || canonicalHandoff === 'ubisoft') &&
      current.chainedHandoffTopology !== 'partner_launcher_link'
    ) {
      ensureCloned();
      current.chainedHandoffTopology = 'partner_launcher_link';
      repaired = true;
    }
  }

  if (pid === 'xbox') {
    if (
      current.ownershipType !== 'owned' &&
      typeof current.gamePassTier === 'string' &&
      current.gamePassTier.trim() &&
      !current.subscriptionTierId
    ) {
      const gpLower = current.gamePassTier.trim().toLowerCase();
      let inferredTierId = '';
      if (gpLower.includes('ultimate')) inferredTierId = 'ultimate';
      else if (gpLower.includes('starter')) inferredTierId = 'starter';
      else if (gpLower.includes('pc game pass')) inferredTierId = 'pc';
      else if (gpLower.includes('premium') && gpLower.includes('game pass'))
        inferredTierId = 'premium';
      else if (gpLower.includes('essential')) inferredTierId = 'essential';
      else if (gpLower.includes('ubisoft')) inferredTierId = 'ubisoft_classics';
      else if (gpLower.includes('ea play')) inferredTierId = 'ea_play';
      if (inferredTierId) {
        ensureCloned();
        current.subscriptionTierId = inferredTierId;
        repaired = true;
      }
    }
    if (Array.isArray(current.satisfyingPassIds)) {
      const cleanedPassIds = Array.from(
        new Set(
          current.satisfyingPassIds
            .map((/** @type {any} */ passId) => String(passId || '').trim().toUpperCase())
            .filter((/** @type {string} */ passId) => /^[A-Z0-9]{12}$/.test(passId))
        )
      );
      if (
        cleanedPassIds.length !== current.satisfyingPassIds.length ||
        cleanedPassIds.some(
          (/** @type {string} */ passId, /** @type {number} */ idx) =>
            passId !== current.satisfyingPassIds[idx]
        )
      ) {
        ensureCloned();
        current.satisfyingPassIds = cleanedPassIds;
        repaired = true;
      }
    }
    if (!current.isCrossPlatformLauncherRuntime) {
      if (canonicalHandoff && WINDOWS_ONLY_CHAINED_HANDOFFS.has(canonicalHandoff)) {
        if (
          !current.platforms ||
          typeof current.platforms !== 'object' ||
          current.platforms.windows !== true ||
          current.platforms.mac !== false
        ) {
          ensureCloned();
          current.platforms = {
            linux: Boolean(current.platforms?.linux),
            ...current.platforms,
            windows: true,
            mac: false,
          };
          repaired = true;
        }
      } else if (
        current.platforms &&
        typeof current.platforms === 'object' &&
        (current.platforms.windows === false || current.platforms.mac === true)
      ) {
        ensureCloned();
        current.platforms = { windows: true, mac: false, linux: false };
        repaired = true;
      }
    }
    return { entry: current, repaired };
  }

  if (pid === 'ubisoft' || pid === 'ea' || pid === 'rockstar' || pid === 'riot') {
    if (
      !current.platforms ||
      typeof current.platforms !== 'object' ||
      current.platforms.windows !== true ||
      current.platforms.mac !== false
    ) {
      ensureCloned();
      current.platforms = {
        linux: Boolean(current.platforms?.linux),
        ...current.platforms,
        windows: true,
        mac: false,
      };
      repaired = true;
    }
    return { entry: current, repaired };
  }

  if (pid === 'epic') {
    if (canonicalHandoff && WINDOWS_ONLY_CHAINED_HANDOFFS.has(canonicalHandoff)) {
      if (
        !current.platforms ||
        typeof current.platforms !== 'object' ||
        current.platforms.windows !== true ||
        current.platforms.mac !== false
      ) {
        ensureCloned();
        current.platforms = {
          linux: Boolean(current.platforms?.linux),
          ...current.platforms,
          windows: true,
          mac: false,
        };
        repaired = true;
      }
      return { entry: current, repaired };
    }
    if (
      current.platforms &&
      typeof current.platforms === 'object' &&
      !current.platforms.windows &&
      !current.platforms.mac &&
      !current.platforms.linux
    ) {
      ensureCloned();
      current.platforms = { windows: true, mac: false, linux: false };
      repaired = true;
    }
    return { entry: current, repaired };
  }

  if (pid === 'gog') {
    if (
      current.platforms &&
      typeof current.platforms === 'object' &&
      !current.platforms.windows &&
      !current.platforms.mac &&
      !current.platforms.linux
    ) {
      ensureCloned();
      current.platforms = { windows: true, mac: false, linux: false };
      repaired = true;
    }
    return { entry: current, repaired };
  }

  if (pid === 'steam') {
    if (
      !hasEnrichedJson &&
      current.platforms &&
      typeof current.platforms === 'object' &&
      current.platforms.mac === true &&
      current.platforms.windows === true &&
      !current.installed
    ) {
      ensureCloned();
      delete current.platforms;
      repaired = true;
    }
    return { entry: current, repaired };
  }

  return { entry: current, repaired };
}

/**
 * Pure self-healing sanitizer for per-storefront `platforms` entries stored in `vault_games`.
 * Forwards ALL 13 caller-supplied context fields (fixing the silent 8-field drop!) into
 * `sanitizeVaultPlatformEntry`.
 *
 * @param {any[] | null | undefined} platforms
 * @param {boolean} [hasEnrichedJson=false]
 * @param {Record<string, any> | null} [context=null]
 * @returns {{ platforms: any[] | null | undefined, repaired: boolean }}
 */
function sanitizeVaultPlatformEntriesOsFlags(platforms, hasEnrichedJson = false, context = null) {
  if (!Array.isArray(platforms)) {
    return { platforms, repaired: false };
  }
  let repaired = false;
  const isSinglePlatform = platforms.length === 1;
  const entryContext = {
    ...(context && typeof context === 'object' ? context : {}),
    hasEnrichedJson,
    drmNotice: context?.drmNotice || null,
    isSinglePlatform,
    gameChainedLauncherHandoff: context?.gameChainedLauncherHandoff || null,
    gameExternalStorefrontHandoff: context?.gameExternalStorefrontHandoff || null,
    gameExternalLauncher: context?.gameExternalLauncher ?? null,
    gameExternalLauncherUrl: context?.gameExternalLauncherUrl ?? null,
    gameIsExternalLauncherStubPackage:
      typeof context?.gameIsExternalLauncherStubPackage === 'boolean'
        ? context.gameIsExternalLauncherStubPackage
        : undefined,
    gameXboxBottleCompatibilityReason: context?.gameXboxBottleCompatibilityReason ?? null,
    gameMaxDownloadSizeBytes: context?.gameMaxDownloadSizeBytes ?? null,
    gamePcMaxInstallSizeBytes: context?.gamePcMaxInstallSizeBytes ?? null,
    gameRequiresKernelAntiCheat:
      typeof context?.gameRequiresKernelAntiCheat === 'boolean'
        ? context.gameRequiresKernelAntiCheat
        : undefined,
    gameKernelAntiCheatName: context?.gameKernelAntiCheatName ?? null,
  };
  const next = [];
  for (const p of platforms) {
    const res = sanitizeVaultPlatformEntry(p, entryContext);
    if (res.repaired) {
      repaired = true;
    }
    if (res.entry === null) {
      repaired = true;
      continue;
    }
    next.push(res.entry);
  }
  return {
    platforms: repaired ? next : platforms,
    repaired,
  };
}

/**
 * Validates whether a SQLite `game_media_assets` federated row (`source_url` + `federated_path`)
 * is origin-, ID-, and content-hash-compatible across macOS and Windows paths, and rejects
 * explicit user media overrides (`params?.ov`).
 *
 * @param {unknown} sourceUrl
 * @param {unknown} federatedPath
 * @param {Record<string, any> | null} [params]
 * @returns {boolean}
 */
function isFederatedAssetRowCompatible(sourceUrl, federatedPath, params = null) {
  if (isExplicitOverrideParam(params?.ov)) {
    return false;
  }
  const paramRole = params?.role != null ? String(params.role).trim().toLowerCase() : '';
  const paramOrdinal = Math.max(0, Math.floor(Number(params?.ordinal ?? params?.ord ?? 0) || 0));
  if (paramRole === 'achievement_icon' || (paramRole === 'icon' && paramOrdinal > 0)) {
    return false;
  }
  const cleanFedPath = typeof federatedPath === 'string' ? federatedPath.trim() : '';
  if (!cleanFedPath) {
    return false;
  }

  const normPath = cleanFedPath.replace(/\\/g, '/');
  const normPathLower = normPath.toLowerCase();
  const paramGogId =
    params?.gogId != null
      ? String(params.gogId).trim()
      : params?.gid != null
        ? String(params.gid).trim()
        : '';
  const paramSteamId =
    params?.steamAppId != null
      ? String(params.steamAppId).trim()
      : params?.sid != null
        ? String(params.sid).trim()
        : '';

  const gogDirMatch = normPath.match(/\/gog\/(\d+)\//i);
  if (paramGogId && gogDirMatch && gogDirMatch[1] !== paramGogId) {
    return false;
  }
  const steamDirMatch = normPath.match(/\/librarycache\/(\d+)(?:\/|_)/i);
  if (paramSteamId && steamDirMatch && steamDirMatch[1] !== paramSteamId) {
    return false;
  }

  const cleanUrl = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';
  if (!cleanUrl) {
    return true;
  }

  let parsed;
  try {
    parsed = new URL(cleanUrl);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname || '';

  if (matchesCdnHost(host, ['igdb.com', 'steamgriddb.com'])) {
    return false;
  }

  const isGogCache =
    normPathLower.includes('gog.com/galaxy/webcache') ||
    (normPathLower.includes('/webcache/') && normPathLower.includes('/gog/'));
  if (isGogCache) {
    if (!matchesCdnHost(host, ['gog-statics.com', 'gog.com'])) {
      return false;
    }
    const urlHash64 = pathname.match(/([0-9a-f]{64})/i);
    const fileHash64 = path.posix.basename(normPath).match(/([0-9a-f]{64})/i);
    if (urlHash64 && fileHash64 && urlHash64[1].toLowerCase() !== fileHash64[1].toLowerCase()) {
      return false;
    }
    return true;
  }

  const isSteamCache =
    normPathLower.includes('appcache/librarycache') ||
    (normPathLower.includes('/userdata/') && normPathLower.includes('/config/grid/')) ||
    normPathLower.includes('/steam/games/');
  if (isSteamCache) {
    if (
      !matchesCdnHost(host, [
        'steamstatic.com',
        'akamaihd.net',
        'steamcdn-a.akamaihd.net',
        'steampowered.com',
      ])
    ) {
      return false;
    }
    const appUrlMatch = pathname.match(/\/(?:steam|images)\/apps\/(\d+)\//i);
    if (appUrlMatch) {
      if (steamDirMatch && steamDirMatch[1] !== appUrlMatch[1]) {
        return false;
      }
      if (paramSteamId && paramSteamId !== appUrlMatch[1]) {
        return false;
      }
    }
    const sha40SegMatch = pathname.match(/\/([0-9a-f]{40})\//i);
    if (sha40SegMatch && normPathLower.includes('appcache/librarycache')) {
      if (!normPathLower.includes(sha40SegMatch[1].toLowerCase())) {
        return false;
      }
    }
    return true;
  }

  const isXboxCache =
    normPathLower.includes('/xboxgames/') ||
    normPathLower.includes('microsoft.gamingapp_') ||
    normPathLower.includes('8wekyb3d8bbwe') ||
    normPathLower.includes('/windowsapps/');
  if (isXboxCache) {
    return matchesCdnHost(host, ['s-microsoft.com', 'xboxlive.com', 'microsoft.com']);
  }

  const isEpicCache =
    normPathLower.includes('/images-cache/') ||
    normPathLower.includes('/heroic/') ||
    normPathLower.includes('epicgameslauncher') ||
    normPathLower.includes('/legendary/');
  if (isEpicCache) {
    return matchesCdnHost(host, ['epicgames.com', 'unrealengine.com']);
  }

  return true;
}

module.exports = {
  isStandaloneStorefrontLauncherUtility,
  QUALITY_RANK,
  METADATA_QUALITY_RANK,
  REJECTED_VIDEO_URL_RE,
  REJECTED_VIDEO_MIME_RE,
  computeAdaptive404DelayMs,
  isWafOrChallengeResponse,
  parseRetryAfterMs,
  isRejectedVideoUrl,
  normalizeComparableMediaUrl,
  normalizeAssetIdentityUrl,
  isAnimatedGifBuffer,
  hasXboxPlatform,
  extractXboxBigIdsFromGame,
  hasVaultReqContent,
  mergeVaultSystemRequirements,
  carryForwardVaultRequirements,
  isXboxCriticHostUrl,
  isOpenCriticHostUrl,
  isMetacriticHostUrl,
  isMetacriticUserReviewsUrl,
  getCriticAuthorityRank,
  isTrustedEnrichedMetacritic,
  hasMeaningfulVaultReviewSummary,
  carryForwardVaultCriticAndReviewFields,
  hasVaultNonPlaceholderStrings,
  inferVaultMetadataQuality,
  buildAssetUrlKey,
  isExplicitOverrideParam,
  matchesCdnHost,
  normalizeVaultChainedHandoffId,
  buildVaultPlatformSanitizeContext,
  sanitizeVaultPlatformEntry,
  sanitizeVaultPlatformEntriesOsFlags,
  isFederatedAssetRowCompatible,
};
