import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export const LAUNCH_FOCUS_RING_CLASSES =
  'focus:outline-none focus:border-sky-400/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300';

export const LAUNCH_BUTTON_FOCUS_CLASSES =
  'focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300';

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
      aria-label={!ariaLabelledBy ? ariaLabel : undefined}
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
      className={`min-h-[24px] min-w-[44px] h-6 w-11 p-0.5 rounded-full inline-flex items-center shrink-0 border transition-colors motion-reduce:transition-none ${LAUNCH_BUTTON_FOCUS_CLASSES} ${stateClasses} ${
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

export interface SegmentedRadioOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  badge?: string;
  testId?: string;
  disabled?: boolean;
}

export interface SegmentedRadioGroupProps<T extends string> {
  name: string;
  legend: React.ReactNode;
  description?: React.ReactNode;
  descriptionId?: string;
  value: T;
  options: readonly SegmentedRadioOption<T>[];
  onChange: (value: T) => void;
  columns?: 2 | 3 | 4;
  variant?: 'pills' | 'cards';
  testId?: string;
  disabled?: boolean;
  className?: string;
}

export function SegmentedRadioGroup<T extends string>({
  name,
  legend,
  description,
  descriptionId,
  value,
  options,
  onChange,
  columns,
  variant = 'pills',
  testId,
  disabled = false,
  className,
}: SegmentedRadioGroupProps<T>): React.ReactElement {
  const resolvedDescId = descriptionId || (description ? `${name}-desc` : undefined);
  const colCount = columns ?? (options.length >= 4 ? 2 : options.length === 3 ? 3 : 2);
  const gridColsClass =
    colCount === 4
      ? 'grid-cols-2 sm:grid-cols-4'
      : colCount === 3
        ? 'grid-cols-1 sm:grid-cols-3'
        : 'grid-cols-1 sm:grid-cols-2';

  if (variant === 'cards') {
    return (
      <fieldset
        data-testid={testId}
        aria-describedby={resolvedDescId}
        disabled={disabled}
        className={`border-0 p-0 m-0 min-w-0 space-y-2 ${className || ''}`}
      >
        <legend className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1.5 p-0">
          {legend}
        </legend>
        <div className={`grid ${gridColsClass} gap-2`}>
          {options.map((opt) => {
            const isSelected = value === opt.value;
            const isDisabled = disabled || Boolean(opt.disabled);
            return (
              <label
                key={opt.value}
                data-testid={opt.testId}
                className={`relative min-h-[28px] flex flex-col justify-between gap-1 rounded-lg border bg-[#0e151f] border-[#26384d] p-2.5 transition-colors motion-reduce:transition-none has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-sky-300 ${
                  isDisabled
                    ? 'opacity-50 cursor-not-allowed'
                    : isSelected
                      ? 'bg-sky-500/15 border-sky-400 cursor-pointer'
                      : 'hover:border-[#385370] cursor-pointer'
                }`}
              >
                <input
                  type="radio"
                  name={name}
                  value={opt.value}
                  checked={isSelected}
                  disabled={isDisabled}
                  onChange={() => {
                    if (!isDisabled) {
                      onChange(opt.value);
                    }
                  }}
                  className="ol-visually-hidden"
                />
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      aria-hidden="true"
                      className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border shrink-0 ${
                        isSelected
                          ? 'border-sky-400 bg-sky-400/20'
                          : 'border-[#3b5571] bg-[#141d2b]'
                      }`}
                    >
                      {isSelected && <span className="h-1.5 w-1.5 rounded-full bg-sky-300" />}
                    </span>
                    <span
                      className={`text-xs font-bold leading-snug ${
                        isSelected ? 'text-sky-300' : 'text-white'
                      }`}
                    >
                      {opt.label}
                    </span>
                  </div>
                  {opt.badge && (
                    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 shrink-0">
                      {opt.badge}
                    </span>
                  )}
                </div>
                {opt.description && (
                  <span className="text-[10px] text-steam-subtext leading-snug">
                    {opt.description}
                  </span>
                )}
              </label>
            );
          })}
        </div>
        {description && (
          <p id={resolvedDescId} className="text-[10px] text-steam-subtext leading-snug">
            {description}
          </p>
        )}
      </fieldset>
    );
  }

  return (
    <fieldset
      data-testid={testId}
      aria-describedby={resolvedDescId}
      disabled={disabled}
      className={`border-0 p-0 m-0 min-w-0 space-y-1.5 ${className || ''}`}
    >
      <legend className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1.5 p-0">
        {legend}
      </legend>
      <div className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-[#0e151f] border border-[#26384d] p-1 w-full sm:w-auto">
        {options.map((opt) => {
          const isSelected = value === opt.value;
          const isDisabled = disabled || Boolean(opt.disabled);
          return (
            <label
              key={opt.value}
              data-testid={opt.testId}
              className={`relative min-h-[28px] min-w-[44px] flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold border transition-colors motion-reduce:transition-none has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-sky-300 ${
                isDisabled
                  ? 'border-transparent text-steam-subtext/50 opacity-50 cursor-not-allowed'
                  : isSelected
                    ? 'bg-sky-500/20 border-sky-400 text-sky-200 shadow-sm cursor-pointer'
                    : 'border-transparent text-steam-subtext hover:text-white hover:bg-white/5 cursor-pointer'
              }`}
            >
              <input
                type="radio"
                name={name}
                value={opt.value}
                checked={isSelected}
                disabled={isDisabled}
                onChange={() => {
                  if (!isDisabled) {
                    onChange(opt.value);
                  }
                }}
                className="ol-visually-hidden"
              />
              <span>{opt.label}</span>
              {opt.badge && (
                <span className="text-[9px] font-semibold px-1.5 py-0.2 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                  {opt.badge}
                </span>
              )}
            </label>
          );
        })}
      </div>
      {description && (
        <p id={resolvedDescId} className="text-[10px] text-steam-subtext leading-snug">
          {description}
        </p>
      )}
    </fieldset>
  );
}

