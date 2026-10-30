// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const {
  getElectron,
  getStoreSync,
  getConfiguredUserDataDir,
  resolveIsolatedHomedirAndUserData,
  findGogdlBinary,
  findLegendaryBinary,
  safeIsBottleSlug,
} = require('./engineStateRegistry.cjs');
const {
  toHostFilesystemPath,
  atomicWriteFileSync,
  isStoreDisconnectedTombstoned,
} = require('./securityAndPathUtils.cjs');
const {
  resolveDriveCPathCaseInsensitive,
  resolveBottleSteamExe,
  resolveXboxBridgeDllPath,
  resolveBundledGameInputBridgeDllPath,
} = require('./wineAndCrossOverManager.cjs');
const {
  isValidBottleDirectory,
  detectCompatibilityLayers,
  checkCompatibilityLayerUpdates,
  resolveBottleGogGalaxyExe,
  resolveBottleEpicLauncherExe,
} = require('./macNativeInstallerAndCodesign.cjs');
const {
  resolveSteamClientBinaryPath,
} = require('./sessionAndProcessSupervisor.cjs');
const {
  resolveGogGalaxyClientBinaryPath,
} = require('./gogRegistryAndDirectInstaller.cjs');
const {
  resolveEpicClientBinaryPath,
  isMockOrCorruptedToken,
  isPoisonedStorefrontToken,
} = require('./epicLegendaryAndEosCoordinator.cjs');
const {
  hasWindowsGamingServicesInstalled,
} = require('./diskAndVolumeInspector.cjs');
const {
  resolveXboxClientBinaryPath,
} = require('./windowsXboxAppxAndMsixvcOrchestrator.cjs');
const {
  steamId64ToAccountId32,
} = require('../storefronts/steamLocalScanner.cjs');

/**
 * @typedef {'rosetta2' | 'win_vcredist' | 'win_webview2' | 'runner_crossover' | 'runner_crossover_preview' | 'runner_wine' | 'runner_gptk' | 'bottle_default' | 'host_steam' | 'bottle_steam' | 'host_gog' | 'bottle_gog' | 'host_epic' | 'bottle_epic' | 'xbox_runtime'} EnvironmentComponentId
 * @typedef {'os_prerequisite' | 'compatibility_runner' | 'bottle' | 'host_client' | 'bottle_client' | 'built_in_runtime'} EnvironmentComponentCategory
 * @typedef {'ready' | 'partially_configured' | 'missing' | 'update_available' | 'not_applicable'} EnvironmentComponentStatus
 * @typedef {'required' | 'recommended' | 'optional' | 'not_needed' | 'built_in'} RecommendationTier
 * @typedef {'host_steam' | 'bottle_steam' | 'host_gog' | 'bottle_gog' | 'host_epic' | 'bottle_epic'} ClientLoginTargetId
 * @typedef {'crossover' | 'crossover_preview' | 'gptk' | 'wine'} NonNativeRunnerType
 * @typedef {'steam' | 'gog' | 'epic' | 'amazon' | 'xbox' | 'ubisoft' | 'ea' | 'bnet' | 'itch' | 'rockstar' | 'humble' | 'custom'} StorefrontId
 */

/**
 * @typedef {object} SetupWizardPersistedState
 * @property {1} schemaVersion
 * @property {string | null} completedAt
 * @property {string | null} dismissedAt
 * @property {string | null} lastHealthCheckAt
 * @property {NonNativeRunnerType | 'skip'} [preferredRunnerType]
 * @property {string} [preferredBottleName]
 * @property {EnvironmentComponentId[]} configuredComponents
 * @property {boolean} [allowAutoOpenInTest]
 */

/**
 * @typedef {object} DiscoveredLocalStoreHint
 * @property {'steam' | 'gog' | 'epic'} storefrontId
 * @property {string} sourceLabel
 * @property {boolean} hasReusableSession
 * @property {string} [publicHandleHint]
 * @property {string} [publicSteamId]
 */

/**
 * @typedef {object} ClientAuthProbeState
 * @property {ClientLoginTargetId} targetId
 * @property {'steam' | 'gog' | 'epic'} storefrontId
 * @property {'host' | 'bottle'} scope
 * @property {string} label
 * @property {boolean} installed
 * @property {string} [binaryPath]
 * @property {string} [bottleName]
 * @property {string} [bottlePath]
 * @property {boolean} authenticated
 * @property {boolean} [autoLoginEnabled]
 * @property {string} [detectedAccountLabel]
 * @property {boolean | null} accountMatchesOneLauncher
 * @property {string} [mismatchReason]
 * @property {string} statusSummary
 */

/**
 * @typedef {object} EnvironmentComponentState
 * @property {EnvironmentComponentId} id
 * @property {EnvironmentComponentCategory} category
 * @property {StorefrontId} [storefrontId]
 * @property {'host' | 'bottle' | 'system'} [scope]
 * @property {string} title
 * @property {string} shortLabel
 * @property {EnvironmentComponentStatus} status
 * @property {string} [version]
 * @property {string} [latestVersion]
 * @property {string} [binaryPath]
 * @property {string} [installLocation]
 * @property {boolean} [wasPreviouslyConfigured]
 * @property {boolean} canAutoInstall
 * @property {boolean} [requiresExternalDownload]
 * @property {string} [externalDownloadUrl]
 * @property {number} [estimatedDownloadMB]
 * @property {RecommendationTier} recommendationTier
 * @property {string} recommendationBadge
 * @property {boolean} defaultSelected
 * @property {string} whyExplanation
 * @property {string} [footprintNote]
 * @property {string} [tradeoffNote]
 * @property {string} statusDetail
 */

/**
 * @typedef {object} BottleEnvironmentSummary
 * @property {NonNativeRunnerType | null} runnerType
 * @property {string} [runnerName]
 * @property {boolean} runnerInstalled
 * @property {Array<{ name: string, path: string, runnerType: NonNativeRunnerType, hasSteam: boolean, hasGogGalaxy: boolean, hasEpicLauncher: boolean, isSandboxed: boolean }>} availableBottles
 * @property {'reuse_existing' | 'create_dedicated'} recommendedBottleMode
 * @property {string} recommendedBottleName
 * @property {string} [activeBottlePath]
 */

/**
 * @typedef {object} EnvironmentHealthSnapshot
 * @property {string} probedAt
 * @property {number} probeDurationMs
 * @property {'darwin' | 'win32' | 'linux'} hostPlatform
 * @property {string} hostArch
 * @property {boolean} isAppleSiliconMac
 * @property {boolean} hasWriteAccessToSystemApplications
 * @property {string} preferredMacApplicationsDir
 * @property {StorefrontId[]} connectedStorefronts
 * @property {{ gogdlReady: boolean, gogdlPath?: string, legendaryReady: boolean, legendaryPath?: string, xboxGdkBridgesReady: boolean, metalPreloadReady: boolean }} bundledHelpers
 * @property {any[]} detectedRunners
 * @property {BottleEnvironmentSummary} bottleSummary
 * @property {Record<EnvironmentComponentId, EnvironmentComponentState>} components
 * @property {Record<ClientLoginTargetId, ClientAuthProbeState>} clientLogins
 * @property {DiscoveredLocalStoreHint[]} localStoreHints
 * @property {{ readyCount: number, missingRecommendedCount: number, removedSinceLastSetupCount: number, pendingClientLoginCount: number, accountMismatchCount: number, updateAvailableCount: number }} counts
 */

const SETUP_WIZARD_STATE_FILENAME = 'setup-wizard-state.json';

/** @type {Set<string>} */
const VALID_ENVIRONMENT_COMPONENT_IDS = new Set([
  'rosetta2',
  'win_vcredist',
  'win_webview2',
  'runner_crossover',
  'runner_crossover_preview',
  'runner_wine',
  'runner_gptk',
  'bottle_default',
  'host_steam',
  'bottle_steam',
  'host_gog',
  'bottle_gog',
  'host_epic',
  'bottle_epic',
  'xbox_runtime',
]);

/** @type {Set<string>} */
const VALID_PREFERRED_RUNNER_TYPES = new Set([
  'crossover',
  'crossover_preview',
  'gptk',
  'wine',
  'skip',
]);

/** @type {Set<string>} */
const VALID_STOREFRONT_IDS = new Set([
  'steam',
  'gog',
  'epic',
  'amazon',
  'xbox',
  'ubisoft',
  'ea',
  'bnet',
  'itch',
  'rockstar',
  'humble',
  'custom',
]);

/**
 * Forward `homedir` into helper/detector/client-resolver options ONLY when the caller
 * explicitly provided a non-empty `options.homedir` string. Downstream functions
 * (`findGogdlBinary`, `findLegendaryBinary`, `detectCompatibilityLayers`, `resolve*ClientBinaryPath`)
 * treat `Boolean(options.homedir)` as the unit-test sandbox isolation flag!
 *
 * @param {Record<string, any>} [options]
 * @returns {{ homedir?: string }}
 */
function explicitHomedirOpt(options = {}) {
  const raw = typeof options?.homedir === 'string' ? options.homedir.trim() : '';
  return raw ? { homedir: raw } : {};
}

/**
 * Resolve `homedir` and `userDataDir` strictly WITHOUT mutating disk (`0` `mkdirSync` calls)
 * so read-only health checks never touch the filesystem.
 *
 * @param {Record<string, any>} [options]
 * @returns {{ homedir: string, userDataDir: string }}
 */
function resolveReadOnlyPaths(options = {}) {
  const isVitest = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
  const defaultHome = isVitest
    ? path.join(os.tmpdir(), `one-launcher-test-home-${process.pid}`)
    : os.homedir();

  const homedir =
    typeof options.homedir === 'string' && options.homedir.trim()
      ? options.homedir.trim()
      : defaultHome;

  const configuredDir = getConfiguredUserDataDir();
  if (typeof options.userDataDir === 'string' && options.userDataDir.trim()) {
    return { homedir, userDataDir: toHostFilesystemPath(options.userDataDir.trim()) };
  }
  if (configuredDir) {
    return { homedir, userDataDir: toHostFilesystemPath(configuredDir) };
  }
  if (options.homedir || isVitest) {
    return { homedir, userDataDir: path.join(homedir, '.one-launcher') };
  }
  try {
    const electron = getElectron();
    if (electron?.app && typeof electron.app.getPath === 'function') {
      const appUserData = electron.app.getPath('userData');
      if (appUserData) {
        return { homedir, userDataDir: toHostFilesystemPath(appUserData) };
      }
    }
  } catch {}
  return { homedir, userDataDir: path.join(homedir, '.one-launcher') };
}

/**
 * @returns {SetupWizardPersistedState}
 */
function createDefaultSetupWizardState() {
  return {
    schemaVersion: 1,
    completedAt: null,
    dismissedAt: null,
    lastHealthCheckAt: null,
    configuredComponents: [],
  };
}

/**
 * @param {unknown} rawList
 * @returns {EnvironmentComponentId[]}
 */
function sanitizeConfiguredComponents(rawList) {
  if (!Array.isArray(rawList)) return [];
  /** @type {EnvironmentComponentId[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const item of rawList) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (id && VALID_ENVIRONMENT_COMPONENT_IDS.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(/** @type {EnvironmentComponentId} */ (id));
    }
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {SetupWizardPersistedState}
 */
function sanitizeSetupWizardStateObject(raw) {
  const base = createDefaultSetupWizardState();
  if (!raw || typeof raw !== 'object') return base;
  const obj = /** @type {Record<string, any>} */ (raw);

  base.completedAt =
    typeof obj.completedAt === 'string' && obj.completedAt.trim()
      ? obj.completedAt.trim()
      : null;
  base.dismissedAt =
    typeof obj.dismissedAt === 'string' && obj.dismissedAt.trim()
      ? obj.dismissedAt.trim()
      : null;
  base.lastHealthCheckAt =
    typeof obj.lastHealthCheckAt === 'string' && obj.lastHealthCheckAt.trim()
      ? obj.lastHealthCheckAt.trim()
      : null;
  base.configuredComponents = sanitizeConfiguredComponents(obj.configuredComponents);

  if (typeof obj.preferredRunnerType === 'string') {
    const rt = obj.preferredRunnerType.trim().toLowerCase();
    if (VALID_PREFERRED_RUNNER_TYPES.has(rt)) {
      base.preferredRunnerType = /** @type {NonNativeRunnerType | 'skip'} */ (rt);
    }
  }

  if (typeof obj.preferredBottleName === 'string') {
    const bn = obj.preferredBottleName.trim();
    if (bn && safeIsBottleSlug(bn)) {
      base.preferredBottleName = bn;
    }
  }

  if (typeof obj.allowAutoOpenInTest === 'boolean') {
    base.allowAutoOpenInTest = obj.allowAutoOpenInTest;
  }

  return base;
}

/**
 * Read persisted Setup Wizard state without creating or mutating files on disk.
 *
 * @param {Record<string, any>} [options]
 * @returns {SetupWizardPersistedState}
 */
function getSetupWizardState(options = {}) {
  const { userDataDir } = resolveReadOnlyPaths(options);
  const statePath = path.join(userDataDir, SETUP_WIZARD_STATE_FILENAME);
  try {
    if (!fs.existsSync(statePath)) {
      return createDefaultSetupWizardState();
    }
    const rawText = fs.readFileSync(statePath, 'utf8');
    if (!rawText || !rawText.trim()) {
      return createDefaultSetupWizardState();
    }
    return sanitizeSetupWizardStateObject(JSON.parse(rawText));
  } catch {
    return createDefaultSetupWizardState();
  }
}

/**
 * Atomically merge and persist Setup Wizard state to `<userDataDir>/setup-wizard-state.json`.
 *
 * @param {Record<string, any>} [patch]
 * @param {Record<string, any>} [options]
 * @returns {{ success: boolean, state: SetupWizardPersistedState }}
 */
