import {
  CanonicalGame,
  GamePlatformOwnership,
  XboxOwnershipType,
  XboxSubscriptionTierId,
} from '../../../contracts/game';
import { StorefrontId } from '../../../contracts/platform';
import { sanitizeGameInstallSizeBytes } from '../../../utils/formatBytes';
import { LIBRARY_TITLE_COLLATOR } from '../../common/titleSortUtils';
import { isUnsuitableHeaderUrl } from '../../igdb/igdbCoverService';
import { reconcileAchievementSummaries } from '../../storage/achievementReconciliation';
import {
  pickBestEnrichedMetadata,
  pickPreferredDetailedDescription,
  pickPreferredReleaseDate,
} from '../../storage/librarySync';
import {
  reconcileCapsuleImage,
  reconcileHeaderImage,
  type ArtworkRecoveryContext,
} from '../../storage/metadataReconciliation';
import {
  applyUserOverrideToGame,
  getUserOverrideForGame,
  loadUserOverrides,
} from '../../storage/userOverrideStorage';
import {
  hasSameStorefrontConflict,
  hasSplitOverrideConflict,
  normalizeCanonicalTitle,
  normalizeChainedHandoffId,
  sanitizeGameCatalog,
  sanitizePlatformOwnershipOsFlags,
} from '../catalogSanitizer';
import {
  areAchievementSummariesSubstantivelyEqual,
  areCanonicalGamesShallowEqual,
  arePlatformOwnershipsEqual,
  areStringArraysEqual,
  recoverRichSummaryFieldsFromDonor,
} from './catalogSlimming';
import {
  clearVerifiedUserEntitlements,
  recordVerifiedUserEntitlements,
} from './entitlementsAndProfileStore';
import {
  deleteOrphanedGamesFromOfflineVault,
  hasLocalInstallMetadata,
  normalizePlatformGameIdForLookup,
  preserveLocalInstallFieldsAcrossSanitize,
} from './installedReconciler';

const XBOX_SUBSCRIPTION_TAG_RE =
  /^(?:xbox\s+game\s+pass(?:\s+(?:ultimate|premium|essential|core|standard|for\s+console|for\s+pc))?|pc\s+game\s+pass(?:\s+starter)?|game\s+pass(?:\s+(?:ultimate|premium|essential|core|standard))?|ea\s+play|ubisoft\+?(?:\s+(?:classics|premium))?|leaving\s+soon|recently\s+added)$/i;

/**
 * Parses `lastPlayed` strings in either Unix epoch seconds (e.g. `"1730000000"`),
 * Unix epoch milliseconds, or ISO 8601 format into canonical epoch milliseconds.
 */
export function parseLastPlayedEpochMs(raw?: string | number | null): number {
  if (raw === undefined || raw === null) return Number.NaN;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return Number.NaN;
    return raw < 1e12 ? raw * 1000 : raw;
  }
  const trimmed = String(raw).trim();
  if (!trimmed) return Number.NaN;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num <= 0) return Number.NaN;
    return num < 1e12 ? num * 1000 : num;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function pickNewerLastPlayed(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  const msA = parseLastPlayedEpochMs(a);
  const msB = parseLastPlayedEpochMs(b);
  if (Number.isFinite(msA) && Number.isFinite(msB)) {
    return msA >= msB ? a : b;
  }
  if (Number.isFinite(msA)) return a;
  if (Number.isFinite(msB)) return b;
  return a >= b ? a : b;
}

export interface MergeStorefrontGamesOptions {
  authoritativeComplete?: boolean;
}

