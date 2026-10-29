const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const {
  diagLog,
  getXboxStorefrontModules,
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,
  hasManagedInstallSentinel,
  registerExternalCacheInvalidator,
} = require('./engineStateRegistry.cjs');
const {
  discoverWindowsLocalDrivesAsync,
  getCachedWindowsLocalDrives,
  getDefaultInstallDir,
  getDirectorySizeFast,
  hasWindowsGamingServicesInstalled,
} = require('./diskAndVolumeInspector.cjs');
const {
  isExcludedExecutable,
  findPrimaryExecutable,
  listAllInitializedBottlePaths,
} = require('./macNativeInstallerAndCodesign.cjs');
const {
  sanitizeGameInstallSizeBytes,
  inspectWindowsExecutableHeader,
  isCompatibleX86OrX64PeHeader,
  resolveCaseInsensitiveRelFile,
  parseGamingRootFile,
  deriveDefaultScidFromTitleId,
  inspectMicrosoftGameConfig,
  inspectAppxManifest,
} = require('./binaryAndManifestInspectors.cjs');

const GAMING_SERVICES_REG_CACHE_TTL_MS = 15_000;

/** @type {{ timestamp: number, output: string, inFlight: Promise<string> | null }} */
let gamingServicesRegCache = {
  timestamp: 0,
  output: '',
  inFlight: null,
};

registerExternalCacheInvalidator(() => {
  gamingServicesRegCache = { timestamp: 0, output: '', inFlight: null };
});

/**
 * Safely escape a string for PowerShell single-quoted literals (`'` -> `''`).
 */
function escapePowerShellSingleQuoted(raw) {
  return String(raw ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/'/g, "''");
}

/**
 * Derive the Appx `Identity.Name` from an explicit `identityName` or a `PackageFamilyName`
 * (`<IdentityName>_<13CharPublisherHash>`).
 */
function deriveAppxIdentityName(identityOrPfn) {
  const clean = String(identityOrPfn || '').trim();
  if (!clean) return '';
  const pfnMatch = clean.match(/^(.+)_[0-9a-hjkmnp-tv-z]{13}$/i);
  if (pfnMatch && pfnMatch[1]) {
    return pfnMatch[1].trim();
  }
  return clean;
}

function parseGamingServicesRegistryRoots(regOutput) {
  /** @type {string[]} */
  const roots = [];
  if (typeof regOutput !== 'string' || !regOutput.trim()) return roots;

  // Support both UTF-8 PowerShell JSON arrays/strings and legacy `reg.exe query` text output
  const trimmed = regOutput.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{') || trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const val =
          typeof item === 'string'
            ? item.trim()
            : item && typeof item === 'object'
              ? String(item.Root || item.root || '').trim()
              : '';
        if (val) roots.push(val);
      }
      if (roots.length > 0) return roots;
    } catch {}
  }

  for (const line of regOutput.split(/\r?\n/)) {
    const m = /^\s*Root\s+REG_SZ\s+(.+)$/i.exec(line);
    if (m && m[1]) {
      const candidate = m[1].trim();
      if (candidate) roots.push(candidate);
    }
  }
  return roots;
}

/**
 * Prime local Windows drive list and GamingServices registry roots asynchronously off the main thread.
 */
async function primeXboxDiscoveryCachesAsync(/** @type {any} */ options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return;

  const isIsolatedTest = Boolean(
    isTestEnvironment(options) ||
      options.homedir ||
      options.userDataDir ||
      (options.customRoots && options.customRoots.length > 0)
  );

  await discoverWindowsLocalDrivesAsync(options);

  if (
    isIsolatedTest ||
    options.skipRegistrySpawn ||
    typeof options.gamingServicesRegistryOutput === 'string'
  ) {
    return;
  }

  const now = Date.now();
  if (
    gamingServicesRegCache.timestamp > 0 &&
    now - gamingServicesRegCache.timestamp < GAMING_SERVICES_REG_CACHE_TTL_MS
  ) {
    return;
  }
  if (gamingServicesRegCache.inFlight) {
    await gamingServicesRegCache.inFlight;
    return;
  }

  const execFileFn =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;

  if (process.platform !== 'win32' && execFileFn === execFile) {
    return;
  }

  const psScript =
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    "$p = 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\GamingServices\\PackageRepository\\Package'; " +
    'if (Test-Path -LiteralPath $p) { ' +
    '  Get-ChildItem -LiteralPath $p -ErrorAction SilentlyContinue | ForEach-Object { ' +
    "    $prop = Get-ItemProperty -LiteralPath $_.PSPath -Name 'Root' -ErrorAction SilentlyContinue; " +
    '    if ($null -ne $prop -and $prop.Root) { $prop.Root } ' +
    '  } | ConvertTo-Json -Compress ' +
    '}';

  const regPromise = new Promise((resolve) => {
    try {
      execFileFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { timeout: 3000, windowsHide: true },
        (/** @type {any} */ err, /** @type {any} */ stdout) => {
          const out = !err ? String(stdout || '') : '';
          gamingServicesRegCache = {
            timestamp: Date.now(),
            output: out,
            inFlight: null,
          };
          resolve(out);
        }
      );
    } catch {
      gamingServicesRegCache = {
        timestamp: Date.now(),
        output: '',
        inFlight: null,
      };
      resolve('');
    }
  });

  gamingServicesRegCache.inFlight = regPromise;
  await regPromise;
}

