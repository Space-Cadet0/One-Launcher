// @ts-check
'use strict';

const { resolveCleanBrowserUserAgent } = require('./oauthPopupWindows.cjs');

const MAX_HLTB_QUERY_LENGTH = 200;
const HLTB_FETCH_TIMEOUT_MS = 10_000;

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
      signal: AbortSignal.timeout(HLTB_FETCH_TIMEOUT_MS),
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
    if (
      /\s+windows(?:\s*10|\s*11)?$/i.test(cur) &&
      !HLTB_NATURAL_WINDOWS_PREDECESSOR_RE.test(cur)
    ) {
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
  let working = stripHltbTrademarksAndPlatformNoise(rawTitle.slice(0, MAX_HLTB_QUERY_LENGTH));
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
 * Input is bounded to `MAX_HLTB_QUERY_LENGTH` (200 chars) to prevent regex backtracking.
 *
 * @param {string} rawTitle
 * @returns {string[][]}
 */
function buildHltbSearchTermPasses(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') return [];
  const boundedTitle = rawTitle.trim().slice(0, MAX_HLTB_QUERY_LENGTH);
  if (!boundedTitle) return [];

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

  addPass(sanitizeHltbSearchClause(boundedTitle, { stripEditions: false, splitHyphens: false }));
  addPass(sanitizeHltbSearchClause(boundedTitle, { stripEditions: true, splitHyphens: true }));

  const preCleaned = stripHltbTrademarksAndPlatformNoise(boundedTitle);
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
    stripHltbTrademarksAndPlatformNoise(candidateName.slice(0, MAX_HLTB_QUERY_LENGTH))
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
 * Register the `hltb:search` IPC handler with query length capping (`<= 200` chars) and
 * `AbortSignal.timeout(10000)` on both token-init and search HTTP requests.
 *
 * @param {{ ipcMain: any, session: any }} deps
 */
function registerHltbSearchIpcHandler({ ipcMain, session }) {
  ipcMain.handle(
    'hltb:search',
    async (/** @type {any} */ _event, /** @type {unknown} */ gameTitle) => {
      if (!gameTitle || typeof gameTitle !== 'string') {
        return { success: false, data: [] };
      }

      const boundedTitle = gameTitle.trim().slice(0, MAX_HLTB_QUERY_LENGTH);
      if (!boundedTitle) {
        return { success: false, data: [] };
      }

      try {
        const termPasses = buildHltbSearchTermPasses(boundedTitle);
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
            signal: AbortSignal.timeout(HLTB_FETCH_TIMEOUT_MS),
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
    }
  );
}

module.exports = {
  MAX_HLTB_QUERY_LENGTH,
  HLTB_FETCH_TIMEOUT_MS,
  getHltbToken,
  buildHltbSearchTermPasses,
  extractHltbBaseWords,
  hltbCandidateSharesBaseWord,
  registerHltbSearchIpcHandler,
};
