// @ts-check
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveDriveCPathCaseInsensitive } = require('../wineAndCrossOverManager.cjs');
const {
  discoverWindowsPublisherLauncherPaths,
  discoverWindowsPublisherLauncherPathsAsync,
} = require('../../utils/windowsRegistryDiscovery.cjs');
const {
  EA_DESKTOP_MSI_UPGRADE_CODE,
  CHAINED_PUBLISHER_ECOSYSTEMS,
  normalizeChainedHandoffId,
} = require('./publisherCatalogData.cjs');
const {
  getRegistryPropCaseInsensitive,
  getBottleSystemRegSections,
  getBottleSystemRegSectionsAsync,
  resolveDriveCPathCaseInsensitiveAsync,
  resolveBottleWindowsPathReadOnly,
  resolveBottleWindowsPathReadOnlyAsync,
  listBottleUserDirectories,
  listBottleUserDirectoriesAsync,
} = require('./wineRegistryParserAndMutator.cjs');

const execFileAsyncDefault = promisify(execFile);

/**
 * @typedef {import('./publisherCatalogData.cjs').ChainedHandoffId} ChainedHandoffId
 * @typedef {import('./publisherCatalogData.cjs').DiscoveredPublisherLauncherInfo} DiscoveredPublisherLauncherInfo
 */

/**
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
async function pathExistsAsync(targetPath) {
  if (!targetPath) return false;
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} targetPath
 * @returns {Promise<fs.Stats | null>}
 */
async function safeStatAsync(targetPath) {
  if (!targetPath) return null;
  try {
    return await fs.promises.stat(targetPath);
  } catch {
    return null;
  }
}

// ============================================================================
// Pure Session / Version / Candidate Parsers (shared by Sync & Async paths)
// ============================================================================

/**
 * @param {string} raw
 * @returns {boolean}
 */
function doesUbisoftSettingsDisableAutoLogin(raw) {
  return /^\s*(?:remember_me|auto_login|autologin)\s*:\s*["']?(?:false|0|no)["']?\s*(?:#.*)?$/im.test(
    raw
  );
}

/**
 * @param {string} iniText
 * @returns {boolean}
 */
