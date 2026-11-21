// @ts-check
'use strict';

const zlib = require('node:zlib');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');

/**
 * Maximum plausible game installation size (2 TiB = 2,199,023,255,552 bytes).
 * Rejects corrupted/uninitialized/mis-parsed manifest sizes (e.g. 253,114.6 GB).
 */
const MAX_PLAUSIBLE_GAME_INSTALL_BYTES = 2 * 1024 * 1024 * 1024 * 1024;

/**
 * Hard 64 MiB inflation cap for untrusted Epic Games `.manifest` payloads (CP-02 zip-bomb DoS guard).
 */
const MAX_EPIC_MANIFEST_INFLATE_BYTES = 64 * 1024 * 1024;

/**
 * Validate and round a byte count into a plausible positive game install size, or undefined.
 *
 * @param {unknown} val
 * @returns {number | undefined}
 */
function sanitizeGameInstallSizeBytes(val) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return undefined;
  if (val <= 0 || val > MAX_PLAUSIBLE_GAME_INSTALL_BYTES) return undefined;
  const rounded = Math.round(val);
  return rounded > 0 && rounded <= MAX_PLAUSIBLE_GAME_INSTALL_BYTES ? rounded : undefined;
}

/**
 * Decode Unreal Engine's `%03d` little-endian byte-triplet strings (e.g. "121001000000" -> 377)
 * into a safe JS integer, or null if invalid / out of range.
 *
 * @param {unknown} str
 * @returns {number | null}
 */
function decodeEpicJsonBlobInt(str) {
  if (typeof str !== 'string' || str.length < 3 || str.length % 3 !== 0) return null;
  let num = 0n;
  let shift = 0n;
  for (let i = 0; i < str.length; i += 3) {
    const c0 = str.charCodeAt(i);
    const c1 = str.charCodeAt(i + 1);
    const c2 = str.charCodeAt(i + 2);
    if (c0 < 48 || c0 > 57 || c1 < 48 || c1 > 57 || c2 < 48 || c2 > 57) return null;
    const byteVal = (c0 - 48) * 100 + (c1 - 48) * 10 + (c2 - 48);
    if (byteVal > 255) return null;
    num |= BigInt(byteVal) << shift;
    shift += 8n;
  }
  if (num > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(num);
}

/**
 * @param {unknown} rawNum
 * @returns {number}
 */
function parseLocalizedStorageNumber(rawNum) {
  if (typeof rawNum !== 'string') return NaN;
  const s = rawNum.trim();
  if (!s) return NaN;
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      return Number(s.replace(/\./g, '').replace(',', '.'));
    }
    return Number(s.replace(/,/g, ''));
  }
  if (/^\d{1,3}(?:,\d{3})+$/.test(s)) {
    return Number(s.replace(/,/g, ''));
  }
  if (/^\d+,\d+$/.test(s)) {
    return Number(s.replace(',', '.'));
  }
  return Number(s);
}

/**
 * Parse a raw byte count (number or numeric string) or human-readable formatted size
 * (e.g. "1.11 GiB", "532.4 MiB", "4.5 GB", "850 KB", "1.2 TiB") into sanitized bytes.
 *
 * @param {unknown} raw
 * @returns {number | undefined}
 */
function parseByteCountOrFormattedSize(raw) {
  if (typeof raw === 'number') {
    return sanitizeGameInstallSizeBytes(raw);
  }
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return sanitizeGameInstallSizeBytes(Number(trimmed));
  }
  const m = trimmed.match(
    /^(\d{1,3}(?:,\d{3})+|\d+(?:[.,]\d+)?)\s*(tb|tib|gb|gib|mb|mib|kb|kib|b)$/i
  );
  if (!m) return undefined;
  const val = parseLocalizedStorageNumber(m[1]);
  if (!Number.isFinite(val) || val <= 0) return undefined;
  const unit = m[2].toLowerCase();
  let factor = 1;
  if (unit === 'tb' || unit === 'tib') factor = 1024 * 1024 * 1024 * 1024;
  else if (unit === 'gb' || unit === 'gib') factor = 1024 * 1024 * 1024;
  else if (unit === 'mb' || unit === 'mib') factor = 1024 * 1024;
  else if (unit === 'kb' || unit === 'kib') factor = 1024;
  return sanitizeGameInstallSizeBytes(val * factor);
}

/**
 * Parse human-readable storage requirements from HTML or text descriptions.
 *
 * @param {unknown} htmlOrText
 * @returns {number | undefined}
 */
