/**
 * Shared non-Steam storefront HTML/Markdown description, system-requirement, and
 * localization formatters + placeholder/boilerplate detectors.
 */

import {
  LanguageTableSchema,
  SteamLanguageOption,
  SteamSystemRequirements,
} from '../../../contracts/steam';
import { decodeHtmlEntities } from '../../common/htmlEntities';
import { escapeHtml, sanitizeStoreHtml } from '../../common/htmlSanitizer';
import { LruMap } from '../../common/lruMap';
import { stripHtmlToPlainSynopsis } from '../../common/synopsisTextUtils';

export interface GogLocalizationItem {
  _embedded?: {
    language?: { name?: string };
    localizationScope?: { type?: string };
  };
}

export interface GogSupportedOperatingSystem {
  operatingSystem?: { name?: string; versions?: string };
  systemRequirements?: Array<{
    type?: string;
    description?: string;
    requirements?: Array<{ id?: string; name?: string; description?: string }>;
  }>;
}

export interface EpicRequirementDetail {
  title?: string;
  minimum?: string;
  recommended?: string;
}

export interface EpicRequirementSystem {
  systemType?: string;
  details?: EpicRequirementDetail[];
}

export interface RawMediaScreenshotItem {
  pathFull?: string;
  pathThumbnail?: string;
  url?: string;
}

export interface RawMediaMovieItem {
  id?: number;
  name?: string;
  thumbnail?: string;
  hls?: string;
  videoUrl?: string;
  url?: string;
  mp4?: { '480'?: string; max?: string };
  webm?: { '480'?: string; max?: string };
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message?: unknown }).message || '');
  }
  return String(err || '');
}

export function ensureHttps(url?: string): string {
  if (!url) return '';
  const trimmed = url.trim();
  if (trimmed.startsWith('//')) return 'https:' + trimmed;
  return trimmed;
}

const MAX_SANITIZED_STORE_HTML_MEMO = 512;
const MAX_SYNOPSIS_MEMO_ENTRIES = 4096;
const MAX_SYNOPSIS_MEMO_INPUT_LEN = 16_384;

const sanitizedStoreHtmlMemo = new LruMap<string, string>(MAX_SANITIZED_STORE_HTML_MEMO);
const storeBoilerplateMemo = new LruMap<string, string>(MAX_SYNOPSIS_MEMO_ENTRIES);
const genericPlaceholderSynopsisMemo = new LruMap<string, boolean>(MAX_SYNOPSIS_MEMO_ENTRIES);
const cleanGogHtmlMemo = new LruMap<string, string>(MAX_SYNOPSIS_MEMO_ENTRIES);

export function memoizedSanitizeStoreHtml(raw: string): string {
  if (!raw) return '';
  const hit = sanitizedStoreHtmlMemo.get(raw);
  if (hit !== undefined) {
    return hit;
  }
  const sanitized = sanitizeStoreHtml(raw);
  sanitizedStoreHtmlMemo.set(raw, sanitized);
  return sanitized;
}

