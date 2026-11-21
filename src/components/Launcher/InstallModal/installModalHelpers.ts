import type { CanonicalGame } from '../../../contracts/game';
import { toOlMediaUrl } from '../../../contracts/network';
import type { StorefrontId } from '../../../contracts/platform';
import {
  type CompatibilityLayerInfo,
  type CompatibilityLayerType,
  type DiskSpaceInfo,
  type GameInstallInfo,
  resolveDefaultBottleForLayer,
} from '../../../contracts/launcher';
import {
  getDefaultBottleNameForRunner,
  isBottleNameCompatibleWithRunner,
} from '../../../services/launcher/bottleArchitectureUtils';
import {
  detectKernelAntiCheatFromNotice,
  detectStructuralKernelAntiCheatFromNotices,
  isBattlEyeKernelAntiCheat,
  normalizeChainedHandoffId,
} from '../../../services/integrations/catalogSanitizer';
import { launcherService } from '../../../services/launcher/launcherService';
import { sanitizeGameInstallSizeBytes } from '../../../utils/formatBytes';

export type InstallerItem = NonNullable<GameInstallInfo['availableInstallers']>[number];

export type GameInstallRequestPayload = Parameters<typeof launcherService.startInstall>[0] & {
  xboxProductId?: string;
  packageFamilyName?: string;
  appUserModelId?: string;
  xboxTitleId?: string;
  scid?: string;
  msaAppId?: string;
  preferClientlessExtraction?: boolean;
  totalBytes?: number;
  compatibilityLayer?: CompatibilityLayerType;
  wineBottleName?: string;
};

const CHAINED_INSTALLER_ID_RE = /-chained-(?:bottle|host|win)-launcher$/i;

export function formatVersion(v?: string): string {
  if (!v) return '';
  const cleaned = String(v).trim().replace(/^[vV]+/, '');
  return cleaned ? `v${cleaned}` : '';
}

export function isChainedInstallerItem(ins?: InstallerItem | null): boolean {
  if (!ins) return false;
  return Boolean(
    ins.chainedLauncherHandoff ||
      ins.externalStorefrontHandoff ||
      CHAINED_INSTALLER_ID_RE.test(String(ins.id || ''))
  );
}

function mapHandoffIdToLauncherName(id?: string): string | null {
  switch (id) {
    case 'ubisoft':
      return 'Ubisoft Connect';
    case 'ea':
      return 'EA App';
    case 'bnet':
      return 'Battle.net';
    case 'rockstar':
      return 'Rockstar Games Launcher';
    case 'riot':
      return 'Riot Client';
    default:
      return null;
  }
}

export function resolveChainedPublisherLauncherName(params: {
  selectedInstaller?: InstallerItem;
  installInfo?: GameInstallInfo | null;
  activePlatformObj?: CanonicalGame['platforms'][number];
}): string {
  const explicit =
    params.selectedInstaller?.externalLauncher ||
    params.installInfo?.externalLauncher ||
    params.activePlatformObj?.externalLauncher ||
    params.installInfo?.xboxCompatibility?.externalLauncher ||
    params.installInfo?.xboxCompatibility?.externalStorefront;
  if (explicit && explicit.trim()) {
    const normalizedExplicit = normalizeChainedHandoffId(explicit);
    const mappedExplicit = mapHandoffIdToLauncherName(normalizedExplicit);
    if (mappedExplicit) return mappedExplicit;
    return explicit.trim();
  }
  const rawKey =
    params.selectedInstaller?.chainedLauncherHandoff ||
    params.selectedInstaller?.externalStorefrontHandoff ||
    params.installInfo?.chainedLauncherHandoff ||
    params.installInfo?.externalStorefrontHandoff ||
    params.installInfo?.xboxCompatibility?.chainedLauncherHandoff ||
    params.installInfo?.xboxCompatibility?.externalStorefrontHandoff ||
    params.activePlatformObj?.chainedLauncherHandoff ||
    params.activePlatformObj?.externalStorefrontHandoff ||
    '';
  const normalizedKey =
    normalizeChainedHandoffId(rawKey) || String(rawKey).trim().toLowerCase();
  return mapHandoffIdToLauncherName(normalizedKey) || 'Publisher Launcher';
}

