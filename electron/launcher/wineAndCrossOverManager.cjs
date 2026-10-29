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

/**
 * Resolves the bundled 64-bit PE `one_xgameruntime_bridge.dll` across dev, unpacked ASAR, and test overrides.
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function resolveXboxBridgeDllPath(options = {}) {
  const customOverride =
    options?.xboxBridgeDllPath ||
    options?.xboxRuntimeBridgeDllPath ||
    process.env.ONE_LAUNCHER_XBOX_BRIDGE_DLL ||
    '';
  if (typeof customOverride === 'string' && customOverride.trim()) {
    const custom = customOverride.trim();
    if (fs.existsSync(custom)) return custom;
  }

  const unpackedDir = __dirname.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1');
  const candidates = [
    path.join(unpackedDir, '..', 'helpers', 'bin', 'one_xgameruntime_bridge.dll'),
    process.resourcesPath
      ? path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'electron',
          'helpers',
          'bin',
          'one_xgameruntime_bridge.dll'
        )
      : '',
    process.resourcesPath
      ? path.join(process.resourcesPath, 'helpers', 'bin', 'one_xgameruntime_bridge.dll')
      : '',
    path.join(__dirname, '..', 'helpers', 'bin', 'one_xgameruntime_bridge.dll'),
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
 * Resolves the bundled 64-bit PE `one_gameinput_bridge.dll` across dev, unpacked ASAR, and test overrides.
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function resolveBundledGameInputBridgeDllPath(options = {}) {
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

  const unpackedDir = __dirname.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1');
  const candidates = [
    path.join(unpackedDir, '..', 'helpers', 'bin', 'one_gameinput_bridge.dll'),
    process.resourcesPath
      ? path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'electron',
          'helpers',
          'bin',
          'one_gameinput_bridge.dll'
        )
      : '',
    process.resourcesPath
      ? path.join(process.resourcesPath, 'helpers', 'bin', 'one_gameinput_bridge.dll')
      : '',
    path.join(__dirname, '..', 'helpers', 'bin', 'one_gameinput_bridge.dll'),
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
 * Resolves the bundled 64-bit PE `one_appnotify_bridge.dll` (`api-ms-win-core-psm-appnotify-l1-1-0.dll`)
 * across env overrides, unpacked ASAR, and dev paths, returning `null` gracefully if absent.
 *
 * @param {Record<string, any>} [options]
 * @returns {string | null}
 */
function resolveBundledXboxAppNotifyBridgeDllPath(options = {}) {
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

  const unpackedDir = __dirname.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1');
  const candidates = [
    path.join(unpackedDir, '..', 'helpers', 'bin', 'one_appnotify_bridge.dll'),
    process.resourcesPath
      ? path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'electron',
          'helpers',
          'bin',
          'one_appnotify_bridge.dll'
        )
      : '',
    process.resourcesPath
      ? path.join(process.resourcesPath, 'helpers', 'bin', 'one_appnotify_bridge.dll')
      : '',
    path.join(__dirname, '..', 'helpers', 'bin', 'one_appnotify_bridge.dll'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }
  return null;
}

/**
 * Resolves the bundled 64-bit PE `one_xgr_win_launcher.exe` helper for clientless Windows GDK
 * launches (`LOAD_LIBRARY_SEARCH_SYSTEM32` preloader), returning `null` gracefully if absent.
 *
 * @param {Record<string, any>} [options]
 * @returns {string | null}
 */
function resolveBundledXboxWinLauncherExePath(options = {}) {
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

  const unpackedDir = __dirname.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1');
  const candidates = [
    path.join(unpackedDir, '..', 'helpers', 'bin', 'one_xgr_win_launcher.exe'),
    process.resourcesPath
      ? path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'electron',
          'helpers',
          'bin',
          'one_xgr_win_launcher.exe'
        )
      : '',
    process.resourcesPath
      ? path.join(process.resourcesPath, 'helpers', 'bin', 'one_xgr_win_launcher.exe')
      : '',
    path.join(__dirname, '..', 'helpers', 'bin', 'one_xgr_win_launcher.exe'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }
  return null;
}

/**
 * Atomically upserts a key and string/dword values inside `<bottleDir>/user.reg`.
 * @param {string} bottleDir
 * @param {string} keyPath
 * @param {Array<[string, any]> | Record<string, any>} valuesObj
 * @param {Record<string, any>} [options]
 */
