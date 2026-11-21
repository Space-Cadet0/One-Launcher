// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { toHostFilesystemPath } = require('../../../launcher/securityAndPathUtils.cjs');
const {
  WGS_USER_SCID_DIR_RE,
  POISONED_USER_SCID_PREFIX_RE,
  generateUpperGuidHex,
  isValidTitleStorageContainerName,
} = require('./wgsBinaryFormat.cjs');
const {
  assertStrictlyContainedPath,
  safeRemoveContainedDir,
  hashFileStreaming,
  writeFileAtomic,
  copyFileAtomicStreaming,
  loadXgsSyncSidecar,
  saveXgsSyncSidecar,
  readLocalWgsWorkspace,
  writeLocalWgsWorkspace,
} = require('./wgsLocalWorkspace.cjs');

/**
 * Ensures `xgsUserDir` points to `.../SystemAppData/xgs/<HexXuid>_<Scid>` when `wgsUserDir`
 * is user-scoped (`.../SystemAppData/wgs/<HexXuid>_<Scid>`) and a caller mistakenly passed
 * `.../SystemAppData/xgs`.
 *
 * @param {string | null | undefined} xgsUserDir
 * @param {string | null | undefined} wgsUserDir
 * @returns {string | null}
 */
function resolveEffectiveXgsUserDir(xgsUserDir, wgsUserDir) {
  if (!xgsUserDir) return null;
  const cleanXgs = String(xgsUserDir).trim();
  if (!cleanXgs) return null;
  if (wgsUserDir) {
    const wgsBase = path.basename(String(wgsUserDir).trim());
    const xgsBase = path.basename(cleanXgs);
    if (WGS_USER_SCID_DIR_RE.test(wgsBase) && xgsBase.toLowerCase() === 'xgs') {
      return path.join(cleanXgs, wgsBase);
    }
  }
  return cleanXgs;
}

/**
 * Self-heals `containers.index` workspaces that were previously poisoned by walking `SystemAppData/xgs`
 * instead of `SystemAppData/xgs/<HexXuid>_<Scid>`, producing `<HexXuid>_<Scid>/<containerName>` duplicates.
 *
 * @param {Map<string, any> | null | undefined} containersMap
 * @param {Set<string> | null} [pendingDeletionsSet]
 * @returns {boolean}
 */
function sanitizePoisonedWgsContainersMap(containersMap, pendingDeletionsSet = null) {
  let mutated = false;
  if (pendingDeletionsSet && typeof pendingDeletionsSet.values === 'function') {
    for (const delName of Array.from(pendingDeletionsSet.values())) {
      if (
        POISONED_USER_SCID_PREFIX_RE.test(String(delName)) ||
        !isValidTitleStorageContainerName(String(delName))
      ) {
        pendingDeletionsSet.delete(delName);
        mutated = true;
      }
    }
  }
  if (!containersMap || typeof containersMap.entries !== 'function') return mutated;

  for (const [cName, container] of Array.from(containersMap.entries())) {
    const poisonedMatch = POISONED_USER_SCID_PREFIX_RE.exec(String(cName));
    if (poisonedMatch) {
      const cleanName = poisonedMatch[2];
      containersMap.delete(cName);
      mutated = true;
      if (isValidTitleStorageContainerName(cleanName) && !containersMap.has(cleanName)) {
        containersMap.set(cleanName, {
          ...container,
          name: cleanName,
          displayName:
            container.displayName && container.displayName !== cName
              ? container.displayName
              : cleanName,
        });
      }
    }
  }
  return mutated;
}

/**
 * Cleans stale root `SystemAppData/xgs/<container>` duplicate directories when user-scoped
 * `xgs/<HexXuid>_<Scid>` is active, strictly guarded by `isContainedWithinRoot`.
 *
 * @param {string | null | undefined} effectiveXgsUserDir
 * @param {Iterable<string>} containerNamesIterable
 */
async function cleanupStaleRootXgsDuplicates(effectiveXgsUserDir, containerNamesIterable) {
  if (!effectiveXgsUserDir) return;
  const hostXgsDir = path.resolve(toHostFilesystemPath(effectiveXgsUserDir));
  const userBase = path.basename(hostXgsDir);
  if (!WGS_USER_SCID_DIR_RE.test(userBase)) return;
  const parentDir = path.dirname(hostXgsDir);
  if (path.basename(parentDir).toLowerCase() !== 'xgs') return;

  const topSegments = new Set();
  for (const rawName of containerNamesIterable || []) {
    const clean = String(rawName || '').replace(/\\/g, '/').split('/')[0];
    if (clean && clean !== '.' && clean !== '..' && !WGS_USER_SCID_DIR_RE.test(clean)) {
      topSegments.add(clean);
    }
  }
  for (const seg of topSegments) {
    const staleRootCopy = path.join(parentDir, seg);
    const st = await fs.promises.lstat(staleRootCopy).catch(() => null);
    if (st && st.isDirectory() && !st.isSymbolicLink()) {
      await safeRemoveContainedDir(parentDir, staleRootCopy);
    }
  }
}

