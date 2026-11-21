import { SearchMatchCandidate } from '../../contracts/override';
import { withTimeoutFallback } from '../../utils/asyncUtils';
import { computeTitleSimilarity } from '../common/titleMatching';
import {
  normalizeTitleKey,
  matchesLooseSearchQuery,
  sanitizeStoreReleaseDate,
} from '../common/titleUtils';
import { igdbCoverService } from '../igdb/igdbCoverService';
import { KNOWN_EPIC_APP_NAMES } from '../integrations/epicCodenames';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { stripHtmlToPlainSynopsis } from '../steam/fallbackMetadataProvider';
import { steamApi } from '../steam/steamApi';
import { steamMatcher, canonicalizeTitleKey } from '../steam/steamMatcher';
import {
  SteamStoreSearchItem,
  LutrisGameSearchItem,
  XboxProductSearchRecord,
  StorefrontSearchSource,
  gogCacheMap,
  steamCacheMap,
  hasGogCacheEntries,
  hasSteamCacheEntries,
  hasKnownEpicAppNames,
  getErrorMessage,
  extractXboxBigId,
  buildCandidateStoreUrl,
  cleanSearchQuery,
  isNonGameAddonTitle,
  getSteamHeaderUrl,
  resolveSteamCandidateCapsuleUrl,
} from './scraperUrlAndQueryUtils';

export interface StorefrontSearchCallbacks {
  querySteamStore: (query: string) => Promise<SteamStoreSearchItem[]>;
  queryLutrisGames: (query: string) => Promise<LutrisGameSearchItem[]>;
}

async function searchSteamStorefront(
  rawQuery: string,
  normQuery: string,
  querySteamStoreFn: (query: string) => Promise<SteamStoreSearchItem[]>
): Promise<SearchMatchCandidate[]> {
  const candidates: SearchMatchCandidate[] = [];
  try {
    // Direct AppID search if query is purely numeric
    if (/^\d{3,8}$/.test(rawQuery)) {
      const numId = parseInt(rawQuery, 10);
      const meta = await steamApi.fetchGameMetadata(numId, Priority.P0_INTERACTIVE);
      if (meta) {
        candidates.push({
          id: `steam-${numId}`,
          source: 'steam',
          title: meta.name,
          steamAppId: numId,
          storeUrl: buildCandidateStoreUrl({
            source: 'steam',
            title: meta.name,
            steamAppId: numId,
          }),
          capsuleImage: resolveSteamCandidateCapsuleUrl(numId),
          headerImage: meta.headerImage || getSteamHeaderUrl(numId),
          confidenceScore: 100,
        });
      }
    }

    // Query Steam storesearch first with the raw query so real store names take precedence
    const items = await querySteamStoreFn(rawQuery);

    // Instant matcher check
    const instantId = steamMatcher.matchGameToSteamInstant(rawQuery);
    if (instantId && !candidates.some((c) => c.steamAppId === instantId)) {
      const cachedSteamName = hasSteamCacheEntries()
        ? steamCacheMap[String(instantId)]?.name
        : undefined;
      const instantTitle =
        items.find((it) => Number(it?.id) === instantId)?.name ||
        steamApi.getCachedMetadata(instantId)?.name ||
        cachedSteamName ||
        rawQuery;

      candidates.push({
        id: `steam-${instantId}`,
        source: 'steam',
        title: instantTitle,
        steamAppId: instantId,
        storeUrl: buildCandidateStoreUrl({
          source: 'steam',
          title: instantTitle,
          steamAppId: instantId,
        }),
        capsuleImage: resolveSteamCandidateCapsuleUrl(instantId),
        headerImage: getSteamHeaderUrl(instantId),
        confidenceScore: 95,
      });
    }

    for (const item of items) {
      if (!item.id || !item.name) continue;
      if (candidates.some((c) => c.steamAppId === item.id)) continue;

      const sim = computeTitleSimilarity(rawQuery, item.name);
      const itemKey = normalizeTitleKey(item.name) || canonicalizeTitleKey(item.name);
      let score = Math.round(sim * 100);
      if (itemKey === normQuery) score += 20;
      else if (matchesLooseSearchQuery(item.name, rawQuery)) score = Math.max(score, 75);

      candidates.push({
        id: `steam-${item.id}`,
        source: 'steam',
        title: item.name,
        steamAppId: item.id,
        storeUrl: buildCandidateStoreUrl({
          source: 'steam',
          title: item.name,
          steamAppId: item.id,
        }),
        capsuleImage: resolveSteamCandidateCapsuleUrl(item.id),
        headerImage: getSteamHeaderUrl(item.id),
        confidenceScore: Math.min(100, score),
      });
    }
  } catch (err: unknown) {
    console.warn('[MetadataScraperService] Steam search error:', getErrorMessage(err));
  }
  return candidates;
}

