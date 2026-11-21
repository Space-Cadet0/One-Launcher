// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  isTestEnvironment,
  resolveIsolatedHomedirAndUserData,
  invalidateScanCaches,
  clearMacQuarantineAsync,
  activeSessions,
  pendingBottleLaunches,
  macCodesignValidCache,
  evictExecutableDiscoveryCacheForPath,
} = require('../engineStateRegistry.cjs');
const macNativeInstallerAndCodesign = /** @type {any} */ (
  require('../macNativeInstallerAndCodesign.cjs')
);
const {
  ensureMacExecutablePermissions,
  resolveWineserverBinary,
  shutdownWinePrefix,
  recordRunnerInstallReceipt,
} = macNativeInstallerAndCodesign;
const {
  normalizeRequestedRunnerType,
  formatRunnerDisplayLabel,
  emitEnvironmentSetupProgress,
  getExecFileFn,
  runExecFileAsync,
} = require('./installerNetworkAndGuardrails.cjs');
const {
  findEmbeddedD3DMetalFramework,
  verifyAppleSignedFramework,
  verifyMacAppDeveloperSignature,
} = require('./artifactSignatureVerifier.cjs');

/** @type {(appPath: string | null | undefined) => string | null} */
let registeredDetectExternalRunnerManagerName = () => null;

/**
 * Register the facade-owned external runner-manager detector so `macAppBundleInstaller`
 * preserves the GPL clean-room allowlist without copying options objects.
 *
 * @param {(appPath: string | null | undefined) => string | null} fn
 */
function registerExternalRunnerManagerDetector(fn) {
  if (typeof fn === 'function') {
    registeredDetectExternalRunnerManagerName = fn;
  }
}

/**
 * Per-target-`.app` async mutex chains so concurrent installs/updates targeting the same
 * bundle path serialize cleanly instead of racing on `.ol-staging-*` / `.ol-backup-*`.
 *
 * @type {Map<string, Promise<void>>}
 */
const perAppReplaceLocks = new Map();

/**
 * Track currently active staging suffixes so orphan sweeps never touch an in-flight suffix.
 *
 * @type {Set<string>}
 */
const activeStagingSuffixes = new Set();

/**
 * Run `fn` while holding an exclusive per-path async lock keyed by `path.resolve(targetPath)`.
 *
 * @template T
 * @param {string} targetPath
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withPerAppReplaceLock(targetPath, fn) {
  const lockKey = path.resolve(String(targetPath || ''));
  const prevTail = perAppReplaceLocks.get(lockKey) || Promise.resolve();
  /** @type {() => void} */
  let releaseCurrent = () => {};
  const currentGate = new Promise((resolve) => {
    releaseCurrent = () => resolve(undefined);
  });
  const nextTail = prevTail.catch(() => {}).then(() => currentGate);
  perAppReplaceLocks.set(lockKey, nextTail);

  await prevTail.catch(() => {});
  try {
    return await fn();
  } finally {
    releaseCurrent();
    if (perAppReplaceLocks.get(lockKey) === nextTail) {
      perAppReplaceLocks.delete(lockKey);
    }
  }
}

/**
 * Throw a structured runner-busy Error preserving `busyCode`.
 *
 * @param {{ ok: boolean, busyCode?: string, error?: string }} safeRes
 */
function throwIfRunnerBusy(safeRes) {
  if (safeRes && safeRes.ok === false) {
    const err = /** @type {Error & { busyCode?: string }} */ (
      new Error(safeRes.error || 'Compatibility runner is currently busy.')
    );
    if (safeRes.busyCode) {
      err.busyCode = safeRes.busyCode;
    }
    throw err;
  }
}

/**
 * Resolve writable target macOS Applications directory (`'/Applications'` when writable,
 * else `'~/Applications'`, or `options.customApplicationsDir`).
 *
 * @param {string} homedir
 * @param {Record<string, any>} options
 * @returns {Promise<string>}
 */
