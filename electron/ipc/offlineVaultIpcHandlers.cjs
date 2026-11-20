// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { sanitizeRendererIpcOptions } = require('./launcherIpcHandlers.cjs');
const {
  assertSafePublicHttpsUrl,
  assertSafePublicHttpsUrlSyntax,
  atomicWriteFileSync,
  resolveEffectiveUserDataDir,
  toHostFilesystemPath,
  wrapIpcMainWithSenderCheck,
} = require('../launcher/securityAndPathUtils.cjs');

/**
 * Case-insensitively extract a header value from a Fetch `Request` or mock request object.
 * @param {any} request
 * @param {string} headerName
 * @returns {string}
 */
function getRequestHeaderValue(request, headerName) {
  const hdrs = request?.headers;
  if (!hdrs) return '';
  if (typeof hdrs.get === 'function') {
    const val = hdrs.get(headerName);
    return typeof val === 'string' ? val.trim() : '';
  }
  if (typeof hdrs === 'object') {
    const target = headerName.toLowerCase();
    for (const [k, v] of Object.entries(hdrs)) {
      if (k.toLowerCase() === target && typeof v === 'string') {
        return v.trim();
      }
    }
  }
  return '';
}

/**
 * Determine whether an `ol-media://` request originates from a cross-site embedded frame.
 * @param {any} request
 * @returns {boolean}
 */
