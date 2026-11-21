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
  sanitizePlatformOwnershipOsFlags,
  normalizeCanonicalTitle,
  hasSameStorefrontConflict,
} from '../services/integrations/catalogSanitizer';
import { steamMatcher } from '../services/steam/steamMatcher';
import { steamApi } from '../services/steam/steamApi';
import { isKnownDeadSteamCover } from '../services/igdb/igdbCoverService';
import {
  reconcileCapsuleImage,
  reconcileHeaderImage,
  type ArtworkRecoveryContext,
} from '../services/storage/metadataReconciliation';
import { launcherService } from '../services/launcher/launcherService';
import { getAlphabeticalTitleSortKey } from '../services/common/titleSortUtils';

export type PartialAchievementRecord = Partial<StoreAchievementSummary> & {
  unlocked: number;
  total: number;
  percentage: number;
};

function areAchievementSummariesSame(
  a?: StoreAchievementSummary,
  b?: StoreAchievementSummary
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.unlocked === b.unlocked &&
    a.total === b.total &&
    a.percentage === b.percentage &&
    Boolean(a.isMastered) === Boolean(b.isMastered) &&
    a.lastUnlockedAt === b.lastUnlockedAt &&
    a.source === b.source &&
    a.syncedAt === b.syncedAt &&
    Boolean(a.hasConflict) === Boolean(b.hasConflict) &&
    a.conflictDetails === b.conflictDetails &&
    a.gamerscore?.earned === b.gamerscore?.earned &&
    a.gamerscore?.total === b.gamerscore?.total &&
    a.xp?.earned === b.xp?.earned &&
    a.xp?.total === b.xp?.total
  );
}

/**
 * Reconciles achievements and local installation state across the game catalog.
 * Preserves exact object references on zero-change entries to avoid unnecessary re-renders.
 */
