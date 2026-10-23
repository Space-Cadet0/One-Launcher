import React, { useState, useEffect } from 'react';
import { DownloadTaskState, DownloadTaskStatus } from '../../contracts/launcher';
import { launcherService } from '../../services/launcher/launcherService';
import { StorefrontIcon, getStorefrontDisplayName } from '../Common/StorefrontIcon';
import {
  Download,
  Pause,
  Play,
  X,
  Trash2,
  CheckCircle2,
  AlertCircle,
  FolderOpen,
  Clock,
  Activity,
} from 'lucide-react';

export interface DownloadManagerDrawerProps {
  isOpen?: boolean;
  onClose?: () => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) {
    return `${gb.toFixed(2)} GB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return '0.0 MB/s';
  const mbPerSec = bytesPerSec / (1024 * 1024);
  return `${mbPerSec.toFixed(1)} MB/s`;
}

function formatEta(etaSeconds?: number): string {
  if (etaSeconds === undefined || etaSeconds === null || etaSeconds <= 0 || !isFinite(etaSeconds)) {
    return '--:--';
  }
  const hrs = Math.floor(etaSeconds / 3600);
  const mins = Math.floor((etaSeconds % 3600) / 60);
  const secs = Math.floor(etaSeconds % 60);
  if (hrs > 0) {
    return `${hrs}h ${String(mins).padStart(2, '0')}m`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function getStatusBadge(status: DownloadTaskStatus): {
  label: string;
  classes: string;
} {
  switch (status) {
    case 'downloading':
      return {
        label: 'Downloading',
        classes: 'bg-sky-500/20 text-sky-300 border-sky-400/50',
      };
    case 'extracting':
      return {
        label: 'Extracting',
        classes: 'bg-purple-500/20 text-purple-300 border-purple-400/50',
      };
    case 'verifying':
      return {
        label: 'Verifying',
        classes: 'bg-indigo-500/20 text-indigo-300 border-indigo-400/50',
      };
    case 'queued':
      return {
        label: 'Queued',
        classes: 'bg-slate-500/20 text-slate-300 border-slate-400/50',
      };
    case 'paused':
      return {
        label: 'Paused',
        classes: 'bg-amber-500/20 text-amber-300 border-amber-400/50',
      };
    case 'completed':
      return {
        label: 'Completed',
        classes: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/50',
      };
    case 'failed':
      return {
        label: 'Failed',
        classes: 'bg-red-500/20 text-red-300 border-red-400/50',
      };
    case 'cancelled':
      return {
        label: 'Cancelled',
        classes: 'bg-zinc-600/20 text-zinc-400 border-zinc-500/40',
      };
  }
}

export const DownloadManagerDrawer: React.FC<DownloadManagerDrawerProps> = ({
  isOpen,
  onClose,
}) => {
  const [internalOpen, setInternalOpen] = useState<boolean>(false);
  const [queue, setQueue] = useState<DownloadTaskState[]>(() =>
    launcherService.getDownloadQueue()
  );
  const [dismissedTaskIds, setDismissedTaskIds] = useState<Set<string>>(() => new Set());
  const [pendingActionIds, setPendingActionIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (isOpen !== undefined) {
      setInternalOpen(isOpen);
    }
  }, [isOpen]);

  useEffect(() => {
    const unsub = launcherService.subscribe(() => {
      setQueue([...launcherService.getDownloadQueue()]);
    });

    const handleOpenEvent = () => {
      setInternalOpen(true);
    };

    window.addEventListener('antigravity:open-download-drawer', handleOpenEvent);
    return () => {
      unsub();
      window.removeEventListener('antigravity:open-download-drawer', handleOpenEvent);
    };
  }, []);

  const effectiveOpen = isOpen !== undefined ? isOpen || internalOpen : internalOpen;

  const handleClose = () => {
    setInternalOpen(false);
    onClose?.();
  };

  useEffect(() => {
    if (!effectiveOpen || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return;
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setInternalOpen(false);
        onClose?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [effectiveOpen, onClose]);

  const runTaskAction = async (taskId: string, action: () => Promise<unknown> | unknown) => {
    if (pendingActionIds.has(taskId)) return;
    setPendingActionIds((prev) => {
      const next = new Set(prev);
      next.add(taskId);
      return next;
    });
    try {
      await action();
    } finally {
      setPendingActionIds((prev) => {
        if (!prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  };

  if (!effectiveOpen) return null;

  const visibleQueue = queue.filter(
    (t) =>
      !dismissedTaskIds.has(t.taskId) ||
      (t.status !== 'completed' && t.status !== 'failed' && t.status !== 'cancelled')
  );

  const activeTasks = visibleQueue.filter(
    (t) =>
      t.status === 'downloading' ||
      t.status === 'extracting' ||
      t.status === 'verifying' ||
      t.status === 'queued' ||
      t.status === 'paused'
  );
  const finishedTasks = visibleQueue.filter(
    (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled'
  );

  const handleClearCompleted = () => {
    const finishedIds = finishedTasks.map((t) => t.taskId);
    setDismissedTaskIds((prev) => {
      const next = new Set(prev);
      for (const id of finishedIds) {
        next.add(id);
      }
      return next;
    });
    launcherService.clearCompletedDownloads();
    setQueue((prev) =>
      prev.filter(
        (t) => t.status !== 'completed' && t.status !== 'failed' && t.status !== 'cancelled'
      )
    );
  };

  const totalSpeed = activeTasks.reduce((sum, t) => sum + (t.speedBytesPerSec || 0), 0);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/75 animate-in fade-in duration-150 select-none"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-md h-full bg-[#111822]/98 border-l border-[#2a475e] shadow-[-16px_0_50px_rgba(0,0,0,0.85)] flex flex-col text-steam-text"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drawer Header */}
        <div className="px-4 py-3.5 bg-[#0d131b] border-b border-[#223447] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0">
              <Download className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="text-xs sm:text-sm font-bold text-white tracking-wider uppercase whitespace-nowrap">
                  Downloads
                </h2>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-400/40 whitespace-nowrap shrink-0">
                  {activeTasks.length} Active
                </span>
              </div>
              {totalSpeed > 0 && (
                <div className="flex items-center gap-1.5 text-[11px] text-emerald-400 font-mono mt-0.5">
                  <Activity className="w-3 h-3 animate-pulse" />
                  <span>{formatSpeed(totalSpeed)}</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {finishedTasks.length > 0 && (
              <button
                type="button"
                onClick={handleClearCompleted}
                className="px-2 py-1 rounded text-[11px] font-medium text-gray-400 hover:text-white hover:bg-white/5 border border-transparent hover:border-white/10 transition-colors flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                title="Clear completed, cancelled, and failed tasks"
              >
                <Trash2 className="w-3 h-3" />
                <span>Clear Completed</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleClose}
              className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-steam-subtext hover:text-white transition-colors shrink-0 cursor-pointer"
              aria-label="Close downloads drawer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {visibleQueue.length === 0 ? (
            <div className="h-64 flex flex-col items-center justify-center text-center p-6 rounded-xl bg-[#151f2c]/60 border border-[#223447]">
              <Download className="w-10 h-10 text-steam-subtext/40 mb-2.5" />
              <h3 className="text-sm font-bold text-white">No Active Downloads</h3>
              <p className="text-xs text-steam-subtext mt-1 max-w-xs leading-relaxed">
                Install games from Steam, GOG.com, or Epic Games Store to monitor download progress, extraction, and disk speeds here.
              </p>
            </div>
          ) : (
            visibleQueue.map((task) => {
              const badge = getStatusBadge(task.status);
              const isActive =
                task.status === 'downloading' ||
                task.status === 'extracting' ||
                task.status === 'verifying' ||
                task.status === 'queued';
              const isPaused = task.status === 'paused';
              const isDone = task.status === 'completed';
              const isFailed = task.status === 'failed';
              const pct = Math.min(100, Math.max(0, task.progressPercent || 0));

              return (
                <div
                  key={task.taskId}
                  className="rounded-xl bg-[#16202d] border border-[#2a475e]/80 p-3.5 shadow-md space-y-2.5 transition-all"
                >
                  {/* Top row: Header thumbnail + Title + Status badge */}
                  <div className="flex items-start justify-between gap-2.5">
                    <div className="flex items-center gap-2.5 min-w-0">
                      {task.headerImage && (
                        <img
                          src={task.headerImage}
                          alt={task.title}
                          className="w-14 h-8 rounded object-cover border border-white/10 shrink-0"
                        />
                      )}
                      <div className="min-w-0">
                        <h4 className="text-xs font-bold text-white truncate" title={task.title}>
                          {task.title}
                        </h4>
                        <div className="flex items-center gap-1.5 text-[10px] text-steam-subtext mt-0.5">
                          <StorefrontIcon
                            storefrontId={task.platformId}
                            className="w-3 h-3 text-sky-400"
                          />
                          <span>{getStorefrontDisplayName(task.platformId)}</span>
                        </div>
                      </div>
                    </div>

                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded border shrink-0 ${badge.classes}`}
                    >
                      {badge.label}
                    </span>
                  </div>

                  {/* Progress bar */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-steam-subtext truncate max-w-[75%]">
                        {task.statusMessage || badge.label}
                      </span>
                      <span className="font-mono font-bold text-white">{pct.toFixed(0)}%</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-[#0d131b] overflow-hidden border border-white/5">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          isDone
                            ? 'bg-emerald-400'
                            : isFailed
                              ? 'bg-red-500'
                              : isPaused
                                ? 'bg-amber-400'
                                : 'bg-gradient-to-r from-sky-400 to-blue-500'
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>

                  {/* Speed, Downloaded / Total, ETA & Controls */}
                  <div className="flex items-center justify-between gap-2 pt-0.5 text-[10px] text-steam-subtext">
                    <div className="flex flex-wrap items-center gap-2.5 font-mono">
                      {task.totalBytes > 0 ? (
                        <span>
                          {formatBytes(task.bytesDownloaded)} / {formatBytes(task.totalBytes)}
                        </span>
                      ) : isActive ? (
                        <span>
                          {task.bytesDownloaded > 0
                            ? formatBytes(task.bytesDownloaded)
                            : 'Calculating size...'}
                        </span>
                      ) : (
                        <span>{formatBytes(task.bytesDownloaded)}</span>
                      )}
                      {task.status === 'downloading' && task.speedBytesPerSec > 0 && (
                        <span className="text-sky-400">
                          {formatSpeed(task.speedBytesPerSec)}
                        </span>
                      )}
                      {task.status === 'downloading' &&
                        task.speedBytesPerSec > 0 &&
                        task.etaSeconds !== undefined &&
                        task.etaSeconds > 0 && (
                          <span className="flex items-center gap-1 text-steam-subtext">
                            <Clock className="w-2.5 h-2.5" />
                            <span>ETA {formatEta(task.etaSeconds)}</span>
                          </span>
                        )}
                    </div>

                    {/* Task Action Buttons */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {task.status === 'downloading' && (
                        <button
                          type="button"
                          disabled={pendingActionIds.has(task.taskId)}
                          onClick={() =>
                            runTaskAction(task.taskId, () =>
                              launcherService.pauseDownload(task.taskId)
                            )
                          }
                          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#1b2838] hover:bg-[#26384f] border border-[#2a475e] text-[10px] font-semibold text-amber-300 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Pause download"
                        >
                          <Pause className="w-3 h-3" />
                          <span>Pause</span>
                        </button>
                      )}

                      {isPaused && (
                        <button
                          type="button"
                          disabled={pendingActionIds.has(task.taskId)}
                          onClick={() =>
                            runTaskAction(task.taskId, () =>
                              launcherService.resumeDownload(task.taskId)
                            )
                          }
                          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/50 text-[10px] font-semibold text-sky-300 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Resume download"
                        >
                          <Play className="w-3 h-3" />
                          <span>Resume</span>
                        </button>
                      )}

                      {(isActive || isPaused) && (
                        <button
                          type="button"
                          disabled={pendingActionIds.has(task.taskId)}
                          onClick={() =>
                            runTaskAction(task.taskId, () =>
                              launcherService.cancelDownload(task.taskId)
                            )
                          }
                          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-950/60 hover:bg-red-900/70 border border-red-500/40 text-[10px] font-semibold text-red-300 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Cancel installation"
                        >
                          <X className="w-3 h-3" />
                          <span>Cancel</span>
                        </button>
                      )}

                      {isDone && (task.finalInstallPath || task.installDir) && (
                        <button
                          type="button"
                          onClick={() => {
                            const target = task.finalInstallPath || task.installDir;
                            if (window.electronAPI?.browseLocalFiles) {
                              window.electronAPI.browseLocalFiles(target);
                            }
                          }}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-[10px] font-semibold text-emerald-300 transition-colors cursor-pointer"
                          title="Browse installed files"
                        >
                          <FolderOpen className="w-3 h-3" />
                          <span>Browse</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Error details if failed */}
                  {task.error && (
                    <div className="rounded bg-red-950/60 border border-red-500/40 px-2.5 py-1.5 text-[10px] text-red-300 flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                      <span className="truncate">{task.error}</span>
                    </div>
                  )}

                  {isDone && (
                    <div className="flex items-center gap-1.5 text-[10px] text-emerald-400 font-medium">
                      <CheckCircle2 className="w-3 h-3 shrink-0" />
                      <span className="truncate">
                        Installed to {task.finalInstallPath || task.installDir}
                      </span>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
