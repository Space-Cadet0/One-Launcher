import { STOREFRONT_REGISTRY, type StorefrontId } from '../../contracts/platform';
import { mapFeatureKeyword, type FeatureFilterOption } from '../../contracts/filter';

export const FEATURE_DESCRIPTOR_PATTERNS: ReadonlyArray<{
  feature: FeatureFilterOption;
  pattern: RegExp;
}> = [
  { feature: 'singleplayer', pattern: /single-?player/i },
  { feature: 'coop', pattern: /\bco-?op\b|coop/i },
  {
    feature: 'multiplayer',
    pattern: /multi-?player|\bpvp\b|online pvp|lan pvp|cross-platform multiplayer/i,
  },
  { feature: 'controller', pattern: /controller|gamepad/i },
  { feature: 'cloud_saves', pattern: /steam cloud|cloud saves?|\bcloud\b/i },
  { feature: 'achievements', pattern: /achievements?/i },
  { feature: 'hdr', pattern: /\bhdr\b/i },
];

/**
 * Extracts normalized `FeatureFilterOption` capabilities from an array of already
 * ownership-normalized tag/category descriptors.
 */
export function extractFeaturesFromDescriptors(
  descriptors: readonly string[],
  targetSet: Set<FeatureFilterOption> = new Set<FeatureFilterOption>()
): Set<FeatureFilterOption> {
  for (const raw of descriptors) {
    if (!raw) continue;
    for (const { feature, pattern } of FEATURE_DESCRIPTOR_PATTERNS) {
      if (pattern.test(raw)) {
        targetSet.add(feature);
      }
    }
  }
  return targetSet;
}

/**
 * Maps a raw user/chip feature query string into a canonical `FeatureFilterOption` if recognized.
 */
export function matchFeatureOptionFromTarget(target: string): FeatureFilterOption | null {
  return mapFeatureKeyword(target);
}

/**
 * Returns true only when `controllerSupport` represents real controller support
 * (explicitly rejecting `'none'`, `'false'`, empty strings, and non-truthy values).
 */
export function isValidControllerSupportValue(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 && normalized !== 'none' && normalized !== 'false' && normalized !== 'no';
}

const STOREFRONT_FILTER_ALIASES: Readonly<Record<string, StorefrontId>> = {
  steam: 'steam',
  'steam store': 'steam',
  gog: 'gog',
  'gog galaxy': 'gog',
  'gog.com': 'gog',
  epic: 'epic',
  'epic games': 'epic',
  'epic games store': 'epic',
  egs: 'epic',
  amazon: 'amazon',
  'amazon prime': 'amazon',
  'amazon games': 'amazon',
  'prime gaming': 'amazon',
  xbox: 'xbox',
  'xbox game pass': 'xbox',
  'xbox / game pass': 'xbox',
  'pc game pass': 'xbox',
  'game pass': 'xbox',
  'microsoft store': 'xbox',
  ubisoft: 'ubisoft',
  'ubisoft connect': 'ubisoft',
  uplay: 'ubisoft',
  ea: 'ea',
  'ea app': 'ea',
  'ea play': 'ea',
  'electronic arts': 'ea',
  origin: 'ea',
  bnet: 'bnet',
  'battle.net': 'bnet',
  battlenet: 'bnet',
  blizzard: 'bnet',
  itch: 'itch',
  'itch.io': 'itch',
  rockstar: 'rockstar',
  'rockstar games': 'rockstar',
  'rockstar games launcher': 'rockstar',
  humble: 'humble',
  'humble bundle': 'humble',
  custom: 'custom',
  'custom / drm-free': 'custom',
  'drm-free': 'custom',
};

/**
 * Resolves a platform filter value to its exact canonical `StorefrontId` using exact
 * registry lookup and explicit aliases (never substring `.includes()`, preventing
 * `"steam".includes("ea")` from leaking EA App games into Steam filters!).
 */
export function resolveCanonicalStorefrontAlias(rawTarget: string): StorefrontId | null {
  const normalized = (rawTarget || '').trim().toLowerCase();
  if (!normalized) return null;
  if (Object.hasOwn(STOREFRONT_REGISTRY, normalized)) {
    return normalized as StorefrontId;
  }
  if (Object.hasOwn(STOREFRONT_FILTER_ALIASES, normalized)) {
    return STOREFRONT_FILTER_ALIASES[normalized];
  }
  return null;
}
