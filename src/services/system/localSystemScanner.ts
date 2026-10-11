export interface LocalSystemScanResult {
  success: boolean;
  installedSteamAppIds: number[];
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

/**
 * Scans the local workstation for installed Steam, Heroic, and PC storefront games.
 * Returns the exact list of verified local installed AppIDs.
 */
export async function scanLocalInstalledGames(): Promise<LocalSystemScanResult | null> {
  // First check if running inside native Electron application
  if (typeof window !== 'undefined' && (window as any).electronAPI?.scanLocalGames) {
    try {
      const electronRes = await (window as any).electronAPI.scanLocalGames();
      if (electronRes && electronRes.success) {
        return {
          success: true,
          installedSteamAppIds: Array.isArray(electronRes.installedSteamAppIds) ? electronRes.installedSteamAppIds : [],
          scannedAt: new Date().toISOString(),
        };
      }
    } catch (e) {
      console.warn('Native Electron scanner call failed:', e);
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
  if (typeof window !== 'undefined' && (window as any).electronAPI?.scanSteamAchievements) {
    try {
      const electronRes = await (window as any).electronAPI.scanSteamAchievements();
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
    // Ignore fetch error in static builds
  }
  return null;
}
