import { CriticScoreData, StorefrontReviewAnchor } from '../../contracts/critic';
import { calculateTier, isSequelMismatch } from './criticUtils';

export interface MetacriticBundle {
  critic: CriticScoreData | null;
  user: CriticScoreData | null;
}

export const SPECIAL_CHAR_TRANSLITERATION: Record<string, string> = {
  'Δ': 'delta',
  'δ': 'delta',
  'α': 'alpha',
  'β': 'beta',
  'γ': 'gamma',
  'λ': 'lambda',
  'ω': 'omega',
  'Ω': 'omega',
  'π': 'pi',
  'μ': 'mu',
  'σ': 'sigma',
  'Σ': 'sigma',
  'θ': 'theta',
  '½': 'half',
};

/**
 * Universal slug generator for Metacritic URLs.
 * Correctly strips punctuation, apostrophes, and noise while preserving edition specifics.
 */
export function toCanonicalMetacriticSlug(title: string): string {
  if (!title) return '';
  let clean = title;
  for (const [char, rep] of Object.entries(SPECIAL_CHAR_TRANSLITERATION)) {
    clean = clean.replace(new RegExp(char, 'g'), ` ${rep} `);
  }
  return clean
    .toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/['’]/g, '')
    .replace(/\s*\((?:[^)]*,\s*)?((?:19|20)\d{2})[^)]*\)/g, ' $1')
    .replace(/\s*\([a-z0-9\s,]+\)/gi, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Helper to check whether a candidate slug is compatible with or an alias of the storefront anchor slug.
 */
export function isAnchorMatch(candidateSlug: string, anchorSlug: string): boolean {
  const cSlug = candidateSlug.toLowerCase().trim();
  const aSlug = anchorSlug.toLowerCase().trim();
  if (cSlug === aSlug) return true;
  const aNorm = aSlug.replace(/-\d{4}$/, '').replace(/^the-/, '');
  const cNorm = cSlug.replace(/-\d{4}$/, '').replace(/^the-/, '');
  if (aNorm === cNorm) return true;
  const romanToArabic = (s: string) =>
    s
      .replace(/-ii-/g, '-2-').replace(/-ii$/, '-2')
      .replace(/-iii-/g, '-3-').replace(/-iii$/, '-3')
      .replace(/-iv-/g, '-4-').replace(/-iv$/, '-4')
      .replace(/-v-/g, '-5-').replace(/-v$/, '-5');
  return romanToArabic(aNorm) === romanToArabic(cNorm);
}

/**
 * Helper to determine if a candidate slug conflicts with the ground truth storefront anchor slug.
 */
export function isCandidateConflictingWithAnchor(candidateSlug: string, anchorSlug: string): boolean {
  return !isAnchorMatch(candidateSlug, anchorSlug);
}

/**
 * Generates alternate slug variations based on systematic title patterns:
 * 1. Acronym/Word + Digit concatenation & mid-numeral subtitle omission (e.g. 'deus-ex-2-invisible-war' -> 'deus-ex-invisible-war')
 * 2. Leading 'the-' toggling ('the-callisto-protocol' <-> 'callisto-protocol')
 * 3. Subtitle variations ('hitman-codename-47' <-> 'hitman')
 * 4. Universal Edition stripping ('predator-hunting-grounds-standard-edition' -> 'predator-hunting-grounds')
 * 5. Roman numerals <-> Arabic numerals ('-ii' <-> '-2', '-iii' <-> '-3')
 * 6. Release year suffix variations ('airship-kingdoms-adrift' <-> 'airship-kingdoms-adrift-2023', 'star-wars-battlefront-ii-2005')
 */
export function generateMetacriticSlugCandidates(
  title: string,
  releaseYear?: number | string | null,
  storefrontAnchor?: StorefrontReviewAnchor | null
): string[] {
  const base = toCanonicalMetacriticSlug(title);
  const candidates: string[] = base ? [base] : [];

  if (!base && !storefrontAnchor?.metacriticSlug) return [];

  // 1. Release year suffix variations (prioritize early if title mentions release year or releaseYear is passed)
  const yrFromTitle = title.match(/\b(19\d\d|20\d\d)\b/)?.[1];
  const yrParam = releaseYear ? String(releaseYear).match(/\b(19\d\d|20\d\d)\b/)?.[1] : null;
  const yr = yrFromTitle || yrParam;

  if (yr) {
    if (!base.endsWith(yr)) {
      candidates.push(`${base}-${yr}`);
    } else {
      candidates.push(base.replace(new RegExp(`-${yr}$`), ''));
    }
  }

  // Parenthetical subtitle stripping (e.g. 'Never Alone (Kisima Ingitchuna)' -> 'Never Alone' -> 'never-alone')
  const withoutParens = title.replace(/\s*\([^)]*\)/g, '').trim();
  if (withoutParens && withoutParens !== title) {
    const parenBase = toCanonicalMetacriticSlug(withoutParens);
    if (parenBase && parenBase !== base) {
      candidates.push(parenBase);
      if (yr) {
        candidates.push(`${parenBase}-${yr}`);
      }
    }
  }

  // 2. Acronym/Word + Digit concatenation & mid-numeral subtitle omission
  if (/-\d+$/.test(base)) {
    candidates.push(base.replace(/-(\d+)$/, '$1'));
  }
  if (/-\d+-/.test(base)) {
    candidates.push(base.replace(/-(\d+)-/g, '$1-'));
    // Mid-numeral subtitle omission (e.g. 'deus-ex-2-invisible-war' -> 'deus-ex-invisible-war')
    candidates.push(base.replace(/-(\d+)-/g, '-'));
  }

  // 3. Leading 'the-' toggling
  if (base.startsWith('the-')) {
    candidates.push(base.replace(/^the-/, ''));
  } else {
    candidates.push(`the-${base}`);
  }

  // 4. Symbol expansion ('+' -> 'plus', '&' -> 'and')
  if (title.includes('+')) {
    const withPlus = toCanonicalMetacriticSlug(title.replace(/\+/g, ' plus '));
    if (withPlus && withPlus !== base) {
      candidates.push(withPlus);
    }
  }
  if (title.includes('&')) {
    const withAnd = toCanonicalMetacriticSlug(title.replace(/&/g, ' and '));
    if (withAnd && withAnd !== base) {
      candidates.push(withAnd);
    }
  }

  // 5. Subtitle splitting (e.g. 'hitman-codename-47' -> 'hitman')
  if (title.includes(':') || title.includes(' - ')) {
    const mainTitle = title.split(/[:\-]/)[0].trim();
    if (mainTitle.length >= 3) {
      const mainSlug = toCanonicalMetacriticSlug(mainTitle);
      if (mainSlug && mainSlug !== base) {
        candidates.push(mainSlug);
      }
    }
  }

  // 6. Universal Edition suffix stripping (standard, deluxe, gold, silver, collector, goty, etc.)
  const stripped = base
    .replace(
      /-(standard|deluxe|gold|silver|platinum|diamond|collector'?s|ultimate|complete|special|limited|definitive|enhanced|anniversary|directors-cut|goty|game-of-the-year|remastered|remake)(-edition|-pack|-bundle|-collection)?$/i,
      ''
    )
    .replace(/-(edition|pack|bundle|collection)$/i, '');
  if (stripped && stripped !== base) {
    candidates.push(stripped);
    if (/-\d+$/.test(stripped)) {
      candidates.push(stripped.replace(/-(\d+)$/, '$1'));
    }
    if (/-\d+-/.test(stripped)) {
      candidates.push(stripped.replace(/-(\d+)-/g, '-'));
    }
  }

  // 6. Roman numeral <-> Arabic conversions
  if (base.includes('-ii-')) candidates.push(base.replace(/-ii-/g, '-2-'));
  if (base.endsWith('-ii')) candidates.push(base.replace(/-ii$/, '-2'));
  if (base.includes('-iii-')) candidates.push(base.replace(/-iii-/g, '-3-'));
  if (base.endsWith('-iii')) candidates.push(base.replace(/-iii$/, '-3'));
  if (base.includes('-iv-')) candidates.push(base.replace(/-iv-/g, '-4-'));
  if (base.endsWith('-iv')) candidates.push(base.replace(/-iv$/, '-4'));
  if (base.includes('-v-')) candidates.push(base.replace(/-v-/g, '-5-'));
  if (base.endsWith('-v')) candidates.push(base.replace(/-v$/, '-5'));

  if (base.includes('-2-')) candidates.push(base.replace(/-2-/g, '-ii-'));
  if (base.endsWith('-2')) candidates.push(base.replace(/-2$/, '-ii'));
  if (base.includes('-3-')) candidates.push(base.replace(/-3-/g, '-iii-'));
  if (base.endsWith('-3')) candidates.push(base.replace(/-3$/, '-iii'));
  if (base.includes('-4-')) candidates.push(base.replace(/-4-/g, '-iv-'));
  if (base.endsWith('-4')) candidates.push(base.replace(/-4$/, '-iv'));
  if (base.includes('-5-')) candidates.push(base.replace(/-5-/g, '-v-'));
  if (base.endsWith('-5')) candidates.push(base.replace(/-5$/, '-v'));
  const unique = Array.from(new Set(candidates));
  if (storefrontAnchor?.metacriticSlug) {
    const rawAnchorSlug = storefrontAnchor.metacriticSlug.toLowerCase().trim();
    if (rawAnchorSlug && isTitleCompatible(title, rawAnchorSlug.replace(/-/g, ' '))) {
      const anchorCandidates: string[] = [];
      if (yrFromTitle && !rawAnchorSlug.endsWith(yrFromTitle)) {
        anchorCandidates.push(`${rawAnchorSlug}-${yrFromTitle}`);
      }
      anchorCandidates.push(rawAnchorSlug);
      return Array.from(new Set([...anchorCandidates, ...unique]));
    }
  }

  return unique;
}

function isViteBrowserDev(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.location !== 'undefined' &&
    window.location.protocol.startsWith('http') &&
    (window.location.port === '3000' || window.location.port === '5173') &&
    typeof navigator !== 'undefined' &&
    !navigator.userAgent?.includes('jsdom') &&
    !navigator.userAgent?.includes('Node')
  );
}

