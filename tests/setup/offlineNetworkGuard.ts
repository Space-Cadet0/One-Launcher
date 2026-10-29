import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import axios, { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { resolveOfflineFixture } from '../fixtures/http/router';
import { FixtureResponse, OfflineNetworkGuardError, normalizeTargetUrl } from '../fixtures/http/types';

export { OfflineNetworkGuardError };

const requireCjs = createRequire(import.meta.url);
const cjsHttp = requireCjs('node:http') as typeof import('node:http');
const cjsHttps = requireCjs('node:https') as typeof import('node:https');
const cjsNet = requireCjs('node:net') as typeof import('node:net');
const cjsTls = requireCjs('node:tls') as typeof import('node:tls');

const originalFetch = globalThis.fetch?.bind(globalThis);
const originalHttpRequest = cjsHttp.request.bind(cjsHttp);
const originalHttpGet = cjsHttp.get.bind(cjsHttp);
const originalHttpsRequest = cjsHttps.request.bind(cjsHttps);
const originalHttpsGet = cjsHttps.get.bind(cjsHttps);
const originalSocketConnect = cjsNet.Socket.prototype.connect;
const originalTlsConnect = cjsTls.connect.bind(cjsTls);
const originalAxiosAdapter = axios.defaults.adapter;

export function isPermittedLoopbackHost(rawHost: unknown): boolean {
  if (rawHost === undefined || rawHost === null) {
    // Node's net.Socket.connect defaults omitted host to localhost
    return true;
  }
  let host = String(rawHost).trim().toLowerCase();
  if (!host) {
    return true;
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  const zoneIdx = host.indexOf('%');
  if (zoneIdx !== -1) {
    host = host.slice(0, zoneIdx);
  }
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    /^::ffff:127(?:\.\d{1,3}){3}$/.test(host)
  );
}

interface SocketTargetCheck {
  allowed: boolean;
  targetHost?: string;
  targetPort?: string | number;
}

function inspectRawSocketConnectArgs(args: unknown[]): SocketTargetCheck {
  if (args.length === 0) {
    return { allowed: true };
  }

  // Node's internal net.connect / net.createConnection normalizes args into [options, cb]
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];

  if (typeof first === 'object' && first !== null) {
    const opts = first as Record<string, unknown>;
    if (typeof opts.path === 'string' && opts.path.length > 0) {
      // Unix domain socket or Windows named pipe (\\.\pipe\...)
      if (
        typeof opts.servername === 'string' &&
        opts.servername.trim().length > 0 &&
        !isPermittedLoopbackHost(opts.servername)
      ) {
        return { allowed: false, targetHost: opts.servername.trim(), targetPort: opts.port as string | number | undefined };
      }
      return { allowed: true };
    }

    const candidateHost = opts.host ?? opts.hostname ?? opts.servername;
    if (isPermittedLoopbackHost(candidateHost)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      targetHost: String(candidateHost).trim(),
      targetPort: opts.port as string | number | undefined,
    };
  }

  if (typeof first === 'string') {
    const trimmed = first.trim();
    if (!/^\d+$/.test(trimmed)) {
      // Unix domain socket path or Windows named pipe path
      const maybeOpts = args[1];
      if (
        typeof maybeOpts === 'object' &&
        maybeOpts !== null &&
        typeof (maybeOpts as Record<string, unknown>).servername === 'string' &&
        !isPermittedLoopbackHost((maybeOpts as Record<string, unknown>).servername)
      ) {
        return {
          allowed: false,
          targetHost: String((maybeOpts as Record<string, unknown>).servername).trim(),
        };
      }
      return { allowed: true };
    }
  }

  if (typeof first === 'number' || typeof first === 'string') {
    let candidateHost: unknown;
    if (typeof args[1] === 'string') {
      candidateHost = args[1];
    } else if (typeof args[1] === 'object' && args[1] !== null && !Array.isArray(args[1])) {
      const opts = args[1] as Record<string, unknown>;
      candidateHost = opts.host ?? opts.hostname ?? opts.servername;
    }

    if (isPermittedLoopbackHost(candidateHost)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      targetHost: String(candidateHost).trim(),
      targetPort: first,
    };
  }

  return { allowed: true };
}

