import React from 'react';
import { NativeOsPlatform } from '../../contracts/game';

export const WindowsOsSvg: React.FC<{ size?: number; className?: string }> = ({
  size = 12,
  className = '',
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={`shrink-0 ${className}`.trim()}
    aria-label="Windows"
    data-native-os="windows"
  >
    <path d="M2 3.5L10.5 2.3V11.2H2V3.5ZM11.8 2.1L22 0.7V11.2H11.8V2.1ZM2 12.5H10.5V21.4L2 20.2V12.5ZM11.8 12.5H22V23L11.8 21.6V12.5Z" />
  </svg>
);

export const MacOsSvg: React.FC<{ size?: number; className?: string }> = ({
  size = 12,
  className = '',
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={`shrink-0 ${className}`.trim()}
    aria-label="macOS"
    data-native-os="mac"
  >
    <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.96 6.33c.67-.81 1.12-1.94 1-3.07-.96.04-2.13.64-2.82 1.45-.61.7-.11 1.85-.99 2.97 1.07.08 2.15-.54 2.81-1.35" />
  </svg>
);

export interface NativeOsBadgesProps {
  platforms: NativeOsPlatform[];
  variant?: 'cover-badge' | 'detail-pill';
  onSelectOs?: (os: NativeOsPlatform) => void;
  className?: string;
}

export const NativeOsBadges: React.FC<NativeOsBadgesProps> = ({
  platforms,
  variant = 'cover-badge',
  onSelectOs,
  className = '',
}) => {
  if (!platforms || platforms.length === 0) return null;

  const hasMac = platforms.includes('mac');
  const hasWindows = platforms.includes('windows');

  const tooltipText =
    hasMac && hasWindows
      ? 'Natively available on macOS & Windows'
      : hasMac
        ? 'Natively available on macOS (Compatibility layers excluded)'
        : 'Natively available on Windows';

  if (variant === 'cover-badge') {
    return (
      <div
        className={`bg-[#0e141b]/95 border border-white/15 px-1.5 py-1 rounded shadow-md flex items-center gap-1 text-white/85 ${className}`.trim()}
        title={tooltipText}
        data-testid="cover-native-os-badge"
      >
        {hasMac && <MacOsSvg size={11} className="text-white/95" />}
        {hasWindows && <WindowsOsSvg size={10} className="text-sky-300/90" />}
      </div>
    );
  }

  return (
    <div
      className={`inline-flex items-center gap-1.5 ${className}`.trim()}
      data-testid="detail-native-os-badges"
    >
      {hasMac && (
        <button
          type="button"
          onClick={(e) => {
            if (onSelectOs) {
              e.stopPropagation();
              onSelectOs('mac');
            }
          }}
          title="Natively available on macOS (Compatibility layers excluded)"
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium bg-white/10 text-white border border-white/15 transition-colors ${
            onSelectOs ? 'hover:bg-white/20 hover:border-white/30 cursor-pointer' : 'cursor-default'
          }`}
          data-testid="detail-native-os-pill-mac"
        >
          <MacOsSvg size={11} className="text-white" />
          <span>macOS</span>
        </button>
      )}
      {hasWindows && (
        <button
          type="button"
          onClick={(e) => {
            if (onSelectOs) {
              e.stopPropagation();
              onSelectOs('windows');
            }
          }}
          title="Natively available on Windows"
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium bg-sky-500/10 text-sky-200 border border-sky-400/20 transition-colors ${
            onSelectOs ? 'hover:bg-sky-500/20 hover:border-sky-400/40 cursor-pointer' : 'cursor-default'
          }`}
          data-testid="detail-native-os-pill-windows"
        >
          <WindowsOsSvg size={10} className="text-sky-300" />
          <span>Windows</span>
        </button>
      )}
    </div>
  );
};
