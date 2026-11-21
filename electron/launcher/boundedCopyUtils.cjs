// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { diagLog } = require('../utils/diagnosticLogger.cjs');

const FICLONE_FLAG =
  fs.constants && typeof fs.constants.COPYFILE_FICLONE === 'number'
    ? fs.constants.COPYFILE_FICLONE
    : 0;

const COPYFILE_EXCL_FLAG =
  fs.constants && typeof fs.constants.COPYFILE_EXCL === 'number'
    ? fs.constants.COPYFILE_EXCL
    : 0;

const FICLONE_FALLBACK_CODES = new Set([
  'EXDEV',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EINVAL',
  'ENOSYS',
]);

/**
 * @param {any} err
 * @returns {string}
 */
function getErrCode(err) {
  return String(err?.code || '').toUpperCase();
}

/**
 * @param {string} rel
 * @returns {boolean}
 */
function isRelEscaping(rel) {
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\');
}

/**
 * Check whether `candidate` is equal to or contained within `root`.
 *
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
function isSameOrContainedPath(root, candidate) {
  if (!root || !candidate) return false;
  const isWin = process.platform === 'win32';
  const normRoot = isWin ? path.win32.resolve(root).toLowerCase() : path.posix.resolve(root);
  const normCand = isWin
    ? path.win32.resolve(candidate).toLowerCase()
    : path.posix.resolve(candidate);
  const rel = isWin
    ? path.win32.relative(normRoot, normCand)
    : path.posix.relative(normRoot, normCand);
  return rel === '' || (!isRelEscaping(rel) && !(isWin ? path.win32 : path.posix).isAbsolute(rel));
}

/**
 * Resolve canonical path for a possibly non-existent destination by finding its nearest existing
 * ancestor via `realpathSync` and verifying the destination itself is not a symlink.
 *
 * @param {string} targetPath
 * @returns {{ canonical: string, isSymlink: boolean, existingStat: fs.Stats | null }}
 */
function inspectCanonicalDestinationSync(targetPath) {
  const resolved = path.resolve(targetPath);
  /** @type {fs.Stats | null} */
  let existingStat = null;
  try {
    existingStat = fs.lstatSync(resolved);
    if (existingStat.isSymbolicLink()) {
      return { canonical: resolved, isSymlink: true, existingStat };
    }
    return { canonical: fs.realpathSync(resolved), isSymlink: false, existingStat };
  } catch (err) {
    if (getErrCode(err) !== 'ENOENT') {
      throw err;
    }
  }

  /** @type {string[]} */
  const suffix = [];
  let cursor = resolved;
  for (let guard = 0; guard < 64; guard += 1) {
    const parent = path.dirname(cursor);
    if (!parent || parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
    try {
      const ancStat = fs.lstatSync(cursor);
      if (ancStat.isSymbolicLink()) {
        // Resolve the real ancestor target (e.g. macOS /var -> /private/var)
        const realAnc = fs.realpathSync(cursor);
        return {
          canonical: path.join(realAnc, ...suffix),
          isSymlink: false,
          existingStat: null,
        };
      }
      const realAnc = fs.realpathSync(cursor);
      return {
        canonical: path.join(realAnc, ...suffix),
        isSymlink: false,
        existingStat: null,
      };
    } catch (ancErr) {
      if (getErrCode(ancErr) !== 'ENOENT') {
        throw ancErr;
      }
    }
  }
  return { canonical: resolved, isSymlink: false, existingStat: null };
}

/**
 * Async counterpart to `inspectCanonicalDestinationSync`.
 *
 * @param {string} targetPath
 * @returns {Promise<{ canonical: string, isSymlink: boolean, existingStat: fs.Stats | null }>}
 */
async function inspectCanonicalDestinationAsync(targetPath) {
  const resolved = path.resolve(targetPath);
  /** @type {fs.Stats | null} */
  let existingStat = null;
  try {
    existingStat = await fs.promises.lstat(resolved);
    if (existingStat.isSymbolicLink()) {
      return { canonical: resolved, isSymlink: true, existingStat };
    }
    return { canonical: await fs.promises.realpath(resolved), isSymlink: false, existingStat };
  } catch (err) {
    if (getErrCode(err) !== 'ENOENT') {
      throw err;
    }
  }

  /** @type {string[]} */
  const suffix = [];
  let cursor = resolved;
  for (let guard = 0; guard < 64; guard += 1) {
    const parent = path.dirname(cursor);
    if (!parent || parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
    try {
      await fs.promises.lstat(cursor);
      const realAnc = await fs.promises.realpath(cursor);
      return {
        canonical: path.join(realAnc, ...suffix),
        isSymlink: false,
        existingStat: null,
      };
    } catch (ancErr) {
      if (getErrCode(ancErr) !== 'ENOENT') {
        throw ancErr;
      }
    }
  }
  return { canonical: resolved, isSymlink: false, existingStat: null };
}

/**
 * Verify a destination file path is NOT a symlink (or directory) before writing.
 *
 * @param {string} destFile
 */
function assertDestinationNotSymlinkSync(destFile) {
  try {
    const st = fs.lstatSync(destFile);
    if (st.isSymbolicLink()) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`Refusing to overwrite destination symlink: ${destFile}`)
      );
      err.code = 'ERR_DEST_SYMLINK';
      throw err;
    }
    if (st.isDirectory()) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`Refusing to overwrite destination directory with file: ${destFile}`)
      );
      err.code = 'EISDIR';
      throw err;
    }
  } catch (err) {
    if (getErrCode(err) === 'ENOENT') return;
    throw err;
  }
}

