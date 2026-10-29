/**
 * Shared byte formatting, game install size sanitization, and client-side
 * system-requirements storage parser utilities.
 */

/**
 * 2 TiB ceiling for any single game install, download, or DLC byte size.
 * Guards UI and persistence caches against corrupt manifest pointers (e.g., 253,114.6 GB)
 * while never capping drive/volume freeBytes or totalBytes (which regularly exceed 4–20 TB).
 */
export const MAX_PLAUSIBLE_GAME_INSTALL_BYTES = 2 * 1024 * 1024 * 1024 * 1024;

export interface FormatBytesOptions {
  decimals?: number;
  tbDecimals?: number;
  fallback?: string;
}

/**
 * Validates and normalizes a game install, download, or DLC byte count.
 * Returns a positive integer <= 2 TiB, or `undefined` if missing, non-positive, or implausible.
 */
export function sanitizeGameInstallSizeBytes(bytes: unknown): number | undefined {
  const num =
    typeof bytes === 'number'
      ? bytes
      : typeof bytes === 'string' && bytes.trim() !== ''
        ? Number(bytes)
        : NaN;
  if (!Number.isFinite(num) || num <= 0 || num > MAX_PLAUSIBLE_GAME_INSTALL_BYTES) {
    return undefined;
  }
  const rounded = Math.round(num);
  return rounded > 0 && rounded <= MAX_PLAUSIBLE_GAME_INSTALL_BYTES ? rounded : undefined;
}

/**
 * Formats a byte value into human-readable TB / GB / MB units.
 * Do NOT apply `MAX_PLAUSIBLE_GAME_INSTALL_BYTES` inside `formatBytes` so multi-terabyte
 * disk capacities (`freeBytes` / `totalBytes`) render accurately (e.g. `4.00 TB`).
 */
export function formatBytes(
  bytes: number | undefined | null,
  options?: FormatBytesOptions
): string {
  const decimals = options?.decimals ?? 1;
  const tbDecimals = options?.tbDecimals ?? 2;
  const fallback = options?.fallback ?? 'Unknown';

  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) {
    return fallback;
  }

  const tb = bytes / (1024 * 1024 * 1024 * 1024);
  if (tb >= 1) {
    return `${tb.toFixed(tbDecimals)} TB`;
  }

  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) {
    return `${gb.toFixed(decimals)} GB`;
  }

  const mb = bytes / (1024 * 1024);
  if (decimals === 2) {
    return `${mb.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(mb))} MB`;
}

/**
 * Formats a positive byte value into TB / GB / MB, returning `null` when absent or non-positive.
 */
export function formatByteSize(bytes: number | undefined | null): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }
  return formatBytes(bytes);
}

function parseLocalizedStorageNumber(rawNum: string): number {
  const trimmed = rawNum.trim();
  if (!trimmed) return NaN;

  if (trimmed.includes(',') && trimmed.includes('.')) {
    if (trimmed.lastIndexOf(',') > trimmed.lastIndexOf('.')) {
      return parseFloat(trimmed.replace(/\./g, '').replace(',', '.'));
    }
    return parseFloat(trimmed.replace(/,/g, ''));
  }

  if (trimmed.includes(',')) {
    if (/^\d{1,3}(?:,\d{3})+$/.test(trimmed)) {
      return parseFloat(trimmed.replace(/,/g, ''));
    }
    return parseFloat(trimmed.replace(',', '.'));
  }

  return parseFloat(trimmed);
}

function convertUnitToBytes(val: number, rawUnit: string): number | undefined {
  if (!Number.isFinite(val) || val <= 0) return undefined;
  const unit = rawUnit.toUpperCase();
  let bytes: number;
  if (unit.startsWith('T')) {
    bytes = val * 1024 * 1024 * 1024 * 1024;
  } else if (unit.startsWith('G')) {
    bytes = val * 1024 * 1024 * 1024;
  } else if (unit.startsWith('M')) {
    bytes = val * 1024 * 1024;
  } else {
    return undefined;
  }
  return sanitizeGameInstallSizeBytes(bytes);
}

const STORAGE_NOUN_ALT =
  'storage(?:\\s+space)?|hard\\s+drive(?:\\s+space)?|hard\\s+disk(?:\\s+space)?|disk\\s+space|hd\\s+space|hdd\\s+space|ssd\\s+space|free\\s+(?:hard\\s+)?(?:disk|drive)\\s+space|available\\s+(?:hard\\s+)?(?:disk|drive)?\\s*space|speicherplatz|festplattenspeicher|festplatte|espace\\s+(?:disque|de\\s+stockage)|stockage|almacenamiento|espacio\\s+en\\s+disco|spazio\\s+(?:su\\s+disco|disponibile)|armazenamento|miejsce\\s+na\\s+dysku';

const NUM_CAPTURE = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:[.,]\\d+)?)';
const UNIT_CAPTURE =
  '(?:(?:\\s+|\\/|-)(?:ssd|hdd|nvme))?\\s*(tb|tib|gb|gib|mb|mib)\\b(?!\\s*(?:ram|vram|arbeitsspeicher|video\\s+memory|system\\s+memory|unified\\s+memory)\\b)';

const STANDALONE_STORAGE_HEADING_RE = new RegExp(
  `^(?:\\*\\s*|-\\s*|•\\s*)?(?:${STORAGE_NOUN_ALT})\\s*[:\\-–—]?\\s*$`,
  'i'
);

