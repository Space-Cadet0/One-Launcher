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
} from '../src/components/Library/LibraryGridView';
import { LibrarySidebar } from '../src/components/Library/LibrarySidebar';

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
    it('configures --max-old-space-size=384, Chromium disk/media/GPU cache caps, renderer-process-limit, lightweight store:sync scraper BrowserWindow, 15s Steam VDF scan TTL, and perf:trim-memory IPC', () => {
      const mainCjsPath = path.join(repoRoot, 'electron/main.cjs');
      const preloadCjsPath = path.join(repoRoot, 'electron/preload.cjs');
      const mainSource = fs.readFileSync(mainCjsPath, 'utf8');
      const preloadSource = fs.readFileSync(preloadCjsPath, 'utf8');

      // 1a. V8 heap cap (384 MB), Chromium disk/media/GPU shader cache bounds, renderer process limit, and feature flags
      expect(mainSource).toContain("app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384')");
      expect(mainSource).toContain("app.commandLine.appendSwitch('disk-cache-size', String(50 * 1024 * 1024))");
      expect(mainSource).toContain("app.commandLine.appendSwitch('media-cache-size', String(25 * 1024 * 1024))");
      expect(mainSource).toContain("app.commandLine.appendSwitch('gpu-program-cache-size-kb', '4096')");
      expect(mainSource).toContain("app.commandLine.appendSwitch('renderer-process-limit', '2')");
      expect(mainSource).toContain(
        'CalculateNativeWinOcclusion,SpareRendererForSitePerProcess,BackForwardCache'
      );

      // 1b. Hidden store:sync scraper BrowserWindow lightweight webPreferences + destroyScraperWindowCleanly
      expect(mainSource).toContain('images: false');
      expect(mainSource).toContain('spellcheck: false');
      expect(mainSource).toContain('backgroundThrottling: true');
      expect(mainSource).toContain("v8CacheOptions: 'none'");
      expect(mainSource).toContain('storeSync.destroyScraperWindowCleanly(bgWin)');

      // 1c. 15s TTL caching (STEAM_LOCAL_SCAN_TTL_MS = 15000) for local Steam VDF & achievements scans
      expect(mainSource).toContain('const STEAM_LOCAL_SCAN_TTL_MS = 15000');
      expect(mainSource).toContain('Date.now() - cachedLocalSteamPlaytimesAt < STEAM_LOCAL_SCAN_TTL_MS');
      expect(mainSource).toContain(
        'Date.now() - cachedLocalSteamAchievementsAt < STEAM_LOCAL_SCAN_TTL_MS'
      );

      // 1d. perf:trim-memory IPC handler & preload webFrame.clearCache() bridge
      expect(mainSource).toContain("ipcMain.handle('perf:trim-memory'");
      expect(mainSource).toContain('mainWindow.webContents.session.clearCache()');
      expect(mainSource).toContain('launcherEngine.trimLauncherEngineMemory?.()');
      expect(mainSource).toContain('storeSync.trimStoreSyncMemory?.()');
      expect(preloadSource).toContain('webFrame?.clearCache?.()');
      expect(preloadSource).toContain("ipcRenderer.invoke('perf:trim-memory')");
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

    it('compacts bloated enrichedMetadata (caps screenshots at 12, movies at 4, descriptions at 12,000 chars, and deduplicates identical aboutTheGame) when persisting to localStorage', () => {
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
      };

      // Test saveCurrentCatalog followed by flushPendingCatalogSave()
      saveCurrentCatalog([bloatedGame], { skipSanitize: true });
      flushPendingCatalogSave();

      const rawJson = localStorage.getItem('universal_game_library_catalog');
      expect(rawJson).toBeTruthy();
      const persisted = JSON.parse(rawJson!) as CanonicalGame[];
      expect(persisted).toHaveLength(1);

      const savedGame = persisted[0];
      expect(savedGame.detailedDescription?.length).toBe(12_000);
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
    it('prioritizes 1x library_600x900.jpg (2.16 MB RGBA) before 2x library_600x900_2x.jpg (8.64 MB RGBA), eliminates per-card backdrop-blur, and windows offscreen card <img> elements past index 42', () => {
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
        expect(gridHtml).toContain('/1041/library_600x900.jpg');
        // Card index 42 (steam-1042) is beyond the initial 42-card window and has not intersected yet
        expect(gridHtml).not.toContain('/1042/library_600x900.jpg');
        // Zero per-card GPU backdrop-blur-sm layers across all 50 cards (only the single sticky header uses backdrop-blur-md)
        expect(gridHtml).not.toContain('backdrop-blur-sm');
        expect((gridHtml.match(/backdrop-blur/g) || []).length).toBeLessThanOrEqual(1);
      } finally {
        if (prevIO === undefined) {
          delete (globalThis as any).IntersectionObserver;
        } else {
          (globalThis as any).IntersectionObserver = prevIO;
        }
      }
    });

    it('rewrites library_600x900_2x.jpg to 1x library_600x900.jpg and uses decoding="async" + loading="lazy" in LibrarySidebar thumbnails', () => {
      const sidebarGame: CanonicalGame = {
        id: 'steam-620',
        title: 'Portal 2',
        sortTitle: 'Portal 2',
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

      const sidebarHtml = renderToString(
        React.createElement(LibrarySidebar, {
          games: [sidebarGame],
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

      expect(sidebarHtml).toContain('/620/library_600x900.jpg');
      expect(sidebarHtml).not.toContain('/620/library_600x900_2x.jpg');
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
  describe('5. Code-Splitting, Dynamic hls.js & Bounded Preloading (App.tsx, MediaGallery.tsx, index.css)', () => {
    it('uses dynamic import("hls.js") in MediaGallery.tsx, bounds screenshot preloading to [0, 1], and sets fetchPriority attributes', () => {
      const mediaGalleryPath = path.join(
        repoRoot,
        'src/components/SteamStoreDetail/MediaGallery.tsx'
      );
      const source = fs.readFileSync(mediaGalleryPath, 'utf8');

      // Type-only import at top, dynamic import('hls.js') inside VideoPlayer useEffect
      expect(source).toContain("import type Hls from 'hls.js'");
      expect(source).not.toMatch(/^import\s+Hls\s+from\s+['"]hls\.js['"]/m);
      expect(source).toContain("await import('hls.js')");

      // Bounded screenshot preloading to [0, 1] (never [-1, 0, 1, 2])
      expect(source).toContain('for (const offset of [0, 1])');
      expect(source).not.toContain('[-1, 0, 1, 2]');

      // Explicit fetchPriority="high" on active showcase image and fetchPriority="low" on strip thumbnails
      expect(source).toContain('fetchPriority="high"');
      expect(source).toContain('fetchPriority="low"');
    });

    it('lazy-loads all 6 heavy modals/drawers in App.tsx via React.lazy and defines content-visibility rules in src/index.css', () => {
      const appPath = path.join(repoRoot, 'src/App.tsx');
      const cssPath = path.join(repoRoot, 'src/index.css');
      const appSource = fs.readFileSync(appPath, 'utf8');
      const cssSource = fs.readFileSync(cssPath, 'utf8');

      // All 6 modals/drawers lazy-loaded via lazy(() => import(...))
      expect(appSource).toContain("import('./components/Library/ManageCollectionsModal')");
      expect(appSource).toContain("import('./components/Navigation/IntegrationsModal')");
      expect(appSource).toContain("import('./components/Library/FixMatchWizardModal')");
      expect(appSource).toContain("import('./components/Library/LibraryMatchManagerModal')");
      expect(appSource).toContain("import('./components/Achievements/GameAchievementsModal')");
      expect(appSource).toContain("import('./components/Launcher/DownloadManagerDrawer')");

      // CSS content-visibility containment utilities
      expect(cssSource).toContain('.cv-card');
      expect(cssSource).toContain('.cv-sidebar-row');
      expect(cssSource).toContain('.cv-section');
      expect(cssSource).toContain('content-visibility: auto;');
    });
  });
});
