// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { deriveDefaultScidFromTitleId } = require('./xboxConfigAndIds.cjs');
const { toHostFilesystemPath } = require('../../launcher/securityAndPathUtils.cjs');

const wgsBinaryFormat = require('./titlestorage/wgsBinaryFormat.cjs');
const wgsLocalWorkspace = require('./titlestorage/wgsLocalWorkspace.cjs');
const xgsMirroring = require('./titlestorage/xgsMirroring.cjs');
const titleStorageRestClient = require('./titlestorage/titleStorageRestClient.cjs');

const {
  VALID_SCID_UUID_RE,
  dateToFileTimeBigInt,
  fileTimeBigIntToIso,
  readWinGuidHexUpper,
  writeWinGuidHex,
  generateUpperGuidHex,
  formatWgsUserScidFolderName,
  isValidTitleStorageContainerName,
  encodeTitleStorageContainerPath,
  parseWgsContainersIndex,
  serializeWgsContainersIndex,
  parseWgsContainerBlobIndex,
  serializeWgsContainerBlobIndex,
} = wgsBinaryFormat;

const {
  WGS_ATOM_SIDECAR_FILENAME,
  XGS_SYNC_SIDECAR_FILENAME,
  assertStrictlyContainedPath,
  writeFileAtomic,
  loadWgsSyncSidecar,
  saveWgsSyncSidecar,
  loadXgsSyncSidecar,
  saveXgsSyncSidecar,
  readLocalWgsWorkspace,
  writeLocalWgsWorkspace,
} = wgsLocalWorkspace;

const {
  resolveEffectiveXgsUserDir,
  sanitizePoisonedWgsContainersMap,
  cleanupStaleRootXgsDuplicates,
  exportWgsToXgsFolder,
  importXgsFolderIntoWgs,
} = xgsMirroring;

const {
  LARGE_ATOM_THRESHOLD_BYTES,
  DEFAULT_TITLE_STORAGE_TIMEOUT_MS,
  validateTitleStorageOrigin,
  validateTitleStorageBlobUri,
  createTitleStorageClient,
} = titleStorageRestClient;

/**
 * Synchronizes a local `wgs\<HexXuid>_<Scid>` (and optional `xgs\<HexXuid>_<Scid>`) workspace
 * with Xbox Live Connected Storage (`titlestorage.xboxlive.com`, contract v107).
 *
 * Modes:
 * - `'pre_launch'`: Acquires lock, lists remote containers, pulls newer cloud blobs, uploads any offline dirty saves, exports `xgs/` view, optionally holds or releases lock.
 * - `'in_session'`: Pushes dirty local containers immediately to cloud.
 * - `'post_exit'`: Imports `xgs/` changes, pushes all dirty containers + deletions, releases session lock.
 *
 * @param {Record<string, any>} [options]
 */
