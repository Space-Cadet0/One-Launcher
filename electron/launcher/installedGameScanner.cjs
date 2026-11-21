// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const { diagLog } = require('../utils/diagnosticLogger.cjs');
const {
  isContainedWithinRoot,
  recordImportedEpicInstall,
  discoverWindowsLocalDrivesAsync,
  refreshHostWindowsKnownFoldersAsync,
} = require('./securityAndPathUtils.cjs');

const MAX_SCANNER_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_SCANNER_INDEX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_GOG_SCAN_DIRS_VISITED = 4000;
const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Prototype-pollution-safe own property getter.
 *
 * @param {any} obj
 * @param {string} key
 * @returns {any}
 */
function getOwnProp(obj, key) {
  if (!obj || typeof obj !== 'object' || !key || FORBIDDEN_PROTO_KEYS.has(key)) {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/**
 * Bounded read-only synchronous UTF-8 file reader (guards against OOM DoS and FIFOs/devices).
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {string | null}
 */
function readTextFileBoundedSync(filePath, maxBytes) {
  if (!filePath || typeof filePath !== 'string' || filePath.includes('\0')) return null;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > maxBytes) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Bounded read-only asynchronous UTF-8 file reader (guards against OOM DoS and FIFOs/devices).
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<string | null>}
 */
async function readTextFileBoundedAsync(filePath, maxBytes) {
  if (!filePath || typeof filePath !== 'string' || filePath.includes('\0')) return null;
  try {
    const st = await fs.promises.stat(filePath);
    if (!st.isFile() || st.size > maxBytes) return null;
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}
const {
  discoverWindowsEpicRegistryPaths,
  refreshWindowsStorefrontRegistryCacheAsync,
} = require('../utils/windowsRegistryDiscovery.cjs');
const { fromWineWindowsPath } = require('./firstPartyRegistration.cjs');
const {
  parseByteCountOrFormattedSize,
  inspectMacMachOHeader,
  inspectWindowsExecutableHeader,
  parseSteamAcf,
  detectKernelAntiCheatMarkersInDir,
  resolveParadoxLauncherSettings,
  selectPreferredGogPlayTask,
} = require('./binaryAndManifestInspectors.cjs');
const {
  getUserDataDir,
  isTestEnvironment,
  getXboxStorefrontModules,
  getLastProductionScanCache,
  setLastProductionScanCache,
  getLastSyncedEpicFingerprint,
  setLastSyncedEpicFingerprint,
  getLastSyncedGogFingerprint,
  setLastSyncedGogFingerprint,
  toLocalFsPath,
  loadManagedInstalledGames,
  saveManagedInstalledGames,
  resolvePlatformLaunchConfig,
  getGameLaunchConfigs,
  isPathUnderActiveDownload,
  isPathOrGameUnderIncompleteDownload,
} = require('./engineStateRegistry.cjs');
const { isExternalVolumeUnmounted } = require('./diskAndVolumeInspector.cjs');
const macNativeInstallerAndCodesign = require('./macNativeInstallerAndCodesign.cjs');
const {
  isExcludedExecutable,
  resolveMacAppBundleBinary,
  findPrimaryExecutable,
  resolveSteamAppInfoLaunchSpec,
  resolveDefaultEngineLaunchArguments,
  discoverSteamLocations,
  normalizeComparableTitle,
  extractBottleRootFromPath,
  inspectBottleConfMetadata,
  listAllInitializedBottlePaths,
  extractSiblingLauncherStem,
  resolveSiblingLauncherStub,
} = macNativeInstallerAndCodesign;
const {
  primeXboxDiscoveryCachesAsync,
  collectXboxScanDirectories,
  inspectInstalledXboxGameDir,
} = require('./windowsXboxAppxAndMsixvcOrchestrator.cjs');
const epicLegendaryAndEosCoordinator = require('./epicLegendaryAndEosCoordinator.cjs');
const { syncEpicFirstPartyLauncher } = epicLegendaryAndEosCoordinator;
const { syncGogFirstPartyLauncher } = require('./gogRegistryAndDirectInstaller.cjs');
const {
  normalizeChainedHandoffId,
  scanBottlePublisherInstalledGames,
  scanHostPublisherInstalledGames,
} = require('./chainedPublisherLaunchers.cjs');
const {
  parseVaultJson,
  sanitizeVaultPlatformEntriesOsFlags,
} = require('./offlineVaultService.cjs');
const { parseSteamEaInstallerDataXml } = require('../storefronts/steamLocalScanner.cjs');

function resolveAnyChainedHandoffId(/** @type {any} */ raw) {
  return normalizeChainedHandoffId(raw);
}

function extractRegistryPathLeafKeys(/** @type {any} */ rawRegistryPath) {
  if (!rawRegistryPath || typeof rawRegistryPath !== 'string') return [];
  const parts = rawRegistryPath
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return [];
  const leaf = parts[parts.length - 1];
  return buildChainedTitleMatchKeys(leaf);
}

const EDITION_SUFFIX_STRIP_RE =
  /\b(?:standard|deluxe|gold|ultimate|complete|definitive|collector'?s|limited|anniversary|remastered|game\s+of\s+the\s+year|goty|director'?s\s+cut|digital)\s+edition\b|\b(?:goty|for\s+windows|pc\s+version|windows\s+edition)\b|\((?:pc|windows|mac|xbox|game\s*pass|ubisoft\s*connect|ea\s*play)\)/gi;

function isGdkStubExecutablePath(exePath) {
  if (!exePath || typeof exePath !== 'string') return false;
  const base = path.posix.basename(exePath.replace(/\\/g, '/'));
  return /^gdkstubgame\.exe$/i.test(base);
}


/**
 * Generates deterministic comparable title keys (full + edition-stripped) with Roman numeral
 * (`II` <-> `2`, `III` <-> `3`, `IV` <-> `4`, `VI` <-> `6`, etc.) and trademark symbol normalization.
 *
 * @param {string} rawTitle
 * @returns {string[]}
 */
function buildChainedTitleMatchKeys(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') return [];
  const xboxMods = getXboxStorefrontModules();
  let cleaned = rawTitle.replace(/[™®©℠]/g, ' ').replace(/\s+/g, ' ').trim();
  if (typeof xboxMods?.stripXboxPlatformDisambiguators === 'function') {
    cleaned = xboxMods.stripXboxPlatformDisambiguators(cleaned);
  }
  const fullKey = normalizeComparableTitle(cleaned);
  const stripped = cleaned
    .replace(EDITION_SUFFIX_STRIP_RE, ' ')
    .replace(/[:\-–—|]+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const baseKey = normalizeComparableTitle(stripped);
  /** @type {string[]} */
  const keys = [];
  if (fullKey && fullKey.length >= 2) keys.push(fullKey);
  if (baseKey && baseKey.length >= 2 && baseKey !== fullKey) keys.push(baseKey);
  return keys;
}

/**
 * Checks whether two game titles match under comparable Roman-numeral / edition-stripped normalization.
 *
 * @param {string} titleA
 * @param {string} titleB
 * @returns {boolean}
 */
function doChainedPublisherTitlesMatch(titleA, titleB) {
  const keysA = buildChainedTitleMatchKeys(titleA);
  const keysB = buildChainedTitleMatchKeys(titleB);
  if (keysA.length === 0 || keysB.length === 0) return false;
  for (const ka of keysA) {
    for (const kb of keysB) {
      if (ka === kb) return true;
    }
  }
  return false;
}

function loadChainedCatalogIndex(
  userDataDir,
  /** @type {any} */ options = {},
  /** @type {any[]} */ managedRecords = [],
  /** @type {any} */ epicLocalOrGetter = null
) {
  /** @type {Map<string, { platformGameId: string, xboxProductId?: string, title: string }>} */
  const xboxHandoffByFullKey = new Map();
  /** @type {Map<string, { platformGameId: string, xboxProductId?: string, title: string }>} */
  const xboxHandoffByBaseKey = new Map();
  /** @type {Map<string, { platformGameId: string, title: string, epicPartnerRegistryPath?: string }>} */
  const epicHandoffByFullKey = new Map();
  /** @type {Map<string, { platformGameId: string, title: string, epicPartnerRegistryPath?: string }>} */
  const epicHandoffByBaseKey = new Map();
  /** @type {Map<string, { platformId: string, platformGameId: string, title: string }>} */
  const standaloneByFullKey = new Map();
  /** @type {Map<string, { platformId: string, platformGameId: string, title: string }>} */
  const standaloneByBaseKey = new Map();
  /** @type {Map<string, { platformId: string, platformGameId: string, xboxProductId?: string, title?: string }>} */
  const byExternalId = new Map();
  /** @type {Map<string, { platformId: string, platformGameId: string, xboxProductId?: string, title?: string }>} */
  const managedByInstallPath = new Map();

  const customRoots = Array.isArray(options.customRoots) ? options.customRoots : [];

  for (const rec of managedRecords) {
    if (!rec || !rec.platformId || !rec.platformGameId) continue;
    const hId = resolveAnyChainedHandoffId(
      rec.chainedLauncherHandoff || rec.externalStorefrontHandoff || rec.platformId
    );
    if (!hId) continue;
    if (rec.installPath) {
      const localManagedPath = toLocalFsPath(rec.installPath, customRoots);
      if (localManagedPath) {
        managedByInstallPath.set(path.resolve(localManagedPath).toLowerCase(), {
          platformId: String(rec.platformId),
          platformGameId: String(rec.platformGameId),
          ...(rec.xboxProductId ? { xboxProductId: String(rec.xboxProductId) } : {}),
          ...(rec.title ? { title: String(rec.title) } : {}),
        });
      }
    }
    if (rec.chainedExternalInstallId) {
      byExternalId.set(`${hId}:${String(rec.chainedExternalInstallId).toLowerCase()}`, {
        platformId: String(rec.platformId),
        platformGameId: String(rec.platformGameId),
        ...(rec.xboxProductId ? { xboxProductId: String(rec.xboxProductId) } : {}),
        ...(rec.title ? { title: String(rec.title) } : {}),
      });
    }
    if (String(rec.platformId).toLowerCase() === 'epic' && rec.epicPartnerRegistryPath) {
      const leafKeys = extractRegistryPathLeafKeys(rec.epicPartnerRegistryPath);
      const epicEntry = {
        platformGameId: String(rec.platformGameId),
        title: String(rec.title || rec.platformGameId),
        epicPartnerRegistryPath: String(rec.epicPartnerRegistryPath),
      };
      if (leafKeys[0] && !epicHandoffByFullKey.has(`${hId}:${leafKeys[0]}`)) {
        epicHandoffByFullKey.set(`${hId}:${leafKeys[0]}`, epicEntry);
      }
      const baseLeaf = leafKeys[1] || leafKeys[0];
      if (baseLeaf && !epicHandoffByBaseKey.has(`${hId}:${baseLeaf}`)) {
        epicHandoffByBaseKey.set(`${hId}:${baseLeaf}`, epicEntry);
      }
    }
  }

  const indexEpicPartnerEntry = (
    /** @type {string} */ eHandoff,
    /** @type {string} */ pgid,
    /** @type {string} */ title,
    /** @type {string | undefined} */ regPath,
    /** @type {string | undefined} */ extId
  ) => {
    const keys = buildChainedTitleMatchKeys(title);
    const leafKeys = extractRegistryPathLeafKeys(regPath);
    const entry = {
      platformGameId: pgid,
      title: title || pgid,
      ...(regPath ? { epicPartnerRegistryPath: regPath } : {}),
    };
    if (keys[0] && !epicHandoffByFullKey.has(`${eHandoff}:${keys[0]}`)) {
      epicHandoffByFullKey.set(`${eHandoff}:${keys[0]}`, entry);
    }
    const baseKey = keys[1] || keys[0];
    if (baseKey && !epicHandoffByBaseKey.has(`${eHandoff}:${baseKey}`)) {
      epicHandoffByBaseKey.set(`${eHandoff}:${baseKey}`, entry);
    }
    if (leafKeys[0] && !epicHandoffByFullKey.has(`${eHandoff}:${leafKeys[0]}`)) {
      epicHandoffByFullKey.set(`${eHandoff}:${leafKeys[0]}`, entry);
    }
    const baseLeaf = leafKeys[1] || leafKeys[0];
    if (baseLeaf && !epicHandoffByBaseKey.has(`${eHandoff}:${baseLeaf}`)) {
      epicHandoffByBaseKey.set(`${eHandoff}:${baseLeaf}`, entry);
    }
    if (extId && !byExternalId.has(`${eHandoff}:${String(extId).toLowerCase()}`)) {
      byExternalId.set(`${eHandoff}:${String(extId).toLowerCase()}`, {
        platformId: 'epic',
        platformGameId: pgid,
        title: title || pgid,
      });
    }
  };

  const indexGameEntry = (/** @type {any} */ game) => {
    if (!game || typeof game !== 'object') return;
    const title = String(game.title || game.canonical_title || '').trim();
    const keys = buildChainedTitleMatchKeys(title);
    const fullKey = keys[0] || '';
    const baseKey = keys[1] || keys[0] || '';
    const rawPlats = Array.isArray(game.platforms) ? game.platforms : [];
    const sanitizedPlats =
      sanitizeVaultPlatformEntriesOsFlags(rawPlats, false, {
        drmNotice: game.drmNotice || game.enrichedMetadata?.drmNotice || null,
        gameChainedLauncherHandoff: game.chainedLauncherHandoff || null,
        gameExternalStorefrontHandoff: game.externalStorefrontHandoff || null,
      }).platforms || rawPlats;

    for (const p of sanitizedPlats) {
      if (!p || typeof p !== 'object') continue;
      const pid = String(p.platformId || '').trim().toLowerCase();
      const pgid = String(p.platformGameId || p.xboxProductId || '').trim();
      if (!pgid) continue;
      if (pid === 'xbox') {
        const xHandoff = resolveAnyChainedHandoffId(
          p.chainedLauncherHandoff ||
            p.externalStorefrontHandoff ||
            (sanitizedPlats.length === 1
              ? game.chainedLauncherHandoff || game.externalStorefrontHandoff
              : null)
        );
        if (xHandoff && fullKey) {
          const entry = {
            platformGameId: pgid,
            xboxProductId: String(p.xboxProductId || pgid),
            title,
          };
          if (!xboxHandoffByFullKey.has(`${xHandoff}:${fullKey}`)) {
            xboxHandoffByFullKey.set(`${xHandoff}:${fullKey}`, entry);
          }
          if (!xboxHandoffByBaseKey.has(`${xHandoff}:${baseKey}`)) {
            xboxHandoffByBaseKey.set(`${xHandoff}:${baseKey}`, entry);
          }
          if (p.chainedExternalInstallId) {
            byExternalId.set(`${xHandoff}:${String(p.chainedExternalInstallId).toLowerCase()}`, {
              platformId: 'xbox',
              platformGameId: pgid,
              xboxProductId: String(p.xboxProductId || pgid),
              title,
            });
          }
        }
      } else if (pid === 'epic') {
        const eHandoff = resolveAnyChainedHandoffId(
          p.chainedLauncherHandoff ||
            p.externalStorefrontHandoff ||
            (sanitizedPlats.length === 1
              ? game.chainedLauncherHandoff || game.externalStorefrontHandoff
              : null)
        );
        if (eHandoff) {
          indexEpicPartnerEntry(
            eHandoff,
            pgid,
            String(p.originalTitle || title),
            p.epicPartnerRegistryPath ? String(p.epicPartnerRegistryPath) : undefined,
            p.chainedExternalInstallId ? String(p.chainedExternalInstallId) : undefined
          );
        }
      } else {
        const standaloneHandoff = resolveAnyChainedHandoffId(pid);
        if (standaloneHandoff && fullKey) {
          const entry = {
            platformId: standaloneHandoff,
            platformGameId: pgid,
            title,
          };
          if (!standaloneByFullKey.has(`${standaloneHandoff}:${fullKey}`)) {
            standaloneByFullKey.set(`${standaloneHandoff}:${fullKey}`, entry);
          }
          if (!standaloneByBaseKey.has(`${standaloneHandoff}:${baseKey}`)) {
            standaloneByBaseKey.set(`${standaloneHandoff}:${baseKey}`, entry);
          }
        }
      }
    }
  };

  if (Array.isArray(options.catalogGames)) {
    for (const cg of options.catalogGames) {
      indexGameEntry(cg);
    }
  }

  try {
    const epicLocal =
      typeof epicLocalOrGetter === 'function'
        ? epicLocalOrGetter()
        : epicLocalOrGetter && typeof epicLocalOrGetter === 'object'
          ? epicLocalOrGetter
          : epicLegendaryAndEosCoordinator.collectLocalEpicMetadataAndSupport(options);
    if (Array.isArray(epicLocal?.metaSummaries)) {
      for (const s of epicLocal.metaSummaries) {
        if (!s || !s.appName) continue;
        const eHandoff = resolveAnyChainedHandoffId(
          s.chainedLauncherHandoff || s.externalStorefrontHandoff
        );
        if (!eHandoff) continue;
        indexEpicPartnerEntry(
          eHandoff,
          String(s.appName),
          String(s.appTitle || s.appName),
          s.epicPartnerRegistryPath ? String(s.epicPartnerRegistryPath) : undefined,
          s.chainedExternalInstallId ? String(s.chainedExternalInstallId) : undefined
        );
      }
    }
  } catch {}

  try {
    const vaultDbPath = path.join(userDataDir, 'offline-vault', 'catalog_metadata.sqlite');
    if (fs.existsSync(vaultDbPath)) {
      const vaultDb = new DatabaseSync(vaultDbPath, { readOnly: true });
      try {
        try {
          vaultDb.exec('PRAGMA busy_timeout = 3000;');
        } catch {}
        // Project only lightweight columns in the full-table pass so thousands of uninstalled
        // library rows never trigger synchronous `zlib.inflateRawSync` on multi-KB `enriched_json`.
        const rows = vaultDb
          .prepare('SELECT game_id, canonical_title, platforms_json, summary_json FROM vault_games')
          .all();
        const getEnrichedByIdStmt = vaultDb.prepare(
          'SELECT enriched_json FROM vault_games WHERE game_id = ?'
        );
        for (const row of rows) {
          if (!row) continue;
          const summary = parseVaultJson(row.summary_json) || {};
          const platforms = parseVaultJson(row.platforms_json) || summary.platforms || [];
          let enrichedMetadata = null;
          const needsEnrichedDrmFallback =
            !summary.drmNotice &&
            !summary.chainedLauncherHandoff &&
            !summary.externalStorefrontHandoff &&
            Array.isArray(platforms) &&
            platforms.some((p) => {
              if (!p || typeof p !== 'object') return false;
              const pid = String(p.platformId || '').toLowerCase();
              return (
                (pid === 'xbox' || pid === 'epic') &&
                !p.chainedLauncherHandoff &&
                !p.externalStorefrontHandoff
              );
            });
          if (needsEnrichedDrmFallback && row.game_id) {
            const enrichedRow = getEnrichedByIdStmt.get(row.game_id);
            if (enrichedRow?.enriched_json) {
              enrichedMetadata = parseVaultJson(enrichedRow.enriched_json);
            }
          }
          indexGameEntry({
            ...summary,
            id: summary.id || row.game_id,
            title: summary.title || row.canonical_title || '',
            platforms,
            ...(enrichedMetadata ? { enrichedMetadata } : {}),
          });
        }
      } finally {
        try {
          vaultDb.close();
        } catch {}
      }
    }
  } catch {}

  return {
    xboxHandoffByFullKey,
    xboxHandoffByBaseKey,
    epicHandoffByFullKey,
    epicHandoffByBaseKey,
    standaloneByFullKey,
    standaloneByBaseKey,
    byExternalId,
    managedByInstallPath,
  };
}

function resolveBottleLayerMetadata(bottlePath, /** @type {any[]} */ detectedLayers) {
  const resolvedBottle = path.resolve(bottlePath);
  const normBottle = resolvedBottle.replace(/\\/g, '/');
  const bottleBase = path.basename(resolvedBottle);
  const confMeta = inspectBottleConfMetadata(resolvedBottle);
  if (confMeta.wineArch === 'arm64') {
    return {
      compatibilityLayer: 'crossover_preview_arm64',
      wineBottle: bottleBase,
    };
  }
  if (confMeta.previewEnabled === true) {
    return {
      compatibilityLayer: 'crossover_preview',
      wineBottle: bottleBase,
    };
  }
  for (const layer of detectedLayers) {
    if (!layer || !layer.bottlesDir) continue;
    const resolvedBottlesDir = path.resolve(layer.bottlesDir);
    if (
      resolvedBottle === resolvedBottlesDir ||
      resolvedBottle.startsWith(`${resolvedBottlesDir}${path.sep}`)
    ) {
      return {
        compatibilityLayer:
          layer.type === 'crossover_preview_arm64' && confMeta.wineArch === 'win64'
            ? 'crossover_preview'
            : layer.type,
        wineBottle: bottleBase,
      };
    }
  }
  if (/\/CrossOver Preview arm64\/Bottles\//i.test(normBottle)) {
    return { compatibilityLayer: 'crossover_preview_arm64', wineBottle: bottleBase };
  }
  if (/\/CrossOver Preview\/Bottles\//i.test(normBottle)) {
    return { compatibilityLayer: 'crossover_preview', wineBottle: bottleBase };
  }
  if (/\/(?:CrossOver|Whisky)\/Bottles\//i.test(normBottle)) {
    return { compatibilityLayer: 'crossover', wineBottle: bottleBase };
  }
  const preferredReady =
    detectedLayers.find((l) => l && l.available) || detectedLayers[0] || null;
  return {
    compatibilityLayer: preferredReady?.type || 'wine',
    wineBottle: bottleBase,
  };
}

const ASYNC_SCAN_YIELD_CHUNK = 4;

/**
 * Yield cleanly to the Node/Electron event loop so IPC messages, timers, and UI frames
 * are never starved during multi-storefront installed-game scans.
 *
 * @returns {Promise<void>}
 */
function yieldToEventLoop() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Check the 3-second default production scan cache and return a cloned copy if fresh.
 *
 * @param {any} options
 * @returns {{ isDefaultProdScan: boolean, cachedResult: any | null }}
 */
function checkDefaultProdScanCache(options) {
  const isDefaultProdScan =
    !options.platform &&
    !options.homedir &&
    !options.customRoots &&
    !options.userDataDir &&
    !options.forceRefresh &&
    !options.syncFirstParty &&
    !options.eglManifestsDir &&
    !options.gogGalaxyConfigPath &&
    !options.gogGalaxyStorageDir &&
    !options.xboxGamesDirs &&
    !options.windowsDriveRoots &&
    !options.gamingServicesRegistryOutput &&
    !options.catalogGames &&
    !options.bottlePath &&
    !options.bottlePaths &&
    !options.strictPe;

  const lastProductionScanCache = getLastProductionScanCache();
  if (
    isDefaultProdScan &&
    lastProductionScanCache.result &&
    Date.now() - lastProductionScanCache.timestamp < 3000
  ) {
    const cachedInstalledGames = lastProductionScanCache.result.installedGames.map(
      (/** @type {any} */ g) => ({ ...g })
    );
    const cachedEpicSupport = { ...(lastProductionScanCache.result.epicPlatformSupport || {}) };
    try {
      Object.defineProperty(cachedInstalledGames, 'epicPlatformSupport', {
        value: cachedEpicSupport,
        enumerable: false,
        configurable: true,
      });
    } catch {}
    return {
      isDefaultProdScan,
      cachedResult: {
        success: true,
        installedGames: cachedInstalledGames,
        installedSteamAppIds: [...lastProductionScanCache.result.installedSteamAppIds],
        epicPlatformSupport: cachedEpicSupport,
      },
    };
  }
  return { isDefaultProdScan, cachedResult: null };
}

/**
 * Initialize shared per-scan state with memoized single-call `detectCompatibilityLayers`
 * and `collectLocalEpicMetadataAndSupport` getters so neither runs more than once per scan.
 *
 * @param {any} options
 * @param {boolean} isDefaultProdScan
 * @param {boolean} skipWin32BackgroundPrewarm
 */
function createScanContext(options, isDefaultProdScan, skipWin32BackgroundPrewarm) {
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();
  const customRoots = Array.isArray(options.customRoots) ? options.customRoots : [];
  const userDataDir = getUserDataDir(options.userDataDir);
  const isIsolatedTest = Boolean(
    options.homedir || (options.customRoots && options.customRoots.length > 0)
  );

  if (platform === 'win32' && !skipWin32BackgroundPrewarm) {
    primeXboxDiscoveryCachesAsync(options).catch(() => {});
    if (!isTestEnvironment(options) || options.prewarmWindowsCaches === true) {
      const prewarmOpts = options.prewarmWindowsCaches === true ? options : { platform };
      refreshWindowsStorefrontRegistryCacheAsync(prewarmOpts).catch(() => {});
      refreshHostWindowsKnownFoldersAsync(prewarmOpts).catch(() => {});
      discoverWindowsLocalDrivesAsync(prewarmOpts).catch(() => {});
    }
  }

  /** @type {Record<string, any>} */
  let launchConfigs = {};
  try {
    launchConfigs = getGameLaunchConfigs({ userDataDir }) || {};
  } catch (cfgErr) {
    diagLog.warn(
      'scanAllInstalledGames.stageError',
      cfgErr,
      { stage: 'launch_configs' },
      { userDataDir }
    );
  }

  const discoveredMap = new Map();
  /** @type {number[]} */
  const installedSteamAppIds = [];
  /** @type {Set<string>} */
  const steamInstalledDirPaths = new Set();

  /** @type {any[]} */
  let preloadedManagedRecords = [];
  /** @type {Set<string>} */
  const managedCompletedKeys = new Set();
  try {
    const rawManagedRecords = loadManagedInstalledGames(userDataDir);
    preloadedManagedRecords = rawManagedRecords.filter(
      (rec) => !isGdkStubExecutablePath(rec?.executablePath)
    );
    if (preloadedManagedRecords.length !== rawManagedRecords.length) {
      saveManagedInstalledGames(preloadedManagedRecords, userDataDir);
    }
    for (const rec of preloadedManagedRecords) {
      if (!rec || !rec.platformId || !rec.platformGameId) continue;
      const cleanManagedId = String(rec.platformGameId)
        .replace(/^(gog|steam|epic|xbox)-/i, '')
        .toLowerCase();
      managedCompletedKeys.add(`${String(rec.platformId).toLowerCase()}:${cleanManagedId}`);
    }
  } catch {}

  let hasDetectedDarwinLayers = false;
  /** @type {any[]} */
  let cachedDarwinLayers = [];
  const getDetectedDarwinLayersOnce = () => {
    if (platform !== 'darwin') return [];
    if (!hasDetectedDarwinLayers) {
      hasDetectedDarwinLayers = true;
      if (Array.isArray(options.detectedLayers)) {
        cachedDarwinLayers = options.detectedLayers;
      } else {
        const explicitHomedirOpt = options.homedir ? { homedir: options.homedir } : {};
        cachedDarwinLayers =
          macNativeInstallerAndCodesign.detectCompatibilityLayers({
            ...options,
            platform: 'darwin',
            ...explicitHomedirOpt,
          }) || [];
      }
    }
    return cachedDarwinLayers;
  };

  let hasCollectedEpicLocal = false;
  /** @type {any} */
  let cachedEpicLocal = null;
  const getEpicLocalMetadataOnce = () => {
    if (!hasCollectedEpicLocal) {
      hasCollectedEpicLocal = true;
      cachedEpicLocal = epicLegendaryAndEosCoordinator.collectLocalEpicMetadataAndSupport(options);
    }
    return cachedEpicLocal;
  };

  /** @type {Set<string>} */
  const knownEpicDlcAppNames = new Set();
  let epicDlcMetadataSeeded = false;
  const markEpicDlcAppName = (/** @type {unknown} */ rawId) => {
    const clean = String(rawId || '')
      .trim()
      .replace(/^epic[-_]/i, '')
      .toLowerCase();
    if (clean) {
      knownEpicDlcAppNames.add(clean);
    }
  };
  const ensureEpicDlcMetadataSeeded = () => {
    if (epicDlcMetadataSeeded) return;
    epicDlcMetadataSeeded = true;
    try {
      const localMeta = getEpicLocalMetadataOnce();
      if (Array.isArray(localMeta?.metaSummaries)) {
        for (const s of localMeta.metaSummaries) {
          if (s && s.isDlc === true) {
            if (s.appName) markEpicDlcAppName(s.appName);
            if (s.catalogItemId) markEpicDlcAppName(s.catalogItemId);
          }
        }
      }
    } catch {}
  };
  const isKnownEpicDlc = (/** @type {unknown} */ rawId) => {
    const clean = String(rawId || '')
      .trim()
      .replace(/^epic[-_]/i, '')
      .toLowerCase();
    if (!clean) return false;
    ensureEpicDlcMetadataSeeded();
    return knownEpicDlcAppNames.has(clean);
  };

  const addRecord = (/** @type {any} */ record) => {
    if (!record || !record.platformId || !record.platformGameId) return;
    const cleanRecordId = String(record.platformGameId)
      .replace(/^(gog|steam|epic|xbox)-/i, '')
      .toLowerCase();
    if (record.platformId === 'epic' && isKnownEpicDlc(cleanRecordId)) {
      return;
    }
    if (
      !managedCompletedKeys.has(`${String(record.platformId).toLowerCase()}:${cleanRecordId}`) &&
      isPathOrGameUnderIncompleteDownload(
        record.installPath,
        record.platformId,
        record.platformGameId
      )
    ) {
      return;
    }
    const key = `${record.platformId}:${record.platformGameId}`;
    const existing = discoveredMap.get(key);
    if (existing) {
      if (existing.driveDisconnected && !record.driveDisconnected) {
        discoveredMap.set(key, record);
      } else if (!existing.driveDisconnected && record.driveDisconnected) {
        // Keep mounted record over unmounted record
      } else if (
        platform === 'darwin' &&
        ['steam', 'gog', 'epic', 'xbox'].includes(record.platformId) &&
        Boolean(existing.isWindowsBinaryOnMac) !== Boolean(record.isWindowsBinaryOnMac)
      ) {
        const platPrefix = `${String(record.platformId).toLowerCase()}`;
        const rawCandidateId = String(
          record.storefrontAppId || record.appId || record.platformGameId || ''
        );
        const rawLower = rawCandidateId.toLowerCase();
        const cleanId =
          rawLower.startsWith(`${platPrefix}-`) || rawLower.startsWith(`${platPrefix}_`)
            ? rawCandidateId.slice(platPrefix.length + 1)
            : rawCandidateId;
        let rawSaved =
          getOwnProp(launchConfigs, `${record.platformId}-${cleanId}`) ||
          getOwnProp(launchConfigs, `${record.platformId}_${cleanId}`) ||
          getOwnProp(launchConfigs, String(record.platformGameId)) ||
          getOwnProp(launchConfigs, cleanId) ||
          null;
        if (!rawSaved && cleanId) {
          const lowerClean = cleanId.toLowerCase();
          for (const [cfgKey, cfgVal] of Object.entries(launchConfigs)) {
            if (!cfgVal || typeof cfgVal !== 'object') continue;
            const kLower = cfgKey.toLowerCase();
            if (
              kLower === `${record.platformId}-${lowerClean}` ||
              kLower === `${record.platformId}_${lowerClean}` ||
              kLower === lowerClean ||
              String(cfgVal.gameId || '').toLowerCase() ===
                `${record.platformId}-${lowerClean}` ||
              Boolean(
                getOwnProp(cfgVal.platformConfigs, record.platformId) &&
                  kLower.includes(lowerClean)
              )
            ) {
              rawSaved = cfgVal;
              break;
            }
          }
        }
        const savedCfg = resolvePlatformLaunchConfig(rawSaved || {}, record.platformId);
        const preferWinBottle = savedCfg?.launchMethod === 'compatibility_layer';
        const preferred = preferWinBottle
          ? record.isWindowsBinaryOnMac
            ? record
            : existing
          : !record.isWindowsBinaryOnMac
            ? record
            : existing;
        const secondary = preferred === record ? existing : record;
        discoveredMap.set(key, {
          ...secondary,
          ...preferred,
          executablePath: preferred.executablePath || secondary.executablePath,
          installPath: preferred.installPath || secondary.installPath,
          launchArguments: preferred.launchArguments || secondary.launchArguments,
          isWindowsBinaryOnMac: Boolean(preferred.isWindowsBinaryOnMac),
        });
      } else if (
        record.platformId === 'steam' &&
        existing.isWindowsBinaryOnMac &&
        record.isWindowsBinaryOnMac &&
        existing.installPath &&
        record.installPath
      ) {
        let existingIsSymlink = false;
        let recordIsSymlink = false;
        try {
          existingIsSymlink = fs.lstatSync(existing.installPath).isSymbolicLink();
        } catch {}
        try {
          recordIsSymlink = fs.lstatSync(record.installPath).isSymbolicLink();
        } catch {}
        if (!existingIsSymlink && recordIsSymlink) {
          discoveredMap.set(key, {
            ...record,
            ...existing,
            executablePath: existing.executablePath || record.executablePath,
            installPath: existing.installPath,
            manifestPath: existing.manifestPath || record.manifestPath,
            launchArguments: existing.launchArguments || record.launchArguments,
          });
        } else {
          discoveredMap.set(key, {
            ...existing,
            ...record,
            executablePath: record.executablePath || existing.executablePath,
            installPath: record.installPath || existing.installPath,
            manifestPath: record.manifestPath || existing.manifestPath,
            launchArguments: record.launchArguments || existing.launchArguments,
          });
        }
      } else {
        discoveredMap.set(key, {
          ...existing,
          ...record,
          executablePath: record.executablePath || existing.executablePath,
          installPath: record.installPath || existing.installPath,
          launchArguments: record.launchArguments || existing.launchArguments,
        });
      }
    } else {
      discoveredMap.set(key, record);
    }
    if (record.platformId === 'steam') {
      const numId = Number(record.appId || record.platformGameId);
      if (numId > 0 && !installedSteamAppIds.includes(numId)) {
        installedSteamAppIds.push(numId);
      }
    }
  };

  return {
    options,
    isDefaultProdScan,
    platform,
    homedir,
    customRoots,
    userDataDir,
    isIsolatedTest,
    launchConfigs,
    discoveredMap,
    installedSteamAppIds,
    steamInstalledDirPaths,
    preloadedManagedRecords,
    managedCompletedKeys,
    getDetectedDarwinLayersOnce,
    getEpicLocalMetadataOnce,
    knownEpicDlcAppNames,
    markEpicDlcAppName,
    isKnownEpicDlc,
    addRecord,
  };
}

/**
 * Shared Steam `appmanifest_<appId>.acf` processor used by both sync and async scanners.
 *
 * @param {any} ctx
 * @param {string} steamappsDir
 * @param {string} manifestPath
 * @param {string} acfRawText
 * @param {string | null} [preloadedInstallerXmlText]
 */
function processSteamManifestRecord(
  ctx,
  steamappsDir,
  manifestPath,
  acfRawText,
  preloadedInstallerXmlText = null
) {
  const { platform, options, steamInstalledDirPaths, addRecord } = ctx;
  /** @type {any} */
  let parsed = null;
  try {
    parsed = parseSteamAcf(acfRawText);
  } catch {}
  if (!parsed || !parsed.appId) return;

  // Skip Steamworks Common Redistributables
  if (parsed.appId === 228980) return;

  const commonDir = path.join(steamappsDir, 'common');
  const installPath = parsed.installdir
    ? path.resolve(commonDir, String(parsed.installdir))
    : path.resolve(commonDir, String(parsed.appId));
  if (
    !isContainedWithinRoot(commonDir, installPath, platform) ||
    path.resolve(installPath) === path.resolve(commonDir)
  ) {
    return;
  }

  const dirExists = fs.existsSync(installPath);
  const stateFlags = parsed.StateFlags ? String(parsed.StateFlags).trim() : undefined;
  const stateFlagsNum =
    stateFlags !== undefined && /^\d+$/.test(stateFlags) ? Number(stateFlags) : NaN;
  const bytesToDl = Number(parsed.BytesToDownload || 0);
  const bytesDl = Number(parsed.BytesDownloaded || 0);
  const isInstalledFlagSet = Number.isFinite(stateFlagsNum) && (stateFlagsNum & 4) === 4;
  const isActivelyDownloading = Boolean(
    !isInstalledFlagSet &&
      ((Number.isFinite(stateFlagsNum) &&
        (stateFlagsNum & (2 | 256 | 512 | 1024 | 2048)) !== 0) ||
        (stateFlags && bytesToDl > 0 && bytesDl < bytesToDl))
  );

  if (isActivelyDownloading) {
    return;
  }

  if (!dirExists) {
    if (isExternalVolumeUnmounted(installPath, options)) {
      const isInsideBottle = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(installPath);
      addRecord({
        platformId: 'steam',
        platformGameId: String(parsed.appId),
        appId: parsed.appId,
        title: parsed.name,
        name: parsed.name,
        installPath,
        installSize: parseByteCountOrFormattedSize(parsed.SizeOnDisk),
        version: parsed.buildid ? String(parsed.buildid) : undefined,
        manifestPath,
        runner: 'steam',
        isWindowsBinaryOnMac: Boolean(platform === 'darwin' && isInsideBottle),
        driveDisconnected: true,
      });
    }
    return;
  }

  const appInfoSpec = resolveSteamAppInfoLaunchSpec(steamappsDir, parsed.appId, installPath, {
    platform,
  });
  let installerDataParsed = null;
  if (typeof preloadedInstallerXmlText === 'string' && preloadedInstallerXmlText) {
    try {
      installerDataParsed = parseSteamEaInstallerDataXml(preloadedInstallerXmlText);
    } catch {}
  } else if (preloadedInstallerXmlText === null) {
    const installerXmlCandidates = [
      path.join(installPath, '__Installer', 'installerdata.xml'),
      path.join(installPath, '__installer', 'installerdata.xml'),
    ];
    for (const xmlPath of installerXmlCandidates) {
      if (!fs.existsSync(xmlPath)) continue;
      const xmlRaw = readTextFileBoundedSync(xmlPath, MAX_SCANNER_MANIFEST_BYTES);
      if (!xmlRaw) continue;
      try {
        installerDataParsed = parseSteamEaInstallerDataXml(xmlRaw);
        if (installerDataParsed) break;
      } catch {}
    }
  }

  const steamChainedHandoff = resolveAnyChainedHandoffId(
    appInfoSpec?.chainedLauncherHandoff || (installerDataParsed?.isEaChained ? 'ea' : null)
  );
  const steamRequiresProtocolLaunch = Boolean(
    appInfoSpec?.requiresStorefrontProtocolLaunch || steamChainedHandoff
  );
  const steamChainedContentId = installerDataParsed?.contentId || undefined;

  const exeDiscovery =
    appInfoSpec && appInfoSpec.executablePath
      ? {
          executablePath: appInfoSpec.launchArguments
            ? appInfoSpec.executablePath
            : resolveSiblingLauncherStub(appInfoSpec.executablePath, installPath),
          isWindowsBinaryOnMac: appInfoSpec.isWindowsBinaryOnMac,
        }
      : findPrimaryExecutable(installPath, {
          platform,
          hintName: parsed.name,
          readOnly: true,
        });

  if (!exeDiscovery.executablePath && !steamRequiresProtocolLaunch) {
    return;
  }

  steamInstalledDirPaths.add(path.resolve(installPath).toLowerCase());
  const isInsideBottle = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(installPath);
  const launchArguments =
    appInfoSpec?.launchArguments ||
    (exeDiscovery.executablePath
      ? resolveDefaultEngineLaunchArguments(installPath, exeDiscovery.executablePath)
      : undefined);

  addRecord({
    platformId: 'steam',
    platformGameId: String(parsed.appId),
    appId: parsed.appId,
    title: parsed.name,
    name: parsed.name,
    installPath,
    ...(exeDiscovery.executablePath ? { executablePath: exeDiscovery.executablePath } : {}),
    ...(launchArguments ? { launchArguments } : {}),
    ...(steamChainedHandoff
      ? {
          chainedLauncherHandoff: steamChainedHandoff,
          externalStorefrontHandoff: steamChainedHandoff,
          chainedHandoffTopology: 'storefront_depot_uri',
        }
      : {}),
    ...(steamRequiresProtocolLaunch ? { requiresStorefrontProtocolLaunch: true } : {}),
    ...(steamChainedContentId ? { chainedExternalInstallId: steamChainedContentId } : {}),
    ...(appInfoSpec?.protocolUri ? { protocolUri: appInfoSpec.protocolUri } : {}),
    installSize: parseByteCountOrFormattedSize(parsed.SizeOnDisk),
    version: parsed.buildid ? String(parsed.buildid) : undefined,
    manifestPath,
    runner: 'steam',
    isWindowsBinaryOnMac:
      Boolean(exeDiscovery.isWindowsBinaryOnMac) ||
      (platform === 'darwin' && (isInsideBottle || Boolean(steamChainedHandoff))),
  });
}

function getDarwinBottleContainerDirs(/** @type {any} */ ctx) {
  if (ctx.platform !== 'darwin') return [];
  const detectedDarwinLayers = ctx.getDetectedDarwinLayersOnce();
  return Array.from(
    new Set([
      path.join(ctx.homedir, 'Library/Application Support/CrossOver/Bottles'),
      path.join(ctx.homedir, 'Library/Application Support/CrossOver Preview/Bottles'),
      path.join(ctx.homedir, 'Library/Application Support/CrossOver Preview arm64/Bottles'),
      path.join(ctx.homedir, 'Games/OneLauncher/Bottles'),
      path.join(ctx.homedir, 'Bottles'),
      path.join(ctx.homedir, 'Library/Application Support/Whisky/Bottles'),
      path.join(ctx.homedir, 'Library/Application Support/Mythic/Bottles'),
      ...(Array.isArray(detectedDarwinLayers) ? detectedDarwinLayers : [])
        .map((/** @type {any} */ l) => l?.bottlesDir)
        .filter((/** @type {any} */ d) => typeof d === 'string' && d.trim()),
    ])
  );
}

function buildGogScanSources(/** @type {any} */ ctx, /** @type {string[]} */ discoveredBottleRoots) {
  const { homedir, customRoots, userDataDir, isIsolatedTest } = ctx;
  const gogSearchDirs = new Set([
    path.join(homedir, 'Games', 'OneLauncher', 'GOG'),
    path.join(homedir, 'Games', 'Heroic'),
    ...customRoots.map((/** @type {string} */ r) => toLocalFsPath(r, customRoots)),
    path.join(homedir, 'Applications'),
    path.join(homedir, 'Games'),
  ]);

  for (const bottleRoot of discoveredBottleRoots) {
    gogSearchDirs.add(path.join(bottleRoot, 'drive_c/Program Files (x86)/GOG Galaxy/Games'));
    gogSearchDirs.add(path.join(bottleRoot, 'drive_c/Program Files/GOG Galaxy/Games'));
    gogSearchDirs.add(path.join(bottleRoot, 'drive_c/GOG Games'));
    gogSearchDirs.add(path.join(bottleRoot, 'drive_c/Games/OneLauncher/GOG'));
  }

  if (!isIsolatedTest) {
    gogSearchDirs.add('/Applications');
    gogSearchDirs.add('C:\\Program Files (x86)\\GOG Galaxy\\Games');
    gogSearchDirs.add('C:\\Program Files\\GOG Galaxy\\Games');
    gogSearchDirs.add('C:\\GOG Games');
    gogSearchDirs.add('C:\\Games\\OneLauncher\\GOG');
  }

  const gogGalaxyConfigs = [
    path.join(homedir, 'Library/Application Support/GOG.com/Galaxy/config.json'),
    ...customRoots.map((/** @type {string} */ r) =>
      path.join(toLocalFsPath(r, customRoots), 'config.json')
    ),
    ...discoveredBottleRoots.map((bRoot) =>
      path.join(bRoot, 'drive_c/ProgramData/GOG.com/Galaxy/config.json')
    ),
  ];
  if (!isIsolatedTest) {
    gogGalaxyConfigs.push(
      '/Users/Shared/GOG.com/Galaxy/config.json',
      'C:\\ProgramData\\GOG.com\\Galaxy\\config.json'
    );
  }

  const heroicGogFiles = [
    path.join(userDataDir, 'gog_store/installed.json'),
    path.join(homedir, 'Library/Application Support/heroic/gog_store/installed.json'),
    path.join(homedir, '.config/heroic/gog_store/installed.json'),
    path.join(homedir, 'AppData/Roaming/heroic/gog_store/installed.json'),
    ...customRoots.map((/** @type {string} */ r) =>
      path.join(toLocalFsPath(r, customRoots), 'gog_store/installed.json')
    ),
    ...customRoots.map((/** @type {string} */ r) =>
      path.join(toLocalFsPath(r, customRoots), 'heroic/gog_store/installed.json')
    ),
  ];

  return { gogSearchDirs, gogGalaxyConfigs, heroicGogFiles };
}

function applyGogGalaxyConfigJson(
  /** @type {any} */ ctx,
  /** @type {string} */ cfgPath,
  /** @type {string} */ rawText,
  /** @type {Set<string>} */ gogSearchDirs
) {
  try {
    const cfgBottleRoot = extractBottleRootFromPath(cfgPath);
    const cfg = JSON.parse(rawText);
    if (cfg.libraryPath) {
      const libLocal = cfgBottleRoot
        ? fromWineWindowsPath(cfg.libraryPath, cfgBottleRoot)
        : toLocalFsPath(cfg.libraryPath, ctx.customRoots);
      if (libLocal) gogSearchDirs.add(libLocal);
    }
    if (Array.isArray(cfg.installed)) {
      for (const item of cfg.installed) {
        if (item.installPath) {
          const itemLocal = cfgBottleRoot
            ? fromWineWindowsPath(item.installPath, cfgBottleRoot)
            : toLocalFsPath(item.installPath, ctx.customRoots);
          if (itemLocal) gogSearchDirs.add(itemLocal);
        }
      }
    }
  } catch {}
}

function processGogInfoJson(
  /** @type {any} */ ctx,
  /** @type {string} */ infoFilePath,
  /** @type {string} */ rawText
) {
  const { platform, managedCompletedKeys, addRecord } = ctx;
  try {
    const raw = JSON.parse(rawText);
    const fileMatch = path.basename(infoFilePath).match(/^goggame-(\d+)\.info$/i);
    const gameId = String(raw.gameId || raw.rootGameId || (fileMatch ? fileMatch[1] : ''));
    if (!gameId) return;

    const title = String(raw.name || raw.title || `GOG Game ${gameId}`);
    if (/^(steam|epic|custom)-\d+$/i.test(title)) return;
    let installPath = path.dirname(infoFilePath);

    if (isPathUnderActiveDownload(installPath)) return;
    if (
      !managedCompletedKeys.has(`gog:${gameId.toLowerCase()}`) &&
      (fs.existsSync(path.join(installPath, '.gogdl-resume')) ||
        fs.existsSync(path.join(installPath, '.gogdl-download-cache')) ||
        fs.existsSync(path.join(installPath, '.onelauncher-gog-v2-resume.json')))
    ) {
      return;
    }

    const normInfoDir = installPath.replace(/\\/g, '/');
    if (normInfoDir.endsWith('/Contents/Resources')) {
      const candidateParentDir = path.resolve(installPath, '..', '..');
      if (candidateParentDir.toLowerCase().endsWith('.app')) {
        const parentOfApp = path.dirname(candidateParentDir);
        const parentBase = path.basename(parentOfApp).toLowerCase();
        if (
          parentOfApp &&
          !/^(applications|gog|heroic|games|onelauncher)$/i.test(parentBase) &&
          /[\\/](OneLauncher[\\/]GOG|GOG Galaxy[\\/]Games|Heroic)[\\/]/i.test(candidateParentDir)
        ) {
          installPath = parentOfApp;
        } else {
          installPath = candidateParentDir;
        }
      } else {
        installPath = candidateParentDir;
      }
      if (
        !managedCompletedKeys.has(`gog:${gameId.toLowerCase()}`) &&
        (fs.existsSync(path.join(installPath, '.gogdl-resume')) ||
          fs.existsSync(path.join(installPath, '.gogdl-download-cache')) ||
          fs.existsSync(path.join(installPath, '.onelauncher-gog-v2-resume.json')))
      ) {
        return;
      }
    }

    let executablePath = undefined;
    let launchArguments = undefined;
    let isWindowsBinaryOnMac = false;

    if (Array.isArray(raw.playTasks)) {
      const isFileTask = (/** @type {any} */ t) =>
        Boolean(t && t.path && (!t.type || String(t.type) === 'FileTask'));
      let primaryTask = selectPreferredGogPlayTask(
        raw.playTasks,
        [path.dirname(infoFilePath), installPath],
        { platform }
      );
      if (primaryTask && primaryTask.path) {
        const baseName = path.basename(String(primaryTask.path).replace(/\\/g, '/'));
        const stem = extractSiblingLauncherStem(baseName);
        if (stem) {
          const siblingName = `${stem.toLowerCase()}.exe`;
          const siblingTask = raw.playTasks.find((/** @type {any} */ t) => {
            if (!isFileTask(t)) return false;
            const tBase = path.basename(String(t.path).replace(/\\/g, '/')).toLowerCase();
            return tBase === siblingName;
          });
          if (siblingTask) {
            primaryTask = siblingTask;
          }
        }
      }
      if (primaryTask && primaryTask.path) {
        if (
          primaryTask.arguments &&
          typeof primaryTask.arguments === 'string' &&
          primaryTask.arguments.trim()
        ) {
          launchArguments = primaryTask.arguments.trim();
        }
        const relTaskPath = primaryTask.path.replace(/\\/g, path.sep);
        const infoDir = path.dirname(infoFilePath);
        /** @type {Array<{ anchor: string, candidate: string }>} */
        const anchoredCandidates = [
          { anchor: installPath, candidate: path.resolve(installPath, relTaskPath) },
          { anchor: infoDir, candidate: path.resolve(infoDir, relTaskPath) },
        ];
        if (normInfoDir.endsWith('/Contents/Resources')) {
          const bundleRoot = path.resolve(infoDir, '..', '..');
          anchoredCandidates.push({
            anchor: bundleRoot,
            candidate: path.resolve(bundleRoot, relTaskPath),
          });
        }
        for (const { anchor, candidate: c } of anchoredCandidates) {
          if (!isContainedWithinRoot(anchor, c, platform)) {
            continue;
          }
          if (fs.existsSync(c)) {
            const resolvedCand = c.endsWith('.app') ? resolveMacAppBundleBinary(c) : c;
            if (resolvedCand && !isContainedWithinRoot(anchor, resolvedCand, platform)) {
              continue;
            }
            if (platform === 'darwin' && /[\\/]GOGLauncher$/i.test(String(resolvedCand || ''))) {
              continue;
            }
            if (
              platform === 'darwin' &&
              resolvedCand &&
              !resolvedCand.toLowerCase().endsWith('.exe') &&
              inspectMacMachOHeader(resolvedCand).is32BitOnly
            ) {
              continue;
            }
            executablePath = resolvedCand || undefined;
            break;
          }
        }
        if (executablePath && !launchArguments) {
          executablePath = resolveSiblingLauncherStub(executablePath, installPath);
        }
      }
    }

    if (!executablePath) {
      const discovered = findPrimaryExecutable(installPath, {
        platform,
        hintName: title,
        readOnly: true,
      });
      executablePath = resolveSiblingLauncherStub(discovered.executablePath, installPath);
      isWindowsBinaryOnMac = discovered.isWindowsBinaryOnMac;
    } else if (platform === 'darwin' && executablePath.toLowerCase().endsWith('.exe')) {
      isWindowsBinaryOnMac = true;
    }

    const gogClientId =
      typeof raw.clientId === 'string' || typeof raw.clientId === 'number'
        ? String(raw.clientId).trim()
        : '';

    addRecord({
      platformId: 'gog',
      platformGameId: gameId,
      title,
      installPath,
      executablePath,
      ...(launchArguments ? { launchArguments } : {}),
      ...(gogClientId ? { clientId: gogClientId, gogClientId } : {}),
      version: raw.version
        ? String(raw.version)
        : raw.buildId
          ? String(raw.buildId)
          : undefined,
      manifestPath: infoFilePath,
      runner: 'gog',
      isWindowsBinaryOnMac,
    });
  } catch {}
}

function processHeroicGogFileJson(
  /** @type {any} */ ctx,
  /** @type {string} */ hgFile,
  /** @type {string} */ rawText
) {
  const { platform, customRoots, options, addRecord } = ctx;
  try {
    const raw = JSON.parse(rawText);
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.installed)
        ? raw.installed
        : Object.values(raw || {});
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const gameId = String(item.appName || item.gameId || item.id || '');
      const rawInstallPath = item.install_path || item.installPath;
      if (!gameId || !rawInstallPath) continue;
      const installPath = toLocalFsPath(rawInstallPath, customRoots);
      const title = item.title || item.name || `GOG Game ${gameId}`;
      const isWindowsGogItem =
        platform === 'darwin' && String(item.platform || '').toLowerCase() === 'windows';

      if (!installPath || !fs.existsSync(installPath)) {
        if (isExternalVolumeUnmounted(String(rawInstallPath), options)) {
          addRecord({
            platformId: 'gog',
            platformGameId: gameId,
            title,
            installPath: installPath || String(rawInstallPath),
            executablePath: item.executable
              ? toLocalFsPath(item.executable, customRoots) || String(item.executable)
              : undefined,
            installSize: parseByteCountOrFormattedSize(item.install_size ?? item.installSize),
            version: item.version ? String(item.version) : undefined,
            manifestPath: hgFile,
            runner: 'gogdl',
            isWindowsBinaryOnMac: isWindowsGogItem,
            driveDisconnected: true,
          });
        }
        continue;
      }

      const discovered = findPrimaryExecutable(installPath, {
        platform,
        hintName: title,
        preferWindowsExecutable: isWindowsGogItem,
        readOnly: true,
      });
      const rawItemExe = item.executable ? String(item.executable).replace(/\\/g, path.sep) : '';
      const resolvedItemExe = rawItemExe
        ? toLocalFsPath(
            path.isAbsolute(rawItemExe) ? rawItemExe : path.resolve(installPath, rawItemExe),
            customRoots
          )
        : '';
      const itemExeCandidate =
        resolvedItemExe && isContainedWithinRoot(installPath, resolvedItemExe, platform)
          ? resolvedItemExe
          : '';
      const rawHeroicExe =
        itemExeCandidate && fs.existsSync(itemExeCandidate)
          ? itemExeCandidate
          : discovered.executablePath || itemExeCandidate || undefined;
      const resolvedHeroicExe = rawHeroicExe
        ? resolveSiblingLauncherStub(rawHeroicExe, installPath)
        : undefined;
      const isWinOnMac =
        discovered.isWindowsBinaryOnMac ||
        isWindowsGogItem ||
        Boolean(
          platform === 'darwin' &&
            resolvedHeroicExe &&
            resolvedHeroicExe.toLowerCase().endsWith('.exe')
        );

      addRecord({
        platformId: 'gog',
        platformGameId: gameId,
        title,
        installPath,
        executablePath: resolvedHeroicExe,
        installSize: parseByteCountOrFormattedSize(item.install_size ?? item.installSize),
        version: item.version ? String(item.version) : undefined,
        manifestPath: hgFile,
        runner: 'gogdl',
        isWindowsBinaryOnMac: isWinOnMac,
      });
    }
  } catch {}
}

function buildEpicScanSources(/** @type {any} */ ctx, /** @type {string[]} */ discoveredBottleRoots) {
  const { platform, homedir, customRoots, userDataDir, isIsolatedTest, options } = ctx;
  const epicManifestDirs = new Set([
    path.join(homedir, 'Library/Application Support/Epic/EpicGamesLauncher/Data/Manifests'),
    path.join(homedir, 'ProgramData/Epic/EpicGamesLauncher/Data/Manifests'),
    ...discoveredBottleRoots.map((bRoot) =>
      path.join(bRoot, 'drive_c/ProgramData/Epic/EpicGamesLauncher/Data/Manifests')
    ),
  ]);
  if (!isIsolatedTest) {
    epicManifestDirs.add('C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests');
    if (platform === 'win32') {
      const regEpic = discoverWindowsEpicRegistryPaths(options);
      if (regEpic.manifestsDir) {
        epicManifestDirs.add(regEpic.manifestsDir);
      }
    }
  }
  for (const root of customRoots) {
    const localRoot = toLocalFsPath(root, customRoots);
    if (!localRoot) continue;
    epicManifestDirs.add(localRoot);
    epicManifestDirs.add(path.join(localRoot, 'Manifests'));
    epicManifestDirs.add(path.join(localRoot, 'Data', 'Manifests'));
    epicManifestDirs.add(path.join(localRoot, 'Epic/EpicGamesLauncher/Data/Manifests'));
    epicManifestDirs.add(
      path.join(localRoot, 'ProgramData/Epic/EpicGamesLauncher/Data/Manifests')
    );
  }

  const launcherInstalledFiles = [
    path.join(
      homedir,
      'Library/Application Support/Epic/UnrealEngineLauncher/LauncherInstalled.dat'
    ),
    ...discoveredBottleRoots.map((bRoot) =>
      path.join(bRoot, 'drive_c/ProgramData/Epic/UnrealEngineLauncher/LauncherInstalled.dat')
    ),
    ...customRoots.map((/** @type {string} */ r) =>
      path.join(toLocalFsPath(r, customRoots), 'LauncherInstalled.dat')
    ),
    ...customRoots.map((/** @type {string} */ r) =>
      path.join(
        toLocalFsPath(r, customRoots),
        'Epic/UnrealEngineLauncher/LauncherInstalled.dat'
      )
    ),
  ];
  if (!isIsolatedTest) {
    launcherInstalledFiles.push(
      'C:\\ProgramData\\Epic\\UnrealEngineLauncher\\LauncherInstalled.dat'
    );
  }

  const managedLegendaryInstalledPath = path.resolve(
    path.join(userDataDir, 'legendaryConfig/legendary/installed.json')
  );
  const legendaryFiles = [
    path.join(userDataDir, 'legendaryConfig/legendary/installed.json'),
    path.join(
      homedir,
      'Library/Application Support/heroic/legendaryConfig/legendary/installed.json'
    ),
    path.join(homedir, '.config/legendary/installed.json'),
    path.join(homedir, 'AppData/Roaming/heroic/legendaryConfig/legendary/installed.json'),
    ...customRoots.map((/** @type {string} */ r) =>
      path.join(toLocalFsPath(r, customRoots), 'installed.json')
    ),
    ...customRoots.map((/** @type {string} */ r) =>
      path.join(toLocalFsPath(r, customRoots), 'legendary/installed.json')
    ),
    ...customRoots.map((/** @type {string} */ r) =>
      path.join(toLocalFsPath(r, customRoots), 'heroic/legendaryConfig/legendary/installed.json')
    ),
  ];

  return {
    epicManifestDirs,
    launcherInstalledFiles,
    legendaryFiles,
    managedLegendaryInstalledPath,
  };
}

function collectEpicDlcAppNamesFromLegendaryJson(
  /** @type {any} */ ctx,
  /** @type {string} */ rawText
) {
  try {
    const raw = JSON.parse(rawText);
    const entries = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
        ? Object.entries(raw).map(([k, v]) =>
            v && typeof v === 'object' ? { _mapKey: k, app_name: k, ...v } : null
          )
        : [];
    for (const item of entries) {
      if (!item || typeof item !== 'object') continue;
      if (item.is_dlc === true || item.isDlc === true) {
        const appName = String(item.app_name || item.appName || '').trim();
        if (appName) ctx.markEpicDlcAppName(appName);
      }
    }
  } catch {}
}

function isEpicItemManifestDlc(/** @type {any} */ item, /** @type {string} */ appName) {
  if (!item || typeof item !== 'object') return false;
  if (item.bIsApplication === false) return true;
  const mainGameAppName = String(item.MainGameAppName || '').trim();
  if (mainGameAppName && appName && mainGameAppName.toLowerCase() !== appName.toLowerCase()) {
    return true;
  }
  const catalogItemId = String(item.CatalogItemId || '').trim();
  const mainGameCatalogItemId = String(item.MainGameCatalogItemId || '').trim();
  if (
    mainGameCatalogItemId &&
    catalogItemId &&
    mainGameCatalogItemId.toLowerCase() !== catalogItemId.toLowerCase()
  ) {
    return true;
  }
  if (Array.isArray(item.AppCategories)) {
    const hasAddonCategory = item.AppCategories.some((/** @type {unknown} */ c) =>
      String(c || '')
        .toLowerCase()
        .split('/')
        .some((seg) =>
          ['addons', 'add-on', 'addon', 'dlc', 'digitalextras', 'consumable'].includes(seg.trim())
        )
    );
    if (hasAddonCategory) return true;
  }
  return false;
}

function processEpicItemJson(
  /** @type {any} */ ctx,
  /** @type {string | null} */ manifestBottleRoot,
  /** @type {string} */ itemPath,
  /** @type {string} */ rawText
) {
  const { platform, customRoots, userDataDir, isIsolatedTest, options, addRecord } = ctx;
  try {
    const item = JSON.parse(rawText);
    if (item.bIsIncompleteInstall === true) return;

    const appName = String(item.AppName || item.CatalogItemId || '');
    if (!appName) return;

    if (isEpicItemManifestDlc(item, appName)) {
      ctx.markEpicDlcAppName(appName);
      if (item.CatalogItemId) ctx.markEpicDlcAppName(item.CatalogItemId);
      return;
    }
    if (
      ctx.isKnownEpicDlc(appName) ||
      (item.CatalogItemId && ctx.isKnownEpicDlc(item.CatalogItemId))
    ) {
      return;
    }

    const title = String(item.DisplayName || appName);
    const rawInstallLoc = item.InstallLocation || '';
    const installPath = manifestBottleRoot
      ? fromWineWindowsPath(rawInstallLoc, manifestBottleRoot)
      : toLocalFsPath(rawInstallLoc, customRoots);

    if (!installPath || !fs.existsSync(installPath)) {
      const checkUnmountedPath = installPath || String(rawInstallLoc);
      if (isExternalVolumeUnmounted(checkUnmountedPath, options)) {
        addRecord({
          platformId: 'epic',
          platformGameId: appName,
          title,
          installPath: checkUnmountedPath,
          installSize: parseByteCountOrFormattedSize(item.InstallSize),
          version: item.AppVersionString ? String(item.AppVersionString) : undefined,
          manifestPath: itemPath,
          runner: 'epic',
          isWindowsBinaryOnMac: Boolean(platform === 'darwin' && manifestBottleRoot),
          driveDisconnected: true,
        });
      }
      return;
    }

    let executablePath = undefined;
    let isWindowsBinaryOnMac = Boolean(platform === 'darwin' && manifestBottleRoot);

    if (item.LaunchExecutable) {
      const cleanLaunchExe = String(item.LaunchExecutable).replace(/\\/g, path.sep);
      const candidateExe = path.resolve(installPath, cleanLaunchExe);
      const isContainedCand = isContainedWithinRoot(installPath, candidateExe, platform);
      if (isContainedCand && fs.existsSync(candidateExe)) {
        const resolvedCand = candidateExe.endsWith('.app')
          ? resolveMacAppBundleBinary(candidateExe)
          : candidateExe;
        if (resolvedCand && isContainedWithinRoot(installPath, resolvedCand, platform)) {
          executablePath = resolvedCand;
        }
      }
      if (!executablePath) {
        const discovered = findPrimaryExecutable(installPath, {
          platform,
          hintName: title,
          readOnly: true,
        });
        executablePath = discovered.executablePath;
        isWindowsBinaryOnMac = isWindowsBinaryOnMac || discovered.isWindowsBinaryOnMac;
      }
    } else {
      const discovered = findPrimaryExecutable(installPath, {
        platform,
        hintName: title,
        readOnly: true,
      });
      executablePath = discovered.executablePath;
      isWindowsBinaryOnMac = isWindowsBinaryOnMac || discovered.isWindowsBinaryOnMac;
    }

    const launchArguments =
      item.LaunchCommand && typeof item.LaunchCommand === 'string'
        ? item.LaunchCommand.trim()
        : '';

    if (executablePath && !launchArguments) {
      executablePath = resolveSiblingLauncherStub(executablePath, installPath);
    }
    if (!executablePath || !fs.existsSync(executablePath)) return;

    if (
      platform === 'darwin' &&
      executablePath &&
      executablePath.toLowerCase().endsWith('.exe')
    ) {
      isWindowsBinaryOnMac = true;
    }

    if (Boolean(options.userDataDir) || !isIsolatedTest) {
      recordImportedEpicInstall({ appName, installPath, source: itemPath }, { userDataDir });
    }

    addRecord({
      platformId: 'epic',
      platformGameId: appName,
      title,
      installPath,
      executablePath,
      ...(launchArguments ? { launchArguments } : {}),
      installSize: parseByteCountOrFormattedSize(item.InstallSize),
      version: item.AppVersionString ? String(item.AppVersionString) : undefined,
      manifestPath: itemPath,
      runner: 'epic',
      isWindowsBinaryOnMac,
    });
  } catch {}
}

function processEpicDatJson(
  /** @type {any} */ ctx,
  /** @type {string} */ datFile,
  /** @type {string | null} */ datBottleRoot,
  /** @type {string} */ rawText
) {
  const { platform, customRoots, userDataDir, isIsolatedTest, options, addRecord } = ctx;
  try {
    const dat = JSON.parse(rawText);
    const list = Array.isArray(dat?.InstallationList) ? dat.InstallationList : [];
    for (const entry of list) {
      const appName = String(entry.AppName || entry.ArtifactId || '');
      if (!appName || appName.startsWith('UE_')) continue;
      if (ctx.isKnownEpicDlc(appName) || (entry.ItemId && ctx.isKnownEpicDlc(entry.ItemId))) {
        continue;
      }
      const rawInstallLoc = entry.InstallLocation || '';
      const installPath = datBottleRoot
        ? fromWineWindowsPath(rawInstallLoc, datBottleRoot)
        : toLocalFsPath(rawInstallLoc, customRoots);
      if (!installPath || !fs.existsSync(installPath)) {
        const checkUnmountedPath = installPath || String(rawInstallLoc);
        if (isExternalVolumeUnmounted(checkUnmountedPath, options)) {
          addRecord({
            platformId: 'epic',
            platformGameId: appName,
            title: entry.DisplayName || path.basename(checkUnmountedPath) || appName,
            installPath: checkUnmountedPath,
            version: entry.AppVersion ? String(entry.AppVersion) : undefined,
            manifestPath: datFile,
            runner: 'epic',
            isWindowsBinaryOnMac: Boolean(platform === 'darwin' && datBottleRoot),
            driveDisconnected: true,
          });
        }
        continue;
      }

      const discovered = findPrimaryExecutable(installPath, {
        platform,
        hintName: appName,
        readOnly: true,
      });
      const effectiveEpicExe = resolveSiblingLauncherStub(discovered.executablePath, installPath);
      if (!effectiveEpicExe || !fs.existsSync(effectiveEpicExe)) continue;

      if (Boolean(options.userDataDir) || !isIsolatedTest) {
        recordImportedEpicInstall({ appName, installPath, source: datFile }, { userDataDir });
      }

      addRecord({
        platformId: 'epic',
        platformGameId: appName,
        title: entry.DisplayName || path.basename(installPath) || appName,
        installPath,
        executablePath: effectiveEpicExe,
        version: entry.AppVersion ? String(entry.AppVersion) : undefined,
        manifestPath: datFile,
        runner: 'epic',
        isWindowsBinaryOnMac:
          discovered.isWindowsBinaryOnMac || Boolean(platform === 'darwin' && datBottleRoot),
      });
    }
  } catch {}
}

function processLegendaryFileJson(
  /** @type {any} */ ctx,
  /** @type {string} */ legFile,
  /** @type {boolean} */ isExternalLegFile,
  /** @type {string} */ rawText
) {
  const { platform, customRoots, userDataDir, isIsolatedTest, options, addRecord } = ctx;
  try {
    const raw = JSON.parse(rawText);
    const entries = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
        ? Object.entries(raw).map(([k, v]) =>
            v && typeof v === 'object' ? { _mapKey: k, app_name: k, ...v } : null
          )
        : [];

    for (const item of entries) {
      if (!item || typeof item !== 'object') continue;
      const appName = String(item.app_name || item.appName || '');
      if (item.is_dlc === true || item.isDlc === true) {
        if (appName) ctx.markEpicDlcAppName(appName);
        continue;
      }
      if (appName && ctx.isKnownEpicDlc(appName)) {
        continue;
      }
      const rawInstallPath = item.install_path || item.installPath;
      if (!appName || !rawInstallPath) continue;

      const title = String(item.title || appName);
      const installPath = toLocalFsPath(rawInstallPath, customRoots);
      if (!installPath || !fs.existsSync(installPath)) {
        const checkUnmountedPath = installPath || String(rawInstallPath);
        if (isExternalVolumeUnmounted(checkUnmountedPath, options)) {
          addRecord({
            platformId: 'epic',
            platformGameId: appName,
            title,
            installPath: checkUnmountedPath,
            installSize: parseByteCountOrFormattedSize(item.install_size ?? item.installSize),
            version: item.version ? String(item.version) : undefined,
            manifestPath: legFile,
            runner: 'legendary',
            isWindowsBinaryOnMac: Boolean(
              platform === 'darwin' &&
                String(item.platform || '').toLowerCase() === 'windows'
            ),
            driveDisconnected: true,
          });
        }
        continue;
      }

      let executablePath = undefined;
      if (item.executable) {
        const cleanExe = String(item.executable).replace(/\\/g, path.sep);
        const candidate = path.isAbsolute(cleanExe)
          ? cleanExe
          : path.resolve(installPath, cleanExe);
        const localCand = toLocalFsPath(candidate, customRoots);
        if (localCand && isContainedWithinRoot(installPath, localCand, platform)) {
          executablePath = localCand;
        }
      }
      const discovered = findPrimaryExecutable(installPath, {
        platform,
        hintName: title,
        readOnly: true,
      });
      if (!executablePath || !fs.existsSync(executablePath)) {
        executablePath = discovered.executablePath;
      }
      if (executablePath) {
        executablePath = resolveSiblingLauncherStub(executablePath, installPath);
      }
      if (!executablePath || !fs.existsSync(executablePath)) {
        continue;
      }

      if (isExternalLegFile && (Boolean(options.userDataDir) || !isIsolatedTest)) {
        recordImportedEpicInstall({ appName, installPath, source: legFile }, { userDataDir });
      }

      const isWindowsBinaryOnMac =
        discovered.isWindowsBinaryOnMac ||
        (platform === 'darwin' &&
          (String(item.platform || '').toLowerCase() === 'windows' ||
            Boolean(executablePath && executablePath.toLowerCase().endsWith('.exe'))));

      const launchArguments =
        item.launch_parameters && typeof item.launch_parameters === 'string'
          ? item.launch_parameters.trim()
          : '';

      addRecord({
        platformId: 'epic',
        platformGameId: appName,
        title,
        installPath,
        executablePath,
        ...(launchArguments ? { launchArguments } : {}),
        installSize: parseByteCountOrFormattedSize(item.install_size ?? item.installSize),
        version: item.version ? String(item.version) : undefined,
        manifestPath: legFile,
        runner: 'legendary',
        isWindowsBinaryOnMac,
      });
    }
  } catch {}
}

function processXboxCandidateDir(/** @type {any} */ ctx, /** @type {string} */ xboxDir) {
  const xboxRecord = inspectInstalledXboxGameDir(xboxDir, {
    platform: ctx.platform,
    strictPe: Boolean(ctx.options.strictPe),
  });
  if (
    xboxRecord &&
    !(xboxRecord.isExternalLauncherStub && !xboxRecord.executablePath) &&
    !isGdkStubExecutablePath(xboxRecord.executablePath)
  ) {
    ctx.addRecord(xboxRecord);
  }
}

function collectDarwinChainedBottlePaths(/** @type {any} */ ctx) {
  const { options, customRoots } = ctx;
  const explicitHomedirOpt = options.homedir ? { homedir: options.homedir } : {};
  const bottleSet = new Set(
    listAllInitializedBottlePaths({
      ...options,
      platform: 'darwin',
      ...explicitHomedirOpt,
    })
  );
  for (const cr of customRoots) {
    if (!cr || typeof cr !== 'string') continue;
    const bRoot = extractBottleRootFromPath(cr);
    if (bRoot && fs.existsSync(bRoot)) {
      bottleSet.add(path.resolve(bRoot));
    } else if (
      fs.existsSync(path.join(cr, 'drive_c')) ||
      fs.existsSync(path.join(cr, 'system.reg'))
    ) {
      bottleSet.add(path.resolve(cr));
    }
  }
  return Array.from(bottleSet);
}

function reconcileChainedPublisherEntries(
  /** @type {any} */ ctx,
  /** @type {Array<{ found: any, isBottle: boolean, compatibilityLayer?: string, wineBottle?: string }>} */ discoveredPublisherEntries
) {
  if (discoveredPublisherEntries.length === 0) return;
  const { userDataDir, options, preloadedManagedRecords, steamInstalledDirPaths, platform, addRecord } =
    ctx;
  const catalogIndex = loadChainedCatalogIndex(
    userDataDir,
    options,
    preloadedManagedRecords,
    ctx.getEpicLocalMetadataOnce
  );
  for (const item of discoveredPublisherEntries) {
    const { found, isBottle, compatibilityLayer, wineBottle } = item;
    if (
      !found ||
      !found.handoffId ||
      !found.installPath ||
      !found.executablePath ||
      isGdkStubExecutablePath(found.executablePath)
    ) {
      continue;
    }

    const resolvedFoundPathLower = path.resolve(found.installPath).toLowerCase();
    // Skip Steam depots (`steamapps/common/*`) that register in EA/Ubisoft Windows registry
    // so Steam `storefront_depot_uri` games never emit duplicate `ea:<contentId>` cards or hijack other stores.
    if (
      /(?:^|[\\/])steamapps[\\/]common(?:[\\/]|$)/i.test(found.installPath) ||
      steamInstalledDirPaths.has(resolvedFoundPathLower)
    ) {
      continue;
    }

    const handoffId = resolveAnyChainedHandoffId(found.handoffId) || found.handoffId;
    const extId = found.externalInstallId ? String(found.externalInstallId) : '';
    const matchKeys = Array.from(
      new Set([
        ...buildChainedTitleMatchKeys(found.title || ''),
        ...buildChainedTitleMatchKeys(path.basename(found.installPath)),
      ])
    );

    const managedPathMatch =
      catalogIndex.managedByInstallPath.get(resolvedFoundPathLower) || null;
    const extMatch =
      !managedPathMatch && extId
        ? catalogIndex.byExternalId.get(`${handoffId}:${extId.toLowerCase()}`) || null
        : null;
    let xboxMatch = null;
    let epicMatch = null;
    let standaloneMatch = null;
    if (!managedPathMatch && !extMatch) {
      for (const mk of matchKeys) {
        xboxMatch = catalogIndex.xboxHandoffByFullKey.get(`${handoffId}:${mk}`) || null;
        if (xboxMatch) break;
      }
      if (!xboxMatch) {
        for (const mk of matchKeys) {
          epicMatch = catalogIndex.epicHandoffByFullKey.get(`${handoffId}:${mk}`) || null;
          if (epicMatch) break;
        }
      }
      if (!xboxMatch && !epicMatch) {
        for (const mk of matchKeys) {
          xboxMatch = catalogIndex.xboxHandoffByBaseKey.get(`${handoffId}:${mk}`) || null;
          if (xboxMatch) break;
        }
      }
      if (!xboxMatch && !epicMatch) {
        for (const mk of matchKeys) {
          epicMatch = catalogIndex.epicHandoffByBaseKey.get(`${handoffId}:${mk}`) || null;
          if (epicMatch) break;
        }
      }
      if (!xboxMatch && !epicMatch) {
        for (const mk of matchKeys) {
          standaloneMatch = catalogIndex.standaloneByFullKey.get(`${handoffId}:${mk}`) || null;
          if (standaloneMatch) break;
        }
      }
      if (!xboxMatch && !epicMatch && !standaloneMatch) {
        for (const mk of matchKeys) {
          standaloneMatch = catalogIndex.standaloneByBaseKey.get(`${handoffId}:${mk}`) || null;
          if (standaloneMatch) break;
        }
      }
    }

    let targetPlatformId = handoffId;
    let targetPlatformGameId =
      extId || normalizeComparableTitle(found.title || '') || path.basename(found.installPath);
    /** @type {string | undefined} */
    let xboxProductId = undefined;
    let resolvedTitle = found.title || path.basename(found.installPath);
    /** @type {string | undefined} */
    let chainedHandoffTopology = undefined;

    if (managedPathMatch) {
      targetPlatformId = managedPathMatch.platformId;
      targetPlatformGameId = managedPathMatch.platformGameId;
      xboxProductId = managedPathMatch.xboxProductId;
      if (managedPathMatch.title) resolvedTitle = managedPathMatch.title;
      if (targetPlatformId === 'epic') {
        chainedHandoffTopology = 'partner_launcher_link';
      } else if (targetPlatformId === 'xbox') {
        chainedHandoffTopology = 'publisher_managed';
      }
    } else if (extMatch) {
      targetPlatformId = extMatch.platformId;
      targetPlatformGameId = extMatch.platformGameId;
      xboxProductId = extMatch.xboxProductId;
      if (extMatch.title) resolvedTitle = extMatch.title;
      if (targetPlatformId === 'epic') {
        chainedHandoffTopology = 'partner_launcher_link';
      } else if (targetPlatformId === 'xbox') {
        chainedHandoffTopology = 'publisher_managed';
      }
    } else if (xboxMatch) {
      targetPlatformId = 'xbox';
      targetPlatformGameId = xboxMatch.platformGameId;
      xboxProductId = xboxMatch.xboxProductId || xboxMatch.platformGameId;
      if (xboxMatch.title) resolvedTitle = xboxMatch.title;
      chainedHandoffTopology = 'publisher_managed';
    } else if (epicMatch) {
      targetPlatformId = 'epic';
      targetPlatformGameId = epicMatch.platformGameId;
      if (epicMatch.title) resolvedTitle = epicMatch.title;
      chainedHandoffTopology = 'partner_launcher_link';
    } else if (standaloneMatch) {
      targetPlatformId = standaloneMatch.platformId;
      targetPlatformGameId = standaloneMatch.platformGameId;
      if (standaloneMatch.title) resolvedTitle = standaloneMatch.title;
    }

    const installSize = parseByteCountOrFormattedSize(found.installSizeBytes);
    addRecord({
      platformId: targetPlatformId,
      platformGameId: targetPlatformGameId,
      storefrontAppId: targetPlatformGameId,
      ...(xboxProductId ? { xboxProductId } : {}),
      title: resolvedTitle,
      installPath: found.installPath,
      executablePath: found.executablePath,
      ...(installSize ? { installSize } : {}),
      chainedLauncherHandoff: handoffId,
      externalStorefrontHandoff: handoffId,
      ...(chainedHandoffTopology ? { chainedHandoffTopology } : {}),
      ...(extId ? { chainedExternalInstallId: extId } : {}),
      runner: isBottle ? 'chained_bottle' : 'chained_host',
      ...(isBottle
        ? {
            ...(compatibilityLayer ? { compatibilityLayer } : {}),
            ...(wineBottle ? { wineBottle } : {}),
            isWindowsBinaryOnMac: true,
          }
        : {
            isWindowsBinaryOnMac:
              platform === 'darwin' && String(found.executablePath).toLowerCase().endsWith('.exe'),
          }),
    });
  }
}

function processManagedInstallRecord(/** @type {any} */ ctx, /** @type {any} */ rec) {
  const { platform, customRoots, options, discoveredMap, addRecord } = ctx;
  if (!rec || !rec.platformId || !rec.platformGameId) return;
  if (isGdkStubExecutablePath(rec.executablePath)) return;
  const localInstall = toLocalFsPath(rec.installPath, customRoots);
  if (localInstall && fs.existsSync(localInstall)) {
    const existingKey = `${rec.platformId}:${rec.platformGameId}`;
    const existingDiscovered = discoveredMap.get(existingKey);
    const isSameInstallDir = Boolean(
      existingDiscovered &&
        existingDiscovered.installPath &&
        !existingDiscovered.driveDisconnected &&
        path.resolve(existingDiscovered.installPath) === path.resolve(localInstall)
    );
    const matchedDiscovered = isSameInstallDir ? existingDiscovered : null;
    const isChainedManagedRecord = Boolean(
      rec.chainedLauncherHandoff || rec.externalStorefrontHandoff
    );
    if (rec.platformId === 'xbox' && !matchedDiscovered && !isChainedManagedRecord) {
      const inspectedManagedXbox = inspectInstalledXboxGameDir(localInstall, {
        platform,
        strictPe: Boolean(options.strictPe),
      });
      if (
        !inspectedManagedXbox ||
        (inspectedManagedXbox.isExternalLauncherStub && !inspectedManagedXbox.executablePath)
      ) {
        return;
      }
    }
    const recExeLocal = rec.executablePath ? toLocalFsPath(rec.executablePath, customRoots) : '';
    const isRecExeValid =
      Boolean(recExeLocal) &&
      fs.existsSync(recExeLocal) &&
      !isGdkStubExecutablePath(recExeLocal) &&
      !isExcludedExecutable(path.basename(recExeLocal)) &&
      !/\.com$/i.test(recExeLocal);
    const discovered =
      matchedDiscovered && matchedDiscovered.executablePath
        ? {
            executablePath: matchedDiscovered.executablePath,
            isWindowsBinaryOnMac: matchedDiscovered.isWindowsBinaryOnMac,
          }
        : findPrimaryExecutable(localInstall, {
            platform,
            hintName: rec.title,
            readOnly: true,
          });
    const rawEffectiveExe =
      matchedDiscovered?.executablePath ||
      (isRecExeValid ? recExeLocal : undefined) ||
      discovered.executablePath;
    const effectiveExe = resolveSiblingLauncherStub(rawEffectiveExe, localInstall);
    if (!effectiveExe || !fs.existsSync(effectiveExe) || isGdkStubExecutablePath(effectiveExe)) {
      return;
    }
    const effectiveLaunchArgs =
      matchedDiscovered?.launchArguments ||
      rec.launchArguments ||
      resolveDefaultEngineLaunchArguments(localInstall, effectiveExe);
    const inferredWinOnMac =
      matchedDiscovered?.isWindowsBinaryOnMac !== undefined
        ? matchedDiscovered.isWindowsBinaryOnMac
        : rec.isWindowsBinaryOnMac !== undefined
          ? rec.isWindowsBinaryOnMac
          : Boolean(
              discovered.isWindowsBinaryOnMac ||
                (platform === 'darwin' &&
                  ((effectiveExe && /\.exe$/i.test(effectiveExe)) ||
                    /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(
                      String(effectiveExe || rec.installPath || '')
                    )))
            );
    const effectiveInstallSize =
      parseByteCountOrFormattedSize(matchedDiscovered?.installSize) ||
      parseByteCountOrFormattedSize(rec.installSize);
    const effectiveRunner =
      rec.runner && rec.runner !== 'one_launcher'
        ? rec.runner
        : matchedDiscovered?.runner || rec.runner || 'one_launcher';
    addRecord({
      ...rec,
      installPath: localInstall,
      executablePath: effectiveExe,
      ...(effectiveLaunchArgs ? { launchArguments: effectiveLaunchArgs } : {}),
      ...(effectiveInstallSize ? { installSize: effectiveInstallSize } : {}),
      runner: effectiveRunner,
      isWindowsBinaryOnMac: inferredWinOnMac,
    });
  } else if (rec.installPath && isExternalVolumeUnmounted(String(rec.installPath), options)) {
    const preservedInstallSize = parseByteCountOrFormattedSize(rec.installSize);
    addRecord({
      ...rec,
      installPath: localInstall || String(rec.installPath),
      ...(preservedInstallSize ? { installSize: preservedInstallSize } : {}),
      runner: rec.runner || 'one_launcher',
      driveDisconnected: true,
    });
  }
}

function processCustomLaunchConfigEntry(/** @type {any} */ ctx, /** @type {any} */ cfg) {
  const { platform, customRoots, discoveredMap, addRecord } = ctx;
  if (!cfg || typeof cfg !== 'object') return;
  const customEntries = [];
  const seenPlatExe = new Set();

  if (cfg.platformConfigs && typeof cfg.platformConfigs === 'object') {
    for (const [platId, prof] of Object.entries(cfg.platformConfigs)) {
      if (!prof || typeof prof !== 'object' || !prof.customExecutablePath) continue;
      const customExe = toLocalFsPath(prof.customExecutablePath, customRoots);
      if (!customExe) continue;
      const dedupeKey = `${platId}:${customExe}`;
      if (seenPlatExe.has(dedupeKey)) continue;
      seenPlatExe.add(dedupeKey);
      customEntries.push({
        platId,
        customExe,
        workingDirectory: prof.workingDirectory,
      });
    }
  }

  if (cfg.customExecutablePath) {
    const platId = cfg.preferredPlatformId || 'custom';
    const customExe = toLocalFsPath(cfg.customExecutablePath, customRoots);
    if (customExe) {
      const dedupeKey = `${platId}:${customExe}`;
      if (!seenPlatExe.has(dedupeKey)) {
        seenPlatExe.add(dedupeKey);
        customEntries.push({
          platId,
          customExe,
          workingDirectory: cfg.workingDirectory,
        });
      }
    }
  }

  for (const entry of customEntries) {
    const { platId, customExe, workingDirectory } = entry;
    if (customExe && fs.existsSync(customExe)) {
      const platformGameId = String(cfg.gameId).replace(/^(steam|gog|epic|xbox|custom)-/, '');
      const installPath = workingDirectory
        ? toLocalFsPath(workingDirectory, customRoots)
        : path.dirname(customExe);
      const alreadyDiscovered = Array.from(discoveredMap.values()).some(
        (r) =>
          r &&
          (platId === 'custom' || r.platformId === platId) &&
          ((installPath && r.installPath === installPath) ||
            (customExe && r.executablePath === customExe))
      );
      if (alreadyDiscovered) continue;
      addRecord({
        platformId: platId,
        platformGameId,
        storefrontAppId: String(cfg.gameId),
        title: cfg.title || String(cfg.gameId),
        installPath,
        executablePath: customExe,
        runner: 'custom',
        isWindowsBinaryOnMac: platform === 'darwin' && customExe.toLowerCase().endsWith('.exe'),
      });
    }
  }
}

/**
 * Populate `executableArchitecture` (`'x64' | 'x86' | 'arm64'`) and `is32BitExecutable`
 * on a scanned Windows game record via the cached, bounded PE header reader.
 *
 * @param {any} g
 * @param {string[]} [customRoots]
 * @param {string | null} [localInstallDir]
 */
function enrichWindowsExecutableArchitecture(g, customRoots = [], localInstallDir = null) {
  if (!g || g.driveDisconnected) return;
  /** @type {string[]} */
  const candidatePaths = [];
  if (typeof g.paradoxDirectGameExe === 'string' && g.paradoxDirectGameExe.trim()) {
    candidatePaths.push(g.paradoxDirectGameExe.trim());
  }
  if (typeof g.executablePath === 'string' && g.executablePath.trim()) {
    candidatePaths.push(g.executablePath.trim());
  }
  for (const rawExe of candidatePaths) {
    if (!/\.exe$/i.test(rawExe)) continue;
    let localExe = toLocalFsPath(rawExe, customRoots);
    if (localExe && !path.isAbsolute(localExe) && localInstallDir) {
      const resolvedRel = path.resolve(localInstallDir, localExe);
      if (isContainedWithinRoot(localInstallDir, resolvedRel)) {
        localExe = resolvedRel;
      }
    }
    if (!localExe) continue;
    const peInfo = inspectWindowsExecutableHeader(localExe, {
      skipImports: true,
      skipRdataStringScan: true,
      inspectDpiManifest: false,
      inspectElevationManifest: false,
    });
    if (!peInfo || !peInfo.isValidPe || peInfo.isSyntheticStub) continue;
    const arch = peInfo.isX64
      ? 'x64'
      : peInfo.isX86
        ? 'x86'
        : peInfo.isArm64
          ? 'arm64'
          : null;
    if (arch) {
      g.executableArchitecture = arch;
      g.is32BitExecutable = arch === 'x86';
      return;
    }
  }
}

function enrichSingleInstalledGameRecord(/** @type {any} */ g, /** @type {string[]} */ customRoots = []) {
  if (!g || g.driveDisconnected) {
    return;
  }
  let localInstallDir = null;
  if (g.installPath && typeof g.installPath === 'string') {
    try {
      const candidateInstallDir = toLocalFsPath(g.installPath, customRoots);
      if (candidateInstallDir && fs.existsSync(candidateInstallDir)) {
        localInstallDir = candidateInstallDir;
        const acMarkers = detectKernelAntiCheatMarkersInDir(localInstallDir);
        if (
          acMarkers.kernelAntiCheatName ||
          acMarkers.requiresKernelAntiCheat ||
          acMarkers.storyModeBypassAvailable
        ) {
          if (g.requiresKernelAntiCheat === undefined) {
            g.requiresKernelAntiCheat = acMarkers.requiresKernelAntiCheat;
          }
          if (!g.kernelAntiCheatName && acMarkers.kernelAntiCheatName) {
            g.kernelAntiCheatName = acMarkers.kernelAntiCheatName;
          }
          if (acMarkers.storyModeBypassAvailable) {
            g.storyModeBypassAvailable = true;
          }
        }
        if (g.executablePath && !g.paradoxDirectGameExe) {
          const exeBase = path.posix.basename(String(g.executablePath).replace(/\\/g, '/'));
          if (/^dowser\.exe$/i.test(exeBase)) {
            const pdx = resolveParadoxLauncherSettings(
              toLocalFsPath(g.executablePath, customRoots) || localInstallDir,
              localInstallDir
            );
            if (pdx.paradoxDirectGameExe) {
              g.paradoxDirectGameExe = pdx.paradoxDirectGameExe;
            }
          }
        }
      }
    } catch {}
  }
  try {
    enrichWindowsExecutableArchitecture(g, customRoots, localInstallDir);
  } catch {}
}

function finalizeScanContext(/** @type {any} */ ctx, /** @type {any[]} */ installedGames) {
  const { options, userDataDir, installedSteamAppIds, isDefaultProdScan } = ctx;
  let epicPlatformSupport = {};
  try {
    const metaRes = ctx.getEpicLocalMetadataOnce();
    epicPlatformSupport = metaRes?.epicPlatformSupport || {};
  } catch (stageErr) {
    diagLog.warn(
      'scanAllInstalledGames.stageError',
      stageErr,
      { stage: 'epic_metadata' },
      { userDataDir }
    );
  }
  try {
    Object.defineProperty(installedGames, 'epicPlatformSupport', {
      value: epicPlatformSupport,
      enumerable: false,
      configurable: true,
    });
  } catch {}

  if (!options.skipFirstPartySync) {
    const epicFingerprint = installedGames
      .filter((g) => g && g.platformId === 'epic' && !g.driveDisconnected)
      .map((g) => `${g.platformGameId}:${g.installPath}`)
      .sort()
      .join('|');
    const isSyncableGogInstall = (/** @type {any} */ g) =>
      Boolean(
        g &&
          g.platformId === 'gog' &&
          !g.driveDisconnected &&
          g.runner !== 'custom' &&
          g.runner !== 'gog_galaxy' &&
          g.installPath &&
          !isPathUnderActiveDownload(g.installPath)
      );
    const gogFingerprint = installedGames
      .filter(isSyncableGogInstall)
      .map((g) => `${g.platformGameId}:${g.installPath}`)
      .sort()
      .join('|');

    const runFirstPartySyncSynchronously = Boolean(
      options.homedir ||
        options.syncFirstParty === true ||
        options.eglManifestsDir ||
        options.gogGalaxyConfigPath ||
        options.gogGalaxyStorageDir
    );

    if (runFirstPartySyncSynchronously) {
      try {
        if (installedGames.some((g) => g && g.platformId === 'epic' && !g.driveDisconnected)) {
          syncEpicFirstPartyLauncher({ ...options, fromAutoScan: true });
        }
      } catch {}
      try {
        for (const g of installedGames) {
          if (isSyncableGogInstall(g)) {
            syncGogFirstPartyLauncher(g, { ...options, fromAutoScan: true });
          }
        }
      } catch {}
    } else {
      if (epicFingerprint && epicFingerprint !== getLastSyncedEpicFingerprint()) {
        setLastSyncedEpicFingerprint(epicFingerprint);
        setImmediate(() => {
          try {
            syncEpicFirstPartyLauncher({ ...options, fromAutoScan: true });
          } catch {}
        });
      }
      if (gogFingerprint && gogFingerprint !== getLastSyncedGogFingerprint()) {
        setLastSyncedGogFingerprint(gogFingerprint);
        setImmediate(() => {
          try {
            for (const g of installedGames) {
              if (isSyncableGogInstall(g)) {
                syncGogFirstPartyLauncher(g, { ...options, fromAutoScan: true });
              }
            }
          } catch {}
        });
      }
    }
  }

  if (isDefaultProdScan) {
    setLastProductionScanCache({
      timestamp: Date.now(),
      result: { installedGames, installedSteamAppIds, epicPlatformSupport },
    });
  }

  return {
    success: true,
    installedGames,
    installedSteamAppIds,
    epicPlatformSupport,
  };
}

/**
 * Multi-Storefront & Multi-Drive Read-Only Installation Scanner (Synchronous).
 * Zero file/folder mutations during scanning; preserves external-drive records when unmounted.
 * Calls `detectCompatibilityLayers` and `collectLocalEpicMetadataAndSupport` at most once per scan.
 */
function scanAllInstalledGames(/** @type {any} */ options = {}) {
  try {
    const { isDefaultProdScan, cachedResult } = checkDefaultProdScanCache(options);
    if (cachedResult) return cachedResult;

    const ctx = createScanContext(options, isDefaultProdScan, false);
    const { platform, homedir, customRoots, userDataDir } = ctx;

    // 1. STEAM MULTI-LIBRARY SCANNER
    try {
      const { steamappsDirs } = discoverSteamLocations(options);
      for (const steamappsDir of steamappsDirs) {
        /** @type {string[]} */
        let files = [];
        try {
          files = fs.readdirSync(steamappsDir);
        } catch {
          continue;
        }
        for (const file of files) {
          if (!/^appmanifest_\d+\.acf$/i.test(file)) continue;
          const manifestPath = path.join(steamappsDir, file);
          const rawAcf = readTextFileBoundedSync(manifestPath, MAX_SCANNER_MANIFEST_BYTES);
          if (!rawAcf) continue;
          processSteamManifestRecord(ctx, steamappsDir, manifestPath, rawAcf, null);
        }
      }
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'steam' },
        { userDataDir }
      );
    }

    // 2. GOG.COM SCANNER (+ Darwin Bottles discovery reusing single detectCompatibilityLayers call)
    /** @type {string[]} */
    const discoveredBottleRoots = [];
    for (const bottlesDir of getDarwinBottleContainerDirs(ctx)) {
      if (!fs.existsSync(bottlesDir)) continue;
      try {
        const entries = fs.readdirSync(bottlesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          discoveredBottleRoots.push(path.join(bottlesDir, entry.name));
        }
      } catch {}
    }

    try {
      const { gogSearchDirs, gogGalaxyConfigs, heroicGogFiles } = buildGogScanSources(
        ctx,
        discoveredBottleRoots
      );
      for (const cfgPath of gogGalaxyConfigs) {
        if (!fs.existsSync(cfgPath)) continue;
        const rawCfg = readTextFileBoundedSync(cfgPath, MAX_SCANNER_MANIFEST_BYTES);
        if (!rawCfg) continue;
        try {
          applyGogGalaxyConfigJson(ctx, cfgPath, rawCfg, gogSearchDirs);
        } catch {}
      }

      /** @type {Map<string, number>} */
      const visitedGogDirsSync = new Map();
      let gogDirsVisitedCountSync = 0;
      const scanDirForGogInfoSync = (/** @type {string} */ dirPath, depth = 0) => {
        if (
          depth > 3 ||
          !dirPath ||
          gogDirsVisitedCountSync >= MAX_GOG_SCAN_DIRS_VISITED ||
          !fs.existsSync(dirPath)
        ) {
          return;
        }
        if (isPathUnderActiveDownload(dirPath)) return;
        let canonicalDir = path.resolve(dirPath);
        try {
          canonicalDir = fs.realpathSync(dirPath);
        } catch {}
        const prevMinDepth = visitedGogDirsSync.get(canonicalDir);
        if (prevMinDepth !== undefined && prevMinDepth <= depth) return;
        visitedGogDirsSync.set(canonicalDir, depth);
        gogDirsVisitedCountSync += 1;
        /** @type {fs.Dirent[]} */
        let entries = [];
        try {
          entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(dirPath, entry.name);
          if (entry.isFile() && /^goggame-\d+\.info$/i.test(entry.name)) {
            const rawInfo = readTextFileBoundedSync(full, MAX_SCANNER_MANIFEST_BYTES);
            if (rawInfo) {
              try {
                processGogInfoJson(ctx, full, rawInfo);
              } catch {}
            }
          } else if (entry.isDirectory()) {
            if (entry.name.toLowerCase().endsWith('.app')) {
              const resDir = path.join(full, 'Contents', 'Resources');
              if (fs.existsSync(resDir)) {
                try {
                  const resFiles = fs.readdirSync(resDir);
                  for (const rf of resFiles) {
                    if (/^goggame-\d+\.info$/i.test(rf)) {
                      const rfPath = path.join(resDir, rf);
                      const rawInfo = readTextFileBoundedSync(rfPath, MAX_SCANNER_MANIFEST_BYTES);
                      if (rawInfo) {
                        try {
                          processGogInfoJson(ctx, rfPath, rawInfo);
                        } catch {}
                      }
                    }
                  }
                } catch {}
              }
            } else if (dirPath !== '/Applications') {
              scanDirForGogInfoSync(full, depth + 1);
            }
          }
        }
      };

      for (const gogDir of gogSearchDirs) {
        scanDirForGogInfoSync(gogDir, 0);
      }

      for (const hgFile of heroicGogFiles) {
        if (!fs.existsSync(hgFile)) continue;
        const rawHg = readTextFileBoundedSync(hgFile, MAX_SCANNER_INDEX_JSON_BYTES);
        if (!rawHg) continue;
        try {
          processHeroicGogFileJson(ctx, hgFile, rawHg);
        } catch {}
      }
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'gog' },
        { userDataDir }
      );
    }

    // 3. EPIC GAMES STORE SCANNER
    try {
      const {
        epicManifestDirs,
        launcherInstalledFiles,
        legendaryFiles,
        managedLegendaryInstalledPath,
      } = buildEpicScanSources(ctx, discoveredBottleRoots);

      /** @type {Array<{ legFile: string, isExternalLegFile: boolean, rawLeg: string }>} */
      const loadedLegendaryFiles = [];
      for (const legFile of legendaryFiles) {
        if (!fs.existsSync(legFile)) continue;
        const isExternalLegFile = path.resolve(legFile) !== managedLegendaryInstalledPath;
        const rawLeg = readTextFileBoundedSync(legFile, MAX_SCANNER_INDEX_JSON_BYTES);
        if (!rawLeg) continue;
        collectEpicDlcAppNamesFromLegendaryJson(ctx, rawLeg);
        loadedLegendaryFiles.push({ legFile, isExternalLegFile, rawLeg });
      }

      for (const manifestDir of epicManifestDirs) {
        if (!fs.existsSync(manifestDir)) continue;
        /** @type {string[]} */
        let files = [];
        try {
          files = fs.readdirSync(manifestDir);
        } catch {
          continue;
        }
        const manifestBottleRoot = extractBottleRootFromPath(manifestDir);
        for (const file of files) {
          if (!file.toLowerCase().endsWith('.item')) continue;
          const itemPath = path.join(manifestDir, file);
          const rawItem = readTextFileBoundedSync(itemPath, MAX_SCANNER_MANIFEST_BYTES);
          if (!rawItem) continue;
          try {
            processEpicItemJson(ctx, manifestBottleRoot, itemPath, rawItem);
          } catch {}
        }
      }

      for (const datFile of launcherInstalledFiles) {
        if (!fs.existsSync(datFile)) continue;
        const datBottleRoot = extractBottleRootFromPath(datFile);
        const rawDat = readTextFileBoundedSync(datFile, MAX_SCANNER_INDEX_JSON_BYTES);
        if (!rawDat) continue;
        try {
          processEpicDatJson(ctx, datFile, datBottleRoot, rawDat);
        } catch {}
      }

      for (const { legFile, isExternalLegFile, rawLeg } of loadedLegendaryFiles) {
        try {
          processLegendaryFileJson(ctx, legFile, isExternalLegFile, rawLeg);
        } catch {}
      }
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'epic' },
        { userDataDir }
      );
    }

    // 3.5 XBOX / PC GAME PASS SCANNER
    try {
      const xboxCandidateDirs = collectXboxScanDirectories({
        ...options,
        platform,
        customRoots,
      });
      for (const xboxDir of xboxCandidateDirs) {
        processXboxCandidateDir(ctx, xboxDir);
      }
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'xbox' },
        { userDataDir }
      );
    }

    // 3.6 CHAINED PUBLISHER LAUNCHERS SCANNER (reuses cached Compatibility Layers array)
    try {
      /** @type {Array<{ found: any, isBottle: boolean, compatibilityLayer?: string, wineBottle?: string }>} */
      const discoveredPublisherEntries = [];
      if (platform === 'darwin') {
        const detectedLayers = ctx.getDetectedDarwinLayersOnce();
        const bottlePaths = collectDarwinChainedBottlePaths(ctx);
        for (const bottlePath of bottlePaths) {
          const layerMeta = resolveBottleLayerMetadata(bottlePath, detectedLayers);
          const bottleGames = scanBottlePublisherInstalledGames(bottlePath, {
            ...options,
            homedir,
          });
          for (const found of bottleGames) {
            discoveredPublisherEntries.push({
              found,
              isBottle: true,
              compatibilityLayer: layerMeta.compatibilityLayer,
              wineBottle: found.bottleName || layerMeta.wineBottle,
            });
          }
        }
        const hostMacPublisherGames = scanHostPublisherInstalledGames({
          ...options,
          platform: 'darwin',
          homedir,
        });
        for (const found of hostMacPublisherGames) {
          discoveredPublisherEntries.push({ found, isBottle: false });
        }
      } else if (platform === 'win32') {
        const hostWinPublisherGames = scanHostPublisherInstalledGames({
          ...options,
          platform: 'win32',
          homedir,
        });
        for (const found of hostWinPublisherGames) {
          discoveredPublisherEntries.push({ found, isBottle: false });
        }
      }
      reconcileChainedPublisherEntries(ctx, discoveredPublisherEntries);
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'chained_publisher_launchers' },
        { userDataDir }
      );
    }

    // 4. ONE LAUNCHER MANAGED INSTALLS
    try {
      for (const rec of ctx.preloadedManagedRecords) {
        processManagedInstallRecord(ctx, rec);
      }
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'managed_installs' },
        { userDataDir }
      );
    }

    // 5. CUSTOM LAUNCH CONFIG OVERRIDES
    try {
      for (const cfg of Object.values(ctx.launchConfigs)) {
        processCustomLaunchConfigEntry(ctx, cfg);
      }
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'custom_overrides' },
        { userDataDir }
      );
    }

    // 6. POST-PASS ENRICHMENT & FINALIZATION
    const installedGames = Array.from(ctx.discoveredMap.values());
    for (const g of installedGames) {
      enrichSingleInstalledGameRecord(g, customRoots);
    }
    return finalizeScanContext(ctx, installedGames);
  } catch (/** @type {any} */ err) {
    return {
      success: false,
      error: err.message,
      installedGames: [],
      installedSteamAppIds: [],
      epicPlatformSupport: {},
    };
  }
}

