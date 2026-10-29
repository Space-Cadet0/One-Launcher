import { StorefrontId } from '../../contracts/platform';
import { StorefrontIntegration, StorefrontCredentials } from '../../contracts/integration';
import {
  CanonicalGame,
  GamePlatformOwnership,
  XboxGamePassSyncMode,
  XboxOwnershipType,
  XboxSubscriptionSummary,
} from '../../contracts/game';
import type { InstalledGameRecord } from '../../contracts/launcher';
import { FULL_USER_STEAM_GAMES } from '../storage/fullUserSteamGames';
import { steamIntegration } from './steamIntegration';
import { gogIntegration, normalizeGogAvatarUrl } from './gogIntegration';
import { epicIntegration } from './epicIntegration';
import { xboxIntegration } from './xboxIntegration';
import {
  mergeScannedSteamGames,
  pickBestEnrichedMetadata,
  pickPreferredCapsuleImage,
  pickPreferredDetailedDescription,
  pickPreferredHeaderImage,
  pickPreferredReleaseDate,
} from '../storage/librarySync';
import { truncateHtmlSafely } from '../steam/steamApi';
import { GOG_USER_LIBRARY, EPIC_USER_LIBRARY } from '../storage/storefrontLibraries';
import {
  sanitizeGameCatalog,
  normalizeCanonicalTitle,
  hasSameStorefrontConflict,
  hasSplitOverrideConflict,
} from './catalogSanitizer';
import { stripStorefrontPlatformDisambiguators } from '../common/titleUtils';
import { reconcileAchievementSummaries } from '../storage/achievementReconciliation';
import { cacheUserXboxAchievements } from '../storage/knownGameAchievements';
import { isUnsuitableHeaderUrl } from '../igdb/igdbCoverService';
import {
  loadUserOverrides,
  getUserOverrideForGame,
  applyUserOverrideToGame,
  applyUserOverridesToCatalog,
} from '../storage/userOverrideStorage';
import { clearExpiredStagedCache } from '../storage/stagedCacheService';
import { vaultDelete, vaultGet, vaultSet } from '../storage/indexedDbVault';
import { isUserActivelyScrolling } from '../../utils/scrollActivityTracker';
import { isModalOverlayOpen } from '../../utils/modalOverlayLock';
import { sanitizeGameInstallSizeBytes } from '../../utils/formatBytes';

const IDB_KEY_MAIN_CATALOG = 'idb_universal_game_library_catalog_v2';

const STORAGE_KEY_INTEGRATIONS = 'antigravity_storefront_integrations';
const STORAGE_KEY_CUSTOM_GAMES = 'antigravity_synced_user_games';
const STORAGE_KEY_MAIN_CATALOG = 'universal_game_library_catalog';
export const STORAGE_KEY_VERIFIED_ENTITLEMENTS = 'antigravity_verified_storefront_entitlements_v1';
export const STORAGE_KEY_XBOX_PROFILE = 'antigravity_xbox_profile_v1';

export interface XboxCachedProfileState {
  connected: boolean;
  gamertag?: string;
  modernGamertag?: string;
  xuid?: string;
  avatarUrl?: string;
  gamerscore?: number;
  subscription?: XboxSubscriptionSummary | null;
  syncMode?: XboxGamePassSyncMode;
  hasDeviceContext?: boolean;
  lastSyncedAt?: string;
}

export interface VerifiedUserEntitlements {
  steam: number[];
  gog: string[];
  epic: string[];
  xbox: string[];
}

function getSafeStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // Ignore storage access errors
  }
  return null;
}

export function loadXboxProfileState(): XboxCachedProfileState | null {
  const storage = getSafeStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY_XBOX_PROFILE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      connected: Boolean(parsed.connected),
      gamertag: typeof parsed.gamertag === 'string' ? parsed.gamertag : undefined,
      modernGamertag: typeof parsed.modernGamertag === 'string' ? parsed.modernGamertag : undefined,
      xuid: typeof parsed.xuid === 'string' ? parsed.xuid : undefined,
      avatarUrl: typeof parsed.avatarUrl === 'string' ? parsed.avatarUrl : undefined,
      gamerscore: typeof parsed.gamerscore === 'number' ? parsed.gamerscore : undefined,
      subscription:
        parsed.subscription && typeof parsed.subscription === 'object'
          ? (parsed.subscription as XboxSubscriptionSummary)
          : null,
      syncMode:
        parsed.syncMode === 'owned_and_played' ||
        parsed.syncMode === 'full_pc_game_pass' ||
        parsed.syncMode === 'owned_only'
          ? parsed.syncMode
          : undefined,
      hasDeviceContext:
        typeof parsed.hasDeviceContext === 'boolean' ? parsed.hasDeviceContext : undefined,
      lastSyncedAt: typeof parsed.lastSyncedAt === 'string' ? parsed.lastSyncedAt : undefined,
    };
  } catch {
    return null;
  }
}

export function saveXboxProfileState(state: XboxCachedProfileState): void {
  const storage = getSafeStorage();
  if (!storage) return;
  try {
    // Strictly persist non-secret display & subscription state; never persist tokens
    const safeState: XboxCachedProfileState = {
      connected: Boolean(state.connected),
      ...(state.gamertag ? { gamertag: state.gamertag } : {}),
      ...(state.modernGamertag ? { modernGamertag: state.modernGamertag } : {}),
      ...(state.xuid ? { xuid: state.xuid } : {}),
      ...(state.avatarUrl ? { avatarUrl: state.avatarUrl } : {}),
      ...(typeof state.gamerscore === 'number' ? { gamerscore: state.gamerscore } : {}),
      subscription: state.subscription ?? null,
      ...(state.syncMode ? { syncMode: state.syncMode } : {}),
      ...(typeof state.hasDeviceContext === 'boolean'
        ? { hasDeviceContext: state.hasDeviceContext }
        : {}),
      ...(state.lastSyncedAt ? { lastSyncedAt: state.lastSyncedAt } : {}),
    };
    storage.setItem(STORAGE_KEY_XBOX_PROFILE, JSON.stringify(safeState));
  } catch (err) {
    console.warn('Failed to save Xbox profile state:', err);
  }
}

export function clearXboxProfileState(): void {
  const storage = getSafeStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY_XBOX_PROFILE);
  } catch {
    // Ignore storage removal errors
  }
}

export function getVerifiedUserEntitlements(): VerifiedUserEntitlements {
  const empty: VerifiedUserEntitlements = { steam: [], gog: [], epic: [], xbox: [] };
  const storage = getSafeStorage();
  if (!storage) return empty;
  try {
    const raw = storage.getItem(STORAGE_KEY_VERIFIED_ENTITLEMENTS);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    return {
      steam: Array.isArray(parsed?.steam)
        ? parsed.steam.filter((n: unknown): n is number => typeof n === 'number' && n > 0)
        : [],
      gog: Array.isArray(parsed?.gog)
        ? parsed.gog.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
        : [],
      epic: Array.isArray(parsed?.epic)
        ? parsed.epic.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
        : [],
      xbox: Array.isArray(parsed?.xbox)
        ? parsed.xbox.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
        : [],
    };
  } catch {
    return empty;
  }
}

export function recordVerifiedUserEntitlements(
  storefrontId: StorefrontId,
  games: CanonicalGame[]
): void {
  const storage = getSafeStorage();
  if (!storage || !Array.isArray(games) || games.length === 0) return;
  try {
    const current = getVerifiedUserEntitlements();
    if (storefrontId === 'steam') {
      const set = new Set<number>(current.steam);
      for (const g of games) {
        if (!g || g.isVerifiedEntitlement === false) continue;
        const steamPlat = g.platforms?.find((p) => p.platformId === 'steam');
        const appId =
          g.steamAppId ||
          (steamPlat?.platformGameId && !isNaN(Number(steamPlat.platformGameId))
            ? Number(steamPlat.platformGameId)
            : undefined);
        if (appId && appId > 0) set.add(appId);
      }
      current.steam = Array.from(set);
    } else if (storefrontId === 'gog' || storefrontId === 'epic' || storefrontId === 'xbox') {
      const set = new Set<string>(current[storefrontId]);
      for (const g of games) {
        if (!g || g.isVerifiedEntitlement === false) continue;
        const plat = g.platforms?.find((p) => p.platformId === storefrontId);
        if (plat?.platformGameId) {
          set.add(plat.platformGameId.trim().toLowerCase());
        }
        if (storefrontId === 'xbox' && plat) {
          if (plat.xboxProductId) set.add(plat.xboxProductId.trim().toLowerCase());
          if (plat.xboxTitleId) set.add(plat.xboxTitleId.trim().toLowerCase());
          if (plat.packageFamilyName) set.add(plat.packageFamilyName.trim().toLowerCase());
        }
        if (g.title) {
          const norm = normalizeCanonicalTitle(g.title);
          if (norm) set.add(norm);
        }
      }
      current[storefrontId] = Array.from(set);
    }
    storage.setItem(STORAGE_KEY_VERIFIED_ENTITLEMENTS, JSON.stringify(current));
  } catch (err) {
    console.warn('Failed to record verified storefront entitlements:', err);
  }
}

export function clearVerifiedUserEntitlements(storefrontId?: StorefrontId): void {
  const storage = getSafeStorage();
  if (!storage) return;
  try {
    if (!storefrontId) {
      storage.removeItem(STORAGE_KEY_VERIFIED_ENTITLEMENTS);
      return;
    }
    const current = getVerifiedUserEntitlements();
    if (storefrontId === 'steam') current.steam = [];
    else if (storefrontId === 'gog') current.gog = [];
    else if (storefrontId === 'epic') current.epic = [];
    else if (storefrontId === 'xbox') current.xbox = [];
    storage.setItem(STORAGE_KEY_VERIFIED_ENTITLEMENTS, JSON.stringify(current));
  } catch (err) {
    console.warn('Failed to clear verified storefront entitlements:', err);
  }
}

export const DEFAULT_INTEGRATIONS: StorefrontIntegration[] = [
  {
    storefrontId: 'steam',
    name: 'Steam',
    isConnected: false,
    gamesCount: 0,
    statusMessage: 'Not connected — Sign in with Steam or enter SteamID64',
  },
  {
    storefrontId: 'gog',
    name: 'GOG.com',
    isConnected: false,
    gamesCount: 0,
    statusMessage: 'Not connected — Sign in with GOG.com account',
  },
  {
    storefrontId: 'epic',
    name: 'Epic Games Store',
    isConnected: false,
    gamesCount: 0,
    statusMessage: 'Not connected — Sign in with Epic Games account',
  },
  {
    storefrontId: 'xbox',
    name: 'Xbox',
    isConnected: false,
    gamesCount: 0,
    statusMessage: 'Not connected — Ready to connect via Xbox Live account',
  },
];

const sessionApiKeysByStore = new Map<StorefrontId, string>();

const SENSITIVE_CREDENTIAL_FIELDS = [
  'access_token',
  'refresh_token',
  'accessToken',
  'refreshToken',
  'xstsToken',
  'userHash',
  'apiKey',
  'steamApiKey',
  'clientSecret',
  'client_secret',
  'idToken',
  'id_token',
  'exchangeCode',
  'gogToken',
  'epicToken',
  'epicRefreshToken',
  'webToken',
] as const;

export function loadIntegrations(): StorefrontIntegration[] {
  if (typeof window === 'undefined') return DEFAULT_INTEGRATIONS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_INTEGRATIONS);
    if (!raw) {
      sessionApiKeysByStore.clear();
      saveIntegrations(DEFAULT_INTEGRATIONS);
      return DEFAULT_INTEGRATIONS;
    }
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      let changed = false;
      const normalized = (parsed as StorefrontIntegration[]).map((i: StorefrontIntegration) => {
        if (!i) return i;
        let next = i;
        if (next.storefrontId === 'gog' && next.avatarUrl) {
          const normUrl = normalizeGogAvatarUrl(next.avatarUrl);
          if (normUrl && normUrl !== next.avatarUrl) {
            changed = true;
            next = { ...next, avatarUrl: normUrl };
          }
        }
        const sessionKey = sessionApiKeysByStore.get(next.storefrontId);
        if (sessionKey && next.isConnected && !next.credentials?.apiKey) {
          next = {
            ...next,
            credentials: {
              ...(next.credentials || {}),
              apiKey: sessionKey,
            },
          };
        }
        return next;
      });
      if (changed) {
        saveIntegrations(normalized);
      }
      return normalized;
    }
    return DEFAULT_INTEGRATIONS;
  } catch (err) {
    console.warn('Failed to load storefront integrations from localStorage:', err);
    return DEFAULT_INTEGRATIONS;
  }
}

export function saveIntegrations(integrations: StorefrontIntegration[]): void {
  if (typeof window === 'undefined') return;
  try {
    const sanitized = integrations.map((integ) => {
      if (!integ) return integ;
      if (integ.isConnected && typeof integ.credentials?.apiKey === 'string' && integ.credentials.apiKey.trim()) {
        sessionApiKeysByStore.set(integ.storefrontId, integ.credentials.apiKey.trim());
      } else if (!integ.isConnected) {
        sessionApiKeysByStore.delete(integ.storefrontId);
      }

      const copy: Record<string, unknown> = { ...integ };
      for (const secretField of SENSITIVE_CREDENTIAL_FIELDS) {
        delete copy[secretField];
      }
      if (copy.credentials && typeof copy.credentials === 'object') {
        const creds: Record<string, unknown> = {
          ...(copy.credentials as Record<string, unknown>),
        };
        for (const secretField of SENSITIVE_CREDENTIAL_FIELDS) {
          delete creds[secretField];
        }
        copy.credentials = creds as StorefrontCredentials;
      }
      return copy as unknown as StorefrontIntegration;
    });
    localStorage.setItem(STORAGE_KEY_INTEGRATIONS, JSON.stringify(sanitized));
  } catch (err) {
    console.error('Failed to save storefront integrations to localStorage', err);
  }
}

export interface SaveCatalogOptions {
  immediate?: boolean;
  skipSanitize?: boolean;
  dirtyGameIds?: ReadonlySet<string> | readonly string[];
  dirtyGames?: readonly CanonicalGame[];
}

const MAX_MODAL_INCREMENTAL_DEFER_MS = 10_000;