function parseStorageRequirementBytes(htmlOrText) {
  if (!htmlOrText) return undefined;
  const rawStr = typeof htmlOrText === 'string' ? htmlOrText : JSON.stringify(htmlOrText);

  const normalizedText = rawStr
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:li|p|tr|div|h[1-6]|dd|dt)\s*>/gi, '\n')
    .replace(/<\/(?:td|th)\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&#58;|&#x3a;/gi, ':')
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&amp;/gi, '&');

  const rawLines = normalizedText
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const STORAGE_NOUN_ALT =
    'storage(?:\\s+space)?|hard\\s+drive(?:\\s+space)?|hard\\s+disk(?:\\s+space)?|disk\\s+space|hd\\s+space|hdd\\s+space|ssd\\s+space|free\\s+(?:hard\\s+)?(?:disk|drive)\\s+space|available\\s+(?:hard\\s+)?(?:disk|drive)?\\s*space|speicherplatz|festplattenspeicher|festplatte|espace\\s+(?:disque|de\\s+stockage)|stockage|almacenamiento|espacio\\s+en\\s+disco|spazio\\s+(?:su\\s+disco|disponibile)|armazenamento|miejsce\\s+na\\s+dysku';
  const standaloneHeadingRe = new RegExp(
    `^(?:\\*\\s*|-\\s*|•\\s*)?(?:${STORAGE_NOUN_ALT})\\s*[:\\-–—]?\\s*$`,
    'i'
  );
  /** @type {string[]} */
  const mergedLines = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    if (standaloneHeadingRe.test(rawLines[i]) && i + 1 < rawLines.length) {
      const cleanHeading = rawLines[i].replace(/\s*[:\-–—]?\s*$/, '');
      mergedLines.push(`${cleanHeading}: ${rawLines[i + 1]}`);
      i += 1;
    } else {
      mergedLines.push(rawLines[i]);
    }
  }

  const nonStoragePrefixRe =
    /^\s*(?:(?:minimum|recommended)\s*:\s*)?(?:\*\s*|-\s*|•\s*)?(?:memory|ram|system\s+memory|arbeitsspeicher|graphics|grafik(?:karte)?|video(?:\s+card)?|gpu|vram|processor|prozessor|cpu|os|operating\s+system|betriebssystem|sound(?:\s+card)?|audio|network|broadband|directx)\s*:/i;
  const inlineStorageLabelRe = new RegExp(`\\b(?:${STORAGE_NOUN_ALT})\\s*:`, 'i');

  /** @type {string[]} */
  const candidateLines = [];
  for (const line of mergedLines) {
    if (nonStoragePrefixRe.test(line)) {
      const inlineMatch = inlineStorageLabelRe.exec(line);
      if (inlineMatch) {
        candidateLines.push(line.slice(inlineMatch.index));
      }
      continue;
    }
    candidateLines.push(line);
  }

  /**
   * @param {string} numStr
   * @param {string} unitStr
   */
  const convertMatchedSize = (numStr, unitStr) => {
    const val = parseLocalizedStorageNumber(numStr);
    if (!Number.isFinite(val) || val <= 0) return undefined;
    const unit = String(unitStr || '').toLowerCase();
    let factor = 0;
    if (unit === 'tb' || unit === 'tib') factor = 1024 * 1024 * 1024 * 1024;
    else if (unit === 'gb' || unit === 'gib') factor = 1024 * 1024 * 1024;
    else if (unit === 'mb' || unit === 'mib') factor = 1024 * 1024;
    if (!factor) return undefined;
    return sanitizeGameInstallSizeBytes(val * factor);
  };

  const NUM_CAPTURE = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:[.,]\\d+)?)';
  const UNIT_CAPTURE =
    '(?:(?:\\s+|\\/|-)(?:ssd|hdd|nvme))?\\s*(tb|tib|gb|gib|mb|mib)\\b(?!\\s*(?:ram|vram|arbeitsspeicher|video\\s+memory|system\\s+memory|unified\\s+memory)\\b)';

  const pass1LineLeadingRe = new RegExp(
    `^\\s*(?:(?:recommended|minimum)\\s*:?\\s+|\\*\\s*|-\\s*|•\\s*)*(?:${STORAGE_NOUN_ALT})\\s*(?::|-|–|—)\\s*(?:at\\s+least\\s+|approx\\.?\\s+|minimum\\s+(?:of\\s+)?|up\\s+to\\s+|requires\\s+|about\\s+|~\\s*)?${NUM_CAPTURE}${UNIT_CAPTURE}`,
    'i'
  );
  const pass1InlineColonRe = new RegExp(
    `\\b(?:${STORAGE_NOUN_ALT}|(?:hdd|ssd)(?:\\s+space)?)\\s*:\\s*(?:at\\s+least\\s+|approx\\.?\\s+|minimum\\s+(?:of\\s+)?|up\\s+to\\s+|requires\\s+|about\\s+|~\\s*)?${NUM_CAPTURE}${UNIT_CAPTURE}`,
    'i'
  );

  for (const line of candidateLines) {
    const m = line.match(pass1LineLeadingRe) || line.match(pass1InlineColonRe);
    if (m) {
      const bytes = convertMatchedSize(m[1], m[2]);
      if (bytes) return bytes;
    }
  }

  const pass2Re = new RegExp(
    `\\b${NUM_CAPTURE}${UNIT_CAPTURE}\\s+(?:of\\s+)?(?:uncompressed\\s+)?(?:(?:available|free|verfügbarer?)\\s+)?(?:(?:hard\\s+(?:drive|disk)|hdd|ssd|disk|hd)(?:\\s+(?:space|storage))?|(?:space|storage|speicherplatz|festplattenspeicher)\\b|on\\s+hard\\s+(?:drive|disk))`,
    'i'
  );

  for (const line of candidateLines) {
    const m = line.match(pass2Re);
    if (m) {
      const bytes = convertMatchedSize(m[1], m[2]);
      if (bytes) return bytes;
    }
  }

  const pass3Re = new RegExp(
    `\\b(?:${STORAGE_NOUN_ALT}|ssd|hdd)\\b[^0-9\\n()]{0,25}\\(?\\s*${NUM_CAPTURE}${UNIT_CAPTURE}`,
    'i'
  );

  for (const line of candidateLines) {
    const m = line.match(pass3Re);
    if (m) {
      const bytes = convertMatchedSize(m[1], m[2]);
      if (bytes) return bytes;
    }
  }

  return undefined;
}