function isUntrustedCrossSiteMediaRequest(request) {
  const secFetchSite = getRequestHeaderValue(request, 'sec-fetch-site').toLowerCase();
  if (secFetchSite === 'cross-site') {
    return true;
  }
  const originHeader = getRequestHeaderValue(request, 'origin');
  if (originHeader && /^https?:\/\//i.test(originHeader)) {
    try {
      const parsedOrigin = new URL(originHeader);
      const host = String(parsedOrigin.hostname || '')
        .replace(/^\[|\]$/g, '')
        .toLowerCase();
      if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

const OL_MEDIA_BASE_SECURITY_HEADERS = Object.freeze({
  'Cross-Origin-Resource-Policy': 'same-origin',
});

/**
 * Creates the `ol-media://` custom streaming protocol handler backed by `OfflineVaultService`.
 * Enforces `assertSafePublicHttpsUrl` SSRF/DNS-rebinding protection on remote fallback URLs,
 * sets `Cross-Origin-Resource-Policy: same-origin`, and rejects cross-site subframe requests.
 *
 * @param {{ offlineVaultService?: any, getOfflineVault?: () => any, dnsLookup?: any }} deps
 */
function createOlMediaProtocolHandler({ offlineVaultService, getOfflineVault, dnsLookup }) {
  return async function handleOlMediaRequest(/** @type {any} */ request) {
    try {
      const activeVault =
        typeof getOfflineVault === 'function' ? getOfflineVault() : offlineVaultService;
      const rawReqUrl = String(request?.url || '');
      if (!rawReqUrl.startsWith('ol-media://')) {
        return new Response(null, {
          status: 400,
          headers: {
            ...OL_MEDIA_BASE_SECURITY_HEADERS,
            'Cache-Control': 'no-store',
          },
        });
      }

      if (isUntrustedCrossSiteMediaRequest(request)) {
        return new Response(null, {
          status: 403,
          headers: {
            ...OL_MEDIA_BASE_SECURITY_HEADERS,
            'Cache-Control': 'no-store',
          },
        });
      }

      const parsed = new URL(rawReqUrl);
      const sp = parsed.searchParams;
      const params = {
        gameId: sp.get('gameId') || '',
        role: sp.get('role') || 'cover',
        ordinal: Number(sp.get('ord') || sp.get('ordinal') || 0),
        url: sp.get('url') || '',
        ov: sp.get('ov') || '',
        steamAppId: sp.get('steamAppId') || '',
        gogId: sp.get('gogId') || '',
        epicAppName: sp.get('epicApp') || sp.get('epicAppName') || '',
        xboxProductId: sp.get('xboxProductId') || sp.get('xid') || '',
        packageFamilyName: sp.get('pfn') || sp.get('packageFamilyName') || '',
        pfn: sp.get('pfn') || sp.get('packageFamilyName') || '',
        xboxTitleId: sp.get('xboxTitleId') || sp.get('xtid') || '',
      };

      // Step 1: Synchronous zero-DNS lexical validation (< 0.01ms).
      // Immediately rejects malformed, non-HTTPS, credentialed, local, and private-IP URLs with 403.
      if (params.url) {
        try {
          assertSafePublicHttpsUrlSyntax(params.url);
        } catch {
          return new Response(null, {
            status: 403,
            headers: {
              ...OL_MEDIA_BASE_SECURITY_HEADERS,
              'Cache-Control': 'no-store',
            },
          });
        }
      }

      let localCacheOnly = false;
      /** @type {any} */
      let resolved = null;

      // Step 2: Zero-DNS local disk cache fast path (exact previously-validated URL identity,
      // `url_resolution_cache` live blob hit, or explicit offline fallback). Bypassed whenever
      // a custom `dnsLookup` is injected (preserving deterministic SSRF/DNS-rebinding tests).
      if (
        typeof dnsLookup !== 'function' &&
        activeVault &&
        typeof activeVault.resolveLocalCachedMedia === 'function'
      ) {
        try {
          resolved = await activeVault.resolveLocalCachedMedia({
            ...params,
            localCacheOnly,
          });
        } catch {
          resolved = null;
        }
      }

      // Step 3: Cache miss, online URL upgrade, or injected custom `dnsLookup`:
      // enforce full DNS SSRF/rebinding check before resolving through Tier 2/3.
      if (!resolved) {
        if (params.url) {
          try {
            await assertSafePublicHttpsUrl(
              params.url,
              typeof dnsLookup === 'function' ? { dnsLookup } : undefined
            );
          } catch (urlErr) {
            const anyErr = /** @type {any} */ (urlErr);
            if (!anyErr?.isDnsUnavailable) {
              return new Response(null, {
                status: 403,
                headers: {
                  ...OL_MEDIA_BASE_SECURITY_HEADERS,
                  'Cache-Control': 'no-store',
                },
              });
            }
            // OS DNS is offline or domain is unresolvable (and already verified as `https:` with a
            // public multi-label hostname and zero private IP literals): serve strictly from local
            // SQLite/disk/federator cache unless an explicit test `fetchImpl` was injected.
            localCacheOnly = !activeVault?.hasCustomFetchImpl;
          }
        }

        if (!activeVault || typeof activeVault.resolveMediaRequest !== 'function') {
          return new Response(null, {
            status: 503,
            headers: {
              ...OL_MEDIA_BASE_SECURITY_HEADERS,
              'Cache-Control': 'no-store',
            },
          });
        }

        resolved = await activeVault.resolveMediaRequest(params, {
          signal: request?.signal,
          ...(localCacheOnly ? { localCacheOnly: true } : {}),
        });
      }

      if (!resolved || resolved.kind === 'error') {
        const status =
          typeof resolved?.status === 'number' && resolved.status >= 400 && resolved.status <= 599
            ? resolved.status
            : 404;
        return new Response(null, {
          status,
          headers: {
            ...OL_MEDIA_BASE_SECURITY_HEADERS,
            'Cache-Control': 'no-store',
          },
        });
      }

      if (resolved.kind === 'buffer' && Buffer.isBuffer(resolved.buffer)) {
        return new Response(/** @type {any} */ (resolved.buffer), {
          status: 200,
          headers: {
            ...OL_MEDIA_BASE_SECURITY_HEADERS,
            'Content-Type': resolved.mimeType || 'image/jpeg',
            'Content-Length': String(resolved.buffer.length),
            'Cache-Control': resolved.cacheControl || 'public, max-age=31536000, immutable',
          },
        });
      }

      if (resolved.kind === 'file' && typeof resolved.filePath === 'string') {
        const rangeHeader = getRequestHeaderValue(request, 'range');
        let totalSize =
          typeof resolved.sizeBytes === 'number' && resolved.sizeBytes > 0
            ? resolved.sizeBytes
            : 0;

        if (!totalSize) {
          try {
            const st = await fs.promises.stat(resolved.filePath);
            totalSize = st.size;
          } catch {
            totalSize = 0;
          }
        }

        let statusCode = 200;
        let streamOpts = {};
        /** @type {Record<string, string>} */
        const headers = {
          ...OL_MEDIA_BASE_SECURITY_HEADERS,
          'Content-Type': resolved.mimeType || 'image/jpeg',
          'Cache-Control': resolved.cacheControl || 'public, max-age=31536000, immutable',
          'Accept-Ranges': 'bytes',
        };

        if (rangeHeader && /^bytes=\d*-\d*$/i.test(rangeHeader) && totalSize > 0) {
          const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/i);
          if (match) {
            const rawStart = match[1];
            const rawEnd = match[2];
            let start = rawStart !== '' ? parseInt(rawStart, 10) : 0;
            let end = rawEnd !== '' ? parseInt(rawEnd, 10) : totalSize - 1;

            if (rawStart === '' && rawEnd !== '') {
              const suffixLen = parseInt(rawEnd, 10);
              start = Math.max(0, totalSize - suffixLen);
              end = totalSize - 1;
            }

            if (start <= end && start < totalSize) {
              end = Math.min(end, totalSize - 1);
              statusCode = 206;
              streamOpts = { start, end };
              headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
              headers['Content-Length'] = String(end - start + 1);
            } else {
              return new Response(null, {
                status: 416,
                headers: {
                  ...OL_MEDIA_BASE_SECURITY_HEADERS,
                  'Content-Range': `bytes */${totalSize}`,
                  'Accept-Ranges': 'bytes',
                },
              });
            }
          }
        } else if (totalSize > 0) {
          headers['Content-Length'] = String(totalSize);
        }

        const nodeStream = fs.createReadStream(resolved.filePath, streamOpts);
        nodeStream.on('error', () => {
          try {
            nodeStream.destroy();
          } catch {}
        });
        if (request?.signal) {
          if (request.signal.aborted) {
            nodeStream.destroy();
            return new Response(null, {
              status: 499,
              headers: { ...OL_MEDIA_BASE_SECURITY_HEADERS },
            });
          }
          request.signal.addEventListener(
            'abort',
            () => {
              try {
                nodeStream.destroy();
              } catch {}
            },
            { once: true }
          );
        }

        const webStream = Readable.toWeb(nodeStream);
        return new Response(/** @type {any} */ (webStream), {
          status: statusCode,
          headers,
        });
      }

      return new Response(null, {
        status: 404,
        headers: {
          ...OL_MEDIA_BASE_SECURITY_HEADERS,
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      return new Response(null, {
        status: 500,
        headers: {
          ...OL_MEDIA_BASE_SECURITY_HEADERS,
          'Cache-Control': 'no-store',
        },
      });
    }
  };
}

/** @type {Map<string, { mtimeMs: number, overrides: Record<string, Record<string, any>> }>} */
const userOverridesMemoryCache = new Map();
/** @type {Map<string, Promise<any>>} */
const userOverridesWriteQueues = new Map();
let userOverridesTmpSeq = 0;

/**
 * Resolve the atomic persistence path for `user_overrides.json`.
 * @param {any} offlineVaultService
 * @param {string | undefined} explicitUserDataDir
 * @returns {string}
 */
function resolveUserOverridesFilePath(offlineVaultService, explicitUserDataDir) {
  if (typeof explicitUserDataDir === 'string' && explicitUserDataDir.trim()) {
    return path.join(explicitUserDataDir.trim(), 'user_overrides.json');
  }
  if (typeof offlineVaultService?.userDataDir === 'string' && offlineVaultService.userDataDir.trim()) {
    return path.join(offlineVaultService.userDataDir.trim(), 'user_overrides.json');
  }
  if (typeof offlineVaultService?.vaultDir === 'string' && offlineVaultService.vaultDir.trim()) {
    return path.join(path.dirname(offlineVaultService.vaultDir.trim()), 'user_overrides.json');
  }
  return path.join(resolveEffectiveUserDataDir(), 'user_overrides.json');
}

/**
 * Validate a `gameId` key for user override storage.
 * @param {unknown} rawGameId
 * @returns {string}
 */
function normalizeSafeOverrideGameId(rawGameId) {
  if (typeof rawGameId !== 'string') return '';
  const trimmed = rawGameId.trim();
  if (
    !trimmed ||
    trimmed.length > 256 ||
    trimmed.includes('\0') ||
    trimmed === '__proto__' ||
    trimmed === 'constructor' ||
    trimmed === 'prototype'
  ) {
    return '';
  }
  return trimmed;
}

/**
 * Normalizes a `(platformId, platformGameId)` pair for cross-key override deduplication.
 * @param {unknown} rawPlatformId
 * @param {unknown} rawPlatformGameId
 * @returns {{ platformId: string, platformGameId: string } | null}
 */
function normalizeEntitlementPair(rawPlatformId, rawPlatformGameId) {
  const platformId = typeof rawPlatformId === 'string' ? rawPlatformId.trim().toLowerCase() : '';
  const rawPid =
    typeof rawPlatformGameId === 'string' || typeof rawPlatformGameId === 'number'
      ? String(rawPlatformGameId).trim()
      : '';
  if (!platformId || !rawPid) return null;
  const platformGameId =
    platformId === 'xbox' && /^[A-Z0-9]{12}$/i.test(rawPid) ? rawPid.toUpperCase() : rawPid;
  return { platformId, platformGameId };
}

/**
 * Extracts the underlying storefront `(platformId, platformGameId)` entitlement identity from
 * an override map key and record across modern (`platformId` + `platformGameId`) and legacy
 * (`<store>-<id>` / `matchedStore` + `matchedId`) override schemas.
 *
 * @param {string} key
 * @param {Record<string, any> | null | undefined} ov
 * @returns {{ platformId: string, platformGameId: string } | null}
 */
function extractOverrideEntitlementPair(key, ov) {
  if (ov && typeof ov === 'object') {
    const explicit = normalizeEntitlementPair(ov.platformId, ov.platformGameId);
    if (explicit) return explicit;
  }

  const candidateIds = [key, typeof ov?.gameId === 'string' ? ov.gameId : ''];
  for (const cid of candidateIds) {
    if (!cid) continue;
    const nonSteamPrefix = cid.match(/^(gog|epic|xbox|ea|ubisoft|local)[:_-](.+)$/i);
    if (nonSteamPrefix) {
      const pair = normalizeEntitlementPair(nonSteamPrefix[1], nonSteamPrefix[2]);
      if (pair) return pair;
    }
  }

  if (ov && typeof ov === 'object') {
    const mStore = typeof ov.matchedStore === 'string' ? ov.matchedStore.trim().toLowerCase() : '';
    if (mStore && mStore !== 'steam' && ov.matchedId != null) {
      const legacyMatched = normalizeEntitlementPair(mStore, ov.matchedId);
      if (legacyMatched) return legacyMatched;
    }
  }

  for (const cid of candidateIds) {
    if (!cid) continue;
    const steamPrefix = cid.match(/^steam[:_-](\d+)$/i);
    if (steamPrefix) {
      return normalizeEntitlementPair('steam', steamPrefix[1]);
    }
  }

  return null;
}

/**
 * Adds a safe override key and its `:`, `-`, and `_` storefront separator variants to `targetSet`.
 * @param {Set<string>} targetSet
 * @param {unknown} rawKey
 */
function addOverrideKeyVariants(targetSet, rawKey) {
  const safe = normalizeSafeOverrideGameId(rawKey);
  if (!safe) return;
  targetSet.add(safe);
  const match = safe.match(/^(steam|gog|epic|xbox|ea|ubisoft|local)[:_-](.+)$/i);
  if (match) {
    const prefix = match[1].toLowerCase();
    const rest = match[2].trim();
    if (rest) {
      targetSet.add(`${prefix}:${rest}`);
      targetSet.add(`${prefix}-${rest}`);
      targetSet.add(`${prefix}_${rest}`);
      if (prefix === 'xbox' && /^[A-Z0-9]{12}$/i.test(rest)) {
        const up = rest.toUpperCase();
        const lo = rest.toLowerCase();
        targetSet.add(`xbox:${up}`);
        targetSet.add(`xbox:${lo}`);
        targetSet.add(`xbox-${up}`);
        targetSet.add(`xbox-${lo}`);
        targetSet.add(`xbox_${up}`);
        targetSet.add(`xbox_${lo}`);
      }
    }
  }
}

/**
 * Extracts positive numeric Steam App IDs referenced by an override key or record.
 * @param {string} key
 * @param {Record<string, any> | null | undefined} ov
 * @returns {number[]}
 */
function extractLinkedSteamAppIds(key, ov) {
  /** @type {Set<number>} */
  const ids = new Set();
  const addCandidate = (/** @type {unknown} */ val) => {
    if (typeof val === 'number' && Number.isInteger(val) && val > 0) {
      ids.add(val);
    } else if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
      const parsed = parseInt(val.trim(), 10);
      if (parsed > 0) ids.add(parsed);
    }
  };

  const keyMatch = String(key || '').match(/^steam[:_-](\d+)$/i);
  if (keyMatch) addCandidate(keyMatch[1]);

  if (ov && typeof ov === 'object') {
    const gidMatch = String(ov.gameId || '').match(/^steam[:_-](\d+)$/i);
    if (gidMatch) addCandidate(gidMatch[1]);
    addCandidate(ov.steamAppId);
    if (String(ov.matchedStore || '').trim().toLowerCase() === 'steam') {
      addCandidate(ov.matchedId);
    }
  }

  return Array.from(ids);
}

/**
 * Parse and sanitize raw JSON text from `user_overrides.json`.
 * @param {string} rawText
 * @returns {Record<string, Record<string, any>>}
 */
function parseSanitizedUserOverridesJson(rawText) {
  const parsed = JSON.parse(rawText);
  const rawMap =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed.overrides && typeof parsed.overrides === 'object' && !Array.isArray(parsed.overrides)
        ? parsed.overrides
        : parsed
      : {};
  /** @type {Record<string, Record<string, any>>} */
  const cleanMap = {};
  for (const [k, v] of Object.entries(rawMap)) {
    const safeKey = normalizeSafeOverrideGameId(k);
    if (!safeKey) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      cleanMap[safeKey] = sanitizeRendererIpcOptions(v);
    }
  }
  return cleanMap;
}

/**
 * Read durable user metadata/artwork overrides map synchronously from `userData/user_overrides.json`.
 * @param {string} filePath
 * @returns {Record<string, Record<string, any>>}
 */
function readUserOverridesFromDisk(filePath) {
  const hostFilePath = toHostFilesystemPath(filePath);
  try {
    if (!fs.existsSync(hostFilePath)) {
      userOverridesMemoryCache.delete(hostFilePath);
      return {};
    }
    const stat = fs.statSync(hostFilePath);
    const cached = userOverridesMemoryCache.get(hostFilePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return { ...cached.overrides };
    }
    const cleanMap = parseSanitizedUserOverridesJson(fs.readFileSync(hostFilePath, 'utf8'));
    userOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: stat.mtimeMs,
      overrides: cleanMap,
    });
    return { ...cleanMap };
  } catch {
    return {};
  }
}

/**
 * Read durable user metadata/artwork overrides map asynchronously with `mtimeMs`-validated in-memory caching.
 * @param {string} filePath
 * @returns {Promise<Record<string, Record<string, any>>>}
 */
async function readUserOverridesAsync(filePath) {
  const hostFilePath = toHostFilesystemPath(filePath);
  try {
    let stat = null;
    try {
      stat = await fs.promises.stat(hostFilePath);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) {
      userOverridesMemoryCache.delete(hostFilePath);
      return {};
    }
    const cached = userOverridesMemoryCache.get(hostFilePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return { ...cached.overrides };
    }
    const rawText = await fs.promises.readFile(hostFilePath, 'utf8');
    const cleanMap = parseSanitizedUserOverridesJson(rawText);
    userOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: stat.mtimeMs,
      overrides: cleanMap,
    });
    return { ...cleanMap };
  } catch {
    return {};
  }
}

