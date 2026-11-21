// @ts-check
'use strict';

const {
  MAX_RPC_FRAME_BYTES,
  MAX_UNAUTH_RPC_FRAME_BYTES,
  MAX_HTTP_HEADER_BYTES,
  MAX_PARSED_REQ_QUEUE,
  verifySessionKeyConstantTime,
  encodeRpcFrame,
} = require('./loopbackValidationAndPaths.cjs');

const HTTP_REQUEST_LINE_RE = /^(POST|GET|PUT|DELETE|HEAD|OPTIONS)\s+\S+\s+HTTP\/1\.[01]$/;
const LOOPBACK_HOST_HEADER_RE = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i;

/**
 * Validates an HTTP `Host` header against strict loopback literals (`127.0.0.1`,
 * `localhost`, `[::1]`) with an optional valid TCP port (`1..65535`).
 *
 * @param {string | undefined | null} rawHost
 * @returns {boolean}
 */
function isValidLoopbackHostHeader(rawHost) {
  if (typeof rawHost !== 'string') return false;
  const trimmed = rawHost.trim();
  if (!trimmed) return false;
  const m = LOOPBACK_HOST_HEADER_RE.exec(trimmed);
  if (!m) return false;
  if (m[2] !== undefined) {
    const portNum = Number(m[2]);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return false;
    }
  }
  return true;
}

/**
 * @param {number} b0
 * @returns {boolean}
 */
function looksLikeAsciiHttpPrefix(b0) {
  return (
    b0 === 0x50 /* P (POST/PUT) */ ||
    b0 === 0x47 /* G (GET) */ ||
    b0 === 0x44 /* D (DELETE) */ ||
    b0 === 0x48 /* H (HEAD) */ ||
    b0 === 0x4f /* O (OPTIONS) */
  );
}

/**
 * Creates the hardened TCP connection handler supporting dual-mode binary length-prefixed
 * RPC framing and hardened HTTP/1.1 JSON-RPC framing (with strict Host validation,
 * Transfer-Encoding smuggling rejection, incremental body buffering, capped request queue,
 * and per-request keepAlive scoping).
 *
 * @param {{
 *   expectedKeyBuf: Buffer,
 *   activeSockets: Set<import('node:net').Socket>,
 *   unauthSockets: Set<import('node:net').Socket>,
 *   maxConcurrentSockets: number,
 *   socketIdleTimeoutMs: number,
 *   unauthHandshakeTimeoutMs: number,
 *   maxParsedReqQueue?: number,
 *   dispatchRpcMethod: (method: string, params: Record<string, any>) => Promise<any>,
 * }} config
 * @returns {(socket: import('node:net').Socket) => void}
 */
