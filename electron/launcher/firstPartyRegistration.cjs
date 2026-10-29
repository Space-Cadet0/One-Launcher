// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { atomicWriteFileSync } = require('./securityAndPathUtils.cjs');
const { resolveDriveCPathCaseInsensitive } = require('./wineAndCrossOverManager.cjs');

/**
 * Convert a host POSIX path into the Windows path representation visible inside `bottlePath`.
 * - Paths inside `<bottlePath>/drive_c/...` map to `C:\...`.
 * - Paths elsewhere on the host filesystem map via Wine's root `Z:` drive (`Z:\...`).
 *
 * @param {string} posixPath
 * @param {string} [bottlePath]
 * @returns {string}
 */
function toWineWindowsPath(posixPath, bottlePath = '') {
  if (!posixPath || typeof posixPath !== 'string') return '';
  const trimmed = posixPath.trim();
  if (!trimmed) return '';

  const hasBottle = Boolean(bottlePath && typeof bottlePath === 'string' && bottlePath.trim());
  const isWinDrivePath = /^[a-zA-Z]:(?:[\\/]|$)/.test(trimmed);
  const isBottleWinHostPath = hasBottle && /^[a-zA-Z]:[\\/]/.test(bottlePath.trim());

  // Already a Windows drive path (unless both posixPath and bottlePath are host paths on a Windows test runner)
  if (isWinDrivePath && (!isBottleWinHostPath || /^[zZ]:(?:[\\/]|$)/.test(trimmed))) {
    const normWin = trimmed.replace(/\//g, '\\');
    return /^[a-zA-Z]:$/.test(normWin) ? `${normWin}\\` : normWin;
  }

  const normalizeForCompare = (p) =>
    /^[a-zA-Z]:[\\/]/.test(p)
      ? p.replace(/\\/g, '/').replace(/\/+$/, '')
      : path.posix.resolve(p.replace(/\\/g, '/'));

  const resolvedPosix = normalizeForCompare(trimmed);

  if (hasBottle) {
    const resolvedBottle = normalizeForCompare(bottlePath.trim());
    const driveCPosix = `${resolvedBottle}/drive_c`;
    const driveCRegex = new RegExp(`^${escapeRegExp(driveCPosix)}(?:$|/(.*))`, 'i');
    const driveCMatch = resolvedPosix.match(driveCRegex);
    if (driveCMatch) {
      const rel = (driveCMatch[1] || '').replace(/\//g, '\\');
      return rel ? `C:\\${rel}` : 'C:\\';
    }
  }

  const withoutHostRoot = resolvedPosix.replace(/^(?:[a-zA-Z]:)?\/+/, '');
  return withoutHostRoot ? `Z:\\${withoutHostRoot.replace(/\//g, '\\')}` : 'Z:\\';
}

/**
 * Convert a Wine Windows path (`C:\...` or `Z:\...`) back to a host POSIX path.
 *
 * @param {string} winPath
 * @param {string} [bottlePath]
 * @returns {string}
 */
function fromWineWindowsPath(winPath, bottlePath = '') {
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

  if (driveLetter === 'C' && bottlePath && typeof bottlePath === 'string' && bottlePath.trim()) {
    const driveCRoot = path.join(bottlePath.trim(), 'drive_c');
    if (fs.existsSync(driveCRoot)) {
      return resolveDriveCPathCaseInsensitive(driveCRoot, relParts);
    }
    return path.join(driveCRoot, ...relParts);
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
      if (fs.existsSync(dosLink)) {
        const realRoot = fs.realpathSync(dosLink);
        return path.join(realRoot, ...relParts);
      }
    } catch {}
  }

  return trimmed;
}

/**
 * Escape a string for safe inclusion inside quotes in a Wine `.reg` file (`"key"="value"`).
 *
 * @param {string} raw
 * @returns {string}
 */
function escapeWineRegString(raw) {
  return String(raw ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

/**
 * Format a single Wine `.reg` value assignment line (`REG_SZ`, `REG_DWORD`, or `REG_QWORD` `hex(b):...`).
 * Supports both `formatWineRegEntryLine(key, { type, value })` and `formatWineRegEntryLine(key, type, value)`.
 *
 * @param {string} key
 * @param {any} valOrType
 * @param {any} [maybeValue]
 * @returns {string}
 */
function formatWineRegEntryLine(key, valOrType, maybeValue) {
  const escapedKey = escapeWineRegString(key);
  const val =
    arguments.length >= 3 && typeof valOrType === 'string'
      ? { type: valOrType, value: maybeValue }
      : valOrType;
  if (val && typeof val === 'object') {
    const rawType = String(val.type || '').trim().toLowerCase();
    const rawPayload = val.value !== undefined ? val.value : val.data;
    if (rawType === 'dword' || rawType === 'reg_dword') {
      const num = (Number(rawPayload) >>> 0).toString(16).padStart(8, '0');
      return `"${escapedKey}"=dword:${num}`;
    }
    if (rawType === 'qword' || rawType === 'reg_qword') {
      if (
        typeof rawPayload === 'string' &&
        /^hex\(b\):[0-9a-f]{2}(?:,[0-9a-f]{2}){7}$/i.test(rawPayload.trim())
      ) {
        return `"${escapedKey}"=${rawPayload.trim().toLowerCase()}`;
      }
      const u64 = BigInt(rawPayload ?? 0) & 0xffffffffffffffffn;
      const bytes = [];
      for (let i = 0; i < 8; i += 1) {
        bytes.push(Number((u64 >> BigInt(i * 8)) & 0xffn).toString(16).padStart(2, '0'));
      }
      return `"${escapedKey}"=hex(b):${bytes.join(',')}`;
    }
    if (rawType === 'sz' || rawType === 'reg_sz') {
      return `"${escapedKey}"="${escapeWineRegString(String(rawPayload ?? ''))}"`;
    }
  }
  return `"${escapedKey}"="${escapeWineRegString(String(val ?? ''))}"`;
}

/**
 * Escape RegExp special characters.
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect whether a live `wineserver` socket currently exists for `bottlePath`.
 * When `wineserver` is active, direct edits to `system.reg` / `user.reg` on disk would be
 * overwritten when `wineserver` flushes its in-memory registry unless `wine reg.exe import` is run.
 *
 * @param {string} bottlePath
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function isBottleWineserverActive(bottlePath, options = {}) {
  if (typeof options.wineserverActive === 'boolean') {
    return options.wineserverActive;
  }
  if (!bottlePath || typeof bottlePath !== 'string' || process.platform === 'win32') {
    return false;
  }
  if (typeof process.getuid !== 'function') {
    return false;
  }
  const uid = process.getuid();
  const baseTmpDirs = Array.from(new Set(['/tmp', os.tmpdir()]));
  const candidatePrefixPaths = [bottlePath];
  try {
    const real = fs.realpathSync(bottlePath);
    if (real && real !== bottlePath) candidatePrefixPaths.push(real);
  } catch {}

  for (const p of candidatePrefixPaths) {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    const devHex = Number(st.dev).toString(16);
    const inoHex = Number(st.ino).toString(16);
    const serverFolder = `server-${devHex}-${inoHex}`;
    for (const tmpRoot of baseTmpDirs) {
      const socketPath = path.join(tmpRoot, `.wine-${uid}`, serverFolder, 'socket');
      try {
        if (fs.existsSync(socketPath)) {
          return true;
        }
      } catch {}
    }
  }
  return false;
}

/**
 * Resolve a suitable Wine / CrossOver binary for running `reg.exe import` against `bottlePath`.
 *
 * @param {string} bottlePath
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function resolveWineBinaryForBottle(bottlePath, options = {}) {
  const explicit = String(
    options.wineBinaryPath || options.compatLayer?.binaryPath || ''
  ).trim();
  if (explicit && (typeof options.execFileFn === 'function' || fs.existsSync(explicit))) {
    return explicit;
  }
  const homedir = options.homedir || os.homedir();
  const prefersPreview = /CrossOver Preview/i.test(String(bottlePath || ''));
  const candidates = [
    ...(prefersPreview
      ? [
          '/Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine',
          path.join(
            homedir,
            'Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine'
          ),
        ]
      : []),
    '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
    path.join(homedir, 'Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine'),
    '/Applications/CrossOver Preview.app/Contents/SharedSupport/CrossOver/bin/wine',
    '/opt/homebrew/bin/wine64',
    '/opt/homebrew/bin/wine',
    '/usr/local/bin/wine64',
    '/usr/local/bin/wine',
  ];
  for (const cand of candidates) {
    try {
      if (cand && fs.existsSync(cand)) return cand;
    } catch {}
  }
  return '';
}

/**
 * Import a registry key update or deletion into a running `wineserver` asynchronously via `reg.exe import`.
 *
 * @param {string} bottlePath
 * @param {'HKEY_LOCAL_MACHINE' | 'HKEY_CURRENT_USER'} hiveName
 * @param {string} normalizedSubKey
 * @param {Array<[string, any]> | null} entryPairsOrNullForDelete
 * @param {Record<string, any>} [options]
 * @returns {Promise<boolean>}
 */
function syncLiveWineRegistryAsync(
  bottlePath,
  hiveName,
  normalizedSubKey,
  entryPairsOrNullForDelete,
  options = {}
) {
  if (!bottlePath || !normalizedSubKey || !isBottleWineserverActive(bottlePath, options)) {
    return Promise.resolve(false);
  }
  const wineBin = resolveWineBinaryForBottle(bottlePath, options);
  const execFileImpl =
    typeof options.execFileFn === 'function'
      ? options.execFileFn
      : typeof options.execFileImpl === 'function'
        ? options.execFileImpl
        : execFile;
  if (!wineBin) return Promise.resolve(false);

  const regLines = ['Windows Registry Editor Version 5.00', ''];
  if (entryPairsOrNullForDelete === null) {
    regLines.push(`[-${hiveName}\\${normalizedSubKey}]`);
    const wowMatch = normalizedSubKey.match(/^software\\wow6432node\\(.+)$/i);
    if (wowMatch && wowMatch[1]) {
      regLines.push(`[-${hiveName}\\Software\\${wowMatch[1]}]`);
    } else {
      const softMatch = normalizedSubKey.match(/^software\\(.+)$/i);
      if (softMatch && softMatch[1]) {
        regLines.push(`[-${hiveName}\\Software\\Wow6432Node\\${softMatch[1]}]`);
      }
    }
  } else {
    regLines.push(`[${hiveName}\\${normalizedSubKey}]`);
    for (const [k, v] of entryPairsOrNullForDelete) {
      regLines.push(formatWineRegEntryLine(String(k), v));
    }
  }
  regLines.push('');

  const tempRegPath = path.join(
    os.tmpdir(),
    `one-launcher-winereg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.reg`
  );
  const isCrossOverBottle = /\/Bottles\/([^/]+)$/i.exec(bottlePath.replace(/\\/g, '/'));
  const bottleEnv = {
    ...process.env,
    WINEPREFIX: bottlePath,
    ...(isCrossOverBottle && isCrossOverBottle[1] ? { CX_BOTTLE: isCrossOverBottle[1] } : {}),
  };

  return new Promise((resolve) => {
    try {
      fs.writeFileSync(tempRegPath, '\uFEFF' + regLines.join('\r\n'), 'utf16le');
    } catch {
      resolve(false);
      return;
    }
    const cleanup = () => {
      fs.promises.unlink(tempRegPath).catch(() => {});
    };
    try {
      execFileImpl(
        wineBin,
        ['reg.exe', 'import', tempRegPath],
        { env: bottleEnv, timeout: 5000 },
        (/** @type {any} */ err) => {
          cleanup();
          resolve(!err);
        }
      );
    } catch {
      cleanup();
      resolve(false);
    }
  });
}

/**
 * Upserts a registry key and values inside a Wine bottle `.reg` file (`system.reg` by default).
 * Preserves `WINE REGISTRY Version 2` header, `#arch=` directive, and any unrelated keys.
 *
 * @param {string} bottlePath
 * @param {string} subKeyPath
 * @param {Array<[string, any]> | Record<string, any>} entries
 * @param {Record<string, any>} [options]
 * @returns {{ updated: boolean, regFilePath: string }}
 */
function upsertWineSystemRegKey(bottlePath, subKeyPath, entries, options = {}) {
  const regFilePath =
    typeof options.regFilePath === 'string' && options.regFilePath
      ? options.regFilePath
      : bottlePath
        ? path.join(bottlePath, 'system.reg')
        : '';
  if (!regFilePath || !subKeyPath) {
    return { updated: false, regFilePath: '' };
  }

  const normalizedSubKey = String(subKeyPath)
    .trim()
    .replace(/^\\+|\\+$/g, '')
    .replace(/\\+/g, '\\');
  if (!normalizedSubKey) {
    return { updated: false, regFilePath };
  }

  const escapedSectionPath = normalizedSubKey.replace(/\\/g, '\\\\');
  /** @type {Array<[string, any]>} */
  const entryPairs = Array.isArray(entries)
    ? entries
    : entries && typeof entries === 'object'
      ? Object.entries(entries)
      : [];

  let content = '';
  if (fs.existsSync(regFilePath)) {
    try {
      content = fs.readFileSync(regFilePath, 'utf8');
    } catch {
      content = '';
    }
  }

  if (!content.trim()) {
    content = 'WINE REGISTRY Version 2\n;; All keys relative to \\\\Machine\n\n#arch=win64\n';
  }

  const unixSec = Math.floor(Date.now() / 1000);
  const sectionHeaderRe = new RegExp(
    `^\\[${escapeRegExp(escapedSectionPath)}\\](?:\\s+\\d+)?[^\\r\\n]*$`,
    'im'
  );
  const match = sectionHeaderRe.exec(content);

  if (match) {
    const headerEnd = match.index + match[0].length;
    const afterHeader = content.slice(headerEnd);
    const nextSectionMatch = /^\[[^\]]+\]/m.exec(afterHeader);
    const body = nextSectionMatch ? afterHeader.slice(0, nextSectionMatch.index) : afterHeader;
    const rest = nextSectionMatch ? afterHeader.slice(nextSectionMatch.index) : '';

    const bodyLines = body.split(/\r?\n/);
    /** @type {Map<string, [string, any]>} */
    const pendingByLower = new Map();
    for (const [k, v] of entryPairs) {
      pendingByLower.set(String(k).toLowerCase(), [String(k), v]);
    }

    /** @type {Set<string>} */
    const updatedLower = new Set();
    const nextBodyLines = bodyLines.map((line) => {
      const kvMatch = line.match(/^\s*"((?:[^"\\]|\\.)+)"\s*=/);
      if (!kvMatch) return line;
      const unescapedKey = kvMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      const lowerKey = unescapedKey.toLowerCase();
      if (pendingByLower.has(lowerKey)) {
        const pair = pendingByLower.get(lowerKey);
        if (pair) {
          updatedLower.add(lowerKey);
          return formatWineRegEntryLine(pair[0], pair[1]);
        }
      }
      return line;
    });

    /** @type {string[]} */
    const toAppend = [];
    for (const [lowerKey, pair] of pendingByLower.entries()) {
      if (!updatedLower.has(lowerKey)) {
        toAppend.push(formatWineRegEntryLine(pair[0], pair[1]));
      }
    }

    if (toAppend.length > 0) {
      let insertIdx = nextBodyLines.length;
      while (insertIdx > 0 && nextBodyLines[insertIdx - 1].trim() === '') {
        insertIdx--;
      }
      nextBodyLines.splice(insertIdx, 0, ...toAppend);
    }

    let rebuiltBody = nextBodyLines.join('\n');
    if (!rebuiltBody.startsWith('\n')) {
      rebuiltBody = `\n${rebuiltBody}`;
    }
    if (rest && !rebuiltBody.endsWith('\n\n')) {
      rebuiltBody = rebuiltBody.endsWith('\n') ? `${rebuiltBody}\n` : `${rebuiltBody}\n\n`;
    } else if (!rest && !rebuiltBody.endsWith('\n')) {
      rebuiltBody = `${rebuiltBody}\n`;
    }

    const updatedHeader = `[${escapedSectionPath}] ${unixSec}`;
    content = content.slice(0, match.index) + updatedHeader + rebuiltBody + rest;
  } else {
    const formattedLines = entryPairs.map(([k, v]) => formatWineRegEntryLine(String(k), v));
    const sep = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    content = `${content}${sep}[${escapedSectionPath}] ${unixSec}\n${formattedLines.join('\n')}\n`;
  }

  fs.mkdirSync(path.dirname(regFilePath), { recursive: true });
  atomicWriteFileSync(regFilePath, content);
  if (bottlePath && options.skipLiveWineRegSync !== true) {
    const hiveName =
      path.basename(regFilePath).toLowerCase() === 'user.reg'
        ? 'HKEY_CURRENT_USER'
        : 'HKEY_LOCAL_MACHINE';
    syncLiveWineRegistryAsync(bottlePath, hiveName, normalizedSubKey, entryPairs, options).catch(
      () => {}
    );
  }
  return { updated: true, regFilePath };
}