async function syncXboxTitleStorage(options = {}) {
  const {
    mode = 'pre_launch',
    xgsUserDir = null,
    xuid,
    scid,
    msaAppId = '',
    titleId = '',
    storePkgAumid = '',
    authProvider,
    authorizationHeader,
    fetchImpl,
    keepLockHeld = false,
    alreadyLocked = false,
    priorHadWrites = false,
    signal,
  } = options;
  const wgsUserDir = options.wgsUserDir || options.wgsDir;
  const packageFamilyName = options.packageFamilyName || options.pfn || '';
  const titleStorageOrigin =
    options.titleStorageOrigin || options.baseUrl || options.origin;

  if (!wgsUserDir) {
    throw new Error('syncXboxTitleStorage requires wgsUserDir');
  }

  const normalizedScid = String(scid || '').trim().toLowerCase();
  let candidateFallbackScid = '';
  if (options._isFallbackRetry !== true) {
    const explicitFallback = String(options.fallbackScid || '').trim().toLowerCase();
    const derivedFromTitleId = titleId ? deriveDefaultScidFromTitleId(titleId).toLowerCase() : '';
    if (VALID_SCID_UUID_RE.test(explicitFallback) && explicitFallback !== normalizedScid) {
      candidateFallbackScid = explicitFallback;
    } else if (
      VALID_SCID_UUID_RE.test(derivedFromTitleId) &&
      derivedFromTitleId !== normalizedScid
    ) {
      candidateFallbackScid = derivedFromTitleId;
    }
  }

  const effectiveXgsUserDir = resolveEffectiveXgsUserDir(xgsUserDir, wgsUserDir);

  if (mode === 'post_exit' || mode === 'in_session') {
    await importXgsFolderIntoWgs(effectiveXgsUserDir, wgsUserDir, storePkgAumid);
  } else if (mode === 'pre_launch' && effectiveXgsUserDir) {
    const preXgsMeta = await loadXgsSyncSidecar(effectiveXgsUserDir);
    if (
      preXgsMeta.exists ||
      preXgsMeta.active ||
      preXgsMeta.knownContainers.length > 0 ||
      preXgsMeta.deletedContainers.length > 0
    ) {
      await importXgsFolderIntoWgs(effectiveXgsUserDir, wgsUserDir, storePkgAumid);
    }
  }

  const client = createTitleStorageClient({
    xuid,
    scid: normalizedScid || scid,
    packageFamilyName,
    msaAppId,
    titleId,
    titleStorageOrigin,
    allowLoopbackOrigin: options.allowLoopbackOrigin,
    authProvider,
    authorizationHeader,
    fetchImpl,
  });

  const hostWgsUserDir = path.resolve(toHostFilesystemPath(wgsUserDir));
  let lockAcquired = Boolean(alreadyLocked);

  const retryWithCandidateScid = async () => {
    if (lockAcquired) {
      try {
        await client.releaseLock(Boolean(priorHadWrites), signal);
      } catch {
        // Best-effort release of original SCID lock before switching to fallback SCID
      } finally {
        lockAcquired = false;
      }
    }
    let retryWgsUserDir = String(wgsUserDir);
    let retryXgsUserDir = effectiveXgsUserDir;
    const hasLocalWgsSaves =
      mode !== 'pre_launch' &&
      fs.existsSync(path.join(toHostFilesystemPath(retryWgsUserDir), 'containers.index'));
    if (
      options.preserveLocalWgsDirOnFallback !== true &&
      !hasLocalWgsSaves &&
      xuid &&
      normalizedScid &&
      candidateFallbackScid
    ) {
      try {
        const initialFolder = formatWgsUserScidFolderName(xuid, normalizedScid);
        const nextFolder = formatWgsUserScidFolderName(xuid, candidateFallbackScid);
        if (
          initialFolder &&
          nextFolder &&
          path.basename(retryWgsUserDir).toLowerCase() === initialFolder.toLowerCase()
        ) {
          retryWgsUserDir = path.join(path.dirname(retryWgsUserDir), nextFolder);
        }
        if (
          retryXgsUserDir &&
          initialFolder &&
          nextFolder &&
          path.basename(retryXgsUserDir).toLowerCase() === initialFolder.toLowerCase()
        ) {
          retryXgsUserDir = path.join(path.dirname(retryXgsUserDir), nextFolder);
        }
      } catch {
        // Keep original directories when fallback folder derivation fails
      }
    }
    return syncXboxTitleStorage({
      ...options,
      scid: candidateFallbackScid,
      fallbackScid: undefined,
      alreadyLocked: false,
      wgsUserDir: retryWgsUserDir,
      xgsUserDir: retryXgsUserDir,
      _isFallbackRetry: true,
    });
  };
  let reacquiredExpiredSessionLock = false;
  let sessionLockGeneration = 0;
  /** @type {Promise<any> | null} */
  let inFlightSessionLockRecovery = null;
  let readOnlyFallback = false;
  let uploadedContainers = 0;
  let downloadedContainers = 0;
  let deletedRemoteContainers = 0;
  let conflictDetected = false;
  /** @type {string[]} */
  const conflictContainerNames = [];
  let quotaBytes =
    Number(options.quotaBytes) > 0 ? Number(options.quotaBytes) : 256 * 1024 * 1024;
  const maxBlobConcurrency = Math.max(
    1,
    Math.min(8, Number(options.blobConcurrency ?? 4) || 4)
  );
  const pendingUploadLastSyncedAt =
    typeof options.pendingUploadLastSyncedAt === 'number' &&
    Number.isFinite(options.pendingUploadLastSyncedAt) &&
    options.pendingUploadLastSyncedAt > 0
      ? options.pendingUploadLastSyncedAt
      : 0;

  let activeLimiterCount = 0;
  /** @type {Array<() => void>} */
  const limiterWaiters = [];
  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const runWithBlobConcurrency = async (fn) => {
    if (activeLimiterCount >= maxBlobConcurrency) {
      await new Promise((resolve) => {
        limiterWaiters.push(() => resolve(undefined));
      });
    }
    activeLimiterCount += 1;
    try {
      return await fn();
    } finally {
      activeLimiterCount -= 1;
      const nextWaiter = limiterWaiters.shift();
      if (nextWaiter) nextWaiter();
    }
  };

  /** @param {Map<string, any>} containersMap */
  const computeUsedBytes = (containersMap) => {
    let total = 0;
    for (const container of containersMap.values()) {
      if (!container || !(container.blobs instanceof Map)) continue;
      for (const blob of container.blobs.values()) {
        const sz = Number(blob?.size);
        if (Number.isFinite(sz) && sz > 0) {
          total += sz;
        } else if (Buffer.isBuffer(blob?.data)) {
          total += blob.data.length;
        }
      }
    }
    return total;
  };

  /**
   * @template T
   * @param {() => Promise<T>} writeFn
   * @returns {Promise<T>}
   */
  const runWithSessionLockRecovery = async (writeFn) => {
    const attemptGeneration = sessionLockGeneration;
    try {
      return await writeFn();
    } catch (/** @type {any} */ writeErr) {
      if (alreadyLocked && (writeErr?.status === 403 || writeErr?.status === 412)) {
        if (attemptGeneration < sessionLockGeneration) {
          return await writeFn();
        }
        if (!reacquiredExpiredSessionLock || inFlightSessionLockRecovery) {
          let pendingLock = inFlightSessionLockRecovery;
          if (!pendingLock) {
            reacquiredExpiredSessionLock = true;
            pendingLock = Promise.resolve()
              .then(() => client.acquireLock(signal))
              .then((lockInfo) => {
                lockAcquired = lockInfo.locked;
                if (lockInfo.quotaBytes > 0) {
                  quotaBytes = lockInfo.quotaBytes;
                }
                sessionLockGeneration += 1;
                return lockInfo;
              })
              .finally(() => {
                if (inFlightSessionLockRecovery === pendingLock) {
                  inFlightSessionLockRecovery = null;
                }
              });
            inFlightSessionLockRecovery = pendingLock;
          }
          await pendingLock;
          return await writeFn();
        }
      }
      throw writeErr;
    }
  };

  try {
    if (!lockAcquired) {
      try {
        const lockInfo = await client.acquireLock(signal);
        lockAcquired = lockInfo.locked;
        quotaBytes = lockInfo.quotaBytes;
      } catch (/** @type {any} */ lockErr) {
        if (
          candidateFallbackScid &&
          (lockErr?.status === 404 ||
            (lockErr?.status === 403 && Number(lockErr?.xblCode) !== 2016))
        ) {
          return await retryWithCandidateScid();
        }
        if (
          lockErr?.status === 404 ||
          (lockErr?.status === 400 && Number(lockErr?.xblCode) === 2000)
        ) {
          return {
            synced: false,
            skipped: true,
            unsupportedForTitle: true,
            skippedReason: 'title_storage_not_provisioned',
            resolvedScid: normalizedScid,
            resolvedWgsUserDir: wgsUserDir,
            downloadedContainers: 0,
            uploadedContainers: 0,
            deletedRemoteContainers: 0,
          };
        }
        if (
          mode === 'pre_launch' &&
          lockErr?.status === 403 &&
          (lockErr?.xblCode === undefined || Number(lockErr?.xblCode) === 2016)
        ) {
          readOnlyFallback = true;
        } else {
          throw lockErr;
        }
      }
    }

    const workspace = await readLocalWgsWorkspace(wgsUserDir, { lazy: true });
    const mergedContainers = new Map(workspace.containers);
    const pendingDeletions = new Set(workspace.sidecar.deletedContainers || []);
    sanitizePoisonedWgsContainersMap(mergedContainers, pendingDeletions);

    // Push pending container deletions first (only when session lock is held)
    if (!readOnlyFallback) {
      for (const delName of Array.from(pendingDeletions)) {
        if (!isValidTitleStorageContainerName(delName)) {
          pendingDeletions.delete(delName);
          mergedContainers.delete(delName);
          continue;
        }
        await runWithSessionLockRecovery(() => client.deleteContainer(delName, signal));
        pendingDeletions.delete(delName);
        mergedContainers.delete(delName);
        deletedRemoteContainers += 1;
      }
    }

    const cloudPulledContainerNames = new Set();
    const remotelyPrunedContainerNames = new Set();

    if (mode === 'pre_launch') {
      let remoteList;
      try {
        remoteList = await client.listContainers(signal);
      } catch (/** @type {any} */ listErr) {
        if (
          candidateFallbackScid &&
          (listErr?.status === 404 || listErr?.status === 403)
        ) {
          return await retryWithCandidateScid();
        }
        if (
          listErr?.status === 404 ||
          (listErr?.status === 400 && Number(listErr?.xblCode) === 2000)
        ) {
          if (lockAcquired && !keepLockHeld) {
            await client.releaseLock(false, signal);
            lockAcquired = false;
          }
          return {
            synced: false,
            skipped: true,
            unsupportedForTitle: true,
            skippedReason: 'title_storage_not_provisioned',
            resolvedScid: normalizedScid,
            resolvedWgsUserDir: wgsUserDir,
            downloadedContainers: 0,
            uploadedContainers: 0,
            deletedRemoteContainers: 0,
          };
        }
        throw listErr;
      }
      const remoteByName = new Map(remoteList.map((r) => [r.name, r]));

      /** @type {Array<{ remote: any, local: any }>} */
      const containersToPull = [];
      for (const remote of remoteList) {
        if (pendingDeletions.has(remote.name)) {
          continue;
        }
        const local = mergedContainers.get(remote.name);
        const remoteTimeMs = Date.parse(remote.clientFileTime || '') || 0;
        const localTimeMs = local ? Date.parse(local.modifiedIso || '') || 0 : 0;
        const remoteChanged = !local || local.remoteClientFileTime !== remote.clientFileTime;

        const remoteAdvancedSinceLastSync =
          pendingUploadLastSyncedAt > 0 &&
          Boolean(local?.dirty) &&
          remoteTimeMs > pendingUploadLastSyncedAt;
        if (remoteAdvancedSinceLastSync && remoteTimeMs >= localTimeMs) {
          conflictDetected = true;
          conflictContainerNames.push(remote.name);
        }

        const shouldPullRemote =
          !local ||
          (remoteChanged && !local.dirty) ||
          (remoteChanged && local.dirty && remoteTimeMs > localTimeMs) ||
          (remoteAdvancedSinceLastSync && remoteTimeMs >= localTimeMs);

        if (shouldPullRemote) {
          containersToPull.push({ remote, local });
        }
      }

      // Download remote containers and write blobs directly to disk inside bounded concurrency
      // so peak RAM stays O(concurrency * single_blob) rather than retaining all blobs in heap.
      await Promise.all(
        containersToPull.map(async ({ remote, local }) => {
          const folderGuid = local ? local.folderGuid : generateUpperGuidHex();
          const containerDir = assertStrictlyContainedPath(
            hostWgsUserDir,
            path.join(hostWgsUserDir, folderGuid),
            'wgs containerDir'
          );
          await fs.promises.mkdir(containerDir, { recursive: true });

          const atomsMap = await runWithBlobConcurrency(() =>
            client.getContainerAtoms(remote.name, signal)
          );
          const downloadedEntries = await Promise.all(
            Array.from(atomsMap.entries()).map(([blobName, atomToken]) =>
              runWithBlobConcurrency(async () => {
                const data = await client.downloadAtom(atomToken, signal);
                const sha256 = crypto.createHash('sha256').update(data).digest('hex');
                const blobGuid = generateUpperGuidHex();
                const blobFilePath = assertStrictlyContainedPath(
                  containerDir,
                  path.join(containerDir, blobGuid),
                  'wgs blobFilePath'
                );
                await writeFileAtomic(blobFilePath, data);
                const size = data.length;
                return /** @type {[string, any]} */ ([
                  blobName,
                  {
                    name: blobName,
                    blobGuid,
                    filePath: blobFilePath,
                    size,
                    sha256,
                    atom: atomToken,
                    readData: () => fs.promises.readFile(blobFilePath),
                  },
                ]);
              })
            )
          );
          const downloadedBlobs = new Map(downloadedEntries);

          mergedContainers.set(remote.name, {
            name: remote.name,
            displayName: remote.displayName || remote.name,
            etag: remote.etag || '',
            containerNum: local ? local.containerNum : 1,
            dirty: false,
            folderGuid,
            modifiedIso: remote.clientFileTime || new Date().toISOString(),
            remoteClientFileTime: remote.clientFileTime || '',
            blobs: downloadedBlobs,
          });
          cloudPulledContainerNames.add(remote.name);
          downloadedContainers += 1;
        })
      );

      // Prune clean previously-synced local containers that were deleted remotely on another device
      for (const [cName, local] of Array.from(mergedContainers.entries())) {
        if (!local.dirty && local.remoteClientFileTime && !remoteByName.has(cName)) {
          mergedContainers.delete(cName);
          remotelyPrunedContainerNames.add(cName);
        }
      }
    }

    // Upload all dirty containers when write lock is held (4-way bounded concurrency, fault-isolated)
    let firstUploadError = null;
    if (!readOnlyFallback) {
      /** @type {Array<[string, any]>} */
      const dirtyContainers = [];
      for (const [cName, container] of Array.from(mergedContainers.entries())) {
        if (!container.dirty) continue;
        if (!isValidTitleStorageContainerName(cName)) {
          mergedContainers.delete(cName);
          continue;
        }
        dirtyContainers.push([cName, container]);
      }

      await Promise.all(
        dirtyContainers.map(async ([cName, container]) => {
          try {
            await runWithSessionLockRecovery(async () => {
              const uploadedPairs = await Promise.all(
                Array.from(container.blobs.entries()).map(([bName, blob]) =>
                  runWithBlobConcurrency(async () => {
                    let atomToken = blob.atom;
                    if (!atomToken) {
                      const uploadPayload = blob.filePath
                        ? { filePath: blob.filePath, size: blob.size }
                        : Buffer.isBuffer(blob.data)
                          ? blob.data
                          : typeof blob.readData === 'function'
                            ? await blob.readData()
                            : Buffer.from(blob.data || '');
                      atomToken = await client.uploadAtom(uploadPayload, signal);
                      blob.atom = atomToken;
                    }
                    return [bName, atomToken];
                  })
                )
              );
              const atomsObject = Object.fromEntries(uploadedPairs);

              const isoNow = container.modifiedIso || new Date().toISOString();
              await runWithBlobConcurrency(() =>
                client.putContainerManifest(
                  cName,
                  {
                    displayName: container.displayName || cName,
                    clientFileTime: isoNow,
                    atomsObject,
                  },
                  signal
                )
              );

              container.dirty = false;
              container.stateFlags = 0;
              container.remoteClientFileTime = isoNow;
            });
            uploadedContainers += 1;
          } catch (uploadErr) {
            if (!firstUploadError) firstUploadError = uploadErr;
          }
        })
      );
    }

    await writeLocalWgsWorkspace(wgsUserDir, {
      containers: Array.from(mergedContainers.values()),
      storePkgAumid: workspace.index?.storePkgAumid || storePkgAumid,
      pkgDisplayName: workspace.index?.pkgDisplayName || '',
      syncMetadataId: workspace.index?.syncMetadataId || '',
      creationFileTime: workspace.index?.creationFileTime,
      deletedContainers: Array.from(pendingDeletions),
    });

    if (effectiveXgsUserDir) {
      if (mode === 'pre_launch') {
        await exportWgsToXgsFolder(wgsUserDir, effectiveXgsUserDir, {
          cloudPulledContainerNames,
          remotelyPrunedContainerNames,
        });
      } else {
        await cleanupStaleRootXgsDuplicates(effectiveXgsUserDir, mergedContainers.keys());
      }
    }

    if (firstUploadError) {
      throw firstUploadError;
    }

    if (lockAcquired && !keepLockHeld) {
      const hadWrites =
        Boolean(priorHadWrites) || uploadedContainers > 0 || deletedRemoteContainers > 0;
      await client.releaseLock(hadWrites, signal);
      lockAcquired = false;
    }

    const usedBytes = computeUsedBytes(mergedContainers);
    const remainingQuotaBytes = Math.max(0, quotaBytes - usedBytes);

    if (readOnlyFallback) {
      return {
        synced: true,
        mode,
        readOnlyFallback: true,
        resolvedScid: normalizedScid,
        resolvedWgsUserDir: wgsUserDir,
        quotaBytes,
        usedBytes,
        remainingQuotaBytes,
        downloadedContainers,
        uploadedContainers: 0,
        deletedRemoteContainers: 0,
        containerCount: mergedContainers.size,
        lockHeld: false,
      };
    }

    return {
      synced: true,
      mode,
      resolvedScid: normalizedScid,
      resolvedWgsUserDir: wgsUserDir,
      quotaBytes,
      usedBytes,
      remainingQuotaBytes,
      downloadedContainers,
      uploadedContainers,
      deletedRemoteContainers,
      containerCount: mergedContainers.size,
      lockHeld: lockAcquired,
      ...(conflictDetected ? { conflictDetected: true, conflictContainerNames } : {}),
    };
  } catch (err) {
    if (lockAcquired && !keepLockHeld) {
      const hadWrites =
        Boolean(priorHadWrites) || uploadedContainers > 0 || deletedRemoteContainers > 0;
      await client.releaseLock(hadWrites, signal);
    }
    throw err;
  }
}

