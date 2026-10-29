import { CanonicalGame } from '../../../contracts/game';
import { UserGameOverride } from '../../../contracts/override';
import { SuppressedCatalogEntry } from '../../../services/integrations/catalogSanitizer';
import {
  buildCandidateStoreUrl,
  extractXboxBigId,
  isXboxStoreCandidateId,
} from '../../../services/scraper/metadataScraperService';
import { isGenericPlaceholderSynopsis } from '../../../services/steam/fallbackMetadataProvider';
import { steamApi } from '../../../services/steam/steamApi';
import gogEnrichedCache from '../../../services/storage/gogEnrichedCache.json';
import steamBlurbCache from '../../../services/storage/steamBlurbCache.json';
import {
  AutoFilteredSubFilter,
  GogCachedMetadataEntry,
  UnmatchedDiagnosticReason,
} from './matchManagerTypes';

const TYPED_GOG_ENRICHED_CACHE = gogEnrichedCache as Record<
  string,
  GogCachedMetadataEntry | undefined
>;
const TYPED_STEAM_BLURB_CACHE = steamBlurbCache as Record<string, string | undefined>;

export const STORAGE_KEY_EMPTY_SYNOPSIS_PROBES =
  'universal_game_library_empty_synopsis_probes_v1';
const EMPTY_SYNOPSIS_PROBE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_EMPTY_SYNOPSIS_PROBES = 4_000;

let cachedEmptyProbeStorageRef: Storage | null = null;
let cachedEmptyProbeRaw: string | null = null;
let cachedEmptyProbeMap = new Map<string, number>();

function getSafeLocalStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      return (globalThis as { localStorage?: Storage }).localStorage ?? null;
    }
  } catch {
    // Ignore sandboxed storage access errors
  }
  return null;
}

function loadDurableEmptySynopsisProbeMap(): Map<string, number> {
  const storage = getSafeLocalStorage();
  if (!storage || typeof storage.getItem !== 'function') {
    return cachedEmptyProbeMap;
  }
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY_EMPTY_SYNOPSIS_PROBES);
  } catch {
    return cachedEmptyProbeMap;
  }
  if (storage === cachedEmptyProbeStorageRef && raw === cachedEmptyProbeRaw) {
    return cachedEmptyProbeMap;
  }
  const next = new Map<string, number>();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        const now = Date.now();
        for (const [id, ts] of Object.entries(parsed)) {
          if (
            typeof ts === 'number' &&
            Number.isFinite(ts) &&
            now - ts < EMPTY_SYNOPSIS_PROBE_TTL_MS
          ) {
            next.set(id, ts);
          }
        }
      }
    } catch {
      // Ignore malformed JSON
    }
  }
  cachedEmptyProbeStorageRef = storage;
  cachedEmptyProbeRaw = raw;
  cachedEmptyProbeMap = next;
  return next;
}

export function hasDurableEmptySynopsisProbe(gameId: string): boolean {
  if (!gameId) return false;
  const map = loadDurableEmptySynopsisProbeMap();
  const ts = map.get(gameId);
  if (ts === undefined) return false;
  if (Date.now() - ts >= EMPTY_SYNOPSIS_PROBE_TTL_MS) {
    map.delete(gameId);
    return false;
  }
  return true;
}

