import axios from 'axios';
import {
  BROWSER_DEV_PROXY_ROUTES,
  buildDevProxyUrlForRoute,
  isViteBrowserDev,
} from '../network/browserDevProxy';
import { requestScheduler, Priority } from '../network/requestScheduler';
import {
  SteamStoreSearchItem,
  LutrisGameSearchItem,
  getErrorMessage,
  isNonGameAddonTitle,
} from './scraperUrlAndQueryUtils';

/**
 * Queries Steam Store Search API using Wave 1's browser dev proxy routing (falling back to direct HTTPS)
 * without forbidden browser `Cookie` or `User-Agent` headers.
 */
export async function querySteamStoreItems(query: string): Promise<SteamStoreSearchItem[]> {
  const clean = query.trim();
  if (!clean) return [];

  const fetchStoreItems = async (searchTerm: string): Promise<SteamStoreSearchItem[]> => {
    const pathAndQuery = `/api/storesearch/?term=${encodeURIComponent(searchTerm)}&l=english&cc=US`;
    const urls: string[] = [];
    if (isViteBrowserDev()) {
      urls.push(buildDevProxyUrlForRoute('steamStore', pathAndQuery));
      urls.push(`${BROWSER_DEV_PROXY_ROUTES.steamStore.prodBase}${pathAndQuery}`);
    } else {
      urls.push(`${BROWSER_DEV_PROXY_ROUTES.steamStore.prodBase}${pathAndQuery}`);
    }

    for (const url of urls) {
      try {
        const res = await requestScheduler.schedule(
          url,
          () =>
            axios.get<{ items?: SteamStoreSearchItem[] }>(url, {
              timeout: 6000,
              headers: {
                Accept: 'application/json, text/plain, */*',
              },
            }),
          Priority.P0_INTERACTIVE
        );
        if (res.data?.items && Array.isArray(res.data.items)) {
          return res.data.items.filter(
            (item) => !isNonGameAddonTitle(item?.name || '', searchTerm)
          );
        }
      } catch (err: unknown) {
        console.warn(
          `[MetadataScraperService] Steam store search failed on ${url}:`,
          getErrorMessage(err)
        );
      }
    }
    return [];
  };

  let items = await fetchStoreItems(clean);
  if (query.includes('+') && (!items || items.length === 0)) {
    const plusStripped = query.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();
    if (plusStripped && plusStripped !== clean) {
      items = await fetchStoreItems(plusStripped);
    }
  }
  return items;
}

/**
 * Queries Lutris/IGDB Games Search API using Wave 1's browser dev proxy routing (falling back to direct HTTPS)
 * without forbidden browser `User-Agent` headers.
 */
export async function queryLutrisGameItems(query: string): Promise<LutrisGameSearchItem[]> {
  const clean = query.trim();
  if (!clean) return [];

  const pathAndQuery = `/api/games?search=${encodeURIComponent(clean)}`;
  const urls: string[] = [];
  if (isViteBrowserDev()) {
    urls.push(buildDevProxyUrlForRoute('lutris', pathAndQuery));
    urls.push(`${BROWSER_DEV_PROXY_ROUTES.lutris.prodBase}${pathAndQuery}`);
  } else {
    urls.push(`${BROWSER_DEV_PROXY_ROUTES.lutris.prodBase}${pathAndQuery}`);
  }

  for (const url of urls) {
    try {
      const res = await requestScheduler.schedule(
        url,
        () =>
          axios.get<{ results?: LutrisGameSearchItem[] }>(url, {
            timeout: 6000,
            headers: {
              Accept: 'application/json, text/plain, */*',
            },
          }),
        Priority.P0_INTERACTIVE
      );
      if (res.data?.results && Array.isArray(res.data.results)) {
        return res.data.results.filter((r) => !isNonGameAddonTitle(r?.name || '', clean));
      }
    } catch (err: unknown) {
      console.warn(`[MetadataScraperService] Lutris search failed on ${url}:`, getErrorMessage(err));
    }
  }
  return [];
}