export interface MetacriticSearchCandidate {
  slug: string;
  title?: string;
  score?: number | null;
  releaseDate?: string;
}

/**
 * Queries official Metacritic finder search API to discover release-year and alternative slugs.
 */
export async function searchMetacriticCandidates(query: string): Promise<MetacriticSearchCandidate[]> {
  try {
    const cleanQuery = query
      .replace(/[™®©]/g, '')
      .replace(/\s*\([^)]*\)/g, '')
      .replace(/[:\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanQuery) return [];

    const baseUrl = isViteBrowserDev()
      ? '/api/metacritic-backend'
      : 'https://backend.metacritic.com';

    const url = `${baseUrl}/finder/metacritic/search/${encodeURIComponent(cleanQuery)}/web?offset=0&limit=10&mcoTypeId=13`;
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
      signal:
        typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
          ? AbortSignal.timeout(6000)
          : undefined,
    });

    if (!res.ok) return [];
    const data = await res.json();
    const items = data?.data?.items || [];
    const candidates: MetacriticSearchCandidate[] = [];
    for (const item of items) {
      if (item?.slug && typeof item.slug === 'string') {
        candidates.push({
          slug: item.slug,
          title: item.title,
          score: typeof item.criticScoreSummary?.score === 'number' ? item.criticScoreSummary.score : null,
          releaseDate: item.releaseDate,
        });
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

export async function searchMetacriticSlugs(query: string): Promise<string[]> {
  const candidates = await searchMetacriticCandidates(query);
  return candidates.map((c) => c.slug);
}

const METACRITIC_STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'till', 'into', 'from', 'with',
  'standard', 'deluxe', 'gold', 'silver', 'platinum', 'diamond', 'collectors', 'collector', 'ultimate',
  'complete', 'special', 'limited', 'definitive', 'enhanced', 'anniversary', 'edition', 'remastered',
  'remake', 'directors', 'cut', 'legacy', 'classic', 'reloaded'
]);

