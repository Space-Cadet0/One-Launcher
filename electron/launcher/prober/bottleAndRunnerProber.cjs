// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  isTestEnvironment,
  registerExternalCacheInvalidator,
  safeIsBottleSlug,
} = require('../engineStateRegistry.cjs');
const { toHostFilesystemPath } = require('../securityAndPathUtils.cjs');
const {
  resolveDriveCPathCaseInsensitive,
  resolveBottleSteamExe,
} = require('../wineAndCrossOverManager.cjs');
const { resolveDefaultChainedBottleName } = require('../chainedPublisherLaunchers.cjs');
const { explicitHomedirOpt, resolveReadOnlyPaths } = require('./setupWizardStateStore.cjs');

/**
 * @typedef {import('./setupWizardStateStore.cjs').NonNativeRunnerType} NonNativeRunnerType
 * @typedef {import('./setupWizardStateStore.cjs').SetupWizardPersistedState} SetupWizardPersistedState
 * @typedef {import('./setupWizardStateStore.cjs').BottleEnvironmentSummary} BottleEnvironmentSummary
 */

const RUNNER_UPDATE_CHECK_CACHE_FILENAME = 'one_launcher_runner_update_check_cache.json';
const PROBER_RUNNER_UPDATES_TTL_MS = 24 * 60 * 60 * 1000; // 24-hour persisted + in-memory TTL

/** @type {{ userDataDir: string, key: string, expiresAt: number, value: Record<string, any> | null }} */
let cachedProberRunnerUpdates = { userDataDir: '', key: '', expiresAt: 0, value: null };

/**
 * Lazy accessor breaking the circular `require()` cycle between `environmentHealthProber.cjs`
 * and `macNativeInstallerAndCodesign.cjs` during module initialization.
 *
 * @returns {Record<string, any>}
 */
function getMacNativeInstaller() {
  return /** @type {Record<string, any>} */ (require('../macNativeInstallerAndCodesign.cjs'));
}

/**
 * Resolve the path to the 24-hour runner update check cache file in `userDataDir`.
 *
 * @param {string} userDataDir
 * @returns {string}
 */
function getRunnerUpdateCheckCachePath(userDataDir) {
  return path.join(userDataDir, RUNNER_UPDATE_CHECK_CACHE_FILENAME);
}

/**
 * Build a deterministic cache key capturing installed runner versions and paths.
 *
 * @param {any[]} detectedRunners
 * @returns {string}
 */
function buildRunnerUpdatesLayersKey(detectedRunners) {
  return (Array.isArray(detectedRunners) ? detectedRunners : [])
    .map(
      (r) =>
        `${r.type}:${r.version || ''}:${r.buildVersion || ''}:${r.previewDate || ''}:${r.appPath || r.binaryPath || ''}`
    )
    .join('|');
}

/**
 * Read the persisted 24-hour runner update check cache from `<userDataDir>/one_launcher_runner_update_check_cache.json`.
 *
 * @param {string} userDataDir
 * @param {string} layersCacheKey
 * @param {number} nowMs
 * @returns {Promise<{ updates: Record<string, any>, expiresAt: number } | null>}
 */
async function readPersistedRunnerUpdateCheckCacheAsync(userDataDir, layersCacheKey, nowMs) {
  if (!userDataDir) return null;
  try {
    const cachePath = getRunnerUpdateCheckCachePath(userDataDir);
    const raw = await fs.promises.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.layersKey !== layersCacheKey ||
      !parsed.updates ||
      typeof parsed.updates !== 'object' ||
      Array.isArray(parsed.updates)
    ) {
      return null;
    }
    const checkedAt = Number(parsed.checkedAt || 0);
    const expiresAt = Number(parsed.expiresAt || checkedAt + PROBER_RUNNER_UPDATES_TTL_MS);
    if (
      !Number.isFinite(checkedAt) ||
      checkedAt <= 0 ||
      nowMs - checkedAt >= PROBER_RUNNER_UPDATES_TTL_MS ||
      (Number.isFinite(expiresAt) && nowMs >= expiresAt)
    ) {
      return null;
    }
    return { updates: parsed.updates, expiresAt };
  } catch {
    return null;
  }
}

