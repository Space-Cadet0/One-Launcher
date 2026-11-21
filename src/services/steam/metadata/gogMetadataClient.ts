/**
 * GOG product & catalog metadata client (v1 products, v2 games, v1 catalog, HTML fallback).
 */

import axios from 'axios';
import {
  SteamEnrichedMetadata,
  SteamMovie,
  SteamScreenshot,
  SteamSystemRequirements,
} from '../../../contracts/steam';
import { extractFirstParagraph, stripHtmlToPlainSynopsis } from '../../common/synopsisTextUtils';
import { isSequelMismatch, normalizeTitleKey, stripEditionSuffix } from '../../common/titleUtils';
import { getDevProxyBaseForRoute } from '../../network/browserDevProxy';
import { Priority, RequestPriority, requestScheduler } from '../../network/requestScheduler';
import {
  cleanGogDescriptionHtml,
  ensureHttps,
  extractGogRequirementsByOs,
  getErrorMessage,
  isGenericPlaceholderSynopsis,
  parseGogLocalizations,
  type GogLocalizationItem,
  type GogSupportedOperatingSystem,
} from './storefrontTextFormatting';

interface GogFormattedImage {
  formatter_name?: string;
  image_url?: string;
}

interface GogRawScreenshotObj {
  formatted_images?: GogFormattedImage[];
  formatter_template_url?: string;
}

type GogRawScreenshot = string | GogRawScreenshotObj;

interface GogRawVideo {
  thumbnail_url?: string;
  video_url?: string;
}

interface GogCatalogProduct {
  id?: string | number;
  slug?: string;
  title?: string;
  releaseDate?: string;
  developers?: string[];
  publishers?: string[];
  coverVertical?: string;
  coverHorizontal?: string;
  screenshots?: GogRawScreenshot[];
}

interface GogV1ProductResponse {
  title?: string;
  slug?: string;
  languages?: Record<string, string>;
  screenshots?: GogRawScreenshot[];
  videos?: GogRawVideo[];
  images?: { background?: string; logo2x?: string; icon?: string };
  description?: { full?: string; lead?: string };
  release_date?: string;
  links?: { purchase_link?: string };
}

interface GogV2GameResponse {
  description?: string;
  _links?: {
    boxArtImage?: { href?: string };
    galaxyBackgroundImage?: { href?: string };
    backgroundImage?: { href?: string };
  };
  _embedded?: {
    developers?: Array<{ name?: string }>;
    publishers?: Array<{ name?: string }>;
    tags?: Array<{ name?: string }>;
    localizations?: GogLocalizationItem[];
    product?: { globalReleaseDate?: string; title?: string };
    supportedOperatingSystems?: GogSupportedOperatingSystem[];
  };
}

export interface GogMetadataFetchOptions {
  priority?: number;
  synopsisOnly?: boolean;
}

