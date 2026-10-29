'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { diagLog } = require('../utils/diagnosticLogger.cjs');
const {
  computeAppxPublisherId,
  computePackageFamilyName,
  deriveDefaultScidFromTitleId,
  parseMicrosoftGameConfig,
  parseAppxManifest,
} = require('../storefronts/xbox/msixvcXvdParser.cjs');

/**
 * Inspect Windows executable DOS/PE header to distinguish valid 32/64-bit PE executables
 * from legacy 16-bit MS-DOS MZ executables and identify 64-bit PE32+/ARM64 binaries.
 * @param {string} filePath
 * @param {Record<string, any>} [options]
 */
function inspectWindowsExecutableHeader(filePath, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const allowSyntheticStub = Boolean(
    opts.allowSyntheticStub ||
      ((process.env.VITEST || process.env.NODE_ENV === 'test') && !opts.strictPe)
  );
  if (!filePath || typeof filePath !== 'string') {
    return {
      exists: false,
      isValidPe: false,
      is64Bit: false,
      isX64: false,
      isX86: false,
      isArm64: false,
      is16BitDos: false,
    };
  }
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return {
        exists: false,
        isValidPe: false,
        is64Bit: false,
        isX64: false,
        isX86: false,
        isArm64: false,
        is16BitDos: false,
      };
    }
    const size = stat.size;

    if (size < 2) {
      return {
        exists: true,
        isValidPe: false,
        is64Bit: false,
        isX64: false,
        isX86: false,
        isArm64: false,
        is16BitDos: false,
      };
    }

    const readLen = Math.min(64, size);
    const dosHeader = Buffer.alloc(readLen);
    const bytesRead = fs.readSync(fd, dosHeader, 0, readLen, 0);
    if (bytesRead < 2 || dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
      return {
        exists: true,
        isValidPe: false,
        is64Bit: false,
        isX64: false,
        isX86: false,
        isArm64: false,
        is16BitDos: false,
      };
    }

    if (size < 64 || bytesRead < 64) {
      const isAsciiSyntheticMz =
        allowSyntheticStub &&
        dosHeader
          .subarray(2, bytesRead)
          .every((b) => b === 0 || (b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x0d);
      if (!isAsciiSyntheticMz) {
        return {
          exists: true,
          isValidPe: false,
          is64Bit: false,
          isX64: false,
          isX86: false,
          isArm64: false,
          is16BitDos: false,
        };
      }
      return {
        exists: true,
        isValidPe: true,
        is64Bit: false,
        isX64: false,
        isX86: false,
        isArm64: false,
        is16BitDos: false,
        isSyntheticStub: true,
      };
    }

    const peOffset = dosHeader.readUInt32LE(0x3c);
    const isZeroedSyntheticMz =
      peOffset === 0 && dosHeader.subarray(2, 64).every((b) => b === 0);
    if (peOffset < 0x40 || peOffset + 6 > size) {
      if (allowSyntheticStub && isZeroedSyntheticMz) {
        return {
          exists: true,
          isValidPe: true,
          is64Bit: false,
          isX64: false,
          isX86: false,
          isArm64: false,
          is16BitDos: false,
          isSyntheticStub: true,
        };
      }
      return {
        exists: true,
        isValidPe: false,
        is64Bit: false,
        isX64: false,
        isX86: false,
        isArm64: false,
        is16BitDos: !isZeroedSyntheticMz && peOffset < 0x40,
      };
    }

    const peBuf = Buffer.alloc(6);
    const peBytesRead = fs.readSync(fd, peBuf, 0, 6, peOffset);
    if (
      peBytesRead < 6 ||
      peBuf[0] !== 0x50 ||
      peBuf[1] !== 0x45 ||
      peBuf[2] !== 0x00 ||
      peBuf[3] !== 0x00
    ) {
      return {
        exists: true,
        isValidPe: false,
        is64Bit: false,
        isX64: false,
        isX86: false,
        isArm64: false,
        is16BitDos: true,
      };
    }

    const machine = peBuf.readUInt16LE(4);
    const machineHex = `0x${machine.toString(16).padStart(4, '0')}`;
    const isX64 = machine === 0x8664;
    const isX86 = machine === 0x014c;
    const isArm64 = machine === 0xaa64;
    const is64Bit = isX64 || isArm64;
    let requiresElevation = false;
    if (opts.inspectElevationManifest) {
      const elevationRe =
        /requestedExecutionLevel[^>]*level\s*=\s*["'](?:requireAdministrator|highestAvailable)["']/i;
      try {
        const sidecarManifest = `${filePath}.manifest`;
        if (fs.existsSync(sidecarManifest)) {
          const manifestText = fs.readFileSync(sidecarManifest, 'utf8');
          if (elevationRe.test(manifestText)) {
            requiresElevation = true;
          }
        }
      } catch {}
      if (!requiresElevation) {
        try {
          // Locate .rsrc section if present in COFF section headers, otherwise scan trailing 256 KiB
          const coffHdrBuf = Buffer.alloc(24);
          const coffRead = fs.readSync(fd, coffHdrBuf, 0, 24, peOffset);
          let scanOffset = Math.max(0, size - 262144);
          let scanLen = Math.min(262144, size - scanOffset);
          if (coffRead === 24) {
            const numSections = coffHdrBuf.readUInt16LE(6);
            const sizeOfOptionalHeader = coffHdrBuf.readUInt16LE(20);
            const secTableOffset = peOffset + 24 + sizeOfOptionalHeader;
            if (numSections > 0 && numSections <= 64 && secTableOffset + numSections * 40 <= size) {
              const secBuf = Buffer.alloc(numSections * 40);
              if (fs.readSync(fd, secBuf, 0, secBuf.length, secTableOffset) === secBuf.length) {
                for (let i = 0; i < numSections; i++) {
                  const base = i * 40;
                  const secName = secBuf
                    .subarray(base, base + 8)
                    .toString('ascii')
                    .replace(/\0+$/, '');
                  if (secName === '.rsrc') {
                    const rawSize = secBuf.readUInt32LE(base + 16);
                    const rawPtr = secBuf.readUInt32LE(base + 20);
                    if (rawPtr > 0 && rawSize > 0 && rawPtr < size) {
                      scanOffset = rawPtr;
                      scanLen = Math.min(rawSize, 524288, size - rawPtr);
                    }
                    break;
                  }
                }
              }
            }
          }
          if (scanLen > 0) {
            const rsrcBuf = Buffer.alloc(scanLen);
            const rsrcRead = fs.readSync(fd, rsrcBuf, 0, scanLen, scanOffset);
            if (rsrcRead > 0 && elevationRe.test(rsrcBuf.subarray(0, rsrcRead).toString('latin1'))) {
              requiresElevation = true;
            }
          }
        } catch {}
      }
    }
    return {
      exists: true,
      isValidPe: true,
      is64Bit,
      isX64,
      isX86,
      isArm64,
      is16BitDos: false,
      machine,
      machineHex,
      ...(opts.inspectElevationManifest ? { requiresElevation } : {}),
    };
  } catch (err) {
    diagLog.debug('inspector.peHeader', err, { filePath });
    return {
      exists: false,
      isValidPe: false,
      is64Bit: false,
      isX64: false,
      isX86: false,
      isArm64: false,
      is16BitDos: false,
    };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error
      }
    }
  }
}

