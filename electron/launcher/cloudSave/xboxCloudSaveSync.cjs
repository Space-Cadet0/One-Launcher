// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const { isNetworkOnlineForLaunch } = require('../engineStateRegistry.cjs');
const { toHostFilesystemPath } = require('../securityAndPathUtils.cjs');
const {
  parseWgsContainerBlobIndex,
  syncXboxTitleStorage,
} = require('../../storefronts/xbox/xboxTitleStorageSync.cjs');
const {
  buildPerGameCloudSyncLockKey,
  withPerGameCloudSyncLock,
  sleepUnrefWithAbortAsync,
  pathExistsAsync,
} = require('./oneDriveAndPathGuards.cjs');

/**
 * Inspects a Windows GamingServices `SystemAppData\wgs` directory tree asynchronously
 * to detect active `t\` staging or mid-swap dual-GUID containers.
 *
 * @param {string} wgsRootDir
 * @returns {Promise<{ maxMtimeMs: number, totalEntries: number, hasActiveStaging: boolean, hasMidSwapContainer: boolean }>}
 */
async function inspectWgsFlushSnapshot(wgsRootDir) {
  let maxMtimeMs = 0;
  let totalEntries = 0;
  let hasActiveStaging = false;
  let hasMidSwapContainer = false;

  const zeroGuid = '00000000-0000-0000-0000-000000000000';

  /**
   * @param {string} dir
   * @param {number} [depth=0]
   */
  const walk = async (dir, depth = 0) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      let st;
      try {
        st = await fs.promises.lstat(fullPath);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      totalEntries += 1;
      if (st.mtimeMs > maxMtimeMs) {
        maxMtimeMs = st.mtimeMs;
      }
      if (ent.isDirectory()) {
        if (depth === 0 && ent.name.toLowerCase() === 't') {
          try {
            const tempChildren = await fs.promises.readdir(fullPath);
            if (tempChildren.length > 0) {
              hasActiveStaging = true;
            }
          } catch {}
        }
        await walk(fullPath, depth + 1);
      } else if (ent.isFile() && /^container\.\d+$/i.test(ent.name)) {
        try {
          const buf = await fs.promises.readFile(fullPath);
          const parsedIndex = parseWgsContainerBlobIndex(buf);
          const records = Array.isArray(parsedIndex?.blobs)
            ? parsedIndex.blobs
            : Array.isArray(parsedIndex)
              ? parsedIndex
              : [];
          for (const rec of records) {
            if (
              rec.hasDualDistinctGuids ||
              (rec.fileNameGuid1 &&
                rec.fileNameGuid1 !== zeroGuid &&
                rec.fileNameGuid2 &&
                rec.fileNameGuid2 !== zeroGuid)
            ) {
              hasMidSwapContainer = true;
              break;
            }
          }
        } catch {}
      }
    }
  };

  await walk(wgsRootDir, 0);
  return { maxMtimeMs, totalEntries, hasActiveStaging, hasMidSwapContainer };
}

