// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const {
  ENVIRONMENT_COMPONENT_CATALOG,
  resolveComponentScopeForHost,
} = require('../policy/environmentCatalog.cjs');
const {
  isTestEnvironment,
  findGogdlBinary,
  findLegendaryBinary,
} = require('../engineStateRegistry.cjs');
const {
  refreshHostWindowsKnownFoldersAsync,
  discoverWindowsLocalDrivesAsync,
} = require('../securityAndPathUtils.cjs');
const {
  refreshWindowsStorefrontRegistryCacheAsync,
} = require('../../utils/windowsRegistryDiscovery.cjs');
const {
  resolveXboxBridgeDllPath,
  resolveBundledGameInputBridgeDllPath,
} = require('../wineAndCrossOverManager.cjs');
const { hasWindowsGamingServicesInstalled } = require('../diskAndVolumeInspector.cjs');
const { resolveXboxClientBinaryPath } = require('../windowsXboxAppxAndMsixvcOrchestrator.cjs');
const { CHAINED_PUBLISHER_ECOSYSTEMS } = require('../chainedPublisherLaunchers.cjs');
const {
  explicitHomedirOpt,
  resolveReadOnlyPaths,
  getSetupWizardState,
  loadSavedTokensReadOnly,
  resolveConnectedStorefronts,
  probeMetalPreloadDylibReadOnly,
} = require('./setupWizardStateStore.cjs');
const {
  resolveProberRunnerUpdatesAsync,
  detectRunnersReadOnly,
  buildBottleEnvironmentSummaryAsync,
} = require('./bottleAndRunnerProber.cjs');
const {
  probeClientLoginStates,
  discoverLocalStoreHints,
} = require('./clientAuthSessionProber.cjs');

