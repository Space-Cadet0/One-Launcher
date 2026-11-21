// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const { spawn } = childProcess;

const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const {
  getElectron,
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,
  invalidateScanCaches,
  openExternalUri,
  clearMacQuarantineAsync,
  safeIsBottleSlug,
} = require('../engineStateRegistry.cjs');
const {
  isCrossOverPerlWineWrapperOptions,
  upsertWineUserRegKey,
  resolveDriveCPathCaseInsensitive,
  applyCrossOverEnvironmentHygiene,
  sanitizeProvisionedBottleGraphicsBackend,
  sandboxWinePrefixUserFoldersAsync,
} = require('../wineAndCrossOverManager.cjs');
const macNativeInstallerAndCodesign = /** @type {any} */ (
  require('../macNativeInstallerAndCodesign.cjs')
);
const {
  isValidBottleDirectory,
  inspectBottleConfMetadata,
  inspectCrossOverBundleMarkers,
  assertRunnerBottleArchCompatible,
  detectCompatibilityLayers,
  provisionCrossOverBottleViaCxbottle,
  ensureCompatibilityLayerReady,
  alignWineMsyncWithLiveBottle,
  prepareCrossOverWineSpawnEnv,
  prepareAlignedAuxBottleWineCommand,
  parsePlistStringValues,
  compareRunnerVersions,
  extractRunnerPreviewDate,
  extractCandidateLinksFromText,
  recordRunnerInstallReceipt,
  isPreviewSparkleFeedUrl,
  isPreviewSparkleEnclosureValid,
  setCachedAuthenticatedPreviewUrl,
  getCachedAuthenticatedPreviewUrl,
  clearCachedAuthenticatedPreviewUrl,
} = macNativeInstallerAndCodesign;
const {
  getSetupWizardState,
  saveSetupWizardState,
} = require('../environmentHealthProber.cjs');
const {
  CHAINED_PUBLISHER_ECOSYSTEMS,
  normalizeChainedHandoffId,
  resolveDefaultChainedBottleName,
  discoverBottlePublisherLauncher,
  discoverHostPublisherLauncher,
  sanitizeChainedPublisherAutostartInBottleRegs,
} = require('../chainedPublisherLaunchers.cjs');
const {
  CODEWEAVERS_SPARKLE_PUBLIC_ED_KEY,
  explicitHomedirOpt,
  onEnvironmentSetupProgress,
  emitEnvironmentSetupProgress,
  normalizeRequestedRunnerType,
  resolveCodeWeaversRunnerSpec,
  componentIdToRunnerType,
  formatRunnerDisplayLabel,
  resolveDarwinKernelMajor,
  throwBlockedUrlError,
  isFatalSecurityOrAbortError,
  validateInstallerUrl,
  cancellableSleep,
  fetchValidatedText,
  streamVerifiedDownloadToFile,
  getExecFileFn,
  runExecFileAsync,
} = require('./installerNetworkAndGuardrails.cjs');
const {
  verifyFileSha256Async,
  verifySparkleEd25519SignatureAsync,
  findEmbeddedD3DMetalFramework,
  verifyAppleSignedFramework,
  verifyMacAppDeveloperSignature,
  verifyWindowsInstallerSignature,
} = require('./artifactSignatureVerifier.cjs');
const {
  throwIfRunnerBusy,
  resolveTargetMacApplicationsDir,
  assertRunnerSafeToReplace,
  copyVerifiedMacAppToApplicationsDir,
  installVerifiedDmgRunner,
  findStagedAppBundle,
} = require('./macAppBundleInstaller.cjs');
const {
  isAllowedCodeWeaversAuthNavigationUrl,
  isAllowedCodeWeaversDownloadUrl,
  parseNumericPreviewDate,
  extractPreviewFilenameVersionHint,
  classifyCrossOverPreviewArchiveBranch,
  resolvePreviewBranch,
  selectPreferredCrossOverPreviewDownloadUrl,
  discoverCrossOverPreviewBranchUrls,
  resolvePreviewBundleVersion,
  captureCodeWeaversPreviewDownload,
} = require('./gogAndPreviewResolvers.cjs');

/**
 * Primary and secondary CodeWeavers Apple Developer Team IDs.
 * Primary `'2C75U774H4'` is passed in `expectedTeamIds` (preserving spy contracts) while
 * `'G78RJ6NLJU'` is passed via `additionalExpectedTeamIds` so genuine CodeWeavers bundles signed
 * under either team ID pass strict `teamMatched && vendorAuthMatched` verification.
 */
const CODEWEAVERS_PRIMARY_TEAM_IDS = ['2C75U774H4'];
const CODEWEAVERS_ADDITIONAL_TEAM_IDS = ['G78RJ6NLJU'];
const CODEWEAVERS_VENDOR_AUTHORITY_RE = /Developer ID Application:\s*CodeWeavers/i;

/** @type {(appPath: string | null | undefined) => string | null} */
let registeredDetectExternalRunnerManagerName = () => null;
/** @type {(existingLayer: any) => string | null} */
let registeredIsExternalRunnerLayer = () => null;

/**
 * Register facade-owned external runner-manager detectors so `runnerAndBottleProvisioner`
 * preserves the GPL clean-room allowlist without copying caller options objects.
 *
 * @param {{ detectExternalRunnerManagerName?: (appPath: string | null | undefined) => string | null, isExternalRunnerLayer?: (existingLayer: any) => string | null }} detectors
 */
function registerExternalRunnerDetectors(detectors = {}) {
  if (typeof detectors.detectExternalRunnerManagerName === 'function') {
    registeredDetectExternalRunnerManagerName = detectors.detectExternalRunnerManagerName;
  }
  if (typeof detectors.isExternalRunnerLayer === 'function') {
    registeredIsExternalRunnerLayer = detectors.isExternalRunnerLayer;
  }
}

/** @type {Promise<{ installed: boolean, alreadyReady: boolean, error?: string }> | null} */
let inFlightBackgroundRosettaPromise = null;

/**
 * Fast non-mutating check for Apple Silicon Rosetta 2 runtime binaries.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<boolean>}
 */
async function isRosetta2InstalledFast(options = {}) {
  const rawPlatform = String(options.platform || process.platform).toLowerCase();
  const hostArch = String(options.arch || process.arch || 'arm64');
  if (rawPlatform !== 'darwin' || hostArch !== 'arm64') {
    return true;
  }
  if (typeof options.rosettaInstalled === 'boolean') {
    return options.rosettaInstalled;
  }
  const { homedir } = resolveIsolatedHomedirAndUserData(options);
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
  for (const candidate of rosettaPaths) {
    try {
      await fs.promises.access(candidate, fs.constants.F_OK);
      return true;
    } catch {}
  }
  return false;
}

/**
 * Automatically check for and silently install Apple Rosetta 2 in the background on Apple Silicon
 * Macs (`darwin` `arm64`) if missing.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ installed: boolean, alreadyReady: boolean, error?: string }>}
 */