function saveSetupWizardState(patch = {}, options = {}) {
  const { userDataDir } = resolveIsolatedHomedirAndUserData(options);
  const statePath = path.join(userDataDir, SETUP_WIZARD_STATE_FILENAME);
  const safePatch = patch && typeof patch === 'object' ? patch : {};
  const current =
    safePatch.reset === true ? createDefaultSetupWizardState() : getSetupWizardState(options);

  const baseConfigured = Array.isArray(safePatch.configuredComponents)
    ? safePatch.configuredComponents
    : current.configuredComponents;
  const addedConfigured = Array.isArray(safePatch.addConfiguredComponents)
    ? safePatch.addConfiguredComponents
    : [];
  const removedSet = new Set(
    Array.isArray(safePatch.removeConfiguredComponents)
      ? safePatch.removeConfiguredComponents.map((/** @type {any} */ v) => String(v || '').trim())
      : []
  );

  const mergedConfigured = sanitizeConfiguredComponents([
    ...baseConfigured,
    ...addedConfigured,
  ]).filter((id) => !removedSet.has(id));

  /** @type {Record<string, any>} */
  const candidate = {
    schemaVersion: 1,
    completedAt:
      safePatch.completedAt !== undefined ? safePatch.completedAt : current.completedAt,
    dismissedAt:
      safePatch.dismissedAt !== undefined ? safePatch.dismissedAt : current.dismissedAt,
    lastHealthCheckAt:
      safePatch.lastHealthCheckAt !== undefined
        ? safePatch.lastHealthCheckAt
        : current.lastHealthCheckAt,
    configuredComponents: mergedConfigured,
  };

  if (safePatch.preferredRunnerType !== undefined) {
    if (safePatch.preferredRunnerType !== null && safePatch.preferredRunnerType !== '') {
      candidate.preferredRunnerType = safePatch.preferredRunnerType;
    }
  } else if (current.preferredRunnerType) {
    candidate.preferredRunnerType = current.preferredRunnerType;
  }

  if (safePatch.preferredBottleName !== undefined) {
    if (safePatch.preferredBottleName !== null && safePatch.preferredBottleName !== '') {
      candidate.preferredBottleName = safePatch.preferredBottleName;
    }
  } else if (current.preferredBottleName) {
    candidate.preferredBottleName = current.preferredBottleName;
  }

  if (safePatch.allowAutoOpenInTest !== undefined) {
    if (typeof safePatch.allowAutoOpenInTest === 'boolean') {
      candidate.allowAutoOpenInTest = safePatch.allowAutoOpenInTest;
    }
  } else if (typeof current.allowAutoOpenInTest === 'boolean') {
    candidate.allowAutoOpenInTest = current.allowAutoOpenInTest;
  }

  const nextState = sanitizeSetupWizardStateObject(candidate);
  atomicWriteFileSync(statePath, JSON.stringify(nextState, null, 2));
  return { success: true, state: nextState };
}

/**
 * Read saved storefront tokens strictly asynchronously and non-destructively when vault exists.
 * Never calls synchronous `storeSync.loadSavedTokens()` and never writes to disk on direct reads.
 *
 * @param {string} userDataDir
 * @param {Record<string, any>} options
 * @returns {Promise<Record<string, any>>}
 */
async function loadSavedTokensReadOnly(userDataDir, options) {
  if (options.savedTokens && typeof options.savedTokens === 'object') {
    return options.savedTokens;
  }
  const tokensPath = path.join(userDataDir, 'tokens.json');
  try {
    await fs.promises.access(tokensPath, fs.constants.F_OK);
  } catch {
    return {};
  }

  try {
    if (!options?.userDataDir && !options?.homedir) {
      const storeSync = options.storeSync || getStoreSync();
      if (storeSync && typeof storeSync.loadSavedTokensAsync === 'function') {
        return (await storeSync.loadSavedTokensAsync()) || {};
      }
    }

    const rawText = await fs.promises.readFile(tokensPath, 'utf8');
    if (!rawText || !rawText.trim()) {
      return {};
    }
    const parsed = JSON.parse(rawText);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    if (parsed._encrypted_v2 === true || parsed._encrypted_v3 === true) {
      try {
        const {
          decryptTokensPayloadAsync,
          sanitizeStorefrontTokensObject,
        } = require('../storefronts/tokenVault.cjs');
        const decrypted = await decryptTokensPayloadAsync(parsed, {
          ...options,
          userDataDir,
        });
        const { cleaned } = sanitizeStorefrontTokensObject(decrypted, options);
        return cleaned || {};
      } catch {
        return {};
      }
    }

    if (parsed._encrypted === true) {
      return {};
    }

    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value === 'object' && value._encrypted === true) {
        continue;
      }
      out[key] = value;
    }
    return out;
  } catch {}
  return {};
}

/**
 * @param {Record<string, any>} savedTokens
 * @param {string} userDataDir
 * @param {Record<string, any>} options
 * @returns {StorefrontId[]}
 */
function resolveConnectedStorefronts(savedTokens, userDataDir, options) {
  /** @type {Set<StorefrontId>} */
  const connected = new Set();

  if (Array.isArray(options.connectedStorefronts)) {
    for (const rawId of options.connectedStorefronts) {
      const id = String(rawId || '').trim().toLowerCase();
      if (VALID_STOREFRONT_IDS.has(id)) {
        connected.add(/** @type {StorefrontId} */ (id));
      }
    }
  }

  const isCleanString = (/** @type {any} */ val) => {
    const str = String(val || '').trim();
    if (!str) return false;
    return !isMockOrCorruptedToken(str) && !isPoisonedStorefrontToken(str, options);
  };

  if (!isStoreDisconnectedTombstoned('steam', userDataDir)) {
    const steamObj = savedTokens?.steam;
    if (
      (typeof steamObj === 'string' && isCleanString(steamObj)) ||
      (steamObj &&
        typeof steamObj === 'object' &&
        (isCleanString(steamObj.steamId) ||
          isCleanString(steamObj.accountId) ||
          isCleanString(steamObj.accountName)))
    ) {
      connected.add('steam');
    }
  }

  if (!isStoreDisconnectedTombstoned('gog', userDataDir)) {
    const gogObj = savedTokens?.gog;
    if (
      gogObj &&
      typeof gogObj === 'object' &&
      (isCleanString(gogObj.access_token) ||
        isCleanString(gogObj.refresh_token) ||
        isCleanString(gogObj.user_id) ||
        isCleanString(gogObj.userId))
    ) {
      connected.add('gog');
    }
  }

  if (!isStoreDisconnectedTombstoned('epic', userDataDir)) {
    const epicObj = savedTokens?.epic;
    if (
      epicObj &&
      typeof epicObj === 'object' &&
      (isCleanString(epicObj.access_token) ||
        isCleanString(epicObj.refresh_token) ||
        isCleanString(epicObj.account_id) ||
        isCleanString(epicObj.accountId))
    ) {
      connected.add('epic');
    }
  }

  if (!isStoreDisconnectedTombstoned('xbox', userDataDir)) {
    const xboxObj = savedTokens?.xbox;
    if (
      xboxObj &&
      typeof xboxObj === 'object' &&
      (isCleanString(xboxObj.xsts_token) ||
        isCleanString(xboxObj.uhs) ||
        isCleanString(xboxObj.access_token) ||
        isCleanString(xboxObj.refresh_token) ||
        isCleanString(xboxObj.xuid) ||
        isCleanString(xboxObj.gamertag) ||
        isCleanString(xboxObj.accountName))
    ) {
      connected.add('xbox');
    }
  }

  return Array.from(connected);
}

/**
 * Pure read-only check for `libone_metal_preload.dylib` without extracting or writing files.
 *
 * @param {string} userDataDir
 * @param {Record<string, any>} options
 * @returns {boolean}
 */
function probeMetalPreloadDylibReadOnly(userDataDir, options) {
  if (typeof options.metalPreloadReady === 'boolean') {
    return options.metalPreloadReady;
  }
  if (typeof options.metalPreloadDylibPath === 'string' && options.metalPreloadDylibPath.trim()) {
    return fs.existsSync(options.metalPreloadDylibPath.trim());
  }
  const electronRoot = path.resolve(__dirname, '..');
  const unpackedElectronRoot = electronRoot.replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1');
  const candidates = [
    path.join(unpackedElectronRoot, 'helpers', 'libone_metal_preload.dylib'),
    path.join(electronRoot, 'helpers', 'libone_metal_preload.dylib'),
    path.join(userDataDir, 'helpers', 'libone_metal_preload.dylib'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return true;
    } catch {}
  }
  return false;
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
 * Parse `Steam/config/loginusers.vdf` to extract active user session metadata (`SteamID64`,
 * `PersonaName`, `AccountName`, `MostRecent`, `AllowAutoLogin`).
 *
 * @param {string} vdfText
 * @returns {{ steamId64: string, personaName: string, accountName: string, mostRecent: boolean, allowAutoLogin: boolean, timestamp: number } | null}
 */
function parseSteamLoginUsersVdfDetails(vdfText) {
  if (!vdfText || typeof vdfText !== 'string') return null;
  const userBlockRegex = /"(\d{17})"\s*\{([^{}]*)\}/g;

  /** @type {Array<{ steamId64: string, personaName: string, accountName: string, mostRecent: boolean, allowAutoLogin: boolean, explicitlyLoggedOut: boolean, timestamp: number }>} */
  const users = [];
  let hasAnyMostRecentKey = false;

  let m;
  while ((m = userBlockRegex.exec(vdfText)) !== null) {
    const steamId64 = m[1];
    if (!steamId64ToAccountId32(steamId64)) continue;
    const body = m[2] || '';

    const personaMatch = body.match(/"PersonaName"\s+"([^"]*)"/i);
    const accountMatch = body.match(/"AccountName"\s+"([^"]*)"/i);
    const mrMatch = body.match(/"MostRecent"\s+"(\d+)"/i);
    const autoMatch = body.match(/"AllowAutoLogin"\s+"(\d+)"/i);
    const remMatch = body.match(/"RememberPassword"\s+"(\d+)"/i);
    const tsMatch = body.match(/"Timestamp"\s+"(\d+)"/i);

    if (mrMatch) hasAnyMostRecentKey = true;
    const mostRecent = Boolean(mrMatch && mrMatch[1] === '1');
    const allowAutoLogin = autoMatch
      ? autoMatch[1] === '1'
      : remMatch
        ? remMatch[1] === '1'
        : mostRecent;
    const explicitlyLoggedOut = Boolean(
      !mostRecent &&
        ((autoMatch && autoMatch[1] === '0') || (remMatch && remMatch[1] === '0'))
    );
    const timestamp = tsMatch ? Number(tsMatch[1]) || 0 : 0;

    users.push({
      steamId64,
      personaName: personaMatch ? personaMatch[1].trim() : '',
      accountName: accountMatch ? accountMatch[1].trim() : '',
      mostRecent,
      allowAutoLogin,
      explicitlyLoggedOut,
      timestamp,
    });
  }

  if (users.length === 0) return null;

  const mostRecentUsers = users
    .filter((u) => u.mostRecent)
    .sort((a, b) => b.timestamp - a.timestamp);
  if (mostRecentUsers.length > 0) {
    const chosen = mostRecentUsers[0];
    return {
      steamId64: chosen.steamId64,
      personaName: chosen.personaName,
      accountName: chosen.accountName,
      mostRecent: chosen.mostRecent,
      allowAutoLogin: chosen.allowAutoLogin,
      timestamp: chosen.timestamp,
    };
  }

  if (!hasAnyMostRecentKey) {
    const fallbackUsers = users
      .filter((u) => !u.explicitlyLoggedOut && (u.allowAutoLogin || u.timestamp > 0))
      .sort((a, b) => b.timestamp - a.timestamp);
    if (fallbackUsers.length > 0) {
      const chosen = fallbackUsers[0];
      return {
        steamId64: chosen.steamId64,
        personaName: chosen.personaName,
        accountName: chosen.accountName,
        mostRecent: false,
        allowAutoLogin: chosen.allowAutoLogin,
        timestamp: chosen.timestamp,
      };
    }
  }

  return null;
}

/**
 * Query GOG `galaxy-2.0.db` (`Users` table) strictly read-only via `node:sqlite`.
 * Handles both real GOG Galaxy 2.0/2.1 schemas (`CREATE TABLE Users('id' INT64 NOT NULL PRIMARY KEY)`
 * with 17-digit `INT64` IDs and no `username` column) and schemas with an optional `username` column,
 * casting `id` to `TEXT` inside SQLite to prevent 64-bit IEEE-754 precision loss.
 * Never creates or modifies database/WAL files.
 *
 * @param {string} dbPath
 * @param {string} [preferredUserId]
 * @returns {{ userId: string, username: string } | null}
 */
function readGogGalaxyDbUserReadOnly(dbPath, preferredUserId = '') {
  if (!dbPath) return null;
  try {
    if (!fs.existsSync(dbPath)) return null;
    const st = fs.statSync(dbPath);
    if (!st.isFile() || st.size <= 0) return null;
  } catch {
    return null;
  }

  /** @type {any} */
  let db = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    const cols = /** @type {Array<Record<string, any>>} */ (
      db.prepare('PRAGMA table_info(Users)').all()
    );
    if (!Array.isArray(cols) || cols.length === 0) {
      return null;
    }
    const hasIdCol = cols.some((c) => String(c?.name || '').toLowerCase() === 'id');
    if (!hasIdCol) {
      return null;
    }
    const hasUsernameCol = cols.some((c) => String(c?.name || '').toLowerCase() === 'username');
    const selectCols = hasUsernameCol
      ? 'CAST(id AS TEXT) AS userId, username'
      : 'CAST(id AS TEXT) AS userId';

    if (preferredUserId) {
      try {
        const matchedRow = /** @type {any} */ (
          db
            .prepare(`SELECT ${selectCols} FROM Users WHERE CAST(id AS TEXT) = ? LIMIT 1`)
            .get(String(preferredUserId))
        );
        if (matchedRow && matchedRow.userId !== undefined && matchedRow.userId !== null) {
          return {
            userId: String(matchedRow.userId).trim(),
            username: hasUsernameCol ? String(matchedRow.username || '').trim() : '',
          };
        }
      } catch {}
    }
    const row = /** @type {any} */ (
      db.prepare(`SELECT ${selectCols} FROM Users LIMIT 1`).get()
    );
    if (row && row.userId !== undefined && row.userId !== null) {
      return {
        userId: String(row.userId).trim(),
        username: hasUsernameCol ? String(row.username || '').trim() : '',
      };
    }
  } catch {
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
  return null;
}