/**
 * Rigorously validates title compatibility between user library title and candidate Metacritic page title:
 * 1. Checks sequel numbers (via isSequelMismatch).
 * 2. Prevents distinctive subtitle omissions (e.g. 'METAL GEAR SOLID Δ: SNAKE EATER' -> 'Metal Gear Solid').
 * 3. Prevents short queries from matching completely different multi-word titles
 *    (e.g. 'Kingdom: Classic' -> 'Kingdom Come: Deliverance').
 */
export function isTitleCompatible(queryTitle: string, canonicalName: string): boolean {
  if (!canonicalName) return true;
  if (isSequelMismatch(queryTitle, canonicalName)) return false;

  const norm = (s: string) => {
    let clean = s;
    for (const [char, rep] of Object.entries(SPECIAL_CHAR_TRANSLITERATION)) {
      clean = clean.replace(new RegExp(char, 'g'), ` ${rep} `);
    }
    return clean
      .toLowerCase()
      .replace(/[™®©]/g, '')
      .replace(/(\d),(\d)/g, '$1$2')
      .replace(/([a-z])(\d)/g, '$1 $2')
      .replace(/(\d)([a-z])/g, '$1 $2')
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 0 && !METACRITIC_STOP_WORDS.has(w));
  };


  const qTokens = norm(queryTitle);
  const cTokens = norm(canonicalName);

  if (qTokens.length === 0 || cTokens.length === 0) return true;

  // Must share at least one substantive token
  if (!qTokens.some((t) => cTokens.includes(t))) {
    return false;
  }

  // 1. Prevent distinctive subtitle omissions
  // If query title has a distinct subtitle (e.g. 'Snake Eater', 'Classic') but candidate canonical name has none of its words
  if (queryTitle.includes(':') || queryTitle.includes(' - ')) {
    const subtitlePart = queryTitle.split(/[:\-]/).slice(1).join(' ').trim();
    const rawSubTokens = subtitlePart
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 0 && !['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is'].includes(w));

    const cleanCand = canonicalName.toLowerCase().replace(/[^a-z0-9]/g, ' ');
    const candWords = cleanCand.split(/\s+/).filter(Boolean);
    if (rawSubTokens.length >= 1 && !rawSubTokens.some((t) => candWords.includes(t))) {
      // Allow general edition terms (deluxe, gold, goty, remastered, remake, enhanced, anniversary) to match base game
      const isPureEdition = rawSubTokens.every((t) =>
        [
          'edition',
          'deluxe',
          'gold',
          'silver',
          'goty',
          'remastered',
          'remake',
          'directors',
          'cut',
          'definitive',
          'enhanced',
          'anniversary',
          'special',
          'limited',
          'standard',
          'classic',
          'game',
          'role',
          'playing',
          'rpg',
          'post',
          'nuclear',
          'pack',
          'bundle',
          'collection',
          'complete',
        ].includes(t)
      );
      if (!isPureEdition) {
        return false;
      }
    }
  }

  // 2. Base title compatibility:
  // Extract base title (before colon or hyphen) for both query and candidate
  const qBase = queryTitle.includes(':') || queryTitle.includes(' - ')
    ? queryTitle.split(/[:\-]/)[0].trim()
    : queryTitle;
  const cBase = canonicalName.includes(':') || canonicalName.includes(' - ')
    ? canonicalName.split(/[:\-]/)[0].trim()
    : canonicalName;

  const qBaseTokens = norm(qBase);
  const cBaseTokens = norm(cBase);

  // If candidate base title has extra substantive words not in query title, reject!
  // e.g. candidate base 'Kingdom Come' has 'come' not in query 'Kingdom: Classic'
  const cBaseExtra = cBaseTokens.filter((t) => !qTokens.includes(t) && !/^\d{4}$/.test(t));
  if (cBaseExtra.length >= 1 && qBaseTokens.length <= 2) {
    return false;
  }

  // If candidate has no colon/subtitle and has extra substantive words compared to query, reject!
  // e.g. query 'Kingdom' vs candidate 'Kingdom Come Deliverance'
  if (!canonicalName.includes(':') && !canonicalName.includes(' - ')) {
    const cExtra = cTokens.filter((t) => !qTokens.includes(t) && !/^\d{4}$/.test(t));
    if (qTokens.length === 1 && cExtra.length >= 1) {
      return false;
    }
    if (qTokens.length <= 2 && cExtra.length >= 2) {
      return false;
    }
  }

  return true;
}

