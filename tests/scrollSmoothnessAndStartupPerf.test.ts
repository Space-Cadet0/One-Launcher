import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { CanonicalGame } from '../src/contracts/game';

const requireCjs = createRequire(import.meta.url);
const launcherEngine = requireCjs('../electron/launcherEngine.cjs');

// ---------------------------------------------------------------------------
// Headless Browser Environment Setup (window, localStorage, CustomEvent)
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
const windowListeners: Record<string, Function[]> = {};
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = {
    localStorage: mockStorage,
    location: { hostname: '' },
    addEventListener: (event: string, fn: Function) => {
      windowListeners[event] = windowListeners[event] || [];
      windowListeners[event].push(fn);
    },
    removeEventListener: (event: string, fn: Function) => {
      if (windowListeners[event]) {
        windowListeners[event] = windowListeners[event].filter((f) => f !== fn);
      }
    },
    dispatchEvent: (event: any) => {
      const fns = windowListeners[event.type] || [];
      fns.slice().forEach((fn) => fn(event));
      return true;
    },
  };
}

import { LauncherService } from '../src/services/launcher/launcherService';
import {
  LibraryGridView,
  notifyImageUnmounted,
  scheduleScrollIdleMemoryTrim,
  recordScrollActivity,
} from '../src/components/Library/LibraryGridView';
import { LibrarySidebar } from '../src/components/Library/LibrarySidebar';
import {
  markScrollActivity,
  isUserActivelyScrolling,
  onScrollIdle,
} from '../src/utils/scrollActivityTracker';
import { SteamStorePage } from '../src/components/SteamStoreDetail/SteamStorePage';
import { DownloadManagerDrawer } from '../src/components/Launcher/DownloadManagerDrawer';
import { GameAchievementsModal } from '../src/components/Achievements/GameAchievementsModal';
import { IntegrationsModal } from '../src/components/Navigation/IntegrationsModal';
import { ManageCollectionsModal } from '../src/components/Library/ManageCollectionsModal';
import { FixMatchWizardModal } from '../src/components/Library/FixMatchWizardModal';
import { LibraryMatchManagerModal } from '../src/components/Library/LibraryMatchManagerModal';
import { usePostSessionReconciler } from '../src/hooks/usePostSessionReconciler';
import { loadMainProcessHarness, loadPreloadApi } from './helpers/electronRuntimeHarness';

const repoRoot = path.resolve(__dirname, '..');

function makeCatalogGames(count: number): CanonicalGame[] {
  return Array.from({ length: count }, (_, idx) => {
    const idNum = 1000 + idx;
    const padded = String(idx).padStart(3, '0');
    return {
      id: `steam-${idNum}`,
      title: `Scroll Perf Game ${padded}`,
      sortTitle: `Scroll Perf Game ${padded}`,
      steamAppId: idNum,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: String(idNum),
          installed: idx % 5 === 0,
          installPath: idx % 5 === 0 ? `/Games/Steam/Game_${padded}` : undefined,
        },
      ],
      headerImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${idNum}/header.jpg`,
      capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${idNum}/library_600x900.jpg`,
      developers: ['Perf Studio'],
      publishers: ['Perf Publisher'],
      genres: ['Action'],
      tags: ['Action'],
    };
  });
}

