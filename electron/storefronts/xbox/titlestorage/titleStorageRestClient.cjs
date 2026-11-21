// @ts-check
'use strict';

const fs = require('node:fs');

const { toHostFilesystemPath } = require('../../../launcher/securityAndPathUtils.cjs');
const {
  parseAndValidateXuidBigInt,
  validateTitleStorageScid,
  generateUpperGuidHex,
  formatDashedUpperUuid,
  encodeTitleStorageContainerPath,
} = require('./wgsBinaryFormat.cjs');

const LARGE_ATOM_THRESHOLD_BYTES = 4 * 1024 * 1024; // 4 MiB
const DEFAULT_TITLE_STORAGE_ORIGIN = 'https://titlestorage.xboxlive.com';
const DEFAULT_TITLE_STORAGE_TIMEOUT_MS = 25_000;
const MAX_LIST_CONTAINERS_PAGES = 100;

const ALLOWED_BLOB_URI_HOST_SUFFIXES = [
  '.xboxlive.com',
  '.blob.core.windows.net',
  '.msecnd.net',
];

const ALLOWED_BLOB_URI_EXACT_HOSTS = new Set([
  'xboxlive.com',
  'blob.core.windows.net',
  'msecnd.net',
]);

const ALLOWED_TITLE_STORAGE_ORIGIN_EXACT_HOSTS = new Set(['xboxlive.com']);
const ALLOWED_TITLE_STORAGE_ORIGIN_HOST_SUFFIXES = ['.xboxlive.com'];
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * @param {AbortSignal | undefined} outerSignal
 * @param {number} [timeoutMs]
 * @returns {AbortSignal}
 */
function createTitleStorageFetchSignal(outerSignal, timeoutMs = DEFAULT_TITLE_STORAGE_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (outerSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([outerSignal, timeoutSignal]);
  }
  return outerSignal || timeoutSignal;
}

/**
 * Validates the TitleStorage service origin against allowlisted `https:` Xbox Live hosts.
 * In test environments (`VITEST` / `NODE_ENV=test`) or when explicitly authorized, loopback
 * test servers (`http(s)://127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`) and
 * mock-fetch synthetic `https://*.mock.local` origins are also permitted.
 *
 * @param {string | undefined} rawOrigin
 * @param {{ hasCustomFetchImpl?: boolean, allowLoopbackOrigin?: boolean }} [options]
 * @returns {{ origin: string, allowedLoopbackOrigin: string }}
 */