let inMemoryCatalogCache: CanonicalGame[] | null = null;
let inMemoryCatalogRawRef: string | null = null;
let pendingCatalogSaveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingCatalogGames: CanonicalGame[] | null = null;
let pendingCatalogNeedsSanitize = false;
let pendingCatalogNeedsOverrides = false;
let pendingIsFullCatalogSync = false;
const pendingDirtyGameIds = new Set<string>();
let pendingModalDeferStartedAt: number | null = null;

function collectDirtyGameIdsFromOptions(options?: SaveCatalogOptions): string[] | null {
  if (!options || (options.dirtyGameIds === undefined && options.dirtyGames === undefined)) {
    return null;
  }
  const ids: string[] = [];
  if (options.dirtyGameIds) {
    for (const id of options.dirtyGameIds) {
      if (typeof id === 'string' && id) ids.push(id);
    }
  }
  if (Array.isArray(options.dirtyGames)) {
    for (const g of options.dirtyGames) {
      if (g?.id) ids.push(g.id);
    }
  }
  return ids;
}

function isTestEnv(): boolean {
  try {
    if (typeof process === 'undefined' || !process.env) return false;
    return Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
  } catch {
    return false;
  }
}

function evictExpendableCachesForCatalogQuota(): void {
  try {
    clearExpiredStagedCache();
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (
        key &&
        (key.startsWith('antigravity_detailed_achievements_') ||
          key.startsWith('antigravity_achievement_details_'))
      ) {
        keysToRemove.push(key);
      }
    }
    for (const k of keysToRemove) {
      localStorage.removeItem(k);
    }
  } catch {
    // Ignore storage cleanup errors
  }
}

const MAX_STORED_SCREENSHOTS = 12;
const MAX_STORED_MOVIES = 4;
const MAX_STORED_HTML_DESCRIPTION_CHARS = 35000;
const MAX_STORED_PLAIN_DESCRIPTION_CHARS = 12000;

function getMaxStoredDescriptionChars(text: string): number {
  return /<[a-z!\/][^>]*>/i.test(text)
    ? MAX_STORED_HTML_DESCRIPTION_CHARS
    : MAX_STORED_PLAIN_DESCRIPTION_CHARS;
}

function fnv1aDualHashUpdate(state: [number, number], str: string): void {
  let h1 = state[0];
  let h2 = state[1];
  const len = str.length;
  // Length-prefix every token to eliminate boundary/concatenation collisions
  h1 = Math.imul(h1 ^ len, 0x01000193) >>> 0;
  h2 = Math.imul(h2 ^ ((len << 1) | 1), 0x01000193) >>> 0;
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ (code & 0xff), 0x01000193) >>> 0;
    h1 = Math.imul(h1 ^ (code >>> 8), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((code >>> 8) & 0xff), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (code & 0xff), 0x01000193) >>> 0;
  }
  state[0] = h1;
  state[1] = h2;
}

export function computeCatalogFingerprint(raw: string): string {
  const state: [number, number] = [0x811c9dc5, 0x9e3779b9];
  fnv1aDualHashUpdate(state, raw);
  return `${raw.length}:${state[0].toString(16).padStart(8, '0')}${state[1].toString(16).padStart(8, '0')}`;
}

export function computeCatalogGamesFingerprint(games: CanonicalGame[]): string {
  const state: [number, number] = [0x811c9dc5, 0x9e3779b9];
  fnv1aDualHashUpdate(state, String(games.length));
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    if (!g) continue;
    fnv1aDualHashUpdate(state, g.id || '');
    fnv1aDualHashUpdate(state, g.title || '');
    fnv1aDualHashUpdate(state, String(g.steamAppId ?? ''));
    fnv1aDualHashUpdate(state, String(g.reviewSummary?.positivePercent ?? ''));
    fnv1aDualHashUpdate(state, String(g.reviewScoreOverride?.score ?? ''));
    fnv1aDualHashUpdate(state, g.reviewScoreOverride?.source || '');
    fnv1aDualHashUpdate(state, g.headerImage || '');
    fnv1aDualHashUpdate(state, g.capsuleImage || '');
    fnv1aDualHashUpdate(state, g.shortDescription || '');
    fnv1aDualHashUpdate(state, g.releaseDate || '');
    fnv1aDualHashUpdate(state, String(Boolean(g.needsMatchReview)));
    if (Array.isArray(g.genres)) {
      fnv1aDualHashUpdate(state, g.genres.join('\u001f'));
    }
    if (Array.isArray(g.tags)) {
      fnv1aDualHashUpdate(state, g.tags.join('\u001f'));
    }
    if (g.enrichedMetadata) {
      fnv1aDualHashUpdate(state, String(g.enrichedMetadata.metacritic?.score ?? ''));
      fnv1aDualHashUpdate(state, String(g.enrichedMetadata.reviewSummary?.positivePercent ?? ''));
      fnv1aDualHashUpdate(state, String(g.enrichedMetadata.screenshots?.length ?? 0));
      fnv1aDualHashUpdate(state, String(g.enrichedMetadata.detailedDescription?.length ?? 0));
    }
    if (Array.isArray(g.platforms)) {
      fnv1aDualHashUpdate(state, String(g.platforms.length));
      for (let j = 0; j < g.platforms.length; j++) {
        const p = g.platforms[j];
        fnv1aDualHashUpdate(state, p.platformId || '');
        fnv1aDualHashUpdate(state, String(p.platformGameId || ''));
        fnv1aDualHashUpdate(state, String(Boolean(p.installed)));
        fnv1aDualHashUpdate(state, String(p.playtimeMinutes ?? ''));
        fnv1aDualHashUpdate(state, String(p.lastPlayed ?? ''));
        fnv1aDualHashUpdate(state, String(p.achievements?.unlocked ?? ''));
        fnv1aDualHashUpdate(state, String(p.achievements?.total ?? ''));
        fnv1aDualHashUpdate(state, String(p.achievements?.gamerscore?.earned ?? ''));
        fnv1aDualHashUpdate(state, String(p.ownershipType ?? ''));
        fnv1aDualHashUpdate(state, String(p.gamePassTier ?? ''));
        fnv1aDualHashUpdate(state, String(Boolean(p.subscriptionExpired)));
        fnv1aDualHashUpdate(state, String(Boolean(p.isLeavingSoon)));
        fnv1aDualHashUpdate(state, String(Boolean(p.isRecentlyAddedToGamePass)));
      }
    }
  }
  return `g${games.length}:${state[0].toString(16).padStart(8, '0')}${state[1].toString(16).padStart(8, '0')}`;
}

function slimGameForLocalStorageQuota(game: CanonicalGame): CanonicalGame {
  if (!game || typeof game !== 'object') return game;
  const slim: Record<string, unknown> = { ...game };
  delete slim.detailedDescription;
  delete slim.aboutTheGame;
  delete slim.screenshots;
  delete slim.movies;
  if (game.enrichedMetadata && typeof game.enrichedMetadata === 'object') {
    const slimMeta: Record<string, unknown> = { ...game.enrichedMetadata };
    delete slimMeta.detailedDescription;
    delete slimMeta.aboutTheGame;
    delete slimMeta.screenshots;
    delete slimMeta.movies;
    delete slimMeta.pcRequirements;
    delete slimMeta.macRequirements;
    delete slimMeta.linuxRequirements;
    slim.enrichedMetadata = slimMeta;
  }
  return slim as unknown as CanonicalGame;
}

const compactedGameWeakMemo = new WeakMap<CanonicalGame, CanonicalGame>();

export function compactGameForStorage(game: CanonicalGame): CanonicalGame {
  if (!game || typeof game !== 'object') return game;
  const memoized = compactedGameWeakMemo.get(game);
  if (memoized !== undefined) return memoized;

  let nextGame = game;
  if (typeof nextGame.detailedDescription === 'string') {
    const topDetailedMax = getMaxStoredDescriptionChars(nextGame.detailedDescription);
    if (nextGame.detailedDescription.length > topDetailedMax) {
      nextGame = {
        ...nextGame,
        detailedDescription: truncateHtmlSafely(nextGame.detailedDescription, topDetailedMax),
      };
    }
  }

  type LegacyTopLevelMediaGame = CanonicalGame & {
    aboutTheGame?: string;
    screenshots?: unknown[];
    movies?: unknown[];
  };

  const legacyTop = nextGame as LegacyTopLevelMediaGame;
  const rawTopAbout = legacyTop.aboutTheGame;
  if (typeof rawTopAbout === 'string') {
    const topAboutMax = getMaxStoredDescriptionChars(rawTopAbout);
    const trimmedTopAbout =
      rawTopAbout.length > topAboutMax
        ? truncateHtmlSafely(rawTopAbout, topAboutMax)
        : rawTopAbout;
    const finalTopAbout =
      nextGame.detailedDescription && trimmedTopAbout === nextGame.detailedDescription
        ? ''
        : trimmedTopAbout;
    if (finalTopAbout !== rawTopAbout) {
      const updatedTop: LegacyTopLevelMediaGame = {
        ...nextGame,
        aboutTheGame: finalTopAbout,
      };
      nextGame = updatedTop;
    }
  }

  const rawTopScreenshots = (nextGame as LegacyTopLevelMediaGame).screenshots;
  if (Array.isArray(rawTopScreenshots) && rawTopScreenshots.length > MAX_STORED_SCREENSHOTS) {
    const updatedTop: LegacyTopLevelMediaGame = {
      ...nextGame,
      screenshots: rawTopScreenshots.slice(0, MAX_STORED_SCREENSHOTS),
    };
    nextGame = updatedTop;
  }

  const rawTopMovies = (nextGame as LegacyTopLevelMediaGame).movies;
  if (Array.isArray(rawTopMovies) && rawTopMovies.length > MAX_STORED_MOVIES) {
    const updatedTop: LegacyTopLevelMediaGame = {
      ...nextGame,
      movies: rawTopMovies.slice(0, MAX_STORED_MOVIES),
    };
    nextGame = updatedTop;
  }

  const meta = nextGame.enrichedMetadata;
  if (!meta || typeof meta !== 'object') {
    compactedGameWeakMemo.set(game, nextGame);
    compactedGameWeakMemo.set(nextGame, nextGame);
    return nextGame;
  }

  const screenshotsNeedTrim =
    Array.isArray(meta.screenshots) && meta.screenshots.length > MAX_STORED_SCREENSHOTS;
  const moviesNeedTrim = Array.isArray(meta.movies) && meta.movies.length > MAX_STORED_MOVIES;
  const metaDetailedMax =
    typeof meta.detailedDescription === 'string'
      ? getMaxStoredDescriptionChars(meta.detailedDescription)
      : MAX_STORED_PLAIN_DESCRIPTION_CHARS;
  const metaAboutMax =
    typeof meta.aboutTheGame === 'string'
      ? getMaxStoredDescriptionChars(meta.aboutTheGame)
      : MAX_STORED_PLAIN_DESCRIPTION_CHARS;
  const detailedDescNeedsTrim =
    typeof meta.detailedDescription === 'string' &&
    meta.detailedDescription.length > metaDetailedMax;
  const aboutNeedsTrim =
    typeof meta.aboutTheGame === 'string' &&
    meta.aboutTheGame.length > metaAboutMax;

  const trimmedDetailed = detailedDescNeedsTrim
    ? truncateHtmlSafely(meta.detailedDescription!, metaDetailedMax)
    : meta.detailedDescription;
  const trimmedAbout = aboutNeedsTrim
    ? truncateHtmlSafely(meta.aboutTheGame!, metaAboutMax)
    : meta.aboutTheGame;
  const hasDuplicateAbout =
    Boolean(trimmedDetailed && trimmedAbout && trimmedAbout === trimmedDetailed);

  if (
    !screenshotsNeedTrim &&
    !moviesNeedTrim &&
    !detailedDescNeedsTrim &&
    !aboutNeedsTrim &&
    !hasDuplicateAbout
  ) {
    compactedGameWeakMemo.set(game, nextGame);
    compactedGameWeakMemo.set(nextGame, nextGame);
    return nextGame;
  }

  const nextMeta = {
    ...meta,
    screenshots: screenshotsNeedTrim
      ? meta.screenshots.slice(0, MAX_STORED_SCREENSHOTS)
      : meta.screenshots,
    movies: moviesNeedTrim ? meta.movies.slice(0, MAX_STORED_MOVIES) : meta.movies,
    detailedDescription: trimmedDetailed,
    aboutTheGame: hasDuplicateAbout ? '' : (trimmedAbout ?? ''),
  };

  const finalCompacted: CanonicalGame = {
    ...nextGame,
    enrichedMetadata: nextMeta,
  };
  compactedGameWeakMemo.set(game, finalCompacted);
  compactedGameWeakMemo.set(finalCompacted, finalCompacted);
  return finalCompacted;
}