/**
 * Walks an `xgs/<HexXuid>_<Scid>` tree and collects per-blob file metadata WITHOUT
 * reading file bytes into RAM (eliminates the 512 MiB double-buffered WGS+XGS spike).
 *
 * @param {string} effectiveXgsUserDir
 * @returns {Promise<Map<string, Map<string, { filePath: string, size: number, mtimeMs: number, ino: number }>>>}
 */
async function discoverXgsContainersMetadataOnDisk(effectiveXgsUserDir) {
  /** @type {Map<string, Map<string, { filePath: string, size: number, mtimeMs: number, ino: number }>>} */
  const discovered = new Map();
  const hostXgsDir = path.resolve(toHostFilesystemPath(effectiveXgsUserDir));
  const st = await fs.promises.stat(hostXgsDir).catch(() => null);
  if (!st || !st.isDirectory()) return discovered;

  /**
   * @param {string} curDir
   * @param {string[]} relParts
   */
  const walk = async (curDir, relParts) => {
    const dirents = await fs.promises.readdir(curDir, { withFileTypes: true });
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue;
      if (WGS_USER_SCID_DIR_RE.test(d.name)) continue;
      if (d.isSymbolicLink()) continue;
      const full = path.join(curDir, d.name);
      if (d.isDirectory()) {
        await walk(full, [...relParts, d.name]);
      } else if (d.isFile() && relParts.length > 0) {
        const containerName = relParts.join('/');
        if (!isValidTitleStorageContainerName(containerName)) continue;
        const fileStat = await fs.promises.stat(full).catch(() => null);
        if (!fileStat || !fileStat.isFile()) continue;
        let containerBlobs = discovered.get(containerName);
        if (!containerBlobs) {
          containerBlobs = new Map();
          discovered.set(containerName, containerBlobs);
        }
        containerBlobs.set(d.name, {
          filePath: full,
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          ino: fileStat.ino || 0,
        });
      }
    }
  };

  await walk(hostXgsDir, []);
  return discovered;
}

/**
 * Exports a local `wgs` workspace into `xgs/` folder mode using lazy streaming copies,
 * `isContainedWithinRoot` guards before any recursive delete or write, and unchanged-file skipping.
 *
 * @param {string} wgsUserDir
 * @param {string | null | undefined} xgsUserDir
 * @param {Record<string, any>} [options]
 */