export function deduplicateInstallers(
  installers?: GameInstallInfo['availableInstallers'],
  winHost = false
): InstallerItem[] {
  if (!installers || installers.length === 0) return [];

  const normalizedInstallers = installers.map((ins) => {
    if (CHAINED_INSTALLER_ID_RE.test(String(ins.id || ''))) {
      return { ...ins, os: 'windows' as const };
    }
    if (ins.id === 'xbox-external-mac-launcher') {
      return { ...ins, os: 'mac' as const };
    }
    return ins;
  });

  let filtered = normalizedInstallers;
  if (winHost) {
    const winOnly = normalizedInstallers.filter((i) => i.os === 'windows');
    if (winOnly.length > 0) filtered = winOnly;
  } else {
    const nonLinux = normalizedInstallers.filter((i) => i.os !== 'linux');
    if (nonLinux.length > 0) filtered = nonLinux;
  }

  const byGroup = new Map<string, InstallerItem[]>();
  for (const ins of filtered) {
    const groupKey = ins.os;
    const list = byGroup.get(groupKey) || [];
    list.push(ins);
    byGroup.set(groupKey, list);
  }

  const bestPerGroup: InstallerItem[] = [];
  for (const [, candidates] of byGroup.entries()) {
    const sorted = candidates.toSorted((a, b) => {
      const chainedDiff =
        (isChainedInstallerItem(a) ? 0 : 1) - (isChainedInstallerItem(b) ? 0 : 1);
      if (chainedDiff !== 0) return chainedDiff;
      const langDiff =
        (/^en/i.test(a.language || '') ? 0 : 1) - (/^en/i.test(b.language || '') ? 0 : 1);
      if (langDiff !== 0) return langDiff;
      return (
        (sanitizeGameInstallSizeBytes(b.totalSizeBytes) || 0) -
        (sanitizeGameInstallSizeBytes(a.totalSizeBytes) || 0)
      );
    });
    bestPerGroup.push(sorted[0]);
  }

  const getSortRank = (item: InstallerItem): number => {
    if (winHost) {
      if (item.os === 'windows') return 0;
      if (item.os === 'mac') return 1;
      return 2;
    }
    if (item.os === 'mac') return 0;
    if (item.os === 'windows') return 1;
    return 2;
  };

  return bestPerGroup.toSorted((a, b) => getSortRank(a) - getSortRank(b));
}

export function resolveHeaderImageMediaUrl(game: CanonicalGame): string | undefined {
  if (!game.headerImage) return undefined;
  const gogPlatform = game.platforms.find((p) => p.platformId === 'gog');
  const epicPlatform = game.platforms.find((p) => p.platformId === 'epic');
  const xboxPlatform = game.platforms.find((p) => p.platformId === 'xbox');
  return toOlMediaUrl({
    url: game.headerImage,
    gameId: game.id,
    role: 'header',
    ordinal: 0,
    steamAppId: game.steamAppId,
    gogId: gogPlatform?.platformGameId,
    epicAppName: epicPlatform?.platformGameId,
    xboxProductId: xboxPlatform?.xboxProductId || xboxPlatform?.platformGameId,
    packageFamilyName: xboxPlatform?.packageFamilyName,
    xboxTitleId: xboxPlatform?.xboxTitleId,
  });
}