/**
 * Detects whether a Windows Xbox install is a clientless One Launcher GDK install (`xbox-msixvc-win`)
 * without OS `GamingServices` / Appx AUMID registration, requiring Direct Title Storage REST sync
 * against `titlestorage.xboxlive.com` instead of waiting on `GamingServices` flush.
 *
 * @param {Record<string, any>} [payload]
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function isClientlessWindowsXboxGdkInstall(payload = {}, options = {}) {
  if (
    payload?.isAppxRegistered === true ||
    options?.isAppxRegistered === true ||
    payload?.useGamingServicesRuntime === true ||
    options?.useGamingServicesRuntime === true
  ) {
    return false;
  }
  const installKind = String(payload?.installKind || options?.installKind || '')
    .trim()
    .toLowerCase();
  const launchMethod = String(payload?.launchMethod || options?.launchMethod || '')
    .trim()
    .toLowerCase();
  const runner = String(payload?.runner || options?.runner || '')
    .trim()
    .toLowerCase();

  if (
    installKind === 'xbox-gamingservices' ||
    installKind === 'xbox-appx' ||
    launchMethod === 'xbox-aumid' ||
    launchMethod === 'xbox-protocol' ||
    runner === 'xbox-aumid' ||
    runner === 'xbox-protocol'
  ) {
    return false;
  }

  if (
    payload?.isClientlessXboxGdk === true ||
    options?.isClientlessXboxGdk === true ||
    installKind === 'xbox-msixvc-win' ||
    launchMethod === 'xbox-msixvc-win' ||
    runner === 'xbox-msixvc-win'
  ) {
    return true;
  }

  const installPath = String(payload?.installPath || options?.installPath || '').trim();
  if (!installPath) {
    return false;
  }

  const checkDirs = [installPath];
  const baseLower = path.basename(installPath.replace(/[\\/]+$/, '')).toLowerCase();
  if (baseLower === 'content') {
    const parent = path.dirname(installPath.replace(/[\\/]+$/, ''));
    if (parent && parent !== installPath) {
      checkDirs.push(parent);
    }
  }

  for (const dir of checkDirs) {
    try {
      if (
        fs.existsSync(path.join(dir, '.onelauncher-xbox-receipt.json')) ||
        fs.existsSync(path.join(dir, '.one_launcher_managed'))
      ) {
        return true;
      }
    } catch {}
  }

  return false;
}

/**
 * Factory creating `waitForXboxCloudSaveFlush` and `syncXboxCloudSaves` wired to
 * facade-injected backup, path-resolver, and per-snapshot quota helpers.
 *
 * @param {{
 *   resolveDefaultPerSnapshotMaxBackupBytes: (options?: Record<string, any>) => number,
 *   createCloudSaveRollingBackupAsync: (...args: any[]) => Promise<any>,
 *   resolveXboxSaveLocations: (...args: any[]) => any,
 *   getWaitForXboxCloudSaveFlush?: () => (options?: Record<string, any>) => Promise<any>,
 * }} deps
 */
