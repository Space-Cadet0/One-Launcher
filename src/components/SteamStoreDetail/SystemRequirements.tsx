import React, { useState, useEffect, useMemo, useRef } from 'react';
import { SteamSystemRequirements } from '../../contracts/steam';
import { MetadataQuality } from '../../contracts/network';
import { onlineLifecycleManager } from '../../services/network/onlineLifecycleManager';
import { SanitizedHtmlBlock } from '../../utils/safeHtmlSanitizer';
import { Cpu } from 'lucide-react';

export interface SystemRequirementsProps {
  gameId?: string;
  requirements?: SteamSystemRequirements;
  macRequirements?: SteamSystemRequirements;
  linuxRequirements?: SteamSystemRequirements;
  metadataQuality?: MetadataQuality;
}

type OsTabKey = 'windows' | 'mac' | 'linux';

function hasRequirementContent(req?: SteamSystemRequirements | null): req is SteamSystemRequirements {
  return Boolean(req && (req.minimum?.trim() || req.recommended?.trim()));
}

const OS_TAB_LABELS: Record<OsTabKey, string> = {
  windows: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
};

function computePreferredOsTab(
  requirements?: SteamSystemRequirements,
  macRequirements?: SteamSystemRequirements,
  linuxRequirements?: SteamSystemRequirements
): OsTabKey {
  const isDarwinHost =
    typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';
  if (isDarwinHost && hasRequirementContent(macRequirements)) {
    return 'mac';
  }
  if (hasRequirementContent(requirements)) return 'windows';
  if (hasRequirementContent(macRequirements)) return 'mac';
  if (hasRequirementContent(linuxRequirements)) return 'linux';
  return 'windows';
}

