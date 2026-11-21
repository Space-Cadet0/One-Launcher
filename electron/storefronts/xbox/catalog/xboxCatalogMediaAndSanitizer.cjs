'use strict';

/**
 * Xbox DisplayCatalog Media Normalization, Rich Trailer/Capability Extraction,
 * Hardened Balanced Description HTML Sanitizer, Release Date Sanitizer,
 * Title Disambiguator Stripper & Canonical SCID Derivation.
 */

const xboxConfigAndIds = require('../xboxConfigAndIds.cjs');

const RELEVANT_IMAGE_PURPOSES = new Set([
  'poster',
  'superheroart',
  'titledheroart',
  'featurepromotionalsquareart',
  'boxart',
  'tile',
  'appicon',
  'logo',
  'screenshot',
]);

const DISPLAY_CATALOG_CAPABILITY_MAP = Object.freeze({
  singleplayer: 'Single-player',
  xblonlinemultiplayer: 'Online PvP / Multiplayer',
  onlinemultiplayerwithgold: 'Online PvP / Multiplayer',
  xblonlinecoop: 'Online Co-op',
  xbllocalcoop: 'Shared/Split Screen Co-op',
  xbllocalmultiplayer: 'Shared/Split Screen PvP',
  xblcrossplatformmultiplayer: 'Cross-Platform Multiplayer',
  xblcrossplatformcoop: 'Cross-Platform Co-op',
  xblachievements: 'Xbox Achievements',
  xblpresence: 'Xbox Achievements',
  xblcloudsaves: 'Xbox Cloud Saves',
  xpa: 'Xbox Play Anywhere',
  pcgamepad: 'Full controller support',
  consolegamepad: 'Full controller support',
  consolekeyboardmouse: 'Keyboard & Mouse Support',
  capability4k: '4K Ultra HD',
  '4kultrahd': '4K Ultra HD',
  capabilityhdr: 'HDR',
  hdr: 'HDR',
  '60fps': 'High Frame Rate',
  '120fps': 'High Frame Rate',
  capabilityvrr: 'Variable Refresh Rate',
  raytracing: 'Ray Tracing',
});

const SAFE_DESCRIPTION_HTML_TAGS = new Set([
  'p',
  'div',
  'span',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'b',
  'i',
  'u',
  'blockquote',
  'code',
  'pre',
  'video',
  'source',
  'img',
  'a',
]);

const VOID_DESCRIPTION_HTML_TAGS = new Set(['br', 'hr', 'img', 'source']);
const SAFE_MEDIA_BOOLEAN_ATTRS = new Set([
  'controls',
  'autoplay',
  'loop',
  'muted',
  'playsinline',
]);
const SAFE_TEXT_ATTRS = new Set(['alt', 'title', 'type', 'preload', 'width', 'height']);
const ALLOWED_DESCRIPTION_CLASS_TOKEN_RE = /^(?:bb_[a-z0-9_-]+|steam_[a-z0-9_-]+|lead)$/i;
const MAX_HTML_NESTING_DEPTH = 32;

const NATURAL_PC_PREDECESSOR_RE =
  /(?:^|\s)(?:my|your|our|the|his|her|its|a|an|this|that|new|old|custom|virtual|retro|mini|pocket|super|dream|ultimate|gaming|home|office|build\s+a)\s+pc$/i;
const NATURAL_WINDOWS_PREDECESSOR_RE =
  /(?:^|\s)(?:the|of|in|into|through|behind|between|beyond|under|over|from|with|without|two|three|four|many|broken|stained|open|closed|shattered|dark|rear|glass)\s+windows$/i;

