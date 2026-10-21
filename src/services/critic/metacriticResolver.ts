import { CriticScoreData, StorefrontReviewAnchor } from '../../contracts/critic';
import { calculateTier, isSequelMismatch, stripEditionSuffix } from './criticUtils';
import { ROMAN_TO_ARABIC, NUMERIC_SEQUELS, extractSequelIdentifier, normalizeTitleKey } from '../common/titleUtils';
import { requestScheduler, Priority } from '../network/requestScheduler';

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
    .replace(/['’ʼ`]/g, '')
    .replace(/\s*\((?:[^)]*,\s*)?((?:19|20)\d{2})[^)]*\)/g, ' $1')
    .replace(/\s*\([a-z0-9\s,]+\)/gi, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function stripMetacriticEditionSlug(slug: string): string {
  if (!slug) return '';
  let current = slug;
  for (let i = 0; i < 2; i++) {
    const next = current
      .replace(
        /-(the-)?(standard|deluxe|gold|silver|platinum|diamond|collectors|collector|ultimate|complete|special|limited|definitive|enhanced|extended|enchanted|anniversary|directors-cut|goty|game-of-the-year|remastered|remake|redux|emperor|gourmet|celebration|20-year-celebration|spacers-choice|classic-and-uncut|original)(-edition|-pack|-bundle|-collection|-cut)?$/i,
        ''
      )
      .replace(/-(edition|pack|bundle|collection)$/i, '');
    if (next === current) break;
    current = next;
  }
  return current;
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

const METACRITIC_STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'till', 'into', 'from',
  'standard', 'deluxe', 'gold', 'silver', 'platinum', 'diamond', 'collectors', 'collector', 'ultimate',
  'complete', 'special', 'limited', 'definitive', 'enhanced', 'anniversary', 'edition', 'remastered',
  'remake', 'directors', 'cut', 'legacy', 'classic', 'redux', 'extended', 'enchanted',
  'emperor', 'gourmet', 'celebration', 'spacers', 'choice', 'uncut', 'year', 'original', 'story',
  'digital', 'gog', 'steam', 'epic'
]);

const PURE_EDITION_WORDS = new Set([
  'edition', 'deluxe', 'gold', 'silver', 'platinum', 'diamond', 'goty', 'remastered', 'remake',
  'directors', 'cut', 'definitive', 'enhanced', 'anniversary', 'special', 'limited', 'standard',
  'classic', 'game', 'games', 'role', 'playing', 'rpg', 'post', 'nuclear', 'pack', 'bundle',
  'collection', 'complete', 'redux', 'extended', 'enchanted', 'emperor', 'gourmet', 'celebration',
  'spacers', 'choice', 'uncut', 'year', 'original', 'story', 'trials', 'ecto',
  'lightspeed', 'landmark', 'super', 'turbo', 'championship', 'unrated', 'anthology', 'telltale',
  'series', 'sid', 'meiers', 'meier', '20', '10', '25', '30',
  'digital', 'gog', 'steam', 'epic',
]);

/**
 * Validates whether a storefront Metacritic anchor slug is semantically compatible with the game title.
 * Normalizes episodic pilot suffixes (e.g. 'the-walking-dead-episode-1---a-new-day' -> 'the-walking-dead')
 * while blocking cross-sequel or cross-franchise anchor bleed.
 */