export function mergeStorefrontGames(
  currentCatalog: CanonicalGame[],
  newGames: CanonicalGame[],
  storefrontId: StorefrontId,
  options?: MergeStorefrontGamesOptions
): CanonicalGame[] {
  const userOverrides = loadUserOverrides();
  const verifiedIncoming = newGames.filter((g) => g && g.isVerifiedEntitlement === true);
  const isAuthoritativeReplaceable =
    (options?.authoritativeComplete === true &&
      (storefrontId === 'gog' || storefrontId === 'epic' || storefrontId === 'xbox')) ||
    (storefrontId === 'xbox' &&
      options?.authoritativeComplete === undefined &&
      verifiedIncoming.length > 0);
  if (verifiedIncoming.length > 0 || isAuthoritativeReplaceable) {
    recordVerifiedUserEntitlements(storefrontId, verifiedIncoming, {
      replaceStorefront: isAuthoritativeReplaceable,
      preservedInstalledCatalog: isAuthoritativeReplaceable ? currentCatalog : undefined,
    });
  }
  // Skip redundant override application on incoming slice — applied cleanly once on merged output
  const sanitizedNew = sanitizeGameCatalog(newGames, { skipUserOverrides: true });

  const activeSyncedXboxKeys = new Set<string>();
  if (storefrontId === 'xbox') {
    for (const ng of sanitizedNew) {
      if (!ng) continue;
      const xp = ng.platforms?.find((p) => p.platformId === 'xbox');
      if (xp) {
        const k1 = normalizePlatformGameIdForLookup(xp.platformGameId);
        const k2 = normalizePlatformGameIdForLookup(xp.xboxProductId);
        const k3 = normalizePlatformGameIdForLookup(xp.xboxTitleId);
        const k4 = String(xp.packageFamilyName || '').trim().toLowerCase();
        if (k1) activeSyncedXboxKeys.add(k1);
        if (k2) activeSyncedXboxKeys.add(k2);
        if (k3) activeSyncedXboxKeys.add(k3);
        if (k4) activeSyncedXboxKeys.add(k4);
      }
      const nt = normalizeCanonicalTitle(ng.title);
      if (nt) activeSyncedXboxKeys.add(`title:${nt}`);
    }
  }

  const merged = currentCatalog.map((g) => {
    if (
      g.id.startsWith('steam-') &&
      g.steamAppId &&
      g.platforms.some((p) => p.platformId === 'steam' && p.platformGameId !== String(g.steamAppId))
    ) {
      return {
        ...g,
        platforms: g.platforms.map((p) => {
          if (p.platformId === 'steam' && p.platformGameId !== String(g.steamAppId)) {
            return {
              ...p,
              platformGameId: String(g.steamAppId),
              playtimeMinutes: 0,
              lastPlayed: undefined,
              achievements: undefined,
            };
          }
          return p;
        }),
      };
    }
    return g;
  });

  type IndexedCatalogMeta = {
    ovGameId?: string;
    ovSteamAppId?: number;
    storePlatIds: string[];
    steamAppId?: number;
    id: string;
    lowerTitle: string;
    normTitle: string;
    override?: ReturnType<typeof getUserOverrideForGame>;
  };

  const entryMeta: IndexedCatalogMeta[] = [];
  const byOverrideGameId = new Map<string, Set<number>>();
  const byOverrideSteamAppId = new Map<number, Set<number>>();
  const byStorePlatformGameId = new Map<string, Set<number>>();
  const bySteamAppId = new Map<number, Set<number>>();
  const byId = new Map<string, Set<number>>();
  const byLowerTitle = new Map<string, Set<number>>();
  const byNormTitle = new Map<string, Set<number>>();

  const addBucket = <K>(map: Map<K, Set<number>>, key: K, idx: number) => {
    let set = map.get(key);
    if (!set) {
      set = new Set<number>();
      map.set(key, set);
    }
    set.add(idx);
  };

  const removeBucket = <K>(map: Map<K, Set<number>>, key: K, idx: number) => {
    const set = map.get(key);
    if (set) {
      set.delete(idx);
      if (set.size === 0) map.delete(key);
    }
  };

  const unindexEntry = (idx: number) => {
    const meta = entryMeta[idx];
    if (!meta) return;
    if (meta.ovGameId) removeBucket(byOverrideGameId, meta.ovGameId, idx);
    if (meta.ovSteamAppId) removeBucket(byOverrideSteamAppId, meta.ovSteamAppId, idx);
    for (let i = 0; i < meta.storePlatIds.length; i++) {
      removeBucket(byStorePlatformGameId, meta.storePlatIds[i], idx);
    }
    if (meta.steamAppId) removeBucket(bySteamAppId, meta.steamAppId, idx);
    if (meta.id) removeBucket(byId, meta.id, idx);
    if (meta.lowerTitle) removeBucket(byLowerTitle, meta.lowerTitle, idx);
    if (meta.normTitle) removeBucket(byNormTitle, meta.normTitle, idx);
  };

  const indexEntry = (idx: number, g: CanonicalGame) => {
    const ov = getUserOverrideForGame(g, userOverrides);
    const storePlatIds: string[] = [];
    for (let i = 0; i < g.platforms.length; i++) {
      const p = g.platforms[i];
      if (p.platformId === storefrontId) {
        const pid = String(p.platformGameId || '').trim();
        if (pid) storePlatIds.push(pid);
        if (storefrontId === 'xbox') {
          const xBigId = String(p.xboxProductId || '').trim();
          const xPfn = String(p.packageFamilyName || '').trim().toLowerCase();
          const xTitleId = String(p.xboxTitleId || '').trim();
          if (xBigId && !storePlatIds.includes(xBigId)) storePlatIds.push(xBigId);
          if (xPfn && !storePlatIds.includes(xPfn)) storePlatIds.push(xPfn);
          if (xTitleId && !storePlatIds.includes(xTitleId)) storePlatIds.push(xTitleId);
        }
      }
    }
    const meta: IndexedCatalogMeta = {
      ovGameId: ov?.gameId || undefined,
      ovSteamAppId: ov?.steamAppId || undefined,
      storePlatIds,
      steamAppId: g.steamAppId || undefined,
      id: g.id || '',
      lowerTitle: g.title.toLowerCase().trim(),
      normTitle: normalizeCanonicalTitle(g.title),
      override: ov,
    };
    entryMeta[idx] = meta;
    if (meta.ovGameId) addBucket(byOverrideGameId, meta.ovGameId, idx);
    if (meta.ovSteamAppId) addBucket(byOverrideSteamAppId, meta.ovSteamAppId, idx);
    for (let i = 0; i < storePlatIds.length; i++) {
      addBucket(byStorePlatformGameId, storePlatIds[i], idx);
    }
    if (meta.steamAppId) addBucket(bySteamAppId, meta.steamAppId, idx);
    if (meta.id) addBucket(byId, meta.id, idx);
    if (meta.lowerTitle) addBucket(byLowerTitle, meta.lowerTitle, idx);
    if (meta.normTitle) addBucket(byNormTitle, meta.normTitle, idx);
  };

  for (let i = 0; i < merged.length; i++) {
    indexEntry(i, merged[i]);
  }

  const matchedTargetIndices = new Set<number>();

  for (const newGame of sanitizedNew) {
    const newNorm = normalizeCanonicalTitle(newGame.title);
    const newLower = newGame.title.toLowerCase().trim();
    const platformOwnership = newGame.platforms.find((p) => p.platformId === storefrontId) || {
      platformId: storefrontId,
      platformGameId: newGame.id,
      installed: false,
    };
    const incomingPlatGameId = String(platformOwnership.platformGameId || '').trim();

    const candidateSet = new Set<number>();
    const collectSet = (set?: Set<number>) => {
      if (!set) return;
      for (const idx of set) candidateSet.add(idx);
    };

    if (newGame.id) collectSet(byOverrideGameId.get(newGame.id));
    if (newGame.steamAppId) {
      collectSet(byOverrideGameId.get(`steam-${newGame.steamAppId}`));
      collectSet(byOverrideSteamAppId.get(newGame.steamAppId));
    }
    const incomingLookupIds: string[] = [];
    if (incomingPlatGameId) incomingLookupIds.push(incomingPlatGameId);
    if (storefrontId === 'xbox') {
      const incBigId = String(platformOwnership.xboxProductId || '').trim();
      const incPfn = String(platformOwnership.packageFamilyName || '').trim().toLowerCase();
      const incTitleId = String(platformOwnership.xboxTitleId || '').trim();
      if (incBigId && !incomingLookupIds.includes(incBigId)) incomingLookupIds.push(incBigId);
      if (incPfn && !incomingLookupIds.includes(incPfn)) incomingLookupIds.push(incPfn);
      if (incTitleId && !incomingLookupIds.includes(incTitleId)) incomingLookupIds.push(incTitleId);
    }
    // Match multi-storefront merged entries by exact store platformGameId (`g.platforms.some(...)`)
    // so already-merged Steam+GOG or Steam+Epic games still resolve even if a storefront title changed.
    for (const lookupId of incomingLookupIds) {
      const platMatches = byStorePlatformGameId.get(lookupId);
      if (platMatches) {
        for (const idx of platMatches) {
          const g = merged[idx];
          if (g.platforms.length > 0 && g.platforms.some((p) => p.platformId === storefrontId)) {
            candidateSet.add(idx);
          }
        }
      }
    }
    if (newGame.steamAppId) collectSet(bySteamAppId.get(newGame.steamAppId));
    if (newGame.id) collectSet(byId.get(newGame.id));
    if (newLower) collectSet(byLowerTitle.get(newLower));
    if (newNorm) collectSet(byNormTitle.get(newNorm));

    let existingIndex = -1;
    if (candidateSet.size > 0) {
      const sortedCandidates =
        candidateSet.size === 1
          ? [candidateSet.values().next().value as number]
          : Array.from(candidateSet).toSorted((a, b) => {
              const ga = merged[a];
              const gb = merged[b];
              const aHasOtherStore = Boolean(
                ga?.platforms?.some((p) => p.platformId !== storefrontId)
              );
              const bHasOtherStore = Boolean(
                gb?.platforms?.some((p) => p.platformId !== storefrontId)
              );
              if (aHasOtherStore !== bHasOtherStore) {
                return aHasOtherStore ? -1 : 1;
              }
              return a - b;
            });
      for (let c = 0; c < sortedCandidates.length; c++) {
        const candIdx = sortedCandidates[c];
        const g = merged[candIdx];
        if (!g || g.platforms.length === 0) continue;
        if (hasSameStorefrontConflict(g, newGame)) continue;
        if (hasSplitOverrideConflict(g, newGame, userOverrides)) continue;
        existingIndex = candIdx;
        break;
      }
    }

    const targetIndex = existingIndex >= 0 ? existingIndex : merged.length;
    matchedTargetIndices.add(targetIndex);

    if (existingIndex >= 0) {
      const existing = merged[existingIndex];
      const existingOverride = entryMeta[existingIndex]?.override;
      unindexEntry(existingIndex);
      const preferStorefrontTitle =
        existing.platforms.every((p) => p.platformId === storefrontId) &&
        !existingOverride?.title &&
        Boolean(newGame.title);
      const hasPlatform = existing.platforms.some((p) => p.platformId === storefrontId);
      const updatedPlatforms = hasPlatform
        ? existing.platforms.map((p) => {
            if (p.platformId !== storefrontId) return p;
            const mergedInstalled = Boolean(platformOwnership.installed || p.installed);
            const mergedInstallSize = mergedInstalled
              ? (sanitizeGameInstallSizeBytes(platformOwnership.installSize) ??
                sanitizeGameInstallSizeBytes(p.installSize))
              : sanitizeGameInstallSizeBytes(platformOwnership.installSize);

            const mergedOwnershipType: XboxOwnershipType | undefined =
              storefrontId === 'xbox'
                ? platformOwnership.ownershipType !== undefined
                  ? platformOwnership.ownershipType
                  : p.ownershipType
                : platformOwnership.ownershipType || p.ownershipType;

            const xboxOwnershipFields: Partial<GamePlatformOwnership> =
              storefrontId === 'xbox'
                ? mergedOwnershipType === 'owned'
                  ? {
                      ownershipType: 'owned',
                      gamePassTier: undefined,
                      satisfyingPassIds: undefined,
                      subscriptionTierId: undefined,
                      isLeavingSoon: undefined,
                      isRecentlyAddedToGamePass: undefined,
                      subscriptionExpired: false,
                    }
                  : mergedOwnershipType === 'subscription' ||
                    mergedOwnershipType === 'owned_and_subscription'
                  ? {
                      ownershipType: mergedOwnershipType,
                      gamePassTier:
                        platformOwnership.ownershipType !== undefined
                          ? platformOwnership.gamePassTier || undefined
                          : platformOwnership.gamePassTier || p.gamePassTier || undefined,
                      satisfyingPassIds:
                        platformOwnership.ownershipType !== undefined
                          ? platformOwnership.satisfyingPassIds || undefined
                          : platformOwnership.satisfyingPassIds || p.satisfyingPassIds || undefined,
                      subscriptionTierId:
                        platformOwnership.ownershipType !== undefined
                          ? platformOwnership.subscriptionTierId || undefined
                          : platformOwnership.subscriptionTierId || p.subscriptionTierId || undefined,
                      isLeavingSoon: Boolean(platformOwnership.isLeavingSoon) || undefined,
                      isRecentlyAddedToGamePass:
                        Boolean(platformOwnership.isRecentlyAddedToGamePass) || undefined,
                      subscriptionExpired:
                        mergedOwnershipType === 'owned_and_subscription'
                          ? undefined
                          : Boolean(platformOwnership.subscriptionExpired) || undefined,
                    }
                  : {
                      ownershipType: undefined,
                      gamePassTier: platformOwnership.gamePassTier || undefined,
                      satisfyingPassIds: platformOwnership.satisfyingPassIds || undefined,
                      subscriptionTierId: platformOwnership.subscriptionTierId || undefined,
                      isLeavingSoon: Boolean(platformOwnership.isLeavingSoon) || undefined,
                      isRecentlyAddedToGamePass:
                        Boolean(platformOwnership.isRecentlyAddedToGamePass) || undefined,
                      subscriptionExpired:
                        Boolean(platformOwnership.subscriptionExpired) || undefined,
                    }
                : {
                    ...(mergedOwnershipType ? { ownershipType: mergedOwnershipType } : {}),
                    ...(platformOwnership.gamePassTier || p.gamePassTier
                      ? { gamePassTier: platformOwnership.gamePassTier || p.gamePassTier }
                      : {}),
                    ...(platformOwnership.satisfyingPassIds || p.satisfyingPassIds
                      ? {
                          satisfyingPassIds:
                            platformOwnership.satisfyingPassIds || p.satisfyingPassIds,
                        }
                      : {}),
                    ...(platformOwnership.subscriptionTierId || p.subscriptionTierId
                      ? {
                          subscriptionTierId:
                            platformOwnership.subscriptionTierId || p.subscriptionTierId,
                        }
                      : {}),
                    ...(platformOwnership.isLeavingSoon !== undefined || p.isLeavingSoon !== undefined
                      ? { isLeavingSoon: platformOwnership.isLeavingSoon ?? p.isLeavingSoon }
                      : {}),
                    ...(platformOwnership.isRecentlyAddedToGamePass !== undefined ||
                    p.isRecentlyAddedToGamePass !== undefined
                      ? {
                          isRecentlyAddedToGamePass:
                            platformOwnership.isRecentlyAddedToGamePass ??
                            p.isRecentlyAddedToGamePass,
                        }
                      : {}),
                  };

            const nextPlaytimeMinutes =
              storefrontId === 'steam' &&
              newGame.isVerifiedEntitlement &&
              platformOwnership.playtimeMinutes !== undefined
                ? platformOwnership.playtimeMinutes
                : storefrontId === 'xbox' &&
                  (p.playtimeMinutes !== undefined || platformOwnership.playtimeMinutes !== undefined)
                ? Math.max(p.playtimeMinutes ?? 0, platformOwnership.playtimeMinutes ?? 0)
                : platformOwnership.playtimeMinutes !== undefined &&
                  platformOwnership.playtimeMinutes > 0
                ? platformOwnership.playtimeMinutes
                : p.playtimeMinutes;

            const rawMergedHandoff =
              platformOwnership.chainedLauncherHandoff ||
              platformOwnership.externalStorefrontHandoff ||
              p.chainedLauncherHandoff ||
              p.externalStorefrontHandoff;
            const normalizedMergedHandoff = normalizeChainedHandoffId(rawMergedHandoff);
            const handoffSyncFields: Partial<GamePlatformOwnership> = normalizedMergedHandoff
              ? {
                  chainedLauncherHandoff: normalizedMergedHandoff,
                  externalStorefrontHandoff: normalizedMergedHandoff,
                }
              : rawMergedHandoff
              ? {
                  chainedLauncherHandoff:
                    platformOwnership.chainedLauncherHandoff ||
                    p.chainedLauncherHandoff ||
                    String(rawMergedHandoff).trim(),
                  externalStorefrontHandoff: (platformOwnership.externalStorefrontHandoff ||
                    p.externalStorefrontHandoff ||
                    String(rawMergedHandoff).trim()) as StorefrontId | 'riot',
                }
              : {};

            const nextPlat: GamePlatformOwnership = sanitizePlatformOwnershipOsFlags({
              ...p,
              platformGameId: platformOwnership.platformGameId || p.platformGameId,
              storefrontAppId: platformOwnership.storefrontAppId || p.storefrontAppId,
              namespace: platformOwnership.namespace || p.namespace,
              catalogItemId: platformOwnership.catalogItemId || p.catalogItemId,
              ...(platformOwnership.xboxProductId || p.xboxProductId
                ? { xboxProductId: platformOwnership.xboxProductId || p.xboxProductId }
                : {}),
              ...(platformOwnership.packageFamilyName || p.packageFamilyName
                ? { packageFamilyName: platformOwnership.packageFamilyName || p.packageFamilyName }
                : {}),
              ...(platformOwnership.appUserModelId || p.appUserModelId
                ? { appUserModelId: platformOwnership.appUserModelId || p.appUserModelId }
                : {}),
              ...(platformOwnership.xboxTitleId || p.xboxTitleId
                ? { xboxTitleId: platformOwnership.xboxTitleId || p.xboxTitleId }
                : {}),
              ...(platformOwnership.scid || p.scid ? { scid: platformOwnership.scid || p.scid } : {}),
              ...(platformOwnership.msaAppId || p.msaAppId
                ? { msaAppId: platformOwnership.msaAppId || p.msaAppId }
                : {}),
              ...xboxOwnershipFields,
              ...(platformOwnership.isCrossPlatformLauncherRuntime !== undefined ||
              p.isCrossPlatformLauncherRuntime !== undefined
                ? {
                    isCrossPlatformLauncherRuntime:
                      platformOwnership.isCrossPlatformLauncherRuntime ??
                      p.isCrossPlatformLauncherRuntime,
                  }
                : {}),
              ...(platformOwnership.isExternalLauncherStubPackage !== undefined ||
              p.isExternalLauncherStubPackage !== undefined
                ? {
                    isExternalLauncherStubPackage:
                      platformOwnership.isExternalLauncherStubPackage ??
                      p.isExternalLauncherStubPackage,
                  }
                : {}),
              ...(platformOwnership.externalLauncher || p.externalLauncher
                ? { externalLauncher: platformOwnership.externalLauncher || p.externalLauncher }
                : {}),
              ...(platformOwnership.externalLauncherUrl || p.externalLauncherUrl
                ? {
                    externalLauncherUrl:
                      platformOwnership.externalLauncherUrl || p.externalLauncherUrl,
                  }
                : {}),
              ...(platformOwnership.xboxBottleCompatibilityReason ||
              p.xboxBottleCompatibilityReason
                ? {
                    xboxBottleCompatibilityReason:
                      platformOwnership.xboxBottleCompatibilityReason ||
                      p.xboxBottleCompatibilityReason,
                  }
                : {}),
              ...(platformOwnership.maxDownloadSizeBytes !== undefined ||
              p.maxDownloadSizeBytes !== undefined
                ? {
                    maxDownloadSizeBytes:
                      platformOwnership.maxDownloadSizeBytes ?? p.maxDownloadSizeBytes,
                  }
                : {}),
              ...(platformOwnership.pcMaxInstallSizeBytes !== undefined ||
              p.pcMaxInstallSizeBytes !== undefined
                ? {
                    pcMaxInstallSizeBytes:
                      platformOwnership.pcMaxInstallSizeBytes ?? p.pcMaxInstallSizeBytes,
                  }
                : {}),
              ...handoffSyncFields,
              ...(platformOwnership.chainedExternalInstallId || p.chainedExternalInstallId
                ? {
                    chainedExternalInstallId:
                      platformOwnership.chainedExternalInstallId || p.chainedExternalInstallId,
                  }
                : {}),
              ...(platformOwnership.chainedHandoffTopology || p.chainedHandoffTopology
                ? {
                    chainedHandoffTopology:
                      platformOwnership.chainedHandoffTopology || p.chainedHandoffTopology,
                  }
                : {}),
              ...(platformOwnership.epicPartnerRegistryPath || p.epicPartnerRegistryPath
                ? {
                    epicPartnerRegistryPath:
                      platformOwnership.epicPartnerRegistryPath || p.epicPartnerRegistryPath,
                  }
                : {}),
              ...(platformOwnership.requiresKernelAntiCheat !== undefined ||
              p.requiresKernelAntiCheat !== undefined
                ? {
                    requiresKernelAntiCheat:
                      platformOwnership.requiresKernelAntiCheat ?? p.requiresKernelAntiCheat,
                  }
                : {}),
              ...(platformOwnership.kernelAntiCheatName || p.kernelAntiCheatName
                ? {
                    kernelAntiCheatName:
                      platformOwnership.kernelAntiCheatName || p.kernelAntiCheatName,
                  }
                : {}),
              ...(platformOwnership.antiCheatName || p.antiCheatName
                ? { antiCheatName: platformOwnership.antiCheatName || p.antiCheatName }
                : {}),
              ...(platformOwnership.xboxBottleCompatibilityTier || p.xboxBottleCompatibilityTier
                ? {
                    xboxBottleCompatibilityTier:
                      platformOwnership.xboxBottleCompatibilityTier ||
                      p.xboxBottleCompatibilityTier,
                  }
                : {}),
              platforms: platformOwnership.platforms || p.platforms,
              installed: mergedInstalled,
              installPath: platformOwnership.installPath || p.installPath,
              executablePath: platformOwnership.executablePath || p.executablePath,
              version: platformOwnership.version || p.version,
              launchArguments: platformOwnership.launchArguments || p.launchArguments,
              isWindowsBinaryOnMac: platformOwnership.isWindowsBinaryOnMac ?? p.isWindowsBinaryOnMac,
              lastPlayed:
                storefrontId === 'steam' && newGame.isVerifiedEntitlement
                  ? platformOwnership.lastPlayed
                  : pickNewerLastPlayed(platformOwnership.lastPlayed, p.lastPlayed),
              playtimeMinutes: nextPlaytimeMinutes,
              achievements: (() => {
                const reconciled = reconcileAchievementSummaries(
                  p.achievements,
                  platformOwnership.achievements,
                  { title: newGame.title, appId: newGame.steamAppId, store: storefrontId }
                );
                return areAchievementSummariesSubstantivelyEqual(p.achievements, reconciled)
                  ? p.achievements
                  : reconciled;
              })(),
            });
            if (mergedInstallSize !== undefined) {
              nextPlat.installSize = mergedInstallSize;
            } else {
              delete nextPlat.installSize;
            }
            return arePlatformOwnershipsEqual(p, nextPlat) ? p : nextPlat;
          })
        : [
            ...existing.platforms,
            sanitizePlatformOwnershipOsFlags(
              storefrontId === 'xbox' && platformOwnership.ownershipType === 'owned'
                ? {
                    ...platformOwnership,
                    gamePassTier: undefined,
                    satisfyingPassIds: undefined,
                    subscriptionTierId: undefined,
                    isLeavingSoon: undefined,
                    isRecentlyAddedToGamePass: undefined,
                    subscriptionExpired: false,
                  }
                : storefrontId === 'xbox' &&
                  platformOwnership.ownershipType === 'owned_and_subscription'
                ? { ...platformOwnership, subscriptionExpired: undefined }
                : platformOwnership
            ),
          ];

      const platformsRef =
        hasPlatform &&
        updatedPlatforms.length === existing.platforms.length &&
        updatedPlatforms.every((p, idx) => p === existing.platforms[idx])
          ? existing.platforms
          : updatedPlatforms;

      const mergedSteamAppId = existing.isExplicitNonSteam
        ? undefined
        : existing.steamAppId || newGame.steamAppId;

      const gogPlatForArt = platformsRef.find((p) => p.platformId === 'gog');
      const artworkCtx: ArtworkRecoveryContext = {
        gameId: existing.id,
        title: existing.title,
        steamAppId: mergedSteamAppId,
        gogId: gogPlatForArt?.platformGameId,
        userOverrideCapsule: existingOverride?.capsuleImage,
        userOverrideHeader: existingOverride?.headerImage,
      };
      const nextHeaderImage =
        reconcileHeaderImage(existing.headerImage, newGame.headerImage, artworkCtx) ||
        existing.headerImage ||
        newGame.headerImage;
      const nextCapsuleImage = reconcileCapsuleImage(
        existing.capsuleImage,
        newGame.capsuleImage,
        { ...artworkCtx, headerUrl: nextHeaderImage }
      );
      const nextIconUrl = !isUnsuitableHeaderUrl(existing.iconUrl)
        ? existing.iconUrl
        : newGame.iconUrl || newGame.capsuleImage || newGame.headerImage || existing.iconUrl;

      const nextTitle = preferStorefrontTitle ? newGame.title : existing.title;
      const nextSortTitle = preferStorefrontTitle
        ? newGame.sortTitle || existing.sortTitle
        : existing.sortTitle;
      const nextId = mergedSteamAppId ? `steam-${mergedSteamAppId}` : existing.id;
      const nextDevelopers =
        existing.developers && existing.developers.length > 0
          ? existing.developers
          : newGame.developers;
      const nextPublishers =
        existing.publishers && existing.publishers.length > 0
          ? existing.publishers
          : newGame.publishers;
      const nextGenres =
        existing.genres && existing.genres.length > 0 ? existing.genres : newGame.genres;
      const nextTags = (() => {
        if (storefrontId !== 'xbox') {
          return existing.tags && existing.tags.length > 0 ? existing.tags : newGame.tags;
        }
        const updatedXboxPlat = platformsRef.find((p) => p.platformId === 'xbox');
        const existingNonSubTags = Array.isArray(existing.tags)
          ? existing.tags.filter((t) => !XBOX_SUBSCRIPTION_TAG_RE.test(String(t || '').trim()))
          : [];
        const incomingNonSubTags = Array.isArray(newGame.tags)
          ? newGame.tags.filter((t) => !XBOX_SUBSCRIPTION_TAG_RE.test(String(t || '').trim()))
          : [];
        const baseNonSubTags =
          existingNonSubTags.length > 0 ? existingNonSubTags : incomingNonSubTags;

        const deduped: string[] = [];
        const seenLower = new Set<string>();
        for (const tag of baseNonSubTags) {
          const trimmed = String(tag || '').trim();
          if (!trimmed) continue;
          const key = trimmed.toLowerCase();
          if (!seenLower.has(key)) {
            seenLower.add(key);
            deduped.push(trimmed);
          }
        }

        if (updatedXboxPlat?.ownershipType !== 'owned' && !updatedXboxPlat?.subscriptionExpired) {
          const incomingSubTags = Array.isArray(newGame.tags)
            ? newGame.tags.filter((t) => XBOX_SUBSCRIPTION_TAG_RE.test(String(t || '').trim()))
            : [];
          for (const subTag of incomingSubTags) {
            const trimmed = String(subTag || '').trim();
            if (!trimmed) continue;
            if (/^leaving\s+soon$/i.test(trimmed) && !updatedXboxPlat?.isLeavingSoon) {
              continue;
            }
            if (
              /^recently\s+added$/i.test(trimmed) &&
              !updatedXboxPlat?.isRecentlyAddedToGamePass
            ) {
              continue;
            }
            const key = trimmed.toLowerCase();
            if (!seenLower.has(key)) {
              seenLower.add(key);
              deduped.push(trimmed);
            }
          }
        }

        return areStringArraysEqual(existing.tags, deduped) ? existing.tags : deduped;
      })();
      const nextShortDescription = existing.shortDescription || newGame.shortDescription;
      const nextDetailedDescription = pickPreferredDetailedDescription(
        existing.detailedDescription,
        newGame.detailedDescription
      );
      const nextReleaseDate =
        pickPreferredReleaseDate(existing.releaseDate, newGame.releaseDate) ||
        existing.releaseDate ||
        newGame.releaseDate;
      const nextReviewSummary = existing.reviewSummary || newGame.reviewSummary;
      const nextIsVerifiedEntitlement =
        existing.isVerifiedEntitlement || newGame.isVerifiedEntitlement;
      const nextMatchConfidence = existing.matchConfidence ?? newGame.matchConfidence;
      const nextNeedsMatchReview = existing.needsMatchReview ?? newGame.needsMatchReview;
      const nextRequiresKernelAntiCheat =
        existing.requiresKernelAntiCheat || newGame.requiresKernelAntiCheat;
      const nextKernelAntiCheatName =
        existing.kernelAntiCheatName || newGame.kernelAntiCheatName;
      const nextAntiCheatName = existing.antiCheatName || newGame.antiCheatName;
      const nextEnrichedMetadata = pickBestEnrichedMetadata(
        existing.enrichedMetadata,
        newGame.enrichedMetadata
      );

      const gameUnchanged =
        nextTitle === existing.title &&
        nextSortTitle === existing.sortTitle &&
        nextHeaderImage === existing.headerImage &&
        nextCapsuleImage === existing.capsuleImage &&
        nextIconUrl === existing.iconUrl &&
        mergedSteamAppId === existing.steamAppId &&
        nextId === existing.id &&
        platformsRef === existing.platforms &&
        areStringArraysEqual(nextDevelopers, existing.developers) &&
        areStringArraysEqual(nextPublishers, existing.publishers) &&
        areStringArraysEqual(nextGenres, existing.genres) &&
        areStringArraysEqual(nextTags, existing.tags) &&
        nextShortDescription === existing.shortDescription &&
        nextDetailedDescription === existing.detailedDescription &&
        nextReleaseDate === existing.releaseDate &&
        nextReviewSummary === existing.reviewSummary &&
        nextIsVerifiedEntitlement === existing.isVerifiedEntitlement &&
        nextMatchConfidence === existing.matchConfidence &&
        nextNeedsMatchReview === existing.needsMatchReview &&
        nextRequiresKernelAntiCheat === existing.requiresKernelAntiCheat &&
        nextKernelAntiCheatName === existing.kernelAntiCheatName &&
        nextAntiCheatName === existing.antiCheatName &&
        nextEnrichedMetadata === existing.enrichedMetadata;

      merged[existingIndex] = gameUnchanged
        ? existing
        : {
            ...existing,
            title: nextTitle,
            sortTitle: nextSortTitle,
            headerImage: nextHeaderImage,
            capsuleImage: nextCapsuleImage,
            iconUrl: nextIconUrl,
            steamAppId: mergedSteamAppId,
            id: nextId,
            platforms: platformsRef,
            developers: nextDevelopers,
            publishers: nextPublishers,
            genres: nextGenres,
            tags: nextTags,
            shortDescription: nextShortDescription,
            detailedDescription: nextDetailedDescription,
            releaseDate: nextReleaseDate,
            reviewSummary: nextReviewSummary,
            isVerifiedEntitlement: nextIsVerifiedEntitlement,
            matchConfidence: nextMatchConfidence,
            needsMatchReview: nextNeedsMatchReview,
            ...(nextRequiresKernelAntiCheat
              ? { requiresKernelAntiCheat: nextRequiresKernelAntiCheat }
              : {}),
            ...(nextKernelAntiCheatName ? { kernelAntiCheatName: nextKernelAntiCheatName } : {}),
            ...(nextAntiCheatName ? { antiCheatName: nextAntiCheatName } : {}),
            enrichedMetadata: nextEnrichedMetadata,
          };

      if (existingOverride) {
        merged[existingIndex] = applyUserOverrideToGame(merged[existingIndex], existingOverride);
      }
      indexEntry(existingIndex, merged[existingIndex]);
    } else {
      const insertedOwnership = sanitizePlatformOwnershipOsFlags(
        storefrontId === 'xbox' && platformOwnership.ownershipType === 'owned'
          ? {
              ...platformOwnership,
              gamePassTier: undefined,
              satisfyingPassIds: undefined,
              subscriptionTierId: undefined,
              isLeavingSoon: undefined,
              isRecentlyAddedToGamePass: undefined,
              subscriptionExpired: false,
            }
          : storefrontId === 'xbox' &&
            platformOwnership.ownershipType === 'owned_and_subscription'
          ? { ...platformOwnership, subscriptionExpired: undefined }
          : platformOwnership
      );
      const inserted: CanonicalGame = {
        ...newGame,
        platforms: [insertedOwnership],
      };
      merged.push(inserted);
      indexEntry(targetIndex, inserted);
    }

    // Ensure platformOwnership.platformGameId is not left attached to any other entry in merged
    const assignedGameId = String(platformOwnership.platformGameId || '').trim();
    if (assignedGameId) {
      const owners = byStorePlatformGameId.get(assignedGameId);
      if (owners && (owners.size > 1 || !owners.has(targetIndex))) {
        for (const otherIdx of Array.from(owners)) {
          if (otherIdx === targetIndex) continue;
          const other = merged[otherIdx];
          unindexEntry(otherIdx);
          merged[otherIdx] = {
            ...other,
            platforms: other.platforms.filter(
              (p) =>
                !(
                  p.platformId === storefrontId &&
                  String(p.platformGameId || '').trim() === assignedGameId
                )
            ),
          };
          if (merged[otherIdx].platforms.length > 0) {
            indexEntry(otherIdx, merged[otherIdx]);
          }
        }
      }
    }
  }

  const candidateOrphanVaultIds = new Set<string>();

  // Strict Active-Access Gate for Xbox Game Pass rotation / subscription expiry
  if (storefrontId === 'xbox' && options?.authoritativeComplete !== false) {
    for (let idx = 0; idx < merged.length; idx++) {
      if (matchedTargetIndices.has(idx)) continue;
      const g = merged[idx];
      if (!g || !Array.isArray(g.platforms) || !g.platforms.some((p) => p.platformId === 'xbox')) {
        continue;
      }
      const nextPlats: GamePlatformOwnership[] = [];
      let platChanged = false;
      for (const p of g.platforms) {
        if (p.platformId !== 'xbox') {
          nextPlats.push(p);
          continue;
        }
        const k1 = normalizePlatformGameIdForLookup(p.platformGameId);
        const k2 = normalizePlatformGameIdForLookup(p.xboxProductId);
        const k3 = normalizePlatformGameIdForLookup(p.xboxTitleId);
        const k4 = String(p.packageFamilyName || '').trim().toLowerCase();
        const nt = normalizeCanonicalTitle(g.title);
        const stillInActiveSync =
          (k1 && activeSyncedXboxKeys.has(k1)) ||
          (k2 && activeSyncedXboxKeys.has(k2)) ||
          (k3 && activeSyncedXboxKeys.has(k3)) ||
          (k4 && activeSyncedXboxKeys.has(k4)) ||
          (nt && activeSyncedXboxKeys.has(`title:${nt}`));
        if (stillInActiveSync) {
          nextPlats.push(p);
          continue;
        }
        if (p.ownershipType === 'owned' || p.ownershipType === 'owned_and_subscription') {
          if (
            p.ownershipType !== 'owned' ||
            p.subscriptionExpired !== false ||
            p.gamePassTier !== undefined ||
            p.satisfyingPassIds !== undefined ||
            p.subscriptionTierId !== undefined ||
            p.isLeavingSoon !== undefined ||
            p.isRecentlyAddedToGamePass !== undefined
          ) {
            platChanged = true;
            nextPlats.push({
              ...p,
              ownershipType: 'owned',
              gamePassTier: undefined,
              satisfyingPassIds: undefined,
              subscriptionTierId: undefined,
              isLeavingSoon: undefined,
              isRecentlyAddedToGamePass: undefined,
              subscriptionExpired: false,
            });
          } else {
            nextPlats.push(p);
          }
        } else if (p.installed || hasLocalInstallMetadata(p)) {
          const targetOwnership = p.ownershipType || 'subscription';
          if (
            p.ownershipType !== targetOwnership ||
            p.subscriptionExpired !== true ||
            p.isLeavingSoon !== undefined ||
            p.isRecentlyAddedToGamePass !== undefined
          ) {
            platChanged = true;
            nextPlats.push({
              ...p,
              ownershipType: targetOwnership,
              subscriptionExpired: true,
              isLeavingSoon: undefined,
              isRecentlyAddedToGamePass: undefined,
            });
          } else {
            nextPlats.push(p);
          }
        } else {
          platChanged = true;
          const rawPid = String(p.platformGameId || '').trim();
          const normPid = normalizePlatformGameIdForLookup(p.platformGameId);
          const rawXboxProductId = String(p.xboxProductId || '').trim();
          const normXboxProductId = normalizePlatformGameIdForLookup(p.xboxProductId);
          if (rawPid) candidateOrphanVaultIds.add(`xbox-${rawPid}`);
          if (normPid) {
            candidateOrphanVaultIds.add(`xbox-${normPid}`);
            candidateOrphanVaultIds.add(`xbox-${normPid.toUpperCase()}`);
          }
          if (rawXboxProductId) candidateOrphanVaultIds.add(`xbox-${rawXboxProductId}`);
          if (normXboxProductId) {
            candidateOrphanVaultIds.add(`xbox-${normXboxProductId}`);
            candidateOrphanVaultIds.add(`xbox-${normXboxProductId.toUpperCase()}`);
          }
        }
      }
      if (nextPlats.length === 0 && g.id) {
        candidateOrphanVaultIds.add(g.id);
      }
      if (platChanged) {
        const downgradedXboxPlat = nextPlats.find((p) => p.platformId === 'xbox');
        const cleanedTags =
          Array.isArray(g.tags) && g.tags.length > 0
            ? downgradedXboxPlat?.ownershipType === 'owned'
              ? g.tags.filter((t) => !XBOX_SUBSCRIPTION_TAG_RE.test(String(t || '').trim()))
              : g.tags.filter(
                  (t) => !/^(?:leaving\s+soon|recently\s+added)$/i.test(String(t || '').trim())
                )
            : g.tags;
        merged[idx] = {
          ...g,
          platforms: nextPlats,
          tags: cleanedTags,
        };
      }
    }
  }

  if (
    options?.authoritativeComplete === true &&
    (storefrontId === 'gog' || storefrontId === 'epic')
  ) {
    const activeSyncedIds = new Set<string>();
    for (const ng of sanitizedNew) {
      if (!ng) continue;
      let foundStorePlat = false;
      for (const np of ng.platforms || []) {
        if (!np || np.platformId !== storefrontId) continue;
        foundStorePlat = true;
        const normPid = normalizePlatformGameIdForLookup(np.platformGameId);
        const normStoreId = normalizePlatformGameIdForLookup(np.storefrontAppId);
        if (normPid) activeSyncedIds.add(normPid);
        if (normStoreId) activeSyncedIds.add(normStoreId);
      }
      if (!foundStorePlat && ng.id) {
        const fallbackId = normalizePlatformGameIdForLookup(ng.id);
        if (fallbackId) activeSyncedIds.add(fallbackId);
      }
    }

    for (let idx = 0; idx < merged.length; idx++) {
      const g = merged[idx];
      if (
        !g ||
        !Array.isArray(g.platforms) ||
        !g.platforms.some((p) => p.platformId === storefrontId)
      ) {
        continue;
      }
      const nextPlats: GamePlatformOwnership[] = [];
      for (const p of g.platforms) {
        if (p.platformId !== storefrontId) {
          nextPlats.push(p);
          continue;
        }
        const normPid = normalizePlatformGameIdForLookup(p.platformGameId);
        const normStoreId = normalizePlatformGameIdForLookup(p.storefrontAppId);
        if (
          (normPid && activeSyncedIds.has(normPid)) ||
          (normStoreId && activeSyncedIds.has(normStoreId))
        ) {
          nextPlats.push(p);
        } else if (p.installed || hasLocalInstallMetadata(p)) {
          // NEVER prune a locally installed game!
          nextPlats.push(p);
        } else {
          const rawPid = String(p.platformGameId || '').trim();
          if (rawPid) candidateOrphanVaultIds.add(`${storefrontId}-${rawPid}`);
          if (normPid) candidateOrphanVaultIds.add(`${storefrontId}-${normPid}`);
        }
      }
      if (nextPlats.length === 0) {
        if (g.id) candidateOrphanVaultIds.add(g.id);
        merged[idx] = {
          ...g,
          platforms: [],
        };
      } else if (nextPlats.length !== g.platforms.length) {
        merged[idx] = {
          ...g,
          platforms: nextPlats,
        };
      }
    }
  }

  const nonEmptyMerged = merged.filter((g) => g.platforms && g.platforms.length > 0);
  // Single authoritative sanitize + override pass (eliminates redundant applyUserOverridesToCatalog churn)
  const finalCatalog = preserveLocalInstallFieldsAcrossSanitize(
    nonEmptyMerged,
    sanitizeGameCatalog(nonEmptyMerged)
  );
  const finalMerged = finalCatalog.toSorted((a, b) =>
    LIBRARY_TITLE_COLLATOR.compare(a.title, b.title)
  );

  if (candidateOrphanVaultIds.size > 0) {
    const survivingIds = new Set(finalMerged.map((fg) => fg.id));
    const prunedVaultIds: string[] = [];
    for (const id of candidateOrphanVaultIds) {
      if (id && !survivingIds.has(id)) {
        prunedVaultIds.push(id);
      }
    }
    if (prunedVaultIds.length > 0) {
      deleteOrphanedGamesFromOfflineVault(prunedVaultIds);
    }
  }

  return finalMerged;
}