/**
 * Remove matching registry section(s) from `<bottlePath>/system.reg` cleanly via atomic write.
 * Automatically removes both `Software\Wow6432Node\<rest>` and `Software\<rest>` views when
 * given a `Software\...` key so 32-bit and 64-bit registry views stay clean.
 *
 * @param {string} bottlePath
 * @param {string} subKeyPath
 * @param {Record<string, any>} [options]
 * @returns {{ removed: number, regFilePath: string }}
 */
function deleteWineSystemRegKey(bottlePath, subKeyPath, options = {}) {
  const regFilePath =
    typeof options.regFilePath === 'string' && options.regFilePath
      ? options.regFilePath
      : bottlePath
        ? path.join(bottlePath, 'system.reg')
        : '';
  if (!regFilePath || !subKeyPath || !fs.existsSync(regFilePath)) {
    return { removed: 0, regFilePath };
  }

  const normalizedSubKey = String(subKeyPath)
    .trim()
    .replace(/^\\+|\\+$/g, '')
    .replace(/\\+/g, '\\');
  if (!normalizedSubKey) {
    return { removed: 0, regFilePath };
  }

  /** @type {Set<string>} */
  const targetEscapedSections = new Set();
  targetEscapedSections.add(normalizedSubKey.replace(/\\/g, '\\\\').toLowerCase());

  const wowMatch = normalizedSubKey.match(/^software\\wow6432node\\(.+)$/i);
  if (wowMatch && wowMatch[1]) {
    targetEscapedSections.add(`software\\\\${wowMatch[1].replace(/\\/g, '\\\\').toLowerCase()}`);
  } else {
    const softMatch = normalizedSubKey.match(/^software\\(.+)$/i);
    if (softMatch && softMatch[1]) {
      targetEscapedSections.add(
        `software\\\\wow6432node\\\\${softMatch[1].replace(/\\/g, '\\\\').toLowerCase()}`
      );
    }
  }

  let content = '';
  try {
    content = fs.readFileSync(regFilePath, 'utf8');
  } catch {
    return { removed: 0, regFilePath };
  }

  const lines = content.split(/\r?\n/);
  /** @type {string[]} */
  const outLines = [];
  let skippingSection = false;
  let removed = 0;

  for (const line of lines) {
    const secMatch = line.match(/^\[([^\]]+)\]/);
    if (secMatch) {
      const secKeyLower = secMatch[1].trim().toLowerCase();
      if (targetEscapedSections.has(secKeyLower)) {
        skippingSection = true;
        removed += 1;
        continue;
      }
      skippingSection = false;
    }
    if (!skippingSection) {
      outLines.push(line);
    }
  }

  if (removed > 0) {
    const cleaned = outLines.join('\n').replace(/\n{3,}/g, '\n\n');
    atomicWriteFileSync(regFilePath, cleaned.endsWith('\n') ? cleaned : `${cleaned}\n`);
    if (bottlePath && options.skipLiveWineRegSync !== true) {
      const hiveName =
        path.basename(regFilePath).toLowerCase() === 'user.reg'
          ? 'HKEY_CURRENT_USER'
          : 'HKEY_LOCAL_MACHINE';
      syncLiveWineRegistryAsync(bottlePath, hiveName, normalizedSubKey, null, options).catch(
        () => {}
      );
    }
  }

  return { removed, regFilePath };
}

