// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const {
  atomicWriteSecureFileSync,
  isContainedWithinRoot,
  readSafeResponseBuffer,
} = require('../securityAndPathUtils.cjs');
const {
  sanitizeGameInstallSizeBytes,
  parseByteCountOrFormattedSize,
  parseStorageRequirementBytes,
  parseEpicManifestBuffer,
  parseSteamAcf,
} = require('../binaryAndManifestInspectors.cjs');
const {
  getStoreSync,
  getXboxStorefrontModules,
  getUserDataDir,
  MAX_DISCOVERY_CACHE_ENTRIES,
  installInfoSizeCache,
  steamPlatformSupportCache,
  xboxCompatibilityProbeCache,
  setBoundedMapEntry,
  findLegendaryBinary,
  findGogdlBinary,
} = require('../engineStateRegistry.cjs');
const {
  discoverWindowsLocalDrivesAsync,
  hasWindowsGamingServicesInstalled,
  getDefaultInstallDir,
  getDiskSpace,
} = require('../diskAndVolumeInspector.cjs');
const { collectXboxLibraryRoots } = require('../windowsXboxAppxAndMsixvcOrchestrator.cjs');
const macNativeInstallerAndCodesign = /** @type {any} */ (
  require('../macNativeInstallerAndCodesign.cjs')
);
const { discoverSteamLocations } = macNativeInstallerAndCodesign;
const {
  ensureLegendaryConfigAndAuth,
  extractEpicThirdPartyPartnerMetadata,
  refreshLocalLegendaryMetadata,
  resolveEpicAppAndPlatforms,
} = require('../epicLegendaryAndEosCoordinator.cjs');
const {
  ensureGogdlAuthConfig,
  resolveGogDepotSizesDirectHttp,
} = require('../gogRegistryAndDirectInstaller.cjs');
const chainedPublisherLaunchers = /** @type {any} */ (require('../chainedPublisherLaunchers.cjs'));
const {
  CHAINED_PUBLISHER_ECOSYSTEMS,
  normalizeChainedHandoffId,
} = chainedPublisherLaunchers;
const {
  resolveAnyChainedHandoffId,
  validateTrustedExternalLauncherUrl,
  validateSafeGogProductId,
  validateSafeCliIdentifier,
  validateSafeCliPathArg,
  buildValidatedEpicManifestUrl,
} = require('./downloadQueueStore.cjs');

const MAX_EPIC_MANIFEST_BYTES = 32 * 1024 * 1024;

/**
 * Create an `.unref()`ed abort timer so background HTTP probes never stall Node shutdown.
 *
 * @param {AbortController} controller
 * @param {number} timeoutMs
 * @returns {NodeJS.Timeout}
 */
function createUnrefAbortTimer(controller, timeoutMs) {
  const t = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof t.unref === 'function') t.unref();
  return t;
}

/**
 * Safely cancel an unread response stream to avoid leaking Undici sockets.
 * @param {any} res
 */
async function cancelResponseQuietly(res) {
  try {
    if (res && res.body && typeof res.body.cancel === 'function') {
      await res.body.cancel();
    }
  } catch {}
}

/**
 * Pre-stat file paths once (Schwartzian transform) and sort newest-first in O(N) stat calls
 * instead of O(N log N) `statSync` calls inside `.sort()`.
 *
 * @param {string[]} filePaths
 * @returns {string[]}
 */