function writeCatalogToLocalStorage(
  cleaned: CanonicalGame[],
  dirtyIds?: ReadonlySet<string> | null
): void {
  const compacted = cleaned.map(compactGameForStorage);
  inMemoryCatalogCache = compacted;

  // Primary rich persistence in IndexedDB vault (non-blocking, GB-scale quota)
  void vaultSet(IDB_KEY_MAIN_CATALOG, compacted);

  // Mirror catalog snapshot to Electron SQLite offlineVault when available (non-blocking).
  // For incremental updates where dirtyIds is known and smaller than the catalog, send ONLY
  // the compacted dirty slice across IPC instead of structured-cloning all unchanged games!
  if (typeof window !== 'undefined' && window.electronAPI?.offlineVault?.upsertGames) {
    try {
      const ipcPayload =
        dirtyIds !== null && dirtyIds !== undefined
          ? dirtyIds.size === 0
            ? []
            : dirtyIds.size < compacted.length
              ? compacted.filter((g) => Boolean(g && dirtyIds.has(g.id)))
              : compacted
          : compacted;
      if (ipcPayload.length > 0) {
        void window.electronAPI.offlineVault.upsertGames(ipcPayload)?.catch?.(() => {});
      }
    } catch {}
  }

  const storage = getSafeStorage();
  if (!storage) {
    inMemoryCatalogRawRef = computeCatalogGamesFingerprint(compacted);
    return;
  }

  let persistedRaw: string | null = null;
  try {
    const serialized = JSON.stringify(compacted);
    try {
      storage.setItem(STORAGE_KEY_MAIN_CATALOG, serialized);
      persistedRaw = serialized;
    } catch {
      evictExpendableCachesForCatalogQuota();
      try {
        storage.setItem(STORAGE_KEY_MAIN_CATALOG, serialized);
        persistedRaw = serialized;
      } catch {
        // Fallback 1: slim heavy HTML/media fields for localStorage while keeping full rich objects in IndexedDB & memory
        const slimSerialized = JSON.stringify(compacted.map(slimGameForLocalStorageQuota));
        try {
          storage.setItem(STORAGE_KEY_MAIN_CATALOG, slimSerialized);
          persistedRaw = slimSerialized;
        } catch {
          // Fallback 2: ultra-large catalog (>10,000 games) — store compact vault pointer sentinel
          const sentinel = JSON.stringify({
            __idbVaultOnly: true,
            count: compacted.length,
            fp: computeCatalogGamesFingerprint(compacted),
          });
          try {
            storage.setItem(STORAGE_KEY_MAIN_CATALOG, sentinel);
            persistedRaw = sentinel;
          } catch {
            // Ignore final localStorage failure; IndexedDB vault & inMemoryCatalogCache remain authoritative
          }
        }
      }
    }
  } catch {
    // Ignore serialization fallback errors
  }

  inMemoryCatalogRawRef =
    persistedRaw !== null
      ? computeCatalogFingerprint(persistedRaw)
      : computeCatalogGamesFingerprint(compacted);

  // Save only custom games delta to STORAGE_KEY_CUSTOM_GAMES, NOT the duplicate copy of all master games
  const customGames = compacted.filter(
    (g) =>
      g.platforms?.some((p) => p.platformId === 'custom') ||
      !g.platforms?.some((p) => ['steam', 'gog', 'epic', 'xbox'].includes(p.platformId))
  );
  if (customGames.length > 0) {
    try {
      storage.setItem(STORAGE_KEY_CUSTOM_GAMES, JSON.stringify(customGames));
    } catch {}
  } else {
    try {
      storage.removeItem(STORAGE_KEY_CUSTOM_GAMES);
    } catch {}
  }
}

/**
 * Asynchronously hydrates the full rich catalog from IndexedDB on startup,
 * seamlessly upgrading any quota-slimmed localStorage snapshot or migrating
 * legacy localStorage catalogs into IndexedDB on first run.
 */
export async function hydrateCatalogFromIndexedDb(): Promise<CanonicalGame[] | null> {
  if (typeof window === 'undefined') return null;
  let vaultCatalog = await vaultGet<CanonicalGame[]>(IDB_KEY_MAIN_CATALOG);

  if (
    (!Array.isArray(vaultCatalog) || vaultCatalog.length === 0) &&
    window.electronAPI?.offlineVault?.getCatalogSnapshot
  ) {
    try {
      const snap = await window.electronAPI.offlineVault.getCatalogSnapshot();
      if (snap?.success && Array.isArray(snap.games) && snap.games.length > 0) {
        const details = snap.details || {};
        vaultCatalog = snap.games.map((g) => {
          const detailMeta = g?.id ? details[g.id]?.enrichedMetadata ?? undefined : undefined;
          const mergedMeta = pickBestEnrichedMetadata(g.enrichedMetadata, detailMeta);
          return mergedMeta !== g.enrichedMetadata
            ? { ...g, enrichedMetadata: mergedMeta }
            : g;
        });
        void vaultSet(IDB_KEY_MAIN_CATALOG, vaultCatalog);
      }
    } catch {}
  }

  const userOverrides = loadUserOverrides();

  if (Array.isArray(vaultCatalog) && vaultCatalog.length > 0) {
    const hadUnstrippedXboxTitles = vaultCatalog.some(
      (g) =>
        g?.platforms?.some((p) => p?.platformId === 'xbox') &&
        typeof g?.title === 'string' &&
        stripStorefrontPlatformDisambiguators(g.title) !== g.title
    );
    const sanitizedVault = preserveLocalInstallFieldsAcrossSanitize(
      vaultCatalog,
      sanitizeGameCatalog(vaultCatalog, { allowNewPurchases: true })
    );
    const cleaned = applyUserOverridesToCatalog(sanitizedVault, userOverrides);
    if (cleaned.length > 0 || !inMemoryCatalogCache || inMemoryCatalogCache.length === 0) {
      const mergedCache =
        inMemoryCatalogCache && inMemoryCatalogCache.length > 0
          ? mergeHydratedCatalogPreservingLiveState(inMemoryCatalogCache, cleaned)
          : cleaned;
      inMemoryCatalogCache = mergedCache;
      if (hadUnstrippedXboxTitles || cleaned.length !== vaultCatalog.length) {
        void vaultSet(IDB_KEY_MAIN_CATALOG, mergedCache);
      }
      return mergedCache;
    }
  } else if (inMemoryCatalogCache && inMemoryCatalogCache.length > 0) {
    // One-time automatic migration from localStorage into IndexedDB & SQLite offlineVault
    void vaultSet(IDB_KEY_MAIN_CATALOG, inMemoryCatalogCache);
    if (window.electronAPI?.offlineVault?.upsertGames) {
      try {
        void window.electronAPI.offlineVault.upsertGames(inMemoryCatalogCache)?.catch?.(() => {});
      } catch {}
    }
  }
  return null;
}

export const loadNormalizedCatalogAsync = hydrateCatalogFromIndexedDb;

export function flushPendingCatalogSave(): void {
  if (pendingCatalogSaveTimer) {
    clearTimeout(pendingCatalogSaveTimer);
    pendingCatalogSaveTimer = null;
  }
  if (pendingCatalogGames !== null && typeof window !== 'undefined') {
    try {
      let toWrite = pendingCatalogGames;
      const dirtySnapshot: ReadonlySet<string> | null =
        !pendingIsFullCatalogSync && pendingDirtyGameIds.size > 0
          ? new Set<string>(pendingDirtyGameIds)
          : !pendingIsFullCatalogSync && pendingModalDeferStartedAt !== null
            ? new Set<string>()
            : null;
      if (pendingCatalogNeedsOverrides) {
        const userOverrides = loadUserOverrides();
        toWrite = applyUserOverridesToCatalog(toWrite, userOverrides);
      }
      if (pendingCatalogNeedsSanitize) {
        toWrite = preserveLocalInstallFieldsAcrossSanitize(
          toWrite,
          sanitizeGameCatalog(toWrite)
        );
      }
      pendingCatalogGames = null;
      pendingCatalogNeedsSanitize = false;
      pendingCatalogNeedsOverrides = false;
      pendingIsFullCatalogSync = false;
      pendingDirtyGameIds.clear();
      pendingModalDeferStartedAt = null;
      inMemoryCatalogCache = toWrite;
      writeCatalogToLocalStorage(toWrite, dirtySnapshot);
    } catch (err) {
      console.error('[IntegrationStorage] Failed to flush pending catalog save:', err);
    }
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', () => {
    flushPendingCatalogSave();
  });
  window.addEventListener('antigravity:modal-overlay-changed', (e: Event) => {
    const isOpen = Boolean((e as CustomEvent<{ isOpen?: boolean }>).detail?.isOpen);
    if (!isOpen && pendingCatalogGames !== null && !isTestEnv()) {
      pendingModalDeferStartedAt = null;
      if (pendingCatalogSaveTimer) {
        clearTimeout(pendingCatalogSaveTimer);
        pendingCatalogSaveTimer = null;
      }
      pendingCatalogSaveTimer = setTimeout(() => {
        pendingCatalogSaveTimer = null;
        flushPendingCatalogSave();
      }, 250);
    }
  });
}

function buildDefaultBaseCatalog(userOverrides: ReturnType<typeof loadUserOverrides>): CanonicalGame[] {
  let defaultBase: CanonicalGame[] = [];
  if (
    FULL_USER_STEAM_GAMES.length > 0 ||
    GOG_USER_LIBRARY.length > 0 ||
    EPIC_USER_LIBRARY.length > 0
  ) {
    defaultBase = sanitizeGameCatalog(
      mergeStorefrontGames(
        mergeStorefrontGames(mergeScannedSteamGames([]), GOG_USER_LIBRARY, 'gog'),
        EPIC_USER_LIBRARY,
        'epic'
      )
    );
    defaultBase = applyUserOverridesToCatalog(defaultBase, userOverrides);
  }
  return defaultBase;
}

export function loadCurrentCatalog(): CanonicalGame[] {
  const userOverrides = loadUserOverrides();

  if (typeof window === 'undefined') {
    return buildDefaultBaseCatalog(userOverrides);
  }

  try {
    if (
      (pendingCatalogGames !== null || !isTestEnv()) &&
      inMemoryCatalogCache !== null
    ) {
      return applyUserOverridesToCatalog(inMemoryCatalogCache, userOverrides);
    }

    const raw = localStorage.getItem(STORAGE_KEY_MAIN_CATALOG);
    if (raw) {
      const fp = computeCatalogFingerprint(raw);
      if (inMemoryCatalogCache !== null && inMemoryCatalogRawRef === fp) {
        return applyUserOverridesToCatalog(inMemoryCatalogCache, userOverrides);
      }

      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.__idbVaultOnly) {
        if (inMemoryCatalogCache !== null) {
          return applyUserOverridesToCatalog(inMemoryCatalogCache, userOverrides);
        }
        return buildDefaultBaseCatalog(userOverrides);
      }
      if (Array.isArray(parsed) && parsed.length > 0) {
        let compactedAny = parsed.some(
          (g: CanonicalGame) =>
            g?.platforms?.some(
              (p) =>
                p?.installSize !== undefined &&
                sanitizeGameInstallSizeBytes(p.installSize) === undefined
            ) ||
            (g?.platforms?.some((p) => p?.platformId === 'xbox') &&
              typeof g?.title === 'string' &&
              stripStorefrontPlatformDisambiguators(g.title) !== g.title)
        );
        const sanitizedParsed = preserveLocalInstallFieldsAcrossSanitize(
          parsed,
          sanitizeGameCatalog(parsed, { allowNewPurchases: true })
        );
        let cleaned = sanitizedParsed.map((g) => {
          const c = compactGameForStorage(g);
          if (c !== g) compactedAny = true;
          return c;
        });
        cleaned = applyUserOverridesToCatalog(cleaned, userOverrides);
        inMemoryCatalogCache = cleaned;
        if (cleaned.length !== parsed.length || compactedAny) {
          writeCatalogToLocalStorage(cleaned);
        } else {
          inMemoryCatalogRawRef = fp;
        }
        return cleaned;
      }
    } else {
      inMemoryCatalogCache = null;
      inMemoryCatalogRawRef = null;
    }

    const defaultBase = buildDefaultBaseCatalog(userOverrides);
    // Merge any custom games if stored in custom games delta
    const customRaw = localStorage.getItem(STORAGE_KEY_CUSTOM_GAMES);
    if (customRaw) {
      try {
        const customParsed = JSON.parse(customRaw);
        if (Array.isArray(customParsed) && customParsed.length > 0) {
          const customOnly = customParsed.filter(
            (g: CanonicalGame) =>
              g.platforms?.some((p) => p.platformId === 'custom') ||
              !g.platforms?.some((p) => ['steam', 'gog', 'epic', 'xbox'].includes(p.platformId))
          );
          for (const cg of customOnly) {
            if (!defaultBase.some((g: CanonicalGame) => g.id === cg.id)) {
              defaultBase.push(cg);
            }
          }
        }
      } catch (err) {
        console.warn('Failed to parse custom games cache:', err);
      }
    }
    return applyUserOverridesToCatalog(defaultBase, userOverrides);
  } catch (err) {
    console.warn('Failed to load cached universal catalog:', err);
  }
  return buildDefaultBaseCatalog(userOverrides);
}

export function saveCurrentCatalog(games: CanonicalGame[], options?: SaveCatalogOptions): void {
  if (typeof window === 'undefined') return;
  try {
    const incomingDirtyIds = collectDirtyGameIdsFromOptions(options);
    const isIncrementalCall = incomingDirtyIds !== null;

    if (!options?.immediate && !isTestEnv()) {
      const hadPendingSave = pendingCatalogGames !== null;
      inMemoryCatalogCache = games;
      pendingCatalogGames = games;
      pendingCatalogNeedsOverrides = true;
      if (!options?.skipSanitize) {
        pendingCatalogNeedsSanitize = true;
      }

      if (!isIncrementalCall) {
        pendingIsFullCatalogSync = true;
        pendingDirtyGameIds.clear();
        pendingModalDeferStartedAt = null;
      } else if (!pendingIsFullCatalogSync) {
        for (const id of incomingDirtyIds) {
          pendingDirtyGameIds.add(id);
        }
      }

      const scheduleDeferredFlush = (delayMs: number) => {
        if (pendingCatalogSaveTimer) {
          clearTimeout(pendingCatalogSaveTimer);
          pendingCatalogSaveTimer = null;
        }
        pendingCatalogSaveTimer = setTimeout(() => {
          pendingCatalogSaveTimer = null;
          if (!isTestEnv() && isUserActivelyScrolling()) {
            scheduleDeferredFlush(600);
            return;
          }
          if (
            !isTestEnv() &&
            !pendingIsFullCatalogSync &&
            isModalOverlayOpen() &&
            pendingModalDeferStartedAt !== null
          ) {
            const elapsed = Date.now() - pendingModalDeferStartedAt;
            if (elapsed < MAX_MODAL_INCREMENTAL_DEFER_MS) {
              scheduleDeferredFlush(Math.max(250, MAX_MODAL_INCREMENTAL_DEFER_MS - elapsed));
              return;
            }
          }
          try {
            flushPendingCatalogSave();
          } catch (e) {
            console.error('[IntegrationStorage] Deferred catalog flush failed:', e);
          }
        }, delayMs);
      };

      const shouldModalDefer = !pendingIsFullCatalogSync && isModalOverlayOpen();
      if (shouldModalDefer) {
        if (pendingModalDeferStartedAt === null) {
          pendingModalDeferStartedAt = Date.now();
        }
        if (!pendingCatalogSaveTimer) {
          const remaining = Math.max(
            250,
            MAX_MODAL_INCREMENTAL_DEFER_MS - (Date.now() - pendingModalDeferStartedAt)
          );
          scheduleDeferredFlush(remaining);
        }
      } else if (!pendingCatalogSaveTimer || (hadPendingSave && pendingIsFullCatalogSync)) {
        scheduleDeferredFlush(1200);
      }
      return;
    }

    if (pendingCatalogSaveTimer) {
      clearTimeout(pendingCatalogSaveTimer);
      pendingCatalogSaveTimer = null;
    }

    let immediateDirtySnapshot: ReadonlySet<string> | null = null;
    if (isIncrementalCall && !pendingIsFullCatalogSync) {
      const mergedDirty = new Set<string>(pendingDirtyGameIds);
      for (const id of incomingDirtyIds) {
        mergedDirty.add(id);
      }
      immediateDirtySnapshot = mergedDirty;
    }

    pendingCatalogGames = null;
    pendingCatalogNeedsSanitize = false;
    pendingCatalogNeedsOverrides = false;
    pendingIsFullCatalogSync = false;
    pendingDirtyGameIds.clear();
    pendingModalDeferStartedAt = null;

    const userOverrides = loadUserOverrides();
    const withOverrides = applyUserOverridesToCatalog(games, userOverrides);
    const cleaned = options?.skipSanitize ? withOverrides : sanitizeGameCatalog(withOverrides);
    inMemoryCatalogCache = cleaned;
    writeCatalogToLocalStorage(cleaned, immediateDirtySnapshot);
  } catch (err) {
    console.error('Failed to save universal catalog', err);
  }
}

