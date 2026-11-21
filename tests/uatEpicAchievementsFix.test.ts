import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { CanonicalGame } from '../src/contracts/game';
import type { MultiStoreAchievementsMap } from '../src/contracts/achievement';
import type { ElectronAPI } from '../src/types/electron';
import { achievementDetailService } from '../src/services/achievements/achievementDetailService';
import { fetchEpicDetailedAchievementsProvider } from '../src/services/achievements/epicAchievementProvider';
import {
  achievementSummaryStore,
} from '../src/services/storage/knownGameAchievementsStore';
import { getKnownEpicAchievements } from '../src/services/storage/knownGameAchievements';
import {
  hasHigherPlatformUnlockedSummary,
  resolveNoAchievementsSubtitle,
  shouldSwrRevalidateMap,
} from '../src/components/Achievements/achievementsModalTypes';
import { epicIntegration } from '../src/services/integrations/epicIntegration';

const nodeRequire = createRequire(import.meta.url);

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
  };
}

interface RegisterStoreSyncIpcFn {
  (deps: Record<string, unknown>): void;
}
const { registerStoreSyncIpcHandlers } = nodeRequire(
  '../electron/ipc/storeSyncIpcHandlers.cjs'
) as { registerStoreSyncIpcHandlers: RegisterStoreSyncIpcFn };

interface MockJsonResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function makeMockJsonResponse(body: unknown, status = 200): MockJsonResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

