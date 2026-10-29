const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { diagLog } = require('../utils/diagnosticLogger.cjs');
const { recordImportedEpicInstall } = require('./securityAndPathUtils.cjs');
const { discoverWindowsEpicRegistryPaths } = require('../utils/windowsRegistryDiscovery.cjs');
const { fromWineWindowsPath } = require('./firstPartyRegistration.cjs');
const {
  parseByteCountOrFormattedSize,
  inspectMacMachOHeader,
  parseSteamAcf,
} = require('./binaryAndManifestInspectors.cjs');
const {
  getUserDataDir,
  getLastProductionScanCache,
  setLastProductionScanCache,
  getLastSyncedEpicFingerprint,
  setLastSyncedEpicFingerprint,
  getLastSyncedGogFingerprint,
  setLastSyncedGogFingerprint,
  toLocalFsPath,
  loadManagedInstalledGames,
  resolvePlatformLaunchConfig,
  getGameLaunchConfigs,
} = require('./engineStateRegistry.cjs');
const { isExternalVolumeUnmounted } = require('./diskAndVolumeInspector.cjs');
const {
  isExcludedExecutable,
  resolveMacAppBundleBinary,
  findPrimaryExecutable,
  resolveSteamAppInfoLaunchSpec,
  resolveDefaultEngineLaunchArguments,
  discoverSteamLocations,
  extractBottleRootFromPath,
} = require('./macNativeInstallerAndCodesign.cjs');
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

    const addRecord = (/** @type {any} */ record) => {
      if (!record || !record.platformId || !record.platformGameId) return;
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
          const exeDiscovery =
            appInfoSpec && appInfoSpec.executablePath
              ? {
                  executablePath: appInfoSpec.executablePath,
                  isWindowsBinaryOnMac: appInfoSpec.isWindowsBinaryOnMac,
                }
              : findPrimaryExecutable(installPath, { platform, hintName: parsed.name });

          if (!exeDiscovery.executablePath) {
            continue;
          }

          const isInsideBottle = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(installPath);
          const launchArguments =
            appInfoSpec?.launchArguments ||
            resolveDefaultEngineLaunchArguments(installPath, exeDiscovery.executablePath);

          addRecord({
            platformId: 'steam',
            platformGameId: String(parsed.appId),
            appId: parsed.appId,
            title: parsed.name,
            name: parsed.name,
            installPath,
            executablePath: exeDiscovery.executablePath,
            ...(launchArguments ? { launchArguments } : {}),
            installSize: parseByteCountOrFormattedSize(parsed.SizeOnDisk),
            version: parsed.buildid ? String(parsed.buildid) : undefined,
            manifestPath,
            runner: 'steam',
            isWindowsBinaryOnMac:
              Boolean(exeDiscovery.isWindowsBinaryOnMac) ||
              (platform === 'darwin' && isInsideBottle),
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
          }

          let executablePath = undefined;
          let launchArguments = undefined;
          let isWindowsBinaryOnMac = false;

          if (Array.isArray(raw.playTasks)) {
            const isFileTask = (/** @type {any} */ t) =>
              Boolean(t && t.path && (!t.type || String(t.type) === 'FileTask'));
            const primaryTask =
              raw.playTasks.find((/** @type {any} */ t) => isFileTask(t) && t.isPrimary) ||
              raw.playTasks.find((/** @type {any} */ t) => isFileTask(t) && t.category === 'game') ||
              raw.playTasks.find((/** @type {any} */ t) => isFileTask(t));
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
            }
          }

          if (!executablePath) {
            const discovered = findPrimaryExecutable(installPath, { platform, hintName: title });
            executablePath = discovered.executablePath;
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
            });
            const itemExeCandidate = item.executable
              ? toLocalFsPath(item.executable, customRoots)
              : '';
            const resolvedHeroicExe =
              itemExeCandidate && fs.existsSync(itemExeCandidate)
                ? itemExeCandidate
                : discovered.executablePath || itemExeCandidate || undefined;
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
                });
                executablePath = discovered.executablePath;
                isWindowsBinaryOnMac = isWindowsBinaryOnMac || discovered.isWindowsBinaryOnMac;
              }
            } else {
              const discovered = findPrimaryExecutable(installPath, { platform, hintName: title });
              executablePath = discovered.executablePath;
              isWindowsBinaryOnMac = isWindowsBinaryOnMac || discovered.isWindowsBinaryOnMac;
            }

            if (!executablePath || !fs.existsSync(executablePath)) continue;

            if (
              platform === 'darwin' &&
              executablePath &&
              executablePath.toLowerCase().endsWith('.exe')
            ) {
              isWindowsBinaryOnMac = true;
            }

            const launchArguments =
              item.LaunchCommand && typeof item.LaunchCommand === 'string'
                ? item.LaunchCommand.trim()
                : '';

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

            const discovered = findPrimaryExecutable(installPath, { platform, hintName: appName });
            if (!discovered.executablePath || !fs.existsSync(discovered.executablePath)) continue;

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
              executablePath: discovered.executablePath,
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
            const discovered = findPrimaryExecutable(installPath, { platform, hintName: title });
            if (!executablePath || !fs.existsSync(executablePath)) {
              executablePath = discovered.executablePath;
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
        if (xboxRecord) {
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
    // 4. ONE LAUNCHER MANAGED INSTALLS (Read-only; never wipes unmounted external drives)
    // =========================================================================
    try {
      const managedRecords = loadManagedInstalledGames(userDataDir);
      for (const rec of managedRecords) {
        if (!rec || !rec.platformId || !rec.platformGameId) continue;
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
          if (
            rec.platformId === 'xbox' &&
            !matchedDiscovered &&
            !inspectInstalledXboxGameDir(localInstall, {
              platform,
              strictPe: Boolean(options.strictPe),
            })
          ) {
            continue;
          }
          const recExeLocal = rec.executablePath
            ? toLocalFsPath(rec.executablePath, customRoots)
            : '';
          const isRecExeValid =
            Boolean(recExeLocal) &&
            fs.existsSync(recExeLocal) &&
            !isExcludedExecutable(path.basename(recExeLocal)) &&
            !/\.com$/i.test(recExeLocal);
          const discovered =
            matchedDiscovered && matchedDiscovered.executablePath
              ? {
                  executablePath: matchedDiscovered.executablePath,
                  isWindowsBinaryOnMac: matchedDiscovered.isWindowsBinaryOnMac,
                }
              : findPrimaryExecutable(localInstall, { platform, hintName: rec.title });
          const effectiveExe =
            matchedDiscovered?.executablePath ||
            (isRecExeValid ? recExeLocal : undefined) ||
            discovered.executablePath;
          if (!effectiveExe || !fs.existsSync(effectiveExe)) {
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
            g.installPath
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

module.exports = {
  scanAllInstalledGames,
};
