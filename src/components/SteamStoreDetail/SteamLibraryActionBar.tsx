import React, { Suspense, useState, useEffect, useRef, useCallback } from 'react';
import { StorefrontId } from '../../contracts/platform';
import { StorefrontIcon, getStorefrontDisplayName } from '../Common/StorefrontIcon';
import {
  Play,
  Pause,
  Square,
  Download,
  HardDrive,
  Clock,
  Calendar,
  Trophy,
  Bookmark,
  Award,
  ChevronDown,
  X,
  ExternalLink,
  Sparkles,
  Settings,
  Activity,
  Loader2,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { formatPlaytime } from '../../utils/dateUtils';
import { launcherService } from '../../services/launcher/launcherService';
import { ModalErrorBoundary } from '../Common/ModalErrorBoundary';
import { lazyWithRetry } from '../../utils/lazyWithRetry';
import type { SteamLibraryActionBarProps } from './ActionBar/actionBarTypes';
import { useActionBarPlatformAndInstall } from './ActionBar/useActionBarPlatformAndInstall';
import { useActionBarAchievementsAndCritic } from './ActionBar/useActionBarAchievementsAndCritic';
import { renderManageGameDropdown } from './ActionBar/actionBarManageMenu';
import {
  renderPlaytimeBreakdownDrawer,
  renderAchievementsBreakdownDrawer,
  renderMacCompatHandoffBanner,
} from './ActionBar/actionBarDrawers';

const loadGameInstallModalModule = () => import('../Launcher/GameInstallModal');
const loadGameLaunchConfigModalModule = () => import('../Launcher/GameLaunchConfigModal');

const GameInstallModal = lazyWithRetry(() =>
  loadGameInstallModalModule().then((m) => ({ default: m.GameInstallModal }))
);

const GameLaunchConfigModal = lazyWithRetry(() =>
  loadGameLaunchConfigModalModule().then((m) => ({ default: m.GameLaunchConfigModal }))
);

function prefetchGameInstallModal(): void {
  void loadGameInstallModalModule().catch(() => {});
}

function prefetchGameLaunchConfigModal(): void {
  void loadGameLaunchConfigModalModule().catch(() => {});
}

export const SteamLibraryActionBar: React.FC<SteamLibraryActionBarProps> = ({
  game,
  metadata,
  openCriticData,
  collections,
  onManageCollections,
  onToggleInstallStatus,
  onApplyFilter,
  onFixMatch,
  onHideGame,
  onViewAchievements,
  onSelectedPlatformChange,
}) => {
  const [showAchievementPopover, setShowAchievementPopover] = useState(false);
  const [showPlaytimePopover, setShowPlaytimePopover] = useState(false);
  const [isManageMenuOpen, setIsManageMenuOpen] = useState(false);
  const [isInstallModalOpen, setIsInstallModalOpen] = useState(false);
  const [isLaunchConfigOpen, setIsLaunchConfigOpen] = useState(false);
  const [isLaunchPending, setIsLaunchPending] = useState(false);
  const [isStopPending, setIsStopPending] = useState(false);
  const [isFullscreenTogglePending, setIsFullscreenTogglePending] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const manageMenuRef = useRef<HTMLDivElement | null>(null);
  const manageTriggerRef = useRef<HTMLButtonElement | null>(null);
  const manageDropdownRef = useRef<HTMLDivElement | null>(null);
  const pendingManageFocusRef = useRef<'first' | 'last' | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetUiStateForNewGame = useCallback(() => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    setIsManageMenuOpen(false);
    setShowPlaytimePopover(false);
    setShowAchievementPopover(false);
    setIsLaunchPending(false);
    setIsStopPending(false);
    setIsFullscreenTogglePending(false);
    setActionFeedback(null);
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
    };
  }, [game.id]);

  const {
    selectedPlatformId,
    setSelectedPlatformId,
    userManuallySelectedPlatformRef,
    activePlatform,
    activeSession,
    activeDownload,
    isRunning,
    isInstalled,
    isWindowsHost,
    isBottledRunningSession,
    hasLocalFilesPath,
    isInCollection,
    totalPlaytimeMinutes,
    formatLastPlayed,
    formatPlatformLastPlayed,
    targetSteamAppId,
    getSpaceRequired,
    isXboxSubscriptionExpired,
    xboxStoreUrl,
  } = useActionBarPlatformAndInstall({
    game,
    metadata,
    collections,
    onSelectedPlatformChange,
    onResetUiStateForNewGame: resetUiStateForNewGame,
  });

  const isStartingSession = isLaunchPending || activeSession?.status === 'starting';
  const isStoppingSession = isStopPending || activeSession?.status === 'stopping';

  const {
    platformAchievements,
    hasAchievements,
    bestAchievement,
    isAnyMastered,
    openCritic,
    ocColors,
    ocMeta,
  } = useActionBarAchievementsAndCritic(game, metadata, openCriticData, targetSteamAppId);

  const getEnabledManageMenuItems = useCallback(
    (root?: HTMLElement | null): HTMLButtonElement[] => {
      const container =
        root ||
        manageDropdownRef.current ||
        (manageMenuRef.current?.querySelector?.('#manage-game-dropdown') as HTMLElement | null) ||
        null;
      if (!container || typeof container.querySelectorAll !== 'function') return [];
      return Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])'
        )
      ).filter((item) => !item.disabled && item.getAttribute('aria-disabled') !== 'true');
    },
    []
  );

  const focusManageMenuItem = useCallback(
    (target: 'first' | 'last', root?: HTMLElement | null): boolean => {
      const items = getEnabledManageMenuItems(root);
      if (items.length === 0) return false;
      const targetEl = target === 'last' ? items[items.length - 1] : items[0];
      targetEl?.focus?.({ preventScroll: true });
      return true;
    },
    [getEnabledManageMenuItems]
  );

  const handleManageTriggerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (isManageMenuOpen) {
          focusManageMenuItem('first');
        } else {
          pendingManageFocusRef.current = 'first';
          setIsManageMenuOpen(true);
        }
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (isManageMenuOpen) {
          focusManageMenuItem('last');
        } else {
          pendingManageFocusRef.current = 'last';
          setIsManageMenuOpen(true);
        }
        return;
      }
      if (isManageMenuOpen && e.key === 'Home') {
        e.preventDefault();
        focusManageMenuItem('first');
        return;
      }
      if (isManageMenuOpen && e.key === 'End') {
        e.preventDefault();
        focusManageMenuItem('last');
        return;
      }
      if (isManageMenuOpen && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setIsManageMenuOpen(false);
        manageTriggerRef.current?.focus?.();
        return;
      }
      if (isManageMenuOpen && e.key === 'Tab') {
        setIsManageMenuOpen(false);
      }
    },
    [isManageMenuOpen, focusManageMenuItem]
  );

  const handleManageMenuKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setIsManageMenuOpen(false);
        manageTriggerRef.current?.focus?.();
        return;
      }
      if (e.key === 'Tab') {
        setIsManageMenuOpen(false);
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        return;
      }
      const items = getEnabledManageMenuItems(e.currentTarget);
      if (items.length === 0) return;
      const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
      const currentIdx = items.indexOf(activeEl as HTMLButtonElement);
      const nextIdx =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? items.length - 1
            : currentIdx < 0
              ? e.key === 'ArrowUp'
                ? items.length - 1
                : 0
              : (currentIdx + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      e.preventDefault();
      e.stopPropagation();
      items[nextIdx]?.focus?.({ preventScroll: true });
    },
    [getEnabledManageMenuItems]
  );

  useEffect(() => {
    if (!isManageMenuOpen) {
      pendingManageFocusRef.current = null;
      return undefined;
    }

    const pendingTarget = pendingManageFocusRef.current;
    if (pendingTarget) {
      pendingManageFocusRef.current = null;
      focusManageMenuItem(pendingTarget);
    }

    if (typeof document === 'undefined') return undefined;

    function handleOutsideClick(e: MouseEvent) {
      if (manageMenuRef.current && !manageMenuRef.current.contains(e.target as Node)) {
        setIsManageMenuOpen(false);
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsManageMenuOpen(false);
        manageTriggerRef.current?.focus?.();
      }
    }

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isManageMenuOpen, focusManageMenuItem]);

  const showTempFeedback = useCallback((msg: string, durationMs = 4000) => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }
    setActionFeedback(msg);
    feedbackTimerRef.current = setTimeout(() => {
      feedbackTimerRef.current = null;
      setActionFeedback((prev) => (prev === msg ? null : prev));
    }, durationMs);
  }, []);

  const showTempFeedbackRef = useRef(showTempFeedback);
  showTempFeedbackRef.current = showTempFeedback;

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return undefined;
    }
    const handleLaunchError = (e: Event) => {
      const event = e as CustomEvent<{ gameId?: string; error?: string }>;
      if (event.detail?.gameId === game.id && event.detail?.error) {
        showTempFeedbackRef.current(`Launch failed: ${event.detail.error}`, 6000);
      }
    };
    window.addEventListener('antigravity:game-launch-error', handleLaunchError);
    return () => {
      window.removeEventListener('antigravity:game-launch-error', handleLaunchError);
    };
  }, [game.id]);

  const handleInstallClick = () => {
    setIsInstallModalOpen(true);
  };

  const handlePlayClick = async () => {
    if (isLaunchPending || isRunning) return;
    setIsLaunchPending(true);
    try {
      const res = await launcherService.launchGame(game, selectedPlatformId);
      if (res && !res.success) {
        showTempFeedback(res.error || 'Failed to launch game');
      }
    } finally {
      setIsLaunchPending(false);
    }
  };

  const handleStopClick = async () => {
    if (isStopPending) return;
    setIsStopPending(true);
    try {
      const res = await launcherService.stopGame(game.id);
      if (res.message) {
        showTempFeedback(res.message);
      }
    } finally {
      setIsStopPending(false);
    }
  };

  const handleToggleSessionFullscreen = async () => {
    if (isFullscreenTogglePending || isStopPending) return;
    setIsFullscreenTogglePending(true);
    try {
      const res = await launcherService.toggleSessionFullscreen(game.id);
      if (res && !res.success && res.error) {
        showTempFeedback(res.error);
      } else if (res?.message) {
        showTempFeedback(res.message, 2500);
      }
    } finally {
      setIsFullscreenTogglePending(false);
    }
  };

  return (
    <div className="bg-[#101822] border border-[#2a475e] rounded p-3.5 xl:p-4 shadow-xl text-steam-text select-none">
      <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3 xl:gap-5">
        {/* Left: Action Button & Library Status */}
        <div className="flex items-center gap-2 xl:gap-2.5 shrink-0 flex-wrap sm:flex-nowrap py-0.5">
          {/* Main Action Button (Starting / Running / Stopping / Installing / Play / Install) */}
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
            {isRunning ? (
              <div className="flex items-center gap-1.5">
                {activeSession?.status === 'starting' ? (
                  <span
                    data-testid="actionbar-session-starting"
                    className="inline-flex items-center gap-1.5 px-4 xl:px-5 py-2 xl:py-2.5 rounded bg-sky-950/80 border border-sky-500/60 text-sky-300 font-bold text-xs uppercase tracking-wider shadow-sm"
                  >
                    <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin" aria-hidden="true" />
                    <span>Starting...</span>
                  </span>
                ) : isStoppingSession ? (
                  <>
                    <span
                      data-testid="actionbar-session-stopping"
                      className="inline-flex items-center gap-1.5 px-3 py-2 xl:py-2.5 rounded bg-amber-950/80 border border-amber-500/60 text-amber-300 font-bold text-xs uppercase tracking-wider shadow-sm"
                    >
                      <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" aria-hidden="true" />
                      <span>Stopping...</span>
                    </span>
                    <button
                      type="button"
                      disabled
                      className="inline-flex items-center justify-center gap-1.5 px-4 xl:px-5 py-2 xl:py-2.5 rounded font-bold text-xs xl:text-sm text-white tracking-wider uppercase transition-all shadow-md opacity-50 cursor-not-allowed shrink-0"
                      style={{
                        background: 'linear-gradient(to right, #dc2626 0%, #991b1b 100%)',
                      }}
                      title="Stopping game and syncing cloud saves..."
                    >
                      <Square className="w-3.5 h-3.5 fill-white" aria-hidden="true" />
                      <span>Stop</span>
                    </button>
                  </>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1.5 px-3 py-2 xl:py-2.5 rounded bg-emerald-950/80 border border-emerald-500/60 text-emerald-300 font-bold text-xs uppercase tracking-wider shadow-sm">
                      <Activity className="w-3.5 h-3.5 text-emerald-400 animate-pulse" aria-hidden="true" />
                      <span>Running</span>
                    </span>
                    <button
                      type="button"
                      onClick={handleStopClick}
                      disabled={isStopPending}
                      className="inline-flex items-center justify-center gap-1.5 px-4 xl:px-5 py-2 xl:py-2.5 rounded font-bold text-xs xl:text-sm text-white tracking-wider uppercase transition-all shadow-md hover:brightness-110 active:scale-[0.99] shrink-0 cursor-pointer disabled:opacity-50"
                      style={{
                        background: 'linear-gradient(to right, #dc2626 0%, #991b1b 100%)',
                        boxShadow: '0 0 14px rgba(220, 38, 38, 0.45)',
                      }}
                      title={`Stop ${game.title}`}
                    >
                      <Square className="w-3.5 h-3.5 fill-white" aria-hidden="true" />
                      <span>Stop</span>
                    </button>
                    {isBottledRunningSession && (
                      <button
                        type="button"
                        data-testid="live-session-fullscreen-toggle"
                        aria-pressed={Boolean(activeSession?.fullscreenActive)}
                        title="Toggle Bottled Game Fullscreen / Windowed (Ctrl+Option+F)"
                        disabled={isFullscreenTogglePending || isStopPending}
                        onClick={handleToggleSessionFullscreen}
                        className={`min-h-[38px] inline-flex items-center justify-center gap-1.5 px-3.5 xl:px-4 py-2 xl:py-2.5 rounded border font-bold text-xs xl:text-sm tracking-wider uppercase transition-colors shrink-0 cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                          activeSession?.fullscreenActive
                            ? 'bg-sky-950/75 hover:bg-sky-900/80 border-sky-400/60 text-sky-100 hover:text-white'
                            : 'bg-[#16202d] hover:bg-[#1f2c3d] border-[#3878a8]/80 text-white'
                        }`}
                      >
                        {activeSession?.fullscreenActive ? (
                          <>
                            <Minimize2
                              className="w-3.5 h-3.5 text-sky-300 shrink-0"
                              aria-hidden="true"
                            />
                            <span>Windowed</span>
                          </>
                        ) : (
                          <>
                            <Maximize2
                              className="w-3.5 h-3.5 text-sky-400 shrink-0"
                              aria-hidden="true"
                            />
                            <span>Fullscreen</span>
                          </>
                        )}
                      </button>
                    )}
                  </>
                )}
              </div>
            ) : isStartingSession ? (
              <button
                type="button"
                disabled
                data-testid="actionbar-play-starting"
                className="inline-flex items-center justify-center gap-1.5 xl:gap-2 px-5 xl:px-6 py-2 xl:py-2.5 rounded font-bold text-xs xl:text-sm text-white tracking-wider uppercase transition-all shadow-md opacity-75 cursor-wait shrink-0"
                style={{
                  background: 'linear-gradient(to right, #2f6f18 5%, #1f5110 95%)',
                }}
              >
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                <span>Starting...</span>
              </button>
            ) : activeDownload ? (
              (() => {
                const isPausedDownload = activeDownload.status === 'paused';
                const activeDownloadPct = Math.min(
                  100,
                  Math.max(0, Math.round(activeDownload.progressPercent || 0))
                );
                const activeSpeedLabel =
                  (activeDownload.status === 'downloading' ||
                    activeDownload.status === 'extracting' ||
                    activeDownload.status === 'verifying') &&
                  activeDownload.speedBytesPerSec > 0
                    ? `${
                        activeDownload.status === 'extracting' ||
                        activeDownload.status === 'verifying'
                          ? 'Disk '
                          : ''
                      }${(activeDownload.speedBytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
                    : '';
                const tooltipDetails = [
                  activeDownload.statusMessage?.trim(),
                  activeSpeedLabel && !activeDownload.statusMessage?.includes('MB/s')
                    ? activeSpeedLabel
                    : '',
                ]
                  .filter(Boolean)
                  .join(' • ');
                const activeDownloadTitle = tooltipDetails
                  ? `${tooltipDetails} — Click to open Download Manager`
                  : 'Click to open Download Manager';

                return (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => launcherService.openDownloadDrawer()}
                      aria-label={
                        isPausedDownload
                          ? `Paused ${activeDownloadPct}% — Open Download Manager`
                          : `${activeDownloadPct}% — Open Download Manager`
                      }
                      className={`relative overflow-hidden inline-flex items-center justify-center gap-2 px-5 xl:px-6 py-2 xl:py-2.5 rounded font-bold text-xs xl:text-sm text-white tracking-wider uppercase transition-all shadow-md hover:brightness-110 shrink-0 cursor-pointer ${
                        isPausedDownload
                          ? 'bg-[#241e14] border border-amber-400/70'
                          : 'bg-[#17283b] border border-sky-400/70'
                      }`}
                      title={activeDownloadTitle}
                    >
                      <div
                        aria-hidden="true"
                        className={`absolute inset-y-0 left-0 transition-all duration-300 motion-reduce:transition-none pointer-events-none ${
                          isPausedDownload ? 'bg-amber-500/30' : 'bg-sky-500/35'
                        }`}
                        style={{
                          width: `${Math.min(100, Math.max(0, activeDownload.progressPercent || 0))}%`,
                        }}
                      />
                      {isPausedDownload ? (
                        <Pause
                          className="w-4 h-4 text-amber-300 relative z-10"
                          aria-hidden="true"
                        />
                      ) : (
                        <Loader2
                          className="w-4 h-4 text-sky-300 animate-spin motion-reduce:animate-none relative z-10"
                          aria-hidden="true"
                        />
                      )}
                      <span className="relative z-10 tabular-nums">
                        {isPausedDownload
                          ? `Paused ${activeDownloadPct}%`
                          : `${activeDownloadPct}%`}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        await launcherService.cancelDownload(activeDownload.taskId);
                        showTempFeedback('Installation cancelled.');
                      }}
                      aria-label="Cancel Install"
                      title="Cancel active installation"
                      className="min-w-6 min-h-6 p-2 xl:p-2.5 rounded border border-red-500/50 bg-red-950/60 hover:bg-red-900/70 text-red-300 hover:text-white transition-colors shrink-0 cursor-pointer"
                    >
                      <X className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </div>
                );
              })()
            ) : isInstalled ? (
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  onClick={handlePlayClick}
                  className="inline-flex items-center justify-center gap-1.5 xl:gap-2 px-5 xl:px-6 py-2 xl:py-2.5 rounded font-bold text-xs xl:text-sm text-white tracking-wider uppercase transition-all shadow-md hover:brightness-110 active:scale-[0.99] shrink-0 cursor-pointer"
                  style={{
                    background: isXboxSubscriptionExpired
                      ? 'linear-gradient(to right, #475569 5%, #334155 95%)'
                      : 'linear-gradient(to right, #2f6f18 5%, #1f5110 95%)',
                    boxShadow: isXboxSubscriptionExpired
                      ? 'none'
                      : '0 0 16px rgba(47, 111, 24, 0.5)',
                  }}
                  title={
                    isXboxSubscriptionExpired
                      ? `Launch ${game.title} (Game Pass subscription access expired — purchase or renew if required)`
                      : `Launch ${game.title} (${getStorefrontDisplayName(selectedPlatformId)})`
                  }
                >
                  <Play className="w-4 h-4 fill-white" aria-hidden="true" />
                  <span>Play</span>
                </button>
                {isXboxSubscriptionExpired && xboxStoreUrl && (
                  <a
                    href={xboxStoreUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="xbox-expired-store-cta"
                    onClick={(e) => {
                      e.preventDefault();
                      if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
                        window.electronAPI.openExternal(xboxStoreUrl);
                      } else {
                        window.open(xboxStoreUrl, '_blank', 'noreferrer,noopener');
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-2 xl:py-2.5 rounded bg-rose-950/70 hover:bg-rose-900/80 border border-rose-500/60 text-rose-200 hover:text-white text-[11px] font-bold uppercase tracking-wider transition-colors shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                    title="Game Pass access rotated out or expired. View on Xbox Store to purchase or renew."
                  >
                    <span>Subscription Expired • Xbox Store</span>
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  </a>
                )}
              </div>
            ) : isXboxSubscriptionExpired ? (
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  disabled
                  data-testid="actionbar-install-expired-disabled"
                  className="inline-flex items-center justify-center gap-1.5 xl:gap-2 px-5 xl:px-6 py-2 xl:py-2.5 rounded font-bold text-xs xl:text-sm text-slate-300 tracking-wider uppercase transition-all shadow-none opacity-65 cursor-not-allowed shrink-0 bg-slate-800/80 border border-slate-600/60"
                  title={`Game Pass access expired for ${game.title} — purchase or renew on Xbox Store to install`}
                >
                  <span>Subscription Expired</span>
                </button>
                {xboxStoreUrl && (
                  <a
                    href={xboxStoreUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="xbox-expired-store-cta"
                    onClick={(e) => {
                      e.preventDefault();
                      if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
                        window.electronAPI.openExternal(xboxStoreUrl);
                      } else {
                        window.open(xboxStoreUrl, '_blank', 'noreferrer,noopener');
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-2 xl:py-2.5 rounded bg-rose-950/70 hover:bg-rose-900/80 border border-rose-500/60 text-rose-200 hover:text-white text-[11px] font-bold uppercase tracking-wider transition-colors shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                    title="Game Pass access rotated out or expired. View on Xbox Store to purchase or renew."
                  >
                    <span>View on Xbox Store</span>
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  </a>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={handleInstallClick}
                onPointerEnter={prefetchGameInstallModal}
                onFocus={prefetchGameInstallModal}
                className="inline-flex items-center justify-center gap-1.5 xl:gap-2 px-5 xl:px-6 py-2 xl:py-2.5 rounded font-bold text-xs xl:text-sm text-white tracking-wider uppercase transition-all shadow-md hover:brightness-110 active:scale-[0.99] shrink-0 cursor-pointer"
                style={{
                  background: 'linear-gradient(to right, #214b6b 0%, #123049 100%)',
                  border: '1px solid #3878a8',
                  boxShadow: '0 0 12px rgba(33, 75, 107, 0.4)',
                }}
                title={`Install ${game.title} (${getStorefrontDisplayName(selectedPlatformId)})`}
              >
                <Download className="w-4 h-4 text-sky-400" aria-hidden="true" />
                <span>Install</span>
              </button>
            )}

            {/* Storefront Switcher Pill (when owned on >1 storefront) */}
            {game.platforms.length > 1 && (
              <div
                className="relative inline-flex items-center justify-center p-2 xl:p-2.5 rounded bg-[#16202d] hover:bg-[#1f2c3d] border border-steam-border/80 text-white shrink-0 cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-steam-accent focus-within:border-steam-accent"
                title={`Active Storefront: ${getStorefrontDisplayName(selectedPlatformId)} (Click to switch)`}
              >
                <StorefrontIcon
                  storefrontId={selectedPlatformId}
                  decorative
                  className={`w-4 h-4 shrink-0 pointer-events-none ${
                    selectedPlatformId === 'xbox' ? 'text-[#52d652]' : 'text-sky-400'
                  }`}
                />
                <ChevronDown
                  className="w-3 h-3 text-steam-subtext ml-1 shrink-0 pointer-events-none"
                  aria-hidden="true"
                />
                <select
                  aria-label="Target Storefront"
                  value={selectedPlatformId}
                  onChange={(e) => {
                    const nextPlat = e.target.value as StorefrontId;
                    userManuallySelectedPlatformRef.current = true;
                    setSelectedPlatformId(nextPlat);
                    launcherService.setSelectedStorefrontForGame(game.id, nextPlat);
                  }}
                  title={`Active Storefront: ${getStorefrontDisplayName(selectedPlatformId)} (Click to switch)`}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                >
                  {game.platforms.map((plat) => {
                    const platInstalled =
                      launcherService.isGameInstalled(game, plat.platformId) ||
                      Boolean(plat.installed);
                    return (
                      <option
                        key={plat.platformId}
                        value={plat.platformId}
                        className="bg-[#131b26] text-white"
                      >
                        {getStorefrontDisplayName(plat.platformId)}{' '}
                        {platInstalled ? '• Installed' : '• Not Installed'}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}

            {/* Gear (Manage Game) Dropdown Button */}
            <div className="relative" ref={manageMenuRef}>
              <button
                ref={manageTriggerRef}
                type="button"
                onClick={(e) => {
                  const isKeyboardActivation = !e || e.detail === 0;
                  setIsManageMenuOpen((prev) => {
                    const next = !prev;
                    pendingManageFocusRef.current = next && isKeyboardActivation ? 'first' : null;
                    return next;
                  });
                }}
                onKeyDown={handleManageTriggerKeyDown}
                aria-label="Manage Game"
                aria-haspopup="menu"
                aria-expanded={isManageMenuOpen}
                aria-controls={isManageMenuOpen ? 'manage-game-dropdown' : undefined}
                title="Manage Game (Files, Launch Settings, Verify, Uninstall)"
                className={`p-2 xl:p-2.5 rounded border transition-colors shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent ${
                  isManageMenuOpen
                    ? 'bg-steam-accent text-black border-steam-accent'
                    : 'text-steam-subtext hover:text-white bg-[#16202d] hover:bg-[#1f2c3d] border-steam-border/80'
                }`}
              >
                <Settings className="w-4 h-4" aria-hidden="true" />
              </button>

              {isManageMenuOpen &&
                renderManageGameDropdown({
                  game,
                  selectedPlatformId,
                  isInstalled,
                  isWindowsHost,
                  hasLocalFilesPath,
                  activeDownload,
                  dropdownRef: manageDropdownRef,
                  onMenuKeyDown: handleManageMenuKeyDown,
                  onCloseMenu: () => setIsManageMenuOpen(false),
                  onOpenInstallModal: () => setIsInstallModalOpen(true),
                  onPrefetchInstallModal: prefetchGameInstallModal,
                  onOpenLaunchConfigModal: () => setIsLaunchConfigOpen(true),
                  onPrefetchLaunchConfigModal: prefetchGameLaunchConfigModal,
                  onToggleInstallStatus,
                  onFixMatch,
                  onHideGame,
                  showTempFeedback,
                })}
            </div>
          </div>

          {/* Collections Shortcut Button */}
          {onManageCollections && (
            <button
              type="button"
              onClick={onManageCollections}
              aria-label={isInCollection ? 'In Collection (click to manage)' : 'Add to Collections'}
              className={`min-w-6 min-h-6 p-2 xl:p-2.5 rounded transition-all shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent ${
                isInCollection
                  ? 'bg-[#1b2b3d] text-steam-accent border border-steam-accent/60 shadow-[0_0_8px_rgba(102,192,244,0.3)] hover:brightness-110'
                  : 'text-steam-subtext hover:text-white bg-[#16202d] hover:bg-[#1f2c3d] border border-steam-border/80'
              }`}
              title={isInCollection ? 'In Collection (click to manage)' : 'Add to Collections'}
            >
              <Bookmark
                className={`w-4 h-4 transition-transform active:scale-95 ${
                  isInCollection
                    ? 'text-steam-accent fill-steam-accent drop-shadow-[0_0_4px_rgba(102,192,244,0.6)]'
                    : 'text-steam-subtext hover:text-white'
                }`}
                aria-hidden="true"
              />
            </button>
          )}
        </div>

        {/* Right: Steam Library Stats Matrix */}
        <div className="flex flex-wrap lg:flex-nowrap items-start justify-start lg:justify-end gap-x-5 xl:gap-x-7 gap-y-3 border-t lg:border-t-0 lg:border-l border-[#2a475e]/60 pt-3 lg:pt-0 pl-0 lg:pl-4 xl:pl-6 flex-1 min-w-0">
          {/* Play Time */}
          {game.platforms.length > 1 ? (
            <div
              className="flex flex-col min-w-0 shrink-0"
              title="Click to view per-store playtime breakdown"
              onClick={() => {
                setShowPlaytimePopover((prev) => {
                  const next = !prev;
                  if (next) setShowAchievementPopover(false);
                  return next;
                });
              }}
            >
              <button
                type="button"
                aria-expanded={showPlaytimePopover}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowPlaytimePopover((prev) => {
                    const next = !prev;
                    if (next) setShowAchievementPopover(false);
                    return next;
                  });
                }}
                className="flex flex-col min-w-0 min-h-6 shrink-0 text-left cursor-pointer group select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent rounded"
              >
                <span
                  className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 whitespace-nowrap transition-colors ${
                    showPlaytimePopover
                      ? 'text-steam-accent'
                      : 'text-[#94a3b8] group-hover:text-white'
                  }`}
                >
                  <Clock className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                  <span>Play Time</span>
                  <ChevronDown
                    className={`w-2.5 h-2.5 transition-transform duration-200 text-sky-400/80 group-hover:text-sky-300 ${
                      showPlaytimePopover ? 'rotate-180 text-steam-accent' : ''
                    }`}
                    aria-hidden="true"
                  />
                </span>
                <span className="text-sm font-bold text-white mt-0.5 whitespace-nowrap transition-colors group-hover:text-steam-accent">
                  {formatPlaytime(totalPlaytimeMinutes)}
                </span>
              </button>
            </div>
          ) : (
            <div className="flex flex-col min-w-0 shrink-0">
              <span className="text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 whitespace-nowrap text-[#94a3b8]">
                <Clock className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                <span>Play Time</span>
              </span>
              <span className="text-sm font-bold text-white mt-0.5 whitespace-nowrap">
                {formatPlaytime(totalPlaytimeMinutes)}
              </span>
            </div>
          )}

          {/* Last Played */}
          <div className="flex flex-col min-w-0 shrink-0">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#94a3b8] flex items-center gap-1 whitespace-nowrap">
              <Calendar className="w-3 h-3 text-sky-400" aria-hidden="true" />
              Last Played
            </span>
            <span className="text-sm font-bold text-white mt-0.5 whitespace-nowrap">
              {formatLastPlayed()}
            </span>
          </div>

          {/* Space Required */}
          <div className="flex flex-col min-w-0 shrink-0">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#94a3b8] flex items-center gap-1 whitespace-nowrap">
              <HardDrive className="w-3 h-3 text-sky-400" aria-hidden="true" />
              Space Required
            </span>
            <span className="text-sm font-bold text-white mt-0.5 whitespace-nowrap">
              {getSpaceRequired()}
            </span>
          </div>

          {/* Achievements */}
          {(() => {
            const bestHasDisplayableAch =
              bestAchievement.total > 0 ||
              bestAchievement.unlocked > 0 ||
              (bestAchievement.gamerscore?.total ?? 0) > 0 ||
              (bestAchievement.xp?.total ?? 0) > 0;
            const hasMultiStoreAch = platformAchievements.length > 1;
            const isInteractiveAch =
              Boolean(onViewAchievements && hasAchievements && bestHasDisplayableAch) ||
              hasMultiStoreAch;

            const toggleBreakdownDrawer = () => {
              setShowAchievementPopover((prev) => {
                const next = !prev;
                if (next) setShowPlaytimePopover(false);
                return next;
              });
            };

            const achContent = (
              <>
                <div className="flex items-center gap-1.5 whitespace-nowrap">
                  <span
                    className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 transition-colors ${
                      hasMultiStoreAch
                        ? showAchievementPopover
                          ? 'text-steam-accent'
                          : 'text-[#94a3b8] group-hover:text-white'
                        : 'text-[#94a3b8]'
                    }`}
                  >
                    {isAnyMastered ? (
                      <span
                        className="relative inline-flex items-center justify-center w-3 h-3 shrink-0"
                        title="Mastered (100% Achievements Unlocked)"
                      >
                        <Trophy
                          className="w-3 h-3 text-amber-300 fill-amber-400 drop-shadow-[0_0_4px_rgba(251,191,36,0.95)]"
                          aria-hidden="true"
                        />
                        <Sparkles
                          className="w-2 h-2 text-yellow-200 absolute -top-1 -right-1 drop-shadow-[0_0_2px_rgba(255,255,255,0.9)] animate-pulse pointer-events-none"
                          aria-hidden="true"
                        />
                      </span>
                    ) : (
                      <Trophy
                        className={`w-3 h-3 shrink-0 ${
                          hasAchievements && bestHasDisplayableAch
                            ? 'text-amber-400'
                            : 'text-[#94a3b8]'
                        }`}
                        aria-hidden="true"
                      />
                    )}
                    <span>Achievements</span>
                  </span>
                </div>

                {hasAchievements && bestHasDisplayableAch ? (
                  <>
                    <div className="flex items-center gap-1.5 mt-0.5 whitespace-nowrap">
                      <span
                        className={`text-sm font-bold text-white transition-colors ${
                          hasMultiStoreAch ? 'group-hover:text-steam-accent' : ''
                        }`}
                      >
                        {bestAchievement.total > 0
                          ? `${bestAchievement.unlocked} / ${bestAchievement.total}`
                          : `${bestAchievement.unlocked} Unlocked`}
                      </span>
                      {bestAchievement.total > 0 && (
                        <span
                          className={`text-[11px] ${
                            isAnyMastered ? 'text-amber-300 font-semibold' : 'text-[#94a3b8]'
                          }`}
                        >
                          ({bestAchievement.percentage}%)
                        </span>
                      )}
                      {bestAchievement.platformId === 'xbox' &&
                        bestAchievement.gamerscore &&
                        bestAchievement.gamerscore.total > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-emerald-300 bg-emerald-950/70 border border-emerald-500/40 px-1 py-0.2 rounded font-mono">
                            <span>{bestAchievement.gamerscore.earned}</span>
                            <span>G</span>
                          </span>
                        )}
                    </div>

                    <div className="w-full bg-[#1b2838] h-1 rounded-full mt-1 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          isAnyMastered
                            ? 'bg-gradient-to-r from-amber-400 to-yellow-300'
                            : 'bg-amber-400'
                        }`}
                        style={{ width: `${Math.min(100, bestAchievement.percentage)}%` }}
                      />
                    </div>
                  </>
                ) : (
                  <span className="text-sm font-medium text-steam-subtext mt-0.5 whitespace-nowrap">
                    No Achievements
                  </span>
                )}
              </>
            );

            if (isInteractiveAch) {
              return (
                <div className="flex items-start gap-1 min-w-0 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      if (onViewAchievements && hasAchievements && bestHasDisplayableAch) {
                        onViewAchievements(bestAchievement.platformId);
                      } else if (hasMultiStoreAch) {
                        toggleBreakdownDrawer();
                      }
                    }}
                    className="flex flex-col min-w-0 min-h-6 shrink-0 text-left cursor-pointer group select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent rounded"
                    title={
                      hasAchievements && bestHasDisplayableAch
                        ? 'Click to view full achievements browser, icons & unlock dates'
                        : 'Click to view per-store achievements breakdown'
                    }
                  >
                    {achContent}
                  </button>
                  {hasMultiStoreAch && (
                    <button
                      type="button"
                      data-testid="toggle-storefront-achievements-drawer"
                      aria-label="Toggle storefront achievements breakdown"
                      aria-expanded={showAchievementPopover}
                      onClick={toggleBreakdownDrawer}
                      className={`min-w-6 min-h-6 mt-0.5 rounded inline-flex items-center justify-center transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent ${
                        showAchievementPopover
                          ? 'bg-[#1b2b3d] text-steam-accent'
                          : 'text-sky-400/80 hover:text-sky-300 hover:bg-white/10'
                      }`}
                      title="Toggle per-store achievements breakdown"
                    >
                      <ChevronDown
                        className={`w-3.5 h-3.5 transition-transform duration-200 ${
                          showAchievementPopover ? 'rotate-180' : ''
                        }`}
                        aria-hidden="true"
                      />
                    </button>
                  )}
                </div>
              );
            }

            return <div className="flex flex-col min-w-0 shrink-0">{achContent}</div>;
          })()}

          {/* Critic Score */}
          {openCritic && ocColors && ocMeta && (
            <div
              role="group"
              aria-label={ocMeta.ariaLabel}
              data-critic-source={ocMeta.shortTag}
              className="flex flex-col min-w-0 shrink-0"
            >
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[#94a3b8] flex items-center gap-1 whitespace-nowrap">
                <Award className="w-3 h-3 text-purple-400" aria-hidden="true" />
                <span>{ocMeta.shortLabel}</span>
                <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-white/5 border border-white/10 text-[#cbd5e1]">
                  {ocMeta.shortTag}
                </span>
              </span>
              <div className="flex items-center gap-1.5 mt-0.5 whitespace-nowrap">
                <span className={`text-sm font-black ${ocColors.accentText}`}>
                  {ocMeta.shortTag === 'MCU' && openCritic.userScoreRaw !== undefined
                    ? `${openCritic.userScoreRaw}/10`
                    : ocMeta.isStoreRating && openCritic.starRatingRaw !== undefined
                    ? `${openCritic.starRatingRaw}★ (${openCritic.score})`
                    : openCritic.score}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onApplyFilter?.({
                      type: 'rating',
                      label: 'Rating',
                      value: openCritic.tier,
                    })
                  }
                  aria-label={`Filter library for ${openCritic.tier} games (${ocMeta.ariaLabel})`}
                  className={`text-[10px] font-bold px-1.5 py-0.2 min-h-6 inline-flex items-center rounded border hover:underline hover:brightness-125 cursor-pointer ${ocColors.badgeBg} ${ocColors.badgeBorder} ${ocColors.badgeText}`}
                  title={`Filter library for ${openCritic.tier} games`}
                >
                  {openCritic.tier}
                </button>
                {openCritic.url && (
                  <a
                    href={openCritic.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
                        window.electronAPI.openExternal(openCritic.url);
                      } else {
                        window.open(openCritic.url, '_blank', 'noreferrer,noopener');
                      }
                    }}
                    className="inline-flex items-center justify-center min-w-6 min-h-6 text-steam-subtext hover:text-white transition-colors cursor-pointer"
                    aria-label={`${ocMeta.externalLinkPrefix} ${game.title}`}
                    title={`${ocMeta.externalLinkPrefix} ${game.title}`}
                  >
                    <ExternalLink className="w-2.5 h-2.5" aria-hidden="true" />
                  </a>
                )}
              </div>
              <span className="text-[10px] text-[#94a3b8] mt-0.5 truncate">
                {openCritic.percentRecommended !== undefined
                  ? `${openCritic.percentRecommended}% ${
                      ocMeta.shortTag === 'STM' ? 'Positive' : 'Recommended'
                    }`
                  : ocMeta.isStoreRating && openCritic.starRatingRaw !== undefined
                  ? `${openCritic.starRatingRaw}/5 Stars${
                      openCritic.numReviews
                        ? ` (${openCritic.numReviews.toLocaleString()} ratings)`
                        : ''
                    }`
                  : ocMeta.shortTag === 'CST'
                  ? 'Custom Override'
                  : `${openCritic.tier} Consensus`}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Multi-Store Playtime Breakdown Drawer */}
      {showPlaytimePopover &&
        game.platforms.length > 1 &&
        renderPlaytimeBreakdownDrawer({
          game,
          totalPlaytimeMinutes,
          formatPlatformLastPlayed,
          onClose: () => setShowPlaytimePopover(false),
        })}

      {/* Multi-Store Achievements Drawer */}
      {showAchievementPopover &&
        platformAchievements.length > 1 &&
        renderAchievementsBreakdownDrawer({
          platformAchievements,
          onViewAchievements,
          onClose: () => setShowAchievementPopover(false),
        })}

      {/* macOS Chained Publisher Launcher / Anti-Cheat Compatibility Callout */}
      {!isWindowsHost &&
        renderMacCompatHandoffBanner({
          game,
          metadata,
          activePlatform,
          selectedPlatformId,
        })}

      {/* Action Feedback / Launch Error Banner */}
      {actionFeedback && (
        <div
          role="alert"
          className="mt-3 px-3 py-2 rounded bg-[#162334] border border-sky-500/40 text-xs text-sky-200 flex items-center justify-between gap-2"
        >
          <span>{actionFeedback}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setActionFeedback(null)}
            className="inline-flex items-center justify-center min-w-6 min-h-6 text-steam-subtext hover:text-white cursor-pointer"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Universal Game Install Modal (lazy-loaded on demand) */}
      {isInstallModalOpen && (
        <ModalErrorBoundary
          modalName="Game Installation"
          isOpen={isInstallModalOpen}
          onClose={() => setIsInstallModalOpen(false)}
        >
          <Suspense fallback={null}>
            <GameInstallModal
              isOpen={isInstallModalOpen}
              game={game}
              initialPlatformId={selectedPlatformId}
              onClose={() => setIsInstallModalOpen(false)}
              onInstallStarted={(task) => {
                if (task?.platformId) {
                  userManuallySelectedPlatformRef.current = true;
                  setSelectedPlatformId(task.platformId);
                  launcherService.setSelectedStorefrontForGame(game.id, task.platformId);
                }
              }}
            />
          </Suspense>
        </ModalErrorBoundary>
      )}

      {/* Per-Game Launch & Compatibility Configuration Modal (lazy-loaded on demand) */}
      {isLaunchConfigOpen && (
        <ModalErrorBoundary
          modalName="Launch Configuration"
          isOpen={isLaunchConfigOpen}
          onClose={() => setIsLaunchConfigOpen(false)}
        >
          <Suspense fallback={null}>
            <GameLaunchConfigModal
              isOpen={isLaunchConfigOpen}
              game={game}
              initialPlatformId={selectedPlatformId}
              onClose={() => setIsLaunchConfigOpen(false)}
              onSaved={(cfg) => {
                if (cfg.preferredPlatformId) {
                  userManuallySelectedPlatformRef.current = true;
                  setSelectedPlatformId(cfg.preferredPlatformId);
                  launcherService.setSelectedStorefrontForGame(game.id, cfg.preferredPlatformId);
                }
                showTempFeedback(`Saved launch configuration for ${game.title}.`);
              }}
            />
          </Suspense>
        </ModalErrorBoundary>
      )}
    </div>
  );
};
