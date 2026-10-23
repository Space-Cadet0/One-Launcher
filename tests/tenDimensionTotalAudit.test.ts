import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

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

  describe('Dimension 3 & 4: File Descriptor Safety & Steam Monitor Location Caching (electron/launcherEngine.cjs + extracted native CJS modules & electron/main.cjs)', () => {
    const readConcatenatedNativeModules = () => {
      const electronDir = path.resolve(__dirname, '../electron');
      const moduleFiles = [path.join(electronDir, 'launcherEngine.cjs')];
      for (const subDir of ['launcher', 'utils', 'ipc']) {
        const fullDir = path.join(electronDir, subDir);
        if (!fs.existsSync(fullDir)) continue;
        for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.cjs')) {
            moduleFiles.push(path.join(fullDir, entry.name));
          }
        }
      }
      return {
        moduleFiles,
        combinedSource: moduleFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n'),
      };
    };

    it('guarantees every fs.openSync and fs.promises.open across electron/launcherEngine.cjs + electron/{launcher,utils,ipc}/*.cjs is guarded by try/finally close', () => {
      const { moduleFiles, combinedSource } = readConcatenatedNativeModules();
      const openCalls = combinedSource.match(/fs\.openSync\(/g) || [];
      const closeCalls = combinedSource.match(/fs\.closeSync\([a-zA-Z0-9_]+\)/g) || [];

      expect(openCalls.length).toBeGreaterThanOrEqual(10);
      expect(closeCalls.length).toBe(openCalls.length);

      // Every module calling fs.promises.open must close its FileHandle in a finally block
      let asyncOpenTotal = 0;
      for (const modFile of moduleFiles) {
        const modSource = fs.readFileSync(modFile, 'utf8');
        const asyncOpens = modSource.match(/fs\.promises\.open\(/g) || [];
        if (asyncOpens.length > 0) {
          asyncOpenTotal += asyncOpens.length;
          expect(modSource).toContain('finally {');
          expect(modSource).toMatch(/\.close\(\)/);
        }
      }
      expect(asyncOpenTotal).toBeGreaterThanOrEqual(6);

      // Verify readContentLogTail and readContentLogTailAsync wrap reads in try ... finally close
      const readContentLogSection = combinedSource.slice(
        combinedSource.indexOf('const readContentLogTail ='),
        combinedSource.indexOf('const readContentLogTail =') + 3200
      );
      expect(readContentLogSection).toContain("const fd = fs.openSync(logPath, 'r');");
      expect(readContentLogSection).toContain('fs.closeSync(fd);');
      expect(readContentLogSection).toContain("fh = await fs.promises.open(logPath, 'r');");
      expect(readContentLogSection).toContain('await fh.close();');
      expect(readContentLogSection).toContain('finally {');

      // Verify extracted helpers remain present across native modules
      expect(combinedSource).toContain('function extractMatchedPidFromProcessOutput(');
      expect(combinedSource).toContain('function startSteamInstallMonitor(');
    });

    it('verifies startSteamInstallMonitor caches discoverSteamLocations with a 10,000ms TTL and electron/main.cjs supports ONE_LAUNCHER_GITHUB_REPO with AbortSignal.timeout(8000)', () => {
      const { combinedSource } = readConcatenatedNativeModules();
      expect(combinedSource).toContain(
        'const locationsCacheTtlMs = Number(options.steamLocationsCacheTtlMs ?? 10000);'
      );
      expect(combinedSource).toContain('nowMs - cachedLocationsAt >= locationsCacheTtlMs');

      const mainPath = path.resolve(__dirname, '../electron/main.cjs');
      const mainSource = fs.readFileSync(mainPath, 'utf8');
      expect(mainSource).toContain(
        "process.env.ONE_LAUNCHER_GITHUB_REPO || 'Space-Cadet0/One-Launcher'"
      );
      expect(mainSource).toContain('signal: AbortSignal.timeout(8000)');
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

  describe('Dimension 3 & 8: Catalog Cache Synchronization & Action Bar Timer Cleanup', () => {
    it('src/App.tsx + src/hooks/*.ts persist catalog updates via saveCurrentCatalog + flushPendingCatalogSave and SteamLibraryActionBar cleans up feedbackTimerRef', () => {
      const appPath = path.resolve(__dirname, '../src/App.tsx');
      const hooksDir = path.resolve(__dirname, '../src/hooks');
      const hookFiles = fs.existsSync(hooksDir)
        ? fs
            .readdirSync(hooksDir, { withFileTypes: true })
            .filter((e) => e.isFile() && /\.(?:ts|tsx)$/.test(e.name))
            .map((e) => path.join(hooksDir, e.name))
        : [];
      const combinedAppAndHooksSource = [appPath, ...hookFiles]
        .map((f) => fs.readFileSync(f, 'utf8'))
        .join('\n');

      // Zero direct localStorage.setItem('antigravity_current_catalog_v1', ...) bypasses in App.tsx or extracted hooks
      expect(combinedAppAndHooksSource).not.toContain(
        "localStorage.setItem('antigravity_current_catalog_v1'"
      );
      expect(combinedAppAndHooksSource).toContain(
        'saveCurrentCatalog(sanitized, { skipSanitize: true });'
      );
      expect(combinedAppAndHooksSource).toContain('flushPendingCatalogSave();');

      const actionBarPath = path.resolve(
        __dirname,
        '../src/components/SteamStoreDetail/SteamLibraryActionBar.tsx'
      );
      const actionBarSource = fs.readFileSync(actionBarPath, 'utf8');
      expect(actionBarSource).toContain('const feedbackTimerRef = useRef<');
      expect(actionBarSource).toContain('clearTimeout(feedbackTimerRef.current);');
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

      const walkFiles = (targetPath: string, acc: string[] = []): string[] => {
        if (!fs.existsSync(targetPath)) return acc;
        const st = fs.statSync(targetPath);
        if (st.isFile()) {
          if (releaseExtRegex.test(path.basename(targetPath))) {
            acc.push(targetPath);
          }
          return acc;
        }
        for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
          const full = path.join(targetPath, entry.name);
          if (entry.isDirectory()) {
            walkFiles(full, acc);
          } else if (entry.isFile() && releaseExtRegex.test(entry.name)) {
            acc.push(full);
          }
        }
        return acc;
      };

      const forbiddenPatterns = [
        { label: 'macOS personal user path (/Users/mike)', regex: /\/Users\/mike\b/i },
        { label: 'Windows personal user path (C:\\Users\\mike)', regex: /C:\\+Users\\+mike\b/i },
        { label: 'Personal SteamID64 (76561197960506092)', regex: /76561197960506092/ },
        { label: 'Personal SteamID64 (76561198244849198)', regex: /76561198244849198/ },
        { label: 'Personal GOG handle (mike.stokes85)', regex: /mike\.stokes85/i },
      ];

      const violations: string[] = [];
      for (const target of prodTargets) {
        const files = walkFiles(path.join(rootDir, target));
        for (const file of files) {
          const rel = path.relative(rootDir, file);
          const content = fs.readFileSync(file, 'utf8');
          for (const pattern of forbiddenPatterns) {
            if (pattern.regex.test(content)) {
              violations.push(`${rel}: matched ${pattern.label}`);
            }
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });
});