/**
 * Async counterpart to `assertDestinationNotSymlinkSync`.
 *
 * @param {string} destFile
 */
async function assertDestinationNotSymlinkAsync(destFile) {
  try {
    const st = await fs.promises.lstat(destFile);
    if (st.isSymbolicLink()) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`Refusing to overwrite destination symlink: ${destFile}`)
      );
      err.code = 'ERR_DEST_SYMLINK';
      throw err;
    }
    if (st.isDirectory()) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`Refusing to overwrite destination directory with file: ${destFile}`)
      );
      err.code = 'EISDIR';
      throw err;
    }
  } catch (err) {
    if (getErrCode(err) === 'ENOENT') return;
    throw err;
  }
}

/**
 * Perform a single raw `copyFileSync` with `COPYFILE_FICLONE` falling back ONLY on
 * cross-device / unsupported-CoW error codes.
 *
 * @param {string} srcFile
 * @param {string} targetFile
 * @param {number} extraFlags
 */
function rawCopyWithCloneFallbackSync(srcFile, targetFile, extraFlags) {
  if (FICLONE_FLAG) {
    try {
      fs.copyFileSync(srcFile, targetFile, FICLONE_FLAG | extraFlags);
      return;
    } catch (cloneErr) {
      if (!FICLONE_FALLBACK_CODES.has(getErrCode(cloneErr))) {
        throw cloneErr;
      }
    }
  }
  if (extraFlags) {
    fs.copyFileSync(srcFile, targetFile, extraFlags);
  } else {
    fs.copyFileSync(srcFile, targetFile);
  }
}

/**
 * Perform a single raw `fs.promises.copyFile` with `COPYFILE_FICLONE` falling back ONLY on
 * cross-device / unsupported-CoW error codes.
 *
 * @param {string} srcFile
 * @param {string} targetFile
 * @param {number} extraFlags
 */
async function rawCopyWithCloneFallbackAsync(srcFile, targetFile, extraFlags) {
  if (FICLONE_FLAG) {
    try {
      await fs.promises.copyFile(srcFile, targetFile, FICLONE_FLAG | extraFlags);
      return;
    } catch (cloneErr) {
      if (!FICLONE_FALLBACK_CODES.has(getErrCode(cloneErr))) {
        throw cloneErr;
      }
    }
  }
  if (extraFlags) {
    await fs.promises.copyFile(srcFile, targetFile, extraFlags);
  } else {
    await fs.promises.copyFile(srcFile, targetFile);
  }
}

/**
 * Copy a single regular file synchronously using APFS/ReFS `COPYFILE_FICLONE` when available,
 * rejecting destination symlinks, using `COPYFILE_EXCL` when `options.skipExisting` is true,
 * and using sibling exclusive temp file + atomic rename when overwriting.
 *
 * @param {string} srcFile
 * @param {string} destFile
 * @param {{ skipExisting?: boolean }} [options]
 * @returns {boolean} true if copied, false if skipped due to `skipExisting`
 */
