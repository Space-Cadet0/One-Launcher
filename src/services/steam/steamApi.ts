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
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import { vaultDelete, vaultGet, vaultSet } from '../storage/indexedDbVault';
import {
  evictStagedCache,
  loadStagedCache,
  saveStagedCache,
  STAGED_CACHE_PREFIX,
} from '../storage/stagedCacheService';
import { stripHtmlToPlainSynopsis } from './fallbackMetadataProvider';

const STEAM_APPDETAILS_404_KEY_PREFIX = `${STAGED_CACHE_PREFIX}steam_appdetails_404_v1_`;
const STEAM_APPDETAILS_404_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Truncates rich store HTML at a safe tag/entity/container boundary so `<img ...>`,
 * `<video ...>...</video>`, `<picture>...</picture>`, `<a ...>...</a>`, or HTML entities
 * are never sliced mid-element.
 */
export function truncateHtmlSafely(rawHtml: string, maxChars: number = 35000): string {
  if (!rawHtml) return '';
  if (rawHtml.length <= maxChars) return rawHtml;

  let cut = rawHtml.slice(0, maxChars);
  const lastOpen = cut.lastIndexOf('<');
  const lastClose = cut.lastIndexOf('>');
  if (lastOpen > lastClose) {
    cut = cut.slice(0, lastOpen);
  }

  // Never leave composite media/link containers unclosed at the truncation tail
  const lowerCut = cut.toLowerCase();
  let earliestUnclosedIdx = -1;
  for (const tag of ['video', 'picture', 'a']) {
    const openNeedle = `<${tag}`;
    let searchFrom = lowerCut.length;
    while (searchFrom > 0) {
      const idx = lowerCut.lastIndexOf(openNeedle, searchFrom - 1);
      if (idx === -1) break;
      const nextCh = lowerCut[idx + openNeedle.length];
      if (!nextCh || /[\s>\/]/.test(nextCh)) {
        const closeIdx = lowerCut.indexOf(`</${tag}>`, idx);
        if (closeIdx === -1) {
          earliestUnclosedIdx =
            earliestUnclosedIdx === -1 ? idx : Math.min(earliestUnclosedIdx, idx);
        }
        break;
      }
      searchFrom = idx;
    }
  }

  const bbImgMatchIdx = lowerCut.lastIndexOf('<span class="bb_img_ctn');
  if (bbImgMatchIdx !== -1 && lowerCut.indexOf('</span>', bbImgMatchIdx) === -1) {
    earliestUnclosedIdx =
      earliestUnclosedIdx === -1 ? bbImgMatchIdx : Math.min(earliestUnclosedIdx, bbImgMatchIdx);
  }

  if (earliestUnclosedIdx !== -1) {
    cut = cut.slice(0, earliestUnclosedIdx);
  }

  const trailingEntity = cut.match(/&[a-zA-Z0-9#]{0,12}$/);
  if (trailingEntity && typeof trailingEntity.index === 'number') {
    cut = cut.slice(0, trailingEntity.index);
  }
  return cut;
}

/**
 * Universally detects non-English regional dubbed/subtitled trailer titles across storefronts.
 * Preserves English, US, UK, EN, International, Global, PEGI, and ESRB trailers, and never
 * misclassifies ordinary English title words ("Make It Count", "Tour de Force", "AR Mode").
 */
export function isNonEnglishRegionalMovieName(name?: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed) return false;

  // 1. Non-Latin regional scripts (CJK, Cyrillic, Arabic, Hangul, Kana)
  if (/[\u0400-\u04ff\u0600-\u06ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(trimmed)) {
    return true;
  }

  // 2a. Explicit hyphenated regional locale pairs (unambiguous across case)
  if (
    /(?:^|[\s_\-[(\/])(?:PT-BR|ES-MX|ES-AR|ES-419|FR-CA|ZH-CN|ZH-TW|ZH-HANS|ZH-HANT)(?:$|[\s_\-\])\/.])/i.test(
      trimmed
    )
  ) {
    return true;
  }

  // 2b. Bracketed or parenthesized regional ISO tags, e.g. "[ES]", "(ITA)", "(FR)", "[DE]"
  if (
    /[\[(]\s*(?:IT|ITA|FR|FRA|FRE|DE|DEU|GER|ES|ESP|SPA|PT|POR|BR|PTBR|RU|RUS|PL|POL|JP|JPN|KR|KOR|CN|CHN|ZH|ZHS|ZHT|TW|CHT|CHS|TR|TUR|ARA|LATAM)\s*[\])]/i.test(
      trimmed
    )
  ) {
    return true;
  }

  // 2c. Case-sensitive uppercase ISO tags delimited by underscores, slashes, or hyphen separators in production trailer filenames
  // e.g. "Wolfenstein II_Launch Trailer_IT_PEGI", "12_RE9_LaunchPV_Multi_IT_FullHD_PEGI.mp4", "Launch_Trailer_FR_1080p", "Trailer - DE"
  if (
    /(?:_|\/|\s-\s)(?:IT|ITA|FR|FRA|FRE|DE|DEU|GER|ES|ESP|SPA|PT|POR|BR|PTBR|RU|RUS|PL|POL|JP|JPN|KR|KOR|CN|CHN|ZH|ZHS|ZHT|TW|CHT|CHS|TR|TUR|ARA|LATAM)(?=$|[_\-\/\])\s.])/.test(
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

export interface SteamStoreBrowseAssets {
  capsuleImage?: string;
  headerImage?: string;
  iconUrl?: string;
  ts: number;
}

export type StoreBrowseAssets = SteamStoreBrowseAssets;

const STORAGE_KEY_BROWSE_ASSETS = 'antigravity_steam_browse_assets_v1';
const BROWSE_ASSETS_BATCH_CHUNK_SIZE = 80;

function toLightweightSteamDigest(meta: SteamEnrichedMetadata): SteamEnrichedMetadata {
  return {
    appId: meta.appId,
    name: meta.name,
    shortDescription: meta.shortDescription,
    detailedDescription: '',
    aboutTheGame: '',
    headerImage: meta.headerImage,
    capsuleImage: meta.capsuleImage,
    iconUrl: meta.iconUrl,
    developers: meta.developers,
    publishers: meta.publishers,
    releaseDate: meta.releaseDate,
    genres: meta.genres,
    tags: meta.tags,
    categories: [],
    screenshots: [],
    movies: [],
    supportedLanguages: meta.supportedLanguages,
    languageOptions: meta.languageOptions,
    languageTableSchema: meta.languageTableSchema,
    systemRequirements: {},
    reviewSummary: meta.reviewSummary,
    metacritic: meta.metacritic,
    platforms: meta.platforms,
    xboxDeliveryHints: meta.xboxDeliveryHints,
    metadataQuality: meta.metadataQuality,
    enrichedSource: meta.enrichedSource,
    fetchedAt: meta.fetchedAt,
  };
}

export class SteamApiService {
  public static readonly MAX_METADATA_CACHE_ENTRIES = 60;
  public static readonly MAX_METADATA_CACHE_SIZE = 60;
  private static readonly MAX_DIGEST_CACHE_SIZE = 4096;
  private static readonly staticEnrichedMemo = new Map<number, SteamEnrichedMetadata | null>();
  private cache = new Map<number, SteamEnrichedMetadata>();
  private digestCache = new Map<number, SteamEnrichedMetadata>();
  private rateLimitedUntil = 0;
  private browseAssetsCache = new Map<number, SteamStoreBrowseAssets>();
  private inFlightBrowseAssets = new Map<number, Promise<SteamStoreBrowseAssets | null>>();
  private browseCacheLoaded = false;

  private loadBrowseAssetsCache(): void {
    if (this.browseCacheLoaded) return;
    this.browseCacheLoaded = true;
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(STORAGE_KEY_BROWSE_ASSETS);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          const id = Number(k);
          if (Number.isFinite(id) && id > 0 && v && typeof v === 'object') {
            const entry = v as SteamStoreBrowseAssets;
            if (entry.capsuleImage || entry.headerImage || entry.iconUrl) {
              this.browseAssetsCache.set(id, entry);
            }
          }
        }
      }
    } catch {
      // Ignore storage errors
    }
  }

  private saveBrowseAssetsCache(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const obj: Record<string, SteamStoreBrowseAssets> = {};
      const entries = Array.from(this.browseAssetsCache.entries()).slice(-1000);
      for (const [k, v] of entries) {
        if (v.capsuleImage || v.headerImage || v.iconUrl) {
          obj[String(k)] = v;
        }
      }
      localStorage.setItem(STORAGE_KEY_BROWSE_ASSETS, JSON.stringify(obj));
    } catch {
      // Ignore quota errors
    }
  }

  public getStoreBrowseAssetsInstant(appId?: number | null): SteamStoreBrowseAssets | null {
    if (!appId || appId <= 0) return null;
    this.loadBrowseAssetsCache();
    return this.browseAssetsCache.get(appId) || null;
  }

  public peekCachedBrowseAssets(appId?: number | null): SteamStoreBrowseAssets | null {
    return this.getStoreBrowseAssetsInstant(appId);
  }

  public evictCache(appId: number): void {
    if (!appId) return;
    this.metadataCache.delete(appId);
    this.digestCache.delete(appId);
    void vaultDelete(`enriched_metadata:${appId}`);
    this.loadBrowseAssetsCache();
    if (this.browseAssetsCache.delete(appId)) {
      this.saveBrowseAssetsCache();
    }
  }

  private getSteamWebApiBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/steam-api';
    }
    return 'https://api.steampowered.com';
  }

  private parseStoreBrowseItemAssets(
    appId: number,
    assets: {
      asset_url_format?: string;
      library_capsule_2x?: string;
      library_capsule?: string;
      header?: string;
      community_icon?: string;
    } | null | undefined,
    cached?: SteamStoreBrowseAssets
  ): SteamStoreBrowseAssets | null {
    if (!assets || typeof assets !== 'object') {
      return cached || null;
    }

    const format =
      typeof assets.asset_url_format === 'string' && assets.asset_url_format
        ? assets.asset_url_format
        : `steam/apps/${appId}/\${FILENAME}`;

    const buildAssetUrl = (file?: string): string | undefined => {
      if (!file || typeof file !== 'string') return undefined;
      if (file.startsWith('http')) return file;
      return `https://shared.akamai.steamstatic.com/store_item_assets/${format.replace(
        '${FILENAME}',
        file
      )}`;
    };

    const capsuleImage = buildAssetUrl(assets.library_capsule_2x || assets.library_capsule);
    const headerImage = buildAssetUrl(assets.header);
    const rawIcon =
      typeof assets.community_icon === 'string' && assets.community_icon
        ? assets.community_icon
        : undefined;
    const iconUrl = rawIcon
      ? rawIcon.startsWith('http')
        ? rawIcon
        : `https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/${appId}/${
            rawIcon.endsWith('.jpg') ? rawIcon : `${rawIcon}.jpg`
          }`
      : undefined;

    if (!capsuleImage && !headerImage && !iconUrl) {
      return cached || null;
    }

    return {
      capsuleImage: capsuleImage || cached?.capsuleImage,
      headerImage: headerImage || cached?.headerImage,
      iconUrl: iconUrl || cached?.iconUrl,
      ts: Date.now(),
    };
  }

  public async fetchStoreBrowseAssets(
    appId: number,
    priority: number = RequestPriority.P1_VIEWPORT
  ): Promise<SteamStoreBrowseAssets | null> {
    if (!appId || appId <= 0) return null;
    this.loadBrowseAssetsCache();
    const cached = this.browseAssetsCache.get(appId);
    if (cached && cached.capsuleImage) {
      return cached;
    }

    if (this.inFlightBrowseAssets.has(appId)) {
      return this.inFlightBrowseAssets.get(appId)!;
    }

    const promise = (async (): Promise<SteamStoreBrowseAssets | null> => {
      try {
        const inputJson = JSON.stringify({
          ids: [{ appid: appId }],
          context: { language: 'english', country_code: 'US' },
          data_request: { include_assets: true },
        });
        const url = `${this.getSteamWebApiBaseUrl()}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(
          inputJson
        )}`;
        const res = await requestScheduler.schedule(
          url,
          () => axios.get(url, { timeout: 6000 }),
          priority,
          'api.steampowered.com'
        );
        const item = res?.data?.response?.store_items?.[0];
        const resolved = this.parseStoreBrowseItemAssets(appId, item?.assets, cached);
        if (!resolved || resolved === cached) {
          return cached || null;
        }
        this.browseAssetsCache.set(appId, resolved);
        this.saveBrowseAssetsCache();

        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('antigravity:steam-assets-resolved', {
              detail: { appId, ...resolved },
            })
          );
        }
        return resolved;
      } catch {
        return cached || null;
      } finally {
        this.inFlightBrowseAssets.delete(appId);
      }
    })();

    this.inFlightBrowseAssets.set(appId, promise);
    return promise;
  }

  /**
   * Batch-resolves 2x SHA1-hashed Steam library covers, headers, and community icons
   * for up to 80 AppIDs per IStoreBrowseService/GetItems/v1 GET request.
   */
  public async fetchStoreBrowseAssetsBatch(
    appIds: number[],
    priority: number = RequestPriority.P2_BACKGROUND
  ): Promise<Map<number, SteamStoreBrowseAssets>> {
    const result = new Map<number, SteamStoreBrowseAssets>();
    if (!Array.isArray(appIds) || appIds.length === 0) return result;

    this.loadBrowseAssetsCache();
    const missing: number[] = [];
    const seen = new Set<number>();
    for (const rawId of appIds) {
      const id = Number(rawId);
      if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      const cached = this.browseAssetsCache.get(id);
      if (cached && cached.capsuleImage) {
        result.set(id, cached);
      } else {
        missing.push(id);
      }
    }

    if (missing.length === 0 || !onlineLifecycleManager.isOnline()) {
      return result;
    }

    let updatedAny = false;
    for (let offset = 0; offset < missing.length; offset += BROWSE_ASSETS_BATCH_CHUNK_SIZE) {
      if (!onlineLifecycleManager.isOnline()) break;
      const chunk = missing.slice(offset, offset + BROWSE_ASSETS_BATCH_CHUNK_SIZE);
      try {
        const inputJson = JSON.stringify({
          ids: chunk.map((appid) => ({ appid })),
          context: { language: 'english', country_code: 'US' },
          data_request: { include_assets: true },
        });
        const url = `${this.getSteamWebApiBaseUrl()}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(
          inputJson
        )}`;
        const res = await requestScheduler.schedule(
          url,
          () => axios.get(url, { timeout: 8000 }),
          priority,
          'api.steampowered.com'
        );
        const storeItems = res?.data?.response?.store_items;
        if (Array.isArray(storeItems)) {
          for (const item of storeItems) {
            const itemAppId = Number(item?.appid ?? item?.id);
            if (!Number.isFinite(itemAppId) || itemAppId <= 0) continue;
            const prevCached = this.browseAssetsCache.get(itemAppId);
            const resolved = this.parseStoreBrowseItemAssets(itemAppId, item?.assets, prevCached);
            if (resolved && resolved !== prevCached) {
              this.browseAssetsCache.set(itemAppId, resolved);
              result.set(itemAppId, resolved);
              updatedAny = true;
              if (typeof window !== 'undefined') {
                try {
                  window.dispatchEvent(
                    new CustomEvent('antigravity:steam-assets-resolved', {
                      detail: { appId: itemAppId, ...resolved },
                    })
                  );
                } catch {}
              }
            }
          }
        }
      } catch {
        // Best-effort batch enrichment; preserve already-cached items
      }
    }

    if (updatedAny) {
      this.saveBrowseAssetsCache();
    }
    return result;
  }

  private get metadataCache(): Map<number, SteamEnrichedMetadata> {
    return this.cache;
  }

  private setDigestCacheEntry(appId: number, value: SteamEnrichedMetadata): void {
    if (this.digestCache.has(appId)) {
      this.digestCache.delete(appId);
    }
    this.digestCache.set(appId, toLightweightSteamDigest(value));
    while (this.digestCache.size > SteamApiService.MAX_DIGEST_CACHE_SIZE) {
      const oldestKey = this.digestCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.digestCache.delete(oldestKey);
    }
  }

  private setCacheEntry(appId: number, value: SteamEnrichedMetadata): void {
    if (this.metadataCache.has(appId)) {
      this.metadataCache.delete(appId);
    }
    this.digestCache.delete(appId);
    this.metadataCache.set(appId, value);
    while (this.metadataCache.size > SteamApiService.MAX_METADATA_CACHE_SIZE) {
      const oldestKey = this.metadataCache.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = this.metadataCache.get(oldestKey);
      this.metadataCache.delete(oldestKey);
      if (evicted) {
        this.setDigestCacheEntry(oldestKey, evicted);
      }
    }
  }

  public trimMemoryCache(maxEntries: number = 30): void {
    const limit = Math.max(0, maxEntries);
    while (this.metadataCache.size > limit) {
      const oldestKey = this.metadataCache.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = this.metadataCache.get(oldestKey);
      this.metadataCache.delete(oldestKey);
      if (evicted) {
        // Retain lightweight synopsis/developer/year digest so diagnostics & filters never thrash
        this.setDigestCacheEntry(oldestKey, evicted);
      }
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
    if (!appId || appId <= 0) return null;
    if (this.metadataCache.has(appId)) {
      const hit = this.metadataCache.get(appId)!;
      this.setCacheEntry(appId, hit);
      return hit;
    }
    if (this.digestCache.has(appId)) {
      return this.digestCache.get(appId)!;
    }
    if (SteamApiService.staticEnrichedMemo.has(appId)) {
      return SteamApiService.staticEnrichedMemo.get(appId) ?? null;
    }
    const preCached = (
      steamEnrichedCache as Record<string, (Partial<SteamEnrichedMetadata> & { library_capsule?: string }) | undefined>
    )[String(appId)];
    if (preCached && preCached.shortDescription) {
      const languageOptions =
        Array.isArray(preCached.languageOptions) && preCached.languageOptions.length > 0
          ? preCached.languageOptions
          : preCached.supportedLanguages
          ? parseSteamSupportedLanguagesString(preCached.supportedLanguages)
          : undefined;
      const built: SteamEnrichedMetadata = {
        ...(preCached as SteamEnrichedMetadata),
        appId,
        shortDescription: stripHtmlToPlainSynopsis(preCached.shortDescription),
        movies: filterEnglishMovies<SteamMovie>(preCached.movies || []).slice(0, 4),
        screenshots: Array.isArray(preCached.screenshots) ? preCached.screenshots.slice(0, 12) : [],
        languageOptions,
        languageTableSchema: preCached.languageTableSchema || 'steam',
        metadataQuality: preCached.metadataQuality || 'authoritative',
        enrichedSource: 'steam',
      };
      SteamApiService.staticEnrichedMemo.set(appId, built);
      return built;
    }
    SteamApiService.staticEnrichedMemo.set(appId, null);
    return null;
  }

  private isValidAuthoritativeSteamMetadata(
    meta: SteamEnrichedMetadata | null | undefined,
    expectedAppId: number,
    detailQuality?: string
  ): meta is SteamEnrichedMetadata {
    if (!meta || typeof meta !== 'object') return false;
    if (!(meta.name || meta.shortDescription || meta.aboutTheGame || meta.detailedDescription)) {
      return false;
    }
    if (meta.enrichedSource === 'xbox') return false;
    const effectiveQuality = meta.metadataQuality || detailQuality;
    if (
      effectiveQuality === 'storefront_native' ||
      effectiveQuality === 'skeleton_fallback' ||
      effectiveQuality === 'local_federated'
    ) {
      return false;
    }
    if (meta.appId !== undefined && Number(meta.appId) !== Number(expectedAppId)) {
      return false;
    }
    if (
      meta.appId === undefined &&
      effectiveQuality !== 'authoritative' &&
      effectiveQuality !== 'scraped'
    ) {
      return false;
    }
    return true;
  }

  private async loadPersistedMetadata(appId: number): Promise<SteamEnrichedMetadata | null> {
    try {
      const fromIdb = await vaultGet<SteamEnrichedMetadata>(`enriched_metadata:${appId}`);
      if (fromIdb && typeof fromIdb === 'object') {
        if (this.isValidAuthoritativeSteamMetadata(fromIdb, appId)) {
          return {
            ...fromIdb,
            appId,
            metadataQuality: fromIdb.metadataQuality || 'authoritative',
            enrichedSource: fromIdb.enrichedSource || 'steam',
          };
        }
        // Evict poisoned/storefront_native entry stored under a Steam AppID key
        void vaultDelete(`enriched_metadata:${appId}`);
      }
    } catch {}

    if (typeof window !== 'undefined' && window.electronAPI?.offlineVault?.getGameDetail) {
      try {
        const detail = await window.electronAPI.offlineVault.getGameDetail(`steam-${appId}`);
        if (
          detail?.enrichedMetadata &&
          this.isValidAuthoritativeSteamMetadata(
            detail.enrichedMetadata,
            appId,
            detail.metadataQuality
          )
        ) {
          const sanitized: SteamEnrichedMetadata = {
            ...detail.enrichedMetadata,
            appId,
            metadataQuality: detail.enrichedMetadata.metadataQuality || 'authoritative',
            enrichedSource: detail.enrichedMetadata.enrichedSource || 'steam',
          };
          void vaultSet(`enriched_metadata:${appId}`, sanitized);
          return sanitized;
        }
      } catch {}
    }

    return null;
  }

  private persistAuthoritativeMetadata(appId: number, metadata: SteamEnrichedMetadata): void {
    void vaultSet(`enriched_metadata:${appId}`, metadata);
    if (typeof window !== 'undefined' && window.electronAPI?.offlineVault?.saveGameDetail) {
      try {
        void window.electronAPI.offlineVault
          .saveGameDetail({
            gameId: `steam-${appId}`,
            steamAppId: appId,
            canonicalTitle: metadata.name,
            enrichedMetadata: metadata,
            metadataQuality: 'authoritative',
            enrichedAt: metadata.fetchedAt || Date.now(),
          })
          ?.catch?.(() => {});
      } catch {}
    }
  }

  async fetchGameMetadata(
    appId: number,
    priority: number = RequestPriority.P1_VIEWPORT,
    options?: { forceRefresh?: boolean }
  ): Promise<SteamEnrichedMetadata | null> {
    const forceRefresh = Boolean(options?.forceRefresh);
    const isOnline = onlineLifecycleManager.isOnline();
    const inMemoryCached = this.metadataCache.get(appId) || null;

    if (inMemoryCached && (!forceRefresh || !isOnline || this.isStoreRateLimited())) {
      this.setCacheEntry(appId, inMemoryCached);
      return inMemoryCached;
    }

    let preCachedEnriched: SteamEnrichedMetadata | null = null;
    const preCached = (
      steamEnrichedCache as Record<
        string,
        | (Partial<SteamEnrichedMetadata> & {
            library_capsule?: string;
            movies?: Array<SteamMovie & { hls_h264?: string }>;
          })
        | undefined
      >
    )[String(appId)];
    if (preCached && preCached.aboutTheGame) {
      const normalizedMovies: SteamMovie[] = filterEnglishMovies<SteamMovie>(
        (preCached.movies || []).map((m) => ({
          id: m.id,
          name: m.name,
          thumbnail: m.thumbnail,
          hls: m.hls || m.hls_h264 || '',
          webm: m.webm || { 480: '', max: '' },
          mp4: m.mp4 || { 480: '', max: '' },
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
      const safeAbout = truncateHtmlSafely(rawAbout, 35000);
      const safeDetailedDesc =
        rawDetailedDesc === rawAbout ? safeAbout : truncateHtmlSafely(rawDetailedDesc, 35000);

      const rawPreCachedCapsule = preCached.capsuleImage || preCached.library_capsule;
      const validPreCachedCapsule =
        typeof rawPreCachedCapsule === 'string' &&
        rawPreCachedCapsule &&
        !rawPreCachedCapsule.includes('184x69') &&
        !rawPreCachedCapsule.includes('231x87')
          ? rawPreCachedCapsule
          : this.getStoreBrowseAssetsInstant(appId)?.capsuleImage;

      const builtPreCached: SteamEnrichedMetadata = {
        ...(preCached as SteamEnrichedMetadata),
        appId,
        shortDescription: stripHtmlToPlainSynopsis(preCached.shortDescription || ''),
        detailedDescription: safeDetailedDesc,
        aboutTheGame: safeAbout,
        capsuleImage: validPreCachedCapsule,
        screenshots: Array.isArray(preCached.screenshots) ? preCached.screenshots.slice(0, 12) : [],
        movies: normalizedMovies,
        languageOptions,
        languageTableSchema: preCached.languageTableSchema || 'steam',
        categories: (preCached.categories || []).map((c) => ({
          ...c,
          icon: getSteamCategoryIconUrl(c.id),
        })),
        metadataQuality: preCached.metadataQuality || 'authoritative',
        enrichedSource: 'steam',
      };
      preCachedEnriched = builtPreCached;
      if (!forceRefresh) {
        this.setCacheEntry(appId, builtPreCached);
        return builtPreCached;
      }
    }

    const persisted = await this.loadPersistedMetadata(appId);
    if (persisted && (!isOnline || this.isStoreRateLimited() || !forceRefresh)) {
      this.setCacheEntry(appId, persisted);
      return persisted;
    }

    const fallbackMetadata = persisted || inMemoryCached || preCachedEnriched || null;

    if (!isOnline || this.isStoreRateLimited()) {
      return fallbackMetadata;
    }

    const neg404Key = `${STEAM_APPDETAILS_404_KEY_PREFIX}${appId}`;
    if (!forceRefresh && loadStagedCache<null>(neg404Key, false).valid) {
      return fallbackMetadata;
    }

    const baseUrl = this.getBaseUrl();
    const url = `${baseUrl}/api/appdetails?appids=${appId}&l=english&cc=US`;
    const gameKey = `steam:${appId}`;

    return requestScheduler
      .schedule(
        url,
        async () => {
          const detailsRes = await axios.get<
            Record<
              string,
              {
                success?: boolean;
                data?: {
                  name: string;
                  short_description?: string;
                  detailed_description?: string;
                  about_the_game?: string;
                  header_image?: string;
                  library_capsule?: string;
                  developers?: string[];
                  publishers?: string[];
                  release_date?: { date?: string; coming_soon?: boolean };
                  screenshots?: Array<{ id: number; path_thumbnail: string; path_full: string }>;
                  movies?: Array<{
                    id: number;
                    name: string;
                    thumbnail: string;
                    hls_h264?: string;
                    hls?: string;
                    webm?: { '480'?: string; max?: string };
                    mp4?: { '480'?: string; max?: string };
                  }>;
                  categories?: Array<{ id: number; description: string }>;
                  genres?: Array<{ description: string }>;
                  achievements?: {
                    total: number;
                    highlighted?: Array<{ name?: string; localized_name?: string; path?: string }>;
                  };
                  supported_languages?: string;
                  pc_requirements?: { minimum?: string; recommended?: string } | unknown[];
                  mac_requirements?: { minimum?: string; recommended?: string } | unknown[];
                  linux_requirements?: { minimum?: string; recommended?: string } | unknown[];
                  legal_notice?: string;
                  drm_notice?: string;
                  ext_user_account_notice?: string;
                  website?: string;
                  controller_support?: 'full' | 'partial';
                  metacritic?: { score: number; url?: string };
                  platforms?: { windows?: boolean; mac?: boolean; linux?: boolean };
                };
              }
            >
          >(url, {
            timeout: 8000,
            headers: {
              Cookie:
                'Steam_Language=english; birthtime=568022401; mature_content=1; wants_mature_content=1',
              'Accept-Language': 'en-US,en;q=0.9',
            },
          });

          const appData = detailsRes.data?.[String(appId)];
          if (!appData || !appData.success || !appData.data) {
            if (appData && appData.success === false && onlineLifecycleManager.isOnline()) {
              saveStagedCache<null>(neg404Key, null, 'negative', {
                failureReason: 'not_found',
                dynamicResolved: true,
                customTtlMs: STEAM_APPDETAILS_404_TTL_MS,
              });
            }
            return fallbackMetadata;
          }
          evictStagedCache(neg404Key);

          const data = appData.data;

          // Execute supplementary Steam Store requests sequentially inside the single scheduled slot
          // so maxConcurrent on store.steampowered.com is strictly honored without re-entrant deadlock.
          const reviewsRes = !this.isStoreRateLimited()
            ? await axios
                .get<{
                  query_summary?: {
                    total_reviews?: number;
                    total_positive?: number;
                    total_negative?: number;
                    review_score?: number;
                    review_score_desc?: string;
                  };
                }>(`${baseUrl}/appreviews/${appId}?json=1&language=all`, { timeout: 6000 })
                .catch(() => null)
            : null;

          const storePageRes = !this.isStoreRateLimited()
            ? await axios
                .get<string>(`${baseUrl}/app/${appId}/?l=english&cc=US`, {
                  timeout: 6000,
                  headers: {
                    Cookie:
                      'Steam_Language=english; birthtime=568022401; mature_content=1; wants_mature_content=1',
                    'Accept-Language': 'en-US,en;q=0.9',
                  },
                })
                .catch(() => null)
            : null;

          // Extract screenshots
          const screenshots: SteamScreenshot[] = (data.screenshots || [])
            .slice(0, 12)
            .map((s) => ({
              id: s.id,
              pathThumbnail: s.path_thumbnail,
              pathFull: s.path_full,
            }));

          // Extract movies / trailers
          const rawMovies: SteamMovie[] = (data.movies || []).map((m) => {
            const hlsUrl = m.hls_h264 || m.hls || '';
            const rawMp4Max =
              m.mp4?.max && !m.mp4.max.includes('.mpd') && !m.mp4.max.includes('.m3u8')
                ? m.mp4.max
                : '';
            const rawMp4Low =
              m.mp4?.['480'] && !m.mp4['480'].includes('.mpd') && !m.mp4['480'].includes('.m3u8')
                ? m.mp4['480']
                : '';

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
              reviewScoreDesc:
                qs.review_score_desc || (total > 0 ? `${percent}% Positive` : 'No User Reviews'),
              totalPositive: positive,
              totalNegative: negative,
              totalReviews: total,
              positivePercent: percent,
            };
          }

          // Extract categories (features)
          const categories: SteamCategory[] = (data.categories || []).map((c) => ({
            id: c.id,
            description: c.description,
            icon: getSteamCategoryIconUrl(c.id),
          }));

          // Extract genres & tags
          const genres: string[] = (data.genres || []).map((g) => g.description);
          const tags: string[] = (data.categories || []).map((c) => c.description).slice(0, 10);

          // Extract achievements
          let achievements:
            | { total: number; highlighted?: Array<{ name: string; path: string }> }
            | undefined = undefined;
          if (data.achievements && typeof data.achievements.total === 'number') {
            achievements = {
              total: data.achievements.total,
              highlighted: (data.achievements.highlighted || []).map((h) => ({
                name: h.name || h.localized_name || '',
                path: h.path || '',
              })),
            };
          }

          const directLibraryCapsule =
            typeof data.library_capsule === 'string' &&
            data.library_capsule &&
            !data.library_capsule.includes('184x69') &&
            !data.library_capsule.includes('231x87')
              ? data.library_capsule
              : undefined;

          const browseAssets = directLibraryCapsule
            ? this.getStoreBrowseAssetsInstant(appId)
            : await this.fetchStoreBrowseAssets(appId, priority).catch(() => null);

          const resolvedCapsuleImage =
            directLibraryCapsule || browseAssets?.capsuleImage || undefined;

          const htmlLanguageOptions = parseSteamLanguageTableHtml(
            typeof storePageRes?.data === 'string' ? storePageRes.data : ''
          );
          const resolvedLanguageOptions =
            htmlLanguageOptions.length > 0
              ? htmlLanguageOptions
              : parseSteamSupportedLanguagesString(data.supported_languages);

          const rawDetailedDesc = String(data.detailed_description || '');
          const rawAboutTheGame = String(data.about_the_game || '');
          const safeAboutTheGame = truncateHtmlSafely(rawAboutTheGame, 35000);
          const safeDetailedDesc =
            rawDetailedDesc === rawAboutTheGame
              ? safeAboutTheGame
              : truncateHtmlSafely(rawDetailedDesc, 35000);

          const parsePlatformRequirements = (
            req: unknown
          ): { minimum?: string; recommended?: string } | undefined => {
            if (!req || typeof req !== 'object' || Array.isArray(req)) return undefined;
            const recObj = req as { minimum?: unknown; recommended?: unknown };
            const minimum =
              typeof recObj.minimum === 'string' && recObj.minimum ? recObj.minimum : undefined;
            const recommended =
              typeof recObj.recommended === 'string' && recObj.recommended
                ? recObj.recommended
                : undefined;
            if (!minimum && !recommended) return undefined;
            return { minimum, recommended };
          };

          const pcReqsObj =
            data.pc_requirements &&
            typeof data.pc_requirements === 'object' &&
            !Array.isArray(data.pc_requirements)
              ? data.pc_requirements
              : undefined;

          const fetchedAt = Date.now();
          const metadata: SteamEnrichedMetadata = {
            appId,
            name: data.name,
            shortDescription: stripHtmlToPlainSynopsis(data.short_description || ''),
            detailedDescription: safeDetailedDesc,
            aboutTheGame: safeAboutTheGame,
            headerImage: data.header_image || browseAssets?.headerImage || '',
            capsuleImage: resolvedCapsuleImage,
            developers: data.developers || [],
            publishers: data.publishers || [],
            releaseDate:
              data.release_date?.date || (data.release_date?.coming_soon ? 'Coming Soon' : 'TBA'),
            genres,
            tags,
            categories,
            screenshots,
            movies,
            systemRequirements: {
              minimum: typeof pcReqsObj?.minimum === 'string' ? pcReqsObj.minimum : undefined,
              recommended:
                typeof pcReqsObj?.recommended === 'string' ? pcReqsObj.recommended : undefined,
            },
            macRequirements: parsePlatformRequirements(data.mac_requirements),
            linuxRequirements: parsePlatformRequirements(data.linux_requirements),
            reviewSummary,
            supportedLanguages: data.supported_languages,
            languageOptions: resolvedLanguageOptions.length > 0 ? resolvedLanguageOptions : undefined,
            languageTableSchema: 'steam',
            legalNotice: data.legal_notice,
            drmNotice: data.drm_notice,
            extUserAccountNotice:
              typeof data.ext_user_account_notice === 'string' && data.ext_user_account_notice
                ? data.ext_user_account_notice
                : undefined,
            website:
              typeof data.website === 'string' && data.website ? data.website : undefined,
            controllerSupport: data.controller_support,
            pcRequirementsHtml: pcReqsObj?.minimum || undefined,
            metadataQuality: 'authoritative',
            enrichedSource: 'steam',
            fetchedAt,
            enrichedAt: fetchedAt,
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
          this.persistAuthoritativeMetadata(appId, metadata);

          return metadata;
        },
        priority,
        'store.steampowered.com',
        gameKey
      )
      .catch((err: unknown) => {
        const errObj =
          err && typeof err === 'object'
            ? (err as { response?: { status?: number }; isRateLimited?: boolean })
            : undefined;
        const status = errObj?.response?.status;
        if (
          onlineLifecycleManager.isOnline() &&
          (status === 403 || status === 429 || errObj?.isRateLimited)
        ) {
          // Akamai CDN edge rate limit: pause storefront web requests for 15 minutes to let the cooldown reset cleanly
          this.rateLimitedUntil = Date.now() + 15 * 60 * 1000;
          requestScheduler.setCooldown('store.steampowered.com', 900);
          console.warn(
            `[Steam API] Akamai edge cooldown encountered (${status || 429}). Pausing web requests to store.steampowered.com for 15 minutes to allow IP cooldown to clear.`
          );
        } else {
          console.warn(`Failed to fetch Steam metadata for appId ${appId}:`, err);
        }
        return fallbackMetadata;
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