function formatBlockedSocketUrl(scheme: 'tcp' | 'tls', host: string, port?: string | number): string {
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const portPart = port !== undefined && port !== null && String(port).length > 0 ? `:${port}` : '';
  return `${scheme}://${formattedHost}${portPart}`;
}

function buildUrlWithAxiosParams(config: InternalAxiosRequestConfig): string {
  let raw = config.url || '';
  if (config.baseURL && !/^https?:\/\//i.test(raw)) {
    raw = `${config.baseURL.replace(/\/+$/, '')}/${raw.replace(/^\/+/, '')}`;
  }
  if (config.params && typeof config.params === 'object') {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(config.params as Record<string, unknown>)) {
      if (v !== undefined && v !== null) search.append(k, String(v));
    }
    const qs = search.toString();
    if (qs) {
      raw += (raw.includes('?') ? '&' : '?') + qs;
    }
  }
  return raw;
}

async function offlineGuardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const rawUrl =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const method =
    init?.method ||
    (typeof input === 'object' && input !== null && 'method' in input ? input.method : 'GET') ||
    'GET';

  const normalized = normalizeTargetUrl(rawUrl);
  if (normalized === 'PASS_THROUGH_LOOPBACK') {
    if (!originalFetch) {
      throw new OfflineNetworkGuardError(rawUrl, method);
    }
    return originalFetch(input, init);
  }

  let bodyStr: string | undefined;
  if (typeof init?.body === 'string') {
    bodyStr = init.body;
  } else if (init?.body instanceof URLSearchParams) {
    bodyStr = init.body.toString();
  }

  const fixture = resolveOfflineFixture({
    url: normalized,
    rawUrl,
    method,
    body: bodyStr,
  });

  const payload = typeof fixture.body === 'string' ? fixture.body : JSON.stringify(fixture.body);
  return new Response(payload, {
    status: fixture.status,
    statusText: fixture.statusText || (fixture.status >= 200 && fixture.status < 300 ? 'OK' : 'Error'),
    headers: fixture.headers || { 'content-type': typeof fixture.body === 'string' ? 'text/html' : 'application/json' },
  });
}

const offlineAxiosAdapter: AxiosAdapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
  const fullUrl = buildUrlWithAxiosParams(config);
  const method = (config.method || 'GET').toUpperCase();
  const normalized = normalizeTargetUrl(fullUrl);

  if (normalized === 'PASS_THROUGH_LOOPBACK') {
    const adapter = typeof originalAxiosAdapter === 'function' ? originalAxiosAdapter : axios.getAdapter(originalAxiosAdapter);
    return adapter(config);
  }

  const bodyStr =
    typeof config.data === 'string'
      ? config.data
      : config.data !== undefined && config.data !== null
        ? JSON.stringify(config.data)
        : undefined;

  const fixture: FixtureResponse = resolveOfflineFixture({
    url: normalized,
    rawUrl: fullUrl,
    method,
    body: bodyStr,
  });

  const responseData =
    config.responseType === 'text' && typeof fixture.body !== 'string'
      ? JSON.stringify(fixture.body)
      : fixture.body;

  const axiosResponse: AxiosResponse = {
    data: responseData,
    status: fixture.status,
    statusText: fixture.statusText || (fixture.status >= 200 && fixture.status < 300 ? 'OK' : 'Error'),
    headers: fixture.headers || {},
    config,
  };

  const validateStatus = config.validateStatus === undefined ? (s: number) => s >= 200 && s < 300 : config.validateStatus;
  if (validateStatus && !validateStatus(fixture.status)) {
    const err = Object.assign(new Error(`Request failed with status code ${fixture.status}`), {
      isAxiosError: true,
      config,
      response: axiosResponse,
      status: fixture.status,
    });
    throw err;
  }

  return axiosResponse;
};

