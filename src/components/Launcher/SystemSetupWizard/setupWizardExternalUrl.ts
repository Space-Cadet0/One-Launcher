import { sanitizeAllowedStoreUri } from '../../../services/common/htmlSanitizer';

const SAFE_MS_STORE_URI_RE = /^ms-windows-store:\/\/[A-Za-z0-9/?=&._%-]+$/i;

/**
 * Validates external download/store links rendered inside System Setup Wizard steps.
 * Permits canonical `https://` URLs (via `sanitizeAllowedStoreUri`) as well as
 * official `ms-windows-store://` product protocol URIs for Microsoft Gaming Services.
 */
export function sanitizeSetupExternalHref(raw?: string | null): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return '';
  if (SAFE_MS_STORE_URI_RE.test(trimmed)) {
    return trimmed;
  }
  const safeHttps = sanitizeAllowedStoreUri(trimmed);
  return /^https:\/\//i.test(safeHttps) ? safeHttps : '';
}

/**
 * Delegates opening an external URL to Electron's shell bridge when available.
 * Returns `true` if Electron handled the navigation (so an `<a>` click handler should preventDefault).
 */
export function openSetupExternalUrlViaElectron(safeUrl: string): boolean {
  if (!safeUrl || typeof window === 'undefined') return false;
  const api = window.electronAPI;
  if (typeof api?.openExternalUrl === 'function') {
    void api.openExternalUrl(safeUrl);
    return true;
  }
  if (typeof api?.openExternal === 'function') {
    void api.openExternal(safeUrl);
    return true;
  }
  return false;
}
