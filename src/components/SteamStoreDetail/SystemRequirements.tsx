import React, { useState, useEffect, useMemo } from 'react';
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

export const SystemRequirements: React.FC<SystemRequirementsProps> = ({
  gameId,
  requirements,
  macRequirements,
  linuxRequirements,
  metadataQuality,
}) => {
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

  const computePreferredTab = (): OsTabKey => {
    const isDarwinHost =
      typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';
    if (isDarwinHost && hasRequirementContent(macRequirements)) {
      return 'mac';
    }
    if (hasRequirementContent(requirements)) return 'windows';
    if (hasRequirementContent(macRequirements)) return 'mac';
    if (hasRequirementContent(linuxRequirements)) return 'linux';
    return 'windows';
  };

  const [selectedTab, setSelectedTab] = useState<OsTabKey>(computePreferredTab);

  useEffect(() => {
    if (gameId !== undefined) {
      setSelectedTab(computePreferredTab());
    }
  }, [gameId]);

  useEffect(() => {
    if (!availableTabs.some((t) => t.key === selectedTab)) {
      setSelectedTab(computePreferredTab());
    }
  }, [availableTabs, selectedTab]);

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
          <Cpu className="w-4 h-4 text-steam-accent" />
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
            {availableTabs.map((tab) => {
              const isActive = tab.key === activeEntry.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setSelectedTab(tab.key)}
                  className={`min-h-6 px-2.5 py-1 rounded text-xs font-semibold transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-[#2a475e] text-white shadow-sm'
                      : 'text-[#94a3b8] hover:text-white hover:bg-white/5'
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