/**
 * Parse Wine/CrossOver `user.reg` `[Software\\GOG.com\\Galaxy]` and
 * `[Software\\GOG.com\\Galaxy\\settings]` sections for GOG Galaxy login state.
 * Never returns raw auth/refresh tokens.
 *
 * @param {string} userRegText
 * @returns {{ sawGalaxySection: boolean, hasRefreshToken: boolean, userId: string, username: string }}
 */
function parseWineGogRegistryUser(userRegText) {
  if (!userRegText || typeof userRegText !== 'string') {
    return { sawGalaxySection: false, hasRefreshToken: false, userId: '', username: '' };
  }

  let sawGalaxySection = false;
  let hasRefreshToken = false;
  let userId = '';
  let username = '';
  /** @type {'' | 'galaxy' | 'settings'} */
  let currentSection = '';

  const lines = userRegText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const closeIdx = line.indexOf(']');
      if (closeIdx > 1) {
        const normalizedKey = line
          .slice(1, closeIdx)
          .replace(/\\\\/g, '\\')
          .trim()
          .toLowerCase();
        if (normalizedKey === 'software\\gog.com\\galaxy') {
          currentSection = 'galaxy';
          sawGalaxySection = true;
        } else if (normalizedKey === 'software\\gog.com\\galaxy\\settings') {
          currentSection = 'settings';
          sawGalaxySection = true;
        } else {
          currentSection = '';
        }
      } else {
        currentSection = '';
      }
      continue;
    }

    if (!currentSection) continue;

    if (currentSection === 'galaxy') {
      const rtMatch = line.match(/^"refreshToken"\s*=\s*"([^"]*)"/i);
      if (rtMatch) {
        hasRefreshToken = rtMatch[1].trim().length > 0;
        continue;
      }
    }

    const uidMatch = line.match(/^"userId"\s*=\s*"([^"]*)"/i);
    if (uidMatch) {
      const val = uidMatch[1].trim();
      if (val || currentSection === 'settings') {
        userId = val;
      }
      continue;
    }

    const unameMatch = line.match(/^"username"\s*=\s*"([^"]*)"/i);
    if (unameMatch) {
      const val = unameMatch[1].trim();
      if (val || currentSection === 'settings') {
        username = val;
      }
    }
  }

  return { sawGalaxySection, hasRefreshToken, userId, username };
}

/**
 * Enumerate per-user profile directories inside a Wine/CrossOver bottle (`drive_c/users/<name>`),
 * prioritizing `crossover` and real user profiles ahead of system folders (`Public`, `Default`).
 *
 * @param {string} activeBottlePath
 * @returns {string[]}
 */
function listBottleUserDirs(activeBottlePath) {
  if (!activeBottlePath) return [];
  const usersDir = resolveDriveCPathCaseInsensitive(path.join(activeBottlePath, 'drive_c'), [
    'users',
  ]);
  try {
    if (!fs.existsSync(usersDir)) return [];
    const deprioritizedUsers = new Set(['public', 'all users', 'default', 'default user']);
    return fs
      .readdirSync(usersDir, { withFileTypes: true })
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
 * Parse Epic Games Launcher `GameUserSettings.ini` for `[RememberMe]`, `[Offline]`, and UE5
 * per-account `[<32-hex-accountId>_General]` / `[<32-hex-accountId>_Launcher]` state.
 * Never returns raw auth tokens.
 *
 * @param {string} iniText
 * @returns {{ authenticated: boolean, accountId: string, displayLabel: string, candidateAccountIds: string[] }}
 */
function parseEpicGameUserSettingsIni(iniText) {
  if (!iniText || typeof iniText !== 'string') {
    return { authenticated: false, accountId: '', displayLabel: '', candidateAccountIds: [] };
  }

  /** @type {Record<string, Record<string, string>>} */
  const sections = {};
  /** @type {string[]} */
  const candidateAccountIds = [];
  const seenCandidateIds = new Set();
  let currentSection = '';
  for (const rawLine of iniText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const secMatch = line.match(/^\[([^\]]+)\]$/);
    if (secMatch) {
      const rawSecName = secMatch[1].trim();
      currentSection = rawSecName.toLowerCase();
      if (!sections[currentSection]) {
        sections[currentSection] = {};
      }
      const acctSecMatch = rawSecName.match(
        /^([a-f0-9]{32})_(?:general|launcher|autoinstall|dismissednotification|dismisseddialog|library|friends)$/i
      );
      if (acctSecMatch) {
        const candId = acctSecMatch[1].toLowerCase();
        if (!seenCandidateIds.has(candId)) {
          seenCandidateIds.add(candId);
          candidateAccountIds.push(candId);
        }
      }
      continue;
    }
    if (!currentSection) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim().toLowerCase();
    const val = line.slice(eqIdx + 1).trim();
    sections[currentSection][key] = val;
  }

  const rememberMe = sections['rememberme'] || {};
  const offline = sections['offline'] || {};
  const enableRaw = String(rememberMe['enable'] || '')
    .trim()
    .toLowerCase();
  const rememberEnabled = enableRaw === 'true' || enableRaw === '1';
  const rawData = String(rememberMe['data'] || '')
    .replace(/^"+|"+$/g, '')
    .trim();

  const hasNonEmptyData =
    Boolean(rawData) &&
    rawData !== '[]' &&
    rawData !== '[[]]' &&
    rawData.toLowerCase() !== 'none' &&
    rawData.toLowerCase() !== 'null';

  let accountId = String(
    rememberMe['accountid'] ||
      offline['accountid'] ||
      offline['userid'] ||
      sections['launcher']?.['accountid'] ||
      ''
  ).trim();
  let displayLabel = String(
    rememberMe['displayname'] ||
      rememberMe['email'] ||
      offline['displayname'] ||
      offline['username'] ||
      ''
  ).trim();

  if (hasNonEmptyData) {
    const cleanB64 = rawData.replace(/^\[+|\]+$/g, '').trim();
    if (/^[A-Za-z0-9+/=]+$/.test(cleanB64) && cleanB64.length >= 16) {
      try {
        const decoded = Buffer.from(cleanB64, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        const entry = Array.isArray(parsed) ? parsed[0] : parsed;
        if (entry && typeof entry === 'object') {
          if (!accountId && (entry.AccountId || entry.accountId || entry.UserId)) {
            accountId = String(entry.AccountId || entry.accountId || entry.UserId).trim();
          }
          if (!displayLabel && (entry.DisplayName || entry.Name || entry.Email)) {
            displayLabel = String(entry.DisplayName || entry.Name || entry.Email).trim();
          }
          if (entry.Token === '') {
            return {
              authenticated: false,
              accountId: '',
              displayLabel: '',
              candidateAccountIds: [],
            };
          }
        }
      } catch {}
    }
  }

  const authenticated = Boolean(
    (rememberEnabled && hasNonEmptyData) || (!enableRaw && hasNonEmptyData)
  );
  if (authenticated && !accountId && candidateAccountIds.length === 1) {
    accountId = candidateAccountIds[0];
  }
  return {
    authenticated,
    accountId: authenticated ? accountId : '',
    displayLabel: authenticated ? displayLabel || accountId : '',
    candidateAccountIds: authenticated ? candidateAccountIds : [],
  };
}

/**
 * Resolve active bottle context from detected runners & wizard preferences.
 *
 * @param {'darwin' | 'win32' | 'linux'} hostPlatform
 * @param {string} homedir
 * @param {any[]} detectedRunners
 * @param {SetupWizardPersistedState} wizardState
 * @param {Record<string, any>} options
 * @returns {BottleEnvironmentSummary}
 */
function buildBottleEnvironmentSummary(
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

  const isMockHomedir = Boolean(options.homedir || options.customApplicationsDir);
  /** @type {Array<{ name: string, path: string, runnerType: NonNativeRunnerType, hasSteam: boolean, hasGogGalaxy: boolean, hasEpicLauncher: boolean, isSandboxed: boolean }>} */
  const availableBottles = [];
  /** @type {Set<string>} */
  const seenBottlePaths = new Set();

  const preferredRunner =
    wizardState.preferredRunnerType && wizardState.preferredRunnerType !== 'skip'
      ? detectedRunners.find((r) => r.type === wizardState.preferredRunnerType)
      : null;
  const activeRunner = preferredRunner || detectedRunners[0] || null;

  // Inspect CrossOver & CrossOver Preview bottles (ordered so activeRunner wins path deduplication)
  const orderedRunners = activeRunner
    ? [activeRunner, ...detectedRunners.filter((r) => r !== activeRunner)]
    : detectedRunners;

  for (const layer of orderedRunners) {
    if (
      (layer.type === 'crossover' || layer.type === 'crossover_preview') &&
      layer.bottlesDir &&
      Array.isArray(layer.availableBottles)
    ) {
      for (const bottleName of layer.availableBottles) {
        const bottlePath = path.join(layer.bottlesDir, bottleName);
        const resolvedKey = path.resolve(bottlePath);
        if (seenBottlePaths.has(resolvedKey)) continue;
        if (!isValidBottleDirectory(bottlePath, isMockHomedir)) continue;
        seenBottlePaths.add(resolvedKey);
        availableBottles.push({
          name: bottleName,
          path: bottlePath,
          runnerType: /** @type {NonNativeRunnerType} */ (layer.type),
          hasSteam: Boolean(resolveBottleSteamExe(bottlePath)),
          hasGogGalaxy: Boolean(resolveBottleGogGalaxyExe(bottlePath)),
          hasEpicLauncher: Boolean(resolveBottleEpicLauncherExe(bottlePath)),
          isSandboxed: isBottleUserFoldersSandboxedReadOnly(bottlePath),
        });
      }
    }
  }

  // Fallback direct scan of standard CrossOver bottle directories so valid initialized bottles
  // (and their Steam/GOG/Epic installations) are never falsely marked missing if runner order shifts.
  const directBottleRoots = [
    {
      bottlesDir: path.join(homedir, 'Library/Application Support/CrossOver/Bottles'),
      runnerType: /** @type {NonNativeRunnerType} */ ('crossover'),
    },
    {
      bottlesDir: path.join(homedir, 'Library/Application Support/CrossOver Preview/Bottles'),
      runnerType: /** @type {NonNativeRunnerType} */ ('crossover_preview'),
    },
  ];
  for (const rootSpec of directBottleRoots) {
    if (!fs.existsSync(rootSpec.bottlesDir)) continue;
    let subdirs = [];
    try {
      subdirs = fs
        .readdirSync(rootSpec.bottlesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name);
    } catch {
      subdirs = [];
    }
    for (const bottleName of subdirs) {
      if (!safeIsBottleSlug(bottleName)) continue;
      const bottlePath = path.join(rootSpec.bottlesDir, bottleName);
      const resolvedKey = path.resolve(bottlePath);
      if (seenBottlePaths.has(resolvedKey)) continue;
      if (!isValidBottleDirectory(bottlePath, isMockHomedir)) continue;
      seenBottlePaths.add(resolvedKey);
      availableBottles.push({
        name: bottleName,
        path: bottlePath,
        runnerType: rootSpec.runnerType,
        hasSteam: Boolean(resolveBottleSteamExe(bottlePath)),
        hasGogGalaxy: Boolean(resolveBottleGogGalaxyExe(bottlePath)),
        hasEpicLauncher: Boolean(resolveBottleEpicLauncherExe(bottlePath)),
        isSandboxed: isBottleUserFoldersSandboxedReadOnly(bottlePath),
      });
    }
  }

  // Inspect standalone Wine / GPTK prefixes
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
        hasSteam: Boolean(resolveBottleSteamExe(cand.path)),
        hasGogGalaxy: Boolean(resolveBottleGogGalaxyExe(cand.path)),
        hasEpicLauncher: Boolean(resolveBottleEpicLauncherExe(cand.path)),
        isSandboxed: isBottleUserFoldersSandboxedReadOnly(cand.path),
      });
    }
  }

  if (availableBottles.length > 0) {
    const oneLauncherBottle = availableBottles.find((b) => b.name === 'OneLauncher');
    const userPreferredBottle = wizardState.preferredBottleName
      ? availableBottles.find((b) => b.name === wizardState.preferredBottleName)
      : null;
    const steamBottle = availableBottles.find((b) => b.hasSteam);
    const chosenBottle =
      oneLauncherBottle || userPreferredBottle || steamBottle || availableBottles[0];

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
    };
  }

  const defaultBottleName =
    wizardState.preferredBottleName && safeIsBottleSlug(wizardState.preferredBottleName)
      ? wizardState.preferredBottleName
      : activeRunner && (activeRunner.type === 'wine' || activeRunner.type === 'gptk')
        ? 'default'
        : 'OneLauncher';

  return {
    runnerType: activeRunner ? /** @type {NonNativeRunnerType} */ (activeRunner.type) : null,
    ...(activeRunner?.name ? { runnerName: activeRunner.name } : {}),
    runnerInstalled: Boolean(activeRunner),
    availableBottles: [],
    recommendedBottleMode: 'create_dedicated',
    recommendedBottleName: defaultBottleName,
  };
}

/**
 * Probe all 6 host & bottled storefront client authentication states (`host_steam`,
 * `bottle_steam`, `host_gog`, `bottle_gog`, `host_epic`, `bottle_epic`) strictly read-only.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<ClientLoginTargetId, ClientAuthProbeState>>}
 */
