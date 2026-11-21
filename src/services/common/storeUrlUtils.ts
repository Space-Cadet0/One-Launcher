/**
 * Pure store URL validation, origin/host allowlisting, and `ol-media://` helpers.
 * Complements `toOlMediaUrl` / `unwrapOlMediaUrl` in `src/contracts/network.ts` without duplicating them.
 *
 * Layer 0 (`services-foundation`) — zero upward imports.
 */

import { unwrapOlMediaUrl } from '../../contracts/network';

const CONTROL_CHAR_OR_BACKSLASH_RE = /[\u0000-\u001f\u007f\\]/;
const PATH_TRAVERSAL_SEGMENT_RE = /(?:^|\/)\.\.(?:\/|$)/;
const OL_MEDIA_SCHEME_PREFIX_RE = /^ol-media:\/\//i;

const METACRITIC_HOSTS = ['metacritic.com'] as const;
const OPENCRITIC_HOSTS = ['opencritic.com'] as const;
const XBOX_STORE_HOSTS = ['xbox.com'] as const;
const STEAM_STORE_HOSTS = ['steampowered.com', 'steamcommunity.com'] as const;
const GOG_STORE_HOSTS = ['gog.com'] as const;
const EPIC_STORE_HOSTS = ['epicgames.com'] as const;

const MICROSOFT_CDN_HOSTS = [
  's-microsoft.com',
  'xboxlive.com',
  'compass-ssl.xbox.com',
] as const;
const STEAM_CDN_HOSTS = [
  'steamstatic.com',
  'steamcdn-a.akamaihd.net',
  'steamcommunity.com',
] as const;
const GOG_CDN_HOSTS = ['gog-statics.com', 'gog.com'] as const;
const IGDB_CDN_HOSTS = ['igdb.com'] as const;

export interface ParseSafeHttpUrlOptions {
  allowHttp?: boolean;
  unwrapOlMedia?: boolean;
}

/**
 * Unwraps an `ol-media://` URL to its underlying upstream URL when present,
 * returning the trimmed string unchanged otherwise.
 */
export function unwrapMediaUrl(rawUrl?: string | null): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  if (OL_MEDIA_SCHEME_PREFIX_RE.test(trimmed)) {
    const normalized = `ol-media://${trimmed.slice('ol-media://'.length)}`;
    return unwrapOlMediaUrl(normalized);
  }
  return trimmed;
}

/**
 * Parses an HTTP(S) URL safely, enforcing scheme and non-empty hostname while rejecting
 * control characters or malformed inputs. Defaults to HTTPS-only (`allowHttp: false`).
 */
export function parseSafeHttpUrl(
  rawUrl?: string | null,
  options?: ParseSafeHttpUrlOptions
): URL | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const candidate = options?.unwrapOlMedia ? unwrapMediaUrl(rawUrl) : rawUrl.trim();
  if (!candidate || CONTROL_CHAR_OR_BACKSLASH_RE.test(candidate)) {
    return null;
  }
  try {
    const parsed = new URL(candidate);
    const protocolOk = options?.allowHttp
      ? parsed.protocol === 'https:' || parsed.protocol === 'http:'
      : parsed.protocol === 'https:';
    if (!protocolOk || !parsed.hostname) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Strictly validates an `ol-media://` URL to the allowlisted authorities `asset`, `covers`, and `vault`:
 * - Rejects arbitrary authorities (e.g. `ol-media://evil/...`), userinfo, ports, backslashes, control chars
 * - Rejects path traversal segments (`..`, `%2e%2e`, malformed percent-encoding)
 * - For `ol-media://covers/...` and `ol-media://vault/...`, requires a non-empty relative path after `/`
 * - For `ol-media://asset?...` or `ol-media://asset/...`, requires a query or path, and when an
 *   embedded `url` query parameter is present, requires it to parse as a valid `https:` URL
 */
export function isAllowedOlMediaUrl(rawUrl?: string | null): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!OL_MEDIA_SCHEME_PREFIX_RE.test(trimmed) || CONTROL_CHAR_OR_BACKSLASH_RE.test(trimmed)) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'ol-media:' || parsed.username || parsed.password || parsed.port) {
    return false;
  }

  const authority = parsed.hostname.toLowerCase();
  if (authority !== 'asset' && authority !== 'covers' && authority !== 'vault') {
    return false;
  }

  // Inspect raw pre-URL-normalization path so `new URL()` dot-segment resolution cannot mask `..`
  const afterScheme = trimmed.slice('ol-media://'.length);
  const rawQueryIdx = afterScheme.indexOf('?');
  const rawHashIdx = afterScheme.indexOf('#');
  const rawPathEnd = Math.min(
    rawQueryIdx >= 0 ? rawQueryIdx : afterScheme.length,
    rawHashIdx >= 0 ? rawHashIdx : afterScheme.length
  );
  const rawPathStart = afterScheme.indexOf('/');
  const rawPath =
    rawPathStart >= 0 && rawPathStart < rawPathEnd
      ? afterScheme.slice(rawPathStart, rawPathEnd)
      : '';

  if (PATH_TRAVERSAL_SEGMENT_RE.test(rawPath) || PATH_TRAVERSAL_SEGMENT_RE.test(parsed.pathname)) {
    return false;
  }

  let decodedRawPath: string;
  let decodedPathname: string;
  try {
    decodedRawPath = decodeURIComponent(rawPath);
    decodedPathname = decodeURIComponent(parsed.pathname);
  } catch {
    return false;
  }
  if (
    CONTROL_CHAR_OR_BACKSLASH_RE.test(decodedRawPath) ||
    CONTROL_CHAR_OR_BACKSLASH_RE.test(decodedPathname) ||
    PATH_TRAVERSAL_SEGMENT_RE.test(decodedRawPath) ||
    PATH_TRAVERSAL_SEGMENT_RE.test(decodedPathname)
  ) {
    return false;
  }

  if (authority === 'covers' || authority === 'vault') {
    return parsed.pathname.startsWith('/') && decodedPathname.length > 1;
  }

  const hasNonEmptyPath = parsed.pathname.startsWith('/') && decodedPathname.length > 1;
  const hasQuery = parsed.search.length > 1;
  if (!hasNonEmptyPath && !hasQuery) {
    return false;
  }

  if (parsed.searchParams.has('url')) {
    const embeddedUrl = parsed.searchParams.get('url');
    if (!parseSafeHttpUrl(embeddedUrl, { allowHttp: false })) {
      return false;
    }
  }

  return true;
}