export function isAnchorSlugCompatible(title: string, rawAnchorSlug: string): boolean {
  if (!rawAnchorSlug) return false;
  const cleanAnchor = rawAnchorSlug
    .toLowerCase()
    .trim()
    .replace(/-episode-(?:1|one)\b.*$/i, '');
  const anchorWords = cleanAnchor.replace(/-/g, ' ');
  if (isSequelMismatch(title, anchorWords)) return false;
  if (isTitleCompatible(title, anchorWords)) return true;

  if (title.includes(' - ')) {
    const [mainPart, ...rest] = title.split(' - ');
    const subPart = rest.join(' ');
    if (
      mainPart.trim().length >= 4 &&
      !/\b(season|episode|part|chapter|book|act|mysteries|sith|testing|beta|deathmatch)\b/i.test(subPart) &&
      isTitleCompatible(mainPart.trim(), anchorWords)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Generates alternate slug variations based on systematic title patterns:
 * 1. Universal Edition stripping ('predator-hunting-grounds-standard-edition' -> 'predator-hunting-grounds')
 * 2. Release year suffix variations ('airship-kingdoms-adrift' <-> 'airship-kingdoms-adrift-2023', 'star-wars-battlefront-ii-2005')
 * 3. Acronym/Word + Digit concatenation & mid-numeral subtitle omission (e.g. 'deus-ex-2-invisible-war' -> 'deus-ex-invisible-war')
 * 4. Leading 'the-' toggling ('the-callisto-protocol' <-> 'callisto-protocol')
 * 5. Subtitle variations (only when suffix consists of edition/packaging tokens)
 * 6. Roman numerals <-> Arabic numerals ('-ii' <-> '-2', '-iii' <-> '-3')
 */
export function generateMetacriticSlugCandidates(
  title: string,
  releaseYear?: number | string | null,
  storefrontAnchor?: StorefrontReviewAnchor | null
): string[] {
  const clean = (title || '').trim();
  const base = toCanonicalMetacriticSlug(clean);
  const candidates: string[] = base ? [base] : [];

  if (!base && !storefrontAnchor?.metacriticSlug) return [];

  // Collapse dotted single-letter sequences (e.g. "S.T.A.L.K.E.R. 2: Heart of Chornobyl" -> "stalker-2-heart-of-chornobyl")
  const collapsedAcronym = clean.replace(/\b(?:[a-z]\.){2,}[a-z]?\.?/gi, (m) => m.replace(/\./g, ''));
  if (collapsedAcronym !== clean) {
    const collapsedSlug = toCanonicalMetacriticSlug(collapsedAcronym);
    if (collapsedSlug && collapsedSlug !== base) {
      candidates.push(collapsedSlug);
      const strippedCollapsed = stripMetacriticEditionSlug(collapsedSlug);
      if (strippedCollapsed && strippedCollapsed !== collapsedSlug) {
        candidates.push(strippedCollapsed);
      }
    }
    if (collapsedAcronym.includes(':')) {
      const collapsedBaseSlug = toCanonicalMetacriticSlug(collapsedAcronym.split(':')[0].trim());
      if (collapsedBaseSlug && !candidates.includes(collapsedBaseSlug)) {
        candidates.push(collapsedBaseSlug);
      }
    }
  }

  // 1. Universal Edition suffix stripping (prioritized as Candidate #2 immediately after base)
  const stripped = stripMetacriticEditionSlug(base);
  if (stripped && stripped !== base) {
    candidates.push(stripped);
  }

  // 2. Release year suffix variations
  const yrFromTitle = title.match(/\b(19\d\d|20\d\d)\b/)?.[1];
  const yrParam = releaseYear ? String(releaseYear).match(/\b(19\d\d|20\d\d)\b/)?.[1] : null;
  const yr = yrFromTitle || yrParam;

  if (yr) {
    if (!base.endsWith(yr)) {
      candidates.push(`${base}-${yr}`);
    } else {
      const baseNoYr = base.replace(new RegExp(`-${yr}$`), '');
      candidates.push(baseNoYr);
      const strippedNoYr = stripMetacriticEditionSlug(baseNoYr);
      if (strippedNoYr && strippedNoYr !== baseNoYr) {
        candidates.push(strippedNoYr);
      }
    }
    if (stripped && stripped !== base && !stripped.endsWith(yr)) {
      candidates.push(`${stripped}-${yr}`);
    }
  }

  if (stripped && stripped !== base) {
    if (/-\d+$/.test(stripped)) {
      candidates.push(stripped.replace(/-(\d+)$/, '$1'));
    }
    if (/-\d+-/.test(stripped)) {
      candidates.push(stripped.replace(/-(\d+)-/g, '-'));
    }
  }

  // Parenthetical subtitle stripping (e.g. 'Never Alone (Kisima Ingitchuna)' -> 'Never Alone' -> 'never-alone')
  const withoutParens = title.replace(/\s*\([^)]*\)/g, '').trim();
  if (withoutParens && withoutParens !== title) {
    const parenBase = toCanonicalMetacriticSlug(withoutParens);
    if (parenBase && parenBase !== base) {
      if (yr) {
        candidates.push(`${parenBase}-${yr}`);
      }
      candidates.push(parenBase);
    }
  }

  // 3. Acronym/Word + Digit concatenation & mid-numeral subtitle omission
  if (/-\d+$/.test(base)) {
    candidates.push(base.replace(/-(\d+)$/, '$1'));
  }
  if (/-\d+-/.test(base)) {
    candidates.push(base.replace(/-(\d+)-/g, '$1-'));
    // Mid-numeral subtitle omission (e.g. 'deus-ex-2-invisible-war' -> 'deus-ex-invisible-war')
    candidates.push(base.replace(/-(\d+)-/g, '-'));
  }

  // 4. Leading 'the-' toggling
  if (base.startsWith('the-')) {
    candidates.push(base.replace(/^the-/, ''));
  } else {
    candidates.push(`the-${base}`);
  }
  if (stripped && stripped !== base) {
    if (stripped.startsWith('the-')) {
      candidates.push(stripped.replace(/^the-/, ''));
    } else {
      candidates.push(`the-${stripped}`);
    }
  }

  // 5. Symbol expansion ('+' -> 'plus', '&' -> 'and')
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

  // 6. Subtitle splitting: only strip colon/dash suffix when it consists solely of edition/packaging words
  if (title.includes(':') || title.includes(' - ')) {
    const parts = title.split(/\s*:\s*|\s+-\s+/);
    const mainTitle = parts[0].trim();
    const suffixTokens = parts
      .slice(1)
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const isEditionSuffix =
      suffixTokens.length > 0 &&
      suffixTokens.every((t) => METACRITIC_STOP_WORDS.has(t) || PURE_EDITION_WORDS.has(t));
    if (mainTitle.length >= 3 && isEditionSuffix) {
      const mainSlug = toCanonicalMetacriticSlug(mainTitle);
      if (mainSlug && mainSlug !== base) {
        candidates.push(mainSlug);
      }
    }
  }

  // 7. Roman numeral <-> Arabic conversions
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
    if (rawAnchorSlug && isAnchorSlugCompatible(title, rawAnchorSlug)) {
      const prioritized: string[] = [rawAnchorSlug];
      if (base && base !== rawAnchorSlug) {
        prioritized.push(base);
      }
      if (stripped && stripped !== base && stripped !== rawAnchorSlug) {
        prioritized.push(stripped);
      }
      if (yr) {
        if (!rawAnchorSlug.endsWith(yr)) {
          prioritized.push(`${rawAnchorSlug}-${yr}`);
        }
        if (base && !base.endsWith(yr) && `${base}-${yr}` !== `${rawAnchorSlug}-${yr}`) {
          prioritized.push(`${base}-${yr}`);
        }
      }
      return Array.from(new Set([...prioritized, ...unique]));
    }
  }

  return unique;
}

function isViteBrowserDev(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.location !== 'undefined' &&
    window.location.protocol?.startsWith('http') &&
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
export async function searchMetacriticCandidates(
  query: string,
  priority: number = Priority.P1_VIEWPORT
): Promise<MetacriticSearchCandidate[]> {
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
    const res = await requestScheduler.schedule(
      url,
      () =>
        fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'application/json',
          },
          signal:
            typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
              ? AbortSignal.timeout(6000)
              : undefined,
        }),
      priority,
      'backend.metacritic.com'
    );

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