/**
 * Atomically persist the 24-hour runner update check cache into `userDataDir`.
 * Explicitly separated from read-only probing so `{ readOnly: true }` probes perform 0 disk writes.
 *
 * @param {string} userDataDir
 * @param {string} layersCacheKey
 * @param {Record<string, any>} updates
 * @param {number} nowMs
 */
async function writePersistedRunnerUpdateCheckCacheAsync(
  userDataDir,
  layersCacheKey,
  updates,
  nowMs
) {
  if (!userDataDir || !updates || typeof updates !== 'object') return;
  try {
    const cachePath = getRunnerUpdateCheckCachePath(userDataDir);
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({
      schemaVersion: 1,
      layersKey: layersCacheKey,
      checkedAt: nowMs,
      expiresAt: nowMs + PROBER_RUNNER_UPDATES_TTL_MS,
      updates,
    });
    const suffix = crypto.randomBytes(6).toString('hex');
    const tmpPath = `${cachePath}.${process.pid}.${suffix}.tmp`;
    try {
      await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tmpPath, cachePath);
    } catch {
      try {
        await fs.promises.unlink(tmpPath);
      } catch {}
      await fs.promises.writeFile(cachePath, payload, { encoding: 'utf8', mode: 0o600 });
    }
  } catch {}
}

/**
 * Invalidate in-memory (and optionally on-disk) runner update check caches.
 *
 * @param {Record<string, any>} [options]
 */
function invalidateProberRunnerUpdatesCache(options = {}) {
  cachedProberRunnerUpdates = { userDataDir: '', key: '', expiresAt: 0, value: null };
  if (!options?.memoryOnly) {
    try {
      const targetUserDataDir =
        typeof options?.userDataDir === 'string' && options.userDataDir.trim()
          ? toHostFilesystemPath(options.userDataDir.trim())
          : !isTestEnvironment(options)
            ? resolveReadOnlyPaths(options).userDataDir
            : '';
      if (targetUserDataDir) {
        const cachePath = getRunnerUpdateCheckCachePath(targetUserDataDir);
        if (fs.existsSync(cachePath)) {
          fs.unlinkSync(cachePath);
        }
      }
    } catch {}
  }
  if (!options?.skipPreviewUrlCacheClear) {
    try {
      const macNative = getMacNativeInstaller();
      if (typeof macNative?.clearCachedAuthenticatedPreviewUrl === 'function') {
        macNative.clearCachedAuthenticatedPreviewUrl(undefined, { skipProberInvalidation: true });
      }
    } catch {}
  }
}

registerExternalCacheInvalidator((invOpts) => {
  invalidateProberRunnerUpdatesCache(invOpts);
});

