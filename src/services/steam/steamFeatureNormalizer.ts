import { SteamCategory } from '../../contracts/steam';

/**
 * Steam-exclusive category IDs that are proprietary to the Steam ecosystem
 * and are inapplicable/inaccessible for game copies owned strictly on other storefronts (Epic, GOG, Xbox).
 */
export const STEAM_EXCLUSIVE_CATEGORY_IDS = new Set<number>([
  8,  // Valve Anti-Cheat enabled (VAC)
  16, // Includes Source SDK
  29, // Steam Trading Cards
  30, // Steam Workshop
  40, // SteamVR Collectibles
  41, // Remote Play on Phone
  42, // Remote Play on Tablet
  43, // Remote Play on TV
  44, // Remote Play Together
  51, // Steam Workshop (secondary ID)
  59, // Steam Input API Support
  62, // Family Sharing
  63, // Steam Timeline
]);

/**
 * Text patterns for Steam-exclusive features to safely sanitize tags and text descriptors.
 */
const STEAM_EXCLUSIVE_PATTERNS = [
  /^steam workshop$/i,
  /^family sharing$/i,
  /^remote play/i,
  /^steam trading cards$/i,
  /^steam timeline$/i,
  /^steamvr collectibles$/i,
  /^steam input/i,
  /^valve anti-cheat/i,
];

/**
 * Rebranding mapping for cross-store features that Steam prefixes with its own brand name.
 */
export const CATEGORY_REBRAND_MAP: Record<number, string> = {
  22: 'Achievements', // "Steam Achievements" -> "Achievements"
  23: 'Cloud Saves',   // "Steam Cloud" -> "Cloud Saves"
  25: 'Leaderboards',  // "Steam Leaderboards" -> "Leaderboards"
};

/**
 * Checks whether a game has an active ownership entitlement on Steam.
 */
export function isGameOwnedOnSteam(platforms?: Array<{ platformId: string }>): boolean {
  if (!platforms || !Array.isArray(platforms)) return false;
  return platforms.some((p) => p.platformId === 'steam');
}

/**
 * Checks whether a tag or feature description represents a Steam-proprietary service.
 */
export function isSteamExclusiveFeature(name: string): boolean {
  const trimmed = name.trim();
  return STEAM_EXCLUSIVE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Dynamically projects and filters Steam categories based on whether the game is owned on Steam.
 *
 * NOTE: This is a NON-DESTRUCTIVE projection. The underlying raw category data is never mutated,
 * ensuring that if the user later purchases the title on Steam, the full Steam features
 * immediately re-appear with zero data loss or cache invalidation.
 */
export function getEffectiveCategories(
  categories: SteamCategory[] = [],
  isOwnedOnSteam: boolean
): SteamCategory[] {
  if (isOwnedOnSteam) {
    return categories;
  }

  const effective: SteamCategory[] = [];
  const seenDescriptions = new Set<string>();

  for (const cat of categories) {
    // 1. Suppress Steam-exclusive category IDs and pattern matches
    if (STEAM_EXCLUSIVE_CATEGORY_IDS.has(cat.id)) {
      continue;
    }
    if (isSteamExclusiveFeature(cat.description)) {
      continue;
    }

    // 2. Normalize and rebrand cross-platform capabilities
    let updatedDesc = cat.description;
    if (CATEGORY_REBRAND_MAP[cat.id]) {
      updatedDesc = CATEGORY_REBRAND_MAP[cat.id];
    } else {
      const lower = cat.description.toLowerCase().trim();
      if (lower === 'steam achievements') updatedDesc = 'Achievements';
      else if (lower === 'steam cloud') updatedDesc = 'Cloud Saves';
      else if (lower === 'steam leaderboards') updatedDesc = 'Leaderboards';
    }

    const normKey = updatedDesc.toLowerCase().trim();
    if (!seenDescriptions.has(normKey)) {
      seenDescriptions.add(normKey);
      effective.push({
        ...cat,
        description: updatedDesc,
      });
    }
  }

  return effective;
}

/**
 * Dynamically normalizes tags based on Steam ownership.
 * Strips proprietary Steam services and neutralizes branded tags for non-Steam titles.
 */
export function getEffectiveTags(
  tags: string[] = [],
  isOwnedOnSteam: boolean
): string[] {
  if (isOwnedOnSteam) {
    return tags;
  }

  const effective: string[] = [];
  const seen = new Set<string>();

  for (const tag of tags) {
    if (!tag) continue;
    const trimmed = tag.trim();

    // 1. Suppress Steam-exclusive services
    if (isSteamExclusiveFeature(trimmed)) {
      continue;
    }

    // 2. Rebrand cross-platform tags
    let updatedTag = trimmed;
    const lower = trimmed.toLowerCase();
    if (lower === 'steam achievements') {
      updatedTag = 'Achievements';
    } else if (lower === 'steam cloud') {
      updatedTag = 'Cloud Saves';
    } else if (lower === 'steam leaderboards') {
      updatedTag = 'Leaderboards';
    }

    const normKey = updatedTag.toLowerCase();
    if (!seen.has(normKey)) {
      seen.add(normKey);
      effective.push(updatedTag);
    }
  }

  return effective;
}