async function resolveTargetMacApplicationsDir(homedir, options = {}) {
  if (typeof options.customApplicationsDir === 'string' && options.customApplicationsDir.trim()) {
    return options.customApplicationsDir.trim();
  }
  if (typeof options.hasWriteAccessToSystemApplications === 'boolean') {
    return options.hasWriteAccessToSystemApplications
      ? '/Applications'
      : path.join(homedir, 'Applications');
  }
  if (options.homedir) {
    return path.join(homedir, 'Applications');
  }
  try {
    await fs.promises.access('/Applications', fs.constants.W_OK);
    return '/Applications';
  } catch {
    return path.join(homedir, 'Applications');
  }
}

/**
 * Inspect `activeSessions`, `pendingBottleLaunches`, and live OS processes executing from inside
 * `targetAppPath` BEFORE replacing a compatibility runner `.app` bundle.
 *
 * @param {string} runnerType
 * @param {string | null | undefined} targetAppPath
 * @param {any} [existingLayer]
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ ok: boolean, busyCode?: 'RUNNER_BUSY_ACTIVE_SESSION' | 'RUNNER_BUSY_EXTERNAL_PROCESS', error?: string }>}
 */
async function assertRunnerSafeToReplace(
  runnerType,
  targetAppPath,
  existingLayer = null,
  options = {}
) {
  const cleanRunnerType = normalizeRequestedRunnerType(runnerType) || 'crossover';
  const runnerLabel = formatRunnerDisplayLabel(cleanRunnerType, existingLayer);
  const hostPlatform = String(options.platform || process.platform);
  const detectExternalMgr =
    typeof options.detectExternalRunnerManagerNameFn === 'function'
      ? options.detectExternalRunnerManagerNameFn
      : registeredDetectExternalRunnerManagerName;
  const externalExistingMgr =
    detectExternalMgr(existingLayer?.appPath) || detectExternalMgr(existingLayer?.binaryPath);
  const effectiveAppPath = String(
    targetAppPath || (!externalExistingMgr ? existingLayer?.appPath : '') || ''
  )
    .trim()
    .replace(/\/+$/, '');
  const appPrefix = effectiveAppPath ? `${effectiveAppPath}/` : '';

  // 1. Check active One Launcher bottled sessions
  for (const [gameId, entry] of activeSessions.entries()) {
    if (!entry || entry.finalized === true) continue;
    const rawSessLayer = String(
      entry.session?.compatibilityLayer || entry.compatibilityLayer || ''
    )
      .trim()
      .toLowerCase();
    const sessLayer = normalizeRequestedRunnerType(rawSessLayer);
    const wineBin = String(entry.wineBinary || '').trim();
    const winePrefix = String(entry.winePrefix || '').trim();
    const isBottledSession = Boolean(
      wineBin ||
        winePrefix ||
        entry.launchedViaBottleSteam ||
        (rawSessLayer && rawSessLayer !== 'native')
    );
    const matchesTargetRunner =
      (hostPlatform === 'darwin' && isBottledSession) ||
      sessLayer === cleanRunnerType ||
      Boolean(appPrefix && wineBin.startsWith(appPrefix));

    if (matchesTargetRunner) {
      const gameTitle = String(
        entry.session?.title || entry.title || entry.session?.gameTitle || gameId || 'a game'
      ).trim();
      return {
        ok: false,
        busyCode: 'RUNNER_BUSY_ACTIVE_SESSION',
        error: `Cannot update ${runnerLabel} while "${gameTitle}" is running. Close the game and try again.`,
      };
    }
  }

  // 2. Check pending bottle launches in flight
  for (const [prefixPath, pendingCount] of pendingBottleLaunches.entries()) {
    if (Number(pendingCount) > 0 && hostPlatform === 'darwin') {
      const bottleLabel = path.basename(String(prefixPath || 'bottle')) || 'a game';
      return {
        ok: false,
        busyCode: 'RUNNER_BUSY_ACTIVE_SESSION',
        error: `Cannot update ${runnerLabel} while "${bottleLabel}" is running. Close the game and try again.`,
      };
    }
  }

  // 3. Inspect live OS processes executing from inside the target `.app` bundle
  if (!appPrefix || options.skipProcessCheck === true) {
    return { ok: true };
  }

  const readProcessListOutput = async () => {
    if (typeof options.getProcessListOutput === 'function') {
      return String((await options.getProcessListOutput()) || '');
    }
    if (typeof options.mockProcessListOutput === 'string') {
      return options.mockProcessListOutput;
    }
    if (hostPlatform !== 'darwin') {
      return '';
    }
    try {
      await fs.promises.access(effectiveAppPath, fs.constants.F_OK);
    } catch {
      return '';
    }
    try {
      const execFileFn = getExecFileFn(options);
      const psRes = await runExecFileAsync(
        execFileFn,
        '/bin/ps',
        ['-ax', '-o', 'pid=,command='],
        { timeout: 5000 }
      );
      return psRes.stdout || '';
    } catch {
      return '';
    }
  };

  /**
   * @param {string} rawPsOutput
   */
  const classifyMatchingProcesses = (rawPsOutput) => {
    /** @type {Array<{ pid: number, command: string }>} */
    const matched = [];
    for (const rawLine of String(rawPsOutput || '').split(/\r?\n/)) {
      const m = rawLine.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number.parseInt(m[1], 10);
      const command = m[2].trim();
      if (!pid || pid === process.pid) continue;
      if (command.includes(appPrefix)) {
        matched.push({ pid, command });
      }
    }

    let hasGuiOrExternalApp = false;
    let hasIdleWineserverOrDaemon = false;
    const idleDaemonRe =
      /(?:^|[\\/ ])(?:wineserver(?:-arm64|-x86|64)?|services\.exe|plugplay\.exe|svchost\.exe|rpcss\.exe|winedevice\.exe|explorer\.exe|conhost\.exe|tabtip\.exe)(?:\s|$|")/i;

    for (const proc of matched) {
      const cmdAfterApp = proc.command.slice(proc.command.indexOf(appPrefix) + appPrefix.length);
      const macOsBinMatch = cmdAfterApp.match(/^Contents\/MacOS\/([^\s"]+)/i);
      if (macOsBinMatch) {
        const macBinName = macOsBinMatch[1];
        if (!/^wine(?:64)?(?:-preloader|server(?:64|-arm64|-x86)?)?$/i.test(macBinName)) {
          hasGuiOrExternalApp = true;
          continue;
        }
      }
      if (idleDaemonRe.test(proc.command)) {
        hasIdleWineserverOrDaemon = true;
      } else {
        hasGuiOrExternalApp = true;
      }
    }

    return { matched, hasGuiOrExternalApp, hasIdleWineserverOrDaemon };
  };

  const initialPs = classifyMatchingProcesses(await readProcessListOutput());
  if (initialPs.matched.length === 0) {
    return { ok: true };
  }

  if (initialPs.hasGuiOrExternalApp) {
    return {
      ok: false,
      busyCode: 'RUNNER_BUSY_EXTERNAL_PROCESS',
      error: `Please quit ${runnerLabel} before installing the update.`,
    };
  }

  if (initialPs.hasIdleWineserverOrDaemon) {
    const { homedir } = resolveIsolatedHomedirAndUserData(options);
    /** @type {Set<string>} */
    const candidatePrefixes = new Set();
    if (existingLayer?.bottlesDir && Array.isArray(existingLayer?.availableBottles)) {
      for (const bName of existingLayer.availableBottles) {
        candidatePrefixes.add(path.join(existingLayer.bottlesDir, bName));
      }
    }
    const customCxBottleRoots = [options.cxBottlePath, process.env.CX_BOTTLE_PATH]
      .filter((v) => typeof v === 'string' && v.trim())
      .flatMap((v) =>
        String(v)
          .split(path.delimiter)
          .map((s) => s.trim())
          .filter(Boolean)
      );
    for (const bottlesParent of Array.from(
      new Set([
        path.join(homedir, 'Library/Application Support/CrossOver/Bottles'),
        path.join(homedir, 'Library/Application Support/CrossOver Preview/Bottles'),
        path.join(homedir, 'Library/Application Support/CrossOver Preview arm64/Bottles'),
        path.join(homedir, 'Games/OneLauncher/Prefixes'),
        ...customCxBottleRoots,
      ])
    )) {
      try {
        const entries = await fs.promises.readdir(bottlesParent, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.isDirectory() && !ent.name.startsWith('.')) {
            candidatePrefixes.add(path.join(bottlesParent, ent.name));
          }
        }
      } catch {}
    }

    const execFileFn = getExecFileFn(options);
    const shutdownWineBin =
      existingLayer?.wineserverBinary ||
      existingLayer?.binaryPath ||
      path.join(effectiveAppPath, 'Contents/SharedSupport/CrossOver/bin/wine');
    for (const prefixDir of candidatePrefixes) {
      try {
        await shutdownWinePrefix(shutdownWineBin, prefixDir, 3000, {
          bottleName: path.basename(prefixDir),
          cxBottlePath: path.dirname(prefixDir),
          layerType: cleanRunnerType,
          execFileFn,
        });
      } catch {}
    }
    const cxBinDir = path.join(effectiveAppPath, 'Contents/SharedSupport/CrossOver/bin');
    const candidateWsBins = Array.from(
      new Set(
        [
          existingLayer?.wineserverBinary,
          resolveWineserverBinary(existingLayer?.binaryPath, { layerType: cleanRunnerType }),
          path.join(cxBinDir, 'wineserver'),
          path.join(cxBinDir, 'wineserver64'),
          path.join(cxBinDir, 'wineserver-arm64'),
          path.join(cxBinDir, 'wineserver-x86'),
        ].filter((p) => typeof p === 'string' && p.trim())
      )
    );
    for (const wsBin of candidateWsBins) {
      try {
        await fs.promises.access(wsBin, fs.constants.F_OK);
        await runExecFileAsync(execFileFn, wsBin, ['-k'], {
          timeout: 4000,
        });
      } catch {}
    }

    if (
      typeof options.getProcessListOutput === 'function' ||
      (!options.mockProcessListOutput && hostPlatform === 'darwin')
    ) {
      const settleMs = isTestEnvironment(options) ? 15 : 150;
      await new Promise((r) => setTimeout(r, settleMs));
      const recheckPs = classifyMatchingProcesses(await readProcessListOutput());
      if (recheckPs.matched.length > 0) {
        return {
          ok: false,
          busyCode: 'RUNNER_BUSY_EXTERNAL_PROCESS',
          error: `Please quit ${runnerLabel} before installing the update.`,
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Evict cached codesign and executable discovery entries for a replaced macOS `.app` bundle.
 *
 * @param {string} targetAppPath
 */
function evictMacAppCachesForPath(targetAppPath) {
  if (!targetAppPath) return;
  const normalized = path.resolve(targetAppPath);
  const slashPrefix = `${normalized}/`;
  for (const key of Array.from(macCodesignValidCache.keys())) {
    const kStr = String(key);
    if (kStr === normalized || kStr === targetAppPath || kStr.startsWith(slashPrefix)) {
      macCodesignValidCache.delete(key);
    }
  }
  evictExecutableDiscoveryCacheForPath(targetAppPath);
}

/**
 * Atomically stage, quarantine-strip, codesign-verify, and swap a macOS `.app` bundle into
 * `targetDestAppPath` on the destination volume (`O(1)` POSIX `rename(2)` with `.ol-backup` rollback).
 * Serialized by a per-`targetDestAppPath` async mutex and scoped staging/backup cleanup so concurrent
 * installs never collide or delete another active run's staging directory.
 *
 * @param {string} stagedAppPath
 * @param {string} targetDestAppPath
 * @param {Record<string, any>} [options]
 * @returns {Promise<string>}
 */
async function atomicReplaceMacAppBundle(stagedAppPath, targetDestAppPath, options = {}) {
  return withPerAppReplaceLock(targetDestAppPath, async () => {
    const parentDir = path.dirname(targetDestAppPath);
    const appName = path.basename(targetDestAppPath);
    const signal = /** @type {AbortSignal | undefined} */ (options.signal);
    if (signal?.aborted) {
      const abortErr = new Error(`Installation of ${appName} cancelled.`);
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    await fs.promises.mkdir(parentDir, { recursive: true });

    let destinationExists = false;
    try {
      await fs.promises.lstat(targetDestAppPath);
      destinationExists = true;
    } catch {}

    try {
      await fs.promises.access(parentDir, fs.constants.W_OK | fs.constants.X_OK);
    } catch (accessErr) {
      throw new Error(
        `Cannot install ${appName}: write permission denied on "${parentDir}" (${accessErr instanceof Error ? accessErr.message : String(accessErr)}).`
      );
    }
    if (destinationExists) {
      try {
        await fs.promises.access(targetDestAppPath, fs.constants.W_OK);
      } catch (targetAccessErr) {
        throw new Error(
          `Cannot replace existing "${targetDestAppPath}": write/rename permission denied (${targetAccessErr instanceof Error ? targetAccessErr.message : String(targetAccessErr)}).`
        );
      }
    }

    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const siblingStagingPath = path.join(parentDir, `.${appName}.ol-staging-${suffix}`);
    const backupPath = path.join(parentDir, `.${appName}.ol-backup-${suffix}`);
    const execFileFn = getExecFileFn(options);
    let movedExistingToBackup = false;
    activeStagingSuffixes.add(suffix);

    try {
      if (typeof options.onExecDitto === 'function') {
        await options.onExecDitto(stagedAppPath, siblingStagingPath);
        if (fs.existsSync(stagedAppPath) && !fs.existsSync(siblingStagingPath)) {
          await fs.promises.cp(stagedAppPath, siblingStagingPath, {
            recursive: true,
            force: true,
            verbatimSymlinks: true,
          });
        }
      } else {
        const canUseDitto =
          (process.platform === 'darwin' && fs.existsSync('/usr/bin/ditto')) ||
          typeof options.execFileFn === 'function' ||
          typeof options.execFileImpl === 'function';
        if (canUseDitto) {
          await runExecFileAsync(
            execFileFn,
            '/usr/bin/ditto',
            [stagedAppPath, siblingStagingPath],
            { timeout: 300000, signal }
          );
        }
        if (fs.existsSync(stagedAppPath) && !fs.existsSync(siblingStagingPath)) {
          await fs.promises.cp(stagedAppPath, siblingStagingPath, {
            recursive: true,
            force: true,
            verbatimSymlinks: true,
          });
        }
      }

      ensureMacExecutablePermissions(siblingStagingPath);
      await clearMacQuarantineAsync(siblingStagingPath, { ...options, force: true });

      const shouldVerifyStagingCodesign =
        options.skipStagingCodesignVerify !== true &&
        typeof options.verifySignatureFn !== 'function' &&
        fs.existsSync(siblingStagingPath) &&
        ((process.platform === 'darwin' && fs.existsSync('/usr/bin/codesign')) ||
          typeof options.execFileFn === 'function' ||
          typeof options.execFileImpl === 'function');

      if (shouldVerifyStagingCodesign) {
        if (options.prepareUnsignedWineBundle === true) {
          try {
            await runExecFileAsync(
              execFileFn,
              '/usr/bin/codesign',
              ['--verify', '--deep', '--strict', siblingStagingPath],
              { timeout: 60000, signal }
            );
          } catch (verifyErr) {
            const errDetail = `${String(verifyErr?.stderr || '')} ${String(verifyErr?.message || '')}`;
            if (/not signed at all/i.test(errDetail)) {
              await runExecFileAsync(
                execFileFn,
                '/usr/bin/codesign',
                ['--force', '--deep', '-s', '-', siblingStagingPath],
                { timeout: 180000, signal }
              );
            } else {
              throw verifyErr;
            }
          }
        }
        await runExecFileAsync(
          execFileFn,
          '/usr/bin/codesign',
          ['--verify', '--deep', '--strict', siblingStagingPath],
          { timeout: 60000, signal }
        );
      }

      if (signal?.aborted) {
        const abortErr = new Error(`Installation of ${appName} cancelled.`);
        abortErr.name = 'AbortError';
        throw abortErr;
      }

      destinationExists = false;
      try {
        await fs.promises.lstat(targetDestAppPath);
        destinationExists = true;
      } catch {}

      if (destinationExists) {
        await fs.promises.rename(targetDestAppPath, backupPath);
        movedExistingToBackup = true;
      }

      try {
        await fs.promises.rename(siblingStagingPath, targetDestAppPath);
      } catch (swapErr) {
        if (movedExistingToBackup) {
          try {
            if (fs.existsSync(backupPath) && !fs.existsSync(targetDestAppPath)) {
              await fs.promises.rename(backupPath, targetDestAppPath);
              movedExistingToBackup = false;
            }
          } catch {}
        }
        throw swapErr;
      }

      evictMacAppCachesForPath(targetDestAppPath);

      if (movedExistingToBackup) {
        try {
          await fs.promises.rm(backupPath, { recursive: true, force: true });
          movedExistingToBackup = false;
        } catch {}
      }

      return targetDestAppPath;
    } finally {
      activeStagingSuffixes.delete(suffix);
      // Always clean up THIS invocation's own staging/backup paths first
      try {
        if (fs.existsSync(siblingStagingPath)) {
          await fs.promises.rm(siblingStagingPath, { recursive: true, force: true });
        }
      } catch {}
      if (fs.existsSync(targetDestAppPath)) {
        if (movedExistingToBackup && fs.existsSync(backupPath)) {
          try {
            await fs.promises.rm(backupPath, { recursive: true, force: true });
          } catch {}
        }
        // Safe under per-app lock: sweep orphaned staging/backup entries for THIS appName
        // that do NOT belong to any currently active run suffix.
        if (options.sweepOrphanStagingDirs !== false) {
          try {
            const stagingPrefix = `.${appName}.ol-staging-`;
            const backupPrefix = `.${appName}.ol-backup-`;
            const entries = await fs.promises.readdir(parentDir);
            for (const ent of entries) {
              let entSuffix = '';
              if (ent.startsWith(stagingPrefix)) {
                entSuffix = ent.slice(stagingPrefix.length);
              } else if (ent.startsWith(backupPrefix)) {
                entSuffix = ent.slice(backupPrefix.length);
              } else {
                continue;
              }
              if (entSuffix && activeStagingSuffixes.has(entSuffix)) {
                continue;
              }
              await fs.promises
                .rm(path.join(parentDir, ent), { recursive: true, force: true })
                .catch(() => {});
            }
          } catch {}
        }
      }
    }
  });
}

/**
 * Copy a verified `.app` bundle into `targetDestDir` preserving `.framework` symlinks via `/usr/bin/ditto`
 * (with `fs.promises.cp` fallback in hermetic test mocks), clear macOS quarantine attributes, and
 * perform an atomic same-volume `rename(2)` swap.
 *
 * @param {string} srcApp
 * @param {string} targetDestDir
 * @param {Record<string, any>} [options]
 * @returns {Promise<string>}
 */
async function copyVerifiedMacAppToApplicationsDir(srcApp, targetDestDir, options = {}) {
  const destApp =
    typeof options.targetAppBundlePath === 'string' && options.targetAppBundlePath.trim()
      ? options.targetAppBundlePath.trim()
      : path.join(targetDestDir, path.basename(srcApp));
  return atomicReplaceMacAppBundle(srcApp, destApp, options);
}

/**
 * Mount a `.dmg` read-only, verify the contained `.app` Developer ID signature (and mandatory
 * Apple-signed `D3DMetal.framework` for GPTK bundles) BEFORE copying anything to `targetDestDir`,
 * atomically stage & swap via `ditto`, clear quarantine, and ALWAYS detach in `finally`.
 *
 * @param {string} dmgPath
 * @param {string} targetDestDir
 * @param {string[]} expectedTeamIds
 * @param {RegExp | null} expectedVendorAuthorityPattern
 * @param {Record<string, any>} [options]
 * @returns {Promise<string>}
 */
async function mountVerifyAndInstallDmgApp(
  dmgPath,
  targetDestDir,
  expectedTeamIds = [],
  expectedVendorAuthorityPattern = null,
  options = {}
) {
  if (
    typeof dmgPath !== 'string' ||
    !dmgPath.trim() ||
    !path.isAbsolute(dmgPath) ||
    path.basename(dmgPath).startsWith('-')
  ) {
    throw new Error(`Rejected unsafe or non-absolute disk image path: ${String(dmgPath)}`);
  }

  const mountPoint = path.join(
    os.tmpdir(),
    `ol-env-dmg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  );
  const execFileFn = getExecFileFn(options);
  const execHdiutil =
    typeof options.onExecHdiutil === 'function'
      ? options.onExecHdiutil
      : (/** @type {string[]} */ args) =>
          runExecFileAsync(execFileFn, 'hdiutil', args, {
            timeout: 120000,
            ...(options.signal ? { signal: options.signal } : {}),
          });

  let attached = false;
  try {
    await execHdiutil([
      'attach',
      '-mountpoint',
      mountPoint,
      '-nobrowse',
      '-readonly',
      '-quiet',
      '--',
      dmgPath,
    ]);
    attached = true;

    if (!fs.existsSync(mountPoint)) {
      throw new Error(`Failed to mount disk image: ${path.basename(dmgPath)}`);
    }

    const entries = await fs.promises.readdir(mountPoint);
    const appEntries = entries.filter((e) => e.toLowerCase().endsWith('.app'));
    const appEntry =
      options.requireGptkBundle === true
        ? appEntries.find((e) => /^Game Porting Toolkit.*\.app$/i.test(e)) || appEntries[0]
        : appEntries[0];
    if (!appEntry) {
      throw new Error(`No .app bundle found inside ${path.basename(dmgPath)}`);
    }

    const mountedAppPath = path.join(mountPoint, appEntry);
    if (options.requireGptkBundle === true) {
      const matchesGptkName = /^Game Porting Toolkit.*\.app$/i.test(appEntry);
      const embeddedD3d = findEmbeddedD3DMetalFramework(mountedAppPath);
      const hasGptkLayout =
        fs.existsSync(path.join(mountedAppPath, 'Contents/Resources/wine')) ||
        Boolean(embeddedD3d);
      if (!matchesGptkName && !hasGptkLayout) {
        throw new Error(
          `Rejected ${path.basename(dmgPath)}: "${appEntry}" is not an Apple Game Porting Toolkit bundle.`
        );
      }
      const allowMissingD3dInMockedTest =
        isTestEnvironment(options) &&
        typeof options.verifySignatureFn === 'function' &&
        options.requireD3DMetalSignatureCheck !== true;
      if (!embeddedD3d && !allowMissingD3dInMockedTest) {
        throw new Error(
          `Rejected ${path.basename(dmgPath)}: embedded Apple-signed D3DMetal.framework was not found inside "${appEntry}".`
        );
      }
      if (embeddedD3d) {
        await verifyAppleSignedFramework(embeddedD3d, {
          ...options,
          keepOnFailure: true,
        });
      }
    }

    if (options.prepareUnsignedWineBundle === true && expectedTeamIds.length === 0) {
      try {
        await verifyMacAppDeveloperSignature(mountedAppPath, expectedTeamIds, {
          ...options,
          keepOnFailure: true,
          allowAdhocSignature: true,
          ...(expectedVendorAuthorityPattern ? { expectedVendorAuthorityPattern } : {}),
        });
      } catch (verifyErr) {
        const errDetail = `${String(verifyErr?.stderr || '')} ${String(verifyErr?.message || '')}`;
        if (!/not signed at all/i.test(errDetail)) {
          throw verifyErr;
        }
      }
    } else {
      await verifyMacAppDeveloperSignature(mountedAppPath, expectedTeamIds, {
        ...options,
        keepOnFailure: true,
        ...(options.requireGptkBundle === true ? { allowAdhocSignature: true } : {}),
        ...(expectedVendorAuthorityPattern ? { expectedVendorAuthorityPattern } : {}),
      });
    }

    return await copyVerifiedMacAppToApplicationsDir(mountedAppPath, targetDestDir, options);
  } finally {
    if (attached || typeof options.onExecHdiutil === 'function') {
      try {
        await execHdiutil(['detach', mountPoint, '-force', '-quiet']);
      } catch {}
    }
  }
}

/**
 * Unified verified `.dmg` runner installer collapsing duplicated DMG mount/verify/receipt/cache
 * flows across local DMG, Preview DMG, CrossOver DMG, Wine DMG, and GPTK DMG installs.
 *
 * @param {{
 *   dmgPath: string,
 *   effectiveRunnerType: string,
 *   componentId: any,
 *   targetAppsDir: string,
 *   targetAppPath?: string | null,
 *   existingLayer?: any,
 *   expectedTeamIds?: string[],
 *   expectedVendorAuthorityPattern?: RegExp | null,
 *   additionalExpectedTeamIds?: string[],
 *   displayLabel: string,
 *   verifyingMessage: string,
 *   progressCtx: any,
 *   homedir: string,
 *   resolvedVersion?: string | null,
 *   resolveVersionAfterInstall?: (installedPath: string) => string | null,
 *   extraMountOptions?: Record<string, any>,
 * }} params
 * @param {Record<string, any>} options
 * @returns {Promise<{ success: true, installed: true, installedPath: string, version?: string, message: string }>}
 */
async function installVerifiedDmgRunner(params, options = {}) {
  const {
    dmgPath,
    effectiveRunnerType,
    componentId,
    targetAppsDir,
    targetAppPath = null,
    existingLayer = null,
    expectedTeamIds = [],
    expectedVendorAuthorityPattern = null,
    additionalExpectedTeamIds = [],
    displayLabel,
    verifyingMessage,
    progressCtx,
    homedir,
    resolvedVersion: initialVersion = null,
    resolveVersionAfterInstall,
    extraMountOptions = {},
  } = params;

  emitEnvironmentSetupProgress(
    {
      ...progressCtx,
      phase: 'verifying_signature',
      message: verifyingMessage,
    },
    options
  );
  const preSwapSafe = await assertRunnerSafeToReplace(
    effectiveRunnerType,
    targetAppPath,
    existingLayer,
    options
  );
  throwIfRunnerBusy(preSwapSafe);

  const installedPath = await mountVerifyAndInstallDmgApp(
    dmgPath,
    targetAppsDir,
    expectedTeamIds,
    expectedVendorAuthorityPattern,
    {
      ...options,
      ...extraMountOptions,
      _componentId: componentId,
      ...(additionalExpectedTeamIds.length > 0 ? { additionalExpectedTeamIds } : {}),
      ...(targetAppPath ? { targetAppBundlePath: targetAppPath } : {}),
    }
  );

  const finalVersion =
    typeof resolveVersionAfterInstall === 'function'
      ? resolveVersionAfterInstall(installedPath)
      : initialVersion;

  if (finalVersion && typeof recordRunnerInstallReceipt === 'function') {
    recordRunnerInstallReceipt(installedPath, effectiveRunnerType, finalVersion, {
      ...options,
      homedir,
    });
  }
  invalidateScanCaches({ skipPreviewUrlCacheClear: true });
  return {
    success: true,
    installed: true,
    installedPath,
    ...(finalVersion ? { version: finalVersion } : {}),
    message: `Installed ${displayLabel} to ${installedPath}.`,
  };
}

/**
 * Recursively find a `.app` bundle inside an archive extraction staging directory (up to depth 3),
 * optionally prioritizing preferred `.app` bundle basenames.
 *
 * @param {string} rootDir
 * @param {number} [depth]
 * @param {string[]} [preferredAppNames]
 * @returns {Promise<string | null>}
 */
async function findStagedAppBundle(rootDir, depth = 0, preferredAppNames = []) {
  if (depth > 3 || !fs.existsSync(rootDir)) return null;
  const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  const appEntries = entries.filter(
    (ent) =>
      !ent.name.startsWith('.') &&
      ent.name !== '__MACOSX' &&
      ent.isDirectory() &&
      ent.name.toLowerCase().endsWith('.app')
  );
  if (Array.isArray(preferredAppNames) && preferredAppNames.length > 0 && appEntries.length > 0) {
    for (const pref of preferredAppNames) {
      const lowerPref = String(pref || '').trim().toLowerCase();
      if (!lowerPref) continue;
      const hit = appEntries.find((ent) => ent.name.toLowerCase() === lowerPref);
      if (hit) return path.join(rootDir, hit.name);
    }
  }
  if (appEntries.length > 0) {
    return path.join(rootDir, appEntries[0].name);
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === '__MACOSX') continue;
    if (ent.isDirectory()) {
      const nested = await findStagedAppBundle(
        path.join(rootDir, ent.name),
        depth + 1,
        preferredAppNames
      );
      if (nested) return nested;
    }
  }
  return null;
}

module.exports = {
  registerExternalRunnerManagerDetector,
  throwIfRunnerBusy,
  resolveTargetMacApplicationsDir,
  assertRunnerSafeToReplace,
  evictMacAppCachesForPath,
  atomicReplaceMacAppBundle,
  copyVerifiedMacAppToApplicationsDir,
  mountVerifyAndInstallDmgApp,
  installVerifiedDmgRunner,
  findStagedAppBundle,
};