async function probeClientLoginStates(options = {}) {
  const rawPlatform = String(options.platform || process.platform).toLowerCase();
  /** @type {'darwin' | 'win32' | 'linux'} */
  const hostPlatform =
    rawPlatform === 'win32' ? 'win32' : rawPlatform === 'linux' ? 'linux' : 'darwin';
  const { homedir, userDataDir } = resolveReadOnlyPaths(options);

  const savedTokens = await loadSavedTokensReadOnly(userDataDir, options);
  const connectedStorefronts = resolveConnectedStorefronts(savedTokens, userDataDir, options);
  const wizardState = getSetupWizardState(options);

  let activeBottlePath = typeof options.bottlePath === 'string' ? options.bottlePath : '';
  let activeBottleName = typeof options.preferredBottleName === 'string' ? options.preferredBottleName : '';

  if (hostPlatform === 'darwin' && !activeBottlePath) {
    let runners = [];
    if (Array.isArray(options._detectedRunners)) {
      runners = options._detectedRunners;
    } else {
      try {
        runners = detectCompatibilityLayers({
          ...options,
          ...explicitHomedirOpt(options),
          readOnly: true,
        });
      } catch {
        runners = [];
      }
    }
    const overriddenState = {
      ...wizardState,
      ...(options.preferredRunnerType ? { preferredRunnerType: options.preferredRunnerType } : {}),
      ...(options.preferredBottleName ? { preferredBottleName: options.preferredBottleName } : {}),
    };
    const summary =
      options._bottleSummary ||
      buildBottleEnvironmentSummary(hostPlatform, homedir, runners, overriddenState, options);
    activeBottlePath = summary.activeBottlePath || '';
    activeBottleName = summary.recommendedBottleName || '';
    if (!activeBottlePath && summary.runnerInstalled && runners.length > 0) {
      const layer =
        (options.preferredRunnerType &&
          runners.find((/** @type {any} */ r) => r.type === options.preferredRunnerType)) ||
        runners[0];
      if (layer) {
        if ((layer.type === 'crossover' || layer.type === 'crossover_preview') && layer.bottlesDir) {
          const candidatePath = path.join(layer.bottlesDir, activeBottleName || 'OneLauncher');
          if (fs.existsSync(candidatePath)) activeBottlePath = candidatePath;
        } else {
          const candidatePrefix = path.join(
            homedir,
            'Games/OneLauncher/Prefixes',
            activeBottleName || 'default'
          );
          if (fs.existsSync(candidatePrefix)) activeBottlePath = candidatePrefix;
        }
      }
    }
  }

  const clientResolverOpts = {
    ...options,
    ...explicitHomedirOpt(options),
    platform: hostPlatform,
  };
  const hostSteamBin = resolveSteamClientBinaryPath(clientResolverOpts);
  const hostGogBin = resolveGogGalaxyClientBinaryPath(clientResolverOpts);
  const hostEpicBin = resolveEpicClientBinaryPath(clientResolverOpts);

  const bottleSteamBin =
    hostPlatform === 'darwin' && activeBottlePath ? resolveBottleSteamExe(activeBottlePath) : null;
  const bottleGogBin =
    hostPlatform === 'darwin' && activeBottlePath
      ? resolveBottleGogGalaxyExe(activeBottlePath)
      : null;
  const bottleEpicBin =
    hostPlatform === 'darwin' && activeBottlePath
      ? resolveBottleEpicLauncherExe(activeBottlePath)
      : null;

  const olSteamId = connectedStorefronts.includes('steam')
    ? String(
        (typeof savedTokens?.steam === 'string' ? savedTokens.steam : '') ||
          savedTokens?.steam?.steamId ||
          savedTokens?.steam?.accountId ||
          options.oneLauncherSteamId ||
          ''
      ).trim()
    : '';
  const olGogUserId = connectedStorefronts.includes('gog')
    ? String(
        savedTokens?.gog?.user_id || savedTokens?.gog?.userId || options.oneLauncherGogUserId || ''
      ).trim()
    : '';
  const olGogUsername = connectedStorefronts.includes('gog')
    ? String(
        savedTokens?.gog?.username ||
          savedTokens?.gog?.user_name ||
          options.oneLauncherGogUsername ||
          ''
      ).trim()
    : '';
  let olEpicAccountId = connectedStorefronts.includes('epic')
    ? String(
        savedTokens?.epic?.account_id ||
          savedTokens?.epic?.accountId ||
          options.oneLauncherEpicAccountId ||
          ''
      ).trim()
    : '';
  let olEpicDisplayName = connectedStorefronts.includes('epic')
    ? String(
        savedTokens?.epic?.displayName ||
          savedTokens?.epic?.display_name ||
          options.oneLauncherEpicDisplayName ||
          ''
      ).trim()
    : '';
  if (connectedStorefronts.includes('epic') && (!olEpicAccountId || !olEpicDisplayName)) {
    try {
      const legUserJsonPath = path.join(userDataDir, 'legendaryConfig/legendary/user.json');
      const rawLegUser = await fs.promises.readFile(legUserJsonPath, 'utf8');
      const parsedLegUser = JSON.parse(rawLegUser);
      if (parsedLegUser && typeof parsedLegUser === 'object') {
        if (!olEpicAccountId) {
          olEpicAccountId = String(
            parsedLegUser.account_id || parsedLegUser.accountId || ''
          ).trim();
        }
        if (!olEpicDisplayName) {
          olEpicDisplayName = String(
            parsedLegUser.displayName || parsedLegUser.display_name || ''
          ).trim();
        }
      }
    } catch {}
  }

  // 1. Steam helper (host & bottle)
  const probeSteamTarget = async (
    /** @type {'host_steam' | 'bottle_steam'} */ targetId,
    /** @type {'host' | 'bottle'} */ scope,
    /** @type {string} */ label,
    /** @type {string | null} */ binPath,
    /** @type {string[]} */ vdfCandidates
  ) => {
    const installed = Boolean(binPath);
    /** @type {ReturnType<typeof parseSteamLoginUsersVdfDetails>} */
    let activeUser = null;
    for (const vdfPath of vdfCandidates) {
      if (!vdfPath) continue;
      try {
        const text = await fs.promises.readFile(vdfPath, 'utf8');
        const parsed = parseSteamLoginUsersVdfDetails(text);
        if (parsed) {
          activeUser = parsed;
          break;
        }
      } catch {}
    }

    const authenticated = Boolean(activeUser && activeUser.steamId64);
    const autoLoginEnabled = Boolean(activeUser?.allowAutoLogin);
    const detectedAccountLabel = activeUser
      ? activeUser.personaName || activeUser.accountName || activeUser.steamId64
      : undefined;

    /** @type {boolean | null} */
    let accountMatchesOneLauncher = null;
    /** @type {string | undefined} */
    let mismatchReason;
    if (authenticated && activeUser?.steamId64 && olSteamId && /^\d{17}$/.test(olSteamId)) {
      accountMatchesOneLauncher = activeUser.steamId64 === olSteamId;
      if (!accountMatchesOneLauncher) {
        mismatchReason = `Signed into a different Steam account (${detectedAccountLabel}) than One Launcher (${olSteamId}).`;
      }
    }

    const statusSummary = !installed
      ? scope === 'bottle' && hostPlatform !== 'darwin'
        ? 'Not needed on Windows'
        : 'Not installed'
      : !authenticated
        ? 'Sign-in needed'
        : accountMatchesOneLauncher === false
          ? mismatchReason || 'Different Steam account signed in'
          : !autoLoginEnabled
            ? `Signed in as ${detectedAccountLabel} (Remember me off)`
            : `Signed in as ${detectedAccountLabel}`;

    /** @type {ClientAuthProbeState} */
    const state = {
      targetId,
      storefrontId: 'steam',
      scope,
      label,
      installed,
      ...(binPath ? { binaryPath: binPath } : {}),
      ...(scope === 'bottle' && activeBottleName ? { bottleName: activeBottleName } : {}),
      ...(scope === 'bottle' && activeBottlePath ? { bottlePath: activeBottlePath } : {}),
      authenticated,
      autoLoginEnabled,
      ...(detectedAccountLabel ? { detectedAccountLabel } : {}),
      accountMatchesOneLauncher,
      ...(mismatchReason ? { mismatchReason } : {}),
      statusSummary,
      ...(activeUser?.steamId64 ? { _steamId64: activeUser.steamId64 } : {}),
    };
    return state;
  };

  // 2. GOG Galaxy helper (host & bottle)
  const probeGogTarget = async (
    /** @type {'host_gog' | 'bottle_gog'} */ targetId,
    /** @type {'host' | 'bottle'} */ scope,
    /** @type {string} */ label,
    /** @type {string | null} */ binPath,
    /** @type {string[]} */ configCandidates,
    /** @type {string[]} */ dbCandidates,
    /** @type {string} */ wineUserRegPath = ''
  ) => {
    const installed = Boolean(binPath);
    let configUserId = '';
    let configUsername = '';
    let explicitlySignedOut = false;
    let perUserConfigMissingUser = false;

    for (const cfgPath of configCandidates) {
      if (!cfgPath) continue;
      try {
        const raw = await fs.promises.readFile(cfgPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const hasUidProp =
            Object.prototype.hasOwnProperty.call(parsed, 'userId') ||
            Object.prototype.hasOwnProperty.call(parsed, 'user_id');
          const uid = String(parsed.userId ?? parsed.user_id ?? '').trim();
          const uname = String(parsed.username ?? parsed.user_name ?? '').trim();
          if (uid) {
            configUserId = uid;
            configUsername = uname;
            explicitlySignedOut = false;
            perUserConfigMissingUser = false;
            break;
          }
          if (hasUidProp) {
            explicitlySignedOut = true;
            break;
          }
          const normalizedCfgPath = cfgPath.replace(/\\/g, '/').toLowerCase();
          const isPerUserConfigurationJson =
            normalizedCfgPath.endsWith('/configuration/config.json') ||
            Object.prototype.hasOwnProperty.call(parsed, 'keepLoggedIn') ||
            Object.prototype.hasOwnProperty.call(parsed, 'whenClosingMainWindow');
          if (isPerUserConfigurationJson) {
            perUserConfigMissingUser = true;
          }
        }
      } catch {}
    }

    if (!configUserId && !explicitlySignedOut && wineUserRegPath) {
      try {
        const regText = await fs.promises.readFile(wineUserRegPath, 'utf8');
        const regUser = parseWineGogRegistryUser(regText);
        if (regUser.hasRefreshToken && regUser.userId) {
          configUserId = regUser.userId;
          if (regUser.username) {
            configUsername = regUser.username;
          }
          perUserConfigMissingUser = false;
        } else if (regUser.sawGalaxySection && !regUser.hasRefreshToken) {
          perUserConfigMissingUser = true;
        }
      } catch {}
    }

    /** @type {{ userId: string, username: string } | null} */
    let dbUser = null;
    if (!explicitlySignedOut && (!perUserConfigMissingUser || Boolean(configUserId))) {
      for (const dbPath of dbCandidates) {
        dbUser = readGogGalaxyDbUserReadOnly(dbPath, configUserId);
        if (dbUser) break;
      }
    }

    const suppressDbOnlySession = explicitlySignedOut || perUserConfigMissingUser;
    const detectedUserId = configUserId || (suppressDbOnlySession ? '' : dbUser?.userId || '');
    const authenticated = Boolean(
      detectedUserId || (!suppressDbOnlySession && (configUsername || dbUser?.username))
    );

    /** @type {boolean | null} */
    let accountMatchesOneLauncher = null;
    if (authenticated && detectedUserId && olGogUserId) {
      accountMatchesOneLauncher = detectedUserId === olGogUserId;
    }

    const detectedUsername =
      configUsername ||
      dbUser?.username ||
      (accountMatchesOneLauncher === true && olGogUsername ? olGogUsername : '');
    const detectedAccountLabel = authenticated
      ? detectedUsername || (detectedUserId ? `GOG User ${detectedUserId}` : undefined)
      : undefined;

    /** @type {string | undefined} */
    let mismatchReason;
    if (accountMatchesOneLauncher === false && detectedUserId && olGogUserId) {
      const olDesc = olGogUsername ? `${olGogUsername} (${olGogUserId})` : olGogUserId;
      mismatchReason = `Signed into a different GOG account (${detectedAccountLabel || detectedUserId}) than One Launcher (${olDesc}).`;
    }

    const statusSummary = !installed
      ? scope === 'bottle' && hostPlatform !== 'darwin'
        ? 'Not needed on Windows'
        : 'Not installed'
      : !authenticated
        ? 'Sign-in needed'
        : accountMatchesOneLauncher === false
          ? mismatchReason || 'Different GOG account signed in'
          : `Signed in as ${detectedAccountLabel || 'GOG User'}`;

    /** @type {ClientAuthProbeState} */
    const state = {
      targetId,
      storefrontId: 'gog',
      scope,
      label,
      installed,
      ...(binPath ? { binaryPath: binPath } : {}),
      ...(scope === 'bottle' && activeBottleName ? { bottleName: activeBottleName } : {}),
      ...(scope === 'bottle' && activeBottlePath ? { bottlePath: activeBottlePath } : {}),
      authenticated,
      ...(detectedAccountLabel ? { detectedAccountLabel } : {}),
      accountMatchesOneLauncher,
      ...(mismatchReason ? { mismatchReason } : {}),
      statusSummary,
    };
    return state;
  };

  // 3. Epic Games Launcher helper (host & bottle)
  const probeEpicTarget = async (
    /** @type {'host_epic' | 'bottle_epic'} */ targetId,
    /** @type {'host' | 'bottle'} */ scope,
    /** @type {string} */ label,
    /** @type {string | null} */ binPath,
    /** @type {string[]} */ iniCandidates
  ) => {
    const installed = Boolean(binPath);
    let authenticated = false;
    let detectedAccountId = '';
    let detectedLabel = '';

    for (const iniPath of iniCandidates) {
      if (!iniPath) continue;
      try {
        const rawIni = await fs.promises.readFile(iniPath, 'utf8');
        const parsed = parseEpicGameUserSettingsIni(rawIni);
        if (parsed.authenticated) {
          authenticated = true;
          detectedAccountId = parsed.accountId;
          detectedLabel = parsed.displayLabel;
          if (!detectedAccountId && parsed.candidateAccountIds.length > 1) {
            const savedDataDirs = Array.from(
              new Set([
                path.resolve(path.dirname(iniPath), '../../Data'),
                ...(scope === 'host' && hostPlatform === 'darwin'
                  ? [
                      path.join(
                        homedir,
                        'Library/Application Support/Epic/EpicGamesLauncher/Saved/Data'
                      ),
                    ]
                  : []),
              ])
            );
            let newestId = '';
            let newestMtimeMs = -1;
            for (const candId of parsed.candidateAccountIds) {
              for (const savedDataDir of savedDataDirs) {
                for (const fileName of [
                  `${candId}.dat`,
                  `OC_${candId}.dat`,
                  `${candId.toUpperCase()}.dat`,
                  `OC_${candId.toUpperCase()}.dat`,
                ]) {
                  try {
                    const st = await fs.promises.stat(path.join(savedDataDir, fileName));
                    if (st.isFile() && st.mtimeMs >= newestMtimeMs) {
                      newestMtimeMs = st.mtimeMs;
                      newestId = candId;
                    }
                  } catch {}
                }
              }
            }
            if (newestId) {
              detectedAccountId = newestId;
            } else if (
              olEpicAccountId &&
              parsed.candidateAccountIds.some(
                (id) => id.toLowerCase() === olEpicAccountId.toLowerCase()
              )
            ) {
              detectedAccountId =
                parsed.candidateAccountIds.find(
                  (id) => id.toLowerCase() === olEpicAccountId.toLowerCase()
                ) || '';
            } else {
              detectedAccountId = parsed.candidateAccountIds[parsed.candidateAccountIds.length - 1];
            }
          }
          break;
        }
      } catch {}
    }

    const isHex32Label = /^[a-f0-9]{32}$/i.test(detectedLabel);
    /** @type {boolean | null} */
    let accountMatchesOneLauncher = null;
    /** @type {string | undefined} */
    let mismatchReason;
    if (authenticated && detectedAccountId && olEpicAccountId) {
      accountMatchesOneLauncher =
        detectedAccountId.toLowerCase() === olEpicAccountId.toLowerCase();
      if (!accountMatchesOneLauncher) {
        const detectedDesc =
          detectedLabel && !isHex32Label
            ? detectedLabel
            : /^[a-f0-9]{32}$/i.test(detectedAccountId)
              ? `Epic ID ${detectedAccountId.slice(0, 8)}…`
              : detectedAccountId;
        const olDesc = olEpicDisplayName || olEpicAccountId;
        mismatchReason = `Signed into a different Epic account (${detectedDesc}) than One Launcher (${olDesc}).`;
      }
    }

    if (authenticated && (!detectedLabel || isHex32Label)) {
      if (accountMatchesOneLauncher === true && olEpicDisplayName) {
        detectedLabel = olEpicDisplayName;
      } else if (isHex32Label) {
        detectedLabel = '';
      }
    }

    const statusSummary = !installed
      ? scope === 'bottle' && hostPlatform !== 'darwin'
        ? 'Not needed on Windows'
        : 'Not installed'
      : !authenticated
        ? 'Sign-in needed'
        : accountMatchesOneLauncher === false
          ? mismatchReason || 'Different Epic account signed in'
          : `Signed in${detectedLabel ? ` as ${detectedLabel}` : ''}`;

    /** @type {ClientAuthProbeState} */
    const state = {
      targetId,
      storefrontId: 'epic',
      scope,
      label,
      installed,
      ...(binPath ? { binaryPath: binPath } : {}),
      ...(scope === 'bottle' && activeBottleName ? { bottleName: activeBottleName } : {}),
      ...(scope === 'bottle' && activeBottlePath ? { bottlePath: activeBottlePath } : {}),
      authenticated,
      ...(detectedLabel ? { detectedAccountLabel: detectedLabel } : {}),
      accountMatchesOneLauncher,
      ...(mismatchReason ? { mismatchReason } : {}),
      statusSummary,
    };
    return state;
  };

  // Assemble candidate file lists
  const hostSteamVdfs = [
    typeof options.hostSteamLoginUsersVdfPath === 'string'
      ? options.hostSteamLoginUsersVdfPath
      : '',
    ...(hostPlatform === 'darwin'
      ? [path.join(homedir, 'Library/Application Support/Steam/config/loginusers.vdf')]
      : hostPlatform === 'win32'
        ? [
            hostSteamBin ? path.join(path.dirname(hostSteamBin), 'config', 'loginusers.vdf') : '',
            path.join(homedir, 'Program Files (x86)/Steam/config/loginusers.vdf'),
            path.join(homedir, 'Steam/config/loginusers.vdf'),
            ...(!options.homedir
              ? [
                  'C:\\Program Files (x86)\\Steam\\config\\loginusers.vdf',
                  'C:\\Program Files\\Steam\\config\\loginusers.vdf',
                ]
              : []),
          ]
        : [
            path.join(homedir, '.local/share/Steam/config/loginusers.vdf'),
            path.join(homedir, '.steam/steam/config/loginusers.vdf'),
          ]),
  ].filter(Boolean);

  const bottleSteamVdfs =
    hostPlatform === 'darwin' && activeBottlePath
      ? [
          bottleSteamBin
            ? path.join(path.dirname(bottleSteamBin), 'config', 'loginusers.vdf')
            : '',
          path.join(activeBottlePath, 'drive_c/Program Files (x86)/Steam/config/loginusers.vdf'),
          path.join(activeBottlePath, 'drive_c/Program Files/Steam/config/loginusers.vdf'),
        ].filter(Boolean)
      : [];

  const programDataWin = process.env.PROGRAMDATA || 'C:\\ProgramData';
  const winLocalAppData =
    !options.homedir && process.env.LOCALAPPDATA
      ? process.env.LOCALAPPDATA
      : path.join(homedir, 'AppData/Local');
  const winProgramDataRoot = !options.homedir ? programDataWin : path.join(homedir, 'ProgramData');
  const bottleUserDirs =
    hostPlatform === 'darwin' && activeBottlePath ? listBottleUserDirs(activeBottlePath) : [];

  const hostGogRoots =
    hostPlatform === 'darwin'
      ? !options.homedir
        ? [
            path.join(homedir, 'Library/Application Support/GOG.com/Galaxy'),
            '/Users/Shared/GOG.com/Galaxy',
          ]
        : [
            path.join(homedir, 'Library/Application Support/GOG.com/Galaxy'),
            path.join(homedir, 'Users/Shared/GOG.com/Galaxy'),
            path.join(homedir, 'GOG.com/Galaxy'),
          ]
      : hostPlatform === 'win32'
        ? [
            path.join(winLocalAppData, 'GOG.com/Galaxy'),
            path.join(winProgramDataRoot, 'GOG.com/Galaxy'),
          ]
        : [];

  const hostGogConfigs = Array.from(
    new Set(
      [
        typeof options.gogGalaxyConfigPath === 'string' ? options.gogGalaxyConfigPath : '',
        ...hostGogRoots.map((root) => path.join(root, 'Configuration', 'config.json')),
        ...hostGogRoots.map((root) => path.join(root, 'config.json')),
      ].filter(Boolean)
    )
  );

  const hostGogDbRoots = Array.from(
    new Set([
      ...hostGogRoots,
      ...(typeof options.gogGalaxyConfigPath === 'string' && options.gogGalaxyConfigPath
        ? [path.dirname(options.gogGalaxyConfigPath)]
        : []),
    ])
  );
  const hostGogDbs = Array.from(
    new Set(
      [
        typeof options.gogGalaxyDbPath === 'string' ? options.gogGalaxyDbPath : '',
        ...hostGogDbRoots.flatMap((root) => [
          path.join(root, 'storage', 'galaxy-2.0.db'),
          path.join(root, 'Storage', 'galaxy-2.0.db'),
        ]),
      ].filter(Boolean)
    )
  );

  const bottleGogConfigs =
    hostPlatform === 'darwin' && activeBottlePath
      ? Array.from(
          new Set(
            [
              typeof options.bottleGogGalaxyConfigPath === 'string'
                ? options.bottleGogGalaxyConfigPath
                : '',
              ...bottleUserDirs.flatMap((uDir) => [
                resolveDriveCPathCaseInsensitive(uDir, [
                  'AppData',
                  'Local',
                  'GOG.com',
                  'Galaxy',
                  'Configuration',
                  'config.json',
                ]),
                path.join(uDir, 'AppData/Local/GOG.com/Galaxy/Configuration/config.json'),
                resolveDriveCPathCaseInsensitive(uDir, [
                  'AppData',
                  'Local',
                  'GOG.com',
                  'Galaxy',
                  'config.json',
                ]),
                path.join(uDir, 'AppData/Local/GOG.com/Galaxy/config.json'),
              ]),
              path.join(activeBottlePath, 'drive_c/ProgramData/GOG.com/Galaxy/Configuration/config.json'),
              path.join(activeBottlePath, 'drive_c/ProgramData/GOG.com/Galaxy/config.json'),
            ].filter(Boolean)
          )
        )
      : [];
  const bottleGogDbs =
    hostPlatform === 'darwin' && activeBottlePath
      ? Array.from(
          new Set(
            [
              typeof options.bottleGogGalaxyDbPath === 'string'
                ? options.bottleGogGalaxyDbPath
                : '',
              path.join(activeBottlePath, 'drive_c/ProgramData/GOG.com/Galaxy/storage/galaxy-2.0.db'),
              path.join(activeBottlePath, 'drive_c/ProgramData/GOG.com/Galaxy/Storage/galaxy-2.0.db'),
            ].filter(Boolean)
          )
        )
      : [];
  const bottleUserRegPath =
    hostPlatform === 'darwin' && activeBottlePath ? path.join(activeBottlePath, 'user.reg') : '';

  const macEpicSubpaths = [
    'MacEditor/GameUserSettings.ini',
    'MacPortal/GameUserSettings.ini',
    'Mac/GameUserSettings.ini',
  ];
  const winEpicSubpaths = [
    'WindowsEditor/GameUserSettings.ini',
    'WindowsPortal/GameUserSettings.ini',
    'Windows/GameUserSettings.ini',
  ];

  const hostEpicInis = [
    typeof options.hostEpicGameUserSettingsIniPath === 'string'
      ? options.hostEpicGameUserSettingsIniPath
      : '',
    ...(hostPlatform === 'darwin'
      ? [
          path.join(homedir, 'Library/Application Support/Epic/EpicGamesLauncher/Saved/Config'),
          path.join(homedir, 'Library/Preferences/Unreal Engine/EpicGamesLauncher'),
        ].flatMap((root) => macEpicSubpaths.map((sub) => path.join(root, sub)))
      : hostPlatform === 'win32'
        ? winEpicSubpaths.map((sub) =>
            path.join(winLocalAppData, 'EpicGamesLauncher/Saved/Config', sub)
          )
        : []),
  ].filter(Boolean);

  /** @type {string[]} */
  const bottleEpicInis = [];
  for (const uDir of bottleUserDirs) {
    for (const sub of winEpicSubpaths) {
      bottleEpicInis.push(path.join(uDir, 'AppData/Local/EpicGamesLauncher/Saved/Config', sub));
    }
  }

  const [hostSteam, bottleSteam, hostGog, bottleGog, hostEpic, bottleEpic] = await Promise.all([
    probeSteamTarget(
      'host_steam',
      'host',
      hostPlatform === 'darwin' ? 'Steam (Mac)' : 'Steam',
      hostSteamBin,
      hostSteamVdfs
    ),
    probeSteamTarget(
      'bottle_steam',
      'bottle',
      'Steam (Windows)',
      bottleSteamBin,
      bottleSteamVdfs
    ),
    probeGogTarget(
      'host_gog',
      'host',
      hostPlatform === 'darwin' ? 'GOG Galaxy (Mac)' : 'GOG Galaxy',
      hostGogBin,
      hostGogConfigs,
      hostGogDbs
    ),
    probeGogTarget(
      'bottle_gog',
      'bottle',
      'GOG Galaxy (Windows)',
      bottleGogBin,
      bottleGogConfigs,
      bottleGogDbs,
      bottleUserRegPath
    ),
    probeEpicTarget(
      'host_epic',
      'host',
      hostPlatform === 'darwin' ? 'Epic Games Launcher (Mac)' : 'Epic Games Launcher',
      hostEpicBin,
      hostEpicInis
    ),
    probeEpicTarget(
      'bottle_epic',
      'bottle',
      'Epic Games Launcher (Windows)',
      bottleEpicBin,
      bottleEpicInis
    ),
  ]);

  // Strip internal _steamId64 helper tag before returning public contract object
  const cleanSteamState = (/** @type {any} */ st) => {
    const { _steamId64, ...pub } = st;
    return pub;
  };

  return {
    host_steam: cleanSteamState(hostSteam),
    bottle_steam: cleanSteamState(bottleSteam),
    host_gog: hostGog,
    bottle_gog: bottleGog,
    host_epic: hostEpic,
    bottle_epic: bottleEpic,
  };
}

