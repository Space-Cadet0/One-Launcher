import {
  CanonicalGame,
  ChainedHandoffTopology,
  GamePlatformOwnership,
} from '../../../contracts/game';
import { StorefrontId } from '../../../contracts/platform';
import gogEnrichedCache from '../../storage/gogEnrichedCache.json';
import steamEnrichedCache from '../../storage/steamEnrichedCache.json';

export interface GogEnrichedCacheItem {
  shortDescription?: string;
  description?: string;
  coverVertical?: string;
  coverHorizontal?: string;
  platforms?: {
    windows?: boolean;
    mac?: boolean;
    linux?: boolean;
  };
  worksOn?: {
    windows?: boolean;
    mac?: boolean;
    linux?: boolean;
    Windows?: boolean;
    Mac?: boolean;
    Linux?: boolean;
  };
}

export interface SteamEnrichedCacheItem {
  name?: string;
  platforms?: {
    windows?: boolean;
    mac?: boolean;
    linux?: boolean;
  };
}

export type NormalizedChainedHandoffId = 'ea' | 'ubisoft' | 'bnet' | 'rockstar' | 'riot';

const WINDOWS_ONLY_CHAINED_HANDOFFS = new Set<NormalizedChainedHandoffId>([
  'ea',
  'ubisoft',
  'rockstar',
  'riot',
]);

export const EA_DRM_BACKGROUND_REQUIRED_RE =
  /\b(?:EA\s+app|Origin(?:\s+client)?)\s+software\s+installation\s+and\s+background\s+use\s+required/i;

export const KERNEL_ANTICHEAT_DRM_RE =
  /\b(EA\s+Javelin(?:\s+Anticheat)?|EA\s+Anti-?Cheat|Easy\s*Anti-?Cheat|BattlEye|Vanguard)\b/i;

function normalizeDrmNoticePlainText(raw?: unknown): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ndash;|&#8209;|&#8211;/gi, '-')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes publisher launcher / PartnerLink / URI handoff tokens into canonical
 * One Launcher publisher handoff IDs (`'ea' | 'ubisoft' | 'bnet' | 'rockstar' | 'riot'`).
 */
export function normalizeChainedHandoffId(raw?: unknown): NormalizedChainedHandoffId | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('link2ea') ||
    lower.startsWith('origin2:') ||
    lower.startsWith('origin:') ||
    lower.startsWith('eadm:')
  ) {
    return 'ea';
  }
  if (lower.startsWith('uplay:')) return 'ubisoft';
  if (lower.startsWith('battlenet:')) return 'bnet';

  const compact = lower.replace(/[^a-z0-9]/g, '');
  if (
    compact === 'ea' ||
    compact === 'eaapp' ||
    compact === 'theeaapp' ||
    compact === 'eadesktop' ||
    compact === 'eaplay' ||
    compact === 'electronicarts' ||
    compact === 'origin' ||
    compact === 'originclient' ||
    compact === 'theoriginclient' ||
    compact === 'link2ea'
  ) {
    return 'ea';
  }
  if (
    compact === 'ubisoft' ||
    compact === 'ubisoftconnect' ||
    compact === 'theubisoftconnect' ||
    compact === 'uplay' ||
    compact === 'ubisoftgamelauncher'
  ) {
    return 'ubisoft';
  }
  if (
    compact === 'bnet' ||
    compact === 'battlenet' ||
    compact === 'blizzard' ||
    compact === 'blizzardbattlenet'
  ) {
    return 'bnet';
  }
  if (
    compact === 'rockstar' ||
    compact === 'rockstargames' ||
    compact === 'rockstarlauncher' ||
    compact === 'rockstargameslauncher'
  ) {
    return 'rockstar';
  }
  if (compact === 'riot' || compact === 'riotgames' || compact === 'riotclient') {
    return 'riot';
  }

  if (
    /\b(?:ea\s*app|origin(?:\s+client)?|electronic\s+arts|link2ea|ea\s+desktop|ea\s+play)\b/i.test(
      trimmed
    )
  ) {
    return 'ea';
  }
  if (/\b(?:ubisoft(?:\s+connect)?|uplay)\b/i.test(trimmed)) {
    return 'ubisoft';
  }
  if (/\b(?:battle\.?net|blizzard)\b/i.test(trimmed)) {
    return 'bnet';
  }
  if (/\brockstar(?:\s+games)?(?:\s+launcher)?\b/i.test(trimmed)) {
    return 'rockstar';
  }
  if (/\briot(?:\s+client|\s+games)?\b/i.test(trimmed)) {
    return 'riot';
  }

  return undefined;
}

export function mapChainedHandoffIdToExternalLauncher(handoffId?: unknown): string | undefined {
  const canonical = normalizeChainedHandoffId(handoffId);
  switch (canonical) {
    case 'ea':
      return 'EA App';
    case 'ubisoft':
      return 'Ubisoft Connect';
    case 'bnet':
      return 'Battle.net';
    case 'rockstar':
      return 'Rockstar Games Launcher';
    case 'riot':
      return 'Riot Client';
    default:
      return undefined;
  }
}

