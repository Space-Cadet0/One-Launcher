import type { InstalledGameRecord } from '../../contracts/launcher';
import type { StorefrontId } from '../../contracts/platform';

export type ScannedInstalledGameItem = InstalledGameRecord & {
  appId: number;
  name?: string;
  installPath: string;
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
  runner?: InstalledGameRecord['runner'];
  launchArguments?: string;
  isWindowsBinaryOnMac?: boolean;
}

function normalizeScannedPlatformId(raw?: string): StorefrontId {
  const lower = (raw || '').trim().toLowerCase();
  if (lower === 'steam' || lower === 'gog' || lower === 'epic' || lower === 'xbox' || lower === 'custom') {
    return lower;
  }
  return 'steam';
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
      installSize: item.installSize,
      version: item.version,
      manifestPath: item.manifestPath,
      xboxProductId: item.xboxProductId,
      packageFamilyName: item.packageFamilyName,
      appUserModelId: item.appUserModelId,
      xboxTitleId: item.xboxTitleId,
      scid: item.scid,
      msaAppId: item.msaAppId,
      runner: item.runner,
      launchArguments: item.launchArguments,
      isWindowsBinaryOnMac: item.isWindowsBinaryOnMac,
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
            installedGames: normalizeInstalledGamesList(electronRes.installedGames || []),
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
      installedGames: normalizeInstalledGamesList(data.installedGames || []),
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
