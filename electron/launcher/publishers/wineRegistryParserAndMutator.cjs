// @ts-check
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { fromWineWindowsPath } = require('../firstPartyRegistration.cjs');
const {
  unescapeWineRegString,
  resolveDriveCPathCaseInsensitive,
} = require('../wineAndCrossOverManager.cjs');
const { atomicWriteFileSync, isContainedWithinRoot } = require('../securityAndPathUtils.cjs');
const {
  EA_DESKTOP_MSI_UPGRADE_CODE,
  normalizeChainedHandoffId,
  isForbiddenBroadPublisherContainerDir,
} = require('./publisherCatalogData.cjs');

const execFileAsyncDefault = promisify(execFile);

/**
 * Unescape a Wine `.reg` string literal delegating to `unescapeWineRegString` from
 * `wineAndCrossOverManager.cjs` with a no-backslash fast path and NUL-byte stripping.
 *
 * @param {string} raw
 * @returns {string}
 */
function unescapeWineRegValue(raw) {
  if (!raw || typeof raw !== 'string') return '';
  if (!raw.includes('\\')) return raw;
  const unescaped = unescapeWineRegString(raw);
  return unescaped.includes('\0') ? unescaped.replace(/\0/g, '') : unescaped;
}

/**
 * Return `true` when `str` ends with an odd number of literal backslashes (Wine `.reg` line
 * continuation marker, distinguishing `\` from escaped `\\`).
 *
 * @param {string} str
 * @returns {boolean}
 */
function hasOddTrailingBackslashes(str) {
  let count = 0;
  for (let i = str.length - 1; i >= 0 && str.charCodeAt(i) === 92 /* '\\' */; i -= 1) {
    count += 1;
  }
  return (count & 1) === 1;
}

/**
 * Decode a Wine / Regedit UTF-16LE comma-separated hex byte sequence for `hex(1):` (`REG_SZ`),
 * `hex(2):` (`REG_EXPAND_SZ`), or `hex(7):` (`REG_MULTI_SZ`).
 *
 * - For `REG_SZ` / `REG_EXPAND_SZ` (`isMultiSz = false`): strips trailing NUL code units
 *   (stopping at the first NUL terminator).
 * - For `REG_MULTI_SZ` (`isMultiSz = true`): splits on UTF-16LE NUL code units, discards empty
 *   terminator entries, and joins non-empty strings with `\n` (a single-item `REG_MULTI_SZ`
 *   yields the exact string with no delimiter).
 *
 * @param {string} hexBody
 * @param {boolean} isMultiSz
 * @returns {string | null} Decoded string, or `null` when hex syntax is invalid.
 */
function decodeWineRegUtf16LeHex(hexBody, isMultiSz) {
  const cleaned = String(hexBody || '').trim();
  if (!cleaned) return '';
  const tokens = cleaned.split(',');
  /** @type {number[]} */
  const bytes = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i].trim();
    if (!tok) {
      if (i === tokens.length - 1) continue;
      return null;
    }
    if (!/^[0-9a-fA-F]{1,2}$/.test(tok)) {
      return null;
    }
    bytes.push(parseInt(tok, 16));
  }
  const evenLen = bytes.length - (bytes.length % 2);
  if (evenLen <= 0) return '';
  const decoded = Buffer.from(bytes.slice(0, evenLen)).toString('utf16le');
  if (isMultiSz) {
    const parts = decoded.split('\0').filter((s) => s.length > 0);
    return parts.join('\n');
  }
  const nulIdx = decoded.indexOf('\0');
  return nulIdx >= 0 ? decoded.slice(0, nulIdx) : decoded;
}

/**
 * Parse a Wine `.reg` right-hand-side value (`"..."`, `dword:...`, `str(2):"..."`, `str(7):"..."`,
 * `hex(1):...`, `hex(2):...`, `hex(7):...`) into a string, or `null` if unsupported/malformed.
 *
 * @param {string} rhs
 * @returns {string | null}
 */
function parseWineRegRhsValue(rhs) {
  if (!rhs) return null;
  if (rhs.length >= 2 && rhs.startsWith('"') && rhs.endsWith('"')) {
    return unescapeWineRegValue(rhs.slice(1, -1));
  }
  const rhsLower = rhs.toLowerCase();
  if (rhsLower.startsWith('dword:')) {
    return rhs.slice(6).trim();
  }
  if (rhsLower.startsWith('str(2):"') && rhs.endsWith('"')) {
    return unescapeWineRegValue(rhs.slice(8, -1));
  }
  if (rhsLower.startsWith('str(7):"') && rhs.endsWith('"')) {
    const rawMulti = unescapeWineRegString(rhs.slice(8, -1));
    return rawMulti
      .split('\0')
      .filter((s) => s.length > 0)
      .join('\n');
  }
  if (rhsLower.startsWith('hex(2):') || rhsLower.startsWith('hex(1):')) {
    return decodeWineRegUtf16LeHex(rhs.slice(7), false);
  }
  if (rhsLower.startsWith('hex(7):')) {
    return decodeWineRegUtf16LeHex(rhs.slice(7), true);
  }
  return null;
}

/**
 * Normalize a Wine registry section path to lowercase single-backslash form
 * (e.g. `[Software\\Wow6432Node\\Ubisoft\\Launcher]` -> `'software\\wow6432node\\ubisoft\\launcher'`).
 *
 * @param {string} rawSection
 * @returns {string}
 */