export interface LaunchDisclosureProps {
  summary: string;
  subtitle?: string;
  overrideCount?: number;
  open?: boolean;
  onToggle?: (isOpen: boolean) => void;
  testId?: string;
  summaryTestId?: string;
  overrideBadgeTestId?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * Accessible native `<details>` + `<summary>` disclosure following modern-web-guidance:
 * - Zero heading elements (`<h3>`/`<h4>`) inside `<summary>` (preserves button role in JAWS/TalkBack).
 * - Rotating chevron placed directly BEFORE the label text for vertical scanning.
 * - Compact override count pill surfaced when non-default values exist inside.
 */
export function LaunchDisclosure({
  summary,
  subtitle,
  overrideCount = 0,
  open,
  onToggle,
  testId,
  summaryTestId,
  overrideBadgeTestId,
  className,
  children,
}: LaunchDisclosureProps): React.ReactElement {
  return (
    <details
      open={open}
      onToggle={
        onToggle
          ? (e) => {
              const target = e.currentTarget as HTMLDetailsElement;
              if (typeof target.open === 'boolean') {
                onToggle(target.open);
              }
            }
          : undefined
      }
      data-testid={testId}
      className={`group rounded-lg bg-[#0e151f] border border-[#223447] overflow-hidden ${className || ''}`}
    >
      <summary
        data-testid={summaryTestId}
        className={`list-none [&::-webkit-details-marker]:hidden min-h-[36px] px-3.5 py-2.5 flex items-center justify-between gap-2 cursor-pointer select-none hover:bg-[#141d2b]/70 transition-colors motion-reduce:transition-none ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
      >
        <span className="flex items-center gap-2 min-w-0">
          <ChevronRight
            aria-hidden="true"
            className="w-4 h-4 text-sky-400 shrink-0 transition-transform duration-150 motion-reduce:transition-none group-open:rotate-90"
          />
          <span className="text-xs font-bold text-white truncate">{summary}</span>
          {subtitle && (
            <span className="hidden sm:inline text-[10px] text-steam-subtext truncate">
              — {subtitle}
            </span>
          )}
        </span>
        {overrideCount > 0 && (
          <span
            data-testid={overrideBadgeTestId}
            className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sky-500/20 border border-sky-400/40 text-sky-200 shrink-0"
          >
            {overrideCount} {overrideCount === 1 ? 'override' : 'overrides'}
          </span>
        )}
      </summary>
      <div className="px-3.5 pb-3.5 pt-2.5 border-t border-[#223447]/80 space-y-3.5">
        {children}
      </div>
    </details>
  );
}
