import React from 'react';
import {
  RefreshCw,
  Cloud,
  Menu,
  Film,
  Wand,
  Trophy,
  Award,
  Download,
  Sliders,
  ShieldCheck,
  Settings,
  Info,
} from 'lucide-react';
import type { HostPlatformCapabilities } from '../../../contracts/hostPlatform';
import { environmentSetupService } from '../../../services/launcher/environmentSetupService';
import type { AppUpdateCheckResult } from '../../../types/electron';
import type { MenuKeyboardNavOptions } from './types';

export interface RenderBurgerMenuArgs {
  menuRef: React.MutableRefObject<HTMLDivElement | null>;
  burgerTriggerRef: React.MutableRefObject<HTMLButtonElement | null>;
  burgerMenuDropdownRef: React.MutableRefObject<HTMLDivElement | null>;
  isMenuOpen: boolean;
  setIsMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsAboutModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  hostCapabilities: HostPlatformCapabilities;
  appVersion: string;
  updateStatus: 'idle' | 'checking' | 'up-to-date' | 'update-available';
  updateInfo: AppUpdateCheckResult | null;
  systemSetupAlertCount?: number;
  isSyncing: boolean;
  isSyncingAllMedia: boolean;
  isSyncingCurrentGame: boolean;
  isSyncingScores: boolean;
  isSyncingTrophies: boolean;
  currentGameTitle?: string;
  canSyncCurrentGame: boolean;
  scheduleFocusInMenuContainer: (
    getContainer: () => HTMLElement | null,
    target: 'first' | 'last'
  ) => void;
  handleMenuContainerArrowKeys: (
    event: React.KeyboardEvent<HTMLDivElement>,
    options?: MenuKeyboardNavOptions
  ) => void;
  handleOpenSettings: () => void;
  handleCheckForUpdates: () => Promise<void>;
  onOpenIntegrations: () => void;
  onOpenLibraryMatchManager?: () => void;
  onOpenSystemSetup?: () => void;
  onTriggerSync: () => void;
  onSyncAllMedia?: () => void;
  onSyncTrophies?: () => void;
  onRefreshScores?: () => void;
  onOpenFixMatch?: () => void;
  onSyncCurrentGame?: () => void;
  onOpenAchievements?: () => void;
}