/**
 * Resolve compatibility runner updates using in-memory/on-disk 24h caches and optional network check.
 * When `options.readOnly === true` or `options.persistRunnerUpdateCache === false`, strictly performs
 * ZERO disk writes (reads persisted cache + populates memory cache only).
 *
 * @param {'darwin' | 'win32' | 'linux'} hostPlatform
 * @param {string} userDataDir
 * @param {any[]} detectedRunners
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function resolveProberRunnerUpdatesAsync(
  hostPlatform,
  userDataDir,
  detectedRunners,
  options = {}
) {
  if (hostPlatform !== 'darwin') {
    return {};
  }
  const macNative = getMacNativeInstaller();
  const checkUpdatesImpl =
    typeof options.checkCompatibilityLayerUpdatesFn === 'function'
      ? options.checkCompatibilityLayerUpdatesFn
      : macNative.checkCompatibilityLayerUpdates;
  const hasInlineFixtureOverrides = Boolean(
    options.mockFeeds || options.previewCandidateUrls || options.previewPortalHtml
  );
  const hasNetworkHandlerOverride = Boolean(
    typeof options.httpGetText === 'function' ||
      typeof options.previewSessionFetch === 'function' ||
      typeof options.sessionFetch === 'function' ||
      (typeof options.fetchFn === 'function' && options.skipNetwork !== true) ||
      typeof options.checkCompatibilityLayerUpdatesFn === 'function'
  );

  if (options.runnerUpdates && typeof options.runnerUpdates === 'object') {
    return options.runnerUpdates;
  }

  if (hasInlineFixtureOverrides) {
    try {
      return (
        (await checkUpdatesImpl({
          ...options,
          ...explicitHomedirOpt(options),
          layers: detectedRunners,
          timeoutMs: Number(options.runnerUpdateTimeoutMs || 3500),
          ...(options.mockFeeds ? { skipNetwork: true } : {}),
        })) || {}
      );
    } catch {
      return {};
    }
  }

  if (
    options.offline === true ||
    (!hasNetworkHandlerOverride && (isTestEnvironment(options) || options.skipNetwork === true))
  ) {
    return {};
  }

  const layersCacheKey = buildRunnerUpdatesLayersKey(detectedRunners);
  const nowMs =
    typeof options.nowMs === 'number' && Number.isFinite(options.nowMs)
      ? options.nowMs
      : Date.now();
  const shouldBypassCache =
    options.forceRefresh === true ||
    options.forceRefreshRunnerUpdates === true ||
    options.forceFresh === true;
  const allowDiskPersist =
    options.readOnly !== true &&
    options.persistRunnerUpdateCache !== false &&
    options.skipNetwork !== true &&
    options.offline !== true;

  if (!shouldBypassCache) {
    if (
      cachedProberRunnerUpdates.value &&
      cachedProberRunnerUpdates.userDataDir === userDataDir &&
      cachedProberRunnerUpdates.key === layersCacheKey &&
      nowMs < cachedProberRunnerUpdates.expiresAt
    ) {
      return cachedProberRunnerUpdates.value;
    }
    const persisted = await readPersistedRunnerUpdateCheckCacheAsync(
      userDataDir,
      layersCacheKey,
      nowMs
    );
    if (persisted) {
      cachedProberRunnerUpdates = {
        userDataDir,
        key: layersCacheKey,
        expiresAt: persisted.expiresAt,
        value: persisted.updates,
      };
      return persisted.updates;
    }
  }

  try {
    const runnerUpdates =
      (await checkUpdatesImpl({
        ...options,
        ...explicitHomedirOpt(options),
        layers: detectedRunners,
        timeoutMs: Number(options.runnerUpdateTimeoutMs || 3500),
      })) || {};
    if (
      runnerUpdates &&
      typeof runnerUpdates === 'object' &&
      (Object.keys(runnerUpdates).length > 0 || detectedRunners.length === 0)
    ) {
      cachedProberRunnerUpdates = {
        userDataDir,
        key: layersCacheKey,
        expiresAt: nowMs + PROBER_RUNNER_UPDATES_TTL_MS,
        value: runnerUpdates,
      };
      if (allowDiskPersist) {
        await writePersistedRunnerUpdateCheckCacheAsync(
          userDataDir,
          layersCacheKey,
          runnerUpdates,
          nowMs
        );
      }
    }
    return runnerUpdates;
  } catch {
    return {};
  }
}

/**
 * Explicitly refresh and persist the 24-hour runner update cache outside read-only probes.
 *
 * @param {string} userDataDir
 * @param {any[]} detectedRunners
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function refreshRunnerUpdateCheckCacheAsync(userDataDir, detectedRunners, options = {}) {
  return resolveProberRunnerUpdatesAsync('darwin', userDataDir, detectedRunners, {
    ...options,
    readOnly: false,
    persistRunnerUpdateCache: true,
    forceRefresh: options.forceRefresh !== false,
  });
}

/**
 * Detect installed macOS compatibility layers in read-only mode via lazy getter.
 *
 * @param {Record<string, any>} [options]
 * @returns {any[]}
 */
function detectRunnersReadOnly(options = {}) {
  try {
    const macNative = getMacNativeInstaller();
    if (typeof macNative?.detectCompatibilityLayers !== 'function') return [];
    return (
      macNative.detectCompatibilityLayers({
        ...options,
        ...explicitHomedirOpt(options),
        readOnly: true,
      }) || []
    );
  } catch {
    return [];
  }
}

/**
 * Enumerate per-user profile directories inside a Wine/CrossOver bottle (`drive_c/users/<name>`),
 * prioritizing `crossover` and real user profiles ahead of system folders (`Public`, `Default`).
 *
 * @param {string} activeBottlePath
 * @returns {Promise<string[]>}
 */
