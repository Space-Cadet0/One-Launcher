import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToString } from 'react-dom/server';

import type { CanonicalGame } from '../src/contracts/game';
import {
  loadCurrentCatalog,
  saveCurrentCatalog,
  flushPendingCatalogSave,
} from '../src/services/integrations/integrationStorage';
import { SteamApiService, steamApi } from '../src/services/steam/steamApi';
import { criticScoreService } from '../src/services/critic/criticScoreService';
import {
  LibraryGridView,
  GameCardCover,
  getCoverCandidates,
  notifyImageUnmounted,
} from '../src/components/Library/LibraryGridView';
import { LibrarySidebar } from '../src/components/Library/LibrarySidebar';
import { StorefrontIcon } from '../src/components/Common/StorefrontIcon';
import { MediaGallery } from '../src/components/SteamStoreDetail/MediaGallery';
import { App } from '../src/App';
import { loadMainProcessHarness, loadPreloadApi } from './helpers/electronRuntimeHarness';

const requireCjs = createRequire(import.meta.url);
const launcherEngine = requireCjs('../electron/launcherEngine.cjs');
const storeSync = requireCjs('../electron/storeSync.cjs');

// ---------------------------------------------------------------------------
// Mock Browser Environment (window, localStorage, CustomEvent) for Headless QA
// ---------------------------------------------------------------------------
class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

const mockStorage = new MockStorage();

if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = mockStorage;
}

if (typeof (globalThis as any).CustomEvent === 'undefined') {
  (globalThis as any).CustomEvent = class CustomEvent {
    type: string;
    detail: any;
    constructor(type: string, init?: any) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
}

const windowEventListeners: Record<string, Function[]> = {};
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = {
    localStorage: mockStorage,
    location: { hostname: '' },
    addEventListener: (event: string, fn: Function) => {
      windowEventListeners[event] = windowEventListeners[event] || [];
      windowEventListeners[event].push(fn);
    },
    removeEventListener: (event: string, fn: Function) => {
      if (windowEventListeners[event]) {
        windowEventListeners[event] = windowEventListeners[event].filter((f) => f !== fn);
      }
    },
    dispatchEvent: (event: any) => {
      const fns = (windowEventListeners[event.type] || []).slice();
      fns.forEach((f) => f(event));
      return true;
    },
  };
} else if (!(globalThis as any).window.localStorage) {
  (globalThis as any).window.localStorage = mockStorage;
}

/**
 * Helper to build a valid binary Steam appinfo.vdf (v28, magic 0x07564428)
 * containing multiple AppIDs with launch specifications.
 */
function buildBinarySteamAppInfoVdfV28(
  apps: Array<{
    appId: number;
    executable: string;
    arguments?: string;
    oslist?: string;
  }>
): Buffer {
  const cstr = (s: string) => Buffer.from(`${s}\0`, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x07564428, 0); // v28 magic
  header.writeUInt32LE(1, 4); // universe

  const appChunks: Buffer[] = [header];
  for (const app of apps) {
    const launchEntryParts: Buffer[] = [
      Buffer.from([0x01]),
      cstr('executable'),
      cstr(app.executable),
    ];
    if (app.arguments) {
      launchEntryParts.push(Buffer.from([0x01]), cstr('arguments'), cstr(app.arguments));
    }
    if (app.oslist) {
      launchEntryParts.push(
        Buffer.from([0x00]),
        cstr('config'),
        Buffer.from([0x01]),
        cstr('oslist'),
        cstr(app.oslist),
        Buffer.from([0x08])
      );
    }
    launchEntryParts.push(Buffer.from([0x08])); // end "0"

    const vdfPayload = Buffer.concat([
      Buffer.from([0x00]),
      cstr('appinfo'),
      Buffer.from([0x00]),
      cstr('config'),
      Buffer.from([0x00]),
      cstr('launch'),
      Buffer.from([0x00]),
      cstr('0'),
      ...launchEntryParts,
      Buffer.from([0x08]), // end "launch"
      Buffer.from([0x08]), // end "config"
      Buffer.from([0x08]), // end "appinfo"
      Buffer.from([0x08]), // root terminator
    ]);

    const entryMetaBytes = 60; // v28 metadata header bytes
    const entryHeader = Buffer.alloc(8 + entryMetaBytes);
    entryHeader.writeUInt32LE(app.appId, 0);
    entryHeader.writeUInt32LE(entryMetaBytes + vdfPayload.length, 4);
    appChunks.push(entryHeader, vdfPayload);
  }

  const footer = Buffer.alloc(4);
  footer.writeUInt32LE(0, 0);
  appChunks.push(footer);
  return Buffer.concat(appChunks);
}

