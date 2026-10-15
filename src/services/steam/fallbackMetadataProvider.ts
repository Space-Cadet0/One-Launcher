import axios from 'axios';
import { CanonicalGame } from '../../contracts/game';
import { UserGameOverride } from '../../contracts/override';
import { SteamEnrichedMetadata, SteamScreenshot, SteamMovie, SteamReviewSummary, SteamCategory } from '../../contracts/steam';
import { getOpenCriticData } from '../opencritic/openCritic';
import {
  getUserOverrideForGame,
  inferMetadataRouteFromOverride,
  updateRoutedMetadataSnapshot,
} from '../storage/userOverrideStorage';
import { getSteamCategoryIconUrl } from './steamApi';
import gogEnrichedCache from '../storage/gogEnrichedCache.json';

function ensureHttps(url?: string): string {
  if (!url) return '';
  const trimmed = url.trim();
  if (trimmed.startsWith('//')) return 'https:' + trimmed;
  return trimmed;
}

export function extractFirstParagraph(rawText?: string, maxLength = 260): string | null {
  if (!rawText) return null;
  const clean = rawText
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\/?(b|i|u|url|quote|img)[^\]]*\]/gi, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();

  if (!clean) return null;

  const paragraphs = clean.split(/\r?\n+/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (paragraphs.length === 0) return null;

  let firstPara = paragraphs[0];
  if (firstPara.length < 30 && paragraphs.length > 1 && /^(about|overview|story|description|features)/i.test(firstPara)) {
    firstPara = paragraphs[1];
  }

  if (firstPara.length > maxLength) {
    const truncated = firstPara.substring(0, maxLength);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > maxLength * 0.7) {
      firstPara = truncated.substring(0, lastSpace).trim() + '...';
    } else {
      firstPara = truncated.trim() + '...';
    }
  }
  return firstPara.trim();
}

export function isGenericPlaceholderSynopsis(desc?: string, title?: string): boolean {
  if (!desc) return true;
  const trimmed = desc.trim();
  if (trimmed.length <= 3) return true;
  const lower = trimmed.toLowerCase();
  if (title && lower === title.trim().toLowerCase()) return true;
  if (lower.includes('drm-free')) return true;
  if (lower.includes('store exclusive')) return true;
  if (lower.includes('on gog.com')) return true;
  if (lower.includes('epic games store')) return true;
  if (/^(action|role-playing|adventure|shooter|strategy|simulation|racing|sports|indie)\s+experience$/i.test(trimmed)) return true;
  if (lower === 'classic title') return true;
  if (/^[a-z\s-]+ on gog\.com/i.test(trimmed)) return true;
  if (/^dlcs?\s+(included|available)/i.test(trimmed)) return true;
  if (/^includes\s+(the\s+following\s+)?dlc/i.test(trimmed)) return true;
  if (/^bonus\s+content\s+included/i.test(trimmed)) return true;
  if (/^this\s+(package|edition|version)\s+includes/i.test(trimmed)) return true;
  return false;
}

export const GOG_SPECIAL_DESCRIPTIONS: Record<string, { lead: string; full: string; releaseDate?: string; headerImage?: string }> = {};

export function formatDescriptionToHtml(rawDesc: string): string {
  if (!rawDesc) return '';
  // If already full HTML with paragraph or heading tags, return as-is
  if (rawDesc.includes('<p class="bb_paragraph">') || rawDesc.includes('<h2 class="bb_tag">')) {
    return rawDesc;
  }

  const lines = rawDesc.split(/\r?\n/);
  const htmlParts: string[] = [];
  let currentParagraph: string[] = [];

  const formatInline = (text: string): string => {
    return text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>')
      .replace(/(?<!_)_([^_]+?)_(?!_)/g, '<em>$1</em>');
  };

  const flushParagraph = () => {
    if (currentParagraph.length > 0) {
      const text = currentParagraph.join(' ').trim();
      if (text) {
        htmlParts.push(`<p class="bb_paragraph">${formatInline(text)}</p>`);
      }
      currentParagraph = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      continue;
    }

    const headingMatch = trimmed.match(/^#{1,4}\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      htmlParts.push(`<h2 class="bb_tag">${formatInline(headingMatch[1].trim())}</h2>`);
      continue;
    }

    const boldOnlyMatch = trimmed.match(/^\*\*(.+?)\*\*$/);
    if (boldOnlyMatch) {
      flushParagraph();
      htmlParts.push(`<h2 class="bb_tag">${boldOnlyMatch[1].trim()}</h2>`);
      continue;
    }

    currentParagraph.push(trimmed);
  }

  flushParagraph();
  return htmlParts.join('\n');
}

