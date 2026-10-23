'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');
const { diagLog } = require('../utils/diagnosticLogger.cjs');

/**
 * Inspect Windows executable DOS/PE header to distinguish valid 32/64-bit PE executables
 * from legacy 16-bit MS-DOS MZ executables and identify 64-bit PE32+/ARM64 binaries.
 */
function inspectWindowsExecutableHeader(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { isValidPe: false, is64Bit: false, is16BitDos: false };
  }
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const size = stat.size;

    if (size < 64) {
      return {
        isValidPe: true,
        is64Bit: false,
        is16BitDos: false,
        isSyntheticStub: true,
      };
    }

    const dosHeader = Buffer.alloc(64);
    const bytesRead = fs.readSync(fd, dosHeader, 0, 64, 0);
    if (bytesRead < 64) {
      return { isValidPe: true, is64Bit: false, is16BitDos: false, isSyntheticStub: true };
    }

    if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
      return { isValidPe: true, is64Bit: false, is16BitDos: false };
    }

    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (peOffset < 0x40 || peOffset + 6 > size) {
      return { isValidPe: false, is64Bit: false, is16BitDos: true };
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
      return { isValidPe: false, is64Bit: false, is16BitDos: true };
    }

    const machine = peBuf.readUInt16LE(4);
    const is64Bit = machine === 0x8664 || machine === 0xaa64;
    return {
      isValidPe: true,
      is64Bit,
      is16BitDos: false,
      machine,
    };
  } catch (err) {
    diagLog.debug('inspector.peHeader', err, { filePath });
    return { isValidPe: false, is64Bit: false, is16BitDos: false };
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
 * Parse Steam logs/content_log.txt tail content for real-time download & staging progress of an AppID.
 */
function parseSteamContentLogForApp(logContent, appId, minTimestampMs = 0) {
  const result = {
    bytesDownloaded: 0,
    bytesToDownload: 0,
    bytesStaged: 0,
    bytesToStage: 0,
    phase: undefined,
    fullyInstalled: false,
    updateStarted: false,
    isRunning: false,
    speedBytesPerSec: 0,
  };

  if (!logContent || typeof logContent !== 'string' || !appId) return result;

  const appPrefixRe = new RegExp(`AppID\\s+${String(appId)}\\b`, 'i');
  const lines = logContent.split(/\r?\n/);

  for (const line of lines) {
    if (minTimestampMs > 0) {
      const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\]/);
      if (tsMatch) {
        const lineTs = new Date(tsMatch[1].replace(' ', 'T')).getTime();
        if (Number.isFinite(lineTs) && lineTs < minTimestampMs - 10000) {
          continue;
        }
      }
    }

    const rateMatch =
      line.match(/Current download rate:\s*([\d.]+)\s*Mbps/i) ||
      line.match(
        /Increasing target number of download connections to \d+\s*\(rate was [\d.]+,\s*now\s*([\d.]+)\)/i
      );
    if (rateMatch) {
      const mbps = parseFloat(rateMatch[1]);
      if (!Number.isNaN(mbps) && mbps >= 0) {
        result.speedBytesPerSec = Math.round(mbps * 125000);
      }
    }

    if (!appPrefixRe.test(line)) continue;

    if (
      /update started/i.test(line) ||
      /state changed\s*:\s*[^(\r\n]*(?:Uninstalled|Update Required)/i.test(line)
    ) {
      result.bytesDownloaded = 0;
      result.bytesToDownload = 0;
      result.bytesStaged = 0;
      result.bytesToStage = 0;
      result.fullyInstalled = false;
      result.speedBytesPerSec = 0;
      if (/update started/i.test(line)) {
        result.updateStarted = true;
      }
    }

    const dlMatch = line.match(/download\s+(\d+)\/(\d+)/i);
    if (dlMatch) {
      result.bytesDownloaded = Number(dlMatch[1]) || 0;
      result.bytesToDownload = Number(dlMatch[2]) || 0;
    }

    const stageMatch = line.match(/stage\s+(\d+)\/(\d+)/i);
    if (stageMatch) {
      result.bytesStaged = Number(stageMatch[1]) || 0;
      result.bytesToStage = Number(stageMatch[2]) || 0;
    }

    const updateChangedMatch = line.match(/App update changed\s*:\s*(.+)$/i);
    if (updateChangedMatch) {
      const rawPhase = updateChangedMatch[1].trim();
      result.phase = rawPhase;
      if (/^none$/i.test(rawPhase)) {
        result.isRunning = false;
      } else if (
        /running update|downloading|staging|preallocating|allocating|verifying|committing/i.test(
          rawPhase
        )
      ) {
        result.fullyInstalled = false;
        result.isRunning = true;
      }
    }

    if (/state changed\s*:\s*[^(\r\n]*Fully Installed/i.test(line)) {
      result.fullyInstalled = true;
      result.isRunning = false;
      result.phase = 'Fully Installed';
    }
  }

  return result;
}

/**
 * Parse human-readable storage requirements from HTML or text descriptions.
 */
function parseStorageRequirementBytes(htmlOrText) {
  if (!htmlOrText) return undefined;
  const text = typeof htmlOrText === 'string' ? htmlOrText : JSON.stringify(htmlOrText);
  const patterns = [
    /(?:Storage|Hard\s*Drive(?:\s*Space)?|Hard\s*Disk(?:\s*Space)?|Disk\s*Space|Available\s*Space|Free\s*Space|HDD|SSD)[^0-9]{0,45}(\d+(?:[.,]\d+)?)\s*(GB|GiB|MB|MiB|TB|TiB)\b/i,
    /\b(\d+(?:[.,]\d+)?)\s*(GB|GiB|MB|MiB|TB|TiB)\s+(?:available\s+space|free\s+(?:disk\s+)?space|hard\s+drive\s+space|storage|of\s+free\s+space)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const val = parseFloat(m[1].replace(',', '.'));
      if (!Number.isFinite(val) || val <= 0) continue;
      const unit = m[2].toUpperCase();
      if (unit.startsWith('T')) return Math.round(val * 1024 * 1024 * 1024 * 1024);
      if (unit.startsWith('G')) return Math.round(val * 1024 * 1024 * 1024);
      if (unit.startsWith('M')) return Math.round(val * 1024 * 1024);
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
    if (buf.length >= 41 && buf.readUInt32LE(0) === 0x44bec00c) {
      const headerSize = buf.readUInt32LE(4);
      const storedAs = buf.readUInt8(36);
      const rawBody = buf.subarray(headerSize);
      const body = storedAs & 1 ? zlib.inflateSync(rawBody) : rawBody;

      const metaSize = body.readUInt32LE(0);
      let offset = metaSize;

      const cdlSize = body.readUInt32LE(offset);
      const cdlCount = body.readUInt32LE(offset + 5);
      const windowSizeStart = offset + 9 + cdlCount * (16 + 8 + 20 + 1);
      let uncompressedChunkSize = 0n;
      for (let i = 0; i < cdlCount; i++) {
        uncompressedChunkSize += BigInt(body.readUInt32LE(windowSizeStart + i * 4));
      }
      const fileSizeStart = windowSizeStart + cdlCount * 4;
      let downloadSize = 0n;
      for (let i = 0; i < cdlCount; i++) {
        downloadSize += body.readBigUInt64LE(fileSizeStart + i * 8);
      }

      offset += cdlSize;
      const fmlCount = body.readUInt32LE(offset + 5);
      let pos = offset + 9;
      const skipFString = () => {
        const len = body.readInt32LE(pos);
        pos += 4;
        if (len > 0) pos += len;
        else if (len < 0) pos += -len * 2;
      };
      for (let i = 0; i < fmlCount; i++) skipFString();
      for (let i = 0; i < fmlCount; i++) skipFString();
      pos += fmlCount * 21;
      for (let i = 0; i < fmlCount; i++) {
        const tagCount = body.readUInt32LE(pos);
        pos += 4;
        for (let t = 0; t < tagCount; t++) skipFString();
      }
      let diskSize = 0n;
      for (let i = 0; i < fmlCount; i++) {
        const partCount = body.readUInt32LE(pos);
        pos += 4;
        for (let p = 0; p < partCount; p++) {
          const structSize = body.readUInt32LE(pos);
          const partSize = body.readUInt32LE(pos + 24);
          diskSize += BigInt(partSize);
          pos += structSize;
        }
      }

      return {
        diskSize: Number(diskSize) || Number(uncompressedChunkSize) || 0,
        downloadSize: Number(downloadSize) || 0,
      };
    }

    let jsonStr = null;
    if (buf[0] === 0x7b) {
      jsonStr = buf.toString('utf8');
    } else {
      try {
        const inflated = zlib.inflateSync(buf);
        if (inflated.length > 0 && inflated[0] === 0x7b) {
          jsonStr = inflated.toString('utf8');
        }
      } catch {
        // Not zlib JSON
      }
    }
    if (jsonStr) {
      const parsed = JSON.parse(jsonStr);
      let diskSize = 0;
      if (Array.isArray(parsed.FileManifestList)) {
        for (const f of parsed.FileManifestList) {
          if (Array.isArray(f.FileChunkParts)) {
            for (const part of f.FileChunkParts) {
              if (typeof part.Size === 'string') {
                const n = Number(part.Size);
                if (Number.isFinite(n) && n > 0) diskSize += n;
              } else if (typeof part.Size === 'number' && part.Size > 0) {
                diskSize += part.Size;
              }
            }
          }
        }
      }
      return {
        diskSize: diskSize || Number(parsed.diskSize || parsed.installSize || 0),
        downloadSize: Number(parsed.downloadSize || diskSize || 0),
      };
    }
  } catch (err) {
    diagLog.warn('inspector.parseEpicManifest', err);
  }
  return null;
}

module.exports = {
  inspectWindowsExecutableHeader,
  inspectMacMachOHeader,
  parseSteamLibraryFoldersVdf,
  parseSteamAcf,
  parseSteamContentLogForApp,
  parseStorageRequirementBytes,
  parseEpicManifestBuffer,
};