export type StructuralKernelAntiCheatCategory =
  | 'ring0_hard_block'
  | 'battleye_multiplayer_only'
  | 'kernel_advisory';

export function resolveCanonicalKernelAntiCheatDisplayName(
  raw?: string | null
): string | undefined {
  const plain = normalizeDrmNoticePlainText(raw);
  if (!plain) return undefined;
  if (/\b(?:ea\s*anticheat|ea\s*javelin|ea\s+anti-?cheat)\b/i.test(plain)) {
    return 'EA Javelin Anti-Cheat';
  }
  if (/\b(?:ricochet\s*anti[- ]?cheat|randgrid)\b/i.test(plain)) {
    return 'RICOCHET Anti-Cheat';
  }
  if (/\b(?:riot\s*vanguard|vgk\.sys|\bvanguard\b)\b/i.test(plain)) {
    return 'Riot Vanguard';
  }
  if (/\bbattleye\b/i.test(plain)) {
    return 'BattlEye';
  }
  if (/\beasy\s*anti-?cheat\b/i.test(plain)) {
    return 'Easy Anti-Cheat';
  }
  return undefined;
}

export function isRing0HardBlockKernelAntiCheat(antiCheatName?: string | null): boolean {
  const canonical = resolveCanonicalKernelAntiCheatDisplayName(antiCheatName);
  return (
    canonical === 'EA Javelin Anti-Cheat' ||
    canonical === 'RICOCHET Anti-Cheat' ||
    canonical === 'Riot Vanguard'
  );
}

export function isBattlEyeKernelAntiCheat(antiCheatName?: string | null): boolean {
  return resolveCanonicalKernelAntiCheatDisplayName(antiCheatName) === 'BattlEye';
}

export function detectStructuralKernelAntiCheatFromNotices(
  ...notices: Array<string | null | undefined>
): {
  requiresKernelAntiCheat: true;
  kernelAntiCheatName: string;
  category: StructuralKernelAntiCheatCategory;
} | null {
  const combined = notices
    .map((n) => normalizeDrmNoticePlainText(n))
    .filter(Boolean)
    .join(' | ');
  if (!combined) return null;

  if (/\b(?:ea\s*anticheat|ea\s*javelin|ea\s+anti-?cheat)\b/i.test(combined)) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'EA Javelin Anti-Cheat',
      category: 'ring0_hard_block',
    };
  }
  if (/\b(?:ricochet\s*anti[- ]?cheat|randgrid)\b/i.test(combined)) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'RICOCHET Anti-Cheat',
      category: 'ring0_hard_block',
    };
  }
  if (/\b(?:riot\s*vanguard|vgk\.sys|\bvanguard\b)\b/i.test(combined)) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'Riot Vanguard',
      category: 'ring0_hard_block',
    };
  }
  if (/\bbattleye\b/i.test(combined)) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'BattlEye',
      category: 'battleye_multiplayer_only',
    };
  }
  if (/\beasy\s*anti-?cheat\b/i.test(combined)) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'Easy Anti-Cheat',
      category: 'kernel_advisory',
    };
  }
  return null;
}

export function detectKernelAntiCheatFromNotice(
  drmNotice?: string | null
): { requiresKernelAntiCheat: true; antiCheatName: string } | null {
  const plain = normalizeDrmNoticePlainText(drmNotice);
  if (!plain) return null;
  const match = plain.match(KERNEL_ANTICHEAT_DRM_RE);
  if (!match) return null;
  const token = match[1];
  let antiCheatName = token;
  if (/ea\s+javelin/i.test(token)) {
    antiCheatName = 'EA Javelin Anticheat';
  } else if (/ea\s+anti-?cheat/i.test(token)) {
    antiCheatName = 'EA Anti-Cheat';
  } else if (/easy\s*anti-?cheat/i.test(token)) {
    antiCheatName = 'Easy Anti-Cheat';
  } else if (/battleye/i.test(token)) {
    antiCheatName = 'BattlEye';
  } else if (/vanguard/i.test(token)) {
    antiCheatName = 'Vanguard';
  } else {
    const structural = detectStructuralKernelAntiCheatFromNotices(plain);
    if (structural) {
      antiCheatName = structural.kernelAntiCheatName;
    }
  }
  return {
    requiresKernelAntiCheat: true,
    antiCheatName,
  };
}

function resolveDefaultChainedTopology(
  platformId: StorefrontId | 'riot'
): ChainedHandoffTopology | undefined {
  if (platformId === 'xbox') return 'publisher_managed';
  if (platformId === 'epic') return 'partner_launcher_link';
  if (platformId === 'steam') return 'storefront_depot_uri';
  return undefined;
}

