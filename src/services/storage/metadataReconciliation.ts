import {
  igdbCoverService,
  isGogCroppedHorizontalCover,
  isUnsuitableCoverUrl,
  isUnsuitableHeaderUrl,
} from '../igdb/igdbCoverService';
import { isMicrosoftStoreCdnUrl, isSteamCdnAssetUrl } from '../common/titleUtils';

/**
 * Strictly monotonic artwork authority ranking (modeled on `achievementReconciliation.ts`):
 * - 6: USER_OVERRIDE            Explicit UserGameOverride capsule/header URL
 * - 5: VERIFIED_LOCAL_PORTRAIT  Verified local `ol-media://` or runtime-verified local portrait asset
 * - 4: STOREFRONT_VERIFIED_2X3  Steam 40-char SHA1 hashed or `?t=` verified portrait/header,
 *                               GOG vertical boxart, Epic tall/portrait, Xbox 2:3 BoxArt
 * - 3: IGDB_VERIFIED_2X3        Verified `images.igdb.com/.../t_cover_big/...` portrait
 * - 2: STEAM_UNHASHED_GUESS     Synthetic unhashed, untimestamped `.../apps/<id>/library_600x900*.jpg`
 *                               or untimestamped `.../apps/<id>/header.jpg`
 * - 1: UNSUITABLE_OR_LANDSCAPE  Dead asset, 16:9 banner in capsule slot, `_glx_vertical_cover`, badge
 * - 0: EMPTY                    Missing / empty string
 */
export const ArtworkAuthorityRank = {
  EMPTY: 0,
  UNSUITABLE_OR_LANDSCAPE: 1,
  STEAM_UNHASHED_GUESS: 2,
  IGDB_VERIFIED_2X3: 3,
  STOREFRONT_VERIFIED_2X3: 4,
  VERIFIED_LOCAL_PORTRAIT: 5,
  USER_OVERRIDE: 6,
} as const;

export type ArtworkAuthorityRank =
  (typeof ArtworkAuthorityRank)[keyof typeof ArtworkAuthorityRank];

export const ARTWORK_AUTHORITY_RANK = ArtworkAuthorityRank;

export interface ArtworkRecoveryContext {
  gameId?: string;
  title?: string;
  steamAppId?: number | null;
  gogId?: string | number | null;
  userOverrideCapsule?: string | null;
  userOverrideHeader?: string | null;
  verifiedLocalCapsule?: string | null;
  verifiedLocalHeader?: string | null;
  headerUrl?: string | null;
}

