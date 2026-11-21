import type {
  ActiveGameSession,
  DownloadTaskState,
  GameInstallInfo,
  HibernateStatePayload,
  InstalledGameRecord,
  LauncherPerformanceSettings,
} from '../../../contracts/launcher';
import type { StorefrontId } from '../../../contracts/platform';
import { sanitizeGameInstallSizeBytes } from '../../../utils/formatBytes';

export const WINDOWS_EXECUTABLE_EXT_RE = /\.(exe|bat|msi)$/i;
export const BOTTLE_PATH_RE = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i;

export function isWindowsExecutablePath(targetPath?: string | null): boolean {
  return typeof targetPath === 'string' && WINDOWS_EXECUTABLE_EXT_RE.test(targetPath.trim());
}

export function isBottleFilesystemPath(targetPath?: string | null): boolean {
  return typeof targetPath === 'string' && BOTTLE_PATH_RE.test(targetPath);
}

export function getLauncherErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (
    err &&
    typeof err === 'object' &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    const msg = (err as { message: string }).message;
    if (msg) return msg;
  }
  return fallback;
}

export function sanitizeGameInstallInfo(info: GameInstallInfo): GameInstallInfo {
  return {
    ...info,
    estimatedSizeBytes: sanitizeGameInstallSizeBytes(info.estimatedSizeBytes),
    downloadSizeBytes: sanitizeGameInstallSizeBytes(info.downloadSizeBytes),
    dlcSizeBytes: sanitizeGameInstallSizeBytes(info.dlcSizeBytes),
    ...(Array.isArray(info.availableInstallers)
      ? {
          availableInstallers: info.availableInstallers.map((ins) => ({
            ...ins,
            totalSizeBytes: sanitizeGameInstallSizeBytes(ins.totalSizeBytes),
            downloadSizeBytes: sanitizeGameInstallSizeBytes(ins.downloadSizeBytes),
            dlcSizeBytes: sanitizeGameInstallSizeBytes(ins.dlcSizeBytes),
          })),
        }
      : {}),
  };
}

export interface GameInstalledEventDetail {
  gameId: string;
  platformId: StorefrontId;
  platformGameId: string;
  steamAppId?: number;
  installPath?: string;
  executablePath?: string;
  launchArguments?: string;
  version?: string;
  xboxProductId?: string;
  packageFamilyName?: string;
  appUserModelId?: string;
  xboxTitleId?: string;
  scid?: string;
  msaAppId?: string;
  isWindowsBinaryOnMac?: boolean;
  installed: boolean;
}

export function buildGameInstalledEventDetailFromRecord(
  gameId: string,
  rec: InstalledGameRecord,
  installed: boolean,
  overrides?: {
    platformId?: StorefrontId;
    platformGameId?: string;
    steamAppId?: number;
  }
): GameInstalledEventDetail {
  return {
    gameId,
    platformId: overrides?.platformId ?? rec.platformId,
    platformGameId: overrides?.platformGameId ?? rec.platformGameId,
    ...(overrides?.steamAppId ? { steamAppId: overrides.steamAppId } : {}),
    installPath: rec.installPath,
    executablePath: rec.executablePath,
    ...(rec.launchArguments ? { launchArguments: rec.launchArguments } : {}),
    ...(rec.version ? { version: rec.version } : {}),
    ...(rec.xboxProductId ? { xboxProductId: rec.xboxProductId } : {}),
    ...(rec.packageFamilyName ? { packageFamilyName: rec.packageFamilyName } : {}),
    ...(rec.appUserModelId ? { appUserModelId: rec.appUserModelId } : {}),
    ...(rec.xboxTitleId ? { xboxTitleId: rec.xboxTitleId } : {}),
    ...(rec.scid ? { scid: rec.scid } : {}),
    ...(rec.msaAppId ? { msaAppId: rec.msaAppId } : {}),
    isWindowsBinaryOnMac: rec.isWindowsBinaryOnMac,
    installed,
  };
}

export function dispatchGameInstalledEvent(detail: GameInstalledEventDetail): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('antigravity:game-installed', { detail }));
  }
}

export function dispatchLauncherStateChangedEvent(detail: {
  runningGames: ActiveGameSession[];
  downloadQueue: DownloadTaskState[];
  installedRecords: InstalledGameRecord[];
  inGameHibernating: boolean;
  performanceSettings: LauncherPerformanceSettings;
}): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('antigravity:launcher-state-changed', { detail }));
  }
}

export function dispatchHibernateStateChangedEvent(
  hibernating: boolean,
  extra?: Partial<HibernateStatePayload>
): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(
      new CustomEvent('antigravity:hibernate-state-changed', {
        detail: {
          ...extra,
          hibernating,
          hibernated: hibernating,
          isHibernated: hibernating,
        },
      })
    );
  }
}

export function dispatchCloudSyncTelemetryEvent(detail: unknown): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('antigravity:cloud-sync-telemetry', { detail }));
  }
}

export function dispatchGameSessionEndedEvent(detail: Record<string, unknown>): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('antigravity:game-session-ended', { detail }));
  }
}

export function dispatchGameLaunchErrorEvent(detail: {
  gameId: string;
  platformId: StorefrontId;
  error: string;
}): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('antigravity:game-launch-error', { detail }));
  }
}

export function dispatchOpenDownloadDrawerEvent(): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('antigravity:open-download-drawer'));
  }
}