/**
 * Filters and ranks discovered search slugs against the original query to prevent sequel/variant mismatches.
 */
export function rankCandidateSlugs(
  query: string,
  candidateSlugs: Array<string | MetacriticSearchCandidate>,
  storefrontAnchor?: StorefrontReviewAnchor | null
): string[] {
  const clean = query
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[:\-]/g, ' ')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const qTokens = clean.split(' ').filter((t) => t.length > 0 && !METACRITIC_STOP_WORDS.has(t));

  const normalized: MetacriticSearchCandidate[] = candidateSlugs.map((c) =>
    typeof c === 'string' ? { slug: c, score: null } : c
  );

  const rawAnchorSlug = storefrontAnchor?.metacriticSlug?.toLowerCase().trim();
  const anchorSlug = rawAnchorSlug && isTitleCompatible(query, rawAnchorSlug.replace(/-/g, ' ')) ? rawAnchorSlug : undefined;

  // Rule 4: If storefrontAnchor is present, veto conflicting candidates and place anchor match at index 0
  if (anchorSlug) {
    const nonConflicting = normalized.filter((c) => !isCandidateConflictingWithAnchor(c.slug, anchorSlug));
    const queryYr = query.match(/\b(19\d\d|20\d\d)\b/)?.[1];

    nonConflicting.sort((a, b) => {
      if (queryYr) {
        const aYearMatch = a.slug.toLowerCase().trim() === `${anchorSlug}-${queryYr}` ? 1 : 0;
        const bYearMatch = b.slug.toLowerCase().trim() === `${anchorSlug}-${queryYr}` ? 1 : 0;
        if (bYearMatch !== aYearMatch) return bYearMatch - aYearMatch;
      }

      const aExact = a.slug.toLowerCase().trim() === anchorSlug ? 1 : 0;
      const bExact = b.slug.toLowerCase().trim() === anchorSlug ? 1 : 0;
      if (bExact !== aExact) return bExact - aExact;

      const aMatch = isAnchorMatch(a.slug, anchorSlug) ? 1 : 0;
      const bMatch = isAnchorMatch(b.slug, anchorSlug) ? 1 : 0;
      return bMatch - aMatch;
    });

    return nonConflicting.map(({ slug }) => slug);
  }

  return normalized
    .filter((c) => {
      const { slug } = c;
      const slugWithoutYear = slug.replace(/-\d{4}$/, '');
      const slugTitle = slugWithoutYear.replace(/-/g, ' ');
      if (isSequelMismatch(query, slugTitle)) {
        return false;
      }

      if (c.title) {
        if (!isTitleCompatible(query, c.title)) {
          return false;
        }
      } else {
        const sTokens = slugWithoutYear.split('-').filter((t) => t.length > 0 && !METACRITIC_STOP_WORDS.has(t));
        const nonStopSTokens = sTokens.filter((t) => !METACRITIC_STOP_WORDS.has(t) && !/^\d{4}$/.test(t));
        const sExtraSubstantive = nonStopSTokens.filter((t) => !qTokens.includes(t));
        if (qTokens.length === 1 && sExtraSubstantive.length >= 1) {
          return false;
        }
        if (sExtraSubstantive.length >= 2 && qTokens.length <= 2 && query.includes(':')) {
          return false;
        }
      }

      const sTokens = slugWithoutYear.split('-').filter((t) => t.length > 0 && !METACRITIC_STOP_WORDS.has(t));
      if (qTokens.length > 0 && sTokens.length > 0) {
        if (qTokens[0] !== sTokens[0] && !sTokens.includes(qTokens[0])) {
          return false;
        }
      }

      // Prevent distinct franchise entries with disjoint substantive words (e.g. 'wrath' vs 'rise')
      const qDisjoint = qTokens.filter((t) => !sTokens.includes(t) && t.length >= 3);
      const sDisjoint = sTokens.filter((t) => !qTokens.includes(t) && t.length >= 3);
      if (qDisjoint.length > 0 && sDisjoint.length > 0) {
        return false;
      }

      const overlap = qTokens.filter((t) => sTokens.includes(t));
      const qRatio = qTokens.length > 0 ? overlap.length / qTokens.length : 0;
      const sRatio = sTokens.length > 0 ? overlap.length / sTokens.length : 0;

      return (qRatio >= 0.65 || sRatio === 1) && overlap.length >= Math.min(1, qTokens.length);
    })

    .sort((a, b) => {
      const aWithoutYear = a.slug.replace(/-\d{4}$/, '');
      const bWithoutYear = b.slug.replace(/-\d{4}$/, '');
      const aTokens = aWithoutYear.split('-').filter((t) => t.length > 0 && !METACRITIC_STOP_WORDS.has(t));
      const bTokens = bWithoutYear.split('-').filter((t) => t.length > 0 && !METACRITIC_STOP_WORDS.has(t));
      const aOverlap = qTokens.filter((t) => aTokens.includes(t)).length;
      const bOverlap = qTokens.filter((t) => bTokens.includes(t)).length;
      const aRatio = aTokens.length > 0 ? aOverlap / aTokens.length : 0;
      const bRatio = bTokens.length > 0 ? bOverlap / bTokens.length : 0;

      if (Math.abs(bRatio - aRatio) > 0.1) {
        return bRatio - aRatio;
      }

      // Prioritize candidates with verified scores in Metacritic search
      const aHasScore = typeof a.score === 'number' && a.score > 0 ? 1 : 0;
      const bHasScore = typeof b.score === 'number' && b.score > 0 ? 1 : 0;
      if (bHasScore !== aHasScore) {
        return bHasScore - aHasScore;
      }

      return bRatio - aRatio;
    })
    .map(({ slug }) => slug);
}

