'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { diagLog } = require('../utils/diagnosticLogger.cjs');
const {
  copyRealDirBoundedSync,
  copyRealDirBoundedAsync,
} = require('./boundedCopyUtils.cjs');

/**
 * Single-pass Wine `.reg` string unescaper supporting `\\\\`, `\"`, `\xNN` (multi-byte UTF-8
 * with Windows-1252/Latin-1 fallback), `\uNNNN`, `\r`, `\n`, `\t`, `\0`, and octal `\NNN`
 * without double-unescaping literal backslashes.
 */
function unescapeWineRegString(rawVal) {
  if (!rawVal || typeof rawVal !== 'string') return '';
  return rawVal.replace(
    /\\(?:(\\|"|r|n|t|0)|u([0-9a-fA-F]{4})|(x[0-9a-fA-F]{2}(?:\\x[0-9a-fA-F]{2})*)|([0-7]{1,3}))/g,
    (_full, singleEsc, unicodeHex, hexSeq, octalDigits) => {
      if (singleEsc !== undefined) {
        if (singleEsc === '\\') return '\\';
        if (singleEsc === '"') return '"';
        if (singleEsc === 'r') return '\r';
        if (singleEsc === 'n') return '\n';
        if (singleEsc === 't') return '\t';
        if (singleEsc === '0') return '\0';
        return singleEsc;
      }
      if (unicodeHex !== undefined) {
        return String.fromCharCode(parseInt(unicodeHex, 16));
      }
      if (hexSeq !== undefined) {
        const bytePairs = hexSeq.match(/[0-9a-fA-F]{2}/g) || [];
        const buf = Buffer.from(bytePairs.map((b) => parseInt(b, 16)));
        const utf8Decoded = buf.toString('utf8');
        if (!utf8Decoded.includes('\uFFFD')) {
          return utf8Decoded;
        }
        return buf.toString('latin1');
      }
      if (octalDigits !== undefined) {
        return String.fromCharCode(parseInt(octalDigits, 8));
      }
      return _full;
    }
  );
}

/**
 * Resolve path segments under `<prefix>/drive_c` case-insensitively against actual on-disk
 * directories so Windows paths under `<drive_c>/users/<bottleUser>/Documents` resolve cleanly to
 * `<prefix>/drive_c/users/<bottleUser>/Documents` even on case-sensitive APFS volumes.
 */
function resolveDriveCPathCaseInsensitive(driveCRoot, relParts) {
  let currentPath = driveCRoot;
  let parentExistsOnDisk = false;
  try {
    parentExistsOnDisk = fs.existsSync(currentPath) && fs.statSync(currentPath).isDirectory();
  } catch {
    parentExistsOnDisk = false;
  }

  for (const rawSeg of relParts) {
    if (!rawSeg || rawSeg === '.') continue;
    if (rawSeg === '..') {
      currentPath = path.dirname(currentPath);
      try {
        parentExistsOnDisk = fs.existsSync(currentPath) && fs.statSync(currentPath).isDirectory();
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
    let matchedSegment = null;
    try {
      const entries = fs.readdirSync(currentPath);
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
        parentExistsOnDisk = fs.existsSync(currentPath) && fs.statSync(currentPath).isDirectory();
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
 * Parse `<winePrefix>/user.reg` `[Shell Folders]` and `[User Shell Folders]` and detect active
 * Wine user profile directories accurately across CrossOver, GPTK, and Wine prefixes.
 */
function readWinePrefixShellFolders(winePrefix) {
  if (!winePrefix || typeof winePrefix !== 'string') {
    return {
      winePrefix: '',
      wineUser: 'crossover',
      userProfile: '',
      documents: '',
      savedGames: '',
      appDataRoaming: '',
      appDataLocal: '',
      appDataLocalLow: '',
      rawFolders: {},
    };
  }

  const resolvedPrefix = path.resolve(winePrefix);
  const driveCDir = path.join(resolvedPrefix, 'drive_c');
  const usersDir = resolveDriveCPathCaseInsensitive(driveCDir, ['users']);
  let wineUser = 'crossover';
  let userEntriesOnDisk = [];

  try {
    if (fs.existsSync(usersDir)) {
      userEntriesOnDisk = fs
        .readdirSync(usersDir, { withFileTypes: true })
        .filter(
          (d) =>
            d.isDirectory() &&
            !d.name.startsWith('.') &&
            d.name.toLowerCase() !== 'public'
        )
        .map((d) => d.name);
      if (userEntriesOnDisk.length > 0) {
        let hostUser = '';
        try {
          hostUser = os.userInfo().username || '';
        } catch {
          hostUser = '';
        }
        const crossoverMatch = userEntriesOnDisk.find((u) => u.toLowerCase() === 'crossover');
        const hostMatch = hostUser
          ? userEntriesOnDisk.find((u) => u.toLowerCase() === hostUser.toLowerCase())
          : null;
        if (crossoverMatch) {
          wineUser = crossoverMatch;
        } else if (hostMatch) {
          wineUser = hostMatch;
        } else {
          wineUser = userEntriesOnDisk[0];
        }
      }
    }
  } catch (err) {
    diagLog.debug('wine.readUsersDir', err, { usersDir });
  }

  const shellFoldersRaw = {};
  const userShellFoldersRaw = {};
  const userRegPath = path.join(resolvedPrefix, 'user.reg');

  try {
    if (fs.existsSync(userRegPath)) {
      const content = fs.readFileSync(userRegPath, 'utf8');
      const lines = content.split(/\r?\n/);
      let currentSection = '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(';') || line.startsWith('#')) continue;
        if (line.startsWith('[')) {
          if (
            /^\[Software\\+Microsoft\\+Windows\\+CurrentVersion\\+Explorer\\+Shell Folders\]/i.test(
              line
            )
          ) {
            currentSection = 'shell';
          } else if (
            /^\[Software\\+Microsoft\\+Windows\\+CurrentVersion\\+Explorer\\+User Shell Folders\]/i.test(
              line
            )
          ) {
            currentSection = 'user_shell';
          } else {
            currentSection = '';
          }
          continue;
        }
        if (!currentSection) continue;
        const kvMatch = line.match(/^"((?:[^"\\]|\\.)+)"="((?:[^"\\]|\\.)*)"$/);
        if (kvMatch) {
          const key = unescapeWineRegString(kvMatch[1]);
          const val = unescapeWineRegString(kvMatch[2]);
          if (currentSection === 'shell') {
            shellFoldersRaw[key] = val;
          } else {
            userShellFoldersRaw[key] = val;
          }
        }
      }
    }
  } catch (regErr) {
    diagLog.warn('wine.readUserRegFailed', regErr, { userRegPath });
  }

  // Pre-scan literal C:\users\<regUser>\... entries in Shell Folders (and User Shell Folders)
  // BEFORE expanding %USERPROFILE% / %APPDATA% / %LOCALAPPDATA%.
  const detectRegUserFromValues = (valuesMap) => {
    for (const rawVal of Object.values(valuesMap)) {
      if (!rawVal || typeof rawVal !== 'string') continue;
      const m = rawVal.trim().match(/^[Cc]:[\\/]+users[\\/]+([^\\/]+)(?:[\\/]|$)/i);
      if (!m || !m[1]) continue;
      const candidateUser = m[1].trim();
      if (!candidateUser || candidateUser.toLowerCase() === 'public' || candidateUser.startsWith('%')) {
        continue;
      }
      const diskMatch = userEntriesOnDisk.find(
        (u) => u.toLowerCase() === candidateUser.toLowerCase()
      );
      if (diskMatch) {
        wineUser = diskMatch;
        return true;
      }
      if (userEntriesOnDisk.length === 0) {
        wineUser = candidateUser;
        return true;
      }
    }
    return false;
  };

  if (!detectRegUserFromValues(shellFoldersRaw)) {
    detectRegUserFromValues(userShellFoldersRaw);
  }

  const resolveDosDeviceRoot = (driveLetter, fallbackRoot) => {
    const dosDeviceLink = path.join(
      resolvedPrefix,
      'dosdevices',
      `${driveLetter.toLowerCase()}:`
    );
    try {
      if (fs.existsSync(dosDeviceLink)) {
        return fs.realpathSync(dosDeviceLink);
      }
    } catch (err) {
      diagLog.debug('wine.dosdevicesRealpath', err, { dosDeviceLink });
    }
    return fallbackRoot;
  };

  const mapWindowsPathToHost = (unescapedVal) => {
    if (!unescapedVal || typeof unescapedVal !== 'string') return '';
    const expanded = unescapedVal
      .trim()
      .replace(/%USERPROFILE%/gi, `C:\\users\\${wineUser}`)
      .replace(/%APPDATA%/gi, `C:\\users\\${wineUser}\\AppData\\Roaming`)
      .replace(/%LOCALAPPDATA%/gi, `C:\\users\\${wineUser}\\AppData\\Local`)
      .replace(/%PUBLIC%/gi, 'C:\\users\\Public');

    const cMatch = expanded.match(/^[Cc]:[\\/](.*)$/);
    if (cMatch) {
      const relParts = cMatch[1].split(/[\\/]+/).filter(Boolean);
      return resolveDriveCPathCaseInsensitive(driveCDir, relParts);
    }

    const zMatch = expanded.match(/^[Zz]:[\\/]?(.*)$/);
    if (zMatch) {
      const relParts = zMatch[1].split(/[\\/]+/).filter(Boolean);
      const zRoot = resolveDosDeviceRoot('z', '/');
      if (zRoot === '/') {
        return path.posix.normalize('/' + relParts.join('/'));
      }
      return path.normalize(path.join(zRoot, ...relParts));
    }

    const otherDriveMatch = expanded.match(/^([A-Za-z]):[\\/]?(.*)$/);
    if (otherDriveMatch) {
      const driveLetter = otherDriveMatch[1].toLowerCase();
      const relParts = otherDriveMatch[2].split(/[\\/]+/).filter(Boolean);
      const fallbackDriveRoot = path.join(resolvedPrefix, `drive_${driveLetter}`);
      const mappedRoot = resolveDosDeviceRoot(driveLetter, fallbackDriveRoot);
      return path.normalize(path.join(mappedRoot, ...relParts));
    }

    return path.normalize(expanded.replace(/[\\/]+/g, path.sep));
  };

  const mergedKeys = new Set([
    ...Object.keys(userShellFoldersRaw),
    ...Object.keys(shellFoldersRaw),
  ]);
  const rawFolders = {};
  for (const key of mergedKeys) {
    // Prefer User Shell Folders when explicitly redirected (e.g. %USERPROFILE% or Z:\...),
    // otherwise Shell Folders, falling back cleanly if either is empty.
    const chosenRaw = shellFoldersRaw[key] || userShellFoldersRaw[key];
    if (chosenRaw) {
      rawFolders[key] = mapWindowsPathToHost(chosenRaw);
    }
  }

  const effectiveUserProfile = resolveDriveCPathCaseInsensitive(driveCDir, ['users', wineUser]);
  const docsCandidate = resolveDriveCPathCaseInsensitive(driveCDir, [
    'users',
    wineUser,
    'Documents',
  ]);
  const myDocsCandidate = resolveDriveCPathCaseInsensitive(driveCDir, [
    'users',
    wineUser,
    'My Documents',
  ]);
  const fallbackDocs =
    !fs.existsSync(docsCandidate) && fs.existsSync(myDocsCandidate)
      ? myDocsCandidate
      : docsCandidate;

  return {
    winePrefix: resolvedPrefix,
    wineUser,
    userProfile: effectiveUserProfile,
    documents: rawFolders.Personal || fallbackDocs,
    savedGames:
      rawFolders['{4C5C32FF-BB9D-43B0-B5B4-2D72E54EAAA4}'] ||
      rawFolders['Saved Games'] ||
      resolveDriveCPathCaseInsensitive(driveCDir, ['users', wineUser, 'Saved Games']),
    appDataRoaming:
      rawFolders.AppData ||
      resolveDriveCPathCaseInsensitive(driveCDir, ['users', wineUser, 'AppData', 'Roaming']),
    appDataLocal:
      rawFolders['Local AppData'] ||
      resolveDriveCPathCaseInsensitive(driveCDir, ['users', wineUser, 'AppData', 'Local']),
    appDataLocalLow:
      rawFolders['{A520A1A4-1780-4FF6-BD18-167343C5AF16}'] ||
      rawFolders.LocalLow ||
      resolveDriveCPathCaseInsensitive(driveCDir, ['users', wineUser, 'AppData', 'LocalLow']),
    rawFolders,
  };
}

/**
 * Single source of truth to locate Windows `steam.exe` inside a Wine/CrossOver prefix.
 */
function resolveBottleSteamExe(winePrefix) {
  if (!winePrefix || typeof winePrefix !== 'string') return null;
  const driveCRoot = path.join(winePrefix, 'drive_c');
  const candidates = [
    path.join(driveCRoot, 'Program Files (x86)', 'Steam', 'steam.exe'),
    path.join(driveCRoot, 'Program Files', 'Steam', 'steam.exe'),
    resolveDriveCPathCaseInsensitive(driveCRoot, ['Program Files (x86)', 'Steam', 'steam.exe']),
    resolveDriveCPathCaseInsensitive(driveCRoot, ['Program Files', 'Steam', 'steam.exe']),
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      // Ignore inaccessible path
    }
  }
  return null;
}

const SANDBOX_TARGET_FOLDERS = [
  'Documents',
  'My Documents',
  'Saved Games',
  'Desktop',
  'Downloads',
  'Pictures',
  'Music',
  'Videos',
];

const BLOCKLISTED_SEED_DIRS = new Set([
  'antigravity',
  'one-launcher',
  'onelauncher',
  'node_modules',
  '.git',
  'caches',
  'cache',
  '.trash',
  'desktop',
  'downloads',
  'pictures',
  'music',
  'videos',
  'movies',
  'library',
  'applications',
  'public',
]);

function isSafeCandidateSubdirName(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith('.') || trimmed.includes('..')) return false;
  if (/[\\/]/.test(trimmed)) return false;
  if (BLOCKLISTED_SEED_DIRS.has(trimmed.toLowerCase())) return false;
  return true;
}

function parseSteamRemoteCacheText(vdfText, vdfDocSubdirs, vdfSavedGamesSubdirs) {
  if (!vdfText) return;
  for (const m of vdfText.matchAll(/%?WinMyDocuments%?[\\/]+([^"\\/\r\n]+)/gi)) {
    if (m[1] && m[1].trim()) vdfDocSubdirs.add(m[1].trim());
  }
  for (const m of vdfText.matchAll(/%?WinSavedGames%?[\\/]+([^"\\/\r\n]+)/gi)) {
    if (m[1] && m[1].trim()) vdfSavedGamesSubdirs.add(m[1].trim());
  }

  const lines = vdfText.split(/\r?\n/);
  let pendingKey = '';
  let currentEntryPath = '';
  let braceDepth = 0;
  let entryDepth = -1;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === '{') {
      braceDepth += 1;
      if (pendingKey && entryDepth === -1 && braceDepth >= 2) {
        currentEntryPath = pendingKey;
        entryDepth = braceDepth;
      }
      pendingKey = '';
      continue;
    }
    if (line === '}') {
      if (braceDepth === entryDepth) {
        currentEntryPath = '';
        entryDepth = -1;
      }
      braceDepth = Math.max(0, braceDepth - 1);
      pendingKey = '';
      continue;
    }
    const singleMatch = line.match(/^"([^"]+)"$/);
    if (singleMatch) {
      pendingKey = singleMatch[1];
      continue;
    }
    const kvMatch = line.match(/^"([^"]+)"\s+"([^"]*)"$/);
    if (kvMatch && currentEntryPath) {
      const k = kvMatch[1].toLowerCase();
      const v = kvMatch[2].trim();
      if (k === 'root') {
        const segs = currentEntryPath.split(/[\\/]+/).filter(Boolean);
        if (segs.length >= 2) {
          if (/^(WinMyDocuments|4)$/i.test(v)) {
            vdfDocSubdirs.add(segs[0]);
          } else if (/^(WinSavedGames|11)$/i.test(v)) {
            vdfSavedGamesSubdirs.add(segs[0]);
          }
        }
      }
    }
  }
}

/**
 * Replace external macOS host symlinks inside `<prefix>/drive_c/users/<user>/*` with real
 * prefix-local directories, seeding existing game saves safely.
 * Fast-paths in <0.2ms when zero external symlinks are present (avoiding `remotecache.vdf` walks).
 */
function sandboxWinePrefixUserFolders(winePrefix, options = {}) {
  if (!winePrefix || typeof winePrefix !== 'string' || !fs.existsSync(winePrefix)) {
    return { winePrefix: winePrefix || null, sandboxedFolders: [] };
  }
  const resolvedPrefix = path.resolve(winePrefix);
  const usersDir = resolveDriveCPathCaseInsensitive(path.join(resolvedPrefix, 'drive_c'), ['users']);
  if (!fs.existsSync(usersDir)) {
    return { winePrefix: resolvedPrefix, sandboxedFolders: [] };
  }

  let userEntries = [];
  try {
    userEntries = fs.readdirSync(usersDir, { withFileTypes: true });
  } catch (err) {
    diagLog.debug('wine.sandboxReaddirUsers', err, { usersDir });
    return { winePrefix: resolvedPrefix, sandboxedFolders: [] };
  }

  // Fast Pre-Check: collect external symlinks BEFORE scanning Steam remotecache.vdf trees!
  const externalSymlinks = [];
  let needsVdfSaveScan = false;

  for (const userEntry of userEntries) {
    if (!userEntry.isDirectory() || userEntry.name.startsWith('.')) continue;
    if (userEntry.name.toLowerCase() === 'public') continue;
    const userRoot = path.join(usersDir, userEntry.name);
    for (const folder of SANDBOX_TARGET_FOLDERS) {
      const entryPath = path.join(userRoot, folder);
      try {
        const st = fs.lstatSync(entryPath);
        if (!st.isSymbolicLink()) continue;
        const linkTarget = fs.readlinkSync(entryPath);
        const resolvedTarget = path.resolve(path.dirname(entryPath), linkTarget);
        const isInsidePrefix =
          resolvedTarget === resolvedPrefix ||
          resolvedTarget.startsWith(resolvedPrefix + path.sep);
        if (!isInsidePrefix) {
          externalSymlinks.push({
            userName: userEntry.name,
            folder,
            entryPath,
            resolvedTarget,
          });
          if (
            folder === 'Documents' ||
            folder === 'My Documents' ||
            folder === 'Saved Games'
          ) {
            needsVdfSaveScan = true;
          }
        }
      } catch {
        // Folder doesn't exist or isn't a symlink
      }
    }
  }

  if (externalSymlinks.length === 0) {
    return { winePrefix: resolvedPrefix, sandboxedFolders: [] };
  }

  const maxSeedBytes =
    typeof options.maxSaveSeedBytes === 'number' && options.maxSaveSeedBytes > 0
      ? options.maxSaveSeedBytes
      : 250 * 1024 * 1024;

  const vdfDocSubdirs = new Set();
  const vdfSavedGamesSubdirs = new Set();

  if (needsVdfSaveScan) {
    const steamUserdataRoots = [
      path.join(resolvedPrefix, 'drive_c', 'Program Files (x86)', 'Steam', 'userdata'),
      path.join(resolvedPrefix, 'drive_c', 'Program Files', 'Steam', 'userdata'),
    ];
    for (const userdataRoot of steamUserdataRoots) {
      if (!fs.existsSync(userdataRoot)) continue;
      let uidEntries = [];
      try {
        uidEntries = fs.readdirSync(userdataRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const uidEntry of uidEntries) {
        if (!uidEntry.isDirectory() || uidEntry.name.startsWith('.')) continue;
        const uidDir = path.join(userdataRoot, uidEntry.name);
        let appEntries = [];
        try {
          appEntries = fs.readdirSync(uidDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const appEntry of appEntries) {
          if (!appEntry.isDirectory() || appEntry.name.startsWith('.')) continue;
          const vdfPath = path.join(uidDir, appEntry.name, 'remotecache.vdf');
          if (!fs.existsSync(vdfPath)) continue;
          try {
            const vdfText = fs.readFileSync(vdfPath, 'utf8');
            parseSteamRemoteCacheText(vdfText, vdfDocSubdirs, vdfSavedGamesSubdirs);
          } catch (vdfErr) {
            diagLog.debug('wine.readRemotecacheSync', vdfErr, { vdfPath });
          }
        }
      }
    }
  }

  const sandboxedFolders = [];
  for (const item of externalSymlinks) {
    const { userName, folder, entryPath, resolvedTarget } = item;
    try {
      const candidateSubdirs = new Set();
      let targetExistsDir = false;
      try {
        targetExistsDir =
          fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isDirectory();
      } catch {
        targetExistsDir = false;
      }

      if (targetExistsDir) {
        if (folder === 'Documents' || folder === 'My Documents') {
          const myGamesPath = path.join(resolvedTarget, 'My Games');
          try {
            if (
              fs.existsSync(myGamesPath) &&
              !fs.lstatSync(myGamesPath).isSymbolicLink() &&
              fs.lstatSync(myGamesPath).isDirectory()
            ) {
              candidateSubdirs.add('My Games');
            }
          } catch {
            // Ignore unreadable My Games
          }
          for (const sub of vdfDocSubdirs) {
            if (isSafeCandidateSubdirName(sub) || sub === 'My Games') {
              candidateSubdirs.add(sub);
            }
          }
        } else if (folder === 'Saved Games') {
          for (const sub of vdfSavedGamesSubdirs) {
            if (isSafeCandidateSubdirName(sub)) {
              candidateSubdirs.add(sub);
            }
          }
          try {
            const hostSavedEntries = fs.readdirSync(resolvedTarget, { withFileTypes: true });
            for (const hEnt of hostSavedEntries) {
              if (hEnt.isSymbolicLink() || !hEnt.isDirectory()) continue;
              if (isSafeCandidateSubdirName(hEnt.name)) {
                candidateSubdirs.add(hEnt.name);
              }
            }
          } catch {
            // Ignore unreadable host Saved Games
          }
        }
      }

      fs.unlinkSync(entryPath);
      fs.mkdirSync(entryPath, { recursive: true });
      if (folder === 'Documents' || folder === 'My Documents') {
        fs.mkdirSync(path.join(entryPath, 'My Games'), { recursive: true });
      }

      const seededSubdirs = [];
      for (const subName of candidateSubdirs) {
        const srcSub = path.join(resolvedTarget, subName);
        const destSub = path.join(entryPath, subName);
        const copyRes = copyRealDirBoundedSync(srcSub, destSub, maxSeedBytes, {
          skipExisting: true,
        });
        if (copyRes.copied) {
          seededSubdirs.push(subName);
        }
      }

      sandboxedFolders.push({
        user: userName,
        folder,
        entryPath,
        previousTarget: resolvedTarget,
        seededSubdirs,
      });
    } catch (sandboxErr) {
      diagLog.warn('wine.sandboxFolderSyncFailed', sandboxErr, { entryPath });
    }
  }

  return { winePrefix: resolvedPrefix, sandboxedFolders };
}

/**
 * Asynchronous counterpart to `sandboxWinePrefixUserFolders` for non-blocking main-process launches.
 */
async function sandboxWinePrefixUserFoldersAsync(winePrefix, options = {}) {
  if (!winePrefix || typeof winePrefix !== 'string') {
    return { winePrefix: winePrefix || null, sandboxedFolders: [] };
  }
  try {
    await fs.promises.access(winePrefix);
  } catch {
    return { winePrefix, sandboxedFolders: [] };
  }

  const resolvedPrefix = path.resolve(winePrefix);
  const usersDir = resolveDriveCPathCaseInsensitive(path.join(resolvedPrefix, 'drive_c'), ['users']);

  let userEntries = [];
  try {
    userEntries = await fs.promises.readdir(usersDir, { withFileTypes: true });
  } catch {
    return { winePrefix: resolvedPrefix, sandboxedFolders: [] };
  }

  const externalSymlinks = [];
  let needsVdfSaveScan = false;

  for (const userEntry of userEntries) {
    if (!userEntry.isDirectory() || userEntry.name.startsWith('.')) continue;
    if (userEntry.name.toLowerCase() === 'public') continue;
    const userRoot = path.join(usersDir, userEntry.name);
    for (const folder of SANDBOX_TARGET_FOLDERS) {
      const entryPath = path.join(userRoot, folder);
      try {
        const st = await fs.promises.lstat(entryPath);
        if (!st.isSymbolicLink()) continue;
        const linkTarget = await fs.promises.readlink(entryPath);
        const resolvedTarget = path.resolve(path.dirname(entryPath), linkTarget);
        const isInsidePrefix =
          resolvedTarget === resolvedPrefix ||
          resolvedTarget.startsWith(resolvedPrefix + path.sep);
        if (!isInsidePrefix) {
          externalSymlinks.push({
            userName: userEntry.name,
            folder,
            entryPath,
            resolvedTarget,
          });
          if (
            folder === 'Documents' ||
            folder === 'My Documents' ||
            folder === 'Saved Games'
          ) {
            needsVdfSaveScan = true;
          }
        }
      } catch {
        // Folder doesn't exist or isn't a symlink
      }
    }
  }

  if (externalSymlinks.length === 0) {
    return { winePrefix: resolvedPrefix, sandboxedFolders: [] };
  }

  const maxSeedBytes =
    typeof options.maxSaveSeedBytes === 'number' && options.maxSaveSeedBytes > 0
      ? options.maxSaveSeedBytes
      : 250 * 1024 * 1024;

  const vdfDocSubdirs = new Set();
  const vdfSavedGamesSubdirs = new Set();

  if (needsVdfSaveScan) {
    const steamUserdataRoots = [
      path.join(resolvedPrefix, 'drive_c', 'Program Files (x86)', 'Steam', 'userdata'),
      path.join(resolvedPrefix, 'drive_c', 'Program Files', 'Steam', 'userdata'),
    ];
    for (const userdataRoot of steamUserdataRoots) {
      let uidEntries = [];
      try {
        uidEntries = await fs.promises.readdir(userdataRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const uidEntry of uidEntries) {
        if (!uidEntry.isDirectory() || uidEntry.name.startsWith('.')) continue;
        const uidDir = path.join(userdataRoot, uidEntry.name);
        let appEntries = [];
        try {
          appEntries = await fs.promises.readdir(uidDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const appEntry of appEntries) {
          if (!appEntry.isDirectory() || appEntry.name.startsWith('.')) continue;
          const vdfPath = path.join(uidDir, appEntry.name, 'remotecache.vdf');
          try {
            const vdfText = await fs.promises.readFile(vdfPath, 'utf8');
            parseSteamRemoteCacheText(vdfText, vdfDocSubdirs, vdfSavedGamesSubdirs);
          } catch {
            // No remotecache.vdf for this app
          }
        }
      }
    }
  }

  const sandboxedFolders = [];
  for (const item of externalSymlinks) {
    const { userName, folder, entryPath, resolvedTarget } = item;
    try {
      const candidateSubdirs = new Set();
      let targetExistsDir = false;
      try {
        const st = await fs.promises.stat(resolvedTarget);
        targetExistsDir = st.isDirectory();
      } catch {
        targetExistsDir = false;
      }

      if (targetExistsDir) {
        if (folder === 'Documents' || folder === 'My Documents') {
          const myGamesPath = path.join(resolvedTarget, 'My Games');
          try {
            const mgStat = await fs.promises.lstat(myGamesPath);
            if (!mgStat.isSymbolicLink() && mgStat.isDirectory()) {
              candidateSubdirs.add('My Games');
            }
          } catch {
            // No My Games folder
          }
          for (const sub of vdfDocSubdirs) {
            if (isSafeCandidateSubdirName(sub) || sub === 'My Games') {
              candidateSubdirs.add(sub);
            }
          }
        } else if (folder === 'Saved Games') {
          for (const sub of vdfSavedGamesSubdirs) {
            if (isSafeCandidateSubdirName(sub)) {
              candidateSubdirs.add(sub);
            }
          }
          try {
            const hostSavedEntries = await fs.promises.readdir(resolvedTarget, {
              withFileTypes: true,
            });
            for (const hEnt of hostSavedEntries) {
              if (hEnt.isSymbolicLink() || !hEnt.isDirectory()) continue;
              if (isSafeCandidateSubdirName(hEnt.name)) {
                candidateSubdirs.add(hEnt.name);
              }
            }
          } catch {
            // Unreadable host Saved Games
          }
        }
      }

      await fs.promises.unlink(entryPath);
      await fs.promises.mkdir(entryPath, { recursive: true });
      if (folder === 'Documents' || folder === 'My Documents') {
        await fs.promises.mkdir(path.join(entryPath, 'My Games'), { recursive: true });
      }

      const seededSubdirs = [];
      for (const subName of candidateSubdirs) {
        const srcSub = path.join(resolvedTarget, subName);
        const destSub = path.join(entryPath, subName);
        const copyRes = await copyRealDirBoundedAsync(srcSub, destSub, maxSeedBytes, {
          skipExisting: true,
        });
        if (copyRes.copied) {
          seededSubdirs.push(subName);
        }
      }

      sandboxedFolders.push({
        user: userName,
        folder,
        entryPath,
        previousTarget: resolvedTarget,
        seededSubdirs,
      });
    } catch (sandboxErr) {
      diagLog.warn('wine.sandboxFolderAsyncFailed', sandboxErr, { entryPath });
    }
  }

  return { winePrefix: resolvedPrefix, sandboxedFolders };
}

module.exports = {
  unescapeWineRegString,
  resolveDriveCPathCaseInsensitive,
  readWinePrefixShellFolders,
  resolveBottleSteamExe,
  sandboxWinePrefixUserFolders,
  sandboxWinePrefixUserFoldersAsync,
};
