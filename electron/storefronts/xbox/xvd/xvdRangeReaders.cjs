// @ts-check
'use strict';

const fs = require('node:fs');
const { isAllowedHttpsHost } = require('../../../launcher/securityAndPathUtils.cjs');

/**
 * Trusted Microsoft Delivery Optimization / Xbox MSIXVC CDN domain suffixes permitted over strict
 * `https:` (port 443 only). Matches exact domain or dot-separated subdomains.
 */
const ALLOWED_XVD_CDN_HOSTS = Object.freeze([
  'xboxlive.com',
  'delivery.mp.microsoft.com',
  'windowsupdate.com',
  'msecnd.net',
  'microsoft.com',
  'akamaized.net',
]);

/**
 * Exact Microsoft Delivery Optimization / XVCF CDN hosts that legitimately serve MSIXVC/FE3
 * payloads over plaintext `http:` (port 80 only) in real Windows/Xbox Delivery Optimization.
 */
const ALLOWED_XVD_HTTP_EXACT_HOSTS = new Set([
  'assets1.xboxlive.com',
  'assets2.xboxlive.com',
  'dlassets.xboxlive.com',
  'dlassets2.xboxlive.com',
  'xvcf1.xboxlive.com',
  'xvcf2.xboxlive.com',
  'dl.delivery.mp.microsoft.com',
  'download.windowsupdate.com',
]);

/**
 * Dot-separated Microsoft Delivery Optimization host suffixes permitted over plaintext `http:`
 * (port 80 only) for real FE3 / Windows Update package delivery URLs.
 */
const ALLOWED_XVD_HTTP_HOST_SUFFIXES = Object.freeze([
  '.dl.delivery.mp.microsoft.com',
  '.download.windowsupdate.com',
]);

const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Strips query strings (including Azure SAS / Delivery Optimization tokens) and fragments
 * before logging, throwing errors, or returning reader stats.
 *
 * @param {unknown} rawUrl
 * @returns {string}
 */
