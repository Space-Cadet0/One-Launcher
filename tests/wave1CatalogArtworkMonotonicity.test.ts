import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import type { CanonicalGame } from '../src/contracts/game';
import type { SteamEnrichedMetadata } from '../src/contracts/steam';
import {
  ArtworkAuthorityRank,
  getCapsuleAuthorityRank,
  getHeaderAuthorityRank,
  reconcileCapsuleImage,
  reconcileHeaderImage,
} from '../src/services/storage/metadataReconciliation';
import {
  pickPreferredCapsuleImage,
  pickPreferredHeaderImage,
} from '../src/services/storage/librarySync';
import {
  igdbCoverService,
  isDeadSteamCoverUrl,
  isExpiredDeadSteamUnhashed,
  isKnownDeadSteamCover,
  isUnsuitableCoverUrl,
  KNOWN_DEAD_STEAM_COVER_APP_IDS,
  scheduleExpiredDeadSteamReprobe,
} from '../src/services/igdb/igdbCoverService';
import { runIntelligentNonSteamMatchPass } from '../src/utils/catalogMergeUtils';
import {
  flushPendingCatalogSave,
  hydrateCatalogFromIndexedDb,
  mergeHydratedCatalogPreservingLiveState,
  mergeStorefrontGames,
  saveCurrentCatalog,
  slimGameForLocalStorageQuota,
} from '../src/services/integrations/integrationStorage';
import { sanitizeGameCatalog } from '../src/services/integrations/catalogSanitizer';
import { epicIntegration } from '../src/services/integrations/epicIntegration';
import { fallbackMetadataProvider } from '../src/services/steam/fallbackMetadataProvider';
import { SteamMatcherService, steamMatcher } from '../src/services/steam/steamMatcher';
import { SteamApiService, steamApi } from '../src/services/steam/steamApi';
import * as indexedDbVault from '../src/services/storage/indexedDbVault';
import { markScrollActivity } from '../src/utils/scrollActivityTracker';
import {
  clearStagedMemoryFallback,
  hydrateAllStagedCacheFromVault,
  loadStagedCache,
  STAGED_CACHE_VERSION,
} from '../src/services/storage/stagedCacheService';

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string): string | null {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

function makeSyntheticGame(overrides: Partial<CanonicalGame> = {}): CanonicalGame {
  const id = overrides.id ?? 'steam-910001';
  const title = overrides.title ?? 'Synthetic Nebula Chronicles';
  return {
    id,
    title,
    sortTitle: title,
    isVerifiedEntitlement: true,
    platforms: [
      {
        platformId: 'steam',
        platformGameId: '910001',
        installed: false,
        playtimeMinutes: 0,
      },
    ],
    headerImage:
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/910001/header.jpg?t=1710000000',
    capsuleImage:
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/910001/library_600x900_2x.jpg?t=1710000000',
    shortDescription: 'A synthetic strategy adventure built for Wave 1 monotonicity verification.',
    releaseDate: '2022-05-12',
    developers: ['Synthetic Foundry'],
    publishers: ['Synthetic Interactive'],
    genres: ['Strategy', 'RPG'],
    tags: ['Singleplayer', 'Tactical'],
    ...overrides,
  };
}

interface MockIdbRequest<T> {
  result: T;
  error: Error | null;
  onsuccess: ((ev: { target: MockIdbRequest<T> }) => void) | null;
  onerror: ((ev: { target: MockIdbRequest<T> }) => void) | null;
  onupgradeneeded?: ((ev: { target: MockIdbRequest<T> }) => void) | null;
}

function createTrackingIndexedDbFactory(seedEntries: Record<string, unknown>) {
  const kv = new Map<IDBValidKey, unknown>(Object.entries(seedEntries));
  const readKeys: IDBValidKey[] = [];
  let getAllKeysCalls = 0;
  let getAllCalls = 0;

  const makeReq = <T,>(compute: () => T): MockIdbRequest<T> => {
    const req: MockIdbRequest<T> = {
      result: undefined as unknown as T,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => {
      try {
        req.result = compute();
        req.onsuccess?.({ target: req });
      } catch (err) {
        req.error = err instanceof Error ? err : new Error(String(err));
        req.onerror?.({ target: req });
      }
    });
    return req;
  };

  const factory: IDBFactory = {
    open(_name: string) {
      const dbObj = {
        objectStoreNames: {
          contains: (storeName: string) => storeName === 'kv',
        },
        createObjectStore: () => ({}),
        transaction: () => ({
          objectStore: () => ({
            get(key: IDBValidKey) {
              readKeys.push(key);
              return makeReq(() => kv.get(key));
            },
            getAllKeys() {
              getAllKeysCalls++;
              return makeReq(() => Array.from(kv.keys()));
            },
            getAll() {
              getAllCalls++;
              return makeReq(() => Array.from(kv.values()));
            },
          }),
        }),
        close() {},
      };
      const openReq: MockIdbRequest<typeof dbObj> = {
        result: dbObj,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        openReq.onsuccess?.({ target: openReq });
      });
      return openReq as unknown as IDBOpenDBRequest;
    },
    deleteDatabase: vi.fn(),
    cmp: vi.fn(),
    databases: vi.fn(async () => []),
  };

  return {
    factory,
    readKeys,
    getGetAllKeysCalls: () => getAllKeysCalls,
    getGetAllCalls: () => getAllCalls,
  };
}