/**
 * Acquires ONLY the lightweight Xbox Title Storage session lock (`PUT /lock`) without listing
 * or re-downloading containers (used when pre-launch sync already completed moments earlier).
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<{ locked: boolean, quotaBytes: number, resolvedScid: string, readOnlyFallback?: boolean, ownerChangeId?: string }>}
 */
async function acquireXboxTitleStorageSessionLock(options = {}) {
  const {
    xuid,
    scid,
    fallbackScid = '',
    msaAppId = '',
    titleId = '',
    authProvider,
    authorizationHeader,
    fetchImpl,
    signal,
  } = options;
  const packageFamilyName = options.packageFamilyName || options.pfn || '';
  const titleStorageOrigin =
    options.titleStorageOrigin || options.baseUrl || options.origin;
  const defaultQuota =
    Number(options.quotaBytes) > 0 ? Number(options.quotaBytes) : 256 * 1024 * 1024;
  const normalizedScid = String(scid || '').trim().toLowerCase();

  if (!xuid || !normalizedScid) {
    return {
      locked: false,
      quotaBytes: defaultQuota,
      resolvedScid: normalizedScid,
    };
  }

  /** @param {string} targetScid */
  const tryAcquire = async (targetScid) => {
    const client = createTitleStorageClient({
      xuid,
      scid: targetScid,
      packageFamilyName,
      msaAppId,
      titleId,
      titleStorageOrigin,
      allowLoopbackOrigin: options.allowLoopbackOrigin,
      authProvider,
      authorizationHeader,
      fetchImpl,
    });
    const lockInfo = await client.acquireLock(signal);
    return {
      locked: Boolean(lockInfo.locked),
      quotaBytes: Number(lockInfo.quotaBytes) > 0 ? Number(lockInfo.quotaBytes) : defaultQuota,
      resolvedScid: targetScid,
      ownerChangeId: lockInfo.ownerChangeId || '',
    };
  };

  try {
    return await tryAcquire(normalizedScid);
  } catch (/** @type {any} */ lockErr) {
    const explicitFallback = String(fallbackScid || '').trim().toLowerCase();
    const derivedFromTitleId = titleId ? deriveDefaultScidFromTitleId(titleId).toLowerCase() : '';
    const candidateFallback =
      VALID_SCID_UUID_RE.test(explicitFallback) && explicitFallback !== normalizedScid
        ? explicitFallback
        : VALID_SCID_UUID_RE.test(derivedFromTitleId) && derivedFromTitleId !== normalizedScid
          ? derivedFromTitleId
          : '';

    if (
      candidateFallback &&
      (lockErr?.status === 404 ||
        (lockErr?.status === 403 && Number(lockErr?.xblCode) !== 2016))
    ) {
      try {
        return await tryAcquire(candidateFallback);
      } catch (/** @type {any} */ fbErr) {
        if (
          fbErr?.status === 403 &&
          (fbErr?.xblCode === undefined || Number(fbErr?.xblCode) === 2016)
        ) {
          return {
            locked: false,
            readOnlyFallback: true,
            quotaBytes: defaultQuota,
            resolvedScid: candidateFallback,
          };
        }
        throw fbErr;
      }
    }
    if (
      lockErr?.status === 403 &&
      (lockErr?.xblCode === undefined || Number(lockErr?.xblCode) === 2016)
    ) {
      return {
        locked: false,
        readOnlyFallback: true,
        quotaBytes: defaultQuota,
        resolvedScid: normalizedScid,
      };
    }
    throw lockErr;
  }
}