function isXboxChildGameFolder(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) return false;
  const clean = dirPath.trim();
  try {
    if (!fs.existsSync(clean)) return false;
    const markers = [
      'MicrosoftGame.config',
      'MicrosoftGame.Config',
      'microsoftgame.config',
      path.join('Content', 'MicrosoftGame.config'),
      path.join('Content', 'MicrosoftGame.Config'),
      path.join('Content', 'microsoftgame.config'),
      'AppxManifest.xml',
      'appxmanifest.xml',
      path.join('Content', 'AppxManifest.xml'),
      path.join('Content', 'appxmanifest.xml'),
      '.onelauncher-xbox-receipt.json',
      '.onelauncher-xbox-journal.json',
      '.onelauncher-xbox-install.json',
    ];
    for (const rel of markers) {
      if (fs.existsSync(path.join(clean, rel))) {
        return true;
      }
    }
    if (hasManagedInstallSentinel(clean, 'xbox')) {
      return true;
    }
    const ciRelMarkers = [
      'microsoftgame.config',
      'Content/microsoftgame.config',
      'appxmanifest.xml',
      'Content/appxmanifest.xml',
    ];
    for (const rel of ciRelMarkers) {
      if (resolveCaseInsensitiveRelFile(clean, rel)) {
        return true;
      }
    }
  } catch {}
  return false;
}

/**
 * Bounded read-only scan of `rootDir` (depth <= 6) locating the best runnable `AMD64` (`0x8664`)
 * or `I386` (`0x014c`) `.exe` when a generic directory scan accidentally hit an `ARM64` (`0xaa64`) helper.
 *
 * @param {string} rootDir
 * @param {{ strictPe?: boolean, platform?: string, arch?: string }} [options]
 * @returns {string}
 */
function findBestX86OrX64WindowsExe(rootDir, options = {}) {
  let bestPath = '';
  let bestScore = -Infinity;
  const walk = (/** @type {string} */ currentDir, /** @type {number} */ depth) => {
    if (!currentDir || depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const fullPath = path.join(currentDir, ent.name);
      if (ent.isDirectory()) {
        if (!ent.isSymbolicLink() && depth < 6) {
          walk(fullPath, depth + 1);
        }
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.exe')) {
        if (ent.name.toLowerCase().endsWith('.olpart') || isExcludedExecutable(ent.name)) {
          continue;
        }
        const pe = inspectWindowsExecutableHeader(fullPath, {
          strictPe: Boolean(options.strictPe),
        });
        if (
          !isCompatibleX86OrX64PeHeader(pe, {
            hostPlatform: options.platform,
            hostArch: options.arch,
          })
        ) {
          continue;
        }
        let score = 100 - depth * 10;
        if (pe.isX64) score += 45;
        else if (pe.isX86) score += 20;
        if (score > bestScore) {
          bestScore = score;
          bestPath = fullPath;
        }
      }
    }
  };
  walk(rootDir, 0);
  return bestPath;
}

function isWindowsAppsProtectedPath(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) return false;
  return /(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(dirPath.trim());
}

function hasXboxClientlessReceipt(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) return false;
  const clean = dirPath.trim();
  return (
    fs.existsSync(path.join(clean, '.onelauncher-xbox-receipt.json')) ||
    fs.existsSync(path.join(clean, '.onelauncher-xbox-install.json')) ||
    hasManagedInstallSentinel(clean, 'xbox')
  );
}

/**
 * Shared non-blocking helper collecting both parent Xbox library roots and direct child game folders
 * without synchronous A:\..Z:\ loops or synchronous registry spawns.
 */