function copyFileWithCloneFallbackSync(srcFile, destFile, options = {}) {
  const skipExisting = Boolean(options && options.skipExisting);
  assertDestinationNotSymlinkSync(destFile);

  if (skipExisting && COPYFILE_EXCL_FLAG) {
    try {
      rawCopyWithCloneFallbackSync(srcFile, destFile, COPYFILE_EXCL_FLAG);
      return true;
    } catch (err) {
      if (getErrCode(err) === 'EEXIST') {
        assertDestinationNotSymlinkSync(destFile);
        return false;
      }
      throw err;
    }
  }

  const tmpDest = `${destFile}.${process.pid.toString(36)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    rawCopyWithCloneFallbackSync(srcFile, tmpDest, COPYFILE_EXCL_FLAG);
    assertDestinationNotSymlinkSync(destFile);
    fs.renameSync(tmpDest, destFile);
    return true;
  } catch (err) {
    try {
      fs.unlinkSync(tmpDest);
    } catch {}
    if (getErrCode(err) === 'ENAMETOOLONG') {
      assertDestinationNotSymlinkSync(destFile);
      try {
        rawCopyWithCloneFallbackSync(srcFile, destFile, 0);
        return true;
      } catch (directErr) {
        try {
          fs.unlinkSync(destFile);
        } catch {}
        throw directErr;
      }
    }
    throw err;
  }
}

/**
 * Asynchronous counterpart to `copyFileWithCloneFallbackSync`.
 *
 * @param {string} srcFile
 * @param {string} destFile
 * @param {{ skipExisting?: boolean }} [options]
 * @returns {Promise<boolean>} true if copied, false if skipped due to `skipExisting`
 */
async function copyFileWithCloneFallbackAsync(srcFile, destFile, options = {}) {
  const skipExisting = Boolean(options && options.skipExisting);
  await assertDestinationNotSymlinkAsync(destFile);

  if (skipExisting && COPYFILE_EXCL_FLAG) {
    try {
      await rawCopyWithCloneFallbackAsync(srcFile, destFile, COPYFILE_EXCL_FLAG);
      return true;
    } catch (err) {
      if (getErrCode(err) === 'EEXIST') {
        await assertDestinationNotSymlinkAsync(destFile);
        return false;
      }
      throw err;
    }
  }

  const tmpDest = `${destFile}.${process.pid.toString(36)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await rawCopyWithCloneFallbackAsync(srcFile, tmpDest, COPYFILE_EXCL_FLAG);
    await assertDestinationNotSymlinkAsync(destFile);
    await fs.promises.rename(tmpDest, destFile);
    return true;
  } catch (err) {
    try {
      await fs.promises.unlink(tmpDest);
    } catch {}
    if (getErrCode(err) === 'ENAMETOOLONG') {
      await assertDestinationNotSymlinkAsync(destFile);
      try {
        await rawCopyWithCloneFallbackAsync(srcFile, destFile, 0);
        return true;
      } catch (directErr) {
        try {
          await fs.promises.unlink(destFile);
        } catch {}
        throw directErr;
      }
    }
    throw err;
  }
}

/**
 * Ensure `dirPath` exists as a real non-symlink directory synchronously.
 *
 * @param {string} dirPath
 */
function ensureRealDirectorySync(dirPath) {
  try {
    const st = fs.lstatSync(dirPath);
    if (st.isSymbolicLink()) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`Refusing to write into symlinked destination directory: ${dirPath}`)
      );
      err.code = 'ERR_DEST_SYMLINK';
      throw err;
    }
    if (!st.isDirectory()) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`Destination path exists and is not a directory: ${dirPath}`)
      );
      err.code = 'ENOTDIR';
      throw err;
    }
    return;
  } catch (err) {
    if (getErrCode(err) !== 'ENOENT') throw err;
  }
  fs.mkdirSync(dirPath, { recursive: true });
  const createdStat = fs.lstatSync(dirPath);
  if (createdStat.isSymbolicLink() || !createdStat.isDirectory()) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(`Destination directory became symlink during mkdir: ${dirPath}`)
    );
    err.code = 'ERR_DEST_SYMLINK';
    throw err;
  }
}

/**
 * Async counterpart to `ensureRealDirectorySync`.
 *
 * @param {string} dirPath
 */
