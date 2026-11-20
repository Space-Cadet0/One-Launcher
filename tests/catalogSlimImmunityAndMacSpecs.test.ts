import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import axios from 'axios';

const testEnv = vi.hoisted(() => {
  class MemoryStorage implements Storage {
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

  const mockStorage = new MemoryStorage();
  const idbStore = new Map<string, unknown>();
  const windowEvents = new EventTarget();

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

  const windowObj: Record<string, unknown> = {
    localStorage: mockStorage,
    indexedDB: globalRecord.indexedDB,
    location: { hostname: 'app.local' },
    navigator: { onLine: true, platform: 'MacIntel' },
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
    electronAPI: { platform: 'darwin' },
  };
  globalRecord.window = windowObj;

  return {
    mockStorage,
    idbStore,
    windowObj,
    reset() {
      mockStorage.clear();
      idbStore.clear();
      windowObj.location = { hostname: 'app.local' };
      windowObj.navigator = { onLine: true, platform: 'MacIntel' };
      windowObj.electronAPI = { platform: 'darwin' };
      delete windowObj.__ENABLE_AUTO_STORE_MEDIA_WARMUP__;
      delete windowObj.__ENABLE_AUTO_HLTB_WARMUP__;
    },
  };
});

vi.mock('../src/services/storage/indexedDbVault', () => ({
  isIndexedDbAvailable: () => true,
  vaultGet: vi.fn(async <T>(key: string): Promise<T | null> => {
    if (!testEnv.idbStore.has(key)) return null;
    return structuredClone(testEnv.idbStore.get(key)) as T;
  }),
  vaultSet: vi.fn(async <T>(key: string, value: T): Promise<boolean> => {
    testEnv.idbStore.set(key, structuredClone(value));
    return true;
  }),
  vaultDelete: vi.fn(async (key: string): Promise<boolean> => {
    testEnv.idbStore.delete(key);
    return true;
  }),
  vaultEntriesByPrefix: vi.fn(async <T>(prefix: string): Promise<Array<[string, T]>> => {
    const out: Array<[string, T]> = [];
    for (const [k, v] of testEnv.idbStore.entries()) {
      if (k.startsWith(prefix)) {
        out.push([k, structuredClone(v) as T]);
      }
    }
    return out;
  }),
}));

import { CanonicalGame } from '../src/contracts/game';
import { SteamEnrichedMetadata } from '../src/contracts/steam';
import { HowLongToBeatCard } from '../src/components/SteamStoreDetail/HowLongToBeatCard';
import { sanitizeGameCatalog } from '../src/services/integrations/catalogSanitizer';
import {
  getEnrichedMetadataQualityRank,
  pickBestEnrichedMetadata,
} from '../src/services/storage/librarySync';
import {
  loadCurrentCatalog,
  saveCurrentCatalog,
  flushPendingCatalogSave,
  hydrateCatalogFromIndexedDb,
  slimGameForLocalStorageQuota,
} from '../src/services/integrations/integrationStorage';
import * as indexedDbVault from '../src/services/storage/indexedDbVault';
import {
  isSynopsisAlreadyProbed,
  recordDurableEmptySynopsisProbe,
  hasDurableEmptySynopsisProbe,
  clearDurableEmptySynopsisProbe,
} from '../src/components/Library/MatchManager/matchManagerDiagnostics';
import {
  SyncJobManager,
  syncJobManager,
  evaluateGameNeedsStoreMediaSync,
  computeMediaRepairPriority,
  MAX_PASSIVE_REPAIR_PER_BOOT,
} from '../src/services/network/syncJobManager';
import { requestScheduler } from '../src/services/network/requestScheduler';
import { onlineLifecycleManager } from '../src/services/network/onlineLifecycleManager';
import { steamApi, SteamApiService } from '../src/services/steam/steamApi';
import { steamMatcher } from '../src/services/steam/steamMatcher';
import {
  fallbackMetadataProvider,
  extractGogRequirementsByOs,
  extractEpicRequirementsByOs,
} from '../src/services/steam/fallbackMetadataProvider';
import { saveUserOverride, removeUserOverride } from '../src/services/storage/userOverrideStorage';
import { useBackgroundMediaWarmup } from '../src/hooks/useBackgroundMediaWarmup';
import { useManualLibrarySyncActions } from '../src/hooks/useManualLibrarySyncActions';
import { launcherService } from '../src/services/launcher/launcherService';
import * as stagedCacheService from '../src/services/storage/stagedCacheService';

const nodeRequire = createRequire(import.meta.url);
const { OfflineVaultService } = nodeRequire('../electron/launcher/offlineVaultService.cjs') as {
  OfflineVaultService: new (opts: { userDataDir: string; now?: () => number }) => {
    upsertGames: (games: CanonicalGame[]) => { success: boolean; upserted: number; skipped: number };
    getCatalogSnapshot: () => {
      success: boolean;
      games: CanonicalGame[];
      details: Record<
        string,
        { enrichedMetadata?: SteamEnrichedMetadata; metadataQuality?: string; enrichedAt?: number }
      >;
    };
    getGameDetail: (gameId: string) => {
      enrichedMetadata?: SteamEnrichedMetadata;
      metadataQuality?: string;
    } | null;
    saveGameDetail: (payload: {
      gameId: string;
      steamAppId?: number | null;
      canonicalTitle?: string;
      enrichedMetadata?: SteamEnrichedMetadata;
      metadataQuality?: string;
      enrichedAt?: number;
    }) => { success: boolean };
    shutdown: () => void;
  };
};

// Minimal zero-dependency React 19 hook runner for client hook verification
interface HookFiber {
  states: unknown[];
  refs: Array<{ current: unknown }>;
  memos: Array<{ deps?: readonly unknown[]; value: unknown }>;
  effectDeps: Array<readonly unknown[] | undefined>;
  effectCleanups: Array<(() => void) | undefined>;
}

function mountHookHarness<P extends object, R>(
  useHook: (props: P) => R,
  initialProps: P
): { getResult: () => R; rerender: (next: P) => void; unmount: () => void } {
  let currentProps = { ...initialProps };
  let latestResult!: R;
  let isUnmounted = false;
  let dirty = false;
  const fiber: HookFiber = {
    states: [],
    refs: [],
    memos: [],
    effectDeps: [],
    effectCleanups: [],
  };

  const depsChanged = (
    prev: readonly unknown[] | undefined,
    next: readonly unknown[] | undefined
  ): boolean =>
    prev === undefined ||
    next === undefined ||
    prev.length !== next.length ||
    next.some((d, i) => !Object.is(d, prev[i]));

  const runCycle = () => {
    const pendingEffects: Array<{ idx: number; fn: () => void | (() => void) }> = [];
    const internals = (
      React as unknown as {
        __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
      }
    ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prevH = internals.H;

    let stateIdx = 0;
    let refIdx = 0;
    let memoIdx = 0;
    let effectIdx = 0;

    internals.H = {
      useState<S>(initial: S | (() => S)) {
        const idx = stateIdx++;
        if (idx >= fiber.states.length) {
          fiber.states.push(typeof initial === 'function' ? (initial as () => S)() : initial);
        }
        const setState = (updater: S | ((prev: S) => S)) => {
          if (isUnmounted) return;
          const prevVal = fiber.states[idx] as S;
          const nextVal =
            typeof updater === 'function' ? (updater as (prev: S) => S)(prevVal) : updater;
          if (!Object.is(prevVal, nextVal)) {
            fiber.states[idx] = nextVal;
            dirty = true;
          }
        };
        return [fiber.states[idx] as S, setState] as const;
      },
      useRef<T>(initial: T) {
        const idx = refIdx++;
        if (idx >= fiber.refs.length) {
          fiber.refs.push({ current: initial });
        }
        return fiber.refs[idx] as { current: T };
      },
      useMemo<T>(factory: () => T, deps?: readonly unknown[]) {
        const idx = memoIdx++;
        const prev = fiber.memos[idx];
        if (!prev || depsChanged(prev.deps, deps)) {
          const value = factory();
          fiber.memos[idx] = { deps: deps ? [...deps] : undefined, value };
          return value;
        }
        return prev.value as T;
      },
      useCallback<T extends (...args: never[]) => unknown>(cb: T, deps?: readonly unknown[]) {
        const idx = memoIdx++;
        const prev = fiber.memos[idx];
        if (!prev || depsChanged(prev.deps, deps)) {
          fiber.memos[idx] = { deps: deps ? [...deps] : undefined, value: cb };
          return cb;
        }
        return prev.value as T;
      },
      useEffect(fn: () => void | (() => void), deps?: readonly unknown[]) {
        const idx = effectIdx++;
        const prevDeps = fiber.effectDeps[idx];
        if (idx >= fiber.effectDeps.length || depsChanged(prevDeps, deps)) {
          fiber.effectDeps[idx] = deps ? [...deps] : undefined;
          pendingEffects.push({ idx, fn });
        }
      },
    };

    try {
      latestResult = useHook(currentProps);
    } finally {
      internals.H = prevH;
    }

    for (const eff of pendingEffects) {
      fiber.effectCleanups[eff.idx]?.();
      const cleanup = eff.fn();
      fiber.effectCleanups[eff.idx] = typeof cleanup === 'function' ? cleanup : undefined;
    }
  };

  const flush = () => {
    let guard = 0;
    do {
      dirty = false;
      runCycle();
      guard++;
    } while (dirty && guard < 12);
  };

  flush();

  return {
    getResult: () => latestResult,
    rerender(next: P) {
      currentProps = { ...next };
      flush();
    },
    unmount() {
      isUnmounted = true;
      for (const cleanup of fiber.effectCleanups) {
        cleanup?.();
      }
    },
  };
}

function makeRichMeta(overrides: Partial<SteamEnrichedMetadata> = {}): SteamEnrichedMetadata {
  return {
    appId: 991001,
    name: 'Synthetic Starforge Odyssey',
    shortDescription: 'Explore charted star systems and forge modular fleets across ancient ruins.',
    detailedDescription: '<p>Full official store overview with tactical fleet gameplay.</p>',
    aboutTheGame: '<p>Deep orbital campaign with native Apple Silicon and DirectX 12 support.</p>',
    headerImage: 'https://cdn.example.invalid/991001/header.jpg',
    capsuleImage: 'https://cdn.example.invalid/991001/library_600x900.jpg',
    developers: ['Synthetic Orbital Works'],
    publishers: ['Synthetic Frontier Publishing'],
    releaseDate: '2025-04-12',
    genres: ['RPG', 'Strategy', 'Sci-Fi'],
    tags: ['Space', 'Tactical', 'Singleplayer'],
    categories: [{ id: 2, description: 'Single-player' }],
    screenshots: [
      {
        id: 1,
        pathThumbnail: 'https://cdn.example.invalid/991001/s1_thumb.jpg',
        pathFull: 'https://cdn.example.invalid/991001/s1_full.jpg',
      },
      {
        id: 2,
        pathThumbnail: 'https://cdn.example.invalid/991001/s2_thumb.jpg',
        pathFull: 'https://cdn.example.invalid/991001/s2_full.jpg',
      },
    ],
    movies: [
      {
        id: 10,
        name: 'Official Launch Trailer',
        thumbnail: 'https://cdn.example.invalid/991001/m1.jpg',
      },
    ],
    systemRequirements: {
      minimum: '<strong>OS:</strong> Windows 10 64-bit<br><strong>Memory:</strong> 8 GB RAM',
      recommended: '<strong>OS:</strong> Windows 11 64-bit<br><strong>Memory:</strong> 16 GB RAM',
    },
    macRequirements: {
      minimum: '<strong>OS:</strong> macOS 14.0+<br><strong>Processor:</strong> Apple M1',
      recommended: '<strong>OS:</strong> macOS 15.0+<br><strong>Processor:</strong> Apple M3',
    },
    linuxRequirements: {
      minimum: '<strong>OS:</strong> Ubuntu 22.04<br><strong>Memory:</strong> 8 GB RAM',
    },
    pcRequirementsHtml: '<strong>OS:</strong> Windows 10 64-bit',
    supportedLanguages: 'English<strong>*</strong>, French, German',
    languageOptions: [
      { name: 'English', hasInterface: true, hasAudio: true, hasSubtitles: true },
      { name: 'French', hasInterface: true, hasAudio: false, hasSubtitles: true },
    ],
    languageTableSchema: 'steam',
    reviewSummary: {
      reviewScore: 9,
      reviewScoreDesc: 'Overwhelmingly Positive',
      totalPositive: 9600,
      totalNegative: 400,
      totalReviews: 10000,
      positivePercent: 96,
    },
    metacritic: { score: 91, url: 'https://metacritic.example.invalid/starforge' },
    platforms: { windows: true, mac: true, linux: true },
    achievements: {
      total: 50,
      highlighted: [{ name: 'First Jump', path: 'https://cdn.example.invalid/ach1.jpg' }],
    },
    legalNotice: '© Synthetic Orbital Works',
    drmNotice: 'None',
    extUserAccountNotice: 'Optional Cloud Profile',
    website: 'https://starforge.example.invalid',
    controllerSupport: 'full',
    deckCompatibility: 'verified',
    metadataQuality: 'authoritative',
    enrichedSource: 'steam',
    fetchedAt: 1_760_000_000_000,
    enrichedAt: 1_760_000_000_000,
    ...overrides,
  };
}

function makeGame(overrides: Partial<CanonicalGame> & { id: string; title: string }): CanonicalGame {
  const { id, title, ...rest } = overrides;
  const appId = rest.steamAppId ?? 991001;
  return {
    id,
    title,
    sortTitle: title,
    steamAppId: appId,
    platforms: rest.platforms ?? [
      {
        platformId: 'steam',
        platformGameId: String(appId),
        installed: false,
        playtimeMinutes: 0,
        platforms: { windows: true, mac: true, linux: true },
      },
    ],
    headerImage: `https://cdn.example.invalid/${appId}/header.jpg`,
    capsuleImage: `https://cdn.example.invalid/${appId}/library_600x900.jpg`,
    shortDescription: 'Explore charted star systems and forge modular fleets across ancient ruins.',
    detailedDescription: '<p>Full official store overview with tactical fleet gameplay.</p>',
    developers: ['Synthetic Orbital Works'],
    publishers: ['Synthetic Frontier Publishing'],
    genres: ['RPG', 'Strategy', 'Sci-Fi'],
    tags: ['Space', 'Tactical', 'Singleplayer'],
    releaseDate: '2025-04-12',
    ...rest,
  };
}

describe('Tasks 1, 3a/3b & 6 — HLTB Badge Cleanup, __quotaSlimmed Immunity, Tiered Store Media Sync & Universal macOS Specs', () => {
  beforeEach(() => {
    testEnv.reset();
    vi.restoreAllMocks();
    requestScheduler.reset();
    vi.spyOn(onlineLifecycleManager, 'isOnline').mockReturnValue(true);
    syncJobManager.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    requestScheduler.reset();
  });

  // -------------------------------------------------------------------------
  // 1. Task 1: HowLongToBeatCard badge removal
  // -------------------------------------------------------------------------
  describe('1. Task 1 — HowLongToBeatCard removes Verified / Full Game / Estimated / Fetching pills', () => {
    it('renders completion times and View on HLTB link without Verified, Full Game, Estimated, or Fetching... badges', () => {
      const accurateHtml = renderToStaticMarkup(
        React.createElement(HowLongToBeatCard, {
          gameId: 'steam-991001',
          gameTitle: 'Synthetic Starforge Odyssey',
          appId: 991001,
          hltb: {
            mainStoryHours: 24.5,
            mainExtraHours: 42,
            completionistHours: 78,
            allStylesHours: 36,
            hltbGameId: 999111,
            gameplayType: 'Full Game',
            isAccurate: true,
          },
        })
      );

      expect(accurateHtml).toContain('HowLongToBeat');
      expect(accurateHtml).toContain('Community-sourced completion estimates');
      expect(accurateHtml).toContain('View on HLTB');
      expect(accurateHtml).toContain('24½h');
      expect(accurateHtml).toContain('42h');
      expect(accurateHtml).toContain('78h');
      expect(accurateHtml).toContain('36h');
      expect(accurateHtml).not.toContain('Verified');
      expect(accurateHtml).not.toContain('Full Game');
      expect(accurateHtml).not.toContain('Estimated');
      expect(accurateHtml).not.toContain('Fetching...');

      const estimatedHtml = renderToStaticMarkup(
        React.createElement(HowLongToBeatCard, {
          gameId: 'steam-991002',
          gameTitle: 'Synthetic Unverified Quest',
          appId: 991002,
          hltb: {
            mainStoryHours: 12,
            mainExtraHours: 18,
            completionistHours: 30,
            allStylesHours: 15,
            gameplayType: 'DLC',
            isAccurate: false,
          },
        })
      );
      expect(estimatedHtml).toContain('HowLongToBeat');
      expect(estimatedHtml).toContain('12h');
      expect(estimatedHtml).not.toContain('Estimated');
      expect(estimatedHtml).not.toContain('Verified');
      expect(estimatedHtml).not.toContain('DLC');
      expect(estimatedHtml).not.toContain('Fetching...');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Tasks 3a & 6: __quotaSlimmed Rank-0 Lattice + Cold-Boot Write Barrier (C8)
  // -------------------------------------------------------------------------
  describe('2. Tasks 3a & 6 — __quotaSlimmed Rank-0 Lattice, Cold-Boot Barrier & SQLite Immunity (C8)', () => {
    it('skips empty-string placeholder mutation in catalogSanitizer when enrichedMetadata.__quotaSlimmed === true', () => {
      const rich = makeGame({
        id: 'steam-991010',
        title: 'Synthetic Slim Preservation',
        steamAppId: 991010,
        enrichedMetadata: makeRichMeta({ appId: 991010, name: 'Synthetic Slim Preservation' }),
      });
      const slimmed = slimGameForLocalStorageQuota(rich);
      expect(slimmed.shortDescription).toBeUndefined();
      expect(slimmed.enrichedMetadata?.__quotaSlimmed).toBe(true);
      expect(slimmed.enrichedMetadata?.shortDescription).toBeUndefined();

      const sanitized = sanitizeGameCatalog([slimmed], { allowNewPurchases: true });
      expect(sanitized).toHaveLength(1);
      // Neither enrichedMetadata nor top-level shortDescription is turned into ""
      expect(sanitized[0].shortDescription).toBeUndefined();
      expect(sanitized[0].enrichedMetadata?.__quotaSlimmed).toBe(true);
      expect(sanitized[0].enrichedMetadata?.shortDescription).toBeUndefined();
      expect(sanitized[0].enrichedMetadata?.aboutTheGame).toBeUndefined();
      expect(sanitized[0].enrichedMetadata?.detailedDescription).toBeUndefined();
    });

    it('ranks __quotaSlimmed at 0, preserves all rich fields in mergeWinnerWithFallbackFields, isolates Xbox PC from Steam Mac specs, and never strips __quotaSlimmed on bare skeleton merge', () => {
      const richSteam = makeRichMeta({ appId: 991011 });
      const slimmedSteam: SteamEnrichedMetadata = {
        ...richSteam,
        shortDescription: '',
        detailedDescription: '',
        aboutTheGame: '',
        screenshots: [],
        movies: [],
        systemRequirements: {},
        macRequirements: undefined,
        linuxRequirements: undefined,
        supportedLanguages: undefined,
        languageOptions: undefined,
        fetchedAt: undefined,
        __quotaSlimmed: true,
        hasScreenshotsCount: 8,
        metadataQuality: 'authoritative',
      };

      // C8 Rank-0 invariant
      expect(getEnrichedMetadataQualityRank(slimmedSteam)).toBe(0);
      expect(getEnrichedMetadataQualityRank(richSteam)).toBe(4);

      // Rich Steam beats slimmed in BOTH argument orders & preserves every rich field
      for (const merged of [
        pickBestEnrichedMetadata(slimmedSteam, richSteam),
        pickBestEnrichedMetadata(richSteam, slimmedSteam),
      ]) {
        expect(merged?.__quotaSlimmed).toBeUndefined();
        expect(merged?.systemRequirements?.minimum).toContain('Windows 10');
        expect(merged?.macRequirements?.minimum).toContain('macOS 14.0+');
        expect(merged?.linuxRequirements?.minimum).toContain('Ubuntu 22.04');
        expect(merged?.pcRequirementsHtml).toContain('Windows 10');
        expect(merged?.aboutTheGame).toContain('Apple Silicon');
        expect(merged?.supportedLanguages).toContain('English');
        expect(merged?.languageOptions).toHaveLength(2);
        expect(merged?.languageTableSchema).toBe('steam');
        expect(merged?.developers).toEqual(['Synthetic Orbital Works']);
        expect(merged?.publishers).toEqual(['Synthetic Frontier Publishing']);
        expect(merged?.genres).toEqual(['RPG', 'Strategy', 'Sci-Fi']);
        expect(merged?.tags).toEqual(['Space', 'Tactical', 'Singleplayer']);
        expect(merged?.reviewSummary?.totalReviews).toBe(10000);
        expect(merged?.metacritic?.score).toBe(91);
        expect(merged?.platforms?.mac).toBe(true);
        expect(merged?.achievements?.highlighted).toHaveLength(1);
        expect(merged?.legalNotice).toBe('© Synthetic Orbital Works');
        expect(merged?.drmNotice).toBe('None');
        expect(merged?.extUserAccountNotice).toBe('Optional Cloud Profile');
        expect(merged?.website).toBe('https://starforge.example.invalid');
        expect(merged?.controllerSupport).toBe('full');
        expect(merged?.deckCompatibility).toBe('verified');
        expect(merged?.fetchedAt).toBe(1_760_000_000_000);
      }

      // Rank-2 Epic/Xbox native beats Rank-0 slimmed stub cleanly without creating a fake Rank-4 Frankenstein
      const xboxNative = makeRichMeta({
        appId: 0,
        enrichedSource: 'xbox',
        metadataQuality: 'storefront_native',
        macRequirements: undefined,
        linuxRequirements: undefined,
        platforms: { windows: true, mac: false, linux: false },
        fetchedAt: undefined,
      });
      const mergedXboxOverSlim = pickBestEnrichedMetadata(slimmedSteam, xboxNative);
      expect(mergedXboxOverSlim?.metadataQuality).toBe('storefront_native');
      expect(mergedXboxOverSlim?.__quotaSlimmed).toBeUndefined();
      // Xbox PC isolation: macRequirements from a Steam record never leaks onto Xbox winner
      const xboxNoMac = pickBestEnrichedMetadata(
        xboxNative,
        makeRichMeta({ appId: 0, enrichedSource: 'gog', metadataQuality: 'local_federated' })
      );
      expect(xboxNoMac?.macRequirements).toBeUndefined();
      expect(xboxNoMac?.linuxRequirements).toBeUndefined();

      // Merging slimmed stub with bare skeleton_fallback preserves __quotaSlimmed: true
      const bareSkeleton: SteamEnrichedMetadata = {
        ...makeRichMeta({
          appId: 0,
          shortDescription: '',
          detailedDescription: '',
          aboutTheGame: '',
          screenshots: [],
          movies: [],
          systemRequirements: {},
          macRequirements: undefined,
          linuxRequirements: undefined,
          fetchedAt: undefined,
          metadataQuality: 'skeleton_fallback',
        }),
      };
      const slimVsSkeleton = pickBestEnrichedMetadata(slimmedSteam, bareSkeleton);
      expect(slimVsSkeleton?.__quotaSlimmed).toBe(true);
    });

    it('blocks cold-boot slimmed writes in loadCurrentCatalog() and recovers rich SQLite summary_json + enrichedMetadata in hydrateCatalogFromIndexedDb()', async () => {
      const richGame = makeGame({
        id: 'steam-991020',
        title: 'Synthetic Cold Boot Shield',
        steamAppId: 991020,
        reviewSummary: {
          reviewScore: 9,
          reviewScoreDesc: 'Very Positive',
          totalPositive: 450,
          totalNegative: 50,
          totalReviews: 500,
          positivePercent: 90,
        },
        enrichedMetadata: makeRichMeta({ appId: 991020, name: 'Synthetic Cold Boot Shield' }),
      });

      // Simulate cold boot: localStorage holds slimmed projection + an unstripped Xbox title that triggers sanitizer delta
      const slimForLs = slimGameForLocalStorageQuota(richGame);
      const xboxDeltaTrigger = makeGame({
        id: 'xbox-9N991021',
        title: 'Synthetic Trigger (PC)',
        steamAppId: undefined,
        platforms: [{ platformId: 'xbox', platformGameId: '9N991021', installed: false }],
        enrichedMetadata: undefined,
      });
      testEnv.mockStorage.setItem(
        'universal_game_library_catalog',
        JSON.stringify([slimForLs, xboxDeltaTrigger])
      );

      // Seed IndexedDB with a previously slimmed/corrupted row while SQLite retains rich summary + enriched detail
      testEnv.idbStore.set('idb_universal_game_library_catalog_v2', [
        {
          ...slimForLs,
          shortDescription: '',
          developers: [],
          publishers: [],
          tags: [],
          genres: ['RPG'],
          reviewSummary: undefined,
        },
      ]);

      const upsertSpy = vi.fn(async () => ({ success: true }));
      const vaultSetSpy = vi.spyOn(indexedDbVault, 'vaultSet');
      testEnv.windowObj.electronAPI = {
        platform: 'darwin',
        offlineVault: {
          upsertGames: upsertSpy,
          getCatalogSnapshot: vi.fn(async () => ({
            success: true,
            games: [richGame],
            details: {
              [richGame.id]: {
                enrichedMetadata: richGame.enrichedMetadata,
                metadataQuality: 'authoritative',
                enrichedAt: 1_760_000_000_000,
              },
            },
          })),
        },
      };

      // 1. Cold-boot loadCurrentCatalog() MUST NOT call upsertGames or overwrite IDB!
      const bootLoaded = loadCurrentCatalog();
      expect(bootLoaded.length).toBeGreaterThanOrEqual(1);
      expect(upsertSpy).not.toHaveBeenCalled();
      expect(vaultSetSpy).not.toHaveBeenCalled();

      // 2. Direct saveCurrentCatalog with pure slimmed snapshot also MUST NOT touch SQLite or overwrite IDB
      saveCurrentCatalog([slimForLs], { immediate: true, skipSanitize: true });
      flushPendingCatalogSave();
      expect(upsertSpy).not.toHaveBeenCalled();
      expect(vaultSetSpy).not.toHaveBeenCalled();

      // 3. hydrateCatalogFromIndexedDb() recovers rich enrichedMetadata AND all 7 summary_json fields from SQLite!
      const hydrated = await hydrateCatalogFromIndexedDb();
      expect(hydrated).not.toBeNull();
      const restored = hydrated!.find((g) => g.id === richGame.id);
      expect(restored?.enrichedMetadata?.__quotaSlimmed).toBeUndefined();
      expect(restored?.enrichedMetadata?.macRequirements?.minimum).toContain('macOS 14.0+');
      expect(restored?.shortDescription).toBe(richGame.shortDescription);
      expect(restored?.detailedDescription).toBe(richGame.detailedDescription);
      expect(restored?.developers).toEqual(['Synthetic Orbital Works']);
      expect(restored?.publishers).toEqual(['Synthetic Frontier Publishing']);
      expect(restored?.tags).toEqual(['Space', 'Tactical', 'Singleplayer']);
      expect(restored?.genres).toEqual(['RPG', 'Strategy', 'Sci-Fi']);
      expect(restored?.reviewSummary?.totalReviews).toBe(500);
    });

    it('enforces __quotaSlimmed immunity, Rank-0 demotion healing, and monotonic OS requirements in SQLite OfflineVaultService', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-slim-vault-'));
      const vault = new OfflineVaultService({ userDataDir: tmpDir, now: () => 1_760_000_100_000 });
      try {
        const richGame = makeGame({
          id: 'steam-991030',
          title: 'Synthetic Vault Guardian',
          steamAppId: 991030,
          reviewSummary: {
            reviewScore: 9,
            reviewScoreDesc: 'Very Positive',
            totalPositive: 800,
            totalNegative: 50,
            totalReviews: 850,
            positivePercent: 94,
          },
          enrichedMetadata: makeRichMeta({ appId: 991030, name: 'Synthetic Vault Guardian' }),
        });

        // 1. Seed rich authoritative row in SQLite
        vault.upsertGames([richGame]);

        // 2. Attempt to overwrite with a __quotaSlimmed projection claiming metadataQuality: 'authoritative'
        const slimProjection = slimGameForLocalStorageQuota(richGame);
        slimProjection.shortDescription = '';
        vault.upsertGames([slimProjection]);

        const snapAfterSlim = vault.getCatalogSnapshot();
        const storedGame = snapAfterSlim.games.find((g) => g.id === richGame.id);
        const storedDetail = snapAfterSlim.details[richGame.id];
        expect(storedDetail?.enrichedMetadata?.__quotaSlimmed).toBeUndefined();
        expect(storedDetail?.enrichedMetadata?.macRequirements?.minimum).toContain('macOS 14.0+');
        expect(storedDetail?.metadataQuality).toBe('authoritative');
        expect(storedGame?.shortDescription).toBe(richGame.shortDescription);
        expect(storedGame?.developers).toEqual(['Synthetic Orbital Works']);
        expect(storedGame?.tags).toEqual(['Space', 'Tactical', 'Singleplayer']);
        expect(storedGame?.genres).toEqual(['RPG', 'Strategy', 'Sci-Fi']);
        expect(storedGame?.reviewSummary?.totalReviews).toBe(850);

        // 3. Equal-rank partial update omitting macRequirements/linuxRequirements/systemRequirements carries them forward monotonically
        const partialNoReqs = makeGame({
          ...richGame,
          enrichedMetadata: {
            ...richGame.enrichedMetadata!,
            systemRequirements: {},
            macRequirements: undefined,
            linuxRequirements: undefined,
            shortDescription: 'Updated official synopsis from partial sync.',
          },
        });
        vault.upsertGames([partialNoReqs]);
        const detailAfterPartial = vault.getGameDetail(richGame.id);
        expect(detailAfterPartial?.enrichedMetadata?.systemRequirements?.minimum).toContain(
          'Windows 10'
        );
        expect(detailAfterPartial?.enrichedMetadata?.macRequirements?.minimum).toContain(
          'macOS 14.0+'
        );
        expect(detailAfterPartial?.enrichedMetadata?.linuxRequirements?.minimum).toContain(
          'Ubuntu 22.04'
        );

        // 4. Pre-existing corrupted __quotaSlimmed row in SQLite is demoted to Rank 0 and healed by full upsertGames & saveGameDetail
        const corruptedId = 'steam-991031';
        const corruptedStub = makeGame({
          id: corruptedId,
          title: 'Synthetic Corrupted Stub',
          steamAppId: 991031,
          shortDescription: '',
          developers: [],
          enrichedMetadata: {
            ...makeRichMeta({ appId: 991031, name: 'Synthetic Corrupted Stub' }),
            shortDescription: '',
            detailedDescription: '',
            aboutTheGame: '',
            screenshots: [],
            systemRequirements: {},
            macRequirements: undefined,
            __quotaSlimmed: true,
            metadataQuality: 'authoritative',
          },
        });
        vault.upsertGames([corruptedStub]);
        const beforeHeal = vault.getGameDetail(corruptedId);
        expect(beforeHeal?.metadataQuality).toBe('skeleton_fallback');

        const healedMeta = makeRichMeta({ appId: 991031, name: 'Synthetic Corrupted Stub' });
        vault.saveGameDetail({
          gameId: corruptedId,
          steamAppId: 991031,
          canonicalTitle: 'Synthetic Corrupted Stub',
          enrichedMetadata: healedMeta,
          metadataQuality: 'authoritative',
        });
        const afterHeal = vault.getGameDetail(corruptedId);
        expect(afterHeal?.enrichedMetadata?.__quotaSlimmed).toBeUndefined();
        expect(afterHeal?.enrichedMetadata?.shortDescription).toContain('Explore charted star systems');
        expect(afterHeal?.enrichedMetadata?.macRequirements?.minimum).toContain('macOS 14.0+');
        expect(afterHeal?.metadataQuality).toBe('authoritative');
      } finally {
        vault.shutdown();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns false from isSynopsisAlreadyProbed when enrichedMetadata.__quotaSlimmed === true and description is empty', () => {
      const slimBrokenGame = makeGame({
        id: 'steam-991040',
        title: 'Synthetic Missing Synopsis Slim',
        steamAppId: 991040,
        shortDescription: '',
        detailedDescription: '',
        enrichedMetadata: {
          ...makeRichMeta({ appId: 991040 }),
          shortDescription: '',
          aboutTheGame: '',
          detailedDescription: '',
          __quotaSlimmed: true,
          hasScreenshotsCount: 7,
        },
      });
      expect(isSynopsisAlreadyProbed(slimBrokenGame)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Tasks 3b & 6: Tiered Store Media Sync & Rate-Limit-Safe Self-Heal (C1)
  // -------------------------------------------------------------------------
  describe('3. Tasks 3b & 6 — Tiered Store Media Sync, Bounded Passive Warmup & Cooldown Abort (C1)', () => {
    it('evaluates eligibility across default, manual, and post-hydration modes including IGDB routes while preserving cold-boot backward compatibility', () => {
      const fullGame = makeGame({
        id: 'steam-991050',
        title: 'Synthetic Healthy Game',
        steamAppId: 991050,
        enrichedMetadata: makeRichMeta({ appId: 991050 }),
      });

      // Fresh localStorage slim projection (shortDescription === undefined)
      const freshSlimProjection = slimGameForLocalStorageQuota(fullGame);
      expect(evaluateGameNeedsStoreMediaSync(freshSlimProjection, false)).toEqual({
        eligible: false,
        alreadyEnriched: true,
      });
      // Post-hydration & manual sync detect persisted __quotaSlimmed immediately
      expect(
        evaluateGameNeedsStoreMediaSync(freshSlimProjection, false, { isPostHydration: true })
          .eligible
      ).toBe(true);
      expect(
        evaluateGameNeedsStoreMediaSync(freshSlimProjection, false, { isManualSync: true }).eligible
      ).toBe(true);

      // Missing genuine synopsis (exact state of the 51 broken vault titles)
      const missingSynopsisSlim = makeGame({
        id: 'steam-991051',
        title: 'Synthetic Lost Synopsis',
        steamAppId: 991051,
        shortDescription: '',
        detailedDescription: '',
        enrichedMetadata: {
          ...makeRichMeta({ appId: 991051 }),
          shortDescription: '',
          aboutTheGame: '',
          detailedDescription: '',
          screenshots: [],
          __quotaSlimmed: true,
          hasScreenshotsCount: 8,
        },
      });
      expect(
        evaluateGameNeedsStoreMediaSync(missingSynopsisSlim, false, { isManualSync: true }).eligible
      ).toBe(true);

      // Frankenstein authoritative Steam row missing systemRequirements & fetchedAt
      const frankenstein = makeGame({
        id: 'steam-991052',
        title: 'Synthetic Frankenstein',
        steamAppId: 991052,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '991052',
            installed: false,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
        enrichedMetadata: makeRichMeta({
          appId: 991052,
          systemRequirements: {},
          macRequirements: undefined,
          platforms: { windows: true, mac: false, linux: false },
          fetchedAt: undefined,
        }),
      });
      expect(
        evaluateGameNeedsStoreMediaSync(frankenstein, false, { isManualSync: true }).eligible
      ).toBe(true);
      expect(computeMediaRepairPriority(frankenstein, undefined, 'darwin')).toBe(3);
      expect(computeMediaRepairPriority(frankenstein, undefined, 'win32')).toBe(1);

      // Owned native macOS game missing macRequirements & fetchedAt
      const legacyMac = makeGame({
        id: 'steam-991053',
        title: 'Synthetic Legacy Mac Title',
        steamAppId: 991053,
        enrichedMetadata: makeRichMeta({
          appId: 991053,
          macRequirements: undefined,
          fetchedAt: undefined,
          platforms: { windows: true, mac: true, linux: false },
        }),
      });
      expect(
        evaluateGameNeedsStoreMediaSync(legacyMac, false, { isPostHydration: true }).eligible
      ).toBe(true);
      expect(computeMediaRepairPriority(legacyMac, undefined, 'darwin')).toBe(1);

      // Xbox-only PC build with Steam cross-match platforms.mac = true is NOT owned native macOS
      const xboxOnlyCrossMatch = makeGame({
        id: 'xbox-9N991054',
        title: 'Synthetic Xbox PC Build',
        steamAppId: 991054,
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9N991054',
            installed: false,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
        enrichedMetadata: makeRichMeta({
          appId: 991054,
          macRequirements: undefined,
          fetchedAt: undefined,
          platforms: { windows: true, mac: true, linux: false },
        }),
      });
      expect(
        evaluateGameNeedsStoreMediaSync(xboxOnlyCrossMatch, false, { isPostHydration: true })
          .eligible
      ).toBe(false);

      // IGDB-routed exclusive is eligible for store media sync
      const igdbGame = makeGame({
        id: 'custom-igdb-991055',
        title: 'Synthetic IGDB Exclusive',
        steamAppId: undefined,
        isExplicitNonSteam: true,
        platforms: [{ platformId: 'custom', platformGameId: 'igdb-991055', installed: false }],
        shortDescription: '',
        detailedDescription: '',
        enrichedMetadata: undefined,
      });
      saveUserOverride({
        gameId: igdbGame.id,
        matchedStore: 'igdb',
        metadataRoute: {
          mode: 'routed',
          source: 'igdb',
          matchedId: '991055',
          igdbId: '991055',
          targetTitle: igdbGame.title,
        },
        updatedAt: new Date().toISOString(),
      });
      try {
        expect(
          evaluateGameNeedsStoreMediaSync(igdbGame, false, { isManualSync: true }).eligible
        ).toBe(true);
      } finally {
        removeUserOverride(igdbGame.id);
      }
    });

    it('sorts manual sync strictly Tier 0 -> Tier 1 -> Tier 2 -> Tier 3, passes forceRefresh: true on repair, and clears durable empty synopsis probes', async () => {
      const t3Frankenstein = makeGame({
        id: 'steam-991063',
        title: 'Z Tier 3 Frankenstein',
        steamAppId: 991063,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '991063',
            installed: false,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
        enrichedMetadata: makeRichMeta({
          appId: 991063,
          systemRequirements: {},
          macRequirements: undefined,
          platforms: { windows: true, mac: false, linux: false },
          fetchedAt: undefined,
        }),
      });
      const t2Slim = makeGame({
        id: 'steam-991062',
        title: 'Y Tier 2 Slimmed Uninstalled',
        steamAppId: 991062,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '991062',
            installed: false,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
        enrichedMetadata: {
          ...makeRichMeta({ appId: 991062, platforms: { windows: true, mac: false, linux: false } }),
          screenshots: [],
          __quotaSlimmed: true,
          hasScreenshotsCount: 5,
        },
      });
      const t1LegacyMac = makeGame({
        id: 'steam-991061',
        title: 'X Tier 1 Native Mac Spec Gap',
        steamAppId: 991061,
        enrichedMetadata: makeRichMeta({
          appId: 991061,
          macRequirements: undefined,
          fetchedAt: undefined,
          platforms: { windows: true, mac: true, linux: false },
        }),
      });
      const t0MissingSynopsis = makeGame({
        id: 'steam-991060',
        title: 'W Tier 0 Missing Synopsis',
        steamAppId: 991060,
        shortDescription: '',
        detailedDescription: '',
        enrichedMetadata: {
          ...makeRichMeta({ appId: 991060 }),
          shortDescription: '',
          aboutTheGame: '',
          detailedDescription: '',
          screenshots: [],
          __quotaSlimmed: true,
          hasScreenshotsCount: 6,
        },
      });

      recordDurableEmptySynopsisProbe(t0MissingSynopsis.id);
      expect(hasDurableEmptySynopsisProbe(t0MissingSynopsis.id)).toBe(true);

      const fetchOrder: Array<{ appId: number; forceRefresh: boolean }> = [];
      vi.spyOn(steamApi, 'fetchStoreBrowseAssetsBatch').mockResolvedValue(new Map());
      vi.spyOn(steamApi, 'fetchGameMetadata').mockImplementation(async (appId, _prio, opts) => {
        fetchOrder.push({ appId, forceRefresh: Boolean(opts?.forceRefresh) });
        return makeRichMeta({
          appId,
          name: `Healed ${appId}`,
          shortDescription: `Restored genuine synopsis for ${appId}.`,
          fetchedAt: Date.now(),
        });
      });
      vi.spyOn(steamMatcher, 'getEffectiveSteamAppId').mockImplementation(
        (g) => g?.steamAppId ?? undefined
      );

      const updated: CanonicalGame[] = [];
      const mgr = new SyncJobManager();
      // Deliberately input reverse tier order: T3, T2, T1, T0
      await mgr.startStoreMediaSync(
        [t3Frankenstein, t2Slim, t1LegacyMac, t0MissingSynopsis],
        (u) => updated.push(u),
        { isManualSync: true }
      );

      expect(fetchOrder.map((f) => f.appId)).toEqual([991060, 991061, 991062, 991063]);
      expect(fetchOrder.every((f) => f.forceRefresh === true)).toBe(true);
      expect(updated).toHaveLength(4);
      expect(hasDurableEmptySynopsisProbe(t0MissingSynopsis.id)).toBe(false);
      clearDurableEmptySynopsisProbe(t0MissingSynopsis.id);
    });

    it('bounds useBackgroundMediaWarmup to Tiers 0–2 capped at MAX_PASSIVE_REPAIR_PER_BOOT (45), marks attempts only after completion, and aborts immediately on cooldown', async () => {
      vi.useFakeTimers();
      testEnv.windowObj.__ENABLE_AUTO_STORE_MEDIA_WARMUP__ = true;
      vi.spyOn(launcherService, 'getRunningGames').mockReturnValue([]);
      vi.spyOn(launcherService, 'isInGameHibernating').mockReturnValue(false);
      vi.spyOn(steamMatcher, 'getEffectiveSteamAppId').mockImplementation(
        (g) => g?.steamAppId ?? undefined
      );

      // Build 55 Tier-0 games + 10 Tier-3 Frankenstein games
      const tier0Games: CanonicalGame[] = Array.from({ length: 55 }, (_, i) => {
        const appId = 992000 + i;
        return makeGame({
          id: `steam-${appId}`,
          title: `Synthetic Tier0 ${i}`,
          steamAppId: appId,
          shortDescription: '',
          detailedDescription: '',
          enrichedMetadata: {
            ...makeRichMeta({ appId }),
            shortDescription: '',
            aboutTheGame: '',
            detailedDescription: '',
            screenshots: [],
            __quotaSlimmed: true,
            hasScreenshotsCount: 4,
          },
        });
      });
      const tier3Games: CanonicalGame[] = Array.from({ length: 10 }, (_, i) => {
        const appId = 993000 + i;
        return makeGame({
          id: `steam-${appId}`,
          title: `Synthetic Tier3 ${i}`,
          steamAppId: appId,
          platforms: [
            {
              platformId: 'steam',
              platformGameId: String(appId),
              installed: false,
              platforms: { windows: true, mac: false, linux: false },
            },
          ],
          enrichedMetadata: makeRichMeta({
            appId,
            systemRequirements: {},
            macRequirements: undefined,
            platforms: { windows: true, mac: false, linux: false },
            fetchedAt: undefined,
          }),
        });
      });
      const catalog = [...tier3Games, ...tier0Games];

      // Case A: Warmup starts with NO cooldown -> caps at MAX_PASSIVE_REPAIR_PER_BOOT (45) and excludes Tier 3
      let receivedBatch: CanonicalGame[] = [];
      let receivedOpts: Record<string, unknown> | undefined;
      const startSpy = vi
        .spyOn(syncJobManager, 'startStoreMediaSync')
        .mockImplementation(async (batch, _onUpdated, opts) => {
          receivedBatch = batch;
          receivedOpts = opts as Record<string, unknown>;
          // Simulate only 3 games completing before an interruption
          opts?.onGameAttempted?.(batch[0].id);
          opts?.onGameAttempted?.(batch[1].id);
          opts?.onGameAttempted?.(batch[2].id);
        });

      const gamesRef = { current: catalog };
      const harness = mountHookHarness(useBackgroundMediaWarmup, {
        games: catalog,
        gamesRef,
        isHibernating: false,
        runningGamesCount: 0,
        isModalSuspended: false,
        isBootHydrating: false,
        setGames: vi.fn(),
        setIsSyncingAllMedia: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(200);
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(receivedBatch).toHaveLength(MAX_PASSIVE_REPAIR_PER_BOOT);
      expect(MAX_PASSIVE_REPAIR_PER_BOOT).toBe(45);
      expect(receivedBatch.every((g) => g.title.startsWith('Synthetic Tier0'))).toBe(true);
      expect(receivedOpts?.isPostHydration).toBe(true);
      expect(receivedOpts?.maxRepairTier).toBe(2);
      harness.unmount();

      // Case B: Media domain enters cooldown -> passive warmup aborts immediately without calling startStoreMediaSync
      startSpy.mockClear();
      requestScheduler.setCooldown('store.steampowered.com', 300);

      const cooldownHarness = mountHookHarness(useBackgroundMediaWarmup, {
        games: catalog,
        gamesRef,
        isHibernating: false,
        runningGamesCount: 0,
        isModalSuspended: false,
        isBootHydrating: false,
        setGames: vi.fn(),
        setIsSyncingAllMedia: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(200);
      expect(startSpy).not.toHaveBeenCalled();
      cooldownHarness.unmount();

      // Case C: Real SyncJobManager aborts mid-batch when cooldown activates & only calls onGameAttempted for finished items
      vi.useRealTimers();
      startSpy.mockRestore();
      requestScheduler.reset();
      vi.spyOn(stagedCacheService, 'whenStagedCacheHydrated').mockResolvedValue(0);
      vi.spyOn(steamApi, 'fetchStoreBrowseAssetsBatch').mockResolvedValue(new Map());
      let callCount = 0;
      vi.spyOn(steamApi, 'fetchGameMetadata').mockImplementation(async (appId) => {
        callCount++;
        if (callCount === 2) {
          requestScheduler.setCooldown('store.steampowered.com', 600);
        }
        return makeRichMeta({ appId, fetchedAt: Date.now() });
      });

      const attemptedIds: string[] = [];
      const mgr = new SyncJobManager();
      await mgr.startStoreMediaSync(tier0Games.slice(0, 6), () => {}, {
        incremental: true,
        isBackgroundWarmup: true,
        isPostHydration: true,
        maxRepairTier: 2,
        onGameAttempted: (id) => attemptedIds.push(id),
      });
      expect(callCount).toBe(2);
      expect(attemptedIds).toEqual([tier0Games[0].id, tier0Games[1].id]);
    });

    it('passes gamesRef.current and { isManualSync: true } in handleSyncStoreMedia with accurate count completion toasts', async () => {
      const staleGames: CanonicalGame[] = [];
      const freshGames = [
        makeGame({ id: 'steam-991070', title: 'Synthetic Manual Target', steamAppId: 991070 }),
      ];
      const gamesRef = { current: freshGames };
      const showSyncNotice = vi.fn();
      let passedGames: CanonicalGame[] = [];
      let passedOpts: Record<string, unknown> | undefined;

      const startSpy = vi
        .spyOn(syncJobManager, 'startStoreMediaSync')
        .mockImplementation(async (batch, onUpdated, opts) => {
          passedGames = batch;
          passedOpts = opts as Record<string, unknown>;
          onUpdated({
            ...batch[0],
            shortDescription: 'Freshly repaired synopsis.',
          });
        });

      const harness = mountHookHarness(useManualLibrarySyncActions, {
        games: staleGames,
        gamesRef,
        selectedGame: null,
        isGridView: true,
        isSyncingAllMedia: false,
        setGames: vi.fn(),
        setIsSyncingAllMedia: vi.fn(),
        setGameRefreshKey: vi.fn(),
        overlayLauncherInstalledState: (catalog) => catalog,
        showSyncNotice,
      });

      await harness.getResult().handleSyncStoreMedia();
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(passedGames).toBe(freshGames);
      expect(passedOpts?.isManualSync).toBe(true);
      expect(showSyncNotice).toHaveBeenLastCalledWith(
        expect.stringContaining('Updated 1 title'),
        5000
      );

      // Zero eligible/updated titles -> honest "already up to date" message
      startSpy.mockImplementationOnce(async () => {});
      await harness.getResult().handleSyncStoreMedia();
      expect(showSyncNotice).toHaveBeenLastCalledWith(
        'All library store media & descriptions are already up to date.',
        5000
      );

      harness.unmount();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Task 6: Steam Legacy Mac Upgrade + GOG v2 & Epic Multi-OS Parsers (C9)
  // -------------------------------------------------------------------------
  describe('4. Task 6 — steamApi Legacy Mac Upgrade (inMemory + persisted) & GOG v2 / Epic Mac+Linux Parsers (C9)', () => {
    it('evicts __quotaSlimmed IDB entries, upgrades legacy Steam Mac metadata at BOTH inMemoryCached and persisted when online, and preserves fallback on network failure', async () => {
      const api = new SteamApiService();
      const appId = 991080;

      // 1. Seed poisoned __quotaSlimmed entry in IDB -> loadPersistedMetadata rejects & evicts it
      testEnv.idbStore.set(`enriched_metadata:${appId}`, {
        ...makeRichMeta({ appId }),
        __quotaSlimmed: true,
        screenshots: [],
      });
      const axiosSpy = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (url.includes('appdetails')) {
          return {
            data: {
              [String(appId)]: {
                success: true,
                data: {
                  name: 'Synthetic Mac Odyssey',
                  short_description: 'Native Apple Silicon RPG.',
                  detailed_description: '<p>Full RPG overview.</p>',
                  about_the_game: '<p>Full RPG overview.</p>',
                  header_image: `https://cdn.example.invalid/${appId}/header.jpg`,
                  developers: ['Synthetic Mac Studio'],
                  publishers: ['Synthetic Pub'],
                  platforms: { windows: true, mac: true, linux: false },
                  pc_requirements: { minimum: '<strong>OS:</strong> Windows 10' },
                  mac_requirements: {
                    minimum: '<strong>OS:</strong> macOS 14.7.1+<br><strong>Processor:</strong> Apple M1',
                  },
                },
              },
            },
          };
        }
        return { data: { query_summary: { total_reviews: 0 } } };
      });

      const upgradedFromSlim = await api.fetchGameMetadata(appId);
      expect(upgradedFromSlim?.__quotaSlimmed).toBeUndefined();
      expect(upgradedFromSlim?.macRequirements?.minimum).toContain('macOS 14.7.1+');
      expect(typeof upgradedFromSlim?.fetchedAt).toBe('number');

      // Subsequent call hits in-memory cache with 0 network calls because fetchedAt is stamped
      axiosSpy.mockClear();
      const cachedHit = await api.fetchGameMetadata(appId);
      expect(cachedHit?.macRequirements?.minimum).toContain('macOS 14.7.1+');
      expect(axiosSpy).not.toHaveBeenCalled();

      // 2. Legacy 2026-10-29 persisted Mac row (no macRequirements, no fetchedAt) loaded while OFFLINE enters inMemoryCached,
      // then upgrades LIVE once back online (proving C9 inMemoryCached upgrade!)
      const legacyAppId = 991081;
      const legacyMacMeta = makeRichMeta({
        appId: legacyAppId,
        name: 'Synthetic Legacy Mac RPG',
        macRequirements: undefined,
        fetchedAt: undefined,
        platforms: { windows: true, mac: true, linux: false },
      });
      testEnv.idbStore.set(`enriched_metadata:${legacyAppId}`, legacyMacMeta);

      const isOnlineSpy = vi.spyOn(onlineLifecycleManager, 'isOnline').mockReturnValue(false);
      const offlineRead = await api.fetchGameMetadata(legacyAppId);
      expect(offlineRead?.name).toBe('Synthetic Legacy Mac RPG');
      expect(offlineRead?.macRequirements).toBeUndefined();

      // Reconnect -> inMemoryCached has no macRequirements & no fetchedAt -> upgrades live!
      isOnlineSpy.mockReturnValue(true);
      axiosSpy.mockImplementation(async (url: string) => {
        if (url.includes('appdetails')) {
          return {
            data: {
              [String(legacyAppId)]: {
                success: true,
                data: {
                  name: 'Synthetic Legacy Mac RPG',
                  short_description: 'Native macOS edition.',
                  detailed_description: '<p>Native macOS edition.</p>',
                  about_the_game: '<p>Native macOS edition.</p>',
                  header_image: `https://cdn.example.invalid/${legacyAppId}/header.jpg`,
                  developers: ['Synthetic Mac Studio'],
                  publishers: ['Synthetic Pub'],
                  platforms: { windows: true, mac: true, linux: false },
                  pc_requirements: { minimum: 'Windows 10' },
                  mac_requirements: {
                    minimum: '<strong>OS:</strong> macOS 14.0+ Apple Silicon',
                  },
                },
              },
            },
          };
        }
        return { data: { query_summary: { total_reviews: 0 } } };
      });
      const onlineUpgraded = await api.fetchGameMetadata(legacyAppId);
      expect(onlineUpgraded?.macRequirements?.minimum).toContain('macOS 14.0+ Apple Silicon');
      expect(typeof onlineUpgraded?.fetchedAt).toBe('number');

      // 3. Fallback preserved when live upgrade network request fails
      const failAppId = 991082;
      const failLegacyMeta = makeRichMeta({
        appId: failAppId,
        name: 'Synthetic Fallback Safe',
        macRequirements: undefined,
        fetchedAt: undefined,
        platforms: { windows: true, mac: true, linux: false },
      });
      testEnv.idbStore.set(`enriched_metadata:${failAppId}`, failLegacyMeta);
      axiosSpy.mockRejectedValueOnce(new Error('Simulated network timeout'));
      const fallbackResult = await api.fetchGameMetadata(failAppId);
      expect(fallbackResult?.name).toBe('Synthetic Fallback Safe');
      expect(fallbackResult?.systemRequirements?.minimum).toContain('Windows 10');
    });

    it('parses GOG v2 _embedded.supportedOperatingSystems (windows, osx, linux) with entity-safe HTML escaping', async () => {
      const parsed = extractGogRequirementsByOs([
        {
          operatingSystem: { name: 'windows', versions: '10, 11' },
          systemRequirements: [
            {
              type: 'minimum',
              requirements: [
                { id: 'system', name: 'System:', description: 'Windows 10 &amp; 11' },
                { id: 'memory', name: 'Memory', description: '8&nbsp;GB RAM' },
              ],
            },
            {
              type: 'recommended',
              requirements: [{ id: 'memory', name: 'Memory', description: '16&nbsp;GB RAM' }],
            },
          ],
        },
        {
          operatingSystem: { name: 'osx', versions: '12+' },
          systemRequirements: [
            {
              type: 'minimum',
              requirements: [
                {
                  id: 'system',
                  name: 'System',
                  description: 'macOS 12.0+<br>Apple Silicon &amp; Intel<script>alert(1)</script>',
                },
                { id: 'graphics', name: 'Graphics', description: 'Metal 2 < 3' },
              ],
            },
          ],
        },
        {
          operatingSystem: { name: 'linux', versions: 'Ubuntu 22.04' },
          systemRequirements: [
            {
              type: 'minimum',
              description: 'Ubuntu 22.04, Processor: Dual Core 2.4 GHz, Memory: 4 GB RAM',
            },
          ],
        },
      ]);

      expect(parsed.systemRequirements?.minimum).toContain('<strong>System:</strong> Windows 10 &amp; 11');
      expect(parsed.systemRequirements?.minimum).toContain('<strong>Memory:</strong> 8 GB RAM');
      expect(parsed.systemRequirements?.minimum).not.toContain('&amp;nbsp;');
      expect(parsed.systemRequirements?.recommended).toContain('16 GB RAM');

      expect(parsed.macRequirements?.minimum).toContain('macOS 12.0+<br>Apple Silicon &amp; Intel');
      expect(parsed.macRequirements?.minimum).toContain('Metal 2 &lt; 3');
      expect(parsed.macRequirements?.minimum).not.toContain('<script>');
      expect(parsed.macRequirements?.minimum).not.toContain('&amp;amp;');

      expect(parsed.linuxRequirements?.minimum).toContain('Ubuntu 22.04');
      expect(parsed.linuxRequirements?.minimum).toContain('<strong>Processor:</strong>');

      // End-to-end through fetchGogProductMetadata
      vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (url.includes('/v2/games/')) {
          return {
            data: {
              description: '<p>Synthetic GOG native macOS adventure across mystical islands.</p>',
              _embedded: {
                developers: [{ name: 'Synthetic GOG Studio' }],
                supportedOperatingSystems: [
                  {
                    operatingSystem: { name: 'osx' },
                    systemRequirements: [
                      {
                        type: 'minimum',
                        requirements: [
                          { id: 'system', name: 'System', description: 'macOS 13.0 Ventura' },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          };
        }
        return { data: { title: 'Synthetic GOG Mac Game' } };
      });

      const gogMeta = await fallbackMetadataProvider.fetchGogProductMetadata(
        '991090',
        'Synthetic GOG Mac Game'
      );
      expect(gogMeta?.macRequirements?.minimum).toContain('macOS 13.0 Ventura');
    });

    it('parses Epic requirements.systems across Windows, Mac, and Linux, propagates IPC macRequirements, and refuses __quotaSlimmed fallback', async () => {
      const parsedEpic = extractEpicRequirementsByOs([
        {
          systemType: 'Windows',
          details: [
            { title: 'OS', minimum: 'Windows 10', recommended: 'Windows 11' },
            { title: 'Memory', minimum: '8 GB', recommended: '16 GB' },
          ],
        },
        {
          systemType: 'Mac',
          details: [
            { title: 'OS', minimum: 'macOS 12.0', recommended: 'macOS 14.0' },
            { title: 'Processor', minimum: 'Apple M1 &amp; Intel', recommended: 'Apple M2' },
          ],
        },
        {
          systemType: 'Linux',
          details: [{ title: 'OS', minimum: 'Ubuntu 22.04 LTS' }],
        },
      ]);

      expect(parsedEpic.systemRequirements?.minimum).toContain('<strong>OS:</strong> Windows 10');
      expect(parsedEpic.systemRequirements?.recommended).toContain('<strong>Memory:</strong> 16 GB');
      expect(parsedEpic.macRequirements?.minimum).toContain('<strong>OS:</strong> macOS 12.0');
      expect(parsedEpic.macRequirements?.minimum).toContain('Apple M1 &amp; Intel');
      expect(parsedEpic.macRequirements?.recommended).toContain('Apple M2');
      expect(parsedEpic.linuxRequirements?.minimum).toContain('Ubuntu 22.04 LTS');

      // IPC payload macRequirements / linuxRequirements propagation
      testEnv.windowObj.electronAPI = {
        platform: 'darwin',
        fetchEpicProductMetadata: vi.fn(async () => ({
          title: 'Synthetic Epic Mac Game',
          shortDescription: 'Official Epic Games Store narrative thriller for Windows and Mac.',
          screenshots: ['https://cdn.example.invalid/epic/s1.jpg'],
          movies: [{ id: 1, name: 'Trailer', videoUrl: 'https://cdn.example.invalid/epic/t1.mp4' }],
          supportedLanguages: ['English'],
          systemRequirements: { minimum: '<strong>OS:</strong> Windows 10' },
          macRequirements: { minimum: '<strong>OS:</strong> macOS 13.5 Apple Silicon' },
          linuxRequirements: { minimum: '<strong>OS:</strong> SteamOS 3.0' },
        })),
      };

      const epicMeta = await fallbackMetadataProvider.fetchEpicProductMetadata(
        'synthetic-epic-mac',
        { title: 'Synthetic Epic Mac Game', appName: 'SynthEpicMac' }
      );
      expect(epicMeta?.macRequirements?.minimum).toContain('macOS 13.5 Apple Silicon');
      expect(epicMeta?.linuxRequirements?.minimum).toContain('SteamOS 3.0');

      // Step 2 Epic Content Products API multi-OS systems parsing end-to-end
      testEnv.windowObj.electronAPI = { platform: 'darwin' };
      vi.spyOn(axios, 'get').mockResolvedValueOnce({
        data: {
          pages: [
            {
              type: 'productHome',
              data: {
                about: { shortDescription: 'Epic Content API narrative RPG.' },
                requirements: {
                  systems: [
                    { systemType: 'Windows', details: [{ title: 'OS', minimum: 'Windows 10' }] },
                    { systemType: 'Mac', details: [{ title: 'OS', minimum: 'macOS 14.2 Sonoma' }] },
                    { systemType: 'Linux', details: [{ title: 'OS', minimum: 'Ubuntu 22.04' }] },
                  ],
                },
              },
            },
          ],
        },
      });
      const epicContentMeta = await fallbackMetadataProvider.fetchEpicProductMetadata(
        'synthetic-epic-content-mac',
        { title: 'Synthetic Epic Content Mac' }
      );
      expect(epicContentMeta?.systemRequirements?.minimum).toContain('Windows 10');
      expect(epicContentMeta?.macRequirements?.minimum).toContain('macOS 14.2 Sonoma');
      expect(epicContentMeta?.linuxRequirements?.minimum).toContain('Ubuntu 22.04');

      // Refuses to return a __quotaSlimmed stub in getEnrichedMetadataForNonSteamGame when live lookup misses
      testEnv.windowObj.electronAPI = { platform: 'darwin' };
      vi.spyOn(axios, 'get').mockRejectedValue(new Error('offline'));
      const slimmedEpicGame = makeGame({
        id: 'epic-synth-slim',
        title: 'Synthetic Slimmed Epic',
        steamAppId: undefined,
        isExplicitNonSteam: true,
        platforms: [{ platformId: 'epic', platformGameId: 'synth-slim', installed: false }],
        shortDescription: '',
        detailedDescription: '',
        enrichedMetadata: {
          ...makeRichMeta({ appId: 0, enrichedSource: 'epic' }),
          __quotaSlimmed: true,
          shortDescription: '',
          detailedDescription: '',
          aboutTheGame: '',
          screenshots: [],
        },
      });
      const nonSteamResult =
        await fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(slimmedEpicGame);
      expect(nonSteamResult.__quotaSlimmed).toBeUndefined();
      expect(nonSteamResult.metadataQuality).toBe('skeleton_fallback');
    });
  });
});
