/**
 * Microsoft Store / Xbox DisplayCatalog metadata client via Electron IPC.
 */

import {
  SteamCategory,
  SteamEnrichedMetadata,
  SteamMovie,
  SteamReviewSummary,
  SteamScreenshot,
  XboxDeliveryHints,
} from '../../../contracts/steam';
import { stripHtmlToPlainSynopsis } from '../../common/synopsisTextUtils';
import { sanitizeStoreReleaseDate } from '../../common/titleUtils';
import { getSteamCategoryIconUrl } from '../steamApi';
import {
  ensureHttps,
  formatDescriptionToHtml,
  getErrorMessage,
  type RawMediaMovieItem,
  type RawMediaScreenshotItem,
} from './storefrontTextFormatting';

interface NormalizedXboxIpcPayload {
  title?: string;
  name?: string;
  shortDescription?: string;
  detailedDescription?: string;
  aboutTheGame?: string;
  description?: string;
  headerImage?: string;
  heroUrl?: string;
  capsuleImage?: string;
  posterUrl?: string;
  iconUrl?: string;
  releaseDate?: string;
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  tags?: string[];
  capabilities?: string[];
  categories?: Array<string | { description?: string }>;
  screenshots?: Array<string | RawMediaScreenshotItem>;
  movies?: RawMediaMovieItem[];
  systemRequirements?: { minimum?: string; recommended?: string };
  pcRequirements?: { minimum?: string; recommended?: string };
  storeUrl?: string;
  website?: string;
  averageRating?: number;
  starRating?: number;
  ratingCount?: number;
  reviewCount?: number;
  reviewSummary?: SteamReviewSummary;
  xboxDeliveryHints?: XboxDeliveryHints;
  product?: Record<string, unknown>;
  results?: Array<Record<string, unknown>>;
}

export interface XboxMetadataFetchOptions {
  xboxProductId?: string;
  xboxTitleId?: string;
  packageFamilyName?: string;
  platformGameId?: string;
  title?: string;
  synopsisOnly?: boolean;
}

/**
 * Fetches rich metadata directly from Microsoft Store DisplayCatalog via Electron IPC Bridge.
 */
