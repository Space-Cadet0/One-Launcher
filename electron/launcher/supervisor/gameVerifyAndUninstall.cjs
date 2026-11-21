// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const {
  toHostFilesystemPath,
  atomicWriteFileSync,
  isContainedWithinRoot,
} = require('../securityAndPathUtils.cjs');
const {
  stageWindowsClientlessXboxBridgeDlls,
  restoreWindowsClientlessXboxBridgeDlls,
  prepareXboxBottleEnvironment,
} = require('../wineAndCrossOverManager.cjs');
const {
  parseSteamAcf,
  deriveDefaultScidFromTitleId,
  inspectMicrosoftGameConfig,
  inspectAppxManifest,
} = require('../binaryAndManifestInspectors.cjs');
const {
  normalizePosixUtf8Locale,
  pruneCloudSaveStateForGame,
} = require('../cloudSaveEngine.cjs');
const {
  diagLog,
  getUserDataDir,
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,
  activeSessions,
  evictExecutableDiscoveryCacheForPath,
  invalidateScanCaches,
  toLocalFsPath,
  openExternalUri,
  resolveHostLocaleInfo,
  findLegendaryBinary,
  findGogdlBinary,
  readManagedInstallSentinel,
  hasManagedInstallSentinel,
  loadManagedInstalledGames,
  saveManagedInstalledGames,
  resolvePlatformLaunchConfig,
  getGameLaunchConfigs,
  isSafeToDeleteInstallPath,
  safeRemoveInstallDirectoryAsync,
  safeIsNumericAppId,
} = require('../engineStateRegistry.cjs');
const {
  isWindowsAppsProtectedPath,
  hasXboxClientlessReceipt,
  ensureWindowsXboxAppxRegisteredAsync,
  queryTargetedAppxPackageAsync,
  removeTargetedAppxPackageVerifiedAsync,
} = require('../windowsXboxAppxAndMsixvcOrchestrator.cjs');
const {
  findPrimaryExecutable,
  discoverSteamLocations,
  extractBottleRootFromPath,
  listBottleSubdirectories,
  removeSteamAppFromLibraryFoldersVdf,
  cleanupCrossOverSteamShortcuts,
  detectCompatibilityLayers,
  ensureCompatibilityLayerReady,
} = require('../macNativeInstallerAndCodesign.cjs');
const {
  unregisterEpicFirstPartyLauncher,
  ensureLegendaryConfigAndAuth,
  getLegendaryConfigDir,
  resolveEpicAppAndPlatforms,
} = require('../epicLegendaryAndEosCoordinator.cjs');
const {
  unregisterGogFirstPartyLauncher,
  ensureGogdlAuthConfig,
  clearStaleGogdlManifestCache,
} = require('../gogRegistryAndDirectInstaller.cjs');
const { deleteWineSystemRegKey } = require('../firstPartyRegistration.cjs');
const chainedPublisherLaunchers = /** @type {any} */ (require('../chainedPublisherLaunchers.cjs'));
const {
  CHAINED_PUBLISHER_ECOSYSTEMS,
  discoverHostPublisherLauncher,
  scanHostPublisherInstalledGames,
} = chainedPublisherLaunchers;
const { isGdkStubExecutablePath } = require('../installedGameScanner.cjs');
const { parseSteamEaInstallerDataXml } = require('../../storefronts/steamLocalScanner.cjs');
const { resolveAnyChainedHandoffId } = require('./bottleDisplayAndEnvController.cjs');
const {
  isSafeHostEaGameDirToDelete,
  wineRegistryInstallDirToPosix,
  cleanupBottleEaGameRegistryAndDaemons,
  cleanupWindowsEaGameRegistryAsync,
  isSafeBottleChainedGameDirToDelete,
} = require('./chainedPublisherLauncher.cjs');

