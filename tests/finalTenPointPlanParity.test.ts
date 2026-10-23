import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToString } from 'react-dom/server';

import { resolveEffectiveLaunchPolicy as resolveEffectiveLaunchPolicyTs } from '../src/contracts/launchPolicyResolver';
import { RequestScheduler, RequestPriority } from '../src/services/network/requestScheduler';
import type { CanonicalGame as Game } from '../src/contracts/game';
import type { CompatibilityLayerInfo } from '../src/contracts/launcher';

// ============================================================================
// Minimal Browser Globals & React 19 Stateful VNode Harness (Zero-jsdom)
// ============================================================================

class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
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

const initialMockStorage = new MockStorage();
if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = initialMockStorage;
}
if (typeof (globalThis as any).CustomEvent === 'undefined') {
  (globalThis as any).CustomEvent = class CustomEvent<T = any> {
    type: string;
    detail: T;
    constructor(type: string, params?: { detail?: T }) {
      this.type = type;
      this.detail = params?.detail as T;
    }
  };
}
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = {
    localStorage: initialMockStorage,
    location: { hostname: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
}

import { launcherService } from '../src/services/launcher/launcherService';
import { GameLaunchConfigModal } from '../src/components/Launcher/GameLaunchConfigModal';

const require = createRequire(import.meta.url);
const launcherEngine = require('../electron/launcherEngine.cjs');
const wineManager = require('../electron/launcher/wineAndCrossOverManager.cjs');

interface MountedTree {
  vnode: any;
  html: string;
  rerender: () => void;
  findByProp: (predicate: (props: Record<string, any>, type: any) => boolean) => any[];
}

function createStatefulRenderer<P extends object>(
  Component: React.FC<P>,
  getProps: () => P
): MountedTree {
  const states: any[] = [];
  const refs: { current: any }[] = [];
  let cursor = 0;
  let refCursor = 0;

  const reactAny = React as any;
  const internals =
    reactAny.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
    reactAny.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

  const evalTree = (): { vnode: any; html: string } => {
    cursor = 0;
    refCursor = 0;
    const prevDispatcher = internals.H;

    const dispatcher = {
      useState(initialState: any) {
        const idx = cursor++;
        if (!(idx in states)) {
          states[idx] = typeof initialState === 'function' ? initialState() : initialState;
        }
        const setState = (action: any) => {
          const next = typeof action === 'function' ? action(states[idx]) : action;
          states[idx] = next;
        };
        return [states[idx], setState];
      },
      useEffect() {},
      useLayoutEffect() {},
      useCallback(cb: any) {
        return cb;
      },
      useMemo(factory: () => any) {
        return factory();
      },
      useRef(initialValue: any) {
        const rIdx = refCursor++;
        if (!(rIdx in refs)) {
          refs[rIdx] = { current: initialValue };
        }
        return refs[rIdx];
      },
      useContext(ctx: any) {
        return ctx._currentValue;
      },
    };

    let vnode: any;
    internals.H = dispatcher;
    try {
      vnode = Component(getProps());
    } finally {
      internals.H = prevDispatcher;
    }

    const html = vnode ? renderToString(vnode) : '';
    return { vnode, html };
  };

  const walk = (
    node: any,
    predicate: (props: Record<string, any>, type: any) => boolean,
    acc: any[] = []
  ): any[] => {
    if (!node || typeof node !== 'object') return acc;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, predicate, acc);
      return acc;
    }
    if (node.props && predicate(node.props, node.type)) {
      acc.push(node);
    }
    if (node.props && node.props.children) {
      walk(node.props.children, predicate, acc);
    }
    return acc;
  };

  let current = evalTree();

  return {
    get vnode() {
      return current.vnode;
    },
    get html() {
      return current.html;
    },
    rerender() {
      current = evalTree();
    },
    findByProp(predicate) {
      return walk(current.vnode, predicate, []);
    },
  };
}

function createFakePeBinary(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const buf = Buffer.alloc(512, 0);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'ascii');
  buf.writeUInt16LE(0x8664, 0x84);
  fs.writeFileSync(filePath, buf);
}

function createFakeMachOBinary(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const buf = Buffer.alloc(128, 0);
  buf.writeUInt32LE(0xfeedfacf, 0);
  fs.writeFileSync(filePath, buf, { mode: 0o755 });
}

function createMockChildProcess(pid = 51500): EventEmitter & {
  pid: number;
  killed: boolean;
  kill: (sig?: string | number) => boolean;
  unref: () => void;
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const child = new EventEmitter() as any;
  child.pid = pid;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = vi.fn();
  child.kill = vi.fn((sig?: string | number) => {
    if (sig !== 0) {
      child.killed = true;
    }
    return true;
  });
  return child;
}

function makeJsonResponse(obj: unknown) {
  const raw = Buffer.from(JSON.stringify(obj), 'utf8');
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => raw.toString('utf8'),
    arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
  };
}