export function sanitizePlatformOwnershipOsFlags(
  entry: GamePlatformOwnership
): GamePlatformOwnership {
  if (!entry || typeof entry !== 'object') return entry;
  const pid = entry.platformId as StorefrontId | 'riot';

  let normalizedEntry = entry;
  const rawHandoff =
    entry.chainedLauncherHandoff || entry.externalStorefrontHandoff || entry.externalLauncher;
  const canonicalHandoff = normalizeChainedHandoffId(rawHandoff);
  if (canonicalHandoff && canonicalHandoff !== pid) {
    const defaultTopology = entry.chainedHandoffTopology || resolveDefaultChainedTopology(pid);
    const mappedExternalLauncher =
      entry.externalLauncher || mapChainedHandoffIdToExternalLauncher(canonicalHandoff);
    if (
      entry.chainedLauncherHandoff !== canonicalHandoff ||
      entry.externalStorefrontHandoff !== canonicalHandoff ||
      (defaultTopology && !entry.chainedHandoffTopology) ||
      (mappedExternalLauncher && !entry.externalLauncher)
    ) {
      normalizedEntry = {
        ...normalizedEntry,
        chainedLauncherHandoff: canonicalHandoff,
        externalStorefrontHandoff: canonicalHandoff,
        ...(defaultTopology && !entry.chainedHandoffTopology
          ? { chainedHandoffTopology: defaultTopology }
          : {}),
        ...(mappedExternalLauncher && !entry.externalLauncher
          ? { externalLauncher: mappedExternalLauncher }
          : {}),
      };
    }
  } else if (
    (entry.chainedLauncherHandoff || entry.externalStorefrontHandoff) &&
    typeof rawHandoff === 'string'
  ) {
    const trimmed = rawHandoff.trim();
    if (
      trimmed &&
      trimmed.toLowerCase() !== String(pid).toLowerCase() &&
      (!entry.chainedLauncherHandoff || !entry.externalStorefrontHandoff)
    ) {
      normalizedEntry = {
        ...normalizedEntry,
        chainedLauncherHandoff: entry.chainedLauncherHandoff || trimmed,
        externalStorefrontHandoff: (entry.externalStorefrontHandoff || trimmed) as
          | StorefrontId
          | 'riot',
      };
    }
  }

  const rawPlat = normalizedEntry.platforms;
  const activeHandoff = normalizeChainedHandoffId(
    normalizedEntry.chainedLauncherHandoff || normalizedEntry.externalStorefrontHandoff
  );
  const hasWindowsOnlyChainedHandoff = Boolean(
    activeHandoff && WINDOWS_ONLY_CHAINED_HANDOFFS.has(activeHandoff)
  );

  if (pid === 'xbox') {
    const allowMac =
      !normalizedEntry.externalStorefrontHandoff &&
      !normalizedEntry.chainedLauncherHandoff &&
      normalizedEntry.xboxBottleCompatibilityTier !== 'tier_b_legacy_uwp' &&
      normalizedEntry.xboxBottleCompatibilityTier !== 'tier_c_external_launcher' &&
      normalizedEntry.xboxBottleCompatibilityTier !== 'tier_c_kernel_anticheat' &&
      normalizedEntry.isWindowsBinaryOnMac !== true &&
      (normalizedEntry.isCrossPlatformLauncherRuntime === true ||
        (normalizedEntry.isCrossPlatformLauncherRuntime !== false &&
          !normalizedEntry.packageFamilyName &&
          !normalizedEntry.appUserModelId &&
          Boolean(
            rawPlat &&
              typeof rawPlat === 'object' &&
              !Array.isArray(rawPlat) &&
              rawPlat.windows === true &&
              rawPlat.mac === true &&
              rawPlat.linux === true
          )));
    const needsPlatEnforcement =
      (rawPlat &&
        typeof rawPlat === 'object' &&
        !Array.isArray(rawPlat) &&
        (rawPlat.windows !== true || Boolean(rawPlat.mac) !== allowMac)) ||
      (!rawPlat && Boolean(activeHandoff || hasWindowsOnlyChainedHandoff));
    if (needsPlatEnforcement) {
      return {
        ...normalizedEntry,
        platforms: {
          windows: true,
          mac: allowMac,
          linux: allowMac && rawPlat ? Boolean(rawPlat.linux) : false,
        },
      };
    }
    return normalizedEntry;
  }

  if (pid === 'epic' && hasWindowsOnlyChainedHandoff) {
    if (
      !rawPlat ||
      typeof rawPlat !== 'object' ||
      Array.isArray(rawPlat) ||
      rawPlat.windows !== true ||
      rawPlat.mac !== false
    ) {
      return {
        ...normalizedEntry,
        platforms: {
          windows: true,
          mac: false,
          linux: false,
        },
      };
    }
    return normalizedEntry;
  }

  if (pid === 'ubisoft' || pid === 'ea' || pid === 'rockstar' || pid === 'riot') {
    if (
      rawPlat &&
      typeof rawPlat === 'object' &&
      !Array.isArray(rawPlat) &&
      (rawPlat.windows !== true || rawPlat.mac === true)
    ) {
      return {
        ...normalizedEntry,
        platforms: {
          windows: true,
          mac: false,
          linux: Boolean(rawPlat.linux),
        },
      };
    }
    return normalizedEntry;
  }

  if (
    rawPlat &&
    typeof rawPlat === 'object' &&
    !Array.isArray(rawPlat) &&
    !rawPlat.windows &&
    !rawPlat.mac &&
    !rawPlat.linux
  ) {
    return {
      ...normalizedEntry,
      platforms: {
        windows: true,
        mac: false,
        linux: false,
      },
    };
  }

  return normalizedEntry;
}

