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
  XboxDeliveryHints,
} from '../../contracts/steam';
import { getOpenCriticData } from '../opencritic/openCritic';
import {
  getUserOverrideForGame,
  inferMetadataRouteFromOverride,
  updateRoutedMetadataSnapshot,
} from '../storage/userOverrideStorage';
import { getSteamCategoryIconUrl } from './steamApi';
import { sanitizeStoreReleaseDate } from '../common/titleUtils';
import { escapeHtml, sanitizeStoreHtml } from '../common/htmlSanitizer';
import { requestScheduler, Priority, RequestPriority } from '../network/requestScheduler';
import gogEnrichedCache from '../storage/gogEnrichedCache.json';

export interface NonSteamMetadataFetchOptions {
  priority?: number;
  synopsisOnly?: boolean;
}

const MAX_SANITIZED_STORE_HTML_MEMO = 512;
const sanitizedStoreHtmlMemo = new Map<string, string>();

function memoizedSanitizeStoreHtml(raw: string): string {
  if (!raw) return '';
  const hit = sanitizedStoreHtmlMemo.get(raw);
  if (hit !== undefined) {
    sanitizedStoreHtmlMemo.delete(raw);
    sanitizedStoreHtmlMemo.set(raw, hit);
    return hit;
  }
  const sanitized = sanitizeStoreHtml(raw);
  if (sanitizedStoreHtmlMemo.size >= MAX_SANITIZED_STORE_HTML_MEMO) {
    const oldest = sanitizedStoreHtmlMemo.keys().next().value;
    if (oldest !== undefined) sanitizedStoreHtmlMemo.delete(oldest);
  }
  sanitizedStoreHtmlMemo.set(raw, sanitized);
  return sanitized;
}

interface GogCachedEntry {
  coverHorizontal?: string;
  coverVertical?: string;
  aboutTheGame?: string;
  detailedDescription?: string;
  shortDescription?: string;
  releaseDate?: string;
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  tags?: string[];
  categories?: Array<{ id: number; description: string }>;
  systemRequirements?: { minimum?: string; recommended?: string };
  supportedLanguages?: string;
  features?: string[];
}

interface GogLocalizationItem {
  _embedded?: {
    language?: { name?: string };
    localizationScope?: { type?: string };
  };
}

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
  };
}

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

interface EpicRequirementDetail {
  title?: string;
  minimum?: string;
  recommended?: string;
}

interface EpicProductHomePage {
  type?: string;
  data?: {
    carousel?: { items?: EpicCarouselItem[] };
    gallery?: { galleryImages?: Array<string | EpicGalleryImage> };
    requirements?: {
      systems?: Array<{ details?: EpicRequirementDetail[] }>;
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

interface RawMediaScreenshotItem {
  pathFull?: string;
  pathThumbnail?: string;
  url?: string;
}

interface RawMediaMovieItem {
  id?: number;
  name?: string;
  thumbnail?: string;
  hls?: string;
  videoUrl?: string;
  url?: string;
  mp4?: { '480'?: string; max?: string };
  webm?: { '480'?: string; max?: string };
}

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

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message?: unknown }).message || '');
  }
  return String(err || '');
}

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

