import axios from 'axios';
import { CanonicalGame } from '../../contracts/game';
import {
  SearchMatchCandidate,
  ScrapedCoverOption,
  ScrapedMetadataBundle,
  MetadataSourceOption,
} from '../../contracts/override';
import {
  steamMatcher,
  computeTitleSimilarity,
  canonicalizeTitleKey,
} from '../steam/steamMatcher';
import { steamApi } from '../steam/steamApi';
import {
  fallbackMetadataProvider,
  extractFirstParagraph,
  stripHtmlToPlainSynopsis,
} from '../steam/fallbackMetadataProvider';
import {
  igdbCoverService,
  isGogCroppedHorizontalCover,
} from '../igdb/igdbCoverService';
import { storefrontReviewHarvester } from '../critic/storefrontReviewHarvester';
import gogEnrichedCache from '../storage/gogEnrichedCache.json';
import steamEnrichedCache from '../storage/steamEnrichedCache.json';
import { FULL_USER_STEAM_GAMES } from '../storage/fullUserSteamGames';
import { GOG_USER_LIBRARY } from '../storage/gogUserLibrary';
import { EPIC_USER_LIBRARY } from '../storage/epicUserLibrary';
import { KNOWN_EPIC_APP_NAMES } from '../integrations/epicCodenames';
import { requestScheduler, Priority } from '../network/requestScheduler';
import { computeEntityMatchConfidence } from '../common/entityResolver';
import { normalizeTitleKey, matchesLooseSearchQuery } from '../common/titleUtils';

/**
 * Builds a direct or search storefront URL for a candidate or metadata source.
 */
export function buildCandidateStoreUrl(params: {
  source: string;
  title: string;
  steamAppId?: number;
  gogId?: string | number;
  epicSlug?: string;
  igdbId?: string | number;
}): string {
  const cleanTitle = (params.title || '').trim();
  const src = (params.source || '').toLowerCase();

  if (src === 'steam') {
    if (params.steamAppId && Number(params.steamAppId) > 0) {
      return `https://store.steampowered.com/app/${params.steamAppId}`;
    }
    return `https://store.steampowered.com/search/?term=${encodeURIComponent(cleanTitle)}`;
  }

  if (src === 'gog') {
    const gogStr =
      params.gogId !== undefined && params.gogId !== null
        ? String(params.gogId).replace(/^gog-/, '').trim()
        : '';
    if (gogStr && !/^\d+$/.test(gogStr)) {
      return `https://www.gog.com/en/game/${gogStr}`;
    }
    return `https://www.gog.com/en/games?query=${encodeURIComponent(cleanTitle)}`;
  }

  if (src === 'epic') {
    const slug = (params.epicSlug || '').replace(/^epic-/, '').trim();
    if (slug && slug.toLowerCase() !== 'epic' && !/^[0-9a-f]{20,}$/i.test(slug)) {
      return `https://store.epicgames.com/en-US/p/${slug}`;
    }
    return `https://store.epicgames.com/en-US/browse?q=${encodeURIComponent(cleanTitle)}`;
  }

  if (src === 'igdb') {
    const igdbStr =
      params.igdbId !== undefined && params.igdbId !== null
        ? String(params.igdbId).replace(/^igdb-/, '').trim()
        : '';
    if (igdbStr && igdbStr.toLowerCase() !== 'igdb' && !/^\d+$/.test(igdbStr)) {
      return `https://www.igdb.com/games/${igdbStr}`;
    }
    return `https://www.igdb.com/search?type=1&q=${encodeURIComponent(cleanTitle)}`;
  }

  return `https://www.google.com/search?q=${encodeURIComponent(cleanTitle + ' game')}`;
}

/**
 * Cleans a user or game search query by stripping punctuation and trademark noise.
 */