export function mergePlatformEntry(
  ep: GamePlatformOwnership,
  secMatch?: GamePlatformOwnership,
  fallbackOriginalTitle?: string
): GamePlatformOwnership {
  const epHasActiveSub =
    ep.ownershipType === 'owned_and_subscription' ||
    (ep.ownershipType === 'subscription' && !ep.subscriptionExpired);
  const secHasActiveSub = Boolean(
    secMatch &&
      (secMatch.ownershipType === 'owned_and_subscription' ||
        (secMatch.ownershipType === 'subscription' && !secMatch.subscriptionExpired))
  );
  const hasPermanentOwned =
    ep.ownershipType === 'owned' ||
    ep.ownershipType === 'owned_and_subscription' ||
    secMatch?.ownershipType === 'owned' ||
    secMatch?.ownershipType === 'owned_and_subscription';
  const hasAnySubscription =
    ep.ownershipType === 'subscription' || secMatch?.ownershipType === 'subscription';

  const mergedOwnershipType =
    hasPermanentOwned && (epHasActiveSub || secHasActiveSub)
      ? 'owned_and_subscription'
      : hasPermanentOwned
      ? 'owned'
      : epHasActiveSub || secHasActiveSub || hasAnySubscription
      ? 'subscription'
      : ep.ownershipType || secMatch?.ownershipType;
  const isPermanentOwnership =
    mergedOwnershipType === 'owned' || mergedOwnershipType === 'owned_and_subscription';
  const mergedSubscriptionExpired = isPermanentOwnership
    ? false
    : epHasActiveSub || secHasActiveSub
    ? ep.subscriptionExpired === false || secMatch?.subscriptionExpired === false
      ? false
      : undefined
    : ep.subscriptionExpired ?? secMatch?.subscriptionExpired;

  const activeEp = epHasActiveSub ? ep : undefined;
  const activeSec = secHasActiveSub ? secMatch : undefined;
  const mergedGamePassTier =
    mergedOwnershipType === 'owned'
      ? undefined
      : activeEp?.gamePassTier ||
        activeSec?.gamePassTier ||
        (mergedOwnershipType === 'subscription'
          ? ep.gamePassTier || secMatch?.gamePassTier
          : undefined);
  const mergedIsLeavingSoon =
    mergedOwnershipType === 'owned' || mergedSubscriptionExpired
      ? undefined
      : activeEp?.isLeavingSoon ?? activeSec?.isLeavingSoon;
  const mergedIsRecentlyAdded =
    mergedOwnershipType === 'owned' || mergedSubscriptionExpired
      ? undefined
      : activeEp?.isRecentlyAddedToGamePass ?? activeSec?.isRecentlyAddedToGamePass;
  const mergedCrossPlatformLauncher =
    ep.isCrossPlatformLauncherRuntime ?? secMatch?.isCrossPlatformLauncherRuntime;

  const mergedExternalLauncher = ep.externalLauncher || secMatch?.externalLauncher;
  const mergedExternalLauncherUrl = ep.externalLauncherUrl || secMatch?.externalLauncherUrl;
  const mergedXboxCompatReason =
    ep.xboxBottleCompatibilityReason || secMatch?.xboxBottleCompatibilityReason;
  const mergedStubPkg = ep.isExternalLauncherStubPackage ?? secMatch?.isExternalLauncherStubPackage;
  const mergedMaxDownloadBytes = ep.maxDownloadSizeBytes ?? secMatch?.maxDownloadSizeBytes;
  const mergedPcMaxInstallBytes = ep.pcMaxInstallSizeBytes ?? secMatch?.pcMaxInstallSizeBytes;
  const mergedInstallSize = ep.installSize ?? secMatch?.installSize;
  const mergedKernelAntiCheatName = ep.kernelAntiCheatName || secMatch?.kernelAntiCheatName;

  return sanitizePlatformOwnershipOsFlags({
    ...ep,
    platforms: ep.platforms || secMatch?.platforms,
    storefrontAppId: ep.storefrontAppId || secMatch?.storefrontAppId,
    namespace: ep.namespace || secMatch?.namespace,
    catalogItemId: ep.catalogItemId || secMatch?.catalogItemId,
    ...(ep.xboxProductId || secMatch?.xboxProductId
      ? { xboxProductId: ep.xboxProductId || secMatch?.xboxProductId }
      : {}),
    ...(ep.packageFamilyName || secMatch?.packageFamilyName
      ? { packageFamilyName: ep.packageFamilyName || secMatch?.packageFamilyName }
      : {}),
    ...(ep.appUserModelId || secMatch?.appUserModelId
      ? { appUserModelId: ep.appUserModelId || secMatch?.appUserModelId }
      : {}),
    ...(ep.xboxTitleId || secMatch?.xboxTitleId
      ? { xboxTitleId: ep.xboxTitleId || secMatch?.xboxTitleId }
      : {}),
    ...(ep.scid || secMatch?.scid ? { scid: ep.scid || secMatch?.scid } : {}),
    ...(ep.msaAppId || secMatch?.msaAppId ? { msaAppId: ep.msaAppId || secMatch?.msaAppId } : {}),
    ...(mergedOwnershipType ? { ownershipType: mergedOwnershipType } : {}),
    ...(ep.platformId === 'xbox'
      ? {
          gamePassTier: mergedGamePassTier,
          isLeavingSoon: mergedIsLeavingSoon,
          isRecentlyAddedToGamePass: mergedIsRecentlyAdded,
          subscriptionExpired: mergedSubscriptionExpired,
        }
      : {
          ...(mergedGamePassTier ? { gamePassTier: mergedGamePassTier } : {}),
          ...(mergedIsLeavingSoon !== undefined ? { isLeavingSoon: mergedIsLeavingSoon } : {}),
          ...(mergedIsRecentlyAdded !== undefined
            ? { isRecentlyAddedToGamePass: mergedIsRecentlyAdded }
            : {}),
          ...(mergedSubscriptionExpired !== undefined
            ? { subscriptionExpired: mergedSubscriptionExpired }
            : {}),
        }),
    ...(mergedCrossPlatformLauncher !== undefined
      ? { isCrossPlatformLauncherRuntime: mergedCrossPlatformLauncher }
      : {}),
    ...(ep.externalStorefrontHandoff ||
    secMatch?.externalStorefrontHandoff ||
    ep.chainedLauncherHandoff ||
    secMatch?.chainedLauncherHandoff ||
    mergedExternalLauncher
      ? (() => {
          const rawMergedHandoff =
            ep.chainedLauncherHandoff ||
            ep.externalStorefrontHandoff ||
            secMatch?.chainedLauncherHandoff ||
            secMatch?.externalStorefrontHandoff ||
            mergedExternalLauncher;
          const normMergedHandoff = normalizeChainedHandoffId(rawMergedHandoff);
          if (normMergedHandoff && normMergedHandoff !== ep.platformId) {
            return {
              chainedLauncherHandoff: normMergedHandoff,
              externalStorefrontHandoff: normMergedHandoff,
            };
          }
          return {
            ...(ep.externalStorefrontHandoff || secMatch?.externalStorefrontHandoff
              ? {
                  externalStorefrontHandoff:
                    ep.externalStorefrontHandoff || secMatch?.externalStorefrontHandoff,
                }
              : {}),
            ...(ep.chainedLauncherHandoff || secMatch?.chainedLauncherHandoff
              ? {
                  chainedLauncherHandoff:
                    ep.chainedLauncherHandoff || secMatch?.chainedLauncherHandoff,
                }
              : {}),
          };
        })()
      : {}),
    ...(mergedExternalLauncher ? { externalLauncher: mergedExternalLauncher } : {}),
    ...(mergedExternalLauncherUrl ? { externalLauncherUrl: mergedExternalLauncherUrl } : {}),
    ...(ep.xboxBottleCompatibilityTier || secMatch?.xboxBottleCompatibilityTier
      ? {
          xboxBottleCompatibilityTier:
            ep.xboxBottleCompatibilityTier || secMatch?.xboxBottleCompatibilityTier,
        }
      : {}),
    ...(mergedXboxCompatReason ? { xboxBottleCompatibilityReason: mergedXboxCompatReason } : {}),
    ...(mergedStubPkg !== undefined ? { isExternalLauncherStubPackage: mergedStubPkg } : {}),
    ...(mergedMaxDownloadBytes !== undefined
      ? { maxDownloadSizeBytes: mergedMaxDownloadBytes }
      : {}),
    ...(mergedPcMaxInstallBytes !== undefined
      ? { pcMaxInstallSizeBytes: mergedPcMaxInstallBytes }
      : {}),
    ...(mergedInstallSize !== undefined ? { installSize: mergedInstallSize } : {}),
    ...(ep.chainedExternalInstallId || secMatch?.chainedExternalInstallId
      ? {
          chainedExternalInstallId:
            ep.chainedExternalInstallId || secMatch?.chainedExternalInstallId,
        }
      : {}),
    ...(ep.chainedHandoffTopology || secMatch?.chainedHandoffTopology
      ? {
          chainedHandoffTopology: ep.chainedHandoffTopology || secMatch?.chainedHandoffTopology,
        }
      : {}),
    ...(ep.epicPartnerRegistryPath || secMatch?.epicPartnerRegistryPath
      ? {
          epicPartnerRegistryPath: ep.epicPartnerRegistryPath || secMatch?.epicPartnerRegistryPath,
        }
      : {}),
    ...(ep.requiresKernelAntiCheat !== undefined ||
    secMatch?.requiresKernelAntiCheat !== undefined
      ? {
          requiresKernelAntiCheat:
            ep.requiresKernelAntiCheat ?? secMatch?.requiresKernelAntiCheat,
        }
      : {}),
    ...(mergedKernelAntiCheatName ? { kernelAntiCheatName: mergedKernelAntiCheatName } : {}),
    ...(ep.antiCheatName || secMatch?.antiCheatName
      ? {
          antiCheatName: ep.antiCheatName || secMatch?.antiCheatName,
        }
      : {}),
    originalTitle: ep.originalTitle || secMatch?.originalTitle || fallbackOriginalTitle || '',
  });
}

