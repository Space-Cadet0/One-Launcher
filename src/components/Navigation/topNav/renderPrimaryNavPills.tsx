import React from 'react';
import { StorefrontId, STOREFRONT_REGISTRY } from '../../../contracts/platform';

export interface RenderPrimaryNavPillsArgs {
  visiblePlatforms: readonly (StorefrontId | 'all')[];
  selectedPlatform: StorefrontId | 'all';
  connectedSet: ReadonlySet<StorefrontId>;
  onSelectPlatform: (platform: StorefrontId | 'all') => void;
}

export function renderPrimaryNavPills({
  visiblePlatforms,
  selectedPlatform,
  connectedSet,
  onSelectPlatform,
}: RenderPrimaryNavPillsArgs): React.ReactElement {
  return (
    <nav
      aria-label="Primary"
      className="flex items-center gap-1.5 overflow-x-auto scrollbar-none min-w-0 flex-1 justify-start md:justify-center px-1"
    >
      {visiblePlatforms.map((p) => {
        const isSelected = selectedPlatform === p;
        const isConnected = p === 'all' || connectedSet.has(p);
        const meta = p === 'all' ? null : STOREFRONT_REGISTRY[p];
        const name = p === 'all' ? 'All Libraries' : meta?.name || p.toUpperCase();

        return (
          <button
            key={p}
            type="button"
            aria-pressed={isSelected}
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
    </nav>
  );
}
