// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const { isNetworkOnlineForLaunch } = require('../engineStateRegistry.cjs');
const {
  toHostFilesystemPath,
  recordImportedEpicInstall,
} = require('../securityAndPathUtils.cjs');
const { execCliWithTreeTimeout } = require('../processTreeUtils.cjs');
const {
  MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES,
  withCloudManifestFileLock,
  buildPerGameCloudSyncLockKey,
  withPerGameCloudSyncLock,
  sleepUnrefWithAbortAsync,
  pathExistsAsync,
  atomicWriteFileAsync,
  sanitizeGogGameClientId,
  isSafeGogGameId,
  isSafeGogLocationName,
  isSafeEpicAppName,
  normalizePosixUtf8Locale,
  verifySavePathRealContainmentAsync,
  isBroadOneDriveKnownFolderRoot,
  openFileBoundedNoRecallAsync,
  purgeOsMetadataAndCountRealFilesAsync,
} = require('./oneDriveAndPathGuards.cjs');
const {
  getResolvedGogLocationAnchor,
  getResolvedEpicPathAnchor,
} = require('./savePathResolvers.cjs');

/** @type {WeakMap<Function, Set<string>>} */
const virtualMockPreLaunchByExecFn = new WeakMap();

const MAX_NESTED_GOG_INFO_SUBDIRS = 32;

/**
 * Normalize a filesystem path to lowercase POSIX form (stripping trailing slashes) for
 * cross-bottle path comparison and deterministic hashing.
 *
 * @param {string} rawPath
 * @returns {string}
 */
function normalizeComparableFsPath(rawPath) {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return '';
  const resolved = path.resolve(toHostFilesystemPath(trimmed));
  return resolved.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Compute a deterministic per-bottle scope key (`bottle:<safeSlug>_<sha256_8>`) from a
 * Wine/CrossOver prefix path so cloud-save watermarks never collide across bottles.
 *
 * @param {string} winePrefix
 * @returns {string}
 */
function computeWinePrefixBottleScope(winePrefix) {
  const canonicalPrefixLower = normalizeComparableFsPath(winePrefix);
  if (!canonicalPrefixLower) return 'bottle:unknown';
  const safeSlug =
    path.posix
      .basename(canonicalPrefixLower)
      .replace(/[^a-z0-9_-]/g, '_')
      .slice(0, 24) || 'bottle';
  const hash8 = crypto
    .createHash('sha256')
    .update(canonicalPrefixLower)
    .digest('hex')
    .slice(0, 8);
  return `bottle:${safeSlug}_${hash8}`;
}

/**
 * Parse Epic `CloudIncludeList` / `CloudExcludeList` attribute values (string or string[])
 * into trimmed, POSIX-normalized glob patterns.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseEpicCloudPatternList(raw) {
  /** @type {string[]} */
  const rawItems = Array.isArray(raw)
    ? raw.map((v) => String(v ?? ''))
    : typeof raw === 'string'
      ? raw.split(/[,;\r\n]+/)
      : [];
  /** @type {string[]} */
  const out = [];
  for (const item of rawItems) {
    let norm = item.trim().replace(/\\/g, '/');
    norm = norm.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
    if (norm) out.push(norm);
  }
  return out;
}

/**
 * Tokenize a single POSIX glob pattern into linear DP tokens supporting single-wildcard (`*`),
 * double-wildcard (`**`), directory-globstar (`globstar_dir`), and single-char (`?`).
 *
 * @param {string} pattern
 * @returns {Array<{ kind: 'lit' | 'qmark' | 'star' | 'globstar' | 'globstar_dir', ch?: string }>}
 */
function tokenizeGlobPattern(pattern) {
  const effective = pattern.endsWith('/') ? `${pattern}**` : pattern;
  /** @type {Array<{ kind: 'lit' | 'qmark' | 'star' | 'globstar' | 'globstar_dir', ch?: string }>} */
  const tokens = [];
  let i = 0;
  while (i < effective.length) {
    if (effective[i] === '*') {
      if (effective[i + 1] === '*') {
        while (i < effective.length && effective[i] === '*') i += 1;
        if (effective[i] === '/') {
          while (i < effective.length && effective[i] === '/') i += 1;
          const prev = tokens[tokens.length - 1];
          if (!prev || (prev.kind !== 'globstar' && prev.kind !== 'globstar_dir')) {
            tokens.push({ kind: 'globstar_dir' });
          }
        } else {
          const prev = tokens[tokens.length - 1];
          if (prev && prev.kind === 'globstar_dir') {
            tokens[tokens.length - 1] = { kind: 'globstar' };
          } else if (!prev || prev.kind !== 'globstar') {
            tokens.push({ kind: 'globstar' });
          }
        }
      } else {
        i += 1;
        const prev = tokens[tokens.length - 1];
        if (!prev || prev.kind !== 'star') {
          tokens.push({ kind: 'star' });
        }
      }
    } else if (effective[i] === '?') {
      i += 1;
      tokens.push({ kind: 'qmark' });
    } else {
      tokens.push({ kind: 'lit', ch: effective[i] });
      i += 1;
    }
  }
  return tokens;
}

/**
 * Strictly linear-time O(tokens * text) ReDoS-safe glob matcher (zero regex backtracking).
 *
 * @param {Array<{ kind: 'lit' | 'qmark' | 'star' | 'globstar' | 'globstar_dir', ch?: string }>} tokens
 * @param {string} text
 * @returns {boolean}
 */
function matchGlobTokensLinear(tokens, text) {
  const n = text.length;
  let prev = new Uint8Array(n + 1);
  let next = new Uint8Array(n + 1);
  prev[0] = 1;

  for (let t = 0; t < tokens.length; t += 1) {
    const tok = tokens[t];
    next.fill(0);
    if (tok.kind === 'lit') {
      const ch = tok.ch || '';
      for (let j = 0; j < n; j += 1) {
        if (prev[j] && text[j] === ch) {
          next[j + 1] = 1;
        }
      }
    } else if (tok.kind === 'qmark') {
      for (let j = 0; j < n; j += 1) {
        if (prev[j] && text[j] !== '/') {
          next[j + 1] = 1;
        }
      }
    } else if (tok.kind === 'star') {
      next[0] = prev[0];
      for (let j = 0; j < n; j += 1) {
        if (prev[j + 1]) {
          next[j + 1] = 1;
        } else if (next[j] && text[j] !== '/') {
          next[j + 1] = 1;
        }
      }
    } else if (tok.kind === 'globstar') {
      let seen = 0;
      for (let j = 0; j <= n; j += 1) {
        if (prev[j]) seen = 1;
        next[j] = seen;
      }
    } else if (tok.kind === 'globstar_dir') {
      let seen = 0;
      for (let j = 0; j <= n; j += 1) {
        if (prev[j]) {
          next[j] = 1;
          seen = 1;
        }
        if (seen && j < n && text[j] === '/') {
          next[j + 1] = 1;
        }
      }
    }
    const tmp = prev;
    prev = next;
    next = tmp;
  }

  return prev[n] === 1;
}

/**
 * Build a ReDoS-safe pure relative-POSIX-path predicate from Epic `CloudIncludeList` /
 * `CloudExcludeList` patterns. Patterns without `/` match the file basename; patterns with `/`
 * match the full relative POSIX path.
 *
 * @param {string[]} [includePatterns]
 * @param {string[]} [excludePatterns]
 * @param {boolean} [caseInsensitive=true]
 * @returns {(relPosixPath: string) => boolean}
 */
function createEpicCloudFileFilter(
  includePatterns = [],
  excludePatterns = [],
  caseInsensitive = true
) {
  /** @param {string[]} list */
  const compileList = (list) =>
    (Array.isArray(list) ? list : [])
      .map((raw) => String(raw || '').trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, ''))
      .filter(Boolean)
      .map((pat) => {
        const effectivePat = caseInsensitive ? pat.toLowerCase() : pat;
        const matchFullPath = effectivePat.includes('/');
        return {
          matchFullPath,
          tokens: tokenizeGlobPattern(effectivePat),
        };
      });

  const compiledIncludes = compileList(includePatterns);
  const compiledExcludes = compileList(excludePatterns);

  /**
   * @param {string} relPosixPath
   * @returns {boolean}
   */
  return (relPosixPath) => {
    const norm = String(relPosixPath || '')
      .replace(/\\/g, '/')
      .replace(/^(?:\.\/)+/, '')
      .replace(/^\/+/, '');
    if (!norm) return false;
    const cmpPath = caseInsensitive ? norm.toLowerCase() : norm;
    const cmpBase = path.posix.basename(cmpPath);

    if (compiledIncludes.length > 0) {
      const matchedInclude = compiledIncludes.some((entry) =>
        matchGlobTokensLinear(entry.tokens, entry.matchFullPath ? cmpPath : cmpBase)
      );
      if (!matchedInclude) return false;
    }

    if (compiledExcludes.length > 0) {
      const matchedExclude = compiledExcludes.some((entry) =>
        matchGlobTokensLinear(entry.tokens, entry.matchFullPath ? cmpPath : cmpBase)
      );
      if (matchedExclude) return false;
    }

    return true;
  };
}

/**
 * Factory building the `createCloudSaveRunner(deps)` function wired to facade-injected
 * helpers (preserving load-time platform caps, `vi.spyOn` routing, and facade timestamp parser).
 *
 * @param {{
 *   resolveDefaultPerSnapshotMaxBackupBytes: (options?: Record<string, any>) => number,
 *   parseGogdlSyncTimestampFromStdout: (execRes: any, fallbackNowSec?: number) => number,
 *   inspectOneDrivePlaceholderStateAsync: (...args: any[]) => Promise<any>,
 *   createCloudSaveRollingBackupAsync: (...args: any[]) => Promise<any>,
 *   enforceCloudSaveBackupQuotaAsync: (...args: any[]) => Promise<any>,
 *   cleanupGameBackups: (...args: any[]) => any,
 *   resolveGogCloudSaveLocations: (...args: any[]) => any[],
 *   resolveEpicSavePathTemplate: (...args: any[]) => string,
 *   isSafeEpicSaveTemplateSyntax: (template: string) => boolean,
 *   pruneGogCloudConfigsMap: (...args: any[]) => Record<string, any>,
 *   pruneCloudSaveStateForGameAsync: (...args: any[]) => Promise<boolean>,
 *   syncXboxCloudSaves: (...args: any[]) => Promise<any>,
 *   waitForXboxCloudSaveFlush: (...args: any[]) => Promise<any>,
 * }} facadeDeps
 */
