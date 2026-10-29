export class OfflineNetworkGuardError extends Error {
  public readonly url: string;
  public readonly method: string;

  constructor(url: string, method = 'GET') {
    super(
      `[OfflineNetworkGuard] Blocked unmocked outbound network request: ${method.toUpperCase()} ${url}. ` +
        `Register a deterministic fixture in tests/fixtures/http/ or mock the call explicitly in the test.`
    );
    this.name = 'OfflineNetworkGuardError';
    this.url = url;
    this.method = method.toUpperCase();
  }
}

export interface FixtureRequest {
  url: URL;
  rawUrl: string;
  method: string;
  body?: string;
}

export interface FixtureResponse {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body: string | Record<string, unknown> | unknown[];
}

const PROXY_PREFIX_MAP: Array<[string, string]> = [
  ['/api/metacritic-search', 'https://backend.metacritic.com'],
  ['/api/metacritic', 'https://www.metacritic.com'],
  ['/api/opencritic', 'https://api.opencritic.com'],
  ['/api/steam-store', 'https://store.steampowered.com'],
  ['/api/steam-community', 'https://steamcommunity.com'],
  ['/api/steam-api', 'https://api.steampowered.com'],
  ['/api/gog-catalog', 'https://catalog.gog.com'],
  ['/api/gog-api', 'https://api.gog.com'],
  ['/api/gog-web', 'https://www.gog.com'],
  ['/api/epic-graphql', 'https://launcher.store.epicgames.com'],
  ['/api/epic-content', 'https://store-content.ak.epicgames.com'],
  ['/api/epic-oauth', 'https://account-public-service-prod03.ol.epicgames.com'],
  ['/api/epic-library', 'https://library-service.live.use1a.on.epicgames.com'],
  ['/api/lutris', 'https://lutris.net'],
  ['/api/local-system', 'https://local-system.onelauncher.internal'],
];

export function normalizeTargetUrl(rawUrl: string): URL | 'PASS_THROUGH_LOOPBACK' {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    throw new OfflineNetworkGuardError('<empty-url>');
  }

  if (trimmed.startsWith('/')) {
    for (const [prefix, targetOrigin] of PROXY_PREFIX_MAP) {
      if (trimmed === prefix || trimmed.startsWith(`${prefix}/`) || trimmed.startsWith(`${prefix}?`)) {
        const rest = trimmed.slice(prefix.length) || '/';
        return new URL(rest.startsWith('/') ? rest : `/${rest}`, targetOrigin);
      }
    }
    throw new OfflineNetworkGuardError(trimmed);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new OfflineNetworkGuardError(trimmed);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]' || hostname === 'localhost') {
    for (const [prefix, targetOrigin] of PROXY_PREFIX_MAP) {
      if (parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`)) {
        const rest = parsed.pathname.slice(prefix.length) || '/';
        return new URL(`${rest.startsWith('/') ? rest : `/${rest}`}${parsed.search}`, targetOrigin);
      }
    }
    if (parsed.port && parsed.pathname !== '/undefined') {
      return 'PASS_THROUGH_LOOPBACK';
    }
  }

  return parsed;
}