const NON_STORAGE_PREFIX_RE =
  /^\s*(?:(?:minimum|recommended)\s*:\s*)?(?:\*\s*|-\s*|•\s*)?(?:memory|ram|system\s+memory|arbeitsspeicher|graphics|grafik(?:karte)?|video(?:\s+card)?|gpu|vram|processor|prozessor|cpu|os|operating\s+system|betriebssystem|sound(?:\s+card)?|audio|network|broadband|directx)\s*:/i;

const INLINE_STORAGE_LABEL_RE = new RegExp(`\\b(?:${STORAGE_NOUN_ALT})\\s*:`, 'i');

const PASS1_LINE_LEADING_RE = new RegExp(
  `^\\s*(?:(?:recommended|minimum)\\s*:?\\s+|\\*\\s*|-\\s*|•\\s*)*(?:${STORAGE_NOUN_ALT})\\s*(?::|-|–|—)\\s*(?:at\\s+least\\s+|approx\\.?\\s+|minimum\\s+(?:of\\s+)?|up\\s+to\\s+|requires\\s+|about\\s+|~\\s*)?${NUM_CAPTURE}${UNIT_CAPTURE}`,
  'i'
);

const PASS1_INLINE_COLON_RE = new RegExp(
  `\\b(?:${STORAGE_NOUN_ALT}|(?:hdd|ssd)(?:\\s+space)?)\\s*:\\s*(?:at\\s+least\\s+|approx\\.?\\s+|minimum\\s+(?:of\\s+)?|up\\s+to\\s+|requires\\s+|about\\s+|~\\s*)?${NUM_CAPTURE}${UNIT_CAPTURE}`,
  'i'
);

const PASS2_NUMBER_FIRST_RE = new RegExp(
  `\\b${NUM_CAPTURE}${UNIT_CAPTURE}\\s+(?:of\\s+)?(?:uncompressed\\s+)?(?:(?:available|free|verfügbarer?)\\s+)?(?:(?:hard\\s+(?:drive|disk)|hdd|ssd|disk|hd)(?:\\s+(?:space|storage))?|(?:space|storage|speicherplatz|festplattenspeicher)\\b|on\\s+hard\\s+(?:drive|disk))`,
  'i'
);

const PASS3_FALLBACK_RE = new RegExp(
  `\\b(?:${STORAGE_NOUN_ALT}|ssd|hdd)\\b[^0-9\\n()]{0,25}\\(?\\s*${NUM_CAPTURE}${UNIT_CAPTURE}`,
  'i'
);

/**
 * Parses storage requirements from storefront HTML or plain-text system requirement blocks
 * into exact bytes (matching backend `parseStorageRequirementBytes` rules).
 */
export function parseStorageRequirementBytesClient(
  rawHtmlOrText?: string | null
): number | undefined {
  if (!rawHtmlOrText || typeof rawHtmlOrText !== 'string') {
    return undefined;
  }

  const normalizedBlock = rawHtmlOrText
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:li|p|tr|div|h[1-6]|dd|dt)\s*>/gi, '\n')
    .replace(/<\/(?:td|th)\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&#58;|&#x3a;/gi, ':')
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&amp;/gi, '&');

  const rawLines = normalizedBlock
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);

  const mergedLines: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const curr = rawLines[i];
    if (STANDALONE_STORAGE_HEADING_RE.test(curr) && i + 1 < rawLines.length) {
      const cleanLabel = curr.replace(/\s*[:\-–—]?\s*$/, '').trim();
      mergedLines.push(`${cleanLabel}: ${rawLines[i + 1]}`);
      i++;
    } else {
      mergedLines.push(curr);
    }
  }

  const candidateLines: string[] = [];
  for (const line of mergedLines) {
    if (NON_STORAGE_PREFIX_RE.test(line)) {
      const inlineMatch = INLINE_STORAGE_LABEL_RE.exec(line);
      if (inlineMatch) {
        candidateLines.push(line.slice(inlineMatch.index));
      }
      continue;
    }
    candidateLines.push(line);
  }

  for (const line of candidateLines) {
    const m = line.match(PASS1_LINE_LEADING_RE) || line.match(PASS1_INLINE_COLON_RE);
    if (m) {
      const parsedBytes = convertUnitToBytes(parseLocalizedStorageNumber(m[1]), m[2]);
      if (parsedBytes !== undefined) return parsedBytes;
    }
  }

  for (const line of candidateLines) {
    const m = line.match(PASS2_NUMBER_FIRST_RE);
    if (m) {
      const parsedBytes = convertUnitToBytes(parseLocalizedStorageNumber(m[1]), m[2]);
      if (parsedBytes !== undefined) return parsedBytes;
    }
  }

  for (const line of candidateLines) {
    const m = line.match(PASS3_FALLBACK_RE);
    if (m) {
      const parsedBytes = convertUnitToBytes(parseLocalizedStorageNumber(m[1]), m[2]);
      if (parsedBytes !== undefined) return parsedBytes;
    }
  }

  return undefined;
}

/**
 * Parses storage requirement bytes from storefront HTML/text and formats them via `formatBytes`
 * (e.g. `"10000 MB"` -> `"9.8 GB"`, `"1,650 MB"` -> `"1.6 GB"`), returning `null` if none found.
 */
export function parseStorageRequirementTextClient(rawHtmlOrText?: string | null): string | null {
  const bytes = parseStorageRequirementBytesClient(rawHtmlOrText);
  return bytes !== undefined ? formatBytes(bytes) : null;
}
