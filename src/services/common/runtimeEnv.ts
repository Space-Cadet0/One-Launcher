/**
 * Safe runtime environment feature detection helpers for Electron renderer,
 * Vite browser dev, and Vitest / SSR test runtimes.
 *
 * Pure Layer 0 foundation utility (`services-foundation`) with zero `node:` imports.
 */

interface ViteImportMetaEnv {
  DEV?: boolean;
  PROD?: boolean;
  MODE?: string;
  VITEST?: string | boolean;
}

function getImportMetaEnv(): ViteImportMetaEnv | undefined {
  try {
    return (import.meta as ImportMeta & { env?: ViteImportMetaEnv }).env;
  } catch {
    return undefined;
  }
}

/**
 * Returns true when running inside Vitest or a `NODE_ENV=test` test runner.
 */
export function isTestEnv(): boolean {
  try {
    const metaEnv = getImportMetaEnv();
    if (metaEnv?.VITEST || metaEnv?.MODE === 'test') {
      return true;
    }
    if (
      typeof process !== 'undefined' &&
      process !== null &&
      typeof process.env === 'object' &&
      process.env !== null
    ) {
      return Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
    }
  } catch {
    // Ignore restricted global access
  }
  return false;
}

/**
 * Alias of `isTestEnv()` for Vitest-aware hooks and services.
 */
export function isVitestRuntime(): boolean {
  try {
    const metaEnv = getImportMetaEnv();
    if (metaEnv?.VITEST) {
      return true;
    }
    if (
      typeof process !== 'undefined' &&
      process !== null &&
      typeof process.env === 'object' &&
      process.env !== null &&
      Boolean(process.env.VITEST)
    ) {
      return true;
    }
  } catch {
    // Ignore restricted global access
  }
  return isTestEnv();
}

/**
 * Returns true when running in Vite development mode (`import.meta.env.DEV === true`).
 */
export function isViteDevMode(): boolean {
  return Boolean(getImportMetaEnv()?.DEV);
}

/**
 * Returns true when `window.electronAPI` is exposed on the current global window.
 */
export function hasElectronBridge(): boolean {
  try {
    return typeof window !== 'undefined' && Boolean(window.electronAPI);
  } catch {
    return false;
  }
}

/**
 * Returns true when running inside the Electron desktop shell (`window.electronAPI.isElectron === true`).
 */
export function isElectronRuntime(): boolean {
  try {
    return typeof window !== 'undefined' && Boolean(window.electronAPI?.isElectron);
  } catch {
    return false;
  }
}

/**
 * Returns true when Electron's SQLite offline media & metadata vault bridge is active.
 */
export function hasOfflineVaultBridge(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      Boolean(window.electronAPI?.isElectron && window.electronAPI?.offlineVault)
    );
  } catch {
    return false;
  }
}

/**
 * Returns true when executing in a DOM-capable browser/renderer environment.
 */
export function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Returns true when `navigator.userAgent` identifies a headless jsdom or Node runtime.
 */
export function isJsdomOrNodeUserAgent(): boolean {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.userAgent !== 'string') {
      return false;
    }
    return navigator.userAgent.includes('jsdom') || navigator.userAgent.includes('Node');
  } catch {
    return false;
  }
}

/**
 * Safely resolves `localStorage` without throwing in restricted iframe/sandbox or SSR contexts.
 */
export function getSafeLocalStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof localStorage !== 'undefined' && localStorage) {
      return localStorage;
    }
  } catch {
    // Ignore restricted storage environments
  }
  return null;
}

/**
 * Alias of `getSafeLocalStorage()` matching historical service naming.
 */
export const getSafeStorage = getSafeLocalStorage;

/**
 * Safely resolves `sessionStorage` without throwing in restricted iframe/sandbox or SSR contexts.
 */
export function getSafeSessionStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      return window.sessionStorage;
    }
    if (typeof sessionStorage !== 'undefined' && sessionStorage) {
      return sessionStorage;
    }
  } catch {
    // Ignore restricted storage environments
  }
  return null;
}