/**
 * Enqueue a serialized async read/write task per resolved `user_overrides.json` path so concurrent
 * IPC mutations never race on `.tmp` files or clobber sibling keys.
 *
 * @template T
 * @param {string} filePath
 * @param {(hostFilePath: string) => Promise<T>} taskFn
 * @returns {Promise<T>}
 */
function enqueueUserOverridesTask(filePath, taskFn) {
  const hostFilePath = toHostFilesystemPath(filePath);
  const prev = userOverridesWriteQueues.get(hostFilePath) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => taskFn(hostFilePath));
  const tracked = next.finally(() => {
    if (userOverridesWriteQueues.get(hostFilePath) === tracked) {
      userOverridesWriteQueues.delete(hostFilePath);
    }
  });
  userOverridesWriteQueues.set(hostFilePath, tracked);
  return next;
}

/**
 * Internal atomic async writer for `user_overrides.json` with bounded Windows `EPERM`/`EACCES`/`EBUSY`
 * rename retry backoff (`15ms -> 40ms -> 80ms`) and temp-file cleanup.
 *
 * @param {string} hostFilePath
 * @param {Record<string, Record<string, any>>} nextOverrides
 * @param {string} [updatedAt]
 * @returns {Promise<void>}
 */
async function performAtomicUserOverridesWriteAsync(hostFilePath, nextOverrides, updatedAt) {
  const effectiveUpdatedAt = updatedAt || new Date().toISOString();
  const serialized = JSON.stringify(
    { overrides: nextOverrides, updatedAt: effectiveUpdatedAt },
    null,
    2
  );
  const dir = path.dirname(hostFilePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${hostFilePath}.${process.pid}.${++userOverridesTmpSeq}.tmp`;
  const retryDelaysMs = [15, 40, 80];

  try {
    await fs.promises.writeFile(tmpPath, serialized, 'utf8');
    let renamed = false;
    let lastRenameErr = null;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      try {
        await fs.promises.rename(tmpPath, hostFilePath);
        renamed = true;
        break;
      } catch (renErr) {
        lastRenameErr = renErr;
        const code = String(/** @type {any} */ (renErr)?.code || '').toUpperCase();
        const isRetryableLock = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
        if (!isRetryableLock || attempt >= retryDelaysMs.length) {
          break;
        }
        const delayMs = retryDelaysMs[attempt];
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    if (!renamed) {
      throw lastRenameErr || new Error('Failed to rename user_overrides temporary file');
    }
  } catch {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {}
    atomicWriteFileSync(hostFilePath, serialized);
  }

  try {
    const postStat = await fs.promises.stat(hostFilePath);
    userOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: postStat.mtimeMs,
      overrides: { ...nextOverrides },
    });
  } catch {
    userOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: -1,
      overrides: { ...nextOverrides },
    });
  }
}

/**
 * Serialized async atomic writer for `user_overrides.json`.
 *
 * @param {string} filePath
 * @param {Record<string, Record<string, any>>} nextOverrides
 * @param {string} [updatedAt]
 * @returns {Promise<void>}
 */
function writeUserOverridesToDiskAsync(filePath, nextOverrides, updatedAt) {
  return enqueueUserOverridesTask(filePath, (hostFilePath) =>
    performAtomicUserOverridesWriteAsync(hostFilePath, nextOverrides, updatedAt)
  );
}

const MAX_USER_TAG_LENGTH = 64;
const MAX_USER_TAGS_PER_ARRAY = 100;
const MAX_USER_TAG_PLATFORM_ALIASES = 50;
const MAX_USER_TAG_OVERRIDES_PAYLOAD_BYTES = 2 * 1024 * 1024;

/**
 * @typedef {{
 *   gameId: string,
 *   platformAliases?: string[],
 *   addedTags: string[],
 *   removedTags: string[],
 *   updatedAt: string,
 * }} SanitizedUserTagOverrideRecord
 */

/** @type {Map<string, { mtimeMs: number, overrides: Record<string, SanitizedUserTagOverrideRecord> }>} */
const userTagOverridesMemoryCache = new Map();
/** @type {Map<string, Promise<any>>} */
const userTagOverridesWriteQueue = new Map();
let userTagOverridesTmpSeq = 0;

/**
 * Resolve the atomic persistence path for `user_tag_overrides.json`.
 * Completely decoupled from `user_overrides.json` so tag edits never trigger media-blob resets.
 *
 * @param {any} offlineVaultService
 * @param {string | undefined} explicitUserDataDir
 * @returns {string}
 */
function resolveUserTagOverridesFilePath(offlineVaultService, explicitUserDataDir) {
  if (typeof explicitUserDataDir === 'string' && explicitUserDataDir.trim()) {
    return path.join(explicitUserDataDir.trim(), 'user_tag_overrides.json');
  }
  if (typeof offlineVaultService?.userDataDir === 'string' && offlineVaultService.userDataDir.trim()) {
    return path.join(offlineVaultService.userDataDir.trim(), 'user_tag_overrides.json');
  }
  if (typeof offlineVaultService?.vaultDir === 'string' && offlineVaultService.vaultDir.trim()) {
    return path.join(path.dirname(offlineVaultService.vaultDir.trim()), 'user_tag_overrides.json');
  }
  return path.join(resolveEffectiveUserDataDir(), 'user_tag_overrides.json');
}

/**
 * Sanitize a single tag label: strip ASCII control chars, collapse whitespace, clamp to 64 chars.
 * @param {unknown} rawTag
 * @returns {string}
 */
function sanitizeUserTagValue(rawTag) {
  if (typeof rawTag !== 'string') return '';
  const cleaned = rawTag
    .replace(/[\x00-\x1f\x7f]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_USER_TAG_LENGTH)
    .trim();
  return cleaned;
}

/**
 * Sanitize an array of tag labels (strings only, case-insensitive dedupe, capped at 100 entries).
 * @param {unknown} rawList
 * @returns {string[]}
 */
function sanitizeUserTagArray(rawList) {
  if (!Array.isArray(rawList)) return [];
  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const item of rawList) {
    if (out.length >= MAX_USER_TAGS_PER_ARRAY) break;
    const clean = sanitizeUserTagValue(item);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/**
 * Sanitize platform alias identifiers (`steam:<appId>`, `<platformId>:<platformGameId>`), capped at 50.
 * @param {unknown} rawAliases
 * @returns {string[]}
 */
function sanitizeUserTagAliases(rawAliases) {
  if (!Array.isArray(rawAliases)) return [];
  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const item of rawAliases) {
    if (out.length >= MAX_USER_TAG_PLATFORM_ALIASES) break;
    if (typeof item !== 'string') continue;
    const stripped = item.replace(/[\x00-\x1f\x7f]+/g, '').trim();
    const safeAlias = normalizeSafeOverrideGameId(stripped);
    if (!safeAlias || seen.has(safeAlias)) continue;
    seen.add(safeAlias);
    out.push(safeAlias);
  }
  return out;
}

/**
 * Validate and sanitize a `UserTagOverride` record.
 * @param {unknown} rawGameId
 * @param {any} rawRecord
 * @param {string} [fallbackIso]
 * @returns {SanitizedUserTagOverrideRecord | null}
 */
function sanitizeUserTagOverrideRecord(rawGameId, rawRecord, fallbackIso) {
  const gameId = normalizeSafeOverrideGameId(
    rawGameId || (rawRecord && typeof rawRecord === 'object' ? rawRecord.gameId : '')
  );
  if (!gameId || !rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) {
    return null;
  }
  const addedTags = sanitizeUserTagArray(rawRecord.addedTags);
  const addedKeys = new Set(addedTags.map((t) => t.toLowerCase()));
  const removedTags = sanitizeUserTagArray(rawRecord.removedTags).filter(
    (t) => !addedKeys.has(t.toLowerCase())
  );
  const platformAliases = sanitizeUserTagAliases(rawRecord.platformAliases);
  const rawUpdated = typeof rawRecord.updatedAt === 'string' ? rawRecord.updatedAt.trim() : '';
  const updatedAt = Number.isFinite(Date.parse(rawUpdated))
    ? rawUpdated
    : fallbackIso || new Date().toISOString();

  /** @type {SanitizedUserTagOverrideRecord} */
  const record = {
    gameId,
    ...(platformAliases.length > 0 ? { platformAliases } : {}),
    addedTags,
    removedTags,
    updatedAt,
  };
  return record;
}

/**
 * Parse and sanitize raw JSON text from `user_tag_overrides.json`.
 * @param {string} rawText
 * @returns {Record<string, SanitizedUserTagOverrideRecord>}
 */
function parseSanitizedUserTagOverridesJson(rawText) {
  if (
    typeof rawText !== 'string' ||
    Buffer.byteLength(rawText, 'utf8') > MAX_USER_TAG_OVERRIDES_PAYLOAD_BYTES * 2
  ) {
    return {};
  }
  const parsed = JSON.parse(rawText);
  const rawMap =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed.overrides && typeof parsed.overrides === 'object' && !Array.isArray(parsed.overrides)
        ? parsed.overrides
        : parsed
      : {};
  /** @type {Record<string, SanitizedUserTagOverrideRecord>} */
  const cleanMap = {};
  for (const [k, v] of Object.entries(rawMap)) {
    const safeKey = normalizeSafeOverrideGameId(k);
    if (!safeKey) continue;
    const sanitized = sanitizeUserTagOverrideRecord(safeKey, v);
    if (!sanitized) continue;
    if (sanitized.addedTags.length === 0 && sanitized.removedTags.length === 0) continue;
    cleanMap[safeKey] = sanitized;
  }
  return cleanMap;
}

/**
 * Read durable user tag overrides map synchronously from `userData/user_tag_overrides.json`.
 * @param {string} filePath
 * @returns {Record<string, SanitizedUserTagOverrideRecord>}
 */
function readUserTagOverridesFromDisk(filePath) {
  const hostFilePath = toHostFilesystemPath(filePath);
  try {
    if (!fs.existsSync(hostFilePath)) {
      userTagOverridesMemoryCache.delete(hostFilePath);
      return {};
    }
    const stat = fs.statSync(hostFilePath);
    const cached = userTagOverridesMemoryCache.get(hostFilePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return { ...cached.overrides };
    }
    const cleanMap = parseSanitizedUserTagOverridesJson(fs.readFileSync(hostFilePath, 'utf8'));
    userTagOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: stat.mtimeMs,
      overrides: cleanMap,
    });
    return { ...cleanMap };
  } catch {
    return {};
  }
}

/**
 * Read durable user tag overrides map asynchronously with `mtimeMs`-validated in-memory caching.
 * @param {string} filePath
 * @returns {Promise<Record<string, SanitizedUserTagOverrideRecord>>}
 */
async function readUserTagOverridesAsync(filePath) {
  const hostFilePath = toHostFilesystemPath(filePath);
  try {
    let stat = null;
    try {
      stat = await fs.promises.stat(hostFilePath);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) {
      userTagOverridesMemoryCache.delete(hostFilePath);
      return {};
    }
    const cached = userTagOverridesMemoryCache.get(hostFilePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return { ...cached.overrides };
    }
    const rawText = await fs.promises.readFile(hostFilePath, 'utf8');
    const cleanMap = parseSanitizedUserTagOverridesJson(rawText);
    userTagOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: stat.mtimeMs,
      overrides: cleanMap,
    });
    return { ...cleanMap };
  } catch {
    return {};
  }
}

/**
 * Enqueue a serialized async read/write task per resolved `user_tag_overrides.json` path so
 * tag writes never race or contend with `user_overrides.json`.
 *
 * @template T
 * @param {string} filePath
 * @param {(hostFilePath: string) => Promise<T>} taskFn
 * @returns {Promise<T>}
 */
function enqueueUserTagOverridesTask(filePath, taskFn) {
  const hostFilePath = toHostFilesystemPath(filePath);
  const prev = userTagOverridesWriteQueue.get(hostFilePath) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => taskFn(hostFilePath));
  const tracked = next.catch(() => {}).finally(() => {
    if (userTagOverridesWriteQueue.get(hostFilePath) === tracked) {
      userTagOverridesWriteQueue.delete(hostFilePath);
    }
  });
  userTagOverridesWriteQueue.set(hostFilePath, tracked);
  return next;
}

/**
 * Internal atomic async writer for `user_tag_overrides.json` with strict 2 MB payload cap
 * and bounded Windows `EPERM`/`EACCES`/`EBUSY` rename retry backoff.
 *
 * @param {string} hostFilePath
 * @param {Record<string, SanitizedUserTagOverrideRecord>} nextOverrides
 * @param {string} [updatedAt]
 * @returns {Promise<void>}
 */
async function performAtomicUserTagOverridesWriteAsync(hostFilePath, nextOverrides, updatedAt) {
  const effectiveUpdatedAt = updatedAt || new Date().toISOString();
  const serialized = JSON.stringify(
    { overrides: nextOverrides, updatedAt: effectiveUpdatedAt },
    null,
    2
  );
  if (Buffer.byteLength(serialized, 'utf8') > MAX_USER_TAG_OVERRIDES_PAYLOAD_BYTES) {
    throw new Error('User tag overrides payload exceeds 2 MB limit.');
  }

  const dir = path.dirname(hostFilePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${hostFilePath}.${process.pid}.${++userTagOverridesTmpSeq}.tmp`;
  const retryDelaysMs = [15, 40, 80];

  try {
    await fs.promises.writeFile(tmpPath, serialized, 'utf8');
    let renamed = false;
    let lastRenameErr = null;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      try {
        await fs.promises.rename(tmpPath, hostFilePath);
        renamed = true;
        break;
      } catch (renErr) {
        lastRenameErr = renErr;
        const code = String(/** @type {any} */ (renErr)?.code || '').toUpperCase();
        const isRetryableLock = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
        if (!isRetryableLock || attempt >= retryDelaysMs.length) {
          break;
        }
        const delayMs = retryDelaysMs[attempt];
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    if (!renamed) {
      throw lastRenameErr || new Error('Failed to rename user_tag_overrides temporary file');
    }
  } catch (err) {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {}
    if (
      err &&
      typeof err === 'object' &&
      String(/** @type {any} */ (err).message || '').includes('2 MB limit')
    ) {
      throw err;
    }
    atomicWriteFileSync(hostFilePath, serialized);
  }

  try {
    const postStat = await fs.promises.stat(hostFilePath);
    userTagOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: postStat.mtimeMs,
      overrides: { ...nextOverrides },
    });
  } catch {
    userTagOverridesMemoryCache.set(hostFilePath, {
      mtimeMs: -1,
      overrides: { ...nextOverrides },
    });
  }
}

