import { CriticTier } from '../../contracts/critic';

/**
 * Computes an authentic synthetic score calibrated from Steam positive review percentage.
 */
export function calculateSyntheticSteamScore(
  positivePercent: number,
  _totalReviews?: number
): {
  score: number;
  percentRecommended: number;
  tier: CriticTier;
} {
  const positive = Math.max(0, Math.min(100, Math.round(positivePercent)));
  let score: number;
  let percentRecommended: number;

  if (positive >= 95) {
    score = Math.min(95, 88 + Math.round((positive - 95) * 1.4));
    percentRecommended = Math.min(99, 92 + Math.round((positive - 95) * 1.4));
  } else if (positive >= 90) {
    score = 84 + Math.round((positive - 90) * 0.8);
    percentRecommended = 86 + Math.round((positive - 90) * 1.2);
  } else if (positive >= 80) {
    score = 77 + Math.round((positive - 80) * 0.7);
    percentRecommended = 74 + Math.round((positive - 80) * 1.2);
  } else if (positive >= 70) {
    score = 70 + Math.round((positive - 70) * 0.7);
    percentRecommended = 55 + Math.round((positive - 70) * 1.9);
  } else {
    score = Math.max(35, positive - 5);
    percentRecommended = Math.max(10, positive - 10);
  }

  const tier = calculateTier(score, percentRecommended);
  return { score, percentRecommended, tier };
}

/**
 * Calculates the tier rating according to OpenCritic / Metacritic standards.
 */
export function calculateTier(score: number, percentRecommended?: number): CriticTier {
  if (score >= 84 && (percentRecommended === undefined || percentRecommended >= 85)) {
    return 'Mighty';
  }
  if (score >= 74) return 'Strong';
  if (score >= 66) return 'Fair';
  return 'Weak';
}

/**
 * Returns Tailwind design tokens for styling critic badges according to tier.
 */
export function getTierColor(tier?: CriticTier) {
  switch (tier) {
    case 'Mighty':
      return {
        badgeBg: 'bg-[#3b1261]/90',
        badgeBorder: 'border-[#a855f7]/70',
        badgeText: 'text-[#d8b4fe]',
        scoreBg: 'bg-gradient-to-br from-[#9333ea] to-[#6b21a8]',
        accentText: 'text-[#c084fc]',
        glow: 'shadow-[0_0_16px_rgba(168,85,247,0.35)]',
        cardGlow: 'shadow-[0_0_20px_rgba(168,85,247,0.25)]',
      };
    case 'Strong':
      return {
        badgeBg: 'bg-[#064e3b]/90',
        badgeBorder: 'border-[#10b981]/70',
        badgeText: 'text-[#6ee7b7]',
        scoreBg: 'bg-gradient-to-br from-[#059669] to-[#047857]',
        accentText: 'text-[#34d399]',
        glow: 'shadow-[0_0_16px_rgba(16,185,129,0.35)]',
        cardGlow: 'shadow-[0_0_20px_rgba(16,185,129,0.25)]',
      };
    case 'Fair':
      return {
        badgeBg: 'bg-[#78350f]/90',
        badgeBorder: 'border-[#f59e0b]/70',
        badgeText: 'text-[#fde68a]',
        scoreBg: 'bg-gradient-to-br from-[#d97706] to-[#b45309]',
        accentText: 'text-[#fbbf24]',
        glow: 'shadow-[0_0_16px_rgba(245,158,11,0.35)]',
        cardGlow: 'shadow-[0_0_20px_rgba(245,158,11,0.25)]',
      };
    case 'Weak':
    default:
      return {
        badgeBg: 'bg-[#7f1d1d]/90',
        badgeBorder: 'border-[#ef4444]/70',
        badgeText: 'text-[#fca5a5]',
        scoreBg: 'bg-gradient-to-br from-[#dc2626] to-[#991b1b]',
        accentText: 'text-[#f87171]',
        glow: 'shadow-[0_0_16px_rgba(239,68,68,0.35)]',
        cardGlow: 'shadow-[0_0_20px_rgba(239,68,68,0.25)]',
      };
  }
}

/**
 * Normalizes title string for robust aggregator matching.
 */
