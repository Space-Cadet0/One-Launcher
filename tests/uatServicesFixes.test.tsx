import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import axios from 'axios';

import { makeCanonicalGame, makeUserGameOverride } from './helpers/factories';
import {
  DEFAULT_LIBRARY_FILTER_STATE,
  activeGameFilterToLibraryFilterState,
  type ActiveGameFilter,
} from '../src/contracts/filter';
import type { CanonicalGame } from '../src/contracts/game';
import type {
  ActiveGameSession,
  HibernateStatePayload,
  SessionUpdatedPayload,
} from '../src/contracts/launcher';
import type { StorefrontIntegration } from '../src/contracts/integration';
import type { ElectronAPI } from '../src/types/electron';

// ---------------------------------------------------------------------------
// Headless Browser & Storage Harness (Zero Real Network / Zero PII)
// ---------------------------------------------------------------------------
const testEnv = vi.hoisted(() => {
  class MemoryStorage implements Storage {
    private data = new Map<string, string>();
    get length(): number {
      return this.data.size;
    }
    clear(): void {
      this.data.clear();
    }
    getItem(key: string): string | null {
      return this.data.get(key) ?? null;
    }
    key(index: number): string | null {
      return Array.from(this.data.keys())[index] ?? null;
    }
    removeItem(key: string): void {
      this.data.delete(key);
    }
    setItem(key: string, value: string): void {
      this.data.set(key, String(value));
    }
  }

  const localStorageMock = new MemoryStorage();
  const eventTarget = new EventTarget();
  const bodyClasses = new Set<string>();

  const windowObj: Record<string, unknown> = {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.removeEventListener(type, listener),
    dispatchEvent: (event: Event) => eventTarget.dispatchEvent(event),
    localStorage: localStorageMock,
    location: { hostname: 'example.invalid', origin: 'https://example.invalid', protocol: 'https:' },
    navigator: { onLine: true, userAgent: 'NodeVitest/1.0' },
    innerWidth: 1440,
    innerHeight: 900,
    open: vi.fn(),
  };

  const documentObj: Record<string, unknown> = {
    hidden: false,
    body: {
      classList: {
        add: (cls: string) => bodyClasses.add(cls),
        remove: (cls: string) => bodyClasses.delete(cls),
        contains: (cls: string) => bodyClasses.has(cls),
      },
    },
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.removeEventListener(type, listener),
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  const g = globalThis as Record<string, unknown>;
  g.localStorage = localStorageMock;
  g.window = windowObj;
  g.document = documentObj;

  return { localStorageMock, windowObj, documentObj, bodyClasses };
});

import { useNavigationHistory, type NavHistoryEntry } from '../src/hooks/useNavigationHistory';
import { useStorefrontAuthFlow } from '../src/hooks/useStorefrontAuthFlow';
import { useManualLibrarySyncActions } from '../src/hooks/useManualLibrarySyncActions';
import { runStorefrontLibrarySync } from '../src/hooks/syncActions/storefrontSyncRunner';
import * as integrationStorage from '../src/services/integrations/integrationStorage';
import { steamIntegration } from '../src/services/integrations/steamIntegration';
import { epicIntegration } from '../src/services/integrations/epicIntegration';
import { gogIntegration } from '../src/services/integrations/gogIntegration';
import { xboxIntegration } from '../src/services/integrations/xboxIntegration';
import { steamAchievementsService } from '../src/services/steam/steamAchievementsService';
import * as localSystemScanner from '../src/services/system/localSystemScanner';
import {
  getUserOverrideForGame,
  saveUserOverride,
} from '../src/services/storage/userOverrideStorage';
import {
  isDonorGameCompatibleWithTarget,
  recoverRichSummaryFieldsFromDonor,
  slimGameForLocalStorageQuota,
} from '../src/services/integrations/catalog/catalogSlimming';
import {
  mergeHydratedCatalogPreservingLiveState,
  mergeStorefrontGames,
  mergeUpdatedGamePreservingLivePlatformState,
} from '../src/services/integrations/catalog/catalogMerger';
import { sanitizeGameCatalog } from '../src/services/integrations/catalogSanitizer';
import { runIntelligentNonSteamMatchPass } from '../src/utils/catalogMergeUtils';
import { findMatchingUserOverrideWithMemo } from '../src/services/critic/core/criticOverrideBridge';
import type { CompiledReviewOverrideIndex } from '../src/services/critic/core/criticServiceTypes';
import { launcherService } from '../src/services/launcher/launcherService';
import { SyncJobManager, syncJobManager } from '../src/services/network/syncJobManager';
import {
  extractReleaseYear,
  sanitizeGogCatalogLikeQuery,
} from '../src/services/scraper/scraperUrlAndQueryUtils';
import { metadataScraperService } from '../src/services/scraper/metadataScraperService';
import { executeParallelStorefrontSearch } from '../src/services/scraper/storefrontSearchEngine';
import {
  deriveGogCatalogRetryQuery,
  fetchGogProductMetadata,
  sanitizeGogCatalogLikeQuery as sanitizeGogClientLikeQuery,
} from '../src/services/steam/metadata/gogMetadataClient';
import { StorefrontReviewHarvester } from '../src/services/critic/storefrontReviewHarvester';

const nodeRequire = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Minimal Zero-`any` React Hook Test Harness
// ---------------------------------------------------------------------------
function mountHook<P, R>(useHook: (props: P) => R, initialProps: P) {
  let currentProps = initialProps;
  let latestResult!: R;
  let isUnmounted = false;

  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const memos: Array<{ deps: readonly unknown[] | undefined; value: unknown }> = [];
  const effectDeps: Array<readonly unknown[] | undefined> = [];
  const effectCleanups: Array<(() => void) | undefined> = [];

  const depsChanged = (
    prev: readonly unknown[] | undefined,
    next: readonly unknown[] | undefined
  ): boolean =>
    prev === undefined ||
    next === undefined ||
    prev.length !== next.length ||
    next.some((d, i) => !Object.is(d, prev[i]));

  const runCycle = () => {
    let dirty = false;
    let guard = 0;
    do {
      dirty = false;
      guard++;
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
          if (idx >= states.length) {
            states.push(typeof initial === 'function' ? (initial as () => S)() : initial);
          }
          const setState = (updater: S | ((prev: S) => S)) => {
            if (isUnmounted) return;
            const prevVal = states[idx] as S;
            const nextVal =
              typeof updater === 'function' ? (updater as (prev: S) => S)(prevVal) : updater;
            if (!Object.is(prevVal, nextVal)) {
              states[idx] = nextVal;
              dirty = true;
            }
          };
          return [states[idx] as S, setState] as const;
        },
        useRef<T>(initial: T) {
          const idx = refIdx++;
          if (idx >= refs.length) {
            refs.push({ current: initial });
          }
          return refs[idx] as { current: T };
        },
        useMemo<T>(factory: () => T, deps?: readonly unknown[]) {
          const idx = memoIdx++;
          const prev = memos[idx];
          if (!prev || depsChanged(prev.deps, deps)) {
            const value = factory();
            memos[idx] = { deps: deps ? [...deps] : undefined, value };
            return value;
          }
          return prev.value as T;
        },
        useCallback<T extends (...args: never[]) => unknown>(cb: T, deps?: readonly unknown[]) {
          const idx = memoIdx++;
          const prev = memos[idx];
          if (!prev || depsChanged(prev.deps, deps)) {
            memos[idx] = { deps: deps ? [...deps] : undefined, value: cb };
            return cb;
          }
          return prev.value as T;
        },
        useEffect(fn: () => void | (() => void), deps?: readonly unknown[]) {
          const idx = effectIdx++;
          const prevDeps = effectDeps[idx];
          if (idx >= effectDeps.length || depsChanged(prevDeps, deps)) {
            effectDeps[idx] = deps ? [...deps] : undefined;
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
        if (typeof effectCleanups[eff.idx] === 'function') {
          effectCleanups[eff.idx]!();
        }
        const cleanup = eff.fn();
        effectCleanups[eff.idx] = typeof cleanup === 'function' ? cleanup : undefined;
      }
    } while (dirty && guard < 12);
  };

  runCycle();

  return {
    getResult: () => latestResult,
    rerender: (nextProps?: Partial<P>) => {
      if (nextProps) {
        currentProps = { ...currentProps, ...nextProps };
      }
      runCycle();
    },
    flush: () => {
      runCycle();
    },
    unmount: () => {
      isUnmounted = true;
      for (const cleanup of effectCleanups) {
        if (typeof cleanup === 'function') {
          cleanup();
        }
      }
    },
  };
}

const ROOT_DIR = path.resolve(__dirname, '..');

describe('UAT Phase 3 Services & Hooks Remediation Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    testEnv.localStorageMock.clear();
    testEnv.bodyClasses.clear();
    delete testEnv.windowObj.electronAPI;
    launcherService.resetForTests();
    syncJobManager.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete testEnv.windowObj.electronAPI;
    launcherService.resetForTests();
    syncJobManager.reset();
  });

  // -------------------------------------------------------------------------
  // BUG-B1: Navigation History libraryFilterState Snapshots & Home Reset
  // -------------------------------------------------------------------------
  describe('BUG-B1: useNavigationHistory snapshots libraryFilterState across Back/Forward & App.tsx resets click-through filters', () => {
    it('restores pre-filter libraryFilterState on goBack() and re-applies filter on goForward()', () => {
      const initialEntry: Omit<NavHistoryEntry, 'id'> = {
        view: 'grid',
        selectedGameId: null,
        activeFilter: null,
        activeGroupId: null,
        title: 'All Games',
        scrollY: 0,
        libraryFilterState: DEFAULT_LIBRARY_FILTER_STATE,
      };

      const harness = mountHook(
        (props: { initial: Omit<NavHistoryEntry, 'id'> }) => useNavigationHistory(props.initial),
        { initial: initialEntry }
      );

      // 1. Navigate to a game detail page (unfiltered)
      harness.getResult().pushEntry({
        view: 'game',
        selectedGameId: 'steam-1086940',
        activeFilter: null,
        activeGroupId: null,
        title: "Baldur's Gate 3",
        libraryFilterState: DEFAULT_LIBRARY_FILTER_STATE,
      });
      harness.flush();
      expect(harness.getResult().currentEntry.view).toBe('game');
      expect(harness.getResult().currentEntry.libraryFilterState).toEqual(
        DEFAULT_LIBRARY_FILTER_STATE
      );

      // 2. Click Native OS: macOS link on the detail page
      const macFilter: ActiveGameFilter = {
        type: 'os',
        label: 'Native OS',
        value: 'macOS',
      };
      const macFilterState = activeGameFilterToLibraryFilterState(
        macFilter,
        DEFAULT_LIBRARY_FILTER_STATE,
        false
      );
      harness.getResult().pushEntry({
        view: 'grid',
        selectedGameId: 'steam-1086940',
        activeFilter: macFilter,
        activeGroupId: null,
        title: 'Native OS: macOS',
        libraryFilterState: macFilterState,
      });
      harness.flush();

      expect(harness.getResult().currentEntry.activeFilter).toEqual(macFilter);
      expect(harness.getResult().currentEntry.libraryFilterState?.osCompatibility).toEqual([
        'mac_native',
      ]);

      // 3. Click < Back to Baldur's Gate 3: BOTH activeFilter and libraryFilterState must revert!
      harness.getResult().goBack();
      harness.flush();
      expect(harness.getResult().currentEntry.view).toBe('game');
      expect(harness.getResult().currentEntry.activeFilter).toBeNull();
      expect(harness.getResult().currentEntry.libraryFilterState).toEqual(
        DEFAULT_LIBRARY_FILTER_STATE
      );
      expect(harness.getResult().currentEntry.libraryFilterState?.osCompatibility).toEqual([]);

      // 4. Click > Forward: BOTH activeFilter and osCompatibility: ['mac_native'] must be restored!
      harness.getResult().goForward();
      harness.flush();
      expect(harness.getResult().currentEntry.view).toBe('grid');
      expect(harness.getResult().currentEntry.activeFilter).toEqual(macFilter);
      expect(harness.getResult().currentEntry.libraryFilterState?.osCompatibility).toEqual([
        'mac_native',
      ]);

      // 5. Updating current entry filter state in-place does not corrupt earlier history entries
      const withRpg = { ...macFilterState, genres: ['rpg'] };
      harness.getResult().updateCurrentEntry({ libraryFilterState: withRpg });
      harness.flush();
      expect(harness.getResult().currentEntry.libraryFilterState?.genres).toEqual(['rpg']);

      harness.getResult().goBack();
      harness.flush();
      expect(harness.getResult().currentEntry.libraryFilterState).toEqual(
        DEFAULT_LIBRARY_FILTER_STATE
      );

      harness.unmount();
    });

    it('preserves App.tsx static contracts while wiring libraryFilterState directly into navigation history', () => {
      const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/App.tsx'), 'utf8');
      expect(appSrc).toContain('if (!isCatalogVaultHydrated)');
      expect(appSrc).toContain(
        'const libraryFilterState = currentEntry.libraryFilterState ?? DEFAULT_LIBRARY_FILTER_STATE;'
      );
      expect(appSrc).toContain('updateCurrentEntry');
      expect(appSrc).toContain(
        'libraryFilterState: activeFilter ? DEFAULT_LIBRARY_FILTER_STATE : libraryFilterState'
      );
    });
  });

  // -------------------------------------------------------------------------
  // BUG-C1: Connected Steam Re-sync Library Now & Sync Integrations Auth
  // -------------------------------------------------------------------------
  describe('BUG-C1: Connected Steam Re-sync Library Now & Sync Integrations auth handling', () => {
    const SYNTH_STEAM_ID = '76561198000000042';

    const makeConnectedSteamIntegration = (): StorefrontIntegration => ({
      storefrontId: 'steam',
      name: 'Steam',
      isConnected: true,
      accountName: 'SynthSteamPlayer',
      accountId: SYNTH_STEAM_ID,
      gamesCount: 1,
      lastSyncedAt: new Date().toISOString(),
      credentials: {
        steamId: SYNTH_STEAM_ID,
      },
    });

    it('re-syncs connected Steam cleanly via IPC syncStore with saved steamId when steamInput is empty', async () => {
      const steamGame = makeCanonicalGame({
        id: 'steam-620',
        title: 'Portal 2',
        steamAppId: 620,
        platforms: [{ platformId: 'steam', platformGameId: '620', installed: false }],
      });
      const syncStoreMock = vi.fn().mockResolvedValue({
        success: true,
        accountName: 'SynthSteamPlayer',
        accountId: SYNTH_STEAM_ID,
        games: [steamGame],
        authoritativeComplete: true,
      });

      testEnv.windowObj.electronAPI = {
        isElectron: true,
        syncStore: syncStoreMock,
        getSavedTokens: vi.fn().mockResolvedValue({
          steam: { steamId: SYNTH_STEAM_ID, accountName: 'SynthSteamPlayer' },
        }),
      } as Partial<ElectronAPI>;

      integrationStorage.saveIntegrations([makeConnectedSteamIntegration()]);
      const onLibraryUpdated = vi.fn();

      const harness = mountHook(
        (props: { isOpen: boolean; selectedTab: 'steam'; onLibraryUpdated: (g: CanonicalGame[]) => void }) =>
          useStorefrontAuthFlow(props),
        { isOpen: true, selectedTab: 'steam' as const, onLibraryUpdated }
      );

      await harness.getResult().completeStoreAuthentication('steam');
      harness.flush();

      expect(syncStoreMock).toHaveBeenCalledWith('steam', { steamId: SYNTH_STEAM_ID });
      expect(harness.getResult().errorMsg).toBeNull();
      expect(harness.getResult().successMsg).toContain('SynthSteamPlayer');
      expect(onLibraryUpdated).toHaveBeenCalledTimes(1);

      harness.unmount();
    });

    it('surfaces the real IPC error on connected Steam resync failure instead of falling through with steamId: undefined', async () => {
      const syncStoreMock = vi.fn().mockResolvedValue({
        success: false,
        error: 'Steam session expired. Please sign in again.',
      });

      testEnv.windowObj.electronAPI = {
        isElectron: true,
        syncStore: syncStoreMock,
        getSavedTokens: vi.fn().mockResolvedValue({}),
      } as Partial<ElectronAPI>;

      integrationStorage.saveIntegrations([makeConnectedSteamIntegration()]);
      const fetchOwnedSpy = vi.spyOn(steamIntegration, 'fetchOwnedGames');

      const harness = mountHook(
        (props: { isOpen: boolean; selectedTab: 'steam'; onLibraryUpdated: (g: CanonicalGame[]) => void }) =>
          useStorefrontAuthFlow(props),
        { isOpen: true, selectedTab: 'steam' as const, onLibraryUpdated: vi.fn() }
      );

      await harness.getResult().completeStoreAuthentication('steam');
      harness.flush();

      expect(fetchOwnedSpy).not.toHaveBeenCalled();
      expect(harness.getResult().errorMsg).toBe('Steam session expired. Please sign in again.');
      expect(harness.getResult().errorMsg).not.toContain('Steam ID is required');

      harness.unmount();
    });

    it('steamIntegration.fetchOwnedGames delegates to IPC syncStore in Electron without false unauthenticated errors', async () => {
      const steamGame = makeCanonicalGame({
        id: 'steam-220',
        title: 'Half-Life 2',
        steamAppId: 220,
        platforms: [{ platformId: 'steam', platformGameId: '220', installed: false }],
      });
      const syncStoreMock = vi.fn().mockResolvedValue({
        success: true,
        accountName: 'SynthSteamPlayer',
        accountId: SYNTH_STEAM_ID,
        games: [steamGame],
        authoritativeComplete: true,
      });

      testEnv.windowObj.electronAPI = {
        isElectron: true,
        syncStore: syncStoreMock,
      } as Partial<ElectronAPI>;

      const res = await steamIntegration.fetchOwnedGames({ steamId: SYNTH_STEAM_ID });
      expect(syncStoreMock).toHaveBeenCalledWith('steam', { steamId: SYNTH_STEAM_ID });
      expect(res.games).toHaveLength(1);
      expect(res.games[0].id).toBe('steam-220');
      expect(res.profile.personaName).toBe('SynthSteamPlayer');
    });

    it('runStorefrontLibrarySync avoids false unauthenticated Steam warnings when IPC returns transientOffline without a renderer API key', async () => {
      const syncStoreMock = vi.fn().mockResolvedValue({
        success: false,
        transientOffline: true,
        error: 'Steam Community temporarily unreachable.',
      });
      testEnv.windowObj.electronAPI = {
        isElectron: true,
        syncStore: syncStoreMock,
      } as Partial<ElectronAPI>;

      integrationStorage.saveIntegrations([makeConnectedSteamIntegration()]);
      vi.spyOn(localSystemScanner, 'scanLocalSteamAchievements').mockResolvedValue({});
      vi.spyOn(localSystemScanner, 'scanLocalInstalledGames').mockResolvedValue({
        success: true,
        installedSteamAppIds: [],
        installedGames: [],
      });
      vi.spyOn(integrationStorage, 'saveCurrentCatalog').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchOwnedSpy = vi.spyOn(steamIntegration, 'fetchOwnedGames');

      const gamesRef = { current: [] as CanonicalGame[] };
      await runStorefrontLibrarySync({
        gamesRef,
        setGames: vi.fn(),
        setGameRefreshKey: vi.fn(),
        overlayLauncherInstalledState: (cat) => cat,
        showSyncNotice: vi.fn(),
        isMountedRef: { current: true },
      });

      expect(syncStoreMock).toHaveBeenCalledWith('steam', { steamId: SYNTH_STEAM_ID });
      expect(fetchOwnedSpy).not.toHaveBeenCalled();
      const steamWarns = warnSpy.mock.calls.filter((call) =>
        String(call[0] || '').includes('Steam sync warning')
      );
      expect(steamWarns).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // BUG-C2: isCompatibleWithGame Rejects Conflicting Same-Storefront Overrides
  // -------------------------------------------------------------------------
  describe('BUG-C2: getUserOverrideForGame blocks cross-product hijacking on the same storefront', () => {
    it('rejects an override pinned to xbox:9NRRJLLXM68V when applied to xbox:9P38D19T7LRV despite shared steam-2537590 gameId', () => {
      const msfs2020Override = makeUserGameOverride({
        gameId: 'steam-2537590',
        platformId: 'xbox',
        platformGameId: '9NRRJLLXM68V',
        title: 'Microsoft Flight Simulator (2020)',
      });
      const overridesMap = {
        'steam-2537590': msfs2020Override,
        'xbox:9NRRJLLXM68V': msfs2020Override,
      };

      const msfs2024Game = makeCanonicalGame({
        id: 'steam-2537590',
        title: 'Microsoft Flight Simulator 2024',
        steamAppId: 2537590,
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9P38D19T7LRV',
            xboxProductId: '9P38D19T7LRV',
            installed: false,
          },
        ],
      });

      const msfs2020Game = makeCanonicalGame({
        id: 'steam-2537590',
        title: 'Microsoft Flight Simulator',
        steamAppId: 2537590,
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NRRJLLXM68V',
            xboxProductId: '9NRRJLLXM68V',
            installed: false,
          },
        ],
      });

      expect(getUserOverrideForGame(msfs2024Game, overridesMap)).toBeUndefined();
      expect(getUserOverrideForGame(msfs2020Game, overridesMap)).toEqual(msfs2020Override);
    });

    it('blocks secondary releaseDate, isExplicitNonSteam, reviewScoreOverride, criticScore, and enrichedMetadata bleed across distinct Xbox product IDs sharing an upstream appId', () => {
      const msfs2020CriticOverride = {
        id: 'mc-microsoft-flight-simulator',
        source: 'metacritic' as const,
        score: 91,
        tier: 'Mighty' as const,
        numReviews: 71,
        url: 'https://www.metacritic.com/game/microsoft-flight-simulator/critic-reviews/',
        summary: 'Synthetic MSFS 2020 press consensus',
        isVerified: true,
        isSynthetic: false,
      };
      const msfs2020Override = makeUserGameOverride({
        gameId: 'steam-2537590',
        platformId: 'xbox',
        platformGameId: '9NRRJLLXM68V',
        title: 'Microsoft Flight Simulator (2020)',
        steamAppId: null,
        isExplicitNonSteam: true,
        matchedStore: 'custom',
        matchedId: 'xbox-9NRRJLLXM68V',
        releaseDate: '2021-07-27',
        reviewScoreOverride: msfs2020CriticOverride,
        reviewRoute: {
          mode: 'routed',
          source: 'metacritic',
          url: msfs2020CriticOverride.url,
          metacriticSlug: 'microsoft-flight-simulator',
          steamAppId: 2537590,
          xboxProductId: '9NRRJLLXM68V',
          targetTitle: 'Microsoft Flight Simulator (2020)',
        },
      });
      saveUserOverride(msfs2020Override);

      const msfs2020Game = makeCanonicalGame({
        id: 'steam-2537590',
        title: 'Microsoft Flight Simulator (2020)',
        originalStoreTitle: 'Microsoft Flight Simulator (2020)',
        steamAppId: undefined,
        isExplicitNonSteam: true,
        releaseDate: '2021-07-27',
        reviewScoreOverride: msfs2020CriticOverride,
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NRRJLLXM68V',
            xboxProductId: '9NRRJLLXM68V',
            installed: false,
          },
        ],
        enrichedMetadata: {
          appId: 0,
          name: 'Microsoft Flight Simulator (2020)',
          aboutTheGame: 'MSFS 2020 description',
          detailedDescription: 'MSFS 2020 description',
          shortDescription: 'MSFS 2020 description',
          headerImage: '',
          screenshots: [],
          movies: [],
          developers: ['Asobo Studio'],
          publishers: ['Xbox Game Studios'],
          genres: ['Simulation'],
          tags: [],
          categories: [],
          releaseDate: '2021-07-27',
          supportedLanguages: 'English',
          systemRequirements: {},
          reviewSummary: {
            reviewScore: 0,
            reviewScoreDesc: '',
            totalPositive: 0,
            totalNegative: 0,
            totalReviews: 0,
            positivePercent: 0,
          },
          enrichedSource: 'xbox',
          metadataQuality: 'storefront_native',
        },
      });

      const msfs2024Clean = makeCanonicalGame({
        id: 'xbox-9P38D19T7LRV',
        title: 'Microsoft Flight Simulator 2024',
        originalStoreTitle: 'Microsoft Flight Simulator 2024',
        steamAppId: undefined,
        isExplicitNonSteam: undefined,
        releaseDate: 'Nov 19, 2024',
        reviewScoreOverride: undefined,
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9P38D19T7LRV',
            xboxProductId: '9P38D19T7LRV',
            installed: false,
          },
        ],
        enrichedMetadata: {
          appId: 2537590,
          name: 'Microsoft Flight Simulator 2024',
          aboutTheGame: 'MSFS 2024 description',
          detailedDescription: 'MSFS 2024 description',
          shortDescription: 'MSFS 2024 description',
          headerImage: '',
          screenshots: [],
          movies: [],
          developers: ['Asobo Studio'],
          publishers: ['Xbox Game Studios'],
          genres: ['Simulation'],
          tags: [],
          categories: [],
          releaseDate: 'TBA',
          supportedLanguages: 'English',
          systemRequirements: {},
          reviewSummary: {
            reviewScore: 0,
            reviewScoreDesc: '',
            totalPositive: 0,
            totalNegative: 0,
            totalReviews: 0,
            positivePercent: 0,
          },
          enrichedSource: 'steam',
          metadataQuality: 'authoritative',
        },
      });

      // 1. Donor compatibility & recoverRichSummaryFieldsFromDonor block cross-product bleed
      expect(isDonorGameCompatibleWithTarget(msfs2024Clean, msfs2020Game)).toBe(false);
      const slimmed2024 = slimGameForLocalStorageQuota(msfs2024Clean);
      const recovered2024 = recoverRichSummaryFieldsFromDonor(
        slimmed2024,
        msfs2020Game,
        msfs2020Game.enrichedMetadata,
        true
      );
      expect(recovered2024.reviewScoreOverride).toBeUndefined();
      expect(recovered2024.isExplicitNonSteam).toBeUndefined();
      expect(recovered2024.releaseDate).toBe('Nov 19, 2024');

      // 2. mergeUpdatedGamePreservingLivePlatformState & mergeHydratedCatalogPreservingLiveState reject conflicting products
      const preserved = mergeUpdatedGamePreservingLivePlatformState(msfs2020Game, msfs2024Clean);
      expect(preserved.releaseDate).toBe('Nov 19, 2024');
      expect(preserved.isExplicitNonSteam).toBeUndefined();
      expect(preserved.reviewScoreOverride).toBeUndefined();
      expect(preserved.enrichedMetadata?.releaseDate).toBe('TBA');

      const collidingHydrated2024: CanonicalGame = {
        ...msfs2024Clean,
        id: 'steam-2537590',
        steamAppId: 2537590,
      };
      const hydratedMerged = mergeHydratedCatalogPreservingLiveState(
        [msfs2020Game, slimmed2024],
        [msfs2020Game, collidingHydrated2024]
      );
      const hydrated2024 = hydratedMerged.find((g) =>
        g.platforms.some((p) => p.platformId === 'xbox' && p.platformGameId === '9P38D19T7LRV')
      );
      expect(hydrated2024).toBeDefined();
      expect(hydrated2024?.title).toBe('Microsoft Flight Simulator 2024');
      expect(hydrated2024?.releaseDate).toBe('Nov 19, 2024');
      expect(hydrated2024?.isExplicitNonSteam).toBeUndefined();
      expect(hydrated2024?.reviewScoreOverride).toBeUndefined();
      expect(hydrated2024?.enrichedMetadata?.releaseDate).toBe('TBA');

      // 3. Full Sync Integrations pipeline (mergeStorefrontGames -> runIntelligentNonSteamMatchPass -> sanitizeGameCatalog)
      const incomingXbox2024 = makeCanonicalGame({
        id: 'xbox-9P38D19T7LRV',
        title: 'Microsoft Flight Simulator 2024',
        releaseDate: '2024-11-19',
        isVerifiedEntitlement: true,
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9P38D19T7LRV',
            xboxProductId: '9P38D19T7LRV',
            installed: false,
            ownershipType: 'subscription',
          },
        ],
      });
      const incomingXbox2020 = makeCanonicalGame({
        id: 'xbox-9NRRJLLXM68V',
        title: 'Microsoft Flight Simulator',
        releaseDate: '2021-07-27',
        isVerifiedEntitlement: true,
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NRRJLLXM68V',
            xboxProductId: '9NRRJLLXM68V',
            installed: false,
            ownershipType: 'subscription',
          },
        ],
      });

      const afterXboxMerge = mergeStorefrontGames(
        [msfs2020Game, msfs2024Clean],
        [incomingXbox2020, incomingXbox2024],
        'xbox',
        { authoritativeComplete: true }
      );
      const afterMatchPass = runIntelligentNonSteamMatchPass(afterXboxMerge);
      const afterSanitize = sanitizeGameCatalog(afterMatchPass);

      const synced2024 = afterSanitize.find((g) => g.id === 'xbox-9P38D19T7LRV');
      const synced2020 = afterSanitize.find((g) => g.id === 'steam-2537590');
      expect(synced2024).toBeDefined();
      expect(synced2024?.title).toBe('Microsoft Flight Simulator 2024');
      expect(synced2024?.releaseDate).toBe('Nov 19, 2024');
      expect(synced2024?.isExplicitNonSteam).toBeUndefined();
      expect(synced2024?.reviewScoreOverride).toBeUndefined();
      expect(synced2024?.enrichedMetadata?.appId).toBe(2537590);
      expect(synced2024?.enrichedMetadata?.releaseDate).toBe('TBA');

      expect(synced2020).toBeDefined();
      expect(synced2020?.title).toBe('Microsoft Flight Simulator (2020)');
      expect(synced2020?.releaseDate).toBe('2021-07-27');
      expect(synced2020?.isExplicitNonSteam).toBe(true);
      expect(synced2020?.reviewScoreOverride?.id).toBe('mc-microsoft-flight-simulator');

      // 4. Self-heal already-poisoned xbox-9P38D19T7LRV row during Sync Integrations
      const poisoned2024: CanonicalGame = {
        ...msfs2024Clean,
        releaseDate: '2021-07-27',
        isExplicitNonSteam: true,
        reviewScoreOverride: msfs2020CriticOverride,
        enrichedMetadata: {
          ...msfs2024Clean.enrichedMetadata!,
          releaseDate: '2021-07-27',
        },
      };
      const healedCatalog = sanitizeGameCatalog(
        mergeStorefrontGames(
          [msfs2020Game, poisoned2024],
          [incomingXbox2020, incomingXbox2024],
          'xbox',
          { authoritativeComplete: true }
        )
      );
      const healed2024 = healedCatalog.find((g) => g.id === 'xbox-9P38D19T7LRV');
      expect(healed2024).toBeDefined();
      expect(healed2024?.title).toBe('Microsoft Flight Simulator 2024');
      expect(healed2024?.releaseDate).toBe('2024-11-19');
      expect(healed2024?.isExplicitNonSteam).toBeUndefined();
      expect(healed2024?.reviewScoreOverride).toBeUndefined();
      expect(healed2024?.enrichedMetadata?.releaseDate).toBe('2024-11-19');

      // 5. criticOverrideBridge refuses to bind xbox:9NRRJLLXM68V override onto xbox:9P38D19T7LRV
      const memo = new WeakMap<object, CompiledReviewOverrideIndex>();
      const criticOvFor2024 = findMatchingUserOverrideWithMemo(
        memo,
        2537590,
        'Microsoft Flight Simulator 2024',
        'steam-2537590',
        [{ platformId: 'xbox', platformGameId: '9P38D19T7LRV', xboxProductId: '9P38D19T7LRV' }]
      );
      const criticOvFor2020 = findMatchingUserOverrideWithMemo(
        memo,
        2537590,
        'Microsoft Flight Simulator (2020)',
        'steam-2537590',
        [{ platformId: 'xbox', platformGameId: '9NRRJLLXM68V', xboxProductId: '9NRRJLLXM68V' }]
      );
      expect(criticOvFor2024).toBeUndefined();
      expect(criticOvFor2020?.reviewScoreOverride?.id).toBe('mc-microsoft-flight-simulator');

      // 6. SQLite offlineVault upsertGames & saveUserOverride block cross-product bleed on conflicting Xbox BigIds
      const tmpVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-bug-c2-vault-'));
      interface VaultServiceLike {
        upsertGames: (games: CanonicalGame[]) => { success: boolean };
        saveUserOverride: (
          gameId: string,
          record: Record<string, unknown>
        ) => { success: boolean };
        saveGameDetail: (payload: Record<string, unknown>) => { success: boolean };
        getGameDetail: (gameId: string) => {
          enrichedMetadata?: { releaseDate?: string } | null;
          criticScore?: { id?: string; score?: number } | null;
        } | null;
        shutdown: () => void;
      }
      const { OfflineVaultService } = nodeRequire(
        path.join(ROOT_DIR, 'electron/launcher/offlineVaultService.cjs')
      ) as {
        OfflineVaultService: new (opts: { userDataDir: string }) => VaultServiceLike;
      };
      const vault = new OfflineVaultService({ userDataDir: tmpVaultDir });
      try {
        // Seed MSFS 2024 under colliding key with its own critic score 78
        vault.upsertGames([collidingHydrated2024]);
        vault.saveGameDetail({
          gameId: 'steam-2537590',
          steamAppId: 2537590,
          canonicalTitle: 'Microsoft Flight Simulator 2024',
          criticScore: {
            id: 'mc-microsoft-flight-simulator-2024',
            source: 'metacritic',
            score: 78,
          },
        });
        // Saving MSFS 2020's override (pinned to xbox:9NRRJLLXM68V) MUST NOT overwrite xbox:9P38D19T7LRV's critic_json
        vault.saveUserOverride('steam-2537590', {
          gameId: 'steam-2537590',
          platformId: 'xbox',
          platformGameId: '9NRRJLLXM68V',
          reviewScoreOverride: msfs2020CriticOverride,
        });
        const detailAfterOtherOverride = vault.getGameDetail('steam-2537590');
        expect(detailAfterOtherOverride?.criticScore?.id).toBe(
          'mc-microsoft-flight-simulator-2024'
        );
        expect(detailAfterOtherOverride?.criticScore?.score).toBe(78);

        // Upserting MSFS 2020 row onto a colliding gameId replaces instead of carrying forward MSFS 2024 fields
        vault.upsertGames([msfs2020Game]);
        const detailAfterReplace = vault.getGameDetail('steam-2537590');
        expect(detailAfterReplace?.enrichedMetadata?.releaseDate).toBe('2021-07-27');
      } finally {
        vault.shutdown();
        fs.rmSync(tmpVaultDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // BUG-C3: InGameHibernationView IPC Ordering Race Defense
  // -------------------------------------------------------------------------
  describe('BUG-C3: launcherService defends inGameHibernating against early IPC ordering races', () => {
    it('preserves inGameHibernating when hibernate-state arrives before session-updated and clears only on explicit resume or session stop', async () => {
      let hibernateHandler:
        | ((payload: HibernateStatePayload & Record<string, unknown>) => void)
        | null = null;
      let sessionHandler: ((payload: SessionUpdatedPayload) => void) | null = null;

      testEnv.windowObj.electronAPI = {
        isElectron: true,
        getGameLaunchConfigs: vi.fn().mockResolvedValue({}),
        getRunningGames: vi.fn().mockResolvedValue([]),
        getDownloadQueue: vi.fn().mockResolvedValue([]),
        detectCompatibilityLayers: vi.fn().mockResolvedValue([]),
        getLauncherPerformanceSettings: vi.fn().mockResolvedValue({
          inGameLauncherBehavior: 'hide_tray_hibernate',
        }),
        saveLauncherPerformanceSettings: vi.fn().mockResolvedValue({
          inGameLauncherBehavior: 'hide_tray_hibernate',
        }),
        drainPendingSessions: vi.fn().mockResolvedValue([]),
        detectInstalledStorefrontClients: vi.fn().mockResolvedValue({}),
        scanAllInstalledGames: vi.fn().mockResolvedValue({ success: true, installedGames: [] }),
        getAppInfo: vi.fn().mockResolvedValue({ platform: 'darwin', arch: 'arm64' }),
        onDownloadUpdated: vi.fn().mockReturnValue(() => {}),
        onSessionUpdated: vi.fn((cb: (payload: SessionUpdatedPayload) => void) => {
          sessionHandler = cb;
          return () => {};
        }),
        onHibernateStateChanged: vi.fn(
          (cb: (payload: HibernateStatePayload & Record<string, unknown>) => void) => {
            hibernateHandler = cb;
            return () => {};
          }
        ),
        onCompatibilityRunnerProgress: vi.fn().mockReturnValue(() => {}),
      } as Partial<ElectronAPI>;

      await launcherService.initialize();
      expect(hibernateHandler).not.toBeNull();
      expect(sessionHandler).not.toBeNull();

      // 1. Main process sends hibernate-state { hibernating: true } BEFORE session-updated { event: 'started' }
      hibernateHandler!({
        hibernating: true,
        inGame: true,
        mode: 'hide_tray_hibernate',
        gameTitle: 'Synthetic Adventure',
      });
      expect(launcherService.isInGameHibernating()).toBe(true);

      // 2. An intervening syncInGameResourceThrottle() call (via savePerformanceSettings) while
      // activeSessions.size === 0 MUST NOT wipe inGameHibernating back to false!
      await launcherService.savePerformanceSettings({
        inGameLauncherBehavior: 'hide_tray_hibernate',
      });
      expect(launcherService.isInGameHibernating()).toBe(true);

      // 3. session-updated { event: 'started' } arrives shortly afterward -> hibernation stays active
      const session: ActiveGameSession = {
        sessionId: 'sess-1',
        gameId: 'gog-1207658992',
        title: 'Synthetic Adventure',
        platformId: 'gog',
        platformGameId: '1207658992',
        startedAt: new Date().toISOString(),
        launchMethod: 'direct',
        status: 'running',
      };
      sessionHandler!({ event: 'started', session });
      expect(launcherService.isInGameHibernating()).toBe(true);
      expect(launcherService.getRunningGames()).toHaveLength(1);

      // 4. All sessions end -> inGameHibernating clears cleanly to false!
      sessionHandler!({
        event: 'stopped',
        session: { ...session, status: 'stopping' },
        sessionMinutesPlayed: 5,
        durationSeconds: 300,
      });
      expect(launcherService.getRunningGames()).toHaveLength(0);
      expect(launcherService.isInGameHibernating()).toBe(false);

      // 5. Explicit resumeFromHibernation() & hibernate-state { hibernating: false } always clear immediately
      hibernateHandler!({ hibernating: true, inGame: true });
      expect(launcherService.isInGameHibernating()).toBe(true);
      launcherService.resumeFromHibernation();
      expect(launcherService.isInGameHibernating()).toBe(false);

      hibernateHandler!({ hibernating: true, inGame: true });
      expect(launcherService.isInGameHibernating()).toBe(true);
      hibernateHandler!({ hibernating: false, inGame: false });
      expect(launcherService.isInGameHibernating()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // BUG-C7: GlobalSyncProgressBar Self-Preemption & Cancelled Sync Banners
  // -------------------------------------------------------------------------
  describe('BUG-C7: SyncJobManager self-preemption exemption & honest cancelled sync notices', () => {
    it('exempts storefront_libraries from self-preempting on Syncing Storefront Libraries while honoring real external priority scopes', async () => {
      const mgr = new SyncJobManager();
      const scopeId = mgr.beginPriorityScope('Syncing Storefront Libraries');

      let stateDuringStorefrontSync = mgr.getState();
      let stateDuringExternalPreempt = mgr.getState();

      await mgr.trackTask('storefront_libraries', 'Steam', async () => {
        stateDuringStorefrontSync = mgr.getState();
        const inGameScope = mgr.beginPriorityScope('In-Game Performance Mode', 'Hades II');
        stateDuringExternalPreempt = mgr.getState();
        mgr.endPriorityScope(inGameScope);
      });

      mgr.endPriorityScope(scopeId);
      mgr.reset();

      expect(stateDuringStorefrontSync?.type).toBe('storefront_libraries');
      expect(stateDuringStorefrontSync?.isPreempted).toBe(false);
      expect(stateDuringStorefrontSync?.priorityHeadline).toBeUndefined();

      expect(stateDuringExternalPreempt?.isPreempted).toBe(true);
      expect(stateDuringExternalPreempt?.priorityHeadline).toBe('In-Game Performance Mode');
    });

    it('announces "Store media sync cancelled." instead of "Store media sync complete!" when cancelled after updating a game', async () => {
      const targetGame = makeCanonicalGame({
        id: 'steam-991001',
        title: 'Synthetic Media Game',
        steamAppId: 991001,
      });
      const gamesRef = { current: [targetGame] };
      const showSyncNotice = vi.fn();

      const startSpy = vi
        .spyOn(syncJobManager, 'startStoreMediaSync')
        .mockImplementation(async (batch, onUpdated) => {
          const fakeJobId = `sync-store-media-cancel-test-${Date.now()}`;
          // Drive real subscriber notifications via startTrophySync/trackTask-style state or direct cancel flow
          // Use the internal state + cancelJob path via a real SyncJobManager transition:
          onUpdated({ ...batch[0], shortDescription: 'Partial update before cancel' });
          Reflect.set(syncJobManager, 'state', {
            id: fakeJobId,
            type: 'store_media',
            title: 'Syncing Official Store Media',
            headline: 'Syncing Official Store Media',
            total: 10,
            current: 1,
            status: 'running',
            startedAt: Date.now(),
          });
          syncJobManager.cancelJob(fakeJobId);
        });

      const harness = mountHook(
        (props: Parameters<typeof useManualLibrarySyncActions>[0]) =>
          useManualLibrarySyncActions(props),
        {
          gamesRef,
          selectedGame: null,
          isGridView: true,
          isSyncingAllMedia: false,
          setIsSyncingAllMedia: vi.fn(),
          setGames: vi.fn(),
          setGameRefreshKey: vi.fn(),
          overlayLauncherInstalledState: (cat) => cat,
          showSyncNotice,
        }
      );

      await harness.getResult().handleSyncStoreMedia();
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(showSyncNotice).toHaveBeenLastCalledWith('Store media sync cancelled.', 4000);
      const anyCompleteNotice = showSyncNotice.mock.calls.some((call) =>
        String(call[0] || '').includes('Store media sync complete!')
      );
      expect(anyCompleteNotice).toBe(false);

      harness.unmount();
    });

    it('clears the sticky trophy sync banner immediately with "Trophy sync cancelled." when Sync Trophies is cancelled', async () => {
      const gamesRef = { current: [] as CanonicalGame[] };
      const showSyncNotice = vi.fn();

      vi.spyOn(localSystemScanner, 'scanLocalSteamAchievements').mockImplementation(async () => {
        const runningId = syncJobManager.getState()?.id;
        if (runningId) {
          syncJobManager.cancelJob(runningId);
        }
        return {};
      });
      vi.spyOn(steamAchievementsService, 'syncUserLibraryAchievements').mockResolvedValue({});
      vi.spyOn(gogIntegration, 'fetchUserAchievementsAndStats').mockResolvedValue({
        achievements: {},
        stats: {},
      });
      vi.spyOn(epicIntegration, 'fetchUserAchievements').mockResolvedValue({});
      vi.spyOn(xboxIntegration, 'fetchUserAchievements').mockResolvedValue({});
      vi.spyOn(integrationStorage, 'saveCurrentCatalog').mockImplementation(() => {});

      const harness = mountHook(
        (props: Parameters<typeof useManualLibrarySyncActions>[0]) =>
          useManualLibrarySyncActions(props),
        {
          gamesRef,
          selectedGame: null,
          isGridView: true,
          isSyncingAllMedia: false,
          setIsSyncingAllMedia: vi.fn(),
          setGames: vi.fn(),
          setGameRefreshKey: vi.fn(),
          overlayLauncherInstalledState: (cat) => cat,
          showSyncNotice,
        }
      );

      await harness.getResult().handleSyncTrophies();

      // Initial banner has a finite duration (not indefinite), and cancellation replaces it cleanly
      expect(showSyncNotice.mock.calls[0]?.[1]).toBe(4000);
      expect(showSyncNotice).toHaveBeenLastCalledWith('Trophy sync cancelled.', 4000);
      const anyCompletedBanner = showSyncNotice.mock.calls.some((call) =>
        String(call[0] || '').includes('Trophies synced across')
      );
      expect(anyCompletedBanner).toBe(false);

      harness.unmount();
    });
  });

  // -------------------------------------------------------------------------
  // BUG-B4, BUG-B7 & Epic GraphQL 400 Guard
  // -------------------------------------------------------------------------
  describe('BUG-B4, BUG-B7 & Epic GraphQL 400: Date year extraction, GOG like: sanitization & Epic 400 circuit breaker', () => {
    it('BUG-B4: extracts 4-digit release years from non-ISO GOG dates ("3 Jun 2010" -> "2010", never "3 Ju")', async () => {
      expect(extractReleaseYear('3 Jun 2010')).toBe('2010');
      expect(extractReleaseYear('2010-06-03')).toBe('2010');
      expect(extractReleaseYear('2010.06.03')).toBe('2010');
      expect(extractReleaseYear('Nov 19, 2024')).toBe('2024');
      expect(extractReleaseYear('TBA')).toBeUndefined();

      const gogGame = makeCanonicalGame({
        id: 'gog-1207660103',
        title: 'Alien Breed: Impact',
        releaseDate: '3 Jun 2010',
        platforms: [{ platformId: 'gog', platformGameId: '1207660103', installed: false }],
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        new Response(
          JSON.stringify({
            productCount: 1,
            products: [
              {
                id: '1207660103',
                title: 'Alien Breed: Impact',
                slug: 'alien_breed_impact',
                releaseDate: '3 Jun 2010',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const searchCandidates = await executeParallelStorefrontSearch('Alien Breed: Impact', 'gog', {
        querySteamStore: async () => [],
        queryLutrisGames: async () => [],
      });
      const gogSearchCand = searchCandidates.find((c) => c.source === 'gog');
      expect(gogSearchCand?.year).toBe('2010');
      expect(gogSearchCand?.year).not.toBe('3 Ju');

      // Verify sanitized GOG like: query in storefrontSearchEngine had no colon
      expect(fetchSpy).toHaveBeenCalled();
      const calledUrl = String(fetchSpy.mock.calls[0]?.[0] || '');
      expect(decodeURIComponent(calledUrl)).toContain('query=like:Alien Breed Impact');

      const suggested = await metadataScraperService.getSuggestedMatches(
        gogGame,
        undefined,
        'gog',
        true
      );
      const suggestedGog = suggested.find((c) => c.source === 'gog');
      expect(suggestedGog?.year).toBe('2010');
    });

    it('BUG-B7: sanitizes hyphens and punctuation out of GOG fallback catalog like: queries', async () => {
      expect(sanitizeGogCatalogLikeQuery('Daggerfall Unity - GOG Cut')).toBe(
        'Daggerfall Unity GOG Cut'
      );
      expect(sanitizeGogClientLikeQuery('like:Daggerfall Unity - GOG Cut™')).toBe(
        'Daggerfall Unity GOG Cut'
      );

      const requestedUrls: string[] = [];
      vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        requestedUrls.push(url);
        if (url.includes('catalog.gog.com/v1/catalog')) {
          return {
            data: {
              productCount: 1,
              products: [
                {
                  id: '999999',
                  title: 'Daggerfall Unity - GOG Cut',
                  slug: 'daggerfall_unity_gog_cut',
                  releaseDate: '2022.05.01',
                },
              ],
            },
          };
        }
        throw Object.assign(new Error('Not found'), { response: { status: 404 } });
      });

      await fetchGogProductMetadata('1782995089', 'Daggerfall Unity - GOG Cut');

      const catalogCall = requestedUrls.find((u) => u.includes('/v1/catalog'));
      expect(catalogCall).toBeDefined();
      const decodedCatalogCall = decodeURIComponent(catalogCall || '');
      expect(decodedCatalogCall).toContain('query=like:Daggerfall Unity GOG Cut');
      expect(decodedCatalogCall).not.toContain('like:Daggerfall Unity - GOG Cut');
    });

    it('BUG-B7 residual: retries once with primary leading token on GOG /v1/catalog HTTP 400, validates title similarity, and stays silent on benign 400/404 misses', async () => {
      expect(
        deriveGogCatalogRetryQuery('Daggerfall Unity GOG Cut', 'Daggerfall Unity - GOG Cut')
      ).toBe('Daggerfall');
      expect(deriveGogCatalogRetryQuery('The Witcher 3 Wild Hunt', 'The Witcher 3: Wild Hunt')).toBe(
        'Witcher'
      );
      expect(deriveGogCatalogRetryQuery('Daggerfall')).toBeNull();
      expect(deriveGogCatalogRetryQuery('F1 24')).toBeNull();

      // Case 1: Multi-token query returns HTTP 400 -> retries once with `like:Daggerfall` ->
      // rejects unrelated "The Elder Scrolls II: Daggerfall" and returns null with ZERO warnings!
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const urlsCase1: string[] = [];
      vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        urlsCase1.push(url);
        const decoded = decodeURIComponent(url);
        if (decoded.includes('/v1/catalog') && decoded.includes('query=like:Daggerfall Unity GOG Cut')) {
          throw Object.assign(new Error('Request failed with status code 400'), {
            response: { status: 400 },
          });
        }
        if (decoded.includes('/v1/catalog') && decoded.includes('query=like:Daggerfall')) {
          return {
            status: 200,
            data: {
              productCount: 2,
              products: [
                {
                  id: '1435828767',
                  title: 'The Elder Scrolls II: Daggerfall',
                  slug: 'the_elder_scrolls_ii_daggerfall',
                  releaseDate: '1996.08.31',
                },
                {
                  id: '1435828999',
                  title: 'Daggerfall 2',
                  slug: 'daggerfall_2',
                  releaseDate: '2025.01.01',
                },
              ],
            },
          };
        }
        throw Object.assign(new Error('Not found'), { response: { status: 404 } });
      });

      const resCase1 = await fetchGogProductMetadata('1782995089', 'Daggerfall Unity - GOG Cut');
      expect(resCase1).toBeNull();
      const catalogUrlsCase1 = urlsCase1
        .filter((u) => u.includes('/v1/catalog'))
        .map((u) => decodeURIComponent(u));
      expect(catalogUrlsCase1).toHaveLength(2);
      expect(catalogUrlsCase1[0]).toContain('query=like:Daggerfall Unity GOG Cut');
      expect(catalogUrlsCase1[1]).toContain('query=like:Daggerfall');
      expect(warnSpy).not.toHaveBeenCalled();

      // Case 2: Retry returns both an unrelated game AND a corroborated candidate -> picks only the corroborated match
      warnSpy.mockClear();
      vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        const decoded = decodeURIComponent(url);
        if (decoded.includes('/v1/catalog') && decoded.includes('query=like:Daggerfall Unity GOG Cut')) {
          throw Object.assign(new Error('Request failed with status code 400'), {
            response: { status: 400 },
          });
        }
        if (decoded.includes('/v1/catalog') && decoded.includes('query=like:Daggerfall')) {
          return {
            status: 200,
            data: {
              productCount: 2,
              products: [
                {
                  id: '1435828767',
                  title: 'The Elder Scrolls II: Daggerfall',
                  slug: 'the_elder_scrolls_ii_daggerfall',
                  releaseDate: '1996.08.31',
                  developers: ['Bethesda Softworks'],
                },
                {
                  id: '1782995089',
                  title: 'Daggerfall Unity',
                  slug: 'daggerfall_unity',
                  releaseDate: '2022.05.01',
                  developers: ['Interkarma'],
                  coverVertical: 'https://images.gog.com/daggerfall_unity_cover.jpg',
                },
              ],
            },
          };
        }
        if (decoded.includes('/en/game/daggerfall_unity')) {
          return {
            status: 200,
            data: '<div class="description"><p>Daggerfall Unity brings the classic RPG into a modern open-source engine.</p></div>',
          };
        }
        throw Object.assign(new Error('Not found'), { response: { status: 404 } });
      });

      const resCase2 = await fetchGogProductMetadata('1782995089', 'Daggerfall Unity - GOG Cut');
      expect(resCase2).not.toBeNull();
      expect(resCase2?.releaseDate).toBe('2022-05-01');
      expect(resCase2?.developers).toEqual(['Interkarma']);
      expect(warnSpy).not.toHaveBeenCalled();

      // Case 3: Persistent HTTP 400 on both initial query and single retry -> silent null (zero console.warn)
      warnSpy.mockClear();
      const urlsCase3: string[] = [];
      vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        urlsCase3.push(url);
        if (url.includes('/v1/catalog')) {
          throw Object.assign(new Error('Request failed with status code 400'), {
            response: { status: 400 },
          });
        }
        throw Object.assign(new Error('Not found'), { response: { status: 404 } });
      });

      const resCase3 = await fetchGogProductMetadata('1782995089', 'Daggerfall Unity - GOG Cut');
      expect(resCase3).toBeNull();
      expect(urlsCase3.filter((u) => u.includes('/v1/catalog'))).toHaveLength(2);
      expect(warnSpy).not.toHaveBeenCalled();

      // Case 4: Real server error (HTTP 500) still logs diagnostic warning
      warnSpy.mockClear();
      vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (url.includes('/v1/catalog')) {
          throw Object.assign(new Error('Request failed with status code 500'), {
            response: { status: 500 },
          });
        }
        throw Object.assign(new Error('Not found'), { response: { status: 404 } });
      });

      const resCase4 = await fetchGogProductMetadata('1782995089', 'Daggerfall Unity - GOG Cut');
      expect(resCase4).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0] || '')).toContain(
        '[Fallback Provider] GOG catalog search fallback failed'
      );
    });

    it('Epic GraphQL 400 guard: trips session cooldown on HTTP 400 so Harvester does not spam repeated 400s across SKUs or games, and Electron epicIntegration skips unauthenticated renderer GraphQL POST', async () => {
      const harvester = new StorefrontReviewHarvester();
      let graphqlCalls = 0;
      let contentCalls = 0;

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/graphql')) {
          graphqlCalls++;
          return new Response(JSON.stringify({ errors: [{ message: 'Bad Request' }] }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/content/products/')) {
          contentCalls++;
          return new Response(
            JSON.stringify({
              text: 'Review at https://www.metacritic.com/game/pc/synthetic-epic-game',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('', { status: 404 });
      });

      const anchor1 = await harvester.getEpicAnchor('synthetic-epic-game', 'Synthetic Epic Game');
      const anchor2 = await harvester.getEpicAnchor('another-epic-title', 'Another Epic Title');

      // Must break after the very first HTTP 400 and suppress all further GraphQL calls during cooldown
      expect(graphqlCalls).toBe(1);
      expect(contentCalls).toBe(2);
      expect(anchor1?.metacriticSlug).toBe('synthetic-epic-game');
      expect(anchor2?.storefront).toBe('epic');

      // Electron epicIntegration.fetchUserAchievements must NOT fall back to an unauthenticated renderer GraphQL POST
      const axiosPostSpy = vi.spyOn(axios, 'post');
      testEnv.windowObj.electronAPI = {
        isElectron: true,
        fetchEpicAchievements: vi.fn().mockResolvedValue({}),
      } as Partial<ElectronAPI>;

      const achMap = await epicIntegration.fetchUserAchievements(
        '00000000000000000000000000000042',
        'saved_in_electron'
      );
      expect(achMap).toEqual({});
      expect(axiosPostSpy).not.toHaveBeenCalled();
    });
  });
});
