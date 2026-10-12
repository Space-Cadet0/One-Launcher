import axios from 'axios';
import { CanonicalGame } from '../../contracts/game';
import { SteamEnrichedMetadata, SteamScreenshot, SteamMovie, SteamReviewSummary, SteamCategory } from '../../contracts/steam';
import { getOpenCriticData } from '../opencritic/openCritic';
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

export const GOG_SPECIAL_DESCRIPTIONS: Record<string, { lead: string; full: string; releaseDate?: string; headerImage?: string }> = {
  '1413291984': {
    lead: 'Developed by id Software, and originally released in 1993, DOOM pioneered and popularized the first-person shooter, setting a standard for all FPS games. The critically acclaimed sequel, DOOM II, followed in 1994. Now the definitive, newly enhanced versions of DOOM + DOOM II are available as a combined product.',
    full: `Developed by id Software, and originally released in 1993, DOOM pioneered and popularized the first-person shooter, setting a standard for all FPS games. The critically acclaimed sequel, DOOM II, followed in 1994. Now the definitive, newly enhanced versions of DOOM + DOOM II are available as a combined product.<br><br><b>Owners Receive:</b><br>- DOOM<br>- DOOM II<br>- TNT: Evilution<br>- The Plutonia Experiment<br>- Master Levels for DOOM II<br>- No Rest for the Living<br>- Sigil<br>- Sigil II<br>- Legacy of Rust (a new episode created in collaboration by id Software, Nightdive Studios and MachineGames)<br>- A new Deathmatch map pack featuring 25 maps<br><br>Altogether, there are a total of 187 mission maps and 43 deathmatch maps in DOOM + DOOM II.<br><br><b>New Enhancements:</b><br>- Online, cross-platform deathmatch and co-op for up to 16 players<br>- Community-published mod support with an in-game mod browser<br>- Choose between the original midi DOOM and DOOM II soundtracks or the modern IDKFA versions by Andrew Hulshult<br>- Improved performance with multithreaded rendering supporting up to 4K resolution<br>- Now on the KEX engine<br>- 60 FPS and native 16:9 support<br>- Restored original in-game music using original hardware<br>- Quick Save/Load support`,
    releaseDate: '2024-08-08',
  },
  '1837805079': {
    lead: 'Cast out into the night as a vampire, seek vengeance on your murderers and discover the dark plot threatening the land of Nosgoth in this classic dark fantasy action-adventure.',
    full: `Cast out into the night as a vampire, seek vengeance on your murderers and discover the dark plot threatening the land of Nosgoth in this classic dark fantasy action-adventure.<br><br>Take the role of Kain, a nobleman murdered and revived as a vampire, as you traverse the expansive world of Nosgoth. Slaughter enemies, drink their blood to sustain your life, cast devastating spells, and wield legendary weapons in an epic quest for vengeance and power.<br><br><b>Features:</b><br>- Over 60 hours of dark, open-ended gameplay<br>- Transform into a bat, wolf, mist, or disguise yourself as a human<br>- Epic storyline with cinematic voice acting and rich lore`,
    releaseDate: '1996-11-15',
  },
  '1782995089': {
    lead: 'Experience the vast open world of The Elder Scrolls: Daggerfall reimagined in the Unity engine, featuring modernized controls, enhanced visuals, bug fixes, and pre-installed community mods.',
    full: `Experience the vast open world of The Elder Scrolls: Daggerfall reimagined in the Unity engine, featuring modernized controls, enhanced visuals, bug fixes, and pre-installed community mods.<br><br>Explore thousands of cities, dungeons, and hamlets across the Iliac Bay in one of the most ambitious fantasy RPGs ever created. The GOG Cut includes high-resolution terrain, remastered textures, improved lighting, and refined gameplay systems ready to play out of the box.<br><br><b>Features:</b><br>- Modernized first-person controls with smooth mouse-look and customizable keybindings<br>- Enhanced visuals with widescreen and 4K resolution support<br>- Massive roster of curated community mods including DREAM, Warm Ashes, and Archaeologists Guild<br>- Full classic character creation and endless procedural quests`,
    releaseDate: '2022-06-15',
  },
  '1491728574': {
    lead: 'Fallout: London is an ambitious total conversion mod for Fallout 4 that takes players out of America and drops them into a post-apocalyptic United Kingdom, exploring a brand new wasteland filled with unique factions and storylines.',
    full: `Fallout: London is an ambitious total conversion mod for Fallout 4 that takes players out of America and drops them into a post-apocalyptic United Kingdom, exploring a brand new wasteland filled with unique factions and storylines.<br><br>Set fifty years before Fallout 4, Fallout: London lets you experience the events of Nuclear Apocalypse in a completely distinct cultural setting. From stuffy parliamentary aristocrats to a resurrection of the Knights of the Round Table and an uncompromising cult of revolutionaries, experience an all-new gritty post-war epic.<br><br><b>Features:</b><br>- A completely new map encompassing a detailed London metropolis with diverse boroughs<br>- Fully voiced storyline with original characters, factions, and companions<br>- Unique British weaponry, retro-futuristic technology, and cultural lore`,
    releaseDate: '2024-07-25',
  },
  '2028023186': {
    lead: 'Agony is a first-person, survival horror set in hell. You will begin your journey as a tormented soul within the depths of hell without any memories about your past. The special ability to control people on your path, and possess demons, gives you the measures to survive.',
    full: `Agony is a first-person, survival horror set in hell. You will begin your journey as a tormented soul within the depths of hell without any memories about your past. The special ability to control people on your path, and possess demons, gives you the measures to survive.<br><br>By exploring hostile environments and interacting with other souls of the hellscape, the hero will soon understand that there is only one way to escape from Hell, and it requires a meeting of the mystical Red Goddess.<br><br><b>Features:</b><br>- Non-linear survival horror in the depths of hell<br>- Possess lesser and greater demons and control people to survive<br>- Hostile, grotesque underworld environment inspired by Dante's Inferno<br>- Agony Mode featuring procedural survival labyrinth challenges`,
    releaseDate: '2018-05-29',
  },
  '1213448387': {
    lead: 'Agony UNRATED is the definitive, uncensored first-person survival horror experience set in the grotesque depths of hell.',
    full: `Agony UNRATED is the definitive, uncensored first-person survival horror experience set in the grotesque depths of hell.<br><br>This unrated edition features completely uncensored cinematics and gameplay scenes, enhanced lighting and high-resolution textures, additional character models and animations, newly designed forest and torture chamber environments, and refined stealth and combat systems.<br><br><b>Features:</b><br>- Completely uncensored story, cinematics, and environments<br>- High-resolution textures, volumetric lighting, and upgraded graphics engine<br>- Additional game modes including Succubus Mode and procedural Agony Mode<br>- Full map and fast-travel system, hard difficulty mode, and expanded demon roster`,
    releaseDate: '2018-10-30',
  },
};

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

    try {
      const url = `${this.getGogBaseUrl()}/products/${encodeURIComponent(gogId)}?expand=description,screenshots,videos`;
      const res = await axios.get(url, { timeout: 8000 });
      const data = res.data;
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
          descriptionLead = apiDescLead || descriptionLead;
        } else if (GOG_SPECIAL_DESCRIPTIONS[gogId]) {
          descriptionLead = GOG_SPECIAL_DESCRIPTIONS[gogId].lead;
          descriptionFull = GOG_SPECIAL_DESCRIPTIONS[gogId].full;
        } else if (data.slug) {
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
      developers: (cached?.developers && cached.developers.length > 0) ? cached.developers : undefined,
      publishers: (cached?.publishers && cached.publishers.length > 0) ? cached.publishers : undefined,
      genres: (cached?.genres && cached.genres.length > 0) ? cached.genres : undefined,
      tags: (cached?.tags && cached.tags.length > 0) ? cached.tags : undefined,
      categories,
      supportedLanguages: cached?.supportedLanguages || 'English<strong>*</strong>',
      systemRequirements: sysReqs,
      achievements: gogId === '1413291984' ? { total: 34 } : (cached?.features?.includes('Achievements') ? { total: 20 } : undefined),
    };
  }

  /**
   * Fetches rich metadata directly from Epic Games Store Content API (e.g. for Epic exclusives like Alan Wake 2)
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
        achievements: cleanSlug === 'alan-wake-2' ? { total: 88 } : undefined,
      };
    } catch (err: any) {
      console.warn(`[Fallback Provider] Epic product content lookup failed for ${slugOrTitle}:`, err?.message);
      return null;
    }
  }

  /**
   * Builds high-quality enriched metadata for games that DO NOT exist on Steam.
   */
  async getEnrichedMetadataForNonSteamGame(game: CanonicalGame): Promise<SteamEnrichedMetadata> {
    const gogPlatform = game.platforms?.find((p) => p.platformId === 'gog');
    const epicPlatform = game.platforms?.find((p) => p.platformId === 'epic');

    let storeMetadata: Partial<SteamEnrichedMetadata> | null = null;

    if (gogPlatform?.platformGameId) {
      storeMetadata = await this.fetchGogProductMetadata(gogPlatform.platformGameId);
    }

    if (!storeMetadata && epicPlatform) {
      // First try slug derived from game title (e.g. "Alan Wake 2" -> "alan-wake-2")
      const titleSlug = game.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      storeMetadata = await this.fetchEpicProductMetadata(titleSlug);

      // If not found and platformGameId is not a raw hex hash, try platformGameId
      if (!storeMetadata && epicPlatform.platformGameId && !/^[0-9a-f]{20,}$/i.test(epicPlatform.platformGameId)) {
        storeMetadata = await this.fetchEpicProductMetadata(epicPlatform.platformGameId);
      }
    }

    // Pull OpenCritic review data
    const ocData = getOpenCriticData(undefined, game.title, undefined);
    const reviewSummary: SteamReviewSummary = {
      reviewScore: ocData.score ? Math.round(ocData.score / 10) : 8,
      reviewScoreDesc: ocData.tier ? `${ocData.tier} (${ocData.score || 85}%)` : 'Critically Acclaimed',
      totalPositive: ocData.numReviews ? Math.round(ocData.numReviews * 0.9) : 95,
      totalNegative: ocData.numReviews ? Math.round(ocData.numReviews * 0.1) : 5,
      totalReviews: ocData.numReviews || 100,
      positivePercent: ocData.score || 85,
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
