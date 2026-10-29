// @ts-check
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Leaf directory names (lowercased) that represent OS roots, Known Folders, Wine prefix
 * roots, or shared multi-game storefront/library container directories and must NEVER be
 * passed to `fs.rmSync(..., { recursive: true })` as an entire game installation root.
 */
const BLOCKED_CONTAINER_LEAF_NAMES = new Set([
  // OS & system roots
  'windows',
  'system32',
  'syswow64',
  'program files',
  'program files (x86)',
  'program files (arm)',
  'programdata',
  'users',
  'perflogs',
  'recovery',
  '$recycle.bin',
  'system volume information',
  'boot',
  'efi',
  'system',
  'library',
  'applications',
  'utilities',
  'volumes',
  'var',
  'tmp',
  'temp',
  'private',
  'opt',
  'usr',
  'bin',
  'sbin',
  'etc',
  'dev',
  'cores',
  'home',
  'proc',
  'sys',
  // User profile & Windows/macOS Known Folders
  'desktop',
  'documents',
  'my documents',
  'downloads',
  'pictures',
  'my pictures',
  'music',
  'my music',
  'videos',
  'my videos',
  'movies',
  'saved games',
  'onedrive',
  'appdata',
  'local',
  'locallow',
  'roaming',
  'application support',
  'preferences',
  'caches',
  'public',
  'favorites',
  // Shared multi-game library & storefront roots
  'games',
  'my games',
  'onelauncher',
  'onelauncher games',
  'steam',
  'steamlibrary',
  'steamapps',
  'common',
  'downloading',
  'shadercache',
  'compatdata',
  'workshop',
  'userdata',
  'epic',
  'epic games',
  'epicgameslauncher',
  'manifests',
  'gog',
  'gog.com',
  'gog galaxy',
  'gog games',
  'galaxy',
  'heroic',
  'legendary',
  'xboxgames',
  'windowsapps',
  'modifiablewindowsapps',
  'wpsystem',
  'gamingroot',
  '.gamingroot',
  'msixvc',
  'wudownloadcache',
  // Wine / CrossOver / GPTK prefix containers
  'bottles',
  'prefixes',
  'drive_c',
  'dosdevices',
]);

const PROTECTED_MAC_APP_BUNDLES_RE =
  /^(?:steam|gog galaxy|epic games launcher|heroic|crossover|whisky|mythic|lutris|one launcher|safari|mail|messages|music|tv|photos|preview|finder|terminal|system settings|system preferences|activity monitor|app store|xcode|automator|console|disk utility|keychain access|migration assistant|screenshot|script editor|time machine)\.app$/i;

const MULTI_GAME_CONTAINER_SENTINEL_FILES = [
  '.GamingRoot',
  'libraryfolders.vdf',
  'cxbottle.conf',
  'Steam.exe',
  'steam.dll',
];

/**
 * Strip `file://` URI scheme if present.
 * @param {string} rawPath
 * @returns {string}
 */
function stripFileProtocol(rawPath) {
  if (/^file:\/\//i.test(rawPath)) {
    try {
      const decoded = decodeURIComponent(rawPath.replace(/^file:\/+/i, '/'));
      if (/^\/[a-zA-Z]:[\\/]/.test(decoded)) {
        return decoded.slice(1);
      }
      return decoded;
    } catch {
      return rawPath;
    }
  }
  return rawPath;
}

/**
 * Strip Win32 extended-length and NT device path prefixes (`\\?\UNC\` -> `\\`, `\\?\`, `\\.\`, `\??\`,
 * plus forward-slash equivalents `//?/UNC/`, `//?/`, `//./`) BEFORE root/depth/protected-tree checks.
 *
 * @param {string} rawPath
 * @returns {string}
 */
function normalizeWin32DevicePrefix(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return '';
  let cleaned = stripFileProtocol(rawPath.trim());
  // Loop in case multiple redundant device prefixes were stacked
  for (let i = 0; i < 4; i += 1) {
    const uncMatch = cleaned.match(/^(?:\\\\\?\\|\\\\\.\\|\\\?\?\\|\/\/\?\/|\/\/\.\/)UNC[\\/](.+)$/i);
    if (uncMatch && uncMatch[1]) {
      cleaned = `\\\\${uncMatch[1]}`;
      continue;
    }
    const devMatch = cleaned.match(/^(?:\\\\\?\\|\\\\\.\\|\\\?\?\\|\/\/\?\/|\/\/\.\/)(.+)$/);
    if (devMatch && devMatch[1]) {
      cleaned = devMatch[1];
      continue;
    }
    break;
  }
  return cleaned.trim();
}

