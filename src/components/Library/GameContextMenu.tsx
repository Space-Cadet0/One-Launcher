import React, { useState, useEffect, useRef, useLayoutEffect, useCallback } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { GameCollection } from '../../contracts/collection';
import { CollectionIcon } from '../Common/CollectionIcon';
import {
  Wand,
  Film,
  FolderPlus,
  ChevronRight,
  Check,
  Sliders,
  Trophy,
  EyeOff,
} from 'lucide-react';

export interface GameContextMenuProps {
  isOpen: boolean;
  x: number;
  y: number;
  game: CanonicalGame | null;
  collections: GameCollection[];
  onClose: () => void;
  onFixMatch: (game: CanonicalGame) => void;
  onSyncStoreMedia: (game: CanonicalGame) => void;
  onToggleCollection: (collectionId: string, gameId: string) => void;
  onManageCollections: (game: CanonicalGame) => void;
  onViewAchievements?: (game: CanonicalGame) => void;
  onHideGame?: (game: CanonicalGame) => void;
}

function getDirectMenuItems(
  root: HTMLElement | null,
  excludeContainer?: HTMLElement | null
): HTMLButtonElement[] {
  if (!root) return [];
  const all = Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)')
  );
  if (!excludeContainer) return all;
  return all.filter((item) => !excludeContainer.contains(item));
}

function scheduleMenuFocus(fn: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(fn);
    return () => cancelAnimationFrame(id);
  }
  const timer = setTimeout(fn, 0);
  return () => clearTimeout(timer);
}

