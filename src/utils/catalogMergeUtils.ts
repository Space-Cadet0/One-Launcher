import { CanonicalGame } from '../contracts/game';
import { UserGameOverride } from '../contracts/override';
import { StorefrontId } from '../contracts/platform';
import {
  getKnownSteamAchievements,
  getKnownGogAchievements,
  getKnownEpicAchievements,
} from '../services/storage/knownGameAchievements';
import { reconcileAchievementSummaries } from '../services/storage/achievementReconciliation';
import { applyUserOverrideToGame } from '../services/storage/userOverrideStorage';
import {
  sanitizeGameCatalog,
  normalizeCanonicalTitle,
  hasSameStorefrontConflict,
} from '../services/integrations/catalogSanitizer';
import { steamMatcher } from '../services/steam/steamMatcher';
import { launcherService } from '../services/launcher/launcherService';

/**
 * Reconciles achievements and local installation state across the game catalog.
 */
export function reconcileCatalogTrophiesRecords(
  catalog: CanonicalGame[],
  steamAchs: Record<number, any>,
  gogAchs: Record<string, any>,
  epicAchs: Record<string, any>,
  installedSteamAppIds?: Set<number> | null
): CanonicalGame[] {
  return catalog.map((game) => {
    const targetAppId = game.steamAppId;
    const ach = targetAppId
      ? steamAchs[targetAppId] || getKnownSteamAchievements(targetAppId, game.title)
      : null;
    const titleLower = (game.title || '').toLowerCase().trim();
    const normTitle = titleLower.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();

    const updatedPlatforms = game.platforms.map((p) => {
      const newP = { ...p };
      const rec = launcherService.getInstalledRecordForGame(game, p.platformId);
      if (rec && rec.platformId === p.platformId) {
        newP.installed = true;
        newP.installPath = rec.installPath || newP.installPath;
        newP.executablePath = rec.executablePath || newP.executablePath;
        newP.installSize = rec.installSize ?? newP.installSize;
        newP.version = rec.version || newP.version;
        newP.isWindowsBinaryOnMac = rec.isWindowsBinaryOnMac ?? newP.isWindowsBinaryOnMac;
      }

      if (p.platformId === 'steam') {
        if (installedSteamAppIds) {
          newP.installed =
            (targetAppId ? installedSteamAppIds.has(targetAppId) : false) ||
            launcherService.isGameInstalled(game, 'steam');
        }
        if (ach && ach.total > 0) {
          const reconciled = reconcileAchievementSummaries(
            p.achievements,
            {
              unlocked: ach.unlocked,
              total: ach.total,
              percentage: ach.percentage,
              isMastered: ach.percentage >= 100 || (ach.total > 0 && ach.unlocked >= ach.total),
              source: (ach as any).source || 'local_client_cache',
              syncedAt: (ach as any).syncedAt,
              hasConflict: (ach as any).hasConflict,
              conflictDetails: (ach as any).conflictDetails,
            },
            { title: game.title, appId: targetAppId, store: 'steam' }
          );
          if (reconciled) newP.achievements = reconciled;
        }
      } else if (p.platformId === 'gog') {
        const gogId = String(p.platformGameId || game.id).replace(/^gog-/, '');
        const gogAch =
          gogAchs[gogId] ||
          gogAchs[`gog-${gogId}`] ||
          gogAchs[titleLower] ||
          gogAchs[normTitle] ||
          getKnownGogAchievements(p.platformGameId || game.id, game.title);
        if (gogAch && gogAch.total > 0) {
          const reconciled = reconcileAchievementSummaries(p.achievements, gogAch, {
            title: game.title,
            store: 'gog',
          });
          if (reconciled) newP.achievements = reconciled;
        }
      } else if (p.platformId === 'epic') {
        const epicId = String(p.platformGameId || game.id);
        const epicIdLower = epicId.toLowerCase();
        const epicAch =
          epicAchs[epicId] ||
          epicAchs[epicIdLower] ||
          epicAchs[`epic-${epicIdLower}`] ||
          ((p as any).namespace
            ? epicAchs[String((p as any).namespace).toLowerCase()]
            : undefined) ||
          epicAchs[titleLower] ||
          epicAchs[normTitle] ||
          getKnownEpicAchievements(p.platformGameId || game.id, game.title);
        if (epicAch && epicAch.total > 0) {
          const reconciled = reconcileAchievementSummaries(p.achievements, epicAch, {
            title: game.title,
            store: 'epic',
          });
          if (reconciled) newP.achievements = reconciled;
        }
      }
      return newP;
    });

    return { ...game, platforms: updatedPlatforms };
  });
}