function parseNodeHttpArgs(
  defaultProto: 'http:' | 'https:',
  arg0: unknown,
  arg1?: unknown,
  arg2?: unknown
): { rawUrl: string; method: string; callback?: (res: NodeJS.ReadableStream) => void } {
  let callback: ((res: NodeJS.ReadableStream) => void) | undefined;
  let method = 'GET';
  let rawUrl = '';

  if (typeof arg1 === 'function') callback = arg1 as (res: NodeJS.ReadableStream) => void;
  else if (typeof arg2 === 'function') callback = arg2 as (res: NodeJS.ReadableStream) => void;

  const opts =
    typeof arg0 === 'object' && arg0 !== null && !(arg0 instanceof URL)
      ? (arg0 as Record<string, unknown>)
      : typeof arg1 === 'object' && arg1 !== null
        ? (arg1 as Record<string, unknown>)
        : {};

  if (typeof opts.method === 'string') {
    method = opts.method.toUpperCase();
  }

  if (typeof arg0 === 'string') {
    rawUrl = arg0;
  } else if (arg0 instanceof URL) {
    rawUrl = arg0.toString();
  } else if (typeof opts.href === 'string') {
    rawUrl = opts.href;
  } else {
    const proto = typeof opts.protocol === 'string' ? opts.protocol : defaultProto;
    const host = String(opts.hostname || opts.host || 'localhost');
    const portPart = opts.port && !host.includes(':') ? `:${opts.port}` : '';
    const pathPart = typeof opts.path === 'string' ? opts.path : '/';
    rawUrl = `${proto}//${host}${portPart}${pathPart.startsWith('/') ? pathPart : `/${pathPart}`}`;
  }

  return { rawUrl, method, callback };
}

function createPatchedNodeRequest(
  defaultProto: 'http:' | 'https:',
  originalReqFn: (...args: unknown[]) => import('node:http').ClientRequest,
  autoEnd: boolean,
  originalGetFn?: (...args: unknown[]) => import('node:http').ClientRequest
) {
  return function patchedRequest(arg0: unknown, arg1?: unknown, arg2?: unknown): import('node:http').ClientRequest {
    const { rawUrl, method, callback } = parseNodeHttpArgs(defaultProto, arg0, arg1, arg2);
    const normalized = normalizeTargetUrl(rawUrl);

    if (normalized === 'PASS_THROUGH_LOOPBACK') {
      const fn = autoEnd && originalGetFn ? originalGetFn : originalReqFn;
      return fn(arg0, arg1, arg2);
    }

    // Eagerly validate GET requests so unmocked URLs fail synchronously
    let preflightFixture: FixtureResponse | null = null;
    if (method === 'GET' || method === 'HEAD') {
      preflightFixture = resolveOfflineFixture({ url: normalized, rawUrl, method });
    }

    const reqEmitter = new EventEmitter();
    const chunks: Buffer[] = [];
    let ended = false;

    const clientReq = Object.assign(reqEmitter, {
      write(chunk: string | Buffer) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        return true;
      },
      end(chunk?: string | Buffer) {
        if (ended) return clientReq;
        ended = true;
        if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        const bodyStr = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined;
        let fixture: FixtureResponse;
        try {
          fixture = preflightFixture || resolveOfflineFixture({ url: normalized, rawUrl, method, body: bodyStr });
        } catch (err) {
          if (reqEmitter.listenerCount('error') > 0) {
            queueMicrotask(() => reqEmitter.emit('error', err));
            return clientReq;
          }
          throw err;
        }

        queueMicrotask(() => {
          const stream = new PassThrough() as PassThrough & {
            statusCode: number;
            statusMessage: string;
            headers: Record<string, string>;
          };
          stream.statusCode = fixture.status;
          stream.statusMessage = fixture.statusText || 'OK';
          stream.headers = fixture.headers || { 'content-type': 'application/json' };
          if (callback) {
            reqEmitter.once('response', callback);
          }
          reqEmitter.emit('response', stream);
          const out = typeof fixture.body === 'string' ? fixture.body : JSON.stringify(fixture.body);
          stream.end(Buffer.from(out, 'utf8'));
        });
        return clientReq;
      },
      setTimeout(_ms: number, _cb?: () => void) {
        return clientReq;
      },
      destroy(err?: Error) {
        if (err && reqEmitter.listenerCount('error') > 0) {
          reqEmitter.emit('error', err);
        }
        return clientReq;
      },
      abort() {
        return clientReq;
      },
      setHeader() {
        return clientReq;
      },
      getHeader() {
        return undefined;
      },
      removeHeader() {},
      flushHeaders() {},
    }) as unknown as import('node:http').ClientRequest;

    if (autoEnd) {
      clientReq.end();
    }

    return clientReq;
  };
}

