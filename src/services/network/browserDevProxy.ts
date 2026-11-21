/**
 * Unified Vite browser-dev CORS proxy detection and URL builder.
 *
 * Replaces all divergent `isViteBrowserDev()` and raw `window.location.hostname === 'localhost'`
 * checks across storefront connectors, critic resolvers, and scrapers.
 *
 * Strictly returns `false` inside Electron (even when loading from `http://localhost:5173`),
 * inside Vitest/jsdom/Node test environments, and in production builds.
 */

import {
  hasElectronBridge,
  isJsdomOrNodeUserAgent,
  isTestEnv,
  isViteDevMode,
} from '../common/runtimeEnv';

export interface BrowserDevProxyRoute {
  readonly proxyPrefix: string;
  readonly prodBase: string;
}

export const BROWSER_DEV_PROXY_ROUTES = {
  steamStore: {
    proxyPrefix: '/api/steam-store',
    prodBase: 'https://store.steampowered.com',
  },
  steamApi: {
    proxyPrefix: '/api/steam-api',
    prodBase: 'https://api.steampowered.com',
  },
  steamCommunity: {
    proxyPrefix: '/api/steam-community',
    prodBase: 'https://steamcommunity.com',
  },
  gogEmbed: {
    proxyPrefix: '/api/gog-embed',
    prodBase: 'https://embed.gog.com',
  },
  gogAuth: {
    proxyPrefix: '/api/gog-auth',
    prodBase: 'https://auth.gog.com',
  },
  gogMenu: {
    proxyPrefix: '/api/gog-menu',
    prodBase: 'https://menu.gog.com',
  },
  gogProfile: {
    proxyPrefix: '/api/gog-profile',
    prodBase: 'https://www.gog.com',
  },
  gogProduct: {
    proxyPrefix: '/api/gog-product',
    prodBase: 'https://api.gog.com',
  },
  gogCatalog: {
    proxyPrefix: '/api/gog-catalog',
    prodBase: 'https://catalog.gog.com',
  },
  epicOauth: {
    proxyPrefix: '/api/epic-oauth',
    prodBase: 'https://account-public-service-prod03.ol.epicgames.com',
  },
  epicLibrary: {
    proxyPrefix: '/api/epic-library',
    prodBase: 'https://library-service.live.use1a.on.epicgames.com',
  },
  epicCatalog: {
    proxyPrefix: '/api/epic-catalog',
    prodBase: 'https://catalog-public-service-prod06.ol.epicgames.com',
  },
  epicContent: {
    proxyPrefix: '/api/epic-content',
    prodBase: 'https://store-content.ak.epicgames.com',
  },
  epicGraphql: {
    proxyPrefix: '/api/epic-graphql',
    prodBase: 'https://launcher.store.epicgames.com',
  },
  hltb: {
    proxyPrefix: '/api/hltb',
    prodBase: 'https://howlongtobeat.com',
  },
  lutris: {
    proxyPrefix: '/api/lutris',
    prodBase: 'https://lutris.net',
  },
  openCriticWeb: {
    proxyPrefix: '/api/opencritic-web',
    prodBase: 'https://opencritic.com',
  },
  metacriticBackend: {
    proxyPrefix: '/api/metacritic-backend',
    prodBase: 'https://backend.metacritic.com',
  },
  metacritic: {
    proxyPrefix: '/api/metacritic',
    prodBase: 'https://www.metacritic.com',
  },
  wikidataSparql: {
    proxyPrefix: '/api/wikidata-sparql',
    prodBase: 'https://query.wikidata.org',
  },
  wikidataApi: {
    proxyPrefix: '/api/wikidata-api',
    prodBase: 'https://www.wikidata.org',
  },
} as const satisfies Record<string, BrowserDevProxyRoute>;

export type BrowserDevProxyRouteKey = keyof typeof BROWSER_DEV_PROXY_ROUTES;

/**
 * Returns true ONLY when executing inside a real browser served by the Vite dev server
 * on localhost ports 3000 or 5173, outside Electron and outside Vitest/jsdom/Node.
 */
export function isViteBrowserDev(): boolean {
  if (!isViteDevMode()) return false;
  if (isTestEnv()) return false;
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return false;
  if (hasElectronBridge()) return false;

  const protocol = window.location.protocol || '';
  const port = window.location.port || '';
  if (!protocol.startsWith('http') || (port !== '3000' && port !== '5173')) {
    return false;
  }

  if (isJsdomOrNodeUserAgent()) {
    return false;
  }

  return true;
}

/**
 * Resolves either the Vite dev proxy prefix or the direct HTTPS production base URL.
 */
export function resolveDevProxyBase(vitePrefix: string, prodBase: string): string {
  return isViteBrowserDev() ? vitePrefix : prodBase;
}

/**
 * Builds a complete request URL by joining the resolved dev-proxy or production base
 * with an optional path/query suffix without duplicating slashes.
 */
export function buildDevProxyUrl(
  vitePrefix: string,
  prodBase: string,
  pathAndQuery = ''
): string {
  const base = resolveDevProxyBase(vitePrefix, prodBase).replace(/\/+$/, '');
  if (!pathAndQuery) {
    return base;
  }
  if (pathAndQuery.startsWith('/') || pathAndQuery.startsWith('?')) {
    return `${base}${pathAndQuery}`;
  }
  return `${base}/${pathAndQuery}`;
}

/**
 * Resolves the base URL for a named route from `BROWSER_DEV_PROXY_ROUTES`.
 */
export function getDevProxyBaseForRoute(route: BrowserDevProxyRouteKey): string {
  const entry = BROWSER_DEV_PROXY_ROUTES[route];
  return resolveDevProxyBase(entry.proxyPrefix, entry.prodBase);
}

/**
 * Builds a complete request URL for a named route from `BROWSER_DEV_PROXY_ROUTES`.
 */
export function buildDevProxyUrlForRoute(
  route: BrowserDevProxyRouteKey,
  pathAndQuery = ''
): string {
  const entry = BROWSER_DEV_PROXY_ROUTES[route];
  return buildDevProxyUrl(entry.proxyPrefix, entry.prodBase, pathAndQuery);
}
