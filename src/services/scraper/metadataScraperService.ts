import axios from 'axios';
import { CanonicalGame } from '../../contracts/game';
import {
  SearchMatchCandidate,
  ScrapedCoverOption,
  ScrapedMetadataBundle,
} from '../../contracts/override';
import {
  steamMatcher,
  computeTitleSimilarity,
  normalizeGameTitle,
  canonicalizeTitleKey,
} from '../steam/steamMatcher';
import { steamApi } from '../steam/steamApi';
import {
  fallbackMetadataProvider,
  extractFirstParagraph,
} from '../steam/fallbackMetadataProvider';
import { igdbCoverService } from '../igdb/igdbCoverService';
import gogEnrichedCache from '../storage/gogEnrichedCache.json';
import { EPIC_USER_LIBRARY } from '../storage/epicUserLibrary';
import { KNOWN_EPIC_APP_NAMES } from '../integrations/epicCodenames';

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
 * Deduplicates scraped covers by normalized image URL.
 */
function deduplicateCovers(covers: ScrapedCoverOption[]): ScrapedCoverOption[] {
  const seen = new Set<string>();
  const result: ScrapedCoverOption[] = [];
  for (const c of covers) {
    if (!c.url || !c.url.trim()) continue;
    const norm = c.url.trim().toLowerCase().replace(/^https?:\/\//, '');
    if (seen.has(norm)) continue;
    seen.add(norm);
    result.push(c);
  }
  return result;
}

/**
 * Deduplicates descriptions by normalized text content.
 */
function deduplicateDescriptions(
  descriptions: { source: string; text: string }[]
): { source: string; text: string }[] {
  const seen = new Set<string>();
  const result: { source: string; text: string }[] = [];
  for (const d of descriptions) {
    if (!d.text || !d.text.trim()) continue;
    const norm = d.text.trim().toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    result.push({ source: d.source, text: d.text.trim() });
  }
  return result;
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
  private async querySteamStore(term: string): Promise<any[]> {
    const clean = term.trim();
    if (!clean) return [];

    const isLocal =
      typeof window !== 'undefined' &&
      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

    const urls: string[] = [];
    if (isLocal) {
      urls.push(`${this.getSteamBaseUrl()}/api/storesearch/?term=${encodeURIComponent(clean)}&l=english&cc=US`);
      urls.push(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(clean)}&l=english&cc=US`);
    } else {
      urls.push(`${this.getSteamBaseUrl()}/api/storesearch/?term=${encodeURIComponent(clean)}&l=english&cc=US`);
    }

    for (const url of urls) {
      try {
        const res = await axios.get(url, {
          timeout: 6000,
          headers: {
            Cookie: 'birthtime=568022401; mature_content=1; wants_mature_content=1',
          },
        });
        if (res.data?.items && Array.isArray(res.data.items)) {
          return res.data.items;
        }
      } catch (err: any) {
        // Fallback to next URL or log warning
        console.warn(`[MetadataScraperService] Steam store search failed on ${url}:`, err?.message);
      }
    }
    return [];
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
        const res = await axios.get(url, {
          timeout: 6000,
          headers: {
            'User-Agent': 'OneLauncher/1.0',
          },
        });
        if (res.data?.results && Array.isArray(res.data.results)) {
          return res.data.results;
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

    const effectiveTitle = customQuery && customQuery.trim() ? customQuery.trim() : game.title;
    const cleanTitle = normalizeGameTitle(effectiveTitle) || effectiveTitle;
    const candidates: SearchMatchCandidate[] = [];

    // 1. Steam Existing Ownership or Instant Curated Match (skip if nonSteamOnly is active)
    if (!nonSteamOnly) {
      let matchedSteamAppId: number | null = game.steamAppId || null;
      if (!matchedSteamAppId) {
        matchedSteamAppId = steamMatcher.matchGameToSteamInstant(effectiveTitle);
      }

      if (matchedSteamAppId) {
        candidates.push({
          id: `steam-${matchedSteamAppId}`,
          source: 'steam',
          title: game.title,
          steamAppId: matchedSteamAppId,
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
      if (gogData) {
        candidates.push({
          id: `gog-${gogPlatform.platformGameId}`,
          source: 'gog',
          title: gogData.title || game.title,
          gogId: gogPlatform.platformGameId,
          year: gogData.releaseDate ? gogData.releaseDate.substring(0, 4) : undefined,
          capsuleImage: gogData.coverVertical || gogData.coverHorizontal,
          headerImage: gogData.coverHorizontal || gogData.coverVertical,
          description: gogData.shortDescription || gogData.aboutTheGame,
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

      if (epicMapping) {
        candidates.push({
          id: `epic-${epicPlatform.platformGameId}`,
          source: 'epic',
          title: epicMapping.title || game.title,
          capsuleImage: epicMapping.capsuleImage || epicMapping.headerImage,
          headerImage: epicMapping.headerImage,
          description: epicMapping.description,
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
      if (shouldQuerySteam) searchPromises.push(this.searchStorefronts(cleanTitle, 'steam').catch(() => []));
      if (shouldQueryIgdb) searchPromises.push(this.searchStorefronts(cleanTitle, 'igdb').catch(() => []));
      if (shouldQueryGog) searchPromises.push(this.searchStorefronts(cleanTitle, 'gog').catch(() => []));
      if (shouldQueryEpic) searchPromises.push(this.searchStorefronts(cleanTitle, 'epic').catch(() => []));

      const results = await Promise.all(searchPromises);
      for (const resList of results) {
        candidates.push(...resList);
      }
    } catch (err: any) {
      console.warn('[MetadataScraperService] Dynamic suggested matches search encountered error:', err?.message);
    }

    // 5. Score, Filter, Deduplicate, and Rank
    const scoredCandidates: SearchMatchCandidate[] = [];
    const seen = new Set<string>();

    for (const cand of candidates) {
      if (nonSteamOnly && cand.source === 'steam') continue;
      if (sourceFilter && sourceFilter.toLowerCase() !== 'all' && cand.source.toLowerCase() !== sourceFilter.toLowerCase()) {
        continue;
      }

      const key = `${cand.source}:${cand.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Similarity calculation against original game title
      const sim = computeTitleSimilarity(effectiveTitle, cand.title);
      let score = Math.round(sim * 100);

      const normGame = canonicalizeTitleKey(effectiveTitle);
      const normCand = canonicalizeTitleKey(cand.title);

      if (normGame === normCand) {
        score = Math.max(score, 96);
      }

      // Bonus if candidate has official SteamAppId matching the game
      if (cand.source === 'steam' && game.steamAppId && cand.steamAppId === game.steamAppId) {
        score = 100;
      }

      // Bonus if candidate source matches a platform owned by user
      if (game.platforms?.some((p) => p.platformId === cand.source)) {
        score = Math.min(100, score + 8);
      }

      // Bonus if candidate has a valid cover image
      if (cand.capsuleImage) {
        score = Math.min(100, score + 2);
      }

      scoredCandidates.push({
        ...cand,
        confidenceScore: Math.max(cand.confidenceScore || 0, score),
      });
    }

    // Sort by confidenceScore descending
    scoredCandidates.sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0));

    // Return top candidates (if custom query or filter is passed, return up to 20; if default, top 6)
    const limit = (customQuery || (sourceFilter && sourceFilter.toLowerCase() !== 'all')) ? 20 : 6;
    return scoredCandidates.slice(0, limit);
  }

  /**
   * Searches storefronts (Steam, IGDB, GOG, Epic) for matching games.
   */
  async searchStorefronts(
    query: string,
    source: 'all' | 'steam' | 'igdb' | 'gog' | 'epic' = 'all'
  ): Promise<SearchMatchCandidate[]> {
    const rawClean = cleanSearchQuery(query);
    if (!rawClean) return [];

    const candidates: SearchMatchCandidate[] = [];
    const normQuery = canonicalizeTitleKey(rawClean);

    // --- 1. Steam Search ---
    if (source === 'all' || source === 'steam') {
      try {
        // Direct AppID search if query is purely numeric
        if (/^\d{3,8}$/.test(rawClean)) {
          const numId = parseInt(rawClean, 10);
          const meta = await steamApi.fetchGameMetadata(numId);
          if (meta) {
            candidates.push({
              id: `steam-${numId}`,
              source: 'steam',
              title: meta.name,
              steamAppId: numId,
              capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${numId}/library_600x900_2x.jpg`,
              headerImage: meta.headerImage || `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${numId}/header.jpg`,
              confidenceScore: 100,
            });
          }
        }

        // Instant matcher check
        const instantId = steamMatcher.matchGameToSteamInstant(rawClean);
        if (instantId && !candidates.some((c) => c.steamAppId === instantId)) {
          candidates.push({
            id: `steam-${instantId}`,
            source: 'steam',
            title: rawClean,
            steamAppId: instantId,
            capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${instantId}/library_600x900_2x.jpg`,
            headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${instantId}/header.jpg`,
            confidenceScore: 95,
          });
        }

        // Query Steam storesearch
        const items = await this.querySteamStore(rawClean);
        for (const item of items) {
          if (!item.id || !item.name) continue;
          if (candidates.some((c) => c.steamAppId === item.id)) continue;

          const sim = computeTitleSimilarity(rawClean, item.name);
          let score = Math.round(sim * 100);
          if (canonicalizeTitleKey(item.name) === normQuery) score += 20;

          candidates.push({
            id: `steam-${item.id}`,
            source: 'steam',
            title: item.name,
            steamAppId: item.id,
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
        const results = await this.queryLutrisGames(rawClean);
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

          const sim = computeTitleSimilarity(rawClean, item.name);
          let score = Math.round(sim * 100);
          if (canonicalizeTitleKey(item.name) === normQuery) score += 20;

          candidates.push({
            id: `igdb-${item.id || item.slug}`,
            source: 'igdb',
            title: item.name,
            year: item.year,
            igdbId: item.id,
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
          const sim = computeTitleSimilarity(rawClean, entry.title);
          const titleKey = canonicalizeTitleKey(entry.title);

          const isMatch =
            sim >= 0.4 ||
            titleKey.includes(normQuery) ||
            normQuery.includes(titleKey) ||
            String(id) === rawClean;

          if (isMatch) {
            let score = Math.round(sim * 100);
            if (titleKey === normQuery) score = 100;
            else if (titleKey.includes(normQuery)) score = Math.max(score, 75);

            candidates.push({
              id: `gog-${id}`,
              source: 'gog',
              title: entry.title,
              gogId: id,
              year: entry.releaseDate ? entry.releaseDate.substring(0, 4) : undefined,
              capsuleImage: entry.coverVertical || entry.coverHorizontal,
              headerImage: entry.coverHorizontal || entry.coverVertical,
              description: entry.shortDescription || entry.aboutTheGame,
              confidenceScore: Math.min(100, score),
            });
          }
        }
      } catch (err: any) {
        console.warn('[MetadataScraperService] GOG local search error:', err?.message);
      }
    }

    // --- 4. Epic Catalog Search ---
    if (source === 'all' || source === 'epic') {
      try {
        const seenEpicTitles = new Set<string>();

        // Search EPIC_USER_LIBRARY
        for (const game of EPIC_USER_LIBRARY) {
          if (!game.title) continue;
          const titleKey = canonicalizeTitleKey(game.title);
          if (seenEpicTitles.has(titleKey)) continue;

          const sim = computeTitleSimilarity(rawClean, game.title);
          const isMatch =
            sim >= 0.4 ||
            titleKey.includes(normQuery) ||
            normQuery.includes(titleKey);

          if (isMatch) {
            seenEpicTitles.add(titleKey);
            let score = Math.round(sim * 100);
            if (titleKey === normQuery) score = 100;
            else if (titleKey.includes(normQuery)) score = Math.max(score, 75);

            candidates.push({
              id: `epic-${game.id}`,
              source: 'epic',
              title: game.title,
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
          const titleKey = canonicalizeTitleKey(mapping.title);
          if (seenEpicTitles.has(titleKey)) continue;

          const sim = computeTitleSimilarity(rawClean, mapping.title);
          const isMatch =
            sim >= 0.4 ||
            titleKey.includes(normQuery) ||
            normQuery.includes(titleKey);

          if (isMatch) {
            seenEpicTitles.add(titleKey);
            let score = Math.round(sim * 100);
            if (titleKey === normQuery) score = 100;
            else if (titleKey.includes(normQuery)) score = Math.max(score, 75);

            candidates.push({
              id: `epic-${key}`,
              source: 'epic',
              title: mapping.title,
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
      deduplicated.push(cand);
    }

    // Sort by confidenceScore descending
    deduplicated.sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0));

    return deduplicated;
  }

  /**
   * Scrapes comprehensive match details, assemble multiple portrait covers,
   * multiple synopsis options, and deep metadata.
   */
  async scrapeMatchDetails(
    candidate: SearchMatchCandidate,
    originalGame?: CanonicalGame | null
  ): Promise<ScrapedMetadataBundle> {
    const sortTitle = (candidate.title || originalGame?.title || '')
      .replace(/^(The|A|An)\s+/i, '')
      .trim();

    // -------------------------------------------------------------
    // 1. MATCHING TO STEAM
    // -------------------------------------------------------------
    if (candidate.source === 'steam') {
      const steamAppId =
        candidate.steamAppId ||
        (typeof candidate.id === 'number'
          ? candidate.id
          : parseInt(String(candidate.id).replace(/^steam-/, ''), 10));

      let meta = null;
      if (steamAppId && !isNaN(steamAppId)) {
        try {
          meta = await steamApi.fetchGameMetadata(steamAppId);
        } catch (err: any) {
          console.warn(`[MetadataScraperService] Failed to fetch Steam metadata for ${steamAppId}:`, err?.message);
        }
      }

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

      if (originalGame?.platforms) {
        const gogPlat = originalGame.platforms.find((p) => p.platformId === 'gog');
        if (gogPlat?.platformGameId) {
          const cachedGog = (gogEnrichedCache as Record<string, any>)[gogPlat.platformGameId];
          if (cachedGog?.coverVertical) {
            rawCovers.push({
              url: cachedGog.coverVertical,
              source: 'gog',
              label: 'GOG Official Cover',
              dimensions: 'vertical',
            });
          }
        }
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
        (await igdbCoverService.fetchIgdbCover(candidate.title).catch(() => null));

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

      if (originalGame?.shortDescription) {
        rawDescriptions.push({
          source: 'Original Library Synopsis',
          text: originalGame.shortDescription,
        });
      }

      const availableDescriptions = deduplicateDescriptions(rawDescriptions);

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
        shortDescription:
          meta?.shortDescription ||
          availableDescriptions[0]?.text ||
          originalGame?.shortDescription ||
          '',
        detailedDescription: meta?.detailedDescription || meta?.aboutTheGame || '',
        availableDescriptions,
        developers: meta?.developers?.length ? meta.developers : originalGame?.developers || [],
        publishers: meta?.publishers?.length ? meta.publishers : originalGame?.publishers || [],
        genres: meta?.genres?.length ? meta.genres : originalGame?.genres || [],
        tags: meta?.tags?.length ? meta.tags : originalGame?.tags || [],
        releaseDate: meta?.releaseDate || originalGame?.releaseDate || '',
      };
    }

    // -------------------------------------------------------------
    // 2. MATCHING TO GOG
    // -------------------------------------------------------------
    if (candidate.source === 'gog') {
      const gogId = String(candidate.gogId || candidate.id).replace(/^gog-/, '');
      const cached = (gogEnrichedCache as Record<string, any>)[gogId];

      let storeMeta = null;
      try {
        storeMeta = await fallbackMetadataProvider.fetchGogProductMetadata(gogId);
      } catch (err: any) {
        console.warn(`[MetadataScraperService] GOG metadata fetch failed for ${gogId}:`, err?.message);
      }

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

      if (originalGame?.capsuleImage) {
        rawCovers.push({
          url: originalGame.capsuleImage,
          source: 'original',
          label: 'Original Library Cover',
        });
      }

      const igdbCover = igdbCoverService.getIgdbCoverInstant(candidate.title);
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
      const gogLead = storeMeta?.shortDescription || cached?.shortDescription;
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

      if (originalGame?.shortDescription) {
        rawDescriptions.push({
          source: 'Original Library Synopsis',
          text: originalGame.shortDescription,
        });
      }

      const availableDescriptions = deduplicateDescriptions(rawDescriptions);

      return {
        matchedStore: 'gog',
        matchedId: gogId,
        title: candidate.title || cached?.title || originalGame?.title || '',
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
        shortDescription: gogLead || availableDescriptions[0]?.text || originalGame?.shortDescription || '',
        detailedDescription: storeMeta?.detailedDescription || cached?.aboutTheGame || '',
        availableDescriptions,
        developers: storeMeta?.developers || cached?.developers || originalGame?.developers || [],
        publishers: storeMeta?.publishers || cached?.publishers || originalGame?.publishers || [],
        genres: storeMeta?.genres || cached?.genres || originalGame?.genres || [],
        tags: storeMeta?.tags || cached?.tags || originalGame?.tags || [],
        releaseDate: storeMeta?.releaseDate || cached?.releaseDate || originalGame?.releaseDate || '',
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

      let storeMeta = null;
      try {
        storeMeta = await fallbackMetadataProvider.fetchEpicProductMetadata(cleanSlug);
        if (!storeMeta && !/^[0-9a-f]{20,}$/i.test(epicId)) {
          storeMeta = await fallbackMetadataProvider.fetchEpicProductMetadata(epicId);
        }
      } catch (err: any) {
        console.warn(`[MetadataScraperService] Epic metadata fetch failed for ${candidate.title}:`, err?.message);
      }

      const epicVertical = storeMeta?.capsuleImage || candidate.capsuleImage;
      const rawCovers: ScrapedCoverOption[] = [];

      if (epicVertical) {
        rawCovers.push({
          url: epicVertical,
          source: 'epic',
          label: 'Epic Portrait Cover',
        });
      }

      if (originalGame?.capsuleImage) {
        rawCovers.push({
          url: originalGame.capsuleImage,
          source: 'original',
          label: 'Original Library Cover',
        });
      }

      const igdbCover = igdbCoverService.getIgdbCoverInstant(candidate.title);
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
      const epicShort = storeMeta?.shortDescription || candidate.description;
      if (epicShort) {
        rawDescriptions.push({
          source: 'Epic Store Synopsis',
          text: epicShort,
        });
      }

      const firstPara = extractFirstParagraph(storeMeta?.detailedDescription || storeMeta?.aboutTheGame);
      if (firstPara && firstPara !== epicShort) {
        rawDescriptions.push({
          source: 'Epic Detailed Overview',
          text: firstPara,
        });
      }

      if (originalGame?.shortDescription) {
        rawDescriptions.push({
          source: 'Original Library Synopsis',
          text: originalGame.shortDescription,
        });
      }

      const availableDescriptions = deduplicateDescriptions(rawDescriptions);

      return {
        matchedStore: 'epic',
        matchedId: epicId,
        title: candidate.title || originalGame?.title || '',
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
        shortDescription: epicShort || availableDescriptions[0]?.text || originalGame?.shortDescription || '',
        detailedDescription: storeMeta?.detailedDescription || candidate.description || '',
        availableDescriptions,
        developers: storeMeta?.developers || originalGame?.developers || [],
        publishers: storeMeta?.publishers || originalGame?.publishers || [],
        genres: storeMeta?.genres || originalGame?.genres || [],
        tags: storeMeta?.tags || originalGame?.tags || [],
        releaseDate:
          storeMeta?.releaseDate ||
          (candidate.year ? String(candidate.year) : originalGame?.releaseDate || ''),
      };
    }

    // -------------------------------------------------------------
    // 4. MATCHING TO IGDB / NON-STEAM GAMES
    // -------------------------------------------------------------
    const igdbCover =
      candidate.capsuleImage ||
      igdbCoverService.getIgdbCoverInstant(candidate.title) ||
      (await igdbCoverService.fetchIgdbCover(candidate.title).catch(() => null));

    const rawCovers: ScrapedCoverOption[] = [];
    if (igdbCover) {
      rawCovers.push({
        url: igdbCover,
        source: 'igdb',
        label: 'IGDB Portrait Cover',
        dimensions: 't_cover_big',
      });
    }

    if (originalGame?.capsuleImage) {
      rawCovers.push({
        url: originalGame.capsuleImage,
        source: 'original',
        label: 'Original Library Cover',
      });
    }

    if (originalGame?.platforms) {
      const gogPlat = originalGame.platforms.find((p) => p.platformId === 'gog');
      if (gogPlat?.platformGameId) {
        const cachedGog = (gogEnrichedCache as Record<string, any>)[gogPlat.platformGameId];
        if (cachedGog?.coverVertical) {
          rawCovers.push({
            url: cachedGog.coverVertical,
            source: 'gog',
            label: 'GOG Official Cover',
            dimensions: 'vertical',
          });
        }
      }
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
    if (candidate.description) {
      rawDescriptions.push({
        source: 'IGDB Overview',
        text: candidate.description,
      });
    }

    if (originalGame?.shortDescription) {
      rawDescriptions.push({
        source: 'Original Library Synopsis',
        text: originalGame.shortDescription,
      });
    }

    const availableDescriptions = deduplicateDescriptions(rawDescriptions);

    return {
      matchedStore: 'igdb',
      matchedId: candidate.igdbId || candidate.id,
      title: candidate.title,
      sortTitle,
      steamAppId: null, // null explicitly unlinks Steam for non-Steam games
      igdbId: candidate.igdbId || candidate.id,
      capsuleImage: availableCovers[0]?.url || originalGame?.capsuleImage || '',
      availableCovers,
      headerImage: candidate.headerImage || originalGame?.headerImage || availableCovers[0]?.url || '',
      iconUrl: originalGame?.iconUrl || '',
      shortDescription: candidate.description || originalGame?.shortDescription || '',
      detailedDescription: candidate.description || originalGame?.detailedDescription || originalGame?.shortDescription || '',
      availableDescriptions,
      developers: originalGame?.developers || [],
      publishers: originalGame?.publishers || [],
      genres: originalGame?.genres || [],
      tags: ['IGDB Matched', ...(originalGame?.tags || [])],
      releaseDate: candidate.year ? String(candidate.year) : originalGame?.releaseDate || '',
    };
  }
}

export const metadataScraperService = new MetadataScraperService();