export const SystemRequirements: React.FC<SystemRequirementsProps> = ({
  gameId,
  requirements,
  macRequirements,
  linuxRequirements,
  metadataQuality,
}) => {
  const panelId = 'sysreq-tabpanel';
  const userSelectedTabRef = useRef(false);
  const tabButtonRefs = useRef<Partial<Record<OsTabKey, HTMLButtonElement | null>>>({});

  const availableTabs = useMemo(() => {
    const list: Array<{ key: OsTabKey; label: string; specs: SteamSystemRequirements }> = [];
    if (hasRequirementContent(requirements)) {
      list.push({ key: 'windows', label: OS_TAB_LABELS.windows, specs: requirements });
    }
    if (hasRequirementContent(macRequirements)) {
      list.push({ key: 'mac', label: OS_TAB_LABELS.mac, specs: macRequirements });
    }
    if (hasRequirementContent(linuxRequirements)) {
      list.push({ key: 'linux', label: OS_TAB_LABELS.linux, specs: linuxRequirements });
    }
    return list;
  }, [requirements, macRequirements, linuxRequirements]);

  const [selectedTab, setSelectedTab] = useState<OsTabKey>(() =>
    computePreferredOsTab(requirements, macRequirements, linuxRequirements)
  );

  useEffect(() => {
    userSelectedTabRef.current = false;
    setSelectedTab(computePreferredOsTab(requirements, macRequirements, linuxRequirements));
  }, [gameId]);

  useEffect(() => {
    if (!availableTabs.some((t) => t.key === selectedTab)) {
      setSelectedTab(computePreferredOsTab(requirements, macRequirements, linuxRequirements));
      return;
    }
    if (!userSelectedTabRef.current) {
      const preferred = computePreferredOsTab(requirements, macRequirements, linuxRequirements);
      if (preferred !== selectedTab && availableTabs.some((t) => t.key === preferred)) {
        setSelectedTab(preferred);
      }
    }
  }, [availableTabs, selectedTab, requirements, macRequirements, linuxRequirements]);

  if (availableTabs.length === 0) {
    const isUnsyncedFallback =
      metadataQuality === 'skeleton_fallback' ||
      (!metadataQuality && !onlineLifecycleManager.isOnline());
    return (
      <div className="p-4 bg-steam-card rounded border border-steam-border text-sm text-steam-subtext">
        {isUnsyncedFallback
          ? 'System specifications pending online sync.'
          : 'System specifications not provided by developer.'}
      </div>
    );
  }

  const activeEntry =
    availableTabs.find((t) => t.key === selectedTab) || availableTabs[0];
  const activeSpecs = activeEntry.specs;

  const handleTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    currentIndex: number
  ) => {
    const count = availableTabs.length;
    if (count <= 1) return;

    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % count;
    } else if (e.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + count) % count;
    } else if (e.key === 'Home') {
      nextIndex = 0;
    } else if (e.key === 'End') {
      nextIndex = count - 1;
    }

    if (nextIndex === null) return;
    if (typeof e.preventDefault === 'function') {
      e.preventDefault();
    }

    const nextTab = availableTabs[nextIndex];
    if (!nextTab) return;

    userSelectedTabRef.current = true;
    setSelectedTab(nextTab.key);

    const targetBtn = tabButtonRefs.current[nextTab.key];
    if (targetBtn && typeof targetBtn.focus === 'function') {
      targetBtn.focus();
    } else {
      const siblingTabs =
        e.currentTarget?.parentElement?.querySelectorAll?.('[role="tab"]');
      const fallbackBtn = siblingTabs?.[nextIndex] as HTMLElement | undefined;
      if (fallbackBtn && typeof fallbackBtn.focus === 'function') {
        fallbackBtn.focus();
      }
    }
  };

  const renderCleanHtml = (htmlContent: string) => {
    return (
      <SanitizedHtmlBlock
        html={htmlContent}
        className="text-xs leading-relaxed text-[#acb2b8] space-y-1 [&_strong]:text-white [&_ul]:space-y-1 [&_li]:list-none [&_li]:pl-0 [&_h2]:text-sm [&_h2]:text-steam-accent [&_h2]:font-bold [&_h2]:mb-2"
      />
    );
  };

  return (
    <div className="w-full bg-[#16202d] rounded border border-steam-border p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-steam-border/60 pb-3">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-steam-accent" aria-hidden="true" />
          <h3 className="text-sm font-bold tracking-wider text-steam-accent uppercase">
            {availableTabs.length > 1
              ? 'System Requirements'
              : `System Requirements (${activeEntry.key === 'windows' ? 'PC' : activeEntry.label})`}
          </h3>
        </div>

        {availableTabs.length > 1 && (
          <div
            className="flex items-center gap-1 bg-[#0e151f] p-1 rounded border border-[#2a475e]/60"
            role="tablist"
            aria-label="Operating system requirements"
          >
            {availableTabs.map((tab, index) => {
              const isActive = tab.key === activeEntry.key;
              return (
                <button
                  key={tab.key}
                  ref={(el) => {
                    tabButtonRefs.current[tab.key] = el;
                  }}
                  id={`sysreq-tab-${tab.key}`}
                  type="button"
                  role="tab"
                  tabIndex={isActive ? 0 : -1}
                  aria-selected={isActive}
                  aria-controls={panelId}
                  onClick={() => {
                    userSelectedTabRef.current = true;
                    setSelectedTab(tab.key);
                  }}
                  onKeyDown={(e) => handleTabKeyDown(e, index)}
                  className={`min-h-6 px-2.5 py-1 rounded text-xs font-semibold transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-400 ${
                    isActive
                      ? 'bg-[#2a475e] text-white shadow-sm'
                      : 'text-[#cbd5e1] hover:text-white hover:bg-white/5'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div
        id={panelId}
        role={availableTabs.length > 1 ? 'tabpanel' : undefined}
        aria-labelledby={
          availableTabs.length > 1 ? `sysreq-tab-${activeEntry.key}` : undefined
        }
        className={`grid grid-cols-1 ${
          activeSpecs.minimum && activeSpecs.recommended ? 'md:grid-cols-2' : ''
        } gap-6`}
      >
        {/* Minimum Specs */}
        {activeSpecs.minimum && (
          <div className="bg-[#101720]/80 p-4 rounded border border-steam-border/40">
            {renderCleanHtml(activeSpecs.minimum)}
          </div>
        )}

        {/* Recommended Specs */}
        {activeSpecs.recommended && (
          <div className="bg-[#101720]/80 p-4 rounded border border-steam-border/40">
            {renderCleanHtml(activeSpecs.recommended)}
          </div>
        )}
      </div>
    </div>
  );
};