export const loadSavedCatalog = loadCurrentCatalog;

export function clearIntegrationStorage(): void {
  if (pendingCatalogSaveTimer) {
    clearTimeout(pendingCatalogSaveTimer);
    pendingCatalogSaveTimer = null;
  }
  pendingCatalogGames = null;
  pendingCatalogNeedsSanitize = false;
  pendingCatalogNeedsOverrides = false;
  pendingIsFullCatalogSync = false;
  pendingDirtyGameIds.clear();
  pendingModalDeferStartedAt = null;
  inMemoryCatalogCache = null;
  inMemoryCatalogRawRef = null;
  void vaultDelete(IDB_KEY_MAIN_CATALOG);
  const storage = getSafeStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY_INTEGRATIONS);
    storage.removeItem(STORAGE_KEY_CUSTOM_GAMES);
    storage.removeItem(STORAGE_KEY_MAIN_CATALOG);
    storage.removeItem(STORAGE_KEY_VERIFIED_ENTITLEMENTS);
    storage.removeItem(STORAGE_KEY_XBOX_PROFILE);
  } catch {}
}

export function mergeStorefrontGames(
  currentCatalog: CanonicalGame[],
  newGames: CanonicalGame[],
  storefrontId: StorefrontId
): CanonicalGame[] {
  const userOverrides = loadUserOverrides();
  const verifiedIncoming = newGames.filter((g) => g && g.isVerifiedEntitlement === true);
  if (verifiedIncoming.length > 0) {
    recordVerifiedUserEntitlements(storefrontId, verifiedIncoming);
  }
  const sanitizedNew = sanitizeGameCatalog(newGames);

  const activeSyncedXboxKeys = new Set<string>();
  if (storefrontId === 'xbox') {
    for (const ng of sanitizedNew) {
      if (!ng) continue;
      const xp = ng.platforms?.find((p) => p.platformId === 'xbox');
      if (xp) {
        const k1 = normalizePlatformGameIdForLookup(xp.platformGameId);
        const k2 = normalizePlatformGameIdForLookup(xp.xboxProductId);
        const k3 = normalizePlatformGameIdForLookup(xp.xboxTitleId);
        const k4 = String(xp.packageFamilyName || '').trim().toLowerCase();
        if (k1) activeSyncedXboxKeys.add(k1);
        if (k2) activeSyncedXboxKeys.add(k2);
        if (k3) activeSyncedXboxKeys.add(k3);
        if (k4) activeSyncedXboxKeys.add(k4);
      }
      const nt = normalizeCanonicalTitle(ng.title);
      if (nt) activeSyncedXboxKeys.add(`title:${nt}`);
    }
  }

  const merged = currentCatalog.map((g) => {
    if (g.id.startsWith('steam-') && g.steamAppId) {
      return {
        ...g,
        platforms: g.platforms.map((p) => {
          if (p.platformId === 'steam' && p.platformGameId !== String(g.steamAppId)) {
            return {
              ...p,
              platformGameId: String(g.steamAppId),
              playtimeMinutes: 0,
              lastPlayed: undefined,
              achievements: undefined,
            };
          }
          return p;
        }),
      };
    }
    return g;
  });

  type IndexedCatalogMeta = {
    ovGameId?: string;
    ovSteamAppId?: number;
    storePlatIds: string[];
    steamAppId?: number;
    id: string;
    lowerTitle: string;
    normTitle: string;
    override?: ReturnType<typeof getUserOverrideForGame>;
  };

  const entryMeta: IndexedCatalogMeta[] = [];
  const byOverrideGameId = new Map<string, Set<number>>();
  const byOverrideSteamAppId = new Map<number, Set<number>>();
  const byStorePlatformGameId = new Map<string, Set<number>>();
  const bySteamAppId = new Map<number, Set<number>>();
  const byId = new Map<string, Set<number>>();
  const byLowerTitle = new Map<string, Set<number>>();
  const byNormTitle = new Map<string, Set<number>>();

  const addBucket = <K>(map: Map<K, Set<number>>, key: K, idx: number) => {
    let set = map.get(key);
    if (!set) {
      set = new Set<number>();
      map.set(key, set);
    }
    set.add(idx);
  };

  const removeBucket = <K>(map: Map<K, Set<number>>, key: K, idx: number) => {
    const set = map.get(key);
    if (set) {
      set.delete(idx);
      if (set.size === 0) map.delete(key);
    }
  };

  const unindexEntry = (idx: number) => {
    const meta = entryMeta[idx];
    if (!meta) return;
    if (meta.ovGameId) removeBucket(byOverrideGameId, meta.ovGameId, idx);
    if (meta.ovSteamAppId) removeBucket(byOverrideSteamAppId, meta.ovSteamAppId, idx);
    for (let i = 0; i < meta.storePlatIds.length; i++) {
      removeBucket(byStorePlatformGameId, meta.storePlatIds[i], idx);
    }
    if (meta.steamAppId) removeBucket(bySteamAppId, meta.steamAppId, idx);
    if (meta.id) removeBucket(byId, meta.id, idx);
    if (meta.lowerTitle) removeBucket(byLowerTitle, meta.lowerTitle, idx);
    if (meta.normTitle) removeBucket(byNormTitle, meta.normTitle, idx);
  };

  const indexEntry = (idx: number, g: CanonicalGame) => {
    const ov = getUserOverrideForGame(g, userOverrides);
    const storePlatIds: string[] = [];
    for (let i = 0; i < g.platforms.length; i++) {
      const p = g.platforms[i];
      if (p.platformId === storefrontId) {
        const pid = String(p.platformGameId || '').trim();
        if (pid) storePlatIds.push(pid);
        if (storefrontId === 'xbox') {
          const xBigId = String(p.xboxProductId || '').trim();
          const xPfn = String(p.packageFamilyName || '').trim().toLowerCase();
          const xTitleId = String(p.xboxTitleId || '').trim();
          if (xBigId && !storePlatIds.includes(xBigId)) storePlatIds.push(xBigId);
          if (xPfn && !storePlatIds.includes(xPfn)) storePlatIds.push(xPfn);
          if (xTitleId && !storePlatIds.includes(xTitleId)) storePlatIds.push(xTitleId);
        }
      }
    }
    const meta: IndexedCatalogMeta = {
      ovGameId: ov?.gameId || undefined,
      ovSteamAppId: ov?.steamAppId || undefined,
      storePlatIds,
      steamAppId: g.steamAppId || undefined,
      id: g.id || '',
      lowerTitle: g.title.toLowerCase().trim(),
      normTitle: normalizeCanonicalTitle(g.title),
      override: ov,
    };
    entryMeta[idx] = meta;
    if (meta.ovGameId) addBucket(byOverrideGameId, meta.ovGameId, idx);
    if (meta.ovSteamAppId) addBucket(byOverrideSteamAppId, meta.ovSteamAppId, idx);
    for (let i = 0; i < storePlatIds.length; i++) {
      addBucket(byStorePlatformGameId, storePlatIds[i], idx);
    }
    if (meta.steamAppId) addBucket(bySteamAppId, meta.steamAppId, idx);
    if (meta.id) addBucket(byId, meta.id, idx);
    if (meta.lowerTitle) addBucket(byLowerTitle, meta.lowerTitle, idx);
    if (meta.normTitle) addBucket(byNormTitle, meta.normTitle, idx);
  };

  for (let i = 0; i < merged.length; i++) {
    indexEntry(i, merged[i]);
  }

  const matchedTargetIndices = new Set<number>();

  for (const newGame of sanitizedNew) {
    const newNorm = normalizeCanonicalTitle(newGame.title);
    const newLower = newGame.title.toLowerCase().trim();
    const platformOwnership = newGame.platforms.find((p) => p.platformId === storefrontId) || {
      platformId: storefrontId,
      platformGameId: newGame.id,
      installed: false,
    };
    const incomingPlatGameId = String(platformOwnership.platformGameId || '').trim();

    const candidateSet = new Set<number>();
    const collectSet = (set?: Set<number>) => {
      if (!set) return;
      for (const idx of set) candidateSet.add(idx);
    };

    if (newGame.id) collectSet(byOverrideGameId.get(newGame.id));
    if (newGame.steamAppId) {
      collectSet(byOverrideGameId.get(`steam-${newGame.steamAppId}`));
      collectSet(byOverrideSteamAppId.get(newGame.steamAppId));
    }
    const incomingLookupIds: string[] = [];
    if (incomingPlatGameId) incomingLookupIds.push(incomingPlatGameId);
    if (storefrontId === 'xbox') {
      const incBigId = String(platformOwnership.xboxProductId || '').trim();
      const incPfn = String(platformOwnership.packageFamilyName || '').trim().toLowerCase();
      const incTitleId = String(platformOwnership.xboxTitleId || '').trim();
      if (incBigId && !incomingLookupIds.includes(incBigId)) incomingLookupIds.push(incBigId);
      if (incPfn && !incomingLookupIds.includes(incPfn)) incomingLookupIds.push(incPfn);
      if (incTitleId && !incomingLookupIds.includes(incTitleId)) incomingLookupIds.push(incTitleId);
    }
    for (const lookupId of incomingLookupIds) {
      const platMatches = byStorePlatformGameId.get(lookupId);
      if (platMatches) {
        for (const idx of platMatches) {
          const g = merged[idx];
          if (
            g.platforms.length > 0 &&
            (storefrontId === 'xbox'
              ? g.platforms.some((p) => p.platformId === 'xbox')
              : g.platforms.every((p) => p.platformId === storefrontId))
          ) {
            candidateSet.add(idx);
          }
        }
      }
    }
    if (newGame.steamAppId) collectSet(bySteamAppId.get(newGame.steamAppId));
    if (newGame.id) collectSet(byId.get(newGame.id));
    if (newLower) collectSet(byLowerTitle.get(newLower));
    if (newNorm) collectSet(byNormTitle.get(newNorm));

    let existingIndex = -1;
    if (candidateSet.size > 0) {
      const sortedCandidates =
        candidateSet.size === 1
          ? [candidateSet.values().next().value as number]
          : Array.from(candidateSet).sort((a, b) => {
              const ga = merged[a];
              const gb = merged[b];
              const aHasOtherStore = Boolean(
                ga?.platforms?.some((p) => p.platformId !== storefrontId)
              );
              const bHasOtherStore = Boolean(
                gb?.platforms?.some((p) => p.platformId !== storefrontId)
              );
              if (aHasOtherStore !== bHasOtherStore) {
                return aHasOtherStore ? -1 : 1;
              }
              return a - b;
            });
      for (let c = 0; c < sortedCandidates.length; c++) {
        const candIdx = sortedCandidates[c];
        const g = merged[candIdx];
        if (!g || g.platforms.length === 0) continue;
        if (hasSameStorefrontConflict(g, newGame)) continue;
        if (hasSplitOverrideConflict(g, newGame, userOverrides)) continue;
        existingIndex = candIdx;
        break;
      }
    }

    const targetIndex = existingIndex >= 0 ? existingIndex : merged.length;
    matchedTargetIndices.add(targetIndex);

    if (existingIndex >= 0) {
      const existing = merged[existingIndex];
      const existingOverride = entryMeta[existingIndex]?.override;
      unindexEntry(existingIndex);
      const preferStorefrontTitle =
        existing.platforms.every((p) => p.platformId === storefrontId) &&
        !existingOverride?.title &&
        Boolean(newGame.title);
      const hasPlatform = existing.platforms.some((p) => p.platformId === storefrontId);
      const updatedPlatforms = hasPlatform
        ? existing.platforms.map((p) => {
            if (p.platformId !== storefrontId) return p;
            const mergedInstalled = Boolean(platformOwnership.installed || p.installed);
            const mergedInstallSize = mergedInstalled
              ? (sanitizeGameInstallSizeBytes(platformOwnership.installSize) ??
                  sanitizeGameInstallSizeBytes(p.installSize))
              : sanitizeGameInstallSizeBytes(platformOwnership.installSize);

            const mergedOwnershipType: XboxOwnershipType | undefined =
              storefrontId === 'xbox'
                ? platformOwnership.ownershipType !== undefined
                  ? platformOwnership.ownershipType
                  : p.ownershipType
                : platformOwnership.ownershipType || p.ownershipType;

            const xboxOwnershipFields: Partial<GamePlatformOwnership> =
              storefrontId === 'xbox'
                ? mergedOwnershipType === 'owned'
                  ? {
                      ownershipType: 'owned',
                      gamePassTier: undefined,
                      isLeavingSoon: undefined,
                      isRecentlyAddedToGamePass: undefined,
                      subscriptionExpired: false,
                    }
                  : mergedOwnershipType === 'subscription' ||
                    mergedOwnershipType === 'owned_and_subscription'
                  ? {
                      ownershipType: mergedOwnershipType,
                      gamePassTier:
                        platformOwnership.ownershipType !== undefined
                          ? platformOwnership.gamePassTier || undefined
                          : platformOwnership.gamePassTier || p.gamePassTier || undefined,
                      isLeavingSoon: Boolean(platformOwnership.isLeavingSoon) || undefined,
                      isRecentlyAddedToGamePass:
                        Boolean(platformOwnership.isRecentlyAddedToGamePass) || undefined,
                      subscriptionExpired:
                        mergedOwnershipType === 'owned_and_subscription'
                          ? undefined
                          : Boolean(platformOwnership.subscriptionExpired) || undefined,
                    }
                  : {
                      ownershipType: undefined,
                      gamePassTier: platformOwnership.gamePassTier || undefined,
                      isLeavingSoon: Boolean(platformOwnership.isLeavingSoon) || undefined,
                      isRecentlyAddedToGamePass:
                        Boolean(platformOwnership.isRecentlyAddedToGamePass) || undefined,
                      subscriptionExpired:
                        Boolean(platformOwnership.subscriptionExpired) || undefined,
                    }
                : {
                    ...(mergedOwnershipType ? { ownershipType: mergedOwnershipType } : {}),
                    ...(platformOwnership.gamePassTier || p.gamePassTier
                      ? { gamePassTier: platformOwnership.gamePassTier || p.gamePassTier }
                      : {}),
                    ...(platformOwnership.isLeavingSoon !== undefined ||
                    p.isLeavingSoon !== undefined
                      ? { isLeavingSoon: platformOwnership.isLeavingSoon ?? p.isLeavingSoon }
                      : {}),
                    ...(platformOwnership.isRecentlyAddedToGamePass !== undefined ||
                    p.isRecentlyAddedToGamePass !== undefined
                      ? {
                          isRecentlyAddedToGamePass:
                            platformOwnership.isRecentlyAddedToGamePass ??
                            p.isRecentlyAddedToGamePass,
                        }
                      : {}),
                  };

            const nextPlaytimeMinutes =
              storefrontId === 'steam' &&
              newGame.isVerifiedEntitlement &&
              platformOwnership.playtimeMinutes !== undefined
                ? platformOwnership.playtimeMinutes
                : storefrontId === 'xbox' &&
                  (p.playtimeMinutes !== undefined ||
                    platformOwnership.playtimeMinutes !== undefined)
                ? Math.max(p.playtimeMinutes ?? 0, platformOwnership.playtimeMinutes ?? 0)
                : platformOwnership.playtimeMinutes !== undefined &&
                  platformOwnership.playtimeMinutes > 0
                ? platformOwnership.playtimeMinutes
                : p.playtimeMinutes;

            const nextPlat: GamePlatformOwnership = {
              ...p,
              platformGameId: platformOwnership.platformGameId || p.platformGameId,
              storefrontAppId: platformOwnership.storefrontAppId || p.storefrontAppId,
              namespace: platformOwnership.namespace || p.namespace,
              catalogItemId: platformOwnership.catalogItemId || p.catalogItemId,
              ...(platformOwnership.xboxProductId || p.xboxProductId
                ? { xboxProductId: platformOwnership.xboxProductId || p.xboxProductId }
                : {}),
              ...(platformOwnership.packageFamilyName || p.packageFamilyName
                ? { packageFamilyName: platformOwnership.packageFamilyName || p.packageFamilyName }
                : {}),
              ...(platformOwnership.appUserModelId || p.appUserModelId
                ? { appUserModelId: platformOwnership.appUserModelId || p.appUserModelId }
                : {}),
              ...(platformOwnership.xboxTitleId || p.xboxTitleId
                ? { xboxTitleId: platformOwnership.xboxTitleId || p.xboxTitleId }
                : {}),
              ...(platformOwnership.scid || p.scid
                ? { scid: platformOwnership.scid || p.scid }
                : {}),
              ...(platformOwnership.msaAppId || p.msaAppId
                ? { msaAppId: platformOwnership.msaAppId || p.msaAppId }
                : {}),
              ...xboxOwnershipFields,
              ...(platformOwnership.externalStorefrontHandoff || p.externalStorefrontHandoff
                ? {
                    externalStorefrontHandoff:
                      platformOwnership.externalStorefrontHandoff || p.externalStorefrontHandoff,
                  }
                : {}),
              ...(platformOwnership.xboxBottleCompatibilityTier || p.xboxBottleCompatibilityTier
                ? {
                    xboxBottleCompatibilityTier:
                      platformOwnership.xboxBottleCompatibilityTier ||
                      p.xboxBottleCompatibilityTier,
                  }
                : {}),
              platforms: platformOwnership.platforms || p.platforms,
              installed: mergedInstalled,
              installPath: platformOwnership.installPath || p.installPath,
              executablePath: platformOwnership.executablePath || p.executablePath,
              version: platformOwnership.version || p.version,
              launchArguments: platformOwnership.launchArguments || p.launchArguments,
              isWindowsBinaryOnMac:
                platformOwnership.isWindowsBinaryOnMac ?? p.isWindowsBinaryOnMac,
              lastPlayed:
                storefrontId === 'steam' && newGame.isVerifiedEntitlement
                  ? platformOwnership.lastPlayed
                  : platformOwnership.lastPlayed || p.lastPlayed,
              playtimeMinutes: nextPlaytimeMinutes,
              achievements: reconcileAchievementSummaries(
                p.achievements,
                platformOwnership.achievements,
                { title: newGame.title, appId: newGame.steamAppId, store: storefrontId }
              ),
            };
            if (mergedInstallSize !== undefined) {
              nextPlat.installSize = mergedInstallSize;
            } else {
              delete nextPlat.installSize;
            }
            return nextPlat;
          })
        : [
            ...existing.platforms,
            storefrontId === 'xbox' && platformOwnership.ownershipType === 'owned'
              ? {
                  ...platformOwnership,
                  gamePassTier: undefined,
                  isLeavingSoon: undefined,
                  isRecentlyAddedToGamePass: undefined,
                  subscriptionExpired: false,
                }
              : storefrontId === 'xbox' &&
                platformOwnership.ownershipType === 'owned_and_subscription'
              ? { ...platformOwnership, subscriptionExpired: undefined }
              : platformOwnership,
          ];

      const mergedSteamAppId = existing.isExplicitNonSteam
        ? undefined
        : existing.steamAppId || newGame.steamAppId;

      merged[existingIndex] = {
        ...existing,
        title: preferStorefrontTitle ? newGame.title : existing.title,
        sortTitle: preferStorefrontTitle ? (newGame.sortTitle || existing.sortTitle) : existing.sortTitle,
        headerImage:
          pickPreferredHeaderImage(existing.headerImage, newGame.headerImage) ||
          existing.headerImage ||
          newGame.headerImage,
        capsuleImage: pickPreferredCapsuleImage(existing.capsuleImage, newGame.capsuleImage),
        iconUrl: !isUnsuitableHeaderUrl(existing.iconUrl) ? existing.iconUrl : (newGame.iconUrl || newGame.capsuleImage || newGame.headerImage),
        steamAppId: mergedSteamAppId,
        id: mergedSteamAppId ? `steam-${mergedSteamAppId}` : existing.id,
        platforms: updatedPlatforms,
        developers: (existing.developers && existing.developers.length > 0) ? existing.developers : newGame.developers,
        publishers: (existing.publishers && existing.publishers.length > 0) ? existing.publishers : newGame.publishers,
        genres: (existing.genres && existing.genres.length > 0) ? existing.genres : newGame.genres,
        tags: (() => {
          const baseTags =
            existing.tags && existing.tags.length > 0 ? existing.tags : newGame.tags;
          if (storefrontId !== 'xbox' || !Array.isArray(baseTags) || baseTags.length === 0) {
            return baseTags;
          }
          const updatedXboxPlat = updatedPlatforms.find((p) => p.platformId === 'xbox');
          if (updatedXboxPlat?.ownershipType === 'owned') {
            return baseTags.filter(
              (t) =>
                !/^(?:xbox\s+game\s+pass|pc\s+game\s+pass|game\s+pass(?:\s+ultimate|\s+core|\s+standard)?|leaving\s+soon)$/i.test(
                  String(t || '').trim()
                )
            );
          }
          if (!updatedXboxPlat?.isLeavingSoon) {
            return baseTags.filter((t) => !/^leaving\s+soon$/i.test(String(t || '').trim()));
          }
          return baseTags;
        })(),
        shortDescription: existing.shortDescription || newGame.shortDescription,
        detailedDescription: pickPreferredDetailedDescription(
          existing.detailedDescription,
          newGame.detailedDescription
        ),
        releaseDate:
          pickPreferredReleaseDate(existing.releaseDate, newGame.releaseDate) ||
          existing.releaseDate ||
          newGame.releaseDate,
        reviewSummary: existing.reviewSummary || newGame.reviewSummary,
        isVerifiedEntitlement: existing.isVerifiedEntitlement || newGame.isVerifiedEntitlement,
        matchConfidence: existing.matchConfidence ?? newGame.matchConfidence,
        needsMatchReview: existing.needsMatchReview ?? newGame.needsMatchReview,
        enrichedMetadata: pickBestEnrichedMetadata(
          existing.enrichedMetadata,
          newGame.enrichedMetadata
        ),
      };

      if (existingOverride) {
        merged[existingIndex] = applyUserOverrideToGame(merged[existingIndex], existingOverride);
      }
      indexEntry(existingIndex, merged[existingIndex]);
    } else {
      const insertedOwnership =
        storefrontId === 'xbox' && platformOwnership.ownershipType === 'owned'
          ? {
              ...platformOwnership,
              gamePassTier: undefined,
              isLeavingSoon: undefined,
              isRecentlyAddedToGamePass: undefined,
              subscriptionExpired: false,
            }
          : storefrontId === 'xbox' &&
            platformOwnership.ownershipType === 'owned_and_subscription'
          ? { ...platformOwnership, subscriptionExpired: undefined }
          : platformOwnership;
      const inserted: CanonicalGame = {
        ...newGame,
        platforms: [insertedOwnership],
      };
      merged.push(inserted);
      indexEntry(targetIndex, inserted);
    }

    // Ensure platformOwnership.platformGameId is not left attached to any other entry in merged from a prior false merge (O(1) via index)
    const assignedGameId = String(platformOwnership.platformGameId || '').trim();
    if (assignedGameId) {
      const owners = byStorePlatformGameId.get(assignedGameId);
      if (owners && (owners.size > 1 || !owners.has(targetIndex))) {
        for (const otherIdx of Array.from(owners)) {
          if (otherIdx === targetIndex) continue;
          const other = merged[otherIdx];
          unindexEntry(otherIdx);
          merged[otherIdx] = {
            ...other,
            platforms: other.platforms.filter(
              (p) =>
                !(
                  p.platformId === storefrontId &&
                  String(p.platformGameId || '').trim() === assignedGameId
                )
            ),
          };
          if (merged[otherIdx].platforms.length > 0) {
            indexEntry(otherIdx, merged[otherIdx]);
          }
        }
      }
    }
  }

  // Strict Active-Access Gate for Xbox Game Pass rotation / subscription expiry:
  // Any previously synced Xbox platform entry no longer present in the active synced list:
  // - If permanently owned ('owned' / 'owned_and_subscription'): retain as 'owned' with subscriptionExpired: false and cleared Game Pass flags.
  // - If subscription-only ('subscription') and NOT installed: prune from catalog.
  // - If subscription-only ('subscription') and installed locally: retain with subscriptionExpired: true and cleared active GP promo flags.
  if (storefrontId === 'xbox') {
    for (let idx = 0; idx < merged.length; idx++) {
      if (matchedTargetIndices.has(idx)) continue;
      const g = merged[idx];
      if (!g || !Array.isArray(g.platforms) || !g.platforms.some((p) => p.platformId === 'xbox')) {
        continue;
      }
      const nextPlats: GamePlatformOwnership[] = [];
      let platChanged = false;
      for (const p of g.platforms) {
        if (p.platformId !== 'xbox') {
          nextPlats.push(p);
          continue;
        }
        const k1 = normalizePlatformGameIdForLookup(p.platformGameId);
        const k2 = normalizePlatformGameIdForLookup(p.xboxProductId);
        const k3 = normalizePlatformGameIdForLookup(p.xboxTitleId);
        const k4 = String(p.packageFamilyName || '').trim().toLowerCase();
        const nt = normalizeCanonicalTitle(g.title);
        const stillInActiveSync =
          (k1 && activeSyncedXboxKeys.has(k1)) ||
          (k2 && activeSyncedXboxKeys.has(k2)) ||
          (k3 && activeSyncedXboxKeys.has(k3)) ||
          (k4 && activeSyncedXboxKeys.has(k4)) ||
          (nt && activeSyncedXboxKeys.has(`title:${nt}`));
        if (stillInActiveSync) {
          nextPlats.push(p);
          continue;
        }
        if (p.ownershipType === 'owned' || p.ownershipType === 'owned_and_subscription') {
          if (
            p.ownershipType !== 'owned' ||
            p.subscriptionExpired !== false ||
            p.gamePassTier !== undefined ||
            p.isLeavingSoon !== undefined ||
            p.isRecentlyAddedToGamePass !== undefined
          ) {
            platChanged = true;
            nextPlats.push({
              ...p,
              ownershipType: 'owned',
              gamePassTier: undefined,
              isLeavingSoon: undefined,
              isRecentlyAddedToGamePass: undefined,
              subscriptionExpired: false,
            });
          } else {
            nextPlats.push(p);
          }
        } else if (p.installed) {
          // Retain locally installed Game Pass game with subscriptionExpired: true
          const targetOwnership = p.ownershipType || 'subscription';
          if (
            p.ownershipType !== targetOwnership ||
            p.subscriptionExpired !== true ||
            p.isLeavingSoon !== undefined ||
            p.isRecentlyAddedToGamePass !== undefined
          ) {
            platChanged = true;
            nextPlats.push({
              ...p,
              ownershipType: targetOwnership,
              subscriptionExpired: true,
              isLeavingSoon: undefined,
              isRecentlyAddedToGamePass: undefined,
            });
          } else {
            nextPlats.push(p);
          }
        } else {
          // Uninstalled subscription-only title rotated out or subscription lapsed -> prune
          platChanged = true;
        }
      }
      if (platChanged) {
        const downgradedXboxPlat = nextPlats.find((p) => p.platformId === 'xbox');
        const cleanedTags =
          Array.isArray(g.tags) && g.tags.length > 0
            ? downgradedXboxPlat?.ownershipType === 'owned'
              ? g.tags.filter(
                  (t) =>
                    !/^(?:xbox\s+game\s+pass|pc\s+game\s+pass|game\s+pass(?:\s+ultimate|\s+core|\s+standard)?|leaving\s+soon)$/i.test(
                      String(t || '').trim()
                    )
                )
              : g.tags.filter((t) => !/^leaving\s+soon$/i.test(String(t || '').trim()))
            : g.tags;
        merged[idx] = {
          ...g,
          platforms: nextPlats,
          tags: cleanedTags,
        };
      }
    }
  }

  const nonEmptyMerged = merged.filter((g) => g.platforms && g.platforms.length > 0);
  const finalCatalog = preserveLocalInstallFieldsAcrossSanitize(
    nonEmptyMerged,
    sanitizeGameCatalog(nonEmptyMerged)
  );
  const withOverrides = applyUserOverridesToCatalog(finalCatalog, userOverrides);
  return withOverrides.sort((a, b) => BASE_TITLE_COLLATOR.compare(a.title, b.title));
}