async function listBottleUserDirsAsync(activeBottlePath) {
  if (!activeBottlePath) return [];
  const usersDir = resolveDriveCPathCaseInsensitive(path.join(activeBottlePath, 'drive_c'), [
    'users',
  ]);
  try {
    const dirents = await fs.promises.readdir(usersDir, { withFileTypes: true });
    const deprioritizedUsers = new Set(['public', 'all users', 'default', 'default user']);
    return dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .sort((a, b) => {
        const aLower = a.name.toLowerCase();
        const bLower = b.name.toLowerCase();
        if (aLower === 'crossover' && bLower !== 'crossover') return -1;
        if (bLower === 'crossover' && aLower !== 'crossover') return 1;
        const aDeprio = deprioritizedUsers.has(aLower);
        const bDeprio = deprioritizedUsers.has(bLower);
        if (aDeprio !== bDeprio) return aDeprio ? 1 : -1;
        return a.name.localeCompare(b.name);
      })
      .map((d) => path.join(usersDir, d.name));
  } catch {
    return [];
  }
}

/**
 * Check whether a Wine/CrossOver bottle has sandboxed user Documents/My Documents folders
 * (not symlinked out to the macOS host `~/Documents`). Read-only (`lstat` + `readlink` only).
 *
 * @param {string} bottlePath
 * @returns {boolean}
 */
