import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

describe('Phase 4: Comprehensive Performance Optimization & Resource Footprint Verification Suite', () => {
  const repoRoot = path.resolve(__dirname, '..');

  beforeEach(() => {
    localStorage.clear();
  });

  // =========================================================================
  // 1. Electron Main Process Memory Hardening (electron/main.cjs)
  // =========================================================================
  describe('1. Electron Main Process Memory Hardening (electron/main.cjs)', () => {
    it('configures --max-old-space-size=512, CalculateNativeWinOcclusion, lightweight store:sync scraper BrowserWindow, 15s Steam VDF scan TTL, and perf:trim-memory IPC', () => {
      const mainCjsPath = path.join(repoRoot, 'electron/main.cjs');
      const preloadCjsPath = path.join(repoRoot, 'electron/preload.cjs');
      const mainSource = fs.readFileSync(mainCjsPath, 'utf8');
      const preloadSource = fs.readFileSync(preloadCjsPath, 'utf8');

      // 1a. V8 heap cap & Windows occlusion switch
      expect(mainSource).toContain("app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512')");
      expect(mainSource).toContain(
        "app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')"
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

      // 1d. perf:trim-memory IPC handler & preload bridge
      expect(mainSource).toContain("ipcMain.handle('perf:trim-memory'");
      expect(mainSource).toContain('mainWindow.webContents.session.clearCache()');
      expect(preloadSource).toContain("trimMemory: () => ipcRenderer.invoke('perf:trim-memory')");
    });
  });

  // =========================================================================
  // 2. Catalog Persistence Coalescing & In-Memory Fast Path
  // =========================================================================
  describe('2. Catalog Persistence Coalescing & In-Memory Fast Path (integrationStorage.ts)', () => {
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
  });

  // =========================================================================
  // 3. Bounded In-Memory Caches (SteamApiService & CriticScoreService)
  // =========================================================================
  describe('3. Bounded In-Memory Caches (SteamApiService & CriticScoreService)', () => {
    it('caps SteamApiService metadataCache at 150 entries (MAX_METADATA_CACHE_SIZE = 150) and trims via trimMemoryCache(50)', () => {
      const api = new SteamApiService() as any;
      expect((SteamApiService as any).MAX_METADATA_CACHE_SIZE).toBe(150);

      for (let i = 1; i <= 210; i++) {
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

      // Must never exceed 150 entries
      expect(api.metadataCache.size).toBe(150);
      // Oldest 60 entries (1..60) were evicted; entry 61 is now oldest and 210 is newest
      expect(api.metadataCache.has(1)).toBe(false);
      expect(api.metadataCache.has(60)).toBe(false);
      expect(api.metadataCache.has(61)).toBe(true);
      expect(api.metadataCache.has(210)).toBe(true);

      // Trim down to 50 entries via trimMemoryCache(50)
      api.trimMemoryCache(50);
      expect(api.metadataCache.size).toBe(50);
      expect(api.metadataCache.has(160)).toBe(false);
      expect(api.metadataCache.has(161)).toBe(true);
      expect(api.metadataCache.has(210)).toBe(true);

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
  // 4. Grid Card 1x Cover Priority & O(1) Shared Event Dispatch
  // =========================================================================
  describe('4. Grid Card 1x Cover Priority & O(1) Shared Event Dispatch (LibraryGridView.tsx)', () => {
    it('prioritizes 1x library_600x900.jpg (2.16 MB RGBA) before 2x library_600x900_2x.jpg (8.64 MB RGBA) and renders .cv-card with decoding="async"', () => {
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

      // Render LibraryGridView and verify .cv-card + decoding="async" + 1x cover src
      const gridHtml = renderToString(
        React.createElement(LibraryGridView, {
          games: [gameWith2xCapsule],
          onSelectGame: vi.fn(),
        })
      );

      expect(gridHtml).toContain('cv-card');
      expect(gridHtml).toContain('decoding="async"');
      expect(gridHtml).toContain('/1091500/library_600x900.jpg');
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