/**
 * Intelligent non-Steam Steam App ID matching pass that avoids same-storefront or conflicting-title collisions.
 */
export function runIntelligentNonSteamMatchPass(currentCatalog: CanonicalGame[]): CanonicalGame[] {
  const assignedSteamIds = new Map<number, CanonicalGame>();
  for (const existingGame of currentCatalog) {
    if (existingGame.steamAppId) {
      assignedSteamIds.set(existingGame.steamAppId, existingGame);
    }
  }
  return currentCatalog.map((g) => {
    if (g.steamAppId || g.isExplicitNonSteam) return g;
    const matched = steamMatcher.getEffectiveSteamAppId(g);
    if (matched) {
      const existingOwner = assignedSteamIds.get(matched);
      const conflictingOwner =
        (existingOwner &&
          existingOwner !== g &&
          (hasSameStorefrontConflict(existingOwner, g) ||
            normalizeCanonicalTitle(existingOwner.title) !== normalizeCanonicalTitle(g.title))) ||
        currentCatalog.some(
          (other) =>
            other !== g &&
            other.steamAppId === matched &&
            (hasSameStorefrontConflict(other, g) ||
              normalizeCanonicalTitle(other.title) !== normalizeCanonicalTitle(g.title))
        );
      if (conflictingOwner) {
        return g;
      }
      const enriched: CanonicalGame = {
        ...g,
        steamAppId: matched,
        id: `steam-${matched}`,
        headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${matched}/header.jpg`,
        capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${matched}/library_600x900.jpg`,
      };
      assignedSteamIds.set(matched, enriched);
      return enriched;
    }
    return g;
  });
}

/**
 * Applies a UserGameOverride (including optional multi-storefront split) to the game catalog.
 */
export function applyOverrideToCatalog(
  prevGames: CanonicalGame[],
  override: UserGameOverride,
  fixMatchGame: CanonicalGame | null,
  isSplitting: boolean
): CanonicalGame[] {
  if (isSplitting && fixMatchGame && override.platformId) {
    const strippedGames: CanonicalGame[] = [];
    for (const g of prevGames) {
      const hasSplitPlat = g.platforms?.some(
        (p) =>
          p.platformId === override.platformId &&
          (!override.platformGameId ||
            String(p.platformGameId) === String(override.platformGameId))
      );
      if (hasSplitPlat && g.platforms.length > 1) {
        const remainingPlats = g.platforms.filter(
          (p) =>
            !(
              p.platformId === override.platformId &&
              (!override.platformGameId ||
                String(p.platformGameId) === String(override.platformGameId))
            )
        );
        if (remainingPlats.length > 0) {
          strippedGames.push({ ...g, platforms: remainingPlats });
        }
      } else if (hasSplitPlat && g.platforms.length === 1 && g.id === override.gameId) {
        // Replaced by standalone split entry below
      } else {
        strippedGames.push(g);
      }
    }

    const cleanBaseGame: CanonicalGame = { ...fixMatchGame, isVerifiedEntitlement: true };
    delete (cleanBaseGame as any).isSplittingFromMerged;
    const standaloneGame = applyUserOverrideToGame(cleanBaseGame, override, {
      invalidateEnrichedCache: true,
    });

    return sanitizeGameCatalog([...strippedGames, standaloneGame], {
      allowNewPurchases: true,
    });
  }

  let matchedAny = false;
  let updatedGames = prevGames.map((g) => {
    const isMatch =
      g.id === override.gameId ||
      Boolean(
        override.platformGameId &&
          g.platforms?.some(
            (p) =>
              p.platformGameId === override.platformGameId &&
              (!override.platformId || p.platformId === override.platformId)
          )
      );
    if (isMatch) {
      matchedAny = true;
      return applyUserOverrideToGame(g, override, { invalidateEnrichedCache: true });
    }
    return g;
  });

  if (!matchedAny && fixMatchGame) {
    const restoredGame = applyUserOverrideToGame(
      { ...fixMatchGame, isVerifiedEntitlement: true },
      override,
      {
        invalidateEnrichedCache: true,
      }
    );
    updatedGames = [...updatedGames, restoredGame];
  }

  return sanitizeGameCatalog(updatedGames, {
    allowNewPurchases: true,
  });
}

