// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES,
  STEAM_APPINFO_BUF_IDLE_TTL_MS,
  steamAppInfoCache,
  steamResolvedLaunchSpecCache,
  setBoundedMapEntry,
  toLocalFsPath,
} = require('../engineStateRegistry.cjs');
const { atomicWriteFileSync } = require('../securityAndPathUtils.cjs');
const { resolveDriveCPathCaseInsensitive } = require('../wineAndCrossOverManager.cjs');
const windowsRegistryDiscovery = require('../../utils/windowsRegistryDiscovery.cjs');
const {
  parseSteamLibraryFoldersVdf,
  inspectMacMachOHeader,
} = require('../binaryAndManifestInspectors.cjs');
const {
  isExcludedExecutable,
  resolveMacAppBundleBinary,
  findPrimaryExecutable,
} = require('./executableAndCodesignManager.cjs');
const {
  extractBottleRootFromPath,
  listBottleSubdirectories,
  detectCompatibilityLayers,
} = require('./compatLayerRegistryAndDetection.cjs');

function scheduleSteamAppInfoBufEviction(/** @type {any} */ entry) {
  if (!entry) return;
  if (entry.evictTimer) {
    try {
      clearTimeout(entry.evictTimer);
    } catch {}
  }
  entry.evictTimer = setTimeout(() => {
    entry.buf = null;
    entry.evictTimer = null;
  }, STEAM_APPINFO_BUF_IDLE_TTL_MS);
  if (entry.evictTimer && typeof entry.evictTimer.unref === 'function') {
    entry.evictTimer.unref();
  }
}

/**
 * Non-blocking async variant of `getIndexedSteamAppInfoVdf` that reads `appinfo.vdf` via
 * `fs.promises.readFile` and populates the shared `steamAppInfoCache` index.
 *
 * @param {string} appinfoPath
 * @returns {Promise<any>}
 */
async function getIndexedSteamAppInfoVdfAsync(appinfoPath) {
  if (!appinfoPath) return null;
  try {
    const stat = await fs.promises.stat(appinfoPath);
    if (!stat.isFile() || stat.size < 16 || stat.size > 256 * 1024 * 1024) return null;
    const cached = steamAppInfoCache.get(appinfoPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      if (cached.buf) {
        scheduleSteamAppInfoBufEviction(cached);
      }
      return cached;
    }

    const buf = await fs.promises.readFile(appinfoPath);
    const magic = buf.readUInt32LE(0);
    if ((magic & 0xffffff00) !== 0x07564400) return null;
    const version = magic & 0xff;
    let pos = 8;
    /** @type {string[] | null} */
    let strings = null;

    if (version >= 0x29) {
      if (buf.length < 16) return null;
      const strTableOffset = Number(buf.readBigInt64LE(8));
      pos = 16;
      if (strTableOffset >= 16 && strTableOffset + 4 <= buf.length) {
        const strCount = buf.readUInt32LE(strTableOffset);
        if (strCount <= 2000000) {
          strings = new Array(strCount);
          let sp = strTableOffset + 4;
          for (let i = 0; i < strCount && sp < buf.length; i++) {
            const zero = buf.indexOf(0, sp);
            if (zero === -1) break;
            strings[i] = buf.toString('utf8', sp, zero);
            sp = zero + 1;
          }
        }
      }
    }

    /** @type {Map<string, { start: number, end: number }>} */
    const appIndex = new Map();
    const headerAfterSize = version >= 0x28 ? 60 : 40;
    while (pos + 8 <= buf.length) {
      const appId = buf.readUInt32LE(pos);
      if (appId === 0) break;
      const entrySize = buf.readUInt32LE(pos + 4);
      const entryEnd = pos + 8 + entrySize;
      if (entrySize === 0 || entryEnd > buf.length) break;
      const vdfStart = pos + 8 + headerAfterSize;
      if (vdfStart < entryEnd) {
        appIndex.set(String(appId), { start: vdfStart, end: entryEnd });
      }
      pos = entryEnd;
    }

    if (steamAppInfoCache.size >= 6) {
      const oldestKey = steamAppInfoCache.keys().next().value;
      if (oldestKey) {
        const evicted = steamAppInfoCache.get(oldestKey);
        if (evicted && evicted.evictTimer) {
          clearTimeout(evicted.evictTimer);
          evicted.evictTimer = null;
        }
        steamAppInfoCache.delete(oldestKey);
      }
    }
    const entry = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      version,
      strings,
      buf,
      appIndex,
      evictTimer: null,
    };
    steamAppInfoCache.set(appinfoPath, entry);
    scheduleSteamAppInfoBufEviction(entry);
    return entry;
  } catch {
    return null;
  }
}

