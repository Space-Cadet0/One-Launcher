/**
 * Steam library portrait cover URL builder and URL-kind parser.
 *
 * Unwraps `ol-media://` vault wrappers before inspecting `/apps/<id>/[sha1/]library_*` paths,
 * cleanly distinguishing unhashed legacy paths from 40-char SHA1-hashed asset paths.
 */

import { unwrapOlMediaUrl } from '../../contracts/network';

export const STEAM_LIBRARY_COVER_URL_RE =
  /\/apps\/(\d+)\/(?:([a-f0-9]{40})\/)?library_(?:600x900|capsule)/i;

export interface ParsedSteamLibraryCoverUrl {
  appId: number;
  sha1: string | null;
}

export interface SteamPortraitCoverUrls {
  standard: string;
  retina: string;
}

const STEAM_AKAMAI_STORE_ASSETS_BASE =
  'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps';

/**
 * Parses a Steam library cover URL (or `ol-media://` wrapped URL) into `{ appId, sha1 }`.
 * Returns `null` when the URL is not a Steam library portrait cover path.
 */
export function parseSteamLibraryCoverUrl(
  url?: string | null
): ParsedSteamLibraryCoverUrl | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  const raw = trimmed.startsWith('ol-media://') ? unwrapOlMediaUrl(trimmed) : trimmed;
  const match = STEAM_LIBRARY_COVER_URL_RE.exec(raw);
  if (!match) return null;
  const appId = Number(match[1]);
  if (!Number.isFinite(appId) || appId <= 0) return null;
  const sha1 = match[2] ? match[2].toLowerCase() : null;
  return { appId, sha1 };
}

/**
 * Builds canonical unhashed 2:3 Steam portrait cover URLs (`1x` and `2x`).
 */
export function buildSteamPortraitCoverUrls(appId: number): SteamPortraitCoverUrls {
  return {
    standard: `${STEAM_AKAMAI_STORE_ASSETS_BASE}/${appId}/library_600x900.jpg`,
    retina: `${STEAM_AKAMAI_STORE_ASSETS_BASE}/${appId}/library_600x900_2x.jpg`,
  };
}

/**
 * Builds the canonical unhashed Steam portrait URL used for HEAD/status liveness probing.
 */
export function buildSteamPortraitProbeUrl(appId: number): string {
  return `${STEAM_AKAMAI_STORE_ASSETS_BASE}/${appId}/library_600x900.jpg`;
}