async function exportWgsToXgsFolder(wgsUserDir, xgsUserDir, options = {}) {
  const rawEffectiveXgsUserDir = resolveEffectiveXgsUserDir(xgsUserDir, wgsUserDir);
  if (!rawEffectiveXgsUserDir) return;
  const effectiveXgsUserDir = path.resolve(toHostFilesystemPath(rawEffectiveXgsUserDir));
  const hostWgsUserDir = toHostFilesystemPath(wgsUserDir);
  const workspace = await readLocalWgsWorkspace(hostWgsUserDir, { lazy: true });
  const xgsMeta = await loadXgsSyncSidecar(effectiveXgsUserDir);
  const existingOnDisk = await discoverXgsContainersMetadataOnDisk(effectiveXgsUserDir);

  await fs.promises.mkdir(effectiveXgsUserDir, { recursive: true });

  // Only seed xgs/ from legacy wgs/ when xgs/ has zero existing sync metadata/history.
  const isXgsAlreadyActive =
    xgsMeta.exists ||
    xgsMeta.active ||
    xgsMeta.knownContainers.length > 0 ||
    xgsMeta.deletedContainers.length > 0 ||
    existingOnDisk.size > 0;

  const tombstonedSet = new Set([
    ...(workspace.sidecar.deletedContainers || []),
    ...(xgsMeta.deletedContainers || []),
  ]);
  const knownSet = new Set([...xgsMeta.knownContainers, ...existingOnDisk.keys()]);
  const cloudPulledSet =
    options.cloudPulledContainerNames instanceof Set
      ? options.cloudPulledContainerNames
      : Array.isArray(options.cloudPulledContainerNames)
        ? new Set(options.cloudPulledContainerNames)
        : null;
  const remotelyPrunedSet =
    options.remotelyPrunedContainerNames instanceof Set
      ? options.remotelyPrunedContainerNames
      : Array.isArray(options.remotelyPrunedContainerNames)
        ? new Set(options.remotelyPrunedContainerNames)
        : null;

  if (remotelyPrunedSet && remotelyPrunedSet.size > 0) {
    for (const prunedName of remotelyPrunedSet) {
      const normalizedPruned = String(prunedName || '').replace(/\\/g, '/');
      if (isValidTitleStorageContainerName(normalizedPruned)) {
        const safeParts = normalizedPruned
          .split('/')
          .filter((p) => p && p !== '.' && p !== '..');
        if (safeParts.length > 0) {
          const prunedDir = path.join(effectiveXgsUserDir, ...safeParts);
          await safeRemoveContainedDir(effectiveXgsUserDir, prunedDir);
        }
      }
      knownSet.delete(prunedName);
      tombstonedSet.add(prunedName);
    }
  }

  if (!workspace.exists) {
    if (isXgsAlreadyActive) {
      await saveXgsSyncSidecar(effectiveXgsUserDir, {
        active: true,
        knownContainers: Array.from(knownSet),
        deletedContainers: Array.from(tombstonedSet),
      });
    }
    return;
  }

  let wroteAny = false;
  for (const container of workspace.containers.values()) {
    const rawName = String(container.name || '').replace(/\\/g, '/');
    if (!isValidTitleStorageContainerName(rawName)) continue;
    if (tombstonedSet.has(rawName)) continue;

    // When xgs/ is already active, ONLY materialize explicitly newly cloud-pulled containers
    if (isXgsAlreadyActive) {
      if (!cloudPulledSet || !cloudPulledSet.has(rawName)) {
        continue;
      }
    }

    const safeRelParts = rawName.split('/').filter((p) => p && p !== '.' && p !== '..');
    if (safeRelParts.length === 0) continue;
    const cDir = assertStrictlyContainedPath(
      effectiveXgsUserDir,
      path.join(effectiveXgsUserDir, ...safeRelParts),
      'xgs containerDir'
    );
    await fs.promises.mkdir(cDir, { recursive: true });
    for (const blob of container.blobs.values()) {
      const safeBlobName = path.basename(String(blob.name || '').replace(/\\/g, '/'));
      if (!safeBlobName || safeBlobName === '.' || safeBlobName === '..') continue;
      const dstPath = assertStrictlyContainedPath(
        cDir,
        path.join(cDir, safeBlobName),
        'xgs blobPath'
      );

      // Skip rewriting unchanged xgs/ files when size & sha256 already match
      const existingDstStat = await fs.promises.stat(dstPath).catch(() => null);
      if (
        existingDstStat &&
        existingDstStat.isFile() &&
        existingDstStat.size === blob.size &&
        blob.sha256
      ) {
        const dstSha = await hashFileStreaming(dstPath).catch(() => '');
        if (dstSha === blob.sha256) {
          continue;
        }
      }

      if (blob.filePath) {
        await copyFileAtomicStreaming(blob.filePath, dstPath);
      } else if (Buffer.isBuffer(blob.data)) {
        await writeFileAtomic(dstPath, blob.data);
      } else if (typeof blob.readData === 'function') {
        const data = await blob.readData();
        await writeFileAtomic(dstPath, data);
      }
    }
    knownSet.add(rawName);
    wroteAny = true;
  }

  if (wroteAny || isXgsAlreadyActive || workspace.containers.size > 0) {
    await saveXgsSyncSidecar(effectiveXgsUserDir, {
      active: true,
      knownContainers: Array.from(knownSet),
      deletedContainers: Array.from(tombstonedSet),
    });
  }

  await cleanupStaleRootXgsDuplicates(effectiveXgsUserDir, workspace.containers.keys());
}

/**
 * Imports changes and save-slot deletions from `xgs/` into binary `wgs` format using
 * lazy metadata inspection + streaming SHA-256 comparison (zero double-buffering in RAM).
 *
 * @param {string | null | undefined} xgsUserDir
 * @param {string} wgsUserDir
 * @param {string} [storePkgAumid]
 * @returns {Promise<boolean>}
 */