export function sanitizeGogCatalogLikeQuery(raw: string): string {
  return String(raw || '')
    .replace(/^like:/i, '')
    .replace(/[™®©]/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapGogScreenshots(rawShots: GogRawScreenshot[]): SteamScreenshot[] {
  return rawShots
    .map((s: GogRawScreenshot, idx: number) => {
      if (typeof s === 'string') {
        const url = ensureHttps(s.replace('{formatter}', 'ggvgl_2x'));
        const thumb = ensureHttps(s.replace('{formatter}', 'ggvgm'));
        return { id: idx, pathThumbnail: thumb, pathFull: url };
      }
      const fullImg =
        s.formatted_images?.find((img) => img.formatter_name === 'ggvgl_2x')?.image_url ||
        s.formatted_images?.find((img) => img.formatter_name === 'ggvgl')?.image_url ||
        (s.formatter_template_url
          ? s.formatter_template_url.replace('{formatter}', 'ggvgl_2x')
          : '');
      const thumbImg =
        s.formatted_images?.find((img) => img.formatter_name === 'ggvgm')?.image_url || fullImg;

      return {
        id: idx,
        pathThumbnail: ensureHttps(thumbImg),
        pathFull: ensureHttps(fullImg),
      };
    })
    .filter((s) => Boolean(s.pathFull));
}

/**
 * Fetches rich metadata directly from GOG's official product API and catalog endpoints.
 */
export async function fetchGogProductMetadata(
  gogId: string,
  gameTitle?: string,
  fetchOptions?: GogMetadataFetchOptions
): Promise<Partial<SteamEnrichedMetadata> | null> {
  const synopsisOnly = Boolean(fetchOptions?.synopsisOnly);
  const effectivePriority =
    fetchOptions?.priority !== undefined
      ? fetchOptions.priority
      : synopsisOnly
        ? RequestPriority.P2_BACKGROUND
        : Priority.HIGH;

  let screenshots: SteamScreenshot[] = [];
  let movies: SteamMovie[] = [];
  let headerImage = '';
  let capsuleImage = '';
  let descriptionFull = '';
  let descriptionLead = '';

  let releaseDate = 'TBA';
  let v2Devs: string[] | undefined = undefined;
  let v2Pubs: string[] | undefined = undefined;
  let v2Genres: string[] | undefined = undefined;
  let v2Tags: string[] | undefined = undefined;
  let v2Localizations: GogLocalizationItem[] | undefined = undefined;
  let v1Languages: Record<string, string> | undefined = undefined;
  let v2SupportedOperatingSystems: GogSupportedOperatingSystem[] | undefined = undefined;
  let v2Requirements: {
    systemRequirements?: SteamSystemRequirements;
    macRequirements?: SteamSystemRequirements;
    linuxRequirements?: SteamSystemRequirements;
  } = {};

  const cleanGogId = String(gogId).replace(/^gog-/, '').trim();
  const gogGameKey = `gog:${cleanGogId}`;
  const gogBaseUrl = getDevProxyBaseForRoute('gogProduct');
  const gogCatalogBaseUrl = getDevProxyBaseForRoute('gogCatalog');
  const gogProfileBaseUrl = getDevProxyBaseForRoute('gogProfile');

  try {
    const urlV1 = `${gogBaseUrl}/products/${encodeURIComponent(cleanGogId)}?expand=description,screenshots,videos`;
    const urlV2 = `${gogBaseUrl}/v2/games/${encodeURIComponent(cleanGogId)}`;
    const [resV1Settled, resV2Settled] = await Promise.allSettled([
      requestScheduler.schedule(
        `https://api.gog.com/products/${encodeURIComponent(cleanGogId)}`,
        () => axios.get<GogV1ProductResponse>(urlV1, { timeout: 8000 }),
        effectivePriority,
        'api.gog.com',
        gogGameKey
      ),
      requestScheduler.schedule(
        `https://api.gog.com/v2/games/${encodeURIComponent(cleanGogId)}`,
        () => axios.get<GogV2GameResponse>(urlV2, { timeout: 6000 }),
        effectivePriority,
        'api.gog.com',
        gogGameKey
      ),
    ]);

    const data = resV1Settled.status === 'fulfilled' ? resV1Settled.value?.data : null;
    const v2Data = resV2Settled.status === 'fulfilled' ? resV2Settled.value?.data : null;

    if (v2Data) {
      const boxArt = ensureHttps(v2Data._links?.boxArtImage?.href || '');
      if (boxArt) {
        capsuleImage = boxArt;
      }
      const v2Bg = ensureHttps(
        v2Data._links?.galaxyBackgroundImage?.href || v2Data._links?.backgroundImage?.href || ''
      );
      if (v2Bg && !headerImage) {
        headerImage = v2Bg;
      }
      if (Array.isArray(v2Data._embedded?.developers)) {
        const devs = v2Data._embedded.developers
          .map((d) => d?.name)
          .filter((n): n is string => Boolean(n));
        if (devs.length > 0) v2Devs = devs;
      }
      if (Array.isArray(v2Data._embedded?.publishers)) {
        const pubs = v2Data._embedded.publishers
          .map((p) => p?.name)
          .filter((n): n is string => Boolean(n));
        if (pubs.length > 0) v2Pubs = pubs;
      }
      if (Array.isArray(v2Data._embedded?.tags)) {
        const tags = v2Data._embedded.tags
          .map((t) => t?.name)
          .filter((n): n is string => Boolean(n));
        if (tags.length > 0) {
          if (!v2Genres) v2Genres = tags;
          if (!v2Tags) v2Tags = tags;
        }
      }
      if (
        Array.isArray(v2Data._embedded?.localizations) &&
        v2Data._embedded.localizations.length > 0
      ) {
        v2Localizations = v2Data._embedded.localizations;
      }
      if (
        Array.isArray(v2Data._embedded?.supportedOperatingSystems) &&
        v2Data._embedded.supportedOperatingSystems.length > 0
      ) {
        v2SupportedOperatingSystems = v2Data._embedded.supportedOperatingSystems;
        if (!synopsisOnly) {
          v2Requirements = extractGogRequirementsByOs(v2SupportedOperatingSystems);
        }
      }
      const globalRel = v2Data._embedded?.product?.globalReleaseDate;
      if (globalRel && typeof globalRel === 'string' && releaseDate === 'TBA') {
        releaseDate = globalRel.substring(0, 10);
      }
      if (v2Data.description && typeof v2Data.description === 'string' && !descriptionFull) {
        const cleanedV2 = cleanGogDescriptionHtml(v2Data.description, synopsisOnly);
        if (cleanedV2.length >= 30 && !isGenericPlaceholderSynopsis(cleanedV2, gameTitle)) {
          descriptionFull = cleanedV2;
          descriptionLead = extractFirstParagraph(cleanedV2) || descriptionLead;
        }
      }
    }

    if (data) {
      if (data.languages && typeof data.languages === 'object') {
        v1Languages = data.languages;
      }
      if (!synopsisOnly && data.screenshots && Array.isArray(data.screenshots)) {
        screenshots = mapGogScreenshots(data.screenshots);
      }

      if (!synopsisOnly && data.videos && Array.isArray(data.videos)) {
        movies = data.videos.map((v: GogRawVideo, idx: number) => ({
          id: idx,
          name: `Trailer ${idx + 1}`,
          thumbnail: ensureHttps(v.thumbnail_url || ''),
          webm: { 480: '', max: '' },
          mp4: { 480: ensureHttps(v.video_url || ''), max: ensureHttps(v.video_url || '') },
        }));
      }

      const apiHeader = ensureHttps(
        data.images?.background || data.images?.logo2x || data.images?.icon || ''
      );
      if (apiHeader) headerImage = apiHeader;

      const cleanedDescFull = cleanGogDescriptionHtml(
        data.description?.full || data.description?.lead || '',
        synopsisOnly
      );
      const cleanedDescLead = cleanGogDescriptionHtml(data.description?.lead || '', synopsisOnly);

      const isPlaceholderDesc =
        !cleanedDescFull ||
        cleanedDescFull.length < 30 ||
        isGenericPlaceholderSynopsis(cleanedDescFull, gameTitle);

      if (!isPlaceholderDesc && cleanedDescFull) {
        descriptionFull = cleanedDescFull;
        descriptionLead =
          extractFirstParagraph(cleanedDescLead || cleanedDescFull) || descriptionLead || '';
      }

      if (data.release_date && releaseDate === 'TBA') {
        releaseDate = data.release_date.substring(0, 10);
      }
    }

    // Universal GOG Catalog Product Fallback (for bundled/bonus editions whose own product ID holds a placeholder)
    if (!descriptionFull || isGenericPlaceholderSynopsis(descriptionFull, gameTitle)) {
      const lookupTitle = (
        gameTitle ||
        data?.title ||
        v2Data?._embedded?.product?.title ||
        ''
      ).trim();
      const purchaseSlug =
        typeof data?.links?.purchase_link === 'string'
          ? data.links.purchase_link.split('/').filter(Boolean).pop()
          : undefined;

      let catProd: GogCatalogProduct | null = null;
      const sanitizedCatalogQuery = sanitizeGogCatalogLikeQuery(lookupTitle || purchaseSlug || '');
      if (sanitizedCatalogQuery) {
        try {
          const likeParam = encodeURIComponent(`like:${sanitizedCatalogQuery}`);
          const catUrl = `${gogCatalogBaseUrl}/v1/catalog?query=${likeParam}&limit=5&productType=in:game,pack`;
          const catRes = await requestScheduler.schedule(
            `https://catalog.gog.com/v1/catalog?query=${likeParam}&limit=5&productType=in:game,pack`,
            () =>
              axios.get<{ productCount?: number; products?: GogCatalogProduct[] }>(catUrl, {
                timeout: 6000,
              }),
            effectivePriority,
            'catalog.gog.com',
            gogGameKey
          );
          const hasZeroMatches =
            typeof catRes.data?.productCount === 'number' && catRes.data.productCount <= 0;
          const rawProducts =
            !hasZeroMatches && Array.isArray(catRes.data?.products) ? catRes.data.products : [];
          const isQaSandboxProduct = (p?: GogCatalogProduct | null): boolean => {
            if (!p) return true;
            const orgs = [...(p.developers || []), ...(p.publishers || [])];
            return orgs.some((name) =>
              /^test\s+(?:developer|publisher)$/i.test(String(name || '').trim())
            );
          };
          const products = rawProducts.filter((p) => !isQaSandboxProduct(p));
          const normLookup = normalizeTitleKey(lookupTitle);
          const normBaseLookup = normalizeTitleKey(stripEditionSuffix(lookupTitle));
          const isCorroboratedCatalogCandidate = (p?: GogCatalogProduct | null): boolean => {
            if (!p?.title || !normLookup) return false;
            const candNorm = normalizeTitleKey(p.title);
            if (!candNorm) return false;
            if (candNorm === normLookup) return true;
            const candBase = normalizeTitleKey(stripEditionSuffix(p.title));
            if (
              normBaseLookup &&
              candBase === normBaseLookup &&
              !isSequelMismatch(lookupTitle, p.title)
            ) {
              return true;
            }
            return false;
          };
          catProd =
            (purchaseSlug ? products.find((p) => p?.slug === purchaseSlug) || null : null) ||
            products.find((p) => isCorroboratedCatalogCandidate(p)) ||
            null;
        } catch (catErr: unknown) {
          console.warn(
            `[Fallback Provider] GOG catalog search fallback failed for ${lookupTitle}:`,
            getErrorMessage(catErr)
          );
        }
      }

      if (catProd) {
        if (catProd.releaseDate && releaseDate === 'TBA') {
          releaseDate = String(catProd.releaseDate).replace(/\./g, '-').substring(0, 10);
        }
        if (
          !v2Devs?.length &&
          Array.isArray(catProd.developers) &&
          catProd.developers.length > 0
        ) {
          v2Devs = catProd.developers;
        }
        if (
          !v2Pubs?.length &&
          Array.isArray(catProd.publishers) &&
          catProd.publishers.length > 0
        ) {
          v2Pubs = catProd.publishers;
        }
        if (!capsuleImage && catProd.coverVertical) {
          capsuleImage = ensureHttps(catProd.coverVertical);
        }
        if (!headerImage && catProd.coverHorizontal) {
          headerImage = ensureHttps(catProd.coverHorizontal);
        }
        if (!synopsisOnly && screenshots.length === 0 && Array.isArray(catProd.screenshots)) {
          screenshots = mapGogScreenshots(catProd.screenshots);
        }

        if (catProd.id && String(catProd.id) !== cleanGogId) {
          try {
            const catIdEncoded = encodeURIComponent(String(catProd.id));
            const catProdUrl = `${gogBaseUrl}/products/${catIdEncoded}?expand=description,screenshots,videos`;
            const catV2Url = `${gogBaseUrl}/v2/games/${catIdEncoded}`;
            const [catProdSettled, catV2Settled] = await Promise.allSettled([
              requestScheduler.schedule(
                `https://api.gog.com/products/${catIdEncoded}`,
                () => axios.get<GogV1ProductResponse>(catProdUrl, { timeout: 6000 }),
                effectivePriority,
                'api.gog.com',
                gogGameKey
              ),
              !v2Localizations?.length && !synopsisOnly
                ? requestScheduler.schedule(
                    `https://api.gog.com/v2/games/${catIdEncoded}`,
                    () => axios.get<GogV2GameResponse>(catV2Url, { timeout: 6000 }),
                    effectivePriority,
                    'api.gog.com',
                    gogGameKey
                  )
                : Promise.resolve(null),
            ]);
            const catData =
              catProdSettled.status === 'fulfilled' ? catProdSettled.value?.data : null;
            const catV2Data =
              catV2Settled.status === 'fulfilled' ? catV2Settled.value?.data : null;
            if (
              !v2Localizations?.length &&
              Array.isArray(catV2Data?._embedded?.localizations) &&
              catV2Data._embedded.localizations.length > 0
            ) {
              v2Localizations = catV2Data._embedded.localizations;
            }
            if (
              !v2SupportedOperatingSystems?.length &&
              Array.isArray(catV2Data?._embedded?.supportedOperatingSystems) &&
              catV2Data._embedded.supportedOperatingSystems.length > 0
            ) {
              v2SupportedOperatingSystems = catV2Data._embedded.supportedOperatingSystems;
              if (!synopsisOnly) {
                v2Requirements = extractGogRequirementsByOs(v2SupportedOperatingSystems);
              }
            }
            if (catData) {
              if (!v1Languages && catData.languages && typeof catData.languages === 'object') {
                v1Languages = catData.languages;
              }
              const cleanedCatFull = cleanGogDescriptionHtml(
                catData.description?.full || catData.description?.lead || '',
                synopsisOnly
              );
              const cleanedCatLead = cleanGogDescriptionHtml(
                catData.description?.lead || '',
                synopsisOnly
              );
              if (
                cleanedCatFull &&
                cleanedCatFull.length >= 30 &&
                !isGenericPlaceholderSynopsis(cleanedCatFull, lookupTitle)
              ) {
                descriptionFull = cleanedCatFull;
                descriptionLead =
                  extractFirstParagraph(cleanedCatLead || cleanedCatFull) || descriptionLead || '';
              }
              if (
                !synopsisOnly &&
                screenshots.length === 0 &&
                Array.isArray(catData.screenshots)
              ) {
                screenshots = mapGogScreenshots(catData.screenshots);
              }
              if (!synopsisOnly && movies.length === 0 && Array.isArray(catData.videos)) {
                movies = catData.videos.map((v: GogRawVideo, idx: number) => ({
                  id: idx,
                  name: `Trailer ${idx + 1}`,
                  thumbnail: ensureHttps(v.thumbnail_url || ''),
                  webm: { 480: '', max: '' },
                  mp4: {
                    480: ensureHttps(v.video_url || ''),
                    max: ensureHttps(v.video_url || ''),
                  },
                }));
              }
              if (catData.release_date && releaseDate === 'TBA') {
                releaseDate = String(catData.release_date).substring(0, 10);
              }
            }
          } catch (catProdErr: unknown) {
            console.warn(
              `[Fallback Provider] GOG catalog product detail lookup failed for ${catProd.id}:`,
              getErrorMessage(catProdErr)
            );
          }
        }
      }

      const targetSlug = purchaseSlug || catProd?.slug || data?.slug;
      if (!descriptionFull && targetSlug && typeof DOMParser !== 'undefined') {
        try {
          const encodedSlug = encodeURIComponent(targetSlug);
          const pageUrl = `${gogProfileBaseUrl}/en/game/${encodedSlug}`;
          const pageRes = await requestScheduler.schedule(
            `https://www.gog.com/en/game/${encodedSlug}`,
            () => axios.get<string>(pageUrl, { timeout: 5000 }),
            effectivePriority,
            'www.gog.com',
            gogGameKey
          );
          if (pageRes.data && typeof pageRes.data === 'string') {
            const doc = new DOMParser().parseFromString(pageRes.data, 'text/html');
            const descEl = doc.querySelector('.description');
            if (descEl) {
              descEl
                .querySelectorAll('script, style, .description__copyrights')
                .forEach((el) => el.remove());
              const scrapedHtml = cleanGogDescriptionHtml(descEl.innerHTML.trim(), synopsisOnly);
              if (scrapedHtml && !isGenericPlaceholderSynopsis(scrapedHtml, lookupTitle)) {
                descriptionFull = scrapedHtml;
                descriptionLead =
                  extractFirstParagraph(scrapedHtml) ||
                  descEl.textContent?.split('\n')[0]?.trim() ||
                  descriptionLead;
              }
            }
          }
        } catch (scrapeErr: unknown) {
          console.warn(
            `[Fallback Provider] Store page scrape failed for ${targetSlug}:`,
            getErrorMessage(scrapeErr)
          );
        }
      }
    }
  } catch (err: unknown) {
    console.warn(
      `[Fallback Provider] GOG live product lookup failed for ${gogId}:`,
      getErrorMessage(err)
    );
  }

  const hasResolvedGogContent = Boolean(
    descriptionFull ||
      descriptionLead ||
      screenshots.length > 0 ||
      movies.length > 0 ||
      headerImage ||
      capsuleImage ||
      (v2Devs && v2Devs.length > 0) ||
      (v2Pubs && v2Pubs.length > 0) ||
      (v2Genres && v2Genres.length > 0) ||
      v2Localizations ||
      v1Languages ||
      v2Requirements.systemRequirements ||
      v2Requirements.macRequirements ||
      v2Requirements.linuxRequirements
  );

  if (!hasResolvedGogContent) {
    return null;
  }

  const sysReqs: SteamSystemRequirements = synopsisOnly
    ? {}
    : {
        ...(v2Requirements.systemRequirements?.minimum
          ? { minimum: v2Requirements.systemRequirements.minimum }
          : {}),
        ...(v2Requirements.systemRequirements?.recommended
          ? { recommended: v2Requirements.systemRequirements.recommended }
          : {}),
      };

  const cleanGogShort = stripHtmlToPlainSynopsis(descriptionLead || descriptionFull);
  const parsedGogLangs = parseGogLocalizations(v2Localizations, v1Languages);

  const hasGogWinReq = Boolean(sysReqs.minimum?.trim() || sysReqs.recommended?.trim());
  const hasGogMacReq = Boolean(
    v2Requirements.macRequirements?.minimum?.trim() ||
      v2Requirements.macRequirements?.recommended?.trim()
  );
  const hasGogLinuxReq = Boolean(
    v2Requirements.linuxRequirements?.minimum?.trim() ||
      v2Requirements.linuxRequirements?.recommended?.trim()
  );
  let gogPlatforms: SteamEnrichedMetadata['platforms'] | undefined;
  if (Array.isArray(v2SupportedOperatingSystems) && v2SupportedOperatingSystems.length > 0) {
    const osNames = v2SupportedOperatingSystems
      .map((entry) => String(entry?.operatingSystem?.name || '').trim())
      .filter(Boolean);
    if (osNames.length > 0 || hasGogWinReq || hasGogMacReq || hasGogLinuxReq) {
      gogPlatforms = {
        windows: hasGogWinReq || osNames.some((n) => /^win/i.test(n)),
        mac: hasGogMacReq || osNames.some((n) => /^(?:osx|mac)/i.test(n)),
        linux: hasGogLinuxReq || osNames.some((n) => /^linux/i.test(n)),
      };
    }
  } else if (hasGogWinReq || hasGogMacReq || hasGogLinuxReq) {
    gogPlatforms = {
      windows: hasGogWinReq,
      mac: hasGogMacReq,
      linux: hasGogLinuxReq,
    };
  }

  return {
    aboutTheGame: descriptionFull,
    detailedDescription: descriptionFull,
    shortDescription: cleanGogShort,
    headerImage: ensureHttps(headerImage),
    capsuleImage: ensureHttps(capsuleImage),
    screenshots,
    movies,
    releaseDate,
    developers: v2Devs,
    publishers: v2Pubs,
    genres: v2Genres,
    tags: v2Tags,
    categories: [],
    supportedLanguages: parsedGogLangs.supportedLanguages || '',
    languageOptions: parsedGogLangs.languageOptions,
    languageTableSchema: parsedGogLangs.languageTableSchema || 'audio_text',
    systemRequirements: sysReqs,
    ...(v2Requirements.macRequirements ? { macRequirements: v2Requirements.macRequirements } : {}),
    ...(v2Requirements.linuxRequirements
      ? { linuxRequirements: v2Requirements.linuxRequirements }
      : {}),
    ...(gogPlatforms ? { platforms: gogPlatforms } : {}),
    // P0-11: synopsisOnly MUST NOT stamp full 'scraped' + fetchedAt so full detail hydration still runs
    metadataQuality: synopsisOnly ? 'local_federated' : 'scraped',
    enrichedSource: 'gog',
    ...(synopsisOnly ? {} : { fetchedAt: Date.now() }),
    achievements: undefined,
  };
}
