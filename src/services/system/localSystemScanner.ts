import type { ChainedHandoffTopology } from '../../contracts/game';
import type { GameInstallInfo, InstalledGameRecord } from '../../contracts/launcher';
import { STOREFRONT_REGISTRY, type StorefrontId } from '../../contracts/platform';
import { sanitizeGameInstallSizeBytes } from '../../utils/formatBytes';

export type ScannedInstalledGameItem = InstalledGameRecord & {
  appId: number;
  name?: string;
  installPath: string;
  xboxCompatibility?: GameInstallInfo['xboxCompatibility'];
  packageFormat?: string;
  xboxBottleCompatibilityTier?: string;
  bottleName?: string;
};

export interface LocalSystemScanResult {
  success: boolean;
  installedSteamAppIds: number[];
  installedGames?: ScannedInstalledGameItem[];
  scannedAt?: string;
  error?: string;
}

export interface SteamAchievementRecord {
  unlocked: number;
  total: number;
  percentage: number;
  source?: 'local_client_cache';
  syncedAt?: string;
  hasConflict?: boolean;
  conflictDetails?: string;
}

interface RawScannedInstalledGame {
  platformId?: string;
  storefront?: string;
  store?: string;
  platformGameId?: string | number;
  appId?: string | number;
  title?: string;
  name?: string;
  installPath?: string;
  executablePath?: string;
  installSize?: number;
  version?: string;
  manifestPath?: string;
  xboxProductId?: string;
  packageFamilyName?: string;
  appUserModelId?: string;
  xboxTitleId?: string;
  scid?: string;
  msaAppId?: string;
  isCrossPlatformLauncherRuntime?: boolean;
  externalStorefrontHandoff?: StorefrontId | 'riot' | string;
  chainedLauncherHandoff?: string;
  chainedExternalInstallId?: string;
  chainedHandoffTopology?: ChainedHandoffTopology;
  epicPartnerRegistryPath?: string;
  requiresKernelAntiCheat?: boolean;
  antiCheatName?: string;
  xboxCompatibility?: GameInstallInfo['xboxCompatibility'];
  packageFormat?: string;
  xboxBottleCompatibilityTier?: string;
  bottleName?: string;
  runner?: InstalledGameRecord['runner'];
  launchArguments?: string;
  isWindowsBinaryOnMac?: boolean;
  executableArchitecture?: string;
  is32BitExecutable?: boolean;
}

const SCANNED_PLATFORM_ALIASES: Readonly<Record<string, StorefrontId>> = {
  'ea app': 'ea',
  ea_app: 'ea',
  origin: 'ea',
  'battle.net': 'bnet',
  battlenet: 'bnet',
  uplay: 'ubisoft',
  'ubisoft connect': 'ubisoft',
  'itch.io': 'itch',
  'epic games': 'epic',
  'gog galaxy': 'gog',
  'amazon prime': 'amazon',
  'rockstar games': 'rockstar',
  'humble bundle': 'humble',
};

function normalizeScannedPlatformId(raw?: string): StorefrontId {
  const lower = (raw || '').trim().toLowerCase();
  if (!lower) return 'custom';
  if (Object.hasOwn(STOREFRONT_REGISTRY, lower)) {
    return lower as StorefrontId;
  }
  if (Object.hasOwn(SCANNED_PLATFORM_ALIASES, lower)) {
    return SCANNED_PLATFORM_ALIASES[lower];
  }
  return 'custom';
}