/**
 * Discover non-secret local store sessions for unconnected storefronts (`localStoreHints`).
 * Strictly read-only and never exposes tokens or credentials.
 *
 * @param {'darwin' | 'win32' | 'linux'} hostPlatform
 * @param {string} homedir
 * @param {string} userDataDir
 * @param {StorefrontId[]} connectedStorefronts
 * @param {Record<ClientLoginTargetId, ClientAuthProbeState>} clientLogins
 * @param {string} [activeBottlePath]
 * @param {Record<string, any>} [options]
 * @returns {Promise<DiscoveredLocalStoreHint[]>}
 */
async function discoverLocalStoreHints(
  hostPlatform,
  homedir,
  userDataDir,
  connectedStorefronts,
  clientLogins,
  activeBottlePath = '',
  options = {}
) {
  /** @type {DiscoveredLocalStoreHint[]} */
  const hints = [];

  // 1. Steam hint from local loginusers.vdf
  if (!connectedStorefronts.includes('steam')) {
    const steamVdfCandidates = [
      {
        label: hostPlatform === 'darwin' ? 'Steam (macOS)' : 'Steam Desktop Client',
        vdfPath:
          hostPlatform === 'darwin'
            ? path.join(homedir, 'Library/Application Support/Steam/config/loginusers.vdf')
            : hostPlatform === 'win32'
              ? clientLogins.host_steam.binaryPath
                ? path.join(
                    path.dirname(clientLogins.host_steam.binaryPath),
                    'config/loginusers.vdf'
                  )
                : path.join(homedir, 'Program Files (x86)/Steam/config/loginusers.vdf')
              : path.join(homedir, '.local/share/Steam/config/loginusers.vdf'),
      },
      ...(hostPlatform === 'darwin' && activeBottlePath
        ? [
            {
              label: 'Windows Steam (Inside Bottle)',
              vdfPath: path.join(
                activeBottlePath,
                'drive_c/Program Files (x86)/Steam/config/loginusers.vdf'
              ),
            },
          ]
        : []),
    ];

    for (const cand of steamVdfCandidates) {
      if (!cand.vdfPath) continue;
      try {
        const vdfText = await fs.promises.readFile(cand.vdfPath, 'utf8');
        const active = parseSteamLoginUsersVdfDetails(vdfText);
        if (active && active.steamId64) {
          hints.push({
            storefrontId: 'steam',
            sourceLabel: cand.label,
            hasReusableSession: true,
            ...(active.personaName ? { publicHandleHint: active.personaName } : {}),
            publicSteamId: active.steamId64,
          });
          break;
        }
      } catch {}
    }
  }

  // 2. Epic hint from local legendary / Heroic user.json
  if (!connectedStorefronts.includes('epic') && !isStoreDisconnectedTombstoned('epic', userDataDir)) {
    const epicCandidates = [
      {
        label: 'Local Legendary CLI Session',
        filePath: path.join(homedir, '.config/legendary/user.json'),
      },
      {
        label: 'Heroic Games Launcher (Epic)',
        filePath: path.join(
          homedir,
          'Library/Application Support/heroic/legendaryConfig/legendary/user.json'
        ),
      },
      {
        label: 'Heroic Games Launcher (Epic)',
        filePath: path.join(
          !options.homedir && process.env.APPDATA
            ? process.env.APPDATA
            : path.join(homedir, 'AppData/Roaming'),
          'heroic/legendaryConfig/legendary/user.json'
        ),
      },
    ];
    let foundEpicHint = false;
    for (const cand of epicCandidates) {
      try {
        if (!fs.existsSync(cand.filePath)) continue;
        const parsed = JSON.parse(await fs.promises.readFile(cand.filePath, 'utf8'));
        const tok = String(parsed?.access_token || parsed?.refresh_token || '').trim();
        if (
          tok &&
          !isMockOrCorruptedToken(tok) &&
          !isPoisonedStorefrontToken(tok, options)
        ) {
          const handle = String(
            parsed.displayName || parsed.display_name || parsed.account_id || ''
          ).trim();
          hints.push({
            storefrontId: 'epic',
            sourceLabel: cand.label,
            hasReusableSession: true,
            ...(handle ? { publicHandleHint: handle } : {}),
          });
          foundEpicHint = true;
          break;
        }
      } catch {}
    }
    if (
      !foundEpicHint &&
      (clientLogins.host_epic.authenticated || clientLogins.bottle_epic.authenticated)
    ) {
      const epicLogin = clientLogins.host_epic.authenticated
        ? clientLogins.host_epic
        : clientLogins.bottle_epic;
      hints.push({
        storefrontId: 'epic',
        sourceLabel: epicLogin.label,
        hasReusableSession: false,
        ...(epicLogin.detectedAccountLabel
          ? { publicHandleHint: epicLogin.detectedAccountLabel }
          : {}),
      });
    }
  }

  // 3. GOG hint from Heroic / local gogdl auth.json or GOG Galaxy
  if (!connectedStorefronts.includes('gog') && !isStoreDisconnectedTombstoned('gog', userDataDir)) {
    const gogCandidates = [
      {
        label: 'Heroic Games Launcher (GOG)',
        filePath: path.join(homedir, 'Library/Application Support/heroic/gog_store/auth.json'),
      },
      {
        label: 'Heroic Games Launcher (GOG)',
        filePath: path.join(
          !options.homedir && process.env.APPDATA
            ? process.env.APPDATA
            : path.join(homedir, 'AppData/Roaming'),
          'heroic/gog_store/auth.json'
        ),
      },
      {
        label: 'Heroic Games Launcher (GOG)',
        filePath: path.join(homedir, '.config/heroic/gog_store/auth.json'),
      },
      {
        label: 'Local gogdl Session',
        filePath: path.join(userDataDir, 'gogdlConfig/auth.json'),
      },
    ];
    let foundGogHint = false;
    for (const cand of gogCandidates) {
      try {
        if (!fs.existsSync(cand.filePath)) continue;
        const parsed = JSON.parse(await fs.promises.readFile(cand.filePath, 'utf8'));
        const entry = parsed?.['46899977096215655'] || parsed;
        const tok = String(entry?.access_token || entry?.refresh_token || '').trim();
        if (
          tok &&
          !isMockOrCorruptedToken(tok) &&
          !isPoisonedStorefrontToken(tok, options)
        ) {
          const handle = String(entry.username || entry.user_id || entry.userId || '').trim();
          hints.push({
            storefrontId: 'gog',
            sourceLabel: cand.label,
            hasReusableSession: true,
            ...(handle ? { publicHandleHint: handle } : {}),
          });
          foundGogHint = true;
          break;
        }
      } catch {}
    }
    if (!foundGogHint && (clientLogins.host_gog.authenticated || clientLogins.bottle_gog.authenticated)) {
      const gogLogin = clientLogins.host_gog.authenticated
        ? clientLogins.host_gog
        : clientLogins.bottle_gog;
      hints.push({
        storefrontId: 'gog',
        sourceLabel: gogLogin.label,
        hasReusableSession: false,
        ...(gogLogin.detectedAccountLabel
          ? { publicHandleHint: gogLogin.detectedAccountLabel }
          : {}),
      });
    }
  }

  return hints;
}