/**
 * Strict validator for Wine / CrossOver / Whisky / GPTK bottle slugs.
 * Rejects `.`, `..`, `/`, `\`, NUL bytes, leading/trailing dots-only names, and lengths outside 1..80.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
function isSafeBottleSlug(name) {
  if (typeof name !== 'string') return false;
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) return false;
  if (!/^[A-Za-z0-9._ -]{1,80}$/.test(name)) return false;
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || name.includes('..')) return false;
  return true;
}

/**
 * Strict validator for numeric storefront AppIDs / ProductIDs (`1..12` ASCII digits).
 *
 * @param {unknown} id
 * @returns {boolean}
 */
function isSafeNumericAppId(id) {
  if (typeof id === 'number') {
    if (!Number.isSafeInteger(id) || id < 0) return false;
    return /^\d{1,12}$/.test(String(id));
  }
  if (typeof id !== 'string') return false;
  return /^\d{1,12}$/.test(id);
}

/**
 * Cross-platform containment check without external circular dependencies.
 * @param {string} anchorRoot
 * @param {string} candidatePath
 * @param {boolean} isWinStyle
 * @returns {boolean}
 */
function isPathContainedInRoot(anchorRoot, candidatePath, isWinStyle) {
  if (!anchorRoot || !candidatePath) return false;
  if (anchorRoot.includes('\0') || candidatePath.includes('\0')) return false;
  if (isWinStyle || /^[a-zA-Z]:[\\/]/.test(anchorRoot) || anchorRoot.startsWith('\\\\')) {
    const normAnchor = path.win32.resolve(normalizeWin32DevicePrefix(anchorRoot)).toLowerCase();
    const normCand = path.win32.resolve(normalizeWin32DevicePrefix(candidatePath)).toLowerCase();
    const rel = path.win32.relative(normAnchor, normCand);
    return rel === '' || (!rel.startsWith('..') && !path.win32.isAbsolute(rel));
  }
  const normAnchor = path.posix.resolve(anchorRoot.replace(/\\/g, '/'));
  const normCand = path.posix.resolve(candidatePath.replace(/\\/g, '/'));
  const rel = path.posix.relative(normAnchor, normCand);
  return rel === '' || (!rel.startsWith('..') && !path.posix.isAbsolute(rel));
}

/**
 * Lexical + structural path check used on both the requested path and (when existing on disk)
 * its canonical `realpathSync` target.
 *
 * @param {string} candidatePath
 * @param {Record<string, any>} options
 * @param {string[]} protectedTrees
 * @param {boolean} hasManagedSentinel
 * @returns {{ safe: boolean, resolved: string, isWinStyle: boolean }}
 */