export function normalizeCriticTitleKey(title: string): string {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strips edition suffixes (e.g. Definitive Edition, Deluxe, Gold, Remastered) for base title fallback.
 */
export function stripEditionSuffix(title: string): string {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(
      /\b(digital\s+)?(standard|deluxe|gold|silver|platinum|diamond|collector'?s|ultimate|complete|special|limited|definitive|enhanced|anniversary|director'?s cut|goty|game of the year|remastered|remake)\b.*$/i,
      ''
    )
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ROMAN_TO_ARABIC: Record<string, string> = {
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
  xi: '11',
  xii: '12',
  xiii: '13',
  xiv: '14',
  xv: '15',
  xvi: '16',
  xvii: '17',
  xviii: '18',
  xix: '19',
  xx: '20',
};

const NUMERIC_SEQUELS = new Set([
  '2', '3', '4', '5', '6', '7', '8', '9', '10',
  '11', '12', '13', '14', '15', '16', '17', '18', '19', '20'
]);

/**
 * Detects whether a search candidate is a numbered or Roman numeral sequel to prevent false-positive matching.
 * Handles both hyphenated/spaced ('MDK 2', 'Quake 2') and concatenated ('MDK2', 'Quake2') numeral boundaries.
 * Correctly permits mid-numeral subtitle omissions (e.g. 'Deus Ex 2: Invisible War' vs 'Deus Ex: Invisible War')
 * while strictly preventing true franchise sequel mismatches (e.g. 'Doom' vs 'Doom 2', 'Left 4 Dead' vs 'Left 4 Dead 2').
 */
export function isSequelMismatch(query: string, candidateName: string): boolean {
  const normalize = (str: string) =>
    str
      .toLowerCase()
      .replace(/(\d),(\d)/g, '$1$2')
      .replace(/([a-z])(\d)/g, '$1 $2')
      .replace(/(\d)([a-z])/g, '$1 $2')
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => ROMAN_TO_ARABIC[token] || token);

  const qTokens = normalize(query);
  const cTokens = normalize(candidateName);

  const otherVariants = new Set(['new', 'vr']);
  const stopWords = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'edition', 'game', 'classic', 'standard', 'deluxe']);

  for (const num of NUMERIC_SEQUELS) {
    const qHas = qTokens.includes(num);
    const cHas = cTokens.includes(num);
    if ((!qHas && cHas) || (qHas && !cHas)) {
      // If the number is part of an anniversary/celebration (e.g. '20 Year Celebration'), ignore
      if (num === '20' && (qTokens.includes('year') || cTokens.includes('year'))) continue;

      // Check if this is an intermediate numeral before a distinctive subtitle
      const hasNumeral = qHas ? qTokens : cTokens;
      const noNumeral = qHas ? cTokens : qTokens;
      const numIdx = hasNumeral.indexOf(num);
      const afterNum = hasNumeral.slice(numIdx + 1).filter((t) => !stopWords.has(t) && !NUMERIC_SEQUELS.has(t));

      const hasSubtitleSyntax =
        query.includes(':') ||
        query.includes(' - ') ||
        candidateName.includes(':') ||
        candidateName.includes(' - ');

      const subtitleMatches =
        afterNum.length >= (hasSubtitleSyntax ? 1 : 2) && afterNum.every((t) => noNumeral.includes(t));

      if (subtitleMatches) {
        continue; // Permitted subtitle match (e.g. Deus Ex 2: Invisible War vs Deus Ex: Invisible War)
      }
      return true;
    }
  }

  // Distinct numbers mismatch (e.g. 'THE KING OF FIGHTERS 2002' vs 'The King of Fighters-i 2012')
  const qAllNums = qTokens.filter((t) => /^\d+$/.test(t));
  const cAllNums = cTokens.filter((t) => /^\d+$/.test(t));
  if (qAllNums.length > 0 && cAllNums.length > 0) {
    const qHasDiff = qAllNums.some((n) => !cAllNums.includes(n));
    const cHasDiff = cAllNums.some((n) => !qAllNums.includes(n));
    if (qHasDiff && cHasDiff) {
      return true;
    }
  }

  for (const variant of otherVariants) {
    const qHas = qTokens.includes(variant);
    const cHas = cTokens.includes(variant);
    if ((!qHas && cHas) || (qHas && !cHas)) {
      return true;
    }
  }

  // Edition mismatch: prevent distinct remaster/remake releases from adopting original game reviews
  const editions = new Set(['remastered', 'remake']);
  for (const ed of editions) {
    const qHas = qTokens.includes(ed);
    const cHas = cTokens.includes(ed);
    if (qHas && !cHas) return true;
  }

  // Compilation/bundle mismatch: prevent dual game compilations (e.g. 'DOOM + DOOM II')
  // from erroneously resolving to a single component game (e.g. 'Doom II')
  if (/\s\+\s/.test(query) && !candidateName.toLowerCase().includes('+') && !candidateName.toLowerCase().includes('plus')) {
    return true;
  }
  return false;

}

