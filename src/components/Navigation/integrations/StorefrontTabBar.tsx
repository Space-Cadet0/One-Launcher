import React from 'react';
import type { StorefrontId } from '../../../contracts/platform';
import type { StorefrontIntegration } from '../../../contracts/integration';

export interface StorefrontTabBarProps {
  integrations: readonly StorefrontIntegration[];
  selectedTab: StorefrontId;
  tabIdPrefix: string;
  tabPanelId: string;
  tabButtonRefs: React.MutableRefObject<Record<string, HTMLButtonElement | null>>;
  onSelectTab: (storefrontId: StorefrontId) => void;
}

export const StorefrontTabBar: React.FC<StorefrontTabBarProps> = ({
  integrations,
  selectedTab,
  tabIdPrefix,
  tabPanelId,
  tabButtonRefs,
  onSelectTab,
}) => {
  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentIndex: number
  ) => {
    if (integrations.length === 0) return;
    let nextIndex = -1;
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % integrations.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + integrations.length) % integrations.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = integrations.length - 1;
    }
    if (nextIndex < 0) return;

    event.preventDefault();
    const nextStore = integrations[nextIndex].storefrontId;
    onSelectTab(nextStore);
    tabButtonRefs.current[nextStore]?.focus?.({ preventScroll: true });
  };

  return (
    <div
      role="tablist"
      aria-label="Storefront accounts"
      className="flex border-b border-steam-border/40 bg-[#121922] px-6 pt-3 gap-2"
    >
      {integrations.map((integ, idx) => {
        const isActive = selectedTab === integ.storefrontId;
        const tabId = `${tabIdPrefix}-${integ.storefrontId}`;
        return (
          <button
            key={integ.storefrontId}
            ref={(el) => {
              tabButtonRefs.current[integ.storefrontId] = el;
            }}
            id={tabId}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={tabPanelId}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelectTab(integ.storefrontId)}
            onKeyDown={(e) => handleTabKeyDown(e, idx)}
            className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t border-t border-x transition-colors relative cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent ${
              isActive
                ? 'bg-[#1b2838] border-steam-border text-white border-b-transparent shadow-md'
                : 'bg-black/20 border-transparent text-steam-subtext hover:text-white hover:bg-white/5'
            }`}
          >
            <span>{integ.name}</span>
            {integ.isConnected ? (
              <span
                aria-hidden="true"
                className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]"
              />
            ) : (
              <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-gray-600" />
            )}
          </button>
        );
      })}
    </div>
  );
};
