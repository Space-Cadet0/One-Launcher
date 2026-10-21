import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CanonicalGame } from '../src/contracts/game';
import type { StorefrontIntegration } from '../src/contracts/integration';
import { dispatchAppEvent, subscribeAppEvent } from '../src/contracts/events';
import { fallbackMetadataProvider } from '../src/services/steam/fallbackMetadataProvider';
import {
  isNonGameCatalogEntry,
  isEpicNonGameEntry,
  isUnmappedEpicInternalCodename,
  sanitizeGameCatalog,
} from '../src/services/integrations/catalogSanitizer';
import {
  getKnownSteamAchievements,
  getKnownEpicAchievements,
  getKnownGogAchievements,
  cacheUserSteamAchievements,
  cacheUserEpicAchievements,
  cacheUserGogAchievements,
} from '../src/services/storage/knownGameAchievements';
import {
  saveCurrentCatalog,
  loadCurrentCatalog,
  flushPendingCatalogSave,
  saveIntegrations,
  clearIntegrationStorage,
  mergeStorefrontGames,
} from '../src/services/integrations/integrationStorage';
import { saveUserOverride } from '../src/services/storage/userOverrideStorage';
import { AchievementDetailService } from '../src/services/achievements/achievementDetailService';
import { SteamApiService } from '../src/services/steam/steamApi';
import { criticScoreService } from '../src/services/critic/criticScoreService';
import { storefrontReviewHarvester } from '../src/services/critic/storefrontReviewHarvester';
import {
  saveStagedCache,
  clearExpiredStagedCache,
  STAGED_CACHE_PREFIX,
} from '../src/services/storage/stagedCacheService';
import { loadCollections, saveCollections } from '../src/services/storage/collectionStorage';
import {
  getNativeOsPlatforms,
  getStorefrontNativeOsFlags,
  saveCachedGogOsSupport,
  getCachedGogOsSupport,
} from '../src/services/platform/nativeOsService';
import { launcherService } from '../src/services/launcher/launcherService';

// CJS Electron modules for main-process verification
// eslint-disable-next-line @typescript-eslint/no-var-requires
const storeSync = require('../electron/storeSync.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const launcherEngine = require('../electron/launcherEngine.cjs');

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
  // Re-attach criticScoreService listeners in headless environment
  criticScoreService.initEventListeners();
} else if (!(globalThis as any).window.localStorage) {
  (globalThis as any).window.localStorage = mockStorage;
}