export class MetacriticResolver {
  private cache = new Map<string, MetacriticBundle>();
  private inFlight = new Map<string, Promise<MetacriticBundle>>();

  /**
   * Resolves both Critic Metascore and User Score for a game title in a single request pass.
   */
  async resolveMetacritic(
    rawTitle: string,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null
  ): Promise<MetacriticBundle> {
    const title = (rawTitle || '').trim();
    if (!title) return { critic: null, user: null };

    const rawAnchorSlug = storefrontAnchor?.metacriticSlug?.toLowerCase().trim();
    const anchorSlug = rawAnchorSlug && isTitleCompatible(title, rawAnchorSlug.replace(/-/g, ' ')) ? rawAnchorSlug : undefined;
    const cacheKey = `${title.toLowerCase()}${releaseYear ? `:${releaseYear}` : ''}${anchorSlug ? `:${anchorSlug}` : ''}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey)!;
    }

    const promise = (async (): Promise<MetacriticBundle> => {
      const slugs = generateMetacriticSlugCandidates(title, releaseYear, storefrontAnchor);
      let fallbackUser: CriticScoreData | null = null;

      const evaluateSlug = async (slug: string, isAnchor = false): Promise<CriticScoreData | null> => {
        const url = isViteBrowserDev()
          ? `/api/metacritic/game/${slug}/`
          : `https://www.metacritic.com/game/${slug}/`;

        try {
          let res: Response | null = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              res = await fetch(url, {
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                signal:
                  typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
                    ? AbortSignal.timeout(6000)
                    : undefined,
              });
              if (res.ok || res.status === 404) break;
            } catch (e) {
              if (attempt === 0) {
                await new Promise((r) => setTimeout(r, 200));
              }
            }
          }