function normalizeInstalledGamesList(
  rawList: RawScannedInstalledGame[]
): ScannedInstalledGameItem[] {
  if (!Array.isArray(rawList)) return [];
  return rawList.map((item) => {
    const platId = normalizeScannedPlatformId(item.platformId || item.storefront || item.store);
    const numAppId = platId === 'steam' ? Number(item.appId ?? item.platformGameId ?? 0) : 0;
    return {
      platformId: platId,
      platformGameId: String(item.platformGameId ?? item.appId ?? ''),
      appId: Number.isNaN(numAppId) ? 0 : numAppId,
      title: item.title || item.name,
      name: item.name || item.title,
      installPath: item.installPath || '',
      executablePath: item.executablePath,
      installSize: sanitizeGameInstallSizeBytes(item.installSize),
      version: item.version,
      manifestPath: item.manifestPath,
      xboxProductId: item.xboxProductId,
      packageFamilyName: item.packageFamilyName,
      appUserModelId: item.appUserModelId,
      xboxTitleId: item.xboxTitleId,
      scid: item.scid,
      msaAppId: item.msaAppId,
      isCrossPlatformLauncherRuntime: item.isCrossPlatformLauncherRuntime,
      externalStorefrontHandoff: item.externalStorefrontHandoff,
      chainedLauncherHandoff: item.chainedLauncherHandoff,
      chainedExternalInstallId: item.chainedExternalInstallId,
      chainedHandoffTopology: item.chainedHandoffTopology,
      epicPartnerRegistryPath: item.epicPartnerRegistryPath,
      requiresKernelAntiCheat: item.requiresKernelAntiCheat,
      antiCheatName: item.antiCheatName,
      xboxCompatibility: item.xboxCompatibility,
      packageFormat: item.packageFormat,
      xboxBottleCompatibilityTier: item.xboxBottleCompatibilityTier,
      bottleName: item.bottleName,
      runner: item.runner,
      launchArguments: item.launchArguments,
      isWindowsBinaryOnMac: item.isWindowsBinaryOnMac,
      executableArchitecture: item.executableArchitecture,
      is32BitExecutable: item.is32BitExecutable,
    };
  });
}

/**
 * Scans the local workstation for installed Steam, GOG, Epic, Heroic, and One Launcher games.
 * Returns the exact list of verified local installed games and Steam AppIDs.
 */
export async function scanLocalInstalledGames(): Promise<LocalSystemScanResult | null> {
  if (typeof window !== 'undefined' && window.electronAPI) {
    const scanFn =
      window.electronAPI.scanAllInstalledGames || window.electronAPI.scanLocalGames;
    if (scanFn) {
      try {
        const electronRes = await scanFn();
        if (electronRes && electronRes.success) {
          return {
            success: true,
            installedSteamAppIds: Array.isArray(electronRes.installedSteamAppIds)
              ? electronRes.installedSteamAppIds
              : [],
            installedGames: normalizeInstalledGamesList(
              (electronRes.installedGames || []) as RawScannedInstalledGame[]
            ),
            scannedAt: new Date().toISOString(),
          };
        }
        if (electronRes && electronRes.success === false) {
          return {
            success: false,
            installedSteamAppIds: [],
            installedGames: [],
            error: (electronRes as { error?: string }).error || 'scan_failed',
          };
        }
      } catch (e) {
        console.warn('Native Electron scanner call failed:', e);
        return {
          success: false,
          installedSteamAppIds: [],
          installedGames: [],
          error: e instanceof Error ? e.message : 'scan_failed',
        };
      }
    }
  }

  try {
    const res = await fetch('/api/local-system/installed-games');
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    return {
      success: !!data.success,
      installedSteamAppIds: Array.isArray(data.installedSteamAppIds) ? data.installedSteamAppIds : [],
      installedGames: normalizeInstalledGamesList(
        (data.installedGames || []) as RawScannedInstalledGame[]
      ),
      scannedAt: data.scannedAt,
    };
  } catch (err) {
    console.warn('Local system scanner endpoint unavailable:', err);
    return null;
  }
}

/**
 * Scans local Steam client userdata librarycache for accurate user achievement progress.
 * Returns map of AppID -> { unlocked, total, percentage }.
 */
export async function scanLocalSteamAchievements(): Promise<Record<number, SteamAchievementRecord> | null> {
  // First check if running inside native Electron application
  if (typeof window !== 'undefined' && window.electronAPI?.scanSteamAchievements) {
    try {
      const electronRes = await window.electronAPI.scanSteamAchievements();
      if (electronRes && electronRes.success && electronRes.achievements) {
        return electronRes.achievements;
      }
    } catch (e) {
      console.warn('Native Electron steam achievements scan failed:', e);
    }
  }

  try {
    const res = await fetch('/api/local-system/steam-achievements');
    if (res.ok) {
      const data = await res.json();
      if (data && data.success && data.achievements) {
        return data.achievements;
      }
    }
  } catch (err) {
    console.warn('Local steam achievements endpoint unavailable:', err);
  }
  return null;
}
