import { CriticScoreData } from './critic';
import { CanonicalGame } from './game';
import {
  ActiveGameSession,
  CloudSaveSyncTelemetry,
  DownloadTaskState,
  HibernateStatePayload,
  InstalledGameRecord,
  LauncherPerformanceSettings,
} from './launcher';
import { UserGameOverride } from './override';
import { StorefrontId } from './platform';

export interface CriticUpdatedEventDetail {
  key?: string;
  cacheKey?: string;
  appId?: number;
  steamAppId?: number;
  title?: string;
  score?: number | null;
  data?: CriticScoreData | null;
}

export interface UserOverrideUpdatedEventDetail {
  override?: UserGameOverride;
  oldGame?: CanonicalGame;
  gameId?: string;
  platformId?: StorefrontId;
  platformGameId?: string;
  isHidden?: boolean;
  hiddenGameId?: string;
  unhiddenKey?: string;
  restoredKey?: string;
  type?: 'override' | 'hidden' | 'unhidden' | 'restored-non-game' | 'confirmed-non-game' | 'batch-confirmed-non-game';
}

export interface UserOverrideRemovedEventDetail {
  gameId?: string;
  oldOverride?: UserGameOverride;
}

export interface SuppressedEntriesUpdatedEventDetail {
  count?: number;
}

export interface LauncherStateChangedEventDetail {
  reason?: string;
  gameId?: string;
  runningGames?: ActiveGameSession[];
  downloadQueue?: DownloadTaskState[];
  installedRecords?: InstalledGameRecord[];
  inGameHibernating?: boolean;
  performanceSettings?: LauncherPerformanceSettings;
}

export interface GameSessionEndedEventDetail {
  gameId: string;
  platformId?: StorefrontId;
  platformGameId?: string;
  sessionMinutesPlayed?: number;
  durationSeconds?: number;
  lastPlayed?: string;
  storefrontTotalPlaytimeMinutes?: number | null;
}

export interface GameInstalledEventDetail {
  gameId?: string;
  platformId?: StorefrontId;
  platformGameId?: string;
  installed: boolean;
  installPath?: string;
  executablePath?: string;
  isWindowsBinaryOnMac?: boolean;
}

export interface OpenDownloadDrawerEventDetail {
  taskId?: string;
  gameId?: string;
}

export interface IgdbCoverUpdatedEventDetail {
  title: string;
  coverUrl: string;
}

export interface SteamMatchUpdatedEventDetail {
  title: string;
  steamAppId: number;
}

export interface GogCoverUpdatedEventDetail {
  gogId: string;
  coverUrl: string;
}

export interface GameLaunchErrorEventDetail {
  gameId?: string;
  title?: string;
  platformId?: StorefrontId;
  error: string;
}

export type CloudSyncTelemetryEventDetail =
  | CloudSaveSyncTelemetry
  | (Partial<CloudSaveSyncTelemetry> & Record<string, unknown>);

export type HibernateStateChangedEventDetail = HibernateStatePayload;

export interface SteamAssetsResolvedEventDetail {
  appId: number;
  capsuleImage?: string;
  headerImage?: string;
  iconUrl?: string;
  ts?: number;
}

export interface OneLauncherEventMap {
  antigravity_critic_updated: CriticUpdatedEventDetail | undefined;
  'antigravity:user-override-updated': UserOverrideUpdatedEventDetail;
  'antigravity:user-override-removed': UserOverrideRemovedEventDetail;
  'antigravity:suppressed-entries-updated': SuppressedEntriesUpdatedEventDetail | undefined;
  'antigravity:launcher-state-changed': LauncherStateChangedEventDetail | undefined;
  'antigravity:hibernate-state-changed': HibernateStateChangedEventDetail;
  'antigravity:cloud-sync-telemetry': CloudSyncTelemetryEventDetail;
  'antigravity:game-session-ended': GameSessionEndedEventDetail;
  'antigravity:game-installed': GameInstalledEventDetail;
  'antigravity:open-download-drawer': OpenDownloadDrawerEventDetail | undefined;
  'antigravity:igdb-cover-updated': IgdbCoverUpdatedEventDetail;
  'antigravity:steam-match-updated': SteamMatchUpdatedEventDetail;
  'antigravity:steam-assets-resolved': SteamAssetsResolvedEventDetail;
  'antigravity:gog-cover-updated': GogCoverUpdatedEventDetail;
  'antigravity:game-launch-error': GameLaunchErrorEventDetail;
}

/**
 * Dispatches a strongly-typed custom application event on `window`.
 */
export function dispatchAppEvent<K extends keyof OneLauncherEventMap>(
  type: K,
  detail?: OneLauncherEventMap[K]
): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  } catch {
    // Ignore dispatch errors in headless test environments
  }
}

/**
 * Subscribes to a strongly-typed custom application event on `window` and returns an unsubscribe cleanup function.
 */
export function subscribeAppEvent<K extends keyof OneLauncherEventMap>(
  type: K,
  handler: (detail: OneLauncherEventMap[K], event: CustomEvent<OneLauncherEventMap[K]>) => void
): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  const listener = ((event: Event) => {
    const customEvent = event as CustomEvent<OneLauncherEventMap[K]>;
    handler(customEvent.detail, customEvent);
  }) as EventListener;
  window.addEventListener(type, listener);
  return () => {
    window.removeEventListener(type, listener);
  };
}