/**
 * Compute exact .NET `DateTime.UtcNow.Ticks` (`100ns` intervals since `0001-01-01T00:00:00Z`)
 * serialized as a decimal string via `BigInt` so `MAX_SAFE_INTEGER` precision is never lost.
 *
 * @param {number} [nowMs]
 * @returns {bigint}
 */
function computeDotNetUtcTicksBigInt(nowMs = Date.now()) {
  return 621355968000000000n + BigInt(Math.trunc(nowMs)) * 10000n;
}

/**
 * Read current `number` counter from `InstalledItems/Revision.json` safely.
 *
 * @param {string} revisionJsonPath
 * @returns {number}
 */
function readEpicEoshRevisionNumber(revisionJsonPath) {
  if (!revisionJsonPath || !fs.existsSync(revisionJsonPath)) return 0;
  try {
    const raw = fs.readFileSync(revisionJsonPath, 'utf8');
    const numMatch = raw.match(/"number"\s*:\s*(\d+)/);
    if (numMatch) {
      return Number(numMatch[1]) || 0;
    }
    const parsed = JSON.parse(raw);
    return Number(parsed?.number || 0) || 0;
  } catch {
    return 0;
  }
}

/**
 * Atomically write `InstalledItems/Revision.json` with exact `.NET` ticks precision.
 *
 * @param {string} revisionJsonPath
 * @param {number} nextNumber
 */