function createCloudSaveRunnerFactory(facadeDeps) {
  const {
    resolveDefaultPerSnapshotMaxBackupBytes,
    parseGogdlSyncTimestampFromStdout,
    inspectOneDrivePlaceholderStateAsync,
    createCloudSaveRollingBackupAsync,
    enforceCloudSaveBackupQuotaAsync,
    cleanupGameBackups,
    resolveGogCloudSaveLocations,
    resolveEpicSavePathTemplate,
    isSafeEpicSaveTemplateSyntax,
    pruneGogCloudConfigsMap,
    pruneCloudSaveStateForGameAsync,
    syncXboxCloudSaves,
    waitForXboxCloudSaveFlush,
  } = facadeDeps;

  /**
   * Factory creating `syncGogCloudSaves`, `syncEpicCloudSaves`, `syncXboxCloudSaves`,
   * Steam cloud log watchers, backup quota/cleanup helpers, and async state pruning
   * wired to the launcher engine's binary/auth resolvers.
   *
   * @param {Record<string, any>} deps
   */
  function createCloudSaveRunner(deps) {
    const {
      resolveIsolatedHomedirAndUserData,
      isTestEnvironment,
      fetchGogV1Json,
      findGogdlBinary,
      ensureGogdlAuthConfig,
      resolveEpicAppAndPlatforms,
      ensureLegendaryConfigAndAuth,
      getLegendaryConfigDir,
      collectLocalEpicMetadataAndSupport,
      findLegendaryBinary,
    } = deps;

    /**
     * @param {Record<string, any>} payload
     * @param {string} mode
     * @param {Record<string, any>} options
     * @param {string} gameId
     */
    async function runSyncGogCloudSaves(payload, mode, options, gameId) {
      const { homedir, userDataDir } = resolveIsolatedHomedirAndUserData(options);
      const targetPlatform = options.platform || process.platform;
      const useCompatLayer = Boolean(options.useCompatLayer || payload.useCompatLayer);
      const useWindowsLocations = targetPlatform === 'win32' || useCompatLayer;
      const installPath = String(payload.installPath || options.installPath || '').trim();
      const effectiveFetchImpl =
        typeof options.fetchImpl === 'function'
          ? options.fetchImpl
          : typeof options.fetchFn === 'function'
            ? options.fetchFn
            : undefined;
      const canUseNetwork =
        !isTestEnvironment(options) ||
        Boolean(effectiveFetchImpl) ||
        options.allowNetworkInTest === true;
      const hasRemoteConfigOverride = Boolean(
        options.gogRemoteConfigOverride && typeof options.gogRemoteConfigOverride === 'object'
      );

      const configCachePath = path.join(userDataDir, 'one_launcher_gog_cloud_configs.json');
      /** @type {Record<string, any>} */
      let cachedMap = {};
      try {
        if (await pathExistsAsync(configCachePath)) {
          cachedMap = JSON.parse(await fs.promises.readFile(configCachePath, 'utf8')) || {};
        }
      } catch (cacheReadErr) {
        diagLog.warn('cloudSave.gogReadConfigCache', cacheReadErr, { configCachePath });
      }

      // 1. Discover per-game GOG clientId (rejecting poisoned GOG_GALAXY_LAUNCHER_CLIENT_ID)
      let clientId = sanitizeGogGameClientId(
        options.gogClientId || payload.gogClientId || payload.clientId || '',
        hasRemoteConfigOverride
      );
      let effectiveInstallPath = installPath;

      if (installPath && (await pathExistsAsync(installPath))) {
        const rootInfoPrimary = path.join(installPath, `goggame-${gameId}.info`);
        const rootInfoHidden = path.join(installPath, `.goggame-${gameId}.info`);
        const hasRootInfo =
          (await pathExistsAsync(rootInfoPrimary)) || (await pathExistsAsync(rootInfoHidden));

        /** @type {Array<{ infoPath: string, nestedSubDir?: string }>} */
        const candidateInfoEntries = [
          { infoPath: rootInfoPrimary },
          { infoPath: rootInfoHidden },
          { infoPath: path.join(installPath, 'Contents', 'Resources', `goggame-${gameId}.info`) },
          { infoPath: path.join(installPath, 'Contents', 'Resources', `.goggame-${gameId}.info`) },
        ];
        /** @type {string[]} */
        const nestedSubDirsScanned = [];
        try {
          const instStat = await fs.promises.stat(installPath);
          if (instStat.isDirectory() && !installPath.toLowerCase().endsWith('.app')) {
            const entries = (await fs.promises.readdir(installPath, { withFileTypes: true })).sort(
              (a, b) => a.name.localeCompare(b.name)
            );
            for (const entry of entries) {
              if (entry.isSymbolicLink()) continue;
              const childPath = path.join(installPath, entry.name);
              let isDir = entry.isDirectory();
              if (!isDir) {
                try {
                  const childStat = await fs.promises.lstat(childPath);
                  if (childStat.isSymbolicLink()) continue;
                  isDir = childStat.isDirectory();
                } catch {
                  continue;
                }
              }
              if (!isDir) continue;
              if (entry.name.toLowerCase().endsWith('.app')) {
                candidateInfoEntries.push(
                  {
                    infoPath: path.join(
                      childPath,
                      'Contents',
                      'Resources',
                      `goggame-${gameId}.info`
                    ),
                  },
                  {
                    infoPath: path.join(
                      childPath,
                      'Contents',
                      'Resources',
                      `.goggame-${gameId}.info`
                    ),
                  }
                );
              } else if (!hasRootInfo && nestedSubDirsScanned.length < MAX_NESTED_GOG_INFO_SUBDIRS) {
                nestedSubDirsScanned.push(childPath);
                candidateInfoEntries.push(
                  {
                    infoPath: path.join(childPath, `goggame-${gameId}.info`),
                    nestedSubDir: childPath,
                  },
                  {
                    infoPath: path.join(childPath, `.goggame-${gameId}.info`),
                    nestedSubDir: childPath,
                  }
                );
              }
            }
          }
        } catch (dirErr) {
          diagLog.debug('cloudSave.gogScanInstallDir', dirErr, { installPath });
        }
        const parentDir = path.dirname(installPath);
        if (parentDir && parentDir !== installPath) {
          candidateInfoEntries.push(
            { infoPath: path.join(parentDir, `goggame-${gameId}.info`) },
            { infoPath: path.join(parentDir, `.goggame-${gameId}.info`) }
          );
        }

        if (!hasRootInfo && nestedSubDirsScanned.length > 0) {
          for (const subDir of nestedSubDirsScanned) {
            if (
              (await pathExistsAsync(path.join(subDir, `goggame-${gameId}.info`))) ||
              (await pathExistsAsync(path.join(subDir, `.goggame-${gameId}.info`)))
            ) {
              effectiveInstallPath = subDir;
              break;
            }
          }
        }

        if (!clientId) {
          for (const entry of candidateInfoEntries) {
            const { infoPath, nestedSubDir } = entry;
            if (!infoPath || !(await pathExistsAsync(infoPath))) continue;
            try {
              const parsedInfo = JSON.parse(await fs.promises.readFile(infoPath, 'utf8'));
              const candidateClientId = sanitizeGogGameClientId(
                parsedInfo?.clientId,
                hasRemoteConfigOverride
              );
              if (candidateClientId) {
                clientId = candidateClientId;
                if (!hasRootInfo && nestedSubDir) {
                  effectiveInstallPath = nestedSubDir;
                }
                break;
              }
            } catch (infoErr) {
              diagLog.warn('cloudSave.gogParseInfoJson', infoErr, { infoPath });
            }
          }
        }
      }

      if (
        !clientId &&
        cachedMap?.__productClientIds &&
        typeof cachedMap.__productClientIds === 'object'
      ) {
        const cachedClientId = sanitizeGogGameClientId(
          cachedMap.__productClientIds[gameId],
          false
        );
        if (cachedClientId) {
          clientId = cachedClientId;
        }
      }

      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
      if (
        !clientId &&
        !hasRemoteConfigOverride &&
        options.forceCloudSaveSync !== true &&
        cachedMap?.__noCloudProductIds &&
        typeof cachedMap.__noCloudProductIds === 'object'
      ) {
        const negCachedAt = Number(cachedMap.__noCloudProductIds[gameId] || 0);
        if (negCachedAt > 0 && Date.now() - negCachedAt < SEVEN_DAYS_MS) {
          return {
            synced: false,
            gameId,
            mode,
            cachedNegative: true,
            reason: 'no_cloud_saves_configured',
          };
        }
      }

      if (!clientId && canUseNetwork) {
        const primaryOs = useWindowsLocations ? 'windows' : 'osx';
        const fallbackOs = primaryOs === 'osx' ? 'windows' : 'osx';
        const osCandidates = [primaryOs, fallbackOs];
        const generations = [2, 1];
        let anyBuildsHttpJsonResponse = false;

        for (const gen of generations) {
          if (clientId) break;
          for (const osCandidate of osCandidates) {
            if (clientId) break;
            const buildsUrl = `https://content-system.gog.com/products/${encodeURIComponent(gameId)}/os/${osCandidate}/builds?generation=${gen}`;
            const buildsJson = await fetchGogV1Json(buildsUrl, {}, 8000, effectiveFetchImpl);
            if (!buildsJson || typeof buildsJson !== 'object') continue;
            anyBuildsHttpJsonResponse = true;

            const directCandidates = [
              ...(Array.isArray(buildsJson.items)
                ? buildsJson.items.map((/** @type {any} */ it) => it?.clientId)
                : []),
              buildsJson.clientId,
              buildsJson.product?.clientId,
            ];
            for (const rawCid of directCandidates) {
              const cleaned = sanitizeGogGameClientId(rawCid, false);
              if (cleaned) {
                clientId = cleaned;
                break;
              }
            }

            if (!clientId && buildsJson?.items?.[0]?.link) {
              const repoJson = await fetchGogV1Json(
                buildsJson.items[0].link,
                {},
                8000,
                effectiveFetchImpl
              );
              const repoCid = sanitizeGogGameClientId(
                repoJson?.clientId || repoJson?.product?.clientId,
                false
              );
              if (repoCid) {
                clientId = repoCid;
              }
            }
          }
        }

        if (clientId) {
          try {
            await withCloudManifestFileLock(configCachePath, async () => {
              /** @type {Record<string, any>} */
              let freshMap = {};
              try {
                if (await pathExistsAsync(configCachePath)) {
                  freshMap = JSON.parse(await fs.promises.readFile(configCachePath, 'utf8')) || {};
                }
              } catch {}
              if (
                !freshMap.__productClientIds ||
                typeof freshMap.__productClientIds !== 'object'
              ) {
                freshMap.__productClientIds = {};
              }
              freshMap.__productClientIds[gameId] = clientId;
              if (
                freshMap.__noCloudProductIds &&
                typeof freshMap.__noCloudProductIds === 'object'
              ) {
                delete freshMap.__noCloudProductIds[gameId];
              }
              const pruned = pruneGogCloudConfigsMap(freshMap, MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES);
              cachedMap = pruned;
              await atomicWriteFileAsync(configCachePath, JSON.stringify(pruned, null, 2));
            });
          } catch (prodCacheErr) {
            diagLog.warn('cloudSave.gogWriteProductClientIdCache', prodCacheErr, {
              configCachePath,
              gameId,
            });
          }
        } else if (anyBuildsHttpJsonResponse) {
          // Negative-cache confirmed non-cloud GOG product IDs for 7 days
          try {
            await withCloudManifestFileLock(configCachePath, async () => {
              /** @type {Record<string, any>} */
              let freshMap = {};
              try {
                if (await pathExistsAsync(configCachePath)) {
                  freshMap = JSON.parse(await fs.promises.readFile(configCachePath, 'utf8')) || {};
                }
              } catch {}
              if (
                !freshMap.__noCloudProductIds ||
                typeof freshMap.__noCloudProductIds !== 'object'
              ) {
                freshMap.__noCloudProductIds = {};
              }
              freshMap.__noCloudProductIds[gameId] = Date.now();
              const pruned = pruneGogCloudConfigsMap(freshMap, MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES);
              cachedMap = pruned;
              await atomicWriteFileAsync(configCachePath, JSON.stringify(pruned, null, 2));
            });
          } catch (negCacheErr) {
            diagLog.warn('cloudSave.gogWriteNoCloudProductCache', negCacheErr, {
              configCachePath,
              gameId,
            });
          }
        }
      }

      if (!clientId) {
        return { synced: false, gameId, mode, reason: 'missing_client_id' };
      }

      // 2. Fetch or read cached remote-config (7-day TTL, 250-entry LRU cap)
      let remoteConfig = options.gogRemoteConfigOverride || null;

      if (!remoteConfig) {
        const cachedEntry = cachedMap[clientId];
        if (
          cachedEntry &&
          cachedEntry.config &&
          typeof cachedEntry.fetchedAt === 'number' &&
          Date.now() - cachedEntry.fetchedAt < SEVEN_DAYS_MS
        ) {
          remoteConfig = cachedEntry.config;
          const accessedAt = Date.now();
          cachedEntry.lastAccessedAt = accessedAt;
          if (Object.keys(cachedMap).length > MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES) {
            try {
              await withCloudManifestFileLock(configCachePath, async () => {
                /** @type {Record<string, any>} */
                let freshMap = {};
                try {
                  if (await pathExistsAsync(configCachePath)) {
                    freshMap =
                      JSON.parse(await fs.promises.readFile(configCachePath, 'utf8')) || {};
                  }
                } catch {}
                if (freshMap[clientId] && typeof freshMap[clientId] === 'object') {
                  freshMap[clientId].lastAccessedAt = accessedAt;
                } else {
                  freshMap[clientId] = cachedEntry;
                }
                const pruned = pruneGogCloudConfigsMap(
                  freshMap,
                  MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES
                );
                cachedMap = pruned;
                await atomicWriteFileAsync(configCachePath, JSON.stringify(pruned, null, 2));
              });
            } catch (pruneErr) {
              diagLog.warn('cloudSave.gogPruneConfigCache', pruneErr, { configCachePath });
            }
          }
        } else if (canUseNetwork) {
          const rcUrl = `https://remote-config.gog.com/components/galaxy_client/clients/${encodeURIComponent(clientId)}?component_version=2.0.45`;
          const fetched = await fetchGogV1Json(rcUrl, {}, 8000, effectiveFetchImpl);
          if (fetched && typeof fetched === 'object') {
            remoteConfig = fetched;
            try {
              const now = Date.now();
              await withCloudManifestFileLock(configCachePath, async () => {
                /** @type {Record<string, any>} */
                let freshMap = {};
                try {
                  if (await pathExistsAsync(configCachePath)) {
                    freshMap =
                      JSON.parse(await fs.promises.readFile(configCachePath, 'utf8')) || {};
                  }
                } catch {}
                freshMap[clientId] = {
                  fetchedAt: now,
                  lastAccessedAt: now,
                  config: fetched,
                };
                const pruned = pruneGogCloudConfigsMap(
                  freshMap,
                  MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES
                );
                cachedMap = pruned;
                await atomicWriteFileAsync(configCachePath, JSON.stringify(pruned, null, 2));
              });
            } catch (cacheWriteErr) {
              diagLog.warn('cloudSave.gogWriteConfigCache', cacheWriteErr, { configCachePath });
            }
          } else if (cachedEntry && cachedEntry.config) {
            remoteConfig = cachedEntry.config;
          }
        }
      }

      if (!remoteConfig || typeof remoteConfig !== 'object') {
        return { synced: false, gameId, clientId, mode, reason: 'no_cloud_saves_configured' };
      }

      const contentRoot =
        remoteConfig.content && typeof remoteConfig.content === 'object'
          ? remoteConfig.content
          : remoteConfig;
      const osSection = useWindowsLocations
        ? contentRoot.Windows || contentRoot.windows
        : contentRoot.MacOS || contentRoot.macOS || contentRoot.OSX || contentRoot.osx;
      const cloudStorage = osSection?.cloudStorage;
      const rawLocations = Array.isArray(cloudStorage?.locations) ? cloudStorage.locations : [];

      if (!cloudStorage?.enabled && rawLocations.length === 0) {
        return { synced: false, gameId, clientId, mode, reason: 'no_cloud_saves_configured' };
      }

      const effectiveLocations =
        rawLocations.length > 0
          ? rawLocations
          : [
              {
                name: '__default',
                location: `<?APPLICATION_DATA_LOCAL?>/GOG.com/Galaxy/Applications/${clientId}/Storage/Shared/Files`,
              },
            ];

      const effectiveWinePrefix = String(options.winePrefix || payload.winePrefix || '').trim();
      const resolvedLocations = resolveGogCloudSaveLocations(effectiveLocations, {
        platform: targetPlatform,
        useCompatLayer,
        winePrefix: effectiveWinePrefix,
        installPath: effectiveInstallPath,
        homedir,
        clientId,
        windowsKnownFolders: options.windowsKnownFolders,
        windowsRegistryOutput: options.windowsRegistryOutput,
        env: options.env,
      });

      if (resolvedLocations.length === 0) {
        return { synced: false, gameId, clientId, mode, reason: 'no_resolvable_save_locations' };
      }

      // 3. Resolve gogdl binary & authConfigPath
      const gogdlBin = options.gogdlBinaryPath || findGogdlBinary(options);
      let authConfigPath = options.gogAuthConfigPath || null;
      if (!authConfigPath) {
        const authInfo = await ensureGogdlAuthConfig(options);
        if (authInfo && authInfo.authenticated && authInfo.gogAuthPath) {
          authConfigPath = authInfo.gogAuthPath;
        }
      }

      if (!gogdlBin || !authConfigPath) {
        return { synced: false, gameId, clientId, mode, reason: 'missing_gogdl_or_auth' };
      }

      // 4. Load per-location sync timestamps and execute gogdl save-sync with tree-kill timeout
      const timestampsPath = path.join(userDataDir, 'one_launcher_cloud_sync_timestamps.json');
      /** @type {Record<string, any>} */
      let timestampsData = {};
      try {
        if (await pathExistsAsync(timestampsPath)) {
          timestampsData = JSON.parse(await fs.promises.readFile(timestampsPath, 'utf8')) || {};
        }
      } catch (tsErr) {
        diagLog.warn('cloudSave.gogReadTimestamps', tsErr, { timestampsPath });
      }
      if (!timestampsData.gog || typeof timestampsData.gog !== 'object') {
        timestampsData.gog = {};
      }
      if (
        !timestampsData.gogLegacyMigrated ||
        typeof timestampsData.gogLegacyMigrated !== 'object'
      ) {
        timestampsData.gogLegacyMigrated = {};
      }

      const backupQuotaOpts = {
        maxTotalBackupBytes: options.maxTotalBackupBytes,
        maxSnapshotsPerGame: options.maxSnapshotsPerGame,
        userDataDir,
        backupsRootDir: options.backupsRootDir,
        platform: targetPlatform,
        getWin32FileAttributes: options.getWin32FileAttributes,
        oneDriveAttribExecImpl: options.oneDriveAttribExecImpl,
        forceOneDriveCheck: options.forceOneDriveCheck,
      };

      const syncedLocations = [];
      /** @type {Record<string, number>} */
      const updatedTimestampDeltas = {};
      /** @type {Record<string, string>} */
      const updatedLegacyMigrationClaims = {};
      let anySuccess = false;
      let lastFailureReason = '';
      let lastBackupPath = null;
      const syncTimeoutMs = Number(options.cloudSyncTimeoutMs || 60000);
      const osKey = useWindowsLocations ? 'windows' : 'osx';

      for (const loc of resolvedLocations) {
        if (
          !loc ||
          typeof loc.resolvedPath !== 'string' ||
          !loc.resolvedPath.trim() ||
          loc.resolvedPath.trim().startsWith('-')
        ) {
          lastFailureReason = 'unsafe_cloud_save_path_rejected';
          continue;
        }
        if (loc.name && loc.name !== '__default' && !isSafeGogLocationName(loc.name)) {
          diagLog.warn(
            'cloudSave.gogUnsafeLocationNameBlocked',
            'Blocked GOG cloud save sync due to unsafe CLI flag or path characters in loc.name',
            { gameId, locationName: loc.name }
          );
          lastFailureReason = 'unsafe_cloud_save_location_name';
          continue;
        }
        if (isBroadOneDriveKnownFolderRoot(loc.resolvedPath)) {
          diagLog.warn(
            'cloudSave.gogBroadOneDriveRootBlocked',
            'Blocked GOG cloud save sync on broad OneDrive Known Folder root without game subfolder',
            { gameId, resolvedPath: loc.resolvedPath }
          );
          lastFailureReason = 'broad_known_folder_root_blocked';
          continue;
        }

        // Re-verify realpath/symlink containment asynchronously right before filesystem access
        const anchorMeta = getResolvedGogLocationAnchor(loc);
        if (anchorMeta) {
          const realCheck = await verifySavePathRealContainmentAsync(
            anchorMeta.normalizedAnchor,
            loc.resolvedPath,
            anchorMeta.containmentPlatform
          );
          if (!realCheck.ok) {
            diagLog.warn(
              'cloudSave.gogSymlinkEscapeBlocked',
              'Blocked GOG cloud save sync due to symlink/junction escaping placeholder root',
              { gameId, resolvedPath: loc.resolvedPath, reason: realCheck.reason }
            );
            lastFailureReason = 'unsafe_cloud_save_path_rejected';
            continue;
          }
        }

        const hostLocPath = toHostFilesystemPath(loc.resolvedPath);
        // Single OneDrive placeholder probe per location — reused by rolling backup below!
        const placeholderCheck = await inspectOneDrivePlaceholderStateAsync(
          hostLocPath,
          backupQuotaOpts
        );
        if (placeholderCheck.blockedBroadRoot) {
          lastFailureReason = 'broad_known_folder_root_blocked';
          continue;
        }
        if (placeholderCheck.hasPlaceholders) {
          diagLog.warn(
            'cloudSave.gogOneDrivePlaceholderSkipped',
            'Skipped GOG cloud save sync on unhydrated OneDrive Files On-Demand placeholder files',
            {
              gameId,
              resolvedPath: loc.resolvedPath,
              sampleFiles: Array.isArray(placeholderCheck.placeholderFiles)
                ? placeholderCheck.placeholderFiles.slice(0, 5)
                : [],
            }
          );
          lastFailureReason = 'onedrive_cloud_placeholder_skipped';
          continue;
        }

        const isInstallScopedLocation = /^<\?INSTALL\?>/i.test(String(loc.location || '').trim());
        const bottleScope = !useCompatLayer
          ? 'host'
          : isInstallScopedLocation
            ? 'install'
            : computeWinePrefixBottleScope(effectiveWinePrefix);
        const scopedLocKey = `${gameId}:${osKey}:${bottleScope}:${loc.name}`;
        const legacyLocKey = `${gameId}:${osKey}:${loc.name}`;
        const hygiene = await purgeOsMetadataAndCountRealFilesAsync(hostLocPath);
        const dirExistsBeforeSync = await pathExistsAsync(hostLocPath);

        const scopedStoredTs = Number(timestampsData.gog[scopedLocKey] || 0);
        const legacyStoredTs = Number(timestampsData.gog[legacyLocKey] || 0);
        const existingLegacyClaim =
          typeof timestampsData.gogLegacyMigrated[legacyLocKey] === 'string'
            ? timestampsData.gogLegacyMigrated[legacyLocKey]
            : '';

        let inheritedFromLegacy = false;
        let lastTs = 0;
        if (scopedStoredTs > 0) {
          lastTs = scopedStoredTs;
        } else if (legacyStoredTs > 0) {
          if (bottleScope === 'host' || bottleScope === 'install') {
            lastTs = legacyStoredTs;
            inheritedFromLegacy = true;
          } else if (
            hygiene.realFileCount > 0 &&
            (!existingLegacyClaim || existingLegacyClaim === bottleScope)
          ) {
            lastTs = legacyStoredTs;
            inheritedFromLegacy = true;
          } else {
            lastTs = 0;
          }
        } else if (Number(options.fallbackLastSyncTsSec) > 0) {
          lastTs = Math.floor(Number(options.fallbackLastSyncTsSec));
        }

        // Empty-dir pre-launch safety: NEVER allow gogdl --skip-upload to treat missing files
        // in a new/empty bottle as local deletions!
        const effectiveLastTs =
          mode === 'pre_launch' && (!dirExistsBeforeSync || hygiene.realFileCount === 0)
            ? 0
            : lastTs;

        if (mode === 'pre_launch' || mode === 'both') {
          const safeLocName = String(loc.name || '__default').replace(/[^a-zA-Z0-9_-]/g, '_');
          const backupRoot = path.join(
            userDataDir,
            'cloud_save_backups',
            'gog',
            String(gameId),
            safeLocName
          );
          const backupRes = await createCloudSaveRollingBackupAsync(
            hostLocPath,
            backupRoot,
            Number(options.maxBackupBytes) > 0
              ? Number(options.maxBackupBytes)
              : resolveDefaultPerSnapshotMaxBackupBytes(options),
            {
              ...backupQuotaOpts,
              precheckedPlaceholderState: placeholderCheck,
            }
          );
          if (backupRes?.backupPath) {
            lastBackupPath = backupRes.backupPath;
          }
          try {
            await fs.promises.mkdir(hostLocPath, { recursive: true });
          } catch (mkdirErr) {
            diagLog.warn('cloudSave.gogMkdirSaveDir', mkdirErr, { path: loc.resolvedPath });
          }
        } else if (!dirExistsBeforeSync || hygiene.realFileCount === 0) {
          continue;
        }

        const syncArgs = [
          '--auth-config-path',
          authConfigPath,
          'save-sync',
          loc.resolvedPath,
          String(gameId),
          '--ts',
          String(effectiveLastTs),
          '--os',
          osKey,
        ];
        if (loc.name && loc.name !== '__default') {
          syncArgs.push('--name', loc.name);
        }
        if (mode === 'pre_launch') {
          syncArgs.push('--skip-upload');
        } else if (mode === 'post_exit') {
          syncArgs.push('--skip-download');
        }

        const gogdlExecOpts = {
          env: {
            ...process.env,
            ...(useCompatLayer && effectiveWinePrefix ? { WINEPREFIX: effectiveWinePrefix } : {}),
          },
          timeout: syncTimeoutMs,
        };
        let execRes = await execCliWithTreeTimeout(gogdlBin, syncArgs, gogdlExecOpts, options);
        let combinedOutput = `${execRes.stdout}\n${execRes.stderr}`.trim();

        if (
          execRes.err &&
          mode === 'post_exit' &&
          /FileNotFoundError|No such file or directory/i.test(
            `${combinedOutput}\n${execRes.err?.message || ''}`
          )
        ) {
          const retryDelayMs = isTestEnvironment(options) ? 0 : 750;
          if (retryDelayMs > 0) {
            await sleepUnrefWithAbortAsync(retryDelayMs, options.signal);
          }
          const retryHygiene = await purgeOsMetadataAndCountRealFilesAsync(hostLocPath);
          if ((await pathExistsAsync(hostLocPath)) && retryHygiene.realFileCount > 0) {
            execRes = await execCliWithTreeTimeout(gogdlBin, syncArgs, gogdlExecOpts, options);
            combinedOutput = `${execRes.stdout}\n${execRes.stderr}`.trim();
          }
        }

        if (!execRes.err) {
          const updatedTs = parseGogdlSyncTimestampFromStdout(execRes);
          timestampsData.gog[scopedLocKey] = updatedTs;
          updatedTimestampDeltas[scopedLocKey] = updatedTs;
          if (bottleScope === 'host' || bottleScope === 'install') {
            timestampsData.gog[legacyLocKey] = updatedTs;
            updatedTimestampDeltas[legacyLocKey] = updatedTs;
          } else if (inheritedFromLegacy) {
            timestampsData.gogLegacyMigrated[legacyLocKey] = bottleScope;
            updatedLegacyMigrationClaims[legacyLocKey] = bottleScope;
          }
          anySuccess = true;
          syncedLocations.push({
            name: loc.name,
            resolvedPath: loc.resolvedPath,
            args: syncArgs,
            timestamp: updatedTs,
            bottleScope,
          });
        } else {
          lastFailureReason =
            combinedOutput || execRes.err.message || 'gogdl_save_sync_failed';
          diagLog.warn('cloudSave.gogSyncFailed', lastFailureReason, {
            gameId,
            mode,
            location: loc.name,
          });
        }
      }

      if (anySuccess) {
        try {
          await withCloudManifestFileLock(timestampsPath, async () => {
            /** @type {Record<string, any>} */
            let freshTimestamps = {};
            try {
              if (await pathExistsAsync(timestampsPath)) {
                freshTimestamps =
                  JSON.parse(await fs.promises.readFile(timestampsPath, 'utf8')) || {};
              }
            } catch {}
            if (!freshTimestamps.gog || typeof freshTimestamps.gog !== 'object') {
              freshTimestamps.gog = {};
            }
            for (const [k, v] of Object.entries(updatedTimestampDeltas)) {
              freshTimestamps.gog[k] = v;
            }
            if (Object.keys(updatedLegacyMigrationClaims).length > 0) {
              if (
                !freshTimestamps.gogLegacyMigrated ||
                typeof freshTimestamps.gogLegacyMigrated !== 'object'
              ) {
                freshTimestamps.gogLegacyMigrated = {};
              }
              for (const [k, v] of Object.entries(updatedLegacyMigrationClaims)) {
                if (!freshTimestamps.gogLegacyMigrated[k]) {
                  freshTimestamps.gogLegacyMigrated[k] = v;
                }
              }
            }
            await atomicWriteFileAsync(timestampsPath, JSON.stringify(freshTimestamps, null, 2));
          });
        } catch (tsWriteErr) {
          diagLog.warn('cloudSave.gogWriteTimestamps', tsWriteErr, { timestampsPath });
        }
        return {
          synced: true,
          gameId,
          clientId,
          mode,
          locations: syncedLocations,
          ...(lastBackupPath ? { backupPath: lastBackupPath } : {}),
        };
      }

      return {
        synced: false,
        gameId,
        clientId,
        mode,
        reason: lastFailureReason || 'nothing_to_sync',
        ...(lastBackupPath ? { backupPath: lastBackupPath } : {}),
      };
    }

    /**
     * Synchronize GOG cloud saves serialized per game via `withPerGameCloudSyncLock`.
     *
     * @param {Record<string, any>} [payload]
     * @param {string} [mode='both']
     * @param {Record<string, any>} [options]
     */
    async function syncGogCloudSaves(payload = {}, mode = 'both', options = {}) {
      try {
        if (payload.platformId !== 'gog') {
          return { synced: false, mode, reason: 'invalid_platform' };
        }
        const gameId = String(payload.platformGameId || payload.gameId || '')
          .replace(/^gog[-_]/i, '')
          .trim();
        if (!gameId) {
          return { synced: false, mode, reason: 'missing_game_id' };
        }
        if (!isSafeGogGameId(gameId)) {
          diagLog.warn(
            'cloudSave.gogUnsafeGameIdRejected',
            'Rejected GOG cloud save sync due to unsafe gameId CLI/path characters',
            { gameId }
          );
          return { synced: false, gameId, mode, reason: 'unsafe_game_id_rejected' };
        }
        if (!isNetworkOnlineForLaunch(options)) {
          return { synced: false, gameId, mode, offlineSkipped: true, reason: 'offline_skipped' };
        }

        const lockKey = buildPerGameCloudSyncLockKey('gog', gameId);
        if (!lockKey || options._cloudSyncLockHeldKey === lockKey) {
          return await runSyncGogCloudSaves(payload, mode, options, gameId);
        }
        return await withPerGameCloudSyncLock(lockKey, () =>
          runSyncGogCloudSaves(payload, mode, { ...options, _cloudSyncLockHeldKey: lockKey }, gameId)
        );
      } catch (err) {
        diagLog.warn('cloudSave.gogUnhandled', err, { mode });
        const anyErr = /** @type {any} */ (err);
        return {
          synced: false,
          mode,
          reason: anyErr && anyErr.message ? anyErr.message : 'gog_sync_failed',
        };
      }
    }

    /**
     * @param {Record<string, any>} payload
     * @param {string} mode
     * @param {Record<string, any>} options
     * @param {string} appName
     */
    async function runSyncEpicCloudSaves(payload, mode, options, appName) {
      const canRunSync =
        (!isTestEnvironment(options) && !options.skipCloudSaveSync) ||
        typeof options.execFileImpl === 'function' ||
        typeof options.execFileFn === 'function' ||
        options.allowCloudSaveSyncInTest === true;

      let resolvedLegAuth =
        options.prefetchedLegAuth && typeof options.prefetchedLegAuth === 'object'
          ? options.prefetchedLegAuth
          : null;
      if (
        !resolvedLegAuth &&
        canRunSync &&
        !options.skipAuthRefresh &&
        !options.legendaryConfigDir &&
        !options.legendaryConfigPath
      ) {
        try {
          resolvedLegAuth = await ensureLegendaryConfigAndAuth(options);
        } catch (authErr) {
          diagLog.warn('cloudSave.epicEnsureAuth', authErr, { appName });
        }
      }

      const targetPlatform = options.platform || process.platform;
      const useCompatLayer = Boolean(options.useCompatLayer || payload.useCompatLayer);
      const winePrefix = options.winePrefix || payload.winePrefix || '';
      const installPath = String(payload.installPath || options.installPath || '').trim();
      const { homedir, userDataDir } = resolveIsolatedHomedirAndUserData(options);

      let hasCloudSaveFolder = Boolean(options.forceCloudSaveSync === true);
      let cloudSaveFolderTemplate = String(options.cloudSaveFolderTemplate || '').trim();
      if (cloudSaveFolderTemplate) {
        hasCloudSaveFolder = true;
      }

      const hasExplicitInclude = options.cloudIncludeList !== undefined;
      const hasExplicitExclude = options.cloudExcludeList !== undefined;
      let includePatterns = parseEpicCloudPatternList(options.cloudIncludeList);
      let excludePatterns = parseEpicCloudPatternList(options.cloudExcludeList);

      const legCfgDir = getLegendaryConfigDir(options);
      if (!cloudSaveFolderTemplate || (!hasExplicitInclude && !hasExplicitExclude)) {
        /** @type {Set<string>} */
        const candidateMetaFiles = new Set();
        if (legCfgDir) {
          candidateMetaFiles.add(path.join(legCfgDir, 'metadata', `${appName}.json`));
          candidateMetaFiles.add(path.join(legCfgDir, 'legendary', 'metadata', `${appName}.json`));
        }
        try {
          const localSupport = collectLocalEpicMetadataAndSupport(options);
          if (localSupport && Array.isArray(localSupport.configDirs)) {
            for (const dir of localSupport.configDirs) {
              candidateMetaFiles.add(path.join(dir, 'metadata', `${appName}.json`));
            }
          }
        } catch (metaScanErr) {
          diagLog.debug('cloudSave.epicLocalSupport', metaScanErr, { appName });
        }

        for (const metaPath of candidateMetaFiles) {
          if (!metaPath || !(await pathExistsAsync(metaPath))) continue;
          try {
            const parsed = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
            const attrs = parsed?.metadata?.customAttributes || parsed?.customAttributes || {};
            const isNativeMac = targetPlatform === 'darwin' && !useCompatLayer;
            if (!cloudSaveFolderTemplate) {
              const folderVal = isNativeMac
                ? attrs?.CloudSaveFolder_MAC?.value ||
                  attrs?.CloudSaveFolder_Mac?.value ||
                  attrs?.CloudSaveFolder?.value ||
                  ''
                : attrs?.CloudSaveFolder?.value ||
                  attrs?.CloudSaveFolder_MAC?.value ||
                  attrs?.CloudSaveFolder_Mac?.value ||
                  '';
              if (typeof folderVal === 'string' && folderVal.trim()) {
                hasCloudSaveFolder = true;
                cloudSaveFolderTemplate = folderVal.trim();
              }
            }
            if (!hasExplicitInclude && includePatterns.length === 0) {
              const rawInclude = isNativeMac
                ? attrs?.CloudIncludeList_MAC?.value ||
                  attrs?.CloudIncludeList_Mac?.value ||
                  attrs?.CloudIncludeList?.value
                : attrs?.CloudIncludeList?.value;
              includePatterns = parseEpicCloudPatternList(rawInclude);
            }
            if (!hasExplicitExclude && excludePatterns.length === 0) {
              const rawExclude = isNativeMac
                ? attrs?.CloudExcludeList_MAC?.value ||
                  attrs?.CloudExcludeList_Mac?.value ||
                  attrs?.CloudExcludeList?.value
                : attrs?.CloudExcludeList?.value;
              excludePatterns = parseEpicCloudPatternList(rawExclude);
            }
            if (cloudSaveFolderTemplate) {
              break;
            }
          } catch (metaReadErr) {
            diagLog.warn('cloudSave.epicReadMetadataJson', metaReadErr, { metaPath });
          }
        }
      }

      if (!hasCloudSaveFolder) {
        return {
          synced: false,
          appName,
          mode,
          reason: 'no_cloud_save_folder_or_skipped',
        };
      }

      if (cloudSaveFolderTemplate && !isSafeEpicSaveTemplateSyntax(cloudSaveFolderTemplate)) {
        diagLog.warn(
          'cloudSave.epicUnsafeTemplateRejected',
          'Rejected Epic cloud save sync due to unsafe CloudSaveFolder template',
          { appName, cloudSaveFolderTemplate }
        );
        return {
          synced: false,
          appName,
          mode,
          cloudSaveFolder: cloudSaveFolderTemplate,
          reason: 'unsafe_cloud_save_path_rejected',
        };
      }

      if (!canRunSync) {
        return {
          synced: false,
          appName,
          mode,
          cloudSaveFolder: cloudSaveFolderTemplate || null,
          reason: 'skipped_in_test',
        };
      }

      const legendaryBin =
        options.legendaryBinaryPath ||
        findLegendaryBinary(options) ||
        (typeof options.execFileImpl === 'function' || typeof options.execFileFn === 'function'
          ? 'legendary'
          : null);
      if (!legendaryBin) {
        return {
          synced: false,
          appName,
          mode,
          reason: 'legendary_binary_not_found',
        };
      }

      let epicAccountId = String(
        options.epicAccountId || payload.epicAccountId || resolvedLegAuth?.accountId || ''
      ).trim();
      if (!epicAccountId && legCfgDir) {
        const userJsonCandidates = [
          path.join(legCfgDir, 'user.json'),
          path.join(legCfgDir, 'legendary', 'user.json'),
        ];
        for (const uj of userJsonCandidates) {
          if (!(await pathExistsAsync(uj))) continue;
          try {
            const parsedUser = JSON.parse(await fs.promises.readFile(uj, 'utf8'));
            if (parsedUser && parsedUser.account_id) {
              epicAccountId = String(parsedUser.account_id).trim();
              break;
            }
          } catch (ujErr) {
            diagLog.debug('cloudSave.epicReadUserJson', ujErr, { uj });
          }
        }
      }

      const legEnv = {
        ...process.env,
        ...(options.env || {}),
        LC_ALL: normalizePosixUtf8Locale(options.env?.LC_ALL ?? process.env.LC_ALL),
        LANG: normalizePosixUtf8Locale(options.env?.LANG ?? process.env.LANG),
        ...(legCfgDir ? { LEGENDARY_CONFIG_PATH: legCfgDir } : {}),
        ...(useCompatLayer && winePrefix ? { WINEPREFIX: winePrefix } : {}),
      };

      const readLegendaryInstalledEntryAsync = async () => {
        if (!legCfgDir) return null;
        const installedJsonCandidates = [
          path.join(legCfgDir, 'installed.json'),
          path.join(legCfgDir, 'legendary', 'installed.json'),
        ];
        for (const instPath of installedJsonCandidates) {
          if (!(await pathExistsAsync(instPath))) continue;
          try {
            const installedMap = JSON.parse(await fs.promises.readFile(instPath, 'utf8'));
            if (installedMap && typeof installedMap === 'object' && installedMap[appName]) {
              return installedMap[appName];
            }
          } catch (instErr) {
            diagLog.warn('cloudSave.epicReadInstalledJson', instErr, { instPath });
          }
        }
        return null;
      };

      let installedJsonRecord = await readLegendaryInstalledEntryAsync();

      // Official Epic Games Launcher auto-import into Legendary installed.json when missing,
      // recording the external import in `one_launcher_epic_imports.json` so Windows uninstaller never deletes it!
      if (
        installPath &&
        !installPath.startsWith('-') &&
        (await pathExistsAsync(installPath)) &&
        legCfgDir &&
        !installedJsonRecord
      ) {
        const importPlatform = useCompatLayer || targetPlatform === 'win32' ? 'Windows' : 'Mac';
        const importRes = await execCliWithTreeTimeout(
          legendaryBin,
          ['import', appName, installPath, '--platform', importPlatform, '--disable-check', '-y'],
          { env: legEnv, timeout: 15000 },
          options
        );
        if (!importRes.err) {
          recordImportedEpicInstall(appName, installPath, options);
          installedJsonRecord = await readLegendaryInstalledEntryAsync();
        } else {
          diagLog.warn('cloudSave.epicImportFailed', importRes.err, { appName, installPath });
        }
      }

      const resolvedSavePath = cloudSaveFolderTemplate
        ? resolveEpicSavePathTemplate(cloudSaveFolderTemplate, {
            platform: targetPlatform,
            useCompatLayer,
            winePrefix,
            installPath,
            epicAccountId,
            homedir,
            windowsKnownFolders: options.windowsKnownFolders,
            windowsRegistryOutput: options.windowsRegistryOutput,
            env: options.env,
          })
        : '';
      const hasCompleteResolvedSavePath =
        Boolean(resolvedSavePath) &&
        !/\{[^}]+\}/.test(resolvedSavePath) &&
        !resolvedSavePath.trim().startsWith('-');

      if (useCompatLayer && !hasCompleteResolvedSavePath) {
        diagLog.warn(
          'cloudSave.epicUnresolvedBottleSavePathBlocked',
          'Blocked Epic cloud save sync under compatibility layer without a complete resolved bottle save path',
          {
            appName,
            mode,
            cloudSaveFolder: cloudSaveFolderTemplate || null,
            hasWinePrefix: Boolean(winePrefix),
          }
        );
        return {
          synced: false,
          appName,
          mode,
          cloudSaveFolder: cloudSaveFolderTemplate || null,
          reason: 'unresolved_bottle_save_path',
        };
      }

      if (hasCompleteResolvedSavePath) {
        const epicAnchorMeta = getResolvedEpicPathAnchor(resolvedSavePath);
        if (epicAnchorMeta) {
          const realCheck = await verifySavePathRealContainmentAsync(
            epicAnchorMeta.normalizedAnchor,
            resolvedSavePath,
            epicAnchorMeta.containmentPlatform
          );
          if (!realCheck.ok) {
            diagLog.warn(
              'cloudSave.epicSymlinkEscapeBlocked',
              'Blocked Epic cloud save sync due to symlink/junction escaping placeholder root',
              { appName, resolvedSavePath, reason: realCheck.reason }
            );
            return {
              synced: false,
              appName,
              mode,
              cloudSaveFolder: cloudSaveFolderTemplate || null,
              resolvedSavePath,
              reason: 'unsafe_cloud_save_path_rejected',
            };
          }
        }
      }

      const backupQuotaOpts = {
        maxTotalBackupBytes: options.maxTotalBackupBytes,
        maxSnapshotsPerGame: options.maxSnapshotsPerGame,
        userDataDir,
        backupsRootDir: options.backupsRootDir,
        platform: targetPlatform,
        getWin32FileAttributes: options.getWin32FileAttributes,
        oneDriveAttribExecImpl: options.oneDriveAttribExecImpl,
        forceOneDriveCheck: options.forceOneDriveCheck,
      };

      if (hasCompleteResolvedSavePath && isBroadOneDriveKnownFolderRoot(resolvedSavePath)) {
        diagLog.warn(
          'cloudSave.epicBroadOneDriveRootBlocked',
          'Blocked Epic cloud save sync on broad OneDrive Known Folder root without game subfolder',
          { appName, resolvedSavePath }
        );
        return {
          synced: false,
          appName,
          mode,
          cloudSaveFolder: cloudSaveFolderTemplate || null,
          resolvedSavePath,
          reason: 'broad_known_folder_root_blocked',
        };
      }

      const execMockFn =
        typeof options.execFileImpl === 'function'
          ? options.execFileImpl
          : typeof options.execFileFn === 'function'
            ? options.execFileFn
            : null;
      const hostResolvedSavePath = resolvedSavePath ? toHostFilesystemPath(resolvedSavePath) : '';
      const saveDirExistsBefore =
        hasCompleteResolvedSavePath &&
        Boolean(hostResolvedSavePath) &&
        (await pathExistsAsync(hostResolvedSavePath));

      const isSaveRootSameAsInstallDir = Boolean(
        installPath &&
          hostResolvedSavePath &&
          normalizeComparableFsPath(hostResolvedSavePath) ===
            normalizeComparableFsPath(installPath)
      );
      const skipInstallDirWithoutIncludeList = Boolean(
        isSaveRootSameAsInstallDir && includePatterns.length === 0
      );
      const epicCaseInsensitive =
        targetPlatform === 'win32' || useCompatLayer || targetPlatform === 'darwin';
      const epicFileFilter =
        includePatterns.length > 0 || excludePatterns.length > 0
          ? createEpicCloudFileFilter(includePatterns, excludePatterns, epicCaseInsensitive)
          : null;

      /** @type {Record<string, any> | null} */
      let placeholderCheck = null;
      if (saveDirExistsBefore) {
        // Single OneDrive placeholder probe per sync — reused by rolling backup below!
        placeholderCheck = await inspectOneDrivePlaceholderStateAsync(
          hostResolvedSavePath,
          backupQuotaOpts
        );
        if (placeholderCheck.blockedBroadRoot) {
          return {
            synced: false,
            appName,
            mode,
            cloudSaveFolder: cloudSaveFolderTemplate || null,
            resolvedSavePath,
            reason: 'broad_known_folder_root_blocked',
          };
        }
        if (placeholderCheck.hasPlaceholders) {
          diagLog.warn(
            'cloudSave.epicOneDrivePlaceholderSkipped',
            'Skipped Epic cloud save sync on unhydrated OneDrive Files On-Demand placeholder files',
            {
              appName,
              resolvedSavePath,
              sampleFiles: Array.isArray(placeholderCheck.placeholderFiles)
                ? placeholderCheck.placeholderFiles.slice(0, 5)
                : [],
            }
          );
          return {
            synced: false,
            appName,
            mode,
            cloudSaveFolder: cloudSaveFolderTemplate || null,
            resolvedSavePath,
            reason: 'onedrive_cloud_placeholder_skipped',
            placeholderFiles: placeholderCheck.placeholderFiles,
          };
        }
      }

      let realFileCount = 0;
      if (saveDirExistsBefore) {
        if (skipInstallDirWithoutIncludeList) {
          // Avoid full-tree metadata purge across multi-GB {InstallDir} without CloudIncludeList
          realFileCount = 1;
        } else {
          const hygiene = await purgeOsMetadataAndCountRealFilesAsync(
            hostResolvedSavePath,
            epicFileFilter ? { fileFilter: epicFileFilter } : undefined
          );
          realFileCount = hygiene.realFileCount;
        }
      }

      if (mode === 'post_exit' && hasCompleteResolvedSavePath) {
        const hadPureVirtualMockPreLaunch = Boolean(
          execMockFn &&
            !saveDirExistsBefore &&
            options.enforceEmptySaveGuard !== true &&
            virtualMockPreLaunchByExecFn.get(execMockFn)?.has(appName)
        );
        if ((!saveDirExistsBefore || realFileCount === 0) && !hadPureVirtualMockPreLaunch) {
          return {
            synced: false,
            appName,
            mode,
            cloudSaveFolder: cloudSaveFolderTemplate || null,
            resolvedSavePath,
            reason: 'nothing_to_sync',
          };
        }
      }

      let backupPath = null;
      let backupSkippedReason = '';
      if ((mode === 'pre_launch' || mode === 'both') && hasCompleteResolvedSavePath) {
        if (skipInstallDirWithoutIncludeList) {
          backupSkippedReason = 'install_dir_without_include_list_skipped';
          diagLog.info(
            'cloudSave.epicInstallDirBackupSkipped',
            'Skipped rolling backup because CloudSaveFolder resolves to {InstallDir} without CloudIncludeList',
            { appName, resolvedSavePath }
          );
        } else {
          const safeAppName = appName.replace(/[^a-zA-Z0-9_-]/g, '_');
          const backupRoot = path.join(userDataDir, 'cloud_save_backups', 'epic', safeAppName);
          const backupRes = await createCloudSaveRollingBackupAsync(
            hostResolvedSavePath,
            backupRoot,
            Number(options.maxBackupBytes) > 0
              ? Number(options.maxBackupBytes)
              : resolveDefaultPerSnapshotMaxBackupBytes(options),
            {
              ...backupQuotaOpts,
              ...(placeholderCheck ? { precheckedPlaceholderState: placeholderCheck } : {}),
              ...(epicFileFilter ? { fileFilter: epicFileFilter } : {}),
            }
          );
          if (backupRes?.backupPath) {
            backupPath = backupRes.backupPath;
          }
        }
      }

      const recordedInstalledSavePath = String(installedJsonRecord?.save_path || '').trim();
      const installedSavePathPointsElsewhere = Boolean(
        recordedInstalledSavePath &&
          hasCompleteResolvedSavePath &&
          normalizeComparableFsPath(recordedInstalledSavePath) !==
            normalizeComparableFsPath(resolvedSavePath)
      );
      const shouldForceDownloadEmptyCrossBottle = Boolean(
        mode === 'pre_launch' &&
          useCompatLayer &&
          hasCompleteResolvedSavePath &&
          installedSavePathPointsElsewhere &&
          realFileCount === 0
      );

      const syncArgs = ['sync-saves', appName, '-y'];
      if (mode === 'pre_launch') {
        syncArgs.push('--skip-upload');
      } else if (mode === 'post_exit') {
        syncArgs.push('--skip-download');
      }
      if (shouldForceDownloadEmptyCrossBottle) {
        syncArgs.push('--force-download');
      }
      if (hasCompleteResolvedSavePath) {
        syncArgs.push('--save-path', resolvedSavePath);
      }

      const syncTimeoutMs = Number(options.cloudSyncTimeoutMs || 60000);
      const execRes = await execCliWithTreeTimeout(
        legendaryBin,
        syncArgs,
        {
          env: legEnv,
          timeout: syncTimeoutMs,
        },
        options
      );

      const combinedOutput = `${execRes.stdout}\n${execRes.stderr}`.trim();
      if (
        execRes.err ||
        /skipping due to --yes|Game\s+.*not\s+installed|not\s+installed|does not support cloud saves/i.test(
          combinedOutput
        )
      ) {
        const failReason = combinedOutput || execRes.err?.message || 'sync_saves_failed';
        diagLog.warn('cloudSave.epicSyncFailed', failReason, { appName, mode });
        return {
          synced: false,
          appName,
          mode,
          args: syncArgs,
          cloudSaveFolder: cloudSaveFolderTemplate || null,
          resolvedSavePath: hasCompleteResolvedSavePath ? resolvedSavePath : null,
          reason: failReason,
          ...(backupPath ? { backupPath } : {}),
          ...(backupSkippedReason ? { backupSkippedReason } : {}),
        };
      }

      if (mode === 'pre_launch' && execMockFn && hasCompleteResolvedSavePath) {
        let appSet = virtualMockPreLaunchByExecFn.get(execMockFn);
        if (!saveDirExistsBefore && !(await pathExistsAsync(hostResolvedSavePath))) {
          if (!appSet) {
            appSet = new Set();
            virtualMockPreLaunchByExecFn.set(execMockFn, appSet);
          }
          appSet.add(appName);
        } else if (appSet) {
          appSet.delete(appName);
        }
      }

      const epicBottleScope = !useCompatLayer
        ? 'host'
        : isSaveRootSameAsInstallDir ||
            /^\{InstallDir\}(?:[\\/]|$)/i.test(cloudSaveFolderTemplate)
          ? 'install'
          : computeWinePrefixBottleScope(winePrefix);
      const postInstalledRecord =
        (await readLegendaryInstalledEntryAsync()) || installedJsonRecord;
      const latestSaveTimestamp = postInstalledRecord?.save_timestamp ?? null;

      if (userDataDir) {
        const timestampsPath = path.join(userDataDir, 'one_launcher_cloud_sync_timestamps.json');
        const epicWatermarkKey = `${appName}:${epicBottleScope}`;
        try {
          await withCloudManifestFileLock(timestampsPath, async () => {
            /** @type {Record<string, any>} */
            let freshTimestamps = {};
            try {
              if (await pathExistsAsync(timestampsPath)) {
                freshTimestamps =
                  JSON.parse(await fs.promises.readFile(timestampsPath, 'utf8')) || {};
              }
            } catch {}
            if (!freshTimestamps.epic || typeof freshTimestamps.epic !== 'object') {
              freshTimestamps.epic = {};
            }
            freshTimestamps.epic[epicWatermarkKey] = {
              savePath: hasCompleteResolvedSavePath ? resolvedSavePath : null,
              lastSyncedAt: Date.now(),
              saveTimestamp: latestSaveTimestamp,
            };
            await atomicWriteFileAsync(timestampsPath, JSON.stringify(freshTimestamps, null, 2));
          });
        } catch (tsWriteErr) {
          diagLog.warn('cloudSave.epicWriteTimestamps', tsWriteErr, { timestampsPath, appName });
        }
      }

      return {
        synced: true,
        appName,
        mode,
        args: syncArgs,
        cloudSaveFolder: cloudSaveFolderTemplate || null,
        resolvedSavePath: hasCompleteResolvedSavePath ? resolvedSavePath : null,
        ...(backupPath ? { backupPath } : {}),
        ...(backupSkippedReason ? { backupSkippedReason } : {}),
      };
    }

    /**
     * Synchronize Epic Games cloud saves via Legendary, guarded against CLI flag injection
     * and serialized per game via `withPerGameCloudSyncLock`.
     *
     * @param {Record<string, any>} [payload]
     * @param {string} [mode='both']
     * @param {Record<string, any>} [options]
     */
    async function syncEpicCloudSaves(payload = {}, mode = 'both', options = {}) {
      try {
        let appName = '';
        try {
          const resolved = resolveEpicAppAndPlatforms(payload, options);
          if (resolved && resolved.appName) {
            appName = String(resolved.appName).trim();
          }
        } catch (resolveErr) {
          diagLog.debug('cloudSave.epicResolveApp', resolveErr);
        }
        if (!appName) {
          appName = String(payload.appName || payload.platformGameId || payload.gameId || '')
            .replace(/^epic[-_]/i, '')
            .trim();
        }
        if (!appName) {
          return { synced: false, appName: '', mode, reason: 'missing_app_name' };
        }
        if (!isSafeEpicAppName(appName)) {
          diagLog.warn(
            'cloudSave.epicUnsafeAppNameRejected',
            'Rejected Epic cloud save sync due to unsafe appName CLI flag or path characters',
            { appName }
          );
          return { synced: false, appName, mode, reason: 'unsafe_app_name_rejected' };
        }
        if (!isNetworkOnlineForLaunch(options)) {
          return { synced: false, appName, mode, offlineSkipped: true, reason: 'offline_skipped' };
        }

        const lockKey = buildPerGameCloudSyncLockKey('epic', appName);
        if (!lockKey || options._cloudSyncLockHeldKey === lockKey) {
          return await runSyncEpicCloudSaves(payload, mode, options, appName);
        }
        return await withPerGameCloudSyncLock(lockKey, () =>
          runSyncEpicCloudSaves(
            payload,
            mode,
            { ...options, _cloudSyncLockHeldKey: lockKey },
            appName
          )
        );
      } catch (err) {
        diagLog.warn('cloudSave.epicUnhandled', err, { mode });
        const anyErr = /** @type {any} */ (err);
        return {
          synced: false,
          appName: '',
          mode,
          reason: anyErr && anyErr.message ? anyErr.message : 'sync_failed',
        };
      }
    }

    /**
     * Wait for cold-booted Steam (`-silent`) to finish its global client cloud sync AND any queued
     * `[AppID <cleanAppId>]` startup download/eval jobs before dispatching `-applaunch` / `steam://rungameid`.
     *
     * @param {string} steamRoot
     * @param {string | number} appId
     * @param {Record<string, any>} [options]
     */
    async function waitForSteamColdStartupCloudReady(steamRoot, appId, options = {}) {
      if (isTestEnvironment(options) && options.enableTwoStageSteamColdStart !== true) {
        return { ready: true, waitedMs: 0, reason: 'skipped_in_test' };
      }
      if (!isNetworkOnlineForLaunch(options)) {
        return { ready: true, waitedMs: 0, offlineSkipped: true, reason: 'offline_skipped' };
      }
      if (options.signal?.aborted) {
        return { ready: false, aborted: true, waitedMs: 0, reason: 'aborted' };
      }

      const cleanAppId = String(appId || '')
        .replace(/^steam[-_]/i, '')
        .trim();
      const targetPlatform = options.platform || process.platform;
      const trimmedRoot = typeof steamRoot === 'string' ? steamRoot.trim() : '';

      const resolveLogPathAsync = async () => {
        const primary = trimmedRoot ? path.join(trimmedRoot, 'logs', 'cloud_log.txt') : '';
        if (primary && (await pathExistsAsync(primary))) {
          return primary;
        }
        if (targetPlatform === 'darwin' && !options.steamRootStrict) {
          const macSupportLog = path.join(
            options.homedir || os.homedir(),
            'Library',
            'Application Support',
            'Steam',
            'logs',
            'cloud_log.txt'
          );
          if (await pathExistsAsync(macSupportLog)) {
            return macSupportLog;
          }
          return primary || macSupportLog;
        }
        return primary;
      };

      const initialLogPath = await resolveLogPathAsync();
      let baseOffset = 0;
      if (typeof options.preBootLogOffset === 'number' && options.preBootLogOffset >= 0) {
        baseOffset = options.preBootLogOffset;
      } else if (initialLogPath) {
        try {
          baseOffset = (await fs.promises.stat(initialLogPath)).size;
        } catch {
          baseOffset = 0;
        }
      }

      const resolveConnectionLogPathAsync = async () => {
        const primary = trimmedRoot ? path.join(trimmedRoot, 'logs', 'connection_log.txt') : '';
        if (primary && (await pathExistsAsync(primary))) {
          return primary;
        }
        if (targetPlatform === 'darwin' && !options.steamRootStrict) {
          const macConnLog = path.join(
            options.homedir || os.homedir(),
            'Library',
            'Application Support',
            'Steam',
            'logs',
            'connection_log.txt'
          );
          if (await pathExistsAsync(macConnLog)) {
            return macConnLog;
          }
          return primary || macConnLog;
        }
        return primary;
      };

      const initialConnLogPath = await resolveConnectionLogPathAsync();
      let baseConnOffset = 0;
      if (
        typeof options.preBootConnectionLogOffset === 'number' &&
        options.preBootConnectionLogOffset >= 0
      ) {
        baseConnOffset = options.preBootConnectionLogOffset;
      } else if (initialConnLogPath) {
        try {
          baseConnOffset = (await fs.promises.stat(initialConnLogPath)).size;
        } catch {
          baseConnOffset = 0;
        }
      }

      const resolveBootstrapLogPathAsync = async () => {
        const primary = trimmedRoot ? path.join(trimmedRoot, 'logs', 'bootstrap_log.txt') : '';
        if (primary && (await pathExistsAsync(primary))) {
          return primary;
        }
        if (targetPlatform === 'darwin' && !options.steamRootStrict) {
          const macBootLog = path.join(
            options.homedir || os.homedir(),
            'Library',
            'Application Support',
            'Steam',
            'logs',
            'bootstrap_log.txt'
          );
          if (await pathExistsAsync(macBootLog)) {
            return macBootLog;
          }
          return primary || macBootLog;
        }
        return primary;
      };

      const initialBootstrapLogPath = await resolveBootstrapLogPathAsync();
      let baseBootstrapOffset = 0;
      if (
        typeof options.preBootBootstrapLogOffset === 'number' &&
        options.preBootBootstrapLogOffset >= 0
      ) {
        baseBootstrapOffset = options.preBootBootstrapLogOffset;
      } else if (initialBootstrapLogPath) {
        try {
          baseBootstrapOffset = (await fs.promises.stat(initialBootstrapLogPath)).size;
        } catch {
          baseBootstrapOffset = 0;
        }
      }

      const pollIntervalMs = Math.max(10, Number(options.pollIntervalMs || 250));
      const defaultStartupWaitMs = options.isBottleSteam ? 35000 : 25000;
      const maxStartupCloudWaitMs = Math.max(
        0,
        Number(options.maxStartupCloudWaitMs ?? defaultStartupWaitMs)
      );
      const enableSelfUpdateExtension =
        !isTestEnvironment(options) || options.enableSelfUpdateExtensionInTest === true;
      const maxSelfUpdateWaitMs = Math.max(
        maxStartupCloudWaitMs,
        Number(options.maxSelfUpdateWaitMs ?? (options.isBottleSteam ? 120000 : 90000))
      );
      const selfUpdateActiveWindowMs = Math.max(
        1000,
        Number(options.selfUpdateActiveWindowMs ?? 15000)
      );
      const selfUpdateRestartGraceMs = Math.max(
        1000,
        Number(options.selfUpdateRestartGraceMs ?? 8000)
      );
      const livenessGraceMs = Math.max(0, Number(options.livenessGraceMs ?? 5000));
      const selfUpdatePatternRegex =
        /Downloading\s+update|Extracting\s+package|Installing\s+update|Verifying\s+installation/i;
      const settleAfterClientSyncMs =
        options.settleAfterClientSyncMs !== undefined
          ? Math.max(0, Number(options.settleAfterClientSyncMs))
          : 900;

      const inspectBootstrapUpdateActivityAsync = async () => {
        const bootPath = await resolveBootstrapLogPathAsync();
        if (!bootPath || !(await pathExistsAsync(bootPath))) {
          return { active: false, recentRestart: false, size: 0, mtimeMs: 0 };
        }
        let fh = null;
        try {
          fh = await openFileBoundedNoRecallAsync(bootPath, 'r', 2500);
          const st = await fh.stat();
          const effectiveBootOffset = st.size < baseBootstrapOffset ? 0 : baseBootstrapOffset;
          const availableBytes = Math.max(0, st.size - effectiveBootOffset);
          const ageMs = Math.max(0, Date.now() - st.mtimeMs);
          if (availableBytes === 0) {
            return { active: false, recentRestart: false, size: st.size, mtimeMs: st.mtimeMs };
          }
          const readLen = Math.min(availableBytes, 65536);
          const startPos = st.size - readLen;
          const buf = Buffer.alloc(readLen);
          const { bytesRead } = await fh.read(buf, 0, readLen, startPos);
          const appendedText = buf.subarray(0, bytesRead).toString('utf8');
          const matchesUpdateLine = selfUpdatePatternRegex.test(appendedText);
          const recentWrite = ageMs <= selfUpdateActiveWindowMs;
          return {
            active: recentWrite || matchesUpdateLine,
            recentRestart: ageMs <= selfUpdateRestartGraceMs,
            size: st.size,
            mtimeMs: st.mtimeMs,
          };
        } catch {
          return { active: false, recentRestart: false, size: 0, mtimeMs: 0 };
        } finally {
          if (fh) {
            try {
              await fh.close();
            } catch {}
          }
        }
      };

      const readAppendedConnectionLogAsync = async () => {
        const connPath = await resolveConnectionLogPathAsync();
        if (!connPath || !(await pathExistsAsync(connPath))) {
          return null;
        }
        let fh = null;
        try {
          fh = await openFileBoundedNoRecallAsync(connPath, 'r', 2500);
          const st = await fh.stat();
          const effectiveOffset = st.size < baseConnOffset ? 0 : baseConnOffset;
          const availableBytes = Math.max(0, st.size - effectiveOffset);
          if (availableBytes === 0) {
            return { text: '', size: st.size };
          }
          const readLen = Math.min(availableBytes, 131072);
          const startPos = st.size - readLen;
          const buf = Buffer.alloc(readLen);
          const { bytesRead } = await fh.read(buf, 0, readLen, startPos);
          return {
            text: buf.subarray(0, bytesRead).toString('utf8'),
            size: st.size,
          };
        } catch {
          return null;
        } finally {
          if (fh) {
            try {
              await fh.close();
            } catch {}
          }
        }
      };
      const connectionLogOnRegex = /RecvMsgClientLogOnResponse\(\)\s*:\s*processing complete/i;

      const readAppendedLogAsync = async () => {
        const logPath = await resolveLogPathAsync();
        if (!logPath || !(await pathExistsAsync(logPath))) {
          return null;
        }
        let fh = null;
        try {
          fh = await openFileBoundedNoRecallAsync(logPath, 'r', 2500);
          const st = await fh.stat();
          const effectiveOffset = st.size < baseOffset ? 0 : baseOffset;
          const availableBytes = Math.max(0, st.size - effectiveOffset);
          if (availableBytes === 0) {
            return { text: '', size: st.size };
          }
          const maxRead = 262144;
          const readLen = Math.min(availableBytes, maxRead);
          const startPos = st.size - readLen;
          const buf = Buffer.alloc(readLen);
          const { bytesRead } = await fh.read(buf, 0, readLen, startPos);
          return {
            text: buf.subarray(0, bytesRead).toString('utf8'),
            size: st.size,
          };
        } catch (err) {
          diagLog.debug('cloudSave.steamColdStartReadLog', err, { logPath });
          return null;
        } finally {
          if (fh) {
            try {
              await fh.close();
            } catch {}
          }
        }
      };

      const clientSyncRegex =
        /OnRemoteStorageSyncedClient\(\)\s*-\s*result\s+OK|PerformSyncCloud\s*-\s*all\s+sync'd\s+up/i;
      const escapedAppId = cleanAppId ? cleanAppId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
      const appIdLineRegex = escapedAppId
        ? new RegExp(
            `(?:\\bAppID\\s*[:=]?\\s*${escapedAppId}\\b|\\[AppID\\s+${escapedAppId}\\])`,
            'i'
          )
        : null;

      const downloadQueuedRegex =
        /(?:Need\s+to\s+download\s+file|Need\s+to\s+sync\s+from\s+local\s+change\s+number(?!.*but\s+not\s+attempting\s+now)|Starting\s+sync\s*\([^)]*down,|HTTP\s+download\s+.*\s+beginning)/i;
      const downloadCompleteRegex = /Download\s+complete/i;
      const inFlightStartRegex =
        /(?:Starting\s+sync|Need\s+to\s+upload\s+file|HTTP\s+upload\s+.*\s+beginning)/i;
      const anySyncCompleteRegex =
        /(?:Eval\s+complete|Download\s+complete|Upload\s+complete|AutoCloud\s+done|Nothing\s+to\s+sync)/i;
      const globalDownSyncStartRegex = /Starting\s+sync\s*\([^)]*down,/i;

      /** @param {string} text */
      const evaluateStartupReadiness = (text) => {
        if (!text || !clientSyncRegex.test(text)) {
          return { ready: false };
        }

        const lines = text.split(/\r?\n/);
        let lastGlobalDownSyncIdx = -1;
        let lastGlobalOrAppSyncDoneIdx = -1;
        let lastAppDownloadQueuedIdx = -1;
        let lastAppDownloadCompleteIdx = -1;
        let lastAppInFlightStartIdx = -1;
        let lastAppCompletionIdx = -1;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;

          if (globalDownSyncStartRegex.test(line)) {
            lastGlobalDownSyncIdx = i;
          }
          if (
            clientSyncRegex.test(line) ||
            downloadCompleteRegex.test(line) ||
            anySyncCompleteRegex.test(line)
          ) {
            lastGlobalOrAppSyncDoneIdx = i;
          }

          if (appIdLineRegex && appIdLineRegex.test(line)) {
            if (downloadQueuedRegex.test(line)) {
              lastAppDownloadQueuedIdx = i;
            }
            if (downloadCompleteRegex.test(line)) {
              lastAppDownloadCompleteIdx = i;
            }
            if (inFlightStartRegex.test(line)) {
              lastAppInFlightStartIdx = i;
            }
            if (anySyncCompleteRegex.test(line)) {
              lastAppCompletionIdx = i;
            }
          }
        }

        if (
          lastAppDownloadQueuedIdx !== -1 &&
          lastAppDownloadCompleteIdx <= lastAppDownloadQueuedIdx
        ) {
          return { ready: false };
        }

        if (lastAppInFlightStartIdx !== -1 && lastAppCompletionIdx <= lastAppInFlightStartIdx) {
          return { ready: false };
        }

        if (lastGlobalDownSyncIdx !== -1 && lastGlobalOrAppSyncDoneIdx < lastGlobalDownSyncIdx) {
          return { ready: false };
        }

        return { ready: true };
      };

      const startedWait = Date.now();
      let effectiveMaxWaitMs = maxStartupCloudWaitMs;
      let notifiedSelfUpdate = false;
      let readySinceMs = 0;
      let readyAtSize = -1;
      let loginConfirmedAtMs = 0;
      const defaultLoginOnlySettleMs = isTestEnvironment(options) ? 1500 : 3500;
      const loginOnlySettleMs = Math.max(
        settleAfterClientSyncMs,
        options.loginOnlySettleMs !== undefined
          ? Math.max(0, Number(options.loginOnlySettleMs))
          : defaultLoginOnlySettleMs
      );
      const isSteamAliveFn =
        typeof options.isSteamAliveFn === 'function' ? options.isSteamAliveFn : null;

      const checkSelfUpdateExtensionAsync = async () => {
        if (!enableSelfUpdateExtension) return false;
        const bootActivity = await inspectBootstrapUpdateActivityAsync();
        if (bootActivity.active) {
          const extended = Math.min(
            maxSelfUpdateWaitMs,
            Math.max(
              effectiveMaxWaitMs,
              Date.now() - startedWait + Math.max(maxStartupCloudWaitMs, selfUpdateActiveWindowMs)
            )
          );
          if (extended > effectiveMaxWaitMs) {
            effectiveMaxWaitMs = extended;
          }
          if (!notifiedSelfUpdate && typeof options.onStatusUpdate === 'function') {
            notifiedSelfUpdate = true;
            try {
              options.onStatusUpdate('Updating Steam client...');
            } catch {}
          }
          return true;
        }
        return false;
      };

      const checkEarlySteamExitAsync = async () => {
        if (!isSteamAliveFn) return false;
        if (Date.now() - startedWait < livenessGraceMs) return false;
        let alive = true;
        try {
          alive = Boolean(await Promise.resolve(isSteamAliveFn()));
        } catch {
          alive = true;
        }
        if (alive) return false;
        const bootActivity = await inspectBootstrapUpdateActivityAsync();
        if (bootActivity.recentRestart) {
          return false;
        }
        return true;
      };

      const checkConnectionLogLoginAsync = async () => {
        if (loginConfirmedAtMs > 0) return true;
        const connSnap = await readAppendedConnectionLogAsync();
        if (connSnap && connSnap.text && connectionLogOnRegex.test(connSnap.text)) {
          loginConfirmedAtMs = Date.now();
          return true;
        }
        return false;
      };

      // Check immediately before sleeping in case already synced
      await checkConnectionLogLoginAsync();
      const firstSnap = await readAppendedLogAsync();
      if (firstSnap && evaluateStartupReadiness(firstSnap.text).ready) {
        readySinceMs = Date.now();
        readyAtSize = firstSnap.size;
        if (settleAfterClientSyncMs <= 0) {
          return {
            ready: true,
            waitedMs: Date.now() - startedWait,
            ...(loginConfirmedAtMs > 0 ? { loginConfirmed: true } : {}),
            reason: 'startup_cloud_synced',
          };
        }
      } else if (!firstSnap || !firstSnap.text || !clientSyncRegex.test(firstSnap.text)) {
        await checkSelfUpdateExtensionAsync();
      }

      while (Date.now() - startedWait < effectiveMaxWaitMs) {
        if (options.signal?.aborted) {
          return {
            ready: false,
            aborted: true,
            waitedMs: Date.now() - startedWait,
            reason: 'aborted',
          };
        }
        const remainingBudget = effectiveMaxWaitMs - (Date.now() - startedWait);
        if (remainingBudget <= 0) break;

        let waitSlice = pollIntervalMs;
        if (readySinceMs > 0 && settleAfterClientSyncMs > 0) {
          const remainingSettle = settleAfterClientSyncMs - (Date.now() - readySinceMs);
          waitSlice = Math.max(
            10,
            Math.min(pollIntervalMs, remainingSettle > 0 ? remainingSettle : 10)
          );
        }
        await sleepUnrefWithAbortAsync(Math.min(waitSlice, remainingBudget), options.signal);

        await checkConnectionLogLoginAsync();
        const snap = await readAppendedLogAsync();
        const now = Date.now();
        if (!snap || !snap.text || !clientSyncRegex.test(snap.text)) {
          await checkSelfUpdateExtensionAsync();
        }
        if (!snap || !snap.text) {
          readySinceMs = 0;
          readyAtSize = -1;
          if (loginConfirmedAtMs > 0 && now - loginConfirmedAtMs >= loginOnlySettleMs) {
            return {
              ready: true,
              waitedMs: now - startedWait,
              loginConfirmed: true,
              reason: 'connection_logged_on_settled',
            };
          }
          if (await checkEarlySteamExitAsync()) {
            return {
              ready: false,
              waitedMs: Date.now() - startedWait,
              reason: 'steam_exited_early',
            };
          }
          continue;
        }

        const evalRes = evaluateStartupReadiness(snap.text);
        if (!evalRes.ready) {
          readySinceMs = 0;
          readyAtSize = -1;
          if (await checkEarlySteamExitAsync()) {
            return {
              ready: false,
              waitedMs: Date.now() - startedWait,
              reason: 'steam_exited_early',
            };
          }
          continue;
        }

        if (readySinceMs === 0) {
          readySinceMs = now;
          readyAtSize = snap.size;
        } else if (snap.size !== readyAtSize) {
          // New activity occurred during settle window; ensure a fresh quiet settle window
          readySinceMs = now;
          readyAtSize = snap.size;
        }

        if (now - readySinceMs >= settleAfterClientSyncMs) {
          const confirmSnap = await readAppendedLogAsync();
          if (
            confirmSnap &&
            evaluateStartupReadiness(confirmSnap.text).ready &&
            confirmSnap.size === readyAtSize
          ) {
            return {
              ready: true,
              waitedMs: Date.now() - startedWait,
              ...(loginConfirmedAtMs > 0 ? { loginConfirmed: true } : {}),
              reason: 'startup_cloud_synced',
            };
          }
          readySinceMs =
            confirmSnap && evaluateStartupReadiness(confirmSnap.text).ready ? Date.now() : 0;
          readyAtSize = confirmSnap ? confirmSnap.size : -1;
        }
      }

      diagLog.warn(
        'cloudSave.steamColdStartupTimeout',
        'Steam cold-startup cloud sync wait timed out',
        {
          appId: cleanAppId,
          maxStartupCloudWaitMs,
          effectiveMaxWaitMs,
        }
      );
      return {
        ready: false,
        timedOut: true,
        waitedMs: Date.now() - startedWait,
        reason: 'timeout',
      };
    }

    /**
     * Poll `<steamRoot>/logs/cloud_log.txt` (with macOS `~/Library/Application Support/Steam/logs/cloud_log.txt`
     * fallback even when `steamRoot` is empty) asynchronously via `fs.promises.open` until active AutoCloud
     * upload jobs complete or settle.
     *
     * @param {string} steamRoot
     * @param {string | number} appId
     * @param {Record<string, any>} [options]
     */
    async function waitForSteamCloudSyncCompletion(steamRoot, appId, options = {}) {
      const cleanAppId = String(appId || '')
        .replace(/^steam[-_]/i, '')
        .trim();
      if (!cleanAppId) {
        return { completed: true, waitedMs: 0, reason: 'no_active_cloud_job' };
      }

      const targetPlatform = options.platform || process.platform;
      const trimmedRoot = typeof steamRoot === 'string' ? steamRoot.trim() : '';
      let cloudLogPath = trimmedRoot ? path.join(trimmedRoot, 'logs', 'cloud_log.txt') : '';

      if (
        (!cloudLogPath || !(await pathExistsAsync(cloudLogPath))) &&
        targetPlatform === 'darwin' &&
        !options.steamRootStrict
      ) {
        const macSupportLog = path.join(
          options.homedir || os.homedir(),
          'Library',
          'Application Support',
          'Steam',
          'logs',
          'cloud_log.txt'
        );
        if (await pathExistsAsync(macSupportLog)) {
          cloudLogPath = macSupportLog;
        }
      }

      if (!cloudLogPath || !(await pathExistsAsync(cloudLogPath))) {
        return { completed: true, waitedMs: 0, reason: 'no_active_cloud_job' };
      }

      const hasSessionStartOffset =
        typeof options.sessionStartOffset === 'number' &&
        Number.isFinite(options.sessionStartOffset) &&
        options.sessionStartOffset >= 0;
      const sessionStartOffset = hasSessionStartOffset
        ? Math.floor(options.sessionStartOffset)
        : -1;

      const readLogTailAsync = async () => {
        let fh = null;
        try {
          fh = await openFileBoundedNoRecallAsync(cloudLogPath, 'r', 2500);
          const st = await fh.stat();
          const maxRead = 65536;
          const startPos = hasSessionStartOffset
            ? st.size < sessionStartOffset
              ? 0
              : Math.max(sessionStartOffset, st.size - maxRead)
            : Math.max(0, st.size - maxRead);
          const readLen = Math.max(0, st.size - startPos);
          if (readLen === 0) {
            return {
              text: '',
              size: st.size,
              mtimeMs: st.mtimeMs,
            };
          }
          const buf = Buffer.alloc(readLen);
          const { bytesRead } = await fh.read(buf, 0, readLen, startPos);
          return {
            text: buf.subarray(0, bytesRead).toString('utf8'),
            size: st.size,
            mtimeMs: st.mtimeMs,
          };
        } catch (err) {
          diagLog.debug('cloudSave.steamReadLogTail', err, { cloudLogPath });
          return null;
        } finally {
          if (fh) {
            try {
              await fh.close();
            } catch {
              // Ignore close error
            }
          }
        }
      };

      const escapedAppId = cleanAppId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const appIdLineRegex = new RegExp(
        `(?:\\bAppID\\s*[:=]?\\s*${escapedAppId}\\b|\\[AppID\\s+${escapedAppId}\\])`,
        'i'
      );

      const exitUploadStartRegex =
        /(?:Starting\s+sync\s*\([^)]*(?:up,|AC\s+Exit)|Running\s+AutoCloud\s+on\s+exit|Need\s+to\s+upload\s+file|Upload\s+batch\s+initiated|HTTP\s+upload\s+.*\s+beginning|\bUploading\b)/i;
      const exitUploadCompletionRegex =
        /(?:Upload\s+complete|Sync\s+complete|Cloud\s+sync\s+complete|Syncing\s+to\s+Steam\s+Cloud\s+succeeded|AppCloudStateChange[^\n]*synced|Nothing\s+to\s+sync|0\s+files\s+to\s+upload|Job\s+complete|Job\s+Canceled|ReleaseAppLock)/i;
      const downloadStartRegex =
        /(?:Need\s+to\s+download\s+file|Need\s+to\s+sync\s+from\s+local\s+change\s+number(?!.*but\s+not\s+attempting\s+now)|Starting\s+sync\s*\([^)]*down,|HTTP\s+download\s+.*\s+beginning|\bDownloading\b)/i;
      const downloadCompletionRegex = /Download\s+complete/i;
      const launchEvalStartRegex =
        /(?:Starting\s+sync\s*\((?:init,)?(?:AC\s+Launch,|eval,|down,|Get\s+App\s+Quota)|Running\s+AutoCloud\s+on\s+launch|Starting\s+sync|\bSyncing\b|Writing|Evaluating|Locking|in\s+progress|pending|queued)/i;
      const launchEvalCompletionRegex =
        /(?:AutoCloud\s+done|Eval\s+complete|Download\s+complete|GetAppQuotaUsage\s*-\s*Success)/i;
      const localAutoCloudScanOnlyRegex = /\bAutoCloud\s+complete\b/i;

      /** @param {{ text: string, size: number, mtimeMs: number } | null} logSnapshot */
      const inspectCloudState = (logSnapshot) => {
        if (!logSnapshot || !logSnapshot.text) {
          return { active: false, completed: false, exitUploadCompleted: false };
        }
        const lines = logSnapshot.text.split(/\r?\n/);
        let exitOrUploadActive = false;
        let launchOrEvalActive = false;
        let downloadPending = false;
        let sawCompletion = false;
        let sawExitUploadStart = false;
        let sawExitUploadCompleted = false;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!appIdLineRegex.test(line)) continue;

          // `AutoCloud complete` only marks local file hashing completion, NEVER network upload completion
          if (localAutoCloudScanOnlyRegex.test(line)) {
            continue;
          }

          if (exitUploadCompletionRegex.test(line)) {
            if (sawExitUploadStart) {
              sawExitUploadCompleted = true;
            }
            exitOrUploadActive = false;
            launchOrEvalActive = false;
            downloadPending = false;
            sawCompletion = true;
          } else if (exitUploadStartRegex.test(line)) {
            exitOrUploadActive = true;
            sawExitUploadStart = true;
            sawExitUploadCompleted = false;
          } else if (downloadCompletionRegex.test(line)) {
            downloadPending = false;
            launchOrEvalActive = false;
            sawCompletion = true;
          } else if (downloadStartRegex.test(line)) {
            downloadPending = true;
            launchOrEvalActive = true;
          } else if (launchEvalCompletionRegex.test(line)) {
            if (!downloadPending) {
              launchOrEvalActive = false;
              sawCompletion = true;
            }
          } else if (launchEvalStartRegex.test(line)) {
            launchOrEvalActive = true;
          }
        }

        const isActive = exitOrUploadActive || launchOrEvalActive || downloadPending;
        return {
          active: isActive,
          completed: !isActive && sawCompletion,
          exitUploadCompleted: !isActive && sawExitUploadCompleted,
        };
      };

      const initialSnap = await readLogTailAsync();
      if (!initialSnap) {
        return { completed: true, waitedMs: 0, reason: 'no_active_cloud_job' };
      }

      const recentThresholdMs = Number(options.recentThresholdMs ?? 120000);
      if (
        options.mode !== 'post_exit' &&
        options.ignoreStaleLogAge !== true &&
        recentThresholdMs > 0 &&
        Date.now() - initialSnap.mtimeMs > recentThresholdMs
      ) {
        return { completed: true, waitedMs: 0, reason: 'no_active_cloud_job' };
      }

      const pollIntervalMs = Math.max(
        10,
        Number(options.pollIntervalMs || options.cloudSyncPollIntervalMs || 500)
      );
      const maxCloudWaitMs = Math.max(
        0,
        Number(options.maxCloudWaitMs ?? options.cloudSyncMaxWaitMs ?? 45000)
      );
      const settleMs =
        options.settleMs !== undefined ? Math.max(0, Number(options.settleMs)) : 15000;
      const abortSignal = options.signal || null;

      /** @param {number} delayMs */
      const waitTickWithAbort = (delayMs) =>
        sleepUnrefWithAbortAsync(delayMs, options.abortOnSignal === true ? abortSignal : null);

      const startedWait = Date.now();
      let baselineSnap = initialSnap;
      const initialState = inspectCloudState(initialSnap);

      if (
        options.mode === 'post_exit' &&
        hasSessionStartOffset &&
        !initialState.active &&
        initialState.exitUploadCompleted
      ) {
        return { completed: true, waitedMs: 0, reason: 'cloud_sync_completed' };
      }

      if (!initialState.active) {
        const postExitGraceMs =
          options.mode === 'post_exit'
            ? options.postExitGraceMs !== undefined && options.postExitGraceMs !== null
              ? Math.max(0, Number(options.postExitGraceMs))
              : isTestEnvironment(options)
                ? 0
                : options.isFastDirectBypass && !options.wokeSteamByLauncher
                  ? 0
                  : options.isBottleSteam
                    ? 6000
                    : 4500
            : 0;

        if (postExitGraceMs <= 0) {
          return { completed: true, waitedMs: 0, reason: 'no_active_cloud_job' };
        }

        const gracePollMs = Math.min(pollIntervalMs, 250);
        const initialByteSize = initialSnap.size;
        let observedActiveInGrace = false;

        while (Date.now() - startedWait < postExitGraceMs) {
          if (abortSignal && abortSignal.aborted && options.abortOnSignal === true) {
            return {
              completed: false,
              aborted: true,
              waitedMs: Date.now() - startedWait,
              reason: 'aborted',
            };
          }

          const remainingGrace = postExitGraceMs - (Date.now() - startedWait);
          await waitTickWithAbort(Math.max(10, Math.min(gracePollMs, remainingGrace)));

          if (abortSignal && abortSignal.aborted && options.abortOnSignal === true) {
            return {
              completed: false,
              aborted: true,
              waitedMs: Date.now() - startedWait,
              reason: 'aborted',
            };
          }

          const graceSnap = await readLogTailAsync();
          if (!graceSnap) {
            return {
              completed: true,
              waitedMs: Date.now() - startedWait,
              reason: 'cloud_log_removed',
            };
          }

          if (graceSnap.size !== initialByteSize) {
            const graceState = inspectCloudState(graceSnap);
            if (graceState.active) {
              baselineSnap = graceSnap;
              observedActiveInGrace = true;
              break;
            }
            // Check if Steam both started AND finished the AppID exit sync inside a single poll interval
            const newlyAppendedLen = Math.max(0, graceSnap.size - initialByteSize);
            const newlyAppendedSlice =
              newlyAppendedLen > 0 ? graceSnap.text.slice(-newlyAppendedLen) : graceSnap.text;
            const appendedLines = newlyAppendedSlice.split(/\r?\n/);
            const completedDuringGrace =
              graceState.exitUploadCompleted ||
              appendedLines.some(
                (ln) => appIdLineRegex.test(ln) && exitUploadCompletionRegex.test(ln)
              );
            if (completedDuringGrace) {
              return {
                completed: true,
                waitedMs: Date.now() - startedWait,
                reason: 'cloud_sync_completed',
              };
            }
          }
        }

        if (!observedActiveInGrace) {
          return {
            completed: true,
            waitedMs: Date.now() - startedWait,
            reason: 'no_active_cloud_job',
          };
        }
      }

      let lastObservedSize = baselineSnap.size;
      let lastObservedMtime = baselineSnap.mtimeMs;
      let lastChangeWallMs = Date.now();

      while (Date.now() - startedWait < maxCloudWaitMs) {
        if (abortSignal && abortSignal.aborted && options.abortOnSignal === true) {
          return {
            completed: false,
            aborted: true,
            waitedMs: Date.now() - startedWait,
            reason: 'aborted',
          };
        }

        await waitTickWithAbort(pollIntervalMs);

        if (abortSignal && abortSignal.aborted && options.abortOnSignal === true) {
          return {
            completed: false,
            aborted: true,
            waitedMs: Date.now() - startedWait,
            reason: 'aborted',
          };
        }

        const snap = await readLogTailAsync();
        const now = Date.now();
        if (!snap) {
          return {
            completed: true,
            waitedMs: now - startedWait,
            reason: 'cloud_log_removed',
          };
        }

        if (snap.size !== lastObservedSize || snap.mtimeMs !== lastObservedMtime) {
          lastObservedSize = snap.size;
          lastObservedMtime = snap.mtimeMs;
          lastChangeWallMs = now;
        }

        const state = inspectCloudState(snap);
        if (!state.active) {
          return {
            completed: true,
            waitedMs: now - startedWait,
            reason: 'cloud_sync_completed',
          };
        }

        if (settleMs > 0 && now - lastChangeWallMs >= settleMs) {
          return {
            completed: true,
            waitedMs: now - startedWait,
            reason: 'cloud_log_settled',
          };
        }
      }

      diagLog.warn('cloudSave.steamSyncTimeout', 'Steam Cloud upload wait timed out', {
        appId: cleanAppId,
        cloudLogPath,
        maxCloudWaitMs,
      });
      return {
        completed: false,
        timedOut: true,
        waitedMs: Date.now() - startedWait,
        reason: 'timeout',
      };
    }

    /**
     * @param {string | Record<string, any>} gameIdOrPayload
     * @param {Record<string, any>} [opts]
     */
    function cleanupRunnerGameBackups(gameIdOrPayload, opts = {}) {
      const { homedir, userDataDir } = resolveIsolatedHomedirAndUserData(opts);
      return cleanupGameBackups(gameIdOrPayload, {
        homedir,
        userDataDir,
        ...opts,
      });
    }

    /**
     * @param {Record<string, any>} [opts]
     */
    function enforceRunnerBackupQuota(opts = {}) {
      const { homedir, userDataDir } = resolveIsolatedHomedirAndUserData(opts);
      return enforceCloudSaveBackupQuotaAsync(opts.backupsRootDir || userDataDir, {
        homedir,
        userDataDir,
        ...opts,
      });
    }

    /**
     * Async runner helper pruning per-game cloud sync timestamps under resolved `userDataDir`.
     *
     * @param {Record<string, any>} [payload]
     * @param {Record<string, any> | string} [optsOrUserDataDir]
     */
    function pruneRunnerCloudSaveStateAsync(payload = {}, optsOrUserDataDir) {
      if (typeof optsOrUserDataDir === 'string' && optsOrUserDataDir.trim()) {
        return pruneCloudSaveStateForGameAsync(payload, optsOrUserDataDir.trim());
      }
      const opts =
        optsOrUserDataDir && typeof optsOrUserDataDir === 'object' ? optsOrUserDataDir : {};
      const { userDataDir } = resolveIsolatedHomedirAndUserData(opts);
      return pruneCloudSaveStateForGameAsync(payload, userDataDir);
    }

    return {
      syncGogCloudSaves,
      syncEpicCloudSaves,
      syncXboxCloudSaves,
      waitForXboxCloudSaveFlush,
      waitForSteamColdStartupCloudReady,
      waitForSteamCloudSyncCompletion,
      cleanupGameBackups: cleanupRunnerGameBackups,
      enforceCloudSaveBackupQuota: enforceRunnerBackupQuota,
      pruneCloudSaveStateForGameAsync: pruneRunnerCloudSaveStateAsync,
    };
  }

  return createCloudSaveRunner;
}

module.exports = {
  createCloudSaveRunnerFactory,
  computeWinePrefixBottleScope,
  parseEpicCloudPatternList,
  createEpicCloudFileFilter,
};