export function recordDurableEmptySynopsisProbe(gameId: string): void {
  if (!gameId) return;
  const map = new Map(loadDurableEmptySynopsisProbeMap());
  const now = Date.now();
  map.delete(gameId);
  map.set(gameId, now);
  while (map.size > MAX_EMPTY_SYNOPSIS_PROBES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
  const storage = getSafeLocalStorage();
  if (storage && typeof storage.setItem === 'function') {
    try {
      const serialized = JSON.stringify(Object.fromEntries(map));
      storage.setItem(STORAGE_KEY_EMPTY_SYNOPSIS_PROBES, serialized);
      cachedEmptyProbeStorageRef = storage;
      cachedEmptyProbeRaw = serialized;
      cachedEmptyProbeMap = map;
      return;
    } catch {
      // Fall through to in-memory update if quota is exceeded
    }
  }
  cachedEmptyProbeMap = map;
}

export function clearDurableEmptySynopsisProbe(gameId: string): void {
  if (!gameId) return;
  const map = loadDurableEmptySynopsisProbeMap();
  if (!map.has(gameId)) return;
  const next = new Map(map);
  next.delete(gameId);
  const storage = getSafeLocalStorage();
  if (storage && typeof storage.setItem === 'function') {
    try {
      const serialized = JSON.stringify(Object.fromEntries(next));
      storage.setItem(STORAGE_KEY_EMPTY_SYNOPSIS_PROBES, serialized);
      cachedEmptyProbeStorageRef = storage;
      cachedEmptyProbeRaw = serialized;
      cachedEmptyProbeMap = next;
      return;
    } catch {
      // Ignore storage error
    }
  }
  cachedEmptyProbeMap = next;
}

export function extractCleanSynopsisText(htmlOrText?: string): string {
  if (!htmlOrText) return '';
  return htmlOrText
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[\/*[a-z0-9_=]+\]/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGenuineSynopsisCandidate(raw: string | undefined, gameTitle: string): boolean {
  if (!raw || raw.length < 25) return false;
  const bounded = raw.length > 2400 ? raw.slice(0, 2400) : raw;
  const cleaned = extractCleanSynopsisText(bounded);
  return cleaned.length >= 25 && !isGenericPlaceholderSynopsis(cleaned, gameTitle);
}

export function isLikelyNonStoreOrTestBranchTitle(title?: string): boolean {
  return Boolean(
    title &&
      (/\b(test\s*branch|beta\b|alpha\b|playtest|dedicated\s*server|sdk\b|benchmark|prototype|staging|experimental|press\s*build|review\s*build|demo\b)\b/i.test(
        title
      ) ||
        /^[a-z0-9]+(_[a-z0-9]+){2,}$/i.test(title.trim()))
  );
}

type CachedSteamMeta = ReturnType<typeof steamApi.getCachedMetadata>;

export function hasGenuineStoreSynopsis(
  game: CanonicalGame,
  override?: UserGameOverride,
  probedSynopsisMap?: Record<string, string | null>,
  preloadedSteamMeta?: CachedSteamMeta
): boolean {
  if (probedSynopsisMap && game.id in probedSynopsisMap) {
    const probed = probedSynopsisMap[game.id];
    if (typeof probed === 'string' && isGenuineSynopsisCandidate(probed, game.title)) {
      return true;
    }
    if (probed === null) {
      return false;
    }
  }

  // 1. Short-circuit on inline override & game synopsis fields first (zero storage/JSON parse)
  if (
    isGenuineSynopsisCandidate(override?.shortDescription, game.title) ||
    isGenuineSynopsisCandidate(override?.detailedDescription, game.title) ||
    isGenuineSynopsisCandidate(game.shortDescription, game.title) ||
    isGenuineSynopsisCandidate(game.detailedDescription, game.title) ||
    isGenuineSynopsisCandidate(game.enrichedMetadata?.shortDescription, game.title) ||
    isGenuineSynopsisCandidate(game.enrichedMetadata?.aboutTheGame, game.title) ||
    isGenuineSynopsisCandidate(game.enrichedMetadata?.detailedDescription, game.title)
  ) {
    return true;
  }

  // 2. Check static Steam blurb hash & cached Steam metadata only when inline fields miss
  if (game.steamAppId) {
    if (isGenuineSynopsisCandidate(TYPED_STEAM_BLURB_CACHE[String(game.steamAppId)], game.title)) {
      return true;
    }
    const cachedSteam =
      preloadedSteamMeta !== undefined
        ? preloadedSteamMeta
        : steamApi.getCachedMetadata(game.steamAppId);
    if (
      cachedSteam &&
      (isGenuineSynopsisCandidate(cachedSteam.shortDescription, game.title) ||
        isGenuineSynopsisCandidate(cachedSteam.aboutTheGame, game.title) ||
        isGenuineSynopsisCandidate(cachedSteam.detailedDescription, game.title))
    ) {
      return true;
    }
  }

  // 3. Check static GOG enriched cache only when inline fields miss
  if (game.platforms) {
    for (const p of game.platforms) {
      if (p.platformId === 'gog' && p.platformGameId) {
        const gogEntry = TYPED_GOG_ENRICHED_CACHE[p.platformGameId];
        if (
          gogEntry &&
          (isGenuineSynopsisCandidate(gogEntry.shortDescription, game.title) ||
            isGenuineSynopsisCandidate(gogEntry.description, game.title) ||
            isGenuineSynopsisCandidate(gogEntry.aboutTheGame, game.title) ||
            isGenuineSynopsisCandidate(gogEntry.detailedDescription, game.title))
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

function hasValidDeveloperEntry(list?: string[]): boolean {
  if (!Array.isArray(list) || list.length === 0) return false;
  for (const d of list) {
    if (typeof d === 'string') {
      const trimmed = d.trim();
      if (trimmed.length > 0 && trimmed !== 'Unknown Developer') {
        return true;
      }
    }
  }
  return false;
}

function hasValidReleaseDateString(dateStr?: string): boolean {
  if (typeof dateStr !== 'string') return false;
  const trimmed = dateStr.trim();
  return trimmed.length > 0 && trimmed.toUpperCase() !== 'TBA';
}

export function hasDeveloperOrReleaseYear(
  game: CanonicalGame,
  override?: UserGameOverride,
  preloadedSteamMeta?: CachedSteamMeta
): boolean {
  if (
    hasValidDeveloperEntry(override?.developers) ||
    hasValidDeveloperEntry(game.developers) ||
    hasValidDeveloperEntry(game.enrichedMetadata?.developers) ||
    hasValidReleaseDateString(override?.releaseDate) ||
    hasValidReleaseDateString(game.releaseDate) ||
    hasValidReleaseDateString(game.enrichedMetadata?.releaseDate)
  ) {
    return true;
  }

  if (game.steamAppId) {
    const cachedSteam =
      preloadedSteamMeta !== undefined
        ? preloadedSteamMeta
        : steamApi.getCachedMetadata(game.steamAppId);
    if (
      cachedSteam &&
      (hasValidDeveloperEntry(cachedSteam.developers) ||
        hasValidReleaseDateString(cachedSteam.releaseDate))
    ) {
      return true;
    }
  }

  return false;
}

export function isSynopsisAlreadyProbed(
  game: CanonicalGame,
  override?: UserGameOverride,
  probedSynopsisMap?: Record<string, string | null>
): boolean {
  if (probedSynopsisMap && game.id in probedSynopsisMap) return true;
  if (game?.id && hasDurableEmptySynopsisProbe(game.id)) return true;
  if (override?.shortDescription || override?.detailedDescription) return true;
  if (game.enrichedMetadata) {
    if (
      /product_(?:description|feature)_\d+/i.test(
        game.enrichedMetadata.shortDescription ||
          game.enrichedMetadata.aboutTheGame ||
          game.enrichedMetadata.detailedDescription ||
          ''
      )
    ) {
      return false;
    }
    if (
      game.platforms?.some((p) => p.platformId === 'epic' || p.platformId === 'gog') &&
      isGenericPlaceholderSynopsis(game.enrichedMetadata.shortDescription, game.title) &&
      (game.enrichedMetadata.screenshots?.length || 0) <= 1 &&
      !isLikelyNonStoreOrTestBranchTitle(game.title)
    ) {
      return false;
    }
    return true;
  }
  if (
    Boolean(game.shortDescription && game.shortDescription.trim().length > 0) &&
    !/product_(?:description|feature)_\d+/i.test(game.shortDescription || '') &&
    (!isGenericPlaceholderSynopsis(game.shortDescription, game.title) ||
      !game.platforms?.some((p) => p.platformId === 'epic' || p.platformId === 'gog') ||
      isLikelyNonStoreOrTestBranchTitle(game.title))
  ) {
    return true;
  }
  if (isLikelyNonStoreOrTestBranchTitle(game.title)) return true;
  if (!game.steamAppId && !game.platforms?.some((p) => Boolean(p.platformGameId))) return true;
  if (!game.capsuleImage || !game.headerImage) return true;
  return false;
}

export function getGranularUnmatchedReasons(
  game: CanonicalGame,
  override?: UserGameOverride,
  probedSynopsisMap?: Record<string, string | null>
): UnmatchedDiagnosticReason[] {
  const reasons: UnmatchedDiagnosticReason[] = [];

  if (!game.capsuleImage && !game.headerImage) {
    reasons.push({
      code: 'missing_all_art',
      label: 'Missing All Artwork',
      tooltip: 'Missing both 2:3 vertical cover and 16:9 header image',
      colorClass: 'bg-rose-950/70 border-rose-500/40 text-rose-300',
    });
  } else if (!game.capsuleImage && Boolean(game.headerImage)) {
    reasons.push({
      code: 'missing_vertical_cover',
      label: 'Missing 2:3 Cover Art',
      tooltip: 'Has 16:9 header banner, but missing 2:3 vertical box art',
      colorClass: 'bg-amber-950/70 border-amber-500/40 text-amber-300',
    });
  }

  const trimmedTitle = (game.title || '').trim();
  if (
    /^[a-z0-9_-]{6,}$/i.test(trimmedTitle) &&
    !trimmedTitle.includes(' ') &&
    (/\d/.test(trimmedTitle) || /[_-]/.test(trimmedTitle))
  ) {
    reasons.push({
      code: 'unresolved_codename',
      label: 'Unresolved Store Codename / Slug',
      tooltip: 'Title looks like a raw internal storefront identifier rather than a display name',
      colorClass: 'bg-purple-950/70 border-purple-500/40 text-purple-300',
    });
  }

  const alreadyProbed = isSynopsisAlreadyProbed(game, override, probedSynopsisMap);
  if (alreadyProbed) {
    let steamMetaLoaded = false;
    let cachedSteam: CachedSteamMeta = null;
    const getSteamMetaOnce = (): CachedSteamMeta => {
      if (!steamMetaLoaded) {
        steamMetaLoaded = true;
        cachedSteam = game.steamAppId ? steamApi.getCachedMetadata(game.steamAppId) : null;
      }
      return cachedSteam;
    };

    const hasSynopsis =
      hasGenuineStoreSynopsis(game, override, probedSynopsisMap, null) ||
      (Boolean(game.steamAppId) &&
        hasGenuineStoreSynopsis(game, override, probedSynopsisMap, getSteamMetaOnce()));

    if (!hasSynopsis) {
      reasons.push({
        code: 'missing_synopsis',
        label: 'Missing Store Synopsis',
        tooltip: 'No store description or summary blurb scraped yet',
        colorClass: 'bg-orange-950/60 border-orange-500/35 text-orange-300',
      });
    }

    const hasDevOrYear =
      hasDeveloperOrReleaseYear(game, override, null) ||
      (Boolean(game.steamAppId) &&
        hasDeveloperOrReleaseYear(game, override, getSteamMetaOnce()));

    if (!hasDevOrYear) {
      reasons.push({
        code: 'missing_dev_year',
        label: 'Missing Developer & Release Year',
        tooltip: 'Missing developer studio and release year metadata',
        colorClass: 'bg-slate-800/80 border-slate-600/50 text-slate-300',
      });
    }
  }

  return reasons;
}

export function formatSuppressionBadge(entry: SuppressedCatalogEntry): {
  label: string;
  colorClass: string;
} {
  switch (entry.reasonCategory) {
    case 'user_hidden':
      return {
        label: entry.reason || 'Hidden by User',
        colorClass: 'bg-sky-950/70 border-sky-500/40 text-sky-300',
      };
    case 'unverified_entitlement':
      return {
        label: entry.reason || 'Cryptic Code / Unresolved Slug',
        colorClass: 'bg-amber-950/70 border-amber-500/40 text-amber-300',
      };
    case 'non_game_filter':
      return {
        label: entry.reason || 'Non-Game / Engine / SDK',
        colorClass: 'bg-rose-950/70 border-rose-500/40 text-rose-300',
      };
    case 'score_suppressed':
      return {
        label: entry.reason || 'Score / Metadata Suppressed',
        colorClass: 'bg-purple-950/70 border-purple-500/40 text-purple-300',
      };
    case 'duplicate_conflict':
    default:
      return {
        label: entry.reason || 'Duplicate / Redundant Entry',
        colorClass: 'bg-slate-800 border-slate-600 text-slate-300',
      };
  }
}

export function classifyAutoFilteredSubCategory(
  entry: SuppressedCatalogEntry
): Exclude<AutoFilteredSubFilter, 'all'> {
  const rawTitle = entry.rawTitle || '';
  const reasonText = entry.reasonCategory === 'non_game_filter' ? entry.reason || '' : '';
  const combinedText = reasonText ? `${rawTitle} ${reasonText}` : rawTitle;

  if (
    /\b(?:soundtrack|ost|artbook|art\s*book|digital\s*goodies|goodie\s*pack|wallpaper|comic\s*book|original\s+score|musical\s+score|film\s+score|game\s+score)\b/i.test(
      combinedText
    )
  ) {
    return 'soundtrack';
  }
  if (/\b(?:prologue|playable\s*teaser|demo|trial)\b/i.test(combinedText)) {
    return 'prologue';
  }
  if (/\b(?:dlc|expansion|season\s*pass|upgrade\s*pack|add-?on)\b/i.test(combinedText)) {
    return 'dlc';
  }
  if (
    /\b(?:sdk|editor|tool|dedicated\s*server|redistributable|directx|vcredist|physx|authoring|mod\s*kit|server)\b/i.test(
      combinedText
    )
  ) {
    return 'tool';
  }
  return 'beta';
}

export function resolveOverrideTargetStoreDetails(
  override: UserGameOverride,
  sourceRawTitle: string
): {
  targetUrl: string;
  targetStoreLabel: string;
} {
  const isXboxTarget =
    isXboxStoreCandidateId(override.matchedId) ||
    Boolean(extractXboxBigId(override.matchedId) && override.matchedStore === 'custom');

  const targetStoreLabel = isXboxTarget ? 'xbox' : override.matchedStore || 'steam';

  const targetUrl = buildCandidateStoreUrl({
    source: targetStoreLabel,
    title: override.title || sourceRawTitle || '',
    steamAppId: override.steamAppId ?? undefined,
    gogId: override.matchedStore === 'gog' ? override.matchedId : undefined,
    epicSlug: override.matchedStore === 'epic' ? String(override.matchedId) : undefined,
    igdbId: override.igdbId,
    xboxProductId: isXboxTarget ? override.matchedId : undefined,
  });

  return { targetUrl, targetStoreLabel };
}
