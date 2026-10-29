const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');

const { diagLog } = require('../utils/diagnosticLogger.cjs');
const {
  toHostFilesystemPath,
  atomicWriteFileSync,
  atomicWriteSecureFileSync,
  isStoreDisconnectedTombstoned,
  recordImportedEpicInstall,
} = require('./securityAndPathUtils.cjs');
const {
  discoverWindowsEpicRegistryPaths,
} = require('../utils/windowsRegistryDiscovery.cjs');
const {
  toWineWindowsPath,
  fromWineWindowsPath,
  syncEpicEoshInstalledItem,
  removeEpicEoshInstalledItem,
} = require('./firstPartyRegistration.cjs');
const { normalizePosixUtf8Locale } = require('./cloudSaveEngine.cjs');
const {
  getStoreSync,
  getEpicAuthRecoveryHook,
  getUserDataDir,
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,
  MAX_LEGENDARY_CACHE_DIRS,
  legendaryMetadataDirCache,
  legendaryAssetsFileCache,
  legendaryAliasesFileCache,
  setBoundedMapEntry,
  toLocalFsPath,
  resolveHostLocaleInfo,
  loadManagedInstalledGames,
} = require('./engineStateRegistry.cjs');
const {
  findPrimaryExecutable,
  listAllInitializedBottlePaths,
  resolveTargetBottleForFirstPartySync,
} = require('./macNativeInstallerAndCodesign.cjs');

/**
 * Resolve Epic Games Launcher Manifests directory and LauncherInstalled.dat path
 */
