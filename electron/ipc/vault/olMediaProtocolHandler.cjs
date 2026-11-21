// @ts-check
'use strict';

const fs = require('node:fs');
const { Readable } = require('node:stream');
const {
  assertSafePublicHttpsUrl,
  assertSafePublicHttpsUrlSyntax,
} = require('../../launcher/securityAndPathUtils.cjs');

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
 * Clamp an `ol-media://` `ord`/`ordinal` query parameter to a non-negative integer (`>= 0`,
 * falling back to `0` on `NaN`, negative, or non-finite values).
 *
 * @param {string | null} rawOrd
 * @returns {number}
 */
function parseClampedMediaOrdinal(rawOrd) {
  if (rawOrd === null || rawOrd === '') return 0;
  const parsed = Number(rawOrd);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

/**
 * Creates the `ol-media://` custom streaming protocol handler backed by `OfflineVaultService`.
 * Enforces `assertSafePublicHttpsUrl` SSRF/DNS-rebinding protection on remote fallback URLs,
 * sets `Cross-Origin-Resource-Policy: same-origin`, clamps `ord`, returns HTTP 416 on invalid
 * `Range` headers (`bytes=-`, `bytes=-0`, out-of-bounds), and rejects cross-site subframes.
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
        ordinal: parseClampedMediaOrdinal(sp.get('ord') ?? sp.get('ordinal')),
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

      // Step 2: Zero-DNS local disk cache fast path (bypassed when custom `dnsLookup` is injected).
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
            if (rawStart === '' && rawEnd === '') {
              return new Response(null, {
                status: 416,
                headers: {
                  ...OL_MEDIA_BASE_SECURITY_HEADERS,
                  'Content-Range': `bytes */${totalSize}`,
                  'Accept-Ranges': 'bytes',
                },
              });
            }

            let start = rawStart !== '' ? parseInt(rawStart, 10) : 0;
            let end = rawEnd !== '' ? parseInt(rawEnd, 10) : totalSize - 1;

            if (rawStart === '' && rawEnd !== '') {
              const suffixLen = parseInt(rawEnd, 10);
              if (!Number.isFinite(suffixLen) || suffixLen <= 0) {
                return new Response(null, {
                  status: 416,
                  headers: {
                    ...OL_MEDIA_BASE_SECURITY_HEADERS,
                    'Content-Range': `bytes */${totalSize}`,
                    'Accept-Ranges': 'bytes',
                  },
                });
              }
              start = Math.max(0, totalSize - suffixLen);
              end = totalSize - 1;
            }

            if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < totalSize) {
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

module.exports = {
  OL_MEDIA_BASE_SECURITY_HEADERS,
  getRequestHeaderValue,
  isUntrustedCrossSiteMediaRequest,
  parseClampedMediaOrdinal,
  createOlMediaProtocolHandler,
};