function doesEaUserIniIgnoreRememberMe(iniText) {
  const ignoreMatch = iniText.match(/^\s*user\.ignoreRememberMe\s*=\s*([^\r\n#;]*)/im);
  const ignoreVal = ignoreMatch
    ? String(ignoreMatch[1] || '')
        .trim()
        .replace(/^["']+|["']+$/g, '')
        .toLowerCase()
    : '';
  return ignoreVal === 'true' || ignoreVal === '1';
}

/**
 * Evaluate EA `cookie.ini` contents for active non-expired session cookies.
 *
 * @param {string} cookieText
 * @param {number} [nowMs]
 * @returns {{ hasValidNonExpiredCookie: boolean, hasExpiredCookieOnly: boolean, cookieIniClearedOrEmpty: boolean }}
 */
function evaluateEaCookieIniText(cookieText, nowMs = Date.now()) {
  let cookieIniClearedOrEmpty = false;
  let hasExpiredCookieOnly = false;
  let hasValidNonExpiredCookie = false;

  const cookieLines = Array.from(
    cookieText.matchAll(
      /^\s*browser\.(?:rememberMeCookie|sessionPersistentCookies)\s*=\s*(.*)$/gim
    )
  );
  if (cookieLines.length === 0) {
    if (!cookieText.trim()) {
      cookieIniClearedOrEmpty = true;
    }
    return { hasValidNonExpiredCookie, hasExpiredCookieOnly, cookieIniClearedOrEmpty };
  }

  let sawClearedLine = false;
  let sawExpiredLine = false;

  for (const m of cookieLines) {
    let rhs = String(m[1] || '').trim();
    if (!rhs || rhs === '""' || rhs === "''" || /^@invalid\(\)$/i.test(rhs)) {
      sawClearedLine = true;
      continue;
    }
    if (
      (rhs.startsWith('"') && rhs.endsWith('"')) ||
      (rhs.startsWith("'") && rhs.endsWith("'"))
    ) {
      rhs = rhs.slice(1, -1).trim();
    }
    rhs = rhs.replace(/\\"/g, '"').replace(/\\x3b/gi, ';');
    if (!rhs || /^@invalid\(\)$/i.test(rhs)) {
      sawClearedLine = true;
      continue;
    }

    const expMatches = Array.from(rhs.matchAll(/\bexpires\s*=\s*([^;\r\n"|]+)/gi));
    /** @type {number[]} */
    const parsedExpiries = [];
    for (const expMatch of expMatches) {
      const rawExp = String(expMatch[1] || '').trim();
      if (!rawExp) continue;
      const parsedMs = Date.parse(rawExp);
      if (!Number.isNaN(parsedMs)) {
        parsedExpiries.push(parsedMs);
      }
    }

    if (parsedExpiries.length > 0) {
      if (parsedExpiries.some((ms) => ms > nowMs)) {
        hasValidNonExpiredCookie = true;
      } else {
        sawExpiredLine = true;
      }
    } else {
      hasValidNonExpiredCookie = true;
    }
  }

  if (!hasValidNonExpiredCookie) {
    if (sawExpiredLine) hasExpiredCookieOnly = true;
    if (sawClearedLine) cookieIniClearedOrEmpty = true;
  }

  return { hasValidNonExpiredCookie, hasExpiredCookieOnly, cookieIniClearedOrEmpty };
}

/**
 * @param {string} raw
 * @returns {string | undefined}
 */
function parseEaVersionPropertiesText(raw) {
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.includes('=')) {
      const rhs = line.split('=').slice(1).join('=').trim();
      if (rhs) return rhs;
    } else {
      return line;
    }
  }
  return undefined;
}

/**
 * @param {string} xml
 * @returns {string | undefined}
 */
function parseMacInfoPlistVersionXml(xml) {
  const shortMatch = xml.match(
    /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/i
  );
  if (shortMatch && shortMatch[1]?.trim()) {
    return shortMatch[1].trim();
  }
  const bundleVerMatch = xml.match(
    /<key>\s*CFBundleVersion\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/i
  );
  if (bundleVerMatch && bundleVerMatch[1]?.trim()) {
    return bundleVerMatch[1].trim();
  }
  return undefined;
}

/**
 * @param {string} rawJsonText
 * @returns {boolean}
 */
function doesBattleNetConfigHaveSession(rawJsonText) {
  try {
    const parsed = JSON.parse(rawJsonText);
    const saved = parsed?.Client?.SavedAccountNames;
    if (typeof saved !== 'string' || saved.trim().length === 0) return false;
    const autoLogin = parsed?.Client?.AutoLogin;
    if (
      autoLogin === false ||
      autoLogin === 0 ||
      (typeof autoLogin === 'string' && /^(?:false|0|no)$/i.test(autoLogin.trim()))
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function doesRockstarTextIndicateSignOut(text) {
  return (
    /\b(?:auto_?sign_?in|remember_?me)\s*[:=]\s*["']?(?:false|0)["']?/i.test(text) ||
    /\bsigned_?out\s*[:=]\s*["']?(?:true|1)["']?/i.test(text)
  );
}

/**
 * Pure parser for Riot Client's `RiotGamesPrivateSettings.yaml` checking specifically
 * `riot-login` -> `persist` -> `session` -> `cookies` for an authenticated session cookie
 * (`ssid`, `sub`, or `csid` with a non-empty `value`), strictly ignoring pre-login telemetry `tdid`.
 *
 * @param {string} raw
 * @returns {boolean}
 */
function doesRiotPrivateSettingsHaveSession(raw) {
  const lines = raw.split(/\r?\n/);

  /** @type {Array<{ indent: number, key: string }>} */
  const pathStack = [];
  let inSessionCookiesList = false;
  let cookiesBlockIndent = -1;
  let currentCookieName = '';
  let currentCookieValue = '';

  const checkCurrentCookie = () => {
    const n = currentCookieName.trim().toLowerCase();
    const v = currentCookieValue.trim();
    return (
      (n === 'ssid' || n === 'sub' || n === 'csid') &&
      v.length > 0 &&
      v.toLowerCase() !== 'null' &&
      v !== '~'
    );
  };

  const stripYamlScalarQuotes = (/** @type {string} */ s) => {
    const t = s.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1).trim();
    }
    return t.replace(/\s+#.*$/, '').trim();
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indentMatch = rawLine.match(/^[ \t]*/);
    const indent = indentMatch ? indentMatch[0].replace(/\t/g, '  ').length : 0;

    if (inSessionCookiesList) {
      if (indent <= cookiesBlockIndent) {
        if (checkCurrentCookie()) return true;
        currentCookieName = '';
        currentCookieValue = '';
        inSessionCookiesList = false;
        cookiesBlockIndent = -1;
      } else {
        if (trimmed === '-' || trimmed.startsWith('- ')) {
          if (checkCurrentCookie()) return true;
          currentCookieName = '';
          currentCookieValue = '';
          const afterDash = trimmed.slice(1).trim();
          if (afterDash) {
            const kv = afterDash.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
            if (kv) {
              const k = kv[1].toLowerCase();
              const val = stripYamlScalarQuotes(kv[2] || '');
              if (k === 'name') currentCookieName = val;
              else if (k === 'value') currentCookieValue = val;
            }
          }
          continue;
        }
        const propMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
        if (propMatch) {
          const k = propMatch[1].toLowerCase();
          const val = stripYamlScalarQuotes(propMatch[2] || '');
          if (k === 'name') currentCookieName = val;
          else if (k === 'value') currentCookieValue = val;
        }
        continue;
      }
    }

    while (pathStack.length > 0 && pathStack[pathStack.length - 1].indent >= indent) {
      pathStack.pop();
    }

    const keyHeaderMatch = trimmed.match(/^["']?([A-Za-z0-9_.-]+)["']?\s*:\s*(.*)$/);
    if (keyHeaderMatch) {
      const keyLower = keyHeaderMatch[1].toLowerCase();
      const rhs = keyHeaderMatch[2].trim();
      if (!rhs || rhs.startsWith('#')) {
        pathStack.push({ indent, key: keyLower });
        if (
          pathStack.length >= 4 &&
          pathStack[pathStack.length - 4].key === 'riot-login' &&
          pathStack[pathStack.length - 3].key === 'persist' &&
          pathStack[pathStack.length - 2].key === 'session' &&
          keyLower === 'cookies'
        ) {
          inSessionCookiesList = true;
          cookiesBlockIndent = indent;
          currentCookieName = '';
          currentCookieValue = '';
        }
      }
    }
  }

  return inSessionCookiesList && checkCurrentCookie();
}

/**
 * Pure helper extracting candidate Windows executable/helper paths and registry metadata for
 * a bottle publisher launcher from parsed `system.reg` sections.
 *
 * @param {ChainedHandoffId} canonical
 * @param {Map<string, Record<string, string>>} sections
 * @returns {{
 *   winExeCandidates: string[],
 *   winLauncherAppCandidates: string[],
 *   winBgServiceCandidates: string[],
 *   version: string | undefined,
 *   regInstallDirWin: string,
 * }}
 */
function collectBottlePublisherCandidates(canonical, sections) {
  /** @type {string[]} */
  const winExeCandidates = [];
  /** @type {string[]} */
  const winLauncherAppCandidates = [];
  /** @type {string[]} */
  const winBgServiceCandidates = [];
  /** @type {string | undefined} */
  let version;
  let regInstallDirWin = '';

  const pushWinCandidate = (/** @type {string} */ winPath) => {
    const clean = String(winPath || '').trim();
    if (clean && !winExeCandidates.includes(clean)) {
      winExeCandidates.push(clean);
    }
  };

  if (canonical === 'ubisoft') {
    const sec32 = sections.get('Software\\Wow6432Node\\Ubisoft\\Launcher');
    const sec64 = sections.get('Software\\Ubisoft\\Launcher');
    const regInstallDir =
      getRegistryPropCaseInsensitive(sec32, 'InstallDir') ||
      getRegistryPropCaseInsensitive(sec64, 'InstallDir');
    version =
      getRegistryPropCaseInsensitive(sec32, 'Version') ||
      getRegistryPropCaseInsensitive(sec64, 'Version') ||
      undefined;
    if (regInstallDir) {
      const trimmedDir = regInstallDir.replace(/[\\/]+$/, '');
      regInstallDirWin = trimmedDir;
      pushWinCandidate(`${trimmedDir}\\upc.exe`);
      pushWinCandidate(`${trimmedDir}\\UbisoftConnect.exe`);
    }
    pushWinCandidate('C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\upc.exe');
    pushWinCandidate(
      'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\UbisoftConnect.exe'
    );
    pushWinCandidate('C:\\Program Files\\Ubisoft\\Ubisoft Game Launcher\\upc.exe');
  } else if (canonical === 'ea') {
    const sec64 = sections.get('Software\\Electronic Arts\\EA Desktop');
    const sec32 = sections.get('Software\\Wow6432Node\\Electronic Arts\\EA Desktop');
    const clientPath =
      getRegistryPropCaseInsensitive(sec64, 'ClientPath') ||
      getRegistryPropCaseInsensitive(sec32, 'ClientPath');
    const launcherAppReg =
      getRegistryPropCaseInsensitive(sec64, 'LauncherAppPath') ||
      getRegistryPropCaseInsensitive(sec32, 'LauncherAppPath');
    const installLoc =
      getRegistryPropCaseInsensitive(sec64, 'InstallLocation') ||
      getRegistryPropCaseInsensitive(sec32, 'InstallLocation');
    version =
      getRegistryPropCaseInsensitive(sec64, 'ClientVersion') ||
      getRegistryPropCaseInsensitive(sec32, 'ClientVersion') ||
      undefined;
    if (clientPath) {
      pushWinCandidate(clientPath);
    }
    if (launcherAppReg) {
      winLauncherAppCandidates.push(launcherAppReg);
    }
    if (installLoc) {
      const trimmedDir = installLoc.replace(/[\\/]+$/, '');
      regInstallDirWin = trimmedDir;
      pushWinCandidate(`${trimmedDir}\\EA Desktop\\EADesktop.exe`);
      pushWinCandidate(`${trimmedDir}\\EA Desktop\\EALauncher.exe`);
      pushWinCandidate(`${trimmedDir}\\EADesktop.exe`);
      pushWinCandidate(`${trimmedDir}\\EALauncher.exe`);
      winLauncherAppCandidates.push(`${trimmedDir}\\EA Desktop\\EALauncher.exe`);
      winLauncherAppCandidates.push(`${trimmedDir}\\EALauncher.exe`);
      winBgServiceCandidates.push(`${trimmedDir}\\EA Desktop\\EABackgroundService.exe`);
      winBgServiceCandidates.push(`${trimmedDir}\\EABackgroundService.exe`);
    }
    if (launcherAppReg) {
      pushWinCandidate(launcherAppReg);
    }
    pushWinCandidate(
      'C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe'
    );
    pushWinCandidate(
      'C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EALauncher.exe'
    );
    pushWinCandidate(
      'C:\\Program Files (x86)\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe'
    );
    pushWinCandidate(
      'C:\\Program Files (x86)\\Electronic Arts\\EA Desktop\\EA Desktop\\EALauncher.exe'
    );
    winLauncherAppCandidates.push(
      'C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EALauncher.exe',
      'C:\\Program Files (x86)\\Electronic Arts\\EA Desktop\\EA Desktop\\EALauncher.exe'
    );
    winBgServiceCandidates.push(
      'C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EABackgroundService.exe',
      'C:\\Program Files (x86)\\Electronic Arts\\EA Desktop\\EA Desktop\\EABackgroundService.exe'
    );
  } else if (canonical === 'bnet') {
    const sec32 = sections.get(
      'Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Battle.net'
    );
    const sec64 = sections.get(
      'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Battle.net'
    );
    const installLoc =
      getRegistryPropCaseInsensitive(sec32, 'InstallLocation') ||
      getRegistryPropCaseInsensitive(sec64, 'InstallLocation');
    version =
      getRegistryPropCaseInsensitive(sec32, 'DisplayVersion') ||
      getRegistryPropCaseInsensitive(sec64, 'DisplayVersion') ||
      undefined;
    if (installLoc) {
      const trimmedDir = installLoc.replace(/[\\/]+$/, '');
      regInstallDirWin = trimmedDir;
      pushWinCandidate(`${trimmedDir}\\Battle.net.exe`);
      pushWinCandidate(`${trimmedDir}\\Battle.net Launcher.exe`);
    }
    pushWinCandidate('C:\\Program Files (x86)\\Battle.net\\Battle.net.exe');
    pushWinCandidate('C:\\Program Files\\Battle.net\\Battle.net.exe');
  } else if (canonical === 'rockstar') {
    const sec32 = sections.get('Software\\Wow6432Node\\Rockstar Games\\Launcher');
    const sec64 = sections.get('Software\\Rockstar Games\\Launcher');
    const installFolder =
      getRegistryPropCaseInsensitive(sec32, 'InstallFolder') ||
      getRegistryPropCaseInsensitive(sec64, 'InstallFolder');
    version =
      getRegistryPropCaseInsensitive(sec32, 'Version') ||
      getRegistryPropCaseInsensitive(sec64, 'Version') ||
      undefined;
    if (installFolder) {
      const trimmedDir = installFolder.replace(/[\\/]+$/, '');
      regInstallDirWin = trimmedDir;
      pushWinCandidate(`${trimmedDir}\\Launcher.exe`);
      pushWinCandidate(`${trimmedDir}\\LauncherPatcher.exe`);
    }
    pushWinCandidate('C:\\Program Files\\Rockstar Games\\Launcher\\Launcher.exe');
    pushWinCandidate('C:\\Program Files\\Rockstar Games\\Launcher\\LauncherPatcher.exe');
    pushWinCandidate('C:\\Program Files (x86)\\Rockstar Games\\Launcher\\Launcher.exe');
    pushWinCandidate('C:\\Program Files (x86)\\Rockstar Games\\Launcher\\LauncherPatcher.exe');
  }

  return {
    winExeCandidates,
    winLauncherAppCandidates,
    winBgServiceCandidates,
    version,
    regInstallDirWin,
  };
}

/**
 * Pure helper scanning `Uninstall` registry entries for EA App / EA Desktop `DisplayVersion`.
 *
 * @param {Map<string, Record<string, string>>} sections
 * @returns {string | undefined}
 */
function findEaVersionInUninstallSections(sections) {
  for (const [secKey, props] of sections.entries()) {
    if (
      !/^software\\(?:wow6432node\\)?microsoft\\windows\\currentversion\\uninstall\\[^\\]+$/i.test(
        secKey
      )
    ) {
      continue;
    }
    const upgradeCode = getRegistryPropCaseInsensitive(props, 'UpgradeCode').toUpperCase();
    const dispName = getRegistryPropCaseInsensitive(props, 'DisplayName').toLowerCase();
    if (
      upgradeCode === EA_DESKTOP_MSI_UPGRADE_CODE ||
      dispName === 'ea app' ||
      dispName === 'ea desktop'
    ) {
      const dispVer =
        getRegistryPropCaseInsensitive(props, 'DisplayVersion') ||
        getRegistryPropCaseInsensitive(props, 'BundleVersion');
      if (dispVer) return dispVer;
    }
  }
  return undefined;
}

/**
 * Resolve sandbox-aware macOS Application roots & shared Riot directory.
 *
 * @param {Record<string, any>} [options]
 * @returns {{ sandboxHome: string, customAppsDir: string, isIsolatedSandbox: boolean, home: string, appRoots: string[], sharedRiotDir: string }}
 */
function resolveDarwinBundleRoots(options = {}) {
  const sandboxHome =
    typeof options.homedir === 'string' && options.homedir.trim() ? options.homedir.trim() : '';
  const customAppsDir =
    typeof options.customApplicationsDir === 'string' && options.customApplicationsDir.trim()
      ? options.customApplicationsDir.trim()
      : '';
  const isIsolatedSandbox = Boolean(sandboxHome || customAppsDir);
  const home = sandboxHome || os.homedir();
  const appRoots = isIsolatedSandbox
    ? [customAppsDir, sandboxHome ? path.join(sandboxHome, 'Applications') : ''].filter(Boolean)
    : ['/Applications', path.join(home, 'Applications')];

  const explicitSharedRiotDir =
    typeof options.sharedRiotDir === 'string' && options.sharedRiotDir.trim()
      ? options.sharedRiotDir.trim()
      : '';
  const sharedRiotDir =
    explicitSharedRiotDir ||
    (isIsolatedSandbox
      ? sandboxHome
        ? path.join(sandboxHome, 'Users', 'Shared', 'Riot Games')
        : ''
      : '/Users/Shared/Riot Games');

  return { sandboxHome, customAppsDir, isIsolatedSandbox, home, appRoots, sharedRiotDir };
}

// ============================================================================
// Non-Secret Local Session Probes (Sync + Async)
// ============================================================================

/**
 * Read-only, non-PII check for whether a local Ubisoft Connect (`175.x` or legacy) authenticated
 * session exists under a Windows/Wine `AppData/Local/Ubisoft Game Launcher` directory (synchronous).
 *
 * @param {string} ubiLocalDir
 * @param {string} [legacyInstallDir]
 * @returns {boolean}
 */
function hasUbisoftLocalSessionInDir(ubiLocalDir, legacyInstallDir = '') {
  if (!ubiLocalDir) return false;
  try {
    if (!fs.existsSync(ubiLocalDir)) return false;

    const settingsDirs = [ubiLocalDir, legacyInstallDir].filter(Boolean);
    for (const dir of settingsDirs) {
      for (const settingsName of ['settings.yaml', 'settings.yml']) {
        const settingsPath = resolveDriveCPathCaseInsensitive(dir, [settingsName]);
        try {
          if (settingsPath && fs.existsSync(settingsPath)) {
            const raw = fs.readFileSync(settingsPath, 'utf8');
            if (doesUbisoftSettingsDisableAutoLogin(raw)) return false;
          }
        } catch {}
      }
    }

    let hasModernSessionFile = false;
    let sawClearedModernStorage = false;
    for (const modernFile of ['user.vdat', 'ConnectSecureStorage.dat']) {
      const modernPath = resolveDriveCPathCaseInsensitive(ubiLocalDir, [modernFile]);
      try {
        if (modernPath && fs.existsSync(modernPath)) {
          const st = fs.statSync(modernPath);
          if (st.isFile()) {
            if (st.size > 16) hasModernSessionFile = true;
            else sawClearedModernStorage = true;
          }
        }
      } catch {}
    }

    const ownershipDir = resolveDriveCPathCaseInsensitive(ubiLocalDir, ['cache', 'ownership']);
    try {
      if (ownershipDir && fs.existsSync(ownershipDir) && fs.statSync(ownershipDir).isDirectory()) {
        const entries = fs.readdirSync(ownershipDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !/\.vdat$/i.test(entry.name)) continue;
          const st = fs.statSync(path.join(ownershipDir, entry.name));
          if (st.size > 16) {
            hasModernSessionFile = true;
            break;
          }
        }
      }
    } catch {}

    if (hasModernSessionFile) return true;
    if (sawClearedModernStorage) return false;

    for (const userDatName of ['users.dat', 'user.dat']) {
      const usersDat = resolveDriveCPathCaseInsensitive(ubiLocalDir, [userDatName]);
      if (usersDat && fs.existsSync(usersDat)) {
        const st = fs.statSync(usersDat);
        if (st.isFile() && st.size > 16) return true;
      }
    }
  } catch {}
  return false;
}

/**
 * Async counterpart to `hasUbisoftLocalSessionInDir` using `fs.promises`.
 *
 * @param {string} ubiLocalDir
 * @param {string} [legacyInstallDir]
 * @returns {Promise<boolean>}
 */
async function hasUbisoftLocalSessionInDirAsync(ubiLocalDir, legacyInstallDir = '') {
  if (!ubiLocalDir) return false;
  try {
    if (!(await pathExistsAsync(ubiLocalDir))) return false;

    const settingsDirs = [ubiLocalDir, legacyInstallDir].filter(Boolean);
    for (const dir of settingsDirs) {
      for (const settingsName of ['settings.yaml', 'settings.yml']) {
        const settingsPath = await resolveDriveCPathCaseInsensitiveAsync(dir, [settingsName]);
        try {
          const raw = await fs.promises.readFile(settingsPath, 'utf8');
          if (doesUbisoftSettingsDisableAutoLogin(raw)) return false;
        } catch {}
      }
    }

    let hasModernSessionFile = false;
    let sawClearedModernStorage = false;
    for (const modernFile of ['user.vdat', 'ConnectSecureStorage.dat']) {
      const modernPath = await resolveDriveCPathCaseInsensitiveAsync(ubiLocalDir, [modernFile]);
      const st = await safeStatAsync(modernPath);
      if (st && st.isFile()) {
        if (st.size > 16) hasModernSessionFile = true;
        else sawClearedModernStorage = true;
      }
    }

    const ownershipDir = await resolveDriveCPathCaseInsensitiveAsync(ubiLocalDir, [
      'cache',
      'ownership',
    ]);
    try {
      const ownStat = await safeStatAsync(ownershipDir);
      if (ownStat && ownStat.isDirectory()) {
        const entries = await fs.promises.readdir(ownershipDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !/\.vdat$/i.test(entry.name)) continue;
          const st = await safeStatAsync(path.join(ownershipDir, entry.name));
          if (st && st.size > 16) {
            hasModernSessionFile = true;
            break;
          }
        }
      }
    } catch {}

    if (hasModernSessionFile) return true;
    if (sawClearedModernStorage) return false;

    for (const userDatName of ['users.dat', 'user.dat']) {
      const usersDat = await resolveDriveCPathCaseInsensitiveAsync(ubiLocalDir, [userDatName]);
      const st = await safeStatAsync(usersDat);
      if (st && st.isFile() && st.size > 16) return true;
    }
  } catch {}
  return false;
}

/**
 * Read-only, non-PII check for whether a local EA App authenticated session exists (synchronous).
 *
 * @param {string} eaLocalDir
 * @returns {boolean}
 */
function hasEaLocalSessionInDir(eaLocalDir) {
  if (!eaLocalDir) return false;
  try {
    if (!fs.existsSync(eaLocalDir)) return false;
    const entries = fs.readdirSync(eaLocalDir, { withFileTypes: true });

    /** @type {string | null} */
    let cookieIniPath = null;
    let cookieIniMtimeMs = 0;
    let hasExplicitIgnoreRememberMe = false;
    let maxIgnoreRememberMeMtimeMs = 0;
    let hasActiveRememberMeUserIni = false;

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower === 'cookie.ini') {
        cookieIniPath = path.join(eaLocalDir, entry.name);
        try {
          cookieIniMtimeMs = fs.statSync(cookieIniPath).mtimeMs || 0;
        } catch {}
        continue;
      }
      if (/^user_.+\.ini$/.test(lower) && lower !== 'user_unknown.ini') {
        const userIniPath = path.join(eaLocalDir, entry.name);
        try {
          const st = fs.statSync(userIniPath);
          if (!st.isFile() || st.size === 0) continue;
          const iniText = fs.readFileSync(userIniPath, 'utf8');
          if (doesEaUserIniIgnoreRememberMe(iniText)) {
            hasExplicitIgnoreRememberMe = true;
            maxIgnoreRememberMeMtimeMs = Math.max(maxIgnoreRememberMeMtimeMs, st.mtimeMs || 0);
          } else {
            hasActiveRememberMeUserIni = true;
          }
        } catch {}
      }
    }

    let cookieIniClearedOrEmpty = false;
    let hasExpiredCookieOnly = false;
    let hasValidNonExpiredCookie = false;

    if (cookieIniPath) {
      try {
        const st = fs.statSync(cookieIniPath);
        if (st.size === 0) {
          cookieIniClearedOrEmpty = true;
        } else {
          const evalRes = evaluateEaCookieIniText(fs.readFileSync(cookieIniPath, 'utf8'));
          cookieIniClearedOrEmpty = evalRes.cookieIniClearedOrEmpty;
          hasExpiredCookieOnly = evalRes.hasExpiredCookieOnly;
          hasValidNonExpiredCookie = evalRes.hasValidNonExpiredCookie;
        }
      } catch {}
    }

    if (hasValidNonExpiredCookie) {
      return !hasExplicitIgnoreRememberMe || cookieIniMtimeMs > maxIgnoreRememberMeMtimeMs;
    }

    if (
      hasActiveRememberMeUserIni &&
      !hasExplicitIgnoreRememberMe &&
      !cookieIniClearedOrEmpty &&
      !hasExpiredCookieOnly
    ) {
      /** @type {string[]} */
      const cefCandidates = [
        resolveDriveCPathCaseInsensitive(eaLocalDir, ['CEF', 'BrowserCache', 'Network', 'Cookies']),
        resolveDriveCPathCaseInsensitive(eaLocalDir, ['CEF', 'BrowserCache', 'Cookies']),
      ];
      const cefRoot = resolveDriveCPathCaseInsensitive(eaLocalDir, ['CEF']);
      try {
        if (cefRoot && fs.existsSync(cefRoot) && fs.statSync(cefRoot).isDirectory()) {
          for (const d of fs.readdirSync(cefRoot, { withFileTypes: true })) {
            if (!d.isDirectory()) continue;
            cefCandidates.push(
              resolveDriveCPathCaseInsensitive(path.join(cefRoot, d.name), [
                'EADesktop',
                'BrowserCache',
                'Network',
                'Cookies',
              ]),
              resolveDriveCPathCaseInsensitive(path.join(cefRoot, d.name), [
                'EADesktop',
                'BrowserCache',
                'Cookies',
              ])
            );
          }
        }
      } catch {}
      for (const cefPath of cefCandidates) {
        try {
          if (cefPath && fs.existsSync(cefPath)) {
            const st = fs.statSync(cefPath);
            if (st.isFile() && st.size > 4096) return true;
          }
        } catch {}
      }
    }
  } catch {}
  return false;
}

/**
 * Async counterpart to `hasEaLocalSessionInDir` using `fs.promises`.
 *
 * @param {string} eaLocalDir
 * @returns {Promise<boolean>}
 */
async function hasEaLocalSessionInDirAsync(eaLocalDir) {
  if (!eaLocalDir) return false;
  try {
    const entries = await fs.promises.readdir(eaLocalDir, { withFileTypes: true });

    /** @type {string | null} */
    let cookieIniPath = null;
    let cookieIniMtimeMs = 0;
    let hasExplicitIgnoreRememberMe = false;
    let maxIgnoreRememberMeMtimeMs = 0;
    let hasActiveRememberMeUserIni = false;

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower === 'cookie.ini') {
        cookieIniPath = path.join(eaLocalDir, entry.name);
        const st = await safeStatAsync(cookieIniPath);
        cookieIniMtimeMs = st?.mtimeMs || 0;
        continue;
      }
      if (/^user_.+\.ini$/.test(lower) && lower !== 'user_unknown.ini') {
        const userIniPath = path.join(eaLocalDir, entry.name);
        try {
          const st = await safeStatAsync(userIniPath);
          if (!st || !st.isFile() || st.size === 0) continue;
          const iniText = await fs.promises.readFile(userIniPath, 'utf8');
          if (doesEaUserIniIgnoreRememberMe(iniText)) {
            hasExplicitIgnoreRememberMe = true;
            maxIgnoreRememberMeMtimeMs = Math.max(maxIgnoreRememberMeMtimeMs, st.mtimeMs || 0);
          } else {
            hasActiveRememberMeUserIni = true;
          }
        } catch {}
      }
    }

    let cookieIniClearedOrEmpty = false;
    let hasExpiredCookieOnly = false;
    let hasValidNonExpiredCookie = false;

    if (cookieIniPath) {
      try {
        const st = await safeStatAsync(cookieIniPath);
        if (st && st.size === 0) {
          cookieIniClearedOrEmpty = true;
        } else if (st) {
          const evalRes = evaluateEaCookieIniText(await fs.promises.readFile(cookieIniPath, 'utf8'));
          cookieIniClearedOrEmpty = evalRes.cookieIniClearedOrEmpty;
          hasExpiredCookieOnly = evalRes.hasExpiredCookieOnly;
          hasValidNonExpiredCookie = evalRes.hasValidNonExpiredCookie;
        }
      } catch {}
    }

    if (hasValidNonExpiredCookie) {
      return !hasExplicitIgnoreRememberMe || cookieIniMtimeMs > maxIgnoreRememberMeMtimeMs;
    }

    if (
      hasActiveRememberMeUserIni &&
      !hasExplicitIgnoreRememberMe &&
      !cookieIniClearedOrEmpty &&
      !hasExpiredCookieOnly
    ) {
      /** @type {string[]} */
      const cefCandidates = [
        await resolveDriveCPathCaseInsensitiveAsync(eaLocalDir, [
          'CEF',
          'BrowserCache',
          'Network',
          'Cookies',
        ]),
        await resolveDriveCPathCaseInsensitiveAsync(eaLocalDir, ['CEF', 'BrowserCache', 'Cookies']),
      ];
      const cefRoot = await resolveDriveCPathCaseInsensitiveAsync(eaLocalDir, ['CEF']);
      try {
        const cefRootStat = await safeStatAsync(cefRoot);
        if (cefRootStat && cefRootStat.isDirectory()) {
          const cefSubdirs = await fs.promises.readdir(cefRoot, { withFileTypes: true });
          for (const d of cefSubdirs) {
            if (!d.isDirectory()) continue;
            cefCandidates.push(
              await resolveDriveCPathCaseInsensitiveAsync(path.join(cefRoot, d.name), [
                'EADesktop',
                'BrowserCache',
                'Network',
                'Cookies',
              ]),
              await resolveDriveCPathCaseInsensitiveAsync(path.join(cefRoot, d.name), [
                'EADesktop',
                'BrowserCache',
                'Cookies',
              ])
            );
          }
        }
      } catch {}
      for (const cefPath of cefCandidates) {
        const st = await safeStatAsync(cefPath);
        if (st && st.isFile() && st.size > 4096) return true;
      }
    }
  } catch {}
  return false;
}

/**
 * Extract the first non-empty version string from an EA `version.properties` file (synchronous).
 *
 * @param {string | undefined | null} versionFilePath
 * @returns {string | undefined}
 */
function readEaVersionFromPropertiesFile(versionFilePath) {
  if (!versionFilePath) return undefined;
  try {
    if (!fs.existsSync(versionFilePath)) return undefined;
    return parseEaVersionPropertiesText(fs.readFileSync(versionFilePath, 'utf8'));
  } catch {}
  return undefined;
}

/**
 * Async counterpart to `readEaVersionFromPropertiesFile`.
 *
 * @param {string | undefined | null} versionFilePath
 * @returns {Promise<string | undefined>}
 */
async function readEaVersionFromPropertiesFileAsync(versionFilePath) {
  if (!versionFilePath) return undefined;
  try {
    const raw = await fs.promises.readFile(versionFilePath, 'utf8');
    return parseEaVersionPropertiesText(raw);
  } catch {}
  return undefined;
}

/**
 * Read `CFBundleShortVersionString` (or `CFBundleVersion`) from a macOS `.app` bundle `Info.plist`
 * (synchronous).
 *
 * @param {string} appBundlePath
 * @returns {string | undefined}
 */
function readMacAppBundleVersionReadOnly(appBundlePath) {
  if (!appBundlePath) return undefined;
  const plistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
  try {
    if (fs.existsSync(plistPath)) {
      const buf = fs.readFileSync(plistPath);
      if (buf.length > 0 && !(buf.length >= 6 && buf.subarray(0, 6).toString('ascii') === 'bplist')) {
        const parsed = parseMacInfoPlistVersionXml(buf.toString('utf8'));
        if (parsed) return parsed;
      } else if (process.platform === 'darwin' && fs.existsSync('/usr/libexec/PlistBuddy')) {
        for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
          try {
            const out = execFileSync(
              '/usr/libexec/PlistBuddy',
              ['-c', `Print :${key}`, plistPath],
              { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }
            ).trim();
            if (out) return out;
          } catch {}
        }
      }
    }
  } catch {}
  return (
    readEaVersionFromPropertiesFile(
      path.join(appBundlePath, 'Contents', 'Resources', 'version.properties')
    ) ||
    readEaVersionFromPropertiesFile(
      path.join(appBundlePath, 'Contents', 'MacOS', 'version.properties')
    )
  );
}

/**
 * Non-blocking async counterpart to `readMacAppBundleVersionReadOnly` using `fs.promises` and
 * `execFile` async for binary plists (zero main-thread `PlistBuddy` `execFileSync`).
 *
 * @param {string} appBundlePath
 * @param {{ execFileAsync?: (file: string, args: string[], opts?: Record<string, any>) => Promise<{ stdout?: string } | string> }} [options]
 * @returns {Promise<string | undefined>}
 */
async function readMacAppBundleVersionReadOnlyAsync(appBundlePath, options = {}) {
  if (!appBundlePath) return undefined;
  const plistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
  try {
    const buf = await fs.promises.readFile(plistPath);
    if (buf.length > 0 && !(buf.length >= 6 && buf.subarray(0, 6).toString('ascii') === 'bplist')) {
      const parsed = parseMacInfoPlistVersionXml(buf.toString('utf8'));
      if (parsed) return parsed;
    } else if (
      process.platform === 'darwin' &&
      (await pathExistsAsync('/usr/libexec/PlistBuddy'))
    ) {
      const runExecFile =
        typeof options.execFileAsync === 'function' ? options.execFileAsync : execFileAsyncDefault;
      for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
        try {
          const res = await runExecFile(
            '/usr/libexec/PlistBuddy',
            ['-c', `Print :${key}`, plistPath],
            { encoding: 'utf8', timeout: 1500 }
          );
          const stdout =
            typeof res === 'string' ? res : res && typeof res === 'object' ? String(res.stdout || '') : '';
          const out = stdout.trim();
          if (out) return out;
        } catch {}
      }
    }
  } catch {}
  return (
    (await readEaVersionFromPropertiesFileAsync(
      path.join(appBundlePath, 'Contents', 'Resources', 'version.properties')
    )) ||
    (await readEaVersionFromPropertiesFileAsync(
      path.join(appBundlePath, 'Contents', 'MacOS', 'version.properties')
    ))
  );
}

/**
 * Read-only, non-PII check for whether a Battle.net `Battle.net.config` file has an active
 * `SavedAccountNames` session where `Client.AutoLogin` is NOT `"false"` / `false` (synchronous).
 *
 * @param {string} configFilePath
 * @returns {boolean}
 */
function hasBattleNetLocalSessionInConfigFile(configFilePath) {
  if (!configFilePath) return false;
  try {
    if (!fs.existsSync(configFilePath)) return false;
    return doesBattleNetConfigHaveSession(fs.readFileSync(configFilePath, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Async counterpart to `hasBattleNetLocalSessionInConfigFile`.
 *
 * @param {string} configFilePath
 * @returns {Promise<boolean>}
 */
async function hasBattleNetLocalSessionInConfigFileAsync(configFilePath) {
  if (!configFilePath) return false;
  try {
    const raw = await fs.promises.readFile(configFilePath, 'utf8');
    return doesBattleNetConfigHaveSession(raw);
  } catch {
    return false;
  }
}

/**
 * Inspect whether a Rockstar `settings_user.dat` or `autosignin.dat` file contains an explicit sign-out flag.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function hasRockstarExplicitSignOutMarker(filePath) {
  if (!filePath) return false;
  try {
    if (!fs.existsSync(filePath)) return false;
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size === 0 || st.size > 256 * 1024) return false;
    return doesRockstarTextIndicateSignOut(fs.readFileSync(filePath, 'utf8'));
  } catch {}
  return false;
}

/**
 * Async counterpart to `hasRockstarExplicitSignOutMarker`.
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function hasRockstarExplicitSignOutMarkerAsync(filePath) {
  if (!filePath) return false;
  try {
    const st = await safeStatAsync(filePath);
    if (!st || !st.isFile() || st.size === 0 || st.size > 256 * 1024) return false;
    return doesRockstarTextIndicateSignOut(await fs.promises.readFile(filePath, 'utf8'));
  } catch {}
  return false;
}

/**
 * Read-only, non-PII check for whether Rockstar Games Launcher has an authenticated local profile
 * (synchronous).
 *
 * @param {string} launcherLocalOrProfilesDir
 * @param {string} [socialClubProfilesDir]
 * @returns {boolean}
 */
function hasRockstarLocalSessionInDir(launcherLocalOrProfilesDir, socialClubProfilesDir = '') {
  const checkLauncherProfilesContainer = (/** @type {string} */ profilesRoot) => {
    try {
      if (!profilesRoot || !fs.existsSync(profilesRoot)) return false;
      const entries = fs.readdirSync(profilesRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[0-9a-f]{6,}$/i.test(entry.name)) continue;
        const profDir = path.join(profilesRoot, entry.name);
        const signOutMarker = resolveDriveCPathCaseInsensitive(profDir, ['signout']);
        if (signOutMarker && fs.existsSync(signOutMarker)) continue;
        const autoSignInPath = resolveDriveCPathCaseInsensitive(profDir, ['autosignin.dat']);
        if (hasRockstarExplicitSignOutMarker(autoSignInPath)) continue;

        for (const credName of ['settings_account.dat', 'profiletitles.dat', 'autosignin.dat']) {
          const credPath = resolveDriveCPathCaseInsensitive(profDir, [credName]);
          try {
            if (credPath && fs.existsSync(credPath)) {
              const st = fs.statSync(credPath);
              if (st.isFile() && st.size > 0) return true;
            }
          } catch {}
        }
      }
    } catch {}
    return false;
  };

  let sawLauncherLocalDir = false;
  if (launcherLocalOrProfilesDir) {
    try {
      if (fs.existsSync(launcherLocalOrProfilesDir)) {
        const settingsUserPath = resolveDriveCPathCaseInsensitive(launcherLocalOrProfilesDir, [
          'settings_user.dat',
        ]);
        if (hasRockstarExplicitSignOutMarker(settingsUserPath)) return false;
        const nestedProfiles = resolveDriveCPathCaseInsensitive(launcherLocalOrProfilesDir, [
          'profiles',
        ]);
        if (nestedProfiles && fs.existsSync(nestedProfiles)) {
          sawLauncherLocalDir = true;
          if (checkLauncherProfilesContainer(nestedProfiles)) return true;
        } else if (path.basename(launcherLocalOrProfilesDir).toLowerCase() === 'profiles') {
          if (checkLauncherProfilesContainer(launcherLocalOrProfilesDir)) return true;
        }
      }
    } catch {}
  }

  const scCandidate =
    socialClubProfilesDir ||
    (!sawLauncherLocalDir &&
    launcherLocalOrProfilesDir &&
    /social club[\\/]profiles$/i.test(launcherLocalOrProfilesDir)
      ? launcherLocalOrProfilesDir
      : '');
  if (scCandidate && !sawLauncherLocalDir) {
    try {
      if (fs.existsSync(scCandidate)) {
        for (const entry of fs.readdirSync(scCandidate, { withFileTypes: true })) {
          if (
            entry.isFile() &&
            entry.name.toLowerCase() === 'autosignin.dat' &&
            !hasRockstarExplicitSignOutMarker(path.join(scCandidate, entry.name)) &&
            fs.statSync(path.join(scCandidate, entry.name)).size > 0
          ) {
            return true;
          }
          if (entry.isDirectory() && /^[0-9a-f]{6,}$/i.test(entry.name)) {
            const hexAuto = resolveDriveCPathCaseInsensitive(path.join(scCandidate, entry.name), [
              'autosignin.dat',
            ]);
            if (
              hexAuto &&
              fs.existsSync(hexAuto) &&
              !hasRockstarExplicitSignOutMarker(hexAuto) &&
              fs.statSync(hexAuto).size > 0
            ) {
              return true;
            }
          }
        }
      }
    } catch {}
  }

  return false;
}

/**
 * Async counterpart to `hasRockstarLocalSessionInDir` using `fs.promises`.
 *
 * @param {string} launcherLocalOrProfilesDir
 * @param {string} [socialClubProfilesDir]
 * @returns {Promise<boolean>}
 */
async function hasRockstarLocalSessionInDirAsync(
  launcherLocalOrProfilesDir,
  socialClubProfilesDir = ''
) {
  const checkLauncherProfilesContainer = async (/** @type {string} */ profilesRoot) => {
    try {
      const entries = await fs.promises.readdir(profilesRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[0-9a-f]{6,}$/i.test(entry.name)) continue;
        const profDir = path.join(profilesRoot, entry.name);
        const signOutMarker = await resolveDriveCPathCaseInsensitiveAsync(profDir, ['signout']);
        if (await pathExistsAsync(signOutMarker)) continue;
        const autoSignInPath = await resolveDriveCPathCaseInsensitiveAsync(profDir, [
          'autosignin.dat',
        ]);
        if (await hasRockstarExplicitSignOutMarkerAsync(autoSignInPath)) continue;

        for (const credName of ['settings_account.dat', 'profiletitles.dat', 'autosignin.dat']) {
          const credPath = await resolveDriveCPathCaseInsensitiveAsync(profDir, [credName]);
          const st = await safeStatAsync(credPath);
          if (st && st.isFile() && st.size > 0) return true;
        }
      }
    } catch {}
    return false;
  };

  let sawLauncherLocalDir = false;
  if (launcherLocalOrProfilesDir && (await pathExistsAsync(launcherLocalOrProfilesDir))) {
    try {
      const settingsUserPath = await resolveDriveCPathCaseInsensitiveAsync(
        launcherLocalOrProfilesDir,
        ['settings_user.dat']
      );
      if (await hasRockstarExplicitSignOutMarkerAsync(settingsUserPath)) return false;
      const nestedProfiles = await resolveDriveCPathCaseInsensitiveAsync(
        launcherLocalOrProfilesDir,
        ['profiles']
      );
      if (await pathExistsAsync(nestedProfiles)) {
        sawLauncherLocalDir = true;
        if (await checkLauncherProfilesContainer(nestedProfiles)) return true;
      } else if (path.basename(launcherLocalOrProfilesDir).toLowerCase() === 'profiles') {
        if (await checkLauncherProfilesContainer(launcherLocalOrProfilesDir)) return true;
      }
    } catch {}
  }

  const scCandidate =
    socialClubProfilesDir ||
    (!sawLauncherLocalDir &&
    launcherLocalOrProfilesDir &&
    /social club[\\/]profiles$/i.test(launcherLocalOrProfilesDir)
      ? launcherLocalOrProfilesDir
      : '');
  if (scCandidate && !sawLauncherLocalDir) {
    try {
      const entries = await fs.promises.readdir(scCandidate, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase() === 'autosignin.dat') {
          const autoPath = path.join(scCandidate, entry.name);
          const st = await safeStatAsync(autoPath);
          if (st && st.size > 0 && !(await hasRockstarExplicitSignOutMarkerAsync(autoPath))) {
            return true;
          }
        }
        if (entry.isDirectory() && /^[0-9a-f]{6,}$/i.test(entry.name)) {
          const hexAuto = await resolveDriveCPathCaseInsensitiveAsync(
            path.join(scCandidate, entry.name),
            ['autosignin.dat']
          );
          const st = await safeStatAsync(hexAuto);
          if (st && st.size > 0 && !(await hasRockstarExplicitSignOutMarkerAsync(hexAuto))) {
            return true;
          }
        }
      }
    } catch {}
  }

  return false;
}

/**
 * Backwards-compatible two-directory Rockstar session probe (`(profilesDir, launcherLocalDir)`).
 *
 * @param {string} profilesDir
 * @param {string} launcherLocalDir
 * @returns {boolean}
 */
function hasRockstarLocalSessionInDirs(profilesDir, launcherLocalDir) {
  if (launcherLocalDir) {
    return hasRockstarLocalSessionInDir(launcherLocalDir, profilesDir);
  }
  return hasRockstarLocalSessionInDir(profilesDir, '');
}

/**
 * Async counterpart to `hasRockstarLocalSessionInDirs`.
 *
 * @param {string} profilesDir
 * @param {string} launcherLocalDir
 * @returns {Promise<boolean>}
 */
async function hasRockstarLocalSessionInDirsAsync(profilesDir, launcherLocalDir) {
  if (launcherLocalDir) {
    return hasRockstarLocalSessionInDirAsync(launcherLocalDir, profilesDir);
  }
  return hasRockstarLocalSessionInDirAsync(profilesDir, '');
}

/**
 * Read-only, non-PII parser for Riot Client's `RiotGamesPrivateSettings.yaml` (synchronous).
 *
 * @param {string} yamlFilePath
 * @returns {boolean}
 */
function hasRiotLocalSessionInFile(yamlFilePath) {
  if (!yamlFilePath) return false;
  try {
    if (!fs.existsSync(yamlFilePath)) return false;
    const st = fs.statSync(yamlFilePath);
    if (!st.isFile() || st.size === 0 || st.size > 4 * 1024 * 1024) return false;
    return doesRiotPrivateSettingsHaveSession(fs.readFileSync(yamlFilePath, 'utf8'));
  } catch {}
  return false;
}

/**
 * Async counterpart to `hasRiotLocalSessionInFile`.
 *
 * @param {string} yamlFilePath
 * @returns {Promise<boolean>}
 */
async function hasRiotLocalSessionInFileAsync(yamlFilePath) {
  if (!yamlFilePath) return false;
  try {
    const st = await safeStatAsync(yamlFilePath);
    if (!st || !st.isFile() || st.size === 0 || st.size > 4 * 1024 * 1024) return false;
    return doesRiotPrivateSettingsHaveSession(await fs.promises.readFile(yamlFilePath, 'utf8'));
  } catch {}
  return false;
}

/**
 * Check read-only session presence inside a Wine/CrossOver bottle for `handoffId` (synchronous).
 *
 * @param {string} bottlePath
 * @param {ChainedHandoffId} handoffId
 * @returns {boolean}
 */
function probeBottlePublisherSessionReadOnly(bottlePath, handoffId) {
  const driveCRoot = bottlePath ? path.join(bottlePath, 'drive_c') : '';
  const ubiLegacyDir = driveCRoot
    ? resolveDriveCPathCaseInsensitive(driveCRoot, [
        'Program Files (x86)',
        'Ubisoft',
        'Ubisoft Game Launcher',
      ])
    : '';
  const userDirs = listBottleUserDirectories(bottlePath);
  for (const userDir of userDirs) {
    if (handoffId === 'ubisoft') {
      const ubiDir = resolveDriveCPathCaseInsensitive(userDir, [
        'AppData',
        'Local',
        'Ubisoft Game Launcher',
      ]);
      if (hasUbisoftLocalSessionInDir(ubiDir, ubiLegacyDir)) return true;
    } else if (handoffId === 'ea') {
      const eaDir = resolveDriveCPathCaseInsensitive(userDir, [
        'AppData',
        'Local',
        'Electronic Arts',
        'EA Desktop',
      ]);
      if (hasEaLocalSessionInDir(eaDir)) return true;
    } else if (handoffId === 'bnet') {
      const bnetCfg = resolveDriveCPathCaseInsensitive(userDir, [
        'AppData',
        'Roaming',
        'Battle.net',
        'Battle.net.config',
      ]);
      if (hasBattleNetLocalSessionInConfigFile(bnetCfg)) return true;
    } else if (handoffId === 'rockstar') {
      const profilesDir = resolveDriveCPathCaseInsensitive(userDir, [
        'Documents',
        'Rockstar Games',
        'Social Club',
        'Profiles',
      ]);
      const altProfilesDir = resolveDriveCPathCaseInsensitive(userDir, [
        'My Documents',
        'Rockstar Games',
        'Social Club',
        'Profiles',
      ]);
      const launcherLocalDir = resolveDriveCPathCaseInsensitive(userDir, [
        'AppData',
        'Local',
        'Rockstar Games',
        'Launcher',
      ]);
      if (
        hasRockstarLocalSessionInDir(launcherLocalDir, profilesDir) ||
        hasRockstarLocalSessionInDir(launcherLocalDir, altProfilesDir)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Async counterpart to `probeBottlePublisherSessionReadOnly` (zero sync FS).
 *
 * @param {string} bottlePath
 * @param {ChainedHandoffId} handoffId
 * @returns {Promise<boolean>}
 */
async function probeBottlePublisherSessionReadOnlyAsync(bottlePath, handoffId) {
  const driveCRoot = bottlePath ? path.join(bottlePath, 'drive_c') : '';
  const ubiLegacyDir = driveCRoot
    ? await resolveDriveCPathCaseInsensitiveAsync(driveCRoot, [
        'Program Files (x86)',
        'Ubisoft',
        'Ubisoft Game Launcher',
      ])
    : '';
  const userDirs = await listBottleUserDirectoriesAsync(bottlePath);
  for (const userDir of userDirs) {
    if (handoffId === 'ubisoft') {
      const ubiDir = await resolveDriveCPathCaseInsensitiveAsync(userDir, [
        'AppData',
        'Local',
        'Ubisoft Game Launcher',
      ]);
      if (await hasUbisoftLocalSessionInDirAsync(ubiDir, ubiLegacyDir)) return true;
    } else if (handoffId === 'ea') {
      const eaDir = await resolveDriveCPathCaseInsensitiveAsync(userDir, [
        'AppData',
        'Local',
        'Electronic Arts',
        'EA Desktop',
      ]);
      if (await hasEaLocalSessionInDirAsync(eaDir)) return true;
    } else if (handoffId === 'bnet') {
      const bnetCfg = await resolveDriveCPathCaseInsensitiveAsync(userDir, [
        'AppData',
        'Roaming',
        'Battle.net',
        'Battle.net.config',
      ]);
      if (await hasBattleNetLocalSessionInConfigFileAsync(bnetCfg)) return true;
    } else if (handoffId === 'rockstar') {
      const profilesDir = await resolveDriveCPathCaseInsensitiveAsync(userDir, [
        'Documents',
        'Rockstar Games',
        'Social Club',
        'Profiles',
      ]);
      const altProfilesDir = await resolveDriveCPathCaseInsensitiveAsync(userDir, [
        'My Documents',
        'Rockstar Games',
        'Social Club',
        'Profiles',
      ]);
      const launcherLocalDir = await resolveDriveCPathCaseInsensitiveAsync(userDir, [
        'AppData',
        'Local',
        'Rockstar Games',
        'Launcher',
      ]);
      if (
        (await hasRockstarLocalSessionInDirAsync(launcherLocalDir, profilesDir)) ||
        (await hasRockstarLocalSessionInDirAsync(launcherLocalDir, altProfilesDir))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Resolve host OS session target path(s) for `canonical` and `platform`.
 *
 * @param {ChainedHandoffId} canonical
 * @param {string} platform
 * @param {Record<string, any>} [options]
 * @returns {{ kind: string, primary: string, secondary?: string } | null}
 */
function resolveHostSessionProbeTarget(canonical, platform, options = {}) {
  const sandboxHome =
    typeof options.homedir === 'string' && options.homedir.trim() ? options.homedir.trim() : '';
  const home = sandboxHome || os.homedir();
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;

  if (platform === 'win32') {
    const localAppData = sandboxHome
      ? String(options.localAppDataDir || env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
      : String(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'));
    const roamingAppData = sandboxHome
      ? String(options.appDataDir || env.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : String(env.APPDATA || path.join(home, 'AppData', 'Roaming'));
    const documentsDir = path.join(home, 'Documents');

    if (canonical === 'ubisoft') {
      return { kind: 'ubisoft', primary: path.join(localAppData, 'Ubisoft Game Launcher') };
    }
    if (canonical === 'ea') {
      return { kind: 'ea', primary: path.join(localAppData, 'Electronic Arts', 'EA Desktop') };
    }
    if (canonical === 'bnet') {
      return {
        kind: 'bnet',
        primary: path.join(roamingAppData, 'Battle.net', 'Battle.net.config'),
      };
    }
    if (canonical === 'rockstar') {
      return {
        kind: 'rockstar',
        primary: path.join(documentsDir, 'Rockstar Games', 'Social Club', 'Profiles'),
        secondary: path.join(localAppData, 'Rockstar Games', 'Launcher'),
      };
    }
    if (canonical === 'riot') {
      return {
        kind: 'riot',
        primary: path.join(
          localAppData,
          'Riot Games',
          'Riot Client',
          'Data',
          'RiotGamesPrivateSettings.yaml'
        ),
      };
    }
    return null;
  }

  if (platform === 'darwin') {
    if (canonical === 'ea') {
      return {
        kind: 'ea',
        primary: path.join(home, 'Library', 'Application Support', 'Electronic Arts', 'EA app'),
      };
    }
    if (canonical === 'bnet') {
      return {
        kind: 'bnet',
        primary: path.join(home, 'Library', 'Application Support', 'Battle.net', 'Battle.net.config'),
      };
    }
    if (canonical === 'riot') {
      return {
        kind: 'riot',
        primary: path.join(
          home,
          'Library',
          'Application Support',
          'Riot Games',
          'Riot Client',
          'Data',
          'RiotGamesPrivateSettings.yaml'
        ),
      };
    }
  }
  return null;
}

/**
 * Check read-only session presence on the host OS (`win32` or `darwin`) (synchronous).
 *
 * @param {ChainedHandoffId} canonical
 * @param {string} platform
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function probeHostPublisherSessionReadOnly(canonical, platform, options = {}) {
  const target = resolveHostSessionProbeTarget(canonical, platform, options);
  if (!target) return false;
  if (target.kind === 'ubisoft') return hasUbisoftLocalSessionInDir(target.primary);
  if (target.kind === 'ea') return hasEaLocalSessionInDir(target.primary);
  if (target.kind === 'bnet') return hasBattleNetLocalSessionInConfigFile(target.primary);
  if (target.kind === 'rockstar') {
    return hasRockstarLocalSessionInDirs(target.primary, target.secondary || '');
  }
  if (target.kind === 'riot') return hasRiotLocalSessionInFile(target.primary);
  return false;
}

/**
 * Async counterpart to `probeHostPublisherSessionReadOnly` (zero sync FS).
 *
 * @param {ChainedHandoffId} canonical
 * @param {string} platform
 * @param {Record<string, any>} [options]
 * @returns {Promise<boolean>}
 */
async function probeHostPublisherSessionReadOnlyAsync(canonical, platform, options = {}) {
  const target = resolveHostSessionProbeTarget(canonical, platform, options);
  if (!target) return false;
  if (target.kind === 'ubisoft') return hasUbisoftLocalSessionInDirAsync(target.primary);
  if (target.kind === 'ea') return hasEaLocalSessionInDirAsync(target.primary);
  if (target.kind === 'bnet') return hasBattleNetLocalSessionInConfigFileAsync(target.primary);
  if (target.kind === 'rockstar') {
    return hasRockstarLocalSessionInDirsAsync(target.primary, target.secondary || '');
  }
  if (target.kind === 'riot') return hasRiotLocalSessionInFileAsync(target.primary);
  return false;
}

// ============================================================================
// Bottle & Host Publisher Launcher Discovery (Sync + Async)
// ============================================================================

/**
 * Discover whether a chained publisher launcher (`'ubisoft' | 'ea' | 'bnet' | 'rockstar'`)
 * is installed inside a macOS Wine/CrossOver bottle (synchronous).
 *
 * @param {string} bottlePath
 * @param {string} handoffId
 * @param {Record<string, any>} [options]
 * @returns {DiscoveredPublisherLauncherInfo}
 */
function discoverBottlePublisherLauncher(bottlePath, handoffId, options = {}) {
  const canonical = normalizeChainedHandoffId(handoffId);
  if (canonical === 'riot') {
    return {
      installed: false,
      hasLocalSession: false,
      unsupportedBottleReason: CHAINED_PUBLISHER_ECOSYSTEMS.riot.unsupportedBottleReason,
    };
  }
  if (!bottlePath || !canonical) {
    return { installed: false, hasLocalSession: false };
  }
  const driveCRoot = path.join(bottlePath, 'drive_c');
  try {
    if (!fs.existsSync(driveCRoot)) {
      return { installed: false, hasLocalSession: false };
    }
  } catch {
    return { installed: false, hasLocalSession: false };
  }

  const sections = getBottleSystemRegSections(bottlePath, options);
  const {
    winExeCandidates,
    winLauncherAppCandidates,
    winBgServiceCandidates,
    version: regVersion,
    regInstallDirWin,
  } = collectBottlePublisherCandidates(canonical, sections);
  let version = regVersion;
  const regInstallDirPosix = regInstallDirWin
    ? resolveBottleWindowsPathReadOnly(regInstallDirWin, bottlePath, options)
    : undefined;

  /** @type {string | undefined} */
  let foundBinaryPath;
  for (const winCand of winExeCandidates) {
    const hostCand = resolveBottleWindowsPathReadOnly(winCand, bottlePath, options);
    if (!hostCand) continue;
    try {
      const st = fs.statSync(hostCand);
      if (st.isFile() && st.size > 0) {
        foundBinaryPath = hostCand;
        break;
      }
    } catch {}
  }

  const hasLocalSession = probeBottlePublisherSessionReadOnly(bottlePath, canonical);
  if (!foundBinaryPath) {
    return { installed: false, hasLocalSession };
  }

  const installDir =
    regInstallDirPosix && fs.existsSync(regInstallDirPosix)
      ? regInstallDirPosix
      : path.dirname(foundBinaryPath);

  /** @type {string | undefined} */
  let launcherAppPath;
  /** @type {string | undefined} */
  let backgroundServicePath;

  if (canonical === 'ea') {
    const clientDir = path.dirname(foundBinaryPath);
    const siblingLauncher = resolveDriveCPathCaseInsensitive(clientDir, ['EALauncher.exe']);
    const launcherHostCandidates = [
      siblingLauncher,
      ...winLauncherAppCandidates.map((w) => resolveBottleWindowsPathReadOnly(w, bottlePath, options)),
    ].filter(Boolean);
    for (const cand of launcherHostCandidates) {
      try {
        const st = fs.statSync(cand);
        if (st.isFile() && st.size > 0) {
          launcherAppPath = cand;
          break;
        }
      } catch {}
    }

    const siblingBg = resolveDriveCPathCaseInsensitive(clientDir, ['EABackgroundService.exe']);
    const bgHostCandidates = [
      siblingBg,
      ...winBgServiceCandidates.map((w) => resolveBottleWindowsPathReadOnly(w, bottlePath, options)),
    ].filter(Boolean);
    for (const cand of bgHostCandidates) {
      try {
        const st = fs.statSync(cand);
        if (st.isFile() && st.size > 0) {
          backgroundServicePath = cand;
          break;
        }
      } catch {}
    }

    if (!version) {
      const parentClientDir = path.dirname(clientDir);
      version =
        readEaVersionFromPropertiesFile(
          resolveDriveCPathCaseInsensitive(clientDir, ['version.properties'])
        ) ||
        (/ea desktop$/i.test(path.basename(parentClientDir))
          ? readEaVersionFromPropertiesFile(
              resolveDriveCPathCaseInsensitive(parentClientDir, ['version.properties'])
            )
          : undefined) ||
        readEaVersionFromPropertiesFile(
          resolveDriveCPathCaseInsensitive(installDir, ['EA Desktop', 'version.properties'])
        ) ||
        readEaVersionFromPropertiesFile(
          resolveDriveCPathCaseInsensitive(installDir, ['version.properties'])
        );
    }

    if (!version) {
      version = findEaVersionInUninstallSections(sections);
    }
  }

  return {
    installed: true,
    binaryPath: foundBinaryPath,
    ...(launcherAppPath ? { launcherAppPath } : {}),
    ...(backgroundServicePath ? { backgroundServicePath } : {}),
    installDir,
    ...(version ? { version } : {}),
    hasLocalSession,
  };
}

/**
 * Non-blocking async counterpart to `discoverBottlePublisherLauncher` using strictly `fs.promises`
 * and async `execFile` for `xattr` (zero main-thread sync I/O or `execFileSync`).
 *
 * @param {string} bottlePath
 * @param {string} handoffId
 * @param {Record<string, any>} [options]
 * @returns {Promise<DiscoveredPublisherLauncherInfo>}
 */
async function discoverBottlePublisherLauncherAsync(bottlePath, handoffId, options = {}) {
  const canonical = normalizeChainedHandoffId(handoffId);
  if (canonical === 'riot') {
    return {
      installed: false,
      hasLocalSession: false,
      unsupportedBottleReason: CHAINED_PUBLISHER_ECOSYSTEMS.riot.unsupportedBottleReason,
    };
  }
  if (!bottlePath || !canonical) {
    return { installed: false, hasLocalSession: false };
  }
  const driveCRoot = path.join(bottlePath, 'drive_c');
  if (!(await pathExistsAsync(driveCRoot))) {
    return { installed: false, hasLocalSession: false };
  }

  const sections = await getBottleSystemRegSectionsAsync(bottlePath, options);
  const {
    winExeCandidates,
    winLauncherAppCandidates,
    winBgServiceCandidates,
    version: regVersion,
    regInstallDirWin,
  } = collectBottlePublisherCandidates(canonical, sections);
  let version = regVersion;
  const regInstallDirPosix = regInstallDirWin
    ? await resolveBottleWindowsPathReadOnlyAsync(regInstallDirWin, bottlePath, options)
    : undefined;

  const sessionPromise = probeBottlePublisherSessionReadOnlyAsync(bottlePath, canonical);

  /** @type {string | undefined} */
  let foundBinaryPath;
  for (const winCand of winExeCandidates) {
    const hostCand = await resolveBottleWindowsPathReadOnlyAsync(winCand, bottlePath, options);
    if (!hostCand) continue;
    const st = await safeStatAsync(hostCand);
    if (st && st.isFile() && st.size > 0) {
      foundBinaryPath = hostCand;
      break;
    }
  }

  const hasLocalSession = await sessionPromise;
  if (!foundBinaryPath) {
    return { installed: false, hasLocalSession };
  }

  const installDir =
    regInstallDirPosix && (await pathExistsAsync(regInstallDirPosix))
      ? regInstallDirPosix
      : path.dirname(foundBinaryPath);

  /** @type {string | undefined} */
  let launcherAppPath;
  /** @type {string | undefined} */
  let backgroundServicePath;

  if (canonical === 'ea') {
    const clientDir = path.dirname(foundBinaryPath);
    const siblingLauncher = await resolveDriveCPathCaseInsensitiveAsync(clientDir, [
      'EALauncher.exe',
    ]);
    const resolvedLaunchers = await Promise.all(
      winLauncherAppCandidates.map((w) =>
        resolveBottleWindowsPathReadOnlyAsync(w, bottlePath, options)
      )
    );
    for (const cand of [siblingLauncher, ...resolvedLaunchers].filter(Boolean)) {
      const st = await safeStatAsync(cand);
      if (st && st.isFile() && st.size > 0) {
        launcherAppPath = cand;
        break;
      }
    }

    const siblingBg = await resolveDriveCPathCaseInsensitiveAsync(clientDir, [
      'EABackgroundService.exe',
    ]);
    const resolvedBgs = await Promise.all(
      winBgServiceCandidates.map((w) =>
        resolveBottleWindowsPathReadOnlyAsync(w, bottlePath, options)
      )
    );
    for (const cand of [siblingBg, ...resolvedBgs].filter(Boolean)) {
      const st = await safeStatAsync(cand);
      if (st && st.isFile() && st.size > 0) {
        backgroundServicePath = cand;
        break;
      }
    }

    if (!version) {
      const parentClientDir = path.dirname(clientDir);
      const versionCandidates = [
        await resolveDriveCPathCaseInsensitiveAsync(clientDir, ['version.properties']),
        ...(/ea desktop$/i.test(path.basename(parentClientDir))
          ? [await resolveDriveCPathCaseInsensitiveAsync(parentClientDir, ['version.properties'])]
          : []),
        await resolveDriveCPathCaseInsensitiveAsync(installDir, [
          'EA Desktop',
          'version.properties',
        ]),
        await resolveDriveCPathCaseInsensitiveAsync(installDir, ['version.properties']),
      ];
      for (const verPath of versionCandidates) {
        const v = await readEaVersionFromPropertiesFileAsync(verPath);
        if (v) {
          version = v;
          break;
        }
      }
    }

    if (!version) {
      version = findEaVersionInUninstallSections(sections);
    }
  }

  return {
    installed: true,
    binaryPath: foundBinaryPath,
    ...(launcherAppPath ? { launcherAppPath } : {}),
    ...(backgroundServicePath ? { backgroundServicePath } : {}),
    installDir,
    ...(version ? { version } : {}),
    hasLocalSession,
  };
}

/**
 * Detect native macOS `.app` publisher launcher bundles on `darwin` for `'ea'` (`EA app.app`),
 * `'bnet'` (`Battle.net.app`), and `'riot'` (`Riot Client.app`) (synchronous).
 *
 * @param {string} handoffId
 * @param {Record<string, any>} [options]
 * @returns {{
 *   installed: boolean,
 *   handoffId: ChainedHandoffId | null,
 *   appBundlePath: string | null,
 *   binaryPath: string | null,
 *   installDir?: string,
 *   launcherAppPath?: string,
 *   backgroundServicePath?: string,
 *   version?: string,
 * }}
 */
function detectMacNativePublisherBundle(handoffId, options = {}) {
  const canonical = normalizeChainedHandoffId(handoffId);
  if (!canonical || canonical === 'ubisoft' || canonical === 'rockstar') {
    return {
      installed: false,
      handoffId: canonical,
      appBundlePath: null,
      binaryPath: null,
    };
  }

  const { appRoots, sharedRiotDir } = resolveDarwinBundleRoots(options);

  if (canonical === 'ea') {
    for (const appRoot of appRoots) {
      const appBundle = path.join(appRoot, 'EA app.app');
      const eaDesktopBin = path.join(appBundle, 'Contents', 'MacOS', 'EADesktop');
      const eaAppBin = path.join(appBundle, 'Contents', 'MacOS', 'EA app');
      try {
        const macBin = fs.existsSync(eaDesktopBin)
          ? eaDesktopBin
          : fs.existsSync(eaAppBin)
            ? eaAppBin
            : '';
        if (macBin) {
          const version = readMacAppBundleVersionReadOnly(appBundle);
          const helperLauncher = path.join(
            appBundle,
            'Contents',
            'Applications',
            'EALauncher.app',
            'Contents',
            'MacOS',
            'EALauncher'
          );
          const helperBg = path.join(
            appBundle,
            'Contents',
            'Applications',
            'EABackgroundService.app',
            'Contents',
            'MacOS',
            'EABackgroundService'
          );
          return {
            installed: true,
            handoffId: 'ea',
            appBundlePath: appBundle,
            binaryPath: macBin,
            ...(fs.existsSync(helperLauncher) ? { launcherAppPath: helperLauncher } : {}),
            ...(fs.existsSync(helperBg) ? { backgroundServicePath: helperBg } : {}),
            installDir: appBundle,
            ...(version ? { version } : {}),
          };
        }
      } catch {}
    }
    return { installed: false, handoffId: 'ea', appBundlePath: null, binaryPath: null };
  }

  if (canonical === 'bnet') {
    for (const appRoot of appRoots) {
      const appBundle = path.join(appRoot, 'Battle.net.app');
      const macBin = path.join(appBundle, 'Contents', 'MacOS', 'Battle.net');
      try {
        if (fs.existsSync(macBin)) {
          const version = readMacAppBundleVersionReadOnly(appBundle);
          return {
            installed: true,
            handoffId: 'bnet',
            appBundlePath: appBundle,
            binaryPath: macBin,
            installDir: appBundle,
            ...(version ? { version } : {}),
          };
        }
      } catch {}
    }
    return { installed: false, handoffId: 'bnet', appBundlePath: null, binaryPath: null };
  }

  if (canonical === 'riot') {
    /** @type {string[]} */
    const bundleCandidates = [];
    if (sharedRiotDir) {
      const installsJson = path.join(sharedRiotDir, 'RiotClientInstalls.json');
      try {
        if (fs.existsSync(installsJson)) {
          const parsed = JSON.parse(fs.readFileSync(installsJson, 'utf8'));
          for (const k of ['rc_default', 'rc_live', 'rc_beta']) {
            if (typeof parsed?.[k] === 'string' && parsed[k].trim()) {
              bundleCandidates.push(parsed[k].trim());
            }
          }
        }
      } catch {}
      bundleCandidates.push(path.join(sharedRiotDir, 'Riot Client.app'));
    }
    for (const appRoot of appRoots) {
      bundleCandidates.push(path.join(appRoot, 'Riot Client.app'));
    }
    for (const cand of bundleCandidates) {
      if (!cand) continue;
      try {
        if (!fs.existsSync(cand)) continue;
        const st = fs.statSync(cand);
        if (st.isFile()) {
          const inferredBundle = /\.app\/Contents\/MacOS\/[^/]+$/i.test(cand)
            ? path.resolve(cand, '..', '..', '..')
            : null;
          const version = inferredBundle
            ? readMacAppBundleVersionReadOnly(inferredBundle)
            : undefined;
          return {
            installed: true,
            handoffId: 'riot',
            appBundlePath: inferredBundle || path.dirname(cand),
            binaryPath: cand,
            installDir: inferredBundle || path.dirname(cand),
            ...(version ? { version } : {}),
          };
        }
        if (st.isDirectory()) {
          const macServicesBin = path.join(cand, 'Contents', 'MacOS', 'RiotClientServices');
          const macRiotBin = path.join(cand, 'Contents', 'MacOS', 'Riot Client');
          const resolvedBin = fs.existsSync(macServicesBin)
            ? macServicesBin
            : fs.existsSync(macRiotBin)
              ? macRiotBin
              : '';
          if (resolvedBin) {
            const version = readMacAppBundleVersionReadOnly(cand);
            return {
              installed: true,
              handoffId: 'riot',
              appBundlePath: cand,
              binaryPath: resolvedBin,
              installDir: cand,
              ...(version ? { version } : {}),
            };
          }
        }
      } catch {}
    }
    return { installed: false, handoffId: 'riot', appBundlePath: null, binaryPath: null };
  }

  return { installed: false, handoffId: canonical, appBundlePath: null, binaryPath: null };
}

/**
 * Non-blocking async counterpart to `detectMacNativePublisherBundle` using `fs.promises` and
 * async `PlistBuddy` execution (zero main-thread sync I/O or `execFileSync`).
 *
 * @param {string} handoffId
 * @param {Record<string, any>} [options]
 * @returns {Promise<{
 *   installed: boolean,
 *   handoffId: ChainedHandoffId | null,
 *   appBundlePath: string | null,
 *   binaryPath: string | null,
 *   installDir?: string,
 *   launcherAppPath?: string,
 *   backgroundServicePath?: string,
 *   version?: string,
 * }>}
 */
async function detectMacNativePublisherBundleAsync(handoffId, options = {}) {
  const canonical = normalizeChainedHandoffId(handoffId);
  if (!canonical || canonical === 'ubisoft' || canonical === 'rockstar') {
    return {
      installed: false,
      handoffId: canonical,
      appBundlePath: null,
      binaryPath: null,
    };
  }

  const { appRoots, sharedRiotDir } = resolveDarwinBundleRoots(options);

  if (canonical === 'ea') {
    for (const appRoot of appRoots) {
      const appBundle = path.join(appRoot, 'EA app.app');
      const eaDesktopBin = path.join(appBundle, 'Contents', 'MacOS', 'EADesktop');
      const eaAppBin = path.join(appBundle, 'Contents', 'MacOS', 'EA app');
      try {
        const macBin = (await pathExistsAsync(eaDesktopBin))
          ? eaDesktopBin
          : (await pathExistsAsync(eaAppBin))
            ? eaAppBin
            : '';
        if (macBin) {
          const helperLauncher = path.join(
            appBundle,
            'Contents',
            'Applications',
            'EALauncher.app',
            'Contents',
            'MacOS',
            'EALauncher'
          );
          const helperBg = path.join(
            appBundle,
            'Contents',
            'Applications',
            'EABackgroundService.app',
            'Contents',
            'MacOS',
            'EABackgroundService'
          );
          const [version, hasLauncher, hasBg] = await Promise.all([
            readMacAppBundleVersionReadOnlyAsync(appBundle, options),
            pathExistsAsync(helperLauncher),
            pathExistsAsync(helperBg),
          ]);
          return {
            installed: true,
            handoffId: 'ea',
            appBundlePath: appBundle,
            binaryPath: macBin,
            ...(hasLauncher ? { launcherAppPath: helperLauncher } : {}),
            ...(hasBg ? { backgroundServicePath: helperBg } : {}),
            installDir: appBundle,
            ...(version ? { version } : {}),
          };
        }
      } catch {}
    }
    return { installed: false, handoffId: 'ea', appBundlePath: null, binaryPath: null };
  }

  if (canonical === 'bnet') {
    for (const appRoot of appRoots) {
      const appBundle = path.join(appRoot, 'Battle.net.app');
      const macBin = path.join(appBundle, 'Contents', 'MacOS', 'Battle.net');
      try {
        if (await pathExistsAsync(macBin)) {
          const version = await readMacAppBundleVersionReadOnlyAsync(appBundle, options);
          return {
            installed: true,
            handoffId: 'bnet',
            appBundlePath: appBundle,
            binaryPath: macBin,
            installDir: appBundle,
            ...(version ? { version } : {}),
          };
        }
      } catch {}
    }
    return { installed: false, handoffId: 'bnet', appBundlePath: null, binaryPath: null };
  }

  if (canonical === 'riot') {
    /** @type {string[]} */
    const bundleCandidates = [];
    if (sharedRiotDir) {
      const installsJson = path.join(sharedRiotDir, 'RiotClientInstalls.json');
      try {
        const parsed = JSON.parse(await fs.promises.readFile(installsJson, 'utf8'));
        for (const k of ['rc_default', 'rc_live', 'rc_beta']) {
          if (typeof parsed?.[k] === 'string' && parsed[k].trim()) {
            bundleCandidates.push(parsed[k].trim());
          }
        }
      } catch {}
      bundleCandidates.push(path.join(sharedRiotDir, 'Riot Client.app'));
    }
    for (const appRoot of appRoots) {
      bundleCandidates.push(path.join(appRoot, 'Riot Client.app'));
    }
    for (const cand of bundleCandidates) {
      if (!cand) continue;
      const st = await safeStatAsync(cand);
      if (!st) continue;
      if (st.isFile()) {
        const inferredBundle = /\.app\/Contents\/MacOS\/[^/]+$/i.test(cand)
          ? path.resolve(cand, '..', '..', '..')
          : null;
        const version = inferredBundle
          ? await readMacAppBundleVersionReadOnlyAsync(inferredBundle, options)
          : undefined;
        return {
          installed: true,
          handoffId: 'riot',
          appBundlePath: inferredBundle || path.dirname(cand),
          binaryPath: cand,
          installDir: inferredBundle || path.dirname(cand),
          ...(version ? { version } : {}),
        };
      }
      if (st.isDirectory()) {
        const macServicesBin = path.join(cand, 'Contents', 'MacOS', 'RiotClientServices');
        const macRiotBin = path.join(cand, 'Contents', 'MacOS', 'Riot Client');
        const resolvedBin = (await pathExistsAsync(macServicesBin))
          ? macServicesBin
          : (await pathExistsAsync(macRiotBin))
            ? macRiotBin
            : '';
        if (resolvedBin) {
          const version = await readMacAppBundleVersionReadOnlyAsync(cand, options);
          return {
            installed: true,
            handoffId: 'riot',
            appBundlePath: cand,
            binaryPath: resolvedBin,
            installDir: cand,
            ...(version ? { version } : {}),
          };
        }
      }
    }
    return { installed: false, handoffId: 'riot', appBundlePath: null, binaryPath: null };
  }

  return { installed: false, handoffId: canonical, appBundlePath: null, binaryPath: null };
}

/**
 * Format discovered host launcher output consistently across `win32` and `darwin`.
 *
 * @param {{
 *   binaryPath?: string | null,
 *   launcherAppPath?: string,
 *   backgroundServicePath?: string,
 *   installDir?: string,
 *   version?: string,
 * }} found
 * @param {boolean} hasLocalSession
 * @returns {DiscoveredPublisherLauncherInfo}
 */
function formatHostDiscoveryResult(found, hasLocalSession) {
  if (!found || !found.binaryPath) {
    return { installed: false, hasLocalSession };
  }
  return {
    installed: true,
    binaryPath: found.binaryPath,
    ...(found.launcherAppPath ? { launcherAppPath: found.launcherAppPath } : {}),
    ...(found.backgroundServicePath ? { backgroundServicePath: found.backgroundServicePath } : {}),
    ...(found.installDir ? { installDir: found.installDir } : {}),
    ...(found.version ? { version: found.version } : {}),
    hasLocalSession,
  };
}

/**
 * Discover whether a publisher launcher (`'ubisoft' | 'ea' | 'bnet' | 'rockstar' | 'riot'`)
 * is installed natively on the host OS (`win32` or `darwin`) (synchronous).
 *
 * @param {string} handoffId
 * @param {Record<string, any>} [options]
 * @returns {DiscoveredPublisherLauncherInfo}
 */
function discoverHostPublisherLauncher(handoffId, options = {}) {
  const canonical = normalizeChainedHandoffId(handoffId);
  const platform = String(options.platform || process.platform).toLowerCase();
  if (!canonical) {
    return { installed: false, hasLocalSession: false };
  }

  if (platform === 'win32') {
    const winFound = discoverWindowsPublisherLauncherPaths(canonical, options);
    const hasLocalSession = probeHostPublisherSessionReadOnly(canonical, 'win32', options);
    return formatHostDiscoveryResult(winFound, hasLocalSession);
  }

  if (platform === 'darwin') {
    if (canonical === 'ubisoft' || canonical === 'rockstar') {
      return { installed: false, hasLocalSession: false };
    }
    const hasLocalSession = probeHostPublisherSessionReadOnly(canonical, 'darwin', options);
    const macBundle = detectMacNativePublisherBundle(canonical, options);
    return formatHostDiscoveryResult(
      macBundle.installed ? macBundle : { binaryPath: null },
      hasLocalSession
    );
  }

  return { installed: false, hasLocalSession: false };
}

/**
 * Non-blocking async counterpart to `discoverHostPublisherLauncher` using `fs.promises`,
 * `discoverWindowsPublisherLauncherPathsAsync`, and async `PlistBuddy` execution.
 *
 * @param {string} handoffId
 * @param {Record<string, any>} [options]
 * @returns {Promise<DiscoveredPublisherLauncherInfo>}
 */
async function discoverHostPublisherLauncherAsync(handoffId, options = {}) {
  const canonical = normalizeChainedHandoffId(handoffId);
  const platform = String(options.platform || process.platform).toLowerCase();
  if (!canonical) {
    return { installed: false, hasLocalSession: false };
  }

  if (platform === 'win32') {
    const [winFound, hasLocalSession] = await Promise.all([
      discoverWindowsPublisherLauncherPathsAsync(canonical, options),
      probeHostPublisherSessionReadOnlyAsync(canonical, 'win32', options),
    ]);
    return formatHostDiscoveryResult(winFound, hasLocalSession);
  }

  if (platform === 'darwin') {
    if (canonical === 'ubisoft' || canonical === 'rockstar') {
      return { installed: false, hasLocalSession: false };
    }
    const [hasLocalSession, macBundle] = await Promise.all([
      probeHostPublisherSessionReadOnlyAsync(canonical, 'darwin', options),
      detectMacNativePublisherBundleAsync(canonical, options),
    ]);
    return formatHostDiscoveryResult(
      macBundle.installed ? macBundle : { binaryPath: null },
      hasLocalSession
    );
  }

  return { installed: false, hasLocalSession: false };
}

module.exports = {
  hasUbisoftLocalSessionInDir,
  hasUbisoftLocalSessionInDirAsync,
  hasEaLocalSessionInDir,
  hasEaLocalSessionInDirAsync,
  readEaVersionFromPropertiesFile,
  readEaVersionFromPropertiesFileAsync,
  readMacAppBundleVersionReadOnly,
  readMacAppBundleVersionReadOnlyAsync,
  hasBattleNetLocalSessionInConfigFile,
  hasBattleNetLocalSessionInConfigFileAsync,
  hasRockstarLocalSessionInDir,
  hasRockstarLocalSessionInDirAsync,
  hasRockstarLocalSessionInDirs,
  hasRockstarLocalSessionInDirsAsync,
  hasRiotLocalSessionInFile,
  hasRiotLocalSessionInFileAsync,
  probeBottlePublisherSessionReadOnly,
  probeBottlePublisherSessionReadOnlyAsync,
  probeHostPublisherSessionReadOnly,
  probeHostPublisherSessionReadOnlyAsync,
  detectMacNativePublisherBundle,
  detectMacNativePublisherBundleAsync,
  discoverBottlePublisherLauncher,
  discoverBottlePublisherLauncherAsync,
  discoverHostPublisherLauncher,
  discoverHostPublisherLauncherAsync,
};