async function verifyGameFiles(/** @type {any} */ payload = {}, /** @type {any} */ options = {}) {
  try {
    const { platformId, platformGameId, steamAppId, installPath, title } = payload;
    const targetPlatform = options.platform || process.platform;
    const execFileImpl =
      typeof options.execFileImpl === 'function'
        ? options.execFileImpl
        : typeof options.execFileFn === 'function'
          ? options.execFileFn
          : execFile;
    const canRunCliRepair =
      !options.skipCliRepair &&
      (!isTestEnvironment(options) ||
        typeof options.execFileImpl === 'function' ||
        typeof options.execFileFn === 'function' ||
        Boolean(options.legendaryBinaryPath) ||
        Boolean(options.gogdlBinaryPath) ||
        options.allowCliRepairInTest === true);

    if (installPath) {
      const localInstall = toLocalFsPath(installPath);
      if (!fs.existsSync(localInstall)) {
        return {
          success: false,
          error: `Installation directory not found: ${installPath}`,
        };
      }

      if (platformId === 'epic' && canRunCliRepair) {
        let appName = '';
        try {
          const resolved = resolveEpicAppAndPlatforms(payload, options);
          if (resolved && resolved.appName) {
            appName = String(resolved.appName).trim();
          }
        } catch {}
        if (!appName) {
          appName = String(payload.appName || platformGameId || payload.gameId || '')
            .replace(/^epic[-_]/i, '')
            .trim();
        }
        const legendaryBin =
          options.legendaryBinaryPath ||
          findLegendaryBinary(options) ||
          (typeof options.execFileImpl === 'function' || typeof options.execFileFn === 'function'
            ? 'legendary'
            : null);
        if (appName && legendaryBin) {
          const legendaryConfigPath = getLegendaryConfigDir(options);
          /** @type {any} */
          const cliRes = await new Promise((resolve) => {
            try {
              execFileImpl(
                legendaryBin,
                ['repair', appName, '-y'],
                {
                  env: {
                    ...process.env,
                    LC_ALL: normalizePosixUtf8Locale(options.env?.LC_ALL ?? process.env.LC_ALL),
                    LANG: normalizePosixUtf8Locale(options.env?.LANG ?? process.env.LANG),
                    ...(legendaryConfigPath ? { LEGENDARY_CONFIG_PATH: legendaryConfigPath } : {}),
                  },
                  timeout: 120000,
                },
                (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
                  const combined = `${stdout || ''}\n${stderr || ''}`;
                  resolve({ err, combined });
                }
              );
            } catch (/** @type {any} */ err) {
              resolve({ err, combined: '' });
            }
          });
          if (!cliRes.err && !/not installed|cannot find/i.test(cliRes.combined)) {
            const discovered = findPrimaryExecutable(localInstall, {
              platform: targetPlatform,
              hintName: title,
            });
            return {
              success: true,
              repairedViaCli: true,
              runner: 'legendary',
              message: `Verified and repaired Epic installation via Legendary (${title || appName}).`,
              installPath: localInstall,
              executablePath: discovered.executablePath,
            };
          }
        }
      } else if (platformId === 'gog' && canRunCliRepair) {
        const cleanId = String(platformGameId || payload.gameId || '')
          .replace(/^gog[-_]/i, '')
          .trim();
        const gogdlBin =
          options.gogdlBinaryPath ||
          findGogdlBinary(options) ||
          (typeof options.execFileImpl === 'function' || typeof options.execFileFn === 'function'
            ? 'gogdl'
            : null);
        let gogAuthPath = options.gogAuthConfigPath || null;
        if (!gogAuthPath && gogdlBin && !isTestEnvironment(options)) {
          try {
            const authRes = await ensureGogdlAuthConfig(options);
            gogAuthPath = authRes?.configPath || authRes?.gogAuthPath || null;
          } catch {}
        }
        if (cleanId && gogdlBin && gogAuthPath) {
          const discoveredForOs = findPrimaryExecutable(localInstall, {
            platform: targetPlatform,
            hintName: title,
          });
          const gogOs =
            targetPlatform === 'win32' || discoveredForOs.isWindowsBinaryOnMac ? 'windows' : 'osx';
          const gogLocale = resolveHostLocaleInfo(options).gogLocale || 'en-US';
          /** @type {any} */
          const cliRes = await new Promise((resolve) => {
            try {
              execFileImpl(
                gogdlBin,
                [
                  '--auth-config-path',
                  gogAuthPath,
                  'repair',
                  cleanId,
                  '--platform',
                  gogOs,
                  '--path',
                  localInstall,
                  '--skip-dlcs',
                  '--lang',
                  gogLocale,
                ],
                {
                  env: { ...process.env, PYTHONUNBUFFERED: '1' },
                  timeout: 120000,
                },
                (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
                  resolve({ err, combined: `${stdout || ''}\n${stderr || ''}` });
                }
              );
            } catch (/** @type {any} */ err) {
              resolve({ err, combined: '' });
            }
          });
          if (!cliRes.err && !/unrecognized arguments|invalid choice/i.test(cliRes.combined)) {
            return {
              success: true,
              repairedViaCli: true,
              runner: 'gogdl',
              message: `Verified and repaired GOG installation via gogdl (${title || cleanId}).`,
              installPath: localInstall,
              executablePath: discoveredForOs.executablePath,
            };
          }
        }
      } else if (platformId === 'xbox') {
        const gameCfg = inspectMicrosoftGameConfig(localInstall);
        const appxCfg = !gameCfg ? inspectAppxManifest(localInstall) : null;
        const resolvedPfn =
          payload.packageFamilyName ||
          gameCfg?.packageFamilyName ||
          appxCfg?.packageFamilyName ||
          '';
        const resolvedIdentityName =
          gameCfg?.identityName || appxCfg?.identityName || '';
        const hasClientlessReceipt = hasXboxClientlessReceipt(localInstall);

        if (targetPlatform === 'win32' && resolvedPfn && !hasClientlessReceipt && canRunCliRepair) {
          const appxCheck = await queryTargetedAppxPackageAsync(
            { identityName: resolvedIdentityName, packageFamilyName: resolvedPfn },
            { ...options, execFileImpl }
          );
          if (appxCheck.found && appxCheck.pkg && appxCheck.pkg.Status) {
            const st = appxCheck.pkg.Status;
            const isBadStringStatus =
              typeof st === 'string' && st.trim() !== '' && !/^(?:ok|normal|healthy|0)$/i.test(st.trim());
            const isBadObjStatus =
              typeof st === 'object' &&
              st !== null &&
              (st.Invalid === true ||
                st.Tampered === true ||
                st.Modified === true ||
                st.LicenseIssue === true ||
                st.DataOffline === true ||
                st.DependencyIssue === true);
            if (isBadStringStatus || isBadObjStatus) {
              return {
                success: false,
                error: `Xbox Appx package ${resolvedPfn} reported unhealthy status (${typeof st === 'string' ? st : JSON.stringify(st)}). Please repair via Xbox App or reinstall.`,
                installPath: localInstall,
              };
            }
          }
        }

        if (gameCfg?.isExternalLauncherStub) {
          return {
            success: false,
            error: `Xbox package at ${localInstall} is an external publisher launcher stub (GDKStubGame.exe) and does not contain game files.`,
            installPath: localInstall,
          };
        }

        const primaryExe =
          (gameCfg?.primaryExecutable
            ? path.join(
                gameCfg.configDir || localInstall,
                gameCfg.primaryExecutable.replace(/\\/g, path.sep)
              )
            : '') ||
          findPrimaryExecutable(localInstall, {
            platform: targetPlatform,
            hintName: title,
            preferWindowsExecutable: true,
          }).executablePath;

        if (!primaryExe || isGdkStubExecutablePath(primaryExe) || !fs.existsSync(primaryExe)) {
          return {
            success: false,
            error: `Primary Xbox game executable not found in ${localInstall}.`,
            installPath: localInstall,
          };
        }

        const bottleRoot = extractBottleRootFromPath(localInstall);
        let repairedWinAppxRegistered = false;
        if (targetPlatform === 'darwin' && bottleRoot && resolvedPfn) {
          try {
            await prepareXboxBottleEnvironment({
              bottlePath: bottleRoot,
              env: {},
              packageFamilyName: resolvedPfn,
              installDir: localInstall,
              executablePath: primaryExe,
              scid: gameCfg?.scid || undefined,
              xboxBridgeDllPath: options.xboxBridgeDllPath,
              gameInputBridgeDllPath: options.gameInputBridgeDllPath,
              xboxAppNotifyBridgeDllPath: options.xboxAppNotifyBridgeDllPath,
            });
          } catch {}
        } else if (targetPlatform === 'win32' && hasClientlessReceipt) {
          try {
            if (options.forceClientlessXboxOnWin32 !== true) {
              const appxRegCheck = await ensureWindowsXboxAppxRegisteredAsync(
                {
                  installDir: localInstall,
                  identityName: resolvedIdentityName,
                  packageFamilyName: resolvedPfn,
                },
                { ...options, execFileImpl }
              );
              if (appxRegCheck.gamingServicesInstalled && appxRegCheck.registered) {
                repairedWinAppxRegistered = true;
                await restoreWindowsClientlessXboxBridgeDlls(localInstall);
              }
            }
            if (!repairedWinAppxRegistered) {
              await stageWindowsClientlessXboxBridgeDlls({
                installDir: localInstall,
                executablePath: primaryExe,
                xboxBridgeDllPath: options.xboxBridgeDllPath,
                gameInputBridgeDllPath: options.gameInputBridgeDllPath,
              });
            }
          } catch {}
        }

        return {
          success: true,
          runner:
            targetPlatform === 'darwin'
              ? 'xbox_xgr'
              : hasClientlessReceipt && !repairedWinAppxRegistered
                ? 'xbox_direct'
                : 'xbox',
          message: `Verified Xbox GDK installation integrity (${path.basename(primaryExe)} ready).`,
          installPath: localInstall,
          executablePath: primaryExe,
        };
      }

      const discovered = findPrimaryExecutable(localInstall, {
        platform: targetPlatform,
        hintName: title,
      });

      if (platformId === 'steam' && (steamAppId || platformGameId)) {
        await openExternalUri(`steam://validate/${steamAppId || platformGameId}`, options);
      }

      return {
        success: true,
        message: discovered.executablePath
          ? `Verified installation integrity (${path.basename(discovered.executablePath)} ready).`
          : 'Verified installation directory exists.',
        installPath: localInstall,
        executablePath: discovered.executablePath,
      };
    }

    if (platformId === 'steam' && (steamAppId || platformGameId)) {
      await openExternalUri(`steam://validate/${steamAppId || platformGameId}`, options);
      return {
        success: true,
        message: 'Triggered Steam file integrity validation.',
      };
    }

    return {
      success: false,
      error: 'No installation path available to verify.',
    };
  } catch (/** @type {any} */ err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

async function uninstallGame(/** @type {any} */ payload = {}, /** @type {any} */ options = {}) {
  try {
    const {
      gameId,
      title,
      platformId,
      platformGameId,
      steamAppId,
      installPath,
      allowDeleteFiles,
    } = payload;
    const platform = options.platform || process.platform;
    const userDataDir = getUserDataDir(options.userDataDir);

    const cleanId = String(platformGameId || gameId || '')
      .replace(/^(epic|gog|steam|xbox|ubisoft|ea|bnet|rockstar|riot)[-_:]/i, '')
      .trim();
    const appId = String(steamAppId || platformGameId || cleanId)
      .replace(/^steam[-_]/i, '')
      .trim();
    let localInstall = installPath ? toLocalFsPath(installPath) : '';
    const isBottlePath = (/** @type {any} */ p) =>
      /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(String(p || ''));

    const managed = loadManagedInstalledGames(userDataDir);
    const matchedManagedRecord = managed.find(
      (/** @type {any} */ r) =>
        (r.platformId === platformId &&
          ((platformGameId &&
            r.platformGameId &&
            String(r.platformGameId) === String(platformGameId)) ||
            (cleanId && r.platformGameId && String(r.platformGameId) === cleanId) ||
            (appId && r.platformGameId && String(r.platformGameId) === appId))) ||
        (installPath && r.installPath === installPath) ||
        (localInstall && r.installPath && path.resolve(r.installPath) === path.resolve(localInstall))
    );
    if (!localInstall && matchedManagedRecord?.installPath) {
      localInstall = toLocalFsPath(matchedManagedRecord.installPath);
    }
    const normUninstallPlatformId = String(platformId || '')
      .trim()
      .toLowerCase();
    const standalonePublisherPlatform = ['ubisoft', 'ea', 'bnet', 'rockstar', 'riot'].includes(
      normUninstallPlatformId
    )
      ? normUninstallPlatformId
      : '';
    /** @type {any} */
    let eaInstallerXmlMeta = null;
    if (localInstall && fs.existsSync(localInstall)) {
      const candidateEaInstallerXml = path.join(localInstall, '__Installer', 'installerdata.xml');
      if (fs.existsSync(candidateEaInstallerXml)) {
        try {
          const rawXml = fs.readFileSync(candidateEaInstallerXml, 'utf8');
          const parsedSteamXml = /** @type {any} */ (parseSteamEaInstallerDataXml(rawXml));
          const parsedPublisherXml =
            typeof chainedPublisherLaunchers.parseEaInstallerDataXml === 'function'
              ? chainedPublisherLaunchers.parseEaInstallerDataXml(rawXml, localInstall)
              : null;
          const mergedContentIds = Array.from(
            new Set([
              ...(Array.isArray(parsedSteamXml?.contentIds) ? parsedSteamXml.contentIds : []),
              ...(parsedSteamXml?.contentId ? [parsedSteamXml.contentId] : []),
              ...(Array.isArray(parsedPublisherXml?.contentIds) ? parsedPublisherXml.contentIds : []),
              ...(parsedPublisherXml?.contentId ? [parsedPublisherXml.contentId] : []),
            ])
          ).filter(Boolean);
          if (parsedSteamXml || (parsedPublisherXml && mergedContentIds.length > 0)) {
            eaInstallerXmlMeta = {
              ...(parsedSteamXml || {}),
              isEaChained: true,
              isEaInstaller: true,
              contentId: mergedContentIds[0] || undefined,
              contentIds: mergedContentIds,
            };
          }
        } catch {}
      }
    }
    const chainedHandoff =
      resolveAnyChainedHandoffId(
        payload.chainedLauncherHandoff ||
          payload.chainedRequiresLauncherHandoff ||
          payload.externalStorefrontHandoff ||
          matchedManagedRecord?.chainedLauncherHandoff ||
          matchedManagedRecord?.chainedRequiresLauncherHandoff ||
          matchedManagedRecord?.externalStorefrontHandoff ||
          standalonePublisherPlatform
      ) || (eaInstallerXmlMeta?.isEaInstaller ? 'ea' : '');
    const externalInstallId = String(
      payload.chainedExternalInstallId ||
        matchedManagedRecord?.chainedExternalInstallId ||
        eaInstallerXmlMeta?.contentIds?.[0] ||
        ''
    ).trim();
    let gogSplitParentDir = '';

    if (platformId === 'epic') {
      const resolvedAppNames = new Set();
      const resolvedCatalogItemIds = new Set();
      let resolvedInstallFromLeg = '';
      if (cleanId) {
        resolvedAppNames.add(cleanId);
        resolvedCatalogItemIds.add(cleanId);
      }
      if (platformGameId) {
        resolvedAppNames.add(String(platformGameId));
      }

      const homedir = options.homedir || os.homedir();
      const legendaryDirs = [
        path.join(userDataDir, 'legendaryConfig', 'legendary'),
        path.join(homedir, 'Library/Application Support/heroic/legendaryConfig/legendary'),
        path.join(homedir, '.config/legendary'),
        path.join(homedir, 'AppData/Roaming/heroic/legendaryConfig/legendary'),
      ];

      for (const legDir of legendaryDirs) {
        const assetsFile = path.join(legDir, 'assets.json');
        if (fs.existsSync(assetsFile)) {
          try {
            const rawAssets = JSON.parse(fs.readFileSync(assetsFile, 'utf8'));
            const lists = Array.isArray(rawAssets)
              ? [rawAssets]
              : rawAssets && typeof rawAssets === 'object'
                ? Object.values(rawAssets).filter(Array.isArray)
                : [];
            for (const list of lists) {
              for (const asset of list) {
                if (!asset || typeof asset !== 'object') continue;
                const aName = String(asset.app_name || asset.appName || '').trim();
                const cId = String(asset.catalog_item_id || asset.catalogItemId || '').trim();
                if (
                  (cleanId &&
                    (aName.toLowerCase() === cleanId.toLowerCase() ||
                      cId.toLowerCase() === cleanId.toLowerCase())) ||
                  (aName && resolvedAppNames.has(aName)) ||
                  (cId && resolvedCatalogItemIds.has(cId))
                ) {
                  if (aName) resolvedAppNames.add(aName);
                  if (cId) resolvedCatalogItemIds.add(cId);
                }
              }
            }
          } catch {}
        }

        const instFile = path.join(legDir, 'installed.json');
        if (fs.existsSync(instFile)) {
          const isManagedLegFile =
            path.resolve(instFile) ===
            path.resolve(path.join(userDataDir, 'legendaryConfig', 'legendary', 'installed.json'));
          try {
            const rawLeg = JSON.parse(fs.readFileSync(instFile, 'utf8'));
            if (rawLeg && typeof rawLeg === 'object' && !Array.isArray(rawLeg)) {
              let changed = false;
              for (const [k, val] of Object.entries(rawLeg)) {
                const v = /** @type {any} */ (val);
                const vApp = String(v?.app_name || v?.appName || k || '').trim();
                const vCat = String(v?.catalog_item_id || v?.catalogItemId || '').trim();
                const vInstallRaw = v?.install_path || v?.installPath || '';
                const vInstallLocal = vInstallRaw ? toLocalFsPath(vInstallRaw) : '';
                const matchesPath = Boolean(
                  (installPath && vInstallRaw === installPath) ||
                    (localInstall &&
                      vInstallLocal &&
                      path.resolve(vInstallLocal) === path.resolve(localInstall))
                );
                const matchesIds = Boolean(
                  resolvedAppNames.has(k) ||
                    resolvedAppNames.has(vApp) ||
                    (cleanId &&
                      (k.toLowerCase() === cleanId.toLowerCase() ||
                        vApp.toLowerCase() === cleanId.toLowerCase() ||
                        vCat.toLowerCase() === cleanId.toLowerCase())) ||
                    (vCat && resolvedCatalogItemIds.has(vCat))
                );
                if (matchesIds || matchesPath) {
                  if (k) resolvedAppNames.add(k);
                  if (vApp) resolvedAppNames.add(vApp);
                  if (vCat) resolvedCatalogItemIds.add(vCat);
                  if (!resolvedInstallFromLeg && vInstallLocal) {
                    resolvedInstallFromLeg = vInstallLocal;
                  }
                  if (isManagedLegFile) {
                    delete rawLeg[k];
                    changed = true;
                  }
                }
              }
              if (isManagedLegFile && changed) {
                atomicWriteFileSync(instFile, JSON.stringify(rawLeg, null, 2));
              }
            }
          } catch (legErr) {
            if (isManagedLegFile) {
              diagLog.warn('uninstallGame.legendaryInstalledCleanup', legErr, {
                gameId,
                platformGameId,
              });
            }
          }
        }
      }

      try {
        unregisterEpicFirstPartyLauncher(
          cleanId || platformGameId,
          installPath || resolvedInstallFromLeg,
          {
            ...options,
            catalogItemId: cleanId,
            resolvedAppNames: Array.from(resolvedAppNames),
            resolvedCatalogItemIds: Array.from(resolvedCatalogItemIds),
          }
        );
      } catch {}
    } else if (platformId === 'gog') {
      if (localInstall) {
        try {
          const parentCandidate = path.dirname(localInstall);
          if (
            parentCandidate &&
            path.resolve(parentCandidate) !== path.resolve(localInstall) &&
            fs.existsSync(parentCandidate) &&
            isSafeToDeleteInstallPath(parentCandidate, options) &&
            !/^(?:gog|gog\.com|gog galaxy|gog games|games|onelauncher|onelauncher games|applications|bottles|drive_c)$/i.test(
              path.basename(parentCandidate).trim()
            )
          ) {
            const parentSentinel = readManagedInstallSentinel(parentCandidate);
            const sentinelGameId = String(parentSentinel?.gameId || '')
              .replace(/^gog[-_]/i, '')
              .trim();
            const matchesSentinel =
              String(parentSentinel?.store || '').toLowerCase() === 'gog' &&
              Boolean(
                (cleanId && sentinelGameId === cleanId) ||
                  (platformGameId &&
                    String(parentSentinel?.gameId || '') === String(platformGameId))
              );
            const matchesGogInfo = Boolean(
              cleanId &&
                (fs.existsSync(path.join(parentCandidate, `goggame-${cleanId}.info`)) ||
                  fs.existsSync(path.join(parentCandidate, `.goggame-${cleanId}.info`)))
            );
            if (matchesSentinel || matchesGogInfo) {
              gogSplitParentDir = parentCandidate;
            }
          }
        } catch {}
      }

      try {
        const unregRes = unregisterGogFirstPartyLauncher(
          cleanId || platformGameId,
          installPath,
          options
        );
        if (unregRes && unregRes.registryDeletePromise) {
          await unregRes.registryDeletePromise.catch(() => {});
        }
        if (gogSplitParentDir) {
          const unregParentRes = unregisterGogFirstPartyLauncher(
            cleanId || platformGameId,
            gogSplitParentDir,
            options
          );
          if (unregParentRes && unregParentRes.registryDeletePromise) {
            await unregParentRes.registryDeletePromise.catch(() => {});
          }
        }
      } catch {}
      try {
        clearStaleGogdlManifestCache(cleanId || platformGameId, options);
      } catch {}
    } else if (platformId === 'steam' && appId) {
      let isBottleInstall = isBottlePath(localInstall);
      let removedLocalSteamFiles = false;
      let acfName = '';
      const discoveredBottleDirs = new Set();
      const hasValidNumericSteamId = safeIsNumericAppId(appId);

      if (isBottleInstall) {
        const br = extractBottleRootFromPath(localInstall);
        if (br) discoveredBottleDirs.add(br);
      }

      const candidateSteamappsDirs = new Set();
      try {
        const { steamappsDirs } = discoverSteamLocations(options);
        for (const d of steamappsDirs) {
          if (d) candidateSteamappsDirs.add(d);
        }
      } catch {}

      if (localInstall && /steamapps[\\/]common[\\/]/i.test(localInstall)) {
        candidateSteamappsDirs.add(path.resolve(localInstall, '..', '..'));
      }

      try {
        const layers = detectCompatibilityLayers(options);
        for (const layer of layers) {
          if (layer && layer.bottlesDir && fs.existsSync(layer.bottlesDir)) {
            for (const bottle of listBottleSubdirectories(layer.bottlesDir)) {
              const bPath = path.join(layer.bottlesDir, bottle);
              discoveredBottleDirs.add(bPath);
              const s1 = path.join(bPath, 'drive_c/Program Files (x86)/Steam/steamapps');
              const s2 = path.join(bPath, 'drive_c/Program Files/Steam/steamapps');
              if (fs.existsSync(s1)) candidateSteamappsDirs.add(s1);
              if (fs.existsSync(s2)) candidateSteamappsDirs.add(s2);
            }
          }
        }
      } catch {}

      if (hasValidNumericSteamId) {
        for (const steamappsDir of candidateSteamappsDirs) {
          if (!steamappsDir || !fs.existsSync(steamappsDir)) continue;
          const acfPath = path.join(steamappsDir, `appmanifest_${appId}.acf`);
          if (fs.existsSync(acfPath)) {
            /** @type {any} */
            let parsedAcf = null;
            try {
              parsedAcf = parseSteamAcf(fs.readFileSync(acfPath, 'utf8'));
            } catch {}
            if (parsedAcf && parsedAcf.name && !acfName) {
              acfName = parsedAcf.name;
            }
            if (isBottlePath(steamappsDir)) {
              isBottleInstall = true;
              const br = extractBottleRootFromPath(steamappsDir);
              if (br) discoveredBottleDirs.add(br);
            }
            try {
              fs.rmSync(acfPath, { force: true });
              removedLocalSteamFiles = true;
            } catch {}

            const installdir =
              parsedAcf && parsedAcf.installdir ? String(parsedAcf.installdir) : '';
            if (
              installdir &&
              !/[\\/\x00]/.test(installdir) &&
              installdir !== '.' &&
              installdir !== '..' &&
              !installdir.includes('..')
            ) {
              const acfCommonDir = path.join(steamappsDir, 'common', installdir);
              /** @type {fs.Stats | null} */
              let commonLstat = null;
              try {
                commonLstat = fs.lstatSync(acfCommonDir);
              } catch {}
              if (commonLstat && commonLstat.isSymbolicLink()) {
                try {
                  fs.unlinkSync(acfCommonDir);
                } catch {}
              } else if (
                commonLstat &&
                fs.existsSync(acfCommonDir) &&
                isSafeToDeleteInstallPath(acfCommonDir, options)
              ) {
                try {
                  await safeRemoveInstallDirectoryAsync(acfCommonDir, {
                    ...options,
                    skipSafetyAssertion: true,
                  });
                } catch {}
              }
            }

            const auxPaths = [
              path.join(steamappsDir, 'downloading', appId),
              path.join(steamappsDir, 'temp', appId),
              path.join(steamappsDir, 'shadercache', appId),
              path.join(steamappsDir, 'workshop', 'content', appId),
              path.join(steamappsDir, 'workshop', `appworkshop_${appId}.acf`),
            ];
            for (const aux of auxPaths) {
              if (fs.existsSync(aux)) {
                try {
                  fs.rmSync(aux, { recursive: true, force: true });
                } catch {}
              }
            }

            removeSteamAppFromLibraryFoldersVdf(steamappsDir, appId);
          }
        }
      }

      if (
        localInstall &&
        fs.existsSync(localInstall) &&
        isSafeToDeleteInstallPath(localInstall, options)
      ) {
        if (isBottlePath(localInstall)) {
          isBottleInstall = true;
        }
        try {
          await safeRemoveInstallDirectoryAsync(localInstall, {
            ...options,
            skipSafetyAssertion: true,
          });
          removedLocalSteamFiles = true;
        } catch {}
      }

      if ((isBottleInstall || platform === 'darwin') && hasValidNumericSteamId) {
        try {
          cleanupCrossOverSteamShortcuts(
            appId,
            title || acfName,
            Array.from(discoveredBottleDirs),
            options
          );
        } catch {}
      }

      if (!isBottleInstall && !removedLocalSteamFiles && !allowDeleteFiles && hasValidNumericSteamId) {
        await openExternalUri(`steam://uninstall/${appId}`, options);
      }
    } else if (platformId === 'xbox') {
      const hasClientlessReceipt = hasXboxClientlessReceipt(localInstall);
      const isClientlessOrBottle =
        platform === 'darwin' || hasClientlessReceipt || isBottlePath(localInstall);

      let resolvedPfn = String(
        payload.packageFamilyName || matchedManagedRecord?.packageFamilyName || ''
      ).trim();
      let resolvedIdentityName = '';
      if (localInstall && fs.existsSync(localInstall)) {
        const gameCfg = inspectMicrosoftGameConfig(localInstall);
        const appxCfg = !gameCfg ? inspectAppxManifest(localInstall) : null;
        if (!resolvedPfn) {
          resolvedPfn = String(
            gameCfg?.packageFamilyName || appxCfg?.packageFamilyName || ''
          ).trim();
        }
        resolvedIdentityName = String(
          gameCfg?.identityName || appxCfg?.identityName || ''
        ).trim();
      }

      if (platform === 'win32' && !isClientlessOrBottle && resolvedPfn) {
        const appxRemoveRes = await removeTargetedAppxPackageVerifiedAsync(
          { identityName: resolvedIdentityName, packageFamilyName: resolvedPfn },
          options
        );
        if (!appxRemoveRes.removed && appxRemoveRes.stillInstalled && !chainedHandoff) {
          diagLog.warn('uninstallGame.xboxRemoveAppxPackageStillInstalled', appxRemoveRes.error, {
            gameId,
            resolvedPfn,
          });
          return {
            success: false,
            error:
              appxRemoveRes.error ||
              `Failed to remove Xbox Appx package ${resolvedPfn}. The package is still installed.`,
            installPath,
          };
        }
      } else if (
        isClientlessOrBottle &&
        !chainedHandoff &&
        localInstall &&
        fs.existsSync(localInstall) &&
        isSafeToDeleteInstallPath(localInstall, options)
      ) {
        try {
          await safeRemoveInstallDirectoryAsync(localInstall, {
            ...options,
            skipSafetyAssertion: true,
          });
        } catch (rmErr) {
          diagLog.warn('uninstallGame.xboxRemoveDir', rmErr, { localInstall });
        }
      }
    }

    // Chained Publisher Launcher cleanup (macOS Wine bottle + Windows native)
    let chainedBottleRoot = '';
    if (chainedHandoff) {
      if (platform === 'darwin' || isBottlePath(localInstall)) {
        chainedBottleRoot = localInstall ? extractBottleRootFromPath(localInstall) : '';
        if (!chainedBottleRoot && matchedManagedRecord?.wineBottle) {
          try {
            const layers = detectCompatibilityLayers(options);
            for (const layer of layers) {
              if (!layer?.bottlesDir || !fs.existsSync(layer.bottlesDir)) continue;
              const candidateBottle = path.join(
                layer.bottlesDir,
                String(matchedManagedRecord.wineBottle)
              );
              if (fs.existsSync(candidateBottle)) {
                chainedBottleRoot = candidateBottle;
                break;
              }
            }
          } catch {}
        }

        if (allowDeleteFiles !== false) {
          if (
            chainedBottleRoot &&
            localInstall &&
            fs.existsSync(localInstall) &&
            isSafeBottleChainedGameDirToDelete(chainedBottleRoot, localInstall)
          ) {
            try {
              await safeRemoveInstallDirectoryAsync(localInstall, {
                ...options,
                skipSafetyAssertion: true,
              });
            } catch (rmBottleGameErr) {
              diagLog.warn('uninstallGame.chainedBottleRemoveDir', rmBottleGameErr, {
                localInstall,
                chainedBottleRoot,
              });
            }
          } else if (
            !isBottlePath(localInstall) &&
            localInstall &&
            (localInstall.includes('OneLauncher') || localInstall.includes('one-launcher')) &&
            fs.existsSync(localInstall) &&
            isSafeToDeleteInstallPath(localInstall, options)
          ) {
            try {
              await safeRemoveInstallDirectoryAsync(localInstall, {
                ...options,
                skipSafetyAssertion: true,
              });
            } catch {}
          }
        }

        if (
          chainedBottleRoot &&
          typeof chainedPublisherLaunchers.stripPublisherUninstallKeysFromSystemReg === 'function'
        ) {
          try {
            chainedPublisherLaunchers.stripPublisherUninstallKeysFromSystemReg(
              chainedBottleRoot,
              localInstall,
              chainedHandoff
            );
          } catch (stripRegErr) {
            diagLog.warn('uninstallGame.stripPublisherUninstallKeysFromSystemReg', stripRegErr, {
              chainedBottleRoot,
              chainedHandoff,
            });
          }
        }

        if (chainedBottleRoot && chainedHandoff === 'ubisoft') {
          if (externalInstallId && /^[A-Za-z0-9_-]+$/.test(externalInstallId)) {
            try {
              deleteWineSystemRegKey(
                chainedBottleRoot,
                `Software\\Wow6432Node\\Ubisoft\\Launcher\\Installs\\${externalInstallId}`,
                options
              );
              deleteWineSystemRegKey(
                chainedBottleRoot,
                `Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Uplay Install ${externalInstallId}`,
                options
              );
            } catch (regCleanErr) {
              diagLog.warn('uninstallGame.chainedUbisoftRegCleanup', regCleanErr, {
                chainedBottleRoot,
                externalInstallId,
              });
            }
          }
        } else if (chainedBottleRoot && chainedHandoff === 'ea') {
          cleanupBottleEaGameRegistryAndDaemons(
            chainedBottleRoot,
            localInstall,
            {
              externalInstallId,
              eaInstallerXmlMeta,
              epicPartnerRegistryPath:
                payload.epicPartnerRegistryPath || matchedManagedRecord?.epicPartnerRegistryPath,
            },
            options
          );
        } else if (
          chainedBottleRoot &&
          localInstall &&
          (chainedHandoff === 'bnet' || chainedHandoff === 'rockstar')
        ) {
          // Fallback `system.reg` Uninstall / Rockstar Installs key cleanup matching `localInstall`
          const sysRegFile = path.join(chainedBottleRoot, 'system.reg');
          if (fs.existsSync(sysRegFile)) {
            try {
              const resolvedLocalTarget = path.resolve(localInstall);
              const regLines = fs.readFileSync(sysRegFile, 'utf8').split(/\r?\n/);
              /** @type {Set<string>} */
              const subkeysToDelete = new Set();
              let curSectionKey = '';
              /** @type {string[]} */
              let curSectionDirs = [];
              const flushBottlePubSection = () => {
                if (!curSectionKey || curSectionDirs.length === 0) return;
                const keyLower = curSectionKey.toLowerCase();
                const isUninstallOrRockstarSubkey =
                  /^software\\(?:wow6432node\\)?microsoft\\windows\\currentversion\\uninstall\\[^\\]+$/.test(
                    keyLower
                  ) ||
                  /^software\\(?:wow6432node\\)?rockstar games\\[^\\]+$/.test(keyLower);
                if (!isUninstallOrRockstarSubkey) return;
                if (/\\(?:rockstar games\\launcher|social club)(?:\\|$)/i.test(keyLower)) return;
                for (const rawRegDir of curSectionDirs) {
                  const candidatePosix = wineRegistryInstallDirToPosix(chainedBottleRoot, rawRegDir);
                  if (candidatePosix && candidatePosix === resolvedLocalTarget) {
                    subkeysToDelete.add(curSectionKey);
                    break;
                  }
                }
              };
              for (const line of regLines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('[') && trimmed.includes(']')) {
                  flushBottlePubSection();
                  curSectionKey = trimmed.slice(1, trimmed.indexOf(']')).replace(/\\\\+/g, '\\');
                  curSectionDirs = [];
                  continue;
                }
                if (!curSectionKey) continue;
                const dirMatch = trimmed.match(
                  /^"(?:InstallLocation|InstallFolder|Install Dir)"\s*=\s*"((?:[^"\\]|\\.)*)"/i
                );
                if (dirMatch && dirMatch[1]) {
                  curSectionDirs.push(dirMatch[1]);
                }
              }
              flushBottlePubSection();
              for (const subkey of subkeysToDelete) {
                try {
                  deleteWineSystemRegKey(chainedBottleRoot, subkey, options);
                } catch {}
              }
            } catch {}
          }
        }
      } else if (platform === 'win32') {
        const hadWinLocalInstallOnDisk = Boolean(localInstall && fs.existsSync(localInstall));
        const execFileImpl = options.execFileImpl || options.execFileFn || execFile;
        const spawnImpl = options.spawnImpl || options.spawnFn || spawn;
        const canQueryWinReg = !isTestEnvironment(options) || execFileImpl !== execFile;

        /**
         * Parse a Windows `UninstallString` / `QuietUninstallString` into `{ exe, args, uri }`.
         * @param {string} rawCmd
         */
        const parseWindowsUninstallCommand = (rawCmd) => {
          const trimmed = String(rawCmd || '').trim();
          if (!trimmed) return null;
          const uriMatch = trimmed.match(/\b(uplay:\/\/uninstall\/[A-Za-z0-9_-]+)/i);
          if (/^uplay:\/\/uninstall\//i.test(trimmed)) {
            return { exe: '', args: /** @type {string[]} */ ([]), uri: trimmed };
          }
          let exe = '';
          let rest = '';
          if (trimmed.startsWith('"')) {
            const endQuote = trimmed.indexOf('"', 1);
            if (endQuote > 1) {
              exe = trimmed.slice(1, endQuote).trim();
              rest = trimmed.slice(endQuote + 1).trim();
            }
          } else {
            const exeMatch = trimmed.match(/^([^\s]+\.exe)(?:\s+(.*))?$/i);
            if (exeMatch) {
              exe = exeMatch[1].trim();
              rest = String(exeMatch[2] || '').trim();
            }
          }
          if (!exe && uriMatch) {
            return { exe: '', args: /** @type {string[]} */ ([]), uri: uriMatch[1] };
          }
          if (!exe) return null;
          /** @type {string[]} */
          const parsedArgs = [];
          const argTokenRe = /"([^"]*)"|([^\s]+)/g;
          let tok;
          while ((tok = argTokenRe.exec(rest)) !== null) {
            parsedArgs.push(tok[1] !== undefined ? tok[1] : tok[2]);
          }
          return { exe, args: parsedArgs, uri: '' };
        };

        let resolvedWinUninstallSpec = null;
        if (canQueryWinReg && (localInstall || externalInstallId)) {
          const normTargetWin = localInstall
            ? toHostFilesystemPath(localInstall)
                .replace(/\//g, '\\')
                .replace(/\\+$/, '')
                .toLowerCase()
            : '';
          /** @type {string[]} */
          const uninstallQueryRoots = [];
          if (externalInstallId && /^[A-Za-z0-9._-]+$/.test(externalInstallId)) {
            if (chainedHandoff === 'ubisoft') {
              uninstallQueryRoots.push(
                `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Uplay Install ${externalInstallId}`,
                `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Uplay Install ${externalInstallId}`
              );
            } else if (chainedHandoff === 'ea') {
              uninstallQueryRoots.push(
                `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${externalInstallId}}`,
                `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${externalInstallId}}`
              );
            } else if (chainedHandoff === 'riot') {
              uninstallQueryRoots.push(
                `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Riot Game ${externalInstallId}.live`,
                `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Riot Game ${externalInstallId}.live`
              );
            } else {
              uninstallQueryRoots.push(
                `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${externalInstallId}`,
                `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${externalInstallId}`,
                `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${externalInstallId}`
              );
            }
          }
          if (normTargetWin && allowDeleteFiles !== true) {
            uninstallQueryRoots.push(
              'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
              'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
              'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
            );
          }

          for (const qKey of uninstallQueryRoots) {
            const isTreeScan = /\\Uninstall$/i.test(qKey);
            const regOut = await new Promise((resolve) => {
              try {
                execFileImpl(
                  'reg.exe',
                  isTreeScan ? ['query', qKey, '/s'] : ['query', qKey],
                  { timeout: 3500, windowsHide: true },
                  (/** @type {any} */ err, /** @type {any} */ stdout) =>
                    resolve(err ? '' : String(stdout || ''))
                );
              } catch {
                resolve('');
              }
            });
            if (!regOut) continue;
            let secKey = '';
            let secInstallLoc = '';
            let secQuietCmd = '';
            let secUninstCmd = '';
            const checkSecMatch = () => {
              const rawChosen = secQuietCmd || secUninstCmd;
              if (!rawChosen) return false;
              if (!isTreeScan && !normTargetWin) {
                resolvedWinUninstallSpec = parseWindowsUninstallCommand(rawChosen);
                return Boolean(resolvedWinUninstallSpec);
              }
              if (normTargetWin && secInstallLoc) {
                const candNorm = toHostFilesystemPath(secInstallLoc)
                  .replace(/\//g, '\\')
                  .replace(/\\+$/, '')
                  .toLowerCase();
                if (candNorm === normTargetWin) {
                  resolvedWinUninstallSpec = parseWindowsUninstallCommand(rawChosen);
                  return Boolean(resolvedWinUninstallSpec);
                }
              }
              return false;
            };
            for (const rawLine of regOut.split(/\r?\n/)) {
              const trimmed = rawLine.trim();
              if (/^HKEY_/i.test(trimmed)) {
                if (secKey && checkSecMatch()) break;
                secKey = trimmed;
                secInstallLoc = '';
                secQuietCmd = '';
                secUninstCmd = '';
                continue;
              }
              if (!secKey) continue;
              const locM = trimmed.match(
                /^(?:InstallLocation|InstallFolder|Install Dir)\s+REG_[A-Z0-9_]+\s+(.+)$/i
              );
              if (locM && locM[1]) secInstallLoc = locM[1].trim();
              const quietM = trimmed.match(/^QuietUninstallString\s+REG_[A-Z0-9_]+\s+(.+)$/i);
              if (quietM && quietM[1]) secQuietCmd = quietM[1].trim();
              const unM = trimmed.match(/^UninstallString\s+REG_[A-Z0-9_]+\s+(.+)$/i);
              if (unM && unM[1]) secUninstCmd = unM[1].trim();
            }
            if (!resolvedWinUninstallSpec && secKey) {
              checkSecMatch();
            }
            if (resolvedWinUninstallSpec) break;
          }
        }

        // Publisher-specific fallback CLI / URI / record uninstallers when registry UninstallString is absent
        if (!resolvedWinUninstallSpec && allowDeleteFiles !== true) {
          const explicitUninstallCmd = String(
            payload.uninstallCommand || matchedManagedRecord?.uninstallCommand || ''
          ).trim();
          if (explicitUninstallCmd) {
            resolvedWinUninstallSpec = parseWindowsUninstallCommand(explicitUninstallCmd);
          }
          if (!resolvedWinUninstallSpec && localInstall && chainedHandoff === 'rockstar') {
            const localUninstExe = path.join(localInstall, 'uninstall.exe');
            if (fs.existsSync(localUninstExe)) {
              resolvedWinUninstallSpec = { exe: localUninstExe, args: [], uri: '' };
            }
          }
        }
        if (!resolvedWinUninstallSpec && allowDeleteFiles !== true) {
          const safeExtId =
            externalInstallId && /^[A-Za-z0-9._-]+$/.test(externalInstallId)
              ? externalInstallId
              : '';
          if (chainedHandoff === 'ubisoft' && safeExtId) {
            resolvedWinUninstallSpec = {
              exe: '',
              args: [],
              uri: `uplay://uninstall/${safeExtId}`,
            };
          } else if (
            (chainedHandoff === 'bnet' ||
              chainedHandoff === 'rockstar' ||
              chainedHandoff === 'riot') &&
            safeExtId
          ) {
            const hostPub = discoverHostPublisherLauncher(chainedHandoff, {
              ...options,
              platform: 'win32',
            });
            if (hostPub?.installed && hostPub.binaryPath) {
              if (chainedHandoff === 'bnet') {
                resolvedWinUninstallSpec = {
                  exe: hostPub.binaryPath,
                  args: [`--exec=uninstall ${safeExtId}`],
                  uri: '',
                };
              } else if (chainedHandoff === 'rockstar') {
                resolvedWinUninstallSpec = {
                  exe: hostPub.binaryPath,
                  args: ['-enableFullMode', `-uninstall=${safeExtId}`],
                  uri: '',
                };
              } else if (chainedHandoff === 'riot') {
                resolvedWinUninstallSpec = {
                  exe: hostPub.binaryPath,
                  args: [`--uninstall-product=${safeExtId}`, '--uninstall-patchline=live'],
                  uri: '',
                };
              }
            }
          } else if (chainedHandoff === 'ea' && localInstall) {
            const eaCleanupExe = path.join(localInstall, '__Installer', 'Cleanup.exe');
            if (fs.existsSync(eaCleanupExe)) {
              resolvedWinUninstallSpec = {
                exe: eaCleanupExe,
                args: ['uninstall_game', '-autologging'],
                uri: '',
              };
            }
          }
        }

        let invokedWinPublisherUninstaller = false;
        if (resolvedWinUninstallSpec) {
          if (resolvedWinUninstallSpec.uri) {
            await openExternalUri(resolvedWinUninstallSpec.uri, options);
            invokedWinPublisherUninstaller = true;
          } else if (
            resolvedWinUninstallSpec.exe &&
            (typeof options.spawnFn === 'function' ||
              typeof options.spawnImpl === 'function' ||
              fs.existsSync(toHostFilesystemPath(resolvedWinUninstallSpec.exe)) ||
              fs.existsSync(resolvedWinUninstallSpec.exe))
          ) {
            const uninstallTimeoutMs = Math.max(
              50,
              Number(
                options.publisherUninstallTimeoutMs ??
                  (isTestEnvironment(options) ? 2000 : 120_000)
              )
            );
            await new Promise((resolve) => {
              let settled = false;
              const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(undefined);
              };
              const timer = setTimeout(finish, uninstallTimeoutMs);
              if (typeof timer.unref === 'function') timer.unref();
              try {
                const uninstChild = spawnImpl(
                  resolvedWinUninstallSpec.exe,
                  resolvedWinUninstallSpec.args || [],
                  {
                    cwd:
                      localInstall && fs.existsSync(localInstall)
                        ? localInstall
                        : path.dirname(resolvedWinUninstallSpec.exe),
                    windowsHide: false,
                    stdio: 'ignore',
                  }
                );
                invokedWinPublisherUninstaller = true;
                if (uninstChild && typeof uninstChild.once === 'function') {
                  uninstChild.once('exit', finish);
                  uninstChild.once('close', finish);
                  uninstChild.once('error', finish);
                } else {
                  finish();
                }
              } catch {
                finish();
              }
            });
          }
        }

        if (invokedWinPublisherUninstaller && hadWinLocalInstallOnDisk && fs.existsSync(localInstall)) {
          const pollTimeoutMs = Math.max(
            0,
            Number(
              options.publisherUninstallPollTimeoutMs ??
                (isTestEnvironment(options) ? 40 : 15_000)
            )
          );
          const pollIntervalMs = Math.max(
            10,
            Number(options.publisherUninstallPollIntervalMs ?? (isTestEnvironment(options) ? 10 : 500))
          );
          const deadline = Date.now() + pollTimeoutMs;
          while (Date.now() < deadline && fs.existsSync(localInstall)) {
            await new Promise((resolve) => {
              const t = setTimeout(resolve, pollIntervalMs);
              if (typeof t.unref === 'function') t.unref();
            });
          }
          if (fs.existsSync(localInstall)) {
            const pubName =
              CHAINED_PUBLISHER_ECOSYSTEMS[chainedHandoff]?.displayName || 'the publisher launcher';
            return {
              success: false,
              cancelled: true,
              stillInstalled: true,
              error: `Publisher uninstaller did not remove ${localInstall}. Confirm uninstall in ${pubName} and try again.`,
              installPath: localInstall,
            };
          }
        }

        if (chainedHandoff === 'ea' && localInstall) {
          await cleanupWindowsEaGameRegistryAsync(
            localInstall,
            { externalInstallId, eaInstallerXmlMeta },
            options
          );
        }
      }
    }

    // Remove from One Launcher managed records AFTER verified Appx / store removal succeeds
    const filtered = managed.filter((/** @type {any} */ r) => {
      if (r === matchedManagedRecord) return false;
      if (
        gogSplitParentDir &&
        r?.platformId === 'gog' &&
        r?.installPath &&
        path.resolve(toLocalFsPath(r.installPath)) === path.resolve(gogSplitParentDir)
      ) {
        return false;
      }
      return true;
    });
    if (filtered.length !== managed.length) {
      saveManagedInstalledGames(filtered, userDataDir);
    }

    if (localInstall && fs.existsSync(localInstall)) {
      const canDeleteLocal =
        chainedHandoff && isBottlePath(localInstall)
          ? allowDeleteFiles !== false &&
            Boolean(chainedBottleRoot) &&
            isSafeBottleChainedGameDirToDelete(chainedBottleRoot, localInstall)
          : chainedHandoff === 'ea' && platform === 'win32'
            ? allowDeleteFiles !== false &&
              (hasManagedInstallSentinel(localInstall) ||
                /steamapps[\\/]common[\\/]/i.test(localInstall) ||
                isSafeHostEaGameDirToDelete(localInstall, eaInstallerXmlMeta, options))
            : Boolean(allowDeleteFiles) ||
              hasManagedInstallSentinel(localInstall) ||
              Boolean(gogSplitParentDir) ||
              (!chainedHandoff && isBottlePath(localInstall)) ||
              /steamapps[\\/]common[\\/]/i.test(localInstall) ||
              localInstall.includes('OneLauncher') ||
              localInstall.includes('one-launcher');

      if (canDeleteLocal && isSafeToDeleteInstallPath(localInstall, options)) {
        try {
          await safeRemoveInstallDirectoryAsync(localInstall, {
            ...options,
            skipSafetyAssertion: true,
          });
        } catch {}
      }
    }

    if (gogSplitParentDir && fs.existsSync(gogSplitParentDir)) {
      const canDeleteSplitParent =
        Boolean(allowDeleteFiles) ||
        hasManagedInstallSentinel(gogSplitParentDir) ||
        isBottlePath(gogSplitParentDir) ||
        gogSplitParentDir.includes('OneLauncher') ||
        gogSplitParentDir.includes('one-launcher');

      if (canDeleteSplitParent && isSafeToDeleteInstallPath(gogSplitParentDir, options)) {
        try {
          await safeRemoveInstallDirectoryAsync(gogSplitParentDir, {
            ...options,
            skipSafetyAssertion: true,
          });
        } catch {}
      }
    }

    if (localInstall) {
      evictExecutableDiscoveryCacheForPath(localInstall);
    }
    if (gogSplitParentDir) {
      evictExecutableDiscoveryCacheForPath(gogSplitParentDir);
    }

    try {
      pruneCloudSaveStateForGame(
        {
          platformId,
          gameId,
          platformGameId: cleanId || platformGameId,
        },
        userDataDir
      );
    } catch (pruneErr) {
      diagLog.warn('uninstallGame.pruneCloudSaveState', pruneErr, { gameId, platformId });
    }

    invalidateScanCaches();

    return {
      success: true,
      message: `Uninstalled ${title || gameId || platformGameId}`,
      installPath,
    };
  } catch (/** @type {any} */ err) {
    return {
      success: false,
      error: err.message,
    };
  }
}


module.exports = {
  verifyGameFiles,
  uninstallGame,
};