interface EpicStoreSyncModule {
  isEpicGraphqlPlayerNotFound: (json: unknown) => boolean;
  isEpicGraphqlAuthFailure: (status: number, json: unknown) => boolean;
  fetchEpicPublicAchievementSchema: (
    sandboxId: string,
    options?: Record<string, unknown>
  ) => Promise<{
    productId: string;
    sandboxId: string;
    totalAchievements: number;
    totalProductXP: number;
    rawAchievements: unknown[];
    definitiveNotFound: boolean;
  } | null>;
  fetchEpicDetailedGameAchievements: (
    payload?: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<{
    storefrontId: string;
    total: number;
    unlocked: number;
    percentage: number;
    totalXp?: number;
    earnedXp?: number;
    source: string;
    unlockPrecision?: string;
    supportsAchievements?: boolean;
    achievements: Array<{
      id: string;
      apiName: string;
      name: string;
      unlocked: boolean;
      xp?: number;
    }>;
  } | null>;
  fetchEpicAchievements: (
    accessToken: string,
    accountId: string,
    options?: Record<string, unknown>
  ) => Promise<
    Record<
      string,
      {
        unlocked: number;
        total: number;
        percentage: number;
        xp?: { earned: number; total: number };
        source?: string;
      }
    >
  >;
  enrichEpicPublicAchievementSummaries: (
    targets: Array<Record<string, unknown> | string>,
    achievementsMap: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  getEpicPublicAchievementCachePath: (options?: Record<string, unknown>) => string;
  fetchEpicOwnedGames: (
    accessToken: string,
    accountId: string,
    options?: Record<string, unknown>
  ) => Promise<
    Array<{
      id: string;
      title: string;
      platforms: Array<{
        platformId: string;
        platformGameId: string;
        namespace?: string;
        achievements?: { unlocked: number; total: number; xp?: { earned: number; total: number } };
      }>;
    }>
  >;
  trimStoreSyncMemory: () => void;
}

const storeSync = nodeRequire('../electron/storeSync.cjs') as EpicStoreSyncModule;

const createdDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

describe('UAT Epic Games Achievements Fix — 0-Earned Trophies, Public Schema Enrichment & Stale 0/0 Self-Heal', () => {
  const origWindowDesc = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const origLocalStorageDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  beforeEach(() => {
    storeSync.trimStoreSyncMemory();
    achievementDetailService.clearCache();
    achievementSummaryStore.resetForTests('epic');
    const memStorage = createMemoryStorage();
    const fakeWindow: Record<string, unknown> = {
      localStorage: memStorage,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    Object.defineProperty(globalThis, 'window', {
      value: fakeWindow,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      value: memStorage,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    storeSync.trimStoreSyncMemory();
    achievementDetailService.clearCache();
    achievementSummaryStore.resetForTests('epic');
    if (origWindowDesc) {
      Object.defineProperty(globalThis, 'window', origWindowDesc);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
    if (origLocalStorageDesc) {
      Object.defineProperty(globalThis, 'localStorage', origLocalStorageDesc);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop();
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  });

  it('classifies Epic GraphQL ServiceError { status: 404 } as authoritative 0-trophy PlayerNotFound, NOT an auth failure', () => {
    const notFoundResp = {
      data: {
        PlayerProfile: {
          playerProfile: {
            productAchievements: {
              __typename: 'ServiceError',
              status: 404,
              message: 'Request failed with status code 404',
            },
          },
        },
      },
    };
    expect(storeSync.isEpicGraphqlPlayerNotFound(notFoundResp)).toBe(true);
    expect(storeSync.isEpicGraphqlAuthFailure(200, notFoundResp)).toBe(false);

    // Real auth failures (C7 legacy ServiceError without status, 401/403 ServiceError, UNAUTHENTICATED errors) remain detected
    const legacyAuthServiceError = {
      data: {
        PlayerProfile: {
          playerProfile: {
            productAchievements: { __typename: 'ServiceError' },
          },
        },
      },
    };
    const unauthorizedServiceError = {
      data: {
        PlayerProfile: {
          playerProfile: {
            productAchievements: {
              __typename: 'ServiceError',
              status: 401,
              message: 'Unauthorized',
            },
          },
        },
      },
    };
    expect(storeSync.isEpicGraphqlPlayerNotFound(legacyAuthServiceError)).toBe(false);
    expect(storeSync.isEpicGraphqlAuthFailure(200, legacyAuthServiceError)).toBe(true);
    expect(storeSync.isEpicGraphqlAuthFailure(200, unauthorizedServiceError)).toBe(true);
    expect(storeSync.isEpicGraphqlAuthFailure(401, {})).toBe(true);
  });

  it('fetchEpicDetailedGameAchievements returns authoritative live_cloud 0/N + 0/1000 XP with ZERO spurious token renewals on Epic 404 ServiceError', async () => {
    const vaultDir = makeTempDir('uat-epic-zero-trophy-');
    let oauthRenewCalls = 0;
    let playerGqlCalls = 0;

    const fetchMock = vi.fn(async (rawUrl: string, init?: { body?: string }) => {
      const url = String(rawUrl);
      if (url.includes('api.epicgames.dev/epic/achievements/v1/public/achievements/product/sb_zero_earned/locale/')) {
        return makeMockJsonResponse({
          productId: 'prod_zero_earned_001',
          sandboxId: 'sb_zero_earned',
          totalAchievements: 2,
          totalProductXP: 1000,
          achievements: [
            {
              achievement: {
                name: 'ACH_FIRST_STEP',
                unlockedDisplayName: 'First Step',
                unlockedDescription: 'Complete the opening mission.',
                XP: 250,
                unlockedIconLink: 'https://shared-static-prod.epicgames.com/u1.png',
                lockedIconLink: 'https://shared-static-prod.epicgames.com/l1.png',
                rarity: { percent: 64.5 },
              },
            },
            {
              achievement: {
                name: 'ACH_MASTER',
                unlockedDisplayName: 'Grand Master',
                unlockedDescription: 'Finish on hardest difficulty.',
                XP: 750,
                unlockedIconLink: 'https://shared-static-prod.epicgames.com/u2.png',
                lockedIconLink: 'https://shared-static-prod.epicgames.com/l2.png',
                rarity: { percent: 4.2 },
              },
            },
          ],
        });
      }
      if (url.includes('/account/api/oauth/token')) {
        oauthRenewCalls += 1;
        return makeMockJsonResponse({ access_token: 'unexpected_refresh', account_id: 'syn_acct_001' });
      }
      if (url === 'https://launcher.store.epicgames.com/graphql') {
        playerGqlCalls += 1;
        const body = JSON.parse(String(init?.body || '{}')) as { query?: string };
        expect(body.query).toContain('... on ServiceError');
        return makeMockJsonResponse({
          data: {
            PlayerProfile: {
              playerProfile: {
                productAchievements: {
                  __typename: 'ServiceError',
                  status: 404,
                  message: 'Request failed with status code 404',
                },
              },
            },
          },
        });
      }
      return makeMockJsonResponse({}, 404);
    });

    const result = await storeSync.fetchEpicDetailedGameAchievements(
      { sandboxId: 'sb_zero_earned', title: 'Synthetic Zero Trophy Title' },
      {
        userDataDir: vaultDir,
        legendaryBaseDirs: [vaultDir],
        accessToken: 'syn_valid_epic_token',
        refreshToken: 'syn_refresh_token',
        accountId: '00000000000000000000000000000042',
        fetchFn: fetchMock,
      }
    );

    expect(oauthRenewCalls).toBe(0);
    expect(playerGqlCalls).toBe(1);
    expect(result).not.toBeNull();
    expect(result?.total).toBe(2);
    expect(result?.unlocked).toBe(0);
    expect(result?.percentage).toBe(0);
    expect(result?.totalXp).toBe(1000);
    expect(result?.earnedXp).toBe(0);
    expect(result?.source).toBe('live_cloud');
    expect(result?.unlockPrecision).toBe('exact');
    expect(result?.supportsAchievements).toBe(true);
    expect(result?.achievements).toHaveLength(2);
    expect(result?.achievements.every((a) => a.unlocked === false)).toBe(true);
  });

  it('fetchEpicPublicAchievementSchema falls back to en-US when a non-US locale returns 404, and recovers mismatched payload namespace via Legendary metadata', async () => {
    const legDir = makeTempDir('uat-epic-leg-ns-');
    const metaDir = path.join(legDir, 'metadata');
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, 'SynAppCodename.json'),
      JSON.stringify({
        app_name: 'SynAppCodename',
        app_title: 'Synthetic Remapped Title',
        metadata: {
          id: 'syn_cat_id_001',
          namespace: 'sb_real_base_ns',
          title: 'Synthetic Remapped Title',
        },
      }),
      'utf8'
    );

    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (rawUrl: string) => {
      const url = String(rawUrl);
      requestedUrls.push(url);
      if (url.includes('/product/sb_real_base_ns/locale/en-US')) {
        return makeMockJsonResponse({
          productId: 'prod_remapped_001',
          sandboxId: 'sb_real_base_ns',
          totalAchievements: 1,
          totalProductXP: 100,
          achievements: [
            {
              achievement: {
                name: 'ACH_ONE',
                unlockedDisplayName: 'Unlocked via Fallback',
                XP: 100,
              },
            },
          ],
        });
      }
      return makeMockJsonResponse({ message: 'productAchievement: Record not found.', code: 'DBRecordNotFound' }, 404);
    });

    // 1. Non-US locale fallback (`fr-FR` -> 404 -> retries `en-US` -> 200!)
    const schema = await storeSync.fetchEpicPublicAchievementSchema('sb_real_base_ns', {
      locale: 'fr-FR',
      fetchFn: fetchMock,
    });
    expect(schema?.totalAchievements).toBe(1);
    expect(requestedUrls.some((u) => u.includes('/locale/fr-FR'))).toBe(true);
    expect(requestedUrls.some((u) => u.includes('/locale/en-US'))).toBe(true);

    // 2. Stale/mismatched namespace (`sb_wrong_dlc_ns`) auto-resolves true `sb_real_base_ns` from appName metadata
    const detailed = await storeSync.fetchEpicDetailedGameAchievements(
      {
        namespace: 'sb_wrong_dlc_ns',
        appName: 'SynAppCodename',
        catalogItemId: 'syn_cat_id_001',
        title: 'Synthetic Remapped Title',
      },
      {
        legendaryBaseDirs: [legDir],
        userDataDir: legDir,
        locale: 'en-US',
        fetchFn: fetchMock,
      }
    );
    expect(detailed?.total).toBe(1);
    expect(detailed?.supportsAchievements).toBe(true);
    expect(detailed?.achievements[0]?.name).toBe('Unlocked via Fallback');
  });

  it('single-game scoped fetchEpicAchievements does not bail on empty singleQuery and resolves 0/N from public schema + 404 player response', async () => {
    const emptyLegDir = makeTempDir('uat-epic-scoped-zero-');

    const fetchMock = vi.fn(async (rawUrl: string, init?: { body?: string }) => {
      const url = String(rawUrl);
      if (url.includes('/product/sb_unplayed_metro/locale/')) {
        return makeMockJsonResponse({
          productId: 'prod_unplayed_metro',
          sandboxId: 'sb_unplayed_metro',
          totalAchievements: 49,
          totalProductXP: 1000,
          achievements: [{ achievement: { name: 'ACH_1', XP: 1000 } }],
        });
      }
      if (url === 'https://launcher.store.epicgames.com/graphql') {
        const body = JSON.parse(String(init?.body || '{}')) as { query?: string };
        if (body.query?.includes('productAchievements(sandboxId: $sandboxId)')) {
          // Empty targeted response with zero errors (previously triggered premature empty return!)
          return makeMockJsonResponse({
            data: {
              PlayerProfile: {
                playerProfile: {
                  epicAccountId: '00000000000000000000000000000042',
                  productAchievements: {},
                },
              },
            },
          });
        }
        if (body.query?.includes('productAchievements(productId: $productId)')) {
          return makeMockJsonResponse({
            data: {
              PlayerProfile: {
                playerProfile: {
                  productAchievements: {
                    __typename: 'ServiceError',
                    status: 404,
                    message: 'Request failed with status code 404',
                  },
                },
              },
            },
          });
        }
      }
      return makeMockJsonResponse({}, 404);
    });

    const map = await storeSync.fetchEpicAchievements(
      'syn_tok',
      '00000000000000000000000000000042',
      {
        sandboxId: 'sb_unplayed_metro',
        appName: 'SynMetroApp',
        catalogItemId: 'syn_metro_cat',
        title: 'Synthetic Metro Redux',
        legendaryBaseDirs: [emptyLegDir],
        fetchFn: fetchMock,
      }
    );

    expect(map['sb_unplayed_metro']).toMatchObject({
      unlocked: 0,
      total: 49,
      percentage: 0,
      xp: { earned: 0, total: 1000 },
    });
    expect(map['synmetroapp']).toMatchObject({ unlocked: 0, total: 49 });
    expect(map['epic-synmetroapp']).toMatchObject({ unlocked: 0, total: 49 });
  });

  it('bulk fetchEpicAchievements & fetchEpicOwnedGames enrich unplayed titles with 0/N public schemas, disk-cache misses, and self-heal on forceRefresh', async () => {
    const userDataDir = makeTempDir('uat-epic-bulk-enrich-');
    const emptyLegDir = makeTempDir('uat-epic-bulk-leg-');
    let publicApiCalls = 0;
    let newlyAddedEnabled = false;

    const fetchMock = vi.fn(async (rawUrl: string) => {
      const url = String(rawUrl);
      if (url.includes('api.epicgames.dev/epic/achievements/v1/public/achievements/product/')) {
        publicApiCalls += 1;
        if (url.includes('/product/sb_metro_like/locale/')) {
          return makeMockJsonResponse({
            productId: 'prod_metro_like',
            sandboxId: 'sb_metro_like',
            totalAchievements: 49,
            totalProductXP: 1000,
            achievements: [{ achievement: { name: 'ACH_M1', XP: 1000 } }],
          });
        }
        if (url.includes('/product/sb_control_like/locale/')) {
          if (newlyAddedEnabled) {
            return makeMockJsonResponse({
              productId: 'prod_control_like',
              sandboxId: 'sb_control_like',
              totalAchievements: 67,
              totalProductXP: 1000,
              achievements: [{ achievement: { name: 'ACH_C1', XP: 1000 } }],
            });
          }
          return makeMockJsonResponse(
            { message: 'productAchievement: Record not found.', code: 'DBRecordNotFound' },
            404
          );
        }
        return makeMockJsonResponse({}, 404);
      }
      if (url === 'https://launcher.store.epicgames.com/graphql') {
        return makeMockJsonResponse({
          data: {
            PlayerProfile: {
              playerProfile: {
                achievementsSummaries: {
                  data: [
                    {
                      totalUnlocked: 59,
                      totalXP: 830,
                      sandboxId: 'sb_alan_like',
                      product: { name: 'Synthetic Alan Sequel', slug: 'synthetic-alan-sequel' },
                      productAchievements: { totalAchievements: 88, totalProductXP: 1360 },
                    },
                  ],
                },
              },
            },
          },
        });
      }
      if (url.includes('/playtime/account/')) return makeMockJsonResponse([]);
      if (url.includes('/assets/Mac')) return makeMockJsonResponse([]);
      if (url.includes('/library/api/public/items')) {
        return makeMockJsonResponse({
          records: [
            {
              appName: 'SynMetroApp',
              namespace: 'sb_metro_like',
              catalogItemId: 'cat_metro_01',
              sandboxType: 'PUBLIC',
              metadata: {
                title: 'Synthetic Metro Redux',
                itemType: 'APPLICATION',
                categories: [{ path: 'games' }],
              },
            },
            {
              appName: 'SynControlApp',
              namespace: 'sb_control_like',
              catalogItemId: 'cat_control_01',
              sandboxType: 'PUBLIC',
              metadata: {
                title: 'Synthetic Control',
                itemType: 'APPLICATION',
                categories: [{ path: 'games' }],
              },
            },
          ],
          responseMetadata: {},
        });
      }
      return makeMockJsonResponse({});
    });

    const targets = [
      { sandboxId: 'sb_alan_like', appName: 'SynAlanApp', title: 'Synthetic Alan Sequel' },
      { sandboxId: 'sb_metro_like', appName: 'SynMetroApp', catalogItemId: 'cat_metro_01', title: 'Synthetic Metro Redux' },
      { sandboxId: 'sb_control_like', appName: 'SynControlApp', catalogItemId: 'cat_control_01', title: 'Synthetic Control' },
    ];

    // Pass 1: Alan keeps live 59/88; Metro (0 earned, no Legendary metadata!) gets 0/49 + 1000 XP; Control (404) stays absent
    const firstMap = await storeSync.fetchEpicAchievements(
      'syn_tok',
      '00000000000000000000000000000042',
      {
        targets,
        userDataDir,
        legendaryBaseDirs: [emptyLegDir],
        fetchFn: fetchMock,
      }
    );

    expect(firstMap['sb_alan_like']).toMatchObject({ unlocked: 59, total: 88, source: 'live_cloud_graphql' });
    expect(firstMap['sb_metro_like']).toMatchObject({
      unlocked: 0,
      total: 49,
      percentage: 0,
      xp: { earned: 0, total: 1000 },
    });
    expect(firstMap['synmetroapp']).toMatchObject({ unlocked: 0, total: 49 });
    expect(firstMap['sb_control_like']).toBeUndefined();
    expect(publicApiCalls).toBe(2); // Alan skipped (already in summaries); only Metro & Control probed

    const cachePath = storeSync.getEpicPublicAchievementCachePath({ userDataDir });
    expect(fs.existsSync(cachePath)).toBe(true);

    // Pass 2: Disk cache serves both positive (Metro) and negative (Control) with ZERO api.epicgames.dev calls!
    publicApiCalls = 0;
    const ownedGames = await storeSync.fetchEpicOwnedGames(
      'syn_tok',
      '00000000000000000000000000000042',
      {
        userDataDir,
        legendaryBaseDirs: [emptyLegDir],
        fetchFn: fetchMock,
      }
    );
    expect(publicApiCalls).toBe(0);
    const metroGame = ownedGames.find((g) => g.title === 'Synthetic Metro Redux');
    expect(metroGame?.platforms[0]?.achievements).toMatchObject({
      unlocked: 0,
      total: 49,
      xp: { earned: 0, total: 1000 },
    });

    // Pass 3: Publisher adds achievements to sb_control_like -> forceRefresh revalidates negative cache & heals to 0/67!
    newlyAddedEnabled = true;
    const healedMap = await storeSync.fetchEpicAchievements(
      'syn_tok',
      '00000000000000000000000000000042',
      {
        targets,
        forceRefresh: true,
        userDataDir,
        legendaryBaseDirs: [emptyLegDir],
        fetchFn: fetchMock,
      }
    );
    expect(publicApiCalls).toBe(1); // Only Control re-probed (Metro stayed positive-cached)
    expect(healedMap['sb_control_like']).toMatchObject({
      unlocked: 0,
      total: 67,
      xp: { earned: 0, total: 1000 },
    });
  });

  it('renderer provider back-propagates live_cloud 0/N summary and achievementDetailService self-heals stale 0/0 cache entries', async () => {
    const epicGame: CanonicalGame = {
      id: 'epic-SynMetroApp',
      title: 'Synthetic Metro Redux',
      sortTitle: 'Synthetic Metro Redux',
      headerImage: 'https://example.com/header.jpg',
      capsuleImage: 'https://example.com/capsule.jpg',
      shortDescription: '',
      releaseDate: '2020-01-01',
      developers: ['Synthetic Studio'],
      publishers: ['Epic Games Store'],
      genres: ['Action'],
      tags: ['Epic Games Store'],
      platforms: [
        {
          platformId: 'epic',
          platformGameId: 'SynMetroApp',
          namespace: 'sb_metro_like',
          catalogItemId: 'cat_metro_01',
          installed: false,
        },
      ],
    };

    const getStoreAchievementsMock = vi.fn().mockResolvedValue({
      storefrontId: 'epic',
      storefrontName: 'Epic Games',
      total: 49,
      unlocked: 0,
      percentage: 0,
      isMastered: false,
      totalXp: 1000,
      earnedXp: 0,
      source: 'live_cloud',
      unlockPrecision: 'exact',
      supportsAchievements: true,
      cacheVersion: 2,
      syncedAt: '2026-11-21T12:00:00.000Z',
      achievements: Array.from({ length: 49 }, (_, i) => ({
        id: `epic:sb_metro_like:ACH_${i + 1}`,
        apiName: `ACH_${i + 1}`,
        name: `Achievement ${i + 1}`,
        unlocked: false,
        xp: i === 0 ? 1000 : 0,
      })),
    });

    const fetchEpicAchievementsMock = vi.fn().mockResolvedValue({
      sb_metro_like: { unlocked: 0, total: 49, percentage: 0 },
    });

    const mockElectronApi: Partial<ElectronAPI> = {
      isElectron: true,
      getStoreAchievements: getStoreAchievementsMock,
      fetchEpicAchievements: fetchEpicAchievementsMock,
    };

    Object.defineProperty(window, 'electronAPI', {
      value: mockElectronApi,
      writable: true,
      configurable: true,
    });

    // 1. Seed a STALE cached 0/0 Epic entry (synced > 5 min ago)
    const staleZeroMap: MultiStoreAchievementsMap = {
      epic: {
        storefrontId: 'epic',
        storefrontName: 'Epic Games',
        total: 0,
        unlocked: 0,
        percentage: 0,
        isMastered: false,
        achievements: [],
        syncedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        source: 'live_cloud',
        unlockPrecision: 'exact',
        supportsAchievements: false,
        cacheVersion: 2,
      },
    };
    achievementDetailService.setCachedMultiStoreAchievements(epicGame.id, staleZeroMap);

    // 2. fetchGameAchievements (even WITHOUT forceRefresh!) must self-heal stale 0/0 -> 0/49 live_cloud
    const healed = await achievementDetailService.fetchGameAchievements(epicGame, false);
    expect(getStoreAchievementsMock).toHaveBeenCalledTimes(1);
    expect(healed.epic?.total).toBe(49);
    expect(healed.epic?.unlocked).toBe(0);
    expect(healed.epic?.totalXp).toBe(1000);
    expect(healed.epic?.earnedXp).toBe(0);
    expect(healed.epic?.source).toBe('live_cloud');
    expect(healed.epic?.supportsAchievements).toBe(true);

    // 3. Verified live_cloud 0/49 was back-propagated to unified summary store for ActionBar / Breakdown Drawer!
    const knownSummary = getKnownEpicAchievements('sb_metro_like', epicGame.title);
    expect(knownSummary).toMatchObject({
      unlocked: 0,
      total: 49,
      percentage: 0,
      xp: { earned: 0, total: 1000 },
    });

    // 4. Fresh 0/0 cached entry ALSO immediately self-heals when platform summary knows total > 0 (e.g. 0/49)
    const freshZeroMap: MultiStoreAchievementsMap = {
      epic: {
        storefrontId: 'epic',
        storefrontName: 'Epic Games',
        total: 0,
        unlocked: 0,
        percentage: 0,
        isMastered: false,
        achievements: [],
        syncedAt: new Date().toISOString(),
        source: 'live_cloud',
        unlockPrecision: 'exact',
        supportsAchievements: false,
        cacheVersion: 2,
      },
    };
    const gameWithPlatformTotal: CanonicalGame = {
      ...epicGame,
      platforms: [
        {
          ...epicGame.platforms[0],
          achievements: {
            unlocked: 0,
            total: 49,
            percentage: 0,
            xp: { earned: 0, total: 1000 },
            source: 'local_client_cache',
          },
        },
      ],
    };
    expect(hasHigherPlatformUnlockedSummary(gameWithPlatformTotal, freshZeroMap)).toBe(true);
    expect(
      shouldSwrRevalidateMap({
        epic: { ...freshZeroMap.epic!, syncedAt: undefined },
      })
    ).toBe(true);

    achievementDetailService.setCachedMultiStoreAchievements(gameWithPlatformTotal.id, freshZeroMap);
    const healedBySummary = await achievementDetailService.fetchGameAchievements(
      gameWithPlatformTotal,
      false
    );
    expect(getStoreAchievementsMock).toHaveBeenCalledTimes(2);
    expect(healedBySummary.epic?.total).toBe(49);

    // 5. Direct provider call preserves live_cloud and exact precision for 0/49
    const directRes = await fetchEpicDetailedAchievementsProvider(
      epicGame,
      async () => [],
      'SynMetroApp'
    );
    expect(directRes?.source).toBe('live_cloud');
    expect(directRes?.unlockPrecision).toBe('exact');
    expect(directRes?.total).toBe(49);

    // 6. epicIntegration.fetchUserAchievements forwards targets + forceRefresh payload when supplied
    const targets = [{ sandboxId: 'sb_metro_like', appName: 'SynMetroApp', title: 'Synthetic Metro Redux' }];
    await epicIntegration.fetchUserAchievements(
      '00000000000000000000000000000042',
      'saved_in_electron',
      targets,
      { forceRefresh: true }
    );
    expect(fetchEpicAchievementsMock).toHaveBeenCalledWith({
      accountId: '00000000000000000000000000000042',
      accessToken: 'saved_in_electron',
      targets,
      forceRefresh: true,
    });
  });

  it('epic:fetch-achievements IPC forwards sanitized targets + forceRefresh and GameAchievementsModal shows truthful multi-storefront empty copy for Control-style titles', async () => {
    type IpcHandler = (event: unknown, payload?: unknown) => Promise<unknown>;
    const handlers = new Map<string, IpcHandler>();
    const fetchEpicAchSpy = vi.fn(async () => ({
      sb_metro_like: { unlocked: 0, total: 49, percentage: 0 },
    }));
    const userDataDir = makeTempDir('uat-epic-ipc-');

    registerStoreSyncIpcHandlers({
      ipcMain: {
        handle: (ch: string, fn: IpcHandler) => handlers.set(ch, fn),
        on: vi.fn(),
        removeListener: vi.fn(),
      },
      BrowserWindow: vi.fn(),
      session: {},
      getMainWindow: () => null,
      storeSync: {
        loadSavedTokens: () => ({
          epic: {
            access_token: 'syn_ipc_epic_tok',
            account_id: '00000000000000000000000000000042',
          },
        }),
        fetchEpicAchievements: fetchEpicAchSpy,
      },
      launcherEngine: {},
      options: { userDataDir },
    });

    const handler = handlers.get('epic:fetch-achievements');
    expect(handler).toBeDefined();
    await handler!(
      {},
      {
        targets: [
          {
            sandboxId: 'sb_metro_like',
            appName: 'SynMetroApp',
            catalogItemId: 'cat_metro_01',
            title: 'Synthetic Metro Redux',
          },
          { title: 'Ignored Entry Without Sandbox' },
        ],
        forceRefresh: true,
      }
    );

    expect(fetchEpicAchSpy).toHaveBeenCalledWith(
      'syn_ipc_epic_tok',
      '00000000000000000000000000000042',
      {
        targets: [
          {
            sandboxId: 'sb_metro_like',
            appName: 'SynMetroApp',
            catalogItemId: 'cat_metro_01',
            title: 'Synthetic Metro Redux',
          },
        ],
        forceRefresh: true,
        userDataDir,
      }
    );

    // Control-style title: Epic genuinely lacks achievements while Xbox & GOG have 67
    const cachedControlMap: MultiStoreAchievementsMap = {
      epic: {
        storefrontId: 'epic',
        storefrontName: 'Epic Games',
        total: 0,
        unlocked: 0,
        percentage: 0,
        isMastered: false,
        achievements: [],
        syncedAt: new Date().toISOString(),
        source: 'live_cloud',
        unlockPrecision: 'exact',
        supportsAchievements: false,
        cacheVersion: 2,
      },
      xbox: {
        storefrontId: 'xbox',
        storefrontName: 'Xbox',
        total: 67,
        unlocked: 22,
        percentage: 33,
        isMastered: false,
        totalGamerscore: 1390,
        earnedGamerscore: 395,
        achievements: [],
        syncedAt: new Date().toISOString(),
        source: 'live_cloud',
        unlockPrecision: 'exact',
        supportsAchievements: true,
        cacheVersion: 2,
      },
    };

    expect(resolveNoAchievementsSubtitle('epic', cachedControlMap)).toBe(
      'This publisher did not integrate Epic Games achievements for this release, though achievements are available on another connected storefront.'
    );
    expect(resolveNoAchievementsSubtitle('epic', { epic: cachedControlMap.epic })).toContain(
      'does not have Epic Achievements configured by the publisher'
    );
  });
});
