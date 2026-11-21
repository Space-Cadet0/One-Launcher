import React from 'react';
import { AlertCircle, CheckCircle2, Cpu, Info, Link2 } from 'lucide-react';
import type { GameInstallInfo } from '../../../contracts/launcher';
import type { StorefrontId } from '../../../contracts/platform';

export interface InstallCompatibilityBannersProps {
  gameTitle: string;
  selectedPlatformId: StorefrontId;
  isWindowsHost: boolean;
  xboxCompat: GameInstallInfo['xboxCompatibility'] | undefined;
  isXboxMacBlocked: boolean;
  hasChainedBottleInstaller: boolean;
  isRiotKernelAntiCheat: boolean;
  hasKernelAntiCheatRequirement: boolean;
  isBattlEyeAntiCheat: boolean;
  detectedAntiCheatName?: string;
  isChainedWinInstaller: boolean;
  chainedLauncherName: string;
  showXboxPublisherAccountLinkCallout: boolean;
  handoffKeyLower: string;
  showMacKernelAntiCheatWarning: boolean;
}

export function InstallCompatibilityBannersBase({
  gameTitle,
  selectedPlatformId,
  isWindowsHost,
  xboxCompat,
  isXboxMacBlocked,
  hasChainedBottleInstaller,
  isRiotKernelAntiCheat,
  hasKernelAntiCheatRequirement,
  isBattlEyeAntiCheat,
  detectedAntiCheatName,
  isChainedWinInstaller,
  chainedLauncherName,
  showXboxPublisherAccountLinkCallout,
  handoffKeyLower,
  showMacKernelAntiCheatWarning,
}: InstallCompatibilityBannersProps): React.ReactElement | null {
  const showXboxTierBanner = selectedPlatformId === 'xbox' && !isWindowsHost && Boolean(xboxCompat);
  const showWinChainedNotice = isWindowsHost && isChainedWinInstaller;
  const showEaSsoGuidance =
    handoffKeyLower === 'ea' && selectedPlatformId !== 'ea' && selectedPlatformId !== 'xbox';

  if (
    !showXboxTierBanner &&
    !showWinChainedNotice &&
    !showXboxPublisherAccountLinkCallout &&
    !showEaSsoGuidance &&
    !showMacKernelAntiCheatWarning
  ) {
    return null;
  }

  return (
    <>
      {/* Xbox / MSIXVC Compatibility Tier Banner on macOS */}
      {showXboxTierBanner &&
        xboxCompat &&
        (() => {
          const isTierASupportedWithoutAntiCheat =
            xboxCompat.tier === 'tier_a_supported' && !hasKernelAntiCheatRequirement;
          const isChainedBottleSupportedTier =
            xboxCompat.tier === 'tier_c_external_launcher' &&
            hasChainedBottleInstaller &&
            !isRiotKernelAntiCheat &&
            !hasKernelAntiCheatRequirement;
          const isAmberTier =
            xboxCompat.tier === 'tier_b_legacy_uwp' ||
            (hasKernelAntiCheatRequirement && isBattlEyeAntiCheat);
          return (
            <div
              data-testid="xbox-compat-tier-banner"
              role={isXboxMacBlocked ? 'alert' : 'status'}
              className={`rounded-lg border p-3.5 space-y-1.5 text-xs ${
                isTierASupportedWithoutAntiCheat
                  ? 'bg-emerald-950/40 border-emerald-500/45 text-emerald-100'
                  : isChainedBottleSupportedTier
                    ? 'bg-sky-950/45 border-sky-500/45 text-sky-100'
                    : isAmberTier
                      ? 'bg-amber-950/55 border-amber-400/55 text-amber-100'
                      : 'bg-rose-950/55 border-rose-500/55 text-rose-100'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`inline-flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider ${
                    isTierASupportedWithoutAntiCheat
                      ? 'text-emerald-300'
                      : isChainedBottleSupportedTier
                        ? 'text-sky-300'
                        : isAmberTier
                          ? 'text-amber-200'
                          : 'text-rose-200'
                  }`}
                >
                  {isTierASupportedWithoutAntiCheat ? (
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  ) : isChainedBottleSupportedTier ? (
                    <Cpu className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  )}
                  <span>
                    {isTierASupportedWithoutAntiCheat
                      ? 'Tier A • Win32 GDK Package (CrossOver / Wine Supported)'
                      : isChainedBottleSupportedTier
                        ? `Chained Partner Launcher • Bottle Setup Supported (${chainedLauncherName})`
                        : hasKernelAntiCheatRequirement && isBattlEyeAntiCheat
                          ? 'Kernel Anti-Cheat Notice • BattlEye Online Multiplayer Blocked on macOS'
                          : hasKernelAntiCheatRequirement ||
                              xboxCompat.tier === 'tier_c_kernel_anticheat'
                            ? `Tier C • Kernel Anti-Cheat Blocker on macOS${
                                detectedAntiCheatName ? ` (${detectedAntiCheatName})` : ''
                              }`
                            : xboxCompat.tier === 'tier_b_legacy_uwp'
                              ? 'Tier B • Legacy UWP / AppContainer Warning'
                              : 'Tier C • External Partner Launcher Required (Windows Only)'}
                  </span>
                </span>
                {(xboxCompat.externalStorefront || xboxCompat.externalLauncher) && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-black/35 border border-white/15 font-bold uppercase tracking-wider">
                    {xboxCompat.externalStorefront || xboxCompat.externalLauncher}
                  </span>
                )}
              </div>
              {(xboxCompat.label || xboxCompat.summary) && !hasKernelAntiCheatRequirement && (
                <p className="font-semibold leading-snug">
                  {xboxCompat.label || xboxCompat.summary}
                </p>
              )}
              {xboxCompat.detail && !hasKernelAntiCheatRequirement && (
                <p className="text-[11px] opacity-90 leading-relaxed">{xboxCompat.detail}</p>
              )}
            </div>
          );
        })()}

      {/* Windows Chained Publisher Launcher Notice */}
      {showWinChainedNotice && (
        <div
          data-testid="chained-launcher-install-notice"
          role="status"
          className="rounded-lg bg-[#101e2e] border border-sky-500/45 p-3.5 space-y-1 text-xs text-slate-100"
        >
          <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider text-sky-300">
            <Info className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Chained Publisher Launcher ({chainedLauncherName})</span>
          </div>
          <p className="text-xs text-slate-200 leading-relaxed">
            {`One Launcher will set up or open ${chainedLauncherName} on Windows so you can sign in with your linked account and install ${gameTitle}.`}
          </p>
        </div>
      )}

      {/* Xbox <-> Publisher Account-Link Guidance */}
      {showXboxPublisherAccountLinkCallout && (
        <div
          data-testid="xbox-publisher-account-link-callout"
          role="note"
          className="rounded-lg bg-sky-950/60 border border-sky-400/55 p-3.5 space-y-1 text-xs text-sky-100"
        >
          <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider text-sky-200">
            <Link2 className="w-3.5 h-3.5 text-sky-300 shrink-0" aria-hidden="true" />
            <span>{`Xbox ↔ ${chainedLauncherName} Account Link Required`}</span>
          </div>
          <p className="text-xs text-sky-100 leading-relaxed">
            {`Xbox Game Pass unlocks this title inside ${chainedLauncherName} via server-side account linking. Sign in to ${chainedLauncherName} with the account linked to your Xbox profile to download and play.`}
          </p>
        </div>
      )}

      {/* EA Account SSO Linking Guidance (Epic / Steam -> EA App) */}
      {showEaSsoGuidance && (
        <div
          data-testid="ea-sso-linking-guidance"
          role="note"
          className="rounded-lg bg-sky-950/55 border border-sky-400/50 px-3.5 py-2.5 flex items-start gap-2 text-xs text-sky-100"
        >
          <Info className="w-4 h-4 text-sky-300 shrink-0 mt-0.5" aria-hidden="true" />
          <p className="leading-relaxed">
            Sign in to EA App with the EA Account linked to your Xbox / Epic / Steam account so your
            game entitlement activates.
          </p>
        </div>
      )}

      {/* macOS Bottled Kernel Anti-Cheat Pre-Download Compatibility Warning */}
      {showMacKernelAntiCheatWarning && (
        <div
          data-testid="macos-kernel-anticheat-warning"
          role={isXboxMacBlocked ? 'note' : 'status'}
          className={
            isBattlEyeAntiCheat
              ? 'rounded-lg bg-amber-950/65 border border-amber-400/60 p-3.5 space-y-1.5 text-xs text-amber-100'
              : 'rounded-lg bg-rose-950/65 border border-rose-500/60 p-3.5 space-y-1.5 text-xs text-rose-100'
          }
        >
          <div
            className={`flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider ${
              isBattlEyeAntiCheat ? 'text-amber-200' : 'text-rose-200'
            }`}
          >
            <AlertCircle
              className={`w-4 h-4 shrink-0 ${
                isBattlEyeAntiCheat ? 'text-amber-300' : 'text-rose-300'
              }`}
              aria-hidden="true"
            />
            <span>
              {isBattlEyeAntiCheat
                ? 'BattlEye Online Anti-Cheat Warning (macOS Bottle)'
                : `Kernel Anti-Cheat Compatibility Warning${
                    detectedAntiCheatName ? ` (${detectedAntiCheatName})` : ''
                  }`}
            </span>
          </div>
          <p
            className={`text-xs leading-relaxed ${
              isBattlEyeAntiCheat ? 'text-amber-100' : 'text-rose-100'
            }`}
          >
            {isBattlEyeAntiCheat
              ? 'Online multiplayer sessions requiring BattlEye (BEDaisy.sys Windows kernel driver) cannot load inside macOS Wine / CrossOver bottles, while offline single-player Story Mode (-nobattleye) remains playable where supported. Review compatibility before starting a large bottle download.'
              : `This Windows title requires ${
                  detectedAntiCheatName || 'kernel-level anti-cheat'
                }, whose Windows ring-0 kernel driver cannot load inside macOS Wine / CrossOver bottles. Review compatibility before starting a large bottle download, as startup or online play is blocked on macOS.`}
          </p>
        </div>
      )}
    </>
  );
}

export const InstallCompatibilityBanners = React.memo(InstallCompatibilityBannersBase);
InstallCompatibilityBanners.displayName = 'InstallCompatibilityBanners';
