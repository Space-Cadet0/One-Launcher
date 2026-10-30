import React, { useState, useRef, useEffect, useMemo } from 'react';
import { StorefrontId, STOREFRONT_REGISTRY } from '../../contracts/platform';
import { loadIntegrations } from '../../services/integrations/integrationStorage';
import { CanonicalGame } from '../../contracts/game';
import { launcherService } from '../../services/launcher/launcherService';
import { environmentSetupService } from '../../services/launcher/environmentSetupService';
import type { AppUpdateCheckResult, WindowMenuAction } from '../../types/electron';
import { ModalShell } from '../Common/ModalShell';
import {
  RefreshCw,
  Layers,
  Cloud,
  ChevronLeft,
  ChevronRight,
  Menu,
  Film,
  Wand,
  Trophy,
  Award,
  Download,
  Sliders,
  ShieldCheck,
  Minus,
  X,
  Info,
} from 'lucide-react';

type TopMenuId = 'file' | 'edit' | 'view' | 'window';

interface TopNavBarProps {
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  selectedPlatform: StorefrontId | 'all';
  onSelectPlatform: (platform: StorefrontId | 'all') => void;
  installedOnly: boolean;
  onToggleInstalledOnly: () => void;
  totalGamesCount: number;
  filteredCount: number;
  isSyncing: boolean;
  onTriggerSync: () => void;
  onHomeClick: () => void;
  onOpenIntegrations: () => void;
  canGoBack?: boolean;
  onGoBack?: () => void;
  backTitle?: string | null;
  canGoForward?: boolean;
  onGoForward?: () => void;
  forwardTitle?: string | null;
  connectedStorefronts?: StorefrontId[];
  games?: CanonicalGame[];
  currentGameTitle?: string;
  canSyncCurrentGame?: boolean;
  isSyncingCurrentGame?: boolean;
  onSyncCurrentGame?: () => void;
  isSyncingAllMedia?: boolean;
  onSyncAllMedia?: () => void;
  isSyncingScores?: boolean;
  onRefreshScores?: () => void;
  isSyncingTrophies?: boolean;
  onSyncTrophies?: () => void;
  onOpenFixMatch?: () => void;
  onOpenLibraryMatchManager?: () => void;
  onOpenSystemSetup?: () => void;
  systemSetupAlertCount?: number;
  defaultMenuOpen?: boolean;
  onOpenAchievements?: () => void;
  onOpenDownloads?: () => void;
}

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
  systemSetupAlertCount,
  defaultMenuOpen = false,
  onOpenAchievements,
  onOpenDownloads,
}) => {
  const [isMenuOpen, setIsMenuOpen] = useState(defaultMenuOpen);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [openMenu, setOpenMenu] = useState<TopMenuId | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const topMenuBarRef = useRef<HTMLDivElement | null>(null);
  const [downloadQueue, setDownloadQueue] = useState(() => launcherService.getDownloadQueue());
  const [appVersion, setAppVersion] = useState<string>('0.2.0');
  const [updateStatus, setUpdateStatus] = useState<
    'idle' | 'checking' | 'up-to-date' | 'update-available'
  >('idle');
  const [updateInfo, setUpdateInfo] = useState<AppUpdateCheckResult | null>(null);
  const [isAboutModalOpen, setIsAboutModalOpen] = useState(false);

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (typeof api?.getAppVersion === 'function') {
      api
        .getAppVersion()
        .then((ver: string) => {
          if (ver && typeof ver === 'string' && ver.trim()) {
            setAppVersion(ver.trim());
          }
        })
        .catch(() => {});
    }
    if (typeof api?.checkForAppUpdates === 'function') {
      api
        .checkForAppUpdates()
        .then((res: AppUpdateCheckResult) => {
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
    if (typeof api.isWindowMaximized === 'function') {
      api
        .isWindowMaximized()
        .then((val: boolean) => setIsMaximized(Boolean(val)))
        .catch(() => {});
    }
    if (typeof api.onMaximizedChanged === 'function') {
      return api.onMaximizedChanged((val: boolean) => setIsMaximized(Boolean(val)));
    }
  }, []);

  const electronPlatform = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined;
  const isMacWindow =
    typeof window !== 'undefined' &&
    (electronPlatform
      ? electronPlatform === 'darwin'
      : Boolean(window.electronAPI?.isElectron) &&
        /Mac|Darwin/i.test(navigator.platform || navigator.userAgent || ''));
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
        setIsMenuOpen(false);
        setOpenMenu(null);
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

  // All known storefront IDs in canonical order
  const allPlatforms: StorefrontId[] = [
    'steam',
    'gog',
    'epic',
    'xbox',
    'amazon',
    'ubisoft',
    'ea',
    'bnet',
    'itch',
  ];

  // Set of connected storefront IDs
  const connectedSet = useMemo(() => {
    if (connectedStorefronts && connectedStorefronts.length > 0) {
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
    const set = new Set<StorefrontId>();
    if (games) {
      for (const g of games) {
        for (const p of g.platforms) {
          set.add(p.platformId);
        }
      }
    }
    return set;
  }, [games]);

  // Display 'all' and storefronts that are either connected OR present in library
  const visiblePlatforms: (StorefrontId | 'all')[] = useMemo(() => {
    return [
      'all',
      ...allPlatforms.filter((p) => connectedSet.has(p) || storesInLibrary.has(p)),
    ];
  }, [connectedSet, storesInLibrary]);

  return useMemo(
    () => (
    <header
      className="app-drag-region sticky top-0 z-40 bg-[#171a21] border-b border-steam-border shadow-md select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {isWindowsOrLinuxWindow && (
        <div
          data-testid="steam-integrated-window-bar"
          className="bg-[#10151d] border-b border-[#1f2937]/80 h-8 flex items-center justify-between select-none relative z-50"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          {/* Left Side: Brand Icon + Title + Steam-Style Menu Bar */}
          <div
            ref={topMenuBarRef}
            className="app-no-drag flex items-center h-full pl-2.5 gap-0.5"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <img
              src="./favicon-32x32.png"
              alt=""
              className="w-3.5 h-3.5 rounded-sm mr-1.5 pointer-events-none"
            />
            <span className="text-[11px] font-bold tracking-wide text-[#66c0f4] mr-2">
              One Launcher
            </span>

            {/* File Menu */}
            <div className="relative">
              <button
                type="button"
                data-testid="win-menu-file"
                aria-haspopup="menu"
                aria-expanded={openMenu === 'file'}
                onClick={() => setOpenMenu(openMenu === 'file' ? null : 'file')}
                onMouseEnter={() => {
                  if (openMenu !== null && openMenu !== 'file') setOpenMenu('file');
                }}
                className={`min-h-6 px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                  openMenu === 'file'
                    ? 'bg-[#253447] text-white'
                    : 'text-steam-subtext hover:text-white hover:bg-white/5'
                }`}
              >
                File
              </button>
              {openMenu === 'file' && (
                <div
                  role="menu"
                  aria-label="File"
                  data-testid="win-menu-dropdown-file"
                  className="bg-[#16202d] border border-[#2a475e] shadow-2xl rounded-md py-1.5 min-w-[230px] absolute top-full left-0 mt-0.5 z-50"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenMenu(null);
                      onOpenIntegrations();
                    }}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Accounts &amp; Storefronts...</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenMenu(null);
                      if (onOpenSystemSetup) {
                        onOpenSystemSetup();
                      } else {
                        environmentSetupService.openWizard({ mode: 'health_check' });
                      }
                    }}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>
                      Setup Wizard...
                      {(systemSetupAlertCount || 0) > 0 && (
                        <span className="sr-only">{` (${systemSetupAlertCount} setup ${systemSetupAlertCount === 1 ? 'alert' : 'alerts'})`}</span>
                      )}
                    </span>
                    {(systemSetupAlertCount || 0) > 0 && (
                      <span
                        className="w-2 h-2 rounded-full bg-amber-400 shrink-0 ml-2"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenMenu(null);
                      onOpenLibraryMatchManager?.();
                    }}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Library Match &amp; Overrides Studio...</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenMenu(null);
                      onTriggerSync();
                    }}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Sync All Integrations</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenMenu(null);
                      handleOpenDownloadsDrawer();
                    }}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Downloads Manager</span>
                  </button>
                  <div role="separator" className="border-t border-steam-border/50 my-1" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runMenuAction('quit')}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Exit One Launcher</span>
                    <span className="text-[10px] text-steam-subtext font-mono ml-4">Alt+F4</span>
                  </button>
                </div>
              )}
            </div>

            {/* Edit Menu */}
            <div className="relative">
              <button
                type="button"
                data-testid="win-menu-edit"
                aria-haspopup="menu"
                aria-expanded={openMenu === 'edit'}
                onClick={() => setOpenMenu(openMenu === 'edit' ? null : 'edit')}
                onMouseEnter={() => {
                  if (openMenu !== null && openMenu !== 'edit') setOpenMenu('edit');
                }}
                className={`min-h-6 px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                  openMenu === 'edit'
                    ? 'bg-[#253447] text-white'
                    : 'text-steam-subtext hover:text-white hover:bg-white/5'
                }`}
              >
                Edit
              </button>
              {openMenu === 'edit' && (
                <div
                  role="menu"
                  aria-label="Edit"
                  data-testid="win-menu-dropdown-edit"
                  className="bg-[#16202d] border border-[#2a475e] shadow-2xl rounded-md py-1.5 min-w-[230px] absolute top-full left-0 mt-0.5 z-50"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runMenuAction('undo')}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Undo</span>
                    <span className="text-[10px] text-steam-subtext font-mono ml-4">Ctrl+Z</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runMenuAction('redo')}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Redo</span>
                    <span className="text-[10px] text-steam-subtext font-mono ml-4">Ctrl+Y</span>
                  </button>
                  <div role="separator" className="border-t border-steam-border/50 my-1" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runMenuAction('cut')}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Cut</span>
                    <span className="text-[10px] text-steam-subtext font-mono ml-4">Ctrl+X</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runMenuAction('copy')}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Copy</span>
                    <span className="text-[10px] text-steam-subtext font-mono ml-4">Ctrl+C</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runMenuAction('paste')}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Paste</span>
                    <span className="text-[10px] text-steam-subtext font-mono ml-4">Ctrl+V</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runMenuAction('select-all')}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Select All</span>
                    <span className="text-[10px] text-steam-subtext font-mono ml-4">Ctrl+A</span>
                  </button>
                </div>
              )}
            </div>

            {/* View Menu */}
            <div className="relative">
              <button
                type="button"
                data-testid="win-menu-view"
                aria-haspopup="menu"
                aria-expanded={openMenu === 'view'}
                onClick={() => setOpenMenu(openMenu === 'view' ? null : 'view')}
                onMouseEnter={() => {
                  if (openMenu !== null && openMenu !== 'view') setOpenMenu('view');
                }}
                className={`min-h-6 px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                  openMenu === 'view'
                    ? 'bg-[#253447] text-white'
                    : 'text-steam-subtext hover:text-white hover:bg-white/5'
                }`}
              >
                View
              </button>
              {openMenu === 'view' && (
                <div
                  role="menu"
                  aria-label="View"
                  data-testid="win-menu-dropdown-view"
                  className="bg-[#16202d] border border-[#2a475e] shadow-2xl rounded-md py-1.5 min-w-[230px] absolute top-full left-0 mt-0.5 z-50"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runMenuAction('reload')}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Reload</span>
                    <span className="text-[10px] text-steam-subtext font-mono ml-4">Ctrl+R</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runMenuAction('force-reload')}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Force Reload</span>
                    <span className="text-[10px] text-steam-subtext font-mono ml-4">
                      Ctrl+Shift+R
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runMenuAction('toggle-devtools')}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Toggle Developer Tools</span>
                    <span className="text-[10px] text-steam-subtext font-mono ml-4">
                      Ctrl+Shift+I
                    </span>
                  </button>
                  <div role="separator" className="border-t border-steam-border/50 my-1" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runMenuAction('reset-zoom')}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Actual Size</span>
                    <span className="text-[10px] text-steam-subtext font-mono ml-4">Ctrl+0</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runMenuAction('zoom-in')}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Zoom In</span>
                    <span className="text-[10px] text-steam-subtext font-mono ml-4">Ctrl++</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runMenuAction('zoom-out')}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Zoom Out</span>
                    <span className="text-[10px] text-steam-subtext font-mono ml-4">Ctrl+-</span>
                  </button>
                  <div role="separator" className="border-t border-steam-border/50 my-1" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => runMenuAction('toggle-fullscreen')}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Toggle Full Screen</span>
                    <span className="text-[10px] text-steam-subtext font-mono ml-4">F11</span>
                  </button>
                </div>
              )}
            </div>

            {/* Window Menu */}
            <div className="relative">
              <button
                type="button"
                data-testid="win-menu-window"
                aria-haspopup="menu"
                aria-expanded={openMenu === 'window'}
                onClick={() => setOpenMenu(openMenu === 'window' ? null : 'window')}
                onMouseEnter={() => {
                  if (openMenu !== null && openMenu !== 'window') setOpenMenu('window');
                }}
                className={`min-h-6 px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                  openMenu === 'window'
                    ? 'bg-[#253447] text-white'
                    : 'text-steam-subtext hover:text-white hover:bg-white/5'
                }`}
              >
                Window
              </button>
              {openMenu === 'window' && (
                <div
                  role="menu"
                  aria-label="Window"
                  data-testid="win-menu-dropdown-window"
                  className="bg-[#16202d] border border-[#2a475e] shadow-2xl rounded-md py-1.5 min-w-[230px] absolute top-full left-0 mt-0.5 z-50"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenMenu(null);
                      window.electronAPI?.minimizeWindow?.();
                    }}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Minimize</span>
                    <span className="text-[10px] text-steam-subtext font-mono ml-4">Ctrl+M</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenMenu(null);
                      window.electronAPI
                        ?.toggleMaximizeWindow?.()
                        .then((val) => {
                          if (typeof val === 'boolean') setIsMaximized(val);
                        })
                        .catch(() => {});
                    }}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Maximize / Restore</span>
                  </button>
                  <div role="separator" className="border-t border-steam-border/50 my-1" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenMenu(null);
                      onToggleInstalledOnly();
                    }}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Installed Games Only</span>
                    {installedOnly && (
                      <span className="text-xs font-bold text-emerald-400 ml-4">✓</span>
                    )}
                  </button>
                  <div role="separator" className="border-t border-steam-border/50 my-1" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenMenu(null);
                      window.electronAPI?.closeWindow?.();
                    }}
                    className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                  >
                    <span>Close Window</span>
                    <span className="text-[10px] text-steam-subtext font-mono ml-4">Alt+F4</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Right Side: Integrated Steam Window Control Buttons */}
          <div
            className="app-no-drag flex items-center h-full"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <button
              type="button"
              data-testid="win-btn-minimize"
              title="Minimize"
              aria-label="Minimize"
              onClick={() => window.electronAPI?.minimizeWindow?.()}
              className="h-full w-11 flex items-center justify-center text-steam-subtext hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              data-testid="win-btn-maximize"
              title={isMaximized ? 'Restore Down' : 'Maximize'}
              aria-label={isMaximized ? 'Restore Down' : 'Maximize'}
              onClick={() => {
                window.electronAPI
                  ?.toggleMaximizeWindow?.()
                  .then((val) => {
                    if (typeof val === 'boolean') setIsMaximized(val);
                  })
                  .catch(() => {});
              }}
              className="h-full w-11 flex items-center justify-center text-steam-subtext hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              {isMaximized ? (
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                >
                  <path d="M2.5 2.5V1h6.5v6.5H7.5" />
                  <rect x="1" y="2.5" width="6.5" height="6.5" />
                </svg>
              ) : (
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                >
                  <rect x="1" y="1" width="8" height="8" />
                </svg>
              )}
            </button>
            <button
              type="button"
              data-testid="win-btn-close"
              title="Close"
              aria-label="Close"
              onClick={() => window.electronAPI?.closeWindow?.()}
              className="h-full w-11 flex items-center justify-center text-steam-subtext hover:text-white hover:bg-[#e81123] transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

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
          {/* Burger Menu Button with Dropdown */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setIsMenuOpen((prev) => !prev)}
              className={`app-no-drag min-w-6 min-h-6 p-2 rounded transition-all flex items-center justify-center border shadow-sm cursor-pointer ${
                isMenuOpen
                  ? 'bg-steam-accent text-black border-steam-accent shadow-[0_0_12px_rgba(102,192,244,0.4)]'
                  : 'bg-[#10141a] text-steam-text hover:text-white hover:bg-[#1a222d] border-steam-border/80'
              }`}
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              title="Menu (Accounts, Sync All)"
              aria-label="Menu"
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
            >
              <Menu className="w-4 h-4" />
              {(isSyncing || isSyncingAllMedia || isSyncingCurrentGame || isSyncingScores || isSyncingTrophies) && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              )}
            </button>

            {/* Burger Dropdown Menu */}
            {isMenuOpen && (
              <div
                role="menu"
                aria-label="Application menu"
                className="app-no-drag absolute left-0 top-full mt-2 w-64 rounded-md bg-[#16202d] border border-steam-border shadow-2xl z-50 py-1.5 animate-in fade-in zoom-in-95 duration-150"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              >
                {/* Brand Header */}
                <div className="px-3.5 py-1.5 border-b border-steam-border/60 mb-1 flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <img
                      src="./favicon-32x32.png"
                      alt="One Launcher"
                      className="w-4 h-4 rounded-sm object-contain shrink-0"
                    />
                    <span className="text-[11px] font-bold uppercase tracking-wider text-steam-accent">
                      One Launcher
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {updateInfo?.hasUpdate && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                        Update
                      </span>
                    )}
                    <span
                      data-testid="menu-app-version"
                      className="text-[10px] text-steam-subtext font-mono"
                    >
                      v{appVersion}
                    </span>
                  </div>
                </div>

                {/* Group 1: Accounts & Library Management */}
                <div role="presentation" className="px-3.5 pt-1 pb-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-300">
                  Accounts &amp; Library
                </div>

                {/* 1. Accounts */}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsMenuOpen(false);
                    onOpenIntegrations();
                  }}
                  className="min-h-6 w-full flex items-center justify-between px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer group"
                >
                  <div className="flex items-center gap-2.5">
                    <Cloud className="w-4 h-4 text-sky-400 group-hover:scale-110 transition-transform" />
                    <div className="flex flex-col">
                      <span className="font-semibold text-white">Accounts</span>
                      <span className="text-[10px] text-steam-subtext">Connected storefronts</span>
                    </div>
                  </div>
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
                </button>

                {/* 2. Library Match & Overrides Studio */}
                {onOpenLibraryMatchManager && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsMenuOpen(false);
                      onOpenLibraryMatchManager();
                    }}
                    className="min-h-6 w-full flex items-center justify-between px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer group"
                    title="Inspect unmatched games, restore suppressed storefront entries, manage manual overrides, and audit multi-storefront merges"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Sliders className="w-4 h-4 shrink-0 text-[#66c0f4] group-hover:scale-110 transition-transform" />
                      <div className="flex flex-col min-w-0">
                        <span className="font-semibold text-white truncate">
                          Library Match &amp; Overrides Studio
                        </span>
                        <span className="text-[10px] text-steam-subtext truncate">
                          Unmatched, suppressed &amp; merged games
                        </span>
                      </div>
                    </div>
                  </button>
                )}

                {/* 2b. Setup Wizard */}
                <button
                  type="button"
                  role="menuitem"
                  data-testid="menu-system-setup-health"
                  onClick={() => {
                    setIsMenuOpen(false);
                    if (onOpenSystemSetup) {
                      onOpenSystemSetup();
                    } else {
                      environmentSetupService.openWizard({ mode: 'health_check' });
                    }
                  }}
                  className="min-h-6 w-full flex items-center justify-between px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer group"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <ShieldCheck
                      className="w-4 h-4 shrink-0 text-emerald-400 group-hover:scale-110 transition-transform"
                      aria-hidden="true"
                    />
                    <div className="flex flex-col min-w-0">
                      <span className="font-semibold text-white truncate">
                        Setup Wizard
                        {(systemSetupAlertCount || 0) > 0 && (
                          <span className="sr-only">{` (${systemSetupAlertCount} setup ${systemSetupAlertCount === 1 ? 'alert' : 'alerts'})`}</span>
                        )}
                      </span>
                      <span className="text-[10px] text-steam-subtext truncate">
                        {launcherService.getHostPlatform() === 'darwin'
                          ? 'Accounts, Windows on Mac & launchers'
                          : 'Accounts & game launchers'}
                      </span>
                    </div>
                  </div>
                  {(systemSetupAlertCount || 0) > 0 && (
                    <span
                      data-testid="menu-system-setup-alert-dot"
                      aria-hidden="true"
                      className="w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.85)] shrink-0"
                    />
                  )}
                </button>

                {/* Group 2: Library Sync & Refresh */}
                <div role="presentation" className="mt-1 pt-1.5 border-t border-steam-border/50">
                  <div className="px-3.5 pb-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-300">
                    Library Sync &amp; Refresh
                  </div>

                  {/* 3. Sync Integrations */}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsMenuOpen(false);
                      onTriggerSync();
                    }}
                    disabled={isSyncing}
                    className="min-h-6 w-full flex items-center justify-between px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer disabled:opacity-50 group"
                    title="Sync all connected accounts (owned games, trophies & achievements, playtime)"
                  >
                    <div className="flex items-center gap-2.5">
                      <RefreshCw
                        className={`w-4 h-4 ${
                          isSyncing
                            ? 'animate-spin text-steam-accent'
                            : 'text-emerald-400 group-hover:rotate-45 transition-transform'
                        }`}
                      />
                      <div className="flex flex-col">
                        <span className="font-semibold text-white">
                          {isSyncing ? 'Syncing...' : 'Sync Integrations'}
                        </span>
                        <span className="text-[10px] text-steam-subtext">Games, trophies &amp; playtime</span>
                      </div>
                    </div>
                    {isSyncing && (
                      <span className="text-[10px] text-steam-accent font-semibold">Active</span>
                    )}
                  </button>

                  {/* 4. Sync Store Media (All Games) */}
                  {onSyncAllMedia && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setIsMenuOpen(false);
                        onSyncAllMedia();
                      }}
                      disabled={isSyncingAllMedia}
                      className="min-h-6 w-full flex items-center justify-between px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer disabled:opacity-50 group"
                      title="Sync trailers, high-res screenshots, movies & store descriptions from Steam across your library"
                    >
                      <div className="flex items-center gap-2.5">
                        <Film
                          className={`w-4 h-4 ${
                            isSyncingAllMedia
                              ? 'animate-spin text-steam-accent'
                              : 'text-purple-400 group-hover:scale-110 transition-transform'
                          }`}
                        />
                        <div className="flex flex-col">
                          <span className="font-semibold text-white">
                            {isSyncingAllMedia ? 'Syncing Media...' : 'Sync Store Media (All Games)'}
                          </span>
                          <span className="text-[10px] text-steam-subtext">Trailers, screenshots &amp; descriptions</span>
                        </div>
                      </div>
                      {isSyncingAllMedia && (
                        <span className="text-[10px] text-steam-accent font-semibold">Active</span>
                      )}
                    </button>
                  )}

                  {/* 5. Sync Trophies (All Storefronts) */}
                  {onSyncTrophies && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setIsMenuOpen(false);
                        onSyncTrophies();
                      }}
                      disabled={isSyncingTrophies}
                      className="min-h-6 w-full flex items-center justify-between px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer disabled:opacity-50 group"
                      title="Synchronize unlocked trophies & achievements across Steam, GOG.com, Epic Games Store, and Xbox Live"
                    >
                      <div className="flex items-center gap-2.5">
                        <Trophy
                          className={`w-4 h-4 ${
                            isSyncingTrophies
                              ? 'animate-bounce text-amber-400'
                              : 'text-amber-400 group-hover:scale-110 transition-transform'
                          }`}
                        />
                        <div className="flex flex-col">
                          <span className="font-semibold text-white">
                            {isSyncingTrophies ? 'Syncing Trophies...' : 'Sync Trophies'}
                          </span>
                          <span className="text-[10px] text-steam-subtext">Steam, GOG, Epic &amp; Xbox</span>
                        </div>
                      </div>
                      {isSyncingTrophies && (
                        <span className="text-[10px] text-steam-accent font-semibold">Active</span>
                      )}
                    </button>
                  )}

                  {/* 6. Refresh Critic Scores */}
                  {onRefreshScores && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setIsMenuOpen(false);
                        onRefreshScores();
                      }}
                      disabled={isSyncingScores}
                      className="min-h-6 w-full flex items-center justify-between px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer disabled:opacity-50 group"
                      title="Refresh and sync ratings from Metacritic, OpenCritic, and Steam across all games"
                    >
                      <div className="flex items-center gap-2.5">
                        <Award
                          className={`w-4 h-4 ${
                            isSyncingScores
                              ? 'animate-spin text-steam-accent'
                              : 'text-amber-400 group-hover:scale-110 transition-transform'
                          }`}
                        />
                        <div className="flex flex-col">
                          <span className="font-semibold text-white">
                            {isSyncingScores ? 'Syncing Scores...' : 'Refresh Critic Scores'}
                          </span>
                          <span className="text-[10px] text-steam-subtext">Metacritic, OpenCritic &amp; Steam</span>
                        </div>
                      </div>
                      {isSyncingScores && (
                        <span className="text-[10px] text-steam-accent font-semibold">Active</span>
                      )}
                    </button>
                  )}
                </div>

                {/* Group 3: Current Game (Visible when viewing an individual game) */}
                {(currentGameTitle || (canSyncCurrentGame && onSyncCurrentGame)) && (
                  <div role="presentation" className="mt-1 pt-1.5 border-t border-steam-border/50">
                    <div className="px-3.5 pb-0.5 text-[9px] font-bold uppercase tracking-wider text-steam-accent truncate">
                      Current Game
                    </div>

                    {/* 7. Fix Match & Metadata (Consistent #1 per-game item matching GameContextMenu) */}
                    {currentGameTitle && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setIsMenuOpen(false);
                          if (onOpenFixMatch) onOpenFixMatch();
                        }}
                        className="min-h-6 w-full flex items-center justify-between px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer group"
                        title={`Fix canonical match, cover poster, and metadata for ${currentGameTitle}`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Wand className="w-4 h-4 shrink-0 text-[#66c0f4] group-hover:scale-110 transition-transform" />
                          <div className="flex flex-col min-w-0">
                            <span className="font-semibold text-white truncate">
                              Fix Match &amp; Metadata...
                            </span>
                            <span className="text-[10px] text-steam-subtext truncate">
                              {currentGameTitle}
                            </span>
                          </div>
                        </div>
                      </button>
                    )}

                    {/* 8. Sync Store Media (This Game) (Consistent #2 per-game item matching GameContextMenu) */}
                    {canSyncCurrentGame && onSyncCurrentGame && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setIsMenuOpen(false);
                          onSyncCurrentGame();
                        }}
                        disabled={isSyncingCurrentGame}
                        className="min-h-6 w-full flex items-center justify-between px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer disabled:opacity-50 group"
                        title={`Re-sync trailers, screenshots, descriptions & achievements for ${currentGameTitle || 'current game'} from Steam`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Film
                            className={`w-4 h-4 shrink-0 ${
                              isSyncingCurrentGame
                                ? 'animate-spin text-steam-accent'
                                : 'text-purple-400 group-hover:scale-110 transition-transform'
                            }`}
                          />
                          <div className="flex flex-col min-w-0">
                            <span className="font-semibold text-white truncate">
                              {isSyncingCurrentGame ? 'Syncing Media...' : 'Sync Store Media (This Game)'}
                            </span>
                            <span className="text-[10px] text-steam-subtext truncate">
                              {currentGameTitle || 'Current game'}
                            </span>
                          </div>
                        </div>
                        {isSyncingCurrentGame && (
                          <span className="text-[10px] text-steam-accent font-semibold ml-2 shrink-0">Active</span>
                        )}
                      </button>
                    )}

                    {/* 9. View Achievements (Consistent #3 per-game item matching GameContextMenu) */}
                    {currentGameTitle && onOpenAchievements && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setIsMenuOpen(false);
                          onOpenAchievements();
                        }}
                        className="min-h-6 w-full flex items-center justify-between px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer group"
                        title={`View detailed achievements, icons & unlock dates for ${currentGameTitle}`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Trophy className="w-4 h-4 shrink-0 text-amber-400 group-hover:scale-110 transition-transform" />
                          <div className="flex flex-col min-w-0">
                            <span className="font-semibold text-white truncate">
                              View Achievements...
                            </span>
                            <span className="text-[10px] text-steam-subtext truncate">
                              {currentGameTitle}
                            </span>
                          </div>
                        </div>
                      </button>
                    )}
                  </div>
                )}

                {/* Group 4: Application Updates */}
                <div role="presentation" className="mt-1 pt-1.5 border-t border-steam-border/50">
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="menu-check-for-updates"
                    onClick={handleCheckForUpdates}
                    disabled={updateStatus === 'checking'}
                    className="min-h-6 w-full flex items-center justify-between px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer disabled:opacity-50 group"
                    title={
                      updateInfo?.hasUpdate
                        ? `Download One Launcher v${updateInfo.latestVersion} — Your library, connected accounts, and installed games are automatically preserved.`
                        : 'Check for a newer version of One Launcher'
                    }
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {updateInfo?.hasUpdate ? (
                        <Download className="w-4 h-4 shrink-0 text-emerald-400 group-hover:scale-110 transition-transform" />
                      ) : (
                        <RefreshCw
                          className={`w-4 h-4 shrink-0 ${
                            updateStatus === 'checking'
                              ? 'animate-spin text-steam-accent'
                              : 'text-sky-400 group-hover:rotate-45 transition-transform'
                          }`}
                        />
                      )}
                      <div className="flex flex-col min-w-0">
                        <span
                          className={`font-semibold truncate ${
                            updateInfo?.hasUpdate ? 'text-emerald-300' : 'text-white'
                          }`}
                        >
                          {updateStatus === 'checking'
                            ? 'Checking for updates...'
                            : updateInfo?.hasUpdate
                              ? `Update Available: v${updateInfo.latestVersion} — Download`
                              : updateStatus === 'up-to-date'
                                ? `Up to date (v${appVersion})`
                                : 'Check for Updates'}
                        </span>
                        <span className="text-[10px] text-steam-subtext truncate">
                          {updateInfo?.hasUpdate
                            ? 'Accounts & library preserved on update'
                            : `Current version: v${appVersion}`}
                        </span>
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="menu-about-one-launcher"
                    onClick={() => {
                      setIsMenuOpen(false);
                      setIsAboutModalOpen(true);
                    }}
                    className="min-h-6 w-full flex items-center justify-between px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer group"
                    title="View version & architecture details for One Launcher"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Info className="w-4 h-4 shrink-0 text-slate-300 group-hover:text-sky-400 transition-colors" />
                      <span className="font-semibold text-white truncate">About One Launcher</span>
                    </div>
                    <span className="text-[10px] text-slate-300 font-mono shrink-0">v{appVersion}</span>
                  </button>
                </div>
              </div>
            )}
          </div>

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
              <ChevronLeft className="w-4 h-4" />
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
              title={canGoForward ? `Forward to ${forwardTitle || 'next page'} (Alt + →)` : 'Forward'}
              aria-label="Forward"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Center Section: Merged Storefront Filter Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none min-w-0 flex-1 justify-start md:justify-center px-1">
          {visiblePlatforms.map((p) => {
            const isSelected = selectedPlatform === p;
            const isConnected = p === 'all' || connectedSet.has(p);
            const meta = p === 'all' ? null : STOREFRONT_REGISTRY[p];
            const name = p === 'all' ? 'All Libraries' : meta?.name || p.toUpperCase();

            return (
              <button
                key={p}
                type="button"
                onClick={() => onSelectPlatform(p)}
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                className={`app-no-drag px-3 py-1 rounded text-xs whitespace-nowrap font-medium transition-all cursor-pointer flex items-center gap-1.5 ${
                  isSelected
                    ? 'bg-steam-accent text-black font-bold shadow-md shadow-steam-accent/20'
                    : 'bg-[#1b222d] text-steam-text hover:text-white hover:bg-[#253040] border border-steam-border/40'
                }`}
              >
                <span>{name}</span>
                {!isConnected && (
                  <span
                    className="text-[9px] px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 font-semibold"
                    title="Storefront account not connected"
                  >
                    Not Connected
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Right Section: Downloads, Installed Only Filter & Games Counter */}
        <div
          className="app-no-drag flex items-center gap-2.5 text-xs shrink-0"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            type="button"
            onClick={() => {
              if (onOpenDownloads) {
                onOpenDownloads();
              } else {
                launcherService.openDownloadDrawer();
              }
            }}
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
            onClick={onToggleInstalledOnly}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            className={`app-no-drag px-2.5 py-1 text-xs rounded border transition-colors flex items-center gap-1.5 cursor-pointer ${
              installedOnly
                ? 'bg-emerald-950/70 border-emerald-500/70 text-emerald-400 font-semibold'
                : 'bg-steam-card border-steam-border text-steam-subtext hover:text-white'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${installedOnly ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
            Installed Only
          </button>

          <span className="text-steam-subtext flex items-center gap-1">
            <Layers className="w-3.5 h-3.5 text-steam-accent" />
            <strong className="text-white">{filteredCount}</strong> / {totalGamesCount} Games
          </span>
        </div>
      </div>

      <ModalShell
        isOpen={isAboutModalOpen}
        onClose={() => setIsAboutModalOpen(false)}
        ariaLabelledBy="about-one-launcher-title"
        testId="about-one-launcher-modal"
        className="w-full max-w-md rounded-xl border border-steam-border bg-[#131b26] p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="about-one-launcher-title" className="text-base font-bold text-white">
              One Launcher
            </h2>
            <p className="mt-0.5 text-xs text-slate-400 font-mono">Version v{appVersion}</p>
          </div>
          <button
            type="button"
            onClick={() => setIsAboutModalOpen(false)}
            aria-label="Close About dialog"
            className="min-w-6 min-h-6 inline-flex items-center justify-center rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-slate-300">
          Unified multi-storefront PC &amp; macOS game library, trophy tracker, and launch orchestrator.
        </p>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={() => setIsAboutModalOpen(false)}
            className="rounded-lg bg-steam-accent px-4 py-1.5 text-xs font-bold text-black hover:brightness-110 transition-all cursor-pointer"
          >
            Close
          </button>
        </div>
      </ModalShell>
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
      systemSetupAlertCount,
      onOpenAchievements,
      onOpenDownloads,
      isMenuOpen,
      isFullScreen,
      isMaximized,
      openMenu,
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