async function importXgsFolderIntoWgs(xgsUserDir, wgsUserDir, storePkgAumid = '') {
  const effectiveXgsUserDir = resolveEffectiveXgsUserDir(xgsUserDir, wgsUserDir);
  if (!effectiveXgsUserDir) return false;
  const hostXgsDir = toHostFilesystemPath(effectiveXgsUserDir);
  const st = await fs.promises.stat(hostXgsDir).catch(() => null);
  if (!st || !st.isDirectory()) return false;

  const workspace = await readLocalWgsWorkspace(wgsUserDir, { lazy: true });
  const xgsMeta = await loadXgsSyncSidecar(effectiveXgsUserDir);
  const pendingDeletionsSet = new Set(workspace.sidecar.deletedContainers || []);
  const xgsKnownSet = new Set(xgsMeta.knownContainers || []);
  const xgsDeletedSet = new Set(xgsMeta.deletedContainers || []);
  let anyMutated = sanitizePoisonedWgsContainersMap(workspace.containers, pendingDeletionsSet);

  const discovered = await discoverXgsContainersMetadataOnDisk(effectiveXgsUserDir);
  const xgsHasHistory =
    xgsMeta.exists ||
    xgsMeta.active ||
    xgsKnownSet.size > 0 ||
    xgsDeletedSet.size > 0 ||
    discovered.size > 0;

  if (discovered.size === 0 && !workspace.exists && !xgsHasHistory) return false;

  const updatedContainers = [];
  let xgsMetaMutated = false;

  // Check existing containers for modifications or save-slot deletions in xgs/
  for (const [cName, existing] of workspace.containers.entries()) {
    if (!discovered.has(cName)) {
      if (xgsKnownSet.has(cName) || xgsDeletedSet.has(cName)) {
        pendingDeletionsSet.add(cName);
        xgsDeletedSet.add(cName);
        xgsKnownSet.delete(cName);
        anyMutated = true;
        xgsMetaMutated = true;
        continue;
      }
      updatedContainers.push(existing);
      continue;
    }
    const diskBlobs = discovered.get(cName);
    discovered.delete(cName);
    if (!xgsKnownSet.has(cName)) {
      xgsKnownSet.add(cName);
      xgsMetaMutated = true;
    }
    if (xgsDeletedSet.delete(cName)) {
      xgsMetaMutated = true;
    }
    pendingDeletionsSet.delete(cName);

    let containerDirty = Boolean(existing.dirty);
    const mergedBlobs = [];

    if (!diskBlobs || diskBlobs.size !== existing.blobs.size) {
      containerDirty = true;
    }

    if (diskBlobs) {
      for (const [bName, diskMeta] of diskBlobs.entries()) {
        const prev = existing.blobs.get(bName);
        const diskSha256 = await hashFileStreaming(diskMeta.filePath);
        if (!prev || prev.size !== diskMeta.size || prev.sha256 !== diskSha256) {
          containerDirty = true;
          mergedBlobs.push({
            name: bName,
            blobGuid: prev?.blobGuid || generateUpperGuidHex(),
            sourcePath: diskMeta.filePath,
            size: diskMeta.size,
            sha256: diskSha256,
            atom: '',
          });
        } else {
          mergedBlobs.push(prev);
        }
      }
    }

    if (containerDirty) anyMutated = true;
    updatedContainers.push({
      ...existing,
      dirty: containerDirty,
      modifiedIso: containerDirty ? new Date().toISOString() : existing.modifiedIso,
      blobs: mergedBlobs,
    });
  }

  // Add newly created xgs/ subfolders as dirty Connected Storage containers
  for (const [cName, diskBlobs] of discovered.entries()) {
    if (!isValidTitleStorageContainerName(cName)) continue;
    anyMutated = true;
    xgsMetaMutated = true;
    xgsKnownSet.add(cName);
    xgsDeletedSet.delete(cName);
    pendingDeletionsSet.delete(cName);

    const blobs = [];
    for (const [bName, diskMeta] of diskBlobs.entries()) {
      const diskSha256 = await hashFileStreaming(diskMeta.filePath);
      blobs.push({
        name: bName,
        blobGuid: generateUpperGuidHex(),
        sourcePath: diskMeta.filePath,
        size: diskMeta.size,
        sha256: diskSha256,
        atom: '',
      });
    }
    updatedContainers.push({
      name: cName,
      displayName: cName,
      containerNum: 1,
      dirty: true,
      folderGuid: generateUpperGuidHex(),
      modifiedIso: new Date().toISOString(),
      blobs,
    });
  }

  const deletedContainers = Array.from(pendingDeletionsSet);

  if (anyMutated) {
    await writeLocalWgsWorkspace(wgsUserDir, {
      containers: updatedContainers,
      storePkgAumid: workspace.index?.storePkgAumid || storePkgAumid,
      pkgDisplayName: workspace.index?.pkgDisplayName || '',
      syncMetadataId: workspace.index?.syncMetadataId || '',
      creationFileTime: workspace.index?.creationFileTime,
      deletedContainers,
    });
  }

  if (xgsMetaMutated || (discovered.size > 0 && !xgsMeta.active)) {
    await saveXgsSyncSidecar(effectiveXgsUserDir, {
      active: true,
      knownContainers: Array.from(xgsKnownSet),
      deletedContainers: Array.from(xgsDeletedSet),
    });
  }

  return anyMutated;
}

module.exports = {
  resolveEffectiveXgsUserDir,
  sanitizePoisonedWgsContainersMap,
  cleanupStaleRootXgsDuplicates,
  discoverXgsContainersMetadataOnDisk,
  exportWgsToXgsFolder,
  importXgsFolderIntoWgs,
};