/**
 * Non-blocking async multi-storefront installation scanner using `fs.promises` and clean
 * `setImmediate` yields between storefront trees and item chunks so scanning 30+ installed games
 * never stalls Electron's main thread while preserving 100% parity with `scanAllInstalledGames`.
 */
async function scanAllInstalledGamesAsync(/** @type {any} */ options = {}) {
  try {
    const platform = options.platform || process.platform;
    if (platform === 'win32') {
      const prewarmOpts = options.prewarmWindowsCaches === true ? options : { platform };
      /** @type {Promise<any>[]} */
      const tasks = [primeXboxDiscoveryCachesAsync(options).catch(() => {})];
      if (!isTestEnvironment(options) || options.prewarmWindowsCaches === true) {
        tasks.push(
          refreshWindowsStorefrontRegistryCacheAsync(prewarmOpts).catch(() => {}),
          refreshHostWindowsKnownFoldersAsync(prewarmOpts).catch(() => {}),
          discoverWindowsLocalDrivesAsync(prewarmOpts).catch(() => {})
        );
      }
      await Promise.all(tasks);
    }

    const { isDefaultProdScan, cachedResult } = checkDefaultProdScanCache(options);
    if (cachedResult) return cachedResult;

    const ctx = createScanContext(options, isDefaultProdScan, true);
    const { homedir, customRoots, userDataDir } = ctx;

    // 1. STEAM MULTI-LIBRARY SCANNER (async fs.promises + chunked yielding)
    try {
      const { steamappsDirs } = discoverSteamLocations(options);
      let steamProcessed = 0;
      for (const steamappsDir of steamappsDirs) {
        /** @type {string[]} */
        let files = [];
        try {
          files = await fs.promises.readdir(steamappsDir);
        } catch {
          continue;
        }
        for (const file of files) {
          if (!/^appmanifest_\d+\.acf$/i.test(file)) continue;
          const manifestPath = path.join(steamappsDir, file);
          const rawAcf = await readTextFileBoundedAsync(manifestPath, MAX_SCANNER_MANIFEST_BYTES);
          if (!rawAcf) continue;
          // Pre-read EA installerdata.xml asynchronously when present
          let preloadedXml = '';
          try {
            const parsedPeek = parseSteamAcf(rawAcf);
            if (parsedPeek && parsedPeek.appId && parsedPeek.appId !== 228980) {
              const commonDir = path.join(steamappsDir, 'common');
              const installPath = parsedPeek.installdir
                ? path.resolve(commonDir, String(parsedPeek.installdir))
                : path.resolve(commonDir, String(parsedPeek.appId));
              if (
                isContainedWithinRoot(commonDir, installPath, platform) &&
                path.resolve(installPath) !== path.resolve(commonDir)
              ) {
                for (const xmlPath of [
                  path.join(installPath, '__Installer', 'installerdata.xml'),
                  path.join(installPath, '__installer', 'installerdata.xml'),
                ]) {
                  const readXml = await readTextFileBoundedAsync(
                    xmlPath,
                    MAX_SCANNER_MANIFEST_BYTES
                  );
                  if (readXml) {
                    preloadedXml = readXml;
                    break;
                  }
                }
              }
            }
          } catch {}
          processSteamManifestRecord(ctx, steamappsDir, manifestPath, rawAcf, preloadedXml);
          steamProcessed += 1;
          if (steamProcessed % ASYNC_SCAN_YIELD_CHUNK === 0) {
            await yieldToEventLoop();
          }
        }
      }
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'steam' },
        { userDataDir }
      );
    }

    await yieldToEventLoop();

    // 2. GOG.COM SCANNER (+ async Darwin Bottles enumeration reusing single detectCompatibilityLayers call)
    /** @type {string[]} */
    const discoveredBottleRoots = [];
    for (const bottlesDir of getDarwinBottleContainerDirs(ctx)) {
      try {
        const entries = await fs.promises.readdir(bottlesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          discoveredBottleRoots.push(path.join(bottlesDir, entry.name));
        }
      } catch {}
    }

    try {
      const { gogSearchDirs, gogGalaxyConfigs, heroicGogFiles } = buildGogScanSources(
        ctx,
        discoveredBottleRoots
      );
      for (const cfgPath of gogGalaxyConfigs) {
        try {
          const rawCfg = await readTextFileBoundedAsync(cfgPath, MAX_SCANNER_MANIFEST_BYTES);
          if (rawCfg) {
            applyGogGalaxyConfigJson(ctx, cfgPath, rawCfg, gogSearchDirs);
          }
        } catch {}
      }

      /** @type {Map<string, number>} */
      const visitedGogDirsAsync = new Map();
      let gogVisited = 0;
      const scanDirForGogInfoAsync = async (/** @type {string} */ dirPath, depth = 0) => {
        if (depth > 3 || !dirPath || gogVisited >= MAX_GOG_SCAN_DIRS_VISITED) return;
        if (isPathUnderActiveDownload(dirPath)) return;
        let canonicalDir = path.resolve(dirPath);
        try {
          canonicalDir = await fs.promises.realpath(dirPath);
        } catch {}
        const prevMinDepth = visitedGogDirsAsync.get(canonicalDir);
        if (prevMinDepth !== undefined && prevMinDepth <= depth) return;
        visitedGogDirsAsync.set(canonicalDir, depth);
        /** @type {fs.Dirent[]} */
        let entries = [];
        try {
          entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        } catch {
          return;
        }
        gogVisited += 1;
        if (gogVisited % ASYNC_SCAN_YIELD_CHUNK === 0) {
          await yieldToEventLoop();
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(dirPath, entry.name);
          if (entry.isFile() && /^goggame-\d+\.info$/i.test(entry.name)) {
            try {
              const rawInfo = await readTextFileBoundedAsync(full, MAX_SCANNER_MANIFEST_BYTES);
              if (rawInfo) {
                processGogInfoJson(ctx, full, rawInfo);
              }
            } catch {}
          } else if (entry.isDirectory()) {
            if (entry.name.toLowerCase().endsWith('.app')) {
              const resDir = path.join(full, 'Contents', 'Resources');
              try {
                const resFiles = await fs.promises.readdir(resDir);
                for (const rf of resFiles) {
                  if (/^goggame-\d+\.info$/i.test(rf)) {
                    const rfPath = path.join(resDir, rf);
                    try {
                      const rawInfo = await readTextFileBoundedAsync(
                        rfPath,
                        MAX_SCANNER_MANIFEST_BYTES
                      );
                      if (rawInfo) {
                        processGogInfoJson(ctx, rfPath, rawInfo);
                      }
                    } catch {}
                  }
                }
              } catch {}
            } else if (dirPath !== '/Applications') {
              await scanDirForGogInfoAsync(full, depth + 1);
            }
          }
        }
      };

      for (const gogDir of gogSearchDirs) {
        await scanDirForGogInfoAsync(gogDir, 0);
      }

      for (const hgFile of heroicGogFiles) {
        try {
          const rawHg = await readTextFileBoundedAsync(hgFile, MAX_SCANNER_INDEX_JSON_BYTES);
          if (rawHg) {
            processHeroicGogFileJson(ctx, hgFile, rawHg);
          }
        } catch {}
      }
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'gog' },
        { userDataDir }
      );
    }

    await yieldToEventLoop();

    // 3. EPIC GAMES STORE SCANNER (async fs.promises + chunked yielding)
    try {
      const {
        epicManifestDirs,
        launcherInstalledFiles,
        legendaryFiles,
        managedLegendaryInstalledPath,
      } = buildEpicScanSources(ctx, discoveredBottleRoots);

      /** @type {Array<{ legFile: string, isExternalLegFile: boolean, rawLeg: string }>} */
      const loadedLegendaryFiles = [];
      for (const legFile of legendaryFiles) {
        const isExternalLegFile = path.resolve(legFile) !== managedLegendaryInstalledPath;
        try {
          const rawLeg = await readTextFileBoundedAsync(legFile, MAX_SCANNER_INDEX_JSON_BYTES);
          if (rawLeg) {
            collectEpicDlcAppNamesFromLegendaryJson(ctx, rawLeg);
            loadedLegendaryFiles.push({ legFile, isExternalLegFile, rawLeg });
          }
        } catch {}
      }

      let epicProcessed = 0;
      for (const manifestDir of epicManifestDirs) {
        /** @type {string[]} */
        let files = [];
        try {
          files = await fs.promises.readdir(manifestDir);
        } catch {
          continue;
        }
        const manifestBottleRoot = extractBottleRootFromPath(manifestDir);
        for (const file of files) {
          if (!file.toLowerCase().endsWith('.item')) continue;
          const itemPath = path.join(manifestDir, file);
          try {
            const rawItem = await readTextFileBoundedAsync(itemPath, MAX_SCANNER_MANIFEST_BYTES);
            if (rawItem) {
              processEpicItemJson(ctx, manifestBottleRoot, itemPath, rawItem);
            }
          } catch {}
          epicProcessed += 1;
          if (epicProcessed % ASYNC_SCAN_YIELD_CHUNK === 0) {
            await yieldToEventLoop();
          }
        }
      }

      for (const datFile of launcherInstalledFiles) {
        const datBottleRoot = extractBottleRootFromPath(datFile);
        try {
          const rawDat = await readTextFileBoundedAsync(datFile, MAX_SCANNER_INDEX_JSON_BYTES);
          if (rawDat) {
            processEpicDatJson(ctx, datFile, datBottleRoot, rawDat);
          }
        } catch {}
      }

      for (const { legFile, isExternalLegFile, rawLeg } of loadedLegendaryFiles) {
        try {
          processLegendaryFileJson(ctx, legFile, isExternalLegFile, rawLeg);
        } catch {}
      }
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'epic' },
        { userDataDir }
      );
    }

    await yieldToEventLoop();

    // 3.5 XBOX / PC GAME PASS SCANNER
    try {
      const xboxCandidateDirs = collectXboxScanDirectories({
        ...options,
        platform,
        customRoots,
      });
      for (let i = 0; i < xboxCandidateDirs.length; i++) {
        processXboxCandidateDir(ctx, xboxCandidateDirs[i]);
        if ((i + 1) % ASYNC_SCAN_YIELD_CHUNK === 0) {
          await yieldToEventLoop();
        }
      }
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'xbox' },
        { userDataDir }
      );
    }

    await yieldToEventLoop();

    // 3.6 CHAINED PUBLISHER LAUNCHERS SCANNER (reuses cached Compatibility Layers array)
    try {
      /** @type {Array<{ found: any, isBottle: boolean, compatibilityLayer?: string, wineBottle?: string }>} */
      const discoveredPublisherEntries = [];
      if (platform === 'darwin') {
        const detectedLayers = ctx.getDetectedDarwinLayersOnce();
        const bottlePaths = collectDarwinChainedBottlePaths(ctx);
        for (let i = 0; i < bottlePaths.length; i++) {
          const bottlePath = bottlePaths[i];
          const layerMeta = resolveBottleLayerMetadata(bottlePath, detectedLayers);
          const bottleGames = scanBottlePublisherInstalledGames(bottlePath, {
            ...options,
            homedir,
          });
          for (const found of bottleGames) {
            discoveredPublisherEntries.push({
              found,
              isBottle: true,
              compatibilityLayer: layerMeta.compatibilityLayer,
              wineBottle: found.bottleName || layerMeta.wineBottle,
            });
          }
          await yieldToEventLoop();
        }
        const hostMacPublisherGames = scanHostPublisherInstalledGames({
          ...options,
          platform: 'darwin',
          homedir,
        });
        for (const found of hostMacPublisherGames) {
          discoveredPublisherEntries.push({ found, isBottle: false });
        }
      } else if (platform === 'win32') {
        const hostWinPublisherGames = scanHostPublisherInstalledGames({
          ...options,
          platform: 'win32',
          homedir,
        });
        for (const found of hostWinPublisherGames) {
          discoveredPublisherEntries.push({ found, isBottle: false });
        }
      }
      reconcileChainedPublisherEntries(ctx, discoveredPublisherEntries);
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'chained_publisher_launchers' },
        { userDataDir }
      );
    }

    await yieldToEventLoop();

    // 4. ONE LAUNCHER MANAGED INSTALLS
    try {
      for (let i = 0; i < ctx.preloadedManagedRecords.length; i++) {
        processManagedInstallRecord(ctx, ctx.preloadedManagedRecords[i]);
        if ((i + 1) % ASYNC_SCAN_YIELD_CHUNK === 0) {
          await yieldToEventLoop();
        }
      }
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'managed_installs' },
        { userDataDir }
      );
    }

    await yieldToEventLoop();

    // 5. CUSTOM LAUNCH CONFIG OVERRIDES
    try {
      const cfgValues = Object.values(ctx.launchConfigs);
      for (let i = 0; i < cfgValues.length; i++) {
        processCustomLaunchConfigEntry(ctx, cfgValues[i]);
        if ((i + 1) % ASYNC_SCAN_YIELD_CHUNK === 0) {
          await yieldToEventLoop();
        }
      }
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'custom_overrides' },
        { userDataDir }
      );
    }

    await yieldToEventLoop();

    // 6. POST-PASS ENRICHMENT (chunked yielding across 30+ installed dirs) & FINALIZATION
    const installedGames = Array.from(ctx.discoveredMap.values());
    for (let i = 0; i < installedGames.length; i++) {
      enrichSingleInstalledGameRecord(installedGames[i], customRoots);
      if ((i + 1) % ASYNC_SCAN_YIELD_CHUNK === 0) {
        await yieldToEventLoop();
      }
    }

    return finalizeScanContext(ctx, installedGames);
  } catch (/** @type {any} */ err) {
    return {
      success: false,
      error: err.message,
      installedGames: [],
      installedSteamAppIds: [],
      epicPlatformSupport: {},
    };
  }
}

module.exports = {
  scanAllInstalledGames,
  scanAllInstalledGamesAsync,
  buildChainedTitleMatchKeys,
  doChainedPublisherTitlesMatch,
  isGdkStubExecutablePath,
  detectKernelAntiCheatMarkersInDir,
  resolveParadoxLauncherSettings,
  extractSiblingLauncherStem,
  resolveSiblingLauncherStub,
};
