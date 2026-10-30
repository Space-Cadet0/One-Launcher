import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import axios from 'axios';

// ---------------------------------------------------------------------------
// Hoisted Headless Browser + Deterministic IndexedDB Vault Polyfills
// (Executed before any application module imports so boot hydration hooks attach cleanly)
// ---------------------------------------------------------------------------
const testEnv = vi.hoisted(() => {
  class MockStorage implements Storage {
    private store = new Map<string, string>();
    get length(): number {
      return this.store.size;
    }
    clear(): void {
      this.store.clear();
    }
    getItem(key: string): string | null {
      return this.store.get(key) ?? null;
    }
    key(index: number): string | null {
      return Array.from(this.store.keys())[index] ?? null;
    }
    removeItem(key: string): void {
      this.store.delete(key);
    }
    setItem(key: string, value: string): void {
      this.store.set(key, String(value));
    }
  }

  const mockStorage = new MockStorage();
  const idbStore = new Map<string, unknown>();
  const windowEvents = new EventTarget();
  let navigatorOnline = true;
  let pendingEntriesGate: Promise<void> | null = null;

  const cloneValue = <T>(val: T): T => {
    if (val === undefined || val === null || typeof val !== 'object') return val;
    return structuredClone(val);
  };

  const globalRecord = globalThis as Record<string, unknown>;
  globalRecord.localStorage = mockStorage;
  globalRecord.indexedDB = { __syntheticIdbMock: true };

  if (typeof globalThis.CustomEvent === 'undefined') {
    globalRecord.CustomEvent = class SyntheticCustomEvent<T = unknown> extends Event {
      public readonly detail: T;
      constructor(type: string, params?: CustomEventInit<T>) {
        super(type);
        this.detail = params?.detail as T;
      }
    };
  }

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      get onLine(): boolean {
        return navigatorOnline;
      },
      userAgent: 'OneLauncherUnitTest/1.0',
    },
  });

  const windowObj: Record<string, unknown> = {
    addEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
      windowEvents.addEventListener(type, cb),
    removeEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
      windowEvents.removeEventListener(type, cb),
    dispatchEvent: (event: Event) => windowEvents.dispatchEvent(event),
    localStorage: mockStorage,
    location: {
      protocol: 'app:',
      port: '',
      hostname: 'one-launcher.local',
      origin: 'app://one-launcher',
    },
    innerWidth: 1440,
    innerHeight: 900,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    electronAPI: undefined,
  };
  globalRecord.window = windowObj;

  return {
    mockStorage,
    idbStore,
    windowObj,
    cloneValue,
    setNavigatorOnline(next: boolean): void {
      const changed = navigatorOnline !== next;
      navigatorOnline = next;
      if (changed) {
        windowEvents.dispatchEvent(new Event(next ? 'online' : 'offline'));
      }
    },
    setEntriesGate(gate: Promise<void> | null): void {
      pendingEntriesGate = gate;
    },
    async waitEntriesGate(): Promise<void> {
      if (pendingEntriesGate) {
        await pendingEntriesGate;
      }
    },
  };
});

vi.mock('idb-keyval', () => ({
  createStore: (dbName: string, storeName: string) => ({ dbName, storeName }),
  get: async <T>(key: IDBValidKey): Promise<T | undefined> => {
    const k = String(key);
    if (!testEnv.idbStore.has(k)) return undefined;
    return testEnv.cloneValue(testEnv.idbStore.get(k) as T);
  },
  set: async (key: IDBValidKey, value: unknown): Promise<void> => {
    testEnv.idbStore.set(String(key), testEnv.cloneValue(value));
  },
  del: async (key: IDBValidKey): Promise<void> => {
    testEnv.idbStore.delete(String(key));
  },
  entries: async (): Promise<Array<[IDBValidKey, unknown]>> => {
    await testEnv.waitEntriesGate();
    return Array.from(testEnv.idbStore.entries()).map(([k, v]) => [k, testEnv.cloneValue(v)]);
  },
}));

const requireCjs = createRequire(import.meta.url);
const offlineVaultMod = requireCjs('../electron/launcher/offlineVaultService.cjs');
const hydrationEngineMod = requireCjs('../electron/launcher/mediaHydrationEngine.cjs');
const offlineVaultIpcMod = requireCjs('../electron/ipc/offlineVaultIpcHandlers.cjs');

import type { CanonicalGame } from '../src/contracts/game';
import type { CriticScoreData } from '../src/contracts/critic';
import type { SteamEnrichedMetadata } from '../src/contracts/steam';
import { isSequelMismatch } from '../src/services/common/titleUtils';
import { SteamMatcherService, steamMatcher } from '../src/services/steam/steamMatcher';
import { SteamReviewResolver } from '../src/services/critic/steamReviewResolver';
import { steamApi } from '../src/services/steam/steamApi';
import { fallbackMetadataProvider } from '../src/services/steam/fallbackMetadataProvider';
import {
  CriticScoreService,
  criticScoreService,
  getOpenCriticData,
} from '../src/services/critic/criticScoreService';
import {
  saveStagedCache,
  loadStagedCache,
  hydrateAllStagedCacheFromVault,
  hasFreshMediaSyncAttempt,
  recordMediaSyncAttempt,
  MEDIA_ATTEMPT_KEY_PREFIX,
} from '../src/services/storage/stagedCacheService';
import {
  evaluateGameNeedsStoreMediaSync,
  SyncJobManager,
} from '../src/services/network/syncJobManager';
import { requestScheduler } from '../src/services/network/requestScheduler';
import {
  resolveEffectiveSteamAppId,
  saveUserOverride,
  loadUserOverrides,
  hydrateUserOverridesFromVault,
  STORAGE_KEY_USER_OVERRIDES,
} from '../src/services/storage/userOverrideStorage';
import {
  saveCurrentCatalog,
  flushPendingCatalogSave,
} from '../src/services/integrations/integrationStorage';
import { pickBestEnrichedMetadata } from '../src/services/storage/librarySync';
import {
  getHowLongToBeat,
  hasAttemptedHltbLookup,
  fetchAndCacheHltb,
} from '../src/services/hltb/howLongToBeat';
import { IgdbCoverService } from '../src/services/igdb/igdbCoverService';

// Minimal valid 1x1 PNG buffer for deterministic offline media hydration tests
const SYNTHETIC_PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

const SYNTHETIC_REVIEW_SUMMARY = {
  reviewScore: 8,
  reviewScoreDesc: 'Very Positive',
  totalPositive: 860,
  totalNegative: 140,
  totalReviews: 1000,
  positivePercent: 86,
};

function buildSyntheticEnrichedMetadata(
  overrides: Partial<SteamEnrichedMetadata> = {}
): SteamEnrichedMetadata {
  return {
    appId: 0,
    name: 'Synthetic Title',
    shortDescription: 'Synthetic test game synopsis.',
    detailedDescription: '<p>Synthetic detailed description.</p>',
    aboutTheGame: '<p>Synthetic about the game.</p>',
    headerImage: 'https://cdn.example.invalid/headers/synthetic-header.jpg',
    developers: ['Synthetic Studio'],
    publishers: ['Synthetic Publishing'],
    releaseDate: '2022-06-15',
    genres: ['Action'],
    tags: ['Singleplayer'],
    categories: [{ id: 2, description: 'Single-player' }],
    screenshots: [],
    movies: [],
    systemRequirements: { minimum: 'Synthetic OS 1.0' },
    reviewSummary: SYNTHETIC_REVIEW_SUMMARY,
    ...overrides,
  };
}

function buildSyntheticGame(overrides: Partial<CanonicalGame> & { id: string; title: string }): CanonicalGame {
  const { id, title, ...rest } = overrides;
  return {
    id,
    title,
    sortTitle: title,
    platforms: rest.platforms ?? [
      {
        platformId: 'gog',
        platformGameId: id.replace(/^gog-/, ''),
        installed: false,
      },
    ],
    capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co999999.jpg',
    headerImage: 'https://cdn.example.invalid/headers/synthetic-header.jpg',
    shortDescription: 'Synthetic test game description for automated regression verification.',
    developers: ['Synthetic Studio'],
    publishers: ['Synthetic Publishing'],
    genres: ['Action'],
    tags: ['Singleplayer'],
    releaseDate: '2022-06-15',
    ...rest,
  };
}

