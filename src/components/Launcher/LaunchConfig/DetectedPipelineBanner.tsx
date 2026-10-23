import React from 'react';
import { CanonicalGame } from '../../../contracts/game';
import { StorefrontId } from '../../../contracts/platform';
import {
  ResolvedLaunchModePreview,
  StorefrontLaunchProfile,
} from '../../../contracts/launcher';
import { launcherService } from '../../../services/launcher/launcherService';
import { StorefrontIcon, getStorefrontDisplayName } from '../../Common/StorefrontIcon';
import { CheckCircle2 } from 'lucide-react';
import { getBadgeToneClasses } from './launchConfigHelpers';

export interface DetectedPipelineBannerProps {
  game: CanonicalGame;
  preview: ResolvedLaunchModePreview;
  buildBadgeTone: 'emerald' | 'sky' | 'amber' | 'slate';
  discoveredTargetPath?: string;
  preferredPlatformId: StorefrontId;
  draftsByPlatform: Partial<Record<StorefrontId, StorefrontLaunchProfile>>;
  onSelectStorefront: (platformId: StorefrontId) => void;
}

export function DetectedPipelineBanner({
  game,
  preview,
  buildBadgeTone,
  discoveredTargetPath,
  preferredPlatformId,
  draftsByPlatform,
  onSelectStorefront,
}: DetectedPipelineBannerProps): React.ReactElement {
  const isNativeInstalled =
    preview.detectedBuildType === 'mac_native_app' ||
    preview.detectedBuildType === 'mac_native_bin' ||
    preview.detectedBuildType === 'windows_native';

  return (
    <>
      {/* Detected Installation & Active Pipeline Banner */}
      <div className="rounded-lg bg-[#0e151f] border border-[#26384d] p-3.5 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext">
              Detected Installation
            </span>
            <span
              className={`text-[10px] px-2 py-0.5 rounded border font-bold ${getBadgeToneClasses(
                buildBadgeTone
              )}`}
            >
              {preview.detectedBuildLabel}
            </span>
          </div>
          <span className="text-[11px] text-steam-subtext">{preview.detectedBuildDetail}</span>
        </div>

        {discoveredTargetPath && (
          <div className="text-[11px] font-mono text-sky-300/90 bg-[#141d2b] border border-[#223447] rounded px-2.5 py-1 truncate">
            {discoveredTargetPath}
          </div>
        )}

        <div className="flex items-start gap-2 text-xs text-steam-text pt-0.5">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold text-white">
              {isNativeInstalled ? 'Active Launch Pipeline: ' : 'Auto-Detect Pipeline: '}
            </span>
            <span className="text-steam-subtext">{preview.autoResolvedSummary}</span>
          </div>
        </div>
      </div>

      {/* Storefront Installation Profile Selector (hidden for standalone custom games) */}
      {game.platforms.length >= 1 &&
        !(game.platforms.length === 1 && game.platforms[0]?.platformId === 'custom') && (
          <div className="space-y-1.5">
            <label className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext">
              {game.platforms.length > 1
                ? 'Storefront Installation Profile — Settings apply per storefront'
                : 'Active Storefront Profile'}
            </label>
            <div className="flex flex-wrap gap-2">
              {game.platforms.map((plat) => {
                const isSelected = plat.platformId === preferredPlatformId;
                const isPlatInstalled =
                  launcherService.isGameInstalled(game, plat.platformId) || Boolean(plat.installed);
                const hasCustomProfile = Boolean(
                  draftsByPlatform[plat.platformId] ||
                    launcherService.getLaunchConfig(game.id, plat.platformId)
                );
                return (
                  <button
                    key={plat.platformId}
                    type="button"
                    data-storefront-pill={plat.platformId}
                    aria-pressed={isSelected}
                    onClick={() => onSelectStorefront(plat.platformId)}
                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-sky-500/20 border-sky-400 text-white shadow-sm'
                        : 'bg-[#17212e] border-[#26384d] text-steam-subtext hover:text-white'
                    }`}
                  >
                    <StorefrontIcon
                      storefrontId={plat.platformId}
                      className={`w-3.5 h-3.5 ${isSelected ? 'text-sky-400' : 'text-steam-subtext'}`}
                    />
                    <span>{getStorefrontDisplayName(plat.platformId)}</span>
                    {isPlatInstalled ? (
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                        Installed
                      </span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-500/15 text-steam-subtext border border-slate-500/30">
                        Not Installed
                      </span>
                    )}
                    {hasCustomProfile && (
                      <span
                        className="text-[9px] px-1.5 py-0.2 rounded bg-sky-500/20 text-sky-300 border border-sky-500/40"
                        title="Custom launch profile configured for this storefront"
                      >
                        Configured
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
    </>
  );
}
