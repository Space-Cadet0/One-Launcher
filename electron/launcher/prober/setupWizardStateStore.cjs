// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  isValidEnvironmentComponentId,
  isValidPreferredRunner,
} = require('../policy/environmentCatalog.cjs');
const {
  getElectron,
  getStoreSync,
  getConfiguredUserDataDir,
  resolveIsolatedHomedirAndUserData,
  safeIsBottleSlug,
} = require('../engineStateRegistry.cjs');
const {
  toHostFilesystemPath,
  atomicWriteFileSync,
  isStoreDisconnectedTombstoned,
} = require('../securityAndPathUtils.cjs');
const {
  isMockOrCorruptedToken,
  isPoisonedStorefrontToken,
} = require('../epicLegendaryAndEosCoordinator.cjs');

/**
 * @typedef {import('../policy/environmentCatalog.cjs').EnvironmentComponentId} EnvironmentComponentId
 * @typedef {import('../policy/environmentCatalog.cjs').ClientLoginTargetId} ClientLoginTargetId
 * @typedef {import('../policy/environmentCatalog.cjs').NonNativeRunnerType} NonNativeRunnerType
 * @typedef {import('../policy/environmentCatalog.cjs').PreferredRunnerSelection} PreferredRunnerSelection
 * @typedef {'os_prerequisite' | 'compatibility_runner' | 'bottle' | 'host_client' | 'bottle_client' | 'built_in_runtime'} EnvironmentComponentCategory
 * @typedef {'ready' | 'partially_configured' | 'missing' | 'update_available' | 'not_applicable'} EnvironmentComponentStatus
 * @typedef {'required' | 'recommended' | 'optional' | 'not_needed' | 'built_in'} RecommendationTier
 * @typedef {'steam' | 'gog' | 'epic' | 'amazon' | 'xbox' | 'ubisoft' | 'ea' | 'bnet' | 'itch' | 'rockstar' | 'riot' | 'humble' | 'custom'} StorefrontId
 */

/**
 * @typedef {object} SetupWizardPersistedState
 * @property {1} schemaVersion
 * @property {string | null} completedAt
 * @property {string | null} dismissedAt
 * @property {string | null} lastHealthCheckAt
 * @property {PreferredRunnerSelection} [preferredRunnerType]
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
 * @property {'steam' | 'gog' | 'epic' | 'ubisoft' | 'ea' | 'bnet' | 'rockstar' | 'riot'} storefrontId
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
 * @property {Array<{ name: string, path: string, runnerType: NonNativeRunnerType, wineArch?: 'win64' | 'arm64', bottleArch?: 'win64' | 'arm64', previewEnabled?: boolean, hasSteam: boolean, hasGogGalaxy: boolean, hasEpicLauncher: boolean, isSandboxed: boolean }>} availableBottles
 * @property {'reuse_existing' | 'create_dedicated'} recommendedBottleMode
 * @property {string} recommendedBottleName
 * @property {string} [activeBottlePath]
 * @property {'win64' | 'arm64'} [wineArch]
 * @property {'win64' | 'arm64'} [bottleArch]
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
  'riot',
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
    if (id && isValidEnvironmentComponentId(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
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
    if (isValidPreferredRunner(rt)) {
      base.preferredRunnerType = rt;
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
        } = require('../../storefronts/tokenVault.cjs');
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
  const electronRoot = path.resolve(__dirname, '..', '..');
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

module.exports = {
  SETUP_WIZARD_STATE_FILENAME,
  VALID_STOREFRONT_IDS,
  explicitHomedirOpt,
  resolveReadOnlyPaths,
  createDefaultSetupWizardState,
  sanitizeConfiguredComponents,
  sanitizeSetupWizardStateObject,
  getSetupWizardState,
  saveSetupWizardState,
  loadSavedTokensReadOnly,
  resolveConnectedStorefronts,
  probeMetalPreloadDylibReadOnly,
};
