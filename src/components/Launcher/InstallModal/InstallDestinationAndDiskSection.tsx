import React from 'react';
import { AlertCircle, AlertTriangle, FolderOpen, HardDrive, Info } from 'lucide-react';
import type { ClientAuthProbeState } from '../../../contracts/environmentSetup';
import type { DiskSpaceInfo, GameInstallInfo } from '../../../contracts/launcher';
import type { StorefrontId } from '../../../contracts/platform';
import { environmentSetupService } from '../../../services/launcher/environmentSetupService';
import { formatBytes } from '../../../utils/formatBytes';
import { getStorefrontDisplayName } from '../../Common/StorefrontIcon';
import type { InstallMethodDescription } from './installModalHelpers';

export interface InstallDestinationAndDiskSectionProps {
  installDirInputId: string;
  selectedPlatformId: StorefrontId;
  isWindowsHost: boolean;
  selectedOs: 'mac' | 'windows' | 'linux';
  selectedBottleName: string;
  defaultResolvedBottleName: string;
  effectiveSteamDisplayPath: string;
  showSteamSignInHint: boolean;
  targetSteamLogin: ClientAuthProbeState | undefined;
  installInfo: GameInstallInfo | null;
  installDir: string;
  onDirectoryChange: (newDir: string, debounce?: boolean) => void;
  onBrowseFolder: () => void;
  diskSpace: DiskSpaceInfo | null;
  baseEstimatedBytes: number;
  knownDlcBytes: number;
  estimatedSizeBytes: number;
  usedPercent: number;
  installPercent: number;
  isVolumeMissing: boolean;
  hasEnoughSpaceOnTargetVolume: boolean;
  isExternalClientManagedDriveSelection: boolean;
  isCaseSensitiveTargetVolume: boolean;
  methodInfo: InstallMethodDescription;
  includeDlcs: boolean;
  onChangeIncludeDlcs: (next: boolean) => void;
  preferClientlessExtraction: boolean;
  onChangePreferClientlessExtraction: (next: boolean) => void;
  createShortcut: boolean;
  onChangeCreateShortcut: (next: boolean) => void;
  errorMsg: string | null;
}

