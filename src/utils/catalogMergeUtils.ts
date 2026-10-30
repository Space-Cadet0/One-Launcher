import { CanonicalGame, GamePlatformOwnership, NativeOsPlatform, StoreAchievementSummary } from '../contracts/game';
import { NativeGameBaselineSnapshot, UserGameOverride } from '../contracts/override';
import { StorefrontId } from '../contracts/platform';
import {
  getKnownSteamAchievements,
  getKnownGogAchievements,
  getKnownEpicAchievements,
  getKnownXboxAchievements,
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

export type PartialAchievementRecord = Partial<StoreAchievementSummary> & {
  unlocked: number;
  total: number;
  percentage: number;
};

/**
 * Reconciles achievements and local installation state across the game catalog.
 */
export function reconcileCatalogTrophiesRecords(
  catalog: CanonicalGame[],
  steamAchs: Record<number, PartialAchievementRecord>,
  gogAchs: Record<string, PartialAchievementRecord>,
  epicAchs: Record<string, PartialAchievementRecord>,
  installedSteamAppIds?: Set<number> | null,
  xboxAchs: Record<string, PartialAchievementRecord> = {}
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
        newP.launchArguments = rec.launchArguments || newP.launchArguments;
        newP.installSize = rec.installSize ?? newP.installSize;
        newP.version = rec.version || newP.version;
        newP.isWindowsBinaryOnMac = rec.isWindowsBinaryOnMac ?? newP.isWindowsBinaryOnMac;
        const recXboxProductId = (rec as typeof rec & { xboxProductId?: string }).xboxProductId;
        if (recXboxProductId) newP.xboxProductId = recXboxProductId || newP.xboxProductId;
        if (rec.packageFamilyName) {
          newP.packageFamilyName = rec.packageFamilyName || newP.packageFamilyName;
        }
        if (rec.appUserModelId) newP.appUserModelId = rec.appUserModelId || newP.appUserModelId;
        if (rec.xboxTitleId) newP.xboxTitleId = rec.xboxTitleId || newP.xboxTitleId;
        if (rec.scid) newP.scid = rec.scid || newP.scid;
        if (rec.msaAppId) newP.msaAppId = rec.msaAppId || newP.msaAppId;
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
              source: ach.source || 'local_client_cache',
              syncedAt: ach.syncedAt,
              hasConflict: ach.hasConflict,
              conflictDetails: ach.conflictDetails,
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
        const epicNamespace = (p as GamePlatformOwnership & { namespace?: string }).namespace;
        const epicAch =
          epicAchs[epicId] ||
          epicAchs[epicIdLower] ||
          epicAchs[`epic-${epicIdLower}`] ||
          (epicNamespace ? epicAchs[String(epicNamespace).toLowerCase()] : undefined) ||
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
      } else if (p.platformId === 'xbox') {
        const rawXboxId = String(p.xboxProductId || p.platformGameId || game.id).replace(
          /^xbox[-_]/i,
          ''
        );
        const xboxIdLower = rawXboxId.toLowerCase();
        const titleIdStr = p.xboxTitleId ? String(p.xboxTitleId).trim() : '';
        const pfnStr = p.packageFamilyName ? String(p.packageFamilyName).trim() : '';
        const xboxAch =
          xboxAchs[rawXboxId] ||
          xboxAchs[xboxIdLower] ||
          xboxAchs[`xbox-${xboxIdLower}`] ||
          (p.platformGameId ? xboxAchs[String(p.platformGameId)] : undefined) ||
          (p.platformGameId ? xboxAchs[String(p.platformGameId).toLowerCase()] : undefined) ||
          (titleIdStr ? xboxAchs[titleIdStr] || xboxAchs[titleIdStr.toLowerCase()] : undefined) ||
          (pfnStr ? xboxAchs[pfnStr] || xboxAchs[pfnStr.toLowerCase()] : undefined) ||
          xboxAchs[titleLower] ||
          xboxAchs[normTitle] ||
          getKnownXboxAchievements(
            p.xboxProductId || p.platformGameId || p.xboxTitleId || p.packageFamilyName || game.id,
            game.title
          );
        if (xboxAch && (xboxAch.total > 0 || (xboxAch.gamerscore?.total ?? 0) > 0)) {
          const reconciled = reconcileAchievementSummaries(p.achievements, xboxAch, {
            title: game.title,
            store: 'xbox',
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

    const cleanBaseGame: CanonicalGame & { isSplittingFromMerged?: boolean } = {
      ...fixMatchGame,
      isVerifiedEntitlement: true,
    };
    delete cleanBaseGame.isSplittingFromMerged;
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
 * Captures the pre-override native baseline snapshot of a CanonicalGame so subsequent Reset
 * deterministically restores the exact original ID, title, art, synopsis, and OS support.
 */
export function captureNativeGameBaseline(game: CanonicalGame): NativeGameBaselineSnapshot {
  const primaryPlat = game.platforms?.[0];
  const steamPlat = game.platforms?.find(
    (p) => p?.platformId === 'steam' && p.platformGameId && !isNaN(Number(p.platformGameId))
  );
  const baseTitle =
    primaryPlat?.originalTitle || game.originalStoreTitle || game.title || game.id;
  return {
    id: game.id,
    title: baseTitle,
    steamAppId:
      typeof game.steamAppId === 'number' && game.steamAppId > 0
        ? game.steamAppId
        : steamPlat
          ? Number(steamPlat.platformGameId)
          : null,
    capsuleImage: game.capsuleImage,
    headerImage: game.headerImage,
    iconUrl: game.iconUrl,
    shortDescription: game.shortDescription,
    detailedDescription: game.detailedDescription,
    developers: Array.isArray(game.developers) ? [...game.developers] : undefined,
    publishers: Array.isArray(game.publishers) ? [...game.publishers] : undefined,
    genres: Array.isArray(game.genres) ? [...game.genres] : undefined,
    tags: Array.isArray(game.tags) ? [...game.tags] : undefined,
    releaseDate: game.releaseDate,
    nativePlatforms: Array.isArray(game.nativePlatforms) ? [...game.nativePlatforms] : undefined,
    worksOn: game.worksOn
      ? {
          windows: game.worksOn.windows,
          mac: game.worksOn.mac,
          linux: game.worksOn.linux,
        }
      : undefined,
    platforms_os: game.platforms_os
      ? {
          windows: game.platforms_os.windows,
          mac: game.platforms_os.mac,
          linux: game.platforms_os.linux,
        }
      : undefined,
  };
}

function recomputeOsFieldsFromPlatforms(
  platforms?: GamePlatformOwnership[]
): Pick<CanonicalGame, 'nativePlatforms' | 'worksOn' | 'platforms_os'> {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    return {
      nativePlatforms: undefined,
      worksOn: undefined,
      platforms_os: undefined,
    };
  }
  const hasExplicitOsInfo = platforms.some(
    (p) =>
      (Array.isArray(p?.platforms) && p.platforms.length > 0) ||
      p?.isWindowsBinaryOnMac !== undefined ||
      p?.platformId === 'xbox'
  );
  if (!hasExplicitOsInfo) {
    return {
      nativePlatforms: undefined,
      worksOn: undefined,
      platforms_os: undefined,
    };
  }

  let hasWindows = false;
  let hasMac = false;
  for (const p of platforms) {
    if (!p) continue;
    if (p.platformId === 'xbox' || p.isWindowsBinaryOnMac === true) {
      hasWindows = true;
    }
    if (Array.isArray(p.platforms)) {
      if (p.platforms.includes('windows')) hasWindows = true;
      if (p.platforms.includes('mac') && !p.isWindowsBinaryOnMac) hasMac = true;
    }
  }

  const nativePlatforms: NativeOsPlatform[] = [];
  if (hasWindows) nativePlatforms.push('windows');
  if (hasMac) nativePlatforms.push('mac');

  return {
    nativePlatforms: nativePlatforms.length > 0 ? nativePlatforms : undefined,
    worksOn: { windows: hasWindows, mac: hasMac },
    platforms_os: { windows: hasWindows, mac: hasMac },
  };
}

/**
 * Reverts a removed user override across matching catalog entries, restoring canonical IDs,
 * original storefront titles, default artwork/metadata, and OS flags, then re-sanitizes and runs
 * the intelligent non-Steam default match pass.
 */
export function revertRemovedOverrideInCatalog(
  prevGames: CanonicalGame[],
  removedGameId: string,
  oldOverride?: UserGameOverride | null,
  contextGame?: Partial<CanonicalGame> | null
): CanonicalGame[] {
  const isSplitRevert = Boolean(oldOverride?.splitFromMerged);

  const revertedGames = prevGames.map((g) => {
    const matchesById =
      g.id === removedGameId ||
      Boolean(oldOverride?.gameId && g.id === oldOverride.gameId) ||
      Boolean(contextGame?.id && g.id === contextGame.id);

    const matchesByOverridePlat = Boolean(
      oldOverride?.platformGameId &&
        (!isSplitRevert || g.platforms?.length === 1) &&
        g.platforms?.some(
          (p) =>
            String(p.platformGameId).toLowerCase() ===
              String(oldOverride.platformGameId).toLowerCase() &&
            (!oldOverride.platformId ||
              String(p.platformId).toLowerCase() === String(oldOverride.platformId).toLowerCase())
        )
    );

    const matchesByContextPlat = Boolean(
      !isSplitRevert &&
        Array.isArray(contextGame?.platforms) &&
        contextGame!.platforms!.length > 0 &&
        g.platforms?.some((p) =>
          contextGame!.platforms!.some(
            (cp) =>
              cp?.platformId &&
              cp?.platformGameId &&
              String(p.platformId).toLowerCase() === String(cp.platformId).toLowerCase() &&
              String(p.platformGameId).toLowerCase() === String(cp.platformGameId).toLowerCase()
          )
        )
    );

    if (!matchesById && !matchesByOverridePlat && !matchesByContextPlat) {
      return g;
    }

    const steamPlat = g.platforms?.find(
      (p) => p.platformId === 'steam' && p.platformGameId && !isNaN(Number(p.platformGameId))
    );
    const primaryPlat = g.platforms?.[0];
    const osFieldsFromPlats = recomputeOsFieldsFromPlatforms(g.platforms);

    if (oldOverride?.nativeBaseline) {
      const nb = oldOverride.nativeBaseline;
      const fallbackNativeId = steamPlat
        ? `steam-${steamPlat.platformGameId}`
        : primaryPlat?.platformId && primaryPlat?.platformGameId
          ? `${String(primaryPlat.platformId).toLowerCase()}-${primaryPlat.platformGameId}`
          : g.id;
      const restoredId = nb.id || fallbackNativeId;
      const restoredTitle =
        nb.title ||
        primaryPlat?.originalTitle ||
        g.originalStoreTitle ||
        oldOverride.originalSourceTitle ||
        g.title;
      const restoredSteamAppId =
        typeof nb.steamAppId === 'number' && nb.steamAppId > 0
          ? nb.steamAppId
          : steamPlat
            ? Number(steamPlat.platformGameId)
            : undefined;

      return {
        ...g,
        id: restoredId,
        title: restoredTitle,
        sortTitle: restoredTitle.replace(/^(The|A|An)\s+/i, '').trim(),
        steamAppId: restoredSteamAppId,
        isExplicitNonSteam: false,
        matchConfidence: undefined,
        needsMatchReview: undefined,
        reviewScoreOverride: undefined,
        enrichedMetadata: undefined,
        capsuleImage: nb.capsuleImage,
        headerImage: nb.headerImage ?? '',
        iconUrl: nb.iconUrl,
        shortDescription: nb.shortDescription ?? '',
        detailedDescription: nb.detailedDescription,
        developers: Array.isArray(nb.developers) ? [...nb.developers] : [],
        publishers: Array.isArray(nb.publishers) ? [...nb.publishers] : [],
        genres: Array.isArray(nb.genres) ? [...nb.genres] : [],
        tags: Array.isArray(nb.tags) ? [...nb.tags] : [],
        releaseDate: nb.releaseDate,
        nativePlatforms: nb.nativePlatforms ?? osFieldsFromPlats.nativePlatforms,
        worksOn: nb.worksOn ?? osFieldsFromPlats.worksOn,
        platforms_os: nb.platforms_os ?? osFieldsFromPlats.platforms_os,
      };
    }

    if (!steamPlat) {
      const restoredId =
        primaryPlat?.platformId && primaryPlat?.platformGameId
          ? `${String(primaryPlat.platformId).toLowerCase()}-${primaryPlat.platformGameId}`
          : g.id;
      const restoredTitle =
        primaryPlat?.originalTitle ||
        g.originalStoreTitle ||
        oldOverride?.originalSourceTitle ||
        g.title;

      return {
        ...g,
        ...osFieldsFromPlats,
        id: restoredId,
        title: restoredTitle,
        sortTitle: restoredTitle.replace(/^(The|A|An)\s+/i, '').trim(),
        steamAppId: undefined,
        isExplicitNonSteam: false,
        matchConfidence: undefined,
        needsMatchReview: undefined,
        reviewScoreOverride: undefined,
        enrichedMetadata: undefined,
        capsuleImage: undefined,
        headerImage: '',
        iconUrl: undefined,
        shortDescription: '',
        detailedDescription: undefined,
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
        releaseDate: undefined,
      };
    }

    const steamIdStr = String(steamPlat.platformGameId);
    const restoredAppId = Number(steamIdStr);
    const restoredTitle =
      steamPlat.originalTitle ||
      g.originalStoreTitle ||
      oldOverride?.originalSourceTitle ||
      g.title;

    return {
      ...g,
      ...osFieldsFromPlats,
      id: `steam-${steamIdStr}`,
      title: restoredTitle,
      sortTitle: restoredTitle.replace(/^(The|A|An)\s+/i, '').trim(),
      steamAppId: restoredAppId,
      isExplicitNonSteam: false,
      matchConfidence: undefined,
      needsMatchReview: undefined,
      reviewScoreOverride: undefined,
      enrichedMetadata: undefined,
      capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamIdStr}/library_600x900_2x.jpg`,
      headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamIdStr}/header.jpg`,
      iconUrl: undefined,
      shortDescription: '',
      detailedDescription: undefined,
    };
  });

  const sanitized = sanitizeGameCatalog(revertedGames, { allowNewPurchases: true });
  const rematched = runIntelligentNonSteamMatchPass(sanitized);
  const didRematch = rematched.some((g, idx) => g !== sanitized[idx]);
  return didRematch ? sanitizeGameCatalog(rematched, { allowNewPurchases: true }) : rematched;
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