/**
 * Inspect macOS Mach-O executable header to distinguish 64-bit, 32-bit only (i386), and Universal (Fat) binaries.
 */
function inspectMacMachOHeader(filePath) {
  let fd = null;
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { isMachO: false, is64Bit: false, is32BitOnly: false };
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 4) {
      return { isMachO: false, is64Bit: false, is32BitOnly: false };
    }
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(168);
    const bytesRead = fs.readSync(fd, buf, 0, 168, 0);
    if (bytesRead < 4) {
      return { isMachO: false, is64Bit: false, is32BitOnly: false };
    }

    const magicLE = buf.readUInt32LE(0);
    const magicBE = buf.readUInt32BE(0);

    if (magicLE === 0xfeedfacf || magicBE === 0xfeedfacf) {
      return { isMachO: true, is64Bit: true, is32BitOnly: false };
    }
    if (magicLE === 0xfeedface || magicBE === 0xfeedface) {
      return { isMachO: true, is64Bit: false, is32BitOnly: true };
    }
    if (magicBE === 0xcafebabe && bytesRead >= 8) {
      const nfat = buf.readUInt32BE(4);
      if (nfat >= 1 && nfat <= 8 && bytesRead >= 8 + nfat * 20) {
        let has64 = false;
        let has32 = false;
        for (let i = 0; i < nfat; i++) {
          const cputype = buf.readUInt32BE(8 + i * 20);
          if ((cputype & 0x01000000) !== 0) {
            has64 = true;
          } else {
            has32 = true;
          }
        }
        return { isMachO: true, is64Bit: has64, is32BitOnly: !has64 && has32 };
      }
    }
    return { isMachO: false, is64Bit: false, is32BitOnly: false };
  } catch (err) {
    diagLog.debug('inspector.machOHeader', err, { filePath });
    return { isMachO: false, is64Bit: false, is32BitOnly: false };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error
      }
    }
  }
}

/**
 * Parse Valve VDF libraryfolders.vdf to extract all Steam library paths.
 */