export function mergeUpdatedGamePreservingLivePlatformState(
  liveGame: CanonicalGame,
  incomingGame: CanonicalGame
): CanonicalGame {
  if (!liveGame) return incomingGame;
  if (!incomingGame) return liveGame;

  const bestEnriched = pickBestEnrichedMetadata(
    liveGame.enrichedMetadata,
    incomingGame.enrichedMetadata
  );
  const enrichedChanged = bestEnriched !== incomingGame.enrichedMetadata;

  if (!Array.isArray(liveGame.platforms) || liveGame.platforms.length === 0) {
    return enrichedChanged ? { ...incomingGame, enrichedMetadata: bestEnriched } : incomingGame;
  }

  const incomingPlatforms = Array.isArray(incomingGame.platforms) ? incomingGame.platforms : [];
  let platformsChanged = false;

  const mergedPlatforms: GamePlatformOwnership[] = incomingPlatforms.map((incPlat) => {
    const livePlat = liveGame.platforms.find((lp) => lp.platformId === incPlat.platformId);
    if (!livePlat) {
      const sanitizedIncOnlySize = sanitizeGameInstallSizeBytes(incPlat.installSize);
      if (incPlat.installSize === sanitizedIncOnlySize) return incPlat;
      platformsChanged = true;
      const cleanedInc: GamePlatformOwnership = { ...incPlat };
      if (sanitizedIncOnlySize !== undefined) {
        cleanedInc.installSize = sanitizedIncOnlySize;
      } else {
        delete cleanedInc.installSize;
      }
      return cleanedInc;
    }

    const nextInstalled = Boolean(livePlat.installed || incPlat.installed);
    const nextInstallPath = nextInstalled
      ? incPlat.installPath || livePlat.installPath
      : undefined;
    const nextExePath = nextInstalled
      ? incPlat.executablePath || livePlat.executablePath
      : undefined;
    const sanitizedIncSize = sanitizeGameInstallSizeBytes(incPlat.installSize);
    const sanitizedLiveSize = sanitizeGameInstallSizeBytes(livePlat.installSize);
    const nextInstallSize = nextInstalled
      ? (sanitizedIncSize ?? sanitizedLiveSize)
      : sanitizedIncSize;
    const nextVersion = nextInstalled ? incPlat.version || livePlat.version : undefined;
    const nextLaunchArgs = nextInstalled
      ? incPlat.launchArguments || livePlat.launchArguments
      : undefined;
    const nextWinOnMac = nextInstalled
      ? (incPlat.isWindowsBinaryOnMac ?? livePlat.isWindowsBinaryOnMac)
      : undefined;

    const livePlaytime = livePlat.playtimeMinutes ?? 0;
    const incPlaytime = incPlat.playtimeMinutes ?? 0;
    const nextPlaytime =
      livePlat.playtimeMinutes !== undefined || incPlat.playtimeMinutes !== undefined
        ? Math.max(livePlaytime, incPlaytime)
        : undefined;
    const nextLastPlayed = pickNewerLastPlayed(livePlat.lastPlayed, incPlat.lastPlayed);
    const rawReconciledAchievements = reconcileAchievementSummaries(
      livePlat.achievements,
      incPlat.achievements,
      {
        title: incomingGame.title || liveGame.title,
        appId: incomingGame.steamAppId || liveGame.steamAppId,
        store: incPlat.platformId,
      }
    );
    const nextAchievements = areAchievementSummariesSubstantivelyEqual(
      incPlat.achievements,
      rawReconciledAchievements
    )
      ? incPlat.achievements
      : rawReconciledAchievements;

    const nextStorefrontAppId = incPlat.storefrontAppId || livePlat.storefrontAppId;
    const nextNamespace = incPlat.namespace || livePlat.namespace;
    const nextCatalogItemId = incPlat.catalogItemId || livePlat.catalogItemId;
    const nextChainedHandoff = incPlat.chainedLauncherHandoff || livePlat.chainedLauncherHandoff;
    const nextExternalHandoff =
      incPlat.externalStorefrontHandoff || livePlat.externalStorefrontHandoff;
    const nextExternalLauncher = incPlat.externalLauncher || livePlat.externalLauncher;
    const nextExternalLauncherUrl = incPlat.externalLauncherUrl || livePlat.externalLauncherUrl;
    const nextChainedInstallId =
      incPlat.chainedExternalInstallId || livePlat.chainedExternalInstallId;
    const nextChainedTopology = incPlat.chainedHandoffTopology || livePlat.chainedHandoffTopology;
    const nextEpicPartnerReg = incPlat.epicPartnerRegistryPath || livePlat.epicPartnerRegistryPath;
    const nextReqAntiCheat = incPlat.requiresKernelAntiCheat ?? livePlat.requiresKernelAntiCheat;
    const nextKernelAntiCheatName = incPlat.kernelAntiCheatName || livePlat.kernelAntiCheatName;
    const nextAntiCheatName = incPlat.antiCheatName || livePlat.antiCheatName;
    const nextXboxCompatTier =
      incPlat.xboxBottleCompatibilityTier || livePlat.xboxBottleCompatibilityTier;
    const nextXboxCompatReason =
      incPlat.xboxBottleCompatibilityReason || livePlat.xboxBottleCompatibilityReason;
    const nextStubPkg =
      incPlat.isExternalLauncherStubPackage ?? livePlat.isExternalLauncherStubPackage;
    const nextCrossPlatLauncher =
      incPlat.isCrossPlatformLauncherRuntime ?? livePlat.isCrossPlatformLauncherRuntime;
    const nextMaxDlBytes = incPlat.maxDownloadSizeBytes ?? livePlat.maxDownloadSizeBytes;
    const nextPcMaxInstallBytes = incPlat.pcMaxInstallSizeBytes ?? livePlat.pcMaxInstallSizeBytes;
    const nextPlatOs = incPlat.platforms || livePlat.platforms;

    const nextXboxProductId = incPlat.xboxProductId || livePlat.xboxProductId;
    const nextPfn = incPlat.packageFamilyName || livePlat.packageFamilyName;
    const nextAumid = incPlat.appUserModelId || livePlat.appUserModelId;
    const nextXboxTitleId = incPlat.xboxTitleId || livePlat.xboxTitleId;
    const nextScid = incPlat.scid || livePlat.scid;
    const nextMsaAppId = incPlat.msaAppId || livePlat.msaAppId;

    const authXboxOwnershipPlat =
      incPlat.platformId === 'xbox'
        ? livePlat.ownershipType !== undefined
          ? livePlat
          : incPlat
        : undefined;
    const nextOwnershipType: XboxOwnershipType | undefined = authXboxOwnershipPlat
      ? authXboxOwnershipPlat.ownershipType
      : livePlat.ownershipType ?? incPlat.ownershipType;
    const nextGamePassTier: string | undefined = authXboxOwnershipPlat
      ? nextOwnershipType === 'owned'
        ? undefined
        : authXboxOwnershipPlat.gamePassTier || undefined
      : livePlat.gamePassTier ?? incPlat.gamePassTier;
    const rawNextSatisfyingPassIds: string[] | undefined = authXboxOwnershipPlat
      ? nextOwnershipType === 'owned'
        ? undefined
        : authXboxOwnershipPlat.satisfyingPassIds || undefined
      : livePlat.satisfyingPassIds ?? incPlat.satisfyingPassIds;
    const nextSatisfyingPassIds: string[] | undefined = areStringArraysEqual(
      incPlat.satisfyingPassIds,
      rawNextSatisfyingPassIds
    )
      ? incPlat.satisfyingPassIds
      : rawNextSatisfyingPassIds;
    const nextSubscriptionTierId: XboxSubscriptionTierId | undefined = authXboxOwnershipPlat
      ? nextOwnershipType === 'owned'
        ? undefined
        : authXboxOwnershipPlat.subscriptionTierId || undefined
      : livePlat.subscriptionTierId ?? incPlat.subscriptionTierId;
    const nextSubscriptionExpired: boolean | undefined = authXboxOwnershipPlat
      ? nextOwnershipType === 'owned'
        ? false
        : nextOwnershipType === 'owned_and_subscription'
        ? authXboxOwnershipPlat.subscriptionExpired === false
          ? false
          : undefined
        : authXboxOwnershipPlat.subscriptionExpired
        ? true
        : authXboxOwnershipPlat.subscriptionExpired === false
        ? false
        : undefined
      : livePlat.subscriptionExpired ?? incPlat.subscriptionExpired;
    const nextIsLeavingSoon: boolean | undefined = authXboxOwnershipPlat
      ? nextOwnershipType === 'owned' || nextSubscriptionExpired
        ? undefined
        : Boolean(authXboxOwnershipPlat.isLeavingSoon) || undefined
      : livePlat.isLeavingSoon ?? incPlat.isLeavingSoon;
    const nextIsRecentlyAddedToGamePass: boolean | undefined = authXboxOwnershipPlat
      ? nextOwnershipType === 'owned' || nextSubscriptionExpired
        ? undefined
        : Boolean(authXboxOwnershipPlat.isRecentlyAddedToGamePass) || undefined
      : livePlat.isRecentlyAddedToGamePass ?? incPlat.isRecentlyAddedToGamePass;

    if (
      Boolean(incPlat.installed) === nextInstalled &&
      incPlat.installPath === nextInstallPath &&
      incPlat.executablePath === nextExePath &&
      incPlat.installSize === nextInstallSize &&
      incPlat.version === nextVersion &&
      incPlat.launchArguments === nextLaunchArgs &&
      incPlat.isWindowsBinaryOnMac === nextWinOnMac &&
      incPlat.playtimeMinutes === nextPlaytime &&
      incPlat.lastPlayed === nextLastPlayed &&
      incPlat.achievements === nextAchievements &&
      incPlat.storefrontAppId === nextStorefrontAppId &&
      incPlat.namespace === nextNamespace &&
      incPlat.catalogItemId === nextCatalogItemId &&
      incPlat.chainedLauncherHandoff === nextChainedHandoff &&
      incPlat.externalStorefrontHandoff === nextExternalHandoff &&
      incPlat.externalLauncher === nextExternalLauncher &&
      incPlat.externalLauncherUrl === nextExternalLauncherUrl &&
      incPlat.chainedExternalInstallId === nextChainedInstallId &&
      incPlat.chainedHandoffTopology === nextChainedTopology &&
      incPlat.epicPartnerRegistryPath === nextEpicPartnerReg &&
      incPlat.requiresKernelAntiCheat === nextReqAntiCheat &&
      incPlat.kernelAntiCheatName === nextKernelAntiCheatName &&
      incPlat.antiCheatName === nextAntiCheatName &&
      incPlat.xboxBottleCompatibilityTier === nextXboxCompatTier &&
      incPlat.xboxBottleCompatibilityReason === nextXboxCompatReason &&
      incPlat.isExternalLauncherStubPackage === nextStubPkg &&
      incPlat.isCrossPlatformLauncherRuntime === nextCrossPlatLauncher &&
      incPlat.maxDownloadSizeBytes === nextMaxDlBytes &&
      incPlat.pcMaxInstallSizeBytes === nextPcMaxInstallBytes &&
      incPlat.platforms === nextPlatOs &&
      incPlat.xboxProductId === nextXboxProductId &&
      incPlat.packageFamilyName === nextPfn &&
      incPlat.appUserModelId === nextAumid &&
      incPlat.xboxTitleId === nextXboxTitleId &&
      incPlat.scid === nextScid &&
      incPlat.msaAppId === nextMsaAppId &&
      incPlat.ownershipType === nextOwnershipType &&
      incPlat.gamePassTier === nextGamePassTier &&
      incPlat.satisfyingPassIds === nextSatisfyingPassIds &&
      incPlat.subscriptionTierId === nextSubscriptionTierId &&
      incPlat.subscriptionExpired === nextSubscriptionExpired &&
      incPlat.isLeavingSoon === nextIsLeavingSoon &&
      incPlat.isRecentlyAddedToGamePass === nextIsRecentlyAddedToGamePass
    ) {
      return incPlat;
    }

    platformsChanged = true;
    const mergedP: GamePlatformOwnership = {
      ...incPlat,
      installed: nextInstalled,
      ...(nextPlaytime !== undefined ? { playtimeMinutes: nextPlaytime } : {}),
      ...(nextLastPlayed !== undefined ? { lastPlayed: nextLastPlayed } : {}),
      ...(nextAchievements !== undefined ? { achievements: nextAchievements } : {}),
      ...(nextStorefrontAppId !== undefined ? { storefrontAppId: nextStorefrontAppId } : {}),
      ...(nextNamespace !== undefined ? { namespace: nextNamespace } : {}),
      ...(nextCatalogItemId !== undefined ? { catalogItemId: nextCatalogItemId } : {}),
      ...(nextChainedHandoff !== undefined ? { chainedLauncherHandoff: nextChainedHandoff } : {}),
      ...(nextExternalHandoff !== undefined
        ? { externalStorefrontHandoff: nextExternalHandoff }
        : {}),
      ...(nextExternalLauncher !== undefined ? { externalLauncher: nextExternalLauncher } : {}),
      ...(nextExternalLauncherUrl !== undefined
        ? { externalLauncherUrl: nextExternalLauncherUrl }
        : {}),
      ...(nextChainedInstallId !== undefined
        ? { chainedExternalInstallId: nextChainedInstallId }
        : {}),
      ...(nextChainedTopology !== undefined ? { chainedHandoffTopology: nextChainedTopology } : {}),
      ...(nextEpicPartnerReg !== undefined ? { epicPartnerRegistryPath: nextEpicPartnerReg } : {}),
      ...(nextReqAntiCheat !== undefined ? { requiresKernelAntiCheat: nextReqAntiCheat } : {}),
      ...(nextKernelAntiCheatName !== undefined
        ? { kernelAntiCheatName: nextKernelAntiCheatName }
        : {}),
      ...(nextAntiCheatName !== undefined ? { antiCheatName: nextAntiCheatName } : {}),
      ...(nextXboxCompatTier !== undefined
        ? { xboxBottleCompatibilityTier: nextXboxCompatTier }
        : {}),
      ...(nextXboxCompatReason !== undefined
        ? { xboxBottleCompatibilityReason: nextXboxCompatReason }
        : {}),
      ...(nextStubPkg !== undefined ? { isExternalLauncherStubPackage: nextStubPkg } : {}),
      ...(nextCrossPlatLauncher !== undefined
        ? { isCrossPlatformLauncherRuntime: nextCrossPlatLauncher }
        : {}),
      ...(nextMaxDlBytes !== undefined ? { maxDownloadSizeBytes: nextMaxDlBytes } : {}),
      ...(nextPcMaxInstallBytes !== undefined
        ? { pcMaxInstallSizeBytes: nextPcMaxInstallBytes }
        : {}),
      ...(nextPlatOs !== undefined ? { platforms: nextPlatOs } : {}),
      ...(nextXboxProductId !== undefined ? { xboxProductId: nextXboxProductId } : {}),
      ...(nextPfn !== undefined ? { packageFamilyName: nextPfn } : {}),
      ...(nextAumid !== undefined ? { appUserModelId: nextAumid } : {}),
      ...(nextXboxTitleId !== undefined ? { xboxTitleId: nextXboxTitleId } : {}),
      ...(nextScid !== undefined ? { scid: nextScid } : {}),
      ...(nextMsaAppId !== undefined ? { msaAppId: nextMsaAppId } : {}),
      ...(incPlat.platformId === 'xbox'
        ? {
            ownershipType: nextOwnershipType,
            gamePassTier: nextGamePassTier,
            satisfyingPassIds: nextSatisfyingPassIds,
            subscriptionTierId: nextSubscriptionTierId,
            subscriptionExpired: nextSubscriptionExpired,
            isLeavingSoon: nextIsLeavingSoon,
            isRecentlyAddedToGamePass: nextIsRecentlyAddedToGamePass,
          }
        : {
            ...(nextOwnershipType !== undefined ? { ownershipType: nextOwnershipType } : {}),
            ...(nextGamePassTier !== undefined ? { gamePassTier: nextGamePassTier } : {}),
            ...(nextSatisfyingPassIds !== undefined
              ? { satisfyingPassIds: nextSatisfyingPassIds }
              : {}),
            ...(nextSubscriptionTierId !== undefined
              ? { subscriptionTierId: nextSubscriptionTierId }
              : {}),
            ...(nextSubscriptionExpired !== undefined
              ? { subscriptionExpired: nextSubscriptionExpired }
              : {}),
            ...(nextIsLeavingSoon !== undefined ? { isLeavingSoon: nextIsLeavingSoon } : {}),
            ...(nextIsRecentlyAddedToGamePass !== undefined
              ? { isRecentlyAddedToGamePass: nextIsRecentlyAddedToGamePass }
              : {}),
          }),
    };
    if (nextInstalled) {
      if (nextInstallPath !== undefined) mergedP.installPath = nextInstallPath;
      if (nextExePath !== undefined) mergedP.executablePath = nextExePath;
      if (nextInstallSize !== undefined) {
        mergedP.installSize = nextInstallSize;
      } else {
        delete mergedP.installSize;
      }
      if (nextVersion !== undefined) mergedP.version = nextVersion;
      if (nextLaunchArgs !== undefined) mergedP.launchArguments = nextLaunchArgs;
      if (nextWinOnMac !== undefined) mergedP.isWindowsBinaryOnMac = nextWinOnMac;
    } else {
      delete mergedP.installPath;
      delete mergedP.executablePath;
      delete mergedP.launchArguments;
      delete mergedP.version;
      delete mergedP.isWindowsBinaryOnMac;
      if (nextInstallSize !== undefined) {
        mergedP.installSize = nextInstallSize;
      } else {
        delete mergedP.installSize;
      }
    }
    return mergedP;
  });

  for (const livePlat of liveGame.platforms) {
    if (!mergedPlatforms.some((mp) => mp.platformId === livePlat.platformId)) {
      mergedPlatforms.push(livePlat);
      platformsChanged = true;
    }
  }

  let candidateMerged =
    !platformsChanged && !enrichedChanged
      ? incomingGame
      : {
          ...incomingGame,
          ...(platformsChanged ? { platforms: mergedPlatforms } : {}),
          ...(enrichedChanged ? { enrichedMetadata: bestEnriched } : {}),
        };

  if (incomingGame.enrichedMetadata?.__quotaSlimmed && !liveGame.enrichedMetadata?.__quotaSlimmed) {
    candidateMerged = recoverRichSummaryFieldsFromDonor(
      candidateMerged,
      liveGame,
      bestEnriched,
      true
    );
  }

  return areCanonicalGamesShallowEqual(liveGame, candidateMerged) ? liveGame : candidateMerged;
}

