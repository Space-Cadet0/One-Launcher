// @ts-check
'use strict';

const path = require('node:path');
const os = require('node:os');

/**
 * Host environment, path/URI/locale/quarantine helpers, CLI binary discovery,
 * uninstall safety delegation, and native file/folder dialogs.
 *
 * CRITICAL TEST CONTRACT: Receives `fs`, `childProcess`, and `platform` from the
 * `engineStateRegistry.cjs` facade at facade load-time so `Module._load` tests that
 * evict ONLY `engineStateRegistry.cjs` & `launcherEngine.cjs` work identically.
 */

const ALLOWED_EXTERNAL_URI_SCHEME_RE =
  /^(?:https:\/\/|steam:\/\/|goggalaxy:\/\/|com\.epicgames\.launcher:\/\/|heroic:\/\/|msxbox:(?:\/\/|\S)|ms-windows-store:(?:\/\/|\S)|xbox:(?:\/\/|\S)|ms-xbl-[a-z0-9-]+:(?:\/\/|\S))/i;

const MAX_EXTERNAL_URI_LENGTH = 4096;
const MAX_ENSURED_DIR_CACHE_ENTRIES = 64;
const CLI_BINARY_CACHE_TTL_MS = 60 * 1000;

/** @type {Record<string, string>} */
const STEAM_LANGUAGE_BY_CODE = {
  ar: 'arabic',
  bg: 'bulgarian',
  cs: 'czech',
  da: 'danish',
  de: 'german',
  el: 'greek',
  en: 'english',
  es: 'spanish',
  'es-419': 'latam',
  fi: 'finnish',
  fr: 'french',
  hu: 'hungarian',
  id: 'indonesian',
  it: 'italian',
  ja: 'japanese',
  ko: 'koreana',
  nl: 'dutch',
  no: 'norwegian',
  nb: 'norwegian',
  nn: 'norwegian',
  pl: 'polish',
  pt: 'portuguese',
  'pt-br': 'brazilian',
  ro: 'romanian',
  ru: 'russian',
  sv: 'swedish',
  th: 'thai',
  tr: 'turkish',
  uk: 'ukrainian',
  vi: 'vietnamese',
  'zh-cn': 'schinese',
  'zh-hans': 'schinese',
  'zh-sg': 'schinese',
  'zh-tw': 'tchinese',
  'zh-hant': 'tchinese',
  'zh-hk': 'tchinese',
};

/** @type {Record<string, string>} */
const DEFAULT_REGION_BY_LANG = {
  de: 'DE',
  en: 'US',
  es: 'ES',
  fr: 'FR',
  it: 'IT',
  ja: 'JP',
  ko: 'KR',
  nl: 'NL',
  pl: 'PL',
  pt: 'PT',
  ru: 'RU',
  sv: 'SE',
  tr: 'TR',
  uk: 'UA',
  zh: 'CN',
};

/**
 * @typedef {Object} HostEnvAndCliResolverDeps
 * @property {typeof import('node:fs')} fs
 * @property {typeof import('node:child_process')} childProcess
 * @property {NodeJS.Platform} platform
 * @property {string} launcherDir
 * @property {() => any} getElectron
 * @property {() => any} getMainWindow
 * @property {(targetPath: string) => string} toHostFilesystemPath
 * @property {any} uninstallSafety
 * @property {string[]} openedExternalUris
 * @property {Set<string>} quarantineClearedBinaries
 * @property {<T>(setObj: Set<T>, value: T, maxEntries?: number) => void} addBoundedSetEntry
 * @property {number} MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES
 */

/**
 * @param {HostEnvAndCliResolverDeps} deps
 */