/**
 * Exact-domain or subdomain allowlist matcher (blocks suffix collisions such as `evilmetacritic.com`).
 */
export function matchesAllowedHost(
  hostname: string | undefined | null,
  allowedHosts: readonly string[]
): boolean {
  if (!hostname || typeof hostname !== 'string') return false;
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized) return false;
  for (const allowed of allowedHosts) {
    const cleanAllowed = allowed.trim().toLowerCase().replace(/\.$/, '');
    if (!cleanAllowed) continue;
    if (normalized === cleanAllowed || normalized.endsWith(`.${cleanAllowed}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts a normalized lowercase hostname from an HTTP(S) URL (optionally unwrapping `ol-media://`).
 */
export function getUrlHostname(
  rawUrl?: string | null,
  options?: ParseSafeHttpUrlOptions
): string | null {
  const parsed = parseSafeHttpUrl(rawUrl, {
    allowHttp: options?.allowHttp ?? true,
    unwrapOlMedia: options?.unwrapOlMedia ?? false,
  });
  return parsed ? parsed.hostname.toLowerCase() : null;
}

/**
 * Validates that a URL is a well-formed HTTP(S) URL whose hostname matches `allowedHosts`.
 */
export function isUrlMatchingHosts(
  rawUrl: string | undefined | null,
  allowedHosts: readonly string[],
  options?: ParseSafeHttpUrlOptions
): boolean {
  const parsed = parseSafeHttpUrl(rawUrl, options);
  if (!parsed) return false;
  return matchesAllowedHost(parsed.hostname, allowedHosts);
}

export function isValidMetacriticHostUrl(url?: string | null): boolean {
  return isUrlMatchingHosts(url, METACRITIC_HOSTS, { allowHttp: true });
}

export const isMetacriticHostUrl = isValidMetacriticHostUrl;

export function isOpenCriticHostUrl(url?: string | null): boolean {
  return isUrlMatchingHosts(url, OPENCRITIC_HOSTS, { allowHttp: true });
}

export function isXboxStoreUrl(url?: string | null): boolean {
  return isUrlMatchingHosts(url, XBOX_STORE_HOSTS, { allowHttp: true });
}

export const isXboxStoreHostUrl = isXboxStoreUrl;

export function isSteamStoreUrl(url?: string | null): boolean {
  return isUrlMatchingHosts(url, STEAM_STORE_HOSTS, { allowHttp: true });
}

export function isGogStoreUrl(url?: string | null): boolean {
  return isUrlMatchingHosts(url, GOG_STORE_HOSTS, { allowHttp: true });
}

export function isEpicStoreUrl(url?: string | null): boolean {
  return isUrlMatchingHosts(url, EPIC_STORE_HOSTS, { allowHttp: true });
}

export function isMicrosoftStoreCdnHost(url?: string | null): boolean {
  return isUrlMatchingHosts(url, MICROSOFT_CDN_HOSTS, {
    allowHttp: true,
    unwrapOlMedia: true,
  });
}

export function isSteamCdnHost(url?: string | null): boolean {
  return isUrlMatchingHosts(url, STEAM_CDN_HOSTS, {
    allowHttp: true,
    unwrapOlMedia: true,
  });
}

export function isGogCdnHost(url?: string | null): boolean {
  return isUrlMatchingHosts(url, GOG_CDN_HOSTS, {
    allowHttp: true,
    unwrapOlMedia: true,
  });
}

export function isIgdbCdnHost(url?: string | null): boolean {
  return isUrlMatchingHosts(url, IGDB_CDN_HOSTS, {
    allowHttp: true,
    unwrapOlMedia: true,
  });
}