const BASE_TITLE_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' });

export function normalizePlatformGameIdForLookup(raw?: string | number | null): string {
  if (raw === undefined || raw === null) return '';
  return String(raw)
    .trim()
    .replace(/^(?:gog[_-]|epic[_-]|steam[_-]|xbox[_-]|custom[_-])/i, '')
    .toLowerCase();
}

function normalizeInstallPathForLookup(raw?: string | null): string {
  if (!raw) return '';
  return String(raw).trim().replace(/[\\/]+$/, '').toLowerCase();
}

function hasLocalInstallMetadata(p: GamePlatformOwnership): boolean {
  return Boolean(
    p.installed ||
      p.installPath ||
      p.executablePath ||
      p.launchArguments ||
      (p.installed && sanitizeGameInstallSizeBytes(p.installSize) !== undefined) ||
      p.version ||
      p.isWindowsBinaryOnMac !== undefined
  );
}

export function preserveLocalInstallFieldsAcrossSanitize(
  sourceGames: CanonicalGame[],
  sanitizedGames: CanonicalGame[]
): CanonicalGame[] {
  const hasInvalidSanitizedSize = Array.isArray(sanitizedGames)
    ? sanitizedGames.some((g) =>
        g?.platforms?.some(
          (p) =>
            p?.installSize !== undefined &&
            sanitizeGameInstallSizeBytes(p.installSize) === undefined
        )
      )
    : false;

  if (!Array.isArray(sourceGames) || sourceGames.length === 0) {
    if (!hasInvalidSanitizedSize) return sanitizedGames;
  }

  let anySourceHasLocal = false;
  if (Array.isArray(sourceGames)) {
    for (let i = 0; i < sourceGames.length && !anySourceHasLocal; i++) {
      const plats = sourceGames[i]?.platforms;
      if (Array.isArray(plats)) {
        for (let j = 0; j < plats.length; j++) {
          if (plats[j] && hasLocalInstallMetadata(plats[j])) {
            anySourceHasLocal = true;
            break;
          }
        }
      }
    }
  }
  if (!anySourceHasLocal && !hasInvalidSanitizedSize) return sanitizedGames;

  const byKey = new Map<string, GamePlatformOwnership>();
  const registerPlat = (key: string, p: GamePlatformOwnership) => {
    if (!key) return;
    const sanitizedPSize = p.installed ? sanitizeGameInstallSizeBytes(p.installSize) : undefined;
    const normalizedP: GamePlatformOwnership = { ...p };
    if (sanitizedPSize !== undefined) {
      normalizedP.installSize = sanitizedPSize;
    } else {
      delete normalizedP.installSize;
    }
    const prev = byKey.get(key);
    if (!prev || (!prev.installed && normalizedP.installed)) {
      byKey.set(key, normalizedP);
    } else if (prev) {
      const mergedInstalled = Boolean(prev.installed || normalizedP.installed);
      const mergedSize = mergedInstalled
        ? ((prev.installed ? sanitizeGameInstallSizeBytes(prev.installSize) : undefined) ??
          sanitizedPSize)
        : undefined;
      const mergedEntry: GamePlatformOwnership = {
        ...prev,
        installed: mergedInstalled,
        installPath: prev.installPath || normalizedP.installPath,
        executablePath: prev.executablePath || normalizedP.executablePath,
        version: prev.version || normalizedP.version,
        launchArguments: prev.launchArguments || normalizedP.launchArguments,
        isWindowsBinaryOnMac: prev.isWindowsBinaryOnMac ?? normalizedP.isWindowsBinaryOnMac,
      };
      if (mergedSize !== undefined) {
        mergedEntry.installSize = mergedSize;
      } else {
        delete mergedEntry.installSize;
      }
      byKey.set(key, mergedEntry);
    }
  };

  if (anySourceHasLocal) {
    for (const g of sourceGames) {
      if (!g || !Array.isArray(g.platforms)) continue;
      for (const p of g.platforms) {
        if (!p || !hasLocalInstallMetadata(p)) continue;
        const normId = normalizePlatformGameIdForLookup(p.platformGameId);
        const normStoreId = normalizePlatformGameIdForLookup(p.storefrontAppId);
        if (normId) registerPlat(`${p.platformId}:${normId}`, p);
        if (normStoreId && normStoreId !== normId) {
          registerPlat(`${p.platformId}:${normStoreId}`, p);
        }
        if (p.platformId === 'xbox') {
          const normXboxId = normalizePlatformGameIdForLookup(p.xboxProductId);
          const normPfn = String(p.packageFamilyName || '').trim().toLowerCase();
          if (normXboxId) registerPlat(`xbox:${normXboxId}`, p);
          if (normPfn) registerPlat(`xbox:${normPfn}`, p);
        }
        if (p.platformId === 'steam' && g.steamAppId) {
          registerPlat(`steam:${g.steamAppId}`, p);
        }
      }
    }
  }

  let catalogChanged = false;
  const restored = sanitizedGames.map((g) => {
    if (!g || !Array.isArray(g.platforms)) return g;
    let gameChanged = false;
    const nextPlatforms = g.platforms.map((p) => {
      const normId = normalizePlatformGameIdForLookup(p.platformGameId);
      const normStoreId = normalizePlatformGameIdForLookup(p.storefrontAppId);
      const normXboxId =
        p.platformId === 'xbox' ? normalizePlatformGameIdForLookup(p.xboxProductId) : '';
      const normPfn =
        p.platformId === 'xbox' ? String(p.packageFamilyName || '').trim().toLowerCase() : '';
      const saved =
        (normId ? byKey.get(`${p.platformId}:${normId}`) : undefined) ||
        (normStoreId ? byKey.get(`${p.platformId}:${normStoreId}`) : undefined) ||
        (normXboxId ? byKey.get(`xbox:${normXboxId}`) : undefined) ||
        (normPfn ? byKey.get(`xbox:${normPfn}`) : undefined) ||
        (p.platformId === 'steam' && g.steamAppId ? byKey.get(`steam:${g.steamAppId}`) : undefined);

      const sanitizedCurrentSize = p.installed
        ? sanitizeGameInstallSizeBytes(p.installSize)
        : undefined;

      if (!saved) {
        if (p.installSize === sanitizedCurrentSize) {
          return p;
        }
        gameChanged = true;
        const cleanedPlat: GamePlatformOwnership = { ...p };
        if (sanitizedCurrentSize !== undefined) {
          cleanedPlat.installSize = sanitizedCurrentSize;
        } else {
          delete cleanedPlat.installSize;
        }
        return cleanedPlat;
      }

      const nextInstalled = Boolean(p.installed || saved.installed);
      const nextInstallPath = p.installPath || saved.installPath;
      const nextExePath = p.executablePath || saved.executablePath;
      const nextInstallSize = nextInstalled
        ? (sanitizeGameInstallSizeBytes(p.installSize) ??
          (saved.installed ? sanitizeGameInstallSizeBytes(saved.installSize) : undefined))
        : undefined;
      const nextVersion = p.version || saved.version;
      const nextLaunchArgs = p.launchArguments || saved.launchArguments;
      const nextWinOnMac = p.isWindowsBinaryOnMac ?? saved.isWindowsBinaryOnMac;

      if (
        Boolean(p.installed) === nextInstalled &&
        p.installPath === nextInstallPath &&
        p.executablePath === nextExePath &&
        p.installSize === nextInstallSize &&
        p.version === nextVersion &&
        p.launchArguments === nextLaunchArgs &&
        p.isWindowsBinaryOnMac === nextWinOnMac
      ) {
        return p;
      }

      gameChanged = true;
      const restoredPlat: GamePlatformOwnership = {
        ...p,
        installed: nextInstalled,
        ...(nextInstallPath !== undefined ? { installPath: nextInstallPath } : {}),
        ...(nextExePath !== undefined ? { executablePath: nextExePath } : {}),
        ...(nextVersion !== undefined ? { version: nextVersion } : {}),
        ...(nextLaunchArgs !== undefined ? { launchArguments: nextLaunchArgs } : {}),
        ...(nextWinOnMac !== undefined ? { isWindowsBinaryOnMac: nextWinOnMac } : {}),
      };
      if (nextInstallSize !== undefined) {
        restoredPlat.installSize = nextInstallSize;
      } else {
        delete restoredPlat.installSize;
      }
      return restoredPlat;
    });

    if (!gameChanged) return g;
    catalogChanged = true;
    return { ...g, platforms: nextPlatforms };
  });

  return catalogChanged ? restored : sanitizedGames;
}

