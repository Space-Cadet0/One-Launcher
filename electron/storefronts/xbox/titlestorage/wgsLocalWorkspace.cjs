// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  toHostFilesystemPath,
  isContainedWithinRoot,
} = require('../../../launcher/securityAndPathUtils.cjs');
const {
  VALID_GUID_HEX32_RE,
  validateGuidHex32,
  generateUpperGuidHex,
  parseWgsContainersIndex,
  serializeWgsContainersIndex,
  parseWgsContainerBlobIndex,
  serializeWgsContainerBlobIndex,
} = require('./wgsBinaryFormat.cjs');

const WGS_ATOM_SIDECAR_FILENAME = '.onelauncher-wgs-sync.json';
const XGS_SYNC_SIDECAR_FILENAME = '.onelauncher-xgs-sync.json';
const STREAM_CHUNK_BYTES = 64 * 1024;
const MTIME_CACHE_SAFETY_WINDOW_MS = 2_000;
const MAX_METADATA_COMPARE_BYTES = 4 * 1024 * 1024;
const ZERO_GUID = '00000000000000000000000000000000';

/**
 * Ensures `targetPath` is strictly contained within `rootDir` (never equal to `rootDir`
 * and never escaping via `..` or Win32 prefix tricks).
 *
 * @param {string} rootDir
 * @param {string} targetPath
 * @param {string} [label]
 * @returns {string}
 */
function assertStrictlyContainedPath(rootDir, targetPath, label = 'path') {
  const resolvedRoot = path.resolve(toHostFilesystemPath(rootDir));
  const resolvedTarget = path.resolve(toHostFilesystemPath(targetPath));
  if (
    resolvedTarget === resolvedRoot ||
    !isContainedWithinRoot(resolvedRoot, resolvedTarget)
  ) {
    throw new Error(
      `Rejected ${label} escaping root directory: "${String(targetPath).slice(0, 120)}"`
    );
  }
  return resolvedTarget;
}

/**
 * Safely deletes a child directory strictly inside `rootDir` after verifying containment
 * with `isContainedWithinRoot` and refusing to follow symlinks.
 *
 * @param {string} rootDir
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
async function safeRemoveContainedDir(rootDir, targetPath) {
  const resolvedRoot = path.resolve(toHostFilesystemPath(rootDir));
  const resolvedTarget = path.resolve(toHostFilesystemPath(targetPath));
  if (
    resolvedTarget === resolvedRoot ||
    !isContainedWithinRoot(resolvedRoot, resolvedTarget)
  ) {
    return false;
  }
  const st = await fs.promises.lstat(resolvedTarget).catch(() => null);
  if (!st || st.isSymbolicLink()) {
    return false;
  }
  await fs.promises.rm(resolvedTarget, { recursive: true, force: true }).catch(() => {});
  return true;
}

/**
 * Computes the SHA-256 hex digest of a file on disk using a bounded 64 KiB read stream
 * so large save blobs (up to 256 MiB) never spike heap memory.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function hashFileStreaming(filePath) {
  const hostPath = toHostFilesystemPath(filePath);
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(hostPath, { highWaterMark: STREAM_CHUNK_BYTES });
    stream.on('data', (chunk) => {
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

/**
 * Renames `tmpPath` onto `hostTargetPath` with Windows transient-lock retry.
 *
 * @param {string} tmpPath
 * @param {string} hostTargetPath
 */
async function renameWithWin32Retry(tmpPath, hostTargetPath) {
  const maxAttempts = process.platform === 'win32' ? 4 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.promises.rename(tmpPath, hostTargetPath);
      return;
    } catch (/** @type {any} */ renameErr) {
      const code = renameErr?.code;
      if (
        attempt < maxAttempts &&
        (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')
      ) {
        await new Promise((r) => setTimeout(r, 15 * attempt));
        continue;
      }
      throw renameErr;
    }
  }
}

/**
 * Atomically writes `dataBuffer` to `targetPath` via temp file + `datasync()` + rename.
 *
 * @param {string} targetPath
 * @param {Buffer} dataBuffer
 */