function parseSteamLibraryFoldersVdf(vdfContent) {
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
 */
function parseSteamAcf(acfContent) {
  if (!acfContent || typeof acfContent !== 'string') return null;
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
 * Note: Steam logs `Running Update,Downloading,Staging,` simultaneously during SteamPipe downloads;
 * `Downloading` must take precedence over `Staging` until download chunks finish (`Committing`).
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
  for (let i = 0; i < rateSamples.length; i++) {
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

  const validMinTs = Number.isFinite(minTimestampMs) && minTimestampMs > 0 ? minTimestampMs : 0;
  const effectiveNowMs = Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  const appPrefixRe = new RegExp(`AppID\\s+${String(appId)}\\b`, 'i');
  const lines = logContent.split(/\r?\n/);
  let lastAppEventTs = 0;

  for (const line of lines) {
    const lineTs = parseSteamLogLineTimestampMs(line);

    const rateMatch =
      line.match(/Current download rate:\s*([\d.]+)\s*Mbps/i) ||
      line.match(
        /Increasing target number of download connections to \d+\s*\(rate was [\d.]+,\s*now\s*([\d.]+)\)/i
      );
    if (rateMatch) {
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
          if (
            lineTs > 0 &&
            !result.fullyInstalled &&
            !result.updateCanceled &&
            !result.isSuspended
          ) {
            result.rateSamples.push({ tsMs: lineTs, speedBytesPerSec: bps });
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
      !/\b(?:Update Running|Update Started|Update Queued|Update Required|Uninstalling)\b/i.test(line)
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

  // Discard completed/cancelled historical sessions that ended before task.startedAt,
  // while keeping unfinished active downloads (even if started in Steam before One Launcher attached).
  if (
    validMinTs > 0 &&
    lastAppEventTs > 0 &&
    lastAppEventTs < validMinTs - 15000 &&
    (result.fullyInstalled || result.updateCanceled || (!result.isRunning && !result.updateStarted))
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
    lastRateSampleTs > 0 && effectiveNowMs >= lastRateSampleTs && effectiveNowMs - lastRateSampleTs <= 120000;

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
 * Maximum plausible game installation size (2 TiB = 2,199,023,255,552 bytes).
 * Rejects corrupted/uninitialized/mis-parsed manifest sizes (e.g. 253,114.6 GB).
 */
const MAX_PLAUSIBLE_GAME_INSTALL_BYTES = 2 * 1024 * 1024 * 1024 * 1024;

/**
 * Validate and round a byte count into a plausible positive game install size, or undefined.
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
  const m = trimmed.match(/^(\d{1,3}(?:,\d{3})+|\d+(?:[.,]\d+)?)\s*(tb|tib|gb|gib|mb|mib|kb|kib|b)$/i);
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
 */
function parseStorageRequirementBytes(htmlOrText) {
  if (!htmlOrText) return undefined;
  const rawStr = typeof htmlOrText === 'string' ? htmlOrText : JSON.stringify(htmlOrText);

  // 1. Convert structural HTML tags to newlines/spaces, strip remaining tags, decode entities
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

  // 2. Merge standalone storage-heading lines (e.g. <h4>Storage</h4><p>45 GB</p>) with next line
  const STORAGE_NOUN_ALT =
    'storage(?:\\s+space)?|hard\\s+drive(?:\\s+space)?|hard\\s+disk(?:\\s+space)?|disk\\s+space|hd\\s+space|hdd\\s+space|ssd\\s+space|free\\s+(?:hard\\s+)?(?:disk|drive)\\s+space|available\\s+(?:hard\\s+)?(?:disk|drive)?\\s*space|speicherplatz|festplattenspeicher|festplatte|espace\\s+(?:disque|de\\s+stockage)|stockage|almacenamiento|espacio\\s+en\\s+disco|spazio\\s+(?:su\\s+disco|disponibile)|armazenamento|miejsce\\s+na\\s+dysku';
  const standaloneHeadingRe = new RegExp(
    `^(?:\\*\\s*|-\\s*|•\\s*)?(?:${STORAGE_NOUN_ALT})\\s*[:\\-–—]?\\s*$`,
    'i'
  );
  const mergedLines = [];
  for (let i = 0; i < rawLines.length; i++) {
    if (standaloneHeadingRe.test(rawLines[i]) && i + 1 < rawLines.length) {
      const cleanHeading = rawLines[i].replace(/\s*[:\-–—]?\s*$/, '');
      mergedLines.push(`${cleanHeading}: ${rawLines[i + 1]}`);
      i++;
    } else {
      mergedLines.push(rawLines[i]);
    }
  }

  // 3. Filter/slice lines starting with non-storage hardware labels (Memory, Graphics, CPU, OS, etc.)
  const nonStoragePrefixRe =
    /^\s*(?:(?:minimum|recommended)\s*:\s*)?(?:\*\s*|-\s*|•\s*)?(?:memory|ram|system\s+memory|arbeitsspeicher|graphics|grafik(?:karte)?|video(?:\s+card)?|gpu|vram|processor|prozessor|cpu|os|operating\s+system|betriebssystem|sound(?:\s+card)?|audio|network|broadband|directx)\s*:/i;
  const inlineStorageLabelRe = new RegExp(`\\b(?:${STORAGE_NOUN_ALT})\\s*:`, 'i');

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

  // Pass 1: Explicit storage label before number (requiring colon, or dash on line-leading label)
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

  // Pass 2: Number before storage noun (e.g. "2.2GB of uncompressed free hard disk space (plus 400MB swap)")
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

  // Pass 3: Label without colon / SSD parenthetical fallback (without crossing parenthetical clauses)
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
 * Parse binary (magic 0x44bec00c) or JSON Epic Games `.manifest` buffers.
 */
function parseEpicManifestBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  try {
    // 1. Binary Manifest (magic 0x44BEC00C)
    if (buf.length >= 41 && buf.readUInt32LE(0) === 0x44bec00c) {
      const headerSize = buf.readUInt32LE(4);
      if (headerSize < 41 || headerSize > buf.length) return null;

      const storedAs = buf.readUInt8(36);
      // Encrypted manifest body cannot be parsed without key; fall back to legendary info
      if ((storedAs & 0x2) !== 0) return null;

      const rawBody = buf.subarray(headerSize);
      const body = (storedAs & 0x1) !== 0 ? zlib.inflateSync(rawBody) : rawBody;
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
      for (let i = 0; i < cdlCount; i++) {
        uncompressedChunkSize += BigInt(body.readUInt32LE(windowSizeStart + i * 4));
      }
      let downloadSize = 0n;
      for (let i = 0; i < cdlCount; i++) {
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

      for (let i = 0; i < fmlCount; i++) skipFString();
      for (let i = 0; i < fmlCount; i++) skipFString();
      pos += fmlCount * 21;
      if (pos > fmlEnd) return null;

      for (let i = 0; i < fmlCount; i++) {
        if (pos + 4 > fmlEnd) return null;
        const tagCount = body.readUInt32LE(pos);
        pos += 4;
        for (let t = 0; t < tagCount; t++) skipFString();
      }

      let diskSize = 0n;
      for (let i = 0; i < fmlCount; i++) {
        if (pos + 4 > fmlEnd) return null;
        const partCount = body.readUInt32LE(pos);
        pos += 4;
        for (let p = 0; p < partCount; p++) {
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
    const findJsonStart = (b) => {
      let idx = 0;
      if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) idx = 3;
      while (
        idx < b.length &&
        (b[idx] === 0x20 || b[idx] === 0x09 || b[idx] === 0x0a || b[idx] === 0x0d)
      ) {
        idx++;
      }
      return idx < b.length && b[idx] === 0x7b ? idx : -1;
    };

    let jsonStr = null;
    if (findJsonStart(buf) >= 0) {
      jsonStr = buf.toString('utf8').replace(/^\uFEFF/, '');
    } else {
      try {
        const inflated = zlib.inflateSync(buf);
        if (findJsonStart(inflated) >= 0) {
          jsonStr = inflated.toString('utf8').replace(/^\uFEFF/, '');
        }
      } catch {
        // Not zlib JSON
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

const XBOX_SYSTEM_OR_UTILITY_IDENTITY_RE =
  /^(?:Microsoft\.(?:GamingServices|GamingApp|XboxGamingOverlay|XboxGameOverlay|XboxIdentityProvider|XboxSpeechToTextOverlay|Xbox\.TCUI|WindowsStore|StorePurchaseApp|DesktopAppInstaller|UI\.|VCLibs|NET\.|DirectX|Services\.Store|Advertising|Wallet|SecHealthUI|WindowsTerminal)|Windows\.|System\.)/i;

function isXboxNonGameUtilityIdentity(identityName, flags = {}) {
  if (flags.isFramework || flags.isResourcePackage || flags.isDlcAddon) {
    return true;
  }
  if (flags.hasExecutable === false) {
    return true;
  }
  const cleanName = String(identityName || '').trim();
  if (!cleanName) return false;
  return XBOX_SYSTEM_OR_UTILITY_IDENTITY_RE.test(cleanName);
}

function cleanManifestDisplayName(rawName) {
  const trimmed = String(rawName || '').trim();
  if (!trimmed || /^ms-resource:/i.test(trimmed)) return '';
  return trimmed;
}

/**
 * Resolves a relative file path inside `baseDir` with a fast `fs.existsSync` check first,
 * followed by a case-insensitive segment-by-segment `fs.readdirSync` fallback so MSIXVC `$MFT`
 * casing (`MicrosoftGame.Config`, `appxmanifest.xml`, `content/...`) resolves cleanly on
 * case-sensitive APFS/Linux volumes as well as Windows NTFS.
 *
 * @param {string} baseDir
 * @param {string} relCandidate
 * @returns {string}
 */
function resolveCaseInsensitiveRelFile(baseDir, relCandidate) {
  if (!baseDir || typeof baseDir !== 'string' || !relCandidate || typeof relCandidate !== 'string') {
    return '';
  }
  try {
    const exactPath = path.join(baseDir, relCandidate);
    if (fs.existsSync(exactPath) && fs.statSync(exactPath).isFile()) {
      return exactPath;
    }
    const parts = relCandidate.split(/[\\/]+/).filter(Boolean);
    if (parts.length === 0) return '';
    let current = baseDir;
    for (let i = 0; i < parts.length; i += 1) {
      const seg = parts[i];
      if (seg === '.' || seg === '..') return '';
      if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) {
        return '';
      }
      const exactStep = path.join(current, seg);
      if (fs.existsSync(exactStep)) {
        current = exactStep;
        continue;
      }
      const lowerSeg = seg.toLowerCase();
      const entries = fs.readdirSync(current);
      const matched = entries.find((e) => e.toLowerCase() === lowerSeg);
      if (!matched) return '';
      current = path.join(current, matched);
    }
    if (fs.existsSync(current) && fs.statSync(current).isFile()) {
      return current;
    }
  } catch {}
  return '';
}

/**
 * Returns `true` when `peInfo` represents an executable runnable under x64/x86 Wine or x64 Windows
 * (`AMD64` `0x8664`, `I386` `0x014c`, or synthetic test MZ stubs), rejecting `ARM64` (`0xaa64`)
 * binaries unless running natively on Windows ARM64.
 *
 * @param {Record<string, any> | null | undefined} peInfo
 * @param {{ hostPlatform?: string, hostArch?: string }} [options]
 * @returns {boolean}
 */
function isCompatibleX86OrX64PeHeader(peInfo, options = {}) {
  if (!peInfo || peInfo.isValidPe !== true) return false;
  const hostPlatform = options.hostPlatform || process.platform;
  const hostArch = options.hostArch || process.arch;
  if (peInfo.machine === 0xaa64 || peInfo.isArm64 === true) {
    return hostPlatform === 'win32' && hostArch === 'arm64';
  }
  return true;
}

function readXmlFromInputOrCandidatePaths(xmlOrPath, candidateFileNames) {
  if (Buffer.isBuffer(xmlOrPath)) {
    return { xml: xmlOrPath.toString('utf8'), filePath: '', contentRootDir: '' };
  }
  if (typeof xmlOrPath !== 'string' || !xmlOrPath.trim()) {
    return { xml: '', filePath: '', contentRootDir: '' };
  }
  const trimmed = xmlOrPath.trim();
  if (trimmed.startsWith('<') || trimmed.startsWith('\uFEFF<')) {
    return { xml: trimmed.replace(/^\uFEFF/, ''), filePath: '', contentRootDir: '' };
  }
  try {
    if (!fs.existsSync(trimmed)) {
      return { xml: '', filePath: '', contentRootDir: '' };
    }
    const stat = fs.statSync(trimmed);
    if (stat.isFile()) {
      return {
        xml: fs.readFileSync(trimmed, 'utf8').replace(/^\uFEFF/, ''),
        filePath: trimmed,
        contentRootDir: path.dirname(trimmed),
      };
    }
    if (stat.isDirectory()) {
      for (const relCandidate of candidateFileNames) {
        const candidatePath = resolveCaseInsensitiveRelFile(trimmed, relCandidate);
        if (candidatePath) {
          return {
            xml: fs.readFileSync(candidatePath, 'utf8').replace(/^\uFEFF/, ''),
            filePath: candidatePath,
            contentRootDir: path.dirname(candidatePath),
          };
        }
      }
    }
  } catch (err) {
    diagLog.warn('inspector.readXboxManifest', err);
  }
  return { xml: '', filePath: '', contentRootDir: '' };
}

/**
 * Parses a Windows GamingServices `.GamingRoot` binary marker (`RGBX` + `u32LE(1)` + UTF-16LE folder path).
 * @param {Buffer|string} input Buffer or path to `.GamingRoot`
 * @param {string} [driveRoot] Optional drive root (e.g. `D:\` or `/Volumes/Games`)
 */
function parseGamingRootFile(input, driveRoot = '') {
  try {
    let buf = null;
    let inferredRoot = typeof driveRoot === 'string' ? driveRoot.trim() : '';
    if (Buffer.isBuffer(input)) {
      buf = input;
    } else if (typeof input === 'string' && input.trim()) {
      const filePath = input.trim();
      if (!fs.existsSync(filePath)) return null;
      buf = fs.readFileSync(filePath);
      if (!inferredRoot) {
        inferredRoot = path.dirname(filePath);
      }
    }
    if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
    if (
      buf[0] !== 0x52 || // 'R'
      buf[1] !== 0x47 || // 'G'
      buf[2] !== 0x42 || // 'B'
      buf[3] !== 0x58    // 'X'
    ) {
      return null;
    }
    const version = buf.readUInt32LE(4);
    if (version !== 1) return null;

    const rawTarget = buf
      .subarray(8)
      .toString('utf16le')
      .replace(/\0+/g, '')
      .trim()
      .replace(/^[\\/]+|[\\/]+$/g, '');
    if (!rawTarget || /[\x00-\x1f\x7f:]/.test(rawTarget)) {
      return null;
    }

    const segments = rawTarget
      .split(/[\\/]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length === 0 || segments.some((s) => s === '.' || s === '..')) {
      return null;
    }

    const relativePath = segments.join('/');
    const folderName = segments[segments.length - 1];
    let resolvedPath = '';
    if (inferredRoot) {
      if (/^[A-Za-z]:(?:[\\/]|$)/.test(inferredRoot)) {
        const normalizedDrive = /^[A-Za-z]:$/.test(inferredRoot)
          ? `${inferredRoot}\\`
          : inferredRoot;
        resolvedPath = path.win32.join(normalizedDrive, ...segments);
      } else {
        resolvedPath = path.join(inferredRoot, ...segments);
      }
    }

    return {
      valid: true,
      version,
      relativePath,
      folderName,
      resolvedPath,
    };
  } catch (err) {
    diagLog.warn('inspector.parseGamingRootFile', err);
    return null;
  }
}

/**
 * Inspects a GDK `MicrosoftGame.config` XML buffer, string, file path, or game directory.
 * @param {Buffer|string} xmlOrPath
 */
function inspectMicrosoftGameConfig(xmlOrPath) {
  const { xml, filePath, contentRootDir } = readXmlFromInputOrCandidatePaths(xmlOrPath, [
    'MicrosoftGame.config',
    path.join('Content', 'MicrosoftGame.config'),
  ]);
  if (!xml) return null;
  const parsed = parseMicrosoftGameConfig(xml);
  if (!parsed) return null;

  const hasMainPackageDependency = /<(?:[\w]+:)?MainPackageDependency\b/i.test(xml);
  const extractAttrLocal = (tagText, attrName) => {
    const re = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
    const m = re.exec(tagText);
    return m ? (m[1] !== undefined ? m[1] : m[2] || '').trim() : '';
  };
  const sanitizeOverrideWorkingDir = (rawWd) => {
    const clean = String(rawWd || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/^\/+|\/+$/g, '');
    if (!clean || clean === '.' || /^[A-Za-z]:/.test(clean)) return '';
    const parts = clean.split('/').filter(Boolean);
    if (parts.length === 0 || parts.some((p) => p === '..' || p === '.')) return '';
    return parts.join('/');
  };
  const overrideWorkDirByExeKey = new Map();
  const exeTagRe = /<Executable\b([^>]*)\/?>/gi;
  let exeTagMatch;
  while ((exeTagMatch = exeTagRe.exec(xml)) !== null) {
    const attrs = exeTagMatch[1];
    const rawName = extractAttrLocal(attrs, 'Name');
    const rawId = extractAttrLocal(attrs, 'Id');
    const rawWd =
      extractAttrLocal(attrs, 'OverrideWorkingDirectory') ||
      extractAttrLocal(attrs, 'WorkingDirectory');
    const cleanWd = sanitizeOverrideWorkingDir(rawWd);
    if (!cleanWd) continue;
    if (rawName) {
      const normKey = rawName.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
      overrideWorkDirByExeKey.set(`name:${normKey}`, cleanWd);
    }
    if (rawId) {
      overrideWorkDirByExeKey.set(`id:${rawId.toLowerCase()}`, cleanWd);
    }
  }

  const NON_PRIMARY_EXE_BASENAME_RE =
    /(?:^|[-_])(?:gamelaunchhelper|custominstallexec|custominstallactions|crashreporter|crashhandler|crashpad|unitycrashhandler|bugsplat|unrealcefsubprocess|cefprocess|prerequisites|vc_redist|vcredist|dxsetup|directx|dotnet|unins\d*)/i;
  const rawExecutables = Array.isArray(parsed.executables) ? parsed.executables : [];
  const executables = rawExecutables.map((e) => {
    const normName = String(e?.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const base = path.posix.basename(normName);
    const isAuxHelper = Boolean(e?.isHelperStub || NON_PRIMARY_EXE_BASENAME_RE.test(base));
    const overrideWorkingDirectory =
      overrideWorkDirByExeKey.get(`name:${normName.toLowerCase()}`) ||
      (e?.id ? overrideWorkDirByExeKey.get(`id:${String(e.id).toLowerCase()}`) : '') ||
      '';
    return {
      ...e,
      isHelperStub: isAuxHelper,
      ...(overrideWorkingDirectory ? { overrideWorkingDirectory } : {}),
    };
  });
  const nonHelperExecutables = executables.filter((e) => !e.isHelperStub && !e.isGameLaunchHelper);
  const scoreConfigExeArch = (/** @type {any} */ exeEntry) => {
    const relName = String(exeEntry?.name || '');
    const explicitArmPath = /(?:^|[\\/_.-])(?:arm64|aarch64)(?:$|[\\/_.-])/i.test(relName);
    if (contentRootDir) {
      const diskPath = resolveCaseInsensitiveRelFile(contentRootDir, relName);
      if (diskPath) {
        const pe = inspectWindowsExecutableHeader(diskPath);
        if (pe.isValidPe) {
          if (!isCompatibleX86OrX64PeHeader(pe)) return -100;
          if (pe.isX64) return 30;
          if (pe.isX86) return 20;
          return 10;
        }
      }
    }
    if (explicitArmPath && !(process.platform === 'win32' && process.arch === 'arm64')) {
      return -50;
    }
    return 0;
  };
  let primaryExecObj = nonHelperExecutables[0] || executables[0] || null;
  if (nonHelperExecutables.length > 1) {
    let bestScore = -Infinity;
    for (const cand of nonHelperExecutables) {
      const sc = scoreConfigExeArch(cand);
      if (sc > bestScore) {
        bestScore = sc;
        primaryExecObj = cand;
      }
    }
  }
  let primaryExecutable = primaryExecObj ? primaryExecObj.name : parsed.primaryExecutable || '';
  if (primaryExecutable && contentRootDir) {
    const resolvedOnDisk = resolveCaseInsensitiveRelFile(contentRootDir, primaryExecutable);
    if (resolvedOnDisk) {
      primaryExecutable = path
        .relative(contentRootDir, resolvedOnDisk)
        .replace(/\\/g, '/');
    }
  }
  const overrideWorkingDirectory =
    (primaryExecObj && primaryExecObj.overrideWorkingDirectory) || '';
  const helperExecObj = executables.find((e) => e.isGameLaunchHelper) || null;
  let gameLaunchHelperExecutable = helperExecObj ? helperExecObj.name : '';
  if (!gameLaunchHelperExecutable && contentRootDir) {
    try {
      const helperCandidate = resolveCaseInsensitiveRelFile(contentRootDir, 'gamelaunchhelper.exe');
      if (helperCandidate) {
        gameLaunchHelperExecutable = path.basename(helperCandidate);
      }
    } catch {}
  }

  const appId = (primaryExecObj && primaryExecObj.id) || (executables[0] && executables[0].id) || 'Game';
  const packageFamilyName = parsed.packageFamilyName || '';
  const appUserModelId = packageFamilyName && appId ? `${packageFamilyName}!${appId}` : '';
  const isDlcAddon = Boolean(hasMainPackageDependency || executables.length === 0);
  const isNonGameUtility = isXboxNonGameUtilityIdentity(parsed.identity?.name, {
    isDlcAddon,
    hasExecutable: executables.length > 0,
  });
  const rawDisplayName = parsed.shellVisuals?.defaultDisplayName || '';
  const displayName = cleanManifestDisplayName(rawDisplayName);

  return {
    ...parsed,
    executables,
    primaryExecutable,
    overrideWorkingDirectory,
    identityName: parsed.identity?.name || '',
    publisher: parsed.identity?.publisher || '',
    version: parsed.identity?.version || '',
    displayName,
    rawDisplayName,
    publisherDisplayName: parsed.shellVisuals?.publisherDisplayName || '',
    appId,
    appUserModelId,
    gameLaunchHelperExecutable,
    requiresCoreWindow: false,
    isDlcAddon,
    isNonGameUtility,
    configFilePath: filePath,
    contentRootDir,
    configDir: contentRootDir,
  };
}

/**
 * Inspects an Appx/MSIX `AppxManifest.xml` buffer, string, file path, or game directory.
 * @param {Buffer|string} xmlOrPath
 */
function inspectAppxManifest(xmlOrPath) {
  const { xml, filePath, contentRootDir } = readXmlFromInputOrCandidatePaths(xmlOrPath, [
    'AppxManifest.xml',
    path.join('Content', 'AppxManifest.xml'),
  ]);
  if (!xml) return null;
  const parsed = parseAppxManifest(xml);
  if (!parsed) return null;

  const extractAttr = (tagText, attrName) => {
    const re = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
    const m = re.exec(tagText);
    return m ? (m[1] !== undefined ? m[1] : m[2] || '').trim() : '';
  };
  const normRel = (p) =>
    String(p || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .trim();

  const logoMatch = /<Logo(?:\s[^>]*)?>([\s\S]*?)<\/Logo>/i.exec(xml);
  const visualMatch = /<(?:[\w]+:)?VisualElements\b([^>]*)\/?>/i.exec(xml);
  const splashMatch = /<(?:[\w]+:)?SplashScreen\b([^>]*)\/?>/i.exec(xml);
  const visualDisplayName = visualMatch ? extractAttr(visualMatch[1], 'DisplayName') : '';
  const rawDisplayName = visualDisplayName || parsed.displayName || '';
  const displayName = cleanManifestDisplayName(rawDisplayName);

  const shellVisuals = {
    defaultDisplayName: displayName,
    publisherDisplayName: parsed.publisherDisplayName || '',
    storeLogo: logoMatch ? normRel(logoMatch[1]) : '',
    square150x150Logo: visualMatch ? normRel(extractAttr(visualMatch[1], 'Square150x150Logo')) : '',
    square44x44Logo: visualMatch ? normRel(extractAttr(visualMatch[1], 'Square44x44Logo')) : '',
    splashScreenImage: splashMatch ? normRel(extractAttr(splashMatch[1], 'Image')) : '',
  };

  const apps = Array.isArray(parsed.applications) ? parsed.applications : [];
  const nonHelperApps = apps.filter(
    (a) => a.executable && path.posix.basename(a.executable).toLowerCase() !== 'gamelaunchhelper.exe'
  );
  let nonHelperApp = nonHelperApps[0] || null;
  if (nonHelperApps.length > 1) {
    let bestAppScore = -Infinity;
    for (const appCand of nonHelperApps) {
      let sc = /(?:^|[\\/_.-])(?:arm64|aarch64)(?:$|[\\/_.-])/i.test(appCand.executable) ? -50 : 0;
      if (contentRootDir) {
        const diskPath = resolveCaseInsensitiveRelFile(contentRootDir, appCand.executable);
        if (diskPath) {
          const pe = inspectWindowsExecutableHeader(diskPath);
          if (pe.isValidPe) {
            sc = !isCompatibleX86OrX64PeHeader(pe) ? -100 : pe.isX64 ? 30 : pe.isX86 ? 20 : 10;
          }
        }
      }
      if (sc > bestAppScore) {
        bestAppScore = sc;
        nonHelperApp = appCand;
      }
    }
  }
  const primaryApplication = nonHelperApp || apps.find((a) => a.executable) || apps[0] || null;
  let primaryExecutable = primaryApplication?.executable || '';
  if (primaryExecutable && contentRootDir) {
    const resolvedAppxExe = resolveCaseInsensitiveRelFile(contentRootDir, primaryExecutable);
    if (resolvedAppxExe) {
      primaryExecutable = path
        .relative(contentRootDir, resolvedAppxExe)
        .replace(/\\/g, '/');
    }
  }
  const appId = primaryApplication?.id || 'App';
  const packageFamilyName = parsed.packageFamilyName || '';
  const appUserModelId = packageFamilyName && appId ? `${packageFamilyName}!${appId}` : '';

  const requiresCoreWindow = Boolean(
    !parsed.hasFullTrustApplication &&
      apps.length > 0 &&
      apps.every((a) => a.isPureUwpCoreWindow)
  );
  const hasAnyExecutable = Boolean(primaryExecutable);
  const isDlcAddon = Boolean(parsed.hasMainPackageDependency || (!hasAnyExecutable && !requiresCoreWindow));
  const isNonGameUtility = isXboxNonGameUtilityIdentity(parsed.identity?.name, {
    isFramework: parsed.isFramework,
    isResourcePackage: parsed.isResourcePackage,
    isDlcAddon,
    hasExecutable: hasAnyExecutable || requiresCoreWindow,
  });

  return {
    ...parsed,
    identityName: parsed.identity?.name || '',
    publisher: parsed.identity?.publisher || '',
    version: parsed.identity?.version || '',
    processorArchitecture: parsed.identity?.processorArchitecture || '',
    displayName,
    rawDisplayName,
    shellVisuals,
    primaryApplication,
    primaryExecutable,
    appId,
    appUserModelId,
    requiresCoreWindow,
    isDlcAddon,
    isNonGameUtility,
    manifestFilePath: filePath,
    contentRootDir,
  };
}

module.exports = {
  MAX_PLAUSIBLE_GAME_INSTALL_BYTES,
  sanitizeGameInstallSizeBytes,
  decodeEpicJsonBlobInt,
  parseByteCountOrFormattedSize,
  inspectWindowsExecutableHeader,
  isCompatibleX86OrX64PeHeader,
  resolveCaseInsensitiveRelFile,
  inspectMacMachOHeader,
  parseSteamLibraryFoldersVdf,
  parseSteamAcf,
  integrateSteamRateSamples,
  parseSteamContentLogForApp,
  parseStorageRequirementBytes,
  parseEpicManifestBuffer,
  parseGamingRootFile,
  computeAppxPublisherId,
  computePackageFamilyName,
  deriveDefaultScidFromTitleId,
  inspectMicrosoftGameConfig,
  inspectAppxManifest,
  isXboxNonGameUtilityIdentity,
};