export function InstallDestinationAndDiskSectionBase({
  installDirInputId,
  selectedPlatformId,
  isWindowsHost,
  selectedOs,
  selectedBottleName,
  defaultResolvedBottleName,
  effectiveSteamDisplayPath,
  showSteamSignInHint,
  targetSteamLogin,
  installInfo,
  installDir,
  onDirectoryChange,
  onBrowseFolder,
  diskSpace,
  baseEstimatedBytes,
  knownDlcBytes,
  estimatedSizeBytes,
  usedPercent,
  installPercent,
  isVolumeMissing,
  hasEnoughSpaceOnTargetVolume,
  isExternalClientManagedDriveSelection,
  isCaseSensitiveTargetVolume,
  methodInfo,
  includeDlcs,
  onChangeIncludeDlcs,
  preferClientlessExtraction,
  onChangePreferClientlessExtraction,
  createShortcut,
  onChangeCreateShortcut,
  errorMsg,
}: InstallDestinationAndDiskSectionProps): React.ReactElement {
  return (
    <>
      {/* Target Installation Directory */}
      {selectedPlatformId === 'steam' ? (
        <>
          {showSteamSignInHint && targetSteamLogin && (
            <div
              data-testid="steam-client-signin-hint-banner"
              className="rounded-lg bg-sky-950/50 border border-sky-400/45 p-3.5 flex flex-wrap items-center justify-between gap-3"
            >
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="space-y-0.5 min-w-0">
                  <div className="text-xs font-bold text-white">
                    {targetSteamLogin.accountMatchesOneLauncher === false
                      ? `${targetSteamLogin.label} is signed into a different account`
                      : `${targetSteamLogin.label} isn’t signed in yet`}
                  </div>
                  <p className="text-[11px] text-slate-200 leading-relaxed">
                    {targetSteamLogin.accountMatchesOneLauncher === false
                      ? 'Switch to your connected Steam account first, or click Install and switch when Steam opens.'
                      : 'Sign in first, or click Install and sign in when Steam opens.'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                data-testid="open-guided-signin-from-install-btn"
                onClick={() =>
                  environmentSetupService.openWizard({
                    mode: 'health_check',
                    initialStep: 'client_logins',
                  })
                }
                className="min-h-6 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400 text-xs font-bold text-sky-100 hover:text-white transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 shrink-0"
              >
                <span>Sign In to Steam...</span>
              </button>
            </div>
          )}

          <div
            data-testid="steam-managed-install-location"
            className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-2"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <FolderOpen className="w-3.5 h-3.5 text-sky-400 shrink-0" aria-hidden="true" />
                <span className="text-[11px] font-bold uppercase tracking-wider text-white">
                  Steam Library Location
                </span>
              </div>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-[10px] font-bold uppercase tracking-wider text-sky-300">
                Managed by Steam Client (steamapps/common)
              </span>
            </div>

            <div
              data-testid="steam-library-location-display"
              className="min-w-0 max-w-full overflow-hidden rounded-lg border border-white/10 bg-[#141821] px-3 py-2.5 space-y-1"
            >
              <code
                title={effectiveSteamDisplayPath}
                className="truncate block text-xs font-mono text-gray-200"
              >
                {effectiveSteamDisplayPath}
              </code>{' '}
              <div className="text-[10px] text-steam-subtext truncate">
                {!isWindowsHost && selectedOs === 'windows'
                  ? `CrossOver / Wine Bottle Steam Library (${
                      selectedBottleName || defaultResolvedBottleName
                    })`
                  : 'Native Steam Library'}
              </div>
            </div>

            <p className="text-[11px] text-steam-subtext leading-relaxed">
              Steam manages the installation folder for Steam games. You will select or confirm your
              target Steam Library drive inside the Steam installation dialog when it opens.
            </p>
          </div>
        </>
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label
              htmlFor={installDirInputId}
              className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext"
            >
              Installation Directory
            </label>
            {installInfo?.availableInstallDirs && installInfo.availableInstallDirs.length > 1 && (
              <select
                aria-label="Preset Installation Locations"
                value={
                  installInfo.availableInstallDirs
                    .filter(
                      (dir) => isWindowsHost || selectedOs !== 'windows' || dir !== '/Applications'
                    )
                    .includes(installDir)
                    ? installDir
                    : ''
                }
                onChange={(e) => {
                  if (e.target.value) onDirectoryChange(e.target.value);
                }}
                className="text-[11px] bg-[#17212e] border border-[#2a475e] rounded px-2 py-0.5 text-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus:border-sky-400"
              >
                <option value="" disabled>
                  Preset Locations...
                </option>
                {installInfo.availableInstallDirs
                  .filter(
                    (dir) => isWindowsHost || selectedOs !== 'windows' || dir !== '/Applications'
                  )
                  .map((dir) => (
                    <option key={dir} value={dir}>
                      {dir}
                    </option>
                  ))}
              </select>
            )}
          </div>

          <div className="flex items-center gap-2">
            <input
              id={installDirInputId}
              type="text"
              value={installDir}
              onChange={(e) => onDirectoryChange(e.target.value, true)}
              placeholder="~/Games/OneLauncher"
              autoComplete="off"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              className="flex-1 rounded-lg bg-[#0e151f] border border-[#2a475e] px-3 py-2 text-xs text-white font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus:border-sky-400"
            />
            <button
              type="button"
              onClick={onBrowseFolder}
              className="inline-flex items-center gap-1.5 min-h-6 px-3 py-2 rounded-lg bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-xs font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Browse...</span>
            </button>
          </div>
        </div>
      )}

      {/* Live Disk Space Indicator Bar */}
      <div className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5 text-steam-subtext font-medium">
            <HardDrive className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
            <span>Disk Space</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-steam-subtext">
              Estimated Size:{' '}
              <strong className="text-white">
                {estimatedSizeBytes > 0 ? formatBytes(estimatedSizeBytes) : 'Store Managed'}
              </strong>
            </span>
            <span className="text-steam-subtext">
              Free Space:{' '}
              <strong
                className={
                  hasEnoughSpaceOnTargetVolume
                    ? 'text-emerald-400'
                    : isExternalClientManagedDriveSelection
                      ? 'text-amber-400'
                      : 'text-red-400'
                }
              >
                {isVolumeMissing
                  ? 'Not Mounted'
                  : diskSpace
                    ? formatBytes(diskSpace.freeBytes)
                    : 'Checking...'}
              </strong>
            </span>
          </div>
        </div>

        {/* Storage Progress Bar */}
        <progress
          className="sr-only"
          max={100}
          value={Math.min(100, usedPercent + installPercent)}
          aria-label="Target volume storage usage"
        />
        <div
          aria-hidden="true"
          className="w-full h-2 rounded-full bg-[#1b2838] overflow-hidden flex"
        >
          <div
            className="h-full bg-slate-600"
            style={{ width: `${usedPercent}%` }}
            title={`Used Space: ${usedPercent}%`}
          />
          {installPercent > 0 && (
            <div
              className={`h-full ${
                hasEnoughSpaceOnTargetVolume
                  ? 'bg-sky-400'
                  : isExternalClientManagedDriveSelection
                    ? 'bg-amber-400'
                    : 'bg-red-500'
              }`}
              style={{ width: `${installPercent}%` }}
              title={`Required for Install: ${formatBytes(estimatedSizeBytes)}`}
            />
          )}
        </div>

        {isVolumeMissing && !isExternalClientManagedDriveSelection ? (
          <div role="alert" className="flex items-center gap-1.5 text-[11px] text-red-400 pt-0.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Selected target drive or volume is not currently mounted.</span>
          </div>
        ) : !hasEnoughSpaceOnTargetVolume && isExternalClientManagedDriveSelection ? (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-1.5 text-[11px] text-amber-300 pt-0.5"
          >
            <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" aria-hidden="true" />
            <span>
              {selectedPlatformId === 'steam'
                ? 'Default library volume has less free space than estimated. You can select another drive with sufficient space inside Steam when prompted.'
                : `Default library volume has less free space than estimated. You can select another drive with sufficient space inside ${getStorefrontDisplayName(selectedPlatformId)} when prompted.`}
            </span>
          </div>
        ) : !hasEnoughSpaceOnTargetVolume ? (
          <div role="alert" className="flex items-center gap-1.5 text-[11px] text-red-400 pt-0.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Insufficient disk space on target volume for this installation.</span>
          </div>
        ) : null}

        {(selectedPlatformId === 'epic' || selectedPlatformId === 'gog') && includeDlcs && (
          <div
            data-testid="dlc-disk-space-note"
            className="flex items-center gap-1.5 text-[11px] text-steam-subtext pt-0.5"
          >
            <Info className="w-3.5 h-3.5 text-sky-400 shrink-0" aria-hidden="true" />
            <span>
              {knownDlcBytes > 0
                ? `Includes +${formatBytes(knownDlcBytes)} for owned DLCs & expansions alongside the ${formatBytes(baseEstimatedBytes)} base game.`
                : 'Base game size shown above; total required disk space may increase when owned DLCs & expansions are included.'}
            </span>
          </div>
        )}

        {isCaseSensitiveTargetVolume && (
          <div
            data-testid="macos-case-sensitive-volume-warning"
            role="status"
            className="mt-1.5 rounded-lg bg-amber-950/60 border border-amber-400/55 p-2.5 flex items-start gap-2 text-xs text-amber-100"
          >
            <AlertTriangle
              className="w-4 h-4 text-amber-300 shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <div className="space-y-0.5 leading-relaxed">
              <div className="font-bold text-amber-200 uppercase tracking-wider text-[10px]">
                Case-Sensitive APFS Volume Detected
              </div>
              <p className="text-[11px] text-amber-100">
                This target drive uses Case-Sensitive APFS. Many Windows games and publisher
                launchers expect case-insensitive paths and may fail to locate assets inside Wine /
                CrossOver. Selecting a standard case-insensitive APFS volume is recommended.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Installation Method Notice */}
      <div className="rounded-lg bg-[#162231]/90 border border-[#2a475e]/70 p-3 flex items-start gap-2.5 text-xs">
        <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-0.5">
          <div className="font-semibold text-white flex items-center gap-1.5">
            <span>{methodInfo.title}</span>
            {selectedPlatformId === 'gog' && (
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold">
                DRM-Free Direct
              </span>
            )}
          </div>
          <p className="text-[11px] text-steam-subtext leading-relaxed">{methodInfo.desc}</p>
        </div>
      </div>

      {/* Owned DLCs & Expansions Toggle (GOG & Epic) */}
      {(selectedPlatformId === 'gog' || selectedPlatformId === 'epic') && (
        <label className="flex items-start gap-2.5 rounded-lg bg-[#0e151f] border border-[#223447] p-3 text-xs text-steam-text cursor-pointer hover:border-[#2a475e] transition-colors">
          <input
            type="checkbox"
            data-testid="toggle-include-dlcs"
            checked={includeDlcs}
            aria-checked={includeDlcs}
            onChange={(e) =>
              onChangeIncludeDlcs(
                typeof e?.target?.checked === 'boolean' ? e.target.checked : !includeDlcs
              )
            }
            className="mt-0.5 rounded border-steam-border bg-[#0e151f] text-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          />
          <div className="space-y-0.5 min-w-0">
            <div className="font-semibold text-white">Include Owned DLCs &amp; Expansions</div>
            <div className="text-[11px] text-steam-subtext leading-snug">
              {knownDlcBytes > 0
                ? `Downloads owned expansions, season pass content, and bonus DLC depots alongside the base game (+${formatBytes(knownDlcBytes)})`
                : 'Downloads owned expansions, season pass content, and bonus DLC depots alongside the base game'}
            </div>
          </div>
        </label>
      )}

      {/* Advanced Clientless MSIXVC Extraction Option (Windows Xbox when supported) */}
      {selectedPlatformId === 'xbox' && isWindowsHost && installInfo?.canDirectDownload && (
        <div className="flex items-start gap-2.5 rounded-lg bg-[#0e151f] border border-[#223447] p-3 text-xs text-steam-text hover:border-[#2a475e] transition-colors">
          <input
            id="xbox-prefer-clientless-extraction"
            type="checkbox"
            data-testid="toggle-xbox-clientless-extraction"
            checked={preferClientlessExtraction}
            aria-describedby="xbox-prefer-clientless-desc"
            onChange={(e) => onChangePreferClientlessExtraction(e.target.checked)}
            className="mt-0.5 rounded border-steam-border bg-[#0e151f] text-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 cursor-pointer"
          />
          <div className="space-y-0.5 min-w-0">
            <label
              htmlFor="xbox-prefer-clientless-extraction"
              className="font-semibold text-white cursor-pointer block"
            >
              Prefer Clientless MSIXVC Extraction (Advanced)
            </label>
            <div
              id="xbox-prefer-clientless-desc"
              className="text-[11px] text-steam-subtext leading-snug"
            >
              Extracts standard Win32 GDK files directly into your custom directory instead of
              delegating installation to Microsoft Store / GamingServices.
            </div>
          </div>
        </div>
      )}

      {/* Options Checkbox */}
      <label className="flex items-center gap-2 text-xs text-steam-text cursor-pointer">
        <input
          type="checkbox"
          checked={createShortcut}
          onChange={(e) => onChangeCreateShortcut(e.target.checked)}
          className="rounded border-steam-border bg-[#0e151f] text-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        />
        <span>Automatically register executable &amp; launch configuration on completion</span>
      </label>

      {errorMsg && (
        <div
          role="alert"
          className="rounded-lg bg-red-950/70 border border-red-500/50 p-3 text-xs text-red-200 flex items-center gap-2"
        >
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" aria-hidden="true" />
          <span>{errorMsg}</span>
        </div>
      )}
    </>
  );
}

export const InstallDestinationAndDiskSection = React.memo(InstallDestinationAndDiskSectionBase);
InstallDestinationAndDiskSection.displayName = 'InstallDestinationAndDiskSection';