async function writeFileAtomic(targetPath, dataBuffer) {
  const hostTargetPath = toHostFilesystemPath(targetPath);
  await fs.promises.mkdir(path.dirname(hostTargetPath), { recursive: true });
  const randHex = crypto.randomBytes(6).toString('hex');
  const tmpPath = `${hostTargetPath}.tmp.${process.pid}.${Date.now()}.${randHex}`;
  let fh = null;
  try {
    fh = await fs.promises.open(tmpPath, 'wx');
    await fh.writeFile(dataBuffer);
    await fh.datasync();
    await fh.close();
    fh = null;
    await renameWithWin32Retry(tmpPath, hostTargetPath);
  } catch (err) {
    if (fh) {
      await fh.close().catch(() => {});
    }
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Atomically writes a metadata buffer only if the destination file does not already contain
 * identical bytes (eliminates unnecessary `datasync()` write amplification).
 *
 * @param {string} targetPath
 * @param {Buffer} dataBuffer
 * @returns {Promise<boolean>} True if written, false if skipped because bytes matched
 */
async function writeFileAtomicIfChanged(targetPath, dataBuffer) {
  const hostTargetPath = toHostFilesystemPath(targetPath);
  if (dataBuffer.length <= MAX_METADATA_COMPARE_BYTES) {
    try {
      const existingStat = await fs.promises.stat(hostTargetPath);
      if (existingStat.isFile() && existingStat.size === dataBuffer.length) {
        const existingBuf = await fs.promises.readFile(hostTargetPath);
        if (existingBuf.equals(dataBuffer)) {
          return false;
        }
      }
    } catch {
      // Missing or unreadable target -> proceed with atomic write
    }
  }
  await writeFileAtomic(hostTargetPath, dataBuffer);
  return true;
}

/**
 * Atomically copies `sourcePath` to `targetPath` using bounded 64 KiB streaming chunks
 * + `datasync()` + atomic rename (never buffers full 256 MiB files in RAM).
 *
 * @param {string} sourcePath
 * @param {string} targetPath
 */
async function copyFileAtomicStreaming(sourcePath, targetPath) {
  const hostSourcePath = toHostFilesystemPath(sourcePath);
  const hostTargetPath = toHostFilesystemPath(targetPath);
  await fs.promises.mkdir(path.dirname(hostTargetPath), { recursive: true });
  const randHex = crypto.randomBytes(6).toString('hex');
  const tmpPath = `${hostTargetPath}.tmp.${process.pid}.${Date.now()}.${randHex}`;
  let srcFh = null;
  let dstFh = null;
  try {
    srcFh = await fs.promises.open(hostSourcePath, 'r');
    dstFh = await fs.promises.open(tmpPath, 'wx');
    const chunkBuf = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
    while (true) {
      const { bytesRead } = await srcFh.read(chunkBuf, 0, STREAM_CHUNK_BYTES, null);
      if (bytesRead <= 0) break;
      let writtenTotal = 0;
      while (writtenTotal < bytesRead) {
        const { bytesWritten } = await dstFh.write(
          chunkBuf,
          writtenTotal,
          bytesRead - writtenTotal
        );
        if (bytesWritten <= 0) {
          throw new Error(`Short write while streaming copy to ${hostTargetPath}`);
        }
        writtenTotal += bytesWritten;
      }
    }
    await dstFh.datasync();
    await dstFh.close();
    dstFh = null;
    await srcFh.close();
    srcFh = null;
    await renameWithWin32Retry(tmpPath, hostTargetPath);
  } catch (err) {
    if (srcFh) {
      await srcFh.close().catch(() => {});
    }
    if (dstFh) {
      await dstFh.close().catch(() => {});
    }
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * @param {string} wgsUserDir
 * @returns {Promise<{ containers: Record<string, any>, deletedContainers: string[] }>}
 */
async function loadWgsSyncSidecar(wgsUserDir) {
  const hostWgsUserDir = toHostFilesystemPath(wgsUserDir);
  const sidecarPath = path.join(hostWgsUserDir, WGS_ATOM_SIDECAR_FILENAME);
  try {
    const raw = await fs.promises.readFile(sidecarPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        containers:
          parsed.containers && typeof parsed.containers === 'object' ? parsed.containers : {},
        deletedContainers: Array.isArray(parsed.deletedContainers)
          ? parsed.deletedContainers
          : [],
      };
    }
  } catch {
    // Missing sidecar is normal on fresh or native Windows wgs directories
  }
  return { containers: {}, deletedContainers: [] };
}

/**
 * @param {string} wgsUserDir
 * @param {{ containers: Record<string, any>, deletedContainers: string[] }} sidecar
 */
async function saveWgsSyncSidecar(wgsUserDir, sidecar) {
  const hostWgsUserDir = toHostFilesystemPath(wgsUserDir);
  const sidecarPath = path.join(hostWgsUserDir, WGS_ATOM_SIDECAR_FILENAME);
  await writeFileAtomicIfChanged(
    sidecarPath,
    Buffer.from(JSON.stringify(sidecar, null, 2), 'utf8')
  );
}

/**
 * @param {string | null | undefined} effectiveXgsUserDir
 * @returns {Promise<{ exists: boolean, active: boolean, knownContainers: string[], deletedContainers: string[] }>}
 */
async function loadXgsSyncSidecar(effectiveXgsUserDir) {
  if (!effectiveXgsUserDir) {
    return { exists: false, active: false, knownContainers: [], deletedContainers: [] };
  }
  const hostXgsDir = toHostFilesystemPath(effectiveXgsUserDir);
  const sidecarPath = path.join(hostXgsDir, XGS_SYNC_SIDECAR_FILENAME);
  try {
    const raw = await fs.promises.readFile(sidecarPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        exists: true,
        active: Boolean(parsed.active),
        knownContainers: Array.isArray(parsed.knownContainers) ? parsed.knownContainers : [],
        deletedContainers: Array.isArray(parsed.deletedContainers)
          ? parsed.deletedContainers
          : [],
      };
    }
  } catch {
    // No sidecar yet
  }
  return { exists: false, active: false, knownContainers: [], deletedContainers: [] };
}

/**
 * @param {string | null | undefined} effectiveXgsUserDir
 * @param {{ active?: boolean, knownContainers?: string[], deletedContainers?: string[] }} meta
 */
async function saveXgsSyncSidecar(effectiveXgsUserDir, meta) {
  if (!effectiveXgsUserDir) return;
  const hostXgsDir = toHostFilesystemPath(effectiveXgsUserDir);
  await fs.promises.mkdir(hostXgsDir, { recursive: true });
  const sidecarPath = path.join(hostXgsDir, XGS_SYNC_SIDECAR_FILENAME);
  const payload = {
    active: Boolean(meta.active),
    knownContainers: Array.from(new Set(meta.knownContainers || [])),
    deletedContainers: Array.from(new Set(meta.deletedContainers || [])),
    updatedAt: new Date().toISOString(),
  };
  await writeFileAtomic(sidecarPath, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
}

/**
 * Checks whether cached sidecar blob metadata can safely skip re-hashing the on-disk file.
 *
 * @param {any} atomMeta
 * @param {fs.Stats} st
 * @param {string} chosenGuid
 * @param {number} nowMs
 * @returns {boolean}
 */
function canReuseSidecarSha256(atomMeta, st, chosenGuid, nowMs) {
  if (!atomMeta || typeof atomMeta.sha256 !== 'string' || !atomMeta.sha256) return false;
  if (atomMeta.blobGuid && String(atomMeta.blobGuid).toUpperCase() !== chosenGuid) return false;
  if (typeof atomMeta.size !== 'number' || atomMeta.size !== st.size) return false;
  if (typeof atomMeta.mtimeMs !== 'number' || Math.abs(atomMeta.mtimeMs - st.mtimeMs) >= 0.001) {
    return false;
  }
  if (atomMeta.ino && st.ino && atomMeta.ino !== st.ino) return false;
  // Always stream-hash files modified within the last 2s to guard against coarse filesystem mtime
  if (nowMs - st.mtimeMs < MTIME_CACHE_SAFETY_WINDOW_MS) return false;
  return true;
}

/**
 * Reads all containers and blob descriptors from a local `wgs\<HexXuid>_<Scid>` directory.
 * When `options.lazy === true`, blobs are metadata-checked and stream-hashed without loading
 * up to 256 MiB of payloads into heap memory (providing `readData()` for on-demand reads).
 *
 * @param {string} wgsUserDir
 * @param {{ lazy?: boolean }} [options]
 */
async function readLocalWgsWorkspace(wgsUserDir, options = {}) {
  const lazy = Boolean(options?.lazy);
  const hostWgsUserDir = toHostFilesystemPath(wgsUserDir);
  const indexPath = path.join(hostWgsUserDir, 'containers.index');
  const sidecar = await loadWgsSyncSidecar(hostWgsUserDir);

  let indexBuf;
  try {
    indexBuf = await fs.promises.readFile(indexPath);
  } catch (/** @type {any} */ err) {
    if (err && err.code === 'ENOENT') {
      return {
        exists: false,
        index: null,
        containers: new Map(),
        sidecar,
      };
    }
    throw err;
  }

  const index = parseWgsContainersIndex(indexBuf);
  const containers = new Map();
  const nowMs = Date.now();

  for (const cEntry of index.containers) {
    if (!VALID_GUID_HEX32_RE.test(cEntry.folderGuid)) continue;
    const containerDir = assertStrictlyContainedPath(
      hostWgsUserDir,
      path.join(hostWgsUserDir, cEntry.folderGuid),
      'wgs containerDir'
    );
    const containerFile = path.join(containerDir, `container.${cEntry.containerNum}`);
    let blobRecords = [];
    try {
      const cBuf = await fs.promises.readFile(containerFile);
      blobRecords = parseWgsContainerBlobIndex(cBuf).blobs;
    } catch {
      blobRecords = [];
    }

    const sidecarContainer = sidecar.containers[cEntry.name] || {};
    const sidecarAtoms = sidecarContainer.atoms || {};
    const blobs = new Map();

    for (const bRec of blobRecords) {
      let chosenGuid = '';
      let chosenPath = '';
      /** @type {fs.Stats | null} */
      let chosenStat = null;
      for (const candidate of [bRec.blobGuidA, bRec.blobGuidB]) {
        if (!candidate || candidate === ZERO_GUID || !VALID_GUID_HEX32_RE.test(candidate)) {
          continue;
        }
        const candPath = assertStrictlyContainedPath(
          containerDir,
          path.join(containerDir, candidate),
          'wgs blobPath'
        );
        const st = await fs.promises.stat(candPath).catch(() => null);
        if (st && st.isFile()) {
          chosenGuid = candidate;
          chosenPath = candPath;
          chosenStat = st;
          break;
        }
      }
      if (!chosenStat || !chosenPath) continue;

      const atomMeta = sidecarAtoms[bRec.name] || null;
      let data = null;
      let sha256 = '';
      if (lazy) {
        if (canReuseSidecarSha256(atomMeta, chosenStat, chosenGuid, nowMs)) {
          sha256 = atomMeta.sha256;
        } else {
          sha256 = await hashFileStreaming(chosenPath);
        }
      } else {
        data = await fs.promises.readFile(chosenPath);
        sha256 = crypto.createHash('sha256').update(data).digest('hex');
      }

      const unchangedAtom =
        atomMeta && atomMeta.sha256 === sha256 && atomMeta.atom ? atomMeta.atom : '';

      /** @type {Record<string, any>} */
      const blobEntry = {
        name: bRec.name,
        blobGuid: chosenGuid,
        filePath: chosenPath,
        size: chosenStat.size,
        mtimeMs: chosenStat.mtimeMs,
        ino: chosenStat.ino || 0,
        sha256,
        atom: unchangedAtom,
        readData: () => fs.promises.readFile(chosenPath),
      };
      if (!lazy) {
        blobEntry.data = data;
      }

      blobs.set(bRec.name, blobEntry);
    }

    containers.set(cEntry.name, {
      ...cEntry,
      remoteClientFileTime: sidecarContainer.remoteClientFileTime || '',
      etag: sidecarContainer.etag || cEntry.tag || '',
      blobs,
    });
  }

  return {
    exists: true,
    index,
    containers,
    sidecar,
  };
}

/**
 * Resolves whether an existing blob file on disk already matches the desired content so
 * `writeLocalWgsWorkspace` can skip redundant temp-file creation and `datasync()` flushes.
 *
 * @param {string} blobFilePath
 * @param {number} expectedSize
 * @param {string} expectedSha256
 * @param {any} priorSidecarAtom
 * @param {string} blobGuid
 * @returns {Promise<fs.Stats | null>}
 */
async function matchExistingBlobOnDisk(
  blobFilePath,
  expectedSize,
  expectedSha256,
  priorSidecarAtom,
  blobGuid
) {
  const existingStat = await fs.promises.stat(blobFilePath).catch(() => null);
  if (!existingStat || !existingStat.isFile() || existingStat.size !== expectedSize) {
    return null;
  }
  if (
    expectedSha256 &&
    canReuseSidecarSha256(priorSidecarAtom, existingStat, blobGuid, Date.now()) &&
    priorSidecarAtom.sha256 === expectedSha256
  ) {
    return existingStat;
  }
  if (expectedSha256) {
    const existingSha = await hashFileStreaming(blobFilePath).catch(() => '');
    if (existingSha === expectedSha256) {
      return existingStat;
    }
  }
  return null;
}

/**
 * Writes container/blob state atomically into `wgs\<HexXuid>_<Scid>\`
 * (`containers.index`, `<FOLDER_GUID>\container.<N>`, `<BLOB_GUID>`, and sync sidecar),
 * skipping `datasync()` rewrites for unchanged blobs and unchanged metadata files, and
 * enforcing `isContainedWithinRoot` before any write or orphan cleanup `fs.promises.rm`.
 *
 * @param {string} wgsUserDir
 * @param {Record<string, any>} [options]
 */
async function writeLocalWgsWorkspace(wgsUserDir, options = {}) {
  const hostWgsUserDir = path.resolve(toHostFilesystemPath(wgsUserDir));
  const {
    containers = [],
    storePkgAumid = '',
    pkgDisplayName = '',
    syncMetadataId = '',
    deletedContainers = [],
    creationFileTime,
  } = options;

  await fs.promises.mkdir(hostWgsUserDir, { recursive: true });
  const priorSidecar = await loadWgsSyncSidecar(hostWgsUserDir);

  let preservedCreationFileTime = typeof creationFileTime === 'bigint' ? creationFileTime : undefined;
  if (preservedCreationFileTime === undefined) {
    try {
      const existingIndexBuf = await fs.promises.readFile(
        path.join(hostWgsUserDir, 'containers.index')
      );
      preservedCreationFileTime = parseWgsContainersIndex(existingIndexBuf).creationFileTime;
    } catch {
      preservedCreationFileTime = undefined;
    }
  }

  const indexEntries = [];
  const sidecar = {
    containers: /** @type {Record<string, any>} */ ({}),
    deletedContainers: Array.from(new Set(deletedContainers)),
  };
  const activeFolderGuids = new Set();

  for (const c of containers) {
    const folderGuid = validateGuidHex32(c.folderGuid || generateUpperGuidHex(), 'folderGuid');
    activeFolderGuids.add(folderGuid);
    const containerNum =
      Number.isInteger(c.containerNum) && c.containerNum > 0 ? c.containerNum : 1;
    const containerDir = assertStrictlyContainedPath(
      hostWgsUserDir,
      path.join(hostWgsUserDir, folderGuid),
      'wgs containerDir'
    );
    await fs.promises.mkdir(containerDir, { recursive: true });

    const priorContainerAtoms = priorSidecar.containers?.[c.name]?.atoms || {};
    const blobInputList =
      c.blobs instanceof Map ? Array.from(c.blobs.values()) : Array.isArray(c.blobs) ? c.blobs : [];
    const blobIndexEntries = [];
    const sidecarAtoms = /** @type {Record<string, any>} */ ({});
    let totalSize = 0;

    for (const b of blobInputList) {
      const blobGuid = validateGuidHex32(b.blobGuid || generateUpperGuidHex(), 'blobGuid');
      const blobFilePath = assertStrictlyContainedPath(
        containerDir,
        path.join(containerDir, blobGuid),
        'wgs blobFilePath'
      );
      const priorAtomMeta = priorContainerAtoms[b.name] || null;

      let sha256 = typeof b.sha256 === 'string' ? b.sha256 : '';
      let blobSize = 0;
      /** @type {fs.Stats | null} */
      let finalStat = null;

      const hasInlineData = b.data !== undefined && b.data !== null;
      const sourcePath = typeof b.sourcePath === 'string' && b.sourcePath ? b.sourcePath : '';
      const existingFilePath = typeof b.filePath === 'string' && b.filePath ? b.filePath : '';

      if (!hasInlineData && !sourcePath && existingFilePath) {
        const resolvedExisting = path.resolve(toHostFilesystemPath(existingFilePath));
        if (resolvedExisting === blobFilePath) {
          const st = await fs.promises.stat(blobFilePath).catch(() => null);
          if (!st || !st.isFile()) {
            throw new Error(`Expected lazy WGS blob file missing on disk: ${blobFilePath}`);
          }
          finalStat = st;
          blobSize = st.size;
          if (!sha256) {
            sha256 = await hashFileStreaming(blobFilePath);
          }
        } else {
          const srcStat = await fs.promises.stat(resolvedExisting);
          blobSize = srcStat.size;
          if (!sha256) {
            sha256 = await hashFileStreaming(resolvedExisting);
          }
          const matched = await matchExistingBlobOnDisk(
            blobFilePath,
            blobSize,
            sha256,
            priorAtomMeta,
            blobGuid
          );
          if (matched) {
            finalStat = matched;
          } else {
            await copyFileAtomicStreaming(resolvedExisting, blobFilePath);
            finalStat = await fs.promises.stat(blobFilePath);
          }
        }
      } else if (!hasInlineData && sourcePath) {
        const resolvedSrc = path.resolve(toHostFilesystemPath(sourcePath));
        const srcStat = await fs.promises.stat(resolvedSrc);
        blobSize = srcStat.size;
        if (!sha256) {
          sha256 = await hashFileStreaming(resolvedSrc);
        }
        const matched = await matchExistingBlobOnDisk(
          blobFilePath,
          blobSize,
          sha256,
          priorAtomMeta,
          blobGuid
        );
        if (matched) {
          finalStat = matched;
        } else {
          await copyFileAtomicStreaming(resolvedSrc, blobFilePath);
          finalStat = await fs.promises.stat(blobFilePath);
        }
      } else {
        const buf = Buffer.isBuffer(b.data) ? b.data : Buffer.from(b.data || '');
        blobSize = buf.length;
        if (!sha256) {
          sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        }
        const matched = await matchExistingBlobOnDisk(
          blobFilePath,
          blobSize,
          sha256,
          priorAtomMeta,
          blobGuid
        );
        if (matched) {
          finalStat = matched;
        } else {
          await writeFileAtomic(blobFilePath, buf);
          finalStat = await fs.promises.stat(blobFilePath);
        }
      }

      blobIndexEntries.push({
        name: b.name,
        blobGuidA: blobGuid,
        blobGuidB: ZERO_GUID,
      });

      sidecarAtoms[b.name] = {
        ...(b.atom ? { atom: b.atom } : {}),
        sha256,
        size: blobSize,
        blobGuid,
        mtimeMs: finalStat ? finalStat.mtimeMs : Date.now(),
        ino: finalStat ? finalStat.ino || 0 : 0,
      };
      totalSize += blobSize;
    }

    const containerNBytes = serializeWgsContainerBlobIndex(blobIndexEntries, 4);
    await writeFileAtomicIfChanged(
      path.join(containerDir, `container.${containerNum}`),
      containerNBytes
    );

    const modifiedIso = c.modifiedIso || new Date().toISOString();
    indexEntries.push({
      name: c.name,
      displayName: c.displayName || c.name,
      tag: c.etag || c.tag || '',
      containerNum,
      stateFlags: c.dirty ? 1 : 0,
      dirty: Boolean(c.dirty),
      folderGuid,
      modifiedIso,
      totalSize,
    });

    sidecar.containers[c.name] = {
      remoteClientFileTime: c.remoteClientFileTime || '',
      etag: c.etag || c.tag || '',
      atoms: sidecarAtoms,
    };
  }

  const indexBytes = serializeWgsContainersIndex({
    version: 14,
    pkgDisplayName,
    storePkgAumid,
    syncMetadataId,
    ...(preservedCreationFileTime !== undefined
      ? { creationFileTime: preservedCreationFileTime }
      : {}),
    containers: indexEntries,
  });

  await writeFileAtomicIfChanged(path.join(hostWgsUserDir, 'containers.index'), indexBytes);
  await saveWgsSyncSidecar(hostWgsUserDir, sidecar);

  // Clean up orphaned container GUID directories removed during sync (strictly guarded by isContainedWithinRoot)
  const entries = await fs.promises.readdir(hostWgsUserDir, { withFileTypes: true }).catch(() => []);
  for (const dirent of entries) {
    if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue;
    if (
      VALID_GUID_HEX32_RE.test(dirent.name) &&
      !activeFolderGuids.has(dirent.name.toUpperCase())
    ) {
      await safeRemoveContainedDir(hostWgsUserDir, path.join(hostWgsUserDir, dirent.name));
    }
  }
}

module.exports = {
  WGS_ATOM_SIDECAR_FILENAME,
  XGS_SYNC_SIDECAR_FILENAME,
  assertStrictlyContainedPath,
  safeRemoveContainedDir,
  hashFileStreaming,
  writeFileAtomic,
  writeFileAtomicIfChanged,
  copyFileAtomicStreaming,
  loadWgsSyncSidecar,
  saveWgsSyncSidecar,
  loadXgsSyncSidecar,
  saveXgsSyncSidecar,
  readLocalWgsWorkspace,
  writeLocalWgsWorkspace,
};