async function searchIgdbStorefront(
  rawQuery: string,
  normQuery: string,
  queryLutrisGamesFn: (query: string) => Promise<LutrisGameSearchItem[]>
): Promise<SearchMatchCandidate[]> {
  const candidates: SearchMatchCandidate[] = [];
  try {
    const results = await queryLutrisGamesFn(rawQuery);
    for (const item of results) {
      if (!item.name) continue;

      let capsuleImage: string | undefined;
      if (item.coverart && typeof item.coverart === 'string') {
        const m = item.coverart.match(/\/([a-zA-Z0-9_-]+)\.(?:jpg|png|webp)/i);
        if (
          m &&
          !m[1].startsWith('banner_') &&
          !m[1].startsWith('library_capsule') &&
          !m[1].startsWith('header_')
        ) {
          capsuleImage = `https://images.igdb.com/igdb/image/upload/t_cover_big/${m[1]}.jpg`;
        } else if (item.coverart.startsWith('http')) {
          capsuleImage = item.coverart;
        }
      }

      if (!capsuleImage) {
        const instantCover = igdbCoverService.getIgdbCoverInstant(item.name);
        if (instantCover) capsuleImage = instantCover;
      }

      const sim = computeTitleSimilarity(rawQuery, item.name);
      const itemKey = normalizeTitleKey(item.name) || canonicalizeTitleKey(item.name);
      let score = Math.round(sim * 100);
      if (itemKey === normQuery) score += 20;
      else if (matchesLooseSearchQuery(item.name, rawQuery)) score = Math.max(score, 75);

      candidates.push({
        id: `igdb-${item.id || item.slug}`,
        source: 'igdb',
        title: item.name,
        year: item.year,
        igdbId: item.id,
        storeUrl: buildCandidateStoreUrl({
          source: 'igdb',
          title: item.name,
          igdbId: item.slug || item.id,
        }),
        capsuleImage,
        description: item.description,
        confidenceScore: Math.min(100, score),
      });
    }
  } catch (err: unknown) {
    console.warn('[MetadataScraperService] IGDB search error:', getErrorMessage(err));
  }
  return candidates;
}

async function searchGogStorefront(
  rawQuery: string,
  normQuery: string
): Promise<SearchMatchCandidate[]> {
  const candidates: SearchMatchCandidate[] = [];
  try {
    if (hasGogCacheEntries()) {
      for (const [id, entry] of Object.entries(gogCacheMap)) {
        if (!entry?.title) continue;
        const sim = computeTitleSimilarity(rawQuery, entry.title);
        const titleKey = normalizeTitleKey(entry.title) || canonicalizeTitleKey(entry.title);

        const isMatch =
          sim >= 0.4 ||
          titleKey.includes(normQuery) ||
          normQuery.includes(titleKey) ||
          matchesLooseSearchQuery(entry.title, rawQuery) ||
          String(id) === rawQuery;

        if (isMatch) {
          let score = Math.round(sim * 100);
          if (titleKey === normQuery) score = 100;
          else if (titleKey.includes(normQuery) || matchesLooseSearchQuery(entry.title, rawQuery)) {
            score = Math.max(score, 75);
          }

          candidates.push({
            id: `gog-${id}`,
            source: 'gog',
            title: entry.title,
            gogId: id,
            storeUrl: buildCandidateStoreUrl({
              source: 'gog',
              title: entry.title,
              gogId: entry.slug || id,
            }),
            year: entry.releaseDate ? entry.releaseDate.substring(0, 4) : undefined,
            capsuleImage: entry.coverVertical || entry.coverHorizontal,
            headerImage: entry.coverHorizontal || entry.coverVertical,
            description: entry.shortDescription || entry.aboutTheGame,
            confidenceScore: Math.min(100, score),
          });
        }
      }
    }

    // Live GOG Catalog API search with GOG v1 `like:` filter syntax + 0-match recommendation guard
    const cleanGogLike = rawQuery.replace(/^like:/i, '').trim();
    const gogCatalogUrl = `https://catalog.gog.com/v1/catalog?query=${encodeURIComponent(`like:${cleanGogLike}`)}&limit=20&productType=in:game,pack`;
    const gogRes = await requestScheduler.schedule(
      gogCatalogUrl,
      () =>
        fetch(gogCatalogUrl, {
          headers: { Accept: 'application/json' },
          signal:
            typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
              ? AbortSignal.timeout(4000)
              : undefined,
        }),
      Priority.P0_INTERACTIVE,
      'catalog.gog.com'
    );
    if (gogRes && gogRes.ok) {
      const gogJson = (await gogRes.json()) as {
        productCount?: number;
        products?: Array<{
          id?: string | number;
          title?: string;
          slug?: string;
          releaseDate?: string;
          developers?: string[];
          publishers?: string[];
          coverVertical?: string;
          coverHorizontal?: string;
          storeLink?: string;
        }>;
      };
      const hasZeroMatches =
        typeof gogJson?.productCount === 'number' && gogJson.productCount <= 0;
      const products =
        !hasZeroMatches && Array.isArray(gogJson?.products) ? gogJson.products : [];
      for (const prod of products) {
        if (!prod?.id || !prod?.title) continue;
        const orgs = [...(prod.developers || []), ...(prod.publishers || [])];
        if (orgs.some((n) => /^test\s+(?:developer|publisher)$/i.test(String(n || '').trim()))) {
          continue;
        }
        if (isNonGameAddonTitle(prod.title, rawQuery)) continue;
        const sim = computeTitleSimilarity(rawQuery, prod.title);
        const titleKey = normalizeTitleKey(prod.title) || canonicalizeTitleKey(prod.title);
        let score = Math.round(sim * 100);
        if (titleKey === normQuery) score = 100;
        else if (titleKey.includes(normQuery) || matchesLooseSearchQuery(prod.title, rawQuery)) {
          score = Math.max(score, 75);
        }
        if (score < 30) continue;

        candidates.push({
          id: `gog-${prod.id}`,
          source: 'gog',
          title: prod.title,
          gogId: String(prod.id),
          storeUrl:
            prod.storeLink ||
            buildCandidateStoreUrl({
              source: 'gog',
              title: prod.title,
              gogId: prod.slug || prod.id,
            }),
          year: prod.releaseDate ? String(prod.releaseDate).slice(0, 4) : undefined,
          capsuleImage: prod.coverVertical || prod.coverHorizontal,
          headerImage: prod.coverHorizontal || prod.coverVertical,
          confidenceScore: Math.min(100, score),
        });
      }
    }
  } catch (err: unknown) {
    console.warn('[MetadataScraperService] GOG search error:', getErrorMessage(err));
  }
  return candidates;
}