function resolveXboxDiscoveryLocations(/** @type {any} */ options = {}) {
  const platform = options.platform || process.platform;
  const { homedir } = resolveIsolatedHomedirAndUserData(options);
  const customRoots = Array.isArray(options.customRoots) ? options.customRoots : [];
  const isIsolatedTest = Boolean(
    isTestEnvironment(options) ||
      options.homedir ||
      options.userDataDir ||
      (options.customRoots && options.customRoots.length > 0)
  );

  /** @type {string[]} */
  const orderedLibraryRoots = [];
  const seenParentKeys = new Set();
  const modifiableRoots = new Set();
  const directChildGameDirs = new Set();

  const addParentRoot = (/** @type {any} */ dir) => {
    if (typeof dir !== 'string' || !dir.trim()) return;
    const trimmed = dir.trim();
    if (isWindowsAppsProtectedPath(trimmed)) return;
    if (isXboxChildGameFolder(trimmed)) return;
    const normKey =
      platform === 'win32'
        ? trimmed.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
        : path.resolve(trimmed);
    if (!seenParentKeys.has(normKey)) {
      seenParentKeys.add(normKey);
      orderedLibraryRoots.push(trimmed);
    }
  };

  addParentRoot(getDefaultInstallDir('xbox', { ...options, platform, homedir }));
  if (platform === 'win32' && !options.homedir) {
    addParentRoot(
      getDefaultInstallDir('xbox', {
        ...options,
        platform,
        homedir,
        clientlessMsixvc: true,
      })
    );
  }

  if (Array.isArray(options.xboxGamesDirs)) {
    for (const d of options.xboxGamesDirs) {
      if (typeof d !== 'string' || !d.trim()) continue;
      const trimmed = d.trim();
      if (isXboxChildGameFolder(trimmed)) {
        directChildGameDirs.add(trimmed);
      } else {
        addParentRoot(trimmed);
      }
    }
  }

  for (const rawRoot of customRoots) {
    if (typeof rawRoot !== 'string' || !rawRoot.trim()) continue;
    const root = rawRoot.trim();
    if (isXboxChildGameFolder(root)) {
      directChildGameDirs.add(root);
    }
    const gr = parseGamingRootFile(path.join(root, '.GamingRoot'), root);
    if (gr && gr.resolvedPath) {
      addParentRoot(gr.resolvedPath);
    }
    const subXboxGames = path.join(root, 'XboxGames');
    if (fs.existsSync(subXboxGames)) {
      addParentRoot(subXboxGames);
    }
    const subXbox = path.join(root, 'Xbox');
    if (fs.existsSync(subXbox)) {
      addParentRoot(subXbox);
    }
    const modWinApps = path.join(root, 'ModifiableWindowsApps');
    if (fs.existsSync(modWinApps)) {
      modifiableRoots.add(modWinApps);
    }
    addParentRoot(root);
  }

  if (
    platform === 'win32' &&
    (!isIsolatedTest ||
      options.scanWindowsDrives === true ||
      Array.isArray(options.windowsDriveRoots) ||
      typeof options.gamingServicesRegistryOutput === 'string')
  ) {
    // Use explicit test roots or cached async local fixed/removable drives (NEVER A:\..Z:\ sync loop)
    const driveRoots = Array.isArray(options.windowsDriveRoots)
      ? options.windowsDriveRoots
      : getCachedWindowsLocalDrives(options);

    for (const driveRoot of driveRoots) {
      try {
        if (!driveRoot || !fs.existsSync(driveRoot)) continue;
        const gr = parseGamingRootFile(path.win32.join(driveRoot, '.GamingRoot'), driveRoot);
        if (gr && gr.resolvedPath) {
          addParentRoot(gr.resolvedPath);
        }
        const driveXboxGames = path.win32.join(driveRoot, 'XboxGames');
        if (fs.existsSync(driveXboxGames)) {
          addParentRoot(driveXboxGames);
        }
        const modApps = path.win32.join(driveRoot, 'ModifiableWindowsApps');
        if (fs.existsSync(modApps)) {
          modifiableRoots.add(modApps);
        }
      } catch {}
    }

    if (!options.homedir && fs.existsSync('C:\\XboxGames')) {
      addParentRoot('C:\\XboxGames');
    }

    const regText =
      typeof options.gamingServicesRegistryOutput === 'string'
        ? options.gamingServicesRegistryOutput
        : !isIsolatedTest && !options.skipRegistrySpawn
          ? gamingServicesRegCache.output
          : '';

    for (const pkgRoot of parseGamingServicesRegistryRoots(regText)) {
      if (!pkgRoot) continue;
      directChildGameDirs.add(pkgRoot);
      if (isWindowsAppsProtectedPath(pkgRoot)) continue;
      const trimmedPkg = pkgRoot.replace(/[\\/]+$/, '');
      const baseLower = path.win32.basename(trimmedPkg).toLowerCase();
      const gameFolder = baseLower === 'content' ? path.win32.dirname(trimmedPkg) : trimmedPkg;
      const parentLibRoot = path.win32.dirname(gameFolder);
      if (parentLibRoot && parentLibRoot !== gameFolder && !/^[A-Za-z]:\\?$/.test(parentLibRoot)) {
        addParentRoot(parentLibRoot);
      }
    }
  }

  return {
    orderedLibraryRoots,
    modifiableRoots: Array.from(modifiableRoots),
    directChildGameDirs: Array.from(directChildGameDirs),
    platform,
    homedir,
  };
}

/**
 * Returns strictly parent Xbox library root folders (NEVER child game folders and NEVER ACL-locked WindowsApps).
 */
function collectXboxLibraryRoots(/** @type {any} */ options = {}) {
  return resolveXboxDiscoveryLocations(options).orderedLibraryRoots;
}

function collectXboxScanDirectories(/** @type {any} */ options = {}) {
  const {
    orderedLibraryRoots,
    modifiableRoots,
    directChildGameDirs,
    platform,
    homedir,
  } = resolveXboxDiscoveryLocations(options);

  const libraryRoots = new Set([...orderedLibraryRoots, ...modifiableRoots]);
  const candidateGameDirs = new Set(directChildGameDirs);

  if (platform === 'darwin') {
    try {
      const bottles = listAllInitializedBottlePaths({ platform, homedir });
      for (const bottlePath of bottles) {
        const bottleXbox = path.join(bottlePath, 'drive_c', 'XboxGames');
        if (fs.existsSync(bottleXbox)) {
          libraryRoots.add(bottleXbox);
        }
      }
    } catch {}
  }

  for (const libRoot of libraryRoots) {
    try {
      if (!fs.existsSync(libRoot)) continue;
      const st = fs.statSync(libRoot);
      if (!st.isDirectory()) continue;

      const entries = fs.readdirSync(libRoot, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
        candidateGameDirs.add(path.join(libRoot, ent.name));
      }
    } catch {}
  }

  return Array.from(candidateGameDirs);
}

