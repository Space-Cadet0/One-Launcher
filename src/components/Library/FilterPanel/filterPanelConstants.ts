import {
  CriticTierFilterOption,
  FeatureFilterOption,
  OsCompatibilityFilterOption,
  ReviewSentimentFilterOption,
} from '../../../contracts/filter';

export const OS_OPTIONS: readonly {
  id: OsCompatibilityFilterOption;
  label: string;
  sublabel: string;
}[] = [
  { id: 'mac_native', label: 'macOS Native', sublabel: 'Apple Silicon / Intel' },
  { id: 'windows_native', label: 'Windows Native', sublabel: 'PC Direct' },
  { id: 'mac_compat_layer', label: 'CrossOver / Wine (Mac)', sublabel: 'Compatibility Layer' },
];

export const CRITIC_TIER_OPTIONS: readonly {
  id: CriticTierFilterOption;
  label: string;
  range: string;
  badgeClass: string;
}[] = [
  {
    id: 'mighty',
    label: 'Mighty',
    range: '84+',
    badgeClass: 'border-amber-500/50 text-amber-300 bg-amber-500/10',
  },
  {
    id: 'strong',
    label: 'Strong',
    range: '74–83',
    badgeClass: 'border-purple-500/50 text-purple-300 bg-purple-500/10',
  },
  {
    id: 'fair',
    label: 'Fair',
    range: '66–73',
    badgeClass: 'border-sky-500/50 text-sky-300 bg-sky-500/10',
  },
  {
    id: 'weak',
    label: 'Weak',
    range: '<66',
    badgeClass: 'border-emerald-500/50 text-emerald-300 bg-emerald-500/10',
  },
];

export const MIN_SCORE_OPTIONS: readonly (number | null)[] = [null, 60, 70, 80, 90];

export const REVIEW_SENTIMENT_OPTIONS: readonly {
  id: ReviewSentimentFilterOption;
  label: string;
}[] = [
  { id: 'overwhelmingly_positive', label: 'Overwhelmingly Positive' },
  { id: 'very_positive', label: 'Very Positive' },
  { id: 'mostly_positive', label: 'Mostly Positive' },
  { id: 'mixed', label: 'Mixed' },
  { id: 'negative', label: 'Negative' },
];

export const FEATURE_OPTIONS: readonly {
  id: FeatureFilterOption;
  label: string;
}[] = [
  { id: 'singleplayer', label: 'Single-player' },
  { id: 'coop', label: 'Co-op' },
  { id: 'multiplayer', label: 'Multiplayer / PvP' },
  { id: 'controller', label: 'Controller Support' },
  { id: 'cloud_saves', label: 'Cloud Saves' },
  { id: 'achievements', label: 'Achievements' },
  { id: 'hdr', label: 'HDR' },
];

export const TAG_PREVIEW_LIMIT = 40;