async function searchEpicStorefront(
  rawQuery: string,
  normQuery: string
): Promise<SearchMatchCandidate[]> {
  const candidates: SearchMatchCandidate[] = [];
  if (!hasKnownEpicAppNames()) return candidates;
  try {
    const seenEpicTitles = new Set<string>();
    for (const [key, mapping] of Object.entries(KNOWN_EPIC_APP_NAMES)) {
      if (!mapping.title) continue;
      const titleKey = normalizeTitleKey(mapping.title) || canonicalizeTitleKey(mapping.title);
      if (seenEpicTitles.has(titleKey)) continue;

      const sim = computeTitleSimilarity(rawQuery, mapping.title);
      const isMatch =
        sim >= 0.4 ||
        titleKey.includes(normQuery) ||
        normQuery.includes(titleKey) ||
        matchesLooseSearchQuery(mapping.title, rawQuery);

      if (isMatch) {
        seenEpicTitles.add(titleKey);
        let score = Math.round(sim * 100);
        if (titleKey === normQuery) score = 100;
        else if (titleKey.includes(normQuery) || matchesLooseSearchQuery(mapping.title, rawQuery)) {
          score = Math.max(score, 75);
        }

        candidates.push({
          id: `epic-${key}`,
          source: 'epic',
          title: mapping.title,
          storeUrl: buildCandidateStoreUrl({
            source: 'epic',
            title: mapping.title,
            epicSlug: key,
          }),
          capsuleImage: mapping.capsuleImage || mapping.headerImage,
          headerImage: mapping.headerImage,
          description: mapping.description,
          confidenceScore: Math.min(100, score),
        });
      }
    }
  } catch (err: unknown) {
    console.warn('[MetadataScraperService] Epic local search error:', getErrorMessage(err));
  }
  return candidates;
}

