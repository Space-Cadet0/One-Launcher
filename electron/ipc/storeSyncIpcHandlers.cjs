// @ts-check
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const {
  isAllowedHttpsHost,
  sanitizeLaunchConfigRecursive,
} = require('../launcher/securityAndPathUtils.cjs');
const {
  diagLog,
  redactSensitiveDiagnosticText,
} = require('../utils/diagnosticLogger.cjs');
const {
  readLocalSteamPlaytimes,
  scanLocalSteamAchievements,
  fetchSteamBatchAchievements,
  fetchSteamStoreBrowseItemsMap,
  parseSteamGamesListJson,
  trimSteamLocalScannerMemory,
} = require('../storefronts/steamLocalScanner.cjs');
const {
  STORE_OAUTH_URLS,
  STEAM_AUTH_PAGE_EXTRACTOR_SCRIPT,
  STEAM_SSR_BG_EXTRACTOR_SCRIPT,
  createEpicAuthRecovery,
} = require('../storefronts/epicAuthRecovery.cjs');

const XBOX_TRUSTED_AUTH_HOSTS = Object.freeze([
  'login.live.com',
  'account.live.com',
  'login.microsoftonline.com',
  'login.microsoft.com',
  'account.microsoft.com',
  'sisu.xboxlive.com',
]);

const STOREFRONT_OAUTH_PARTITIONS = Object.freeze({
  xbox: 'persist:oauth_xbox',
  gog: 'persist:oauth_gog',
  epic: 'persist:oauth_epic',
  steam: 'persist:oauth_steam',
});

const RENDERER_TOKEN_SENTINELS = new Set([
  'saved_in_electron',
  '[REDACTED]',
  '[REDACTED_SECRET]',
  '[REDACTED_BEARER]',
  '[REDACTED_BASIC]',
  '[REDACTED_XBL_TOKEN]',
]);

const SECRET_TOKEN_OBJECT_KEYS = new Set([
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'apiKey',
  'api_key',
  'steamApiKey',
  'webapi_token',
  'webApiToken',
  'client_secret',
  'clientSecret',
  'exchange_code',
  'authorization_code',
  'xblAccessToken',
  'xstsToken',
  'msaAccessToken',
  'msaRefreshToken',
  'storeTicket',
  'userStsLegacyTokenXml',
  'deviceToken',
  'deviceKey',
  'proofKey',
  'privateKey',
  'sDAToken',
]);

/**
 * Determine whether a candidate string is a real credential rather than an empty or redacted sentinel.
 * @param {unknown} val
 * @returns {val is string}
 */