function inspectInstalledXboxGameDir(gameDir, /** @type {any} */ options = {}) {
  const platform = options.platform || process.platform;
  try {
    if (!gameDir || !fs.existsSync(gameDir)) return null;

    // Never treat an active or interrupted in-progress MSIXVC extraction journal as installed
    if (fs.existsSync(path.join(gameDir, '.onelauncher-xbox-journal.json'))) {
      return null;
    }

    /** @type {any} */
    let receipt = null;
    let hasReceiptFile = false;
    const receiptCandidates = [
      path.join(gameDir, '.onelauncher-xbox-receipt.json'),
      path.join(gameDir, '.onelauncher-xbox-install.json'),
    ];
    for (const rp of receiptCandidates) {
      if (fs.existsSync(rp)) {
        hasReceiptFile = true;
        try {
          receipt = JSON.parse(fs.readFileSync(rp, 'utf8'));
        } catch {
          receipt = null;
        }
        break;
      }
    }
    if (hasReceiptFile && receipt?.status !== 'completed') {
      return null;
    }

    const hasManagedSentinel = hasManagedInstallSentinel(gameDir, 'xbox');
    const gameCfg = inspectMicrosoftGameConfig(gameDir);
    const appxCfg = inspectAppxManifest(gameDir);
    if (!gameCfg && !appxCfg && !(receipt && receipt.status === 'completed') && !hasManagedSentinel) {
      return null;
    }

    if (gameCfg && (gameCfg.isNonGameUtility || gameCfg.isDlcAddon)) {
      return null;
    }
    if (!gameCfg && appxCfg && (appxCfg.isNonGameUtility || appxCfg.isDlcAddon)) {
      return null;
    }

    const packageFamilyName =
      gameCfg?.packageFamilyName ||
      appxCfg?.packageFamilyName ||
      receipt?.packageFamilyName ||
      '';
    const identityName =
      gameCfg?.identityName || appxCfg?.identityName || receipt?.identityName || '';
    const version = gameCfg?.version || appxCfg?.version || receipt?.version || '';
    const xboxProductId = String(receipt?.xboxProductId || gameCfg?.storeId || '')
      .trim()
      .toUpperCase();
    const xboxTitleId = String(gameCfg?.titleId || receipt?.xboxTitleId || '')
      .trim()
      .toUpperCase();
    const scid = String(
      gameCfg?.scid ||
        receipt?.scid ||
        (xboxTitleId ? deriveDefaultScidFromTitleId(xboxTitleId) : '')
    )
      .trim()
      .toLowerCase();
    const fallbackScid = String(gameCfg?.fallbackScid || receipt?.fallbackScid || '')
      .trim()
      .toLowerCase();
    const msaAppId = String(gameCfg?.msaAppId || receipt?.msaAppId || '').trim();
    const appUserModelId =
      gameCfg?.appUserModelId ||
      appxCfg?.appUserModelId ||
      receipt?.appUserModelId ||
      (packageFamilyName ? `${packageFamilyName}!App` : '');
    const requiresCoreWindow = Boolean(!gameCfg && appxCfg?.requiresCoreWindow);

    const rawInstalledTitle =
      receipt?.title ||
      gameCfg?.displayName ||
      appxCfg?.displayName ||
      path.basename(gameDir);
    const xboxModsForTitle = getXboxStorefrontModules();
    const title =
      typeof xboxModsForTitle?.stripXboxPlatformDisambiguators === 'function'
        ? xboxModsForTitle.stripXboxPlatformDisambiguators(rawInstalledTitle)
        : rawInstalledTitle;

    let executablePath = '';
    /** @type {string[]} */
    const exeCandidates = [];
    const pushExeCandidateRel = (/** @type {string} */ baseDir, /** @type {string} */ relExe) => {
      if (!baseDir || !relExe) return;
      const normRel = String(relExe).replace(/\\/g, path.sep);
      const exact = path.join(baseDir, normRel);
      exeCandidates.push(exact);
      if (!fs.existsSync(exact)) {
        const ciResolved = resolveCaseInsensitiveRelFile(baseDir, normRel);
        if (ciResolved) exeCandidates.push(ciResolved);
      }
    };
    if (gameCfg?.primaryExecutable) {
      pushExeCandidateRel(gameCfg.contentRootDir || gameDir, gameCfg.primaryExecutable);
      pushExeCandidateRel(gameDir, gameCfg.primaryExecutable);
    }
    if (Array.isArray(gameCfg?.executables)) {
      for (const exeEntry of gameCfg.executables) {
        if (!exeEntry?.name || exeEntry.isHelperStub || exeEntry.isGameLaunchHelper) continue;
        pushExeCandidateRel(gameCfg.contentRootDir || gameDir, exeEntry.name);
        pushExeCandidateRel(gameDir, exeEntry.name);
      }
    }
    if (receipt?.executableRelPath) {
      const relStr = String(receipt.executableRelPath);
      if (!isExcludedExecutable(path.posix.basename(relStr.replace(/\\/g, '/')))) {
        pushExeCandidateRel(gameDir, relStr);
      }
    }
    if (appxCfg?.primaryExecutable) {
      pushExeCandidateRel(appxCfg.contentRootDir || gameDir, appxCfg.primaryExecutable);
      pushExeCandidateRel(gameDir, appxCfg.primaryExecutable);
    }
    let fallbackArm64Candidate = '';
    for (const cand of exeCandidates) {
      if (cand && !cand.toLowerCase().endsWith('.olpart') && fs.existsSync(cand)) {
        const pe = inspectWindowsExecutableHeader(cand, {
          strictPe: Boolean(options.strictPe),
        });
        if (isCompatibleX86OrX64PeHeader(pe, { hostPlatform: platform })) {
          executablePath = cand;
          break;
        }
        if (pe.isValidPe && !fallbackArm64Candidate) {
          fallbackArm64Candidate = cand;
        }
      }
    }
    if (!executablePath) {
      const fallbackDisc = findPrimaryExecutable(gameDir, {
        platform,
        hintName: title,
        preferWindowsExecutable: true,
      });
      if (
        fallbackDisc &&
        fallbackDisc.executablePath &&
        !fallbackDisc.executablePath.toLowerCase().endsWith('.olpart') &&
        fs.existsSync(fallbackDisc.executablePath)
      ) {
        const discPe = inspectWindowsExecutableHeader(fallbackDisc.executablePath, {
          strictPe: Boolean(options.strictPe),
        });
        if (isCompatibleX86OrX64PeHeader(discPe, { hostPlatform: platform })) {
          executablePath = fallbackDisc.executablePath;
        } else {
          const x64Alt = findBestX86OrX64WindowsExe(gameDir, {
            strictPe: Boolean(options.strictPe),
            platform,
          });
          executablePath = x64Alt || fallbackDisc.executablePath;
        }
      } else if (fallbackArm64Candidate) {
        const x64Alt = findBestX86OrX64WindowsExe(gameDir, {
          strictPe: Boolean(options.strictPe),
          platform,
        });
        executablePath = x64Alt || fallbackArm64Candidate;
      }
    }

    if (!requiresCoreWindow) {
      if (
        !executablePath ||
        !fs.existsSync(executablePath) ||
        executablePath.toLowerCase().endsWith('.olpart') ||
        inspectWindowsExecutableHeader(executablePath, {
          strictPe: Boolean(options.strictPe),
        }).isValidPe !== true
      ) {
        return null;
      }
    } else if (!executablePath) {
      if (!(platform === 'win32' && appUserModelId)) {
        return null;
      }
    } else if (
      executablePath.toLowerCase().endsWith('.olpart') ||
      !fs.existsSync(executablePath) ||
      inspectWindowsExecutableHeader(executablePath, {
        strictPe: Boolean(options.strictPe),
      }).isValidPe !== true
    ) {
      if (!(platform === 'win32' && appUserModelId)) {
        return null;
      }
      executablePath = '';
    }

    const platformGameId =
      xboxProductId || packageFamilyName || identityName || path.basename(gameDir);
    const installSize =
      sanitizeGameInstallSizeBytes(receipt?.installSizeBytes) ||
      sanitizeGameInstallSizeBytes(getDirectorySizeFast(gameDir, 3));

    const isClientlessExtraction = Boolean(
      (receipt && receipt.status === 'completed') || hasManagedSentinel
    );
    const runner =
      platform === 'darwin'
        ? 'xbox_xgr'
        : isClientlessExtraction
          ? 'xbox_direct'
          : 'xbox';

    return {
      platformId: 'xbox',
      platformGameId,
      storefrontAppId: xboxProductId || packageFamilyName || platformGameId,
      ...(xboxProductId ? { xboxProductId } : {}),
      ...(packageFamilyName ? { packageFamilyName } : {}),
      ...(appUserModelId ? { appUserModelId } : {}),
      ...(xboxTitleId ? { xboxTitleId } : {}),
      ...(scid ? { scid } : {}),
      ...(fallbackScid ? { fallbackScid } : {}),
      ...(msaAppId ? { msaAppId } : {}),
      ...(identityName ? { identityName } : {}),
      ...(version ? { version } : {}),
      title,
      installPath: gameDir,
      ...(executablePath ? { executablePath } : {}),
      ...(installSize ? { installSize } : {}),
      runner,
      isWindowsBinaryOnMac: platform === 'darwin',
      ...(isClientlessExtraction ? { isClientlessXboxInstall: true } : {}),
      ...(requiresCoreWindow ? { requiresCoreWindow: true } : {}),
    };
  } catch (err) {
    diagLog.warn('scanAllInstalledGames.xboxInspectError', err, { gameDir });
    return null;
  }
}

