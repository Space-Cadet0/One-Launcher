const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const { diagLog } = require('../utils/diagnosticLogger.cjs');
const {
  recordImportedEpicInstall,
  discoverWindowsLocalDrivesAsync,
  refreshHostWindowsKnownFoldersAsync,
} = require('./securityAndPathUtils.cjs');
const {
  discoverWindowsEpicRegistryPaths,
  refreshWindowsStorefrontRegistryCacheAsync,
} = require('../utils/windowsRegistryDiscovery.cjs');
const { fromWineWindowsPath } = require('./firstPartyRegistration.cjs');
const {
  parseByteCountOrFormattedSize,
  inspectMacMachOHeader,
  parseSteamAcf,
  detectKernelAntiCheatMarkersInDir,
  resolveParadoxLauncherSettings,
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
  listAllInitializedBottlePaths,
  detectCompatibilityLayers,
  extractSiblingLauncherStem,
  resolveSiblingLauncherStub,
} = macNativeInstallerAndCodesign;
const {
  primeXboxDiscoveryCachesAsync,
  collectXboxScanDirectories,
  inspectInstalledXboxGameDir,
} = require('./windowsXboxAppxAndMsixvcOrchestrator.cjs');
const {
  syncEpicFirstPartyLauncher,
  collectLocalEpicMetadataAndSupport,
} = require('./epicLegendaryAndEosCoordinator.cjs');
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

function loadChainedCatalogIndex(userDataDir, /** @type {any} */ options = {}, /** @type {any[]} */ managedRecords = []) {
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
    const epicLocal = collectLocalEpicMetadataAndSupport(options);
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
  for (const layer of detectedLayers) {
    if (!layer || !layer.bottlesDir) continue;
    const resolvedBottlesDir = path.resolve(layer.bottlesDir);
    if (
      resolvedBottle === resolvedBottlesDir ||
      resolvedBottle.startsWith(`${resolvedBottlesDir}${path.sep}`)
    ) {
      return {
        compatibilityLayer: layer.type,
        wineBottle: path.basename(resolvedBottle),
      };
    }
  }
  if (/\/CrossOver Preview\/Bottles\//i.test(normBottle)) {
    return { compatibilityLayer: 'crossover_preview', wineBottle: path.basename(resolvedBottle) };
  }
  if (/\/(?:CrossOver|Whisky)\/Bottles\//i.test(normBottle)) {
    return { compatibilityLayer: 'crossover', wineBottle: path.basename(resolvedBottle) };
  }
  const preferredReady =
    detectedLayers.find((l) => l && l.available) || detectedLayers[0] || null;
  return {
    compatibilityLayer: preferredReady?.type || 'wine',
    wineBottle: path.basename(resolvedBottle),
  };
}

/**
 * Multi-Storefront & Multi-Drive Read-Only Installation Scanner.
 * Zero file/folder mutations during scanning; preserves external-drive records when unmounted.
 */