export function resolveTargetSteamDisplayPath(params: {
  isWindowsHost: boolean;
  selectedOs: 'mac' | 'windows' | 'linux';
  activeCompatLayer?: CompatibilityLayerInfo;
  selectedBottleName: string;
  winePrefixPath?: string;
  installInfo: GameInstallInfo | null;
  installDir: string;
}): string {
  const {
    isWindowsHost,
    selectedOs,
    activeCompatLayer,
    selectedBottleName,
    winePrefixPath,
    installInfo,
    installDir,
  } = params;

  if (!isWindowsHost && selectedOs === 'windows') {
    const isCrossOverLayer =
      !activeCompatLayer ||
      activeCompatLayer.type === 'crossover' ||
      activeCompatLayer.type === 'crossover_preview' ||
      activeCompatLayer.type === 'crossover_preview_arm64' ||
      Boolean(selectedBottleName);
    if (isCrossOverLayer) {
      const isPreviewLayer =
        activeCompatLayer?.type === 'crossover_preview' ||
        activeCompatLayer?.type === 'crossover_preview_arm64';
      const defaultBottlesRoot = isPreviewLayer
        ? '~/Library/Application Support/CrossOver Preview/Bottles'
        : '~/Library/Application Support/CrossOver/Bottles';
      const bottlesRoot = (activeCompatLayer?.bottlesDir || defaultBottlesRoot).replace(
        /\/+$/,
        ''
      );
      const compatibleBottles = (activeCompatLayer?.availableBottles || []).filter((b) =>
        isBottleNameCompatibleWithRunner(b, activeCompatLayer?.type || '', {
          layer: activeCompatLayer,
        })
      );
      const fallbackBottle = getDefaultBottleNameForRunner(activeCompatLayer?.type || '');
      const defaultResolvedBottle =
        resolveDefaultBottleForLayer(
          activeCompatLayer
            ? {
                type: activeCompatLayer.type,
                availableBottles: compatibleBottles,
                bottleDetails: activeCompatLayer.bottleDetails,
              }
            : undefined,
          activeCompatLayer?.type
        ) || fallbackBottle;
      const bottleName = selectedBottleName || defaultResolvedBottle;
      return `${bottlesRoot}/${bottleName}/drive_c/Program Files (x86)/Steam/steamapps/common`;
    }
    const prefixRoot = (
      (activeCompatLayer as (CompatibilityLayerInfo & { prefixPath?: string }) | undefined)
        ?.prefixPath ||
      winePrefixPath ||
      '~/Games/OneLauncher/Prefixes/default'
    ).replace(/\/+$/, '');
    return `${prefixRoot}/drive_c/Program Files (x86)/Steam/steamapps/common`;
  }

  if (!isWindowsHost) {
    const nativeCandidates = [
      ...(installInfo?.availableInstallDirs || []),
      installInfo?.defaultInstallDir,
      installDir,
    ].filter(
      (d): d is string =>
        typeof d === 'string' &&
        d.length > 0 &&
        !/\/Bottles\//i.test(d) &&
        !/\/drive_c\//i.test(d)
    );
    return nativeCandidates[0] || '~/Library/Application Support/Steam/steamapps/common';
  }

  return (
    installDir ||
    installInfo?.defaultInstallDir ||
    installInfo?.availableInstallDirs?.[0] ||
    'C:\\Program Files (x86)\\Steam\\steamapps\\common'
  );
}

export interface InstallMethodDescription {
  title: string;
  desc: string;
}