function evaluateLexicalPathSafety(candidatePath, options, protectedTrees, hasManagedSentinel) {
  const trimmed = normalizeWin32DevicePrefix(candidatePath);
  if (trimmed.length < 10 || trimmed.includes('\0')) {
    return { safe: false, resolved: '', isWinStyle: false };
  }
  // Reject raw Win32 Volume GUID paths (`Volume{guid}\...`)
  if (/^volume\{[0-9a-f-]+\}/i.test(trimmed)) {
    return { safe: false, resolved: '', isWinStyle: true };
  }

  const isWinStyle =
    /^[a-zA-Z]:(?:[\\/]|$)/.test(trimmed) ||
    /^\\\\[^\\]+\\[^\\]+/.test(trimmed) ||
    (options.platform === 'win32' && !trimmed.startsWith('/'));

  // Require an explicit absolute input path (prevent relative path resolution surprises)
  if (isWinStyle) {
    if (!/^[a-zA-Z]:[\\/]/.test(trimmed) && !/^\\\\[^\\]+\\[^\\]+/.test(trimmed)) {
      return { safe: false, resolved: '', isWinStyle };
    }
  } else if (!trimmed.startsWith('/')) {
    return { safe: false, resolved: '', isWinStyle };
  }

  const resolved = isWinStyle
    ? path.win32.resolve(trimmed.replace(/\//g, '\\'))
    : path.posix.resolve(trimmed.replace(/\\/g, '/'));
  const normForward = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normForward || normForward === '.' || normForward === '..') {
    return { safe: false, resolved, isWinStyle };
  }

  const lowerNorm = normForward.toLowerCase();

  // 1. Block drive roots (C:, D:), UNC share roots (//server/share), and POSIX root
  if (/^[a-z]:$/i.test(normForward)) return { safe: false, resolved, isWinStyle };
  if (/^\/\/[^/]+\/[^/]+$/i.test(normForward)) return { safe: false, resolved, isWinStyle };

  const rawSegments = normForward.split('/').filter(Boolean);
  // Strip Windows trailing dots/spaces per segment so `C:\Users\Alice.` or `C:\XboxGames.` cannot bypass leaf checks
  const segments = rawSegments.map((seg) => (isWinStyle ? seg.replace(/[. ]+$/, '') : seg));
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) {
    return { safe: false, resolved, isWinStyle };
  }

  const leafRaw = segments[segments.length - 1];
  const leafLower = leafRaw.toLowerCase();

  // Never delete protected launcher/system .app bundles at any depth
  if (PROTECTED_MAC_APP_BUNDLES_RE.test(leafRaw)) {
    return { safe: false, resolved, isWinStyle };
  }

  // Enforce exact `.app` / leaf bundle match when caller supplies an expected bundle/leaf/path
  const expectedInstallPath =
    typeof options.expectedInstallPath === 'string' && options.expectedInstallPath.trim()
      ? normalizeWin32DevicePrefix(options.expectedInstallPath)
      : '';
  if (expectedInstallPath) {
    const resolvedExpected = (
      isWinStyle
        ? path.win32.resolve(expectedInstallPath.replace(/\//g, '\\'))
        : path.posix.resolve(expectedInstallPath.replace(/\\/g, '/'))
    )
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (lowerNorm !== resolvedExpected) {
      return { safe: false, resolved, isWinStyle };
    }
  }

  const expectedBundleOrLeaf =
    options.expectedAppBundleName || options.expectedBundleName || options.expectedLeafName || '';
  if (typeof expectedBundleOrLeaf === 'string' && expectedBundleOrLeaf.trim()) {
    const cleanExpectedLeaf = path
      .basename(expectedBundleOrLeaf.trim().replace(/[\\/]+$/, ''))
      .toLowerCase();
    if (cleanExpectedLeaf && leafLower !== cleanExpectedLeaf) {
      return { safe: false, resolved, isWinStyle };
    }
  }

  // Block `/System/...` on macOS unconditionally
  if (!isWinStyle && segments[0].toLowerCase() === 'system') {
    return { safe: false, resolved, isWinStyle };
  }
  // Block `/Applications/Utilities/...`
  if (
    !isWinStyle &&
    segments.length >= 2 &&
    segments[0].toLowerCase() === 'applications' &&
    segments[1].toLowerCase() === 'utilities'
  ) {
    return { safe: false, resolved, isWinStyle };
  }

  const isTopLevelMacAppBundle =
    !isWinStyle &&
    segments.length === 2 &&
    segments[0].toLowerCase() === 'applications' &&
    leafLower.endsWith('.app') &&
    !PROTECTED_MAC_APP_BUNDLES_RE.test(leafRaw);

  // Require at least 3 path segments (e.g., ['C:', 'Games', 'GameTitle']) unless top-level `/Applications/<Game>.app`
  if (segments.length < 3 && !isTopLevelMacAppBundle) {
    return { safe: false, resolved, isWinStyle };
  }

  // UNC share paths (`//server/share/...`) need at least 4 segments (`//server/share/Games/GameTitle`) unless sentinel-verified
  if (normForward.startsWith('//') && segments.length < 4 && !hasManagedSentinel) {
    return { safe: false, resolved, isWinStyle };
  }

  // Block `/Volumes`, `/Volumes/<VolumeName>`, and `/Users/<username>` directly
  if (!isWinStyle && segments[0].toLowerCase() === 'volumes' && segments.length < 3) {
    return { safe: false, resolved, isWinStyle };
  }
  if (!isWinStyle && segments[0].toLowerCase() === 'users' && segments.length <= 2) {
    return { safe: false, resolved, isWinStyle };
  }
  // Block `/Users/<username>/<KnownFolder>` when depth is 3 on macOS/Linux (handled by BLOCKED_CONTAINER_LEAF_NAMES below, plus `/Users/<username>` at length 2 above)

  // Block `C:/Users/<username>` directly (3 segments on Windows: ['c:', 'users', '<name>'])
  if (
    segments.length === 3 &&
    /^[a-z]:$/i.test(segments[0]) &&
    segments[1].toLowerCase() === 'users'
  ) {
    return { safe: false, resolved, isWinStyle };
  }

  const parentLower = segments.length >= 2 ? segments[segments.length - 2].toLowerCase() : '';

  if (BLOCKED_CONTAINER_LEAF_NAMES.has(leafLower) || leafLower.startsWith('.')) {
    return { safe: false, resolved, isWinStyle };
  }

  // Block 3-segment & nested Steam library roots (`D:\Games\Steam`, `D:\SteamLibrary`, `/Volumes/SSD/SteamLibrary`, `.../steamapps/shadercache/...`),
  // while scoping container checks after `drive_c` when inside a Wine/CrossOver bottle so a bottle named
  // `Bottles/Steam` never false-blocks `Bottles/Steam/drive_c/GOG Games/<Game>`.
  const lowerSegments = segments.map((s) => s.toLowerCase());
  const bottlesIdx = lowerSegments.findIndex((s) => s === 'bottles' || s === 'prefixes');
  const driveCIdx = lowerSegments.lastIndexOf('drive_c');

  if (bottlesIdx >= 0 && !hasManagedSentinel) {
    if (driveCIdx !== bottlesIdx + 2) {
      return { safe: false, resolved, isWinStyle };
    }
  }

  if (driveCIdx >= 0) {
    const afterDriveC = lowerSegments.slice(driveCIdx + 1);
    if (afterDriveC[0] === 'windows') {
      return { safe: false, resolved, isWinStyle };
    }
    if (afterDriveC.length < 2 && !hasManagedSentinel) {
      return { safe: false, resolved, isWinStyle };
    }
  }

  const containerCheckSegments =
    driveCIdx >= 0 ? lowerSegments.slice(driveCIdx + 1) : lowerSegments;
  const hasSteamContainerSegment = containerCheckSegments.some(
    (s) => s === 'steam' || s === 'steamlibrary' || s === 'steamapps'
  );
  if (hasSteamContainerSegment && !hasManagedSentinel) {
    const steamAppsIdx = containerCheckSegments.lastIndexOf('steamapps');
    const isUnderSteamAppsCommonGame =
      steamAppsIdx >= 0 &&
      containerCheckSegments[steamAppsIdx + 1] === 'common' &&
      containerCheckSegments.length >= steamAppsIdx + 3 &&
      !BLOCKED_CONTAINER_LEAF_NAMES.has(containerCheckSegments[steamAppsIdx + 2]);
    if (!isUnderSteamAppsCommonGame) {
      return { safe: false, resolved, isWinStyle };
    }
  }

  // Block top-level shared Xbox / Microsoft Store containers (`C:\XboxGames`, `D:\XboxGames`, `D:\Program Files\ModifiableWindowsApps`, `.../WindowsApps`)
  const windowsAppsIdx = lowerSegments.findIndex(
    (s) => s === 'windowsapps' || s === 'wpsystem'
  );
  if (windowsAppsIdx >= 0 && !hasManagedSentinel) {
    return { safe: false, resolved, isWinStyle };
  }

  // 2. Never delete an entire Wine/CrossOver bottle root (`.../Bottles/<BottleName>` or `.../prefixes/<Name>`)
  if (parentLower === 'bottles' || parentLower === 'prefixes') {
    return { safe: false, resolved, isWinStyle };
  }
  // Block `.../drive_c/users/<username>` inside a Wine bottle
  if (
    segments.length >= 3 &&
    segments[segments.length - 2].toLowerCase() === 'users' &&
    segments[segments.length - 3].toLowerCase() === 'drive_c'
  ) {
    return { safe: false, resolved, isWinStyle };
  }

  // 3. Block exact or ancestor matches of homedir, tmpdir, and userDataDir (case-insensitive)
  for (const prot of protectedTrees) {
    if (lowerNorm === prot || prot.startsWith(`${lowerNorm}/`)) {
      return { safe: false, resolved, isWinStyle };
    }
  }

  return { safe: true, resolved, isWinStyle };
}

/**
 * Scan a directory tree (bounded, without following symlinks) to verify that no nested symlink
 * or NTFS junction/reparse-point resolves outside `realInstallRoot`.
 *
 * @param {string} realInstallRoot
 * @param {any} fsImpl
 * @param {boolean} isWinStyle
 * @returns {boolean} true if safe (no escaping symlinks/junctions), false if unsafe
 */
function verifyNoEscapingSymlinksInTree(realInstallRoot, fsImpl, isWinStyle) {
  const MAX_SCANNED_ENTRIES = 2000;
  let scanned = 0;
  /** @type {string[]} */
  const stack = [realInstallRoot];

  while (stack.length > 0 && scanned < MAX_SCANNED_ENTRIES) {
    const currentDir = /** @type {string} */ (stack.pop());
    /** @type {any[]} */
    let entries = [];
    try {
      entries = fsImpl.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      scanned += 1;
      if (scanned > MAX_SCANNED_ENTRIES) break;

      const entryName = typeof entry === 'string' ? entry : entry?.name;
      if (!entryName || entryName === '.' || entryName === '..') continue;
      const entryPath = isWinStyle
        ? path.win32.join(currentDir, entryName)
        : path.posix.join(currentDir, entryName);

      let isSymlink = false;
      let isDirectory = false;
      if (entry && typeof entry.isSymbolicLink === 'function') {
        isSymlink = Boolean(entry.isSymbolicLink());
        isDirectory = !isSymlink && Boolean(entry.isDirectory?.());
      } else {
        try {
          const st = fsImpl.lstatSync(entryPath);
          isSymlink = Boolean(st?.isSymbolicLink?.());
          isDirectory = !isSymlink && Boolean(st?.isDirectory?.());
        } catch {
          continue;
        }
      }

      if (isSymlink) {
        let linkTargetResolved = '';
        try {
          if (typeof fsImpl.realpathSync === 'function') {
            linkTargetResolved = fsImpl.realpathSync(entryPath);
          }
        } catch {
          // Dangling link: fall back to lexical resolution of readlinkSync target
        }
        if (!linkTargetResolved) {
          try {
            if (typeof fsImpl.readlinkSync === 'function') {
              const rawLink = String(fsImpl.readlinkSync(entryPath) || '');
              if (!rawLink) return false;
              linkTargetResolved = isWinStyle
                ? path.win32.resolve(currentDir, normalizeWin32DevicePrefix(rawLink))
                : path.posix.resolve(currentDir, rawLink);
            } else {
              return false;
            }
          } catch {
            return false;
          }
        }
        if (!isPathContainedInRoot(realInstallRoot, linkTargetResolved, isWinStyle)) {
          return false;
        }
      } else if (isDirectory) {
        stack.push(entryPath);
      }
    }
  }

  return true;
}

/**
 * Positive-containment safety validator for game uninstallation directory removal.
 * Enforces Win32 device-prefix stripping (`\\?\`, `\\.\`, `\??\`, `\\?\UNC\`), case-insensitive
 * path comparisons across Windows (`C:\`, `D:\`, UNC) and macOS (`/`, `/Volumes/<Drive>`, Wine/CrossOver
 * bottles), `.GamingRoot` / Steam / Xbox shared container guards, and `lstatSync` + `realpathSync`
 * symlink/junction containment verification.
 *
 * @param {unknown} targetPath
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function isSafeToDeleteInstallPath(targetPath, options = {}) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const fsImpl = options.fsImpl || fs;

  const rawHome = String(options.homedir || os.homedir() || '');
  const rawTmp = String(options.tmpdir || os.tmpdir() || '');
  const rawUserData = typeof options.userDataDir === 'string' ? options.userDataDir : '';

  /** @type {string[]} */
  const protectedTrees = [];
  const addProtectedCandidate = (/** @type {string} */ candidate) => {
    if (!candidate) return;
    const stripped = normalizeWin32DevicePrefix(candidate);
    if (!stripped) return;
    const normCandidate = (
      /^[a-zA-Z]:/.test(stripped) || stripped.startsWith('\\\\')
        ? path.win32.resolve(stripped.replace(/\//g, '\\'))
        : path.posix.resolve(stripped.replace(/\\/g, '/'))
    )
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (normCandidate && !protectedTrees.includes(normCandidate)) {
      protectedTrees.push(normCandidate);
    }
  };

  for (const candidate of [rawHome, rawTmp, rawUserData]) {
    addProtectedCandidate(candidate);
    try {
      if (candidate && typeof fsImpl.existsSync === 'function' && fsImpl.existsSync(candidate)) {
        const realCand = fsImpl.realpathSync?.(candidate);
        if (realCand) addProtectedCandidate(realCand);
      }
    } catch {
      // Ignore unresolvable virtual test paths
    }
  }

  // Probe whether `.one_launcher_managed` sentinel exists on target (only when target is a real non-symlink directory)
  const preliminaryClean = normalizeWin32DevicePrefix(targetPath);
  const prelimIsWin =
    /^[a-zA-Z]:(?:[\\/]|$)/.test(preliminaryClean) ||
    /^\\\\[^\\]+\\[^\\]+/.test(preliminaryClean) ||
    (options.platform === 'win32' && !preliminaryClean.startsWith('/'));
  const prelimResolved =
    preliminaryClean && !preliminaryClean.includes('\0')
      ? prelimIsWin
        ? path.win32.resolve(preliminaryClean.replace(/\//g, '\\'))
        : path.posix.resolve(preliminaryClean.replace(/\\/g, '/'))
      : '';

  const canProbeHostFs = Boolean(options.fsImpl) || !prelimIsWin || process.platform === 'win32';
  let hasManagedSentinel = Boolean(options.hasManagedSentinel === true);

  if (canProbeHostFs && prelimResolved) {
    try {
      if (typeof fsImpl.lstatSync === 'function') {
        const st = fsImpl.lstatSync(prelimResolved);
        // Reject immediately if targetPath itself is a symlink or NTFS junction/reparse point!
        if (st && typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) {
          return false;
        }
        if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
          const sentinelPath = prelimIsWin
            ? path.win32.join(prelimResolved, '.one_launcher_managed')
            : path.posix.join(prelimResolved, '.one_launcher_managed');
          if (typeof fsImpl.lstatSync === 'function') {
            try {
              const sentStat = fsImpl.lstatSync(sentinelPath);
              if (sentStat && !sentStat.isSymbolicLink?.() && sentStat.isFile?.()) {
                hasManagedSentinel = true;
              }
            } catch {
              // No sentinel file present
            }
          }
        }
      }
    } catch {
      // Target does not exist on host filesystem (e.g. cross-OS lexical test); continue lexical validation
    }
  }

  const lexical = evaluateLexicalPathSafety(
    targetPath,
    options,
    protectedTrees,
    hasManagedSentinel
  );
  if (!lexical.safe) return false;

  const { resolved, isWinStyle } = lexical;
  const allowedRoot =
    options.libraryRoot || options.allowedRoot || options.bottleRoot || '';

  if (allowedRoot && typeof allowedRoot === 'string') {
    if (!isPathContainedInRoot(allowedRoot, resolved, isWinStyle)) {
      return false;
    }
  }

  if (canProbeHostFs) {
    try {
      const joinImpl = isWinStyle ? path.win32.join : path.posix.join;
      // Block directories containing multi-game library/drive/bottle root sentinels (`.GamingRoot`, `libraryfolders.vdf`, `cxbottle.conf`, `drive_c/windows`, `steamapps`)
      for (const sentinel of MULTI_GAME_CONTAINER_SENTINEL_FILES) {
        if (fsImpl.existsSync?.(joinImpl(resolved, sentinel))) {
          return false;
        }
      }
      if (
        fsImpl.existsSync?.(joinImpl(resolved, 'drive_c', 'windows')) ||
        fsImpl.existsSync?.(joinImpl(resolved, 'steamapps'))
      ) {
        return false;
      }

      // If `resolved` exists on disk, verify `lstatSync`, `realpathSync` parent/library containment, and nested symlinks
      let targetExists = false;
      try {
        const targetStat = fsImpl.lstatSync?.(resolved);
        if (targetStat) {
          if (targetStat.isSymbolicLink?.()) {
            return false;
          }
          targetExists = true;
        }
      } catch {
        targetExists = false;
      }

      if (targetExists && typeof fsImpl.realpathSync === 'function') {
        const realTarget = fsImpl.realpathSync(resolved);
        if (!realTarget) return false;

        // Re-verify lexical/protected rules on canonical `realTarget` so symlinked parent dirs cannot mask `/Users/Alice` or `C:\XboxGames`
        if (realTarget !== resolved) {
          const realCheck = evaluateLexicalPathSafety(
            realTarget,
            { ...options, expectedInstallPath: undefined },
            protectedTrees,
            hasManagedSentinel
          );
          if (!realCheck.safe) {
            return false;
          }
        }

        // Verify parent-directory realpath containment
        const parentDir = isWinStyle ? path.win32.dirname(resolved) : path.posix.dirname(resolved);
        if (parentDir && parentDir !== resolved) {
          const realParent = fsImpl.realpathSync(parentDir);
          if (!isPathContainedInRoot(realParent, realTarget, isWinStyle)) {
            return false;
          }
        }

        // Verify explicit libraryRoot / bottleRoot realpath containment when provided
        if (allowedRoot && typeof allowedRoot === 'string') {
          const realAllowedRoot = fsImpl.existsSync?.(allowedRoot)
            ? fsImpl.realpathSync(allowedRoot)
            : allowedRoot;
          if (!isPathContainedInRoot(realAllowedRoot, realTarget, isWinStyle)) {
            return false;
          }
        }

        // Verify no symlink or NTFS junction inside the install directory points outside `realTarget`
        if (!verifyNoEscapingSymlinksInTree(realTarget, fsImpl, isWinStyle)) {
          return false;
        }
      } else if (!targetExists && typeof fsImpl.realpathSync === 'function') {
        // Even if leaf doesn't exist yet, if an existing ancestor is a symlink escaping `allowedRoot` or into a protected tree, catch it
        const parentDir = isWinStyle ? path.win32.dirname(resolved) : path.posix.dirname(resolved);
        if (parentDir && fsImpl.existsSync?.(parentDir)) {
          const parentLstat = fsImpl.lstatSync?.(parentDir);
          if (parentLstat?.isSymbolicLink?.()) {
            return false;
          }
          const realParent = fsImpl.realpathSync(parentDir);
          const leafName = isWinStyle ? path.win32.basename(resolved) : path.posix.basename(resolved);
          const projectedRealTarget = isWinStyle
            ? path.win32.join(realParent, leafName)
            : path.posix.join(realParent, leafName);
          const projectedCheck = evaluateLexicalPathSafety(
            projectedRealTarget,
            { ...options, expectedInstallPath: undefined },
            protectedTrees,
            hasManagedSentinel
          );
          if (!projectedCheck.safe) {
            return false;
          }
          if (allowedRoot && typeof allowedRoot === 'string') {
            const realAllowedRoot = fsImpl.existsSync?.(allowedRoot)
              ? fsImpl.realpathSync(allowedRoot)
              : allowedRoot;
            if (!isPathContainedInRoot(realAllowedRoot, projectedRealTarget, isWinStyle)) {
              return false;
            }
          }
        }
      }
    } catch {
      // Ignore fs probe errors on virtual paths
    }
  }

  return true;
}

module.exports = {
  isSafeToDeleteInstallPath,
  normalizeWin32DevicePrefix,
  isSafeBottleSlug,
  isSafeNumericAppId,
  BLOCKED_CONTAINER_LEAF_NAMES,
};