function isPrivateOrLoopbackHostname(rawHost) {
  const host = String(rawHost || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.arpa')
  ) {
    return true;
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1);
    if (
      inner === '::1' ||
      inner === '::' ||
      inner.startsWith('fe80:') ||
      inner.startsWith('fc') ||
      inner.startsWith('fd') ||
      inner.startsWith('::ffff:127.') ||
      inner.startsWith('::ffff:10.') ||
      inner.startsWith('::ffff:192.168.') ||
      inner.startsWith('::ffff:169.254.')
    ) {
      return true;
    }
    return false;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (/^(?:\d+|0x[0-9a-f]+)$/i.test(host)) {
    return true;
  }
  return false;
}

function isSafeDescriptionHttpsUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed || trimmed.length > 2048 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.port) return false;
    if (isPrivateOrLoopbackHostname(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function selectPreferredLocalizedEntry(localizedList) {
  if (!Array.isArray(localizedList) || localizedList.length === 0) return {};
  const validEntries = localizedList.filter((l) => l && typeof l === 'object');
  if (validEntries.length === 0) return {};

  const primary = validEntries[0];
  const base =
    validEntries.find((l) => typeof l.ProductTitle === 'string' && l.ProductTitle.trim()) ||
    primary;
  if (validEntries.length === 1) return base;

  const baseImages = Array.isArray(base.Images) ? base.Images : [];
  const basePurposes = new Set();
  const seenImageUris = new Set();
  for (const img of baseImages) {
    if (!img || !img.Uri) continue;
    seenImageUris.add(String(img.Uri));
    const p = String(img.ImagePurpose || '').trim().toLowerCase();
    if (p) basePurposes.add(p);
  }

  let mergedImages = baseImages;
  for (const entry of validEntries) {
    if (entry === base || !Array.isArray(entry.Images) || entry.Images.length === 0) continue;
    for (const img of entry.Images) {
      if (!img || !img.Uri) continue;
      const uriStr = String(img.Uri);
      const purposeLower = String(img.ImagePurpose || '').trim().toLowerCase();
      if (!basePurposes.has(purposeLower) && !seenImageUris.has(uriStr)) {
        if (mergedImages === baseImages) {
          mergedImages = [...baseImages];
        }
        seenImageUris.add(uriStr);
        mergedImages.push(img);
      }
    }
  }

  const withShortDesc = !base.ShortDescription
    ? validEntries.find((l) => typeof l.ShortDescription === 'string' && l.ShortDescription.trim())
    : null;
  const withProdDesc = !base.ProductDescription
    ? validEntries.find(
        (l) => typeof l.ProductDescription === 'string' && l.ProductDescription.trim()
      )
    : null;
  const withDev = !base.DeveloperName
    ? validEntries.find((l) => typeof l.DeveloperName === 'string' && l.DeveloperName.trim())
    : null;
  const withPub = !base.PublisherName
    ? validEntries.find((l) => typeof l.PublisherName === 'string' && l.PublisherName.trim())
    : null;
  const withCmsVideos =
    !Array.isArray(base.CMSVideos) || base.CMSVideos.length === 0
      ? validEntries.find((l) => Array.isArray(l.CMSVideos) && l.CMSVideos.length > 0)
      : null;
  const withLegacyVideos =
    !Array.isArray(base.Videos) || base.Videos.length === 0
      ? validEntries.find((l) => Array.isArray(l.Videos) && l.Videos.length > 0)
      : null;

  if (
    mergedImages === baseImages &&
    !withShortDesc &&
    !withProdDesc &&
    !withDev &&
    !withPub &&
    !withCmsVideos &&
    !withLegacyVideos
  ) {
    return base;
  }

  return {
    ...base,
    ...(withShortDesc ? { ShortDescription: withShortDesc.ShortDescription } : {}),
    ...(withProdDesc ? { ProductDescription: withProdDesc.ProductDescription } : {}),
    ...(withDev ? { DeveloperName: withDev.DeveloperName } : {}),
    ...(withPub ? { PublisherName: withPub.PublisherName } : {}),
    ...(mergedImages !== baseImages ? { Images: mergedImages } : {}),
    ...(withCmsVideos ? { CMSVideos: withCmsVideos.CMSVideos } : {}),
    ...(withLegacyVideos ? { Videos: withLegacyVideos.Videos } : {}),
  };
}

function normalizeStoreImageUrl(rawUri, querySuffix = '') {
  if (!rawUri || typeof rawUri !== 'string') return '';
  let url = rawUri.trim();
  if (!url) return '';
  if (url.startsWith('//')) {
    url = `https:${url}`;
  } else if (url.startsWith('http://')) {
    url = `https://${url.slice(7)}`;
  }
  if (!/^https:\/\//i.test(url)) return '';
  if (querySuffix && !url.includes('?')) {
    return `${url}${querySuffix}`;
  }
  return url;
}

function normalizeDisplayCatalogMediaUrl(rawUri) {
  if (!rawUri || typeof rawUri !== 'string') return '';
  let url = rawUri.trim();
  if (!url) return '';
  if (url.startsWith('//')) {
    url = `https:${url}`;
  } else if (url.startsWith('http://')) {
    url = `https://${url.slice(7)}`;
  }
  if (!/^https:\/\//i.test(url)) return '';
  return url;
}

function normalizeDisplayCatalogImageUri(rawUri, defaultSizingQuery = '?w=1280&h=720&q=85') {
  const base = normalizeDisplayCatalogMediaUrl(rawUri);
  if (!base) return '';
  if (!defaultSizingQuery) return base;
  try {
    const parsed = new URL(base);
    if (
      parsed.hostname.toLowerCase().endsWith('s-microsoft.com') &&
      !parsed.searchParams.has('w') &&
      !parsed.searchParams.has('h')
    ) {
      const cleanQuery = defaultSizingQuery.replace(/^[?&]/, '');
      return `${base}${base.includes('?') ? '&' : '?'}${cleanQuery}`;
    }
  } catch {}
  return base;
}

/**
 * Extracts official HLS (`.m3u8`) and MP4 trailer streams from Microsoft DisplayCatalog
 * `LocalizedProperties[0].CMSVideos` and `LocalizedProperties[0].Videos`.
 *
 * Sorts `HeroTrailer` first, then `Trailer`, then ascending numeric `SortOrder` (fallback `999`),
 * deduplicating by canonical stream URL and emitting `SteamMovie`-compatible objects.
 */
function extractDisplayCatalogMovies(localProps, fallbackThumbnail = '') {
  if (!localProps || typeof localProps !== 'object') return [];
  const cmsVideos = Array.isArray(localProps.CMSVideos) ? localProps.CMSVideos : [];
  const legacyVideos = Array.isArray(localProps.Videos) ? localProps.Videos : [];
  const combined = [...cmsVideos, ...legacyVideos];
  if (combined.length === 0) return [];

  const candidates = [];
  for (let i = 0; i < combined.length; i++) {
    const v = combined[i];
    if (!v || typeof v !== 'object') continue;

    const rawHls = normalizeDisplayCatalogMediaUrl(v.HLS || v.Hls || '');
    const rawUri = normalizeDisplayCatalogMediaUrl(v.URI || v.Uri || '');

    const hlsUrl = rawHls || (/\.m3u8(?:$|[?#])/i.test(rawUri) ? rawUri : '');
    const mp4Url = /\.mp4(?:$|[?#])/i.test(rawUri) ? rawUri : '';
    if (!hlsUrl && !mp4Url) continue;

    const purposeRaw = String(v.VideoPurpose || v.Purpose || '').trim();
    const purposeLower = purposeRaw.toLowerCase();
    const purposeRank =
      purposeLower === 'herotrailer' ? 0 : purposeLower === 'trailer' ? 1 : 2;
    const numericSort = Number(v.SortOrder);
    const sortOrder = Number.isFinite(numericSort) ? numericSort : 999;

    const thumb =
      normalizeDisplayCatalogImageUri(
        v.PreviewImage?.Uri || v.PreviewImage?.URI || v.Image?.Uri || v.Image?.URI || '',
        '?w=1280&h=720&q=85'
      ) || fallbackThumbnail || '';

    const name =
      String(v.VideoPositionInfo || v.Title || purposeRaw || 'Trailer').trim() || 'Trailer';

    candidates.push({
      originalIdx: i,
      purposeRank,
      sortOrder,
      name,
      thumbnail: thumb,
      hlsUrl,
      mp4Url,
    });
  }

  candidates.sort((a, b) => {
    if (a.purposeRank !== b.purposeRank) return a.purposeRank - b.purposeRank;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.originalIdx - b.originalIdx;
  });

  const seenStreams = new Set();
  const movies = [];
  for (const cand of candidates) {
    const hlsKey = cand.hlsUrl ? cand.hlsUrl.toLowerCase() : '';
    const mp4Key = cand.mp4Url ? cand.mp4Url.toLowerCase() : '';
    if ((hlsKey && seenStreams.has(hlsKey)) || (mp4Key && seenStreams.has(mp4Key))) {
      continue;
    }
    if (hlsKey) seenStreams.add(hlsKey);
    if (mp4Key) seenStreams.add(mp4Key);

    const idx = movies.length;
    movies.push({
      id: 100000 + idx,
      name: cand.name,
      thumbnail: cand.thumbnail,
      ...(cand.hlsUrl ? { hls: cand.hlsUrl } : {}),
      ...(cand.mp4Url ? { mp4: { max: cand.mp4Url, 480: cand.mp4Url } } : {}),
    });
  }

  return movies;
}

/**
 * Maps Microsoft Store `Properties.Attributes` capability flags (plus `XboxLiveGoldRequired`)
 * into deduplicated `SteamCategory`-compatible `{ id, description }` chips.
 */
function extractDisplayCatalogCategories(product) {
  if (!product || typeof product !== 'object') return [];
  const props = product.Properties || {};
  const attrs = Array.isArray(props.Attributes) ? props.Attributes : [];

  const descriptions = [];
  const seen = new Set();
  const pushLabel = (label) => {
    if (!label || seen.has(label)) return;
    seen.add(label);
    descriptions.push(label);
  };

  for (const attr of attrs) {
    const rawName = typeof attr === 'string' ? attr : attr?.Name;
    if (!rawName || typeof rawName !== 'string') continue;
    const mapped = DISPLAY_CATALOG_CAPABILITY_MAP[rawName.trim().toLowerCase()];
    if (mapped) {
      pushLabel(mapped);
    }
  }

  if (props.XboxLiveGoldRequired === true) {
    pushLabel('Online PvP / Multiplayer');
  }

  return descriptions.map((description, idx) => ({
    id: idx + 1,
    description,
  }));
}

function sanitizeDescriptionTagAttributes(tagLower, rawAttrs, escapeHtml) {
  if (!rawAttrs || !rawAttrs.trim()) return { attrStr: '', hasValidMediaSrc: false };
  const sanitizedPairs = [];
  let hasValidMediaSrc = false;
  let hasHref = false;
  const attrRegex = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = attrRegex.exec(rawAttrs)) !== null) {
    const attrName = String(m[1] || '').toLowerCase();
    if (
      !attrName ||
      attrName.startsWith('on') ||
      attrName.startsWith('data-') ||
      attrName === 'style' ||
      attrName === 'srcdoc' ||
      attrName === 'srcset' ||
      attrName === 'formaction'
    ) {
      continue;
    }
    const rawVal =
      m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : null;
    if (attrName === 'class') {
      if (rawVal !== null) {
        const safeClasses = rawVal
          .trim()
          .split(/\s+/)
          .filter((tok) => tok && ALLOWED_DESCRIPTION_CLASS_TOKEN_RE.test(tok));
        if (safeClasses.length > 0) {
          sanitizedPairs.push(`class="${escapeHtml(safeClasses.join(' '))}"`);
        }
      }
      continue;
    }
    if (attrName === 'src' || attrName === 'poster' || attrName === 'href') {
      if (rawVal !== null) {
        const trimmedUrl = rawVal.trim();
        const attrAllowedOnTag =
          (attrName === 'href' && tagLower === 'a') ||
          (attrName === 'src' && (tagLower === 'img' || tagLower === 'video' || tagLower === 'source')) ||
          (attrName === 'poster' && tagLower === 'video');
        if (attrAllowedOnTag && isSafeDescriptionHttpsUrl(trimmedUrl)) {
          sanitizedPairs.push(`${attrName}="${escapeHtml(trimmedUrl)}"`);
          if (attrName === 'src') hasValidMediaSrc = true;
          if (attrName === 'href') hasHref = true;
        }
      }
      continue;
    }
    if (SAFE_MEDIA_BOOLEAN_ATTRS.has(attrName) && (tagLower === 'video' || tagLower === 'source')) {
      sanitizedPairs.push(attrName);
      continue;
    }
    if (SAFE_TEXT_ATTRS.has(attrName) && rawVal !== null && rawVal.length <= 200) {
      if ((attrName === 'width' || attrName === 'height') && !/^\d{1,4}$/.test(rawVal.trim())) {
        continue;
      }
      if (attrName === 'preload' && !/^(?:none|metadata|auto)$/i.test(rawVal.trim())) {
        continue;
      }
      sanitizedPairs.push(`${attrName}="${escapeHtml(rawVal)}"`);
    }
  }
  if (tagLower === 'a' && hasHref) {
    sanitizedPairs.push('rel="noopener noreferrer"');
  }
  return {
    attrStr: sanitizedPairs.length > 0 ? ` ${sanitizedPairs.join(' ')}` : '',
    hasValidMediaSrc,
  };
}

/**
 * Formats plain-text Microsoft Store `ProductDescription` synopses into clean semantic HTML
 * while strictly sanitizing pre-existing HTML descriptions against XSS, UI-redressing classes,
 * unsafe/private URLs, and unbalanced tag breakouts.
 */
function formatPlainDescriptionToHtml(text) {
  if (!text || typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';

  const escapeHtml = (str) =>
    String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  if (
    /<\/?(?:p|div|span|br|hr|h[1-6]|ul|ol|li|strong|em|b|i|u|blockquote|code|pre|img|video|source|a|script|style|iframe|svg|object|embed|form|math|template|noscript)\b|<!--/i.test(
      trimmed
    )
  ) {
    // Strip HTML comments, processing instructions, and dangerous container elements (including unclosed)
    const withoutDangerousBlocks = trimmed
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<!--[\s\S]*$/g, '')
      .replace(/<\?[\s\S]*?\?>/g, '')
      .replace(
        /<(script|style|iframe|object|embed|svg|math|form|template|noscript|textarea|title)\b[\s\S]*?<\/\1\s*>/gi,
        ''
      )
      .replace(
        /<(script|style|iframe|object|embed|svg|math|form|template|noscript|textarea|title)\b[\s\S]*$/gi,
        ''
      );

    const tagRegex = /<(\/?)([a-zA-Z0-9]+)(\s[^<>]*?)?(\/?)>/g;
    let out = '';
    let lastIndex = 0;
    /** @type {string[]} */
    const openTagStack = [];
    let match;
    while ((match = tagRegex.exec(withoutDangerousBlocks)) !== null) {
      if (match.index > lastIndex) {
        out += escapeHtml(withoutDangerousBlocks.slice(lastIndex, match.index));
      }
      lastIndex = tagRegex.lastIndex;
      const isClosing = Boolean(match[1]);
      const tagLower = String(match[2] || '').toLowerCase();
      const rawAttrs = String(match[3] || '');
      const isSelfClosing = Boolean(match[4]);
      if (!SAFE_DESCRIPTION_HTML_TAGS.has(tagLower)) {
        continue;
      }
      if (isClosing) {
        if (!VOID_DESCRIPTION_HTML_TAGS.has(tagLower)) {
          const stackIdx = openTagStack.lastIndexOf(tagLower);
          if (stackIdx !== -1) {
            while (openTagStack.length > stackIdx) {
              const popped = openTagStack.pop();
              out += `</${popped}>`;
            }
          }
        }
        continue;
      }
      if (tagLower === 'br') {
        out += isSelfClosing ? '<br />' : '<br>';
        continue;
      }
      const { attrStr, hasValidMediaSrc } = sanitizeDescriptionTagAttributes(
        tagLower,
        rawAttrs,
        escapeHtml
      );
      if ((tagLower === 'img' || tagLower === 'source') && !hasValidMediaSrc) {
        continue;
      }
      if (VOID_DESCRIPTION_HTML_TAGS.has(tagLower)) {
        out += isSelfClosing ? `<${tagLower}${attrStr} />` : `<${tagLower}${attrStr}>`;
      } else if (openTagStack.length < MAX_HTML_NESTING_DEPTH) {
        if (isSelfClosing) {
          out += `<${tagLower}${attrStr}></${tagLower}>`;
        } else {
          openTagStack.push(tagLower);
          out += `<${tagLower}${attrStr}>`;
        }
      }
    }
    if (lastIndex < withoutDangerousBlocks.length) {
      out += escapeHtml(withoutDangerousBlocks.slice(lastIndex));
    }
    while (openTagStack.length > 0) {
      const popped = openTagStack.pop();
      out += `</${popped}>`;
    }
    return out.trim();
  }

  const isFeatureHeadingLine = (line) =>
    line.length >= 3 &&
    line.length <= 60 &&
    /[A-Z]{2}/.test(line) &&
    line === line.toUpperCase() &&
    !/[.:]$/.test(line);

  const rawBlocks = trimmed
    .split(/\r?\n\s*\r?\n+/)
    .map((b) => b.trim())
    .filter(Boolean);

  const htmlBlocks = [];
  for (let bIdx = 0; bIdx < rawBlocks.length; bIdx++) {
    const lines = rawBlocks[bIdx]
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;

    if (lines.every((l) => /^[-*•·]\s+/.test(l))) {
      const items = lines
        .map((l) => `<li>${escapeHtml(l.replace(/^[-*•·]\s+/, '').trim())}</li>`)
        .join('');
      htmlBlocks.push(`<ul>${items}</ul>`);
      continue;
    }

    if (lines.length === 1 && bIdx < rawBlocks.length - 1 && isFeatureHeadingLine(lines[0])) {
      htmlBlocks.push(`<h3 class="bb_tag">${escapeHtml(lines[0])}</h3>`);
      continue;
    }

    if (lines.length >= 2 && isFeatureHeadingLine(lines[0])) {
      const heading = `<h3 class="bb_tag">${escapeHtml(lines[0])}</h3>`;
      const bodyLines = lines.slice(1);
      if (bodyLines.every((l) => /^[-*•·]\s+/.test(l))) {
        const items = bodyLines
          .map((l) => `<li>${escapeHtml(l.replace(/^[-*•·]\s+/, '').trim())}</li>`)
          .join('');
        htmlBlocks.push(`${heading}\n<ul>${items}</ul>`);
      } else {
        htmlBlocks.push(`${heading}\n<p>${bodyLines.map(escapeHtml).join('<br />')}</p>`);
      }
      continue;
    }

    htmlBlocks.push(`<p>${lines.map(escapeHtml).join('<br />')}</p>`);
  }

  return htmlBlocks.join('\n');
}

/**
 * Sanitizes DisplayCatalog ISO release dates, rejecting empty/invalid timestamps and universal
 * storefront sentinel dates (`0001-01-01`, `1753-01-01`, `2099-*`, `2799-12-31`, `2999-*`, `9998-*`, `9999-*`)
 * where `year < 1975` or `year > currentUTCYear + 10`.
 */
function sanitizeDisplayCatalogReleaseDate(rawDate) {
  if (!rawDate || typeof rawDate !== 'string') return '';
  const trimmed = rawDate.trim();
  if (!trimmed) return '';

  const maxYear = new Date().getUTCFullYear() + 10;
  const isoPrefix = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoPrefix) {
    const year = Number(isoPrefix[1]);
    const month = Number(isoPrefix[2]);
    const day = Number(isoPrefix[3]);
    if (
      !Number.isFinite(year) ||
      year < 1975 ||
      year > maxYear ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > 31
    ) {
      return '';
    }
    const utcCheck = new Date(Date.UTC(year, month - 1, day));
    if (
      Number.isNaN(utcCheck.getTime()) ||
      utcCheck.getUTCFullYear() !== year ||
      utcCheck.getUTCMonth() !== month - 1 ||
      utcCheck.getUTCDate() !== day
    ) {
      return '';
    }
    return `${isoPrefix[1]}-${isoPrefix[2]}-${isoPrefix[3]}`;
  }

  const parsedMs = Date.parse(trimmed);
  if (Number.isNaN(parsedMs)) return '';
  const dt = new Date(parsedMs);
  const year = dt.getUTCFullYear();
  if (year < 1975 || year > maxYear) return '';
  return dt.toISOString().slice(0, 10);
}

/**
 * Strips Microsoft Store / Xbox PC platform disambiguators so Xbox PC game titles
 * display cleanly and merge canonically with Steam, GOG, and Epic titles.
 *
 * @param {string} rawTitle
 * @returns {string}
 */
function stripXboxPlatformDisambiguators(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') return '';
  let cur = rawTitle.replace(/\s+/g, ' ').trim();
  for (let pass = 0; pass < 3; pass++) {
    const prev = cur;
    cur = cur
      .replace(
        /\s*[\(\[]\s*(?:pc(?:\s*(?:&|and)\s*(?:console|xbox))?|console\s*(?:&|and)\s*pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11|xbox(?:\s+pc|\s+one(?:\s*(?:&|and)\s*xbox\s+series\s+x\s*[\|\/]\s*s)?|\s+series\s+x\s*[\|\/]\s*s|\s+play\s+anywhere|\s*(?:&|and)\s*pc)?|microsoft\s+store|game\s+preview|(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11)\s+(?:edition|version))\s*[\)\]]/gi,
        ''
      )
      .replace(
        /([\(\[][^\)\]]+?)\s*[:\-–—]\s*(?:pc|windows(?:\s*10|\s*11)?(?:\s+version)?|win\s*10|win\s*11|xbox(?:\s+series\s+x\s*[\|\/]\s*s)?)\s*([\)\]])/gi,
        '$1$2'
      )
      .replace(
        /(?:\s*[:\-–—]\s*|\s+for\s+)(?:pc(?:\s*(?:&|and)\s*(?:console|xbox))?|console\s*(?:&|and)\s*pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11|microsoft\s+store|xbox(?:\s+pc|\s+one|\s+series\s+x\s*[\|\/]\s*s)?)(?:\s+(?:edition|version))?\s*$/gi,
        ''
      )
      .replace(
        /(?:[:\-–—]\s*|\s+)(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11)\s+(?:edition|version)\s*$/gi,
        ''
      )
      .replace(/(?:[:\-–—]\s*|\s+)xbox\s+series\s+x\s*[\|\/]\s*s\s*$/gi, '')
      .replace(/(?:[:\-–—]\s*|\s+)game\s+preview\s*$/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (/\s+pc$/i.test(cur) && !NATURAL_PC_PREDECESSOR_RE.test(cur)) {
      const withoutTrailingPc = cur.replace(/\s+pc$/i, '').trim();
      if (withoutTrailingPc.length >= 2) {
        cur = withoutTrailingPc;
      }
    }

    if (/\s+windows(?:\s*10|\s*11)?$/i.test(cur) && !NATURAL_WINDOWS_PREDECESSOR_RE.test(cur)) {
      const withoutTrailingWin = cur.replace(/\s+windows(?:\s*10|\s*11)?$/i, '').trim();
      if (withoutTrailingWin.length >= 2) {
        cur = withoutTrailingWin;
      }
    }

    if (cur === prev) break;
  }
  return cur || rawTitle.trim();
}

/**
 * Deterministically derives the canonical Xbox Live `SCID`
 * (`00000000-0000-0000-0000-0000<8-hex-titleId>`) by delegating to `xboxConfigAndIds`.
 *
 * - `MicrosoftGame.config` `<TitleId>` XML elements, leading-zero 8-char hex strings, `0x`-prefixed
 *   strings, strings with `[a-fA-F]`, or calls with `{ preferHex: true | format: 'hex' | source: 'msgameconfig' }`
 *   are parsed strictly as base-16 hexadecimal.
 * - Store DisplayCatalog / TitleHub numeric `XboxTitleId` / `modernTitleId` integers are parsed as base-10 decimal.
 *
 * @param {string | number | bigint | null | undefined} rawTitleId
 * @param {{ preferHex?: boolean, isHex?: boolean, format?: string, source?: string } | string} [options]
 * @returns {string}
 */
function deriveDefaultScidFromTitleId(rawTitleId, options = undefined) {
  if (rawTitleId === null || rawTitleId === undefined) return '';

  let input = rawTitleId;
  let forceHex =
    options === 'hex' ||
    Boolean(
      options &&
        typeof options === 'object' &&
        (options.preferHex === true ||
          options.isHex === true ||
          String(options.format || '').toLowerCase() === 'hex' ||
          String(options.source || '').toLowerCase() === 'msgameconfig')
    );

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return '';
    const xmlMatch = trimmed.match(/<TitleId>\s*([0-9a-fA-FxX]+)\s*<\/TitleId>/i);
    if (xmlMatch) {
      input = xmlMatch[1].trim();
      forceHex = true;
    } else {
      input = trimmed;
    }
  }

  /** @type {'hex' | 'decimal'} */
  let resolvedFormat = 'decimal';
  if (typeof input === 'number' || typeof input === 'bigint') {
    if (typeof input === 'number') {
      if (!Number.isInteger(input) || input <= 0 || input > 0xffffffff) return '';
    } else if (input <= 0n || input > 0xffffffffn) {
      return '';
    }
    resolvedFormat = 'decimal';
  } else {
    const str = String(input);
    if (
      forceHex ||
      /^0x[0-9a-f]+$/i.test(str) ||
      /^0[0-9a-f]{1,7}$/i.test(str) ||
      (/[a-f]/i.test(str) && /^[0-9a-f]{1,8}$/i.test(str))
    ) {
      resolvedFormat = 'hex';
    } else if (/^[0-9]+$/.test(str)) {
      resolvedFormat = 'decimal';
    } else {
      return '';
    }
  }

  const scid = xboxConfigAndIds.deriveDefaultScidFromTitleId(input, { format: resolvedFormat });
  if (!scid || scid === '00000000-0000-0000-0000-000000000000') return '';
  return scid;
}

module.exports = {
  RELEVANT_IMAGE_PURPOSES,
  DISPLAY_CATALOG_CAPABILITY_MAP,
  selectPreferredLocalizedEntry,
  normalizeStoreImageUrl,
  normalizeDisplayCatalogMediaUrl,
  normalizeDisplayCatalogImageUri,
  extractDisplayCatalogMovies,
  extractDisplayCatalogCategories,
  formatPlainDescriptionToHtml,
  sanitizeDisplayCatalogReleaseDate,
  stripXboxPlatformDisambiguators,
  deriveDefaultScidFromTitleId,
};