export async function fetchXboxProductMetadata(
  options: XboxMetadataFetchOptions
): Promise<Partial<SteamEnrichedMetadata> | null> {
  if (typeof window === 'undefined' || !window.electronAPI?.fetchXboxProductMetadata) {
    return null;
  }

  const synopsisOnly = Boolean(options.synopsisOnly);
  const cleanBigId = (
    options.xboxProductId ||
    (/^[A-Z0-9]{12}$/i.test(String(options.platformGameId || ''))
      ? options.platformGameId
      : undefined) ||
    ''
  )
    .replace(/^xbox[-_]/i, '')
    .trim();

  try {
    const rawIpcData = await window.electronAPI.fetchXboxProductMetadata({
      xboxProductId: cleanBigId || undefined,
      productId: cleanBigId || undefined,
      xboxTitleId: options.xboxTitleId,
      packageFamilyName: options.packageFamilyName,
      title: options.title,
    });

    if (!rawIpcData || typeof rawIpcData !== 'object') {
      return null;
    }

    const typedRaw = rawIpcData as NormalizedXboxIpcPayload;
    const ipcData: NormalizedXboxIpcPayload =
      typedRaw.product && typeof typedRaw.product === 'object'
        ? ({ ...typedRaw, ...typedRaw.product } as NormalizedXboxIpcPayload)
        : Array.isArray(typedRaw.results) && typedRaw.results[0]
          ? ({ ...typedRaw, ...typedRaw.results[0] } as NormalizedXboxIpcPayload)
          : typedRaw;

    const hasUsefulContent = Boolean(
      ipcData.shortDescription ||
        ipcData.detailedDescription ||
        ipcData.aboutTheGame ||
        ipcData.description ||
        ipcData.headerImage ||
        ipcData.heroUrl ||
        ipcData.capsuleImage ||
        ipcData.posterUrl ||
        (Array.isArray(ipcData.screenshots) && ipcData.screenshots.length > 0) ||
        (Array.isArray(ipcData.developers) && ipcData.developers.length > 0)
    );
    if (!hasUsefulContent) {
      return null;
    }

    const mappedScreenshots: SteamScreenshot[] =
      !synopsisOnly && Array.isArray(ipcData.screenshots)
        ? ipcData.screenshots
            .map((s, idx): SteamScreenshot | null => {
              const fullUrl = typeof s === 'string' ? s : s?.pathFull || s?.url || '';
              const thumbUrl = typeof s === 'string' ? s : s?.pathThumbnail || fullUrl;
              if (!fullUrl) return null;
              return {
                id: idx,
                pathThumbnail: ensureHttps(thumbUrl),
                pathFull: ensureHttps(fullUrl),
              };
            })
            .filter((s): s is SteamScreenshot => s !== null)
        : [];

    const mappedMovies: SteamMovie[] =
      !synopsisOnly && Array.isArray(ipcData.movies)
        ? ipcData.movies
            .map((m, idx): SteamMovie | null => {
              if (!m) return null;
              const videoUrl = m.mp4?.max || m.videoUrl || m.url || m.hls || '';
              if (!videoUrl) return null;
              return {
                id: typeof m.id === 'number' ? m.id : idx,
                name: m.name || `Trailer ${idx + 1}`,
                thumbnail: ensureHttps(m.thumbnail || ''),
                webm: { '480': m.webm?.['480'] || videoUrl, max: m.webm?.max || videoUrl },
                mp4: { '480': m.mp4?.['480'] || videoUrl, max: m.mp4?.max || videoUrl },
                hls: m.hls || undefined,
              };
            })
            .filter((m): m is SteamMovie => m !== null)
        : [];

    const rawAbout = String(
      ipcData.aboutTheGame ||
        ipcData.detailedDescription ||
        ipcData.description ||
        ipcData.shortDescription ||
        ''
    )
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
    const cleanShort = stripHtmlToPlainSynopsis(ipcData.shortDescription || rawAbout);
    const formattedAbout = synopsisOnly
      ? cleanShort
      : rawAbout
        ? formatDescriptionToHtml(rawAbout)
        : '';

    const rawCapabilities: string[] = Array.isArray(ipcData.capabilities)
      ? ipcData.capabilities
      : Array.isArray(ipcData.categories)
        ? ipcData.categories
            .map((c) => (typeof c === 'string' ? c : c?.description))
            .filter((d): d is string => Boolean(d))
        : [];

    const categories: SteamCategory[] = rawCapabilities.slice(0, 12).map((cap, idx) => ({
      id: 8000 + idx,
      description: String(cap),
      icon: getSteamCategoryIconUrl(2),
    }));

    const avgRating = Number(ipcData.averageRating ?? ipcData.starRating ?? 0);
    const ratingCount = Number(ipcData.ratingCount ?? ipcData.reviewCount ?? 0);
    const positivePct =
      avgRating > 0 ? Math.min(100, Math.max(1, Math.round(avgRating * 20))) : 0;
    const reviewSummary: SteamReviewSummary | undefined =
      avgRating > 0 && ratingCount > 0
        ? {
            reviewScore: Math.round(positivePct / 10),
            reviewScoreDesc: `Xbox Rating ${(Math.round(avgRating * 10) / 10).toFixed(1)}/5`,
            totalPositive: Math.round(ratingCount * (positivePct / 100)),
            totalNegative: Math.max(0, ratingCount - Math.round(ratingCount * (positivePct / 100))),
            totalReviews: ratingCount,
            positivePercent: positivePct,
          }
        : ipcData.reviewSummary;

    const headerImg = ipcData.headerImage || ipcData.heroUrl;
    const capsuleImg = ipcData.capsuleImage || ipcData.posterUrl;

    return {
      name: ipcData.title || ipcData.name || options.title,
      shortDescription: cleanShort,
      detailedDescription: formattedAbout || cleanShort,
      aboutTheGame: formattedAbout || cleanShort,
      headerImage: headerImg ? ensureHttps(headerImg) : undefined,
      capsuleImage: capsuleImg ? ensureHttps(capsuleImg) : undefined,
      iconUrl: ipcData.iconUrl ? ensureHttps(ipcData.iconUrl) : undefined,
      releaseDate: sanitizeStoreReleaseDate(ipcData.releaseDate),
      developers: Array.isArray(ipcData.developers) ? ipcData.developers : undefined,
      publishers: Array.isArray(ipcData.publishers) ? ipcData.publishers : undefined,
      genres: Array.isArray(ipcData.genres) ? ipcData.genres : undefined,
      tags: Array.isArray(ipcData.tags)
        ? ipcData.tags
        : rawCapabilities.length > 0
          ? rawCapabilities
          : undefined,
      categories,
      screenshots: mappedScreenshots,
      movies: mappedMovies,
      systemRequirements: ipcData.systemRequirements || ipcData.pcRequirements || undefined,
      website: ipcData.storeUrl || ipcData.website || undefined,
      reviewSummary,
      xboxDeliveryHints: ipcData.xboxDeliveryHints,
      // P0-11: synopsisOnly MUST NOT lock out full detail hydration
      metadataQuality: synopsisOnly ? 'local_federated' : 'storefront_native',
      enrichedSource: 'xbox',
      ...(synopsisOnly ? {} : { fetchedAt: Date.now() }),
    };
  } catch (err: unknown) {
    console.warn(
      `[Fallback Provider] Xbox product metadata lookup failed for ${cleanBigId || options.title}:`,
      getErrorMessage(err)
    );
    return null;
  }
}
