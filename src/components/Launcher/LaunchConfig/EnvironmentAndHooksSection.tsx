import React from 'react';
import { ResolvedLaunchModePreview } from '../../../contracts/launcher';
import { Sliders, Terminal } from 'lucide-react';
import { WINDOWS_QUICK_ENV_TOGGLES } from './launchConfigHelpers';
import {
  LAUNCH_BUTTON_FOCUS_CLASSES,
  LAUNCH_TEXT_INPUT_CLASSES,
  LAUNCH_TEXTAREA_CLASSES,
} from './LaunchConfigControls';

export interface EnvironmentAndHooksSectionProps {
  idPrefix?: string;
  preview: ResolvedLaunchModePreview;
  isWindowsHost: boolean;
  currentEnvMap: Record<string, string>;
  onToggleQuickEnv: (key: string, value: string) => void;
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
  currentEnvMap,
  onToggleQuickEnv,
  envText,
  onChangeEnvText,
  preLaunchCommand,
  onChangePreLaunchCommand,
  postExitCommand,
  onChangePostExitCommand,
}: EnvironmentAndHooksSectionProps): React.ReactElement | null {
  const envHeadingId = `${idPrefix}-env-variables-heading`;
  const envTextareaId = `${idPrefix}-env-variables`;
  const preHookInputId = `${idPrefix}-pre-launch-cmd`;
  const postHookInputId = `${idPrefix}-post-exit-cmd`;

  if (!preview.visibleSections.environmentAndHooks) {
    return null;
  }

  const envPlaceholder = isWindowsHost
    ? 'KEY=VALUE (one per line, e.g. __GL_THREADED_OPTIMIZATIONS=1)'
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
    <>
      {/* Environment Variables & Custom Overrides */}
      <section
        data-section="environment-variables"
        aria-labelledby={envHeadingId}
        className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-2.5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-sky-400" aria-hidden="true" />
            <h3
              id={envHeadingId}
              className="text-xs font-bold text-white uppercase tracking-wider"
            >
              Environment Variables
            </h3>
          </div>
          <label htmlFor={envTextareaId} className="text-[10px] text-steam-subtext cursor-pointer">
            Custom KEY=VALUE process overrides
          </label>
        </div>

        {isWindowsHost && (
          <div className="flex flex-wrap gap-1.5">
            {WINDOWS_QUICK_ENV_TOGGLES.map((item) => {
              const isActive = currentEnvMap[item.key] === item.value;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => onToggleQuickEnv(item.key, item.value)}
                  className={`min-h-6 min-w-6 px-2.5 py-1 rounded text-[11px] font-semibold border transition-colors cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES} ${
                    isActive
                      ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                      : 'bg-[#141d2b] border-[#26384d] text-steam-subtext hover:text-white'
                  }`}
                  title={item.desc}
                >
                  {item.label} ({item.key}={item.value})
                </button>
              );
            })}
          </div>
        )}

        <textarea
          id={envTextareaId}
          aria-labelledby={envHeadingId}
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
      </section>

      {/* Pre-Launch & Post-Exit Shell Commands */}
      <section
        data-section="shell-hooks"
        aria-label="Shell Lifecycle Hooks"
        className="bg-[#0e151f] border border-[#223447] rounded-lg p-3.5 space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-sky-400" aria-hidden="true" />
            <h3 className="text-xs font-bold text-white uppercase tracking-wider">
              Shell Lifecycle Hooks
            </h3>
          </div>
          <span className="text-[10px] text-steam-subtext">
            Optional commands run before launch &amp; after exit
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
      </section>
    </>
  );
}

export const EnvironmentAndHooksSectionBase = EnvironmentAndHooksSectionImpl;
export const EnvironmentAndHooksSection = React.memo(EnvironmentAndHooksSectionImpl);
EnvironmentAndHooksSection.displayName = 'EnvironmentAndHooksSection';