export function reconcileCatalogTrophiesRecords(
  catalog: CanonicalGame[],
  steamAchs: Record<number, PartialAchievementRecord>,
  gogAchs: Record<string, PartialAchievementRecord>,
  epicAchs: Record<string, PartialAchievementRecord>,
  installedSteamAppIds?: Set<number> | null,
  xboxAchs: Record<string, PartialAchievementRecord> = {}
): CanonicalGame[] {
  let anyCatalogChanged = false;

  const updatedCatalog = catalog.map((game) => {
    const targetAppId = game.steamAppId;
    const ach = targetAppId
      ? steamAchs[targetAppId] || getKnownSteamAchievements(targetAppId, game.title)
      : null;
    const titleLower = (game.title || '').toLowerCase().trim();
    const normTitle = titleLower.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();

    let gamePlatformsChanged = false;
    const updatedPlatforms = game.platforms.map((p) => {
      const sanitizedBase = sanitizePlatformOwnershipOsFlags(p);
      let working: GamePlatformOwnership = sanitizedBase;
      const cloneIfNeeded = (): GamePlatformOwnership => {
        if (working === p) {
          working = { ...p };
        }
        return working;
      };

      const rec = launcherService.getInstalledRecordForGame(game, p.platformId);
      if (rec && rec.platformId === p.platformId) {
        const nextInstalled = true;
        const nextInstallPath = rec.installPath || working.installPath;
        const nextExePath = rec.executablePath || working.executablePath;
        const nextLaunchArgs = rec.launchArguments || working.launchArguments;
        const nextInstallSize = rec.installSize ?? working.installSize;
        const nextVersion = rec.version || working.version;
        const nextWinOnMac = rec.isWindowsBinaryOnMac ?? working.isWindowsBinaryOnMac;
        const nextCrossPlat =
          rec.isCrossPlatformLauncherRuntime !== undefined
            ? rec.isCrossPlatformLauncherRuntime
            : working.isCrossPlatformLauncherRuntime;
        const nextExtHandoff = rec.externalStorefrontHandoff
          ? ((rec.externalStorefrontHandoff as GamePlatformOwnership['externalStorefrontHandoff']) ||
            working.externalStorefrontHandoff)
          : working.externalStorefrontHandoff;
        const nextChainedHandoff = rec.chainedLauncherHandoff || working.chainedLauncherHandoff;
        const nextChainedInstallId =
          rec.chainedExternalInstallId || working.chainedExternalInstallId;
        const recXboxProductId = (rec as typeof rec & { xboxProductId?: string }).xboxProductId;
        const nextXboxProductId = recXboxProductId || working.xboxProductId;
        const nextPfn = rec.packageFamilyName || working.packageFamilyName;
        const nextAumid = rec.appUserModelId || working.appUserModelId;
        const nextXboxTitleId = rec.xboxTitleId || working.xboxTitleId;
        const nextScid = rec.scid || working.scid;
        const nextMsaAppId = rec.msaAppId || working.msaAppId;

        if (
          working.installed !== nextInstalled ||
          working.installPath !== nextInstallPath ||
          working.executablePath !== nextExePath ||
          working.launchArguments !== nextLaunchArgs ||
          working.installSize !== nextInstallSize ||
          working.version !== nextVersion ||
          working.isWindowsBinaryOnMac !== nextWinOnMac ||
          working.isCrossPlatformLauncherRuntime !== nextCrossPlat ||
          working.externalStorefrontHandoff !== nextExtHandoff ||
          working.chainedLauncherHandoff !== nextChainedHandoff ||
          working.chainedExternalInstallId !== nextChainedInstallId ||
          working.xboxProductId !== nextXboxProductId ||
          working.packageFamilyName !== nextPfn ||
          working.appUserModelId !== nextAumid ||
          working.xboxTitleId !== nextXboxTitleId ||
          working.scid !== nextScid ||
          working.msaAppId !== nextMsaAppId
        ) {
          const target = cloneIfNeeded();
          target.installed = nextInstalled;
          target.installPath = nextInstallPath;
          target.executablePath = nextExePath;
          target.launchArguments = nextLaunchArgs;
          target.installSize = nextInstallSize;
          target.version = nextVersion;
          target.isWindowsBinaryOnMac = nextWinOnMac;
          if (nextCrossPlat !== undefined) {
            target.isCrossPlatformLauncherRuntime = nextCrossPlat;
          }
          if (nextExtHandoff) target.externalStorefrontHandoff = nextExtHandoff;
          if (nextChainedHandoff) target.chainedLauncherHandoff = nextChainedHandoff;
          if (nextChainedInstallId) target.chainedExternalInstallId = nextChainedInstallId;
          if (nextXboxProductId) target.xboxProductId = nextXboxProductId;
          if (nextPfn) target.packageFamilyName = nextPfn;
          if (nextAumid) target.appUserModelId = nextAumid;
          if (nextXboxTitleId) target.xboxTitleId = nextXboxTitleId;
          if (nextScid) target.scid = nextScid;
          if (nextMsaAppId) target.msaAppId = nextMsaAppId;
        }
      }

      if (p.platformId === 'steam') {
        if (installedSteamAppIds) {
          const nextSteamInstalled =
            (targetAppId ? installedSteamAppIds.has(targetAppId) : false) ||
            launcherService.isGameInstalled(game, 'steam');
          if (working.installed !== nextSteamInstalled) {
            cloneIfNeeded().installed = nextSteamInstalled;
          }
        }
        if (ach && ach.total > 0) {
          const reconciled = reconcileAchievementSummaries(
            working.achievements,
            {
              unlocked: ach.unlocked,
              total: ach.total,
              percentage: ach.percentage,
              isMastered: ach.percentage >= 100 || (ach.total > 0 && ach.unlocked >= ach.total),
              lastUnlockedAt: ach.lastUnlockedAt,
              source: ach.source || 'local_client_cache',
              syncedAt: ach.syncedAt,
              hasConflict: ach.hasConflict,
              conflictDetails: ach.conflictDetails,
            },
            { title: game.title, appId: targetAppId, store: 'steam' }
          );
          if (reconciled && !areAchievementSummariesSame(working.achievements, reconciled)) {
            cloneIfNeeded().achievements = reconciled;
          }
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
          const reconciled = reconcileAchievementSummaries(working.achievements, gogAch, {
            title: game.title,
            store: 'gog',
          });
          if (reconciled && !areAchievementSummariesSame(working.achievements, reconciled)) {
            cloneIfNeeded().achievements = reconciled;
          }
        }
      } else if (p.platformId === 'epic') {
        const epicId = String(p.platformGameId || game.id);
        const epicIdLower = epicId.toLowerCase();
        const epicNamespace = p.namespace;
        const epicCatalogId = p.catalogItemId;
        const epicAch =
          (epicNamespace ? epicAchs[String(epicNamespace).toLowerCase()] : undefined) ||
          epicAchs[epicId] ||
          epicAchs[epicIdLower] ||
          epicAchs[`epic-${epicIdLower}`] ||
          (epicCatalogId ? epicAchs[String(epicCatalogId).toLowerCase()] : undefined) ||
          epicAchs[titleLower] ||
          epicAchs[normTitle] ||
          (epicNamespace ? getKnownEpicAchievements(epicNamespace, game.title) : undefined) ||
          getKnownEpicAchievements(p.platformGameId || game.id, game.title) ||
          (epicCatalogId ? getKnownEpicAchievements(epicCatalogId, game.title) : undefined);
        if (epicAch && epicAch.total > 0) {
          const reconciled = reconcileAchievementSummaries(working.achievements, epicAch, {
            title: game.title,
            store: 'epic',
          });
          if (reconciled && !areAchievementSummariesSame(working.achievements, reconciled)) {
            cloneIfNeeded().achievements = reconciled;
          }
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
          const reconciled = reconcileAchievementSummaries(working.achievements, xboxAch, {
            title: game.title,
            store: 'xbox',
          });
          if (reconciled && !areAchievementSummariesSame(working.achievements, reconciled)) {
            cloneIfNeeded().achievements = reconciled;
          }
        }
      }

      const finalP = working === sanitizedBase ? sanitizedBase : sanitizePlatformOwnershipOsFlags(working);
      if (finalP !== p) {
        gamePlatformsChanged = true;
      }
      return finalP;
    });

    if (!gamePlatformsChanged) {
      return game;
    }
    anyCatalogChanged = true;
    return { ...game, platforms: updatedPlatforms };
  });

  return anyCatalogChanged ? updatedCatalog : catalog;
}