function collectSourceFiles(dirPath: string, exts = ['.ts', '.tsx', '.js', '.cjs']): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dirPath)) return results;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      results.push(...collectSourceFiles(fullPath, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('9-Dimension Audit Regression Suite (macOS ARM64 & Windows x64)', () => {
  const repoRoot = path.resolve(__dirname, '..');

  beforeEach(() => {
    localStorage.clear();
    clearIntegrationStorage();
  });

  // =========================================================================
  // Dimension 1: De-Hacking & Universal Portability
  // =========================================================================
  describe('Dimension 1: De-Hacking & Universal Portability', () => {
    it('confirms zero hardcoded game-specific strings or personal user paths across src/ and electron/', () => {
      const sourceFiles = [
        ...collectSourceFiles(path.join(repoRoot, 'src')),
        ...collectSourceFiles(path.join(repoRoot, 'electron')),
      ];
      expect(sourceFiles.length).toBeGreaterThan(20);

      const forbiddenGameStrings = [
        'survival instinct',
        'terminal reality',
        'killingfloor2beta',
      ];
      // Match /Users/<username>/ (excluding /Users/Shared/ which is standard macOS shared storage)
      const macPersonalPathRe = /\/Users\/(?!Shared\b)[A-Za-z0-9._-]+\//;
      // Match C:\Users\<username>\
      const winPersonalPathRe = /C:\\+Users\\+[A-Za-z0-9._-]+\\+/i;

      for (const filePath of sourceFiles) {
        const content = fs.readFileSync(filePath, 'utf8');
        const lower = content.toLowerCase();
        const relPath = path.relative(repoRoot, filePath);

        for (const forbidden of forbiddenGameStrings) {
          expect(lower, `Forbidden game-specific string "${forbidden}" in ${relPath}`).not.toContain(
            forbidden
          );
        }
        expect(macPersonalPathRe.test(content), `Hardcoded macOS user path in ${relPath}`).toBe(
          false
        );
        expect(winPersonalPathRe.test(content), `Hardcoded Windows user path in ${relPath}`).toBe(
          false
        );
      }
    });

    it('never fabricates reviewScore: 8 / totalReviews: 100 / positivePercent: 80 in fallbackMetadataProvider when OpenCritic data is unavailable', async () => {
      const unknownGame: CanonicalGame = {
        id: 'custom-unrated-indie-999999',
        title: 'Unrated Mystery Prototype 999999',
        sortTitle: 'Unrated Mystery Prototype 999999',
        platforms: [
          {
            platformId: 'custom',
            platformGameId: 'unrated-999999',
            installed: true,
          },
        ],
        headerImage: '',
        capsuleImage: '',
        developers: ['Indie Studio'],
        publishers: ['Indie Studio'],
        genres: ['Adventure'],
        tags: ['Indie'],
      };

      const metadata = await fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(
        unknownGame
      );
      expect(metadata.reviewSummary).toBeDefined();
      expect(metadata.reviewSummary?.reviewScore).toBe(0);
      expect(metadata.reviewSummary?.totalReviews).toBe(0);
      expect(metadata.reviewSummary?.positivePercent).toBe(0);
      expect(metadata.reviewSummary?.reviewScoreDesc).toBe('No user reviews');
    });

    it('suppresses generic <title>beta entries in catalogSanitizer while preserving legitimate short single-word titles (Prey, Control, Inside)', () => {
      const kf2Beta: CanonicalGame = {
        id: 'epic-kf2beta',
        title: 'killingfloor2beta',
        sortTitle: 'killingfloor2beta',
        platforms: [{ platformId: 'epic', platformGameId: 'kf2beta', installed: false }],
        headerImage: '',
        capsuleImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };
      const payday3Beta: CanonicalGame = {
        id: 'steam-payday3beta',
        title: 'payday3beta',
        sortTitle: 'payday3beta',
        platforms: [{ platformId: 'steam', platformGameId: '999991', installed: false }],
        headerImage: '',
        capsuleImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      expect(isNonGameCatalogEntry(kf2Beta)).toBe(true);
      expect(isNonGameCatalogEntry(payday3Beta)).toBe(true);
      expect(isEpicNonGameEntry(kf2Beta)).toBe(true);

      const legitimateTitles = ['Prey', 'Control', 'Inside'];
      for (const title of legitimateTitles) {
        const game: CanonicalGame = {
          id: `epic-${title.toLowerCase()}`,
          title,
          sortTitle: title,
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'epic',
              platformGameId: `${title.toLowerCase()}-id`,
              installed: true,
            },
          ],
          headerImage: 'https://example.com/header.jpg',
          capsuleImage: 'https://example.com/cover.jpg',
          developers: ['Studio'],
          publishers: ['Publisher'],
          genres: ['Action'],
          tags: ['Action'],
        };

        expect(isNonGameCatalogEntry(game)).toBe(false);
        expect(isUnmappedEpicInternalCodename(game)).toBe(false);
        expect(isEpicNonGameEntry(game)).toBe(false);
      }

      const sanitized = sanitizeGameCatalog([
        kf2Beta,
        payday3Beta,
        {
          id: 'epic-prey',
          title: 'Prey',
          sortTitle: 'Prey',
          isVerifiedEntitlement: true,
          platforms: [{ platformId: 'epic', platformGameId: 'prey-id', installed: true }],
          headerImage: 'https://example.com/prey.jpg',
          capsuleImage: 'https://example.com/prey-cover.jpg',
          developers: ['Arkane Studios'],
          publishers: ['Bethesda Softworks'],
          genres: ['Action'],
          tags: ['Sci-Fi'],
        },
      ]);
      expect(sanitized.map((g) => g.title)).toEqual(['Prey']);
    });

    it('auto-discovers locally installed Steam, GOG, and Epic games in App.tsx syncLocalInstallations without gating on OAuth connection status', () => {
      const appSource = fs.readFileSync(path.join(repoRoot, 'src/App.tsx'), 'utf8');
      const syncBlockStart = appSource.indexOf('async function syncLocalInstallations()');
      expect(syncBlockStart).toBeGreaterThan(0);
      const syncBlock = appSource.slice(syncBlockStart, syncBlockStart + 15000);

      // Must support steam, gog, and epic local auto-discovery without an isSteamConnected gate
      expect(syncBlock).toContain("if (platId === 'steam')");
      expect(syncBlock).toContain("else if (platId === 'gog' || platId === 'epic')");
      expect(syncBlock).not.toContain('if (isSteamConnected)');
      expect(syncBlock).not.toContain("item.platformId !== 'steam'");
    });
  });

  // =========================================================================
  // Dimension 2: Performance & Responsiveness
  // =========================================================================
  describe('Dimension 2: Performance & Responsiveness', () => {
    it('filters launcherService.subscribe notifications in LibraryGridView.tsx by running+installed signature (getLauncherGridSignature) and uses stable key={game.id}', () => {
      const gridSource = fs.readFileSync(
        path.join(repoRoot, 'src/components/Library/LibraryGridView.tsx'),
        'utf8'
      );

      expect(gridSource).toContain('const getLauncherGridSignature = () =>');
      expect(gridSource).toContain('const nextSig = getLauncherGridSignature()');
      expect(gridSource).toContain('if (nextSig !== prevSig)');
      expect(gridSource).toContain('key={game.id}');
    });

    it('caches parsed achievement maps in memory in knownGameAchievements.ts (O(1) repeated lookups without JSON.parse) until invalidated by cacheUser*Achievements', () => {
      cacheUserSteamAchievements({
        620: { unlocked: 15, total: 51, percentage: 29 },
      });
      cacheUserEpicAchievements({
        'epic-alan-wake-2': { unlocked: 10, total: 66, percentage: 15 },
      });
      cacheUserGogAchievements({
        '1207658924': { unlocked: 8, total: 20, percentage: 40 },
      });

      // Warm up caches with initial lookup
      expect(getKnownSteamAchievements(620, 'Portal 2')?.unlocked).toBe(15);
      expect(getKnownEpicAchievements('epic-alan-wake-2', 'Alan Wake 2')?.unlocked).toBe(10);
      expect(getKnownGogAchievements('1207658924', 'The Witcher 3')?.unlocked).toBe(8);

      const parseSpy = vi.spyOn(JSON, 'parse');
      try {
        for (let i = 0; i < 40; i++) {
          expect(getKnownSteamAchievements(620, 'Portal 2')?.unlocked).toBe(15);
          expect(getKnownEpicAchievements('epic-alan-wake-2', 'Alan Wake 2')?.unlocked).toBe(10);
          expect(getKnownGogAchievements('1207658924', 'The Witcher 3')?.unlocked).toBe(8);
        }
        // Zero JSON.parse calls across 120 repeated lookups!
        expect(parseSpy).toHaveBeenCalledTimes(0);
      } finally {
        parseSpy.mockRestore();
      }

      // Updating cache invalidates in-memory ref and reflects new unlocked counts immediately
      cacheUserSteamAchievements({
        620: { unlocked: 25, total: 51, percentage: 49 },
      });
      expect(getKnownSteamAchievements(620, 'Portal 2')?.unlocked).toBe(25);
    });

    it('updates inMemoryCatalogCache in O(1) when saveCurrentCatalog is called with skipSanitize: true and applies user overrides on flushPendingCatalogSave()', () => {
      const games: CanonicalGame[] = [
        {
          id: 'steam-400',
          title: 'Portal',
          sortTitle: 'Portal',
          steamAppId: 400,
          isVerifiedEntitlement: true,
          platforms: [{ platformId: 'steam', platformGameId: '400', installed: true }],
          headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/400/header.jpg',
          capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/400/library_600x900.jpg',
          developers: ['Valve'],
          publishers: ['Valve'],
          genres: ['Puzzle'],
          tags: ['Portal'],
        },
      ];

      saveUserOverride({
        gameId: 'steam-400',
        title: 'Portal (Director Override)',
        updatedAt: new Date().toISOString(),
      });

      const origVitest = process.env.VITEST;
      const origNodeEnv = process.env.NODE_ENV;
      try {
        // Simulate production non-immediate mode to verify deferred O(1) path + flushPendingCatalogSave()
        delete process.env.VITEST;
        process.env.NODE_ENV = 'production';

        saveCurrentCatalog(games, { skipSanitize: true, immediate: false });
        // Flush pending catalog save and verify user override was applied before persisting
        flushPendingCatalogSave();

        const persistedRaw = localStorage.getItem('universal_game_library_catalog');
        expect(persistedRaw).toBeTruthy();
        const persisted = JSON.parse(persistedRaw!);
        expect(persisted[0].title).toBe('Portal (Director Override)');
      } finally {
        process.env.VITEST = origVitest;
        process.env.NODE_ENV = origNodeEnv;
      }
    });
  });

  // =========================================================================
  // Dimension 3: Memory Leak Prevention
  // =========================================================================
  describe('Dimension 3: Memory Leak Prevention', () => {
    it('caps AchievementDetailService inMemoryCache at <= 60 entries (LRU) and SteamApiService metadataCache at <= 60 entries', () => {
      const achSvc = new AchievementDetailService();
      expect(AchievementDetailService.MAX_MEMORY_CACHE_ENTRIES).toBe(60);

      for (let i = 1; i <= 85; i++) {
        achSvc.setCachedMultiStoreAchievements(`game-${i}`, {
          steam: {
            platformId: 'steam',
            totalCount: 10,
            unlockedCount: 5,
            achievements: [],
          },
        });
      }

      expect(achSvc.memoryCache.size).toBe(60);
      expect(achSvc.memoryCache.has('game-1')).toBe(false);
      expect(achSvc.memoryCache.has('game-25')).toBe(false);
      expect(achSvc.memoryCache.has('game-26')).toBe(true);
      expect(achSvc.memoryCache.has('game-85')).toBe(true);

      const steamSvc = new SteamApiService() as any;
      expect(SteamApiService.MAX_METADATA_CACHE_ENTRIES).toBe(60);
      expect(SteamApiService.MAX_METADATA_CACHE_SIZE).toBe(60);

      for (let i = 1; i <= 90; i++) {
        steamSvc.setCacheEntry(i, {
          appId: i,
          name: `App ${i}`,
          shortDescription: '',
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

      expect(steamSvc.metadataCache.size).toBe(60);
      expect(steamSvc.metadataCache.has(1)).toBe(false);
      expect(steamSvc.metadataCache.has(30)).toBe(false);
      expect(steamSvc.metadataCache.has(31)).toBe(true);
      expect(steamSvc.metadataCache.has(90)).toBe(true);
    });

    it('configures Hls in MediaGallery.tsx with bounded buffers (15/30/10) and cleans up via stopLoad(), detachMedia(), destroy()', () => {
      const mediaGallerySource = fs.readFileSync(
        path.join(repoRoot, 'src/components/SteamStoreDetail/MediaGallery.tsx'),
        'utf8'
      );

      expect(mediaGallerySource).toContain('maxBufferLength: 15');
      expect(mediaGallerySource).toContain('maxMaxBufferLength: 30');
      expect(mediaGallerySource).toContain('backBufferLength: 10');
      expect(mediaGallerySource).toContain('hlsInstance.stopLoad()');
      expect(mediaGallerySource).toContain('hlsInstance.detachMedia()');
      expect(mediaGallerySource).toContain('hlsInstance.destroy()');
    });

    it('cleans up hidden BrowserWindow instances in storeSync.destroyScraperWindowCleanly by removing listeners, clearing session cache, and destroying window', () => {
      const removeAllListeners = vi.fn();
      const clearCache = vi.fn().mockResolvedValue(undefined);
      const destroy = vi.fn();
      const close = vi.fn();

      const mockWin = {
        isDestroyed: () => false,
        webContents: {
          removeAllListeners,
          session: {
            clearCache,
          },
        },
        destroy,
        close,
      };

      storeSync.destroyScraperWindowCleanly(mockWin);

      expect(removeAllListeners).toHaveBeenCalledTimes(1);
      expect(clearCache).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Dimension 4: Concurrency & Race Condition Safety
  // =========================================================================
  describe('Dimension 4: Concurrency & Race Condition Safety', () => {
    it('coalesces concurrent renewGogTokens() and renewEpicTokens() calls via single-flight lock (inFlightTokenRenewals) and persists rotated GOG tokens', async () => {
      const storeSyncSource = fs.readFileSync(path.join(repoRoot, 'electron/storeSync.cjs'), 'utf8');
      expect(storeSyncSource).toContain('const inFlightTokenRenewals = new Map()');
      expect(storeSyncSource).toContain("saveTokens('gog', data)");
      expect(storeSyncSource).toContain("saveTokens('epic', data)");

      const origFetch = globalThis.fetch;
      let gogNetworkCalls = 0;
      let epicNetworkCalls = 0;

      globalThis.fetch = vi.fn(async (url: any) => {
        const urlStr = String(url);
        await new Promise((r) => setTimeout(r, 25));
        if (urlStr.includes('auth.gog.com/token')) {
          gogNetworkCalls++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'gog-rotated-access-token',
              refresh_token: 'gog-rotated-refresh-token',
              expires_in: 3600,
              user_id: 'gog-user-1',
            }),
          } as any;
        }
        if (urlStr.includes('epicgames.com/account/api/oauth/token')) {
          epicNetworkCalls++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'epic-rotated-access-token',
              refresh_token: 'epic-rotated-refresh-token',
              expires_in: 7200,
              account_id: 'epic-user-1',
            }),
          } as any;
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      try {
        const [gog1, gog2, gog3] = await Promise.all([
          storeSync.renewGogTokens('refresh-gog-123'),
          storeSync.renewGogTokens('refresh-gog-123'),
          storeSync.renewGogTokens('refresh-gog-123'),
        ]);

        expect(gogNetworkCalls).toBe(1);
        expect(gog1.access_token).toBe('gog-rotated-access-token');
        expect(gog2.access_token).toBe('gog-rotated-access-token');
        expect(gog3.access_token).toBe('gog-rotated-access-token');

        const [epic1, epic2, epic3] = await Promise.all([
          storeSync.renewEpicTokens('refresh-epic-456'),
          storeSync.renewEpicTokens('refresh-epic-456'),
          storeSync.renewEpicTokens('refresh-epic-456'),
        ]);

        expect(epicNetworkCalls).toBe(1);
        expect(epic1.access_token).toBe('epic-rotated-access-token');
        expect(epic2.access_token).toBe('epic-rotated-access-token');
        expect(epic3.access_token).toBe('epic-rotated-access-token');
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('does NOT clear storefrontReviewHarvester cache when hiding/unhiding a game, but DOES clear it on an actual score/metadata override', () => {
      const clearHarvesterSpy = vi.spyOn(storefrontReviewHarvester, 'clearCache');
      try {
        // 1. Hiding a game (no `override` property in detail)
        (globalThis as any).window.dispatchEvent(
          new CustomEvent('antigravity:user-override-updated', {
            detail: { gameId: 'steam_10', isHidden: true, hiddenGameId: 'steam_10' },
          })
        );
        expect(clearHarvesterSpy).toHaveBeenCalledTimes(0);

        // 2. Actual override object in detail
        (globalThis as any).window.dispatchEvent(
          new CustomEvent('antigravity:user-override-updated', {
            detail: {
              gameId: 'steam_10',
              override: {
                gameId: 'steam_10',
                title: 'Counter-Strike',
                criticScore: 88,
                updatedAt: new Date().toISOString(),
              },
            },
          })
        );
        expect(clearHarvesterSpy).toHaveBeenCalledTimes(1);
      } finally {
        clearHarvesterSpy.mockRestore();
      }
    });
  });

  // =========================================================================
  // Dimension 5: Storage & Disk Integrity
  // =========================================================================
  describe('Dimension 5: Storage & Disk Integrity', () => {
    it('writes files atomically via .tmp + fs.renameSync in launcherEngine.atomicWriteFileSync and storeSync.atomicWriteFileSync', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-atomic-test-'));
      try {
        const targetA = path.join(tmpDir, 'registry.json');
        const targetB = path.join(tmpDir, 'tokens.json');
        const payloadA = JSON.stringify({ installed: ['steam-620'] }, null, 2);
        const payloadB = JSON.stringify({ gog: { user_id: '12345' } }, null, 2);

        launcherEngine.atomicWriteFileSync(targetA, payloadA);
        storeSync.atomicWriteFileSync(targetB, payloadB);

        expect(fs.readFileSync(targetA, 'utf8')).toBe(payloadA);
        expect(fs.readFileSync(targetB, 'utf8')).toBe(payloadB);

        // Confirm no leftover .tmp files remain in directory
        const remainingTmp = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
        expect(remainingTmp).toEqual([]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('checks STAGED_CACHE_PREFIX in clearExpiredStagedCache() and never calls localStorage.getItem or JSON.parse on universal_game_library_catalog', () => {
      localStorage.setItem(
        'universal_game_library_catalog',
        JSON.stringify([{ id: 'steam-620', title: 'Portal 2' }])
      );
      // Add an expired staged cache entry
      saveStagedCache(`${STAGED_CACHE_PREFIX}expired_entry`, { score: 75 }, 'fresh', {
        cachedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
        customTtlMs: 1000,
      });

      const getItemSpy = vi.spyOn(localStorage, 'getItem');
      try {
        clearExpiredStagedCache();
        const catalogReads = getItemSpy.mock.calls.filter(
          (c) => c[0] === 'universal_game_library_catalog'
        );
        expect(catalogReads).toHaveLength(0);
        expect(localStorage.getItem(`${STAGED_CACHE_PREFIX}expired_entry`)).toBeNull();
        expect(localStorage.getItem('universal_game_library_catalog')).toBeTruthy();
      } finally {
        getItemSpy.mockRestore();
      }
    });

    it('recovers from QuotaExceededError in saveCurrentCatalog by pruning expired staged caches and detailed achievement caches before retrying', () => {
      localStorage.setItem(
        'antigravity_detailed_achievements_steam-620',
        JSON.stringify({ steam: { achievements: [] } })
      );
      saveStagedCache(`${STAGED_CACHE_PREFIX}expired_quota`, { score: 80 }, 'fresh', {
        cachedAt: Date.now() - 1000000,
        customTtlMs: 10,
      });

      const origSetItem = localStorage.setItem.bind(localStorage);
      let threwOnceForCatalog = false;
      const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation((k: string, v: string) => {
        if (k === 'universal_game_library_catalog' && !threwOnceForCatalog) {
          threwOnceForCatalog = true;
          const err = new Error('QuotaExceededError');
          err.name = 'QuotaExceededError';
          throw err;
        }
        return origSetItem(k, v);
      });

      try {
        const sampleGames: CanonicalGame[] = [
          {
            id: 'steam-620',
            title: 'Portal 2',
            sortTitle: 'Portal 2',
            steamAppId: 620,
            isVerifiedEntitlement: true,
            platforms: [{ platformId: 'steam', platformGameId: '620', installed: true }],
            headerImage: '',
            capsuleImage: '',
            developers: ['Valve'],
            publishers: ['Valve'],
            genres: ['Puzzle'],
            tags: ['Puzzle'],
          },
        ];

        saveCurrentCatalog(sampleGames, { immediate: true, skipSanitize: true });

        expect(threwOnceForCatalog).toBe(true);
        // Expendable detailed achievements cache and expired staged cache were pruned
        expect(localStorage.getItem('antigravity_detailed_achievements_steam-620')).toBeNull();
        expect(localStorage.getItem(`${STAGED_CACHE_PREFIX}expired_quota`)).toBeNull();
        // Retry succeeded and catalog was persisted
        expect(localStorage.getItem('universal_game_library_catalog')).toContain('Portal 2');
      } finally {
        setItemSpy.mockRestore();
      }
    });

    it('does not call localStorage.setItem in loadCollections() when stored collections are already sanitized', () => {
      const cleanCollections = [
        {
          id: 'favorites',
          name: 'Favorites',
          icon: 'star',
          isDefault: true,
          gameIds: ['steam-620'],
        },
      ];
      saveCollections(cleanCollections);

      const setItemSpy = vi.spyOn(localStorage, 'setItem');
      try {
        const loaded = loadCollections();
        expect(loaded).toEqual(cleanCollections);
        expect(setItemSpy).toHaveBeenCalledTimes(0);
      } finally {
        setItemSpy.mockRestore();
      }
    });
  });

  // =========================================================================
  // Dimension 6: Security & IPC Boundary Hardening
  // =========================================================================
  describe('Dimension 6: Security & IPC Boundary Hardening', () => {
    it('blocks dangerous URI schemes (file://, javascript:, data:, smb://, ms-msdt:) in openExternalUri and shell:open-external while permitting https:// and storefront protocols', async () => {
      const blockedUris = [
        'file:///System/Applications/Calculator.app',
        'file:///C:/Windows/System32/cmd.exe',
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'smb://attacker.example.com/share/payload.exe',
        'ms-msdt:/id PCWDiagnostic /skip force',
      ];

      for (const badUri of blockedUris) {
        const opened: string[] = [];
        const result = await launcherEngine.openExternalUri(badUri, {
          onOpenExternal: (u: string) => opened.push(u),
        });
        expect(result, `Expected ${badUri} to be blocked`).toBe(false);
        expect(opened).toHaveLength(0);
      }

      const allowedUris = [
        'https://store.steampowered.com/app/620',
        'steam://rungameid/620',
        'goggalaxy://openGameView/1207658924',
        'com.epicgames.launcher://apps/AlanWake2?action=launch&silent=true',
        'heroic://launch/epic/AlanWake2',
      ];

      for (const goodUri of allowedUris) {
        const opened: string[] = [];
        const result = await launcherEngine.openExternalUri(goodUri, {
          onOpenExternal: (u: string) => opened.push(u),
        });
        expect(result, `Expected ${goodUri} to be permitted`).toBe(true);
        expect(opened).toEqual([goodUri]);
      }

      // Also verify electron/main.cjs shell:open-external enforces the identical scheme allowlist
      const mainSource = fs.readFileSync(path.join(repoRoot, 'electron/main.cjs'), 'utf8');
      expect(mainSource).toContain("ipcMain.handle('shell:open-external'");
      expect(mainSource).toContain(
        '/^https?:\\/\\/|^steam:\\/\\/|^goggalaxy:\\/\\/|^com\\.epicgames\\.launcher:\\/\\/|^heroic:\\/\\//i'
      );
    });

    it('strips raw access_token, refresh_token, accessToken, and refreshToken secrets in saveIntegrations before writing to renderer localStorage', () => {
      const integrationsWithSecrets = [
        {
          storefrontId: 'gog',
          name: 'GOG.com',
          isConnected: true,
          gamesCount: 42,
          statusMessage: 'Connected',
          access_token: 'top-secret-top-level-access',
          refresh_token: 'top-secret-top-level-refresh',
          accessToken: 'top-secret-camel-access',
          refreshToken: 'top-secret-camel-refresh',
          credentials: {
            gogUsername: 'TestPlayer',
            access_token: 'nested-secret-access',
            refresh_token: 'nested-secret-refresh',
            accessToken: 'nested-camel-access',
            refreshToken: 'nested-camel-refresh',
          },
        },
      ] as unknown as StorefrontIntegration[];

      saveIntegrations(integrationsWithSecrets);

      const rawStored = localStorage.getItem('antigravity_storefront_integrations');
      expect(rawStored).toBeTruthy();
      expect(rawStored).not.toContain('top-secret-top-level-access');
      expect(rawStored).not.toContain('top-secret-top-level-refresh');
      expect(rawStored).not.toContain('top-secret-camel-access');
      expect(rawStored).not.toContain('top-secret-camel-refresh');
      expect(rawStored).not.toContain('nested-secret-access');
      expect(rawStored).not.toContain('nested-secret-refresh');
      expect(rawStored).not.toContain('nested-camel-access');
      expect(rawStored).not.toContain('nested-camel-refresh');

      const parsed = JSON.parse(rawStored!);
      expect(parsed[0].credentials.gogUsername).toBe('TestPlayer');
    });

    it('encrypts tokens.json with hardware-bound AES-256-GCM (_encrypted_v2) + 0o600 permissions without triggering macOS Keychain (safeStorage)', () => {
      const mainSource = fs.readFileSync(path.join(repoRoot, 'electron/main.cjs'), 'utf8');
      expect(mainSource).toContain("app.commandLine.appendSwitch('use-mock-keychain')");

      const storeSyncSource = fs.readFileSync(path.join(repoRoot, 'electron/storeSync.cjs'), 'utf8');
      expect(storeSyncSource).not.toContain('safeStorage.encryptString');
      expect(storeSyncSource).not.toContain('safeStorage.decryptString');
      expect(storeSyncSource).toContain('aes-256-gcm');

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-vault-test-'));
      const tokenFile = path.join(tmpDir, 'tokens.json');
      try {
        const sampleTokens = {
          gog: { access_token: 'gog-secret-123', refresh_token: 'gog-refresh-456', user_id: 'u1' },
          epic: { access_token: 'epic-secret-789', account_id: 'e1' },
        };

        storeSync.writeTokensFile(sampleTokens, {
          filePath: tokenFile,
          machineIdOverride: 'machine-alpha-uuid',
        });

        const onDiskRaw = fs.readFileSync(tokenFile, 'utf8');
        expect(onDiskRaw).not.toContain('gog-secret-123');
        expect(onDiskRaw).not.toContain('epic-secret-789');

        const onDiskParsed = JSON.parse(onDiskRaw);
        expect(onDiskParsed._encrypted_v2).toBe(true);
        expect(onDiskParsed.alg).toBe('aes-256-gcm');

        if (process.platform !== 'win32') {
          const mode = fs.statSync(tokenFile).mode & 0o777;
          expect(mode).toBe(0o600);
        }

        // Same machine decrypts cleanly
        const loadedSameMachine = storeSync.loadSavedTokens({
          filePath: tokenFile,
          machineIdOverride: 'machine-alpha-uuid',
        });
        expect(loadedSameMachine).toEqual(sampleTokens);

        // Different machine cannot decrypt the hardware-bound vault
        const loadedOtherMachine = storeSync.loadSavedTokens({
          filePath: tokenFile,
          machineIdOverride: 'machine-beta-uuid',
        });
        expect(loadedOtherMachine).toEqual({});
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // Dimension 7: Code & Type Hygiene — Typed Event Bus
  // =========================================================================
  describe('Dimension 7: Code & Type Hygiene — Typed Event Bus (src/contracts/events.ts)', () => {
    it('dispatches and receives strongly-typed custom events via dispatchAppEvent and subscribeAppEvent and unsubscribes cleanly', () => {
      const overrideEvents: any[] = [];
      const launcherEvents: any[] = [];

      const unsubOverride = subscribeAppEvent('antigravity:user-override-updated', (detail) => {
        overrideEvents.push(detail);
      });
      const unsubLauncher = subscribeAppEvent('antigravity:launcher-state-changed', (detail) => {
        launcherEvents.push(detail);
      });

      dispatchAppEvent('antigravity:user-override-updated', {
        gameId: 'steam-620',
        isHidden: true,
      });
      dispatchAppEvent('antigravity:launcher-state-changed', {
        reason: 'session-started',
        gameId: 'steam-620',
      });

      expect(overrideEvents).toEqual([{ gameId: 'steam-620', isHidden: true }]);
      expect(launcherEvents).toEqual([{ reason: 'session-started', gameId: 'steam-620' }]);

      unsubOverride();
      unsubLauncher();

      dispatchAppEvent('antigravity:user-override-updated', {
        gameId: 'steam-400',
        isHidden: false,
      });
      expect(overrideEvents).toHaveLength(1);
    });
  });

  // =========================================================================
  // Dimension 9A: macOS ARM64 & Windows x64 Platform Execution
  // =========================================================================
  describe('Dimension 9A: macOS ARM64 & Windows x64 Platform Execution', () => {
    it('macOS track: applyCrossOverPerGameSettings writes cxbottle.conf and user.reg atomically without synchronous Wine reg add spawns on default launch path, mountAndExtractDmgSafe detaches in finally, and darwin quarantine stripping is present', async () => {
      const tmpBottle = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cx-bottle-'));
      try {
        fs.writeFileSync(path.join(tmpBottle, 'cxbottle.conf'), '[Bottle]\n"Version" = "25.0"\n', 'utf8');
        fs.writeFileSync(path.join(tmpBottle, 'user.reg'), 'WINE REGISTRY Version 2\n', 'utf8');

        const env: Record<string, string> = {};
        launcherEngine.applyCrossOverPerGameSettings(
          { type: 'crossover', binaryPath: '/nonexistent/wine' },
          {
            crossoverGraphicsBackend: 'd3dmetal',
            crossoverSyncMode: 'msync',
            crossoverHighResolutionMode: true,
            crossoverDlss: true,
            metalHud: true,
          },
          env,
          tmpBottle,
          { homedir: tmpBottle }
        );

        const confContent = fs.readFileSync(path.join(tmpBottle, 'cxbottle.conf'), 'utf8');
        const regContent = fs.readFileSync(path.join(tmpBottle, 'user.reg'), 'utf8');

        expect(env.MTL_HUD_ENABLED).toBe('1');
        expect(confContent).toContain('[EnvironmentVariables]');
        expect(confContent).toContain('"CX_GRAPHICS_BACKEND" = "d3dmetal"');
        expect(confContent).toContain('"WINEMSYNC" = "1"');
        expect(confContent).toContain('"D3DM_ENABLE_METALFX" = "1"');
        expect(regContent).toContain('[Software\\\\Wine\\\\Mac Driver]');
        expect(regContent).toContain('"RetinaMode"="y"');
        expect(regContent).toContain('[Control Panel\\\\Desktop]');
        expect(regContent).toContain('"LogPixels"=dword:000000c0');
      } finally {
        fs.rmSync(tmpBottle, { recursive: true, force: true });
      }

      // Verify mountAndExtractDmgSafe always detaches in finally even when attach/copy throws
      const hdiutilCalls: string[][] = [];
      await expect(
        launcherEngine.mountAndExtractDmgSafe('/fake/archive.dmg', '/fake/dest', {
          onExecHdiutil: async (args: string[]) => {
            hdiutilCalls.push(args);
            if (args[0] === 'attach') {
              throw new Error('Simulated DMG mount error');
            }
          },
        })
      ).rejects.toThrow('Simulated DMG mount error');

      expect(hdiutilCalls.length).toBe(2);
      expect(hdiutilCalls[0][0]).toBe('attach');
      expect(hdiutilCalls[1][0]).toBe('detach');

      // Verify com.apple.quarantine stripping in findBundledOrSystemCliBinary on darwin
      const engineSource = fs.readFileSync(
        path.join(repoRoot, 'electron/launcherEngine.cjs'),
        'utf8'
      );
      expect(engineSource).toContain('const quarantineClearedBinaries = new Set()');
      expect(engineSource).toContain("execFileSync('xattr', ['-dr', 'com.apple.quarantine', found]");
    });

    it('Windows track: galaxy-2.0.db SQLite operations set PRAGMA busy_timeout = 5000 with zero execSync("sleep 0.1") spawns, reg.exe uses execFileSync array args, and session polling uses process.kill(pid, 0)', () => {
      const engineSource = fs.readFileSync(
        path.join(repoRoot, 'electron/launcherEngine.cjs'),
        'utf8'
      );

      // 1. SQLite PRAGMA busy_timeout = 5000 and zero shell sleep spawns
      expect(engineSource).toContain("db.exec('PRAGMA busy_timeout = 5000;')");
      expect(engineSource).not.toContain('sleep 0.1');

      // 2. Parameterized execFileSync('reg.exe', [...]) array calls (no string-concatenated reg.exe shell commands)
      expect(engineSource).toContain("'reg.exe'");
      expect(engineSource).toContain("['add', regKey, '/v', valName, '/t', 'REG_SZ', '/d', String(valData), '/f']");
      expect(engineSource).not.toMatch(/execSync\s*\(\s*[`'"]reg(?:\.exe)?\s+/i);

      // 3. Fast O(1) process.kill(trackedPid, 0) liveness check before spawning tasklist.exe / ps
      expect(engineSource).toContain('process.kill(trackedPid, 0)');
    });
  });

  // =========================================================================
  // Recent Changes 9-Dimension Audit Regression Suite (Per-Storefront OS, GOG Cache & Dual-Build Launch Switching)
  // =========================================================================
  describe('Recent Changes 9-Dimension Audit: Per-Storefront OS Preservation, GOG Cache, Heroic Legendary Discovery & Dual-Build Launch Switching', () => {
    it('1. mergeStorefrontGames & sanitizeGameCatalog Per-Storefront OS Preservation (Dimension 6): preserves platforms, storefrontAppId, namespace, and catalogItemId when updating or deduplicating', () => {
      // 1a. mergeStorefrontGames when hasPlatform === true
      const existingCatalog: CanonicalGame[] = [
        {
          id: 'epic-4656facc740742a39e265b026e13d075',
          title: '20 Minutes Till Dawn',
          sortTitle: '20 Minutes Till Dawn',
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'epic',
              platformGameId: '4656facc740742a39e265b026e13d075',
              installed: true,
              installPath: '/Games/20MinutesTillDawn',
            },
          ],
          headerImage: 'https://example.com/header.jpg',
          capsuleImage: 'https://example.com/cover.jpg',
          developers: ['flanne'],
          publishers: ['Erabit'],
          genres: ['Action'],
          tags: ['Action'],
        },
      ];

      const incomingEpicSync: CanonicalGame[] = [
        {
          id: 'epic-4656facc740742a39e265b026e13d075',
          title: '20 Minutes Till Dawn',
          sortTitle: '20 Minutes Till Dawn',
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'epic',
              platformGameId: '4656facc740742a39e265b026e13d075',
              storefrontAppId: '4656facc740742a39e265b026e13d075',
              namespace: 'ns-20mtd',
              catalogItemId: 'cat-20mtd',
              installed: false,
              platforms: { windows: true, mac: false },
            },
          ],
          headerImage: 'https://example.com/header.jpg',
          capsuleImage: 'https://example.com/cover.jpg',
          developers: ['flanne'],
          publishers: ['Erabit'],
          genres: ['Action'],
          tags: ['Action'],
        },
      ];

      const merged = mergeStorefrontGames(existingCatalog, incomingEpicSync, 'epic');
      expect(merged).toHaveLength(1);
      const epicPlat = merged[0].platforms.find((p) => p.platformId === 'epic');
      expect(epicPlat).toBeDefined();
      expect(epicPlat?.installPath).toBe('/Games/20MinutesTillDawn');
      expect(epicPlat?.platforms).toEqual({ windows: true, mac: false });
      expect(epicPlat?.storefrontAppId).toBe('4656facc740742a39e265b026e13d075');
      expect(epicPlat?.namespace).toBe('ns-20mtd');
      expect(epicPlat?.catalogItemId).toBe('cat-20mtd');

      // Also verify that if existing entry already has platforms/namespace/catalogItemId and incoming update omits them, they are preserved
      const mergedReverse = mergeStorefrontGames(merged, existingCatalog, 'epic');
      const epicPlatReverse = mergedReverse[0].platforms.find((p) => p.platformId === 'epic');
      expect(epicPlatReverse?.installed).toBe(true);
      expect(epicPlatReverse?.platforms).toEqual({ windows: true, mac: false });
      expect(epicPlatReverse?.storefrontAppId).toBe('4656facc740742a39e265b026e13d075');
      expect(epicPlatReverse?.namespace).toBe('ns-20mtd');
      expect(epicPlatReverse?.catalogItemId).toBe('cat-20mtd');

      // 1b. sanitizeGameCatalog deduplicating two catalog entries for the same game
      const duplicateEntries: CanonicalGame[] = [
        {
          id: 'epic-dup-1',
          title: 'Tactical Odyssey',
          sortTitle: 'Tactical Odyssey',
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'epic',
              platformGameId: 'tac-odyssey-id',
              installed: true,
              installPath: '/Games/TacticalOdyssey',
            },
          ],
          headerImage: 'https://example.com/tac.jpg',
          capsuleImage: 'https://example.com/tac-cover.jpg',
          developers: ['Odyssey Devs'],
          publishers: ['Odyssey Pub'],
          genres: ['Strategy'],
          tags: ['Strategy'],
        },
        {
          id: 'epic-dup-2',
          title: 'Tactical Odyssey',
          sortTitle: 'Tactical Odyssey',
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'epic',
              platformGameId: 'tac-odyssey-id',
              storefrontAppId: 'tac-odyssey-app',
              namespace: 'ns-tac-odyssey',
              catalogItemId: 'cat-tac-odyssey',
              installed: false,
              platforms: { windows: true, mac: true },
            },
          ],
          headerImage: 'https://example.com/tac.jpg',
          capsuleImage: 'https://example.com/tac-cover.jpg',
          developers: ['Odyssey Devs'],
          publishers: ['Odyssey Pub'],
          genres: ['Strategy'],
          tags: ['Strategy'],
        },
      ];

      const deduplicated = sanitizeGameCatalog(duplicateEntries);
      expect(deduplicated).toHaveLength(1);
      const dedupPlat = deduplicated[0].platforms.find((p) => p.platformId === 'epic');
      expect(dedupPlat?.installed).toBe(true);
      expect(dedupPlat?.platforms).toEqual({ windows: true, mac: true });
      expect(dedupPlat?.storefrontAppId).toBe('tac-odyssey-app');
      expect(dedupPlat?.namespace).toBe('ns-tac-odyssey');
      expect(dedupPlat?.catalogItemId).toBe('cat-tac-odyssey');
    });

    it('2. getNativeOsPlatforms Stale nativePlatforms Guard & gog_os_support_cache_v1 Persistence (Dimensions 1 & 6): ignores stale top-level nativePlatforms on Epic/GOG and persists GOG OS support', () => {
      // 2a. Stale nativePlatforms: ['windows', 'mac'] on an Epic-only Windows game without explicit p.platforms
      const staleEpicGame: CanonicalGame = {
        id: 'epic-stale-native-platforms',
        title: 'Epic Windows Only Title',
        sortTitle: 'Epic Windows Only Title',
        nativePlatforms: ['windows', 'mac'],
        steamAppId: 1966900,
        enrichedMetadata: {
          appId: 1966900,
          name: 'Epic Windows Only Title',
          shortDescription: '',
          headerImage: '',
          developers: [],
          publishers: [],
          genres: [],
          categories: [],
          releaseDate: '2023',
          platforms: { windows: true, mac: true, linux: false },
          screenshots: [],
          movies: [],
        },
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'epic-win-only-app',
            installed: false,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      expect(getNativeOsPlatforms(staleEpicGame)).toEqual(['windows']);

      // 2b. saveCachedGogOsSupport and getCachedGogOsSupport (gog_os_support_cache_v1)
      const uncachedGogGame: CanonicalGame = {
        id: 'gog-77889900',
        title: 'Freshly Discovered GOG Indie',
        sortTitle: 'Freshly Discovered GOG Indie',
        nativePlatforms: ['windows', 'mac'],
        steamAppId: 1966900,
        enrichedMetadata: {
          appId: 1966900,
          platforms: { windows: true, mac: true, linux: false },
        } as any,
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '77889900',
            installed: false,
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      // Before caching, defaults to Windows-only (ignoring stale top-level nativePlatforms)
      expect(getNativeOsPlatforms(uncachedGogGame)).toEqual(['windows']);

      // Save dual-OS support to gog_os_support_cache_v1
      saveCachedGogOsSupport('gog-77889900', 'Freshly Discovered GOG Indie', {
        windows: true,
        mac: true,
      });

      expect(getCachedGogOsSupport('77889900')).toEqual({ windows: true, mac: true });
      expect(getCachedGogOsSupport('Freshly Discovered GOG Indie')).toEqual({
        windows: true,
        mac: true,
      });
      expect(getStorefrontNativeOsFlags(uncachedGogGame, 'gog')).toEqual({
        windows: true,
        mac: true,
        isExplicit: true,
      });
      expect(getNativeOsPlatforms(uncachedGogGame)).toEqual(['windows', 'mac']);

      // Update cache to Windows-only and verify immediate reflection
      saveCachedGogOsSupport('77889900', 'Freshly Discovered GOG Indie', {
        windows: true,
        mac: false,
      });
      expect(getStorefrontNativeOsFlags(uncachedGogGame, 'gog')).toEqual({
        windows: true,
        mac: false,
        isExplicit: true,
      });
      expect(getNativeOsPlatforms(uncachedGogGame)).toEqual(['windows']);
    });

    it('3. launcherService.getGameInstallInfo Host OS Preservation & GOG Cache Persistence (Dimensions 1, 4 & 9A): preserves mac:true on win32 and persists gog_os_support_cache_v1 on darwin', async () => {
      const prevApi = (window as any).electronAPI;
      const dualGogGame: CanonicalGame = {
        id: 'gog-dual-os-919191',
        title: 'Dual OS GOG Adventure',
        sortTitle: 'Dual OS GOG Adventure',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '919191',
            installed: false,
            platforms: { windows: true, mac: true },
          },
        ],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      // 3a. On win32 host, availableInstallers only has Windows installer -> must NOT overwrite targetPlat.platforms.mac (true) with false
      const winHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('win32');
      (window as any).electronAPI = {
        ...prevApi,
        getGameInstallInfo: vi.fn().mockResolvedValue({
          platformId: 'gog',
          platformGameId: '919191',
          hostPlatform: 'win32',
          defaultInstallDir: 'C:\\Games\\OneLauncher\\GOG',
          availableInstallDirs: ['C:\\Games\\OneLauncher\\GOG'],
          availableInstallers: [
            { id: 'gog-win', name: 'Windows Installer', os: 'windows', totalSizeBytes: 1024 },
          ],
          canDirectDownload: true,
          requiresStoreClientFallback: false,
        }),
      };

      try {
        await launcherService.getGameInstallInfo(dualGogGame, 'gog');
        expect(dualGogGame.platforms[0].platforms).toEqual({
          windows: true,
          mac: true,
        });
      } finally {
        winHostSpy.mockRestore();
      }

      // 3b. On darwin host, getGameInstallInfo updates targetPlat.platforms and persists into gog_os_support_cache_v1
      const macHostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      (window as any).electronAPI = {
        ...prevApi,
        getGameInstallInfo: vi.fn().mockResolvedValue({
          platformId: 'gog',
          platformGameId: '919191',
          hostPlatform: 'darwin',
          defaultInstallDir: '~/Games/OneLauncher/GOG',
          availableInstallDirs: ['~/Games/OneLauncher/GOG'],
          availableInstallers: [
            { id: 'gog-mac', name: 'macOS Installer', os: 'mac', totalSizeBytes: 1024 },
            { id: 'gog-win', name: 'Windows Installer', os: 'windows', totalSizeBytes: 1024 },
          ],
          canDirectDownload: true,
          requiresStoreClientFallback: false,
        }),
      };

      try {
        await launcherService.getGameInstallInfo(dualGogGame, 'gog');
        expect(getCachedGogOsSupport('919191')).toEqual({
          windows: true,
          mac: true,
        });
      } finally {
        macHostSpy.mockRestore();
        (window as any).electronAPI = prevApi;
      }
    });

    it('4. Windows Heroic Legendary Path Discovery, mtimeMs Caching & Composite Cache Eviction (launcherEngine.cjs & storeSync.cjs, Dimensions 2, 3, 4 & 9A)', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-win-heroic-test-'));
      try {
        // Create Windows Heroic path structure: <homedir>/AppData/Roaming/heroic/legendaryConfig/legendary
        const winHeroicLegendaryDir = path.join(
          tmpHome,
          'AppData',
          'Roaming',
          'heroic',
          'legendaryConfig',
          'legendary'
        );
        const metaDir = path.join(winHeroicLegendaryDir, 'metadata');
        fs.mkdirSync(metaDir, { recursive: true });

        // Write assets.json and metadata/*.json
        fs.writeFileSync(
          path.join(winHeroicLegendaryDir, 'assets.json'),
          JSON.stringify({
            Windows: [
              {
                app_name: '4656facc740742a39e265b026e13d075',
                catalog_item_id: 'cat-20mtd',
                app_title: '20 Minutes Till Dawn',
              },
              {
                app_name: 'mac-capable-epic-app',
                catalog_item_id: 'cat-mac-epic',
                app_title: 'Mac Capable Epic Game',
              },
            ],
            Mac: [
              {
                app_name: 'mac-capable-epic-app',
                catalog_item_id: 'cat-mac-epic',
                app_title: 'Mac Capable Epic Game',
              },
            ],
          }),
          'utf8'
        );

        fs.writeFileSync(
          path.join(metaDir, 'meta-release-mac.json'),
          JSON.stringify({
            app_name: 'meta-release-mac',
            app_title: 'Metadata ReleaseInfo Mac Game',
            metadata: {
              id: 'cat-meta-release-mac',
              namespace: 'ns-meta-release-mac',
              releaseInfo: [{ platform: ['Windows', 'Mac'] }],
            },
          }),
          'utf8'
        );

        // Verify storeSync.extractEpicMacSupportFromLegendaryDirs discovers both assets.json Mac and metadata releaseInfo Mac
        const macSet = storeSync.extractEpicMacSupportFromLegendaryDirs([winHeroicLegendaryDir]);
        expect(macSet.has('mac-capable-epic-app')).toBe(true);
        expect(macSet.has('cat-mac-epic')).toBe(true);
        expect(macSet.has('meta-release-mac')).toBe(true);
        expect(macSet.has('cat-meta-release-mac')).toBe(true);
        expect(macSet.has('4656facc740742a39e265b026e13d075')).toBe(false);

        // Verify launcherEngine.collectLocalEpicMetadataAndSupport discovers Windows Heroic directory via homedir
        const collected = launcherEngine.collectLocalEpicMetadataAndSupport({
          homedir: tmpHome,
          userDataDir: tmpHome,
        });
        expect(collected.epicPlatformSupport['4656facc740742a39e265b026e13d075']).toEqual({
          windows: true,
          mac: false,
        });
        expect(collected.epicPlatformSupport['mac-capable-epic-app']).toEqual({
          windows: true,
          mac: true,
        });
        expect(collected.epicPlatformSupport['meta-release-mac']).toEqual({
          windows: true,
          mac: true,
        });

        // Verify evictExecutableDiscoveryCacheForPath clears composite cache keys
        const gameInstallDir = path.join(tmpHome, 'DualGameDir');
        const appMacOsDir = path.join(gameInstallDir, 'DualGame.app', 'Contents', 'MacOS');
        fs.mkdirSync(appMacOsDir, { recursive: true });
        const macBin = path.join(appMacOsDir, 'DualGame');
        fs.writeFileSync(macBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        const firstLookup = launcherEngine.findPrimaryExecutable(gameInstallDir, {
          platform: 'darwin',
          hintName: 'DualGame',
          preferWindowsExecutable: false,
        });
        expect(firstLookup.executablePath).toBe(macBin);

        // Remove .app and add .exe, then evict composite cache for gameInstallDir
        fs.rmSync(path.join(gameInstallDir, 'DualGame.app'), { recursive: true, force: true });
        const winExe = path.join(gameInstallDir, 'DualGame.exe');
        fs.writeFileSync(winExe, 'MZ-fake-windows-pe-binary-payload');

        launcherEngine.evictExecutableDiscoveryCacheForPath(gameInstallDir);

        const secondLookup = launcherEngine.findPrimaryExecutable(gameInstallDir, {
          platform: 'darwin',
          hintName: 'DualGame',
          preferWindowsExecutable: false,
        });
        expect(secondLookup.executablePath).toBe(winExe);
        expect(secondLookup.isWindowsBinaryOnMac).toBe(true);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it('5. Dual-Build Launch Switching on macOS (launcherEngine.cjs, Dimensions 7 & 9A): switches between Windows .exe (compatibility_layer) and native .app (auto) even when payload.executablePath still points to .exe', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-dual-switch-'));
      try {
        // Create fake CrossOver wine runner binary and bottle
        const fakeWineBin = path.join(tmpDir, 'fake-wine-runner.sh');
        fs.writeFileSync(fakeWineBin, '#!/bin/sh\nsleep 2\n', { mode: 0o755 });
        const bottleDir = path.join(tmpDir, 'Bottles', 'OneLauncher', 'drive_c');
        fs.mkdirSync(bottleDir, { recursive: true });

        // Create dual-build game directory containing BOTH native .app bundle and Windows .exe
        const installDir = path.join(tmpDir, 'DualSwitchGame');
        const macOsDir = path.join(installDir, 'DualSwitchGame.app', 'Contents', 'MacOS');
        fs.mkdirSync(macOsDir, { recursive: true });
        const macBinPath = path.join(macOsDir, 'DualSwitchGame');
        fs.writeFileSync(macBinPath, '#!/bin/sh\nsleep 2\n', { mode: 0o755 });

        const winExePath = path.join(installDir, 'DualSwitchGame.exe');
        fs.writeFileSync(winExePath, 'MZ-fake-windows-pe-binary-payload');

        const launchOpts = {
          platform: 'darwin',
          userDataDir: tmpDir,
          skipStartupWait: true,
          customLayers: [
            {
              id: 'crossover',
              type: 'crossover',
              name: 'CrossOver',
              binaryPath: fakeWineBin,
              bottlesDir: path.join(tmpDir, 'Bottles'),
              availableBottles: ['OneLauncher'],
            },
          ],
        };

        // 5a. Launch with launchMethod: 'compatibility_layer' -> selects DualSwitchGame.exe and runs via compatibility_layer:crossover
        const winLaunchRes = await launcherEngine.launchGame(
          {
            gameId: 'dual-switch-game',
            title: 'DualSwitchGame',
            platformId: 'gog',
            platformGameId: '55667788',
            installPath: installDir,
            executablePath: macBinPath,
            isWindowsBinaryOnMac: false,
            launchConfig: {
              gameId: 'dual-switch-game',
              launchMethod: 'compatibility_layer',
              compatibilityLayer: 'crossover',
              wineBottleName: 'OneLauncher',
            },
          },
          launchOpts
        );

        expect(winLaunchRes.success).toBe(true);
        expect(winLaunchRes.session?.executablePath).toBe(winExePath);
        expect(winLaunchRes.session?.launchMethod).toBe('compatibility_layer:crossover');
        await launcherEngine.stopGame('dual-switch-game');

        // 5b. Switch back to launchMethod: 'auto' while payload.executablePath still points to winExePath and payload.isWindowsBinaryOnMac is true
        // Must rediscover and launch the native .app binary directly!
        const macLaunchRes = await launcherEngine.launchGame(
          {
            gameId: 'dual-switch-game',
            title: 'DualSwitchGame',
            platformId: 'gog',
            platformGameId: '55667788',
            installPath: installDir,
            executablePath: winExePath,
            isWindowsBinaryOnMac: true,
            launchConfig: {
              gameId: 'dual-switch-game',
              launchMethod: 'auto',
            },
          },
          launchOpts
        );

        expect(macLaunchRes.success).toBe(true);
        expect(macLaunchRes.session?.executablePath).toBe(macBinPath);
        expect(macLaunchRes.session?.launchMethod).toBe('direct');
        await launcherEngine.stopGame('dual-switch-game');
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });
});
