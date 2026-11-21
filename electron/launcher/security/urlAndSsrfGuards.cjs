// @ts-check
'use strict';

const net = require('node:net');
const dns = require('node:dns');

const DEFAULT_FALLBACK_CHROME_VERSION = '134.0.0.0';
const POSITIVE_DNS_SAFETY_CACHE_TTL_MS = 5_000;
const POSITIVE_DNS_SAFETY_CACHE_MAX_HOSTS = 256;
const DEFAULT_ALLOWED_HTTPS_PORTS = new Set(['', '443']);

/** @type {Map<string, { addresses: string[], expiresAt: number }>} */
const positiveDnsSafetyCache = new Map();

/**
 * Derive a single canonical desktop Chrome User-Agent string from the host Electron/Chromium
 * runtime (`process.versions.chrome`) so all Electron HTTP fetchers stay synchronized.
 *
 * @param {{ platform?: string, chromeVersion?: string }} [options]
 * @returns {string}
 */
function getCanonicalChromeUserAgent(options = {}) {
  const platform = options.platform || process.platform;
  const rawChrome =
    typeof options.chromeVersion === 'string' && options.chromeVersion.trim()
      ? options.chromeVersion.trim()
      : typeof process.versions?.chrome === 'string' && process.versions.chrome.trim()
        ? process.versions.chrome.trim()
        : DEFAULT_FALLBACK_CHROME_VERSION;
  const safeChromeVersion = /^\d+(?:\.\d+){1,3}$/.test(rawChrome)
    ? rawChrome
    : DEFAULT_FALLBACK_CHROME_VERSION;

  const osToken =
    platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : platform === 'linux'
        ? 'X11; Linux x86_64'
        : 'Macintosh; Intel Mac OS X 10_15_7';

  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${safeChromeVersion} Safari/537.36`;
}

/**
 * Build an explicit allowed-port Set from `options.allowedPorts` (defaulting to HTTPS `443` only).
 * Note: Node's WHATWG `URL.port` normalizes `:443` on `https:` to `''` and `:80` on `http:` to `''`.
 *
 * @param {Iterable<string | number> | undefined} allowedPorts
 * @returns {Set<string>}
 */
function resolveAllowedPortSet(allowedPorts) {
  if (!allowedPorts || typeof allowedPorts[Symbol.iterator] !== 'function') {
    return DEFAULT_ALLOWED_HTTPS_PORTS;
  }
  /** @type {Set<string>} */
  const set = new Set();
  for (const p of allowedPorts) {
    const clean = String(p ?? '').trim();
    if (!clean) {
      set.add('');
    } else if (/^\d{1,5}$/.test(clean)) {
      const n = Number(clean);
      if (n >= 1 && n <= 65535) {
        set.add(String(n));
        if (n === 443) set.add('');
      }
    }
  }
  return set.size > 0 ? set : DEFAULT_ALLOWED_HTTPS_PORTS;
}

/**
 * Validate that `urlStr` is a strict `https:` URL on an allowlisted port (default `443` only)
 * whose parsed hostname equals or is a dot-separated subdomain of an entry in `allowedHosts`.
 *
 * @param {unknown} urlStr
 * @param {Iterable<string>} allowedHosts
 * @param {{ allowedPorts?: Iterable<string | number> }} [options]
 * @returns {boolean}
 */
function isAllowedHttpsHost(urlStr, allowedHosts, options = {}) {
  if (typeof urlStr !== 'string' || !urlStr.trim() || /[\x00-\x1f\x7f]/.test(urlStr)) {
    return false;
  }
  if (!allowedHosts || typeof allowedHosts[Symbol.iterator] !== 'function') {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(urlStr.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') {
    return false;
  }
  if (parsed.username || parsed.password) {
    return false;
  }
  const allowedPorts = resolveAllowedPortSet(options?.allowedPorts);
  const port = String(parsed.port || '');
  if (!allowedPorts.has(port)) {
    return false;
  }

  const host = String(parsed.hostname || '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host) {
    return false;
  }

  for (const rawAllowed of allowedHosts) {
    if (typeof rawAllowed !== 'string') continue;
    const allowed = rawAllowed
      .trim()
      .toLowerCase()
      .replace(/^\*\./, '')
      .replace(/\.$/, '');
    if (!allowed) continue;
    if (host === allowed || host.endsWith(`.${allowed}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Expand a valid IPv6 address into eight 16-bit unsigned integer groups.
 * @param {string} ipv6
 * @returns {number[] | null}
 */
function parseIpv6Groups(ipv6) {
  let addr = ipv6.toLowerCase();
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const v4Part = addr.slice(lastColon + 1);
    if (net.isIP(v4Part) !== 4) return null;
    const octets = v4Part.split('.').map((n) => Number(n));
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const dblParts = addr.split('::');
  if (dblParts.length > 2) return null;

  const left = dblParts[0] ? dblParts[0].split(':') : [];
  const right = dblParts.length === 2 && dblParts[1] ? dblParts[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if ((dblParts.length === 1 && missing !== 0) || (dblParts.length === 2 && missing < 1)) {
    return null;
  }

  const full = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (full.length !== 8) return null;

  /** @type {number[]} */
  const groups = [];
  for (const part of full) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}

/**
 * Check whether an IPv4 or IPv6 literal falls in loopback, private, link-local, unspecified,
 * CGNAT, multicast, documentation, or IPv4-mapped private/loopback space.
 *
 * @param {unknown} ip
 * @returns {boolean}
 */
function isPrivateOrLoopbackIp(ip) {
  if (typeof ip !== 'string' || !ip.trim()) return false;
  const clean = ip
    .trim()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
    .trim();
  if (!clean) return false;

  const mappedDottedMatch = clean.match(/^(?:::ffff:|0{1,4}(?::0{1,4}){4}:ffff:)(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedDottedMatch && mappedDottedMatch[1] && net.isIP(mappedDottedMatch[1]) === 4) {
    return isPrivateOrLoopbackIp(mappedDottedMatch[1]);
  }

  const family = net.isIP(clean);
  if (family === 4) {
    const [a, b, c] = clean.split('.').map((x) => Number(x));
    if (a === 0) return true; // 0.0.0.0/8 unspecified
    if (a === 10) return true; // 10.0.0.0/8 RFC1918
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
    if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast
    return false;
  }

  if (family === 6) {
    const g = parseIpv6Groups(clean);
    if (!g) return true;
    const allZeroPrefix5 = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
    if (allZeroPrefix5 && g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) {
      return true;
    }
    if (allZeroPrefix5 && g[5] === 0xffff) {
      const embeddedV4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
      return isPrivateOrLoopbackIp(embeddedV4);
    }
    if (allZeroPrefix5 && g[5] === 0) {
      const embeddedV4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
      return isPrivateOrLoopbackIp(embeddedV4);
    }
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      const embeddedV4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
      return isPrivateOrLoopbackIp(embeddedV4);
    }
    if ((g[0] & 0xfe00) === 0xfc00) return true;
    if ((g[0] & 0xffc0) === 0xfe80) return true;
    if ((g[0] & 0xffc0) === 0xfec0) return true;
    if ((g[0] & 0xff00) === 0xff00) return true;
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
    return false;
  }

  return false;
}

/**
 * Create a structured SSRF rejection Error.
 * @param {string} message
 * @param {{ isDnsUnavailable?: boolean }} [flags]
 */
function createUnsafeUrlError(message, flags = {}) {
  const err = /** @type {Error & { code?: string, isSsrfBlocked?: boolean, isDnsUnavailable?: boolean }} */ (
    new Error(message)
  );
  err.code = flags.isDnsUnavailable ? 'ERR_DNS_UNAVAILABLE' : 'ERR_SSRF_BLOCKED';
  err.isSsrfBlocked = !flags.isDnsUnavailable;
  err.isDnsUnavailable = Boolean(flags.isDnsUnavailable);
  return err;
}

/**
 * Clear the bounded positive DNS-safety cache (primarily for deterministic testing).
 */
function clearPublicDnsSafetyCache() {
  positiveDnsSafetyCache.clear();
}

/**
 * Synchronous zero-DNS lexical validator for public `https:` URLs (`< 0.01ms`).
 * Enforces `https:` protocol, explicit port allowlist (`443` by default), rejects embedded
 * credentials, control characters, empty/local/single-label/numeric-TLD hostnames, and
 * private/loopback/link-local/CGNAT/metadata IP literals.
 *
 * @param {unknown} urlStr
 * @param {{ allowedPorts?: Iterable<string | number> }} [options]
 * @returns {{ url: string, hostname: string, isIpLiteral: boolean }}
 */
function assertSafePublicHttpsUrlSyntax(urlStr, options = {}) {
  if (typeof urlStr !== 'string' || !urlStr.trim() || /[\x00-\x1f\x7f]/.test(urlStr)) {
    throw createUnsafeUrlError('Blocked empty or malformed URL');
  }
  let parsed;
  try {
    parsed = new URL(urlStr.trim());
  } catch {
    throw createUnsafeUrlError('Blocked unparseable URL');
  }

  if (parsed.protocol !== 'https:') {
    throw createUnsafeUrlError(`Blocked non-HTTPS protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw createUnsafeUrlError('Blocked URL containing embedded credentials');
  }
  const allowedPorts = resolveAllowedPortSet(options?.allowedPorts);
  const port = String(parsed.port || '');
  if (!allowedPorts.has(port)) {
    throw createUnsafeUrlError(`Blocked disallowed HTTPS port: ${port}`);
  }

  const host = String(parsed.hostname || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  const ipFamily = net.isIP(host);
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa') ||
    (ipFamily === 0 && !host.includes('.'))
  ) {
    throw createUnsafeUrlError(`Blocked local hostname: ${host || '<empty>'}`);
  }

  if (ipFamily !== 0) {
    if (isPrivateOrLoopbackIp(host)) {
      throw createUnsafeUrlError(`Blocked private or loopback IP literal: ${host}`);
    }
    return { url: parsed.toString(), hostname: host, isIpLiteral: true };
  }

  const labels = host.split('.');
  const tld = labels[labels.length - 1] || '';
  if (labels.some((label) => !label) || /^\d+$/.test(tld)) {
    throw createUnsafeUrlError(`Blocked non-public or malformed hostname: ${host}`);
  }

  return { url: parsed.toString(), hostname: host, isIpLiteral: false };
}

/**
 * Validate that `urlStr` is a public `https:` URL on an allowlisted port whose literal IP or
 * `dns.promises.lookup(..., { all: true })` resolution contains ZERO private, loopback,
 * link-local, or unspecified addresses.
 *
 * @param {unknown} urlStr
 * @param {{
 *   dnsLookup?: (hostname: string, opts: { all: true }) => Promise<Array<{ address: string }>>,
 *   skipDnsForReservedTestTld?: boolean,
 *   allowedPorts?: Iterable<string | number>,
 * }} [options]
 * @returns {Promise<{ url: string, hostname: string, addresses: string[] }>}
 */
async function assertSafePublicHttpsUrl(urlStr, options = {}) {
  const syntax = assertSafePublicHttpsUrlSyntax(urlStr, options);
  const host = syntax.hostname;

  if (syntax.isIpLiteral) {
    return { url: syntax.url, hostname: host, addresses: [host] };
  }

  const hasCustomDnsLookup = typeof options.dnsLookup === 'function';

  if (
    options.skipDnsForReservedTestTld === true &&
    !hasCustomDnsLookup &&
    (host.endsWith('.test') || host.endsWith('.example'))
  ) {
    return { url: syntax.url, hostname: host, addresses: [] };
  }

  if (!hasCustomDnsLookup) {
    const cached = positiveDnsSafetyCache.get(host);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        positiveDnsSafetyCache.delete(host);
        positiveDnsSafetyCache.set(host, cached);
        return { url: syntax.url, hostname: host, addresses: [...cached.addresses] };
      }
      positiveDnsSafetyCache.delete(host);
    }
  }

  const lookupFn = hasCustomDnsLookup ? /** @type {Function} */ (options.dnsLookup) : dns.promises.lookup;

  let records;
  try {
    records = await lookupFn(host, { all: true });
  } catch (dnsErr) {
    const code = String(/** @type {any} */ (dnsErr)?.code || '').toUpperCase();
    const isOfflineDnsCode =
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' ||
      code === 'EAI_NONAME' ||
      code === 'ENODATA' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNREFUSED' ||
      code === 'ESERVFAIL';
    throw createUnsafeUrlError(`DNS lookup failed for ${host}`, {
      isDnsUnavailable: isOfflineDnsCode,
    });
  }

  const recordList = Array.isArray(records) ? records : records ? [records] : [];
  if (recordList.length === 0) {
    throw createUnsafeUrlError(`DNS lookup returned no addresses for ${host}`, {
      isDnsUnavailable: true,
    });
  }

  /** @type {string[]} */
  const addresses = [];
  for (const entry of recordList) {
    const addr = typeof entry === 'string' ? entry : String(entry?.address || '').trim();
    if (!addr || net.isIP(addr.replace(/^\[|\]$/g, '').split('%')[0]) === 0) {
      throw createUnsafeUrlError(`Invalid DNS address record for ${host}`);
    }
    if (isPrivateOrLoopbackIp(addr)) {
      throw createUnsafeUrlError(`Blocked DNS resolution to private/loopback IP for ${host}`);
    }
    addresses.push(addr);
  }

  if (!hasCustomDnsLookup) {
    if (positiveDnsSafetyCache.has(host)) {
      positiveDnsSafetyCache.delete(host);
    }
    while (positiveDnsSafetyCache.size >= POSITIVE_DNS_SAFETY_CACHE_MAX_HOSTS) {
      const oldestHost = positiveDnsSafetyCache.keys().next().value;
      if (oldestHost === undefined) break;
      positiveDnsSafetyCache.delete(oldestHost);
    }
    positiveDnsSafetyCache.set(host, {
      addresses: [...addresses],
      expiresAt: Date.now() + POSITIVE_DNS_SAFETY_CACHE_TTL_MS,
    });
  }

  return { url: syntax.url, hostname: host, addresses };
}

/**
 * Safely cancel an unread/rejected Fetch Response body stream so Undici sockets never leak.
 *
 * @param {any} res
 */
async function cancelResponseBodySafely(res) {
  try {
    if (res && res.body && typeof res.body.cancel === 'function') {
      await res.body.cancel();
    }
  } catch {}
}

/**
 * Read a Fetch `Response` body into a `Buffer` with a hard byte ceiling enforced
 * incrementally on Web Streams (`res.body.getReader()`) and deterministic stream cancellation
 * on oversized or aborted reads.
 *
 * @param {any} res
 * @param {number} maxFetchBytes
 * @returns {Promise<Buffer>}
 */
async function readSafeResponseBuffer(res, maxFetchBytes) {
  const limit = Number.isFinite(maxFetchBytes) && maxFetchBytes > 0 ? maxFetchBytes : 25 * 1024 * 1024;
  const contentLengthRaw =
    res?.headers && typeof res.headers.get === 'function'
      ? res.headers.get('content-length')
      : undefined;
  if (contentLengthRaw !== null && contentLengthRaw !== undefined && String(contentLengthRaw).trim() !== '') {
    const contentLen = Number(contentLengthRaw);
    if (Number.isFinite(contentLen) && contentLen > limit) {
      await cancelResponseBodySafely(res);
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`Response Content-Length (${contentLen}) exceeds limit (${limit})`)
      );
      err.code = 'ERR_RESPONSE_TOO_LARGE';
      throw err;
    }
  }

  if (res?.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    let streamCancelled = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const buf = Buffer.isBuffer(value)
          ? value
          : ArrayBuffer.isView(value)
            ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
            : Buffer.from(value);
        total += buf.length;
        if (total > limit) {
          streamCancelled = true;
          try {
            await reader.cancel();
          } catch {}
          const err = /** @type {Error & { code?: string }} */ (
            new Error(`Streamed response size (${total}) exceeds limit (${limit})`)
          );
          err.code = 'ERR_RESPONSE_TOO_LARGE';
          throw err;
        }
        chunks.push(buf);
      }
    } catch (readErr) {
      if (!streamCancelled) {
        try {
          await reader.cancel();
        } catch {}
      }
      throw readErr;
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
  }

  if (typeof res?.arrayBuffer === 'function') {
    const ab = await res.arrayBuffer();
    const byteLen = ab ? ab.byteLength : 0;
    if (byteLen > limit) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`Response ArrayBuffer size (${byteLen}) exceeds limit (${limit})`)
      );
      err.code = 'ERR_RESPONSE_TOO_LARGE';
      throw err;
    }
    return Buffer.from(ab);
  }

  return Buffer.alloc(0);
}

/**
 * SSRF-hardened outbound `https:` fetcher that:
 *   1. Validates the initial URL and every `3xx` `Location` redirect hop (up to `maxRedirects`)
 *      through `assertSafePublicHttpsUrl` (including port allowlist) using `redirect: 'manual'`.
 *   2. Optionally reads the body through `readSafeResponseBuffer` (`maxFetchBytes` hard cap)
 *      and cancels unread/rejected/aborted response streams to prevent Undici socket leaks.
 *   3. Preserves `options.fetchImpl` and `options.dnsLookup` DI compatibility for hermetic tests.
 *
 * @param {string} rawUrl
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   dnsLookup?: (hostname: string, opts: { all: true }) => Promise<Array<{ address: string }>>,
 *   method?: string,
 *   headers?: Record<string, string>,
 *   signal?: AbortSignal | null,
 *   timeoutMs?: number,
 *   maxRedirects?: number,
 *   maxFetchBytes?: number,
 *   readBody?: boolean,
 *   keepErrorBody?: boolean,
 *   allowedPorts?: Iterable<string | number>,
 *   allowDnsUnavailableForCustomFetch?: boolean,
 * }} [options]
 * @returns {Promise<{ response: any, finalUrl: string, buffer: Buffer | null }>}
 */
async function safePublicHttpsFetch(rawUrl, options = {}) {
  const hasExplicitFetchImpl = typeof options.fetchImpl === 'function' && options.fetchImpl !== fetch;
  const fetchFn = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  const allowOfflineTestFetch =
    Boolean(options.allowDnsUnavailableForCustomFetch ?? hasExplicitFetchImpl) &&
    hasExplicitFetchImpl &&
    typeof options.dnsLookup !== 'function';
  const maxRedirects =
    typeof options.maxRedirects === 'number' && options.maxRedirects >= 0
      ? Math.min(5, Math.floor(options.maxRedirects))
      : 3;
  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 15000;
  const maxFetchBytes =
    typeof options.maxFetchBytes === 'number' && options.maxFetchBytes > 0
      ? options.maxFetchBytes
      : 25 * 1024 * 1024;
  const shouldReadBody = options.readBody !== false;

  let currentUrl = String(rawUrl || '').trim();
  let currentMethod = String(options.method || 'GET').toUpperCase();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    try {
      const validated = await assertSafePublicHttpsUrl(currentUrl, {
        dnsLookup: options.dnsLookup,
        skipDnsForReservedTestTld: allowOfflineTestFetch,
        allowedPorts: options.allowedPorts,
      });
      currentUrl = validated.url;
    } catch (urlErr) {
      const anyErr = /** @type {any} */ (urlErr);
      if (anyErr?.isDnsUnavailable && allowOfflineTestFetch) {
        currentUrl = assertSafePublicHttpsUrlSyntax(currentUrl, options).url;
      } else {
        throw urlErr;
      }
    }

    const hopController = new AbortController();
    const timer = setTimeout(() => hopController.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const onCallerAbort = () => hopController.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        hopController.abort();
      } else {
        options.signal.addEventListener('abort', onCallerAbort, { once: true });
      }
    }

    let res = null;
    try {
      res = await fetchFn(currentUrl, {
        method: currentMethod,
        headers: options.headers || {},
        redirect: 'manual',
        signal: hopController.signal,
      });

      const status = Number(res?.status || 0);
      if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
        const locationHeader =
          res?.headers && typeof res.headers.get === 'function'
            ? res.headers.get('location')
            : '';
        await cancelResponseBodySafely(res);
        if (!locationHeader || !String(locationHeader).trim()) {
          throw createUnsafeUrlError(`Blocked redirect (${status}) missing Location header`);
        }
        if (hop >= maxRedirects) {
          throw createUnsafeUrlError(`Blocked redirect chain exceeding ${maxRedirects} hops`);
        }
        let nextUrl;
        try {
          nextUrl = new URL(String(locationHeader).trim(), currentUrl).toString();
        } catch {
          throw createUnsafeUrlError('Blocked malformed redirect Location URL');
        }
        if (status === 303 && currentMethod !== 'GET' && currentMethod !== 'HEAD') {
          currentMethod = 'GET';
        }
        currentUrl = nextUrl;
        continue;
      }

      if (shouldReadBody) {
        if (res?.ok) {
          try {
            const buffer = await readSafeResponseBuffer(res, maxFetchBytes);
            return { response: res, finalUrl: currentUrl, buffer };
          } catch (readErr) {
            await cancelResponseBodySafely(res);
            throw readErr;
          }
        }
        if (options.keepErrorBody !== true) {
          await cancelResponseBodySafely(res);
        }
        return { response: res, finalUrl: currentUrl, buffer: null };
      }

      return { response: res, finalUrl: currentUrl, buffer: null };
    } catch (hopErr) {
      if (res) {
        await cancelResponseBodySafely(res);
      }
      throw hopErr;
    } finally {
      clearTimeout(timer);
      if (options.signal) {
        try {
          options.signal.removeEventListener('abort', onCallerAbort);
        } catch {}
      }
    }
  }

  throw createUnsafeUrlError('Redirect resolution terminated unexpectedly');
}

module.exports = {
  getCanonicalChromeUserAgent,
  isAllowedHttpsHost,
  isPrivateOrLoopbackIp,
  assertSafePublicHttpsUrlSyntax,
  assertSafePublicHttpsUrl,
  clearPublicDnsSafetyCache,
  readSafeResponseBuffer,
  safePublicHttpsFetch,
};
