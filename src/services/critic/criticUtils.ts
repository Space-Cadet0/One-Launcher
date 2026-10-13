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

import {
  normalizeTitleKey,
  stripEditionSuffix as commonStripEditionSuffix,
  isSequelMismatch as commonIsSequelMismatch,
  ROMAN_TO_ARABIC,
} from '../common/titleUtils';

export { ROMAN_TO_ARABIC };

/**
 * Normalizes title string for robust aggregator matching.
 */
export function normalizeCriticTitleKey(title: string): string {
  return normalizeTitleKey(title);
}

/**
 * Strips edition suffixes (e.g. Definitive Edition, Deluxe, Gold, Remastered) for base title fallback.
 */
export function stripEditionSuffix(title: string): string {
  return commonStripEditionSuffix(title);
}

/**
 * Detects whether a search candidate is a numbered or Roman numeral sequel to prevent false-positive matching.
 */
export function isSequelMismatch(query: string, candidateName: string): boolean {
  return commonIsSequelMismatch(query, candidateName);
}