// Install low-level raw TCP/TLS socket backstop (permits loopback & Unix sockets/named pipes)
cjsNet.Socket.prototype.connect = function offlineGuardedSocketConnect(
  this: import('node:net').Socket,
  ...args: unknown[]
): import('node:net').Socket {
  const check = inspectRawSocketConnectArgs(args);
  if (!check.allowed) {
    const err = new OfflineNetworkGuardError(
      formatBlockedSocketUrl('tcp', check.targetHost || '<external-host>', check.targetPort),
      'TCP_CONNECT'
    );
    if (this.listenerCount('error') > 0) {
      queueMicrotask(() => {
        if (this.listenerCount('error') > 0) {
          this.emit('error', err);
        }
      });
    }
    this.destroy();
    throw err;
  }
  return (originalSocketConnect as (...a: unknown[]) => import('node:net').Socket).apply(this, args);
} as typeof cjsNet.Socket.prototype.connect;

cjsTls.connect = function offlineGuardedTlsConnect(
  ...args: unknown[]
): import('node:tls').TLSSocket {
  const check = inspectRawSocketConnectArgs(args);
  if (!check.allowed) {
    throw new OfflineNetworkGuardError(
      formatBlockedSocketUrl('tls', check.targetHost || '<external-host>', check.targetPort ?? 443),
      'TLS_CONNECT'
    );
  }
  return (originalTlsConnect as (...a: unknown[]) => import('node:tls').TLSSocket)(...args);
} as typeof cjsTls.connect;

// Install global offline network guard across fetch, axios, http, and https
globalThis.fetch = offlineGuardedFetch as typeof fetch;
axios.defaults.adapter = offlineAxiosAdapter;

cjsHttp.request = createPatchedNodeRequest(
  'http:',
  originalHttpRequest as unknown as (...args: unknown[]) => import('node:http').ClientRequest,
  false
) as typeof cjsHttp.request;
cjsHttp.get = createPatchedNodeRequest(
  'http:',
  originalHttpRequest as unknown as (...args: unknown[]) => import('node:http').ClientRequest,
  true,
  originalHttpGet as unknown as (...args: unknown[]) => import('node:http').ClientRequest
) as typeof cjsHttp.get;

cjsHttps.request = createPatchedNodeRequest(
  'https:',
  originalHttpsRequest as unknown as (...args: unknown[]) => import('node:http').ClientRequest,
  false
) as typeof cjsHttps.request;
cjsHttps.get = createPatchedNodeRequest(
  'https:',
  originalHttpsRequest as unknown as (...args: unknown[]) => import('node:http').ClientRequest,
  true,
  originalHttpsGet as unknown as (...args: unknown[]) => import('node:http').ClientRequest
) as typeof cjsHttps.get;

syncBuiltinESMExports();