export function stripStoreBoilerplate(plain: string): string {
  if (!plain) return '';
  const canMemo = plain.length <= MAX_SYNOPSIS_MEMO_INPUT_LEN;
  if (canMemo) {
    const hit = storeBoilerplateMemo.get(plain);
    if (hit !== undefined) return hit;
  }
  const stripped = plain
    .replace(
      /(?:\s*[-–—|•]?\s*)?(?:buy\s+[^.!\n]{1,120}?\s+drm-free(?:\s+on\s+gog\.com)?|download\s+[^.!\n]{1,120}?\s+drm-free(?:\s+on\s+gog\.com)?|when\s+you\s+buy\s+this\s+game[\s\S]*$|[\w\s:'’-]{1,80}\s+will\s+be\s+added\s+to\s+your\s+gog\.com\s+account[^.!\n]*)[.!\s]*$/gi,
      ''
    )
    .trim();
  if (canMemo) {
    storeBoilerplateMemo.set(plain, stripped);
  }
  return stripped;
}

export function isGenericPlaceholderSynopsis(desc?: string, title?: string): boolean {
  if (!desc) return true;
  const canMemo = desc.length <= MAX_SYNOPSIS_MEMO_INPUT_LEN && (!title || title.length <= 512);
  const memoKey = canMemo ? `${title ? title.trim().toLowerCase() : ''}\u0000${desc}` : '';
  if (canMemo) {
    const hit = genericPlaceholderSynopsisMemo.get(memoKey);
    if (hit !== undefined) return hit;
  }

  const compute = (): boolean => {
    const plainRaw = desc
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (plainRaw.length <= 3) return true;
    if (/product_(?:description|feature)_\d+/i.test(plainRaw)) return true;

    const trimmed = stripStoreBoilerplate(plainRaw);
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
    if (
      /^(?:buy\s+|download\s+|get\s+)?[^.!?]{1,90}\s+(?:drm-free\s+)?on\s+gog\.com[.!\s]*$/i.test(
        trimmed
      )
    ) {
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
    if (
      /^(action|role-playing|adventure|shooter|strategy|simulation|racing|sports|indie)\s+experience$/i.test(
        trimmed
      )
    ) {
      return true;
    }
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
  };

  const result = compute();
  if (canMemo) {
    genericPlaceholderSynopsisMemo.set(memoKey, result);
  }
  return result;
}

export function cleanGogDescriptionHtml(raw?: string, synopsisOnly = false): string {
  if (!raw) return '';
  const canMemo = raw.length <= MAX_SYNOPSIS_MEMO_INPUT_LEN;
  const memoKey = canMemo ? `${synopsisOnly ? '1' : '0'}\u0000${raw}` : '';
  if (canMemo) {
    const hit = cleanGogHtmlMemo.get(memoKey);
    if (hit !== undefined) return hit;
  }

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
  if (!stripped) {
    if (canMemo) cleanGogHtmlMemo.set(memoKey, '');
    return '';
  }
  const result = synopsisOnly
    ? stripStoreBoilerplate(stripHtmlToPlainSynopsis(stripped, 420))
    : /<[a-z][\s\S]*>/i.test(stripped)
      ? memoizedSanitizeStoreHtml(stripped)
      : stripStoreBoilerplate(stripped);
  if (canMemo) {
    cleanGogHtmlMemo.set(memoKey, result);
  }
  return result;
}

export function formatDescriptionToHtml(rawDesc: string): string {
  if (!rawDesc) return '';
  const cleanedRaw = rawDesc.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!cleanedRaw) return '';
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

function normalizeRequirementFieldValue(raw?: string): string {
  if (!raw || typeof raw !== 'string') return '';
  const withLineBreaks = raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li)>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '');
  const decoded = decodeHtmlEntities(withLineBreaks, { asciiQuotes: true });
  const lines = decoded
    .split(/\r?\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return lines.map((line) => escapeHtml(line)).join('<br>');
}

export function extractGogRequirementsByOs(
  supportedOperatingSystems?: GogSupportedOperatingSystem[]
): {
  systemRequirements?: SteamSystemRequirements;
  macRequirements?: SteamSystemRequirements;
  linuxRequirements?: SteamSystemRequirements;
} {
  if (!Array.isArray(supportedOperatingSystems) || supportedOperatingSystems.length === 0) {
    return {};
  }

  let systemRequirements: SteamSystemRequirements | undefined;
  let macRequirements: SteamSystemRequirements | undefined;
  let linuxRequirements: SteamSystemRequirements | undefined;

  for (const osEntry of supportedOperatingSystems) {
    const osName = String(osEntry?.operatingSystem?.name || '').trim();
    if (!osName) continue;
    const reqBlocks = Array.isArray(osEntry?.systemRequirements)
      ? osEntry.systemRequirements
      : [];
    if (reqBlocks.length === 0) continue;

    let minHtml = '';
    let recHtml = '';

    for (const block of reqBlocks) {
      const reqType = String(block?.type || '').trim().toLowerCase();
      const structuredItems = Array.isArray(block?.requirements) ? block.requirements : [];
      let formattedBlock = '';
      if (structuredItems.length > 0) {
        formattedBlock = structuredItems
          .map((item) => {
            const label = normalizeRequirementFieldValue(item?.name).replace(/:$/, '');
            const desc = normalizeRequirementFieldValue(item?.description);
            if (label && desc) return `<strong>${label}:</strong> ${desc}`;
            return desc || '';
          })
          .filter(Boolean)
          .join('<br>');
      }
      if (!formattedBlock && typeof block?.description === 'string' && block.description.trim()) {
        formattedBlock = formatGogSystemRequirements(block.description.trim());
      }
      if (!formattedBlock) continue;

      if (reqType === 'recommended') {
        if (!recHtml) recHtml = formattedBlock;
      } else {
        if (!minHtml) minHtml = formattedBlock;
      }
    }

    if (!minHtml && !recHtml) continue;
    const parsed: SteamSystemRequirements = {
      ...(minHtml ? { minimum: minHtml } : {}),
      ...(recHtml ? { recommended: recHtml } : {}),
    };

    if (/^(?:osx|mac)/i.test(osName)) {
      if (!macRequirements) macRequirements = parsed;
    } else if (/^linux/i.test(osName)) {
      if (!linuxRequirements) linuxRequirements = parsed;
    } else if (/^win/i.test(osName)) {
      if (!systemRequirements) systemRequirements = parsed;
    }
  }

  return {
    ...(systemRequirements ? { systemRequirements } : {}),
    ...(macRequirements ? { macRequirements } : {}),
    ...(linuxRequirements ? { linuxRequirements } : {}),
  };
}

export function extractEpicRequirementsByOs(
  systems?: EpicRequirementSystem[]
): {
  systemRequirements?: SteamSystemRequirements;
  macRequirements?: SteamSystemRequirements;
  linuxRequirements?: SteamSystemRequirements;
} {
  if (!Array.isArray(systems) || systems.length === 0) {
    return {};
  }

  let systemRequirements: SteamSystemRequirements | undefined;
  let macRequirements: SteamSystemRequirements | undefined;
  let linuxRequirements: SteamSystemRequirements | undefined;
  let fallbackRequirements: SteamSystemRequirements | undefined;

  for (const sys of systems) {
    const details = Array.isArray(sys?.details) ? sys.details : [];
    if (details.length === 0) continue;

    const minHtml = details
      .map((r) => {
        const title = normalizeRequirementFieldValue(r?.title).replace(/:$/, '');
        const min = normalizeRequirementFieldValue(r?.minimum);
        return title && min ? `<strong>${title}:</strong> ${min}` : '';
      })
      .filter(Boolean)
      .join('<br>');
    const recHtml = details
      .map((r) => {
        const title = normalizeRequirementFieldValue(r?.title).replace(/:$/, '');
        const rec = normalizeRequirementFieldValue(r?.recommended);
        return title && rec ? `<strong>${title}:</strong> ${rec}` : '';
      })
      .filter(Boolean)
      .join('<br>');

    if (!minHtml && !recHtml) continue;
    const parsed: SteamSystemRequirements = {
      ...(minHtml ? { minimum: minHtml } : {}),
      ...(recHtml ? { recommended: recHtml } : {}),
    };

    const sysType = String(sys?.systemType || '').trim();
    if (/mac|osx|darwin/i.test(sysType)) {
      if (!macRequirements) macRequirements = parsed;
    } else if (/linux|ubuntu|steam\s*os/i.test(sysType)) {
      if (!linuxRequirements) linuxRequirements = parsed;
    } else if (/win/i.test(sysType)) {
      if (!systemRequirements) systemRequirements = parsed;
    } else if (!fallbackRequirements) {
      fallbackRequirements = parsed;
    }
  }

  if (!systemRequirements && fallbackRequirements) {
    systemRequirements = fallbackRequirements;
  }

  return {
    ...(systemRequirements ? { systemRequirements } : {}),
    ...(macRequirements ? { macRequirements } : {}),
    ...(linuxRequirements ? { linuxRequirements } : {}),
  };
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
    .toSorted((a, b) => a[0].localeCompare(b[0]))
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