describe('Scroll Smoothness, Startup Storm Elimination & Storefront Function Preservation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockStorage.clear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('eliminates mid-scroll V8 GC / webFrame.clearCache() stalls during notifyImageUnmounted and 350ms/1600ms scroll pauses while preserving explicit full memory trim', async () => {
    const gcSpy = vi.fn();
    const prevGc = (globalThis as any).gc;
    (globalThis as any).gc = gcSpy;

    const mainHarness = loadMainProcessHarness({ platform: 'darwin' });
    const preload = loadPreloadApi({ platform: 'darwin' });

    try {
      // 1. Preload passive trim skips synchronous globalThis.gc() and webFrame.clearCache(), while explicit trim runs both
      await preload.api.trimMemory({ passive: true });
      expect(gcSpy).not.toHaveBeenCalled();
      expect(preload.clearCacheCalls).toBe(0);

      await preload.api.trimMemory({ passive: false });
      expect(gcSpy).toHaveBeenCalledTimes(1);
      expect(preload.clearCacheCalls).toBe(1);

      // 2. Main process perf:trim-memory IPC trims engine buffers without triggering main-handler global.gc() on passive trim
      const engineTrimSpy = vi
        .spyOn(launcherEngine, 'trimLauncherEngineMemory')
        .mockImplementation(() => ({ success: true }));
      try {
        gcSpy.mockClear();
        await mainHarness.invokeIpc('perf:trim-memory', { passive: true });
        expect(engineTrimSpy).toHaveBeenCalledTimes(1);
        expect(gcSpy).not.toHaveBeenCalled();

        await mainHarness.invokeIpc('perf:trim-memory', { passive: false });
        expect(engineTrimSpy).toHaveBeenCalledTimes(2);
        expect(gcSpy).toHaveBeenCalledTimes(1);
      } finally {
        engineTrimSpy.mockRestore();
      }
    } finally {
      (globalThis as any).gc = prevGc;
      mainHarness.dispose();
    }

    const trimMemorySpy = vi.fn().mockResolvedValue({ success: true });
    const prevApi = (globalThis as any).window?.electronAPI;
    (globalThis as any).window.electronAPI = {
      ...(prevApi || {}),
      trimMemory: trimMemorySpy,
    };

    try {
      // Simulate scrolling through 40 cards unmounting offscreen images + scroll ticks
      for (let i = 0; i < 40; i++) {
        notifyImageUnmounted();
      }
      recordScrollActivity(640, 'main');
      scheduleScrollIdleMemoryTrim();

      // Advance past 80ms, 350ms, 1600ms, and 5000ms: ZERO trimMemory calls during active/recent browsing!
      vi.advanceTimersByTime(5000);
      expect(trimMemorySpy).not.toHaveBeenCalled();

      // Advance past 20,000ms of complete idle: only a passive buffer trim is requested
      vi.advanceTimersByTime(20000);
      expect(trimMemorySpy).toHaveBeenCalledWith({ passive: true });
    } finally {
      (globalThis as any).window.electronAPI = prevApi;
    }
  });

  it('applies content-visibility: auto strictly below the fold (idx >= 28 on grid, row > 28 on sidebar) without content-visibility: hidden', () => {
    const games = makeCatalogGames(40);

    const gridHtml = renderToString(
      React.createElement(LibraryGridView, {
        games,
        onSelectGame: vi.fn(),
        collections: [],
      })
    );

    // Above-the-fold cards (0..27) MUST NOT have cv-card-deferred
    const card0Match = gridHtml.match(/data-game-id="steam-1000"[^>]*class="([^"]+)"/);
    const card27Match = gridHtml.match(/data-game-id="steam-1027"[^>]*class="([^"]+)"/);
    const card28Match = gridHtml.match(/data-game-id="steam-1028"[^>]*class="([^"]+)"/);
    const card39Match = gridHtml.match(/data-game-id="steam-1039"[^>]*class="([^"]+)"/);

    expect(card0Match?.[1]).toContain('cv-card');
    expect(card0Match?.[1]).not.toContain('cv-card-deferred');
    expect(card27Match?.[1]).not.toContain('cv-card-deferred');
    // Below-the-fold cards (28..39) MUST have cv-card-deferred and remain in DOM without content-visibility: hidden
    expect(card28Match?.[1]).toContain('cv-card-deferred');
    expect(card39Match?.[1]).toContain('cv-card-deferred');
    expect(gridHtml).not.toContain('content-visibility: hidden');

    const sidebarHtml = renderToString(
      React.createElement(LibrarySidebar, {
        games,
        selectedGameId: 'steam-1000',
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

    const deferredSidebarMatches = sidebarHtml.match(/cv-sidebar-row-deferred/g) || [];
    // Rows 0..28 (29 rows) are eager; rows 29..39 (11 rows) are deferred
    expect(deferredSidebarMatches.length).toBe(11);
  });

  it('eliminates full-viewport backdrop-blur compositor thrashing across rendered SteamStorePage and all modal/drawer backdrops', () => {
    const sampleGame = makeCatalogGames(1)[0];
    const renderedViews: Array<[string, string]> = [
      [
        'SteamStorePage',
        renderToString(React.createElement(SteamStorePage, { game: sampleGame, collections: [] })),
      ],
      ['DownloadManagerDrawer', renderToString(React.createElement(DownloadManagerDrawer, {}))],
      [
        'GameAchievementsModal',
        renderToString(
          React.createElement(GameAchievementsModal, {
            isOpen: true,
            game: sampleGame,
            onClose: vi.fn(),
          })
        ),
      ],
      [
        'IntegrationsModal',
        renderToString(
          React.createElement(IntegrationsModal, {
            isOpen: true,
            onClose: vi.fn(),
            integrations: [],
            onUpdateIntegrations: vi.fn(),
            onGamesSynced: vi.fn(),
          } as any)
        ),
      ],
      [
        'ManageCollectionsModal',
        renderToString(
          React.createElement(ManageCollectionsModal, {
            isOpen: true,
            onClose: vi.fn(),
            collections: [],
            games: [sampleGame],
            onCreateCollection: vi.fn(),
            onRenameCollection: vi.fn(),
            onDeleteCollection: vi.fn(),
            onReorderCollections: vi.fn(),
          } as any)
        ),
      ],
      [
        'FixMatchWizardModal',
        renderToString(
          React.createElement(FixMatchWizardModal, {
            isOpen: true,
            game: sampleGame,
            onClose: vi.fn(),
            onApplyOverride: vi.fn(),
          } as any)
        ),
      ],
      [
        'LibraryMatchManagerModal',
        renderToString(
          React.createElement(LibraryMatchManagerModal, {
            isOpen: true,
            games: [sampleGame],
            onClose: vi.fn(),
            onOpenFixMatch: vi.fn(),
            onResetOverride: vi.fn(),
          } as any)
        ),
      ],
    ];

    for (const [name, html] of renderedViews) {
      expect(html, `${name} rendered HTML should not contain backdrop-blur`).not.toContain(
        'backdrop-blur'
      );
    }
  });

  it('tracks scroll activity and flushes onScrollIdle callbacks cleanly once scrolling settles', () => {
    const idleSpy = vi.fn();
    expect(isUserActivelyScrolling()).toBe(false);

    markScrollActivity();
    expect(isUserActivelyScrolling()).toBe(true);

    onScrollIdle(idleSpy);
    expect(idleSpy).not.toHaveBeenCalled();

    // Another scroll tick resets the settle window
    vi.advanceTimersByTime(150);
    markScrollActivity();
    vi.advanceTimersByTime(150);
    expect(isUserActivelyScrolling()).toBe(true);
    expect(idleSpy).not.toHaveBeenCalled();

    // After 220ms of quiet, scroll state clears and idle callback runs once
    vi.advanceTimersByTime(100);
    expect(isUserActivelyScrolling()).toBe(false);
    expect(idleSpy).toHaveBeenCalledTimes(1);
  });

  it('provides O(1) LauncherService installed lookup parity across platformId, steamAppId, paths, normalized title, and custom exe while suppressing cold-boot event storms', async () => {
    const svc = new LauncherService();
    const installedEvents: any[] = [];
    const onInstalled = (e: any) => installedEvents.push(e.detail);
    (globalThis as any).window.addEventListener('antigravity:game-installed', onInstalled);

    const prevApi = (globalThis as any).window.electronAPI;
    (globalThis as any).window.electronAPI = {
      ...(prevApi || {}),
      platform: 'darwin',
      scanAllInstalledGames: vi.fn().mockResolvedValue({
        success: true,
        installedGames: [
          {
            platformId: 'steam',
            platformGameId: '2320',
            appId: 2320,
            title: 'Quake II',
            installPath: '/Users/test/Bottles/OneLauncher/drive_c/Games/Quake2',
            executablePath: '/Users/test/Bottles/OneLauncher/drive_c/Games/Quake2/quake2.exe',
            isWindowsBinaryOnMac: true,
          },
          {
            platformId: 'gog',
            platformGameId: '1441704920',
            title: 'The Witcher 3: Wild Hunt',
            installPath: '/Applications/The Witcher 3.app',
            executablePath: '/Applications/The Witcher 3.app/Contents/MacOS/Witcher3',
            isWindowsBinaryOnMac: false,
          },
          {
            platformId: 'epic',
            platformGameId: 'QuakeEpicApp',
            title: 'Quake',
            installPath: '/Users/test/Games/Heroic/Quake',
            executablePath: '/Users/test/Games/Heroic/Quake/Quake_x64_egs.exe',
            isWindowsBinaryOnMac: true,
          },
        ],
      }),
    };

    try {
      // Cold boot scan with silentInitialBoot: true emits ZERO redundant per-game events
      const records = await svc.scanAllInstalledGames(true, { silentInitialBoot: true });
      expect(records).toHaveLength(3);
      expect(installedEvents).toHaveLength(0);

      // O(1) lookup by exact platformId + platformGameId
      const quake2Steam: CanonicalGame = {
        id: 'steam-2320',
        title: 'Quake II',
        sortTitle: 'Quake II',
        steamAppId: 2320,
        platforms: [{ platformId: 'steam', platformGameId: '2320', installed: false }],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };
      expect(svc.isGameInstalled(quake2Steam)).toBe(true);
      expect(svc.getInstalledRecordForGame(quake2Steam)?.executablePath).toContain('quake2.exe');

      // O(1) lookup by normalized title when platformGameId differs
      const witcherByTitle: CanonicalGame = {
        id: 'gog-witcher',
        title: 'The Witcher® 3 - Wild Hunt™',
        sortTitle: 'Witcher 3',
        platforms: [{ platformId: 'gog', platformGameId: 'legacy-slug', installed: false }],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };
      expect(svc.isGameInstalled(witcherByTitle)).toBe(true);
      expect(svc.getInstalledRecordForGame(witcherByTitle)?.platformGameId).toBe('1441704920');

      // Runtime scan discovering a brand-new installation DOES emit antigravity:game-installed
      ((globalThis as any).window.electronAPI.scanAllInstalledGames as any).mockResolvedValueOnce({
        success: true,
        installedGames: [
          ...records,
          {
            platformId: 'gog',
            platformGameId: '999111',
            title: 'Newly Installed Game',
            installPath: '/Applications/NewGame.app',
          },
        ],
      });
      await svc.scanAllInstalledGames(true);
      expect(installedEvents).toHaveLength(1);
      expect(installedEvents[0].platformGameId).toBe('999111');
    } finally {
      (globalThis as any).window.removeEventListener('antigravity:game-installed', onInstalled);
      (globalThis as any).window.electronAPI = prevApi;
    }
  });

  it('preserves all critical storefront functions (active downloads, cloud save sync barriers, achievements/trophies, and post-session playtime reconciliation)', () => {
    // 1. Active downloads pause/resume & post-session work guards remain intact
    expect(typeof launcherEngine.pauseActiveDownloadsForInGame).toBe('function');
    expect(typeof launcherEngine.resumeDownloadsPausedByInGame).toBe('function');
    expect(typeof launcherEngine.hasActivePostSessionWork).toBe('function');
    // 2. Cloud save bidirectional sync barriers remain intact across Steam, GOG, and Epic
    expect(typeof launcherEngine.waitForSteamColdStartupCloudReady).toBe('function');
    expect(typeof launcherEngine.waitForSteamCloudSyncCompletion).toBe('function');
    expect(typeof launcherEngine.syncGogCloudSaves).toBe('function');
    expect(typeof launcherEngine.ensureGogGalaxyBackgroundService).toBe('function');
    expect(typeof launcherEngine.syncEpicCloudSaves).toBe('function');
    expect(typeof launcherEngine.resolveEpicLaunchAuthArguments).toBe('function');
    // 3. Playtime sync & behavioral usePostSessionReconciler event reconciliation
    expect(typeof launcherEngine.syncSessionPlaytimeToStorefront).toBe('function');

    let gamesState: CanonicalGame[] = makeCatalogGames(1);
    const showSyncNotice = vi.fn();
    let cleanupFn: (() => void) | undefined;
    const internals =
      (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
      (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
    const prevH = internals.H;
    internals.H = {
      useEffect(fn: () => any) {
        cleanupFn = fn();
      },
    };
    try {
      usePostSessionReconciler({
        setGames: (updater) => {
          gamesState = typeof updater === 'function' ? updater(gamesState) : updater;
        },
        showSyncNotice,
      });
    } finally {
      internals.H = prevH;
    }

    try {
      (globalThis as any).window.dispatchEvent(
        new CustomEvent('antigravity:game-session-ended', {
          detail: {
            gameId: 'steam-1000',
            platformId: 'steam',
            platformGameId: '1000',
            sessionMinutesPlayed: 45,
            storefrontTotalPlaytimeMinutes: 210,
            lastPlayed: '2026-10-24T10:00:00Z',
          },
        })
      );
      expect(gamesState[0].platforms[0].playtimeMinutes).toBe(210);
    } finally {
      cleanupFn?.();
    }
  });
});
