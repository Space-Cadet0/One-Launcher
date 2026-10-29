import React from 'react';
import { StorefrontId } from '../../../contracts/platform';
import { FastMinimalLaunchAdvisory, LaunchMethod } from '../../../contracts/launcher';
import { getStorefrontDisplayName } from '../../Common/StorefrontIcon';
import { ExternalLink, Zap } from 'lucide-react';

export interface FastLaunchWarningBannerProps {
  fastLaunchAdvisory: FastMinimalLaunchAdvisory;
  activeDisplayMethod: LaunchMethod;
  isInstalled: boolean;
  preferredPlatformId: StorefrontId;
  mode?: 'all' | 'fast_warning_only' | 'storefront_uri_only';
}

function FastLaunchWarningBannerImpl({
  fastLaunchAdvisory,
  activeDisplayMethod,
  isInstalled,
  preferredPlatformId,
  mode = 'all',
}: FastLaunchWarningBannerProps): React.ReactElement | null {
  const showFastWarning =
    mode !== 'storefront_uri_only' &&
    fastLaunchAdvisory.isActive &&
    activeDisplayMethod !== 'storefront_uri' &&
    isInstalled;
  const showStorefrontUriNotice =
    mode !== 'fast_warning_only' && activeDisplayMethod === 'storefront_uri' && isInstalled;

  if (!showFastWarning && !showStorefrontUriNotice) {
    return null;
  }

  const isWarningSeverity = fastLaunchAdvisory.severity === 'warning';
  const storefrontUriCloudSummary =
    preferredPlatformId === 'steam'
      ? 'Launch and Steam Cloud Sync are delegated directly to the Steam desktop client (steam://rungameid).'
      : preferredPlatformId === 'gog'
        ? "Launch and Cloud Save Sync are delegated to the official GOG Galaxy desktop client (goggalaxy://) rather than One Launcher's standalone CLI Cloud Save engine."
        : preferredPlatformId === 'epic'
          ? "Launch and Cloud Save Sync are delegated to the official Epic Games Launcher desktop client (com.epicgames.launcher://) rather than One Launcher's standalone CLI Cloud Save engine."
          : `Launch is handed off directly to the official ${getStorefrontDisplayName(preferredPlatformId)} desktop client via URI protocol.`;

  const storefrontUriHeading =
    preferredPlatformId === 'steam'
      ? 'Steam Protocol Launch (steam://rungameid)'
      : `Delegated to ${getStorefrontDisplayName(preferredPlatformId)} Desktop Client`;

  const storefrontUriBody =
    preferredPlatformId === 'steam'
      ? 'Launches via Steam protocol with two-way Steam Cloud Save Sync, Achievements/Trophies, and Steamworks DRM (client window vs silent auto-close behavior is controlled by Steam Launch Policy below). Custom executable, working directory, environment variable, and shell hook overrides require Direct mode.'
      : `${storefrontUriCloudSummary} Local executable, working directory, environment variable, and shell hook overrides are bypassed in this mode.`;

  return (
    <>
      {showFastWarning && (
        <div
          data-testid="fast-minimal-launch-warning"
          className={`rounded-lg p-3.5 space-y-2.5 text-xs border ${
            isWarningSeverity
              ? 'bg-amber-950/45 border-amber-500/45'
              : 'bg-sky-950/35 border-sky-500/40'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              className={`flex items-center gap-2 font-bold ${
                isWarningSeverity ? 'text-amber-300' : 'text-sky-300'
              }`}
            >
              <Zap
                className={`w-4 h-4 shrink-0 ${
                  isWarningSeverity ? 'text-amber-400' : 'text-sky-400'
                }`}
              />
              <span>{fastLaunchAdvisory.title}</span>
            </div>
            <span
              className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                isWarningSeverity
                  ? 'bg-amber-500/20 border-amber-400/40 text-amber-200'
                  : 'bg-sky-500/20 border-sky-400/40 text-sky-200'
              }`}
            >
              {fastLaunchAdvisory.footprintBenefit}
            </span>
          </div>

          {fastLaunchAdvisory.warnings.length > 0 && (
            <ul
              className={`list-disc pl-4 space-y-1 text-[11px] leading-relaxed ${
                isWarningSeverity ? 'text-amber-100/90' : 'text-sky-100/90'
              }`}
            >
              {fastLaunchAdvisory.warnings.map((warn, idx) => (
                <li key={idx}>{warn}</li>
              ))}
            </ul>
          )}

          <div
            className={`pt-1 border-t text-[11px] leading-relaxed ${
              isWarningSeverity
                ? 'border-amber-500/25 text-amber-200/90'
                : 'border-sky-500/25 text-sky-200/90'
            }`}
          >
            <span
              className={`font-semibold ${
                isWarningSeverity ? 'text-amber-300' : 'text-sky-300'
              }`}
            >
              Recommendation:{' '}
            </span>
            <span>{fastLaunchAdvisory.recommendation}</span>
          </div>
        </div>
      )}

      {showStorefrontUriNotice && (
        <div
          data-section="storefront-uri-notice"
          className="rounded-lg bg-[#0e151f] border border-[#26384d] p-3.5 flex items-start gap-2.5 text-xs text-steam-subtext"
        >
          <ExternalLink className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="font-bold text-white">{storefrontUriHeading}</div>
            <p className="text-[11px] leading-relaxed">{storefrontUriBody}</p>
          </div>
        </div>
      )}
    </>
  );
}

export const FastLaunchWarningBannerBase = FastLaunchWarningBannerImpl;
export const FastLaunchWarningBanner = React.memo(FastLaunchWarningBannerImpl);
FastLaunchWarningBanner.displayName = 'FastLaunchWarningBanner';