/**
 * Helper to execute an async read-only command (`reg.exe`, etc.) with a bounded timeout.
 *
 * @param {Function} execFileFn
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string }>}
 */
function execReadOnlyProbe(execFileFn, cmd, args, timeoutMs = 1500) {
  return new Promise((resolve) => {
    try {
      execFileFn(
        cmd,
        args,
        { timeout: timeoutMs, windowsHide: true },
        (/** @type {any} */ err, /** @type {any} */ stdout, /** @type {any} */ stderr) => {
          resolve({
            ok: !err,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
          });
        }
      );
    } catch {
      resolve({ ok: false, stdout: '', stderr: '' });
    }
  });
}

/**
 * Perform a 100% read-only (`0` writes, `< 400ms`) comprehensive health check of OS prerequisites,
 * compatibility runners, bottles, host & bottled storefront clients, client login states, and
 * account mismatches.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<EnvironmentHealthSnapshot>}
 */
async function probeEnvironmentHealth(options = {}) {
  const startMs = performance.now();
  const rawPlatform = String(options.platform || process.platform).toLowerCase();
  /** @type {'darwin' | 'win32' | 'linux'} */
  const hostPlatform =
    rawPlatform === 'win32' ? 'win32' : rawPlatform === 'linux' ? 'linux' : 'darwin';
  const hostArch = String(options.arch || process.arch || 'arm64');
  const isAppleSiliconMac = hostPlatform === 'darwin' && hostArch === 'arm64';

  const { homedir, userDataDir } = resolveReadOnlyPaths(options);
  const wizardState = getSetupWizardState(options);
  const configuredSet = new Set(wizardState.configuredComponents);
  const savedTokens = await loadSavedTokensReadOnly(userDataDir, options);
  const connectedStorefronts = resolveConnectedStorefronts(savedTokens, userDataDir, options);

  const execFileFn =
    typeof options.execFileImpl === 'function'
      ? options.execFileImpl
      : typeof options.execFileFn === 'function'
        ? options.execFileFn
        : execFile;
  const hasInjectedExec =
    typeof options.execFileImpl === 'function' || typeof options.execFileFn === 'function';

  // Run async OS & write-access probes concurrently
  const [
    hasWriteAccessToSystemApplications,
    rosettaReady,
    vcRedistProbe,
    webview2Probe,
    winGamingServicesReady,
  ] = await Promise.all([
    // 1. macOS /Applications write access
    (async () => {
      if (hostPlatform !== 'darwin') return false;
      if (typeof options.hasWriteAccessToSystemApplications === 'boolean') {
        return options.hasWriteAccessToSystemApplications;
      }
      if (options.homedir || options.customApplicationsDir) {
        return false;
      }
      try {
        await fs.promises.access('/Applications', fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    })(),

    // 2. Apple Silicon Rosetta 2 probe
    (async () => {
      if (!isAppleSiliconMac) return false;
      if (typeof options.rosettaInstalled === 'boolean') {
        return options.rosettaInstalled;
      }
      const rosettaPaths = options.homedir && options.allowSystemRosettaInTest !== true
        ? [
            path.join(homedir, 'Library/Apple/usr/libexec/oah/libRosettaRuntime'),
            path.join(homedir, 'Library/Apple/usr/share/rosetta/rosetta'),
          ]
        : [
            '/Library/Apple/usr/libexec/oah/libRosettaRuntime',
            '/Library/Apple/usr/share/rosetta/rosetta',
          ];
      for (const rp of rosettaPaths) {
        try {
          await fs.promises.access(rp, fs.constants.F_OK);
          return true;
        } catch {}
      }
      return false;
    })(),

    // 3. Windows VC++ 2015-2022 Redistributable (x64) probe
    (async () => {
      if (hostPlatform !== 'win32') return { installed: false, version: undefined };
      if (typeof options.vcRedistInstalled === 'boolean') {
        return { installed: options.vcRedistInstalled, version: options.vcRedistVersion };
      }
      if (options.homedir && !hasInjectedExec) {
        const mockDll = path.join(homedir, 'Windows/System32/vcruntime140.dll');
        return { installed: fs.existsSync(mockDll), version: undefined };
      }
      if (process.platform !== 'win32' && !hasInjectedExec) {
        return { installed: false, version: undefined };
      }
      const regKeys = [
        'HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
        'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
      ];
      for (const key of regKeys) {
        const res = await execReadOnlyProbe(execFileFn, 'reg.exe', ['query', key]);
        if (res.ok && /Installed\s+REG_DWORD\s+0x1\b/i.test(res.stdout)) {
          const verMatch = res.stdout.match(/Version\s+REG_SZ\s+v?([^\r\n]+)/i);
          return {
            installed: true,
            version: verMatch ? verMatch[1].trim() : undefined,
          };
        }
      }
      return { installed: false, version: undefined };
    })(),

    // 4. Windows Edge WebView2 Runtime probe
    (async () => {
      if (hostPlatform !== 'win32') return { installed: false, version: undefined };
      if (typeof options.webview2Installed === 'boolean') {
        return { installed: options.webview2Installed, version: options.webview2Version };
      }
      if (options.homedir && !hasInjectedExec) {
        return { installed: false, version: undefined };
      }
      if (process.platform !== 'win32' && !hasInjectedExec) {
        return { installed: false, version: undefined };
      }
      const regKeys = [
        'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
      ];
      for (const key of regKeys) {
        const res = await execReadOnlyProbe(execFileFn, 'reg.exe', ['query', key, '/v', 'pv']);
        if (res.ok) {
          const pvMatch = res.stdout.match(/\bpv\s+REG_SZ\s+([^\r\n]+)/i);
          const pv = pvMatch ? pvMatch[1].trim() : '';
          if (pv && pv !== '0.0.0.0') {
            return { installed: true, version: pv };
          }
        }
      }
      return { installed: false, version: undefined };
    })(),

    // 5. Windows GamingServices probe
    (async () => {
      if (hostPlatform !== 'win32') return false;
      if (typeof options.gamingServicesInstalled === 'boolean') {
        return options.gamingServicesInstalled;
      }
      if (typeof options.hasGamingServices === 'boolean') {
        return options.hasGamingServices;
      }
      if (hasInjectedExec) {
        const res = await execReadOnlyProbe(execFileFn, 'reg.exe', [
          'query',
          'HKLM\\SYSTEM\\CurrentControlSet\\Services\\GamingServices',
        ]);
        if (res.ok) return true;
      }
      if (!options.homedir && process.platform === 'win32') {
        if (hasWindowsGamingServicesInstalled(options)) return true;
        if (resolveXboxClientBinaryPath(options)) return true;
      }
      return false;
    })(),
  ]);

  const preferredMacApplicationsDir = options.customApplicationsDir
    ? String(options.customApplicationsDir)
    : hostPlatform === 'darwin' && hasWriteAccessToSystemApplications
      ? '/Applications'
      : path.join(homedir, 'Applications');

  // Bundled helpers probe (passing no-op execFileSyncFn prevents xattr spawns on darwin)
  const readOnlyHelperOpts = {
    ...options,
    ...explicitHomedirOpt(options),
    ...(typeof options?.userDataDir === 'string' && options.userDataDir.trim()
      ? { userDataDir: options.userDataDir.trim() }
      : {}),
    execFileSyncFn: options.execFileSyncFn || (() => {}),
  };
  const gogdlPath = findGogdlBinary(readOnlyHelperOpts) || undefined;
  const legendaryPath = findLegendaryBinary(readOnlyHelperOpts) || undefined;
  const xboxBridgePath = resolveXboxBridgeDllPath(options);
  const gameInputBridgePath = resolveBundledGameInputBridgeDllPath(options);
  const xboxGdkBridgesReady = Boolean(xboxBridgePath && gameInputBridgePath);
  const metalPreloadReady = probeMetalPreloadDylibReadOnly(userDataDir, options);

  const bundledHelpers = {
    gogdlReady: Boolean(gogdlPath),
    ...(gogdlPath ? { gogdlPath } : {}),
    legendaryReady: Boolean(legendaryPath),
    ...(legendaryPath ? { legendaryPath } : {}),
    xboxGdkBridgesReady,
    metalPreloadReady,
  };

  // Compatibility runners & bottles (macOS only)
  let detectedRunners = [];
  if (hostPlatform === 'darwin') {
    try {
      detectedRunners = detectCompatibilityLayers({
        ...options,
        ...explicitHomedirOpt(options),
        readOnly: true,
      });
    } catch {
      detectedRunners = [];
    }
  }

  /** @type {Record<string, any>} */
  const runnerUpdates =
    hostPlatform === 'darwin' && options.mockFeeds
      ? await checkCompatibilityLayerUpdates({
          ...options,
          ...explicitHomedirOpt(options),
          layers: detectedRunners,
          skipNetwork: true,
        })
      : {};

  const bottleSummary = buildBottleEnvironmentSummary(
    hostPlatform,
    homedir,
    detectedRunners,
    wizardState,
    options
  );

  // Client auth probe across all 6 targets
  const clientLogins = await probeClientLoginStates({
    ...options,
    ...explicitHomedirOpt(options),
    ...(typeof options?.userDataDir === 'string' && options.userDataDir.trim()
      ? { userDataDir: options.userDataDir.trim() }
      : {}),
    platform: hostPlatform,
    savedTokens,
    connectedStorefronts,
    _detectedRunners: detectedRunners,
    _bottleSummary: bottleSummary,
  });

  // Reverse-discovery hints for unconnected storefronts
  const localStoreHints = await discoverLocalStoreHints(
    hostPlatform,
    homedir,
    userDataDir,
    connectedStorefronts,
    clientLogins,
    bottleSummary.activeBottlePath || '',
    options
  );

  const steamRelevant =
    connectedStorefronts.includes('steam') || connectedStorefronts.length === 0;
  const skipRunnerSelected = wizardState.preferredRunnerType === 'skip';
  const noMacRunnersInstalled = hostPlatform === 'darwin' && detectedRunners.length === 0;

  const formatRemovedPrefix = (
    /** @type {EnvironmentComponentId} */ id,
    /** @type {EnvironmentComponentStatus} */ status,
    /** @type {string} */ detail
  ) => {
    if (configuredSet.has(id) && status === 'missing') {
      return `Previously Installed — Removed · ${detail}`;
    }
    return detail;
  };

  /**
   * Build runner component state cleanly.
   *
   * @param {EnvironmentComponentId} id
   * @param {NonNativeRunnerType} runnerType
   * @param {object} meta
   * @param {string} meta.title
   * @param {string} meta.shortLabel
   * @param {RecommendationTier} meta.tier
   * @param {string} meta.badge
   * @param {boolean} meta.defaultSelected
   * @param {boolean} meta.canAutoInstall
   * @param {boolean} [meta.requiresExternalDownload]
   * @param {string} [meta.externalDownloadUrl]
   * @param {number} [meta.estimatedDownloadMB]
   * @param {string} meta.whyExplanation
   * @param {string} [meta.footprintNote]
   * @param {string} [meta.tradeoffNote]
   * @returns {EnvironmentComponentState}
   */
  const buildRunnerComponent = (id, runnerType, meta) => {
    if (hostPlatform !== 'darwin') {
      return {
        id,
        category: 'compatibility_runner',
        scope: 'system',
        title: meta.title,
        shortLabel: meta.shortLabel,
        status: 'not_applicable',
        wasPreviouslyConfigured: configuredSet.has(id),
        canAutoInstall: false,
        recommendationTier: 'not_needed',
        recommendationBadge: 'Not Applicable on Windows',
        defaultSelected: false,
        whyExplanation: meta.whyExplanation,
        statusDetail: 'Windows games run natively on Windows without a translation layer.',
      };
    }

    const layer = detectedRunners.find((r) => r.type === runnerType);
    if (runnerType === 'gptk' && !isAppleSiliconMac && !layer) {
      return {
        id,
        category: 'compatibility_runner',
        scope: 'system',
        title: meta.title,
        shortLabel: meta.shortLabel,
        status: 'not_applicable',
        wasPreviouslyConfigured: configuredSet.has(id),
        canAutoInstall: false,
        recommendationTier: 'not_needed',
        recommendationBadge: 'Apple Silicon Only',
        defaultSelected: false,
        whyExplanation: meta.whyExplanation,
        statusDetail: 'Apple Game Porting Toolkit requires a Mac with Apple Silicon.',
      };
    }
    const upd = runnerUpdates[runnerType];
    /** @type {EnvironmentComponentStatus} */
    const status = layer
      ? upd?.updateAvailable
        ? 'update_available'
        : 'ready'
      : 'missing';
    const rawDetail = layer
      ? upd?.updateAvailable
        ? `Installed (${layer.displayVersion || layer.version || 'Installed'}) — Update ${upd.latestDisplayVersion || upd.latestVersion} available`
        : `Installed${layer.displayVersion || layer.version ? ` (${layer.displayVersion || layer.version})` : ''}`
      : meta.requiresExternalDownload
        ? 'Not installed — requires manual download'
        : 'Not installed';

    return {
      id,
      category: 'compatibility_runner',
      scope: 'system',
      title: meta.title,
      shortLabel: meta.shortLabel,
      status,
      ...(layer?.displayVersion || layer?.version
        ? { version: layer.displayVersion || layer.version }
        : {}),
      ...(upd?.latestDisplayVersion || upd?.latestVersion
        ? { latestVersion: upd.latestDisplayVersion || upd.latestVersion }
        : {}),
      ...(layer?.binaryPath ? { binaryPath: layer.binaryPath } : {}),
      ...(layer?.appPath ? { installLocation: layer.appPath } : {}),
      wasPreviouslyConfigured: configuredSet.has(id),
      canAutoInstall: meta.canAutoInstall,
      ...(meta.requiresExternalDownload ? { requiresExternalDownload: true } : {}),
      ...(meta.externalDownloadUrl ? { externalDownloadUrl: meta.externalDownloadUrl } : {}),
      ...(meta.estimatedDownloadMB ? { estimatedDownloadMB: meta.estimatedDownloadMB } : {}),
      recommendationTier: meta.tier,
      recommendationBadge: meta.badge,
      defaultSelected: status === 'missing' ? meta.defaultSelected : false,
      whyExplanation: meta.whyExplanation,
      ...(meta.footprintNote ? { footprintNote: meta.footprintNote } : {}),
      ...(meta.tradeoffNote ? { tradeoffNote: meta.tradeoffNote } : {}),
      statusDetail: formatRemovedPrefix(id, status, rawDetail),
    };
  };

  // Assemble all 15 EnvironmentComponentState records
  /** @type {EnvironmentComponentStatus} */
  const rosettaStatus = !isAppleSiliconMac
    ? 'not_applicable'
    : rosettaReady
      ? 'ready'
      : 'missing';

  /** @type {EnvironmentComponentStatus} */
  const vcRedistStatus =
    hostPlatform !== 'win32' ? 'not_applicable' : vcRedistProbe.installed ? 'ready' : 'missing';

  /** @type {EnvironmentComponentStatus} */
  const webview2Status =
    hostPlatform !== 'win32' ? 'not_applicable' : webview2Probe.installed ? 'ready' : 'missing';

  /** @type {EnvironmentComponentStatus} */
  const bottleDefaultStatus =
    hostPlatform !== 'darwin'
      ? 'not_applicable'
      : bottleSummary.availableBottles.length > 0
        ? 'ready'
        : 'missing';

  const bottleDefaultSelected =
    hostPlatform === 'darwin' &&
    bottleDefaultStatus === 'missing' &&
    !skipRunnerSelected;

  /** @type {EnvironmentComponentStatus} */
  const hostSteamStatus = clientLogins.host_steam.installed ? 'ready' : 'missing';
  /** @type {EnvironmentComponentStatus} */
  const bottleSteamStatus =
    hostPlatform !== 'darwin'
      ? 'not_applicable'
      : clientLogins.bottle_steam.installed
        ? 'ready'
        : 'missing';

  /** @type {EnvironmentComponentStatus} */
  const hostGogStatus = clientLogins.host_gog.installed ? 'ready' : 'missing';
  /** @type {EnvironmentComponentStatus} */
  const bottleGogStatus =
    hostPlatform !== 'darwin'
      ? 'not_applicable'
      : clientLogins.bottle_gog.installed
        ? 'ready'
        : 'missing';

  /** @type {EnvironmentComponentStatus} */
  const hostEpicStatus = clientLogins.host_epic.installed ? 'ready' : 'missing';
  /** @type {EnvironmentComponentStatus} */
  const bottleEpicStatus =
    hostPlatform !== 'darwin'
      ? 'not_applicable'
      : clientLogins.bottle_epic.installed
        ? 'ready'
        : 'missing';

  /** @type {EnvironmentComponentStatus} */
  const xboxRuntimeStatus =
    hostPlatform === 'darwin'
      ? xboxGdkBridgesReady
        ? 'ready'
        : 'missing'
      : hostPlatform === 'win32'
        ? winGamingServicesReady
          ? 'ready'
          : 'missing'
        : 'not_applicable';

  /** @type {Record<EnvironmentComponentId, EnvironmentComponentState>} */
  const components = {
    rosetta2: {
      id: 'rosetta2',
      category: 'os_prerequisite',
      scope: 'system',
      title: 'Apple Rosetta 2',
      shortLabel: 'Rosetta 2',
      status: rosettaStatus,
      wasPreviouslyConfigured: configuredSet.has('rosetta2'),
      canAutoInstall: isAppleSiliconMac,
      estimatedDownloadMB: 5,
      recommendationTier: isAppleSiliconMac ? 'required' : 'not_needed',
      recommendationBadge: isAppleSiliconMac ? 'Required' : 'Not Needed',
      defaultSelected: rosettaStatus === 'missing',
      whyExplanation:
        'Lets your Mac run Windows games and older Mac games.',
      statusDetail: !isAppleSiliconMac
        ? 'Not needed on this computer.'
        : rosettaReady
          ? 'Installed.'
          : formatRemovedPrefix(
              'rosetta2',
              rosettaStatus,
              'Needed to run Windows games on Mac.'
            ),
    },

    win_vcredist: {
      id: 'win_vcredist',
      category: 'os_prerequisite',
      scope: 'system',
      title: 'Microsoft Visual C++',
      shortLabel: 'Visual C++',
      status: vcRedistStatus,
      ...(vcRedistProbe.version ? { version: vcRedistProbe.version } : {}),
      wasPreviouslyConfigured: configuredSet.has('win_vcredist'),
      canAutoInstall: hostPlatform === 'win32',
      estimatedDownloadMB: 25,
      recommendationTier: hostPlatform === 'win32' ? 'recommended' : 'not_needed',
      recommendationBadge: hostPlatform === 'win32' ? 'Recommended' : 'Windows Only',
      defaultSelected: vcRedistStatus === 'missing',
      whyExplanation:
        'Needed by most Windows games to start.',
      statusDetail:
        hostPlatform !== 'win32'
          ? 'Not needed on Mac.'
          : vcRedistProbe.installed
            ? `Installed${vcRedistProbe.version ? ` (${vcRedistProbe.version})` : ''}.`
            : formatRemovedPrefix(
                'win_vcredist',
                vcRedistStatus,
                'Needed by most PC games.'
              ),
    },

    win_webview2: {
      id: 'win_webview2',
      category: 'os_prerequisite',
      scope: 'system',
      title: 'Microsoft Edge WebView2',
      shortLabel: 'WebView2',
      status: webview2Status,
      ...(webview2Probe.version ? { version: webview2Probe.version } : {}),
      wasPreviouslyConfigured: configuredSet.has('win_webview2'),
      canAutoInstall: false,
      ...(hostPlatform === 'win32' && !webview2Probe.installed
        ? {
            requiresExternalDownload: true,
            externalDownloadUrl: 'https://go.microsoft.com/fwlink/p/?LinkId=2124703',
          }
        : {}),
      recommendationTier: hostPlatform === 'win32' ? 'optional' : 'not_needed',
      recommendationBadge: hostPlatform === 'win32' ? 'Built In' : 'Windows Only',
      defaultSelected: false,
      whyExplanation:
        'Used for store sign-in windows on Windows.',
      statusDetail:
        hostPlatform !== 'win32'
          ? 'Not needed on Mac.'
          : webview2Probe.installed
            ? `Installed (${webview2Probe.version}).`
            : 'Available from Microsoft if sign-in windows fail to open.',
    },

    runner_crossover: buildRunnerComponent('runner_crossover', 'crossover', {
      title: 'CrossOver',
      shortLabel: 'CrossOver',
      tier: 'recommended',
      badge: 'Recommended',
      defaultSelected:
        noMacRunnersInstalled &&
        !skipRunnerSelected &&
        wizardState.preferredRunnerType !== 'wine',
      canAutoInstall: true,
      estimatedDownloadMB: 420,
      whyExplanation:
        'Best compatibility and performance for Windows games on Mac. Paid app by CodeWeavers with a free 14-day trial.',
      tradeoffNote: 'Paid app with a 14-day free trial — or choose free Wine below.',
    }),

    runner_crossover_preview: buildRunnerComponent(
      'runner_crossover_preview',
      'crossover_preview',
      {
        title: 'CrossOver Preview',
        shortLabel: 'CrossOver Preview',
        tier: 'optional',
        badge: 'Optional',
        defaultSelected: false,
        canAutoInstall: false,
        requiresExternalDownload: true,
        externalDownloadUrl: 'https://www.codeweavers.com/preview/download',
        whyExplanation:
          'Early-access version of CrossOver for active subscribers.',
      }
    ),

    runner_wine: buildRunnerComponent('runner_wine', 'wine', {
      title: 'Wine',
      shortLabel: 'Wine',
      tier: 'optional',
      badge: 'Free',
      defaultSelected: wizardState.preferredRunnerType === 'wine',
      canAutoInstall: true,
      estimatedDownloadMB: 240,
      whyExplanation:
        'Free, open-source way to run Windows games on Mac. Great for older and lighter games.',
      tradeoffNote: 'Completely free, though newer 3D games run better in CrossOver.',
    }),

    runner_gptk: buildRunnerComponent('runner_gptk', 'gptk', {
      title: 'Apple Game Porting Toolkit',
      shortLabel: 'Apple GPTK',
      tier: 'optional',
      badge: 'Advanced',
      defaultSelected: false,
      canAutoInstall: false,
      requiresExternalDownload: true,
      externalDownloadUrl: 'https://developer.apple.com/games/game-porting-toolkit/',
      whyExplanation:
        'Apple’s developer tool. Not needed if you use CrossOver, which already includes it.',
    }),

    bottle_default: {
      id: 'bottle_default',
      category: 'bottle',
      scope: 'bottle',
      title: `Windows Game Bottle ("${bottleSummary.recommendedBottleName}")`,
      shortLabel: 'Windows Bottle',
      status: bottleDefaultStatus,
      ...(bottleSummary.activeBottlePath
        ? { installLocation: bottleSummary.activeBottlePath }
        : {}),
      wasPreviouslyConfigured: configuredSet.has('bottle_default'),
      canAutoInstall: hostPlatform === 'darwin',
      recommendationTier: hostPlatform === 'darwin' ? 'recommended' : 'not_needed',
      recommendationBadge:
        hostPlatform !== 'darwin'
          ? 'Mac Only'
          : bottleDefaultStatus === 'ready'
            ? 'Ready'
            : 'Recommended',
      defaultSelected: bottleDefaultSelected,
      whyExplanation:
        'A dedicated folder that keeps your Windows games and saves neatly separated from your Mac files.',
      statusDetail:
        hostPlatform !== 'darwin'
          ? 'Not needed on Windows.'
          : bottleDefaultStatus === 'ready'
            ? `Using "${bottleSummary.recommendedBottleName}".`
            : formatRemovedPrefix(
                'bottle_default',
                bottleDefaultStatus,
                `Will set up "${bottleSummary.recommendedBottleName}".`
              ),
    },

    bottle_steam: {
      id: 'bottle_steam',
      category: 'bottle_client',
      storefrontId: 'steam',
      scope: 'bottle',
      title: 'Steam (Windows)',
      shortLabel: 'Steam (Windows)',
      status: bottleSteamStatus,
      ...(clientLogins.bottle_steam.binaryPath
        ? { binaryPath: clientLogins.bottle_steam.binaryPath }
        : {}),
      ...(bottleSummary.activeBottlePath
        ? { installLocation: bottleSummary.activeBottlePath }
        : {}),
      wasPreviouslyConfigured: configuredSet.has('bottle_steam'),
      canAutoInstall: hostPlatform === 'darwin',
      estimatedDownloadMB: 240,
      recommendationTier:
        hostPlatform !== 'darwin'
          ? 'not_needed'
          : steamRelevant
            ? 'recommended'
            : 'optional',
      recommendationBadge:
        hostPlatform !== 'darwin'
          ? 'Mac Only'
          : steamRelevant
            ? 'Recommended'
            : 'Optional',
      defaultSelected:
        hostPlatform === 'darwin' &&
        bottleSteamStatus === 'missing' &&
        steamRelevant &&
        !skipRunnerSelected,
      whyExplanation:
        'Needed to download and play Windows-only Steam games on your Mac.',
      statusDetail:
        hostPlatform !== 'darwin'
          ? 'Not needed on Windows.'
          : bottleSteamStatus === 'ready'
            ? clientLogins.bottle_steam.statusSummary
            : formatRemovedPrefix(
                'bottle_steam',
                bottleSteamStatus,
                'Not installed yet.'
              ),
    },

    host_steam: {
      id: 'host_steam',
      category: 'host_client',
      storefrontId: 'steam',
      scope: 'host',
      title: hostPlatform === 'darwin' ? 'Steam (Mac)' : 'Steam',
      shortLabel: hostPlatform === 'darwin' ? 'Steam (Mac)' : 'Steam',
      status: hostSteamStatus,
      ...(clientLogins.host_steam.binaryPath
        ? { binaryPath: clientLogins.host_steam.binaryPath }
        : {}),
      wasPreviouslyConfigured: configuredSet.has('host_steam'),
      canAutoInstall: hostPlatform === 'darwin' || hostPlatform === 'win32',
      estimatedDownloadMB: 220,
      recommendationTier: steamRelevant ? 'recommended' : 'optional',
      recommendationBadge: steamRelevant ? 'Recommended' : 'Optional',
      defaultSelected: hostSteamStatus === 'missing' && steamRelevant,
      whyExplanation:
        hostPlatform === 'darwin'
          ? 'Needed to download and play Mac Steam games. Uncheck if you only play Windows Steam games.'
          : 'Needed to download and play your Steam games.',
      statusDetail:
        hostSteamStatus === 'ready'
          ? clientLogins.host_steam.statusSummary
          : formatRemovedPrefix(
              'host_steam',
              hostSteamStatus,
              'Not installed yet.'
            ),
    },

    host_gog: {
      id: 'host_gog',
      category: 'host_client',
      storefrontId: 'gog',
      scope: 'host',
      title: hostPlatform === 'darwin' ? 'GOG Galaxy (Mac)' : 'GOG Galaxy',
      shortLabel: hostPlatform === 'darwin' ? 'GOG Galaxy (Mac)' : 'GOG Galaxy',
      status: hostGogStatus,
      ...(clientLogins.host_gog.binaryPath
        ? { binaryPath: clientLogins.host_gog.binaryPath }
        : {}),
      wasPreviouslyConfigured: configuredSet.has('host_gog'),
      canAutoInstall: hostPlatform === 'darwin' || hostPlatform === 'win32',
      estimatedDownloadMB: 280,
      recommendationTier: 'optional',
      recommendationBadge: 'Optional — Achievements Only',
      defaultSelected: false,
      whyExplanation:
        'Downloads and cloud saves already work without GOG Galaxy (via built-in gogdl). Only install Galaxy if you want GOG achievements or multiplayer.',
      statusDetail:
        hostGogStatus === 'ready'
          ? clientLogins.host_gog.statusSummary
          : formatRemovedPrefix(
              'host_gog',
              hostGogStatus,
              'Not installed (optional).'
            ),
    },

    bottle_gog: {
      id: 'bottle_gog',
      category: 'bottle_client',
      storefrontId: 'gog',
      scope: 'bottle',
      title: 'GOG Galaxy (Windows)',
      shortLabel: 'GOG Galaxy (Windows)',
      status: bottleGogStatus,
      ...(clientLogins.bottle_gog.binaryPath
        ? { binaryPath: clientLogins.bottle_gog.binaryPath }
        : {}),
      ...(bottleSummary.activeBottlePath
        ? { installLocation: bottleSummary.activeBottlePath }
        : {}),
      wasPreviouslyConfigured: configuredSet.has('bottle_gog'),
      canAutoInstall: hostPlatform === 'darwin',
      estimatedDownloadMB: 290,
      recommendationTier: hostPlatform === 'darwin' ? 'optional' : 'not_needed',
      recommendationBadge:
        hostPlatform === 'darwin' ? 'Optional — Achievements Only' : 'Mac Only',
      defaultSelected: false,
      whyExplanation:
        'Downloads and cloud saves already work without GOG Galaxy (via built-in gogdl). Only install Galaxy if you want GOG achievements or multiplayer.',
      statusDetail:
        hostPlatform !== 'darwin'
          ? 'Not needed on Windows.'
          : bottleGogStatus === 'ready'
            ? clientLogins.bottle_gog.statusSummary
            : formatRemovedPrefix(
                'bottle_gog',
                bottleGogStatus,
                'Not installed (optional).'
              ),
    },

    host_epic: {
      id: 'host_epic',
      category: 'host_client',
      storefrontId: 'epic',
      scope: 'host',
      title:
        hostPlatform === 'darwin' ? 'Epic Games Launcher (Mac)' : 'Epic Games Launcher',
      shortLabel: hostPlatform === 'darwin' ? 'Epic Launcher (Mac)' : 'Epic Launcher',
      status: hostEpicStatus,
      ...(clientLogins.host_epic.binaryPath
        ? { binaryPath: clientLogins.host_epic.binaryPath }
        : {}),
      wasPreviouslyConfigured: configuredSet.has('host_epic'),
      canAutoInstall: hostPlatform === 'darwin' || hostPlatform === 'win32',
      estimatedDownloadMB: 520,
      recommendationTier: 'not_needed',
      recommendationBadge: 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Downloads, cloud saves, achievements, and multiplayer already work without it (via built-in legendary). Only install if you want the Epic social overlay.',
      statusDetail:
        hostEpicStatus === 'ready'
          ? clientLogins.host_epic.statusSummary
          : formatRemovedPrefix(
              'host_epic',
              hostEpicStatus,
              'Not installed (not needed).'
            ),
    },

    bottle_epic: {
      id: 'bottle_epic',
      category: 'bottle_client',
      storefrontId: 'epic',
      scope: 'bottle',
      title: 'Epic Games Launcher (Windows)',
      shortLabel: 'Epic Launcher (Windows)',
      status: bottleEpicStatus,
      ...(clientLogins.bottle_epic.binaryPath
        ? { binaryPath: clientLogins.bottle_epic.binaryPath }
        : {}),
      ...(bottleSummary.activeBottlePath
        ? { installLocation: bottleSummary.activeBottlePath }
        : {}),
      wasPreviouslyConfigured: configuredSet.has('bottle_epic'),
      canAutoInstall: hostPlatform === 'darwin',
      estimatedDownloadMB: 540,
      recommendationTier: 'not_needed',
      recommendationBadge: hostPlatform === 'darwin' ? 'Not Needed' : 'Mac Only',
      defaultSelected: false,
      whyExplanation:
        'Downloads, cloud saves, achievements, and multiplayer already work without it (via built-in legendary). Only install if you want the Epic social overlay.',
      statusDetail:
        hostPlatform !== 'darwin'
          ? 'Not needed on Windows.'
          : bottleEpicStatus === 'ready'
            ? clientLogins.bottle_epic.statusSummary
            : formatRemovedPrefix(
                'bottle_epic',
                bottleEpicStatus,
                'Not installed (not needed).'
              ),
    },

    xbox_runtime: {
      id: 'xbox_runtime',
      category: 'built_in_runtime',
      storefrontId: 'xbox',
      scope: hostPlatform === 'darwin' ? 'bottle' : 'system',
      title: 'Microsoft Gaming Services',
      shortLabel: 'Gaming Services',
      status: xboxRuntimeStatus,
      ...(xboxBridgePath ? { binaryPath: xboxBridgePath } : {}),
      wasPreviouslyConfigured: configuredSet.has('xbox_runtime'),
      canAutoInstall: false,
      ...(hostPlatform === 'win32' && xboxRuntimeStatus === 'missing'
        ? {
            requiresExternalDownload: true,
            externalDownloadUrl: 'ms-windows-store://pdp/?productid=9MWPM2CQNLHN',
          }
        : {}),
      recommendationTier:
        hostPlatform === 'darwin'
          ? 'built_in'
          : hostPlatform === 'win32'
            ? 'recommended'
            : 'not_needed',
      recommendationBadge:
        hostPlatform === 'darwin'
          ? 'Built In'
          : xboxRuntimeStatus === 'ready'
            ? 'Ready'
            : 'Recommended',
      defaultSelected: false,
      whyExplanation:
        hostPlatform === 'darwin'
          ? 'Xbox and PC Game Pass support is built in — no extra app needed.'
          : 'Needed on Windows to play PC Game Pass and Microsoft Store games.',
      statusDetail:
        hostPlatform === 'darwin'
          ? xboxGdkBridgesReady
            ? 'Ready.'
            : 'Missing built-in files.'
          : hostPlatform === 'win32'
            ? winGamingServicesReady
              ? 'Installed.'
              : 'Install Gaming Services from the Microsoft Store for PC Game Pass games.'
            : 'Not needed.',
    },
  };

  // Compute summary counts
  const componentValues = Object.values(components);
  const loginValues = Object.values(clientLogins);

  const counts = {
    readyCount: componentValues.filter((c) => c.status === 'ready').length,
    missingRecommendedCount: componentValues.filter(
      (c) =>
        (c.recommendationTier === 'required' || c.recommendationTier === 'recommended') &&
        (c.status === 'missing' || c.status === 'partially_configured')
    ).length,
    removedSinceLastSetupCount: componentValues.filter(
      (c) => c.wasPreviouslyConfigured === true && c.status === 'missing'
    ).length,
    pendingClientLoginCount: loginValues.filter((l) => l.installed && !l.authenticated).length,
    accountMismatchCount: loginValues.filter(
      (l) => l.installed && l.authenticated && l.accountMatchesOneLauncher === false
    ).length,
    updateAvailableCount: componentValues.filter((c) => c.status === 'update_available').length,
  };

  const probeDurationMs = Math.max(0, Math.round(performance.now() - startMs));

  return {
    probedAt: new Date().toISOString(),
    probeDurationMs,
    hostPlatform,
    hostArch,
    isAppleSiliconMac,
    hasWriteAccessToSystemApplications,
    preferredMacApplicationsDir,
    connectedStorefronts,
    bundledHelpers,
    detectedRunners,
    bottleSummary,
    components,
    clientLogins,
    localStoreHints,
    counts,
  };
}

module.exports = {
  getSetupWizardState,
  saveSetupWizardState,
  loadSavedTokensReadOnly,
  probeClientLoginStates,
  probeEnvironmentHealth,
  parseSteamLoginUsersVdfDetails,
  parseEpicGameUserSettingsIni,
  parseWineGogRegistryUser,
  readGogGalaxyDbUserReadOnly,
};
