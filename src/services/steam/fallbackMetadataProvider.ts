import axios from 'axios';
import { CanonicalGame } from '../../contracts/game';
import { UserGameOverride } from '../../contracts/override';
import {
  SteamEnrichedMetadata,
  SteamScreenshot,
  SteamMovie,
  SteamReviewSummary,
  SteamCategory,
  SteamLanguageOption,
  LanguageTableSchema,
} from '../../contracts/steam';
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

export function stripHtmlToPlainSynopsis(rawText?: string, maxLength = 320): string {
  if (!rawText || typeof rawText !== 'string') return '';
  const clean = rawText
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/product_(?:description|feature)_\d+/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|section|article)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\/?(?:b|i|u|url|quote|img|h[1-6]|list|code|spoiler|\*)[^\]]*\]/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&trade;/gi, '™')
    .replace(/&reg;/gi, '®')
    .replace(/&copy;/gi, '©')
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return !isNaN(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return !isNaN(code) ? String.fromCharCode(code) : '';
    })
    .trim();

  if (!clean) return '';

  const paragraphs = clean
    .split(/\r?\n+/)
    .map((p) =>
      p
        .replace(/^#{1,6}\s+/, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return '';

  while (
    paragraphs.length > 1 &&
    ((paragraphs[0].length < 40 &&
      /^(about(?:\s+the\s+game|\s+this\s+game)?|overview|story|description|features|synopsis|summary|key\s+features)\b[:.\s-]*$/i.test(
        paragraphs[0]
      )) ||
      /when you buy this game\b|will be added to your gog\.com account/i.test(paragraphs[0]))
  ) {
    paragraphs.shift();
  }

  let firstPara = paragraphs[0];

  if (maxLength > 0 && firstPara.length > maxLength) {
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

export function extractFirstParagraph(rawText?: string, maxLength = 260): string | null {
  const result = stripHtmlToPlainSynopsis(rawText, maxLength);
  return result || null;
}

export function isGenericPlaceholderSynopsis(desc?: string, title?: string): boolean {
  if (!desc) return true;
  const trimmed = desc.trim();
  if (trimmed.length <= 3) return true;
  if (/product_(?:description|feature)_\d+/i.test(trimmed)) return true;
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
  if (/\bis\s+a\s+[\w,\s-]+\s+title(?:\s+developed\s+by\s+.+)?\.?$/i.test(trimmed)) return true;
  if (/\bstandard\s+steam\s+catalog\s+title\b/i.test(trimmed)) return true;
  if (/\bis\s+a\s+single-player\s+title\b/i.test(trimmed)) return true;
  return false;
}

export function cleanGogDescriptionHtml(raw?: string): string {
  if (!raw) return '';
  return raw
    .replace(/<li[^>]*>\s*product_feature_\d+\s*<\/li>/gi, '')
    .replace(/<ul[^>]*>\s*<\/ul>/gi, '')
    .replace(/product_feature_\d+/gi, '')
    .replace(/product_description_\d+/gi, '')
    .replace(/^(?:\s*<br\s*\/?>\s*)+/gi, '')
    .replace(/(?:\s*<br\s*\/?>\s*)+$/gi, '')
    .trim();
}

export const GOG_SPECIAL_DESCRIPTIONS: Record<string, { lead: string; full: string; releaseDate?: string; headerImage?: string }> = {};

export function formatDescriptionToHtml(rawDesc: string): string {
  if (!rawDesc) return '';
  const cleanedRaw = rawDesc.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!cleanedRaw) return '';
  // If already full HTML with paragraph or heading tags, return as-is
  if (cleanedRaw.includes('<p class="bb_paragraph">') || cleanedRaw.includes('<h2 class="bb_tag">')) {
    return cleanedRaw;
  }

  const lines = cleanedRaw.split(/\r?\n/);
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

export function parseGogLocalizations(
  v2Localizations?: any[],
  v1Languages?: Record<string, string>
): {
  supportedLanguages?: string;
  languageOptions?: SteamLanguageOption[];
  languageTableSchema?: LanguageTableSchema;
} {
  const byLang = new Map<string, { hasInterface: boolean; hasAudio: boolean }>();

  if (Array.isArray(v2Localizations) && v2Localizations.length > 0) {
    for (const loc of v2Localizations) {
      const langName = loc?._embedded?.language?.name;
      const scope = String(loc?._embedded?.localizationScope?.type || '').toLowerCase();
      if (!langName || typeof langName !== 'string') continue;
      const cleanName = langName.trim();
      if (!cleanName) continue;
      const entry = byLang.get(cleanName) || { hasInterface: false, hasAudio: false };
      if (scope === 'audio') {
        entry.hasAudio = true;
      } else if (scope === 'text') {
        entry.hasInterface = true;
      } else {
        entry.hasInterface = true;
      }
      byLang.set(cleanName, entry);
    }
  } else if (v1Languages && typeof v1Languages === 'object') {
    for (const langName of Object.values(v1Languages)) {
      if (typeof langName === 'string' && langName.trim()) {
        const cleanName = langName.trim();
        const entry = byLang.get(cleanName) || { hasInterface: false, hasAudio: false };
        entry.hasInterface = true;
        byLang.set(cleanName, entry);
      }
    }
  }

  if (byLang.size === 0) {
    return {};
  }

  const languageOptions: SteamLanguageOption[] = Array.from(byLang.entries()).map(
    ([name, flags]) => ({
      name,
      hasInterface: flags.hasInterface,
      hasAudio: flags.hasAudio,
      hasSubtitles: false,
    })
  );

  const audioList = languageOptions.filter((l) => l.hasAudio).map((l) => l.name);
  const textList = languageOptions.filter((l) => l.hasInterface).map((l) => l.name);
  const parts: string[] = [];
  if (audioList.length > 0) parts.push(`AUDIO: ${audioList.join(', ')}`);
  if (textList.length > 0) parts.push(`TEXT: ${textList.join(', ')}`);

  return {
    supportedLanguages: parts.join(' | '),
    languageOptions,
    languageTableSchema: 'audio_text',
  };
}

export function normalizeEpicLanguageName(raw: string): string {
  const trimmed = raw
    .replace(/^and\s+/i, '')
    .replace(/\.$/, '')
    .trim();
  if (!trimmed) return '';
  if (/^Portugu[eê]s\s*\(\s*Brasil\s*\)$/i.test(trimmed)) return 'Portuguese (Brazil)';
  if (/^Brazilian\s*-\s*Portuguese$/i.test(trimmed)) return 'Portuguese (Brazil)';
  if (/^Portuguese\s*-\s*Brazil$/i.test(trimmed)) return 'Portuguese (Brazil)';
  if (/^Spanish\s*-\s*Spain$/i.test(trimmed)) return 'Spanish (Spain)';
  if (/^Spanish\s*-\s*Latin America$/i.test(trimmed)) return 'Spanish (Latin America)';
  if (/^Chinese\s*-\s*Simplified$/i.test(trimmed)) return 'Chinese (Simplified)';
  if (/^Chinese\s*-\s*Traditional$/i.test(trimmed)) return 'Chinese (Traditional)';
  const dashMatch = trimmed.match(/^([A-Za-z]+)\s*-\s*([A-Za-z\s]+)$/);
  if (dashMatch) {
    return `${dashMatch[1].trim()} (${dashMatch[2].trim()})`;
  }
  return trimmed;
}

export function parseEpicLanguages(rawLanguages?: string[] | string): {
  supportedLanguages?: string;
  languageOptions?: SteamLanguageOption[];
  languageTableSchema?: LanguageTableSchema;
} {
  if (!rawLanguages) return {};
  const lines = (Array.isArray(rawLanguages) ? rawLanguages : [rawLanguages])
    .flatMap((entry) => (typeof entry === 'string' ? entry.split(/\r?\n|\|/) : []))
    .map((s) => s.trim())
    .filter(Boolean);

  if (lines.length === 0) return {};

  const byLang = new Map<string, { hasInterface: boolean; hasAudio: boolean }>();

  const addLangs = (csv: string, type: 'audio' | 'text' | 'both') => {
    const tokens = csv.split(/,(?![^(]*\))/);
    for (const token of tokens) {
      const name = normalizeEpicLanguageName(token);
      if (!name || /^(coming\b|tba\b|none\b|n\/a\b)/i.test(name)) continue;
      const entry = byLang.get(name) || { hasInterface: false, hasAudio: false };
      if (type === 'audio' || type === 'both') entry.hasAudio = true;
      if (type === 'text' || type === 'both') entry.hasInterface = true;
      byLang.set(name, entry);
    }
  };

  for (const line of lines) {
    if (/^coming\b/i.test(line)) continue;
    const audioMatch = line.match(/^(?:full\s+)?audio\s*(?:&\s*text)?\s*:\s*(.+)$/i);
    if (audioMatch) {
      const isBoth = /text/i.test(line.split(':')[0]);
      addLangs(audioMatch[1], isBoth ? 'both' : 'audio');
      continue;
    }
    const textMatch = line.match(/^(?:text|subtitles?|interface|text\s*&\s*subtitles?)\s*:\s*(.+)$/i);
    if (textMatch) {
      addLangs(textMatch[1], 'text');
      continue;
    }
    if (!line.includes(':')) {
      addLangs(line, 'text');
    }
  }

  if (byLang.size === 0) return {};

  const languageOptions: SteamLanguageOption[] = Array.from(byLang.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, flags]) => ({
      name,
      hasInterface: flags.hasInterface,
      hasAudio: flags.hasAudio,
      hasSubtitles: false,
    }));

  const audioList = languageOptions.filter((l) => l.hasAudio).map((l) => l.name);
  const textList = languageOptions.filter((l) => l.hasInterface).map((l) => l.name);
  const parts: string[] = [];
  if (audioList.length > 0) parts.push(`AUDIO: ${audioList.join(', ')}`);
  if (textList.length > 0) parts.push(`TEXT: ${textList.join(', ')}`);

  return {
    supportedLanguages: parts.join(' | '),
    languageOptions,
    languageTableSchema: 'audio_text',
  };
}

export class FallbackMetadataProvider {
  private getGogBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/gog-product';
    }
    return 'https://api.gog.com';
  }

  private getGogCatalogBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/gog-catalog';
    }
    return 'https://catalog.gog.com';
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
  async fetchGogProductMetadata(gogId: string, gameTitle?: string): Promise<Partial<SteamEnrichedMetadata> | null> {
    const cached = (gogEnrichedCache as Record<string, any>)[gogId];
    const special = GOG_SPECIAL_DESCRIPTIONS[gogId];

    let screenshots: SteamScreenshot[] = [];
    let movies: SteamMovie[] = [];
    let headerImage = special?.headerImage || cached?.coverHorizontal || cached?.coverVertical || '';
    let capsuleImage = cached?.coverVertical || cached?.coverHorizontal || '';
    let descriptionFull = cleanGogDescriptionHtml(
      special?.full || cached?.aboutTheGame || cached?.detailedDescription || ''
    );
    let descriptionLead = cleanGogDescriptionHtml(special?.lead || cached?.shortDescription || '');
    if (isGenericPlaceholderSynopsis(descriptionFull, gameTitle)) descriptionFull = '';
    if (isGenericPlaceholderSynopsis(descriptionLead, gameTitle)) descriptionLead = '';
    if (descriptionLead) {
      descriptionLead = extractFirstParagraph(descriptionLead) || descriptionLead;
    }

    let releaseDate = special?.releaseDate || cached?.releaseDate || 'TBA';
    let v2Devs: string[] | undefined = cached?.developers?.length ? cached.developers : undefined;
    let v2Pubs: string[] | undefined = cached?.publishers?.length ? cached.publishers : undefined;
    let v2Genres: string[] | undefined = cached?.genres?.length ? cached.genres : undefined;
    let v2Tags: string[] | undefined = cached?.tags?.length ? cached.tags : undefined;
    let v2Localizations: any[] | undefined = undefined;
    let v1Languages: Record<string, string> | undefined = undefined;

    const cleanGogId = String(gogId).replace(/^gog-/, '').trim();

    const mapGogScreenshots = (rawShots: any[]): SteamScreenshot[] =>
      rawShots
        .map((s: any, idx: number) => {
          if (typeof s === 'string') {
            const url = ensureHttps(s.replace('{formatter}', 'ggvgl_2x'));
            const thumb = ensureHttps(s.replace('{formatter}', 'ggvgm'));
            return { id: idx, pathThumbnail: thumb, pathFull: url };
          }
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
        })
        .filter((s) => Boolean(s.pathFull));

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
        if (Array.isArray(v2Data._embedded?.localizations) && v2Data._embedded.localizations.length > 0) {
          v2Localizations = v2Data._embedded.localizations;
        }
        const globalRel = v2Data._embedded?.product?.globalReleaseDate;
        if (globalRel && typeof globalRel === 'string' && releaseDate === 'TBA') {
          releaseDate = globalRel.substring(0, 10);
        }
        if (v2Data.description && typeof v2Data.description === 'string' && !descriptionFull) {
          const cleanedV2 = cleanGogDescriptionHtml(v2Data.description);
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
        if (data.screenshots && Array.isArray(data.screenshots)) {
          screenshots = mapGogScreenshots(data.screenshots);
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

        const cleanedDescFull = cleanGogDescriptionHtml(data.description?.full || data.description?.lead || '');
        const cleanedDescLead = cleanGogDescriptionHtml(data.description?.lead || '');

        const isPlaceholderDesc =
          !cleanedDescFull ||
          cleanedDescFull.length < 30 ||
          isGenericPlaceholderSynopsis(cleanedDescFull, gameTitle);

        if (!isPlaceholderDesc && cleanedDescFull) {
          descriptionFull = cleanedDescFull;
          descriptionLead = extractFirstParagraph(cleanedDescLead || cleanedDescFull) || descriptionLead || '';
        } else if (GOG_SPECIAL_DESCRIPTIONS[gogId]) {
          descriptionLead = GOG_SPECIAL_DESCRIPTIONS[gogId].lead;
          descriptionFull = GOG_SPECIAL_DESCRIPTIONS[gogId].full;
        }

        if (data.release_date && releaseDate === 'TBA') {
          releaseDate = data.release_date.substring(0, 10);
        }
      }

      // Universal GOG Catalog Product Fallback (for bundled/bonus editions whose own product ID holds a placeholder)
      if (!descriptionFull || isGenericPlaceholderSynopsis(descriptionFull, gameTitle)) {
        const lookupTitle = (gameTitle || data?.title || v2Data?._embedded?.product?.title || '').trim();
        const purchaseSlug =
          typeof data?.links?.purchase_link === 'string'
            ? data.links.purchase_link.split('/').filter(Boolean).pop()
            : undefined;

        let catProd: any = null;
        if (lookupTitle || purchaseSlug) {
          try {
            const q = lookupTitle || purchaseSlug || '';
            const catUrl = `${this.getGogCatalogBaseUrl()}/v1/catalog?query=${encodeURIComponent(q)}&limit=5&productType=in:game,pack`;
            const catRes = await axios.get(catUrl, { timeout: 6000 });
            const products = Array.isArray(catRes.data?.products) ? catRes.data.products : [];
            const normLookup = lookupTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
            catProd =
              (purchaseSlug ? products.find((p: any) => p?.slug === purchaseSlug) : null) ||
              (normLookup
                ? products.find(
                    (p: any) =>
                      String(p?.title || '')
                        .toLowerCase()
                        .replace(/[^a-z0-9]/g, '') === normLookup
                  )
                : null) ||
              products[0];
          } catch (catErr: any) {
            console.warn(
              `[Fallback Provider] GOG catalog search fallback failed for ${lookupTitle}:`,
              catErr?.message
            );
          }
        }

        if (catProd) {
          if (catProd.releaseDate && releaseDate === 'TBA') {
            releaseDate = String(catProd.releaseDate).replace(/\./g, '-').substring(0, 10);
          }
          if (!v2Devs?.length && Array.isArray(catProd.developers) && catProd.developers.length > 0) {
            v2Devs = catProd.developers;
          }
          if (!v2Pubs?.length && Array.isArray(catProd.publishers) && catProd.publishers.length > 0) {
            v2Pubs = catProd.publishers;
          }
          if (!capsuleImage && catProd.coverVertical) {
            capsuleImage = ensureHttps(catProd.coverVertical);
          }
          if (!headerImage && catProd.coverHorizontal) {
            headerImage = ensureHttps(catProd.coverHorizontal);
          }
          if (screenshots.length === 0 && Array.isArray(catProd.screenshots)) {
            screenshots = mapGogScreenshots(catProd.screenshots);
          }

          if (catProd.id && String(catProd.id) !== cleanGogId) {
            try {
              const catProdUrl = `${this.getGogBaseUrl()}/products/${encodeURIComponent(String(catProd.id))}?expand=description,screenshots,videos`;
              const catV2Url = `${this.getGogBaseUrl()}/v2/games/${encodeURIComponent(String(catProd.id))}`;
              const [catProdSettled, catV2Settled] = await Promise.allSettled([
                axios.get(catProdUrl, { timeout: 6000 }),
                !v2Localizations?.length ? axios.get(catV2Url, { timeout: 6000 }) : Promise.resolve(null),
              ]);
              const catData = catProdSettled.status === 'fulfilled' ? catProdSettled.value?.data : null;
              const catV2Data = catV2Settled.status === 'fulfilled' ? catV2Settled.value?.data : null;
              if (
                !v2Localizations?.length &&
                Array.isArray(catV2Data?._embedded?.localizations) &&
                catV2Data._embedded.localizations.length > 0
              ) {
                v2Localizations = catV2Data._embedded.localizations;
              }
              if (catData) {
                if (!v1Languages && catData.languages && typeof catData.languages === 'object') {
                  v1Languages = catData.languages;
                }
                const cleanedCatFull = cleanGogDescriptionHtml(
                  catData.description?.full || catData.description?.lead || ''
                );
                const cleanedCatLead = cleanGogDescriptionHtml(catData.description?.lead || '');
                if (
                  cleanedCatFull &&
                  cleanedCatFull.length >= 30 &&
                  !isGenericPlaceholderSynopsis(cleanedCatFull, lookupTitle)
                ) {
                  descriptionFull = cleanedCatFull;
                  descriptionLead =
                    extractFirstParagraph(cleanedCatLead || cleanedCatFull) || descriptionLead || '';
                }
                if (screenshots.length === 0 && Array.isArray(catData.screenshots)) {
                  screenshots = mapGogScreenshots(catData.screenshots);
                }
                if (movies.length === 0 && Array.isArray(catData.videos)) {
                  movies = catData.videos.map((v: any, idx: number) => ({
                    id: idx,
                    name: `Trailer ${idx + 1}`,
                    thumbnail: ensureHttps(v.thumbnail_url || ''),
                    webm: { 480: '', max: '' },
                    mp4: { 480: ensureHttps(v.video_url || ''), max: ensureHttps(v.video_url || '') },
                  }));
                }
                if (catData.release_date && releaseDate === 'TBA') {
                  releaseDate = String(catData.release_date).substring(0, 10);
                }
              }
            } catch (catProdErr: any) {
              console.warn(
                `[Fallback Provider] GOG catalog product detail lookup failed for ${catProd.id}:`,
                catProdErr?.message
              );
            }
          }
        }

        const targetSlug = purchaseSlug || catProd?.slug || data?.slug;
        if (!descriptionFull && targetSlug) {
          try {
            const pageUrl =
              typeof window !== 'undefined' && window.location.hostname === 'localhost'
                ? `/api/gog-profile/en/game/${encodeURIComponent(targetSlug)}`
                : `https://www.gog.com/en/game/${encodeURIComponent(targetSlug)}`;
            const pageRes = await axios.get(pageUrl, { timeout: 5000 });
            if (pageRes.data && typeof pageRes.data === 'string') {
              const cheerio = await import('cheerio');
              const $ = cheerio.load(pageRes.data);
              const descEl = $('.description');
              descEl.find('script, style, .description__copyrights').remove();
              const scrapedHtml = cleanGogDescriptionHtml(descEl.html()?.trim() || '');
              if (scrapedHtml && !isGenericPlaceholderSynopsis(scrapedHtml, lookupTitle)) {
                descriptionFull = scrapedHtml;
                descriptionLead =
                  extractFirstParagraph(scrapedHtml) ||
                  descEl.text()?.split('\n')[0]?.trim() ||
                  descriptionLead;
              }
            }
          } catch (scrapeErr: any) {
            console.warn(`[Fallback Provider] Store page scrape failed for ${targetSlug}:`, scrapeErr?.message);
          }
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

    const cleanGogShort = stripHtmlToPlainSynopsis(descriptionLead || descriptionFull);
    const parsedGogLangs = parseGogLocalizations(v2Localizations, v1Languages);
    const cachedSupportedLangs =
      cached?.supportedLanguages && cached.supportedLanguages !== 'English<strong>*</strong>'
        ? cached.supportedLanguages
        : undefined;

    return {
      aboutTheGame: descriptionFull,
      detailedDescription: descriptionFull,
      shortDescription: cleanGogShort,
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
      supportedLanguages:
        parsedGogLangs.supportedLanguages || cachedSupportedLangs || 'TEXT: English',
      languageOptions: parsedGogLangs.languageOptions,
      languageTableSchema: parsedGogLangs.languageTableSchema || 'audio_text',
      systemRequirements: sysReqs,
      achievements: cached?.features?.includes('Achievements') ? { total: 20 } : undefined,
    };
  }

  /**
   * Fetches rich metadata directly from Epic Games Store Catalog Offers API (via IPC) and Content API
   */
  async fetchEpicProductMetadata(
    slugOrTitle: string,
    options?: {
      appName?: string;
      namespace?: string;
      catalogItemId?: string;
      title?: string;
    }
  ): Promise<Partial<SteamEnrichedMetadata> | null> {
    let ipcMetadata: Partial<SteamEnrichedMetadata> | null = null;

    // Step 1: Official Epic Catalog Offers API via Electron IPC Bridge
    if (typeof window !== 'undefined' && (window as any).electronAPI?.fetchEpicProductMetadata) {
      try {
        const ipcData = await (window as any).electronAPI.fetchEpicProductMetadata({
          slug: slugOrTitle,
          appName: options?.appName || slugOrTitle,
          namespace: options?.namespace,
          catalogItemId: options?.catalogItemId,
          title: options?.title || slugOrTitle,
        });

        if (
          ipcData &&
          (ipcData.shortDescription ||
            ipcData.detailedDescription ||
            ipcData.aboutTheGame ||
            (Array.isArray(ipcData.screenshots) && ipcData.screenshots.length > 0) ||
            (Array.isArray(ipcData.movies) && ipcData.movies.length > 0))
        ) {
          const mappedScreenshots: SteamScreenshot[] = Array.isArray(ipcData.screenshots)
            ? (ipcData.screenshots
                .map((s: any, idx: number) => {
                  const url = typeof s === 'string' ? s : s?.pathFull || s?.url || '';
                  if (!url) return null;
                  return {
                    id: idx,
                    pathThumbnail: ensureHttps(url),
                    pathFull: ensureHttps(url),
                  };
                })
                .filter(Boolean) as SteamScreenshot[])
            : [];

          const mappedMovies: SteamMovie[] = Array.isArray(ipcData.movies)
            ? (ipcData.movies
                .map((m: any, idx: number) => {
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
                  } as SteamMovie;
                })
                .filter(Boolean) as SteamMovie[])
            : [];

          const rawAbout = (
            ipcData.aboutTheGame ||
            ipcData.detailedDescription ||
            ipcData.shortDescription ||
            ''
          )
            .replace(/<!--[\s\S]*?-->/g, '')
            .trim();
          const formattedAbout = rawAbout ? formatDescriptionToHtml(rawAbout) : '';
          const cleanShort = stripHtmlToPlainSynopsis(
            ipcData.shortDescription || rawAbout
          );

          const parsedIpcLangs = parseEpicLanguages(
            ipcData.supportedLanguages || ipcData.languages
          );

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
            screenshots: mappedScreenshots,
            movies: mappedMovies,
            ...(parsedIpcLangs.supportedLanguages
              ? { supportedLanguages: parsedIpcLangs.supportedLanguages }
              : {}),
            ...(parsedIpcLangs.languageOptions
              ? { languageOptions: parsedIpcLangs.languageOptions }
              : {}),
            languageTableSchema: 'audio_text',
            ...(ipcData.systemRequirements ? { systemRequirements: ipcData.systemRequirements } : {}),
            ...(ipcData.namespace ? { epicNamespace: ipcData.namespace } : {}),
          } as Partial<SteamEnrichedMetadata>;

          if (
            mappedMovies.length > 0 &&
            cleanShort &&
            mappedScreenshots.length > 0 &&
            Boolean(ipcMetadata.supportedLanguages)
          ) {
            return ipcMetadata;
          }
        }
      } catch (ipcErr: any) {
        console.warn(
          `[Fallback Provider] Epic IPC product lookup failed for ${slugOrTitle}:`,
          ipcErr?.message
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

      let home: any = null;
      for (const candidateSlug of slugsToTry) {
        try {
          const url =
            typeof window !== 'undefined' && window.location.hostname === 'localhost'
              ? `/api/epic-content/api/en-US/content/products/${candidateSlug}`
              : `${this.getEpicContentBaseUrl()}/api/en-US/content/products/${candidateSlug}`;

          const res = await axios.get(url, { timeout: 8000 });
          const data = res.data;
          const foundHome =
            data?.pages?.find((p: any) => p.type === 'productHome') || data?.pages?.[0];
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

      const parsedContentLangs = parseEpicLanguages(d.requirements?.languages);

      const descFull = d.about?.description || d.about?.about || d.markdown?.markdown || '';
      const formattedAbout = formatDescriptionToHtml(descFull);
      const descShort = stripHtmlToPlainSynopsis(d.about?.shortDescription || descFull);
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
        systemRequirements: {
          minimum: minReq,
          recommended: recReq,
        },
        releaseDate: d.meta?.releaseDate ? d.meta.releaseDate.substring(0, 10) : '',
        developers: d.about?.developerAttribution ? [d.about.developerAttribution] : undefined,
        publishers: d.about?.publisherAttribution ? [d.about.publisherAttribution] : undefined,
        achievements: undefined,
      };

      if (ipcMetadata) {
        const mergedScreenshots = [
          ...(ipcMetadata.screenshots || []),
          ...screenshots.filter(
            (s) => !(ipcMetadata?.screenshots || []).some((existing) => existing.pathFull === s.pathFull)
          ),
        ];
        return {
          ...contentMetadata,
          ...ipcMetadata,
          shortDescription: ipcMetadata.shortDescription || contentMetadata.shortDescription,
          detailedDescription: ipcMetadata.detailedDescription || contentMetadata.detailedDescription,
          aboutTheGame: ipcMetadata.aboutTheGame || contentMetadata.aboutTheGame,
          headerImage: ipcMetadata.headerImage || contentMetadata.headerImage,
          capsuleImage: ipcMetadata.capsuleImage || contentMetadata.capsuleImage,
          iconUrl: ipcMetadata.iconUrl || contentMetadata.iconUrl,
          screenshots: mergedScreenshots,
          movies:
            ipcMetadata.movies && ipcMetadata.movies.length > 0
              ? ipcMetadata.movies
              : contentMetadata.movies,
          supportedLanguages:
            ipcMetadata.supportedLanguages || contentMetadata.supportedLanguages,
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
    } catch (err: any) {
      console.warn(`[Fallback Provider] Epic product content lookup failed for ${slugOrTitle}:`, err?.message);
      return ipcMetadata;
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

    const lookupTitle = route?.targetTitle || override?.title || game.title;

    const epicOptions = {
      appName: epicPlatform?.platformGameId,
      namespace: (epicPlatform as any)?.namespace,
      catalogItemId: (epicPlatform as any)?.catalogItemId,
      title: lookupTitle,
    };

    let storeMetadata: Partial<SteamEnrichedMetadata> | null = null;

    // 1. Honor explicit Step 4 MetadataSourceRoute first (allows routing any game to GOG or Epic)
    if (route?.source === 'gog') {
      const targetGogId =
        route.gogId ||
        (route.matchedId ? String(route.matchedId).replace(/^gog-/, '') : undefined) ||
        gogPlatform?.platformGameId;
      if (targetGogId) {
        storeMetadata = await this.fetchGogProductMetadata(String(targetGogId), lookupTitle);
      }
    } else if (route?.source === 'epic') {
      const explicitSlug =
        route.epicSlug ||
        (route.matchedId && !/^[0-9a-f]{20,}$/i.test(String(route.matchedId))
          ? String(route.matchedId).replace(/^epic-/, '')
          : undefined);
      const titleSlug = lookupTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      if (explicitSlug) {
        storeMetadata = await this.fetchEpicProductMetadata(explicitSlug, epicOptions);
      }
      if (!storeMetadata && titleSlug) {
        storeMetadata = await this.fetchEpicProductMetadata(titleSlug, epicOptions);
      }
      if (!storeMetadata && epicPlatform?.platformGameId) {
        storeMetadata = await this.fetchEpicProductMetadata(
          epicPlatform.platformGameId,
          epicOptions
        );
      }
    }

    // 2. Fallback to platform-based or cross-store GOG/Epic IDs if not yet resolved
    if (!storeMetadata) {
      const fallbackGogId = route?.gogId || gogPlatform?.platformGameId;
      if (fallbackGogId) {
        storeMetadata = await this.fetchGogProductMetadata(String(fallbackGogId), lookupTitle);
      }
    }

    if (!storeMetadata && (epicPlatform || route?.epicSlug)) {
      const titleSlug = (route?.targetTitle || game.title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      storeMetadata = await this.fetchEpicProductMetadata(
        route?.epicSlug || titleSlug,
        epicOptions
      );

      if (!storeMetadata && epicPlatform?.platformGameId) {
        storeMetadata = await this.fetchEpicProductMetadata(
          epicPlatform.platformGameId,
          epicOptions
        );
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
          reviewScore: 0,
          reviewScoreDesc: 'No user reviews',
          totalPositive: 0,
          totalNegative: 0,
          totalReviews: 0,
          positivePercent: 0,
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

    const rawShortCandidate =
      storeMetadata?.shortDescription && !isGenericPlaceholderSynopsis(storeMetadata.shortDescription, game.title)
        ? storeMetadata.shortDescription.trim()
        : game.shortDescription && !isGenericPlaceholderSynopsis(game.shortDescription, game.title)
        ? game.shortDescription.trim()
        : firstParaDesc && !isGenericPlaceholderSynopsis(firstParaDesc, game.title)
        ? firstParaDesc
        : cleanSummary;

    const shortDescription = stripHtmlToPlainSynopsis(rawShortCandidate) || cleanSummary;

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
      supportedLanguages: storeMetadata?.supportedLanguages || 'TEXT: English',
      languageOptions: storeMetadata?.languageOptions,
      languageTableSchema: storeMetadata?.languageTableSchema || 'audio_text',
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
