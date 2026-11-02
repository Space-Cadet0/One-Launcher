'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
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
      usersDir: '',
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
    const cleanLetter = driveLetter.toLowerCase();
    const dosDeviceLink = path.join(resolvedPrefix, 'dosdevices', `${cleanLetter}:`);
    try {
      if (process.platform !== 'win32' && fs.existsSync(dosDeviceLink)) {
        return fs.realpathSync(dosDeviceLink);
      }
    } catch (err) {
      diagLog.debug('wine.dosdevicesRealpath', err, { dosDeviceLink });
    }
    const ntfsTestPointer = path.join(
      resolvedPrefix,
      'dosdevices',
      `${cleanLetter}.dosdevice_target`
    );
    try {
      if (fs.existsSync(ntfsTestPointer)) {
        const pointedTarget = fs.readFileSync(ntfsTestPointer, 'utf8').trim();
        if (pointedTarget && fs.existsSync(pointedTarget)) {
          return fs.realpathSync(pointedTarget);
        }
      }
    } catch {}
    return fallbackRoot;
  };

  const mapWindowsPathToHost = (unescapedVal) => {
    if (!unescapedVal || typeof unescapedVal !== 'string') return '';
    const expanded = unescapedVal
      .trim()
      .replace(/%USERPROFILE%/gi, `C:\\users\\${wineUser}`)
      .replace(/%APPDATA%/gi, `C:\\users\\${wineUser}\\AppData\\Roaming`)
      .replace(/%LOCALAPPDATA%/gi, `C:\\users\\${wineUser}\\AppData\\Local`)
      .replace(/%PUBLIC%/gi, 'C:\\users\\Public')
      .replace(/%PROGRAMDATA%/gi, 'C:\\ProgramData')
      .replace(/%ALLUSERSPROFILE%/gi, 'C:\\ProgramData');

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
    const chosenRaw = userShellFoldersRaw[key] || shellFoldersRaw[key];
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
    usersDir,
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
        const linkTarget = String(fs.readlinkSync(entryPath) || '').replace(/^\\\\\?\\/, '');
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

      try {
        fs.unlinkSync(entryPath);
      } catch {
        fs.rmdirSync(entryPath);
      }
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
        const linkTarget = String((await fs.promises.readlink(entryPath)) || '').replace(
          /^\\\\\?\\/,
          ''
        );
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

      try {
        await fs.promises.unlink(entryPath);
      } catch {
        await fs.promises.rmdir(entryPath);
      }
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

const XGR_BRIDGE_MARKER = 'OneLauncher.XGRBridge.v1';
const XGR_STAGED_MANIFEST_FILENAME = '.onelauncher-xgr-staged.json';
const DEFAULT_XBOX_DLL_SEARCH_MAX_DEPTH = 8;
const XBOX_GAMING_SERVICES_PACKED_VERSION_QWORD = 0x0026007569790000n; // 38.117.27001.0 -> hex(b):00,00,79,69,75,00,26,00
const XBOX_DEFAULT_WINE_DLL_OVERRIDES =
  'xgameruntime=n;gameinput=n;gameinputredist=n;api-ms-win-core-psm-appnotify-l1-1-0=n,b;concrt140=n,b;winemenubuilder.exe=d';

/**
 * Recursively finds files matching `predicate` under `rootDir` up to `maxDepth` (default `8`),
 * skipping symbolic links and dot-prefixed directories.
 *
 * @param {string} rootDir
 * @param {(filePath: string, entryName: string) => boolean} predicate
 * @param {number} [maxDepth]
 * @returns {Promise<string[]>}
 */
async function findFilesMatching(
  rootDir,
  predicate,
  maxDepth = DEFAULT_XBOX_DLL_SEARCH_MAX_DEPTH
) {
  /** @type {string[]} */
  const matches = [];
  if (!rootDir || typeof rootDir !== 'string' || typeof predicate !== 'function') {
    return matches;
  }
  const effectiveMaxDepth = Number.isFinite(maxDepth) && maxDepth >= 0 ? Math.floor(maxDepth) : 8;
  const walk = async (/** @type {string} */ currentDir, /** @type {number} */ depth) => {
    if (!currentDir || depth > effectiveMaxDepth) return;
    let st;
    try {
      st = await fs.promises.lstat(currentDir);
    } catch {
      return;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) return;
    const dirents = await fs.promises.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue;
      const fullPath = path.join(currentDir, d.name);
      if (d.isFile()) {
        if (predicate(fullPath, d.name)) {
          matches.push(fullPath);
        }
      } else if (d.isDirectory() && depth < effectiveMaxDepth && !d.name.startsWith('.')) {
        await walk(fullPath, depth + 1);
      }
    }
  };
  await walk(path.resolve(rootDir), 0);
  return matches;
}

function isX86BridgeArchOption(options) {
  const raw = String(options?.arch || options?.processorArchitecture || '')
    .trim()
    .toLowerCase();
  return raw === 'x86' || raw === 'i386' || raw === 'i686' || raw === 'win32';
}

function resolveBundledHelperBinCandidate(fileName) {
  const unpackedDir = __dirname.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1');
  const candidates = [
    path.join(unpackedDir, '..', 'helpers', 'bin', fileName),
    process.resourcesPath
      ? path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'electron',
          'helpers',
          'bin',
          fileName
        )
      : '',
    process.resourcesPath ? path.join(process.resourcesPath, 'helpers', 'bin', fileName) : '',
    path.join(__dirname, '..', 'helpers', 'bin', fileName),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }
  return '';
}

/**
 * Resolves the bundled 32-bit PE (`0x014c`) `one_xgameruntime_bridge_x86.dll` across dev, unpacked ASAR, and test overrides.
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function resolveXboxBridgeX86DllPath(options = {}) {
  const customOverride =
    options?.xboxBridgeX86DllPath ||
    options?.xboxRuntimeBridgeX86DllPath ||
    process.env.ONE_LAUNCHER_XBOX_BRIDGE_X86_DLL ||
    (isX86BridgeArchOption(options)
      ? options?.xboxBridgeDllPath || options?.xboxRuntimeBridgeDllPath || ''
      : '');
  if (typeof customOverride === 'string' && customOverride.trim()) {
    const custom = customOverride.trim();
    if (fs.existsSync(custom)) return custom;
  }
  return resolveBundledHelperBinCandidate('one_xgameruntime_bridge_x86.dll');
}

/**
 * Resolves the bundled PE `one_xgameruntime_bridge.dll` (or `one_xgameruntime_bridge_x86.dll` when `options.arch === 'x86'`)
 * across dev, unpacked ASAR, and test overrides.
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function resolveXboxBridgeDllPath(options = {}) {
  if (isX86BridgeArchOption(options)) {
    return resolveXboxBridgeX86DllPath(options);
  }
  const customOverride =
    options?.xboxBridgeDllPath ||
    options?.xboxRuntimeBridgeDllPath ||
    process.env.ONE_LAUNCHER_XBOX_BRIDGE_DLL ||
    '';
  if (typeof customOverride === 'string' && customOverride.trim()) {
    const custom = customOverride.trim();
    if (fs.existsSync(custom)) return custom;
  }

  return resolveBundledHelperBinCandidate('one_xgameruntime_bridge.dll');
}

/**
 * Resolves the bundled 32-bit PE (`0x014c`) `one_gameinput_bridge_x86.dll` across dev, unpacked ASAR, and test overrides.
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function resolveBundledGameInputBridgeX86DllPath(options = {}) {
  const customOverride =
    options?.gameInputBridgeX86DllPath ||
    options?.xboxGameInputBridgeX86DllPath ||
    options?.bundledGameInputX86DllPath ||
    process.env.ONE_LAUNCHER_XBOX_GAMEINPUT_BRIDGE_X86_DLL ||
    (isX86BridgeArchOption(options)
      ? options?.gameInputBridgeDllPath ||
        options?.xboxGameInputBridgeDllPath ||
        options?.bundledGameInputDllPath ||
        ''
      : '');
  if (typeof customOverride === 'string' && customOverride.trim()) {
    const custom = customOverride.trim();
    if (fs.existsSync(custom)) return custom;
  }
  return resolveBundledHelperBinCandidate('one_gameinput_bridge_x86.dll');
}

/**
 * Resolves the bundled PE `one_gameinput_bridge.dll` (or `one_gameinput_bridge_x86.dll` when `options.arch === 'x86'`)
 * across dev, unpacked ASAR, and test overrides.
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function resolveBundledGameInputBridgeDllPath(options = {}) {
  if (isX86BridgeArchOption(options)) {
    return resolveBundledGameInputBridgeX86DllPath(options);
  }
  const customOverride =
    options?.gameInputBridgeDllPath ||
    options?.xboxGameInputBridgeDllPath ||
    options?.bundledGameInputDllPath ||
    process.env.ONE_LAUNCHER_XBOX_GAMEINPUT_BRIDGE_DLL ||
    '';
  if (typeof customOverride === 'string' && customOverride.trim()) {
    const custom = customOverride.trim();
    if (fs.existsSync(custom)) return custom;
  }

  return resolveBundledHelperBinCandidate('one_gameinput_bridge.dll');
}

/**
 * Resolves the bundled 32-bit PE (`0x014c`) `one_appnotify_bridge_x86.dll` (`api-ms-win-core-psm-appnotify-l1-1-0.dll`)
 * across env overrides, unpacked ASAR, and dev paths, returning `null` gracefully if absent.
 *
 * @param {Record<string, any>} [options]
 * @returns {string | null}
 */
function resolveBundledXboxAppNotifyBridgeX86DllPath(options = {}) {
  const customOverride =
    options?.xboxAppNotifyBridgeX86DllPath ||
    options?.appNotifyBridgeX86DllPath ||
    process.env.ONE_LAUNCHER_XBOX_APPNOTIFY_BRIDGE_X86_DLL ||
    (isX86BridgeArchOption(options)
      ? options?.xboxAppNotifyBridgeDllPath || options?.appNotifyBridgeDllPath || ''
      : '');
  if (typeof customOverride === 'string' && customOverride.trim()) {
    const custom = customOverride.trim();
    try {
      if (fs.existsSync(custom) && fs.statSync(custom).isFile()) return custom;
    } catch {}
  }
  return resolveBundledHelperBinCandidate('one_appnotify_bridge_x86.dll') || null;
}

/**
 * Resolves the bundled PE `one_appnotify_bridge.dll` (or `one_appnotify_bridge_x86.dll` when `options.arch === 'x86'`)
 * across env overrides, unpacked ASAR, and dev paths, returning `null` gracefully if absent.
 *
 * @param {Record<string, any>} [options]
 * @returns {string | null}
 */
function resolveBundledXboxAppNotifyBridgeDllPath(options = {}) {
  if (isX86BridgeArchOption(options)) {
    return resolveBundledXboxAppNotifyBridgeX86DllPath(options);
  }
  const customOverride =
    options?.xboxAppNotifyBridgeDllPath ||
    options?.appNotifyBridgeDllPath ||
    process.env.ONE_LAUNCHER_XBOX_APPNOTIFY_BRIDGE_DLL ||
    '';
  if (typeof customOverride === 'string' && customOverride.trim()) {
    const custom = customOverride.trim();
    try {
      if (fs.existsSync(custom) && fs.statSync(custom).isFile()) return custom;
    } catch {}
  }

  return resolveBundledHelperBinCandidate('one_appnotify_bridge.dll') || null;
}

/**
 * Resolves the bundled 32-bit PE (`0x014c`) `one_xgr_win_launcher_x86.exe` helper for clientless
 * 32-bit Windows GDK launches, returning `null` gracefully if absent.
 *
 * @param {Record<string, any>} [options]
 * @returns {string | null}
 */
