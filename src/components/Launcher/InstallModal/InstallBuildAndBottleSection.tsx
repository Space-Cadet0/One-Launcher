import React from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Cpu, Loader2, Wrench } from 'lucide-react';
import type { CanonicalGame } from '../../../contracts/game';
import { type CompatibilityLayerInfo } from '../../../contracts/launcher';
import { type StorefrontId, STOREFRONT_REGISTRY } from '../../../contracts/platform';
import { isBottleNameCompatibleWithRunner } from '../../../services/launcher/bottleArchitectureUtils';
import { environmentSetupService } from '../../../services/launcher/environmentSetupService';
import { formatBytes, sanitizeGameInstallSizeBytes } from '../../../utils/formatBytes';
import { StorefrontIcon, getStorefrontDisplayName } from '../../Common/StorefrontIcon';
import { formatVersion, type InstallerItem } from './installModalHelpers';

export interface InstallStorefrontSelectorProps {
  idPrefix: string;
  game: CanonicalGame;
  selectedPlatformId: StorefrontId;
  onSelectPlatform: (platformId: StorefrontId) => void;
}

export function InstallStorefrontSelectorBase({
  idPrefix,
  game,
  selectedPlatformId,
  onSelectPlatform,
}: InstallStorefrontSelectorProps): React.ReactElement | null {
  if (game.platforms.length <= 1) return null;
  const storefrontGroupLabelId = `${idPrefix}-storefront-source-label`;
  return (
    <div className="space-y-1.5">
      <div
        id={storefrontGroupLabelId}
        className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext"
      >
        Select Storefront Source ({game.platforms.length} Owned)
      </div>
      <div
        role="group"
        aria-labelledby={storefrontGroupLabelId}
        className="grid grid-cols-2 sm:grid-cols-3 gap-2"
      >
        {game.platforms.map((plat) => {
          const isSelected = plat.platformId === selectedPlatformId;
          const reg = STOREFRONT_REGISTRY[plat.platformId];
          return (
            <button
              key={plat.platformId}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelectPlatform(plat.platformId)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                isSelected
                  ? plat.platformId === 'xbox'
                    ? 'bg-[#107c10]/25 border-[#52d652] text-white shadow-[0_0_12px_rgba(82,214,82,0.22)]'
                    : 'bg-sky-500/20 border-sky-400 text-white shadow-[0_0_12px_rgba(56,189,248,0.25)]'
                  : 'bg-[#17212e] border-[#26384d] text-steam-subtext hover:text-white hover:bg-[#1d2a3a]'
              }`}
            >
              <StorefrontIcon
                storefrontId={plat.platformId}
                decorative
                className={`w-4 h-4 ${
                  isSelected
                    ? plat.platformId === 'xbox'
                      ? 'text-[#52d652]'
                      : 'text-sky-400'
                    : 'text-steam-subtext'
                }`}
              />
              <span className="truncate">
                {reg?.name || getStorefrontDisplayName(plat.platformId)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export const InstallStorefrontSelector = React.memo(InstallStorefrontSelectorBase);
InstallStorefrontSelector.displayName = 'InstallStorefrontSelector';

export interface InstallBuildAndBottleSectionProps {
  idPrefix: string;
  game: CanonicalGame;
  selectedPlatformId: StorefrontId;
  isWindowsHost: boolean;
  isLoadingInfo: boolean;
  uniqueInstallers: InstallerItem[];
  hasMacBuildOption: boolean;
  macInstaller: InstallerItem | undefined;
  winInstaller: InstallerItem | undefined;
  selectedInstaller: InstallerItem | undefined;
  selectedInstallerId: string | undefined;
  selectedOs: 'mac' | 'windows' | 'linux';
  onSelectMacBuild: (installerId?: string) => void;
  onSelectWinBuild: (installerId?: string) => void;
  onSelectInstallerFromDropdown: (installerId: string) => void;
  isCrossPlatformMacLauncher: boolean;
  isXboxMacBlocked: boolean;
  hasKernelAntiCheatRequirement: boolean;
  detectedAntiCheatName?: string;
  isChainedBottleInstaller: boolean;
  chainedLauncherName: string;
  showPreinstallCompatConfig: boolean;
  compatLayers: CompatibilityLayerInfo[];
  allRawCompatLayers: CompatibilityLayerInfo[];
  activeCompatLayer: CompatibilityLayerInfo | undefined;
  effectiveCompatRunner: string;
  selectedBottleName: string;
  defaultResolvedBottleName: string;
  hasSelectedBottleArchMismatch: boolean;
  onChangeCompatRunner: (nextRunner: string) => void;
  onChangeBottleName: (nextBottle: string) => void;
}

export function InstallBuildAndBottleSectionBase({
  idPrefix,
  game,
  selectedPlatformId,
  isWindowsHost,
  isLoadingInfo,
  uniqueInstallers,
  hasMacBuildOption,
  macInstaller,
  winInstaller,
  selectedInstaller,
  selectedInstallerId,
  selectedOs,
  onSelectMacBuild,
  onSelectWinBuild,
  onSelectInstallerFromDropdown,
  isCrossPlatformMacLauncher,
  isXboxMacBlocked,
  hasKernelAntiCheatRequirement,
  detectedAntiCheatName,
  isChainedBottleInstaller,
  chainedLauncherName,
  showPreinstallCompatConfig,
  compatLayers,
  allRawCompatLayers,
  activeCompatLayer,
  effectiveCompatRunner,
  selectedBottleName,
  defaultResolvedBottleName,
  hasSelectedBottleArchMismatch,
  onChangeCompatRunner,
  onChangeBottleName,
}: InstallBuildAndBottleSectionProps): React.ReactElement | null {
  const installerGroupLabelId = `${idPrefix}-installer-build-label`;
  const installerSelectId = `${idPrefix}-installer-build-select`;
  const compatRunnerSelectId = `${idPrefix}-compat-runner`;
  const compatBottleSelectId = `${idPrefix}-compat-bottle`;

  const showsInstallerSelect =
    !isLoadingInfo &&
    uniqueInstallers.length > 1 &&
    !(macInstaller && winInstaller && uniqueInstallers.length <= 2);

  return (
    <>

      {/* Available Installer / OS Selector (hidden on Windows host since Windows builds are always native) */}
      {!isWindowsHost && (
        <div className="space-y-1.5">
          {showsInstallerSelect ? (
            <label
              htmlFor={installerSelectId}
              className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext"
            >
              Platform &amp; Installer Build
            </label>
          ) : (
            <div
              id={installerGroupLabelId}
              className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext"
            >
              Platform &amp; Installer Build
            </div>
          )}

          {isLoadingInfo ? (
            <div className="flex items-center gap-2 text-xs text-steam-subtext bg-[#17212e] border border-[#26384d] rounded-lg px-3.5 py-2.5">
              <Loader2 className="w-4 h-4 animate-spin text-sky-400" aria-hidden="true" />
              <span>Querying {getStorefrontDisplayName(selectedPlatformId)} build manifest...</span>
            </div>
          ) : uniqueInstallers.length === 1 ? (
            <div className="space-y-2">
              {selectedOs === 'mac' ? (
                <div className="rounded-lg bg-emerald-950/40 border border-emerald-500/40 p-3 space-y-1">
                  <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>
                      {isCrossPlatformMacLauncher
                        ? `★ AUTO-DETECTED • NATIVE MACOS LAUNCHER (${chainedLauncherName.toUpperCase()})`
                        : '★ AUTO-DETECTED • NATIVE MACOS BUILD'}
                    </span>
                  </div>
                  <p className="text-xs text-emerald-100/90 leading-relaxed">
                    {isCrossPlatformMacLauncher
                      ? `Official macOS ${chainedLauncherName} build — runs natively on your Mac without translation layers.`
                      : `Official macOS build${formatVersion(selectedInstaller?.version) ? ` (${formatVersion(selectedInstaller?.version)})` : ''}${sanitizeGameInstallSizeBytes(selectedInstaller?.totalSizeBytes) ? ` • ${formatBytes(sanitizeGameInstallSizeBytes(selectedInstaller?.totalSizeBytes))}` : ''} — runs natively on your Mac without translation layers.`}
                  </p>
                </div>
              ) : selectedOs === 'windows' ? (
                <div
                  data-testid={
                    isChainedBottleInstaller ? 'chained-launcher-install-notice' : undefined
                  }
                  className={
                    isXboxMacBlocked
                      ? 'rounded-lg bg-rose-950/45 border border-rose-500/45 p-3 space-y-1'
                      : 'rounded-lg bg-amber-950/50 border border-amber-500/40 p-3 space-y-1'
                  }
                >
                  <div
                    className={`flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider ${
                      isXboxMacBlocked ? 'text-rose-200' : 'text-amber-400'
                    }`}
                  >
                    {isXboxMacBlocked ? (
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <Cpu className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    )}
                    <span>
                      {isXboxMacBlocked
                        ? hasKernelAntiCheatRequirement
                          ? `WINDOWS BUILD • BLOCKED ON MACOS (${(detectedAntiCheatName || 'KERNEL ANTI-CHEAT').toUpperCase()})`
                          : 'WINDOWS BUILD • NATIVE WINDOWS REQUIRED'
                        : isChainedBottleInstaller
                          ? `WINDOWS BUILD • CHAINED BOTTLE LAUNCHER (${chainedLauncherName.toUpperCase()})`
                          : 'AUTO-DETECTED • WINDOWS BUILD (CROSSOVER / WINE)'}
                    </span>
                  </div>
                  <p
                    className={`text-xs leading-relaxed ${
                      isXboxMacBlocked ? 'text-rose-100/95' : 'text-amber-100/90'
                    }`}
                  >
                    {isXboxMacBlocked
                      ? hasKernelAntiCheatRequirement
                        ? `This Windows build requires ${detectedAntiCheatName || 'a Windows ring-0 kernel driver'} and cannot run inside macOS Wine / CrossOver bottles. Install and play on native Windows instead.`
                        : 'This Windows title cannot be installed or launched inside a macOS CrossOver / Wine bottle. Install and play on native Windows instead.'
                      : isChainedBottleInstaller
                        ? `One Launcher will automatically set up ${chainedLauncherName} inside your bottle if needed and open it so you can sign in with your linked account and install ${game.title}.`
                        : `No native macOS build exists for this game on ${getStorefrontDisplayName(selectedPlatformId)}. One Launcher will automatically install the Windows build${formatVersion(selectedInstaller?.version) ? ` (${formatVersion(selectedInstaller?.version)})` : ''}${sanitizeGameInstallSizeBytes(selectedInstaller?.totalSizeBytes) ? ` • ${formatBytes(sanitizeGameInstallSizeBytes(selectedInstaller?.totalSizeBytes))}` : ''} and run it via CrossOver / Wine.`}
                  </p>
                </div>
              ) : (
                <div className="rounded-lg bg-sky-950/40 border border-sky-500/40 p-3 space-y-1">
                  <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider text-sky-400">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>AUTO-DETECTED • LINUX BUILD</span>
                  </div>
                  <p className="text-xs text-sky-100/90 leading-relaxed">
                    {`Linux build${formatVersion(selectedInstaller?.version) ? ` (${formatVersion(selectedInstaller?.version)})` : ''}${sanitizeGameInstallSizeBytes(selectedInstaller?.totalSizeBytes) ? ` • ${formatBytes(sanitizeGameInstallSizeBytes(selectedInstaller?.totalSizeBytes))}` : ''}.`}
                  </p>
                </div>
              )}
            </div>
          ) : uniqueInstallers.length > 1 ? (
            <div className="space-y-2.5">
              {macInstaller && winInstaller && (
                <div
                  role="group"
                  aria-labelledby={!showsInstallerSelect ? installerGroupLabelId : undefined}
                  aria-label={showsInstallerSelect ? 'Platform & Installer Build' : undefined}
                  className="grid grid-cols-1 sm:grid-cols-2 gap-2.5"
                >
                  <button
                    type="button"
                    data-testid="install-option-mac-native"
                    aria-pressed={selectedOs === 'mac'}
                    onClick={() => onSelectMacBuild(macInstaller.id)}
                    className={`text-left rounded-lg p-3 border transition-colors cursor-pointer space-y-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                      selectedOs === 'mac'
                        ? 'bg-emerald-950/50 border-emerald-400 shadow-[0_0_14px_rgba(16,185,129,0.22)]'
                        : 'bg-[#17212e] border-[#26384d] hover:border-emerald-500/40 hover:bg-[#1b2736]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-[10px] font-extrabold uppercase tracking-wider text-emerald-300">
                        <CheckCircle2
                          className="w-3 h-3 text-emerald-400 shrink-0"
                          aria-hidden="true"
                        />
                        <span>★ Recommended • Native macOS</span>
                      </span>
                    </div>
                    <div className="text-xs font-bold text-white">Native macOS Build</div>
                    <p className="text-[11px] text-steam-subtext leading-relaxed">
                      Official macOS build — runs natively on your Mac without translation layers.
                      {formatVersion(macInstaller.version)
                        ? ` (${formatVersion(macInstaller.version)})`
                        : ''}
                      {sanitizeGameInstallSizeBytes(macInstaller.totalSizeBytes)
                        ? ` • ${formatBytes(sanitizeGameInstallSizeBytes(macInstaller.totalSizeBytes))}`
                        : ''}
                    </p>
                  </button>

                  <button
                    type="button"
                    data-testid="install-option-win-compat"
                    aria-pressed={selectedOs === 'windows'}
                    onClick={() => onSelectWinBuild(winInstaller.id)}
                    className={`text-left rounded-lg p-3 border transition-colors cursor-pointer space-y-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                      selectedOs === 'windows'
                        ? 'bg-amber-950/50 border-amber-400 shadow-[0_0_14px_rgba(245,158,11,0.22)]'
                        : 'bg-[#17212e] border-[#26384d] hover:border-amber-500/40 hover:bg-[#1b2736]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-[10px] font-extrabold uppercase tracking-wider text-amber-300">
                        <Cpu className="w-3 h-3 text-amber-400 shrink-0" aria-hidden="true" />
                        <span>Compatibility / Translation Layer</span>
                      </span>
                    </div>
                    <div className="text-xs font-bold text-white">
                      Windows Build (CrossOver / Wine)
                    </div>
                    <p className="text-[11px] text-steam-subtext leading-relaxed">
                      Installs the Windows build and runs via CrossOver, GPTK, or Wine translation.
                      {formatVersion(winInstaller.version)
                        ? ` (${formatVersion(winInstaller.version)})`
                        : ''}
                      {sanitizeGameInstallSizeBytes(winInstaller.totalSizeBytes)
                        ? ` • ${formatBytes(sanitizeGameInstallSizeBytes(winInstaller.totalSizeBytes))}`
                        : ''}
                    </p>
                  </button>
                </div>
              )}
              {showsInstallerSelect && (
                <select
                  id={installerSelectId}
                  aria-label="Installer Build"
                  value={selectedInstallerId || ''}
                  onChange={(e) => onSelectInstallerFromDropdown(e.target.value)}
                  className="w-full rounded-lg bg-[#17212e] border border-[#2a475e] px-3 py-2 text-xs text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus:border-sky-400"
                >
                  {uniqueInstallers.map((ins) => {
                    const ver = formatVersion(ins.version);
                    const validInsBytes = sanitizeGameInstallSizeBytes(ins.totalSizeBytes);
                    const sizeSuffix = validInsBytes ? ` • ${formatBytes(validInsBytes)}` : '';
                    const verSuffix = ver ? ` (${ver})` : '';
                    let optionLabel: string;
                    if (ins.os === 'mac') {
                      optionLabel = `★ Recommended: Native macOS Build${verSuffix}${sizeSuffix}`;
                    } else if (ins.os === 'windows') {
                      optionLabel = `${hasMacBuildOption ? 'Alternative: ' : ''}Windows Build via CrossOver / Wine${verSuffix}${sizeSuffix}`;
                    } else {
                      optionLabel = `Linux Build${verSuffix}${sizeSuffix}`;
                    }
                    return (
                      <option key={ins.id} value={ins.id}>
                        {optionLabel}
                      </option>
                    );
                  })}
                </select>
              )}
              {selectedOs === 'mac' && (
                <div className="flex items-start gap-2 text-[11px] text-emerald-300 bg-emerald-950/40 border border-emerald-500/40 rounded-lg px-3 py-2 leading-relaxed">
                  <CheckCircle2
                    className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <span>
                    ✓ Recommended: Official macOS build is available and auto-selected. Only choose
                    the Windows (CrossOver / Wine) alternative if this game is an older 32-bit Mac
                    port that won&apos;t launch on Apple Silicon.
                  </span>
                </div>
              )}
              {selectedOs === 'windows' && (
                <div className="flex items-start gap-2 text-[11px] text-amber-300 bg-amber-950/50 border border-amber-500/40 rounded-lg px-3 py-2 leading-relaxed">
                  <Cpu className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>
                    {hasMacBuildOption
                      ? 'Windows Compatibility Mode selected: Will install the Windows x64 build and run it through CrossOver / Wine instead of the native macOS build.'
                      : `No native macOS build exists for this game on ${getStorefrontDisplayName(selectedPlatformId)}. One Launcher will install the Windows build and run it via CrossOver / Wine.`}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div
              role="group"
              aria-labelledby={installerGroupLabelId}
              className="grid grid-cols-2 gap-2"
            >
              <button
                type="button"
                aria-pressed={selectedOs === 'mac'}
                onClick={() => onSelectMacBuild(undefined)}
                className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                  selectedOs === 'mac'
                    ? 'bg-sky-500/20 border-sky-400 text-white'
                    : 'bg-[#17212e] border-[#26384d] text-steam-subtext hover:text-white'
                }`}
              >
                <span>macOS / Auto-Detect</span>
              </button>
              <button
                type="button"
                aria-pressed={selectedOs === 'windows'}
                onClick={() => onSelectWinBuild(undefined)}
                className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                  selectedOs === 'windows'
                    ? 'bg-amber-500/20 border-amber-400 text-amber-200'
                    : 'bg-[#17212e] border-[#26384d] text-steam-subtext hover:text-white'
                }`}
              >
                <Cpu className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Windows (via CrossOver / Wine)</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Pre-Install Compatibility Runner & Bottle Selector */}
      {showPreinstallCompatConfig && (
        <div
          data-testid="preinstall-compat-config"
          className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-2.5"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-white">
                Compatibility Runner &amp; Target Bottle
              </span>
            </div>
            <span className="text-[10px] text-steam-subtext">Saved to game launch profile</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div className="space-y-1">
              <label
                htmlFor={compatRunnerSelectId}
                className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
              >
                Compatibility Runner
              </label>
              <select
                id={compatRunnerSelectId}
                data-testid="preinstall-compat-runner"
                aria-label="Compatibility Runner"
                value={effectiveCompatRunner}
                onChange={(e) => onChangeCompatRunner(e.target.value)}
                className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus:border-sky-400"
              >
                {compatLayers.map((layer) => (
                  <option key={layer.type} value={layer.type}>
                    {layer.name}
                    {layer.version ? ` (v${layer.version})` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label
                htmlFor={compatBottleSelectId}
                className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
              >
                Target Bottle
              </label>
              <select
                id={compatBottleSelectId}
                data-testid="preinstall-compat-bottle"
                aria-label="Target Bottle"
                aria-invalid={hasSelectedBottleArchMismatch || undefined}
                aria-describedby={
                  hasSelectedBottleArchMismatch ? 'preinstall-bottle-arch-warning' : undefined
                }
                value={selectedBottleName}
                onChange={(e) => onChangeBottleName(e.target.value)}
                className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus:border-sky-400"
              >
                <option value="">Default Bottle ({defaultResolvedBottleName})</option>
                {(activeCompatLayer?.availableBottles || []).map((bottle) => {
                  const bottleArch = activeCompatLayer?.bottleDetails?.[bottle]?.wineArch;
                  const isCompatible = isBottleNameCompatibleWithRunner(
                    bottle,
                    effectiveCompatRunner,
                    {
                      layer: activeCompatLayer,
                      allLayers: allRawCompatLayers,
                    }
                  );
                  const archLabel =
                    bottleArch === 'arm64'
                      ? ' (arm64 / FEX)'
                      : bottleArch === 'win64'
                        ? ' (Intel / win64)'
                        : '';
                  return (
                    <option key={bottle} value={bottle} disabled={!isCompatible}>
                      {bottle}
                      {archLabel}
                      {!isCompatible ? ' — incompatible' : ''}
                    </option>
                  );
                })}
              </select>
              {hasSelectedBottleArchMismatch && (
                <div
                  id="preinstall-bottle-arch-warning"
                  data-testid="preinstall-bottle-arch-warning"
                  role="alert"
                  className="flex items-start gap-1.5 rounded bg-amber-950/45 border border-amber-500/45 px-2 py-1 text-[10px] text-amber-200 mt-1"
                >
                  <AlertTriangle
                    className="w-3 h-3 text-amber-400 shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <span>
                    Bottle &ldquo;{selectedBottleName}&rdquo; is incompatible with{' '}
                    {effectiveCompatRunner === 'crossover_preview_arm64'
                      ? 'CrossOver Preview (arm64 / FEX) — choose an arm64 bottle like "OneLauncher-arm64".'
                      : 'this Intel/Rosetta runner — choose a win64 bottle like "OneLauncher".'}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {!isWindowsHost && selectedOs === 'windows' && compatLayers.length === 0 && (
        <div
          data-testid="missing-compat-runner-setup-callout"
          role="status"
          aria-live="polite"
          className="rounded-lg bg-amber-950/50 border border-amber-500/45 p-3.5 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-0.5 min-w-0">
              <div className="text-xs font-bold text-amber-200">
                Windows game support isn&rsquo;t set up yet
              </div>
              <p className="text-[11px] text-amber-100/90 leading-relaxed">
                Install CrossOver or Wine in Setup Wizard to play Windows games on your Mac.
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="open-setup-wizard-from-install-btn"
            onClick={() =>
              environmentSetupService.openWizard({
                mode: 'repair',
                initialStep: 'compatibility',
              })
            }
            className="min-h-6 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/25 hover:bg-amber-500/35 border border-amber-400 text-xs font-bold text-amber-100 hover:text-white transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 shrink-0"
          >
            <Wrench className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Setup Wizard...</span>
          </button>
        </div>
      )}
    </>
  );
}

export const InstallBuildAndBottleSection = React.memo(InstallBuildAndBottleSectionBase);
InstallBuildAndBottleSection.displayName = 'InstallBuildAndBottleSection';