function normalizeWineRegistrySectionKey(rawSection) {
  if (!rawSection || typeof rawSection !== 'string') return '';
  const trimmed = rawSection.trim();
  const unescaped =
    trimmed.includes('\\\\') || trimmed.includes('\\"')
      ? unescapeWineRegValue(trimmed)
      : trimmed;
  return unescaped
    .replace(/\//g, '\\')
    .replace(/\\+/g, '\\')
    .replace(/^\\+|\\+$/g, '')
    .replace(/^(?:hkey_local_machine|hklm|hkey_current_user|hkcu)\\/i, '')
    .toLowerCase();
}

/**
 * Case- and slash-insensitive `Map` subclass for Wine registry sections.
 *
 * @extends {Map<string, Record<string, string>>}
 */
class WineRegistrySectionMap extends Map {
  /**
   * @param {string} key
   * @returns {Record<string, string> | undefined}
   */
  get(key) {
    return super.get(normalizeWineRegistrySectionKey(key));
  }

  /**
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return super.has(normalizeWineRegistrySectionKey(key));
  }
}

/**
 * Fast (`< 5ms`) pure-Node Wine `.reg` parser with zero child processes.
 * Parses `[Section\\Path]` headers and `"Key"="Value"` / `@="Value"` / `dword:` /
 * `str(2):` / `str(7):` / multi-line `hex(2):` (`REG_EXPAND_SZ`) / `hex(7):` (`REG_MULTI_SZ`)
 * UTF-16LE entries cleanly.
 *
 * @param {string} regText
 * @returns {Map<string, Record<string, string>>}
 */
function parseWineRegistrySections(regText) {
  /** @type {WineRegistrySectionMap} */
  const sections = new WineRegistrySectionMap();
  if (!regText || typeof regText !== 'string') {
    return sections;
  }

  /** @type {Record<string, string> | null} */
  let currentProps = null;
  const len = regText.length;
  let lineStart = 0;

  while (lineStart < len) {
    let lineEnd = regText.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = len;

    let endTrim = lineEnd;
    if (endTrim > lineStart && regText.charCodeAt(endTrim - 1) === 13 /* \r */) {
      endTrim -= 1;
    }

    // Handle trailing backslash line continuations in Wine .reg files
    let line = regText.slice(lineStart, endTrim);
    lineStart = lineEnd + 1;

    while (lineStart < len) {
      const rightTrimmed = line.trimEnd();
      if (!hasOddTrailingBackslashes(rightTrimmed)) break;
      let nextEnd = regText.indexOf('\n', lineStart);
      if (nextEnd === -1) nextEnd = len;
      let nextTrim = nextEnd;
      if (nextTrim > lineStart && regText.charCodeAt(nextTrim - 1) === 13) {
        nextTrim -= 1;
      }
      const continuation = regText.slice(lineStart, nextTrim).trimStart();
      line = rightTrimmed.slice(0, -1) + continuation;
      lineStart = nextEnd + 1;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;
    const firstCode = trimmed.charCodeAt(0);
    // ';' (59) or '#' (35) comment/directive lines
    if (firstCode === 59 || firstCode === 35) continue;

    if (firstCode === 91 /* '[' */) {
      const closeBracket = trimmed.indexOf(']');
      if (closeBracket > 1) {
        const secKey = normalizeWineRegistrySectionKey(trimmed.slice(1, closeBracket));
        if (secKey) {
          let existing = sections.get(secKey);
          if (!existing) {
            existing = {};
            sections.set(secKey, existing);
          }
          currentProps = existing;
        } else {
          currentProps = null;
        }
      }
      continue;
    }

    if (!currentProps) continue;

    if (firstCode === 64 /* '@' */) {
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const rhs = trimmed.slice(eqIdx + 1).trim();
        const parsedVal = parseWineRegRhsValue(rhs);
        if (parsedVal !== null) {
          currentProps['@'] = parsedVal;
        }
      }
      continue;
    }

    if (firstCode === 34 /* '"' */) {
      // Scan closing quote of key name while honoring escaped quotes
      let keyEnd = -1;
      for (let i = 1; i < trimmed.length; i += 1) {
        const c = trimmed.charCodeAt(i);
        if (c === 92 /* '\\' */) {
          i += 1;
          continue;
        }
        if (c === 34 /* '"' */) {
          keyEnd = i;
          break;
        }
      }
      if (keyEnd <= 0) continue;

      const eqIdx = trimmed.indexOf('=', keyEnd + 1);
      if (eqIdx < 0) continue;

      const keyName = unescapeWineRegValue(trimmed.slice(1, keyEnd));
      if (!keyName) continue;

      const rhs = trimmed.slice(eqIdx + 1).trim();
      const parsedVal = parseWineRegRhsValue(rhs);
      if (parsedVal !== null) {
        currentProps[keyName] = parsedVal;
      }
    }
  }

  return sections;
}

/**
 * Look up a property case-insensitively inside a parsed registry property bag.
 *
 * @param {Record<string, string> | undefined | null} props
 * @param {string} propName
 * @returns {string}
 */
function getRegistryPropCaseInsensitive(props, propName) {
  if (!props || typeof props !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(props, propName)) {
    return String(props[propName] || '').trim();
  }
  const target = propName.toLowerCase();
  for (const [k, v] of Object.entries(props)) {
    if (k.toLowerCase() === target) {
      return String(v || '').trim();
    }
  }
  return '';
}

/**
 * Load or reuse a parsed `system.reg` section map for `bottlePath` (synchronous).
 *
 * @param {string} bottlePath
 * @param {Record<string, any>} [options]
 * @returns {Map<string, Record<string, string>>}
 */
function getBottleSystemRegSections(bottlePath, options = {}) {
  if (options.parsedSystemReg instanceof Map) {
    return options.parsedSystemReg;
  }
  const sysRegPath = path.join(bottlePath, 'system.reg');
  try {
    if (fs.existsSync(sysRegPath)) {
      return parseWineRegistrySections(fs.readFileSync(sysRegPath, 'utf8'));
    }
  } catch {}
  return new WineRegistrySectionMap();
}

/**
 * Load or reuse a parsed `system.reg` section map for `bottlePath` asynchronously (`fs.promises`).
 *
 * @param {string} bottlePath
 * @param {Record<string, any>} [options]
 * @returns {Promise<Map<string, Record<string, string>>>}
 */
async function getBottleSystemRegSectionsAsync(bottlePath, options = {}) {
  if (options.parsedSystemReg instanceof Map) {
    return options.parsedSystemReg;
  }
  const sysRegPath = path.join(bottlePath, 'system.reg');
  try {
    const raw = await fs.promises.readFile(sysRegPath, 'utf8');
    return parseWineRegistrySections(raw);
  } catch {}
  return new WineRegistrySectionMap();
}

/**
 * Async case-insensitive path resolver under `<prefix>/drive_c` using `fs.promises`.
 *
 * @param {string} driveCRoot
 * @param {string[]} relParts
 * @returns {Promise<string>}
 */
async function resolveDriveCPathCaseInsensitiveAsync(driveCRoot, relParts) {
  let currentPath = driveCRoot;
  let parentExistsOnDisk = false;
  try {
    const st = await fs.promises.stat(currentPath);
    parentExistsOnDisk = st.isDirectory();
  } catch {
    parentExistsOnDisk = false;
  }

  for (const rawSeg of relParts) {
    if (!rawSeg || rawSeg === '.') continue;
    if (rawSeg === '..') {
      currentPath = path.dirname(currentPath);
      try {
        const st = await fs.promises.stat(currentPath);
        parentExistsOnDisk = st.isDirectory();
      } catch {
        parentExistsOnDisk = false;
      }
      continue;
    }

    if (!parentExistsOnDisk) {
      currentPath = path.join(currentPath, rawSeg);
      continue;
    }

    const exactCandidate = path.join(currentPath, rawSeg);
    /** @type {string | null} */
    let matchedSegment = null;
    try {
      const entries = await fs.promises.readdir(currentPath);
      if (entries.includes(rawSeg)) {
        matchedSegment = rawSeg;
      } else {
        const lowerTarget = rawSeg.toLowerCase();
        matchedSegment = entries.find((e) => e.toLowerCase() === lowerTarget) || null;
      }
    } catch {
      matchedSegment = null;
    }

    if (matchedSegment) {
      currentPath = path.join(currentPath, matchedSegment);
      try {
        const st = await fs.promises.stat(currentPath);
        parentExistsOnDisk = st.isDirectory();
      } catch {
        parentExistsOnDisk = false;
      }
    } else {
      currentPath = exactCandidate;
      parentExistsOnDisk = false;
    }
  }

  return path.normalize(currentPath);
}

/**
 * Async counterpart to `fromWineWindowsPath` using strictly `fs.promises` (zero sync FS).
 *
 * @param {string} winPath
 * @param {string} [bottlePath]
 * @returns {Promise<string>}
 */
async function fromWineWindowsPathAsync(winPath, bottlePath = '') {
  if (!winPath || typeof winPath !== 'string') return '';
  const trimmed = winPath.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('/')) {
    return path.posix.normalize(trimmed);
  }

  const driveMatch = trimmed.match(/^([a-zA-Z]):(?:[\\/](.*))?$/);
  if (!driveMatch) {
    return trimmed;
  }

  const driveLetter = driveMatch[1].toUpperCase();
  const relRaw = driveMatch[2] || '';
  const relParts = relRaw.replace(/\\/g, '/').split('/').filter(Boolean);

  if (
    process.platform === 'win32' &&
    bottlePath &&
    typeof bottlePath === 'string' &&
    bottlePath.trim()
  ) {
    const cleanBottle = bottlePath.trim();
    const normInput = path.win32.resolve(trimmed).toLowerCase();
    const normBottle = path.win32.resolve(cleanBottle).toLowerCase();
    if (normInput === normBottle || normInput.startsWith(`${normBottle}\\`)) {
      return path.win32.normalize(trimmed);
    }
    const normTmp = path.win32.resolve(os.tmpdir()).toLowerCase();
    if (
      (normBottle === normTmp || normBottle.startsWith(`${normTmp}\\`)) &&
      normInput.startsWith(`${normTmp}\\`)
    ) {
      try {
        await fs.promises.access(trimmed);
        return path.win32.normalize(trimmed);
      } catch {}
    }
  }

  if (driveLetter === 'C' && bottlePath && typeof bottlePath === 'string' && bottlePath.trim()) {
    const driveCRoot = path.join(bottlePath.trim(), 'drive_c');
    try {
      await fs.promises.access(driveCRoot);
      return resolveDriveCPathCaseInsensitiveAsync(driveCRoot, relParts);
    } catch {
      return path.join(driveCRoot, ...relParts);
    }
  }

  if (driveLetter === 'Z') {
    const bottleDriveMatch =
      bottlePath && typeof bottlePath === 'string'
        ? bottlePath.trim().match(/^([a-zA-Z]:)[\\/]/)
        : null;
    if (bottleDriveMatch) {
      return path.win32.join(`${bottleDriveMatch[1]}\\`, ...relParts);
    }
    return `/${relParts.join('/')}`;
  }

  if (bottlePath && typeof bottlePath === 'string' && bottlePath.trim()) {
    const dosLink = path.join(bottlePath.trim(), 'dosdevices', `${driveLetter.toLowerCase()}:`);
    try {
      const realRoot = await fs.promises.realpath(dosLink);
      return path.join(realRoot, ...relParts);
    } catch {}
  }

  return trimmed;
}

const IO_REPARSE_TAG_MOUNT_POINT = 0xa0000003;
const IO_REPARSE_TAG_SYMLINK = 0xa000000c;
const WINE_REPARSE_XATTR_NAME = 'user.WINEREPARSE';
const WINE_REPARSE_XATTR_CACHE_MAX = 256;
/** @type {Map<string, { mtimeMs: number, buffer: Buffer | null }>} */
const wineReparseXattrCache = new Map();

/**
 * Decode a Microsoft `REPARSE_DATA_BUFFER` (`IO_REPARSE_TAG_MOUNT_POINT` or `IO_REPARSE_TAG_SYMLINK`)
 * from a Wine `user.WINEREPARSE` extended attribute payload.
 *
 * @param {Buffer | null | undefined} rawBuf
 * @returns {{ tag: number, target: string, isRelative: boolean } | null}
 */
function decodeWineReparseDataBuffer(rawBuf) {
  /**
   * @param {Buffer} buf
   * @returns {{ tag: number, target: string, isRelative: boolean } | null}
   */
  const tryDecode = (buf) => {
    if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
    const maxScan = Math.min(32, buf.length - 16);
    for (let base = 0; base <= maxScan; base += 4) {
      const tag = buf.readUInt32LE(base);
      if (tag !== IO_REPARSE_TAG_MOUNT_POINT && tag !== IO_REPARSE_TAG_SYMLINK) continue;
      const isSymlink = tag === IO_REPARSE_TAG_SYMLINK;
      const pathBufOffset = base + (isSymlink ? 20 : 16);
      if (pathBufOffset > buf.length) continue;

      const subOffset = buf.readUInt16LE(base + 8);
      const subLen = buf.readUInt16LE(base + 10);
      const printOffset = buf.readUInt16LE(base + 12);
      const printLen = buf.readUInt16LE(base + 14);
      const flags = isSymlink ? buf.readUInt32LE(base + 16) : 0;

      let subName = '';
      if (subLen > 0 && pathBufOffset + subOffset + subLen <= buf.length) {
        subName = buf
          .subarray(pathBufOffset + subOffset, pathBufOffset + subOffset + subLen)
          .toString('utf16le')
          .replace(/\0+$/g, '');
      }
      let printName = '';
      if (printLen > 0 && pathBufOffset + printOffset + printLen <= buf.length) {
        printName = buf
          .subarray(pathBufOffset + printOffset, pathBufOffset + printOffset + printLen)
          .toString('utf16le')
          .replace(/\0+$/g, '');
      }

      const stripNtPrefix = (/** @type {string} */ s) =>
        s
          .trim()
          .replace(/^\\\?\?\\UNC\\/i, '\\\\')
          .replace(/^\\\?\?\\/, '')
          .replace(/^\\\\\?\\UNC\\/i, '\\\\')
          .replace(/^\\\\\?\\/, '');

      let target = stripNtPrefix(subName);
      const cleanPrint = stripNtPrefix(printName);
      if ((!target || /^Volume\{/i.test(target)) && cleanPrint) {
        target = cleanPrint;
      }
      if (target) {
        return {
          tag,
          target,
          isRelative: isSymlink && (flags & 0x00000001) !== 0,
        };
      }
    }
    return null;
  };

  if (!Buffer.isBuffer(rawBuf) || rawBuf.length < 16) return null;
  const direct = tryDecode(rawBuf);
  if (direct) return direct;
  if (rawBuf.length >= 20 && rawBuf.length <= 4096) {
    const ascii = rawBuf.toString('utf8').trim();
    if (/^[A-Za-z0-9+/=\s]+$/.test(ascii)) {
      try {
        return tryDecode(Buffer.from(ascii.replace(/\s+/g, ''), 'base64'));
      } catch {}
    }
  }
  return null;
}

/**
 * Parse hex output returned by `/usr/bin/xattr -px` into a raw `Buffer`.
 *
 * @param {unknown} hexOut
 * @returns {Buffer | null}
 */
function parseXattrHexOutput(hexOut) {
  const cleanHex = String(hexOut || '').replace(/[^0-9a-fA-F]/g, '');
  if (cleanHex.length >= 32 && cleanHex.length % 2 === 0) {
    return Buffer.from(cleanHex, 'hex');
  }
  return null;
}

/**
 * @param {string} targetPath
 * @param {number} mtimeMs
 * @returns {{ hit: boolean, buffer: Buffer | null }}
 */
function lookupWineReparseXattrCache(targetPath, mtimeMs) {
  const cached = wineReparseXattrCache.get(targetPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    wineReparseXattrCache.delete(targetPath);
    wineReparseXattrCache.set(targetPath, cached);
    return { hit: true, buffer: cached.buffer };
  }
  return { hit: false, buffer: null };
}

/**
 * @param {string} targetPath
 * @param {number} mtimeMs
 * @param {Buffer | null} buffer
 */
function storeWineReparseXattrCache(targetPath, mtimeMs, buffer) {
  if (wineReparseXattrCache.size >= WINE_REPARSE_XATTR_CACHE_MAX) {
    const oldestKey = wineReparseXattrCache.keys().next().value;
    if (oldestKey !== undefined) wineReparseXattrCache.delete(oldestKey);
  }
  wineReparseXattrCache.set(targetPath, { mtimeMs, buffer });
}

/**
 * Read `user.WINEREPARSE` extended attribute bytes without mutating disk state (synchronous).
 *
 * @param {string} targetPath
 * @param {number} mtimeMs
 * @param {{ getXattrBuffer?: (targetPath: string, attrName: string) => Buffer | null | undefined, platform?: string }} [options]
 * @returns {Buffer | null}
 */
function readWineReparseXattrCached(targetPath, mtimeMs, options = {}) {
  if (typeof options.getXattrBuffer === 'function') {
    try {
      const injected = options.getXattrBuffer(targetPath, WINE_REPARSE_XATTR_NAME);
      return Buffer.isBuffer(injected) ? injected : null;
    } catch {
      return null;
    }
  }
  const platform = String(options.platform || process.platform).toLowerCase();
  if (platform !== 'darwin') return null;

  const cached = lookupWineReparseXattrCache(targetPath, mtimeMs);
  if (cached.hit) return cached.buffer;

  /** @type {Buffer | null} */
  let resolvedBuf = null;
  try {
    const hexOut = execFileSync('/usr/bin/xattr', ['-px', WINE_REPARSE_XATTR_NAME, targetPath], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    resolvedBuf = parseXattrHexOutput(hexOut);
  } catch {
    resolvedBuf = null;
  }

  storeWineReparseXattrCache(targetPath, mtimeMs, resolvedBuf);
  return resolvedBuf;
}

/**
 * Read `user.WINEREPARSE` extended attribute bytes asynchronously via `execFile` (zero main-thread block).
 *
 * @param {string} targetPath
 * @param {number} mtimeMs
 * @param {{
 *   getXattrBufferAsync?: (targetPath: string, attrName: string) => Promise<Buffer | null | undefined> | Buffer | null | undefined,
 *   getXattrBuffer?: (targetPath: string, attrName: string) => Promise<Buffer | null | undefined> | Buffer | null | undefined,
 *   execFileAsync?: (file: string, args: string[], opts?: Record<string, any>) => Promise<{ stdout?: string } | string>,
 *   platform?: string,
 * }} [options]
 * @returns {Promise<Buffer | null>}
 */
async function readWineReparseXattrCachedAsync(targetPath, mtimeMs, options = {}) {
  const injectedGetter =
    typeof options.getXattrBufferAsync === 'function'
      ? options.getXattrBufferAsync
      : typeof options.getXattrBuffer === 'function'
        ? options.getXattrBuffer
        : null;
  if (injectedGetter) {
    try {
      const injected = await injectedGetter(targetPath, WINE_REPARSE_XATTR_NAME);
      return Buffer.isBuffer(injected) ? injected : null;
    } catch {
      return null;
    }
  }
  const platform = String(options.platform || process.platform).toLowerCase();
  if (platform !== 'darwin') return null;

  const cached = lookupWineReparseXattrCache(targetPath, mtimeMs);
  if (cached.hit) return cached.buffer;

  const runExecFile =
    typeof options.execFileAsync === 'function' ? options.execFileAsync : execFileAsyncDefault;
  /** @type {Buffer | null} */
  let resolvedBuf = null;
  try {
    const res = await runExecFile('/usr/bin/xattr', ['-px', WINE_REPARSE_XATTR_NAME, targetPath], {
      encoding: 'utf8',
      timeout: 1000,
    });
    const hexOut = typeof res === 'string' ? res : res && typeof res === 'object' ? res.stdout : '';
    resolvedBuf = parseXattrHexOutput(hexOut);
  } catch {
    resolvedBuf = null;
  }

  storeWineReparseXattrCache(targetPath, mtimeMs, resolvedBuf);
  return resolvedBuf;
}

/**
 * Strictly read-only (`0` disk writes / `0` symlinks) resolver for Wine NTFS junctions and
 * symlinks stored via the `user.WINEREPARSE` extended attribute inside `<bottlePath>/drive_c`.
 *
 * @param {string} hostPath
 * @param {string} [driveCRoot]
 * @param {{ getXattrBuffer?: (targetPath: string, attrName: string) => Buffer | null | undefined, platform?: string, maxHops?: number }} [options]
 * @returns {string}
 */
function resolveWineReparseTargetReadOnly(hostPath, driveCRoot = '', options = {}) {
  if (!hostPath || typeof hostPath !== 'string') return hostPath || '';
  const hasCustomGetter = typeof options.getXattrBuffer === 'function';
  const platform = String(options.platform || process.platform).toLowerCase();
  if (!hasCustomGetter && platform !== 'darwin') {
    return hostPath;
  }

  let effectiveDriveC = driveCRoot ? path.resolve(driveCRoot) : '';
  if (!effectiveDriveC) {
    const dcMatch = hostPath.match(/^(.*\/drive_c)(?:\/|$)/i);
    if (dcMatch && dcMatch[1]) effectiveDriveC = path.resolve(dcMatch[1]);
  }
  if (!effectiveDriveC) return hostPath;

  const bottlePath = path.dirname(effectiveDriveC);
  const maxHops = Number.isInteger(options.maxHops) && Number(options.maxHops) > 0 ? Number(options.maxHops) : 6;
  /** @type {Set<string>} */
  const visited = new Set();
  let currentPath = hostPath;

  for (let hop = 0; hop < maxHops; hop += 1) {
    const normCurrent = path.resolve(currentPath);
    if (visited.has(normCurrent)) break;
    visited.add(normCurrent);

    if (!hasCustomGetter) {
      try {
        if (fs.existsSync(normCurrent)) {
          const st = fs.statSync(normCurrent);
          if ((st.isFile() && st.size > 0) || (st.isDirectory() && fs.readdirSync(normCurrent).length > 0)) {
            return currentPath;
          }
        }
      } catch {}
    }

    const driveCPrefix = effectiveDriveC.endsWith(path.sep) ? effectiveDriveC : `${effectiveDriveC}${path.sep}`;
    if (normCurrent !== effectiveDriveC && !normCurrent.startsWith(driveCPrefix)) {
      return currentPath;
    }

    const relFromDriveC = normCurrent === effectiveDriveC ? '' : normCurrent.slice(driveCPrefix.length);
    const segments = relFromDriveC.split(path.sep).filter(Boolean);
    if (segments.length === 0) return currentPath;

    let curDir = effectiveDriveC;
    let hopped = false;

    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const segLower = seg.toLowerCase();
      const segQ = `${segLower}?`;
      /** @type {fs.Dirent[]} */
      let entries = [];
      try {
        entries = fs.readdirSync(curDir, { withFileTypes: true });
      } catch {
        break;
      }

      const exactOrCi = entries.find((e) => e.name === seg) || entries.find((e) => e.name.toLowerCase() === segLower);
      const qStub = entries.find((e) => e.name.toLowerCase() === segQ);
      /** @type {fs.Dirent[]} */
      const stubDirents = [];
      if (qStub) stubDirents.push(qStub);
      if (exactOrCi && exactOrCi !== qStub) stubDirents.push(exactOrCi);

      for (const dirent of stubDirents) {
        const candPath = path.join(curDir, dirent.name);
        let mtimeMs = 0;
        let shouldCheckXattr = hasCustomGetter || dirent.name.endsWith('?');
        try {
          const lst = fs.lstatSync(candPath);
          mtimeMs = lst.mtimeMs;
          if (!shouldCheckXattr) {
            if (lst.isSymbolicLink() || (lst.isFile() && lst.size === 0)) {
              shouldCheckXattr = true;
            } else if (lst.isDirectory() && fs.readdirSync(candPath).length === 0) {
              shouldCheckXattr = true;
            }
          }
        } catch {
          continue;
        }
        if (!shouldCheckXattr) continue;

        const xattrBuf = readWineReparseXattrCached(candPath, mtimeMs, options);
        const decoded = decodeWineReparseDataBuffer(xattrBuf);
        if (!decoded || !decoded.target) continue;

        let mappedBase = '';
        if (
          decoded.isRelative ||
          (!/^[a-zA-Z]:(?:[\\/]|$)/.test(decoded.target) && !decoded.target.startsWith('/'))
        ) {
          const relParts = decoded.target.replace(/\\/g, '/').split('/').filter(Boolean);
          mappedBase = resolveDriveCPathCaseInsensitive(curDir, relParts);
        } else {
          mappedBase = fromWineWindowsPath(decoded.target, bottlePath);
        }
        if (!mappedBase) continue;

        const remaining = segments.slice(i + 1);
        currentPath =
          remaining.length > 0
            ? resolveDriveCPathCaseInsensitive(mappedBase, remaining)
            : mappedBase;
        hopped = true;
        break;
      }

      if (hopped) break;
      if (!exactOrCi) break;
      curDir = path.join(curDir, exactOrCi.name);
    }

    if (!hopped) break;
  }

  return currentPath;
}

/**
 * Strictly read-only, non-blocking async resolver for Wine NTFS junctions and symlinks stored
 * via `user.WINEREPARSE` inside `<bottlePath>/drive_c` (uses `fs.promises` + `execFile` async).
 *
 * @param {string} hostPath
 * @param {string} [driveCRoot]
 * @param {{
 *   getXattrBufferAsync?: (targetPath: string, attrName: string) => Promise<Buffer | null | undefined> | Buffer | null | undefined,
 *   getXattrBuffer?: (targetPath: string, attrName: string) => Promise<Buffer | null | undefined> | Buffer | null | undefined,
 *   execFileAsync?: (file: string, args: string[], opts?: Record<string, any>) => Promise<{ stdout?: string } | string>,
 *   platform?: string,
 *   maxHops?: number,
 * }} [options]
 * @returns {Promise<string>}
 */
async function resolveWineReparseTargetReadOnlyAsync(hostPath, driveCRoot = '', options = {}) {
  if (!hostPath || typeof hostPath !== 'string') return hostPath || '';
  const hasCustomGetter =
    typeof options.getXattrBufferAsync === 'function' || typeof options.getXattrBuffer === 'function';
  const platform = String(options.platform || process.platform).toLowerCase();
  if (!hasCustomGetter && platform !== 'darwin') {
    return hostPath;
  }

  let effectiveDriveC = driveCRoot ? path.resolve(driveCRoot) : '';
  if (!effectiveDriveC) {
    const dcMatch = hostPath.match(/^(.*\/drive_c)(?:\/|$)/i);
    if (dcMatch && dcMatch[1]) effectiveDriveC = path.resolve(dcMatch[1]);
  }
  if (!effectiveDriveC) return hostPath;

  const bottlePath = path.dirname(effectiveDriveC);
  const maxHops = Number.isInteger(options.maxHops) && Number(options.maxHops) > 0 ? Number(options.maxHops) : 6;
  /** @type {Set<string>} */
  const visited = new Set();
  let currentPath = hostPath;

  for (let hop = 0; hop < maxHops; hop += 1) {
    const normCurrent = path.resolve(currentPath);
    if (visited.has(normCurrent)) break;
    visited.add(normCurrent);

    if (!hasCustomGetter) {
      try {
        const st = await fs.promises.stat(normCurrent);
        if (st.isFile() && st.size > 0) {
          return currentPath;
        }
        if (st.isDirectory()) {
          const children = await fs.promises.readdir(normCurrent);
          if (children.length > 0) {
            return currentPath;
          }
        }
      } catch {}
    }

    const driveCPrefix = effectiveDriveC.endsWith(path.sep) ? effectiveDriveC : `${effectiveDriveC}${path.sep}`;
    if (normCurrent !== effectiveDriveC && !normCurrent.startsWith(driveCPrefix)) {
      return currentPath;
    }

    const relFromDriveC = normCurrent === effectiveDriveC ? '' : normCurrent.slice(driveCPrefix.length);
    const segments = relFromDriveC.split(path.sep).filter(Boolean);
    if (segments.length === 0) return currentPath;

    let curDir = effectiveDriveC;
    let hopped = false;

    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const segLower = seg.toLowerCase();
      const segQ = `${segLower}?`;
      /** @type {fs.Dirent[]} */
      let entries = [];
      try {
        entries = await fs.promises.readdir(curDir, { withFileTypes: true });
      } catch {
        break;
      }

      const exactOrCi = entries.find((e) => e.name === seg) || entries.find((e) => e.name.toLowerCase() === segLower);
      const qStub = entries.find((e) => e.name.toLowerCase() === segQ);
      /** @type {fs.Dirent[]} */
      const stubDirents = [];
      if (qStub) stubDirents.push(qStub);
      if (exactOrCi && exactOrCi !== qStub) stubDirents.push(exactOrCi);

      for (const dirent of stubDirents) {
        const candPath = path.join(curDir, dirent.name);
        let mtimeMs = 0;
        let shouldCheckXattr = hasCustomGetter || dirent.name.endsWith('?');
        try {
          const lst = await fs.promises.lstat(candPath);
          mtimeMs = lst.mtimeMs;
          if (!shouldCheckXattr) {
            if (lst.isSymbolicLink() || (lst.isFile() && lst.size === 0)) {
              shouldCheckXattr = true;
            } else if (lst.isDirectory()) {
              const subEntries = await fs.promises.readdir(candPath);
              if (subEntries.length === 0) shouldCheckXattr = true;
            }
          }
        } catch {
          continue;
        }
        if (!shouldCheckXattr) continue;

        const xattrBuf = await readWineReparseXattrCachedAsync(candPath, mtimeMs, options);
        const decoded = decodeWineReparseDataBuffer(xattrBuf);
        if (!decoded || !decoded.target) continue;

        let mappedBase = '';
        if (
          decoded.isRelative ||
          (!/^[a-zA-Z]:(?:[\\/]|$)/.test(decoded.target) && !decoded.target.startsWith('/'))
        ) {
          const relParts = decoded.target.replace(/\\/g, '/').split('/').filter(Boolean);
          mappedBase = await resolveDriveCPathCaseInsensitiveAsync(curDir, relParts);
        } else {
          mappedBase = await fromWineWindowsPathAsync(decoded.target, bottlePath);
        }
        if (!mappedBase) continue;

        const remaining = segments.slice(i + 1);
        currentPath =
          remaining.length > 0
            ? await resolveDriveCPathCaseInsensitiveAsync(mappedBase, remaining)
            : mappedBase;
        hopped = true;
        break;
      }

      if (hopped) break;
      if (!exactOrCi) break;
      curDir = path.join(curDir, exactOrCi.name);
    }

    if (!hopped) break;
  }

  return currentPath;
}

/**
 * Convert a Wine Windows path to a host POSIX path and resolve any `user.WINEREPARSE`
 * junction/symlink hops inside `<bottlePath>/drive_c` strictly read-only (synchronous).
 *
 * @param {string} winPath
 * @param {string} bottlePath
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function resolveBottleWindowsPathReadOnly(winPath, bottlePath, options = {}) {
  const hostPath = fromWineWindowsPath(winPath, bottlePath);
  if (!hostPath || !bottlePath) return hostPath;
  return resolveWineReparseTargetReadOnly(hostPath, path.join(bottlePath, 'drive_c'), options);
}

/**
 * Async counterpart to `resolveBottleWindowsPathReadOnly` (zero sync FS / `execFileSync`).
 *
 * @param {string} winPath
 * @param {string} bottlePath
 * @param {Record<string, any>} [options]
 * @returns {Promise<string>}
 */
async function resolveBottleWindowsPathReadOnlyAsync(winPath, bottlePath, options = {}) {
  const hostPath = await fromWineWindowsPathAsync(winPath, bottlePath);
  if (!hostPath || !bottlePath) return hostPath;
  return resolveWineReparseTargetReadOnlyAsync(hostPath, path.join(bottlePath, 'drive_c'), options);
}

const DEPRIORITIZED_BOTTLE_USER_NAMES = new Set(['public', 'all users', 'default', 'default user']);

/**
 * Filter and sort `<bottlePath>/drive_c/users` directory entries prioritizing real user profiles
 * (`crossover`, etc.) ahead of `Public`/`Default`.
 *
 * @param {string} usersDir
 * @param {fs.Dirent[]} dirents
 * @returns {string[]}
 */
function sortBottleUserDirents(usersDir, dirents) {
  return dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .sort((a, b) => {
      const aLower = a.name.toLowerCase();
      const bLower = b.name.toLowerCase();
      if (aLower === 'crossover' && bLower !== 'crossover') return -1;
      if (bLower === 'crossover' && aLower !== 'crossover') return 1;
      const aDep = DEPRIORITIZED_BOTTLE_USER_NAMES.has(aLower);
      const bDep = DEPRIORITIZED_BOTTLE_USER_NAMES.has(bLower);
      if (aDep !== bDep) return aDep ? 1 : -1;
      return a.name.localeCompare(b.name);
    })
    .map((d) => path.join(usersDir, d.name));
}

/**
 * Enumerate per-user profile directories inside `<bottlePath>/drive_c/users`,
 * prioritizing real user profiles (`crossover`, etc.) ahead of `Public`/`Default` (synchronous).
 *
 * @param {string} bottlePath
 * @returns {string[]}
 */
function listBottleUserDirectories(bottlePath) {
  if (!bottlePath) return [];
  const driveCRoot = path.join(bottlePath, 'drive_c');
  const usersDir = resolveDriveCPathCaseInsensitive(driveCRoot, ['users']);
  try {
    if (!fs.existsSync(usersDir)) return [];
    const dirents = fs.readdirSync(usersDir, { withFileTypes: true });
    return sortBottleUserDirents(usersDir, dirents);
  } catch {
    return [];
  }
}

/**
 * Enumerate per-user profile directories inside `<bottlePath>/drive_c/users` asynchronously.
 *
 * @param {string} bottlePath
 * @returns {Promise<string[]>}
 */
async function listBottleUserDirectoriesAsync(bottlePath) {
  if (!bottlePath) return [];
  const driveCRoot = path.join(bottlePath, 'drive_c');
  const usersDir = await resolveDriveCPathCaseInsensitiveAsync(driveCRoot, ['users']);
  try {
    const dirents = await fs.promises.readdir(usersDir, { withFileTypes: true });
    return sortBottleUserDirents(usersDir, dirents);
  } catch {
    return [];
  }
}

/**
 * Verify that `regFilePath` is strictly contained within `bottlePath` (including resolved symlink
 * targets when both exist on disk) before performing any atomic registry mutation.
 *
 * @param {string} bottlePath
 * @param {string} regFilePath
 * @returns {boolean}
 */
function isRegFileContainedInBottle(bottlePath, regFilePath) {
  if (!bottlePath || !regFilePath) return false;
  const resolvedBottle = path.resolve(bottlePath);
  const resolvedReg = path.resolve(regFilePath);
  if (!isContainedWithinRoot(resolvedBottle, resolvedReg)) {
    return false;
  }
  try {
    if (fs.existsSync(resolvedBottle) && fs.existsSync(resolvedReg)) {
      const realBottle = fs.realpathSync(resolvedBottle);
      const realReg = fs.realpathSync(resolvedReg);
      if (!isContainedWithinRoot(realBottle, realReg)) {
        return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * Return `true` when a Wine `.reg` value assignment line inside a `CurrentVersion\\Run` section
 * launches one of our managed chained publisher launchers (`EA`, `Ubisoft`, `Battle.net`, `Rockstar`).
 *
 * @param {string} line
 * @returns {boolean}
 */
function isChainedPublisherAutostartRunLine(line) {
  const kvMatch = line.match(/^\s*"([^"]+)"\s*=\s*(.*)$/);
  if (!kvMatch) return false;
  const keyName = unescapeWineRegValue(kvMatch[1]).trim();
  const rhsRaw = kvMatch[2].trim();
  if (
    /^(?:eadm|ea\s*(?:desktop|app|background\s*service)|origin|uplay(?:launch)?|ubisoft(?:\s*connect|\s*game\s*launcher)?|battle\.?net(?:\s*launcher|\s*helper)?|blizzard(?:\s*battle\.?net)?|rockstar(?:\s*games(?:\s*launcher)?)?|social\s*club)$/i.test(
      keyName
    )
  ) {
    return true;
  }
  const decodedRhs =
    parseWineRegRhsValue(rhsRaw) ?? unescapeWineRegValue(rhsRaw.replace(/^"|"$/g, ''));
  if (
    /(?:EADesktop|EALauncher|EABackgroundService|Origin|upc|UbisoftConnect|UbisoftGameLauncher|Battle\.net(?:\s+Launcher)?|Rockstar-Games-Launcher|RockstarService|LauncherPatcher)\.exe\b/i.test(
      decodedRhs
    ) ||
    /\\Rockstar Games\\Launcher\\Launcher\.exe\b/i.test(decodedRhs)
  ) {
    return true;
  }
  return false;
}

/**
 * Sanitize a single Wine `.reg` file (`user.reg` or `system.reg`), stripping `CurrentVersion\\Run`
 * and `Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Run` autostart entries for EA, Ubisoft,
 * Battle.net, and Rockstar, and enforcing `"startOnBootFlag"=dword:00000000` in `user.reg`.
 *
 * @param {string} bottlePath
 * @param {string} regFilePath
 * @param {{ enforceEaStartOnBootFlag?: boolean }} [opts]
 * @returns {boolean}
 */
function sanitizePublisherAutostartInSingleRegFile(bottlePath, regFilePath, opts = {}) {
  if (!bottlePath || !regFilePath) return false;
  try {
    if (!isRegFileContainedInBottle(bottlePath, regFilePath)) return false;
    if (!fs.existsSync(regFilePath)) return false;
    const raw = fs.readFileSync(regFilePath, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    const enforceEaFlag = Boolean(opts.enforceEaStartOnBootFlag);

    let currentSec = '';
    let modified = false;
    let sawEaDesktopSection = false;
    let sawStartOnBootInCurrentSection = false;
    let skipContinuation = false;
    /** @type {string[]} */
    const outLines = [];

    const flushEaDesktopSectionIfNeeded = () => {
      if (
        enforceEaFlag &&
        currentSec === 'software\\electronic arts\\ea desktop' &&
        !sawStartOnBootInCurrentSection
      ) {
        let insertIdx = outLines.length;
        while (insertIdx > 0 && outLines[insertIdx - 1].trim() === '') {
          insertIdx -= 1;
        }
        outLines.splice(insertIdx, 0, '"startOnBootFlag"=dword:00000000');
        sawStartOnBootInCurrentSection = true;
        modified = true;
      }
    };

    for (const line of lines) {
      if (skipContinuation) {
        if (!hasOddTrailingBackslashes(line.trimEnd())) {
          skipContinuation = false;
        }
        continue;
      }

      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        const closeBracket = trimmed.indexOf(']');
        if (closeBracket > 1) {
          flushEaDesktopSectionIfNeeded();
          currentSec = normalizeWineRegistrySectionKey(trimmed.slice(1, closeBracket));
          if (currentSec === 'software\\electronic arts\\ea desktop') {
            sawEaDesktopSection = true;
            sawStartOnBootInCurrentSection = false;
          }
        }
        outLines.push(line);
        continue;
      }

      if (
        (currentSec === 'software\\microsoft\\windows\\currentversion\\run' ||
          currentSec === 'software\\microsoft\\windows\\currentversion\\runonce' ||
          currentSec === 'software\\wow6432node\\microsoft\\windows\\currentversion\\run' ||
          currentSec === 'software\\wow6432node\\microsoft\\windows\\currentversion\\runonce') &&
        isChainedPublisherAutostartRunLine(line)
      ) {
        modified = true;
        if (hasOddTrailingBackslashes(line.trimEnd())) {
          skipContinuation = true;
        }
        continue;
      }

      if (
        enforceEaFlag &&
        currentSec === 'software\\electronic arts\\ea desktop' &&
        /^\s*"startonbootflag"\s*=/i.test(line)
      ) {
        sawStartOnBootInCurrentSection = true;
        if (trimmed !== '"startOnBootFlag"=dword:00000000') {
          outLines.push('"startOnBootFlag"=dword:00000000');
          modified = true;
        } else {
          outLines.push(line);
        }
        continue;
      }

      outLines.push(line);
    }

    flushEaDesktopSectionIfNeeded();

    if (enforceEaFlag && !sawEaDesktopSection) {
      if (outLines.length > 0 && outLines[outLines.length - 1].trim() !== '') {
        outLines.push('');
      }
      outLines.push('[Software\\\\Electronic Arts\\\\EA Desktop]');
      outLines.push('"startOnBootFlag"=dword:00000000');
      outLines.push('');
      modified = true;
    }

    if (!modified) return false;

    atomicWriteFileSync(regFilePath, outLines.join(eol));
    return true;
  } catch {
    return false;
  }
}

/**
 * Strip `CurrentVersion\\Run` and `Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Run` autostart
 * entries for EA, Ubisoft, Battle.net, and Rockstar across BOTH `<bottlePath>/user.reg` and
 * `<bottlePath>/system.reg` (plus `"startOnBootFlag"=dword:00000000` for EA Desktop) so background
 * publisher clients never auto-boot on unrelated bottle launches.
 *
 * @param {string} bottlePath
 * @returns {boolean} `true` if either `user.reg` or `system.reg` was modified on disk.
 */
function sanitizeChainedPublisherAutostartInBottleRegs(bottlePath) {
  if (!bottlePath || typeof bottlePath !== 'string') return false;
  const userModified = sanitizePublisherAutostartInSingleRegFile(
    bottlePath,
    path.join(bottlePath, 'user.reg'),
    { enforceEaStartOnBootFlag: true }
  );
  const sysModified = sanitizePublisherAutostartInSingleRegFile(
    bottlePath,
    path.join(bottlePath, 'system.reg'),
    { enforceEaStartOnBootFlag: false }
  );
  return userModified || sysModified;
}

/**
 * Backwards-compatible alias delegating to `sanitizeChainedPublisherAutostartInBottleRegs(bottlePath)`.
 *
 * @param {string} bottlePath
 * @returns {boolean}
 */
function sanitizeEaBottleAutostartInUserReg(bottlePath) {
  return sanitizeChainedPublisherAutostartInBottleRegs(bottlePath);
}

/**
 * Collect normalized lowercase install directory paths belonging to managed publisher launcher
 * clients inside `bottlePath` using an already-parsed `system.reg` map (zero cyclic require and
 * zero redundant `system.reg` reads).
 *
 * @param {string} bottlePath
 * @param {Map<string, Record<string, string>>} parsedSections
 * @returns {Set<string>}
 */
function collectProtectedBottleLauncherInstallDirs(bottlePath, parsedSections) {
  /** @type {Set<string>} */
  const protectedDirs = new Set();

  const addProtectedWinDir = (/** @type {string} */ winPath) => {
    const clean = String(winPath || '').trim().replace(/[\\/]+$/, '');
    if (!clean) return;
    const hostPath = resolveBottleWindowsPathReadOnly(clean, bottlePath);
    if (hostPath) {
      protectedDirs.add(path.resolve(hostPath).replace(/[\\/]+$/, '').toLowerCase());
    }
  };

  const addProtectedExeParentIfExists = (/** @type {string} */ winExePath) => {
    const hostExe = resolveBottleWindowsPathReadOnly(winExePath, bottlePath);
    if (!hostExe) return;
    try {
      const st = fs.statSync(hostExe);
      if (st.isFile() && st.size > 0) {
        protectedDirs.add(path.resolve(path.dirname(hostExe)).replace(/[\\/]+$/, '').toLowerCase());
      }
    } catch {}
  };

  // Ubisoft
  const ubiSec32 = parsedSections.get('Software\\Wow6432Node\\Ubisoft\\Launcher');
  const ubiSec64 = parsedSections.get('Software\\Ubisoft\\Launcher');
  addProtectedWinDir(
    getRegistryPropCaseInsensitive(ubiSec32, 'InstallDir') ||
      getRegistryPropCaseInsensitive(ubiSec64, 'InstallDir')
  );
  addProtectedExeParentIfExists('C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\upc.exe');
  addProtectedExeParentIfExists(
    'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\UbisoftConnect.exe'
  );
  addProtectedExeParentIfExists('C:\\Program Files\\Ubisoft\\Ubisoft Game Launcher\\upc.exe');

  // EA App
  const eaSec64 = parsedSections.get('Software\\Electronic Arts\\EA Desktop');
  const eaSec32 = parsedSections.get('Software\\Wow6432Node\\Electronic Arts\\EA Desktop');
  addProtectedWinDir(
    getRegistryPropCaseInsensitive(eaSec64, 'InstallLocation') ||
      getRegistryPropCaseInsensitive(eaSec32, 'InstallLocation')
  );
  const eaClientPath =
    getRegistryPropCaseInsensitive(eaSec64, 'ClientPath') ||
    getRegistryPropCaseInsensitive(eaSec32, 'ClientPath');
  if (eaClientPath) addProtectedExeParentIfExists(eaClientPath);
  addProtectedExeParentIfExists(
    'C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe'
  );
  addProtectedExeParentIfExists(
    'C:\\Program Files (x86)\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe'
  );

  // Battle.net
  const bnetSec32 = parsedSections.get(
    'Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Battle.net'
  );
  const bnetSec64 = parsedSections.get(
    'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Battle.net'
  );
  addProtectedWinDir(
    getRegistryPropCaseInsensitive(bnetSec32, 'InstallLocation') ||
      getRegistryPropCaseInsensitive(bnetSec64, 'InstallLocation')
  );
  addProtectedExeParentIfExists('C:\\Program Files (x86)\\Battle.net\\Battle.net.exe');
  addProtectedExeParentIfExists('C:\\Program Files\\Battle.net\\Battle.net.exe');

  // Rockstar Games Launcher
  const rglSec32 = parsedSections.get('Software\\Wow6432Node\\Rockstar Games\\Launcher');
  const rglSec64 = parsedSections.get('Software\\Rockstar Games\\Launcher');
  addProtectedWinDir(
    getRegistryPropCaseInsensitive(rglSec32, 'InstallFolder') ||
      getRegistryPropCaseInsensitive(rglSec64, 'InstallFolder')
  );
  addProtectedExeParentIfExists('C:\\Program Files\\Rockstar Games\\Launcher\\Launcher.exe');
  addProtectedExeParentIfExists('C:\\Program Files (x86)\\Rockstar Games\\Launcher\\Launcher.exe');

  return protectedDirs;
}

/**
 * Safely remove uninstalled game `Uninstall` and publisher-install registry sections matching
 * `installDir` inside `<bottlePath>/system.reg` for `ubisoft`, `ea`, `bnet`, and `rockstar`
 * without ever touching the publisher launcher's own registration keys.
 *
 * @param {string} bottlePath
 * @param {string} installDir
 * @param {string} [handoffId]
 * @returns {{ modified: boolean, removedSections: string[] }}
 */
function stripPublisherUninstallKeysFromSystemReg(bottlePath, installDir, handoffId = '') {
  /** @type {string[]} */
  const removedSections = [];
  if (
    !bottlePath ||
    typeof bottlePath !== 'string' ||
    !installDir ||
    typeof installDir !== 'string'
  ) {
    return { modified: false, removedSections };
  }
  const canonical = handoffId ? normalizeChainedHandoffId(handoffId) : null;
  if (canonical === 'riot') {
    return { modified: false, removedSections };
  }

  const driveCRoot = path.join(bottlePath, 'drive_c');
  const targetHostDir = installDir.startsWith('/')
    ? resolveWineReparseTargetReadOnly(installDir, driveCRoot)
    : resolveBottleWindowsPathReadOnly(installDir, bottlePath);
  if (!targetHostDir || isForbiddenBroadPublisherContainerDir(targetHostDir, bottlePath)) {
    return { modified: false, removedSections };
  }
  const targetNormLower = path.resolve(targetHostDir).replace(/[\\/]+$/, '').toLowerCase();

  const sysRegPath = path.join(bottlePath, 'system.reg');
  try {
    if (!isRegFileContainedInBottle(bottlePath, sysRegPath)) {
      return { modified: false, removedSections };
    }
    if (!fs.existsSync(sysRegPath)) {
      return { modified: false, removedSections };
    }
    const raw = fs.readFileSync(sysRegPath, 'utf8');
    const parsedSections = parseWineRegistrySections(raw);

    // Never strip a launcher client's own install directory
    const protectedLauncherDirs = collectProtectedBottleLauncherInstallDirs(
      bottlePath,
      parsedSections
    );
    if (protectedLauncherDirs.has(targetNormLower)) {
      return { modified: false, removedSections };
    }

    /** @type {Set<string>} */
    const sectionsToStrip = new Set();

    const matchesTargetDir = (/** @type {string} */ rawRegPath) => {
      if (!rawRegPath) return false;
      const trimmed = rawRegPath.trim().replace(/^"+|"+$/g, '');
      if (!trimmed) return false;
      const resolved = trimmed.startsWith('/')
        ? resolveWineReparseTargetReadOnly(trimmed, driveCRoot)
        : resolveBottleWindowsPathReadOnly(trimmed, bottlePath);
      if (!resolved) return false;
      return path.resolve(resolved).replace(/[\\/]+$/, '').toLowerCase() === targetNormLower;
    };

    for (const [secKey, props] of parsedSections.entries()) {
      const uninstMatch = secKey.match(
        /^software\\(?:wow6432node\\)?microsoft\\windows\\currentversion\\uninstall\\([^\\]+)$/i
      );
      if (uninstMatch && uninstMatch[1]) {
        const subKeyLower = uninstMatch[1].trim().toLowerCase();
        const dispName = getRegistryPropCaseInsensitive(props, 'DisplayName');
        const upgradeCode = getRegistryPropCaseInsensitive(props, 'UpgradeCode').toUpperCase();
        // Protect launcher clients' own Uninstall keys
        if (
          subKeyLower === 'battle.net' ||
          subKeyLower === 'uplay' ||
          subKeyLower === 'ubisoft connect' ||
          upgradeCode === EA_DESKTOP_MSI_UPGRADE_CODE ||
          /^(?:ea\s+(?:app|desktop)|battle\.net|ubisoft\s+connect|uplay|(?:rockstar\s+games\s+)?(?:launcher|social\s+club))$/i.test(
            dispName
          )
        ) {
          continue;
        }
        const loc =
          getRegistryPropCaseInsensitive(props, 'InstallLocation') ||
          getRegistryPropCaseInsensitive(props, 'InstallDir') ||
          getRegistryPropCaseInsensitive(props, 'InstallFolder');
        if (matchesTargetDir(loc)) {
          sectionsToStrip.add(secKey);
        }
        continue;
      }

      if (
        (!canonical || canonical === 'ubisoft') &&
        /^software\\(?:wow6432node\\)?ubisoft\\launcher\\installs\\[^\\]+$/i.test(secKey)
      ) {
        if (matchesTargetDir(getRegistryPropCaseInsensitive(props, 'InstallDir'))) {
          sectionsToStrip.add(secKey);
        }
        continue;
      }

      if (
        (!canonical || canonical === 'ea') &&
        /^software\\(?:wow6432node\\)?(?:ea games|origin games)\\[^\\]+$/i.test(secKey)
      ) {
        const loc =
          getRegistryPropCaseInsensitive(props, 'Install Dir') ||
          getRegistryPropCaseInsensitive(props, 'InstallLocation');
        if (matchesTargetDir(loc)) {
          sectionsToStrip.add(secKey);
        }
        continue;
      }

      if (!canonical || canonical === 'rockstar') {
        const rMatch = secKey.match(/^software\\(?:wow6432node\\)?rockstar games\\([^\\]+)$/i);
        if (rMatch && rMatch[1]) {
          const rSub = rMatch[1].trim().toLowerCase();
          if (rSub !== 'launcher' && rSub !== 'social club') {
            const loc =
              getRegistryPropCaseInsensitive(props, 'InstallFolder') ||
              getRegistryPropCaseInsensitive(props, 'InstallLocation');
            if (matchesTargetDir(loc)) {
              sectionsToStrip.add(secKey);
            }
          }
        }
      }
    }

    if (sectionsToStrip.size === 0) {
      return { modified: false, removedSections };
    }

    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    /** @type {string[]} */
    const outLines = [];
    let droppingCurrentSection = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        const closeBracket = trimmed.indexOf(']');
        if (closeBracket > 1) {
          const secKey = normalizeWineRegistrySectionKey(trimmed.slice(1, closeBracket));
          if (sectionsToStrip.has(secKey)) {
            droppingCurrentSection = true;
            removedSections.push(secKey);
            continue;
          }
          droppingCurrentSection = false;
        }
      }
      if (!droppingCurrentSection) {
        outLines.push(line);
      }
    }

    atomicWriteFileSync(sysRegPath, outLines.join(eol));
    return { modified: true, removedSections };
  } catch {
    return { modified: false, removedSections };
  }
}

module.exports = {
  unescapeWineRegValue,
  decodeWineRegUtf16LeHex,
  parseWineRegRhsValue,
  normalizeWineRegistrySectionKey,
  WineRegistrySectionMap,
  parseWineRegistrySections,
  getRegistryPropCaseInsensitive,
  getBottleSystemRegSections,
  getBottleSystemRegSectionsAsync,
  resolveDriveCPathCaseInsensitiveAsync,
  fromWineWindowsPathAsync,
  decodeWineReparseDataBuffer,
  readWineReparseXattrCached,
  readWineReparseXattrCachedAsync,
  resolveWineReparseTargetReadOnly,
  resolveWineReparseTargetReadOnlyAsync,
  resolveBottleWindowsPathReadOnly,
  resolveBottleWindowsPathReadOnlyAsync,
  listBottleUserDirectories,
  listBottleUserDirectoriesAsync,
  isChainedPublisherAutostartRunLine,
  sanitizeChainedPublisherAutostartInBottleRegs,
  sanitizeEaBottleAutostartInUserReg,
  stripPublisherUninstallKeysFromSystemReg,
};