function getIndexedSteamAppInfoVdf(appinfoPath) {
  try {
    if (!appinfoPath || !fs.existsSync(appinfoPath)) return null;
    const st = fs.statSync(appinfoPath);
    const mtimeMs = st.mtimeMs || 0;
    const cached = steamAppInfoCache.get(appinfoPath);
    if (cached && cached.mtimeMs === mtimeMs) {
      if (cached.buf) {
        scheduleSteamAppInfoBufEviction(cached);
      }
      return cached;
    }
    if (cached && cached.evictTimer) {
      try {
        clearTimeout(cached.evictTimer);
      } catch {}
      cached.evictTimer = null;
    }

    const buf = fs.readFileSync(appinfoPath);
    if (buf.length < 16) return null;

    const magic = buf.readUInt32LE(0);
    if (magic !== 0x07564429 && magic !== 0x07564428 && magic !== 0x07564427) {
      return null;
    }

    let strings = null;
    let entriesEnd = buf.length;
    let pos = 8;

    if (magic === 0x07564429) {
      const strTableOffset = Number(buf.readBigInt64LE(8));
      pos = 16;
      if (strTableOffset > 16 && strTableOffset + 4 <= buf.length) {
        entriesEnd = strTableOffset;
        const strCount = buf.readUInt32LE(strTableOffset);
        strings = new Array(strCount);
        let sPos = strTableOffset + 4;
        for (let i = 0; i < strCount && sPos < buf.length; i++) {
          let end = sPos;
          while (end < buf.length && buf[end] !== 0) end++;
          strings[i] = buf.toString('utf8', sPos, end);
          sPos = end + 1;
        }
      }
    }

    const entryMetaBytes = magic === 0x07564427 ? 40 : 60;
    const appIndex = new Map();

    while (pos + 8 <= entriesEnd) {
      const entryAppId = buf.readUInt32LE(pos);
      if (entryAppId === 0) break;
      const size = buf.readUInt32LE(pos + 4);
      const nextPos = pos + 8 + size;
      if (size <= entryMetaBytes || nextPos > entriesEnd) break;
      appIndex.set(entryAppId, {
        payloadStart: pos + 8 + entryMetaBytes,
        payloadEnd: nextPos,
      });
      pos = nextPos;
    }

    const indexed = {
      mtimeMs,
      buf,
      magic,
      strings,
      appIndex,
      evictTimer: null,
    };
    scheduleSteamAppInfoBufEviction(indexed);
    setBoundedMapEntry(steamAppInfoCache, appinfoPath, indexed, 16);
    return indexed;
  } catch {
    return null;
  }
}

function parseSteamBinaryVdfSlice(buf, startPos, endPos, strings) {
  let p = startPos;

  function readNullTerminatedUtf8() {
    let e = p;
    while (e < endPos && buf[e] !== 0) e++;
    const str = buf.toString('utf8', p, e);
    p = Math.min(endPos, e + 1);
    return str;
  }

  function readNullTerminatedUtf16() {
    let e = p;
    while (e + 1 < endPos && (buf[e] !== 0 || buf[e + 1] !== 0)) e += 2;
    const str = buf.toString('utf16le', p, e);
    p = Math.min(endPos, e + 2);
    return str;
  }

  function parseObject() {
    /** @type {Record<string, any>} */
    const obj = {};
    while (p < endPos) {
      const type = buf[p++];
      if (type === 0x08) break;

      let key;
      if (strings) {
        if (p + 4 > endPos) break;
        const keyIdx = buf.readUInt32LE(p);
        p += 4;
        key = strings[keyIdx] !== undefined ? strings[keyIdx] : String(keyIdx);
      } else {
        key = readNullTerminatedUtf8();
      }

      if (type === 0x00) {
        obj[key] = parseObject();
      } else if (type === 0x01) {
        obj[key] = readNullTerminatedUtf8();
      } else if (type === 0x02 || type === 0x04 || type === 0x06) {
        if (p + 4 > endPos) break;
        obj[key] = buf.readInt32LE(p);
        p += 4;
      } else if (type === 0x03) {
        if (p + 4 > endPos) break;
        obj[key] = buf.readFloatLE(p);
        p += 4;
      } else if (type === 0x05) {
        obj[key] = readNullTerminatedUtf16();
      } else if (type === 0x07 || type === 0x0a) {
        if (p + 8 > endPos) break;
        obj[key] = String(buf.readBigUInt64LE(p));
        p += 8;
      } else {
        break;
      }
    }
    return obj;
  }

  return parseObject();
}