export const GameContextMenu: React.FC<GameContextMenuProps> = ({
  isOpen,
  x,
  y,
  game,
  collections,
  onClose,
  onFixMatch,
  onSyncStoreMedia,
  onToggleCollection,
  onManageCollections,
  onViewAchievements,
  onHideGame,
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const submenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [isSubmenuOpen, setIsSubmenuOpen] = useState(false);
  const [coords, setCoords] = useState<{ x: number; y: number }>({ x, y });
  const [flyLeft, setFlyLeft] = useState(false);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const openSubmenu = useCallback(() => {
    clearCloseTimer();
    setIsSubmenuOpen(true);
  }, [clearCloseTimer]);

  const scheduleCloseSubmenu = useCallback(
    (delayMs = 260) => {
      clearCloseTimer();
      closeTimerRef.current = setTimeout(() => {
        setIsSubmenuOpen(false);
        closeTimerRef.current = null;
      }, delayMs);
    },
    [clearCloseTimer]
  );

  const focusSubmenuItem = useCallback((target: 'first' | 'last') => {
    scheduleMenuFocus(() => {
      const items = getDirectMenuItems(submenuRef.current);
      if (items.length === 0) return;
      const item = target === 'first' ? items[0] : items[items.length - 1];
      item?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    return () => {
      clearCloseTimer();
    };
  }, [clearCloseTimer]);

  // Recalculate coordinates whenever open or x/y changes to keep completely within viewport bounds
  useLayoutEffect(() => {
    if (!isOpen) {
      clearCloseTimer();
      setIsSubmenuOpen(false);
      return;
    }

    const menuWidth = 230;
    const menuHeight = 220;
    const submenuWidth = 210;
    const padding = 8;

    let targetX = x;
    let targetY = y;

    if (targetX + menuWidth + padding > window.innerWidth) {
      targetX = Math.max(padding, window.innerWidth - menuWidth - padding);
    }
    if (targetY + menuHeight + padding > window.innerHeight) {
      targetY = Math.max(padding, window.innerHeight - menuHeight - padding);
    }

    setCoords({ x: targetX, y: targetY });

    if (targetX + menuWidth + submenuWidth + padding > window.innerWidth) {
      setFlyLeft(true);
    } else {
      setFlyLeft(false);
    }
  }, [isOpen, x, y, clearCloseTimer]);

  // Move keyboard focus into the ARIA menu when opened and restore on Escape/close if focus stayed inside
  useEffect(() => {
    if (!isOpen || !game) return;
    if (typeof document !== 'undefined' && typeof HTMLElement !== 'undefined') {
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    const cancelFocus = scheduleMenuFocus(() => {
      const items = getDirectMenuItems(menuRef.current, submenuRef.current);
      items[0]?.focus({ preventScroll: true });
    });
    return () => {
      cancelFocus();
      const prevEl = previousFocusRef.current;
      previousFocusRef.current = null;
      if (
        prevEl &&
        typeof document !== 'undefined' &&
        document.contains(prevEl) &&
        (!document.activeElement ||
          document.activeElement === document.body ||
          menuRef.current?.contains(document.activeElement))
      ) {
        prevEl.focus({ preventScroll: true });
      }
    };
  }, [isOpen, game?.id]);

  // Handle outside click, passive capture window scroll, and escape key
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    function handleScroll(event: Event) {
      if (menuRef.current && menuRef.current.contains(event.target as Node)) {
        return;
      }
      onClose();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
      document.addEventListener('keydown', handleKeyDown);
    }, 50);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  const handleMainMenuKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (submenuRef.current && submenuRef.current.contains(e.target as Node)) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        onClose();
        return;
      }
      const openSubmenuKey = flyLeft ? 'ArrowLeft' : 'ArrowRight';
      if (e.key === openSubmenuKey && document.activeElement === submenuTriggerRef.current) {
        e.preventDefault();
        e.stopPropagation();
        openSubmenu();
        focusSubmenuItem('first');
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        return;
      }
      const items = getDirectMenuItems(menuRef.current, submenuRef.current);
      if (items.length === 0) return;
      const currentIdx = items.indexOf(document.activeElement as HTMLButtonElement);
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
      items[nextIdx]?.focus({ preventScroll: true });
    },
    [flyLeft, focusSubmenuItem, onClose, openSubmenu]
  );

  const handleSubmenuKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const closeSubmenuKey = flyLeft ? 'ArrowRight' : 'ArrowLeft';
      if (e.key === 'Escape' || e.key === closeSubmenuKey) {
        e.preventDefault();
        e.stopPropagation();
        clearCloseTimer();
        setIsSubmenuOpen(false);
        submenuTriggerRef.current?.focus({ preventScroll: true });
        return;
      }
      if (e.key === 'Tab') {
        onClose();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        return;
      }
      const items = getDirectMenuItems(submenuRef.current);
      if (items.length === 0) return;
      const currentIdx = items.indexOf(document.activeElement as HTMLButtonElement);
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
      items[nextIdx]?.focus({ preventScroll: true });
    },
    [clearCloseTimer, flyLeft, onClose]
  );

  if (!isOpen || !game) return null;

  const flyUp = typeof window !== 'undefined' && coords.y + 420 > window.innerHeight;
  const menuItemFocusClass =
    'focus-visible:outline-none focus-visible:bg-[#1b2838] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#66c0f4]';

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Game context menu"
      style={{
        left: `${coords.x}px`,
        top: `${coords.y}px`,
      }}
      className="fixed z-[9999] w-56 rounded-md bg-[#16202d] border border-[#2a475e] shadow-[0_10px_35px_rgba(0,0,0,0.9)] py-1.5 select-none text-xs text-slate-200"
      onKeyDown={handleMainMenuKeyDown}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Game Title Header */}
      <div className="px-3 py-1.5 border-b border-[#2a475e]/60 mb-1">
        <p className="font-semibold text-white truncate text-[11px] leading-tight" title={game.title}>
          {game.title}
        </p>
      </div>

      {/* Action 1: Fix Match & Metadata */}
      <button
        type="button"
        role="menuitem"
        onMouseEnter={() => scheduleCloseSubmenu(140)}
        onClick={() => {
          onClose();
          onFixMatch(game);
        }}
        className={`w-full min-h-6 flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[#1b2838] hover:text-[#66c0f4] transition-colors cursor-pointer group ${menuItemFocusClass}`}
      >
        <Wand
          aria-hidden="true"
          className="w-4 h-4 text-[#66c0f4] group-hover:scale-110 transition-transform"
        />
        <span className="font-medium">Fix Match &amp; Metadata...</span>
      </button>

      {/* Action 2: Sync Store Media (This Game) */}
      <button
        type="button"
        role="menuitem"
        onMouseEnter={() => scheduleCloseSubmenu(140)}
        onClick={() => {
          onClose();
          onSyncStoreMedia(game);
        }}
        className={`w-full min-h-6 flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[#1b2838] hover:text-white transition-colors cursor-pointer group ${menuItemFocusClass}`}
      >
        <Film
          aria-hidden="true"
          className="w-4 h-4 text-purple-400 group-hover:scale-110 transition-transform"
        />
        <span>Sync Store Media (This Game)</span>
      </button>

      {/* Action 3: View Achievements */}
      {onViewAchievements && (
        <button
          type="button"
          role="menuitem"
          onMouseEnter={() => scheduleCloseSubmenu(140)}
          onClick={() => {
            onClose();
            onViewAchievements(game);
          }}
          className={`w-full min-h-6 flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[#1b2838] hover:text-amber-400 transition-colors cursor-pointer group ${menuItemFocusClass}`}
        >
          <Trophy
            aria-hidden="true"
            className="w-4 h-4 text-amber-400 group-hover:scale-110 transition-transform"
          />
          <span>View Achievements...</span>
        </button>
      )}

      {/* Action 4: Assign to Collection (Branching Submenu) */}
      <div
        className="relative"
        onMouseEnter={openSubmenu}
        onMouseLeave={() => scheduleCloseSubmenu(260)}
      >
        <button
          ref={submenuTriggerRef}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={isSubmenuOpen}
          onClick={() => {
            clearCloseTimer();
            setIsSubmenuOpen((prev) => {
              const next = !prev;
              if (next) {
                focusSubmenuItem('first');
              }
              return next;
            });
          }}
          className={`w-full min-h-6 flex items-center justify-between px-3 py-2 text-left transition-colors cursor-pointer ${menuItemFocusClass} ${
            isSubmenuOpen ? 'bg-[#1b2838] text-white' : 'hover:bg-[#1b2838] hover:text-white'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <FolderPlus aria-hidden="true" className="w-4 h-4 text-sky-400" />
            <span>Assign to Collection</span>
          </div>
          <ChevronRight aria-hidden="true" className="w-3.5 h-3.5 text-slate-300" />
        </button>

        {/* Branching Submenu with continuous hover bridge corridor */}
        {isSubmenuOpen && (
          <div
            ref={submenuRef}
            onMouseEnter={openSubmenu}
            onMouseLeave={() => scheduleCloseSubmenu(220)}
            className={`absolute ${flyUp ? 'bottom-0' : 'top-0'} ${
              flyLeft ? 'right-full pr-1.5' : 'left-full pl-1.5'
            } z-50 before:content-[''] before:absolute before:-top-4 before:-bottom-4 ${
              flyLeft ? 'before:-right-3 before:w-4' : 'before:-left-3 before:w-4'
            }`}
          >
            <div
              role="menu"
              aria-label="Collections submenu"
              onKeyDown={handleSubmenuKeyDown}
              className="w-52 max-h-72 overflow-y-auto rounded-md bg-[#16202d] border border-[#2a475e] shadow-[0_10px_25px_rgba(0,0,0,0.85)] py-1.5"
            >
              <div className="px-3 py-1 border-b border-[#2a475e]/60 mb-1 text-[10px] uppercase font-bold text-slate-300 tracking-wider">
                Collections
              </div>

              {collections.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-slate-300 italic">
                  No collections created
                </div>
              ) : (
                collections.map((col) => {
                  const isAssigned = Array.isArray(col.gameIds) && col.gameIds.includes(game.id);
                  return (
                    <button
                      key={col.id}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={isAssigned}
                      onClick={() => {
                        onToggleCollection(col.id, game.id);
                      }}
                      className={`w-full min-h-6 flex items-center justify-between px-3 py-1.5 text-left hover:bg-[#1b2838] hover:text-white transition-colors cursor-pointer text-xs ${menuItemFocusClass}`}
                    >
                      <div className="flex items-center gap-2 min-w-0 pr-2">
                        <CollectionIcon
                          iconId={col.icon}
                          collectionId={col.id}
                          size={14}
                          className={
                            isAssigned ? 'text-[#66c0f4] shrink-0' : 'text-slate-400 shrink-0'
                          }
                        />
                        <span className="truncate">{col.name}</span>
                      </div>
                      {isAssigned && (
                        <Check
                          aria-hidden="true"
                          className="w-3.5 h-3.5 text-[#66c0f4] shrink-0 font-bold"
                        />
                      )}
                    </button>
                  );
                })
              )}

              <div role="separator" className="my-1 border-t border-[#2a475e]/60" />

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onClose();
                  onManageCollections(game);
                }}
                className={`w-full min-h-6 flex items-center gap-2 px-3 py-2 text-left hover:bg-[#1b2838] hover:text-[#66c0f4] transition-colors cursor-pointer text-xs text-slate-200 font-medium ${menuItemFocusClass}`}
              >
                <Sliders aria-hidden="true" className="w-3.5 h-3.5 text-[#66c0f4]" />
                <span>Manage Collections...</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Action 5: Hide / Suppress from Library */}
      {onHideGame && (
        <div
          className="mt-1 pt-1 border-t border-[#2a475e]/60"
          onMouseEnter={() => scheduleCloseSubmenu(140)}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              onHideGame(game);
            }}
            className={`w-full min-h-6 flex items-center gap-2.5 px-3 py-2 text-left text-rose-300 hover:bg-rose-950/50 hover:text-white transition-colors cursor-pointer group ${menuItemFocusClass}`}
          >
            <EyeOff
              aria-hidden="true"
              className="w-4 h-4 text-rose-400 group-hover:scale-110 transition-transform shrink-0"
            />
            <span>Hide / Suppress from Library</span>
          </button>
        </div>
      )}
    </div>
  );
};