function redactUrlForLog(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return '<empty-url>';
  try {
    const parsed = new URL(s);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return s.split(/[?#]/)[0].slice(0, 160) || '<malformed-url>';
  }
}

/**
 * @param {string} message
 * @returns {Error & { code: string, isSsrfBlocked: boolean }}
 */
function createBlockedUrlError(message) {
  const err = /** @type {Error & { code: string, isSsrfBlocked: boolean }} */ (new Error(message));
  err.code = 'ERR_SSRF_BLOCKED';
  err.isSsrfBlocked = true;
  return err;
}

/**
 * Checks whether a parsed hostname refers to local loopback (`127.0.0.1`, `localhost`, `::1`).
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isLoopbackHostname(hostname) {
  const host = String(hostname || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Checks whether a hostname is an official Microsoft Delivery Optimization / XVCF CDN host
 * permitted over plaintext `http:` (port 80 only).
 *
 * @param {string} host
 * @returns {boolean}
 */
function isAllowedDeliveryOptimizationHttpHost(host) {
  if (!host) return false;
  if (ALLOWED_XVD_HTTP_EXACT_HOSTS.has(host)) return true;
  return ALLOWED_XVD_HTTP_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Strips sensitive authentication headers (`Authorization`, `Cookie`, `Proxy-Authorization`)
 * from outbound CDN Range requests so credentials are never leaked to CDN nodes or redirects.
 *
 * @param {Record<string, string> | null | undefined} extraHeaders
 * @returns {Record<string, string>}
 */
function sanitizeCdnRequestHeaders(extraHeaders) {
  /** @type {Record<string, string>} */
  const clean = {};
  if (!extraHeaders || typeof extraHeaders !== 'object') return clean;
  for (const [k, v] of Object.entries(extraHeaders)) {
    const lower = String(k).toLowerCase().trim();
    if (
      !lower ||
      lower === 'authorization' ||
      lower === 'proxy-authorization' ||
      lower === 'cookie' ||
      lower === 'range'
    ) {
      continue;
    }
    if (v !== undefined && v !== null) {
      clean[k] = String(v);
    }
  }
  return clean;
}

/**
 * Validates an XVD / FE3 HTTP Range URL against the strict Microsoft Delivery Optimization &
 * Xbox CDN allowlist:
 *   - `https:` (port 443 only) on `ALLOWED_XVD_CDN_HOSTS` (`*.xboxlive.com`,
 *     `*.delivery.mp.microsoft.com`, `*.windowsupdate.com`, `*.msecnd.net`,
 *     `*.microsoft.com`, `*.akamaized.net`).
 *   - `http:` (port 80 only) STRICTLY on official Microsoft Delivery Optimization / XVCF CDN
 *     hosts (`assets1/2.xboxlive.com`, `dlassets/2.xboxlive.com`, `xvcf1/2.xboxlive.com`,
 *     `*.dl.delivery.mp.microsoft.com`, `*.download.windowsupdate.com`).
 *   - Rejects all other hosts, non-standard ports, embedded credentials, control chars, and
 *     private/loopback IPs in production.
 *   - Loopback (`127.0.0.1` / `localhost` / `::1`) is permitted ONLY when explicitly opted in
 *     via `options.allowLocalhost === true` OR inside Vitest/test runtimes (`VITEST` /
 *     `NODE_ENV === 'test'`) unless `options.allowLocalhost === false`.
 *
 * @param {unknown} rawUrl
 * @param {{
 *   allowedHosts?: Iterable<string>,
 *   allowLocalhost?: boolean,
 * }} [options]
 * @returns {string}
 */
function validateXvdCdnUrl(rawUrl, options = {}) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim() || /[\x00-\x1f\x7f]/.test(rawUrl)) {
    throw createBlockedUrlError('Blocked empty or malformed XVD/FE3 URL');
  }
  const trimmed = rawUrl.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw createBlockedUrlError(`Blocked unparseable XVD/FE3 URL: ${redactUrlForLog(trimmed)}`);
  }

  if (parsed.username || parsed.password) {
    throw createBlockedUrlError(
      `Blocked XVD/FE3 URL with embedded credentials: ${redactUrlForLog(trimmed)}`
    );
  }

  const host = String(parsed.hostname || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');

  const isTestRuntime = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
  const loopbackPermitted =
    options.allowLocalhost === true || (options.allowLocalhost !== false && isTestRuntime);

  if (isLoopbackHostname(host)) {
    if (!loopbackPermitted) {
      throw createBlockedUrlError(
        `Blocked loopback XVD/FE3 URL in production: ${redactUrlForLog(trimmed)}`
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw createBlockedUrlError(
        `Blocked non-HTTP(S) loopback XVD URL protocol "${parsed.protocol}"`
      );
    }
    return parsed.toString();
  }

  const allowedHosts = options.allowedHosts || ALLOWED_XVD_CDN_HOSTS;

  if (parsed.protocol === 'https:') {
    if (!isAllowedHttpsHost(trimmed, allowedHosts)) {
      throw createBlockedUrlError(
        `Blocked untrusted XVD/FE3 CDN host or port: ${redactUrlForLog(trimmed)}`
      );
    }
    return parsed.toString();
  }

  if (parsed.protocol === 'http:') {
    const port = String(parsed.port || '');
    if ((port === '' || port === '80') && isAllowedDeliveryOptimizationHttpHost(host)) {
      return parsed.toString();
    }
    throw createBlockedUrlError(
      `Blocked untrusted plaintext HTTP XVD/FE3 URL: ${redactUrlForLog(trimmed)}`
    );
  }

  throw createBlockedUrlError(
    `Blocked disallowed XVD/FE3 URL protocol "${parsed.protocol}": ${redactUrlForLog(trimmed)}`
  );
}

/**
 * @param {Buffer} buffer
 */
function createBufferRangeReader(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('createBufferRangeReader expects a Buffer');
  }
  let bytesRead = 0;
  let requests = 0;
  return {
    async getTotalSize() {
      return buffer.length;
    },
    /**
     * @param {number} offset
     * @param {number} length
     * @param {AbortSignal} [signal]
     */
    async readRange(offset, length, signal) {
      if (signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      const start = Math.max(0, Number(offset));
      const len = Math.max(0, Number(length));
      if (len === 0 || start >= buffer.length) return Buffer.alloc(0);
      const slice = Buffer.from(buffer.subarray(start, Math.min(buffer.length, start + len)));
      bytesRead += slice.length;
      requests += 1;
      return slice;
    },
    getStats() {
      return { bytesRead, requests, totalSize: buffer.length };
    },
  };
}

/**
 * @param {string} filePath
 */
function createFileRangeReader(filePath) {
  /** @type {Promise<fs.promises.FileHandle> | null} */
  let fdPromise = null;
  /** @type {number | null} */
  let cachedSize = null;
  let bytesRead = 0;
  let requests = 0;

  async function ensureHandle() {
    if (!fdPromise) {
      fdPromise = fs.promises.open(filePath, 'r');
    }
    return fdPromise;
  }

  return {
    async getTotalSize() {
      if (cachedSize === null) {
        const handle = await ensureHandle();
        const st = await handle.stat();
        cachedSize = st.size;
      }
      return cachedSize;
    },
    /**
     * @param {number} offset
     * @param {number} length
     * @param {AbortSignal} [signal]
     */
    async readRange(offset, length, signal) {
      if (signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      const len = Math.max(0, Number(length));
      if (len === 0) return Buffer.alloc(0);
      const handle = await ensureHandle();
      const total = await this.getTotalSize();
      const start = Math.max(0, Number(offset));
      if (start >= total) return Buffer.alloc(0);
      const toRead = Math.min(len, total - start);
      const out = Buffer.allocUnsafe(toRead);
      let filled = 0;
      while (filled < toRead) {
        const { bytesRead: n } = await handle.read(out, filled, toRead - filled, start + filled);
        if (n <= 0) break;
        filled += n;
      }
      bytesRead += filled;
      requests += 1;
      return filled === toRead ? out : out.subarray(0, filled);
    },
    async close() {
      if (fdPromise) {
        const h = await fdPromise.catch(() => null);
        fdPromise = null;
        if (h) await h.close().catch(() => {});
      }
    },
    getStats() {
      return { bytesRead, requests, totalSize: cachedSize };
    },
  };
}

/**
 * @param {Record<string, any>} [params]
 * @returns {string[]}
 */
function resolveCandidateUrls({ urls, cdnRootPaths, fileName } = {}) {
  /** @type {string[]} */
  const resolved = [];
  if (Array.isArray(urls)) {
    for (const u of urls) {
      if (typeof u === 'string' && u.trim()) resolved.push(u.trim());
    }
  }
  if (Array.isArray(cdnRootPaths)) {
    for (const root of cdnRootPaths) {
      if (typeof root !== 'string' || !root.trim()) continue;
      const trimmed = root.trim();
      if (fileName) {
        resolved.push(`${trimmed.replace(/\/+$/, '')}/${String(fileName).replace(/^\/+/, '')}`);
      } else {
        resolved.push(trimmed);
      }
    }
  }
  return Array.from(new Set(resolved));
}

/**
 * @param {string | null | undefined} headerVal
 * @returns {number | null}
 */
function parseContentRangeTotal(headerVal) {
  if (!headerVal) return null;
  const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(String(headerVal));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Executes a single bounded HTTP `Range` request, enforcing:
 *   1. Strict Microsoft Delivery Optimization / Xbox CDN host allowlist + manual redirect
 *      validation (re-validating every `3xx` `Location` hop against the allowlist!).
 *   2. Stripping `Authorization` / `Cookie` headers on CDN requests and query-redacted error logging.
 *   3. HTTP `206` (or `200` ONLY within `maxAllowed200Bytes` <= 16 MiB), immediately
 *      cancelling/aborting unexpected multi-GB `200 OK` bodies BEFORE OOM buffering (`D4.4`).
 *
 * @param {string} targetUrl
 * @param {number} startByte
 * @param {number} endInclusive
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   headers?: Record<string, string>,
 *   userAgent?: string,
 *   timeoutMs?: number,
 *   maxHttp200Bytes?: number,
 *   maxRedirects?: number,
 *   allowedHosts?: Iterable<string>,
 *   allowLocalhost?: boolean,
 *   signal?: AbortSignal,
 * }} [options]
 */
async function fetchRange(targetUrl, startByte, endInclusive, options = {}) {
  const fetchFn = options.fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('Global fetch is unavailable for fetchRange');
  }

  const validationOpts = {
    allowedHosts: options.allowedHosts,
    ...(typeof options.allowLocalhost === 'boolean'
      ? { allowLocalhost: options.allowLocalhost }
      : {}),
  };

  let currentUrl = validateXvdCdnUrl(targetUrl, validationOpts);

  const start = Math.max(0, Math.floor(Number(startByte)));
  const end = Math.max(start, Math.floor(Number(endInclusive)));
  const expectedBytes = Math.max(1, end - start + 1);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30_000;
  const maxRedirects = Number.isInteger(options.maxRedirects)
    ? Math.max(0, Math.min(10, Number(options.maxRedirects)))
    : DEFAULT_MAX_REDIRECTS;
  const safeExtraHeaders = sanitizeCdnRequestHeaders(options.headers);
  const signal = options.signal;

  const MAX_HTTP_200_FULL_BODY_BYTES = 16 * 1024 * 1024;
  const MIN_HTTP_200_SMALL_BODY_BYTES = 256 * 1024;
  const maxAllowed200Bytes =
    Number(options.maxHttp200Bytes) > 0
      ? Math.min(MAX_HTTP_200_FULL_BODY_BYTES, Math.floor(Number(options.maxHttp200Bytes)))
      : Math.min(
          MAX_HTTP_200_FULL_BODY_BYTES,
          Math.max(MIN_HTTP_200_SMALL_BODY_BYTES, expectedBytes * 2, start + expectedBytes)
        );

  if (signal?.aborted) {
    const abortErr = new Error('Operation aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(new Error('HTTP Range timeout')), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  const onOuterAbort = () => timeoutCtrl.abort(signal?.reason || new Error('Aborted'));
  if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });

  /** @param {any} resp */
  const cancelBody = async (resp) => {
    try {
      if (resp?.body && typeof resp.body.cancel === 'function') {
        await resp.body.cancel();
      }
    } catch {
      // Ignore stream cancellation error
    }
  };

  try {
    /** @type {any} */
    let resp = null;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      currentUrl = validateXvdCdnUrl(currentUrl, validationOpts);
      resp = await fetchFn(currentUrl, {
        method: 'GET',
        headers: {
          'User-Agent': options.userAgent || 'Microsoft-Delivery-Optimization/10.0',
          ...safeExtraHeaders,
          Range: `bytes=${start}-${end}`,
        },
        redirect: 'manual',
        signal: timeoutCtrl.signal,
      });

      const status = Number(resp?.status || 0);
      if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
        const locationHeader = resp?.headers?.get?.('location') || '';
        await cancelBody(resp);
        if (!locationHeader || !String(locationHeader).trim()) {
          throw createBlockedUrlError(
            `Blocked XVD redirect (${status}) missing Location header from ${redactUrlForLog(currentUrl)}`
          );
        }
        if (hop >= maxRedirects) {
          throw createBlockedUrlError(
            `Blocked XVD redirect chain exceeding ${maxRedirects} hops from ${redactUrlForLog(currentUrl)}`
          );
        }
        let nextUrl;
        try {
          nextUrl = new URL(String(locationHeader).trim(), currentUrl).toString();
        } catch {
          throw createBlockedUrlError(
            `Blocked malformed XVD redirect Location URL from ${redactUrlForLog(currentUrl)}`
          );
        }
        currentUrl = validateXvdCdnUrl(nextUrl, validationOpts);
        continue;
      }
      break;
    }

    if (!resp) {
      throw new Error(`HTTP Range request failed for ${redactUrlForLog(currentUrl)}`);
    }

    if (resp.status === 416) {
      await cancelBody(resp);
      const crTotal = parseContentRangeTotal(resp.headers?.get?.('content-range'));
      return { status: 416, buffer: Buffer.alloc(0), totalSize: crTotal };
    }

    if (resp.status !== 206 && resp.status !== 200) {
      await cancelBody(resp);
      throw new Error(
        `HTTP ${resp.status} reading Range ${start}-${end} from ${redactUrlForLog(currentUrl)}`
      );
    }

    const rawContentLength = resp.headers?.get?.('content-length');
    const parsedContentLength =
      rawContentLength !== null &&
      rawContentLength !== undefined &&
      String(rawContentLength).trim() !== ''
        ? Number(rawContentLength)
        : NaN;

    if (resp.status === 200) {
      if (
        start + expectedBytes > MAX_HTTP_200_FULL_BODY_BYTES ||
        (Number.isFinite(parsedContentLength) &&
          (parsedContentLength < 0 || parsedContentLength > maxAllowed200Bytes))
      ) {
        await cancelBody(resp);
        timeoutCtrl.abort(new Error('Aborted unexpected full-body HTTP 200 response'));
        throw new Error(
          `Aborted unexpected HTTP 200 full-body response (Content-Length=${rawContentLength ?? 'missing'}) for Range bytes=${start}-${end}`
        );
      }
    } else if (
      Number.isFinite(parsedContentLength) &&
      parsedContentLength > Math.max(expectedBytes * 2, expectedBytes + 65536)
    ) {
      await cancelBody(resp);
      timeoutCtrl.abort(new Error('Aborted oversized HTTP 206 Range response'));
      throw new Error(
        `Aborted oversized HTTP 206 response (Content-Length=${parsedContentLength}) for Range bytes=${start}-${end}`
      );
    }

    let resolvedTotalSize = parseContentRangeTotal(resp.headers?.get?.('content-range'));
    if (resolvedTotalSize === null && resp.status === 200 && parsedContentLength > 0) {
      resolvedTotalSize = parsedContentLength;
    }

    if (resp.status === 200 && !Number.isFinite(parsedContentLength)) {
      /** @type {Buffer} */
      let buf;
      if (!resp.body || typeof resp.body.getReader !== 'function') {
        buf = Buffer.alloc(0);
      } else {
        const reader = resp.body.getReader();
        /** @type {Buffer[]} */
        const chunks = [];
        let accumulatedBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          accumulatedBytes += value.byteLength;
          if (accumulatedBytes > maxAllowed200Bytes) {
            await reader.cancel().catch(() => {});
            timeoutCtrl.abort(new Error('Aborted oversized chunked HTTP 200 response'));
            throw new Error(
              `Aborted oversized chunked HTTP 200 response (> ${maxAllowed200Bytes} bytes) for Range bytes=${start}-${end}`
            );
          }
          chunks.push(
            Buffer.isBuffer(value)
              ? value
              : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          );
        }
        buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, accumulatedBytes);
      }
      if (resolvedTotalSize === null && buf.length > 0) {
        resolvedTotalSize = buf.length;
      }
      if (start >= buf.length) {
        buf = Buffer.alloc(0);
      } else if (start > 0 || buf.length > expectedBytes) {
        buf = Buffer.from(buf.subarray(start, Math.min(buf.length, start + expectedBytes)));
      }
      return { status: resp.status, buffer: buf, totalSize: resolvedTotalSize };
    }

    const ab = await resp.arrayBuffer();
    let buf = Buffer.from(ab);
    if (resp.status === 200 && buf.length > maxAllowed200Bytes) {
      throw new Error(
        `Rejected oversized buffered HTTP 200 response (${buf.length} bytes) for Range bytes=${start}-${end}`
      );
    }
    if (resp.status === 200) {
      if (start >= buf.length) {
        buf = Buffer.alloc(0);
      } else if (start > 0 || buf.length > expectedBytes) {
        buf = Buffer.from(buf.subarray(start, Math.min(buf.length, start + expectedBytes)));
      }
    }
    return { status: resp.status, buffer: buf, totalSize: resolvedTotalSize };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * @param {Record<string, any>} [options]
 */