export interface ReconcileCatalogInstalledOptions {
  authoritativeRemoval?: boolean;
  installedSteamAppIds?: Set<number> | null;
  getHasCustomExe?: (gameId: string, platformId: StorefrontId) => boolean;
}

export function reconcileCatalogGamesWithInstalledRecords(
  games: CanonicalGame[],
  installedRecords: InstalledGameRecord[],
  options?: ReconcileCatalogInstalledOptions
): CanonicalGame[] {
  if (!Array.isArray(games) || games.length === 0) return games;

  const authoritativeRemoval = Boolean(options?.authoritativeRemoval);
  const installedSteamAppIds = options?.installedSteamAppIds ?? null;
  const getHasCustomExe = options?.getHasCustomExe;

  const byPlatNormId = new Map<string, InstalledGameRecord>();
  const bySteamAppId = new Map<number, InstalledGameRecord>();
  const byPlatInstallPath = new Map<string, InstalledGameRecord>();

  if (Array.isArray(installedRecords)) {
    for (const r of installedRecords) {
      if (!r || !r.platformId) continue;
      const rawId = String(r.platformGameId ?? '').trim().toLowerCase();
      const normId = normalizePlatformGameIdForLookup(r.platformGameId);
      if (rawId) {
        const rawKey = `${r.platformId}:${rawId}`;
        if (!byPlatNormId.has(rawKey)) byPlatNormId.set(rawKey, r);
      }
      if (normId) {
        const normKey = `${r.platformId}:${normId}`;
        if (!byPlatNormId.has(normKey)) byPlatNormId.set(normKey, r);
      }
      if (r.platformId === 'xbox') {
        const rXboxBigId = normalizePlatformGameIdForLookup(
          (r as InstalledGameRecord & { xboxProductId?: string }).xboxProductId
        );
        const rPfn = String(r.packageFamilyName || '').trim().toLowerCase();
        const rTitleId = normalizePlatformGameIdForLookup(r.xboxTitleId);
        if (rXboxBigId && !byPlatNormId.has(`xbox:${rXboxBigId}`)) {
          byPlatNormId.set(`xbox:${rXboxBigId}`, r);
        }
        if (rPfn && !byPlatNormId.has(`xbox:${rPfn}`)) {
          byPlatNormId.set(`xbox:${rPfn}`, r);
        }
        if (rTitleId && !byPlatNormId.has(`xbox:${rTitleId}`)) {
          byPlatNormId.set(`xbox:${rTitleId}`, r);
        }
      }
      if (r.platformId === 'steam') {
        const appIdNum = Number(r.appId || normId);
        if (Number.isFinite(appIdNum) && appIdNum > 0 && !bySteamAppId.has(appIdNum)) {
          bySteamAppId.set(appIdNum, r);
        }
      }
      const normPath = normalizeInstallPathForLookup(r.installPath);
      if (normPath) {
        const pathKey = `${r.platformId}:${normPath}`;
        if (!byPlatInstallPath.has(pathKey)) byPlatInstallPath.set(pathKey, r);
      }
    }
  }

  let anyCatalogChanged = false;
  const nextGames = games.map((game) => {
    if (!game || !Array.isArray(game.platforms) || game.platforms.length === 0) return game;
    const targetAppId = game.steamAppId;
    let gameChanged = false;

    const nextPlatforms = game.platforms.map((p) => {
      const rawPId = String(p.platformGameId ?? '').trim().toLowerCase();
      const normPId = normalizePlatformGameIdForLookup(p.platformGameId);
      const normStoreAppId = normalizePlatformGameIdForLookup(p.storefrontAppId);
      const normXboxBigId =
        p.platformId === 'xbox' ? normalizePlatformGameIdForLookup(p.xboxProductId) : '';
      const normXboxPfn =
        p.platformId === 'xbox' ? String(p.packageFamilyName || '').trim().toLowerCase() : '';
      const normXboxTitleId =
        p.platformId === 'xbox' ? normalizePlatformGameIdForLookup(p.xboxTitleId) : '';
      const normInstallPath = normalizeInstallPathForLookup(p.installPath);

      const matchedRecord =
        (rawPId ? byPlatNormId.get(`${p.platformId}:${rawPId}`) : undefined) ||
        (normPId ? byPlatNormId.get(`${p.platformId}:${normPId}`) : undefined) ||
        (normStoreAppId ? byPlatNormId.get(`${p.platformId}:${normStoreAppId}`) : undefined) ||
        (normXboxBigId ? byPlatNormId.get(`xbox:${normXboxBigId}`) : undefined) ||
        (normXboxPfn ? byPlatNormId.get(`xbox:${normXboxPfn}`) : undefined) ||
        (normXboxTitleId ? byPlatNormId.get(`xbox:${normXboxTitleId}`) : undefined) ||
        (p.platformId === 'steam' && targetAppId
          ? bySteamAppId.get(Number(targetAppId))
          : undefined) ||
        (normInstallPath ? byPlatInstallPath.get(`${p.platformId}:${normInstallPath}`) : undefined);

      if (matchedRecord) {
        const nextInstallPath = matchedRecord.installPath || p.installPath;
        const nextExePath = matchedRecord.executablePath || p.executablePath;
        const nextLaunchArgs = matchedRecord.launchArguments || p.launchArguments;
        const scannedInstallSize = sanitizeGameInstallSizeBytes(matchedRecord.installSize);
        const catalogInstallSize = sanitizeGameInstallSizeBytes(p.installSize);
        const isSuspiciousTinyScannedSize =
          scannedInstallSize !== undefined &&
          catalogInstallSize !== undefined &&
          catalogInstallSize >= 50 * 1024 * 1024 &&
          scannedInstallSize < Math.min(10 * 1024 * 1024, catalogInstallSize * 0.05);
        const nextInstallSize = isSuspiciousTinyScannedSize
          ? catalogInstallSize
          : (scannedInstallSize ?? catalogInstallSize);
        const nextVersion = matchedRecord.version || p.version;
        const nextWinOnMac = matchedRecord.isWindowsBinaryOnMac ?? p.isWindowsBinaryOnMac;
        const nextPfn = matchedRecord.packageFamilyName || p.packageFamilyName;
        const nextAumid = matchedRecord.appUserModelId || p.appUserModelId;
        const nextXboxTitleId = matchedRecord.xboxTitleId || p.xboxTitleId;
        const nextScid = matchedRecord.scid || p.scid;
        const nextMsaAppId = matchedRecord.msaAppId || p.msaAppId;

        if (
          p.installed === true &&
          p.installPath === nextInstallPath &&
          p.executablePath === nextExePath &&
          p.launchArguments === nextLaunchArgs &&
          p.installSize === nextInstallSize &&
          p.version === nextVersion &&
          p.isWindowsBinaryOnMac === nextWinOnMac &&
          p.packageFamilyName === nextPfn &&
          p.appUserModelId === nextAumid &&
          p.xboxTitleId === nextXboxTitleId &&
          p.scid === nextScid &&
          p.msaAppId === nextMsaAppId
        ) {
          return p;
        }

        gameChanged = true;
        const updatedP: GamePlatformOwnership = {
          ...p,
          installed: true,
          installPath: nextInstallPath,
          executablePath: nextExePath,
          version: nextVersion,
          isWindowsBinaryOnMac: nextWinOnMac,
          ...(nextPfn !== undefined ? { packageFamilyName: nextPfn } : {}),
          ...(nextAumid !== undefined ? { appUserModelId: nextAumid } : {}),
          ...(nextXboxTitleId !== undefined ? { xboxTitleId: nextXboxTitleId } : {}),
          ...(nextScid !== undefined ? { scid: nextScid } : {}),
          ...(nextMsaAppId !== undefined ? { msaAppId: nextMsaAppId } : {}),
        };
        if (nextInstallSize !== undefined) {
          updatedP.installSize = nextInstallSize;
        } else {
          delete updatedP.installSize;
        }
        if (nextLaunchArgs !== undefined) {
          updatedP.launchArguments = nextLaunchArgs;
        }
        return updatedP;
      }

      if (!authoritativeRemoval) {
        return p;
      }

      const hasCustomExe = Boolean(getHasCustomExe?.(game.id, p.platformId));
      const shouldBeInstalled =
        p.platformId === 'steam' && installedSteamAppIds
          ? Boolean(targetAppId && installedSteamAppIds.has(Number(targetAppId))) || hasCustomExe
          : hasCustomExe;

      if (
        Boolean(p.installed) === shouldBeInstalled &&
        (shouldBeInstalled ||
          (!p.installPath &&
            !p.executablePath &&
            !p.launchArguments &&
            p.isWindowsBinaryOnMac === undefined &&
            p.installSize === undefined))
      ) {
        return p;
      }

      gameChanged = true;
      const updatedP: GamePlatformOwnership = {
        ...p,
        installed: shouldBeInstalled,
      };
      if (!shouldBeInstalled) {
        delete updatedP.installPath;
        delete updatedP.executablePath;
        delete updatedP.launchArguments;
        delete updatedP.isWindowsBinaryOnMac;
        delete updatedP.installSize;
      }
      return updatedP;
    });

    if (!gameChanged) return game;
    anyCatalogChanged = true;
    return { ...game, platforms: nextPlatforms };
  });

  return anyCatalogChanged ? nextGames : games;
}