function stripTrailingStorePromoClauses(plain: string): string {
  return plain
    .replace(
      /(?:\s*[-–—|•]?\s*)?(?:buy\s+[^.!\n]{1,120}?\s+drm-free(?:\s+on\s+gog\.com)?|download\s+[^.!\n]{1,120}?\s+drm-free(?:\s+on\s+gog\.com)?|when\s+you\s+buy\s+this\s+game[\s\S]*$|[\w\s:'’-]{1,80}\s+will\s+be\s+added\s+to\s+your\s+gog\.com\s+account[^.!\n]*)[.!\s]*$/gi,
      ''
    )
    .trim();
}

export function isGenericPlaceholderSynopsis(desc?: string, title?: string): boolean {
  if (!desc) return true;
  const plainRaw = desc
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plainRaw.length <= 3) return true;
  if (/product_(?:description|feature)_\d+/i.test(plainRaw)) return true;

  const trimmed = stripTrailingStorePromoClauses(plainRaw);
  if (trimmed.length <= 3) return true;
  const lower = trimmed.toLowerCase();
  if (title && lower === title.trim().toLowerCase()) return true;
  if (
    /^(?:available\s+)?(?:drm-free|store\s+exclusive|epic\s+games\s+store(?:\s+title)?|gog\.com(?:\s+title)?)(?:\s+on\s+gog\.com)?[.!\s]*$/i.test(
      trimmed
    )
  ) {
    return true;
  }
  if (/^(?:buy\s+|download\s+|get\s+)?[^.!?]{1,90}\s+(?:drm-free\s+)?on\s+gog\.com[.!\s]*$/i.test(trimmed)) {
    return true;
  }
  if (
    trimmed.length < 60 &&
    (lower.includes('drm-free') ||
      lower.includes('store exclusive') ||
      lower.includes('on gog.com') ||
      lower.includes('epic games store'))
  ) {
    return true;
  }
  if (/^(action|role-playing|adventure|shooter|strategy|simulation|racing|sports|indie)\s+experience$/i.test(trimmed)) return true;
  if (lower === 'classic title') return true;
  if (/^[a-z\s-]+ on gog\.com$/i.test(trimmed)) return true;
  if (/^dlcs?\s+(included|available)/i.test(trimmed)) return true;
  if (/^includes\s+(the\s+following\s+)?dlc/i.test(trimmed)) return true;
  if (/^bonus\s+content\s+included/i.test(trimmed)) return true;
  if (/^this\s+(package|edition|version)\s+includes/i.test(trimmed)) return true;
  if (/\bis\s+a\s+[\w,\s-]+\s+title(?:\s+developed\s+by\s+.+)?\.?$/i.test(trimmed)) return true;
  if (/\bstandard\s+steam\s+catalog\s+title\b/i.test(trimmed)) return true;
  if (/\bis\s+a\s+single-player\s+title\b/i.test(trimmed)) return true;
  return false;
}

export function cleanGogDescriptionHtml(raw?: string, synopsisOnly = false): string {
  if (!raw) return '';
  const stripped = raw
    .replace(/<li[^>]*>\s*product_feature_\d+\s*<\/li>/gi, '')
    .replace(/<ul[^>]*>\s*<\/ul>/gi, '')
    .replace(/product_feature_\d+/gi, '')
    .replace(/product_description_\d+/gi, '')
    .replace(
      /<(?:p|div)[^>]*>\s*(?:buy\s+[^<]{1,140}\s+drm-free(?:\s+on\s+gog\.com)?|when\s+you\s+buy\s+this\s+game[^<]*|[^<]*will\s+be\s+added\s+to\s+your\s+gog\.com\s+account[^<]*)[.!\s]*<\/(?:p|div)>/gi,
      ''
    )
    .replace(
      /(?:<br\s*\/?>|\r?\n)+\s*(?:buy\s+[^<\n]{1,140}\s+drm-free(?:\s+on\s+gog\.com)?|when\s+you\s+buy\s+this\s+game[^<\n]*)[.!\s]*$/gi,
      ''
    )
    .replace(/^(?:\s*<br\s*\/?>\s*)+/gi, '')
    .replace(/(?:\s*<br\s*\/?>\s*)+$/gi, '')
    .trim();
  if (!stripped) return '';
  if (synopsisOnly) {
    return stripTrailingStorePromoClauses(stripHtmlToPlainSynopsis(stripped, 420));
  }
  return /<[a-z][\s\S]*>/i.test(stripped)
    ? memoizedSanitizeStoreHtml(stripped)
    : stripTrailingStorePromoClauses(stripped);
}

export const GOG_SPECIAL_DESCRIPTIONS: Record<string, { lead: string; full: string; releaseDate?: string; headerImage?: string }> = {};

export function formatDescriptionToHtml(rawDesc: string): string {
  if (!rawDesc) return '';
  const cleanedRaw = rawDesc.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!cleanedRaw) return '';
  // If already full HTML with paragraph, heading, or block markup, sanitize untrusted store HTML directly
  if (
    cleanedRaw.includes('<p class="bb_paragraph">') ||
    cleanedRaw.includes('<h2 class="bb_tag">') ||
    /<(?:p|div|ul|ol|li|h[1-6]|br|strong|em|b|i)\b/i.test(cleanedRaw)
  ) {
    return memoizedSanitizeStoreHtml(cleanedRaw);
  }

  const lines = cleanedRaw.split(/\r?\n/);
  const htmlParts: string[] = [];
  let currentParagraph: string[] = [];

  const formatInline = (text: string): string => {
    return escapeHtml(text)
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
      htmlParts.push(`<h2 class="bb_tag">${escapeHtml(boldOnlyMatch[1].trim())}</h2>`);
      continue;
    }

    currentParagraph.push(trimmed);
  }

  flushParagraph();
  return htmlParts.join('\n');
}

