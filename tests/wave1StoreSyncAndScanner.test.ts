import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (filePath: string, opts?: { readOnly?: boolean }) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => {
      all: (...args: unknown[]) => Array<Record<string, unknown>>;
      get: (...args: unknown[]) => Record<string, unknown> | undefined;
      run: (...args: unknown[]) => { changes?: number };
    };
    close: () => void;
  };
};

const storeSync = require('../electron/storeSync.cjs');
const { registerStoreSyncIpcHandlers } = require('../electron/ipc/storeSyncIpcHandlers.cjs');
const xboxCatalog = require('../electron/storefronts/xbox/xboxCatalogAndGamePass.cjs');
const installedGameScanner = require('../electron/launcher/installedGameScanner.cjs');
const environmentHealthProber = require('../electron/launcher/environmentHealthProber.cjs');
const macNativeInstaller = require('../electron/launcher/macNativeInstallerAndCodesign.cjs');
const epicCoordinator = require('../electron/launcher/epicLegendaryAndEosCoordinator.cjs');
const engineStateRegistry = require('../electron/launcher/engineStateRegistry.cjs');

interface MockIpcHandler {
  (event: Record<string, unknown>, ...args: unknown[]): Promise<unknown>;
}

interface MockResponse {
  ok: boolean;
  status: number;
  url?: string;
  headers?: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function makeJsonRes(body: unknown, status = 200, url = ''): MockResponse {
  const serialized = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => null },
    json: async () => body,
    text: async () => serialized,
  };
}

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  storeSync.trimStoreSyncMemory();
  storeSync.invalidateVaultMemoryCache();
  environmentHealthProber.invalidateProberRunnerUpdatesCache({ memoryOnly: true });
  engineStateRegistry.setLastProductionScanCache({ timestamp: 0, result: null });
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    try {
      xboxCatalog.closeXboxCatalogCacheStore({ userDataDir: dir });
    } catch {}
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe('Wave 1 — Storefront Sync Hardening, Scoped Achievements & Non-Blocking Scanner', () => {
  // =========================================================================
  // 1. Steam Sync Hardening & Token Vault De-Bloat
  // =========================================================================
  describe('1. Steam Sync Hardening, AbortSignal.timeout & Token Vault De-Bloat', () => {
    it('passes AbortSignal.timeout to GetOwnedGames and fails fast offline (< 500ms) with zero BrowserWindow spawns while preserving legacy cached games', async () => {
      const userDataDir = makeTempDir('wave1-steam-offline-');
      const handlers = new Map<string, MockIpcHandler>();
      const mockIpcMain = {
        handle: vi.fn((ch: string, fn: MockIpcHandler) => {
          handlers.set(ch, fn);
        }),
        on: vi.fn(),
        removeListener: vi.fn(),
      };
      const browserWindowSpy = vi.fn();
      const authSessionFetchSpy = vi.fn();

      const legacySteamGames = [
        {
          id: 'steam-910001',
          steamAppId: 910001,
          title: 'Synthetic Offline Adventure',
          isVerifiedEntitlement: true,
          platforms: [{ platformId: 'steam', platformGameId: '910001', installed: false, playtimeMinutes: 42 }],
        },
      ];

      // Seed bloated legacy tokens.json containing `games` array inside encrypted vault
      const vaultOpts = { userDataDir };
      storeSync.saveTokens(
        'steam',
        {
          access_token: 'steam_web_session',
          webapi_token: 'syn_steam_webapi_token_abc',
          steamId: '76561198000000001',
          accountName: 'SyntheticSteamOfflineUser',
          avatarUrl: 'https://avatars.steamstatic.com/synthetic.jpg',
          games: legacySteamGames,
        },
        vaultOpts
      );

      const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => {
        throw new Error('Should not be called while net.isOnline() === false');
      });

      const wrappedStoreSync = {
        ...storeSync,
        loadSavedTokens: () => storeSync.loadSavedTokens(vaultOpts),
        saveTokens: vi.fn((storeId: string, data: Record<string, unknown>) =>
          storeSync.saveTokens(storeId, data, vaultOpts)
        ),
        scanLocalSuppressedStorefrontItems: () => [],
      };

      registerStoreSyncIpcHandlers({
        ipcMain: mockIpcMain,
        BrowserWindow: browserWindowSpy,
        session: {
          fromPartition: () => ({ fetch: authSessionFetchSpy }),
        },
        getMainWindow: () => null,
        storeSync: wrappedStoreSync,
        launcherEngine: {},
        options: {
          userDataDir,
          isOnline: () => false,
          fetchFn: fetchSpy,
        },
      });

      const syncHandler = handlers.get('store:sync');
      expect(syncHandler).toBeDefined();

      const t0 = Date.now();
      const res = (await syncHandler!({}, 'steam')) as {
        success: boolean;
        games: Array<{ id: string; title: string }>;
      };
      const elapsedMs = Date.now() - t0;

      expect(res.success).toBe(true);
      expect(elapsedMs).toBeLessThan(500);
      expect(res.games.map((g) => g.id)).toEqual(['steam-910001']);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(authSessionFetchSpy).not.toHaveBeenCalled();
      expect(browserWindowSpy).not.toHaveBeenCalled();

      // Legacy `games` was seamlessly migrated out of tokens.json into one_launcher_steam_owned_cache.json
      const steamCachePath = storeSync.getSteamOwnedGamesCachePath(vaultOpts);
      expect(fs.existsSync(steamCachePath)).toBe(true);
      const savedAfterMigration = storeSync.loadSavedTokens(vaultOpts);
      expect(savedAfterMigration.steam?.games).toBeUndefined();
      expect(savedAfterMigration.steam?.steamId).toBe('76561198000000001');
      expect(wrappedStoreSync.saveTokens).toHaveBeenCalledTimes(1);

      // Subsequent sync with unchanged credentials writes tokens.json 0 times!
      wrappedStoreSync.saveTokens.mockClear();
      const res2 = (await syncHandler!({}, 'steam')) as {
        success: boolean;
        games: Array<{ id: string }>;
      };
      expect(res2.success).toBe(true);
      expect(res2.games.map((g) => g.id)).toEqual(['steam-910001']);
      expect(wrappedStoreSync.saveTokens).not.toHaveBeenCalled();
    });

    it('attaches an AbortSignal to GetOwnedGames, classifies network timeout as offline (skipping hidden BrowserWindow), and avoids rewriting tokens.json on unchanged online syncs', async () => {
      const userDataDir = makeTempDir('wave1-steam-online-');
      const handlers = new Map<string, MockIpcHandler>();
      const mockIpcMain = {
        handle: vi.fn((ch: string, fn: MockIpcHandler) => {
          handlers.set(ch, fn);
        }),
        on: vi.fn(),
        removeListener: vi.fn(),
      };
      const browserWindowSpy = vi.fn();
      const vaultOpts = { userDataDir };

      storeSync.saveTokens(
        'steam',
        {
          access_token: 'steam_web_session',
          webapi_token: 'syn_steam_webapi_token_live',
          steamId: '76561198000000002',
          accountName: 'SyntheticSteamLiveUser',
          avatarUrl: 'https://avatars.steamstatic.com/synthetic2.jpg',
        },
        vaultOpts
      );

      let capturedSignal: AbortSignal | undefined;
      let simulateTimeout = true;
      const fetchSpy = vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('GetOwnedGames')) {
          capturedSignal = init?.signal ?? undefined;
          if (simulateTimeout) {
            const timeoutErr = new Error('The operation was aborted due to timeout');
            timeoutErr.name = 'TimeoutError';
            throw timeoutErr;
          }
          return makeJsonRes({
            response: {
              games: [
                {
                  appid: 910002,
                  name: 'Synthetic Online Quest',
                  playtime_forever: 90,
                },
              ],
            },
          });
        }
        if (url.includes('IStoreBrowseService')) {
          return makeJsonRes({ response: { store_items: [] } });
        }
        if (url.includes('GetAchievementsProgress')) {
          return makeJsonRes({ response: { achievement_progress: [] } });
        }
        return makeJsonRes({});
      });

      const saveTokensSpy = vi.fn((storeId: string, data: Record<string, unknown>) =>
        storeSync.saveTokens(storeId, data, vaultOpts)
      );

      registerStoreSyncIpcHandlers({
        ipcMain: mockIpcMain,
        BrowserWindow: browserWindowSpy,
        session: { fromPartition: () => ({ fetch: vi.fn() }) },
        getMainWindow: () => null,
        storeSync: {
          ...storeSync,
          loadSavedTokens: () => storeSync.loadSavedTokens(vaultOpts),
          saveTokens: saveTokensSpy,
          scanLocalSuppressedStorefrontItems: () => [],
        },
        launcherEngine: {},
        options: {
          userDataDir,
          isOnline: () => true,
          fetchFn: fetchSpy,
        },
      });

      const syncHandler = handlers.get('store:sync')!;

      // 1. TimeoutError on GetOwnedGames must NOT spawn hidden Chromium BrowserWindow
      const timeoutRes = (await syncHandler({}, 'steam')) as { success: boolean; games: unknown[] };
      expect(timeoutRes.success).toBe(true);
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(browserWindowSpy).not.toHaveBeenCalled();

      // 2. Online GetOwnedGames refresh writes games ONLY to one_launcher_steam_owned_cache.json, 0 saveTokens calls!
      simulateTimeout = false;
      saveTokensSpy.mockClear();
      const liveRes = (await syncHandler({}, 'steam')) as {
        success: boolean;
        games: Array<{ id: string; title: string }>;
      };
      expect(liveRes.success).toBe(true);
      expect(liveRes.games).toHaveLength(1);
      expect(liveRes.games[0].id).toBe('steam-910002');
      expect(saveTokensSpy).not.toHaveBeenCalled();

      const cachedDiskGames = storeSync.loadSteamOwnedGamesCache({
        ...vaultOpts,
        steamId: '76561198000000002',
      }) as Array<{ id: string }>;
      expect(cachedDiskGames.map((g) => g.id)).toEqual(['steam-910002']);

      // Verify tokens.json itself stays tiny (< 2 KB) without owned games embedded
      const tokensPath = storeSync.getTokensFilePath(vaultOpts);
      expect(fs.statSync(tokensPath).size).toBeLessThan(2048);
    });
  });

  // =========================================================================
  // 2. GOG Non-Enumerable Metadata, Cached gogEnrichedCache & Overlap
  // =========================================================================
  describe('2. GOG Per-Array Metadata & Cached gogEnrichedCache.json', () => {
    it('attaches non-enumerable authoritativeComplete per array and reads per-array metadata in store:sync IPC even if function-static property is mutated concurrently', async () => {
      const fetchOk = vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('/games/stats')) {
          return makeJsonRes({ pages: 1, _embedded: { items: [] } });
        }
        if (url.includes('getFilteredProducts')) {
          return makeJsonRes({
            totalPages: 2,
            products: url.includes('page=1')
              ? [{ id: 810001, title: 'Synthetic GOG Page One', worksOn: { Windows: true } }]
              : [{ id: 810002, title: 'Synthetic GOG Page Two', worksOn: { Windows: true } }],
          });
        }
        return makeJsonRes({});
      });

      const games = (await storeSync.fetchGogOwnedGames('syn_gog_tok', 'SynGogUser', '40001', {
        fetchFn: fetchOk,
      })) as Array<{ id: string }> & { authoritativeComplete?: boolean };

      expect(games.map((g) => g.id)).toEqual(['gog-810001', 'gog-810002']);
      expect(games.authoritativeComplete).toBe(true);
      // Must be non-enumerable so JSON serialization & Object.keys remain clean
      expect(Object.keys(games)).not.toContain('authoritativeComplete');

      // Verify IPC handler trusts per-array non-enumerable `authoritativeComplete` over clobbered function-static flag
      const handlers = new Map<string, MockIpcHandler>();
      const mockIpcMain = {
        handle: vi.fn((ch: string, fn: MockIpcHandler) => {
          handlers.set(ch, fn);
        }),
        on: vi.fn(),
        removeListener: vi.fn(),
      };
      const gogStub = vi.fn(async () => {
        const arr: Array<Record<string, unknown>> = [];
        Object.defineProperty(arr, 'authoritativeComplete', { value: true, enumerable: false });
        Object.defineProperty(arr, 'achievementsMap', { value: { '810001': { unlocked: 1, total: 5 } }, enumerable: false });
        Object.defineProperty(arr, 'suppressedItems', { value: [], enumerable: false });
        // Intentionally clobber legacy static property to simulate a concurrent failing call
        (gogStub as unknown as { lastAuthoritativeComplete: boolean }).lastAuthoritativeComplete = false;
        return arr;
      });

      registerStoreSyncIpcHandlers({
        ipcMain: mockIpcMain,
        BrowserWindow: vi.fn(),
        session: {},
        getMainWindow: () => null,
        storeSync: {
          loadSavedTokens: () => ({ gog: { access_token: 'syn_gog_tok', user_id: '40001' } }),
          fetchGogAccount: async () => ({ username: 'SynGogUser', userId: '40001' }),
          fetchGogOwnedGames: gogStub,
          scanLocalSuppressedStorefrontItems: () => [],
        },
        launcherEngine: {},
      });

      const ipcRes = (await handlers.get('store:sync')!({}, 'gog')) as {
        authoritativeComplete: boolean;
        transientOffline: boolean;
        achievements: Record<string, unknown>;
      };
      expect(ipcRes.authoritativeComplete).toBe(true);
      expect(ipcRes.transientOffline).toBe(false);
      expect(ipcRes.achievements).toHaveProperty('810001');
    });
  });

  // =========================================================================
  // 3. Epic Batched bulk/items & Persistent 7-Day Offer Cache
  // =========================================================================
  describe('3. Epic Batched bulk/items & 7-Day Persistent Offer Cache', () => {
    it('batches up to 50 catalogItemIds per namespace in bulk/items (65 IDs -> 2 HTTP calls instead of 65)', async () => {
      const emptyLegDir = makeTempDir('wave1-epic-bulk-leg-');
      const userDataDir = makeTempDir('wave1-epic-bulk-ud-');
      const totalItems = 65;
      const records = Array.from({ length: totalItems }, (_, idx) => ({
        appName: `SynBulkApp${idx + 1}`,
        namespace: 'syn_ns_shared',
        catalogItemId: `cat_bulk_${String(idx + 1).padStart(3, '0')}`,
        sandboxType: 'PUBLIC',
        metadata: {
          title: 'Live',
          itemType: 'APPLICATION',
          categories: [],
        },
      }));

      const bulkUrls: string[] = [];
      const fetchMock = vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('/playtime/account/')) return makeJsonRes([]);
        if (url.includes('launcher.store.epicgames.com/graphql')) {
          return makeJsonRes({
            data: { PlayerProfile: { playerProfile: { achievementsSummaries: { data: [] } } } },
          });
        }
        if (url.includes('/assets/Mac')) return makeJsonRes([]);
        if (url.includes('/library/api/public/items')) {
          return makeJsonRes({ records, responseMetadata: {} });
        }
        if (url.includes('/bulk/items')) {
          bulkUrls.push(url);
          const parsedUrl = new URL(url);
          const requestedIds = parsedUrl.searchParams.getAll('id');
          const responseObj: Record<string, Record<string, unknown>> = {};
          for (const cid of requestedIds) {
            responseObj[cid] = {
              id: cid,
              title: `Synthetic Bulk Game ${cid}`,
              description: `Valid description for ${cid}`,
              developer: 'Synthetic Studio',
              itemType: 'APPLICATION',
              categories: [{ path: 'games' }],
            };
          }
          return makeJsonRes(responseObj);
        }
        return makeJsonRes({});
      });

      const games = (await storeSync.fetchEpicOwnedGames('syn_epic_tok', 'syn_acct_bulk', {
        fetchFn: fetchMock,
        legendaryBaseDirs: [emptyLegDir],
        userDataDir,
      })) as Array<{ id: string }> & { authoritativeComplete?: boolean };

      expect(games).toHaveLength(totalItems);
      expect(games.authoritativeComplete).toBe(true);
      // 65 IDs in 1 namespace must be batched into 2 requests (50 + 15), NOT 65 requests!
      expect(bulkUrls).toHaveLength(2);
      const batchSizes = bulkUrls
        .map((u) => new URL(u).searchParams.getAll('id').length)
        .sort((a, b) => b - a);
      expect(batchSizes).toEqual([50, 15]);
    });

    it('persists positive results and negative misses for 7 days in one_launcher_epic_offer_cache.json and refreshes after TTL expiry', async () => {
      const userDataDir = makeTempDir('wave1-epic-offer-cache-');
      const emptyLegDir = makeTempDir('wave1-epic-offer-leg-');
      const baseNow = 1_800_000_000_000;
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

      let offersNetworkCalls = 0;
      const fetchMock = vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('/namespace/ns_pos/offers')) {
          offersNetworkCalls += 1;
          return makeJsonRes({
            elements: [
              {
                id: 'offer_pos_1',
                title: 'Synthetic Cached Title',
                offerType: 'BASE_GAME',
                description: `Fresh description call #${offersNetworkCalls}`,
                developerDisplayName: 'Synthetic Dev',
                keyImages: [],
              },
            ],
          });
        }
        if (url.includes('/namespace/ns_miss/offers')) {
          offersNetworkCalls += 1;
          return makeJsonRes({ elements: [] }, 200);
        }
        return makeJsonRes({}, 404);
      });

      const commonOpts = {
        userDataDir,
        legendaryBaseDirs: [emptyLegDir],
        accessToken: 'syn_catalog_tok',
        fetchFn: fetchMock,
      };

      // 1. Positive hit populates one_launcher_epic_offer_cache.json
      const firstPos = (await storeSync.fetchEpicProductOfferMetadata(
        { namespace: 'ns_pos', catalogItemId: 'cat_pos_1', title: 'Synthetic Cached Title' },
        { ...commonOpts, nowMs: baseNow }
      )) as { shortDescription?: string } | null;
      expect(firstPos?.shortDescription).toBe('Fresh description call #1');
      expect(offersNetworkCalls).toBe(1);

      const cacheFile = storeSync.getEpicOfferCachePath({ userDataDir });
      expect(fs.existsSync(cacheFile)).toBe(true);

      // Clear in-memory cache (simulating app restart) -> must serve from disk with 0 network calls within 7d
      storeSync.trimStoreSyncMemory();
      const secondPos = (await storeSync.fetchEpicProductOfferMetadata(
        { namespace: 'ns_pos', catalogItemId: 'cat_pos_1', title: 'Synthetic Cached Title' },
        { ...commonOpts, nowMs: baseNow + 3 * 24 * 60 * 60 * 1000 }
      )) as { shortDescription?: string } | null;
      expect(secondPos?.shortDescription).toBe('Fresh description call #1');
      expect(offersNetworkCalls).toBe(1);

      // 2. Negative miss (empty elements) is also cached for 7 days
      const firstMiss = await storeSync.fetchEpicProductOfferMetadata(
        { namespace: 'ns_miss', catalogItemId: 'cat_miss_1', title: 'Synthetic Missing Offer' },
        { ...commonOpts, nowMs: baseNow }
      );
      expect(firstMiss).toBeNull();
      expect(offersNetworkCalls).toBe(2);

      storeSync.trimStoreSyncMemory();
      const secondMiss = await storeSync.fetchEpicProductOfferMetadata(
        { namespace: 'ns_miss', catalogItemId: 'cat_miss_1', title: 'Synthetic Missing Offer' },
        { ...commonOpts, nowMs: baseNow + 6 * 24 * 60 * 60 * 1000 }
      );
      expect(secondMiss).toBeNull();
      expect(offersNetworkCalls).toBe(2);

      // 3. After 7 days + 1ms, TTL expires and re-fetches from network
      const expiredPos = (await storeSync.fetchEpicProductOfferMetadata(
        { namespace: 'ns_pos', catalogItemId: 'cat_pos_1', title: 'Synthetic Cached Title' },
        { ...commonOpts, nowMs: baseNow + sevenDaysMs + 1 }
      )) as { shortDescription?: string } | null;
      expect(expiredPos?.shortDescription).toBe('Fresh description call #3');
      expect(offersNetworkCalls).toBe(3);
    });
  });

  // =========================================================================
  // 4. Xbox 24h layer3_rejected_at SQLite Migration/Cache & Conditional Token Save
  // =========================================================================
  describe('4. Xbox 24h layer3_rejected_at Cache & Conditional saveTokensAsync', () => {
    it('migrates legacy xbox_catalog_cache_v1.sqlite via ALTER TABLE and suppresses bypassCache re-fetches for Layer-3 rejected SKUs for 24h', async () => {
      const userDataDir = makeTempDir('wave1-xbox-l3-');
      const dbPath = path.join(userDataDir, 'xbox_catalog_cache_v1.sqlite');

      // Seed a legacy v1 SQLite DB WITHOUT `layer3_rejected_at` column to prove guarded ALTER TABLE migration
      const legacyDb = new DatabaseSync(dbPath);
      legacyDb.exec(`
        CREATE TABLE sigl_snapshots (
          cache_key TEXT PRIMARY KEY,
          etag TEXT,
          sha256 TEXT,
          ids_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL
        );
        CREATE TABLE display_catalog_products (
          cache_key TEXT PRIMARY KEY,
          big_id TEXT NOT NULL,
          market TEXT NOT NULL,
          product_json BLOB NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE sync_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      legacyDb.close();

      // Opening cache store must safely add `layer3_rejected_at`
      const store = xboxCatalog.openXboxCatalogCacheStore({ userDataDir });
      expect(store).toBeDefined();

      const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
      const cols = verifyDb.prepare('PRAGMA table_info(display_catalog_products)').all();
      verifyDb.close();
      expect(cols.some((c) => c.name === 'layer3_rejected_at')).toBe(true);

      const BIGID_CONSOLE_ONLY = '9SYNCONSOL01';
      const BIGID_PC_ALLOWED = '9SYNPCDESK01';
      const now0 = 1_800_000_000_000;
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;

      const pcAllowedProduct = {
        ProductId: BIGID_PC_ALLOWED,
        ProductKind: 'Game',
        LocalizedProperties: [
          {
            Language: 'en-US',
            ProductTitle: 'Synthetic PC Game Pass Title',
            DeveloperName: 'Synthetic Xbox Studio',
            PublisherName: 'Synthetic Xbox Pub',
            Images: [],
          },
        ],
        Properties: { Category: 'Action & adventure' },
        MarketProperties: [{ OriginalReleaseDate: '2025-01-01T00:00:00Z' }],
        DisplaySkuAvailabilities: [
          {
            Sku: {
              SkuId: '0010',
              Properties: {
                Packages: [
                  {
                    PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }],
                    PackageFamilyName: 'SynStudio.PcGame_1234567890abc',
                    Architectures: ['X64'],
                    MaxDownloadSizeInBytes: 5_000_000_000,
                  },
                ],
              },
            },
            Availabilities: [
              {
                Actions: ['License', 'Details'],
                Conditions: {
                  StartDate: '2020-01-01T00:00:00Z',
                  EndDate: '2099-01-01T00:00:00Z',
                  ClientConditions: { AllowedPlatforms: [{ PlatformName: 'Windows.Desktop' }] },
                },
                RemediationRequired: true,
                OrderManagementData: { Price: { ListPrice: 0, MSRP: 39.99 } },
                Properties: {
                  OriginalReleaseDate: '2025-01-01T00:00:00Z',
                  MerchandisingTags: ['LegacyDiscountGold'],
                },
                LicensingData: {
                  SatisfyingEntitlementKeys: [
                    {
                      EntitlementKeys: ['CFQ7TTC0KGQ8'],
                      LicensingKeyIds: [],
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      // Present in SIGL feed, has Windows.Desktop package, but ONLY grants CFQ7TTC0KHS0 (Ultimate) while user has PC Game Pass (CFQ7TTC0KGQ8) -> fails Layer-3!
      const layer3IneligibleProduct = {
        ProductId: BIGID_CONSOLE_ONLY,
        ProductKind: 'Game',
        LocalizedProperties: [
          {
            Language: 'en-US',
            ProductTitle: 'Synthetic Ineligible Tier SKU',
            DeveloperName: 'Synthetic Studio',
            PublisherName: 'Synthetic Pub',
            Images: [],
          },
        ],
        Properties: { Category: 'Action & adventure' },
        DisplaySkuAvailabilities: [
          {
            Sku: {
              SkuId: '0010',
              Properties: {
                Packages: [
                  {
                    PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }],
                    PackageFamilyName: 'SynStudio.Ineligible_1234567890abc',
                    Architectures: ['X64'],
                    MaxDownloadSizeInBytes: 4_000_000_000,
                  },
                ],
              },
            },
            Availabilities: [
              {
                Actions: ['License'],
                Conditions: {
                  StartDate: '2020-01-01T00:00:00Z',
                  EndDate: '2099-01-01T00:00:00Z',
                  ClientConditions: { AllowedPlatforms: [{ PlatformName: 'Windows.Desktop' }] },
                },
                LicensingData: {
                  SatisfyingEntitlementKeys: [
                    {
                      EntitlementKeys: ['CFQ7TTC0KHS0'], // Ultimate-only; user only holds PC Game Pass CFQ7TTC0KGQ8
                      LicensingKeyIds: [],
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const displayCatalogRequests: string[] = [];
      const mockFetch = vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('collections.mp.microsoft.com')) {
          let bodyObj: { productTypes?: string[] } = {};
          try {
            bodyObj = JSON.parse(String(init?.body || '{}')) as { productTypes?: string[] };
          } catch {}
          if (
            Array.isArray(bodyObj.productTypes) &&
            bodyObj.productTypes.length === 1 &&
            bodyObj.productTypes[0] === 'Pass'
          ) {
            return makeJsonRes({
              items: [
                {
                  productId: 'CFQ7TTC0KGQ8',
                  productKind: 'Pass',
                  status: 'Active',
                  endDate: '2099-01-01T00:00:00Z',
                  autoRenew: true,
                },
              ],
            });
          }
          return makeJsonRes({ items: [] });
        }
        if (url.includes('catalog.gamepass.com/sigls')) {
          return makeJsonRes([
            { siglId: 'fdd9e2a7-0fee-49f6-ad69-4354098401ff' },
            { id: BIGID_PC_ALLOWED },
            { id: BIGID_CONSOLE_ONLY },
          ]);
        }
        if (url.includes('displaycatalog.mp.microsoft.com/v7.0/products')) {
          displayCatalogRequests.push(url);
          const ids = (new URL(url).searchParams.get('bigIds') || '').split(',');
          const products = [];
          if (ids.includes(BIGID_PC_ALLOWED)) products.push(pcAllowedProduct);
          if (ids.includes(BIGID_CONSOLE_ONLY)) products.push(layer3IneligibleProduct);
          return makeJsonRes({ Products: products });
        }
        return makeJsonRes({});
      });

      const sharedSyncOpts = {
        storeToken: 'syn_xbox_store_token',
        collectionsToken: 'syn_xbox_collections_token',
        syncMode: 'full_pc_game_pass',
        market: 'US',
        locale: 'en-US',
        userDataDir,
        checkMinecraftJava: false,
        fetchImpl: mockFetch,
      };

      // Sync #1 (cold): hydrates both products; Layer-3 rejects BIGID_CONSOLE_ONLY and stamps layer3_rejected_at
      const sync1 = await xboxCatalog.syncXboxCatalog({ ...sharedSyncOpts, nowMs: now0 });
      expect(sync1.games.map((g: { id: string }) => g.id)).toEqual([`xbox-${BIGID_PC_ALLOWED}`]);
      expect(displayCatalogRequests).toHaveLength(1);

      // Sync #2 (1 hour later): MUST NOT re-fetch BIGID_CONSOLE_ONLY via bypassCache: true!
      displayCatalogRequests.length = 0;
      const sync2 = await xboxCatalog.syncXboxCatalog({
        ...sharedSyncOpts,
        cachedSubscription: sync1.subscription,
        nowMs: now0 + 60 * 60 * 1000,
      });
      expect(sync2.games.map((g: { id: string }) => g.id)).toEqual([`xbox-${BIGID_PC_ALLOWED}`]);
      expect(displayCatalogRequests).toHaveLength(0);

      // Sync #3 (> 24 hours later): TTL expired -> re-checks BIGID_CONSOLE_ONLY once!
      displayCatalogRequests.length = 0;
      const sync3 = await xboxCatalog.syncXboxCatalog({
        ...sharedSyncOpts,
        cachedSubscription: sync1.subscription,
        nowMs: now0 + twentyFourHoursMs + 1000,
      });
      expect(sync3.games.map((g: { id: string }) => g.id)).toEqual([`xbox-${BIGID_PC_ALLOWED}`]);
      expect(displayCatalogRequests).toHaveLength(1);
      expect(displayCatalogRequests[0]).toContain(BIGID_CONSOLE_ONLY);

      // Sync #4 (immediately after Sync #3 with forceRefresh: true): bypasses 24h rejection cache!
      displayCatalogRequests.length = 0;
      await xboxCatalog.syncXboxCatalog({
        ...sharedSyncOpts,
        cachedSubscription: sync1.subscription,
        forceRefresh: true,
        nowMs: now0 + twentyFourHoursMs + 5000,
      });
      expect(displayCatalogRequests.some((u) => u.includes(BIGID_CONSOLE_ONLY))).toBe(true);
    });

    it('skips redundant saveTokensAsync("xbox", ...) in syncXboxLibrary when profile/subscription fields are unchanged', async () => {
      const userDataDir = makeTempDir('wave1-xbox-notokenwrite-');
      const vaultOpts = { userDataDir };

      const mockAuthProvider = {
        getValidXboxSession: vi.fn(async () => ({
          xuid: '2535400000000001',
          gamertag: 'SyntheticXboxPlayer',
          modernGamertag: 'SyntheticXboxPlayer',
          gamerpicUrl: 'https://images-eds-ssl.xboxlive.com/syn.png',
          gamerscore: 1500,
          authorizationHeader: 'XBL3.0 x=uhs;token',
        })),
        getStoreMsaToken: vi.fn(async () => 'syn_msa_token'),
        getValidStoreToken: vi.fn(async () => 'syn_col_token'),
      };

      const fetchMock = vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('titlehub.xboxlive.com')) return makeJsonRes({ titles: [] });
        if (url.includes('collections.mp.microsoft.com')) return makeJsonRes({ items: [] });
        if (url.includes('catalog.gamepass.com')) return makeJsonRes([]);
        return makeJsonRes({});
      });

      // Run #1: cold vault -> persists xbox tokens once
      await storeSync.syncXboxLibrary({
        userDataDir,
        authProviderOverride: mockAuthProvider,
        fetchFn: fetchMock,
        market: 'US',
        locale: 'en-US',
      });

      const tokensPath = storeSync.getTokensFilePath(vaultOpts);
      const firstStat = fs.statSync(tokensPath);

      // Wait briefly to ensure any write would alter mtimeMs, and spy on vault change events
      await new Promise((r) => setTimeout(r, 25));
      let xboxWriteCount = 0;
      const unsub = storeSync.onVaultChange((evt: { storefrontId?: string }) => {
        if (evt.storefrontId === 'xbox') xboxWriteCount += 1;
      });

      try {
        // Run #2: identical Xbox profile/subscription -> MUST NOT rewrite tokens.json!
        await storeSync.syncXboxLibrary({
          userDataDir,
          authProviderOverride: mockAuthProvider,
          fetchFn: fetchMock,
          market: 'US',
          locale: 'en-US',
        });
      } finally {
        unsub();
      }

      const secondStat = fs.statSync(tokensPath);
      expect(xboxWriteCount).toBe(0);
      expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
    });
  });

  // =========================================================================
  // 5. Single-Game Scoped Post-Exit Achievement Endpoints (GOG / Epic / Xbox)
  // =========================================================================
  describe('5. Single-Game Scoped Achievement Endpoints (GOG, Epic, Xbox)', () => {
    it('GOG fetchGogAchievements & IPC make 1 targeted gameplay call when productId/gameId is given, and keep full pagination when omitted', async () => {
      const requestedUrls: string[] = [];
      const fetchMock = vi.fn(async (input: string) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.includes('gameplay.gog.com/clients/777001/users/99001/achievements')) {
          return makeJsonRes({
            items: [
              { id: 'a1', date_unlocked: '2026-01-01T00:00:00Z' },
              { id: 'a2', date_unlocked: null },
            ],
          });
        }
        if (url.includes('/games/stats')) {
          return makeJsonRes({ pages: 1, _embedded: { items: [] } });
        }
        return makeJsonRes({}, 404);
      });

      const scoped = await storeSync.fetchGogAchievements('syn_gog_tok', 'SynUser', '99001', {
        productId: 'gog-777001',
        title: 'Synthetic GOG Quest',
        fetchFn: fetchMock,
      });

      expect(requestedUrls).toHaveLength(1);
      expect(requestedUrls[0]).toContain('gameplay.gog.com/clients/777001/users/99001/achievements');
      expect(requestedUrls.some((u) => u.includes('/games/stats'))).toBe(false);
      expect(scoped.achievements['777001']).toMatchObject({ unlocked: 1, total: 2, percentage: 50 });
      expect(scoped.achievements['gog-777001']).toMatchObject({ unlocked: 1, total: 2 });

      // Full-account fallback when no filter is supplied
      requestedUrls.length = 0;
      await storeSync.fetchGogAchievements('syn_gog_tok', 'SynUser', '99001', {
        fetchFn: fetchMock,
      });
      expect(requestedUrls.some((u) => u.includes('sort=percent_of_unlocked_achievements'))).toBe(true);
      expect(requestedUrls.some((u) => u.includes('sort=recent_playtime'))).toBe(true);

      // Verify IPC handler forwards productId/gameId and skips redundant fetchGogAccount when userId is saved
      const handlers = new Map<string, MockIpcHandler>();
      const fetchGogAccSpy = vi.fn(async () => ({ username: 'SynUser', userId: '99001' }));
      const fetchGogAchSpy = vi.fn(async () => ({ achievements: { '777001': { unlocked: 1, total: 2 } }, stats: new Map() }));
      registerStoreSyncIpcHandlers({
        ipcMain: {
          handle: (ch: string, fn: MockIpcHandler) => handlers.set(ch, fn),
          on: vi.fn(),
          removeListener: vi.fn(),
        },
        BrowserWindow: vi.fn(),
        session: {},
        getMainWindow: () => null,
        storeSync: {
          loadSavedTokens: () => ({ gog: { access_token: 'syn_gog_tok', user_id: '99001', username: 'SynUser' } }),
          fetchGogAccount: fetchGogAccSpy,
          fetchGogAchievements: fetchGogAchSpy,
        },
        launcherEngine: {},
      });

      await handlers.get('gog:fetch-achievements')!({}, { productId: '777001' });
      expect(fetchGogAccSpy).not.toHaveBeenCalled();
      expect(fetchGogAchSpy).toHaveBeenCalledWith('syn_gog_tok', 'SynUser', '99001', {
        productId: '777001',
      });
    });

    it('Epic fetchEpicAchievements & IPC send 1 targeted single-sandbox GraphQL query when sandboxId/namespace/appName is supplied', async () => {
      const emptyLegDir = makeTempDir('wave1-epic-ach-leg-');
      const sentBodies: Array<{ query: string; variables: Record<string, unknown> }> = [];

      const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}')) as {
          query: string;
          variables: Record<string, unknown>;
        };
        sentBodies.push(body);
        if (body.query.includes('productAchievements(sandboxId: $sandboxId)')) {
          return makeJsonRes({
            data: {
              PlayerProfile: {
                playerProfile: {
                  epicAccountId: 'syn_epic_acct',
                  productAchievements: {
                    data: {
                      totalUnlocked: 3,
                      totalXP: 150,
                      sandboxId: 'sb_target_001',
                      product: { name: 'Synthetic Epic Action', slug: 'synthetic-epic-action' },
                      productAchievements: { totalAchievements: 10, totalProductXP: 1000 },
                    },
                  },
                },
              },
            },
          });
        }
        return makeJsonRes({
          data: {
            PlayerProfile: {
              playerProfile: {
                achievementsSummaries: {
                  data: [
                    {
                      totalUnlocked: 1,
                      totalXP: 50,
                      sandboxId: 'sb_other_999',
                      product: { name: 'Synthetic Other Game', slug: 'other' },
                      productAchievements: { totalAchievements: 20, totalProductXP: 1000 },
                    },
                  ],
                },
              },
            },
          },
        });
      });

      // Scoped call -> 1 single-sandbox query
      const scoped = await storeSync.fetchEpicAchievements('syn_epic_tok', 'syn_epic_acct', {
        sandboxId: 'sb_target_001',
        appName: 'SynEpicApp001',
        legendaryBaseDirs: [emptyLegDir],
        fetchFn: fetchMock,
      });
      expect(sentBodies).toHaveLength(1);
      expect(sentBodies[0].query).toContain('productAchievements(sandboxId: $sandboxId)');
      expect(sentBodies[0].variables.sandboxId).toBe('sb_target_001');
      expect(scoped['sb_target_001']).toMatchObject({ unlocked: 3, total: 10, percentage: 30 });
      expect(scoped['synepicapp001']).toMatchObject({ unlocked: 3, total: 10 });
      expect(scoped['epic-synepicapp001']).toMatchObject({ unlocked: 3, total: 10 });

      // Unscoped call -> full achievementsSummaries query
      sentBodies.length = 0;
      const full = await storeSync.fetchEpicAchievements('syn_epic_tok', 'syn_epic_acct', {
        legendaryBaseDirs: [emptyLegDir],
        fetchFn: fetchMock,
      });
      expect(sentBodies).toHaveLength(1);
      expect(sentBodies[0].query).toContain('achievementsSummaries');
      expect(full['sb_other_999']).toMatchObject({ unlocked: 1, total: 20 });

      // Verify IPC handler forwards sandboxId/namespace/appName
      const handlers = new Map<string, MockIpcHandler>();
      const fetchEpicAchSpy = vi.fn(async () => ({ sb_target_001: { unlocked: 3, total: 10 } }));
      registerStoreSyncIpcHandlers({
        ipcMain: {
          handle: (ch: string, fn: MockIpcHandler) => handlers.set(ch, fn),
          on: vi.fn(),
          removeListener: vi.fn(),
        },
        BrowserWindow: vi.fn(),
        session: {},
        getMainWindow: () => null,
        storeSync: {
          loadSavedTokens: () => ({ epic: { access_token: 'syn_epic_tok', account_id: 'syn_epic_acct' } }),
          fetchEpicAchievements: fetchEpicAchSpy,
        },
        launcherEngine: {},
      });

      await handlers.get('epic:fetch-achievements')!({}, { sandboxId: 'sb_target_001', appName: 'SynEpicApp001' });
      expect(fetchEpicAchSpy).toHaveBeenCalledWith('syn_epic_tok', 'syn_epic_acct', {
        sandboxId: 'sb_target_001',
        appName: 'SynEpicApp001',
      });
    });

    it('Xbox fetchXboxAchievements & IPC fetch ONLY the target titleId when supplied, and full titlehistory when omitted', async () => {
      const requestedUrls: string[] = [];
      const mockAuthProvider = {
        getValidXboxSession: vi.fn(async () => ({
          xuid: '2535400000000099',
          authorizationHeader: 'XBL3.0 x=uhs;tok',
        })),
      };
      const fetchMock = vi.fn(async (input: string) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.includes('achievements.xboxlive.com') && url.includes('titleId=123456789')) {
          return makeJsonRes({
            achievements: [
              {
                id: '1',
                name: 'First Step',
                progressState: 'Achieved',
                progression: { timeUnlocked: '2026-02-01T12:00:00Z' },
                rewards: [{ type: 'Gamerscore', value: '50' }],
              },
              {
                id: '2',
                name: 'Second Step',
                progressState: 'NotStarted',
                rewards: [{ type: 'Gamerscore', value: '50' }],
              },
            ],
          });
        }
        if (url.includes('titlehub.xboxlive.com')) {
          return makeJsonRes({
            titles: [
              {
                titleId: '987654321',
                modernTitleId: '9SYNALL00001',
                name: 'Synthetic Full Account Xbox Game',
                achievement: {
                  currentAchievements: 4,
                  totalAchievements: 10,
                  currentGamerscore: 200,
                  totalGamerscore: 1000,
                },
              },
            ],
          });
        }
        return makeJsonRes({});
      });

      // 1. Single-game scoped call by titleId -> 1 targeted achievements call, ZERO titlehistory calls!
      const scoped = await storeSync.fetchXboxAchievements({
        titleId: '123456789',
        productId: '9SYNTARGET01',
        authProviderOverride: mockAuthProvider,
        fetchFn: fetchMock,
      });
      expect(requestedUrls).toHaveLength(1);
      expect(requestedUrls[0]).toContain('achievements.xboxlive.com');
      expect(requestedUrls[0]).toContain('titleId=123456789');
      expect(requestedUrls.some((u) => u.includes('titlehistory'))).toBe(false);
      expect(scoped['123456789']).toMatchObject({
        unlocked: 1,
        total: 2,
        percentage: 50,
        gamerscore: { earned: 50, total: 100 },
      });
      expect(scoped['9SYNTARGET01']).toMatchObject({ unlocked: 1, total: 2 });
      expect(scoped['xbox-9SYNTARGET01']).toMatchObject({ unlocked: 1, total: 2 });

      // 2. Unscoped call (`{}`) -> full TitleHub titlehistory behavior preserved
      requestedUrls.length = 0;
      const full = await storeSync.fetchXboxAchievements({
        authProviderOverride: mockAuthProvider,
        fetchFn: fetchMock,
      });
      expect(requestedUrls.some((u) => u.includes('titlehistory'))).toBe(true);
      expect(full['9SYNALL00001']).toMatchObject({ unlocked: 4, total: 10 });
    });
  });

  // =========================================================================
  // 6. Async Non-Blocking installedGameScanner Parity & Deduplication
  // =========================================================================
  describe('6. Non-Blocking installedGameScannerAsync Parity & Single-Call Deduplication', () => {
    it('produces exact parity with scanAllInstalledGames across 30+ installed games, yields to the event loop, and invokes detectCompatibilityLayers & collectLocalEpicMetadataAndSupport at most once', async () => {
      const rootDir = makeTempDir('wave1-scanner-parity-');
      const homedir = path.join(rootDir, 'home');
      const userDataDir = path.join(rootDir, 'userdata');
      const steamappsDir = path.join(homedir, 'Library/Application Support/Steam/steamapps');
      const gogGamesDir = path.join(homedir, 'Games/OneLauncher/GOG');
      const epicManifestsDir = path.join(
        homedir,
        'Library/Application Support/Epic/EpicGamesLauncher/Data/Manifests'
      );
      const appsDir = path.join(rootDir, 'Applications');
      fs.mkdirSync(steamappsDir, { recursive: true });
      fs.mkdirSync(gogGamesDir, { recursive: true });
      fs.mkdirSync(epicManifestsDir, { recursive: true });
      fs.mkdirSync(appsDir, { recursive: true });
      fs.mkdirSync(userDataDir, { recursive: true });

      // Create 20 Steam games, 8 GOG games, and 6 Epic games = 34 installed games
      for (let i = 1; i <= 20; i++) {
        const appId = 950000 + i;
        const folderName = `SynthSteamGame${i}`;
        const gameDir = path.join(steamappsDir, 'common', folderName);
        fs.mkdirSync(gameDir, { recursive: true });
        fs.writeFileSync(path.join(gameDir, `SynthSteamGame${i}.exe`), 'MZ_SYNTHETIC', 'utf8');
        fs.writeFileSync(
          path.join(steamappsDir, `appmanifest_${appId}.acf`),
          `"AppState" {\n  "appid" "${appId}"\n  "name" "Synthetic Steam Game ${i}"\n  "installdir" "${folderName}"\n  "StateFlags" "4"\n  "SizeOnDisk" "1048576"\n}\n`,
          'utf8'
        );
      }

      for (let i = 1; i <= 8; i++) {
        const gogId = String(850000 + i);
        const gameDir = path.join(gogGamesDir, `SynthGogGame${i}`);
        fs.mkdirSync(gameDir, { recursive: true });
        fs.writeFileSync(path.join(gameDir, `SynthGogGame${i}.exe`), 'MZ_SYNTHETIC', 'utf8');
        fs.writeFileSync(
          path.join(gameDir, `goggame-${gogId}.info`),
          JSON.stringify({
            gameId: gogId,
            name: `Synthetic GOG Game ${i}`,
            playTasks: [{ path: `SynthGogGame${i}.exe`, isPrimary: true, type: 'FileTask' }],
          }),
          'utf8'
        );
      }

      for (let i = 1; i <= 6; i++) {
        const appName = `SynthEpicApp${i}`;
        const gameDir = path.join(homedir, 'Games', appName);
        fs.mkdirSync(gameDir, { recursive: true });
        fs.writeFileSync(path.join(gameDir, `${appName}.exe`), 'MZ_SYNTHETIC', 'utf8');
        fs.writeFileSync(
          path.join(epicManifestsDir, `${appName}.item`),
          JSON.stringify({
            AppName: appName,
            DisplayName: `Synthetic Epic Game ${i}`,
            InstallLocation: gameDir,
            LaunchExecutable: `${appName}.exe`,
            InstallSize: 2097152,
          }),
          'utf8'
        );
      }

      const scanOpts = {
        platform: 'darwin',
        homedir,
        userDataDir,
        customApplicationsDir: appsDir,
        skipFirstPartySync: true,
      };

      const detectLayersSpy = vi.spyOn(macNativeInstaller, 'detectCompatibilityLayers');
      const collectEpicMetaSpy = vi.spyOn(epicCoordinator, 'collectLocalEpicMetadataAndSupport');

      // 1. Run synchronous scan
      const syncResult = installedGameScanner.scanAllInstalledGames(scanOpts);
      expect(syncResult.success).toBe(true);
      expect(syncResult.installedGames).toHaveLength(34);
      expect(detectLayersSpy).toHaveBeenCalledTimes(1);
      expect(collectEpicMetaSpy).toHaveBeenCalledTimes(1);

      // 2. Run async scan and verify event-loop yields interleave with scan progress
      detectLayersSpy.mockClear();
      collectEpicMetaSpy.mockClear();

      let interleavedTicks = 0;
      let scanDone = false;
      const tickProbe = () => {
        if (!scanDone) {
          interleavedTicks += 1;
          setImmediate(tickProbe);
        }
      };
      setImmediate(tickProbe);

      const asyncResult = await installedGameScanner.scanAllInstalledGamesAsync(scanOpts);
      scanDone = true;

      expect(asyncResult.success).toBe(true);
      expect(asyncResult.installedGames).toHaveLength(34);
      expect(interleavedTicks).toBeGreaterThanOrEqual(5);
      expect(detectLayersSpy).toHaveBeenCalledTimes(1);
      expect(collectEpicMetaSpy).toHaveBeenCalledTimes(1);

      // Strict parity between sync and async discovered records & Steam AppIDs
      const normalizeRecords = (list: Array<{ platformId: string; platformGameId: string; title: string; executablePath?: string }>) =>
        list
          .map((g) => ({
            platformId: g.platformId,
            platformGameId: g.platformGameId,
            title: g.title,
            executablePath: g.executablePath,
          }))
          .sort((a, b) =>
            `${a.platformId}:${a.platformGameId}`.localeCompare(`${b.platformId}:${b.platformGameId}`)
          );

      expect(normalizeRecords(asyncResult.installedGames)).toEqual(
        normalizeRecords(syncResult.installedGames)
      );
      expect([...asyncResult.installedSteamAppIds].sort((a, b) => a - b)).toEqual(
        [...syncResult.installedSteamAppIds].sort((a, b) => a - b)
      );
    });
  });

  // =========================================================================
  // 7. 24-Hour Persisted checkCompatibilityLayerUpdates TTL in environmentHealthProber
  // =========================================================================
  describe('7. 24-Hour Persisted Runner Update Check Cache in environmentHealthProber', () => {
    it('caches checkCompatibilityLayerUpdates for 24h in one_launcher_runner_update_check_cache.json, serves across restarts, and refreshes on forceRefresh or >24h expiry', async () => {
      const rootDir = makeTempDir('wave1-prober-ttl-');
      const homedir = path.join(rootDir, 'home');
      const userDataDir = path.join(rootDir, 'userdata');
      fs.mkdirSync(homedir, { recursive: true });
      fs.mkdirSync(userDataDir, { recursive: true });

      const syntheticLayers = [
        {
          id: 'wine',
          type: 'wine',
          name: 'Open-Source Wine',
          available: true,
          version: '11.18',
          binaryPath: path.join(rootDir, 'Wine.app/Contents/Resources/wine/bin/wine64'),
          appPath: path.join(rootDir, 'Wine.app'),
        },
      ];

      let checkCalls = 0;
      const mockCheckUpdates = vi.fn(async () => {
        checkCalls += 1;
        return {
          wine: {
            runnerType: 'wine',
            installedVersion: '11.18',
            latestVersion: checkCalls === 1 ? '11.21' : '11.22',
            updateAvailable: true,
            canAutoUpdate: true,
          },
        };
      });

      const baseNow = 1_800_000_000_000;
      const twentyFourHoursMs = environmentHealthProber.PROBER_RUNNER_UPDATES_TTL_MS;
      expect(twentyFourHoursMs).toBe(24 * 60 * 60 * 1000);

      const baseProbeOpts = {
        platform: 'darwin',
        arch: 'arm64',
        homedir,
        userDataDir,
        rosettaInstalled: true,
        savedTokens: {},
        connectedStorefronts: [],
        layers: syntheticLayers,
        checkCompatibilityLayerUpdatesFn: mockCheckUpdates,
      };

      // 1. Cold check invokes checkCompatibilityLayerUpdates once and writes cache file
      const probe1 = await environmentHealthProber.probeEnvironmentHealth({
        ...baseProbeOpts,
        nowMs: baseNow,
      });
      expect(checkCalls).toBe(1);
      expect(probe1.components.runner_wine.status).toBe('update_available');
      expect(probe1.components.runner_wine.latestVersion).toBe('11.21');

      const cachePath = environmentHealthProber.getRunnerUpdateCheckCachePath(userDataDir);
      expect(fs.existsSync(cachePath)).toBe(true);

      // 2. Simulate app restart (clear in-memory cache ONLY) -> 12h later still hits disk cache with 0 network checks!
      environmentHealthProber.invalidateProberRunnerUpdatesCache({ memoryOnly: true });
      const probe2 = await environmentHealthProber.probeEnvironmentHealth({
        ...baseProbeOpts,
        nowMs: baseNow + 12 * 60 * 60 * 1000,
      });
      expect(checkCalls).toBe(1);
      expect(probe2.components.runner_wine.latestVersion).toBe('11.21');

      // 3. forceRefresh: true bypasses 24h cache and re-fetches immediately
      const probe3 = await environmentHealthProber.probeEnvironmentHealth({
        ...baseProbeOpts,
        nowMs: baseNow + 12 * 60 * 60 * 1000 + 1000,
        forceRefresh: true,
      });
      expect(checkCalls).toBe(2);
      expect(probe3.components.runner_wine.latestVersion).toBe('11.22');

      // 4. Advancing clock past 24h TTL triggers a fresh check automatically
      environmentHealthProber.invalidateProberRunnerUpdatesCache({ memoryOnly: true });
      await environmentHealthProber.probeEnvironmentHealth({
        ...baseProbeOpts,
        nowMs: baseNow + 12 * 60 * 60 * 1000 + 1000 + twentyFourHoursMs + 1,
      });
      expect(checkCalls).toBe(3);
    });
  });
});
