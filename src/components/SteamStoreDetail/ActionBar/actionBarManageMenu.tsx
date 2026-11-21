import React from 'react';
import { CanonicalGame } from '../../../contracts/game';
import { StorefrontId } from '../../../contracts/platform';
import { DownloadTaskState } from '../../../contracts/launcher';
import { getStorefrontDisplayName } from '../../Common/StorefrontIcon';
import { launcherService } from '../../../services/launcher/launcherService';
import {
  Download,
  HardDrive,
  X,
  Wand,
  FolderOpen,
  ShieldCheck,
  Trash2,
  Cpu,
  FileSearch,
  EyeOff,
} from 'lucide-react';

export interface RenderManageGameDropdownArgs {
  game: CanonicalGame;
  selectedPlatformId: StorefrontId;
  isInstalled: boolean;
  isWindowsHost: boolean;
  hasLocalFilesPath: boolean;
  activeDownload: DownloadTaskState | undefined;
  onCloseMenu: () => void;
  onOpenInstallModal: () => void;
  onPrefetchInstallModal: () => void;
  onOpenLaunchConfigModal: () => void;
  onPrefetchLaunchConfigModal: () => void;
  onToggleInstallStatus?: (platformId?: StorefrontId) => void;
  onFixMatch?: () => void;
  onHideGame?: (game: CanonicalGame, targetPlatformId?: StorefrontId) => void;
  showTempFeedback: (msg: string, durationMs?: number) => void;
}

