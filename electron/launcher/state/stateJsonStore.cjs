// @ts-check
'use strict';

/**
 * Bounded `(mtimeMs, size)` JSON state cache with automatic `.bak` crash recovery
 * (including when the primary JSON file is missing / `ENOENT`) and optional `0o600`
 * owner-only atomic writes (`atomicWriteSecureFileSync`).
 */

const MAX_STATE_JSON_CACHE_ENTRIES = 128;

/**
 * @typedef {Object} StateJsonStoreDeps
 * @property {typeof import('node:fs')} fs
 * @property {(targetPath: string) => string} toHostFilesystemPath
 * @property {(filePath: string, content: string | Buffer) => void} atomicWriteFileSync
 * @property {(filePath: string, content: string | Buffer, options?: Record<string, any>) => void} atomicWriteSecureFileSync
 * @property {(filePath: string, fallbackValue?: any, options?: { recoverMissingFromBackup?: boolean }) => any} readJsonFileWithBackupSync
 */

/**
 * @param {StateJsonStoreDeps} deps
 */
function createStateJsonStore(deps) {
  const {
    fs,
    toHostFilesystemPath,
    atomicWriteFileSync,
    atomicWriteSecureFileSync,
    readJsonFileWithBackupSync,
  } = deps;

  /** @type {Map<string, { mtimeMs: number, size: number, rawJson: string }>} */
  const stateJsonMemoryCache = new Map();

  /**
   * @param {string} hostPath
   * @param {{ mtimeMs: number, size: number, rawJson: string }} entry
   */
  function setCacheEntry(hostPath, entry) {
    if (stateJsonMemoryCache.has(hostPath)) {
      stateJsonMemoryCache.delete(hostPath);
    } else if (stateJsonMemoryCache.size >= MAX_STATE_JSON_CACHE_ENTRIES) {
      const oldestKey = stateJsonMemoryCache.keys().next().value;
      if (oldestKey !== undefined) {
        stateJsonMemoryCache.delete(oldestKey);
      }
    }
    stateJsonMemoryCache.set(hostPath, entry);
  }

  /**
   * Read a JSON state file with `(hostFilePath, mtimeMs, size)` read-through caching
   * and automatic `.bak` fallback recovery on primary corruption OR missing (`ENOENT`) primary.
   *
   * @param {string} filePath
   * @returns {any}
   */
  function readCachedStateJsonSync(filePath) {
    const hostPath = toHostFilesystemPath(filePath);
    if (!hostPath) return null;

    /** @type {import('node:fs').Stats | null} */
    let primaryStat = null;
    try {
      primaryStat = fs.statSync(hostPath);
    } catch (/** @type {any} */ statErr) {
      primaryStat = null;
      if (!statErr || statErr.code !== 'ENOENT') {
        stateJsonMemoryCache.delete(hostPath);
      }
    }

    if (primaryStat) {
      const cached = stateJsonMemoryCache.get(hostPath);
      if (
        cached &&
        cached.mtimeMs === primaryStat.mtimeMs &&
        cached.size === primaryStat.size
      ) {
        try {
          return JSON.parse(cached.rawJson);
        } catch {
          stateJsonMemoryCache.delete(hostPath);
        }
      }
    }

    try {
      const parsed = readJsonFileWithBackupSync(hostPath, null, {
        recoverMissingFromBackup: true,
      });
      if (parsed !== null && parsed !== undefined) {
        const rawJson = JSON.stringify(parsed);
        let latestMtime = primaryStat ? primaryStat.mtimeMs : 0;
        let latestSize = primaryStat ? primaryStat.size : 0;
        let havePostStat = Boolean(primaryStat);
        try {
          const afterStat = fs.statSync(hostPath);
          latestMtime = afterStat.mtimeMs;
          latestSize = afterStat.size;
          havePostStat = true;
        } catch {}
        if (havePostStat) {
          setCacheEntry(hostPath, {
            mtimeMs: latestMtime,
            size: latestSize,
            rawJson,
          });
        } else {
          stateJsonMemoryCache.delete(hostPath);
        }
        return parsed;
      }
      stateJsonMemoryCache.delete(hostPath);
      return null;
    } catch {
      stateJsonMemoryCache.delete(hostPath);
      return null;
    }
  }

  /**
   * Atomically write a JSON state file with single serialization and refresh
   * the bounded in-memory `(mtimeMs, size)` cache.
   *
   * @param {string} filePath
   * @param {any} value
   * @param {{ secure?: boolean, preserveBackup?: boolean }} [options]
   */
  function writeCachedStateJsonSync(filePath, value, options = {}) {
    const hostPath = toHostFilesystemPath(filePath);
    const serialized = JSON.stringify(value, null, 2);
    if (options && options.secure === true) {
      atomicWriteSecureFileSync(hostPath, serialized, options);
    } else {
      atomicWriteFileSync(hostPath, serialized);
    }
    try {
      const st = fs.statSync(hostPath);
      setCacheEntry(hostPath, {
        mtimeMs: st.mtimeMs,
        size: st.size,
        rawJson: serialized,
      });
    } catch {
      stateJsonMemoryCache.delete(hostPath);
    }
  }

  function clearStateJsonCache() {
    stateJsonMemoryCache.clear();
  }

  return {
    MAX_STATE_JSON_CACHE_ENTRIES,
    stateJsonMemoryCache,
    readCachedStateJsonSync,
    writeCachedStateJsonSync,
    clearStateJsonCache,
  };
}

module.exports = {
  MAX_STATE_JSON_CACHE_ENTRIES,
  createStateJsonStore,
};