          if (!res || !res.ok) {
            return null;
          }

          const html = await res.text();

          // 1. Critic extraction from JSON-LD Schema
          let criticData: CriticScoreData | null = null;
          const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
          if (jsonLdMatch) {
            try {
              const jsonLd = JSON.parse(jsonLdMatch[1]);
              const canonicalName = jsonLd.name || '';
              // When evaluating storefrontAnchor, treat it as verified ground truth (bypasses title compatibility heuristic)
              if (isAnchor || !canonicalName || isTitleCompatible(title, canonicalName)) {
                const rating = jsonLd.aggregateRating;
                if (
                  rating &&
                  typeof rating.ratingValue === 'number' &&
                  rating.ratingValue > 0 &&
                  typeof rating.reviewCount === 'number' &&
                  rating.reviewCount >= 4
                ) {
                  const score = Math.round(rating.ratingValue);
                  criticData = {
                    id: `mc-${slug}`,
                    source: 'metacritic',
                    score,
                    tier: calculateTier(score),
                    numReviews: rating.reviewCount,
                    url: `https://www.metacritic.com/game/${slug}/critic-reviews/`,
                    summary:
                      jsonLd.description ||
                      `Metacritic consensus score based on ${rating.reviewCount} critic reviews.`,
                    isVerified: true,
                    isSynthetic: false,
                  };
                }
              }
            } catch {}
          }