function readSteamAppInfoParsedEntry(appinfoPath, appId) {
  try {
    const cleanAppId = parseInt(String(appId || '').replace(/^steam[-_]/i, '').trim(), 10);
    if (!cleanAppId || Number.isNaN(cleanAppId)) return null;
    const indexed = getIndexedSteamAppInfoVdf(appinfoPath);
    if (!indexed) return null;
    const slice = indexed.appIndex.get(cleanAppId);
    if (!slice) return null;
    if (indexed.buf) {
      scheduleSteamAppInfoBufEviction(indexed);
      return parseSteamBinaryVdfSlice(
        indexed.buf,
        slice.payloadStart,
        slice.payloadEnd,
        indexed.strings
      );
    }
    const sliceLen = slice.payloadEnd - slice.payloadStart;
    if (sliceLen <= 0) return null;
    const sliceBuf = Buffer.allocUnsafe(sliceLen);
    const fd = fs.openSync(appinfoPath, 'r');
    try {
      fs.readSync(fd, sliceBuf, 0, sliceLen, slice.payloadStart);
    } finally {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    return parseSteamBinaryVdfSlice(sliceBuf, 0, sliceLen, indexed.strings);
  } catch {
    return null;
  }
}

function findEnclosingSteamAppInfoVdf(startPaths = [], /** @type {any} */ options = {}) {
  if (options.appinfoVdfPath && fs.existsSync(options.appinfoVdfPath)) {
    return options.appinfoVdfPath;
  }
  const visited = new Set();
  for (const rawStart of startPaths) {
    if (!rawStart || typeof rawStart !== 'string') continue;
    let curr = toLocalFsPath(rawStart);
    for (let depth = 0; depth <= 6 && curr; depth++) {
      const resolvedCurr = path.resolve(curr);
      if (!visited.has(resolvedCurr)) {
        visited.add(resolvedCurr);
        const candidates = [
          path.join(resolvedCurr, 'appcache', 'appinfo.vdf'),
          path.join(resolvedCurr, 'Steam', 'appcache', 'appinfo.vdf'),
        ];
        for (const c of candidates) {
          if (fs.existsSync(c)) return c;
        }
      }
      const parent = path.dirname(resolvedCurr);
      if (!parent || parent === resolvedCurr) break;
      curr = parent;
    }
  }
  return null;
}

function resolveSteamAppInfoLaunchSpec(
  steamappsDirOrInstallPath,
  appId,
  /** @type {any} */ installPath,
  /** @type {any} */ options = {}
) {
  try {
    if (installPath && typeof installPath === 'object') {
      options = installPath;
      installPath = steamappsDirOrInstallPath;
    }
    const cleanAppId = parseInt(String(appId || '').replace(/^steam[-_]/i, '').trim(), 10);
    if (!cleanAppId || Number.isNaN(cleanAppId)) return null;

    const resolvedInstallPath = toLocalFsPath(installPath || steamappsDirOrInstallPath);
    const appinfoPath = findEnclosingSteamAppInfoVdf(
      [steamappsDirOrInstallPath, resolvedInstallPath],
      options
    );
    if (!appinfoPath) return null;

    const indexed = getIndexedSteamAppInfoVdf(appinfoPath);
    if (!indexed) return null;

    const platform = options.platform || process.platform;
    const specCacheKey = `${appinfoPath}::${indexed.mtimeMs}::${cleanAppId}`;
    if (steamResolvedLaunchSpecCache.has(specCacheKey)) {
      const cachedEntry = steamResolvedLaunchSpecCache.get(specCacheKey);
      if (
        cachedEntry &&
        cachedEntry.installPath === resolvedInstallPath &&
        cachedEntry.platform === platform
      ) {
        if (cachedEntry.spec === null) return null;
        if (cachedEntry.spec.executablePath && fs.existsSync(cachedEntry.spec.executablePath)) {
          return { ...cachedEntry.spec };
        }
      }
    }

    const slice = indexed.appIndex.get(cleanAppId);
    if (!slice) {
      setBoundedMapEntry(
        steamResolvedLaunchSpecCache,
        specCacheKey,
        { installPath: resolvedInstallPath, platform, spec: null },
        MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES
      );
      return null;
    }

    let parsedApp = null;
    if (indexed.buf) {
      scheduleSteamAppInfoBufEviction(indexed);
      parsedApp = parseSteamBinaryVdfSlice(
        indexed.buf,
        slice.payloadStart,
        slice.payloadEnd,
        indexed.strings
      );
    } else {
      const sliceLen = slice.payloadEnd - slice.payloadStart;
      if (sliceLen <= 0) return null;
      const sliceBuf = Buffer.allocUnsafe(sliceLen);
      const fd = fs.openSync(appinfoPath, 'r');
      try {
        fs.readSync(fd, sliceBuf, 0, sliceLen, slice.payloadStart);
      } finally {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      parsedApp = parseSteamBinaryVdfSlice(sliceBuf, 0, sliceLen, indexed.strings);
    }

    const root = parsedApp?.appinfo || parsedApp;
    const launchMap = root?.config?.launch;
    if (!launchMap || typeof launchMap !== 'object') {
      setBoundedMapEntry(
        steamResolvedLaunchSpecCache,
        specCacheKey,
        { installPath: resolvedInstallPath, platform, spec: null },
        MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES
      );
      return null;
    }

    const isInsideBottle = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(
      resolvedInstallPath || ''
    );
    const wantWindows = platform === 'win32' || isInsideBottle;

    const candidates = [];
    /** @type {Array<{ score: number, entry: any, rawExe: string, isProtocolUri: boolean, isUbisoft: boolean }>} */
    const protocolLaunchCandidates = [];
    for (const [, entry] of Object.entries(launchMap)) {
      if (!entry || typeof entry !== 'object' || !entry.executable) continue;
      const rawExe = String(entry.executable).trim();
      if (!rawExe) continue;

      const oslist = String(entry.config?.oslist || '').toLowerCase();
      const entryType = String(entry.type || 'default').toLowerCase();
      const isProtocolUri = /^(?:link2ea|origin2|origin|uplay):\/\//i.test(rawExe);
      const isChainedShimExe =
        !isProtocolUri && /(?:^|[\\/])(?:link2ea|ealauncher|upc)\.exe$/i.test(rawExe);

      if (isProtocolUri || isChainedShimExe) {
        if (oslist) {
          if (wantWindows && !oslist.includes('windows')) {
            continue;
          }
          if (
            !wantWindows &&
            !oslist.includes('macos') &&
            !oslist.includes('osx') &&
            !oslist.includes('windows')
          ) {
            continue;
          }
        }
        let protoScore = isProtocolUri ? 120 : 90;
        if (entryType === 'default' || entryType === 'none' || !entry.type) {
          protoScore += 50;
        }
        if (entry.config?.ownsdlc) {
          protoScore -= 15;
        }
        const isUbisoft =
          /^uplay:\/\//i.test(rawExe) || /(?:^|[\\/])upc\.exe$/i.test(rawExe);
        protocolLaunchCandidates.push({
          score: protoScore,
          entry,
          rawExe,
          isProtocolUri,
          isUbisoft,
        });
        continue;
      }

      const relExe = rawExe.replace(/^[\\/]+/, '').replace(/\\/g, path.sep);
      if (!relExe || !resolvedInstallPath) continue;

      let candidateExe = path.join(resolvedInstallPath, relExe);
      if (!fs.existsSync(candidateExe)) continue;

      if (platform === 'darwin' && !isInsideBottle && candidateExe.toLowerCase().endsWith('.app')) {
        candidateExe = resolveMacAppBundleBinary(candidateExe);
      }

      if (isExcludedExecutable(candidateExe)) continue;

      let score = 0;

      if (wantWindows) {
        if (oslist.includes('windows')) {
          score += 100;
        } else if (!oslist && candidateExe.toLowerCase().endsWith('.exe')) {
          score += 60;
        } else {
          continue;
        }
      } else {
        if (oslist.includes('macos') || oslist.includes('osx')) {
          score += 100;
        } else if (oslist.includes('windows')) {
          score += 40;
        } else if (oslist.includes('linux')) {
          continue;
        }
        if (
          !candidateExe.toLowerCase().endsWith('.exe') &&
          !candidateExe.toLowerCase().endsWith('.sh') &&
          inspectMacMachOHeader(candidateExe).is32BitOnly
        ) {
          score -= 120;
        }
      }

      if (entryType === 'default' || entryType === 'none' || !entry.type) {
        score += 50;
      } else if (entryType === 'option1' || entryType === 'option2') {
        score -= 20;
      } else if (/config|editor|tool|sdk|server|vr|benchmark/i.test(entryType)) {
        score -= 80;
      }

      if (entry.config?.ownsdlc) {
        score -= 15;
      }

      if (String(entry.config?.osarch || '') === '64') {
        score += 15;
      }

      candidates.push({
        score,
        entry,
        executablePath: candidateExe,
      });
    }

    if (protocolLaunchCandidates.length > 0) {
      protocolLaunchCandidates.sort((a, b) => b.score - a.score);
      candidates.sort((a, b) => b.score - a.score);
      const bestProto = protocolLaunchCandidates[0];
      // Only let a native macOS `.app` binary override a Windows-only protocol entry if Steam ships a native Mac build
      const hasHigherNativeMacCandidate =
        platform === 'darwin' &&
        !wantWindows &&
        candidates.length > 0 &&
        !candidates[0].executablePath.toLowerCase().endsWith('.exe') &&
        candidates[0].score > bestProto.score;

      if (!hasHigherNativeMacCandidate) {
        let concreteExe = candidates[0]?.executablePath || null;
        if (!concreteExe && resolvedInstallPath && fs.existsSync(resolvedInstallPath)) {
          const discovered = findPrimaryExecutable(resolvedInstallPath, {
            platform: wantWindows ? 'win32' : platform,
          });
          if (discovered?.executablePath) {
            concreteExe = discovered.executablePath;
          }
        }
        const launchArguments =
          bestProto.entry.arguments && String(bestProto.entry.arguments).trim()
            ? String(bestProto.entry.arguments).trim()
            : undefined;
        const workingDirectory =
          bestProto.entry.workingdir && resolvedInstallPath
            ? path.join(
                resolvedInstallPath,
                String(bestProto.entry.workingdir)
                  .replace(/^[\\/]+/, '')
                  .replace(/\\/g, path.sep)
              )
            : resolvedInstallPath || undefined;
        const isWindowsBinaryOnMac =
          platform === 'darwin' &&
          Boolean(
            isInsideBottle ||
              wantWindows ||
              !concreteExe ||
              concreteExe.toLowerCase().endsWith('.exe')
          );
        const resolvedProtoSpec = {
          executablePath: concreteExe || null,
          args: launchArguments,
          launchArguments,
          workingDir: workingDirectory,
          workingDirectory,
          isWindowsBinaryOnMac,
          requiresStorefrontProtocolLaunch: true,
          ...(bestProto.isProtocolUri ? { protocolUri: bestProto.rawExe } : {}),
          chainedLauncherHandoff: /** @type {'ubisoft' | 'ea'} */ (
            bestProto.isUbisoft ? 'ubisoft' : 'ea'
          ),
          chainedHandoffTopology: /** @type {'storefront_depot_uri'} */ ('storefront_depot_uri'),
        };
        setBoundedMapEntry(
          steamResolvedLaunchSpecCache,
          specCacheKey,
          { installPath: resolvedInstallPath, platform, spec: resolvedProtoSpec },
          MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES
        );
        return { ...resolvedProtoSpec };
      }
    }

    if (candidates.length === 0) {
      setBoundedMapEntry(
        steamResolvedLaunchSpecCache,
        specCacheKey,
        { installPath: resolvedInstallPath, platform, spec: null },
        MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES
      );
      return null;
    }
    candidates.sort((a, b) => b.score - a.score);

    const best = candidates[0];
    const launchArguments =
      best.entry.arguments && String(best.entry.arguments).trim()
        ? String(best.entry.arguments).trim()
        : undefined;
    const workingDirectory =
      best.entry.workingdir && resolvedInstallPath
        ? path.join(
            resolvedInstallPath,
            String(best.entry.workingdir)
              .replace(/^[\\/]+/, '')
              .replace(/\\/g, path.sep)
          )
        : undefined;
    const isWindowsBinaryOnMac =
      platform === 'darwin' &&
      (isInsideBottle || best.executablePath.toLowerCase().endsWith('.exe'));

    const resolvedSpec = {
      executablePath: best.executablePath,
      launchArguments,
      workingDirectory,
      isWindowsBinaryOnMac,
    };
    setBoundedMapEntry(
      steamResolvedLaunchSpecCache,
      specCacheKey,
      { installPath: resolvedInstallPath, platform, spec: resolvedSpec },
      MAX_STEAM_LAUNCH_SPEC_CACHE_ENTRIES
    );
    return { ...resolvedSpec };
  } catch {
    return null;
  }
}

function discoverSteamLocations(/** @type {any} */ options = {}) {
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();
  const customRoots = Array.isArray(options.customRoots) ? options.customRoots : [];
  const isIsolatedTest = Boolean(
    options.homedir || (options.customRoots && options.customRoots.length > 0)
  );

  const candidateSteamRoots = [
    path.join(homedir, 'Library/Application Support/Steam'),
    path.join(homedir, '.local/share/Steam'),
    path.join(homedir, '.steam/steam'),
    ...customRoots,
  ];

  const bottleContainers = [
    path.join(homedir, 'Library/Application Support/CrossOver/Bottles'),
    path.join(homedir, 'Library/Application Support/CrossOver Preview/Bottles'),
    path.join(homedir, 'Library/Application Support/CrossOver Preview arm64/Bottles'),
    path.join(homedir, 'Games/OneLauncher/Bottles'),
  ];

  for (const bottlesDir of bottleContainers) {
    if (!fs.existsSync(bottlesDir)) continue;
    try {
      const entries = fs.readdirSync(bottlesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        candidateSteamRoots.push(
          path.join(bottlesDir, entry.name, 'drive_c/Program Files (x86)/Steam'),
          path.join(bottlesDir, entry.name, 'drive_c/Program Files/Steam')
        );
      }
    } catch {}
  }

  if (!isIsolatedTest) {
    candidateSteamRoots.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam');
    if (platform === 'win32') {
      const regSteam = windowsRegistryDiscovery.discoverWindowsSteamRegistryPaths(options);
      const regSteamRoot = regSteam.steamRoot || regSteam.steamPath;
      if (regSteamRoot) {
        candidateSteamRoots.unshift(regSteamRoot);
      }
    }
  }

  const steamRoots = new Set();
  const steamappsDirs = new Set();

  const addSteamRootCandidate = (/** @type {any} */ dir) => {
    const resolved = toLocalFsPath(dir, customRoots);
    if (resolved && fs.existsSync(resolved)) {
      try {
        if (fs.statSync(resolved).isDirectory()) {
          steamRoots.add(resolved);
        }
      } catch {}
    }
  };

  const addSteamappsCandidate = (/** @type {any} */ dir) => {
    const resolved = toLocalFsPath(dir, customRoots);
    if (resolved && fs.existsSync(resolved)) {
      try {
        if (fs.statSync(resolved).isDirectory()) {
          steamappsDirs.add(resolved);
          addSteamRootCandidate(path.dirname(resolved));
        }
      } catch {}
    }
  };

  const inspectSteamRootForVdf = (/** @type {any} */ rootDir) => {
    const localRoot = toLocalFsPath(rootDir, customRoots);
    if (!localRoot || !fs.existsSync(localRoot)) return;

    addSteamRootCandidate(localRoot);

    if (path.basename(localRoot).toLowerCase() === 'steamapps') {
      addSteamappsCandidate(localRoot);
    }
    addSteamappsCandidate(path.join(localRoot, 'steamapps'));
    addSteamappsCandidate(path.join(localRoot, 'Steam', 'steamapps'));

    try {
      const rootFiles = fs.readdirSync(localRoot);
      if (rootFiles.some((f) => /^appmanifest_\d+\.acf$/i.test(f))) {
        addSteamappsCandidate(localRoot);
      }
    } catch {}

    const driveCMatch = localRoot.match(/^(.*?[\\/]drive_c)(?:[\\/]|$)/i);
    const bottleDriveCDir = driveCMatch ? driveCMatch[1] : null;
    const vdfCustomRoots = bottleDriveCDir ? [bottleDriveCDir, ...customRoots] : customRoots;

    const vdfLocations = [
      path.join(localRoot, 'steamapps', 'libraryfolders.vdf'),
      path.join(localRoot, 'libraryfolders.vdf'),
      path.join(localRoot, 'config', 'libraryfolders.vdf'),
      path.join(localRoot, 'Steam', 'steamapps', 'libraryfolders.vdf'),
    ];

    for (const vdfPath of vdfLocations) {
      if (fs.existsSync(vdfPath)) {
        try {
          const vdfContent = fs.readFileSync(vdfPath, 'utf8');
          const libPaths = parseSteamLibraryFoldersVdf(vdfContent);
          for (const lp of libPaths) {
            const candidateLibPaths = [toLocalFsPath(lp, vdfCustomRoots)];
            if (bottleDriveCDir && /^[Cc]:[\\/]/.test(lp)) {
              const driveStripped = lp
                .replace(/\\\\/g, '/')
                .replace(/\\/g, '/')
                .replace(/^[Cc]:\/+/, '');
              candidateLibPaths.push(path.join(bottleDriveCDir, driveStripped));
            } else if (/^[Zz]:[\\/]/.test(lp)) {
              const zPosix =
                '/' +
                lp
                  .replace(/\\\\/g, '/')
                  .replace(/\\/g, '/')
                  .replace(/^[Zz]:\/+/, '');
              candidateLibPaths.push(zPosix);
            }
            for (const resolvedLp of candidateLibPaths) {
              if (resolvedLp) {
                addSteamRootCandidate(resolvedLp);
                addSteamappsCandidate(path.join(resolvedLp, 'steamapps'));
                addSteamappsCandidate(resolvedLp);
              }
            }
          }
        } catch {}
      }
    }
  };

  for (const root of candidateSteamRoots) {
    inspectSteamRootForVdf(root);
  }

  return {
    steamRoots: Array.from(steamRoots),
    steamappsDirs: Array.from(steamappsDirs),
  };
}

function normalizeComparableTitle(value) {
  if (!value || typeof value !== 'string') return '';
  /** @type {Record<string, string>} */
  const romanMap = {
    xx: '20',
    xix: '19',
    xviii: '18',
    xvii: '17',
    xvi: '16',
    xv: '15',
    xiv: '14',
    xiii: '13',
    xii: '12',
    xi: '11',
    x: '10',
    ix: '9',
    viii: '8',
    vii: '7',
    vi: '6',
    v: '5',
    iv: '4',
    iii: '3',
    ii: '2',
  };
  return value
    .toLowerCase()
    .replace(
      /\b(xx|xix|xviii|xvii|xvi|xv|xiv|xiii|xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii)\b/g,
      (m) => romanMap[m] || m
    )
    .replace(/[^a-z0-9]/g, '');
}


function removeSteamAppFromLibraryFoldersVdf(steamappsDir, appId) {
  const cleanAppId = String(appId || '')
    .replace(/^steam[-_]/i, '')
    .trim();
  if (!cleanAppId || !steamappsDir || typeof steamappsDir !== 'string') return false;

  const escapedAppId = cleanAppId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lineRegex = new RegExp(
    `^[\\t ]*"${escapedAppId}"[\\t ]+"[^"]*"[\\t ]*\\r?\\n?`,
    'gm'
  );

  const candidates = new Set([
    path.join(steamappsDir, 'libraryfolders.vdf'),
    path.resolve(steamappsDir, '..', 'config', 'libraryfolders.vdf'),
    path.resolve(steamappsDir, '..', 'steamapps', 'libraryfolders.vdf'),
  ]);

  let updatedAny = false;
  for (const vdfPath of candidates) {
    if (!fs.existsSync(vdfPath)) continue;
    try {
      const original = fs.readFileSync(vdfPath, 'utf8');
      const updated = original.replace(lineRegex, '');
      if (updated !== original) {
        atomicWriteFileSync(vdfPath, updated);
        updatedAny = true;
      }
    } catch {}
  }
  return updatedAny;
}

function cleanupCrossOverSteamShortcuts(appId, title, bottleDirs = [], /** @type {any} */ options = {}) {
  const cleanAppId = String(appId || '')
    .replace(/^steam[-_]/i, '')
    .trim();
  const normTitle = normalizeComparableTitle(title);
  const homedir = options.homedir || os.homedir();

  const allBottleDirs = new Set();
  if (bottleDirs && typeof bottleDirs[Symbol.iterator] === 'function') {
    for (const dir of bottleDirs) {
      if (!dir || typeof dir !== 'string') continue;
      const root = extractBottleRootFromPath(dir) || dir;
      if (fs.existsSync(root)) {
        allBottleDirs.add(path.resolve(root));
      }
    }
  }

  try {
    const layers = detectCompatibilityLayers(options);
    for (const layer of layers) {
      if (layer && layer.bottlesDir && fs.existsSync(layer.bottlesDir)) {
        for (const sub of listBottleSubdirectories(layer.bottlesDir)) {
          const fullBottle = path.join(layer.bottlesDir, sub);
          if (fs.existsSync(fullBottle)) {
            allBottleDirs.add(path.resolve(fullBottle));
          }
        }
      }
    }
  } catch {}

  const matchedShortcutNames = new Set();
  if (normTitle && !/^(steam|gog|epic|custom)?\d+$/i.test(String(title || '').trim())) {
    matchedShortcutNames.add(normTitle);
  }

  const deletedWindowsUrlPaths = new Set();
  const deletedCxmenuUrlPaths = new Set();
  /** @type {string[]} */
  const removedPaths = [];
  const escapedAppId = cleanAppId ? cleanAppId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  const appIdUrlRegex = escapedAppId
    ? new RegExp(`steam://rungameid/${escapedAppId}(?:\\b|$)`, 'i')
    : null;

  const scanWinUrlDir = (/** @type {string} */ dirPath, depth = 0) => {
    if (depth > 4 || !dirPath || !fs.existsSync(dirPath)) return;
    /** @type {fs.Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        scanWinUrlDir(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.url')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const baseName = path.basename(entry.name, path.extname(entry.name));
          const normBase = normalizeComparableTitle(baseName);
          const matchesId = Boolean(appIdUrlRegex && appIdUrlRegex.test(content));
          const matchesTitle = Boolean(
            normTitle && normBase === normTitle && /steam:\/\/rungameid\//i.test(content)
          );
          if (matchesId || matchesTitle) {
            if (normBase) matchedShortcutNames.add(normBase);
            deletedWindowsUrlPaths.add(path.resolve(fullPath));
            fs.rmSync(fullPath, { force: true });
            removedPaths.push(fullPath);
          }
        } catch {}
      }
    }
  };

  for (const bottleDir of allBottleDirs) {
    const driveCDir = path.join(bottleDir, 'drive_c');
    const usersDir = resolveDriveCPathCaseInsensitive(driveCDir, ['users']);
    if (!fs.existsSync(usersDir)) continue;
    /** @type {fs.Dirent[]} */
    let userEntries = [];
    try {
      userEntries = fs.readdirSync(usersDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const u of userEntries) {
      if (!u.isDirectory() || u.name.startsWith('.')) continue;
      const userRoot = path.join(usersDir, u.name);
      scanWinUrlDir(path.join(userRoot, 'Desktop'), 0);
      scanWinUrlDir(
        path.join(userRoot, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
        0
      );
    }
  }

  for (const bottleDir of allBottleDirs) {
    const cxmenuDir = path.join(bottleDir, 'desktopdata', 'cxmenu');
    if (!fs.existsSync(cxmenuDir)) continue;

    const scanCxmenuDir = (/** @type {string} */ dirPath, depth = 0) => {
      if (depth > 5 || !dirPath || !fs.existsSync(dirPath)) return;
      /** @type {fs.Dirent[]} */
      let entries = [];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          scanCxmenuDir(fullPath, depth + 1);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.url')) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const rawBase = path.basename(entry.name, path.extname(entry.name));
            let decodedBase = rawBase.replace(/\+/g, ' ');
            try {
              decodedBase = decodeURIComponent(decodedBase);
            } catch {}

            let targetWinUrlPath = null;
            const startMatch = content.match(/--start\s+"([a-zA-Z]:[\\/][^"]+\.url)"/i);
            if (startMatch) {
              const relDriveC = startMatch[1]
                .replace(/^[a-zA-Z]:[\\/]+/, '')
                .replace(/[\\/]+/g, path.sep);
              targetWinUrlPath = path.resolve(bottleDir, 'drive_c', relDriveC);
            }

            const matchesAppId = Boolean(appIdUrlRegex && appIdUrlRegex.test(content));
            const matchesDeletedOrMissingWinUrl = Boolean(
              targetWinUrlPath &&
                (deletedWindowsUrlPaths.has(targetWinUrlPath) || !fs.existsSync(targetWinUrlPath))
            );
            const normDecoded = normalizeComparableTitle(decodedBase);
            const normRaw = normalizeComparableTitle(rawBase);
            const matchesShortcutName = Boolean(
              (normDecoded && matchedShortcutNames.has(normDecoded)) ||
                (normRaw && matchedShortcutNames.has(normRaw))
            );

            if (matchesAppId || matchesDeletedOrMissingWinUrl || matchesShortcutName) {
              deletedCxmenuUrlPaths.add(path.resolve(fullPath));
              if (normDecoded) matchedShortcutNames.add(normDecoded);
              fs.rmSync(fullPath, { force: true });
              removedPaths.push(fullPath);
            }
          } catch {}
        }
      }
    };

    scanCxmenuDir(cxmenuDir, 0);
  }

  const cxAppsRoot = path.join(homedir, 'Applications', 'CrossOver');
  const userAppsRoot = path.join(homedir, 'Applications');

  const scanAppsDir = (/** @type {string} */ dirPath, depth = 0) => {
    if (depth > 3 || !dirPath || !fs.existsSync(dirPath)) return;
    /** @type {fs.Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (!entry.isDirectory()) continue;

      if (entry.name.toLowerCase().endsWith('.app')) {
        if (/^(steam|crossover)\.app$/i.test(entry.name)) continue;
        const plistPath = path.join(fullPath, 'Contents', 'Info.plist');
        if (!fs.existsSync(plistPath)) continue;

        try {
          const plistContent = fs.readFileSync(plistPath, 'utf8');
          const isCxHelper =
            /(com\.codeweavers\.CrossOverHelper|<key>CrossOverHelperCommand<\/key>|<key>CXHelperAppBottleName<\/key>|<key>CXBottle<\/key>)/i.test(
              plistContent
            );
          if (!isCxHelper) continue;

          const cmdMatch = plistContent.match(
            /<key>CrossOverHelperCommand<\/key>\s*<string>([\s\S]*?)<\/string>/i
          );
          let helperCmdPath = '';
          if (cmdMatch) {
            helperCmdPath = cmdMatch[1]
              .trim()
              .replace(/&quot;/g, '"')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&apos;/g, "'")
              .replace(/^"+|"+$/g, '')
              .trim();
          }

          const origMenuMatch = plistContent.match(
            /<key>CXOriginalMenuName<\/key>\s*<string>([\s\S]*?)<\/string>/i
          );
          const origMenuName = origMenuMatch ? origMenuMatch[1].trim() : '';
          const bundleNameMatch = plistContent.match(
            /<key>CFBundleName<\/key>\s*<string>([\s\S]*?)<\/string>/i
          );
          const bundleName = bundleNameMatch ? bundleNameMatch[1].trim() : '';
          const appBaseName = path.basename(fullPath, '.app');

          const matchesDeletedOrMissingCxmenu = Boolean(
            helperCmdPath &&
              (deletedCxmenuUrlPaths.has(path.resolve(helperCmdPath)) ||
                (helperCmdPath.toLowerCase().endsWith('.url') && !fs.existsSync(helperCmdPath)))
          );
          const matchesAppIdInPlist = Boolean(appIdUrlRegex && appIdUrlRegex.test(plistContent));
          const normAppBase = normalizeComparableTitle(appBaseName);
          const normOrigMenu = normalizeComparableTitle(origMenuName);
          const normBundleName = normalizeComparableTitle(bundleName);
          const matchesName = Boolean(
            (normAppBase && matchedShortcutNames.has(normAppBase)) ||
              (normOrigMenu && matchedShortcutNames.has(normOrigMenu)) ||
              (normBundleName && matchedShortcutNames.has(normBundleName))
          );

          if (matchesDeletedOrMissingCxmenu || matchesAppIdInPlist || matchesName) {
            fs.rmSync(fullPath, { recursive: true, force: true });
            removedPaths.push(fullPath);

            const parentDir = path.dirname(fullPath);
            if (
              fs.existsSync(cxAppsRoot) &&
              path.resolve(parentDir) !== path.resolve(cxAppsRoot) &&
              path.resolve(parentDir).startsWith(path.resolve(cxAppsRoot) + path.sep)
            ) {
              try {
                const remaining = fs
                  .readdirSync(parentDir)
                  .filter((f) => f !== '.DS_Store');
                if (remaining.length === 0) {
                  fs.rmSync(parentDir, { recursive: true, force: true });
                }
              } catch {}
            }
          }
        } catch {}
      } else {
        scanAppsDir(fullPath, depth + 1);
      }
    }
  };

  if (fs.existsSync(cxAppsRoot)) {
    scanAppsDir(cxAppsRoot, 0);
  }
  if (fs.existsSync(userAppsRoot)) {
    scanAppsDir(userAppsRoot, 0);
  }

  return { removedPaths };
}

module.exports = {
  getIndexedSteamAppInfoVdf,
  getIndexedSteamAppInfoVdfAsync,
  parseSteamBinaryVdfSlice,
  readSteamAppInfoParsedEntry,
  findEnclosingSteamAppInfoVdf,
  resolveSteamAppInfoLaunchSpec,
  discoverSteamLocations,
  normalizeComparableTitle,
  removeSteamAppFromLibraryFoldersVdf,
  cleanupCrossOverSteamShortcuts,
};