function isBottleUserFoldersSandboxedReadOnly(bottlePath) {
  if (!bottlePath || !fs.existsSync(bottlePath)) return false;
  const resolvedBottle = path.resolve(bottlePath);
  const usersDir = resolveDriveCPathCaseInsensitive(path.join(resolvedBottle, 'drive_c'), ['users']);
  if (!fs.existsSync(usersDir)) return false;

  try {
    const userEntries = fs.readdirSync(usersDir, { withFileTypes: true });
    for (const userEntry of userEntries) {
      if (!userEntry.isDirectory() || userEntry.name.startsWith('.')) continue;
      if (userEntry.name.toLowerCase() === 'public') continue;
      const userRoot = path.join(usersDir, userEntry.name);
      for (const docFolder of ['Documents', 'My Documents']) {
        const entryPath = path.join(userRoot, docFolder);
        try {
          const st = fs.lstatSync(entryPath);
          if (st.isSymbolicLink()) {
            const rawTarget = String(fs.readlinkSync(entryPath) || '').replace(/^\\\\\?\\/, '');
            const resolvedTarget = path.resolve(path.dirname(entryPath), rawTarget);
            const insidePrefix =
              resolvedTarget === resolvedBottle ||
              resolvedTarget.startsWith(resolvedBottle + path.sep);
            if (!insidePrefix) {
              return false;
            }
          }
        } catch {}
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Async variant of `isBottleUserFoldersSandboxedReadOnly` for non-blocking health probes.
 *
 * @param {string} bottlePath
 * @returns {Promise<boolean>}
 */
async function isBottleUserFoldersSandboxedReadOnlyAsync(bottlePath) {
  if (!bottlePath) return false;
  const resolvedBottle = path.resolve(bottlePath);
  try {
    await fs.promises.access(resolvedBottle, fs.constants.F_OK);
  } catch {
    return false;
  }
  const usersDir = resolveDriveCPathCaseInsensitive(path.join(resolvedBottle, 'drive_c'), ['users']);
  try {
    const userEntries = await fs.promises.readdir(usersDir, { withFileTypes: true });
    for (const userEntry of userEntries) {
      if (!userEntry.isDirectory() || userEntry.name.startsWith('.')) continue;
      if (userEntry.name.toLowerCase() === 'public') continue;
      const userRoot = path.join(usersDir, userEntry.name);
      for (const docFolder of ['Documents', 'My Documents']) {
        const entryPath = path.join(userRoot, docFolder);
        try {
          const st = await fs.promises.lstat(entryPath);
          if (st.isSymbolicLink()) {
            const rawTarget = String((await fs.promises.readlink(entryPath)) || '').replace(
              /^\\\\\?\\/,
              ''
            );
            const resolvedTarget = path.resolve(path.dirname(entryPath), rawTarget);
            const insidePrefix =
              resolvedTarget === resolvedBottle ||
              resolvedTarget.startsWith(resolvedBottle + path.sep);
            if (!insidePrefix) {
              return false;
            }
          }
        } catch {}
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve active bottle context from detected runners & wizard preferences asynchronously.
 *
 * @param {'darwin' | 'win32' | 'linux'} hostPlatform
 * @param {string} homedir
 * @param {any[]} detectedRunners
 * @param {SetupWizardPersistedState} wizardState
 * @param {Record<string, any>} options
 * @returns {Promise<BottleEnvironmentSummary>}
 */
async function buildBottleEnvironmentSummaryAsync(
  hostPlatform,
  homedir,
  detectedRunners,
  wizardState,
  options
) {
  if (hostPlatform !== 'darwin') {
    return {
      runnerType: null,
      runnerInstalled: false,
      availableBottles: [],
      recommendedBottleMode: 'create_dedicated',
      recommendedBottleName: 'OneLauncher',
    };
  }

  const macNative = getMacNativeInstaller();
  const {
    isValidBottleDirectory,
    inspectBottleConfMetadata,
    resolveBottleGogGalaxyExe,
    resolveBottleEpicLauncherExe,
  } = macNative;

  const isMockHomedir = Boolean(options.homedir || options.customApplicationsDir);
  /** @type {Array<{ name: string, path: string, runnerType: NonNativeRunnerType, wineArch?: 'win64' | 'arm64', bottleArch?: 'win64' | 'arm64', previewEnabled?: boolean, hasSteam: boolean, hasGogGalaxy: boolean, hasEpicLauncher: boolean, isSandboxed: boolean }>} */
  const availableBottles = [];
  /** @type {Set<string>} */
  const seenBottlePaths = new Set();

  const preferredRunner =
    wizardState.preferredRunnerType && wizardState.preferredRunnerType !== 'skip'
      ? detectedRunners.find((r) => r.type === wizardState.preferredRunnerType)
      : null;
  const activeRunner = preferredRunner || detectedRunners[0] || null;

  const orderedRunners = activeRunner
    ? [activeRunner, ...detectedRunners.filter((r) => r !== activeRunner)]
    : detectedRunners;

  /**
   * @param {string} filePath
   * @returns {Promise<boolean>}
   */
  const existsAsync = async (filePath) => {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  };

  for (const layer of orderedRunners) {
    if (
      (layer.type === 'crossover' ||
        layer.type === 'crossover_preview' ||
        layer.type === 'crossover_preview_arm64') &&
      layer.bottlesDir &&
      Array.isArray(layer.availableBottles)
    ) {
      for (const bottleName of layer.availableBottles) {
        const bottlePath = path.join(layer.bottlesDir, bottleName);
        const resolvedKey = path.resolve(bottlePath);
        if (seenBottlePaths.has(resolvedKey)) continue;
        if (!isValidBottleDirectory(bottlePath, isMockHomedir)) continue;
        seenBottlePaths.add(resolvedKey);
        const detailMeta = layer.bottleDetails?.[bottleName] || {};
        const confMeta = inspectBottleConfMetadata(bottlePath);
        const hasBottleConf = await existsAsync(path.join(bottlePath, 'cxbottle.conf'));
        /** @type {'win64' | 'arm64'} */
        const wineArch =
          confMeta.wineArch ||
          detailMeta.wineArch ||
          (hasBottleConf ? 'win64' : layer.type === 'crossover_preview_arm64' ? 'arm64' : 'win64');
        const previewEnabled =
          confMeta.previewEnabled !== undefined
            ? confMeta.previewEnabled
            : detailMeta.previewEnabled;
        const effectiveRunnerType =
          wineArch === 'arm64'
            ? /** @type {NonNativeRunnerType} */ ('crossover_preview_arm64')
            : layer.type === 'crossover_preview_arm64'
              ? /** @type {NonNativeRunnerType} */ (
                  previewEnabled ? 'crossover_preview' : 'crossover'
                )
              : /** @type {NonNativeRunnerType} */ (layer.type);
        availableBottles.push({
          name: bottleName,
          path: bottlePath,
          runnerType: effectiveRunnerType,
          wineArch,
          bottleArch: wineArch,
          ...(previewEnabled !== undefined ? { previewEnabled } : {}),
          hasSteam: Boolean(resolveBottleSteamExe(bottlePath)),
          hasGogGalaxy: Boolean(resolveBottleGogGalaxyExe(bottlePath)),
          hasEpicLauncher: Boolean(resolveBottleEpicLauncherExe(bottlePath)),
          isSandboxed: await isBottleUserFoldersSandboxedReadOnlyAsync(bottlePath),
        });
      }
    }
  }

  const directBottleRoots = [
    {
      bottlesDir: path.join(homedir, 'Library/Application Support/CrossOver/Bottles'),
      runnerType: /** @type {NonNativeRunnerType} */ ('crossover'),
    },
    {
      bottlesDir: path.join(homedir, 'Library/Application Support/CrossOver Preview/Bottles'),
      runnerType: /** @type {NonNativeRunnerType} */ ('crossover_preview'),
    },
    {
      bottlesDir: path.join(homedir, 'Library/Application Support/CrossOver Preview arm64/Bottles'),
      runnerType: /** @type {NonNativeRunnerType} */ ('crossover_preview_arm64'),
    },
  ];
  for (const rootSpec of directBottleRoots) {
    /** @type {string[]} */
    let subdirs = [];
    try {
      const dirents = await fs.promises.readdir(rootSpec.bottlesDir, { withFileTypes: true });
      subdirs = dirents
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const bottleName of subdirs) {
      if (!safeIsBottleSlug(bottleName)) continue;
      const bottlePath = path.join(rootSpec.bottlesDir, bottleName);
      const resolvedKey = path.resolve(bottlePath);
      if (seenBottlePaths.has(resolvedKey)) continue;
      if (!isValidBottleDirectory(bottlePath, isMockHomedir)) continue;
      seenBottlePaths.add(resolvedKey);
      const confMeta = inspectBottleConfMetadata(bottlePath);
      const hasBottleConf = await existsAsync(path.join(bottlePath, 'cxbottle.conf'));
      /** @type {'win64' | 'arm64'} */
      const wineArch =
        confMeta.wineArch ||
        (hasBottleConf ? 'win64' : rootSpec.runnerType === 'crossover_preview_arm64' ? 'arm64' : 'win64');
      const effectiveRunnerType =
        wineArch === 'arm64'
          ? /** @type {NonNativeRunnerType} */ ('crossover_preview_arm64')
          : confMeta.previewEnabled
            ? /** @type {NonNativeRunnerType} */ ('crossover_preview')
            : rootSpec.runnerType === 'crossover_preview_arm64'
              ? /** @type {NonNativeRunnerType} */ ('crossover')
              : rootSpec.runnerType;
      availableBottles.push({
        name: bottleName,
        path: bottlePath,
        runnerType: effectiveRunnerType,
        wineArch,
        bottleArch: wineArch,
        ...(confMeta.previewEnabled !== undefined
          ? { previewEnabled: confMeta.previewEnabled }
          : {}),
        hasSteam: Boolean(resolveBottleSteamExe(bottlePath)),
        hasGogGalaxy: Boolean(resolveBottleGogGalaxyExe(bottlePath)),
        hasEpicLauncher: Boolean(resolveBottleEpicLauncherExe(bottlePath)),
        isSandboxed: await isBottleUserFoldersSandboxedReadOnlyAsync(bottlePath),
      });
    }
  }

  const standaloneRunner =
    orderedRunners.find((r) => r.type === 'wine' || r.type === 'gptk') || null;
  if (standaloneRunner) {
    const prefixCandidates = [
      {
        name: 'default',
        path: path.join(homedir, 'Games/OneLauncher/Prefixes/default'),
      },
      {
        name: 'Heroic-default',
        path: path.join(homedir, 'Games/Heroic/Prefixes/default'),
      },
    ];
    for (const cand of prefixCandidates) {
      const resolvedKey = path.resolve(cand.path);
      if (seenBottlePaths.has(resolvedKey)) continue;
      if (!isValidBottleDirectory(cand.path, isMockHomedir)) continue;
      seenBottlePaths.add(resolvedKey);
      availableBottles.push({
        name: cand.name,
        path: cand.path,
        runnerType: /** @type {NonNativeRunnerType} */ (standaloneRunner.type),
        wineArch: 'win64',
        bottleArch: 'win64',
        hasSteam: Boolean(resolveBottleSteamExe(cand.path)),
        hasGogGalaxy: Boolean(resolveBottleGogGalaxyExe(cand.path)),
        hasEpicLauncher: Boolean(resolveBottleEpicLauncherExe(cand.path)),
        isSandboxed: await isBottleUserFoldersSandboxedReadOnlyAsync(cand.path),
      });
    }
  }

  const compatibleBottles =
    activeRunner?.type === 'crossover_preview_arm64'
      ? availableBottles.filter((b) => b.wineArch === 'arm64')
      : activeRunner?.type === 'crossover' || activeRunner?.type === 'crossover_preview'
        ? availableBottles.filter((b) => b.wineArch !== 'arm64')
        : availableBottles;

  if (compatibleBottles.length > 0) {
    const preferredExisting =
      wizardState.preferredBottleName && safeIsBottleSlug(wizardState.preferredBottleName)
        ? compatibleBottles.find(
            (b) =>
              b.name.toLowerCase() === String(wizardState.preferredBottleName).trim().toLowerCase()
          )
        : null;
    const resolvedExistingName = resolveDefaultChainedBottleName({
      wizardPreferredBottleName: preferredExisting ? preferredExisting.name : undefined,
      discoveredBottleNames: compatibleBottles,
      runnerType: activeRunner?.type,
    });
    const chosenBottle =
      compatibleBottles.find((b) => b.name === resolvedExistingName) || compatibleBottles[0];

    return {
      runnerType: activeRunner
        ? /** @type {NonNativeRunnerType} */ (activeRunner.type)
        : chosenBottle.runnerType,
      ...(activeRunner?.name ? { runnerName: activeRunner.name } : {}),
      runnerInstalled: Boolean(activeRunner),
      availableBottles,
      recommendedBottleMode: 'reuse_existing',
      recommendedBottleName: chosenBottle.name,
      activeBottlePath: chosenBottle.path,
      ...(chosenBottle.wineArch
        ? { wineArch: chosenBottle.wineArch, bottleArch: chosenBottle.wineArch }
        : {}),
    };
  }

  const isWizardPrefArchMismatch = Boolean(
    wizardState.preferredBottleName &&
      ((activeRunner?.type === 'crossover_preview_arm64' &&
        availableBottles.some(
          (b) =>
            b.name.toLowerCase() === String(wizardState.preferredBottleName).trim().toLowerCase() &&
            b.wineArch !== 'arm64'
        )) ||
        ((activeRunner?.type === 'crossover' || activeRunner?.type === 'crossover_preview') &&
          availableBottles.some(
            (b) =>
              b.name.toLowerCase() ===
                String(wizardState.preferredBottleName).trim().toLowerCase() &&
              b.wineArch === 'arm64'
          )))
  );
  const defaultBottleName = resolveDefaultChainedBottleName({
    wizardPreferredBottleName: isWizardPrefArchMismatch
      ? undefined
      : wizardState.preferredBottleName,
    discoveredBottleNames: [],
    runnerType: activeRunner?.type,
  });

  const targetArch = activeRunner?.type === 'crossover_preview_arm64' ? 'arm64' : 'win64';
  return {
    runnerType: activeRunner ? /** @type {NonNativeRunnerType} */ (activeRunner.type) : null,
    ...(activeRunner?.name ? { runnerName: activeRunner.name } : {}),
    runnerInstalled: Boolean(activeRunner),
    availableBottles,
    recommendedBottleMode: 'create_dedicated',
    recommendedBottleName: defaultBottleName,
    ...(activeRunner ? { wineArch: targetArch, bottleArch: targetArch } : {}),
  };
}

module.exports = {
  RUNNER_UPDATE_CHECK_CACHE_FILENAME,
  PROBER_RUNNER_UPDATES_TTL_MS,
  getMacNativeInstaller,
  getRunnerUpdateCheckCachePath,
  buildRunnerUpdatesLayersKey,
  readPersistedRunnerUpdateCheckCacheAsync,
  writePersistedRunnerUpdateCheckCacheAsync,
  resolveProberRunnerUpdatesAsync,
  refreshRunnerUpdateCheckCacheAsync,
  invalidateProberRunnerUpdatesCache,
  detectRunnersReadOnly,
  listBottleUserDirsAsync,
  isBottleUserFoldersSandboxedReadOnly,
  isBottleUserFoldersSandboxedReadOnlyAsync,
  buildBottleEnvironmentSummaryAsync,
};
