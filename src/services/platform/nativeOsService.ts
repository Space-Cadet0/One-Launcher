import { CanonicalGame, NativeOsPlatform } from '../../contracts/game';
import { StorefrontId } from '../../contracts/platform';
import { steamApi } from '../steam/steamApi';
import { getEffectiveSteamAppId } from '../storage/userOverrideStorage';
import steamEnrichedCacheData from '../storage/steamEnrichedCache.json';
import gogEnrichedCacheData from '../storage/gogEnrichedCache.json';

interface RawOsFlags {
  windows?: boolean;
  mac?: boolean;
  linux?: boolean;
  Windows?: boolean;
  Mac?: boolean;
  Linux?: boolean;
}

const steamCache = (steamEnrichedCacheData || {}) as Record<string, any>;
const gogCache = (gogEnrichedCacheData || {}) as Record<string, any>;

const GOG_OS_SUPPORT_CACHE_KEY = 'gog_os_support_cache_v1';
const MAX_GOG_OS_CACHE_ENTRIES = 500;
let gogDynamicCacheRawSnapshot: string | null = null;
let gogDynamicCacheMap: Map<string, { windows: boolean; mac: boolean }> = new Map();

function syncGogDynamicCacheFromStorage(): Map<string, { windows: boolean; mac: boolean }> {
  try {
    if (typeof localStorage === 'undefined') {
      return gogDynamicCacheMap;
    }
    const raw = localStorage.getItem(GOG_OS_SUPPORT_CACHE_KEY);
    if (raw === gogDynamicCacheRawSnapshot) {
      return gogDynamicCacheMap;
    }
    gogDynamicCacheRawSnapshot = raw;
    gogDynamicCacheMap = new Map();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          const extracted = extractExplicitOsFlags(v as RawOsFlags);
          if (k && extracted) {
            gogDynamicCacheMap.set(k, extracted);
          }
        }
      }
    }
  } catch {
    // Ignore storage read errors
  }
  return gogDynamicCacheMap;
}

