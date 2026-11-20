import React from 'react';
import { ResolvedLaunchModePreview } from '../../../contracts/launcher';
import { FolderOpen } from 'lucide-react';
import {
  LAUNCH_BUTTON_FOCUS_CLASSES,
  LAUNCH_TEXT_INPUT_CLASSES,
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
  sectionFilter = 'all',
}: ExecutableAndArgsSectionProps): React.ReactElement | null {
  const exeInputId = `${idPrefix}-exe-path-${sectionFilter}`;
  const workDirInputId = `${idPrefix}-work-dir-${sectionFilter}`;
  const launchArgsInputId = `${idPrefix}-launch-args-${sectionFilter}`;

  const showExeSection =
    sectionFilter !== 'native_mac_only' && preview.visibleSections.executableAndArgs;

  if (!showExeSection) {
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
    <div data-section="executable-and-args" className="grid grid-cols-1 gap-3">
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

      {/* Custom Executable Path */}
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

      {/* Working Directory */}
      {(preview.isInstalled || Boolean(customExecutablePath.trim())) && (
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
      )}
    </div>
  );
}

export const ExecutableAndArgsSectionBase = ExecutableAndArgsSectionImpl;
export const ExecutableAndArgsSection = React.memo(ExecutableAndArgsSectionImpl);
ExecutableAndArgsSection.displayName = 'ExecutableAndArgsSection';