function createXboxCloudSaveSync(deps) {
  const {
    resolveDefaultPerSnapshotMaxBackupBytes,
    createCloudSaveRollingBackupAsync,
    resolveXboxSaveLocations,
  } = deps;

  /**
   * Non-destructively waits for Windows `GamingServices` (`XGameSave`) to finish flushing
   * `SystemAppData\wgs` after game exit, then optionally snapshots a rolling backup.
   * Supports `options.signal` (`AbortSignal`) and always `.unref()`s poll timers.
   *
   * @param {Record<string, any>} [options]
   */
  async function waitForXboxCloudSaveFlush(options = {}) {
    /** @type {AbortSignal | null} */
    const signal = options.signal || null;
    if (signal?.aborted) {
      return {
        completed: false,
        aborted: true,
        timedOut: false,
        waitedMs: 0,
        reason: 'aborted',
        backupPath: null,
      };
    }

    const resolved = options.wgsRootDir
      ? { wgsRootDir: options.wgsRootDir, packageFamilyName: options.packageFamilyName || '' }
      : resolveXboxSaveLocations(options, options);
    const wgsRootDir = resolved?.wgsRootDir || '';
    if (!wgsRootDir || !(await pathExistsAsync(wgsRootDir))) {
      return {
        completed: true,
        waitedMs: 0,
        reason: 'no_cloud_saves_configured',
        backupPath: null,
      };
    }

    const pollIntervalMs = Math.max(25, Number(options.pollIntervalMs || 250));
    const quietWindowMs = Math.max(50, Number(options.quietWindowMs || 2000));
    const maxWaitMs = Math.max(quietWindowMs, Number(options.maxWaitMs || 15000));
    const startedAt = Date.now();
    let lastMutationAt = startedAt;
    let prevSig = '';
    let timedOut = false;

    while (Date.now() - startedAt < maxWaitMs) {
      if (signal?.aborted) {
        return {
          completed: false,
          aborted: true,
          timedOut: false,
          waitedMs: Date.now() - startedAt,
          reason: 'aborted',
          backupPath: null,
        };
      }

      const snap = await inspectWgsFlushSnapshot(wgsRootDir);
      if (signal?.aborted) {
        return {
          completed: false,
          aborted: true,
          timedOut: false,
          waitedMs: Date.now() - startedAt,
          reason: 'aborted',
          backupPath: null,
        };
      }

      const sig = `${snap.totalEntries}:${Math.round(snap.maxMtimeMs)}:${snap.hasActiveStaging ? 1 : 0}:${snap.hasMidSwapContainer ? 1 : 0}`;
      const now = Date.now();
      if (prevSig && sig !== prevSig) {
        lastMutationAt = now;
      } else if (!prevSig && snap.maxMtimeMs > 0 && now - snap.maxMtimeMs < quietWindowMs) {
        lastMutationAt = Math.max(startedAt, snap.maxMtimeMs);
      }
      prevSig = sig;

      if (
        !snap.hasActiveStaging &&
        !snap.hasMidSwapContainer &&
        now - lastMutationAt >= quietWindowMs
      ) {
        break;
      }

      if (now - startedAt + pollIntervalMs >= maxWaitMs) {
        if (
          snap.hasActiveStaging ||
          snap.hasMidSwapContainer ||
          now - lastMutationAt < quietWindowMs
        ) {
          timedOut = true;
        }
        break;
      }
      await sleepUnrefWithAbortAsync(pollIntervalMs, signal);
      if (signal?.aborted) {
        return {
          completed: false,
          aborted: true,
          timedOut: false,
          waitedMs: Date.now() - startedAt,
          reason: 'aborted',
          backupPath: null,
        };
      }
    }

    let backupPath = null;
    if (typeof options.userDataDir === 'string' && options.userDataDir.trim()) {
      const rawId = String(
        options.gameId || options.platformGameId || resolved?.packageFamilyName || 'xbox_game'
      ).replace(/[^A-Za-z0-9._-]/g, '_');
      const backupDir = path.join(options.userDataDir, 'cloud_save_backups', 'xbox', rawId);
      const backupRes = await createCloudSaveRollingBackupAsync(
        wgsRootDir,
        backupDir,
        Number(options.maxBackupBytes) > 0
          ? Number(options.maxBackupBytes)
          : resolveDefaultPerSnapshotMaxBackupBytes(options),
        {
          maxTotalBackupBytes: options.maxTotalBackupBytes,
          maxSnapshotsPerGame: options.maxSnapshotsPerGame,
          userDataDir: options.userDataDir,
          backupsRootDir: options.backupsRootDir,
          platform: options.platform || process.platform,
          getWin32FileAttributes: options.getWin32FileAttributes,
          oneDriveAttribExecImpl: options.oneDriveAttribExecImpl,
        }
      );
      if (backupRes?.backedUp) {
        backupPath = backupRes.backupPath;
      }
    }

    return {
      completed: !timedOut,
      timedOut,
      waitedMs: Date.now() - startedAt,
      reason: timedOut ? 'timeout' : 'wgs_flushed',
      backupPath,
    };
  }

  /**
   * Inner unlocked implementation of `syncXboxCloudSaves`.
   *
   * @param {Record<string, any>} payload
   * @param {string} mode
   * @param {Record<string, any>} options
   */
  async function runSyncXboxCloudSaves(payload, mode, options) {
    const effectivePlatform = options.platform || process.platform;
    const winePrefix = String(
      options.winePrefix || payload.winePrefix || options.bottlePath || payload.bottlePath || ''
    ).trim();
    const useCompatLayer = Boolean(
      options.useCompatLayer ||
        payload.useCompatLayer ||
        winePrefix ||
        effectivePlatform === 'darwin'
    );
    const isClientlessWinGdk =
      effectivePlatform === 'win32' &&
      !useCompatLayer &&
      isClientlessWindowsXboxGdkInstall(payload, options);

    const xboxBackupQuotaOpts = {
      maxTotalBackupBytes: options.maxTotalBackupBytes,
      maxSnapshotsPerGame: options.maxSnapshotsPerGame,
      userDataDir: options.userDataDir,
      backupsRootDir: options.backupsRootDir,
      platform: effectivePlatform,
      getWin32FileAttributes: options.getWin32FileAttributes,
      oneDriveAttribExecImpl: options.oneDriveAttribExecImpl,
    };
    const effectiveMaxBackupBytes =
      Number(options.maxBackupBytes) > 0
        ? Number(options.maxBackupBytes)
        : resolveDefaultPerSnapshotMaxBackupBytes(options);

    // 1. Windows Native OS Path: GamingServices owns live XGameSave cloud sync (non-clientless only)
    if (effectivePlatform === 'win32' && !useCompatLayer && !isClientlessWinGdk) {
      const locs = resolveXboxSaveLocations(payload, {
        ...options,
        platform: 'win32',
        useCompatLayer: false,
      });
      const hostWgsRootDir = locs?.wgsRootDir ? toHostFilesystemPath(locs.wgsRootDir) : '';
      if (!locs || !hostWgsRootDir || !(await pathExistsAsync(hostWgsRootDir))) {
        return {
          synced: false,
          provider: 'xbox_connected_storage',
          mode,
          reason: 'no_cloud_saves_configured',
          backupPath: null,
        };
      }

      if (mode === 'pre_launch') {
        let backupPath = null;
        if (typeof options.userDataDir === 'string' && options.userDataDir.trim()) {
          const rawId = String(
            payload.gameId || payload.platformGameId || locs.packageFamilyName || 'xbox_game'
          ).replace(/[^A-Za-z0-9._-]/g, '_');
          const backupRes = await createCloudSaveRollingBackupAsync(
            hostWgsRootDir,
            path.join(
              toHostFilesystemPath(options.userDataDir),
              'cloud_save_backups',
              'xbox',
              rawId
            ),
            effectiveMaxBackupBytes,
            xboxBackupQuotaOpts
          );
          if (backupRes?.backedUp) backupPath = backupRes.backupPath;
        }
        return {
          synced: true,
          provider: 'xbox_connected_storage',
          mode,
          reason: 'windows_gamingservices_managed',
          backupPath,
        };
      }

      const flushFn =
        typeof deps.getWaitForXboxCloudSaveFlush === 'function'
          ? deps.getWaitForXboxCloudSaveFlush()
          : waitForXboxCloudSaveFlush;
      const flushRes = await flushFn({
        ...options,
        wgsRootDir: hostWgsRootDir,
        packageFamilyName: locs.packageFamilyName,
        gameId: payload.gameId || payload.platformGameId || locs.packageFamilyName,
      });
      return {
        synced: Boolean(flushRes.completed),
        provider: 'xbox_connected_storage',
        mode,
        reason: flushRes.aborted
          ? 'aborted'
          : flushRes.timedOut
            ? 'timeout'
            : 'windows_gamingservices_flushed',
        waitedMs: flushRes.waitedMs,
        backupPath: flushRes.backupPath || null,
      };
    }

    // 2. Direct Title Storage REST Sync (macOS Bottle / Compat Layer OR Windows Clientless `xbox-msixvc-win`)
    if (!isNetworkOnlineForLaunch(options)) {
      return {
        synced: false,
        provider: 'xbox_connected_storage',
        mode,
        offlineSkipped: true,
        reason: 'offline_skipped',
        backupPath: null,
      };
    }
    const directSyncCompatLayer = Boolean(
      winePrefix || options.useCompatLayer || payload.useCompatLayer
    );
    const baseLocs = resolveXboxSaveLocations(payload, {
      ...options,
      platform: effectivePlatform,
      useCompatLayer: directSyncCompatLayer,
      winePrefix,
    });
    if (!baseLocs || !baseLocs.packageFamilyName || !baseLocs.scid) {
      return {
        synced: false,
        provider: 'xbox_connected_storage',
        mode,
        reason: 'missing_scid_or_pfn',
        backupPath: null,
      };
    }

    let authProvider = options.xboxAuthProvider || null;
    if (!authProvider && !options.xboxSession) {
      try {
        const storeSync = require('../../storeSync.cjs');
        if (typeof storeSync.getXboxAuthProvider === 'function') {
          authProvider = storeSync.getXboxAuthProvider({ userDataDir: options.userDataDir });
        }
      } catch {}
    }

    let session = options.xboxSession || null;
    if (!session && authProvider && typeof authProvider.getValidXboxSession === 'function') {
      try {
        session = await authProvider.getValidXboxSession();
      } catch (authErr) {
        const msg = String(/** @type {any} */ (authErr)?.message || '');
        if (/offline|network|enotfound|econnrefused|etimedout/i.test(msg)) {
          return {
            synced: false,
            provider: 'xbox_connected_storage',
            mode,
            reason: 'offline_skipped',
            backupPath: null,
          };
        }
      }
    }

    if (!session || !session.xuid || !session.authorizationHeader) {
      return {
        synced: false,
        provider: 'xbox_connected_storage',
        mode,
        reason: 'missing_xbox_auth',
        backupPath: null,
      };
    }

    const locs = resolveXboxSaveLocations(
      {
        ...payload,
        packageFamilyName: baseLocs.packageFamilyName,
        scid: baseLocs.scid,
        fallbackScid: baseLocs.fallbackScid || payload.fallbackScid || options.fallbackScid,
        msaAppId: baseLocs.msaAppId || payload.msaAppId,
        xboxTitleId: baseLocs.titleId || payload.xboxTitleId || payload.titleId,
        xuid: session.xuid,
      },
      {
        ...options,
        platform: effectivePlatform,
        useCompatLayer: directSyncCompatLayer,
        winePrefix,
      }
    );
    if (!locs || !locs.wgsUserDir) {
      return {
        synced: false,
        provider: 'xbox_connected_storage',
        mode,
        reason: 'no_cloud_saves_configured',
        backupPath: null,
      };
    }

    const hostWgsUserDir = toHostFilesystemPath(locs.wgsUserDir);
    const hostXgsUserDir = locs.xgsUserDir ? toHostFilesystemPath(locs.xgsUserDir) : null;
    const rawBackupId = String(
      payload.gameId || payload.platformGameId || locs.packageFamilyName || 'xbox_game'
    ).replace(/[^A-Za-z0-9._-]/g, '_');
    const backupBaseDir =
      typeof options.userDataDir === 'string' && options.userDataDir.trim()
        ? path.join(
            toHostFilesystemPath(options.userDataDir),
            'cloud_save_backups',
            'xbox',
            rawBackupId
          )
        : '';

    let backupPath = null;
    if (mode === 'pre_launch' && backupBaseDir && (await pathExistsAsync(hostWgsUserDir))) {
      const preBackup = await createCloudSaveRollingBackupAsync(
        hostWgsUserDir,
        backupBaseDir,
        effectiveMaxBackupBytes,
        xboxBackupQuotaOpts
      );
      if (preBackup?.backedUp) backupPath = preBackup.backupPath;
    }

    try {
      const syncTitleStorageFn =
        options.syncXboxTitleStorageFn || options.xboxSyncFn || syncXboxTitleStorage;
      const syncRes = await syncTitleStorageFn({
        mode,
        wgsUserDir: hostWgsUserDir,
        xgsUserDir: hostXgsUserDir,
        xuid: session.xuid,
        scid: locs.scid,
        fallbackScid: locs.fallbackScid || payload.fallbackScid || options.fallbackScid || '',
        msaAppId: locs.msaAppId || payload.msaAppId || '',
        titleId: locs.titleId || payload.xboxTitleId || payload.titleId || '',
        xboxProductId: payload.xboxProductId || '',
        packageFamilyName: locs.packageFamilyName,
        storePkgAumid: payload.appUserModelId || `${locs.packageFamilyName}!App`,
        authProvider,
        authorizationHeader: session.authorizationHeader,
        titleStorageOrigin: options.titleStorageOrigin || payload.titleStorageOrigin,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        ...(typeof options.pendingUploadLastSyncedAt === 'number' &&
        options.pendingUploadLastSyncedAt > 0
          ? { pendingUploadLastSyncedAt: options.pendingUploadLastSyncedAt }
          : {}),
        ...(typeof options.blobConcurrency === 'number'
          ? { blobConcurrency: options.blobConcurrency }
          : {}),
        ...(options.alreadyLocked === true ? { alreadyLocked: true } : {}),
        ...(typeof options.keepLockHeld === 'boolean'
          ? { keepLockHeld: options.keepLockHeld }
          : {}),
        ...(options.priorHadWrites === true ? { priorHadWrites: true } : {}),
        ...(typeof options.quotaBytes === 'number' && options.quotaBytes > 0
          ? { quotaBytes: options.quotaBytes }
          : {}),
      });

      const resolvedScid = String(syncRes?.resolvedScid || locs.scid || '')
        .trim()
        .toLowerCase();
      const effectiveWgsUserDir = toHostFilesystemPath(
        String(syncRes?.resolvedWgsUserDir || hostWgsUserDir || '')
      );

      if (syncRes?.skipped && syncRes?.unsupportedForTitle) {
        return {
          synced: false,
          provider: 'xbox_connected_storage',
          mode,
          reason: 'title_storage_not_provisioned',
          resolvedScid,
          backupPath,
        };
      }

      if (
        mode === 'post_exit' &&
        backupBaseDir &&
        effectiveWgsUserDir &&
        (await pathExistsAsync(effectiveWgsUserDir))
      ) {
        const postBackup = await createCloudSaveRollingBackupAsync(
          effectiveWgsUserDir,
          backupBaseDir,
          effectiveMaxBackupBytes,
          xboxBackupQuotaOpts
        );
        if (postBackup?.backedUp) backupPath = postBackup.backupPath;
      }

      const filesSynced =
        Number(syncRes?.downloadedContainers || 0) + Number(syncRes?.uploadedContainers || 0);
      const syncedAtMs = Date.now();
      const resolvedQuotaBytes =
        typeof syncRes?.quotaBytes === 'number' &&
        Number.isFinite(syncRes.quotaBytes) &&
        syncRes.quotaBytes > 0
          ? syncRes.quotaBytes
          : undefined;
      const resolvedRemainingQuotaBytes =
        typeof syncRes?.remainingQuotaBytes === 'number' &&
        Number.isFinite(syncRes.remainingQuotaBytes) &&
        syncRes.remainingQuotaBytes >= 0
          ? syncRes.remainingQuotaBytes
          : undefined;
      return {
        synced: Boolean(syncRes?.synced),
        provider: 'xbox_connected_storage',
        mode,
        resolvedScid,
        ...(resolvedQuotaBytes !== undefined ? { quotaBytes: resolvedQuotaBytes } : {}),
        ...(resolvedRemainingQuotaBytes !== undefined
          ? { remainingQuotaBytes: resolvedRemainingQuotaBytes }
          : {}),
        ...(syncRes?.synced ? { syncedAtMs } : {}),
        filesSynced,
        downloadedContainers: Number(syncRes?.downloadedContainers || 0),
        uploadedContainers: Number(syncRes?.uploadedContainers || 0),
        deletedRemoteContainers: Number(syncRes?.deletedRemoteContainers || 0),
        backupPath,
        ...(syncRes?.conflictDetected
          ? {
              conflictDetected: true,
              conflictContainerNames: Array.isArray(syncRes.conflictContainerNames)
                ? syncRes.conflictContainerNames
                : [],
            }
          : {}),
        ...(syncRes?.lockHeld && options.keepLockHeld !== true
          ? { reason: 'xbox_cloud_lock_conflict' }
          : {}),
      };
    } catch (err) {
      if (
        mode === 'post_exit' &&
        !backupPath &&
        backupBaseDir &&
        (await pathExistsAsync(hostWgsUserDir))
      ) {
        const fallbackBackup = await createCloudSaveRollingBackupAsync(
          hostWgsUserDir,
          backupBaseDir,
          effectiveMaxBackupBytes,
          xboxBackupQuotaOpts
        ).catch(() => null);
        if (fallbackBackup?.backedUp) backupPath = fallbackBackup.backupPath;
      }
      diagLog.warn('cloudSave.syncXboxTitleStorageFailed', err, {
        mode,
        packageFamilyName: locs.packageFamilyName,
        scid: locs.scid,
      });
      const anyErr = /** @type {any} */ (err);
      const msg = String(anyErr?.message || '');
      const isOffline =
        anyErr?.code === 'ENOTFOUND' ||
        anyErr?.code === 'ECONNREFUSED' ||
        /offline|network|enotfound|fetch failed/i.test(msg);
      return {
        synced: false,
        provider: 'xbox_connected_storage',
        mode,
        reason: isOffline ? 'offline_skipped' : msg || 'xbox_title_storage_sync_failed',
        backupPath,
      };
    }
  }

  /**
   * Dual-OS Xbox Connected Storage (`wgs`) Cloud Save Sync orchestrator serialized per game
   * via `withPerGameCloudSyncLock` so overlapping pre-launch / post-exit / replay operations
   * for the same title never race on WGS containers or backups.
   *
   * @param {Record<string, any>} [payload]
   * @param {string | Record<string, any>} [mode='pre_launch']
   * @param {Record<string, any>} [options]
   */
  async function syncXboxCloudSaves(payload = {}, mode = 'pre_launch', options = {}) {
    /** @type {string} */
    let effectiveMode = typeof mode === 'string' ? mode : 'pre_launch';
    if (mode && typeof mode === 'object') {
      options = mode;
      effectiveMode = String(payload?.mode || payload?.direction || 'pre_launch');
    }

    const rawLockId = String(
      payload.platformGameId ||
        payload.gameId ||
        payload.packageFamilyName ||
        payload.scid ||
        ''
    ).trim();
    const lockKey = buildPerGameCloudSyncLockKey('xbox', rawLockId);
    if (!lockKey || options._cloudSyncLockHeldKey === lockKey) {
      return runSyncXboxCloudSaves(payload, effectiveMode, options);
    }
    return withPerGameCloudSyncLock(lockKey, () =>
      runSyncXboxCloudSaves(payload, effectiveMode, {
        ...options,
        _cloudSyncLockHeldKey: lockKey,
      })
    );
  }

  return {
    waitForXboxCloudSaveFlush,
    syncXboxCloudSaves,
  };
}

module.exports = {
  inspectWgsFlushSnapshot,
  isClientlessWindowsXboxGdkInstall,
  createXboxCloudSaveSync,
};