export function getInstallMethodDescription(params: {
  platId: StorefrontId;
  gameTitle: string;
  isWindowsHost: boolean;
  selectedOs: 'mac' | 'windows' | 'linux';
  isChainedWinInstaller: boolean;
  isChainedBottleInstaller: boolean;
  isCrossPlatformMacLauncher: boolean;
  isXboxMacBlocked: boolean;
  hasKernelAntiCheatRequirement: boolean;
  detectedAntiCheatName?: string;
  chainedLauncherName: string;
  preferClientlessExtraction: boolean;
  canDirectDownload?: boolean;
}): InstallMethodDescription {
  const {
    platId,
    gameTitle,
    isWindowsHost,
    selectedOs,
    isChainedWinInstaller,
    isChainedBottleInstaller,
    isCrossPlatformMacLauncher,
    isXboxMacBlocked,
    hasKernelAntiCheatRequirement,
    detectedAntiCheatName,
    chainedLauncherName,
    preferClientlessExtraction,
    canDirectDownload,
  } = params;

  switch (platId) {
    case 'gog':
      return {
        title: 'Native gogdl CLI + GOG Direct Installer Pipeline',
        desc: isWindowsHost
          ? 'Downloads official DRM-free Windows game files directly from GOG CDN via bundled gogdl with automatic credential bridging.'
          : 'Installs via native gogdl integration with automatic credential bridging from your authenticated GOG session, or downloads and extracts DRM-free offline installer packages (.pkg / .dmg / .exe) directly into your target directory.',
      };
    case 'epic':
      if (isWindowsHost && isChainedWinInstaller) {
        return {
          title: `Chained ${chainedLauncherName} + Epic Partner Link Pipeline (Windows)`,
          desc: `One Launcher will set up or open ${chainedLauncherName} on Windows so you can sign in with your linked account and install ${gameTitle}.`,
        };
      }
      if (!isWindowsHost && isChainedBottleInstaller) {
        return {
          title: `Chained ${chainedLauncherName} Bottle Pipeline (CrossOver / Wine)`,
          desc: `One Launcher will automatically set up ${chainedLauncherName} inside your bottle if needed and open it so you can sign in with your linked account and install ${gameTitle}.`,
        };
      }
      return {
        title: 'Native Legendary CLI / Epic Games Store Pipeline',
        desc: isWindowsHost
          ? 'Downloads and verifies native Windows game files directly from Epic Games CDN via bundled Legendary CLI.'
          : 'Installs directly via native legendary integration with automatic credential bridging from your authenticated Epic session (or Heroic / Epic Games Launcher fallback) while monitoring real-time manifest progress.',
      };
    case 'xbox':
      if (isWindowsHost) {
        if (isChainedWinInstaller) {
          return {
            title: `Chained ${chainedLauncherName} Pipeline (Windows)`,
            desc: `One Launcher will set up or open ${chainedLauncherName} on Windows so you can sign in with your linked account and install ${gameTitle}.`,
          };
        }
        if (preferClientlessExtraction && canDirectDownload) {
          return {
            title: 'Clientless MSIXVC Extraction Pipeline (Advanced)',
            desc: 'Streams and extracts unencrypted Win32 GDK game files directly from Xbox Content Delivery CDN into your chosen folder without GamingServices.',
          };
        }
        return {
          title: 'Microsoft Store / GamingServices Native Pipeline',
          desc: 'Triggers official Microsoft Store / Xbox App installation (ms-windows-store://pdp/?ProductId=...) and monitors GamingServices .GamingRoot drives (such as C:\\XboxGames) for completion.',
        };
      }
      if (isXboxMacBlocked) {
        return {
          title: hasKernelAntiCheatRequirement
            ? `Blocked on macOS (${detectedAntiCheatName || 'Kernel Anti-Cheat'})`
            : 'Native Windows Required (Blocked on macOS)',
          desc: hasKernelAntiCheatRequirement
            ? `Bottle installation is disabled on macOS because ${detectedAntiCheatName || 'this title'} requires a Windows ring-0 kernel driver that cannot load under Wine / CrossOver.`
            : 'Bottle installation is disabled on macOS because this title requires native Windows components unavailable inside Wine / CrossOver.',
        };
      }
      if (isChainedBottleInstaller) {
        return {
          title: `Chained ${chainedLauncherName} Bottle Pipeline (CrossOver / Wine)`,
          desc: `One Launcher will automatically set up ${chainedLauncherName} inside your bottle if needed and open it so you can sign in with your linked account and install ${gameTitle}.`,
        };
      }
      if (isCrossPlatformMacLauncher) {
        return {
          title: `Native macOS ${chainedLauncherName} Pipeline`,
          desc: `Sets up the official macOS ${chainedLauncherName} client so you can sign in with your linked account and play natively on your Mac.`,
        };
      }
      return {
        title: 'Clientless MSIXVC Extraction + CrossOver / Wine Pipeline',
        desc: 'Downloads and extracts standard Win32 GDK files from Xbox Content Delivery packages into your target folder and configures CrossOver / Wine execution.',
      };
    case 'steam':
      if (!isWindowsHost && selectedOs === 'windows') {
        return {
          title: 'CrossOver Windows Steam Bottle + Live ACF Progress Monitor',
          desc: 'Installs the Windows build inside your CrossOver bottle via Windows Steam (automatically bootstrapping Windows Steam if needed) and tracks real-time download progress via appmanifest_*.acf.',
        };
      }
      return {
        title: 'Steam Client Protocol + Live ACF Progress Monitor',
        desc: isWindowsHost
          ? 'Triggers Steam Client installation (steam://install/) and monitors real-time download progress via steamapps/appmanifest_*.acf.'
          : 'Triggers native Steam installation (`steam://install`) and tracks real-time `BytesDownloaded` / `BytesToDownload` directly from local `appmanifest_*.acf` files.',
      };
    default:
      return {
        title: 'Universal Game Installer',
        desc: 'Downloads and configures game files in your selected installation directory.',
      };
  }
}

export interface InstallModalPlan {
  activePlatformObj: CanonicalGame['platforms'][number] | undefined;
  uniqueInstallers: InstallerItem[];
  hasMacBuildOption: boolean;
  macInstaller: InstallerItem | undefined;
  winInstaller: InstallerItem | undefined;
  selectedInstaller: InstallerItem | undefined;
  baseEstimatedBytes: number;
  knownDlcBytes: number;
  estimatedSizeBytes: number;
  usedPercent: number;
  installPercent: number;
  isVolumeMissing: boolean;
  hasEnoughSpaceOnTargetVolume: boolean;
  isExternalClientManagedDriveSelection: boolean;
  isInstallBlockedByDiskSpace: boolean;
  xboxCompat: GameInstallInfo['xboxCompatibility'] | undefined;
  handoffKeyLower: string;
  isCrossPlatformMacLauncher: boolean;
  showPreinstallCompatConfig: boolean;
  hasSelectedBottleArchMismatch: boolean;
  isRiotKernelAntiCheat: boolean;
  hasChainedBottleInstaller: boolean;
  isChainedBottleInstaller: boolean;
  isChainedWinInstaller: boolean;
  chainedLauncherName: string;
  detectedAntiCheatName: string | undefined;
  hasKernelAntiCheatRequirement: boolean;
  isBattlEyeAntiCheat: boolean;
  showMacKernelAntiCheatWarning: boolean;
  isCaseSensitiveTargetVolume: boolean;
  showXboxPublisherAccountLinkCallout: boolean;
  isXboxMacBlocked: boolean;
  methodInfo: InstallMethodDescription;
}