/**
 * Targeted `Get-AppxPackage -Name '<identityName>'` query (~60ms vs ~4,000ms full scan).
 */
async function queryTargetedAppxPackageAsync(
  /** @type {{ identityName?: string, packageFamilyName?: string, selectFields?: string }} */ targetInfo = {},
  /** @type {any} */ options = {}
) {
  const pfn = String(targetInfo.packageFamilyName || '').trim();
  const identityName = deriveAppxIdentityName(targetInfo.identityName || pfn);
  if (!identityName) {
    return { found: false, pkg: null, stdout: '', stderr: '', error: null };
  }

  const escapedName = escapePowerShellSingleQuoted(identityName);
  const selectFields = targetInfo.selectFields || 'Name,PackageFamilyName,PackageFullName,InstallLocation,Status';
  const pfnFilter = pfn
    ? ` | Where-Object { $_.PackageFamilyName -eq '${escapePowerShellSingleQuoted(pfn)}' }`
    : '';
  const psCommand =
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    `Get-AppxPackage -Name '${escapedName}' -ErrorAction SilentlyContinue${pfnFilter} | ` +
    `Select-Object -First 1 ${selectFields} | ConvertTo-Json -Compress`;

  const execFileImpl =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;

  return new Promise((resolve) => {
    try {
      execFileImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psCommand],
        {
          env: {
            ...process.env,
            ...(pfn ? { OL_PFN: pfn } : {}),
            OL_IDENTITY: identityName,
          },
          timeout: Number(options.timeoutMs || 8000),
          windowsHide: true,
        },
        (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
          const outStr = String(stdout || '').trim();
          const errStr = String(stderr || '').trim();
          if (err) {
            resolve({
              found: false,
              pkg: null,
              stdout: outStr,
              stderr: errStr,
              error: String(errStr || err.message || err),
            });
            return;
          }
          if (!outStr) {
            resolve({ found: false, pkg: null, stdout: '', stderr: errStr, error: null });
            return;
          }
          try {
            const parsed = JSON.parse(outStr);
            const pkg = Array.isArray(parsed) ? parsed[0] || null : parsed;
            resolve({
              found: Boolean(pkg && typeof pkg === 'object'),
              pkg,
              stdout: outStr,
              stderr: errStr,
              error: null,
            });
          } catch {
            resolve({
              found: false,
              pkg: null,
              stdout: outStr,
              stderr: errStr,
              error: null,
            });
          }
        }
      );
    } catch (/** @type {any} */ syncErr) {
      resolve({
        found: false,
        pkg: null,
        stdout: '',
        stderr: '',
        error: String(syncErr?.message || syncErr),
      });
    }
  });
}