function createHttpRangeReader(options = {}) {
  const rawCandidates = resolveCandidateUrls(options);
  if (rawCandidates.length === 0) {
    throw new Error('createHttpRangeReader requires at least one URL or cdnRootPath');
  }
  const fetchFn = options.fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('Global fetch is unavailable for createHttpRangeReader');
  }

  const validationOpts = {
    allowedHosts: options.allowedHosts,
    ...(typeof options.allowLocalhost === 'boolean'
      ? { allowLocalhost: options.allowLocalhost }
      : {}),
  };

  // Validate every candidate endpoint upfront so untrusted/non-allowlisted URLs fail closed immediately
  const candidates = rawCandidates.map((u) => validateXvdCdnUrl(u, validationOpts));

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30_000;
  const maxRetries = Number.isInteger(options.maxRetries)
    ? options.maxRetries
    : Math.max(3, candidates.length * 2);
  const extraHeaders = sanitizeCdnRequestHeaders(options.headers);

  let preferredIndex = 0;
  /** @type {number | null} */
  let totalSize =
    Number.isFinite(options.totalSize) && options.totalSize > 0 ? Number(options.totalSize) : null;
  let bytesRead = 0;
  let requests = 0;

  return {
    getCandidateUrls() {
      return candidates.slice();
    },
    /**
     * @param {AbortSignal} [signal]
     */
    async getTotalSize(signal) {
      if (totalSize !== null) return totalSize;
      await this.readRange(0, 16, signal);
      return totalSize;
    },
    /**
     * @param {number} offset
     * @param {number} length
     * @param {AbortSignal} [signal]
     */
    async readRange(offset, length, signal) {
      const start = Math.max(0, Math.floor(Number(offset)));
      const len = Math.max(0, Math.floor(Number(length)));
      if (len === 0) return Buffer.alloc(0);
      if (totalSize !== null && start >= totalSize) return Buffer.alloc(0);
      const endInclusive =
        totalSize !== null ? Math.min(totalSize - 1, start + len - 1) : start + len - 1;

      let lastErr = null;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (signal?.aborted) {
          const abortErr = new Error('Operation aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        const urlIdx = (preferredIndex + attempt) % candidates.length;
        const targetUrl = candidates[urlIdx];

        try {
          const res = await fetchRange(targetUrl, start, endInclusive, {
            fetchImpl: fetchFn,
            headers: extraHeaders,
            userAgent: options.userAgent,
            timeoutMs,
            maxRedirects: options.maxRedirects,
            allowedHosts: options.allowedHosts,
            ...(typeof options.allowLocalhost === 'boolean'
              ? { allowLocalhost: options.allowLocalhost }
              : {}),
            signal,
          });
          if (res.totalSize !== null && res.totalSize !== undefined) {
            totalSize = res.totalSize;
          }
          if (res.status === 416) {
            return Buffer.alloc(0);
          }
          preferredIndex = urlIdx;
          bytesRead += res.buffer.length;
          requests += 1;
          return res.buffer;
        } catch (err) {
          lastErr = err;
          if (signal?.aborted) {
            const abortErr = new Error('Operation aborted');
            abortErr.name = 'AbortError';
            throw abortErr;
          }
          if (/** @type {any} */ (err)?.isSsrfBlocked) {
            throw err;
          }
          if (attempt < maxRetries) {
            const backoffMs = Math.min(1500, 80 * Math.pow(2, Math.min(attempt, 4)));
            await new Promise((r) => setTimeout(r, backoffMs));
          }
        }
      }
      throw lastErr || new Error('Failed HTTP Range read across all CDN endpoints');
    },
    getStats() {
      return {
        bytesRead,
        requests,
        totalSize,
        preferredUrl: redactUrlForLog(candidates[preferredIndex]),
      };
    },
  };
}