export function formatGogSystemRequirements(raw?: string): string {
  if (!raw) return '';
  if (raw.includes('<strong>') || /<[a-z][\s\S]*>/i.test(raw)) {
    return memoizedSanitizeStoreHtml(raw);
  }
  let text = escapeHtml(raw);
  if (!text.startsWith('OS:')) {
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
  v2Localizations?: GogLocalizationItem[],
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
  async fetchGogProductMetadata(
    gogId: string,
    gameTitle?: string,
    fetchOptions?: NonSteamMetadataFetchOptions
  ): Promise<Partial<SteamEnrichedMetadata> | null> {
    const synopsisOnly = Boolean(fetchOptions?.synopsisOnly);
    const effectivePriority =
      fetchOptions?.priority !== undefined
        ? fetchOptions.priority
        : synopsisOnly
          ? RequestPriority.P2_BACKGROUND
          : Priority.HIGH;

    const cached = (gogEnrichedCache as Record<string, GogCachedEntry | undefined>)[gogId];
    const special = GOG_SPECIAL_DESCRIPTIONS[gogId];

    let screenshots: SteamScreenshot[] = [];
    let movies: SteamMovie[] = [];
    let headerImage = special?.headerImage || cached?.coverHorizontal || cached?.coverVertical || '';
    let capsuleImage = cached?.coverVertical || cached?.coverHorizontal || '';
    let descriptionFull = cleanGogDescriptionHtml(
      special?.full || cached?.aboutTheGame || cached?.detailedDescription || '',
      synopsisOnly
    );
    let descriptionLead = cleanGogDescriptionHtml(
      special?.lead || cached?.shortDescription || '',
      synopsisOnly
    );
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
    let v2Localizations: GogLocalizationItem[] | undefined = undefined;
    let v1Languages: Record<string, string> | undefined = undefined;

    const cleanGogId = String(gogId).replace(/^gog-/, '').trim();
    const gogGameKey = `gog:${cleanGogId}`;

    const mapGogScreenshots = (rawShots: GogRawScreenshot[]): SteamScreenshot[] =>
      rawShots
        .map((s: GogRawScreenshot, idx: number) => {
          if (typeof s === 'string') {
            const url = ensureHttps(s.replace('{formatter}', 'ggvgl_2x'));
            const thumb = ensureHttps(s.replace('{formatter}', 'ggvgm'));
            return { id: idx, pathThumbnail: thumb, pathFull: url };
          }
          const fullImg =
            s.formatted_images?.find((img) => img.formatter_name === 'ggvgl_2x')?.image_url ||
            s.formatted_images?.find((img) => img.formatter_name === 'ggvgl')?.image_url ||
            (s.formatter_template_url ? s.formatter_template_url.replace('{formatter}', 'ggvgl_2x') : '');
          const thumbImg =
            s.formatted_images?.find((img) => img.formatter_name === 'ggvgm')?.image_url || fullImg;

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
        if (Array.isArray(v2Data._embedded?.localizations) && v2Data._embedded.localizations.length > 0) {
          v2Localizations = v2Data._embedded.localizations;
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

        let catProd: GogCatalogProduct | null = null;
        if (lookupTitle || purchaseSlug) {
          try {
            const q = lookupTitle || purchaseSlug || '';
            const catUrl = `${this.getGogCatalogBaseUrl()}/v1/catalog?query=${encodeURIComponent(q)}&limit=5&productType=in:game,pack`;
            const catRes = await requestScheduler.schedule(
              `https://catalog.gog.com/v1/catalog?query=${encodeURIComponent(q)}&limit=5&productType=in:game,pack`,
              () => axios.get<{ products?: GogCatalogProduct[] }>(catUrl, { timeout: 6000 }),
              effectivePriority,
              'catalog.gog.com',
              gogGameKey
            );
            const products = Array.isArray(catRes.data?.products) ? catRes.data.products : [];
            const normLookup = lookupTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
            catProd =
              (purchaseSlug ? products.find((p) => p?.slug === purchaseSlug) || null : null) ||
              (normLookup
                ? products.find(
                    (p) =>
                      String(p?.title || '')
                        .toLowerCase()
                        .replace(/[^a-z0-9]/g, '') === normLookup
                  ) || null
                : null) ||
              products[0] ||
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
          if (!synopsisOnly && screenshots.length === 0 && Array.isArray(catProd.screenshots)) {
            screenshots = mapGogScreenshots(catProd.screenshots);
          }

          if (catProd.id && String(catProd.id) !== cleanGogId) {
            try {
              const catIdEncoded = encodeURIComponent(String(catProd.id));
              const catProdUrl = `${this.getGogBaseUrl()}/products/${catIdEncoded}?expand=description,screenshots,videos`;
              const catV2Url = `${this.getGogBaseUrl()}/v2/games/${catIdEncoded}`;
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
                if (!synopsisOnly && screenshots.length === 0 && Array.isArray(catData.screenshots)) {
                  screenshots = mapGogScreenshots(catData.screenshots);
                }
                if (!synopsisOnly && movies.length === 0 && Array.isArray(catData.videos)) {
                  movies = catData.videos.map((v: GogRawVideo, idx: number) => ({
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
            const pageUrl =
              typeof window !== 'undefined' && window.location.hostname === 'localhost'
                ? `/api/gog-profile/en/game/${encodedSlug}`
                : `https://www.gog.com/en/game/${encodedSlug}`;
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
      console.warn(`[Fallback Provider] GOG live product lookup failed for ${gogId}:`, getErrorMessage(err));
    }

    if (!synopsisOnly && screenshots.length === 0 && (cached?.coverHorizontal || cached?.coverVertical)) {
      const img = cached.coverHorizontal || cached.coverVertical;
      screenshots = [{ id: 0, pathThumbnail: ensureHttps(img), pathFull: ensureHttps(img) }];
    }

    const hasResolvedGogContent = Boolean(
      cached ||
        special ||
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
        v1Languages
    );

    if (!hasResolvedGogContent) {
      return null;
    }

    const rawCategories = synopsisOnly ? [] : cached?.categories || [];
    const categories: SteamCategory[] = rawCategories.map((c) => ({
      id: c.id,
      description: c.description,
      icon: getSteamCategoryIconUrl(c.id),
    }));

    const sysReqs = synopsisOnly
      ? {}
      : {
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
        parsedGogLangs.supportedLanguages || cachedSupportedLangs || '',
      languageOptions: parsedGogLangs.languageOptions,
      languageTableSchema: parsedGogLangs.languageTableSchema || 'audio_text',
      systemRequirements: sysReqs,
      metadataQuality: 'scraped',
      fetchedAt: Date.now(),
      achievements: undefined,
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
      priority?: number;
      synopsisOnly?: boolean;
    }
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
    if (typeof window !== 'undefined' && window.electronAPI?.fetchEpicProductMetadata) {
      try {
        const ipcData = await window.electronAPI.fetchEpicProductMetadata({
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
            ? (ipcData.screenshots as Array<string | RawMediaScreenshotItem>)
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
            ? (ipcData.movies as RawMediaMovieItem[])
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
          const cleanShort = stripHtmlToPlainSynopsis(
            ipcData.shortDescription || rawAbout
          );
          const formattedAbout = synopsisOnly
            ? cleanShort
            : rawAbout
              ? formatDescriptionToHtml(rawAbout)
              : '';

          const parsedIpcLangs = synopsisOnly
            ? {}
            : parseEpicLanguages(ipcData.supportedLanguages || ipcData.languages);

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
            ...(ipcData.namespace ? { epicNamespace: ipcData.namespace } : {}),
          } as Partial<SteamEnrichedMetadata>;

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

      const epicGameKey = `epic:${options?.appName || primarySlug || slugOrTitle}`;
      let home: EpicProductHomePage | null = null;
      for (const candidateSlug of slugsToTry) {
        try {
          const url =
            typeof window !== 'undefined' && window.location.hostname === 'localhost'
              ? `/api/epic-content/api/en-US/content/products/${candidateSlug}`
              : `${this.getEpicContentBaseUrl()}/api/en-US/content/products/${candidateSlug}`;
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

      // Extract carousel items (videos and images)
      const carouselItems = d?.carousel?.items || [];
      carouselItems.forEach((item: EpicCarouselItem, idx: number) => {
        // 1. Extract image screenshots
        const imgObj = typeof item.image === 'object' && item.image !== null ? item.image : null;
        const rawImg =
          imgObj?.src ||
          imgObj?.url ||
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
            // Ignore parse errors
          }
        }
      });

      // Also check gallery images if available
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

      const reqs = d.requirements?.systems?.[0]?.details || [];
      const minReq = reqs
        .map((r) =>
          r.title && r.minimum
            ? `<strong>${escapeHtml(String(r.title))}:</strong> ${escapeHtml(String(r.minimum))}`
            : ''
        )
        .filter(Boolean)
        .join('<br>');
      const recReq = reqs
        .map((r) =>
          r.title && r.recommended
            ? `<strong>${escapeHtml(String(r.title))}:</strong> ${escapeHtml(String(r.recommended))}`
            : ''
        )
        .filter(Boolean)
        .join('<br>');

      const parsedContentLangs = synopsisOnly
        ? {}
        : parseEpicLanguages(d.requirements?.languages);

      const descFull = d.about?.description || d.about?.about || d.markdown?.markdown || '';
      const descShort = stripHtmlToPlainSynopsis(d.about?.shortDescription || descFull);
      const formattedAbout = synopsisOnly ? descShort : formatDescriptionToHtml(descFull);
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
    } catch (err: unknown) {
      console.warn(
        `[Fallback Provider] Epic product content lookup failed for ${slugOrTitle}:`,
        getErrorMessage(err)
      );
      return ipcMetadata;
    }
  }

  /**
   * Fetches rich metadata directly from Microsoft Store DisplayCatalog via Electron IPC Bridge
   */
  async fetchXboxProductMetadata(options: {
    xboxProductId?: string;
    xboxTitleId?: string;
    packageFamilyName?: string;
    platformGameId?: string;
    title?: string;
    synopsisOnly?: boolean;
  }): Promise<Partial<SteamEnrichedMetadata> | null> {
    if (typeof window === 'undefined' || !window.electronAPI?.fetchXboxProductMetadata) {
      return null;
    }

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

      const mappedScreenshots: SteamScreenshot[] = Array.isArray(ipcData.screenshots)
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

      const mappedMovies: SteamMovie[] = Array.isArray(ipcData.movies)
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
      const cleanShort = stripHtmlToPlainSynopsis(
        ipcData.shortDescription || rawAbout
      );
      const formattedAbout = options.synopsisOnly
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
        metadataQuality: 'storefront_native',
        enrichedSource: 'xbox',
        fetchedAt: Date.now(),
      };
    } catch (err: unknown) {
      console.warn(
        `[Fallback Provider] Xbox product metadata lookup failed for ${cleanBigId || options.title}:`,
        getErrorMessage(err)
      );
      return null;
    }
  }

  /**
   * Builds high-quality enriched metadata for games that DO NOT exist on Steam
   * or are explicitly routed to a non-Steam storefront via metadataRoute.
   */
  async getEnrichedMetadataForNonSteamGame(
    game: CanonicalGame,
    explicitOverride?: UserGameOverride,
    options?: NonSteamMetadataFetchOptions
  ): Promise<SteamEnrichedMetadata> {
    const gogPlatform = game.platforms?.find((p) => p.platformId === 'gog');
    const epicPlatform = game.platforms?.find((p) => p.platformId === 'epic');
    const xboxPlatform = game.platforms?.find((p) => p.platformId === 'xbox');
    const override = explicitOverride ?? getUserOverrideForGame(game);
    const route = inferMetadataRouteFromOverride(override);

    const lookupTitle = route?.targetTitle || override?.title || game.title;

    const epicPlatformExtended = epicPlatform as
      | (typeof epicPlatform & { namespace?: string; catalogItemId?: string })
      | undefined;
    const epicOptions = {
      appName: epicPlatform?.platformGameId,
      namespace: epicPlatformExtended?.namespace,
      catalogItemId: epicPlatformExtended?.catalogItemId,
      title: lookupTitle,
      ...(options?.priority !== undefined ? { priority: options.priority } : {}),
      ...(options?.synopsisOnly !== undefined ? { synopsisOnly: options.synopsisOnly } : {}),
    };

    const routeExtended = route as
      | (typeof route & { xboxProductId?: string; source?: string })
      | undefined;
    const routedXboxId =
      routeExtended?.xboxProductId ||
      (String(route?.matchedId || '').startsWith('xbox-')
        ? String(route?.matchedId).replace(/^xbox-/, '')
        : undefined);
    const isXboxRouted =
      routeExtended?.source === 'xbox' ||
      (route?.source === 'custom' && Boolean(routedXboxId));

    let storeMetadata: Partial<SteamEnrichedMetadata> | null = null;

    // 1. Honor explicit Step 4 MetadataSourceRoute first (allows routing any game to GOG, Epic, or Xbox)
    if (route?.source === 'gog') {
      const targetGogId =
        route.gogId ||
        (route.matchedId ? String(route.matchedId).replace(/^gog-/, '') : undefined) ||
        gogPlatform?.platformGameId;
      if (targetGogId) {
        storeMetadata = options
          ? await this.fetchGogProductMetadata(String(targetGogId), lookupTitle, options)
          : await this.fetchGogProductMetadata(String(targetGogId), lookupTitle);
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
    } else if (isXboxRouted) {
      storeMetadata = await this.fetchXboxProductMetadata({
        xboxProductId: routedXboxId || xboxPlatform?.xboxProductId,
        xboxTitleId: xboxPlatform?.xboxTitleId,
        packageFamilyName: xboxPlatform?.packageFamilyName,
        platformGameId: xboxPlatform?.platformGameId,
        title: lookupTitle,
        ...(options?.synopsisOnly !== undefined ? { synopsisOnly: options.synopsisOnly } : {}),
      });
    }

    // 2. Fallback to platform-based or cross-store GOG/Epic/Xbox IDs if not yet resolved
    if (!storeMetadata) {
      const fallbackGogId = route?.gogId || gogPlatform?.platformGameId;
      if (fallbackGogId) {
        storeMetadata = options
          ? await this.fetchGogProductMetadata(String(fallbackGogId), lookupTitle, options)
          : await this.fetchGogProductMetadata(String(fallbackGogId), lookupTitle);
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

    if (!storeMetadata && xboxPlatform) {
      storeMetadata = await this.fetchXboxProductMetadata({
        xboxProductId: xboxPlatform.xboxProductId,
        xboxTitleId: xboxPlatform.xboxTitleId,
        packageFamilyName: xboxPlatform.packageFamilyName,
        platformGameId: xboxPlatform.platformGameId,
        title: lookupTitle,
        ...(options?.synopsisOnly !== undefined ? { synopsisOnly: options.synopsisOnly } : {}),
      });
    }

    // 3. Hydrate from local offline storefront DBs (galaxy-2.0.db / legendary / appinfo.vdf / MicrosoftGame.config) when live storeMetadata is unavailable
    if (
      !storeMetadata &&
      typeof window !== 'undefined' &&
      window.electronAPI?.offlineVault?.resolveLocalMetadata
    ) {
      try {
        const fallbackGogId =
          route?.gogId ||
          (route?.matchedId ? String(route.matchedId).replace(/^gog-/, '') : undefined) ||
          gogPlatform?.platformGameId;
        const localXboxProductId =
          routedXboxId ||
          xboxPlatform?.xboxProductId ||
          (/^[A-Z0-9]{12}$/i.test(String(xboxPlatform?.platformGameId || ''))
            ? xboxPlatform?.platformGameId
            : undefined);
        const localRes = await window.electronAPI.offlineVault.resolveLocalMetadata({
          gameId: game.id,
          title: game.title,
          steamAppId: game.steamAppId ?? undefined,
          gogId: fallbackGogId ? String(fallbackGogId) : undefined,
          epicAppName: epicPlatform?.platformGameId,
          xboxProductId: localXboxProductId ?? null,
          packageFamilyName: xboxPlatform?.packageFamilyName ?? null,
        });
        if (localRes?.success && localRes.metadata) {
          storeMetadata = {
            ...localRes.metadata,
            metadataQuality: localRes.metadata.metadataQuality || 'local_federated',
          };
        }
      } catch {
        // Ignore offline local federation lookup errors
      }
    }

    // 4. CRITICAL NON-CLOBBER GUARD: Never overwrite existing rich enrichedMetadata with an offline skeleton!
    if (!storeMetadata && game.enrichedMetadata) {
      const existing = game.enrichedMetadata;
      const existingAbout = existing.aboutTheGame || existing.detailedDescription || '';
      const plainAbout = stripHtmlToPlainSynopsis(existingAbout, 0);
      const hasMultiSentenceAbout =
        Boolean(plainAbout) &&
        !isGenericPlaceholderSynopsis(existingAbout, game.title) &&
        plainAbout.split(/[.!?]+\s+/).filter(Boolean).length >= 2;
      const hasRichScreenshots = (existing.screenshots?.length || 0) > 1;
      const hasNonSkeletonQuality =
        Boolean(existing.metadataQuality) && existing.metadataQuality !== 'skeleton_fallback';

      if (hasNonSkeletonQuality || hasRichScreenshots || hasMultiSentenceAbout) {
        return { ...existing };
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

    // Pull Critic review data if verified (never fabricate 90%/10% positive/negative counts)
    const ocData = getOpenCriticData(undefined, game.title);
    const reviewSummary: SteamReviewSummary =
      storeMetadata?.reviewSummary && storeMetadata.reviewSummary.totalReviews > 0
        ? storeMetadata.reviewSummary
        : ocData
        ? {
            reviewScore: Math.round(ocData.score / 10),
            reviewScoreDesc: `${ocData.tier} (${ocData.score}%)`,
            totalPositive: 0,
            totalNegative: 0,
            totalReviews: ocData.numReviews || 0,
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
        : [];

    const tags =
      (storeMetadata?.tags && storeMetadata.tags.length > 0)
        ? storeMetadata.tags
        : (game.tags && game.tags.length > 0)
        ? game.tags
        : [];

    const categories: SteamCategory[] =
      storeMetadata?.categories && storeMetadata.categories.length > 0
        ? storeMetadata.categories
        : [];

    const firstParaDesc =
      extractFirstParagraph(storeMetadata?.detailedDescription) ||
      extractFirstParagraph(storeMetadata?.aboutTheGame) ||
      extractFirstParagraph(game.shortDescription);

    const cleanSummary =
      genres.length > 0 && genres[0] !== 'Store Exclusive'
        ? `${game.title} is a ${genres.slice(0, 3).join(', ')} title${devs.length > 0 ? ` developed by ${devs[0]}` : ''}.`
        : `${game.title} is a PC library title${devs.length > 0 ? ` developed by ${devs[0]}` : ''}.`;

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

    const resolvedQuality = storeMetadata
      ? storeMetadata.metadataQuality || 'scraped'
      : 'skeleton_fallback';

    const preservedXboxHints =
      storeMetadata?.xboxDeliveryHints || game.enrichedMetadata?.xboxDeliveryHints;

    return {
      appId: storeMetadata?.appId ?? 0,
      name: storeMetadata?.name || game.title,
      shortDescription,
      detailedDescription,
      aboutTheGame: storeMetadata?.aboutTheGame || detailedDescription,
      headerImage: ensureHttps(storeMetadata?.headerImage || game.headerImage),
      capsuleImage: ensureHttps(storeMetadata?.capsuleImage || game.capsuleImage || storeMetadata?.headerImage || game.headerImage),
      iconUrl: ensureHttps(storeMetadata?.iconUrl || game.iconUrl || ''),
      developers: devs,
      publishers: pubs,
      releaseDate:
        sanitizeStoreReleaseDate(storeMetadata?.releaseDate) ||
        sanitizeStoreReleaseDate(game.releaseDate) ||
        'TBA',
      genres,
      tags,
      categories,
      supportedLanguages: storeMetadata?.supportedLanguages || '',
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
      macRequirements: storeMetadata?.macRequirements,
      linuxRequirements: storeMetadata?.linuxRequirements,
      extUserAccountNotice: storeMetadata?.extUserAccountNotice,
      website: storeMetadata?.website,
      metadataQuality: resolvedQuality,
      ...(storeMetadata?.enrichedSource ? { enrichedSource: storeMetadata.enrichedSource } : {}),
      ...(preservedXboxHints ? { xboxDeliveryHints: preservedXboxHints } : {}),
      fetchedAt: storeMetadata?.fetchedAt || Date.now(),
      reviewSummary,
      achievements: storeMetadata?.achievements,
    };
  }
}

export const fallbackMetadataProvider = new FallbackMetadataProvider();