/**
 * Targeted `Remove-AppxPackage` with mandatory post-condition verification via `Get-AppxPackage -Name`.
 * Returns `{ removed: false, error }` if the package remains installed after removal.
 */
async function removeTargetedAppxPackageVerifiedAsync(
  /** @type {{ identityName?: string, packageFamilyName?: string }} */ targetInfo = {},
  /** @type {any} */ options = {}
) {
  const pfn = String(targetInfo.packageFamilyName || '').trim();
  const identityName = deriveAppxIdentityName(targetInfo.identityName || pfn);
  if (!identityName) {
    return { removed: false, error: 'Missing Appx IdentityName / PackageFamilyName.' };
  }

  const escapedName = escapePowerShellSingleQuoted(identityName);
  const pfnFilter = pfn
    ? ` | Where-Object { $_.PackageFamilyName -eq '${escapePowerShellSingleQuoted(pfn)}' }`
    : '';
  const removeCmd =
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    `$ErrorActionPreference = 'Stop'; ` +
    `$pkgs = @(Get-AppxPackage -Name '${escapedName}'${pfnFilter}); ` +
    'foreach ($p in $pkgs) { Remove-AppxPackage -Package $p.PackageFullName -ErrorAction Stop }';

  const execFileImpl =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;

  const removeRes = await new Promise((resolve) => {
    try {
      execFileImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', removeCmd],
        {
          env: {
            ...process.env,
            ...(pfn ? { OL_PFN: pfn } : {}),
            OL_IDENTITY: identityName,
          },
          timeout: 45000,
          windowsHide: true,
        },
        (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
          resolve({
            err,
            stdout: String(stdout || '').trim(),
            stderr: String(stderr || '').trim(),
          });
        }
      );
    } catch (/** @type {any} */ syncErr) {
      resolve({
        err: syncErr,
        stdout: '',
        stderr: String(syncErr?.message || syncErr),
      });
    }
  });

  const postCheck = await queryTargetedAppxPackageAsync(
    { identityName, packageFamilyName: pfn },
    options
  );

  if (postCheck.found) {
    const detail =
      removeRes.stderr ||
      removeRes.err?.message ||
      postCheck.stderr ||
      `Appx package ${pfn || identityName} remains installed after Remove-AppxPackage.`;
    return {
      removed: false,
      stillInstalled: true,
      error: detail,
    };
  }

  if (removeRes.err && !postCheck.stdout && postCheck.error) {
    return {
      removed: false,
      stillInstalled: false,
      error: removeRes.stderr || removeRes.err.message || postCheck.error,
    };
  }

  return {
    removed: true,
    stillInstalled: false,
    error: null,
  };
}

