import React from 'react';
import { ResolvedLaunchModePreview } from '../../../contracts/launcher';
import { Sliders, Terminal } from 'lucide-react';
import { WINDOWS_QUICK_ENV_TOGGLES } from './launchConfigHelpers';

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
      <div
        data-section="environment-variables"
        className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-2.5"
      >
        <div className="flex items-center justify-between">
          <label
            htmlFor={envTextareaId}
            className="flex items-center gap-2 cursor-pointer"
          >
            <Sliders className="w-4 h-4 text-sky-400" />
            <span className="text-xs font-bold text-white uppercase tracking-wider">
              Environment Variables
            </span>
          </label>
          <span className="text-[10px] text-steam-subtext">Custom KEY=VALUE process overrides</span>
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
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold border transition-colors cursor-pointer ${
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
          rows={2}
          value={envText}
          onChange={(e) => onChangeEnvText(e.target.value)}
          placeholder={envPlaceholder}
          autoComplete="off"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
        />
      </div>

      {/* Pre-Launch & Post-Exit Shell Commands */}
      <div
        data-section="shell-hooks"
        className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-[#0e151f] border border-[#223447] rounded-lg p-3.5"
      >
        <div className="space-y-1">
          <label
            htmlFor={preHookInputId}
            className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1"
          >
            <Terminal className="w-3 h-3 text-sky-400" />
            <span>Pre-Launch Command</span>
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
            className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
          />
        </div>

        <div className="space-y-1">
          <label
            htmlFor={postHookInputId}
            className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1"
          >
            <Terminal className="w-3 h-3 text-sky-400" />
            <span>Post-Exit Command</span>
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
            className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
          />
        </div>
      </div>
    </>
  );
}

export const EnvironmentAndHooksSectionBase = EnvironmentAndHooksSectionImpl;
export const EnvironmentAndHooksSection = React.memo(EnvironmentAndHooksSectionImpl);
EnvironmentAndHooksSection.displayName = 'EnvironmentAndHooksSection';