/**
 * Parse Valve VDF libraryfolders.vdf to extract all Steam library paths.
 *
 * @param {string} vdfContent
 * @returns {string[]}
 */
function parseSteamLibraryFoldersVdf(vdfContent) {
  /** @type {string[]} */
  const paths = [];
  if (!vdfContent || typeof vdfContent !== 'string') return paths;

  const pathRegex = /"path"\s+"([^"]+)"/gi;
  let m;
  while ((m = pathRegex.exec(vdfContent)) !== null) {
    const raw = m[1].replace(/\\\\/g, '\\').trim();
    if (raw && !paths.includes(raw)) {
      paths.push(raw);
    }
  }

  const legacyRegex = /"\d+"\s+"([A-Za-z]:\\[^"]+|\/[^"]+)"/g;
  while ((m = legacyRegex.exec(vdfContent)) !== null) {
    const raw = m[1].replace(/\\\\/g, '\\').trim();
    if (raw && !paths.includes(raw)) {
      paths.push(raw);
    }
  }

  return paths;
}

/**
 * Parse Steam appmanifest_<appId>.acf content.
 *
 * @param {string} acfContent
 */
function parseSteamAcf(acfContent) {
  if (!acfContent || typeof acfContent !== 'string') return null;
  /** @param {string} key */
  const extract = (key) => {
    const re = new RegExp(`"${key}"\\s+"([^"]*)"`, 'i');
    const m = acfContent.match(re);
    return m ? m[1] : undefined;
  };

  const appIdStr = extract('appid');
  const appId = appIdStr ? parseInt(appIdStr, 10) : NaN;
  if (!appId || Number.isNaN(appId)) return null;

  return {
    appId,
    name: extract('name') || `Steam App ${appId}`,
    installdir: extract('installdir') || '',
    SizeOnDisk: extract('SizeOnDisk'),
    StateFlags: extract('StateFlags'),
    buildid: extract('buildid'),
    BytesDownloaded: extract('BytesDownloaded'),
    BytesToDownload: extract('BytesToDownload'),
    BytesStaged: extract('BytesStaged'),
    BytesToStage: extract('BytesToStage'),
    LastUpdated: extract('LastUpdated'),
  };
}

/**
 * Parse `[YYYY-MM-DD HH:MM:SS]` local timestamp prefix from a Steam `content_log.txt` line.
 *
 * @param {string} line
 * @returns {number}
 */