          // Fallback: Critic extraction directly from Metacritic HTML markup (e.g. for /critic-reviews/ pages)
          if (!criticData) {
            const metaScoreMatch = html.match(
              /class="[^"]*c-siteReviewScore_large[^"]*"[^>]*title="Metascore\s+([0-9]+)\s+out\s+of\s+100"/i
            );

            if (metaScoreMatch && metaScoreMatch[1]) {
              const pageTitleMatch = html.match(/<title>([^<]+)<\/title>/i);
              const pageTitle = pageTitleMatch ? pageTitleMatch[1] : '';
              if (isAnchor || !pageTitle || isTitleCompatible(title, pageTitle)) {
                const rawScore = parseInt(metaScoreMatch[1], 10);
                if (!isNaN(rawScore) && rawScore > 0 && rawScore <= 100) {
                  criticData = {
                    id: `mc-${slug}`,
                    source: 'metacritic',
                    score: rawScore,
                    tier: calculateTier(rawScore),
                    numReviews: 20,
                    url: `https://www.metacritic.com/game/${slug}/critic-reviews/`,
                    summary: `Metacritic consensus score based on critic reviews.`,
                    isVerified: true,
                    isSynthetic: false,
                  };
                }
              }
            }
          }

          // 2. User Score extraction from HTML
          let userData: CriticScoreData | null = null;
          const userScoreMatch =
            html.match(/(?:title|aria-label)=["']User score ([0-9.]+) out of 10["']/i) ||
            html.match(/data-testid="global-score-value">([0-9.]+)<\/span>/i) ||
            html.match(/c-siteReviewScore_user[^\"]*\"[^>]*><span>([0-9.]+)<\/span>/i) ||
            html.match(/class=\"[^\"]*c-siteReviewScore_user[^\"]*\"[^>]*title=\"User score ([0-9.]+)/i);

          const userCountMatch =
            html.match(/Based on\s+([0-9,]+)\s+User (?:Ratings|Reviews)/i) ||
            html.match(/(?:Based on|based on)[^<]{0,50}([0-9,]+)\s+User (?:Ratings|Reviews)/i) ||
            html.match(/>([0-9,]+)\s+User Reviews</i) ||
            html.match(/([0-9,]+)\s+User Reviews/i);

          if (userScoreMatch && userScoreMatch[1]) {
            const rawScore = parseFloat(userScoreMatch[1]);
            const rawCount = userCountMatch && userCountMatch[1]
              ? parseInt(userCountMatch[1].replace(/,/g, ''), 10)
              : 0;

            if (!isNaN(rawScore) && rawScore > 0 && rawScore <= 10 && rawCount >= 4) {
              const normalizedScore = Math.round(rawScore * 10);
              userData = {
                id: `mc-user-${slug}`,
                source: 'metacritic_user',
                score: normalizedScore,
                userScoreRaw: rawScore,
                tier: calculateTier(normalizedScore),
                numReviews: rawCount,
                url: `https://www.metacritic.com/game/${slug}/`,
                summary: `Metacritic user score (${rawScore}/10 based on ${rawCount} user reviews).`,
                isVerified: false,
                isSynthetic: false,
              };
            }
          }

          if (criticData) {
            if (userData && !fallbackUser) {
              fallbackUser = userData;
            }
            return criticData;
          }

          if (userData && !fallbackUser) {
            fallbackUser = userData;
          }
        } catch {
          if (isAnchor && typeof storefrontAnchor?.metacriticScore === 'number' && storefrontAnchor.metacriticScore > 0) {
            return {
              id: `mc-${slug}`,
              source: 'metacritic',
              score: storefrontAnchor.metacriticScore,
              tier: calculateTier(storefrontAnchor.metacriticScore),
              numReviews: 20,
              url: storefrontAnchor.metacriticUrl || `https://www.metacritic.com/game/${slug}/critic-reviews/`,
              summary: `Verified by official ${storefrontAnchor.storefront.toUpperCase()} store review anchor.`,
              isVerified: true,
              isSynthetic: false,
            };
          }
        }
        return null;
      };

      // 1. Evaluate generated static permutation candidates
      for (const slug of slugs) {
        const isAnchor = Boolean(anchorSlug && isAnchorMatch(slug, anchorSlug));
        const critic = await evaluateSlug(slug, isAnchor);
        if (critic) {
          const bundle: MetacriticBundle = { critic, user: fallbackUser };
          this.cache.set(cacheKey, bundle);
          return bundle;
        }
      }

      // 2. If no critic score found, query Metacritic backend finder to discover year-aliased or subtitle slugs
      try {
        const searchCandidates = await searchMetacriticCandidates(title);
        const ranked = rankCandidateSlugs(title, searchCandidates, storefrontAnchor);
        for (const s of ranked) {
          if (!slugs.includes(s)) {
            const isAnchor = Boolean(anchorSlug && isAnchorMatch(s, anchorSlug));
            const critic = await evaluateSlug(s, isAnchor);
            if (critic) {
              const bundle: MetacriticBundle = { critic, user: fallbackUser };
              this.cache.set(cacheKey, bundle);
              return bundle;
            }
          }
        }
      } catch {}

      // If no critic data was found across all candidates, return fallback user score (or null)
      const finalBundle: MetacriticBundle = { critic: null, user: fallbackUser };
      this.cache.set(cacheKey, finalBundle);
      return finalBundle;
    })().finally(() => {
      this.inFlight.delete(cacheKey);
    });

    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Resolves verified Critic score only.
   */
  async resolveCriticScore(
    rawTitle: string,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null
  ): Promise<CriticScoreData | null> {
    const bundle = await this.resolveMetacritic(rawTitle, releaseYear, storefrontAnchor);
    return bundle.critic;
  }

  /**
   * Resolves verified User score only.
   */
  async resolveUserScore(
    rawTitle: string,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null
  ): Promise<CriticScoreData | null> {
    const bundle = await this.resolveMetacritic(rawTitle, releaseYear, storefrontAnchor);
    return bundle.user;
  }

  /**
   * Backward-compatible resolveScore: returns Critic score if available, otherwise User score.
   */
  async resolveScore(
    rawTitle: string,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null
  ): Promise<CriticScoreData | null> {
    const bundle = await this.resolveMetacritic(rawTitle, releaseYear, storefrontAnchor);
    return bundle.critic || bundle.user;
  }

  clearCache(): void {
    this.cache.clear();
    this.inFlight.clear();
  }
}

export const metacriticResolver = new MetacriticResolver();
