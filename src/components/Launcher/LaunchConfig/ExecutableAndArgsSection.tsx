import React from 'react';
import { ResolvedLaunchModePreview } from '../../../contracts/launcher';
import { Activity, FileCode, FolderOpen } from 'lucide-react';
import {
  LAUNCH_BUTTON_FOCUS_CLASSES,
  LAUNCH_TEXT_INPUT_CLASSES,
  SwitchControl,
} from './LaunchConfigControls';

export interface ExecutableAndArgsSectionProps {
  idPrefix?: string;
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

function ExecutableAndArgsSectionImpl({
  idPrefix = 'launch-cfg',
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
  const exeInputId = `${idPrefix}-exe-path-${sectionFilter}`;
  const workDirInputId = `${idPrefix}-work-dir-${sectionFilter}`;
  const launchArgsInputId = `${idPrefix}-launch-args-${sectionFilter}`;
  const nativeMetalHudLabelId = `${idPrefix}-native-metal-hud-label-${sectionFilter}`;
  const nativeMetalHudHintId = `${idPrefix}-native-metal-hud-hint-${sectionFilter}`;

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
        <section
          data-section="executable-and-args"
          aria-label="Executable & Launch Parameters"
          className="grid grid-cols-1 gap-3.5 bg-[#0e151f] border border-[#223447] rounded-lg p-3.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FileCode className="w-4 h-4 text-sky-400" aria-hidden="true" />
              <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                Executable &amp; Launch Parameters
              </h3>
            </div>
            <span className="text-[10px] text-steam-subtext">
              Also links existing local installations
            </span>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor={exeInputId}
              className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
            >
              {executablePathLabel}
            </label>
            <div className="flex items-center gap-2">
              <input
                id={exeInputId}
                type="text"
                value={customExecutablePath}
                onChange={(e) => onChangeCustomExecutablePath(e.target.value)}
                placeholder={executablePlaceholder}
                autoComplete="off"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                className={`${LAUNCH_TEXT_INPUT_CLASSES} flex-1 font-mono`}
              />
              <button
                type="button"
                onClick={onBrowseExecutable}
                className={`min-h-6 h-9 inline-flex items-center gap-1.5 px-3 rounded-lg bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-xs font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer shrink-0 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
              >
                <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Browse Executable...</span>
              </button>
            </div>
          </div>

          {(preview.isInstalled || Boolean(customExecutablePath.trim())) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Working Directory */}
              <div className="space-y-1.5">
                <label
                  htmlFor={workDirInputId}
                  className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
                >
                  Working Directory
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    id={workDirInputId}
                    type="text"
                    value={workingDirectory}
                    onChange={(e) => onChangeWorkingDirectory(e.target.value)}
                    placeholder="Default game folder"
                    autoComplete="off"
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                    className={`${LAUNCH_TEXT_INPUT_CLASSES} flex-1 min-w-0 font-mono`}
                  />
                  <button
                    type="button"
                    onClick={onBrowseWorkingDir}
                    className={`min-h-6 h-9 px-3 rounded-lg bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-xs font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer shrink-0 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                  >
                    Browse...
                  </button>
                </div>
              </div>

              {/* Command-Line Arguments */}
              <div className="space-y-1.5">
                <label
                  htmlFor={launchArgsInputId}
                  className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
                >
                  Launch Arguments
                </label>
                <input
                  id={launchArgsInputId}
                  type="text"
                  value={launchArguments}
                  onChange={(e) => onChangeLaunchArguments(e.target.value)}
                  placeholder={launchArgsPlaceholder}
                  autoComplete="off"
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  className={`${LAUNCH_TEXT_INPUT_CLASSES} font-mono`}
                />
              </div>
            </div>
          )}
        </section>
      )}

      {/* Native macOS Performance & Overlay Card (shown for native macOS .app / Mach-O builds) */}
      {showNativeMacHud && (
        <section
          data-section="native-mac-settings"
          aria-label="macOS Native Performance & Overlay"
          className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-2.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400" aria-hidden="true" />
              <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                macOS Native Performance &amp; Overlay
              </h3>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-semibold">
              Apple Silicon / Metal Native
            </span>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5">
            <div className="min-w-0 space-y-0.5">
              <span
                id={nativeMetalHudLabelId}
                className="block text-xs font-semibold text-white"
              >
                Apple Metal Performance HUD (MTL_HUD_ENABLED=1)
              </span>
              <p id={nativeMetalHudHintId} className="text-[10px] text-steam-subtext leading-snug">
                Displays real-time Apple Metal FPS, frame timing, and GPU memory overlay
              </p>
            </div>
            <SwitchControl
              dataTestId="toggle-metal-hud"
              checked={metalHud}
              ariaLabelledBy={nativeMetalHudLabelId}
              ariaDescribedBy={nativeMetalHudHintId}
              onChange={onToggleMetalHud}
              tone="sky"
            />
          </div>
        </section>
      )}
    </>
  );
}

export const ExecutableAndArgsSectionBase = ExecutableAndArgsSectionImpl;
export const ExecutableAndArgsSection = React.memo(ExecutableAndArgsSectionImpl);
ExecutableAndArgsSection.displayName = 'ExecutableAndArgsSection';
