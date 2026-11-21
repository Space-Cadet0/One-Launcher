/**
 * Shared failed-media URL registry extracted out of UI presentation components
 * (`LibraryGridView` / `LibrarySidebar`) to eliminate hook->component layer inversions.
 *
 * Maintains bounded LRU URL failure sets per UI surface (`cover` and `sidebar_icon`)
 * plus subscriber notifications when failed URLs are cleared (e.g. manual sync or reconnect).
 */

import { LruSet } from '../common/lruMap';

export type FailedMediaScope = 'cover' | 'sidebar_icon' | 'all';
export type ConcreteFailedMediaScope = Exclude<FailedMediaScope, 'all'>;

export interface FailedMediaResetEvent {
  scope: FailedMediaScope;
  gameId?: string;
  url?: string;
}

export type FailedMediaResetListener = (event: FailedMediaResetEvent) => void;

export const MAX_FAILED_COVER_URLS = 8192;
export const MAX_FAILED_SIDEBAR_ICON_URLS = 2000;

const failedCoverUrlSet = new LruSet<string>(MAX_FAILED_COVER_URLS);
const failedSidebarIconUrlSet = new LruSet<string>(MAX_FAILED_SIDEBAR_ICON_URLS);
const resetListeners = new Set<FailedMediaResetListener>();

function normalizeMediaUrl(url?: string | null): string {
  if (!url || typeof url !== 'string') return '';
  return url.trim();
}

function getSetForScope(scope: ConcreteFailedMediaScope): LruSet<string> {
  return scope === 'sidebar_icon' ? failedSidebarIconUrlSet : failedCoverUrlSet;
}

function notifyResetListeners(event: FailedMediaResetEvent): void {
  for (const listener of Array.from(resetListeners)) {
    try {
      listener(event);
    } catch {
      // Isolate subscriber errors so all listeners receive reset notifications
    }
  }
}

/**
 * Records a media URL as failed in the bounded registry for `scope` (default `'cover'`).
 */
export function markMediaUrlFailed(
  url?: string | null,
  scope: ConcreteFailedMediaScope = 'cover'
): void {
  const normalized = normalizeMediaUrl(url);
  if (!normalized) return;
  getSetForScope(scope).add(normalized);
}

/**
 * Returns true if `url` is currently marked as failed in `scope` (default `'cover'`).
 */
export function hasMediaUrlFailed(
  url?: string | null,
  scope: FailedMediaScope = 'cover'
): boolean {
  const normalized = normalizeMediaUrl(url);
  if (!normalized) return false;
  if (scope === 'all') {
    return failedCoverUrlSet.has(normalized) || failedSidebarIconUrlSet.has(normalized);
  }
  return getSetForScope(scope).has(normalized);
}

/**
 * Clears failed media URLs for a scope (or a single URL) and notifies registered listeners.
 * Calling `clearFailedMediaUrls()` with no arguments clears both cover and sidebar-icon registries.
 */
export function clearFailedMediaUrls(
  options?:
    | FailedMediaScope
    | {
        scope?: FailedMediaScope;
        gameId?: string;
        url?: string;
      }
): void {
  const resolvedScope: FailedMediaScope =
    typeof options === 'string' ? options : (options?.scope ?? 'all');
  const gameId = typeof options === 'object' && options !== null ? options.gameId : undefined;
  const targetUrl =
    typeof options === 'object' && options !== null ? normalizeMediaUrl(options.url) : '';

  if (targetUrl) {
    if (resolvedScope === 'all' || resolvedScope === 'cover') {
      failedCoverUrlSet.delete(targetUrl);
    }
    if (resolvedScope === 'all' || resolvedScope === 'sidebar_icon') {
      failedSidebarIconUrlSet.delete(targetUrl);
    }
    notifyResetListeners({ scope: resolvedScope, gameId, url: targetUrl });
    return;
  }

  if (resolvedScope === 'all' || resolvedScope === 'cover') {
    failedCoverUrlSet.clear();
  }
  if (resolvedScope === 'all' || resolvedScope === 'sidebar_icon') {
    failedSidebarIconUrlSet.clear();
  }
  notifyResetListeners({ scope: resolvedScope, gameId });
}

/**
 * Subscribes to failed-media reset notifications (returning an unsubscribe callback).
 */
export function subscribeFailedMediaUrlReset(listener: FailedMediaResetListener): () => void {
  resetListeners.add(listener);
  return () => {
    resetListeners.delete(listener);
  };
}

/**
 * Returns the current number of cached failed URLs for `scope`.
 */
export function getFailedMediaUrlCount(scope: FailedMediaScope = 'all'): number {
  if (scope === 'cover') return failedCoverUrlSet.size;
  if (scope === 'sidebar_icon') return failedSidebarIconUrlSet.size;
  return failedCoverUrlSet.size + failedSidebarIconUrlSet.size;
}

/**
 * Convenience helpers matching legacy `LibraryGridView` / `LibrarySidebar` semantics.
 */
export function markCoverUrlFailed(url?: string | null): void {
  markMediaUrlFailed(url, 'cover');
}

export function hasCoverUrlFailed(url?: string | null): boolean {
  return hasMediaUrlFailed(url, 'cover');
}

export function clearFailedCoverUrls(gameId?: string): void {
  clearFailedMediaUrls({ scope: 'cover', gameId });
}

export function markSidebarIconUrlFailed(url?: string | null): void {
  markMediaUrlFailed(url, 'sidebar_icon');
}

export function hasSidebarIconUrlFailed(url?: string | null): boolean {
  return hasMediaUrlFailed(url, 'sidebar_icon');
}

export function clearFailedSidebarIconUrls(): void {
  clearFailedMediaUrls({ scope: 'sidebar_icon' });
}