/**
 * @typedef {import('./setupWizardStateStore.cjs').EnvironmentComponentId} EnvironmentComponentId
 * @typedef {import('./setupWizardStateStore.cjs').EnvironmentComponentCategory} EnvironmentComponentCategory
 * @typedef {import('./setupWizardStateStore.cjs').EnvironmentComponentStatus} EnvironmentComponentStatus
 * @typedef {import('./setupWizardStateStore.cjs').RecommendationTier} RecommendationTier
 * @typedef {import('./setupWizardStateStore.cjs').ClientLoginTargetId} ClientLoginTargetId
 * @typedef {import('./setupWizardStateStore.cjs').NonNativeRunnerType} NonNativeRunnerType
 * @typedef {import('./setupWizardStateStore.cjs').EnvironmentComponentState} EnvironmentComponentState
 * @typedef {import('./setupWizardStateStore.cjs').EnvironmentHealthSnapshot} EnvironmentHealthSnapshot
 */

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
 * Perform a comprehensive health check of OS prerequisites, compatibility runners, bottles,
 * host & bottled storefront clients, client login states, and account mismatches.
 * Passing `{ readOnly: true }` or `{ persistRunnerUpdateCache: false }` enforces strictly
 * zero filesystem writes (including skipping 24h runner update cache persistence on disk).
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
  const darwinKernelMajor =
    typeof options.darwinKernelMajor === 'number' && Number.isFinite(options.darwinKernelMajor)
      ? options.darwinKernelMajor
      : typeof options.osRelease === 'string' && options.osRelease.trim()
        ? Number.parseInt(options.osRelease.trim().split('.')[0] || '0', 10) || 24
        : process.platform === 'darwin'
          ? Number.parseInt(String(os.release() || '24.0.0').split('.')[0] || '24', 10) || 24
          : 24;
  const isGptkAutoInstallSupported = isAppleSiliconMac && darwinKernelMajor >= 23;

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

  if (
    hostPlatform === 'win32' &&
    (!isTestEnvironment(options) || options.prewarmWindowsCaches === true)
  ) {
    const prewarmOpts = options.prewarmWindowsCaches === true ? options : { platform: hostPlatform };
    await Promise.all([
      refreshWindowsStorefrontRegistryCacheAsync(prewarmOpts).catch(() => {}),
      refreshHostWindowsKnownFoldersAsync(prewarmOpts).catch(() => {}),
      discoverWindowsLocalDrivesAsync(prewarmOpts).catch(() => {}),
    ]);
  }

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
      const rosettaPaths =
        options.homedir && options.allowSystemRosettaInTest !== true
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
        try {
          await fs.promises.access(mockDll, fs.constants.F_OK);
          return { installed: true, version: undefined };
        } catch {
          return { installed: false, version: undefined };
        }
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
  const detectedRunners =
    hostPlatform === 'darwin'
      ? Array.isArray(options.layers)
        ? options.layers
        : detectRunnersReadOnly(options)
      : [];

  const [runnerUpdates, bottleSummary] = await Promise.all([
    resolveProberRunnerUpdatesAsync(hostPlatform, userDataDir, detectedRunners, options),
    buildBottleEnvironmentSummaryAsync(
      hostPlatform,
      homedir,
      detectedRunners,
      wizardState,
      options
    ),
  ]);

  // Client auth probe across all 15 targets
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
   * Look up canonical component entry from Wave 1 SSOT `environmentCatalog.cjs`.
   *
   * @param {EnvironmentComponentId} id
   * @returns {Record<string, any>}
   */
  const catEntry = (id) => /** @type {Record<string, any>} */ (ENVIRONMENT_COMPONENT_CATALOG[id]);

  /**
   * Build runner component state cleanly backed by `ENVIRONMENT_COMPONENT_CATALOG`.
   *
   * @param {'runner_crossover' | 'runner_crossover_preview' | 'runner_crossover_preview_arm64' | 'runner_wine' | 'runner_gptk'} id
   * @param {object} meta
   * @param {string} meta.badge
   * @param {boolean} meta.defaultSelected
   * @param {boolean} [meta.canAutoInstallOverride]
   * @param {boolean} [meta.requiresExternalDownloadOverride]
   * @param {string} meta.whyExplanation
   * @param {string} [meta.footprintNote]
   * @param {string} [meta.tradeoffNote]
   * @returns {EnvironmentComponentState}
   */
  const buildRunnerComponent = (id, meta) => {
    const entry = catEntry(id);
    const runnerType = /** @type {NonNativeRunnerType} */ (entry.runnerType);
    const title = entry.macTitle || entry.title;
    const shortLabel = entry.macShortLabel || entry.shortLabel;
    const tier = /** @type {RecommendationTier} */ (entry.macRecommendationTier || 'optional');
    const canAutoInstallBase =
      typeof meta.canAutoInstallOverride === 'boolean'
        ? meta.canAutoInstallOverride
        : Boolean(entry.canAutoInstallOnMac);
    const requiresExternalBase =
      typeof meta.requiresExternalDownloadOverride === 'boolean'
        ? meta.requiresExternalDownloadOverride
        : Boolean(entry.requiresExternalDownloadOnMac);
    const scope = resolveComponentScopeForHost(id, hostPlatform);

    if (hostPlatform !== 'darwin') {
      return {
        id,
        category: 'compatibility_runner',
        scope,
        title,
        shortLabel,
        status: 'not_applicable',
        wasPreviouslyConfigured: configuredSet.has(id),
        canAutoInstall: false,
        recommendationTier: /** @type {RecommendationTier} */ (
          entry.winRecommendationTier || 'not_needed'
        ),
        recommendationBadge: 'Not Applicable on Windows',
        defaultSelected: false,
        whyExplanation: meta.whyExplanation,
        statusDetail: 'Windows games run natively on Windows without a translation layer.',
      };
    }

    const layer = detectedRunners.find((r) => r.type === runnerType);
    if (runnerType === 'crossover_preview_arm64' && !isAppleSiliconMac) {
      return {
        id,
        category: 'compatibility_runner',
        scope,
        title,
        shortLabel,
        status: 'not_applicable',
        wasPreviouslyConfigured: configuredSet.has(id),
        canAutoInstall: false,
        recommendationTier: 'not_needed',
        recommendationBadge: 'Apple Silicon Only',
        defaultSelected: false,
        whyExplanation: meta.whyExplanation,
        statusDetail: 'CrossOver Preview (arm64 / FEX) requires a Mac with Apple Silicon (arm64).',
      };
    }
    if (runnerType === 'gptk' && !isAppleSiliconMac && !layer) {
      return {
        id,
        category: 'compatibility_runner',
        scope,
        title,
        shortLabel,
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
    const isAuthRequired = Boolean(
      (runnerType === 'crossover_preview' || runnerType === 'crossover_preview_arm64') &&
        upd?.authRequired
    );
    /** @type {EnvironmentComponentStatus} */
    const status = layer ? (upd?.updateAvailable ? 'update_available' : 'ready') : 'missing';
    const rawDetail = layer
      ? upd?.updateAvailable
        ? `Installed (${layer.displayVersion || layer.version || 'Installed'}) — Update ${upd.latestDisplayVersion || upd.latestVersion} available`
        : isAuthRequired
          ? `Installed (${layer.displayVersion || layer.version || 'Installed'}) — Sign in to CodeWeavers Preview to check for updates`
          : `Installed${layer.displayVersion || layer.version ? ` (${layer.displayVersion || layer.version})` : ''}`
      : isAuthRequired
        ? 'Not installed — Sign in to CodeWeavers Preview to auto-install'
        : requiresExternalBase
          ? 'Not installed — requires manual download'
          : 'Not installed';

    const canAutoInstallOrUpdate = Boolean(
      canAutoInstallBase || (layer && upd?.canAutoUpdate === true)
    );
    const effectiveRequiresExternal =
      layer && upd?.canAutoUpdate === true ? false : requiresExternalBase;

    return {
      id,
      category: 'compatibility_runner',
      scope,
      title,
      shortLabel,
      status,
      ...(isAuthRequired ? { authRequired: true } : {}),
      ...(layer?.displayVersion || layer?.version
        ? { version: layer.displayVersion || layer.version }
        : {}),
      ...(upd?.latestVersion || upd?.latestDisplayVersion
        ? { latestVersion: upd.latestVersion || upd.latestDisplayVersion }
        : {}),
      ...(upd?.latestDisplayVersion ? { latestDisplayVersion: upd.latestDisplayVersion } : {}),
      ...(layer?.binaryPath ? { binaryPath: layer.binaryPath } : {}),
      ...(layer?.appPath ? { installLocation: layer.appPath } : {}),
      wasPreviouslyConfigured: configuredSet.has(id),
      canAutoInstall: canAutoInstallOrUpdate,
      requiresExternalDownload: effectiveRequiresExternal,
      ...(upd?.downloadUrl || entry.externalDownloadUrl
        ? { externalDownloadUrl: upd?.downloadUrl || entry.externalDownloadUrl }
        : {}),
      ...(upd?.downloadUrl ? { downloadUrl: upd.downloadUrl } : {}),
      ...(upd?.previewDate ? { previewDate: upd.previewDate } : {}),
      ...(upd?.semver ? { semver: upd.semver } : {}),
      ...(entry.estimatedDownloadMB ? { estimatedDownloadMB: entry.estimatedDownloadMB } : {}),
      recommendationTier: tier,
      recommendationBadge: meta.badge,
      defaultSelected: status === 'missing' ? meta.defaultSelected : false,
      whyExplanation: meta.whyExplanation,
      ...(meta.footprintNote ? { footprintNote: meta.footprintNote } : {}),
      ...(meta.tradeoffNote ? { tradeoffNote: meta.tradeoffNote } : {}),
      statusDetail: formatRemovedPrefix(id, status, rawDetail),
    };
  };

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
    hostPlatform === 'darwin' && bottleDefaultStatus === 'missing' && !skipRunnerSelected;

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

  /**
   * Build `EnvironmentComponentState` for chained publisher launchers (`ubisoft`, `ea`, `bnet`, `rockstar`, `riot`)
   * consuming canonical metadata from `ENVIRONMENT_COMPONENT_CATALOG`.
   *
   * @param {EnvironmentComponentId & ClientLoginTargetId} id
   * @param {'ubisoft' | 'ea' | 'bnet' | 'rockstar' | 'riot'} handoffId
   * @param {string} whyExplanation
   * @returns {EnvironmentComponentState}
   */
  const buildPublisherClientComponent = (id, handoffId, whyExplanation) => {
    const entry = catEntry(id);
    const ecosystem = CHAINED_PUBLISHER_ECOSYSTEMS[handoffId];
    const loginProbe = clientLogins[id];
    const scope = /** @type {'host' | 'bottle'} */ (resolveComponentScopeForHost(id, hostPlatform));
    const title = hostPlatform === 'darwin' ? entry.macTitle || entry.title : entry.title;
    const shortLabel =
      hostPlatform === 'darwin' ? entry.macShortLabel || entry.shortLabel : entry.shortLabel;

    const applicable =
      scope === 'bottle'
        ? hostPlatform === 'darwin'
        : handoffId === 'bnet'
          ? hostPlatform === 'win32' || hostPlatform === 'darwin'
          : handoffId === 'ea' || handoffId === 'riot'
            ? hostPlatform === 'win32' || Boolean(hostPlatform === 'darwin' && loginProbe?.installed)
            : hostPlatform === 'win32';

    /** @type {EnvironmentComponentStatus} */
    const status = !applicable
      ? 'not_applicable'
      : loginProbe?.installed
        ? 'ready'
        : 'missing';

    const canAutoInstall =
      hostPlatform === 'darwin'
        ? Boolean(entry.canAutoInstallOnMac)
        : hostPlatform === 'win32'
          ? Boolean(entry.canAutoInstallOnWin)
          : false;

    const requiresMacExternalDownload =
      hostPlatform === 'darwin' &&
      Boolean(entry.requiresExternalDownloadOnMac) &&
      status === 'missing';

    const estimatedDownloadMB = entry.estimatedDownloadMB || ecosystem?.estimatedDownloadMB;
    const rawDetail = !applicable
      ? scope === 'bottle'
        ? 'Not needed on Windows.'
        : 'Windows-only publisher client (use bottled version on Mac).'
      : status === 'ready'
        ? loginProbe.statusSummary
        : formatRemovedPrefix(id, status, 'Not installed (optional).');

    return {
      id,
      category: /** @type {EnvironmentComponentCategory} */ (entry.category),
      storefrontId: handoffId,
      scope,
      title,
      shortLabel,
      status,
      ...(loginProbe?.binaryPath ? { binaryPath: loginProbe.binaryPath } : {}),
      ...(scope === 'bottle' && bottleSummary.activeBottlePath
        ? { installLocation: bottleSummary.activeBottlePath }
        : {}),
      wasPreviouslyConfigured: configuredSet.has(id),
      canAutoInstall,
      ...(requiresMacExternalDownload && entry.externalDownloadUrl
        ? {
            requiresExternalDownload: true,
            externalDownloadUrl: entry.externalDownloadUrl,
          }
        : {}),
      ...(canAutoInstall && estimatedDownloadMB ? { estimatedDownloadMB } : {}),
      recommendationTier: 'optional',
      recommendationBadge: !applicable
        ? scope === 'bottle'
          ? 'Mac Only'
          : 'Windows Only'
        : 'Optional — Chained Games Only',
      defaultSelected: false,
      whyExplanation,
      statusDetail: rawDetail,
    };
  };

  const rosettaCat = catEntry('rosetta2');
  const vcRedistCat = catEntry('win_vcredist');
  const webview2Cat = catEntry('win_webview2');
  const bottleDefaultCat = catEntry('bottle_default');
  const bottleSteamCat = catEntry('bottle_steam');
  const hostSteamCat = catEntry('host_steam');
  const hostGogCat = catEntry('host_gog');
  const bottleGogCat = catEntry('bottle_gog');
  const hostEpicCat = catEntry('host_epic');
  const bottleEpicCat = catEntry('bottle_epic');
  const xboxRuntimeCat = catEntry('xbox_runtime');

  /** @type {Record<EnvironmentComponentId, EnvironmentComponentState>} */
  const components = {
    rosetta2: {
      id: 'rosetta2',
      category: 'os_prerequisite',
      scope: resolveComponentScopeForHost('rosetta2', hostPlatform),
      title: rosettaCat.title,
      shortLabel: rosettaCat.shortLabel,
      status: rosettaStatus,
      wasPreviouslyConfigured: configuredSet.has('rosetta2'),
      canAutoInstall: isAppleSiliconMac && Boolean(rosettaCat.canAutoInstallOnMac),
      estimatedDownloadMB: rosettaCat.estimatedDownloadMB,
      recommendationTier: /** @type {RecommendationTier} */ (
        isAppleSiliconMac ? rosettaCat.macRecommendationTier : rosettaCat.winRecommendationTier
      ),
      recommendationBadge: isAppleSiliconMac ? 'Required' : 'Not Needed',
      defaultSelected: rosettaStatus === 'missing',
      whyExplanation: 'Lets your Mac run Windows games and older Mac games.',
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
      scope: resolveComponentScopeForHost('win_vcredist', hostPlatform),
      title: vcRedistCat.title,
      shortLabel: vcRedistCat.shortLabel,
      status: vcRedistStatus,
      ...(vcRedistProbe.version ? { version: vcRedistProbe.version } : {}),
      wasPreviouslyConfigured: configuredSet.has('win_vcredist'),
      canAutoInstall: hostPlatform === 'win32' && Boolean(vcRedistCat.canAutoInstallOnWin),
      estimatedDownloadMB: vcRedistCat.estimatedDownloadMB,
      recommendationTier: /** @type {RecommendationTier} */ (
        hostPlatform === 'win32'
          ? vcRedistCat.winRecommendationTier
          : vcRedistCat.macRecommendationTier
      ),
      recommendationBadge: hostPlatform === 'win32' ? 'Recommended' : 'Windows Only',
      defaultSelected: vcRedistStatus === 'missing',
      whyExplanation: 'Needed by most Windows games to start.',
      statusDetail:
        hostPlatform !== 'win32'
          ? 'Not needed on Mac.'
          : vcRedistProbe.installed
            ? `Installed${vcRedistProbe.version ? ` (${vcRedistProbe.version})` : ''}.`
            : formatRemovedPrefix('win_vcredist', vcRedistStatus, 'Needed by most PC games.'),
    },

    win_webview2: {
      id: 'win_webview2',
      category: 'os_prerequisite',
      scope: resolveComponentScopeForHost('win_webview2', hostPlatform),
      title: webview2Cat.title,
      shortLabel: webview2Cat.shortLabel,
      status: webview2Status,
      ...(webview2Probe.version ? { version: webview2Probe.version } : {}),
      wasPreviouslyConfigured: configuredSet.has('win_webview2'),
      canAutoInstall: false,
      ...(hostPlatform === 'win32' && !webview2Probe.installed
        ? {
            requiresExternalDownload: Boolean(webview2Cat.requiresExternalDownloadOnWin),
            externalDownloadUrl: webview2Cat.externalDownloadUrl,
          }
        : {}),
      recommendationTier: /** @type {RecommendationTier} */ (
        hostPlatform === 'win32'
          ? webview2Cat.winRecommendationTier
          : webview2Cat.macRecommendationTier
      ),
      recommendationBadge: hostPlatform === 'win32' ? 'Built In' : 'Windows Only',
      defaultSelected: false,
      whyExplanation: 'Used for store sign-in windows on Windows.',
      statusDetail:
        hostPlatform !== 'win32'
          ? 'Not needed on Mac.'
          : webview2Probe.installed
            ? `Installed (${webview2Probe.version}).`
            : 'Available from Microsoft if sign-in windows fail to open.',
    },

    runner_crossover: buildRunnerComponent('runner_crossover', {
      badge: 'Recommended',
      defaultSelected:
        noMacRunnersInstalled &&
        !skipRunnerSelected &&
        wizardState.preferredRunnerType !== 'wine',
      whyExplanation:
        'Best compatibility and performance for Windows games on Mac. Paid app by CodeWeavers with a free 14-day trial.',
      tradeoffNote: 'Paid app with a 14-day free trial — or choose free Wine below.',
    }),

    runner_crossover_preview: buildRunnerComponent('runner_crossover_preview', {
      badge: 'Preview',
      defaultSelected: false,
      whyExplanation:
        'Early-access CodeWeavers build with bleeding-edge D3DMetal and DXMT fixes. Sign in to CodeWeavers Preview in-app to auto-install.',
    }),

    runner_crossover_preview_arm64: buildRunnerComponent('runner_crossover_preview_arm64', {
      badge: 'FEX Preview',
      defaultSelected: false,
      canAutoInstallOverride: isAppleSiliconMac,
      whyExplanation:
        'Experimental Apple Silicon arm64 CrossOver Preview using FEX translation and dedicated arm64 bottles.',
    }),

    runner_wine: buildRunnerComponent('runner_wine', {
      badge: 'Free',
      defaultSelected: wizardState.preferredRunnerType === 'wine',
      whyExplanation:
        'Free, open-source way to run Windows games on Mac. Great for older and lighter games.',
      tradeoffNote: 'Completely free, though newer 3D games run better in CrossOver.',
    }),

    runner_gptk: buildRunnerComponent('runner_gptk', {
      badge: 'Advanced',
      defaultSelected: false,
      canAutoInstallOverride: isGptkAutoInstallSupported,
      requiresExternalDownloadOverride: !isGptkAutoInstallSupported,
      whyExplanation:
        'Apple’s developer tool. Not needed if you use CrossOver, which already includes it.',
    }),

    bottle_default: {
      id: 'bottle_default',
      category: 'bottle',
      scope: resolveComponentScopeForHost('bottle_default', hostPlatform),
      title: `Windows Game Bottle ("${bottleSummary.recommendedBottleName}")`,
      shortLabel: bottleDefaultCat.shortLabel,
      status: bottleDefaultStatus,
      ...(bottleSummary.activeBottlePath
        ? { installLocation: bottleSummary.activeBottlePath }
        : {}),
      wasPreviouslyConfigured: configuredSet.has('bottle_default'),
      canAutoInstall: hostPlatform === 'darwin' && Boolean(bottleDefaultCat.canAutoInstallOnMac),
      recommendationTier: /** @type {RecommendationTier} */ (
        hostPlatform === 'darwin'
          ? bottleDefaultCat.macRecommendationTier
          : bottleDefaultCat.winRecommendationTier
      ),
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
      scope: resolveComponentScopeForHost('bottle_steam', hostPlatform),
      title: bottleSteamCat.macTitle,
      shortLabel: bottleSteamCat.macShortLabel,
      status: bottleSteamStatus,
      ...(clientLogins.bottle_steam.binaryPath
        ? { binaryPath: clientLogins.bottle_steam.binaryPath }
        : {}),
      ...(bottleSummary.activeBottlePath
        ? { installLocation: bottleSummary.activeBottlePath }
        : {}),
      wasPreviouslyConfigured: configuredSet.has('bottle_steam'),
      canAutoInstall: hostPlatform === 'darwin' && Boolean(bottleSteamCat.canAutoInstallOnMac),
      estimatedDownloadMB: bottleSteamCat.estimatedDownloadMB,
      recommendationTier:
        hostPlatform !== 'darwin'
          ? 'not_needed'
          : steamRelevant
            ? /** @type {RecommendationTier} */ (bottleSteamCat.macRecommendationTier)
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
      whyExplanation: 'Needed to download and play Windows-only Steam games on your Mac.',
      statusDetail:
        hostPlatform !== 'darwin'
          ? 'Not needed on Windows.'
          : bottleSteamStatus === 'ready'
            ? clientLogins.bottle_steam.statusSummary
            : formatRemovedPrefix('bottle_steam', bottleSteamStatus, 'Not installed yet.'),
    },

    host_steam: {
      id: 'host_steam',
      category: 'host_client',
      storefrontId: 'steam',
      scope: resolveComponentScopeForHost('host_steam', hostPlatform),
      title: hostPlatform === 'darwin' ? hostSteamCat.macTitle : hostSteamCat.title,
      shortLabel: hostPlatform === 'darwin' ? hostSteamCat.macShortLabel : hostSteamCat.shortLabel,
      status: hostSteamStatus,
      ...(clientLogins.host_steam.binaryPath
        ? { binaryPath: clientLogins.host_steam.binaryPath }
        : {}),
      wasPreviouslyConfigured: configuredSet.has('host_steam'),
      canAutoInstall:
        hostPlatform === 'darwin'
          ? Boolean(hostSteamCat.canAutoInstallOnMac)
          : hostPlatform === 'win32'
            ? Boolean(hostSteamCat.canAutoInstallOnWin)
            : false,
      estimatedDownloadMB: hostSteamCat.estimatedDownloadMB,
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
          : formatRemovedPrefix('host_steam', hostSteamStatus, 'Not installed yet.'),
    },

    host_gog: {
      id: 'host_gog',
      category: 'host_client',
      storefrontId: 'gog',
      scope: resolveComponentScopeForHost('host_gog', hostPlatform),
      title: hostPlatform === 'darwin' ? hostGogCat.macTitle : hostGogCat.title,
      shortLabel: hostPlatform === 'darwin' ? hostGogCat.macShortLabel : hostGogCat.shortLabel,
      status: hostGogStatus,
      ...(clientLogins.host_gog.binaryPath ? { binaryPath: clientLogins.host_gog.binaryPath } : {}),
      wasPreviouslyConfigured: configuredSet.has('host_gog'),
      canAutoInstall:
        hostPlatform === 'darwin'
          ? Boolean(hostGogCat.canAutoInstallOnMac)
          : hostPlatform === 'win32'
            ? Boolean(hostGogCat.canAutoInstallOnWin)
            : false,
      estimatedDownloadMB: hostGogCat.estimatedDownloadMB,
      recommendationTier: /** @type {RecommendationTier} */ (
        hostPlatform === 'darwin'
          ? hostGogCat.macRecommendationTier
          : hostGogCat.winRecommendationTier
      ),
      recommendationBadge: 'Optional — Achievements Only',
      defaultSelected: false,
      whyExplanation:
        'Downloads and cloud saves already work without GOG Galaxy (via built-in gogdl). Only install Galaxy if you want GOG achievements or multiplayer.',
      statusDetail:
        hostGogStatus === 'ready'
          ? clientLogins.host_gog.statusSummary
          : formatRemovedPrefix('host_gog', hostGogStatus, 'Not installed (optional).'),
    },

    bottle_gog: {
      id: 'bottle_gog',
      category: 'bottle_client',
      storefrontId: 'gog',
      scope: resolveComponentScopeForHost('bottle_gog', hostPlatform),
      title: bottleGogCat.macTitle,
      shortLabel: bottleGogCat.macShortLabel,
      status: bottleGogStatus,
      ...(clientLogins.bottle_gog.binaryPath
        ? { binaryPath: clientLogins.bottle_gog.binaryPath }
        : {}),
      ...(bottleSummary.activeBottlePath
        ? { installLocation: bottleSummary.activeBottlePath }
        : {}),
      wasPreviouslyConfigured: configuredSet.has('bottle_gog'),
      canAutoInstall: hostPlatform === 'darwin' && Boolean(bottleGogCat.canAutoInstallOnMac),
      estimatedDownloadMB: bottleGogCat.estimatedDownloadMB,
      recommendationTier: /** @type {RecommendationTier} */ (
        hostPlatform === 'darwin'
          ? bottleGogCat.macRecommendationTier
          : bottleGogCat.winRecommendationTier
      ),
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
            : formatRemovedPrefix('bottle_gog', bottleGogStatus, 'Not installed (optional).'),
    },

    host_epic: {
      id: 'host_epic',
      category: 'host_client',
      storefrontId: 'epic',
      scope: resolveComponentScopeForHost('host_epic', hostPlatform),
      title: hostPlatform === 'darwin' ? hostEpicCat.macTitle : hostEpicCat.title,
      shortLabel: hostPlatform === 'darwin' ? hostEpicCat.macShortLabel : hostEpicCat.shortLabel,
      status: hostEpicStatus,
      ...(clientLogins.host_epic.binaryPath
        ? { binaryPath: clientLogins.host_epic.binaryPath }
        : {}),
      wasPreviouslyConfigured: configuredSet.has('host_epic'),
      canAutoInstall:
        hostPlatform === 'darwin'
          ? Boolean(hostEpicCat.canAutoInstallOnMac)
          : hostPlatform === 'win32'
            ? Boolean(hostEpicCat.canAutoInstallOnWin)
            : false,
      estimatedDownloadMB: hostEpicCat.estimatedDownloadMB,
      recommendationTier: /** @type {RecommendationTier} */ (
        hostPlatform === 'darwin'
          ? hostEpicCat.macRecommendationTier
          : hostEpicCat.winRecommendationTier
      ),
      recommendationBadge: 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Downloads, cloud saves, achievements, and multiplayer already work without it (via built-in legendary). Only install if you want the Epic social overlay.',
      statusDetail:
        hostEpicStatus === 'ready'
          ? clientLogins.host_epic.statusSummary
          : formatRemovedPrefix('host_epic', hostEpicStatus, 'Not installed (not needed).'),
    },

    bottle_epic: {
      id: 'bottle_epic',
      category: 'bottle_client',
      storefrontId: 'epic',
      scope: resolveComponentScopeForHost('bottle_epic', hostPlatform),
      title: bottleEpicCat.macTitle,
      shortLabel: bottleEpicCat.macShortLabel,
      status: bottleEpicStatus,
      ...(clientLogins.bottle_epic.binaryPath
        ? { binaryPath: clientLogins.bottle_epic.binaryPath }
        : {}),
      ...(bottleSummary.activeBottlePath
        ? { installLocation: bottleSummary.activeBottlePath }
        : {}),
      wasPreviouslyConfigured: configuredSet.has('bottle_epic'),
      canAutoInstall: hostPlatform === 'darwin' && Boolean(bottleEpicCat.canAutoInstallOnMac),
      estimatedDownloadMB: bottleEpicCat.estimatedDownloadMB,
      recommendationTier: /** @type {RecommendationTier} */ (
        hostPlatform === 'darwin'
          ? bottleEpicCat.macRecommendationTier
          : bottleEpicCat.winRecommendationTier
      ),
      recommendationBadge: hostPlatform === 'darwin' ? 'Not Needed' : 'Mac Only',
      defaultSelected: false,
      whyExplanation:
        'Downloads, cloud saves, achievements, and multiplayer already work without it (via built-in legendary). Only install if you want the Epic social overlay.',
      statusDetail:
        hostPlatform !== 'darwin'
          ? 'Not needed on Windows.'
          : bottleEpicStatus === 'ready'
            ? clientLogins.bottle_epic.statusSummary
            : formatRemovedPrefix('bottle_epic', bottleEpicStatus, 'Not installed (not needed).'),
    },

    host_ubisoft: buildPublisherClientComponent(
      'host_ubisoft',
      'ubisoft',
      'Only needed for Xbox Game Pass, Steam, or Epic games that delegate launch and DRM through Ubisoft Connect.'
    ),

    bottle_ubisoft: buildPublisherClientComponent(
      'bottle_ubisoft',
      'ubisoft',
      'Only needed on Mac for Windows games (including Xbox Game Pass & Steam titles) that delegate through Ubisoft Connect.'
    ),

    host_ea: buildPublisherClientComponent(
      'host_ea',
      'ea',
      'Only needed for EA Play / Xbox Game Pass, Steam, or Epic games that delegate launch through EA App.'
    ),

    bottle_ea: buildPublisherClientComponent(
      'bottle_ea',
      'ea',
      'Only needed on Mac for Windows games (including EA Play / Game Pass & Steam titles) that delegate through EA App.'
    ),

    host_bnet: buildPublisherClientComponent(
      'host_bnet',
      'bnet',
      'Only needed for Blizzard / Activision titles (including Xbox Game Pass titles) that install and launch through Battle.net.'
    ),

    bottle_bnet: buildPublisherClientComponent(
      'bottle_bnet',
      'bnet',
      'Only needed on Mac for Windows-only Blizzard / Activision games that launch through Battle.net.'
    ),

    host_rockstar: buildPublisherClientComponent(
      'host_rockstar',
      'rockstar',
      'Only needed for Rockstar Games titles that delegate authentication and launch through Rockstar Games Launcher.'
    ),

    bottle_rockstar: buildPublisherClientComponent(
      'bottle_rockstar',
      'rockstar',
      'Only needed on Mac for Windows Rockstar Games titles that delegate through Rockstar Games Launcher.'
    ),

    host_riot: buildPublisherClientComponent(
      'host_riot',
      'riot',
      'Only needed for Riot Games / PC Game Pass titles that delegate install, sign-in, and launch through Riot Client.'
    ),

    xbox_runtime: {
      id: 'xbox_runtime',
      category: 'built_in_runtime',
      storefrontId: 'xbox',
      scope: resolveComponentScopeForHost('xbox_runtime', hostPlatform),
      title: xboxRuntimeCat.title,
      shortLabel: xboxRuntimeCat.shortLabel,
      status: xboxRuntimeStatus,
      ...(xboxBridgePath ? { binaryPath: xboxBridgePath } : {}),
      wasPreviouslyConfigured: configuredSet.has('xbox_runtime'),
      canAutoInstall: false,
      ...(hostPlatform === 'win32' && xboxRuntimeStatus === 'missing'
        ? {
            requiresExternalDownload: Boolean(xboxRuntimeCat.requiresExternalDownloadOnWin),
            externalDownloadUrl: xboxRuntimeCat.externalDownloadUrl,
          }
        : {}),
      recommendationTier: /** @type {RecommendationTier} */ (
        hostPlatform === 'darwin'
          ? xboxRuntimeCat.macRecommendationTier
          : hostPlatform === 'win32'
            ? xboxRuntimeCat.winRecommendationTier
            : 'not_needed'
      ),
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
  execReadOnlyProbe,
  probeEnvironmentHealth,
};