const WINDOWS_AUMID_ACTIVATE_PS_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
namespace OneLauncherXbox {
  public enum ActivateOptions { None = 0x00000000, NoErrorUI = 0x00000002 }
  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IApplicationActivationManager {
    IntPtr ActivateApplication([In] String appUserModelId, [In] String arguments, [In] ActivateOptions options, [Out] out UInt32 processId);
  }
  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
  public class ApplicationActivationManager : IApplicationActivationManager {
    [MethodImpl(MethodImplOptions.InternalCall, MethodCodeType = MethodCodeType.Runtime)]
    public extern IntPtr ActivateApplication([In] String appUserModelId, [In] String arguments, [In] ActivateOptions options, [Out] out UInt32 processId);
  }
}
"@
$mgr = New-Object OneLauncherXbox.ApplicationActivationManager
[uint32]$pidOut = 0
$null = $mgr.ActivateApplication($env:OL_AUMID, $env:OL_ARGS, [OneLauncherXbox.ActivateOptions]::None, [ref]$pidOut)
Write-Output $pidOut
`.trim();

async function isWindowsXboxAppRunning(/** @type {any} */ options = {}) {
  if ((options.platform || process.platform) !== 'win32') return false;
  if (typeof options.mockProcessListOutput === 'string') {
    return /\bXboxPcApp\.exe\b/i.test(options.mockProcessListOutput);
  }
  if (typeof options.getProcessListOutput === 'function') {
    try {
      const out = await options.getProcessListOutput();
      return /\bXboxPcApp\.exe\b/i.test(String(out || ''));
    } catch {
      return false;
    }
  }
  if (isTestEnvironment(options) && !options.execFileImpl && !options.execFileFn) {
    return false;
  }
  const execFileImpl = options.execFileImpl || options.execFileFn || execFile;
  return new Promise((resolve) => {
    try {
      execFileImpl(
        'tasklist.exe',
        ['/FI', 'IMAGENAME eq XboxPcApp.exe', '/NH'],
        { timeout: 2000, windowsHide: true },
        (/** @type {any} */ err, /** @type {any} */ stdout) => {
          resolve(!err && /\bXboxPcApp\.exe\b/i.test(String(stdout || '')));
        }
      );
    } catch {
      resolve(false);
    }
  });
}

async function activateWindowsXboxApplication(
  appUserModelId,
  launchArgsStr = '',
  /** @type {any} */ options = {}
) {
  const cleanAumid = String(appUserModelId || '').trim();
  if (!cleanAumid || /[\x00-\x1f\x7f]/.test(cleanAumid)) {
    return { activated: false, pid: 0, error: 'invalid_aumid' };
  }
  if (typeof options.activateXboxApplicationFn === 'function') {
    return options.activateXboxApplicationFn(cleanAumid, launchArgsStr, options);
  }
  const execFileImpl = options.execFileImpl || options.execFileFn || execFile;
  return new Promise((resolve) => {
    try {
      execFileImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_AUMID_ACTIVATE_PS_SCRIPT],
        {
          timeout: 12000,
          windowsHide: true,
          env: {
            ...process.env,
            OL_AUMID: cleanAumid,
            OL_ARGS: String(launchArgsStr || ''),
          },
        },
        (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
          if (err) {
            resolve({
              activated: false,
              pid: 0,
              error: String(stderr || err.message || 'aumid_activation_failed').trim(),
            });
            return;
          }
          const m = /(\d+)/.exec(String(stdout || '').trim());
          const pid = m ? Number(m[1]) : 0;
          resolve({ activated: pid > 0, pid });
        }
      );
    } catch (/** @type {any} */ syncErr) {
      resolve({ activated: false, pid: 0, error: syncErr.message });
    }
  });
}

function resolveXboxClientBinaryPath(/** @type {any} */ options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return null;

  if (typeof options.xboxClientBinaryPath === 'string' && options.xboxClientBinaryPath.trim()) {
    const custom = options.xboxClientBinaryPath.trim();
    return fs.existsSync(custom) ? custom : null;
  }

  const homedir = options.homedir || os.homedir();
  const localAppData =
    options.localAppData ||
    (options.homedir
      ? path.join(homedir, 'AppData', 'Local')
      : process.env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local'));

  const candidates = [
    path.join(localAppData, 'Microsoft', 'WindowsApps', 'XboxPcApp.exe'),
    path.join(
      localAppData,
      'Microsoft',
      'WindowsApps',
      'Microsoft.GamingApp_8wekyb3d8bbwe',
      'XboxPcApp.exe'
    ),
    path.join(localAppData, 'Packages', 'Microsoft.GamingApp_8wekyb3d8bbwe'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {}
  }
  return null;
}

/**
 * Locates `AppxManifest.xml` / `appxmanifest.xml` inside `installDir` or `installDir/Content`
 * (and parent directory when `installDir` already points at `Content`) case-insensitively.
 *
 * @param {string} installDir
 * @returns {string}
 */
function findAppxManifestFileInInstallDir(installDir) {
  if (!installDir || typeof installDir !== 'string' || !installDir.trim()) return '';
  const cleanDir = installDir.trim();
  const baseCandidates = [cleanDir];
  const baseLower = path.basename(cleanDir.replace(/[\\/]+$/, '')).toLowerCase();
  if (baseLower === 'content') {
    const parent = path.dirname(cleanDir.replace(/[\\/]+$/, ''));
    if (parent && parent !== cleanDir) baseCandidates.push(parent);
  }
  for (const dir of baseCandidates) {
    const direct = resolveCaseInsensitiveRelFile(dir, 'AppxManifest.xml');
    if (direct) return direct;
    const inContent = resolveCaseInsensitiveRelFile(dir, path.join('Content', 'AppxManifest.xml'));
    if (inContent) return inContent;
  }
  return '';
}

/**
 * Checks whether a Windows Xbox package is registered with OS `GamingServices` / Appx, and when
 * `GamingServices` IS installed on Windows but a loose MSIXVC extraction has an `AppxManifest.xml`
 * that isn't registered yet, attempts non-admin `Add-AppxPackage -Register "<AppxManifest.xml>"`
 * so native `GamingServices` owns runtime & `wgs` cloud saves cleanly without app-local bridge DLLs.
 *
 * @param {{ installDir?: string, identityName?: string, packageFamilyName?: string, manifestPath?: string }} [targetInfo]
 * @param {any} [options]
 */
async function ensureWindowsXboxAppxRegisteredAsync(targetInfo = {}, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') {
    return {
      gamingServicesInstalled: false,
      registered: false,
      attemptedRegister: false,
      manifestPath: '',
      pkg: null,
      error: null,
    };
  }

  const gamingServicesInstalled =
    typeof options.hasGamingServices === 'boolean'
      ? options.hasGamingServices
      : hasWindowsGamingServicesInstalled(options);
  if (!gamingServicesInstalled) {
    return {
      gamingServicesInstalled: false,
      registered: false,
      attemptedRegister: false,
      manifestPath: '',
      pkg: null,
      error: null,
    };
  }

  const hasInjectedExec = Boolean(
    typeof options.execFileImpl === 'function' ||
      typeof options.execFileFn === 'function' ||
      typeof options.registerAppxPackageFn === 'function' ||
      options.allowLiveAppxQueryInTests === true
  );
  if (isTestEnvironment(options) && !hasInjectedExec) {
    return {
      gamingServicesInstalled: true,
      registered: Boolean(options.isAppxRegistered === true),
      attemptedRegister: false,
      manifestPath: '',
      pkg: null,
      error: null,
    };
  }

  const installDir = String(targetInfo.installDir || '').trim();
  const manifestPath =
    (typeof targetInfo.manifestPath === 'string' && targetInfo.manifestPath.trim()) ||
    findAppxManifestFileInInstallDir(installDir);
  let pfn = String(targetInfo.packageFamilyName || '').trim();
  let identityName = String(targetInfo.identityName || '').trim();
  if ((!pfn || !identityName) && (manifestPath || installDir)) {
    const appxInfo = inspectAppxManifest(manifestPath || installDir);
    if (appxInfo) {
      if (!pfn && appxInfo.packageFamilyName) pfn = appxInfo.packageFamilyName;
      if (!identityName && appxInfo.identityName) identityName = appxInfo.identityName;
    }
  }

  if (identityName || pfn) {
    const existing = await queryTargetedAppxPackageAsync(
      { identityName, packageFamilyName: pfn },
      options
    );
    if (existing.found) {
      return {
        gamingServicesInstalled: true,
        registered: true,
        attemptedRegister: false,
        manifestPath,
        pkg: existing.pkg,
        error: null,
      };
    }
  }

  if (!manifestPath || !fs.existsSync(manifestPath)) {
    return {
      gamingServicesInstalled: true,
      registered: false,
      attemptedRegister: false,
      manifestPath: '',
      pkg: null,
      error: 'appx_manifest_missing',
    };
  }

  if (typeof options.registerAppxPackageFn === 'function') {
    try {
      const customRes = await options.registerAppxPackageFn(manifestPath, {
        identityName,
        packageFamilyName: pfn,
      });
      return {
        gamingServicesInstalled: true,
        registered: Boolean(customRes?.registered ?? customRes === true),
        attemptedRegister: true,
        manifestPath,
        pkg: customRes?.pkg || null,
        error: customRes?.error || null,
      };
    } catch (/** @type {any} */ customErr) {
      return {
        gamingServicesInstalled: true,
        registered: false,
        attemptedRegister: true,
        manifestPath,
        pkg: null,
        error: String(customErr?.message || customErr),
      };
    }
  }

  const execFileImpl = options.execFileImpl || options.execFileFn || execFile;
  const registerPsCmd =
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    "$ErrorActionPreference = 'Stop'; " +
    'Add-AppxPackage -Register -LiteralPath $env:OL_APPX_MANIFEST -DisableDevelopmentMode -ErrorAction Stop';

  const regOutcome = await new Promise((resolve) => {
    try {
      execFileImpl(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', registerPsCmd],
        {
          timeout: Number(options.registerTimeoutMs || 25000),
          windowsHide: true,
          env: {
            ...process.env,
            OL_APPX_MANIFEST: manifestPath,
          },
        },
        (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
          resolve({
            ok: !err,
            stdout: String(stdout || '').trim(),
            stderr: String(stderr || '').trim(),
            error: err ? String(stderr || err.message || err).trim() : null,
          });
        }
      );
    } catch (/** @type {any} */ syncErr) {
      resolve({
        ok: false,
        stdout: '',
        stderr: '',
        error: String(syncErr?.message || syncErr),
      });
    }
  });

  if (!regOutcome.ok) {
    return {
      gamingServicesInstalled: true,
      registered: false,
      attemptedRegister: true,
      manifestPath,
      pkg: null,
      error: regOutcome.error || 'add_appx_register_failed',
    };
  }

  if (identityName || pfn) {
    const verified = await queryTargetedAppxPackageAsync(
      { identityName, packageFamilyName: pfn },
      options
    );
    if (verified.found) {
      return {
        gamingServicesInstalled: true,
        registered: true,
        attemptedRegister: true,
        manifestPath,
        pkg: verified.pkg,
        error: null,
      };
    }
  }

  return {
    gamingServicesInstalled: true,
    registered: true,
    attemptedRegister: true,
    manifestPath,
    pkg: null,
    error: null,
  };
}

module.exports = {
  escapePowerShellSingleQuoted,
  deriveAppxIdentityName,
  parseGamingServicesRegistryRoots,
  primeXboxDiscoveryCachesAsync,
  isXboxChildGameFolder,
  findBestX86OrX64WindowsExe,
  isWindowsAppsProtectedPath,
  hasXboxClientlessReceipt,
  collectXboxLibraryRoots,
  collectXboxScanDirectories,
  inspectInstalledXboxGameDir,
  findAppxManifestFileInInstallDir,
  queryTargetedAppxPackageAsync,
  ensureWindowsXboxAppxRegisteredAsync,
  removeTargetedAppxPackageVerifiedAsync,
  isWindowsXboxAppRunning,
  activateWindowsXboxApplication,
  resolveXboxClientBinaryPath,
};
