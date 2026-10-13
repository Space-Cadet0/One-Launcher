import { useState, useEffect } from 'react';
import { syncJobManager, SyncJobState } from '../../services/network/syncJobManager';
import {
  RefreshCw,
  Pause,
  Play,
  X,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';

export function GlobalSyncProgressBar() {
  const [job, setJob] = useState<SyncJobState | null>(() => syncJobManager.getState());
  const [visible, setVisible] = useState(() => {
    const s = syncJobManager.getState();
    return Boolean(s && s.status !== 'idle');
  });

  useEffect(() => {
    const unsubscribe = syncJobManager.subscribe((state) => {
      setJob(state);
      if (state && state.status !== 'idle') {
        setVisible(true);
      }
    });
    return unsubscribe;
  }, []);

  // Auto-dismiss handling
  useEffect(() => {
    if (!job) return;

    if (job.status === 'completed') {
      const timer = setTimeout(() => {
        setVisible(false);
      }, 4000);
      return () => clearTimeout(timer);
    }

    if (job.status === 'cancelled') {
      const timer = setTimeout(() => {
        setVisible(false);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [job?.status]);

  if (!visible || !job || job.status === 'idle') {
    return null;
  }

  const percent = job.total > 0 ? Math.min(100, Math.round((job.current / job.total) * 100)) : 0;

  const handlePause = () => {
    if (job) syncJobManager.pauseJob(job.id);
  };

  const handleResume = () => {
    if (job) syncJobManager.resumeJob(job.id);
  };

  const handleCancel = () => {
    if (job) syncJobManager.cancelJob(job.id);
  };

  const handleDismiss = () => {
    setVisible(false);
  };

  const formatCooldown = (seconds?: number): string => {
    if (!seconds || seconds <= 0) return '0s';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  return (
    <div
      role="region"
      aria-label="Global synchronization progress"
      className="fixed bottom-6 right-6 z-50 w-96 max-w-[calc(100vw-3rem)] rounded-xl border border-zinc-700/80 bg-zinc-900/95 p-4 shadow-2xl backdrop-blur-md transition-all duration-300 animate-in fade-in slide-in-from-bottom-5"
    >
      {/* Top Header Row */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          {job.status === 'running' && (
            <RefreshCw className="w-4 h-4 text-cyan-400 shrink-0 animate-spin" />
          )}
          {job.status === 'paused' && (
            <Pause className="w-4 h-4 text-amber-400 shrink-0" />
          )}
          {job.status === 'rate_limited' && (
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 animate-pulse" />
          )}
          {job.status === 'completed' && (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          )}
          {job.status === 'cancelled' && (
            <X className="w-4 h-4 text-zinc-400 shrink-0" />
          )}

          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-200 truncate">
            {job.title}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs font-mono font-bold text-cyan-400">
            {percent}%
          </span>

          {job.status === 'running' && (
            <button
              onClick={handlePause}
              title="Pause sync"
              className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            >
              <Pause className="w-3.5 h-3.5" />
            </button>
          )}

          {job.status === 'paused' && (
            <button
              onClick={handleResume}
              title="Resume sync"
              className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            >
              <Play className="w-3.5 h-3.5" />
            </button>
          )}

          {(job.status === 'running' || job.status === 'paused' || job.status === 'rate_limited') && (
            <button
              onClick={handleCancel}
              title="Cancel sync"
              className="p-1 rounded text-zinc-400 hover:text-rose-400 hover:bg-zinc-800 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}

          {(job.status === 'completed' || job.status === 'cancelled') && (
            <button
              onClick={handleDismiss}
              title="Dismiss"
              className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Progress Track */}
      <div className="w-full bg-zinc-800/80 rounded-full h-1.5 overflow-hidden mb-2">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            job.status === 'completed'
              ? 'bg-emerald-500'
              : job.status === 'rate_limited'
              ? 'bg-amber-500'
              : job.status === 'paused'
              ? 'bg-zinc-500'
              : job.status === 'cancelled'
              ? 'bg-zinc-600'
              : 'bg-gradient-to-r from-cyan-500 to-blue-500'
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* Detail / Status Description Row */}
      <div className="flex items-center justify-between text-[11px] text-zinc-400">
        <div className="truncate pr-2">
          {job.status === 'running' && job.currentItemName && (
            <span className="truncate">
              Processing: <span className="text-zinc-200">{job.currentItemName}</span>
            </span>
          )}
          {job.status === 'paused' && (
            <span className="text-amber-400/90 font-medium">Sync paused</span>
          )}
          {job.status === 'rate_limited' && (
            <span className="text-amber-400 font-medium">
              Rate limited: Cooldown {formatCooldown(job.cooldownSecondsRemaining)}
            </span>
          )}
          {job.status === 'completed' && (
            <span className="text-emerald-400 font-medium">Sync complete!</span>
          )}
          {job.status === 'cancelled' && (
            <span className="text-zinc-400 font-medium">Sync cancelled</span>
          )}
        </div>

        <span className="font-mono text-zinc-400 shrink-0">
          {job.current} / {job.total}
        </span>
      </div>
    </div>
  );
}
