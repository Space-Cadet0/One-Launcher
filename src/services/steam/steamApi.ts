import axios from 'axios';
import {
  SteamEnrichedMetadata,
  SteamReviewSummary,
  SteamScreenshot,
  SteamMovie,
  SteamCategory,
  SteamLanguageOption,
} from '../../contracts/steam';

export function getSteamCategoryIconUrl(id: number): string {
  const map: Record<number, string> = {
    1: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_multiPlayer.png',
    2: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_singlePlayer.png',
    9: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_coop.png',
    13: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_cc.png',
    18: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_controller.png',
    20: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_multiPlayer.png',
    22: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_achievements.png',
    23: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_cloud.png',
    24: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_coop.png',
    25: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_leaderboards.png',
    27: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_multiPlayer.png',
    28: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_controller.png',
    29: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_cards.png',
    30: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_workshop.png',
    31: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_vr_support.png',
    32: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_cloud.png',
    35: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_cart.png',
    36: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_multiPlayer.png',
    37: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_multiPlayer.png',
    38: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_coop.png',
    39: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_coop.png',
    41: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_remote_play.png',
    42: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_remote_play.png',
    43: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_remote_play.png',
    44: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_remote_play_together.png',
    47: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_multiPlayer.png',
    48: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_coop.png',
    49: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_multiPlayer.png',
    51: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_cards.png',
    52: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_vr_input_motion.png',
    53: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_vr_support.png',
    54: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_vr_headset.png',
    55: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_controller.png',
    56: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_controller.png',
    57: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_controller.png',
    58: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_controller.png',
    61: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_hdr.png',
    62: 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_familysharing.png',
  };
  return map[id] || 'https://store.akamai.steamstatic.com/public/images/v6/ico/ico_singlePlayer.png';
}

import steamEnrichedCache from '../storage/steamEnrichedCache.json';
import { requestScheduler, RequestPriority } from '../network/requestScheduler';
import { stripHtmlToPlainSynopsis } from './fallbackMetadataProvider';

/**
 * Universally detects non-English regional dubbed/subtitled trailer titles across storefronts.
 * Preserves English, US, UK, EN, International, Global, PEGI, and ESRB trailers.
 */