export function computeInstallModalPlan(params: {
  game: CanonicalGame;
  selectedPlatformId: StorefrontId;
  selectedInstallerId?: string;
  selectedOs: 'mac' | 'windows' | 'linux';
  isWindowsHost: boolean;
  installInfo: GameInstallInfo | null;
  diskSpace: DiskSpaceInfo | null;
  includeDlcs: boolean;
  preferClientlessExtraction: boolean;
  compatLayers: CompatibilityLayerInfo[];
  allRawCompatLayers: CompatibilityLayerInfo[];
  activeCompatLayer?: CompatibilityLayerInfo;
  effectiveCompatRunner: string;
  selectedBottleName: string;
}): InstallModalPlan {
  const {
    game,
    selectedPlatformId,
    selectedInstallerId,
    selectedOs,
    isWindowsHost,
    installInfo,
    diskSpace,
    includeDlcs,
    preferClientlessExtraction,
    compatLayers,
    allRawCompatLayers,
    activeCompatLayer,
    effectiveCompatRunner,
    selectedBottleName,
  } = params;

  const activePlatformObj =
    game.platforms.find((p) => p.platformId === selectedPlatformId) || game.platforms[0];

  const uniqueInstallers = deduplicateInstallers(installInfo?.availableInstallers, isWindowsHost);
  const hasMacBuildOption = uniqueInstallers.some((i) => i.os === 'mac');
  const macInstaller = uniqueInstallers.find((i) => i.os === 'mac');
  const winInstaller = uniqueInstallers.find((i) => i.os === 'windows');
  const selectedInstaller =
    uniqueInstallers.find((i) => i.id === selectedInstallerId) || uniqueInstallers[0];

  const baseEstimatedBytes =
    sanitizeGameInstallSizeBytes(selectedInstaller?.totalSizeBytes) ??
    sanitizeGameInstallSizeBytes(installInfo?.estimatedSizeBytes) ??
    (activePlatformObj?.installed
      ? sanitizeGameInstallSizeBytes(activePlatformObj?.installSize)
      : undefined) ??
    0;
  const knownDlcBytes =
    sanitizeGameInstallSizeBytes(selectedInstaller?.dlcSizeBytes) ??
    sanitizeGameInstallSizeBytes(installInfo?.dlcSizeBytes) ??
    0;
  const estimatedSizeBytes =
    baseEstimatedBytes +
    (includeDlcs && (selectedPlatformId === 'epic' || selectedPlatformId === 'gog')
      ? knownDlcBytes
      : 0);

  const freeBytes = diskSpace?.freeBytes || 0;
  const totalBytes = diskSpace?.totalBytes || 1;
  const usedBytes = diskSpace?.usedBytes || Math.max(0, totalBytes - freeBytes);
  const usedPercent =
    diskSpace && diskSpace.totalBytes > 0
      ? Math.min(100, Math.round((usedBytes / totalBytes) * 100))
      : 0;
  const installPercent =
    estimatedSizeBytes > 0 && (!diskSpace || diskSpace.totalBytes > 0)
      ? Math.min(
          100 - usedPercent,
          Math.max(1, Math.round((estimatedSizeBytes / totalBytes) * 100))
        )
      : 0;

  const isVolumeMissing = Boolean(diskSpace?.volumeMissing);
  const hasEnoughSpaceOnTargetVolume =
    !isVolumeMissing &&
    (estimatedSizeBytes === 0 || freeBytes === 0 || freeBytes >= estimatedSizeBytes);
  const isXboxStoreManagedInstall =
    selectedPlatformId === 'xbox' && isWindowsHost && !preferClientlessExtraction;
  const isExternalClientManagedDriveSelection =
    selectedPlatformId === 'steam' ||
    isXboxStoreManagedInstall ||
    Boolean(installInfo?.requiresStoreClientFallback && !preferClientlessExtraction);
  const isInstallBlockedByDiskSpace =
    !isExternalClientManagedDriveSelection && !hasEnoughSpaceOnTargetVolume;

  const xboxCompat = selectedPlatformId === 'xbox' ? installInfo?.xboxCompatibility : undefined;
  const rawHandoffCandidate =
    selectedInstaller?.chainedLauncherHandoff ||
    selectedInstaller?.externalStorefrontHandoff ||
    installInfo?.chainedLauncherHandoff ||
    installInfo?.externalStorefrontHandoff ||
    xboxCompat?.chainedLauncherHandoff ||
    xboxCompat?.externalStorefrontHandoff ||
    activePlatformObj?.chainedLauncherHandoff ||
    activePlatformObj?.externalStorefrontHandoff ||
    '';
  const handoffKeyLower =
    normalizeChainedHandoffId(rawHandoffCandidate) ||
    String(rawHandoffCandidate).trim().toLowerCase();
  const hasStoreChainedHandoff = Boolean(
    handoffKeyLower &&
      handoffKeyLower !== String(selectedPlatformId || '').toLowerCase() &&
      (selectedPlatformId === 'xbox' || selectedPlatformId === 'epic')
  );
  const isCrossPlatformMacLauncher =
    !isWindowsHost && selectedInstaller?.id === 'xbox-external-mac-launcher';
  const showPreinstallCompatConfig =
    !isWindowsHost &&
    selectedOs === 'windows' &&
    !isCrossPlatformMacLauncher &&
    compatLayers.length > 0;
  const hasSelectedBottleArchMismatch = Boolean(
    showPreinstallCompatConfig &&
      selectedBottleName &&
      !isBottleNameCompatibleWithRunner(selectedBottleName, effectiveCompatRunner, {
        layer: activeCompatLayer,
        allLayers: allRawCompatLayers,
      })
  );
  const isRiotKernelAntiCheat = handoffKeyLower === 'riot';
  const hasChainedBottleInstaller =
    !isRiotKernelAntiCheat &&
    (uniqueInstallers.some((i) => isChainedInstallerItem(i)) ||
      (!isCrossPlatformMacLauncher && hasStoreChainedHandoff));
  const isChainedBottleInstaller =
    !isWindowsHost &&
    !isCrossPlatformMacLauncher &&
    !isRiotKernelAntiCheat &&
    (isChainedInstallerItem(selectedInstaller) ||
      (selectedOs === 'windows' && hasStoreChainedHandoff));
  const isChainedWinInstaller =
    isWindowsHost && (isChainedInstallerItem(selectedInstaller) || hasStoreChainedHandoff);
  const chainedLauncherName = resolveChainedPublisherLauncherName({
    selectedInstaller,
    installInfo,
    activePlatformObj,
  });

  const rawNoticeText =
    game.enrichedMetadata?.drmNotice || (game as { drmNotice?: string }).drmNotice || null;
  const drmAntiCheatInfo = detectKernelAntiCheatFromNotice(rawNoticeText);
  const structuralAntiCheatInfo = detectStructuralKernelAntiCheatFromNotices(
    rawNoticeText,
    activePlatformObj?.xboxBottleCompatibilityReason,
    installInfo?.xboxBottleCompatibilityReason
  );
  const detectedAntiCheatName =
    selectedInstaller?.kernelAntiCheatName ||
    installInfo?.kernelAntiCheatName ||
    selectedInstaller?.antiCheatName ||
    installInfo?.antiCheatName ||
    xboxCompat?.antiCheatName ||
    activePlatformObj?.kernelAntiCheatName ||
    activePlatformObj?.antiCheatName ||
    game.kernelAntiCheatName ||
    game.antiCheatName ||
    drmAntiCheatInfo?.antiCheatName ||
    structuralAntiCheatInfo?.kernelAntiCheatName ||
    (isRiotKernelAntiCheat ? 'Riot Vanguard' : undefined);
  const hasKernelAntiCheatRequirement = Boolean(
    activePlatformObj?.requiresKernelAntiCheat ||
      game.requiresKernelAntiCheat ||
      installInfo?.requiresKernelAntiCheat ||
      selectedInstaller?.requiresKernelAntiCheat ||
      xboxCompat?.antiCheatDetected ||
      xboxCompat?.tier === 'tier_c_kernel_anticheat' ||
      drmAntiCheatInfo ||
      structuralAntiCheatInfo ||
      isRiotKernelAntiCheat
  );
  const isBattlEyeAntiCheat = isBattlEyeKernelAntiCheat(detectedAntiCheatName);
  const isMacBottleTarget =
    !isWindowsHost &&
    !isCrossPlatformMacLauncher &&
    (selectedOs === 'windows' || selectedPlatformId === 'xbox');
  const showMacKernelAntiCheatWarning = Boolean(
    isMacBottleTarget && hasKernelAntiCheatRequirement
  );
  const isCaseSensitiveTargetVolume = Boolean(
    !isWindowsHost &&
      isMacBottleTarget &&
      (diskSpace?.caseSensitive === true ||
        (diskSpace === null && installInfo?.diskSpace?.caseSensitive === true))
  );
  const showXboxPublisherAccountLinkCallout = Boolean(
    selectedPlatformId === 'xbox' &&
      !isCrossPlatformMacLauncher &&
      (handoffKeyLower === 'ea' ||
        handoffKeyLower === 'ubisoft' ||
        handoffKeyLower === 'bnet' ||
        handoffKeyLower === 'rockstar' ||
        handoffKeyLower === 'riot')
  );
  const isXboxMacBlocked =
    selectedPlatformId === 'xbox' &&
    !isWindowsHost &&
    Boolean(
      isRiotKernelAntiCheat ||
        (xboxCompat &&
          (xboxCompat.tier === 'tier_c_kernel_anticheat' ||
            (xboxCompat.tier === 'tier_c_external_launcher' &&
              !hasChainedBottleInstaller &&
              xboxCompat.canExtractAndRun !== true &&
              xboxCompat.supportedOnMacBottle !== true)))
    );

  const methodInfo = getInstallMethodDescription({
    platId: selectedPlatformId,
    gameTitle: game.title,
    isWindowsHost,
    selectedOs,
    isChainedWinInstaller,
    isChainedBottleInstaller,
    isCrossPlatformMacLauncher,
    isXboxMacBlocked,
    hasKernelAntiCheatRequirement,
    detectedAntiCheatName,
    chainedLauncherName,
    preferClientlessExtraction,
    canDirectDownload: installInfo?.canDirectDownload,
  });

  return {
    activePlatformObj,
    uniqueInstallers,
    hasMacBuildOption,
    macInstaller,
    winInstaller,
    selectedInstaller,
    baseEstimatedBytes,
    knownDlcBytes,
    estimatedSizeBytes,
    usedPercent,
    installPercent,
    isVolumeMissing,
    hasEnoughSpaceOnTargetVolume,
    isExternalClientManagedDriveSelection,
    isInstallBlockedByDiskSpace,
    xboxCompat,
    handoffKeyLower,
    isCrossPlatformMacLauncher,
    showPreinstallCompatConfig,
    hasSelectedBottleArchMismatch,
    isRiotKernelAntiCheat,
    hasChainedBottleInstaller,
    isChainedBottleInstaller,
    isChainedWinInstaller,
    chainedLauncherName,
    detectedAntiCheatName,
    hasKernelAntiCheatRequirement,
    isBattlEyeAntiCheat,
    showMacKernelAntiCheatWarning,
    isCaseSensitiveTargetVolume,
    showXboxPublisherAccountLinkCallout,
    isXboxMacBlocked,
    methodInfo,
  };
}

