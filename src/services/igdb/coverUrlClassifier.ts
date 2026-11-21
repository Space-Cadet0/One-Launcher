/**
 * Pure cover & header URL suitability classifier.
 *
 * Unwraps `ol-media://` vault URLs via `unwrapOlMediaUrl()` at the entry of every classifier
 * so Electron vault-wrapped artwork URLs are evaluated identically to upstream HTTPS URLs.
 */

import { unwrapOlMediaUrl } from '../../contracts/network';

const GOG_HASH_RE = /\/([a-f0-9]{64})/i;
const WIDE_OR_LANDSCAPE_ASSET_TOKEN_REGEX = /(?:^|[^a-z0-9])(wide|landscape)(?:$|[^a-z0-9])/i;

function unwrapAndTrimUrl(url?: string | null): string {
  if (!url) return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  return unwrapOlMediaUrl(trimmed).trim();
}

function isGogStaticsUrl(rawUrl: string): boolean {
  try {
    const normalized = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
    const host = new URL(normalized).hostname.toLowerCase();
    return host === 'gog-statics.com' || host.endsWith('.gog-statics.com');
  } catch {
    return false;
  }
}

/**
 * Extracts the 64-character hex asset hash from a GOG CDN URL (including `ol-media://` wrappers).
 */
export function extractGogImageHash(url?: string | null): string | null {
  const raw = unwrapAndTrimUrl(url);
  if (!raw) return null;
  const match = raw.match(GOG_HASH_RE);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Detects whether a GOG cover URL is a server-cropped 16:9 horizontal banner
 * (created by applying the `_glx_vertical_cover` formatter to a horizontal `p.image` hash
 * or sharing the same 64-char hash as the game's horizontal `headerImage`).
 */
export function isGogCroppedHorizontalCover(
  capsuleUrl?: string | null,
  headerUrl?: string | null
): boolean {
  const rawCapsule = unwrapAndTrimUrl(capsuleUrl);
  if (!rawCapsule) return false;
  if (!isGogStaticsUrl(rawCapsule)) return false;

  const lower = rawCapsule.toLowerCase();
  if (lower.includes('_glx_vertical_cover')) return true;

  if (headerUrl) {
    const rawHeader = unwrapAndTrimUrl(headerUrl);
    if (rawHeader) {
      const capHash = extractGogImageHash(rawCapsule);
      const headHash = extractGogImageHash(rawHeader);
      if (capHash && headHash && capHash === headHash) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Pure URL pattern check for horizontal banners, wide capsules, server-cropped GOG banners,
 * and default placeholder icons (unwrapping `ol-media://` first).
 */
export function hasUnsuitableCoverUrlPattern(url?: string | null): boolean {
  const raw = unwrapAndTrimUrl(url);
  if (!raw) return true;
  const lower = raw.toLowerCase();

  return (
    lower.includes('184x69') ||
    lower.includes('capsule_184x69') ||
    lower.includes('capsule_sm_120') ||
    lower.includes('231x87') ||
    lower.includes('467x181') ||
    lower.includes('616x353') ||
    lower.includes('header.jpg') ||
    lower.includes('mobile_slider') ||
    lower.includes('sbicon') ||
    lower.includes('_glx_vertical_cover') ||
    lower.includes('_glx_logo') ||
    lower.includes('avatars/default.png') ||
    lower.includes('egs-badge') ||
    WIDE_OR_LANDSCAPE_ASSET_TOKEN_REGEX.test(lower)
  );
}

/**
 * Checks whether a header/banner or icon URL is a placeholder badge, SDK test asset,
 * or belongs to a dead Steam CDN asset that should be replaced when merging metadata.
 */
export function isUnsuitableHeaderUrl(url?: string | null): boolean {
  const raw = unwrapAndTrimUrl(url);
  if (!raw) return true;
  const lower = raw.toLowerCase();
  return (
    lower.includes('egs-badge') ||
    lower.includes('avatars/default.png') ||
    lower.includes('/apps/480/') ||
    lower.endsWith('/480/header.jpg')
  );
}