export function formatGogSystemRequirements(raw?: string): string {
  if (!raw) return '';
  if (raw.includes('<strong>')) return raw;
  let text = raw;
  if (!text.startsWith('OS:') && !text.startsWith('<strong>')) {
    text = '<strong>OS:</strong> ' + text;
  }
  return text
    .replace(/,\s*(Processor|CPU):/gi, '<br><strong>Processor:</strong> ')
    .replace(/,\s*(Memory|RAM):/gi, '<br><strong>Memory:</strong> ')
    .replace(/,\s*(Graphics|Video Card):/gi, '<br><strong>Graphics:</strong> ')
    .replace(/,\s*(DirectX):/gi, '<br><strong>DirectX:</strong> ')
    .replace(/,\s*(Hard Drive|Storage|Disk Space):/gi, '<br><strong>Storage:</strong> ')
    .replace(/,\s*(Sound Card|Sound):/gi, '<br><strong>Sound Card:</strong> ')
    .replace(/,\s*(Other|Additional Notes):/gi, '<br><strong>Additional Notes:</strong> ');
}

export class FallbackMetadataProvider {
  private getGogBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/gog-product';
    }
    return 'https://api.gog.com';
  }

  private getEpicContentBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/epic-content';
    }
    return 'https://store-content.ak.epicgames.com';
  }

  /**
   * Fetches rich metadata directly from GOG's official product API and enriched catalog
   */
  async fetchGogProductMetadata(gogId: string): Promise<Partial<SteamEnrichedMetadata> | null> {
    const cached = (gogEnrichedCache as Record<string, any>)[gogId];
    const special = GOG_SPECIAL_DESCRIPTIONS[gogId];

    let screenshots: SteamScreenshot[] = [];
    let movies: SteamMovie[] = [];
    let headerImage = special?.headerImage || cached?.coverHorizontal || cached?.coverVertical || '';
    let capsuleImage = cached?.coverVertical || cached?.coverHorizontal || '';
    let descriptionFull = special?.full || cached?.aboutTheGame || cached?.detailedDescription || '';
    let descriptionLead = special?.lead || cached?.shortDescription || '';
    let releaseDate = special?.releaseDate || cached?.releaseDate || 'TBA';
    let v2Devs: string[] | undefined = cached?.developers?.length ? cached.developers : undefined;
    let v2Pubs: string[] | undefined = cached?.publishers?.length ? cached.publishers : undefined;
    let v2Genres: string[] | undefined = cached?.genres?.length ? cached.genres : undefined;
    let v2Tags: string[] | undefined = cached?.tags?.length ? cached.tags : undefined;

    const cleanGogId = String(gogId).replace(/^gog-/, '').trim();

    try {
      const urlV1 = `${this.getGogBaseUrl()}/products/${encodeURIComponent(cleanGogId)}?expand=description,screenshots,videos`;
      const urlV2 = `${this.getGogBaseUrl()}/v2/games/${encodeURIComponent(cleanGogId)}`;
      const [resV1Settled, resV2Settled] = await Promise.allSettled([
        axios.get(urlV1, { timeout: 8000 }),
        axios.get(urlV2, { timeout: 6000 }),
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
          const devs = v2Data._embedded.developers.map((d: any) => d?.name).filter(Boolean);
          if (devs.length > 0) v2Devs = devs;
        }
        if (Array.isArray(v2Data._embedded?.publishers)) {
          const pubs = v2Data._embedded.publishers.map((p: any) => p?.name).filter(Boolean);
          if (pubs.length > 0) v2Pubs = pubs;
        }
        if (Array.isArray(v2Data._embedded?.tags)) {
          const tags = v2Data._embedded.tags.map((t: any) => t?.name).filter(Boolean);
          if (tags.length > 0) {
            if (!v2Genres) v2Genres = tags;
            if (!v2Tags) v2Tags = tags;
          }
        }
        const globalRel = v2Data._embedded?.product?.globalReleaseDate;
        if (globalRel && typeof globalRel === 'string' && releaseDate === 'TBA') {
          releaseDate = globalRel.substring(0, 10);
        }
        if (v2Data.description && typeof v2Data.description === 'string' && !descriptionFull) {
          descriptionFull = v2Data.description.trim();
          descriptionLead = extractFirstParagraph(descriptionFull) || descriptionLead;
        }
      }

      if (data) {
        if (data.screenshots && Array.isArray(data.screenshots)) {
          screenshots = data.screenshots.map((s: any, idx: number) => {
            const fullImg =
              s.formatted_images?.find((img: any) => img.formatter_name === 'ggvgl_2x')?.image_url ||
              s.formatted_images?.find((img: any) => img.formatter_name === 'ggvgl')?.image_url ||
              (s.formatter_template_url ? s.formatter_template_url.replace('{formatter}', 'ggvgl_2x') : '');
            const thumbImg =
              s.formatted_images?.find((img: any) => img.formatter_name === 'ggvgm')?.image_url || fullImg;

            return {
              id: idx,
              pathThumbnail: ensureHttps(thumbImg),
              pathFull: ensureHttps(fullImg),
            };
          });
        }

        if (data.videos && Array.isArray(data.videos)) {
          movies = data.videos.map((v: any, idx: number) => ({
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

        const apiDescFull = data.description?.full || data.description?.lead || '';
        const apiDescLead = data.description?.lead || '';

        // Clean out raw localization placeholders (e.g. product_description_1413291984 or product_feature_2028023186)
        const cleanedDescFull = apiDescFull
          .replace(/<li[^>]*>\s*product_feature_\d+\s*<\/li>/gi, '')
          .replace(/<ul[^>]*>\s*<\/ul>/gi, '')
          .replace(/product_feature_\d+/gi, '')
          .replace(/product_description_\d+/gi, '')
          .trim();

        const isPlaceholderDesc =
          !cleanedDescFull ||
          cleanedDescFull.length < 30 ||
          cleanedDescFull.includes('product_description_');

        if (!isPlaceholderDesc && cleanedDescFull) {
          descriptionFull = cleanedDescFull;
          descriptionLead = apiDescLead || descriptionLead || extractFirstParagraph(cleanedDescFull) || '';
        } else if (GOG_SPECIAL_DESCRIPTIONS[gogId]) {
          descriptionLead = GOG_SPECIAL_DESCRIPTIONS[gogId].lead;
          descriptionFull = GOG_SPECIAL_DESCRIPTIONS[gogId].full;
        } else if (data.slug && !descriptionFull) {
          try {
            const pageUrl =
              typeof window !== 'undefined' && window.location.hostname === 'localhost'
                ? `/api/gog-profile/en/game/${encodeURIComponent(data.slug)}`
                : `https://www.gog.com/en/game/${encodeURIComponent(data.slug)}`;
            const pageRes = await axios.get(pageUrl, { timeout: 5000 });
            if (pageRes.data && typeof pageRes.data === 'string') {
              const cheerio = await import('cheerio');
              const $ = cheerio.load(pageRes.data);
              const descEl = $('.description');
              descEl.find('script, style, .description__copyrights').remove();
              const scrapedHtml = descEl.html()?.trim();
              if (scrapedHtml && !scrapedHtml.includes('product_description_')) {
                descriptionFull = scrapedHtml;
                descriptionLead = descEl.text()?.split('\n')[0]?.trim() || descriptionLead;
              }
            }
          } catch (scrapeErr: any) {
            console.warn(`[Fallback Provider] Store page scrape failed for ${data.slug}:`, scrapeErr?.message);
          }
        }

        if (data.release_date && releaseDate === 'TBA') {
          releaseDate = data.release_date.substring(0, 10);
        }
      }
    } catch (err: any) {
      console.warn(`[Fallback Provider] GOG live product lookup failed for ${gogId}:`, err?.message);
    }

    if (screenshots.length === 0 && (cached?.coverHorizontal || cached?.coverVertical)) {
      const img = cached.coverHorizontal || cached.coverVertical;
      screenshots = [{ id: 0, pathThumbnail: ensureHttps(img), pathFull: ensureHttps(img) }];
    }

    const rawCategories = cached?.categories || [
      { id: 2, description: 'Single-player' },
    ];
    const categories: SteamCategory[] = rawCategories.map((c: any) => ({
      id: c.id,
      description: c.description,
      icon: getSteamCategoryIconUrl(c.id),
    }));

    const sysReqs = {
      minimum: formatGogSystemRequirements(cached?.systemRequirements?.minimum),
      recommended: formatGogSystemRequirements(cached?.systemRequirements?.recommended),
    };

    return {
      aboutTheGame: descriptionFull,
      detailedDescription: descriptionFull,
      shortDescription: descriptionLead,
      headerImage: ensureHttps(headerImage),
      capsuleImage: ensureHttps(capsuleImage),
      screenshots,
      movies,
      releaseDate: GOG_SPECIAL_DESCRIPTIONS[gogId]?.releaseDate || releaseDate,
      developers: v2Devs,
      publishers: v2Pubs,
      genres: v2Genres,
      tags: v2Tags,
      categories,
      supportedLanguages: cached?.supportedLanguages || 'English<strong>*</strong>',
      systemRequirements: sysReqs,
      achievements: cached?.features?.includes('Achievements') ? { total: 20 } : undefined,
    };
  }

  /**
   * Fetches rich metadata directly from Epic Games Store Content API (e.g. for Epic exclusives)
   */
  async fetchEpicProductMetadata(slugOrTitle: string): Promise<Partial<SteamEnrichedMetadata> | null> {
    try {
      const cleanSlug = slugOrTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      const url =
        typeof window !== 'undefined' && window.location.hostname === 'localhost'
          ? `/api/epic-content/api/en-US/content/products/${cleanSlug}`
          : `${this.getEpicContentBaseUrl()}/api/en-US/content/products/${cleanSlug}`;

      const res = await axios.get(url, { timeout: 8000 });
      const data = res.data;

      const home = data?.pages?.find((p: any) => p.type === 'productHome') || data?.pages?.[0];
      if (!home?.data) return null;

      const d = home.data;
      const screenshots: SteamScreenshot[] = [];
      const movies: SteamMovie[] = [];

      // Extract carousel items (videos and images)
      const carouselItems = d?.carousel?.items || [];
      carouselItems.forEach((item: any, idx: number) => {
        // 1. Extract image screenshots
        const rawImg =
          item.image?.src ||
          item.image?.url ||
          (typeof item.image === 'string' ? item.image : null) ||
          item.src ||
          item.url;
        if (rawImg && typeof rawImg === 'string' && !screenshots.some((s) => s.pathFull === rawImg)) {
          screenshots.push({
            id: idx,
            pathThumbnail: rawImg,
            pathFull: rawImg,
          });
        }

        // 2. Extract video trailers
        if (item.video?.recipes) {
          try {
            const recipes = typeof item.video.recipes === 'string' ? JSON.parse(item.video.recipes) : item.video.recipes;
            const langObj = recipes['en-US'] || recipes['en'] || Object.values(recipes)[0];
            if (Array.isArray(langObj)) {
              const hlsOutput = langObj.find((r: any) => r.recipe === 'video-hls')?.outputs?.find((o: any) => o.key === 'manifest');
              const mp4Output = langObj.find((r: any) => r.recipe === 'video-fmp4' || r.recipe === 'video-webm')?.outputs?.find((o: any) => o.key === 'manifest');
              const thumbOutput = langObj.find((r: any) => r.outputs?.some((o: any) => o.key === 'thumbnail'))?.outputs?.find((o: any) => o.key === 'thumbnail');

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
            // Ignore parse errors
          }
        }
      });

      // Also check gallery images if available
      const galleryImages = d.gallery?.galleryImages || [];
      galleryImages.forEach((g: any, idx: number) => {
        const gUrl = g.src || g.url || (typeof g === 'string' ? g : null);
        if (gUrl && typeof gUrl === 'string' && !screenshots.some((s) => s.pathFull === gUrl)) {
          screenshots.push({
            id: 2000 + idx,
            pathThumbnail: gUrl,
            pathFull: gUrl,
          });
        }
      });

      const reqs = d.requirements?.systems?.[0]?.details || [];
      const minReq = reqs.map((r: any) => (r.title && r.minimum ? `<strong>${r.title}:</strong> ${r.minimum}` : '')).filter(Boolean).join('<br>');
      const recReq = reqs.map((r: any) => (r.title && r.recommended ? `<strong>${r.title}:</strong> ${r.recommended}` : '')).filter(Boolean).join('<br>');

      const descFull = d.about?.description || d.about?.about || d.markdown?.markdown || '';
      const formattedAbout = formatDescriptionToHtml(descFull);
      const descShort = d.about?.shortDescription || '';
      const headerImage =
        d.hero?.backgroundImageUrl ||
        d.hero?.portrait ||
        d.banner?.image ||
        d.about?.image?.src ||
        '';
      const capsuleImage =
        d.hero?.portraitBackgroundImageUrl ||
        d.hero?.portrait ||
        '';
      const iconUrl =
        d.hero?.logoImage?.src ||
        '';

      return {
        aboutTheGame: formattedAbout,
        detailedDescription: formattedAbout,
        shortDescription: descShort,
        headerImage,
        capsuleImage,
        iconUrl,
        screenshots,
        movies,
        systemRequirements: {
          minimum: minReq,
          recommended: recReq,
        },
        releaseDate: d.meta?.releaseDate ? d.meta.releaseDate.substring(0, 10) : '',
        developers: d.about?.developerAttribution ? [d.about.developerAttribution] : undefined,
        publishers: d.about?.publisherAttribution ? [d.about.publisherAttribution] : undefined,
        achievements: undefined,
      };
    } catch (err: any) {
      console.warn(`[Fallback Provider] Epic product content lookup failed for ${slugOrTitle}:`, err?.message);
      return null;
    }
  }

  /**
   * Builds high-quality enriched metadata for games that DO NOT exist on Steam
   * or are explicitly routed to a non-Steam storefront via metadataRoute.
   */
  async getEnrichedMetadataForNonSteamGame(
    game: CanonicalGame,
    explicitOverride?: UserGameOverride
  ): Promise<SteamEnrichedMetadata> {
    const gogPlatform = game.platforms?.find((p) => p.platformId === 'gog');
    const epicPlatform = game.platforms?.find((p) => p.platformId === 'epic');
    const override = explicitOverride ?? getUserOverrideForGame(game);
    const route = inferMetadataRouteFromOverride(override);

    let storeMetadata: Partial<SteamEnrichedMetadata> | null = null;

    // 1. Honor explicit Step 4 MetadataSourceRoute first (allows routing any game to GOG or Epic)
    if (route?.source === 'gog') {
      const targetGogId =
        route.gogId ||
        (route.matchedId ? String(route.matchedId).replace(/^gog-/, '') : undefined) ||
        gogPlatform?.platformGameId;
      if (targetGogId) {
        storeMetadata = await this.fetchGogProductMetadata(String(targetGogId));
      }
    } else if (route?.source === 'epic') {
      const explicitSlug =
        route.epicSlug ||
        (route.matchedId && !/^[0-9a-f]{20,}$/i.test(String(route.matchedId))
          ? String(route.matchedId).replace(/^epic-/, '')
          : undefined);
      const titleSlug = (route.targetTitle || override?.title || game.title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      if (explicitSlug) {
        storeMetadata = await this.fetchEpicProductMetadata(explicitSlug);
      }
      if (!storeMetadata && titleSlug) {
        storeMetadata = await this.fetchEpicProductMetadata(titleSlug);
      }
      if (
        !storeMetadata &&
        epicPlatform?.platformGameId &&
        !/^[0-9a-f]{20,}$/i.test(epicPlatform.platformGameId)
      ) {
        storeMetadata = await this.fetchEpicProductMetadata(epicPlatform.platformGameId);
      }
    }

    // 2. Fallback to platform-based or cross-store GOG/Epic IDs if not yet resolved
    if (!storeMetadata) {
      const fallbackGogId = route?.gogId || gogPlatform?.platformGameId;
      if (fallbackGogId) {
        storeMetadata = await this.fetchGogProductMetadata(String(fallbackGogId));
      }
    }

    if (!storeMetadata && (epicPlatform || route?.epicSlug)) {
      const titleSlug = (route?.targetTitle || game.title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      storeMetadata = await this.fetchEpicProductMetadata(route?.epicSlug || titleSlug);

      if (
        !storeMetadata &&
        epicPlatform?.platformGameId &&
        !/^[0-9a-f]{20,}$/i.test(epicPlatform.platformGameId)
      ) {
        storeMetadata = await this.fetchEpicProductMetadata(epicPlatform.platformGameId);
      }
    }

    if (storeMetadata && override && route?.mode === 'routed') {
      updateRoutedMetadataSnapshot(game.id, {
        title: storeMetadata.name,
        shortDescription: storeMetadata.shortDescription,
        detailedDescription: storeMetadata.detailedDescription || storeMetadata.aboutTheGame,
        headerImage: storeMetadata.headerImage,
        developers: storeMetadata.developers,
        publishers: storeMetadata.publishers,
        genres: storeMetadata.genres,
        tags: storeMetadata.tags,
        releaseDate: storeMetadata.releaseDate,
      });
    }

    // Pull Critic review data if verified
    const ocData = getOpenCriticData(undefined, game.title);
    const reviewSummary: SteamReviewSummary = ocData
      ? {
          reviewScore: Math.round(ocData.score / 10),
          reviewScoreDesc: `${ocData.tier} (${ocData.score}%)`,
          totalPositive: ocData.numReviews ? Math.round(ocData.numReviews * 0.9) : 95,
          totalNegative: ocData.numReviews ? Math.round(ocData.numReviews * 0.1) : 5,
          totalReviews: ocData.numReviews || 100,
          positivePercent: ocData.score,
        }
      : {
          reviewScore: 8,
          reviewScoreDesc: 'Positive',
          totalPositive: 80,
          totalNegative: 20,
          totalReviews: 100,
          positivePercent: 80,
        };

    const devs =
      (storeMetadata?.developers && storeMetadata.developers.length > 0)
        ? storeMetadata.developers
        : (game.developers && game.developers.length > 0)
        ? game.developers
        : [];

    const pubs =
      (storeMetadata?.publishers && storeMetadata.publishers.length > 0)
        ? storeMetadata.publishers
        : (game.publishers && game.publishers.length > 0)
        ? game.publishers
        : [];

    const genres =
      (storeMetadata?.genres && storeMetadata.genres.length > 0)
        ? storeMetadata.genres
        : (game.genres && game.genres.length > 0)
        ? game.genres
        : ['Action'];

    const tags =
      (storeMetadata?.tags && storeMetadata.tags.length > 0)
        ? storeMetadata.tags
        : (game.tags && game.tags.length > 0)
        ? game.tags
        : ['Store Exclusive'];

    const categories =
      (storeMetadata?.categories && storeMetadata.categories.length > 0)
        ? storeMetadata.categories
        : [
            {
              id: 2,
              description: 'Single-player',
              icon: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_singlePlayer.png',
            },
          ];

    const firstParaDesc =
      extractFirstParagraph(storeMetadata?.detailedDescription) ||
      extractFirstParagraph(storeMetadata?.aboutTheGame) ||
      extractFirstParagraph(game.shortDescription);

    const cleanSummary =
      genres.length > 0 && genres[0] !== 'Store Exclusive'
        ? `${game.title} is a ${genres.slice(0, 3).join(', ')} title${devs.length > 0 ? ` developed by ${devs[0]}` : ''}.`
        : `${game.title} is a single-player title${devs.length > 0 ? ` developed by ${devs[0]}` : ''}.`;

    const shortDescription =
      storeMetadata?.shortDescription && !isGenericPlaceholderSynopsis(storeMetadata.shortDescription, game.title)
        ? storeMetadata.shortDescription.trim()
        : game.shortDescription && !isGenericPlaceholderSynopsis(game.shortDescription, game.title)
        ? game.shortDescription.trim()
        : firstParaDesc && !isGenericPlaceholderSynopsis(firstParaDesc, game.title)
        ? firstParaDesc
        : cleanSummary;

    const detailedDescription =
      storeMetadata?.detailedDescription ||
      storeMetadata?.aboutTheGame ||
      (game.shortDescription && !isGenericPlaceholderSynopsis(game.shortDescription, game.title) ? game.shortDescription : '') ||
      cleanSummary;

    return {
      appId: 0,
      name: game.title,
      shortDescription,
      detailedDescription,
      aboutTheGame: detailedDescription,
      headerImage: ensureHttps(storeMetadata?.headerImage || game.headerImage),
      capsuleImage: ensureHttps(storeMetadata?.capsuleImage || game.capsuleImage || storeMetadata?.headerImage || game.headerImage),
      iconUrl: ensureHttps(storeMetadata?.iconUrl || game.iconUrl || ''),
      developers: devs,
      publishers: pubs,
      releaseDate: storeMetadata?.releaseDate || game.releaseDate || 'TBA',
      genres,
      tags,
      categories,
      supportedLanguages: storeMetadata?.supportedLanguages,
      screenshots:
        storeMetadata?.screenshots && storeMetadata.screenshots.length > 0
          ? storeMetadata.screenshots
          : game.headerImage
          ? [{ id: 0, pathThumbnail: ensureHttps(game.headerImage), pathFull: ensureHttps(game.headerImage) }]
          : [],
      movies: storeMetadata?.movies || [],
      systemRequirements: storeMetadata?.systemRequirements || {},
      reviewSummary,
      achievements: storeMetadata?.achievements,
    };
  }
}

export const fallbackMetadataProvider = new FallbackMetadataProvider();