function resolveBundledXboxWinLauncherX86ExePath(options = {}) {
  const customOverride =
    options?.xboxWinLauncherX86ExePath ||
    options?.winLauncherX86ExePath ||
    process.env.ONE_LAUNCHER_XBOX_WIN_LAUNCHER_X86_EXE ||
    (isX86BridgeArchOption(options)
      ? options?.xboxWinLauncherExePath || options?.winLauncherExePath || ''
      : '');
  if (typeof customOverride === 'string' && customOverride.trim()) {
    const custom = customOverride.trim();
    try {
      if (fs.existsSync(custom) && fs.statSync(custom).isFile()) return custom;
    } catch {}
  }
  return resolveBundledHelperBinCandidate('one_xgr_win_launcher_x86.exe') || null;
}

/**
 * Resolves the bundled PE `one_xgr_win_launcher.exe` (or `one_xgr_win_launcher_x86.exe` when `options.arch === 'x86'`)
 * helper for clientless Windows GDK launches (`LOAD_LIBRARY_SEARCH_SYSTEM32` preloader), returning `null` gracefully if absent.
 *
 * @param {Record<string, any>} [options]
 * @returns {string | null}
 */
function resolveBundledXboxWinLauncherExePath(options = {}) {
  if (isX86BridgeArchOption(options)) {
    return resolveBundledXboxWinLauncherX86ExePath(options);
  }
  const customOverride =
    options?.xboxWinLauncherExePath ||
    options?.winLauncherExePath ||
    process.env.ONE_LAUNCHER_XBOX_WIN_LAUNCHER_EXE ||
    '';
  if (typeof customOverride === 'string' && customOverride.trim()) {
    const custom = customOverride.trim();
    try {
      if (fs.existsSync(custom) && fs.statSync(custom).isFile()) return custom;
    } catch {}
  }

  return resolveBundledHelperBinCandidate('one_xgr_win_launcher.exe') || null;
}

/**
 * Atomically upserts multiple keys inside `<bottleDir>/user.reg` in a single read/write pass
 * and a single coalesced live `reg.exe import` (or pushes into `options.liveSyncAccumulator`).
 *
 * @param {string} bottleDir
 * @param {Array<{ subKeyPath: string, entries: Array<[string, any]> | Record<string, any> }>} keySpecs
 * @param {Record<string, any>} [options]
 */
function upsertWineUserRegKeysBatch(bottleDir, keySpecs, options = {}) {
  const regFilePath =
    typeof options.regFilePath === 'string' && options.regFilePath
      ? options.regFilePath
      : bottleDir
        ? path.join(bottleDir, 'user.reg')
        : '';
  if (!regFilePath || !Array.isArray(keySpecs) || keySpecs.length === 0) {
    return { updated: false, regFilePath: '' };
  }
  const { upsertWineSystemRegKeysBatch } = require('./firstPartyRegistration.cjs');
  return upsertWineSystemRegKeysBatch(bottleDir, keySpecs, {
    ...options,
    regFilePath,
  });
}

/**
 * Atomically upserts a key and string/dword values inside `<bottleDir>/user.reg`.
 * @param {string} bottleDir
 * @param {string} keyPath
 * @param {Array<[string, any]> | Record<string, any>} valuesObj
 * @param {Record<string, any>} [options]
 */
function upsertWineUserRegKey(bottleDir, keyPath, valuesObj, options = {}) {
  if (!keyPath) {
    return { updated: false, regFilePath: '' };
  }
  return upsertWineUserRegKeysBatch(bottleDir, [{ subKeyPath: keyPath, entries: valuesObj }], options);
}

/**
 * Detects whether a Wine invocation targets CrossOver's Perl `bin/wine` wrapper
 * (as opposed to a direct `wineloader`/`wine64` Mach-O binary).
 *
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function isCrossOverPerlWineWrapperOptions(options = {}) {
  if (!options || typeof options !== 'object') return false;
  if (typeof options.isCrossOverWrapper === 'boolean') {
    return options.isCrossOverWrapper;
  }
  const binPath = String(
    options.wineBinaryPath || options.binaryPath || options.compatLayer?.binaryPath || ''
  ).trim();
  if (binPath) {
    if (/\/(?:wineloader(?:64|2)?|wine64|wine-preloader)$/i.test(binPath)) {
      return false;
    }
    if (
      /\/CrossOver[^/]*\/bin\/wine$/i.test(binPath) ||
      (/\/bin\/wine$/i.test(binPath) && /crossover/i.test(binPath))
    ) {
      return true;
    }
  }
  const layerType = String(
    options.layerType || options.compatLayer?.type || ''
  )
    .trim()
    .toLowerCase();
  if (layerType === 'crossover' || layerType === 'crossover_preview') {
    return !binPath || /\/bin\/wine$/i.test(binPath);
  }
  return false;
}

/**
 * Derives CrossOver's `Contents/SharedSupport/CrossOver` (`CX_ROOT`) directory from a CrossOver
 * `wine` / `wineloader` / `cxbottle` binary path or compatibility-layer descriptor.
 *
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function deriveCrossOverRootPath(options = {}) {
  if (!options || typeof options !== 'object') return '';
  if (typeof options.cxRoot === 'string' && options.cxRoot.trim()) {
    return options.cxRoot.trim().replace(/\/+$/, '');
  }
  const binPath = String(
    options.wineBinaryPath || options.binaryPath || options.compatLayer?.binaryPath || ''
  ).trim();
  if (binPath) {
    const normalized = binPath.replace(/\\/g, '/');
    const sharedSupportMatch = normalized.match(
      /^(.*?\/Contents\/SharedSupport\/CrossOver)(?:\/|$)/i
    );
    if (sharedSupportMatch && sharedSupportMatch[1]) {
      return sharedSupportMatch[1];
    }
    const appBundleMatch = normalized.match(/^(.*?\/CrossOver[^/]*\.app)(?:\/|$)/i);
    if (appBundleMatch && appBundleMatch[1]) {
      return `${appBundleMatch[1]}/Contents/SharedSupport/CrossOver`;
    }
    const directBinMatch = normalized.match(
      /^(.*?\/CrossOver)\/bin\/(?:wine(?:64)?|wineloader(?:64|2)?|wineserver(?:64)?|cxbottle)$/i
    );
    if (directBinMatch && directBinMatch[1]) {
      return directBinMatch[1];
    }
  }
  const layerType = String(options.layerType || options.compatLayer?.type || '')
    .trim()
    .toLowerCase();
  if (layerType === 'crossover' || layerType === 'crossover_preview') {
    const home = String(options.homedir || os.homedir() || '').trim();
    const appNames =
      layerType === 'crossover_preview'
        ? ['CrossOver Preview.app', 'CrossOver.app']
        : ['CrossOver.app', 'CrossOver Preview.app'];
    const roots = [
      typeof options.customApplicationsDir === 'string' ? options.customApplicationsDir.trim() : '',
      '/Applications',
      home ? path.join(home, 'Applications') : '',
    ].filter(Boolean);
    for (const rootDir of roots) {
      for (const appName of appNames) {
        const cand = path.join(rootDir, appName, 'Contents', 'SharedSupport', 'CrossOver');
        try {
          if (fs.existsSync(cand)) return cand;
        } catch {}
      }
    }
  }
  return '';
}

/**
 * Ensures CrossOver 26.x environment hygiene on `darwin` whenever targeting a CrossOver
 * `wineloader` / `wine` binary: populates `CX_ROOT`, `CX_HOME` (`$HOME/Library/Application Support/CrossOver`),
 * and `DOTNET_EnableWriteXorExecute='0'` if not already set so `cxcompatdb.so` rules activate reliably.
 *
 * @param {Record<string, any>} [env]
 * @param {Record<string, any>} [options]
 */
function applyCrossOverEnvironmentHygiene(env = {}, options = {}) {
  if (!env || typeof env !== 'object') return env;
  const platform = String(options?.platform || process.platform).trim() || process.platform;
  if (platform !== 'darwin') return env;

  const binPath = String(
    options?.wineBinaryPath || options?.binaryPath || options?.compatLayer?.binaryPath || ''
  ).trim();
  const layerType = String(options?.layerType || options?.compatLayer?.type || '')
    .trim()
    .toLowerCase();
  const cxRoot = deriveCrossOverRootPath(options);
  const isCrossOverTarget =
    Boolean(cxRoot) ||
    layerType === 'crossover' ||
    layerType === 'crossover_preview' ||
    isCrossOverPerlWineWrapperOptions(options) ||
    /crossover/i.test(binPath);
  if (!isCrossOverTarget) return env;

  if (!env.CX_ROOT && cxRoot) {
    env.CX_ROOT = cxRoot;
  }
  if (!env.CX_HOME) {
    const home = String(options?.homedir || env.HOME || os.homedir() || '').trim();
    if (home) {
      env.CX_HOME = path.join(home, 'Library', 'Application Support', 'CrossOver');
    }
  }
  if (env.DOTNET_EnableWriteXorExecute === undefined || env.DOTNET_EnableWriteXorExecute === '') {
    env.DOTNET_EnableWriteXorExecute = '0';
  }
  return env;
}

/**
 * Strips any global `"CX_GRAPHICS_BACKEND" = "wined3d"` entry from `<bottlePath>/cxbottle.conf`
 * during bottle provisioning so bottles never default globally to software/OpenGL WineD3D.
 *
 * @param {string} bottlePath
 * @returns {boolean}
 */