function parseSteamLogLineTimestampMs(line) {
  const tsMatch = line.match(/^\[(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\]/);
  if (!tsMatch) return 0;
  const ts = new Date(
    Number(tsMatch[1]),
    Number(tsMatch[2]) - 1,
    Number(tsMatch[3]),
    Number(tsMatch[4]),
    Number(tsMatch[5]),
    Number(tsMatch[6])
  ).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Normalize raw Steam `App update changed : ...` phase strings into clean UI phase labels.
 *
 * @param {string | undefined} rawPhase
 * @returns {string | undefined}
 */
function normalizeSteamUpdatePhase(rawPhase) {
  if (!rawPhase) return undefined;
  if (/^none$/i.test(rawPhase)) return 'None';
  if (/fully installed/i.test(rawPhase)) return 'Fully Installed';
  if (/committing/i.test(rawPhase)) return 'Finalizing';
  if (/stopping|suspended/i.test(rawPhase)) return 'Paused';
  if (/downloading/i.test(rawPhase)) return 'Downloading';
  if (/staging|extracting/i.test(rawPhase)) return 'Staging';
  if (/verifying|validating/i.test(rawPhase)) return 'Verifying';
  if (/preallocating|allocating/i.test(rawPhase)) return 'Preallocating';
  if (/reconfiguring/i.test(rawPhase)) return 'Preparing';
  if (/running update/i.test(rawPhase)) return 'Preparing';
  return rawPhase.replace(/,+$/g, '').trim() || undefined;
}

/**
 * Integrate piecewise-constant Steam bandwidth samples (`rateSamples`) from `anchorTsMs` to `nowMs`.
 * Caps open-ended extrapolation past the final rate sample at 75s (Steam logs a fresh sample every ~60s).
 *
 * @param {Array<{ tsMs: number, speedBytesPerSec: number }>} rateSamples
 * @param {number} anchorTsMs
 * @param {number} nowMs
 * @param {boolean} isCurrentlyDownloading
 * @returns {number}
 */
function integrateSteamRateSamples(rateSamples, anchorTsMs, nowMs, isCurrentlyDownloading) {
  if (
    !Array.isArray(rateSamples) ||
    rateSamples.length === 0 ||
    !Number.isFinite(anchorTsMs) ||
    anchorTsMs <= 0 ||
    !Number.isFinite(nowMs) ||
    nowMs <= anchorTsMs
  ) {
    return 0;
  }

  let totalBytes = 0;
  for (let i = 0; i < rateSamples.length; i += 1) {
    const cur = rateSamples[i];
    if (!cur || !Number.isFinite(cur.tsMs) || cur.tsMs <= 0 || cur.speedBytesPerSec <= 0) {
      continue;
    }
    const nextTs =
      i + 1 < rateSamples.length
        ? rateSamples[i + 1].tsMs
        : isCurrentlyDownloading
          ? Math.min(nowMs, cur.tsMs + 75000)
          : cur.tsMs;
    const segStart = Math.max(anchorTsMs, cur.tsMs);
    const segEnd = Math.min(nowMs, nextTs);
    if (segEnd > segStart) {
      totalBytes += cur.speedBytesPerSec * ((segEnd - segStart) / 1000);
    }
  }

  return Math.max(0, Math.round(totalBytes));
}

/**
 * Parse Steam logs/content_log.txt tail content for real-time download & staging progress of an AppID.
 * Safely escapes regex metacharacters in `appId` and isolates global `Current download rate:` lines
 * so concurrent/unrelated AppID downloads never pollute this AppID's bandwidth telemetry.
 *
 * @param {string} logContent
 * @param {string | number} appId
 * @param {number} [minTimestampMs]
 * @param {number} [nowMs]
 */
function parseSteamContentLogForApp(logContent, appId, minTimestampMs = 0, nowMs = Date.now()) {
  /** @type {{
   *   bytesDownloaded: number,
   *   bytesToDownload: number,
   *   estimatedBytesDownloaded: number,
   *   bytesStaged: number,
   *   bytesToStage: number,
   *   phase: string | undefined,
   *   rawPhase: string | undefined,
   *   fullyInstalled: boolean,
   *   updateStarted: boolean,
   *   updateCanceled: boolean,
   *   isRunning: boolean,
   *   isDownloading: boolean,
   *   isCommitting: boolean,
   *   isSuspended: boolean,
   *   checkpointTs: number,
   *   downloadStartTs: number,
   *   speedBytesPerSec: number,
   *   rateSamples: Array<{ tsMs: number, speedBytesPerSec: number }>
   * }} */
  const result = {
    bytesDownloaded: 0,
    bytesToDownload: 0,
    estimatedBytesDownloaded: 0,
    bytesStaged: 0,
    bytesToStage: 0,
    phase: undefined,
    rawPhase: undefined,
    fullyInstalled: false,
    updateStarted: false,
    updateCanceled: false,
    isRunning: false,
    isDownloading: false,
    isCommitting: false,
    isSuspended: false,
    checkpointTs: 0,
    downloadStartTs: 0,
    speedBytesPerSec: 0,
    rateSamples: [],
  };

  if (!logContent || typeof logContent !== 'string' || !appId) return result;
  const rawAppId = String(appId).trim();
  if (!rawAppId) return result;

  const validMinTs = Number.isFinite(minTimestampMs) && minTimestampMs > 0 ? minTimestampMs : 0;
  const effectiveNowMs = Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  const escapedAppId = rawAppId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const appPrefixRe = new RegExp(`AppID\\s+${escapedAppId}(?![A-Za-z0-9_])`, 'i');
  const targetAppIdLower = rawAppId.toLowerCase();
  const lines = logContent.split(/\r?\n/);
  let lastAppEventTs = 0;
  /** @type {string | null} */
  let activeLogAppId = null;
  /** @type {string | null} */
  let lastMentionedAppId = null;

  for (const line of lines) {
    const lineTs = parseSteamLogLineTimestampMs(line);
    const anyAppMatch = line.match(/\bAppID\s+([^\s:,]+)/i);

    if (anyAppMatch) {
      const lineAppIdLower = anyAppMatch[1].toLowerCase();
      lastMentionedAppId = lineAppIdLower;
      const lineUpdateChangedMatch = line.match(/App update changed\s*:\s*(.+)$/i);
      const lineRawPhase = lineUpdateChangedMatch ? lineUpdateChangedMatch[1].trim() : '';
      const lineStartsOrRuns =
        /\bupdate started\s*:/i.test(line) ||
        /\bdownload\s+\d+\/\d+/i.test(line) ||
        /state changed\s*:\s*[^(\r\n]*\b(?:Update Running|Update Started|Downloading|Staging)\b/i.test(
          line
        ) ||
        (Boolean(lineRawPhase) &&
          !/^none$/i.test(lineRawPhase) &&
          !/stopping|suspended/i.test(lineRawPhase) &&
          /running update|downloading|staging|preallocating|allocating|verifying|validating|committing|reconfiguring/i.test(
            lineRawPhase
          ));
      const lineStops =
        /\bupdate canceled\s*:/i.test(line) ||
        (Boolean(lineRawPhase) &&
          (/^none$/i.test(lineRawPhase) || /stopping|suspended/i.test(lineRawPhase))) ||
        (/state changed\s*:\s*[^(\r\n]*\b(?:Fully Installed|Uninstalled)\b/i.test(line) &&
          !/\b(?:Update Running|Update Started|Update Queued|Update Required|Uninstalling)\b/i.test(
            line
          ));
      if (lineStartsOrRuns) {
        activeLogAppId = lineAppIdLower;
      } else if (lineStops && activeLogAppId === lineAppIdLower) {
        activeLogAppId = null;
      }
    }

    const rateMatch =
      line.match(/Current download rate:\s*([\d.]+)\s*Mbps/i) ||
      line.match(
        /Increasing target number of download connections to \d+\s*\(rate was [\d.]+,\s*now\s*([\d.]+)\)/i
      );
    if (rateMatch) {
      const lineMentionsOtherApp = Boolean(anyAppMatch && !appPrefixRe.test(line));
      const belongsToOtherActiveApp =
        activeLogAppId !== null && activeLogAppId !== targetAppIdLower;
      const belongsToOtherContext =
        activeLogAppId === null &&
        lastMentionedAppId !== null &&
        lastMentionedAppId !== targetAppIdLower;
      if (
        !lineMentionsOtherApp &&
        !belongsToOtherActiveApp &&
        !belongsToOtherContext &&
        !result.fullyInstalled &&
        !result.updateCanceled &&
        !result.isSuspended
      ) {
        const mbps = parseFloat(rateMatch[1]);
        if (!Number.isNaN(mbps) && mbps >= 0) {
          const bps = Math.round(mbps * 125000);
          if (
            validMinTs === 0 ||
            lineTs === 0 ||
            lineTs >= validMinTs - 15000 ||
            result.updateStarted ||
            result.isRunning
          ) {
            result.speedBytesPerSec = bps;
            if (lineTs > 0) {
              result.rateSamples.push({ tsMs: lineTs, speedBytesPerSec: bps });
            }
          }
        }
      }
    }

    if (!appPrefixRe.test(line)) continue;
    if (lineTs > 0) {
      lastAppEventTs = lineTs;
    }

    const isUpdateStartedLine = /\bupdate started\s*:/i.test(line);
    const isUninstalledLine = /state changed\s*:\s*[^(\r\n]*\bUninstalled\b/i.test(line);
    const isFreshUpdateRequiredAfterInstall =
      result.fullyInstalled &&
      /state changed\s*:\s*[^(\r\n]*\bUpdate Required\b/i.test(line) &&
      !/Update Started/i.test(line);

    if (isUpdateStartedLine || isUninstalledLine || isFreshUpdateRequiredAfterInstall) {
      result.bytesDownloaded = 0;
      result.bytesToDownload = 0;
      result.estimatedBytesDownloaded = 0;
      result.bytesStaged = 0;
      result.bytesToStage = 0;
      result.fullyInstalled = false;
      result.updateCanceled = false;
      result.isCommitting = false;
      result.isSuspended = false;
      result.speedBytesPerSec = 0;
      result.rateSamples = [];
      if (isUninstalledLine) {
        result.updateStarted = false;
        result.isRunning = false;
        result.isDownloading = false;
        result.phase = undefined;
        result.rawPhase = undefined;
        result.checkpointTs = 0;
        result.downloadStartTs = 0;
      } else if (isUpdateStartedLine) {
        result.updateStarted = true;
        result.isRunning = true;
        if (lineTs > 0) {
          result.checkpointTs = lineTs;
        }
      }
    }

    if (/update canceled\s*:/i.test(line)) {
      result.updateCanceled = true;
      result.isRunning = false;
      result.isDownloading = false;
      result.isCommitting = false;
      result.speedBytesPerSec = 0;
      if (lineTs > 0) {
        result.rateSamples.push({ tsMs: lineTs, speedBytesPerSec: 0 });
      }
    }

    const dlMatch = line.match(/download\s+(\d+)\/(\d+)/i);
    if (dlMatch) {
      result.bytesDownloaded = Number(dlMatch[1]) || 0;
      result.bytesToDownload = Number(dlMatch[2]) || 0;
      if (lineTs > 0) {
        result.checkpointTs = lineTs;
      }
    }

    const stageMatch = line.match(/stage\s+(\d+)\/(\d+)/i);
    if (stageMatch) {
      result.bytesStaged = Number(stageMatch[1]) || 0;
      result.bytesToStage = Number(stageMatch[2]) || 0;
    }

    const updateChangedMatch = line.match(/App update changed\s*:\s*(.+)$/i);
    if (updateChangedMatch) {
      const rawPhase = updateChangedMatch[1].trim();
      result.rawPhase = rawPhase;
      result.phase = normalizeSteamUpdatePhase(rawPhase);
      if (/^none$/i.test(rawPhase)) {
        result.isRunning = false;
        result.isDownloading = false;
        result.isCommitting = false;
        if (lineTs > 0) {
          result.rateSamples.push({ tsMs: lineTs, speedBytesPerSec: 0 });
        }
      } else if (/stopping|suspended/i.test(rawPhase)) {
        result.isRunning = false;
        result.isDownloading = false;
        result.isCommitting = false;
        result.isSuspended = true;
        result.speedBytesPerSec = 0;
        if (lineTs > 0) {
          result.rateSamples.push({ tsMs: lineTs, speedBytesPerSec: 0 });
        }
      } else if (
        /running update|downloading|staging|preallocating|allocating|verifying|validating|committing|reconfiguring/i.test(
          rawPhase
        )
      ) {
        result.fullyInstalled = false;
        result.updateCanceled = false;
        result.isSuspended = false;
        result.isRunning = true;
        const nowDownloading = /downloading/i.test(rawPhase);
        const nowCommitting = /committing/i.test(rawPhase);
        if (nowDownloading && !result.downloadStartTs && lineTs > 0) {
          result.downloadStartTs = lineTs;
        }
        if (!nowDownloading && result.isDownloading && lineTs > 0) {
          result.rateSamples.push({ tsMs: lineTs, speedBytesPerSec: 0 });
        }
        result.isDownloading = nowDownloading;
        result.isCommitting = nowCommitting;
      }
    }

    if (
      /state changed\s*:\s*[^(\r\n]*\bFully Installed\b/i.test(line) &&
      !/\b(?:Update Running|Update Started|Update Queued|Update Required|Uninstalling)\b/i.test(
        line
      )
    ) {
      result.fullyInstalled = true;
      result.updateCanceled = false;
      result.isRunning = false;
      result.isDownloading = false;
      result.isCommitting = false;
      result.isSuspended = false;
      result.phase = 'Fully Installed';
      result.rawPhase = 'Fully Installed';
      if (lineTs > 0) {
        result.rateSamples.push({ tsMs: lineTs, speedBytesPerSec: 0 });
      }
    }
  }

  if (
    validMinTs > 0 &&
    lastAppEventTs > 0 &&
    lastAppEventTs < validMinTs - 15000 &&
    (result.fullyInstalled ||
      result.updateCanceled ||
      (!result.isRunning && !result.updateStarted))
  ) {
    return {
      bytesDownloaded: 0,
      bytesToDownload: 0,
      estimatedBytesDownloaded: 0,
      bytesStaged: 0,
      bytesToStage: 0,
      phase: undefined,
      rawPhase: undefined,
      fullyInstalled: false,
      updateStarted: false,
      updateCanceled: false,
      isRunning: false,
      isDownloading: false,
      isCommitting: false,
      isSuspended: false,
      checkpointTs: 0,
      downloadStartTs: 0,
      speedBytesPerSec: 0,
      rateSamples: [],
    };
  }

  const lastRateSampleTs =
    result.rateSamples.length > 0 ? result.rateSamples[result.rateSamples.length - 1].tsMs : 0;
  const hasRecentRateTelemetry =
    lastRateSampleTs > 0 &&
    effectiveNowMs >= lastRateSampleTs &&
    effectiveNowMs - lastRateSampleTs <= 120000;

  const anchorTs = result.checkpointTs || result.downloadStartTs;
  if (anchorTs > 0 && result.rateSamples.length > 0 && hasRecentRateTelemetry) {
    const integratedDelta = integrateSteamRateSamples(
      result.rateSamples,
      anchorTs,
      effectiveNowMs,
      result.isRunning && result.isDownloading
    );
    const rawEstimated = result.bytesDownloaded + integratedDelta;
    result.estimatedBytesDownloaded =
      result.bytesToDownload > 0
        ? Math.min(Math.floor(result.bytesToDownload * 0.98), rawEstimated)
        : rawEstimated;
  } else {
    result.estimatedBytesDownloaded = result.bytesDownloaded;
  }

  return result;
}

/**
 * Parse binary (magic `0x44bec00c`) or JSON Epic Games `.manifest` buffers.
 * Enforces a strict 64 MiB uncompressed size & `zlib.inflateSync({ maxOutputLength })` cap (CP-02).
 *
 * @param {Buffer} buf
 * @returns {{ diskSize: number, downloadSize: number } | null}
 */
function parseEpicManifestBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  try {
    // 1. Binary Manifest (magic 0x44BEC00C)
    if (buf.length >= 41 && buf.readUInt32LE(0) === 0x44bec00c) {
      const headerSize = buf.readUInt32LE(4);
      if (headerSize < 41 || headerSize > buf.length) return null;

      // CP-02: Validate declared header DataSizeUncompressed <= 64 MiB before inflating
      const headerUncompressedSize = buf.readUInt32LE(8);
      if (headerUncompressedSize > MAX_EPIC_MANIFEST_INFLATE_BYTES) return null;

      const storedAs = buf.readUInt8(36);
      // Encrypted manifest body cannot be parsed without key; fall back to legendary info
      if ((storedAs & 0x2) !== 0) return null;

      const rawBody = buf.subarray(headerSize);
      if ((storedAs & 0x1) === 0 && rawBody.length > MAX_EPIC_MANIFEST_INFLATE_BYTES) {
        return null;
      }
      const body =
        (storedAs & 0x1) !== 0
          ? zlib.inflateSync(rawBody, { maxOutputLength: MAX_EPIC_MANIFEST_INFLATE_BYTES })
          : rawBody;
      if (body.length < 4) return null;

      const metaSize = body.readUInt32LE(0);
      if (metaSize < 4 || metaSize > body.length) return null;
      let offset = metaSize;

      // ChunkDataList (CDL)
      if (offset + 9 > body.length) return null;
      const cdlSize = body.readUInt32LE(offset);
      const cdlCount = body.readUInt32LE(offset + 5);
      const cdlEnd = offset + cdlSize;
      if (cdlSize < 9 || cdlEnd > body.length) return null;

      const windowSizeStart = offset + 9 + cdlCount * (16 + 8 + 20 + 1);
      const fileSizeStart = windowSizeStart + cdlCount * 4;
      if (fileSizeStart + cdlCount * 8 > cdlEnd) return null;

      let uncompressedChunkSize = 0n;
      for (let i = 0; i < cdlCount; i += 1) {
        uncompressedChunkSize += BigInt(body.readUInt32LE(windowSizeStart + i * 4));
      }
      let downloadSize = 0n;
      for (let i = 0; i < cdlCount; i += 1) {
        const sz = body.readBigInt64LE(fileSizeStart + i * 8);
        if (sz > 0n) downloadSize += sz;
      }

      // Advance past entire CDL (preserving FL >= 22 trailing fields)
      offset += cdlSize;

      // FileManifestList (FML)
      if (offset + 9 > body.length) return null;
      const fmlSize = body.readUInt32LE(offset);
      const fmlCount = body.readUInt32LE(offset + 5);
      const fmlEnd = offset + fmlSize;
      if (fmlSize < 9 || fmlEnd > body.length) return null;

      let pos = offset + 9;
      const skipFString = () => {
        if (pos + 4 > fmlEnd) {
          throw new RangeError('Truncated FString length in Epic FML');
        }
        const len = body.readInt32LE(pos);
        pos += 4;
        if (len > 0) pos += len;
        else if (len < 0) pos += -len * 2;
        if (pos < offset + 9 || pos > fmlEnd) {
          throw new RangeError('Out-of-bounds FString payload in Epic FML');
        }
      };

      for (let i = 0; i < fmlCount; i += 1) skipFString();
      for (let i = 0; i < fmlCount; i += 1) skipFString();
      pos += fmlCount * 21;
      if (pos > fmlEnd) return null;

      for (let i = 0; i < fmlCount; i += 1) {
        if (pos + 4 > fmlEnd) return null;
        const tagCount = body.readUInt32LE(pos);
        pos += 4;
        for (let t = 0; t < tagCount; t += 1) skipFString();
      }

      let diskSize = 0n;
      for (let i = 0; i < fmlCount; i += 1) {
        if (pos + 4 > fmlEnd) return null;
        const partCount = body.readUInt32LE(pos);
        pos += 4;
        for (let p = 0; p < partCount; p += 1) {
          if (pos + 28 > fmlEnd) return null;
          const structSize = body.readUInt32LE(pos);
          if (structSize < 28 || pos + structSize > fmlEnd) return null;
          const partSize = body.readUInt32LE(pos + 24);
          diskSize += BigInt(partSize);
          pos += structSize;
        }
      }

      const rawDisk =
        fmlCount > 0
          ? Number(diskSize)
          : Number(diskSize) || Number(uncompressedChunkSize) || 0;
      const rawDl = Number(downloadSize) || 0;
      const validDisk = sanitizeGameInstallSizeBytes(rawDisk);
      if (!validDisk) return null;

      return {
        diskSize: validDisk,
        downloadSize: sanitizeGameInstallSizeBytes(rawDl) || validDisk,
      };
    }

    // 2. JSON or zlib-compressed JSON Manifest (optional UTF-8 BOM / leading ASCII whitespace)
    /** @param {Buffer} b */
    const findJsonStart = (b) => {
      let idx = 0;
      if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) idx = 3;
      while (
        idx < b.length &&
        (b[idx] === 0x20 || b[idx] === 0x09 || b[idx] === 0x0a || b[idx] === 0x0d)
      ) {
        idx += 1;
      }
      return idx < b.length && b[idx] === 0x7b ? idx : -1;
    };

    /** @type {string | null} */
    let jsonStr = null;
    if (findJsonStart(buf) >= 0) {
      if (buf.length > MAX_EPIC_MANIFEST_INFLATE_BYTES) return null;
      jsonStr = buf.toString('utf8').replace(/^\uFEFF/, '');
    } else {
      try {
        const inflated = zlib.inflateSync(buf, {
          maxOutputLength: MAX_EPIC_MANIFEST_INFLATE_BYTES,
        });
        if (findJsonStart(inflated) >= 0) {
          jsonStr = inflated.toString('utf8').replace(/^\uFEFF/, '');
        }
      } catch {
        // Not zlib JSON (or exceeded maxOutputLength zip-bomb cap)
      }
    }

    if (jsonStr) {
      const parsed = JSON.parse(jsonStr);
      if (!parsed || typeof parsed !== 'object') return null;

      const isEpicBlobFormat = Boolean(
        typeof parsed.ManifestFileVersion === 'string' ||
          (parsed.ChunkFilesizeList && typeof parsed.ChunkFilesizeList === 'object') ||
          (parsed.ChunkHashList && typeof parsed.ChunkHashList === 'object') ||
          typeof parsed.bIsFileData === 'boolean'
      );

      /** @param {unknown} val */
      const parseManifestInt = (val) => {
        if (typeof val === 'number') {
          return Number.isFinite(val) && val > 0 ? val : 0;
        }
        if (typeof val === 'string') {
          const trimmed = val.trim();
          if (isEpicBlobFormat || trimmed.length === 12 || trimmed.length === 24) {
            const decoded = decodeEpicJsonBlobInt(trimmed);
            if (decoded !== null) return decoded > 0 ? decoded : 0;
          }
          const n = Number(trimmed);
          return Number.isFinite(n) && n > 0 ? n : 0;
        }
        return 0;
      };

      let diskSize = 0;
      if (Array.isArray(parsed.FileManifestList)) {
        for (const f of parsed.FileManifestList) {
          if (f && Array.isArray(f.FileChunkParts)) {
            for (const part of f.FileChunkParts) {
              if (part) {
                diskSize += parseManifestInt(part.Size);
              }
            }
          }
        }
      }

      let downloadSize = 0;
      if (parsed.ChunkFilesizeList && typeof parsed.ChunkFilesizeList === 'object') {
        for (const szVal of Object.values(parsed.ChunkFilesizeList)) {
          downloadSize += parseManifestInt(szVal);
        }
      }

      const rawDisk = diskSize || Number(parsed.diskSize || parsed.installSize || 0);
      const validDisk = sanitizeGameInstallSizeBytes(rawDisk);
      if (!validDisk) return null;
      const rawDl = downloadSize || Number(parsed.downloadSize || 0);

      return {
        diskSize: validDisk,
        downloadSize: sanitizeGameInstallSizeBytes(rawDl) || validDisk,
      };
    }
  } catch (err) {
    diagLog.warn('inspector.parseEpicManifest', err);
  }
  return null;
}

module.exports = {
  MAX_PLAUSIBLE_GAME_INSTALL_BYTES,
  MAX_EPIC_MANIFEST_INFLATE_BYTES,
  sanitizeGameInstallSizeBytes,
  decodeEpicJsonBlobInt,
  parseByteCountOrFormattedSize,
  parseStorageRequirementBytes,
  parseSteamLibraryFoldersVdf,
  parseSteamAcf,
  parseSteamLogLineTimestampMs,
  normalizeSteamUpdatePhase,
  integrateSteamRateSamples,
  parseSteamContentLogForApp,
  parseEpicManifestBuffer,
};