function createLoopbackConnectionHandler(config) {
  const {
    expectedKeyBuf,
    activeSockets,
    unauthSockets,
    maxConcurrentSockets,
    socketIdleTimeoutMs,
    unauthHandshakeTimeoutMs,
    dispatchRpcMethod,
  } = config;
  const maxQueuedRequests = Math.max(
    1,
    Math.min(
      256,
      Number.isInteger(config.maxParsedReqQueue)
        ? Number(config.maxParsedReqQueue)
        : MAX_PARSED_REQ_QUEUE
    )
  );

  return function handleLoopbackSocket(socket) {
    if (activeSockets.size >= maxConcurrentSockets) {
      // Evict the oldest unauthenticated socket first so slow pre-auth connections
      // can never starve legitimate RPC clients of socket slots.
      const oldestUnauth = unauthSockets.values().next().value;
      if (oldestUnauth) {
        unauthSockets.delete(oldestUnauth);
        activeSockets.delete(oldestUnauth);
        oldestUnauth.destroy();
      } else {
        socket.destroy();
        return;
      }
    }

    activeSockets.add(socket);
    unauthSockets.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(socketIdleTimeoutMs);
    socket.on('timeout', () => {
      socket.destroy();
    });

    let socketAuthenticated = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let unauthTimer = setTimeout(() => {
      if (!socketAuthenticated && !socket.destroyed) {
        socket.destroy();
      }
    }, unauthHandshakeTimeoutMs);
    if (typeof unauthTimer.unref === 'function') {
      unauthTimer.unref();
    }

    const markSocketAuthenticated = () => {
      if (!socketAuthenticated) {
        socketAuthenticated = true;
        unauthSockets.delete(socket);
        if (unauthTimer) {
          clearTimeout(unauthTimer);
          unauthTimer = null;
        }
      }
    };

    // Dual-mode framing state (incremental chunk accumulation — NEVER pre-allocates full frame!)
    /** @type {null | 'binary' | 'http'} */
    let protocolMode = null;
    const headerBuf = Buffer.allocUnsafe(4);
    let headerFilled = 0;
    let bodyLen = 0;
    /** @type {Buffer[]} */
    let binaryBodyChunks = [];
    let binaryBodyReceived = 0;

    let httpHeaderBuf = Buffer.alloc(0);
    let httpHeadersVerified = false;
    let httpContentLength = 0;
    let httpCurrentKeepAlive = false;
    let httpClosingAfterQueued = false;
    /** @type {Buffer[]} */
    let httpBodyChunks = [];
    let httpBodyReceived = 0;

    /** @type {Array<{ req: any, isHttp: boolean, keepAlive: boolean }>} */
    const parsedReqQueue = [];

    /**
     * @param {number} statusCode
     * @param {string} statusText
     */
    const writeHttpErrorAndDestroy = (statusCode, statusText) => {
      if (!socket.destroyed) {
        socket.write(
          `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
        );
        socket.destroy();
      }
    };

    /**
     * @param {number} statusCode
     * @param {string} statusText
     * @param {any} payloadObj
     * @param {boolean} closeAfter
     * @param {boolean} reqKeepAlive
     */
    const writeHttpJsonResponse = (
      statusCode,
      statusText,
      payloadObj,
      closeAfter = false,
      reqKeepAlive = false
    ) => {
      if (socket.destroyed) return;
      const bodyJson = payloadObj
        ? Buffer.from(JSON.stringify(payloadObj), 'utf8')
        : Buffer.alloc(0);
      const shouldClose = Boolean(closeAfter || !reqKeepAlive);
      const connHeader = shouldClose ? 'close' : 'keep-alive';
      const head =
        `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
        `Content-Type: application/json; charset=utf-8\r\n` +
        `Content-Length: ${bodyJson.length}\r\n` +
        `Connection: ${connHeader}\r\n\r\n`;
      socket.write(head);
      if (bodyJson.length > 0) {
        socket.write(bodyJson);
      }
      if (shouldClose) {
        socket.end();
      }
    };

    const drainParsedReqQueue = async () => {
      while (parsedReqQueue.length > 0 && !socket.destroyed) {
        const item = parsedReqQueue.shift();
        if (!item) break;
        const req = item.req;
        const isHttp = item.isHttp === true;
        const reqKeepAlive = item.keepAlive === true;
        const reqId = req.id ?? 0;
        try {
          const result = await dispatchRpcMethod(String(req.method || ''), req.params || {});
          if (!socket.destroyed) {
            const respObj = { id: reqId, ok: true, hr: 0, result };
            if (isHttp) {
              writeHttpJsonResponse(200, 'OK', respObj, false, reqKeepAlive);
              if (!reqKeepAlive) break;
            } else {
              socket.write(encodeRpcFrame(respObj));
            }
          }
        } catch (/** @type {any} */ err) {
          const hr = Number.isInteger(err?.hr) ? err.hr : -2147467259; // E_FAIL (0x80004005)
          if (!socket.destroyed) {
            const respObj = {
              id: reqId,
              ok: false,
              hr,
              error: err?.message || String(err),
            };
            if (isHttp) {
              writeHttpJsonResponse(200, 'OK', respObj, false, reqKeepAlive);
              if (!reqKeepAlive) break;
            } else {
              socket.write(encodeRpcFrame(respObj));
            }
          }
        }
      }
    };

    let processingChain = Promise.resolve();

    socket.on('data', (chunk) => {
      if (chunk.length === 0 || socket.destroyed) return;

      if (protocolMode === null) {
        if (headerFilled === 0 && chunk.length >= 4) {
          const isAsciiMethod =
            looksLikeAsciiHttpPrefix(chunk[0]) &&
            chunk[1] >= 0x20 &&
            chunk[1] <= 0x7e &&
            chunk[2] >= 0x20 &&
            chunk[2] <= 0x7e &&
            chunk[3] >= 0x20 &&
            chunk[3] <= 0x7e;
          protocolMode = isAsciiMethod ? 'http' : 'binary';
        } else if (headerFilled === 0 && !looksLikeAsciiHttpPrefix(chunk[0])) {
          protocolMode = 'binary';
        } else {
          const take = Math.min(4 - headerFilled, chunk.length);
          chunk.copy(headerBuf, headerFilled, 0, take);
          headerFilled += take;
          if (headerFilled < 4) return;
          const isAsciiMethod =
            looksLikeAsciiHttpPrefix(headerBuf[0]) &&
            headerBuf[1] >= 0x20 &&
            headerBuf[1] <= 0x7e &&
            headerBuf[2] >= 0x20 &&
            headerBuf[2] <= 0x7e &&
            headerBuf[3] >= 0x20 &&
            headerBuf[3] <= 0x7e;
          if (isAsciiMethod) {
            protocolMode = 'http';
            chunk = Buffer.concat([headerBuf.subarray(0, 4), chunk.subarray(take)]);
            headerFilled = 0;
          } else {
            protocolMode = 'binary';
            chunk = chunk.subarray(take);
          }
        }
      }

      if (protocolMode === 'http') {
        let cursor = 0;
        while (cursor < chunk.length && !socket.destroyed && !httpClosingAfterQueued) {
          if (!httpHeadersVerified) {
            const rem = chunk.subarray(cursor);
            const prevLen = httpHeaderBuf.length;
            const searchLimit = Math.min(rem.length, MAX_HTTP_HEADER_BYTES - prevLen + 4);
            const candidateHeader =
              prevLen === 0
                ? rem.subarray(0, searchLimit)
                : Buffer.concat([httpHeaderBuf, rem.subarray(0, searchLimit)]);
            const headerEndIdx = candidateHeader.indexOf('\r\n\r\n');
            if (headerEndIdx < 0) {
              if (candidateHeader.length > MAX_HTTP_HEADER_BYTES) {
                writeHttpErrorAndDestroy(431, 'Request Header Fields Too Large');
                return;
              }
              httpHeaderBuf = Buffer.from(candidateHeader);
              return;
            }

            const rawHeadersStr = candidateHeader.subarray(0, headerEndIdx).toString('latin1');
            const consumedFromRem = headerEndIdx + 4 - prevLen;
            cursor += consumedFromRem;
            httpHeaderBuf = Buffer.alloc(0);

            if (rawHeadersStr.includes('\0')) {
              writeHttpErrorAndDestroy(400, 'Bad Request');
              return;
            }

            const lines = rawHeadersStr.split('\r\n');
            const requestLine = lines[0] || '';
            if (!HTTP_REQUEST_LINE_RE.test(requestLine)) {
              writeHttpErrorAndDestroy(400, 'Bad Request');
              return;
            }

            /** @type {Map<string, string>} */
            const headersMap = new Map();
            let hostHeaderCount = 0;
            let contentLengthCount = 0;
            let hasTransferEncoding = false;

            for (let i = 1; i < lines.length; i += 1) {
              const line = lines[i];
              // Reject obs-fold (leading whitespace) or malformed header lines
              if (!line || line[0] === ' ' || line[0] === '\t') {
                writeHttpErrorAndDestroy(400, 'Bad Request');
                return;
              }
              const colon = line.indexOf(':');
              if (colon <= 0) {
                writeHttpErrorAndDestroy(400, 'Bad Request');
                return;
              }
              const rawKey = line.slice(0, colon);
              if (/[\s]/.test(rawKey)) {
                writeHttpErrorAndDestroy(400, 'Bad Request');
                return;
              }
              const k = rawKey.toLowerCase();
              const v = line.slice(colon + 1).trim();
              if (k === 'host') hostHeaderCount += 1;
              if (k === 'content-length') contentLengthCount += 1;
              if (k === 'transfer-encoding') hasTransferEncoding = true;
              if (k === 'connection' && headersMap.has(k)) {
                headersMap.set(k, `${headersMap.get(k)}, ${v}`);
              } else {
                headersMap.set(k, v);
              }
            }

            // Reject duplicate Host, duplicate Content-Length, or Transfer-Encoding smuggling
            if (hostHeaderCount === 0 || hostHeaderCount > 1 || contentLengthCount > 1) {
              writeHttpErrorAndDestroy(400, 'Bad Request');
              return;
            }
            if (hasTransferEncoding) {
              if (contentLengthCount > 0) {
                // CL.TE / TE.CL HTTP request smuggling attempt
                writeHttpErrorAndDestroy(400, 'Bad Request');
              } else {
                // Unsupported chunked / Transfer-Encoding framing
                writeHttpErrorAndDestroy(501, 'Not Implemented');
              }
              return;
            }

            // Enforce strict loopback Host header (prevents DNS rebinding)
            if (!isValidLoopbackHostHeader(headersMap.get('host'))) {
              writeHttpErrorAndDestroy(403, 'Forbidden');
              return;
            }

            // Reject browser cross-origin / Sec-Fetch requests immediately
            if (headersMap.get('origin') || headersMap.get('sec-fetch-site')) {
              writeHttpErrorAndDestroy(403, 'Forbidden');
              return;
            }

            // Validate X-One-Launcher-Token via constant-time timingSafeEqual BEFORE reading body
            const headerToken = headersMap.get('x-one-launcher-token') || '';
            if (!verifySessionKeyConstantTime(headerToken, expectedKeyBuf)) {
              writeHttpErrorAndDestroy(401, 'Unauthorized');
              return;
            }

            markSocketAuthenticated();

            const clRaw = headersMap.get('content-length');
            let parsedCl = 0;
            if (clRaw !== undefined) {
              if (!/^\d+$/.test(clRaw)) {
                writeHttpErrorAndDestroy(400, 'Bad Request');
                return;
              }
              parsedCl = Number(clRaw);
              if (!Number.isSafeInteger(parsedCl) || parsedCl < 0 || parsedCl > MAX_RPC_FRAME_BYTES) {
                writeHttpErrorAndDestroy(413, 'Payload Too Large');
                return;
              }
            }

            const connTokens = String(headersMap.get('connection') || '')
              .toLowerCase()
              .split(',')
              .map((tok) => tok.trim())
              .filter(Boolean);
            httpCurrentKeepAlive =
              connTokens.includes('keep-alive') && !connTokens.includes('close');

            httpContentLength = parsedCl;
            httpHeadersVerified = true;
            // Incremental chunk list — NEVER pre-allocates Buffer.allocUnsafe(httpContentLength)!
            httpBodyChunks = [];
            httpBodyReceived = 0;
          }

          if (httpHeadersVerified) {
            const need = httpContentLength - httpBodyReceived;
            const take = Math.min(need, chunk.length - cursor);
            if (take > 0) {
              const slice =
                cursor === 0 && take === chunk.length
                  ? chunk
                  : Buffer.from(chunk.subarray(cursor, cursor + take));
              httpBodyChunks.push(slice);
              httpBodyReceived += take;
              cursor += take;
            }
            if (httpBodyReceived === httpContentLength) {
              const completedHttpBody =
                httpContentLength === 0
                  ? Buffer.alloc(0)
                  : httpBodyChunks.length === 1
                    ? httpBodyChunks[0]
                    : Buffer.concat(httpBodyChunks, httpContentLength);
              const reqKeepAlive = httpCurrentKeepAlive;
              httpBodyChunks = [];
              httpBodyReceived = 0;
              httpHeadersVerified = false;
              httpContentLength = 0;
              httpCurrentKeepAlive = false;

              let req;
              try {
                req =
                  completedHttpBody.length > 0
                    ? JSON.parse(completedHttpBody.toString('utf8'))
                    : {};
              } catch {
                writeHttpJsonResponse(
                  400,
                  'Bad Request',
                  { ok: false, error: 'Invalid JSON' },
                  true,
                  false
                );
                socket.destroy();
                return;
              }

              if (parsedReqQueue.length >= maxQueuedRequests) {
                writeHttpErrorAndDestroy(429, 'Too Many Requests');
                return;
              }

              parsedReqQueue.push({ req, isHttp: true, keepAlive: reqKeepAlive });
              if (!reqKeepAlive) {
                httpClosingAfterQueued = true;
              }
            }
          }
        }

        if (parsedReqQueue.length > 0 && !socket.destroyed) {
          processingChain = processingChain.then(drainParsedReqQueue, drainParsedReqQueue);
        }
        return;
      }

      // Binary length-prefixed framing mode ([u32LE length][JSON])
      let offset = 0;
      if (headerFilled === 4 && bodyLen === 0) {
        bodyLen = headerBuf.readUInt32LE(0);
        const maxAllowed = socketAuthenticated
          ? MAX_RPC_FRAME_BYTES
          : MAX_UNAUTH_RPC_FRAME_BYTES;
        if (bodyLen === 0 || bodyLen > maxAllowed) {
          socket.destroy();
          return;
        }
        binaryBodyChunks = [];
        binaryBodyReceived = 0;
      }

      while (offset < chunk.length && !socket.destroyed) {
        if (headerFilled < 4) {
          const needHeader = 4 - headerFilled;
          const takeHeader = Math.min(needHeader, chunk.length - offset);
          chunk.copy(headerBuf, headerFilled, offset, offset + takeHeader);
          headerFilled += takeHeader;
          offset += takeHeader;
          if (headerFilled < 4) {
            break;
          }

          bodyLen = headerBuf.readUInt32LE(0);
          const maxAllowed = socketAuthenticated
            ? MAX_RPC_FRAME_BYTES
            : MAX_UNAUTH_RPC_FRAME_BYTES;
          if (bodyLen === 0 || bodyLen > maxAllowed) {
            socket.destroy();
            return;
          }
          // Incremental chunk accumulation — NEVER pre-allocates Buffer.allocUnsafe(bodyLen)!
          binaryBodyChunks = [];
          binaryBodyReceived = 0;
        }

        const needBody = bodyLen - binaryBodyReceived;
        const takeBody = Math.min(needBody, chunk.length - offset);
        if (takeBody > 0) {
          const slice =
            offset === 0 && takeBody === chunk.length
              ? chunk
              : Buffer.from(chunk.subarray(offset, offset + takeBody));
          binaryBodyChunks.push(slice);
          binaryBodyReceived += takeBody;
          offset += takeBody;
        }

        if (binaryBodyReceived === bodyLen) {
          const completedBuf =
            binaryBodyChunks.length === 1
              ? binaryBodyChunks[0]
              : Buffer.concat(binaryBodyChunks, bodyLen);
          binaryBodyChunks = [];
          binaryBodyReceived = 0;
          headerFilled = 0;
          bodyLen = 0;

          let req;
          try {
            req = JSON.parse(completedBuf.toString('utf8'));
          } catch {
            socket.destroy();
            return;
          }

          const candidateToken =
            req && typeof req === 'object' ? (req.key ?? req.sessionToken) : '';
          if (!req || !verifySessionKeyConstantTime(candidateToken, expectedKeyBuf)) {
            socket.destroy();
            return;
          }

          markSocketAuthenticated();

          if (parsedReqQueue.length >= maxQueuedRequests) {
            socket.destroy();
            return;
          }

          parsedReqQueue.push({ req, isHttp: false, keepAlive: true });
        }
      }

      if (parsedReqQueue.length > 0 && !socket.destroyed) {
        processingChain = processingChain.then(drainParsedReqQueue, drainParsedReqQueue);
      }
    });

    socket.on('error', () => {
      socket.destroy();
    });

    socket.on('close', () => {
      if (unauthTimer) {
        clearTimeout(unauthTimer);
        unauthTimer = null;
      }
      binaryBodyChunks = [];
      httpBodyChunks = [];
      httpHeaderBuf = Buffer.alloc(0);
      parsedReqQueue.length = 0;
      unauthSockets.delete(socket);
      activeSockets.delete(socket);
    });
  };
}

module.exports = {
  isValidLoopbackHostHeader,
  createLoopbackConnectionHandler,
};
