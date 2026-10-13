import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { GameCollection } from '../../contracts/collection';
import {
  Wand,
  Film,
  FolderPlus,
  ChevronRight,
  Check,
  Folder,
  Sliders,
  Trophy,
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
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const [isSubmenuOpen, setIsSubmenuOpen] = useState(false);
  const [coords, setCoords] = useState<{ x: number; y: number }>({ x, y });
  const [flyLeft, setFlyLeft] = useState(false);

  // Recalculate coordinates whenever open or x/y changes to keep completely within viewport bounds
  useLayoutEffect(() => {
    if (!isOpen) {
      setIsSubmenuOpen(false);
      return;
    }

    const menuWidth = 230;
    const menuHeight = 150;
    const submenuWidth = 210;
    const padding = 8;

    let targetX = x;
    let targetY = y;

    // Viewport bounds clamp
    if (targetX + menuWidth + padding > window.innerWidth) {
      targetX = Math.max(padding, window.innerWidth - menuWidth - padding);
    }
    if (targetY + menuHeight + padding > window.innerHeight) {
      targetY = Math.max(padding, window.innerHeight - menuHeight - padding);
    }

    setCoords({ x: targetX, y: targetY });

    // Determine if the collection branching submenu should fly to the left
    if (targetX + menuWidth + submenuWidth + padding > window.innerWidth) {
      setFlyLeft(true);
    } else {
      setFlyLeft(false);
    }
  }, [isOpen, x, y]);

  // Handle outside click, window scroll, and escape key
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }

    function handleScroll(event: Event) {
      // Only close if scrolling an element outside the context menu
      if (menuRef.current && menuRef.current.contains(event.target as Node)) {
        return;
      }
      onClose();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    // Defer listener attachment to next tick (50ms) so the triggering right-click
    // or companion mousedown/contextmenu events do not immediately dismiss the menu!
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      window.addEventListener('scroll', handleScroll, true);
      document.addEventListener('keydown', handleKeyDown);
    }, 50);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen || !game) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Game context menu"
      style={{
        left: `${coords.x}px`,
        top: `${coords.y}px`,
      }}
      className="fixed z-[9999] w-56 rounded-md bg-[#16202d] border border-[#2a475e] shadow-[0_10px_35px_rgba(0,0,0,0.9)] py-1.5 backdrop-blur-md select-none text-xs text-slate-200 animate-in fade-in zoom-in-95 duration-100"
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
        onClick={() => {
          onClose();
          onFixMatch(game);
        }}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[#1b2838] hover:text-[#66c0f4] transition-colors cursor-pointer group"
      >
        <Wand className="w-4 h-4 text-[#66c0f4] group-hover:scale-110 transition-transform" />
        <span className="font-medium">Fix Match & Metadata...</span>
      </button>

      {/* Action 2: Sync Store Media (This Game) */}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onSyncStoreMedia(game);
        }}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[#1b2838] hover:text-white transition-colors cursor-pointer group"
      >
        <Film className="w-4 h-4 text-purple-400 group-hover:scale-110 transition-transform" />
        <span>Sync Store Media (This Game)</span>
      </button>

      {/* Action 3: View Achievements */}
      {onViewAchievements && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onViewAchievements(game);
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[#1b2838] hover:text-amber-400 transition-colors cursor-pointer group"
        >
          <Trophy className="w-4 h-4 text-amber-400 group-hover:scale-110 transition-transform" />
          <span>View Achievements...</span>
        </button>
      )}

      {/* Action 3: Assign to Collection (Branching Submenu) */}
      <div
        className="relative"
        onMouseEnter={() => setIsSubmenuOpen(true)}
        onMouseLeave={() => setIsSubmenuOpen(false)}
      >
        <button
          type="button"
          role="menuitem"
          aria-haspopup="true"
          aria-expanded={isSubmenuOpen}
          onClick={() => setIsSubmenuOpen((prev) => !prev)}
          className={`w-full flex items-center justify-between px-3 py-2 text-left transition-colors cursor-pointer ${
            isSubmenuOpen ? 'bg-[#1b2838] text-white' : 'hover:bg-[#1b2838] hover:text-white'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <FolderPlus className="w-4 h-4 text-sky-400" />
            <span>Assign to Collection</span>
          </div>
          <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
        </button>

        {/* Branching Submenu */}
        {isSubmenuOpen && (
          <div
            ref={submenuRef}
            role="menu"
            aria-label="Collections submenu"
            className={`absolute top-0 ${
              flyLeft ? 'right-full mr-1' : 'left-full ml-1'
            } w-52 max-h-72 overflow-y-auto rounded-md bg-[#16202d] border border-[#2a475e] shadow-[0_10px_25px_rgba(0,0,0,0.85)] py-1.5 z-50 backdrop-blur-md animate-in fade-in zoom-in-95 duration-100 custom-scrollbar`}
          >
            <div className="px-3 py-1 border-b border-[#2a475e]/60 mb-1 text-[10px] uppercase font-bold text-slate-400 tracking-wider">
              Collections
            </div>

            {collections.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-slate-400 italic">
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
                    className="w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-[#1b2838] hover:text-white transition-colors cursor-pointer text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0 pr-2">
                      <Folder className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="truncate">{col.name}</span>
                    </div>
                    {isAssigned && (
                      <Check className="w-3.5 h-3.5 text-[#66c0f4] shrink-0 font-bold" />
                    )}
                  </button>
                );
              })
            )}

            <div className="my-1 border-t border-[#2a475e]/60" />

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onClose();
                onManageCollections(game);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[#1b2838] hover:text-[#66c0f4] transition-colors cursor-pointer text-xs text-slate-300 font-medium"
            >
              <Sliders className="w-3.5 h-3.5 text-[#66c0f4]" />
              <span>Manage Collections...</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