describe('Phase 4: Comprehensive Performance Optimization & Resource Footprint Verification Suite', () => {
  const repoRoot = path.resolve(__dirname, '..');

  beforeEach(() => {
    localStorage.clear();
  });

  // =========================================================================
  // 1. Electron Main Process Memory Hardening (electron/main.cjs, launcherEngine.cjs, storeSync.cjs)
  // =========================================================================
  describe('1. Electron Main Process Memory Hardening (electron/main.cjs, launcherEngine.cjs, storeSync.cjs)', () => {
    it('configures --max-old-space-size=384 --expose-gc, Chromium disk/media cache caps, renderer-process-limit=2, createMainWindow spellcheck/backgroundThrottling, 15s Steam VDF scan TTL, and perf:trim-memory IPC', async () => {
      const mainHarness = loadMainProcessHarness({ platform: 'darwin' });
      const preload = loadPreloadApi({ platform: 'darwin' });

      try {
        // 1a. Verify runtime Chromium command-line switches
        const switchMap = new Map(mainHarness.switches.map((s) => [s.name, s.value]));
        expect(switchMap.get('js-flags')).toContain('--max-old-space-size=384');
        expect(switchMap.get('js-flags')).toContain('--expose-gc');
        expect(switchMap.get('disk-cache-size')).toBe(String(50 * 1024 * 1024));
        expect(switchMap.get('media-cache-size')).toBe(String(25 * 1024 * 1024));
        expect(switchMap.get('renderer-process-limit')).toBe('2');
        expect(switchMap.has('force-gpu-mem-available-mb')).toBe(false);
        expect(switchMap.get('disable-features')).toContain('SpareRendererForSitePerProcess');
        expect(switchMap.get('disable-features')).toContain('BackForwardCache');

        // 1b. Verify createMainWindow webPreferences at runtime
        await mainHarness.triggerReady();
        const mainWin = mainHarness.createdWindows[0];
        expect(mainWin.options.webPreferences.spellcheck).toBe(false);
        expect(mainWin.options.webPreferences.backgroundThrottling).toBe(true);

        // 1c. Verify 15s TTL caching on scan:steam-achievements IPC handler (2nd call hits in-memory TTL cache without re-reading disk)
        const readdirSpy = vi.spyOn(fs.promises, 'readdir').mockResolvedValue([] as any);
        try {
          await mainHarness.invokeIpc('scan:steam-achievements');
          const callsAfterFirst = readdirSpy.mock.calls.length;
          expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

          await mainHarness.invokeIpc('scan:steam-achievements');
          expect(readdirSpy.mock.calls.length).toBe(callsAfterFirst);
        } finally {
          readdirSpy.mockRestore();
        }

        // 1d. Verify perf:trim-memory IPC & preload bridge behaviorally
        let diskCacheCleared = 0;
        mainWin.webContents.session.clearCache = async () => {
          diskCacheCleared++;
        };
        const engineTrimSpy = vi.spyOn(launcherEngine, 'trimLauncherEngineMemory');
        const storeTrimSpy = vi.spyOn(storeSync, 'trimStoreSyncMemory');
        try {
          const trimRes = await mainHarness.invokeIpc('perf:trim-memory', { clearDiskCache: true });
          expect(trimRes).toEqual({ success: true });
          expect(diskCacheCleared).toBe(1);
          expect(engineTrimSpy).toHaveBeenCalled();
          expect(storeTrimSpy).toHaveBeenCalled();
        } finally {
          engineTrimSpy.mockRestore();
          storeTrimSpy.mockRestore();
        }

        const prevGc = (globalThis as any).gc;
        const gcSpy = vi.fn();
        (globalThis as any).gc = gcSpy;
        try {
          await preload.api.trimMemory({ passive: false });
          expect(gcSpy).toHaveBeenCalledTimes(1);
          expect(preload.clearCacheCalls).toBe(1);
          expect(preload.invoked.some((i) => i.channel === 'perf:trim-memory')).toBe(true);
        } finally {
          (globalThis as any).gc = prevGc;
        }
      } finally {
        mainHarness.dispose();
      }
    });

    it('evicts raw steamAppInfoCache Buffer via launcherEngine.trimLauncherEngineMemory() while retaining appIndex/strings and re-reading only the target byte slice on demand', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onelauncher-appinfo-slice-'));
      try {
        const steamRoot = path.join(tempDir, 'Steam');
        const appcacheDir = path.join(steamRoot, 'appcache');
        const commonDir = path.join(steamRoot, 'steamapps', 'common');
        const game400Dir = path.join(commonDir, 'Portal');
        const game620Dir = path.join(commonDir, 'Portal 2');
        fs.mkdirSync(appcacheDir, { recursive: true });
        fs.mkdirSync(game400Dir, { recursive: true });
        fs.mkdirSync(game620Dir, { recursive: true });

        const exe400 = path.join(game400Dir, 'hl2.exe');
        const exe620 = path.join(game620Dir, 'portal2.exe');
        fs.writeFileSync(exe400, 'MZ-portal-1');
        fs.writeFileSync(exe620, 'MZ-portal-2');

        const appinfoPath = path.join(appcacheDir, 'appinfo.vdf');
        const vdfBuf = buildBinarySteamAppInfoVdfV28([
          {
            appId: 400,
            executable: 'hl2.exe',
            arguments: '-game portal -steam',
            oslist: 'windows',
          },
          {
            appId: 620,
            executable: 'portal2.exe',
            arguments: '-game portal2 -novid',
            oslist: 'windows',
          },
        ]);
        fs.writeFileSync(appinfoPath, vdfBuf);

        launcherEngine.invalidateScanCaches();

        // 1. Resolve AppID 400 -> populates steamAppInfoCache with raw buf + appIndex for 400 and 620
        const spec400 = launcherEngine.resolveSteamAppInfoLaunchSpec(steamRoot, 400, game400Dir, {
          platform: 'win32',
        });
        expect(spec400).not.toBeNull();
        expect(spec400.executablePath).toBe(exe400);
        expect(spec400.launchArguments).toBe('-game portal -steam');

        const cacheEntry = launcherEngine.steamAppInfoCache.get(appinfoPath);
        expect(cacheEntry).toBeDefined();
        expect(Buffer.isBuffer(cacheEntry.buf)).toBe(true);
        expect(cacheEntry.appIndex.has(400)).toBe(true);
        expect(cacheEntry.appIndex.has(620)).toBe(true);

        // 2. Trim launcherEngine memory -> evicts raw Buffer (entry.buf === null) while retaining appIndex
        launcherEngine.trimLauncherEngineMemory();
        expect(cacheEntry.buf).toBeNull();
        expect(cacheEntry.appIndex.has(620)).toBe(true);

        // 3. Resolve uncached AppID 620 while entry.buf === null -> reads only AppID 620's byte slice from disk
        const spec620 = launcherEngine.resolveSteamAppInfoLaunchSpec(steamRoot, 620, game620Dir, {
          platform: 'win32',
        });
        expect(spec620).not.toBeNull();
        expect(spec620.executablePath).toBe(exe620);
        expect(spec620.launchArguments).toBe('-game portal2 -novid');
        // Verify full multi-megabyte buffer was NOT re-hydrated into memory
        expect(cacheEntry.buf).toBeNull();
      } finally {
        launcherEngine.invalidateScanCaches();
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('clears transient GOG/Epic sync maps and trims epicOfferMetadataCache to <= 100 entries via storeSync.trimStoreSyncMemory()', () => {
      storeSync.fetchGogOwnedGames.lastAchievementsMap = { 'gog-1': { totalCount: 10 } };
      storeSync.fetchGogOwnedGames.lastSuppressedItems = [{ id: 'sup-1' }];
      storeSync.fetchEpicOwnedGames.lastAchievementsMap = { 'epic-1': { totalCount: 5 } };
      storeSync.fetchEpicOwnedGames.lastSuppressedItems = [{ id: 'sup-2' }];

      storeSync.epicOfferMetadataCache.clear();
      for (let i = 1; i <= 135; i++) {
        storeSync.epicOfferMetadataCache.set(`ns-${i}:item-${i}`, {
          shortDescription: `Desc ${i}`,
        });
      }
      expect(storeSync.epicOfferMetadataCache.size).toBe(135);

      storeSync.trimStoreSyncMemory();

      expect(storeSync.fetchGogOwnedGames.lastAchievementsMap).toBeNull();
      expect(storeSync.fetchGogOwnedGames.lastSuppressedItems).toBeNull();
      expect(storeSync.fetchEpicOwnedGames.lastAchievementsMap).toBeNull();
      expect(storeSync.fetchEpicOwnedGames.lastSuppressedItems).toBeNull();
      expect(storeSync.epicOfferMetadataCache.size).toBe(100);
      expect(storeSync.epicOfferMetadataCache.has('ns-1:item-1')).toBe(false);
      expect(storeSync.epicOfferMetadataCache.has('ns-35:item-35')).toBe(false);
      expect(storeSync.epicOfferMetadataCache.has('ns-36:item-36')).toBe(true);
      expect(storeSync.epicOfferMetadataCache.has('ns-135:item-135')).toBe(true);
    });
  });

  // =========================================================================
  // 2. Catalog Persistence Coalescing, Compaction & In-Memory Fast Path
  // =========================================================================
  describe('2. Catalog Persistence Coalescing, Compaction & In-Memory Fast Path (integrationStorage.ts)', () => {
    it('serves loadCurrentCatalog() from in-memory cache with 0 JSON.parse or localStorage.setItem calls on repeated reads and supports skipSanitize + flushPendingCatalogSave()', () => {
      const sampleCatalog: CanonicalGame[] = [
        {
          id: 'steam-620',
          title: 'Portal 2',
          sortTitle: 'Portal 2',
          steamAppId: 620,
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'steam',
              platformGameId: '620',
              installed: true,
              playtimeMinutes: 120,
            },
          ],
          headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/header.jpg',
          capsuleImage:
            'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/library_600x900_2x.jpg',
          shortDescription: 'Portal 2 draws from the award-winning formula of innovative gameplay.',
          releaseDate: '2011',
          developers: ['Valve'],
          publishers: ['Valve'],
          genres: ['Puzzle'],
          tags: ['Puzzle'],
        },
      ];

      // Save catalog with skipSanitize: true and immediate write
      saveCurrentCatalog(sampleCatalog, { immediate: true, skipSanitize: true });
      flushPendingCatalogSave();

      // Warm up in-memory catalog cache
      const firstRead = loadCurrentCatalog();
      expect(firstRead.length).toBeGreaterThan(0);

      const parseSpy = vi.spyOn(JSON, 'parse');
      const setItemSpy = vi.spyOn(localStorage, 'setItem');

      try {
        for (let i = 0; i < 50; i++) {
          const cachedRead = loadCurrentCatalog();
          expect(cachedRead.length).toBe(firstRead.length);
          expect(cachedRead[0].id).toBe('steam-620');
        }

        // Zero JSON.parse or localStorage.setItem calls across 50 repeated reads!
        expect(parseSpy).toHaveBeenCalledTimes(0);
        expect(setItemSpy).toHaveBeenCalledTimes(0);
      } finally {
        parseSpy.mockRestore();
        setItemSpy.mockRestore();
      }
    });

    it('compacts bloated top-level & enrichedMetadata fields (caps screenshots at 12, movies at 4, descriptions at 12,000 chars, and deduplicates identical aboutTheGame) when persisting to localStorage', () => {
      const longHtmlDescription = 'A'.repeat(18_500);
      const bloatedScreenshots = Array.from({ length: 25 }, (_, idx) => ({
        id: idx + 1,
        pathThumbnail: `https://example.com/thumb-${idx + 1}.jpg`,
        pathFull: `https://example.com/full-${idx + 1}.jpg`,
      }));
      const bloatedMovies = Array.from({ length: 8 }, (_, idx) => ({
        id: idx + 1,
        name: `Trailer ${idx + 1}`,
        thumbnail: `https://example.com/movie-${idx + 1}.jpg`,
        hlsH264: `https://example.com/movie-${idx + 1}.m3u8`,
        highlight: true,
      }));

      const bloatedGame: CanonicalGame = {
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        sortTitle: 'Cyberpunk 2077',
        steamAppId: 1091500,
        isVerifiedEntitlement: true,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
          },
        ],
        headerImage: 'https://example.com/header.jpg',
        shortDescription: 'Short summary',
        detailedDescription: longHtmlDescription,
        aboutTheGame: longHtmlDescription, // Top-level duplicate of detailedDescription -> should deduplicate to ''
        screenshots: bloatedScreenshots, // Top-level screenshots -> should cap at 12
        movies: bloatedMovies, // Top-level movies -> should cap at 4
        developers: ['CD PROJEKT RED'],
        publishers: ['CD PROJEKT RED'],
        genres: ['RPG'],
        tags: ['Sci-Fi'],
        enrichedMetadata: {
          appId: 1091500,
          name: 'Cyberpunk 2077',
          shortDescription: 'Short summary',
          detailedDescription: longHtmlDescription,
          aboutTheGame: longHtmlDescription, // Identical to detailedDescription -> should deduplicate to ''
          headerImage: 'https://example.com/header.jpg',
          capsuleImage: 'https://example.com/capsule.jpg',
          developers: ['CD PROJEKT RED'],
          publishers: ['CD PROJEKT RED'],
          genres: ['RPG'],
          categories: ['Single-player'],
          screenshots: bloatedScreenshots,
          movies: bloatedMovies,
        },
      } as any;

      // Test saveCurrentCatalog followed by flushPendingCatalogSave()
      saveCurrentCatalog([bloatedGame], { skipSanitize: true });
      flushPendingCatalogSave();

      const rawJson = localStorage.getItem('universal_game_library_catalog');
      expect(rawJson).toBeTruthy();
      const persisted = JSON.parse(rawJson!) as any[];
      expect(persisted).toHaveLength(1);

      const savedGame = persisted[0];
      expect(savedGame.detailedDescription?.length).toBe(12_000);
      expect(savedGame.aboutTheGame).toBe('');
      expect(savedGame.screenshots).toHaveLength(12);
      expect(savedGame.movies).toHaveLength(4);
      expect(savedGame.enrichedMetadata?.detailedDescription?.length).toBe(12_000);
      expect(savedGame.enrichedMetadata?.aboutTheGame).toBe('');
      expect(savedGame.enrichedMetadata?.screenshots).toHaveLength(12);
      expect(savedGame.enrichedMetadata?.movies).toHaveLength(4);
    });
  });

  // =========================================================================
  // 3. Bounded In-Memory Caches (SteamApiService & CriticScoreService)
  // =========================================================================
  describe('3. Bounded In-Memory Caches (SteamApiService & CriticScoreService)', () => {
    it('caps SteamApiService metadataCache at 60 entries (MAX_METADATA_CACHE_SIZE = 60) and trims via trimMemoryCache(30)', () => {
      const api = new SteamApiService() as any;
      expect((SteamApiService as any).MAX_METADATA_CACHE_SIZE).toBe(60);
      expect((SteamApiService as any).MAX_METADATA_CACHE_ENTRIES).toBe(60);

      for (let i = 1; i <= 90; i++) {
        api.setCacheEntry(i, {
          appId: i,
          name: `Game ${i}`,
          shortDescription: `Description ${i}`,
          headerImage: '',
          capsuleImage: '',
          developers: [],
          publishers: [],
          genres: [],
          categories: [],
          screenshots: [],
          movies: [],
        });
      }

      // Must never exceed 60 entries
      expect(api.metadataCache.size).toBe(60);
      // Oldest 30 entries (1..30) were evicted; entry 31 is now oldest and 90 is newest
      expect(api.metadataCache.has(1)).toBe(false);
      expect(api.metadataCache.has(30)).toBe(false);
      expect(api.metadataCache.has(31)).toBe(true);
      expect(api.metadataCache.has(90)).toBe(true);

      // Trim down to 30 entries via default trimMemoryCache()
      api.trimMemoryCache();
      expect(api.metadataCache.size).toBe(30);
      expect(api.metadataCache.has(60)).toBe(false);
      expect(api.metadataCache.has(61)).toBe(true);
      expect(api.metadataCache.has(90)).toBe(true);

      // Also verify singleton steamApi exposes trimMemoryCache
      expect(typeof steamApi.trimMemoryCache).toBe('function');
    });

    it('caps CriticScoreService inMemoryCache at 1200 entries (MAX_IN_MEMORY_CACHE_SIZE = 1200) and evicts oldest entries down to 1000', () => {
      const svc = criticScoreService as any;
      const Ctor = svc.constructor;
      expect(Ctor.MAX_IN_MEMORY_CACHE_SIZE).toBe(1200);

      svc.inMemoryCache.clear();

      for (let i = 1; i <= 1201; i++) {
        svc.setInMemoryCache(`perf-test-game-${i}`, {
          score: 80,
          tier: 'Strong',
          source: 'metacritic',
        });
      }

      // Upon inserting the 1201st entry, oldest entries are evicted down to 1000
      expect(svc.inMemoryCache.size).toBe(1000);
      expect(svc.inMemoryCache.has('perf-test-game-1')).toBe(false);
      expect(svc.inMemoryCache.has('perf-test-game-201')).toBe(false);
      expect(svc.inMemoryCache.has('perf-test-game-202')).toBe(true);
      expect(svc.inMemoryCache.has('perf-test-game-1201')).toBe(true);
    });
  });

  // =========================================================================
  // 4. Grid Card 1x Cover Priority, Viewport Windowing & O(1) Shared Event Dispatch
  // =========================================================================
  describe('4. Grid Card 1x Cover Priority, Viewport Windowing & O(1) Shared Event Dispatch (LibraryGridView.tsx & LibrarySidebar.tsx)', () => {
    it('prioritizes 1x library_600x900.jpg (2.16 MB RGBA) before 2x library_600x900_2x.jpg (8.64 MB RGBA), appends h=480&resize=1 to Epic CDN covers, strips drop-shadow from StorefrontIcon, eliminates blur-3xl/drop-shadow/per-card backdrop-blur, and windows offscreen card <img> elements past index 28', () => {
      // Behaviorally verify StorefrontIcon strips drop-shadow classes from rendered SVG/wrapper
      const iconHtml = renderToString(
        React.createElement(StorefrontIcon, {
          storefrontId: 'steam',
          className: 'w-4 h-4 drop-shadow-md text-white',
        } as any)
      );
      expect(iconHtml).not.toContain('drop-shadow');
      expect(typeof notifyImageUnmounted).toBe('function');
      expect(typeof LibraryGridView).toBe('function');

      const gameWith2xCapsule: CanonicalGame = {
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        sortTitle: 'Cyberpunk 2077',
        steamAppId: 1091500,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1091500',
            installed: true,
          },
        ],
        headerImage:
          'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg',
        capsuleImage:
          'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/library_600x900_2x.jpg',
        shortDescription: 'An open-world action-adventure RPG set in Night City.',
        releaseDate: '2020',
        developers: ['CD PROJEKT RED'],
        publishers: ['CD PROJEKT RED'],
        genres: ['RPG'],
        tags: ['Cyberpunk'],
      };

      const candidates = getCoverCandidates(gameWith2xCapsule, null, null);
      expect(candidates.length).toBeGreaterThan(1);

      const first1xIdx = candidates.findIndex((u) => u.endsWith('/library_600x900.jpg'));
      const first2xIdx = candidates.findIndex((u) => u.endsWith('/library_600x900_2x.jpg'));
      expect(first1xIdx).toBe(0);
      expect(first2xIdx).toBeGreaterThan(first1xIdx);

      // Verify getCoverCandidates appends h=480&resize=1 to cdn1.epicgames.com cover URLs
      const epicGame: CanonicalGame = {
        id: 'epic-alan-wake-2',
        title: 'Alan Wake 2',
        sortTitle: 'Alan Wake 2',
        isExplicitNonSteam: true,
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'alan-wake-2',
            installed: false,
          },
        ],
        headerImage: 'https://cdn1.epicgames.com/offer/alan-wake-2/wide.jpg',
        capsuleImage: 'https://cdn1.epicgames.com/offer/alan-wake-2/EGS_AlanWake2_Tall_1200x1600.jpg',
        developers: ['Remedy'],
        publishers: ['Epic Games'],
        genres: ['Action'],
        tags: ['Horror'],
      };
      const epicCandidates = getCoverCandidates(epicGame, null, null);
      expect(epicCandidates[0]).toBe(
        'https://cdn1.epicgames.com/offer/alan-wake-2/EGS_AlanWake2_Tall_1200x1600.jpg?h=480&resize=1'
      );

      // Render LibraryGridView with 50 cards and verify:
      // - Cards 0..41 mount <img> immediately
      // - Cards 42..49 defer <img> mount until IntersectionObserver fires when IO is present
      const prevIO = (globalThis as any).IntersectionObserver;
      (globalThis as any).IntersectionObserver = class MockIntersectionObserver {
        observe() {}
        disconnect() {}
      };

      try {
        const fiftyGames: CanonicalGame[] = Array.from({ length: 50 }, (_, idx) => {
          const padded = String(idx).padStart(3, '0');
          return {
            ...gameWith2xCapsule,
            id: `steam-${1000 + idx}`,
            title: `Game ${padded}`,
            sortTitle: `Game ${padded}`,
            steamAppId: 1000 + idx,
            platforms: [
              {
                platformId: 'steam',
                platformGameId: String(1000 + idx),
                installed: true,
              },
            ],
            capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${1000 + idx}/library_600x900_2x.jpg`,
          };
        });

        const gridHtml = renderToString(
          React.createElement(LibraryGridView, {
            games: fiftyGames,
            onSelectGame: vi.fn(),
          })
        );

        expect(gridHtml).toContain('cv-card');
        expect(gridHtml).toContain('decoding="async"');
        expect(gridHtml).toContain('/1000/library_600x900.jpg');
        expect(gridHtml).toContain('/1027/library_600x900.jpg');
        // Card index 28 (steam-1028) is beyond the initial 28-card window and has not intersected yet
        expect(gridHtml).not.toContain('/1028/library_600x900.jpg');
        // Zero per-card GPU backdrop-blur-sm, blur-3xl, or drop-shadow layers across all 50 cards
        expect(gridHtml).not.toContain('backdrop-blur-sm');
        expect(gridHtml).not.toContain('blur-3xl');
        expect(gridHtml).not.toContain('drop-shadow');
        expect((gridHtml.match(/backdrop-blur/g) || []).length).toBeLessThanOrEqual(1);
      } finally {
        if (prevIO === undefined) {
          delete (globalThis as any).IntersectionObserver;
        } else {
          (globalThis as any).IntersectionObserver = prevIO;
        }
      }
    });

    it('mounts LibrarySidebar <img> thumbnails only within the visible scroll window (0..28 on initial render, omitting row 35), rewrites 2x Steam covers to 1x, and appends h=96&resize=1 to cdn1.epicgames.com thumbnails', () => {
      const fortySidebarGames: CanonicalGame[] = Array.from({ length: 40 }, (_, idx) => {
        const padded = String(idx).padStart(3, '0');
        if (idx === 0) {
          return {
            id: 'steam-620',
            title: `Game ${padded}`,
            sortTitle: `Game ${padded}`,
            steamAppId: 620,
            platforms: [
              {
                platformId: 'steam',
                platformGameId: '620',
                installed: true,
              },
            ],
            headerImage:
              'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/header.jpg',
            capsuleImage:
              'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/library_600x900_2x.jpg',
            developers: ['Valve'],
            publishers: ['Valve'],
            genres: ['Puzzle'],
            tags: ['Puzzle'],
          };
        }
        if (idx === 1) {
          return {
            id: 'epic-sidebar-1',
            title: `Game ${padded}`,
            sortTitle: `Game ${padded}`,
            platforms: [
              {
                platformId: 'epic',
                platformGameId: 'epic-app-1',
                installed: true,
              },
            ],
            headerImage: 'https://cdn1.epicgames.com/offer/ns/tall_cover_01.jpg',
            capsuleImage: 'https://cdn1.epicgames.com/offer/ns/tall_cover_01.jpg',
            developers: ['Epic'],
            publishers: ['Epic'],
            genres: ['Action'],
            tags: ['Action'],
          };
        }
        return {
          id: `steam-${2000 + idx}`,
          title: `Game ${padded}`,
          sortTitle: `Game ${padded}`,
          steamAppId: 2000 + idx,
          platforms: [
            {
              platformId: 'steam',
              platformGameId: String(2000 + idx),
              installed: false,
            },
          ],
          headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${2000 + idx}/header.jpg`,
          capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${2000 + idx}/library_600x900_2x.jpg`,
          developers: ['Studio'],
          publishers: ['Publisher'],
          genres: ['Action'],
          tags: ['Action'],
        };
      });

      const sidebarHtml = renderToString(
        React.createElement(LibrarySidebar, {
          games: fortySidebarGames,
          selectedGameId: 'steam-620',
          onSelectGame: vi.fn(),
          searchQuery: '',
          onSearchChange: vi.fn(),
          selectedPlatform: 'all',
          onSelectPlatform: vi.fn(),
          installedOnly: false,
          onToggleInstalledOnly: vi.fn(),
          collections: [],
          onOpenManageCollectionsModal: vi.fn(),
          onToggleGameInCollection: vi.fn(),
        })
      );

      // Row 0 (steam-620) rewrites 2x/1x portrait cover to tiny capsule_sm_120.jpg and mounts <img>
      expect(sidebarHtml).toContain('/620/capsule_sm_120.jpg');
      expect(sidebarHtml).not.toContain('/620/library_600x900_2x.jpg');
      // Row 1 (epic-sidebar-1) appends h=96&resize=1 to cdn1.epicgames.com thumbnail URL
      expect(sidebarHtml).toContain(
        'https://cdn1.epicgames.com/offer/ns/tall_cover_01.jpg?h=96&amp;resize=1'
      );
      // Row 28 (steam-2028) is inside initial 0..28 window -> mounts <img>
      expect(sidebarHtml).toContain('/2028/capsule_sm_120.jpg');
      // Row 35 (steam-2035) is outside initial 0..28 window -> omits <img> until scrolled near
      expect(sidebarHtml).toContain('Game 035');
      expect(sidebarHtml).not.toContain('/2035/capsule_sm_120.jpg');
      expect(sidebarHtml).toContain('decoding="async"');
      expect(sidebarHtml).toContain('loading="lazy"');
    });

    it('attaches at most 1 shared antigravity:steam-match-updated and 1 antigravity:gog-cover-updated window listener across 50 mounted cards and cleans up on unmount', () => {
      const addListenerSpy = vi.spyOn((globalThis as any).window, 'addEventListener');
      const removeListenerSpy = vi.spyOn((globalThis as any).window, 'removeEventListener');

      const cleanupFns: Array<() => void> = [];
      const internals =
        (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
        (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

      try {
        // Mount 50 GameCardCover instances and run their mount effects
        for (let i = 1; i <= 50; i++) {
          const cardGame: CanonicalGame = {
            id: `gog-perf-${i}`,
            title: `Performance Test Game ${i}`,
            sortTitle: `Performance Test Game ${i}`,
            platforms: [
              {
                platformId: 'gog',
                platformGameId: `${100000 + i}`,
                installed: false,
              },
            ],
            headerImage: `https://example.com/header-${i}.jpg`,
            capsuleImage: `https://images.gog-statics.com/cover-${i}.jpg`,
            developers: ['Studio'],
            publishers: ['Publisher'],
            genres: ['Action'],
            tags: ['Action'],
          };

          const prevH = internals.H;
          let effectIndex = 0;
          internals.H = {
            useState(initial: any) {
              return [typeof initial === 'function' ? initial() : initial, vi.fn()];
            },
            useEffect(fn: () => any) {
              const idx = effectIndex++;
              // Effect 0 in GameCardCover is subscribeToCoverUpdates
              if (idx === 0) {
                const cleanup = fn();
                if (typeof cleanup === 'function') {
                  cleanupFns.push(cleanup);
                }
              }
            },
            useRef(initial: any) {
              return { current: initial };
            },
            useMemo(fn: () => any) {
              return fn();
            },
            useCallback(fn: any) {
              return fn;
            },
          };
          try {
            const CoverFn = (GameCardCover as any).type || GameCardCover;
            CoverFn({ game: cardGame });
          } finally {
            internals.H = prevH;
          }
        }

        expect(cleanupFns).toHaveLength(50);

        const steamMatchAdds = addListenerSpy.mock.calls.filter(
          (c) => c[0] === 'antigravity:steam-match-updated'
        );
        const gogCoverAdds = addListenerSpy.mock.calls.filter(
          (c) => c[0] === 'antigravity:gog-cover-updated'
        );

        // Exactly 1 shared window listener per event type across all 50 cards (not 50 each!)
        expect(steamMatchAdds).toHaveLength(1);
        expect(gogCoverAdds).toHaveLength(1);

        // Unmount all 50 cards and verify shared listeners are removed when subscriber count hits 0
        for (const cleanup of cleanupFns) {
          cleanup();
        }

        const steamMatchRemoves = removeListenerSpy.mock.calls.filter(
          (c) => c[0] === 'antigravity:steam-match-updated'
        );
        const gogCoverRemoves = removeListenerSpy.mock.calls.filter(
          (c) => c[0] === 'antigravity:gog-cover-updated'
        );

        expect(steamMatchRemoves).toHaveLength(1);
        expect(gogCoverRemoves).toHaveLength(1);
      } finally {
        for (const cleanup of cleanupFns) {
          try {
            cleanup();
          } catch {}
        }
        addListenerSpy.mockRestore();
        removeListenerSpy.mockRestore();
      }
    });
  });

  // =========================================================================
  // 5. Code-Splitting, Dynamic hls.js & Bounded Preloading
  // =========================================================================
  describe('5. Code-Splitting, Dynamic hls.js & Bounded Preloading (App.tsx & MediaGallery.tsx)', () => {
    it('renders MediaGallery with fetchPriority="high" on active showcase image and fetchPriority="low" on strip thumbnails, and preloads at most [0, 1] screenshots', () => {
      const preloadedUrls: string[] = [];
      const prevImage = (globalThis as any).Image;
      (globalThis as any).Image = class MockPreloadImage {
        set src(val: string) {
          preloadedUrls.push(val);
        }
      };

      const screenshots = [0, 1, 2, 3].map((i) => ({
        id: i,
        pathThumbnail: `https://example.com/thumb-${i}.jpg`,
        pathFull: `https://example.com/full-${i}.jpg`,
      }));

      try {
        const galleryHtml = renderToString(
          React.createElement(MediaGallery, {
            screenshots,
            movies: [],
            headerImage: 'https://example.com/header.jpg',
          })
        );
        expect(galleryHtml.toLowerCase()).toContain('fetchpriority="high"');
        expect(galleryHtml.toLowerCase()).toContain('fetchpriority="low"');

        // Run MediaGallery's preload useEffect behaviorally and verify bounded [0, 1] window (<= 2 images, never all 4)
        const internals =
          (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
          (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
        const prevH = internals.H;
        internals.H = {
          useState(init: any) {
            return [typeof init === 'function' ? init() : init, vi.fn()];
          },
          useEffect(fn: () => any) {
            fn();
          },
          useRef(init: any) {
            return { current: init };
          },
          useMemo(fn: () => any) {
            return fn();
          },
          useCallback(fn: any) {
            return fn;
          },
        };
        try {
          (MediaGallery as any)({
            screenshots,
            movies: [],
            headerImage: 'https://example.com/header.jpg',
          });
        } finally {
          internals.H = prevH;
        }
        expect(preloadedUrls).toEqual([
          'https://example.com/thumb-0.jpg',
          'https://example.com/full-0.jpg',
          'https://example.com/thumb-1.jpg',
          'https://example.com/full-1.jpg',
        ]);
        expect(preloadedUrls).not.toContain('https://example.com/full-2.jpg');
        expect(preloadedUrls).not.toContain('https://example.com/full-3.jpg');
      } finally {
        (globalThis as any).Image = prevImage;
      }
    });

    it('lazy-loads modals/drawers in App via React.lazy Suspense boundaries', () => {
      const internals =
        (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
        (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
      const prevH = internals.H;
      const mockDispatcher = {
        useState(init: any) {
          return [typeof init === 'function' ? init() : init, vi.fn()];
        },
        useEffect() {},
        useLayoutEffect() {},
        useRef(init: any) {
          return { current: init };
        },
        useMemo(fn: () => any) {
          return fn();
        },
        useCallback(fn: any) {
          return fn;
        },
        useDeferredValue(val: any) {
          return val;
        },
        useTransition() {
          return [false, (fn: () => void) => fn()];
        },
        useContext(ctx: any) {
          return ctx._currentValue;
        },
        useId() {
          return 'id';
        },
      };

      let appVnode: any;
      internals.H = mockDispatcher;
      try {
        appVnode = (App as any)({});
      } finally {
        internals.H = prevH;
      }

      const lazyChildren: any[] = [];
      const walk = (node: any) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (node.type?.$$typeof === Symbol.for('react.lazy')) {
          lazyChildren.push(node);
        }
        if (node.props?.children) {
          walk(node.props.children);
        }
      };
      walk(appVnode);
      // On initial closed boot, zero lazy modal/drawer chunks are mounted or downloaded
      expect(lazyChildren.length).toBe(0);

      // When modal/drawer open flags (useState(false)) are true, all modals/drawers mount via React.lazy inside <Suspense>
      internals.H = {
        ...mockDispatcher,
        useState(init: any) {
          if (init === false) return [true, vi.fn()];
          return [typeof init === 'function' ? init() : init, vi.fn()];
        },
      };
      let openVnode: any;
      try {
        openVnode = (App as any)({});
      } finally {
        internals.H = prevH;
      }
      walk(openVnode);
      expect(lazyChildren.length).toBeGreaterThanOrEqual(6);
    });
  });
});
