import React from 'react';
import { Minus, X } from 'lucide-react';
import { environmentSetupService } from '../../../services/launcher/environmentSetupService';
import type { WindowMenuAction } from '../../../types/electron';
import type { MenuKeyboardNavOptions, TopMenuId } from './types';

export interface RenderWindowMenuBarArgs {
  topMenuBarRef: React.MutableRefObject<HTMLDivElement | null>;
  topMenuTriggerRefs: React.MutableRefObject<Record<TopMenuId, HTMLButtonElement | null>>;
  topMenuDropdownRefs: React.MutableRefObject<Record<TopMenuId, HTMLDivElement | null>>;
  openMenu: TopMenuId | null;
  setOpenMenu: React.Dispatch<React.SetStateAction<TopMenuId | null>>;
  activeMenuBarIndex: number;
  setActiveMenuBarIndex: React.Dispatch<React.SetStateAction<number>>;
  isMaximized: boolean;
  setIsMaximized: React.Dispatch<React.SetStateAction<boolean>>;
  installedOnly: boolean;
  systemSetupAlertCount?: number;
  handleTopMenuTriggerKeyDown: (
    event: React.KeyboardEvent<HTMLButtonElement>,
    menuId: TopMenuId,
    menuIdx: number
  ) => void;
  handleMenuContainerArrowKeys: (
    event: React.KeyboardEvent<HTMLDivElement>,
    options?: MenuKeyboardNavOptions
  ) => void;
  moveToAdjacentTopMenu: (currentIndex: number, direction: 1 | -1, keepOpen: boolean) => void;
  runMenuAction: (action: WindowMenuAction) => void;
  handleOpenSettings: () => void;
  handleOpenDownloadsDrawer: () => void;
  onOpenIntegrations: () => void;
  onOpenSystemSetup?: () => void;
  onOpenLibraryMatchManager?: () => void;
  onTriggerSync: () => void;
  onToggleInstalledOnly: () => void;
}