const STEAM_HASHED_ASSET_RE = /\/apps\/\d+\/[a-f0-9]{40}\//i;
const STEAM_TIMESTAMP_PARAM_RE = /[?&]t=\d+/i;
const STEAM_UNHASHED_CAPSULE_RE =
  /\/apps\/\d+\/library_(?:600x900|capsule)[^/?#]*\.(?:jpg|jpeg|png|webp)(?:$|\?)/i;
const STEAM_UNHASHED_HEADER_RE = /\/apps\/\d+\/header\.(?:jpg|jpeg|png|webp)(?:$|\?)/i;
const STEAM_2X_CAPSULE_RE = /library_(?:600x900|capsule)_2x\./i;
const IGDB_OR_LUTRIS_CDN_RE = /(?:images\.igdb\.com|lutris\.net)/i;
const GOG_CDN_RE = /(?:^|\/\/|\.)gog-statics\.com\//i;
const EPIC_CDN_RE = /(?:epicgames\.com|unrealengine\.com)\//i;

type StorefrontCdnFamily = 'steam' | 'gog' | 'epic' | 'ms' | 'igdb' | 'other';

function getStorefrontCdnFamily(url: string): StorefrontCdnFamily {
  if (isSteamCdnAssetUrl(url)) return 'steam';
  if (GOG_CDN_RE.test(url)) return 'gog';
  if (EPIC_CDN_RE.test(url)) return 'epic';
  if (isMicrosoftStoreCdnUrl(url)) return 'ms';
  if (IGDB_OR_LUTRIS_CDN_RE.test(url)) return 'igdb';
  return 'other';
}

function isValidNonEmptyUrl(url?: string | null): url is string {
  return typeof url === 'string' && url.trim().length > 0;
}

/**
 * Computes the monotonic authority rank for a 2:3 portrait capsule artwork URL.
 */
export function getCapsuleAuthorityRank(
  url?: string | null,
  ctx?: ArtworkRecoveryContext
): ArtworkAuthorityRank {
  if (!isValidNonEmptyUrl(url)) {
    return ARTWORK_AUTHORITY_RANK.EMPTY;
  }
  const trimmed = url.trim();

  if (isValidNonEmptyUrl(ctx?.userOverrideCapsule) && ctx.userOverrideCapsule.trim() === trimmed) {
    return ARTWORK_AUTHORITY_RANK.USER_OVERRIDE;
  }

  if (
    isUnsuitableCoverUrl(trimmed) ||
    (isValidNonEmptyUrl(ctx?.headerUrl) && isGogCroppedHorizontalCover(trimmed, ctx.headerUrl))
  ) {
    return ARTWORK_AUTHORITY_RANK.UNSUITABLE_OR_LANDSCAPE;
  }

  if (
    trimmed.toLowerCase().startsWith('ol-media://') ||
    (isValidNonEmptyUrl(ctx?.verifiedLocalCapsule) && ctx.verifiedLocalCapsule.trim() === trimmed)
  ) {
    return ARTWORK_AUTHORITY_RANK.VERIFIED_LOCAL_PORTRAIT;
  }

  if (isSteamCdnAssetUrl(trimmed)) {
    if (STEAM_HASHED_ASSET_RE.test(trimmed) || STEAM_TIMESTAMP_PARAM_RE.test(trimmed)) {
      return ARTWORK_AUTHORITY_RANK.STOREFRONT_VERIFIED_2X3;
    }
    if (STEAM_UNHASHED_CAPSULE_RE.test(trimmed)) {
      return ARTWORK_AUTHORITY_RANK.STEAM_UNHASHED_GUESS;
    }
    return ARTWORK_AUTHORITY_RANK.STOREFRONT_VERIFIED_2X3;
  }

  if (IGDB_OR_LUTRIS_CDN_RE.test(trimmed)) {
    return ARTWORK_AUTHORITY_RANK.IGDB_VERIFIED_2X3;
  }

  // Verified non-Steam storefront 2:3 art (GOG vertical API, Epic tall, Xbox 2:3 BoxArt, or other valid HTTPS portrait)
  return ARTWORK_AUTHORITY_RANK.STOREFRONT_VERIFIED_2X3;
}

/**
 * Computes the monotonic authority rank for a horizontal header / banner artwork URL.
 */
export function getHeaderAuthorityRank(
  url?: string | null,
  ctx?: ArtworkRecoveryContext
): ArtworkAuthorityRank {
  if (!isValidNonEmptyUrl(url)) {
    return ARTWORK_AUTHORITY_RANK.EMPTY;
  }
  const trimmed = url.trim();

  if (isValidNonEmptyUrl(ctx?.userOverrideHeader) && ctx.userOverrideHeader.trim() === trimmed) {
    return ARTWORK_AUTHORITY_RANK.USER_OVERRIDE;
  }

  if (isUnsuitableHeaderUrl(trimmed)) {
    return ARTWORK_AUTHORITY_RANK.UNSUITABLE_OR_LANDSCAPE;
  }

  if (
    trimmed.toLowerCase().startsWith('ol-media://') ||
    (isValidNonEmptyUrl(ctx?.verifiedLocalHeader) && ctx.verifiedLocalHeader.trim() === trimmed)
  ) {
    return ARTWORK_AUTHORITY_RANK.VERIFIED_LOCAL_PORTRAIT;
  }

  if (isSteamCdnAssetUrl(trimmed)) {
    if (STEAM_HASHED_ASSET_RE.test(trimmed) || STEAM_TIMESTAMP_PARAM_RE.test(trimmed)) {
      return ARTWORK_AUTHORITY_RANK.STOREFRONT_VERIFIED_2X3;
    }
    if (STEAM_UNHASHED_HEADER_RE.test(trimmed)) {
      return ARTWORK_AUTHORITY_RANK.STEAM_UNHASHED_GUESS;
    }
    return ARTWORK_AUTHORITY_RANK.STOREFRONT_VERIFIED_2X3;
  }

  if (IGDB_OR_LUTRIS_CDN_RE.test(trimmed)) {
    return ARTWORK_AUTHORITY_RANK.IGDB_VERIFIED_2X3;
  }

  return ARTWORK_AUTHORITY_RANK.STOREFRONT_VERIFIED_2X3;
}

function recoverCapsuleSynchronously(ctx?: ArtworkRecoveryContext): string | undefined {
  if (!ctx) return undefined;

  if (
    isValidNonEmptyUrl(ctx.userOverrideCapsule) &&
    !isUnsuitableCoverUrl(ctx.userOverrideCapsule)
  ) {
    return ctx.userOverrideCapsule.trim();
  }

  if (
    isValidNonEmptyUrl(ctx.verifiedLocalCapsule) &&
    !isUnsuitableCoverUrl(ctx.verifiedLocalCapsule)
  ) {
    return ctx.verifiedLocalCapsule.trim();
  }

  if (ctx.gogId !== undefined && ctx.gogId !== null && String(ctx.gogId).trim() !== '') {
    const gogCover = igdbCoverService.getGogVerticalCoverInstant(ctx.gogId, ctx.title);
    if (
      isValidNonEmptyUrl(gogCover) &&
      !isUnsuitableCoverUrl(gogCover) &&
      (!isValidNonEmptyUrl(ctx.headerUrl) || !isGogCroppedHorizontalCover(gogCover, ctx.headerUrl))
    ) {
      return gogCover.trim();
    }
  } else if (isValidNonEmptyUrl(ctx.title)) {
    const gogCoverByTitle = igdbCoverService.getGogVerticalCoverInstant(undefined, ctx.title);
    if (
      isValidNonEmptyUrl(gogCoverByTitle) &&
      !isUnsuitableCoverUrl(gogCoverByTitle) &&
      (!isValidNonEmptyUrl(ctx.headerUrl) ||
        !isGogCroppedHorizontalCover(gogCoverByTitle, ctx.headerUrl))
    ) {
      return gogCoverByTitle.trim();
    }
  }

  if (isValidNonEmptyUrl(ctx.title) || ctx.steamAppId || isValidNonEmptyUrl(ctx.gameId)) {
    const igdbCover = igdbCoverService.getIgdbCoverInstant(
      ctx.title,
      ctx.steamAppId ?? undefined,
      ctx.gameId
    );
    if (isValidNonEmptyUrl(igdbCover) && !isUnsuitableCoverUrl(igdbCover)) {
      return igdbCover.trim();
    }
  }

  return undefined;
}

/**
 * Monotonically reconciles existing and incoming 2:3 capsule artwork URLs.
 *
 * Hard invariants:
 * 1. User overrides (Rank 6) always take precedence when valid.
 * 2. Non-Downgrade: Lower-rank synthetic URLs (e.g., Rank 2 unhashed Steam guesses) NEVER
 *    overwrite higher-rank verified art (Rank 3+ IGDB / GOG / Epic / SHA1-hashed / `?t=` Steam).
 * 3. Equal-Rank Resolution: Authoritative Steam beats MS Store CDN in both directions;
 *    SHA1 beats `?t=`; `_2x` beats `1x`; same-storefront equal-rank updates prefer incoming
 *    fresh URLs so genuine art updates flow cleanly without cross-storefront ping-pong.
 * 4. Non-Erasure with Synchronous Recovery: If both existing and incoming are empty/unsuitable/dead,
 *    synchronously consult `userOverrideCapsule -> verifiedLocalCapsule -> getGogVerticalCoverInstant -> getIgdbCoverInstant`
 *    before ever returning `undefined`.
 */
export function reconcileCapsuleImage(
  existingUrl?: string | null,
  incomingUrl?: string | null,
  ctx?: ArtworkRecoveryContext
): string | undefined {
  if (
    isValidNonEmptyUrl(ctx?.userOverrideCapsule) &&
    !isUnsuitableCoverUrl(ctx.userOverrideCapsule)
  ) {
    return ctx.userOverrideCapsule.trim();
  }

  const existingRank = getCapsuleAuthorityRank(existingUrl, ctx);
  const incomingRank = getCapsuleAuthorityRank(incomingUrl, ctx);

  const validExisting =
    existingRank >= ARTWORK_AUTHORITY_RANK.STEAM_UNHASHED_GUESS && isValidNonEmptyUrl(existingUrl)
      ? existingUrl.trim()
      : undefined;
  const validIncoming =
    incomingRank >= ARTWORK_AUTHORITY_RANK.STEAM_UNHASHED_GUESS && isValidNonEmptyUrl(incomingUrl)
      ? incomingUrl.trim()
      : undefined;

  if (!validExisting && !validIncoming) {
    return recoverCapsuleSynchronously(ctx);
  }
  if (!validExisting) return validIncoming;
  if (!validIncoming) return validExisting;

  if (existingRank > incomingRank) return validExisting;
  if (incomingRank > existingRank) return validIncoming;

  // Equal rank >= 2
  if (validExisting === validIncoming) return validExisting;

  const existingFamily = getStorefrontCdnFamily(validExisting);
  const incomingFamily = getStorefrontCdnFamily(validIncoming);

  if (existingRank >= ARTWORK_AUTHORITY_RANK.STOREFRONT_VERIFIED_2X3) {
    // Authoritative verified Steam CDN covers always beat MS Store CDN in both directions
    if (existingFamily === 'steam' && incomingFamily === 'ms') return validExisting;
    if (incomingFamily === 'steam' && existingFamily === 'ms') return validIncoming;

    if (existingFamily === 'steam' && incomingFamily === 'steam') {
      const existingHasSha1 = STEAM_HASHED_ASSET_RE.test(validExisting);
      const incomingHasSha1 = STEAM_HASHED_ASSET_RE.test(validIncoming);
      if (existingHasSha1 && !incomingHasSha1) return validExisting;
      if (incomingHasSha1 && !existingHasSha1) return validIncoming;

      const existingIs2x = STEAM_2X_CAPSULE_RE.test(validExisting);
      const incomingIs2x = STEAM_2X_CAPSULE_RE.test(validIncoming);
      if (existingIs2x && !incomingIs2x) return validExisting;
      if (incomingIs2x && !existingIs2x) return validIncoming;

      return validIncoming;
    }

    // Same-storefront art refresh flows cleanly; cross-storefront keeps existing to prevent flip-flopping
    if (existingFamily === incomingFamily) {
      return validIncoming;
    }
    return validExisting;
  }

  if (existingRank === ARTWORK_AUTHORITY_RANK.IGDB_VERIFIED_2X3) {
    return validIncoming;
  }

  // Both are Rank 2 (STEAM_UNHASHED_GUESS): prefer higher-resolution `_2x` variant
  const existingIs2x = STEAM_2X_CAPSULE_RE.test(validExisting);
  const incomingIs2x = STEAM_2X_CAPSULE_RE.test(validIncoming);
  if (incomingIs2x && !existingIs2x) return validIncoming;
  return validExisting;
}

/**
 * Monotonically reconciles existing and incoming horizontal header / banner URLs.
 * Prevents untimestamped synthetic Steam `header.jpg` guesses (Rank 2) from clobbering
 * verified GOG / Epic / `?t=`-timestamped / SHA1-hashed headers (Rank 4).
 */
export function reconcileHeaderImage(
  existingUrl?: string | null,
  incomingUrl?: string | null,
  ctx?: ArtworkRecoveryContext
): string | undefined {
  if (
    isValidNonEmptyUrl(ctx?.userOverrideHeader) &&
    !isUnsuitableHeaderUrl(ctx.userOverrideHeader)
  ) {
    return ctx.userOverrideHeader.trim();
  }

  const existingRank = getHeaderAuthorityRank(existingUrl, ctx);
  const incomingRank = getHeaderAuthorityRank(incomingUrl, ctx);

  const validExisting =
    existingRank >= ARTWORK_AUTHORITY_RANK.STEAM_UNHASHED_GUESS && isValidNonEmptyUrl(existingUrl)
      ? existingUrl.trim()
      : undefined;
  const validIncoming =
    incomingRank >= ARTWORK_AUTHORITY_RANK.STEAM_UNHASHED_GUESS && isValidNonEmptyUrl(incomingUrl)
      ? incomingUrl.trim()
      : undefined;

  if (!validExisting && !validIncoming) {
    return isValidNonEmptyUrl(ctx?.verifiedLocalHeader) &&
      !isUnsuitableHeaderUrl(ctx.verifiedLocalHeader)
      ? ctx.verifiedLocalHeader.trim()
      : undefined;
  }
  if (!validExisting) return validIncoming;
  if (!validIncoming) return validExisting;

  if (existingRank > incomingRank) return validExisting;
  if (incomingRank > existingRank) return validIncoming;

  if (validExisting === validIncoming) return validExisting;

  const existingFamily = getStorefrontCdnFamily(validExisting);
  const incomingFamily = getStorefrontCdnFamily(validIncoming);

  if (existingRank >= ARTWORK_AUTHORITY_RANK.STOREFRONT_VERIFIED_2X3) {
    if (existingFamily === 'steam' && incomingFamily === 'ms') return validExisting;
    if (incomingFamily === 'steam' && existingFamily === 'ms') return validIncoming;

    if (existingFamily === 'steam' && incomingFamily === 'steam') {
      const existingHasSha1 = STEAM_HASHED_ASSET_RE.test(validExisting);
      const incomingHasSha1 = STEAM_HASHED_ASSET_RE.test(validIncoming);
      if (existingHasSha1 && !incomingHasSha1) return validExisting;
      if (incomingHasSha1 && !existingHasSha1) return validIncoming;
      return validIncoming;
    }

    if (existingFamily === incomingFamily) {
      return validIncoming;
    }
    return validExisting;
  }

  if (existingRank === ARTWORK_AUTHORITY_RANK.IGDB_VERIFIED_2X3) {
    return validIncoming;
  }

  return validExisting;
}