function isRealSecretToken(val) {
  if (typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (!trimmed) return false;
  return !RENDERER_TOKEN_SENTINELS.has(trimmed);
}

/**
 * Scrub PII, emails, compact/XBL tickets, and filesystem paths from an error before logging or returning.
 * @param {unknown} err
 * @returns {string}
 */
function scrubAuthDiagnosticError(err) {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  return redactSensitiveDiagnosticText(raw)
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED]')
    .replace(/\b(?:[td]|XBL3\.0\s+x)=[^\s,;)"']+/gi, '[REDACTED]')
    .replace(/\b(?:puid|xuid|membername|cid|ANID)\s*[:=]\s*[^\s,;)"']+/gi, '[REDACTED]')
    .slice(0, 240);
}

/**
 * Resolve the isolated Electron session partition name for a storefront OAuth popup.
 * @param {unknown} storefrontId
 * @returns {string}
 */
function resolveStorefrontOAuthPartition(storefrontId) {
  const normalized = String(storefrontId || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(STOREFRONT_OAUTH_PARTITIONS, normalized)) {
    return STOREFRONT_OAUTH_PARTITIONS[
      /** @type {keyof typeof STOREFRONT_OAUTH_PARTITIONS} */ (normalized)
    ];
  }
  const safeSlug = normalized.replace(/[^a-z0-9_-]/g, '') || 'generic';
  return `persist:oauth_${safeSlug}`;
}

/**
 * Clear HTTP and V8 bytecode caches on an isolated OAuth popup session when closed.
 * @param {any} targetSession
 */
function clearOAuthPopupSessionCaches(targetSession) {
  if (!targetSession) return;
  try {
    if (typeof targetSession.clearCache === 'function') {
      Promise.resolve(targetSession.clearCache()).catch(() => {});
    }
  } catch {}
  try {
    if (typeof targetSession.clearCodeCaches === 'function') {
      Promise.resolve(targetSession.clearCodeCaches({})).catch(() => {});
    }
  } catch {}
}

/**
 * Validate `https://login.live.com/ppsecure/post.srf` via strict WHATWG URL parsing.
 * @param {unknown} urlStr
 * @returns {boolean}
 */
function isLivePostSrfUrl(urlStr) {
  if (!isAllowedHttpsHost(urlStr, ['login.live.com'])) return false;
  try {
    const parsed = new URL(String(urlStr));
    return /^\/ppsecure\/post\.srf\b/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Validate `https://*.epicgames.com/id/api/redirect*` via strict WHATWG URL parsing.
 * @param {unknown} urlStr
 * @returns {boolean}
 */
function isEpicAuthRedirectUrl(urlStr) {
  if (!isAllowedHttpsHost(urlStr, ['epicgames.com'])) return false;
  try {
    const parsed = new URL(String(urlStr));
    return parsed.pathname.startsWith('/id/api/redirect');
  } catch {
    return false;
  }
}

/**
 * Validate authenticated `https://steamcommunity.com/...` (excluding `/login` paths) via WHATWG URL.
 * @param {unknown} urlStr
 * @returns {boolean}
 */
function isAuthenticatedSteamCommunityUrl(urlStr) {
  if (!isAllowedHttpsHost(urlStr, ['steamcommunity.com'])) return false;
  try {
    const parsed = new URL(String(urlStr));
    const lowerPath = parsed.pathname.toLowerCase();
    return lowerPath !== '/login' && !lowerPath.startsWith('/login/');
  } catch {
    return false;
  }
}

/**
 * Project a storefront credential record across the main->renderer IPC boundary without
 * ever exposing raw OAuth access/refresh tokens, Steam WebAPI tokens/keys, or Xbox XSTS/MSA keys.
 *
 * @param {string} storefrontId
 * @param {any} rawEntry
 * @param {any} [storeSync]
 * @returns {Record<string, any> | null}
 */
function sanitizeStoreTokenEntryForRenderer(storefrontId, rawEntry, storeSync) {
  if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
    return null;
  }
  const normalizedStore = String(storefrontId || '').trim().toLowerCase();

  const hasAccessToken = Boolean(
    (isRealSecretToken(rawEntry.access_token) && rawEntry.access_token !== 'steam_web_session') ||
      isRealSecretToken(rawEntry.accessToken) ||
      isRealSecretToken(rawEntry.xblAccessToken) ||
      isRealSecretToken(rawEntry.msaAccessToken) ||
      isRealSecretToken(rawEntry.storeTicket) ||
      (normalizedStore === 'steam' && rawEntry.access_token === 'steam_web_session')
  );
  const hasRefreshToken = Boolean(
    isRealSecretToken(rawEntry.refresh_token) ||
      isRealSecretToken(rawEntry.refreshToken) ||
      isRealSecretToken(rawEntry.msaRefreshToken) ||
      isRealSecretToken(rawEntry.userStsLegacyTokenXml)
  );
  const hasApiKey = Boolean(
    isRealSecretToken(rawEntry.apiKey) ||
      isRealSecretToken(rawEntry.api_key) ||
      isRealSecretToken(rawEntry.steamApiKey) ||
      isRealSecretToken(rawEntry.webapi_token) ||
      isRealSecretToken(rawEntry.webApiToken)
  );

  if (normalizedStore === 'xbox') {
    const baseXbox =
      typeof storeSync?.projectRedactedXboxSummary === 'function'
        ? storeSync.projectRedactedXboxSummary(rawEntry)
        : null;
    const xboxConnected = Boolean(
      baseXbox?.connected || hasAccessToken || hasRefreshToken || rawEntry.connected
    );
    if (!baseXbox && !xboxConnected) {
      return null;
    }
    /** @type {Record<string, any>} */
    const safeXbox = {};
    if (baseXbox && typeof baseXbox === 'object') {
      for (const [k, v] of Object.entries(baseXbox)) {
        if (!SECRET_TOKEN_OBJECT_KEYS.has(k)) {
          safeXbox[k] = v;
        }
      }
    } else {
      if (typeof rawEntry.accountName === 'string') safeXbox.accountName = rawEntry.accountName;
      if (typeof rawEntry.gamertag === 'string') safeXbox.gamertag = rawEntry.gamertag;
      if (typeof rawEntry.xuid === 'string') safeXbox.xuid = rawEntry.xuid;
      if (typeof rawEntry.avatarUrl === 'string') safeXbox.avatarUrl = rawEntry.avatarUrl;
      if (rawEntry.subscription) safeXbox.subscription = rawEntry.subscription;
      if (rawEntry.syncMode) safeXbox.syncMode = rawEntry.syncMode;
    }
    safeXbox.connected = xboxConnected;
    safeXbox.hasAccessToken = hasAccessToken || xboxConnected;
    safeXbox.hasRefreshToken = hasRefreshToken;
    safeXbox.hasApiKey = hasApiKey;
    if (xboxConnected) {
      safeXbox.access_token = 'saved_in_electron';
    }
    return safeXbox;
  }

  const isConnected = Boolean(
    hasAccessToken ||
      hasRefreshToken ||
      hasApiKey ||
      (normalizedStore === 'steam' && typeof rawEntry.steamId === 'string' && rawEntry.steamId.trim())
  );
  if (!isConnected) {
    return null;
  }

  /** @type {Record<string, any>} */
  const projected = {};
  for (const [key, value] of Object.entries(rawEntry)) {
    if (
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype' ||
      SECRET_TOKEN_OBJECT_KEYS.has(key)
    ) {
      continue;
    }
    projected[key] = value;
  }

  projected.connected = true;
  projected.hasAccessToken = hasAccessToken;
  projected.hasRefreshToken = hasRefreshToken;
  projected.hasApiKey = hasApiKey;
  projected.access_token = 'saved_in_electron';
  return projected;
}

/** @type {string | null} */
let hltbCachedToken = null;
let hltbTokenExpiry = 0;

/**
 * @param {string} [userAgent]
 * @returns {Promise<string | null>}
 */
async function getHltbToken(userAgent) {
  if (hltbCachedToken && Date.now() < hltbTokenExpiry) {
    return hltbCachedToken;
  }
  const effectiveUa = userAgent || resolveCleanBrowserUserAgent(null);
  try {
    const initRes = await fetch(`https://howlongtobeat.com/api/search/site/init?t=${Date.now()}`, {
      headers: {
        'User-Agent': effectiveUa,
        Referer: 'https://howlongtobeat.com/',
      },
    });
    if (!initRes.ok) return null;
    /** @type {{ token?: string } | null} */
    const initData = /** @type {any} */ (await initRes.json());
    if (initData?.token) {
      hltbCachedToken = String(initData.token);
      hltbTokenExpiry = Date.now() + 10 * 60 * 1000;
      return hltbCachedToken;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[HLTB] Token init failed:', msg);
  }
  return null;
}

/** @type {Record<string, string>} */
const HLTB_HTML_ENTITY_MAP = Object.freeze({
  trade: '™',
  '#8482': '™',
  '#x2122': '™',
  reg: '®',
  '#174': '®',
  '#xae': '®',
  copy: '©',
  '#169': '©',
  '#xa9': '©',
  rsquo: '\u2019',
  '#8217': '\u2019',
  '#x2019': '\u2019',
  lsquo: '\u2018',
  '#8216': '\u2018',
  '#x2018': '\u2018',
  apos: "'",
  '#39': "'",
  '#x27': "'",
  quot: '"',
  '#34': '"',
  '#x22': '"',
  ldquo: '\u201c',
  '#8220': '\u201c',
  '#x201c': '\u201c',
  rdquo: '\u201d',
  '#8221': '\u201d',
  '#x201d': '\u201d',
  ndash: '\u2013',
  '#8211': '\u2013',
  '#x2013': '\u2013',
  mdash: '\u2014',
  '#8212': '\u2014',
  '#x2014': '\u2014',
  nbsp: ' ',
  '#160': ' ',
  '#xa0': ' ',
  amp: '&',
  '#38': '&',
  '#x26': '&',
});

/** @type {Record<string, string>} */
const HLTB_LATIN_LIGATURE_MAP = Object.freeze({
  Ø: 'O',
  ø: 'o',
  ẞ: 'SS',
  ß: 'ss',
  Æ: 'AE',
  æ: 'ae',
  Œ: 'OE',
  œ: 'oe',
  Ł: 'L',
  ł: 'l',
  Đ: 'D',
  đ: 'd',
  Ð: 'D',
  ð: 'd',
  Þ: 'TH',
  þ: 'th',
});

const HLTB_NATURAL_PC_PREDECESSOR_RE =
  /(?:^|\s)(?:my|your|our|the|his|her|its|a|an|this|that|new|old|custom|virtual|retro|mini|pocket|super|dream|ultimate|gaming|home|office|build\s+a)\s+pc$/i;
const HLTB_NATURAL_WINDOWS_PREDECESSOR_RE =
  /(?:^|\s)(?:the|of|in|into|through|behind|between|beyond|under|over|from|with|without|two|three|four|many|broken|stained|open|closed|shattered|dark|rear|glass)\s+windows$/i;
const HLTB_STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'and',
  'or',
  'is',
  'edition',
  'game',
]);

/**
 * @param {string} input
 * @returns {string}
 */
function decodeHltbHtmlEntities(input) {
  if (!input || !input.includes('&')) return input || '';
  return input.replace(/&(?:#x0*([0-9a-f]+)|#0*(\d+)|([a-z0-9]+));/gi, (full, hex, dec, named) => {
    if (hex !== undefined) {
      const key = `#x${String(hex).toLowerCase()}`;
      return HLTB_HTML_ENTITY_MAP[key] ?? full;
    }
    if (dec !== undefined) {
      const key = `#${String(dec)}`;
      return HLTB_HTML_ENTITY_MAP[key] ?? full;
    }
    const key = String(named).toLowerCase();
    return HLTB_HTML_ENTITY_MAP[key] ?? full;
  });
}

/**
 * @param {string} input
 * @returns {string}
 */
function stripHltbTrademarksAndPlatformNoise(input) {
  if (!input) return '';
  let cur = decodeHltbHtmlEntities(input)
    .replace(/([\p{L}\p{N}])(?:[™®©℠℗]+|\(\s*(?:tm|r|c)\s*\))(?=[\p{L}\p{N}])/giu, '$1 ')
    .replace(/(?:[™®©℠℗]+|\(\s*(?:tm|r|c)\s*\))/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  for (let pass = 0; pass < 3; pass++) {
    const prev = cur;
    cur = cur
      .replace(
        /\s*[\(\[]\s*(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11|xbox(?:\s+pc|\s+one|\s+series\s+x\s*[\/|]\s*s|\s+play\s+anywhere)?|microsoft\s+store|game\s+preview|ea\s+play(?:\s+edition)?|base\s+game|(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11)\s+(?:edition|version))\s*[\)\]]/gi,
        ''
      )
      .replace(
        /([\(\[][^\)\]]+?)\s*[:\-–—]\s*(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11)(?:\s+(?:edition|version))?\s*([\)\]])/gi,
        '$1$2'
      )
      .replace(
        /(?:\s*[:\-–—]\s*|\s+for\s+)(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11|microsoft\s+store|xbox(?:\s+pc|\s+one|\s+series\s+x\s*[\/|]\s*s)?)(?:\s+(?:edition|version))?\s*$/gi,
        ''
      )
      .replace(/(?:\s*[:\-–—]\s*)(?:ea\s+play(?:\s+edition)?|base\s+game)\s*$/gi, '')
      .replace(
        /(?:[:\-–—]\s*|\s+)(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11)\s+(?:edition|version)\s*$/gi,
        ''
      )
      .replace(/(?:[:\-–—]\s*|\s+)game\s+preview\s*$/gi, '')
      .replace(
        /(?:[:\-–—]\s*|\s+)(?:amazon\s+prime(?:\s+gaming)?|prime\s+gaming|ea\s+play(?:\s+pro)?|ubisoft\s+connect|xbox\s+game\s+pass)(?:\s+(?:edition|version))?\s*$/gi,
        ''
      )
      .replace(/\s+/g, ' ')
      .trim();

    if (/\s+pc$/i.test(cur) && !HLTB_NATURAL_PC_PREDECESSOR_RE.test(cur)) {
      const withoutPc = cur.replace(/\s+pc$/i, '').trim();
      if (withoutPc.length >= 2) cur = withoutPc;
    }
    if (/\s+windows(?:\s*10|\s*11)?$/i.test(cur) && !HLTB_NATURAL_WINDOWS_PREDECESSOR_RE.test(cur)) {
      const withoutWin = cur.replace(/\s+windows(?:\s*10|\s*11)?$/i, '').trim();
      if (withoutWin.length >= 2) cur = withoutWin;
    }
    if (cur === prev) break;
  }

  return cur || input.trim();
}

/**
 * @param {string} input
 * @returns {string}
 */
function foldHltbLatinAndDiacritics(input) {
  if (!input || !/[^\x00-\x7f]/.test(input)) return input || '';
  return input
    .replace(/[ØøẞßÆæŒœŁłĐđÐðÞþ]/g, (ch) => HLTB_LATIN_LIGATURE_MAP[ch] ?? ch)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * @param {string} rawTitle
 * @param {{ stripEditions?: boolean; splitHyphens?: boolean }} [options]
 * @returns {string}
 */
function sanitizeHltbSearchClause(rawTitle, options) {
  if (!rawTitle || typeof rawTitle !== 'string') return '';
  let working = stripHltbTrademarksAndPlatformNoise(rawTitle);
  if (options?.stripEditions) {
    working = working
      .replace(
        /(?:[:\-–—]\s*|\s+|\s*[\(\[]\s*)\bYear\s+(?:\d+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)\s+(?:Edition|Pass|Bundle|Pack|Upgrade)\b\s*[\)\]]?/gi,
        ' '
      )
      .replace(
        /(?:[:\-–—]\s*|\s+|\s*[\(\[]\s*)\b\d+(?:st|nd|rd|th)?[\s\-]*Year\s+(?:Anniversary|Celebration)(?:\s+Edition)?\b\s*[\)\]]?/gi,
        ' '
      )
      .replace(
        /(?:[:\-–—]\s*|\s+|\s*[\(\[]\s*)\b\d+(?:st|nd|rd|th)\s+Anniversary(?:\s+Edition)?\b\s*[\)\]]?/gi,
        ' '
      )
      .replace(
        /(?:\s*[\(\[]\s*(?:19|20)\d{2}\s+Edition\s*[\)\]]|(?:[:\-–—]\s*|\s+)\b(?:19|20)\d{2}\s+Edition\b)/gi,
        ' '
      );
  }

  working = working.replace(/[\(\[]\s*((?:19|20)\d{2})\s*[\)\]]/g, ' $1 ');
  if (!options?.stripEditions) {
    working = working.replace(/[\(\[]\s*(remastered|remaster|remake)\s*[\)\]]/gi, ' $1 ');
  }
  working = working.replace(/[\(\[][^\)\]]*[\)\]]/g, ' ');

  working = foldHltbLatinAndDiacritics(working);
  if (working.includes('.')) {
    working = working.replace(/\b(?:[A-Za-z]\.){2,}[A-Za-z]?\.?/g, (m) => m.replace(/\./g, ''));
  }

  working = working.replace(/['’‘ʼ`´"“”]/g, (ch, offset, str) => {
    if ("'’‘ʼ`´".includes(ch)) {
      const prev = offset > 0 ? str[offset - 1] : '';
      const next = offset + 1 < str.length ? str[offset + 1] : '';
      if (/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next)) {
        return "'";
      }
    }
    return '';
  });

  if (options?.stripEditions) {
    const beforeEditionStrip = working;
    const editionStripped = working
      .replace(
        /\b(?:vault|launch|founders?|royal|original|cross[\s\-]?gen|celebration|international)\s+(?:edition|bundle|pack|collection)\b.*$/i,
        ''
      )
      .replace(
        /\b(?:digital\s+)?(?:the\s+)?(?:standard|deluxe|gold|silver|platinum|diamond|premium|collector'?s|ultimate|complete|extended|special|limited|definitive|enhanced|anniversary|celebration|director'?s\s+cut|final\s+cut|classic\s+and\s+uncut|royal\s+edition|original\s+edition|drm[\s\-]?free(?:\s+edition)?|goty|game\s+of\s+the\s+year|remastered|remaster|remake)\b.*$/i,
        ''
      )
      .replace(/[\s\-]+(?:edition|pack|bundle|collection)\s*$/i, '')
      .trim();
    working =
      editionStripped.replace(/[^A-Za-z0-9]/g, '').length >= 2
        ? editionStripped
        : beforeEditionStrip;
  }

  if (options?.splitHyphens) {
    working = working.replace(/[^A-Za-z0-9']+/g, ' ');
  } else {
    working = working
      .replace(/[\u2010\u2011]/g, '-')
      .replace(/[^A-Za-z0-9'-]+/g, ' ');
  }

  return working
    .replace(/(^|\s)[-']+|[-']+(\s|$)/g, ' ')
    .replace(/-{2,}/g, ' ')
    .replace(/'{2,}/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generates up to 3 deduplicated token-array passes for HowLongToBeat `/api/search/site`.
 * @param {string} rawTitle
 * @returns {string[][]}
 */
function buildHltbSearchTermPasses(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') return [];

  /** @type {string[][]} */
  const passes = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {string} clause */
  const addPass = (clause) => {
    if (!clause) return;
    const tokens = clause.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return;
    const key = tokens.map((t) => t.toLowerCase()).join(' ');
    if (seen.has(key)) return;
    seen.add(key);
    passes.push(tokens);
  };

  addPass(sanitizeHltbSearchClause(rawTitle, { stripEditions: false, splitHyphens: false }));
  addPass(sanitizeHltbSearchClause(rawTitle, { stripEditions: true, splitHyphens: true }));

  const preCleaned = stripHltbTrademarksAndPlatformNoise(rawTitle);
  const delimiterMatch = preCleaned.match(/^(.*?)(?::|\s+[\-–—−]\s+)/);
  if (delimiterMatch && delimiterMatch[1]) {
    const baseClause = sanitizeHltbSearchClause(delimiterMatch[1], {
      stripEditions: true,
      splitHyphens: true,
    });
    if (baseClause.replace(/[^A-Za-z0-9]/g, '').length >= 2) {
      addPass(baseClause);
    }
  }

  return passes.slice(0, 3);
}

/**
 * @param {string[]} tokens
 * @returns {Set<string>}
 */
function extractHltbBaseWords(tokens) {
  const cleaned = tokens
    .map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  const substantive = cleaned.filter((w) => !HLTB_STOP_WORDS.has(w));
  return new Set(substantive.length > 0 ? substantive : cleaned);
}

/**
 * @param {unknown} candidateName
 * @param {Set<string>} baseWords
 * @returns {boolean}
 */
function hltbCandidateSharesBaseWord(candidateName, baseWords) {
  if (typeof candidateName !== 'string' || !candidateName.trim()) return false;
  if (baseWords.size === 0) return true;
  const normalized = foldHltbLatinAndDiacritics(
    stripHltbTrademarksAndPlatformNoise(candidateName)
  )
    .toLowerCase()
    .replace(/['’‘ʼ`´"“”]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized) return false;
  const candWords = normalized.split(/\s+/).filter(Boolean);
  if (candWords.some((w) => baseWords.has(w))) return true;
  const compactCand = candWords.join('');
  for (const bw of baseWords) {
    if (bw.length >= 3 && compactCand.includes(bw)) return true;
  }
  return false;
}

/**
 * Clean Electron/OneLauncher tokens from User-Agent string so storefront OAuth pages do not block WebViews.
 * @param {any} session
 * @returns {string}
 */
function resolveCleanBrowserUserAgent(session) {
  const defaultUa =
    process.platform === 'win32'
      ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
      : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
  try {
    const rawUa = session?.defaultSession?.getUserAgent?.();
    if (!rawUa || typeof rawUa !== 'string') return defaultUa;
    return rawUa
      .replace(/\s+OneLauncher\/[^\s]+/gi, '')
      .replace(/\s+one-launcher\/[^\s]+/gi, '')
      .replace(/\s+Electron\/[^\s]+/gi, '');
  } catch {
    return defaultUa;
  }
}

/**
 * Register all Storefront OAuth, Catalog Sync, Achievement, HLTB & IGDB IPC handlers.
 *
 * @param {{
 *   ipcMain: any,
 *   BrowserWindow: any,
 *   session: any,
 *   getMainWindow: () => any,
 *   storeSync: any,
 *   launcherEngine: any
 * }} deps
 */
function registerStoreSyncIpcHandlers({
  ipcMain,
  BrowserWindow,
  session,
  getMainWindow,
  storeSync,
  launcherEngine,
}) {
  if (!ipcMain) return { trimStoreSyncIpcMemory: trimSteamLocalScannerMemory };
  trimSteamLocalScannerMemory();

  const recoverEpicAuthSession = createEpicAuthRecovery({
    BrowserWindow,
    getMainWindow,
    storeSync,
    launcherEngine,
  });

  if (typeof launcherEngine?.setEpicAuthRecoveryHook === 'function') {
    launcherEngine.setEpicAuthRecoveryHook(recoverEpicAuthSession);
  }

  /** @type {Promise<{ recovered: boolean, error?: string }> | null} */
  let inFlightXboxLicenseRecovery = null;

  /**
   * On-demand single-flight Microsoft Store `TokenBroker` (`InlineLogin.srf`) recovery hook.
   * Invoked automatically during Xbox `.msixvc` installation when an account was previously
   * restored from an OAuth2-only refresh token lacking `storeTicket` / `userStsLegacyTokenXml`
   * (or when a Store licensing session requires interactive consent), so `Quake` and all other
   * encrypted `.msixvc` packages acquire their 32-byte `CIK` and stream seamlessly without failing.
   *
   * @param {{ title?: string, userDataDir?: string }} [context]
   * @returns {Promise<{ recovered: boolean, error?: string }>}
   */
  const recoverXboxStoreLicenseSession = (context = {}) => {
    if (inFlightXboxLicenseRecovery) {
      return inFlightXboxLicenseRecovery;
    }

    inFlightXboxLicenseRecovery = (async () => {
      if (
        !BrowserWindow ||
        typeof storeSync?.xboxStorefront?.buildInlineLoginRequest !== 'function' ||
        typeof storeSync?.getXboxAuthProvider !== 'function'
      ) {
        return { recovered: false, error: 'Xbox Store license recovery window unavailable' };
      }

      const provider = storeSync.getXboxAuthProvider(
        context?.userDataDir ? { userDataDir: context.userDataDir } : undefined
      );
      if (
        !provider ||
        typeof provider.ensureDeviceContext !== 'function' ||
        typeof provider.exchangeTokenBrokerDaProperty !== 'function'
      ) {
        return { recovered: false, error: 'Xbox auth provider unavailable' };
      }

      /** @type {{ url: string, userAgent: string, extraHeadersString?: string }} */
      let xboxInlineReq;
      try {
        await provider.ensureDeviceContext({ requireLegacyToken: true });
        xboxInlineReq = storeSync.xboxStorefront.buildInlineLoginRequest();
      } catch (err) {
        const scrubbedMessage = scrubAuthDiagnosticError(err);
        diagLog.warn(
          'storeSyncIpc.recoverXboxStoreLicenseSession.ensureDeviceContext',
          scrubbedMessage
        );
        return {
          recovered: false,
          error: scrubbedMessage || 'Xbox device license provisioning failed',
        };
      }
      const config = STORE_OAUTH_URLS.xbox || { width: 520, height: 680 };

      return await new Promise((resolve) => {
        let resolved = false;
        let xboxIsSecondLeg = false;
        let xboxProcessingToken = false;

        const currentMain = getMainWindow?.();
        const isolatedXboxSession =
          typeof session?.fromPartition === 'function'
            ? session.fromPartition(`xbox-cxh-lic-${crypto.randomUUID()}`, { cache: false })
            : null;

        /** @type {Record<string, any>} */
        const webPreferences = {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          preload: path.join(__dirname, '../xboxAuthPreload.cjs'),
          userAgent: xboxInlineReq.userAgent,
          ...(isolatedXboxSession
            ? { session: isolatedXboxSession }
            : { partition: resolveStorefrontOAuthPartition('xbox') }),
        };

        const authWindow = new BrowserWindow({
          width: config.width || 520,
          height: config.height || 680,
          parent: currentMain && !currentMain.isDestroyed() ? currentMain : undefined,
          modal: false,
          closable: true,
          minimizable: true,
          resizable: true,
          autoHideMenuBar: true,
          show: true,
          title: context?.title
            ? `Authorize Microsoft Store License - ${context.title}`
            : 'Authorize Microsoft Store License - XBOX',
          webPreferences,
        });

        const popupSession =
          isolatedXboxSession ||
          authWindow.webContents?.session ||
          (typeof session?.fromPartition === 'function'
            ? session.fromPartition(resolveStorefrontOAuthPartition('xbox'))
            : null);

        if (typeof authWindow.webContents?.setUserAgent === 'function') {
          authWindow.webContents.setUserAgent(xboxInlineReq.userAgent);
        }

        const isTrustedXboxUrl = (/** @type {string} */ candidate) => {
          if (!isAllowedHttpsHost(candidate, XBOX_TRUSTED_AUTH_HOSTS)) {
            return false;
          }
          if (typeof storeSync?.xboxStorefront?.isTrustedXboxAuthUrl === 'function') {
            return Boolean(storeSync.xboxStorefront.isTrustedXboxAuthUrl(candidate));
          }
          return true;
        };

        /** @type {(event: any, payload: unknown) => void} */
        let onXboxCxhNotify = () => {};

        const safelyCloseAuthWindow = () => {
          if (typeof ipcMain?.removeListener === 'function') {
            try {
              ipcMain.removeListener('one-launcher:xbox-cxh-notify', onXboxCxhNotify);
            } catch {}
          }
          if (isolatedXboxSession && typeof isolatedXboxSession.clearStorageData === 'function') {
            try {
              void isolatedXboxSession.clearStorageData();
            } catch {}
          }
          clearOAuthPopupSessionCaches(popupSession);
          try {
            if (!authWindow.isDestroyed()) {
              authWindow.close();
            }
            if (!authWindow.isDestroyed()) {
              authWindow.destroy();
            }
          } catch {}
        };

        /** @param {string} rawPayload */
        const handleXboxCxhPayload = async (rawPayload) => {
          if (
            resolved ||
            authWindow.isDestroyed() ||
            typeof rawPayload !== 'string' ||
            !rawPayload ||
            Buffer.byteLength(rawPayload) > 65536
          ) {
            return;
          }
          /** @type {any} */
          let parsed = null;
          try {
            parsed = JSON.parse(rawPayload);
          } catch {
            return;
          }
          if (!parsed || typeof parsed !== 'object') return;

          if (
            parsed.type === 'invoke' &&
            parsed.value &&
            parsed.value.name === 'CloudExperienceHost.getContext' &&
            typeof parsed.value.context === 'string' &&
            parsed.value.context.length <= 4096
          ) {
            if (!isTrustedXboxUrl(authWindow.webContents.getURL())) return;
            const callbackMsg = JSON.stringify({
              type: 'callback',
              value: {
                name: 'CloudExperienceHost.getContext',
                args: [
                  'CloudExperienceHost',
                  'TokenBroker',
                  'TokenBroker',
                  '{"PrivatePropertyBag":1,"PasswordlessConnect":1,"PreferAssociate":1,"ChromelessUI":0}',
                ],
                context: parsed.value.context,
              },
            });
            try {
              await authWindow.webContents.executeJavaScript(
                `globalThis["CloudExperienceHost.Bridge.dispatchMessage"]?.(${JSON.stringify(callbackMsg)})`
              );
            } catch {}
            return;
          }

          if (typeof parsed.sDAToken === 'string' && parsed.sDAToken && !xboxProcessingToken) {
            xboxProcessingToken = true;
            try {
              const exResult = await provider.exchangeTokenBrokerDaProperty(parsed, {
                isSecondLeg: xboxIsSecondLeg,
              });
              if (
                exResult &&
                exResult.requiresInlineConsent &&
                exResult.inlineAuthUrl &&
                !xboxIsSecondLeg &&
                !resolved &&
                !authWindow.isDestroyed()
              ) {
                xboxIsSecondLeg = true;
                authWindow.loadURL(exResult.inlineAuthUrl);
                return;
              }
              if (!resolved) {
                resolved = true;
                safelyCloseAuthWindow();
                const mintedTicket =
                  exResult?.storeTicket ||
                  (typeof provider.getStoreMsaToken === 'function'
                    ? await provider.getStoreMsaToken({ forLicensing: true })
                    : '');
                resolve({ recovered: Boolean(mintedTicket) });
              }
            } catch (err) {
              if (!resolved) {
                resolved = true;
                safelyCloseAuthWindow();
                resolve({
                  recovered: false,
                  error: scrubAuthDiagnosticError(err),
                });
              }
            } finally {
              xboxProcessingToken = false;
            }
          }
        };

        onXboxCxhNotify = (/** @type {any} */ event, /** @type {unknown} */ payload) => {
          if (
            resolved ||
            authWindow.isDestroyed() ||
            event?.sender !== authWindow.webContents ||
            (event?.senderFrame &&
              authWindow.webContents.mainFrame &&
              event.senderFrame !== authWindow.webContents.mainFrame) ||
            typeof payload !== 'string'
          ) {
            return;
          }
          const senderUrl = event?.senderFrame?.url || authWindow.webContents.getURL();
          if (!isTrustedXboxUrl(senderUrl)) return;
          void handleXboxCxhPayload(payload);
        };

        if (typeof ipcMain?.on === 'function') {
          ipcMain.on('one-launcher:xbox-cxh-notify', onXboxCxhNotify);
        }

        authWindow.webContents.on('will-prevent-unload', (/** @type {any} */ event) => {
          event.preventDefault();
        });

        authWindow.webContents.on('did-finish-load', async () => {
          if (resolved || authWindow.isDestroyed()) return;
          const currentUrl = authWindow.webContents.getURL();
          if (isLivePostSrfUrl(currentUrl)) {
            try {
              const serverDataStr = await authWindow.webContents.executeJavaScript(
                'JSON.stringify(globalThis.ServerData ?? null)'
              );
              if (typeof serverDataStr === 'string' && serverDataStr !== 'null') {
                await handleXboxCxhPayload(serverDataStr);
              }
            } catch {}
          }
        });

        authWindow.on('closed', () => {
          if (typeof ipcMain?.removeListener === 'function') {
            try {
              ipcMain.removeListener('one-launcher:xbox-cxh-notify', onXboxCxhNotify);
            } catch {}
          }
          clearOAuthPopupSessionCaches(popupSession);
          if (!resolved) {
            resolved = true;
            resolve({ recovered: false, error: 'Sign-in window closed by user.' });
          }
        });

        if (xboxInlineReq.extraHeadersString) {
          authWindow.loadURL(xboxInlineReq.url, { extraHeaders: xboxInlineReq.extraHeadersString });
        } else {
          authWindow.loadURL(xboxInlineReq.url);
        }
      });
    })()
      .catch((err) => ({
        recovered: false,
        error: scrubAuthDiagnosticError(err),
      }))
      .finally(() => {
        inFlightXboxLicenseRecovery = null;
      });

    return inFlightXboxLicenseRecovery;
  };

  if (typeof launcherEngine?.setXboxStoreLicenseRecoveryHook === 'function') {
    launcherEngine.setXboxStoreLicenseRecoveryHook(recoverXboxStoreLicenseSession);
  }

  /**
   * Process OAuth / TokenBroker exchange and full library entitlement synchronization.
   * @param {string} storefrontId
   * @param {any} codeOrPayload
   */
  async function processStoreAuth(storefrontId, codeOrPayload) {
    let accountName = 'Verified User';
    let avatarUrl;
    /** @type {any[]} */
    let games = [];
    let tokenData = null;
    let authoritativeComplete = false;
    const codeLabel = typeof codeOrPayload === 'string' ? codeOrPayload : 'xbox_token_broker';

    try {
      launcherEngine?.clearStoreDisconnectedTombstone?.(storefrontId);
      if (storefrontId === 'gog') {
        tokenData = await storeSync.exchangeGogCode(codeLabel);
        const account = await storeSync.fetchGogAccount(tokenData.access_token);
        accountName = account.username || 'GOG User';
        avatarUrl = account.avatarUrl;
        games = await storeSync.fetchGogOwnedGames(
          tokenData.access_token,
          accountName,
          account.userId
        );
        authoritativeComplete = Boolean(storeSync.fetchGogOwnedGames.lastAuthoritativeComplete);
      } else if (storefrontId === 'epic') {
        tokenData = await storeSync.exchangeEpicCode(codeLabel);
        accountName = tokenData.displayName || tokenData.account_id || 'Epic Games User';
        games = await storeSync.fetchEpicOwnedGames(tokenData.access_token, tokenData.account_id);
        authoritativeComplete = Boolean(storeSync.fetchEpicOwnedGames.lastAuthoritativeComplete);
      } else if (storefrontId === 'xbox') {
        const xboxRes = await storeSync.loginXbox(codeOrPayload);
        if (xboxRes && xboxRes.requiresInlineConsent) {
          return xboxRes;
        }
        accountName = xboxRes.accountName || xboxRes.gamertag || 'Xbox Player';
        avatarUrl = xboxRes.avatarUrl;
        games = xboxRes.games || [];
        const savedXboxRaw = storeSync.loadSavedTokens()?.xbox || {
          connected: true,
          accountName,
          gamertag: xboxRes.gamertag || accountName,
          xuid: xboxRes.xuid,
          avatarUrl,
          subscription: xboxRes.subscription,
          syncMode: xboxRes.syncMode,
        };
        tokenData = sanitizeStoreTokenEntryForRenderer('xbox', savedXboxRaw, storeSync);
        return {
          success: true,
          code: codeLabel,
          storefrontId,
          accountName,
          accountId: xboxRes.xuid,
          xuid: xboxRes.xuid,
          avatarUrl,
          gamerscore: xboxRes.gamerscore || 0,
          subscription: xboxRes.subscription,
          syncMode: xboxRes.syncMode,
          authoritativeComplete: Boolean(xboxRes.authoritativeComplete),
          subscriptionChanged: Boolean(xboxRes.subscriptionChanged),
          transientOffline: games.length === 0 && !xboxRes.authoritativeComplete,
          games,
          achievements: xboxRes.achievements || {},
          suppressedItems: xboxRes.suppressedItems || [],
          tokenData,
        };
      }

      return {
        success: true,
        code: codeLabel,
        storefrontId,
        accountName,
        avatarUrl,
        games,
        authoritativeComplete,
        tokenData: sanitizeStoreTokenEntryForRenderer(storefrontId, tokenData, storeSync),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (storefrontId === 'xbox' && !tokenData) {
        const anyErr = /** @type {any} */ (err);
        return {
          success: false,
          storefrontId,
          error: msg,
          errorCode: anyErr?.code,
          xerr: anyErr?.xerr,
          redirectUrl: anyErr?.redirectUrl,
        };
      }
      console.warn(`Post-login sync warning for ${storefrontId}:`, msg);
      return {
        success: true,
        code: codeLabel,
        storefrontId,
        accountName,
        avatarUrl,
        games: [],
        syncError: msg,
        tokenData: sanitizeStoreTokenEntryForRenderer(storefrontId, tokenData, storeSync),
      };
    }
  }

  ipcMain.handle('auth:storefront', async (/** @type {any} */ _event, /** @type {string} */ storefrontId) => {
    const config = STORE_OAUTH_URLS[storefrontId];
    if (!config) {
      return { success: false, error: `Unsupported storefront: ${storefrontId}` };
    }

    /** @type {{ url: string, userAgent: string, extraHeadersString: string } | null} */
    let xboxInlineReq = null;
    if (
      storefrontId === 'xbox' &&
      typeof storeSync?.xboxStorefront?.buildInlineLoginRequest === 'function'
    ) {
      try {
        const provider = storeSync.getXboxAuthProvider?.();
        if (provider && typeof provider.ensureDeviceContext === 'function') {
          await provider.ensureDeviceContext({ requireLegacyToken: true });
          xboxInlineReq = storeSync.xboxStorefront.buildInlineLoginRequest();
        }
      } catch (err) {
        // Fallback seamlessly to standard LiveSDK Desktop OAuth2 (`oauth20_desktop.srf`) if SOAP device init is unavailable
        diagLog.warn(
          'storeSyncIpc.authStorefront.xboxEnsureDeviceContext',
          scrubAuthDiagnosticError(err)
        );
        xboxInlineReq = null;
      }
    }

    return new Promise((resolve) => {
      let resolved = false;
      let extractingSteam = false;
      let xboxIsSecondLeg = false;
      let xboxProcessingToken = false;

      const cleanBrowserUA = resolveCleanBrowserUserAgent(session);
      const currentMain = getMainWindow?.();
      const xboxCsrfState =
        storefrontId === 'xbox' ? crypto.randomBytes(16).toString('hex') : '';
      let targetAuthUrl = xboxInlineReq ? xboxInlineReq.url : config.url;
      if (!xboxInlineReq && storefrontId === 'xbox') {
        try {
          const parsedCfgUrl = new URL(config.url);
          if (!parsedCfgUrl.searchParams.has('state')) {
            parsedCfgUrl.searchParams.set('state', xboxCsrfState);
          }
          targetAuthUrl = parsedCfgUrl.toString();
        } catch {}
      }

      const oauthPartition = resolveStorefrontOAuthPartition(storefrontId);
      const isolatedXboxSession =
        xboxInlineReq && typeof session?.fromPartition === 'function'
          ? session.fromPartition(`xbox-cxh-${crypto.randomUUID()}`, { cache: false })
          : null;

      /** @type {Record<string, any>} */
      const webPreferences = {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        userAgent: xboxInlineReq ? xboxInlineReq.userAgent : cleanBrowserUA,
      };
      if (xboxInlineReq) {
        webPreferences.preload = path.join(__dirname, '../xboxAuthPreload.cjs');
        if (isolatedXboxSession) {
          webPreferences.session = isolatedXboxSession;
        } else {
          webPreferences.partition = oauthPartition;
        }
      } else {
        webPreferences.partition = oauthPartition;
      }

      const authWindow = new BrowserWindow({
        width: config.width,
        height: config.height,
        parent: currentMain && !currentMain.isDestroyed() ? currentMain : undefined,
        modal: false,
        closable: true,
        minimizable: true,
        resizable: true,
        autoHideMenuBar: true,
        show: true,
        title: `Sign In - ${storefrontId.toUpperCase()}`,
        webPreferences,
      });

      const popupSession =
        isolatedXboxSession ||
        authWindow.webContents?.session ||
        (typeof session?.fromPartition === 'function'
          ? session.fromPartition(oauthPartition)
          : null);

      if (xboxInlineReq && typeof authWindow.webContents?.setUserAgent === 'function') {
        authWindow.webContents.setUserAgent(xboxInlineReq.userAgent);
      }

      const isTrustedXboxUrl = (/** @type {string} */ candidate) => {
        if (!isAllowedHttpsHost(candidate, XBOX_TRUSTED_AUTH_HOSTS)) {
          return false;
        }
        if (typeof storeSync?.xboxStorefront?.isTrustedXboxAuthUrl === 'function') {
          return Boolean(storeSync.xboxStorefront.isTrustedXboxAuthUrl(candidate));
        }
        return true;
      };

      /** @param {string} rawPayload */
      const handleXboxCxhPayload = async (rawPayload) => {
        if (resolved || authWindow.isDestroyed() || typeof rawPayload !== 'string' || !rawPayload) {
          return;
        }
        if (Buffer.byteLength(rawPayload) > 65536) return;
        /** @type {any} */
        let parsed = null;
        try {
          parsed = JSON.parse(rawPayload);
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== 'object') return;

        // 1. CloudExperienceHost.getContext bridge handshake
        if (
          parsed.type === 'invoke' &&
          parsed.value &&
          parsed.value.name === 'CloudExperienceHost.getContext' &&
          typeof parsed.value.context === 'string' &&
          parsed.value.context.length <= 4096
        ) {
          if (!isTrustedXboxUrl(authWindow.webContents.getURL())) return;
          const callbackMsg = JSON.stringify({
            type: 'callback',
            value: {
              name: 'CloudExperienceHost.getContext',
              args: [
                'CloudExperienceHost',
                'TokenBroker',
                'TokenBroker',
                '{"PrivatePropertyBag":1,"PasswordlessConnect":1,"PreferAssociate":1,"ChromelessUI":0}',
              ],
              context: parsed.value.context,
            },
          });
          try {
            await authWindow.webContents.executeJavaScript(
              `globalThis["CloudExperienceHost.Bridge.dispatchMessage"]?.(${JSON.stringify(callbackMsg)})`
            );
          } catch {}
          return;
        }

        // 2. DAProperty user token exchange (1-leg SSO or 2-leg consent)
        if (typeof parsed.sDAToken === 'string' && parsed.sDAToken && !xboxProcessingToken) {
          xboxProcessingToken = true;
          try {
            const syncResult = await processStoreAuth('xbox', {
              daProperty: parsed,
              isSecondLeg: xboxIsSecondLeg,
            });
            if (
              syncResult &&
              syncResult.requiresInlineConsent &&
              syncResult.inlineAuthUrl &&
              !xboxIsSecondLeg &&
              !resolved &&
              !authWindow.isDestroyed()
            ) {
              xboxIsSecondLeg = true;
              authWindow.loadURL(syncResult.inlineAuthUrl);
              return;
            }
            if (!resolved) {
              resolved = true;
              safelyCloseAuthWindow();
              resolve(syncResult);
            }
          } finally {
            xboxProcessingToken = false;
          }
        }
      };

      const onXboxCxhNotify = (/** @type {any} */ event, /** @type {unknown} */ payload) => {
        if (
          resolved ||
          authWindow.isDestroyed() ||
          event?.sender !== authWindow.webContents ||
          (event?.senderFrame &&
            authWindow.webContents.mainFrame &&
            event.senderFrame !== authWindow.webContents.mainFrame) ||
          typeof payload !== 'string'
        ) {
          return;
        }
        const senderUrl = event?.senderFrame?.url || authWindow.webContents.getURL();
        if (!isTrustedXboxUrl(senderUrl)) return;
        void handleXboxCxhPayload(payload);
      };

      if (xboxInlineReq && typeof ipcMain.on === 'function') {
        ipcMain.on('one-launcher:xbox-cxh-notify', onXboxCxhNotify);
      }

      const safelyCloseAuthWindow = () => {
        if (xboxInlineReq && typeof ipcMain.removeListener === 'function') {
          try {
            ipcMain.removeListener('one-launcher:xbox-cxh-notify', onXboxCxhNotify);
          } catch {}
        }
        if (isolatedXboxSession && typeof isolatedXboxSession.clearStorageData === 'function') {
          try {
            void isolatedXboxSession.clearStorageData();
          } catch {}
        }
        clearOAuthPopupSessionCaches(popupSession);
        try {
          if (!authWindow.isDestroyed()) {
            authWindow.close();
          }
          if (!authWindow.isDestroyed()) {
            authWindow.destroy();
          }
        } catch {}
      };

      authWindow.webContents.on('will-prevent-unload', (/** @type {any} */ event) => {
        event.preventDefault();
      });

      /** @param {string} code */
      const handleAuthCodeFound = async (code) => {
        if (!code || resolved) return;
        resolved = true;
        safelyCloseAuthWindow();
        const syncResult = await processStoreAuth(storefrontId, code);
        resolve(syncResult);
      };

      /** @param {string} url */
      const checkUrlForCode = (url) => {
        if (!url || resolved) return;

        if (storefrontId === 'gog' && isAllowedHttpsHost(url, ['embed.gog.com', 'auth.gog.com', 'gog.com'])) {
          try {
            const parsed = new URL(url);
            if (parsed.pathname.includes('/on_login_success')) {
              const code = parsed.searchParams.get('code');
              if (code) {
                handleAuthCodeFound(code);
                return;
              }
            }
          } catch {}
        }

        if (storefrontId === 'epic') {
          try {
            const parsed = new URL(url);
            if (
              (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
              parsed.hostname.toLowerCase() === 'localhost' &&
              parsed.pathname.startsWith('/launcher/authorized')
            ) {
              const code = parsed.searchParams.get('code');
              if (code) {
                handleAuthCodeFound(code);
                return;
              }
            }
          } catch {}
        }

        if (
          storefrontId === 'xbox' &&
          isAllowedHttpsHost(url, ['login.live.com', 'login.microsoftonline.com'])
        ) {
          try {
            const parsed = new URL(url);
            if (parsed.pathname.toLowerCase().endsWith('/oauth20_desktop.srf')) {
              if (parsed.searchParams.has('error')) {
                const errCode = parsed.searchParams.get('error') || 'access_denied';
                const errDesc = parsed.searchParams.get('error_description') || errCode;
                resolved = true;
                safelyCloseAuthWindow();
                resolve({
                  success: false,
                  storefrontId: 'xbox',
                  error: `Microsoft sign-in cancelled (${errDesc})`,
                });
                return;
              }
              const returnedState = parsed.searchParams.get('state');
              if (xboxCsrfState && returnedState && returnedState !== xboxCsrfState) {
                resolved = true;
                safelyCloseAuthWindow();
                resolve({
                  success: false,
                  storefrontId: 'xbox',
                  error: 'Microsoft OAuth state mismatch (CSRF validation failed).',
                });
                return;
              }
              const code = parsed.searchParams.get('code');
              if (code) {
                handleAuthCodeFound(code);
                return;
              }
            }
          } catch {}
        }
      };

      const tryExtractSteamGames = async () => {
        if (resolved || extractingSteam || authWindow.isDestroyed() || storefrontId !== 'steam') {
          return;
        }
        const currentUrl = authWindow.webContents.getURL();
        if (!isAuthenticatedSteamCommunityUrl(currentUrl)) {
          return;
        }

        extractingSteam = true;
        try {
          const steamData = await authWindow.webContents.executeJavaScript(
            STEAM_AUTH_PAGE_EXTRACTOR_SCRIPT
          );

          if (steamData && steamData.gameslistJson && !resolved) {
            resolved = true;
            safelyCloseAuthWindow();
            const parsedSteam = await parseSteamGamesListJson(
              steamData.gameslistJson,
              steamData.steamId,
              steamData.personaName,
              steamData.avatarUrl,
              [],
              storeSync
            );
            const tokenPayload = {
              access_token: 'steam_web_session',
              webapi_token: steamData.webApiToken,
              steamId: parsedSteam.accountId,
              accountName: parsedSteam.accountName,
              avatarUrl: parsedSteam.avatarUrl,
              games: parsedSteam.games,
            };
            storeSync.saveTokens('steam', tokenPayload);
            try {
              launcherEngine?.clearStoreDisconnectedTombstone?.('steam');
            } catch {}
            resolve({
              success: true,
              storefrontId: 'steam',
              accountName: parsedSteam.accountName,
              accountId: parsedSteam.accountId,
              avatarUrl: parsedSteam.avatarUrl,
              games: parsedSteam.games,
              tokenData: sanitizeStoreTokenEntryForRenderer('steam', tokenPayload, storeSync),
            });
            return;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn('Steam web extraction warning:', msg);
        } finally {
          extractingSteam = false;
        }
      };

      authWindow.webContents.on('will-redirect', (/** @type {any} */ _event, /** @type {string} */ url) => {
        checkUrlForCode(url);
      });

      authWindow.webContents.on('will-navigate', (/** @type {any} */ _event, /** @type {string} */ url) => {
        checkUrlForCode(url);
      });

      authWindow.webContents.on(
        'did-navigate',
        async (/** @type {any} */ _event, /** @type {string} */ url) => {
          checkUrlForCode(url);

          if (storefrontId === 'epic' && isEpicAuthRedirectUrl(url)) {
            try {
              const pageSource = await authWindow.webContents.executeJavaScript(
                'document.body.innerText'
              );
              if (pageSource) {
                const match =
                  pageSource.match(/"authorizationCode"\s*:\s*"([a-fA-F0-9]{32})"/i) ||
                  pageSource.match(/\b([a-fA-F0-9]{32})\b/);
                if (match) {
                  handleAuthCodeFound(match[1]);
                  return;
                }
              }
            } catch {}
          }

          if (storefrontId === 'steam' && isAuthenticatedSteamCommunityUrl(url)) {
            await tryExtractSteamGames();
          }
        }
      );

      authWindow.webContents.on('did-finish-load', async () => {
        if (resolved || authWindow.isDestroyed()) return;
        const currentUrl = authWindow.webContents.getURL();
        checkUrlForCode(currentUrl);

        if (xboxInlineReq && storefrontId === 'xbox' && isLivePostSrfUrl(currentUrl)) {
          try {
            const serverDataStr = await authWindow.webContents.executeJavaScript(
              'JSON.stringify(globalThis.ServerData ?? null)'
            );
            if (typeof serverDataStr === 'string' && serverDataStr !== 'null') {
              await handleXboxCxhPayload(serverDataStr);
              return;
            }
          } catch {}
        }

        if (storefrontId === 'epic' && isEpicAuthRedirectUrl(currentUrl)) {
          try {
            const pageSource = await authWindow.webContents.executeJavaScript(
              'document.body.innerText'
            );
            if (pageSource) {
              const match =
                pageSource.match(/"authorizationCode"\s*:\s*"([a-fA-F0-9]{32})"/i) ||
                pageSource.match(/\b([a-fA-F0-9]{32})\b/);
              if (match) {
                handleAuthCodeFound(match[1]);
                return;
              }
            }
          } catch {}
        }

        if (storefrontId === 'steam' && isAuthenticatedSteamCommunityUrl(currentUrl)) {
          await tryExtractSteamGames();
        }
      });

      authWindow.on('closed', () => {
        if (xboxInlineReq && typeof ipcMain.removeListener === 'function') {
          try {
            ipcMain.removeListener('one-launcher:xbox-cxh-notify', onXboxCxhNotify);
          } catch {}
        }
        clearOAuthPopupSessionCaches(popupSession);
        if (!resolved) {
          resolved = true;
          resolve({ success: false, error: 'Sign-in window closed by user.' });
        }
      });

      if (xboxInlineReq && xboxInlineReq.extraHeadersString) {
        authWindow.loadURL(targetAuthUrl, { extraHeaders: xboxInlineReq.extraHeadersString });
      } else {
        authWindow.loadURL(targetAuthUrl);
      }
    });
  });

  ipcMain.handle(
    'store:exchange-code',
    async (/** @type {any} */ _event, /** @type {{ storefrontId: string, code: string }} */ { storefrontId, code }) => {
      const res = await processStoreAuth(storefrontId, code);
      if (res && res.success) {
        try {
          launcherEngine?.clearStoreDisconnectedTombstone?.(storefrontId);
        } catch {}
      }
      return res;
    }
  );

  /** @type {Map<string, Promise<any>>} */
  const inFlightStoreSyncs = new Map();

  ipcMain.handle(
    'store:sync',
    async (
      /** @type {any} */ _event,
      /** @type {string} */ storefrontId,
      /** @type {Record<string, any> | undefined} */ fallbackCredentials
    ) => {
      const syncKey = String(storefrontId || '').toLowerCase().trim() || 'default';
      if (inFlightStoreSyncs.has(syncKey)) {
        return inFlightStoreSyncs.get(syncKey);
      }

      const syncPromise = (async () => {
        const savedTokens = storeSync.loadSavedTokens();
        let tokenData = savedTokens[storefrontId] || {};
        const cleanFallbackEpicToken = isRealSecretToken(fallbackCredentials?.epicToken)
          ? fallbackCredentials.epicToken.trim()
          : '';
        const cleanFallbackEpicRefresh = isRealSecretToken(fallbackCredentials?.epicRefreshToken)
          ? fallbackCredentials.epicRefreshToken.trim()
          : '';
        const cleanFallbackGogToken = isRealSecretToken(fallbackCredentials?.gogToken)
          ? fallbackCredentials.gogToken.trim()
          : '';

        if (
          !isRealSecretToken(tokenData.access_token) &&
          !isRealSecretToken(tokenData.xblAccessToken) &&
          !isRealSecretToken(tokenData.userStsLegacyTokenXml) &&
          !isRealSecretToken(tokenData.msaRefreshToken) &&
          !isRealSecretToken(tokenData.refresh_token) &&
          !isRealSecretToken(tokenData.webapi_token) &&
          !isRealSecretToken(tokenData.apiKey) &&
          !cleanFallbackEpicToken &&
          !cleanFallbackGogToken
        ) {
          return {
            success: false,
            error: `No saved credentials found for ${storefrontId}. Please connect in Settings.`,
          };
        }

        try {
          let accountName = 'Verified User';
          let avatarUrl;
          /** @type {any[]} */
          let games = [];

          if (storefrontId === 'steam') {
            accountName = tokenData.accountName || 'Steam User';
            avatarUrl = tokenData.avatarUrl;
            games = Array.isArray(tokenData.games) ? tokenData.games : [];
            let refreshedLive = false;

            if (tokenData.webapi_token && tokenData.steamId) {
              try {
                const res = await fetch(
                  `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?access_token=${encodeURIComponent(
                    tokenData.webapi_token
                  )}&steamid=${encodeURIComponent(tokenData.steamId)}&include_appinfo=1&include_played_free_games=1&include_free_sub=0`
                );
                if (res.ok) {
                  /** @type {{ response?: { games?: Array<{ appid?: number }> } } | null} */
                  const apiJson = /** @type {any} */ (await res.json());
                  if (Array.isArray(apiJson?.response?.games) && apiJson.response.games.length > 0) {
                    const ownedAppIds = apiJson.response.games
                      .map((/** @type {any} */ g) => g.appid)
                      .filter(Boolean);
                    const storeItems = await fetchSteamStoreBrowseItemsMap(ownedAppIds);
                    const refreshed = await parseSteamGamesListJson(
                      { rgGames: apiJson.response.games, storeItems, strProfileName: accountName },
                      tokenData.steamId,
                      accountName,
                      avatarUrl,
                      games,
                      storeSync
                    );
                    games = refreshed.games;
                    tokenData = { ...tokenData, games };
                    storeSync.saveTokens('steam', tokenData);
                    refreshedLive = true;
                  }
                }
              } catch {}
            }

            if (!refreshedLive) {
              try {
                const cleanBrowserUA = resolveCleanBrowserUserAgent(session);

                /** @type {{ rgGames: any[], storeItems: Record<string, any>, webApiToken?: string } | null} */
                let ssrResult = null;
                const steamOAuthPartition = resolveStorefrontOAuthPartition('steam');
                try {
                  const authSession =
                    session?.fromPartition?.(steamOAuthPartition) ||
                    session?.fromPartition?.('persist:storefront_auth');
                  if (authSession && typeof authSession.fetch === 'function') {
                    const fetchAbort = new AbortController();
                    const fetchTimer = setTimeout(() => fetchAbort.abort(), 10000);
                    try {
                      const ssrRes = await authSession.fetch(
                        'https://steamcommunity.com/my/games/?tab=all',
                        {
                          signal: fetchAbort.signal,
                          headers: {
                            'User-Agent': cleanBrowserUA,
                            Accept: 'text/html,application/xhtml+xml',
                          },
                        }
                      );
                      const resolvedSsrUrl = String(
                        ssrRes?.url || 'https://steamcommunity.com/my/games/?tab=all'
                      );
                      if (ssrRes && ssrRes.ok && isAuthenticatedSteamCommunityUrl(resolvedSsrUrl)) {
                        const html = await ssrRes.text();
                        const ssrMatch = html.match(
                          /<script\s+id=["']valve-ssr-data["'][^>]*>([\s\S]*?)<\/script>/i
                        );
                        if (ssrMatch && ssrMatch[1]) {
                          try {
                            const ssr = JSON.parse(ssrMatch[1].trim());
                            let webApiToken;
                            let rgGames = null;
                            /** @type {Record<string, any>} */
                            const storeItems = {};
                            const loaderData = Array.isArray(ssr?.loaderData) ? ssr.loaderData : [];
                            for (const item of loaderData) {
                              if (!item) continue;
                              try {
                                const parsed = typeof item === 'string' ? JSON.parse(item) : item;
                                if (parsed && parsed.strWebAPIToken && !webApiToken) {
                                  webApiToken = String(parsed.strWebAPIToken);
                                }
                              } catch {}
                            }
                            const rawQueryData = ssr?.renderContext?.queryData;
                            if (rawQueryData) {
                              try {
                                const qd =
                                  typeof rawQueryData === 'string'
                                    ? JSON.parse(rawQueryData)
                                    : rawQueryData;
                                const queries = Array.isArray(qd?.queries) ? qd.queries : [];
                                for (const q of queries) {
                                  const key = Array.isArray(q?.queryKey) ? q.queryKey : [];
                                  const data = q?.state?.data;
                                  if (!data) continue;
                                  if (key[0] === 'OwnedGames' && Array.isArray(data)) {
                                    rgGames = data;
                                  } else if (
                                    key[0] === 'StoreItem' &&
                                    typeof key[1] === 'string' &&
                                    key[1].startsWith('app_')
                                  ) {
                                    storeItems[key[1].replace('app_', '')] = data;
                                  }
                                }
                              } catch {}
                            }
                            if (Array.isArray(rgGames) && rgGames.length > 0) {
                              ssrResult = { rgGames, storeItems, webApiToken };
                            }
                          } catch {}
                        }
                        if (!ssrResult) {
                          const legacyMatch = html.match(/data-profile-gameslist="([^"]+)"/i);
                          if (legacyMatch && legacyMatch[1]) {
                            try {
                              const decoded = legacyMatch[1]
                                .replace(/&quot;/g, '"')
                                .replace(/&amp;/g, '&')
                                .replace(/&lt;/g, '<')
                                .replace(/&gt;/g, '>')
                                .replace(/&#039;/g, "'")
                                .replace(/&#39;/g, "'");
                              const parsedLegacy = JSON.parse(decoded);
                              if (
                                Array.isArray(parsedLegacy?.rgGames) &&
                                parsedLegacy.rgGames.length > 0
                              ) {
                                ssrResult = {
                                  rgGames: parsedLegacy.rgGames,
                                  storeItems: parsedLegacy.storeItems || {},
                                  webApiToken:
                                    parsedLegacy.strWebAPIToken || parsedLegacy.webapi_token,
                                };
                              }
                            } catch {}
                          }
                        }
                      }
                    } finally {
                      clearTimeout(fetchTimer);
                    }
                  }
                } catch {}

                if (ssrResult && Array.isArray(ssrResult.rgGames) && ssrResult.rgGames.length > 0) {
                  const refreshed = await parseSteamGamesListJson(
                    {
                      rgGames: ssrResult.rgGames,
                      strProfileName: accountName,
                      storeItems: ssrResult.storeItems || {},
                    },
                    tokenData.steamId,
                    accountName,
                    avatarUrl,
                    games,
                    storeSync
                  );
                  games = refreshed.games;
                  tokenData = {
                    ...tokenData,
                    webapi_token: ssrResult.webApiToken || tokenData.webapi_token,
                    games,
                  };
                  storeSync.saveTokens('steam', tokenData);
                  refreshedLive = true;
                }

                if (!refreshedLive && BrowserWindow) {
                  ssrResult = await new Promise((resolveSsr) => {
                    let done = false;
                    const bgWin = new BrowserWindow({
                      width: 1024,
                      height: 768,
                      show: false,
                      webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true,
                        sandbox: true,
                        partition: steamOAuthPartition,
                        userAgent: cleanBrowserUA,
                        images: false,
                        spellcheck: false,
                        backgroundThrottling: true,
                        v8CacheOptions: 'none',
                      },
                    });
                    const bgSession =
                      bgWin.webContents?.session ||
                      session?.fromPartition?.(steamOAuthPartition) ||
                      null;

                    /** @type {ReturnType<typeof setTimeout> | null} */
                    let timer = null;
                    /** @param {any} val */
                    const finish = (val) => {
                      if (done) return;
                      done = true;
                      if (timer) clearTimeout(timer);
                      clearOAuthPopupSessionCaches(bgSession);
                      try {
                        if (typeof storeSync.destroyScraperWindowCleanly === 'function') {
                          storeSync.destroyScraperWindowCleanly(bgWin);
                        } else if (bgWin && !bgWin.isDestroyed()) {
                          bgWin.destroy();
                        }
                      } catch {}
                      resolveSsr(val);
                    };

                    timer = setTimeout(() => finish(null), 12000);

                    bgWin.webContents.on('did-finish-load', async () => {
                      if (done || bgWin.isDestroyed()) return;
                      const currentUrl = bgWin.webContents.getURL();
                      if (!isAuthenticatedSteamCommunityUrl(currentUrl)) {
                        return;
                      }
                      try {
                        const extracted = await bgWin.webContents.executeJavaScript(
                          STEAM_SSR_BG_EXTRACTOR_SCRIPT
                        );
                        if (
                          extracted &&
                          Array.isArray(extracted.rgGames) &&
                          extracted.rgGames.length > 0
                        ) {
                          finish(extracted);
                        }
                      } catch {}
                    });

                    bgWin.loadURL('https://steamcommunity.com/my/games/?tab=all').catch(() => {
                      finish(null);
                    });
                  });

                  if (
                    ssrResult &&
                    Array.isArray(ssrResult.rgGames) &&
                    ssrResult.rgGames.length > 0
                  ) {
                    const refreshed = await parseSteamGamesListJson(
                      {
                        rgGames: ssrResult.rgGames,
                        strProfileName: accountName,
                        storeItems: ssrResult.storeItems || {},
                      },
                      tokenData.steamId,
                      accountName,
                      avatarUrl,
                      games,
                      storeSync
                    );
                    games = refreshed.games;
                    tokenData = {
                      ...tokenData,
                      webapi_token: ssrResult.webApiToken || tokenData.webapi_token,
                      games,
                    };
                    storeSync.saveTokens('steam', tokenData);
                    refreshedLive = true;
                  }
                }
              } catch {}
            }

            /** @type {Record<number, any>} */
            let steamAchMap = {};
            if (Array.isArray(games) && games.length > 0) {
              const localPlaytimes = await readLocalSteamPlaytimes();
              const appIds = games
                .map((g) =>
                  Number(
                    g.steamAppId ||
                      (String(g.id || '').startsWith('steam-')
                        ? String(g.id).replace('steam-', '')
                        : 0)
                  )
                )
                .filter((id) => id > 0);
              steamAchMap = await fetchSteamBatchAchievements(
                tokenData.webapi_token,
                tokenData.steamId,
                appIds
              );

              games = games.map((g) => {
                const appId = Number(
                  g.steamAppId ||
                    (String(g.id || '').startsWith('steam-')
                      ? String(g.id).replace('steam-', '')
                      : 0)
                );
                const localPt = appId ? localPlaytimes[appId] : null;
                const ach = appId ? steamAchMap[appId] : null;
                if ((!localPt || !localPt.playtimeMinutes) && !ach) {
                  return g.isVerifiedEntitlement === true ? g : { ...g, isVerifiedEntitlement: true };
                }
                return {
                  ...g,
                  isVerifiedEntitlement: true,
                  platforms: (g.platforms || []).map((/** @type {any} */ p) => {
                    if (p.platformId !== 'steam') return p;
                    const mergedPt =
                      localPt && localPt.playtimeMinutes
                        ? Math.max(Number(p.playtimeMinutes || 0), localPt.playtimeMinutes)
                        : Number(p.playtimeMinutes || 0);
                    const existingAch = p.achievements;
                    let mergedAch = existingAch;
                    if (ach && ach.total > 0) {
                      const bestUnlocked = existingAch
                        ? Math.max(ach.unlocked, Number(existingAch.unlocked || 0))
                        : ach.unlocked;
                      const bestTotal = existingAch
                        ? Math.max(ach.total, Number(existingAch.total || 0))
                        : ach.total;
                      const pct = bestTotal > 0 ? Math.round((bestUnlocked / bestTotal) * 100) : 0;
                      mergedAch = {
                        unlocked: bestUnlocked,
                        total: bestTotal,
                        percentage: pct,
                        isMastered:
                          Boolean(ach.isMastered) || (bestTotal > 0 && bestUnlocked >= bestTotal),
                      };
                    }
                    return {
                      ...p,
                      playtimeMinutes: mergedPt,
                      achievements: mergedAch,
                    };
                  }),
                };
              });
              tokenData = { ...tokenData, games };
              storeSync.saveTokens('steam', tokenData);
            }
            return {
              success: true,
              storefrontId,
              accountName,
              accountId: tokenData.steamId,
              avatarUrl,
              games,
              achievements: steamAchMap,
              suppressedItems:
                typeof storeSync.scanLocalSuppressedStorefrontItems === 'function'
                  ? storeSync
                      .scanLocalSuppressedStorefrontItems()
                      .filter((/** @type {any} */ x) => x.platformId === 'steam')
                  : [],
            };
          } else if (storefrontId === 'gog') {
            let accessToken =
              (isRealSecretToken(tokenData.access_token) ? tokenData.access_token : '') ||
              cleanFallbackGogToken;
            let accountId;
            try {
              if (!accessToken) {
                throw new Error('GOG access token missing');
              }
              const account = await storeSync.fetchGogAccount(accessToken);
              accountName = account.username || 'GOG User';
              accountId = account.userId;
              avatarUrl = account.avatarUrl;
              games = await storeSync.fetchGogOwnedGames(accessToken, accountName, account.userId);
            } catch (err) {
              if (isRealSecretToken(tokenData.refresh_token)) {
                const renewed = await storeSync.renewGogTokens(tokenData.refresh_token);
                accessToken = renewed.access_token;
                const account = await storeSync.fetchGogAccount(accessToken);
                accountName = account.username || 'GOG User';
                accountId = account.userId;
                avatarUrl = account.avatarUrl;
                games = await storeSync.fetchGogOwnedGames(
                  accessToken,
                  accountName,
                  account.userId
                );
              } else {
                throw err;
              }
            }
            const localGogSuppressed =
              typeof storeSync.scanLocalSuppressedStorefrontItems === 'function'
                ? storeSync
                    .scanLocalSuppressedStorefrontItems({ gogUserId: accountId })
                    .filter((/** @type {any} */ x) => x.platformId === 'gog')
                : [];
            const gogAuthoritativeComplete = Boolean(
              storeSync.fetchGogOwnedGames.lastAuthoritativeComplete
            );
            return {
              success: true,
              storefrontId,
              accountName,
              accountId,
              avatarUrl,
              games,
              authoritativeComplete: gogAuthoritativeComplete,
              transientOffline: games.length === 0 && !gogAuthoritativeComplete,
              achievements: storeSync.fetchGogOwnedGames.lastAchievementsMap || {},
              suppressedItems: [
                ...(storeSync.fetchGogOwnedGames.lastSuppressedItems || []),
                ...localGogSuppressed,
              ],
            };
          } else if (storefrontId === 'epic') {
            const epicDisconnected = Boolean(
              launcherEngine?.isStoreDisconnectedTombstoned?.('epic')
            );
            let accessToken =
              (isRealSecretToken(tokenData.access_token) ? tokenData.access_token : '') ||
              cleanFallbackEpicToken;
            let accountId = tokenData.account_id || fallbackCredentials?.epicAccountId;
            accountName = tokenData.displayName || accountId || 'Epic Games User';
            if (
              (!accessToken || !accountId) &&
              !epicDisconnected &&
              typeof launcherEngine?.ensureLegendaryConfigAndAuth === 'function'
            ) {
              try {
                const legAuth = await launcherEngine.ensureLegendaryConfigAndAuth();
                if (legAuth?.accessToken) {
                  accessToken = accessToken || legAuth.accessToken;
                  accountId = accountId || legAuth.accountId;
                  accountName = legAuth.displayName || accountName;
                }
              } catch {}
            }
            try {
              if (!accessToken) {
                throw new Error('Epic library API unauthorized (missing access token)');
              }
              games = await storeSync.fetchEpicOwnedGames(accessToken, accountId);
            } catch (err) {
              let recoveredSync = false;
              if (cleanFallbackEpicToken && cleanFallbackEpicToken !== accessToken) {
                try {
                  accessToken = cleanFallbackEpicToken;
                  games = await storeSync.fetchEpicOwnedGames(accessToken, accountId);
                  recoveredSync =
                    games.length > 0 ||
                    Boolean(storeSync.fetchEpicOwnedGames.lastAuthoritativeComplete);
                  storeSync.saveTokens('epic', {
                    ...tokenData,
                    access_token: accessToken,
                    refresh_token:
                      cleanFallbackEpicRefresh || tokenData.refresh_token,
                    account_id: accountId,
                  });
                } catch {
                  games = [];
                }
              }
              if ((!games || games.length === 0) && !recoveredSync) {
                const refreshCand =
                  cleanFallbackEpicRefresh ||
                  (isRealSecretToken(tokenData.refresh_token) ? tokenData.refresh_token : '');
                if (refreshCand) {
                  try {
                    const renewed = await storeSync.renewEpicTokens(refreshCand);
                    accessToken = renewed.access_token;
                    accountId = renewed.account_id || accountId;
                    accountName = renewed.displayName || accountName;
                    games = await storeSync.fetchEpicOwnedGames(accessToken, accountId);
                    recoveredSync =
                      games.length > 0 ||
                      Boolean(storeSync.fetchEpicOwnedGames.lastAuthoritativeComplete);
                  } catch {}
                }
                if (
                  (!games || games.length === 0) &&
                  !recoveredSync &&
                  !epicDisconnected &&
                  typeof launcherEngine?.ensureLegendaryConfigAndAuth === 'function'
                ) {
                  const recoveredLegAuth = await launcherEngine.ensureLegendaryConfigAndAuth({
                    forceTokenRefresh: true,
                  });
                  if (recoveredLegAuth?.accessToken) {
                    accessToken = recoveredLegAuth.accessToken;
                    accountId = recoveredLegAuth.accountId || accountId;
                    accountName = recoveredLegAuth.displayName || accountName;
                    games = await storeSync.fetchEpicOwnedGames(accessToken, accountId);
                  } else {
                    throw err;
                  }
                } else if ((!games || games.length === 0) && !recoveredSync) {
                  throw err;
                }
              }
            }
            const localEpicSuppressed =
              typeof storeSync.scanLocalSuppressedStorefrontItems === 'function'
                ? storeSync
                    .scanLocalSuppressedStorefrontItems({ epicAccountId: accountId })
                    .filter((/** @type {any} */ x) => x.platformId === 'epic')
                : [];
            const epicAuthoritativeComplete = Boolean(
              storeSync.fetchEpicOwnedGames.lastAuthoritativeComplete
            );
            return {
              success: true,
              storefrontId,
              accountName,
              accountId,
              avatarUrl,
              games,
              authoritativeComplete: epicAuthoritativeComplete,
              transientOffline: games.length === 0 && !epicAuthoritativeComplete,
              achievements: storeSync.fetchEpicOwnedGames.lastAchievementsMap || {},
              suppressedItems: [
                ...(storeSync.fetchEpicOwnedGames.lastSuppressedItems || []),
                ...localEpicSuppressed,
              ],
            };
          } else if (storefrontId === 'xbox') {
            const xboxSync = await storeSync.syncXboxLibrary({
              syncMode: fallbackCredentials?.syncMode,
              forceRefresh: Boolean(fallbackCredentials?.forceRefresh),
            });
            const xboxGames = xboxSync.games || [];
            const xboxAuthoritativeComplete = Boolean(xboxSync.authoritativeComplete);
            return {
              success: true,
              storefrontId,
              accountName: xboxSync.accountName,
              accountId: xboxSync.xuid,
              xuid: xboxSync.xuid,
              avatarUrl: xboxSync.avatarUrl,
              gamerscore: xboxSync.gamerscore || 0,
              subscription: xboxSync.subscription,
              syncMode: xboxSync.syncMode,
              authoritativeComplete: xboxAuthoritativeComplete,
              subscriptionChanged: Boolean(xboxSync.subscriptionChanged),
              transientOffline: xboxGames.length === 0 && !xboxAuthoritativeComplete,
              games: xboxGames,
              achievements: xboxSync.achievements || {},
              suppressedItems: xboxSync.suppressedItems || [],
            };
          }

          return { success: true, storefrontId, accountName, avatarUrl, games, achievements: {} };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, error: msg };
        }
      })().finally(() => {
        inFlightStoreSyncs.delete(syncKey);
        try {
          storeSync.trimStoreSyncMemory?.();
        } catch {}
      });

      inFlightStoreSyncs.set(syncKey, syncPromise);
      return syncPromise;
    }
  );

  const handleGetSavedStoreTokens = async () => {
    const rawLoaded = storeSync.loadSavedTokens() || {};
    /** @type {Record<string, any>} */
    let saved = { ...rawLoaded };

    if (
      (!saved.epic || !isRealSecretToken(saved.epic.access_token)) &&
      !launcherEngine?.isStoreDisconnectedTombstoned?.('epic') &&
      typeof launcherEngine?.ensureLegendaryConfigAndAuth === 'function'
    ) {
      try {
        const legAuth = await launcherEngine.ensureLegendaryConfigAndAuth();
        if (legAuth?.accessToken) {
          const reloaded = storeSync.loadSavedTokens() || saved;
          saved = { ...reloaded };
          if (!saved.epic || !isRealSecretToken(saved.epic.access_token)) {
            saved.epic = {
              ...(saved.epic || {}),
              access_token: legAuth.accessToken,
              refresh_token: legAuth.refreshToken || saved.epic?.refresh_token,
              account_id: legAuth.accountId || saved.epic?.account_id,
              displayName: legAuth.displayName || saved.epic?.displayName,
            };
          }
        }
      } catch {}
    }

    if (saved.gog && isRealSecretToken(saved.gog.access_token)) {
      let gogEntry = { ...saved.gog };
      const normalizedExisting =
        typeof storeSync.normalizeGogAvatarUrl === 'function'
          ? storeSync.normalizeGogAvatarUrl(gogEntry.avatarUrl, gogEntry.avatars)
          : gogEntry.avatarUrl;
      if (normalizedExisting && normalizedExisting !== gogEntry.avatarUrl) {
        gogEntry = { ...gogEntry, avatarUrl: normalizedExisting };
        storeSync.saveTokens('gog', gogEntry);
      }
      if (!gogEntry.avatarUrl || !gogEntry.username) {
        try {
          const account = await storeSync.fetchGogAccount(gogEntry.access_token);
          if (account) {
            gogEntry = {
              ...gogEntry,
              username: account.username || gogEntry.username,
              avatarUrl: account.avatarUrl || gogEntry.avatarUrl,
              user_id: account.userId || gogEntry.user_id,
            };
            storeSync.saveTokens('gog', gogEntry);
          }
        } catch {
          if (isRealSecretToken(gogEntry.refresh_token)) {
            try {
              const renewed = await storeSync.renewGogTokens(gogEntry.refresh_token);
              const account = await storeSync.fetchGogAccount(renewed.access_token);
              gogEntry = {
                ...gogEntry,
                ...renewed,
                username: account?.username || gogEntry.username,
                avatarUrl: account?.avatarUrl || gogEntry.avatarUrl,
                user_id: account?.userId || renewed.user_id || gogEntry.user_id,
              };
              storeSync.saveTokens('gog', gogEntry);
            } catch {}
          }
        }
      }
      saved.gog = gogEntry;
    }

    /** @type {Record<string, any>} */
    const projected = {};
    for (const [key, value] of Object.entries(saved)) {
      if (key === 'suppressedItems') continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const redactedEntry = sanitizeStoreTokenEntryForRenderer(key, value, storeSync);
        if (redactedEntry) {
          projected[key] = redactedEntry;
        }
      }
    }

    if (typeof storeSync.scanLocalSuppressedStorefrontItems === 'function') {
      try {
        projected.suppressedItems = storeSync.scanLocalSuppressedStorefrontItems();
      } catch {}
    }

    return projected;
  };
  ipcMain.handle('store:get-tokens', handleGetSavedStoreTokens);
  ipcMain.handle('store:get-saved-tokens', handleGetSavedStoreTokens);

  /**
   * @param {any} _event
   * @param {string | { storefrontId?: string, store?: string }} rawStorefrontArg
   */
  const handleClearStoreTokens = async (_event, rawStorefrontArg) => {
    const storefrontId =
      rawStorefrontArg && typeof rawStorefrontArg === 'object'
        ? rawStorefrontArg.storefrontId || rawStorefrontArg.store || ''
        : String(rawStorefrontArg || '');
    storeSync.clearTokens(storefrontId);
    try {
      launcherEngine?.purgeStoreHelperCredentials?.(storefrontId);
    } catch {}
    const partitionsToClear = [resolveStorefrontOAuthPartition(storefrontId)];
    if (storefrontId === 'xbox') {
      partitionsToClear.push('persist:auth_xbox');
    }
    for (const partName of partitionsToClear) {
      try {
        const targetSession = session?.fromPartition?.(partName);
        if (targetSession) {
          if (typeof targetSession.clearStorageData === 'function') {
            await targetSession.clearStorageData();
          }
          clearOAuthPopupSessionCaches(targetSession);
        }
      } catch {}
    }
    return { success: true };
  };

  ipcMain.handle('store:clear-tokens', handleClearStoreTokens);
  ipcMain.handle('store:clear-token', handleClearStoreTokens);
  ipcMain.handle('store:disconnect', handleClearStoreTokens);

  /**
   * @param {any} _event
   * @param {any} arg1
   * @param {any} arg2
   */
  const handleSaveStoreTokens = async (_event, arg1, arg2) => {
    const rawStorefrontId =
      arg1 && typeof arg1 === 'object' ? arg1.storefrontId || arg1.store : arg1;
    const rawTokenData =
      arg1 && typeof arg1 === 'object' ? arg1.tokenData || arg1.tokens || arg2 : arg2;
    const storefrontId = typeof rawStorefrontId === 'string' ? rawStorefrontId.trim() : '';
    if (
      !storefrontId ||
      storefrontId === '__proto__' ||
      storefrontId === 'constructor' ||
      storefrontId === 'prototype' ||
      !rawTokenData ||
      typeof rawTokenData !== 'object' ||
      Array.isArray(rawTokenData)
    ) {
      return { success: false, error: 'Invalid storefront token payload' };
    }
    const cleanIncoming = sanitizeLaunchConfigRecursive(rawTokenData);
    const existing = storeSync.loadSavedTokens()?.[storefrontId] || {};
    /** @type {Record<string, any>} */
    const merged = { ...existing };
    for (const [k, v] of Object.entries(cleanIncoming)) {
      if (SECRET_TOKEN_OBJECT_KEYS.has(k) && typeof v === 'string' && !isRealSecretToken(v)) {
        // Ignore renderer sentinel strings (`saved_in_electron`, `[REDACTED]`, etc.) so vaulted secrets stay intact
        continue;
      }
      merged[k] = v;
    }
    storeSync.saveTokens(storefrontId, merged);
    try {
      launcherEngine?.clearStoreDisconnectedTombstone?.(storefrontId);
    } catch {}
    return { success: true };
  };

  ipcMain.handle('store:save-tokens', handleSaveStoreTokens);
  ipcMain.handle('store:save-token', handleSaveStoreTokens);

  ipcMain.handle(
    'epic:fetch-achievements',
    async (
      /** @type {any} */ _event,
      /** @type {{ accountId?: string, accessToken?: string }} */ { accountId, accessToken } = {}
    ) => {
      try {
        const savedTokens = storeSync.loadSavedTokens();
        const savedEpic = savedTokens?.epic || {};
        let resolvedAccountId = accountId || savedEpic.account_id;
        let resolvedToken =
          (isRealSecretToken(accessToken) ? accessToken.trim() : '') ||
          (isRealSecretToken(savedEpic.access_token) ? savedEpic.access_token : '');
        if (
          (!resolvedToken || !resolvedAccountId) &&
          !launcherEngine?.isStoreDisconnectedTombstoned?.('epic') &&
          typeof launcherEngine?.ensureLegendaryConfigAndAuth === 'function'
        ) {
          try {
            const legAuth = await launcherEngine.ensureLegendaryConfigAndAuth();
            resolvedToken = resolvedToken || legAuth?.accessToken;
            resolvedAccountId = resolvedAccountId || legAuth?.accountId;
          } catch {}
        }
        let result = await storeSync.fetchEpicAchievements(resolvedToken, resolvedAccountId);
        if ((!result || Object.keys(result).length === 0) && savedEpic.refresh_token) {
          try {
            const renewed = await storeSync.renewEpicTokens(savedEpic.refresh_token);
            resolvedToken = renewed.access_token;
            resolvedAccountId = renewed.account_id || resolvedAccountId;
            result = await storeSync.fetchEpicAchievements(resolvedToken, resolvedAccountId);
          } catch {}
        }
        return result || {};
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC epic:fetch-achievements warning:', msg);
        return {};
      }
    }
  );

  ipcMain.handle(
    'epic:fetch-game-schema',
    async (/** @type {any} */ _event, /** @type {Record<string, any>} */ payload = {}) => {
      try {
        if (typeof storeSync.getEpicGameAchievementSchema === 'function') {
          return await storeSync.getEpicGameAchievementSchema(payload);
        }
        return [];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC epic:fetch-game-schema warning:', msg);
        return [];
      }
    }
  );

  ipcMain.handle(
    'store:fetch-epic-metadata',
    async (/** @type {any} */ _event, /** @type {Record<string, any>} */ payload = {}) => {
      try {
        return await storeSync.fetchEpicProductOfferMetadata(payload);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC store:fetch-epic-metadata warning:', msg);
        return null;
      }
    }
  );

  ipcMain.handle(
    'xbox:fetch-achievements',
    async (/** @type {any} */ _event, /** @type {Record<string, any>} */ payload = {}) => {
      try {
        if (typeof storeSync.fetchXboxAchievements === 'function') {
          return await storeSync.fetchXboxAchievements(payload);
        }
        return {};
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC xbox:fetch-achievements warning:', msg);
        return {};
      }
    }
  );

  ipcMain.handle(
    'xbox:fetch-game-schema',
    async (/** @type {any} */ _event, /** @type {Record<string, any>} */ payload = {}) => {
      try {
        if (typeof storeSync.getXboxGameAchievementSchema === 'function') {
          return await storeSync.getXboxGameAchievementSchema(payload);
        }
        return [];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC xbox:fetch-game-schema warning:', msg);
        return [];
      }
    }
  );

  ipcMain.handle(
    'store:get-achievements',
    async (/** @type {any} */ _event, /** @type {Record<string, any>} */ payload = {}) => {
      try {
        const platformId = String(payload?.platformId || payload?.storefrontId || '')
          .trim()
          .toLowerCase();
        if (platformId === 'xbox' && typeof storeSync.fetchXboxDetailedGameAchievements === 'function') {
          return await storeSync.fetchXboxDetailedGameAchievements(payload);
        }
        if (platformId === 'epic' && typeof storeSync.getEpicGameAchievementSchema === 'function') {
          const list = await storeSync.getEpicGameAchievementSchema(payload);
          return {
            storefrontId: 'epic',
            storefrontName: 'Epic Games',
            total: list.length,
            unlocked: list.filter((/** @type {any} */ a) => a.unlocked).length,
            percentage:
              list.length > 0
                ? Math.round(
                    (list.filter((/** @type {any} */ a) => a.unlocked).length / list.length) * 100
                  )
                : 0,
            isMastered:
              list.length > 0 && list.every((/** @type {any} */ a) => Boolean(a.unlocked)),
            achievements: list,
            source: 'local_cache',
          };
        }
        return null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC store:get-achievements warning:', msg);
        return null;
      }
    }
  );

  ipcMain.handle(
    'store:fetch-xbox-metadata',
    async (/** @type {any} */ _event, /** @type {Record<string, any>} */ payload = {}) => {
      try {
        if (typeof storeSync.fetchXboxProductOfferMetadata === 'function') {
          return await storeSync.fetchXboxProductOfferMetadata(payload);
        }
        return null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC store:fetch-xbox-metadata warning:', msg);
        return null;
      }
    }
  );

  ipcMain.handle(
    'store:xbox-get-status',
    async (/** @type {any} */ _event, /** @type {Record<string, any>} */ payload = {}) => {
      try {
        if (typeof storeSync.getXboxStatus === 'function') {
          return await storeSync.getXboxStatus(payload);
        }
        return { connected: false, syncMode: 'owned_and_played' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { connected: false, syncMode: 'owned_and_played', error: msg };
      }
    }
  );

  ipcMain.handle(
    'store:xbox-set-sync-mode',
    async (/** @type {any} */ _event, /** @type {any} */ arg) => {
      try {
        const rawMode =
          arg && typeof arg === 'object' ? arg.syncMode || arg.mode : String(arg || '');
        if (typeof storeSync.setXboxSyncMode === 'function') {
          return storeSync.setXboxSyncMode(rawMode);
        }
        return { success: false, error: 'setXboxSyncMode unavailable' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    }
  );

  ipcMain.handle(
    'gog:fetch-achievements',
    async (
      /** @type {any} */ _event,
      /** @type {{ username?: string, accessToken?: string, userId?: string }} */ {
        username,
        accessToken,
        userId,
      } = {}
    ) => {
      try {
        const savedTokens = storeSync.loadSavedTokens();
        const savedGog = savedTokens?.gog || {};
        let resolvedToken =
          (isRealSecretToken(accessToken) ? accessToken.trim() : '') ||
          (isRealSecretToken(savedGog.access_token) ? savedGog.access_token : '');
        let resolvedUsername = username;
        let resolvedUserId = userId || savedGog.user_id;

        if (resolvedToken) {
          try {
            const account = await storeSync.fetchGogAccount(resolvedToken);
            resolvedUsername = account.username || resolvedUsername;
            resolvedUserId = account.userId || resolvedUserId;
          } catch {
            if (isRealSecretToken(savedGog.refresh_token)) {
              try {
                const renewed = await storeSync.renewGogTokens(savedGog.refresh_token);
                resolvedToken = renewed.access_token;
                const account = await storeSync.fetchGogAccount(resolvedToken);
                resolvedUsername = account.username || resolvedUsername;
                resolvedUserId = account.userId || resolvedUserId;
              } catch {}
            }
          }
        }

        if (!resolvedUsername && !resolvedToken) return {};
        return await storeSync.fetchGogAchievements(resolvedToken, resolvedUsername, resolvedUserId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC gog:fetch-achievements warning:', msg);
        return {};
      }
    }
  );

  ipcMain.handle(
    'steam:fetch-achievements',
    async (
      /** @type {any} */ _event,
      /** @type {{ appIds?: Array<number | string> }} */ { appIds } = {}
    ) => {
      try {
        const savedTokens = storeSync.loadSavedTokens();
        const savedSteam = savedTokens?.steam || {};
        const resolvedAppIds =
          Array.isArray(appIds) && appIds.length > 0
            ? appIds
            : Array.isArray(savedSteam.games)
              ? savedSteam.games
                  .map((/** @type {any} */ g) => Number(g.steamAppId || 0))
                  .filter((/** @type {number} */ id) => id > 0)
              : [];
        const achievements = await fetchSteamBatchAchievements(
          savedSteam.webapi_token,
          savedSteam.steamId,
          resolvedAppIds
        );
        return {
          success: true,
          achievements,
          steamId: savedSteam.steamId,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg, achievements: {} };
      }
    }
  );

  ipcMain.handle('scan:steam-achievements', async () => {
    try {
      const achievements = await scanLocalSteamAchievements();
      return { success: true, achievements };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg, achievements: {} };
    }
  });

  ipcMain.handle('hltb:search', async (/** @type {any} */ _event, /** @type {unknown} */ gameTitle) => {
    if (!gameTitle || typeof gameTitle !== 'string') {
      return { success: false, data: [] };
    }

    try {
      const termPasses = buildHltbSearchTermPasses(gameTitle);
      if (termPasses.length === 0) return { success: false, data: [] };

      const cleanUa = resolveCleanBrowserUserAgent(session);
      let token = await getHltbToken(cleanUa);
      if (!token) return { success: false, error: 'Could not obtain HLTB token', data: [] };

      const baseWords = extractHltbBaseWords(termPasses[termPasses.length - 1]);

      /**
       * @param {string} authToken
       * @param {string[]} searchTerms
       */
      const executeSearch = async (authToken, searchTerms) =>
        fetch('https://howlongtobeat.com/api/search/site', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-auth-token': authToken,
            'User-Agent': cleanUa,
            Referer: 'https://howlongtobeat.com/',
          },
          body: JSON.stringify({
            searchType: 'games',
            searchTerms,
            searchPage: 1,
            size: 10,
            searchOptions: {
              games: {
                userId: 0,
                platform: '',
                sortCategory: 'popular',
                rangeCategory: 'main',
                rangeTime: { min: 0, max: 0 },
                gameplay: { perspective: '', flow: '', genre: '' },
                year: '',
                modifier: '',
              },
              users: { sortCategory: 'postcount' },
              lists: { sortCategory: 'follows' },
              filter: '',
              sort: 0,
              randomizer: 0,
            },
            useCache: true,
          }),
        });

      /** @type {unknown[] | null} */
      let fallbackNonEmpty = null;
      let refreshedTokenOnce = false;

      for (const searchTerms of termPasses) {
        if (!token) break;
        let searchRes = await executeSearch(token, searchTerms);
        if (searchRes.status === 403 && !refreshedTokenOnce) {
          refreshedTokenOnce = true;
          hltbCachedToken = null;
          token = await getHltbToken(cleanUa);
          if (token) {
            searchRes = await executeSearch(token, searchTerms);
          }
        }

        if (!searchRes.ok) {
          if (fallbackNonEmpty) {
            return { success: true, data: fallbackNonEmpty };
          }
          return { success: false, error: `HLTB status ${searchRes.status}`, data: [] };
        }

        /** @type {{ data?: Array<{ game_name?: unknown }> } | null} */
        const json = /** @type {any} */ (await searchRes.json());
        const items = Array.isArray(json?.data) ? json.data : [];
        if (items.length > 0) {
          if (
            baseWords.size === 0 ||
            items.some((item) => hltbCandidateSharesBaseWord(item?.game_name, baseWords))
          ) {
            return { success: true, data: items };
          }
          if (!fallbackNonEmpty) {
            fallbackNonEmpty = items;
          }
        }
      }

      return { success: true, data: fallbackNonEmpty || [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg, data: [] };
    }
  });

  ipcMain.handle(
    'igdb:fetch-cover',
    async (/** @type {any} */ _event, /** @type {string} */ gameTitle) => {
      try {
        return await storeSync.fetchIgdbCover(gameTitle);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('IPC igdb:fetch-cover warning:', msg);
        return null;
      }
    }
  );

  return {
    trimStoreSyncIpcMemory: trimSteamLocalScannerMemory,
  };
}

module.exports = {
  registerStoreSyncIpcHandlers,
  STORE_OAUTH_URLS,
  STOREFRONT_OAUTH_PARTITIONS,
  resolveStorefrontOAuthPartition,
  sanitizeStoreTokenEntryForRenderer,
  buildHltbSearchTermPasses,
};