/**
 * Reverts a removed user override across matching catalog entries and re-sanitizes the catalog.
 */
export function revertRemovedOverrideInCatalog(
  prevGames: CanonicalGame[],
  removedGameId: string,
  oldOverride?: UserGameOverride
): CanonicalGame[] {
  const revertedGames = prevGames.map((g) => {
    const isMatch =
      g.id === removedGameId ||
      Boolean(
        oldOverride?.platformGameId &&
          g.platforms?.some(
            (p) =>
              String(p.platformGameId) === String(oldOverride.platformGameId) &&
              (!oldOverride.platformId || p.platformId === oldOverride.platformId)
          )
      );
    if (!isMatch) return g;

    const nativeTitle =
      g.originalStoreTitle ||
      oldOverride?.originalSourceTitle ||
      g.platforms?.[0]?.originalTitle ||
      g.title;
    const steamPlat = g.platforms?.find(
      (p) => p.platformId === 'steam' && p.platformGameId && !isNaN(Number(p.platformGameId))
    );
    return {
      ...g,
      title: nativeTitle,
      sortTitle: nativeTitle.replace(/^(The|A|An)\s+/i, '').trim(),
      steamAppId: steamPlat ? Number(steamPlat.platformGameId) : undefined,
      isExplicitNonSteam: undefined,
      reviewScoreOverride: undefined,
      enrichedMetadata: undefined,
      capsuleImage:
        oldOverride?.capsuleImage && g.capsuleImage === oldOverride.capsuleImage
          ? ''
          : g.capsuleImage,
      headerImage:
        oldOverride?.headerImage && g.headerImage === oldOverride.headerImage
          ? ''
          : g.headerImage,
    };
  });

  return sanitizeGameCatalog(revertedGames, { allowNewPurchases: true });
}

/**
 * Removes or strips a hidden game/platform entry from the active catalog and re-sanitizes.
 */
export function hideStorefrontEntryFromCatalog(
  prevGames: CanonicalGame[],
  gameToHide: CanonicalGame,
  targetPlatformId?: StorefrontId
): CanonicalGame[] {
  const nextGames: CanonicalGame[] = [];
  for (const g of prevGames) {
    if (g.id === gameToHide.id) {
      if (targetPlatformId && g.platforms.length > 1) {
        const remainingPlats = g.platforms.filter((p) => p.platformId !== targetPlatformId);
        if (remainingPlats.length > 0) {
          nextGames.push({ ...g, platforms: remainingPlats });
        }
      }
    } else if (
      targetPlatformId &&
      gameToHide.platforms.length === 1 &&
      g.platforms.length > 1 &&
      g.platforms.some(
        (p) =>
          p.platformId === targetPlatformId &&
          String(p.platformGameId) === String(gameToHide.platforms[0]?.platformGameId)
      )
    ) {
      const remainingPlats = g.platforms.filter(
        (p) =>
          !(
            p.platformId === targetPlatformId &&
            String(p.platformGameId) === String(gameToHide.platforms[0]?.platformGameId)
          )
      );
      if (remainingPlats.length > 0) {
        nextGames.push({ ...g, platforms: remainingPlats });
      }
    } else {
      nextGames.push(g);
    }
  }

  return sanitizeGameCatalog(nextGames, { allowNewPurchases: true });
}