/**
 * Releases an Xbox Title Storage session lock (`DELETE /lock`).
 * Supports both single-object `releaseXboxTitleStorageSessionLock(options)` and
 * two-argument `releaseXboxTitleStorageSessionLock(payload, options)` calling conventions.
 *
 * @param {Record<string, any>} [payloadOrOptions]
 * @param {Record<string, any>} [extraOptions]
 * @returns {Promise<boolean>}
 */
async function releaseXboxTitleStorageSessionLock(payloadOrOptions = {}, extraOptions = undefined) {
  const merged =
    extraOptions && typeof extraOptions === 'object'
      ? { ...(payloadOrOptions || {}), ...extraOptions }
      : { ...(payloadOrOptions || {}) };
  const xuid = merged.xuid || merged.xboxSession?.xuid || '';
  const scid = String(
    (extraOptions && typeof extraOptions === 'object'
      ? extraOptions.resolvedScid || extraOptions.scid
      : '') ||
      merged.resolvedScid ||
      merged.scid ||
      ''
  )
    .trim()
    .toLowerCase();
  if (!xuid || !scid) return false;
  const packageFamilyName = merged.packageFamilyName || merged.pfn || '';
  const titleStorageOrigin = merged.titleStorageOrigin || merged.baseUrl || merged.origin;
  const authorizationHeader =
    merged.authorizationHeader || merged.xboxSession?.authorizationHeader;
  const client = createTitleStorageClient({
    ...merged,
    xuid,
    scid,
    packageFamilyName,
    titleStorageOrigin,
    allowLoopbackOrigin: merged.allowLoopbackOrigin,
    authorizationHeader,
  });
  await client.releaseLock(Boolean(merged.hadWrites), merged.signal);
  return true;
}