async function searchXboxStorefront(
  rawQuery: string,
  normQuery: string
): Promise<SearchMatchCandidate[]> {
  const candidates: SearchMatchCandidate[] = [];
  try {
    if (
      typeof window !== 'undefined' &&
      typeof window.electronAPI?.fetchXboxProductMetadata === 'function'
    ) {
      const directBigId = extractXboxBigId(rawQuery);
      const xboxRes = await withTimeoutFallback(
        window.electronAPI.fetchXboxProductMetadata({
          xboxProductId: directBigId,
          title: rawQuery,
          query: rawQuery,
          limit: 8,
        }),
        4000,
        null
      );
      const xboxResObj =
        xboxRes && typeof xboxRes === 'object' ? (xboxRes as Record<string, unknown>) : null;
      const xboxProducts: XboxProductSearchRecord[] = Array.isArray(xboxResObj?.results)
        ? (xboxResObj.results as XboxProductSearchRecord[])
        : xboxResObj?.product && typeof xboxResObj.product === 'object'
        ? [xboxResObj.product as XboxProductSearchRecord]
        : xboxResObj && (xboxResObj.title || xboxResObj.name)
        ? [xboxResObj as XboxProductSearchRecord]
        : [];

      for (const prod of xboxProducts) {
        const prodTitle = String(prod?.title || prod?.name || '').trim();
        if (!prodTitle || isNonGameAddonTitle(prodTitle, rawQuery)) continue;

        const resolvedProdBigId = prod.xboxProductId || prod.productId;
        const prodId =
          resolvedProdBigId ||
          directBigId ||
          cleanSearchQuery(prodTitle).replace(/\s+/g, '-').toLowerCase();
        const sim = computeTitleSimilarity(rawQuery, prodTitle);
        const titleKey = normalizeTitleKey(prodTitle) || canonicalizeTitleKey(prodTitle);
        let score = Math.round(sim * 100);
        if (directBigId && String(resolvedProdBigId || '').toUpperCase() === directBigId) {
          score = 100;
        } else if (titleKey === normQuery) {
          score = Math.max(score, 98);
        } else if (
          titleKey.includes(normQuery) ||
          matchesLooseSearchQuery(prodTitle, rawQuery)
        ) {
          score = Math.max(score, 78);
        }

        if (score >= 30) {
          const sanitizedDate = sanitizeStoreReleaseDate(prod.releaseDate);
          candidates.push({
            id: `xbox-${prodId}`,
            source: 'xbox',
            title: prodTitle,
            storeUrl:
              prod.storeUrl ||
              buildCandidateStoreUrl({
                source: 'xbox',
                title: prodTitle,
                xboxProductId: resolvedProdBigId,
              }),
            year: sanitizedDate ? sanitizedDate.slice(0, 4) : undefined,
            capsuleImage:
              prod.capsuleImage ||
              prod.posterUrl ||
              prod.boxArtUrl ||
              prod.headerImage ||
              prod.heroUrl,
            headerImage:
              prod.headerImage ||
              prod.heroUrl ||
              prod.capsuleImage ||
              prod.posterUrl ||
              prod.boxArtUrl,
            description: prod.shortDescription || prod.description,
            confidenceScore: Math.min(100, score),
          });
        }
      }
    }
  } catch (err: unknown) {
    console.warn('[MetadataScraperService] Xbox DisplayCatalog search error:', getErrorMessage(err));
  }
  return candidates;
}

/**
 * Executes storefront searches concurrently across all selected storefronts using `Promise.allSettled`,
 * avoiding sequential waterfall stalls across Steam, IGDB/Lutris, GOG, Epic, and Xbox.
 */
export async function executeParallelStorefrontSearch(
  query: string,
  source: StorefrontSearchSource,
  callbacks: StorefrontSearchCallbacks
): Promise<SearchMatchCandidate[]> {
  const rawQuery = (query || '').trim();
  if (!rawQuery) return [];

  const normQuery = normalizeTitleKey(rawQuery) || canonicalizeTitleKey(rawQuery);
  const tasks: Promise<SearchMatchCandidate[]>[] = [];

  if (source === 'all' || source === 'steam') {
    tasks.push(searchSteamStorefront(rawQuery, normQuery, callbacks.querySteamStore));
  }
  if (source === 'all' || source === 'igdb') {
    tasks.push(searchIgdbStorefront(rawQuery, normQuery, callbacks.queryLutrisGames));
  }
  if (source === 'all' || source === 'gog') {
    tasks.push(searchGogStorefront(rawQuery, normQuery));
  }
  if (source === 'all' || source === 'epic') {
    tasks.push(searchEpicStorefront(rawQuery, normQuery));
  }
  if (source === 'all' || source === 'xbox') {
    tasks.push(searchXboxStorefront(rawQuery, normQuery));
  }

  const settled = await Promise.allSettled(tasks);
  const candidates: SearchMatchCandidate[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled' && Array.isArray(outcome.value)) {
      candidates.push(...outcome.value);
    }
  }

  const deduplicated: SearchMatchCandidate[] = [];
  const seenKeys = new Set<string>();

  for (const cand of candidates) {
    const key = `${cand.source}:${cand.id}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (cand.description) {
      cand.description = stripHtmlToPlainSynopsis(cand.description) || undefined;
    }
    deduplicated.push(cand);
  }

  deduplicated.sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0));

  return deduplicated;
}