describe('Cold-Launch Sync Persistence, Compilation Matching & Negative Cache Durability', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    requestScheduler.reset();
    (steamApi as unknown as { rateLimitedUntil: number }).rateLimitedUntil = 0;
    testEnv.setEntriesGate(null);
    testEnv.setNavigatorOnline(true);
    testEnv.mockStorage.clear();
    testEnv.idbStore.clear();
    testEnv.windowObj.electronAPI = undefined;
    criticScoreService.clearCache();
    steamMatcher.clearCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    requestScheduler.reset();
    (steamApi as unknown as { rateLimitedUntil: number }).rateLimitedUntil = 0;
    testEnv.setEntriesGate(null);
    testEnv.setNavigatorOnline(true);
    testEnv.windowObj.electronAPI = undefined;
  });

  // =========================================================================
  // 1. Compilation "Title A + Title B" Cold-Launch Persistence & Slug Parity
  // =========================================================================
  describe('1. Compilation "Title A + Title B" Cold-Launch Persistence & Slug Compatibility', () => {
    it('retains positive & negative "+" compilation keys across cold-launch re-instantiation & IDB vault mirror while evicting soundtrack/DLC keys', async () => {
      const now = Date.now();
      localStorage.setItem('antigravity_steam_matcher_schema_v5', '1');
      localStorage.setItem(
        'steam_app_id_match_cache_v4',
        JSON.stringify({
          'synthetic blaster + synthetic blaster ii': 990101,
          'synthetic skater 1 + 2': { appId: null, cachedAt: now, failureCount: 1 },
          'synthetic world + fury': 990303,
          'synthetic blaster + official soundtrack': 990999,
          'synthetic blaster - artbook & bonus pack': 990998,
        })
      );

      const coldBootMatcher = new SteamMatcherService();

      // Positive compilation titles with '+' survive cold boot
      expect(coldBootMatcher.matchGameToSteamInstant('Synthetic Blaster + Synthetic Blaster II')).toBe(
        990101
      );
      expect(coldBootMatcher.hasAttemptedMatch('Synthetic Blaster + Synthetic Blaster II')).toBe(true);
      expect(coldBootMatcher.matchGameToSteamInstant('Synthetic World + Fury')).toBe(990303);

      // Negative compilation record with '+' survives cold boot within 14d TTL
      expect(coldBootMatcher.matchGameToSteamInstant('Synthetic Skater 1 + 2')).toBeNull();
      expect(coldBootMatcher.hasAttemptedMatch('Synthetic Skater 1 + 2')).toBe(true);

      // Genuine DLC/OST non-game '+' keys are evicted from positive cache by NON_GAME_SOURCE_REGEX
      // while hasAttemptedMatch returns true so background sync never network-queries OST/DLC items
      expect(
        coldBootMatcher.matchGameToSteamInstant('Synthetic Blaster + Official Soundtrack')
      ).toBeNull();
      expect(
        coldBootMatcher.matchGameToSteamInstant('Synthetic Blaster - Artbook & Bonus Pack')
      ).toBeNull();
      expect(coldBootMatcher.hasAttemptedMatch('Synthetic Blaster + Official Soundtrack')).toBe(
        true
      );

      // Verify IndexedDB vault mirror (`steam_app_id_match_cache_v4`) survives localStorage eviction
      await testEnv.idbStore.set('steam_app_id_match_cache_v4', {
        'synthetic blaster + synthetic blaster ii': 990101,
        'synthetic skater 1 + 2': { appId: null, cachedAt: now, failureCount: 1 },
      });
      localStorage.clear();

      const vaultOnlyMatcher = new SteamMatcherService();
      await new Promise((r) => setTimeout(r, 10));

      expect(vaultOnlyMatcher.matchGameToSteamInstant('Synthetic Blaster + Synthetic Blaster II')).toBe(
        990101
      );
      expect(vaultOnlyMatcher.hasAttemptedMatch('Synthetic Skater 1 + 2')).toBe(true);
      expect(vaultOnlyMatcher.matchGameToSteamInstant('Synthetic Skater 1 + 2')).toBeNull();
    });

    it('matches ordered compilation slugs in isSequelMismatch while rejecting single-clause & wrong-sequel collisions', () => {
      // Valid hyphenated / space-concatenated compilation slugs where '+' was stripped
      expect(
        isSequelMismatch(
          'Synthetic Blaster + Synthetic Blaster II',
          'synthetic blaster synthetic blaster ii'
        )
      ).toBe(false);
      expect(
        isSequelMismatch(
          'Synthetic Blaster + Synthetic Blaster II',
          'synthetic-blaster-synthetic-blaster-ii'
        )
      ).toBe(false);
      expect(isSequelMismatch('Synthetic Skater 1 + 2', 'synthetic skater 1 2')).toBe(false);
      expect(isSequelMismatch('Synthetic World + Fury', 'synthetic world fury')).toBe(false);

      // Single-clause & wrong-sequel collisions MUST still be rejected
      expect(
        isSequelMismatch('Synthetic Blaster + Synthetic Blaster II', 'synthetic blaster')
      ).toBe(true);
      expect(
        isSequelMismatch(
          'Synthetic Blaster + Synthetic Blaster II',
          'the ultimate synthetic blaster'
        )
      ).toBe(true);
      expect(
        isSequelMismatch('Synthetic Blaster + Synthetic Blaster II', 'synthetic blaster ii')
      ).toBe(true);
      expect(isSequelMismatch('Synthetic Skater 1 + 2', 'synthetic skater 1')).toBe(true);
      expect(isSequelMismatch('Synthetic Skater 1 + 2', 'synthetic skater 2')).toBe(true);
      expect(isSequelMismatch('Synthetic Skater 1 + 2', 'synthetic skater 3 + 4')).toBe(true);
    });

    it('normalizes "+" symmetrically in SteamReviewResolver.resolveScore so compilation titles are not rejected by qDisjoint', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/storesearch/')) {
          return new Response(
            JSON.stringify({
              items: [{ id: 990101, name: 'Synthetic Blaster + Synthetic Blaster II' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.includes('/appreviews/990101')) {
          return new Response(
            JSON.stringify({
              success: 1,
              query_summary: { total_reviews: 4200, total_positive: 3948 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('', { status: 404 });
      });

      const resolver = new SteamReviewResolver();
      const score = await resolver.resolveScore('Synthetic Blaster + Synthetic Blaster II', null);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(score).not.toBeNull();
      expect(score?.id).toBe('steam-990101');
      expect(score?.score).toBeGreaterThanOrEqual(85);
      expect(score?.percentRecommended).toBe(91);
      expect(score?.numReviews).toBe(4200);
    });

    it('resolves authoritative enrichedMetadata.appId in resolveEffectiveSteamAppId while honoring Xbox, non-Steam & override exclusions', () => {
      const steamEnrichedGogGame = buildSyntheticGame({
        id: 'gog-550101',
        title: 'Synthetic Blaster + Synthetic Blaster II',
        steamAppId: undefined,
        enrichedMetadata: buildSyntheticEnrichedMetadata({
          appId: 990101,
          name: 'Synthetic Blaster + Synthetic Blaster II',
          shortDescription: 'Authoritative Steam metadata on non-Steam entitlement.',
          headerImage: 'https://cdn.example.invalid/header.jpg',
          releaseDate: '2024-08-08',
          enrichedSource: 'steam',
          metadataQuality: 'authoritative',
        }),
      });

      expect(resolveEffectiveSteamAppId(steamEnrichedGogGame, null)).toBe(990101);

      // Xbox storefront_native metadata must NEVER leak a Steam AppID
      const xboxNativeGame = buildSyntheticGame({
        id: 'xbox-9N0000000101',
        title: 'Synthetic Console Exclusive',
        platforms: [{ platformId: 'xbox', platformGameId: '9N0000000101', installed: false }],
        enrichedMetadata: buildSyntheticEnrichedMetadata({
          ...steamEnrichedGogGame.enrichedMetadata!,
          appId: 990101,
          enrichedSource: 'xbox',
          metadataQuality: 'storefront_native',
        }),
      });
      expect(resolveEffectiveSteamAppId(xboxNativeGame, null)).toBeUndefined();

      // Explicit non-Steam flag blocks enrichedMetadata.appId fallback
      expect(
        resolveEffectiveSteamAppId(
          { ...steamEnrichedGogGame, isExplicitNonSteam: true },
          null
        )
      ).toBeUndefined();

      // User override with steamAppId: null blocks Steam resolution
      saveUserOverride({
        gameId: 'gog-550101',
        matchedStore: 'custom',
        steamAppId: null,
        isExplicitNonSteam: true,
        updatedAt: '2026-10-29T12:00:00.000Z',
      });
      expect(resolveEffectiveSteamAppId(steamEnrichedGogGame, null)).toBeUndefined();

      // User override routed to GOG blocks Steam AppID resolution
      saveUserOverride({
        gameId: 'gog-550102',
        matchedStore: 'gog',
        metadataRoute: {
          mode: 'routed',
          source: 'gog',
          matchedId: '550102',
        },
        updatedAt: '2026-10-29T12:05:00.000Z',
      });
      expect(
        resolveEffectiveSteamAppId(
          {
            ...steamEnrichedGogGame,
            id: 'gog-550102',
          },
          null
        )
      ).toBeUndefined();
    });

    it('persists dual id + title critic keys so Cold Launch #2 queues 0 compilation games & backs off transient WAF failures', async () => {
      const compilationGame = buildSyntheticGame({
        id: 'gog-550101',
        title: 'Synthetic Blaster + Synthetic Blaster II',
        steamAppId: undefined,
        releaseDate: '2021-03-10',
      });

      const verifiedScore: CriticScoreData = {
        id: 'oc-990101',
        source: 'opencritic',
        score: 89,
        percentRecommended: 92,
        tier: 'Mighty',
        numReviews: 48,
        url: 'https://opencritic.com/game/990101/synthetic-blaster-synthetic-blaster-ii',
        isVerified: true,
      };

      // Seed SteamMatcher compilation mapping for Run #1
      localStorage.setItem('antigravity_steam_matcher_schema_v5', '1');
      localStorage.setItem(
        'steam_app_id_match_cache_v4',
        JSON.stringify({ 'synthetic blaster + synthetic blaster ii': 990101 })
      );
      const freshMatcher = new SteamMatcherService();
      vi.spyOn(steamMatcher, 'getEffectiveSteamAppId').mockImplementation((g) =>
        freshMatcher.getEffectiveSteamAppId(g)
      );

      // Run #1: CriticScoreService caches dynamic score with aliasTitle
      const svcRun1 = new CriticScoreService();
      const internalSvc1 = svcRun1 as unknown as {
        cacheResult: (
          rawKey: string,
          result: CriticScoreData | null,
          releaseDate?: string,
          genres?: string[],
          options?: { dynamicResolved?: boolean; aliasTitle?: string }
        ) => void;
      };
      internalSvc1.cacheResult('id:990101', verifiedScore, '2021-03-10', ['Action'], {
        dynamicResolved: true,
        aliasTitle: compilationGame.title,
      });

      // Both id:990101 and title:synthetic blaster + synthetic blaster ii are durably staged
      const byId = loadStagedCache<CriticScoreData>('antigravity_critic_v8_id:990101');
      const byTitle = loadStagedCache<CriticScoreData>(
        'antigravity_critic_v8_title:synthetic blaster + synthetic blaster ii'
      );
      expect(byId.valid).toBe(true);
      expect(byId.entry?.dynamicResolved).toBe(true);
      expect(byTitle.valid).toBe(true);
      expect(byTitle.entry?.dynamicResolved).toBe(true);
      expect(byTitle.data?.score).toBe(89);

      // Simulate Cold Launch #2 with brand-new CriticScoreService & SyncJobManager instances
      const svcColdLaunch2 = new CriticScoreService();
      expect(
        svcColdLaunch2.hasValidCachedResolution(990101, 'Synthetic Blaster + Synthetic Blaster II')
      ).toBe(true);
      // Even before SteamMatcher finishes hydrating (steamAppId = undefined), title key hits!
      expect(
        svcColdLaunch2.hasValidCachedResolution(
          undefined,
          'Synthetic Blaster + Synthetic Blaster II'
        )
      ).toBe(true);

      const resolveDynamicSpy = vi.spyOn(criticScoreService, 'resolveDynamicScore');
      const jobMgr = new SyncJobManager();
      await jobMgr.startCriticScoreSync([compilationGame], { isBackgroundWarmup: true });
      expect(resolveDynamicSpy).not.toHaveBeenCalled();

      // Verify transient WAF/429 failure backoff (>= 2h TTL + dynamicResolved: true)
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () =>
          new Response('Attention Required! | Cloudflare', {
            status: 403,
            headers: { 'cf-mitigated': 'challenge' },
          })
      );
      vi.spyOn(axios, 'get').mockRejectedValue(
        Object.assign(new Error('HTTP 429 Too Many Requests'), {
          response: { status: 429 },
          status: 429,
        })
      );

      const transientSvc = new CriticScoreService();
      const resNull = await transientSvc.resolveDynamicScore(
        'Synthetic Space Saga',
        990499,
        '2023-01-01'
      );
      expect(resNull).toBeNull();

      const backoffEntry = loadStagedCache<CriticScoreData>('antigravity_critic_v8_id:990499');
      expect(backoffEntry.valid).toBe(true);
      expect(backoffEntry.entry?.tier).toBe('transient_error');
      expect(backoffEntry.entry?.dynamicResolved).toBe(true);
      expect(backoffEntry.entry?.ttlMs).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
      expect(transientSvc.hasAttemptedDynamicResolution(990499, 'Synthetic Space Saga')).toBe(true);

      // Also verify priorPositiveScore preservation when a stale positive score encounters WAF/429
      saveStagedCache(
        'antigravity_critic_v8_id:990498',
        {
          id: 'steam-990498',
          source: 'steam',
          score: 86,
          percentRecommended: 88,
          tier: 'Strong',
          numReviews: 300,
          url: 'https://store.steampowered.com/app/990498',
          isVerified: false,
          isSynthetic: true,
        },
        'fresh',
        {
          cachedAt: Date.now() - 10 * 24 * 60 * 60 * 1000, // expired TTL -> stale
          dynamicResolved: true,
        }
      );
      const preserved = await transientSvc.resolveDynamicScore(
        'Synthetic Star Voyager',
        990498,
        '2024-01-01',
        undefined,
        { bypassAttempted: true }
      );
      expect(preserved?.score).toBe(86);
      const refreshedStaged = loadStagedCache<CriticScoreData>('antigravity_critic_v8_id:990498');
      expect(refreshedStaged.valid).toBe(true);
      expect(refreshedStaged.entry?.dynamicResolved).toBe(true);
    });
  });

  // =========================================================================
  // 2. 33-Game Archetype Store Media Eligibility & Negative Cache Durability
  // =========================================================================
  describe('2. 33-Game Archetype Store Media Eligibility & Negative Cache Durability', () => {
    it('queues 0 games for trailerless Xbox storefront_native & multi-store [gog, xbox] scraped games once Steam match is negatively cached', async () => {
      const now = Date.now();
      localStorage.setItem('antigravity_steam_matcher_schema_v5', '1');
      localStorage.setItem(
        'steam_app_id_match_cache_v4',
        JSON.stringify({
          'synthetic grid runner': { appId: null, cachedAt: now, failureCount: 1 },
          'synthetic tactical ops': { appId: null, cachedAt: now, failureCount: 1 },
        })
      );
      const seededMatcher = new SteamMatcherService();
      vi.spyOn(steamMatcher, 'hasAttemptedMatch').mockImplementation((title) =>
        seededMatcher.hasAttemptedMatch(title)
      );
      vi.spyOn(steamMatcher, 'getEffectiveSteamAppId').mockImplementation((g) =>
        seededMatcher.getEffectiveSteamAppId(g)
      );

      const trailerlessXboxNative = buildSyntheticGame({
        id: 'xbox-9N0000000201',
        title: 'Synthetic Grid Runner',
        platforms: [{ platformId: 'xbox', platformGameId: '9N0000000201', installed: false }],
        enrichedMetadata: buildSyntheticEnrichedMetadata({
          appId: 0,
          name: 'Synthetic Grid Runner',
          shortDescription: 'Official Xbox catalog synopsis.',
          headerImage: 'https://cdn.example.invalid/grid-header.jpg',
          screenshots: [
            {
              id: 1,
              pathThumbnail: 'https://cdn.example.invalid/grid-s1-thumb.jpg',
              pathFull: 'https://cdn.example.invalid/grid-s1-full.jpg',
            },
          ],
          movies: [],
          developers: ['Synthetic Racing Lab'],
          publishers: ['Synthetic Studios'],
          genres: ['Racing'],
          releaseDate: '2023-09-10',
          enrichedSource: 'xbox',
          metadataQuality: 'storefront_native',
          enrichedAt: now - 60_000,
        }),
      });

      const multiStoreGogXboxScraped = buildSyntheticGame({
        id: 'gog-7700202',
        title: 'Synthetic Tactical Ops',
        platforms: [
          { platformId: 'gog', platformGameId: '7700202', installed: false },
          { platformId: 'xbox', platformGameId: '9N0000000202', installed: false },
        ],
        enrichedMetadata: buildSyntheticEnrichedMetadata({
          appId: 0,
          name: 'Synthetic Tactical Ops',
          shortDescription: 'Rich GOG storefront metadata without video trailers.',
          headerImage: 'https://cdn.example.invalid/tactical-header.jpg',
          screenshots: [
            {
              id: 1,
              pathThumbnail: 'https://cdn.example.invalid/tac-s1-thumb.jpg',
              pathFull: 'https://cdn.example.invalid/tac-s1-full.jpg',
            },
          ],
          movies: [],
          developers: ['Synthetic Tactics'],
          publishers: ['Synthetic Publishing'],
          genres: ['Strategy'],
          releaseDate: '2022-04-01',
          metadataQuality: 'scraped',
          enrichedAt: now - 60_000,
        }),
      });

      expect(evaluateGameNeedsStoreMediaSync(trailerlessXboxNative, false)).toEqual({
        eligible: false,
        alreadyEnriched: true,
      });
      expect(evaluateGameNeedsStoreMediaSync(multiStoreGogXboxScraped, false)).toEqual({
        eligible: false,
        alreadyEnriched: true,
      });

      const fallbackSpy = vi.spyOn(
        fallbackMetadataProvider,
        'getEnrichedMetadataForNonSteamGame'
      );
      const jobMgr = new SyncJobManager();
      await jobMgr.startStoreMediaSync(
        [trailerlessXboxNative, multiStoreGogXboxScraped],
        () => {},
        { incremental: true, isBackgroundWarmup: true }
      );
      expect(fallbackSpy).not.toHaveBeenCalled();
    });

    it('upgrades newly discovered storefront_native games on Run #1 and skips them on Cold Launch #2 after negative Steam match + attempt stamp', async () => {
      const freshXboxGame = buildSyntheticGame({
        id: 'xbox-9N0000000203',
        title: 'Synthetic Horizon Drift',
        platforms: [{ platformId: 'xbox', platformGameId: '9N0000000203', installed: false }],
        enrichedMetadata: buildSyntheticEnrichedMetadata({
          appId: 0,
          name: 'Synthetic Horizon Drift',
          shortDescription: 'Initial storefront native metadata.',
          headerImage: 'https://cdn.example.invalid/drift-header.jpg',
          screenshots: [
            {
              id: 1,
              pathThumbnail: 'https://cdn.example.invalid/drift-s1.jpg',
              pathFull: 'https://cdn.example.invalid/drift-s1-full.jpg',
            },
          ],
          movies: [],
          developers: ['Synthetic Drift Team'],
          publishers: ['Synthetic Publishing'],
          genres: ['Racing'],
          releaseDate: '2024-02-14',
          enrichedSource: 'xbox',
          metadataQuality: 'storefront_native',
        }),
      });

      // Run #1: Steam match has NOT been attempted yet -> eligible for rich Steam upgrade check
      expect(steamMatcher.hasAttemptedMatch(freshXboxGame.title)).toBe(false);
      expect(evaluateGameNeedsStoreMediaSync(freshXboxGame, false).eligible).toBe(true);

      vi.spyOn(steamMatcher, 'matchGameToSteam').mockImplementation(async (title: string) => {
        localStorage.setItem('antigravity_steam_matcher_schema_v5', '1');
        localStorage.setItem(
          'steam_app_id_match_cache_v4',
          JSON.stringify({
            [title.toLowerCase().trim()]: { appId: null, cachedAt: Date.now(), failureCount: 1 },
          })
        );
        return null;
      });
      vi.spyOn(fallbackMetadataProvider, 'getEnrichedMetadataForNonSteamGame').mockResolvedValue({
        ...freshXboxGame.enrichedMetadata!,
        movies: [],
      });
      testEnv.windowObj.electronAPI = undefined;

      let updatedCatalogGame: CanonicalGame = freshXboxGame;
      const jobMgrRun1 = new SyncJobManager();
      await jobMgrRun1.startStoreMediaSync(
        [freshXboxGame],
        (updated) => {
          updatedCatalogGame = updated;
        },
        { incremental: true, isBackgroundWarmup: true }
      );

      expect(hasFreshMediaSyncAttempt(freshXboxGame.id, updatedCatalogGame.enrichedMetadata)).toBe(
        true
      );
      expect(updatedCatalogGame.enrichedMetadata?.mediaSyncOutcome).toBe('partial_no_trailers');

      // Cold Launch #2: re-evaluate with persisted attempt + negative Steam match -> 0 games queued
      expect(evaluateGameNeedsStoreMediaSync(updatedCatalogGame, false).eligible).toBe(false);

      const fallbackSpyRun2 = vi.spyOn(
        fallbackMetadataProvider,
        'getEnrichedMetadataForNonSteamGame'
      );
      fallbackSpyRun2.mockClear();
      const jobMgrRun2 = new SyncJobManager();
      await jobMgrRun2.startStoreMediaSync(
        [updatedCatalogGame],
        () => {},
        { incremental: true, isBackgroundWarmup: true }
      );
      expect(fallbackSpyRun2).not.toHaveBeenCalled();
    });

    it('records durable negative/partial attempts for 0-screenshot, delisted Steam 404 & skeleton_fallback games, while manual forceRefresh bypasses cooldowns', async () => {
      // 1. Delisted Steam AppID 990404 returning { success: false }
      const axiosSpy = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (url.includes('IStoreBrowseService')) {
          return { data: { response: { store_items: [] } } };
        }
        if (url.includes('appdetails') && url.includes('990404')) {
          return { data: { '990404': { success: false } } };
        }
        return { data: '' };
      });

      const firstDelistedFetch = await steamApi.fetchGameMetadata(990404);
      expect(firstDelistedFetch).toBeNull();

      const neg404Cache = loadStagedCache<{ unavailable: boolean }>('steam_appdetails_404_v1_990404');
      expect(neg404Cache.valid).toBe(true);
      expect(neg404Cache.entry?.tier).toBe('negative');
      expect(neg404Cache.entry?.ttlMs).toBe(14 * 24 * 60 * 60 * 1000);

      // Second non-forced call short-circuits with 0 additional HTTP requests
      axiosSpy.mockClear();
      const secondDelistedFetch = await steamApi.fetchGameMetadata(990404);
      expect(secondDelistedFetch).toBeNull();
      expect(axiosSpy).not.toHaveBeenCalled();

      // 2. Run Store Media Sync across 0-screenshot, delisted Steam 404, and skeleton_fallback archetypes
      const zeroScreenshotsGame = buildSyntheticGame({
        id: 'gog-7700401',
        title: 'Synthetic Text Adventure',
        isExplicitNonSteam: true,
      });
      const delistedSteamGame = buildSyntheticGame({
        id: 'steam-990404',
        title: 'Synthetic Delisted Classic',
        steamAppId: 990404,
        platforms: [{ platformId: 'steam', platformGameId: '990404', installed: false }],
      });
      const skeletonFallbackGame = buildSyntheticGame({
        id: 'epic-synthetic-proto',
        title: 'Synthetic Unlisted Prototype',
        isExplicitNonSteam: true,
        platforms: [{ platformId: 'epic', platformGameId: 'synthetic-proto', installed: false }],
      });

      vi.spyOn(fallbackMetadataProvider, 'getEnrichedMetadataForNonSteamGame').mockImplementation(
        async (g: CanonicalGame): Promise<SteamEnrichedMetadata> => {
          if (g.id === 'gog-7700401') {
            return buildSyntheticEnrichedMetadata({
              appId: 0,
              name: g.title,
              shortDescription: 'Classic text-only adventure with zero store screenshots.',
              headerImage: 'https://cdn.example.invalid/text-header.jpg',
              screenshots: [],
              movies: [],
              developers: ['Synthetic Text Corp'],
              publishers: ['Synthetic Text Corp'],
              genres: ['Adventure'],
              releaseDate: '1998-05-01',
              metadataQuality: 'scraped',
            });
          }
          return buildSyntheticEnrichedMetadata({
            appId: 0,
            name: g.title,
            shortDescription: g.shortDescription || '',
            headerImage: g.headerImage,
            screenshots: [],
            movies: [],
            developers: g.developers,
            publishers: g.publishers,
            genres: g.genres,
            releaseDate: g.releaseDate || '2022-01-01',
            metadataQuality: 'skeleton_fallback',
          });
        }
      );

      // Stub HLTB network calls during warmup
      testEnv.windowObj.electronAPI = {
        searchHltb: vi.fn().mockResolvedValue({ success: true, data: [] }),
      };

      const updatedById = new Map<string, CanonicalGame>([
        [zeroScreenshotsGame.id, zeroScreenshotsGame],
        [delistedSteamGame.id, delistedSteamGame],
        [skeletonFallbackGame.id, skeletonFallbackGame],
      ]);

      const jobMgr = new SyncJobManager();
      await jobMgr.startStoreMediaSync(
        Array.from(updatedById.values()),
        (updated) => {
          updatedById.set(updated.id, updated);
        },
        { incremental: true, isBackgroundWarmup: true }
      );

      expect(loadStagedCache(`${MEDIA_ATTEMPT_KEY_PREFIX}gog-7700401`).data).toMatchObject({
        outcome: 'partial_no_screenshots',
      });
      expect(loadStagedCache(`${MEDIA_ATTEMPT_KEY_PREFIX}steam-990404`).data).toMatchObject({
        outcome: 'unavailable_404',
      });
      expect(loadStagedCache(`${MEDIA_ATTEMPT_KEY_PREFIX}epic-synthetic-proto`).data).toMatchObject({
        outcome: 'unavailable_404',
      });

      // Cold Launch #2: all 3 evaluate to eligible === false
      for (const g of updatedById.values()) {
        expect(evaluateGameNeedsStoreMediaSync(g, false).eligible).toBe(false);
      }

      // Manual forceRefresh: true bypasses negative cooldowns cleanly
      for (const g of updatedById.values()) {
        expect(evaluateGameNeedsStoreMediaSync(g, true).eligible).toBe(true);
      }

      axiosSpy.mockImplementation(async (url: string) => {
        if (url.includes('appdetails') && url.includes('990404')) {
          return {
            data: {
              '990404': {
                success: true,
                data: {
                  name: 'Synthetic Delisted Classic',
                  short_description: 'Restored official Steam store listing.',
                  header_image: 'https://cdn.example.invalid/restored-990404.jpg',
                  developers: ['Synthetic Studio'],
                  publishers: ['Synthetic Publishing'],
                  genres: [{ description: 'Action' }],
                  screenshots: [
                    {
                      id: 1,
                      path_thumbnail: 'https://cdn.example.invalid/s1.jpg',
                      path_full: 'https://cdn.example.invalid/s1_full.jpg',
                    },
                  ],
                  movies: [],
                  release_date: { date: '10 May, 2020' },
                },
              },
            },
          };
        }
        return { data: '' };
      });

      const forcedMeta = await steamApi.fetchGameMetadata(990404, undefined, { forceRefresh: true });
      expect(forcedMeta).not.toBeNull();
      expect(forcedMeta?.shortDescription).toBe('Restored official Steam store listing.');
      expect(loadStagedCache('steam_appdetails_404_v1_990404').valid).toBe(false);
    });
  });

  // =========================================================================
  // 3. Boot Vault Hydration Race, Compact Stub Unpinning & Clobber Protection
  // =========================================================================
  describe('3. Boot Vault Hydration Race (whenStagedCacheHydrated) & Compact Stub Unpinning', () => {
    it('prevents t=0ms synthetic filter reads from clobbering IDB-only scores and unpins >2KB compact stubs once hydrated', async () => {
      const now = Date.now();

      // Seed Game A (990501): Verified OpenCritic score ONLY in IndexedDB (evicted from localStorage)
      const verifiedGameAScore: CriticScoreData = {
        id: 'oc-990501',
        source: 'opencritic',
        score: 91,
        percentRecommended: 95,
        tier: 'Mighty',
        numReviews: 64,
        url: 'https://opencritic.com/game/990501/synthetic-odyssey',
        isVerified: true,
      };
      testEnv.idbStore.set('staged:antigravity_critic_v8_id:990501', {
        data: verifiedGameAScore,
        cachedAt: now,
        ttlMs: 180 * 24 * 60 * 60 * 1000,
        tier: 'immutable',
        version: 9,
        source: 'opencritic',
        isVerified: true,
        dynamicResolved: true,
      });

      // Seed Game B (990502): >2,500B full critic payload in IDB + <512B __vaultFull compact stub in localStorage
      const longSummary = `Masterpiece tactical design. ${'Detailed review paragraph with systems analysis. '.repeat(60)}`;
      const richGameBScore: CriticScoreData = {
        id: 'oc-990502',
        source: 'opencritic',
        score: 93,
        percentRecommended: 97,
        tier: 'Mighty',
        numReviews: 82,
        url: 'https://opencritic.com/game/990502/synthetic-citadel',
        summary: longSummary,
        isVerified: true,
      };
      // Write via saveStagedCache first to generate the authentic <512B __vaultFull compact stub in localStorage
      saveStagedCache('antigravity_critic_v8_id:990502', richGameBScore, 'immutable', {
        dynamicResolved: true,
        source: 'opencritic',
        isVerified: true,
      });
      const stubRaw = localStorage.getItem('antigravity_critic_v8_id:990502');
      expect(stubRaw).not.toBeNull();
      expect(stubRaw!.length).toBeLessThan(512);
      expect(JSON.parse(stubRaw!).__vaultFull).toBe(true);

      // Arm delayed IndexedDB boot hydration gate and reload fresh cold-launch module instances
      let releaseIdbGate!: () => void;
      const gatePromise = new Promise<void>((resolve) => {
        releaseIdbGate = resolve;
      });
      testEnv.setEntriesGate(gatePromise);

      vi.resetModules();
      const freshStaged = await import('../src/services/storage/stagedCacheService');
      const freshCritic = await import('../src/services/critic/criticScoreService');
      const freshFilter = await import('../src/services/filter/libraryFilterIndex');
      const freshSync = await import('../src/services/network/syncJobManager');

      // At t = 0ms, IndexedDB boot hydration is still in flight!
      expect(freshStaged.isStagedVaultHydrationComplete()).toBe(false);
      expect(freshStaged.isCompactStubInLocalStorage('antigravity_critic_v8_id:990502')).toBe(true);

      const gameA = buildSyntheticGame({
        id: 'steam-990501',
        title: 'Synthetic Odyssey',
        steamAppId: 990501,
        platforms: [{ platformId: 'steam', platformGameId: '990501', installed: false }],
        releaseDate: '2020-11-10',
        reviewSummary: {
          reviewScore: 8,
          positivePercent: 86,
          totalPositive: 1032,
          totalNegative: 168,
          totalReviews: 1200,
          reviewScoreDesc: 'Very Positive',
        },
      });
      const gameB = buildSyntheticGame({
        id: 'steam-990502',
        title: 'Synthetic Citadel',
        steamAppId: 990502,
        platforms: [{ platformId: 'steam', platformGameId: '990502', installed: false }],
        releaseDate: '2020-05-20',
      });

      // Synchronous buildLibraryFilterIndex at t = 0ms BEFORE IndexedDB finishes hydrating
      const indexAtBoot = freshFilter.buildLibraryFilterIndex([gameA, gameB], {
        hostPlatform: 'darwin',
      });
      expect(indexAtBoot.entriesById.get('steam-990501')?.criticScore).toBeGreaterThan(0);
      expect(indexAtBoot.entriesById.get('steam-990502')?.criticScore).toBe(93);

      // Game A's temporary synthetic Steam fallback MUST NOT have been written to localStorage!
      expect(localStorage.getItem('antigravity_critic_v8_id:990501')).toBeNull();

      // Start background critic warmup while IDB hydration is still pending
      const resolveSpy = vi.spyOn(freshCritic.criticScoreService, 'resolveDynamicScore');
      const syncMgr = new freshSync.SyncJobManager();
      const warmupPromise = syncMgr.startCriticScoreSync([gameA, gameB], {
        isBackgroundWarmup: true,
      });

      // Still gated on whenStagedCacheHydrated()
      expect(resolveSpy).not.toHaveBeenCalled();

      // Release IndexedDB cursor gate -> 'antigravity:staged-vault-hydrated' fires
      releaseIdbGate();
      await freshStaged.whenStagedCacheHydrated();
      await warmupPromise;

      expect(freshStaged.isStagedVaultHydrationComplete()).toBe(true);

      // 1. Game A now returns its verified 91 OpenCritic score from IDB (never clobbered!)
      const hydratedA = freshCritic.getOpenCriticData(
        990501,
        'Synthetic Odyssey',
        86,
        '2020-11-10',
        undefined,
        false,
        true
      );
      expect(hydratedA?.score).toBe(91);
      expect(hydratedA?.source).toBe('opencritic');
      expect(hydratedA?.isVerified).toBe(true);

      // 2. Game B was unpinned from stubPinnedKeys and now returns full >2KB summary!
      const hydratedB = freshCritic.getOpenCriticData(
        990502,
        'Synthetic Citadel',
        undefined,
        '2020-05-20',
        undefined,
        false,
        true
      );
      expect(hydratedB?.score).toBe(93);
      expect(hydratedB?.summary).toBe(longSummary);
      expect(hydratedB?.summary?.length).toBeGreaterThan(2500);

      // 3. Background warmup saw both hydrated records and executed 0 network resolutions!
      expect(resolveSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. Proactive < 2.5 MB localStorage Catalog Compaction & Sibling Caches
  // =========================================================================
  describe('4. Proactive < 2.5 MB localStorage Catalog Compaction & Sibling Caches', () => {
    it('retains full media in localStorage when <=2.5 MB, proactively slims >2.5 MB while keeping full rich catalog in IDB, and restores unslimmed metadata', async () => {
      const smallGame = buildSyntheticGame({
        id: 'steam-990601',
        title: 'Synthetic Compact Quest',
        steamAppId: 990601,
        platforms: [{ platformId: 'steam', platformGameId: '990601', installed: false }],
        enrichedMetadata: buildSyntheticEnrichedMetadata({
          appId: 990601,
          name: 'Synthetic Compact Quest',
          shortDescription: 'Compact test game.',
          detailedDescription: '<p>Full HTML description preserved when catalog is small.</p>',
          headerImage: 'https://cdn.example.invalid/compact-header.jpg',
          screenshots: [
            {
              id: 1,
              pathThumbnail: 'https://cdn.example.invalid/c1-thumb.jpg',
              pathFull: 'https://cdn.example.invalid/c1-full.jpg',
            },
          ],
          movies: [
            {
              id: 10,
              name: 'Launch Trailer',
              thumbnail: 'https://cdn.example.invalid/m1.jpg',
              webm: { max: 'https://cdn.example.invalid/m1.webm' },
            },
          ],
          developers: ['Synthetic Studio'],
          publishers: ['Synthetic Publishing'],
          genres: ['RPG'],
          releaseDate: '2023-01-15',
          metadataQuality: 'authoritative',
          enrichedSource: 'steam',
        }),
      });

      saveCurrentCatalog([smallGame], { immediate: true, skipSanitize: true });
      flushPendingCatalogSave();

      const rawSmall = localStorage.getItem('universal_game_library_catalog');
      expect(rawSmall).not.toBeNull();
      const parsedSmall = JSON.parse(rawSmall!) as CanonicalGame[];
      expect(parsedSmall[0]?.enrichedMetadata?.__quotaSlimmed).toBeUndefined();
      expect(parsedSmall[0]?.enrichedMetadata?.screenshots).toHaveLength(1);
      expect(parsedSmall[0]?.enrichedMetadata?.movies).toHaveLength(1);

      // Now construct a >2.5 MB synthetic catalog (120 games * ~24 KB HTML/media = ~2.9 MB)
      const largeHtmlBlock = `<div class="synthetic-desc">${'<p>Rich synthetic lore and mechanics paragraph with formatting.</p>'.repeat(340)}</div>`;
      const largeCatalog: CanonicalGame[] = Array.from({ length: 120 }, (_, idx) => {
        const appId = 991000 + idx;
        return buildSyntheticGame({
          id: `steam-${appId}`,
          title: `Synthetic Anthology Volume ${idx + 1}`,
          steamAppId: appId,
          platforms: [{ platformId: 'steam', platformGameId: String(appId), installed: false }],
          enrichedMetadata: buildSyntheticEnrichedMetadata({
            appId,
            name: `Synthetic Anthology Volume ${idx + 1}`,
            shortDescription: `Volume ${idx + 1} synopsis.`,
            detailedDescription: largeHtmlBlock,
            headerImage: `https://cdn.example.invalid/anthology/${appId}/header.jpg`,
            screenshots: Array.from({ length: 6 }, (__, sIdx) => ({
              id: sIdx + 1,
              pathThumbnail: `https://cdn.example.invalid/anthology/${appId}/s${sIdx}_thumb.jpg`,
              pathFull: `https://cdn.example.invalid/anthology/${appId}/s${sIdx}_full.jpg`,
            })),
            movies: Array.from({ length: 2 }, (__, mIdx) => ({
              id: mIdx + 1,
              name: `Official Trailer ${mIdx + 1}`,
              thumbnail: `https://cdn.example.invalid/anthology/${appId}/m${mIdx}.jpg`,
              mp4: { max: `https://cdn.example.invalid/anthology/${appId}/m${mIdx}.mp4` },
            })),
            developers: ['Synthetic Studio'],
            publishers: ['Synthetic Publishing'],
            genres: ['Action'],
            releaseDate: '2022-10-01',
            metadataQuality: 'authoritative',
            enrichedSource: 'steam',
          }),
        });
      });

      expect(JSON.stringify(largeCatalog).length).toBeGreaterThan(2_500_000);

      saveCurrentCatalog(largeCatalog, { immediate: true, skipSanitize: true });
      flushPendingCatalogSave();

      const rawSlimmed = localStorage.getItem('universal_game_library_catalog');
      expect(rawSlimmed).not.toBeNull();
      expect(rawSlimmed!.length).toBeLessThan(2_500_000);

      const parsedSlimmed = JSON.parse(rawSlimmed!) as CanonicalGame[];
      const slimSample = parsedSlimmed[0]!;
      expect(slimSample.enrichedMetadata?.__quotaSlimmed).toBe(true);
      expect(slimSample.enrichedMetadata?.hasScreenshotsCount).toBe(6);
      expect(slimSample.enrichedMetadata?.hasMoviesCount).toBe(2);
      expect(slimSample.enrichedMetadata?.screenshots).toBeUndefined();
      expect(slimSample.enrichedMetadata?.detailedDescription).toBeUndefined();

      // IndexedDB retains the full unslimmed rich catalog
      const idbCatalog = testEnv.idbStore.get(
        'idb_universal_game_library_catalog_v2'
      ) as CanonicalGame[];
      expect(Array.isArray(idbCatalog)).toBe(true);
      expect(idbCatalog[0]?.enrichedMetadata?.__quotaSlimmed).toBeUndefined();
      expect(idbCatalog[0]?.enrichedMetadata?.screenshots).toHaveLength(6);
      expect(idbCatalog[0]?.enrichedMetadata?.movies).toHaveLength(2);
      expect(idbCatalog[0]?.enrichedMetadata?.detailedDescription).toBe(largeHtmlBlock);

      // Slimmed localStorage snapshot does NOT falsely trigger background Store Media re-sync!
      expect(evaluateGameNeedsStoreMediaSync(slimSample, false)).toEqual({
        eligible: false,
        alreadyEnriched: true,
      });

      // pickBestEnrichedMetadata upgrades __quotaSlimmed record with full IDB record & clears __quotaSlimmed
      const restoredMeta = pickBestEnrichedMetadata(
        slimSample.enrichedMetadata,
        idbCatalog[0]?.enrichedMetadata
      );
      expect(restoredMeta?.__quotaSlimmed).toBeUndefined();
      expect(restoredMeta?.screenshots).toHaveLength(6);
      expect(restoredMeta?.movies).toHaveLength(2);
      expect(restoredMeta?.detailedDescription).toBe(largeHtmlBlock);
    });

    it('hydrates HLTB positive & 14d unmatched negative records from IndexedDB vault and prevents repeat negative lookups', async () => {
      const searchHltbMock = vi.fn().mockResolvedValue({ success: true, data: [] });
      testEnv.windowObj.electronAPI = { searchHltb: searchHltbMock };

      expect(hasAttemptedHltbLookup('Synthetic Obscure Arcade', 990650)).toBe(false);
      const firstLookup = await fetchAndCacheHltb('Synthetic Obscure Arcade', 990650);
      expect(firstLookup).toBeNull();
      expect(searchHltbMock).toHaveBeenCalledTimes(1);

      // Returns null (never fabricates playtime) while marking lookup as attempted for 14 days
      expect(getHowLongToBeat('Synthetic Obscure Arcade', 990650)).toBeNull();
      expect(hasAttemptedHltbLookup('Synthetic Obscure Arcade', 990650)).toBe(true);

      // Second lookup short-circuits on cached unmatched record with 0 IPC/network calls
      const secondLookup = await fetchAndCacheHltb('Synthetic Obscure Arcade', 990650);
      expect(secondLookup).toBeNull();
      expect(searchHltbMock).toHaveBeenCalledTimes(1);

      // Simulate Cold Launch #2 where localStorage was cleared but IndexedDB ('hltb_lru_v3') survived
      const now = Date.now();
      testEnv.idbStore.set('hltb_lru_v3', {
        'synthetic quest': {
          mainStoryHours: 14.5,
          mainExtraHours: 22,
          completionistHours: 35,
          allStylesHours: 18,
          isAccurate: true,
          cachedAt: now,
        },
        'synthetic indie mini': {
          mainStoryHours: 0,
          mainExtraHours: 0,
          completionistHours: 0,
          allStylesHours: 0,
          isAccurate: false,
          unmatched: true,
          cachedAt: now,
        },
      });
      localStorage.clear();

      vi.resetModules();
      const freshHltb = await import('../src/services/hltb/howLongToBeat');
      await new Promise((r) => setTimeout(r, 10));

      expect(freshHltb.getHowLongToBeat('Synthetic Quest')?.mainStoryHours).toBe(14.5);
      expect(freshHltb.hasAttemptedHltbLookup('Synthetic Quest')).toBe(true);
      expect(freshHltb.getHowLongToBeat('Synthetic Indie Mini')).toBeNull();
      expect(freshHltb.hasAttemptedHltbLookup('Synthetic Indie Mini')).toBe(true);
    });

    it('mirrors IGDB covers to IndexedDB vault and reconciles userOverrideStorage <-> offlineVault by updatedAt via batchOverrides without evicting critic scores', async () => {
      const now = Date.now();
      testEnv.idbStore.set('antigravity_igdb_covers_v2', {
        'synthetic starlight': 'https://images.igdb.com/igdb/image/upload/t_cover_big/co888888.jpg',
        'synthetic unindexed title': { url: null, cachedAt: now },
      });
      localStorage.clear();

      const freshCoverSvc = new IgdbCoverService();
      freshCoverSvc.ensureInitialized();
      await new Promise((r) => setTimeout(r, 10));

      expect(freshCoverSvc.getIgdbCoverInstant('Synthetic Starlight')).toBe(
        'https://images.igdb.com/igdb/image/upload/t_cover_big/co888888.jpg'
      );
      expect(freshCoverSvc.hasAttemptedIgdbCover('Synthetic Unindexed Title')).toBe(true);
      expect(freshCoverSvc.getIgdbCoverInstant('Synthetic Unindexed Title')).toBeNull();

      // Seed localStorage overrides with 1 newer local entry (+ internal colon alias) and 1 older local entry
      localStorage.setItem(
        STORAGE_KEY_USER_OVERRIDES,
        JSON.stringify({
          'gog-701': {
            gameId: 'gog-701',
            platformId: 'gog',
            platformGameId: '701',
            title: 'Newer Local Override Title',
            updatedAt: '2026-10-29T18:00:00.000Z',
          },
          'gog:701': {
            gameId: 'gog-701',
            platformId: 'gog',
            platformGameId: '701',
            title: 'Newer Local Override Title',
            updatedAt: '2026-10-29T18:00:00.000Z',
          },
          'gog-702': {
            gameId: 'gog-702',
            platformId: 'gog',
            platformGameId: '702',
            title: 'Older Local Override Title',
            steamAppId: 990702,
            updatedAt: '2026-10-20T10:00:00.000Z',
          },
        })
      );

      // Seed a cached critic score for 990702 to confirm hydratedFromVault events do NOT evict it
      saveStagedCache(
        'antigravity_critic_v8_id:990702',
        {
          id: 'oc-990702',
          source: 'opencritic',
          score: 87,
          percentRecommended: 88,
          tier: 'Strong',
          numReviews: 30,
          url: 'https://opencritic.com/game/990702/synthetic-702',
          isVerified: true,
        },
        'immutable',
        { dynamicResolved: true, isVerified: true }
      );
      await hydrateAllStagedCacheFromVault();

      const saveUserOverrideIpcMock = vi.fn().mockResolvedValue({ success: true });
      testEnv.windowObj.electronAPI = {
        offlineVault: {
          getUserOverrides: vi.fn().mockResolvedValue({
            'gog-702': {
              gameId: 'gog-702',
              platformId: 'gog',
              platformGameId: '702',
              title: 'Newer Vault Override Title',
              steamAppId: 990702,
              updatedAt: '2026-10-29T19:00:00.000Z',
            },
            'gog-703': {
              gameId: 'gog-703',
              platformId: 'gog',
              platformGameId: '703',
              title: 'Vault Exclusive Override Title',
              updatedAt: '2026-10-28T12:00:00.000Z',
            },
          }),
          saveUserOverride: saveUserOverrideIpcMock,
        },
      };

      const changed = await hydrateUserOverridesFromVault();
      expect(changed).toBe(true);

      const reconciledLocal = loadUserOverrides();
      expect(reconciledLocal['gog-701']?.title).toBe('Newer Local Override Title');
      expect(reconciledLocal['gog-702']?.title).toBe('Newer Vault Override Title');
      expect(reconciledLocal['gog-703']?.title).toBe('Vault Exclusive Override Title');

      // Only canonical 'gog-701' is pushed to offlineVault via batchOverrides (no 'gog:701' alias duplication!)
      expect(saveUserOverrideIpcMock).toHaveBeenCalledTimes(1);
      const pushedArg = saveUserOverrideIpcMock.mock.calls[0]?.[0] as {
        batchOverrides?: Record<string, { title?: string }>;
      };
      expect(Object.keys(pushedArg.batchOverrides || {})).toEqual(['gog-701']);

      // Cached critic score for 990702 was NOT evicted by vault-hydration event
      expect(loadStagedCache('antigravity_critic_v8_id:990702').valid).toBe(true);
    });
  });

  // =========================================================================
  // 5. Electron OfflineVaultService, MediaHydrationEngine & Async IPC Queue
  // =========================================================================
  describe('5. Electron OfflineVaultService, MediaHydrationEngine & Async offlineVaultIpcHandlers', () => {
    let tempDir: string;
    const openVaults: Array<{ shutdown: () => void }> = [];
    const openEngines: Array<{ shutdown: () => void }> = [];

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cold-launch-qa-'));
    });

    afterEach(() => {
      while (openEngines.length > 0) {
        const eng = openEngines.pop();
        try {
          eng?.shutdown();
        } catch {}
      }
      while (openVaults.length > 0) {
        const v = openVaults.pop();
        try {
          v?.shutdown();
        } catch {}
      }
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('migrates media_hydrated_at, stamps enrichedMetadata.enrichedAt in getCatalogSnapshot & keeps summary_json.steamAppId unset on non-Steam games', () => {
      // Create a pre-migration SQLite DB lacking `media_hydrated_at` to verify seamless ALTER TABLE migration
      const vaultRoot = path.join(tempDir, 'offline-vault');
      fs.mkdirSync(vaultRoot, { recursive: true });
      const dbPath = path.join(vaultRoot, 'catalog_metadata.sqlite');
      const legacyDb = new DatabaseSync(dbPath);
      legacyDb.exec(`
        CREATE TABLE vault_games (
          game_id TEXT PRIMARY KEY,
          canonical_title TEXT NOT NULL DEFAULT '',
          steam_app_id INTEGER,
          is_installed INTEGER NOT NULL DEFAULT 0,
          is_favorited INTEGER NOT NULL DEFAULT 0,
          archived_by_subscription_rotation INTEGER NOT NULL DEFAULT 0,
          platforms_json TEXT,
          summary_json TEXT,
          enriched_json TEXT,
          achievements_json TEXT,
          hltb_json TEXT,
          critic_json TEXT,
          metadata_quality TEXT NOT NULL DEFAULT 'skeleton_fallback',
          updated_at INTEGER NOT NULL DEFAULT 0,
          enriched_at INTEGER NOT NULL DEFAULT 0
        );
      `);
      legacyDb.close();

      const vault = new offlineVaultMod.OfflineVaultService({ userDataDir: tempDir });
      openVaults.push(vault);
      vault.init();

      const cols = vault.db.prepare(`PRAGMA table_info(vault_games)`).all() as Array<{
        name: string;
      }>;
      expect(cols.some((c) => c.name === 'media_hydrated_at')).toBe(true);

      // Upsert non-Steam GOG game (steamAppId undefined) + matched Steam detail (steamAppId 990701)
      vault.upsertGames([
        buildSyntheticGame({
          id: 'gog-88001',
          title: 'Synthetic Relic',
          steamAppId: undefined,
          platforms: [{ platformId: 'gog', platformGameId: '88001', installed: false }],
        }),
      ]);

      const enrichedTimestamp = 1_760_000_000_000;
      vault.saveGameDetail({
        gameId: 'gog-88001',
        steamAppId: 990701,
        canonicalTitle: 'Synthetic Relic',
        enrichedMetadata: {
          appId: 990701,
          name: 'Synthetic Relic',
          shortDescription: 'Authoritative synopsis persisted in SQLite vault_games.',
          screenshots: [
            {
              id: 1,
              pathThumbnail: 'https://cdn.example.invalid/relic-s1.jpg',
              pathFull: 'https://cdn.example.invalid/relic-s1-full.jpg',
            },
          ],
          movies: [],
        },
        metadataQuality: 'authoritative',
        enrichedAt: enrichedTimestamp,
      });

      const snapshot = vault.getCatalogSnapshot();
      expect(snapshot.success).toBe(true);
      const hydratedGogGame = snapshot.games.find((g: CanonicalGame) => g.id === 'gog-88001');
      expect(hydratedGogGame).toBeDefined();

      // summary_json.steamAppId MUST remain undefined on non-Steam entitlements
      expect(hydratedGogGame.steamAppId).toBeUndefined();
      // enrichedMetadata.enrichedAt is stamped from vault_games.enriched_at
      expect(hydratedGogGame.enrichedMetadata?.enrichedAt).toBe(enrichedTimestamp);
      expect(snapshot.details['gog-88001']?.enrichedMetadata?.enrichedAt).toBe(enrichedTimestamp);

      // Verify clean shutdown guard
      vault.shutdown();
      expect(vault.isShutdown).toBe(true);
      expect(vault.markGameMediaHydrated('gog-88001').success).toBe(false);
    });

    it('stamps media_hydrated_at > 0 in MediaHydrationEngine for both 0-asset games and completed multi-asset games', async () => {
      const vault = new offlineVaultMod.OfflineVaultService({
        userDataDir: tempDir,
        fetchImpl: async () =>
          new Response(SYNTHETIC_PNG_1X1, {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
          }),
      });
      openVaults.push(vault);
      vault.init();

      vault.upsertGames([
        buildSyntheticGame({
          id: 'custom-zero-assets',
          title: 'Synthetic Zero Asset Tool',
          platforms: [{ platformId: 'custom', platformGameId: 'zero-1', installed: true }],
          capsuleImage: '',
          headerImage: '',
        }),
        buildSyntheticGame({
          id: 'steam-990702',
          title: 'Synthetic Multi Asset Adventure',
          steamAppId: 990702,
          platforms: [{ platformId: 'steam', platformGameId: '990702', installed: true }],
        }),
      ]);

      vault.saveGameDetail({
        gameId: 'custom-zero-assets',
        canonicalTitle: 'Synthetic Zero Asset Tool',
        enrichedMetadata: {
          appId: 0,
          name: 'Synthetic Zero Asset Tool',
          shortDescription: 'Local utility with zero remote image URLs.',
          screenshots: [],
          movies: [],
          metadataQuality: 'scraped',
        },
        metadataQuality: 'scraped',
      });
      vault.saveGameDetail({
        gameId: 'steam-990702',
        steamAppId: 990702,
        canonicalTitle: 'Synthetic Multi Asset Adventure',
        enrichedMetadata: {
          appId: 990702,
          name: 'Synthetic Multi Asset Adventure',
          shortDescription: 'Adventure with cover and header assets.',
          screenshots: [],
          movies: [],
          metadataQuality: 'authoritative',
        },
        metadataQuality: 'authoritative',
      });

      const engine = new hydrationEngineMod.MediaHydrationEngine({
        offlineVaultService: vault,
        itemDelayMs: 1,
        warmStartDurationMs: 0,
      });
      openEngines.push(engine);

      // 1. 0-asset game stamps media_hydrated_at immediately during queueHydration
      engine.queueHydration({
        games: [
          {
            gameId: 'custom-zero-assets',
            title: 'Synthetic Zero Asset Tool',
            isInstalled: true,
            assets: [],
          },
        ],
      });
      expect(vault.getGameDetail('custom-zero-assets')?.mediaHydratedAt).toBeGreaterThan(0);

      // 2. Multi-asset game stamps media_hydrated_at > 0 once all queued assets finish hydrating
      const hydratedDone = new Promise<void>((resolve) => {
        engine.onGameHydrated((payload: { gameId?: string }) => {
          if (payload?.gameId === 'steam-990702') {
            resolve();
          }
        });
      });

      engine.queueHydration({
        games: [
          {
            gameId: 'steam-990702',
            title: 'Synthetic Multi Asset Adventure',
            steamAppId: 990702,
            isInstalled: true,
            assets: [
              {
                role: 'cover',
                ordinal: 0,
                url: 'https://cdn.example.invalid/990702/cover.png',
              },
              {
                role: 'header',
                ordinal: 0,
                url: 'https://cdn.example.invalid/990702/header.png',
              },
            ],
          },
        ],
      });

      await hydratedDone;
      expect(vault.getGameDetail('steam-990702')?.mediaHydratedAt).toBeGreaterThan(0);
    });

    it('serializes concurrent async user_overrides.json writes, honors batchOverrides updatedAt precedence & retries Windows EPERM rename locks', async () => {
      const vault = new offlineVaultMod.OfflineVaultService({ userDataDir: tempDir });
      openVaults.push(vault);
      vault.init();

      const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
      const mockIpcMain = {
        handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
          handlers.set(channel, fn);
        },
        removeHandler: (channel: string) => {
          handlers.delete(channel);
        },
      };

      const reg = offlineVaultIpcMod.registerOfflineVaultIpcHandlers({
        ipcMain: mockIpcMain,
        offlineVaultService: vault,
        userDataDir: tempDir,
      });

      const saveHandler = handlers.get('offlineVault:save-user-override')!;
      const getHandler = handlers.get('offlineVault:get-user-overrides')!;
      expect(saveHandler).toBeTypeOf('function');
      expect(getHandler).toBeTypeOf('function');

      // Simulate transient Windows NTFS / Defender EPERM lock on first 2 rename attempts
      const origRename = fs.promises.rename.bind(fs.promises);
      let simulatedEpermCount = 0;
      const renameSpy = vi
        .spyOn(fs.promises, 'rename')
        .mockImplementation(async (oldPath, newPath) => {
          if (String(newPath).endsWith('user_overrides.json') && simulatedEpermCount < 2) {
            simulatedEpermCount++;
            const eperm = Object.assign(new Error('Simulated Windows NTFS EPERM lock'), {
              code: 'EPERM',
            });
            throw eperm;
          }
          return origRename(oldPath, newPath);
        });

      // Fire 8 concurrent single-override saves + 1 batchOverrides reconciliation concurrently
      await Promise.all([
        ...Array.from({ length: 8 }, (_, idx) =>
          saveHandler(
            {},
            `gog-concurrent-${idx}`,
            {
              gameId: `gog-concurrent-${idx}`,
              title: `Synthetic Concurrent Title ${idx}`,
              updatedAt: '2026-10-29T15:00:00.000Z',
            }
          )
        ),
        saveHandler(
          {},
          {
            batchOverrides: {
              // Older than gog-concurrent-0's 15:00 timestamp -> must NOT overwrite!
              'gog-concurrent-0': {
                gameId: 'gog-concurrent-0',
                title: 'Stale Batch Title Should Lose',
                updatedAt: '2026-10-20T00:00:00.000Z',
              },
              // Newer than gog-concurrent-1's 15:00 timestamp -> MUST win!
              'gog-concurrent-1': {
                gameId: 'gog-concurrent-1',
                title: 'Newer Batch Title Should Win',
                updatedAt: '2026-10-29T20:00:00.000Z',
              },
              'gog-batch-extra': {
                gameId: 'gog-batch-extra',
                title: 'Batch Added Title',
                updatedAt: '2026-10-29T18:00:00.000Z',
              },
            },
          }
        ),
      ]);

      expect(simulatedEpermCount).toBe(2);
      renameSpy.mockRestore();

      const persisted = (await getHandler({})) as Record<string, { title?: string }>;
      expect(Object.keys(persisted)).toHaveLength(9);
      expect(persisted['gog-concurrent-0']?.title).toBe('Synthetic Concurrent Title 0');
      expect(persisted['gog-concurrent-1']?.title).toBe('Newer Batch Title Should Win');
      expect(persisted['gog-batch-extra']?.title).toBe('Batch Added Title');
      for (let idx = 2; idx < 8; idx++) {
        expect(persisted[`gog-concurrent-${idx}`]?.title).toBe(
          `Synthetic Concurrent Title ${idx}`
        );
      }

      // Confirm zero leftover .tmp files in userDataDir
      const remainingTmp = fs.readdirSync(tempDir).filter((f) => f.endsWith('.tmp'));
      expect(remainingTmp).toEqual([]);

      reg.dispose();
    });
  });
});