function upsertWineUserRegKey(bottleDir, keyPath, valuesObj, options = {}) {
  const regFilePath =
    typeof options.regFilePath === 'string' && options.regFilePath
      ? options.regFilePath
      : bottleDir
        ? path.join(bottleDir, 'user.reg')
        : '';
  if (!regFilePath || !keyPath) {
    return { updated: false, regFilePath: '' };
  }
  let hasNonEmptyHeader = false;
  if (fs.existsSync(regFilePath)) {
    try {
      hasNonEmptyHeader = Boolean(fs.readFileSync(regFilePath, 'utf8').trim());
    } catch {
      hasNonEmptyHeader = false;
    }
  }
  if (!hasNonEmptyHeader) {
    fs.mkdirSync(path.dirname(regFilePath), { recursive: true });
    fs.writeFileSync(
      regFilePath,
      'WINE REGISTRY Version 2\n;; All keys relative to \\\\User\\\\S-1-5-21-0-0-0-1000\n\n#arch=win64\n',
      'utf8'
    );
  }
  const { upsertWineSystemRegKey } = require('./firstPartyRegistration.cjs');
  return upsertWineSystemRegKey(bottleDir, keyPath, valuesObj, {
    ...options,
    regFilePath,
  });
}

/**
 * Enforces Apple Rosetta AVX environment variable semantics:
 * Rosetta checks `getenv("ROSETTA_ADVERTISE_AVX") != NULL`, so `'0'` MUST NEVER be set;
 * when disabled, the variable is strictly deleted from `env`.
 * @param {Record<string, any>} [env]
 * @param {boolean|string|number} [advertiseAvx]
 */