/**
 * Intelligent non-Steam Steam App ID matching pass that avoids same-storefront or conflicting-title collisions.
 */
export function runIntelligentNonSteamMatchPass(currentCatalog: CanonicalGame[]): CanonicalGame[] {
  const assignedSteamIds = new Map<number, CanonicalGame[]>();
  const assignedGameIds = new Map<string, CanonicalGame[]>();
  const registerAssigned = (appId: number, game: CanonicalGame) => {
    let bucket = assignedSteamIds.get(appId);
    if (!bucket) {
      bucket = [];
      assignedSteamIds.set(appId, bucket);
    }
    bucket.push(game);
  };
  const registerGameId = (id: string, game: CanonicalGame) => {
    if (!id) return;
    let bucket = assignedGameIds.get(id);
    if (!bucket) {
      bucket = [];
      assignedGameIds.set(id, bucket);
    }
    bucket.push(game);
  };
  for (const existingGame of currentCatalog) {
    if (existingGame.steamAppId) {
      registerAssigned(existingGame.steamAppId, existingGame);
    }
    if (existingGame.id) {
      registerGameId(existingGame.id, existingGame);
    }
  }
  let anyChanged = false;
  const nextCatalog = currentCatalog.map((g) => {
    if (g.steamAppId || g.isExplicitNonSteam) return g;
    const matched = steamMatcher.getEffectiveSteamAppId(g);
    if (matched) {
      const candidateId = `steam-${matched}`;
      const existingOwners = assignedSteamIds.get(matched);
      const existingIdOwners = assignedGameIds.get(candidateId);
      const normTitle = normalizeCanonicalTitle(g.title);
      const isConflictingOwner = (owner: CanonicalGame): boolean =>
        owner !== g &&
        (hasSameStorefrontConflict(owner, g) ||
          normalizeCanonicalTitle(owner.title) !== normTitle);
      const conflictingOwner = Boolean(
        existingOwners?.some(isConflictingOwner) || existingIdOwners?.some(isConflictingOwner)
      );
      if (conflictingOwner) {
        return g;
      }
      const gogPlat = g.platforms?.find((p) => p.platformId === 'gog');
      const browseAssets = steamApi.peekCachedBrowseAssets(matched);
      const candidateHeader =
        browseAssets?.headerImage ||
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${matched}/header.jpg`;
      const candidateCapsule =
        browseAssets?.capsuleImage ||
        (!isKnownDeadSteamCover(matched)
          ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${matched}/library_600x900_2x.jpg`
          : undefined);

      const artworkCtx: ArtworkRecoveryContext = {
        gameId: g.id,
        title: g.title,
        steamAppId: matched,
        gogId: gogPlat?.platformGameId,
      };
      const nextHeader =
        reconcileHeaderImage(g.headerImage, candidateHeader, artworkCtx) ||
        g.headerImage ||
        candidateHeader;
      const nextCapsule = reconcileCapsuleImage(g.capsuleImage, candidateCapsule, {
        ...artworkCtx,
        headerUrl: nextHeader,
      });

      const enriched: CanonicalGame = {
        ...g,
        steamAppId: matched,
        id: candidateId,
        headerImage: nextHeader,
        capsuleImage: nextCapsule,
      };
      registerAssigned(matched, enriched);
      registerGameId(candidateId, enriched);
      anyChanged = true;
      return enriched;
    }
    return g;
  });
  return anyChanged ? nextCatalog : currentCatalog;
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