/**
 * Serialized async atomic writer for `user_tag_overrides.json`.
 *
 * @param {string} filePath
 * @param {Record<string, SanitizedUserTagOverrideRecord>} nextOverrides
 * @param {string} [updatedAt]
 * @returns {Promise<void>}
 */
function writeUserTagOverridesToDiskAsync(filePath, nextOverrides, updatedAt) {
  return enqueueUserTagOverridesTask(filePath, (hostFilePath) =>
    performAtomicUserTagOverridesWriteAsync(hostFilePath, nextOverrides, updatedAt)
  );
}

/**
 * Registers all `offlineVault:*` and user-override IPC channels, forwarding background health
 * and hydration events to the active BrowserWindow renderer (or daemon event buffer).
 *
 * @param {{
 *   ipcMain: any,
 *   offlineVaultService: any,
 *   mediaHydrationEngine: any,
 *   federator?: any,
 *   getMainWindow?: () => any,
 *   sendRendererEvent?: (channel: string, payload: any) => void,
 *   userDataDir?: string,
 *   dnsLookup?: any,
 *   options?: Record<string, any>,
 * }} deps
 */
function registerOfflineVaultIpcHandlers({
  ipcMain: rawIpcMain,
  offlineVaultService,
  mediaHydrationEngine,
  federator,
  getMainWindow,
  sendRendererEvent,
  userDataDir,
  dnsLookup,
  options: handlerOptions = {},
}) {
  if (!rawIpcMain || !offlineVaultService) {
    return { dispose: () => {} };
  }
  const ipcMain = wrapIpcMainWithSenderCheck(rawIpcMain, {
    getMainWindow,
    isPackaged: Boolean(handlerOptions.isPackaged),
    allowedDevOrigin: handlerOptions.allowedDevOrigin || null,
    expectedFileHref: handlerOptions.expectedFileHref || null,
  });

  const sendToRenderer = (/** @type {string} */ channel, /** @type {any} */ payload) => {
    if (typeof sendRendererEvent === 'function') {
      sendRendererEvent(channel, payload);
      return;
    }
    try {
      const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
      if (win && !win.isDestroyed?.() && win.webContents) {
        win.webContents.send(channel, payload);
      }
    } catch {}
  };

  const unsubHealth =
    typeof offlineVaultService.onHealthChanged === 'function'
      ? offlineVaultService.onHealthChanged((/** @type {any} */ snapshot) => {
          sendToRenderer('offlineVault:health-changed', snapshot);
        })
      : () => {};

  const unsubHydrated =
    mediaHydrationEngine && typeof mediaHydrationEngine.onGameHydrated === 'function'
      ? mediaHydrationEngine.onGameHydrated((/** @type {any} */ payload) => {
          sendToRenderer('offlineVault:game-hydrated', payload);
        })
      : () => {};

  const unsubProgress =
    mediaHydrationEngine && typeof mediaHydrationEngine.onHydrationProgress === 'function'
      ? mediaHydrationEngine.onHydrationProgress((/** @type {any} */ payload) => {
          sendToRenderer('offlineVault:hydration-progress', payload);
        })
      : () => {};

  ipcMain.handle('offlineVault:get-stats', async () => {
    return offlineVaultService.getStats();
  });

  ipcMain.handle(
    'offlineVault:set-tier',
    async (/** @type {any} */ _event, /** @type {unknown} */ tier) => {
      return offlineVaultService.setTier(typeof tier === 'string' ? tier : '');
    }
  );

  ipcMain.handle(
    'offlineVault:clear',
    async (/** @type {any} */ _event, /** @type {unknown} */ options) => {
      return offlineVaultService.clear(sanitizeRendererIpcOptions(options));
    }
  );

  ipcMain.handle('offlineVault:get-catalog-snapshot', async () => {
    return offlineVaultService.getCatalogSnapshot();
  });

  ipcMain.handle(
    'offlineVault:upsert-games',
    async (/** @type {any} */ _event, /** @type {unknown} */ games) => {
      if (!Array.isArray(games)) {
        return { success: false, error: 'Expected array of games' };
      }
      const cleanGames = games
        .filter((g) => g && typeof g === 'object')
        .map((g) => sanitizeRendererIpcOptions(g));
      return offlineVaultService.upsertGames(cleanGames);
    }
  );

  ipcMain.handle(
    'offlineVault:delete-games',
    async (/** @type {any} */ _event, /** @type {unknown} */ rawGameIds) => {
      if (typeof offlineVaultService.deleteGames !== 'function') {
        return { success: false, deleted: 0, error: 'deleteGames unsupported' };
      }
      const list = Array.isArray(rawGameIds)
        ? rawGameIds
        : rawGameIds &&
            typeof rawGameIds === 'object' &&
            Array.isArray(/** @type {any} */ (rawGameIds).gameIds)
          ? /** @type {any} */ (rawGameIds).gameIds
          : typeof rawGameIds === 'string'
            ? [rawGameIds]
            : [];
      const safeIds = list
        .map((item) => normalizeSafeOverrideGameId(item))
        .filter((id) => Boolean(id));
      return offlineVaultService.deleteGames(safeIds);
    }
  );

  ipcMain.handle(
    'offlineVault:set-modal-busy',
    async (/** @type {any} */ _event, /** @type {unknown} */ rawBusy) => {
      const isBusy =
        typeof rawBusy === 'boolean'
          ? rawBusy
          : rawBusy && typeof rawBusy === 'object'
            ? Boolean(
                /** @type {any} */ (rawBusy).isBusy ?? /** @type {any} */ (rawBusy).busy ?? false
              )
            : Boolean(rawBusy);
      if (mediaHydrationEngine && typeof mediaHydrationEngine.setModalBusy === 'function') {
        return mediaHydrationEngine.setModalBusy(isBusy);
      }
      return { success: true, isPausedForModal: isBusy };
    }
  );

  ipcMain.handle(
    'offlineVault:get-game-detail',
    async (/** @type {any} */ _event, /** @type {unknown} */ gameId) => {
      return offlineVaultService.getGameDetail(typeof gameId === 'string' ? gameId : '');
    }
  );

  ipcMain.handle(
    'offlineVault:save-game-detail',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
      return offlineVaultService.saveGameDetail(sanitizeRendererIpcOptions(payload));
    }
  );

  ipcMain.handle(
    'offlineVault:resolve-local-metadata',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
      const cleanPayload = sanitizeRendererIpcOptions(payload);
      const activeFederator = federator || offlineVaultService.federator;
      const metadata =
        activeFederator && typeof activeFederator.resolveLocalMetadata === 'function'
          ? activeFederator.resolveLocalMetadata(cleanPayload)
          : null;

      if (metadata && cleanPayload.gameId) {
        try {
          offlineVaultService.saveGameDetail({
            gameId: String(cleanPayload.gameId),
            canonicalTitle: cleanPayload.title || metadata.name || '',
            steamAppId:
              typeof cleanPayload.steamAppId === 'number' ? cleanPayload.steamAppId : null,
            enrichedMetadata: metadata,
            metadataQuality: 'local_federated',
          });
        } catch {}
      }

      return {
        success: Boolean(metadata),
        metadata: metadata || null,
      };
    }
  );

  ipcMain.handle(
    'offlineVault:queue-hydration',
    async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
      if (!mediaHydrationEngine) {
        return { success: false, queued: 0 };
      }
      const cleanPayload = sanitizeRendererIpcOptions(payload);
      const rawGames = Array.isArray(cleanPayload.games) ? cleanPayload.games : [];
      const sanitizedGames = rawGames
        .filter((g) => g && typeof g === 'object')
        .map((g) => sanitizeRendererIpcOptions(g));
      return mediaHydrationEngine.queueHydration({ games: sanitizedGames });
    }
  );

  const handleCheckUrlStatus = async (/** @type {any} */ _event, /** @type {unknown} */ rawUrl) => {
    const urlStr = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    try {
      await assertSafePublicHttpsUrl(
        urlStr,
        typeof dnsLookup === 'function' ? { dnsLookup } : undefined
      );
    } catch (urlErr) {
      const anyErr = /** @type {any} */ (urlErr);
      if (!anyErr?.isDnsUnavailable || typeof dnsLookup === 'function') {
        return {
          online: false,
          status: null,
          isDefinitive404: false,
          isWafOrRateLimited: false,
          blocked: true,
          error: anyErr?.message || 'Blocked unsafe URL',
        };
      }
      if (!offlineVaultService?.hasCustomFetchImpl) {
        return {
          online: false,
          status: null,
          isDefinitive404: false,
          isWafOrRateLimited: false,
          error: anyErr?.message || 'DNS unavailable',
        };
      }
    }
    return await offlineVaultService.checkUrlStatus(urlStr);
  };

  ipcMain.handle('offlineVault:check-url-status', handleCheckUrlStatus);

  // Durable User Metadata & Artwork Overrides (`userData/user_overrides.json`)
  const handleGetUserOverrides = async () => {
    const filePath = resolveUserOverridesFilePath(offlineVaultService, userDataDir);
    const hostFilePath = toHostFilesystemPath(filePath);
    const pendingWrite = userOverridesWriteQueues.get(hostFilePath);
    if (pendingWrite) {
      try {
        await pendingWrite;
      } catch {}
    }
    return await readUserOverridesAsync(filePath);
  };

  const handleSaveUserOverride = async (
    /** @type {any} */ _event,
    /** @type {unknown} */ arg1,
    /** @type {unknown} */ arg2
  ) => {
    if (
      arg1 &&
      typeof arg1 === 'object' &&
      !Array.isArray(arg1) &&
      /** @type {any} */ (arg1).batchOverrides &&
      typeof /** @type {any} */ (arg1).batchOverrides === 'object' &&
      !Array.isArray(/** @type {any} */ (arg1).batchOverrides)
    ) {
      const cleanBatch = sanitizeRendererIpcOptions(/** @type {any} */ (arg1).batchOverrides);
      const filePath = resolveUserOverridesFilePath(offlineVaultService, userDataDir);

      const batchResult = await enqueueUserOverridesTask(filePath, async (hostFilePath) => {
        const current = await readUserOverridesAsync(hostFilePath);
        /** @type {Record<string, Record<string, any>>} */
        const nextOverrides = { ...current };
        /** @type {Array<[string, Record<string, any>, string[]]>} */
        const mergedRecords = [];
        const nowIso = new Date().toISOString();

        for (const [rawKey, rawPatch] of Object.entries(cleanBatch)) {
          const batchGameId = normalizeSafeOverrideGameId(rawKey);
          if (!batchGameId || !rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
            continue;
          }
          const cleanPatch = sanitizeRendererIpcOptions(rawPatch);
          /** @type {string[]} */
          const batchPurgeKeys = Array.isArray(cleanPatch.purgeKeys)
            ? cleanPatch.purgeKeys
                .map((/** @type {unknown} */ k) => normalizeSafeOverrideGameId(k))
                .filter((/** @type {string} */ k) => Boolean(k) && k !== batchGameId)
            : [];
          delete cleanPatch.id;
          delete cleanPatch.purgeKeys;

          const existing = nextOverrides[batchGameId];
          const existingMs = Date.parse(String(existing?.updatedAt || ''));
          const rawPatchUpdatedStr =
            typeof cleanPatch.updatedAt === 'string' ? cleanPatch.updatedAt.trim() : '';
          const patchMs = Date.parse(rawPatchUpdatedStr);

          if (Number.isFinite(existingMs) && Number.isFinite(patchMs) && existingMs > patchMs) {
            continue;
          }

          const validPatchUpdatedAtIso = Number.isFinite(patchMs) ? rawPatchUpdatedStr : '';
          const mergedRecord = {
            ...(existing || {}),
            ...cleanPatch,
            gameId: batchGameId,
            updatedAt: validPatchUpdatedAtIso || nowIso,
          };
          delete /** @type {any} */ (mergedRecord).purgeKeys;

          /** @type {Set<string>} */
          const purgedForEntry = new Set(batchPurgeKeys);
          for (const pk of batchPurgeKeys) {
            delete nextOverrides[pk];
          }

          const targetPair = extractOverrideEntitlementPair(batchGameId, mergedRecord);
          if (targetPair) {
            for (const [otherKey, otherOv] of Object.entries(nextOverrides)) {
              if (otherKey === batchGameId) continue;
              const otherPair = extractOverrideEntitlementPair(otherKey, otherOv);
              if (
                otherPair &&
                otherPair.platformId === targetPair.platformId &&
                otherPair.platformGameId === targetPair.platformGameId &&
                otherOv?.gameId !== batchGameId
              ) {
                delete nextOverrides[otherKey];
                purgedForEntry.add(otherKey);
              }
            }
          }

          nextOverrides[batchGameId] = mergedRecord;
          mergedRecords.push([batchGameId, mergedRecord, Array.from(purgedForEntry)]);
        }

        await performAtomicUserOverridesWriteAsync(hostFilePath, nextOverrides, nowIso);
        return {
          mergedRecords,
          nextOverrides,
        };
      });

      if (typeof offlineVaultService.saveUserOverride === 'function') {
        for (const [id, rec, purgedKeys] of batchResult.mergedRecords) {
          try {
            offlineVaultService.saveUserOverride(id, rec, purgedKeys);
          } catch {}
        }
      }

      return {
        success: true,
        count: batchResult.mergedRecords.length,
        overrides: batchResult.nextOverrides,
      };
    }

    let gameId = '';
    /** @type {Record<string, any>} */
    let patch = {};
    /** @type {Set<string>} */
    const explicitPurgeKeys = new Set();

    if (typeof arg1 === 'string') {
      gameId = normalizeSafeOverrideGameId(arg1);
      patch = sanitizeRendererIpcOptions(arg2);
    } else if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
      const cleanObj = sanitizeRendererIpcOptions(arg1);
      gameId = normalizeSafeOverrideGameId(cleanObj.gameId || cleanObj.id);
      if (Array.isArray(cleanObj.purgeKeys)) {
        for (const rawPk of cleanObj.purgeKeys) {
          addOverrideKeyVariants(explicitPurgeKeys, rawPk);
        }
      }
      if (cleanObj.override && typeof cleanObj.override === 'object' && !Array.isArray(cleanObj.override)) {
        patch = sanitizeRendererIpcOptions(cleanObj.override);
      } else {
        patch = { ...cleanObj };
        delete patch.id;
      }
    }

    if (Array.isArray(patch.purgeKeys)) {
      for (const rawPk of patch.purgeKeys) {
        addOverrideKeyVariants(explicitPurgeKeys, rawPk);
      }
    }
    delete patch.id;
    delete patch.purgeKeys;

    if (!gameId) {
      return { success: false, error: 'Invalid or missing gameId for user override.' };
    }
    explicitPurgeKeys.delete(gameId);

    const filePath = resolveUserOverridesFilePath(offlineVaultService, userDataDir);
    const { updatedRecord, nextOverrides, purgedKeys } = await enqueueUserOverridesTask(
      filePath,
      async (hostFilePath) => {
        const current = await readUserOverridesAsync(hostFilePath);
        const existing = current[gameId];
        const existingMs = Date.parse(String(existing?.updatedAt || ''));
        const rawPatchUpdatedStr =
          typeof patch.updatedAt === 'string' ? patch.updatedAt.trim() : '';
        const patchMs = Date.parse(rawPatchUpdatedStr);
        const nowIso = new Date().toISOString();

        if (Number.isFinite(existingMs) && Number.isFinite(patchMs) && existingMs > patchMs) {
          return {
            updatedRecord: existing,
            nextOverrides: current,
            purgedKeys: [],
          };
        }

        const effectiveUpdatedAt = Number.isFinite(patchMs) ? rawPatchUpdatedStr : nowIso;
        const rec = {
          ...(existing || {}),
          ...patch,
          gameId,
          updatedAt: effectiveUpdatedAt,
        };
        delete /** @type {any} */ (rec).purgeKeys;
        delete /** @type {any} */ (rec).id;

        /** @type {Record<string, Record<string, any>>} */
        const updatedMap = { ...current };
        /** @type {Set<string>} */
        const purgedSet = new Set();

        for (const pk of explicitPurgeKeys) {
          if (pk !== gameId) {
            if (Object.prototype.hasOwnProperty.call(updatedMap, pk)) {
              delete updatedMap[pk];
            }
            purgedSet.add(pk);
          }
        }

        const targetPair = extractOverrideEntitlementPair(gameId, rec);
        if (targetPair) {
          for (const [k, ov] of Object.entries(current)) {
            if (k === gameId) continue;
            const ovPair = extractOverrideEntitlementPair(k, ov);
            if (
              ovPair &&
              ovPair.platformId === targetPair.platformId &&
              ovPair.platformGameId === targetPair.platformGameId &&
              ov?.gameId !== gameId
            ) {
              delete updatedMap[k];
              purgedSet.add(k);
            }
          }
        }

        updatedMap[gameId] = rec;
        await performAtomicUserOverridesWriteAsync(hostFilePath, updatedMap, rec.updatedAt);
        return {
          updatedRecord: rec,
          nextOverrides: updatedMap,
          purgedKeys: Array.from(purgedSet),
        };
      }
    );

    if (typeof offlineVaultService.saveUserOverride === 'function') {
      try {
        offlineVaultService.saveUserOverride(gameId, updatedRecord, purgedKeys);
      } catch {}
    }

    return {
      success: true,
      gameId,
      override: updatedRecord,
      overrides: nextOverrides,
    };
  };

  const handleRemoveUserOverride = async (
    /** @type {any} */ _event,
    /** @type {unknown} */ rawArg
  ) => {
    const cleanObj =
      rawArg && typeof rawArg === 'object' && !Array.isArray(rawArg)
        ? sanitizeRendererIpcOptions(rawArg)
        : null;
    const rawId = typeof rawArg === 'string' ? rawArg : cleanObj ? cleanObj.gameId || cleanObj.id : '';
    const gameId = normalizeSafeOverrideGameId(rawId);
    if (!gameId) {
      return { success: false, error: 'Invalid or missing gameId for user override removal.' };
    }

    /** @type {Set<string>} */
    const keysToDelete = new Set();
    addOverrideKeyVariants(keysToDelete, gameId);

    /** @type {Array<{ platformId: string, platformGameId: string }>} */
    const targetPairs = [];
    const pushTargetPair = (/** @type {unknown} */ pid, /** @type {unknown} */ pgid) => {
      const norm = normalizeEntitlementPair(pid, pgid);
      if (!norm) return;
      if (
        !targetPairs.some(
          (p) => p.platformId === norm.platformId && p.platformGameId === norm.platformGameId
        )
      ) {
        targetPairs.push(norm);
      }
      addOverrideKeyVariants(keysToDelete, `${norm.platformId}:${norm.platformGameId}`);
    };

    const inferredFromGameId = extractOverrideEntitlementPair(gameId, null);
    if (inferredFromGameId && inferredFromGameId.platformId !== 'steam') {
      pushTargetPair(inferredFromGameId.platformId, inferredFromGameId.platformGameId);
    }

    /** @type {string[]} */
    const safeOrphanVaultGameIds = [];
    if (cleanObj) {
      const rawAliases = [
        ...(Array.isArray(cleanObj.aliasKeys) ? cleanObj.aliasKeys : []),
        ...(Array.isArray(cleanObj.aliases) ? cleanObj.aliases : []),
      ];
      for (const alias of rawAliases) {
        addOverrideKeyVariants(keysToDelete, alias);
      }
      if (cleanObj.platformId && cleanObj.platformGameId) {
        pushTargetPair(cleanObj.platformId, cleanObj.platformGameId);
      }
      if (Array.isArray(cleanObj.platforms)) {
        for (const p of cleanObj.platforms) {
          if (p && typeof p === 'object') {
            pushTargetPair(p.platformId, p.platformGameId);
          }
        }
      }
      if (Array.isArray(cleanObj.orphanVaultGameIds)) {
        const seenOrphans = new Set();
        for (const rawOrphan of cleanObj.orphanVaultGameIds) {
          const safeOrphan = normalizeSafeOverrideGameId(rawOrphan);
          if (safeOrphan && !seenOrphans.has(safeOrphan)) {
            seenOrphans.add(safeOrphan);
            safeOrphanVaultGameIds.push(safeOrphan);
          }
        }
      }
    }

    const matchesAnyTargetPair = (
      /** @type {{ platformId: string, platformGameId: string } | null} */ pair
    ) => {
      if (!pair) return false;
      return targetPairs.some(
        (tp) => tp.platformId === pair.platformId && tp.platformGameId === pair.platformGameId
      );
    };

    const filePath = resolveUserOverridesFilePath(offlineVaultService, userDataDir);
    const { nextOverrides, removedKeys } = await enqueueUserOverridesTask(
      filePath,
      async (hostFilePath) => {
        const current = await readUserOverridesAsync(hostFilePath);
        const updatedMap = { ...current };

        // Pass 1: discover every matching key, linked Steam App ID, and underlying entitlement pair
        for (const [k, ov] of Object.entries(current)) {
          const ovGameId = typeof ov?.gameId === 'string' ? ov.gameId.trim() : '';
          const entryPair = extractOverrideEntitlementPair(k, ov);
          if (
            keysToDelete.has(k) ||
            (ovGameId && keysToDelete.has(ovGameId)) ||
            matchesAnyTargetPair(entryPair)
          ) {
            addOverrideKeyVariants(keysToDelete, k);
            if (ovGameId) addOverrideKeyVariants(keysToDelete, ovGameId);
            if (entryPair) {
              pushTargetPair(entryPair.platformId, entryPair.platformGameId);
            }
            for (const appId of extractLinkedSteamAppIds(k, ov)) {
              const steamKey = `steam-${appId}`;
              const existingSteamOv = current[steamKey];
              const existingSteamPair = existingSteamOv
                ? extractOverrideEntitlementPair(steamKey, existingSteamOv)
                : null;
              const belongsToUnrelatedEntitlement = Boolean(
                existingSteamPair && targetPairs.length > 0 && !matchesAnyTargetPair(existingSteamPair)
              );
              if (!belongsToUnrelatedEntitlement) {
                addOverrideKeyVariants(keysToDelete, steamKey);
              }
            }
          }
        }

        // Pass 2: delete all discovered keys, linked `steam-<appId>` entries, and matching platform pairs
        /** @type {Set<string>} */
        const removedSet = new Set(keysToDelete);
        for (const [k, ov] of Object.entries(current)) {
          const ovGameId = typeof ov?.gameId === 'string' ? ov.gameId.trim() : '';
          const entryPair = extractOverrideEntitlementPair(k, ov);
          if (
            keysToDelete.has(k) ||
            (ovGameId && keysToDelete.has(ovGameId)) ||
            matchesAnyTargetPair(entryPair)
          ) {
            delete updatedMap[k];
            removedSet.add(k);
            if (ovGameId) removedSet.add(ovGameId);
          }
        }

        await performAtomicUserOverridesWriteAsync(
          hostFilePath,
          updatedMap,
          new Date().toISOString()
        );
        return {
          nextOverrides: updatedMap,
          removedKeys: Array.from(removedSet),
        };
      }
    );

    if (typeof offlineVaultService.removeUserOverride === 'function') {
      try {
        offlineVaultService.removeUserOverride(gameId, removedKeys);
      } catch {}
    }

    if (
      safeOrphanVaultGameIds.length > 0 &&
      typeof offlineVaultService.deleteGames === 'function'
    ) {
      try {
        offlineVaultService.deleteGames(safeOrphanVaultGameIds);
      } catch {}
    }

    return {
      success: true,
      gameId,
      overrides: nextOverrides,
    };
  };

  ipcMain.handle('offlineVault:get-user-overrides', handleGetUserOverrides);
  ipcMain.handle('offlineVault:save-user-override', handleSaveUserOverride);
  ipcMain.handle('offlineVault:remove-user-override', handleRemoveUserOverride);

  // Decoupled User Tag Delta Overrides (`userData/user_tag_overrides.json`)
  // NEVER calls `offlineVaultService.saveUserOverride()` — zero media-blob invalidation!
  const handleGetUserTagOverrides = async () => {
    const filePath = resolveUserTagOverridesFilePath(offlineVaultService, userDataDir);
    const hostFilePath = toHostFilesystemPath(filePath);
    const pendingWrite = userTagOverridesWriteQueue.get(hostFilePath);
    if (pendingWrite) {
      try {
        await pendingWrite;
      } catch {}
    }
    return await readUserTagOverridesAsync(filePath);
  };

  const handleSaveUserTagOverride = async (
    /** @type {any} */ _event,
    /** @type {unknown} */ arg1,
    /** @type {unknown} */ arg2
  ) => {
    try {
      const filePath = resolveUserTagOverridesFilePath(offlineVaultService, userDataDir);

      // Batch save path (used by `hydrateUserTagOverridesFromVault`)
      if (
        arg1 &&
        typeof arg1 === 'object' &&
        !Array.isArray(arg1) &&
        /** @type {any} */ (arg1).batchOverrides &&
        typeof /** @type {any} */ (arg1).batchOverrides === 'object' &&
        !Array.isArray(/** @type {any} */ (arg1).batchOverrides)
      ) {
        const cleanBatch = sanitizeRendererIpcOptions(/** @type {any} */ (arg1).batchOverrides);
        const batchResult = await enqueueUserTagOverridesTask(filePath, async (hostFilePath) => {
          const current = await readUserTagOverridesAsync(hostFilePath);
          /** @type {Record<string, SanitizedUserTagOverrideRecord>} */
          const nextOverrides = { ...current };
          const nowIso = new Date().toISOString();
          let appliedCount = 0;

          for (const [rawKey, rawPatch] of Object.entries(cleanBatch)) {
            const batchGameId = normalizeSafeOverrideGameId(rawKey);
            if (!batchGameId || !rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
              continue;
            }
            const cleanPatch = sanitizeRendererIpcOptions(rawPatch);
            const existing = nextOverrides[batchGameId];
            const existingMs = Date.parse(String(existing?.updatedAt || ''));
            const rawPatchUpdatedStr =
              typeof cleanPatch.updatedAt === 'string' ? cleanPatch.updatedAt.trim() : '';
            const patchMs = Date.parse(rawPatchUpdatedStr);

            if (Number.isFinite(existingMs) && Number.isFinite(patchMs) && existingMs > patchMs) {
              continue;
            }

            const candidateRaw = {
              gameId: batchGameId,
              addedTags: Array.isArray(cleanPatch.addedTags)
                ? cleanPatch.addedTags
                : existing?.addedTags || [],
              removedTags: Array.isArray(cleanPatch.removedTags)
                ? cleanPatch.removedTags
                : existing?.removedTags || [],
              platformAliases: Array.isArray(cleanPatch.platformAliases)
                ? cleanPatch.platformAliases
                : existing?.platformAliases,
              updatedAt: Number.isFinite(patchMs) ? rawPatchUpdatedStr : nowIso,
            };
            const sanitized = sanitizeUserTagOverrideRecord(batchGameId, candidateRaw, nowIso);
            if (!sanitized) continue;

            if (Array.isArray(cleanPatch.purgeKeys)) {
              for (const rawPk of cleanPatch.purgeKeys) {
                const pk = normalizeSafeOverrideGameId(rawPk);
                if (pk && pk !== batchGameId) {
                  delete nextOverrides[pk];
                }
              }
            }

            if (sanitized.addedTags.length === 0 && sanitized.removedTags.length === 0) {
              delete nextOverrides[batchGameId];
            } else {
              nextOverrides[batchGameId] = sanitized;
            }
            appliedCount += 1;
          }

          await performAtomicUserTagOverridesWriteAsync(hostFilePath, nextOverrides, nowIso);
          return {
            appliedCount,
            nextOverrides,
          };
        });

        return {
          success: true,
          count: batchResult.appliedCount,
          overrides: batchResult.nextOverrides,
        };
      }

      // Single save path
      let gameId = '';
      /** @type {Record<string, any>} */
      let patch = {};
      /** @type {Set<string>} */
      const explicitPurgeKeys = new Set();

      if (typeof arg1 === 'string') {
        gameId = normalizeSafeOverrideGameId(arg1);
        patch = sanitizeRendererIpcOptions(arg2);
      } else if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
        const cleanObj = sanitizeRendererIpcOptions(arg1);
        gameId = normalizeSafeOverrideGameId(cleanObj.gameId || cleanObj.id);
        if (Array.isArray(cleanObj.purgeKeys)) {
          for (const rawPk of cleanObj.purgeKeys) {
            const safePk = normalizeSafeOverrideGameId(rawPk);
            if (safePk && safePk !== gameId) explicitPurgeKeys.add(safePk);
          }
        }
        if (
          cleanObj.override &&
          typeof cleanObj.override === 'object' &&
          !Array.isArray(cleanObj.override)
        ) {
          patch = sanitizeRendererIpcOptions(cleanObj.override);
        } else {
          patch = { ...cleanObj };
        }
      }

      if (Array.isArray(patch.purgeKeys)) {
        for (const rawPk of patch.purgeKeys) {
          const safePk = normalizeSafeOverrideGameId(rawPk);
          if (safePk && safePk !== gameId) explicitPurgeKeys.add(safePk);
        }
      }

      if (!gameId) {
        return { success: false, error: 'Invalid or missing gameId for user tag override.' };
      }

      const result = await enqueueUserTagOverridesTask(filePath, async (hostFilePath) => {
        const current = await readUserTagOverridesAsync(hostFilePath);
        const existing = current[gameId];
        const existingMs = Date.parse(String(existing?.updatedAt || ''));
        const rawPatchUpdatedStr =
          typeof patch.updatedAt === 'string' ? patch.updatedAt.trim() : '';
        const patchMs = Date.parse(rawPatchUpdatedStr);
        const nowIso = new Date().toISOString();

        if (Number.isFinite(existingMs) && Number.isFinite(patchMs) && existingMs > patchMs) {
          return {
            updatedRecord: existing,
            nextOverrides: current,
          };
        }

        const effectiveUpdatedAt = Number.isFinite(patchMs) ? rawPatchUpdatedStr : nowIso;
        const sanitized = sanitizeUserTagOverrideRecord(
          gameId,
          {
            gameId,
            addedTags: Array.isArray(patch.addedTags)
              ? patch.addedTags
              : existing?.addedTags || [],
            removedTags: Array.isArray(patch.removedTags)
              ? patch.removedTags
              : existing?.removedTags || [],
            platformAliases: Array.isArray(patch.platformAliases)
              ? patch.platformAliases
              : existing?.platformAliases,
            updatedAt: effectiveUpdatedAt,
          },
          nowIso
        );

        if (!sanitized) {
          return {
            updatedRecord: undefined,
            nextOverrides: current,
          };
        }

        /** @type {Record<string, SanitizedUserTagOverrideRecord>} */
        const updatedMap = { ...current };
        for (const pk of explicitPurgeKeys) {
          if (pk !== gameId) {
            delete updatedMap[pk];
          }
        }

        if (sanitized.addedTags.length === 0 && sanitized.removedTags.length === 0) {
          delete updatedMap[gameId];
          await performAtomicUserTagOverridesWriteAsync(hostFilePath, updatedMap, effectiveUpdatedAt);
          return {
            updatedRecord: undefined,
            nextOverrides: updatedMap,
          };
        }

        updatedMap[gameId] = sanitized;
        await performAtomicUserTagOverridesWriteAsync(hostFilePath, updatedMap, sanitized.updatedAt);
        return {
          updatedRecord: sanitized,
          nextOverrides: updatedMap,
        };
      });

      return {
        success: true,
        gameId,
        ...(result.updatedRecord ? { override: result.updatedRecord } : {}),
        overrides: result.nextOverrides,
      };
    } catch (err) {
      return {
        success: false,
        error:
          err && typeof err === 'object' && 'message' in err
            ? String(/** @type {any} */ (err).message)
            : 'Failed to save user tag override.',
      };
    }
  };

  const handleRemoveUserTagOverride = async (
    /** @type {any} */ _event,
    /** @type {unknown} */ rawArg
  ) => {
    try {
      const cleanObj =
        rawArg && typeof rawArg === 'object' && !Array.isArray(rawArg)
          ? sanitizeRendererIpcOptions(rawArg)
          : null;
      const rawId =
        typeof rawArg === 'string' ? rawArg : cleanObj ? cleanObj.gameId || cleanObj.id : '';
      const gameId = normalizeSafeOverrideGameId(rawId);
      if (!gameId) {
        return { success: false, error: 'Invalid or missing gameId for user tag override removal.' };
      }

      /** @type {Set<string>} */
      const keysToDelete = new Set([gameId]);
      if (cleanObj) {
        const rawExtraKeys = [
          ...(Array.isArray(cleanObj.aliasKeys) ? cleanObj.aliasKeys : []),
          ...(Array.isArray(cleanObj.aliases) ? cleanObj.aliases : []),
        ];
        for (const k of rawExtraKeys) {
          const safe = normalizeSafeOverrideGameId(k);
          if (safe) keysToDelete.add(safe);
        }
      }

      const filePath = resolveUserTagOverridesFilePath(offlineVaultService, userDataDir);
      const nextOverrides = await enqueueUserTagOverridesTask(filePath, async (hostFilePath) => {
        const current = await readUserTagOverridesAsync(hostFilePath);
        const updatedMap = { ...current };
        let changed = false;
        for (const key of keysToDelete) {
          if (Object.prototype.hasOwnProperty.call(updatedMap, key)) {
            delete updatedMap[key];
            changed = true;
          }
        }
        if (changed) {
          await performAtomicUserTagOverridesWriteAsync(
            hostFilePath,
            updatedMap,
            new Date().toISOString()
          );
        }
        return updatedMap;
      });

      return {
        success: true,
        gameId,
        overrides: nextOverrides,
      };
    } catch (err) {
      return {
        success: false,
        error:
          err && typeof err === 'object' && 'message' in err
            ? String(/** @type {any} */ (err).message)
            : 'Failed to remove user tag override.',
      };
    }
  };

  ipcMain.handle('offlineVault:get-user-tag-overrides', handleGetUserTagOverrides);
  ipcMain.handle('offlineVault:save-user-tag-override', handleSaveUserTagOverride);
  ipcMain.handle('offlineVault:remove-user-tag-override', handleRemoveUserTagOverride);

  return {
    dispose: () => {
      unsubHealth();
      unsubHydrated();
      unsubProgress();
    },
  };
}

module.exports = {
  registerOfflineVaultIpcHandlers,
  createOlMediaProtocolHandler,
  readUserOverridesFromDisk,
  readUserOverridesAsync,
  writeUserOverridesToDiskAsync,
  readUserTagOverridesFromDisk,
  readUserTagOverridesAsync,
  writeUserTagOverridesToDiskAsync,
  sanitizeUserTagOverrideRecord,
};
