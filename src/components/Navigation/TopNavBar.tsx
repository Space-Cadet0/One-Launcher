import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { StorefrontId } from '../../contracts/platform';
import { loadIntegrations } from '../../services/integrations/integrationStorage';
import { launcherService } from '../../services/launcher/launcherService';
import type { AppUpdateCheckResult, WindowMenuAction } from '../../types/electron';
import { Layers, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import {
  ALL_NAV_PLATFORMS,
  TOP_MENU_ORDER,
  type MenuKeyboardNavOptions,
  type TopMenuId,
  type TopNavBarProps,
} from './topNav/types';
import { renderWindowMenuBar } from './topNav/renderWindowMenuBar';
import { renderBurgerMenu } from './topNav/renderBurgerMenu';
import { renderPrimaryNavPills } from './topNav/renderPrimaryNavPills';
import { renderAboutModal } from './topNav/renderAboutModal';

export type { TopNavBarProps } from './topNav/types';

export const TopNavBar: React.FC<TopNavBarProps> = ({
  selectedPlatform,
  onSelectPlatform,
  installedOnly,
  onToggleInstalledOnly,
  totalGamesCount,
  filteredCount,
  isSyncing,
  onTriggerSync,
  onOpenIntegrations,
  canGoBack = false,
  onGoBack,
  backTitle,
  canGoForward = false,
  onGoForward,
  forwardTitle,
  connectedStorefronts,
  presentStorefronts,
  games,
  currentGameTitle,
  canSyncCurrentGame = false,
  isSyncingCurrentGame = false,
  onSyncCurrentGame,
  isSyncingAllMedia = false,
  onSyncAllMedia,
  isSyncingScores = false,
  onRefreshScores,
  isSyncingTrophies = false,
  onSyncTrophies,
  onOpenFixMatch,
  onOpenLibraryMatchManager,
  onOpenSystemSetup,
  onOpenSettings,
  systemSetupAlertCount,
  defaultMenuOpen = false,
  onOpenAchievements,
  onOpenDownloads,
}) => {
  const [isMenuOpen, setIsMenuOpen] = useState(defaultMenuOpen);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [openMenu, setOpenMenu] = useState<TopMenuId | null>(null);
  const [activeMenuBarIndex, setActiveMenuBarIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const burgerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const burgerMenuDropdownRef = useRef<HTMLDivElement | null>(null);
  const topMenuBarRef = useRef<HTMLDivElement | null>(null);
  const topMenuTriggerRefs = useRef<Record<TopMenuId, HTMLButtonElement | null>>({
    file: null,
    edit: null,
    view: null,
    window: null,
  });
  const topMenuDropdownRefs = useRef<Record<TopMenuId, HTMLDivElement | null>>({
    file: null,
    edit: null,
    view: null,
    window: null,
  });
  const [downloadQueue, setDownloadQueue] = useState(() => launcherService.getDownloadQueue());
  const [appVersion, setAppVersion] = useState<string>('');
  const [updateStatus, setUpdateStatus] = useState<
    'idle' | 'checking' | 'up-to-date' | 'update-available'
  >('idle');
  const [updateInfo, setUpdateInfo] = useState<AppUpdateCheckResult | null>(null);
  const [isAboutModalOpen, setIsAboutModalOpen] = useState(false);

  useEffect(() => {
    let active = true;
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (typeof api?.getAppVersion === 'function') {
      api
        .getAppVersion()
        .then((ver: string) => {
          if (active && ver && typeof ver === 'string' && ver.trim()) {
            setAppVersion(ver.trim());
          }
        })
        .catch(() => {});
    }
    if (typeof api?.checkForAppUpdates === 'function') {
      api
        .checkForAppUpdates()
        .then((res: AppUpdateCheckResult) => {
          if (!active) return;
          if (res?.currentVersion && typeof res.currentVersion === 'string') {
            setAppVersion(res.currentVersion);
          }
          if (res?.hasUpdate) {
            setUpdateInfo(res);
            setUpdateStatus('update-available');
          }
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, []);

  const handleCheckForUpdates = async () => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (updateInfo?.hasUpdate && (updateInfo.downloadUrl || updateInfo.releaseUrl)) {
      const targetUrl = (updateInfo.downloadUrl || updateInfo.releaseUrl)!;
      setIsMenuOpen(false);
      if (typeof api?.openExternalUrl === 'function') {
        await api.openExternalUrl(targetUrl);
      } else if (typeof api?.openExternal === 'function') {
        await api.openExternal(targetUrl);
      } else if (typeof window !== 'undefined') {
        window.open(targetUrl, '_blank', 'noopener,noreferrer');
      }
      return;
    }

    if (updateStatus === 'checking') return;
    setUpdateStatus('checking');
    try {
      const res: AppUpdateCheckResult | undefined = await api?.checkForAppUpdates?.();
      if (res?.currentVersion) {
        setAppVersion(res.currentVersion);
      }
      if (res?.hasUpdate) {
        setUpdateInfo(res);
        setUpdateStatus('update-available');
      } else {
        if (res) setUpdateInfo(res);
        setUpdateStatus('up-to-date');
      }
    } catch {
      setUpdateStatus('up-to-date');
    }
  };

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (api?.onFullscreenChanged) {
      return api.onFullscreenChanged((full: boolean) => setIsFullScreen(Boolean(full)));
    }
  }, []);

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!api) return;
    let active = true;
    if (typeof api.isWindowMaximized === 'function') {
      api
        .isWindowMaximized()
        .then((val: boolean) => {
          if (active) setIsMaximized(Boolean(val));
        })
        .catch(() => {});
    }
    const unsub =
      typeof api.onMaximizedChanged === 'function'
        ? api.onMaximizedChanged((val: boolean) => setIsMaximized(Boolean(val)))
        : undefined;
    return () => {
      active = false;
      unsub?.();
    };
  }, []);

  const hostCapabilities = launcherService.getHostCapabilities();
  const electronPlatform = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined;
  const isMacWindow =
    typeof window !== 'undefined' &&
    (electronPlatform
      ? electronPlatform === 'darwin'
      : Boolean(window.electronAPI?.isElectron) && hostCapabilities.isMac);
  const needsTrafficLightInset = isMacWindow && !isFullScreen;

  const isWindowsOrLinuxWindow =
    typeof window !== 'undefined' &&
    Boolean(window.electronAPI) &&
    (electronPlatform === 'win32' ||
      electronPlatform === 'linux' ||
      (!isMacWindow && Boolean(window.electronAPI?.minimizeWindow))) &&
    !isFullScreen;

  useEffect(() => {
    const computeQueueSig = (q: ReturnType<typeof launcherService.getDownloadQueue>) =>
      q
        .map(
          (t) =>
            `${t.taskId}:${t.status}:${Math.round(t.progressPercent || 0)}:${Math.round((t.speedBytesPerSec || 0) / 1024)}`
        )
        .join('|');
    let prevSig = computeQueueSig(launcherService.getDownloadQueue());
    const unsub = launcherService.subscribe(() => {
      const nextQueue = launcherService.getDownloadQueue();
      const nextSig = computeQueueSig(nextQueue);
      if (nextSig !== prevSig) {
        prevSig = nextSig;
        setDownloadQueue([...nextQueue]);
      }
    });
    return unsub;
  }, []);

  const activeDownloads = useMemo(
    () =>
      downloadQueue.filter(
        (t) =>
          t.status === 'downloading' ||
          t.status === 'extracting' ||
          t.status === 'verifying' ||
          t.status === 'queued'
      ),
    [downloadQueue]
  );

  const avgDownloadProgress = useMemo(() => {
    if (activeDownloads.length === 0) return 0;
    const sum = activeDownloads.reduce((acc, t) => acc + (t.progressPercent || 0), 0);
    return Math.round(sum / activeDownloads.length);
  }, [activeDownloads]);

  // Close menus on window blur so switching OS windows never leaves stale menus open
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const handleWindowBlur = () => {
      setOpenMenu(null);
      setIsMenuOpen(false);
    };
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, []);

  // Close burger menu or top window menu on outside click or escape
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
      if (topMenuBarRef.current && !topMenuBarRef.current.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (typeof document !== 'undefined' && document.querySelector('dialog[open]')) {
          return;
        }
        if (openMenu !== null) {
          const triggerToFocus = topMenuTriggerRefs.current[openMenu];
          setOpenMenu(null);
          triggerToFocus?.focus?.({ preventScroll: true });
        }
        if (isMenuOpen) {
          setIsMenuOpen(false);
          burgerTriggerRef.current?.focus?.({ preventScroll: true });
        }
      }
    }
    if (typeof document !== 'undefined' && (isMenuOpen || openMenu !== null)) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('mousedown', handleClickOutside);
        document.removeEventListener('keydown', handleKeyDown);
      }
    };
  }, [isMenuOpen, openMenu]);

  const scheduleFocusInMenuContainer = (
    getContainer: () => HTMLElement | null,
    target: 'first' | 'last'
  ) => {
    const run = () => {
      const container = getContainer();
      if (!container) return;
      const items = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          'button[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])'
        )
      );
      if (items.length === 0) return;
      const item = target === 'first' ? items[0] : items[items.length - 1];
      item?.focus?.({ preventScroll: true });
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  };

  const moveToAdjacentTopMenu = (currentIndex: number, direction: 1 | -1, keepOpen: boolean) => {
    const nextIdx = (currentIndex + direction + TOP_MENU_ORDER.length) % TOP_MENU_ORDER.length;
    const nextMenuId = TOP_MENU_ORDER[nextIdx];
    setActiveMenuBarIndex(nextIdx);
    if (keepOpen) {
      setOpenMenu(nextMenuId);
    }
    topMenuTriggerRefs.current[nextMenuId]?.focus?.({ preventScroll: true });
  };

  const handleTopMenuTriggerKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    menuId: TopMenuId,
    menuIdx: number
  ) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      moveToAdjacentTopMenu(menuIdx, 1, openMenu !== null);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      moveToAdjacentTopMenu(menuIdx, -1, openMenu !== null);
    } else if (event.key === 'ArrowDown' || event.key === 'Home') {
      event.preventDefault();
      setActiveMenuBarIndex(menuIdx);
      setOpenMenu(menuId);
      scheduleFocusInMenuContainer(() => topMenuDropdownRefs.current[menuId], 'first');
    } else if (event.key === 'ArrowUp' || event.key === 'End') {
      event.preventDefault();
      setActiveMenuBarIndex(menuIdx);
      setOpenMenu(menuId);
      scheduleFocusInMenuContainer(() => topMenuDropdownRefs.current[menuId], 'last');
    } else if (event.key === 'Escape' && openMenu !== null) {
      event.preventDefault();
      event.stopPropagation();
      setOpenMenu(null);
      topMenuTriggerRefs.current[menuId]?.focus?.({ preventScroll: true });
    } else if (event.key === 'Tab') {
      setOpenMenu(null);
    }
  };

  const handleMenuContainerArrowKeys = (
    event: React.KeyboardEvent<HTMLDivElement>,
    options?: MenuKeyboardNavOptions
  ) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      options?.onEscape?.();
      return;
    }
    if (event.key === 'Tab') {
      options?.onTabOut?.();
      return;
    }
    if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && options?.onArrowHorizontal) {
      event.preventDefault();
      options.onArrowHorizontal(event.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (
      typeof HTMLElement !== 'undefined' &&
      'focusGroup' in HTMLElement.prototype &&
      typeof event.currentTarget?.hasAttribute === 'function' &&
      event.currentTarget.hasAttribute('focusgroup')
    ) {
      return;
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        'button[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])'
      )
    );
    if (items.length === 0) return;
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    const currentIdx = items.indexOf(activeEl as HTMLButtonElement);
    const nextIdx =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : currentIdx < 0
            ? event.key === 'ArrowUp'
              ? items.length - 1
              : 0
            : (currentIdx + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    event.preventDefault();
    items[nextIdx]?.focus?.({ preventScroll: true });
  };

  const runMenuAction = (action: WindowMenuAction) => {
    setOpenMenu(null);
    window.electronAPI?.performMenuAction?.(action);
  };

  const handleOpenDownloadsDrawer = () => {
    if (onOpenDownloads) {
      onOpenDownloads();
    } else {
      launcherService.openDownloadDrawer();
    }
  };

  const handleOpenSettings = () => {
    setOpenMenu(null);
    setIsMenuOpen(false);
    if (onOpenSettings) {
      onOpenSettings();
    } else if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('antigravity:open-settings'));
    }
  };

  // Set of connected storefront IDs — explicitly honor empty `[]` (zero connected stores!)
  const connectedSet = useMemo(() => {
    if (connectedStorefronts !== undefined) {
      return new Set<StorefrontId>(connectedStorefronts);
    }
    try {
      const integrations = loadIntegrations();
      return new Set<StorefrontId>(
        integrations.filter((i) => i.isConnected).map((i) => i.storefrontId)
      );
    } catch {
      return new Set<StorefrontId>(['steam', 'gog', 'epic', 'xbox']);
    }
  }, [connectedStorefronts]);

  // Set of storefronts with cataloged games in user's library
  const storesInLibrary = useMemo(() => {
    if (presentStorefronts) {
      return new Set<StorefrontId>(presentStorefronts);
    }
    const set = new Set<StorefrontId>();
    if (games) {
      for (const g of games) {
        for (const p of g.platforms) {
          set.add(p.platformId);
        }
      }
    }
    return set;
  }, [presentStorefronts, games]);

  // Display 'all' and storefronts that are either connected OR present in library
  const visiblePlatforms: (StorefrontId | 'all')[] = useMemo(() => {
    return [
      'all',
      ...ALL_NAV_PLATFORMS.filter((p) => connectedSet.has(p) || storesInLibrary.has(p)),
    ];
  }, [connectedSet, storesInLibrary]);

  return useMemo(
    () => (
      <header
        className="app-drag-region sticky top-0 z-40 bg-[#171a21] border-b border-steam-border shadow-md select-none"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {isWindowsOrLinuxWindow &&
          renderWindowMenuBar({
            topMenuBarRef,
            topMenuTriggerRefs,
            topMenuDropdownRefs,
            openMenu,
            setOpenMenu,
            activeMenuBarIndex,
            setActiveMenuBarIndex,
            isMaximized,
            setIsMaximized,
            installedOnly,
            systemSetupAlertCount,
            handleTopMenuTriggerKeyDown,
            handleMenuContainerArrowKeys,
            moveToAdjacentTopMenu,
            runMenuAction,
            handleOpenSettings,
            handleOpenDownloadsDrawer,
            onOpenIntegrations,
            onOpenSystemSetup,
            onOpenLibraryMatchManager,
            onTriggerSync,
            onToggleInstalledOnly,
          })}

        <div
          data-mac-traffic-inset={needsTrafficLightInset ? 'true' : 'false'}
          className={`w-full pr-4 ${
            needsTrafficLightInset ? 'pl-[88px]' : 'pl-4'
          } py-2.5 flex items-center justify-between gap-3`}
        >
          {/* Left Section: Burger Menu + History Navigation */}
          <div
            className="app-no-drag flex items-center gap-2.5 shrink-0"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {renderBurgerMenu({
              menuRef,
              burgerTriggerRef,
              burgerMenuDropdownRef,
              isMenuOpen,
              setIsMenuOpen,
              setIsAboutModalOpen,
              hostCapabilities,
              appVersion,
              updateStatus,
              updateInfo,
              systemSetupAlertCount,
              isSyncing,
              isSyncingAllMedia,
              isSyncingCurrentGame,
              isSyncingScores,
              isSyncingTrophies,
              currentGameTitle,
              canSyncCurrentGame,
              scheduleFocusInMenuContainer,
              handleMenuContainerArrowKeys,
              handleOpenSettings,
              handleCheckForUpdates,
              onOpenIntegrations,
              onOpenLibraryMatchManager,
              onOpenSystemSetup,
              onTriggerSync,
              onSyncAllMedia,
              onSyncTrophies,
              onRefreshScores,
              onOpenFixMatch,
              onSyncCurrentGame,
              onOpenAchievements,
            })}

            {/* History Navigation: Back & Forward Controls */}
            <div className="flex items-center bg-[#10141a] p-0.5 rounded border border-steam-border/80 shadow-inner">
              <button
                type="button"
                onClick={onGoBack}
                disabled={!canGoBack}
                className={`min-w-6 min-h-6 p-1.5 rounded transition-all flex items-center justify-center ${
                  canGoBack
                    ? 'text-white hover:text-steam-accent hover:bg-steam-card active:scale-95 cursor-pointer shadow-sm'
                    : 'text-zinc-600 cursor-not-allowed opacity-35'
                }`}
                title={canGoBack ? `Back to ${backTitle || 'previous page'} (Alt + ←)` : 'Back'}
                aria-label="Back"
              >
                <ChevronLeft className="w-4 h-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={onGoForward}
                disabled={!canGoForward}
                className={`min-w-6 min-h-6 p-1.5 rounded transition-all flex items-center justify-center ${
                  canGoForward
                    ? 'text-white hover:text-steam-accent hover:bg-steam-card active:scale-95 cursor-pointer shadow-sm'
                    : 'text-zinc-600 cursor-not-allowed opacity-35'
                }`}
                title={
                  canGoForward ? `Forward to ${forwardTitle || 'next page'} (Alt + →)` : 'Forward'
                }
                aria-label="Forward"
              >
                <ChevronRight className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Center Section: Merged Storefront Filter Pills (<nav aria-label="Primary">) */}
          {renderPrimaryNavPills({
            visiblePlatforms,
            selectedPlatform,
            connectedSet,
            onSelectPlatform,
          })}

          {/* Right Section: Downloads, Installed Only Filter & Games Counter */}
          <div
            className="app-no-drag flex items-center gap-2.5 text-xs shrink-0"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <button
              type="button"
              onClick={handleOpenDownloadsDrawer}
              aria-label="Downloads"
              title="Open Downloads & Installations Manager"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              className={`app-no-drag relative overflow-hidden px-2.5 py-1 text-xs rounded border transition-colors flex items-center gap-1.5 cursor-pointer ${
                activeDownloads.length > 0
                  ? 'bg-sky-950/80 border-sky-400/70 text-sky-300 font-semibold shadow-[0_0_10px_rgba(56,189,248,0.2)]'
                  : 'bg-steam-card border-steam-border text-steam-subtext hover:text-white'
              }`}
            >
              {activeDownloads.length > 0 && (
                <div
                  className="absolute inset-y-0 left-0 bg-sky-500/20 pointer-events-none transition-all duration-300"
                  style={{ width: `${avgDownloadProgress}%` }}
                />
              )}
              <Download
                aria-hidden="true"
                className={`w-3.5 h-3.5 relative z-10 ${
                  activeDownloads.length > 0 ? 'text-sky-400 animate-bounce' : ''
                }`}
              />
              <span className="relative z-10">Downloads</span>
              {activeDownloads.length > 0 && (
                <span className="relative z-10 px-1.5 py-0.2 rounded-full bg-sky-500/30 border border-sky-400/50 text-[10px] font-bold text-white">
                  {activeDownloads.length} • {avgDownloadProgress}%
                </span>
              )}
            </button>

            <button
              type="button"
              aria-pressed={installedOnly}
              onClick={onToggleInstalledOnly}
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              className={`app-no-drag px-2.5 py-1 text-xs rounded border transition-colors flex items-center gap-1.5 cursor-pointer ${
                installedOnly
                  ? 'bg-emerald-950/70 border-emerald-500/70 text-emerald-400 font-semibold'
                  : 'bg-steam-card border-steam-border text-steam-subtext hover:text-white'
              }`}
            >
              <span
                aria-hidden="true"
                className={`w-2 h-2 rounded-full ${installedOnly ? 'bg-emerald-400' : 'bg-zinc-600'}`}
              />
              Installed Only
            </button>

            <span className="text-steam-subtext flex items-center gap-1">
              <Layers className="w-3.5 h-3.5 text-steam-accent" aria-hidden="true" />
              <strong className="text-white">{filteredCount}</strong> / {totalGamesCount} Games
            </span>
          </div>
        </div>

        {renderAboutModal({
          isOpen: isAboutModalOpen,
          onClose: () => setIsAboutModalOpen(false),
          appVersion,
        })}
      </header>
    ),
    [
      selectedPlatform,
      onSelectPlatform,
      installedOnly,
      onToggleInstalledOnly,
      totalGamesCount,
      filteredCount,
      isSyncing,
      onTriggerSync,
      onOpenIntegrations,
      canGoBack,
      onGoBack,
      backTitle,
      canGoForward,
      onGoForward,
      forwardTitle,
      connectedStorefronts,
      presentStorefronts,
      games,
      currentGameTitle,
      canSyncCurrentGame,
      isSyncingCurrentGame,
      onSyncCurrentGame,
      isSyncingAllMedia,
      onSyncAllMedia,
      isSyncingScores,
      onRefreshScores,
      isSyncingTrophies,
      onSyncTrophies,
      onOpenFixMatch,
      onOpenLibraryMatchManager,
      onOpenSystemSetup,
      onOpenSettings,
      systemSetupAlertCount,
      onOpenAchievements,
      onOpenDownloads,
      isMenuOpen,
      isFullScreen,
      isMaximized,
      openMenu,
      activeMenuBarIndex,
      activeDownloads,
      avgDownloadProgress,
      appVersion,
      updateStatus,
      updateInfo,
      isAboutModalOpen,
      needsTrafficLightInset,
      isWindowsOrLinuxWindow,
      visiblePlatforms,
    ]
  );
};

export const MemoizedTopNavBar = React.memo(TopNavBar);