async function ensureRosetta2InBackground(options = {}) {
  const rawPlatform = String(options.platform || process.platform).toLowerCase();
  const hostArch = String(options.arch || process.arch || 'arm64');
  if (rawPlatform !== 'darwin' || hostArch !== 'arm64') {
    return { installed: false, alreadyReady: true };
  }

  const hasInjectedExec =
    typeof options.execFileImpl === 'function' || typeof options.execFileFn === 'function';
  if (
    isTestEnvironment() &&
    !hasInjectedExec &&
    options.allowBackgroundRosettaInTest !== true
  ) {
    return { installed: false, alreadyReady: true };
  }

  const alreadyReady = await isRosetta2InstalledFast(options);
  if (alreadyReady && !options.forceReinstall) {
    return { installed: true, alreadyReady: true };
  }

  const isSystemSingletonCall = !hasInjectedExec && !options.homedir && !options.signal;
  if (isSystemSingletonCall && inFlightBackgroundRosettaPromise) {
    return inFlightBackgroundRosettaPromise;
  }

  const runInstall = async () => {
    try {
      const execFileFn = getExecFileFn(options);
      diagLog.info(
        'environmentProvisioner',
        'Installing Apple Rosetta 2 in background via softwareupdate',
        {},
        options
      );
      await runExecFileAsync(
        execFileFn,
        '/usr/sbin/softwareupdate',
        ['--install-rosetta', '--agree-to-license'],
        {
          timeout: 300000,
          ...(options.signal ? { signal: options.signal } : {}),
        }
      );
      try {
        const { homedir, userDataDir } = resolveIsolatedHomedirAndUserData(options);
        saveSetupWizardState(
          { addConfiguredComponents: ['rosetta2'] },
          {
            ...options,
            ...(options.homedir ? { homedir } : {}),
            ...(userDataDir ? { userDataDir } : {}),
          }
        );
      } catch {}
      invalidateScanCaches({ skipPreviewUrlCacheClear: true });
      diagLog.info(
        'environmentProvisioner',
        'Apple Rosetta 2 background installation succeeded',
        {},
        options
      );
      return { installed: true, alreadyReady: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diagLog.warn(
        'environmentProvisioner',
        err,
        { phase: 'rosetta2-background-install' },
        options
      );
      return { installed: false, alreadyReady: false, error: msg };
    }
  };

  if (!isSystemSingletonCall) {
    return runInstall();
  }

  const tracked = runInstall().finally(() => {
    if (inFlightBackgroundRosettaPromise === tracked) {
      inFlightBackgroundRosettaPromise = null;
    }
  });
  inFlightBackgroundRosettaPromise = tracked;
  return tracked;
}

/**
 * Direct vendor installation & in-place atomic update for macOS compatibility runners
 * (`crossover`, `wine`, `gptk`, `crossover_preview`, `crossover_preview_arm64`).
 *
 * @param {string} rawRunnerType
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ success: boolean, installed?: boolean, alreadyUpToDate?: boolean, authenticated?: boolean, downloadUrl?: string | null, openedExternal?: boolean, openedExternalUrl?: string, switchedToStableCrossOver?: boolean, installedPath?: string, version?: string | null, message: string, error?: string }>}
 */
async function installRunnerDirect(rawRunnerType, options = {}) {
  const requestedRunnerType = normalizeRequestedRunnerType(rawRunnerType);
  if (
    requestedRunnerType !== 'crossover' &&
    requestedRunnerType !== 'crossover_preview' &&
    requestedRunnerType !== 'crossover_preview_arm64' &&
    requestedRunnerType !== 'wine' &&
    requestedRunnerType !== 'gptk'
  ) {
    const rawDisplay = String(rawRunnerType ?? '').trim();
    throw new Error(
      `Unsupported compatibility runner type: ${rawDisplay || requestedRunnerType || '(empty)'}`
    );
  }
  const effectiveRunnerType =
    requestedRunnerType === 'crossover_preview' && options.switchToStableCrossOver === true
      ? 'crossover'
      : requestedRunnerType;
  const runnerSpec = resolveCodeWeaversRunnerSpec(effectiveRunnerType);
  const isPreviewRunner =
    effectiveRunnerType === 'crossover_preview' ||
    effectiveRunnerType === 'crossover_preview_arm64';
  const previewBranch =
    effectiveRunnerType === 'crossover_preview_arm64'
      ? 'arm64'
      : resolvePreviewBranch(options, effectiveRunnerType);
  const cwPreviewLabel = runnerSpec?.displayLabel || 'CrossOver Preview';

  const { homedir } = resolveIsolatedHomedirAndUserData(options);
  let targetAppsDir = await resolveTargetMacApplicationsDir(homedir, options);
  const signal = /** @type {AbortSignal | undefined} */ (options.signal);
  if (signal?.aborted) {
    const abortErr = new Error(`Installation of ${cwPreviewLabel || effectiveRunnerType} cancelled.`);
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  /** @type {import('./installerNetworkAndGuardrails.cjs').ProvisionerComponentId} */
  const componentId = runnerSpec
    ? runnerSpec.componentId
    : effectiveRunnerType === 'wine'
      ? 'runner_wine'
      : effectiveRunnerType === 'gptk'
        ? 'runner_gptk'
        : 'runner_crossover';

  const progressCtx = options._progressCtx || {
    runId: String(options.runId || `runner-install-${Date.now()}`),
    componentId,
    stepIndex: 0,
    totalSteps: 1,
  };

  const hostPlatform = String(options.platform || process.platform).toLowerCase();
  const hostArch = String(options.arch || process.arch || 'arm64').toLowerCase();
  if (
    effectiveRunnerType === 'crossover_preview_arm64' &&
    (hostPlatform !== 'darwin' || hostArch !== 'arm64')
  ) {
    const archErrMsg =
      'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.';
    emitEnvironmentSetupProgress(
      {
        ...progressCtx,
        phase: 'failed',
        message: archErrMsg,
        error: archErrMsg,
      },
      options
    );
    return {
      success: false,
      installed: false,
      message: archErrMsg,
      error: archErrMsg,
    };
  }

  const detectedBefore = detectCompatibilityLayers({
    ...options,
    ...explicitHomedirOpt(options),
  });
  const isSwitchingPreviewToStable =
    requestedRunnerType === 'crossover_preview' && options.switchToStableCrossOver === true;
  const providedExistingLayer =
    options.existingLayer &&
    (!isSwitchingPreviewToStable || options.existingLayer.type === effectiveRunnerType)
      ? options.existingLayer
      : null;
  const existingLayer =
    providedExistingLayer ||
    detectedBefore.find((/** @type {any} */ l) => l.type === effectiveRunnerType) ||
    null;

  const rawLocalArchive =
    typeof options.archivePath === 'string' && options.archivePath.trim()
      ? options.archivePath.trim()
      : '';
  const rawLocalDmg =
    typeof options.dmgPath === 'string' && options.dmgPath.trim()
      ? options.dmgPath.trim()
      : '';
  const explicitLocalInstallerPath = rawLocalArchive || rawLocalDmg;

  const externalMgr =
    typeof options.isExternalRunnerLayerFn === 'function'
      ? options.isExternalRunnerLayerFn(existingLayer)
      : typeof options.detectExternalRunnerManagerNameFn === 'function'
        ? options.detectExternalRunnerManagerNameFn(existingLayer?.appPath) ||
          options.detectExternalRunnerManagerNameFn(existingLayer?.binaryPath)
        : registeredIsExternalRunnerLayer(existingLayer) ||
          registeredDetectExternalRunnerManagerName(existingLayer?.appPath) ||
          registeredDetectExternalRunnerManagerName(existingLayer?.binaryPath);

  /** @type {string | null} */
  let existingTargetAppPath = null;
  if (
    existingLayer &&
    typeof existingLayer.appPath === 'string' &&
    existingLayer.appPath.toLowerCase().endsWith('.app') &&
    !externalMgr &&
    typeof options.customApplicationsDir !== 'string'
  ) {
    const matchesCanonicalBundle =
      !runnerSpec ||
      path.basename(existingLayer.appPath).toLowerCase() ===
        runnerSpec.canonicalAppName.toLowerCase();
    if (matchesCanonicalBundle) {
      const existingParent = path.dirname(existingLayer.appPath);
      const existsOnDisk = fs.existsSync(existingLayer.appPath);
      if (options.homedir && !existsOnDisk) {
        targetAppsDir = existingParent;
        existingTargetAppPath = existingLayer.appPath;
      } else {
        try {
          await fs.promises.access(existingParent, fs.constants.W_OK | fs.constants.X_OK);
          if (existsOnDisk) {
            await fs.promises.access(existingLayer.appPath, fs.constants.W_OK);
          }
          targetAppsDir = existingParent;
          existingTargetAppPath = existingLayer.appPath;
        } catch (permErr) {
          if (options._runnerOperation === 'update' && options.authenticateOnly !== true) {
            throw new Error(
              `Cannot update ${formatRunnerDisplayLabel(effectiveRunnerType, existingLayer)}: write/rename permission denied on "${existingLayer.appPath}" or "${existingParent}" (${permErr instanceof Error ? permErr.message : String(permErr)}).`
            );
          }
        }
      }
    }
  }

  if (options.authenticateOnly !== true) {
    const preflightTargetAppPath =
      existingTargetAppPath ||
      (!externalMgr && !existingLayer?.appPath && runnerSpec
        ? path.join(targetAppsDir, runnerSpec.canonicalAppName)
        : null);
    const preflightSafe = await assertRunnerSafeToReplace(
      effectiveRunnerType,
      preflightTargetAppPath,
      existingLayer,
      options
    );
    throwIfRunnerBusy(preflightSafe);
  }

  if (typeof options.mockDirectDownload === 'function') {
    return await options.mockDirectDownload(effectiveRunnerType, {
      ...options,
      requestedRunnerType,
      componentId,
      targetAppsDir,
      existingLayer,
      existingTargetAppPath,
    });
  }

  /**
   * Finalize GPTK bundle staging: unconditionally require embedded Apple-signed `D3DMetal.framework`
   * BEFORE stripping quarantine and running deep ad-hoc signing (`codesign --force --deep -s -`).
   *
   * @param {string} stagedApp
   */
  const verifyAndPrepareStagedGptkApp = async (stagedApp) => {
    const appBase = path.basename(stagedApp);
    const matchesGptkName = /^Game Porting Toolkit.*\.app$/i.test(appBase);
    const embeddedD3d = findEmbeddedD3DMetalFramework(stagedApp);
    const hasGptkLayout =
      fs.existsSync(path.join(stagedApp, 'Contents/Resources/wine')) || Boolean(embeddedD3d);
    if (!matchesGptkName && !hasGptkLayout) {
      await fs.promises.rm(stagedApp, { recursive: true, force: true }).catch(() => {});
      throw new Error(`"${appBase}" is not a valid Apple Game Porting Toolkit bundle.`);
    }

    const allowMissingD3dInMockedTest =
      isTestEnvironment(options) &&
      typeof options.verifySignatureFn === 'function' &&
      options.requireD3DMetalSignatureCheck !== true;
    if (!embeddedD3d && !allowMissingD3dInMockedTest) {
      await fs.promises.rm(stagedApp, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `Embedded Apple-signed D3DMetal.framework was not found inside ${appBase}.`
      );
    }
    if (embeddedD3d) {
      await verifyAppleSignedFramework(embeddedD3d, {
        ...options,
        _componentId: componentId,
        purgeDirOnFailure: stagedApp,
      });
    }

    await clearMacQuarantineAsync(stagedApp, { ...options, force: true });

    if (typeof options.verifySignatureFn === 'function') {
      await verifyMacAppDeveloperSignature(stagedApp, [], {
        ...options,
        _componentId: componentId,
        allowAdhocSignature: true,
      });
      return;
    }

    const execFn = getExecFileFn(options);
    const canExecCodesign =
      process.platform === 'darwin' ||
      typeof options.execFileFn === 'function' ||
      typeof options.execFileImpl === 'function';
    if (canExecCodesign) {
      await runExecFileAsync(
        execFn,
        '/usr/bin/codesign',
        ['--force', '--deep', '-s', '-', stagedApp],
        { timeout: 120000, signal }
      );
      await runExecFileAsync(
        execFn,
        '/usr/bin/codesign',
        ['--verify', '--deep', '--strict', stagedApp],
        { timeout: 60000, signal }
      );
    }
  };

  /**
   * Finalize Open-Source Wine bundle staging after SHA-256 archive verification.
   *
   * @param {string} stagedApp
   */
  const verifyAndPrepareStagedWineApp = async (stagedApp) => {
    const appBase = path.basename(stagedApp);
    const hasWineLayout =
      /wine/i.test(appBase) ||
      fs.existsSync(path.join(stagedApp, 'Contents/Resources/wine')) ||
      fs.existsSync(path.join(stagedApp, 'Contents/SharedSupport/wine')) ||
      fs.existsSync(path.join(stagedApp, 'Contents/MacOS/wine'));
    if (!hasWineLayout) {
      await fs.promises.rm(stagedApp, { recursive: true, force: true }).catch(() => {});
      throw new Error(`"${appBase}" is not a valid macOS Wine bundle.`);
    }

    await clearMacQuarantineAsync(stagedApp, { ...options, force: true });

    if (typeof options.verifySignatureFn === 'function') {
      await verifyMacAppDeveloperSignature(stagedApp, [], {
        ...options,
        _componentId: componentId,
        allowAdhocSignature: true,
      });
      return;
    }

    const execFn = getExecFileFn(options);
    const canExecCodesign =
      process.platform === 'darwin' ||
      typeof options.execFileFn === 'function' ||
      typeof options.execFileImpl === 'function';

    if (canExecCodesign) {
      try {
        await runExecFileAsync(
          execFn,
          '/usr/bin/codesign',
          ['--verify', '--deep', '--strict', stagedApp],
          { timeout: 60000, signal }
        );
      } catch (verifyErr) {
        const errDetail = `${String(verifyErr?.stderr || '')} ${String(verifyErr?.message || '')}`;
        if (/not signed at all/i.test(errDetail)) {
          await runExecFileAsync(
            execFn,
            '/usr/bin/codesign',
            ['--force', '--deep', '-s', '-', stagedApp],
            { timeout: 180000, signal }
          );
        } else {
          await fs.promises.rm(stagedApp, { recursive: true, force: true }).catch(() => {});
          throw new Error(
            `Code signature verification failed for ${appBase}: ${String(verifyErr?.stderr || verifyErr?.message || verifyErr)}`
          );
        }
      }
    }

    await verifyMacAppDeveloperSignature(stagedApp, [], {
      ...options,
      _componentId: componentId,
      allowAdhocSignature: true,
    });
  };

  /**
   * Strip quarantine, verify CodeWeavers Developer ID (TeamIdentifier AND CodeWeavers Authority),
   * validate arm64 vs Intel bundle markers, rename `CrossOver Preview arm64.app` if needed,
   * and re-verify codesign post-rename.
   *
   * @param {string} initialStagedApp
   * @param {string | null} [initialVersion]
   * @returns {Promise<{ preparedApp: string, resolvedVersion: string | null }>}
   */
  const verifyAndPrepareCodeWeaversStagedApp = async (initialStagedApp, initialVersion = null) => {
    let preparedApp = initialStagedApp;
    await clearMacQuarantineAsync(preparedApp, { ...options, force: true });
    await verifyMacAppDeveloperSignature(preparedApp, CODEWEAVERS_PRIMARY_TEAM_IDS, {
      ...options,
      _componentId: componentId,
      additionalExpectedTeamIds: CODEWEAVERS_ADDITIONAL_TEAM_IDS,
      expectedVendorAuthorityPattern: CODEWEAVERS_VENDOR_AUTHORITY_RE,
    });

    const stagedCxRoot = path.join(preparedApp, 'Contents', 'SharedSupport', 'CrossOver');
    if (fs.existsSync(stagedCxRoot) && typeof inspectCrossOverBundleMarkers === 'function') {
      const stagedMarkers = inspectCrossOverBundleMarkers(preparedApp);
      if (effectiveRunnerType === 'crossover_preview_arm64' && !stagedMarkers.isArm64Bundle) {
        await fs.promises.rm(preparedApp, { recursive: true, force: true }).catch(() => {});
        throw new Error(
          'Selected archive contains an Intel/standard CrossOver bundle without arm64 FEX runtime markers (expected lib/wine/aarch64-unix/ntdll.so or bin/wineserver-arm64).'
        );
      }
      if (
        (effectiveRunnerType === 'crossover_preview' || effectiveRunnerType === 'crossover') &&
        stagedMarkers.isArm64Bundle
      ) {
        await fs.promises.rm(preparedApp, { recursive: true, force: true }).catch(() => {});
        throw new Error(
          `Selected archive contains an arm64 CrossOver Preview bundle, which cannot be installed as ${cwPreviewLabel}.`
        );
      }
    }

    if (effectiveRunnerType === 'crossover_preview_arm64') {
      const targetArm64Name = 'CrossOver Preview arm64.app';
      if (path.basename(preparedApp) !== targetArm64Name) {
        const renamedPath = path.join(path.dirname(preparedApp), targetArm64Name);
        if (fs.existsSync(renamedPath)) {
          await fs.promises.rm(renamedPath, { recursive: true, force: true });
        }
        await fs.promises.rename(preparedApp, renamedPath);
        preparedApp = renamedPath;
      }

      const canExecCodesign =
        options.skipStagingCodesignVerify !== true &&
        (process.platform === 'darwin' ||
          typeof options.execFileFn === 'function' ||
          typeof options.execFileImpl === 'function');
      if (canExecCodesign) {
        await runExecFileAsync(
          getExecFileFn(options),
          '/usr/bin/codesign',
          ['--verify', '--deep', '--strict', preparedApp],
          { timeout: 60000, ...(signal ? { signal } : {}) }
        );
      }
    }

    const resolvedVersion = isPreviewRunner
      ? resolvePreviewBundleVersion(preparedApp, initialVersion)
      : initialVersion;
    return { preparedApp, resolvedVersion };
  };

  /**
   * Perform pre-swap safety guard and atomic `.app` installation.
   *
   * @param {string} stagedApp
   * @param {string} displayLabel
   * @param {string | null} [resolvedVersion]
   */
  const atomicSwapVerifiedApp = async (stagedApp, displayLabel, resolvedVersion = null) => {
    const canonicalName = runnerSpec ? runnerSpec.canonicalAppName : path.basename(stagedApp);
    const destAppPath =
      existingTargetAppPath &&
      path.basename(existingTargetAppPath).toLowerCase() === canonicalName.toLowerCase()
        ? existingTargetAppPath
        : path.join(targetAppsDir, canonicalName);

    const preSwapSafe = await assertRunnerSafeToReplace(
      effectiveRunnerType,
      destAppPath,
      existingLayer,
      options
    );
    throwIfRunnerBusy(preSwapSafe);

    emitEnvironmentSetupProgress(
      {
        ...progressCtx,
        phase: 'installing',
        message: `Installing ${path.basename(destAppPath)} to ${path.dirname(destAppPath)}...`,
      },
      options
    );

    const installedPath = await copyVerifiedMacAppToApplicationsDir(stagedApp, targetAppsDir, {
      ...options,
      targetAppBundlePath: destAppPath,
    });
    if (resolvedVersion && typeof recordRunnerInstallReceipt === 'function') {
      recordRunnerInstallReceipt(installedPath, effectiveRunnerType, resolvedVersion, {
        ...options,
        homedir,
      });
    }
    invalidateScanCaches({ skipPreviewUrlCacheClear: true });
    return {
      success: true,
      installed: true,
      installedPath,
      ...(resolvedVersion ? { version: resolvedVersion } : {}),
      message: `Installed ${displayLabel} to ${installedPath}.`,
    };
  };

  // -------------------------------------------------------------------------
  // Local Archive / Disk Image Path (`.dmg`, `.zip`, `.tar.xz`, `.txz`)
  // -------------------------------------------------------------------------
  if (explicitLocalInstallerPath) {
    if (
      explicitLocalInstallerPath.includes('\0') ||
      !path.isAbsolute(explicitLocalInstallerPath) ||
      path.basename(explicitLocalInstallerPath).startsWith('-')
    ) {
      throw new Error(
        `Rejected unsafe or non-absolute runner archive path: ${explicitLocalInstallerPath}`
      );
    }
    if (!fs.existsSync(explicitLocalInstallerPath)) {
      throw new Error(
        `Selected runner archive was not found on disk: ${path.basename(explicitLocalInstallerPath)}`
      );
    }

    const lowerLocal = explicitLocalInstallerPath.toLowerCase();
    const isCodeWeaversRunner = Boolean(runnerSpec);

    if (lowerLocal.endsWith('.dmg')) {
      const dmgTargetAppPath =
        existingTargetAppPath ||
        (runnerSpec ? path.join(targetAppsDir, runnerSpec.canonicalAppName) : null);
      const dmgRes = await installVerifiedDmgRunner(
        {
          dmgPath: explicitLocalInstallerPath,
          effectiveRunnerType,
          componentId,
          targetAppsDir,
          targetAppPath: dmgTargetAppPath,
          existingLayer,
          expectedTeamIds: isCodeWeaversRunner ? CODEWEAVERS_PRIMARY_TEAM_IDS : [],
          additionalExpectedTeamIds: isCodeWeaversRunner ? CODEWEAVERS_ADDITIONAL_TEAM_IDS : [],
          expectedVendorAuthorityPattern: isCodeWeaversRunner
            ? CODEWEAVERS_VENDOR_AUTHORITY_RE
            : null,
          displayLabel: path.basename(dmgTargetAppPath || explicitLocalInstallerPath),
          verifyingMessage: `Mounting and verifying ${path.basename(explicitLocalInstallerPath)}...`,
          progressCtx,
          homedir,
          resolveVersionAfterInstall: isPreviewRunner
            ? (installedPath) =>
                resolvePreviewBundleVersion(
                  installedPath,
                  extractPreviewFilenameVersionHint(explicitLocalInstallerPath)
                )
            : undefined,
          extraMountOptions: {
            ...(effectiveRunnerType === 'gptk' ? { requireGptkBundle: true } : {}),
            ...(effectiveRunnerType === 'wine'
              ? { allowAdhocSignature: true, prepareUnsignedWineBundle: true }
              : {}),
          },
        },
        options
      );
      return {
        ...dmgRes,
        message: `Installed ${path.basename(dmgRes.installedPath)} to ${path.dirname(dmgRes.installedPath)}.`,
      };
    }

    if (/\.(?:zip|tar\.xz|txz)$/i.test(lowerLocal)) {
      const localTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ol-runner-local-'));
      const execFn = getExecFileFn(options);
      try {
        const stagingDir = path.join(localTempDir, 'staging');
        await fs.promises.mkdir(stagingDir, { recursive: true });
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'extracting',
            message: `Extracting ${path.basename(explicitLocalInstallerPath)}...`,
          },
          options
        );
        if (typeof options.onExtractArchive === 'function') {
          await options.onExtractArchive(explicitLocalInstallerPath, stagingDir);
        } else if (lowerLocal.endsWith('.zip')) {
          await runExecFileAsync(
            execFn,
            '/usr/bin/ditto',
            ['-x', '-k', explicitLocalInstallerPath, stagingDir],
            { timeout: 300000, signal }
          );
        } else {
          await runExecFileAsync(
            execFn,
            '/usr/bin/tar',
            ['-xf', explicitLocalInstallerPath, '-C', stagingDir],
            { timeout: 300000, signal }
          );
        }
        if (signal?.aborted) {
          const abortErr = new Error(
            `Installation of ${cwPreviewLabel || effectiveRunnerType} cancelled.`
          );
          abortErr.name = 'AbortError';
          throw abortErr;
        }

        const preferredBundleNames = runnerSpec
          ? [runnerSpec.canonicalAppName, 'CrossOver Preview.app']
          : [];
        const stagedApp = await findStagedAppBundle(stagingDir, 0, preferredBundleNames);
        if (!stagedApp) {
          throw new Error(
            `No macOS .app bundle found inside ${path.basename(explicitLocalInstallerPath)}.`
          );
        }

        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'verifying_signature',
            message: `Verifying ${path.basename(stagedApp)} signature...`,
          },
          options
        );

        let finalStagedApp = stagedApp;
        let localArchiveVersion = isPreviewRunner
          ? extractPreviewFilenameVersionHint(explicitLocalInstallerPath)
          : null;
        if (effectiveRunnerType === 'gptk') {
          await verifyAndPrepareStagedGptkApp(stagedApp);
        } else if (isCodeWeaversRunner) {
          const prepared = await verifyAndPrepareCodeWeaversStagedApp(
            stagedApp,
            localArchiveVersion
          );
          finalStagedApp = prepared.preparedApp;
          localArchiveVersion = prepared.resolvedVersion;
        } else if (effectiveRunnerType === 'wine') {
          await verifyAndPrepareStagedWineApp(stagedApp);
        } else {
          await verifyMacAppDeveloperSignature(stagedApp, [], {
            ...options,
            _componentId: componentId,
            allowAdhocSignature: true,
          });
        }

        return await atomicSwapVerifiedApp(
          finalStagedApp,
          formatRunnerDisplayLabel(effectiveRunnerType, existingLayer),
          localArchiveVersion
        );
      } finally {
        try {
          await fs.promises.rm(localTempDir, { recursive: true, force: true });
        } catch {}
      }
    }

    throw new Error(
      `Unsupported runner archive format (${path.basename(explicitLocalInstallerPath)}). Expected .zip, .dmg, .tar.xz, or .txz.`
    );
  }

  // -------------------------------------------------------------------------
  // CrossOver Preview (`crossover_preview` & `crossover_preview_arm64`)
  // -------------------------------------------------------------------------
  /** @type {{ xml: string, feedUrl: string, sparklePublicEdKey: string } | null} */
  let resolvedPreviewSparkleFeed = null;
  if (isPreviewRunner) {
    const rawDownloadUrl =
      typeof options.downloadUrl === 'string' ? options.downloadUrl.trim() : '';
    if (rawDownloadUrl && !isAllowedCodeWeaversDownloadUrl(rawDownloadUrl, options)) {
      throwBlockedUrlError(`Untrusted CodeWeavers Preview download URL blocked: ${rawDownloadUrl}`);
    }
    const rawPreviewPortalUrl =
      typeof options.previewPortalUrl === 'string' ? options.previewPortalUrl.trim() : '';
    if (rawPreviewPortalUrl && !isAllowedCodeWeaversDownloadUrl(rawPreviewPortalUrl, options)) {
      throwBlockedUrlError(
        `Untrusted CodeWeavers Preview portal URL blocked: ${rawPreviewPortalUrl}`
      );
    }

    const portalUrl = String(
      rawDownloadUrl || rawPreviewPortalUrl || 'https://www.codeweavers.com/preview/download'
    ).trim();
    const previewPortalPageUrl = String(
      rawPreviewPortalUrl || 'https://www.codeweavers.com/preview/download'
    ).trim();

    if (
      !options.authenticateOnly &&
      options._runnerOperation === 'update' &&
      !options.forceReinstall &&
      existingLayer &&
      options.downloadUrl
    ) {
      const candidatePreviewDate = extractRunnerPreviewDate(options.downloadUrl);
      const existingPreviewDate =
        extractRunnerPreviewDate(existingLayer.previewDate) ||
        extractRunnerPreviewDate(existingLayer.displayVersion) ||
        extractRunnerPreviewDate(existingLayer.buildVersion) ||
        extractRunnerPreviewDate(existingLayer.version);
      const candidateDateNum = parseNumericPreviewDate(candidatePreviewDate);
      const existingDateNum = parseNumericPreviewDate(existingPreviewDate);

      let isAlreadyCurrent = false;
      if (candidateDateNum !== null && existingDateNum !== null) {
        isAlreadyCurrent = existingDateNum >= candidateDateNum;
      } else {
        const candidateHint = extractPreviewFilenameVersionHint(options.downloadUrl);
        const existingSemver =
          existingLayer.version && /^\d+\.\d+(?:\.\d+)?$/.test(String(existingLayer.version))
            ? String(existingLayer.version)
            : null;
        if (
          candidateHint &&
          !/^\d{8}$/.test(candidateHint) &&
          existingSemver &&
          typeof compareRunnerVersions === 'function'
        ) {
          isAlreadyCurrent = compareRunnerVersions(existingSemver, candidateHint) >= 0;
        }
      }
      if (isAlreadyCurrent) {
        return {
          success: true,
          installed: false,
          alreadyUpToDate: true,
          version: existingLayer.version,
          message: `${cwPreviewLabel} is already up to date (${existingLayer.displayVersion || existingLayer.version || 'latest version'}).`,
        };
      }
    }

    if (options.skipNetwork === true) {
      if (!isAllowedCodeWeaversDownloadUrl(portalUrl, options)) {
        throwBlockedUrlError(`Untrusted CodeWeavers Preview portal URL blocked: ${portalUrl}`);
      }
      await openExternalUri(portalUrl, options);
      return {
        success: true,
        installed: false,
        openedExternal: true,
        openedExternalUrl: portalUrl,
        message: 'Opened official CodeWeavers Preview download portal in your browser.',
      };
    }

    const explicitFeedUrl =
      typeof options.previewFeedUrl === 'string' ? options.previewFeedUrl.trim() : '';
    if (
      (explicitFeedUrl || (!options.downloadUrl && existingLayer?.appPath)) &&
      typeof parsePlistStringValues === 'function'
    ) {
      const plistDict =
        existingLayer?.appPath && !explicitFeedUrl
          ? parsePlistStringValues(path.join(existingLayer.appPath, 'Contents/Info.plist'))
          : {};
      const rawSuFeedUrl = String(explicitFeedUrl || plistDict.SUFeedURL || '').trim();
      const rawSuPubKey = String(
        options.sparklePublicEdKey ||
          plistDict.SUPublicEDKey ||
          CODEWEAVERS_SPARKLE_PUBLIC_ED_KEY
      ).trim();
      const validPreviewFeed =
        rawSuFeedUrl &&
        (typeof isPreviewSparkleFeedUrl === 'function'
          ? isPreviewSparkleFeedUrl(rawSuFeedUrl, options)
          : !/\/cxmac\.xml$/i.test(new URL(rawSuFeedUrl).pathname) &&
            /preview/i.test(new URL(rawSuFeedUrl).pathname));
      if (validPreviewFeed) {
        try {
          const safeFeedUrl = validateInstallerUrl(rawSuFeedUrl, options);
          emitEnvironmentSetupProgress(
            {
              ...progressCtx,
              phase: 'probing',
              message: `Resolving latest ${cwPreviewLabel} release from CodeWeavers Sparkle feed...`,
            },
            options
          );
          const previewXml = await fetchValidatedText(safeFeedUrl, options, signal);
          const encCheck = previewXml.match(/<enclosure\b([^>]*)>/i);
          const urlAttrCheck = encCheck ? encCheck[1].match(/\burl=["']([^"']+)["']/i) : null;
          const enclosureUrl = urlAttrCheck ? urlAttrCheck[1].trim() : '';
          const enclosureValid =
            enclosureUrl &&
            (typeof isPreviewSparkleEnclosureValid === 'function'
              ? isPreviewSparkleEnclosureValid(enclosureUrl, {
                  ...options,
                  previewBranch,
                })
              : classifyCrossOverPreviewArchiveBranch(enclosureUrl) === previewBranch);
          if (enclosureUrl && enclosureValid) {
            validateInstallerUrl(enclosureUrl, options);
            resolvedPreviewSparkleFeed = {
              xml: previewXml,
              feedUrl: safeFeedUrl,
              sparklePublicEdKey: rawSuPubKey,
            };
          }
        } catch (err) {
          if (isFatalSecurityOrAbortError(err, signal)) {
            throw err;
          }
        }
      }
    }

    if (!resolvedPreviewSparkleFeed) {
      if (
        effectiveRunnerType === 'crossover_preview' &&
        existingLayer?.version &&
        (options.switchToStableCrossOver === true ||
          (!options.downloadUrl &&
            !options.previewCandidateUrls?.length &&
            options.autoSwitchToStableIfSurpassed === true))
      ) {
        try {
          const stableXml = await fetchValidatedText(
            'https://www.codeweavers.com/xml/versions/cxmac.xml',
            options,
            signal
          );
          const encMatch = stableXml.match(/<enclosure\b([^>]*)>/i);
          const encAttrs = encMatch ? encMatch[1] : '';
          const verMatch = encAttrs.match(/\bsparkle:version=["']([^"']+)["']/i);
          const shortMatch = encAttrs.match(/\bsparkle:shortVersionString=["']([^"']+)["']/i);
          const rawBundleVer = verMatch ? verMatch[1].trim() : '';
          const rawShortVer = shortMatch ? shortMatch[1].trim() : '';
          const semverMatch = rawBundleVer.match(/^(\d+\.\d+\.\d+)(?:\.(\d+))?$/);
          const stableLatestVer = semverMatch ? semverMatch[1] : rawShortVer || rawBundleVer;
          if (
            stableLatestVer &&
            typeof compareRunnerVersions === 'function' &&
            compareRunnerVersions(existingLayer.version, stableLatestVer) < 0
          ) {
            const existingStableLayer =
              detectedBefore.find((/** @type {any} */ l) => l.type === 'crossover') || null;
            const stableRes = await installRunnerDirect('crossover', {
              ...options,
              switchToStableCrossOver: true,
              existingLayer: existingStableLayer,
              _prefetchedCxMacXml: stableXml,
            });
            return {
              ...stableRes,
              switchedToStableCrossOver: true,
            };
          }
        } catch (err) {
          if (isFatalSecurityOrAbortError(err, signal)) {
            throw err;
          }
        }
      }

      const electronModForCapture = (options && options.electronMod) || getElectron();

      /**
       * Helper to install an already-downloaded Preview archive (`.zip` or `.dmg`).
       *
       * @param {string} capturedArchivePath
       * @param {string | null} initialVersion
       * @param {string} workTempDir
       */
      const finalizeCapturedPreviewArchive = async (
        capturedArchivePath,
        initialVersion,
        workTempDir
      ) => {
        let resolvedVersion = initialVersion || null;
        if (
          typeof options.expectedSha256 === 'string' &&
          /^[a-f0-9]{64}$/i.test(options.expectedSha256.trim())
        ) {
          emitEnvironmentSetupProgress(
            {
              ...progressCtx,
              phase: 'verifying_signature',
              message: `Verifying ${cwPreviewLabel} archive SHA-256 checksum...`,
            },
            options
          );
          await verifyFileSha256Async(
            capturedArchivePath,
            options.expectedSha256.trim().toLowerCase()
          );
        }

        if (/\.dmg$/i.test(capturedArchivePath)) {
          const dmgTargetAppPath =
            existingTargetAppPath ||
            (runnerSpec ? path.join(targetAppsDir, runnerSpec.canonicalAppName) : null);
          return await installVerifiedDmgRunner(
            {
              dmgPath: capturedArchivePath,
              effectiveRunnerType,
              componentId,
              targetAppsDir,
              targetAppPath: dmgTargetAppPath,
              existingLayer,
              expectedTeamIds: CODEWEAVERS_PRIMARY_TEAM_IDS,
              additionalExpectedTeamIds: CODEWEAVERS_ADDITIONAL_TEAM_IDS,
              expectedVendorAuthorityPattern: CODEWEAVERS_VENDOR_AUTHORITY_RE,
              displayLabel: cwPreviewLabel,
              verifyingMessage: 'Verifying CodeWeavers Developer ID signature...',
              progressCtx,
              homedir,
              resolveVersionAfterInstall: (installedPath) =>
                resolvePreviewBundleVersion(installedPath, resolvedVersion),
            },
            options
          );
        }

        const execFn = getExecFileFn(options);
        const stagingDir = path.join(workTempDir, 'staging');
        await fs.promises.mkdir(stagingDir, { recursive: true });
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'extracting',
            message: `Extracting ${cwPreviewLabel} archive...`,
          },
          options
        );

        if (typeof options.onExtractArchive === 'function') {
          await options.onExtractArchive(capturedArchivePath, stagingDir);
        } else {
          await runExecFileAsync(
            execFn,
            '/usr/bin/ditto',
            ['-x', '-k', capturedArchivePath, stagingDir],
            { timeout: 300000, signal }
          );
        }

        if (signal?.aborted) {
          const abortErr = new Error(
            `Extraction of ${cwPreviewLabel || effectiveRunnerType} cancelled.`
          );
          abortErr.name = 'AbortError';
          throw abortErr;
        }

        const preferredNames = runnerSpec
          ? [runnerSpec.canonicalAppName, 'CrossOver Preview.app']
          : ['CrossOver Preview.app'];
        const stagedApp = await findStagedAppBundle(stagingDir, 0, preferredNames);
        if (!stagedApp) {
          throw new Error('CrossOver Preview.app was not found inside the downloaded archive.');
        }

        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'verifying_signature',
            message: 'Verifying CodeWeavers Developer ID signature...',
          },
          options
        );
        const prepared = await verifyAndPrepareCodeWeaversStagedApp(stagedApp, resolvedVersion);
        return await atomicSwapVerifiedApp(
          prepared.preparedApp,
          cwPreviewLabel,
          prepared.resolvedVersion || null
        );
      };

      if (
        !options.authenticateOnly &&
        typeof options.capturePreviewDownloadFn !== 'function'
      ) {
        const stripDefaultLauncherUa = (/** @type {any} */ fetchOpts) => {
          const {
            redirect: _stripRedirect,
            headers: rawHeaders,
            ...safeOpts
          } = fetchOpts || {};
          const callerHasExplicitUa = Boolean(
            options?.headers?.['User-Agent'] || options?.headers?.['user-agent']
          );
          if (!rawHeaders || typeof rawHeaders !== 'object') {
            return { safeOpts, headers: undefined };
          }
          const cleanedHeaders = { ...rawHeaders };
          if (!callerHasExplicitUa) {
            if (cleanedHeaders['User-Agent'] === 'OneGameLauncher/1.0') {
              delete cleanedHeaders['User-Agent'];
            }
            if (cleanedHeaders['user-agent'] === 'OneGameLauncher/1.0') {
              delete cleanedHeaders['user-agent'];
            }
          }
          const hasHeaders = Object.keys(cleanedHeaders).length > 0;
          return {
            safeOpts,
            headers: hasHeaders ? cleanedHeaders : undefined,
          };
        };

        let usesElectronSessionFetch = false;
        const resolveStreamPreviewFetch = () => {
          if (typeof options.previewSessionFetch === 'function') {
            return options.previewSessionFetch;
          }
          if (typeof options.sessionFetch === 'function') {
            return options.sessionFetch;
          }
          const sessionMod = electronModForCapture?.session;
          if (sessionMod && typeof sessionMod.fromPartition === 'function') {
            try {
              const previewSession = sessionMod.fromPartition('persist:codeweavers-preview');
              const cleanBrowserUa =
                process.platform === 'win32'
                  ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
                  : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
              try {
                if (typeof previewSession?.setUserAgent === 'function') {
                  previewSession.setUserAgent(cleanBrowserUa);
                }
              } catch {}
              if (typeof previewSession?.fetch === 'function') {
                usesElectronSessionFetch = true;
                return (/** @type {string} */ u, /** @type {any} */ fetchOpts) => {
                  const { safeOpts, headers } = stripDefaultLauncherUa(fetchOpts);
                  return previewSession.fetch(u, {
                    ...safeOpts,
                    ...(headers ? { headers } : {}),
                    credentials: 'include',
                  });
                };
              }
              if (previewSession?.net && typeof previewSession.net.fetch === 'function') {
                usesElectronSessionFetch = true;
                return (/** @type {string} */ u, /** @type {any} */ fetchOpts) => {
                  const { safeOpts, headers } = stripDefaultLauncherUa(fetchOpts);
                  return previewSession.net.fetch(u, {
                    ...safeOpts,
                    ...(headers ? { headers } : {}),
                    credentials: 'include',
                  });
                };
              }
            } catch {}
          }
          return null;
        };

        const streamPreviewFetch = resolveStreamPreviewFetch();
        if (typeof streamPreviewFetch === 'function') {
          let verifiedArchiveUrl = options.downloadUrl
            ? selectPreferredCrossOverPreviewDownloadUrl([options.downloadUrl], previewPortalPageUrl, {
                ...options,
                previewBranch,
              })
            : null;
          if (!verifiedArchiveUrl && typeof getCachedAuthenticatedPreviewUrl === 'function') {
            const cachedBranchUrl = getCachedAuthenticatedPreviewUrl({
              ...options,
              previewBranch,
            });
            if (cachedBranchUrl) {
              verifiedArchiveUrl = selectPreferredCrossOverPreviewDownloadUrl(
                [cachedBranchUrl],
                previewPortalPageUrl,
                { ...options, previewBranch }
              );
            }
          }

          if (
            !verifiedArchiveUrl &&
            !options.skipNetwork &&
            isAllowedCodeWeaversDownloadUrl(previewPortalPageUrl, options)
          ) {
            try {
              const explicitUa =
                options?.headers?.['User-Agent'] || options?.headers?.['user-agent'];
              const portalProbeHeaders = explicitUa
                ? { 'User-Agent': explicitUa }
                : usesElectronSessionFetch
                  ? undefined
                  : {
                      'User-Agent':
                        process.platform === 'win32'
                          ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
                          : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
                    };
              const portalRes = await streamPreviewFetch(previewPortalPageUrl, {
                signal,
                ...(portalProbeHeaders ? { headers: portalProbeHeaders } : {}),
              });
              const rawPortalResUrl = String(portalRes?.url || '').trim();
              if (
                rawPortalResUrl &&
                !isAllowedCodeWeaversAuthNavigationUrl(rawPortalResUrl, options)
              ) {
                try {
                  await portalRes?.body?.cancel?.();
                } catch {}
                throwBlockedUrlError(
                  `Untrusted CodeWeavers Preview portal redirect URL blocked: ${rawPortalResUrl}`
                );
              }
              if (portalRes && portalRes.ok) {
                const portalResUrl = rawPortalResUrl.toLowerCase();
                const portalText =
                  typeof portalRes.text === 'function' ? await portalRes.text() : '';
                const looksLikeAuthOrChallenge =
                  portalResUrl.includes('/login') ||
                  portalResUrl.includes('/signin') ||
                  portalResUrl.includes('/account/login') ||
                  /<input[^>]+type=["']password["']/i.test(portalText) ||
                  /<form[^>]+action=["'][^"']*(?:login|signin)/i.test(portalText) ||
                  /<title>[^<]*Sign\s*In[^<]*\|[^<]*CodeWeavers/i.test(portalText) ||
                  /<title>\s*Just a moment\b/i.test(portalText) ||
                  /cf-challenge-running|challenge-platform|challenges\.cloudflare\.com|cf-turnstile-response/i.test(
                    portalText
                  );
                if (!looksLikeAuthOrChallenge && portalText) {
                  const links = extractCandidateLinksFromText(portalText, []);
                  const discovered = discoverCrossOverPreviewBranchUrls(
                    links,
                    previewPortalPageUrl,
                    options
                  );
                  if (typeof setCachedAuthenticatedPreviewUrl === 'function') {
                    if (discovered.standard) {
                      setCachedAuthenticatedPreviewUrl(discovered.standard, {
                        ...options,
                        previewBranch: 'standard',
                      });
                    }
                    if (discovered.arm64) {
                      setCachedAuthenticatedPreviewUrl(discovered.arm64, {
                        ...options,
                        previewBranch: 'arm64',
                      });
                    }
                  }
                  verifiedArchiveUrl = discovered[previewBranch];
                }
              }
            } catch (probeErr) {
              if (isFatalSecurityOrAbortError(probeErr, signal)) {
                throw probeErr;
              }
            }
          }

          if (verifiedArchiveUrl) {
            const streamTempDir = await fs.promises.mkdtemp(
              path.join(os.tmpdir(), 'ol-cx-preview-')
            );
            let downloadStepComplete = false;
            try {
              const isDmgStream = /\.dmg(?:\?|$)/i.test(verifiedArchiveUrl);
              const streamArchivePath = path.join(
                streamTempDir,
                isDmgStream ? 'CrossOverPreview.dmg' : 'CrossOverPreview.zip'
              );
              const wrappedStreamFetch = async (
                /** @type {string} */ u,
                /** @type {any} */ fetchOpts
              ) => {
                const { safeOpts, headers } = stripDefaultLauncherUa(fetchOpts);
                const resp = await streamPreviewFetch(u, {
                  ...safeOpts,
                  ...(headers ? { headers } : {}),
                });
                if (!resp) {
                  throw new Error('Empty response from CodeWeavers Preview download.');
                }
                const respUrl = String(resp.url || '').trim();
                const lowerRespUrl = respUrl.toLowerCase();
                if (respUrl && !isAllowedCodeWeaversAuthNavigationUrl(respUrl, options)) {
                  try {
                    await resp.body?.cancel?.();
                  } catch {}
                  throwBlockedUrlError(
                    `Untrusted CodeWeavers Preview redirect URL blocked: ${respUrl}`
                  );
                }
                if (
                  resp.status === 401 ||
                  resp.status === 403 ||
                  !resp.ok ||
                  lowerRespUrl.includes('/login') ||
                  lowerRespUrl.includes('/signin') ||
                  lowerRespUrl.includes('/account/login') ||
                  (respUrl && !isAllowedCodeWeaversDownloadUrl(respUrl, options))
                ) {
                  const authErr = /** @type {Error & { code?: string }} */ (
                    new Error(`Preview download requires authentication (HTTP ${resp.status || 0}).`)
                  );
                  authErr.code = 'PREVIEW_AUTH_REQUIRED';
                  throw authErr;
                }
                return resp;
              };

              await streamVerifiedDownloadToFile(
                verifiedArchiveUrl,
                streamArchivePath,
                {
                  ...progressCtx,
                  label: cwPreviewLabel,
                  minFreeBytes: Number(options.minFreeBytes || 1200 * 1024 * 1024),
                },
                {
                  ...options,
                  fetchFn: wrappedStreamFetch,
                  rejectHtmlPayload: true,
                  preserveSessionUserAgent: true,
                },
                signal
              );
              downloadStepComplete = true;
              const streamHintVersion =
                extractPreviewFilenameVersionHint(verifiedArchiveUrl) ||
                extractRunnerPreviewDate(verifiedArchiveUrl);
              return await finalizeCapturedPreviewArchive(
                streamArchivePath,
                streamHintVersion,
                streamTempDir
              );
            } catch (streamErr) {
              if (
                downloadStepComplete ||
                isFatalSecurityOrAbortError(streamErr, signal) ||
                Boolean(/** @type {any} */ (streamErr)?.busyCode)
              ) {
                throw streamErr;
              }
              if (typeof clearCachedAuthenticatedPreviewUrl === 'function') {
                clearCachedAuthenticatedPreviewUrl(previewBranch);
              }
            } finally {
              try {
                await fs.promises.rm(streamTempDir, { recursive: true, force: true });
              } catch {}
            }
          }
        }
      }

      const canCapturePreviewInApp =
        typeof options.capturePreviewDownloadFn === 'function' ||
        (Boolean(electronModForCapture?.BrowserWindow) &&
          Boolean(electronModForCapture?.session) &&
          (!isTestEnvironment(options) || options.allowInteractivePreviewCapture === true));

      if (canCapturePreviewInApp) {
        const previewTempDir =
          options.authenticateOnly === true
            ? os.tmpdir()
            : await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ol-cx-preview-'));
        try {
          const captured = await captureCodeWeaversPreviewDownload(
            previewTempDir,
            progressCtx,
            { ...options, previewBranch },
            signal
          );
          if (captured && captured.alreadyUpToDate) {
            emitEnvironmentSetupProgress(
              {
                ...progressCtx,
                phase: 'completed',
                progressPercent: 100,
                message: `${cwPreviewLabel} is already up to date (${existingLayer?.displayVersion || existingLayer?.version || 'latest version'}).`,
              },
              options
            );
            return {
              success: true,
              installed: false,
              alreadyUpToDate: true,
              version: existingLayer?.version || captured.resolvedVersion,
              message: `${cwPreviewLabel} is already up to date (${existingLayer?.displayVersion || existingLayer?.version || 'latest version'}).`,
            };
          }

          if (captured && (captured.authenticated || options.authenticateOnly)) {
            emitEnvironmentSetupProgress(
              {
                ...progressCtx,
                phase: 'completed',
                progressPercent: 100,
                message: 'CodeWeavers Preview authentication completed.',
              },
              options
            );
            return {
              success: true,
              installed: false,
              authenticated: true,
              downloadUrl: captured.downloadUrl || null,
              version: captured.resolvedVersion || existingLayer?.version,
              message: 'CodeWeavers Preview authentication completed.',
            };
          }

          return await finalizeCapturedPreviewArchive(
            captured.archivePath,
            captured.resolvedVersion || null,
            previewTempDir
          );
        } finally {
          if (options.authenticateOnly !== true) {
            try {
              await fs.promises.rm(previewTempDir, { recursive: true, force: true });
            } catch {}
          }
        }
      }

      if (!isAllowedCodeWeaversDownloadUrl(portalUrl, options)) {
        throwBlockedUrlError(`Untrusted CodeWeavers Preview portal URL blocked: ${portalUrl}`);
      }
      await openExternalUri(portalUrl, options);
      return {
        success: true,
        installed: false,
        openedExternal: true,
        openedExternalUrl: portalUrl,
        message: 'Opened official CodeWeavers Preview download portal in your browser.',
      };
    }
  }

  // -------------------------------------------------------------------------
  // Apple Game Porting Toolkit (`gptk`): Apple Silicon macOS 14+
  // -------------------------------------------------------------------------
  if (effectiveRunnerType === 'gptk') {
    const gptkArch = String(options.arch || process.arch);
    const darwinKernelMajor = resolveDarwinKernelMajor(options);
    if (gptkArch !== 'arm64' || darwinKernelMajor < 23) {
      const portalUrl = 'https://developer.apple.com/games/game-porting-toolkit/';
      await openExternalUri(portalUrl, options);
      return {
        success: true,
        installed: false,
        openedExternal: true,
        openedExternalUrl: portalUrl,
        message:
          'Apple Game Porting Toolkit automated install requires Apple Silicon on macOS 14 Sonoma or newer; opened Apple Developer portal.',
      };
    }
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ol-env-setup-'));
  const execFileFn = getExecFileFn(options);

  try {
    // -----------------------------------------------------------------------
    // 1. CrossOver Stable (`crossover`) & Sparkle-Enabled CrossOver Preview
    // -----------------------------------------------------------------------
    if (effectiveRunnerType === 'crossover' || isPreviewRunner) {
      const isPreviewSparkle = isPreviewRunner && Boolean(resolvedPreviewSparkleFeed);
      const cwLabel = isPreviewSparkle ? cwPreviewLabel : 'CrossOver';
      if (!isPreviewSparkle && !options._prefetchedCxMacXml) {
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'probing',
            message: 'Resolving latest CrossOver release from CodeWeavers Sparkle feed...',
          },
          options
        );
      }
      const xml = isPreviewSparkle
        ? String(resolvedPreviewSparkleFeed?.xml || '')
        : typeof options._prefetchedCxMacXml === 'string' && options._prefetchedCxMacXml
          ? options._prefetchedCxMacXml
          : await fetchValidatedText(
              'https://www.codeweavers.com/xml/versions/cxmac.xml',
              options,
              signal
            );
      const encMatch = xml.match(/<enclosure\b([^>]*)>/i);
      const encAttrs = encMatch ? encMatch[1] : '';
      const urlMatch = encAttrs.match(/\burl=["']([^"']+)["']/i);
      const archiveUrl = urlMatch ? validateInstallerUrl(urlMatch[1].trim(), options) : '';
      if (!archiveUrl) {
        throw new Error(`Could not find ${cwLabel} download URL in CodeWeavers Sparkle feed.`);
      }

      const lenMatch = encAttrs.match(/\blength=["'](\d+)["']/i);
      const expectedByteLength =
        typeof options.expectedByteLength === 'number' && options.expectedByteLength > 0
          ? options.expectedByteLength
          : lenMatch
            ? Number.parseInt(lenMatch[1], 10)
            : 0;
      const edSigMatch = encAttrs.match(/\bsparkle:edSignature=["']([^"']+)["']/i);
      const sparkleEdSignature = String(
        options.expectedEdSignature || (edSigMatch ? edSigMatch[1] : '') || ''
      ).trim();
      const shortVerMatch =
        encAttrs.match(/\bsparkle:shortVersionString=["']([^"']+)["']/i) ||
        xml.match(/<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/i);
      const sparkleVerMatch =
        encAttrs.match(/\bsparkle:version=["']([^"']+)["']/i) ||
        xml.match(/<sparkle:version>([^<]+)<\/sparkle:version>/i);
      const rawShortVer = String(shortVerMatch?.[1] || '').trim();
      const rawSparkleVer = String(sparkleVerMatch?.[1] || '').trim();
      const sparkleSemverMatch = rawSparkleVer.match(/^(\d+\.\d+\.\d+)(?:\.(\d+))?$/);
      const resolvedVersion =
        (/^\d{8}$/.test(rawShortVer) && sparkleSemverMatch
          ? sparkleSemverMatch[1]
          : rawShortVer || rawSparkleVer) || null;

      let caskSha256 =
        typeof options.expectedSha256 === 'string' &&
        /^[a-f0-9]{64}$/i.test(options.expectedSha256.trim())
          ? options.expectedSha256.trim().toLowerCase()
          : '';
      if (!caskSha256 && !isPreviewSparkle) {
        try {
          const caskTxt = await fetchValidatedText(
            'https://formulae.brew.sh/api/cask/crossover.json',
            options,
            signal
          );
          const caskJson = JSON.parse(caskTxt);
          const caskUrl = typeof caskJson?.url === 'string' ? caskJson.url.trim() : '';
          const caskVer = String(caskJson?.version || '')
            .split(',')[0]
            .trim();
          const rawCaskSha = String(caskJson?.sha256 || '')
            .trim()
            .toLowerCase();
          const matchesRelease =
            (caskUrl && caskUrl === archiveUrl) ||
            (resolvedVersion && caskVer && resolvedVersion.startsWith(caskVer));
          if (matchesRelease && /^[a-f0-9]{64}$/.test(rawCaskSha)) {
            caskSha256 = rawCaskSha;
          }
        } catch (err) {
          if (isFatalSecurityOrAbortError(err, signal)) {
            throw err;
          }
        }
      }

      const isDmg = /\.dmg(?:\?|$)/i.test(archiveUrl);
      const archiveBaseStem = isPreviewSparkle ? 'CrossOverPreview' : 'CrossOver';
      const archivePath = path.join(
        tempDir,
        isDmg ? `${archiveBaseStem}.dmg` : `${archiveBaseStem}.zip`
      );
      await streamVerifiedDownloadToFile(
        archiveUrl,
        archivePath,
        {
          ...progressCtx,
          label: cwLabel,
          minFreeBytes: 1200 * 1024 * 1024,
        },
        options,
        signal
      );

      if (expectedByteLength > 0) {
        const archiveStat = await fs.promises.stat(archivePath);
        if (archiveStat.size !== expectedByteLength) {
          await fs.promises.rm(archivePath, { force: true }).catch(() => {});
          throw new Error(
            `${cwLabel} download size mismatch: expected ${expectedByteLength} bytes, got ${archiveStat.size} bytes.`
          );
        }
      }

      if (caskSha256) {
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'verifying_signature',
            message: `Verifying ${cwLabel} archive SHA-256 checksum...`,
          },
          options
        );
        await verifyFileSha256Async(archivePath, caskSha256);
      }

      if (sparkleEdSignature) {
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'verifying_signature',
            message: 'Verifying CodeWeavers Sparkle Ed25519 signature...',
          },
          options
        );
        const pubKey = String(
          options.sparklePublicEdKey ||
            resolvedPreviewSparkleFeed?.sparklePublicEdKey ||
            CODEWEAVERS_SPARKLE_PUBLIC_ED_KEY
        ).trim();
        await verifySparkleEd25519SignatureAsync(archivePath, sparkleEdSignature, pubKey, options);
      } else if (
        !caskSha256 &&
        (options.requireSparkleEdSignature === true ||
          options.requireArchiveVerification === true ||
          (!isTestEnvironment(options) && options.allowUnverifiedArchiveDigest !== true))
      ) {
        await fs.promises.rm(archivePath, { force: true }).catch(() => {});
        throw new Error(
          `${cwLabel} Sparkle feed is missing required SHA-256 or sparkle:edSignature verification metadata.`
        );
      }

      if (isDmg) {
        const dmgTargetAppPath =
          existingTargetAppPath ||
          (runnerSpec ? path.join(targetAppsDir, runnerSpec.canonicalAppName) : null);
        return await installVerifiedDmgRunner(
          {
            dmgPath: archivePath,
            effectiveRunnerType,
            componentId,
            targetAppsDir,
            targetAppPath: dmgTargetAppPath,
            existingLayer,
            expectedTeamIds: CODEWEAVERS_PRIMARY_TEAM_IDS,
            additionalExpectedTeamIds: CODEWEAVERS_ADDITIONAL_TEAM_IDS,
            expectedVendorAuthorityPattern: CODEWEAVERS_VENDOR_AUTHORITY_RE,
            displayLabel: cwLabel,
            verifyingMessage: 'Verifying CodeWeavers Developer ID signature...',
            progressCtx,
            homedir,
            resolvedVersion,
          },
          options
        );
      }

      const stagingDir = path.join(tempDir, 'staging');
      await fs.promises.mkdir(stagingDir, { recursive: true });
      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'extracting',
          message: `Extracting ${cwLabel} archive...`,
        },
        options
      );

      if (typeof options.onExtractArchive === 'function') {
        await options.onExtractArchive(archivePath, stagingDir);
      } else {
        await runExecFileAsync(
          execFileFn,
          '/usr/bin/ditto',
          ['-x', '-k', archivePath, stagingDir],
          { timeout: 300000, signal }
        );
      }

      const preferredNames = runnerSpec
        ? [runnerSpec.canonicalAppName, 'CrossOver Preview.app']
        : [];
      const stagedApp = await findStagedAppBundle(stagingDir, 0, preferredNames);
      if (!stagedApp) {
        throw new Error(`${cwLabel}.app was not found inside the downloaded archive.`);
      }

      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'verifying_signature',
          message: 'Verifying CodeWeavers Developer ID signature...',
        },
        options
      );
      const prepared = await verifyAndPrepareCodeWeaversStagedApp(stagedApp, resolvedVersion);
      return await atomicSwapVerifiedApp(
        prepared.preparedApp,
        cwLabel,
        prepared.resolvedVersion
      );
    }

    // -----------------------------------------------------------------------
    // 2. Open-Source Wine (`wine`: `stable` | `staging` | `devel`)
    // -----------------------------------------------------------------------
    if (effectiveRunnerType === 'wine') {
      const existingCombined = `${existingLayer?.name || ''} ${existingLayer?.appPath || ''} ${existingLayer?.binaryPath || ''}`;
      if (
        options._runnerOperation === 'update' &&
        !options.wineChannel &&
        /wine[-_\s]*crossover/i.test(existingCombined)
      ) {
        throw new Error(
          'Wine Crossover is a retired distribution and cannot be updated in place. Install Wine Stable or CrossOver instead.'
        );
      }

      const wineChannel = (() => {
        const rawChan = String(options.wineChannel || '')
          .trim()
          .toLowerCase();
        if (rawChan === 'staging' || rawChan === 'devel' || rawChan === 'stable') {
          return rawChan;
        }
        if (/wine[-_\s]*staging/i.test(existingCombined)) return 'staging';
        if (/wine[-_\s]*devel/i.test(existingCombined)) return 'devel';
        return 'stable';
      })();

      const wineLabel =
        wineChannel === 'staging'
          ? 'Wine Staging'
          : wineChannel === 'devel'
            ? 'Wine Devel'
            : 'Wine Stable';
      const caskApiUrl =
        wineChannel === 'staging'
          ? 'https://formulae.brew.sh/api/cask/wine@staging.json'
          : wineChannel === 'devel'
            ? 'https://formulae.brew.sh/api/cask/wine@devel.json'
            : 'https://formulae.brew.sh/api/cask/wine-stable.json';
      const assetNameRe =
        wineChannel === 'staging'
          ? /wine[-_]?staging.*\.(?:tar\.xz|txz|dmg)$/i
          : wineChannel === 'devel'
            ? /wine[-_]?devel.*\.(?:tar\.xz|txz|dmg)$/i
            : /wine[-_]?stable.*\.(?:tar\.xz|txz|dmg)$/i;

      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'probing',
          message: `Resolving latest Open-Source ${wineLabel} release...`,
        },
        options
      );

      let assetUrl = '';
      let resolvedVersion = /** @type {string | null} */ (null);
      let expectedSha256 =
        typeof options.expectedSha256 === 'string' &&
        /^[a-f0-9]{64}$/i.test(options.expectedSha256.trim())
          ? options.expectedSha256.trim().toLowerCase()
          : '';

      const tryResolveWineFromCaskApi = async (allowDisabled = false) => {
        try {
          const caskTxt = await fetchValidatedText(caskApiUrl, options, signal);
          const caskJson = JSON.parse(caskTxt);
          if (
            caskJson &&
            (allowDisabled || caskJson.disabled !== true) &&
            typeof caskJson.url === 'string' &&
            caskJson.url.trim()
          ) {
            assetUrl = validateInstallerUrl(caskJson.url.trim(), options);
            if (typeof caskJson.version === 'string' && caskJson.version.trim()) {
              resolvedVersion = caskJson.version.split(',')[0].trim();
            }
            if (
              !expectedSha256 &&
              typeof caskJson.sha256 === 'string' &&
              /^[a-f0-9]{64}$/i.test(caskJson.sha256.trim())
            ) {
              expectedSha256 = caskJson.sha256.trim().toLowerCase();
            }
          }
        } catch (err) {
          if (isFatalSecurityOrAbortError(err, signal)) {
            throw err;
          }
        }
      };

      const extractWineAssetFromReleaseObj = (/** @type {any} */ relObj) => {
        const assets = Array.isArray(relObj?.assets) ? relObj.assets : [];
        const matchedAsset = assets.find((/** @type {any} */ a) =>
          assetNameRe.test(String(a?.name || ''))
        );
        if (!matchedAsset?.browser_download_url) return false;
        assetUrl = validateInstallerUrl(
          String(matchedAsset.browser_download_url).trim(),
          options
        );
        const rawTag = String(relObj?.tag_name || relObj?.name || matchedAsset?.name || '')
          .replace(/^v/i, '')
          .trim();
        const tagVerMatch = rawTag.match(/(\d+\.\d+(?:\.\d+)?(?:[-_][0-9A-Za-z.]+)?)/);
        if (tagVerMatch) resolvedVersion = tagVerMatch[1];
        else if (rawTag) resolvedVersion = rawTag;
        const rawDigest = String(matchedAsset?.digest || '').trim();
        if (!expectedSha256 && /^sha256:[a-f0-9]{64}$/i.test(rawDigest)) {
          expectedSha256 = rawDigest.slice(7).toLowerCase();
        }
        return true;
      };

      const tryResolveWineFromGitHubReleases = async () => {
        try {
          const ghListTxt = await fetchValidatedText(
            'https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases?per_page=20',
            options,
            signal
          );
          const ghList = JSON.parse(ghListTxt);
          if (Array.isArray(ghList)) {
            for (const rel of ghList) {
              if (rel && !rel.draft && extractWineAssetFromReleaseObj(rel)) {
                break;
              }
            }
          } else if (ghList && typeof ghList === 'object') {
            extractWineAssetFromReleaseObj(ghList);
          }
        } catch (err) {
          if (isFatalSecurityOrAbortError(err, signal)) {
            throw err;
          }
        }

        if (!assetUrl) {
          try {
            const ghLatestTxt = await fetchValidatedText(
              'https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases/latest',
              options,
              signal
            );
            extractWineAssetFromReleaseObj(JSON.parse(ghLatestTxt));
          } catch (err) {
            if (isFatalSecurityOrAbortError(err, signal)) {
              throw err;
            }
          }
        }

        if (assetUrl && !expectedSha256) {
          try {
            const caskRb = await fetchValidatedText(
              `https://raw.githubusercontent.com/Gcenx/homebrew-wine/master/Casks/wine-${wineChannel}.rb`,
              options,
              signal
            );
            const shaMatch = caskRb.match(/\bsha256\s+["']([a-f0-9]{64})["']/i);
            const verMatch = caskRb.match(/\bversion\s+["']([^"']+)["']/i);
            const caskSha = shaMatch ? shaMatch[1].toLowerCase() : '';
            const caskVer = verMatch ? verMatch[1].trim() : '';
            if (
              caskSha &&
              (!caskVer ||
                !resolvedVersion ||
                resolvedVersion === caskVer ||
                assetUrl.includes(caskVer))
            ) {
              expectedSha256 = caskSha;
            }
          } catch (err) {
            if (isFatalSecurityOrAbortError(err, signal)) {
              throw err;
            }
          }
        }
      };

      if (wineChannel === 'stable') {
        await tryResolveWineFromCaskApi(false);
        if (!assetUrl) {
          await tryResolveWineFromGitHubReleases();
        }
      } else {
        await tryResolveWineFromGitHubReleases();
        if (!assetUrl) {
          await tryResolveWineFromCaskApi(true);
        }
      }

      if (!assetUrl) {
        throw new Error(`Could not resolve Open-Source ${wineLabel} download asset URL.`);
      }

      const isDmg = /\.dmg(?:\?|$)/i.test(assetUrl);
      const safeFileStem = wineLabel.replace(/\s+/g, '');
      const archivePath = path.join(
        tempDir,
        isDmg ? `${safeFileStem}.dmg` : `${safeFileStem}.tar.xz`
      );
      await streamVerifiedDownloadToFile(
        assetUrl,
        archivePath,
        {
          ...progressCtx,
          label: wineLabel,
          minFreeBytes: 800 * 1024 * 1024,
        },
        options,
        signal
      );

      if (expectedSha256) {
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'verifying_signature',
            message: `Verifying ${wineLabel} archive SHA-256 checksum...`,
          },
          options
        );
        await verifyFileSha256Async(archivePath, expectedSha256);
      } else if (!isTestEnvironment(options) && options.allowUnverifiedArchiveDigest !== true) {
        await fs.promises.rm(archivePath, { force: true }).catch(() => {});
        throw new Error(
          `Refusing to extract ${wineLabel} archive without a cryptographic SHA-256 digest.`
        );
      }

      if (isDmg) {
        return await installVerifiedDmgRunner(
          {
            dmgPath: archivePath,
            effectiveRunnerType,
            componentId,
            targetAppsDir,
            targetAppPath: existingTargetAppPath,
            existingLayer,
            expectedTeamIds: [],
            expectedVendorAuthorityPattern: null,
            displayLabel: wineLabel,
            verifyingMessage: `Verifying ${wineLabel} code signature integrity...`,
            progressCtx,
            homedir,
            resolvedVersion,
            extraMountOptions: {
              allowAdhocSignature: true,
              prepareUnsignedWineBundle: true,
            },
          },
          options
        );
      }

      const stagingDir = path.join(tempDir, 'staging');
      await fs.promises.mkdir(stagingDir, { recursive: true });
      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'extracting',
          message: `Extracting ${wineLabel} archive...`,
        },
        options
      );

      if (typeof options.onExtractArchive === 'function') {
        await options.onExtractArchive(archivePath, stagingDir);
      } else {
        await runExecFileAsync(
          execFileFn,
          '/usr/bin/tar',
          ['-xf', archivePath, '-C', stagingDir],
          { timeout: 300000, signal }
        );
      }

      const stagedApp = await findStagedAppBundle(stagingDir);
      if (!stagedApp) {
        throw new Error(`${wineLabel}.app was not found inside the downloaded archive.`);
      }

      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'verifying_signature',
          message: `Verifying ${wineLabel} code signature integrity...`,
        },
        options
      );
      await verifyAndPrepareStagedWineApp(stagedApp);

      return await atomicSwapVerifiedApp(stagedApp, wineLabel, resolvedVersion);
    }

    // -----------------------------------------------------------------------
    // 3. Apple Game Porting Toolkit (`gptk`: Apple Silicon macOS 14+)
    // -----------------------------------------------------------------------
    if (effectiveRunnerType === 'gptk') {
      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'probing',
          message: 'Resolving latest Apple Game Porting Toolkit release...',
        },
        options
      );

      let assetUrl = '';
      let resolvedVersion = /** @type {string | null} */ (null);
      let expectedSha256 =
        typeof options.expectedSha256 === 'string' &&
        /^[a-f0-9]{64}$/i.test(options.expectedSha256.trim())
          ? options.expectedSha256.trim().toLowerCase()
          : '';

      const ghTxt = await fetchValidatedText(
        'https://api.github.com/repos/Gcenx/game-porting-toolkit/releases/latest',
        options,
        signal
      );
      const ghJson = JSON.parse(ghTxt);
      const rawTag = String(ghJson?.tag_name || ghJson?.name || '')
        .replace(/^game-porting-toolkit[-_]?v?/i, '')
        .replace(/^v/i, '')
        .trim();
      if (rawTag) {
        const tagVerMatch = rawTag.match(/(\d+\.\d+(?:\.\d+)?(?:[-_][0-9A-Za-z.]+)?)/);
        resolvedVersion = tagVerMatch ? tagVerMatch[1] : rawTag;
      }
      const assets = Array.isArray(ghJson?.assets) ? ghJson.assets : [];
      const matchedAsset =
        assets.find((/** @type {any} */ a) =>
          /\.(?:tar\.xz|txz)$/i.test(String(a?.name || ''))
        ) ||
        assets.find((/** @type {any} */ a) => /\.dmg$/i.test(String(a?.name || '')));
      if (matchedAsset?.browser_download_url) {
        assetUrl = validateInstallerUrl(
          String(matchedAsset.browser_download_url).trim(),
          options
        );
        const rawDigest = String(matchedAsset?.digest || '').trim();
        if (!expectedSha256 && /^sha256:[a-f0-9]{64}$/i.test(rawDigest)) {
          expectedSha256 = rawDigest.slice(7).toLowerCase();
        }
      }

      if (!assetUrl) {
        throw new Error(
          'Could not resolve Apple Game Porting Toolkit download asset from GitHub release feed.'
        );
      }

      try {
        const caskRb = await fetchValidatedText(
          'https://raw.githubusercontent.com/Gcenx/homebrew-wine/master/Casks/game-porting-toolkit.rb',
          options,
          signal
        );
        const shaMatch = caskRb.match(/\bsha256\s+["']([a-f0-9]{64})["']/i);
        const verMatch = caskRb.match(/\bversion\s+["']([^"']+)["']/i);
        const caskSha = shaMatch ? shaMatch[1].toLowerCase() : '';
        const caskVer = verMatch ? verMatch[1].trim() : '';
        if (caskSha) {
          const sameRelease =
            !caskVer ||
            !resolvedVersion ||
            resolvedVersion === caskVer ||
            assetUrl.includes(caskVer);
          if (sameRelease) {
            if (expectedSha256 && expectedSha256 !== caskSha) {
              throw new Error(
                `Game Porting Toolkit SHA-256 mismatch between GitHub release (${expectedSha256}) and cask (${caskSha}).`
              );
            }
            if (!expectedSha256) {
              expectedSha256 = caskSha;
            }
          }
        }
      } catch (err) {
        if (
          isFatalSecurityOrAbortError(err, signal) ||
          /SHA-256 mismatch between GitHub release/i.test(String(err?.message || ''))
        ) {
          throw err;
        }
      }

      const isDmg = /\.dmg(?:\?|$)/i.test(assetUrl);
      const archivePath = path.join(
        tempDir,
        isDmg ? 'GamePortingToolkit.dmg' : 'GamePortingToolkit.tar.xz'
      );
      await streamVerifiedDownloadToFile(
        assetUrl,
        archivePath,
        {
          ...progressCtx,
          label: 'Apple Game Porting Toolkit',
          minFreeBytes: 900 * 1024 * 1024,
        },
        options,
        signal
      );

      if (expectedSha256) {
        emitEnvironmentSetupProgress(
          {
            ...progressCtx,
            phase: 'verifying_signature',
            message: 'Verifying Game Porting Toolkit archive SHA-256 checksum...',
          },
          options
        );
        await verifyFileSha256Async(archivePath, expectedSha256);
      } else if (!isTestEnvironment(options) && options.allowUnverifiedArchiveDigest !== true) {
        await fs.promises.rm(archivePath, { force: true }).catch(() => {});
        throw new Error(
          'Refusing to extract Game Porting Toolkit archive without a cryptographic SHA-256 digest.'
        );
      }

      if (isDmg) {
        return await installVerifiedDmgRunner(
          {
            dmgPath: archivePath,
            effectiveRunnerType,
            componentId,
            targetAppsDir,
            targetAppPath: existingTargetAppPath,
            existingLayer,
            expectedTeamIds: [],
            expectedVendorAuthorityPattern: null,
            displayLabel: 'Apple Game Porting Toolkit',
            verifyingMessage: 'Verifying Apple Game Porting Toolkit bundle...',
            progressCtx,
            homedir,
            resolvedVersion,
            extraMountOptions: {
              requireGptkBundle: true,
            },
          },
          options
        );
      }

      const stagingDir = path.join(tempDir, 'staging');
      await fs.promises.mkdir(stagingDir, { recursive: true });
      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'extracting',
          message: 'Extracting Apple Game Porting Toolkit archive...',
        },
        options
      );

      if (typeof options.onExtractArchive === 'function') {
        await options.onExtractArchive(archivePath, stagingDir);
      } else {
        await runExecFileAsync(
          execFileFn,
          '/usr/bin/tar',
          ['-xf', archivePath, '-C', stagingDir],
          { timeout: 300000, signal }
        );
      }

      const stagedApp = await findStagedAppBundle(stagingDir);
      if (!stagedApp) {
        throw new Error(
          'Game Porting Toolkit.app was not found inside the downloaded archive.'
        );
      }

      emitEnvironmentSetupProgress(
        {
          ...progressCtx,
          phase: 'verifying_signature',
          message: 'Verifying Apple D3DMetal framework signature and preparing bundle...',
        },
        options
      );
      await verifyAndPrepareStagedGptkApp(stagedApp);

      return await atomicSwapVerifiedApp(
        stagedApp,
        'Apple Game Porting Toolkit',
        resolvedVersion
      );
    }

    throw new Error(`Unsupported compatibility runner type: ${effectiveRunnerType}`);
  } finally {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Maps CrossOver bottle slugs to descriptor objects carrying `wineArch` metadata and filters
 * stale `wizardState.preferredBottleName` when incompatible with `layer.type`.
 *
 * @param {string} homedir
 * @param {any} layer
 * @param {string} bottlesDir
 * @param {string[]} bottleNames
 * @param {any} wizardState
 * @returns {{ mappedBottles: Array<{ name: string, wineArch?: 'win64' | 'arm64', previewEnabled?: boolean, timestamp?: string }>, compatibleWizardBottleName: string | undefined }}
 */
function buildCompatibleCrossOverBottleResolutionInputs(
  homedir,
  layer,
  bottlesDir,
  bottleNames,
  wizardState
) {
  const runnerType = normalizeRequestedRunnerType(layer?.type);
  const isArm64Runner = runnerType === 'crossover_preview_arm64';
  const mappedBottles = (Array.isArray(bottleNames) ? bottleNames : []).map((bName) => {
    const bPath = path.join(bottlesDir, bName);
    const detailMeta = layer?.bottleDetails?.[bName];
    const confMeta = detailMeta || inspectBottleConfMetadata(bPath);
    const resolvedWineArch =
      confMeta?.wineArch || (isValidBottleDirectory(bPath, false) ? 'win64' : undefined);
    return {
      name: bName,
      ...(confMeta || {}),
      ...(resolvedWineArch ? { wineArch: resolvedWineArch } : {}),
    };
  });

  const rawWizardBottle = String(wizardState?.preferredBottleName || '').trim();
  let compatibleWizardBottleName = rawWizardBottle || undefined;
  if (rawWizardBottle) {
    const candidateBottleDirs = Array.from(
      new Set(
        [
          bottlesDir,
          path.join(homedir, 'Library/Application Support/CrossOver/Bottles'),
          path.join(homedir, 'Library/Application Support/CrossOver Preview/Bottles'),
          path.join(homedir, 'Library/Application Support/CrossOver Preview arm64/Bottles'),
        ].filter(Boolean)
      )
    );
    const wizardDetailArch = layer?.bottleDetails?.[rawWizardBottle]?.wineArch;
    if (
      wizardDetailArch &&
      (isArm64Runner ? wizardDetailArch !== 'arm64' : wizardDetailArch === 'arm64')
    ) {
      compatibleWizardBottleName = undefined;
    } else {
      for (const dir of candidateBottleDirs) {
        const candidatePath = path.join(dir, rawWizardBottle);
        if (!fs.existsSync(candidatePath)) continue;
        const meta = inspectBottleConfMetadata(candidatePath);
        const isInit =
          Boolean(meta.wineArch) ||
          fs.existsSync(path.join(candidatePath, 'cxbottle.conf')) ||
          isValidBottleDirectory(candidatePath, false);
        if (!isInit) continue;
        const arch = meta.wineArch || 'win64';
        if (isArm64Runner ? arch !== 'arm64' : arch === 'arm64') {
          compatibleWizardBottleName = undefined;
          break;
        }
      }
    }
    if (compatibleWizardBottleName && wizardState?.preferredRunnerType) {
      const rawSavedPref = String(wizardState.preferredRunnerType).trim().toLowerCase();
      const savedPrefRunner =
        rawSavedPref === 'skip' ? '' : normalizeRequestedRunnerType(rawSavedPref);
      if (
        savedPrefRunner &&
        (savedPrefRunner === 'crossover_preview_arm64') !== isArm64Runner &&
        rawWizardBottle.toLowerCase() ===
          (savedPrefRunner === 'crossover_preview_arm64' ? 'onelauncher-arm64' : 'onelauncher')
      ) {
        compatibleWizardBottleName = undefined;
      }
    }
  }

  return { mappedBottles, compatibleWizardBottleName };
}

/**
 * Resolve active runner and bottle path/name for bottle operations on macOS.
 *
 * @param {string} homedir
 * @param {{ runnerType?: string, bottleName?: string, gameConfigBottleName?: string }} [prefs]
 * @param {Record<string, any>} [options]
 * @returns {{ layer: any, bottleName: string, bottlePath: string }}
 */
function resolveRunnerAndBottleTarget(homedir, prefs = {}, options = {}) {
  const wizardState = getSetupWizardState(options);
  const hostArch = String(options.arch || process.arch || 'arm64').toLowerCase();
  const rawPrefRunner = typeof prefs.runnerType === 'string' ? prefs.runnerType.trim() : '';
  const normalizedPrefRunner = normalizeRequestedRunnerType(rawPrefRunner);
  const hasExplicitAutoPref = Boolean(rawPrefRunner) && normalizedPrefRunner === '';
  const rawWizardRunner =
    wizardState.preferredRunnerType &&
    String(wizardState.preferredRunnerType).trim().toLowerCase() !== 'skip'
      ? wizardState.preferredRunnerType
      : '';
  const normalizedWizardRunner = normalizeRequestedRunnerType(rawWizardRunner);
  const desiredRunner = hasExplicitAutoPref
    ? ''
    : normalizedPrefRunner || normalizedWizardRunner;

  if (desiredRunner === 'crossover_preview_arm64' && hostArch !== 'arm64') {
    throw new Error(
      'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
    );
  }

  if (
    prefs.bottleName !== undefined &&
    prefs.bottleName !== null &&
    String(prefs.bottleName).trim() !== '' &&
    !safeIsBottleSlug(String(prefs.bottleName).trim())
  ) {
    throw new Error(
      `Invalid bottle name "${prefs.bottleName}": must be a safe directory slug without path traversal or leading hyphens.`
    );
  }

  const runners = detectCompatibilityLayers({ ...options, ...explicitHomedirOpt(options) });
  if (runners.length === 0) {
    if (normalizedPrefRunner) {
      throw new Error(`Compatibility runner "${normalizedPrefRunner}" is not installed.`);
    }
    throw new Error(
      'No macOS compatibility runner (CrossOver or Wine) is installed yet. Install a runner first.'
    );
  }

  const matchedDesired = desiredRunner
    ? runners.find((r) => r && (r.type === desiredRunner || r.id === desiredRunner))
    : null;
  if (normalizedPrefRunner && !matchedDesired) {
    throw new Error(`Compatibility runner "${normalizedPrefRunner}" is not installed.`);
  }
  if (normalizedPrefRunner && matchedDesired && matchedDesired.available === false) {
    throw new Error(
      matchedDesired.type === 'crossover_preview_arm64'
        ? 'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
        : `Compatibility runner "${normalizedPrefRunner}" is unavailable on this host.`
    );
  }
  const layer = matchedDesired || runners.find((r) => r.available !== false) || runners[0];
  if (
    layer.type === 'crossover_preview_arm64' &&
    (hostArch !== 'arm64' || layer.available === false)
  ) {
    throw new Error(
      'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
    );
  }

  if (
    layer.type === 'crossover' ||
    layer.type === 'crossover_preview' ||
    layer.type === 'crossover_preview_arm64'
  ) {
    const bottlesDir =
      layer.bottlesDir ||
      path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
    const available = Array.isArray(layer.availableBottles) ? layer.availableBottles : [];
    const { mappedBottles, compatibleWizardBottleName } =
      buildCompatibleCrossOverBottleResolutionInputs(
        homedir,
        layer,
        bottlesDir,
        available,
        wizardState
      );
    const requestedName = resolveDefaultChainedBottleName({
      explicitBottleName: prefs.bottleName,
      gameConfigBottleName: prefs.gameConfigBottleName,
      wizardPreferredBottleName: compatibleWizardBottleName,
      discoveredBottleNames: mappedBottles,
      runnerType: layer.type,
    });
    return {
      layer,
      bottleName: requestedName,
      bottlePath: path.join(bottlesDir, requestedName),
    };
  }

  const prefixSlug =
    prefs.bottleName && safeIsBottleSlug(prefs.bottleName)
      ? prefs.bottleName.trim()
      : normalizedWizardRunner === layer.type &&
          wizardState.preferredBottleName &&
          safeIsBottleSlug(wizardState.preferredBottleName)
        ? wizardState.preferredBottleName
        : 'default';
  return {
    layer,
    bottleName: prefixSlug,
    bottlePath: path.join(homedir, 'Games/OneLauncher/Prefixes', prefixSlug),
  };
}

/**
 * Resolve runner + bottle target for `install_client` bottle tasks and fail fast on invalid
 * bottle slugs, unsupported `crossover_preview_arm64` on non-arm64 hosts, or existing
 * incompatible CrossOver `WineArch` bottles before probing/installing clients.
 *
 * @param {string} homedir
 * @param {{ runnerType?: string, bottleName?: string }} task
 * @param {Record<string, any>} options
 * @returns {{ layer: any, bottleName: string, bottlePath: string }}
 */
function resolveAndValidateBottleClientTarget(homedir, task, options) {
  const hostArch = String(options.arch || process.arch || 'arm64').toLowerCase();
  const normalizedTaskRunner = normalizeRequestedRunnerType(task?.runnerType);
  if (normalizedTaskRunner === 'crossover_preview_arm64' && hostArch !== 'arm64') {
    throw new Error(
      'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
    );
  }
  if (
    task?.bottleName !== undefined &&
    task?.bottleName !== null &&
    String(task.bottleName).trim() !== '' &&
    !safeIsBottleSlug(String(task.bottleName).trim())
  ) {
    throw new Error(
      `Invalid bottle name "${task.bottleName}": must be a safe directory slug without path traversal or leading hyphens.`
    );
  }
  const { layer, bottleName, bottlePath } = resolveRunnerAndBottleTarget(
    homedir,
    { runnerType: task?.runnerType, bottleName: task?.bottleName },
    options
  );
  if (
    layer.type === 'crossover_preview_arm64' &&
    (hostArch !== 'arm64' || layer.available === false)
  ) {
    throw new Error(
      'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
    );
  }
  if (
    layer.type === 'crossover' ||
    layer.type === 'crossover_preview' ||
    layer.type === 'crossover_preview_arm64'
  ) {
    assertRunnerBottleArchCompatible(layer.type, bottleName, bottlePath);
  }
  return { layer, bottleName, bottlePath };
}

/**
 * Resolve Battle.net's background `Agent.exe` inside a Wine/CrossOver bottle.
 *
 * @param {string} bottlePath
 * @param {number} [minBytes=1]
 * @returns {string | null}
 */
function resolveBottleBattleNetAgentExe(bottlePath, minBytes = 1) {
  if (!bottlePath || typeof bottlePath !== 'string') return null;
  const candidate = resolveDriveCPathCaseInsensitive(path.join(bottlePath, 'drive_c'), [
    'ProgramData',
    'Battle.net',
    'Agent',
    'Agent.exe',
  ]);
  if (!candidate) return null;
  try {
    const st = fs.statSync(candidate);
    if (st.isFile() && st.size >= Math.max(1, minBytes)) {
      return candidate;
    }
  } catch {}
  return null;
}

/**
 * Determine whether a Windows or Wine/CrossOver installer exit code indicates a benign success
 * condition (`0`, `3010`, `1641`, `1638` — plus POSIX 8-bit `waitpid` truncations `194`, `105`, `102`).
 *
 * @param {unknown} exitCode
 * @param {boolean} [isWinePosix=false]
 * @returns {boolean}
 */
function isBenignWindowsInstallerExitCode(exitCode, isWinePosix = false) {
  if (exitCode === null || exitCode === undefined || exitCode === '') return false;
  if (typeof exitCode === 'boolean') return false;
  const code = Number(exitCode);
  if (!Number.isFinite(code)) return false;
  if (code === 0 || code === 3010 || code === 1641 || code === 1638) {
    return true;
  }
  if (isWinePosix && (code === 194 || code === 105 || code === 102)) {
    return true;
  }
  return false;
}

/**
 * Spawn an installer inside a CrossOver/Wine bottle and poll until `checkInstalledFn()` resolves
 * to a binary path or `timeoutMs` expires.
 *
 * @param {any} layer
 * @param {string} bottleName
 * @param {string} bottlePath
 * @param {string[]} wineArgs
 * @param {() => string | null} checkInstalledFn
 * @param {Record<string, any>} options
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function runBottleInstallerAndWait(
  layer,
  bottleName,
  bottlePath,
  wineArgs,
  checkInstalledFn,
  options = {},
  signal = undefined
) {
  const timeoutMs = Number(options.clientInstallTimeoutMs || 300000);
  const pollMs = Number(options.bottlePollIntervalMs || (isTestEnvironment(options) ? 40 : 600));
  const minBinaryBytes = Math.max(
    1,
    Number(options.minBinaryBytes ?? (isTestEnvironment(options) ? 1 : 4096))
  );
  const minBinaryStableMs = Math.max(0, Number(options.minBinaryStableMs || 0));
  const companionFilesFn =
    typeof options.companionFilesFn === 'function' ? options.companionFilesFn : null;
  const spawnImpl = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;

  const customEnvOverrides =
    options.wineEnvOverrides && typeof options.wineEnvOverrides === 'object'
      ? options.wineEnvOverrides
      : {};
  const installerDefaultDisablePrefix = options.preserveMscoree ? 'mshtml=d' : 'mscoree,mshtml=d';
  const mergedWineDllOverrides = customEnvOverrides.WINEDLLOVERRIDES
    ? `${installerDefaultDisablePrefix};${customEnvOverrides.WINEDLLOVERRIDES}`
    : `${installerDefaultDisablePrefix};winemenubuilder.exe=d`;

  const isCrossOverLayer =
    layer.type === 'crossover' ||
    layer.type === 'crossover_preview' ||
    layer.type === 'crossover_preview_arm64';
  const sharedCxBottlesDir = path.join(
    options.homedir || os.homedir(),
    'Library/Application Support/CrossOver/Bottles'
  );
  /** @type {Record<string, any>} */
  const env = {
    ...process.env,
    WINEPREFIX: bottlePath,
    ...customEnvOverrides,
    WINEDLLOVERRIDES: mergedWineDllOverrides,
    ...(isCrossOverLayer
      ? {
          CX_BOTTLE: bottleName,
          ...(path.resolve(path.dirname(bottlePath)) !== path.resolve(sharedCxBottlesDir)
            ? { CX_BOTTLE_PATH: path.dirname(bottlePath) }
            : {}),
        }
      : {}),
  };
  alignWineMsyncWithLiveBottle(bottlePath, env);
  prepareCrossOverWineSpawnEnv(layer.binaryPath, env);
  applyCrossOverEnvironmentHygiene(env, {
    wineBinaryPath: layer.binaryPath,
    compatLayer: layer,
    layerType: layer.type,
    homedir: options.homedir,
    platform: 'darwin',
  });

  const isCxPerlWrapper = isCrossOverPerlWineWrapperOptions({
    binaryPath: layer.binaryPath,
    layerType: layer.type,
  });
  const trimmedDllOverrides = String(mergedWineDllOverrides || '').trim();
  const spawnWineArgs =
    isCxPerlWrapper && trimmedDllOverrides && !wineArgs.includes('--dll')
      ? ['--dll', trimmedDllOverrides, ...wineArgs]
      : wineArgs;

  const inspectCandidateStabilityAsync = async () => {
    const found = checkInstalledFn();
    if (!found) return null;
    /** @type {fs.Stats | null} */
    let st = null;
    try {
      st = await fs.promises.stat(found);
    } catch {
      st = null;
    }
    if (!st || !st.isFile() || st.size < minBinaryBytes) return null;
    const parts = [`${found}:${st.size}`];
    if (companionFilesFn) {
      const companions = companionFilesFn();
      if (!Array.isArray(companions)) return null;
      for (const compPath of companions) {
        if (!compPath || typeof compPath !== 'string') return null;
        /** @type {fs.Stats | null} */
        let compStat = null;
        try {
          compStat = await fs.promises.stat(compPath);
        } catch {
          compStat = null;
        }
        if (!compStat || !compStat.isFile() || compStat.size < minBinaryBytes) {
          return null;
        }
        parts.push(`${compPath}:${compStat.size}`);
      }
    }
    return {
      found,
      signature: parts.join('|'),
    };
  };

  if (typeof options.execBottleInstallerFn === 'function') {
    await options.execBottleInstallerFn({
      binaryPath: layer.binaryPath,
      args: wineArgs,
      env,
      bottleName,
      bottlePath,
    });
    const postHookBin = checkInstalledFn();
    if (postHookBin) return postHookBin;
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let pollInFlight = false;
    let hasRealChildPid = false;
    let childExited = false;
    let stableSignature = '';
    let stableSinceMs = 0;
    let stableCandidateHits = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let postExitTimer = null;
    /** @type {any} */
    let child = null;

    const cleanup = () => {
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      if (postExitTimer !== null) {
        clearTimeout(postExitTimer);
        postExitTimer = null;
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const finishOk = (/** @type {string} */ foundPath) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(foundPath);
    };

    const finishErr = (/** @type {Error} */ err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (child && typeof child.kill === 'function') {
        try {
          child.kill('SIGTERM');
        } catch {}
      }
      reject(err);
    };

    const onAbort = () => {
      const abortErr = new Error('Bottle client installation cancelled.');
      abortErr.name = 'AbortError';
      finishErr(abortErr);
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const resolveFoundPathAsync = async () => {
      if (companionFilesFn) {
        const snap = await inspectCandidateStabilityAsync();
        return snap?.found || null;
      }
      return checkInstalledFn();
    };

    const pollTimer = setInterval(() => {
      if (settled || pollInFlight) return;
      pollInFlight = true;
      void (async () => {
        try {
          if (hasRealChildPid && !childExited) {
            if (options.resolveOnBinaryAppear !== true) {
              return;
            }
            const snap = await inspectCandidateStabilityAsync();
            if (settled) return;
            if (!snap) {
              stableSignature = '';
              stableSinceMs = 0;
              stableCandidateHits = 0;
              return;
            }
            const now = Date.now();
            if (snap.signature === stableSignature) {
              stableCandidateHits += 1;
            } else {
              stableSignature = snap.signature;
              stableSinceMs = now;
              stableCandidateHits = 1;
            }
            const elapsedStableMs = stableSinceMs > 0 ? now - stableSinceMs : 0;
            if (stableCandidateHits >= 2 && elapsedStableMs >= minBinaryStableMs) {
              if (child && typeof child.unref === 'function') {
                try {
                  child.unref();
                } catch {}
              }
              finishOk(snap.found);
            }
            return;
          }
          const found = await resolveFoundPathAsync();
          if (!settled && found) {
            finishOk(found);
          }
        } finally {
          pollInFlight = false;
        }
      })();
    }, pollMs);
    if (pollTimer && typeof pollTimer.unref === 'function') {
      pollTimer.unref();
    }

    const timeoutTimer = setTimeout(() => {
      void (async () => {
        const found = await resolveFoundPathAsync();
        if (found) finishOk(found);
        else finishErr(new Error('Timed out waiting for bottled client installer to complete.'));
      })();
    }, timeoutMs);
    if (timeoutTimer && typeof timeoutTimer.unref === 'function') {
      timeoutTimer.unref();
    }

    try {
      child = spawnImpl(layer.binaryPath, spawnWineArgs, {
        env,
        stdio: 'ignore',
      });
      hasRealChildPid = Boolean(child && typeof child.pid === 'number');
      if (!hasRealChildPid || childExited) {
        void (async () => {
          const found = await resolveFoundPathAsync();
          if (!settled && found) {
            finishOk(found);
          }
        })();
      } else if (options.resolveOnBinaryAppear === true) {
        void (async () => {
          const snap = await inspectCandidateStabilityAsync();
          if (!settled && snap) {
            stableSignature = snap.signature;
            stableSinceMs = Date.now();
            stableCandidateHits = 1;
          }
        })();
      }
      if (child && typeof child.on === 'function') {
        child.on('error', (/** @type {any} */ err) => {
          childExited = true;
          void (async () => {
            const found = await resolveFoundPathAsync();
            if (found) finishOk(found);
            else finishErr(err instanceof Error ? err : new Error(String(err)));
          })();
        });
        child.on('exit', (/** @type {number | null} */ code) => {
          childExited = true;
          void (async () => {
            const found = await resolveFoundPathAsync();
            if (found) {
              finishOk(found);
              return;
            }
            if (settled) return;
            const flushGraceMs = Number(
              options.postExitFlushGraceMs ??
                (isTestEnvironment(options) ? Math.max(80, pollMs * 2) : 3000)
            );
            if (postExitTimer !== null) {
              clearTimeout(postExitTimer);
            }
            postExitTimer = setTimeout(() => {
              postExitTimer = null;
              void (async () => {
                const afterFlush = await resolveFoundPathAsync();
                if (afterFlush) {
                  finishOk(afterFlush);
                } else if (code !== null && !isBenignWindowsInstallerExitCode(code, true)) {
                  finishErr(
                    new Error(
                      `Installer exited with code ${code} before client binary was created.`
                    )
                  );
                }
              })();
            }, flushGraceMs);
            if (postExitTimer && typeof postExitTimer.unref === 'function') {
              postExitTimer.unref();
            }
          })();
        });
      }
    } catch (err) {
      finishErr(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Ensure a macOS CrossOver / Wine / GPTK bottle directory is initialized and sandboxed
 * before installing a bottled storefront or publisher client.
 *
 * @param {any} layer
 * @param {string} bottleName
 * @param {string} bottlePath
 * @param {Record<string, any>} [options]
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
async function ensureBottleInitializedInternal(
  layer,
  bottleName,
  bottlePath,
  options = {},
  signal = undefined
) {
  const execFileFn = getExecFileFn(options);
  const isMockHomedir = Boolean(options.homedir || options.customApplicationsDir);

  if (
    layer.type === 'crossover' ||
    layer.type === 'crossover_preview' ||
    layer.type === 'crossover_preview_arm64'
  ) {
    assertRunnerBottleArchCompatible(layer.type, bottleName, bottlePath);
    if (!isValidBottleDirectory(bottlePath, isMockHomedir)) {
      await provisionCrossOverBottleViaCxbottle(
        layer,
        bottleName,
        bottlePath,
        {},
        { ...options, execFileFn },
        signal
      );
      assertRunnerBottleArchCompatible(layer.type, bottleName, bottlePath);
    }
    await ensureCompatibilityLayerReady(layer, { wineBottleName: bottleName }, {}, options);
    sanitizeProvisionedBottleGraphicsBackend(bottlePath);
    await sandboxWinePrefixUserFoldersAsync(bottlePath, options);
    return;
  }

  await fs.promises.mkdir(bottlePath, { recursive: true });
  const sysRegPath = path.join(bottlePath, 'system.reg');
  const sys32Dir = path.join(bottlePath, 'drive_c/windows/system32');

  if (!fs.existsSync(sysRegPath)) {
    const bootEnv = {
      ...process.env,
      WINEPREFIX: bottlePath,
      WINEDLLOVERRIDES: 'mscoree,mshtml=d;winemenubuilder.exe=d',
    };
    const alignedBoot = prepareAlignedAuxBottleWineCommand({
      wineBinary: layer.binaryPath,
      bottlePath,
      env: bootEnv,
      suppressGuiDialogs: true,
      layerType: layer.type,
    });
    try {
      await runExecFileAsync(execFileFn, alignedBoot.binaryPath, ['wineboot', '-u'], {
        timeout: 45000,
        env: alignedBoot.env,
        signal,
      });
    } catch {}

    const initTimeoutMs = Number(
      options.bottleInitTimeoutMs ?? (isTestEnvironment(options) ? 200 : 30000)
    );
    const pollStepMs = isTestEnvironment(options) ? 25 : 250;
    const deadline = Date.now() + initTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) break;
      if (fs.existsSync(sysRegPath) && fs.existsSync(sys32Dir)) break;
      await cancellableSleep(pollStepMs, signal);
    }
  }
  await sandboxWinePrefixUserFoldersAsync(bottlePath, options);
}

/**
 * Download, Authenticode/PKCS#7-verify, silently install, and post-verify a chained publisher
 * launcher (`ubisoft`, `ea`, `bnet`, `rockstar`, `riot`) on Windows host or inside a macOS bottle.
 *
 * @param {{
 *   handoffId: 'ubisoft' | 'ea' | 'bnet' | 'rockstar' | 'riot',
 *   scope: 'host' | 'bottle',
 *   componentId: any,
 *   progressBase: { runId: string, componentId: any, stepIndex: number, totalSteps: number },
 *   tempDir: string,
 *   layer?: any,
 *   bottleName?: string,
 *   bottlePath?: string,
 *   signal?: AbortSignal,
 * }} ctx
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ binaryPath: string, installDir: string }>}
 */
async function provisionVerifiedChainedPublisherClient(ctx, options = {}) {
  const {
    handoffId,
    scope,
    componentId,
    progressBase,
    tempDir,
    layer,
    bottleName = 'OneLauncher',
    bottlePath = '',
    signal,
  } = ctx;

  const ecosystem = CHAINED_PUBLISHER_ECOSYSTEMS[handoffId];
  if (!ecosystem || !ecosystem.installerUrl || !ecosystem.installerFileName) {
    throw new Error(`No verified installer descriptor configured for publisher "${handoffId}".`);
  }

  const stagedExe = path.join(tempDir, ecosystem.installerFileName);
  const minFreeBytes = Math.max(350, (ecosystem.estimatedDownloadMB || 200) * 2) * 1024 * 1024;

  await streamVerifiedDownloadToFile(
    ecosystem.installerUrl,
    stagedExe,
    {
      ...progressBase,
      label: `${ecosystem.displayName} Installer`,
      minFreeBytes,
    },
    options,
    signal
  );

  emitEnvironmentSetupProgress(
    {
      ...progressBase,
      phase: 'verifying_signature',
      message: `Verifying ${ecosystem.displayName} Authenticode signature...`,
    },
    options
  );
  await verifyWindowsInstallerSignature(stagedExe, {
    ...options,
    platform: scope === 'bottle' ? 'darwin' : 'win32',
    kind: 'exe',
    _componentId: componentId,
  });

  if (scope === 'host') {
    const execFileFn = getExecFileFn(options);
    emitEnvironmentSetupProgress(
      {
        ...progressBase,
        phase: 'installing',
        message: `Installing ${ecosystem.displayName} silently...`,
      },
      options
    );
    try {
      await runExecFileAsync(execFileFn, stagedExe, [...(ecosystem.silentArgs || [])], {
        timeout: 300000,
        windowsHide: true,
        signal,
      });
    } catch (/** @type {any} */ execErr) {
      if (!isBenignWindowsInstallerExitCode(execErr?.code, false)) {
        throw execErr;
      }
    }

    const hostProbeOpts = {
      ...options,
      ...explicitHomedirOpt(options),
      platform: 'win32',
    };
    let afterHost = discoverHostPublisherLauncher(handoffId, hostProbeOpts);
    if (!afterHost.installed || !afterHost.binaryPath) {
      const waitMs = Number(
        options.hostPostInstallWaitMs ?? (isTestEnvironment(options) ? 80 : 12000)
      );
      const stepMs = isTestEnvironment(options) ? 20 : 400;
      const deadline = Date.now() + Math.max(0, waitMs);
      while (Date.now() < deadline && (!afterHost.installed || !afterHost.binaryPath)) {
        if (signal?.aborted) break;
        await cancellableSleep(stepMs, signal);
        afterHost = discoverHostPublisherLauncher(handoffId, hostProbeOpts);
      }
    }
    if (!afterHost.installed || !afterHost.binaryPath) {
      throw new Error(
        `${ecosystem.displayName} installer finished, but the launcher executable could not be verified on disk.`
      );
    }
    return {
      binaryPath: afterHost.binaryPath,
      installDir: afterHost.installDir || path.dirname(afterHost.binaryPath),
    };
  }

  if (handoffId === 'bnet' && bottlePath) {
    try {
      upsertWineUserRegKey(
        bottlePath,
        'Software\\Wine\\DllOverrides',
        { 'systemsurvey.exe': '' },
        { skipLiveWineRegSync: true }
      );
    } catch {}
  }

  const bottleTempDir = path.join(bottlePath, 'drive_c/windows/temp');
  await fs.promises.mkdir(bottleTempDir, { recursive: true });
  const bottleSetupExe = path.join(bottleTempDir, ecosystem.installerFileName);
  await fs.promises.copyFile(stagedExe, bottleSetupExe);

  emitEnvironmentSetupProgress(
    {
      ...progressBase,
      phase: 'installing',
      message: `Installing ${ecosystem.displayName} inside bottle "${bottleName}"...`,
    },
    options
  );

  const defaultPublisherStableMs =
    handoffId === 'bnet'
      ? 4000
      : handoffId === 'ubisoft' || handoffId === 'rockstar'
        ? 8000
        : 0;
  const effectiveMinStableMs = Number(
    options.minBinaryStableMs ?? options.bottleBinaryStableMs ?? defaultPublisherStableMs
  );
  const minBytesForCheck = Math.max(
    1,
    Number(options.minBinaryBytes ?? (isTestEnvironment(options) ? 1 : 4096))
  );

  try {
    const installedExe = await runBottleInstallerAndWait(
      layer,
      bottleName,
      bottlePath,
      [`C:\\windows\\temp\\${ecosystem.installerFileName}`, ...(ecosystem.silentArgs || [])],
      () => {
        const probed = discoverBottlePublisherLauncher(bottlePath, handoffId);
        if (!probed.installed || !probed.binaryPath) return null;
        if (handoffId === 'bnet' && !resolveBottleBattleNetAgentExe(bottlePath, minBytesForCheck)) {
          return null;
        }
        return probed.binaryPath;
      },
      {
        ...options,
        resolveOnBinaryAppear: true,
        minBinaryStableMs: effectiveMinStableMs,
        ...(handoffId === 'bnet'
          ? {
              companionFilesFn: () => [
                resolveBottleBattleNetAgentExe(bottlePath, minBytesForCheck),
              ],
            }
          : {}),
        preserveMscoree: Boolean(
          ecosystem.requiresDotNetMscoreeForInstall || options.preserveMscoree
        ),
        wineEnvOverrides: ecosystem.wineEnvOverrides || {},
      },
      signal
    );

    if (bottlePath) {
      sanitizeChainedPublisherAutostartInBottleRegs(bottlePath);
    }

    const afterBottle = discoverBottlePublisherLauncher(bottlePath, handoffId);
    const verifiedBin = (afterBottle.installed && afterBottle.binaryPath) || installedExe;
    if (!verifiedBin || !fs.existsSync(verifiedBin)) {
      throw new Error(
        `${ecosystem.displayName} installer finished, but the launcher executable could not be verified inside bottle "${bottleName}".`
      );
    }
    return {
      binaryPath: verifiedBin,
      installDir: afterBottle.installDir || path.dirname(verifiedBin),
    };
  } finally {
    try {
      await fs.promises.rm(bottleSetupExe, { force: true });
    } catch {}
  }
}

/**
 * Reusable on-demand provisioner for chained publisher launchers (`ubisoft`, `ea`, `bnet`, `rockstar`, `riot`).
 *
 * @param {{
 *   handoffId: string,
 *   platform?: string,
 *   runnerLayer?: any,
 *   bottleName?: string,
 *   bottlePath?: string,
 *   onProgress?: (progress: { percent: number, downloadedBytes: number, totalBytes: number, speedBytesPerSec: number, message: string }) => void,
 *   signal?: AbortSignal,
 * }} params
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ installed: boolean, provisionedNow: boolean, binaryPath: string, installDir: string }>}
 */
async function ensureChainedPublisherLauncherInstalled(params, options = {}) {
  const {
    handoffId,
    platform,
    runnerLayer,
    bottleName,
    bottlePath,
    onProgress,
    signal,
  } = params || {};

  const canonical = normalizeChainedHandoffId(handoffId);
  if (!canonical) {
    throw new Error(`Unsupported chained publisher handoffId: "${String(handoffId || '')}"`);
  }

  const rawPlatform = String(platform || options.platform || process.platform).toLowerCase();
  /** @type {'darwin' | 'win32' | 'linux'} */
  const targetPlatform =
    rawPlatform === 'win32' ? 'win32' : rawPlatform === 'linux' ? 'linux' : 'darwin';

  if (canonical === 'riot' && targetPlatform !== 'win32') {
    if (targetPlatform === 'darwin') {
      throw new Error(
        CHAINED_PUBLISHER_ECOSYSTEMS.riot.unsupportedBottleReason ||
          'Riot Client cannot run inside macOS Wine/CrossOver bottles.'
      );
    }
    throw new Error(
      `Automatic provisioning of ${CHAINED_PUBLISHER_ECOSYSTEMS.riot.displayName} is not supported on platform "${targetPlatform}".`
    );
  }

  const provisionableId = /** @type {'ubisoft' | 'ea' | 'bnet' | 'rockstar' | 'riot'} */ (canonical);
  const ecosystem = CHAINED_PUBLISHER_ECOSYSTEMS[provisionableId];
  const { homedir } = resolveIsolatedHomedirAndUserData(options);
  const hostArch = String(options.arch || options.hostArch || process.arch || 'arm64').toLowerCase();

  const normalizedParamRunnerType = normalizeRequestedRunnerType(runnerLayer?.type);
  const effectiveRunnerLayer =
    runnerLayer && normalizedParamRunnerType && normalizedParamRunnerType !== runnerLayer.type
      ? { ...runnerLayer, type: normalizedParamRunnerType }
      : runnerLayer;

  if (
    targetPlatform === 'darwin' &&
    normalizedParamRunnerType === 'crossover_preview_arm64' &&
    (hostArch !== 'arm64' || effectiveRunnerLayer?.available === false)
  ) {
    throw new Error(
      'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
    );
  }

  if (
    targetPlatform === 'darwin' &&
    typeof bottleName === 'string' &&
    bottleName.trim() !== '' &&
    !safeIsBottleSlug(bottleName.trim())
  ) {
    throw new Error(
      `Invalid bottle name "${bottleName.trim()}": must be a safe directory slug without path traversal or leading hyphens.`
    );
  }

  const resolveExplicitOrWizardBottlePath = () => {
    if (
      targetPlatform === 'darwin' &&
      typeof bottleName === 'string' &&
      bottleName.trim() !== '' &&
      !safeIsBottleSlug(bottleName.trim())
    ) {
      throw new Error(
        `Invalid bottle name "${bottleName.trim()}": must be a safe directory slug without path traversal or leading hyphens.`
      );
    }
    if (typeof bottlePath === 'string' && bottlePath.trim()) {
      const cleanPath = bottlePath.trim();
      const cleanName =
        typeof bottleName === 'string' && bottleName.trim()
          ? bottleName.trim()
          : path.basename(cleanPath);
      let inferredLayerType = normalizedParamRunnerType;
      if (!inferredLayerType && targetPlatform === 'darwin') {
        try {
          inferredLayerType = resolveRunnerAndBottleTarget(
            homedir,
            { runnerType: undefined, bottleName: cleanName },
            options
          )?.layer?.type;
        } catch (/** @type {any} */ inferErr) {
          const inferMsg = String(inferErr?.message || inferErr || '');
          if (/Apple Silicon|unsupported on Intel|Invalid bottle name/i.test(inferMsg)) {
            throw inferErr;
          }
        }
      }
      return { bottleName: cleanName, bottlePath: cleanPath, layerType: inferredLayerType };
    }
    const explicitRunnerBin = String(
      effectiveRunnerLayer?.binaryPath || effectiveRunnerLayer?.path || ''
    ).trim();
    if (effectiveRunnerLayer && explicitRunnerBin) {
      const wizardState = getSetupWizardState(options);
      if (
        normalizedParamRunnerType === 'crossover' ||
        normalizedParamRunnerType === 'crossover_preview' ||
        normalizedParamRunnerType === 'crossover_preview_arm64'
      ) {
        const bottlesDir =
          effectiveRunnerLayer.bottlesDir ||
          path.join(homedir, 'Library/Application Support/CrossOver/Bottles');
        let discoveredBottles = Array.isArray(effectiveRunnerLayer.availableBottles)
          ? effectiveRunnerLayer.availableBottles
          : [];
        if (discoveredBottles.length === 0 && fs.existsSync(bottlesDir)) {
          try {
            discoveredBottles = fs
              .readdirSync(bottlesDir, { withFileTypes: true })
              .filter((d) => d.isDirectory() && safeIsBottleSlug(d.name))
              .map((d) => d.name);
          } catch {}
        }
        const { mappedBottles, compatibleWizardBottleName } =
          buildCompatibleCrossOverBottleResolutionInputs(
            homedir,
            effectiveRunnerLayer,
            bottlesDir,
            discoveredBottles,
            wizardState
          );
        const resolvedName = resolveDefaultChainedBottleName({
          explicitBottleName: bottleName,
          wizardPreferredBottleName: compatibleWizardBottleName,
          discoveredBottleNames: mappedBottles,
          runnerType: normalizedParamRunnerType,
        });
        return {
          bottleName: resolvedName,
          bottlePath: path.join(bottlesDir, resolvedName),
          layerType: normalizedParamRunnerType,
        };
      }
      const normalizedWizardPrefRunner = normalizeRequestedRunnerType(
        wizardState.preferredRunnerType === 'skip' ? '' : wizardState.preferredRunnerType
      );
      const prefixSlug =
        bottleName && safeIsBottleSlug(bottleName)
          ? bottleName.trim()
          : normalizedWizardPrefRunner === normalizedParamRunnerType &&
              wizardState.preferredBottleName &&
              safeIsBottleSlug(wizardState.preferredBottleName)
            ? wizardState.preferredBottleName
            : 'default';
      return {
        bottleName: prefixSlug,
        bottlePath: path.join(homedir, 'Games/OneLauncher/Prefixes', prefixSlug),
        layerType: normalizedParamRunnerType,
      };
    }
    const resolvedTarget = resolveRunnerAndBottleTarget(
      homedir,
      { runnerType: effectiveRunnerLayer?.type, bottleName },
      options
    );
    return {
      bottleName: resolvedTarget.bottleName,
      bottlePath: resolvedTarget.bottlePath,
      layerType: resolvedTarget.layer?.type,
    };
  };

  const validateDarwinRunnerAndBottlePrecheck = () => {
    let checkBottleName = '';
    let checkBottlePath = '';
    let effectiveLayerType = normalizedParamRunnerType;
    try {
      const resolvedCheck = resolveExplicitOrWizardBottlePath();
      checkBottleName = resolvedCheck.bottleName;
      checkBottlePath = resolvedCheck.bottlePath;
      if (!effectiveLayerType && resolvedCheck.layerType) {
        effectiveLayerType = resolvedCheck.layerType;
      }
    } catch (/** @type {any} */ resolveErr) {
      const msg = String(resolveErr?.message || resolveErr || '');
      if (
        /Apple Silicon|unsupported on Intel|Invalid bottle name|Compatibility runner .* is (?:not installed|unavailable)/i.test(
          msg
        ) ||
        (normalizedParamRunnerType && /not installed/i.test(msg))
      ) {
        throw resolveErr;
      }
    }
    if (effectiveLayerType === 'crossover_preview_arm64' && hostArch !== 'arm64') {
      throw new Error(
        'CrossOver Preview (arm64 / FEX) requires an Apple Silicon (arm64) Mac and is unsupported on Intel x86_64 Macs.'
      );
    }
    if (
      (effectiveLayerType === 'crossover' ||
        effectiveLayerType === 'crossover_preview' ||
        effectiveLayerType === 'crossover_preview_arm64') &&
      checkBottlePath
    ) {
      assertRunnerBottleArchCompatible(effectiveLayerType, checkBottleName, checkBottlePath);
    }
    return { checkBottleName, checkBottlePath, effectiveLayerType };
  };

  if (!options.forceReinstall) {
    if (targetPlatform === 'darwin') {
      const { checkBottlePath } = validateDarwinRunnerAndBottlePrecheck();
      if (checkBottlePath) {
        const existingBottle = discoverBottlePublisherLauncher(checkBottlePath, provisionableId);
        if (existingBottle.installed && existingBottle.binaryPath) {
          return {
            installed: true,
            provisionedNow: false,
            binaryPath: existingBottle.binaryPath,
            installDir: existingBottle.installDir || path.dirname(existingBottle.binaryPath),
          };
        }
      }
    } else if (targetPlatform === 'win32') {
      const existingHost = discoverHostPublisherLauncher(provisionableId, {
        ...options,
        ...explicitHomedirOpt(options),
        platform: 'win32',
      });
      if (existingHost.installed && existingHost.binaryPath) {
        return {
          installed: true,
          provisionedNow: false,
          binaryPath: existingHost.binaryPath,
          installDir: existingHost.installDir || path.dirname(existingHost.binaryPath),
        };
      }
    }
  }

  if (signal?.aborted) {
    const abortErr = new Error('Publisher launcher installation cancelled.');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  if (typeof options.provisionChainedLauncherFn === 'function') {
    const injectedRes = await options.provisionChainedLauncherFn(
      {
        handoffId: provisionableId,
        platform: targetPlatform,
        runnerLayer,
        bottleName,
        bottlePath,
        onProgress,
        signal,
      },
      options
    );
    const bin = String(injectedRes?.binaryPath || '').trim();
    const dir = String(injectedRes?.installDir || (bin ? path.dirname(bin) : '')).trim();
    return {
      installed: injectedRes?.installed !== false,
      provisionedNow: injectedRes?.provisionedNow !== false,
      binaryPath: bin,
      installDir: dir,
    };
  }

  if (options.forceReinstall && targetPlatform === 'darwin') {
    validateDarwinRunnerAndBottlePrecheck();
  }

  if (options.skipNetwork === true && typeof options.fetchFn !== 'function') {
    throw new Error(
      `${ecosystem.displayName} is not installed and network provisioning is disabled (skipNetwork: true).`
    );
  }

  if (targetPlatform !== 'darwin' && targetPlatform !== 'win32') {
    throw new Error(
      `Automatic provisioning of ${ecosystem.displayName} is not supported on platform "${targetPlatform}".`
    );
  }

  const scope = targetPlatform === 'darwin' ? 'bottle' : 'host';
  const componentId = /** @type {import('./installerNetworkAndGuardrails.cjs').EnvironmentComponentId} */ (
    scope === 'bottle' ? ecosystem.bottleComponentId : ecosystem.hostComponentId
  );
  const runId = `chained-pub-${provisionableId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  let prevBytes = 0;
  let prevTickAt = Date.now();
  let lastSpeedBytesPerSec = 0;

  const emitProgressCallback = (
    /** @type {{ percent: number, downloadedBytes: number, totalBytes: number, speedBytesPerSec: number, message: string }} */ info
  ) => {
    if (typeof onProgress === 'function') {
      try {
        onProgress(info);
      } catch {}
    }
  };

  const unsubscribeProgress = onEnvironmentSetupProgress((ev) => {
    if (ev.runId !== runId) return;
    const now = Date.now();
    const dlBytes = typeof ev.bytesDownloaded === 'number' ? ev.bytesDownloaded : prevBytes;
    const totBytes = typeof ev.totalBytes === 'number' ? ev.totalBytes : 0;
    const dtSec = (now - prevTickAt) / 1000;
    if (ev.phase === 'downloading' && dlBytes > prevBytes && dtSec > 0.02) {
      const instantSpeed = Math.round((dlBytes - prevBytes) / dtSec);
      lastSpeedBytesPerSec =
        lastSpeedBytesPerSec > 0
          ? Math.round(lastSpeedBytesPerSec * 0.65 + instantSpeed * 0.35)
          : instantSpeed;
      prevBytes = dlBytes;
      prevTickAt = now;
    }

    let pct = typeof ev.progressPercent === 'number' ? ev.progressPercent : 0;
    if (ev.phase === 'downloading') {
      pct =
        typeof ev.progressPercent === 'number'
          ? Math.min(78, Math.max(5, Math.round(5 + ev.progressPercent * 0.73)))
          : 25;
    } else if (ev.phase === 'verifying_signature') {
      pct = 82;
      lastSpeedBytesPerSec = 0;
    } else if (ev.phase === 'installing') {
      pct = 90;
      lastSpeedBytesPerSec = 0;
    } else if (ev.phase === 'completed') {
      pct = 100;
      lastSpeedBytesPerSec = 0;
    }

    emitProgressCallback({
      percent: pct,
      downloadedBytes: dlBytes,
      totalBytes: totBytes,
      speedBytesPerSec: ev.phase === 'downloading' ? lastSpeedBytesPerSec : 0,
      message: ev.message,
    });
  });

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ol-chained-pub-'));
  try {
    /** @type {any} */
    let effectiveLayer = null;
    let effectiveBottleName = '';
    let effectiveBottlePath = '';

    if (targetPlatform === 'darwin') {
      if ((options.arch || process.arch) === 'arm64') {
        await ensureRosetta2InBackground({ ...options, signal });
      }

      const explicitRunnerBin = String(
        effectiveRunnerLayer?.binaryPath || effectiveRunnerLayer?.path || ''
      ).trim();
      if (effectiveRunnerLayer && explicitRunnerBin) {
        effectiveLayer = {
          ...effectiveRunnerLayer,
          binaryPath: explicitRunnerBin,
        };
        const resolvedBottle = resolveExplicitOrWizardBottlePath();
        effectiveBottleName = resolvedBottle.bottleName;
        effectiveBottlePath = resolvedBottle.bottlePath;
      } else {
        const resolved = resolveRunnerAndBottleTarget(
          homedir,
          { runnerType: effectiveRunnerLayer?.type, bottleName },
          options
        );
        effectiveLayer = resolved.layer;
        effectiveBottleName =
          typeof bottleName === 'string' && safeIsBottleSlug(bottleName)
            ? bottleName.trim()
            : resolved.bottleName;
        effectiveBottlePath =
          typeof bottlePath === 'string' && bottlePath.trim()
            ? bottlePath.trim()
            : resolved.bottlePath;
      }

      const isMockHomedir = Boolean(options.homedir || options.customApplicationsDir);
      if (!isValidBottleDirectory(effectiveBottlePath, isMockHomedir)) {
        emitProgressCallback({
          percent: 3,
          downloadedBytes: 0,
          totalBytes: 0,
          speedBytesPerSec: 0,
          message: `Initializing Windows bottle "${effectiveBottleName}"...`,
        });
      }
      await ensureBottleInitializedInternal(
        effectiveLayer,
        effectiveBottleName,
        effectiveBottlePath,
        options,
        signal
      );

      if (!options.forceReinstall) {
        const postInitProbe = discoverBottlePublisherLauncher(effectiveBottlePath, provisionableId);
        if (postInitProbe.installed && postInitProbe.binaryPath) {
          return {
            installed: true,
            provisionedNow: false,
            binaryPath: postInitProbe.binaryPath,
            installDir: postInitProbe.installDir || path.dirname(postInitProbe.binaryPath),
          };
        }
      }
    }

    const provisioned = await provisionVerifiedChainedPublisherClient(
      {
        handoffId: provisionableId,
        scope,
        componentId,
        progressBase: {
          runId,
          componentId,
          stepIndex: 0,
          totalSteps: 1,
        },
        tempDir,
        layer: effectiveLayer,
        bottleName: effectiveBottleName,
        bottlePath: effectiveBottlePath,
        signal,
      },
      options
    );

    try {
      saveSetupWizardState(
        {
          addConfiguredComponents: [componentId],
          lastHealthCheckAt: new Date().toISOString(),
        },
        options
      );
    } catch {}
    invalidateScanCaches({ skipPreviewUrlCacheClear: true });

    emitProgressCallback({
      percent: 100,
      downloadedBytes: prevBytes,
      totalBytes: prevBytes,
      speedBytesPerSec: 0,
      message: `${ecosystem.displayName} is installed and ready.`,
    });

    return {
      installed: true,
      provisionedNow: true,
      binaryPath: provisioned.binaryPath,
      installDir: provisioned.installDir,
    };
  } finally {
    unsubscribeProgress();
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

module.exports = {
  registerExternalRunnerDetectors,
  CODEWEAVERS_PRIMARY_TEAM_IDS,
  CODEWEAVERS_ADDITIONAL_TEAM_IDS,
  CODEWEAVERS_VENDOR_AUTHORITY_RE,
  isRosetta2InstalledFast,
  ensureRosetta2InBackground,
  installRunnerDirect,
  buildCompatibleCrossOverBottleResolutionInputs,
  resolveRunnerAndBottleTarget,
  resolveAndValidateBottleClientTarget,
  resolveBottleBattleNetAgentExe,
  isBenignWindowsInstallerExitCode,
  runBottleInstallerAndWait,
  ensureBottleInitializedInternal,
  provisionVerifiedChainedPublisherClient,
  ensureChainedPublisherLauncherInstalled,
};