export function buildGameInstallPayload(params: {
  game: CanonicalGame;
  selectedPlatformId: StorefrontId;
  activePlatformObj?: CanonicalGame['platforms'][number];
  installInfo: GameInstallInfo | null;
  selectedInstaller?: InstallerItem;
  selectedInstallerId?: string;
  selectedOs: 'mac' | 'windows' | 'linux';
  isWindowsHost: boolean;
  isChainedBottleInstaller: boolean;
  isCrossPlatformMacLauncher: boolean;
  preferClientlessExtraction: boolean;
  installDir: string;
  createShortcut: boolean;
  includeDlcs: boolean;
  estimatedSizeBytes: number;
  effectiveCompatRunner: string;
  selectedBottleName: string;
}): GameInstallRequestPayload {
  const {
    game,
    selectedPlatformId,
    activePlatformObj,
    installInfo,
    selectedInstaller,
    selectedInstallerId,
    selectedOs,
    isWindowsHost,
    isChainedBottleInstaller,
    isCrossPlatformMacLauncher,
    preferClientlessExtraction,
    installDir,
    createShortcut,
    includeDlcs,
    estimatedSizeBytes,
    effectiveCompatRunner,
    selectedBottleName,
  } = params;

  const resolvedExternalLauncher =
    selectedInstaller?.externalLauncher || installInfo?.externalLauncher;
  const resolvedExternalLauncherUrl =
    selectedInstaller?.externalLauncherUrl || installInfo?.externalLauncherUrl;
  const rawExternalHandoff =
    selectedInstaller?.externalStorefrontHandoff ||
    installInfo?.externalStorefrontHandoff ||
    activePlatformObj?.externalStorefrontHandoff;
  const rawChainedHandoff =
    selectedInstaller?.chainedLauncherHandoff ||
    installInfo?.chainedLauncherHandoff ||
    activePlatformObj?.chainedLauncherHandoff;
  const normalizedPayloadHandoff = normalizeChainedHandoffId(
    rawChainedHandoff || rawExternalHandoff
  );
  const resolvedExternalHandoff = normalizedPayloadHandoff || rawExternalHandoff;
  const resolvedChainedHandoff = normalizedPayloadHandoff || rawChainedHandoff;
  const resolvedChainedExternalId =
    selectedInstaller?.chainedExternalInstallId ||
    installInfo?.chainedExternalInstallId ||
    activePlatformObj?.chainedExternalInstallId;
  const resolvedChainedTopology =
    selectedInstaller?.chainedHandoffTopology ||
    installInfo?.chainedHandoffTopology ||
    activePlatformObj?.chainedHandoffTopology;
  const resolvedEpicRegistryPath =
    selectedInstaller?.epicPartnerRegistryPath ||
    installInfo?.epicPartnerRegistryPath ||
    activePlatformObj?.epicPartnerRegistryPath;

  return {
    gameId: game.id,
    title: game.title,
    platformId: selectedPlatformId,
    platformGameId:
      installInfo?.platformGameId ||
      activePlatformObj?.xboxProductId ||
      activePlatformObj?.platformGameId ||
      String(game.steamAppId || game.id),
    xboxProductId: activePlatformObj?.xboxProductId,
    packageFamilyName: activePlatformObj?.packageFamilyName,
    appUserModelId: activePlatformObj?.appUserModelId,
    xboxTitleId: activePlatformObj?.xboxTitleId,
    scid: activePlatformObj?.scid,
    msaAppId: activePlatformObj?.msaAppId,
    ...(resolvedExternalLauncher ? { externalLauncher: resolvedExternalLauncher } : {}),
    ...(resolvedExternalLauncherUrl ? { externalLauncherUrl: resolvedExternalLauncherUrl } : {}),
    ...(resolvedExternalHandoff ? { externalStorefrontHandoff: resolvedExternalHandoff } : {}),
    ...(resolvedChainedHandoff ? { chainedLauncherHandoff: resolvedChainedHandoff } : {}),
    ...(resolvedChainedExternalId ? { chainedExternalInstallId: resolvedChainedExternalId } : {}),
    ...(resolvedChainedTopology ? { chainedHandoffTopology: resolvedChainedTopology } : {}),
    ...(resolvedEpicRegistryPath ? { epicPartnerRegistryPath: resolvedEpicRegistryPath } : {}),
    preferClientlessExtraction:
      selectedPlatformId === 'xbox'
        ? isWindowsHost
          ? preferClientlessExtraction
          : !isChainedBottleInstaller && !isCrossPlatformMacLauncher
        : undefined,
    steamAppId: selectedPlatformId === 'steam' ? game.steamAppId : undefined,
    headerImage: game.headerImage,
    installDir:
      installDir.trim() || (isWindowsHost ? 'C:\\Games\\OneLauncher' : '~/Games/OneLauncher'),
    installerId: selectedInstallerId,
    os: isWindowsHost
      ? 'windows'
      : isCrossPlatformMacLauncher
        ? 'mac'
        : selectedPlatformId === 'xbox'
          ? 'windows'
          : selectedOs,
    createShortcut,
    includeDlcs:
      selectedPlatformId === 'epic' || selectedPlatformId === 'gog' ? includeDlcs : false,
    estimatedSizeBytes: estimatedSizeBytes > 0 ? estimatedSizeBytes : undefined,
    totalBytes: estimatedSizeBytes > 0 ? estimatedSizeBytes : undefined,
    ...(!isWindowsHost &&
    (selectedOs === 'windows' || (selectedPlatformId === 'xbox' && !isCrossPlatformMacLauncher))
      ? {
          compatibilityLayer: (effectiveCompatRunner || 'crossover') as CompatibilityLayerType,
          wineBottleName: selectedBottleName.trim() || undefined,
        }
      : {}),
  };
}
