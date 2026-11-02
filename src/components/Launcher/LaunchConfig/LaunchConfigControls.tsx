import React from 'react';
import { ChevronDown } from 'lucide-react';

export const LAUNCH_FOCUS_RING_CLASSES =
  'focus:outline-none focus:border-sky-400/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400';

export const LAUNCH_BUTTON_FOCUS_CLASSES =
  'focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400';

export const LAUNCH_TEXT_INPUT_CLASSES = `min-h-6 h-9 w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white transition-colors hover:border-[#3b5d7c] disabled:opacity-50 disabled:cursor-not-allowed ${LAUNCH_FOCUS_RING_CLASSES}`;

export const LAUNCH_TEXTAREA_CLASSES = `w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-2 text-xs text-white transition-colors hover:border-[#3b5d7c] disabled:opacity-50 disabled:cursor-not-allowed ${LAUNCH_FOCUS_RING_CLASSES}`;

export interface LaunchSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  wrapperClassName?: string;
  surface?: 'card' | 'panel';
}

export function LaunchSelect({
  wrapperClassName,
  surface = 'card',
  className,
  children,
  ...selectProps
}: LaunchSelectProps): React.ReactElement {
  const surfaceBg = surface === 'panel' ? 'bg-[#0e151f]' : 'bg-[#141d2b]';
  return (
    <div className={`relative ${wrapperClassName || 'w-full'}`}>
      <select
        {...selectProps}
        className={`appearance-none min-h-6 h-9 w-full pr-8 pl-2.5 rounded-lg ${surfaceBg} border border-[#2a475e] text-xs text-white [color-scheme:dark] transition-colors hover:border-[#3b5d7c] disabled:opacity-50 disabled:cursor-not-allowed ${LAUNCH_FOCUS_RING_CLASSES} ${
          className || ''
        }`}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-steam-subtext"
      />
    </div>
  );
}

export interface SwitchControlProps {
  id?: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  dataTestId?: string;
  title?: string;
  tone?: 'sky' | 'emerald' | 'amber';
  className?: string;
}

export function SwitchControl({
  id,
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  dataTestId,
  title,
  tone = 'sky',
  className,
}: SwitchControlProps): React.ReactElement {
  const activeTrackClass =
    tone === 'emerald'
      ? 'bg-emerald-500/85 border-emerald-400'
      : tone === 'amber'
        ? 'bg-amber-500/85 border-amber-400'
        : 'bg-sky-500/85 border-sky-400';

  const stateClasses = disabled
    ? 'bg-[#17212e]/70 border-[#26384d] opacity-50 cursor-not-allowed'
    : checked
      ? `${activeTrackClass} cursor-pointer`
      : 'bg-[#17212e] border-[#334b66] hover:border-[#49698c] cursor-pointer';

  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={Boolean(checked)}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      data-testid={dataTestId}
      title={title}
      onClick={() => {
        if (!disabled) {
          onChange();
        }
      }}
      className={`min-h-6 min-w-11 h-6 w-11 p-0.5 rounded-full inline-flex items-center shrink-0 border transition-colors motion-reduce:transition-none ${LAUNCH_BUTTON_FOCUS_CLASSES} ${stateClasses} ${
        className || ''
      }`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none inline-block h-4 w-4 rounded-full shadow-sm transition-transform motion-reduce:transition-none ${
          disabled ? 'bg-slate-400' : 'bg-white'
        } ${checked ? 'translate-x-5' : 'translate-x-0.5'}`}
      />
    </button>
  );
}