describe('Wave 1 — Catalog, Artwork Monotonicity, Dead-Steam Isolation & Storage Hardening', () => {
  let memStorage: Storage;
  let originalWindow: typeof globalThis.window | undefined;
  let originalLocalStorage: Storage | undefined;
  let originalIndexedDb: IDBFactory | undefined;
  let originalFetch: typeof globalThis.fetch | undefined;
  let winEvents: EventTarget;

  beforeEach(() => {
    memStorage = createMemoryStorage();
    winEvents = new EventTarget();
    originalWindow = globalThis.window;
    originalLocalStorage = globalThis.localStorage;
    originalIndexedDb = globalThis.indexedDB;
    originalFetch = globalThis.fetch;

    Object.defineProperty(globalThis, 'localStorage', {
      value: memStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: {
        localStorage: memStorage,
        location: { hostname: 'localhost', port: '5173', protocol: 'http:' },
        addEventListener: winEvents.addEventListener.bind(winEvents),
        removeEventListener: winEvents.removeEventListener.bind(winEvents),
        dispatchEvent: winEvents.dispatchEvent.bind(winEvents),
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    igdbCoverService.clearCache();
    KNOWN_DEAD_STEAM_COVER_APP_IDS.clear();
    clearStagedMemoryFallback();
  });

  afterEach(() => {
    flushPendingCatalogSave();
    vi.restoreAllMocks();
    vi.useRealTimers();
    igdbCoverService.clearCache();
    KNOWN_DEAD_STEAM_COVER_APP_IDS.clear();
    clearStagedMemoryFallback();

    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'indexedDB', {
      value: originalIndexedDb,
      writable: true,
      configurable: true,
    });
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    }
  });

  describe('1. Monotonic ArtworkAuthorityRank Engine (metadataReconciliation.ts & librarySync.ts)', () => {
    const sha1A = '0123456789abcdef0123456789abcdef01234567';
    const sha1B = 'fedcba9876543210fedcba9876543210fedcba98';
    const steamUnhashed1x =
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/910001/library_600x900.jpg';
    const steamUnhashed2x =
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/910001/library_600x900_2x.jpg';
    const steamTimestamped =
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/910001/library_600x900_2x.jpg?t=1715000000';
    const steamHashed2x = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/910001/${sha1A}/library_capsule_2x.jpg`;
    const steamHashed2xNew = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/910001/${sha1B}/library_capsule_2x.jpg`;
    const gogVertical =
      'https://images.gog-statics.com/synth910001_product_boxart_vertical_600x900.jpg';
    const epicTall =
      'https://cdn1.epicgames.com/offer/synth910001/EGS_SynthQuest_OfferImageTall.jpg';
    const xboxBoxArt =
      'https://store-images.s-microsoft.com/image/apps.910001.boxart.jpg?w=600&h=900';
    const igdbCover = 'https://images.igdb.com/igdb/image/upload/t_cover_big/co910001.jpg';
    const localPortrait = 'ol-media://covers/steam-910001.webp';
    const userOverrideUrl = 'https://cdn.example.com/custom-override-cover.jpg';
    const steamUnhashedHeader =
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/910001/header.jpg';
    const steamTimestampedHeader =
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/910001/header.jpg?t=1715000000';
    const gogCroppedHorizontal =
      'https://images.gog-statics.com/synth910001_glx_vertical_cover.jpg';

    it('assigns strictly monotonic 0..6 authority ranks for capsules and headers', () => {
      expect(getCapsuleAuthorityRank('')).toBe(ArtworkAuthorityRank.EMPTY);
      expect(getCapsuleAuthorityRank(undefined)).toBe(ArtworkAuthorityRank.EMPTY);
      expect(getCapsuleAuthorityRank(steamUnhashedHeader)).toBe(
        ArtworkAuthorityRank.UNSUITABLE_OR_LANDSCAPE
      );
      expect(getCapsuleAuthorityRank(gogCroppedHorizontal)).toBe(
        ArtworkAuthorityRank.UNSUITABLE_OR_LANDSCAPE
      );
      expect(getCapsuleAuthorityRank(steamUnhashed2x)).toBe(
        ArtworkAuthorityRank.STEAM_UNHASHED_GUESS
      );
      expect(getCapsuleAuthorityRank(igdbCover)).toBe(ArtworkAuthorityRank.IGDB_VERIFIED_2X3);
      expect(getCapsuleAuthorityRank(steamTimestamped)).toBe(
        ArtworkAuthorityRank.STOREFRONT_VERIFIED_2X3
      );
      expect(getCapsuleAuthorityRank(steamHashed2x)).toBe(
        ArtworkAuthorityRank.STOREFRONT_VERIFIED_2X3
      );
      expect(getCapsuleAuthorityRank(gogVertical)).toBe(
        ArtworkAuthorityRank.STOREFRONT_VERIFIED_2X3
      );
      expect(getCapsuleAuthorityRank(epicTall)).toBe(
        ArtworkAuthorityRank.STOREFRONT_VERIFIED_2X3
      );
      expect(getCapsuleAuthorityRank(xboxBoxArt)).toBe(
        ArtworkAuthorityRank.STOREFRONT_VERIFIED_2X3
      );
      expect(getCapsuleAuthorityRank(localPortrait)).toBe(
        ArtworkAuthorityRank.VERIFIED_LOCAL_PORTRAIT
      );
      expect(
        getCapsuleAuthorityRank(userOverrideUrl, { userOverrideCapsule: userOverrideUrl })
      ).toBe(ArtworkAuthorityRank.USER_OVERRIDE);

      expect(getHeaderAuthorityRank('')).toBe(ArtworkAuthorityRank.EMPTY);
      expect(getHeaderAuthorityRank(steamUnhashedHeader)).toBe(
        ArtworkAuthorityRank.STEAM_UNHASHED_GUESS
      );
      expect(getHeaderAuthorityRank(steamTimestampedHeader)).toBe(
        ArtworkAuthorityRank.STOREFRONT_VERIFIED_2X3
      );
      expect(
        getHeaderAuthorityRank(userOverrideUrl, { userOverrideHeader: userOverrideUrl })
      ).toBe(ArtworkAuthorityRank.USER_OVERRIDE);
    });

    it('enforces Hard Invariant 1 (Non-Downgrade) and equal-rank upgrades across capsules and headers', () => {
      // Rank 2 synthetic unhashed Steam NEVER overwrites Rank 3+ verified art
      expect(reconcileCapsuleImage(gogVertical, steamUnhashed2x)).toBe(gogVertical);
      expect(reconcileCapsuleImage(epicTall, steamUnhashed2x)).toBe(epicTall);
      expect(reconcileCapsuleImage(igdbCover, steamUnhashed2x)).toBe(igdbCover);
      expect(reconcileCapsuleImage(steamTimestamped, steamUnhashed2x)).toBe(steamTimestamped);
      expect(reconcileCapsuleImage(steamHashed2x, steamUnhashed2x)).toBe(steamHashed2x);
      expect(reconcileCapsuleImage(localPortrait, steamHashed2x)).toBe(localPortrait);
      expect(
        reconcileCapsuleImage(steamHashed2x, gogVertical, { userOverrideCapsule: userOverrideUrl })
      ).toBe(userOverrideUrl);

      // Headers: Rank 2 unhashed Steam header NEVER overwrites Rank 4 timestamped/GOG header
      expect(reconcileHeaderImage(steamTimestampedHeader, steamUnhashedHeader)).toBe(
        steamTimestampedHeader
      );
      expect(pickPreferredHeaderImage(gogVertical, steamUnhashedHeader)).toBe(gogVertical);

      // Equal rank >= 3 upgrades: SHA1 > ?t=, Steam > MS Store CDN, fresh same-storefront flows cleanly
      expect(pickPreferredCapsuleImage(steamTimestamped, steamHashed2x)).toBe(steamHashed2x);
      expect(pickPreferredCapsuleImage(steamHashed2x, steamTimestamped)).toBe(steamHashed2x);
      expect(pickPreferredCapsuleImage(xboxBoxArt, steamHashed2x)).toBe(steamHashed2x);
      expect(pickPreferredCapsuleImage(steamHashed2x, xboxBoxArt)).toBe(steamHashed2x);
      expect(pickPreferredCapsuleImage(steamHashed2x, steamHashed2xNew)).toBe(steamHashed2xNew);

      // Equal rank 2: _2x beats 1x
      expect(pickPreferredCapsuleImage(steamUnhashed1x, steamUnhashed2x)).toBe(steamUnhashed2x);
    });

    it('enforces Hard Invariant 2 (Non-Erasure with synchronous userOverride -> GOG -> IGDB recovery)', () => {
      const deadAppId = 910999;
      igdbCoverService.recordDeadSteamCover(deadAppId);
      const deadSteamUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${deadAppId}/library_600x900_2x.jpg`;

      // Seed both GOG vertical boxart cache and IGDB verified cover cache via persistent storage
      memStorage.setItem(
        'antigravity_gog_boxart_v1',
        JSON.stringify({
          'id:1809000001': gogVertical,
          'title:synthetic relic two': gogVertical,
        })
      );
      memStorage.setItem(
        'antigravity_igdb_covers_v2',
        JSON.stringify({
          'synthetic igdb only': igdbCover,
        })
      );
      (igdbCoverService as unknown as { loadPersistentCache: () => void }).loadPersistentCache();

      // 1) User override wins first
      expect(
        reconcileCapsuleImage(deadSteamUrl, '', {
          gameId: 'gog-1809000001',
          title: 'Synthetic Relic Two',
          gogId: '1809000001',
          steamAppId: deadAppId,
          userOverrideCapsule: userOverrideUrl,
        })
      ).toBe(userOverrideUrl);

      // 2) GOG vertical cover recovers synchronously when existing became dead & incoming is empty
      expect(
        reconcileCapsuleImage(deadSteamUrl, '', {
          gameId: 'gog-1809000001',
          title: 'Synthetic Relic Two',
          gogId: '1809000001',
          steamAppId: deadAppId,
        })
      ).toBe(gogVertical);

      // 3) IGDB verified cover recovers synchronously when no GOG boxart exists
      expect(
        reconcileCapsuleImage(deadSteamUrl, undefined, {
          gameId: 'gog-1809000002',
          title: 'Synthetic Igdb Only',
          steamAppId: deadAppId,
        })
      ).toBe(igdbCover);
    });
  });

  describe('2. End-to-End Stage 1 + Stage 2 + Stage 3 Self-Heal & Zero 16:9 Landscape Leakage', () => {
    it('prevents Stage 1 downgrade, prevents Stage 2 erasure, and heals Stage 3 pre-corrupted GOG capsules', () => {
      const deadSteamId = 920088;
      const gogId = '1809200088';
      const title = 'Synthetic Ocean Two Remastered';
      const gogVerticalUrl =
        'https://images.gog-statics.com/synth_ocean_two_vertical_boxart_600x900.jpg';
      const gogHeaderUrl =
        'https://images.gog-statics.com/synth_ocean_two_background_1920x1080.jpg';

      // Seed dead unhashed Steam cover + cached GOG vertical boxart
      igdbCoverService.recordDeadSteamCover(deadSteamId);
      memStorage.setItem(
        'antigravity_gog_boxart_v1',
        JSON.stringify({
          [`id:${gogId}`]: gogVerticalUrl,
          'title:synthetic ocean two remastered': gogVerticalUrl,
        })
      );
      (igdbCoverService as unknown as { loadPersistentCache: () => void }).loadPersistentCache();

      // Stage 1: runIntelligentNonSteamMatchPass must NEVER overwrite valid GOG art or synthesize dead Steam cover
      const gogGameStage1 = makeSyntheticGame({
        id: `gog-${gogId}`,
        title,
        steamAppId: undefined,
        platforms: [
          { platformId: 'gog', platformGameId: gogId, installed: false, playtimeMinutes: 0 },
        ],
        headerImage: gogHeaderUrl,
        capsuleImage: gogVerticalUrl,
      });

      const matchSpy = vi
        .spyOn(steamMatcher, 'getEffectiveSteamAppId')
        .mockReturnValue(deadSteamId);
      const afterStage1 = runIntelligentNonSteamMatchPass([gogGameStage1]);
      expect(afterStage1[0].steamAppId).toBe(deadSteamId);
      expect(afterStage1[0].capsuleImage).toBe(gogVerticalUrl);
      expect(afterStage1[0].headerImage).toBe(gogHeaderUrl);

      // Even if a GOG game started with NO capsuleImage, Stage 1 must NOT synthesize a dead Steam URL
      const gogMissingCoverStage1 = makeSyntheticGame({
        id: `gog-${gogId}`,
        title,
        steamAppId: undefined,
        platforms: [
          { platformId: 'gog', platformGameId: gogId, installed: false, playtimeMinutes: 0 },
        ],
        headerImage: gogHeaderUrl,
        capsuleImage: '',
      });
      const afterStage1Missing = runIntelligentNonSteamMatchPass([gogMissingCoverStage1]);
      expect(afterStage1Missing[0].capsuleImage).toBe(gogVerticalUrl);
      matchSpy.mockRestore();

      // Stage 2: mergeStorefrontGames with empty incoming capsuleImage must NEVER erase existing or leave dead cover unhealed
      const existingDeadCard = makeSyntheticGame({
        id: `steam-${deadSteamId}`,
        title,
        steamAppId: deadSteamId,
        platforms: [
          { platformId: 'gog', platformGameId: gogId, installed: false, playtimeMinutes: 0 },
        ],
        headerImage: gogHeaderUrl,
        capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${deadSteamId}/library_600x900_2x.jpg`,
      });
      const incomingEmptyCapsule = makeSyntheticGame({
        id: `gog-${gogId}`,
        title,
        platforms: [
          { platformId: 'gog', platformGameId: gogId, installed: false, playtimeMinutes: 0 },
        ],
        headerImage: gogHeaderUrl,
        capsuleImage: '',
      });
      const afterStage2 = mergeStorefrontGames([existingDeadCard], [incomingEmptyCapsule], 'gog');
      expect(afterStage2).toHaveLength(1);
      expect(afterStage2[0].capsuleImage).toBe(gogVerticalUrl);

      // Stage 3: sanitizeGameCatalog instantly heals pre-corrupted capsuleImage: undefined via getGogVerticalCoverInstant
      const preCorruptedGame = makeSyntheticGame({
        id: `steam-${deadSteamId}`,
        title,
        steamAppId: deadSteamId,
        platforms: [
          { platformId: 'gog', platformGameId: gogId, installed: false, playtimeMinutes: 0 },
        ],
        headerImage: gogHeaderUrl,
        capsuleImage: undefined,
      });
      const afterStage3 = sanitizeGameCatalog([preCorruptedGame], { allowNewPurchases: true });
      expect(afterStage3).toHaveLength(1);
      expect(afterStage3[0].capsuleImage).toBe(gogVerticalUrl);

      // Stage 3 URL-kind-aware check: a dead unhashed Steam cover for steamAppId MUST NOT cause
      // sanitizeGameCatalog or duplicate merging to discard a valid SHA1-hashed Steam or GOG cover
      const sha1 = '11223344556677889900aabbccddeeff00112233';
      const validHashedCover = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${deadSteamId}/${sha1}/library_capsule_2x.jpg`;
      const gameWithHashedSteam = makeSyntheticGame({
        id: `steam-${deadSteamId}`,
        title: 'Synthetic Hashed Survivor',
        steamAppId: deadSteamId,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: String(deadSteamId),
            installed: false,
            playtimeMinutes: 0,
          },
        ],
        capsuleImage: validHashedCover,
      });
      const sanitizedHashed = sanitizeGameCatalog([gameWithHashedSteam], {
        allowNewPurchases: true,
      });
      expect(sanitizedHashed[0].capsuleImage).toBe(validHashedCover);
    });

    it('eliminates 16:9 landscape-into-capsule fallbacks in fallbackMetadataProvider and epicIntegration', async () => {
      // 1) fallbackMetadataProvider: never falls back to 16:9 headerImage for capsuleImage
      const landscapeOnlyGame = makeSyntheticGame({
        id: 'custom-930001',
        title: 'Synthetic Landscape Only',
        steamAppId: undefined,
        platforms: [
          {
            platformId: 'custom',
            platformGameId: 'custom-930001',
            installed: false,
            playtimeMinutes: 0,
          },
        ],
        headerImage: 'https://cdn.example.com/synthetic-banner-16x9.jpg',
        capsuleImage: undefined,
      });
      const fallbackMeta = await fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(
        landscapeOnlyGame,
        undefined,
        { synopsisOnly: true }
      );
      expect(fallbackMeta.headerImage).toBe('https://cdn.example.com/synthetic-banner-16x9.jpg');
      expect(fallbackMeta.capsuleImage).toBeUndefined();

      // 2) epicIntegration: checks OfferImageTall, never falls back to wide DieselGameBox,
      //    and never lets unhashed Steam guesses clobber Epic's verified tall cover
      const offerTallUrl =
        'https://cdn1.epicgames.com/offer/synth-ns-1/EGS_SynthBlade_OfferImageTall.jpg';
      const wideBoxUrl =
        'https://cdn1.epicgames.com/offer/synth-ns-2/EGS_WideOnly_DieselGameBox.jpg';

      const epicSteamMatchSpy = vi
        .spyOn(steamMatcher, 'matchGameToSteam')
        .mockImplementation(async (t: string) => (t === 'Synthetic Blade' ? 930099 : null));

      vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (url.includes('/library/api/public/items')) {
          return {
            status: 200,
            data: {
              records: [
                {
                  appName: 'SynthBladeApp',
                  namespace: 'synth-ns-1',
                  catalogItemId: 'cat-synth-blade-1',
                  metadata: {
                    title: 'Synthetic Blade',
                    description: 'Action adventure',
                    developer: 'Synth Studio',
                    keyImages: [
                      { type: 'OfferImageTall', url: offerTallUrl },
                      {
                        type: 'DieselGameBox',
                        url: 'https://cdn1.epicgames.com/offer/synth-ns-1/EGS_SynthBlade_Wide.jpg',
                      },
                    ],
                  },
                },
                {
                  appName: 'SynthWideOnlyApp',
                  namespace: 'synth-ns-2',
                  catalogItemId: 'cat-synth-wide-2',
                  metadata: {},
                },
              ],
            },
          };
        }
        if (url.includes('/catalog/api/shared/namespace/synth-ns-2/')) {
          return {
            status: 200,
            data: {
              'cat-synth-wide-2': {
                title: 'Synthetic Wide Only',
                description: 'Wide-only test title',
                developer: 'Synth Studio',
                categories: [{ path: 'games' }],
                keyImages: [{ type: 'DieselGameBox', url: wideBoxUrl }],
              },
            },
          };
        }
        return { status: 200, data: {} };
      });

      const epicGames = await epicIntegration.fetchOwnedGames('synthetic-epic-token');
      epicSteamMatchSpy.mockRestore();
      const blade = epicGames.find((g) => g.title === 'Synthetic Blade');
      const wideOnly = epicGames.find((g) => g.title === 'Synthetic Wide Only');
      // Epic OfferImageTall (Rank 4) survives Steam match 930099 (Rank 2 unhashed guess)
      expect(blade?.steamAppId).toBe(930099);
      expect(blade?.capsuleImage).toBe(offerTallUrl);
      // Wide-only Epic title never leaks 16:9 DieselGameBox into capsuleImage
      expect(wideOnly?.headerImage).toBe(wideBoxUrl);
      expect(wideOnly?.capsuleImage).toBe('');
    });
  });

  describe('3. Unified URL-Kind-Aware Dead-Steam Cover Engine (igdbCoverService.ts)', () => {
    it('isolates SHA1-hashed failures into antigravity_dead_steam_hashed_v2 without poisoning KNOWN_DEAD_STEAM_COVER_APP_IDS', async () => {
      const appId = 940001;
      const deadSha1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const freshSha1 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const deadHashedUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/${deadSha1}/library_capsule_2x.jpg`;
      const freshHashedUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/${freshSha1}/library_capsule_2x.jpg`;
      const unhashedUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900_2x.jpg`;

      const probedUrls: string[] = [];
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        probedUrls.push(String(input));
        return { status: 404, ok: false } as Response;
      });
      const vaultSetSpy = vi.spyOn(indexedDbVault, 'vaultSet').mockResolvedValue(true);

      const confirmed = await igdbCoverService.verifyAndRecordDeadSteamCover(appId, deadHashedUrl);
      expect(confirmed).toBe(true);
      expect(probedUrls).toEqual([deadHashedUrl]);

      // SHA1-hashed failure MUST NOT poison KNOWN_DEAD_STEAM_COVER_APP_IDS or unhashed v1 storage
      expect(isKnownDeadSteamCover(appId)).toBe(false);
      expect(KNOWN_DEAD_STEAM_COVER_APP_IDS.has(appId)).toBe(false);
      expect(memStorage.getItem('antigravity_dead_steam_covers_v1')).toBeNull();

      // Exact dead SHA1 URL is marked dead/unsuitable; newer SHA1 & unhashed URL remain unaffected
      expect(isDeadSteamCoverUrl(deadHashedUrl)).toBe(true);
      expect(isUnsuitableCoverUrl(deadHashedUrl)).toBe(true);
      expect(isDeadSteamCoverUrl(freshHashedUrl)).toBe(false);
      expect(isUnsuitableCoverUrl(freshHashedUrl)).toBe(false);
      expect(isDeadSteamCoverUrl(unhashedUrl)).toBe(false);
      expect(isUnsuitableCoverUrl(unhashedUrl)).toBe(false);

      const persistedHashedRaw = memStorage.getItem('antigravity_dead_steam_hashed_v2');
      expect(persistedHashedRaw).toBeTruthy();
      expect(persistedHashedRaw).toContain(`${appId}:${deadSha1}`);
      expect(vaultSetSpy).toHaveBeenCalledWith(
        'antigravity_dead_steam_hashed_v2',
        expect.objectContaining({
          [`${appId}:${deadSha1}`]: expect.objectContaining({ failureCount: 1 }),
        })
      );

      // Conversely, recording an unhashed failure MUST NOT mark a valid SHA1 URL unsuitable
      igdbCoverService.recordDeadSteamCover(appId);
      expect(isKnownDeadSteamCover(appId)).toBe(true);
      expect(isDeadSteamCoverUrl(unhashedUrl)).toBe(true);
      expect(isUnsuitableCoverUrl(unhashedUrl)).toBe(true);
      expect(isDeadSteamCoverUrl(freshHashedUrl)).toBe(false);
      expect(isUnsuitableCoverUrl(freshHashedUrl)).toBe(false);
    });

    it('preserves deadSteamFailureCounts across TTL expiry (6h -> 24h -> 7d -> 30d cap 4) and supports SWR reprobe', async () => {
      vi.useFakeTimers();
      const baseTime = 1_760_000_000_000;
      vi.setSystemTime(baseTime);

      const appId = 940002;
      const unhashedUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`;
      let mockStatus = 404;
      globalThis.fetch = vi.fn(async () => ({
        status: mockStatus,
        ok: mockStatus >= 200 && mockStatus < 300,
      }) as Response);

      // Failure #1 -> 6h TTL
      await igdbCoverService.verifyAndRecordDeadSteamCover(appId, unhashedUrl);
      expect(isKnownDeadSteamCover(appId)).toBe(true);
      expect(isExpiredDeadSteamUnhashed(appId)).toBe(false);

      // Advance past 6h TTL and simulate reload via clearCache/reload from localStorage
      const savedCounts1 = JSON.parse(
        memStorage.getItem('antigravity_dead_steam_cover_counts_v1') || '{}'
      ) as Record<string, number>;
      expect(savedCounts1[String(appId)]).toBe(1);

      vi.setSystemTime(baseTime + 7 * 60 * 60 * 1000);
      // Reload persistent state from localStorage (simulating cold boot after 6h TTL expiry)
      (igdbCoverService as unknown as { loadPersistentCache: () => void }).loadPersistentCache();
      expect(isKnownDeadSteamCover(appId)).toBe(false);
      expect(isExpiredDeadSteamUnhashed(appId)).toBe(true);

      // Failure #2 via SWR reprobe -> escalates count to 2 (24h TTL) rather than resetting to 1!
      scheduleExpiredDeadSteamReprobe(appId);
      await vi.advanceTimersByTimeAsync(250);
      expect(isKnownDeadSteamCover(appId)).toBe(true);
      const savedCounts2 = JSON.parse(
        memStorage.getItem('antigravity_dead_steam_cover_counts_v1') || '{}'
      ) as Record<string, number>;
      expect(savedCounts2[String(appId)]).toBe(2);

      // Advance 25h -> Failure #3 (7d TTL)
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
      (igdbCoverService as unknown as { loadPersistentCache: () => void }).loadPersistentCache();
      expect(isExpiredDeadSteamUnhashed(appId)).toBe(true);
      await igdbCoverService.verifyAndRecordDeadSteamCover(appId, unhashedUrl);
      expect(
        (
          JSON.parse(
            memStorage.getItem('antigravity_dead_steam_cover_counts_v1') || '{}'
          ) as Record<string, number>
        )[String(appId)]
      ).toBe(3);

      // Advance 8d -> Failure #4 (30d TTL, capped at 4)
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
      (igdbCoverService as unknown as { loadPersistentCache: () => void }).loadPersistentCache();
      await igdbCoverService.verifyAndRecordDeadSteamCover(appId, unhashedUrl);
      expect(
        (
          JSON.parse(
            memStorage.getItem('antigravity_dead_steam_cover_counts_v1') || '{}'
          ) as Record<string, number>
        )[String(appId)]
      ).toBe(4);

      // Advance 31d -> Failure #5 stays capped at 4
      vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
      (igdbCoverService as unknown as { loadPersistentCache: () => void }).loadPersistentCache();
      await igdbCoverService.verifyAndRecordDeadSteamCover(appId, unhashedUrl);
      expect(
        (
          JSON.parse(
            memStorage.getItem('antigravity_dead_steam_cover_counts_v1') || '{}'
          ) as Record<string, number>
        )[String(appId)]
      ).toBe(4);

      // Advance 31d again -> HTTP 200 recovery clears dead state and dispatches antigravity:steam-assets-resolved
      vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
      (igdbCoverService as unknown as { loadPersistentCache: () => void }).loadPersistentCache();
      mockStatus = 200;
      const resolvedEvents: number[] = [];
      winEvents.addEventListener('antigravity:steam-assets-resolved', (ev: Event) => {
        const detail = (ev as CustomEvent<{ appId?: number }>).detail;
        if (typeof detail?.appId === 'number') resolvedEvents.push(detail.appId);
      });

      scheduleExpiredDeadSteamReprobe(appId);
      await vi.advanceTimersByTimeAsync(250);
      expect(isKnownDeadSteamCover(appId)).toBe(false);
      expect(isExpiredDeadSteamUnhashed(appId)).toBe(false);
      expect(resolvedEvents).toContain(appId);
    });

    it('surgically purges legacy scroll-burst poison clusters (>=8 in 15s) while keeping isolated genuine 404s, and enforces live 15s burst circuit breaker', async () => {
      const now = Date.now();
      const seededTimestamps: Record<string, number> = {
        // Two genuine isolated 404s hours apart
        '950001': now - 2 * 60 * 60 * 1000,
        '950002': now - 4 * 60 * 60 * 1000,
      };
      // 12 burst-clustered uncounted false positives within 4 seconds
      for (let i = 0; i < 12; i++) {
        seededTimestamps[String(951000 + i)] = now - 30 * 60 * 1000 + i * 300;
      }
      memStorage.setItem('antigravity_dead_steam_covers_v1', JSON.stringify(seededTimestamps));
      memStorage.removeItem('antigravity_dead_steam_cover_counts_v1');
      memStorage.removeItem('antigravity_dead_steam_schema_v2');

      (igdbCoverService as unknown as { loadPersistentCache: () => void }).loadPersistentCache();

      expect(memStorage.getItem('antigravity_dead_steam_schema_v2')).toBe('1');
      // Isolated genuine 404s survive!
      expect(isKnownDeadSteamCover(950001)).toBe(true);
      expect(isKnownDeadSteamCover(950002)).toBe(true);
      // All 12 scroll-burst false positives were surgically purged!
      for (let i = 0; i < 12; i++) {
        expect(isKnownDeadSteamCover(951000 + i)).toBe(false);
      }

      // Live 15s rolling burst circuit breaker (>= 8 distinct AppIDs in 15s suppresses persistence)
      globalThis.fetch = vi.fn(async () => ({ status: 404, ok: false }) as Response);
      for (let i = 0; i < 7; i++) {
        const res = await igdbCoverService.verifyAndRecordDeadSteamCover(952000 + i);
        expect(res).toBe(true);
        expect(isKnownDeadSteamCover(952000 + i)).toBe(true);
      }
      // 8th distinct AppID within 15s trips the rolling burst circuit breaker!
      const eighthResult = await igdbCoverService.verifyAndRecordDeadSteamCover(952007);
      expect(eighthResult).toBe(false);
      expect(isKnownDeadSteamCover(952007)).toBe(false);
      const ninthResult = await igdbCoverService.verifyAndRecordDeadSteamCover(952008);
      expect(ninthResult).toBe(false);
      expect(isKnownDeadSteamCover(952008)).toBe(false);
    });
  });

  describe('4. SteamMatcher v5 Cache + Suffix Normalization & SteamApi 5,000-Entry Browse Cache', () => {
    it('migrates v4 -> v5 purging storefront-suffix poison, enforces 30d TTL, blocks Remastered -> Classic collisions, and reconciles monotonically', async () => {
      // Seed poisoned v4 cache + clean v4 entry
      memStorage.setItem(
        'steam_app_id_match_cache_v4',
        JSON.stringify({
          'synthetic classic 2 remastered - amazon prime': 960010,
          'synthetic clean adventure': 960020,
        })
      );

      const matcher = new SteamMatcherService();
      // Poisoned "- Amazon Prime" entry was purged; clean entry survived into v5
      expect(matcher.peekCachedMatch('Synthetic Classic 2 Remastered - Amazon Prime')).toBeNull();
      expect(matcher.peekCachedMatch('Synthetic Clean Adventure')).toBe(960020);
      expect(memStorage.getItem('steam_app_id_match_cache_v5')).toBeTruthy();

      // Match "Synthetic Classic 2 Remastered - Amazon Prime": must NEVER match classic 960010, MUST match Remastered 960011!
      vi.spyOn(axios, 'get').mockResolvedValue({
        status: 200,
        data: {
          items: [
            { id: 960010, name: 'Synthetic Classic 2' },
            { id: 960011, name: 'Synthetic Classic 2 Remastered' },
          ],
        },
      });
      const matchedId = await matcher.matchGameToSteam(
        'Synthetic Classic 2 Remastered - Amazon Prime'
      );
      expect(matchedId).toBe(960011);
      // Suffix-normalized lookup hits the same cache entry for "PC Edition" variant
      expect(matcher.peekCachedMatch('Synthetic Classic 2 Remastered PC Edition')).toBe(960011);

      // Verify 30-day per-entry TTL expiration on v5 cache
      const expiredTimestamp = Date.now() - 31 * 24 * 60 * 60 * 1000;
      memStorage.setItem(
        'steam_app_id_match_cache_v5',
        JSON.stringify({
          'synthetic expired title': { appId: 960099, cachedAt: expiredTimestamp },
          'synthetic fresh title': { appId: 960098, cachedAt: Date.now() },
        })
      );
      const matcherAfterTtl = new SteamMatcherService();
      expect(matcherAfterTtl.peekCachedMatch('Synthetic Expired Title')).toBeNull();
      expect(matcherAfterTtl.peekCachedMatch('Synthetic Fresh Title')).toBe(960098);

      // enrichGameWithSteamMatch never clobbers Rank 4 GOG vertical cover or GOG header with Rank 2 unhashed Steam guesses
      const gogCover = 'https://images.gog-statics.com/synth_classic_2_remastered_vertical.jpg';
      const gogHeader = 'https://images.gog-statics.com/synth_classic_2_remastered_banner.jpg';
      const gogGame = makeSyntheticGame({
        id: 'gog-180960011',
        title: 'Synthetic Classic 2 Remastered',
        steamAppId: undefined,
        platforms: [
          { platformId: 'gog', platformGameId: '180960011', installed: false, playtimeMinutes: 0 },
        ],
        headerImage: gogHeader,
        capsuleImage: gogCover,
      });
      const enriched = await matcher.enrichGameWithSteamMatch(gogGame);
      expect(enriched.steamAppId).toBe(960011);
      expect(enriched.capsuleImage).toBe(gogCover);
      expect(enriched.headerImage).toBe(gogHeader);
    });

    it('retains > 1,000 (up to 5,000) Steam browse asset entries and mirrors to indexedDbVault on localStorage quota overflow', async () => {
      const api = new SteamApiService();
      const seedCount = 1500;
      const sha1 = '0123456789abcdef0123456789abcdef01234567';

      // Batch 1,500 store browse items (30 batches of 50)
      vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        const match = url.match(/input_json=([^&]+)/);
        const parsed = match
          ? (JSON.parse(decodeURIComponent(match[1])) as { ids: Array<{ appid: number }> })
          : { ids: [] };
        return {
          status: 200,
          headers: {},
          data: {
            response: {
              store_items: parsed.ids.map(({ appid }) => ({
                appid,
                assets: {
                  asset_url_format: `steam/apps/${appid}/\${FILENAME}`,
                  library_capsule_2x: `${sha1}/library_capsule_2x.jpg`,
                  header: `${sha1}/header.jpg`,
                },
              })),
            },
          },
        };
      });

      const appIds = Array.from({ length: seedCount }, (_, idx) => 970000 + idx);
      await api.fetchStoreBrowseAssetsBatch(appIds);

      // Old 1,000-entry cap would have evicted 970000..970499 — 5,000-entry cap retains ALL 1,500!
      expect(api.peekCachedBrowseAssets(970000)?.capsuleImage).toContain('/970000/');
      expect(api.peekCachedBrowseAssets(971499)?.capsuleImage).toContain('/971499/');
      const savedBrowse = JSON.parse(
        memStorage.getItem('antigravity_steam_browse_assets_v1') || '{}'
      ) as Record<string, unknown>;
      expect(Object.keys(savedBrowse)).toHaveLength(seedCount);

      // QuotaExceeded fallback mirrors to indexedDbVault and recovers via hydrateBrowseAssetsFromVault
      const vaultStore = new Map<string, unknown>();
      vi.spyOn(indexedDbVault, 'vaultSet').mockImplementation(async (k, v) => {
        vaultStore.set(k, v);
        return true;
      });
      vi.spyOn(indexedDbVault, 'vaultGet').mockImplementation(
        async <T,>(k: string) => vaultStore.get(k) as T | undefined
      );

      vi.spyOn(memStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      });

      await api.fetchStoreBrowseAssetsBatch([979999]);
      expect(vaultStore.has('antigravity_steam_browse_assets_v1')).toBe(true);

      memStorage.removeItem('antigravity_steam_browse_assets_v1');
      const coldApi = new SteamApiService();
      const hydratedCount = await coldApi.hydrateBrowseAssetsFromVault();
      expect(hydratedCount).toBeGreaterThanOrEqual(seedCount);
      expect(coldApi.peekCachedBrowseAssets(979999)?.capsuleImage).toContain('/979999/');
    });
  });

  describe('5. Compact Storage (<1.2 MB for 1,275 Games), Object Identity, Zero-Repair IDB Hydration, Small-Delta Debounce & StagedCache S-07', () => {
    it('compacts 1,275 realistic enriched games to < 1.2 MB in slimGameForLocalStorageQuota while preserving __quotaSlimmed & rich counts', () => {
      const longRichHtml = '<p>' + 'Synthetic store rich description block. '.repeat(120) + '</p>';
      const games: CanonicalGame[] = Array.from({ length: 1275 }, (_, i) => {
        const appId = 980000 + i;
        const enriched: SteamEnrichedMetadata = {
          appId,
          name: `Synthetic Catalog Entry ${i}`,
          shortDescription:
            'A rich tactical simulation featuring procedural worlds, co-op missions, and deep progression.',
          detailedDescription: longRichHtml,
          aboutTheGame: longRichHtml,
          headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg?t=1715000000`,
          capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/0123456789abcdef0123456789abcdef01234567/library_capsule_2x.jpg`,
          developers: ['Synthetic Studio Alpha'],
          publishers: ['Synthetic Publishing Global'],
          releaseDate: '2023-10-15',
          genres: ['Action', 'Strategy', 'RPG'],
          tags: ['Singleplayer', 'Tactical', 'Sci-Fi', 'Controller'],
          categories: [
            { id: 2, description: 'Single-player' },
            { id: 22, description: 'Steam Achievements' },
          ],
          screenshots: Array.from({ length: 6 }, (__, sIdx) => ({
            id: sIdx,
            pathThumbnail: `https://shared.akamai.steamstatic.com/ss/${appId}/${sIdx}_thumb.jpg`,
            pathFull: `https://shared.akamai.steamstatic.com/ss/${appId}/${sIdx}_full.jpg`,
          })),
          movies: [
            {
              id: 1,
              name: 'Trailer',
              thumbnail: `https://shared.akamai.steamstatic.com/mv/${appId}/thumb.jpg`,
            },
          ],
          systemRequirements: { minimum: 'OS: 64-bit', recommended: 'RAM: 16 GB' },
          reviewSummary: {
            reviewScore: 8,
            reviewScoreDesc: 'Very Positive',
            totalPositive: 860,
            totalNegative: 140,
            totalReviews: 1000,
            positivePercent: 86,
          },
          metacritic: { score: 86, url: 'https://metacritic.example/game' },
          platforms: { windows: true, mac: false, linux: true },
          achievements: { total: 42 },
          metadataQuality: 'authoritative',
          enrichedSource: 'steam',
          enrichedAt: 1715000000000,
          ...(i % 10 === 0
            ? { xboxDeliveryHints: { packageFormat: 'gdk', contentId: `synth-cid-${i}` } }
            : {}),
        };
        return makeSyntheticGame({
          id: `steam-${appId}`,
          title: `Synthetic Catalog Entry ${i}`,
          steamAppId: appId,
          platforms: [
            {
              platformId: 'steam',
              platformGameId: String(appId),
              installed: false,
              playtimeMinutes: i % 500,
            },
          ],
          headerImage: enriched.headerImage,
          capsuleImage: enriched.capsuleImage,
          enrichedMetadata: enriched,
        });
      });

      const slimmed = games.map((g) => slimGameForLocalStorageQuota(g));
      const serializedBytes = new TextEncoder().encode(JSON.stringify(slimmed)).length;
      expect(serializedBytes).toBeLessThan(1_200_000);

      const sampleMeta = slimmed[0].enrichedMetadata as unknown as Record<string, unknown>;
      expect(sampleMeta.__quotaSlimmed).toBe(true);
      expect(sampleMeta.hasScreenshotsCount).toBe(6);
      expect(sampleMeta.hasMoviesCount).toBe(1);
      expect(sampleMeta.metadataQuality).toBe('authoritative');
      expect(sampleMeta.enrichedSource).toBe('steam');
      expect(sampleMeta.platforms).toEqual({ windows: true, mac: false, linux: true });
      expect(sampleMeta.achievements).toEqual({ total: 42 });
      expect(sampleMeta.xboxDeliveryHints).toEqual({
        packageFormat: 'gdk',
        contentId: 'synth-cid-0',
      });
      // Redundant top-level fields dropped from slimMeta
      expect(sampleMeta.shortDescription).toBeUndefined();
      expect(sampleMeta.headerImage).toBeUndefined();
      expect(sampleMeta.capsuleImage).toBeUndefined();
      expect(sampleMeta.developers).toBeUndefined();
      expect(sampleMeta.genres).toBeUndefined();
      expect(sampleMeta.tags).toBeUndefined();
    });

    it('preserves exact object identity (===) in mergeStorefrontGames and mergeHydratedCatalogPreservingLiveState when unchanged', () => {
      const existingGame = makeSyntheticGame({
        id: 'steam-985001',
        title: 'Synthetic Identity Alpha',
        steamAppId: 985001,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '985001',
            installed: true,
            installPath: 'C:/Games/SynthAlpha',
            playtimeMinutes: 120,
            achievements: { unlocked: 5, total: 20, percentage: 25 },
          },
        ],
      });
      const identicalIncoming = makeSyntheticGame({
        id: 'steam-985001',
        title: 'Synthetic Identity Alpha',
        steamAppId: 985001,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '985001',
            installed: false, // live install state preserved
            playtimeMinutes: 120,
            achievements: { unlocked: 5, total: 20, percentage: 25 },
          },
        ],
      });

      const mergedPass1 = mergeStorefrontGames([existingGame], [identicalIncoming], 'steam');
      expect(mergedPass1).toHaveLength(1);
      const stabilizedGame = mergedPass1[0];
      // Repeat sync with zero field changes returns exact same object reference (===)
      const mergedPass2 = mergeStorefrontGames([stabilizedGame], [identicalIncoming], 'steam');
      expect(mergedPass2).toHaveLength(1);
      expect(mergedPass2[0]).toBe(stabilizedGame);

      // mergeHydratedCatalogPreservingLiveState(liveGames, hydratedGames) preserves exact live reference when equal
      const hydratedCopy = structuredClone(stabilizedGame);
      const mergedHydrated = mergeHydratedCatalogPreservingLiveState(
        [stabilizedGame],
        [hydratedCopy]
      );
      expect(mergedHydrated).toHaveLength(1);
      expect(mergedHydrated[0]).toBe(stabilizedGame);
    });

    it('preserves existing platform achievements (syncedAt) and exact object identity when storefront sync returns unchanged counts with a fresh syncedAt timestamp', () => {
      const existingEpic = makeSyntheticGame({
        id: 'epic-synth-ach-1',
        title: 'Synthetic Epic Horizon',
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'synth-epic-ach-1',
            installed: false,
            achievements: {
              unlocked: 12,
              total: 40,
              percentage: 30,
              isMastered: false,
              xp: { earned: 300, total: 1000 },
              source: 'live_cloud_graphql',
              syncedAt: '2026-10-01T10:00:00.000Z',
            },
          },
        ],
      });

      // Stabilize baseline first
      const baseMerged = mergeStorefrontGames([existingEpic], [existingEpic], 'epic');
      const stabilized = baseMerged[0];

      // Incoming Epic cold-boot sync stamps a brand-new syncedAt ISO timestamp with identical achievement counts/XP/source
      const incomingSameCountsNewTimestamp = makeSyntheticGame({
        id: 'epic-synth-ach-1',
        title: 'Synthetic Epic Horizon',
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'synth-epic-ach-1',
            installed: false,
            achievements: {
              unlocked: 12,
              total: 40,
              percentage: 30,
              isMastered: false,
              xp: { earned: 300, total: 1000 },
              source: 'live_cloud_graphql',
              syncedAt: '2026-11-20T15:23:22.058Z',
            },
          },
        ],
      });

      const mergedNoOp = mergeStorefrontGames(
        [stabilized],
        [incomingSameCountsNewTimestamp],
        'epic'
      );
      expect(mergedNoOp).toHaveLength(1);
      expect(mergedNoOp[0]).toBe(stabilized);
      expect(mergedNoOp[0].platforms[0].achievements?.syncedAt).toBe('2026-10-01T10:00:00.000Z');

      // When actual progress changes (unlocked 12 -> 13), the achievement summary DOES update
      const incomingProgress = makeSyntheticGame({
        id: 'epic-synth-ach-1',
        title: 'Synthetic Epic Horizon',
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'synth-epic-ach-1',
            installed: false,
            achievements: {
              unlocked: 13,
              total: 40,
              percentage: 33,
              isMastered: false,
              xp: { earned: 350, total: 1000 },
              source: 'live_cloud_graphql',
              syncedAt: '2026-11-20T15:25:00.000Z',
            },
          },
        ],
      });
      const mergedUpdated = mergeStorefrontGames([stabilized], [incomingProgress], 'epic');
      expect(mergedUpdated[0]).not.toBe(stabilized);
      expect(mergedUpdated[0].platforms[0].achievements?.unlocked).toBe(13);
      expect(mergedUpdated[0].platforms[0].achievements?.syncedAt).toBe('2026-11-20T15:25:00.000Z');
    });

    it('slims multi-storefront platforms, tags, and reviewSummary in slimGameForLocalStorageQuota below 1.2 MB while preserving lossless IDB hydration', () => {
      const richGames: CanonicalGame[] = Array.from({ length: 1275 }, (_, i) => {
        const appId = 970000 + i;
        return makeSyntheticGame({
          id: `steam-${appId}`,
          title: `Synthetic MultiStore Entry ${i}`,
          steamAppId: appId,
          developers: ['Synthetic Studio Dev Alpha', 'Synthetic Co-Dev'],
          publishers: ['Synthetic Global Publishing'],
          genres: ['Action', 'RPG', 'Strategy', 'Adventure'],
          tags: ['Singleplayer', 'Atmospheric', 'Sci-Fi', 'Controller', 'Story Rich', 'Co-op'],
          reviewSummary: {
            reviewScore: 8,
            reviewScoreDesc: 'Very Positive',
            totalPositive: 850,
            totalNegative: 150,
            totalReviews: 1000,
            positivePercent: 85,
          },
          platforms: [
            {
              platformId: 'steam',
              platformGameId: String(appId),
              storefrontAppId: String(appId),
              originalTitle: `Synthetic MultiStore Entry ${i}`,
              installed: false,
              playtimeMinutes: i % 400,
              platforms: { windows: true, mac: i % 5 === 0, linux: false },
              achievements: {
                unlocked: 10,
                total: 50,
                percentage: 20,
                source: 'live_cloud_api',
                syncedAt: '2026-11-20T12:00:00.000Z',
              },
            },
            ...(i % 3 === 0
              ? [
                  {
                    platformId: 'epic' as const,
                    platformGameId: `epic-app-${i}`,
                    namespace: `ns-${i}-abcdef0123456789`,
                    catalogItemId: `cat-${i}-9876543210abcdef`,
                    originalTitle: `Synthetic MultiStore Entry ${i}`,
                    installed: false,
                    achievements: {
                      unlocked: 5,
                      total: 25,
                      percentage: 20,
                      xp: { earned: 200, total: 1000 },
                      source: 'live_cloud_graphql' as const,
                      syncedAt: '2026-11-20T12:00:00.000Z',
                    },
                  },
                ]
              : []),
          ],
          headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
          capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_capsule_2x.jpg`,
          iconUrl: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/icon.jpg`,
        });
      });

      const slimmed = richGames.map((g) => slimGameForLocalStorageQuota(g));
      const slimBytes = new TextEncoder().encode(JSON.stringify(slimmed)).length;
      expect(slimBytes).toBeLessThan(1_200_000);
      expect(slimmed[0].tags).toEqual([]);
      expect(slimmed[0].reviewSummary).toBeUndefined();
      expect(slimmed[0].genres).toEqual(['Action', 'RPG']);
      expect(slimmed[0].platforms[0].achievements).toBeUndefined();

      // Hydrating full rich record over slimmed localStorage snapshot restores full platforms/achievements/tags losslessly
      const restored = mergeHydratedCatalogPreservingLiveState([slimmed[0]], [richGames[0]]);
      expect(restored[0]).toBe(richGames[0]);
    });

    it('skips vaultSet in hydrateCatalogFromIndexedDb when zero repairs/upgrades are needed', async () => {
      const cleanGame = makeSyntheticGame({
        id: 'steam-986001',
        title: 'Synthetic Clean Hydrated',
        steamAppId: 986001,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '986001',
            installed: false,
            playtimeMinutes: 0,
            platforms: { windows: true },
          },
        ],
      });
      const preSanitized = sanitizeGameCatalog([cleanGame], { allowNewPurchases: true });

      vi.spyOn(indexedDbVault, 'isIndexedDbAvailable').mockReturnValue(true);
      vi.spyOn(indexedDbVault, 'vaultGet').mockResolvedValue(preSanitized);
      const vaultSetSpy = vi.spyOn(indexedDbVault, 'vaultSet').mockResolvedValue(true);

      const hydrated = await hydrateCatalogFromIndexedDb();
      expect(hydrated).toHaveLength(1);
      expect(hydrated?.[0].id).toBe('steam-986001');
      expect(vaultSetSpy).not.toHaveBeenCalled();
    });

    it('sends small dirty slices immediately to offlineVault.upsertGames while debouncing full IDB/localStorage snapshots to 3,000 ms', () => {
      vi.useFakeTimers();

      const upsertGamesSpy = vi.fn(async () => ({ success: true }));
      const winRef = globalThis.window as unknown as {
        electronAPI?: {
          isElectron: boolean;
          offlineVault: { upsertGames: typeof upsertGamesSpy };
        };
      };
      winRef.electronAPI = {
        isElectron: true,
        offlineVault: { upsertGames: upsertGamesSpy },
      };

      const vaultSetSpy = vi.spyOn(indexedDbVault, 'vaultSet').mockResolvedValue(true);
      const setItemSpy = vi.spyOn(memStorage, 'setItem');

      const largeCatalog: CanonicalGame[] = Array.from({ length: 400 }, (_, idx) => {
        const appId = 990000 + idx;
        return makeSyntheticGame({
          id: `steam-${appId}`,
          title: `Synthetic Large Entry ${idx}`,
          steamAppId: appId,
          platforms: [
            {
              platformId: 'steam',
              platformGameId: String(appId),
              installed: false,
              playtimeMinutes: 0,
            },
          ],
        });
      });

      // Small dirty slice (1 game <= 20 on 400-game catalog > 350)
      saveCurrentCatalog(largeCatalog, {
        dirtyGameIds: ['steam-990005'],
        skipSanitize: true,
      });

      // SQLite delta upsert fires immediately with ONLY the 1 dirty game!
      expect(upsertGamesSpy).toHaveBeenCalledTimes(1);
      const firstCallArgs = upsertGamesSpy.mock.calls[0] as unknown as [CanonicalGame[]];
      expect(firstCallArgs[0]).toHaveLength(1);
      expect(firstCallArgs[0][0].id).toBe('steam-990005');

      // Full IDB + localStorage snapshot is debounced (0 calls before 3,000 ms)
      expect(vaultSetSpy).not.toHaveBeenCalled();
      expect(
        setItemSpy.mock.calls.filter(([k]) => k === 'universal_game_library_catalog')
      ).toHaveLength(0);

      // Advancing 2,999 ms still holds the debounce
      vi.advanceTimersByTime(2999);
      expect(vaultSetSpy).not.toHaveBeenCalled();

      // At 3,000 ms the full snapshot mirrors cleanly to IDB + localStorage
      vi.advanceTimersByTime(1);
      expect(vaultSetSpy).toHaveBeenCalledWith(
        'idb_universal_game_library_catalog_v2',
        expect.any(Array)
      );
      expect(
        setItemSpy.mock.calls.filter(([k]) => k === 'universal_game_library_catalog').length
      ).toBeGreaterThanOrEqual(1);

      // Verify pagehide / flushPendingCatalogSave flushes a second small delta synchronously
      vaultSetSpy.mockClear();
      saveCurrentCatalog(largeCatalog, {
        dirtyGameIds: ['steam-990006'],
        skipSanitize: true,
      });
      expect(vaultSetSpy).not.toHaveBeenCalled();
      flushPendingCatalogSave();
      expect(vaultSetSpy).toHaveBeenCalledWith(
        'idb_universal_game_library_catalog_v2',
        expect.any(Array)
      );
    });

    it('M-1 regression: coalesces production small dirty slices behind scroll-aware debounce without writing synchronously during active scroll', () => {
      vi.useFakeTimers();
      const upsertGamesSpy = vi.fn().mockResolvedValue({ success: true });
      const winRef = globalThis.window as unknown as {
        electronAPI?: {
          isElectron: boolean;
          offlineVault: { upsertGames: typeof upsertGamesSpy };
        };
      };
      winRef.electronAPI = {
        isElectron: true,
        offlineVault: { upsertGames: upsertGamesSpy },
      };

      const vaultSetSpy = vi.spyOn(indexedDbVault, 'vaultSet').mockResolvedValue(true);
      const largeCatalog: CanonicalGame[] = Array.from({ length: 400 }, (_, idx) => {
        const appId = 991000 + idx;
        return makeSyntheticGame({
          id: `steam-${appId}`,
          title: `Synthetic Scroll Entry ${idx}`,
          steamAppId: appId,
          platforms: [
            {
              platformId: 'steam',
              platformGameId: String(appId),
              installed: false,
              playtimeMinutes: 0,
            },
          ],
        });
      });

      const origVitest = process.env.VITEST;
      const origNodeEnv = process.env.NODE_ENV;
      try {
        delete process.env.VITEST;
        process.env.NODE_ENV = 'production';

        // Simulate active user scroll
        markScrollActivity();

        // Two rapid small dirty slices arrive during scroll: NEITHER writes synchronously!
        saveCurrentCatalog(largeCatalog, {
          dirtyGameIds: ['steam-991001'],
          skipSanitize: true,
        });
        saveCurrentCatalog(largeCatalog, {
          dirtyGameIds: ['steam-991002'],
          skipSanitize: true,
        });
        expect(upsertGamesSpy).not.toHaveBeenCalled();
        expect(vaultSetSpy).not.toHaveBeenCalled();

        // Keep scrolling at 200ms and 400ms so scroll stays active across the initial 600ms check
        vi.advanceTimersByTime(200);
        markScrollActivity();
        vi.advanceTimersByTime(200);
        markScrollActivity();
        vi.advanceTimersByTime(200);
        // At t=600ms, scroll is STILL active (last markScrollActivity was at t=400ms, settles at t=620ms)
        expect(upsertGamesSpy).not.toHaveBeenCalled();

        // Let scroll settle (t=620ms) and the rescheduled 600ms idle timer fire (t=1200ms)
        vi.advanceTimersByTime(600);
        expect(upsertGamesSpy).toHaveBeenCalledTimes(1);
        const coalescedArgs = upsertGamesSpy.mock.calls[0] as unknown as [CanonicalGame[]];
        expect(coalescedArgs[0].map((g) => g.id).sort()).toEqual(['steam-991001', 'steam-991002']);

        // Snapshot mirror is STILL debounced for 3,000ms after the coalesced flush
        expect(vaultSetSpy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(3000);
        expect(vaultSetSpy).toHaveBeenCalledWith(
          'idb_universal_game_library_catalog_v2',
          expect.any(Array)
        );
      } finally {
        process.env.VITEST = origVitest;
        process.env.NODE_ENV = origNodeEnv;
        flushPendingCatalogSave();
      }
    });

    it('reads ONLY staged:* keys via getAllKeys in stagedCacheService.hydrateAllStagedCacheFromVault without reading idb_universal_game_library_catalog_v2 (S-07)', async () => {
      const now = Date.now();
      const tracking = createTrackingIndexedDbFactory({
        idb_universal_game_library_catalog_v2: Array.from({ length: 500 }, (_, i) => ({
          id: `steam-${995000 + i}`,
          blob: 'X'.repeat(5000),
        })),
        'staged:antigravity_staged_critic_synth_1': {
          data: { score: 91, source: 'synthetic' },
          cachedAt: now,
          ttlMs: 30 * 24 * 60 * 60 * 1000,
          tier: 'mature',
          version: STAGED_CACHE_VERSION,
        },
        'staged:antigravity_staged_hltb_synth_2': {
          data: { mainStoryHours: 14.5 },
          cachedAt: now,
          ttlMs: 180 * 24 * 60 * 60 * 1000,
          tier: 'immutable',
          version: STAGED_CACHE_VERSION,
        },
        antigravity_steam_browse_assets_v1: { '995000': { capsuleImage: 'https://example.com/c.jpg' } },
      });

      Object.defineProperty(globalThis, 'indexedDB', {
        value: tracking.factory,
        writable: true,
        configurable: true,
      });

      const hydratedCount = await hydrateAllStagedCacheFromVault();
      expect(hydratedCount).toBe(2);
      expect(tracking.getGetAllKeysCalls()).toBe(1);
      expect(tracking.getGetAllCalls()).toBe(0);
      expect(tracking.readKeys).toEqual([
        'staged:antigravity_staged_critic_synth_1',
        'staged:antigravity_staged_hltb_synth_2',
      ]);
      expect(tracking.readKeys).not.toContain('idb_universal_game_library_catalog_v2');
      expect(tracking.readKeys).not.toContain('antigravity_steam_browse_assets_v1');

      const criticLoaded = loadStagedCache<{ score: number }>('antigravity_staged_critic_synth_1');
      expect(criticLoaded.valid).toBe(true);
      expect(criticLoaded.data?.score).toBe(91);

      const hltbLoaded = loadStagedCache<{ mainStoryHours: number }>(
        'antigravity_staged_hltb_synth_2'
      );
      expect(hltbLoaded.valid).toBe(true);
      expect(hltbLoaded.data?.mainStoryHours).toBe(14.5);
    });
  });
});

// Keep steamApi import verified for singleton surface stability
void steamApi;