export function mergeUpdatedGamePreservingLivePlatformState(
  liveGame: CanonicalGame,
  incomingGame: CanonicalGame
): CanonicalGame {
  if (!liveGame) return incomingGame;
  if (!incomingGame) return liveGame;

  const bestEnriched = pickBestEnrichedMetadata(
    liveGame.enrichedMetadata,
    incomingGame.enrichedMetadata
  );
  const enrichedChanged = bestEnriched !== incomingGame.enrichedMetadata;

  if (!Array.isArray(liveGame.platforms) || liveGame.platforms.length === 0) {
    return enrichedChanged ? { ...incomingGame, enrichedMetadata: bestEnriched } : incomingGame;
  }

  const incomingPlatforms = Array.isArray(incomingGame.platforms) ? incomingGame.platforms : [];
  let platformsChanged = false;

  const mergedPlatforms: GamePlatformOwnership[] = incomingPlatforms.map((incPlat) => {
    const livePlat = liveGame.platforms.find((lp) => lp.platformId === incPlat.platformId);
    if (!livePlat) {
      const sanitizedIncOnlySize = sanitizeGameInstallSizeBytes(incPlat.installSize);
      if (incPlat.installSize === sanitizedIncOnlySize) return incPlat;
      platformsChanged = true;
      const cleanedInc: GamePlatformOwnership = { ...incPlat };
      if (sanitizedIncOnlySize !== undefined) {
        cleanedInc.installSize = sanitizedIncOnlySize;
      } else {
        delete cleanedInc.installSize;
      }
      return cleanedInc;
    }

    const nextInstalled = Boolean(livePlat.installed || incPlat.installed);
    const nextInstallPath = nextInstalled
      ? incPlat.installPath || livePlat.installPath
      : undefined;
    const nextExePath = nextInstalled
      ? incPlat.executablePath || livePlat.executablePath
      : undefined;
    const sanitizedIncSize = sanitizeGameInstallSizeBytes(incPlat.installSize);
    const sanitizedLiveSize = sanitizeGameInstallSizeBytes(livePlat.installSize);
    const nextInstallSize = nextInstalled
      ? (sanitizedIncSize ?? sanitizedLiveSize)
      : sanitizedIncSize;
    const nextVersion = nextInstalled
      ? incPlat.version || livePlat.version
      : incPlat.version;
    const nextLaunchArgs = nextInstalled
      ? incPlat.launchArguments || livePlat.launchArguments
      : undefined;
    const nextWinOnMac = nextInstalled
      ? (incPlat.isWindowsBinaryOnMac ?? livePlat.isWindowsBinaryOnMac)
      : undefined;

    const livePlaytime = livePlat.playtimeMinutes ?? 0;
    const incPlaytime = incPlat.playtimeMinutes ?? 0;
    const nextPlaytime =
      livePlat.playtimeMinutes !== undefined || incPlat.playtimeMinutes !== undefined
        ? Math.max(livePlaytime, incPlaytime)
        : undefined;
    const nextLastPlayed =
      livePlat.lastPlayed && incPlat.lastPlayed
        ? livePlat.lastPlayed > incPlat.lastPlayed
          ? livePlat.lastPlayed
          : incPlat.lastPlayed
        : incPlat.lastPlayed || livePlat.lastPlayed;
    const nextAchievements = reconcileAchievementSummaries(
      livePlat.achievements,
      incPlat.achievements,
      {
        title: incomingGame.title || liveGame.title,
        appId: incomingGame.steamAppId || liveGame.steamAppId,
        store: incPlat.platformId,
      }
    );

    const nextXboxProductId = incPlat.xboxProductId || livePlat.xboxProductId;
    const nextPfn = incPlat.packageFamilyName || livePlat.packageFamilyName;
    const nextAumid = incPlat.appUserModelId || livePlat.appUserModelId;
    const nextXboxTitleId = incPlat.xboxTitleId || livePlat.xboxTitleId;
    const nextScid = incPlat.scid || livePlat.scid;
    const nextMsaAppId = incPlat.msaAppId || livePlat.msaAppId;

    const authXboxOwnershipPlat =
      incPlat.platformId === 'xbox'
        ? livePlat.ownershipType !== undefined
          ? livePlat
          : incPlat
        : undefined;
    const nextOwnershipType: XboxOwnershipType | undefined = authXboxOwnershipPlat
      ? authXboxOwnershipPlat.ownershipType
      : livePlat.ownershipType ?? incPlat.ownershipType;
    const nextGamePassTier: string | undefined = authXboxOwnershipPlat
      ? nextOwnershipType === 'owned'
        ? undefined
        : authXboxOwnershipPlat.gamePassTier || undefined
      : livePlat.gamePassTier ?? incPlat.gamePassTier;
    const nextSubscriptionExpired: boolean | undefined = authXboxOwnershipPlat
      ? nextOwnershipType === 'owned'
        ? false
        : nextOwnershipType === 'owned_and_subscription'
        ? authXboxOwnershipPlat.subscriptionExpired === false
          ? false
          : undefined
        : authXboxOwnershipPlat.subscriptionExpired
        ? true
        : authXboxOwnershipPlat.subscriptionExpired === false
        ? false
        : undefined
      : livePlat.subscriptionExpired ?? incPlat.subscriptionExpired;
    const nextIsLeavingSoon: boolean | undefined = authXboxOwnershipPlat
      ? nextOwnershipType === 'owned' || nextSubscriptionExpired
        ? undefined
        : Boolean(authXboxOwnershipPlat.isLeavingSoon) || undefined
      : livePlat.isLeavingSoon ?? incPlat.isLeavingSoon;
    const nextIsRecentlyAddedToGamePass: boolean | undefined = authXboxOwnershipPlat
      ? nextOwnershipType === 'owned' || nextSubscriptionExpired
        ? undefined
        : Boolean(authXboxOwnershipPlat.isRecentlyAddedToGamePass) || undefined
      : livePlat.isRecentlyAddedToGamePass ?? incPlat.isRecentlyAddedToGamePass;

    if (
      Boolean(incPlat.installed) === nextInstalled &&
      incPlat.installPath === nextInstallPath &&
      incPlat.executablePath === nextExePath &&
      incPlat.installSize === nextInstallSize &&
      incPlat.version === nextVersion &&
      incPlat.launchArguments === nextLaunchArgs &&
      incPlat.isWindowsBinaryOnMac === nextWinOnMac &&
      incPlat.playtimeMinutes === nextPlaytime &&
      incPlat.lastPlayed === nextLastPlayed &&
      incPlat.achievements === nextAchievements &&
      incPlat.xboxProductId === nextXboxProductId &&
      incPlat.packageFamilyName === nextPfn &&
      incPlat.appUserModelId === nextAumid &&
      incPlat.xboxTitleId === nextXboxTitleId &&
      incPlat.scid === nextScid &&
      incPlat.msaAppId === nextMsaAppId &&
      incPlat.ownershipType === nextOwnershipType &&
      incPlat.gamePassTier === nextGamePassTier &&
      incPlat.subscriptionExpired === nextSubscriptionExpired &&
      incPlat.isLeavingSoon === nextIsLeavingSoon &&
      incPlat.isRecentlyAddedToGamePass === nextIsRecentlyAddedToGamePass
    ) {
      return incPlat;
    }

    platformsChanged = true;
    const mergedP: GamePlatformOwnership = {
      ...incPlat,
      installed: nextInstalled,
      ...(nextPlaytime !== undefined ? { playtimeMinutes: nextPlaytime } : {}),
      ...(nextLastPlayed !== undefined ? { lastPlayed: nextLastPlayed } : {}),
      ...(nextAchievements !== undefined ? { achievements: nextAchievements } : {}),
      ...(nextXboxProductId !== undefined ? { xboxProductId: nextXboxProductId } : {}),
      ...(nextPfn !== undefined ? { packageFamilyName: nextPfn } : {}),
      ...(nextAumid !== undefined ? { appUserModelId: nextAumid } : {}),
      ...(nextXboxTitleId !== undefined ? { xboxTitleId: nextXboxTitleId } : {}),
      ...(nextScid !== undefined ? { scid: nextScid } : {}),
      ...(nextMsaAppId !== undefined ? { msaAppId: nextMsaAppId } : {}),
      ...(incPlat.platformId === 'xbox'
        ? {
            ownershipType: nextOwnershipType,
            gamePassTier: nextGamePassTier,
            subscriptionExpired: nextSubscriptionExpired,
            isLeavingSoon: nextIsLeavingSoon,
            isRecentlyAddedToGamePass: nextIsRecentlyAddedToGamePass,
          }
        : {
            ...(nextOwnershipType !== undefined ? { ownershipType: nextOwnershipType } : {}),
            ...(nextGamePassTier !== undefined ? { gamePassTier: nextGamePassTier } : {}),
            ...(nextSubscriptionExpired !== undefined
              ? { subscriptionExpired: nextSubscriptionExpired }
              : {}),
            ...(nextIsLeavingSoon !== undefined ? { isLeavingSoon: nextIsLeavingSoon } : {}),
            ...(nextIsRecentlyAddedToGamePass !== undefined
              ? { isRecentlyAddedToGamePass: nextIsRecentlyAddedToGamePass }
              : {}),
          }),
    };
    if (nextInstalled) {
      if (nextInstallPath !== undefined) mergedP.installPath = nextInstallPath;
      if (nextExePath !== undefined) mergedP.executablePath = nextExePath;
      if (nextInstallSize !== undefined) {
        mergedP.installSize = nextInstallSize;
      } else {
        delete mergedP.installSize;
      }
      if (nextVersion !== undefined) mergedP.version = nextVersion;
      if (nextLaunchArgs !== undefined) mergedP.launchArguments = nextLaunchArgs;
      if (nextWinOnMac !== undefined) mergedP.isWindowsBinaryOnMac = nextWinOnMac;
    } else {
      delete mergedP.installPath;
      delete mergedP.executablePath;
      delete mergedP.launchArguments;
      delete mergedP.isWindowsBinaryOnMac;
      if (nextInstallSize !== undefined) {
        mergedP.installSize = nextInstallSize;
      } else {
        delete mergedP.installSize;
      }
    }
    return mergedP;
  });

  for (const livePlat of liveGame.platforms) {
    if (!mergedPlatforms.some((mp) => mp.platformId === livePlat.platformId)) {
      mergedPlatforms.push(livePlat);
      platformsChanged = true;
    }
  }

  if (!platformsChanged && !enrichedChanged) {
    return incomingGame;
  }

  return {
    ...incomingGame,
    ...(platformsChanged ? { platforms: mergedPlatforms } : {}),
    ...(enrichedChanged ? { enrichedMetadata: bestEnriched } : {}),
  };
}

