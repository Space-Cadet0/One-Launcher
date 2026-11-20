import React from 'react';
import { ResolvedLaunchModePreview } from '../../../contracts/launcher';
import {
  LAUNCH_TEXT_INPUT_CLASSES,
  LAUNCH_TEXTAREA_CLASSES,
} from './LaunchConfigControls';

export interface EnvironmentAndHooksSectionProps {
  idPrefix?: string;
  preview: ResolvedLaunchModePreview;
  isWindowsHost: boolean;
  envText: string;
  onChangeEnvText: (value: string) => void;
  preLaunchCommand: string;
  onChangePreLaunchCommand: (value: string) => void;
  postExitCommand: string;
  onChangePostExitCommand: (value: string) => void;
}

function EnvironmentAndHooksSectionImpl({
  idPrefix = 'launch-cfg',
  preview,
  isWindowsHost,
  envText,
  onChangeEnvText,
  preLaunchCommand,
  onChangePreLaunchCommand,
  postExitCommand,
  onChangePostExitCommand,
}: EnvironmentAndHooksSectionProps): React.ReactElement | null {
  const envTextareaId = `${idPrefix}-env-variables`;
  const envHintId = `${idPrefix}-env-variables-hint`;
  const preHookInputId = `${idPrefix}-pre-launch-cmd`;
  const postHookInputId = `${idPrefix}-post-exit-cmd`;

  if (!preview.visibleSections.environmentAndHooks) {
    return null;
  }

  const envPlaceholder = isWindowsHost
    ? 'KEY=VALUE (one per line, e.g. SDL_VIDEO_MINIMIZE_ON_FOCUS_LOSS=0)'
    : preview.visibleSections.compatibilityLayer
      ? 'KEY=VALUE (one per line, e.g. MVK_CONFIG_FAST_MATH_ENABLED=1)'
      : 'KEY=VALUE (one per line, e.g. METAL_DEVICE_WRAPPER_TYPE=1)';

  const preHookPlaceholder = isWindowsHost
    ? 'Optional command or .bat / PowerShell script before launch'
    : 'Optional shell command or script before launch';

  const postHookPlaceholder = isWindowsHost
    ? 'Optional command or .bat / PowerShell script after exit'
    : 'Optional shell command or script after game exits';

  return (
    <div className="space-y-3 pt-1 border-t border-[#223447]/80">
      {/* Environment Variables (custom KEY=VALUE overrides — zero duplicate DXVK_HUD quick chip) */}
      <div data-section="environment-variables" className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label
            htmlFor={envTextareaId}
            className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
          >
            Environment Variables
          </label>
          <span id={envHintId} className="text-[10px] text-steam-subtext">
            Custom KEY=VALUE process overrides (one per line)
          </span>
        </div>

        <textarea
          id={envTextareaId}
          aria-describedby={envHintId}
          rows={2}
          value={envText}
          onChange={(e) => onChangeEnvText(e.target.value)}
          placeholder={envPlaceholder}
          autoComplete="off"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          className={`${LAUNCH_TEXTAREA_CLASSES} font-mono`}
        />
      </div>

      {/* Pre-Launch & Post-Exit Shell Commands */}
      <div data-section="shell-hooks" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label
            htmlFor={preHookInputId}
            className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
          >
            Pre-Launch Command
          </label>
          <input
            id={preHookInputId}
            type="text"
            value={preLaunchCommand}
            onChange={(e) => onChangePreLaunchCommand(e.target.value)}
            placeholder={preHookPlaceholder}
            autoComplete="off"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className={`${LAUNCH_TEXT_INPUT_CLASSES} font-mono`}
          />
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor={postHookInputId}
            className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext"
          >
            Post-Exit Command
          </label>
          <input
            id={postHookInputId}
            type="text"
            value={postExitCommand}
            onChange={(e) => onChangePostExitCommand(e.target.value)}
            placeholder={postHookPlaceholder}
            autoComplete="off"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className={`${LAUNCH_TEXT_INPUT_CLASSES} font-mono`}
          />
        </div>
      </div>
    </div>
  );
}

export const EnvironmentAndHooksSectionBase = EnvironmentAndHooksSectionImpl;
export const EnvironmentAndHooksSection = React.memo(EnvironmentAndHooksSectionImpl);
EnvironmentAndHooksSection.displayName = 'EnvironmentAndHooksSection';
