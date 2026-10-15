import React, { useState, useRef, useEffect, useMemo } from 'react';
import { StorefrontId, STOREFRONT_REGISTRY } from '../../contracts/platform';
import { loadIntegrations } from '../../services/integrations/integrationStorage';
import { CanonicalGame } from '../../contracts/game';
import { launcherService } from '../../services/launcher/launcherService';
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
} from 'lucide-react';

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
  defaultMenuOpen = false,
  onOpenAchievements,
  onOpenDownloads,
}) => {
  const [isMenuOpen, setIsMenuOpen] = useState(defaultMenuOpen);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [downloadQueue, setDownloadQueue] = useState(() => launcherService.getDownloadQueue());

  useEffect(() => {
    const unsub = launcherService.subscribe(() => {
      setDownloadQueue([...launcherService.getDownloadQueue()]);
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

  // Close burger menu on outside click or escape
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsMenuOpen(false);
      }
    }
    if (isMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMenuOpen]);

  // All known storefront IDs in canonical order
  const allPlatforms: StorefrontId[] = [
    'steam',
    'gog',
    'epic',
    'amazon',
    'xbox',
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
      return new Set<StorefrontId>(['steam', 'gog', 'epic']);
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

  return (
    <header className="sticky top-0 z-40 bg-[#171a21]/95 backdrop-blur-md border-b border-steam-border shadow-md select-none">
      <div className="max-w-[1700px] mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
        {/* Left Section: Burger Menu + History Navigation */}
        <div className="flex items-center gap-2.5 shrink-0">
          {/* Burger Menu Button with Dropdown */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setIsMenuOpen((prev) => !prev)}
              className={`p-2 rounded transition-all flex items-center justify-center border shadow-sm cursor-pointer ${
                isMenuOpen
                  ? 'bg-steam-accent text-black border-steam-accent shadow-[0_0_12px_rgba(102,192,244,0.4)]'
                  : 'bg-[#10141a] text-steam-text hover:text-white hover:bg-[#1a222d] border-steam-border/80'
              }`}
              title="Menu (Accounts, Sync All)"
              aria-label="Menu"
              aria-expanded={isMenuOpen}
            >
              <Menu className="w-4 h-4" />
              {(isSyncing || isSyncingAllMedia || isSyncingCurrentGame || isSyncingScores || isSyncingTrophies) && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              )}
            </button>

            {/* Burger Dropdown Menu */}
            {isMenuOpen && (
              <div className="absolute left-0 top-full mt-2 w-64 rounded-md bg-[#16202d] border border-steam-border shadow-2xl z-50 py-1.5 backdrop-blur-md animate-in fade-in zoom-in-95 duration-150">
                {/* Brand Header */}
                <div className="px-3.5 py-1.5 border-b border-steam-border/60 mb-1 flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-steam-accent">One Launcher</span>
                  <span className="text-[10px] text-steam-subtext font-mono">v0.1.0</span>
                </div>

                {/* Accounts */}
                <button
                  type="button"
                  onClick={() => {
                    setIsMenuOpen(false);
                    onOpenIntegrations();
                  }}
                  className="w-full flex items-center justify-between px-3.5 py-2.5 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer group"
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

                {/* Sync Integrations */}
                <button
                  type="button"
                  onClick={() => {
                    setIsMenuOpen(false);
                    onTriggerSync();
                  }}
                  disabled={isSyncing}
                  className="w-full flex items-center justify-between px-3.5 py-2.5 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer disabled:opacity-50 group"
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
                      <span className="text-[10px] text-steam-subtext">Games, trophies & playtime</span>
                    </div>
                  </div>
                  {isSyncing && (
                    <span className="text-[10px] text-steam-accent font-semibold">Active</span>
                  )}
                </button>

                {/* Sync Trophies (All Storefronts) */}
                {onSyncTrophies && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsMenuOpen(false);
                      onSyncTrophies();
                    }}
                    disabled={isSyncingTrophies}
                    className="w-full flex items-center justify-between px-3.5 py-2.5 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer disabled:opacity-50 group border-t border-steam-border/40"
                    title="Synchronize unlocked trophies & achievements across Steam, GOG.com, and Epic Games Store"
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
                        <span className="text-[10px] text-steam-subtext">Steam, GOG & Epic achievements</span>
                      </div>
                    </div>
                    {isSyncingTrophies && (
                      <span className="text-[10px] text-steam-accent font-semibold">Active</span>
                    )}
                  </button>
                )}

                {/* Sync Store Media (All Games) */}
                {onSyncAllMedia && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsMenuOpen(false);
                      onSyncAllMedia();
                    }}
                    disabled={isSyncingAllMedia}
                    className="w-full flex items-center justify-between px-3.5 py-2.5 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer disabled:opacity-50 group"
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
                        <span className="text-[10px] text-steam-subtext">Trailers, screenshots & descriptions</span>
                      </div>
                    </div>
                    {isSyncingAllMedia && (
                      <span className="text-[10px] text-steam-accent font-semibold">Active</span>
                    )}
                  </button>
                )}

                {/* Refresh Critic Scores */}
                {onRefreshScores && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsMenuOpen(false);
                      onRefreshScores();
                    }}
                    disabled={isSyncingScores}
                    className="w-full flex items-center justify-between px-3.5 py-2.5 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer disabled:opacity-50 group border-t border-steam-border/40"
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
                        <span className="text-[10px] text-steam-subtext">Metacritic, OpenCritic & Steam</span>
                      </div>
                    </div>
                    {isSyncingScores && (
                      <span className="text-[10px] text-steam-accent font-semibold">Active</span>
                    )}
                  </button>
                )}

                {/* Sync Store Media (This Game) (Visible only when applicable) */}
                {canSyncCurrentGame && onSyncCurrentGame && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsMenuOpen(false);
                      onSyncCurrentGame();
                    }}
                    disabled={isSyncingCurrentGame}
                    className="w-full flex items-center justify-between px-3.5 py-2.5 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer disabled:opacity-50 group border-t border-steam-border/40"
                    title={`Re-sync trailers, screenshots, descriptions & achievements for ${currentGameTitle || 'current game'} from Steam`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Film
                        className={`w-4 h-4 shrink-0 ${
                          isSyncingCurrentGame
                            ? 'animate-spin text-steam-accent'
                            : 'text-sky-400 group-hover:scale-110 transition-transform'
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

                {/* Fix Match & Metadata (Visible when viewing individual game) */}
                {currentGameTitle && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsMenuOpen(false);
                      if (onOpenFixMatch) onOpenFixMatch();
                    }}
                    className="w-full flex items-center justify-between px-3.5 py-2.5 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer group border-t border-steam-border/40"
                    title={`Fix canonical match, cover poster, and metadata for ${currentGameTitle}`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Wand className="w-4 h-4 shrink-0 text-[#66c0f4] group-hover:scale-110 transition-transform" />
                      <div className="flex flex-col min-w-0">
                        <span className="font-semibold text-white truncate">
                          Fix Match & Metadata...
                        </span>
                        <span className="text-[10px] text-steam-subtext truncate">
                          {currentGameTitle}
                        </span>
                      </div>
                    </div>
                  </button>
                )}

                {/* View Achievements (Visible when viewing individual game) */}
                {currentGameTitle && onOpenAchievements && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsMenuOpen(false);
                      onOpenAchievements();
                    }}
                    className="w-full flex items-center justify-between px-3.5 py-2.5 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer group border-t border-steam-border/40"
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
          </div>

          {/* History Navigation: Back & Forward Controls */}
          <div className="flex items-center bg-[#10141a] p-0.5 rounded border border-steam-border/80 shadow-inner">
            <button
              type="button"
              onClick={onGoBack}
              disabled={!canGoBack}
              className={`p-1.5 rounded transition-all flex items-center justify-center ${
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
              className={`p-1.5 rounded transition-all flex items-center justify-center ${
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
                onClick={() => onSelectPlatform(p)}
                className={`px-3 py-1 rounded text-xs whitespace-nowrap font-medium transition-all cursor-pointer flex items-center gap-1.5 ${
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
        <div className="flex items-center gap-2.5 text-xs shrink-0">
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
            className={`relative overflow-hidden px-2.5 py-1 text-xs rounded border transition-colors flex items-center gap-1.5 cursor-pointer ${
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
            onClick={onToggleInstalledOnly}
            className={`px-2.5 py-1 text-xs rounded border transition-colors flex items-center gap-1.5 cursor-pointer ${
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
    </header>
  );
};