function sortPathsNewestFirst(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length <= 1) return filePaths;
  return filePaths
    .map((filePath) => {
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs || 0;
      } catch {}
      return { filePath, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((item) => item.filePath);
}

/**
 * Resolve installation options, disk space, platform builds, and size telemetry for a game.
 *
 * @param {any} [payload]
 * @param {any} [options]
 */
async function getGameInstallInfo(payload = {}, options = {}) {
  const storeSync = getStoreSync();
  const platformId = payload.platformId || 'custom';
  const platformGameId = String(payload.platformGameId || payload.gameId || '');
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();

  let defaultInstallDir = getDefaultInstallDir(platformId, options);
  /** @type {string[]} */
  let availableInstallDirs;
  if (platform === 'darwin') {
    availableInstallDirs = [defaultInstallDir, '/Applications', path.join(homedir, 'Applications')];
  } else if (
    (platform === 'win32' &&
      (options.discoverWindowsDrivesInTest === true ||
        Array.isArray(options.mountedDriveRoots))) ||
    (process.platform === 'win32' && !options.homedir)
  ) {
    const localDrives = await discoverWindowsLocalDrivesAsync(options);
    const mountedDrives = localDrives.map((root) => path.win32.join(root, 'Games'));
    availableInstallDirs = Array.from(new Set([defaultInstallDir, ...mountedDrives]));
  } else if (platform === 'win32') {
    const env = options.env && typeof options.env === 'object' ? options.env : process.env;
    const rawSysDrive = String(options.systemDrive || env.SYSTEMDRIVE || env.SystemDrive || '')
      .trim()
      .replace(/[\\/]+$/, '');
    const sysGamesDir = /^[A-Za-z]:$/.test(rawSysDrive)
      ? path.win32.join(`${rawSysDrive}\\`, 'Games')
      : '';
    availableInstallDirs = Array.from(
      new Set([defaultInstallDir, ...(sysGamesDir ? [sysGamesDir] : [])])
    );
  } else {
    availableInstallDirs = Array.from(new Set([defaultInstallDir, path.join(homedir, 'Games')]));
  }

  const targetDir = payload.targetInstallDir || defaultInstallDir;
  let diskSpace = await getDiskSpace(targetDir, options);

  let estimatedSizeBytes = sanitizeGameInstallSizeBytes(
    payload.estimatedSizeBytes ? Number(payload.estimatedSizeBytes) : undefined
  );
  /** @type {number | undefined} */
  let downloadSizeBytes = undefined;
  /** @type {number | undefined} */
  let dlcSizeBytes = undefined;
  /** @type {any[]} */
  let availableInstallers = [];
  let canDirectDownload = false;
  let requiresStoreClientFallback = false;
  /** @type {any} */
  let xboxCompatibility = undefined;
  /** @type {string | undefined} */
  let externalLauncher = undefined;
  /** @type {string | undefined} */
  let externalLauncherUrl = undefined;
  let isCrossPlatformBottleInstall = false;
  /** @type {boolean | undefined} */
  let authoritativeOsSupport = undefined;
  /** @type {string | undefined} */
  let resolvedChainedHandoff = undefined;
  /** @type {string | undefined} */
  let resolvedChainedTopology = undefined;
  /** @type {string | undefined} */
  let resolvedEpicRegistryPath = undefined;
  const cacheScope =
    options.userDataDir || options.homedir ? `${options.userDataDir || options.homedir}:` : '';

  if (platformId === 'gog') {
    canDirectDownload = true;
    const savedTokens =
      options.savedTokens ||
      (storeSync && typeof storeSync.loadSavedTokens === 'function' ? storeSync.loadSavedTokens() : {});
    /** @type {any} */
    let authRes = null;
    if (!options.skipNetwork) {
      try {
        authRes = await ensureGogdlAuthConfig(options);
      } catch {}
    }
    let gogToken = options.gogAccessToken || authRes?.accessToken || savedTokens?.gog?.access_token;
    const cleanId = platformGameId.replace(/^gog-/i, '');
    const titleLabel = payload.title || 'Game';

    const readCachedGogOs = (/** @type {string} */ osKey) => {
      if (!cleanId) return null;
      const entry = installInfoSizeCache.get(`${cacheScope}gog:${cleanId}:${osKey}`);
      if (!entry) return null;
      return typeof entry === 'number' ? { diskSize: sanitizeGameInstallSizeBytes(entry) } : entry;
    };

    const cachedMac = readCachedGogOs('mac');
    const cachedWin = readCachedGogOs('windows');
    let macSizeBytes = sanitizeGameInstallSizeBytes(cachedMac?.diskSize);
    let macDownloadBytes = sanitizeGameInstallSizeBytes(cachedMac?.downloadSize);
    let macDlcBytes = sanitizeGameInstallSizeBytes(cachedMac?.dlcSize);
    let hasAuthoritativeMacDisk = Boolean(cachedMac?.fromGogdl && macSizeBytes);
    let winSizeBytes = sanitizeGameInstallSizeBytes(cachedWin?.diskSize);
    let winDownloadBytes = sanitizeGameInstallSizeBytes(cachedWin?.downloadSize);
    let winDlcBytes = sanitizeGameInstallSizeBytes(cachedWin?.dlcSize);
    let hasAuthoritativeWinDisk = Boolean(cachedWin?.fromGogdl && winSizeBytes);

    const fetchGogProduct = async (/** @type {string} */ token) => {
      if (!token || !cleanId || options.skipNetwork) return null;
      const controller = new AbortController();
      const timeout = createUnrefAbortTimer(controller, 4500);
      try {
        const res = await fetch(
          `https://api.gog.com/products/${encodeURIComponent(cleanId)}?expand=downloads,description`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GOGGalaxy/2.0',
            },
            signal: controller.signal,
          }
        );
        if (res.ok) {
          return await res.json();
        }
        await cancelResponseQuietly(res);
        return null;
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    };

    const normalizeInstallerVersion = (/** @type {any} */ v) => {
      if (v === undefined || v === null) return undefined;
      const cleaned = String(v).trim().replace(/^[vV]+/, '');
      return cleaned || undefined;
    };

    /** @type {any} */
    let productData = null;
    /** @type {any} */
    let fetchedOsxBuilds = null;
    /** @type {any} */
    let fetchedWinBuilds = null;
    if (cleanId && (!options.skipNetwork || options.mockGogProductData)) {
      productData = options.mockGogProductData || (await fetchGogProduct(gogToken));
      if (!options.mockGogProductData && (!productData || !productData.downloads) && gogToken) {
        try {
          const refreshedAuth = await ensureGogdlAuthConfig({
            ...options,
            forceTokenRefresh: true,
          });
          if (refreshedAuth?.accessToken && refreshedAuth.accessToken !== gogToken) {
            gogToken = refreshedAuth.accessToken;
            productData = await fetchGogProduct(gogToken);
          }
        } catch {}
      }

      if (productData && productData.downloads) {
        const rawInstallers = Array.isArray(productData?.downloads?.installers)
          ? productData.downloads.installers
          : [];
        const mappedInstallers = rawInstallers.map(
          (/** @type {any} */ ins, /** @type {number} */ idx) => {
            const normOs =
              ins.os === 'mac' || ins.os === 'osx'
                ? 'mac'
                : ins.os === 'linux'
                  ? 'linux'
                  : 'windows';
            const baseName = ins.name || titleLabel;
            return {
              id: String(ins.id || `ins-${idx}`),
              name:
                normOs === 'mac'
                  ? `${baseName} — Native macOS Build`
                  : normOs === 'windows'
                    ? `${baseName} — Windows Build`
                    : baseName,
              os: normOs,
              language: ins.language || 'en',
              totalSizeBytes: sanitizeGameInstallSizeBytes(Number(ins.total_size || 0)),
              version: normalizeInstallerVersion(ins.version),
            };
          }
        );

        const platformFiltered =
          platform === 'win32'
            ? mappedInstallers.filter((/** @type {any} */ i) => i.os === 'windows')
            : mappedInstallers.filter(
                (/** @type {any} */ i) => i.os === 'mac' || i.os === 'windows'
              );

        const osGroups = new Map();
        for (const ins of platformFiltered) {
          if (!osGroups.has(ins.os)) {
            osGroups.set(ins.os, []);
          }
          osGroups.get(ins.os).push(ins);
        }

        const dedupedInstallers = [];
        for (const [, candidates] of osGroups.entries()) {
          candidates.sort((/** @type {any} */ a, /** @type {any} */ b) => {
            const langDiff =
              (/^en/i.test(a.language || '') ? 0 : 1) - (/^en/i.test(b.language || '') ? 0 : 1);
            if (langDiff !== 0) return langDiff;
            return (b.totalSizeBytes || 0) - (a.totalSizeBytes || 0);
          });
          if (candidates[0]) {
            dedupedInstallers.push(candidates[0]);
          }
        }

        availableInstallers = dedupedInstallers;

        if (platform === 'win32') {
          availableInstallers = availableInstallers.map((i) => ({
            ...i,
            name: `${titleLabel} — Windows Native Build`,
          }));
        } else if (platform === 'darwin' && availableInstallers.length > 0) {
          const orderScore = (/** @type {string} */ osVal) =>
            osVal === 'mac' ? 0 : osVal === 'windows' ? 1 : 2;
          availableInstallers.sort((a, b) => orderScore(a.os) - orderScore(b.os));
          const hasMacInstaller = availableInstallers.some((i) => i.os === 'mac');
          if (!hasMacInstaller) {
            availableInstallers = availableInstallers.map((i) =>
              i.os === 'windows'
                ? {
                    ...i,
                    name: `${titleLabel} — Windows Build (CrossOver / Wine Fallback, No macOS Native Build)`,
                  }
                : i
            );
          }
        }

        const macFromProduct = availableInstallers.find((i) => i.os === 'mac')?.totalSizeBytes;
        const winFromProduct = availableInstallers.find((i) => i.os === 'windows')?.totalSizeBytes;
        if (!hasAuthoritativeMacDisk && macFromProduct) macSizeBytes = macFromProduct;
        if (!hasAuthoritativeWinDisk && winFromProduct) winSizeBytes = winFromProduct;
      }

      if (availableInstallers.length === 0 && !options.skipNetwork && !options.mockGogProductData) {
        const fetchFn = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
        const fetchBuilds = async (/** @type {string} */ osType) => {
          const controller = new AbortController();
          const timeout = createUnrefAbortTimer(controller, 3000);
          try {
            const res = await fetchFn(
              `https://content-system.gog.com/products/${encodeURIComponent(cleanId)}/os/${osType}/builds?generation=2`,
              { signal: controller.signal }
            );
            if (res.ok) return /** @type {any} */ (await res.json());
            await cancelResponseQuietly(res);
          } catch {}
          finally {
            clearTimeout(timeout);
          }
          return null;
        };

        try {
          const [osxBuilds, winBuilds] = await Promise.all([
            platform === 'win32' ? Promise.resolve(null) : fetchBuilds('osx'),
            fetchBuilds('windows'),
          ]);
          fetchedOsxBuilds = osxBuilds;
          fetchedWinBuilds = winBuilds;
          const hasMacDepot =
            platform !== 'win32' && Array.isArray(osxBuilds?.items) && osxBuilds.items.length > 0;
          const hasWinDepot = Array.isArray(winBuilds?.items) && winBuilds.items.length > 0;

          if (hasMacDepot || hasWinDepot) {
            if (hasMacDepot) {
              availableInstallers.push({
                id: 'gog-mac-native',
                name: `${titleLabel} — Native macOS Build`,
                os: 'mac',
                language: 'en',
                totalSizeBytes: macSizeBytes,
                version: normalizeInstallerVersion(osxBuilds.items[0]?.version_name),
              });
            }
            if (hasWinDepot) {
              availableInstallers.push({
                id: platform === 'win32' ? 'gog-win-native' : 'gog-win-compat',
                name:
                  platform === 'win32'
                    ? `${titleLabel} — Windows Native Build`
                    : platform === 'darwin' && !hasMacDepot
                      ? `${titleLabel} — Windows Build (CrossOver / Wine Fallback, No macOS Native Build)`
                      : `${titleLabel} — Windows Build`,
                os: 'windows',
                language: 'en',
                totalSizeBytes: winSizeBytes,
                version: normalizeInstallerVersion(winBuilds.items[0]?.version_name),
              });
            }
          }
        } catch {}
      }
    }

    const storeSupportsWin =
      availableInstallers.some((i) => i.os === 'windows') ||
      Boolean(productData?.content_system_compatibility?.windows) ||
      Boolean(payload.storePlatforms?.windows);

    if (
      platform === 'darwin' &&
      availableInstallers.some((i) => i.os === 'mac') &&
      !availableInstallers.some((i) => i.os === 'windows') &&
      (productData?.content_system_compatibility?.windows === true ||
        payload.storePlatforms?.windows === true)
    ) {
      availableInstallers.push({
        id: 'gog-win-compat',
        name: `${titleLabel} — Windows Build via CrossOver / Wine`,
        os: 'windows',
        language: 'en',
        totalSizeBytes: winSizeBytes,
      });
    }

    const needsMacGogdl =
      platform === 'darwin' &&
      !hasAuthoritativeMacDisk &&
      (availableInstallers.some((i) => i.os === 'mac') ||
        (availableInstallers.length === 0 && !estimatedSizeBytes));
    const needsWinGogdl =
      !hasAuthoritativeWinDisk &&
      (availableInstallers.some((i) => i.os === 'windows') ||
        (availableInstallers.length === 0 && !estimatedSizeBytes));

    if (
      (needsMacGogdl || needsWinGogdl) &&
      cleanId &&
      !options.skipNetwork &&
      !options.mockGogProductData
    ) {
      if (
        typeof options.execFileFn !== 'function' &&
        (!options.homedir ||
          options.useDirectGogHttpSizes === true ||
          typeof options.fetchImpl === 'function')
      ) {
        try {
          const [directMacRes, directWinRes] = await Promise.all([
            needsMacGogdl
              ? resolveGogDepotSizesDirectHttp(cleanId, 'osx', {
                  ...options,
                  ...(fetchedOsxBuilds ? { buildsJson: fetchedOsxBuilds } : {}),
                })
              : Promise.resolve(null),
            needsWinGogdl
              ? resolveGogDepotSizesDirectHttp(cleanId, 'windows', {
                  ...options,
                  ...(fetchedWinBuilds ? { buildsJson: fetchedWinBuilds } : {}),
                })
              : Promise.resolve(null),
          ]);
          if (directMacRes?.diskSize) {
            macSizeBytes = directMacRes.diskSize;
            macDownloadBytes = directMacRes.downloadSize;
            macDlcBytes = directMacRes.dlcSize;
            hasAuthoritativeMacDisk = true;
          }
          if (directWinRes?.diskSize) {
            winSizeBytes = directWinRes.diskSize;
            winDownloadBytes = directWinRes.downloadSize;
            winDlcBytes = directWinRes.dlcSize;
            hasAuthoritativeWinDisk = true;
          }
          if (availableInstallers.length > 0 && (directMacRes || directWinRes)) {
            availableInstallers = availableInstallers.map((ins) => {
              const isMac = ins.os === 'mac';
              const directForOs = isMac ? directMacRes : directWinRes;
              if (!directForOs) return ins;
              return {
                ...ins,
                totalSizeBytes: ins.totalSizeBytes || directForOs.diskSize,
                ...(ins.version || !directForOs.versionName
                  ? {}
                  : { version: normalizeInstallerVersion(directForOs.versionName) }),
              };
            });
          }
        } catch {}
      }

      const stillNeedsMacGogdl = needsMacGogdl && !hasAuthoritativeMacDisk;
      const stillNeedsWinGogdl = needsWinGogdl && !hasAuthoritativeWinDisk;

      if (
        (stillNeedsMacGogdl || stillNeedsWinGogdl) &&
        (!options.homedir || typeof options.execFileFn === 'function')
      ) {
        try {
          const execFileImpl =
            typeof options.execFileFn === 'function' ? options.execFileFn : execFile;
          const gogdlBin = findGogdlBinary(options);
          const gogAuthPath = validateSafeCliPathArg(authRes?.configPath || authRes?.gogAuthPath);
          const safeCleanId = validateSafeGogProductId(cleanId);
          if (gogdlBin && safeCleanId && gogAuthPath && fs.existsSync(gogAuthPath)) {
            const extractNodeSizes = (/** @type {any} */ node) => {
              if (!node || typeof node !== 'object') {
                return { diskSize: undefined, downloadSize: undefined };
              }
              let rawDisk = Number(node.disk_size || node.download_size || 0);
              let rawDl = Number(node.download_size || node.disk_size || 0);
              if (
                (!Number.isFinite(rawDisk) || rawDisk <= 0) &&
                node.size &&
                typeof node.size === 'object'
              ) {
                const starNode =
                  node.size['*'] && typeof node.size['*'] === 'object' ? node.size['*'] : null;
                const starDisk = Math.max(
                  0,
                  Number(starNode?.disk_size ?? starNode?.download_size ?? 0) || 0
                );
                const starDl = Math.max(
                  0,
                  Number(starNode?.download_size ?? starNode?.disk_size ?? 0) || 0
                );

                const langKeys = Object.keys(node.size).filter((k) => k !== '*');
                const enKey = langKeys.find((k) => /^en(?:[-_][a-z]+)?$|^english$/i.test(k));
                let langNode = enKey ? node.size[enKey] : null;
                if (!langNode && langKeys.length > 0) {
                  let bestDisk = 0;
                  for (const k of langKeys) {
                    const val = node.size[k];
                    const candDisk = Number(val?.disk_size ?? val?.download_size ?? 0) || 0;
                    if (candDisk > bestDisk) {
                      bestDisk = candDisk;
                      langNode = val;
                    }
                  }
                }

                const langDisk = Math.max(
                  0,
                  Number(langNode?.disk_size ?? langNode?.download_size ?? 0) || 0
                );
                const langDl = Math.max(
                  0,
                  Number(langNode?.download_size ?? langNode?.disk_size ?? 0) || 0
                );

                rawDisk = starDisk + langDisk;
                rawDl = starDl + langDl;
              }
              const validDisk = sanitizeGameInstallSizeBytes(rawDisk);
              const validDl = sanitizeGameInstallSizeBytes(rawDl);
              return { diskSize: validDisk, downloadSize: validDl || validDisk };
            };

            const runGogdlInfo = (/** @type {string} */ osFlag) =>
              new Promise((resolve) => {
                execFileImpl(
                  gogdlBin,
                  ['--auth-config-path', gogAuthPath, 'info', safeCleanId, '--platform', osFlag],
                  { timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
                  (/** @type {any} */ err, /** @type {any} */ stdout) => {
                    if (err || !stdout) return resolve(null);
                    try {
                      const jsonLine =
                        String(stdout || '')
                          .split(/\r?\n/)
                          .map((l) => l.trim())
                          .filter((l) => l.startsWith('{'))
                          .pop() || String(stdout || '').trim();
                      const infoJson = JSON.parse(jsonLine);
                      const baseSizes = extractNodeSizes(infoJson);
                      if (!baseSizes.diskSize) return resolve(null);
                      let dlcSum = 0;
                      if (Array.isArray(infoJson?.dlcs)) {
                        for (const dlc of infoJson.dlcs) {
                          const dlcSizes = extractNodeSizes(dlc);
                          if (dlcSizes.diskSize) dlcSum += dlcSizes.diskSize;
                        }
                      }
                      resolve({
                        diskSize: baseSizes.diskSize,
                        downloadSize: baseSizes.downloadSize,
                        dlcSize: sanitizeGameInstallSizeBytes(dlcSum),
                      });
                    } catch {
                      resolve(null);
                    }
                  }
                );
              });

            const [macInfoRes, winInfoRes] = await Promise.all([
              stillNeedsMacGogdl ? runGogdlInfo('osx') : Promise.resolve(null),
              stillNeedsWinGogdl ? runGogdlInfo('windows') : Promise.resolve(null),
            ]);
            if (macInfoRes?.diskSize) {
              macSizeBytes = macInfoRes.diskSize;
              macDownloadBytes = macInfoRes.downloadSize;
              macDlcBytes = macInfoRes.dlcSize;
              hasAuthoritativeMacDisk = true;
            }
            if (winInfoRes?.diskSize) {
              winSizeBytes = winInfoRes.diskSize;
              winDownloadBytes = winInfoRes.downloadSize;
              winDlcBytes = winInfoRes.dlcSize;
              hasAuthoritativeWinDisk = true;
            }
          }
        } catch {}
      }
    }

    if (cleanId) {
      if (macSizeBytes) {
        setBoundedMapEntry(
          installInfoSizeCache,
          `${cacheScope}gog:${cleanId}:mac`,
          {
            diskSize: macSizeBytes,
            downloadSize: macDownloadBytes,
            dlcSize: macDlcBytes,
            fromGogdl: hasAuthoritativeMacDisk,
          },
          MAX_DISCOVERY_CACHE_ENTRIES
        );
      }
      if (winSizeBytes) {
        setBoundedMapEntry(
          installInfoSizeCache,
          `${cacheScope}gog:${cleanId}:windows`,
          {
            diskSize: winSizeBytes,
            downloadSize: winDownloadBytes,
            dlcSize: winDlcBytes,
            fromGogdl: hasAuthoritativeWinDisk,
          },
          MAX_DISCOVERY_CACHE_ENTRIES
        );
      }
    }

    if (availableInstallers.length > 0) {
      availableInstallers = availableInstallers.map((ins) => {
        const isMac = ins.os === 'mac';
        const authoritativeOsDisk = isMac
          ? hasAuthoritativeMacDisk
            ? macSizeBytes
            : undefined
          : hasAuthoritativeWinDisk
            ? winSizeBytes
            : undefined;
        const resolvedTotal =
          authoritativeOsDisk ||
          ins.totalSizeBytes ||
          (isMac ? macSizeBytes : winSizeBytes) ||
          (!(isMac ? winSizeBytes : macSizeBytes) ? estimatedSizeBytes : undefined);
        const resolvedDl = isMac ? macDownloadBytes : winDownloadBytes;
        const resolvedDlc = isMac ? macDlcBytes : winDlcBytes;
        return {
          ...ins,
          totalSizeBytes: resolvedTotal,
          ...(resolvedDl ? { downloadSizeBytes: resolvedDl } : {}),
          ...(resolvedDlc ? { dlcSizeBytes: resolvedDlc } : {}),
        };
      });
    } else {
      const fallbackWinSize = winSizeBytes || (!macSizeBytes ? estimatedSizeBytes : undefined);
      const fallbackMacSize = macSizeBytes || (!winSizeBytes ? estimatedSizeBytes : undefined);
      if (platform === 'win32') {
        availableInstallers = [
          {
            id: 'gog-win-default',
            name: `${titleLabel} — Windows Native Build`,
            os: 'windows',
            language: 'en',
            totalSizeBytes: fallbackWinSize,
            ...(winDownloadBytes ? { downloadSizeBytes: winDownloadBytes } : {}),
            ...(winDlcBytes ? { dlcSizeBytes: winDlcBytes } : {}),
          },
        ];
      } else if (
        (payload.storePlatforms && payload.storePlatforms.mac === false) ||
        (productData?.content_system_compatibility &&
          productData.content_system_compatibility.osx === false &&
          storeSupportsWin)
      ) {
        availableInstallers = [
          {
            id: 'gog-win-default',
            name: `${titleLabel} — Windows Build (CrossOver / Wine Fallback, No macOS Native Build)`,
            os: 'windows',
            language: 'en',
            totalSizeBytes: fallbackWinSize,
            ...(winDownloadBytes ? { downloadSizeBytes: winDownloadBytes } : {}),
            ...(winDlcBytes ? { dlcSizeBytes: winDlcBytes } : {}),
          },
        ];
      } else if (
        payload.storePlatforms &&
        payload.storePlatforms.mac === true &&
        payload.storePlatforms.windows === false &&
        !storeSupportsWin
      ) {
        availableInstallers = [
          {
            id: 'gog-mac-default',
            name: `${titleLabel} (macOS Universal Installer)`,
            os: 'mac',
            language: 'en',
            totalSizeBytes: fallbackMacSize,
            ...(macDownloadBytes ? { downloadSizeBytes: macDownloadBytes } : {}),
            ...(macDlcBytes ? { dlcSizeBytes: macDlcBytes } : {}),
          },
        ];
      } else {
        availableInstallers = [
          {
            id: 'gog-mac-default',
            name: `${titleLabel} (macOS Universal Installer)`,
            os: 'mac',
            language: 'en',
            totalSizeBytes: fallbackMacSize,
            ...(macDownloadBytes ? { downloadSizeBytes: macDownloadBytes } : {}),
            ...(macDlcBytes ? { dlcSizeBytes: macDlcBytes } : {}),
          },
          {
            id: 'gog-win-default',
            name: `${titleLabel} (Windows x64 Installer — CrossOver / Wine)`,
            os: 'windows',
            language: 'en',
            totalSizeBytes: fallbackWinSize,
            ...(winDownloadBytes ? { downloadSizeBytes: winDownloadBytes } : {}),
            ...(winDlcBytes ? { dlcSizeBytes: winDlcBytes } : {}),
          },
        ];
      }
    }

    const primaryGogInstaller = availableInstallers[0];
    estimatedSizeBytes = sanitizeGameInstallSizeBytes(
      primaryGogInstaller?.totalSizeBytes || macSizeBytes || winSizeBytes || estimatedSizeBytes
    );
    downloadSizeBytes = sanitizeGameInstallSizeBytes(
      primaryGogInstaller?.downloadSizeBytes || macDownloadBytes || winDownloadBytes
    );
    dlcSizeBytes = sanitizeGameInstallSizeBytes(
      primaryGogInstaller?.dlcSizeBytes || macDlcBytes || winDlcBytes
    );
  } else if (platformId === 'epic') {
    const legendaryBin = findLegendaryBinary(options);
    canDirectDownload = Boolean(legendaryBin);
    requiresStoreClientFallback = !canDirectDownload;

    if (options.refreshLegendaryMetadata === true) {
      try {
        await refreshLocalLegendaryMetadata(options);
      } catch {}
    }

    const epicInfo = resolveEpicAppAndPlatforms(payload, options);
    const titleLabel = payload.title || 'Game';
    const resolvedAppName =
      epicInfo.resolvedAppName || epicInfo.appName || platformGameId.replace(/^epic-/i, '');
    const safeAppName = validateSafeCliIdentifier(resolvedAppName);

    const userDataDir = getUserDataDir(options.userDataDir);
    let epicPartnerHandoff = resolveAnyChainedHandoffId(
      epicInfo.chainedLauncherHandoff ||
        payload.chainedLauncherHandoff ||
        payload.externalStorefrontHandoff ||
        ''
    );
    let epicPartnerRegPath =
      epicInfo.epicPartnerRegistryPath ||
      (typeof payload.epicPartnerRegistryPath === 'string' &&
      payload.epicPartnerRegistryPath.trim()
        ? payload.epicPartnerRegistryPath.trim()
        : undefined);
    let hasMacBuild = epicPartnerHandoff ? false : Boolean(epicInfo.hasMacBuild);
    let hasWindowsBuild = epicPartnerHandoff ? true : epicInfo.hasWindowsBuild !== false;
    let namespace = epicInfo.namespace;
    let catalogItemId = epicInfo.catalogItemId;
    /** @type {{ Mac: Set<string>, Windows: Set<string> }} */
    const dlcAppIdsByPlat = { Mac: new Set(), Windows: new Set() };

    if (safeAppName) {
      const metaDirs = [
        path.join(userDataDir, 'legendaryConfig', 'legendary', 'metadata'),
        path.join(homedir, '.config', 'legendary', 'metadata'),
        path.join(
          homedir,
          'Library',
          'Application Support',
          'heroic',
          'legendaryConfig',
          'legendary',
          'metadata'
        ),
        path.join(
          process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
          'heroic',
          'legendaryConfig',
          'legendary',
          'metadata'
        ),
        path.join(
          homedir,
          'AppData',
          'Roaming',
          'heroic',
          'legendaryConfig',
          'legendary',
          'metadata'
        ),
      ];
      for (const metaDir of metaDirs) {
        const metaPath = path.join(metaDir, `${safeAppName}.json`);
        if (!isContainedWithinRoot(metaDir, metaPath) || !fs.existsSync(metaPath)) continue;
        try {
          const metaJson = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          namespace = namespace || metaJson?.namespace || metaJson?.metadata?.namespace;
          catalogItemId =
            catalogItemId ||
            metaJson?.id ||
            metaJson?.catalog_item_id ||
            metaJson?.metadata?.id;
          if (
            metaJson?.asset_infos &&
            typeof metaJson.asset_infos === 'object' &&
            Object.keys(metaJson.asset_infos).length > 0 &&
            epicInfo.hasWindowsBuild === undefined
          ) {
            hasWindowsBuild = Boolean(metaJson.asset_infos.Windows);
          }
          const dlcList = metaJson?.metadata?.dlcItemList || metaJson?.dlcItemList;
          if (Array.isArray(dlcList)) {
            for (const dlcItem of dlcList) {
              if (!Array.isArray(dlcItem?.releaseInfo)) continue;
              for (const rel of dlcItem.releaseInfo) {
                const dlcAppId = String(rel?.appId || '').trim();
                if (!dlcAppId) continue;
                const relPlats = Array.isArray(rel.platform) ? rel.platform : [];
                if (
                  relPlats.length === 0 ||
                  relPlats.some((/** @type {any} */ p) => /^mac$/i.test(String(p)))
                ) {
                  dlcAppIdsByPlat.Mac.add(dlcAppId);
                }
                if (
                  relPlats.length === 0 ||
                  relPlats.some((/** @type {any} */ p) => /^(windows|win32)$/i.test(String(p)))
                ) {
                  dlcAppIdsByPlat.Windows.add(dlcAppId);
                }
              }
            }
          }
          if (namespace && catalogItemId) break;
        } catch {}
      }
    }

    const isDualOsEpic = Boolean(hasMacBuild && hasWindowsBuild);
    /** @type {Array<'Mac' | 'Windows'>} */
    const targetPlats =
      platform === 'darwin'
        ? isDualOsEpic
          ? ['Mac', 'Windows']
          : hasMacBuild
            ? ['Mac']
            : ['Windows']
        : ['Windows'];

    /** @type {Record<'Mac' | 'Windows', { diskSize?: number, downloadSize?: number, dlcSize?: number }>} */
    const platStats = {
      Mac: { diskSize: undefined, downloadSize: undefined, dlcSize: undefined },
      Windows: { diskSize: undefined, downloadSize: undefined, dlcSize: undefined },
    };

    if (!estimatedSizeBytes && safeAppName) {
      for (const plat of targetPlats) {
        const cached = installInfoSizeCache.get(`${cacheScope}epic:${safeAppName}:${plat}`);
        if (cached) {
          if (typeof cached === 'number') {
            platStats[plat].diskSize = sanitizeGameInstallSizeBytes(cached);
          } else if (typeof cached === 'object') {
            platStats[plat].diskSize = sanitizeGameInstallSizeBytes(cached.diskSize);
            platStats[plat].downloadSize = sanitizeGameInstallSizeBytes(cached.downloadSize);
            platStats[plat].dlcSize = sanitizeGameInstallSizeBytes(cached.dlcSize);
          }
        }
      }
    }

    if (
      !estimatedSizeBytes &&
      safeAppName &&
      targetPlats.some((p) => !platStats[p].diskSize)
    ) {
      const installedJsonPaths = [
        path.join(userDataDir, 'legendaryConfig', 'legendary', 'installed.json'),
        path.join(homedir, '.config', 'legendary', 'installed.json'),
        path.join(
          homedir,
          'Library',
          'Application Support',
          'heroic',
          'legendaryConfig',
          'legendary',
          'installed.json'
        ),
        path.join(
          process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
          'heroic',
          'legendaryConfig',
          'legendary',
          'installed.json'
        ),
        path.join(
          homedir,
          'AppData',
          'Roaming',
          'heroic',
          'legendaryConfig',
          'legendary',
          'installed.json'
        ),
      ];
      for (const legInstalledPath of installedJsonPaths) {
        try {
          if (!fs.existsSync(legInstalledPath)) continue;
          const rawInstalled = JSON.parse(fs.readFileSync(legInstalledPath, 'utf8'));
          const entry = rawInstalled?.[safeAppName];
          if (!entry) continue;
          const validInstSize = parseByteCountOrFormattedSize(entry.install_size);
          if (!validInstSize) continue;
          for (const plat of targetPlats) {
            if (
              !platStats[plat].diskSize &&
              (!entry.platform || String(entry.platform).toLowerCase() === plat.toLowerCase())
            ) {
              platStats[plat].diskSize = validInstSize;
            }
          }
        } catch {}
      }
    }

    if (safeAppName) {
      const manifestDirs = [
        path.join(userDataDir, 'legendaryConfig', 'legendary', 'manifests'),
        path.join(homedir, '.config', 'legendary', 'manifests'),
        path.join(
          homedir,
          'Library',
          'Application Support',
          'heroic',
          'legendaryConfig',
          'legendary',
          'manifests'
        ),
        path.join(
          process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
          'heroic',
          'legendaryConfig',
          'legendary',
          'manifests'
        ),
        path.join(
          homedir,
          'AppData',
          'Roaming',
          'heroic',
          'legendaryConfig',
          'legendary',
          'manifests'
        ),
      ];

      /** @type {Array<{ dir: string, files: string[] }>} */
      const existingManifestDirs = [];
      for (const mDir of manifestDirs) {
        try {
          if (fs.existsSync(mDir)) {
            existingManifestDirs.push({ dir: mDir, files: fs.readdirSync(mDir) });
          }
        } catch {}
      }

      const resolveLocalManifestForApp = (
        /** @type {string} */ appId,
        /** @type {'Mac' | 'Windows'} */ targetPlat,
        /** @type {boolean} */ allowSingleOsPrefix
      ) => {
        const otherPlat = targetPlat === 'Mac' ? 'Windows' : 'Mac';
        const tier1Paths = [];
        const tier2Paths = [];

        for (const { dir, files } of existingManifestDirs) {
          for (const f of files) {
            if (!f.endsWith('.manifest')) continue;
            if (
              f.startsWith(`${appId}_${targetPlat}_`) ||
              f === `${appId}_${targetPlat}.manifest`
            ) {
              tier1Paths.push(path.join(dir, f));
            } else if (
              f === `${appId}.manifest` ||
              (allowSingleOsPrefix &&
                f.startsWith(`${appId}_`) &&
                !f.startsWith(`${appId}_${otherPlat}_`) &&
                f !== `${appId}_${otherPlat}.manifest`)
            ) {
              tier2Paths.push(path.join(dir, f));
            }
          }
        }

        const ordered =
          tier1Paths.length > 0
            ? sortPathsNewestFirst(tier1Paths)
            : sortPathsNewestFirst(tier2Paths);

        for (const fullPath of ordered) {
          try {
            const parsed = parseEpicManifestBuffer(fs.readFileSync(fullPath));
            const validDisk = sanitizeGameInstallSizeBytes(parsed?.diskSize);
            if (validDisk) {
              return {
                diskSize: validDisk,
                downloadSize: sanitizeGameInstallSizeBytes(parsed?.downloadSize) || validDisk,
              };
            }
          } catch {}
        }
        return null;
      };

      for (const plat of targetPlats) {
        if (!estimatedSizeBytes && !platStats[plat].diskSize) {
          const localBase = resolveLocalManifestForApp(safeAppName, plat, !isDualOsEpic);
          if (localBase) {
            platStats[plat].diskSize = localBase.diskSize;
            platStats[plat].downloadSize = localBase.downloadSize;
          }
        }

        if (!platStats[plat].dlcSize && dlcAppIdsByPlat[plat].size > 0) {
          let dlcTotal = 0;
          for (const dlcAppId of dlcAppIdsByPlat[plat]) {
            const localDlc = resolveLocalManifestForApp(dlcAppId, plat, !isDualOsEpic);
            if (localDlc?.diskSize) {
              dlcTotal += localDlc.diskSize;
            }
          }
          const validDlc = sanitizeGameInstallSizeBytes(dlcTotal);
          if (validDlc) {
            platStats[plat].dlcSize = validDlc;
          }
        }
      }
    }

    if (
      !estimatedSizeBytes &&
      safeAppName &&
      !options.skipNetwork &&
      targetPlats.some((p) => !platStats[p].diskSize)
    ) {
      try {
        const legAuth = await ensureLegendaryConfigAndAuth(options);
        let accessToken = legAuth?.accessToken;

        if (accessToken && namespace && catalogItemId) {
          const missingNetPlats = targetPlats.filter((p) => !platStats[p].diskSize);
          const fetchAssetsForPlat = async (
            /** @type {'Mac' | 'Windows'} */ plat,
            /** @type {string} */ token
          ) => {
            const assetsUrl = `https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/v2/platform/${plat}/namespace/${encodeURIComponent(namespace)}/catalogItem/${encodeURIComponent(catalogItemId)}/app/${encodeURIComponent(safeAppName)}/label/Live`;
            const ctrl = new AbortController();
            const t = createUnrefAbortTimer(ctrl, 4500);
            try {
              const res = await fetch(assetsUrl, {
                signal: ctrl.signal,
                headers: {
                  Authorization: `Bearer ${token}`,
                  'User-Agent':
                    'UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit',
                },
              });
              return { plat, res };
            } catch {
              return { plat, res: null };
            } finally {
              clearTimeout(t);
            }
          };

          let assetResponses = await Promise.all(
            missingNetPlats.map((plat) => fetchAssetsForPlat(plat, accessToken))
          );

          if (
            assetResponses.some(
              (r) => r.res && (r.res.status === 401 || r.res.status === 403)
            ) &&
            legAuth?.refreshToken &&
            storeSync &&
            typeof storeSync.renewEpicTokens === 'function'
          ) {
            await Promise.all(assetResponses.map((r) => cancelResponseQuietly(r.res)));
            try {
              const renewed = await storeSync.renewEpicTokens(legAuth.refreshToken);
              if (renewed && renewed.access_token) {
                accessToken = renewed.access_token;
                try {
                  const existingUserPath = path.join(legAuth.legendaryConfigPath, 'user.json');
                  const baseUser = fs.existsSync(existingUserPath)
                    ? JSON.parse(fs.readFileSync(existingUserPath, 'utf8'))
                    : {};
                  const updatedUser = { ...baseUser, ...renewed };
                  atomicWriteSecureFileSync(
                    existingUserPath,
                    JSON.stringify(updatedUser, null, 2),
                    options
                  );
                } catch {}
                assetResponses = await Promise.all(
                  missingNetPlats.map((plat) => fetchAssetsForPlat(plat, accessToken))
                );
              }
            } catch {}
          }

          await Promise.all(
            assetResponses.map(async ({ plat, res: assetsRes }) => {
              if (!assetsRes || !assetsRes.ok) {
                await cancelResponseQuietly(assetsRes);
                return;
              }
              try {
                /** @type {any} */
                const assetsData = await assetsRes.json();
                const manifests = assetsData?.elements?.[0]?.manifests || [];
                const manifestEntry = manifests.find((/** @type {any} */ m) => m && m.uri);
                if (!manifestEntry) return;
                const manifestUrl = buildValidatedEpicManifestUrl(manifestEntry);
                if (!manifestUrl) return;
                const mCtrl = new AbortController();
                const mTimeout = createUnrefAbortTimer(mCtrl, 5000);
                try {
                  const manifestRes = await fetch(manifestUrl, {
                    signal: mCtrl.signal,
                    redirect: 'error',
                  });
                  if (manifestRes.ok) {
                    const manifestBuf = await readSafeResponseBuffer(
                      manifestRes,
                      MAX_EPIC_MANIFEST_BYTES
                    );
                    const parsedManifest = parseEpicManifestBuffer(manifestBuf);
                    const validDisk = sanitizeGameInstallSizeBytes(parsedManifest?.diskSize);
                    if (validDisk) {
                      platStats[plat].diskSize = validDisk;
                      platStats[plat].downloadSize =
                        sanitizeGameInstallSizeBytes(parsedManifest?.downloadSize) || validDisk;
                    }
                  } else {
                    await cancelResponseQuietly(manifestRes);
                  }
                } catch {}
                finally {
                  clearTimeout(mTimeout);
                }
              } catch {}
            })
          );
        }
      } catch {}
    }

    if (
      !estimatedSizeBytes &&
      legendaryBin &&
      safeAppName &&
      !options.skipNetwork &&
      !options.disableLegendarySpawn &&
      (!options.homedir || typeof options.execFileFn === 'function') &&
      targetPlats.some((p) => !platStats[p].diskSize)
    ) {
      try {
        const execFileImpl =
          typeof options.execFileFn === 'function' ? options.execFileFn : execFile;
        const legAuth = await ensureLegendaryConfigAndAuth(options);
        const missingLegPlats = targetPlats.filter((p) => !platStats[p].diskSize);
        await Promise.all(
          missingLegPlats.map(
            (plat) =>
              new Promise((resolve) => {
                execFileImpl(
                  legendaryBin,
                  ['info', safeAppName, '--platform', plat, '--json'],
                  { env: legAuth.env, timeout: 10000 },
                  (/** @type {any} */ err, /** @type {any} */ stdout) => {
                    if (err || !stdout) return resolve(undefined);
                    try {
                      const infoJson = JSON.parse(String(stdout).trim());
                      const infoPartner = extractEpicThirdPartyPartnerMetadata(infoJson);
                      if (!epicPartnerHandoff && infoPartner.chainedLauncherHandoff) {
                        epicPartnerHandoff = infoPartner.chainedLauncherHandoff;
                        hasMacBuild = false;
                        hasWindowsBuild = true;
                      }
                      if (!epicPartnerRegPath && infoPartner.epicPartnerRegistryPath) {
                        epicPartnerRegPath = infoPartner.epicPartnerRegistryPath;
                      }
                      const validDisk = sanitizeGameInstallSizeBytes(
                        Number(
                          infoJson?.manifest?.disk_size || infoJson?.manifest?.download_size || 0
                        )
                      );
                      const validDl = sanitizeGameInstallSizeBytes(
                        Number(infoJson?.manifest?.download_size || 0)
                      );
                      if (validDisk) {
                        platStats[plat].diskSize = validDisk;
                        platStats[plat].downloadSize = validDl || validDisk;
                      }
                      const ownedDlcs = infoJson?.game?.owned_dlc || infoJson?.owned_dlc;
                      if (Array.isArray(ownedDlcs) && !platStats[plat].dlcSize) {
                        let dlcSum = 0;
                        for (const dlcEntry of ownedDlcs) {
                          const dSz = sanitizeGameInstallSizeBytes(
                            Number(
                              dlcEntry?.manifest?.disk_size ||
                                dlcEntry?.disk_size ||
                                dlcEntry?.manifest?.download_size ||
                                0
                            )
                          );
                          if (dSz) dlcSum += dSz;
                        }
                        const validDlc = sanitizeGameInstallSizeBytes(dlcSum);
                        if (validDlc) platStats[plat].dlcSize = validDlc;
                      }
                    } catch {}
                    resolve(undefined);
                  }
                );
              })
          )
        );
      } catch {}
    }

    if (
      !estimatedSizeBytes &&
      !options.skipNetwork &&
      (Number(payload.steamAppId) > 0 || payload.title) &&
      targetPlats.some((p) => !platStats[p].diskSize)
    ) {
      let targetSteamId = Number(payload.steamAppId) > 0 ? Number(payload.steamAppId) : null;
      if (!targetSteamId && payload.title) {
        const sCtrl = new AbortController();
        const sTimeout = createUnrefAbortTimer(sCtrl, 3000);
        try {
          const searchRes = await fetch(
            `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(payload.title)}&l=english&cc=US`,
            { signal: sCtrl.signal }
          );
          if (searchRes.ok) {
            /** @type {any} */
            const searchData = await searchRes.json();
            const normAlnum = (/** @type {any} */ s) =>
              String(s || '')
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '');
            const stripEditions = (/** @type {any} */ s) =>
              normAlnum(
                String(s || '').replace(
                  /\b(?:epic\s+games\s+edition|standard\s+edition|game\s+of\s+the\s+year(?:\s+edition)?|goty(?:\s+edition)?|complete\s+edition|definitive\s+edition|deluxe\s+edition)\b/gi,
                  ''
                )
              );
            const normTarget = normAlnum(payload.title);
            const strippedTarget = stripEditions(payload.title);
            const matchedItem = (searchData?.items || []).find((/** @type {any} */ it) => {
              const itNorm = normAlnum(it?.name);
              if (!itNorm) return false;
              if (itNorm === normTarget) return true;
              const itStripped = stripEditions(it?.name);
              return Boolean(strippedTarget && itStripped && itStripped === strippedTarget);
            });
            if (matchedItem?.id) {
              targetSteamId = matchedItem.id;
            }
          } else {
            await cancelResponseQuietly(searchRes);
          }
        } catch {}
        finally {
          clearTimeout(sTimeout);
        }
      }

      if (targetSteamId) {
        const dCtrl = new AbortController();
        const dTimeout = createUnrefAbortTimer(dCtrl, 3000);
        try {
          const detRes = await fetch(
            `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(targetSteamId)}`,
            {
              signal: dCtrl.signal,
              headers: {
                Cookie: 'birthtime=568022401; mature_content=1; wants_mature_content=1',
              },
            }
          );
          if (detRes.ok) {
            const detJson = await detRes.json();
            const appData = detJson?.[targetSteamId]?.data;
            const pcReq =
              appData?.pc_requirements?.minimum || appData?.pc_requirements?.recommended;
            const macReq =
              appData?.mac_requirements?.minimum || appData?.mac_requirements?.recommended;
            const winSteamSize = sanitizeGameInstallSizeBytes(parseStorageRequirementBytes(pcReq));
            const macSteamSize = sanitizeGameInstallSizeBytes(parseStorageRequirementBytes(macReq));
            if (targetPlats.includes('Mac') && !platStats.Mac.diskSize) {
              platStats.Mac.diskSize = macSteamSize || winSteamSize;
            }
            if (targetPlats.includes('Windows') && !platStats.Windows.diskSize) {
              platStats.Windows.diskSize = winSteamSize || macSteamSize;
            }
          } else {
            await cancelResponseQuietly(detRes);
          }
        } catch {}
        finally {
          clearTimeout(dTimeout);
        }
      }
    }

    if (safeAppName) {
      for (const plat of targetPlats) {
        if (platStats[plat].diskSize) {
          setBoundedMapEntry(
            installInfoSizeCache,
            `${cacheScope}epic:${safeAppName}:${plat}`,
            {
              diskSize: platStats[plat].diskSize,
              downloadSize: platStats[plat].downloadSize,
              dlcSize: platStats[plat].dlcSize,
            },
            MAX_DISCOVERY_CACHE_ENTRIES
          );
        }
      }
    }

    const epicPartnerEcosystem = epicPartnerHandoff
      ? CHAINED_PUBLISHER_ECOSYSTEMS[epicPartnerHandoff]
      : null;

    if (epicPartnerHandoff && epicPartnerEcosystem) {
      hasMacBuild = false;
      hasWindowsBuild = true;
      authoritativeOsSupport = true;
      resolvedChainedHandoff = epicPartnerHandoff;
      resolvedChainedTopology = 'partner_launcher_link';
      resolvedEpicRegistryPath = epicPartnerRegPath;
      externalLauncher = epicPartnerEcosystem.displayName;
      externalLauncherUrl = '';
      if (platform === 'darwin') {
        isCrossPlatformBottleInstall = Boolean(epicPartnerEcosystem.supportedInWineBottle);
        canDirectDownload = Boolean(epicPartnerEcosystem.supportedInWineBottle);
        requiresStoreClientFallback = false;
        availableInstallers = [
          {
            id: 'epic-chained-bottle-launcher',
            label: `Windows (${epicPartnerEcosystem.displayName} in Bottle)`,
            name: `${titleLabel} — Windows (${epicPartnerEcosystem.displayName} in Bottle)`,
            os: 'windows',
            sizeBytes: platStats.Windows.diskSize || estimatedSizeBytes,
            totalSizeBytes: platStats.Windows.diskSize || estimatedSizeBytes,
            ...(platStats.Windows.downloadSize
              ? { downloadSizeBytes: platStats.Windows.downloadSize }
              : {}),
            ...(platStats.Windows.dlcSize ? { dlcSizeBytes: platStats.Windows.dlcSize } : {}),
            externalLauncher: epicPartnerEcosystem.displayName,
            externalStorefrontHandoff: epicPartnerHandoff,
            chainedLauncherHandoff: epicPartnerHandoff,
            chainedHandoffTopology: 'partner_launcher_link',
            ...(epicPartnerRegPath ? { epicPartnerRegistryPath: epicPartnerRegPath } : {}),
          },
        ];
      } else {
        canDirectDownload = true;
        requiresStoreClientFallback = false;
        availableInstallers = [
          {
            id: 'epic-chained-host-launcher',
            label: `Windows (${epicPartnerEcosystem.displayName})`,
            name: `${titleLabel} — Windows (${epicPartnerEcosystem.displayName})`,
            os: 'windows',
            sizeBytes: platStats.Windows.diskSize || estimatedSizeBytes,
            totalSizeBytes: platStats.Windows.diskSize || estimatedSizeBytes,
            ...(platStats.Windows.downloadSize
              ? { downloadSizeBytes: platStats.Windows.downloadSize }
              : {}),
            ...(platStats.Windows.dlcSize ? { dlcSizeBytes: platStats.Windows.dlcSize } : {}),
            externalLauncher: epicPartnerEcosystem.displayName,
            externalStorefrontHandoff: epicPartnerHandoff,
            chainedLauncherHandoff: epicPartnerHandoff,
            chainedHandoffTopology: 'partner_launcher_link',
            ...(epicPartnerRegPath ? { epicPartnerRegistryPath: epicPartnerRegPath } : {}),
          },
        ];
      }
    } else if (platform === 'darwin') {
      if (hasMacBuild) {
        availableInstallers = [
          {
            id: 'epic-mac-native',
            name: `${titleLabel} (macOS Native Build)`,
            os: 'mac',
            totalSizeBytes: platStats.Mac.diskSize || estimatedSizeBytes,
            ...(platStats.Mac.downloadSize
              ? { downloadSizeBytes: platStats.Mac.downloadSize }
              : {}),
            ...(platStats.Mac.dlcSize ? { dlcSizeBytes: platStats.Mac.dlcSize } : {}),
            version: epicInfo.macVersion,
          },
          ...(hasWindowsBuild
            ? [
                {
                  id: 'epic-win-compat',
                  name: `${titleLabel} (Windows Build via CrossOver / Wine)`,
                  os: 'windows',
                  totalSizeBytes: platStats.Windows.diskSize || estimatedSizeBytes,
                  ...(platStats.Windows.downloadSize
                    ? { downloadSizeBytes: platStats.Windows.downloadSize }
                    : {}),
                  ...(platStats.Windows.dlcSize
                    ? { dlcSizeBytes: platStats.Windows.dlcSize }
                    : {}),
                  version: epicInfo.winVersion,
                },
              ]
            : []),
        ];
      } else {
        availableInstallers = [
          {
            id: 'epic-win-compat',
            name: `${titleLabel} (Windows Build — CrossOver / Wine Fallback, No macOS Native Build)`,
            os: 'windows',
            totalSizeBytes: platStats.Windows.diskSize || estimatedSizeBytes,
            ...(platStats.Windows.downloadSize
              ? { downloadSizeBytes: platStats.Windows.downloadSize }
              : {}),
            ...(platStats.Windows.dlcSize ? { dlcSizeBytes: platStats.Windows.dlcSize } : {}),
            version: epicInfo.winVersion,
          },
        ];
      }
    } else {
      availableInstallers = [
        {
          id: 'epic-win-native',
          name: `${titleLabel} (Windows Native Build)`,
          os: 'windows',
          totalSizeBytes: platStats.Windows.diskSize || estimatedSizeBytes,
          ...(platStats.Windows.downloadSize
            ? { downloadSizeBytes: platStats.Windows.downloadSize }
            : {}),
          ...(platStats.Windows.dlcSize ? { dlcSizeBytes: platStats.Windows.dlcSize } : {}),
          version: epicInfo.winVersion,
        },
      ];
    }

    const primaryEpicInstaller = availableInstallers[0];
    estimatedSizeBytes = sanitizeGameInstallSizeBytes(
      primaryEpicInstaller?.totalSizeBytes || estimatedSizeBytes
    );
    downloadSizeBytes = sanitizeGameInstallSizeBytes(primaryEpicInstaller?.downloadSizeBytes);
    dlcSizeBytes = sanitizeGameInstallSizeBytes(primaryEpicInstaller?.dlcSizeBytes);
  } else if (platformId === 'steam') {
    canDirectDownload = false;
    requiresStoreClientFallback = true;
    const titleLabel = payload.title || 'Game';
    const cleanId = String(payload.steamAppId || platformGameId).replace(/^steam-/i, '');

    /** @type {number | undefined} */
    let installedDiskSize = undefined;
    /** @type {number | undefined} */
    let installedMacDiskSize = undefined;
    /** @type {number | undefined} */
    let installedWinDiskSize = undefined;
    /** @type {number | undefined} */
    let macParsedSize = undefined;
    /** @type {number | undefined} */
    let winParsedSize = undefined;

    try {
      /** @type {any} */
      const rawSteamDirs = discoverSteamLocations(options).steamappsDirs;
      /** @type {string[]} */
      const steamDirsArr = Array.isArray(rawSteamDirs)
        ? rawSteamDirs
        : rawSteamDirs instanceof Set
          ? Array.from(rawSteamDirs)
          : [];
      if (steamDirsArr.length > 0) {
        const steamCommonDirs = steamDirsArr.map((d) => path.join(d, 'common'));
        defaultInstallDir = steamCommonDirs[0];
        availableInstallDirs = Array.from(new Set([...steamCommonDirs, ...availableInstallDirs]));
        diskSpace = await getDiskSpace(payload.targetInstallDir || defaultInstallDir, options);
      }
      if (!estimatedSizeBytes && cleanId && steamDirsArr.length > 0) {
        for (const dir of steamDirsArr) {
          const acfPath = path.join(dir, `appmanifest_${cleanId}.acf`);
          if (fs.existsSync(acfPath)) {
            const parsedAcf = parseSteamAcf(fs.readFileSync(acfPath, 'utf8'));
            const acfSize = sanitizeGameInstallSizeBytes(
              Number(parsedAcf?.SizeOnDisk || parsedAcf?.BytesToDownload || 0)
            );
            if (acfSize) {
              installedDiskSize = installedDiskSize || acfSize;
              const isBottleDir = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(dir);
              if (platform === 'darwin' && isBottleDir) {
                installedWinDiskSize = installedWinDiskSize || acfSize;
              } else if (platform === 'darwin') {
                installedMacDiskSize = installedMacDiskSize || acfSize;
              } else {
                installedWinDiskSize = installedWinDiskSize || acfSize;
              }
            }
          }
        }
      }
    } catch {}

    if (!estimatedSizeBytes && cleanId) {
      const cachedSteam = installInfoSizeCache.get(`${cacheScope}steam:${cleanId}`);
      if (cachedSteam) {
        if (typeof cachedSteam === 'number') {
          const validCached = sanitizeGameInstallSizeBytes(cachedSteam);
          macParsedSize = validCached;
          winParsedSize = validCached;
        } else if (typeof cachedSteam === 'object') {
          macParsedSize = sanitizeGameInstallSizeBytes(cachedSteam.macParsedSize);
          winParsedSize = sanitizeGameInstallSizeBytes(cachedSteam.winParsedSize);
        }
      }
    }

    let macSupported = Boolean(
      payload?.platforms?.mac || payload?.storePlatforms?.mac || payload?.steamPlatforms?.mac
    );
    let winSupported = Boolean(
      payload?.platforms?.windows ??
        payload?.storePlatforms?.windows ??
        payload?.steamPlatforms?.windows ??
        true
    );
    let platformSupportResolved = false;
    let resolvedFromSteamApi = false;

    if (options.mockSteamAppDetails) {
      if (options.mockSteamAppDetails.platforms) {
        const platData = options.mockSteamAppDetails.platforms;
        macSupported = Boolean(platData.mac);
        winSupported = Boolean(platData.windows);
        platformSupportResolved = true;
        resolvedFromSteamApi = true;
      }
      const mockMacReq =
        options.mockSteamAppDetails.mac_requirements?.minimum ||
        options.mockSteamAppDetails.mac_requirements?.recommended;
      const mockPcReq =
        options.mockSteamAppDetails.pc_requirements?.minimum ||
        options.mockSteamAppDetails.pc_requirements?.recommended;
      if (mockMacReq && !macParsedSize) {
        macParsedSize = sanitizeGameInstallSizeBytes(parseStorageRequirementBytes(mockMacReq));
      }
      if (mockPcReq && !winParsedSize) {
        winParsedSize = sanitizeGameInstallSizeBytes(parseStorageRequirementBytes(mockPcReq));
      }
    } else if (payload.steamPlatforms && typeof payload.steamPlatforms === 'object') {
      macSupported = Boolean(payload.steamPlatforms.mac);
      winSupported = Boolean(payload.steamPlatforms.windows ?? true);
      if (cleanId) {
        setBoundedMapEntry(steamPlatformSupportCache, cleanId, { macSupported, winSupported }, 2000);
      }
      platformSupportResolved = true;
    } else if (cleanId && steamPlatformSupportCache.has(cleanId)) {
      const cachedPlat = steamPlatformSupportCache.get(cleanId);
      macSupported = Boolean(cachedPlat.macSupported);
      winSupported = Boolean(cachedPlat.winSupported);
      platformSupportResolved = true;
      resolvedFromSteamApi = true;
    }

    if (
      cleanId &&
      !options.skipNetwork &&
      !options.mockSteamAppDetails &&
      ((!platformSupportResolved && platform === 'darwin') ||
        (!estimatedSizeBytes && !installedDiskSize && !macParsedSize && !winParsedSize))
    ) {
      const controller = new AbortController();
      const timeout = createUnrefAbortTimer(controller, 3000);
      try {
        const res = await fetch(
          `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(cleanId)}`,
          {
            signal: controller.signal,
            headers: {
              Cookie: 'birthtime=568022401; mature_content=1; wants_mature_content=1',
            },
          }
        );
        if (res.ok) {
          const appDetails = await res.json();
          const appData = appDetails?.[cleanId]?.data;
          const platData = appData?.platforms;
          if (platData && !platformSupportResolved) {
            macSupported = Boolean(platData.mac);
            winSupported = Boolean(platData.windows);
            setBoundedMapEntry(
              steamPlatformSupportCache,
              cleanId,
              { macSupported, winSupported },
              2000
            );
            platformSupportResolved = true;
            resolvedFromSteamApi = true;
          }
          if (appData) {
            const macReqText =
              appData.mac_requirements?.minimum || appData.mac_requirements?.recommended;
            const pcReqText =
              appData.pc_requirements?.minimum || appData.pc_requirements?.recommended;
            macParsedSize =
              macParsedSize ||
              sanitizeGameInstallSizeBytes(parseStorageRequirementBytes(macReqText));
            winParsedSize =
              winParsedSize ||
              sanitizeGameInstallSizeBytes(parseStorageRequirementBytes(pcReqText));
            if (macParsedSize || winParsedSize) {
              setBoundedMapEntry(
                installInfoSizeCache,
                `${cacheScope}steam:${cleanId}`,
                { macParsedSize, winParsedSize },
                MAX_DISCOVERY_CACHE_ENTRIES
              );
            }
          }
        } else {
          await cancelResponseQuietly(res);
        }
      } catch {}
      finally {
        clearTimeout(timeout);
      }
    }

    authoritativeOsSupport = Boolean(payload?.steamPlatforms || resolvedFromSteamApi);

    const resolvedSteamMacTotal =
      installedMacDiskSize ||
      installedDiskSize ||
      macParsedSize ||
      winParsedSize ||
      estimatedSizeBytes;
    const resolvedSteamWinTotal =
      installedWinDiskSize ||
      installedDiskSize ||
      winParsedSize ||
      macParsedSize ||
      estimatedSizeBytes;

    if (platform === 'darwin') {
      if (!macSupported && winSupported) {
        availableInstallers = [
          {
            id: 'steam-win-compat',
            name: `${titleLabel} (Windows Build via CrossOver — Windows Steam Bottle)`,
            os: 'windows',
            totalSizeBytes: resolvedSteamWinTotal,
          },
        ];
      } else {
        availableInstallers = [
          {
            id: 'steam-mac-native',
            name: `${titleLabel} (Steam Client — Native OS / Auto-Detect)`,
            os: 'mac',
            totalSizeBytes: resolvedSteamMacTotal,
          },
          {
            id: 'steam-win-compat',
            name: `${titleLabel} (Windows Build via CrossOver — Windows Steam Bottle)`,
            os: 'windows',
            totalSizeBytes: resolvedSteamWinTotal,
          },
        ];
      }
    } else {
      availableInstallers = [
        {
          id: 'steam-win-native',
          name: `${titleLabel} (Steam Client — Windows Native)`,
          os: 'windows',
          totalSizeBytes: resolvedSteamWinTotal,
        },
      ];
    }

    estimatedSizeBytes = sanitizeGameInstallSizeBytes(
      availableInstallers[0]?.totalSizeBytes || estimatedSizeBytes
    );
  } else if (platformId === 'xbox') {
    const titleLabel = payload.title || 'Game';
    const cleanStoreId = String(
      payload.xboxProductId || payload.storeId || platformGameId || ''
    )
      .replace(/^xbox[-_:]/i, '')
      .trim()
      .toUpperCase();
    const userDataDir = getUserDataDir(options.userDataDir);
    const xboxMods = getXboxStorefrontModules();
    const activeStoreSync = options.storeSync || storeSync;
    const authProvider =
      options.xboxAuthProvider ||
      (activeStoreSync && typeof activeStoreSync.getXboxAuthProvider === 'function'
        ? activeStoreSync.getXboxAuthProvider({ userDataDir })
        : null);

    const xboxDirs = collectXboxLibraryRoots({ ...options, platform });
    if (xboxDirs.length > 0) {
      defaultInstallDir = xboxDirs[0];
      availableInstallDirs = Array.from(new Set([...xboxDirs, ...availableInstallDirs]));
      diskSpace = await getDiskSpace(payload.targetInstallDir || defaultInstallDir, options);
    }

    const cachedSizes = cleanStoreId
      ? installInfoSizeCache.get(`${cacheScope}xbox:${cleanStoreId}`)
      : null;
    let resolvedDiskBytes = sanitizeGameInstallSizeBytes(
      cachedSizes?.diskSize || estimatedSizeBytes
    );
    let resolvedDlBytes = sanitizeGameInstallSizeBytes(
      cachedSizes?.downloadSize || payload.downloadSizeBytes
    );

    /** @type {any} */
    let deliveryInfo = options.mockXboxDeliveryInfo || null;
    if (
      !deliveryInfo &&
      cleanStoreId &&
      (!options.skipNetwork || typeof options.xboxPackageDeliveryResolver === 'function')
    ) {
      try {
        const resolveFn =
          options.xboxPackageDeliveryResolver || xboxMods?.resolveXboxPackageDeliveryInfo;
        if (typeof resolveFn === 'function') {
          deliveryInfo = await resolveFn({
            storeId: cleanStoreId,
            contentId: payload.contentId || payload.xboxDeliveryHints?.contentId,
            wuCategoryId: payload.wuCategoryId || payload.xboxDeliveryHints?.wuCategoryId,
            authProvider,
            userDataDir,
            fetchImpl: options.fetchImpl,
          });
        }
      } catch {}

      if (
        !deliveryInfo &&
        typeof xboxMods?.fetchXboxProductMetadata === 'function' &&
        !options.skipNetwork
      ) {
        try {
          const meta = await xboxMods.fetchXboxProductMetadata(
            { xboxProductId: cleanStoreId, userDataDir },
            { userDataDir, fetchImpl: options.fetchImpl }
          );
          if (meta) {
            deliveryInfo = {
              storeId: meta.xboxProductId || cleanStoreId,
              contentId: meta.contentId,
              wuCategoryId: meta.wuCategoryId,
              packageFamilyName: meta.packageFamilyName,
              packageFullName: meta.packageFullName,
              maxDownloadSizeBytes: meta.maxDownloadSizeBytes,
              pcMaxInstallSizeBytes: meta.pcMaxInstallSizeBytes,
              isExternalLauncherStubPackage: Boolean(meta.isExternalLauncherStubPackage),
              xboxBottleCompatibilityTier: meta.xboxBottleCompatibilityTier,
              xboxBottleCompatibilityReason: meta.xboxBottleCompatibilityReason,
              isCrossPlatformLauncherRuntime: Boolean(meta.isCrossPlatformLauncherRuntime),
              externalLauncher: meta.externalLauncher,
              externalLauncherUrl: meta.externalLauncherUrl,
              externalStorefrontHandoff: meta.externalStorefrontHandoff,
              downloadUrls: [],
            };
          }
        } catch {}
      }
    }

    const handoffId = normalizeChainedHandoffId(
      payload.chainedLauncherHandoff ||
        payload.chainedRequiresLauncherHandoff ||
        payload.externalStorefrontHandoff ||
        deliveryInfo?.chainedLauncherHandoff ||
        deliveryInfo?.chainedRequiresLauncherHandoff ||
        deliveryInfo?.externalStorefrontHandoff ||
        ''
    );
    const ecosystem = handoffId ? CHAINED_PUBLISHER_ECOSYSTEMS[handoffId] : null;
    const STUB_PACKAGE_MAX_BYTES = 32 * 1024 * 1024;
    const isChainedOrStubPackage = Boolean(
      handoffId || deliveryInfo?.isExternalLauncherStubPackage
    );

    if (deliveryInfo?.maxDownloadSizeBytes || deliveryInfo?.pcMaxInstallSizeBytes) {
      const candidateDlBytes = isChainedOrStubPackage
        ? Number(deliveryInfo?.pcMaxInstallSizeBytes || 0) > STUB_PACKAGE_MAX_BYTES
          ? deliveryInfo.pcMaxInstallSizeBytes
          : Number(deliveryInfo?.maxDownloadSizeBytes || 0) > STUB_PACKAGE_MAX_BYTES
            ? deliveryInfo.maxDownloadSizeBytes
            : undefined
        : deliveryInfo?.maxDownloadSizeBytes;
      const sanitizedMaxDl = sanitizeGameInstallSizeBytes(candidateDlBytes);
      if (sanitizedMaxDl) {
        resolvedDlBytes = resolvedDlBytes || sanitizedMaxDl;
        resolvedDiskBytes = resolvedDiskBytes || sanitizedMaxDl;
      }
    }

    const probeKey = cleanStoreId || payload.msixvcPath || deliveryInfo?.primaryDownloadUrl || '';
    let rawProbe =
      probeKey && (!isChainedOrStubPackage || options.mockXboxCompatibilityProbe)
        ? xboxCompatibilityProbeCache.get(probeKey)
        : null;
    const canProbeContainer = Boolean(
      options.mockXboxCompatibilityProbe ||
        (!isChainedOrStubPackage &&
          (payload.msixvcPath ||
            (!options.skipNetwork &&
              Array.isArray(deliveryInfo?.downloadUrls) &&
              deliveryInfo.downloadUrls.length > 0)))
    );

    if (!rawProbe && canProbeContainer) {
      if (options.mockXboxCompatibilityProbe) {
        rawProbe = options.mockXboxCompatibilityProbe;
      } else {
        const probeFn = options.probeMsixvcCompatibilityFn || xboxMods?.probeMsixvcCompatibility;
        if (typeof probeFn === 'function') {
          try {
            rawProbe = await probeFn({
              msixvcPath: payload.msixvcPath || undefined,
              urls: deliveryInfo?.downloadUrls,
              fetchImpl: options.fetchImpl,
              timeoutMs: 4500,
            });
          } catch {}
        }
      }
      if (rawProbe && probeKey) {
        setBoundedMapEntry(xboxCompatibilityProbeCache, probeKey, rawProbe, 500);
      }
    }

    if (rawProbe) {
      const extractedSz = sanitizeGameInstallSizeBytes(rawProbe.totalExtractedBytes);
      const containerSz = sanitizeGameInstallSizeBytes(rawProbe.totalContainerBytes);
      if (!isChainedOrStubPackage || (extractedSz && extractedSz > STUB_PACKAGE_MAX_BYTES)) {
        if (extractedSz) resolvedDiskBytes = extractedSz;
      }
      if (!isChainedOrStubPackage || (containerSz && containerSz > STUB_PACKAGE_MAX_BYTES)) {
        if (containerSz) resolvedDlBytes = containerSz;
      }

      xboxCompatibility = {
        tier: rawProbe.tier || 'tier_a_supported',
        canExtractAndRun: rawProbe.supportedOnMacBottle !== false,
        requiresCoreWindow: rawProbe.tier === 'tier_b_legacy_uwp',
        antiCheatDetected: rawProbe.tier === 'tier_c_kernel_anticheat',
        antiCheatSignals: Array.isArray(rawProbe.antiCheatSignals)
          ? rawProbe.antiCheatSignals
          : [],
        externalLauncher: rawProbe.externalLauncher || undefined,
        summary: rawProbe.reason || 'Supported GDK / Win32 x64 package',
        encryption: rawProbe.encryption,
      };
    }

    if (cleanStoreId && (resolvedDiskBytes || resolvedDlBytes)) {
      setBoundedMapEntry(
        installInfoSizeCache,
        `${cacheScope}xbox:${cleanStoreId}`,
        {
          diskSize: resolvedDiskBytes,
          downloadSize: resolvedDlBytes,
        },
        MAX_DISCOVERY_CACHE_ENTRIES
      );
    }

    const declaredExternalLauncher = String(
      payload.externalLauncher ||
        deliveryInfo?.externalLauncher ||
        rawProbe?.externalLauncher ||
        ''
    ).trim();
    const declaredExternalLauncherUrl = validateTrustedExternalLauncherUrl(
      payload.externalLauncherUrl ||
        deliveryInfo?.externalLauncherUrl ||
        rawProbe?.externalLauncherUrl ||
        ''
    );

    if (handoffId && ecosystem) {
      resolvedChainedHandoff = handoffId;
      externalLauncher = ecosystem.displayName;
      externalLauncherUrl = '';
      if (platform === 'darwin') {
        if (!ecosystem.supportedInWineBottle) {
          canDirectDownload = false;
          requiresStoreClientFallback = false;
          xboxCompatibility = {
            tier: 'tier_c_kernel_anticheat',
            canExtractAndRun: false,
            requiresCoreWindow: false,
            antiCheatDetected: true,
            antiCheatSignals: ['Riot Vanguard (vgk.sys)'],
            externalLauncher: ecosystem.displayName,
            externalStorefrontHandoff: handoffId,
            chainedLauncherHandoff: handoffId,
            summary:
              ecosystem.unsupportedBottleReason ||
              'Requires Riot Vanguard kernel anti-cheat (Windows native only).',
          };
          availableInstallers = [
            {
              id: 'xbox-chained-bottle-launcher',
              label: `Windows (${ecosystem.displayName})`,
              name: `${titleLabel} — Windows (${ecosystem.displayName})`,
              os: 'windows',
              externalLauncher: ecosystem.displayName,
              externalStorefrontHandoff: handoffId,
              chainedLauncherHandoff: handoffId,
            },
          ];
        } else {
          isCrossPlatformBottleInstall = true;
          canDirectDownload = true;
          requiresStoreClientFallback = false;
          xboxCompatibility = {
            tier: 'tier_c_external_launcher',
            canExtractAndRun: true,
            requiresCoreWindow: false,
            antiCheatDetected: false,
            antiCheatSignals: [],
            externalLauncher: ecosystem.displayName,
            externalStorefrontHandoff: handoffId,
            chainedLauncherHandoff: handoffId,
            summary: `Runs in Compatibility Bottle via ${ecosystem.displayName}. One Launcher automatically installs and opens ${ecosystem.displayName} inside your bottle.`,
          };
          availableInstallers = [
            {
              id: 'xbox-chained-bottle-launcher',
              label: `Windows (${ecosystem.displayName} in Bottle)`,
              name: `${titleLabel} — Windows (${ecosystem.displayName} in Bottle)`,
              os: 'windows',
              sizeBytes: resolvedDiskBytes,
              totalSizeBytes: resolvedDiskBytes,
              externalLauncher: ecosystem.displayName,
              externalStorefrontHandoff: handoffId,
              chainedLauncherHandoff: handoffId,
            },
          ];
        }
      } else {
        canDirectDownload = true;
        requiresStoreClientFallback = false;
        xboxCompatibility = {
          tier: 'tier_c_external_launcher',
          canExtractAndRun: true,
          requiresCoreWindow: false,
          antiCheatDetected: false,
          antiCheatSignals: [],
          externalLauncher: ecosystem.displayName,
          externalStorefrontHandoff: handoffId,
          chainedLauncherHandoff: handoffId,
          summary: `Installs via ${ecosystem.displayName} on Windows.`,
        };
        availableInstallers = [
          {
            id: 'xbox-chained-win-launcher',
            label: `Windows (${ecosystem.displayName})`,
            name: `${titleLabel} — Windows (${ecosystem.displayName})`,
            os: 'windows',
            sizeBytes: resolvedDiskBytes,
            totalSizeBytes: resolvedDiskBytes,
            externalLauncher: ecosystem.displayName,
            externalStorefrontHandoff: handoffId,
            chainedLauncherHandoff: handoffId,
          },
        ];
      }
    } else if (platform === 'darwin') {
      const isCrossPlatformLauncher =
        deliveryInfo?.isCrossPlatformLauncherRuntime === true ||
        Boolean(
          declaredExternalLauncher &&
            (!deliveryInfo?.downloadUrls || deliveryInfo.downloadUrls.length === 0) &&
            !deliveryInfo?.externalStorefrontHandoff &&
            !/ubisoft|ea\s*app|origin|battle\.net|blizzard|riot|rockstar/i.test(
              declaredExternalLauncher
            )
        );
      if (isCrossPlatformLauncher && declaredExternalLauncher) {
        externalLauncher = declaredExternalLauncher;
        externalLauncherUrl = declaredExternalLauncherUrl;
        canDirectDownload = false;
        requiresStoreClientFallback = true;
        xboxCompatibility = xboxCompatibility
          ? {
              ...xboxCompatibility,
              externalLauncher: declaredExternalLauncher,
              ...(declaredExternalLauncherUrl
                ? { externalLauncherUrl: declaredExternalLauncherUrl }
                : {}),
            }
          : {
              tier: 'tier_a_supported',
              canExtractAndRun: false,
              requiresCoreWindow: false,
              antiCheatDetected: false,
              antiCheatSignals: [],
              externalLauncher: declaredExternalLauncher,
              ...(declaredExternalLauncherUrl
                ? { externalLauncherUrl: declaredExternalLauncherUrl }
                : {}),
              summary: `Requires external launcher (${declaredExternalLauncher}).`,
            };
        availableInstallers = [
          {
            id: 'xbox-external-mac-launcher',
            label: `${titleLabel} — ${declaredExternalLauncher}`,
            name: `${titleLabel} — ${declaredExternalLauncher}`,
            os: 'mac',
            sizeBytes: resolvedDiskBytes,
            totalSizeBytes: resolvedDiskBytes,
            externalLauncher: declaredExternalLauncher,
            externalLauncherUrl: declaredExternalLauncherUrl,
          },
        ];
      } else {
        isCrossPlatformBottleInstall = true;
        canDirectDownload = xboxCompatibility
          ? xboxCompatibility.canExtractAndRun !== false
          : true;
        requiresStoreClientFallback = false;
        availableInstallers = [
          {
            id: 'xbox-msixvc-win',
            label: 'Windows (MSIXVC Direct Streaming Decrypt)',
            name: `${titleLabel} — Windows (MSIXVC Direct Streaming Decrypt via CrossOver / Wine)`,
            os: 'windows',
            sizeBytes: resolvedDiskBytes,
            totalSizeBytes: resolvedDiskBytes,
            ...(resolvedDlBytes ? { downloadSizeBytes: resolvedDlBytes } : {}),
          },
        ];
      }
    } else {
      const hasMsixvcUrls = Boolean(
        payload.msixvcPath ||
          (Array.isArray(deliveryInfo?.downloadUrls) && deliveryInfo.downloadUrls.length > 0)
      );
      const explicitlyRequestedClientless =
        payload.installerId === 'xbox-msixvc-win' ||
        payload.preferClientlessExtraction === true ||
        options.preferClientlessExtraction === true ||
        Boolean(payload.msixvcPath);
      const explicitlyRequestedGamingServices =
        !explicitlyRequestedClientless &&
        (payload.installerId === 'xbox-win-gamingservices' ||
          payload.preferClientlessExtraction === false);
      const preferClientless = Boolean(
        explicitlyRequestedClientless ||
          (!explicitlyRequestedGamingServices &&
            (options.hasGamingServices === false ||
              (!options.homedir && !hasWindowsGamingServicesInstalled(options))))
      );
      canDirectDownload = Boolean(preferClientless && hasMsixvcUrls);
      requiresStoreClientFallback = !canDirectDownload;

      availableInstallers = [
        {
          id: 'xbox-win-gamingservices',
          label: 'Windows Native (Xbox GamingServices)',
          name: `${titleLabel} — Windows Native (Xbox GamingServices)`,
          os: 'windows',
          sizeBytes: resolvedDiskBytes,
          totalSizeBytes: resolvedDiskBytes,
          ...(resolvedDlBytes ? { downloadSizeBytes: resolvedDlBytes } : {}),
        },
        ...(hasMsixvcUrls
          ? [
              {
                id: 'xbox-msixvc-win',
                label: 'Windows (MSIXVC Direct Streaming Decrypt)',
                name: `${titleLabel} — Windows (MSIXVC Direct Streaming Decrypt — Clientless)`,
                os: 'windows',
                sizeBytes: resolvedDiskBytes,
                totalSizeBytes: resolvedDiskBytes,
                ...(resolvedDlBytes ? { downloadSizeBytes: resolvedDlBytes } : {}),
              },
            ]
          : []),
      ];
    }

    estimatedSizeBytes = sanitizeGameInstallSizeBytes(
      resolvedDiskBytes || availableInstallers[0]?.totalSizeBytes || estimatedSizeBytes
    );
    downloadSizeBytes = sanitizeGameInstallSizeBytes(resolvedDlBytes);
  } else if (resolveAnyChainedHandoffId(platformId)) {
    const standaloneHandoff = resolveAnyChainedHandoffId(platformId);
    const ecosystem = standaloneHandoff ? CHAINED_PUBLISHER_ECOSYSTEMS[standaloneHandoff] : null;
    const titleLabel = payload.title || 'Game';
    if (standaloneHandoff && ecosystem) {
      resolvedChainedHandoff = standaloneHandoff;
      externalLauncher = ecosystem.displayName;
      externalLauncherUrl = '';
      if (platform === 'darwin') {
        isCrossPlatformBottleInstall = Boolean(ecosystem.supportedInWineBottle);
        canDirectDownload = Boolean(ecosystem.supportedInWineBottle);
        requiresStoreClientFallback = false;
        availableInstallers = [
          {
            id: 'xbox-chained-bottle-launcher',
            label: ecosystem.supportedInWineBottle
              ? `Windows (${ecosystem.displayName} in Bottle)`
              : `Windows (${ecosystem.displayName})`,
            name: ecosystem.supportedInWineBottle
              ? `${titleLabel} — Windows (${ecosystem.displayName} in Bottle)`
              : `${titleLabel} — Windows (${ecosystem.displayName})`,
            os: 'windows',
            sizeBytes: estimatedSizeBytes,
            totalSizeBytes: estimatedSizeBytes,
            externalLauncher: ecosystem.displayName,
            externalStorefrontHandoff: standaloneHandoff,
            chainedLauncherHandoff: standaloneHandoff,
          },
        ];
      } else {
        canDirectDownload = true;
        requiresStoreClientFallback = false;
        availableInstallers = [
          {
            id: 'xbox-chained-win-launcher',
            label: `Windows (${ecosystem.displayName})`,
            name: `${titleLabel} — Windows (${ecosystem.displayName})`,
            os: 'windows',
            sizeBytes: estimatedSizeBytes,
            totalSizeBytes: estimatedSizeBytes,
            externalLauncher: ecosystem.displayName,
            externalStorefrontHandoff: standaloneHandoff,
            chainedLauncherHandoff: standaloneHandoff,
          },
        ];
      }
    }
  }

  return {
    platformId,
    platformGameId,
    hostPlatform: platform,
    estimatedSizeBytes,
    ...(downloadSizeBytes ? { downloadSizeBytes } : {}),
    ...(dlcSizeBytes ? { dlcSizeBytes } : {}),
    ...(authoritativeOsSupport !== undefined ? { authoritativeOsSupport } : {}),
    defaultInstallDir,
    availableInstallDirs,
    availableInstallers,
    canDirectDownload,
    requiresStoreClientFallback,
    ...(isCrossPlatformBottleInstall ? { isCrossPlatformBottleInstall: true } : {}),
    ...(xboxCompatibility ? { xboxCompatibility } : {}),
    ...(resolvedChainedHandoff
      ? {
          externalStorefrontHandoff: resolvedChainedHandoff,
          chainedLauncherHandoff: resolvedChainedHandoff,
        }
      : {}),
    ...(resolvedChainedTopology ? { chainedHandoffTopology: resolvedChainedTopology } : {}),
    ...(resolvedEpicRegistryPath ? { epicPartnerRegistryPath: resolvedEpicRegistryPath } : {}),
    ...(externalLauncher !== undefined
      ? { externalLauncher, externalLauncherUrl: externalLauncherUrl ?? '' }
      : {}),
    diskSpace,
  };
}

module.exports = {
  sortPathsNewestFirst,
  getGameInstallInfo,
};