export function mergeHydratedCatalogPreservingLiveState(
  liveGames: CanonicalGame[],
  hydratedGames: CanonicalGame[]
): CanonicalGame[] {
  if (!Array.isArray(hydratedGames) || hydratedGames.length === 0) return liveGames;
  if (!Array.isArray(liveGames) || liveGames.length === 0) return hydratedGames;

  const liveById = new Map<string, CanonicalGame>();
  const liveBySteamAppId = new Map<number, CanonicalGame>();
  const liveByPlatKey = new Map<string, CanonicalGame>();

  for (const lg of liveGames) {
    if (!lg) continue;
    if (lg.id) liveById.set(lg.id, lg);
    if (lg.steamAppId) liveBySteamAppId.set(lg.steamAppId, lg);
    for (const lp of lg.platforms || []) {
      const normId = normalizePlatformGameIdForLookup(lp.platformGameId || lp.storefrontAppId);
      if (normId) {
        liveByPlatKey.set(`${lp.platformId}:${normId}`, lg);
      }
      if (lp.platformId === 'xbox') {
        const xBig = normalizePlatformGameIdForLookup(lp.xboxProductId);
        const xPfn = String(lp.packageFamilyName || '').trim().toLowerCase();
        if (xBig) liveByPlatKey.set(`xbox:${xBig}`, lg);
        if (xPfn) liveByPlatKey.set(`xbox:${xPfn}`, lg);
      }
    }
  }

  const matchedLiveIds = new Set<string>();
  const merged = hydratedGames.map((hg) => {
    let liveMatch = hg.id ? liveById.get(hg.id) : undefined;
    if (!liveMatch && hg.steamAppId) {
      liveMatch = liveBySteamAppId.get(hg.steamAppId);
    }
    if (!liveMatch) {
      for (const hp of hg.platforms || []) {
        const normId = normalizePlatformGameIdForLookup(hp.platformGameId || hp.storefrontAppId);
        if (normId) {
          const cand = liveByPlatKey.get(`${hp.platformId}:${normId}`);
          if (cand) {
            liveMatch = cand;
            break;
          }
        }
        if (hp.platformId === 'xbox') {
          const xBig = normalizePlatformGameIdForLookup(hp.xboxProductId);
          const xPfn = String(hp.packageFamilyName || '').trim().toLowerCase();
          const cand =
            (xBig ? liveByPlatKey.get(`xbox:${xBig}`) : undefined) ||
            (xPfn ? liveByPlatKey.get(`xbox:${xPfn}`) : undefined);
          if (cand) {
            liveMatch = cand;
            break;
          }
        }
      }
    }
    if (!liveMatch) return hg;
    if (liveMatch.id) matchedLiveIds.add(liveMatch.id);
    return mergeUpdatedGamePreservingLivePlatformState(liveMatch, hg);
  });

  // Pre-index merged catalog in O(N) so live delta reconciliation runs in O(1) per game
  const mergedSteamAppIds = new Set<number>();
  const mergedPlatformKeys = new Set<string>();
  const indexGameIntoMergedSets = (g: CanonicalGame) => {
    if (g.steamAppId && g.steamAppId > 0) {
      mergedSteamAppIds.add(g.steamAppId);
    }
    for (const mp of g.platforms || []) {
      const normId = normalizePlatformGameIdForLookup(mp.platformGameId || mp.storefrontAppId);
      if (normId) {
        mergedPlatformKeys.add(`${mp.platformId}:${normId}`);
      }
      if (mp.platformId === 'xbox') {
        const xBig = normalizePlatformGameIdForLookup(mp.xboxProductId);
        const xPfn = String(mp.packageFamilyName || '').trim().toLowerCase();
        if (xBig) mergedPlatformKeys.add(`xbox:${xBig}`);
        if (xPfn) mergedPlatformKeys.add(`xbox:${xPfn}`);
      }
    }
  };
  for (const m of merged) {
    if (m) indexGameIntoMergedSets(m);
  }

  // Preserve any newly discovered local games added to liveGames before hydration resolved
  for (const lg of liveGames) {
    if (!lg || (lg.id && matchedLiveIds.has(lg.id))) continue;
    const alreadyInHydrated =
      Boolean(lg.steamAppId && mergedSteamAppIds.has(lg.steamAppId)) ||
      (lg.platforms || []).some((lp) => {
        const normId = normalizePlatformGameIdForLookup(lp.platformGameId || lp.storefrontAppId);
        if (normId && mergedPlatformKeys.has(`${lp.platformId}:${normId}`)) {
          return true;
        }
        if (lp.platformId === 'xbox') {
          const xBig = normalizePlatformGameIdForLookup(lp.xboxProductId);
          const xPfn = String(lp.packageFamilyName || '').trim().toLowerCase();
          if ((xBig && mergedPlatformKeys.has(`xbox:${xBig}`)) || (xPfn && mergedPlatformKeys.has(`xbox:${xPfn}`))) {
            return true;
          }
        }
        return false;
      });
    if (!alreadyInHydrated) {
      merged.push(lg);
      indexGameIntoMergedSets(lg);
    }
  }

  return merged;
}

export const mergeSyncedGamesIntoCatalog = mergeStorefrontGames;

export function removeStorefrontGames(
  currentCatalog: CanonicalGame[],
  storefrontId: StorefrontId
): CanonicalGame[] {
  clearVerifiedUserEntitlements(storefrontId);
  const remaining: CanonicalGame[] = [];

  for (const game of currentCatalog) {
    const updatedPlatforms = game.platforms.filter((p) => p.platformId !== storefrontId);
    if (updatedPlatforms.length > 0) {
      remaining.push({
        ...game,
        platforms: updatedPlatforms,
      });
    }
  }

  return remaining.sort((a, b) => BASE_TITLE_COLLATOR.compare(a.title, b.title));
}

/**
 * Connect Steam account via Web API / ID / Profile URL without requiring any installed Steam client
 */
export async function connectSteamIntegration(
  credentials: StorefrontCredentials
): Promise<{ integration: StorefrontIntegration; games: CanonicalGame[] }> {
  const { profile, games: steamGames } = await steamIntegration.fetchOwnedGames(credentials);

  const integration: StorefrontIntegration = {
    storefrontId: 'steam',
    name: 'Steam',
    isConnected: true,
    accountName: profile.personaName,
    accountId: profile.steamId,
    avatarUrl: profile.avatarUrl,
    gamesCount: steamGames.length,
    lastSyncedAt: new Date().toISOString(),
    authMethod: credentials.apiKey ? 'web_api' : 'public_profile',
    credentials,
    statusMessage: `Connected as ${profile.personaName} (${steamGames.length} games synced)`,
  };

  const current = loadCurrentCatalog();
  const merged = mergeStorefrontGames(current, steamGames, 'steam');

  const integrations = loadIntegrations().map((i) =>
    i.storefrontId === 'steam' ? integration : i
  );
  saveIntegrations(integrations);
  saveCurrentCatalog(merged);

  return { integration, games: merged };
}

/**
 * Connect GOG account via OAuth / Token / Username
 */
export async function connectGogIntegration(
  credentials: StorefrontCredentials
): Promise<{ integration: StorefrontIntegration; games: CanonicalGame[] }> {
  const { accountName, avatarUrl, games: gogGames } = await gogIntegration.connectAccount(credentials);

  const integration: StorefrontIntegration = {
    storefrontId: 'gog',
    name: 'GOG.com',
    isConnected: true,
    accountName,
    avatarUrl,
    gamesCount: gogGames.length,
    lastSyncedAt: new Date().toISOString(),
    authMethod: credentials.gogToken ? 'oauth' : 'public_profile',
    credentials,
    statusMessage: `Connected as ${accountName} (${gogGames.length} GOG titles synced)`,
  };

  const current = loadCurrentCatalog();
  const merged = mergeStorefrontGames(current, gogGames, 'gog');

  const integrations = loadIntegrations().map((i) =>
    i.storefrontId === 'gog' ? integration : i
  );
  saveIntegrations(integrations);
  saveCurrentCatalog(merged);

  return { integration, games: merged };
}

/**
 * Connect Epic Games Store account
 */
export async function connectEpicIntegration(
  credentials: StorefrontCredentials
): Promise<{ integration: StorefrontIntegration; games: CanonicalGame[] }> {
  const cleanAccountId = epicIntegration.extractEpicAccountId(credentials.epicAccountId);
  const normalizedCredentials = {
    ...credentials,
    epicAccountId: cleanAccountId || credentials.epicAccountId,
  };
  const { accountName, avatarUrl, games: epicGames, updatedCredentials } = await epicIntegration.connectAccount(normalizedCredentials);
  const finalCredentials = updatedCredentials || normalizedCredentials;

  const integration: StorefrontIntegration = {
    storefrontId: 'epic',
    name: 'Epic Games Store',
    isConnected: true,
    accountName,
    accountId: cleanAccountId || undefined,
    avatarUrl,
    gamesCount: epicGames.length,
    lastSyncedAt: new Date().toISOString(),
    authMethod: (finalCredentials.epicToken || finalCredentials.epicRefreshToken) ? 'oauth' : 'public_profile',
    credentials: finalCredentials,
    statusMessage: (finalCredentials.epicToken || finalCredentials.epicRefreshToken)
      ? `Connected as ${accountName} (${epicGames.length} Epic titles synced)`
      : `Cached Baseline (${epicGames.length} Epic titles cataloged)`,
  };

  const current = loadCurrentCatalog();
  const merged = mergeStorefrontGames(current, epicGames, 'epic');

  const integrations = loadIntegrations().map((i) =>
    i.storefrontId === 'epic' ? integration : i
  );
  saveIntegrations(integrations);
  saveCurrentCatalog(merged);

  return { integration, games: merged };
}

/**
 * Connect Xbox / Microsoft Store / Game Pass account
 */
export async function connectXboxIntegration(
  credentials: StorefrontCredentials & { syncMode?: XboxGamePassSyncMode }
): Promise<{ integration: StorefrontIntegration; games: CanonicalGame[] }> {
  const syncRes = await xboxIntegration.syncXboxAccount(credentials);
  const {
    accountName,
    gamertag,
    modernGamertag,
    xuid,
    avatarUrl,
    gamerscore,
    subscription,
    syncMode,
    games: xboxGames,
    achievements,
  } = syncRes;

  if (achievements && typeof achievements === 'object' && Object.keys(achievements).length > 0) {
    cacheUserXboxAchievements(achievements);
  }

  const syncedAt = new Date().toISOString();
  saveXboxProfileState({
    connected: true,
    gamertag: gamertag || accountName,
    modernGamertag: modernGamertag || gamertag || accountName,
    xuid,
    avatarUrl,
    gamerscore,
    subscription: subscription ?? null,
    syncMode: syncMode || credentials?.syncMode,
    lastSyncedAt: syncedAt,
  });

  // Never persist raw OAuth codes or XSTS tokens in localStorage credentials
  const { webToken: _wt, syncMode: _sm, ...safeCredentials } = credentials || {};

  const displayGamertag = modernGamertag || gamertag || accountName;
  const tierSuffix =
    subscription?.hasActiveSubscription && subscription.tierDisplayName
      ? ` · ${subscription.tierDisplayName}`
      : '';

  const integration: StorefrontIntegration = {
    storefrontId: 'xbox',
    name: 'Xbox',
    isConnected: true,
    accountName: displayGamertag,
    accountId: xuid || undefined,
    avatarUrl,
    gamesCount: xboxGames.length,
    lastSyncedAt: syncedAt,
    authMethod: 'oauth',
    credentials: safeCredentials,
    statusMessage: `Connected as ${displayGamertag}${tierSuffix} (${xboxGames.length} Xbox titles synced)`,
  };

  const current = loadCurrentCatalog();
  const merged = mergeStorefrontGames(current, xboxGames, 'xbox');

  const integrations = loadIntegrations().map((i) =>
    i.storefrontId === 'xbox' ? integration : i
  );
  saveIntegrations(integrations);
  saveCurrentCatalog(merged);

  return { integration, games: merged };
}

/**
 * Disconnect an integration and remove its platform presence from the library
 */
export function disconnectIntegration(
  storefrontId: StorefrontId
): { integrations: StorefrontIntegration[]; games: CanonicalGame[] } {
  if (storefrontId === 'xbox') {
    clearXboxProfileState();
  }
  if (typeof window !== 'undefined') {
    if (window.electronAPI?.clearTokens) {
      try {
        window.electronAPI.clearTokens(storefrontId);
      } catch (err) {
        console.warn(`Failed to clear tokens for ${storefrontId}:`, err);
      }
    }
    if (window.electronAPI?.disconnectStore) {
      try {
        void window.electronAPI.disconnectStore(storefrontId)?.catch?.(() => {});
      } catch (err) {
        console.warn(`Failed to disconnect store ${storefrontId}:`, err);
      }
    }
  }
  const integrations = loadIntegrations().map((i) => {
    if (i.storefrontId === storefrontId) {
      return {
        ...i,
        isConnected: false,
        accountName: undefined,
        accountId: undefined,
        avatarUrl: undefined,
        gamesCount: 0,
        lastSyncedAt: undefined,
        credentials: undefined,
        statusMessage: 'Disconnected',
      };
    }
    return i;
  });

  const current = loadCurrentCatalog();
  const updatedGames = removeStorefrontGames(current, storefrontId);

  saveIntegrations(integrations);
  saveCurrentCatalog(updatedGames);

  return { integrations, games: updatedGames };
}
