import React from 'react';
import { ChevronDown, Filter } from 'lucide-react';
import { STOREFRONT_REGISTRY, StorefrontId } from '../../../contracts/platform';
import { StorefrontIcon } from '../../Common/StorefrontIcon';
import { SIDEBAR_PLATFORMS } from './sidebarGroupingUtils';

export interface RenderSidebarStorefrontDropdownArgs {
  storesDropdownRef: React.RefObject<HTMLDivElement | null>;
  storesTriggerRef: React.RefObject<HTMLButtonElement | null>;
  storesMenuRef: React.RefObject<HTMLDivElement | null>;
  isStoresDropdownOpen: boolean;
  setIsStoresDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>;
  selectedPlatform: StorefrontId | 'all';
  onSelectPlatform: (p: StorefrontId | 'all') => void;
  connectedSet: Set<StorefrontId>;
  focusStoreMenuItem: (target: 'first' | 'last') => void;
}

export function renderSidebarStorefrontDropdown({
  storesDropdownRef,
  storesTriggerRef,
  storesMenuRef,
  isStoresDropdownOpen,
  setIsStoresDropdownOpen,
  selectedPlatform,
  onSelectPlatform,
  connectedSet,
  focusStoreMenuItem,
}: RenderSidebarStorefrontDropdownArgs): React.ReactElement {
  return (
    <div className="relative" ref={storesDropdownRef}>
      <button
        ref={storesTriggerRef}
        type="button"
        onClick={() => setIsStoresDropdownOpen((prev) => !prev)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Home') {
            e.preventDefault();
            setIsStoresDropdownOpen(true);
            focusStoreMenuItem('first');
          } else if (e.key === 'ArrowUp' || e.key === 'End') {
            e.preventDefault();
            setIsStoresDropdownOpen(true);
            focusStoreMenuItem('last');
          } else if (e.key === 'Escape' && isStoresDropdownOpen) {
            e.preventDefault();
            e.stopPropagation();
            setIsStoresDropdownOpen(false);
          }
        }}
        className={`min-h-6 flex items-center gap-1.5 text-[11px] px-2 py-1 rounded transition-colors cursor-pointer border select-none ${
          isStoresDropdownOpen
            ? 'bg-[#1b222d] text-white border-steam-accent/70 shadow-sm'
            : 'text-steam-subtext hover:text-white hover:bg-steam-card border-transparent'
        }`}
        title="Filter library by storefront"
        aria-haspopup="menu"
        aria-expanded={isStoresDropdownOpen}
      >
        <Filter aria-hidden="true" className="w-3 h-3 text-steam-accent" />
        <span className="capitalize font-medium truncate max-w-[100px]">
          {selectedPlatform === 'all'
            ? 'All Stores'
            : STOREFRONT_REGISTRY[selectedPlatform]?.name || selectedPlatform}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`w-3 h-3 text-steam-subtext transition-transform duration-200 ${
            isStoresDropdownOpen ? 'rotate-180 text-white' : ''
          }`}
        />
      </button>

      {isStoresDropdownOpen && (
        <div
          ref={storesMenuRef}
          role="menu"
          aria-label="Filter Storefront"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setIsStoresDropdownOpen(false);
              storesTriggerRef.current?.focus({ preventScroll: true });
              return;
            }
            if (e.key === 'Tab') {
              setIsStoresDropdownOpen(false);
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
            if (typeof HTMLElement !== 'undefined' && 'focusGroup' in HTMLElement.prototype) {
              return;
            }
            const items = Array.from(
              e.currentTarget.querySelectorAll<HTMLButtonElement>(
                'button[role^="menuitem"]:not(:disabled)'
              )
            );
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
                    : (currentIdx + (e.key === 'ArrowUp' ? -1 : 1) + items.length) %
                      items.length;
            e.preventDefault();
            items[nextIdx]?.focus({ preventScroll: true });
          }}
          className="absolute left-0 top-full mt-1 w-48 bg-[#1b222d] border border-steam-border rounded shadow-2xl py-1 z-50"
        >
          <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-300 border-b border-steam-border/40 mb-1">
            Filter Storefront
          </div>
          <div className="max-h-64 overflow-y-auto">
            {SIDEBAR_PLATFORMS.map((p) => {
              const isSelected = selectedPlatform === p;
              const isConnected = p === 'all' || connectedSet.has(p);
              const name =
                p === 'all' ? 'All Stores' : STOREFRONT_REGISTRY[p]?.name || p.toUpperCase();
              return (
                <button
                  key={p}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  onClick={() => {
                    onSelectPlatform(p);
                    setIsStoresDropdownOpen(false);
                  }}
                  className={`w-full min-h-6 text-left px-3 py-1.5 text-xs flex items-center justify-between hover:bg-[#253040] transition-colors ${
                    isSelected ? 'text-steam-accent font-bold bg-[#141b24]' : 'text-steam-text'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {p !== 'all' ? (
                      <StorefrontIcon storefrontId={p} className="w-3.5 h-3.5 shrink-0" />
                    ) : (
                      <Filter
                        aria-hidden="true"
                        className="w-3.5 h-3.5 text-steam-accent opacity-70 shrink-0"
                      />
                    )}
                    <span className="truncate">{name}</span>
                    {!isConnected && (
                      <span className="text-[10px] text-amber-400 font-normal shrink-0">
                        (Not Connected)
                      </span>
                    )}
                  </div>
                  {isSelected && (
                    <span className="w-1.5 h-1.5 rounded-full bg-steam-accent shrink-0 ml-1.5" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