function scanAllInstalledGames(/** @type {any} */ options = {}) {
  try {
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
        success: true,
        installedGames: cachedInstalledGames,
        installedSteamAppIds: [...lastProductionScanCache.result.installedSteamAppIds],
        epicPlatformSupport: cachedEpicSupport,
      };
    }

    const platform = options.platform || process.platform;
    const homedir = options.homedir || os.homedir();
    const customRoots = Array.isArray(options.customRoots) ? options.customRoots : [];
    const userDataDir = getUserDataDir(options.userDataDir);
    const isIsolatedTest = Boolean(
      options.homedir || (options.customRoots && options.customRoots.length > 0)
    );

    if (platform === 'win32') {
      primeXboxDiscoveryCachesAsync(options).catch(() => {});
      if (!isTestEnvironment(options) || options.prewarmWindowsCaches === true) {
        const prewarmOpts =
          options.prewarmWindowsCaches === true ? options : { platform };
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

    const addRecord = (/** @type {any} */ record) => {
      if (!record || !record.platformId || !record.platformGameId) return;
      const cleanRecordId = String(record.platformGameId)
        .replace(/^(gog|steam|epic|xbox)-/i, '')
        .toLowerCase();
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
          const platPrefixRe = new RegExp(`^${record.platformId}[-_]`, 'i');
          const cleanId = String(
            record.storefrontAppId || record.appId || record.platformGameId || ''
          ).replace(platPrefixRe, '');
          let rawSaved =
            launchConfigs[`${record.platformId}-${cleanId}`] ||
            launchConfigs[`${record.platformId}_${cleanId}`] ||
            launchConfigs[String(record.platformGameId)] ||
            launchConfigs[cleanId] ||
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
                  cfgVal.platformConfigs &&
                    cfgVal.platformConfigs[record.platformId] &&
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

    // =========================================================================
    // 1. STEAM MULTI-LIBRARY SCANNER (Read-only; never mutates manifests or common/)
    // =========================================================================
    /** @type {Set<string>} */
    const steamInstalledDirPaths = new Set();
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
          /** @type {any} */
          let parsed = null;
          try {
            parsed = parseSteamAcf(fs.readFileSync(manifestPath, 'utf8'));
          } catch {}
          if (!parsed || !parsed.appId) continue;

          // Skip Steamworks Common Redistributables
          if (parsed.appId === 228980) continue;

          const installPath = parsed.installdir
            ? path.join(steamappsDir, 'common', parsed.installdir)
            : path.join(steamappsDir, 'common', String(parsed.appId));

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
            continue;
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
            continue;
          }

          const appInfoSpec = resolveSteamAppInfoLaunchSpec(
            steamappsDir,
            parsed.appId,
            installPath,
            { platform }
          );
          let installerDataParsed = null;
          const installerXmlCandidates = [
            path.join(installPath, '__Installer', 'installerdata.xml'),
            path.join(installPath, '__installer', 'installerdata.xml'),
          ];
          for (const xmlPath of installerXmlCandidates) {
            if (!fs.existsSync(xmlPath)) continue;
            try {
              installerDataParsed = parseSteamEaInstallerDataXml(fs.readFileSync(xmlPath, 'utf8'));
              if (installerDataParsed) break;
            } catch {}
          }

          const steamChainedHandoff = resolveAnyChainedHandoffId(
            appInfoSpec?.chainedLauncherHandoff ||
              (installerDataParsed?.isEaChained ? 'ea' : null)
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
            continue;
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
      }
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'steam' },
        { userDataDir }
      );
    }

    // =========================================================================
    // 2. GOG.COM SCANNER (GOG Galaxy + Heroic + macOS /Applications + Managed + Bottles)
    // =========================================================================
    const discoveredBottleRoots = [];
    if (platform === 'darwin') {
      const scanBottleContainers = [
        path.join(homedir, 'Library/Application Support/CrossOver/Bottles'),
        path.join(homedir, 'Library/Application Support/CrossOver Preview/Bottles'),
        path.join(homedir, 'Games/OneLauncher/Bottles'),
        path.join(homedir, 'Bottles'),
        path.join(homedir, 'Library/Application Support/Whisky/Bottles'),
        path.join(homedir, 'Library/Application Support/Mythic/Bottles'),
      ];
      for (const bottlesDir of scanBottleContainers) {
        if (!fs.existsSync(bottlesDir)) continue;
        try {
          const entries = fs.readdirSync(bottlesDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            discoveredBottleRoots.push(path.join(bottlesDir, entry.name));
          }
        } catch {}
      }
    }

    try {
      const gogSearchDirs = new Set([
        path.join(homedir, 'Applications'),
        path.join(homedir, 'Games'),
        path.join(homedir, 'Games', 'OneLauncher', 'GOG'),
        path.join(homedir, 'Games', 'Heroic'),
        ...customRoots.map((/** @type {string} */ r) => toLocalFsPath(r, customRoots)),
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
      for (const cfgPath of gogGalaxyConfigs) {
        if (fs.existsSync(cfgPath)) {
          try {
            const cfgBottleRoot = extractBottleRootFromPath(cfgPath);
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            if (cfg.libraryPath) {
              const libLocal = cfgBottleRoot
                ? fromWineWindowsPath(cfg.libraryPath, cfgBottleRoot)
                : toLocalFsPath(cfg.libraryPath, customRoots);
              if (libLocal) gogSearchDirs.add(libLocal);
            }
            if (Array.isArray(cfg.installed)) {
              for (const item of cfg.installed) {
                if (item.installPath) {
                  const itemLocal = cfgBottleRoot
                    ? fromWineWindowsPath(item.installPath, cfgBottleRoot)
                    : toLocalFsPath(item.installPath, customRoots);
                  if (itemLocal) gogSearchDirs.add(itemLocal);
                }
              }
            }
          } catch {}
        }
      }

      const parseGogInfoFile = (/** @type {string} */ infoFilePath) => {
        try {
          const raw = JSON.parse(fs.readFileSync(infoFilePath, 'utf8'));
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
                /[\\/](OneLauncher[\\/]GOG|GOG Galaxy[\\/]Games|Heroic)[\\/]/i.test(
                  candidateParentDir
                )
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
            const hasLegacyGogLauncherExe =
              platform === 'darwin' &&
              (fs.existsSync(path.join(installPath, 'GOGLauncher.exe')) ||
                fs.existsSync(path.join(path.dirname(infoFilePath), 'GOGLauncher.exe')));
            const rawPrimaryTask = raw.playTasks.find(
              (/** @type {any} */ t) => isFileTask(t) && t.isPrimary
            );
            const rawGameTask = raw.playTasks.find(
              (/** @type {any} */ t) =>
                isFileTask(t) && String(t.category || '').trim().toLowerCase() === 'game'
            );
            const preferGameOverLegacyLauncher = Boolean(
              hasLegacyGogLauncherExe &&
                rawPrimaryTask &&
                String(rawPrimaryTask.category || '').trim().toLowerCase() === 'launcher' &&
                !rawPrimaryTask.arguments &&
                rawGameTask
            );
            let primaryTask =
              (preferGameOverLegacyLauncher ? rawGameTask : rawPrimaryTask) ||
              rawGameTask ||
              raw.playTasks.find((/** @type {any} */ t) => isFileTask(t));
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
              const candidates = [
                path.join(installPath, relTaskPath),
                path.join(path.dirname(infoFilePath), relTaskPath),
                path.join(path.resolve(path.dirname(infoFilePath), '..', '..'), relTaskPath),
              ];
              for (const c of candidates) {
                if (fs.existsSync(c)) {
                  const resolvedCand = c.endsWith('.app') ? resolveMacAppBundleBinary(c) : c;
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

          addRecord({
            platformId: 'gog',
            platformGameId: gameId,
            title,
            installPath,
            executablePath,
            ...(launchArguments ? { launchArguments } : {}),
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
      };

      const scanDirForGogInfo = (/** @type {string} */ dirPath, depth = 0) => {
        if (depth > 3 || !dirPath || !fs.existsSync(dirPath)) return;
        if (isPathUnderActiveDownload(dirPath)) return;
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
            parseGogInfoFile(full);
          } else if (entry.isDirectory()) {
            if (entry.name.toLowerCase().endsWith('.app')) {
              const resDir = path.join(full, 'Contents', 'Resources');
              if (fs.existsSync(resDir)) {
                try {
                  const resFiles = fs.readdirSync(resDir);
                  for (const rf of resFiles) {
                    if (/^goggame-\d+\.info$/i.test(rf)) {
                      parseGogInfoFile(path.join(resDir, rf));
                    }
                  }
                } catch {}
              }
            } else if (dirPath !== '/Applications') {
              scanDirForGogInfo(full, depth + 1);
            }
          }
        }
      };

      for (const gogDir of gogSearchDirs) {
        scanDirForGogInfo(gogDir, 0);
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

      for (const hgFile of heroicGogFiles) {
        if (!fs.existsSync(hgFile)) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(hgFile, 'utf8'));
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
                  installSize: parseByteCountOrFormattedSize(
                    item.install_size ?? item.installSize
                  ),
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
            const itemExeCandidate = item.executable
              ? toLocalFsPath(item.executable, customRoots)
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
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'gog' },
        { userDataDir }
      );
    }

    // =========================================================================
    // 3. EPIC GAMES STORE SCANNER (Epic Games Launcher + Heroic / Legendary + Bottles)
    // =========================================================================
    try {
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
          try {
            const item = JSON.parse(fs.readFileSync(itemPath, 'utf8'));
            if (item.bIsIncompleteInstall === true) continue;

            const appName = String(item.AppName || item.CatalogItemId || '');
            if (!appName) continue;

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
              continue;
            }

            let executablePath = undefined;
            let isWindowsBinaryOnMac = Boolean(platform === 'darwin' && manifestBottleRoot);

            if (item.LaunchExecutable) {
              const cleanLaunchExe = String(item.LaunchExecutable).replace(/\\/g, path.sep);
              const candidateExe = path.join(installPath, cleanLaunchExe);
              if (fs.existsSync(candidateExe)) {
                executablePath =
                  (candidateExe.endsWith('.app')
                    ? resolveMacAppBundleBinary(candidateExe)
                    : candidateExe) || undefined;
              } else {
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
            if (!executablePath || !fs.existsSync(executablePath)) continue;

            if (
              platform === 'darwin' &&
              executablePath &&
              executablePath.toLowerCase().endsWith('.exe')
            ) {
              isWindowsBinaryOnMac = true;
            }

            if (Boolean(options.userDataDir) || !isIsolatedTest) {
              recordImportedEpicInstall(
                { appName, installPath, source: itemPath },
                { userDataDir }
              );
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

      for (const datFile of launcherInstalledFiles) {
        if (!fs.existsSync(datFile)) continue;
        const datBottleRoot = extractBottleRootFromPath(datFile);
        try {
          const dat = JSON.parse(fs.readFileSync(datFile, 'utf8'));
          const list = Array.isArray(dat?.InstallationList) ? dat.InstallationList : [];
          for (const entry of list) {
            const appName = String(entry.AppName || entry.ArtifactId || '');
            if (!appName || appName.startsWith('UE_')) continue;
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
              recordImportedEpicInstall(
                { appName, installPath, source: datFile },
                { userDataDir }
              );
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
                discovered.isWindowsBinaryOnMac ||
                Boolean(platform === 'darwin' && datBottleRoot),
            });
          }
        } catch {}
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

      for (const legFile of legendaryFiles) {
        if (!fs.existsSync(legFile)) continue;
        const isExternalLegFile = path.resolve(legFile) !== managedLegendaryInstalledPath;
        try {
          const raw = JSON.parse(fs.readFileSync(legFile, 'utf8'));
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
                  installSize: parseByteCountOrFormattedSize(
                    item.install_size ?? item.installSize
                  ),
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
                : path.join(installPath, cleanExe);
              executablePath = toLocalFsPath(candidate, customRoots);
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
              recordImportedEpicInstall(
                { appName, installPath, source: legFile },
                { userDataDir }
              );
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
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'epic' },
        { userDataDir }
      );
    }

    // =========================================================================
    // 3.5 XBOX / PC GAME PASS SCANNER (Windows .GamingRoot / GamingServices + macOS Bottle MSIXVC)
    // =========================================================================
    try {
      const xboxCandidateDirs = collectXboxScanDirectories({
        ...options,
        platform,
        customRoots,
      });
      for (const xboxDir of xboxCandidateDirs) {
        const xboxRecord = inspectInstalledXboxGameDir(xboxDir, {
          platform,
          strictPe: Boolean(options.strictPe),
        });
        if (
          xboxRecord &&
          !(xboxRecord.isExternalLauncherStub && !xboxRecord.executablePath) &&
          !isGdkStubExecutablePath(xboxRecord.executablePath)
        ) {
          addRecord(xboxRecord);
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

    // =========================================================================
    // 3.6 CHAINED PUBLISHER LAUNCHERS SCANNER (Ubisoft Connect / EA App / Battle.net / Rockstar / Riot)
    // =========================================================================
    try {
      /** @type {Array<{ found: any, isBottle: boolean, compatibilityLayer?: string, wineBottle?: string }>} */
      const discoveredPublisherEntries = [];

      if (platform === 'darwin') {
        const explicitHomedirOpt = options.homedir ? { homedir: options.homedir } : {};
        const detectedLayers = detectCompatibilityLayers({
          ...options,
          platform: 'darwin',
          ...explicitHomedirOpt,
        });
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
        for (const bottlePath of bottleSet) {
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

      if (discoveredPublisherEntries.length > 0) {
        const catalogIndex = loadChainedCatalogIndex(
          userDataDir,
          options,
          preloadedManagedRecords
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
                standaloneMatch =
                  catalogIndex.standaloneByFullKey.get(`${handoffId}:${mk}`) || null;
                if (standaloneMatch) break;
              }
            }
            if (!xboxMatch && !epicMatch && !standaloneMatch) {
              for (const mk of matchKeys) {
                standaloneMatch =
                  catalogIndex.standaloneByBaseKey.get(`${handoffId}:${mk}`) || null;
                if (standaloneMatch) break;
              }
            }
          }

          let targetPlatformId = handoffId;
          let targetPlatformGameId =
            extId ||
            normalizeComparableTitle(found.title || '') ||
            path.basename(found.installPath);
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
                    platform === 'darwin' &&
                    String(found.executablePath).toLowerCase().endsWith('.exe'),
                }),
          });
        }
      }
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'chained_publisher_launchers' },
        { userDataDir }
      );
    }

    // =========================================================================
    // 4. ONE LAUNCHER MANAGED INSTALLS (Read-only; never wipes unmounted external drives)
    // =========================================================================
    try {
      const managedRecords = preloadedManagedRecords;
      for (const rec of managedRecords) {
        if (!rec || !rec.platformId || !rec.platformGameId) continue;
        if (isGdkStubExecutablePath(rec.executablePath)) continue;
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
              (inspectedManagedXbox.isExternalLauncherStub &&
                !inspectedManagedXbox.executablePath)
            ) {
              continue;
            }
          }
          const recExeLocal = rec.executablePath
            ? toLocalFsPath(rec.executablePath, customRoots)
            : '';
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
          if (
            !effectiveExe ||
            !fs.existsSync(effectiveExe) ||
            isGdkStubExecutablePath(effectiveExe)
          ) {
            continue;
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
        } else if (
          rec.installPath &&
          isExternalVolumeUnmounted(String(rec.installPath), options)
        ) {
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
    } catch (stageErr) {
      diagLog.warn(
        'scanAllInstalledGames.stageError',
        stageErr,
        { stage: 'managed_installs' },
        { userDataDir }
      );
    }

    // =========================================================================
    // 5. CUSTOM LAUNCH CONFIG OVERRIDES & LOCAL EPIC METADATA
    // =========================================================================
    try {
      for (const cfg of Object.values(launchConfigs)) {
        if (!cfg || typeof cfg !== 'object') continue;
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
            const platformGameId = String(cfg.gameId).replace(
              /^(steam|gog|epic|xbox|custom)-/,
              ''
            );
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
              isWindowsBinaryOnMac:
                platform === 'darwin' && customExe.toLowerCase().endsWith('.exe'),
            });
          }
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

    const installedGames = Array.from(discoveredMap.values());
    for (const g of installedGames) {
      if (!g || g.driveDisconnected || !g.installPath || typeof g.installPath !== 'string') {
        continue;
      }
      try {
        const localInstallDir = toLocalFsPath(g.installPath);
        if (!localInstallDir || !fs.existsSync(localInstallDir)) continue;
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
              toLocalFsPath(g.executablePath) || localInstallDir,
              localInstallDir
            );
            if (pdx.paradoxDirectGameExe) {
              g.paradoxDirectGameExe = pdx.paradoxDirectGameExe;
            }
          }
        }
      } catch {}
    }
    let epicPlatformSupport = {};
    try {
      const metaRes = collectLocalEpicMetadataAndSupport(options);
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
 * Async wrapper around `scanAllInstalledGames` that pre-warms Windows registry,
 * known-folder, and drive-root caches asynchronously before scanning so IPC calls
 * on `win32` never block the Electron main thread on cold synchronous `reg.exe` spawns.
 */
async function scanAllInstalledGamesAsync(/** @type {any} */ options = {}) {
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
  return scanAllInstalledGames(options);
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