export function isNonEnglishRegionalMovieName(name?: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;

  // 1. Non-Latin regional scripts (CJK, Cyrillic, Arabic, Hangul, Kana)
  if (/[\u0400-\u04ff\u0600-\u06ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(trimmed)) {
    return true;
  }

  // 2. Underscore/hyphen/bracket-delimited regional ISO language/country tags in production trailer filenames
  // e.g. "Wolfenstein II_Launch Trailer_IT_PEGI", "Trailer_FR", "Launch_DE_1080p", "[ES]", "(ITA)"
  if (
    /(?:^|[\s_\-[(\/])(?:IT|ITA|FR|FRA|FRE|DE|DEU|GER|ES|ESP|SPA|PT|POR|BR|PTBR|PT-BR|RU|RUS|PL|POL|JP|JPN|KR|KOR|CN|CHN|ZH|ZHS|ZHT|TW|CHT|CHS|TR|TUR|AR|ARA|LATAM|ES-MX|ES-AR|FR-CA)(?:$|[\s_\-\])\/])/i.test(
      trimmed
    )
  ) {
    return true;
  }

  // 3. Explicit non-English language labels or localized "trailer" words
  if (
    /\b(?:italian|italiano|french|fran[cç]ais|german|deutsch|spanish|espa[nñ]ol|portuguese|portugu[eê]s|russian|polish|polski|japanese|korean|chinese|simplified\s+chinese|traditional\s+chinese|turkish|t[uü]rk[cç]e|arabic|latam|bande[\s-]annonce|tr[aá]iler\s+en\s+espa[nñ]ol)\b/i.test(
      trimmed
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Filters out regional non-English trailers when at least one English/international trailer exists.
 * Falls back to the full list only if every single trailer is non-English.
 */
export function filterEnglishMovies<T extends { name?: string }>(movies?: T[] | null): T[] {
  if (!Array.isArray(movies) || movies.length === 0) return [];
  const englishMovies = movies.filter((m) => !isNonEnglishRegionalMovieName(m?.name));
  return englishMovies.length > 0 ? englishMovies : movies;
}

/**
 * Parses the exact 3-column language matrix (`Interface`, `Full Audio`, `Subtitles`)
 * from a Steam store page HTML `<table class="game_language_options">`.
 */
export function parseSteamLanguageTableHtml(html?: string): SteamLanguageOption[] {
  if (!html || typeof html !== 'string') return [];
  const tableMatch = html.match(/<table[^>]*class=["'][^"']*game_language_options[^"']*["'][^>]*>[\s\S]*?<\/table>/i);
  if (!tableMatch) return [];

  const rows = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const options: SteamLanguageOption[] = [];
  const seen = new Set<string>();

  const hasCheck = (cell?: string): boolean =>
    /&#10004;|&#x2714;|✔|✓|<span|<img/i.test(cell || '');

  for (const row of rows) {
    if (/<th[\s>]/i.test(row) || /colspan=/i.test(row)) continue;
    const cells = row.match(/<td[\s\S]*?<\/td>/gi) || [];
    if (cells.length < 2) continue;

    const name = (cells[0] || '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, ' ')
      .trim();
    if (!name) continue;

    const hasInterface = hasCheck(cells[1]);
    const hasAudio = hasCheck(cells[2]);
    const hasSubtitles = hasCheck(cells[3]);

    if (!hasInterface && !hasAudio && !hasSubtitles) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    options.push({
      name,
      hasInterface,
      hasAudio,
      hasSubtitles,
    });
  }

  return options;
}

/**
 * Fallback parser for Steam's `data.supported_languages` string from `/api/appdetails`.
 * Only marks `hasSubtitles: true` when the string explicitly contains an asterisk `*`
 * audio/subtitle footnote marker (preventing false-positive Subtitles ticks on Interface-only games).
 */
export function parseSteamSupportedLanguagesString(rawHtml?: string): SteamLanguageOption[] {
  if (!rawHtml || typeof rawHtml !== 'string') return [];
  const hasAudioMarker = /\*/.test(rawHtml);
  const mainPart = rawHtml.split(/<br\s*\/?>/i)[0] || '';
  const items = mainPart.split(',');
  const results: SteamLanguageOption[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const hasAudio = item.includes('*');
    const cleanName = item
      .replace(/<[^>]*>/g, '')
      .replace(/\*/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleanName) continue;
    const key = cleanName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      name: cleanName,
      hasInterface: true,
      hasAudio,
      hasSubtitles: hasAudioMarker,
    });
  }

  return results;
}

export class SteamApiService {
  public static readonly MAX_METADATA_CACHE_ENTRIES = 60;
  public static readonly MAX_METADATA_CACHE_SIZE = 60;
  private cache = new Map<number, SteamEnrichedMetadata>();
  private rateLimitedUntil = 0;

  private get metadataCache(): Map<number, SteamEnrichedMetadata> {
    return this.cache;
  }

  private setCacheEntry(appId: number, value: SteamEnrichedMetadata): void {
    if (this.metadataCache.has(appId)) {
      this.metadataCache.delete(appId);
    }
    this.metadataCache.set(appId, value);
    while (this.metadataCache.size > SteamApiService.MAX_METADATA_CACHE_SIZE) {
      const oldestKey = this.metadataCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.metadataCache.delete(oldestKey);
    }
  }

  public trimMemoryCache(maxEntries: number = 30): void {
    const limit = Math.max(0, maxEntries);
    while (this.metadataCache.size > limit) {
      const oldestKey = this.metadataCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.metadataCache.delete(oldestKey);
    }
  }

  isStoreRateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil || requestScheduler.isRateLimited('store.steampowered.com');
  }

  getCooldownRemainingSeconds(): number {
    const internalRemaining = Math.max(0, Math.ceil((this.rateLimitedUntil - Date.now()) / 1000));
    const schedulerRemaining = requestScheduler.getCooldownRemaining('store.steampowered.com');
    return Math.max(internalRemaining, schedulerRemaining);
  }

  private getBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/steam-store';
    }
    return 'https://store.steampowered.com';
  }

  getCachedMetadata(appId: number): SteamEnrichedMetadata | null {
    if (this.metadataCache.has(appId)) {
      const hit = this.metadataCache.get(appId)!;
      this.setCacheEntry(appId, hit);
      return hit;
    }
    const preCached = (steamEnrichedCache as Record<string, any>)[String(appId)];
    if (preCached && preCached.shortDescription) {
      const languageOptions =
        Array.isArray(preCached.languageOptions) && preCached.languageOptions.length > 0
          ? preCached.languageOptions
          : preCached.supportedLanguages
          ? parseSteamSupportedLanguagesString(preCached.supportedLanguages)
          : undefined;
      return {
        ...(preCached as SteamEnrichedMetadata),
        shortDescription: stripHtmlToPlainSynopsis(preCached.shortDescription),
        movies: filterEnglishMovies<SteamMovie>(preCached.movies || []).slice(0, 4),
        screenshots: Array.isArray(preCached.screenshots) ? preCached.screenshots.slice(0, 12) : [],
        languageOptions,
        languageTableSchema: preCached.languageTableSchema || 'steam',
      };
    }
    return null;
  }

  async fetchGameMetadata(
    appId: number,
    priority: number = RequestPriority.P1_VIEWPORT
  ): Promise<SteamEnrichedMetadata | null> {
    if (this.metadataCache.has(appId)) {
      const cached = this.metadataCache.get(appId)!;
      this.setCacheEntry(appId, cached);
      return cached;
    }

    const preCached = (steamEnrichedCache as Record<string, any>)[String(appId)];
    if (preCached && preCached.aboutTheGame) {
      const normalizedMovies: SteamMovie[] = filterEnglishMovies<SteamMovie>(
        (preCached.movies || []).map((m: any) => ({
          id: m.id,
          name: m.name,
          thumbnail: m.thumbnail,
          hls: m.hls || m.hls_h264 || '',
          webm: m.webm || {},
          mp4: m.mp4 || {},
        }))
      ).slice(0, 4);

      const languageOptions =
        Array.isArray(preCached.languageOptions) && preCached.languageOptions.length > 0
          ? preCached.languageOptions
          : preCached.supportedLanguages
          ? parseSteamSupportedLanguagesString(preCached.supportedLanguages)
          : undefined;

      const rawDetailedDesc = String(preCached.detailedDescription || '');
      const rawAbout = String(preCached.aboutTheGame || '');

      const enriched: SteamEnrichedMetadata = {
        ...preCached,
        shortDescription: stripHtmlToPlainSynopsis(preCached.shortDescription),
        detailedDescription:
          rawDetailedDesc.length > 15000 ? rawDetailedDesc.slice(0, 15000) : rawDetailedDesc,
        aboutTheGame: rawAbout.length > 15000 ? rawAbout.slice(0, 15000) : rawAbout,
        capsuleImage:
          preCached.capsuleImage ||
          preCached.library_capsule ||
          preCached.capsule_imagev5 ||
          preCached.capsule_image,
        screenshots: Array.isArray(preCached.screenshots) ? preCached.screenshots.slice(0, 12) : [],
        movies: normalizedMovies,
        languageOptions,
        languageTableSchema: preCached.languageTableSchema || 'steam',
        categories: (preCached.categories || []).map((c: any) => ({
          ...c,
          icon: getSteamCategoryIconUrl(c.id),
        })),
      };
      this.setCacheEntry(appId, enriched);
      return enriched;
    }

    if (this.isStoreRateLimited()) {
      return null;
    }

    const baseUrl = this.getBaseUrl();
    const url = `${baseUrl}/api/appdetails?appids=${appId}&l=english&cc=US`;

    return requestScheduler
      .schedule(
        url,
        async () => {
          const [detailsRes, reviewsRes, storePageRes] = await Promise.all([
            axios.get(url, {
              timeout: 8000,
              headers: {
                Cookie:
                  'Steam_Language=english; birthtime=568022401; mature_content=1; wants_mature_content=1',
                'Accept-Language': 'en-US,en;q=0.9',
              },
            }),
            axios.get(`${baseUrl}/appreviews/${appId}?json=1&language=all`, { timeout: 6000 }).catch(() => null),
            axios
              .get(`${baseUrl}/app/${appId}/?l=english&cc=US`, {
                timeout: 6000,
                headers: {
                  Cookie:
                    'Steam_Language=english; birthtime=568022401; mature_content=1; wants_mature_content=1',
                  'Accept-Language': 'en-US,en;q=0.9',
                },
              })
              .catch(() => null),
          ]);

          const appData = detailsRes.data?.[appId];
          if (!appData || !appData.success || !appData.data) {
            return null;
          }

          const data = appData.data;

          // Extract screenshots
          const screenshots: SteamScreenshot[] = (data.screenshots || [])
            .slice(0, 12)
            .map((s: any) => ({
              id: s.id,
              pathThumbnail: s.path_thumbnail,
              pathFull: s.path_full,
            }));

          // Extract movies / trailers
          const rawMovies: SteamMovie[] = (data.movies || []).map((m: any) => {
            const hlsUrl = m.hls_h264 || m.hls || '';
            const rawMp4Max = m.mp4?.max && !m.mp4.max.includes('.mpd') && !m.mp4.max.includes('.m3u8') ? m.mp4.max : '';
            const rawMp4Low = m.mp4?.['480'] && !m.mp4['480'].includes('.mpd') && !m.mp4['480'].includes('.m3u8') ? m.mp4['480'] : '';

            return {
              id: m.id,
              name: m.name,
              thumbnail: m.thumbnail,
              hls: hlsUrl,
              webm: {
                480: m.webm?.['480'] || '',
                max: m.webm?.max || '',
              },
              mp4: {
                480: rawMp4Low,
                max: rawMp4Max,
              },
            };
          });

          // Filter out regional non-English trailers (e.g. CJK/European dubs) when English/international trailers exist
          const movies = filterEnglishMovies(rawMovies).slice(0, 4);

          // Extract review summary
          let reviewSummary: SteamReviewSummary = {
            reviewScore: 0,
            reviewScoreDesc: 'No User Reviews',
            totalPositive: 0,
            totalNegative: 0,
            totalReviews: 0,
            positivePercent: 0,
          };

          if (reviewsRes?.data?.query_summary) {
            const qs = reviewsRes.data.query_summary;
            const total = qs.total_reviews || 0;
            const positive = qs.total_positive || 0;
            const negative = qs.total_negative || 0;
            const percent = total > 0 ? Math.round((positive / total) * 100) : 0;

            reviewSummary = {
              reviewScore: qs.review_score || 0,
              reviewScoreDesc: qs.review_score_desc || (total > 0 ? `${percent}% Positive` : 'No User Reviews'),
              totalPositive: positive,
              totalNegative: negative,
              totalReviews: total,
              positivePercent: percent,
            };
          }

          // Extract categories (features)
          const categories: SteamCategory[] = (data.categories || []).map((c: any) => ({
            id: c.id,
            description: c.description,
            icon: getSteamCategoryIconUrl(c.id),
          }));

          // Extract genres & tags
          const genres: string[] = (data.genres || []).map((g: any) => g.description);
          const tags: string[] = (data.categories || []).map((c: any) => c.description).slice(0, 10);

          // Extract achievements
          let achievements: { total: number; highlighted?: any[] } | undefined = undefined;
          if (data.achievements && typeof data.achievements.total === 'number') {
            achievements = {
              total: data.achievements.total,
              highlighted: (data.achievements.highlighted || []).map((h: any) => ({
                name: h.name || h.localized_name || '',
                path: h.path || '',
              })),
            };
          }

          const resolvedCapsuleImage =
            (typeof data.library_capsule === 'string' && data.library_capsule) ||
            (typeof data.capsule_imagev5 === 'string' && data.capsule_imagev5) ||
            (typeof data.capsule_image === 'string' && data.capsule_image) ||
            undefined;

          const htmlLanguageOptions = parseSteamLanguageTableHtml(
            typeof storePageRes?.data === 'string' ? storePageRes.data : ''
          );
          const resolvedLanguageOptions =
            htmlLanguageOptions.length > 0
              ? htmlLanguageOptions
              : parseSteamSupportedLanguagesString(data.supported_languages);

          const rawDetailedDesc = String(data.detailed_description || '');
          const rawAboutTheGame = String(data.about_the_game || '');

          const metadata: SteamEnrichedMetadata = {
            appId,
            name: data.name,
            shortDescription: stripHtmlToPlainSynopsis(data.short_description || ''),
            detailedDescription:
              rawDetailedDesc.length > 15000 ? rawDetailedDesc.slice(0, 15000) : rawDetailedDesc,
            aboutTheGame:
              rawAboutTheGame.length > 15000 ? rawAboutTheGame.slice(0, 15000) : rawAboutTheGame,
            headerImage: data.header_image || '',
            capsuleImage: resolvedCapsuleImage,
            developers: data.developers || [],
            publishers: data.publishers || [],
            releaseDate: data.release_date?.date || (data.release_date?.coming_soon ? 'Coming Soon' : 'TBA'),
            genres,
            tags,
            categories,
            screenshots,
            movies,
            systemRequirements: {
              minimum: typeof data.pc_requirements?.minimum === 'string' ? data.pc_requirements.minimum : undefined,
              recommended: typeof data.pc_requirements?.recommended === 'string' ? data.pc_requirements.recommended : undefined,
            },
            reviewSummary,
            supportedLanguages: data.supported_languages,
            languageOptions: resolvedLanguageOptions.length > 0 ? resolvedLanguageOptions : undefined,
            languageTableSchema: 'steam',
            legalNotice: data.legal_notice,
            drmNotice: data.drm_notice,
            controllerSupport: data.controller_support,
            pcRequirementsHtml: data.pc_requirements?.minimum || undefined,
            achievements,
            metacritic:
              data.metacritic && typeof data.metacritic.score === 'number'
                ? {
                    score: data.metacritic.score,
                    url: data.metacritic.url || '',
                  }
                : undefined,
            platforms: data.platforms
              ? {
                  windows: Boolean(data.platforms.windows),
                  mac: Boolean(data.platforms.mac),
                  linux: Boolean(data.platforms.linux),
                }
              : undefined,
          };

          this.setCacheEntry(appId, metadata);

          return metadata;
        },
        priority,
        'store.steampowered.com'
      )
      .catch((err: any) => {
        if (err?.response?.status === 403 || err?.response?.status === 429 || err?.isRateLimited) {
          // Akamai CDN edge rate limit: pause storefront web requests for 15 minutes to let the cooldown reset cleanly
          this.rateLimitedUntil = Date.now() + 15 * 60 * 1000;
          requestScheduler.setCooldown('store.steampowered.com', 900);
          console.warn(
            `[Steam API] Akamai edge cooldown encountered (${err.response?.status || 429}). Pausing web requests to store.steampowered.com for 15 minutes to allow IP cooldown to clear.`
          );
        } else {
          console.warn(`Failed to fetch Steam metadata for appId ${appId}:`, err);
        }
        return null;
      });
  }

  async searchAppId(
    term: string,
    priority: number = RequestPriority.P0_INTERACTIVE
  ): Promise<number | null> {
    if (this.isStoreRateLimited()) return null;
    const baseUrl = this.getBaseUrl();
    const url = `${baseUrl}/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`;

    return requestScheduler
      .schedule(
        url,
        async () => {
          const res = await axios.get(url);
          if (res.data?.items?.length > 0) {
            return res.data.items[0].id;
          }
          return null;
        },
        priority,
        'store.steampowered.com'
      )
      .catch(() => null);
  }
}

export const steamApi = new SteamApiService();