export function cleanSearchQuery(query: string): string {
  if (!query) return '';
  return query
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(/[+]/g, ' ')
    .replace(/[:\-–—_]/g, ' ')
    .replace(/[!?,.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deduplicates scraped covers by normalized image URL and filters out server-cropped GOG horizontal covers.
 */
function deduplicateCovers(covers: ScrapedCoverOption[]): ScrapedCoverOption[] {
  const seen = new Set<string>();
  const result: ScrapedCoverOption[] = [];
  for (const c of covers) {
    if (!c.url || !c.url.trim()) continue;
    if (isGogCroppedHorizontalCover(c.url)) continue;
    const norm = c.url.trim().toLowerCase().replace(/^https?:\/\//, '');
    if (seen.has(norm)) continue;
    seen.add(norm);
    result.push(c);
  }
  return result;
}

/**
 * Deduplicates descriptions by normalized plain-text content, stripping any residual HTML tags.
 */
function deduplicateDescriptions(
  descriptions: { source: string; text: string }[]
): { source: string; text: string }[] {
  const seen = new Set<string>();
  const result: { source: string; text: string }[] = [];
  for (const d of descriptions) {
    if (!d.text || !d.text.trim()) continue;
    const plain = stripHtmlToPlainSynopsis(d.text);
    if (!plain) continue;
    const norm = plain.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    result.push({ source: d.source, text: plain });
  }
  return result;
}

/**
 * Resolves a GOG counterpart product ID from candidate, originalGame platform, or exact canonical title match in gogEnrichedCache.
 */
function findGogCounterpartId(
  candidate?: SearchMatchCandidate | null,
  originalGame?: CanonicalGame | null
): string | undefined {
  if (candidate?.gogId) {
    return String(candidate.gogId).replace(/^gog-/, '');
  }
  if (candidate?.source === 'gog' && candidate.id) {
    return String(candidate.id).replace(/^gog-/, '');
  }
  const gogPlat = originalGame?.platforms?.find(
    (p) => p.platformId === 'gog' || p.platformId?.toLowerCase() === 'gog'
  );
  if (gogPlat?.platformGameId) {
    return String(gogPlat.platformGameId).replace(/^gog-/, '');
  }
  const targetTitle = (candidate?.title || originalGame?.title || '').trim();
  if (!targetTitle) return undefined;
  const targetKey = canonicalizeTitleKey(targetTitle);
  if (!targetKey) return undefined;
  for (const [id, entry] of Object.entries(gogEnrichedCache as Record<string, any>)) {
    if (entry?.title && canonicalizeTitleKey(entry.title) === targetKey) {
      return String(id);
    }
  }
  return undefined;
}

const NON_GAME_ADDON_REGEX =
  /\b(soundtrack|ost|artbook|art book|demo|playtest|season pass|expansion pass|upgrade pack|cosmetic pack|voice pack|dedicated server|sdk|mod tools|bonus content|digital goodies|wallpaper|playable teaser|tech beta|public testing)\b/i;

/**
 * Universal helper to detect non-game clutter (DLCs, Soundtracks, Demos, Tools, Bonus Content)
 * when the user's query title does not explicitly ask for those terms.
 */
export function isNonGameAddonTitle(candidateTitle: string, queryTitle: string): boolean {
  if (!candidateTitle) return false;
  if (NON_GAME_ADDON_REGEX.test(queryTitle || '')) return false;
  return NON_GAME_ADDON_REGEX.test(candidateTitle);
}

export class MetadataScraperService {
  private getSteamBaseUrl(): string {
    if (
      typeof window !== 'undefined' &&
      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ) {
      return '/api/steam-store';
    }
    return 'https://store.steampowered.com';
  }

  private getLutrisBaseUrl(): string {
    if (
      typeof window !== 'undefined' &&
      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ) {
      return '/api/lutris';
    }
    return 'https://lutris.net';
  }

  /**
   * Queries Steam Store Search API with fallback support for localhost proxy and direct HTTPS.
   */
  private async querySteamStore(query: string): Promise<any[]> {
    const clean = query.trim();
    if (!clean) return [];

    const fetchStoreItems = async (searchTerm: string): Promise<any[]> => {
      const isLocal =
        typeof window !== 'undefined' &&
        (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

      const urls: string[] = [];
      if (isLocal) {
        urls.push(
          `${this.getSteamBaseUrl()}/api/storesearch/?term=${encodeURIComponent(searchTerm)}&l=english&cc=US`
        );
        urls.push(
          `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(searchTerm)}&l=english&cc=US`
        );
      } else {
        urls.push(
          `${this.getSteamBaseUrl()}/api/storesearch/?term=${encodeURIComponent(searchTerm)}&l=english&cc=US`
        );
      }

      for (const url of urls) {
        try {
          const res = await requestScheduler.schedule(
            url,
            () =>
              axios.get(url, {
                timeout: 6000,
                headers: {
                  Cookie: 'birthtime=568022401; mature_content=1; wants_mature_content=1',
                  'User-Agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  Accept: 'application/json, text/plain, */*',
                },
              }),
            Priority.P0_INTERACTIVE
          );
          if (res.data?.items && Array.isArray(res.data.items)) {
            return res.data.items.filter(
              (item: any) => !isNonGameAddonTitle(item?.name || '', searchTerm)
            );
          }
        } catch (err: any) {
          // Fallback to next URL or log warning
          console.warn(
            `[MetadataScraperService] Steam store search failed on ${url}:`,
            err?.message
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
   * Queries Lutris/IGDB Games Search API with fallback support for localhost proxy and direct HTTPS.
   */
  private async queryLutrisGames(query: string): Promise<any[]> {
    const clean = query.trim();
    if (!clean) return [];

    const isLocal =
      typeof window !== 'undefined' &&
      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

    const urls: string[] = [];
    if (isLocal) {
      urls.push(`${this.getLutrisBaseUrl()}/api/games?search=${encodeURIComponent(clean)}`);
      urls.push(`https://lutris.net/api/games?search=${encodeURIComponent(clean)}`);
    } else {
      urls.push(`${this.getLutrisBaseUrl()}/api/games?search=${encodeURIComponent(clean)}`);
    }

    for (const url of urls) {
      try {
        const res = await requestScheduler.schedule(
          url,
          () =>
            axios.get(url, {
              timeout: 6000,
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Accept: 'application/json, text/plain, */*',
              },
            }),
          Priority.P0_INTERACTIVE
        );
        if (res.data?.results && Array.isArray(res.data.results)) {
          return res.data.results.filter((r: any) => !isNonGameAddonTitle(r?.name || '', clean));
        }
      } catch (err: any) {
        console.warn(`[MetadataScraperService] Lutris search failed on ${url}:`, err?.message);
      }
    }
    return [];
  }

  /**
   * Generates 3-6 top candidate matches combining:
   *  a) Steam store search or instant match from steamMatcher.matchGameToSteamInstant(game.title).
   *  b) IGDB candidates via Lutris API search.
   *  c) GOG catalog search / known GOG games if applicable.
   * Scores and ranks candidates by token similarity so the most likely match is on top.
   * Optionally accepts custom search term, source tab filter, and non-Steam exclusivity toggle.
   */
  async getSuggestedMatches(
    game: CanonicalGame,
    customQuery?: string,
    sourceFilter?: string,
    nonSteamOnly?: boolean
  ): Promise<SearchMatchCandidate[]> {
    if (!game || !game.title) return [];

    const rawSourceTitle =
      game.originalStoreTitle || game.platforms?.[0]?.originalTitle || game.title;
    const effectiveTitle =
      customQuery && customQuery.trim() ? customQuery.trim() : rawSourceTitle;
    const candidates: SearchMatchCandidate[] = [];

    // 1. Steam Existing Ownership or Instant Curated Match (skip if nonSteamOnly is active)
    if (!nonSteamOnly) {
      let matchedSteamAppId: number | null = game.steamAppId || null;
      if (!matchedSteamAppId) {
        matchedSteamAppId = steamMatcher.matchGameToSteamInstant(effectiveTitle);
      }

      if (matchedSteamAppId) {
        const steamCandidateTitle =
          steamApi.getCachedMetadata(matchedSteamAppId)?.name ||
          (steamEnrichedCache as Record<string, any>)[String(matchedSteamAppId)]?.name ||
          FULL_USER_STEAM_GAMES.find((g) => g.steamAppId === matchedSteamAppId)?.title ||
          game.platforms?.find((p) => p.platformId === 'steam')?.originalTitle ||
          rawSourceTitle;

        candidates.push({
          id: `steam-${matchedSteamAppId}`,
          source: 'steam',
          title: steamCandidateTitle,
          steamAppId: matchedSteamAppId,
          storeUrl: buildCandidateStoreUrl({
            source: 'steam',
            title: steamCandidateTitle,
            steamAppId: matchedSteamAppId,
          }),
          capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${matchedSteamAppId}/library_600x900_2x.jpg`,
          headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${matchedSteamAppId}/header.jpg`,
          confidenceScore: 100,
        });
      }
    }

    // 2. Check GOG Platform Ownership
    const gogPlatform = game.platforms?.find((p) => p.platformId === 'gog');
    if (gogPlatform?.platformGameId) {
      const gogData = (gogEnrichedCache as Record<string, any>)[gogPlatform.platformGameId];
      const gogCandidateTitle =
        gogData?.title ||
        gogPlatform.originalTitle ||
        GOG_USER_LIBRARY.find(
          (g) =>
            g.id === gogPlatform.platformGameId ||
            g.platforms?.some(
              (p) => p.platformId === 'gog' && p.platformGameId === gogPlatform.platformGameId
            )
        )?.title ||
        rawSourceTitle;
      const gogStoreUrl = buildCandidateStoreUrl({
        source: 'gog',
        title: gogCandidateTitle,
        gogId: gogPlatform.platformGameId,
      });

      if (gogData) {
        candidates.push({
          id: `gog-${gogPlatform.platformGameId}`,
          source: 'gog',
          title: gogCandidateTitle,
          gogId: gogPlatform.platformGameId,
          storeUrl: gogStoreUrl,
          year: gogData.releaseDate ? gogData.releaseDate.substring(0, 4) : undefined,
          capsuleImage: gogData.coverVertical || gogData.coverHorizontal,
          headerImage: gogData.coverHorizontal || gogData.coverVertical,
          description: gogData.shortDescription || gogData.aboutTheGame,
          confidenceScore: 98,
        });
      } else {
        const instantGogBoxArt = igdbCoverService.getGogVerticalCoverInstant(
          gogPlatform.platformGameId,
          gogCandidateTitle
        );
        const validLocalGogCover =
          game.capsuleImage && !isGogCroppedHorizontalCover(game.capsuleImage, game.headerImage)
            ? game.capsuleImage
            : undefined;
        candidates.push({
          id: `gog-${gogPlatform.platformGameId}`,
          source: 'gog',
          title: gogCandidateTitle,
          gogId: gogPlatform.platformGameId,
          storeUrl: gogStoreUrl,
          year: game.releaseDate ? String(game.releaseDate).substring(0, 4) : undefined,
          capsuleImage: instantGogBoxArt || validLocalGogCover || game.headerImage,
          headerImage: game.headerImage || validLocalGogCover,
          description: game.shortDescription,
          confidenceScore: 98,
        });
      }
    }

    // 3. Check Epic Platform Ownership
    const epicPlatform = game.platforms?.find((p) => p.platformId === 'epic');
    if (epicPlatform?.platformGameId) {
      const epicMapping =
        KNOWN_EPIC_APP_NAMES[epicPlatform.platformGameId] ||
        KNOWN_EPIC_APP_NAMES[epicPlatform.platformGameId.toLowerCase()] ||
        KNOWN_EPIC_APP_NAMES[game.title.toLowerCase()];

      const epicCandidateTitle =
        epicMapping?.title ||
        epicPlatform.originalTitle ||
        EPIC_USER_LIBRARY.find(
          (g) =>
            g.id === epicPlatform.platformGameId ||
            g.platforms?.some(
              (p) => p.platformId === 'epic' && p.platformGameId === epicPlatform.platformGameId
            )
        )?.title ||
        rawSourceTitle;
      const epicStoreUrl = buildCandidateStoreUrl({
        source: 'epic',
        title: epicCandidateTitle,
        epicSlug: epicPlatform.platformGameId,
      });

      if (epicMapping) {
        candidates.push({
          id: `epic-${epicPlatform.platformGameId}`,
          source: 'epic',
          title: epicCandidateTitle,
          storeUrl: epicStoreUrl,
          capsuleImage: epicMapping.capsuleImage || epicMapping.headerImage,
          headerImage: epicMapping.headerImage,
          description: epicMapping.description,
          confidenceScore: 98,
        });
      } else {
        candidates.push({
          id: `epic-${epicPlatform.platformGameId}`,
          source: 'epic',
          title: epicCandidateTitle,
          storeUrl: epicStoreUrl,
          year: game.releaseDate ? String(game.releaseDate).substring(0, 4) : undefined,
          capsuleImage: game.capsuleImage || game.headerImage,
          headerImage: game.headerImage || game.capsuleImage,
          description: game.shortDescription,
          confidenceScore: 98,
        });
      }
    }

    // 4. Concurrently query Storefronts (Steam, IGDB, GOG, Epic)
    try {
      const shouldQuerySteam = !nonSteamOnly && (!sourceFilter || sourceFilter.toLowerCase() === 'all' || sourceFilter.toLowerCase() === 'steam');
      const shouldQueryIgdb = !sourceFilter || sourceFilter.toLowerCase() === 'all' || sourceFilter.toLowerCase() === 'igdb';
      const shouldQueryGog = !sourceFilter || sourceFilter.toLowerCase() === 'all' || sourceFilter.toLowerCase() === 'gog';
      const shouldQueryEpic = !sourceFilter || sourceFilter.toLowerCase() === 'all' || sourceFilter.toLowerCase() === 'epic';

      const searchPromises: Promise<SearchMatchCandidate[]>[] = [];
      if (shouldQuerySteam) searchPromises.push(this.searchStorefronts(effectiveTitle, 'steam').catch(() => []));
      if (shouldQueryIgdb) searchPromises.push(this.searchStorefronts(effectiveTitle, 'igdb').catch(() => []));
      if (shouldQueryGog) searchPromises.push(this.searchStorefronts(effectiveTitle, 'gog').catch(() => []));
      if (shouldQueryEpic) searchPromises.push(this.searchStorefronts(effectiveTitle, 'epic').catch(() => []));

      const results = await Promise.all(searchPromises);
      for (const resList of results) {
        candidates.push(...resList);
      }
    } catch (err: any) {
      console.warn('[MetadataScraperService] Dynamic suggested matches search encountered error:', err?.message);
    }

    // 5. Score, Filter, Deduplicate, and Rank
    const scoredCandidates: SearchMatchCandidate[] = [];
    const seenByKey = new Map<string, SearchMatchCandidate>();

    for (const cand of candidates) {
      if (nonSteamOnly && cand.source === 'steam') continue;
      if (sourceFilter && sourceFilter.toLowerCase() !== 'all' && cand.source.toLowerCase() !== sourceFilter.toLowerCase()) {
        continue;
      }

      const key = `${cand.source}:${cand.id}`;
      const existing = seenByKey.get(key);
      if (existing) {
        if (
          cand.capsuleImage &&
          (!existing.capsuleImage ||
            existing.capsuleImage === existing.headerImage ||
            isGogCroppedHorizontalCover(existing.capsuleImage, existing.headerImage))
        ) {
          existing.capsuleImage = cand.capsuleImage;
        }
        if (cand.headerImage && !existing.headerImage) {
          existing.headerImage = cand.headerImage;
        }
        if (cand.year && !existing.year) {
          existing.year = cand.year;
        }
        if (cand.storeUrl && !existing.storeUrl) {
          existing.storeUrl = cand.storeUrl;
        }
        continue;
      }

      // Multi-vector entity confidence evaluation (title + release year + developers)
      const evaluation = computeEntityMatchConfidence(
        {
          title: effectiveTitle,
          releaseYear: game.releaseDate,
          developers: game.developers,
        },
        {
          title: cand.title,
          releaseYear: cand.year,
        }
      );

      let score = evaluation.confidence;

      const normGame = normalizeTitleKey(effectiveTitle) || canonicalizeTitleKey(effectiveTitle);
      const normCand = normalizeTitleKey(cand.title) || canonicalizeTitleKey(cand.title);

      if (normGame === normCand && !evaluation.isRebootCollision) {
        score = Math.max(score, 96);
      } else if (matchesLooseSearchQuery(cand.title, effectiveTitle) && !evaluation.isRebootCollision) {
        score = Math.max(score, 72);
      }

      // Bonus if candidate has official SteamAppId matching the game
      if (cand.source === 'steam' && game.steamAppId && cand.steamAppId === game.steamAppId) {
        score = 100;
      }

      // Bonus if candidate source matches a platform owned by user
      if (!evaluation.isRebootCollision && game.platforms?.some((p) => p.platformId === cand.source)) {
        score = Math.min(100, score + 8);
      }

      // Bonus if candidate has a valid cover image
      if (!evaluation.isRebootCollision && cand.capsuleImage) {
        score = Math.min(100, score + 2);
      }

      const isAddon = isNonGameAddonTitle(cand.title || '', effectiveTitle);
      if (isAddon) {
        score = Math.max(0, score - 45);
      }

      const finalConfidence = Math.max(0, Math.min(100, score));
      if (isAddon && finalConfidence < 35) {
        continue;
      }

      const scoredEntry: SearchMatchCandidate = {
        ...cand,
        storeUrl:
          cand.storeUrl ||
          buildCandidateStoreUrl({
            source: cand.source,
            title: cand.title,
            steamAppId: cand.steamAppId,
            gogId: cand.gogId,
            epicSlug: cand.source === 'epic' ? String(cand.id) : undefined,
            igdbId: cand.igdbId || cand.id,
          }),
        confidenceScore: finalConfidence,
      };
      seenByKey.set(key, scoredEntry);
      scoredCandidates.push(scoredEntry);
    }

    // Sort by confidenceScore descending
    scoredCandidates.sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0));

    // Return top candidates (if custom query or filter is passed, return up to 20; if default, top 6)
    const limit = (customQuery || (sourceFilter && sourceFilter.toLowerCase() !== 'all')) ? 20 : 6;
    return scoredCandidates.slice(0, limit);
  }

  /**
   * Alias for searchStorefronts for multi-store queries with punctuation-tolerant fallback.
   */
  async searchMultiStore(
    query: string,
    source: 'all' | 'steam' | 'igdb' | 'gog' | 'epic' = 'all'
  ): Promise<SearchMatchCandidate[]> {
    return this.searchStorefronts(query, source);
  }

  /**
   * Searches storefronts (Steam, IGDB, GOG, Epic) for matching games.
   * Keeps primary outgoing storefront queries raw; if the raw query returns 0 candidates
   * with confidence >= 60 and normalizeTitleKey(query) differs from query.trim().toLowerCase(),
   * runs a fallback search with normalizeTitleKey(query) and merges/deduplicates results.
   */
  async searchStorefronts(
    query: string,
    source: 'all' | 'steam' | 'igdb' | 'gog' | 'epic' = 'all'
  ): Promise<SearchMatchCandidate[]> {
    const rawTrimmed = (query || '').trim();
    if (!rawTrimmed) return [];

    const primaryCandidates = await this.executeStorefrontSearch(rawTrimmed, source);
    const hasConfidentPrimary = primaryCandidates.some((c) => (c.confidenceScore ?? 0) >= 60);
    const normalizedFallback = normalizeTitleKey(rawTrimmed);

    if (
      !hasConfidentPrimary &&
      normalizedFallback &&
      normalizedFallback !== rawTrimmed.toLowerCase()
    ) {
      const fallbackCandidates = await this.executeStorefrontSearch(normalizedFallback, source);
      if (fallbackCandidates.length > 0) {
        const mergedMap = new Map<string, SearchMatchCandidate>();
        for (const cand of [...primaryCandidates, ...fallbackCandidates]) {
          const key = `${cand.source}:${cand.id}`;
          const existing = mergedMap.get(key);
          if (!existing || (cand.confidenceScore ?? 0) > (existing.confidenceScore ?? 0)) {
            mergedMap.set(key, cand);
          }
        }
        const merged = Array.from(mergedMap.values());
        merged.sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0));
        return merged;
      }
    }

    return primaryCandidates;
  }

  private async executeStorefrontSearch(
    query: string,
    source: 'all' | 'steam' | 'igdb' | 'gog' | 'epic' = 'all'
  ): Promise<SearchMatchCandidate[]> {
    const rawQuery = (query || '').trim();
    if (!rawQuery) return [];

    const candidates: SearchMatchCandidate[] = [];
    const normQuery = normalizeTitleKey(rawQuery) || canonicalizeTitleKey(rawQuery);

    // --- 1. Steam Search ---
    if (source === 'all' || source === 'steam') {
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
              capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${numId}/library_600x900_2x.jpg`,
              headerImage: meta.headerImage || `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${numId}/header.jpg`,
              confidenceScore: 100,
            });
          }
        }

        // Query Steam storesearch first with the raw query so real store names take precedence
        const items = await this.querySteamStore(rawQuery);

        // Instant matcher check
        const instantId = steamMatcher.matchGameToSteamInstant(rawQuery);
        if (instantId && !candidates.some((c) => c.steamAppId === instantId)) {
          const instantTitle =
            items.find((it: any) => Number(it?.id) === instantId)?.name ||
            steamApi.getCachedMetadata(instantId)?.name ||
            (steamEnrichedCache as Record<string, any>)[String(instantId)]?.name ||
            FULL_USER_STEAM_GAMES.find((g) => g.steamAppId === instantId)?.title ||
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
            capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${instantId}/library_600x900_2x.jpg`,
            headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${instantId}/header.jpg`,
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
            capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${item.id}/library_600x900_2x.jpg`,
            headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${item.id}/header.jpg`,
            confidenceScore: Math.min(100, score),
          });
        }
      } catch (err: any) {
        console.warn('[MetadataScraperService] Steam search error:', err?.message);
      }
    }

    // --- 2. IGDB / Lutris Search ---
    if (source === 'all' || source === 'igdb') {
      try {
        const results = await this.queryLutrisGames(rawQuery);
        for (const item of results) {
          if (!item.name) continue;

          let capsuleImage: string | undefined = undefined;
          if (item.coverart && typeof item.coverart === 'string') {
            const m = item.coverart.match(/\/([a-zA-Z0-9_-]+)\.(?:jpg|png|webp)/i);
            if (m && !m[1].startsWith('banner_') && !m[1].startsWith('library_capsule') && !m[1].startsWith('header_')) {
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
      } catch (err: any) {
        console.warn('[MetadataScraperService] IGDB search error:', err?.message);
      }
    }

    // --- 3. GOG Catalog Search ---
    if (source === 'all' || source === 'gog') {
      try {
        for (const [id, entry] of Object.entries(gogEnrichedCache as Record<string, any>)) {
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

        // Live GOG Catalog API search with raw query
        const gogCatalogUrl = `https://catalog.gog.com/v1/catalog?query=${encodeURIComponent(rawQuery)}&limit=20&productType=in:game,pack`;
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
          const gogJson = await gogRes.json();
          const products = Array.isArray(gogJson?.products) ? gogJson.products : [];
          for (const prod of products) {
            if (!prod?.id || !prod?.title) continue;
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
      } catch (err: any) {
        console.warn('[MetadataScraperService] GOG search error:', err?.message);
      }
    }

    // --- 4. Epic Catalog Search ---
    if (source === 'all' || source === 'epic') {
      try {
        const seenEpicTitles = new Set<string>();

        // Search EPIC_USER_LIBRARY
        for (const game of EPIC_USER_LIBRARY) {
          if (!game.title) continue;
          const titleKey = normalizeTitleKey(game.title) || canonicalizeTitleKey(game.title);
          if (seenEpicTitles.has(titleKey)) continue;

          const sim = computeTitleSimilarity(rawQuery, game.title);
          const isMatch =
            sim >= 0.4 ||
            titleKey.includes(normQuery) ||
            normQuery.includes(titleKey) ||
            matchesLooseSearchQuery(game.title, rawQuery);

          if (isMatch) {
            seenEpicTitles.add(titleKey);
            let score = Math.round(sim * 100);
            if (titleKey === normQuery) score = 100;
            else if (titleKey.includes(normQuery) || matchesLooseSearchQuery(game.title, rawQuery)) {
              score = Math.max(score, 75);
            }

            candidates.push({
              id: `epic-${game.id}`,
              source: 'epic',
              title: game.title,
              storeUrl: buildCandidateStoreUrl({
                source: 'epic',
                title: game.title,
                epicSlug: game.id,
              }),
              year: game.releaseDate ? game.releaseDate.substring(0, 4) : undefined,
              capsuleImage: game.capsuleImage || game.headerImage,
              headerImage: game.headerImage,
              description: game.shortDescription,
              confidenceScore: Math.min(100, score),
            });
          }
        }

        // Search KNOWN_EPIC_APP_NAMES
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
      } catch (err: any) {
        console.warn('[MetadataScraperService] Epic local search error:', err?.message);
      }
    }

    // Deduplicate candidates
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

    // Sort by confidenceScore descending
    deduplicated.sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0));

    return deduplicated;
  }

  /**
   * Scrapes comprehensive match details, assemble multiple portrait covers,
   * multiple synopsis options, cross-storefront metadata sources, and deep metadata.
   */
  async scrapeMatchDetails(
    candidate: SearchMatchCandidate,
    originalGame?: CanonicalGame | null,
    options?: { nonSteamOnly?: boolean }
  ): Promise<ScrapedMetadataBundle> {
    const sortTitle = (candidate.title || originalGame?.title || '')
      .replace(/^(The|A|An)\s+/i, '')
      .trim();

    const crossStoreSteamAppId = options?.nonSteamOnly
      ? undefined
      : candidate.steamAppId ||
        originalGame?.steamAppId ||
        steamMatcher.matchGameToSteamInstant(candidate.title || originalGame?.title || '') ||
        undefined;

    const crossStoreGogId = findGogCounterpartId(candidate, originalGame);

    const buildOriginalMetadataOption = (): MetadataSourceOption | null => {
      if (
        !originalGame ||
        (!originalGame.shortDescription &&
          !originalGame.developers?.length &&
          !originalGame.genres?.length)
      ) {
        return null;
      }
      const origPlat = originalGame.platforms?.[0];
      const origSource = origPlat?.platformId || (originalGame.steamAppId ? 'steam' : 'original');
      const origTitle =
        originalGame.originalStoreTitle || origPlat?.originalTitle || originalGame.title;
      const cleanOrigShort = stripHtmlToPlainSynopsis(originalGame.shortDescription);
      return {
        id: `original-${originalGame.id}`,
        source: 'original',
        sourceLabel: 'Original Library Metadata',
        matchedId: originalGame.id,
        storeUrl: buildCandidateStoreUrl({
          source: origSource,
          title: origTitle,
          steamAppId: originalGame.steamAppId,
          gogId: origSource === 'gog' ? origPlat?.platformGameId : undefined,
          epicSlug: origSource === 'epic' ? origPlat?.platformGameId : undefined,
        }),
        title: originalGame.title,
        shortDescription: cleanOrigShort || undefined,
        detailedDescription: originalGame.detailedDescription || cleanOrigShort,
        availableDescriptions: cleanOrigShort
          ? [{ source: 'Original Library Synopsis', text: cleanOrigShort }]
          : [],
        releaseDate: originalGame.releaseDate,
        developers: originalGame.developers,
        publishers: originalGame.publishers,
        genres: originalGame.genres,
        tags: originalGame.tags,
        headerImage: originalGame.headerImage,
        capsuleImage: originalGame.capsuleImage,
      };
    };

    const buildSteamMetadataOption = (
      appId: number,
      steamMeta: any,
      fallbackTitle: string
    ): MetadataSourceOption => {
      const cleanSteamShort = stripHtmlToPlainSynopsis(steamMeta?.shortDescription);
      const steamFirstPara = extractFirstParagraph(
        steamMeta?.detailedDescription || steamMeta?.aboutTheGame
      );
      const steamDescs = deduplicateDescriptions([
        ...(cleanSteamShort
          ? [{ source: 'Steam Store Synopsis', text: cleanSteamShort }]
          : []),
        ...(steamFirstPara && steamFirstPara !== cleanSteamShort
          ? [{ source: 'Steam Detailed Overview', text: steamFirstPara }]
          : []),
      ]);
      const resolvedTitle = steamMeta?.name || fallbackTitle;
      return {
        id: `steam-${appId}`,
        source: 'steam',
        sourceLabel: 'Steam Store Metadata',
        matchedId: appId,
        steamAppId: appId,
        storeUrl: buildCandidateStoreUrl({
          source: 'steam',
          title: resolvedTitle,
          steamAppId: appId,
        }),
        title: resolvedTitle,
        shortDescription: cleanSteamShort || steamDescs[0]?.text,
        detailedDescription: steamMeta?.detailedDescription || steamMeta?.aboutTheGame,
        availableDescriptions: steamDescs,
        releaseDate: steamMeta?.releaseDate,
        developers: steamMeta?.developers,
        publishers: steamMeta?.publishers,
        genres: steamMeta?.genres,
        tags: steamMeta?.tags,
        headerImage:
          steamMeta?.headerImage ||
          `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
        capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900_2x.jpg`,
      };
    };

    const buildGogMetadataOption = (
      gogId: string,
      gogMeta: any,
      cachedGog: any,
      fallbackTitle: string
    ): MetadataSourceOption | null => {
      if (!gogMeta && !cachedGog) return null;
      const gogLead = stripHtmlToPlainSynopsis(
        gogMeta?.shortDescription || cachedGog?.shortDescription
      );
      const gogFirstPara = extractFirstParagraph(
        gogMeta?.detailedDescription || cachedGog?.aboutTheGame
      );
      const gogDescs = deduplicateDescriptions([
        ...(gogLead ? [{ source: 'GOG Store Synopsis', text: gogLead }] : []),
        ...(gogFirstPara && gogFirstPara !== gogLead
          ? [{ source: 'GOG Detailed Overview', text: gogFirstPara }]
          : []),
      ]);
      const resolvedTitle = cachedGog?.title || fallbackTitle;
      return {
        id: `gog-${gogId}`,
        source: 'gog',
        sourceLabel: 'GOG.com Metadata',
        matchedId: gogId,
        gogId: String(gogId),
        storeUrl: buildCandidateStoreUrl({
          source: 'gog',
          title: resolvedTitle,
          gogId,
        }),
        title: resolvedTitle,
        shortDescription: gogLead || gogDescs[0]?.text,
        detailedDescription: gogMeta?.detailedDescription || cachedGog?.aboutTheGame || gogLead,
        availableDescriptions: gogDescs,
        releaseDate: gogMeta?.releaseDate || cachedGog?.releaseDate,
        developers: gogMeta?.developers || cachedGog?.developers,
        publishers: gogMeta?.publishers || cachedGog?.publishers,
        genres: gogMeta?.genres || cachedGog?.genres,
        tags: gogMeta?.tags || cachedGog?.tags,
        headerImage:
          gogMeta?.headerImage || cachedGog?.coverHorizontal || cachedGog?.coverVertical,
        capsuleImage:
          gogMeta?.capsuleImage || cachedGog?.coverVertical || cachedGog?.coverHorizontal,
      };
    };

    const fetchCrossStoreSteamMeta = async (): Promise<any> => {
      if (!crossStoreSteamAppId) return null;
      try {
        requestScheduler.promoteToInteractive('store.steampowered.com');
        return await Promise.race([
          steamApi.fetchGameMetadata(crossStoreSteamAppId, Priority.P0_INTERACTIVE),
          new Promise<null>((r) => setTimeout(() => r(null), 4000)),
        ]);
      } catch {
        return null;
      }
    };

    // -------------------------------------------------------------
    // 1. MATCHING TO STEAM
    // -------------------------------------------------------------
    if (candidate.source === 'steam') {
      const steamAppId =
        candidate.steamAppId ||
        (typeof candidate.id === 'number'
          ? candidate.id
          : parseInt(String(candidate.id).replace(/^steam-/, ''), 10));

      const cachedGog = crossStoreGogId
        ? (gogEnrichedCache as Record<string, any>)[crossStoreGogId]
        : undefined;

      const [meta, gogMeta] = await Promise.all([
        (async () => {
          if (!steamAppId || isNaN(steamAppId)) return null;
          try {
            requestScheduler.promoteToInteractive('store.steampowered.com');
            return await Promise.race([
              steamApi.fetchGameMetadata(steamAppId, Priority.P0_INTERACTIVE),
              new Promise<null>((r) => setTimeout(() => r(null), 4500)),
            ]);
          } catch (err: any) {
            console.warn(
              `[MetadataScraperService] Failed to fetch Steam metadata for ${steamAppId}:`,
              err?.message
            );
            return null;
          }
        })(),
        (async () => {
          if (!crossStoreGogId) return null;
          if (cachedGog?.shortDescription && cachedGog?.coverVertical) return null;
          try {
            return await Promise.race([
              fallbackMetadataProvider.fetchGogProductMetadata(
                crossStoreGogId,
                candidate.title || originalGame?.title
              ),
              new Promise<null>((r) => setTimeout(() => r(null), 3500)),
            ]);
          } catch {
            return null;
          }
        })(),
      ]);

      const steamPortrait600x900 = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/library_600x900_2x.jpg`;
      const steamCapsule = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/library_capsule.jpg`;

      // 1. Assemble Available Covers
      const rawCovers: ScrapedCoverOption[] = [
        {
          url: steamPortrait600x900,
          source: 'steam',
          label: 'Steam Portrait (600x900)',
          dimensions: '600x900',
        },
        {
          url: steamCapsule,
          source: 'steam',
          label: 'Steam Library Capsule',
          dimensions: 'library_capsule',
        },
      ];

      if (originalGame?.capsuleImage) {
        rawCovers.push({
          url: originalGame.capsuleImage,
          source: 'original',
          label: 'Original Library Cover',
        });
      }

      const gogCoverVertical = gogMeta?.capsuleImage || cachedGog?.coverVertical;
      if (gogCoverVertical) {
        rawCovers.push({
          url: gogCoverVertical,
          source: 'gog',
          label: 'GOG Official Cover',
          dimensions: 'vertical',
        });
      }

      if (originalGame?.platforms) {
        const epicPlat = originalGame.platforms.find((p) => p.platformId === 'epic');
        if (epicPlat?.platformGameId) {
          const epicMapping =
            KNOWN_EPIC_APP_NAMES[epicPlat.platformGameId] ||
            KNOWN_EPIC_APP_NAMES[epicPlat.platformGameId.toLowerCase()] ||
            KNOWN_EPIC_APP_NAMES[originalGame.title.toLowerCase()];
          if (epicMapping?.capsuleImage) {
            rawCovers.push({
              url: epicMapping.capsuleImage,
              source: 'epic',
              label: 'Epic Portrait Cover',
            });
          }
        }
      }

      // Check IGDB cover for fallback / alternative option
      const igdbCover =
        igdbCoverService.getIgdbCoverInstant(candidate.title, steamAppId) ||
        (await Promise.race([
          igdbCoverService
            .fetchIgdbCover(candidate.title, undefined, Priority.P0_INTERACTIVE)
            .catch(() => null),
          new Promise<null>((r) => setTimeout(() => r(null), 3500)),
        ]));

      if (igdbCover) {
        rawCovers.push({
          url: igdbCover,
          source: 'igdb',
          label: 'IGDB Portrait Cover',
          dimensions: 't_cover_big',
        });
      }

      const availableCovers = deduplicateCovers(rawCovers);

      // 2. Assemble Available Descriptions
      const rawDescriptions: { source: string; text: string }[] = [];
      if (meta?.shortDescription) {
        rawDescriptions.push({
          source: 'Steam Store Synopsis',
          text: meta.shortDescription,
        });
      }

      const firstPara = extractFirstParagraph(meta?.detailedDescription || meta?.aboutTheGame);
      if (firstPara && firstPara !== meta?.shortDescription) {
        rawDescriptions.push({
          source: 'Steam Detailed Overview',
          text: firstPara,
        });
      }

      const gogLead = gogMeta?.shortDescription || cachedGog?.shortDescription;
      if (gogLead) {
        rawDescriptions.push({
          source: 'GOG Store Synopsis',
          text: gogLead,
        });
      }
      const gogFirstPara = extractFirstParagraph(
        gogMeta?.detailedDescription || cachedGog?.aboutTheGame
      );
      if (gogFirstPara && gogFirstPara !== gogLead) {
        rawDescriptions.push({
          source: 'GOG Detailed Overview',
          text: gogFirstPara,
        });
      }

      if (originalGame?.shortDescription) {
        rawDescriptions.push({
          source: 'Original Library Synopsis',
          text: originalGame.shortDescription,
        });
      }

      const availableDescriptions = deduplicateDescriptions(rawDescriptions);

      // 3. Assemble Available Metadata Sources
      const availableMetadataSources: MetadataSourceOption[] = [
        buildSteamMetadataOption(steamAppId, meta, candidate.title),
      ];
      if (crossStoreGogId) {
        const gogOption = buildGogMetadataOption(
          crossStoreGogId,
          gogMeta,
          cachedGog,
          meta?.name || candidate.title
        );
        if (gogOption) availableMetadataSources.push(gogOption);
      }
      const origOption = buildOriginalMetadataOption();
      if (origOption) availableMetadataSources.push(origOption);

      let steamAnchor = undefined;
      try {
        steamAnchor =
          (await Promise.race([
            storefrontReviewHarvester.getSteamAnchor(steamAppId),
            new Promise<null>((r) => setTimeout(() => r(null), 3500)),
          ])) || undefined;
      } catch (err: any) {
        console.warn(
          `[MetadataScraperService] Failed to harvest Steam anchor for ${steamAppId}:`,
          err?.message
        );
      }

      return {
        matchedStore: 'steam',
        matchedId: steamAppId,
        title: meta?.name || candidate.title,
        sortTitle: (meta?.name || candidate.title).replace(/^(The|A|An)\s+/i, '').trim(),
        steamAppId: steamAppId,
        capsuleImage: availableCovers[0]?.url || steamPortrait600x900,
        availableCovers,
        headerImage:
          meta?.headerImage ||
          candidate.headerImage ||
          `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/header.jpg`,
        iconUrl: meta?.iconUrl || originalGame?.iconUrl || '',
        shortDescription: stripHtmlToPlainSynopsis(
          meta?.shortDescription ||
            availableDescriptions[0]?.text ||
            originalGame?.shortDescription ||
            ''
        ),
        detailedDescription: meta?.detailedDescription || meta?.aboutTheGame || '',
        availableDescriptions,
        availableMetadataSources,
        developers: meta?.developers?.length ? meta.developers : originalGame?.developers || [],
        publishers: meta?.publishers?.length ? meta.publishers : originalGame?.publishers || [],
        genres: meta?.genres?.length ? meta.genres : originalGame?.genres || [],
        tags: meta?.tags?.length ? meta.tags : originalGame?.tags || [],
        releaseDate: meta?.releaseDate || originalGame?.releaseDate || '',
        storefrontAnchor: steamAnchor,
        metadataRoute: {
          source: 'steam',
          matchedId: steamAppId,
          steamAppId,
          gogId: crossStoreGogId ? String(crossStoreGogId) : undefined,
        },
      };
    }

    // -------------------------------------------------------------
    // 2. MATCHING TO GOG
    // -------------------------------------------------------------
    if (candidate.source === 'gog') {
      const gogId = String(candidate.gogId || candidate.id).replace(/^gog-/, '');
      const cached = (gogEnrichedCache as Record<string, any>)[gogId];

      const [storeMeta, steamMeta] = await Promise.all([
        (async () => {
          try {
            return await Promise.race([
              fallbackMetadataProvider.fetchGogProductMetadata(
                gogId,
                candidate.title || originalGame?.title
              ),
              new Promise<null>((r) => setTimeout(() => r(null), 4000)),
            ]);
          } catch (err: any) {
            console.warn(
              `[MetadataScraperService] GOG metadata fetch failed for ${gogId}:`,
              err?.message
            );
            return null;
          }
        })(),
        fetchCrossStoreSteamMeta(),
      ]);

      const gogVertical = storeMeta?.capsuleImage || cached?.coverVertical || candidate.capsuleImage;
      const rawCovers: ScrapedCoverOption[] = [];

      if (gogVertical) {
        rawCovers.push({
          url: gogVertical,
          source: 'gog',
          label: 'GOG Official Cover',
          dimensions: 'vertical',
        });
      }

      if (crossStoreSteamAppId) {
        rawCovers.push(
          {
            url: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${crossStoreSteamAppId}/library_600x900_2x.jpg`,
            source: 'steam',
            label: 'Steam Portrait (600x900)',
            dimensions: '600x900',
          },
          {
            url: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${crossStoreSteamAppId}/library_capsule.jpg`,
            source: 'steam',
            label: 'Steam Library Capsule',
            dimensions: 'library_capsule',
          }
        );
      }

      if (originalGame?.capsuleImage) {
        rawCovers.push({
          url: originalGame.capsuleImage,
          source: 'original',
          label: 'Original Library Cover',
        });
      }

      const igdbCover = igdbCoverService.getIgdbCoverInstant(candidate.title, crossStoreSteamAppId);
      if (igdbCover) {
        rawCovers.push({
          url: igdbCover,
          source: 'igdb',
          label: 'IGDB Portrait Cover',
          dimensions: 't_cover_big',
        });
      }

      const availableCovers = deduplicateCovers(rawCovers);

      const rawDescriptions: { source: string; text: string }[] = [];
      const gogLead = stripHtmlToPlainSynopsis(
        storeMeta?.shortDescription || cached?.shortDescription
      );
      if (gogLead) {
        rawDescriptions.push({
          source: 'GOG Store Synopsis',
          text: gogLead,
        });
      }

      const firstPara = extractFirstParagraph(storeMeta?.detailedDescription || cached?.aboutTheGame);
      if (firstPara && firstPara !== gogLead) {
        rawDescriptions.push({
          source: 'GOG Detailed Overview',
          text: firstPara,
        });
      }

      if (steamMeta?.shortDescription) {
        rawDescriptions.push({
          source: 'Steam Store Synopsis',
          text: steamMeta.shortDescription,
        });
      }
      const steamFirstPara = extractFirstParagraph(
        steamMeta?.detailedDescription || steamMeta?.aboutTheGame
      );
      if (steamFirstPara && steamFirstPara !== steamMeta?.shortDescription) {
        rawDescriptions.push({
          source: 'Steam Detailed Overview',
          text: steamFirstPara,
        });
      }

      if (originalGame?.shortDescription) {
        rawDescriptions.push({
          source: 'Original Library Synopsis',
          text: originalGame.shortDescription,
        });
      }

      const availableDescriptions = deduplicateDescriptions(rawDescriptions);

      const resolvedTitle = candidate.title || cached?.title || originalGame?.title || '';
      const availableMetadataSources: MetadataSourceOption[] = [];
      const gogOption = buildGogMetadataOption(gogId, storeMeta, cached, resolvedTitle) || {
        id: `gog-${gogId}`,
        source: 'gog',
        sourceLabel: 'GOG.com Metadata',
        matchedId: gogId,
        gogId: String(gogId),
        storeUrl: buildCandidateStoreUrl({
          source: 'gog',
          title: cached?.title || resolvedTitle,
          gogId,
        }),
        title: resolvedTitle,
        shortDescription: gogLead || availableDescriptions[0]?.text,
        detailedDescription: storeMeta?.detailedDescription || cached?.aboutTheGame || '',
        availableDescriptions: deduplicateDescriptions([
          ...(gogLead ? [{ source: 'GOG Store Synopsis', text: gogLead }] : []),
          ...(firstPara && firstPara !== gogLead
            ? [{ source: 'GOG Detailed Overview', text: firstPara }]
            : []),
        ]),
        releaseDate: storeMeta?.releaseDate || cached?.releaseDate,
        developers: storeMeta?.developers || cached?.developers,
        publishers: storeMeta?.publishers || cached?.publishers,
        genres: storeMeta?.genres || cached?.genres,
        tags: storeMeta?.tags || cached?.tags,
        headerImage: storeMeta?.headerImage || cached?.coverHorizontal || candidate.headerImage,
        capsuleImage: gogVertical,
      };
      availableMetadataSources.push(gogOption);

      if (crossStoreSteamAppId) {
        availableMetadataSources.push(
          buildSteamMetadataOption(crossStoreSteamAppId, steamMeta, resolvedTitle)
        );
      }
      const origOption = buildOriginalMetadataOption();
      if (origOption) availableMetadataSources.push(origOption);

      let gogAnchor = undefined;
      try {
        gogAnchor =
          (await Promise.race([
            storefrontReviewHarvester.getGogAnchor(gogId, candidate.title),
            new Promise<null>((r) => setTimeout(() => r(null), 3500)),
          ])) || undefined;
      } catch (err: any) {
        console.warn(
          `[MetadataScraperService] Failed to harvest GOG anchor for ${gogId}:`,
          err?.message
        );
      }

      return {
        matchedStore: 'gog',
        matchedId: gogId,
        title: resolvedTitle,
        sortTitle,
        steamAppId: null, // Non-Steam match explicitly unlinks Steam
        capsuleImage: availableCovers[0]?.url || gogVertical || originalGame?.capsuleImage || '',
        availableCovers,
        headerImage:
          storeMeta?.headerImage ||
          cached?.coverHorizontal ||
          candidate.headerImage ||
          originalGame?.headerImage ||
          '',
        iconUrl: originalGame?.iconUrl || '',
        shortDescription: stripHtmlToPlainSynopsis(
          gogLead || availableDescriptions[0]?.text || originalGame?.shortDescription || ''
        ),
        detailedDescription: storeMeta?.detailedDescription || cached?.aboutTheGame || '',
        availableDescriptions,
        availableMetadataSources,
        developers: storeMeta?.developers || cached?.developers || originalGame?.developers || [],
        publishers: storeMeta?.publishers || cached?.publishers || originalGame?.publishers || [],
        genres: storeMeta?.genres || cached?.genres || originalGame?.genres || [],
        tags: storeMeta?.tags || cached?.tags || originalGame?.tags || [],
        releaseDate:
          storeMeta?.releaseDate || cached?.releaseDate || originalGame?.releaseDate || '',
        storefrontAnchor: gogAnchor,
        metadataRoute: {
          source: 'gog',
          matchedId: gogId,
          steamAppId: crossStoreSteamAppId,
          gogId: String(gogId),
        },
      };
    }

    // -------------------------------------------------------------
    // 3. MATCHING TO EPIC
    // -------------------------------------------------------------
    if (candidate.source === 'epic') {
      const epicId = String(candidate.id).replace(/^epic-/, '');
      const cleanSlug = candidate.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const epicPlatform = originalGame?.platforms?.find((p) => p.platformId === 'epic');
      const epicFetchOpts = {
        appName: epicPlatform?.platformGameId || epicId,
        namespace: (epicPlatform as any)?.namespace,
        catalogItemId: (epicPlatform as any)?.catalogItemId,
        title: candidate.title || originalGame?.title,
      };

      const [storeMeta, steamMeta] = await Promise.all([
        (async () => {
          try {
            let meta = await Promise.race([
              fallbackMetadataProvider.fetchEpicProductMetadata(cleanSlug, epicFetchOpts),
              new Promise<null>((r) => setTimeout(() => r(null), 4500)),
            ]);
            if (!meta) {
              meta = await Promise.race([
                fallbackMetadataProvider.fetchEpicProductMetadata(epicId, epicFetchOpts),
                new Promise<null>((r) => setTimeout(() => r(null), 4500)),
              ]);
            }
            return meta;
          } catch (err: any) {
            console.warn(
              `[MetadataScraperService] Epic metadata fetch failed for ${candidate.title}:`,
              err?.message
            );
            return null;
          }
        })(),
        fetchCrossStoreSteamMeta(),
      ]);

      const epicVertical = storeMeta?.capsuleImage || candidate.capsuleImage;
      const rawCovers: ScrapedCoverOption[] = [];

      if (epicVertical) {
        rawCovers.push({
          url: epicVertical,
          source: 'epic',
          label: 'Epic Portrait Cover',
        });
      }

      if (crossStoreSteamAppId) {
        rawCovers.push(
          {
            url: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${crossStoreSteamAppId}/library_600x900_2x.jpg`,
            source: 'steam',
            label: 'Steam Portrait (600x900)',
            dimensions: '600x900',
          },
          {
            url: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${crossStoreSteamAppId}/library_capsule.jpg`,
            source: 'steam',
            label: 'Steam Library Capsule',
            dimensions: 'library_capsule',
          }
        );
      }

      if (originalGame?.capsuleImage) {
        rawCovers.push({
          url: originalGame.capsuleImage,
          source: 'original',
          label: 'Original Library Cover',
        });
      }

      if (crossStoreGogId) {
        const cachedGog = (gogEnrichedCache as Record<string, any>)[crossStoreGogId];
        if (cachedGog?.coverVertical) {
          rawCovers.push({
            url: cachedGog.coverVertical,
            source: 'gog',
            label: 'GOG Official Cover',
            dimensions: 'vertical',
          });
        }
      }

      const igdbCover = igdbCoverService.getIgdbCoverInstant(candidate.title, crossStoreSteamAppId);
      if (igdbCover) {
        rawCovers.push({
          url: igdbCover,
          source: 'igdb',
          label: 'IGDB Portrait Cover',
          dimensions: 't_cover_big',
        });
      }

      const availableCovers = deduplicateCovers(rawCovers);

      const rawDescriptions: { source: string; text: string }[] = [];
      const epicShort = stripHtmlToPlainSynopsis(
        storeMeta?.shortDescription || candidate.description
      );
      if (epicShort) {
        rawDescriptions.push({
          source: 'Epic Store Synopsis',
          text: epicShort,
        });
      }

      const firstPara = extractFirstParagraph(
        storeMeta?.detailedDescription || storeMeta?.aboutTheGame
      );
      if (firstPara && firstPara !== epicShort) {
        rawDescriptions.push({
          source: 'Epic Detailed Overview',
          text: firstPara,
        });
      }

      if (steamMeta?.shortDescription) {
        rawDescriptions.push({
          source: 'Steam Store Synopsis',
          text: steamMeta.shortDescription,
        });
      }
      const steamFirstPara = extractFirstParagraph(
        steamMeta?.detailedDescription || steamMeta?.aboutTheGame
      );
      if (steamFirstPara && steamFirstPara !== steamMeta?.shortDescription) {
        rawDescriptions.push({
          source: 'Steam Detailed Overview',
          text: steamFirstPara,
        });
      }

      if (originalGame?.shortDescription) {
        rawDescriptions.push({
          source: 'Original Library Synopsis',
          text: originalGame.shortDescription,
        });
      }

      const availableDescriptions = deduplicateDescriptions(rawDescriptions);

      const resolvedTitle = candidate.title || originalGame?.title || '';
      const epicDescs = deduplicateDescriptions([
        ...(epicShort ? [{ source: 'Epic Store Synopsis', text: epicShort }] : []),
        ...(firstPara && firstPara !== epicShort
          ? [{ source: 'Epic Detailed Overview', text: firstPara }]
          : []),
      ]);
      const verifiedEpicSlug =
        !/^[0-9a-f]{20,}$/i.test(epicId) && !epicId.startsWith('search-') && epicId !== cleanSlug
          ? epicId
          : undefined;
      const availableMetadataSources: MetadataSourceOption[] = [
        {
          id: `epic-${epicId}`,
          source: 'epic',
          sourceLabel: 'Epic Games Store',
          matchedId: epicId,
          epicSlug: verifiedEpicSlug || cleanSlug || String(epicId),
          storeUrl:
            candidate.storeUrl ||
            buildCandidateStoreUrl({
              source: 'epic',
              title: resolvedTitle,
              epicSlug: verifiedEpicSlug,
            }),
          title: resolvedTitle,
          shortDescription: epicShort || epicDescs[0]?.text,
          detailedDescription: storeMeta?.detailedDescription || candidate.description || '',
          availableDescriptions: epicDescs,
          releaseDate:
            storeMeta?.releaseDate || (candidate.year ? String(candidate.year) : undefined),
          developers: storeMeta?.developers,
          publishers: storeMeta?.publishers,
          genres: storeMeta?.genres,
          tags: storeMeta?.tags,
          headerImage: storeMeta?.headerImage || candidate.headerImage,
          capsuleImage: epicVertical,
        },
      ];

      if (crossStoreSteamAppId) {
        availableMetadataSources.push(
          buildSteamMetadataOption(crossStoreSteamAppId, steamMeta, resolvedTitle)
        );
      }
      if (crossStoreGogId) {
        const cachedGog = (gogEnrichedCache as Record<string, any>)[crossStoreGogId];
        const gogOption = buildGogMetadataOption(crossStoreGogId, null, cachedGog, resolvedTitle);
        if (gogOption) availableMetadataSources.push(gogOption);
      }
      const origOption = buildOriginalMetadataOption();
      if (origOption) availableMetadataSources.push(origOption);

      return {
        matchedStore: 'epic',
        matchedId: epicId,
        title: resolvedTitle,
        sortTitle,
        steamAppId: null, // Non-Steam match explicitly unlinks Steam
        capsuleImage: availableCovers[0]?.url || epicVertical || originalGame?.capsuleImage || '',
        availableCovers,
        headerImage:
          storeMeta?.headerImage ||
          candidate.headerImage ||
          originalGame?.headerImage ||
          '',
        iconUrl: storeMeta?.iconUrl || originalGame?.iconUrl || '',
        shortDescription: stripHtmlToPlainSynopsis(
          epicShort || availableDescriptions[0]?.text || originalGame?.shortDescription || ''
        ),
        detailedDescription: storeMeta?.detailedDescription || candidate.description || '',
        availableDescriptions,
        availableMetadataSources,
        developers: storeMeta?.developers || originalGame?.developers || [],
        publishers: storeMeta?.publishers || originalGame?.publishers || [],
        genres: storeMeta?.genres || originalGame?.genres || [],
        tags: storeMeta?.tags || originalGame?.tags || [],
        releaseDate:
          storeMeta?.releaseDate ||
          (candidate.year ? String(candidate.year) : originalGame?.releaseDate || ''),
        metadataRoute: {
          source: 'epic',
          matchedId: epicId,
          steamAppId: crossStoreSteamAppId,
          gogId: crossStoreGogId ? String(crossStoreGogId) : undefined,
        },
      };
    }

    // -------------------------------------------------------------
    // 4. MATCHING TO IGDB / NON-STEAM GAMES
    // -------------------------------------------------------------
    const [igdbCover, steamMeta] = await Promise.all([
      (async () => {
        return (
          candidate.capsuleImage ||
          igdbCoverService.getIgdbCoverInstant(candidate.title, crossStoreSteamAppId) ||
          (await Promise.race([
            igdbCoverService
              .fetchIgdbCover(candidate.title, undefined, Priority.P0_INTERACTIVE)
              .catch(() => null),
            new Promise<null>((r) => setTimeout(() => r(null), 3500)),
          ]))
        );
      })(),
      fetchCrossStoreSteamMeta(),
    ]);

    const rawCovers: ScrapedCoverOption[] = [];
    if (igdbCover) {
      rawCovers.push({
        url: igdbCover,
        source: 'igdb',
        label: 'IGDB Portrait Cover',
        dimensions: 't_cover_big',
      });
    }

    if (crossStoreSteamAppId) {
      rawCovers.push(
        {
          url: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${crossStoreSteamAppId}/library_600x900_2x.jpg`,
          source: 'steam',
          label: 'Steam Portrait (600x900)',
          dimensions: '600x900',
        },
        {
          url: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${crossStoreSteamAppId}/library_capsule.jpg`,
          source: 'steam',
          label: 'Steam Library Capsule',
          dimensions: 'library_capsule',
        }
      );
    }

    if (originalGame?.capsuleImage) {
      rawCovers.push({
        url: originalGame.capsuleImage,
        source: 'original',
        label: 'Original Library Cover',
      });
    }

    if (crossStoreGogId) {
      const cachedGog = (gogEnrichedCache as Record<string, any>)[crossStoreGogId];
      if (cachedGog?.coverVertical) {
        rawCovers.push({
          url: cachedGog.coverVertical,
          source: 'gog',
          label: 'GOG Official Cover',
          dimensions: 'vertical',
        });
      }
    }

    if (originalGame?.platforms) {
      const epicPlat = originalGame.platforms.find((p) => p.platformId === 'epic');
      if (epicPlat?.platformGameId) {
        const epicMapping =
          KNOWN_EPIC_APP_NAMES[epicPlat.platformGameId] ||
          KNOWN_EPIC_APP_NAMES[epicPlat.platformGameId.toLowerCase()] ||
          KNOWN_EPIC_APP_NAMES[originalGame.title.toLowerCase()];
        if (epicMapping?.capsuleImage) {
          rawCovers.push({
            url: epicMapping.capsuleImage,
            source: 'epic',
            label: 'Epic Portrait Cover',
          });
        }
      }
    }

    const availableCovers = deduplicateCovers(rawCovers);

    const rawDescriptions: { source: string; text: string }[] = [];
    const cleanIgdbDesc = stripHtmlToPlainSynopsis(candidate.description);
    if (cleanIgdbDesc) {
      rawDescriptions.push({
        source: 'IGDB Overview',
        text: cleanIgdbDesc,
      });
    }

    if (steamMeta?.shortDescription) {
      rawDescriptions.push({
        source: 'Steam Store Synopsis',
        text: steamMeta.shortDescription,
      });
    }
    const steamFirstPara = extractFirstParagraph(
      steamMeta?.detailedDescription || steamMeta?.aboutTheGame
    );
    if (steamFirstPara && steamFirstPara !== steamMeta?.shortDescription) {
      rawDescriptions.push({
        source: 'Steam Detailed Overview',
        text: steamFirstPara,
      });
    }

    if (originalGame?.shortDescription) {
      rawDescriptions.push({
        source: 'Original Library Synopsis',
        text: originalGame.shortDescription,
      });
    }

    const availableDescriptions = deduplicateDescriptions(rawDescriptions);

    const matchedIgdbId = candidate.igdbId || candidate.id;
    const availableMetadataSources: MetadataSourceOption[] = [
      {
        id: String(candidate.id).startsWith('igdb-') ? String(candidate.id) : `igdb-${matchedIgdbId}`,
        source: 'igdb',
        sourceLabel: 'IGDB Metadata',
        matchedId: matchedIgdbId,
        igdbId: matchedIgdbId,
        storeUrl:
          candidate.storeUrl ||
          buildCandidateStoreUrl({
            source: 'igdb',
            title: candidate.title,
            igdbId: matchedIgdbId,
          }),
        title: candidate.title,
        shortDescription: cleanIgdbDesc || undefined,
        detailedDescription: candidate.description,
        availableDescriptions: cleanIgdbDesc
          ? [{ source: 'IGDB Overview', text: cleanIgdbDesc }]
          : [],
        releaseDate: candidate.year ? String(candidate.year) : undefined,
        capsuleImage: igdbCover || candidate.capsuleImage,
        headerImage: candidate.headerImage || igdbCover || candidate.capsuleImage,
      },
    ];

    if (crossStoreSteamAppId) {
      availableMetadataSources.push(
        buildSteamMetadataOption(crossStoreSteamAppId, steamMeta, candidate.title)
      );
    }
    if (crossStoreGogId) {
      const cachedGog = (gogEnrichedCache as Record<string, any>)[crossStoreGogId];
      const gogOption = buildGogMetadataOption(crossStoreGogId, null, cachedGog, candidate.title);
      if (gogOption) availableMetadataSources.push(gogOption);
    }
    const origOption = buildOriginalMetadataOption();
    if (origOption) availableMetadataSources.push(origOption);

    return {
      matchedStore: 'igdb',
      matchedId: matchedIgdbId,
      title: candidate.title,
      sortTitle,
      steamAppId: null, // null explicitly unlinks Steam for non-Steam games
      igdbId: matchedIgdbId,
      capsuleImage: availableCovers[0]?.url || originalGame?.capsuleImage || '',
      availableCovers,
      headerImage: candidate.headerImage || originalGame?.headerImage || availableCovers[0]?.url || '',
      iconUrl: originalGame?.iconUrl || '',
      shortDescription: stripHtmlToPlainSynopsis(
        cleanIgdbDesc || availableDescriptions[0]?.text || originalGame?.shortDescription || ''
      ),
      detailedDescription:
        candidate.description || originalGame?.detailedDescription || originalGame?.shortDescription || '',
      availableDescriptions,
      availableMetadataSources,
      developers: originalGame?.developers || [],
      publishers: originalGame?.publishers || [],
      genres: originalGame?.genres || [],
      tags: ['IGDB Matched', ...(originalGame?.tags || [])],
      releaseDate: candidate.year ? String(candidate.year) : originalGame?.releaseDate || '',
      metadataRoute: {
        source: 'igdb',
        matchedId: matchedIgdbId,
        steamAppId: crossStoreSteamAppId,
        gogId: crossStoreGogId ? String(crossStoreGogId) : undefined,
        igdbId: matchedIgdbId,
      },
    };
  }

  /**
   * Searches across storefronts and IGDB for cover art options matching a custom query and source filter.
   */
  async searchCoverOptions(
    query: string,
    sourceFilter: string = 'All',
    game?: CanonicalGame | null
  ): Promise<ScrapedCoverOption[]> {
    const effectiveQuery = (query && query.trim()) || game?.title?.trim() || '';
    if (!effectiveQuery) return [];

    const normalizedFilter = (sourceFilter || 'all').toLowerCase();
    const filter: 'all' | 'steam' | 'igdb' | 'gog' | 'epic' =
      normalizedFilter === 'steam' ||
      normalizedFilter === 'igdb' ||
      normalizedFilter === 'gog' ||
      normalizedFilter === 'epic'
        ? normalizedFilter
        : 'all';

    const [candidates, directIgdbCover] = await Promise.all([
      this.searchStorefronts(effectiveQuery, filter).catch(() => [] as SearchMatchCandidate[]),
      filter === 'all' || filter === 'igdb'
        ? Promise.race([
            igdbCoverService
              .fetchIgdbCover(effectiveQuery, undefined, Priority.P0_INTERACTIVE)
              .catch(() => null),
            new Promise<null>((r) => setTimeout(() => r(null), 4000)),
          ])
        : Promise.resolve(null),
    ]);

    const rawCovers: ScrapedCoverOption[] = [];

    for (const cand of candidates) {
      if (cand.source === 'steam' && cand.steamAppId) {
        rawCovers.push(
          {
            url: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${cand.steamAppId}/library_600x900_2x.jpg`,
            source: 'steam',
            label: `Steam Portrait — ${cand.title}`,
            dimensions: '600x900',
          },
          {
            url: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${cand.steamAppId}/library_capsule.jpg`,
            source: 'steam',
            label: `Steam Capsule — ${cand.title}`,
            dimensions: 'library_capsule',
          }
        );
      } else if (cand.source === 'gog' && cand.capsuleImage) {
        rawCovers.push({
          url: cand.capsuleImage,
          source: 'gog',
          label: `GOG Cover — ${cand.title}`,
          dimensions: 'vertical',
        });
      } else if (cand.source === 'epic' && cand.capsuleImage) {
        rawCovers.push({
          url: cand.capsuleImage,
          source: 'epic',
          label: `Epic Cover — ${cand.title}`,
        });
      } else if (cand.source === 'igdb' && cand.capsuleImage) {
        rawCovers.push({
          url: cand.capsuleImage,
          source: 'igdb',
          label: `IGDB Cover — ${cand.title}`,
          dimensions: 't_cover_big',
        });
      }
    }

    if (directIgdbCover) {
      rawCovers.push({
        url: directIgdbCover,
        source: 'igdb',
        label: `IGDB Cover — ${effectiveQuery.trim()}`,
        dimensions: 't_cover_big',
      });
    }

    if (game?.capsuleImage && filter === 'all') {
      rawCovers.push({
        url: game.capsuleImage,
        source: 'original',
        label: 'Original Library Cover',
      });
    }

    return deduplicateCovers(rawCovers);
  }

  /**
   * Searches across storefronts for structured MetadataSourceOption bundles matching a query and source filter.
   */
  async searchMetadataSources(
    query: string,
    sourceFilter: string = 'All',
    game?: CanonicalGame | null
  ): Promise<MetadataSourceOption[]> {
    const effectiveQuery = (query && query.trim()) || game?.title?.trim() || '';
    if (!effectiveQuery) return [];

    const normalizedFilter = (sourceFilter || 'all').toLowerCase();
    const filter: 'all' | 'steam' | 'igdb' | 'gog' | 'epic' =
      normalizedFilter === 'steam' ||
      normalizedFilter === 'igdb' ||
      normalizedFilter === 'gog' ||
      normalizedFilter === 'epic'
        ? normalizedFilter
        : 'all';

    const candidates = await this.searchStorefronts(effectiveQuery, filter).catch(
      () => [] as SearchMatchCandidate[]
    );

    let selectedCandidates: SearchMatchCandidate[] = [];
    if (filter === 'all') {
      const sourcesOrder: Array<'steam' | 'gog' | 'epic' | 'igdb'> = [
        'steam',
        'gog',
        'epic',
        'igdb',
      ];
      const pickedKeys = new Set<string>();
      for (const src of sourcesOrder) {
        const topForSrc = candidates.find((c) => c.source === src);
        if (topForSrc) {
          selectedCandidates.push(topForSrc);
          pickedKeys.add(`${topForSrc.source}:${topForSrc.id}`);
        }
      }
      for (const cand of candidates) {
        if (selectedCandidates.length >= 6) break;
        const key = `${cand.source}:${cand.id}`;
        if (!pickedKeys.has(key)) {
          selectedCandidates.push(cand);
          pickedKeys.add(key);
        }
      }
    } else {
      selectedCandidates = candidates.slice(0, 6);
    }

    const builtOptions = await Promise.all(
      selectedCandidates.map(async (cand): Promise<MetadataSourceOption | null> => {
        if (cand.source === 'steam') {
          const appId =
            cand.steamAppId ||
            (typeof cand.id === 'number'
              ? cand.id
              : parseInt(String(cand.id).replace(/^steam-/, ''), 10));
          if (!appId || isNaN(appId)) return null;

          let meta = null;
          try {
            requestScheduler.promoteToInteractive('store.steampowered.com');
            meta = await Promise.race([
              steamApi.fetchGameMetadata(appId, Priority.P0_INTERACTIVE),
              new Promise<null>((r) => setTimeout(() => r(null), 3500)),
            ]);
          } catch {
            meta = null;
          }

          const firstPara = extractFirstParagraph(
            meta?.detailedDescription || meta?.aboutTheGame
          );
          const descs = deduplicateDescriptions([
            ...(meta?.shortDescription
              ? [{ source: 'Steam Store Synopsis', text: meta.shortDescription }]
              : []),
            ...(firstPara && firstPara !== meta?.shortDescription
              ? [{ source: 'Steam Detailed Overview', text: firstPara }]
              : []),
          ]);

          const resolvedName = meta?.name || cand.title;
          return {
            id: `steam-${appId}`,
            source: 'steam',
            sourceLabel: `Steam Store Metadata — ${resolvedName}`,
            matchedId: appId,
            steamAppId: appId,
            storeUrl:
              cand.storeUrl ||
              buildCandidateStoreUrl({
                source: 'steam',
                title: resolvedName,
                steamAppId: appId,
              }),
            title: resolvedName,
            shortDescription:
              stripHtmlToPlainSynopsis(
                meta?.shortDescription || descs[0]?.text || cand.description
              ) || undefined,
            detailedDescription:
              meta?.detailedDescription ||
              meta?.aboutTheGame ||
              meta?.shortDescription ||
              cand.description,
            availableDescriptions: descs,
            releaseDate: meta?.releaseDate || (cand.year ? String(cand.year) : undefined),
            developers: meta?.developers,
            publishers: meta?.publishers,
            genres: meta?.genres,
            tags: meta?.tags,
            headerImage:
              meta?.headerImage ||
              cand.headerImage ||
              `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
            capsuleImage:
              cand.capsuleImage ||
              `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900_2x.jpg`,
          };
        }

        if (cand.source === 'gog') {
          const gogId = String(cand.gogId || cand.id).replace(/^gog-/, '');
          const cached = (gogEnrichedCache as Record<string, any>)[gogId];
          let storeMeta = null;
          if (!cached?.shortDescription) {
            try {
              storeMeta = await Promise.race([
                fallbackMetadataProvider.fetchGogProductMetadata(
                  gogId,
                  cand.title || game?.title
                ),
                new Promise<null>((r) => setTimeout(() => r(null), 3500)),
              ]);
            } catch {
              storeMeta = null;
            }
          }

          const gogLead = stripHtmlToPlainSynopsis(
            storeMeta?.shortDescription || cached?.shortDescription || cand.description
          );
          const firstPara = extractFirstParagraph(
            storeMeta?.detailedDescription || cached?.aboutTheGame
          );
          const descs = deduplicateDescriptions([
            ...(gogLead ? [{ source: 'GOG Store Synopsis', text: gogLead }] : []),
            ...(firstPara && firstPara !== gogLead
              ? [{ source: 'GOG Detailed Overview', text: firstPara }]
              : []),
          ]);

          const resolvedGogTitle = cand.title || cached?.title || '';
          return {
            id: `gog-${gogId}`,
            source: 'gog',
            sourceLabel: `GOG.com Metadata — ${cand.title}`,
            matchedId: gogId,
            gogId,
            storeUrl:
              cand.storeUrl ||
              buildCandidateStoreUrl({
                source: 'gog',
                title: resolvedGogTitle,
                gogId,
              }),
            title: resolvedGogTitle,
            shortDescription: gogLead || descs[0]?.text,
            detailedDescription:
              storeMeta?.detailedDescription || cached?.aboutTheGame || gogLead,
            availableDescriptions: descs,
            releaseDate:
              storeMeta?.releaseDate ||
              cached?.releaseDate ||
              (cand.year ? String(cand.year) : undefined),
            developers: storeMeta?.developers || cached?.developers,
            publishers: storeMeta?.publishers || cached?.publishers,
            genres: storeMeta?.genres || cached?.genres,
            tags: storeMeta?.tags || cached?.tags,
            headerImage:
              storeMeta?.headerImage || cached?.coverHorizontal || cand.headerImage,
            capsuleImage:
              storeMeta?.capsuleImage || cached?.coverVertical || cand.capsuleImage,
          };
        }

        if (cand.source === 'epic') {
          const epicId = String(cand.id).replace(/^epic-/, '');
          const cleanSlug = cand.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');

          let storeMeta = null;
          try {
            storeMeta = await Promise.race([
              fallbackMetadataProvider.fetchEpicProductMetadata(cleanSlug),
              new Promise<null>((r) => setTimeout(() => r(null), 3000)),
            ]);
          } catch {
            storeMeta = null;
          }

          const epicShort = stripHtmlToPlainSynopsis(
            storeMeta?.shortDescription || cand.description
          );
          const firstPara = extractFirstParagraph(
            storeMeta?.detailedDescription || storeMeta?.aboutTheGame
          );
          const descs = deduplicateDescriptions([
            ...(epicShort ? [{ source: 'Epic Store Synopsis', text: epicShort }] : []),
            ...(firstPara && firstPara !== epicShort
              ? [{ source: 'Epic Detailed Overview', text: firstPara }]
              : []),
          ]);

          return {
            id: String(cand.id).startsWith('epic-') ? String(cand.id) : `epic-${cand.id}`,
            source: 'epic',
            sourceLabel: `Epic Games Store — ${cand.title}`,
            matchedId: epicId,
            epicSlug: cleanSlug || String(epicId),
            storeUrl:
              cand.storeUrl ||
              buildCandidateStoreUrl({
                source: 'epic',
                title: cand.title,
                epicSlug: cleanSlug || String(epicId),
              }),
            title: cand.title,
            shortDescription: epicShort || descs[0]?.text,
            detailedDescription: storeMeta?.detailedDescription || epicShort,
            availableDescriptions: descs,
            releaseDate:
              storeMeta?.releaseDate || (cand.year ? String(cand.year) : undefined),
            developers: storeMeta?.developers,
            publishers: storeMeta?.publishers,
            genres: storeMeta?.genres,
            tags: storeMeta?.tags,
            headerImage: storeMeta?.headerImage || cand.headerImage,
            capsuleImage: storeMeta?.capsuleImage || cand.capsuleImage,
          };
        }

        // IGDB candidate
        const cleanCandDesc = stripHtmlToPlainSynopsis(cand.description);
        return {
          id: String(cand.id),
          source: 'igdb',
          sourceLabel: `IGDB Metadata — ${cand.title}`,
          matchedId: cand.igdbId || cand.id,
          igdbId: cand.igdbId || cand.id,
          storeUrl:
            cand.storeUrl ||
            buildCandidateStoreUrl({
              source: 'igdb',
              title: cand.title,
              igdbId: cand.igdbId || cand.id,
            }),
          title: cand.title,
          shortDescription: cleanCandDesc || undefined,
          detailedDescription: cand.description,
          availableDescriptions: cleanCandDesc
            ? [{ source: 'IGDB Overview', text: cleanCandDesc }]
            : [],
          releaseDate: cand.year ? String(cand.year) : undefined,
          capsuleImage: cand.capsuleImage,
          headerImage: cand.headerImage || cand.capsuleImage,
        };
      })
    );

    const results: MetadataSourceOption[] = [];
    const seenIds = new Set<string>();
    for (const opt of builtOptions) {
      if (!opt || seenIds.has(opt.id)) continue;
      seenIds.add(opt.id);
      results.push(opt);
    }

    if (
      filter === 'all' &&
      game &&
      (game.shortDescription || game.developers?.length || game.genres?.length)
    ) {
      const origId = `original-${game.id}`;
      if (!seenIds.has(origId)) {
        const origPlat = game.platforms?.[0];
        const origSource = origPlat?.platformId || (game.steamAppId ? 'steam' : 'original');
        const origTitle =
          game.originalStoreTitle || origPlat?.originalTitle || game.title;
        const cleanGameShort = stripHtmlToPlainSynopsis(game.shortDescription);
        results.push({
          id: origId,
          source: 'original',
          sourceLabel: 'Original Library Metadata',
          matchedId: game.id,
          storeUrl: buildCandidateStoreUrl({
            source: origSource,
            title: origTitle,
            steamAppId: game.steamAppId,
            gogId: origSource === 'gog' ? origPlat?.platformGameId : undefined,
            epicSlug: origSource === 'epic' ? origPlat?.platformGameId : undefined,
          }),
          title: game.title,
          shortDescription: cleanGameShort || undefined,
          detailedDescription: game.detailedDescription || cleanGameShort,
          availableDescriptions: cleanGameShort
            ? [{ source: 'Original Library Synopsis', text: cleanGameShort }]
            : [],
          releaseDate: game.releaseDate,
          developers: game.developers,
          publishers: game.publishers,
          genres: game.genres,
          tags: game.tags,
          headerImage: game.headerImage,
          capsuleImage: game.capsuleImage,
        });
      }
    }

    return results;
  }
}

export const metadataScraperService = new MetadataScraperService();