export function renderBurgerMenu({
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
}: RenderBurgerMenuArgs): React.ReactElement {
  return (
    <div className="relative" ref={menuRef}>
      <button
        ref={burgerTriggerRef}
        type="button"
        onClick={() => setIsMenuOpen((prev) => !prev)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Home') {
            e.preventDefault();
            setIsMenuOpen(true);
            scheduleFocusInMenuContainer(() => burgerMenuDropdownRef.current, 'first');
          } else if (e.key === 'ArrowUp' || e.key === 'End') {
            e.preventDefault();
            setIsMenuOpen(true);
            scheduleFocusInMenuContainer(() => burgerMenuDropdownRef.current, 'last');
          } else if (e.key === 'Escape' && isMenuOpen) {
            e.preventDefault();
            e.stopPropagation();
            setIsMenuOpen(false);
          }
        }}
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
        <Menu className="w-4 h-4" aria-hidden="true" />
        {(isSyncing ||
          isSyncingAllMedia ||
          isSyncingCurrentGame ||
          isSyncingScores ||
          isSyncingTrophies) && (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 animate-ping"
          />
        )}
      </button>

      {/* Burger Dropdown Menu */}
      {isMenuOpen && (
        <div
          ref={burgerMenuDropdownRef}
          role="menu"
          aria-label="Launcher actions"
          onKeyDown={(e) =>
            handleMenuContainerArrowKeys(e, {
              onEscape: () => {
                setIsMenuOpen(false);
                burgerTriggerRef.current?.focus?.({ preventScroll: true });
              },
              onTabOut: () => setIsMenuOpen(false),
            })
          }
          className="app-no-drag absolute left-0 top-full mt-2 w-64 rounded-md bg-[#16202d] border border-steam-border shadow-2xl z-50 py-1.5"
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
              {appVersion && (
                <span
                  data-testid="menu-app-version"
                  className="text-[10px] text-steam-subtext font-mono"
                >
                  v{appVersion}
                </span>
              )}
            </div>
          </div>

          {/* Group 1: Accounts & Library Management */}
          <div
            role="presentation"
            className="px-3.5 pt-1 pb-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-300"
          >
            Accounts &amp; Library
          </div>

          {/* 0. Settings */}
          <button
            type="button"
            role="menuitem"
            data-testid="menu-open-settings"
            onClick={handleOpenSettings}
            className="min-h-6 w-full flex items-center justify-between px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2c3d] transition-colors text-left cursor-pointer group"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <Settings
                className="w-4 h-4 shrink-0 text-sky-400 group-hover:scale-110 transition-transform"
                aria-hidden="true"
              />
              <div className="flex flex-col min-w-0">
                <span className="font-semibold text-white truncate">Settings…</span>
                <span className="text-[10px] text-steam-subtext truncate">
                  {hostCapabilities.supportsBottleDisplayScaler
                    ? 'Library, footprint, display & HUD'
                    : 'Library, footprint & launch defaults'}
                </span>
              </div>
            </div>
          </button>

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
              <Cloud
                className="w-4 h-4 text-sky-400 group-hover:scale-110 transition-transform"
                aria-hidden="true"
              />
              <div className="flex flex-col">
                <span className="font-semibold text-white">Accounts</span>
                <span className="text-[10px] text-steam-subtext">Connected storefronts</span>
              </div>
            </div>
            <span
              aria-hidden="true"
              className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]"
            />
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
                <Sliders
                  className="w-4 h-4 shrink-0 text-[#66c0f4] group-hover:scale-110 transition-transform"
                  aria-hidden="true"
                />
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
                  {hostCapabilities.supportsWindowsTranslation
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
                  aria-hidden="true"
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
                  <span className="text-[10px] text-steam-subtext">
                    Games, trophies &amp; playtime
                  </span>
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
                    aria-hidden="true"
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
                    <span className="text-[10px] text-steam-subtext">
                      Trailers, screenshots &amp; descriptions
                    </span>
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
                    aria-hidden="true"
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
                    <span className="text-[10px] text-steam-subtext">
                      Steam, GOG, Epic &amp; Xbox
                    </span>
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
                    aria-hidden="true"
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
                    <span className="text-[10px] text-steam-subtext">
                      Metacritic, OpenCritic &amp; Steam
                    </span>
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

              {/* 7. Fix Match & Metadata */}
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
                    <Wand
                      aria-hidden="true"
                      className="w-4 h-4 shrink-0 text-[#66c0f4] group-hover:scale-110 transition-transform"
                    />
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

              {/* 8. Sync Store Media (This Game) */}
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
                      aria-hidden="true"
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
                    <span className="text-[10px] text-steam-accent font-semibold ml-2 shrink-0">
                      Active
                    </span>
                  )}
                </button>
              )}

              {/* 9. View Achievements */}
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
                    <Trophy
                      aria-hidden="true"
                      className="w-4 h-4 shrink-0 text-amber-400 group-hover:scale-110 transition-transform"
                    />
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
                  <Download
                    aria-hidden="true"
                    className="w-4 h-4 shrink-0 text-emerald-400 group-hover:scale-110 transition-transform"
                  />
                ) : (
                  <RefreshCw
                    aria-hidden="true"
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
                          ? appVersion
                            ? `Up to date (v${appVersion})`
                            : 'Up to date'
                          : 'Check for Updates'}
                  </span>
                  <span className="text-[10px] text-steam-subtext truncate">
                    {updateInfo?.hasUpdate
                      ? 'Accounts & library preserved on update'
                      : appVersion
                        ? `Current version: v${appVersion}`
                        : 'Check for launcher updates'}
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
                <Info
                  aria-hidden="true"
                  className="w-4 h-4 shrink-0 text-slate-300 group-hover:text-sky-400 transition-colors"
                />
                <span className="font-semibold text-white truncate">About One Launcher</span>
              </div>
              {appVersion && (
                <span className="text-[10px] text-slate-300 font-mono shrink-0">
                  v{appVersion}
                </span>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