export function recomputeOsFieldsFromPlatforms(
  platforms?: GamePlatformOwnership[]
): Pick<CanonicalGame, 'nativePlatforms' | 'worksOn' | 'platforms_os'> {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    return {
      nativePlatforms: undefined,
      worksOn: undefined,
      platforms_os: undefined,
    };
  }
  const hasExplicitOsInfo = platforms.some((p) => {
    if (!p) return false;
    if (
      p.platformId === 'xbox' ||
      p.platformId === 'ubisoft' ||
      p.platformId === 'ea' ||
      p.platformId === 'rockstar' ||
      (p.platformId as string) === 'riot'
    ) {
      return true;
    }
    if (p.isWindowsBinaryOnMac !== undefined) return true;
    if (Array.isArray(p.platforms) && p.platforms.length > 0) return true;
    if (
      p.platforms &&
      typeof p.platforms === 'object' &&
      !Array.isArray(p.platforms) &&
      (typeof p.platforms.windows === 'boolean' || typeof p.platforms.mac === 'boolean')
    ) {
      return true;
    }
    return false;
  });
  if (!hasExplicitOsInfo) {
    return {
      nativePlatforms: undefined,
      worksOn: undefined,
      platforms_os: undefined,
    };
  }

  let hasWindows = false;
  let hasMac = false;
  for (const rawP of platforms) {
    if (!rawP) continue;
    const p = sanitizePlatformOwnershipOsFlags(rawP);
    if (p.platformId === 'xbox') {
      hasWindows = true;
      if (
        (p.isCrossPlatformLauncherRuntime === true ||
          (p.platforms &&
            typeof p.platforms === 'object' &&
            !Array.isArray(p.platforms) &&
            p.platforms.mac === true)) &&
        !p.isWindowsBinaryOnMac
      ) {
        hasMac = true;
      }
      continue;
    }
    if (
      p.platformId === 'ubisoft' ||
      p.platformId === 'ea' ||
      p.platformId === 'rockstar' ||
      (p.platformId as string) === 'riot'
    ) {
      hasWindows = true;
      continue;
    }
    if (p.isWindowsBinaryOnMac === true) {
      hasWindows = true;
    }
    const rawPlatforms: unknown = p.platforms;
    if (Array.isArray(rawPlatforms)) {
      if (rawPlatforms.includes('windows')) hasWindows = true;
      if (rawPlatforms.includes('mac') && !p.isWindowsBinaryOnMac) hasMac = true;
    } else if (p.platforms && typeof p.platforms === 'object') {
      if (p.platforms.windows !== false) hasWindows = true;
      if (p.platforms.mac === true && !p.isWindowsBinaryOnMac) hasMac = true;
    }
  }

  if (!hasWindows && !hasMac) {
    hasWindows = true;
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

        const preferRecomputedXboxOs = Boolean(
          g.platforms?.length &&
            g.platforms.every(
              (p) =>
                String(p.platformId).toLowerCase() === 'xbox' && !p.isCrossPlatformLauncherRuntime
            )
        );

        return {
          ...g,
          id: restoredId,
          title: restoredTitle,
          sortTitle: getAlphabeticalTitleSortKey(restoredTitle, true),
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
          nativePlatforms: preferRecomputedXboxOs
            ? osFieldsFromPlats.nativePlatforms
            : (nb.nativePlatforms ?? osFieldsFromPlats.nativePlatforms),
          worksOn: preferRecomputedXboxOs
            ? osFieldsFromPlats.worksOn
            : (nb.worksOn ?? osFieldsFromPlats.worksOn),
          platforms_os: preferRecomputedXboxOs
            ? osFieldsFromPlats.platforms_os
            : (nb.platforms_os ?? osFieldsFromPlats.platforms_os),
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
        sortTitle: getAlphabeticalTitleSortKey(restoredTitle, true),
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
      sortTitle: getAlphabeticalTitleSortKey(restoredTitle, true),
      steamAppId: restoredAppId,
      isExplicitNonSteam: false,
      matchConfidence: undefined,
      needsMatchReview: undefined,
      reviewScoreOverride: undefined,
      enrichedMetadata: undefined,
      capsuleImage: !isKnownDeadSteamCover(restoredAppId)
        ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamIdStr}/library_600x900_2x.jpg`
        : undefined,
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