async function ensureRealDirectoryAsync(dirPath) {
  try {
    const st = await fs.promises.lstat(dirPath);
    if (st.isSymbolicLink()) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`Refusing to write into symlinked destination directory: ${dirPath}`)
      );
      err.code = 'ERR_DEST_SYMLINK';
      throw err;
    }
    if (!st.isDirectory()) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`Destination path exists and is not a directory: ${dirPath}`)
      );
      err.code = 'ENOTDIR';
      throw err;
    }
    return;
  } catch (err) {
    if (getErrCode(err) !== 'ENOENT') throw err;
  }
  await fs.promises.mkdir(dirPath, { recursive: true });
  const createdStat = await fs.promises.lstat(dirPath);
  if (createdStat.isSymbolicLink() || !createdStat.isDirectory()) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(`Destination directory became symlink during mkdir: ${dirPath}`)
    );
    err.code = 'ERR_DEST_SYMLINK';
    throw err;
  }
}

/**
 * Measure and copy real (non-symlink) files from `srcDir` into `destDir` synchronously,
 * enforcing `maxBytes` cap (both pre-copy and during copy), rejecting destination symlinks
 * and self-containment loops, and utilizing APFS/ReFS copy-on-write (`COPYFILE_FICLONE`).
 *
 * @param {string} srcDir
 * @param {string} destDir
 * @param {number} maxBytes
 * @param {{ skipExisting?: boolean, requireNonEmpty?: boolean }} [options]
 * @returns {{ copied: boolean, reason?: string, totalBytes: number, fileCount: number }}
 */
function copyRealDirBoundedSync(srcDir, destDir, maxBytes, options = {}) {
  const skipExisting = Boolean(options.skipExisting);
  const requireNonEmpty = Boolean(options.requireNonEmpty);

  try {
    if (!srcDir || !destDir || !fs.existsSync(srcDir)) {
      return { copied: false, reason: 'source_missing', totalBytes: 0, fileCount: 0 };
    }
    const rootStat = fs.lstatSync(srcDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { copied: false, reason: 'not_real_directory', totalBytes: 0, fileCount: 0 };
    }

    const realSrc = fs.realpathSync(srcDir);
    const destInfo = inspectCanonicalDestinationSync(destDir);
    if (destInfo.isSymlink) {
      return { copied: false, reason: 'destination_is_symlink', totalBytes: 0, fileCount: 0 };
    }
    if (destInfo.existingStat && !destInfo.existingStat.isDirectory()) {
      return { copied: false, reason: 'destination_not_directory', totalBytes: 0, fileCount: 0 };
    }
    if (isSameOrContainedPath(realSrc, destInfo.canonical)) {
      return { copied: false, reason: 'destination_inside_source', totalBytes: 0, fileCount: 0 };
    }
    if (isSameOrContainedPath(destInfo.canonical, realSrc)) {
      return { copied: false, reason: 'source_inside_destination', totalBytes: 0, fileCount: 0 };
    }

    let totalBytes = 0;
    let fileCount = 0;
    let exceeded = false;

    /**
     * @param {string} dir
     */
    const measure = (dir) => {
      if (exceeded) return;
      /** @type {fs.Dirent[]} */
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        diagLog.debug('boundedCopy.measureReaddirSync', err, { dir });
        return;
      }
      for (const ent of entries) {
        if (ent.isSymbolicLink()) continue;
        const full = path.join(dir, ent.name);
        let isDir = ent.isDirectory();
        let isFile = ent.isFile();
        /** @type {fs.Stats | null} */
        let lstatObj = null;
        if (!isDir && !isFile) {
          // Handle DT_UNKNOWN filesystems via lstat
          try {
            lstatObj = fs.lstatSync(full);
            if (lstatObj.isSymbolicLink()) continue;
            isDir = lstatObj.isDirectory();
            isFile = lstatObj.isFile();
          } catch (statErr) {
            diagLog.debug('boundedCopy.measureLstatSync', statErr, { full });
            continue;
          }
        }

        if (isDir) {
          measure(full);
          if (exceeded) return;
        } else if (isFile) {
          try {
            const lst = lstatObj || fs.lstatSync(full);
            if (lst.isSymbolicLink() || !lst.isFile()) continue;
            const st = fs.statSync(full);
            totalBytes += Math.max(lst.size || 0, st.size || 0);
            fileCount += 1;
            if (maxBytes > 0 && totalBytes > maxBytes) {
              exceeded = true;
              return;
            }
          } catch (statErr) {
            diagLog.debug('boundedCopy.measureStatSync', statErr, { full });
          }
        }
      }
    };

    measure(srcDir);
    if (requireNonEmpty && fileCount === 0) {
      return { copied: false, reason: 'empty_directory', totalBytes: 0, fileCount: 0 };
    }
    if (exceeded) {
      return { copied: false, reason: 'exceeds_size_cap', totalBytes, fileCount };
    }

    let copiedBytes = 0;
    let copiedFiles = 0;

    /**
     * @param {string} sDir
     * @param {string} dDir
     */
    const copyRec = (sDir, dDir) => {
      ensureRealDirectorySync(dDir);
      const entries = fs.readdirSync(sDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isSymbolicLink()) continue;
        const sFull = path.join(sDir, ent.name);
        const dFull = path.join(dDir, ent.name);

        let lst;
        try {
          lst = fs.lstatSync(sFull);
        } catch {
          continue;
        }
        if (lst.isSymbolicLink()) continue;

        if (lst.isDirectory()) {
          copyRec(sFull, dFull);
        } else if (lst.isFile()) {
          let fileSize = lst.size || 0;
          try {
            const st = fs.statSync(sFull);
            fileSize = Math.max(fileSize, st.size || 0);
          } catch {
            continue;
          }
          if (maxBytes > 0 && copiedBytes + fileSize > maxBytes) {
            const err = /** @type {Error & { code?: string }} */ (
              new Error('exceeds_size_cap')
            );
            err.code = 'ERR_SIZE_CAP_EXCEEDED';
            throw err;
          }
          copyFileWithCloneFallbackSync(sFull, dFull, { skipExisting });
          copiedBytes += fileSize;
          copiedFiles += 1;
        }
      }
    };

    copyRec(srcDir, destDir);
    return { copied: true, totalBytes: copiedBytes, fileCount: copiedFiles };
  } catch (err) {
    const anyErr = /** @type {any} */ (err);
    if (anyErr?.code === 'ERR_SIZE_CAP_EXCEEDED') {
      return { copied: false, reason: 'exceeds_size_cap', totalBytes: 0, fileCount: 0 };
    }
    if (anyErr?.code === 'ERR_DEST_SYMLINK') {
      return { copied: false, reason: 'destination_is_symlink', totalBytes: 0, fileCount: 0 };
    }
    diagLog.warn('boundedCopy.copySyncFailed', err, { srcDir, destDir });
    return {
      copied: false,
      reason: anyErr?.message || 'copy_failed',
      totalBytes: 0,
      fileCount: 0,
    };
  }
}