/**
 * Awaits a shared in-flight promise while respecting an individual caller's `AbortSignal`
 * without cancelling sibling callers waiting on the same block.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal | undefined} signal
 * @param {() => void} onWaiterReleased
 * @returns {Promise<T>}
 */
function raceSharedPromiseWithSignal(promise, signal, onWaiterReleased) {
  let released = false;
  const releaseOnce = () => {
    if (!released) {
      released = true;
      onWaiterReleased();
    }
  };

  if (!signal) {
    return promise.finally(releaseOnce);
  }
  if (signal.aborted) {
    releaseOnce();
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      releaseOnce();
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        releaseOnce();
        resolve(val);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        releaseOnce();
        reject(err);
      }
    );
  });
}

/**
 * Wraps any rangeReader with a fixed-budget LRU block cache (default 4 MiB, 128 KiB blocks)
 * and in-flight block coalescing so concurrent reads for the same block share a single fetch.
 *
 * @param {any} innerReader
 * @param {{ blockSize?: number, maxCacheBytes?: number }} [options]
 */
function createLruBlockRangeReader(innerReader, options = {}) {
  const blockSize = Number(options.blockSize) > 0 ? Number(options.blockSize) : 128 * 1024;
  const maxCacheBytes =
    Number(options.maxCacheBytes) > 0 ? Number(options.maxCacheBytes) : 4 * 1024 * 1024;
  const maxBlocks = Math.max(4, Math.floor(maxCacheBytes / blockSize));
  /** @type {Map<number, Buffer>} */
  const cache = new Map();
  /** @type {Map<number, { promise: Promise<Buffer>, controller: AbortController, waiters: number }>} */
  const inFlight = new Map();
  let cacheGeneration = 0;

  /**
   * @param {number} blockIndex
   * @param {AbortSignal} [signal]
   * @returns {Promise<Buffer>}
   */
  async function getBlock(blockIndex, signal) {
    if (signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }

    const cached = cache.get(blockIndex);
    if (cached) {
      cache.delete(blockIndex);
      cache.set(blockIndex, cached);
      return cached;
    }

    let flight = inFlight.get(blockIndex);
    if (!flight) {
      const generationAtStart = cacheGeneration;
      const controller = new AbortController();
      /** @type {{ promise: Promise<Buffer>, controller: AbortController, waiters: number }} */
      const newFlight = {
        promise: Promise.resolve(Buffer.alloc(0)),
        controller,
        waiters: 0,
      };
      newFlight.promise = Promise.resolve()
        .then(() => innerReader.readRange(blockIndex * blockSize, blockSize, controller.signal))
        .then((block) => {
          if (generationAtStart === cacheGeneration) {
            cache.set(blockIndex, block);
            while (cache.size > maxBlocks) {
              const oldestKey = cache.keys().next().value;
              if (oldestKey === undefined) break;
              cache.delete(oldestKey);
            }
          }
          return block;
        })
        .finally(() => {
          if (inFlight.get(blockIndex) === newFlight) {
            inFlight.delete(blockIndex);
          }
        });
      // Prevent unhandled rejection if all waiters abort before inner promise rejects
      newFlight.promise.catch(() => {});
      inFlight.set(blockIndex, newFlight);
      flight = newFlight;
    }

    const activeFlight = flight;
    activeFlight.waiters += 1;
    return raceSharedPromiseWithSignal(activeFlight.promise, signal, () => {
      activeFlight.waiters -= 1;
      if (activeFlight.waiters <= 0 && inFlight.get(blockIndex) === activeFlight) {
        activeFlight.controller.abort();
      }
    });
  }

  return {
    /**
     * @param {AbortSignal} [signal]
     */
    async getTotalSize(signal) {
      return typeof innerReader.getTotalSize === 'function'
        ? innerReader.getTotalSize(signal)
        : null;
    },
    /**
     * @param {number} offset
     * @param {number} length
     * @param {AbortSignal} [signal]
     */
    async readRange(offset, length, signal) {
      const start = Math.max(0, Math.floor(Number(offset)));
      const len = Math.max(0, Math.floor(Number(length)));
      if (len === 0) return Buffer.alloc(0);

      // Large sequential reads bypass block cache to avoid thrashing
      if (len > blockSize * 4) {
        return innerReader.readRange(start, len, signal);
      }

      const firstBlock = Math.floor(start / blockSize);
      const lastBlock = Math.floor((start + len - 1) / blockSize);
      /** @type {Buffer[]} */
      const parts = [];
      let totalCopied = 0;

      for (let b = firstBlock; b <= lastBlock; b += 1) {
        const blk = await getBlock(b, signal);
        if (blk.length === 0) break;
        const blkStart = b * blockSize;
        const sliceStart = Math.max(0, start - blkStart);
        const sliceEnd = Math.min(blk.length, start + len - blkStart);
        if (sliceEnd > sliceStart) {
          const sub = blk.subarray(sliceStart, sliceEnd);
          parts.push(sub);
          totalCopied += sub.length;
        }
        if (blk.length < blockSize) break;
      }

      return parts.length === 1 ? Buffer.from(parts[0]) : Buffer.concat(parts, totalCopied);
    },
    clearCache() {
      cacheGeneration += 1;
      cache.clear();
    },
  };
}

module.exports = {
  ALLOWED_XVD_CDN_HOSTS,
  ALLOWED_XVD_HTTP_EXACT_HOSTS,
  ALLOWED_XVD_HTTP_HOST_SUFFIXES,
  redactUrlForLog,
  sanitizeCdnRequestHeaders,
  validateXvdCdnUrl,
  resolveCandidateUrls,
  parseContentRangeTotal,
  fetchRange,
  createBufferRangeReader,
  createFileRangeReader,
  createHttpRangeReader,
  createLruBlockRangeReader,
};