export async function searchMetacriticSlugs(
  query: string,
  priority: number = Priority.P1_VIEWPORT
): Promise<string[]> {
  const candidates = await searchMetacriticCandidates(query, priority);
  return candidates.map((c) => c.slug);
}

/**
 * Rigorously validates title compatibility between user library title and candidate Metacritic page title:
 * 1. Checks sequel numbers (via isSequelMismatch).
 * 2. Prevents explicit classic/original editions from matching modern remasters/enhanced editions.
 * 3. Prevents distinctive subtitle omissions across all subtitle segments.
 * 4. Enforces bidirectional substantive token conservation between query and candidate.
 */
export function isTitleCompatible(queryTitle: string, canonicalName: string): boolean {
  if (!canonicalName) return true;
  if (isSequelMismatch(queryTitle, canonicalName)) return false;

  // Guard against explicit Classic / Original / Gold editions matching modern Enhanced / Remastered / Remake / Reloaded editions
  const queryIsExplicitClassicOrOriginal =
    (/\b(classic|original|gold)\b/i.test(queryTitle) &&
      !/\boriginal\s+sin\b/i.test(queryTitle) &&
      !/\bclassics\b/i.test(queryTitle)) ||
    /\b\((?:classic|original)\)/i.test(queryTitle);
  if (
    queryIsExplicitClassicOrOriginal &&
    /\b(enhanced|remastered|remaster|remake|reloaded|redux|definitive)\b/i.test(canonicalName)
  ) {
    return false;
  }

  const norm = (s: string) => {
    let clean = s;
    for (const [char, rep] of Object.entries(SPECIAL_CHAR_TRANSLITERATION)) {
      clean = clean.replace(new RegExp(char, 'g'), ` ${rep} `);
    }
    return clean
      .toLowerCase()
      .replace(/\b(?:[a-z]\.){2,}[a-z]\.?/gi, (m) => m.replace(/\./g, ''))
      .replace(/[™®©]/g, '')
      .replace(/['’ʼ`]/g, '')
      .replace(/(\d),(\d)/g, '$1$2')
      .replace(/([a-z])(\d)/g, '$1 $2')
      .replace(/(\d)([a-z])/g, '$1 $2')
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 0 && !METACRITIC_STOP_WORDS.has(w))
      .map((w) => ROMAN_TO_ARABIC[w] || w);
  };

  const qTokens = norm(queryTitle);
  const cTokens = norm(canonicalName);

  if (qTokens.length === 0 || cTokens.length === 0) return true;

  // Must share at least one substantive token
  if (!qTokens.some((t) => cTokens.includes(t))) {
    return false;
  }

  // 1. Prevent distinctive subtitle omissions across every colon/dash/exclamation segment
  if (queryTitle.includes(':') || queryTitle.includes(' - ') || /!\s+\S/.test(queryTitle)) {
    const segments = queryTitle.split(/\s*[:!]\s*|\s+-\s+/).slice(1);
    const cleanCand = canonicalName
      .toLowerCase()
      .replace(/\b(?:[a-z]\.){2,}[a-z]\.?/gi, (m) => m.replace(/\./g, ''))
      .replace(/['’ʼ`]/g, '')
      .replace(/[^a-z0-9]/g, ' ');
    const candWords = cleanCand
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => ROMAN_TO_ARABIC[w] || w);

    for (const seg of segments) {
      const segWithoutParens = seg.replace(/\s*\([^)]*\)/g, '').trim();
      const rawSubTokens = segWithoutParens
        .toLowerCase()
        .replace(/\b(?:[a-z]\.){2,}[a-z]\.?/gi, (m) => m.replace(/\./g, ''))
        .replace(/['’ʼ`]/g, '')
        .replace(/[^a-z0-9]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 0 && !['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is'].includes(w))
        .map((w) => ROMAN_TO_ARABIC[w] || w);

      if (rawSubTokens.length >= 1 && !rawSubTokens.some((t) => candWords.includes(t))) {
        const isPureEdition = rawSubTokens.every((t) => PURE_EDITION_WORDS.has(t) || /^\d{4}$/.test(t));
        if (!isPureEdition) {
          return false;
        }
      }
    }
  }

  // 2. Bidirectional substantive token conservation:
  // Reject if query has extra non-edition substantive words outside parentheticals that are missing from candidate
  // (e.g. 'Godzilla Voxel Wars' -> 'Godzilla', 'Quake Champions' -> 'Quake', 'Quake II RTX' -> 'Quake II Enhanced Edition', 'Fallout Tactics' -> 'Fallout', 'Syndicate Wars' / 'Syndicate Plus' -> 'Syndicate')
  const queryWithoutParens = queryTitle
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\b(mega\s+drive\s*(?:&|and)?\s*)/gi, '')
    .trim();
  const qSubstantive = norm(queryWithoutParens).filter(
    (t) =>
      !PURE_EDITION_WORDS.has(t) &&
      !NUMERIC_SEQUELS.has(t) &&
      !/^\d{4}$/.test(t)
  );
  const qExtra = qSubstantive.filter((t) => !cTokens.includes(t));
  if (qExtra.length >= 1) {
    return false;
  }

  const qBaseStr =
    queryTitle.includes(':') || queryTitle.includes(' - ') || /!\s+\S/.test(queryTitle)
      ? queryTitle.split(/[:\-!]/)[0].trim()
      : queryTitle.replace(/\s*\([^)]*\)/g, '').trim();
  const qBase = norm(qBaseStr).filter(
    (t) => !PURE_EDITION_WORDS.has(t) && !/^\d{4}$/.test(t)
  );
  const hasEditionSuffix =
    stripEditionSuffix(queryTitle).trim().toLowerCase() !== normalizeTitleKey(queryTitle) ||
    /\b(definitive|complete|goty|game of the year|director'?s cut|ultimate|enhanced|anniversary|remastered|collection|anthology|gold|deluxe|special|royal|legendary|edition)\b/i.test(
      queryTitle
    );

  if (
    hasEditionSuffix &&
    qBase.length >= 1 &&
    qTokens.every((t) => cTokens.includes(t)) &&
    qBase.every((t, idx) => cTokens[idx] === t) &&
    (qBase.length > 1 || qBase[0].length >= 5 || extractSequelIdentifier(queryTitle) !== null)
  ) {
    return true;
  }

  const cBase = canonicalName.includes(':') || canonicalName.includes(' - ') || /!\s+\S/.test(canonicalName)
    ? canonicalName.split(/[:\-!]/)[0].trim()
    : canonicalName;

  const cBaseTokens = norm(cBase);

  // Reject if candidate base title has extra non-edition substantive words not in query title
  // (e.g. 'Metal Gear Solid Delta: Snake Eater' for 'Metal Gear Solid: Snake Eater', or 'Kingdom Come' for 'Kingdom: Classic')
  const cBaseExtra = cBaseTokens.filter(
    (t) =>
      !qTokens.includes(t) &&
      !PURE_EDITION_WORDS.has(t) &&
      !NUMERIC_SEQUELS.has(t) &&
      !/^\d{4}$/.test(t) &&
      !(t === 'plus' && queryTitle.includes('+'))
  );
  if (cBaseExtra.length >= 1) {
    return false;
  }

  // Reject if candidate has extra non-edition substantive words anywhere not in query
  // (e.g. 'Pool of Radiance: Ruins of Myth Drannor' for 'Pool of Radiance', 'RPG Maker WITH' for 'RPG Maker XP')
  const cExtra = cTokens.filter(
    (t) =>
      !qTokens.includes(t) &&
      !PURE_EDITION_WORDS.has(t) &&
      !NUMERIC_SEQUELS.has(t) &&
      !/^\d{4}$/.test(t) &&
      !(t === 'plus' && queryTitle.includes('+'))
  );
  const qBaseTokens = qBase.filter((t) => !NUMERIC_SEQUELS.has(t));
  const candidateHasSubtitle =
    canonicalName.includes(':') || canonicalName.includes(' - ') || /!\s+\S/.test(canonicalName);

  if (!candidateHasSubtitle) {
    if (cExtra.length >= 1) {
      return false;
    }
  } else {
    if (qBaseTokens.length >= 2 && cExtra.length >= 1) {
      return false;
    }
  }

  return true;
}

/**
 * Decodes HTML entities and filters out corrupted upstream Metacritic mobile-app spam descriptions.
 */
export function sanitizeMetacriticDescription(rawDesc: string | undefined, reviewCount: number): string {
  const fallback = `Metacritic consensus score based on ${reviewCount} critic reviews.`;
  if (!rawDesc || typeof rawDesc !== 'string') return fallback;

  const decoded = rawDesc
    .replace(/\s*\[(?:WiiWare|iOS|DSiWare|Xbox Live Arcade|PSN|AppStore|App Store)\]\s*/gi, ' ')
    .replace(/&#39;|&#x27;|&#8217;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&#34;|&#8220;|&#8221;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&amp;|&#38;/gi, '&')
    .replace(/&radic;/gi, '')
    .replace(/&ndash;|&#8211;/gi, '-')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (
    !decoded ||
    /^\s*\?[?\sA-Z]*\?/.test(decoded) ||
    /\b(slide your finger to link|you should download gnat squisher|download gnat squisher|squishing gnats|grinnell college|using openfeint|free coins everyday|wiiware download|coming to touch screen devices|available on the app store|swap firejewels|match 3 gem game|use your fingers to jump|school ground game to the digital age|touch-controlled platformer)\b/i.test(
      decoded
    )
  ) {
    return fallback;
  }

  return decoded;
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
    .replace(/['’ʼ`]/g, '')
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
  const anchorSlug = rawAnchorSlug && isAnchorSlugCompatible(query, rawAnchorSlug) ? rawAnchorSlug : undefined;

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
    storefrontAnchor?: StorefrontReviewAnchor | null,
    priority: number = Priority.P1_VIEWPORT
  ): Promise<MetacriticBundle> {
    const title = (rawTitle || '').trim();
    if (!title) return { critic: null, user: null };

    const rawAnchorSlug = storefrontAnchor?.metacriticSlug?.toLowerCase().trim();
    const anchorSlug = rawAnchorSlug && isAnchorSlugCompatible(title, rawAnchorSlug) ? rawAnchorSlug : undefined;
    const cacheKey = `${title.toLowerCase()}${releaseYear ? `:${releaseYear}` : ''}${anchorSlug ? `:${anchorSlug}` : ''}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey)!;
    }

    const titleWithoutParenYear = title.replace(/\s*\((?:19|20)\d{2}\)/g, '').trim();
    const queryHasExplicitFirstInstallment = /\b(?:1|i)\b/i.test(titleWithoutParenYear);
    const isExplicitRetroQuery =
      /\b(classic|original|plus|dos)\b/i.test(titleWithoutParenYear) &&
      !/\boriginal\s+sin\b/i.test(titleWithoutParenYear) &&
      !/\bclassics\b/i.test(titleWithoutParenYear);

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
              res = await requestScheduler.schedule(
                url,
                () =>
                  fetch(url, {
                    headers: {
                      'User-Agent':
                        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    },
                    signal:
                      typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
                        ? AbortSignal.timeout(6000)
                        : undefined,
                  }),
                priority,
                'metacritic.com'
              );
              if (res.ok || res.status === 404) break;
            } catch (e) {
              if (attempt === 0) {
                await new Promise((r) => setTimeout(r, 200));
              }
            }
          }

          if (!res || !res.ok) {
            if (
              isAnchor &&
              typeof storefrontAnchor?.metacriticScore === 'number' &&
              storefrontAnchor.metacriticScore > 0
            ) {
              return {
                id: `mc-${slug}`,
                source: 'metacritic',
                score: storefrontAnchor.metacriticScore,
                tier: calculateTier(storefrontAnchor.metacriticScore),
                numReviews: 20,
                url:
                  storefrontAnchor.metacriticUrl ||
                  `https://www.metacritic.com/game/${slug}/critic-reviews/`,
                summary: `Verified by official ${storefrontAnchor.storefront.toUpperCase()} store review anchor.`,
                isVerified: true,
                isSynthetic: false,
              };
            }
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
                const pageYearMatch = (
                  jsonLd.datePublished ||
                  jsonLd.dateCreated ||
                  html.match(/(?:datePublished|releaseDate|c-gameDetails_releaseDate)[^>]*?(\b(?:19\d\d|20\d\d)\b)/i)?.[1] ||
                  ''
                ).match(/\b(19\d\d|20\d\d)\b/);
                const pageYear = pageYearMatch ? parseInt(pageYearMatch[1], 10) : null;
                const titleYearStr = title.match(/\b(19\d\d|20\d\d)\b/)?.[1];
                const titleYear = titleYearStr ? parseInt(titleYearStr, 10) : null;
                const paramYearStr = !titleYear && releaseYear ? String(releaseYear).match(/\b(19\d\d|20\d\d)\b/)?.[1] : null;
                const paramYear = paramYearStr ? parseInt(paramYearStr, 10) : null;

                if (titleYear && pageYear && Math.abs(titleYear - pageYear) > 2) {
                  return null; // Reject reboot when year is explicitly in title
                }
                if (paramYear && paramYear <= 2020 && pageYear && Math.abs(paramYear - pageYear) >= 4) {
                  return null; // Reject reboot when known classic release year conflicts with modern page
                }

                // Guard against explicit first-installment or retro classic (e.g. "Alone in the Dark 1", "DOOM I", "Shadow Warrior Classic Complete") matching an unnumbered modern reboot
                if (
                  ((queryHasExplicitFirstInstallment &&
                    canonicalName &&
                    !/\b(?:1|i)\b/i.test(canonicalName)) ||
                    (isExplicitRetroQuery &&
                      canonicalName &&
                      !/\b(classic|original|plus|dos)\b/i.test(canonicalName))) &&
                  ((pageYear && pageYear >= 2008) ||
                    /\b(reimagination|reimagining|remake of the|modern reboot|reboot of the|completely remastered)\b/i.test(
                      jsonLd.description || ''
                    ))
                ) {
                  return null;
                }

                // Guard against franchise spinoff subtitle collisions on base-title review URLs
                const descText = jsonLd.description || '';
                const titleNoYear = title.replace(/\s*\((?:19|20)\d{2}\)/g, '').trim();
                const escapedBase = titleNoYear.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                if (escapedBase && !title.includes(':')) {
                  const spinoffColonRe = new RegExp(`\\b${escapedBase}:\\s+([A-Z][A-Za-z0-9'\\s-]{2,})`, 'i');
                  const spinoffMatch = descText.match(spinoffColonRe);
                  if (spinoffMatch?.[1]) {
                    const subLower = spinoffMatch[1].trim().toLowerCase();
                    if (subLower && !title.toLowerCase().includes(subLower)) {
                      return null;
                    }
                  }
                }

                const rating = jsonLd.aggregateRating;
                if (
                  rating &&
                  typeof rating.ratingValue === 'number' &&
                  rating.ratingValue > 0 &&
                  typeof rating.reviewCount === 'number' &&
                  rating.reviewCount >= 4
                ) {
                  const score = Math.round(rating.ratingValue);
                  if (
                    !isAnchor &&
                    typeof storefrontAnchor?.metacriticScore === 'number' &&
                    storefrontAnchor.metacriticScore > 0 &&
                    Math.abs(score - storefrontAnchor.metacriticScore) > 15
                  ) {
                    return null;
                  }
                  criticData = {
                    id: `mc-${slug}`,
                    source: 'metacritic',
                    score,
                    tier: calculateTier(score),
                    numReviews: rating.reviewCount,
                    url: `https://www.metacritic.com/game/${slug}/critic-reviews/`,
                    summary: sanitizeMetacriticDescription(jsonLd.description, rating.reviewCount),
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
                const pageYearMatch = html.match(/(?:datePublished|releaseDate|c-gameDetails_releaseDate)[^>]*?(\b(?:19\d\d|20\d\d)\b)/i);
                const pageYear = pageYearMatch ? parseInt(pageYearMatch[1], 10) : null;
                const titleYearStr = title.match(/\b(19\d\d|20\d\d)\b/)?.[1];
                const titleYear = titleYearStr ? parseInt(titleYearStr, 10) : null;
                const paramYearStr = !titleYear && releaseYear ? String(releaseYear).match(/\b(19\d\d|20\d\d)\b/)?.[1] : null;
                const paramYear = paramYearStr ? parseInt(paramYearStr, 10) : null;

                if (titleYear && pageYear && Math.abs(titleYear - pageYear) > 2) {
                  return null; // Reject reboot when year is explicitly in title
                }
                if (paramYear && paramYear <= 2020 && pageYear && Math.abs(paramYear - pageYear) >= 4) {
                  return null; // Reject reboot when known classic release year conflicts with modern page
                }
                if (
                  ((queryHasExplicitFirstInstallment &&
                    pageTitle &&
                    !/\b(?:1|i)\b/i.test(pageTitle)) ||
                    (isExplicitRetroQuery &&
                      pageTitle &&
                      !/\b(classic|original|plus|dos)\b/i.test(pageTitle))) &&
                  pageYear &&
                  pageYear >= 2008
                ) {
                  return null;
                }
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

      const testedSlugs = new Set<string>();

      // 1. If an anchor slug is present: evaluate anchor slug (with year suffix if query specifies year)
      const queryYr = title.match(/\b(19\d\d|20\d\d)\b/)?.[1];
      const primaryAnchorSlug = queryYr && anchorSlug && !anchorSlug.endsWith(queryYr)
        ? `${anchorSlug}-${queryYr}`
        : anchorSlug;

      if (primaryAnchorSlug) {
        testedSlugs.add(primaryAnchorSlug);
        const critic = await evaluateSlug(primaryAnchorSlug, true);
        if (critic) {
          const bundle: MetacriticBundle = { critic, user: fallbackUser };
          this.cache.set(cacheKey, bundle);
          return bundle;
        }
      }

      // 2. Limit candidate testing to the top 2 highest-probability slugs (or top 3 if release year is present)
      const hasYear = Boolean(
        (releaseYear && String(releaseYear).match(/\b(19\d\d|20\d\d)\b/)) ||
        title.match(/\b(19\d\d|20\d\d)\b/)
      );
      const candidateLimit = hasYear ? 3 : 2;
      const initialCandidates: string[] = [];
      for (const slug of slugs) {
        if (!testedSlugs.has(slug)) {
          initialCandidates.push(slug);
        }
        if (initialCandidates.length + testedSlugs.size >= candidateLimit) {
          break;
        }
      }

      for (const slug of initialCandidates) {
        testedSlugs.add(slug);
        const isAnchor = Boolean(anchorSlug && isAnchorMatch(slug, anchorSlug));
        const critic = await evaluateSlug(slug, isAnchor);
        if (critic) {
          const bundle: MetacriticBundle = { critic, user: fallbackUser };
          this.cache.set(cacheKey, bundle);
          return bundle;
        }
      }

      // 3. If no critic score found, query Metacritic backend finder search API to discover verified slugs
      try {
        let searchCandidates = await searchMetacriticCandidates(title, priority);
        let ranked = rankCandidateSlugs(title, searchCandidates, storefrontAnchor);
        const baseSlug = toCanonicalMetacriticSlug(title);
        const strippedSlug = stripMetacriticEditionSlug(baseSlug);
        if (ranked.length === 0 && strippedSlug && strippedSlug !== baseSlug) {
          const strippedQuery = strippedSlug.replace(/-/g, ' ');
          searchCandidates = await searchMetacriticCandidates(strippedQuery, priority);
          ranked = rankCandidateSlugs(strippedQuery, searchCandidates, storefrontAnchor);
        }
        const titleYearStr = title.match(/\b(19\d\d|20\d\d)\b/)?.[1];
        const titleYear = titleYearStr ? parseInt(titleYearStr, 10) : null;
        const paramYearStr = !titleYear && releaseYear ? String(releaseYear).match(/\b(19\d\d|20\d\d)\b/)?.[1] : null;
        const paramYear = paramYearStr ? parseInt(paramYearStr, 10) : null;

        for (const s of ranked.slice(0, 2)) {
          if (!testedSlugs.has(s)) {
            testedSlugs.add(s);
            const isAnchor = Boolean(anchorSlug && isAnchorMatch(s, anchorSlug));
            const critic = await evaluateSlug(s, isAnchor);
            if (critic) {
              const bundle: MetacriticBundle = { critic, user: fallbackUser };
              this.cache.set(cacheKey, bundle);
              return bundle;
            }
          }

          // Fallback to official Metacritic backend JSON API score if HTML scraping was blocked/failed
          const searchCand = searchCandidates.find((c) => c.slug === s);
          if (
            searchCand &&
            typeof searchCand.score === 'number' &&
            searchCand.score > 0 &&
            (!searchCand.title || isTitleCompatible(title, searchCand.title))
          ) {
            const candYearMatch = String(searchCand.releaseDate || '').match(/\b(19\d\d|20\d\d)\b/);
            const candYear = candYearMatch ? parseInt(candYearMatch[1], 10) : null;
            const candHasFirstInstallment = /\b(?:1|i)\b/i.test(searchCand.title || s.replace(/-/g, ' '));
            const candHasRetroKeyword = /\b(classic|original|plus|dos)\b/i.test(searchCand.title || s.replace(/-/g, ' '));
            const isRebootMismatch =
              ((queryHasExplicitFirstInstallment && !candHasFirstInstallment) ||
                (isExplicitRetroQuery && !candHasRetroKeyword)) &&
              Boolean(candYear && candYear >= 2008);
            const isYearMismatch = Boolean(
              (titleYear && candYear && Math.abs(titleYear - candYear) > 2) ||
              (paramYear && paramYear <= 2020 && candYear && Math.abs(paramYear - candYear) >= 4)
            );
            if (!isRebootMismatch && !isYearMismatch) {
              const jsonScore = Math.round(searchCand.score);
              const jsonCritic: CriticScoreData = {
                id: `mc-${s}`,
                source: 'metacritic',
                score: jsonScore,
                tier: calculateTier(jsonScore),
                numReviews: 20,
                url: `https://www.metacritic.com/game/${s}/critic-reviews/`,
                summary: `Metacritic consensus score based on critic reviews.`,
                isVerified: true,
                isSynthetic: false,
              };
              const bundle: MetacriticBundle = { critic: jsonCritic, user: fallbackUser };
              this.cache.set(cacheKey, bundle);
              return bundle;
            }
          }
        }
      } catch {}

      // 4. Final Storefront Anchor ground-truth fallback if HTML & backend search failed
      if (
        typeof storefrontAnchor?.metacriticScore === 'number' &&
        storefrontAnchor.metacriticScore > 0
      ) {
        const fallbackSlug =
          anchorSlug ||
          storefrontAnchor.metacriticSlug ||
          toCanonicalMetacriticSlug(title);
        if (fallbackSlug && isAnchorSlugCompatible(title, fallbackSlug)) {
          const anchorCritic: CriticScoreData = {
            id: `mc-${fallbackSlug}`,
            source: 'metacritic',
            score: storefrontAnchor.metacriticScore,
            tier: calculateTier(storefrontAnchor.metacriticScore),
            numReviews: 20,
            url:
              storefrontAnchor.metacriticUrl ||
              `https://www.metacritic.com/game/${fallbackSlug}/critic-reviews/`,
            summary: `Verified by official ${storefrontAnchor.storefront.toUpperCase()} store review anchor.`,
            isVerified: true,
            isSynthetic: false,
          };
          const bundle: MetacriticBundle = { critic: anchorCritic, user: fallbackUser };
          this.cache.set(cacheKey, bundle);
          return bundle;
        }
      }

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
    storefrontAnchor?: StorefrontReviewAnchor | null,
    priority: number = Priority.P1_VIEWPORT
  ): Promise<CriticScoreData | null> {
    const bundle = await this.resolveMetacritic(rawTitle, releaseYear, storefrontAnchor, priority);
    return bundle.critic;
  }

  /**
   * Resolves verified User score only.
   */
  async resolveUserScore(
    rawTitle: string,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null,
    priority: number = Priority.P1_VIEWPORT
  ): Promise<CriticScoreData | null> {
    const bundle = await this.resolveMetacritic(rawTitle, releaseYear, storefrontAnchor, priority);
    return bundle.user;
  }

  /**
   * Backward-compatible resolveScore: returns Critic score if available, otherwise User score.
   */
  async resolveScore(
    rawTitle: string,
    releaseYear?: number | string | null,
    storefrontAnchor?: StorefrontReviewAnchor | null,
    priority: number = Priority.P1_VIEWPORT
  ): Promise<CriticScoreData | null> {
    const bundle = await this.resolveMetacritic(rawTitle, releaseYear, storefrontAnchor, priority);
    return bundle.critic || bundle.user;
  }

  clearCache(): void {
    this.cache.clear();
    this.inFlight.clear();
  }
}

export const metacriticResolver = new MetacriticResolver();