function createHostEnvAndCliResolver(deps) {
  const {
    fs,
    childProcess,
    platform: loadTimePlatform,
    launcherDir,
    getElectron,
    getMainWindow,
    toHostFilesystemPath,
    uninstallSafety,
    openedExternalUris,
    quarantineClearedBinaries,
    addBoundedSetEntry,
    MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES,
  } = deps;

  const { execFile } = childProcess;

  /** @type {string | null} */
  let configuredUserDataDir = null;

  /** @type {Set<string>} */
  const ensuredDirCache = new Set();

  /** @type {Map<string, { resolvedPath: string | null, expiresAt: number }>} */
  const cliBinaryDiscoveryCache = new Map();

  function getActivePlatform() {
    return process.platform || loadTimePlatform;
  }

  /**
   * @param {string} dirPath
   */
  function ensureDirExistsCachedSync(dirPath) {
    if (!dirPath) return;
    if (ensuredDirCache.has(dirPath)) return;
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      if (ensuredDirCache.size >= MAX_ENSURED_DIR_CACHE_ENTRIES) {
        const oldest = ensuredDirCache.values().next().value;
        if (oldest !== undefined) ensuredDirCache.delete(oldest);
      }
      ensuredDirCache.add(dirPath);
    } catch {}
  }

  function clearHostEnvCaches() {
    ensuredDirCache.clear();
    cliBinaryDiscoveryCache.clear();
  }

  /**
   * @param {string | null} dirPath
   */
  function setUserDataDir(dirPath) {
    configuredUserDataDir = dirPath;
    ensuredDirCache.clear();
  }

  function getConfiguredUserDataDir() {
    return configuredUserDataDir;
  }

  /**
   * Resolve Electron userData directory with fallback for headless/test environments.
   *
   * @param {string} [customDir]
   * @returns {string}
   */
  function getUserDataDir(customDir) {
    if (customDir && typeof customDir === 'string') {
      const hostCustomDir = toHostFilesystemPath(customDir);
      ensureDirExistsCachedSync(hostCustomDir);
      return hostCustomDir;
    }
    if (configuredUserDataDir) {
      const hostConfiguredDir = toHostFilesystemPath(configuredUserDataDir);
      ensureDirExistsCachedSync(hostConfiguredDir);
      return hostConfiguredDir;
    }
    try {
      const electron = getElectron();
      if (electron && electron.app && typeof electron.app.getPath === 'function') {
        const p = electron.app.getPath('userData');
        if (p) {
          const hostPath = toHostFilesystemPath(p);
          ensureDirExistsCachedSync(hostPath);
          return hostPath;
        }
      }
    } catch {}

    const fallback = path.join(os.homedir(), '.one-launcher');
    ensureDirExistsCachedSync(fallback);
    return fallback;
  }

  /**
   * @param {any} [options]
   * @returns {boolean}
   */
  function isTestEnvironment(options = {}) {
    return Boolean(
      options?.homedir ||
        options?.userDataDir ||
        process.env.VITEST ||
        process.env.NODE_ENV === 'test'
    );
  }

  /**
   * @param {any} [options]
   * @returns {{ homedir: string, userDataDir: string }}
   */
  function resolveIsolatedHomedirAndUserData(options = {}) {
    const isVitest = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
    const defaultHome = isVitest
      ? path.join(os.tmpdir(), `one-launcher-test-home-${process.pid}`)
      : os.homedir();

    if (options?.homedir || options?.userDataDir || configuredUserDataDir) {
      const homedir = options.homedir || defaultHome;
      const fallbackUserData =
        options.userDataDir ||
        (options.homedir ? path.join(options.homedir, '.one-launcher') : undefined);
      const userDataDir = getUserDataDir(fallbackUserData);
      return { homedir, userDataDir };
    }
    if (isVitest) {
      const isolatedUserData = path.join(defaultHome, '.one-launcher');
      ensureDirExistsCachedSync(isolatedUserData);
      return { homedir: defaultHome, userDataDir: isolatedUserData };
    }
    return {
      homedir: os.homedir(),
      userDataDir: getUserDataDir(options?.userDataDir),
    };
  }

  /**
   * Normalize paths across macOS/POSIX and Windows (including escaped backslashes in manifests).
   * Avoids redundant `fs.existsSync` syscalls when a path requires no cross-OS translation.
   *
   * @param {string} rawPath
   * @param {string[]} [customRoots]
   * @returns {string}
   */
  function toLocalFsPath(rawPath, customRoots = []) {
    if (!rawPath || typeof rawPath !== 'string') return '';
    const trimmed = rawPath.trim();
    if (!trimmed) return '';

    const hasCustomRoots = Array.isArray(customRoots) && customRoots.length > 0;

    if (path.sep === '/') {
      // Fast-path: pure POSIX path with no Windows separators or drive letters needs zero syscalls.
      if (!trimmed.includes('\\') && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
        return trimmed;
      }

      try {
        if (fs.existsSync(trimmed)) return trimmed;
      } catch {}

      const posixCandidate = trimmed.replace(/\\\\/g, '/').replace(/\\/g, '/');
      try {
        if (fs.existsSync(posixCandidate)) return posixCandidate;
      } catch {}

      // Wine maps Z:/ directly to the host POSIX root filesystem (/)
      if (/^[Zz]:\//.test(posixCandidate)) {
        const zRootMapped = '/' + posixCandidate.replace(/^[Zz]:\/+/, '');
        try {
          if (fs.existsSync(zRootMapped)) return zRootMapped;
        } catch {}
        const zStripped = posixCandidate.replace(/^[Zz]:\/+/, '');
        if (hasCustomRoots) {
          for (const root of customRoots) {
            if (!root) continue;
            const candidateInRoot = path.join(root, zStripped);
            try {
              if (fs.existsSync(candidateInRoot)) return candidateInRoot;
            } catch {}
          }
        }
        return zRootMapped;
      }

      // If it starts with a drive letter like C:/... check if a customRoot maps to it
      if (hasCustomRoots) {
        const driveStripped = posixCandidate.replace(/^[A-Za-z]:\//, '');
        for (const root of customRoots) {
          if (!root) continue;
          const candidateInRoot = path.join(root, driveStripped);
          try {
            if (fs.existsSync(candidateInRoot)) return candidateInRoot;
          } catch {}
        }
      }
      return posixCandidate;
    }

    // Windows host (`path.sep === '\\'`)
    const hasEscapedSlashes = trimmed.includes('\\\\');
    const isWineZDrive = /^[Zz]:[\\/]/.test(trimmed);
    const hasDrivePrefix = /^[A-Za-z]:[\\/]/.test(trimmed);
    if (!hasEscapedSlashes && !isWineZDrive && !(hasCustomRoots && hasDrivePrefix)) {
      return trimmed;
    }

    try {
      if (fs.existsSync(trimmed)) return trimmed;
    } catch {}

    const unescapedWin = trimmed.replace(/\\\\/g, '\\');
    try {
      if (unescapedWin !== trimmed && fs.existsSync(unescapedWin)) return unescapedWin;
    } catch {}

    const posixNorm = unescapedWin.replace(/\\/g, '/');
    if (/^[Zz]:\//.test(posixNorm)) {
      const zStripped = posixNorm.replace(/^[Zz]:\/+/, '');
      if (hasCustomRoots) {
        for (const root of customRoots) {
          if (!root) continue;
          const candidateInRoot = path.join(root, zStripped);
          try {
            if (fs.existsSync(candidateInRoot)) return candidateInRoot;
          } catch {}
        }
      }
      const sysDrive = process.env.SystemDrive || 'C:';
      const sysDriveMapped = path.join(`${sysDrive}\\`, zStripped);
      try {
        if (fs.existsSync(sysDriveMapped)) return sysDriveMapped;
      } catch {}
    }

    if (/^[A-Za-z]:\//.test(posixNorm) && hasCustomRoots) {
      const driveStripped = posixNorm.replace(/^[A-Za-z]:\/+/, '');
      for (const root of customRoots) {
        if (!root) continue;
        const candidateInRoot = path.join(root, driveStripped);
        try {
          if (fs.existsSync(candidateInRoot)) return candidateInRoot;
        } catch {}
      }
    }
    return unescapedWin;
  }

  /**
   * When running Node child_process.spawn directly on Windows against a POSIX `#!/usr/bin/env node`
   * script (e.g., cross-OS automated test fixtures), invoke `process.execPath` directly.
   * Always closes the file descriptor even if `fs.readSync` throws.
   *
   * @param {string} cmd
   * @param {string[]} args
   * @returns {{ cmd: string, args: string[] }}
   */
  function resolveWindowsNodeShebangSpawn(cmd, args) {
    if (getActivePlatform() !== 'win32' || !cmd || /\.(exe|cmd|bat|com)$/i.test(cmd)) {
      return { cmd, args };
    }
    try {
      if (fs.existsSync(cmd) && fs.statSync(cmd).isFile()) {
        const fd = fs.openSync(cmd, 'r');
        let n = 0;
        const buf = Buffer.alloc(64);
        try {
          n = fs.readSync(fd, buf, 0, 64, 0);
        } finally {
          try {
            fs.closeSync(fd);
          } catch {}
        }
        const head = buf.subarray(0, n).toString('utf8');
        if (/^#!.*\bnode\b/i.test(head)) {
          return { cmd: process.execPath, args: [cmd, ...(Array.isArray(args) ? args : [])] };
        }
      }
    } catch {}
    return { cmd, args };
  }

  /**
   * Open an external URI via Electron shell (or record for headless tests).
   * Permits ONLY `https://` and allowlisted storefront deep-link protocols (blocks `http://`,
   * `file://`, `javascript:`, `data:`, `smb://`, `ms-msdt:`, control chars, oversized URIs),
   * and returns `false` if `electron.shell.openExternal` throws.
   *
   * @param {string} uri
   * @param {any} [options]
   * @returns {Promise<boolean>}
   */
  async function openExternalUri(uri, options = {}) {
    if (typeof uri !== 'string' || !uri.trim()) {
      return false;
    }
    const cleanUri = uri.trim();
    if (
      cleanUri.length > MAX_EXTERNAL_URI_LENGTH ||
      /[\x00-\x1f\x7f]/.test(cleanUri) ||
      !ALLOWED_EXTERNAL_URI_SCHEME_RE.test(cleanUri)
    ) {
      return false;
    }
    if (/^https:\/\//i.test(cleanUri)) {
      try {
        const parsed = new URL(cleanUri);
        if (parsed.protocol !== 'https:' || !parsed.hostname) {
          return false;
        }
      } catch {
        return false;
      }
    }

    while (openedExternalUris.length >= MAX_BOUNDED_URI_AND_QUARANTINE_ENTRIES) {
      openedExternalUris.shift();
    }
    openedExternalUris.push(cleanUri);

    if (typeof options.onOpenExternal === 'function') {
      await options.onOpenExternal(cleanUri);
      return true;
    }
    if (typeof options.openExternalFn === 'function') {
      await options.openExternalFn(cleanUri);
      return true;
    }
    try {
      const electron = getElectron();
      if (electron && electron.shell && typeof electron.shell.openExternal === 'function') {
        if (options.activate === false) {
          await electron.shell.openExternal(cleanUri, { activate: false });
        } else {
          await electron.shell.openExternal(cleanUri);
        }
        return true;
      }
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Dynamically derive storefront locale identifiers from OS / Electron / env locale.
   *
   * @param {any} [options]
   */
  function resolveHostLocaleInfo(options = {}) {
    let raw = '';
    if (typeof options?.locale === 'string' && options.locale.trim()) {
      raw = options.locale.trim();
    } else {
      try {
        const electron = getElectron();
        if (electron && electron.app && typeof electron.app.getLocale === 'function') {
          raw = String(electron.app.getLocale() || '').trim();
        }
      } catch {}
      if (!raw) {
        const envLoc =
          options?.env?.LC_ALL ||
          options?.env?.LC_MESSAGES ||
          options?.env?.LANG ||
          process.env.LC_ALL ||
          process.env.LC_MESSAGES ||
          process.env.LANG ||
          '';
        const cleanedEnv = String(envLoc).split('.')[0].split('@')[0].trim();
        if (cleanedEnv && !/^(c|posix)$/i.test(cleanedEnv)) {
          raw = cleanedEnv;
        }
      }
      if (!raw) {
        try {
          raw = Intl.DateTimeFormat().resolvedOptions().locale || '';
        } catch {}
      }
    }

    const normalized = (raw || 'en-US').replace(/_/g, '-').trim();
    const parts = normalized.split('-').filter(Boolean);
    const lang = (parts[0] || 'en').toLowerCase();
    let scriptOrRegion = parts[1] || '';
    let region = '';

    if (/^[a-zA-Z]{4}$/.test(scriptOrRegion)) {
      const script =
        scriptOrRegion.charAt(0).toUpperCase() + scriptOrRegion.slice(1).toLowerCase();
      scriptOrRegion = script;
      region = (parts[2] || '').toUpperCase();
    } else if (/^[a-zA-Z]{2}$|^\d{3}$/.test(scriptOrRegion)) {
      region = scriptOrRegion.toUpperCase();
      scriptOrRegion = '';
    }

    if (!region && Object.hasOwn(DEFAULT_REGION_BY_LANG, lang)) {
      region = DEFAULT_REGION_BY_LANG[lang];
    }

    const bcp47 = scriptOrRegion
      ? `${lang}-${scriptOrRegion}${region ? `-${region}` : ''}`
      : region
        ? `${lang}-${region}`
        : lang;
    const gogLocale = region ? `${lang}-${region}` : `${lang}-${lang.toUpperCase()}`;
    const lowerFull = bcp47.toLowerCase();
    const lowerLangRegion = region ? `${lang}-${region.toLowerCase()}` : lang;
    const steamLanguage =
      (Object.hasOwn(STEAM_LANGUAGE_BY_CODE, lowerFull) && STEAM_LANGUAGE_BY_CODE[lowerFull]) ||
      (Object.hasOwn(STEAM_LANGUAGE_BY_CODE, lowerLangRegion) &&
        STEAM_LANGUAGE_BY_CODE[lowerLangRegion]) ||
      (Object.hasOwn(STEAM_LANGUAGE_BY_CODE, lang) && STEAM_LANGUAGE_BY_CODE[lang]) ||
      'english';
    const epicLocale =
      lang === 'zh'
        ? lowerFull.includes('tw') || lowerFull.includes('hk') || lowerFull.includes('hant')
          ? 'zh-Hant'
          : 'zh-Hans'
        : lang === 'pt' && region === 'BR'
          ? 'pt-BR'
          : lang === 'es' && (region === 'MX' || region === '419')
            ? 'es-MX'
            : lang;

    return {
      bcp47,
      langCode: lang,
      gogLocale,
      steamLanguage,
      epicLocale,
    };
  }

  /**
   * Check whether the host currently has network connectivity.
   *
   * @param {Record<string, any>} [options]
   * @returns {boolean}
   */
  function isNetworkOnlineForLaunch(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    if (typeof opts.isOnline === 'boolean') {
      return opts.isOnline;
    }
    if (typeof opts.isOnlineFn === 'function') {
      try {
        return opts.isOnlineFn() !== false;
      } catch {
        return true;
      }
    }
    if (opts.offline === true) {
      return false;
    }
    try {
      const electronMod = getElectron();
      if (electronMod && electronMod.net && typeof electronMod.net.isOnline === 'function') {
        return electronMod.net.isOnline() !== false;
      }
    } catch {}
    return true;
  }

  /**
   * Awaited macOS quarantine removal helper with O(1) `xattr -p` pre-check and bounded tracking set.
   *
   * @param {string} targetPath
   * @param {any} [options]
   * @returns {Promise<boolean>}
   */
  async function clearMacQuarantineAsync(targetPath, options = {}) {
    const targetPlatform = options.platform || getActivePlatform();
    if (targetPlatform !== 'darwin' || !targetPath || typeof targetPath !== 'string') {
      return false;
    }
    const resolved = path.resolve(targetPath);
    if (quarantineClearedBinaries.has(resolved) && options.force !== true) {
      return true;
    }
    const execFileFn =
      typeof options.execFileFn === 'function'
        ? options.execFileFn
        : typeof options.execFileImpl === 'function'
          ? options.execFileImpl
          : execFile;

    /**
     * @param {string[]} xattrArgs
     * @param {number} timeoutMs
     * @returns {Promise<{ err: any, stdout: string, stderr: string }>}
     */
    const runXattr = (xattrArgs, timeoutMs) =>
      new Promise((resolve) => {
        try {
          execFileFn(
            '/usr/bin/xattr',
            xattrArgs,
            { timeout: timeoutMs },
            (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
              if (
                err &&
                execFileFn !== execFile &&
                (err.code === 'ENOENT' || /ENOENT/i.test(String(err.message || '')))
              ) {
                try {
                  execFileFn(
                    'xattr',
                    xattrArgs,
                    { timeout: timeoutMs },
                    (
                      /** @type {any} */ err2,
                      /** @type {any} */ stdout2,
                      /** @type {any} */ stderr2
                    ) => {
                      resolve({
                        err: err2 || null,
                        stdout: String(stdout2 || ''),
                        stderr: String(stderr2 || ''),
                      });
                    }
                  );
                  return;
                } catch {}
              }
              resolve({
                err: err || null,
                stdout: String(stdout || ''),
                stderr: String(stderr || ''),
              });
            }
          );
        } catch (syncErr) {
          resolve({ err: syncErr, stdout: '', stderr: '' });
        }
      });

    // O(1) quarantine check before running recursive `xattr -dr` across large game directories
    const probeRes = await runXattr(['-p', 'com.apple.quarantine', targetPath], 2000);
    if (probeRes.err) {
      const errText = `${probeRes.stderr} ${probeRes.err?.message || ''}`;
      const isMissingAttr =
        /No such xattr/i.test(errText) ||
        (probeRes.err?.code === 1 && !/ENOENT|EACCES|EPERM/i.test(errText));
      if (isMissingAttr) {
        addBoundedSetEntry(quarantineClearedBinaries, resolved);
        return true;
      }
    } else if (execFileFn === execFile && !probeRes.stdout.trim()) {
      addBoundedSetEntry(quarantineClearedBinaries, resolved);
      return true;
    }

    await runXattr(['-dr', 'com.apple.quarantine', targetPath], 10000);
    addBoundedSetEntry(quarantineClearedBinaries, resolved);
    return true;
  }

  /**
   * @param {string} filePath
   * @param {boolean} [isUserWritableFallback]
   * @returns {boolean}
   */
  function isTrustedHelperBinaryStats(filePath, isUserWritableFallback = false) {
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile()) return false;
      if (getActivePlatform() !== 'win32' && typeof process.getuid === 'function') {
        // Reject world-writable binaries everywhere; reject group/world-writable on user-writable fallbacks
        if ((st.mode & 0o002) !== 0) return false;
        if (isUserWritableFallback && (st.mode & 0o022) !== 0) return false;
        const currentUid = process.getuid();
        if (currentUid >= 0 && st.uid !== 0 && st.uid !== currentUid) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve helper CLIs (`legendary`, `gogdl`) preferring bundled and root/system-installed
   * paths BEFORE user-writable directories (including Heroic user-profile tools and `~/.local/bin`).
   *
   * @param {string} baseName
   * @param {any} [options]
   * @returns {string | null}
   */
  function findBundledOrSystemCliBinary(baseName, options = {}) {
    const activePlatform = getActivePlatform();
    const homedir = options.homedir || os.homedir();
    const canUseProductionCache =
      !options.homedir &&
      !options.execFileSyncFn &&
      !options.execFileFn &&
      !isTestEnvironment(options);
    const cacheKey = `${baseName}|${activePlatform}|${process.arch}`;

    if (canUseProductionCache) {
      const cached = cliBinaryDiscoveryCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        if (!cached.resolvedPath || fs.existsSync(cached.resolvedPath)) {
          return cached.resolvedPath;
        }
        cliBinaryDiscoveryCache.delete(cacheKey);
      }
    }

    const testCandidates = options.homedir
      ? [
          path.join(options.homedir, `Library/Application Support/heroic/tools/bin/${baseName}`),
          path.join(options.homedir, `.local/bin/${baseName}`),
          path.join(options.homedir, `bin/${baseName}`),
        ]
      : [];

    if (options.homedir && options.allowSystemBinariesInTest !== true) {
      return testCandidates.find((p) => fs.existsSync(p)) || null;
    }

    let found =
      testCandidates.find((p) => fs.existsSync(p) && isTrustedHelperBinaryStats(p, true)) || null;

    if (!found) {
      const binName = activePlatform === 'win32' ? `${baseName}.exe` : baseName;
      const electronRoot = path.resolve(launcherDir, '..');
      const unpackedElectronRoot = electronRoot.replace('app.asar', 'app.asar.unpacked');
      const unpackedLauncherDir = launcherDir.replace('app.asar', 'app.asar.unpacked');

      const trustedSystemCandidates = [
        path.join(unpackedElectronRoot, 'bin', process.arch, activePlatform, binName),
        path.join(electronRoot, 'bin', process.arch, activePlatform, binName),
        path.join(unpackedLauncherDir, 'bin', process.arch, activePlatform, binName),
        path.join(launcherDir, 'bin', process.arch, activePlatform, binName),
        `/usr/local/bin/${baseName}`,
        `/opt/homebrew/bin/${baseName}`,
        `/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/arm64/darwin/${baseName}`,
        `/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/x64/darwin/${baseName}`,
        `/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/darwin/arm64/${baseName}`,
        `/Applications/Heroic.app/Contents/Resources/app.asar.unpacked/build/bin/darwin/x64/${baseName}`,
        path.join(
          process.env.ProgramFiles || 'C:\\Program Files',
          `Heroic/resources/app.asar.unpacked/build/bin/x64/win32/${baseName}.exe`
        ),
      ];

      found =
        trustedSystemCandidates.find(
          (p) => fs.existsSync(p) && isTrustedHelperBinaryStats(p, false)
        ) || null;
    }

    if (!found) {
      // User-writable fallback paths strictly require owner-only write bits (`isUserWritableFallback: true`)
      const userWritableFallbacks = [
        path.join(homedir, `Library/Application Support/heroic/tools/bin/${baseName}`),
        path.join(
          process.env.LOCALAPPDATA || path.join(homedir, 'AppData/Local'),
          `Programs/heroic/resources/app.asar.unpacked/build/bin/x64/win32/${baseName}.exe`
        ),
        path.join(homedir, `.local/bin/${baseName}`),
      ];
      found =
        userWritableFallbacks.find(
          (p) => fs.existsSync(p) && isTrustedHelperBinaryStats(p, true)
        ) || null;
    }

    if (found && activePlatform !== 'win32') {
      try {
        const st = fs.statSync(found);
        if (st.isFile() && (st.mode & 0o111) === 0) {
          fs.chmodSync(found, 0o755);
        }
      } catch {}
      const resolvedFound = path.resolve(found);
      if (activePlatform === 'darwin' && !quarantineClearedBinaries.has(resolvedFound)) {
        addBoundedSetEntry(quarantineClearedBinaries, resolvedFound);
        try {
          if (typeof options.execFileSyncFn === 'function') {
            options.execFileSyncFn('xattr', ['-dr', 'com.apple.quarantine', found], {
              stdio: 'ignore',
              timeout: 1500,
            });
          } else if (typeof options.execFileFn === 'function') {
            options.execFileFn(
              'xattr',
              ['-dr', 'com.apple.quarantine', found],
              { timeout: 3000 },
              () => {}
            );
          } else if (isTestEnvironment(options)) {
            childProcess.execFileSync('xattr', ['-dr', 'com.apple.quarantine', found], {
              stdio: 'ignore',
              timeout: 1500,
            });
          } else {
            childProcess.execFile(
              '/usr/bin/xattr',
              ['-dr', 'com.apple.quarantine', found],
              { timeout: 3000 },
              () => {}
            );
          }
        } catch {}
      }
    }

    if (canUseProductionCache) {
      if (cliBinaryDiscoveryCache.size >= 32) {
        const oldestKey = cliBinaryDiscoveryCache.keys().next().value;
        if (oldestKey !== undefined) cliBinaryDiscoveryCache.delete(oldestKey);
      }
      cliBinaryDiscoveryCache.set(cacheKey, {
        resolvedPath: found,
        expiresAt: Date.now() + CLI_BINARY_CACHE_TTL_MS,
      });
    }

    return found;
  }

  /**
   * @param {any} [options]
   * @returns {string | null}
   */
  function findLegendaryBinary(options = {}) {
    if (typeof options?.legendaryBinaryPath === 'string' && options.legendaryBinaryPath.trim()) {
      return options.legendaryBinaryPath.trim();
    }
    return findBundledOrSystemCliBinary('legendary', options);
  }

  /**
   * @param {any} [options]
   * @returns {string | null}
   */
  function findGogdlBinary(options = {}) {
    if (typeof options?.gogdlBinaryPath === 'string' && options.gogdlBinaryPath.trim()) {
      return options.gogdlBinaryPath.trim();
    }
    return findBundledOrSystemCliBinary('gogdl', options);
  }

  /**
   * @param {string} targetPath
   * @param {any} [options]
   * @returns {boolean}
   */
  function isSafeToDeleteInstallPath(targetPath, options = {}) {
    if (!targetPath || typeof targetPath !== 'string') {
      return false;
    }
    const mappedPath = options.customRoots
      ? toLocalFsPath(targetPath, options.customRoots)
      : targetPath;
    return uninstallSafety.isSafeToDeleteInstallPath(mappedPath, options);
  }

  /**
   * @param {string} targetPath
   * @param {any} [options]
   * @returns {Promise<boolean>}
   */
  async function safeRemoveInstallDirectoryAsync(targetPath, options = {}) {
    if (!targetPath || typeof targetPath !== 'string') {
      return false;
    }
    const mappedPath = options.customRoots
      ? toLocalFsPath(targetPath, options.customRoots)
      : targetPath;
    return uninstallSafety.safeRemoveGameDirectoryAsync(mappedPath, options);
  }

  /**
   * @param {unknown} slug
   * @returns {boolean}
   */
  function safeIsBottleSlug(slug) {
    const fn = /** @type {any} */ (uninstallSafety).isSafeBottleSlug;
    if (typeof fn === 'function') {
      return Boolean(fn(slug));
    }
    if (typeof slug !== 'string') return false;
    const trimmed = slug.trim();
    if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.startsWith('-')) return false;
    return !/[\\/\x00]/.test(trimmed) && !trimmed.includes('..');
  }

  /**
   * @param {unknown} appId
   * @returns {boolean}
   */
  function safeIsNumericAppId(appId) {
    const fn = /** @type {any} */ (uninstallSafety).isSafeNumericAppId;
    if (typeof fn === 'function') {
      return Boolean(fn(appId));
    }
    const clean = String(appId ?? '').trim();
    return /^\d{1,20}$/.test(clean);
  }

  /**
   * @param {string} targetPath
   */
  async function browseLocalFiles(targetPath) {
    if (!targetPath || typeof targetPath !== 'string') {
      return { success: false, error: 'No target path provided.' };
    }
    const resolved = toLocalFsPath(targetPath);
    if (!fs.existsSync(resolved)) {
      return { success: false, error: `Path does not exist: ${targetPath}` };
    }

    try {
      const stat = fs.statSync(resolved);
      const electron = getElectron();
      if (electron && electron.shell) {
        if (stat.isFile() || resolved.endsWith('.app')) {
          electron.shell.showItemInFolder(resolved);
        } else {
          await electron.shell.openPath(resolved);
        }
      }
      return { success: true, path: resolved };
    } catch (/** @type {any} */ err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * @param {string} [defaultPath]
   */
  async function selectExecutableDialog(defaultPath) {
    try {
      const electron = getElectron();
      if (electron && electron.dialog && typeof electron.dialog.showOpenDialog === 'function') {
        const win = getMainWindow();
        const res = await electron.dialog.showOpenDialog(win || undefined, {
          title: 'Select Game Executable',
          defaultPath: defaultPath || os.homedir(),
          properties: ['openFile', 'treatPackageAsDirectory'],
        });
        if (!res.canceled && Array.isArray(res.filePaths) && res.filePaths.length > 0) {
          return res.filePaths[0];
        }
      }
    } catch {}
    return null;
  }

  /**
   * @param {string} [defaultPath]
   */
  async function selectFolderDialog(defaultPath) {
    try {
      const electron = getElectron();
      if (electron && electron.dialog && typeof electron.dialog.showOpenDialog === 'function') {
        const win = getMainWindow();
        const res = await electron.dialog.showOpenDialog(win || undefined, {
          title: 'Select Installation Folder',
          defaultPath: defaultPath || os.homedir(),
          properties: ['openDirectory', 'createDirectory'],
        });
        if (!res.canceled && Array.isArray(res.filePaths) && res.filePaths.length > 0) {
          return res.filePaths[0];
        }
      }
    } catch {}
    return null;
  }

  return {
    clearHostEnvCaches,
    setUserDataDir,
    getConfiguredUserDataDir,
    getUserDataDir,
    isTestEnvironment,
    resolveIsolatedHomedirAndUserData,
    toLocalFsPath,
    resolveWindowsNodeShebangSpawn,
    openExternalUri,
    resolveHostLocaleInfo,
    isNetworkOnlineForLaunch,
    clearMacQuarantineAsync,
    findBundledOrSystemCliBinary,
    findLegendaryBinary,
    findGogdlBinary,
    isSafeToDeleteInstallPath,
    safeRemoveInstallDirectoryAsync,
    safeIsBottleSlug,
    safeIsNumericAppId,
    browseLocalFiles,
    selectExecutableDialog,
    selectFolderDialog,
  };
}

module.exports = {
  ALLOWED_EXTERNAL_URI_SCHEME_RE,
  createHostEnvAndCliResolver,
};
