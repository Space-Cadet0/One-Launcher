/**
 * Epic Games Store metadata client (Electron Catalog Offers IPC + store-content products API).
 */

import axios from 'axios';
import { SteamEnrichedMetadata, SteamMovie, SteamScreenshot } from '../../../contracts/steam';
import { stripHtmlToPlainSynopsis } from '../../common/synopsisTextUtils';
import { getDevProxyBaseForRoute } from '../../network/browserDevProxy';
import { Priority, RequestPriority, requestScheduler } from '../../network/requestScheduler';
import {
  ensureHttps,
  extractEpicRequirementsByOs,
  formatDescriptionToHtml,
  getErrorMessage,
  parseEpicLanguages,
  type EpicRequirementSystem,
  type RawMediaMovieItem,
  type RawMediaScreenshotItem,
} from './storefrontTextFormatting';

interface EpicVideoRecipeOutput {
  key?: string;
  url?: string;
}

interface EpicVideoRecipe {
  recipe?: string;
  outputs?: EpicVideoRecipeOutput[];
}

interface EpicCarouselItem {
  image?: string | { src?: string; url?: string };
  src?: string;
  url?: string;
  video?: {
    recipes?: string | Record<string, EpicVideoRecipe[]>;
  };
}

interface EpicGalleryImage {
  src?: string;
  url?: string;
}

interface EpicProductHomePage {
  type?: string;
  data?: {
    carousel?: { items?: EpicCarouselItem[] };
    gallery?: { galleryImages?: Array<string | EpicGalleryImage> };
    requirements?: {
      systems?: EpicRequirementSystem[];
      languages?: string[] | string;
    };
    about?: {
      description?: string;
      about?: string;
      shortDescription?: string;
      image?: { src?: string };
      developerAttribution?: string;
      publisherAttribution?: string;
    };
    markdown?: { markdown?: string };
    hero?: {
      backgroundImageUrl?: string;
      portrait?: string;
      portraitBackgroundImageUrl?: string;
      logoImage?: { src?: string };
    };
    banner?: { image?: string };
    meta?: { releaseDate?: string };
  };
}

interface NormalizedEpicIpcPayload {
  title?: string;
  shortDescription?: string;
  detailedDescription?: string;
  aboutTheGame?: string;
  headerImage?: string;
  capsuleImage?: string;
  releaseDate?: string;
  developers?: string[];
  publishers?: string[];
  screenshots?: Array<string | RawMediaScreenshotItem>;
  movies?: RawMediaMovieItem[];
  supportedLanguages?: string | string[];
  languages?: string | string[];
  systemRequirements?: { minimum?: string; recommended?: string };
  macRequirements?: { minimum?: string; recommended?: string };
  linuxRequirements?: { minimum?: string; recommended?: string };
  platforms?: { windows?: boolean; mac?: boolean; linux?: boolean };
  namespace?: string;
}

export interface EpicMetadataFetchOptions {
  appName?: string;
  namespace?: string;
  catalogItemId?: string;
  title?: string;
  priority?: number;
  synopsisOnly?: boolean;
  /** Internal orchestration hint to skip duplicate IPC calls across candidate slugs */
  skipIpc?: boolean;
}

/**
 * Fetches rich metadata directly from Epic Games Store Catalog Offers API (via IPC) and Content API.
 */