export function mergeHydratedCatalogPreservingLiveState(
  liveGames: CanonicalGame[],
  hydratedGames: CanonicalGame[]
): CanonicalGame[] {
  if (!Array.isArray(hydratedGames) || hydratedGames.length === 0) return liveGames;
  if (!Array.isArray(liveGames) || liveGames.length === 0) return hydratedGames;

  const liveById = new Map<string, CanonicalGame>();
  const liveBySteamAppId = new Map<number, CanonicalGame>();
  const liveByPlatKey = new Map<string, CanonicalGame>();

  for (const lg of liveGames) {
    if (!lg) continue;
    if (lg.id) liveById.set(lg.id, lg);
    if (lg.steamAppId) liveBySteamAppId.set(lg.steamAppId, lg);
    for (const lp of lg.platforms || []) {
      const normId = normalizePlatformGameIdForLookup(lp.platformGameId || lp.storefrontAppId);
      if (normId) {
        liveByPlatKey.set(`${lp.platformId}:${normId}`, lg);
      }
      if (lp.platformId === 'xbox') {
        const xBig = normalizePlatformGameIdForLookup(lp.xboxProductId);
        const xPfn = String(lp.packageFamilyName || '').trim().toLowerCase();
        if (xBig) liveByPlatKey.set(`xbox:${xBig}`, lg);
        if (xPfn) liveByPlatKey.set(`xbox:${xPfn}`, lg);
      }
    }
  }

  const matchedLiveIds = new Set<string>();
  const merged = hydratedGames.map((hg) => {
    let liveMatch = hg.id ? liveById.get(hg.id) : undefined;
    if (!liveMatch && hg.steamAppId) {
      liveMatch = liveBySteamAppId.get(hg.steamAppId);
    }
    if (!liveMatch) {
      for (const hp of hg.platforms || []) {
        const normId = normalizePlatformGameIdForLookup(hp.platformGameId || hp.storefrontAppId);
        if (normId) {
          const cand = liveByPlatKey.get(`${hp.platformId}:${normId}`);
          if (cand) {
            liveMatch = cand;
            break;
          }
        }
        if (hp.platformId === 'xbox') {
          const xBig = normalizePlatformGameIdForLookup(hp.xboxProductId);
          const xPfn = String(hp.packageFamilyName || '').trim().toLowerCase();
          const cand =
            (xBig ? liveByPlatKey.get(`xbox:${xBig}`) : undefined) ||
            (xPfn ? liveByPlatKey.get(`xbox:${xPfn}`) : undefined);
          if (cand) {
            liveMatch = cand;
            break;
          }
        }
      }
    }
    if (!liveMatch) return hg;
    if (liveMatch.id) matchedLiveIds.add(liveMatch.id);
    return mergeUpdatedGamePreservingLivePlatformState(liveMatch, hg);
  });

  const mergedSteamAppIds = new Set<number>();
  const mergedPlatformKeys = new Set<string>();
  const indexGameIntoMergedSets = (g: CanonicalGame) => {
    if (g.steamAppId && g.steamAppId > 0) {
      mergedSteamAppIds.add(g.steamAppId);
    }
    for (const mp of g.platforms || []) {
      const normId = normalizePlatformGameIdForLookup(mp.platformGameId || mp.storefrontAppId);
      if (normId) {
        mergedPlatformKeys.add(`${mp.platformId}:${normId}`);
      }
      if (mp.platformId === 'xbox') {
        const xBig = normalizePlatformGameIdForLookup(mp.xboxProductId);
        const xPfn = String(mp.packageFamilyName || '').trim().toLowerCase();
        if (xBig) mergedPlatformKeys.add(`xbox:${xBig}`);
        if (xPfn) mergedPlatformKeys.add(`xbox:${xPfn}`);
      }
    }
  };
  for (const m of merged) {
    if (m) indexGameIntoMergedSets(m);
  }

  for (const lg of liveGames) {
    if (!lg || (lg.id && matchedLiveIds.has(lg.id))) continue;
    const alreadyInHydrated =
      Boolean(lg.steamAppId && mergedSteamAppIds.has(lg.steamAppId)) ||
      (lg.platforms || []).some((lp) => {
        const normId = normalizePlatformGameIdForLookup(lp.platformGameId || lp.storefrontAppId);
        if (normId && mergedPlatformKeys.has(`${lp.platformId}:${normId}`)) {
          return true;
        }
        if (lp.platformId === 'xbox') {
          const xBig = normalizePlatformGameIdForLookup(lp.xboxProductId);
          const xPfn = String(lp.packageFamilyName || '').trim().toLowerCase();
          if (
            (xBig && mergedPlatformKeys.has(`xbox:${xBig}`)) ||
            (xPfn && mergedPlatformKeys.has(`xbox:${xPfn}`))
          ) {
            return true;
          }
        }
        return false;
      });
    if (!alreadyInHydrated) {
      merged.push(lg);
      indexGameIntoMergedSets(lg);
    }
  }

  if (merged.length === liveGames.length && merged.every((m, idx) => m === liveGames[idx])) {
    return liveGames;
  }

  return merged;
}