function sanitizeProvisionedBottleGraphicsBackend(bottlePath) {
  if (!bottlePath || typeof bottlePath !== 'string' || !bottlePath.trim()) return false;
  const confPath = path.join(bottlePath.trim(), 'cxbottle.conf');
  try {
    if (!fs.existsSync(confPath)) return false;
    const raw = fs.readFileSync(confPath, 'utf8');
    const globalWineD3dRe = /^[ \t]*"CX_GRAPHICS_BACKEND"[ \t]*=[ \t]*"wined3d"[ \t]*\r?\n?/gim;
    if (!globalWineD3dRe.test(raw)) return false;
    const cleaned = raw.replace(
      /^[ \t]*"CX_GRAPHICS_BACKEND"[ \t]*=[ \t]*"wined3d"[ \t]*\r?\n?/gim,
      ''
    );
    if (cleaned === raw) return false;
    const tmpPath = `${confPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, cleaned, 'utf8');
    fs.renameSync(tmpPath, confPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enforces Apple Rosetta AVX environment variable semantics across both raw `wine64`/`wineloader`
 * and CrossOver's Perl `bin/wine` wrapper:
 * - Raw `wine64`/`wineloader`: Rosetta checks `getenv("ROSETTA_ADVERTISE_AVX") != NULL`, so when
 *   disabled (`advertiseAvx === false`) the variable must be deleted from `env`.
 * - CrossOver Perl `bin/wine` (`bin/wine:726-738`): defaults missing `ROSETTA_ADVERTISE_AVX` to `'1'`,
 *   and only deletes `$ENV{ROSETTA_ADVERTISE_AVX}` before `exec(wineloader)` when set to `'0'`.
 *
 * @param {Record<string, any>} [env]
 * @param {boolean|string|number} [advertiseAvx]
 * @param {{ isCrossOverWrapper?: boolean, wineBinaryPath?: string, binaryPath?: string, layerType?: string, compatLayer?: any, platform?: string, homedir?: string, cxRoot?: string }} [options]
 */
function applyStrictRosettaAvxEnv(env = {}, advertiseAvx = undefined, options = {}) {
  if (!env || typeof env !== 'object') return env;
  applyCrossOverEnvironmentHygiene(env, options);
  const isCrossOverWrapper = isCrossOverPerlWineWrapperOptions(options);
  if (advertiseAvx === true || advertiseAvx === '1' || advertiseAvx === 1) {
    env.ROSETTA_ADVERTISE_AVX = '1';
  } else if (advertiseAvx === false || advertiseAvx === '0' || advertiseAvx === 0) {
    if (isCrossOverWrapper) {
      env.ROSETTA_ADVERTISE_AVX = '0';
    } else {
      delete env.ROSETTA_ADVERTISE_AVX;
    }
  } else if (!isCrossOverWrapper && (env.ROSETTA_ADVERTISE_AVX === '0' || env.ROSETTA_ADVERTISE_AVX === '')) {
    delete env.ROSETTA_ADVERTISE_AVX;
  } else if (isCrossOverWrapper && env.ROSETTA_ADVERTISE_AVX === '') {
    delete env.ROSETTA_ADVERTISE_AVX;
  }
  return env;
}

/**
 * Merges Wine DLL override rules without duplicating existing keys.
 * @param {string} [existingOverrides]
 * @param {string} [additions]
 * @returns {string}
 */
function mergeWineDllOverrides(
  existingOverrides = '',
  additions = XBOX_DEFAULT_WINE_DLL_OVERRIDES
) {
  const orderedKeys = [];
  const map = new Map();
  const ingest = (raw, preserveExisting = false) => {
    for (const part of String(raw || '').split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const rawKey = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!rawKey || !val) continue;
      const normKey = rawKey.toLowerCase();
      if (!map.has(normKey)) {
        orderedKeys.push(normKey);
      } else if (preserveExisting) {
        continue;
      }
      map.set(normKey, { key: rawKey, val });
    }
  };
  ingest(existingOverrides, false);
  ingest(additions, true);
  return orderedKeys
    .map((normKey) => {
      const entry = map.get(normKey);
      return `${entry.key}=${entry.val}`;
    })
    .join(';');
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Reads a bundled bridge DLL and verifies its SHA-256 against an optional `<dllPath>.sha256` sidecar.
 * @param {string} dllPath
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ buf: Buffer | null, sha256: string, sidecarVerified: boolean }>}
 */
async function readVerifiedBridgeDllBuffer(dllPath, options = {}) {
  if (!dllPath) return { buf: null, sha256: '', sidecarVerified: false };
  try {
    const buf = await fs.promises.readFile(dllPath);
    const actualHash = sha256Buffer(buf).toLowerCase();
    const directSidecar = `${dllPath}.sha256`;
    const stemSidecar = dllPath.replace(/\.(?:dll|exe)$/i, '.sha256');
    const sidecarPath = fs.existsSync(directSidecar)
      ? directSidecar
      : stemSidecar !== dllPath && fs.existsSync(stemSidecar)
        ? stemSidecar
        : '';
    let sidecarVerified = false;
    try {
      if (sidecarPath) {
        const rawSidecar = await fs.promises.readFile(sidecarPath, 'utf8');
        const m = String(rawSidecar || '').trim().match(/^([0-9a-fA-F]{64})\b/);
        if (m && m[1]) {
          const expectedSidecarHash = m[1].toLowerCase();
          if (expectedSidecarHash !== actualHash) {
            diagLog.warn('wine.bridgeDllSidecarMismatch', 'Bridge DLL SHA-256 mismatch against sidecar', {
              dllPath,
              expectedSidecarHash,
              actualHash,
            });
            if (options.strictBridgeSha256 === true) {
              return { buf: null, sha256: '', sidecarVerified: false };
            }
          } else {
            sidecarVerified = true;
          }
        }
      }
    } catch {}
    return { buf, sha256: actualHash, sidecarVerified };
  } catch (err) {
    diagLog.warn('wine.readBridgeDllFailed', err, { dllPath });
    return { buf: null, sha256: '', sidecarVerified: false };
  }
}

const XBOX_GDK_IMPORT_DLL_NAMES = new Set([
  'xgameruntime.dll',
  'xgameruntime.thunks.dll',
  'xgamingruntimethunks.dll',
  'gameinput.dll',
  'gameinputredist.dll',
  'xcurl.dll',
  'partywin.dll',
  'partywin7.dll',
  'partyxboxlive.dll',
]);

function isXboxGdkDllName(dllName) {
  const lower = String(dllName || '').trim().toLowerCase();
  if (!lower) return false;
  if (XBOX_GDK_IMPORT_DLL_NAMES.has(lower)) return true;
  if (lower.startsWith('microsoft.xbox.services')) return true;
  if (lower.startsWith('libhttpclient')) return true;
  if (lower.startsWith('xsapi')) return true;
  return false;
}

/**
 * Bounded Win32 PE32 (`0x010b`) / PE32+ (`0x020b`) header & import-table inspector.
 * Uses slice reads via `fs.openSync` / `fs.readSync` so multi-hundred-MB game binaries are never
 * loaded into memory.
 *
 * @param {string | Buffer} filePathOrBuf
 * @param {{ skipRdataStringScan?: boolean }} [options]
 * @returns {{
 *   validPe: boolean,
 *   rawMachine: number,
 *   machine: 'x86' | 'x64' | 'arm64' | '',
 *   importedDlls: string[],
 *   referencesXgrApi: boolean
 * }}
 */
function inspectPeBinaryImportsSync(filePathOrBuf, options = {}) {
  const emptyResult = {
    validPe: false,
    rawMachine: 0,
    machine: /** @type {'x86' | 'x64' | 'arm64' | ''} */ (''),
    importedDlls: /** @type {string[]} */ ([]),
    referencesXgrApi: false,
  };
  if (!filePathOrBuf) return emptyResult;

  /** @type {number | null} */
  let fd = null;
  let totalSize = 0;
  /** @type {Buffer | null} */
  let inMemBuf = null;
  /** @type {Buffer} */
  let headWindow = Buffer.alloc(0);

  try {
    if (Buffer.isBuffer(filePathOrBuf)) {
      inMemBuf = filePathOrBuf;
      totalSize = inMemBuf.length;
      if (totalSize < 96) return emptyResult;
      headWindow = inMemBuf.subarray(0, Math.min(totalSize, 65536));
    } else if (typeof filePathOrBuf === 'string' && filePathOrBuf.trim()) {
      fd = fs.openSync(filePathOrBuf.trim(), 'r');
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size < 96) return emptyResult;
      totalSize = st.size;
      const headLen = Math.min(totalSize, 65536);
      headWindow = Buffer.allocUnsafe(headLen);
      const bytesRead = fs.readSync(fd, headWindow, 0, headLen, 0);
      if (bytesRead < 96) return emptyResult;
      if (bytesRead < headLen) headWindow = headWindow.subarray(0, bytesRead);
    } else {
      return emptyResult;
    }

    const readSlice = (/** @type {number} */ offset, /** @type {number} */ length) => {
      if (!Number.isFinite(offset) || offset < 0 || length <= 0 || offset >= totalSize) {
        return null;
      }
      const clampedLen = Math.min(length, totalSize - offset);
      if (clampedLen <= 0) return null;
      if (inMemBuf) {
        return inMemBuf.subarray(offset, offset + clampedLen);
      }
      if (offset + clampedLen <= headWindow.length) {
        return headWindow.subarray(offset, offset + clampedLen);
      }
      if (fd === null) return null;
      const slice = Buffer.allocUnsafe(clampedLen);
      const got = fs.readSync(fd, slice, 0, clampedLen, offset);
      return got > 0 ? slice.subarray(0, got) : null;
    };

    if (headWindow.readUInt16LE(0) !== 0x5a4d) return emptyResult;
    const eLfanew = headWindow.readUInt32LE(0x3c);
    if (eLfanew < 0x40 || eLfanew + 24 > totalSize) return emptyResult;

    const peHdr = readSlice(eLfanew, 4096);
    if (!peHdr || peHdr.length < 24 || peHdr.readUInt32LE(0) !== 0x00004550) {
      return emptyResult;
    }

    const rawMachine = peHdr.readUInt16LE(4);
    /** @type {'x86' | 'x64' | 'arm64' | ''} */
    const machine =
      rawMachine === 0x014c
        ? 'x86'
        : rawMachine === 0x8664
          ? 'x64'
          : rawMachine === 0xaa64
            ? 'arm64'
            : '';
    const numSections = Math.min(peHdr.readUInt16LE(6), 96);
    const sizeOfOptionalHeader = peHdr.readUInt16LE(20);
    if (sizeOfOptionalHeader < 96) {
      return {
        validPe: true,
        rawMachine,
        machine,
        importedDlls: [],
        referencesXgrApi: false,
      };
    }

    const optAndSecLen = 24 + sizeOfOptionalHeader + numSections * 40;
    const fullPeHdr = peHdr.length >= optAndSecLen ? peHdr : readSlice(eLfanew, optAndSecLen);
    if (!fullPeHdr || fullPeHdr.length < 24 + sizeOfOptionalHeader) {
      return {
        validPe: true,
        rawMachine,
        machine,
        importedDlls: [],
        referencesXgrApi: false,
      };
    }

    const optOffset = 24;
    const magic = fullPeHdr.readUInt16LE(optOffset);
    let numRvaOffset = 0;
    let dataDirOffset = 0;
    if (magic === 0x010b) {
      numRvaOffset = optOffset + 92;
      dataDirOffset = optOffset + 96;
    } else if (magic === 0x020b) {
      numRvaOffset = optOffset + 108;
      dataDirOffset = optOffset + 112;
    } else {
      return {
        validPe: true,
        rawMachine,
        machine,
        importedDlls: [],
        referencesXgrApi: false,
      };
    }

    if (numRvaOffset + 4 > optOffset + sizeOfOptionalHeader) {
      return {
        validPe: true,
        rawMachine,
        machine,
        importedDlls: [],
        referencesXgrApi: false,
      };
    }
    const numberOfRvaAndSizes = Math.min(fullPeHdr.readUInt32LE(numRvaOffset), 32);

    const secTableOffset = optOffset + sizeOfOptionalHeader;
    /** @type {Array<{ name: string, virtualSize: number, virtualAddress: number, sizeOfRawData: number, pointerToRawData: number }>} */
    const sections = [];
    for (let i = 0; i < numSections; i++) {
      const sOff = secTableOffset + i * 40;
      if (sOff + 40 > fullPeHdr.length) break;
      const rawName = fullPeHdr.subarray(sOff, sOff + 8);
      const nulIdx = rawName.indexOf(0);
      const secName = rawName.subarray(0, nulIdx >= 0 ? nulIdx : 8).toString('ascii');
      sections.push({
        name: secName,
        virtualSize: fullPeHdr.readUInt32LE(sOff + 8),
        virtualAddress: fullPeHdr.readUInt32LE(sOff + 12),
        sizeOfRawData: fullPeHdr.readUInt32LE(sOff + 16),
        pointerToRawData: fullPeHdr.readUInt32LE(sOff + 20),
      });
    }

    const headerSpan = eLfanew + secTableOffset + sections.length * 40;
    const rvaToRaw = (/** @type {number} */ rva) => {
      if (!rva || rva < 0) return null;
      for (const sec of sections) {
        const span = Math.max(sec.virtualSize, sec.sizeOfRawData);
        if (span > 0 && rva >= sec.virtualAddress && rva < sec.virtualAddress + span) {
          const delta = rva - sec.virtualAddress;
          if (sec.sizeOfRawData > 0 && delta >= sec.sizeOfRawData) return null;
          const raw = sec.pointerToRawData + delta;
          return raw >= 0 && raw < totalSize ? raw : null;
        }
      }
      if (rva > 0 && rva < headerSpan && rva < totalSize) {
        return rva;
      }
      return null;
    };

    const readAsciiCStringAtRva = (/** @type {number} */ rva) => {
      const rawOff = rvaToRaw(rva);
      if (rawOff === null) return '';
      const nameBuf = readSlice(rawOff, 260);
      if (!nameBuf || nameBuf.length === 0) return '';
      let end = 0;
      while (end < nameBuf.length && nameBuf[end] !== 0) {
        const b = nameBuf[end];
        if (b < 0x20 || b > 0x7e) return '';
        end += 1;
      }
      if (end === 0 || end >= 260) return '';
      return nameBuf.subarray(0, end).toString('ascii');
    };

    const importedSet = new Set();

    // Standard Import Directory (DataDirectory[1])
    if (
      numberOfRvaAndSizes >= 2 &&
      dataDirOffset + 16 <= optOffset + sizeOfOptionalHeader
    ) {
      const importRva = fullPeHdr.readUInt32LE(dataDirOffset + 8);
      if (importRva > 0) {
        for (let idx = 0; idx < 512; idx++) {
          const descRaw = rvaToRaw(importRva + idx * 20);
          if (descRaw === null) break;
          const descBuf = readSlice(descRaw, 20);
          if (!descBuf || descBuf.length < 20) break;
          const origFirstThunk = descBuf.readUInt32LE(0);
          const nameRva = descBuf.readUInt32LE(12);
          const firstThunk = descBuf.readUInt32LE(16);
          if (origFirstThunk === 0 && nameRva === 0 && firstThunk === 0) break;
          if (nameRva > 0) {
            const dllName = readAsciiCStringAtRva(nameRva).trim().toLowerCase();
            if (dllName) importedSet.add(dllName);
          }
        }
      }
    }

    // Delay-Load Import Directory (DataDirectory[13])
    if (
      numberOfRvaAndSizes >= 14 &&
      dataDirOffset + 14 * 8 <= optOffset + sizeOfOptionalHeader
    ) {
      const delayRva = fullPeHdr.readUInt32LE(dataDirOffset + 13 * 8);
      if (delayRva > 0) {
        for (let idx = 0; idx < 256; idx++) {
          const descRaw = rvaToRaw(delayRva + idx * 32);
          if (descRaw === null) break;
          const descBuf = readSlice(descRaw, 32);
          if (!descBuf || descBuf.length < 32) break;
          const attrs = descBuf.readUInt32LE(0);
          const dllNameRva = descBuf.readUInt32LE(4);
          const modHandleRva = descBuf.readUInt32LE(8);
          if (attrs === 0 && dllNameRva === 0 && modHandleRva === 0) break;
          if ((attrs & 1) !== 0 && dllNameRva > 0) {
            const dllName = readAsciiCStringAtRva(dllNameRva).trim().toLowerCase();
            if (dllName) importedSet.add(dllName);
          }
        }
      }
    }

    const importedDlls = Array.from(importedSet);
    let referencesXgrApi = importedDlls.some((name) => isXboxGdkDllName(name));

    // Statically linked xgameruntime.lib resolves Xgameruntime.dll via LoadLibraryExW +
    // GetProcAddress(..., "InitializeApiImpl") without listing xgameruntime.dll in imports.
    if (!referencesXgrApi && options.skipRdataStringScan !== true && sections.length > 0) {
      const needle = Buffer.from('InitializeApiImpl', 'ascii');
      let remainingBudget = 8 * 1024 * 1024;
      const rdataCandidates = sections.filter(
        (s) => s.sizeOfRawData > 0 && (s.name.startsWith('.rdata') || s.name === '.rodata')
      );
      const scanSections = rdataCandidates.length > 0 ? rdataCandidates : sections.slice(0, 4);
      for (const sec of scanSections) {
        if (remainingBudget <= 0 || referencesXgrApi) break;
        const secBytes = Math.min(sec.sizeOfRawData, remainingBudget);
        let pos = 0;
        const chunkLen = 256 * 1024;
        while (pos < secBytes) {
          const toRead = Math.min(chunkLen, secBytes - pos);
          const chunk = readSlice(sec.pointerToRawData + pos, toRead);
          if (!chunk || chunk.length < needle.length) break;
          if (chunk.includes(needle)) {
            referencesXgrApi = true;
            break;
          }
          if (pos + toRead >= secBytes) break;
          pos += Math.max(1, toRead - needle.length);
        }
        remainingBudget -= secBytes;
      }
    }

    return {
      validPe: true,
      rawMachine,
      machine,
      importedDlls,
      referencesXgrApi,
    };
  } catch {
    return emptyResult;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Resolves a child game executable referenced by `launcher_settings.cfg` (`BinaryPath=...`, `LocalePath=...`)
 * located alongside `executablePath` or inside `installDir`.
 *
 * @param {string} [executablePath]
 * @param {string} [installDir]
 * @returns {string}
 */
function resolveLauncherSettingsChildExecutable(executablePath = '', installDir = '') {
  const exeDir =
    typeof executablePath === 'string' && executablePath.trim()
      ? path.dirname(path.resolve(executablePath.trim()))
      : '';
  const resolvedInstall =
    typeof installDir === 'string' && installDir.trim() ? path.resolve(installDir.trim()) : '';

  const searchDirs = Array.from(new Set([exeDir, resolvedInstall].filter(Boolean)));
  if (searchDirs.length === 0) return '';

  let cfgPath = '';
  let cfgDir = '';
  for (const dir of searchDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir);
      const match = entries.find((n) => n.toLowerCase() === 'launcher_settings.cfg');
      if (match) {
        const full = path.join(dir, match);
        if (fs.statSync(full).isFile()) {
          cfgPath = full;
          cfgDir = dir;
          break;
        }
      }
    } catch {}
  }
  if (!cfgPath) return '';

  let rawText = '';
  try {
    rawText = fs.readFileSync(cfgPath, 'utf8');
  } catch {
    return '';
  }
  if (!rawText.trim()) return '';

  let rawBinaryPath = '';
  let rawLocalePath = '';
  const trimmed = rawText.replace(/^\uFEFF/, '').trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsedJson = JSON.parse(trimmed);
      rawBinaryPath = String(parsedJson?.BinaryPath || parsedJson?.binaryPath || '').trim();
      rawLocalePath = String(parsedJson?.LocalePath || parsedJson?.localePath || '').trim();
    } catch {}
  }
  if (!rawBinaryPath) {
    for (const line of trimmed.split(/\r?\n/)) {
      const cleanLine = line.trim();
      if (!cleanLine || cleanLine.startsWith('#') || cleanLine.startsWith(';')) continue;
      const eqIdx = cleanLine.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = cleanLine.slice(0, eqIdx).trim().toLowerCase();
      const val = cleanLine
        .slice(eqIdx + 1)
        .trim()
        .replace(/^["']|["']$/g, '')
        .trim();
      if (key === 'binarypath' && val) rawBinaryPath = val;
      else if (key === 'localepath' && val) rawLocalePath = val;
    }
  }

  const normBinRel = rawBinaryPath
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/|\/)+/, '')
    .trim();
  if (!normBinRel || normBinRel.includes('..')) return '';

  const normLocaleRel = rawLocalePath
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/|\/)+/, '')
    .trim();

  const roots = Array.from(new Set([cfgDir, resolvedInstall, exeDir].filter(Boolean)));
  const isContainedRegularFile = (/** @type {string} */ rootDir, /** @type {string} */ candidate) => {
    const resolvedRoot = path.resolve(rootDir);
    const resolvedCand = path.resolve(candidate);
    if (
      resolvedCand !== resolvedRoot &&
      !resolvedCand.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
      return false;
    }
    try {
      return fs.existsSync(resolvedCand) && fs.statSync(resolvedCand).isFile();
    } catch {
      return false;
    }
  };

  for (const root of roots) {
    if (
      normLocaleRel &&
      normLocaleRel.toUpperCase() !== 'X' &&
      !normLocaleRel.includes('..')
    ) {
      const explicitLocaleCand = path.join(root, normLocaleRel, normBinRel);
      if (isContainedRegularFile(root, explicitLocaleCand)) {
        return path.resolve(explicitLocaleCand);
      }
    }

    const directCand = path.join(root, normBinRel);
    if (isContainedRegularFile(root, directCand)) {
      return path.resolve(directCand);
    }

    const enCand = path.join(root, 'EN', normBinRel);
    if (isContainedRegularFile(root, enCand)) {
      return path.resolve(enCand);
    }

    try {
      const subEntries = fs.readdirSync(root, { withFileTypes: true });
      subEntries.sort((a, b) => a.name.localeCompare(b.name));
      for (const sub of subEntries) {
        if (!sub.isDirectory() || sub.isSymbolicLink()) continue;
        if (!/^[a-zA-Z]{2,5}(?:[-_][a-zA-Z]{2,4})?$/.test(sub.name)) continue;
        const subCand = path.join(root, sub.name, normBinRel);
        if (isContainedRegularFile(root, subCand)) {
          return path.resolve(subCand);
        }
      }
    } catch {}
  }

  return '';
}

async function copyBufferIfChanged(targetPath, srcBuf, expectedSha256) {
  try {
    const st = await fs.promises.stat(targetPath);
    if (st.isFile() && st.size === srcBuf.length) {
      const currentBuf = await fs.promises.readFile(targetPath);
      if (sha256Buffer(currentBuf).toLowerCase() === String(expectedSha256 || '').toLowerCase()) {
        return false;
      }
    }
  } catch {}
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.promises.writeFile(tmpPath, srcBuf);
  await fs.promises.rename(tmpPath, targetPath);
  return true;
}

/**
 * Records staged/overridden app-local bridge DLL paths inside `<installDir>/.onelauncher-xgr-staged.json`
 * so native Windows `GamingServices` registration or repair can cleanly restore original retail DLLs.
 *
 * @param {string} installDir
 * @param {string[]} stagedLocalFiles
 * @param {Array<{ localDllPath: string, backupPath: string }>} backedUpLocalDlls
 */
async function writeStagedLocalBridgeManifest(installDir, stagedLocalFiles, backedUpLocalDlls) {
  if (!installDir || typeof installDir !== 'string' || !installDir.trim()) return;
  if (stagedLocalFiles.length === 0 && backedUpLocalDlls.length === 0) return;
  const resolvedInstallDir = path.resolve(installDir.trim());
  try {
    if (!fs.existsSync(resolvedInstallDir)) return;
    const manifestPath = path.join(resolvedInstallDir, XGR_STAGED_MANIFEST_FILENAME);
    let existingStaged = [];
    let existingBackedUp = [];
    try {
      if (fs.existsSync(manifestPath)) {
        const parsed = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        if (Array.isArray(parsed?.stagedFiles)) existingStaged = parsed.stagedFiles;
        if (Array.isArray(parsed?.backedUpLocalDlls)) existingBackedUp = parsed.backedUpLocalDlls;
      }
    } catch {}
    const mergedStaged = Array.from(
      new Set(
        [...existingStaged, ...stagedLocalFiles]
          .filter((p) => typeof p === 'string' && p.trim())
          .map((p) => path.relative(resolvedInstallDir, path.resolve(p)))
          .filter((rel) => rel && !rel.startsWith('..') && !path.isAbsolute(rel))
      )
    );
    /** @type {Map<string, { localRelPath: string, backupRelPath: string }>} */
    const backupMap = new Map();
    for (const item of existingBackedUp) {
      if (item && typeof item.localRelPath === 'string' && typeof item.backupRelPath === 'string') {
        backupMap.set(item.localRelPath.toLowerCase(), item);
      }
    }
    for (const item of backedUpLocalDlls) {
      if (!item?.localDllPath || !item?.backupPath) continue;
      const localRelPath = path.relative(resolvedInstallDir, path.resolve(item.localDllPath));
      const backupRelPath = path.relative(resolvedInstallDir, path.resolve(item.backupPath));
      if (
        localRelPath &&
        !localRelPath.startsWith('..') &&
        !path.isAbsolute(localRelPath) &&
        backupRelPath &&
        !backupRelPath.startsWith('..') &&
        !path.isAbsolute(backupRelPath)
      ) {
        backupMap.set(localRelPath.toLowerCase(), { localRelPath, backupRelPath });
      }
    }
    const payload = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      stagedFiles: mergedStaged,
      backedUpLocalDlls: Array.from(backupMap.values()),
    };
    const tmpPath = `${manifestPath}.tmp.${process.pid}.${Date.now()}`;
    await fs.promises.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tmpPath, manifestPath);
  } catch (err) {
    diagLog.debug('wine.writeStagedBridgeManifestFailed', err, { installDir: resolvedInstallDir });
  }
}

/**
 * Restores any `.msft.bak` retail DLLs and removes One Launcher app-local bridge DLLs recorded in
 * `<installDir>/.onelauncher-xgr-staged.json` when transitioning a Windows directory to native `GamingServices`.
 *
 * @param {string} installDir
 */
async function restoreWindowsClientlessXboxBridgeDlls(installDir) {
  if (!installDir || typeof installDir !== 'string' || !installDir.trim()) {
    return { restoredCount: 0, removedCount: 0 };
  }
  const resolvedInstallDir = path.resolve(installDir.trim());
  const manifestPath = path.join(resolvedInstallDir, XGR_STAGED_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    return { restoredCount: 0, removedCount: 0 };
  }
  let restoredCount = 0;
  let removedCount = 0;
  const genericOneLauncherMarkerBuf = Buffer.from('OneLauncher.', 'utf8');
  try {
    const parsed = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    const backedUp = Array.isArray(parsed?.backedUpLocalDlls) ? parsed.backedUpLocalDlls : [];
    const staged = Array.isArray(parsed?.stagedFiles) ? parsed.stagedFiles : [];
    const restoredLower = new Set();

    for (const item of backedUp) {
      const localRel = String(item?.localRelPath || '').trim();
      const backupRel = String(item?.backupRelPath || '').trim();
      if (!localRel || !backupRel || localRel.includes('..') || backupRel.includes('..')) continue;
      const localFull = path.resolve(resolvedInstallDir, localRel);
      const backupFull = path.resolve(resolvedInstallDir, backupRel);
      if (
        !localFull.startsWith(`${resolvedInstallDir}${path.sep}`) ||
        !backupFull.startsWith(`${resolvedInstallDir}${path.sep}`)
      ) {
        continue;
      }
      if (fs.existsSync(backupFull)) {
        await fs.promises.rename(backupFull, localFull).catch(async () => {
          const bakBuf = await fs.promises.readFile(backupFull);
          await fs.promises.writeFile(localFull, bakBuf);
          await fs.promises.unlink(backupFull).catch(() => {});
        });
        restoredLower.add(localRel.toLowerCase());
        restoredCount += 1;
      }
    }

    for (const rel of staged) {
      const cleanRel = String(rel || '').trim();
      if (!cleanRel || cleanRel.includes('..') || restoredLower.has(cleanRel.toLowerCase())) {
        continue;
      }
      const fullPath = path.resolve(resolvedInstallDir, cleanRel);
      if (!fullPath.startsWith(`${resolvedInstallDir}${path.sep}`)) continue;
      if (!fs.existsSync(fullPath)) continue;
      const bakCandidate = `${fullPath}.msft.bak`;
      if (fs.existsSync(bakCandidate)) {
        await fs.promises.rename(bakCandidate, fullPath).catch(() => {});
        restoredCount += 1;
        continue;
      }
      const curBuf = await fs.promises.readFile(fullPath).catch(() => null);
      if (curBuf && curBuf.includes(genericOneLauncherMarkerBuf)) {
        await fs.promises.unlink(fullPath).catch(() => {});
        removedCount += 1;
      }
    }

    await fs.promises.unlink(manifestPath).catch(() => {});
  } catch (err) {
    diagLog.warn('wine.restoreClientlessXboxBridgeFailed', err, { installDir: resolvedInstallDir });
  }
  return { restoredCount, removedCount };
}

function determineLocalDllArch(
  localDllPath,
  existingBuf,
  genericOneLauncherMarkerBuf,
  defaultArch = 'x64'
) {
  const backupPath = `${localDllPath}.msft.bak`;
  if (fs.existsSync(backupPath)) {
    const bakInfo = inspectPeBinaryImportsSync(backupPath, { skipRdataStringScan: true });
    if (bakInfo.machine === 'x86' || bakInfo.machine === 'x64') {
      return bakInfo.machine;
    }
  }
  if (existingBuf && !existingBuf.includes(genericOneLauncherMarkerBuf)) {
    const curInfo = inspectPeBinaryImportsSync(existingBuf, { skipRdataStringScan: true });
    if (curInfo.machine === 'x86' || curInfo.machine === 'x64') {
      return curInfo.machine;
    }
  }
  return defaultArch === 'x86' ? 'x86' : 'x64';
}

/**
 * Stages SHA-256-verified `Xgameruntime.dll`, `GameInput.dll`, and `GameInputRedist.dll` into
 * a Windows clientless `xbox-msixvc-win` game directory (matching `x86` vs `x64` PE architecture,
 * backing up original Microsoft DLLs to `.msft.bak`, skipping non-GDK classic Win32 titles, and
 * selecting the matching `one_xgr_win_launcher*.exe` preloader).
 *
 * @param {Record<string, any>} [options]
 */
async function stageWindowsClientlessXboxBridgeDlls(options = {}) {
  const x64LookupOpts = { ...options, arch: 'x64' };
  const bridgeX64DllPath = resolveXboxBridgeDllPath(x64LookupOpts);
  const gameInputX64DllPath = resolveBundledGameInputBridgeDllPath(x64LookupOpts);
  const bridgeX86DllPath = resolveXboxBridgeX86DllPath(options);
  const gameInputX86DllPath = resolveBundledGameInputBridgeX86DllPath(options);

  const [bridgeX64Verified, gameInputX64Verified, bridgeX86Verified, gameInputX86Verified] =
    await Promise.all([
      readVerifiedBridgeDllBuffer(bridgeX64DllPath, options),
      readVerifiedBridgeDllBuffer(gameInputX64DllPath, options),
      readVerifiedBridgeDllBuffer(bridgeX86DllPath, options),
      readVerifiedBridgeDllBuffer(gameInputX86DllPath, options),
    ]);

  const maxDepth = Number.isFinite(options.maxDllSearchDepth)
    ? Math.max(0, Math.floor(Number(options.maxDllSearchDepth)))
    : DEFAULT_XBOX_DLL_SEARCH_MAX_DEPTH;
  const candidateDirs = new Set();
  const walkInstallDirs = async (
    /** @type {string} */ baseDir,
    /** @type {number} */ depth = 0
  ) => {
    if (!baseDir || depth > maxDepth) return;
    let st;
    try {
      st = await fs.promises.lstat(baseDir);
    } catch {
      return;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) return;
    candidateDirs.add(baseDir);
    if (depth >= maxDepth) return;
    const dirents = await fs.promises.readdir(baseDir, { withFileTypes: true }).catch(() => []);
    for (const d of dirents) {
      if (!d.isDirectory() || d.isSymbolicLink() || d.name.startsWith('.')) continue;
      await walkInstallDirs(path.join(baseDir, d.name), depth + 1);
    }
  };

  const resolvedInstallRoot =
    typeof options.installDir === 'string' && options.installDir.trim()
      ? path.resolve(options.installDir.trim())
      : '';
  if (resolvedInstallRoot) {
    await walkInstallDirs(resolvedInstallRoot, 0);
  }
  const resolvedExePath =
    typeof options.executablePath === 'string' && options.executablePath.trim()
      ? path.resolve(options.executablePath.trim())
      : '';
  let primaryExeDir = '';
  if (resolvedExePath) {
    primaryExeDir = path.dirname(resolvedExePath);
    candidateDirs.add(primaryExeDir);
  } else if (resolvedInstallRoot) {
    primaryExeDir = resolvedInstallRoot;
  }

  const childExecutablePath = resolveLauncherSettingsChildExecutable(
    resolvedExePath,
    resolvedInstallRoot
  );
  if (childExecutablePath) {
    candidateDirs.add(path.dirname(childExecutablePath));
  }

  const exeInfo = resolvedExePath
    ? inspectPeBinaryImportsSync(resolvedExePath)
    : { validPe: false, rawMachine: 0, machine: /** @type {''} */ (''), importedDlls: [], referencesXgrApi: false };
  const childExeInfo = childExecutablePath
    ? inspectPeBinaryImportsSync(childExecutablePath)
    : { validPe: false, rawMachine: 0, machine: /** @type {''} */ (''), importedDlls: [], referencesXgrApi: false };

  /** @type {'x86' | 'x64'} */
  const targetMachine =
    exeInfo.machine === 'x86' || exeInfo.machine === 'x64'
      ? exeInfo.machine
      : childExeInfo.machine === 'x86' || childExeInfo.machine === 'x64'
        ? childExeInfo.machine
        : isX86BridgeArchOption(options)
          ? 'x86'
          : 'x64';

  const xgrMarkerBuf = Buffer.from(XGR_BRIDGE_MARKER, 'utf8');
  const genericOneLauncherMarkerBuf = Buffer.from('OneLauncher.', 'utf8');

  /** @type {Map<string, string[]>} */
  const entriesByDir = new Map();
  let hasRetailOrBackedUpXgameruntime = false;
  let hasGdkCompanionDllInTree = false;
  /** @type {string[]} */
  const nonMarkerDllPathsForImportCheck = [];

  for (const dirPath of candidateDirs) {
    try {
      if (!fs.existsSync(dirPath)) continue;
      const entries = await fs.promises.readdir(dirPath);
      entriesByDir.set(dirPath, entries);
      for (const entryName of entries) {
        const lowerName = entryName.toLowerCase();
        if (!lowerName.endsWith('.dll')) continue;
        const fullDllPath = path.join(dirPath, entryName);
        const hasMsftBak = fs.existsSync(`${fullDllPath}.msft.bak`);
        if (lowerName === 'xgameruntime.dll') {
          if (hasMsftBak) {
            hasRetailOrBackedUpXgameruntime = true;
          } else {
            const existingBuf = await fs.promises.readFile(fullDllPath).catch(() => null);
            if (
              existingBuf &&
              !existingBuf.includes(xgrMarkerBuf) &&
              !existingBuf.includes(genericOneLauncherMarkerBuf)
            ) {
              hasRetailOrBackedUpXgameruntime = true;
            }
          }
        } else if (isXboxGdkDllName(lowerName)) {
          if (hasMsftBak) {
            hasGdkCompanionDllInTree = true;
          } else {
            const existingBuf = await fs.promises.readFile(fullDllPath).catch(() => null);
            if (existingBuf && !existingBuf.includes(genericOneLauncherMarkerBuf)) {
              hasGdkCompanionDllInTree = true;
            }
          }
        } else if (nonMarkerDllPathsForImportCheck.length < 48) {
          nonMarkerDllPathsForImportCheck.push(fullDllPath);
        }
      }
    } catch {}
  }

  let hasPluginDllImportingGdk = false;
  const candidateForClassicWin32 =
    exeInfo.validPe &&
    (exeInfo.machine === 'x86' || exeInfo.machine === 'x64') &&
    exeInfo.importedDlls.length > 0 &&
    !exeInfo.referencesXgrApi &&
    (!childExecutablePath || (childExeInfo.validPe && !childExeInfo.referencesXgrApi)) &&
    !hasRetailOrBackedUpXgameruntime &&
    !hasGdkCompanionDllInTree;

  if (candidateForClassicWin32) {
    for (const dllPath of nonMarkerDllPathsForImportCheck) {
      const dllInfo = inspectPeBinaryImportsSync(dllPath, { skipRdataStringScan: true });
      if (dllInfo.referencesXgrApi) {
        hasPluginDllImportingGdk = true;
        break;
      }
    }
  }

  const isPureClassicWin32WithoutGdk = candidateForClassicWin32 && !hasPluginDllImportingGdk;

  const selectBridgeForArch = (/** @type {'x86' | 'x64'} */ arch) => {
    if (arch === 'x86' && bridgeX86Verified.buf) {
      return {
        dllPath: bridgeX86DllPath,
        buf: bridgeX86Verified.buf,
        sha256: bridgeX86Verified.sha256,
      };
    }
    return {
      dllPath: bridgeX64DllPath,
      buf: bridgeX64Verified.buf,
      sha256: bridgeX64Verified.sha256,
    };
  };

  const selectGameInputForArch = (/** @type {'x86' | 'x64'} */ arch) => {
    if (arch === 'x86' && gameInputX86Verified.buf) {
      return {
        dllPath: gameInputX86DllPath,
        buf: gameInputX86Verified.buf,
        sha256: gameInputX86Verified.sha256,
      };
    }
    return {
      dllPath: gameInputX64DllPath,
      buf: gameInputX64Verified.buf,
      sha256: gameInputX64Verified.sha256,
    };
  };

  const primaryBridgeSelection = selectBridgeForArch(targetMachine);
  const primaryGameInputSelection = selectGameInputForArch(targetMachine);

  if (isPureClassicWin32WithoutGdk) {
    const manifestRoot = resolvedInstallRoot || primaryExeDir;
    if (manifestRoot && fs.existsSync(path.join(manifestRoot, XGR_STAGED_MANIFEST_FILENAME))) {
      await restoreWindowsClientlessXboxBridgeDlls(manifestRoot);
    }
    return {
      bridgeDllPath: primaryBridgeSelection.dllPath,
      bridgeStaged: false,
      gameInputBridgeDllPath: primaryGameInputSelection.dllPath,
      gameInputStaged: false,
      primaryExeDir,
      primaryXgameruntimeDllPath: '',
      backedUpLocalDlls: [],
      stagedLocalFiles: [],
      targetMachine,
      requiresXgrInjection: false,
      winLauncherExePath: '',
      childExecutablePath,
    };
  }

  /** @type {Array<{ localDllPath: string, backupPath: string }>} */
  const backedUpLocalDlls = [];
  /** @type {string[]} */
  const stagedLocalFiles = [];
  let bridgeStaged = false;
  let gameInputStaged = false;
  let primaryXgameruntimeDllPath = primaryExeDir
    ? path.join(primaryExeDir, 'xgameruntime.dll')
    : '';

  for (const [dirPath, entries] of entriesByDir.entries()) {
    try {
      for (const entryName of entries) {
        const lowerName = entryName.toLowerCase();
        if (lowerName === 'xgameruntime.dll') {
          const localDllPath = path.join(dirPath, entryName);
          const existingBuf = await fs.promises.readFile(localDllPath);
          const dllArch = determineLocalDllArch(
            localDllPath,
            existingBuf,
            genericOneLauncherMarkerBuf,
            targetMachine
          );
          const chosenBridge = selectBridgeForArch(dllArch);
          if (!chosenBridge.buf) continue;
          const existingHash = sha256Buffer(existingBuf).toLowerCase();
          if (
            existingHash !== chosenBridge.sha256 &&
            !existingBuf.includes(xgrMarkerBuf) &&
            !existingBuf.includes(genericOneLauncherMarkerBuf)
          ) {
            const backupPath = `${localDllPath}.msft.bak`;
            if (!fs.existsSync(backupPath)) {
              await fs.promises.writeFile(backupPath, existingBuf);
            }
            backedUpLocalDlls.push({ localDllPath, backupPath });
          }
          await copyBufferIfChanged(localDllPath, chosenBridge.buf, chosenBridge.sha256);
          stagedLocalFiles.push(localDllPath);
          if (primaryExeDir && path.resolve(dirPath) === path.resolve(primaryExeDir)) {
            primaryXgameruntimeDllPath = localDllPath;
          }
          bridgeStaged = true;
        } else if (lowerName === 'gameinput.dll' || lowerName === 'gameinputredist.dll') {
          const localDllPath = path.join(dirPath, entryName);
          const existingBuf = await fs.promises.readFile(localDllPath);
          const dllArch = determineLocalDllArch(
            localDllPath,
            existingBuf,
            genericOneLauncherMarkerBuf,
            targetMachine
          );
          const chosenGi = selectGameInputForArch(dllArch);
          if (!chosenGi.buf) continue;
          const existingHash = sha256Buffer(existingBuf).toLowerCase();
          if (
            existingHash !== chosenGi.sha256 &&
            !existingBuf.includes(genericOneLauncherMarkerBuf)
          ) {
            const backupPath = `${localDllPath}.msft.bak`;
            if (!fs.existsSync(backupPath)) {
              await fs.promises.writeFile(backupPath, existingBuf);
            }
            backedUpLocalDlls.push({ localDllPath, backupPath });
          }
          await copyBufferIfChanged(localDllPath, chosenGi.buf, chosenGi.sha256);
          stagedLocalFiles.push(localDllPath);
          gameInputStaged = true;
        }
      }
    } catch (err) {
      diagLog.warn('wine.stageWinClientlessXboxBridgeFailed', err, { dirPath });
    }
  }

  const stageDirWithArch = async (
    /** @type {string} */ targetDir,
    /** @type {'x86' | 'x64'} */ arch,
    /** @type {boolean} */ isPrimary
  ) => {
    if (!targetDir || !fs.existsSync(targetDir)) return;
    const chosenBridge = selectBridgeForArch(arch);
    const chosenGi = selectGameInputForArch(arch);
    try {
      const existingNames = await fs.promises.readdir(targetDir).catch(() => []);
      const findCaseMatch = (
        /** @type {string} */ targetLower,
        /** @type {string} */ defaultName
      ) => existingNames.find((n) => n.toLowerCase() === targetLower) || defaultName;
      if (chosenBridge.buf) {
        const targetXgr = path.join(
          targetDir,
          findCaseMatch('xgameruntime.dll', 'xgameruntime.dll')
        );
        await copyBufferIfChanged(targetXgr, chosenBridge.buf, chosenBridge.sha256);
        if (isPrimary) {
          primaryXgameruntimeDllPath = targetXgr;
        }
        stagedLocalFiles.push(targetXgr);
        bridgeStaged = true;
      }
      if (chosenGi.buf) {
        const targetGi = path.join(targetDir, findCaseMatch('gameinput.dll', 'GameInput.dll'));
        const targetGir = path.join(
          targetDir,
          findCaseMatch('gameinputredist.dll', 'GameInputRedist.dll')
        );
        await copyBufferIfChanged(targetGi, chosenGi.buf, chosenGi.sha256);
        await copyBufferIfChanged(targetGir, chosenGi.buf, chosenGi.sha256);
        stagedLocalFiles.push(targetGi, targetGir);
        gameInputStaged = true;
      }
    } catch (err) {
      diagLog.warn('wine.stagePrimaryExeBridgeFailed', err, { primaryExeDir: targetDir });
    }
  };

  // Ensure primary executable directory (and any distinct child executable directory) has matching-arch app-local bridges
  await stageDirWithArch(primaryExeDir, targetMachine, true);
  if (childExecutablePath) {
    const childExeDir = path.dirname(childExecutablePath);
    if (!primaryExeDir || path.resolve(childExeDir) !== path.resolve(primaryExeDir)) {
      const childArch =
        childExeInfo.machine === 'x86' || childExeInfo.machine === 'x64'
          ? childExeInfo.machine
          : targetMachine;
      await stageDirWithArch(childExeDir, childArch, false);
    }
  }

  if (resolvedInstallRoot || primaryExeDir) {
    await writeStagedLocalBridgeManifest(
      resolvedInstallRoot || primaryExeDir,
      stagedLocalFiles,
      backedUpLocalDlls
    );
  }

  const winLauncherExePath =
    resolveBundledXboxWinLauncherExePath({ ...options, arch: targetMachine }) || '';

  return {
    bridgeDllPath: primaryBridgeSelection.dllPath,
    bridgeStaged,
    gameInputBridgeDllPath: primaryGameInputSelection.dllPath,
    gameInputStaged,
    primaryExeDir,
    primaryXgameruntimeDllPath,
    backedUpLocalDlls,
    stagedLocalFiles,
    targetMachine,
    requiresXgrInjection: true,
    winLauncherExePath,
    childExecutablePath,
  };
}

function formatBottleWgsUserFolder(xuid, scid) {
  const cleanXuid = String(xuid || '').trim();
  const cleanScid = String(scid || '').trim().toLowerCase();
  if (!cleanXuid || !cleanScid) return '';
  try {
    const hexXuid = /^[0-9]+$/.test(cleanXuid)
      ? BigInt(cleanXuid).toString(16).toUpperCase().padStart(16, '0')
      : cleanXuid.replace(/^0x/i, '').toUpperCase().padStart(16, '0');
    return `${hexXuid}_${cleanScid}`;
  } catch {
    return '';
  }
}

/**
 * Provisions a macOS Wine/CrossOver/GPTK bottle for clientless GDK / Xbox Game Runtime execution:
 * stages `one_xgameruntime_bridge.dll` into `system32/xgameruntime.dll`, `one_gameinput_bridge.dll`
 * into `system32/gameinput{,redist}.dll`, and `one_appnotify_bridge.dll` into
 * `system32/api-ms-win-core-psm-appnotify-l1-1-0.dll` (when present); backs up & overrides any
 * app-local Microsoft GDK DLLs up to depth 8; creates the UWP `Packages/<PFN>/SystemAppData/wgs`
 * sandbox under the dynamically detected bottle user; upserts `GamingServices` (`REG_QWORD`
 * `CurrentVersion` & `AvailableVersion` = `0x0026007569790000` / `38.117.27001.0`) + `winebus`
 * registry keys; and configures `WINEDLLOVERRIDES` + strict `ROSETTA_ADVERTISE_AVX`.
 *
 * @param {Record<string, any>} [options]
 */
async function prepareXboxBottleEnvironment(options = {}) {
  const resolvedBottle = String(
    options.bottlePath || options.bottleDir || options.winePrefix || ''
  ).trim();
  const env = options.env && typeof options.env === 'object' ? options.env : {};
  env.WINEDLLOVERRIDES = mergeWineDllOverrides(
    env.WINEDLLOVERRIDES,
    XBOX_DEFAULT_WINE_DLL_OVERRIDES
  );
  applyStrictRosettaAvxEnv(env, options.advertiseAvx, {
    isCrossOverWrapper: options.isCrossOverWrapper,
    wineBinaryPath: options.wineBinaryPath,
    compatLayer: options.compatLayer,
    layerType: options.layerType,
    platform: options.platform,
    homedir: options.homedir,
    cxRoot: options.cxRoot,
  });
  if (
    resolvedBottle &&
    String(options.crossoverGraphicsBackend || '').trim().toLowerCase() !== 'wined3d'
  ) {
    sanitizeProvisionedBottleGraphicsBackend(resolvedBottle);
  }

  const x64Opts = { ...options, arch: 'x64' };
  const bridgeDllPath = resolveXboxBridgeDllPath(x64Opts);
  const gameInputBridgeDllPath = resolveBundledGameInputBridgeDllPath(x64Opts);
  const appNotifyBridgeDllPath = resolveBundledXboxAppNotifyBridgeDllPath(x64Opts);
  const bridgeX86DllPath = resolveXboxBridgeX86DllPath(options);
  const gameInputBridgeX86DllPath = resolveBundledGameInputBridgeX86DllPath(options);
  const appNotifyBridgeX86DllPath = resolveBundledXboxAppNotifyBridgeX86DllPath(options);

  const [
    bridgeVerified,
    gameInputVerified,
    appNotifyVerified,
    bridgeX86Verified,
    gameInputX86Verified,
    appNotifyX86Verified,
  ] = await Promise.all([
    readVerifiedBridgeDllBuffer(bridgeDllPath, options),
    readVerifiedBridgeDllBuffer(gameInputBridgeDllPath, options),
    appNotifyBridgeDllPath
      ? readVerifiedBridgeDllBuffer(appNotifyBridgeDllPath, options)
      : Promise.resolve({ buf: null, sha256: '', sidecarVerified: false }),
    readVerifiedBridgeDllBuffer(bridgeX86DllPath, options),
    readVerifiedBridgeDllBuffer(gameInputBridgeX86DllPath, options),
    appNotifyBridgeX86DllPath
      ? readVerifiedBridgeDllBuffer(appNotifyBridgeX86DllPath, options)
      : Promise.resolve({ buf: null, sha256: '', sidecarVerified: false }),
  ]);
  const bridgeBuf = bridgeVerified.buf;
  const bridgeHash = bridgeVerified.sha256;
  const gameInputBuf = gameInputVerified.buf;
  const gameInputHash = gameInputVerified.sha256;
  const appNotifyBuf = appNotifyVerified.buf;
  const appNotifyHash = appNotifyVerified.sha256;

  const bridgeX86Buf = bridgeX86Verified.buf;
  const bridgeX86Hash = bridgeX86Verified.sha256;
  const gameInputX86Buf = gameInputX86Verified.buf;
  const gameInputX86Hash = gameInputX86Verified.sha256;
  const appNotifyX86Buf = appNotifyX86Verified.buf;
  const appNotifyX86Hash = appNotifyX86Verified.sha256;

  let system32DllPath = '';
  let system32AppNotifyDllPath = '';
  let syswow64DllPath = '';
  let syswow64AppNotifyDllPath = '';
  let bridgeStaged = false;
  let gameInputStaged = false;
  let appNotifyStaged = false;
  let bridgeX86Staged = false;
  let gameInputX86Staged = false;
  let appNotifyX86Staged = false;
  /** @type {Array<{ localDllPath: string, backupPath: string }>} */
  const backedUpLocalDlls = [];
  /** @type {string[]} */
  const stagedLocalFiles = [];
  const stagedVcLibsAppDlls = [];
  const stagedVcLibsSyswow64Dlls = [];

  if (resolvedBottle) {
    const driveC = path.join(resolvedBottle, 'drive_c');
    await fs.promises.mkdir(driveC, { recursive: true });
    const system32Dir = resolveDriveCPathCaseInsensitive(driveC, ['windows', 'system32']);
    const syswow64Dir = resolveDriveCPathCaseInsensitive(driveC, ['windows', 'syswow64']);
    await Promise.all([
      fs.promises.mkdir(system32Dir, { recursive: true }),
      fs.promises.mkdir(syswow64Dir, { recursive: true }),
    ]);
    system32DllPath = path.join(system32Dir, 'xgameruntime.dll');

    if (bridgeBuf) {
      await copyBufferIfChanged(system32DllPath, bridgeBuf, bridgeHash);
      bridgeStaged = true;
    }

    if (gameInputBuf) {
      await copyBufferIfChanged(
        path.join(system32Dir, 'gameinput.dll'),
        gameInputBuf,
        gameInputHash
      );
      await copyBufferIfChanged(
        path.join(system32Dir, 'gameinputredist.dll'),
        gameInputBuf,
        gameInputHash
      );
      gameInputStaged = true;
    }

    if (appNotifyBuf) {
      system32AppNotifyDllPath = path.join(system32Dir, 'api-ms-win-core-psm-appnotify-l1-1-0.dll');
      await copyBufferIfChanged(system32AppNotifyDllPath, appNotifyBuf, appNotifyHash);
      appNotifyStaged = true;
    }

    // Stage 32-bit (`0x014c`) bridges into `drive_c/windows/syswow64` for WoW64 GDK execution
    if (bridgeX86Buf) {
      syswow64DllPath = path.join(syswow64Dir, 'xgameruntime.dll');
      await copyBufferIfChanged(syswow64DllPath, bridgeX86Buf, bridgeX86Hash);
      bridgeX86Staged = true;
    }

    if (gameInputX86Buf) {
      await copyBufferIfChanged(
        path.join(syswow64Dir, 'gameinput.dll'),
        gameInputX86Buf,
        gameInputX86Hash
      );
      await copyBufferIfChanged(
        path.join(syswow64Dir, 'gameinputredist.dll'),
        gameInputX86Buf,
        gameInputX86Hash
      );
      gameInputX86Staged = true;
    }

    if (appNotifyX86Buf) {
      syswow64AppNotifyDllPath = path.join(syswow64Dir, 'api-ms-win-core-psm-appnotify-l1-1-0.dll');
      await copyBufferIfChanged(syswow64AppNotifyDllPath, appNotifyX86Buf, appNotifyX86Hash);
      appNotifyX86Staged = true;
    }

    const compatBinPath = String(
      options.compatLayer?.binaryPath || options.wineBinaryPath || ''
    ).trim();

    // Provision UWP VCLibs *_app.dll CRT aliases in `system32` (`x64`) and `syswow64` (`x86`),
    // plus fresh-bottle `x86` VC14 runtime donor fallback from Wine/CrossOver `lib/wine/i386-windows`
    try {
      const vcLibPairs = [
        ['vcruntime140.dll', 'vcruntime140_app.dll'],
        ['vcruntime140_1.dll', 'vcruntime140_1_app.dll'],
        ['msvcp140.dll', 'msvcp140_app.dll'],
        ['concrt140.dll', 'concrt140_app.dll'],
        ['vccorlib140.dll', 'vccorlib140_app.dll'],
      ];
      const sys32Entries = await fs.promises.readdir(system32Dir).catch(() => []);
      const sys32ByLower = new Map(
        sys32Entries.map((name) => /** @type {[string, string]} */ ([name.toLowerCase(), name]))
      );
      const extraWineWin64Dirs = compatBinPath
        ? [
            path.resolve(path.dirname(compatBinPath), '..', 'lib', 'wine', 'x86_64-windows'),
            path.resolve(path.dirname(compatBinPath), '..', 'lib64', 'wine', 'x86_64-windows'),
            path.resolve(
              path.dirname(compatBinPath),
              '..',
              'SharedSupport',
              'CrossOver',
              'lib',
              'wine',
              'x86_64-windows'
            ),
          ]
        : [];

      for (const [donorName, targetAppName] of vcLibPairs) {
        if (sys32ByLower.has(targetAppName.toLowerCase())) continue;
        let donorPath = '';
        const existingDonorEntry = sys32ByLower.get(donorName.toLowerCase());
        if (existingDonorEntry) {
          donorPath = path.join(system32Dir, existingDonorEntry);
        } else {
          for (const wineLibDir of extraWineWin64Dirs) {
            const cand = path.join(wineLibDir, donorName);
            if (fs.existsSync(cand)) {
              donorPath = cand;
              break;
            }
          }
        }
        if (donorPath && fs.existsSync(donorPath)) {
          const targetAppPath = path.join(system32Dir, targetAppName);
          const donorBuf = await fs.promises.readFile(donorPath);
          await copyBufferIfChanged(targetAppPath, donorBuf, sha256Buffer(donorBuf));
          stagedVcLibsAppDlls.push(targetAppPath);
        }
      }

      const vcLibPairsX86 = [
        ['vcruntime140.dll', 'vcruntime140_app.dll'],
        ['msvcp140.dll', 'msvcp140_app.dll'],
        ['concrt140.dll', 'concrt140_app.dll'],
        ['vccorlib140.dll', 'vccorlib140_app.dll'],
      ];
      const syswowEntries = await fs.promises.readdir(syswow64Dir).catch(() => []);
      const syswowByLower = new Map(
        syswowEntries.map((name) => /** @type {[string, string]} */ ([name.toLowerCase(), name]))
      );
      const extraWineWin32Dirs = compatBinPath
        ? [
            path.resolve(path.dirname(compatBinPath), '..', 'lib', 'wine', 'i386-windows'),
            path.resolve(path.dirname(compatBinPath), '..', 'lib32', 'wine', 'i386-windows'),
            path.resolve(
              path.dirname(compatBinPath),
              '..',
              'SharedSupport',
              'CrossOver',
              'lib',
              'wine',
              'i386-windows'
            ),
          ]
        : [];

      // Ensure base x86 VC14 runtime DLLs exist in syswow64 on fresh prefixes when Wine/CrossOver provides them
      for (const [baseDllName] of vcLibPairsX86) {
        if (syswowByLower.has(baseDllName.toLowerCase())) continue;
        for (const wineLibDir of extraWineWin32Dirs) {
          const cand = path.join(wineLibDir, baseDllName);
          if (fs.existsSync(cand)) {
            const targetBasePath = path.join(syswow64Dir, baseDllName);
            const donorBuf = await fs.promises.readFile(cand);
            await copyBufferIfChanged(targetBasePath, donorBuf, sha256Buffer(donorBuf));
            syswowByLower.set(baseDllName.toLowerCase(), baseDllName);
            stagedVcLibsSyswow64Dlls.push(targetBasePath);
            break;
          }
        }
      }

      // Synthesize x86 *_app.dll CRT aliases in syswow64
      for (const [donorName, targetAppName] of vcLibPairsX86) {
        if (syswowByLower.has(targetAppName.toLowerCase())) continue;
        let donorPath = '';
        const existingDonorEntry = syswowByLower.get(donorName.toLowerCase());
        if (existingDonorEntry) {
          donorPath = path.join(syswow64Dir, existingDonorEntry);
        } else {
          for (const wineLibDir of extraWineWin32Dirs) {
            const cand = path.join(wineLibDir, donorName);
            if (fs.existsSync(cand)) {
              donorPath = cand;
              break;
            }
          }
        }
        if (donorPath && fs.existsSync(donorPath)) {
          const targetAppPath = path.join(syswow64Dir, targetAppName);
          const donorBuf = await fs.promises.readFile(donorPath);
          await copyBufferIfChanged(targetAppPath, donorBuf, sha256Buffer(donorBuf));
          stagedVcLibsAppDlls.push(targetAppPath);
          stagedVcLibsSyswow64Dlls.push(targetAppPath);
        }
      }
    } catch (err) {
      diagLog.warn('wine.provisionVcLibsAppDllsFailed', err, { system32Dir, syswow64Dir });
    }

    // Back up and replace any game-local Microsoft xgameruntime.dll, GameInput/GameInputRedist.dll,
    // and api-ms-win-core-psm-appnotify-l1-1-0.dll (up to depth 8), matching PE architecture (`0x014c` vs `0x8664`)
    const maxDepth = Number.isFinite(options.maxDllSearchDepth)
      ? Math.max(0, Math.floor(Number(options.maxDllSearchDepth)))
      : DEFAULT_XBOX_DLL_SEARCH_MAX_DEPTH;
    const candidateDirs = new Set();
    const walkInstallDirs = async (
      /** @type {string} */ baseDir,
      /** @type {number} */ depth = 0
    ) => {
      if (!baseDir || depth > maxDepth) return;
      let st;
      try {
        st = await fs.promises.lstat(baseDir);
      } catch {
        return;
      }
      if (!st.isDirectory() || st.isSymbolicLink()) return;
      candidateDirs.add(baseDir);
      if (depth >= maxDepth) return;
      const dirents = await fs.promises.readdir(baseDir, { withFileTypes: true }).catch(() => []);
      for (const d of dirents) {
        if (!d.isDirectory() || d.isSymbolicLink() || d.name.startsWith('.')) continue;
        await walkInstallDirs(path.join(baseDir, d.name), depth + 1);
      }
    };
    const resolvedInstallRoot =
      typeof options.installDir === 'string' && options.installDir.trim()
        ? path.resolve(options.installDir.trim())
        : '';
    if (resolvedInstallRoot) {
      await walkInstallDirs(resolvedInstallRoot, 0);
    }
    const resolvedExePath =
      typeof options.executablePath === 'string' && options.executablePath.trim()
        ? path.resolve(options.executablePath.trim())
        : '';
    if (resolvedExePath) {
      candidateDirs.add(path.dirname(resolvedExePath));
    }
    const childExecutablePath = resolveLauncherSettingsChildExecutable(
      resolvedExePath,
      resolvedInstallRoot
    );
    if (childExecutablePath) {
      candidateDirs.add(path.dirname(childExecutablePath));
    }

    const exeInfo = resolvedExePath
      ? inspectPeBinaryImportsSync(resolvedExePath, { skipRdataStringScan: true })
      : { machine: '' };
    const childInfo = childExecutablePath
      ? inspectPeBinaryImportsSync(childExecutablePath, { skipRdataStringScan: true })
      : { machine: '' };
    /** @type {'x86' | 'x64'} */
    const defaultLocalArch =
      exeInfo.machine === 'x86' || exeInfo.machine === 'x64'
        ? exeInfo.machine
        : childInfo.machine === 'x86' || childInfo.machine === 'x64'
          ? childInfo.machine
          : isX86BridgeArchOption(options)
            ? 'x86'
            : 'x64';

    const xgrMarkerBuf = Buffer.from(XGR_BRIDGE_MARKER, 'utf8');
    const genericOneLauncherMarkerBuf = Buffer.from('OneLauncher.', 'utf8');
    for (const dirPath of candidateDirs) {
      try {
        if (!fs.existsSync(dirPath)) continue;
        const entries = await fs.promises.readdir(dirPath);
        for (const entryName of entries) {
          const lowerName = entryName.toLowerCase();
          if (lowerName === 'xgameruntime.dll') {
            const localDllPath = path.join(dirPath, entryName);
            const existingBuf = await fs.promises.readFile(localDllPath);
            const dllArch = determineLocalDllArch(
              localDllPath,
              existingBuf,
              genericOneLauncherMarkerBuf,
              defaultLocalArch
            );
            const chosenBuf = dllArch === 'x86' && bridgeX86Buf ? bridgeX86Buf : bridgeBuf;
            const chosenHash = dllArch === 'x86' && bridgeX86Buf ? bridgeX86Hash : bridgeHash;
            const existingHash = sha256Buffer(existingBuf).toLowerCase();
            if (
              existingHash !== chosenHash &&
              !existingBuf.includes(xgrMarkerBuf) &&
              !existingBuf.includes(genericOneLauncherMarkerBuf)
            ) {
              const backupPath = `${localDllPath}.msft.bak`;
              if (!fs.existsSync(backupPath)) {
                await fs.promises.writeFile(backupPath, existingBuf);
              }
              backedUpLocalDlls.push({ localDllPath, backupPath });
            }
            if (chosenBuf) {
              await copyBufferIfChanged(localDllPath, chosenBuf, chosenHash);
              stagedLocalFiles.push(localDllPath);
            }
          } else if (lowerName === 'gameinput.dll' || lowerName === 'gameinputredist.dll') {
            const localDllPath = path.join(dirPath, entryName);
            const existingBuf = await fs.promises.readFile(localDllPath);
            const dllArch = determineLocalDllArch(
              localDllPath,
              existingBuf,
              genericOneLauncherMarkerBuf,
              defaultLocalArch
            );
            const chosenBuf = dllArch === 'x86' && gameInputX86Buf ? gameInputX86Buf : gameInputBuf;
            const chosenHash =
              dllArch === 'x86' && gameInputX86Buf ? gameInputX86Hash : gameInputHash;
            if (!chosenBuf) continue;
            if (
              sha256Buffer(existingBuf).toLowerCase() !== chosenHash &&
              !existingBuf.includes(genericOneLauncherMarkerBuf)
            ) {
              const backupPath = `${localDllPath}.msft.bak`;
              if (!fs.existsSync(backupPath)) {
                await fs.promises.writeFile(backupPath, existingBuf);
              }
              backedUpLocalDlls.push({ localDllPath, backupPath });
            }
            await copyBufferIfChanged(localDllPath, chosenBuf, chosenHash);
            stagedLocalFiles.push(localDllPath);
          } else if (lowerName === 'api-ms-win-core-psm-appnotify-l1-1-0.dll') {
            const localDllPath = path.join(dirPath, entryName);
            const existingBuf = await fs.promises.readFile(localDllPath);
            const dllArch = determineLocalDllArch(
              localDllPath,
              existingBuf,
              genericOneLauncherMarkerBuf,
              defaultLocalArch
            );
            const chosenBuf = dllArch === 'x86' && appNotifyX86Buf ? appNotifyX86Buf : appNotifyBuf;
            const chosenHash =
              dllArch === 'x86' && appNotifyX86Buf ? appNotifyX86Hash : appNotifyHash;
            if (!chosenBuf) continue;
            if (
              sha256Buffer(existingBuf).toLowerCase() !== chosenHash &&
              !existingBuf.includes(genericOneLauncherMarkerBuf)
            ) {
              const backupPath = `${localDllPath}.msft.bak`;
              if (!fs.existsSync(backupPath)) {
                await fs.promises.writeFile(backupPath, existingBuf);
              }
              backedUpLocalDlls.push({ localDllPath, backupPath });
            }
            await copyBufferIfChanged(localDllPath, chosenBuf, chosenHash);
            stagedLocalFiles.push(localDllPath);
          }
        }
      } catch (err) {
        diagLog.warn('wine.stageLocalXboxBridgeFailed', err, { dirPath });
      }
    }

    if (resolvedInstallRoot && (stagedLocalFiles.length > 0 || backedUpLocalDlls.length > 0)) {
      await writeStagedLocalBridgeManifest(
        resolvedInstallRoot,
        stagedLocalFiles,
        backedUpLocalDlls
      );
    }

    // Idempotent Wine system.reg & user.reg keys for GamingServices (REG_QWORD CurrentVersion/AvailableVersion),
    // DllOverrides (xgameruntime, gameinput, gameinputredist, api-ms-win-core-psm-appnotify-l1-1-0, concrt140),
    // and GameInput/SDL controller harmony
    try {
      const {
        upsertWineSystemRegKeysBatch,
        flushLiveWineRegistryAccumulator,
      } = require('./firstPartyRegistration.cjs');
      /** @type {any[]} */
      const liveSyncAccumulator = [];
      const regSyncOptions = {
        compatLayer: options.compatLayer,
        wineBinaryPath: options.wineBinaryPath || options.wineBinary,
        wineBinary: options.wineBinary || options.wineBinaryPath,
        skipLiveWineRegSync: options.skipLiveWineRegSync === true,
        wineserverActive: options.wineserverActive,
        execFileFn: options.execFileFn,
        execFileImpl: options.execFileImpl,
        liveSyncAccumulator,
      };
      const gsEntries = {
        ForceUseInprocGameSaves: { type: 'dword', value: 1 },
        State: { type: 'dword', value: 4 },
        CurrentVersion: { type: 'qword', value: XBOX_GAMING_SERVICES_PACKED_VERSION_QWORD },
        AvailableVersion: { type: 'qword', value: XBOX_GAMING_SERVICES_PACKED_VERSION_QWORD },
        InstallPath: 'C:\\Windows\\System32',
      };
      const winebusEntries = { DisableHidraw: { type: 'dword', value: 1 } };
      const dllOverrideEntries = {
        xgameruntime: 'native,builtin',
        gameinput: 'native,builtin',
        gameinputredist: 'native,builtin',
        'api-ms-win-core-psm-appnotify-l1-1-0': 'native,builtin',
        concrt140: 'native,builtin',
      };

      upsertWineSystemRegKeysBatch(
        resolvedBottle,
        [
          { subKeyPath: 'Software\\Microsoft\\GamingServices', entries: gsEntries },
          { subKeyPath: 'Software\\Wow6432Node\\Microsoft\\GamingServices', entries: gsEntries },
          { subKeyPath: 'System\\CurrentControlSet\\Services\\winebus', entries: winebusEntries },
        ],
        regSyncOptions
      );
      upsertWineUserRegKey(
        resolvedBottle,
        'Software\\Wine\\DllOverrides',
        dllOverrideEntries,
        regSyncOptions
      );

      if (liveSyncAccumulator.length > 0 && options.skipLiveWineRegSync !== true) {
        await flushLiveWineRegistryAccumulator(
          resolvedBottle,
          liveSyncAccumulator,
          regSyncOptions
        ).catch(() => {});
      }
    } catch (err) {
      diagLog.warn('wine.xboxRegistryUpsertFailed', err, { resolvedBottle });
    }
  }

  let bottleUser = 'crossover';
  let bottleUsersDir = resolvedBottle ? path.join(resolvedBottle, 'drive_c', 'users') : '';
  let appDataLocal = '';
  let packageRootDir = '';
  let systemAppDataDir = '';
  let wgsRootDir = '';
  let xgsRootDir = '';
  let wgsUserDir = '';
  let xgsUserDir = '';

  if (resolvedBottle) {
    const shellFolders = readWinePrefixShellFolders(resolvedBottle);
    bottleUser = shellFolders.wineUser || 'crossover';
    bottleUsersDir = shellFolders.usersDir || path.join(resolvedBottle, 'drive_c', 'users');
    appDataLocal =
      shellFolders.appDataLocal ||
      path.join(bottleUsersDir, bottleUser, 'AppData', 'Local');

    const pfn = String(options.packageFamilyName || '').trim();
    if (pfn && !/[\\/:*?"<>|]/.test(pfn) && !pfn.includes('..')) {
      packageRootDir = path.join(appDataLocal, 'Packages', pfn);
      systemAppDataDir = path.join(packageRootDir, 'SystemAppData');
      wgsRootDir = path.join(systemAppDataDir, 'wgs');
      xgsRootDir = path.join(systemAppDataDir, 'xgs');
      await Promise.all([
        fs.promises.mkdir(path.join(wgsRootDir, 't'), { recursive: true }),
        fs.promises.mkdir(xgsRootDir, { recursive: true }),
        fs.promises.mkdir(path.join(packageRootDir, 'LocalState'), { recursive: true }),
        fs.promises.mkdir(path.join(packageRootDir, 'TempState'), { recursive: true }),
        fs.promises.mkdir(path.join(packageRootDir, 'AC'), { recursive: true }),
        fs.promises.mkdir(path.join(packageRootDir, 'Settings'), { recursive: true }),
      ]);
      const userScidFolder = formatBottleWgsUserFolder(options.xuid, options.scid);
      if (userScidFolder) {
        wgsUserDir = path.join(wgsRootDir, userScidFolder);
        xgsUserDir = path.join(xgsRootDir, userScidFolder);
        await Promise.all([
          fs.promises.mkdir(wgsUserDir, { recursive: true }),
          fs.promises.mkdir(xgsUserDir, { recursive: true }),
        ]);
      }
    } else {
      await fs.promises.mkdir(appDataLocal, { recursive: true });
    }
  }

  return {
    provisioned: Boolean(resolvedBottle),
    bridgeDllPath,
    bridgeStaged,
    gameInputBridgeDllPath,
    gameInputStaged,
    appNotifyBridgeDllPath,
    appNotifyStaged,
    bridgeX86DllPath,
    bridgeX86Staged,
    gameInputBridgeX86DllPath,
    gameInputX86Staged,
    appNotifyBridgeX86DllPath,
    appNotifyX86Staged,
    system32DllPath,
    system32AppNotifyDllPath,
    syswow64DllPath,
    syswow64AppNotifyDllPath,
    backedUpLocalDlls,
    stagedLocalFiles,
    stagedVcLibsAppDlls,
    stagedVcLibsSyswow64Dlls,
    bottleUser,
    bottleUsersDir,
    appDataLocal,
    packageRootDir,
    systemAppDataDir,
    wgsRootDir,
    xgsRootDir,
    wgsUserDir,
    xgsUserDir,
    env,
  };
}

module.exports = {
  XGR_BRIDGE_MARKER,
  XGR_STAGED_MANIFEST_FILENAME,
  DEFAULT_XBOX_DLL_SEARCH_MAX_DEPTH,
  XBOX_DEFAULT_WINE_DLL_OVERRIDES,
  findFilesMatching,
  unescapeWineRegString,
  resolveDriveCPathCaseInsensitive,
  readWinePrefixShellFolders,
  resolveBottleSteamExe,
  sandboxWinePrefixUserFolders,
  sandboxWinePrefixUserFoldersAsync,
  resolveXboxBridgeDllPath,
  resolveBundledXboxRuntimeBridgeDllPath: resolveXboxBridgeDllPath,
  resolveXboxBridgeX86DllPath,
  resolveBundledXboxRuntimeBridgeX86DllPath: resolveXboxBridgeX86DllPath,
  resolveBundledGameInputBridgeDllPath,
  resolveBundledXboxGameInputBridgeDllPath: resolveBundledGameInputBridgeDllPath,
  resolveBundledGameInputBridgeX86DllPath,
  resolveBundledXboxGameInputBridgeX86DllPath: resolveBundledGameInputBridgeX86DllPath,
  resolveBundledXboxAppNotifyBridgeDllPath,
  resolveBundledXboxAppNotifyBridgeX86DllPath,
  resolveBundledXboxWinLauncherExePath,
  resolveBundledXboxWinLauncherX86ExePath,
  readVerifiedBridgeDllBuffer,
  inspectPeBinaryImportsSync,
  resolveLauncherSettingsChildExecutable,
  stageWindowsClientlessXboxBridgeDlls,
  restoreWindowsClientlessXboxBridgeDlls,
  upsertWineUserRegKey,
  upsertWineUserRegKeysBatch,
  isCrossOverPerlWineWrapperOptions,
  deriveCrossOverRootPath,
  applyCrossOverEnvironmentHygiene,
  sanitizeProvisionedBottleGraphicsBackend,
  applyStrictRosettaAvxEnv,
  mergeWineDllOverrides,
  prepareXboxBottleEnvironment,
};