export function mergePlatformEntries(
  primary: Pick<CanonicalGame, 'platforms' | 'originalStoreTitle' | 'title'>,
  secondary: Pick<CanonicalGame, 'platforms' | 'originalStoreTitle' | 'title'>
): GamePlatformOwnership[] {
  const mergedPlatforms: GamePlatformOwnership[] = (primary.platforms || []).map((ep) => {
    const secMatch = (secondary.platforms || []).find((sp) => sp.platformId === ep.platformId);
    return mergePlatformEntry(ep, secMatch, primary.originalStoreTitle || primary.title);
  });

  for (const p of secondary.platforms || []) {
    const found = mergedPlatforms.some((ep) => ep.platformId === p.platformId);
    if (!found) {
      mergedPlatforms.push(
        sanitizePlatformOwnershipOsFlags({
          ...p,
          ...(p.platformId === 'xbox' && p.ownershipType === 'owned'
            ? {
                gamePassTier: undefined,
                isLeavingSoon: undefined,
                isRecentlyAddedToGamePass: undefined,
                subscriptionExpired: false,
              }
            : p.platformId === 'xbox' && p.subscriptionExpired
            ? {
                isLeavingSoon: undefined,
                isRecentlyAddedToGamePass: undefined,
              }
            : {}),
          originalTitle: p.originalTitle || secondary.originalStoreTitle || secondary.title,
        })
      );
    }
  }

  return mergedPlatforms;
}