/**
 * Asynchronous counterpart to `copyRealDirBoundedSync` using `fs.promises`, `lstat` symlink
 * rejection, self-containment checks, `COPYFILE_EXCL`, and `COPYFILE_FICLONE`.
 *
 * @param {string} srcDir
 * @param {string} destDir
 * @param {number} maxBytes
 * @param {{ skipExisting?: boolean, requireNonEmpty?: boolean }} [options]
 * @returns {Promise<{ copied: boolean, reason?: string, totalBytes: number, fileCount: number }>}
 */
async function copyRealDirBoundedAsync(srcDir, destDir, maxBytes, options = {}) {
  const skipExisting = Boolean(options.skipExisting);
  const requireNonEmpty = Boolean(options.requireNonEmpty);

  try {
    if (!srcDir || !destDir) {
      return { copied: false, reason: 'source_missing', totalBytes: 0, fileCount: 0 };
    }
    /** @type {fs.Stats | null} */
    let rootStat = null;
    try {
      rootStat = await fs.promises.lstat(srcDir);
    } catch {
      return { copied: false, reason: 'source_missing', totalBytes: 0, fileCount: 0 };
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { copied: false, reason: 'not_real_directory', totalBytes: 0, fileCount: 0 };
    }

    const realSrc = await fs.promises.realpath(srcDir);
    const destInfo = await inspectCanonicalDestinationAsync(destDir);
    if (destInfo.isSymlink) {
      return { copied: false, reason: 'destination_is_symlink', totalBytes: 0, fileCount: 0 };
    }
    if (destInfo.existingStat && !destInfo.existingStat.isDirectory()) {
      return { copied: false, reason: 'destination_not_directory', totalBytes: 0, fileCount: 0 };
    }
    if (isSameOrContainedPath(realSrc, destInfo.canonical)) {
      return { copied: false, reason: 'destination_inside_source', totalBytes: 0, fileCount: 0 };
    }
    if (isSameOrContainedPath(destInfo.canonical, realSrc)) {
      return { copied: false, reason: 'source_inside_destination', totalBytes: 0, fileCount: 0 };
    }

    let totalBytes = 0;
    let fileCount = 0;
    let exceeded = false;

    /**
     * @param {string} dir
     */
    const measure = async (dir) => {
      if (exceeded) return;
      /** @type {fs.Dirent[]} */
      let entries = [];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (err) {
        diagLog.debug('boundedCopy.measureReaddirAsync', err, { dir });
        return;
      }
      for (const ent of entries) {
        if (ent.isSymbolicLink()) continue;
        const full = path.join(dir, ent.name);
        let isDir = ent.isDirectory();
        let isFile = ent.isFile();
        /** @type {fs.Stats | null} */
        let lstatObj = null;
        if (!isDir && !isFile) {
          try {
            lstatObj = await fs.promises.lstat(full);
            if (lstatObj.isSymbolicLink()) continue;
            isDir = lstatObj.isDirectory();
            isFile = lstatObj.isFile();
          } catch (statErr) {
            diagLog.debug('boundedCopy.measureLstatAsync', statErr, { full });
            continue;
          }
        }

        if (isDir) {
          await measure(full);
          if (exceeded) return;
        } else if (isFile) {
          try {
            const lst = lstatObj || (await fs.promises.lstat(full));
            if (lst.isSymbolicLink() || !lst.isFile()) continue;
            const st = await fs.promises.stat(full);
            totalBytes += Math.max(lst.size || 0, st.size || 0);
            fileCount += 1;
            if (maxBytes > 0 && totalBytes > maxBytes) {
              exceeded = true;
              return;
            }
          } catch (statErr) {
            diagLog.debug('boundedCopy.measureStatAsync', statErr, { full });
          }
        }
      }
    };

    await measure(srcDir);
    if (requireNonEmpty && fileCount === 0) {
      return { copied: false, reason: 'empty_directory', totalBytes: 0, fileCount: 0 };
    }
    if (exceeded) {
      return { copied: false, reason: 'exceeds_size_cap', totalBytes, fileCount };
    }

    let copiedBytes = 0;
    let copiedFiles = 0;

    /**
     * @param {string} sDir
     * @param {string} dDir
     */
    const copyRec = async (sDir, dDir) => {
      await ensureRealDirectoryAsync(dDir);
      const entries = await fs.promises.readdir(sDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isSymbolicLink()) continue;
        const sFull = path.join(sDir, ent.name);
        const dFull = path.join(dDir, ent.name);

        let lst;
        try {
          lst = await fs.promises.lstat(sFull);
        } catch {
          continue;
        }
        if (lst.isSymbolicLink()) continue;

        if (lst.isDirectory()) {
          await copyRec(sFull, dFull);
        } else if (lst.isFile()) {
          let fileSize = lst.size || 0;
          try {
            const st = await fs.promises.stat(sFull);
            fileSize = Math.max(fileSize, st.size || 0);
          } catch {
            continue;
          }
          if (maxBytes > 0 && copiedBytes + fileSize > maxBytes) {
            const err = /** @type {Error & { code?: string }} */ (
              new Error('exceeds_size_cap')
            );
            err.code = 'ERR_SIZE_CAP_EXCEEDED';
            throw err;
          }
          await copyFileWithCloneFallbackAsync(sFull, dFull, { skipExisting });
          copiedBytes += fileSize;
          copiedFiles += 1;
        }
      }
    };

    await copyRec(srcDir, destDir);
    return { copied: true, totalBytes: copiedBytes, fileCount: copiedFiles };
  } catch (err) {
    const anyErr = /** @type {any} */ (err);
    if (anyErr?.code === 'ERR_SIZE_CAP_EXCEEDED') {
      return { copied: false, reason: 'exceeds_size_cap', totalBytes: 0, fileCount: 0 };
    }
    if (anyErr?.code === 'ERR_DEST_SYMLINK') {
      return { copied: false, reason: 'destination_is_symlink', totalBytes: 0, fileCount: 0 };
    }
    diagLog.warn('boundedCopy.copyAsyncFailed', err, { srcDir, destDir });
    return {
      copied: false,
      reason: anyErr?.message || 'copy_failed',
      totalBytes: 0,
      fileCount: 0,
    };
  }
}

module.exports = {
  copyFileWithCloneFallbackSync,
  copyFileWithCloneFallbackAsync,
  copyRealDirBoundedSync,
  copyRealDirBoundedAsync,
};