module.exports = {
  LARGE_ATOM_THRESHOLD_BYTES,
  WGS_ATOM_SIDECAR_FILENAME,
  XGS_SYNC_SIDECAR_FILENAME,
  DEFAULT_TITLE_STORAGE_TIMEOUT_MS,
  validateTitleStorageOrigin,
  validateTitleStorageBlobUri,
  dateToFileTimeBigInt,
  fileTimeBigIntToIso,
  readWinGuidHexUpper,
  writeWinGuidHex,
  formatWgsUserScidFolderName,
  isValidTitleStorageContainerName,
  encodeTitleStorageContainerPath,
  resolveEffectiveXgsUserDir,
  sanitizePoisonedWgsContainersMap,
  parseWgsContainersIndex,
  serializeWgsContainersIndex,
  parseWgsContainerBlobIndex,
  serializeWgsContainerBlobIndex,
  loadWgsSyncSidecar,
  saveWgsSyncSidecar,
  loadXgsSyncSidecar,
  saveXgsSyncSidecar,
  readLocalWgsWorkspace,
  writeLocalWgsWorkspace,
  exportWgsToXgsFolder,
  importXgsFolderIntoWgs,
  createTitleStorageClient,
  syncXboxTitleStorage,
  acquireXboxTitleStorageSessionLock,
  releaseXboxTitleStorageSessionLock,
};