export function renderWindowMenuBar({
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
}: RenderWindowMenuBarArgs): React.ReactElement {
  return (
    <div
      data-testid="steam-integrated-window-bar"
      className="bg-[#10151d] border-b border-[#1f2937]/80 h-8 flex items-center justify-between select-none relative z-50"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Left Side: Brand Icon + Title + Steam-Style Menu Bar */}
      <div
        ref={topMenuBarRef}
        className="app-no-drag flex items-center h-full pl-2.5"
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

        <div
          role="menubar"
          aria-label="Application commands"
          className="flex items-center h-full"
        >
          {/* File Menu */}
          <div role="none" className="relative flex items-center h-full">
            <button
              ref={(el) => {
                topMenuTriggerRefs.current.file = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={activeMenuBarIndex === 0 ? 0 : -1}
              data-testid="win-menu-file"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'file'}
              onClick={() => {
                setActiveMenuBarIndex(0);
                setOpenMenu(openMenu === 'file' ? null : 'file');
              }}
              onMouseEnter={() => {
                if (openMenu !== null && openMenu !== 'file') {
                  setActiveMenuBarIndex(0);
                  setOpenMenu('file');
                  topMenuTriggerRefs.current.file?.focus?.({ preventScroll: true });
                }
              }}
              onKeyDown={(e) => handleTopMenuTriggerKeyDown(e, 'file', 0)}
              className={`min-h-6 px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                openMenu === 'file'
                  ? 'bg-[#253447] text-white'
                  : 'text-steam-subtext hover:text-white hover:bg-white/5'
              }`}
            >
              File
            </button>
            {openMenu === 'file' && (
              <div
                ref={(el) => {
                  topMenuDropdownRefs.current.file = el;
                }}
                role="menu"
                aria-label="File"
                data-testid="win-menu-dropdown-file"
                onKeyDown={(e) =>
                  handleMenuContainerArrowKeys(e, {
                    onEscape: () => {
                      setOpenMenu(null);
                      topMenuTriggerRefs.current.file?.focus?.({ preventScroll: true });
                    },
                    onArrowHorizontal: (dir) => moveToAdjacentTopMenu(0, dir, true),
                    onTabOut: () => setOpenMenu(null),
                  })
                }
                className="bg-[#16202d] border border-[#2a475e] shadow-2xl rounded-md py-1.5 min-w-[230px] absolute top-full left-0 mt-0.5 z-50"
              >
                <button
                  type="button"
                  role="menuitem"
                  data-testid="win-menu-settings"
                  onClick={handleOpenSettings}
                  className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                >
                  <span>Settings…</span>
                  <span className="text-[10px] text-steam-subtext font-mono ml-4">Ctrl+,</span>
                </button>
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
          <div role="none" className="relative flex items-center h-full">
            <button
              ref={(el) => {
                topMenuTriggerRefs.current.edit = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={activeMenuBarIndex === 1 ? 0 : -1}
              data-testid="win-menu-edit"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'edit'}
              onClick={() => {
                setActiveMenuBarIndex(1);
                setOpenMenu(openMenu === 'edit' ? null : 'edit');
              }}
              onMouseEnter={() => {
                if (openMenu !== null && openMenu !== 'edit') {
                  setActiveMenuBarIndex(1);
                  setOpenMenu('edit');
                  topMenuTriggerRefs.current.edit?.focus?.({ preventScroll: true });
                }
              }}
              onKeyDown={(e) => handleTopMenuTriggerKeyDown(e, 'edit', 1)}
              className={`min-h-6 px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                openMenu === 'edit'
                  ? 'bg-[#253447] text-white'
                  : 'text-steam-subtext hover:text-white hover:bg-white/5'
              }`}
            >
              Edit
            </button>
            {openMenu === 'edit' && (
              <div
                ref={(el) => {
                  topMenuDropdownRefs.current.edit = el;
                }}
                role="menu"
                aria-label="Edit"
                data-testid="win-menu-dropdown-edit"
                onKeyDown={(e) =>
                  handleMenuContainerArrowKeys(e, {
                    onEscape: () => {
                      setOpenMenu(null);
                      topMenuTriggerRefs.current.edit?.focus?.({ preventScroll: true });
                    },
                    onArrowHorizontal: (dir) => moveToAdjacentTopMenu(1, dir, true),
                    onTabOut: () => setOpenMenu(null),
                  })
                }
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
          <div role="none" className="relative flex items-center h-full">
            <button
              ref={(el) => {
                topMenuTriggerRefs.current.view = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={activeMenuBarIndex === 2 ? 0 : -1}
              data-testid="win-menu-view"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'view'}
              onClick={() => {
                setActiveMenuBarIndex(2);
                setOpenMenu(openMenu === 'view' ? null : 'view');
              }}
              onMouseEnter={() => {
                if (openMenu !== null && openMenu !== 'view') {
                  setActiveMenuBarIndex(2);
                  setOpenMenu('view');
                  topMenuTriggerRefs.current.view?.focus?.({ preventScroll: true });
                }
              }}
              onKeyDown={(e) => handleTopMenuTriggerKeyDown(e, 'view', 2)}
              className={`min-h-6 px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                openMenu === 'view'
                  ? 'bg-[#253447] text-white'
                  : 'text-steam-subtext hover:text-white hover:bg-white/5'
              }`}
            >
              View
            </button>
            {openMenu === 'view' && (
              <div
                ref={(el) => {
                  topMenuDropdownRefs.current.view = el;
                }}
                role="menu"
                aria-label="View"
                data-testid="win-menu-dropdown-view"
                onKeyDown={(e) =>
                  handleMenuContainerArrowKeys(e, {
                    onEscape: () => {
                      setOpenMenu(null);
                      topMenuTriggerRefs.current.view?.focus?.({ preventScroll: true });
                    },
                    onArrowHorizontal: (dir) => moveToAdjacentTopMenu(2, dir, true),
                    onTabOut: () => setOpenMenu(null),
                  })
                }
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
          <div role="none" className="relative flex items-center h-full">
            <button
              ref={(el) => {
                topMenuTriggerRefs.current.window = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={activeMenuBarIndex === 3 ? 0 : -1}
              data-testid="win-menu-window"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'window'}
              onClick={() => {
                setActiveMenuBarIndex(3);
                setOpenMenu(openMenu === 'window' ? null : 'window');
              }}
              onMouseEnter={() => {
                if (openMenu !== null && openMenu !== 'window') {
                  setActiveMenuBarIndex(3);
                  setOpenMenu('window');
                  topMenuTriggerRefs.current.window?.focus?.({ preventScroll: true });
                }
              }}
              onKeyDown={(e) => handleTopMenuTriggerKeyDown(e, 'window', 3)}
              className={`min-h-6 px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                openMenu === 'window'
                  ? 'bg-[#253447] text-white'
                  : 'text-steam-subtext hover:text-white hover:bg-white/5'
              }`}
            >
              Window
            </button>
            {openMenu === 'window' && (
              <div
                ref={(el) => {
                  topMenuDropdownRefs.current.window = el;
                }}
                role="menu"
                aria-label="Window"
                data-testid="win-menu-dropdown-window"
                onKeyDown={(e) =>
                  handleMenuContainerArrowKeys(e, {
                    onEscape: () => {
                      setOpenMenu(null);
                      topMenuTriggerRefs.current.window?.focus?.({ preventScroll: true });
                    },
                    onArrowHorizontal: (dir) => moveToAdjacentTopMenu(3, dir, true),
                    onTabOut: () => setOpenMenu(null),
                  })
                }
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
                  role="menuitemcheckbox"
                  aria-checked={installedOnly}
                  onClick={() => {
                    setOpenMenu(null);
                    onToggleInstalledOnly();
                  }}
                  className="min-h-6 w-full flex items-center justify-between px-3 py-1.5 text-xs text-steam-text hover:text-white hover:bg-[#253447] transition-colors text-left cursor-pointer"
                >
                  <span>Installed Games Only</span>
                  {installedOnly && (
                    <span aria-hidden="true" className="text-xs font-bold text-emerald-400 ml-4">
                      ✓
                    </span>
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
          <Minus className="w-3.5 h-3.5" aria-hidden="true" />
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
              aria-hidden="true"
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
              aria-hidden="true"
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
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
