import React from 'react';
import { ResolvedLaunchModePreview } from '../../../contracts/launcher';
import { Activity, FileCode, FolderOpen } from 'lucide-react';

export interface ExecutableAndArgsSectionProps {
  preview: ResolvedLaunchModePreview;
  isWindowsHost: boolean;
  executablePathLabel: string;
  customExecutablePath: string;
  onChangeCustomExecutablePath: (value: string) => void;
  onBrowseExecutable: () => void;
  workingDirectory: string;
  onChangeWorkingDirectory: (value: string) => void;
  onBrowseWorkingDir: () => void;
  launchArguments: string;
  onChangeLaunchArguments: (value: string) => void;
  metalHud: boolean;
  onToggleMetalHud: () => void;
  sectionFilter?: 'all' | 'executable_only' | 'native_mac_only';
}

export function ExecutableAndArgsSection({
  preview,
  isWindowsHost,
  executablePathLabel,
  customExecutablePath,
  onChangeCustomExecutablePath,
  onBrowseExecutable,
  workingDirectory,
  onChangeWorkingDirectory,
  onBrowseWorkingDir,
  launchArguments,
  onChangeLaunchArguments,
  metalHud,
  onToggleMetalHud,
  sectionFilter = 'all',
}: ExecutableAndArgsSectionProps): React.ReactElement | null {
  const showExeSection =
    sectionFilter !== 'native_mac_only' && preview.visibleSections.executableAndArgs;
  const showNativeMacHud =
    sectionFilter !== 'executable_only' &&
    !isWindowsHost &&
    preview.visibleSections.nativeMacMetalHud;

  if (!showExeSection && !showNativeMacHud) {
    return null;
  }

  const isNativeMacTarget =
    !isWindowsHost &&
    (preview.detectedBuildType === 'mac_native_app' ||
      preview.detectedBuildType === 'mac_native_bin' ||
      (!preview.visibleSections.compatibilityLayer && preview.hasDualMacAndWinBuild));

  const executablePlaceholder = isWindowsHost
    ? 'Auto-detected from storefront manifest or select .exe...'
    : isNativeMacTarget
      ? 'Auto-detected from storefront manifest or select .app / binary...'
      : 'Auto-detected from storefront manifest or select manually...';

  const launchArgsPlaceholder = isNativeMacTarget
    ? 'e.g. -windowed -skipintro -fullscreen'
    : 'e.g. -windowed -skipintro -dx11';

  return (
    <>
      {showExeSection && (
        <div
          data-section="executable-and-args"
          className="grid grid-cols-1 gap-3.5 bg-[#0e151f] border border-[#223447] rounded-lg p-3.5"
        >
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1.5">
                <FileCode className="w-3.5 h-3.5 text-sky-400" />
                <span>{executablePathLabel}</span>
              </label>
              <span className="text-[10px] text-steam-subtext">
                Also links existing local installations
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={customExecutablePath}
                onChange={(e) => onChangeCustomExecutablePath(e.target.value)}
                placeholder={executablePlaceholder}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                className="flex-1 rounded-lg bg-[#141d2b] border border-[#2a475e] px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
              />
              <button
                type="button"
                onClick={onBrowseExecutable}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-xs font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer shrink-0"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>Browse Executable...</span>
              </button>
            </div>
          </div>

          {(preview.isInstalled || Boolean(customExecutablePath.trim())) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Working Directory */}
              <div className="space-y-1">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext">
                  Working Directory
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={workingDirectory}
                    onChange={(e) => onChangeWorkingDirectory(e.target.value)}
                    placeholder="Default game folder"
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                    className="flex-1 min-w-0 rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                  />
                  <button
                    type="button"
                    onClick={onBrowseWorkingDir}
                    className="px-2.5 py-1.5 rounded-lg bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-xs font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer shrink-0"
                  >
                    Browse...
                  </button>
                </div>
              </div>

              {/* Command-Line Arguments */}
              <div className="space-y-1">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext">
                  Launch Arguments
                </label>
                <input
                  type="text"
                  value={launchArguments}
                  onChange={(e) => onChangeLaunchArguments(e.target.value)}
                  placeholder={launchArgsPlaceholder}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Native macOS Performance & Overlay Card (shown for native macOS .app / Mach-O builds) */}
      {showNativeMacHud && (
        <div
          data-section="native-mac-settings"
          className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-2.5"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400" />
              <span className="text-xs font-bold text-white uppercase tracking-wider">
                macOS Native Performance &amp; Overlay
              </span>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-semibold">
              Apple Silicon / Metal Native
            </span>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-white">
                Apple Metal Performance HUD (MTL_HUD_ENABLED=1)
              </div>
              <div className="text-[10px] text-steam-subtext">
                Displays real-time Apple Metal FPS, frame timing, and GPU memory overlay
              </div>
            </div>
            <button
              type="button"
              aria-pressed={metalHud}
              onClick={onToggleMetalHud}
              className={`px-3 py-1 rounded-md text-xs font-bold border transition-colors shrink-0 cursor-pointer ${
                metalHud
                  ? 'bg-sky-500/20 border-sky-400 text-sky-300'
                  : 'bg-[#0e151f] border-[#26384d] text-steam-subtext hover:text-white'
              }`}
            >
              {metalHud ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
