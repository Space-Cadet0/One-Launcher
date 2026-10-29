export interface EpicCodenameMapping {
  title: string;
  steamAppId?: number;
  developer?: string;
  description?: string;
  headerImage?: string;
  capsuleImage?: string;
  iconUrl?: string;
}

export const KNOWN_EPIC_APP_NAMES: Record<string, EpicCodenameMapping> = {};

/**
 * Legacy set preserved as an empty symbol export for backwards compatibility.
 * Epic internal project codename detection now relies exclusively on structural
 * metadata/identifier heuristics rather than hardcoded per-account wordlists.
 */
export const UNMAPPED_EPIC_INTERNAL_CODENAMES: ReadonlySet<string> = new Set<string>();

export interface EpicCodenameInspectionInput {
  id?: string;
  title?: string;
  steamAppId?: number | null;
  isVerifiedEntitlement?: boolean;
  headerImage?: string;
  capsuleImage?: string;
  iconUrl?: string;
  shortDescription?: string;
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  platforms?: Array<{
    platformId?: string;
    platformGameId?: string;
    installed?: boolean;
  }>;
}

function hasRealArtworkUrl(url?: string): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  return !trimmed.includes('egs-badge.png');
}

/**
 * Structural detector for unmapped Epic internal project codenames / private sandbox stubs.
 * Never flags installed games, mapped titles, titles with real storefront metadata/artwork,
 * multi-word titles, or verified Title-Cased standalone storefront titles (e.g. "Hades", "Control", "Celeste").
 */
export function hasStructuralEpicCodenameTraits(input: EpicCodenameInspectionInput): boolean {
  const rawTitle = (input.title || '').trim();
  if (!rawTitle || /\s/.test(rawTitle)) {
    return false;
  }

  const lowerTitle = rawTitle.toLowerCase();
  if (UNMAPPED_EPIC_INTERNAL_CODENAMES.has(lowerTitle)) {
    return true;
  }

  if (Array.isArray(input.platforms) && input.platforms.some((p) => p?.installed === true)) {
    return false;
  }

  if (typeof input.steamAppId === 'number' && input.steamAppId > 0) {
    return false;
  }

  const epicPlat = input.platforms?.find((p) => p?.platformId === 'epic');
  const epicPlatId = (epicPlat?.platformGameId || '').trim();
  const cleanId = (input.id || '').replace(/^epic-/i, '').trim().toLowerCase();
  if (
    KNOWN_EPIC_APP_NAMES[lowerTitle] ||
    (epicPlatId && KNOWN_EPIC_APP_NAMES[epicPlatId.toLowerCase()]) ||
    (cleanId && KNOWN_EPIC_APP_NAMES[cleanId])
  ) {
    return false;
  }

  const hasPublicDisplayMetadata =
    hasRealArtworkUrl(input.headerImage) ||
    hasRealArtworkUrl(input.capsuleImage) ||
    hasRealArtworkUrl(input.iconUrl) ||
    Boolean(input.shortDescription && input.shortDescription.trim().length > 0) ||
    Boolean(input.developers && input.developers.length > 0) ||
    Boolean(input.publishers && input.publishers.length > 0) ||
    Boolean(input.genres && input.genres.length > 0);

  if (hasPublicDisplayMetadata) {
    return false;
  }

  // 1. Strictly all-lowercase single-token identifier (e.g. "snapdragon", "staging_branch")
  if (rawTitle === lowerTitle && /^[a-z][a-z0-9_-]{2,31}$/.test(rawTitle)) {
    return true;
  }

  // 2. Mid-word camelCase / PascalCase internal compound project alias without spaces (e.g. "CobaltFalcon", "CrimsonHarbor")
  if (/[a-z][A-Z]/.test(rawTitle) && /^[A-Za-z][A-Za-z0-9_-]{3,39}$/.test(rawTitle)) {
    return true;
  }

  // 3. Explicit codename/staging sandbox identifier markers
  if (
    /(?:^|[_-])(?:codename|staging|devbuild|qa_?test|playtest)(?:[_-]|$)/i.test(epicPlatId) ||
    /(?:staging|devbuild|qatest|internalbuild)$/i.test(rawTitle)
  ) {
    return true;
  }

  // 4. Unverified single-token sandbox stub lacking all public storefront metadata
  if (input.isVerifiedEntitlement !== true && /^[a-z0-9_-]{3,32}$/i.test(rawTitle)) {
    return true;
  }

  return false;
}
