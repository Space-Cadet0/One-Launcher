import { AlertTriangle } from 'lucide-react';
import { ActiveGameSession } from '../../contracts/launcher';

export interface InGameHibernationViewProps {
  runningGames: ActiveGameSession[];
  onResumeFullUi: () => void;
}

export const InGameHibernationView = ({
  runningGames,
  onResumeFullUi,
}: InGameHibernationViewProps) => {
  const activeSession = runningGames[0];
  const activeTitle = activeSession?.title || 'Active Game Session';
  const hasCloudSyncWarning =
    activeSession?.status === 'cloud_sync_warning' ||
    activeSession?.cloudSync?.status === 'cloud_sync_warning' ||
    activeSession?.cloudSync?.synced === false;

  const statusText =
    activeSession?.status === 'starting'
      ? 'Starting Game Process'
      : activeSession?.status === 'stopping'
        ? 'Closing Session & Syncing Playtime'
        : activeSession?.status === 'cloud_sync_warning'
          ? 'Cloud Save Sync Warning • Local Backup Preserved'
          : activeSession?.status === 'cloud_sync_complete'
            ? 'Cloud Save Sync Complete'
            : 'Running • In-Game Hibernation Active';

  return (
    <div
      data-testid="in-game-hibernation-view"
      className="h-screen w-screen bg-[#0b0f14] text-steam-text flex flex-col items-center justify-center p-6 font-steam select-none"
    >
      <div className="w-full max-w-md rounded-xl bg-[#131b26] border border-[#26384d] p-6 space-y-4 text-center">
        <div
          className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-bold uppercase tracking-wider ${
            hasCloudSyncWarning
              ? 'bg-amber-500/15 border-amber-500/35 text-amber-300'
              : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              hasCloudSyncWarning ? 'bg-amber-400' : 'bg-emerald-400'
            }`}
          />
          <span>{statusText}</span>
        </div>

        <div className="space-y-1">
          <h1 className="text-lg font-bold text-white truncate">{activeTitle}</h1>
          <p className="text-xs text-steam-subtext leading-relaxed">
            One Launcher UI is hibernated to release GPU textures, video decoders, and DOM memory
            while you play.
          </p>
        </div>

        {hasCloudSyncWarning && (
          <div
            data-testid="hibernation-cloud-sync-warning"
            className="text-left text-[11px] text-amber-200 bg-amber-950/35 border border-amber-500/35 rounded-lg px-3 py-2 flex items-start gap-2"
          >
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
            <span>
              {activeSession?.cloudSync?.reason ||
                activeSession?.statusMessage ||
                'Cloud save sync could not be verified — local rolling save backups remain preserved.'}
            </span>
          </div>
        )}

        {activeSession?.pid ? (
          <div className="text-[11px] font-mono text-sky-300 bg-[#0e151f] border border-[#223447] rounded px-3 py-1.5">
            Process PID: {activeSession.pid} • Platform: {activeSession.platformId.toUpperCase()}
          </div>
        ) : null}

        <div className="pt-2">
          <button
            type="button"
            data-testid="resume-full-ui-btn"
            onClick={onResumeFullUi}
            className="w-full px-4 py-2.5 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/50 text-xs font-bold text-sky-200 hover:text-white uppercase tracking-wider transition-colors cursor-pointer"
          >
            Resume Full UI
          </button>
        </div>
      </div>
    </div>
  );
};
