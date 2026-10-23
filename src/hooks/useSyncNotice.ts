import { useState, useRef, useCallback, useEffect } from 'react';
import { CloudSyncTelemetryEventDetail } from '../contracts/events';

export type SyncNoticeTone = 'default' | 'warning';

export interface UseSyncNoticeResult {
  syncNotice: string | null;
  syncNoticeTone: SyncNoticeTone;
  showSyncNotice: (
    message: string | null,
    durationMs?: number | null,
    tone?: SyncNoticeTone
  ) => void;
  clearSyncNotice: () => void;
}

/**
 * Manages the top sync/telemetry banner notice with a single tracked timer ref
 * (preventing overlapping setTimeout races or unmount timer leaks) and listens
 * for `antigravity:cloud-sync-telemetry` warnings.
 */
export function useSyncNotice(): UseSyncNoticeResult {
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [syncNoticeTone, setSyncNoticeTone] = useState<SyncNoticeTone>('default');
  const syncNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSyncNotice = useCallback(() => {
    if (syncNoticeTimerRef.current) {
      clearTimeout(syncNoticeTimerRef.current);
      syncNoticeTimerRef.current = null;
    }
    setSyncNotice(null);
    setSyncNoticeTone('default');
  }, []);

  const showSyncNotice = useCallback(
    (
      message: string | null,
      durationMs: number | null = null,
      tone: SyncNoticeTone = 'default'
    ) => {
      if (syncNoticeTimerRef.current) {
        clearTimeout(syncNoticeTimerRef.current);
        syncNoticeTimerRef.current = null;
      }

      if (!message) {
        setSyncNotice(null);
        setSyncNoticeTone('default');
        return;
      }

      setSyncNotice(message);
      setSyncNoticeTone(tone);

      if (typeof durationMs === 'number' && durationMs > 0) {
        syncNoticeTimerRef.current = setTimeout(() => {
          syncNoticeTimerRef.current = null;
          setSyncNotice(null);
          setSyncNoticeTone('default');
        }, durationMs);
      }
    },
    []
  );

  // Clean up any pending notice timeout on unmount
  useEffect(() => {
    return () => {
      if (syncNoticeTimerRef.current) {
        clearTimeout(syncNoticeTimerRef.current);
        syncNoticeTimerRef.current = null;
      }
    };
  }, []);

  // Subscribe to cloud save sync telemetry warnings emitted by launcherService
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

    const handleCloudSyncTelemetry = (event: Event) => {
      const detail = (event as CustomEvent<CloudSyncTelemetryEventDetail>).detail;
      if (!detail) return;

      const isWarning =
        detail.status === 'cloud_sync_warning' || detail.synced === false;
      if (!isWarning) return;

      const directionLabel =
        detail.direction === 'pre_launch'
          ? 'Pre-launch'
          : detail.direction === 'post_exit'
            ? 'Post-session'
            : 'Session';
      const storeLabel = detail.platformId
        ? String(detail.platformId).toUpperCase()
        : 'Storefront';
      const reasonText =
        detail.reason ||
        (detail as Record<string, any>).statusMessage ||
        'Cloud save sync could not be verified';
      const backupNote = detail.backupPath
        ? 'Local rolling save backup preserved on disk.'
        : 'Local rolling save backups remain preserved.';

      showSyncNotice(
        `${directionLabel} ${storeLabel} cloud save warning: ${reasonText}. ${backupNote}`,
        8000,
        'warning'
      );
    };

    window.addEventListener('antigravity:cloud-sync-telemetry', handleCloudSyncTelemetry);
    return () => {
      window.removeEventListener('antigravity:cloud-sync-telemetry', handleCloudSyncTelemetry);
    };
  }, [showSyncNotice]);

  return {
    syncNotice,
    syncNoticeTone,
    showSyncNotice,
    clearSyncNotice,
  };
}