function resolveEpicFirstPartyPaths(/** @type {any} */ options = {}) {
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();

  if (
    options.fromAutoScan === true &&
    options.homedir &&
    !options.syncFirstParty &&
    !options.eglManifestsDir &&
    !options.eglLauncherInstalledPath &&
    !options.eglLauncherInstalledDat &&
    !options.bottlePath &&
    !options.programDataEpicDir &&
    options.routeWindowsEpicToBottle !== true
  ) {
    return { eglManifestsDir: null, eglLauncherInstalledPath: null, isolatedNoOp: true };
  }

  const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
  const regEpicManifestsDir =
    platform === 'win32' && !options.eglManifestsDir && !options.homedir
      ? discoverWindowsEpicRegistryPaths(options).manifestsDir
      : null;
  const eglManifestsDir =
    options.eglManifestsDir ||
    (platform === 'win32'
      ? options.programDataEpicDir
        ? path.join(options.programDataEpicDir, 'EpicGamesLauncher', 'Data', 'Manifests')
        : !options.homedir
          ? regEpicManifestsDir ||
            path.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
          : path.join(homedir, 'ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
      : path.join(homedir, 'Library/Application Support/Epic/EpicGamesLauncher/Data/Manifests'));

  const eglLauncherInstalledPath =
    options.eglLauncherInstalledPath ||
    options.eglLauncherInstalledDat ||
    (platform === 'win32'
      ? options.programDataEpicDir
        ? path.join(options.programDataEpicDir, 'UnrealEngineLauncher', 'LauncherInstalled.dat')
        : !options.homedir
          ? path.join(programData, 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat')
          : path.join(homedir, 'ProgramData', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat')
      : path.join(
          homedir,
          'Library/Application Support/Epic/UnrealEngineLauncher/LauncherInstalled.dat'
        ));

  return { eglManifestsDir, eglLauncherInstalledPath, isolatedNoOp: false };
}

/**
 * Synchronize installed Epic games into Epic Games Launcher (.item manifests + LauncherInstalled.dat)
 */
function syncEpicFirstPartyLauncher(/** @type {any} */ options = {}) {
  try {
    const platform = options.platform || process.platform;
    const homedir = options.homedir || os.homedir();
    const userDataDir = getUserDataDir(options.userDataDir);
    const { eglManifestsDir, eglLauncherInstalledPath, isolatedNoOp } =
      resolveEpicFirstPartyPaths(options);

    if (isolatedNoOp || (!eglManifestsDir && !eglLauncherInstalledPath)) {
      return { synced: 0 };
    }

    // 1. Collect all installed Epic games from Legendary installed.json files & managed records
    const epicGamesMap = new Map();
    const installPathToAppName = new Map();

    const legendaryDirs = [
      path.join(userDataDir, 'legendaryConfig/legendary'),
      path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary'),
      path.join(homedir, '.config/legendary'),
      path.join(homedir, 'AppData/Roaming/heroic/legendaryConfig/legendary'),
    ];
    const legendaryInstalledFiles = legendaryDirs.map((d) => path.join(d, 'installed.json'));

    for (const legFile of legendaryInstalledFiles) {
      if (!fs.existsSync(legFile)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(legFile, 'utf8'));
        const entries = Array.isArray(raw)
          ? raw
          : raw && typeof raw === 'object'
            ? Object.entries(raw).map(([k, v]) =>
                v && typeof v === 'object' ? { app_name: k, ...v } : null
              )
            : [];
        for (const item of entries) {
          if (!item || typeof item !== 'object') continue;
          const appName = String(item.app_name || item.appName || '')
            .replace(/^epic[-_]/i, '')
            .trim();
          const rawInstallPath = item.install_path || item.installPath;
          if (!appName || !rawInstallPath) continue;
          const installPath = toLocalFsPath(rawInstallPath);
          if (!installPath || !fs.existsSync(installPath)) continue;

          epicGamesMap.set(appName, {
            ...item,
            appName,
            installPath,
            title: item.title || appName,
            version: item.version || '1.0',
            install_size: item.install_size || item.installSize || 0,
            _legFile: legFile,
          });
          installPathToAppName.set(path.resolve(installPath), appName);
        }
      } catch {}
    }

    const managedRecords = loadManagedInstalledGames(userDataDir);
    for (const rec of managedRecords) {
      if (!rec || rec.platformId !== 'epic' || !rec.installPath) continue;
      const installPath = toLocalFsPath(rec.installPath);
      if (!installPath || !fs.existsSync(installPath)) continue;
      const resolvedPathKey = path.resolve(installPath);
      const canonicalAppName =
        installPathToAppName.get(resolvedPathKey) ||
        String(rec.platformGameId || '')
          .replace(/^epic[-_]/i, '')
          .trim();
      if (!canonicalAppName) continue;

      const existing = epicGamesMap.get(canonicalAppName) || {};
      epicGamesMap.set(canonicalAppName, {
        ...existing,
        appName: canonicalAppName,
        installPath,
        title: existing.title || rec.title || canonicalAppName,
        executablePath: rec.executablePath || existing.executablePath,
        isWindowsBinaryOnMac:
          rec.isWindowsBinaryOnMac !== undefined
            ? rec.isWindowsBinaryOnMac
            : existing.isWindowsBinaryOnMac,
        version: existing.version || rec.version || '1.0',
        install_size: existing.install_size || rec.installSize || 0,
      });
      installPathToAppName.set(resolvedPathKey, canonicalAppName);
    }

    // 2. Direct Node.js .item + .mancpn + .manifest + EOSH Synthesis & Verification
    let syncedCount = 0;
    const prunedHostAppNames = new Set();
    const touchedBottleTargets = new Map();
    let hostTouched = false;

    const existingItemsByDir = new Map();
    const getExistingItemsForDir = (/** @type {string | null} */ manifestsDir) => {
      if (!manifestsDir) return [];
      const key = path.resolve(manifestsDir);
      if (existingItemsByDir.has(key)) return existingItemsByDir.get(key);
      /** @type {any[]} */
      const list = [];
      if (fs.existsSync(manifestsDir)) {
        try {
          const files = fs.readdirSync(manifestsDir);
          for (const f of files) {
            if (!f.toLowerCase().endsWith('.item')) continue;
            try {
              const parsed = JSON.parse(fs.readFileSync(path.join(manifestsDir, f), 'utf8'));
              if (parsed && typeof parsed === 'object') {
                list.push({ ...parsed, _fileName: f });
              }
            } catch {}
          }
        } catch {}
      }
      existingItemsByDir.set(key, list);
      return list;
    };

    const metadataDirs = legendaryDirs.map((d) => path.join(d, 'metadata'));
    const assetsCatalogMap = new Map();
    for (const legDir of legendaryDirs) {
      const assetsFile = path.join(legDir, 'assets.json');
      if (!fs.existsSync(assetsFile)) continue;
      try {
        const rawAssets = JSON.parse(fs.readFileSync(assetsFile, 'utf8'));
        const assetLists = [];
        if (Array.isArray(rawAssets)) {
          assetLists.push(rawAssets);
        } else if (rawAssets && typeof rawAssets === 'object') {
          for (const val of Object.values(rawAssets)) {
            if (Array.isArray(val)) assetLists.push(val);
          }
        }
        for (const list of assetLists) {
          for (const asset of list) {
            if (!asset || typeof asset !== 'object') continue;
            const aName = String(asset.app_name || asset.appName || '').trim();
            if (!aName || assetsCatalogMap.has(aName)) continue;
            const cid = asset.catalog_item_id || asset.catalogItemId || '';
            const cns = asset.namespace || asset.catalogNamespace || '';
            if (cid || cns) {
              assetsCatalogMap.set(aName, { catalogItemId: cid, catalogNamespace: cns });
            }
          }
        }
      } catch {}
    }

    for (const [appName, entry] of epicGamesMap.entries()) {
      const installPath = entry.installPath;
      if (!installPath || !fs.existsSync(installPath)) continue;

      const discoveredForPlatform =
        platform === 'darwin' &&
        !entry.platform &&
        entry.isWindowsBinaryOnMac === undefined &&
        !entry.executable &&
        !entry.executablePath
          ? findPrimaryExecutable(installPath, { platform, hintName: entry.title || appName })
          : null;

      const isWinEpicEntry =
        platform === 'darwin' &&
        (String(entry.platform || '').toLowerCase() === 'windows' ||
          Boolean(entry.isWindowsBinaryOnMac) ||
          Boolean(discoveredForPlatform?.isWindowsBinaryOnMac) ||
          Boolean(entry.executable && /\.exe$/i.test(String(entry.executable))) ||
          Boolean(entry.executablePath && /\.exe$/i.test(String(entry.executablePath))));

      const targetBottleForEntry = isWinEpicEntry
        ? resolveTargetBottleForFirstPartySync(entry, 'epic', options)
        : null;
      const honorExplicitTestManifestDir = Boolean(
        options.eglManifestsDir &&
          !options.bottlePath &&
          options.routeWindowsEpicToBottle !== true &&
          !targetBottleForEntry
      );
      const routeToBottle = Boolean(isWinEpicEntry && !honorExplicitTestManifestDir);

      let targetManifestsDir = eglManifestsDir;
      let targetProgramDataEpicDir =
        platform === 'win32'
          ? options.programDataEpicDir ||
            (eglManifestsDir
              ? path.resolve(eglManifestsDir, '..', '..', '..')
              : path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Epic'))
          : null;
      let formattedInstallLocation = installPath;
      let formattedManifestLocation = path.join(installPath, '.egstore');
      let formattedStagingLocation = path.join(installPath, '.egstore', 'bps');

      if (routeToBottle) {
        if (eglManifestsDir && fs.existsSync(eglManifestsDir)) {
          const hostExisting = getExistingItemsForDir(eglManifestsDir);
          for (const hIt of hostExisting) {
            if (
              hIt._fileName &&
              (hIt.AppName === appName ||
                (hIt.InstallLocation &&
                  path.resolve(hIt.InstallLocation) === path.resolve(installPath)))
            ) {
              try {
                fs.rmSync(path.join(eglManifestsDir, hIt._fileName), { force: true });
                hostTouched = true;
              } catch {}
            }
          }
        }
        prunedHostAppNames.add(appName);

        if (!targetBottleForEntry) {
          continue;
        }

        const bottleProgramDataEpic = path.join(
          targetBottleForEntry,
          'drive_c',
          'ProgramData',
          'Epic'
        );
        targetManifestsDir = path.join(
          bottleProgramDataEpic,
          'EpicGamesLauncher',
          'Data',
          'Manifests'
        );
        const bottleDatPath = path.join(
          bottleProgramDataEpic,
          'UnrealEngineLauncher',
          'LauncherInstalled.dat'
        );
        targetProgramDataEpicDir = bottleProgramDataEpic;
        touchedBottleTargets.set(targetBottleForEntry, {
          manifestsDir: targetManifestsDir,
          datPath: bottleDatPath,
          programDataEpicDir: bottleProgramDataEpic,
        });
        formattedInstallLocation = toWineWindowsPath(installPath, targetBottleForEntry);
        formattedManifestLocation = `${formattedInstallLocation.replace(/[\\/]+$/, '')}\\.egstore`;
        formattedStagingLocation = `${formattedManifestLocation}\\bps`;
      } else {
        if (!targetManifestsDir) continue;
        hostTouched = true;
      }

      const hostManifestsDir = toHostFilesystemPath(targetManifestsDir);
      fs.mkdirSync(hostManifestsDir, { recursive: true });
      const existingItems = getExistingItemsForDir(hostManifestsDir);

      /** @type {any} */
      let meta = null;
      for (const metaDir of metadataDirs) {
        const metaFile = path.join(metaDir, `${appName}.json`);
        if (fs.existsSync(metaFile)) {
          try {
            meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
            if (meta) break;
          } catch {}
        }
      }

      const preferMacMeta = platform === 'darwin' && !isWinEpicEntry;
      const primaryAssetInfo = preferMacMeta ? meta?.asset_infos?.Mac : meta?.asset_infos?.Windows;
      const secondaryAssetInfo = preferMacMeta
        ? meta?.asset_infos?.Windows
        : meta?.asset_infos?.Mac;

      const assetsFallback = assetsCatalogMap.get(appName);
      const catalogItemId =
        primaryAssetInfo?.catalog_item_id ||
        secondaryAssetInfo?.catalog_item_id ||
        meta?.metadata?.id ||
        meta?.id ||
        meta?.app_info?.id ||
        entry.catalog_item_id ||
        entry.catalogItemId ||
        assetsFallback?.catalogItemId ||
        '';
      const catalogNamespace =
        primaryAssetInfo?.namespace ||
        secondaryAssetInfo?.namespace ||
        meta?.metadata?.namespace ||
        meta?.achievements?.namespace ||
        meta?.namespace ||
        meta?.app_info?.namespace ||
        entry.namespace ||
        entry.catalogNamespace ||
        assetsFallback?.catalogNamespace ||
        '';

      const manifestSearchDirs = [];
      if (entry._legFile) {
        manifestSearchDirs.push(path.join(path.dirname(entry._legFile), 'manifests'));
      }
      for (const legDir of legendaryDirs) {
        const mDir = path.join(legDir, 'manifests');
        if (!manifestSearchDirs.includes(mDir)) manifestSearchDirs.push(mDir);
      }

      const desiredOsPrefix = `${appName}_${preferMacMeta ? 'Mac' : 'Windows'}`.toLowerCase();
      const oppositeOsPrefix = `${appName}_${preferMacMeta ? 'Windows' : 'Mac'}`.toLowerCase();
      let osMatchedManifest = null;
      let osMatchedMtime = -1;
      let fallbackManifest = null;
      let fallbackMtime = -1;

      for (const mDir of manifestSearchDirs) {
        if (!fs.existsSync(mDir)) continue;
        try {
          const mFiles = fs.readdirSync(mDir);
          for (const mf of mFiles) {
            const lowerMf = mf.toLowerCase();
            if (!lowerMf.endsWith('.manifest')) continue;
            if (
              lowerMf !== `${appName.toLowerCase()}.manifest` &&
              !lowerMf.startsWith(`${appName.toLowerCase()}_`)
            ) {
              continue;
            }
            if (
              lowerMf.startsWith(`${oppositeOsPrefix}_`) ||
              lowerMf === `${oppositeOsPrefix}.manifest`
            ) {
              continue;
            }
            const candidatePath = path.join(mDir, mf);
            try {
              const st = fs.statSync(candidatePath);
              if (
                lowerMf.startsWith(`${desiredOsPrefix}_`) ||
                lowerMf === `${desiredOsPrefix}.manifest`
              ) {
                if (st.mtimeMs > osMatchedMtime) {
                  osMatchedMtime = st.mtimeMs;
                  osMatchedManifest = candidatePath;
                }
              } else if (st.mtimeMs > fallbackMtime) {
                fallbackMtime = st.mtimeMs;
                fallbackManifest = candidatePath;
              }
            } catch {}
          }
        } catch {}
      }

      let sourceManifestPath = osMatchedManifest || fallbackManifest;
      if (!sourceManifestPath) {
        const existingEgstoreDir = path.join(installPath, '.egstore');
        if (fs.existsSync(existingEgstoreDir)) {
          try {
            const egFiles = fs
              .readdirSync(existingEgstoreDir)
              .filter((f) => f.toLowerCase().endsWith('.manifest'));
            if (egFiles.length > 0) {
              sourceManifestPath = path.join(existingEgstoreDir, egFiles[0]);
            }
          } catch {}
        }
      }

      let relativeExePath = '';
      if (entry.executable && !path.isAbsolute(String(entry.executable))) {
        relativeExePath = String(entry.executable);
      } else if (entry.executablePath && String(entry.executablePath).startsWith(installPath)) {
        relativeExePath = path.relative(installPath, entry.executablePath);
      } else {
        const discovered =
          discoveredForPlatform ||
          findPrimaryExecutable(installPath, {
            platform,
            hintName: entry.title || appName,
            preferWindowsExecutable: isWinEpicEntry,
          });
        if (discovered.executablePath && discovered.executablePath.startsWith(installPath)) {
          relativeExePath = path.relative(installPath, discovered.executablePath);
        } else if (discovered.executablePath) {
          relativeExePath = path.basename(discovered.executablePath);
        }
      }
      const cleanLaunchExecutable = String(relativeExePath || '')
        .replace(/^[.\\/]+/, '')
        .replace(/\\/g, '/');
      const isNativeMacEpicTarget = preferMacMeta && !routeToBottle;
      const macBundleMatch = isNativeMacEpicTarget
        ? cleanLaunchExecutable.match(/^([^/]+\.app)\/Contents\/MacOS\/.+/i)
        : null;
      const finalLaunchExecutable = macBundleMatch ? macBundleMatch[1] : cleanLaunchExecutable;
      const mainGameAppName = entry.is_dlc
        ? String(
            entry.base_app_name || entry.baseAppName || (isNativeMacEpicTarget ? '' : appName)
          )
        : isNativeMacEpicTarget
          ? ''
          : appName;

      const existingForApp = existingItems.find((/** @type {any} */ it) => it.AppName === appName);
      const existingGuid = String(entry.egl_guid || existingForApp?.InstallationGuid || '')
        .replace(/[^0-9a-fA-F]/g, '')
        .toUpperCase();

      const guid =
        existingGuid.length === 32
          ? existingGuid
          : crypto
              .createHash('md5')
              .update(`${appName}:${installPath}`)
              .digest('hex')
              .toUpperCase();

      const alreadyValid = existingItems.some((/** @type {any} */ it) => {
        if (
          it.AppName !== appName ||
          it.InstallLocation !== formattedInstallLocation ||
          it.LaunchExecutable !== finalLaunchExecutable ||
          it.MainGameAppName !== mainGameAppName ||
          it.bIsIncompleteInstall !== false ||
          !it.CatalogItemId ||
          !it.CatalogNamespace ||
          !it.InstallationGuid
        ) {
          return false;
        }
        const itemGuid = String(it.InstallationGuid);
        const mancpnExists = fs.existsSync(
          path.join(installPath, '.egstore', `${itemGuid}.mancpn`)
        );
        if (!mancpnExists) return false;
        if (
          sourceManifestPath &&
          !fs.existsSync(path.join(installPath, '.egstore', `${itemGuid}.manifest`))
        ) {
          return false;
        }
        return true;
      });

      if (alreadyValid) {
        if (targetProgramDataEpicDir) {
          syncEpicEoshInstalledItem(targetProgramDataEpicDir, {
            installationGuid: guid,
            appName,
            catalogItemId,
            catalogNamespace,
            installLocation: formattedInstallLocation,
            version: String(entry.version || '1.0'),
            launchExecutable: finalLaunchExecutable,
            launchCommand: entry.launch_parameters || '',
            installSize: Number(entry.install_size || entry.installSize || 0),
          });
        }
        syncedCount++;
        continue;
      }

      const mandatoryFolderName =
        meta?.metadata?.customAttributes?.FolderName?.value || path.basename(installPath);

      const itemPayload = {
        FormatVersion: 0,
        bIsIncompleteInstall: false,
        LaunchCommand: entry.launch_parameters || '',
        LaunchExecutable: finalLaunchExecutable,
        ManifestLocation: formattedManifestLocation,
        StagingLocation: formattedStagingLocation,
        bIsApplication: true,
        bIsExecutable: true,
        bIsManaged: false,
        bNeedsValidation: false,
        bRequiresAuth: true,
        bCanRunOffline: Boolean(entry.can_run_offline !== false),
        AppName: appName,
        BaseURLs: Array.isArray(entry.base_urls) ? entry.base_urls : [],
        BuildLabel: 'Live',
        AppCategories: ['public', 'games', 'applications'],
        ChunkDbs: [],
        CompatibleApps: [],
        DisplayName: entry.title || meta?.app_title || appName,
        FullAppName: appName,
        InstallationGuid: guid,
        InstallLocation: formattedInstallLocation,
        InstallSessionId: '',
        InstallTags: Array.isArray(entry.install_tags) ? entry.install_tags : [],
        InstallComponents: [],
        HostInstallationGuid: '',
        PrereqIds: [],
        TechnicalType: '',
        VaultThumbnailUrl: '',
        VaultTitleText: '',
        InstallSize: Number(entry.install_size || entry.installSize || 0),
        MainWindowProcessName: '',
        ProcessNames: [],
        MainGameAppName: mainGameAppName,
        MandatoryAppFolderName: mandatoryFolderName,
        OwnershipToken: 'false',
        CatalogNamespace: catalogNamespace,
        CatalogItemId: catalogItemId,
        AppVersionString: String(entry.version || '1.0'),
      };

      const mancpnPayload = {
        FormatVersion: 0,
        AppName: appName,
        CatalogItemId: catalogItemId,
        CatalogNamespace: catalogNamespace,
      };

      try {
        const egstoreDir = path.join(toHostFilesystemPath(installPath), '.egstore');
        const bpsDir = path.join(egstoreDir, 'bps');
        fs.mkdirSync(bpsDir, { recursive: true });
        try {
          const egFiles = fs.readdirSync(egstoreDir);
          for (const ef of egFiles) {
            if (ef.toLowerCase().endsWith('.item')) {
              fs.rmSync(path.join(egstoreDir, ef), { force: true });
            }
          }
        } catch {}
        atomicWriteFileSync(
          path.join(egstoreDir, `${guid}.mancpn`),
          JSON.stringify(mancpnPayload, null, 2)
        );
        if (sourceManifestPath && fs.existsSync(sourceManifestPath)) {
          const destManifest = path.join(egstoreDir, `${guid}.manifest`);
          if (path.resolve(sourceManifestPath) !== path.resolve(destManifest)) {
            fs.copyFileSync(sourceManifestPath, destManifest);
          }
        }
      } catch {}

      try {
        for (const oldItem of existingItems) {
          if (
            oldItem.AppName === appName &&
            oldItem._fileName &&
            oldItem._fileName !== `${guid}.item`
          ) {
            try {
              fs.rmSync(path.join(targetManifestsDir, oldItem._fileName), { force: true });
            } catch {}
          }
        }
        const serializedItem = JSON.stringify(itemPayload, null, 2);
        atomicWriteFileSync(path.join(targetManifestsDir, `${guid}.item`), serializedItem);
        syncedCount++;
      } catch {}

      if (targetProgramDataEpicDir) {
        syncEpicEoshInstalledItem(targetProgramDataEpicDir, {
          installationGuid: guid,
          appName,
          catalogItemId,
          catalogNamespace,
          installLocation: formattedInstallLocation,
          version: String(entry.version || '1.0'),
          launchExecutable: finalLaunchExecutable,
          launchCommand: entry.launch_parameters || '',
          installSize: Number(entry.install_size || entry.installSize || 0),
        });
      }

      if (entry._legFile && fs.existsSync(entry._legFile) && entry.egl_guid !== guid) {
        try {
          const rawLeg = JSON.parse(fs.readFileSync(entry._legFile, 'utf8'));
          if (rawLeg && typeof rawLeg === 'object' && !Array.isArray(rawLeg) && rawLeg[appName]) {
            rawLeg[appName].egl_guid = guid;
            atomicWriteFileSync(entry._legFile, JSON.stringify(rawLeg, null, 2));
          }
        } catch {}
      }
    }

    // 3. Update LauncherInstalled.dat on host and any touched Wine/CrossOver bottles
    const syncLauncherInstalledDat = (
      /** @type {string | null} */ manifestsDir,
      /** @type {string | null} */ datPath,
      /** @type {string | null} */ bottlePathForCheck,
      /** @type {Set<string> | null} */ prunedNames
    ) => {
      if (!datPath) return;
      const isInstallLocAlive = (/** @type {any} */ rawLoc) => {
        if (!rawLoc || typeof rawLoc !== 'string') return false;
        if (bottlePathForCheck) {
          const localLoc = fromWineWindowsPath(rawLoc, bottlePathForCheck);
          return Boolean(localLoc && fs.existsSync(localLoc));
        }
        return fs.existsSync(rawLoc);
      };

      const validItems = [];
      if (manifestsDir && fs.existsSync(manifestsDir)) {
        try {
          const files = fs.readdirSync(manifestsDir);
          for (const f of files) {
            if (!f.toLowerCase().endsWith('.item')) continue;
            const fullItemPath = path.join(manifestsDir, f);
            try {
              const parsed = JSON.parse(fs.readFileSync(fullItemPath, 'utf8'));
              if (!parsed || typeof parsed !== 'object') continue;
              if (
                !parsed.bIsIncompleteInstall &&
                parsed.InstallLocation &&
                !isInstallLocAlive(parsed.InstallLocation)
              ) {
                try {
                  fs.rmSync(fullItemPath, { force: true });
                } catch {}
                continue;
              }
              if (
                !parsed.bIsIncompleteInstall &&
                parsed.AppName &&
                !(prunedNames && prunedNames.has(parsed.AppName)) &&
                isInstallLocAlive(parsed.InstallLocation)
              ) {
                validItems.push(parsed);
              }
            } catch {}
          }
        } catch {}
      }

      const listMap = new Map();
      if (fs.existsSync(datPath)) {
        try {
          const existingDat = JSON.parse(fs.readFileSync(datPath, 'utf8'));
          const existingList = Array.isArray(existingDat?.InstallationList)
            ? existingDat.InstallationList
            : [];
          for (const item of existingList) {
            if (
              item &&
              item.AppName &&
              !(prunedNames && prunedNames.has(item.AppName)) &&
              isInstallLocAlive(item.InstallLocation)
            ) {
              listMap.set(item.AppName, item);
            }
          }
        } catch {}
      }

      for (const item of validItems) {
        listMap.set(item.AppName, {
          InstallLocation: item.InstallLocation,
          NamespaceId: item.CatalogNamespace || '',
          ItemId: item.CatalogItemId || '',
          ArtifactId: item.AppName,
          AppVersion: item.AppVersionString || '1.0',
          AppName: item.AppName,
        });
      }

      try {
        const hostDatPath = toHostFilesystemPath(datPath);
        fs.mkdirSync(path.dirname(hostDatPath), { recursive: true });
        atomicWriteFileSync(
          hostDatPath,
          JSON.stringify({ InstallationList: Array.from(listMap.values()) }, null, 2)
        );
      } catch {}
    };

    if (
      eglLauncherInstalledPath &&
      (hostTouched ||
        fs.existsSync(eglLauncherInstalledPath) ||
        Boolean(eglManifestsDir && fs.existsSync(eglManifestsDir)) ||
        Boolean(options.eglLauncherInstalledPath || options.eglLauncherInstalledDat))
    ) {
      syncLauncherInstalledDat(
        eglManifestsDir,
        eglLauncherInstalledPath,
        null,
        prunedHostAppNames
      );
    }

    for (const [bPath, bTarget] of touchedBottleTargets.entries()) {
      syncLauncherInstalledDat(bTarget.manifestsDir, bTarget.datPath, bPath, null);
    }

    return { synced: syncedCount };
  } catch {
    return { synced: 0 };
  }
}

/**
 * Unregister an uninstalled Epic game from Epic Games Launcher (.item manifests + LauncherInstalled.dat)
 */
function unregisterEpicFirstPartyLauncher(
  /** @type {any} */ appName,
  /** @type {any} */ installPath,
  /** @type {any} */ options = {}
) {
  try {
    if (installPath && typeof installPath === 'object') {
      options = installPath;
      installPath = options.installPath || '';
    }
    const platform = options.platform || process.platform;
    const homedir = options.homedir || os.homedir();
    const userDataDir = getUserDataDir(options.userDataDir);
    const { eglManifestsDir, eglLauncherInstalledPath, isolatedNoOp } =
      resolveEpicFirstPartyPaths(options);
    const bottlePaths = platform === 'darwin' ? listAllInitializedBottlePaths(options) : [];

    if (isolatedNoOp && bottlePaths.length === 0) {
      return { removed: 0 };
    }
    if (!eglManifestsDir && !eglLauncherInstalledPath && bottlePaths.length === 0) {
      return { removed: 0 };
    }

    const cleanAppName = String(appName || '')
      .replace(/^epic[-_]/i, '')
      .trim();
    const normInstallPath = installPath ? toLocalFsPath(installPath) : null;
    const resolvedLocalInstall = normInstallPath ? path.resolve(normInstallPath) : null;

    /** @type {Set<string>} */
    const appNameSet = new Set();
    /** @type {Set<string>} */
    const catalogIdSet = new Set();
    const addAppCandidate = (/** @type {any} */ v) => {
      const s = String(v || '').trim();
      if (s) appNameSet.add(s.toLowerCase());
    };
    const addCatalogCandidate = (/** @type {any} */ v) => {
      const s = String(v || '').trim();
      if (s) catalogIdSet.add(s.toLowerCase());
    };

    addAppCandidate(appName);
    addAppCandidate(cleanAppName);
    addCatalogCandidate(cleanAppName);
    addCatalogCandidate(options.catalogItemId);
    if (Array.isArray(options.resolvedAppNames)) {
      for (const a of options.resolvedAppNames) addAppCandidate(a);
    }
    if (Array.isArray(options.resolvedCatalogItemIds)) {
      for (const c of options.resolvedCatalogItemIds) addCatalogCandidate(c);
    }

    const legendaryDirs = [
      path.join(userDataDir, 'legendaryConfig/legendary'),
      path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary'),
      path.join(homedir, '.config/legendary'),
      path.join(homedir, 'AppData/Roaming/heroic/legendaryConfig/legendary'),
    ];
    for (const legDir of legendaryDirs) {
      const instFile = path.join(legDir, 'installed.json');
      if (fs.existsSync(instFile)) {
        try {
          const raw = JSON.parse(fs.readFileSync(instFile, 'utf8'));
          const entries = Array.isArray(raw)
            ? raw
            : raw && typeof raw === 'object'
              ? Object.entries(raw).map(([k, v]) =>
                  v && typeof v === 'object' ? { app_name: k, ...v } : null
                )
              : [];
          for (const it of entries) {
            if (!it || typeof it !== 'object') continue;
            const aName = String(it.app_name || it.appName || '').trim();
            const cId = String(it.catalog_item_id || it.catalogItemId || '').trim();
            const iPath = it.install_path || it.installPath;
            const matchesInstall =
              resolvedLocalInstall &&
              iPath &&
              path.resolve(toLocalFsPath(iPath)) === resolvedLocalInstall;
            if (
              (aName &&
                (appNameSet.has(aName.toLowerCase()) || catalogIdSet.has(aName.toLowerCase()))) ||
              (cId &&
                (catalogIdSet.has(cId.toLowerCase()) || appNameSet.has(cId.toLowerCase()))) ||
              matchesInstall
            ) {
              addAppCandidate(aName);
              addCatalogCandidate(cId);
            }
          }
        } catch {}
      }

      const assetsFile = path.join(legDir, 'assets.json');
      if (fs.existsSync(assetsFile)) {
        try {
          const rawAssets = JSON.parse(fs.readFileSync(assetsFile, 'utf8'));
          const assetLists = [];
          if (Array.isArray(rawAssets)) assetLists.push(rawAssets);
          else if (rawAssets && typeof rawAssets === 'object') {
            for (const val of Object.values(rawAssets)) {
              if (Array.isArray(val)) assetLists.push(val);
            }
          }
          for (const list of assetLists) {
            for (const asset of list) {
              if (!asset || typeof asset !== 'object') continue;
              const aName = String(asset.app_name || asset.appName || '').trim();
              const cId = String(asset.catalog_item_id || asset.catalogItemId || '').trim();
              if (
                (aName && appNameSet.has(aName.toLowerCase())) ||
                (cId &&
                  (catalogIdSet.has(cId.toLowerCase()) || appNameSet.has(cId.toLowerCase())))
              ) {
                addAppCandidate(aName);
                addCatalogCandidate(cId);
              }
            }
          }
        } catch {}
      }
    }

    const targets = [];
    if (eglManifestsDir || eglLauncherInstalledPath) {
      const hostProgramDataEpic =
        platform === 'win32'
          ? options.programDataEpicDir ||
            (eglManifestsDir ? path.resolve(eglManifestsDir, '..', '..', '..') : null)
          : null;
      targets.push({
        manifestsDir: eglManifestsDir,
        datPath: eglLauncherInstalledPath,
        programDataEpicDir: hostProgramDataEpic,
        bottlePath: null,
      });
    }
    for (const bPath of bottlePaths) {
      const bEpic = path.join(bPath, 'drive_c', 'ProgramData', 'Epic');
      targets.push({
        manifestsDir: path.join(bEpic, 'EpicGamesLauncher', 'Data', 'Manifests'),
        datPath: path.join(bEpic, 'UnrealEngineLauncher', 'LauncherInstalled.dat'),
        programDataEpicDir: bEpic,
        bottlePath: bPath,
      });
    }

    let removedCount = 0;

    for (const target of targets) {
      /** @type {string[]} */
      const installCandidates = [];
      if (normInstallPath) installCandidates.push(normInstallPath);
      if (resolvedLocalInstall && resolvedLocalInstall !== normInstallPath) {
        installCandidates.push(resolvedLocalInstall);
      }
      if (normInstallPath && target.bottlePath) {
        installCandidates.push(toWineWindowsPath(normInstallPath, target.bottlePath));
      }

      const matchesInstallLocation = (/** @type {any} */ rawLoc) => {
        if (!rawLoc || typeof rawLoc !== 'string') return false;
        const trimmed = rawLoc.trim();
        if (
          installCandidates.some(
            (c) => c === trimmed || c.toLowerCase() === trimmed.toLowerCase()
          )
        ) {
          return true;
        }
        if (resolvedLocalInstall) {
          if (target.bottlePath) {
            const converted = fromWineWindowsPath(trimmed, target.bottlePath);
            if (converted && path.resolve(converted) === resolvedLocalInstall) return true;
          } else {
            try {
              if (path.resolve(trimmed) === resolvedLocalInstall) return true;
            } catch {}
          }
        }
        return false;
      };

      if (target.manifestsDir && fs.existsSync(target.manifestsDir)) {
        try {
          const files = fs.readdirSync(target.manifestsDir);
          for (const f of files) {
            if (!f.toLowerCase().endsWith('.item')) continue;
            const fullItemPath = path.join(target.manifestsDir, f);
            try {
              const item = JSON.parse(fs.readFileSync(fullItemPath, 'utf8'));
              const itApp = String(item?.AppName || '')
                .trim()
                .toLowerCase();
              const itCat = String(item?.CatalogItemId || '')
                .trim()
                .toLowerCase();
              const matchesApp = Boolean(
                (itApp && (appNameSet.has(itApp) || catalogIdSet.has(itApp))) ||
                  (itCat && (catalogIdSet.has(itCat) || appNameSet.has(itCat)))
              );
              const matchesPath = matchesInstallLocation(item?.InstallLocation);
              if (matchesApp || matchesPath) {
                addAppCandidate(item?.AppName);
                addCatalogCandidate(item?.CatalogItemId);
                fs.rmSync(fullItemPath, { force: true });
                removedCount++;
              }
            } catch {}
          }
        } catch {}
      }

      if (target.datPath && fs.existsSync(target.datPath)) {
        try {
          const rawDat = JSON.parse(fs.readFileSync(target.datPath, 'utf8'));
          const existingList = Array.isArray(rawDat?.InstallationList)
            ? rawDat.InstallationList
            : [];
          const filteredList = existingList.filter((/** @type {any} */ entry) => {
            if (!entry) return false;
            const eApp = String(entry.AppName || '')
              .trim()
              .toLowerCase();
            const eArt = String(entry.ArtifactId || '')
              .trim()
              .toLowerCase();
            const eItem = String(entry.ItemId || '')
              .trim()
              .toLowerCase();
            const matchesApp = Boolean(
              (eApp && (appNameSet.has(eApp) || catalogIdSet.has(eApp))) ||
                (eArt && (appNameSet.has(eArt) || catalogIdSet.has(eArt))) ||
                (eItem && (catalogIdSet.has(eItem) || appNameSet.has(eItem)))
            );
            const matchesPath = matchesInstallLocation(entry.InstallLocation);
            return !(matchesApp || matchesPath);
          });
          atomicWriteFileSync(
            target.datPath,
            JSON.stringify({ InstallationList: filteredList }, null, 2)
          );
        } catch {}
      }

      if (target.programDataEpicDir) {
        removeEpicEoshInstalledItem(target.programDataEpicDir, {
          appNames: Array.from(appNameSet),
          catalogItemIds: Array.from(catalogIdSet),
          installPaths: installCandidates,
        });
      }
    }

    return { removed: removedCount };
  } catch {
    return { removed: 0 };
  }
}

function isMockOrCorruptedToken(/** @type {any} */ tokenStr) {
  if (tokenStr === null || tokenStr === undefined) return false;
  if (typeof tokenStr !== 'string') return false;
  const trimmed = tokenStr.trim();
  if (!trimmed) return true;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(trimmed)) return true;
  if (/^(?:undefined|null|nan|\[object\s+object\])$/i.test(trimmed)) return true;
  if (/^(?:mock|fake|dummy|test)[-_]/i.test(trimmed)) return true;
  if (/^(?:epic|gog|xbox|steam)-rotated(?:-|$)/i.test(trimmed)) return true;
  if (/-(?:rotated)-(?:access|refresh)-token$/i.test(trimmed)) return true;
  if (/^freshly-renewed-(?:access-|refresh-)?token$/i.test(trimmed)) return true;
  return false;
}

function isPoisonedStorefrontToken(/** @type {any} */ tokenStr, /** @type {any} */ options = {}) {
  if (!tokenStr || typeof tokenStr !== 'string') return false;
  const trimmed = tokenStr.trim();
  if (/^(epic-rotated|gog-rotated)/i.test(trimmed)) {
    return true;
  }
  const hasExplicitTestSandbox = Boolean(
    options?.homedir || options?.userDataDir || options?.savedTokens
  );
  if (
    options?.sanitizeMockTokens === true ||
    (!isTestEnvironment(options) && !hasExplicitTestSandbox) ||
    (!options?.homedir && !options?.userDataDir && !options?.savedTokens)
  ) {
    return isMockOrCorruptedToken(trimmed);
  }
  return false;
}

function getLegendaryConfigDir(/** @type {any} */ options = {}) {
  const customCfgDir =
    options && typeof options === 'object'
      ? options.legendaryConfigDir || options.legendaryConfigPath
      : null;
  if (typeof customCfgDir === 'string' && customCfgDir.trim()) {
    return customCfgDir.trim();
  }
  const { userDataDir } = resolveIsolatedHomedirAndUserData(options);
  return path.join(userDataDir, 'legendaryConfig', 'legendary');
}

function sanitizeEpicCandidateRecord(/** @type {any} */ rawRecord, /** @type {any} */ options = {}) {
  if (!rawRecord || typeof rawRecord !== 'object') return null;
  const copy = { ...rawRecord };
  let poisoned = false;
  if (isPoisonedStorefrontToken(copy.access_token, options)) {
    delete copy.access_token;
    poisoned = true;
  }
  if (isPoisonedStorefrontToken(copy.refresh_token, options)) {
    delete copy.refresh_token;
    poisoned = true;
  }
  if (
    isPoisonedStorefrontToken(copy.account_id, options) &&
    typeof copy.in_app_id === 'string' &&
    /^[0-9a-f]{32}$/i.test(copy.in_app_id.trim())
  ) {
    copy.account_id = copy.in_app_id.trim();
  }
  return {
    record: copy.access_token || copy.refresh_token ? copy : null,
    meta: copy,
    poisoned,
  };
}

/**
 * Ensure Legendary config directory and Epic OAuth user.json are populated
 */
async function ensureLegendaryConfigAndAuth(/** @type {any} */ options = {}) {
  const { homedir } = resolveIsolatedHomedirAndUserData(options);
  const legendaryConfigPath = getLegendaryConfigDir(options);
  const userFilePath = path.join(legendaryConfigPath, 'user.json');
  const activeStoreSync = options.storeSync || getStoreSync();

  try {
    const hostLegCfgPath = toHostFilesystemPath(legendaryConfigPath);
    if (!fs.existsSync(hostLegCfgPath)) {
      fs.mkdirSync(hostLegCfgPath, { recursive: true });
    }
  } catch {}

  const candidateHeroicDirs = [
    path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary'),
    path.join(
      process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
      'heroic',
      'legendaryConfig',
      'legendary'
    ),
    path.join(homedir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary'),
    path.join(homedir, '.config/legendary'),
  ];

  // Copy non-credential metadata files; never blindly copy a potentially poisoned user.json
  for (const srcDir of candidateHeroicDirs) {
    if (!fs.existsSync(srcDir)) continue;
    for (const fileName of ['assets.json', 'installed.json', 'aliases.json']) {
      const srcFile = path.join(srcDir, fileName);
      const dstFile = path.join(legendaryConfigPath, fileName);
      if (fs.existsSync(srcFile) && !fs.existsSync(dstFile)) {
        try {
          fs.copyFileSync(srcFile, dstFile);
          if (fileName === 'installed.json') {
            const parsedExt = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
            const extEntries = Array.isArray(parsedExt)
              ? parsedExt
              : parsedExt && typeof parsedExt === 'object'
                ? Object.entries(parsedExt).map(([k, v]) =>
                    v && typeof v === 'object' ? { app_name: k, ...v } : null
                  )
                : [];
            for (const item of extEntries) {
              if (!item || typeof item !== 'object') continue;
              const extAppName = String(item.app_name || item.appName || '').trim();
              const extInstallPath = String(item.install_path || item.installPath || '').trim();
              if (extAppName || extInstallPath) {
                recordImportedEpicInstall(
                  { appName: extAppName, installPath: extInstallPath, source: srcDir },
                  options
                );
              }
            }
          }
        } catch (copyMetaErr) {
          diagLog.debug('ensureLegendaryConfigAndAuth.copyMetadata', copyMetaErr, { srcFile });
        }
      }
    }
  }

  const epicTombstoned =
    isStoreDisconnectedTombstoned('epic', options) &&
    !options.savedTokens?.epic &&
    !options.allowInteractiveAuth;
  if (epicTombstoned) {
    try {
      if (fs.existsSync(userFilePath)) {
        fs.unlinkSync(userFilePath);
      }
    } catch {}
    return {
      legendaryConfigPath,
      configDir: legendaryConfigPath,
      userFilePath,
      authenticated: false,
      disconnectedByUser: true,
      recoveredSession: false,
      accessToken: null,
      refreshToken: null,
      accountId: null,
      displayName: null,
      env: {
        ...process.env,
        LEGENDARY_CONFIG_PATH: legendaryConfigPath,
        LC_ALL: normalizePosixUtf8Locale(options.env?.LC_ALL ?? process.env.LC_ALL),
        LANG: normalizePosixUtf8Locale(options.env?.LANG ?? process.env.LANG),
      },
    };
  }

  const hasExplicitSavedTokens = Boolean(options.savedTokens);
  const savedTokens =
    options.savedTokens ||
    (activeStoreSync && typeof activeStoreSync.loadSavedTokens === 'function'
      ? activeStoreSync.loadSavedTokens(options)
      : {});

  /** @type {any[]} */
  const candidateRecords = [];
  /** @type {any} */
  let fallbackAccountMeta = null;

  if (savedTokens && savedTokens.epic && typeof savedTokens.epic === 'object') {
    const sanitized = sanitizeEpicCandidateRecord(savedTokens.epic, options);
    if (sanitized) {
      fallbackAccountMeta = fallbackAccountMeta || sanitized.meta;
      if (sanitized.record) {
        candidateRecords.push({ source: 'savedTokens', data: sanitized.record });
      }
    }
  }

  const candidateUserJsonPaths = [
    userFilePath,
    path.join(homedir, '.config/legendary/user.json'),
    path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary/user.json'),
    path.join(
      process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
      'heroic',
      'legendaryConfig',
      'legendary',
      'user.json'
    ),
    path.join(homedir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary', 'user.json'),
  ];

  for (const candFile of candidateUserJsonPaths) {
    if (!fs.existsSync(candFile)) continue;
    try {
      const parsedUser = JSON.parse(fs.readFileSync(candFile, 'utf8'));
      const sanitized = sanitizeEpicCandidateRecord(parsedUser, options);
      if (sanitized) {
        fallbackAccountMeta = fallbackAccountMeta || sanitized.meta;
        if (sanitized.poisoned) {
          if (
            path.resolve(candFile) === path.resolve(userFilePath) ||
            path.resolve(candFile) ===
              path.resolve(path.join(homedir, '.config/legendary/user.json'))
          ) {
            try {
              fs.unlinkSync(candFile);
            } catch {}
          }
        }
        if (sanitized.record) {
          candidateRecords.push({
            source: candFile,
            isExternal: path.resolve(candFile) !== path.resolve(userFilePath),
            data: sanitized.record,
          });
        }
      }
    } catch {}
  }

  /** @type {any} */
  let epicTokenData = null;
  let epicTokenFromExternal = false;
  let recoveredSession = false;
  const triedRefreshTokens = new Set();

  for (const { data: cand, isExternal } of candidateRecords) {
    const expiresAtMs = cand.expires_at ? new Date(cand.expires_at).getTime() : 0;
    const isExpiringSoon =
      Boolean(options.forceTokenRefresh) ||
      !cand.access_token ||
      !expiresAtMs ||
      Number.isNaN(expiresAtMs) ||
      expiresAtMs - Date.now() < 10 * 60 * 1000;

    if (!isExpiringSoon && cand.access_token) {
      epicTokenData = { ...cand };
      epicTokenFromExternal = Boolean(isExternal);
      break;
    }

    if (options.skipNetwork) {
      if (cand.access_token && !options.forceTokenRefresh) {
        epicTokenData = { ...cand };
        epicTokenFromExternal = Boolean(isExternal);
        break;
      }
      continue;
    }

    if (
      cand.refresh_token &&
      (!isExternal || options.allowExternalTokenRefresh === true) &&
      !triedRefreshTokens.has(cand.refresh_token) &&
      activeStoreSync &&
      typeof activeStoreSync.renewEpicTokens === 'function'
    ) {
      triedRefreshTokens.add(cand.refresh_token);
      try {
        const renewed = await activeStoreSync.renewEpicTokens(cand.refresh_token);
        if (
          renewed &&
          renewed.access_token &&
          !isPoisonedStorefrontToken(renewed.access_token, options)
        ) {
          epicTokenData = {
            ...cand,
            ...renewed,
          };
          epicTokenFromExternal = Boolean(isExternal);
          if (typeof activeStoreSync.saveTokens === 'function') {
            try {
              activeStoreSync.saveTokens(
                'epic',
                epicTokenData,
                isExternal ? { ...options, fromExternalFallback: true } : options
              );
            } catch {}
          }
          break;
        }
      } catch {}
    } else if (
      !cand.refresh_token &&
      cand.access_token &&
      !options.forceTokenRefresh &&
      (!cand.expires_at || expiresAtMs > Date.now())
    ) {
      epicTokenData = { ...cand };
      epicTokenFromExternal = Boolean(isExternal);
      break;
    }
  }

  if ((!epicTokenData || !epicTokenData.access_token) && !options.skipNetwork) {
    const recoveryFn =
      typeof options.recoverEpicAuthFn === 'function'
        ? options.recoverEpicAuthFn
        : getEpicAuthRecoveryHook();
    if (typeof recoveryFn === 'function') {
      try {
        const recovered = await recoveryFn({
          allowInteractiveAuth: Boolean(options.allowInteractiveAuth),
          forceTokenRefresh: Boolean(options.forceTokenRefresh),
          options,
        });
        if (
          recovered &&
          recovered.access_token &&
          !isPoisonedStorefrontToken(recovered.access_token, options)
        ) {
          epicTokenData = {
            ...(fallbackAccountMeta || {}),
            ...recovered,
          };
          recoveredSession = true;
          if (activeStoreSync && typeof activeStoreSync.saveTokens === 'function') {
            try {
              activeStoreSync.saveTokens(
                'epic',
                epicTokenData,
                options.allowInteractiveAuth
                  ? options
                  : { ...options, fromExternalFallback: true }
              );
            } catch {}
          }
        }
      } catch {}
    }
  }

  if (epicTokenData && epicTokenData.access_token) {
    const resolvedAccountId =
      epicTokenData.account_id && !isPoisonedStorefrontToken(epicTokenData.account_id, options)
        ? epicTokenData.account_id
        : epicTokenData.in_app_id || epicTokenData.account_id || '';

    const userJsonPayload = {
      access_token: epicTokenData.access_token,
      expires_in: epicTokenData.expires_in || 7200,
      expires_at: epicTokenData.expires_at || new Date(Date.now() + 7200 * 1000).toISOString(),
      token_type: epicTokenData.token_type || 'bearer',
      refresh_token: epicTokenData.refresh_token || '',
      refresh_expires: epicTokenData.refresh_expires || 28800,
      refresh_expires_at:
        epicTokenData.refresh_expires_at || new Date(Date.now() + 28800 * 1000).toISOString(),
      account_id: resolvedAccountId,
      client_id:
        epicTokenData.client_id ||
        String(process.env.ONE_LAUNCHER_EPIC_CLIENT_ID || '').trim() ||
        '34a02cf8f4414e29b15921876da36f9a',
      internal_client: true,
      client_service: 'launcher',
      displayName: epicTokenData.displayName || resolvedAccountId || 'Player',
      app: 'launcher',
      in_app_id: epicTokenData.in_app_id || resolvedAccountId || '',
    };

    try {
      atomicWriteSecureFileSync(userFilePath, JSON.stringify(userJsonPayload, null, 2), options);
    } catch (writeErr) {
      diagLog.warn('ensureLegendaryConfigAndAuth.writeSecureUserJson', writeErr, { userFilePath });
    }

    if (
      !hasExplicitSavedTokens &&
      !isMockOrCorruptedToken(epicTokenData.access_token) &&
      activeStoreSync &&
      typeof activeStoreSync.saveTokens === 'function' &&
      savedTokens?.epic?.access_token !== epicTokenData.access_token
    ) {
      try {
        activeStoreSync.saveTokens(
          'epic',
          {
            ...(savedTokens?.epic || {}),
            ...epicTokenData,
            access_token: epicTokenData.access_token,
            refresh_token:
              epicTokenData.refresh_token || savedTokens?.epic?.refresh_token || undefined,
            account_id: resolvedAccountId || savedTokens?.epic?.account_id,
            displayName: userJsonPayload.displayName || savedTokens?.epic?.displayName,
          },
          epicTokenFromExternal ? { ...options, fromExternalFallback: true } : options
        );
      } catch {}
    }

    return {
      legendaryConfigPath,
      configDir: legendaryConfigPath,
      userFilePath,
      authenticated: true,
      recoveredSession,
      accessToken: epicTokenData.access_token,
      refreshToken: epicTokenData.refresh_token || null,
      accountId: resolvedAccountId || null,
      displayName: userJsonPayload.displayName || null,
      env: {
        ...process.env,
        LEGENDARY_CONFIG_PATH: legendaryConfigPath,
        LC_ALL: normalizePosixUtf8Locale(options.env?.LC_ALL ?? process.env.LC_ALL),
        LANG: normalizePosixUtf8Locale(options.env?.LANG ?? process.env.LANG),
      },
    };
  }

  try {
    if (fs.existsSync(userFilePath)) {
      fs.unlinkSync(userFilePath);
    }
  } catch {}

  return {
    legendaryConfigPath,
    configDir: legendaryConfigPath,
    userFilePath,
    authenticated: false,
    recoveredSession: false,
    accessToken: null,
    refreshToken: null,
    accountId: fallbackAccountMeta?.account_id || null,
    displayName: fallbackAccountMeta?.displayName || null,
    env: {
      ...process.env,
      LEGENDARY_CONFIG_PATH: legendaryConfigPath,
      LC_ALL: normalizePosixUtf8Locale(options.env?.LC_ALL ?? process.env.LC_ALL),
      LANG: normalizePosixUtf8Locale(options.env?.LANG ?? process.env.LANG),
    },
  };
}

/**
 * Scan and cache local Legendary assets.json, aliases.json, and metadata/*.json
 * to resolve per-game Epic macOS and Windows build availability with <1ms cached lookups.
 */
function collectLocalEpicMetadataAndSupport(/** @type {any} */ options = {}) {
  const homedir = options.homedir || os.homedir();
  const userDataDir = getUserDataDir(options.userDataDir);
  const customRoots = Array.isArray(options.customRoots) ? options.customRoots : [];
  const norm = (/** @type {any} */ s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');

  const configDirs = Array.from(
    new Set([
      path.join(userDataDir, 'legendaryConfig/legendary'),
      path.join(homedir, 'Library/Application Support/one-launcher/legendaryConfig/legendary'),
      path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary'),
      path.join(
        process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
        'heroic',
        'legendaryConfig',
        'legendary'
      ),
      path.join(homedir, 'AppData', 'Roaming', 'heroic', 'legendaryConfig', 'legendary'),
      path.join(homedir, '.config/legendary'),
      ...customRoots.map((/** @type {string} */ r) => toLocalFsPath(r, customRoots)),
      ...customRoots.map((/** @type {string} */ r) =>
        path.join(toLocalFsPath(r, customRoots), 'legendary')
      ),
      ...customRoots.map((/** @type {string} */ r) =>
        path.join(toLocalFsPath(r, customRoots), 'heroic/legendaryConfig/legendary')
      ),
    ])
  );

  /** @type {any[]} */
  const winAssets = [];
  /** @type {any[]} */
  const macAssets = [];
  const aliasToAppName = new Map();
  /** @type {any[]} */
  const metaSummaries = [];
  const seenMetaAppNames = new Set();

  for (const dir of configDirs) {
    if (!dir || !fs.existsSync(dir)) continue;

    const aliasesFile = path.join(dir, 'aliases.json');
    if (fs.existsSync(aliasesFile)) {
      try {
        const st = fs.statSync(aliasesFile);
        const mtimeMs = st.mtimeMs || 0;
        const size = st.size || 0;
        const cachedAliases = legendaryAliasesFileCache.get(aliasesFile);
        let aliasEntries = null;
        if (
          cachedAliases &&
          cachedAliases.mtimeMs === mtimeMs &&
          cachedAliases.size === size &&
          Array.isArray(cachedAliases.entries)
        ) {
          aliasEntries = cachedAliases.entries;
        } else {
          aliasEntries = [];
          const aliasesObj = JSON.parse(fs.readFileSync(aliasesFile, 'utf8'));
          if (aliasesObj && typeof aliasesObj === 'object') {
            for (const [appNameKey, list] of Object.entries(aliasesObj)) {
              if (!Array.isArray(list)) continue;
              for (const alias of list) {
                const n = norm(alias);
                if (n) {
                  aliasEntries.push([n, appNameKey]);
                }
              }
            }
          }
          setBoundedMapEntry(
            legendaryAliasesFileCache,
            aliasesFile,
            { mtimeMs, size, entries: aliasEntries },
            MAX_LEGENDARY_CACHE_DIRS
          );
        }
        for (const [n, appNameKey] of aliasEntries) {
          if (!aliasToAppName.has(n)) {
            aliasToAppName.set(n, appNameKey);
          }
        }
      } catch {}
    }

    const assetsFile = path.join(dir, 'assets.json');
    if (fs.existsSync(assetsFile)) {
      try {
        const st = fs.statSync(assetsFile);
        const mtimeMs = st.mtimeMs || 0;
        const size = st.size || 0;
        const cachedAssets = legendaryAssetsFileCache.get(assetsFile);
        let fileWinAssets = null;
        let fileMacAssets = null;
        if (
          cachedAssets &&
          cachedAssets.mtimeMs === mtimeMs &&
          cachedAssets.size === size &&
          Array.isArray(cachedAssets.winAssets) &&
          Array.isArray(cachedAssets.macAssets)
        ) {
          fileWinAssets = cachedAssets.winAssets;
          fileMacAssets = cachedAssets.macAssets;
        } else {
          fileWinAssets = [];
          fileMacAssets = [];
          const parsed = JSON.parse(fs.readFileSync(assetsFile, 'utf8'));
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (!item || typeof item !== 'object') continue;
              const hasMacInfo =
                String(item.platform || '').toLowerCase() === 'mac' ||
                Boolean(
                  item.asset_infos &&
                    item.asset_infos.Mac &&
                    Object.keys(item.asset_infos.Mac).length > 0
                );
              const hasWinInfo =
                String(item.platform || '').toLowerCase() === 'windows' ||
                Boolean(
                  item.asset_infos &&
                    item.asset_infos.Windows &&
                    Object.keys(item.asset_infos.Windows).length > 0
                ) ||
                (!item.platform && !item.asset_infos);

              if (hasMacInfo) fileMacAssets.push(item);
              if (hasWinInfo) fileWinAssets.push(item);
            }
          } else if (parsed && typeof parsed === 'object') {
            if (Array.isArray(parsed.Windows)) {
              fileWinAssets.push(...parsed.Windows);
            }
            if (Array.isArray(parsed.Mac)) {
              fileMacAssets.push(...parsed.Mac);
            }
          }
          setBoundedMapEntry(
            legendaryAssetsFileCache,
            assetsFile,
            { mtimeMs, size, winAssets: fileWinAssets, macAssets: fileMacAssets },
            MAX_LEGENDARY_CACHE_DIRS
          );
        }
        winAssets.push(...fileWinAssets);
        macAssets.push(...fileMacAssets);
      } catch {}
    }

    const metaDir = path.join(dir, 'metadata');
    if (fs.existsSync(metaDir)) {
      try {
        const st = fs.statSync(metaDir);
        const mtimeMs = st.mtimeMs || 0;
        const files = fs.readdirSync(metaDir).filter((f) => f.endsWith('.json'));
        const fileCount = files.length;
        const cachedMeta = legendaryMetadataDirCache.get(metaDir);
        let dirSummaries = null;
        if (
          cachedMeta &&
          cachedMeta.mtimeMs === mtimeMs &&
          cachedMeta.fileCount === fileCount &&
          Array.isArray(cachedMeta.summaries)
        ) {
          dirSummaries = cachedMeta.summaries;
        } else {
          dirSummaries = [];
          for (const f of files) {
            try {
              const json = JSON.parse(fs.readFileSync(path.join(metaDir, f), 'utf8'));
              if (!json || typeof json !== 'object') continue;
              const appName = String(json.app_name || f.replace(/\.json$/i, '')).trim();
              if (!appName) continue;
              const catalogItemId = String(
                json.catalog_item_id || json.id || json.metadata?.id || ''
              ).trim();
              const namespace = String(json.namespace || json.metadata?.namespace || '').trim();
              const deploymentId =
                String(
                  json.sidecar?.config?.deploymentId ||
                    json.metadata?.customAttributes?.DeploymentId?.value ||
                    ''
                ).trim() || undefined;
              const appTitle = String(json.app_title || json.metadata?.title || '').trim();
              const normTitle = norm(appTitle);
              const hasMacAsset = Boolean(
                json.asset_infos?.Mac && Object.keys(json.asset_infos.Mac).length > 0
              );
              const hasWinAsset = Boolean(
                json.asset_infos?.Windows && Object.keys(json.asset_infos.Windows).length > 0
              );
              const releaseInfo = json.metadata?.releaseInfo || json.releaseInfo;
              const hasMacRelease =
                Array.isArray(releaseInfo) &&
                releaseInfo.some(
                  (r) =>
                    r &&
                    Array.isArray(r.platform) &&
                    r.platform.some((/** @type {any} */ p) => /^mac$/i.test(String(p)))
                );
              const hasWinRelease =
                Array.isArray(releaseInfo) &&
                releaseInfo.some(
                  (r) =>
                    r &&
                    Array.isArray(r.platform) &&
                    r.platform.some((/** @type {any} */ p) => /^(windows|win32)$/i.test(String(p)))
                );
              const hasMac = hasMacAsset || hasMacRelease;
              const hasWin = hasWinAsset || hasWinRelease || !hasMac;
              dirSummaries.push({
                appName,
                catalogItemId,
                namespace,
                deploymentId,
                appTitle,
                normTitle,
                hasMac,
                hasWin,
                macVersion: json.asset_infos?.Mac?.build_version || undefined,
                winVersion: json.asset_infos?.Windows?.build_version || undefined,
              });
            } catch {}
          }
          setBoundedMapEntry(
            legendaryMetadataDirCache,
            metaDir,
            {
              mtimeMs,
              fileCount,
              summaries: dirSummaries,
            },
            MAX_LEGENDARY_CACHE_DIRS
          );
        }
        for (const s of dirSummaries) {
          const key = s.appName.toLowerCase();
          if (!seenMetaAppNames.has(key)) {
            seenMetaAppNames.add(key);
            metaSummaries.push({ ...s });
          } else {
            const existing = metaSummaries.find((m) => m.appName.toLowerCase() === key);
            if (existing) {
              if (!existing.deploymentId && s.deploymentId) existing.deploymentId = s.deploymentId;
              if (!existing.namespace && s.namespace) existing.namespace = s.namespace;
              if (!existing.catalogItemId && s.catalogItemId) {
                existing.catalogItemId = s.catalogItemId;
              }
            }
          }
        }
      } catch {}
    }
  }

  /** @type {Record<string, { windows: boolean, mac: boolean }>} */
  const epicPlatformSupport = {};
  const mergeSupport = (
    /** @type {any} */ rawKey,
    /** @type {boolean} */ win,
    /** @type {boolean} */ mac
  ) => {
    const k = String(rawKey || '')
      .toLowerCase()
      .trim();
    if (!k) return;
    const prev = epicPlatformSupport[k] || { windows: false, mac: false };
    epicPlatformSupport[k] = {
      windows: Boolean(prev.windows || win),
      mac: Boolean(prev.mac || mac),
    };
  };

  for (const item of winAssets) {
    if (!item || typeof item !== 'object') continue;
    mergeSupport(item.app_name || item.appName, true, false);
    mergeSupport(item.catalog_item_id || item.catalogItemId, true, false);
    if (item.app_title || item.title) {
      mergeSupport(norm(item.app_title || item.title), true, false);
    }
  }
  for (const item of macAssets) {
    if (!item || typeof item !== 'object') continue;
    mergeSupport(item.app_name || item.appName, false, true);
    mergeSupport(item.catalog_item_id || item.catalogItemId, false, true);
    if (item.app_title || item.title) {
      mergeSupport(norm(item.app_title || item.title), false, true);
    }
  }
  for (const s of metaSummaries) {
    const existingByApp = epicPlatformSupport[s.appName.toLowerCase()];
    const hasWin = Boolean(s.hasWin || existingByApp?.windows);
    const hasMac = Boolean(s.hasMac || existingByApp?.mac);
    mergeSupport(s.appName, hasWin, hasMac);
    mergeSupport(s.catalogItemId, hasWin, hasMac);
    if (s.normTitle) {
      mergeSupport(s.normTitle, hasWin, hasMac);
    }
    if (s.appTitle) {
      mergeSupport(s.appTitle, hasWin, hasMac);
    }
  }

  return {
    configDirs,
    winAssets,
    macAssets,
    aliasToAppName,
    metaSummaries,
    epicPlatformSupport,
  };
}

/**
 * Resolve Epic Games app_name and native macOS vs Windows build availability
 */
function resolveEpicAppAndPlatforms(/** @type {any} */ payload = {}, /** @type {any} */ options = {}) {
  const cleanId = String(payload.platformGameId || payload.gameId || '')
    .replace(/^epic-/i, '')
    .trim();
  const title = String(payload.title || '').trim();
  const norm = (/** @type {any} */ s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const normTitle = norm(title);
  const normCleanId = norm(cleanId);

  const { configDirs, winAssets, macAssets, aliasToAppName, metaSummaries } =
    collectLocalEpicMetadataAndSupport(options);

  const matchesEntry = (/** @type {any} */ entry, /** @type {string} */ targetAppName) => {
    if (!entry || typeof entry !== 'object') return false;
    if (targetAppName && entry.app_name === targetAppName) return true;
    if (cleanId) {
      if (
        entry.app_name === cleanId ||
        entry.catalog_item_id === cleanId ||
        entry.asset_id === cleanId ||
        entry.namespace === cleanId ||
        entry.asset_infos?.Windows?.build_id === cleanId ||
        entry.asset_infos?.Mac?.build_id === cleanId
      ) {
        return true;
      }
    }
    if (normTitle && entry.app_title && norm(entry.app_title) === normTitle) {
      return true;
    }
    return false;
  };

  const matchesMetaSummary = (/** @type {any} */ s, /** @type {string} */ targetAppName) => {
    if (!s) return false;
    if (targetAppName && s.appName.toLowerCase() === String(targetAppName).toLowerCase()) {
      return true;
    }
    if (cleanId) {
      const cleanLower = cleanId.toLowerCase();
      if (
        s.appName.toLowerCase() === cleanLower ||
        (s.catalogItemId && s.catalogItemId.toLowerCase() === cleanLower) ||
        (s.namespace && s.namespace.toLowerCase() === cleanLower)
      ) {
        return true;
      }
    }
    if (normTitle && s.normTitle && s.normTitle === normTitle) {
      return true;
    }
    return false;
  };

  let resolvedAppName = '';

  const directWin = winAssets.find((e) => matchesEntry(e, ''));
  const directMac = macAssets.find((e) => matchesEntry(e, ''));
  if (directMac && directMac.app_name) {
    resolvedAppName = directMac.app_name;
  } else if (directWin && directWin.app_name) {
    resolvedAppName = directWin.app_name;
  }

  const matchedMeta = metaSummaries.find((s) => matchesMetaSummary(s, resolvedAppName));
  if (!resolvedAppName && matchedMeta && matchedMeta.appName) {
    resolvedAppName = matchedMeta.appName;
  }

  if (!resolvedAppName) {
    if (normTitle && aliasToAppName.has(normTitle)) {
      resolvedAppName = aliasToAppName.get(normTitle);
    } else if (normCleanId && aliasToAppName.has(normCleanId)) {
      resolvedAppName = aliasToAppName.get(normCleanId);
    }
  }

  if (!resolvedAppName) {
    resolvedAppName = cleanId;
  }

  const macEntry = macAssets.find((e) => matchesEntry(e, resolvedAppName));
  const winEntry = winAssets.find((e) => matchesEntry(e, resolvedAppName));
  const metaSummary =
    matchedMeta || metaSummaries.find((s) => matchesMetaSummary(s, resolvedAppName)) || null;

  const foundInLocal = Boolean(macEntry || winEntry || metaSummary);
  const hasMacBuild = foundInLocal
    ? Boolean(macEntry) || Boolean(metaSummary?.hasMac)
    : Boolean(payload.storePlatforms?.mac === true);
  const hasWindowsBuild = foundInLocal
    ? Boolean(winEntry) || Boolean(metaSummary?.hasWin) || !hasMacBuild
    : payload.storePlatforms?.windows !== undefined
      ? Boolean(payload.storePlatforms.windows)
      : true;

  const macVersion =
    macEntry?.build_version ||
    macEntry?.asset_infos?.Mac?.build_version ||
    metaSummary?.macVersion ||
    undefined;
  const winVersion =
    winEntry?.build_version ||
    winEntry?.asset_infos?.Windows?.build_version ||
    metaSummary?.winVersion ||
    undefined;

  let namespace = macEntry?.namespace || winEntry?.namespace || metaSummary?.namespace;
  let catalogItemId =
    macEntry?.catalog_item_id || winEntry?.catalog_item_id || metaSummary?.catalogItemId;
  let deploymentId = metaSummary?.deploymentId;

  if ((!namespace || !catalogItemId || !deploymentId) && resolvedAppName) {
    for (const dir of configDirs) {
      if (!dir) continue;
      const metaFile = path.join(dir, 'metadata', `${resolvedAppName}.json`);
      if (fs.existsSync(metaFile)) {
        try {
          const metaJson = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
          namespace = namespace || metaJson?.namespace || metaJson?.metadata?.namespace;
          catalogItemId =
            catalogItemId ||
            metaJson?.catalog_item_id ||
            metaJson?.id ||
            metaJson?.metadata?.id;
          deploymentId =
            deploymentId ||
            String(
              metaJson?.sidecar?.config?.deploymentId ||
                metaJson?.metadata?.customAttributes?.DeploymentId?.value ||
                ''
            ).trim() ||
            undefined;
          if (namespace && catalogItemId && deploymentId) break;
        } catch {}
      }
    }
  }

  return {
    resolvedAppName,
    appName: resolvedAppName,
    hasMacBuild,
    hasWindowsBuild,
    macVersion,
    winVersion,
    namespace,
    catalogItemId,
    deploymentId,
  };
}

/**
 * Helper to perform an HTTPS JSON request using options.fetchFn, global.fetch, or node:https fallback
 */
async function performJsonHttpRequest(
  /** @type {string} */ url,
  /** @type {any} */ reqOptions = {},
  /** @type {any} */ fetchFn = null
) {
  const fetchImpl = fetchFn || (typeof global !== 'undefined' ? global.fetch : null);
  const timeoutMs = Number(reqOptions.timeoutMs || 3500);
  if (typeof fetchImpl === 'function') {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    if (timer && typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetchImpl(url, {
        method: reqOptions.method || 'GET',
        headers: reqOptions.headers || {},
        ...(reqOptions.body !== undefined ? { body: reqOptions.body } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      });
      const status = Number(response?.status || (response?.ok ? 200 : 500));
      const ok = Boolean(response?.ok ?? (status >= 200 && status < 300));
      let data = null;
      if (typeof response?.json === 'function') {
        try {
          data = await response.json();
        } catch {}
      } else if (typeof response?.text === 'function') {
        try {
          const txt = await response.text();
          data = txt ? JSON.parse(txt) : null;
        } catch {}
      }
      return { ok, status, data };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'http:' ? http : https;
      const req = client.request(
        parsedUrl,
        {
          method: reqOptions.method || 'GET',
          headers: reqOptions.headers || {},
          timeout: timeoutMs,
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => {
            raw += String(chunk);
          });
          res.on('end', () => {
            const status = Number(res.statusCode || 500);
            const ok = status >= 200 && status < 300;
            let data = null;
            try {
              data = raw ? JSON.parse(raw) : null;
            } catch {}
            resolve({ ok, status, data });
          });
        }
      );
      req.on('error', () => resolve({ ok: false, status: 0, data: null }));
      req.on('timeout', () => {
        try {
          req.destroy();
        } catch {}
        resolve({ ok: false, status: 0, data: null });
      });
      if (reqOptions.body !== undefined) {
        req.write(reqOptions.body);
      }
      req.end();
    } catch {
      resolve({ ok: false, status: 0, data: null });
    }
  });
}

/**
 * Resolve Epic Games OAuth Exchange Code & EOS SDK launch arguments so Epic games
 * authenticate with Epic Online Services for live achievement unlocks and cloud saves.
 */
async function resolveEpicLaunchAuthArguments(
  /** @type {any} */ payload = {},
  /** @type {any} */ options = {}
) {
  let appName = String(payload.appName || payload.artifactId || '').trim();
  let namespace = String(payload.namespace || '').trim();
  let catalogItemId = String(payload.catalogItemId || '').trim();
  let deploymentId = String(payload.deploymentId || '').trim();

  if (!appName || !namespace || !deploymentId) {
    try {
      const resolved = resolveEpicAppAndPlatforms(payload, options);
      if (!appName && resolved?.resolvedAppName) {
        appName = String(resolved.resolvedAppName).trim();
      }
      if (!namespace && resolved?.namespace) {
        namespace = String(resolved.namespace).trim();
      }
      if (!catalogItemId && resolved?.catalogItemId) {
        catalogItemId = String(resolved.catalogItemId).trim();
      }
      if (!deploymentId && resolved?.deploymentId) {
        deploymentId = String(resolved.deploymentId).trim();
      }
    } catch {}
  }

  if (!appName) {
    appName = String(payload.platformGameId || payload.gameId || '')
      .replace(/^epic-/i, '')
      .trim();
  }

  if (appName && (!namespace || !deploymentId)) {
    try {
      const { metaSummaries } = collectLocalEpicMetadataAndSupport(options);
      const matched = metaSummaries.find(
        (s) => s && s.appName && s.appName.toLowerCase() === appName.toLowerCase()
      );
      if (matched) {
        if (!namespace && matched.namespace) namespace = String(matched.namespace).trim();
        if (!catalogItemId && matched.catalogItemId) {
          catalogItemId = String(matched.catalogItemId).trim();
        }
        if (!deploymentId && matched.deploymentId) {
          deploymentId = String(matched.deploymentId).trim();
        }
      }
    } catch {}
  }

  const activeStoreSync = options.storeSync || getStoreSync();
  const savedTokens =
    options.savedTokens ||
    (activeStoreSync && typeof activeStoreSync.loadSavedTokens === 'function'
      ? activeStoreSync.loadSavedTokens()
      : {});

  const legAuth = await ensureLegendaryConfigAndAuth(options).catch(() => null);

  let accessToken =
    legAuth?.accessToken ||
    savedTokens?.epic?.access_token ||
    options.epicAccessToken ||
    null;
  let refreshToken =
    legAuth?.refreshToken ||
    savedTokens?.epic?.refresh_token ||
    options.epicRefreshToken ||
    null;
  let accountId =
    legAuth?.accountId ||
    savedTokens?.epic?.account_id ||
    options.epicAccountId ||
    '';
  let displayName =
    legAuth?.displayName ||
    savedTokens?.epic?.displayName ||
    options.epicDisplayName ||
    '';

  if (
    (!accessToken || !accountId || !displayName || !refreshToken) &&
    legAuth?.legendaryConfigPath
  ) {
    const userJsonFile = path.join(legAuth.legendaryConfigPath, 'user.json');
    if (fs.existsSync(userJsonFile)) {
      try {
        const parsedUser = JSON.parse(fs.readFileSync(userJsonFile, 'utf8'));
        accessToken = accessToken || parsedUser?.access_token || null;
        refreshToken = refreshToken || parsedUser?.refresh_token || null;
        accountId = accountId || parsedUser?.account_id || parsedUser?.in_app_id || '';
        displayName = displayName || parsedUser?.displayName || '';
      } catch {}
    }
  }

  if (!displayName) {
    displayName = accountId || 'Player';
  }

  let exchangeCode = null;
  if (options.mockEpicExchangeCode) {
    exchangeCode = String(options.mockEpicExchangeCode).trim();
  } else if (accessToken && !options.skipNetwork) {
    const requestExchange = (/** @type {string} */ token) =>
      performJsonHttpRequest(
        'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/exchange',
        {
          method: 'GET',
          timeoutMs: 3500,
          headers: {
            Authorization: `bearer ${token}`,
            Accept: 'application/json',
            'User-Agent':
              'UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit',
          },
        },
        options.fetchFn
      );

    try {
      let res = await requestExchange(accessToken);
      if (!res.ok && (res.status === 401 || res.status === 403 || res.status === 400)) {
        const renewFn =
          options.renewEpicTokensFn ||
          (activeStoreSync && typeof activeStoreSync.renewEpicTokens === 'function'
            ? activeStoreSync.renewEpicTokens
            : null);
        let refreshedToken = null;
        if (refreshToken && typeof renewFn === 'function') {
          try {
            const renewed = await renewFn(refreshToken);
            if (renewed?.access_token) {
              refreshedToken = renewed.access_token;
              if (activeStoreSync && typeof activeStoreSync.saveTokens === 'function') {
                try {
                  activeStoreSync.saveTokens(
                    'epic',
                    {
                      ...(savedTokens?.epic || {}),
                      ...renewed,
                      account_id: renewed.account_id || accountId,
                      displayName: renewed.displayName || displayName,
                    },
                    options
                  );
                } catch {}
              }
            }
          } catch {}
        }
        if (!refreshedToken) {
          const forcedAuth = await ensureLegendaryConfigAndAuth({
            ...options,
            forceTokenRefresh: true,
          }).catch(() => null);
          if (forcedAuth?.accessToken && forcedAuth.accessToken !== accessToken) {
            refreshedToken = forcedAuth.accessToken;
          }
        }
        if (refreshedToken) {
          accessToken = refreshedToken;
          res = await requestExchange(accessToken);
        }
      }
      if (res.ok && res.data && res.data.code) {
        exchangeCode = String(res.data.code).trim();
      }
    } catch {}
  }

  const { epicLocale } = resolveHostLocaleInfo(options);
  const resolvedEpicLocale = epicLocale || 'en';

  const authenticated = Boolean(exchangeCode);
  /** @type {string[]} */
  let epicArgs = [];
  if (authenticated) {
    epicArgs = [
      '-AUTH_LOGIN=unused',
      `-AUTH_PASSWORD=${exchangeCode}`,
      '-AUTH_TYPE=exchangecode',
      ...(appName ? [`-epicapp=${appName}`] : []),
      '-epicenv=Prod',
      '-EpicPortal',
      `-epicusername=${displayName || 'Player'}`,
      `-epicuserid=${accountId || ''}`,
      `-epiclocale=${resolvedEpicLocale}`,
      ...(namespace ? [`-epicsandboxid=${namespace}`] : []),
      ...(deploymentId ? [`-epicdeploymentid=${deploymentId}`] : []),
    ];
  } else if (appName) {
    epicArgs = [
      `-epicapp=${appName}`,
      '-epicenv=Prod',
      '-EpicPortal',
      `-epicusername=${displayName || 'Player'}`,
      `-epicuserid=${accountId || ''}`,
      `-epiclocale=${resolvedEpicLocale}`,
      ...(namespace ? [`-epicsandboxid=${namespace}`] : []),
      ...(deploymentId ? [`-epicdeploymentid=${deploymentId}`] : []),
    ];
  }

  return {
    args: epicArgs,
    authenticated,
    appName: appName || '',
    namespace: namespace || '',
    catalogItemId: catalogItemId || '',
    deploymentId: deploymentId || '',
    accountId: accountId || '',
    displayName: displayName || 'Player',
    exchangeCode: exchangeCode || null,
  };
}

/**
 * Discover native host Epic Games Launcher client (`EpicGamesLauncher.exe` on Windows,
 * `Epic Games Launcher.app` on macOS) while respecting isolated test overrides.
 */
function resolveEpicClientBinaryPath(/** @type {any} */ options = {}) {
  const targetPlatform = options.platform || process.platform;
  const isTestEnv = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');

  if (options.epicClientBinaryPath !== undefined && options.epicClientBinaryPath !== null) {
    const explicitPath = String(options.epicClientBinaryPath).trim();
    if (!explicitPath) return null;
    return fs.existsSync(explicitPath) ? explicitPath : null;
  }

  const allowSystem =
    options.allowSystemEpicAppInTest === true ||
    options.allowSystemStorefrontClientsInTest === true;

  if (targetPlatform === 'win32') {
    const winCandidates = [];
    if (options.customApplicationsDir) {
      winCandidates.push(
        path.join(
          options.customApplicationsDir,
          'Epic Games',
          'Launcher',
          'Portal',
          'Binaries',
          'Win64',
          'EpicGamesLauncher.exe'
        ),
        path.join(
          options.customApplicationsDir,
          'Epic Games',
          'Launcher',
          'Portal',
          'Binaries',
          'Win32',
          'EpicGamesLauncher.exe'
        ),
        path.join(options.customApplicationsDir, 'EpicGamesLauncher.exe')
      );
    }
    if (options.homedir) {
      winCandidates.push(
        path.join(
          options.homedir,
          'Program Files (x86)',
          'Epic Games',
          'Launcher',
          'Portal',
          'Binaries',
          'Win64',
          'EpicGamesLauncher.exe'
        ),
        path.join(
          options.homedir,
          'Program Files (x86)',
          'Epic Games',
          'Launcher',
          'Portal',
          'Binaries',
          'Win32',
          'EpicGamesLauncher.exe'
        ),
        path.join(
          options.homedir,
          'Program Files',
          'Epic Games',
          'Launcher',
          'Portal',
          'Binaries',
          'Win64',
          'EpicGamesLauncher.exe'
        ),
        path.join(
          options.homedir,
          'Program Files',
          'Epic Games',
          'Launcher',
          'Portal',
          'Binaries',
          'Win32',
          'EpicGamesLauncher.exe'
        )
      );
    }
    if (
      !options.customApplicationsDir &&
      (!options.homedir || allowSystem) &&
      (!isTestEnv || allowSystem)
    ) {
      const regEpic = discoverWindowsEpicRegistryPaths(options);
      if (Array.isArray(regEpic.launcherExeCandidates) && regEpic.launcherExeCandidates.length > 0) {
        winCandidates.push(...regEpic.launcherExeCandidates);
      }
      if (process.env['ProgramFiles(x86)']) {
        winCandidates.push(
          path.join(
            process.env['ProgramFiles(x86)'],
            'Epic Games',
            'Launcher',
            'Portal',
            'Binaries',
            'Win64',
            'EpicGamesLauncher.exe'
          ),
          path.join(
            process.env['ProgramFiles(x86)'],
            'Epic Games',
            'Launcher',
            'Portal',
            'Binaries',
            'Win32',
            'EpicGamesLauncher.exe'
          )
        );
      }
      if (process.env.ProgramFiles) {
        winCandidates.push(
          path.join(
            process.env.ProgramFiles,
            'Epic Games',
            'Launcher',
            'Portal',
            'Binaries',
            'Win64',
            'EpicGamesLauncher.exe'
          ),
          path.join(
            process.env.ProgramFiles,
            'Epic Games',
            'Launcher',
            'Portal',
            'Binaries',
            'Win32',
            'EpicGamesLauncher.exe'
          )
        );
      }
      winCandidates.push(
        'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe',
        'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win32\\EpicGamesLauncher.exe',
        'C:\\Program Files\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe'
      );
    }
    for (const c of winCandidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return null;
  }

  if (targetPlatform === 'darwin') {
    const macCandidates = [];
    if (options.customApplicationsDir) {
      macCandidates.push(path.join(options.customApplicationsDir, 'Epic Games Launcher.app'));
    }
    if (options.homedir) {
      macCandidates.push(path.join(options.homedir, 'Applications', 'Epic Games Launcher.app'));
    }
    if (
      !options.customApplicationsDir &&
      (!options.homedir || allowSystem) &&
      (!isTestEnv || allowSystem)
    ) {
      macCandidates.push(
        path.join(os.homedir(), 'Applications', 'Epic Games Launcher.app'),
        '/Applications/Epic Games Launcher.app'
      );
    }
    for (const c of macCandidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return null;
  }

  return null;
}

module.exports = {
  resolveEpicFirstPartyPaths,
  syncEpicFirstPartyLauncher,
  unregisterEpicFirstPartyLauncher,
  isMockOrCorruptedToken,
  isPoisonedStorefrontToken,
  getLegendaryConfigDir,
  sanitizeEpicCandidateRecord,
  ensureLegendaryConfigAndAuth,
  collectLocalEpicMetadataAndSupport,
  resolveEpicAppAndPlatforms,
  performJsonHttpRequest,
  resolveEpicLaunchAuthArguments,
  resolveEpicClientBinaryPath,
};