function validateTitleStorageOrigin(rawOrigin, options = {}) {
  const str = String(rawOrigin || DEFAULT_TITLE_STORAGE_ORIGIN).trim();
  if (!str) {
    throw new Error('Rejected empty TitleStorage origin');
  }
  let parsed;
  try {
    parsed = new URL(str);
  } catch {
    throw new Error(`Rejected malformed TitleStorage origin: "${str.slice(0, 120)}"`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Rejected TitleStorage origin containing embedded credentials');
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const isTestEnv = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');

  if (
    parsed.protocol === 'https:' &&
    (ALLOWED_TITLE_STORAGE_ORIGIN_EXACT_HOSTS.has(host) ||
      ALLOWED_TITLE_STORAGE_ORIGIN_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)))
  ) {
    return { origin: parsed.origin, allowedLoopbackOrigin: '' };
  }

  if (
    (isTestEnv || options.allowLoopbackOrigin === true) &&
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    LOOPBACK_HOSTS.has(host) &&
    parsed.port
  ) {
    return { origin: parsed.origin, allowedLoopbackOrigin: parsed.origin };
  }

  if (
    isTestEnv &&
    options.hasCustomFetchImpl === true &&
    parsed.protocol === 'https:' &&
    host.endsWith('.mock.local')
  ) {
    return { origin: parsed.origin, allowedLoopbackOrigin: '' };
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Rejected non-HTTPS TitleStorage origin protocol "${parsed.protocol}" (expected https:)`
    );
  }
  throw new Error(`Rejected untrusted TitleStorage origin host "${host}"`);
}

/**
 * Validates Connected Storage `blobUri` URLs against `https:` and Microsoft/Xbox CDN/Blob hosts
 * (`*.xboxlive.com`, `*.blob.core.windows.net`, `*.msecnd.net`) to prevent SSRF / token exfiltration.
 * When a caller explicitly configures a loopback `allowedLoopbackOrigin` (`http://127.0.0.1:<port>`
 * or `http://localhost:<port>`) for local testing, exact same-origin URLs on that loopback server
 * are permitted while all other hosts/ports/protocols remain blocked.
 *
 * @param {string} rawBlobUri
 * @param {{ allowedLoopbackOrigin?: string }} [options]
 * @returns {string}
 */
function validateTitleStorageBlobUri(rawBlobUri, options = {}) {
  const str = String(rawBlobUri || '').trim();
  if (!str) {
    throw new Error('Rejected empty TitleStorage blobUri');
  }
  let parsed;
  try {
    parsed = new URL(str);
  } catch {
    throw new Error(`Rejected malformed TitleStorage blobUri: "${str.slice(0, 120)}"`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Rejected TitleStorage blobUri containing embedded credentials');
  }
  if (options && options.allowedLoopbackOrigin && parsed.origin === options.allowedLoopbackOrigin) {
    return parsed.toString();
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Rejected non-HTTPS TitleStorage blobUri protocol "${parsed.protocol}" (expected https:)`
    );
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const hostAllowed =
    ALLOWED_BLOB_URI_EXACT_HOSTS.has(host) ||
    ALLOWED_BLOB_URI_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (!hostAllowed) {
    throw new Error(`Rejected untrusted TitleStorage blobUri host "${host}"`);
  }
  return parsed.toString();
}

/**
 * @param {any} rawItem
 */
function normalizeRemoteContainerItem(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') return null;
  let name = String(rawItem.fileName || rawItem.name || '');
  if (/,savedgame$/i.test(name)) {
    name = name.replace(/,savedgame$/i, '');
  }
  if (!name) return null;
  return {
    name,
    displayName: String(rawItem.displayName || name),
    clientFileTime: String(rawItem.clientFileTime || ''),
    etag: String(rawItem.etag || ''),
    size: Number(rawItem.size || 0),
  };
}

/**
 * @param {any} containerJson
 * @param {{ allowedLoopbackOrigin?: string }} [options]
 * @returns {Map<string, string>}
 */
function parseRemoteAtomsMap(containerJson, options = {}) {
  const validateOpts = options.allowedLoopbackOrigin
    ? { allowedLoopbackOrigin: options.allowedLoopbackOrigin }
    : undefined;
  const out = new Map();
  const atoms = containerJson?.atoms;
  if (Array.isArray(atoms)) {
    for (const item of atoms) {
      if (!item || !item.name) continue;
      if (item.blobUri) {
        out.set(String(item.name), validateTitleStorageBlobUri(item.blobUri, validateOpts));
      } else if (item.atom) {
        const atomStr = String(item.atom);
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(atomStr)) {
          out.set(String(item.name), validateTitleStorageBlobUri(atomStr, validateOpts));
        } else {
          out.set(String(item.name), /,binary$/i.test(atomStr) ? atomStr : `${atomStr},binary`);
        }
      }
    }
  } else if (atoms && typeof atoms === 'object') {
    for (const [blobName, atomVal] of Object.entries(atoms)) {
      if (!atomVal) continue;
      if (typeof atomVal === 'object' && atomVal.blobUri) {
        out.set(blobName, validateTitleStorageBlobUri(atomVal.blobUri, validateOpts));
      } else {
        const atomStr = String(atomVal);
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(atomStr)) {
          out.set(blobName, validateTitleStorageBlobUri(atomStr, validateOpts));
        } else {
          out.set(blobName, /,binary$/i.test(atomStr) ? atomStr : `${atomStr},binary`);
        }
      }
    }
  }
  return out;
}

/**
 * @param {string} message
 * @param {any} res
 */
function createTitleStorageHttpError(message, res) {
  let errJson = null;
  try {
    errJson = res.json();
  } catch {
    errJson = null;
  }
  const detail = errJson?.description || errJson?.message || '';
  /** @type {Error & { status?: number, xblCode?: any }} */
  const err = new Error(detail ? `${message} (${detail})` : message);
  err.status = res.status;
  if (errJson && (errJson.code !== undefined || errJson.errorCode !== undefined)) {
    const rawCode = errJson.code !== undefined ? errJson.code : errJson.errorCode;
    const numCode = Number(rawCode);
    err.xblCode = Number.isNaN(numCode) ? rawCode : numCode;
  }
  return err;
}

/**
 * Creates a Connected Storage REST v107 client bound to a validated user XUID, SCID,
 * allowlisted origin, PFN, and `authProvider`.
 *
 * @param {Record<string, any>} [options]
 */
function createTitleStorageClient(options = {}) {
  const {
    xuid,
    scid,
    msaAppId = '',
    titleId = '',
    authProvider,
    authorizationHeader,
    fetchImpl = globalThis.fetch,
    friendlyName = 'OneLauncher',
  } = options;
  const packageFamilyName = options.packageFamilyName || options.pfn || '';
  const rawOrigin =
    options.titleStorageOrigin || options.baseUrl || options.origin || DEFAULT_TITLE_STORAGE_ORIGIN;

  if (!xuid || !scid) {
    throw new Error('createTitleStorageClient requires both xuid and scid');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable for createTitleStorageClient');
  }

  // Strictly validate XUID & SCID before URL construction
  const validatedXuidBig = parseAndValidateXuidBigInt(xuid);
  const cleanXuid = validatedXuidBig.toString(10);
  const cleanScid = validateTitleStorageScid(scid);

  const hasCustomFetchImpl =
    typeof options.fetchImpl === 'function' && options.fetchImpl !== globalThis.fetch;
  const { origin: validatedOrigin, allowedLoopbackOrigin } = validateTitleStorageOrigin(
    rawOrigin,
    {
      hasCustomFetchImpl,
      allowLoopbackOrigin: options.allowLoopbackOrigin === true,
    }
  );

  const baseUrl = `${validatedOrigin}/connectedstorage/users/xuid(${encodeURIComponent(cleanXuid)})/scids/${encodeURIComponent(cleanScid)}`;

  /**
   * @param {string} method
   * @param {string} subPath
   * @param {{ headers?: Record<string, string>, body?: any, signal?: AbortSignal }} [reqOpts]
   */
  async function signedRequest(method, subPath, { headers = {}, body = null, signal } = {}) {
    const url = subPath
      ? `${baseUrl}${subPath.startsWith('/') ? subPath : `/${subPath}`}`
      : baseUrl;
    /** @type {Record<string, string>} */
    const reqHeaders = {
      'x-xbl-contract-version': '107',
      ...(packageFamilyName ? { 'x-xbl-pfn': packageFamilyName } : {}),
      Connection: 'Keep-Alive',
      ...headers,
    };

    const hasBody = body !== null && body !== undefined;
    const bodyBuffer = !hasBody
      ? Buffer.alloc(0)
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');

    if (authProvider && typeof authProvider.getTokenAndSignatureForUrl === 'function') {
      const auth = await authProvider.getTokenAndSignatureForUrl({
        method,
        url,
        headers: reqHeaders,
        body: bodyBuffer,
        bodyBuffer,
        msaAppId,
        titleId,
      });
      const authTok = auth?.token || auth?.authorization;
      if (authTok) reqHeaders.Authorization = authTok;
      if (auth?.signature) reqHeaders.Signature = auth.signature;
    } else if (authorizationHeader) {
      reqHeaders.Authorization = authorizationHeader;
    }

    const resp = await fetchImpl(url, {
      method,
      headers: reqHeaders,
      body: hasBody ? bodyBuffer : undefined,
      redirect: 'error',
      signal: createTitleStorageFetchSignal(signal),
    });

    const ab = await resp.arrayBuffer();
    const respBuf = Buffer.from(ab);
    return {
      status: resp.status,
      ok: resp.status >= 200 && resp.status < 300,
      headers: resp.headers,
      buffer: respBuf,
      json() {
        return respBuf.length > 0 ? JSON.parse(respBuf.toString('utf8')) : {};
      },
    };
  }

  return {
    baseUrl,
    /** @param {AbortSignal} [signal] */
    async acquireLock(signal) {
      const res = await signedRequest(
        'PUT',
        `/lock?friendlyName=${encodeURIComponent(friendlyName)}`,
        {
          headers: {
            'x-xbl-lock-ver': '1',
            'Content-Type': 'application/json',
          },
          signal,
        }
      );
      if (!res.ok) {
        throw createTitleStorageHttpError(`TitleStorage lock failed with HTTP ${res.status}`, res);
      }
      const data = res.json();
      const ownerChangeId = data.ownerChangeId || data.ownerChangedId || '';
      const quotaRaw = data.quotaBytes ?? data.quotaInfo?.quotaBytes;
      return {
        locked: true,
        quotaBytes: Number(quotaRaw || 256 * 1024 * 1024),
        ownerChangeId,
        ownerChangedId: ownerChangeId,
      };
    },

    /**
     * @param {boolean} [newSavesUploaded]
     * @param {AbortSignal} [signal]
     */
    async releaseLock(newSavesUploaded = false, signal) {
      await signedRequest(
        'DELETE',
        `/lock?newSavesUploaded=${newSavesUploaded ? 'true' : 'false'}`,
        { signal }
      ).catch(() => {});
    },

    /** @param {AbortSignal} [signal] */
    async listContainers(signal) {
      const all = [];
      let continuationToken = '';
      const seenCursors = new Set();

      for (let page = 0; page < MAX_LIST_CONTAINERS_PAGES; page += 1) {
        const query = continuationToken
          ? `?continuationToken=${encodeURIComponent(continuationToken)}`
          : '';
        const res = await signedRequest('GET', query, {
          headers: { Accept: 'application/json' },
          signal,
        });
        if (res.status === 404) return [];
        if (!res.ok) {
          throw createTitleStorageHttpError(
            `TitleStorage listContainers failed with HTTP ${res.status}`,
            res
          );
        }
        const payload = res.json();
        const rawBlobs = Array.isArray(payload?.blobs) ? payload.blobs : [];
        for (const raw of rawBlobs) {
          const item = normalizeRemoteContainerItem(raw);
          if (item) all.push(item);
        }
        const nextToken = String(payload?.pagingInfo?.continuationToken || '').trim();
        if (!nextToken || seenCursors.has(nextToken)) {
          break;
        }
        seenCursors.add(nextToken);
        continuationToken = nextToken;
      }

      return all;
    },

    /**
     * @param {string} containerName
     * @param {AbortSignal} [signal]
     */
    async getContainerAtoms(containerName, signal) {
      const enc = encodeTitleStorageContainerPath(containerName);
      let res = await signedRequest('GET', `/${enc},savedgame`, {
        headers: { Accept: 'application/json' },
        signal,
      });
      if (res.status === 404) {
        res = await signedRequest('GET', `/savedgames/${enc}`, {
          headers: { Accept: 'application/json' },
          signal,
        });
      }
      if (!res.ok) {
        throw createTitleStorageHttpError(
          `TitleStorage getContainerAtoms(${containerName}) failed with HTTP ${res.status}`,
          res
        );
      }
      return parseRemoteAtomsMap(res.json(), { allowedLoopbackOrigin });
    },

    /**
     * @param {string} atomId
     * @param {AbortSignal} [signal]
     */
    async downloadAtom(atomId, signal) {
      const rawAtomStr = String(atomId || '').trim();
      /** @param {string} candidateBlobUri */
      const fetchValidatedBlobUri = async (candidateBlobUri) => {
        const safeBlobUri = validateTitleStorageBlobUri(candidateBlobUri, {
          allowedLoopbackOrigin,
        });
        const blobRes = await fetchImpl(safeBlobUri, {
          method: 'GET',
          redirect: 'manual',
          signal: createTitleStorageFetchSignal(signal),
        });
        if (blobRes.status >= 300 && blobRes.status < 400) {
          const loc = blobRes.headers?.get?.('location') || '';
          const safeRedirect = validateTitleStorageBlobUri(loc, {
            allowedLoopbackOrigin,
          });
          const redirRes = await fetchImpl(safeRedirect, {
            method: 'GET',
            redirect: 'error',
            signal: createTitleStorageFetchSignal(signal),
          });
          if (redirRes.status < 200 || redirRes.status >= 300) {
            throw new Error(`TitleStorage blobUri redirect GET failed with HTTP ${redirRes.status}`);
          }
          return Buffer.from(await redirRes.arrayBuffer());
        }
        if (blobRes.status < 200 || blobRes.status >= 300) {
          throw new Error(`TitleStorage blobUri GET failed with HTTP ${blobRes.status}`);
        }
        return Buffer.from(await blobRes.arrayBuffer());
      };

      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawAtomStr)) {
        return fetchValidatedBlobUri(rawAtomStr);
      }

      const cleanAtom = /,binary$/i.test(rawAtomStr) ? rawAtomStr : `${rawAtomStr},binary`;
      const res = await signedRequest('GET', `/${cleanAtom}`, { signal });
      if (!res.ok) {
        throw createTitleStorageHttpError(
          `TitleStorage downloadAtom(${cleanAtom}) failed with HTTP ${res.status}`,
          res
        );
      }

      const ct = String(res.headers?.get?.('content-type') || '').toLowerCase();
      if (ct.includes('application/json') && res.buffer.length > 0 && res.buffer.length <= 4096) {
        let maybeObj = null;
        try {
          maybeObj = res.json();
        } catch {
          maybeObj = null;
        }
        if (maybeObj && typeof maybeObj.blobUri === 'string' && maybeObj.blobUri) {
          return fetchValidatedBlobUri(maybeObj.blobUri);
        }
      }

      return res.buffer;
    },

    /**
     * Uploads a save atom (either an in-memory `Buffer` or a lazy `{ filePath, size }` source
     * whose > 4 MiB blocks are read incrementally 4 MiB at a time from disk).
     *
     * @param {Buffer | string | { filePath: string, size?: number }} dataOrSource
     * @param {AbortSignal} [signal]
     */
    async uploadAtom(dataOrSource, signal) {
      const uuid36 = formatDashedUpperUuid(generateUpperGuidHex());
      const atomToken = `${uuid36},binary`;

      const fileSourceObj =
        !Buffer.isBuffer(dataOrSource) &&
        dataOrSource &&
        typeof dataOrSource === 'object' &&
        typeof dataOrSource.filePath === 'string' &&
        dataOrSource.filePath.length > 0
          ? dataOrSource
          : null;
      const isFileSource = Boolean(fileSourceObj);
      const hostSourcePath = fileSourceObj ? toHostFilesystemPath(fileSourceObj.filePath) : '';
      /** @type {Buffer | null} */
      const directSourceBuf = isFileSource
        ? null
        : Buffer.isBuffer(dataOrSource)
          ? dataOrSource
          : Buffer.from(typeof dataOrSource === 'string' ? dataOrSource : '', 'utf8');

      let totalLength = 0;
      if (fileSourceObj) {
        if (typeof fileSourceObj.size === 'number' && fileSourceObj.size >= 0) {
          totalLength = fileSourceObj.size;
        } else {
          const st = await fs.promises.stat(hostSourcePath);
          totalLength = st.size;
        }
      } else {
        totalLength = directSourceBuf ? directSourceBuf.length : 0;
      }

      if (totalLength <= LARGE_ATOM_THRESHOLD_BYTES) {
        const payloadBuf = isFileSource
          ? await fs.promises.readFile(hostSourcePath)
          : directSourceBuf || Buffer.alloc(0);
        const res = await signedRequest('PUT', `/${atomToken}`, {
          headers: { 'Content-Type': 'application/octet-stream' },
          body: payloadBuf,
          signal,
        });
        if (!res.ok) {
          throw createTitleStorageHttpError(
            `TitleStorage direct atom PUT failed with HTTP ${res.status}`,
            res
          );
        }
        return atomToken;
      }

      // Large (> 4 MiB) block upload flow: POST /atoms/<uuid> -> PUT Azure blocks -> POST ?commit=true
      const allocRes = await signedRequest('POST', `/atoms/${uuid36}`, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ size: totalLength }),
        signal,
      });
      if (!allocRes.ok) {
        throw createTitleStorageHttpError(
          `TitleStorage large atom allocation failed with HTTP ${allocRes.status}`,
          allocRes
        );
      }
      const { blobUri } = allocRes.json();
      if (!blobUri) {
        throw new Error('TitleStorage large atom allocation omitted blobUri');
      }
      const safeBlobUri = validateTitleStorageBlobUri(blobUri, {
        allowedLoopbackOrigin,
      });

      const blockCount = Math.ceil(totalLength / LARGE_ATOM_THRESHOLD_BYTES);
      const blockIds = [];
      let srcFh = null;
      try {
        if (isFileSource) {
          srcFh = await fs.promises.open(hostSourcePath, 'r');
        }
        const sourceBuf = directSourceBuf;

        for (let i = 0; i < blockCount; i += 1) {
          const blockId = Buffer.from(String(i).padStart(8, '0'), 'ascii').toString('base64');
          blockIds.push(blockId);
          const blockOffset = i * LARGE_ATOM_THRESHOLD_BYTES;
          const blockLen = Math.min(LARGE_ATOM_THRESHOLD_BYTES, totalLength - blockOffset);

          let slice;
          if (srcFh) {
            const blockBuf = Buffer.allocUnsafe(blockLen);
            let filled = 0;
            while (filled < blockLen) {
              const { bytesRead } = await srcFh.read(
                blockBuf,
                filled,
                blockLen - filled,
                blockOffset + filled
              );
              if (bytesRead <= 0) break;
              filled += bytesRead;
            }
            slice = filled === blockLen ? blockBuf : blockBuf.subarray(0, filled);
          } else if (sourceBuf) {
            slice = sourceBuf.subarray(blockOffset, blockOffset + blockLen);
          } else {
            slice = Buffer.alloc(0);
          }

          const sep = safeBlobUri.includes('?') ? '&' : '?';
          const blockUrl = `${safeBlobUri}${sep}comp=block&blockid=${encodeURIComponent(blockId)}`;
          const putRes = await fetchImpl(blockUrl, {
            method: 'PUT',
            headers: {
              'x-ms-version': '2015-04-05',
              'Content-Length': String(slice.length),
            },
            body: slice,
            redirect: 'error',
            signal: createTitleStorageFetchSignal(signal),
          });
          if (putRes.status < 200 || putRes.status >= 300) {
            throw new Error(`Azure block upload ${i} failed with HTTP ${putRes.status}`);
          }
        }
      } finally {
        if (srcFh) {
          await srcFh.close().catch(() => {});
        }
      }

      const commitRes = await signedRequest('POST', `/atoms/${uuid36}?commit=true`, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ blockIds, size: totalLength }),
        signal,
      });
      if (!commitRes.ok) {
        throw createTitleStorageHttpError(
          `TitleStorage large atom commit failed with HTTP ${commitRes.status}`,
          commitRes
        );
      }
      return atomToken;
    },

    /**
     * @param {string} containerName
     * @param {{ displayName?: string, clientFileTime?: string, atomsObject: Record<string, string> }} manifest
     * @param {AbortSignal} [signal]
     */
    async putContainerManifest(containerName, { displayName, clientFileTime, atomsObject }, signal) {
      const encName = encodeTitleStorageContainerPath(containerName);
      const encDisplay = encodeURIComponent(displayName || containerName);
      const iso = clientFileTime || new Date().toISOString();
      const res = await signedRequest(
        'PUT',
        `/${encName},savedgame?clientFileTime=${encodeURIComponent(iso)}&displayName=${encDisplay}`,
        {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ atoms: atomsObject }),
          signal,
        }
      );
      if (!res.ok) {
        throw createTitleStorageHttpError(
          `TitleStorage putContainerManifest(${containerName}) failed with HTTP ${res.status}`,
          res
        );
      }
      return { clientFileTime: iso };
    },

    /**
     * @param {string} containerName
     * @param {AbortSignal} [signal]
     */
    async deleteContainer(containerName, signal) {
      const encName = encodeTitleStorageContainerPath(containerName);
      const res = await signedRequest('DELETE', `/${encName},savedgame`, { signal });
      if (!res.ok && res.status !== 404) {
        throw createTitleStorageHttpError(
          `TitleStorage deleteContainer(${containerName}) failed with HTTP ${res.status}`,
          res
        );
      }
    },
  };
}

module.exports = {
  LARGE_ATOM_THRESHOLD_BYTES,
  DEFAULT_TITLE_STORAGE_ORIGIN,
  DEFAULT_TITLE_STORAGE_TIMEOUT_MS,
  MAX_LIST_CONTAINERS_PAGES,
  createTitleStorageFetchSignal,
  validateTitleStorageOrigin,
  validateTitleStorageBlobUri,
  normalizeRemoteContainerItem,
  parseRemoteAtomsMap,
  createTitleStorageHttpError,
  createTitleStorageClient,
};
