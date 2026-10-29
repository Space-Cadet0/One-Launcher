'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { diagLog } = require('../utils/diagnosticLogger.cjs');

const FICLONE_FLAG =
  fs.constants && typeof fs.constants.COPYFILE_FICLONE === 'number'
    ? fs.constants.COPYFILE_FICLONE
    : 0;

function copyFileWithCloneFallbackSync(srcFile, destFile) {
  if (FICLONE_FLAG) {
    try {
      fs.copyFileSync(srcFile, destFile, FICLONE_FLAG);
      return;
    } catch {
      // Cross-device / non-CoW filesystem fallback
    }
  }
  fs.copyFileSync(srcFile, destFile);
}

async function copyFileWithCloneFallbackAsync(srcFile, destFile) {
  if (FICLONE_FLAG) {
    try {
      await fs.promises.copyFile(srcFile, destFile, FICLONE_FLAG);
      return;
    } catch {
      // Cross-device / non-CoW filesystem fallback
    }
  }
  await fs.promises.copyFile(srcFile, destFile);
}

/**
 * Measure and copy real (non-symlink) files from `srcDir` into `destDir` synchronously,
 * enforcing `maxBytes` cap and utilizing APFS/ReFS copy-on-write (`COPYFILE_FICLONE`) when available.
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

    let totalBytes = 0;
    let fileCount = 0;
    let exceeded = false;

    const measure = (dir) => {
      if (exceeded) return;
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
        if (ent.isDirectory()) {
          measure(full);
          if (exceeded) return;
        } else if (ent.isFile()) {
          try {
            const st = fs.statSync(full);
            totalBytes += st.size || 0;
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

    const copyRec = (sDir, dDir) => {
      fs.mkdirSync(dDir, { recursive: true });
      const entries = fs.readdirSync(sDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isSymbolicLink()) continue;
        const sFull = path.join(sDir, ent.name);
        const dFull = path.join(dDir, ent.name);
        if (ent.isDirectory()) {
          copyRec(sFull, dFull);
        } else if (ent.isFile()) {
          if (!skipExisting || !fs.existsSync(dFull)) {
            copyFileWithCloneFallbackSync(sFull, dFull);
          }
        }
      }
    };

    copyRec(srcDir, destDir);
    return { copied: true, totalBytes, fileCount };
  } catch (err) {
    diagLog.warn('boundedCopy.copySyncFailed', err, { srcDir, destDir });
    return {
      copied: false,
      reason: err?.message || 'copy_failed',
      totalBytes: 0,
      fileCount: 0,
    };
  }
}

/**
 * Asynchronous counterpart to `copyRealDirBoundedSync` using `fs.promises` and `COPYFILE_FICLONE`.
 */
async function copyRealDirBoundedAsync(srcDir, destDir, maxBytes, options = {}) {
  const skipExisting = Boolean(options.skipExisting);
  const requireNonEmpty = Boolean(options.requireNonEmpty);

  try {
    if (!srcDir || !destDir) {
      return { copied: false, reason: 'source_missing', totalBytes: 0, fileCount: 0 };
    }
    let rootStat = null;
    try {
      rootStat = await fs.promises.lstat(srcDir);
    } catch {
      return { copied: false, reason: 'source_missing', totalBytes: 0, fileCount: 0 };
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { copied: false, reason: 'not_real_directory', totalBytes: 0, fileCount: 0 };
    }

    let totalBytes = 0;
    let fileCount = 0;
    let exceeded = false;

    const measure = async (dir) => {
      if (exceeded) return;
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
        if (ent.isDirectory()) {
          await measure(full);
          if (exceeded) return;
        } else if (ent.isFile()) {
          try {
            const st = await fs.promises.stat(full);
            totalBytes += st.size || 0;
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

    const copyRec = async (sDir, dDir) => {
      await fs.promises.mkdir(dDir, { recursive: true });
      const entries = await fs.promises.readdir(sDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isSymbolicLink()) continue;
        const sFull = path.join(sDir, ent.name);
        const dFull = path.join(dDir, ent.name);
        if (ent.isDirectory()) {
          await copyRec(sFull, dFull);
        } else if (ent.isFile()) {
          if (skipExisting) {
            try {
              await fs.promises.access(dFull);
              continue;
            } catch {
              // File does not exist yet
            }
          }
          await copyFileWithCloneFallbackAsync(sFull, dFull);
        }
      }
    };

    await copyRec(srcDir, destDir);
    return { copied: true, totalBytes, fileCount };
  } catch (err) {
    diagLog.warn('boundedCopy.copyAsyncFailed', err, { srcDir, destDir });
    return {
      copied: false,
      reason: err?.message || 'copy_failed',
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
