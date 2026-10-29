import { CanonicalGame } from '../../contracts/game';
import { SteamCategory } from '../../contracts/steam';
import { ActiveGameFilter } from '../../contracts/filter';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';
import { getOpenCriticData } from '../opencritic/openCritic';
import {
  isGameOwnedOnSteam,
  isSteamExclusiveFeature,
  getEffectiveCategories,
  getEffectiveTags,
} from '../steam/steamFeatureNormalizer';
import {
  isNativelyAvailableOnMac,
  isNativelyAvailableOnWindows,
} from '../platform/nativeOsService';

interface SteamEnrichedFilterEntry {
  reviewSummary?: {
    reviewScoreDesc?: string;
    positivePercent?: number;
  };
  categories?: SteamCategory[];
}

const cache = steamEnrichedCache as Record<string, SteamEnrichedFilterEntry>;

function normalizeStudioPhrase(raw: string): string {
  return (raw || '')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function stripCorporateSuffixTokens(normalizedPhrase: string): string {
  return normalizedPhrase
    .replace(
      /\b(studios?|inc|incorporated|llc|ltd|limited|gmbh|corp|corporation|co|plc|ab|sa|sas|srl|bv|nv)\b/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Matches a developer or publisher studio name against a filter value using normalized
 * exact or whole-word token boundaries so short studio tokens ("EA", "id") never match
 * unrelated substrings ("Creative Assembly", "Obsidian").
 */
export function matchesStudioFilter(studioName: string, rawTarget: string): boolean {
  const normStudio = normalizeStudioPhrase(studioName);
  const normTarget = normalizeStudioPhrase(rawTarget);
  if (!normStudio || !normTarget) return false;
  if (normStudio === normTarget) return true;

  const paddedStudio = ` ${normStudio} `;
  if (paddedStudio.includes(` ${normTarget} `)) {
    return true;
  }

  const coreStudio = stripCorporateSuffixTokens(normStudio);
  const coreTarget = stripCorporateSuffixTokens(normTarget);
  if (coreStudio && coreTarget && coreStudio === coreTarget) {
    return true;
  }

  return false;
}

function matchesPhraseBoundaryOrLongSubstring(candidate: string, rawTarget: string): boolean {
  const normCandidate = normalizeStudioPhrase(candidate);
  const normTarget = normalizeStudioPhrase(rawTarget);
  if (!normCandidate || !normTarget) return false;
  if (normCandidate === normTarget) return true;
  if (` ${normCandidate} `.includes(` ${normTarget} `)) return true;
  if (normTarget.length >= 5 && normCandidate.includes(normTarget)) return true;
  return false;
}

/**
 * Evaluates whether a game matches the active user-selected temporary filter.
 */
export function matchesGameFilter(game: CanonicalGame, filter: ActiveGameFilter): boolean {
  if (!filter || !filter.value) return true;
  const target = filter.value.trim().toLowerCase();

  if (filter.type === 'os') {
    if (
      target === 'mac' ||
      target === 'macos' ||
      target === 'mac os' ||
      target === 'osx' ||
      target === 'apple'
    ) {
      return isNativelyAvailableOnMac(game);
    }
    if (target === 'windows' || target === 'win' || target === 'pc') {
      return isNativelyAvailableOnWindows(game);
    }
    return false;
  }

  if (filter.type === 'opencritic' || filter.type === 'rating' || filter.type === 'critic') {
    const oc = getOpenCriticData(
      game.steamAppId,
      game.title,
      game.reviewSummary?.positivePercent,
      game.releaseDate,
      undefined,
      false,
      true
    );
    if (!oc) return false;
    const tier = oc.tier.toLowerCase();
    return tier === target || target.includes(tier) || tier.includes(target);
  }

  if (filter.type === 'review') {
    const desc = (
      game.reviewSummary?.reviewScoreDesc ||
      game.enrichedMetadata?.reviewSummary?.reviewScoreDesc ||
      (game.steamAppId ? cache[game.steamAppId.toString()]?.reviewSummary?.reviewScoreDesc : '') ||
      ''
    ).trim().toLowerCase();

    if (desc) {
      if (desc === target) return true;
      const normDesc = desc.replace(/[^a-z]/g, '');
      const normTarget = target.replace(/[^a-z]/g, '');
      if (normDesc === normTarget) return true;

      const keywords = ['overwhelmingly', 'very', 'mostly', 'mixed', 'negative'];
      const targetHasKeyword = keywords.filter((k) => normTarget.includes(k));
      const descHasKeyword = keywords.filter((k) => normDesc.includes(k));
      if (
        targetHasKeyword.length > 0 &&
        targetHasKeyword.every((k) => descHasKeyword.includes(k)) &&
        descHasKeyword.every((k) => targetHasKeyword.includes(k))
      ) {
        return true;
      }
    }

    // Fallback based on positivePercent if explicit descriptor string is missing
    const pos =
      game.reviewSummary?.positivePercent ??
      game.enrichedMetadata?.reviewSummary?.positivePercent ??
      (game.steamAppId ? cache[game.steamAppId.toString()]?.reviewSummary?.positivePercent : undefined);

    if (pos !== undefined) {
      if (pos >= 95 && target.includes('overwhelmingly positive')) return true;
      if (pos >= 80 && pos < 95 && target.includes('very positive')) return true;
      if (pos >= 70 && pos < 80 && target.includes('mostly positive')) return true;
      if (pos >= 40 && pos < 70 && target.includes('mixed')) return true;
      if (pos < 40 && target.includes('negative')) return true;
    }

    return false;
  }

  if (filter.type === 'developer') {
    return game.developers.some((d) => matchesStudioFilter(d, target));
  }

  if (filter.type === 'publisher') {
    return game.publishers.some((p) => matchesStudioFilter(p, target));
  }

  if (filter.type === 'genre') {
    const inGenres = game.genres.some(
      (g) => g.toLowerCase() === target || g.toLowerCase().includes(target)
    );
    const inTags = game.tags.some(
      (t) => t.toLowerCase() === target || t.toLowerCase().includes(target)
    );
    return inGenres || inTags;
  }

  if (filter.type === 'tag') {
    const isOwnedOnSteam = isGameOwnedOnSteam(game.platforms);
    if (isSteamExclusiveFeature(target) && !isOwnedOnSteam) {
      return false;
    }
    const effectiveTags = getEffectiveTags(game.tags, isOwnedOnSteam);
    return (
      effectiveTags.some((t) => t.toLowerCase() === target || t.toLowerCase().includes(target)) ||
      game.genres.some((g) => g.toLowerCase() === target || g.toLowerCase().includes(target))
    );
  }

  if (filter.type === 'feature') {
    const isOwnedOnSteam = isGameOwnedOnSteam(game.platforms);
    if (isSteamExclusiveFeature(target) && !isOwnedOnSteam) {
      return false;
    }

    const effectiveTags = getEffectiveTags(game.tags, isOwnedOnSteam);

    // 1. Direct tag match (e.g. "HDR available", "Single-player", "Achievements")
    if (effectiveTags.some((t) => t.toLowerCase() === target || t.toLowerCase().includes(target))) {
      return true;
    }

    // 2. Direct metadata categories on the game
    const directCategories = getEffectiveCategories(game.enrichedMetadata?.categories, isOwnedOnSteam);
    if (
      directCategories.some((c) =>
        c.description.toLowerCase().includes(target)
      )
    ) {
      return true;
    }

    // 3. Categories stored in steamEnrichedCache
    if (game.steamAppId) {
      const cached = cache[game.steamAppId.toString()];
      if (cached?.categories) {
        const cachedCategories = getEffectiveCategories(cached.categories, isOwnedOnSteam);
        if (
          cachedCategories.some((c) =>
            c.description?.toLowerCase().includes(target)
          )
        ) {
          return true;
        }
      }
    }

    // 4. Feature-specific keyword mappings
    // HDR
    if (target.includes('hdr')) {
      if (game.tags.some((t) => t.toLowerCase().includes('hdr'))) return true;
      if (
        game.steamAppId &&
        cache[game.steamAppId.toString()]?.categories?.some((c) =>
          c.description?.toLowerCase().includes('hdr')
        )
      ) {
        return true;
      }
    }

    // Controller Support
    if (target.includes('controller')) {
      if (game.tags.some((t) => t.toLowerCase().includes('controller'))) return true;
      if (game.enrichedMetadata?.controllerSupport) return true;
      if (
        game.steamAppId &&
        cache[game.steamAppId.toString()]?.categories?.some((c) =>
          c.description?.toLowerCase().includes('controller')
        )
      ) {
        return true;
      }
    }

    // Co-op
    if (target.includes('co-op') || target.includes('coop')) {
      if (
        game.tags.some(
          (t) => t.toLowerCase().includes('co-op') || t.toLowerCase().includes('coop')
        )
      ) {
        return true;
      }
      if (
        game.steamAppId &&
        cache[game.steamAppId.toString()]?.categories?.some((c) =>
          c.description?.toLowerCase().includes('co-op')
        )
      ) {
        return true;
      }
    }

    // Multiplayer / PvP
    if (
      target.includes('multiplayer') ||
      target.includes('pvp') ||
      target.includes('multi-player')
    ) {
      if (
        game.tags.some(
          (t) =>
            t.toLowerCase().includes('multiplayer') ||
            t.toLowerCase().includes('pvp') ||
            t.toLowerCase().includes('multi-player')
        )
      ) {
        return true;
      }
      if (
        game.steamAppId &&
        cache[game.steamAppId.toString()]?.categories?.some((c) => {
          const desc = c.description?.toLowerCase() || '';
          return (
            desc.includes('multiplayer') ||
            desc.includes('multi-player') ||
            desc.includes('pvp')
          );
        })
      ) {
        return true;
      }
    }

    // Cloud Sync
    if (target.includes('cloud')) {
      if (game.tags.some((t) => t.toLowerCase().includes('cloud'))) return true;
      if (
        game.steamAppId &&
        cache[game.steamAppId.toString()]?.categories?.some((c) =>
          c.description?.toLowerCase().includes('cloud')
        )
      ) {
        return true;
      }
    }

    // Achievements
    if (target.includes('achievement')) {
      if (game.platforms.some((p) => p.achievements && p.achievements.total > 0)) return true;
      if (effectiveTags.some((t) => t.toLowerCase().includes('achievement'))) return true;
      if (
        game.steamAppId &&
        cache[game.steamAppId.toString()]?.categories?.some((c) =>
          c.description?.toLowerCase().includes('achievement')
        )
      ) {
        return true;
      }
    }

    // Family Sharing
    if (target.includes('family')) {
      if (!isOwnedOnSteam) return false;
      if (game.tags.some((t) => t.toLowerCase().includes('family'))) return true;
      if (
        game.steamAppId &&
        cache[game.steamAppId.toString()]?.categories?.some((c) =>
          c.description?.toLowerCase().includes('family')
        )
      ) {
        return true;
      }
    }

    return false;
  }

  if (filter.type === 'franchise') {
    return (
      matchesPhraseBoundaryOrLongSubstring(game.title || '', target) ||
      matchesPhraseBoundaryOrLongSubstring(game.originalStoreTitle || '', target) ||
      game.developers.some((d) => matchesStudioFilter(d, target)) ||
      game.publishers.some((p) => matchesStudioFilter(p, target)) ||
      game.tags.some((t) => matchesPhraseBoundaryOrLongSubstring(t, target))
    );
  }

  if (filter.type === 'platform') {
    return (game.platforms || []).some(
      (p) => p.platformId.toLowerCase() === target || target.includes(p.platformId.toLowerCase())
    );
  }

  if (filter.type === 'status') {
    const isInstalled = (game.platforms || []).some((p) => p.installed);
    if (target === 'installed') return isInstalled;
    if (target === 'not_installed' || target === 'uninstalled' || target === 'not installed') {
      return !isInstalled;
    }
    const totalPlaytime = (game.platforms || []).reduce(
      (acc, p) => acc + (p.playtimeMinutes || 0),
      0
    );
    if (target === 'unplayed') return totalPlaytime === 0;
    if (target === 'played') return totalPlaytime > 0;
    return false;
  }

  return false;
}