function setBoundedGogCacheEntry(
  map: Map<string, { windows: boolean; mac: boolean }>,
  key: string,
  value: { windows: boolean; mac: boolean }
): void {
  if (!key) return;
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > MAX_GOG_OS_CACHE_ENTRIES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

export function getCachedGogOsSupport(key?: string): RawOsFlags | undefined {
  if (!key) return undefined;
  const map = syncGogDynamicCacheFromStorage();
  const trimmed = String(key).trim();
  const strippedId = trimmed.replace(/^gog-/, '');
  const norm = normalizeLookupTitle(trimmed);
  return (
    map.get(trimmed) ||
    map.get(strippedId) ||
    (norm ? map.get(norm) : undefined) ||
    map.get(trimmed.toLowerCase())
  );
}

export function saveCachedGogOsSupport(
  gogId?: string,
  title?: string,
  flags?: { windows: boolean; mac: boolean }
): void {
  if (!flags || typeof flags !== 'object') return;
  const normalizedFlags = {
    windows: flags.windows !== false,
    mac: flags.mac === true,
  };
  const map = syncGogDynamicCacheFromStorage();
  const cleanId = gogId ? String(gogId).replace(/^gog-/, '').trim() : '';
  const normTitle = normalizeLookupTitle(title);

  if (cleanId) {
    setBoundedGogCacheEntry(map, cleanId, normalizedFlags);
  }
  if (normTitle) {
    setBoundedGogCacheEntry(map, normTitle, normalizedFlags);
  }

  try {
    if (typeof localStorage !== 'undefined') {
      const serialized = JSON.stringify(Object.fromEntries(map.entries()));
      localStorage.setItem(GOG_OS_SUPPORT_CACHE_KEY, serialized);
      gogDynamicCacheRawSnapshot = serialized;
    }
  } catch {
    // Ignore storage quota errors
  }
}

let steamPlatformsByTitleMap: Map<string, RawOsFlags> | null = null;
let gogPlatformsByTitleMap: Map<string, RawOsFlags> | null = null;

function getSteamPlatformsByTitle(normTitle: string): RawOsFlags | undefined {
  if (!normTitle) return undefined;
  if (!steamPlatformsByTitleMap) {
    steamPlatformsByTitleMap = new Map<string, RawOsFlags>();
    for (const entry of Object.values(steamCache)) {
      if (!entry || !entry.platforms) continue;
      const key = normalizeLookupTitle(entry.name || entry.title);
      if (key && !steamPlatformsByTitleMap.has(key)) {
        steamPlatformsByTitleMap.set(key, entry.platforms);
      }
    }
  }
  return steamPlatformsByTitleMap.get(normTitle);
}

function getGogPlatformsByTitle(normTitle: string): RawOsFlags | undefined {
  if (!normTitle) return undefined;
  if (!gogPlatformsByTitleMap) {
    gogPlatformsByTitleMap = new Map<string, RawOsFlags>();
    for (const entry of Object.values(gogCache)) {
      if (!entry) continue;
      const flags = entry.platforms || entry.worksOn;
      if (!flags) continue;
      const key = normalizeLookupTitle(entry.title || entry.name);
      if (key && !gogPlatformsByTitleMap.has(key)) {
        gogPlatformsByTitleMap.set(key, flags);
      }
    }
  }
  return gogPlatformsByTitleMap.get(normTitle);
}

function normalizeLookupTitle(title?: string): string {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[:\-–—]/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractExplicitOsFlags(raw?: RawOsFlags | null): { windows: boolean; mac: boolean } | null {
  if (!raw || typeof raw !== 'object') return null;
  const winVal = typeof raw.windows === 'boolean' ? raw.windows : typeof raw.Windows === 'boolean' ? raw.Windows : undefined;
  const macVal = typeof raw.mac === 'boolean' ? raw.mac : typeof raw.Mac === 'boolean' ? raw.Mac : undefined;
  if (typeof winVal !== 'boolean' && typeof macVal !== 'boolean') {
    return null;
  }
  return {
    windows: winVal !== false,
    mac: macVal === true,
  };
}

/**
 * Resolves native OS support flags strictly isolated to a single storefront (`platformId`).
 * Prevents cross-store OS metadata bleed (e.g., Epic-only or Windows-only GOG builds inheriting
 * Steam's `mac: true` from `game.enrichedMetadata` or `steamCache`).
 */
export function getStorefrontNativeOsFlags(
  game: CanonicalGame,
  platformId: StorefrontId
): { windows: boolean; mac: boolean; isExplicit: boolean } {
  if (!game) {
    return { windows: true, mac: false, isExplicit: false };
  }

  const platObj = (game.platforms || []).find((p) => p.platformId === platformId);
  const combinedPaths = `${platObj?.installPath || ''} ${platObj?.executablePath || ''}`;
  const isNativeMacApp =
    Boolean(platObj?.installed) &&
    platObj?.isWindowsBinaryOnMac !== true &&
    !/crossover|bottles|drive_c|wine|gptk|\.exe$/i.test(combinedPaths) &&
    /\.app(\/|$)/i.test(combinedPaths);

  const normTitle = normalizeLookupTitle(game.title);

  if (platformId === 'steam') {
    const steamPlatIdNum = platObj?.platformGameId
      ? Number(String(platObj.platformGameId).replace(/^steam-/, ''))
      : NaN;
    const effectiveSteamId =
      (Number.isFinite(steamPlatIdNum) && steamPlatIdNum > 0 ? steamPlatIdNum : undefined) ||
      getEffectiveSteamAppId(game);

    const steamCandidates: Array<RawOsFlags | undefined | null> = [
      platObj?.platforms,
      effectiveSteamId ? steamApi.getCachedMetadata(effectiveSteamId)?.platforms : undefined,
      game.enrichedMetadata?.platforms,
      effectiveSteamId ? steamCache[String(effectiveSteamId)]?.platforms : undefined,
      normTitle && !game.isExplicitNonSteam ? getSteamPlatformsByTitle(normTitle) : undefined,
    ];

    for (const cand of steamCandidates) {
      const extracted = extractExplicitOsFlags(cand);
      if (extracted) {
        return {
          windows: extracted.windows,
          mac: extracted.mac || isNativeMacApp,
          isExplicit: true,
        };
      }
    }

    return {
      windows: true,
      mac: isNativeMacApp,
      isExplicit: isNativeMacApp,
    };
  }

  if (platformId === 'gog') {
    const gogId = platObj?.platformGameId
      ? String(platObj.platformGameId).replace(/^gog-/, '')
      : undefined;
    const isSingleGogGame =
      Array.isArray(game.platforms) &&
      game.platforms.length === 1 &&
      game.platforms[0]?.platformId === 'gog';

    const gogCandidates: Array<RawOsFlags | undefined | null> = [
      platObj?.platforms,
      gogId ? getCachedGogOsSupport(gogId) : undefined,
      normTitle ? getCachedGogOsSupport(normTitle) : undefined,
      gogId && gogCache[gogId] ? gogCache[gogId]?.platforms || gogCache[gogId]?.worksOn : undefined,
      normTitle ? getGogPlatformsByTitle(normTitle) : undefined,
      isSingleGogGame ? (game as any).worksOn : undefined,
    ];

    for (const cand of gogCandidates) {
      const extracted = extractExplicitOsFlags(cand);
      if (extracted) {
        return {
          windows: extracted.windows,
          mac: extracted.mac || isNativeMacApp,
          isExplicit: true,
        };
      }
    }

    return {
      windows: true,
      mac: isNativeMacApp,
      isExplicit: isNativeMacApp,
    };
  }

  if (platformId === 'epic') {
    const isSingleEpicWithOwnMeta =
      Array.isArray(game.platforms) &&
      game.platforms.length === 1 &&
      game.platforms[0]?.platformId === 'epic' &&
      game.enrichedMetadata?.appId === 0 &&
      Boolean(game.enrichedMetadata?.platforms);

    const epicCandidates: Array<RawOsFlags | undefined | null> = [
      platObj?.platforms,
      isSingleEpicWithOwnMeta ? game.enrichedMetadata?.platforms : undefined,
    ];

    for (const cand of epicCandidates) {
      const extracted = extractExplicitOsFlags(cand);
      if (extracted) {
        return {
          windows: extracted.windows,
          mac: extracted.mac || isNativeMacApp,
          isExplicit: true,
        };
      }
    }

    return {
      windows: true,
      mac: isNativeMacApp,
      isExplicit: false,
    };
  }

  // 'custom'
  const customExtracted = extractExplicitOsFlags(platObj?.platforms);
  if (customExtracted) {
    return {
      windows: customExtracted.windows,
      mac: customExtracted.mac || isNativeMacApp,
      isExplicit: true,
    };
  }

  return {
    windows: !isNativeMacApp,
    mac: isNativeMacApp,
    isExplicit: Boolean(platObj?.platforms),
  };
}

/**
 * Resolves the native OS platforms supported on a specific storefront (`platformId`).
 */
export function getStorefrontNativeOsPlatforms(
  game: CanonicalGame,
  platformId: StorefrontId
): NativeOsPlatform[] {
  if (!game) return ['windows'];
  const flags = getStorefrontNativeOsFlags(game, platformId);
  const result: NativeOsPlatform[] = [];
  if (flags.windows) result.push('windows');
  if (flags.mac) result.push('mac');
  return result.length > 0 ? result : ['windows'];
}

/**
 * Resolves the operating systems a game is natively available on.
 * Compatibility layers (CrossOver, Wine, GPTK) and Windows .exe binaries on macOS
 * NEVER count as native macOS availability.
 *
 * When `targetPlatformId` is provided, returns the native OS platforms strictly for that storefront.
 * When `targetPlatformId` is omitted, aggregates ONLY across the storefronts the user actually owns
 * in `game.platforms` (preventing unowned Steam/GOG metadata from bleeding into Epic-only or GOG-only games).
 */
export function getNativeOsPlatforms(
  game: CanonicalGame,
  targetPlatformId?: StorefrontId
): NativeOsPlatform[] {
  if (!game) return ['windows'];

  if (targetPlatformId) {
    return getStorefrontNativeOsPlatforms(game, targetPlatformId);
  }

  let hasNativeMacAppInstall = false;
  const ownedPlatforms = Array.isArray(game.platforms) ? game.platforms.filter(Boolean) : [];
  for (const p of ownedPlatforms) {
    const isCompatOrWinExe =
      p.isWindowsBinaryOnMac === true ||
      /crossover|bottles|drive_c|wine|gptk/i.test(p.installPath || '') ||
      /crossover|bottles|drive_c|wine|gptk/i.test(p.executablePath || '') ||
      /\.exe$/i.test(p.executablePath || '') ||
      /\.exe$/i.test(p.installPath || '');
    const isNativeMacApp =
      Boolean(p.installed) &&
      p.isWindowsBinaryOnMac !== true &&
      !isCompatOrWinExe &&
      (/\.app(\/|$)/i.test(p.installPath || '') || /\.app(\/|$)/i.test(p.executablePath || ''));
    if (isNativeMacApp) {
      hasNativeMacAppInstall = true;
    }
  }

  if (ownedPlatforms.length > 0) {
    let hasWindows = false;
    let hasMac = hasNativeMacAppInstall;
    let hasAnyExplicitStoreFlag = false;
    for (const p of ownedPlatforms) {
      const flags = getStorefrontNativeOsFlags(game, p.platformId);
      if (flags.isExplicit) hasAnyExplicitStoreFlag = true;
      if (flags.windows) hasWindows = true;
      if (flags.mac) hasMac = true;
    }

    const ownsSteam = ownedPlatforms.some((p) => p.platformId === 'steam');
    const hasCrossStoreSteamMetaBleed =
      !ownsSteam && Boolean(game.enrichedMetadata?.platforms && game.enrichedMetadata?.appId !== 0);

    if (
      !hasAnyExplicitStoreFlag &&
      !hasCrossStoreSteamMetaBleed &&
      Array.isArray(game.nativePlatforms) &&
      game.nativePlatforms.length > 0
    ) {
      const normalized = new Set<NativeOsPlatform>();
      for (const entry of game.nativePlatforms) {
        if (entry === 'windows' || entry === 'mac') {
          normalized.add(entry);
        }
      }
      if (hasNativeMacAppInstall) {
        normalized.add('mac');
      }
      if (normalized.size > 0) {
        const ordered: NativeOsPlatform[] = [];
        if (normalized.has('windows')) ordered.push('windows');
        if (normalized.has('mac')) ordered.push('mac');
        return ordered;
      }
    }

    const result: NativeOsPlatform[] = [];
    if (hasWindows) result.push('windows');
    if (hasMac) result.push('mac');
    return result.length > 0 ? result : ['windows'];
  }

  if (Array.isArray(game.nativePlatforms) && game.nativePlatforms.length > 0) {
    const normalized = new Set<NativeOsPlatform>();
    for (const entry of game.nativePlatforms) {
      if (entry === 'windows' || entry === 'mac') {
        normalized.add(entry);
      }
    }
    if (hasNativeMacAppInstall) {
      normalized.add('mac');
    }
    if (normalized.size > 0) {
      const ordered: NativeOsPlatform[] = [];
      if (normalized.has('windows')) ordered.push('windows');
      if (normalized.has('mac')) ordered.push('mac');
      return ordered;
    }
  }

  // Fallback for synthetic unit test objects with empty `game.platforms`
  const effectiveSteamId = getEffectiveSteamAppId(game);
  const normTitle = normalizeLookupTitle(game.title);

  const candidates: Array<RawOsFlags | undefined | null> = [
    game.enrichedMetadata?.platforms,
    (game as any).platforms_os,
    (game as any).worksOn,
  ];

  if (effectiveSteamId) {
    const liveSteamMeta = steamApi.getCachedMetadata(effectiveSteamId);
    if (liveSteamMeta?.platforms) {
      candidates.push(liveSteamMeta.platforms);
    }
    const staticSteamEntry = steamCache[String(effectiveSteamId)];
    if (staticSteamEntry?.platforms) {
      candidates.push(staticSteamEntry.platforms);
    }
  } else if (normTitle && !game.isExplicitNonSteam) {
    const matchedSteamFlags = getSteamPlatformsByTitle(normTitle);
    if (matchedSteamFlags) {
      candidates.push(matchedSteamFlags);
    }
  }

  if (normTitle) {
    const matchedGogFlags = getGogPlatformsByTitle(normTitle);
    if (matchedGogFlags) {
      candidates.push(matchedGogFlags);
    }
  }

  let resolvedFlags: { windows: boolean; mac: boolean } | null = null;
  for (const cand of candidates) {
    const extracted = extractExplicitOsFlags(cand);
    if (extracted) {
      if (!resolvedFlags) {
        resolvedFlags = { ...extracted };
      } else {
        resolvedFlags.windows = resolvedFlags.windows || extracted.windows;
        resolvedFlags.mac = resolvedFlags.mac || extracted.mac;
      }
    }
  }

  const hasWindows = resolvedFlags ? resolvedFlags.windows : true;
  const hasMac = (resolvedFlags ? resolvedFlags.mac : false) || hasNativeMacAppInstall;

  const result: NativeOsPlatform[] = [];
  if (hasWindows) result.push('windows');
  if (hasMac) result.push('mac');
  return result.length > 0 ? result : ['windows'];
}

export function isNativelyAvailableOnMac(
  game: CanonicalGame,
  targetPlatformId?: StorefrontId
): boolean {
  return getNativeOsPlatforms(game, targetPlatformId).includes('mac');
}

export function isNativelyAvailableOnWindows(
  game: CanonicalGame,
  targetPlatformId?: StorefrontId
): boolean {
  return getNativeOsPlatforms(game, targetPlatformId).includes('windows');
}

export function matchesNativeOsQuery(game: CanonicalGame, rawQuery: string): boolean {
  if (!rawQuery) return false;
  const q = rawQuery.trim().toLowerCase();
  if (
    q === 'macos' ||
    q === 'mac os' ||
    q === 'native mac' ||
    q === 'native macos' ||
    q === 'os:mac' ||
    q === 'os:macos' ||
    q === 'platform:mac' ||
    q === 'platform:macos'
  ) {
    return isNativelyAvailableOnMac(game);
  }
  if (
    q === 'windows' ||
    q === 'native windows' ||
    q === 'os:windows' ||
    q === 'os:win' ||
    q === 'platform:windows'
  ) {
    return isNativelyAvailableOnWindows(game);
  }
  return false;
}
