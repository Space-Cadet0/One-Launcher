import React from 'react';
import type {
  EnvironmentComponentId,
  EnvironmentComponentState,
  EnvironmentHealthSnapshot,
  SetupWizardOpenMode,
} from '../../../../contracts/environmentSetup';
import type { CompatibilityLayerType } from '../../../../contracts/launcher';
import type { StorefrontId } from '../../../../contracts/platform';
import { StorefrontIcon } from '../../../Common/StorefrontIcon';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
} from 'lucide-react';

export interface StorefrontClientsStepProps {
  snapshot: EnvironmentHealthSnapshot;
  mode: SetupWizardOpenMode;
  chosenRunner: Exclude<CompatibilityLayerType, 'native'> | 'skip';
  connectedStorefronts: StorefrontId[];
  selectedIds: ReadonlySet<EnvironmentComponentId>;
  forceRepairIds: ReadonlySet<EnvironmentComponentId>;
  focusComponentId?: EnvironmentComponentId;
  onToggleComponent: (id: EnvironmentComponentId) => void;
  onToggleForceRepair: (id: EnvironmentComponentId) => void;
}

interface ClientCopyOverride {
  badge: string;
  badgeTone: 'recommended' | 'optional' | 'not_needed';
  explanation: string;
}

function getClientCopyOverrides(
  isMac: boolean,
  showBottleSection: boolean
): Record<
  Extract<
    EnvironmentComponentId,
    'bottle_steam' | 'host_steam' | 'bottle_gog' | 'host_gog' | 'bottle_epic' | 'host_epic'
  >,
  ClientCopyOverride
> {
  return {
    bottle_steam: {
      badge: 'Recommended',
      badgeTone: 'recommended',
      explanation: 'Needed to download and play Windows Steam games on your Mac.',
    },
    host_steam: {
      badge: 'Recommended',
      badgeTone: 'recommended',
      explanation: isMac
        ? showBottleSection
          ? 'Needed to download and play Mac Steam games. Uncheck if you only play Windows Steam games.'
          : 'Needed to download and play Mac Steam games.'
        : 'Needed to download and play your Steam games.',
    },
    host_gog: {
      badge: 'Optional — Achievements Only',
      badgeTone: 'optional',
      explanation:
        'Not needed to download or play games — downloads and cloud saves already work without it. Only install GOG Galaxy if you want achievements or multiplayer.',
    },
    bottle_gog: {
      badge: 'Optional — Achievements Only',
      badgeTone: 'optional',
      explanation:
        'Not needed to download or play games — downloads and cloud saves already work without it. Only install GOG Galaxy if you want achievements or multiplayer.',
    },
    host_epic: {
      badge: 'Not Needed',
      badgeTone: 'not_needed',
      explanation:
        'Not needed — downloads, cloud saves, achievements, and multiplayer already work without it. Only install if you want the Epic social overlay.',
    },
    bottle_epic: {
      badge: 'Not Needed',
      badgeTone: 'not_needed',
      explanation:
        'Not needed — downloads, cloud saves, achievements, and multiplayer already work without it. Only install if you want the Epic social overlay.',
    },
  };
}

const BOTTLE_CLIENT_IDS: ReadonlyArray<
  Extract<EnvironmentComponentId, 'bottle_steam' | 'bottle_gog' | 'bottle_epic'>
> = ['bottle_steam', 'bottle_gog', 'bottle_epic'];

const HOST_CLIENT_IDS: ReadonlyArray<
  Extract<EnvironmentComponentId, 'host_steam' | 'host_gog' | 'host_epic'>
> = ['host_steam', 'host_gog', 'host_epic'];