function setupMockCrossOverApp(
  rootDir: string,
  homeRoot: string,
  bottleNames: string[]
): {
  appsDir: string;
  crossoverApp: string;
  bottlesRoot: string;
  wineBinary: string;
  wineserverBinary: string;
} {
  const appsDir = path.join(rootDir, 'FakeApplications');
  const crossoverApp = path.join(appsDir, 'CrossOver.app');
  const macosDir = path.join(crossoverApp, 'Contents', 'MacOS');
  const wineBinDir = path.join(
    crossoverApp,
    'Contents',
    'SharedSupport',
    'CrossOver',
    'bin'
  );
  const bottlesRoot = path.join(
    homeRoot,
    'Library',
    'Application Support',
    'CrossOver',
    'Bottles'
  );
  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(wineBinDir, { recursive: true });

  const cxBin = path.join(macosDir, 'CrossOver');
  const wineBinary = path.join(wineBinDir, 'wine');
  const wineserverBinary = path.join(wineBinDir, 'wineserver');
  fs.writeFileSync(cxBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(wineBinary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(wineserverBinary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  fs.writeFileSync(
    path.join(crossoverApp, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>25.0.0</string>
</dict></plist>`
  );

  for (const bName of bottleNames) {
    const bDir = path.join(bottlesRoot, bName);
    fs.mkdirSync(path.join(bDir, 'drive_c', 'windows', 'system32'), { recursive: true });
    fs.mkdirSync(path.join(bDir, 'drive_c', 'users', 'crossover', 'Documents'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(bDir, 'system.reg'), 'WINE REGISTRY Version 2\n');
    fs.writeFileSync(path.join(bDir, 'user.reg'), 'WINE REGISTRY Version 2\n');
  }

  return { appsDir, crossoverApp, bottlesRoot, wineBinary, wineserverBinary };
}

describe('10-Dimension Codebase Hardening Plan — Final Parity Suite (T1–T13)', () => {
  let tmpDir: string;
  let userDataDir: string;
  let homedir: string;
  let originalLocalStorage: any;
  let originalWindow: any;
  let originalCustomEvent: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ten-point-'));
    userDataDir = path.join(tmpDir, 'userData');
    homedir = path.join(tmpDir, 'home_player_one');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(homedir, { recursive: true });

    launcherEngine.setUserDataDir(userDataDir);
    launcherEngine.clearCachedWindowsKnownFolders();
    launcherEngine.clearDownloadQueue();

    originalLocalStorage = (globalThis as any).localStorage;
    originalWindow = (globalThis as any).window;
    originalCustomEvent = (globalThis as any).CustomEvent;

    const mockStorage = new MockStorage();
    (globalThis as any).localStorage = mockStorage;

    if (typeof (globalThis as any).CustomEvent === 'undefined') {
      (globalThis as any).CustomEvent = class CustomEvent<T = any> {
        type: string;
        detail: T;
        constructor(type: string, params?: { detail?: T }) {
          this.type = type;
          this.detail = params?.detail as T;
        }
      };
    }

    (globalThis as any).window = {
      ...(originalWindow || {}),
      localStorage: mockStorage,
      location: { hostname: '' },
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });

  afterEach(() => {
    launcherEngine.shutdownLauncherEngine();
    launcherEngine.clearDownloadQueue();
    launcherEngine.clearCachedWindowsKnownFolders();
    vi.restoreAllMocks();

    (globalThis as any).localStorage = originalLocalStorage;
    (globalThis as any).window = originalWindow;
    (globalThis as any).CustomEvent = originalCustomEvent;

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // ==========================================================================
  // T1: Rapid stopGame -> immediate launchGame post-session cloud barrier
  // ==========================================================================
  it('T1: rapid stopGame -> immediate launchGame awaits post_exit cloud save upload before pre_launch download (zero save overwrite)', async () => {
    const gameDir = path.join(tmpDir, 'Games', 'CedarQuest.app', 'Contents', 'MacOS');
    const gameBin = path.join(gameDir, 'CedarQuest');
    createFakeMachOBinary(gameBin);

    const legCfgDir = path.join(userDataDir, 'legendaryConfig', 'legendary');
    fs.mkdirSync(legCfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(legCfgDir, 'installed.json'),
      JSON.stringify({
        CedarApp: {
          app_name: 'CedarApp',
          install_path: path.join(tmpDir, 'Games', 'CedarQuest.app'),
          platform: 'Mac',
        },
      })
    );

    const saveDir = path.join(homedir, 'Documents', 'My Games', 'CedarApp', 'Saves');
    fs.mkdirSync(saveDir, { recursive: true });
    const saveSlotPath = path.join(saveDir, 'slot0.sav');
    fs.writeFileSync(saveSlotPath, 'v1_initial_cloud_state', 'utf8');

    let remoteCloudState = 'v1_initial_cloud_state';
    const syncTimeline: string[] = [];
    const sessionEvents: any[] = [];
    const unsub = launcherEngine.onSessionUpdated((ev: any) => sessionEvents.push(ev));

    let spawnedCount = 0;
    const activePids = new Set<number>();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: any) => {
      const absPid = Math.abs(Number(pid));
      if (sig === 0) {
        if (activePids.has(absPid)) return true;
        const err: any = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
      activePids.delete(absPid);
      return true;
    }) as any);

    const spawnFn = vi.fn(() => {
      spawnedCount += 1;
      const pid = 61000 + spawnedCount;
      activePids.add(pid);
      return createMockChildProcess(pid);
    });

    let postExitStartedResolve!: () => void;
    const postExitStartedPromise = new Promise<void>((res) => {
      postExitStartedResolve = res;
    });

    const execFileImpl = vi.fn((_cmd: string, args: string[], _opts: any, cb?: any) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      const argList = Array.isArray(args) ? args : [];
      if (argList.includes('sync-saves')) {
        const isPreLaunch = argList.includes('--skip-upload');
        const isPostExit = argList.includes('--skip-download');
        if (isPreLaunch) {
          const callNum = syncTimeline.filter((x) => x.startsWith('pre_launch')).length / 2 + 1;
          syncTimeline.push(`pre_launch_${callNum}:start`);
          fs.writeFileSync(saveSlotPath, remoteCloudState, 'utf8');
          syncTimeline.push(`pre_launch_${callNum}:done`);
          callback?.(null, 'Sync complete', '');
          return;
        }
        if (isPostExit) {
          const exitNum = syncTimeline.filter((x) => x.startsWith('post_exit_')).length / 2 + 1;
          if (exitNum > 1) {
            callback?.(null, 'Uploaded save to Epic cloud', '');
            return;
          }
          syncTimeline.push('post_exit_1:start');
          postExitStartedResolve();
          setTimeout(() => {
            if (fs.existsSync(saveSlotPath)) {
              remoteCloudState = fs.readFileSync(saveSlotPath, 'utf8');
            }
            syncTimeline.push('post_exit_1:done');
            callback?.(null, 'Uploaded save to Epic cloud', '');
          }, 90);
          return;
        }
      }
      callback?.(null, '', '');
    });

    const commonOpts = {
      platform: 'darwin',
      homedir,
      userDataDir,
      legendaryConfigDir: legCfgDir,
      legendaryBinaryPath: 'legendary',
      epicAccountId: 'acct_player_one',
      skipAuthRefresh: true,
      cloudSaveFolderTemplate: '{UserDir}/My Games/CedarApp/Saves',
      spawnFn,
      execFileImpl,
    };

    const payload = {
      gameId: 'epic-cedar-barrier',
      title: 'Cedar Quest',
      platformId: 'epic',
      platformGameId: 'CedarApp',
      installPath: path.join(tmpDir, 'Games', 'CedarQuest.app'),
      executablePath: gameBin,
      launchMethod: 'direct',
    };

    try {
      const launch1 = await launcherEngine.launchGame(payload, commonOpts);
      expect(launch1.success).toBe(true);
      expect(syncTimeline).toEqual(['pre_launch_1:start', 'pre_launch_1:done']);

      // Player progresses during Session 1 and writes new save data
      fs.writeFileSync(saveSlotPath, 'v2_progress_from_session_1', 'utf8');

      // Stop Session 1 — triggers finalizeGameSession -> async post_exit upload (90ms)
      const stopRes = await launcherEngine.stopGame({ gameId: 'epic-cedar-barrier' }, commonOpts);
      expect(stopRes.success).toBe(true);
      await postExitStartedPromise;

      // Immediately relaunch while post_exit_1 is STILL uploading!
      expect(syncTimeline).toEqual(['pre_launch_1:start', 'pre_launch_1:done', 'post_exit_1:start']);
      const launch2 = await launcherEngine.launchGame(payload, commonOpts);
      expect(launch2.success).toBe(true);

      // Verify strict non-overlapping barrier order and preserved Session 1 save
      expect(syncTimeline).toEqual([
        'pre_launch_1:start',
        'pre_launch_1:done',
        'post_exit_1:start',
        'post_exit_1:done',
        'pre_launch_2:start',
        'pre_launch_2:done',
      ]);
      expect(fs.readFileSync(saveSlotPath, 'utf8')).toBe('v2_progress_from_session_1');
      expect(
        sessionEvents.some(
          (e) => e.statusMessage === 'Finishing previous cloud save upload...'
        )
      ).toBe(true);

      await launcherEngine.stopGame({ gameId: 'epic-cedar-barrier' }, commonOpts);
    } finally {
      unsub();
      killSpy.mockRestore();
    }
  });

  // ==========================================================================
  // T2: Bidirectional CrossOver bottle lock & post-cloud download resume deferral
  // ==========================================================================
  it('T2: CrossOver bottle lock prevents Session 1 delayed wineserver -k from killing Session 2, and defers download resume until cloud upload settles', async () => {
    const cx = setupMockCrossOverApp(tmpDir, homedir, ['GamingBottle']);
    const bottlePath = path.join(cx.bottlesRoot, 'GamingBottle');
    const game1Exe = path.join(bottlePath, 'drive_c', 'Games', 'GameOne', 'GameOne.exe');
    const game2Exe = path.join(bottlePath, 'drive_c', 'Games', 'GameTwo', 'GameTwo.exe');
    createFakePeBinary(game1Exe);
    createFakePeBinary(game2Exe);

    const legCfgDir = path.join(userDataDir, 'legendaryConfig', 'legendary');
    fs.mkdirSync(legCfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(legCfgDir, 'installed.json'),
      JSON.stringify({
        BottleAppOne: {
          app_name: 'BottleAppOne',
          install_path: path.dirname(game1Exe),
          platform: 'Windows',
        },
        BottleAppTwo: {
          app_name: 'BottleAppTwo',
          install_path: path.dirname(game2Exe),
          platform: 'Windows',
        },
      })
    );

    const bottleSave1 = path.join(
      bottlePath,
      'drive_c',
      'users',
      'crossover',
      'Documents',
      'BottleAppOne'
    );
    fs.mkdirSync(bottleSave1, { recursive: true });
    fs.writeFileSync(path.join(bottleSave1, 'save.dat'), 'session1_save');

    // Start a real streaming GOG V1 download so downloadControllers has 'dl-bg-1', then pause it for in-game
    const bgInstallDir = path.join(tmpDir, 'BgDownloadInstall');
    const bgPayload = Buffer.from('BACKGROUND_DOWNLOAD_STREAM_PAYLOAD_BYTES_1234', 'utf8');
    let bgHangStream = true;
    const bgFetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      if (u.includes('/builds?generation=2')) {
        return makeJsonResponse({
          items: [
            {
              generation: 1,
              build_id: 'b500',
              legacy_build_id: 'lb500',
              link: 'https://cdn.gog.test/500/repository.json',
            },
          ],
        });
      }
      if (u.endsWith('/repository.json')) {
        return makeJsonResponse({
          product: {
            installDirectory: 'BgGame500',
            depots: [{ gameID: '500', manifest: 'depot.json', languages: ['en'] }],
          },
        });
      }
      if (u.endsWith('/depot.json')) {
        return makeJsonResponse({
          depot: { files: [{ path: 'bg.dat', offset: 0, size: bgPayload.length }] },
        });
      }
      if (u.includes('/secure_link')) {
        return makeJsonResponse({ urls: ['https://cdn.gog.test/500/blobs'] });
      }
      if (u.endsWith('/main.bin')) {
        const signal: AbortSignal | undefined = init?.signal;
        if (bgHangStream) {
          const body = (async function* () {
            yield bgPayload.subarray(0, 12);
            await new Promise<void>((_, reject) => {
              const onAbort = () => {
                const abortErr: any = new Error('Aborted');
                abortErr.name = 'AbortError';
                reject(abortErr);
              };
              if (signal?.aborted) return onAbort();
              signal?.addEventListener('abort', onAbort, { once: true });
            });
          })();
          return { ok: true, status: 200, body };
        }
        const body = (async function* () {
          yield bgPayload;
        })();
        return { ok: true, status: 200, body };
      }
      throw new Error(`Unexpected BG URL: ${u}`);
    });

    await launcherEngine.installGame(
      {
        taskId: 'dl-bg-1',
        gameId: 'gog-500',
        platformId: 'gog',
        platformGameId: '500',
        title: 'Background Download',
        installDir: bgInstallDir,
        manualControl: true,
      },
      { userDataDir, homedir }
    );
    const bgDlPromise = launcherEngine
      .downloadGogV1Depot(
        {
          taskId: 'dl-bg-1',
          cleanId: '500',
          platformGameId: '500',
          title: 'Background Download',
          gogPlatformFlag: 'windows',
          finalInstallPath: bgInstallDir,
          gogToken: 'bg_tok',
          platform: 'darwin',
          totalBytes: bgPayload.length,
        },
        { fetchImpl: bgFetch, userDataDir, homedir }
      )
      .catch(() => {});

    for (
      let i = 0;
      i < 40 &&
      !(
        fs.existsSync(path.join(bgInstallDir, '.gog_v1_500_main.bin')) &&
        fs.statSync(path.join(bgInstallDir, '.gog_v1_500_main.bin')).size >= 12
      );
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    bgHangStream = false;

    let postExit1Started!: () => void;
    const postExit1StartedPromise = new Promise<void>((res) => {
      postExit1Started = res;
    });
    let releasePostExit1!: () => void;
    const releasePostExit1Promise = new Promise<void>((res) => {
      releasePostExit1 = res;
    });

    const wineShutdownCalls: string[] = [];
    const activePids = new Set<number>();
    const childrenByGame: Record<string, ReturnType<typeof createMockChildProcess>> = {};

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: any) => {
      const absPid = Math.abs(Number(pid));
      if (sig === 0) {
        if (activePids.has(absPid)) return true;
        const err: any = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
      activePids.delete(absPid);
      return true;
    }) as any);

    let nextPid = 62000;
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      nextPid += 1;
      const pid = nextPid;
      activePids.add(pid);
      const child = createMockChildProcess(pid);
      const joined = (args || []).join(' ');
      if (joined.includes('GameOne.exe')) {
        childrenByGame.s1 = child;
      } else {
        childrenByGame.s2 = child;
      }
      return child;
    });

    const execFileImpl = vi.fn((cmd: string, args: string[], _opts: any, cb?: any) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      const argList = Array.isArray(args) ? args : [];
      if (String(cmd).includes('wineserver') && argList.includes('-k')) {
        wineShutdownCalls.push(argList.join(' '));
        callback?.(null, '', '');
        return;
      }
      if (argList.includes('sync-saves') && argList.includes('--skip-download')) {
        postExit1Started();
        releasePostExit1Promise.then(() => {
          callback?.(null, 'Uploaded bottle save', '');
        });
        return;
      }
      callback?.(null, '', '');
    });

    let resumedDuringCloudUpload = false;
    let cloudUploadStillRunning = false;
    const unsubDl = launcherEngine.onDownloadUpdated((ev: any) => {
      if (
        cloudUploadStillRunning &&
        ev?.task?.taskId === 'dl-bg-1' &&
        ev?.task?.status === 'downloading'
      ) {
        resumedDuringCloudUpload = true;
      }
    });

    const commonBottleOpts = {
      platform: 'darwin',
      homedir,
      userDataDir,
      customApplicationsDir: cx.appsDir,
      legendaryConfigDir: legCfgDir,
      legendaryBinaryPath: 'legendary',
      epicAccountId: 'acct_player_one',
      skipAuthRefresh: true,
      spawnFn,
      gameSpawnFn: spawnFn,
      execFileImpl,
      onWinePrefixShutdown: (prefix: string) => wineShutdownCalls.push(`callback:${prefix}`),
    };

    try {
      // 1. Launch Session 1 inside GamingBottle (automatically pauses active download 'dl-bg-1' for in-game!)
      const l1 = await launcherEngine.launchGame(
        {
          gameId: 'epic-bottle-s1',
          title: 'Game One',
          platformId: 'epic',
          platformGameId: 'BottleAppOne',
          installPath: path.dirname(game1Exe),
          executablePath: game1Exe,
          isWindowsBinaryOnMac: true,
          launchConfig: {
            launchMethod: 'compatibility_layer',
            compatibilityLayer: 'crossover',
            wineBottleName: 'GamingBottle',
            winePrefixPath: bottlePath,
            storefrontClientLifecycle: 'fast_direct_bypass',
          },
        },
        {
          ...commonBottleOpts,
          cloudSaveFolderTemplate: '{UserDir}/BottleAppOne',
        }
      );
      expect(l1.success).toBe(true);
      await bgDlPromise;
      expect(launcherEngine.getPausedByInGameTaskIds()).toContain('dl-bg-1');

      // Simulate natural exit of Session 1 (exitCode 0) -> triggers post_exit cloud sync + chained shutdownWinePrefix
      cloudUploadStillRunning = true;
      activePids.delete(childrenByGame.s1.pid);
      childrenByGame.s1.emit('exit', 0, null);
      await postExit1StartedPromise;

      // While Session 1 post_exit cloud upload is in flight, background downloads MUST remain paused!
      const midQueue = launcherEngine.getDownloadQueue();
      const bgTaskMid = midQueue.find((t: any) => t.taskId === 'dl-bg-1');
      expect(bgTaskMid?.status).toBe('paused');
      expect(resumedDuringCloudUpload).toBe(false);

      // 2. Launch Session 2 targeting the SAME bottle while Session 1 is still uploading saves
      let session2Resolved = false;
      const l2Promise = launcherEngine
        .launchGame(
          {
            gameId: 'epic-bottle-s2',
            title: 'Game Two',
            platformId: 'epic',
            platformGameId: 'BottleAppTwo',
            installPath: path.dirname(game2Exe),
            executablePath: game2Exe,
            isWindowsBinaryOnMac: true,
            launchConfig: {
              launchMethod: 'compatibility_layer',
              compatibilityLayer: 'crossover',
              wineBottleName: 'GamingBottle',
              winePrefixPath: bottlePath,
              storefrontClientLifecycle: 'fast_direct_bypass',
            },
          },
          {
            ...commonBottleOpts,
            skipCloudSaveSync: true,
          }
        )
        .then((res: any) => {
          session2Resolved = true;
          return res;
        });

      await new Promise((r) => setTimeout(r, 35));
      // Session 2 is blocked on the bottle barrier while Session 1 finishes cloud save upload
      expect(session2Resolved).toBe(false);

      // Release Session 1's cloud upload -> Session 1's delayed shutdownWinePrefix must detect Session 2's pendingBottleLaunches and NOT run wineserver -k!
      cloudUploadStillRunning = false;
      releasePostExit1();
      const l2 = await l2Promise;
      expect(l2.success).toBe(true);
      expect(wineShutdownCalls).toEqual([]);

      await launcherEngine.stopGame(
        { gameId: 'epic-bottle-s2' },
        { ...commonBottleOpts, skipCloudSaveSync: true }
      );

      // Once all active sessions and post-session barriers complete, paused in-game downloads resume!
      for (let i = 0; i < 40 && launcherEngine.getPausedByInGameTaskIds().length > 0; i++) {
        await new Promise((r) => setTimeout(r, 15));
      }
      expect(launcherEngine.getPausedByInGameTaskIds()).toEqual([]);
    } finally {
      unsubDl();
      killSpy.mockRestore();
    }
  });

  // ==========================================================================
  // T3: Ephemeral client shutdown grace cancellation on rapid relaunch
  // ==========================================================================
  it('T3: cancels ephemeral storefront client shutdown immediately when a new game launches during the grace window', async () => {
    const gameDir = path.join(tmpDir, 'Games', 'FastPortal.app', 'Contents', 'MacOS');
    const gameBin = path.join(gameDir, 'FastPortal');
    createFakeMachOBinary(gameBin);

    const activePids = new Set<number>();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: any) => {
      const absPid = Math.abs(Number(pid));
      if (sig === 0) {
        if (activePids.has(absPid)) return true;
        const err: any = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
      activePids.delete(absPid);
      return true;
    }) as any);

    const shutdownExecCalls: string[] = [];
    const execFileImpl = vi.fn((cmd: string, args: string[], _opts: any, cb?: any) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      shutdownExecCalls.push(`${cmd} ${(args || []).join(' ')}`);
      callback?.(null, '', '');
    });

    const spawnFn = vi.fn(() => {
      activePids.add(63001);
      return createMockChildProcess(63001);
    });

    try {
      const startedAt = Date.now();
      const shutdownPromise = launcherEngine.shutdownEphemeralStorefrontClient(
        {
          session: { gameId: 'steam-prev-1', platformId: 'steam', platformGameId: '400' },
          wokeSteamByLauncher: true,
          steamAppId: '400',
        },
        {
          platform: 'darwin',
          homedir,
          cloudSyncGraceMs: 450,
          execFileImpl,
        }
      );

      // Launch a new Steam game 30ms into the 450ms grace window
      await new Promise((r) => setTimeout(r, 30));
      const launchRes = await launcherEngine.launchGame(
        {
          gameId: 'steam-grace-cancel-2',
          title: 'Fast Portal',
          platformId: 'steam',
          platformGameId: '620',
          installPath: path.join(tmpDir, 'Games', 'FastPortal.app'),
          executablePath: gameBin,
          launchMethod: 'direct',
        },
        {
          platform: 'darwin',
          homedir,
          userDataDir,
          skipCloudSaveSync: true,
          spawnFn,
        }
      );
      expect(launchRes.success).toBe(true);

      const shutdownRes = await shutdownPromise;
      const elapsedMs = Date.now() - startedAt;

      expect(shutdownRes.closed).toBe(false);
      expect(shutdownRes.shutDown).toBe(false);
      expect(shutdownRes.reason).toBe('other_session_active');
      expect(elapsedMs).toBeLessThan(280);
      expect(shutdownExecCalls).toEqual([]);

      await launcherEngine.stopGame(
        { gameId: 'steam-grace-cancel-2' },
        { platform: 'darwin', skipCloudSaveSync: true }
      );
    } finally {
      killSpy.mockRestore();
    }
  });

  // ==========================================================================
  // T4: Windows 10/11 OneDrive Known Folder Redirection (GOG & Epic)
  // ==========================================================================
  it('T4: resolves Windows 10/11 OneDrive Documents and redirected D:\\Saved Games via User Shell Folders for both GOG and Epic cloud saves', () => {
    const winHome = 'C:\\Users\\player_one';
    const rawRegOutput = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
      '    Personal    REG_EXPAND_SZ    %OneDrive%\\Documents',
      '    {4C5C32FF-BB9D-43B0-B5B4-2D72E54EAAA4}    REG_SZ    D:\\Saved Games',
      '    AppData    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Roaming',
      '    Local AppData    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local',
    ].join('\r\n');

    const winEnv = {
      USERPROFILE: winHome,
      OneDrive: 'C:\\Users\\player_one\\OneDrive',
      APPDATA: 'C:\\Users\\player_one\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\player_one\\AppData\\Local',
    };

    const known = launcherEngine.resolveHostWindowsKnownFolders({
      platform: 'win32',
      homedir: winHome,
      env: winEnv,
      windowsRegistryOutput: rawRegOutput,
    });

    expect(known.documents).toBe('C:\\Users\\player_one\\OneDrive\\Documents');
    expect(known.savedGames).toBe('D:\\Saved Games');

    // GOG cloud save location resolution with OneDrive Documents & D:\Saved Games
    const gogLocations = launcherEngine.resolveGogCloudSaveLocations(
      [
        { name: 'saves_docs', location: '<?DOCUMENTS?>/CD Projekt Red/The Witcher 3/gamesaves' },
        { name: 'saves_sg', location: '<?SAVED_GAMES?>/CD Projekt Red/Cyberpunk 2077' },
      ],
      {
        platform: 'win32',
        homedir: winHome,
        env: winEnv,
        windowsRegistryOutput: rawRegOutput,
        installPath: 'C:\\Games\\OneLauncher\\GOG\\Witcher3',
      }
    );

    expect(gogLocations).toEqual([
      {
        name: 'saves_docs',
        location: '<?DOCUMENTS?>/CD Projekt Red/The Witcher 3/gamesaves',
        resolvedPath:
          'C:\\Users\\player_one\\OneDrive\\Documents\\CD Projekt Red\\The Witcher 3\\gamesaves',
      },
      {
        name: 'saves_sg',
        location: '<?SAVED_GAMES?>/CD Projekt Red/Cyberpunk 2077',
        resolvedPath: 'D:\\Saved Games\\CD Projekt Red\\Cyberpunk 2077',
      },
    ]);

    // Epic CloudSaveFolder template resolution with OneDrive Documents & D:\Saved Games
    const epicDocsSave = launcherEngine.resolveEpicSavePathTemplate(
      '{UserDir}/My Games/Rocket League/TAGame/SaveData',
      {
        platform: 'win32',
        homedir: winHome,
        env: winEnv,
        windowsRegistryOutput: rawRegOutput,
        epicAccountId: 'acct_player_one',
      }
    );
    expect(epicDocsSave).toBe(
      'C:\\Users\\player_one\\OneDrive\\Documents\\My Games\\Rocket League\\TAGame\\SaveData'
    );

    const epicSavedGames = launcherEngine.resolveEpicSavePathTemplate(
      '{UserSavedGames}/Hades/Saves',
      {
        platform: 'win32',
        homedir: winHome,
        env: winEnv,
        windowsRegistryOutput: rawRegOutput,
      }
    );
    expect(epicSavedGames).toBe('D:\\Saved Games\\Hades\\Saves');
  });

  // ==========================================================================
  // T5: Case-sensitive APFS drive_c/users, \xNN/\uNNNN unescaping & dosdevices/z:
  // ==========================================================================
  it('T5: resolves lowercase drive_c/users on APFS, unescapes \\xNN/\\uNNNN Wine .reg strings, pre-scans regUser, and follows dosdevices/z:', () => {
    const bottleDir = path.join(tmpDir, 'APFSBottle');
    const actualLowercaseDocs = path.join(
      bottleDir,
      'drive_c',
      'users',
      'crossover',
      'Documents',
      'Jos\u00e9Saves'
    );
    const actualLowercaseSavedGames = path.join(
      bottleDir,
      'drive_c',
      'users',
      'crossover',
      'Saved Games'
    );
    fs.mkdirSync(actualLowercaseDocs, { recursive: true });
    fs.mkdirSync(actualLowercaseSavedGames, { recursive: true });

    // Create custom Z: drive target and symlink <bottle>/dosdevices/z: -> customZRoot
    const customZRoot = path.join(tmpDir, 'z_drive_host_target');
    const sharedMacFolder = path.join(customZRoot, 'SharedCloudSaves', 'Caf\u00e9Profile');
    fs.mkdirSync(sharedMacFolder, { recursive: true });
    const dosdevicesDir = path.join(bottleDir, 'dosdevices');
    fs.mkdirSync(dosdevicesDir, { recursive: true });
    fs.symlinkSync(customZRoot, path.join(dosdevicesDir, 'z:'));

    const userRegContent = [
      'WINE REGISTRY Version 2',
      '',
      '[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\User Shell Folders] 1700000000',
      '"Personal"="C:\\\\Users\\\\crossover\\\\Documents\\\\Jos\\xc3\\xa9Saves"',
      '"{4C5C32FF-BB9D-43B0-B5B4-2D72E54EAAA4}"="%USERPROFILE%\\\\Saved Games"',
      '"AppData"="Z:\\\\SharedCloudSaves\\\\Caf\\u00e9Profile"',
      '',
      '[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\Shell Folders] 1700000000',
      '"My Music"="C:\\\\users\\\\crossover\\\\Music"',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(bottleDir, 'user.reg'), userRegContent, 'utf8');

    expect(wineManager.unescapeWineRegString('Jos\\xc3\\xa9_\\u00e9')).toBe('José_é');

    const folders = launcherEngine.readWinePrefixShellFolders(bottleDir);
    expect(folders).not.toBeNull();
    // Matches existing lowercase `users` on disk instead of creating split uppercase `Users`
    expect(folders.documents).toBe(actualLowercaseDocs);
    expect(folders.savedGames).toBe(actualLowercaseSavedGames);
    // Resolves Z:\ via <bottle>/dosdevices/z: realpath
    expect(folders.appDataRoaming || folders.appdataRoaming).toBe(fs.realpathSync(sharedMacFolder));
  });

  // ==========================================================================
  // T6: macOS native Steam waitForSteamCloudSyncCompletion when steamRoot === ''
  // ==========================================================================
  it('T6: macOS native Steam waitForSteamCloudSyncCompletion tails ~/Library/Application Support/Steam/logs/cloud_log.txt when steamRoot is empty', async () => {
    const steamLogsDir = path.join(homedir, 'Library', 'Application Support', 'Steam', 'logs');
    fs.mkdirSync(steamLogsDir, { recursive: true });
    const cloudLogPath = path.join(steamLogsDir, 'cloud_log.txt');

    fs.writeFileSync(
      cloudLogPath,
      '[2026-10-23 12:00:01] [AppID 620] Uploading file savegame_01.sav\n',
      'utf8'
    );

    const startMs = Date.now();
    const appendTimer = setTimeout(() => {
      fs.appendFileSync(
        cloudLogPath,
        '[2026-10-23 12:00:02] [AppID 620] Syncing to Steam Cloud succeeded\n',
        'utf8'
      );
    }, 65);

    try {
      const res = await launcherEngine.waitForSteamCloudSyncCompletion('', '620', {
        platform: 'darwin',
        homedir,
        pollIntervalMs: 20,
        maxCloudWaitMs: 1000,
      });
      const elapsedMs = Date.now() - startMs;

      expect(res.completed).toBe(true);
      expect(res.reason).toBe('cloud_sync_completed');
      expect(elapsedMs).toBeGreaterThanOrEqual(45);
    } finally {
      clearTimeout(appendTimer);
    }
  });

  // ==========================================================================
  // T7: Path-traversal & symlink-slip rejection across GOG, Epic & V1 Depot
  // ==========================================================================
  it('T7: blocks ../../ path traversal, unanchored paths, and symlink-slip escapes across GOG saves, Epic saves, and downloadGogV1Depot', async () => {
    const winKnownFolders = {
      documents: 'C:\\Users\\player_one\\Documents',
      savedGames: 'C:\\Users\\player_one\\Saved Games',
      roamingAppData: 'C:\\Users\\player_one\\AppData\\Roaming',
      localAppData: 'C:\\Users\\player_one\\AppData\\Local',
      localLowAppData: 'C:\\Users\\player_one\\AppData\\LocalLow',
    };

    // 1. GOG Cloud Save traversal & unanchored rejection vs legitimate sibling AppData hop
    const gogRes = launcherEngine.resolveGogCloudSaveLocations(
      [
        { name: 'traversal_escape', location: '<?DOCUMENTS?>/../../etc/passwd' },
        { name: 'unanchored_abs', location: '/etc/shadow' },
        { name: 'raw_relative', location: 'saves/slot1' },
        {
          name: 'valid_locallow',
          location: '<?APPLICATION_DATA_LOCAL?>/../LocalLow/Owlcat Games/Rogue Trader',
        },
      ],
      {
        platform: 'win32',
        homedir: 'C:\\Users\\player_one',
        windowsKnownFolders: winKnownFolders,
        installPath: 'C:\\Games\\OneLauncher\\RogueTrader',
      }
    );

    expect(gogRes.map((r: any) => r.name)).toEqual(['valid_locallow']);
    expect(gogRes[0].resolvedPath).toBe(
      'C:\\Users\\player_one\\AppData\\LocalLow\\Owlcat Games\\Rogue Trader'
    );

    // 2. Epic Cloud Save template traversal & unanchored rejection vs legitimate {AppData}/../LocalLow
    expect(
      launcherEngine.resolveEpicSavePathTemplate('{UserDir}/../../../Windows/System32', {
        platform: 'win32',
        homedir: 'C:\\Users\\player_one',
        windowsKnownFolders: winKnownFolders,
      })
    ).toBe('');
    expect(
      launcherEngine.resolveEpicSavePathTemplate('/var/root/unauthorized', {
        platform: 'darwin',
        homedir,
      })
    ).toBe('');
    const validEpicLocalLow = launcherEngine.resolveEpicSavePathTemplate(
      '{AppData}/../LocalLow/TeamCherry/HollowKnight',
      {
        platform: 'win32',
        homedir: 'C:\\Users\\player_one',
        windowsKnownFolders: winKnownFolders,
      }
    );
    expect(validEpicLocalLow).toBe(
      'C:\\Users\\player_one\\AppData\\LocalLow\\TeamCherry\\HollowKnight'
    );

    // 3. downloadGogV1Depot traversal file & symlink-slip rejection
    const v1InstallRoot = path.join(tmpDir, 'GogV1Container', 'SafeDepotGame');
    const escapedTargetFile = path.join(tmpDir, 'outside_pwned.txt');
    const payloadBytes = Buffer.from('SAFE_CONFIG_PAYLOAD_evil_ignored_OK', 'utf8');

    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/builds?generation=2')) {
        return makeJsonResponse({
          items: [
            {
              generation: 1,
              build_id: 'b100',
              legacy_build_id: 'lb100',
              link: 'https://cdn.gog.test/v1/meta/repository.json',
            },
          ],
        });
      }
      if (u.endsWith('/repository.json')) {
        return makeJsonResponse({
          product: {
            installDirectory: 'SafeDepotGame',
            depots: [{ gameID: '77001', manifest: 'depot_main.json', languages: ['en'] }],
          },
        });
      }
      if (u.endsWith('/depot_main.json')) {
        return makeJsonResponse({
          depot: {
            files: [
              { path: 'readme.txt', offset: 33, size: 2 },
              { path: 'GameData/config.ini', offset: 0, size: 19 },
              { path: '../../outside_pwned.txt', offset: 19, size: 13 },
              { path: 'GameData/bad_symlink', symlinkType: 'file', target: '../../../etc/passwd' },
              { path: 'GameData/good_symlink', symlinkType: 'file', target: 'config.ini' },
            ],
          },
        });
      }
      if (u.includes('/secure_link')) {
        return makeJsonResponse({ urls: ['https://cdn.gog.test/v1/blobs'] });
      }
      if (u.endsWith('/main.bin')) {
        const body = (async function* () {
          yield payloadBytes;
        })();
        return { ok: true, status: 200, body };
      }
      throw new Error(`Unexpected URL in T7: ${u}`);
    });

    await launcherEngine.downloadGogV1Depot(
      {
        taskId: 'dl-t7-depot',
        cleanId: '77001',
        platformGameId: '77001',
        title: 'Safe Depot Game',
        gogPlatformFlag: 'windows',
        finalInstallPath: v1InstallRoot,
        gogToken: 'test_gog_token',
        platform: 'darwin',
        totalBytes: payloadBytes.length,
      },
      { fetchImpl, userDataDir, homedir }
    );

    expect(
      fs.readFileSync(path.join(v1InstallRoot, 'GameData', 'config.ini'), 'utf8')
    ).toBe('SAFE_CONFIG_PAYLOAD');
    expect(fs.existsSync(escapedTargetFile)).toBe(false);
    expect(fs.lstatSync(path.join(v1InstallRoot, 'GameData', 'good_symlink')).isSymbolicLink()).toBe(
      true
    );
    expect(fs.existsSync(path.join(v1InstallRoot, 'GameData', 'bad_symlink'))).toBe(false);
  });

  // ==========================================================================
  // T8: 0o600 CLI auth file permissions, zero global ~/.config writes & logout tombstones
  // ==========================================================================
  it('T8: enforces 0o600/icacls CLI auth permissions, never writes to ~/.config/legendary/user.json, and blocks resurrection via logout tombstones', async () => {
    const globalLegDir = path.join(homedir, '.config', 'legendary');
    fs.mkdirSync(globalLegDir, { recursive: true });
    const globalUserJson = path.join(globalLegDir, 'user.json');
    const externalSeedContent = JSON.stringify({
      access_token: 'external_cli_access_token_abcdef123456',
      refresh_token: 'external_cli_refresh_token_abcdef123456',
      account_id: 'ext_epic_acct_99',
      displayName: 'ExternalPlayer',
      expires_at: new Date(Date.now() + 7200 * 1000).toISOString(),
    });
    fs.writeFileSync(globalUserJson, externalSeedContent, { mode: 0o644 });

    const heroicGogDir = path.join(homedir, 'Library', 'Application Support', 'heroic', 'gog_store');
    fs.mkdirSync(heroicGogDir, { recursive: true });
    fs.writeFileSync(
      path.join(heroicGogDir, 'auth.json'),
      JSON.stringify({
        '46899977096215655': {
          access_token: 'external_heroic_gog_access_abcdef123456',
          refresh_token: 'external_heroic_gog_refresh_abcdef123456',
          user_id: '88001122',
          updatedAt: new Date().toISOString(),
        },
      })
    );

    const authOpts = {
      homedir,
      userDataDir,
      skipNetwork: true,
    };

    // 1. Write isolated One Launcher Epic & GOG helper auth files
    const epicRes = await launcherEngine.ensureLegendaryConfigAndAuth({
      ...authOpts,
      savedTokens: {
        epic: {
          access_token: 'isolated_ol_epic_access_1234567890',
          refresh_token: 'isolated_ol_epic_refresh_1234567890',
          account_id: 'ol_epic_acct_1',
          displayName: 'PlayerOne',
          expires_at: new Date(Date.now() + 7200 * 1000).toISOString(),
        },
      },
    });

    expect(epicRes.authenticated).toBe(true);
    expect(epicRes.userFilePath.startsWith(userDataDir)).toBe(true);
    expect(fs.existsSync(epicRes.userFilePath)).toBe(true);

    // Verify 0o600 file mode and 0o700 directory mode on POSIX
    const fileMode = fs.statSync(epicRes.userFilePath).mode & 0o777;
    const dirMode = fs.statSync(path.dirname(epicRes.userFilePath)).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);

    // Global ~/.config/legendary/user.json must NEVER be overwritten by One Launcher
    expect(fs.readFileSync(globalUserJson, 'utf8')).toBe(externalSeedContent);

    // Verify Windows icacls ACL hardening call on win32 simulation
    const icaclsCalls: string[][] = [];
    const winSecureFile = path.join(userDataDir, 'win_acl_test', 'auth.json');
    launcherEngine.atomicWriteSecureFileSync(winSecureFile, '{"secret":true}', {
      platform: 'win32',
      enforceWindowsAclInTest: true,
      username: 'player_one',
      execFileImpl: (cmd: string, args: string[], _opts: any, cb?: any) => {
        icaclsCalls.push([cmd, ...args]);
        (typeof _opts === 'function' ? _opts : cb)?.(null, '', '');
      },
    });
    expect(icaclsCalls.length).toBe(1);
    expect(icaclsCalls[0][0]).toBe('icacls');
    expect(icaclsCalls[0]).toContain('/inheritance:r');
    expect(icaclsCalls[0]).toContain('player_one:(F)');

    // 2. Disconnect Epic & GOG -> purge helper files + record disconnected tombstone
    const gogResInitial = await launcherEngine.ensureGogdlAuthConfig(authOpts);
    expect(gogResInitial.authenticated).toBe(true);
    expect(fs.existsSync(gogResInitial.gogAuthPath)).toBe(true);
    expect(fs.statSync(gogResInitial.gogAuthPath).mode & 0o777).toBe(0o600);

    launcherEngine.purgeStoreHelperCredentials('epic', authOpts);
    launcherEngine.purgeStoreHelperCredentials('gog', authOpts);

    expect(fs.existsSync(epicRes.userFilePath)).toBe(false);
    expect(fs.existsSync(gogResInitial.gogAuthPath)).toBe(false);
    expect(launcherEngine.isStoreDisconnectedTombstoned('epic', authOpts)).toBe(true);
    expect(launcherEngine.isStoreDisconnectedTombstoned('gog', authOpts)).toBe(true);

    // 3. Even though external Heroic & ~/.config/legendary tokens still exist on disk,
    //    ensureLegendaryConfigAndAuth & ensureGogdlAuthConfig must NOT resurrect them!
    const epicAfterLogout = await launcherEngine.ensureLegendaryConfigAndAuth({
      ...authOpts,
      storeSync: { loadSavedTokens: () => ({}) },
    });
    expect(epicAfterLogout.authenticated).toBe(false);
    expect(epicAfterLogout.disconnectedByUser).toBe(true);
    expect(fs.existsSync(epicRes.userFilePath)).toBe(false);

    const gogAfterLogout = await launcherEngine.ensureGogdlAuthConfig({
      ...authOpts,
      storeSync: { loadSavedTokens: () => ({}) },
    });
    expect(gogAfterLogout.authenticated).toBe(false);
    expect(gogAfterLogout.disconnectedByUser).toBe(true);
    expect(fs.existsSync(gogResInitial.gogAuthPath)).toBe(false);

    // Clearing tombstone re-enables account connection
    launcherEngine.clearStoreDisconnectedTombstone('epic', authOpts);
    expect(launcherEngine.isStoreDisconnectedTombstoned('epic', authOpts)).toBe(false);
  });

  // ==========================================================================
  // T9: Windows NSIS uninstaller & imported official Epic Games Launcher safety
  // ==========================================================================
  it('T9: records imported official Epic Games Launcher installs and protects them across uninstallGame and all 3 Windows uninstaller scripts', async () => {
    const eglInstallDir = path.join(tmpDir, 'Program Files', 'Epic Games', 'RocketLeague');
    fs.mkdirSync(eglInstallDir, { recursive: true });
    createFakePeBinary(path.join(eglInstallDir, 'RocketLeague.exe'));

    launcherEngine.recordImportedEpicInstall('Sugar', eglInstallDir, { userDataDir });
    const recorded = launcherEngine.getImportedEpicInstalls({ userDataDir });
    expect(recorded.imports.Sugar).toMatchObject({
      appName: 'Sugar',
      installPath: eglInstallDir,
    });

    const managedInstallDir = path.join(tmpDir, 'Games', 'OneLauncher', 'Epic', 'ManagedGame');
    fs.mkdirSync(managedInstallDir, { recursive: true });
    createFakePeBinary(path.join(managedInstallDir, 'ManagedGame.exe'));

    launcherEngine.saveManagedInstalledGames(
      [
        {
          gameId: 'epic-sugar',
          platformId: 'epic',
          platformGameId: 'Sugar',
          title: 'Rocket League',
          installPath: eglInstallDir,
          runner: 'legendary',
        },
        {
          gameId: 'epic-managed',
          platformId: 'epic',
          platformGameId: 'ManagedApp',
          title: 'Managed Game',
          installPath: managedInstallDir,
          runner: 'legendary',
        },
      ],
      userDataDir
    );

    await launcherEngine.uninstallGame(
      {
        gameId: 'epic-sugar',
        platformId: 'epic',
        platformGameId: 'Sugar',
        title: 'Rocket League',
        installPath: eglInstallDir,
        allowDeleteFiles: false,
      },
      { platform: 'win32', userDataDir, homedir }
    );
    expect(fs.existsSync(path.join(eglInstallDir, 'RocketLeague.exe'))).toBe(true);

    await launcherEngine.uninstallGame(
      {
        gameId: 'epic-managed',
        platformId: 'epic',
        platformGameId: 'ManagedApp',
        title: 'Managed Game',
        installPath: managedInstallDir,
        allowDeleteFiles: false,
      },
      { platform: 'win32', userDataDir, homedir }
    );
    expect(fs.existsSync(managedInstallDir)).toBe(false);

    const rootDir = path.resolve(__dirname, '..');
    const nsh = fs.readFileSync(path.join(rootDir, 'build', 'installer.nsh'), 'utf8');
    const nsi = fs.readFileSync(path.join(rootDir, 'build', 'standalone-uninstaller.nsi'), 'utf8');
    const ps1 = fs.readFileSync(path.join(rootDir, 'build', 'Uninstall-OneLauncher.ps1'), 'utf8');

    for (const [name, scriptContent] of [
      ['installer.nsh', nsh],
      ['standalone-uninstaller.nsi', nsi],
      ['Uninstall-OneLauncher.ps1', ps1],
    ] as const) {
      expect(scriptContent, `${name} must inspect one_launcher_epic_imports.json`).toContain(
        'one_launcher_epic_imports.json'
      );
      expect(scriptContent, `${name} must track importedPaths`).toContain('importedPaths');
      expect(scriptContent, `${name} must track importedIds`).toContain('importedIds');
    }
  });

  // ==========================================================================
  // T10: GOG V1 cancelDownload (.gog_v1_<id>_main.bin cleanup) & >1h token refresh on resume
  // ==========================================================================
  it('T10: deletes .gog_v1_<id>_main.bin on both mid-stream cancel and paused cancel, and refreshes expired GOG token on paused resume', async () => {
    const createDepotMockFetch = (
      cleanId: string,
      fullData: Buffer,
      opts: { hangAfterFirstChunk?: boolean; onSecureLinkAuth?: (authHeader: string) => void } = {}
    ) => {
      return vi.fn(async (url: string, init?: any) => {
        const u = String(url);
        if (u.includes('/builds?generation=2')) {
          return makeJsonResponse({
            items: [
              {
                generation: 1,
                build_id: `b_${cleanId}`,
                legacy_build_id: `lb_${cleanId}`,
                link: `https://cdn.gog.test/${cleanId}/repository.json`,
              },
            ],
          });
        }
        if (u.endsWith('/repository.json')) {
          return makeJsonResponse({
            product: {
              installDirectory: `Game_${cleanId}`,
              depots: [{ gameID: cleanId, manifest: 'depot.json', languages: ['en'] }],
            },
          });
        }
        if (u.endsWith('/depot.json')) {
          return makeJsonResponse({
            depot: {
              files: [{ path: 'game.dat', offset: 0, size: fullData.length }],
            },
          });
        }
        if (u.includes('/secure_link')) {
          const authHeader = String(init?.headers?.Authorization || '');
          opts.onSecureLinkAuth?.(authHeader);
          return makeJsonResponse({ urls: [`https://cdn.gog.test/${cleanId}/blobs`] });
        }
        if (u.endsWith('/main.bin')) {
          const rangeHdr = String(init?.headers?.Range || '');
          const rangeMatch = rangeHdr.match(/bytes=(\d+)-/);
          const offset = rangeMatch ? Number(rangeMatch[1]) : 0;
          const signal: AbortSignal | undefined = init?.signal;

          if (opts.hangAfterFirstChunk) {
            const firstHalf = fullData.subarray(0, Math.min(16, fullData.length));
            return {
              ok: true,
              status: offset > 0 ? 206 : 200,
              body: (async function* () {
                yield firstHalf;
                await new Promise<void>((_, reject) => {
                  const failAbort = () => {
                    const abortErr: any = new Error('Aborted');
                    abortErr.name = 'AbortError';
                    reject(abortErr);
                  };
                  if (signal?.aborted) {
                    failAbort();
                    return;
                  }
                  signal?.addEventListener('abort', failAbort, { once: true });
                });
              })(),
            };
          }

          const remainingSlice = fullData.subarray(offset);
          return {
            ok: true,
            status: offset > 0 ? 206 : 200,
            body: (async function* () {
              yield remainingSlice;
            })(),
          };
        }
        throw new Error(`Unexpected URL in T10: ${u}`);
      });
    };

    const fullPayload = Buffer.from('0123456789ABCDEF_REMAINING_GOG_V1_BYTES', 'utf8');

    // Case A: Cancel mid-stream -> .gog_v1_99001_main.bin must be deleted
    const installA = path.join(tmpDir, 'GogCancelActive');
    const tempBinA = path.join(installA, '.gog_v1_99001_main.bin');
    await launcherEngine.installGame(
      {
        taskId: 'dl-gog-99001',
        gameId: 'gog-99001',
        platformId: 'gog',
        platformGameId: '99001',
        title: 'GogCancelActive',
        installDir: tmpDir,
        manualControl: true,
      },
      { userDataDir, homedir }
    );

    const pA = launcherEngine
      .downloadGogV1Depot(
        {
          taskId: 'dl-gog-99001',
          cleanId: '99001',
          platformGameId: '99001',
          title: 'GogCancelActive',
          gogPlatformFlag: 'windows',
          finalInstallPath: installA,
          gogToken: 'tok_a',
          platform: 'darwin',
          totalBytes: fullPayload.length,
        },
        {
          fetchImpl: createDepotMockFetch('99001', fullPayload, { hangAfterFirstChunk: true }),
          userDataDir,
          homedir,
        }
      )
      .catch((err: any) => err);

    for (
      let i = 0;
      i < 40 && !(fs.existsSync(tempBinA) && fs.statSync(tempBinA).size >= 16);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fs.existsSync(tempBinA)).toBe(true);

    launcherEngine.cancelDownload('dl-gog-99001', { userDataDir });
    await pA;
    expect(fs.existsSync(tempBinA)).toBe(false);

    // Case B: Pause -> >1h expired token refresh on resume -> complete extraction
    const installB = path.join(tmpDir, 'GogPauseResume');
    const tempBinB = path.join(installB, '.gog_v1_99002_main.bin');
    await launcherEngine.installGame(
      {
        taskId: 'dl-gog-99002',
        gameId: 'gog-99002',
        platformId: 'gog',
        platformGameId: '99002',
        title: 'GogPauseResume',
        installDir: tmpDir,
        manualControl: true,
      },
      { userDataDir, homedir }
    );

    const seenAuthHeaders: string[] = [];
    let shouldHangB = true;
    const dynamicFetchB = vi.fn((url: string, init?: any) =>
      createDepotMockFetch('99002', fullPayload, {
        hangAfterFirstChunk: shouldHangB,
        onSecureLinkAuth: (hdr) => seenAuthHeaders.push(hdr),
      })(url, init)
    );

    const refreshGogTokenFn = vi.fn(async () => 'fresh_refreshed_token_after_2h');

    const pB = launcherEngine
      .downloadGogV1Depot(
        {
          taskId: 'dl-gog-99002',
          cleanId: '99002',
          platformGameId: '99002',
          title: 'GogPauseResume',
          gogPlatformFlag: 'windows',
          finalInstallPath: installB,
          gogToken: 'stale_initial_token',
          platform: 'darwin',
          totalBytes: fullPayload.length,
        },
        {
          fetchImpl: dynamicFetchB,
          refreshGogTokenFn,
          userDataDir,
          homedir,
        }
      )
      .catch((err: any) => err);

    for (
      let i = 0;
      i < 40 && !(fs.existsSync(tempBinB) && fs.statSync(tempBinB).size >= 16);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fs.existsSync(tempBinB)).toBe(true);

    launcherEngine.pauseDownload('dl-gog-99002', { userDataDir });
    await pB;
    expect(fs.existsSync(tempBinB)).toBe(true);

    shouldHangB = false;
    launcherEngine.resumeDownload('dl-gog-99002', { userDataDir });

    for (let i = 0; i < 60 && !fs.existsSync(path.join(installB, 'game.dat')); i++) {
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(refreshGogTokenFn).toHaveBeenCalledTimes(1);
    expect(seenAuthHeaders).toEqual([
      'Bearer stale_initial_token',
      'Bearer fresh_refreshed_token_after_2h',
    ]);
    expect(fs.readFileSync(path.join(installB, 'game.dat'), 'utf8')).toBe(
      fullPayload.toString('utf8')
    );
    expect(fs.existsSync(tempBinB)).toBe(false);

    // Case C: Cancel while already paused -> .gog_v1_99003_main.bin must STILL be deleted!
    const installC = path.join(tmpDir, 'GogCancelPaused');
    const tempBinC = path.join(installC, '.gog_v1_99003_main.bin');
    await launcherEngine.installGame(
      {
        taskId: 'dl-gog-99003',
        gameId: 'gog-99003',
        platformId: 'gog',
        platformGameId: '99003',
        title: 'GogCancelPaused',
        installDir: tmpDir,
        manualControl: true,
      },
      { userDataDir, homedir }
    );

    const pC = launcherEngine
      .downloadGogV1Depot(
        {
          taskId: 'dl-gog-99003',
          cleanId: '99003',
          platformGameId: '99003',
          title: 'GogCancelPaused',
          gogPlatformFlag: 'windows',
          finalInstallPath: installC,
          gogToken: 'tok_c',
          platform: 'darwin',
          totalBytes: fullPayload.length,
        },
        {
          fetchImpl: createDepotMockFetch('99003', fullPayload, { hangAfterFirstChunk: true }),
          userDataDir,
          homedir,
        }
      )
      .catch((err: any) => err);

    for (
      let i = 0;
      i < 40 && !(fs.existsSync(tempBinC) && fs.statSync(tempBinC).size >= 16);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    launcherEngine.pauseDownload('dl-gog-99003', { userDataDir });
    await pC;
    expect(fs.existsSync(tempBinC)).toBe(true);

    launcherEngine.cancelDownload('dl-gog-99003', { userDataDir });
    expect(fs.existsSync(tempBinC)).toBe(false);
  });

  // ==========================================================================
  // T11: POSIX -pid process-group signaling (darwin) & taskkill /T /F (win32)
  // ==========================================================================
  it('T11: signals -pid process groups on darwin, runs taskkill /T /F on win32, and reaps orphaned grandchild processes on CLI timeout', async () => {
    // 1. Darwin POSIX process-group signaling (-pid) for SIGSTOP, SIGCONT, SIGTERM
    const darwinKillCalls: Array<[number, string | number]> = [];
    const mockDarwinProc = { pid: 42420, kill: vi.fn() };
    for (const sig of ['SIGSTOP', 'SIGCONT', 'SIGTERM'] as const) {
      const res = await launcherEngine.signalSubprocessTree(mockDarwinProc, sig, {
        platform: 'darwin',
        killImpl: (pid: number, signal: string | number) => {
          darwinKillCalls.push([pid, signal]);
        },
      });
      expect(res).toMatchObject({ signaled: true, method: 'process_group' });
    }
    expect(darwinKillCalls).toEqual([
      [-42420, 'SIGSTOP'],
      [-42420, 'SIGCONT'],
      [-42420, 'SIGTERM'],
    ]);

    // 2. Win32 taskkill /PID <pid> /T /F subprocess tree termination
    const winTaskkillCalls: Array<[string, string[]]> = [];
    const mockWinProc = { pid: 48880, kill: vi.fn() };
    const winRes = await launcherEngine.signalSubprocessTree(mockWinProc, 'SIGTERM', {
      platform: 'win32',
      execFileImpl: (cmd: string, args: string[], _opts: any, cb?: any) => {
        winTaskkillCalls.push([cmd, args]);
        (typeof _opts === 'function' ? _opts : cb)?.(null, '', '');
      },
    });
    expect(winRes).toMatchObject({ signaled: true, method: 'taskkill_tree' });
    expect(winTaskkillCalls).toEqual([['taskkill', ['/PID', '48880', '/T', '/F']]]);

    // 3. Live empirical process-group timeout reaper on macOS: parent spawns grandchild & hangs
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const pidFile = path.join(tmpDir, 'grandchild.pid');
      const parentScript = `
        const { spawn } = require('child_process');
        const fs = require('fs');
        const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
        fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid), 'utf8');
        setInterval(() => {}, 1000);
      `;

      const cliRes = await launcherEngine.execCliWithTreeTimeout(
        process.execPath,
        ['-e', parentScript],
        { timeout: 160 },
        { useSpawnForCliTimeout: true, platform: process.platform }
      );

      expect(cliRes.timedOut).toBe(true);
      expect(fs.existsSync(pidFile)).toBe(true);
      const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      expect(grandchildPid).toBeGreaterThan(0);

      for (let i = 0; i < 30; i++) {
        let alive = false;
        try {
          process.kill(grandchildPid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        if (!alive) break;
        await new Promise((r) => setTimeout(r, 15));
      }

      expect(() => process.kill(grandchildPid, 0)).toThrow();
    }
  });

  // ==========================================================================
  // T12: RequestScheduler single-URL promotion, maxInteractiveBurst = 2 & preemption
  // ==========================================================================
  it('T12: promotes only the target URL in promoteToInteractive, caps zero-token interactive burst at 2, and preempts background queues', async () => {
    const scheduler = new RequestScheduler();
    scheduler.setEnforceDelays(true);

    // metacritic.com has burst: 1, requestsPerSecond: 0.33 — drain its initial 1 token first
    await scheduler.enqueue(
      'https://metacritic.com/init-drain',
      async () => 'drained',
      RequestPriority.P0_INTERACTIVE
    );

    // Enqueue 4 interactive requests when bucket tokens === 0 -> max simultaneous active interactive must be <= 2!
    let activeInteractive = 0;
    let maxObservedInteractive = 0;
    let bgExecutedWhileInteractiveActive = false;
    const interactiveGateResolvers: Array<() => void> = [];

    const p0Promises = [1, 2, 3, 4].map((idx) =>
      scheduler.enqueue(
        `https://metacritic.com/p0-${idx}`,
        () =>
          new Promise<string>((resolve) => {
            activeInteractive += 1;
            if (activeInteractive > maxObservedInteractive) {
              maxObservedInteractive = activeInteractive;
            }
            interactiveGateResolvers.push(() => {
              activeInteractive -= 1;
              resolve(`p0-${idx}`);
            });
          }),
        RequestPriority.P0_INTERACTIVE
      )
    );

    const p2BgPromise = scheduler.enqueue(
      'https://api.opencritic.com/bg-crawl',
      async () => {
        if (activeInteractive > 0) {
          bgExecutedWhileInteractiveActive = true;
        }
        return 'bg-done';
      },
      RequestPriority.P2_BACKGROUND
    );

    await new Promise((r) => setTimeout(r, 25));
    expect(maxObservedInteractive).toBe(2);
    expect(scheduler.isInteractivePreempted()).toBe(true);
    expect(bgExecutedWhileInteractiveActive).toBe(false);

    while (interactiveGateResolvers.length > 0) {
      const nextBatch = interactiveGateResolvers.splice(0, interactiveGateResolvers.length);
      nextBatch.forEach((fn) => fn());
      await new Promise((r) => setTimeout(r, 25));
    }
    await Promise.all([...p0Promises, p2BgPromise]);
    expect(maxObservedInteractive).toBeLessThanOrEqual(2);
    expect(bgExecutedWhileInteractiveActive).toBe(false);

    // Single-URL promotion test: hold queue via interactive scope so P2_BACKGROUND items queue up on catalog.gog.com
    scheduler.setEnforceDelays(false);
    const scopeId = scheduler.beginInteractiveScope('promo-scope');

    const executionOrder: string[] = [];
    const bgUrls = [
      'https://catalog.gog.com/item-1',
      'https://catalog.gog.com/item-2',
      'https://catalog.gog.com/item-3',
      'https://catalog.gog.com/item-4',
    ];
    const bgTasks = bgUrls.map((u) =>
      scheduler.enqueue(
        u,
        async () => {
          executionOrder.push(u);
          return u;
        },
        RequestPriority.P2_BACKGROUND
      )
    );

    // While P2_BACKGROUND is held by interactive scope, promote ONLY item-3 to P0_INTERACTIVE!
    // item-3 must execute IMMEDIATELY (even while scope is active!), while item-1,2,4 stay held as P2_BACKGROUND!
    scheduler.promoteToInteractive('https://catalog.gog.com/item-3');
    await new Promise((r) => setTimeout(r, 15));
    expect(executionOrder).toEqual(['https://catalog.gog.com/item-3']);

    scheduler.endInteractiveScope(scopeId);
    await Promise.all(bgTasks);
    expect(executionOrder).toEqual([
      'https://catalog.gog.com/item-3',
      'https://catalog.gog.com/item-1',
      'https://catalog.gog.com/item-2',
      'https://catalog.gog.com/item-4',
    ]);

    // In-game throttle holds P1_VIEWPORT and P2_BACKGROUND while letting P0_INTERACTIVE run
    scheduler.setInGameThrottle(true);
    let p1RanWhileThrottled = false;
    const p1Held = scheduler.enqueue(
      'https://catalog.gog.com/throttled-p1',
      async () => {
        p1RanWhileThrottled = scheduler.isInGameThrottled();
        return 'p1';
      },
      RequestPriority.P1_VIEWPORT
    );
    const p0Immediate = await scheduler.enqueue(
      'https://catalog.gog.com/in-game-p0',
      async () => 'p0-ok',
      RequestPriority.P0_INTERACTIVE
    );
    expect(p0Immediate).toBe('p0-ok');
    expect(p1RanWhileThrottled).toBe(false);
    scheduler.setInGameThrottle(false);
    await p1Held;
    expect(p1RanWhileThrottled).toBe(false);
  });

  // ==========================================================================
  // T13: Unified resolveEffectiveLaunchPolicy parity, modal isolation & wheel listener cleanup
  // ==========================================================================
  it('T13: enforces TS===CJS resolveEffectiveLaunchPolicy parity, toggle-bottle-fast-bypass OFF coercion, per-game vs global perfSettings isolation, and LibraryGridView wheel cleanup', async () => {
    const matrixCases = [
      {
        platformId: 'steam' as const,
        hostPlatform: 'darwin' as const,
        isInstalled: true,
        detectedBuildType: 'windows_exe_on_mac' as const,
        configuredLaunchMethod: 'storefront_uri' as const,
        storefrontClientLifecycle: 'fast_direct_bypass' as const,
        globalStorefrontLifecycle: 'fast_direct_bypass' as const,
        executablePath: '/Games/Bottle/drive_c/Game.exe',
      },
      {
        platformId: 'epic' as const,
        hostPlatform: 'win32' as const,
        isInstalled: false,
        configuredLaunchMethod: 'auto' as const,
        storefrontClientLifecycle: 'default' as const,
        globalStorefrontLifecycle: 'fast_direct_bypass' as const,
      },
      {
        platformId: 'steam' as const,
        hostPlatform: 'darwin' as const,
        isInstalled: true,
        detectedBuildType: 'windows_exe_on_mac' as const,
        configuredLaunchMethod: 'auto' as const,
        storefrontClientLifecycle: 'default' as const,
        globalStorefrontLifecycle: 'fast_direct_bypass' as const,
        executablePath: '/Games/Bottle/drive_c/Game.exe',
      },
    ];

    for (const input of matrixCases) {
      const tsOut = resolveEffectiveLaunchPolicyTs(input);
      const cjsOut = launcherEngine.resolveEffectiveLaunchPolicy(input);
      expect(tsOut).toEqual(cjsOut);
    }

    const uriOut = resolveEffectiveLaunchPolicyTs(matrixCases[0]);
    expect(uriOut.isFastDirectBypass).toBe(false);
    expect(uriOut.delegatesToStorefrontUri).toBe(true);

    const uninstalledOut = resolveEffectiveLaunchPolicyTs(matrixCases[1]);
    expect(uninstalledOut.isFastDirectBypass).toBe(false);
    expect(uninstalledOut.detectedBuildType).toBe('not_installed');

    const bottleAutoBypassOut = resolveEffectiveLaunchPolicyTs(matrixCases[2]);
    expect(bottleAutoBypassOut.isFastDirectBypass).toBe(true);
    expect(bottleAutoBypassOut.effectiveLaunchMethod).toBe('compatibility_layer');

    // 2. GameLaunchConfigModal: toggle-bottle-fast-bypass OFF coercion + per-game vs global perfSettings isolation
    const mockLayers: CompatibilityLayerInfo[] = [
      {
        id: 'crossover',
        type: 'crossover',
        name: 'CrossOver',
        version: '25.0.0',
        binaryPath: '/Applications/CrossOver.app/Contents/MacOS/CrossOver',
        available: true,
        availableBottles: ['SteamBottle'],
        bottlesDir: '/tmp/Bottles',
      },
    ];

    const hostSpy = vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
    const getLayersSpy = vi
      .spyOn(launcherService, 'getCompatibilityLayers')
      .mockReturnValue(mockLayers);
    const detectLayersSpy = vi
      .spyOn(launcherService, 'detectCompatibilityLayers')
      .mockResolvedValue(mockLayers);
    const isInstalledSpy = vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(true);
    const getRecSpy = vi.spyOn(launcherService, 'getInstalledRecordForGame').mockReturnValue({
      platformId: 'steam',
      platformGameId: '44000',
      appId: 44000,
      title: 'Bottle Modal Test Game',
      installPath:
        '/tmp/Bottles/SteamBottle/drive_c/Program Files (x86)/Steam/steamapps/common/ModalGame',
      executablePath:
        '/tmp/Bottles/SteamBottle/drive_c/Program Files (x86)/Steam/steamapps/common/ModalGame/ModalGame.exe',
      runner: 'crossover',
      isWindowsBinaryOnMac: true,
    } as any);

    try {
      const sampleGame: Game = {
        id: 'steam-bottle-modal-test',
        title: 'Bottle Modal Test Game',
        coverUrl: '',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '44000',
            installed: true,
            installPath:
              '/tmp/Bottles/SteamBottle/drive_c/Program Files (x86)/Steam/steamapps/common/ModalGame',
          },
        ],
        status: 'Backlog',
        playtimeMinutes: 0,
        genres: ['Action'],
      } as any;

      await launcherService.savePerformanceSettings({
        inGameLauncherBehavior: 'hide_tray_hibernate',
        postGameLauncherBehavior: 'restore_window',
        storefrontClientLifecycle: 'fast_direct_bypass',
        pauseBackgroundSyncInGame: true,
        pauseDownloadsInGame: true,
        autoShutdownWinePrefixOnExit: true,
        suppressWineDebugLogging: true,
      });

      let savedPerGameConfig: any = null;
      const onClose = vi.fn();
      const tree = createStatefulRenderer(GameLaunchConfigModal, () => ({
        isOpen: true,
        game: sampleGame,
        initialPlatformId: 'steam',
        onClose,
        onSaved: (cfg) => {
          savedPerGameConfig = cfg;
        },
      }));

      const findPolicySelect = () =>
        tree.findByProp((p) => p['data-testid'] === 'storefront-client-lifecycle-select')[0];
      const findPolicyInfoBox = () =>
        tree.findByProp((p) => p['data-testid'] === 'storefront-policy-info-box')[0];

      expect(findPolicySelect()).toBeDefined();
      expect(findPolicySelect().props.value).toBe('fast_direct_bypass');
      expect(findPolicyInfoBox()?.props['data-policy-severity']).toBe('warning');

      // Selecting minimal_and_close_if_started when global is fast_direct_bypass overrides per-game policy without mutating global perfSettings
      findPolicySelect().props.onChange({ target: { value: 'minimal_and_close_if_started' } });
      tree.rerender();
      expect(findPolicySelect().props.value).toBe('minimal_and_close_if_started');
      expect(findPolicyInfoBox()?.props['data-policy-severity']).toBe('optimal');

      // Change per-game In-Game Launcher Behavior to 'keep_open' -> must NOT mutate global perfSettings!
      const inGameSelect = tree.findByProp(
        (p) => p['data-testid'] === 'in-game-launcher-behavior-select'
      )[0];
      expect(inGameSelect).toBeDefined();
      inGameSelect.props.onChange({ target: { value: 'keep_open' } });
      tree.rerender();

      const saveBtn = tree.findByProp(
        (p, t) =>
          t === 'button' &&
          typeof p.onClick === 'function' &&
          renderToString(React.createElement('div', null, p.children)).includes(
            'Save Configuration'
          )
      )[0];
      expect(saveBtn).toBeDefined();
      await saveBtn.props.onClick();

      expect(savedPerGameConfig).toBeTruthy();
      expect(savedPerGameConfig.storefrontClientLifecycle).toBe('minimal_and_close_if_started');
      expect(savedPerGameConfig.inGameLauncherBehavior).toBe('keep_open');

      const globalAfter = launcherService.getPerformanceSettings();
      expect(globalAfter.storefrontClientLifecycle).toBe('fast_direct_bypass');
      expect(globalAfter.inGameLauncherBehavior).toBe('hide_tray_hibernate');
    } finally {
      hostSpy.mockRestore();
      getLayersSpy.mockRestore();
      detectLayersSpy.mockRestore();
      isInstalledSpy.mockRestore();
      getRecSpy.mockRestore();
    }

    // 3. LibraryGridView 'wheel' listener cleanup verification (zero capture mismatch leak)
    const gridSource = fs.readFileSync(
      path.resolve(__dirname, '../src/components/Library/LibraryGridView.tsx'),
      'utf8'
    );
    expect(gridSource).toContain(
      "window.addEventListener('wheel', handleScrollOrWheel, { passive: true });"
    );
    expect(gridSource).toContain("window.removeEventListener('wheel', handleScrollOrWheel);");
    expect(gridSource).not.toMatch(/removeEventListener\(\s*['"]wheel['"][^)]*,\s*true\s*\)/);
    expect(gridSource).not.toMatch(/removeEventListener\(\s*['"]wheel['"][^)]*capture\s*:\s*true/);
  });
});