export function renderManageGameDropdown({
  game,
  selectedPlatformId,
  isInstalled,
  isWindowsHost,
  hasLocalFilesPath,
  activeDownload,
  onCloseMenu,
  onOpenInstallModal,
  onPrefetchInstallModal,
  onOpenLaunchConfigModal,
  onPrefetchLaunchConfigModal,
  onToggleInstallStatus,
  onFixMatch,
  onHideGame,
  showTempFeedback,
}: RenderManageGameDropdownArgs): React.ReactElement {
  return (
    <div
      id="manage-game-dropdown"
      className="absolute left-0 top-full mt-2 w-64 rounded-lg bg-[#151f2d] border border-[#2a475e] shadow-2xl z-50 py-1.5"
    >
      <div className="px-3.5 py-1.5 border-b border-[#2a475e]/60 mb-1 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-sky-400">
          Manage Game
        </span>
        <span className="text-[10px] text-steam-subtext">
          {getStorefrontDisplayName(selectedPlatformId)}
        </span>
      </div>

      {/* Group 1: Local Files & Installation */}
      <div className="px-3.5 pt-1 pb-0.5 text-[9px] font-bold uppercase tracking-wider text-steam-subtext/75">
        Local Files &amp; Installation
      </div>

      {isInstalled ? (
        <>
          <button
            type="button"
            disabled={!hasLocalFilesPath}
            onClick={async () => {
              onCloseMenu();
              const ok = await launcherService.browseLocalFiles(game, selectedPlatformId);
              if (!ok) {
                showTempFeedback('Could not open local game folder.');
              }
            }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2d40] disabled:opacity-40 disabled:pointer-events-none transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-steam-accent"
          >
            <FolderOpen className="w-4 h-4 text-sky-400 shrink-0" aria-hidden="true" />
            <span>Browse Local Files</span>
          </button>

          <button
            type="button"
            onClick={async () => {
              onCloseMenu();
              const res = await launcherService.verifyGameFiles(game, selectedPlatformId);
              showTempFeedback(res.message || res.error || 'Verification triggered.');
            }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2d40] transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-steam-accent"
          >
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
            <span>Verify / Repair Game Files</span>
          </button>
        </>
      ) : (
        <button
          type="button"
          onPointerEnter={onPrefetchInstallModal}
          onFocus={onPrefetchInstallModal}
          onClick={() => {
            onCloseMenu();
            onOpenInstallModal();
          }}
          className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2d40] transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-steam-accent"
        >
          <Download className="w-4 h-4 text-sky-400 shrink-0" aria-hidden="true" />
          <span>Install Game...</span>
        </button>
      )}

      <button
        type="button"
        onClick={async () => {
          onCloseMenu();
          const exe = await launcherService.locateInstalledGame(game, selectedPlatformId);
          if (exe) {
            showTempFeedback(`Linked local executable: ${exe}`);
          }
        }}
        className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2d40] transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-steam-accent"
      >
        <FileSearch className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
        <span>Locate Installed Game...</span>
      </button>

      <button
        type="button"
        onClick={async () => {
          onCloseMenu();
          const nextState = !isInstalled;
          await launcherService.setManualInstallStatus(game, nextState, selectedPlatformId);
          onToggleInstallStatus?.(selectedPlatformId);
          showTempFeedback(
            nextState ? 'Marked as manually installed.' : 'Marked as uninstalled (cloud only).'
          );
        }}
        className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2d40] transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-steam-accent"
      >
        <HardDrive
          className={`w-4 h-4 shrink-0 ${isInstalled ? 'text-emerald-400' : 'text-sky-400'}`}
          aria-hidden="true"
        />
        <span>
          {isInstalled ? 'Mark as Uninstalled (Cloud Only)' : 'Mark as Manually Installed'}
        </span>
      </button>

      {/* Group 2: Metadata & Launch Configuration */}
      <div className="mt-1 pt-1.5 border-t border-[#2a475e]/50">
        <div className="px-3.5 pb-0.5 text-[9px] font-bold uppercase tracking-wider text-steam-subtext/75">
          Metadata &amp; Settings
        </div>

        {onFixMatch && (
          <button
            type="button"
            onClick={() => {
              onCloseMenu();
              onFixMatch();
            }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2d40] transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-steam-accent"
          >
            <Wand className="w-4 h-4 text-sky-400 shrink-0" aria-hidden="true" />
            <span>Match &amp; Metadata Wizard...</span>
          </button>
        )}

        <button
          type="button"
          onPointerEnter={onPrefetchLaunchConfigModal}
          onFocus={onPrefetchLaunchConfigModal}
          onClick={() => {
            onCloseMenu();
            onOpenLaunchConfigModal();
          }}
          className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2d40] transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-steam-accent"
        >
          <Cpu className="w-4 h-4 text-purple-400 shrink-0" aria-hidden="true" />
          <span>
            {isWindowsHost ? 'Launch Settings...' : 'Launch & Compatibility Settings...'}
          </span>
        </button>
      </div>

      {/* Group 3: Visibility & Removal */}
      {(onHideGame || activeDownload || isInstalled) && (
        <div className="mt-1 pt-1 border-t border-[#2a475e]/50">
          {onHideGame &&
            (game.platforms.length > 1 ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    onCloseMenu();
                    onHideGame(game, selectedPlatformId);
                  }}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-rose-300 hover:text-white hover:bg-rose-950/50 transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-steam-accent"
                >
                  <EyeOff className="w-4 h-4 text-rose-400 shrink-0" aria-hidden="true" />
                  <span>Hide {getStorefrontDisplayName(selectedPlatformId)} Entry</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onCloseMenu();
                    onHideGame(game);
                  }}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-rose-300 hover:text-white hover:bg-rose-950/50 transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-steam-accent"
                >
                  <EyeOff className="w-4 h-4 text-rose-400 shrink-0" aria-hidden="true" />
                  <span>Hide Entire Game from Library</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  onCloseMenu();
                  onHideGame(game);
                }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-rose-300 hover:text-white hover:bg-rose-950/50 transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-steam-accent"
              >
                <EyeOff className="w-4 h-4 text-rose-400 shrink-0" aria-hidden="true" />
                <span>Hide / Suppress Game from Library</span>
              </button>
            ))}

          {activeDownload && (
            <button
              type="button"
              onClick={async () => {
                onCloseMenu();
                await launcherService.cancelDownload(activeDownload.taskId);
                showTempFeedback('Installation cancelled.');
              }}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-red-300 hover:text-red-200 hover:bg-red-950/50 transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-steam-accent"
            >
              <X className="w-4 h-4 text-red-400 shrink-0" aria-hidden="true" />
              <span>Cancel Install</span>
            </button>
          )}

          {isInstalled && (
            <button
              type="button"
              onClick={async () => {
                onCloseMenu();
                const res = await launcherService.uninstallGame(game, selectedPlatformId);
                showTempFeedback(res.message || res.error || 'Game uninstalled.');
              }}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-red-300 hover:text-red-200 hover:bg-red-950/50 transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-steam-accent"
            >
              <Trash2 className="w-4 h-4 text-red-400 shrink-0" aria-hidden="true" />
              <span>Uninstall Game...</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
