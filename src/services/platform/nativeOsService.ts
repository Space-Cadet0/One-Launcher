import { CanonicalGame, NativeOsPlatform } from '../../contracts/game';
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
 * Resolves the operating systems a game is natively available on.
 * Compatibility layers (CrossOver, Wine, GPTK) and Windows .exe binaries on macOS
 * NEVER count as native macOS availability.
 */
export function getNativeOsPlatforms(game: CanonicalGame): NativeOsPlatform[] {
  if (!game) return ['windows'];

  let hasNativeMacAppInstall = false;
  for (const p of game.platforms || []) {
    if (!p) continue;
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

  const effectiveSteamId = getEffectiveSteamAppId(game);
  const gogPlatform = (game.platforms || []).find((p) => p.platformId === 'gog');
  const gogId = gogPlatform?.platformGameId ? String(gogPlatform.platformGameId).replace(/^gog-/, '') : undefined;
  const normTitle = normalizeLookupTitle(game.title);

  const candidates: Array<RawOsFlags | undefined | null> = [
    game.enrichedMetadata?.platforms,
    ...(game.platforms || []).map((p) => p.platforms),
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

  if (gogId && gogCache[gogId]) {
    candidates.push(gogCache[gogId]?.platforms || gogCache[gogId]?.worksOn);
  } else if (normTitle) {
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

export function isNativelyAvailableOnMac(game: CanonicalGame): boolean {
  return getNativeOsPlatforms(game).includes('mac');
}

export function isNativelyAvailableOnWindows(game: CanonicalGame): boolean {
  return getNativeOsPlatforms(game).includes('windows');
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