function applyStrictRosettaAvxEnv(env = {}, advertiseAvx = undefined) {
  if (!env || typeof env !== 'object') return env;
  if (advertiseAvx === true || advertiseAvx === '1' || advertiseAvx === 1) {
    env.ROSETTA_ADVERTISE_AVX = '1';
  } else if (
    advertiseAvx === false ||
    advertiseAvx === '0' ||
    advertiseAvx === 0 ||
    env.ROSETTA_ADVERTISE_AVX === '0' ||
    env.ROSETTA_ADVERTISE_AVX === ''
  ) {
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
    const sidecarPath = `${dllPath}.sha256`;
    let sidecarVerified = false;
    try {
      if (fs.existsSync(sidecarPath)) {
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

/**
 * Stages SHA-256-verified `Xgameruntime.dll`, `GameInput.dll`, and `GameInputRedist.dll` into
 * a Windows clientless `xbox-msixvc-win` game directory (backing up any original Microsoft DLLs to
 * `.msft.bak` and automatically upgrading any outdated One Launcher bridge DLLs on SHA-256 mismatch).
 *
 * @param {Record<string, any>} [options]
 */
async function stageWindowsClientlessXboxBridgeDlls(options = {}) {
  const bridgeDllPath = resolveXboxBridgeDllPath(options);
  const gameInputBridgeDllPath = resolveBundledGameInputBridgeDllPath(options);
  const [bridgeVerified, gameInputVerified] = await Promise.all([
    readVerifiedBridgeDllBuffer(bridgeDllPath, options),
    readVerifiedBridgeDllBuffer(gameInputBridgeDllPath, options),
  ]);
  const bridgeBuf = bridgeVerified.buf;
  const bridgeHash = bridgeVerified.sha256;
  const gameInputBuf = gameInputVerified.buf;
  const gameInputHash = gameInputVerified.sha256;

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
  let primaryExeDir = '';
  if (typeof options.executablePath === 'string' && options.executablePath.trim()) {
    primaryExeDir = path.dirname(path.resolve(options.executablePath.trim()));
    candidateDirs.add(primaryExeDir);
  } else if (resolvedInstallRoot) {
    primaryExeDir = resolvedInstallRoot;
  }

  const xgrMarkerBuf = Buffer.from(XGR_BRIDGE_MARKER, 'utf8');
  const genericOneLauncherMarkerBuf = Buffer.from('OneLauncher.', 'utf8');
  /** @type {Array<{ localDllPath: string, backupPath: string }>} */
  const backedUpLocalDlls = [];
  /** @type {string[]} */
  const stagedLocalFiles = [];
  let bridgeStaged = false;
  let gameInputStaged = false;
  let primaryXgameruntimeDllPath = primaryExeDir
    ? path.join(primaryExeDir, 'xgameruntime.dll')
    : '';

  for (const dirPath of candidateDirs) {
    try {
      if (!fs.existsSync(dirPath)) continue;
      const entries = await fs.promises.readdir(dirPath);
      for (const entryName of entries) {
        const lowerName = entryName.toLowerCase();
        if (lowerName === 'xgameruntime.dll' && bridgeBuf) {
          const localDllPath = path.join(dirPath, entryName);
          const existingBuf = await fs.promises.readFile(localDllPath);
          const existingHash = sha256Buffer(existingBuf).toLowerCase();
          if (
            existingHash !== bridgeHash &&
            !existingBuf.includes(xgrMarkerBuf) &&
            !existingBuf.includes(genericOneLauncherMarkerBuf)
          ) {
            const backupPath = `${localDllPath}.msft.bak`;
            if (!fs.existsSync(backupPath)) {
              await fs.promises.writeFile(backupPath, existingBuf);
            }
            backedUpLocalDlls.push({ localDllPath, backupPath });
          }
          await copyBufferIfChanged(localDllPath, bridgeBuf, bridgeHash);
          stagedLocalFiles.push(localDllPath);
          if (primaryExeDir && path.resolve(dirPath) === path.resolve(primaryExeDir)) {
            primaryXgameruntimeDllPath = localDllPath;
          }
          bridgeStaged = true;
        } else if (
          gameInputBuf &&
          (lowerName === 'gameinput.dll' || lowerName === 'gameinputredist.dll')
        ) {
          const localDllPath = path.join(dirPath, entryName);
          const existingBuf = await fs.promises.readFile(localDllPath);
          const existingHash = sha256Buffer(existingBuf).toLowerCase();
          if (
            existingHash !== gameInputHash &&
            !existingBuf.includes(genericOneLauncherMarkerBuf)
          ) {
            const backupPath = `${localDllPath}.msft.bak`;
            if (!fs.existsSync(backupPath)) {
              await fs.promises.writeFile(backupPath, existingBuf);
            }
            backedUpLocalDlls.push({ localDllPath, backupPath });
          }
          await copyBufferIfChanged(localDllPath, gameInputBuf, gameInputHash);
          stagedLocalFiles.push(localDllPath);
          gameInputStaged = true;
        }
      }
    } catch (err) {
      diagLog.warn('wine.stageWinClientlessXboxBridgeFailed', err, { dirPath });
    }
  }

  // Ensure primary executable directory always has app-local bridge DLLs on Win32 clientless launches
  if (primaryExeDir && fs.existsSync(primaryExeDir)) {
    try {
      const existingNames = await fs.promises.readdir(primaryExeDir).catch(() => []);
      const findCaseMatch = (/** @type {string} */ targetLower, /** @type {string} */ defaultName) =>
        existingNames.find((n) => n.toLowerCase() === targetLower) || defaultName;
      if (bridgeBuf) {
        const targetXgr = path.join(
          primaryExeDir,
          findCaseMatch('xgameruntime.dll', 'xgameruntime.dll')
        );
        await copyBufferIfChanged(targetXgr, bridgeBuf, bridgeHash);
        primaryXgameruntimeDllPath = targetXgr;
        stagedLocalFiles.push(targetXgr);
        bridgeStaged = true;
      }
      if (gameInputBuf) {
        const targetGi = path.join(primaryExeDir, findCaseMatch('gameinput.dll', 'GameInput.dll'));
        const targetGir = path.join(
          primaryExeDir,
          findCaseMatch('gameinputredist.dll', 'GameInputRedist.dll')
        );
        await copyBufferIfChanged(targetGi, gameInputBuf, gameInputHash);
        await copyBufferIfChanged(targetGir, gameInputBuf, gameInputHash);
        stagedLocalFiles.push(targetGi, targetGir);
        gameInputStaged = true;
      }
    } catch (err) {
      diagLog.warn('wine.stagePrimaryExeBridgeFailed', err, { primaryExeDir });
    }
  }

  if (resolvedInstallRoot || primaryExeDir) {
    await writeStagedLocalBridgeManifest(
      resolvedInstallRoot || primaryExeDir,
      stagedLocalFiles,
      backedUpLocalDlls
    );
  }

  return {
    bridgeDllPath,
    bridgeStaged,
    gameInputBridgeDllPath,
    gameInputStaged,
    primaryExeDir,
    primaryXgameruntimeDllPath,
    backedUpLocalDlls,
    stagedLocalFiles,
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
  applyStrictRosettaAvxEnv(env, options.advertiseAvx);

  const bridgeDllPath = resolveXboxBridgeDllPath(options);
  const gameInputBridgeDllPath = resolveBundledGameInputBridgeDllPath(options);
  const appNotifyBridgeDllPath = resolveBundledXboxAppNotifyBridgeDllPath(options);
  const [bridgeVerified, gameInputVerified, appNotifyVerified] = await Promise.all([
    readVerifiedBridgeDllBuffer(bridgeDllPath, options),
    readVerifiedBridgeDllBuffer(gameInputBridgeDllPath, options),
    appNotifyBridgeDllPath
      ? readVerifiedBridgeDllBuffer(appNotifyBridgeDllPath, options)
      : Promise.resolve({ buf: null, sha256: '', sidecarVerified: false }),
  ]);
  const bridgeBuf = bridgeVerified.buf;
  const bridgeHash = bridgeVerified.sha256;
  const gameInputBuf = gameInputVerified.buf;
  const gameInputHash = gameInputVerified.sha256;
  const appNotifyBuf = appNotifyVerified.buf;
  const appNotifyHash = appNotifyVerified.sha256;

  let system32DllPath = '';
  let system32AppNotifyDllPath = '';
  let bridgeStaged = false;
  let gameInputStaged = false;
  let appNotifyStaged = false;
  /** @type {Array<{ localDllPath: string, backupPath: string }>} */
  const backedUpLocalDlls = [];
  /** @type {string[]} */
  const stagedLocalFiles = [];
  const stagedVcLibsAppDlls = [];

  if (resolvedBottle) {
    const driveC = path.join(resolvedBottle, 'drive_c');
    await fs.promises.mkdir(driveC, { recursive: true });
    const system32Dir = resolveDriveCPathCaseInsensitive(driveC, ['windows', 'system32']);
    await fs.promises.mkdir(system32Dir, { recursive: true });
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

    // Provision UWP VCLibs *_app.dll CRT aliases from bottle system32 or CrossOver/Wine x86_64-windows donor DLLs
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
      const compatBinPath = String(
        options.compatLayer?.binaryPath || options.wineBinaryPath || ''
      ).trim();
      const extraWineWin64Dirs = compatBinPath
        ? [
            path.resolve(path.dirname(compatBinPath), '..', 'lib', 'wine', 'x86_64-windows'),
            path.resolve(path.dirname(compatBinPath), '..', 'lib64', 'wine', 'x86_64-windows'),
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
    } catch (err) {
      diagLog.warn('wine.provisionVcLibsAppDllsFailed', err, { system32Dir });
    }

    // Back up and replace any game-local Microsoft xgameruntime.dll, GameInput/GameInputRedist.dll,
    // and api-ms-win-core-psm-appnotify-l1-1-0.dll (up to depth 8)
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
    if (typeof options.executablePath === 'string' && options.executablePath.trim()) {
      candidateDirs.add(path.dirname(path.resolve(options.executablePath.trim())));
    }

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
            const existingHash = sha256Buffer(existingBuf).toLowerCase();
            if (
              existingHash !== bridgeHash &&
              !existingBuf.includes(xgrMarkerBuf) &&
              !existingBuf.includes(genericOneLauncherMarkerBuf)
            ) {
              const backupPath = `${localDllPath}.msft.bak`;
              if (!fs.existsSync(backupPath)) {
                await fs.promises.writeFile(backupPath, existingBuf);
              }
              backedUpLocalDlls.push({ localDllPath, backupPath });
            }
            if (bridgeBuf) {
              await copyBufferIfChanged(localDllPath, bridgeBuf, bridgeHash);
              stagedLocalFiles.push(localDllPath);
            }
          } else if (
            gameInputBuf &&
            (lowerName === 'gameinput.dll' || lowerName === 'gameinputredist.dll')
          ) {
            const localDllPath = path.join(dirPath, entryName);
            const existingBuf = await fs.promises.readFile(localDllPath);
            if (
              sha256Buffer(existingBuf).toLowerCase() !== gameInputHash &&
              !existingBuf.includes(genericOneLauncherMarkerBuf)
            ) {
              const backupPath = `${localDllPath}.msft.bak`;
              if (!fs.existsSync(backupPath)) {
                await fs.promises.writeFile(backupPath, existingBuf);
              }
              backedUpLocalDlls.push({ localDllPath, backupPath });
            }
            await copyBufferIfChanged(localDllPath, gameInputBuf, gameInputHash);
            stagedLocalFiles.push(localDllPath);
          } else if (appNotifyBuf && lowerName === 'api-ms-win-core-psm-appnotify-l1-1-0.dll') {
            const localDllPath = path.join(dirPath, entryName);
            const existingBuf = await fs.promises.readFile(localDllPath);
            if (
              sha256Buffer(existingBuf).toLowerCase() !== appNotifyHash &&
              !existingBuf.includes(genericOneLauncherMarkerBuf)
            ) {
              const backupPath = `${localDllPath}.msft.bak`;
              if (!fs.existsSync(backupPath)) {
                await fs.promises.writeFile(backupPath, existingBuf);
              }
              backedUpLocalDlls.push({ localDllPath, backupPath });
            }
            await copyBufferIfChanged(localDllPath, appNotifyBuf, appNotifyHash);
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
        upsertWineSystemRegKey,
        isBottleWineserverActive,
        syncLiveWineRegistryAsync,
      } = require('./firstPartyRegistration.cjs');
      const regSyncOptions = {
        compatLayer: options.compatLayer,
        wineBinaryPath: options.wineBinaryPath,
        skipLiveWineRegSync: true,
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

      upsertWineSystemRegKey(
        resolvedBottle,
        'Software\\Microsoft\\GamingServices',
        gsEntries,
        regSyncOptions
      );
      upsertWineSystemRegKey(
        resolvedBottle,
        'Software\\Wow6432Node\\Microsoft\\GamingServices',
        gsEntries,
        regSyncOptions
      );
      upsertWineSystemRegKey(
        resolvedBottle,
        'System\\CurrentControlSet\\Services\\winebus',
        winebusEntries,
        regSyncOptions
      );
      upsertWineUserRegKey(
        resolvedBottle,
        'Software\\Wine\\DllOverrides',
        dllOverrideEntries,
        regSyncOptions
      );

      if (options.skipLiveWineRegSync !== true && isBottleWineserverActive(resolvedBottle, options)) {
        const liveOpts = {
          compatLayer: options.compatLayer,
          wineBinaryPath: options.wineBinaryPath,
          execFileFn: options.execFileFn,
          execFileImpl: options.execFileImpl,
        };
        await Promise.all([
          syncLiveWineRegistryAsync(
            resolvedBottle,
            'HKEY_LOCAL_MACHINE',
            'Software\\Microsoft\\GamingServices',
            Object.entries(gsEntries),
            liveOpts
          ),
          syncLiveWineRegistryAsync(
            resolvedBottle,
            'HKEY_LOCAL_MACHINE',
            'Software\\Wow6432Node\\Microsoft\\GamingServices',
            Object.entries(gsEntries),
            liveOpts
          ),
          syncLiveWineRegistryAsync(
            resolvedBottle,
            'HKEY_LOCAL_MACHINE',
            'System\\CurrentControlSet\\Services\\winebus',
            Object.entries(winebusEntries),
            liveOpts
          ),
          syncLiveWineRegistryAsync(
            resolvedBottle,
            'HKEY_CURRENT_USER',
            'Software\\Wine\\DllOverrides',
            Object.entries(dllOverrideEntries),
            liveOpts
          ),
        ]).catch(() => {});
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
    system32DllPath,
    system32AppNotifyDllPath,
    backedUpLocalDlls,
    stagedLocalFiles,
    stagedVcLibsAppDlls,
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
  resolveBundledGameInputBridgeDllPath,
  resolveBundledXboxGameInputBridgeDllPath: resolveBundledGameInputBridgeDllPath,
  resolveBundledXboxAppNotifyBridgeDllPath,
  resolveBundledXboxWinLauncherExePath,
  readVerifiedBridgeDllBuffer,
  stageWindowsClientlessXboxBridgeDlls,
  restoreWindowsClientlessXboxBridgeDlls,
  upsertWineUserRegKey,
  applyStrictRosettaAvxEnv,
  mergeWineDllOverrides,
  prepareXboxBottleEnvironment,
};
