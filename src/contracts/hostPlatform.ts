export type HostPlatform = 'darwin' | 'win32' | 'linux';
export type HostArch = 'arm64' | 'x64';

export interface HostPlatformCapabilities {
  readonly hostPlatform: HostPlatform;
  readonly hostArch: HostArch;
  readonly isMac: boolean;
  readonly isWindows: boolean;
  readonly isLinux: boolean;
  /** True only on macOS: CrossOver / GPTK / Wine runners, bottles, D3DMetal/DXMT/MetalFX, bottle filters. */
  readonly supportsWindowsTranslation: boolean;
  /** True only on macOS: Display Scaler v3, Virtual Desktop, Legacy 96 DPI, Ctrl+Option+F/A hotkeys. */
  readonly supportsBottleDisplayScaler: boolean;
  /** True only on macOS: Apple Metal Performance HUD (`MTL_HUD_ENABLED=1`). */
  readonly supportsMetalHud: boolean;
  /** True on macOS, Windows, and Linux for Vulkan/DXVK-wrapped games. */
  readonly supportsDxvkHud: boolean;
  /** True only on Apple Silicon macOS (`darwin` + `arm64`). */
  readonly supportsAppleSiliconArm64Runners: boolean;
}

const X64_ARCH_RE = /^(x64|ia32|x86_64|x86|intel|amd64)$/i;

function normalizeArchString(raw: string): HostArch {
  return X64_ARCH_RE.test(raw.trim()) ? 'x64' : 'arm64';
}

/**
 * Resolves the canonical host OS platform for renderer and shared service logic.
 *
 * Precedence:
 *   1. Valid explicit override (`'darwin' | 'win32' | 'linux'`)
 *   2. Electron preload bridge (`window.electronAPI?.platform`)
 *   3. Non-Node browser `navigator.platform` / `navigator.userAgent`
 *   4. Default fallback `'darwin'`
 *
 * Deliberately NEVER falls back to `process.platform` so Vitest / CI runs on
 * Linux and Windows keep deterministic macOS-default renderer behavior unless
 * explicitly overridden via `explicit`, `window.electronAPI.platform`, or spy.
 */
export function resolveHostPlatform(explicit?: HostPlatform | string): HostPlatform {
  if (explicit === 'darwin' || explicit === 'win32' || explicit === 'linux') {
    return explicit;
  }
  const apiPlatform = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined;
  if (apiPlatform === 'win32' || apiPlatform === 'darwin' || apiPlatform === 'linux') {
    return apiPlatform;
  }
  if (typeof navigator !== 'undefined' && !navigator.userAgent?.includes('Node')) {
    const ua = navigator.platform || navigator.userAgent || '';
    if (/Win/i.test(ua)) return 'win32';
    if (/Mac|Darwin/i.test(ua)) return 'darwin';
    if (/Linux/i.test(ua)) return 'linux';
  }
  return 'darwin';
}

/**
 * Resolves the canonical host CPU architecture (`'arm64' | 'x64'`).
 *
 * Precedence:
 *   1. Valid explicit override (`'arm64' | 'x64'` or standard arch alias)
 *   2. Electron preload bridge (`window.electronAPI?.arch`) or `fallbackDetectedArch`
 *   3. Non-Node browser `navigator.userAgentData.architecture` / `navigator.platform`
 *   4. Default fallback `'arm64'`
 *
 * Deliberately NEVER falls back to `process.arch` (mirroring `resolveHostPlatform()`),
 * so Vitest / CI runs on x64 Linux/Windows hosts keep deterministic Apple Silicon-default
 * renderer capabilities unless explicitly overridden via `explicit`, `window.electronAPI.arch`,
 * or `fallbackDetectedArch`.
 */
export function resolveHostArch(
  explicit?: HostArch | string,
  fallbackDetectedArch?: string
): HostArch {
  if (typeof explicit === 'string' && explicit.trim()) {
    return normalizeArchString(explicit);
  }
  const rawArchProp = typeof window !== 'undefined' ? window.electronAPI?.arch : undefined;
  const rawApiArch = typeof rawArchProp === 'string' ? rawArchProp.trim() : '';
  const candidateArch = rawApiArch || (fallbackDetectedArch || '').trim();
  if (candidateArch) {
    return normalizeArchString(candidateArch);
  }
  if (typeof navigator !== 'undefined' && !navigator.userAgent?.includes('Node')) {
    const uaDataArch = (
      navigator as Navigator & { userAgentData?: { architecture?: string } }
    )?.userAgentData?.architecture;
    if (typeof uaDataArch === 'string' && uaDataArch.trim()) {
      return normalizeArchString(uaDataArch);
    }
    const uaPlatform = `${navigator.platform || ''} ${navigator.userAgent || ''}`;
    if (/\b(x86_64|x64|amd64|wow64|win64)\b/i.test(uaPlatform)) {
      return 'x64';
    }
  }
  return 'arm64';
}

/**
 * Pure capability constructor mapping `(HostPlatform, HostArch)` to explicit feature flags.
 */
export function buildHostCapabilities(
  platform: HostPlatform,
  arch: HostArch = 'arm64'
): HostPlatformCapabilities {
  const isMac = platform === 'darwin';
  const isWindows = platform === 'win32';
  const isLinux = platform === 'linux';
  return {
    hostPlatform: platform,
    hostArch: arch,
    isMac,
    isWindows,
    isLinux,
    supportsWindowsTranslation: isMac,
    supportsBottleDisplayScaler: isMac,
    supportsMetalHud: isMac,
    supportsDxvkHud: true,
    supportsAppleSiliconArm64Runners: isMac && arch === 'arm64',
  };
}

/**
 * Resolves host capabilities directly from explicit overrides or runtime globals.
 * UI components should prefer `launcherService.getHostCapabilities(...)` so
 * runtime arch hydration and test spies on `launcherService` are always honored.
 */
export function getHostCapabilities(
  explicitPlatform?: HostPlatform,
  explicitArch?: HostArch
): HostPlatformCapabilities {
  return buildHostCapabilities(
    resolveHostPlatform(explicitPlatform),
    resolveHostArch(explicitArch)
  );
}
