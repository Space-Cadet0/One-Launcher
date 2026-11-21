// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const {
  computeAppxPublisherId,
  computePackageFamilyName,
  deriveDefaultScidFromTitleId,
  parseMicrosoftGameConfig,
  parseAppxManifest,
} = require('../../storefronts/xbox/msixvcXvdParser.cjs');
const {
  inspectWindowsExecutableHeader,
  isCompatibleX86OrX64PeHeader,
} = require('./peAndMachOInspector.cjs');

const XBOX_SYSTEM_OR_UTILITY_IDENTITY_RE =
  /^(?:Microsoft\.(?:GamingServices|GamingApp|XboxGamingOverlay|XboxGameOverlay|XboxIdentityProvider|XboxSpeechToTextOverlay|Xbox\.TCUI|WindowsStore|StorePurchaseApp|DesktopAppInstaller|UI\.|VCLibs|NET\.|DirectX|Services\.Store|Advertising|Wallet|SecHealthUI|WindowsTerminal)|Windows\.|System\.)/i;

/**
 * @param {string | undefined | null} identityName
 * @param {{ isFramework?: boolean, isResourcePackage?: boolean, isDlcAddon?: boolean, hasExecutable?: boolean }} [flags]
 * @returns {boolean}
 */
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

/**
 * @param {unknown} rawName
 * @returns {string}
 */
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
 * @param {Buffer | string} xmlOrPath
 * @param {string[]} candidateFileNames
 * @returns {{ xml: string, filePath: string, contentRootDir: string }}
 */
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
 *
 * @param {Buffer | string} input Buffer or path to `.GamingRoot`
 * @param {string} [driveRoot] Optional drive root (e.g. `D:\` or `/Volumes/Games`)
 */
function parseGamingRootFile(input, driveRoot = '') {
  try {
    /** @type {Buffer | null} */
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
      buf[3] !== 0x58 // 'X'
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
 * Parse a `launcher_settings.cfg` bootstrap configuration file (common in GOG / classic publisher
 * wrappers) and resolve its target game executable (`BinaryPath` + `LocalePath`) on disk.
 *
 * @param {string} installDirOrExePath
 * @param {string} [fallbackInstallDir]
 */
function parseLauncherSettingsCfg(installDirOrExePath, fallbackInstallDir = '') {
  const empty = {
    found: false,
    configPath: '',
    binaryPath: '',
    localePath: '',
    languages: '',
    isoLanguage: '',
    languagePathOnly: '',
    commandLineArgs: '',
    environmentVars: '',
    resolvedTargetExePath: '',
    resolvedWorkingDir: '',
  };
  /** @type {string[]} */
  const candidateDirs = [];
  /** @param {string} d */
  const pushDir = (d) => {
    if (d && typeof d === 'string' && !candidateDirs.includes(d)) {
      candidateDirs.push(d);
    }
  };
  if (installDirOrExePath && typeof installDirOrExePath === 'string') {
    const trimmed = installDirOrExePath.trim();
    if (/\.exe$/i.test(trimmed)) {
      pushDir(path.dirname(trimmed));
    } else {
      try {
        if (fs.existsSync(trimmed) && fs.statSync(trimmed).isFile()) {
          pushDir(path.dirname(trimmed));
        } else {
          pushDir(trimmed);
        }
      } catch {
        pushDir(trimmed);
      }
    }
  }
  if (fallbackInstallDir && typeof fallbackInstallDir === 'string') {
    pushDir(fallbackInstallDir.trim());
  }

  let cfgPath = '';
  let cfgDir = '';
  for (const dir of candidateDirs) {
    const foundCfg = resolveCaseInsensitiveRelFile(dir, 'launcher_settings.cfg');
    if (foundCfg) {
      cfgPath = foundCfg;
      cfgDir = path.dirname(foundCfg);
      break;
    }
  }
  if (!cfgPath) {
    return empty;
  }

  let rawText = '';
  try {
    const st = fs.statSync(cfgPath);
    if (!st.isFile() || st.size <= 0 || st.size > 131072) {
      return empty;
    }
    rawText = fs.readFileSync(cfgPath, 'utf8');
  } catch {
    return empty;
  }

  /** @type {Record<string, string>} */
  const kv = {};
  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) {
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const k = line.slice(0, eqIdx).trim().toLowerCase();
    const v = line
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (k && !(k in kv)) {
      kv[k] = v;
    }
  }

  const binaryPath = kv.binarypath || '';
  const localePath = kv.localepath || '';
  const languages = kv.languages || '';
  const isoLanguage = kv.iso_language || '';
  const languagePathOnly = kv.language_path_only || '';
  const commandLineArgs = kv.commandlineargs || '';
  const environmentVars = kv.environmentvars || '';

  let resolvedTargetExePath = '';
  if (binaryPath) {
    const relBin = binaryPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const rawLocale = localePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    /** @type {string[]} */
    const relCandidates = [];
    if (rawLocale && rawLocale !== '.' && rawLocale.toUpperCase() !== 'X') {
      relCandidates.push(`${rawLocale}/${relBin}`);
    }
    relCandidates.push(relBin);
    relCandidates.push(`EN/${relBin}`);
    if (languages) {
      for (const langTok of languages.split(/[,;\s]+/).filter(Boolean).slice(0, 12)) {
        if (/^[a-z]{2,3}(?:[-_][a-z0-9]{2,4})?$/i.test(langTok)) {
          relCandidates.push(`${langTok}/${relBin}`);
        }
      }
    }

    for (const cand of relCandidates) {
      const resolved = resolveCaseInsensitiveRelFile(cfgDir, cand);
      if (resolved) {
        resolvedTargetExePath = resolved;
        break;
      }
    }

    if (!resolvedTargetExePath) {
      try {
        const subEntries = fs.readdirSync(cfgDir, { withFileTypes: true }).slice(0, 48);
        for (const dirent of subEntries) {
          if (!dirent.isDirectory()) continue;
          if (!/^[a-z]{2,3}(?:[-_][a-z0-9]{2,4})?$/i.test(dirent.name)) continue;
          const resolved = resolveCaseInsensitiveRelFile(path.join(cfgDir, dirent.name), relBin);
          if (resolved) {
            resolvedTargetExePath = resolved;
            break;
          }
        }
      } catch {}
    }
  }

  return {
    found: true,
    configPath: cfgPath,
    binaryPath,
    localePath,
    languages,
    isoLanguage,
    languagePathOnly,
    commandLineArgs,
    environmentVars,
    resolvedTargetExePath,
    resolvedWorkingDir: resolvedTargetExePath ? path.dirname(resolvedTargetExePath) : '',
  };
}

/**
 * Structural Paradox Interactive `dowser.exe` + `launcher-settings.json` inspector.
 * Parses `exePath` from `launcher-settings.json`, strictly rejects `..` traversal or
 * paths escaping `installDir`, and resolves `paradoxDirectGameExe` on disk (case-insensitively).
 *
 * @param {string} installDirOrExePath
 * @param {string} [fallbackInstallDir='']
 * @returns {{
 *   found: boolean,
 *   settingsPath: string,
 *   rawExePath: string,
 *   paradoxDirectGameExe: string | null,
 *   exeArgs: string[],
 *   distPlatform: string
 * }}
 */
function resolveParadoxLauncherSettings(installDirOrExePath, fallbackInstallDir = '') {
  const empty = {
    found: false,
    settingsPath: '',
    rawExePath: '',
    paradoxDirectGameExe: null,
    exeArgs: /** @type {string[]} */ ([]),
    distPlatform: '',
  };
  const primaryInput = typeof installDirOrExePath === 'string' ? installDirOrExePath.trim() : '';
  const fallbackInput = typeof fallbackInstallDir === 'string' ? fallbackInstallDir.trim() : '';
  if (!primaryInput && !fallbackInput) {
    return empty;
  }

  let primaryDir = '';
  let primaryIsExe = false;
  if (primaryInput) {
    try {
      const st = fs.statSync(primaryInput);
      if (st.isDirectory()) {
        primaryDir = primaryInput;
      } else {
        primaryDir = path.dirname(primaryInput);
        primaryIsExe = /\.exe$/i.test(primaryInput);
      }
    } catch {
      primaryIsExe = /\.exe$/i.test(primaryInput);
      primaryDir = primaryIsExe ? path.dirname(primaryInput) : primaryInput;
    }
  }

  let containmentRoot = fallbackInput;
  if (!containmentRoot && primaryDir) {
    if (
      primaryIsExe &&
      /^dowser\.exe$/i.test(path.basename(primaryInput)) &&
      /^launcher$/i.test(path.basename(primaryDir))
    ) {
      containmentRoot = path.dirname(primaryDir);
    } else {
      containmentRoot = primaryDir;
    }
  }
  if (!containmentRoot) {
    return empty;
  }
  const resolvedContainmentRoot = path.resolve(containmentRoot);

  /** @type {string[]} */
  const candidateSettingsPaths = [];
  const addSettingsCandidate = (/** @type {string | null | undefined} */ p) => {
    if (!p || typeof p !== 'string') return;
    const resolved = path.resolve(p);
    const rel = path.relative(resolvedContainmentRoot, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    if (!candidateSettingsPaths.includes(resolved)) {
      candidateSettingsPaths.push(resolved);
    }
  };

  if (primaryDir) {
    addSettingsCandidate(resolveCaseInsensitiveRelFile(primaryDir, 'launcher-settings.json'));
    addSettingsCandidate(
      resolveCaseInsensitiveRelFile(primaryDir, 'launcher/launcher-settings.json')
    );
  }
  addSettingsCandidate(
    resolveCaseInsensitiveRelFile(resolvedContainmentRoot, 'launcher-settings.json')
  );
  addSettingsCandidate(
    resolveCaseInsensitiveRelFile(resolvedContainmentRoot, 'launcher/launcher-settings.json')
  );

  for (const settingsPath of candidateSettingsPaths) {
    /** @type {any} */
    let parsed = null;
    try {
      const st = fs.statSync(settingsPath);
      if (!st.isFile() || st.size <= 0 || st.size > 262144) continue;
      parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;

    const rawExePath = typeof parsed.exePath === 'string' ? parsed.exePath.trim() : '';
    if (!rawExePath || rawExePath.includes('\0')) continue;
    if (/^[A-Za-z]:/.test(rawExePath) || /^[\\/]/.test(rawExePath)) continue;

    const normalizedRel = rawExePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!normalizedRel || !/\.exe$/i.test(normalizedRel)) continue;

    const settingsDir = path.dirname(settingsPath);
    /** @type {string[]} */
    const safeRelCandidates = [];
    for (const baseDir of [settingsDir, resolvedContainmentRoot]) {
      const candidateAbs = path.resolve(baseDir, normalizedRel);
      const relToRoot = path.relative(resolvedContainmentRoot, candidateAbs);
      if (!relToRoot || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
        continue;
      }
      const posixRel = relToRoot.split(path.sep).join('/');
      if (
        posixRel &&
        !posixRel.split('/').includes('..') &&
        !safeRelCandidates.includes(posixRel)
      ) {
        safeRelCandidates.push(posixRel);
      }
    }

    let resolvedExeCandidate = '';
    for (const safeRel of safeRelCandidates) {
      const match = resolveCaseInsensitiveRelFile(resolvedContainmentRoot, safeRel);
      if (match) {
        resolvedExeCandidate = match;
        break;
      }
    }
    if (!resolvedExeCandidate) continue;

    const resolvedExeAbs = path.resolve(resolvedExeCandidate);
    const relToInstall = path.relative(resolvedContainmentRoot, resolvedExeAbs);
    if (!relToInstall || relToInstall.startsWith('..') || path.isAbsolute(relToInstall)) {
      continue;
    }
    if (/^dowser\.exe$/i.test(path.basename(resolvedExeAbs))) {
      continue;
    }

    /** @type {string[]} */
    const exeArgs = Array.isArray(parsed.exeArgs)
      ? parsed.exeArgs
          .filter((/** @type {any} */ a) => typeof a === 'string' && a.trim())
          .map((/** @type {string} */ a) => a.trim())
      : typeof parsed.exeArgs === 'string' && parsed.exeArgs.trim()
        ? parsed.exeArgs.trim().split(/\s+/)
        : [];
    const distPlatform =
      typeof parsed.distPlatform === 'string' ? parsed.distPlatform.trim() : '';

    return {
      found: true,
      settingsPath,
      rawExePath,
      paradoxDirectGameExe: resolvedExeAbs,
      exeArgs,
      distPlatform,
    };
  }

  return empty;
}

const ANTI_CHEAT_PRIORITY_DIR_RE =
  /^(?:battleye|easyanticheat|easyanticheat_eos|eac|anticheatexpert|ace|gameguard|xigncode|xigncode3|vanguard|ricochet|denuvo|javelin|eaanticheat|anticheat|binaries|bin|win64|win32|x64|x86|system|launcher|redist|redistributables|rockstar(?: games)?)$/i;

const ANTI_CHEAT_SKIP_DIR_RE =
  /^(?:\.git|\.spotlight-v100|\.fseventsd|node_modules|__macosx|shaders|textures|audio|sound|sounds|movies|videos|localization|locales|paks|assets|maps|levels|meshes|materials)$/i;

const ANTI_CHEAT_INTERESTING_FILE_EXT_RE = /\.(?:sys|exe|des|xem|dll|rpf|cfg|ini)$/i;

const STORY_BOOTSTRAPPER_RE = /^play(?!er\.exe$|fab)[a-z0-9_.-]+\.exe$/i;

const GENERIC_NON_STORY_PLAY_EXE_RE =
  /^play(?:launcher|game|online|multiplayer|now|setup|settings|config|client|updater|installer|helper|service|server|manager|app|tool|utility|demo|test|er|fab)(?:[_.-].*)?\.exe$/i;

const ROCKSTAR_TITLE_OR_INSTALL_MARKER_RE =
  /(?:rockstar|socialclub|gtav|gta5|rdr2|red\s*dead|playgtav\.exe|playrdr2\.exe|gtavlauncher\.exe|gta5_be\.exe|gta5_enhanced\.exe)/i;

const ROCKSTAR_ARCHIVE_MARKER_RE = /^(?:update|common|x64[a-z]|dlc)\.rpf$/i;

const NON_ROCKSTAR_PUBLISHER_MARKER_RE =
  /^(?:uplay|ubisoft|upc\.exe|eaanticheat|eadesktop|link2ea|originclient|riotclient|vanguard|blizzard|battle\.net)/i;

/**
 * Bounded read-only structural scan (`depth <= 4`, subdirectory-prioritized BFS, `0` mutations)
 * for Windows kernel-mode anti-cheat drivers and services inside a game installation directory:
 * - Riot Vanguard (`vgk.sys`, `vgc.exe`)
 * - RICOCHET Anti-Cheat (`randgrid.sys`)
 * - EA Javelin Anti-Cheat (`EAAntiCheat.GameServiceLauncher.exe`, `EAAntiCheat.Installer.exe`, `EAAntiCheat.sys`)
 * - EasyAntiCheat (`EasyAntiCheat_EOS.sys`, `EasyAntiCheat.sys`, `EasyAntiCheat.exe`, `EasyAntiCheat_EOS.exe`)
 * - nProtect GameGuard (`GameMon.des`, `npggNT.des`, `GameGuard.des`)
 * - XIGNCODE3 (`xhunter1.sys`, `x3.xem`)
 * - Denuvo Anti-Cheat (`denuvo-anti-cheat.sys`)
 * - Tencent ACE (`ACE-BASE.sys`, `AntiCheatExpert`)
 * - BattlEye (`BEService_x64.exe`, `BEService.exe`, `BEDaisy.sys`) — sets
 *   `storyModeBypassAvailable: true` and `requiresKernelAntiCheat: false` ONLY for a valid PE
 *   root-level (`depth === 0`) non-generic `Play*.exe` Story Mode bootstrapper when no non-Rockstar
 *   publisher markers are present (and requiring Rockstar markers when
 *   `options.requireRockstarMarkersForStoryBypass === true`).
 *
 * @param {string} installDir
 * @param {{ requireRockstarMarkersForStoryBypass?: boolean }} [options]
 * @returns {{
 *   requiresKernelAntiCheat: boolean,
 *   kernelAntiCheatName: string | null,
 *   storyModeBypassAvailable: boolean
 * }}
 */
function detectKernelAntiCheatMarkersInDir(installDir, options = {}) {
  const defaultResult = {
    requiresKernelAntiCheat: false,
    kernelAntiCheatName: null,
    storyModeBypassAvailable: false,
  };
  if (!installDir || typeof installDir !== 'string') {
    return defaultResult;
  }
  const rootDir = installDir.trim();
  if (!rootDir) {
    return defaultResult;
  }
  try {
    const st = fs.statSync(rootDir);
    if (!st.isDirectory()) {
      return defaultResult;
    }
  } catch {
    return defaultResult;
  }

  let foundVanguard = false;
  let foundRicochet = false;
  let foundEaJavelin = false;
  let foundEasyAntiCheat = false;
  let foundGameGuard = false;
  let foundXigncode3 = false;
  let foundDenuvoAntiCheat = false;
  let foundTencentAce = false;
  let foundBattlEye = false;
  /** @type {string[]} */
  const rootPlayBootstrapperPaths = [];
  let hasRockstarMarker = ROCKSTAR_TITLE_OR_INSTALL_MARKER_RE.test(rootDir);
  let hasNonRockstarPublisherMarker = false;

  const MAX_DEPTH = 4;
  const MAX_DIRS_VISITED = 180;
  const MAX_FILES_PER_DIR = 512;
  let remainingFileBudget = 2400;
  let dirsVisited = 0;

  /** @type {Array<{ dir: string, depth: number }>} */
  const priorityQueue = [{ dir: rootDir, depth: 0 }];
  /** @type {Array<{ dir: string, depth: number }>} */
  const normalQueue = [];

  while ((priorityQueue.length > 0 || normalQueue.length > 0) && dirsVisited < MAX_DIRS_VISITED) {
    const current = priorityQueue.length > 0 ? priorityQueue.shift() : normalQueue.shift();
    if (!current) break;
    dirsVisited += 1;

    /** @type {fs.Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    // Pass 1: Enqueue subdirectories FIRST so loose asset files at depth 0/1 can never starve
    // anti-cheat subdirectory traversal (`BattlEye/`, `EasyAntiCheat/`, `AntiCheatExpert/`, etc.).
    if (current.depth < MAX_DEPTH) {
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (!entry || entry.name === '.' || entry.name === '..' || !entry.isDirectory()) continue;
        const lower = entry.name.toLowerCase();
        if (lower === 'anticheatexpert') {
          foundTencentAce = true;
        }
        if (ROCKSTAR_TITLE_OR_INSTALL_MARKER_RE.test(lower)) {
          hasRockstarMarker = true;
        }
        if (NON_ROCKSTAR_PUBLISHER_MARKER_RE.test(lower)) {
          hasNonRockstarPublisherMarker = true;
        }
        if (ANTI_CHEAT_SKIP_DIR_RE.test(lower)) continue;
        const nextItem = { dir: path.join(current.dir, entry.name), depth: current.depth + 1 };
        if (ANTI_CHEAT_PRIORITY_DIR_RE.test(lower)) {
          priorityQueue.push(nextItem);
        } else {
          normalQueue.push(nextItem);
        }
      }
    }

    // Pass 2: Inspect relevant files in `current.dir` under a bounded per-dir & total budget.
    let filesInspectedInDir = 0;
    for (
      let i = 0;
      i < entries.length && remainingFileBudget > 0 && filesInspectedInDir < MAX_FILES_PER_DIR;
      i += 1
    ) {
      const entry = entries[i];
      if (!entry || entry.name === '.' || entry.name === '..' || !entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (!ANTI_CHEAT_INTERESTING_FILE_EXT_RE.test(lower)) {
        continue;
      }
      remainingFileBudget -= 1;
      filesInspectedInDir += 1;

      if (
        ROCKSTAR_TITLE_OR_INSTALL_MARKER_RE.test(lower) ||
        ROCKSTAR_ARCHIVE_MARKER_RE.test(lower)
      ) {
        hasRockstarMarker = true;
      }
      if (NON_ROCKSTAR_PUBLISHER_MARKER_RE.test(lower)) {
        hasNonRockstarPublisherMarker = true;
      }

      if (lower === 'vgk.sys' || lower === 'vgc.exe') {
        foundVanguard = true;
      } else if (lower === 'randgrid.sys') {
        foundRicochet = true;
      } else if (
        lower === 'eaanticheat.gameservicelauncher.exe' ||
        lower === 'eaanticheat.installer.exe' ||
        lower === 'eaanticheat.sys'
      ) {
        foundEaJavelin = true;
      } else if (
        lower === 'easyanticheat_eos.sys' ||
        lower === 'easyanticheat.sys' ||
        lower === 'easyanticheat.exe' ||
        lower === 'easyanticheat_eos.exe'
      ) {
        foundEasyAntiCheat = true;
      } else if (
        lower === 'gamemon.des' ||
        lower === 'gamemon64.des' ||
        lower === 'npggnt.des' ||
        lower === 'npggnt64.des' ||
        lower === 'gameguard.des'
      ) {
        foundGameGuard = true;
      } else if (lower === 'xhunter1.sys' || lower === 'x3.xem') {
        foundXigncode3 = true;
      } else if (
        lower === 'denuvo-anti-cheat.sys' ||
        lower === 'denuvo-anti-cheat-update-service.exe'
      ) {
        foundDenuvoAntiCheat = true;
      } else if (
        lower === 'ace-base.sys' ||
        lower === 'ace-game.sys' ||
        lower === 'ace-game-0.sys' ||
        lower.startsWith('anticheatexpert')
      ) {
        foundTencentAce = true;
      } else if (
        lower === 'beservice_x64.exe' ||
        lower === 'beservice.exe' ||
        lower === 'bedaisy.sys'
      ) {
        foundBattlEye = true;
      } else if (
        current.depth === 0 &&
        STORY_BOOTSTRAPPER_RE.test(lower) &&
        !GENERIC_NON_STORY_PLAY_EXE_RE.test(lower)
      ) {
        rootPlayBootstrapperPaths.push(path.join(current.dir, entry.name));
      }
    }
  }

  if (foundVanguard) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'Riot Vanguard',
      storyModeBypassAvailable: false,
    };
  }
  if (foundRicochet) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'RICOCHET Anti-Cheat',
      storyModeBypassAvailable: false,
    };
  }
  if (foundEaJavelin) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'EA Javelin Anti-Cheat',
      storyModeBypassAvailable: false,
    };
  }
  if (foundDenuvoAntiCheat) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'Denuvo Anti-Cheat',
      storyModeBypassAvailable: false,
    };
  }
  if (foundTencentAce) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'Tencent ACE',
      storyModeBypassAvailable: false,
    };
  }
  if (foundGameGuard) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'nProtect GameGuard',
      storyModeBypassAvailable: false,
    };
  }
  if (foundXigncode3) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'XIGNCODE3',
      storyModeBypassAvailable: false,
    };
  }
  if (foundEasyAntiCheat) {
    return {
      requiresKernelAntiCheat: true,
      kernelAntiCheatName: 'EasyAntiCheat',
      storyModeBypassAvailable: false,
    };
  }
  if (foundBattlEye) {
    if (rootPlayBootstrapperPaths.length === 0) {
      try {
        const rootEntries = fs.readdirSync(rootDir, { withFileTypes: true });
        for (const d of rootEntries) {
          const lowerName = d.name.toLowerCase();
          if (
            ROCKSTAR_TITLE_OR_INSTALL_MARKER_RE.test(lowerName) ||
            (d.isFile() && ROCKSTAR_ARCHIVE_MARKER_RE.test(lowerName))
          ) {
            hasRockstarMarker = true;
          }
          if (NON_ROCKSTAR_PUBLISHER_MARKER_RE.test(lowerName)) {
            hasNonRockstarPublisherMarker = true;
          }
          if (
            d.isFile() &&
            STORY_BOOTSTRAPPER_RE.test(lowerName) &&
            !GENERIC_NON_STORY_PLAY_EXE_RE.test(lowerName)
          ) {
            rootPlayBootstrapperPaths.push(path.join(rootDir, d.name));
          }
        }
      } catch {}
    }
    const hasValidRootPePlayBootstrapper = rootPlayBootstrapperPaths.some((candidatePath) => {
      const pe = inspectWindowsExecutableHeader(candidatePath, {
        strictPe: true,
        skipImports: true,
        skipRdataStringScan: true,
        inspectDpiManifest: false,
      });
      return Boolean(pe.isValidPe && !pe.isSyntheticStub);
    });
    const requireRockstar = Boolean(options?.requireRockstarMarkersForStoryBypass);
    const publisherAllowed = requireRockstar
      ? hasRockstarMarker
      : !hasNonRockstarPublisherMarker || hasRockstarMarker;
    const verifiedStoryBypass = Boolean(hasValidRootPePlayBootstrapper && publisherAllowed);
    return {
      requiresKernelAntiCheat: !verifiedStoryBypass,
      kernelAntiCheatName: 'BattlEye',
      storyModeBypassAvailable: verifiedStoryBypass,
    };
  }

  return defaultResult;
}

/**
 * Inspects a GDK `MicrosoftGame.config` XML buffer, string, file path, or game directory.
 *
 * @param {Buffer | string} xmlOrPath
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
  /**
   * @param {string} tagText
   * @param {string} attrName
   */
  const extractAttrLocal = (tagText, attrName) => {
    const re = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
    const m = re.exec(tagText);
    return m ? (m[1] !== undefined ? m[1] : m[2] || '').trim() : '';
  };
  /** @param {string} rawWd */
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
  /** @type {Map<string, string>} */
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
    /(?:^|[-_])(?:gdkstubgame|gamelaunchhelper|custominstallexec|custominstallactions|crashreporter|crashhandler|crashpad|unitycrashhandler|bugsplat|unrealcefsubprocess|cefprocess|prerequisites|vc_redist|vcredist|dxsetup|directx|dotnet|unins\d*)/i;
  const rawExecutables = Array.isArray(parsed.executables) ? parsed.executables : [];
  const isExternalLauncherStub = Boolean(
    /PRPOStubCreator/i.test(xml) ||
      /\bGDKStubGame\.exe\b/i.test(xml) ||
      rawExecutables.some((/** @type {any} */ e) =>
        /^gdkstubgame\.exe$/i.test(
          path.posix.basename(String(e?.name || '').replace(/\\/g, '/'))
        )
      )
  );
  const executables = rawExecutables.map((/** @type {any} */ e) => {
    const normName = String(e?.name || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
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
  const nonHelperExecutables = executables.filter(
    (/** @type {any} */ e) => !e.isHelperStub && !e.isGameLaunchHelper
  );
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
  let primaryExecObj =
    nonHelperExecutables[0] || (isExternalLauncherStub ? null : executables[0] || null);
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
  let primaryExecutable = primaryExecObj
    ? primaryExecObj.name
    : isExternalLauncherStub
      ? ''
      : parsed.primaryExecutable || '';
  if (primaryExecutable && contentRootDir) {
    const resolvedOnDisk = resolveCaseInsensitiveRelFile(contentRootDir, primaryExecutable);
    if (resolvedOnDisk) {
      primaryExecutable = path.relative(contentRootDir, resolvedOnDisk).replace(/\\/g, '/');
    }
  }
  const overrideWorkingDirectory =
    (primaryExecObj && primaryExecObj.overrideWorkingDirectory) || '';
  const helperExecObj = executables.find((/** @type {any} */ e) => e.isGameLaunchHelper) || null;
  let gameLaunchHelperExecutable = helperExecObj ? helperExecObj.name : '';
  if (!gameLaunchHelperExecutable && contentRootDir) {
    try {
      const helperCandidate = resolveCaseInsensitiveRelFile(contentRootDir, 'gamelaunchhelper.exe');
      if (helperCandidate) {
        gameLaunchHelperExecutable = path.basename(helperCandidate);
      }
    } catch {}
  }

  const appId =
    (primaryExecObj && primaryExecObj.id) || (executables[0] && executables[0].id) || 'Game';
  const packageFamilyName = parsed.packageFamilyName || '';
  const appUserModelId = packageFamilyName && appId ? `${packageFamilyName}!${appId}` : '';
  const isDlcAddon = Boolean(hasMainPackageDependency || executables.length === 0);
  const isNonGameUtility = isXboxNonGameUtilityIdentity(parsed.identity?.name, {
    isDlcAddon,
    hasExecutable: executables.length > 0,
  });
  const rawDisplayName = parsed.shellVisuals?.defaultDisplayName || '';
  const displayName = cleanManifestDisplayName(rawDisplayName);

  /** @type {string | null} */
  let paradoxDirectGameExe = null;
  if (contentRootDir) {
    const isDowserPrimary =
      /^dowser\.exe$/i.test(
        path.posix.basename(String(primaryExecutable || '').replace(/\\/g, '/'))
      ) ||
      executables.some((/** @type {any} */ e) =>
        /^dowser\.exe$/i.test(path.posix.basename(String(e?.name || '').replace(/\\/g, '/')))
      );
    if (isDowserPrimary) {
      const primaryDiskExe = primaryExecutable
        ? resolveCaseInsensitiveRelFile(contentRootDir, primaryExecutable)
        : '';
      const paradoxSettings = resolveParadoxLauncherSettings(
        primaryDiskExe || contentRootDir,
        contentRootDir
      );
      if (paradoxSettings.paradoxDirectGameExe) {
        paradoxDirectGameExe = paradoxSettings.paradoxDirectGameExe;
      }
    }
  }
  const antiCheatInfo = contentRootDir
    ? detectKernelAntiCheatMarkersInDir(contentRootDir)
    : {
        requiresKernelAntiCheat: false,
        kernelAntiCheatName: null,
        storyModeBypassAvailable: false,
      };

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
    paradoxDirectGameExe,
    requiresKernelAntiCheat: antiCheatInfo.requiresKernelAntiCheat,
    kernelAntiCheatName: antiCheatInfo.kernelAntiCheatName,
    storyModeBypassAvailable: antiCheatInfo.storyModeBypassAvailable,
    requiresCoreWindow: false,
    isExternalLauncherStub,
    isDlcAddon,
    isNonGameUtility,
    configFilePath: filePath,
    contentRootDir,
    configDir: contentRootDir,
  };
}

/**
 * Inspects an Appx/MSIX `AppxManifest.xml` buffer, string, file path, or game directory.
 *
 * @param {Buffer | string} xmlOrPath
 */
function inspectAppxManifest(xmlOrPath) {
  const { xml, filePath, contentRootDir } = readXmlFromInputOrCandidatePaths(xmlOrPath, [
    'AppxManifest.xml',
    path.join('Content', 'AppxManifest.xml'),
  ]);
  if (!xml) return null;
  const parsed = parseAppxManifest(xml);
  if (!parsed) return null;

  /**
   * @param {string} tagText
   * @param {string} attrName
   */
  const extractAttr = (tagText, attrName) => {
    const re = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
    const m = re.exec(tagText);
    return m ? (m[1] !== undefined ? m[1] : m[2] || '').trim() : '';
  };
  /** @param {unknown} p */
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
    square150x150Logo: visualMatch
      ? normRel(extractAttr(visualMatch[1], 'Square150x150Logo'))
      : '',
    square44x44Logo: visualMatch ? normRel(extractAttr(visualMatch[1], 'Square44x44Logo')) : '',
    splashScreenImage: splashMatch ? normRel(extractAttr(splashMatch[1], 'Image')) : '',
  };

  const apps = Array.isArray(parsed.applications) ? parsed.applications : [];
  const nonHelperApps = apps.filter(
    (/** @type {any} */ a) =>
      a.executable && path.posix.basename(a.executable).toLowerCase() !== 'gamelaunchhelper.exe'
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
  const primaryApplication =
    nonHelperApp || apps.find((/** @type {any} */ a) => a.executable) || apps[0] || null;
  let primaryExecutable = primaryApplication?.executable || '';
  if (primaryExecutable && contentRootDir) {
    const resolvedAppxExe = resolveCaseInsensitiveRelFile(contentRootDir, primaryExecutable);
    if (resolvedAppxExe) {
      primaryExecutable = path.relative(contentRootDir, resolvedAppxExe).replace(/\\/g, '/');
    }
  }
  const appId = primaryApplication?.id || 'App';
  const packageFamilyName = parsed.packageFamilyName || '';
  const appUserModelId = packageFamilyName && appId ? `${packageFamilyName}!${appId}` : '';

  const requiresCoreWindow = Boolean(
    !parsed.hasFullTrustApplication &&
      apps.length > 0 &&
      apps.every((/** @type {any} */ a) => a.isPureUwpCoreWindow)
  );
  const hasAnyExecutable = Boolean(primaryExecutable);
  const isDlcAddon = Boolean(
    parsed.hasMainPackageDependency || (!hasAnyExecutable && !requiresCoreWindow)
  );
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
  resolveCaseInsensitiveRelFile,
  parseGamingRootFile,
  parseLauncherSettingsCfg,
  resolveParadoxLauncherSettings,
  detectKernelAntiCheatMarkersInDir,
  computeAppxPublisherId,
  computePackageFamilyName,
  deriveDefaultScidFromTitleId,
  inspectMicrosoftGameConfig,
  inspectAppxManifest,
  isXboxNonGameUtilityIdentity,
};