export async function fetchEpicProductMetadata(
  slugOrTitle: string,
  options?: EpicMetadataFetchOptions
): Promise<Partial<SteamEnrichedMetadata> | null> {
  const synopsisOnly = Boolean(options?.synopsisOnly);
  const effectivePriority =
    options?.priority !== undefined
      ? options.priority
      : synopsisOnly
        ? RequestPriority.P2_BACKGROUND
        : Priority.HIGH;
  let ipcMetadata: Partial<SteamEnrichedMetadata> | null = null;

  // Step 1: Official Epic Catalog Offers API via Electron IPC Bridge
  if (
    !options?.skipIpc &&
    typeof window !== 'undefined' &&
    window.electronAPI?.fetchEpicProductMetadata
  ) {
    try {
      const rawEpicIpc = await window.electronAPI.fetchEpicProductMetadata({
        slug: slugOrTitle,
        appName: options?.appName || slugOrTitle,
        namespace: options?.namespace,
        catalogItemId: options?.catalogItemId,
        title: options?.title || slugOrTitle,
      });
      const ipcData = rawEpicIpc as NormalizedEpicIpcPayload | null;

      if (
        ipcData &&
        (ipcData.shortDescription ||
          ipcData.detailedDescription ||
          ipcData.aboutTheGame ||
          (Array.isArray(ipcData.screenshots) && ipcData.screenshots.length > 0) ||
          (Array.isArray(ipcData.movies) && ipcData.movies.length > 0))
      ) {
        const mappedScreenshots: SteamScreenshot[] = Array.isArray(ipcData.screenshots)
          ? ipcData.screenshots
              .map((s, idx): SteamScreenshot | null => {
                const url = typeof s === 'string' ? s : s?.pathFull || s?.url || '';
                if (!url) return null;
                return {
                  id: idx,
                  pathThumbnail: ensureHttps(url),
                  pathFull: ensureHttps(url),
                };
              })
              .filter((s): s is SteamScreenshot => s !== null)
          : [];

        const mappedMovies: SteamMovie[] = Array.isArray(ipcData.movies)
          ? ipcData.movies
              .map((m, idx): SteamMovie | null => {
                if (!m) return null;
                const hlsUrl = m.hls || '';
                const mp4Max = m.mp4?.max || m.videoUrl || hlsUrl || '';
                const mp4Low = m.mp4?.['480'] || mp4Max;
                const webmMax = m.webm?.max || mp4Max;
                const webmLow = m.webm?.['480'] || mp4Low;
                if (!hlsUrl && !mp4Max) return null;
                return {
                  id: typeof m.id === 'number' ? m.id : idx,
                  name: m.name || `Trailer ${idx + 1}`,
                  thumbnail: ensureHttps(m.thumbnail || ''),
                  webm: { '480': webmLow, max: webmMax },
                  mp4: { '480': mp4Low, max: mp4Max },
                  hls: hlsUrl || undefined,
                };
              })
              .filter((m): m is SteamMovie => m !== null)
          : [];

        const rawAbout = (
          ipcData.aboutTheGame ||
          ipcData.detailedDescription ||
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

        const parsedIpcLangs = synopsisOnly
          ? {}
          : parseEpicLanguages(ipcData.supportedLanguages || ipcData.languages);

        const hasIpcWin = Boolean(
          ipcData.platforms?.windows ||
            ipcData.systemRequirements?.minimum?.trim() ||
            ipcData.systemRequirements?.recommended?.trim()
        );
        const hasIpcMac = Boolean(
          ipcData.platforms?.mac ||
            ipcData.macRequirements?.minimum?.trim() ||
            ipcData.macRequirements?.recommended?.trim()
        );
        const hasIpcLinux = Boolean(
          ipcData.platforms?.linux ||
            ipcData.linuxRequirements?.minimum?.trim() ||
            ipcData.linuxRequirements?.recommended?.trim()
        );
        const ipcPlatforms: SteamEnrichedMetadata['platforms'] | undefined =
          ipcData.platforms || hasIpcWin || hasIpcMac || hasIpcLinux
            ? {
                windows: hasIpcWin,
                mac: hasIpcMac,
                linux: hasIpcLinux,
              }
            : undefined;

        ipcMetadata = {
          name: ipcData.title || options?.title || slugOrTitle,
          shortDescription: cleanShort,
          detailedDescription: formattedAbout || cleanShort,
          aboutTheGame: formattedAbout || cleanShort,
          headerImage: ipcData.headerImage ? ensureHttps(ipcData.headerImage) : undefined,
          capsuleImage: ipcData.capsuleImage ? ensureHttps(ipcData.capsuleImage) : undefined,
          releaseDate: ipcData.releaseDate,
          developers: ipcData.developers,
          publishers: ipcData.publishers,
          screenshots: synopsisOnly ? [] : mappedScreenshots,
          movies: synopsisOnly ? [] : mappedMovies,
          ...(parsedIpcLangs.supportedLanguages
            ? { supportedLanguages: parsedIpcLangs.supportedLanguages }
            : {}),
          ...(parsedIpcLangs.languageOptions
            ? { languageOptions: parsedIpcLangs.languageOptions }
            : {}),
          languageTableSchema: 'audio_text',
          ...(ipcData.systemRequirements ? { systemRequirements: ipcData.systemRequirements } : {}),
          ...(ipcData.macRequirements ? { macRequirements: ipcData.macRequirements } : {}),
          ...(ipcData.linuxRequirements ? { linuxRequirements: ipcData.linuxRequirements } : {}),
          ...(ipcPlatforms ? { platforms: ipcPlatforms } : {}),
          metadataQuality: synopsisOnly ? 'local_federated' : 'scraped',
          enrichedSource: 'epic',
          ...(synopsisOnly ? {} : { fetchedAt: Date.now() }),
        };

        if (
          (synopsisOnly && cleanShort && cleanShort.length >= 25) ||
          (mappedMovies.length > 0 &&
            cleanShort &&
            mappedScreenshots.length > 0 &&
            Boolean(ipcMetadata.supportedLanguages))
        ) {
          return ipcMetadata;
        }
      }
    } catch (ipcErr: unknown) {
      console.warn(
        `[Fallback Provider] Epic IPC product lookup failed for ${slugOrTitle}:`,
        getErrorMessage(ipcErr)
      );
    }
  }

  // Step 2: Epic Content Products API by slug (enriches video trailers, carousel media, and system requirements)
  try {
    const primarySlug = slugOrTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const titleCandidateSlug = (options?.title || ipcMetadata?.name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const slugsToTry = Array.from(
      new Set([primarySlug, titleCandidateSlug].filter((s) => s && s.length > 1))
    );

    const epicContentBaseUrl = getDevProxyBaseForRoute('epicContent');
    const epicGameKey = `epic:${options?.appName || primarySlug || slugOrTitle}`;
    let home: EpicProductHomePage | null = null;
    for (const candidateSlug of slugsToTry) {
      try {
        const url = `${epicContentBaseUrl}/api/en-US/content/products/${candidateSlug}`;
        const canonicalEpicUrl = `https://store-content.ak.epicgames.com/api/en-US/content/products/${candidateSlug}`;

        const res = await requestScheduler.schedule(
          canonicalEpicUrl,
          () => axios.get<{ pages?: EpicProductHomePage[] }>(url, { timeout: 8000 }),
          effectivePriority,
          'store-content.ak.epicgames.com',
          epicGameKey
        );
        const data = res.data;
        const foundHome =
          data?.pages?.find((p) => p.type === 'productHome') || data?.pages?.[0] || null;
        if (foundHome?.data) {
          home = foundHome;
          break;
        }
      } catch {
        // Try next candidate slug
      }
    }

    if (!home?.data) return ipcMetadata;

    const d = home.data;
    const screenshots: SteamScreenshot[] = [];
    const movies: SteamMovie[] = [];

    const carouselItems = d?.carousel?.items || [];
    if (!synopsisOnly) {
      carouselItems.forEach((item: EpicCarouselItem, idx: number) => {
        const imgObj = typeof item.image === 'object' && item.image !== null ? item.image : null;
        const rawImg =
          imgObj?.src ||
          imgObj?.url ||
          (typeof item.image === 'string' ? item.image : null) ||
          item.src ||
          item.url;
        if (
          rawImg &&
          typeof rawImg === 'string' &&
          !screenshots.some((s) => s.pathFull === rawImg)
        ) {
          screenshots.push({
            id: idx,
            pathThumbnail: rawImg,
            pathFull: rawImg,
          });
        }

        if (item.video?.recipes) {
          try {
            const recipes: Record<string, EpicVideoRecipe[]> =
              typeof item.video.recipes === 'string'
                ? (JSON.parse(item.video.recipes) as Record<string, EpicVideoRecipe[]>)
                : item.video.recipes;
            const langObj = recipes['en-US'] || recipes['en'] || Object.values(recipes)[0];
            if (Array.isArray(langObj)) {
              const hlsOutput = langObj
                .find((r) => r.recipe === 'video-hls')
                ?.outputs?.find((o) => o.key === 'manifest');
              const mp4Output = langObj
                .find((r) => r.recipe === 'video-fmp4' || r.recipe === 'video-webm')
                ?.outputs?.find((o) => o.key === 'manifest');
              const thumbOutput = langObj
                .find((r) => r.outputs?.some((o) => o.key === 'thumbnail'))
                ?.outputs?.find((o) => o.key === 'thumbnail');

              const videoUrl = hlsOutput?.url || mp4Output?.url;
              const thumbUrl = thumbOutput?.url;

              if (videoUrl) {
                movies.push({
                  id: idx,
                  name: `Trailer ${movies.length + 1}`,
                  thumbnail: thumbUrl || '',
                  webm: { '480': videoUrl, max: videoUrl },
                  mp4: { '480': videoUrl, max: videoUrl },
                  hls: hlsOutput?.url,
                });
              }

              if (thumbUrl && !screenshots.some((s) => s.pathFull === thumbUrl)) {
                screenshots.push({
                  id: 1000 + idx,
                  pathThumbnail: thumbUrl,
                  pathFull: thumbUrl,
                });
              }
            }
          } catch {
            // Ignore malformed recipe payloads
          }
        }
      });

      const galleryImages = d.gallery?.galleryImages || [];
      galleryImages.forEach((g, idx: number) => {
        const gUrl = typeof g === 'string' ? g : g.src || g.url || null;
        if (gUrl && typeof gUrl === 'string' && !screenshots.some((s) => s.pathFull === gUrl)) {
          screenshots.push({
            id: 2000 + idx,
            pathThumbnail: gUrl,
            pathFull: gUrl,
          });
        }
      });
    }

    const parsedEpicReqs = synopsisOnly ? {} : extractEpicRequirementsByOs(d.requirements?.systems);
    const parsedContentLangs = synopsisOnly ? {} : parseEpicLanguages(d.requirements?.languages);

    const descFull = d.about?.description || d.about?.about || d.markdown?.markdown || '';
    const descShort = stripHtmlToPlainSynopsis(d.about?.shortDescription || descFull);
    const formattedAbout = synopsisOnly ? descShort : formatDescriptionToHtml(descFull);
    const headerImage =
      d.hero?.backgroundImageUrl ||
      d.hero?.portrait ||
      d.banner?.image ||
      d.about?.image?.src ||
      '';
    const capsuleImage = d.hero?.portraitBackgroundImageUrl || d.hero?.portrait || '';
    const iconUrl = d.hero?.logoImage?.src || '';

    const epicSysTypes = Array.isArray(d.requirements?.systems)
      ? d.requirements.systems
          .map((sys) => String(sys?.systemType || '').trim())
          .filter(Boolean)
      : [];
    const hasContentWin = Boolean(
      parsedEpicReqs.systemRequirements?.minimum?.trim() ||
        parsedEpicReqs.systemRequirements?.recommended?.trim() ||
        epicSysTypes.some((t) => /win/i.test(t))
    );
    const hasContentMac = Boolean(
      parsedEpicReqs.macRequirements?.minimum?.trim() ||
        parsedEpicReqs.macRequirements?.recommended?.trim() ||
        epicSysTypes.some((t) => /mac|osx|darwin/i.test(t))
    );
    const hasContentLinux = Boolean(
      parsedEpicReqs.linuxRequirements?.minimum?.trim() ||
        parsedEpicReqs.linuxRequirements?.recommended?.trim() ||
        epicSysTypes.some((t) => /linux|ubuntu|steam\s*os/i.test(t))
    );
    const contentPlatforms: SteamEnrichedMetadata['platforms'] | undefined =
      hasContentWin || hasContentMac || hasContentLinux
        ? {
            windows: hasContentWin,
            mac: hasContentMac,
            linux: hasContentLinux,
          }
        : undefined;

    const contentMetadata: Partial<SteamEnrichedMetadata> = {
      aboutTheGame: formattedAbout,
      detailedDescription: formattedAbout,
      shortDescription: descShort,
      headerImage,
      capsuleImage,
      iconUrl,
      screenshots,
      movies,
      supportedLanguages: parsedContentLangs.supportedLanguages,
      languageOptions: parsedContentLangs.languageOptions,
      languageTableSchema: 'audio_text',
      systemRequirements: parsedEpicReqs.systemRequirements || {
        minimum: '',
        recommended: '',
      },
      ...(parsedEpicReqs.macRequirements
        ? { macRequirements: parsedEpicReqs.macRequirements }
        : {}),
      ...(parsedEpicReqs.linuxRequirements
        ? { linuxRequirements: parsedEpicReqs.linuxRequirements }
        : {}),
      ...(contentPlatforms ? { platforms: contentPlatforms } : {}),
      metadataQuality: synopsisOnly ? 'local_federated' : 'scraped',
      enrichedSource: 'epic',
      ...(synopsisOnly ? {} : { fetchedAt: Date.now() }),
      releaseDate: d.meta?.releaseDate ? d.meta.releaseDate.substring(0, 10) : '',
      developers: d.about?.developerAttribution ? [d.about.developerAttribution] : undefined,
      publishers: d.about?.publisherAttribution ? [d.about.publisherAttribution] : undefined,
      achievements: undefined,
    };

    if (ipcMetadata) {
      const mergedScreenshots = [
        ...(ipcMetadata.screenshots || []),
        ...screenshots.filter(
          (s) =>
            !(ipcMetadata?.screenshots || []).some((existing) => existing.pathFull === s.pathFull)
        ),
      ];
      const mergedPlatforms: SteamEnrichedMetadata['platforms'] | undefined =
        ipcMetadata.platforms || contentMetadata.platforms
          ? {
              windows: Boolean(
                ipcMetadata.platforms?.windows || contentMetadata.platforms?.windows
              ),
              mac: Boolean(ipcMetadata.platforms?.mac || contentMetadata.platforms?.mac),
              linux: Boolean(ipcMetadata.platforms?.linux || contentMetadata.platforms?.linux),
            }
          : undefined;
      return {
        ...contentMetadata,
        ...ipcMetadata,
        shortDescription: ipcMetadata.shortDescription || contentMetadata.shortDescription,
        detailedDescription:
          ipcMetadata.detailedDescription || contentMetadata.detailedDescription,
        aboutTheGame: ipcMetadata.aboutTheGame || contentMetadata.aboutTheGame,
        headerImage: ipcMetadata.headerImage || contentMetadata.headerImage,
        capsuleImage: ipcMetadata.capsuleImage || contentMetadata.capsuleImage,
        iconUrl: ipcMetadata.iconUrl || contentMetadata.iconUrl,
        screenshots: mergedScreenshots,
        movies:
          ipcMetadata.movies && ipcMetadata.movies.length > 0
            ? ipcMetadata.movies
            : contentMetadata.movies,
        supportedLanguages: ipcMetadata.supportedLanguages || contentMetadata.supportedLanguages,
        languageOptions:
          ipcMetadata.languageOptions && ipcMetadata.languageOptions.length > 0
            ? ipcMetadata.languageOptions
            : contentMetadata.languageOptions,
        languageTableSchema:
          ipcMetadata.languageTableSchema || contentMetadata.languageTableSchema || 'audio_text',
        systemRequirements:
          ipcMetadata.systemRequirements?.minimum || ipcMetadata.systemRequirements?.recommended
            ? ipcMetadata.systemRequirements
            : contentMetadata.systemRequirements,
        macRequirements:
          ipcMetadata.macRequirements?.minimum || ipcMetadata.macRequirements?.recommended
            ? ipcMetadata.macRequirements
            : contentMetadata.macRequirements,
        linuxRequirements:
          ipcMetadata.linuxRequirements?.minimum || ipcMetadata.linuxRequirements?.recommended
            ? ipcMetadata.linuxRequirements
            : contentMetadata.linuxRequirements,
        ...(mergedPlatforms ? { platforms: mergedPlatforms } : {}),
        metadataQuality: synopsisOnly ? 'local_federated' : 'scraped',
        enrichedSource: 'epic',
        ...(synopsisOnly ? {} : { fetchedAt: Date.now() }),
        releaseDate: ipcMetadata.releaseDate || contentMetadata.releaseDate,
        developers:
          ipcMetadata.developers && ipcMetadata.developers.length > 0
            ? ipcMetadata.developers
            : contentMetadata.developers,
        publishers:
          ipcMetadata.publishers && ipcMetadata.publishers.length > 0
            ? ipcMetadata.publishers
            : contentMetadata.publishers,
      };
    }

    return contentMetadata;
  } catch (err: unknown) {
    console.warn(
      `[Fallback Provider] Epic product content lookup failed for ${slugOrTitle}:`,
      getErrorMessage(err)
    );
    return ipcMetadata;
  }
}
