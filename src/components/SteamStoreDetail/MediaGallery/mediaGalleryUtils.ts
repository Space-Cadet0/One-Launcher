import type Hls from 'hls.js';
import { SteamScreenshot, SteamMovie } from '../../../contracts/steam';
import { launcherService } from '../../../services/launcher/launcherService';

export type MediaItem =
  | { type: 'movie'; movie: SteamMovie }
  | { type: 'screenshot'; screenshot: SteamScreenshot };

export const MAX_BOUNDED_MEDIA_ENTRIES = 500;

export function normalizeMediaUrl(url?: string | null): string {
  if (!url) return '';
  const trimmed = url.trim();
  if (trimmed.startsWith('//') && !trimmed.startsWith('///')) {
    return `https:${trimmed}`;
  }
  return trimmed;
}

export function extractYouTubeId(url?: string): string | null {
  if (!url) return null;
  const match = url.match(
    /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/
  );
  return match && match[1] ? match[1] : null;
}

export function setBoundedFlag(
  prev: Record<string, boolean>,
  key: string,
  maxEntries = MAX_BOUNDED_MEDIA_ENTRIES
): Record<string, boolean> {
  if (!key || prev[key]) return prev;
  const keys = Object.keys(prev);
  if (keys.length < maxEntries) {
    return { ...prev, [key]: true };
  }
  const next: Record<string, boolean> = {};
  const startIdx = keys.length - maxEntries + 1;
  for (let i = startIdx; i < keys.length; i += 1) {
    next[keys[i]] = prev[keys[i]];
  }
  next[key] = true;
  return next;
}

export function addBoundedSetEntry(
  set: Set<string>,
  key: string,
  maxEntries = MAX_BOUNDED_MEDIA_ENTRIES
): void {
  if (set.has(key)) return;
  while (set.size >= maxEntries) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
  set.add(key);
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    Boolean(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  );
}

export function isTrustedEmbedHost(rawUrl?: string): boolean {
  if (!rawUrl) return false;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'youtube.com' ||
      host === 'www.youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'youtube-nocookie.com' ||
      host === 'www.youtube-nocookie.com' ||
      host === 'youtu.be' ||
      host === 'wistia.net' ||
      host.endsWith('.wistia.net') ||
      host === 'player.vimeo.com'
    );
  } catch {
    return false;
  }
}

export async function loadHlsModule(): Promise<typeof Hls> {
  if (import.meta.env?.MODE === 'test') {
    const mod = await import('hls.js');
    return mod.default;
  }
  const mod = await import('hls.js/dist/hls.light.mjs');
  return mod.default;
}

export function shouldSuspendMediaPlayback(): boolean {
  return (
    launcherService.getRunningGames().length > 0 ||
    launcherService.isInGameHibernating() ||
    (typeof document !== 'undefined' && Boolean(document.hidden))
  );
}
