import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { scanRepoForPiiViolations } from './helpers/piiHygieneGuard';

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
  keys(): string[] {
    return Array.from(this.store.keys());
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

import { launcherService } from '../src/services/launcher/launcherService';
import {
  criticScoreService,
  normalizeCriticTitleKey,
} from '../src/services/critic/criticScoreService';
import {
  saveCurrentCatalog,
  flushPendingCatalogSave,
  loadCurrentCatalog,
} from '../src/services/integrations/integrationStorage';
import { SteamLibraryActionBar } from '../src/components/SteamStoreDetail/SteamLibraryActionBar';
import { loadMainProcessHarness } from './helpers/electronRuntimeHarness';

const requireCjs = createRequire(import.meta.url);
const launcherEngine = requireCjs('../electron/launcherEngine.cjs');

describe('10-Dimension Total Codebase Audit Verification Suite', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Dimension 4 & 5: Process Tree PID Latching & Cross-Platform Parity (electron/launcherEngine.cjs)', () => {
    it('extractMatchedPidFromProcessOutput parses win32 tasklist CSV and darwin ps output accurately', () => {
      expect(typeof launcherEngine.extractMatchedPidFromProcessOutput).toBe('function');

      // 1. Windows tasklist.exe /FO CSV /NH output
      const winCsvOutput = [
        '"System Idle Process","0","Services","0","8 K"',
        '"Steam.exe","3104","Console","1","245,120 K"',
        '"Cyberpunk2077.exe","48120","Console","1","4,120,000 K"',
      ].join('\r\n');

      expect(
        launcherEngine.extractMatchedPidFromProcessOutput(
          winCsvOutput,
          ['cyberpunk2077.exe'],
          'win32'
        )
      ).toBe(48120);

      // Matches even when hint omits .exe suffix
      expect(
        launcherEngine.extractMatchedPidFromProcessOutput(
          winCsvOutput,
          ['cyberpunk2077'],
          'win32'
        )
      ).toBe(48120);

      // Returns 0 when no process matches
      expect(
        launcherEngine.extractMatchedPidFromProcessOutput(
          winCsvOutput,
          ['witcher3.exe'],
          'win32'
        )
      ).toBe(0);

      // 2. macOS ps -ax -o pid=,command= output
      const darwinPsOutput = [
        '    1 /sbin/launchd',
        '73910 /bin/ps -ax -o pid=,command=',
        '73912 /Users/test/Games/Hades/Hades.app/Contents/MacOS/Hades --vulkan',
      ].join('\n');

      expect(
        launcherEngine.extractMatchedPidFromProcessOutput(
          darwinPsOutput,
          ['hades'],
          'darwin'
        )
      ).toBe(73912);

      // Ignores ps command itself
      expect(
        launcherEngine.extractMatchedPidFromProcessOutput(
          '73910 /bin/ps -ax -o pid=,command=\n',
          ['ps'],
          'darwin'
        )
      ).toBe(0);

      // Returns 0 on empty/unmatched output
      expect(
        launcherEngine.extractMatchedPidFromProcessOutput(
          darwinPsOutput,
          ['nonexistent_binary'],
          'darwin'
        )
      ).toBe(0);
    });

    it('launchGame in storefront_uri mode latches matchedPid and switches to O(1) process.kill(pid, 0) polling', async () => {
      vi.useFakeTimers();
      try {
        const execFileMock = vi.fn((cmd, args, opts, cb) => {
          const callback = typeof opts === 'function' ? opts : cb;
          callback(
            null,
            '88421 /Users/test/Games/Quake2/quake2.exe\n',
            ''
          );
        });
        const openExternalMock = vi.fn().mockResolvedValue(undefined);
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);

        const countUriPollCalls = () =>
          execFileMock.mock.calls.filter(
            ([cmd, args]) => cmd === 'ps' && Array.isArray(args) && args.includes('pid=,command=')
          ).length;

        const res = await launcherEngine.launchGame(
          {
            gameId: 'epic-quake2-uri-latch-test',
            platformId: 'epic',
            platformGameId: 'quake2',
            title: 'Quake II',
            installPath: '/Users/test/Games/Quake2',
            executablePath: '/Users/test/Games/Quake2/quake2.exe',
            launchConfig: {
              launchMethod: 'storefront_uri',
            },
          },
          {
            platform: 'darwin',
            uriPollIntervalMs: 1000,
            execFileFn: execFileMock,
            openExternalFn: openExternalMock,
            skipCloudSaveSync: true,
          }
        );

        expect(res.success).toBe(true);
        expect(countUriPollCalls()).toBe(0);

        // Tick 1: No latched PID yet -> spawns `ps -ax -o pid=,command=` once and latches PID 88421
        vi.advanceTimersByTime(1000);
        expect(countUriPollCalls()).toBe(1);

        const runningAfterFirstTick = launcherEngine.getRunningGames();
        const activeSession = runningAfterFirstTick.find(
          (s: any) => s.gameId === 'epic-quake2-uri-latch-test'
        );
        expect(activeSession).toBeDefined();
        expect(activeSession.pid).toBe(88421);

        // Tick 2 & Tick 3: Uses O(1) process.kill(88421, 0) without spawning `ps` again
        vi.advanceTimersByTime(2000);
        expect(countUriPollCalls()).toBe(1);
        expect(killSpy).toHaveBeenCalledWith(88421, 0);

        vi.useRealTimers();
        killSpy.mockImplementation(() => {
          const err: any = new Error('ESRCH');
          err.code = 'ESRCH';
          throw err;
        });
        await launcherEngine.stopGame(
          { gameId: 'epic-quake2-uri-latch-test' },
          { platform: 'darwin', skipCloudSaveSync: true }
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('Dimension 3 & 4: Behavioral File Descriptor Safety & Steam Monitor Location Caching', () => {
    it('closes every async FileHandle opened during startSteamInstallMonitor log tailing without leaking FDs', async () => {
      expect(typeof launcherEngine.extractMatchedPidFromProcessOutput).toBe('function');
      expect(typeof launcherEngine.startSteamInstallMonitor).toBe('function');

      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-steam-fd-audit-'));
      const steamRoot = path.join(tmpHome, 'Library', 'Application Support', 'Steam');
      const steamappsDir = path.join(steamRoot, 'steamapps');
      const logsDir = path.join(steamRoot, 'logs');
      fs.mkdirSync(steamappsDir, { recursive: true });
      fs.mkdirSync(logsDir, { recursive: true });

      fs.writeFileSync(
        path.join(steamappsDir, 'appmanifest_620.acf'),
        '"AppState"\n{\n\t"appid"\t\t"620"\n\t"name"\t\t"Portal 2"\n\t"StateFlags"\t\t"1026"\n\t"BytesToDownload"\t\t"10000"\n\t"BytesDownloaded"\t\t"4000"\n}\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(logsDir, 'content_log.txt'),
        '[2026-10-24 10:00:00] AppID 620 state changed : Update Required,Update Running,\n[2026-10-24 10:00:01] Current download rate: 24.500 Mbps\n',
        'utf8'
      );

      let openedHandles = 0;
      let closedHandles = 0;
      const origOpen = fs.promises.open.bind(fs.promises);
      const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation((async (...args: any[]) => {
        const fh = await (origOpen as any)(...args);
        openedHandles++;
        const origClose = fh.close.bind(fh);
        fh.close = async () => {
          closedHandles++;
          return origClose();
        };
        return fh;
      }) as any);

      let taskId = '';
      try {
        const initRes = await launcherEngine.installGame({
          gameId: 'steam-620-fd-test',
          title: 'Portal 2',
          platformId: 'steam',
          platformGameId: '620',
          manualControl: true,
        });
        taskId = initRes.task.taskId;

        launcherEngine.startSteamInstallMonitor(taskId, 620, {
          platform: 'darwin',
          homedir: tmpHome,
          steamPollIntervalMs: 15,
          steamLocationsCacheTtlMs: 10000,
        });

        await vi.waitFor(
          () => {
            expect(openedHandles).toBeGreaterThanOrEqual(1);
          },
          { timeout: 3000, interval: 15 }
        );
        await launcherEngine.cancelDownload(taskId);
        await vi.waitFor(
          () => {
            expect(closedHandles).toBe(openedHandles);
          },
          { timeout: 3000, interval: 15 }
        );
      } finally {
        openSpy.mockRestore();
        if (taskId) {
          try {
            await launcherEngine.cancelDownload(taskId);
          } catch {}
        }
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it('verifies app:check-for-updates respects ONE_LAUNCHER_GITHUB_REPO and passes an AbortSignal timeout', async () => {
      const prevRepo = process.env.ONE_LAUNCHER_GITHUB_REPO;
      process.env.ONE_LAUNCHER_GITHUB_REPO = 'ExampleOrg/OneLauncherFork';
      const origFetch = globalThis.fetch;
      const fetchCalls: Array<{ url: string; signal?: AbortSignal | null }> = [];

      globalThis.fetch = vi.fn(async (input: any, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), signal: init?.signal });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: 'v0.2.0',
            html_url: 'https://github.com/ExampleOrg/OneLauncherFork/releases/tag/v0.2.0',
            assets: [],
          }),
        } as any;
      }) as any;

      const mainHarness = loadMainProcessHarness({ platform: 'darwin', version: '0.1.0' });
      try {
        const res = await mainHarness.invokeIpc('app:check-for-updates');
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0].url).toBe(
          'https://api.github.com/repos/ExampleOrg/OneLauncherFork/releases/latest'
        );
        expect(fetchCalls[0].signal).toBeInstanceOf(AbortSignal);
        expect(res.hasUpdate).toBe(true);
        expect(res.latestVersion).toBe('0.2.0');
      } finally {
        mainHarness.dispose();
        globalThis.fetch = origFetch;
        if (prevRepo === undefined) {
          delete process.env.ONE_LAUNCHER_GITHUB_REPO;
        } else {
          process.env.ONE_LAUNCHER_GITHUB_REPO = prevRepo;
        }
      }
    });
  });

  describe('Dimension 4: In-Game Hibernation Download Polling Suppression & Critic Cache Consolidation', () => {
    it('launcherService pauses activeDownloadPollTimer when setInGameHibernating(true) is called and resumes when false', () => {
      const svc = launcherService as any;
      const prevQueue = [...(svc.downloadQueue || [])];
      const prevHibernating = Boolean(svc.inGameHibernating);
      const prevElectronApi = (window as any).electronAPI;

      try {
        (window as any).electronAPI = {
          ...(prevElectronApi || {}),
          getDownloadQueue: vi.fn().mockResolvedValue([]),
          clearRendererImageCache: vi.fn().mockResolvedValue(undefined),
        };

        svc.inGameHibernating = false;
        svc.downloadQueue = [
          {
            taskId: 'dl-audit-1',
            gameId: 'gog-1',
            platformId: 'gog',
            platformGameId: '1',
            title: 'Audit Test Game',
            status: 'downloading',
            progressPercent: 42,
            bytesDownloaded: 420,
            totalBytes: 1000,
            speedBytesPerSec: 100,
            etaSeconds: 5,
            installDir: '/tmp/audit',
          },
        ];

        svc.ensureActiveDownloadPolling();
        expect(svc.activeDownloadPollTimer).not.toBeNull();

        // Entering in-game hibernation must immediately clear the 3500ms poll timer
        launcherService.setInGameHibernating(true);
        expect(launcherService.isInGameHibernating()).toBe(true);
        expect(svc.activeDownloadPollTimer).toBeNull();

        // Calling ensureActiveDownloadPolling while hibernating must keep timer null
        svc.ensureActiveDownloadPolling();
        expect(svc.activeDownloadPollTimer).toBeNull();

        // Exiting in-game hibernation must automatically resume active download polling
        launcherService.setInGameHibernating(false);
        expect(launcherService.isInGameHibernating()).toBe(false);
        expect(svc.activeDownloadPollTimer).not.toBeNull();
      } finally {
        if (svc.activeDownloadPollTimer) {
          clearInterval(svc.activeDownloadPollTimer);
          svc.activeDownloadPollTimer = null;
        }
        svc.downloadQueue = prevQueue;
        svc.inGameHibernating = prevHibernating;
        (window as any).electronAPI = prevElectronApi;
      }
    });

    it('criticScoreService.cacheResult writes only 1 primary antigravity_critic_v8_* key to localStorage while populating normalized title aliases in inMemoryCache', () => {
      localStorage.clear();
      const svc = criticScoreService as any;
      svc.inMemoryCache.clear();

      const sampleScore = {
        score: 92,
        tier: 'Mighty' as const,
        url: 'https://www.metacritic.com/game/the-witcher-3-wild-hunt/',
        source: 'metacritic' as const,
        isVerified: true,
      };

      const rawTitle = 'the witcher 3: wild hunt - complete edition';
      svc.cacheResult(
        `title:${rawTitle}`,
        sampleScore,
        '2015-05-18',
        ['RPG'],
        { dynamicResolved: true }
      );

      const allKeys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('antigravity_critic_v8_')) {
          allKeys.push(k);
        }
      }

      expect(allKeys).toEqual([`antigravity_critic_v8_title:${rawTitle}`]);

      // Secondary normalized key is populated in inMemoryCache without duplicating in localStorage
      const expectedNormKey = normalizeCriticTitleKey(rawTitle);
      expect(expectedNormKey).not.toBe(rawTitle);
      expect(svc.inMemoryCache.get(`title:${expectedNormKey}`)).toEqual(sampleScore);
    });
  });

  describe('Dimension 3 & 8: Behavioral Catalog Cache Synchronization & Action Bar Unmount Cleanup', () => {
    it('persists catalog updates canonically via saveCurrentCatalog + flushPendingCatalogSave without legacy key bypass and cleans up SteamLibraryActionBar timers on unmount', () => {
      localStorage.clear();
      saveCurrentCatalog(
        [
          {
            id: 'steam-620',
            title: 'Portal 2',
            sortTitle: 'Portal 2',
            steamAppId: 620,
            isVerifiedEntitlement: true,
            platforms: [{ platformId: 'steam', platformGameId: '620', installed: true }],
            headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/header.jpg',
            capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/library_600x900.jpg',
            developers: ['Valve'],
            publishers: ['Valve'],
            genres: ['Puzzle'],
            tags: ['Puzzle'],
          },
        ],
        { skipSanitize: true }
      );
      flushPendingCatalogSave();

      expect(localStorage.getItem('antigravity_current_catalog_v1')).toBeNull();
      expect(loadCurrentCatalog().map((g) => g.id)).toEqual(['steam-620']);

      // Verify SteamLibraryActionBar cleans up pending feedbackTimerRef on unmount
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const cleanups: Array<() => void> = [];
      const pendingTimer = setTimeout(() => {}, 10000);
      let refIdx = 0;

      const internals =
        (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
        (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
      const prevH = internals.H;
      internals.H = {
        useState(init: any) {
          return [typeof init === 'function' ? init() : init, vi.fn()];
        },
        useEffect(fn: () => any) {
          const cleanup = fn();
          if (typeof cleanup === 'function') cleanups.push(cleanup);
        },
        useRef(init: any) {
          // Populate timer ref on null-initialized timeout refs so unmount cleanup exercises clearTimeout
          const idx = refIdx++;
          if (init === null && idx <= 3) {
            return { current: pendingTimer };
          }
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
        (SteamLibraryActionBar as any)({
          game: loadCurrentCatalog()[0],
        });
      } finally {
        internals.H = prevH;
      }

      for (const cleanup of cleanups) {
        cleanup();
      }
      expect(clearTimeoutSpy).toHaveBeenCalledWith(pendingTimer);
      clearTimeout(pendingTimer);
      clearTimeoutSpy.mockRestore();
    });
  });

  describe('Dimension 9: Release-Bundle Personal / Individual Information Hygiene Gate', () => {
    it('verifies zero personal paths, personal SteamIDs, or personal handles exist across electron/, src/, build/, public/, and root config files', () => {
      const rootDir = path.resolve(__dirname, '..');
      const prodTargets = [
        'electron',
        'src',
        'build',
        'public',
        'package.json',
        'vite.config.ts',
        'tsconfig.json',
        'tsconfig.app.json',
        'tsconfig.node.json',
        'index.html',
      ];
      const releaseExtRegex =
        /\.(?:ts|tsx|js|cjs|mjs|json|nsh|nsi|ps1|bat|cmd|sh|plist|entitlements|c|h|html|css|md|yml|yaml)$/i;

      const violations = scanRepoForPiiViolations(rootDir, prodTargets, releaseExtRegex);
      expect(violations).toEqual([]);
    });
  });
});