export function selfHealCatalogEntryHandoffsAndOs(game: CanonicalGame): CanonicalGame {
  if (!game || typeof game !== 'object') return game;

  const rawDrmNotice =
    game.enrichedMetadata?.drmNotice || (game as { drmNotice?: string }).drmNotice || '';
  const plainDrmNotice = normalizeDrmNoticePlainText(rawDrmNotice);
  const hasEaBackgroundDrmNotice = Boolean(
    plainDrmNotice && EA_DRM_BACKGROUND_REQUIRED_RE.test(plainDrmNotice)
  );
  const antiCheatFromNotice = detectKernelAntiCheatFromNotice(plainDrmNotice);

  let platformsChanged = false;
  const rawPlatforms = Array.isArray(game.platforms) ? game.platforms : [];
  let nextPlatforms = rawPlatforms.map((p) => {
    if (!p || typeof p !== 'object') return p;
    let working = p;
    const pid = String(p.platformId || '').toLowerCase();

    if (
      hasEaBackgroundDrmNotice &&
      pid === 'epic' &&
      !p.chainedLauncherHandoff &&
      !p.externalStorefrontHandoff
    ) {
      working = {
        ...working,
        chainedLauncherHandoff: 'ea',
        externalStorefrontHandoff: 'ea',
        chainedHandoffTopology: working.chainedHandoffTopology || 'partner_launcher_link',
      };
    } else if (
      hasEaBackgroundDrmNotice &&
      pid === 'steam' &&
      game.enrichedMetadata?.metadataQuality !== 'skeleton_fallback' &&
      !p.chainedLauncherHandoff &&
      !p.externalStorefrontHandoff
    ) {
      working = {
        ...working,
        chainedLauncherHandoff: 'ea',
        externalStorefrontHandoff: 'ea',
        chainedHandoffTopology: working.chainedHandoffTopology || 'storefront_depot_uri',
      };
    }

    const sanitized = sanitizePlatformOwnershipOsFlags(working);
    if (sanitized !== p) {
      platformsChanged = true;
    }
    return sanitized;
  });

  const hasGogEnrichedCache = Object.keys(gogEnrichedCache).length > 0;
  const hasSteamEnrichedCache = Object.keys(steamEnrichedCache).length > 0;

  const hasGenuineMacPlatformEntry = nextPlatforms.some((p) => {
    if (!p || typeof p !== 'object') return false;
    if (
      p.installed &&
      !p.isWindowsBinaryOnMac &&
      /\.app(?:\/|$)/i.test(p.executablePath || p.installPath || '')
    ) {
      return true;
    }
    const pid = String(p.platformId || '').toLowerCase();
    const handoff = normalizeChainedHandoffId(
      p.chainedLauncherHandoff || p.externalStorefrontHandoff
    );

    if (pid === 'xbox') {
      return Boolean(p.isCrossPlatformLauncherRuntime === true || p.platforms?.mac === true);
    }
    if (pid === 'ubisoft' || pid === 'ea' || pid === 'rockstar' || pid === 'riot') {
      return false;
    }
    if (pid === 'epic') {
      if (handoff && WINDOWS_ONLY_CHAINED_HANDOFFS.has(handoff)) return false;
      if (p.platforms && typeof p.platforms === 'object' && !Array.isArray(p.platforms)) {
        return Boolean(p.platforms.mac === true);
      }
      return Boolean(
        nextPlatforms.length === 1 &&
          game.enrichedMetadata?.appId === 0 &&
          game.enrichedMetadata?.platforms?.mac === true
      );
    }
    if (pid === 'gog') {
      if (p.platforms && typeof p.platforms === 'object' && !Array.isArray(p.platforms)) {
        return Boolean(p.platforms.mac === true);
      }
      if (hasGogEnrichedCache) {
        const gogId = String(p.platformGameId || '').replace(/^gog-/, '');
        const cachedGog = gogId
          ? (gogEnrichedCache as Record<string, GogEnrichedCacheItem>)[gogId]
          : undefined;
        if (cachedGog?.platforms || cachedGog?.worksOn) {
          return Boolean(
            cachedGog.platforms?.mac === true ||
              cachedGog.worksOn?.Mac === true ||
              cachedGog.worksOn?.mac === true
          );
        }
      }
      return Boolean(
        nextPlatforms.length === 1 &&
          (game.worksOn?.mac ||
            game.worksOn?.Mac ||
            game.platforms_os?.mac ||
            (Array.isArray(game.nativePlatforms) && game.nativePlatforms.includes('mac')))
      );
    }
    if (pid === 'steam') {
      if (p.platforms && typeof p.platforms === 'object' && !Array.isArray(p.platforms)) {
        return Boolean(p.platforms.mac === true);
      }
      if (game.enrichedMetadata?.metadataQuality === 'skeleton_fallback') {
        return false;
      }
      if (game.enrichedMetadata?.platforms?.mac === true) {
        return true;
      }
      if (hasSteamEnrichedCache && game.steamAppId) {
        const cachedSteam = (steamEnrichedCache as Record<string, SteamEnrichedCacheItem>)[
          String(game.steamAppId)
        ];
        return Boolean(cachedSteam?.platforms?.mac === true);
      }
      return false;
    }
    return Boolean(p.platforms?.mac === true);
  });

  const structuralAntiCheat = detectStructuralKernelAntiCheatFromNotices(
    rawDrmNotice,
    ...nextPlatforms.map((p) => p?.xboxBottleCompatibilityReason)
  );
  const existingPlatAntiCheat = nextPlatforms.find(
    (p) =>
      p?.requiresKernelAntiCheat ||
      Boolean(p?.kernelAntiCheatName) ||
      Boolean(resolveCanonicalKernelAntiCheatDisplayName(p?.antiCheatName))
  );
  const existingPlatKernelAntiCheatName = nextPlatforms
    .map(
      (p) =>
        p?.kernelAntiCheatName ||
        resolveCanonicalKernelAntiCheatDisplayName(p?.antiCheatName) ||
        (normalizeChainedHandoffId(
          p?.chainedLauncherHandoff || p?.externalStorefrontHandoff || p?.platformId
        ) === 'riot'
          ? 'Riot Vanguard'
          : undefined)
    )
    .find(Boolean);

  const effectiveKernelAntiCheatName =
    structuralAntiCheat?.kernelAntiCheatName ||
    game.kernelAntiCheatName ||
    resolveCanonicalKernelAntiCheatDisplayName(game.antiCheatName) ||
    existingPlatKernelAntiCheatName;

  const effectiveRequiresAntiCheat = Boolean(
    antiCheatFromNotice ||
      structuralAntiCheat ||
      game.requiresKernelAntiCheat ||
      existingPlatAntiCheat ||
      effectiveKernelAntiCheatName
  );
  const effectiveAntiCheatName =
    antiCheatFromNotice?.antiCheatName ||
    game.antiCheatName ||
    existingPlatAntiCheat?.antiCheatName ||
    effectiveKernelAntiCheatName;

  if (effectiveRequiresAntiCheat && !hasGenuineMacPlatformEntry) {
    nextPlatforms = nextPlatforms.map((p) => {
      if (!p || typeof p !== 'object') return p;
      const pid = String(p.platformId || '').toLowerCase();
      if (pid === 'gog' || p.platforms?.mac === true) return p;
      const targetKernelName = p.kernelAntiCheatName || effectiveKernelAntiCheatName;
      const targetLegacyName = p.antiCheatName || effectiveAntiCheatName;
      if (
        p.requiresKernelAntiCheat === true &&
        (!targetKernelName || p.kernelAntiCheatName === targetKernelName) &&
        (!targetLegacyName || p.antiCheatName === targetLegacyName)
      ) {
        return p;
      }
      platformsChanged = true;
      return {
        ...p,
        requiresKernelAntiCheat: true,
        ...(targetKernelName ? { kernelAntiCheatName: targetKernelName } : {}),
        ...(targetLegacyName ? { antiCheatName: targetLegacyName } : {}),
      };
    });
  }

  const allOwnedEntriesExcludeMac =
    nextPlatforms.length > 0 &&
    !hasGenuineMacPlatformEntry &&
    nextPlatforms.every((p) => {
      if (!p || typeof p !== 'object') return false;
      const pid = String(p.platformId || '').toLowerCase();
      const handoff = normalizeChainedHandoffId(
        p.chainedLauncherHandoff || p.externalStorefrontHandoff
      );
      if (handoff && WINDOWS_ONLY_CHAINED_HANDOFFS.has(handoff)) {
        if (pid === 'steam' && p.platforms?.mac === true) return false;
        return true;
      }
      if (
        pid === 'xbox' ||
        pid === 'ubisoft' ||
        pid === 'ea' ||
        pid === 'rockstar' ||
        pid === 'riot' ||
        pid === 'epic'
      ) {
        return true;
      }
      if (
        p.platforms &&
        typeof p.platforms === 'object' &&
        !Array.isArray(p.platforms) &&
        p.platforms.mac === false
      ) {
        return true;
      }
      return false;
    });

  let nextGame: CanonicalGame = platformsChanged ? { ...game, platforms: nextPlatforms } : game;

  if (
    effectiveRequiresAntiCheat &&
    !hasGenuineMacPlatformEntry &&
    (nextGame.requiresKernelAntiCheat !== true ||
      (effectiveKernelAntiCheatName &&
        nextGame.kernelAntiCheatName !== effectiveKernelAntiCheatName) ||
      (effectiveAntiCheatName && nextGame.antiCheatName !== effectiveAntiCheatName))
  ) {
    nextGame = {
      ...nextGame,
      requiresKernelAntiCheat: true,
      ...(effectiveKernelAntiCheatName
        ? {
            kernelAntiCheatName: nextGame.kernelAntiCheatName || effectiveKernelAntiCheatName,
          }
        : {}),
      ...(effectiveAntiCheatName
        ? { antiCheatName: nextGame.antiCheatName || effectiveAntiCheatName }
        : {}),
    };
  }

  if (allOwnedEntriesExcludeMac) {
    if (
      nextGame.worksOn &&
      typeof nextGame.worksOn === 'object' &&
      (nextGame.worksOn.mac || nextGame.worksOn.Mac || nextGame.worksOn.windows === false)
    ) {
      nextGame = {
        ...nextGame,
        worksOn: { windows: true, mac: false, linux: false },
      };
    }
    if (
      nextGame.platforms_os &&
      typeof nextGame.platforms_os === 'object' &&
      (nextGame.platforms_os.mac || nextGame.platforms_os.windows === false)
    ) {
      nextGame = {
        ...nextGame,
        platforms_os: { windows: true, mac: false, linux: false },
      };
    }
    if (
      Array.isArray(nextGame.nativePlatforms) &&
      (nextGame.nativePlatforms.includes('mac') || !nextGame.nativePlatforms.includes('windows'))
    ) {
      nextGame = {
        ...nextGame,
        nativePlatforms: ['windows'],
      };
    }
    const rawSupported = (nextGame as { supportedPlatforms?: string[] }).supportedPlatforms;
    if (Array.isArray(rawSupported)) {
      const filteredSupported = rawSupported.filter(
        (os) => !/^(?:mac|macos|osx)$/i.test(String(os || '').trim())
      );
      if (!filteredSupported.some((os) => /^windows$/i.test(String(os || '').trim()))) {
        filteredSupported.unshift('windows');
      }
      if (
        filteredSupported.length !== rawSupported.length ||
        filteredSupported.some((v, idx) => v !== rawSupported[idx])
      ) {
        nextGame = {
          ...nextGame,
          ...({ supportedPlatforms: filteredSupported } as Record<string, unknown>),
        };
      }
    }
  } else if (nextPlatforms.some((p) => p?.isCrossPlatformLauncherRuntime === true)) {
    const supportsLinux = nextPlatforms.some((p) => p?.platforms?.linux === true);
    if (
      !nextGame.worksOn ||
      typeof nextGame.worksOn !== 'object' ||
      nextGame.worksOn.mac !== true ||
      nextGame.worksOn.windows === false ||
      (supportsLinux && nextGame.worksOn.linux !== true)
    ) {
      nextGame = {
        ...nextGame,
        worksOn: {
          ...(nextGame.worksOn || {}),
          windows: true,
          mac: true,
          linux: supportsLinux || Boolean(nextGame.worksOn?.linux),
        },
      };
    }
    if (
      nextGame.platforms_os &&
      typeof nextGame.platforms_os === 'object' &&
      (nextGame.platforms_os.mac !== true || nextGame.platforms_os.windows === false)
    ) {
      nextGame = {
        ...nextGame,
        platforms_os: {
          ...nextGame.platforms_os,
          windows: true,
          mac: true,
          linux: supportsLinux || Boolean(nextGame.platforms_os.linux),
        },
      };
    }
    if (Array.isArray(nextGame.nativePlatforms) && !nextGame.nativePlatforms.includes('mac')) {
      nextGame = {
        ...nextGame,
        nativePlatforms: Array.from(
          new Set([...nextGame.nativePlatforms, 'windows' as const, 'mac' as const])
        ),
      };
    }
  }

  return nextGame;
}