export const StorefrontClientsStep: React.FC<StorefrontClientsStepProps> = ({
  snapshot,
  mode,
  chosenRunner,
  connectedStorefronts,
  selectedIds,
  forceRepairIds,
  focusComponentId,
  onToggleComponent,
  onToggleForceRepair,
}) => {
  const isMac = snapshot.hostPlatform === 'darwin';
  const isWin = snapshot.hostPlatform === 'win32';
  const showBottleSection = isMac && chosenRunner !== 'skip';
  const isRepairCapableMode = mode === 'health_check' || mode === 'repair';
  const connectedSet = new Set<StorefrontId>(connectedStorefronts);
  const copyMap = getClientCopyOverrides(isMac, showBottleSection);

  const handleOpenExternal = (url?: string) => {
    if (!url) return;
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (typeof api?.openExternalUrl === 'function') {
      void api.openExternalUrl(url);
    } else if (typeof api?.openExternal === 'function') {
      void api.openExternal(url);
    } else if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const renderClientCard = (
    compId: Extract<
      EnvironmentComponentId,
      'bottle_steam' | 'host_steam' | 'bottle_gog' | 'host_gog' | 'bottle_epic' | 'host_epic'
    >
  ) => {
    const comp: EnvironmentComponentState | undefined = snapshot.components[compId];
    if (!comp) return null;

    const copy = copyMap[compId];
    const isReady = comp.status === 'ready';
    const isRemoved = Boolean(comp.wasPreviouslyConfigured && comp.status === 'missing');
    const isForceRepair = forceRepairIds.has(compId);
    const isChecked = isReady ? isForceRepair : selectedIds.has(compId);
    const isFocused = focusComponentId === compId;
    const storeConnected = comp.storefrontId ? connectedSet.has(comp.storefrontId) : false;

    const badgeClasses =
      copy.badgeTone === 'recommended'
        ? 'bg-sky-500/20 border-sky-400/50 text-sky-200'
        : copy.badgeTone === 'optional'
          ? 'bg-purple-500/20 border-purple-400/45 text-purple-200'
          : 'bg-[#131c27] border-[#2a475e] text-slate-200';

    return (
      <div
        key={compId}
        data-testid={`setup-client-card-${compId}`}
        className={`rounded-lg border p-3.5 transition-all ${
          isFocused
            ? 'bg-[#1b2838] border-[#66c0f4] shadow-lg shadow-[#66c0f4]/10'
            : isRemoved
              ? 'bg-amber-950/30 border-amber-500/50'
              : isChecked
                ? 'bg-[#1b2838] border-[#66c0f4]/75'
                : isReady
                  ? 'bg-[#16202d] border-emerald-500/45'
                  : 'bg-[#16202d] border-[#2a475e]/80 hover:border-[#66c0f4]/60'
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            <input
              type="checkbox"
              data-testid={`setup-toggle-${compId}`}
              aria-label={`Select ${comp.title}`}
              checked={isChecked}
              disabled={isReady && !isRepairCapableMode}
              onChange={() => {
                if (isReady) {
                  if (isRepairCapableMode) {
                    onToggleForceRepair(compId);
                  }
                } else {
                  onToggleComponent(compId);
                }
              }}
              className="mt-1 w-4 h-4 rounded border-[#2a475e] bg-[#131c27] text-[#66c0f4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            />

            <div className="space-y-1 min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {comp.storefrontId && (
                  <StorefrontIcon
                    storefrontId={comp.storefrontId}
                    decorative
                    className="w-3.5 h-3.5 text-[#66c0f4] shrink-0"
                  />
                )}
                <span className="text-xs font-bold text-white">{comp.title}</span>
                <span className={`text-[10px] px-2 py-0.5 rounded border font-bold ${badgeClasses}`}>
                  {copy.badge}
                </span>
                {storeConnected && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-semibold">
                    Account Connected
                  </span>
                )}
              </div>

              <p className="text-xs text-slate-200 leading-relaxed">{copy.explanation}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isRemoved ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/50 text-[10px] font-bold text-amber-200">
                <AlertTriangle className="w-3 h-3 text-amber-400" aria-hidden="true" />
                <span>Removed</span>
              </span>
            ) : isReady ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-[10px] font-bold text-emerald-300">
                <CheckCircle2 className="w-3 h-3 text-emerald-400" aria-hidden="true" />
                <span>Installed</span>
              </span>
            ) : (
              <span className="inline-flex items-center px-2 py-0.5 rounded bg-[#1b2838] border border-[#2a475e] text-[10px] font-semibold text-slate-300">
                Not Installed
              </span>
            )}

            {isReady && isRepairCapableMode && (
              <button
                type="button"
                data-testid={`setup-force-repair-${compId}`}
                onClick={() => onToggleForceRepair(compId)}
                className={`min-h-6 px-2.5 py-1 rounded-md border text-[11px] font-semibold transition-colors cursor-pointer inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4] ${
                  isForceRepair
                    ? 'bg-amber-500/20 border-amber-400 text-amber-200'
                    : 'bg-[#1b2838] hover:bg-[#24354a] border-[#2a475e] text-slate-200 hover:text-white hover:border-[#66c0f4]'
                }`}
              >
                <RefreshCw className="w-3 h-3" aria-hidden="true" />
                <span>{isForceRepair ? 'Queued' : 'Reinstall'}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  const xboxComp = snapshot.components.xbox_runtime;
  const showMissingWinGamingServices = isWin && xboxComp?.status === 'missing';

  const introCopy = showBottleSection
    ? 'Pick which store launchers to install. Steam is recommended; GOG and Epic already download and play without their apps.'
    : isMac
      ? 'Pick which Mac store launchers to install. Steam is recommended; GOG and Epic already download and play without their apps.'
      : 'Pick which store launchers to install on this PC. Steam is recommended; GOG and Epic already download and play without their apps.';

  return (
    <div className="space-y-4" data-testid="setup-step-clients">
      <div className="p-3 rounded-lg bg-[#131c27] border border-[#2a475e]/80 text-xs text-slate-200 leading-relaxed">
        {introCopy}
      </div>

      {/* Section 1: Windows Launchers on Mac (macOS with active runner only) */}
      {showBottleSection && (
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Launchers for Windows Games (on Mac)
            </span>
            <span className="text-[11px] text-slate-300">Steam is usually all you need</span>
          </div>

          <div className="space-y-2.5">
            {BOTTLE_CLIENT_IDS.map((id) => renderClientCard(id))}
          </div>
        </div>
      )}

      {/* Section 2: Host Launchers (Mac Launchers on macOS, Game Launchers on Windows) */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            {isMac ? 'Launchers for Mac Games' : 'Game Launchers'}
          </span>
          <span className="text-[11px] text-slate-300">GOG and Epic are optional</span>
        </div>

        <div className="space-y-2.5">
          {HOST_CLIENT_IDS.map((id) => renderClientCard(id))}
        </div>
      </div>

      {/* Actionable-only Windows Gaming Services card when missing on Windows */}
      {showMissingWinGamingServices && (
        <div
          data-testid="setup-client-card-xbox_runtime"
          className="rounded-lg bg-amber-950/30 border border-amber-500/45 p-3.5 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="space-y-1 min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <StorefrontIcon
                storefrontId="xbox"
                decorative
                className="w-4 h-4 text-[#52d652] shrink-0"
              />
              <span className="text-xs font-bold text-white">Microsoft Gaming Services</span>
              <span className="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/50 text-[10px] font-bold text-amber-200">
                Needed for Game Pass
              </span>
            </div>
            <p className="text-xs text-slate-200 leading-relaxed">
              Install Gaming Services from the Microsoft Store to play PC Game Pass games.
            </p>
          </div>
          {xboxComp?.externalDownloadUrl && (
            <button
              type="button"
              onClick={() => handleOpenExternal(xboxComp.externalDownloadUrl)}
              className="min-h-6 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#131c27] hover:bg-[#2a475e] border border-[#2a475e] text-xs font-semibold text-[#66c0f4] hover:text-white transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
            >
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Open Microsoft Store</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