function writeEpicEoshRevisionJson(revisionJsonPath, nextNumber) {
  const ticks = computeDotNetUtcTicksBigInt(Date.now());
  const rawJson = `{"timestamp":${ticks.toString()},"number":${Math.max(1, Math.trunc(nextNumber))}}`;
  atomicWriteFileSync(revisionJsonPath, rawJson);
}

/**
 * Normalize a Windows or POSIX install path for case-insensitive comparison.
 * @param {unknown} p
 * @returns {string}
 */
function normalizeInstallPathKey(p) {
  if (!p || typeof p !== 'string') return '';
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Write or update an Epic Online Services InstallHelper (`EOSH` / EGL 20.3+) `.egi` v4 manifest
 * and bump `InstalledItems/Revision.json` ONLY when `InstalledItems` directory already exists.
 *
 * @param {string} programDataEpicDir
 * @param {Record<string, any>} itemSpec
 * @returns {{ synced: boolean, egiPath?: string, revision?: number, reason?: string }}
 */
function syncEpicEoshInstalledItem(programDataEpicDir, itemSpec = {}) {
  if (!programDataEpicDir || typeof programDataEpicDir !== 'string') {
    return { synced: false, reason: 'missing_programdata_epic' };
  }

  const installedItemsDir = path.join(
    programDataEpicDir,
    'EpicOnlineServices',
    'InstallHelper',
    'InstalledItems'
  );
  if (!fs.existsSync(installedItemsDir)) {
    return { synced: false, reason: 'eosh_not_initialized' };
  }

  const artifactId = String(itemSpec.artifactId ?? itemSpec.appName ?? '').trim();
  const dirStr = String(itemSpec.dir ?? itemSpec.installLocation ?? '').trim();
  if (!artifactId || !dirStr) {
    return { synced: false, reason: 'missing_artifact_or_dir' };
  }

  const rawGuid = String(itemSpec.installationGuid ?? itemSpec.installationId ?? '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
  const guidLowerNoDashes =
    rawGuid.length === 32
      ? rawGuid
      : crypto.createHash('md5').update(`${artifactId}:${dirStr}`).digest('hex').toLowerCase();
  const guidUpper = guidLowerNoDashes.toUpperCase();

  const egiFileName = `${guidLowerNoDashes}.egi`;
  const egiPath = path.join(installedItemsDir, egiFileName);
  const revisionJsonPath = path.join(installedItemsDir, 'Revision.json');

  let prevItemRevision = 0;
  try {
    if (fs.existsSync(egiPath)) {
      const existingEgi = JSON.parse(fs.readFileSync(egiPath, 'utf8'));
      prevItemRevision = Number(existingEgi?.revision || 0) || 0;
    }
  } catch {
    prevItemRevision = 0;
  }

  // Remove any stale .egi files for the same artifactId or dir under a different GUID
  const normDirKey = normalizeInstallPathKey(dirStr);
  try {
    for (const f of fs.readdirSync(installedItemsDir)) {
      if (!f.toLowerCase().endsWith('.egi') || f.toLowerCase() === egiFileName) continue;
      const candidatePath = path.join(installedItemsDir, f);
      try {
        const parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
        const sameArtifact =
          parsed?.artifactId &&
          String(parsed.artifactId).toLowerCase() === artifactId.toLowerCase();
        const sameDir = normDirKey && normalizeInstallPathKey(parsed?.dir) === normDirKey;
        if (sameArtifact || sameDir) {
          fs.rmSync(candidatePath, { force: true });
        }
      } catch {}
    }
  } catch {}

  const usesWinSlashes = dirStr.includes('\\') || /^[a-zA-Z]:/.test(dirStr);
  const metaDirStr = String(
    itemSpec.metaDir ||
      (usesWinSlashes ? `${dirStr.replace(/\\+$/, '')}\\.egstore` : path.join(dirStr, '.egstore'))
  );
  const manifestPathStr = String(
    itemSpec.manifestPath ||
      (usesWinSlashes
        ? `${metaDirStr.replace(/\\+$/, '')}\\${guidUpper}.manifest`
        : path.join(metaDirStr, `${guidUpper}.manifest`))
  );

  const launchCommandStr = String(itemSpec.launchCommand ?? '');
  const launchExeStr = String(itemSpec.launchExe ?? itemSpec.launchExecutable ?? '').replace(
    /\//g,
    usesWinSlashes ? '\\' : '/'
  );
  const versionStr = String(itemSpec.version ?? '1.0');
  const buildSizeNum = Number(itemSpec.buildSize ?? itemSpec.installSize ?? 0) || 0;

  const egiPayload = {
    version: 4,
    installationId: guidLowerNoDashes,
    state: 'Installed',
    revision: prevItemRevision + 1,
    dir: dirStr,
    metaDir: metaDirStr,
    manifestPath: manifestPathStr,
    pendingManifestPath: '',
    platform: String(itemSpec.platform || 'Windows'),
    sandboxId: String(itemSpec.sandboxId ?? itemSpec.catalogNamespace ?? ''),
    itemId: String(itemSpec.itemId ?? itemSpec.catalogItemId ?? ''),
    artifactId,
    tags: Array.isArray(itemSpec.tags) ? itemSpec.tags : [],
    pendingTags: [],
    stagedVersion: '',
    manifestData: {
      version: versionStr,
      launchCommand: launchCommandStr,
      launchExe: launchExeStr,
      prereqSHA1Hash: String(itemSpec.prereqSHA1Hash || ''),
      buildSize: buildSizeNum,
    },
    pendingManifestData: {
      version: '',
      launchCommand: '',
      launchExe: '',
      prereqSHA1Hash: '',
      buildSize: 0,
    },
  };

  atomicWriteFileSync(egiPath, JSON.stringify(egiPayload, null, 2));
  const nextRevision = readEpicEoshRevisionNumber(revisionJsonPath) + 1;
  writeEpicEoshRevisionJson(revisionJsonPath, nextRevision);

  return { synced: true, egiPath, revision: nextRevision };
}

/**
 * Remove matching Epic EOSH `.egi` file(s) from `InstalledItems/` and bump `Revision.json`.
 *
 * @param {string} programDataEpicDir
 * @param {Record<string, any>} [matchCriteria]
 * @returns {{ removed: number, revision?: number }}
 */
function removeEpicEoshInstalledItem(programDataEpicDir, matchCriteria = {}) {
  if (!programDataEpicDir || typeof programDataEpicDir !== 'string') {
    return { removed: 0 };
  }

  const installedItemsDir = path.join(
    programDataEpicDir,
    'EpicOnlineServices',
    'InstallHelper',
    'InstalledItems'
  );
  if (!fs.existsSync(installedItemsDir)) {
    return { removed: 0 };
  }

  /** @type {Set<string>} */
  const artifactTargets = new Set();
  for (const rawId of [
    matchCriteria.artifactId,
    matchCriteria.appName,
    ...(Array.isArray(matchCriteria.appNames) ? matchCriteria.appNames : []),
  ]) {
    if (rawId) artifactTargets.add(String(rawId).trim().toLowerCase());
  }

  /** @type {Set<string>} */
  const itemTargets = new Set();
  for (const rawItem of [
    matchCriteria.itemId,
    matchCriteria.catalogItemId,
    ...(Array.isArray(matchCriteria.catalogItemIds) ? matchCriteria.catalogItemIds : []),
  ]) {
    if (rawItem) itemTargets.add(String(rawItem).trim().toLowerCase());
  }

  /** @type {Set<string>} */
  const dirTargets = new Set();
  for (const rawDir of [
    matchCriteria.dir,
    matchCriteria.installPath,
    ...(Array.isArray(matchCriteria.installPaths) ? matchCriteria.installPaths : []),
  ]) {
    const norm = normalizeInstallPathKey(rawDir);
    if (norm) dirTargets.add(norm);
  }

  let removed = 0;
  try {
    for (const f of fs.readdirSync(installedItemsDir)) {
      if (!f.toLowerCase().endsWith('.egi')) continue;
      const fullPath = path.join(installedItemsDir, f);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const artLower = String(parsed?.artifactId || '').trim().toLowerCase();
        const itemLower = String(parsed?.itemId || '').trim().toLowerCase();
        const dirKey = normalizeInstallPathKey(parsed?.dir);
        if (
          (artLower && artifactTargets.has(artLower)) ||
          (itemLower && itemTargets.has(itemLower)) ||
          (dirKey && dirTargets.has(dirKey))
        ) {
          fs.rmSync(fullPath, { force: true });
          removed += 1;
        }
      } catch {}
    }
  } catch {
    return { removed: 0 };
  }

  if (removed > 0) {
    const revisionJsonPath = path.join(installedItemsDir, 'Revision.json');
    const nextRevision = readEpicEoshRevisionNumber(revisionJsonPath) + 1;
    try {
      writeEpicEoshRevisionJson(revisionJsonPath, nextRevision);
    } catch {}
    return { removed, revision: nextRevision };
  }

  return { removed: 0 };
}

module.exports = {
  toWineWindowsPath,
  fromWineWindowsPath,
  escapeWineRegString,
  formatWineRegEntryLine,
  isBottleWineserverActive,
  resolveWineBinaryForBottle,
  syncLiveWineRegistryAsync,
  upsertWineSystemRegKey,
  deleteWineSystemRegKey,
  computeDotNetUtcTicksBigInt,
  syncEpicEoshInstalledItem,
  removeEpicEoshInstalledItem,
};