export const mergeSyncedGamesIntoCatalog = mergeStorefrontGames;

export function removeStorefrontGames(
  currentCatalog: CanonicalGame[],
  storefrontId: StorefrontId
): CanonicalGame[] {
  clearVerifiedUserEntitlements(storefrontId);
  const remaining: CanonicalGame[] = [];
  const candidateOrphanVaultIds = new Set<string>();

  for (const game of currentCatalog) {
    const removedPlatforms = game.platforms.filter((p) => p.platformId === storefrontId);
    const updatedPlatforms = game.platforms.filter((p) => p.platformId !== storefrontId);
    if (removedPlatforms.length > 0) {
      for (const rp of removedPlatforms) {
        const rawPid = String(rp.platformGameId || '').trim();
        const normPid = normalizePlatformGameIdForLookup(rp.platformGameId);
        if (rawPid) candidateOrphanVaultIds.add(`${storefrontId}-${rawPid}`);
        if (normPid) candidateOrphanVaultIds.add(`${storefrontId}-${normPid}`);
      }
    }
    if (updatedPlatforms.length > 0) {
      remaining.push({
        ...game,
        platforms: updatedPlatforms,
      });
    } else if (game.id) {
      candidateOrphanVaultIds.add(game.id);
    }
  }

  const sortedRemaining = remaining.toSorted((a, b) =>
    LIBRARY_TITLE_COLLATOR.compare(a.title, b.title)
  );
  if (candidateOrphanVaultIds.size > 0) {
    const survivingIds = new Set(sortedRemaining.map((g) => g.id));
    const prunedVaultIds: string[] = [];
    for (const id of candidateOrphanVaultIds) {
      if (id && !survivingIds.has(id)) {
        prunedVaultIds.push(id);
      }
    }
    if (prunedVaultIds.length > 0) {
      deleteOrphanedGamesFromOfflineVault(prunedVaultIds);
    }
  }

  return sortedRemaining;
}
