import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

import viteConfig from '../vite.config';
import { CanonicalGame } from '../src/contracts/game';
import { DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS } from '../src/contracts/launcher';
import { DetailedAchievement } from '../src/contracts/achievement';
import {
  resolveMacArchitectureLabel,
  buildEffectiveLaunchModePreview,
} from '../src/services/launcher/launchPolicyPreview';
import { buildLibraryFilterIndex } from '../src/services/filter/libraryFilterIndex';
import { achievementDetailService } from '../src/services/achievements/achievementDetailService';
import { getHowLongToBeat, fetchAndCacheHltb } from '../src/services/hltb/howLongToBeat';
import { sanitizeGameCatalog } from '../src/services/integrations/catalogSanitizer';
import { syncJobManager } from '../src/services/network/syncJobManager';
import { ModalShell } from '../src/components/Common/ModalShell';
import { SteamLanguagesTable } from '../src/components/SteamStoreDetail/SteamLanguagesTable';
import { SteamLibraryActionBar } from '../src/components/SteamStoreDetail/SteamLibraryActionBar';
import { GlobalSyncProgressBar } from '../src/components/Navigation/GlobalSyncProgressBar';
import { LibraryFilterPanel } from '../src/components/Library/LibraryFilterPanel';
import { DEFAULT_LIBRARY_FILTER_STATE } from '../src/contracts/filter';
import { TestDOMParser } from './helpers/domParserHelper';
import { buildDisplayCatalogGameFixture } from './helpers/xboxTestHarness';

const requireCjs = createRequire(import.meta.url);

const windowAndSystemIpc = requireCjs('../electron/ipc/windowAndSystemIpcHandlers.cjs');
const storeSyncIpc = requireCjs('../electron/ipc/storeSyncIpcHandlers.cjs');
const semverUtils = requireCjs('../electron/utils/semverUtils.cjs');
const diagnosticLogger = requireCjs('../electron/utils/diagnosticLogger.cjs');
const securityAndPathUtils = requireCjs('../electron/launcher/securityAndPathUtils.cjs');
const uninstallSafety = requireCjs('../electron/launcher/uninstallSafety.cjs');
const engineStateRegistry = requireCjs('../electron/launcher/engineStateRegistry.cjs');
const macNativeInstaller = requireCjs('../electron/launcher/macNativeInstallerAndCodesign.cjs');
const sessionSupervisor = requireCjs('../electron/launcher/sessionAndProcessSupervisor.cjs');
const diskAndVolumeInspector = requireCjs('../electron/launcher/diskAndVolumeInspector.cjs');
const storefrontReadinessBarrier = requireCjs('../electron/launcher/storefrontReadinessBarrier.cjs');
const offlineVaultModule = requireCjs('../electron/launcher/offlineVaultService.cjs');
const mediaHydrationModule = requireCjs('../electron/launcher/mediaHydrationEngine.cjs');
const xboxCatalogAndGamePass = requireCjs('../electron/storefronts/xbox/xboxCatalogAndGamePass.cjs');
const msixvcStreamExtractor = requireCjs('../electron/storefronts/xbox/msixvcStreamExtractor.cjs');
const xboxRuntimeLoopbackServer = requireCjs(
  '../electron/storefronts/xbox/xboxRuntimeLoopbackServer.cjs'
);
const buildXboxBridge = requireCjs('../scripts/build-xbox-bridge.cjs');

// ---------------------------------------------------------------------------
// Headless Storage, <dialog> Top-Layer Harness & WCAG 2.2 Luminance Engine
// ---------------------------------------------------------------------------

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

class MockDialogElement {
  public open = false;
  public attrs = new Map<string, string>();
  private listeners = new Map<string, Set<(event: any) => void>>();
  public rect = { top: 100, left: 200, width: 600, height: 400 };

  showModal() {
    this.open = true;
    this.attrs.set('open', '');
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.attrs.delete('open');
    this.dispatchEvent({ type: 'close', target: this });
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
    if (name === 'open') this.open = true;
  }

  removeAttribute(name: string) {
    this.attrs.delete(name);
    if (name === 'open') this.open = false;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  addEventListener(type: string, fn: (event: any) => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: (event: any) => void) {
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(rawEvent: { type: string; target?: any }) {
    const event = {
      type: rawEvent.type,
      target: rawEvent.target ?? this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    const handlers = Array.from(this.listeners.get(event.type) || []);
    for (const fn of handlers) {
      fn(event);
    }
    return !event.defaultPrevented;
  }
}

function mountModalShellHarness(initialProps: React.ComponentProps<typeof ModalShell>) {
  const states: any[] = [];
  const refs: Array<{ current: any }> = [];
  const prevDeps: Array<any[] | undefined> = [];
  const cleanups: Array<(() => void) | undefined> = [];
  const dialogEl = new MockDialogElement();
  let currentProps = initialProps;
  let lastTree: any = null;

  const render = (nextProps?: Partial<React.ComponentProps<typeof ModalShell>>) => {
    if (nextProps) {
      currentProps = { ...currentProps, ...nextProps };
    }
    let stateIdx = 0;
    let refIdx = 0;
    let effectIdx = 0;
    const pendingEffects: Array<{ idx: number; fn: () => any }> = [];

    const internals = (React as any)
      .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prevH = internals.H;

    const runEffectHook = (fn: () => any, deps?: any[]) => {
      const idx = effectIdx++;
      const oldDeps = prevDeps[idx];
      const changed =
        !oldDeps ||
        !deps ||
        oldDeps.length !== deps.length ||
        deps.some((d, i) => !Object.is(d, oldDeps[i]));
      if (changed) {
        prevDeps[idx] = deps;
        pendingEffects.push({ idx, fn });
      }
    };

    internals.H = {
      useState(initial: any) {
        const idx = stateIdx++;
        if (idx >= states.length) {
          states.push(typeof initial === 'function' ? initial() : initial);
        }
        const setState = (updater: any) => {
          states[idx] = typeof updater === 'function' ? updater(states[idx]) : updater;
        };
        return [states[idx], setState];
      },
      useRef(initial: any) {
        const idx = refIdx++;
        if (idx >= refs.length) {
          refs.push({ current: idx === 0 ? dialogEl : initial });
        }
        return refs[idx];
      },
      useEffect: runEffectHook,
      useLayoutEffect: runEffectHook,
      useMemo: (fn: () => any) => fn(),
      useCallback: (fn: any) => fn,
      useSyncExternalStore: (_sub: any, _getClient: any, getServer?: () => any) =>
        typeof getServer === 'function' ? getServer() : false,
      useId: () => 'modal-test-id',
    };

    try {
      lastTree = ModalShell(currentProps);
    } finally {
      internals.H = prevH;
    }

    if (refs[0]) {
      refs[0].current = currentProps.isOpen ? dialogEl : null;
    }

    for (const eff of pendingEffects) {
      if (typeof cleanups[eff.idx] === 'function') {
        cleanups[eff.idx]!();
        cleanups[eff.idx] = undefined;
      }
      const cleanup = eff.fn();
      if (typeof cleanup === 'function') {
        cleanups[eff.idx] = cleanup;
      }
    }

    return lastTree;
  };

  const unmount = () => {
    for (let i = 0; i < cleanups.length; i++) {
      if (typeof cleanups[i] === 'function') {
        cleanups[i]!();
        cleanups[i] = undefined;
      }
    }
  };

  render();
  return {
    dialogEl,
    render,
    unmount,
    getTree: () => lastTree,
  };
}

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, '');
  if (clean.length === 3) {
    return [
      parseInt(clean[0] + clean[0], 16),
      parseInt(clean[1] + clean[1], 16),
      parseInt(clean[2] + clean[2], 16),
    ];
  }
  if (clean.length === 6) {
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  }
  throw new Error(`Invalid hex color: ${hex}`);
}

/**
 * WCAG 2.2 Relative Luminance & Contrast Ratio:
 * https://www.w3.org/TR/WCAG22/#dfn-relative-luminance
 */
function computeWcagRelativeLuminance(hex: string): number {
  const [r8, g8, b8] = parseHexRgb(hex);
  const linearize = (channel8: number): number => {
    const s = channel8 / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linearize(r8) + 0.7152 * linearize(g8) + 0.0722 * linearize(b8);
}

function computeWcagContrastRatio(foregroundHex: string, backgroundHex: string): number {
  const l1 = computeWcagRelativeLuminance(foregroundHex);
  const l2 = computeWcagRelativeLuminance(backgroundHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function sendRawLoopbackRpcFrame(
  port: number,
  payloadBuffer: Buffer,
  timeoutMs = 4000
): Promise<{ closedWithoutResponse: boolean; response?: any; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const sock = net.createConnection({ host: '127.0.0.1', port });
    sock.setNoDelay(true);

    const frame = Buffer.allocUnsafe(4 + payloadBuffer.length);
    frame.writeUInt32LE(payloadBuffer.length, 0);
    payloadBuffer.copy(frame, 4);

    let headerBuf = Buffer.alloc(0);
    let expectedBodyLen: number | null = null;
    const bodyChunks: Buffer[] = [];
    let bodyReceived = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new Error(`Loopback RPC timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    sock.on('connect', () => {
      sock.write(frame);
    });

    sock.on('data', (chunk: Buffer) => {
      let cursor = chunk;
      if (expectedBodyLen === null) {
        headerBuf = Buffer.concat([headerBuf, cursor]);
        if (headerBuf.length < 4) return;
        expectedBodyLen = headerBuf.readUInt32LE(0);
        cursor = headerBuf.subarray(4);
      }
      if (cursor.length > 0) {
        bodyChunks.push(cursor);
        bodyReceived += cursor.length;
      }
      if (expectedBodyLen !== null && bodyReceived >= expectedBodyLen && !settled) {
        settled = true;
        clearTimeout(timer);
        const rawBody = Buffer.concat(bodyChunks).subarray(0, expectedBodyLen);
        const elapsedMs = performance.now() - t0;
        sock.destroy();
        resolve({
          closedWithoutResponse: false,
          response: JSON.parse(rawBody.toString('utf8')),
          elapsedMs,
        });
      }
    });

    sock.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ closedWithoutResponse: true, elapsedMs: performance.now() - t0 });
      }
    });

    sock.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ closedWithoutResponse: true, elapsedMs: performance.now() - t0 });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Comprehensive Post-Xbox 9-Dimension, Dual-OS & WCAG 2.2 AA Regression Suite
// ---------------------------------------------------------------------------

describe('Post-Xbox 9-Dimension, Dual-OS & WCAG 2.2 AA Regression Suite', () => {
  let tmpDir: string;
  let prevWindow: any;
  let prevLocalStorage: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-launcher-wave6-audit-'));
    prevWindow = (globalThis as any).window;
    prevLocalStorage = (globalThis as any).localStorage;
    const memStorage = createMemoryStorage();
    (globalThis as any).localStorage = memStorage;
    (globalThis as any).window = {
      localStorage: memStorage,
      location: { hostname: 'example.com' },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
      electronAPI: undefined,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncJobManager.endAllPriorityScopes();
    if (prevWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = prevWindow;
    }
    if (prevLocalStorage === undefined) {
      delete (globalThis as any).localStorage;
    } else {
      (globalThis as any).localStorage = prevLocalStorage;
    }
    xboxCatalogAndGamePass.closeXboxCatalogCacheStore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Block 1: Review Step A — macOS (darwin ARM64 + Intel x64 Native & Bottled)
  // =========================================================================
  describe('Review Step A (macOS darwin ARM64 + Intel x64 Native & Bottled)', () => {
    it('1. selectPlatformReleaseAsset selects Intel x64 vs Apple Silicon arm64 DMGs accurately and rejects untrusted release URLs', () => {
      const releaseAssets = [
        {
          name: 'One-Launcher-0.2.0-arm64.dmg.blockmap',
          browser_download_url:
            'https://github.com/one-launcher/releases/download/v0.2.0/One-Launcher-0.2.0-arm64.dmg.blockmap',
        },
        {
          name: 'One-Launcher-0.2.0-arm64.dmg',
          browser_download_url:
            'https://github.com/one-launcher/releases/download/v0.2.0/One-Launcher-0.2.0-arm64.dmg',
        },
        {
          name: 'One-Launcher-0.2.0-x64.dmg',
          browser_download_url:
            'https://objects.githubusercontent.com/github-production-release-asset/One-Launcher-0.2.0-x64.dmg',
        },
        {
          name: 'One-Launcher-Setup-0.2.0-x64.exe',
          browser_download_url:
            'https://github.com/one-launcher/releases/download/v0.2.0/One-Launcher-Setup-0.2.0-x64.exe',
        },
      ];

      const arm64Choice = windowAndSystemIpc.selectPlatformReleaseAsset(
        releaseAssets,
        'darwin',
        'arm64'
      );
      expect(arm64Choice?.name).toBe('One-Launcher-0.2.0-arm64.dmg');

      const intelChoice = windowAndSystemIpc.selectPlatformReleaseAsset(
        releaseAssets,
        'darwin',
        'x64'
      );
      expect(intelChoice?.name).toBe('One-Launcher-0.2.0-x64.dmg');

      // When only an arm64 DMG exists, Intel x64 Mac MUST receive null (never offered incompatible arm64 binary)
      const arm64OnlyAssets = [releaseAssets[1]];
      expect(
        windowAndSystemIpc.selectPlatformReleaseAsset(arm64OnlyAssets, 'darwin', 'x64')
      ).toBeNull();

      // Universal DMG is accepted by Intel x64 when dedicated x64 DMG is absent
      const universalAssets = [
        releaseAssets[1],
        {
          name: 'One-Launcher-0.2.0-universal.dmg',
          browser_download_url:
            'https://release-assets.githubusercontent.com/One-Launcher-0.2.0-universal.dmg',
        },
      ];
      expect(
        windowAndSystemIpc.selectPlatformReleaseAsset(universalAssets, 'darwin', 'x64')?.name
      ).toBe('One-Launcher-0.2.0-universal.dmg');

      // Untrusted / non-GitHub / HTTP URLs are strictly rejected
      const poisonedAssets = [
        {
          name: 'One-Launcher-0.2.0-x64.dmg',
          browser_download_url: 'https://evil-github.com/One-Launcher-0.2.0-x64.dmg',
        },
        {
          name: 'One-Launcher-0.2.0-universal.dmg',
          browser_download_url: 'http://github.com/One-Launcher-0.2.0-universal.dmg',
        },
      ];
      expect(
        windowAndSystemIpc.selectPlatformReleaseAsset(poisonedAssets, 'darwin', 'x64')
      ).toBeNull();
    });

    it("2. resolveMacArchitectureLabel distinguishes 'Intel Mac' (x64) vs 'Apple Silicon' (arm64) in launch policy previews", () => {
      expect(resolveMacArchitectureLabel('x64')).toBe('Intel Mac');
      expect(resolveMacArchitectureLabel('x86_64')).toBe('Intel Mac');
      expect(resolveMacArchitectureLabel('arm64')).toBe('Apple Silicon');

      const winOnlyGame: CanonicalGame = {
        id: 'gog_win_only',
        title: 'Synthetic DirectX 12 Title',
        sortTitle: 'Synthetic DirectX 12 Title',
        headerImage: '',
        developers: ['Studio'],
        publishers: ['Publisher'],
        genres: ['RPG'],
        tags: [],
        nativePlatforms: ['windows'],
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '12000999',
            installed: true,
            isWindowsBinaryOnMac: true,
            platforms: { windows: true, mac: false },
          },
        ],
      };

      const intelPreview = buildEffectiveLaunchModePreview({
        game: winOnlyGame,
        preferredPlatformId: 'gog',
        effPlatform: winOnlyGame.platforms[0],
        hostPlatform: 'darwin',
        hostArch: 'x64',
        layers: [],
        globalStorefrontLifecycle:
          DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.storefrontClientLifecycle,
      });
      const armPreview = buildEffectiveLaunchModePreview({
        game: winOnlyGame,
        preferredPlatformId: 'gog',
        effPlatform: winOnlyGame.platforms[0],
        hostPlatform: 'darwin',
        hostArch: 'arm64',
        layers: [],
        globalStorefrontLifecycle:
          DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.storefrontClientLifecycle,
      });

      expect(JSON.stringify(intelPreview)).toContain('Intel Mac');
      expect(JSON.stringify(intelPreview)).not.toContain('Apple Silicon');
      expect(JSON.stringify(armPreview)).toContain('Apple Silicon');
    });

    it('3. SIP-safe resolveSipSafeWineBinaryAndPreloadEnv mirrors DYLD_INSERT_LIBRARIES into CX_DYLD_INSERT_LIBRARIES for CrossOver Perl wrappers', () => {
      const fakeCxBinDir = path.join(
        tmpDir,
        'CrossOver.app',
        'Contents',
        'SharedSupport',
        'CrossOver',
        'CrossOver-Hosted Application'
      );
      fs.mkdirSync(fakeCxBinDir, { recursive: true });
      const perlWrapperPath = path.join(fakeCxBinDir, 'wineloader-wrapper');
      fs.writeFileSync(perlWrapperPath, '#!/usr/bin/perl\nexec @ARGV;\n', { mode: 0o755 });

      const preloadPath = '/Applications/One Launcher.app/Contents/Resources/app.asar.unpacked/electron/helpers/libone_metal_preload.dylib';
      const env: Record<string, string> = {
        DYLD_INSERT_LIBRARIES: preloadPath,
        CX_BOTTLE: 'OneLauncher',
      };

      const resolvedBin = macNativeInstaller.resolveSipSafeWineBinaryAndPreloadEnv(
        perlWrapperPath,
        env
      );
      expect(resolvedBin).toBe(perlWrapperPath);
      expect(env.CX_DYLD_INSERT_LIBRARIES).toBe(preloadPath);

      // Re-invoking must remain idempotent without duplicating colon-delimited dylib entries
      macNativeInstaller.resolveSipSafeWineBinaryAndPreloadEnv(perlWrapperPath, env);
      expect(env.CX_DYLD_INSERT_LIBRARIES).toBe(preloadPath);
    });

    it('4. parseLaunchArguments preserves spaces inside double/single-quoted flags (--mod="path with spaces")', () => {
      const parsed = sessionSupervisor.parseLaunchArguments(
        '--mod="path with spaces" -windowed --profile=\'Player OneSave\' --escaped="quote \\"inside\\" arg"'
      );
      expect(parsed).toEqual([
        '--mod=path with spaces',
        '-windowed',
        '--profile=Player OneSave',
        '--escaped=quote "inside" arg',
      ]);
    });

    it('5. SemVer 2.0 comparator orders 26.0-preview < 26.0 and pre-release stages deterministically', () => {
      expect(semverUtils.compareSemver('26.0-preview', '26.0')).toBe(-1);
      expect(semverUtils.compareSemver('26.0', '26.0-preview')).toBe(1);
      expect(semverUtils.compareSemver('26.0.0+build.42', '26.0')).toBe(0);
      expect(semverUtils.compareSemver('0.2.0-alpha.1', '0.2.0-beta.1')).toBe(-1);
      expect(semverUtils.compareSemver('0.2.0-beta.1', '0.2.0-rc1')).toBe(-1);
      expect(semverUtils.compareSemver('0.2.0-rc1', '0.2.0')).toBe(-1);
    });

    it('6. isSafeToDeleteInstallPath permits leaf GOG game folders inside macOS bottles while blocking bottle roots and GOG Games containers', () => {
      const fakeHome = path.join(tmpDir, 'Users', 'testuser');
      const bottleRoot = path.join(
        fakeHome,
        'Library',
        'Application Support',
        'CrossOver',
        'Bottles',
        'OneLauncher'
      );
      const gogContainer = path.join(bottleRoot, 'drive_c', 'GOG Games');
      const leafGameDir = path.join(gogContainer, 'Hollow Knight');
      fs.mkdirSync(leafGameDir, { recursive: true });
      fs.writeFileSync(path.join(bottleRoot, 'cxbottle.conf'), '[Bottle]\n', 'utf8');
      fs.writeFileSync(path.join(leafGameDir, 'Hollow Knight.exe'), 'MZ', 'utf8');

      expect(
        engineStateRegistry.isSafeToDeleteInstallPath(leafGameDir, {
          platform: 'darwin',
          homedir: fakeHome,
        })
      ).toBe(true);

      // Shared containers & bottle roots must be strictly blocked
      expect(
        engineStateRegistry.isSafeToDeleteInstallPath(gogContainer, {
          platform: 'darwin',
          homedir: fakeHome,
        })
      ).toBe(false);
      expect(
        engineStateRegistry.isSafeToDeleteInstallPath(path.join(bottleRoot, 'drive_c'), {
          platform: 'darwin',
          homedir: fakeHome,
        })
      ).toBe(false);
      expect(
        engineStateRegistry.isSafeToDeleteInstallPath(bottleRoot, {
          platform: 'darwin',
          homedir: fakeHome,
        })
      ).toBe(false);
    });

    it('7. bridge-build-manifest.json SHA-256 verification validates deterministic PE64 bridges and rejects tampered digests', () => {
      const verified = buildXboxBridge.verifyXboxBridgeDll();
      expect(verified.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(verified.gameInputBridge.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.existsSync(verified.manifestPath)).toBe(true);

      const tamperedManifestPath = path.join(tmpDir, 'tampered-bridge-build-manifest.json');
      const realManifest = JSON.parse(fs.readFileSync(verified.manifestPath, 'utf8'));
      const firstDllName = Object.keys(realManifest.outputs)[0];
      expect(firstDllName).toBeDefined();
      realManifest.outputs[firstDllName].sha256 = '0'.repeat(64);
      fs.writeFileSync(tamperedManifestPath, JSON.stringify(realManifest, null, 2), 'utf8');

      expect(() =>
        buildXboxBridge.verifyBridgeBuildManifest({
          xgrInfo: verified,
          giInfo: verified.gameInputBridge,
          manifestPath: tamperedManifestPath,
        })
      ).toThrow(/SHA-256|mismatch/i);

      const staleSourceManifestPath = path.join(tmpDir, 'stale-source-bridge-manifest.json');
      const staleManifest = JSON.parse(fs.readFileSync(verified.manifestPath, 'utf8'));
      const firstSourceName = Object.keys(staleManifest.sources)[0];
      staleManifest.sources[firstSourceName] = 'f'.repeat(64);
      fs.writeFileSync(staleSourceManifestPath, JSON.stringify(staleManifest, null, 2), 'utf8');

      expect(() =>
        buildXboxBridge.verifyBridgeBuildManifest({
          xgrInfo: verified,
          giInfo: verified.gameInputBridge,
          manifestPath: staleSourceManifestPath,
        })
      ).toThrow(/Stale prebuilt DLLs|changed since last build/i);
    });
  });

  // =========================================================================
  // Block 2: Review Step B — Windows (win32 x64 Native GamingServices + Clientless xbox-msixvc-win)
  // =========================================================================
  describe('Review Step B (Windows win32 x64 Native GamingServices + Clientless xbox-msixvc-win)', () => {
    it('1. syncXboxCatalog joins localInstallsByPfn by both full packageFamilyName and publisher-stripped identityName', async () => {
      const pfnMatchedProduct = buildDisplayCatalogGameFixture({
        productId: '9NPFNMATCH01',
        title: 'PFN Exact Join Game',
        pfn: 'Microsoft.ForzaHorizon5_8wekyb3d8bbwe',
        xboxTitleId: '6A86E84F',
      });
      const identityMatchedProduct = buildDisplayCatalogGameFixture({
        productId: '9NIDNMATCH02',
        title: 'Identity Prefix Join Game',
        pfn: 'BethesdaSoftworks.Starfield_3275kfvn8vcwc',
        xboxTitleId: '7B112233',
      });

      const mockFetch = vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/PCGAFD/entitlements/subscriptions')) {
          return new Response(JSON.stringify({ subscriptions: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/PCGAFD/entitlements')) {
          return new Response(
            JSON.stringify({
              entitlements: [
                { productId: '9NPFNMATCH01', acquisitionType: 'Single' },
                { productId: '9NIDNMATCH02', acquisitionType: 'Single' },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (url.includes('displaycatalog.mp.microsoft.com/v7.0/products')) {
          return new Response(
            JSON.stringify({ Products: [pfnMatchedProduct, identityMatchedProduct] }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const localInstallsByPfn = new Map<
        string,
        { installed: boolean; installPath: string; executablePath: string }
      >([
        [
          'microsoft.forzahorizon5_8wekyb3d8bbwe',
          {
            installed: true,
            installPath: 'D:\\XboxGames\\Forza Horizon 5\\Content',
            executablePath: 'D:\\XboxGames\\Forza Horizon 5\\Content\\ForzaHorizon5.exe',
          },
        ],
        [
          'bethesdasoftworks.starfield',
          {
            installed: true,
            installPath:
              'C:\\Users\\testuser\\AppData\\Local\\Programs\\OneLauncher\\Games\\Xbox\\Starfield',
            executablePath:
              'C:\\Users\\testuser\\AppData\\Local\\Programs\\OneLauncher\\Games\\Xbox\\Starfield\\Starfield.exe',
          },
        ],
      ]);

      const result = await xboxCatalogAndGamePass.syncXboxCatalog({
        storeToken: 't=mock_ticket',
        syncMode: 'owned_and_played',
        localInstallsByPfn,
        userDataDir: tmpDir,
        fetchImpl: mockFetch,
        checkMinecraftJava: false,
      });

      const pfnGame = result.games.find(
        (g: any) => g.platforms[0]?.xboxProductId === '9NPFNMATCH01'
      );
      const idGame = result.games.find(
        (g: any) => g.platforms[0]?.xboxProductId === '9NIDNMATCH02'
      );

      expect(pfnGame?.platforms[0]?.installed).toBe(true);
      expect(pfnGame?.platforms[0]?.installPath).toBe('D:\\XboxGames\\Forza Horizon 5\\Content');
      expect(idGame?.platforms[0]?.installed).toBe(true);
      expect(idGame?.platforms[0]?.executablePath).toContain('Starfield.exe');
    });

    it('2. clientless xbox-msixvc-win defaults to %LOCALAPPDATA%\\Programs\\OneLauncher\\Games\\Xbox and writes .one_launcher_managed sentinel', () => {
      const localAppData = 'C:\\Users\\testuser\\AppData\\Local';
      const defaultDir = diskAndVolumeInspector.getDefaultInstallDir('xbox', {
        platform: 'win32',
        clientlessMsixvc: true,
        localAppData,
      });
      expect(defaultDir).toBe(
        'C:\\Users\\testuser\\AppData\\Local\\Programs\\OneLauncher\\Games\\Xbox'
      );

      const managedLeafDir = path.join(tmpDir, 'Programs', 'OneLauncher', 'Games', 'Xbox', 'Halo');
      fs.mkdirSync(managedLeafDir, { recursive: true });
      const wrote = engineStateRegistry.writeManagedInstallSentinel(managedLeafDir, {
        platformId: 'xbox',
        installKind: 'xbox-msixvc-win',
        gameId: 'xbox_9NBLGGH42THS',
      });
      expect(wrote).toBe(true);
      expect(
        fs.existsSync(path.join(managedLeafDir, engineStateRegistry.ONE_LAUNCHER_MANAGED_SENTINEL))
      ).toBe(true);
      expect(engineStateRegistry.hasManagedInstallSentinel(managedLeafDir)).toBe(true);
    });

    it('3. isSafeToDeleteInstallPath blocks \\\\?\\C:\\Users\\..., .GamingRoot D:\\XboxGames, and symlinks escaping into protected user trees', () => {
      const winOpts = {
        platform: 'win32',
        homedir: 'C:\\Users\\testuser',
      };

      // Win32 device prefix bypasses (`\\?\`, `\\.\`, `\??\`) must be stripped before protected-tree check
      expect(
        uninstallSafety.isSafeToDeleteInstallPath('\\\\?\\C:\\Users\\testuser\\Documents', winOpts)
      ).toBe(false);
      expect(
        uninstallSafety.isSafeToDeleteInstallPath('\\\\.\\C:\\Users\\testuser\\Desktop', winOpts)
      ).toBe(false);
      expect(
        uninstallSafety.isSafeToDeleteInstallPath('\\\\?\\D:\\XboxGames', winOpts)
      ).toBe(false);

      // Multi-game root containing `.GamingRoot` sentinel on disk must be blocked
      const fakeGamingRootDir = path.join(tmpDir, 'CustomDriveRoot', 'CustomLibraryFolder');
      fs.mkdirSync(fakeGamingRootDir, { recursive: true });
      fs.writeFileSync(path.join(fakeGamingRootDir, '.GamingRoot'), 'RGBX\0', 'utf8');
      expect(
        uninstallSafety.isSafeToDeleteInstallPath(fakeGamingRootDir, { platform: 'darwin' })
      ).toBe(false);

      // Symlink masquerading as a game directory but pointing to user Documents must be blocked
      const fakeUserHome = path.join(tmpDir, 'Users', 'testuser');
      const protectedDocs = path.join(fakeUserHome, 'Documents');
      fs.mkdirSync(protectedDocs, { recursive: true });
      const symlinkInstallParent = path.join(tmpDir, 'Games', 'OneLauncher', 'Xbox');
      fs.mkdirSync(symlinkInstallParent, { recursive: true });
      const symlinkLeaf = path.join(symlinkInstallParent, 'MaliciousSymlinkGame');
      fs.symlinkSync(protectedDocs, symlinkLeaf, 'dir');

      expect(
        uninstallSafety.isSafeToDeleteInstallPath(symlinkLeaf, {
          platform: 'darwin',
          homedir: fakeUserHome,
        })
      ).toBe(false);
    });

    it('4. msixvcStreamExtractor rejects NTFS Alternate Data Streams (Game.exe:stream) and Win32 reserved device names (CON.txt)', () => {
      expect(() =>
        msixvcStreamExtractor.normalizeRelativeInstallPath('Files/Game.exe:stream')
      ).toThrow(/forbidden Win32\/NTFS character/i);
      expect(() =>
        msixvcStreamExtractor.normalizeRelativeInstallPath('Files/bin/payload.dll:$DATA')
      ).toThrow(/forbidden Win32\/NTFS character/i);
      expect(() =>
        msixvcStreamExtractor.normalizeRelativeInstallPath('Files/CON.txt')
      ).toThrow(/reserved device/i);
      expect(() =>
        msixvcStreamExtractor.normalizeRelativeInstallPath('Files/sub/LPT1.cfg')
      ).toThrow(/reserved device/i);
      expect(() =>
        msixvcStreamExtractor.resolveSafeDestinationPath(tmpDir, 'Files/Game.exe:hidden')
      ).toThrow(/forbidden Win32\/NTFS character/i);
    });

    it('5. storefrontReadinessBarrier uses tasklist.exe and PowerShell Get-CimInstance with zero deprecated wmic calls', async () => {
      const barrierSrc = fs.readFileSync(
        path.resolve(__dirname, '../electron/launcher/storefrontReadinessBarrier.cjs'),
        'utf8'
      );
      const diskSrc = fs.readFileSync(
        path.resolve(__dirname, '../electron/launcher/diskAndVolumeInspector.cjs'),
        'utf8'
      );
      expect(/\bwmic(?:\.exe)?\b/i.test(barrierSrc)).toBe(false);
      expect(/\bwmic(?:\.exe)?\b/i.test(diskSrc)).toBe(false);

      const invokedBinaries: string[] = [];
      const running = await storefrontReadinessBarrier.isHostGogGalaxyRunning({
        platform: 'win32',
        execFileImpl: (cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          invokedBinaries.push(cmd);
          cb(null, '"GalaxyClient.exe","4120","Console","1","120,000 K"\r\n');
        },
      });
      expect(running).toBe(true);
      expect(invokedBinaries).toEqual(['tasklist.exe']);
    });

    it("6. libraryFilterIndex never labels Windows titles 'CrossOver / Wine Ready' (mac_compat_layer) on win32", () => {
      const catalog: CanonicalGame[] = [
        {
          id: 'steam_1091500',
          title: 'Cyberpunk 2077',
          sortTitle: 'Cyberpunk 2077',
          headerImage: '',
          developers: ['CD PROJEKT RED'],
          publishers: ['CD PROJEKT RED'],
          genres: ['RPG'],
          tags: [],
          nativePlatforms: ['windows'],
          platforms: [
            {
              platformId: 'steam',
              platformGameId: '1091500',
              installed: true,
              platforms: { windows: true, mac: false },
            },
          ],
        },
        {
          id: 'xbox_9NBLGGH42THS',
          title: 'Forza Horizon 5',
          sortTitle: 'Forza Horizon 5',
          headerImage: '',
          developers: ['Playground Games'],
          publishers: ['Xbox Game Studios'],
          genres: ['Racing'],
          tags: [],
          nativePlatforms: ['windows'],
          platforms: [
            {
              platformId: 'xbox',
              platformGameId: '9NBLGGH42THS',
              installed: true,
              platforms: { windows: true, mac: false },
            },
          ],
        },
      ];

      const winIndex = buildLibraryFilterIndex(catalog, { hostPlatform: 'win32' });
      expect(winIndex.osCounts.mac_compat_layer).toBe(0);
      for (const entry of winIndex.entriesById.values()) {
        expect(entry.osFlags.has('mac_compat_layer')).toBe(false);
        expect(entry.osFlags.has('windows_native')).toBe(true);
      }

      const macIndex = buildLibraryFilterIndex(catalog, { hostPlatform: 'darwin' });
      expect(macIndex.osCounts.mac_compat_layer).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Block 3: Security, Zero-PII & De-Fabrication
  // =========================================================================
  describe('Security, Zero-PII & De-Fabrication', () => {
    it('1. Vite production CSP <meta> plugin injects strict Content-Security-Policy in build mode without duplication', () => {
      const plugins = ((viteConfig as any).plugins || []).flat();
      const cspPlugin = plugins.find((p: any) => p && p.name === 'one-launcher-packaged-csp');
      expect(cspPlugin).toBeDefined();
      expect(cspPlugin.apply).toBe('build');

      const handler =
        typeof cspPlugin.transformIndexHtml === 'function'
          ? cspPlugin.transformIndexHtml
          : cspPlugin.transformIndexHtml.handler;

      const rawHtml = '<!doctype html><html><head><title>One Launcher</title></head><body></body></html>';
      const transformed = handler(rawHtml);

      const doc = new TestDOMParser().parseFromString(transformed, 'text/html');
      const cspMeta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
      expect(cspMeta).not.toBeNull();
      const content = cspMeta?.getAttribute('content') || '';
      expect(content).toContain("default-src 'self'");
      expect(content).toContain("script-src 'self'");
      expect(content).toContain("object-src 'none'");
      expect(content).toContain("base-uri 'self'");
      expect(content).toContain("form-action 'none'");
      expect(content).toContain('ol-media:');

      // Idempotent on second pass
      const twice = handler(transformed);
      expect(twice).toBe(transformed);
    });

    it('2. SSRF & DNS-rebinding guard blocks 127.0.0.1, 169.254.169.254, and ::ffff:127.0.0.1', async () => {
      expect(securityAndPathUtils.isPrivateOrLoopbackIp('127.0.0.1')).toBe(true);
      expect(securityAndPathUtils.isPrivateOrLoopbackIp('169.254.169.254')).toBe(true);
      expect(securityAndPathUtils.isPrivateOrLoopbackIp('::ffff:127.0.0.1')).toBe(true);
      expect(securityAndPathUtils.isPrivateOrLoopbackIp('[::ffff:169.254.169.254]')).toBe(true);
      expect(securityAndPathUtils.isPrivateOrLoopbackIp('::1')).toBe(true);
      expect(securityAndPathUtils.isPrivateOrLoopbackIp('13.107.42.16')).toBe(false);

      await expect(
        securityAndPathUtils.assertSafePublicHttpsUrl('https://127.0.0.1/latest/meta-data')
      ).rejects.toMatchObject({ code: 'ERR_SSRF_BLOCKED', isSsrfBlocked: true });

      await expect(
        securityAndPathUtils.assertSafePublicHttpsUrl('https://169.254.169.254/metadata/instance')
      ).rejects.toMatchObject({ code: 'ERR_SSRF_BLOCKED', isSsrfBlocked: true });

      await expect(
        securityAndPathUtils.assertSafePublicHttpsUrl('https://[::ffff:127.0.0.1]/admin')
      ).rejects.toMatchObject({ code: 'ERR_SSRF_BLOCKED', isSsrfBlocked: true });

      // DNS-rebinding hostname resolving to loopback IPv4-mapped IPv6 must also be blocked
      await expect(
        securityAndPathUtils.assertSafePublicHttpsUrl('https://rebind.example.com/image.png', {
          dnsLookup: async () => [{ address: '::ffff:127.0.0.1' }],
        })
      ).rejects.toMatchObject({ code: 'ERR_SSRF_BLOCKED', isSsrfBlocked: true });

      const allowed = await securityAndPathUtils.assertSafePublicHttpsUrl(
        'https://store-images.s-microsoft.com/image/apps.1234.png',
        { dnsLookup: async () => [{ address: '13.107.246.45' }] }
      );
      expect(allowed.hostname).toBe('store-images.s-microsoft.com');
    });

    it('3. diagnosticLogger redacts XBL3.0 x=..., SAS sig=..., and /Users/<user> paths and flushSync() persists synchronously', () => {
      const sensitiveLine =
        'Auth header Authorization: XBL3.0 x=2918374651928374;eyJhbGciOiJIUzI1NiJ9.secretPayload ' +
        'url=https://assets1.xboxlive.com/pkg.msixvc?sv=2024-01-01&sig=SuperSecretAzureSasSig%2B99%3D&se=2026-12-01 ' +
        'path=/Users/testuser/Library/Application Support/OneLauncher/auth.json ' +
        'winPath=C:\\Users\\testuser\\AppData\\Roaming\\OneLauncher\\user.json';

      const redacted = diagnosticLogger.redactSensitiveDiagnosticText(sensitiveLine);
      expect(redacted).toContain('XBL3.0 x=[REDACTED]');
      expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(redacted).toContain('sig=[REDACTED]');
      expect(redacted).not.toContain('SuperSecretAzureSasSig');
      expect(redacted).toContain('/Users/[REDACTED]/Library');
      expect(redacted).toContain('C:\\Users\\[REDACTED]\\AppData');
      expect(redacted).not.toContain('testuser');

      diagnosticLogger.diagLog.error('xbox.audit', sensitiveLine, { sig: 'RawMetaSecret' }, {
        forceWrite: true,
        userDataDir: tmpDir,
      });
      const flushed = diagnosticLogger.flushSync(tmpDir);
      expect(flushed).toBe(true);

      const logPath = diagnosticLogger.getDiagnosticLogPath(tmpDir);
      expect(fs.existsSync(logPath)).toBe(true);
      const onDisk = fs.readFileSync(logPath, 'utf8');
      expect(onDisk).toContain('XBL3.0 x=[REDACTED]');
      expect(onDisk).toContain('sig=[REDACTED]');
      expect(onDisk).not.toContain('SuperSecretAzureSasSig');
      expect(onDisk).not.toContain('RawMetaSecret');
      expect(onDisk).not.toContain('testuser');
    });

    it("4. store:get-tokens projection sanitizes raw credentials into 'saved_in_electron' with zero secret leakage", () => {
      const gogProjected = storeSyncIpc.sanitizeStoreTokenEntryForRenderer('gog', {
        access_token: 'gog_live_secret_token_123',
        refresh_token: 'gog_live_refresh_token_456',
        accountName: 'SyntheticGogPlayer',
        userId: '998877',
      });
      expect(gogProjected).toEqual({
        accountName: 'SyntheticGogPlayer',
        userId: '998877',
        connected: true,
        hasAccessToken: true,
        hasRefreshToken: true,
        hasApiKey: false,
        access_token: 'saved_in_electron',
      });
      expect(JSON.stringify(gogProjected)).not.toContain('gog_live_secret_token_123');
      expect(JSON.stringify(gogProjected)).not.toContain('gog_live_refresh_token_456');

      const xboxProjected = storeSyncIpc.sanitizeStoreTokenEntryForRenderer(
        'xbox',
        {
          msaRefreshToken: 'M.C507_BL2.-raw-msa-refresh-secret',
          xstsToken: 'raw-xsts-jwt',
          userStsLegacyTokenXml: '<BinarySecurityToken>secret</BinarySecurityToken>',
          gamertag: 'PlayerOne',
        },
        {
          connected: true,
          gamertag: 'PlayerOne',
          xstsToken: 'raw-xsts-jwt',
          msaRefreshToken: 'M.C507_BL2.-raw-msa-refresh-secret',
        }
      );
      expect(xboxProjected.access_token).toBe('saved_in_electron');
      expect(xboxProjected.connected).toBe(true);
      expect(JSON.stringify(xboxProjected)).not.toContain('raw-msa-refresh-secret');
      expect(JSON.stringify(xboxProjected)).not.toContain('raw-xsts-jwt');
      expect(JSON.stringify(xboxProjected)).not.toContain('BinarySecurityToken');
    });

    it("5. GOG achievement detail service reconciles live unlocks accurately and uses unlockPrecision: 'summary_count_only' with 0 positional idx < count unlocks", async () => {
      const gogGame: CanonicalGame = {
        id: 'gog_1458058109',
        title: 'Synthetic GOG Odyssey',
        sortTitle: 'Synthetic GOG Odyssey',
        headerImage: '',
        developers: ['Synthetic Studio'],
        publishers: ['Synthetic Pub'],
        genres: ['Adventure'],
        tags: [],
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1458058109',
            installed: true,
            achievements: { unlocked: 2, total: 4, percentage: 50 },
          },
        ],
      };

      const canonicalSchema: DetailedAchievement[] = [
        {
          id: 's1',
          apiName: 'ACH_PROLOGUE',
          name: 'Prologue',
          unlocked: false,
          iconUnlockedUrl: '',
          storefrontId: 'gog',
        },
        {
          id: 's2',
          apiName: 'ACH_BOSS_ONE',
          name: 'First Boss',
          unlocked: false,
          iconUnlockedUrl: '',
          storefrontId: 'gog',
        },
        {
          id: 's3',
          apiName: 'ACH_SECRET',
          name: 'Hidden Relic',
          unlocked: false,
          iconUnlockedUrl: '',
          storefrontId: 'gog',
        },
        {
          id: 's4',
          apiName: 'ACH_FINALE',
          name: 'Finale',
          unlocked: false,
          iconUnlockedUrl: '',
          storefrontId: 'gog',
        },
      ];

      // Case A: Summary count known (2/4), no per-achievement live unlock payload -> summary_count_only & 0 positional unlocks!
      (globalThis as any).window.electronAPI = {
        getStoreAchievements: vi.fn(async () => ({ items: [] })),
      };
      const summaryOnlyRes = await achievementDetailService.fetchGogDetailedAchievements(
        gogGame,
        '1458058109',
        { unlocked: 2, total: 4, percentage: 50 },
        canonicalSchema
      );
      expect(summaryOnlyRes?.unlockPrecision).toBe('summary_count_only');
      expect(summaryOnlyRes?.unlocked).toBe(2);
      expect(summaryOnlyRes?.total).toBe(4);
      // Zero positional `idx < 2` fabrication: every individual schema item stays `unlocked: false`
      expect(summaryOnlyRes?.achievements.filter((a) => a.unlocked)).toHaveLength(0);

      // Case B: Live GOG Gameplay API returns exact unlocked keys (#3 and #4) -> reconciled by key with unlockPrecision: 'exact'
      (globalThis as any).window.electronAPI = {
        getStoreAchievements: vi.fn(async () => ({
          totalCount: 4,
          items: [
            {
              achievement_key: 'ACH_SECRET',
              name: 'Hidden Relic',
              date_unlocked: '2026-10-12T18:30:00Z',
            },
            {
              achievement_key: 'ACH_FINALE',
              name: 'Finale',
              date_unlocked: '2026-10-14T21:00:00Z',
            },
          ],
        })),
      };
      const liveReconciled = await achievementDetailService.fetchGogDetailedAchievements(
        gogGame,
        '1458058109',
        { unlocked: 2, total: 4, percentage: 50 },
        canonicalSchema
      );
      expect(liveReconciled?.unlockPrecision).toBe('exact');
      expect(liveReconciled?.unlocked).toBe(2);
      expect(liveReconciled?.achievements.map((a) => a.unlocked)).toEqual([
        false,
        false,
        true,
        true,
      ]);
    });

    it('6. HLTB cache/search miss returns strict null without fabricating genre/tag hour estimates, and catalog sanitizer fabricates 0 Action genres', async () => {
      expect(
        getHowLongToBeat('Completely Unindexed Synthetic Game 2099', 99999991, ['Action', 'RPG'], [
          'Open World',
        ])
      ).toBeNull();

      (globalThis as any).window.electronAPI = {
        searchHltb: vi.fn(async () => ({ success: true, data: [] })),
      };
      const asyncMiss = await fetchAndCacheHltb(
        'Completely Unindexed Synthetic Game 2099',
        99999991
      );
      expect(asyncMiss).toBeNull();

      const genrelessGame: CanonicalGame = {
        id: 'xbox_9NGENRELESS01',
        title: 'Genreless Puzzle Prototype',
        sortTitle: 'Genreless Puzzle Prototype',
        headerImage: '',
        developers: ['Prototype Lab'],
        publishers: ['Prototype Lab'],
        genres: [],
        tags: [],
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NGENRELESS01',
            xboxProductId: '9NGENRELESS01',
            installed: false,
          },
        ],
      };

      const sanitized = sanitizeGameCatalog([genrelessGame]);
      expect(sanitized).toHaveLength(1);
      expect(sanitized[0].genres).toEqual([]);
      expect(sanitized[0].genres).not.toContain('Action');
    });
  });

  // =========================================================================
  // Block 4: Performance, Vault Quota & Modern Web / WCAG 2.2 AA
  // =========================================================================
  describe('Performance, Vault Quota & Modern Web / WCAG 2.2 AA', () => {
    it('1. xboxRuntimeLoopbackServer enforces 4 KiB pre-auth frame cap and processes authenticated ~15.5 MiB frame in < 50 ms', async () => {
      expect(xboxRuntimeLoopbackServer.MAX_UNAUTH_RPC_FRAME_BYTES).toBe(4096);
      expect(xboxRuntimeLoopbackServer.MAX_RPC_FRAME_BYTES).toBe(16 * 1024 * 1024);

      const server = await xboxRuntimeLoopbackServer.startXboxRuntimeLoopbackServer({
        userProfile: { xuid: '2533274790395904', gamertag: 'PlayerOne' },
        gameMetadata: {
          titleId: '6A86E84F',
          scid: '00000000-0000-0000-0000-00006a86e84f',
          packageFamilyName: 'Microsoft.HaloInfinite_8wekyb3d8bbwe',
        },
      });

      try {
        // 1. Unauthenticated oversized frame (> 4 KiB) MUST be immediately destroyed before JSON.parse / allocation
        const unauthOversized = Buffer.from(
          JSON.stringify({
            id: 1,
            key: '0'.repeat(64),
            method: 'session.auth',
            params: { pad: 'X'.repeat(8192) },
          }),
          'utf8'
        );
        expect(unauthOversized.length).toBeGreaterThan(4096);
        const rejected = await sendRawLoopbackRpcFrame(server.port, unauthOversized);
        expect(rejected.closedWithoutResponse).toBe(true);

        // 2. Authenticated persistent socket: small < 4 KiB auth handshake unlocks 16 MiB frame ceiling,
        //    warms V8 JIT, then streams a ~15.5 MiB frame and completes O(N) roundtrip in < 50 ms!
        await new Promise<void>((resolve, reject) => {
          const sock = net.createConnection({ host: '127.0.0.1', port: server.port });
          sock.setNoDelay(true);

          const warmupFrame = xboxRuntimeLoopbackServer.encodeRpcFrame({
            id: 10,
            key: server.sessionKey,
            method: 'session.auth',
            params: { warmup: 'W'.repeat(256 * 1024) },
          });

          const largePadding = 'A'.repeat(15.5 * 1024 * 1024);
          const largePayloadBuf = Buffer.from(
            JSON.stringify({
              id: 2,
              key: server.sessionKey,
              method: 'session.auth',
              params: { blob: largePadding },
            }),
            'utf8'
          );
          expect(largePayloadBuf.length).toBeLessThanOrEqual(
            xboxRuntimeLoopbackServer.MAX_RPC_FRAME_BYTES
          );
          expect(largePayloadBuf.length).toBeGreaterThan(15 * 1024 * 1024);

          const largeFrame = Buffer.allocUnsafe(4 + largePayloadBuf.length);
          largeFrame.writeUInt32LE(largePayloadBuf.length, 0);
          largePayloadBuf.copy(largeFrame, 4);

          let stage: 'auth' | 'warmup' | 'large' = 'auth';
          let recvBuf = Buffer.alloc(0);
          let largeStartMs = 0;
          const samplesMs: number[] = [];
          const maxAttempts = 5;

          sock.on('error', reject);
          sock.on('connect', () => {
            sock.write(
              xboxRuntimeLoopbackServer.encodeRpcFrame({
                id: 1,
                key: server.sessionKey,
                method: 'session.auth',
                params: {},
              })
            );
          });

          sock.on('data', (chunk: Buffer) => {
            try {
              recvBuf = Buffer.concat([recvBuf, chunk]);
              while (recvBuf.length >= 4) {
                const len = recvBuf.readUInt32LE(0);
                if (recvBuf.length < 4 + len) break;
                const msg = JSON.parse(recvBuf.subarray(4, 4 + len).toString('utf8'));
                recvBuf = recvBuf.subarray(4 + len);

                if (stage === 'auth') {
                  expect(msg.ok).toBe(true);
                  stage = 'warmup';
                  sock.write(warmupFrame);
                } else if (stage === 'warmup') {
                  expect(msg.ok).toBe(true);
                  stage = 'large';
                  largeStartMs = performance.now();
                  sock.write(largeFrame);
                } else {
                  const elapsedMs = performance.now() - largeStartMs;
                  expect(msg.id).toBe(2);
                  expect(msg.ok).toBe(true);
                  samplesMs.push(elapsedMs);
                  if (elapsedMs < 50 || samplesMs.length >= maxAttempts) {
                    const minMs = Math.min(...samplesMs);
                    expect(minMs).toBeLessThan(50);
                    sock.destroy();
                    resolve();
                    return;
                  }
                  largeStartMs = performance.now();
                  sock.write(largeFrame);
                }
              }
            } catch (err) {
              sock.destroy();
              reject(err);
            }
          });
        });
      } finally {
        await server.close();
      }
    });

    it('2. offlineVaultService tier caps & MediaHydrationEngine enforce P2 cover+icon-only background hydration', () => {
      expect(offlineVaultModule.OFFLINE_VAULT_TIER_CAPS).toEqual({
        compact: 150 * 1024 * 1024,
        balanced: 350 * 1024 * 1024,
        max_offline: 1536 * 1024 * 1024,
        full_archive: 1536 * 1024 * 1024,
      });

      const { isAssetAllowedForTier } = mediaHydrationModule;
      // P2 (uninstalled background sync): strictly cover/capsule + icon at ordinal 0 ONLY
      expect(isAssetAllowedForTier('cover', 0, 2)).toBe(true);
      expect(isAssetAllowedForTier('capsule', 0, 2)).toBe(true);
      expect(isAssetAllowedForTier('icon', 0, 2)).toBe(true);
      expect(isAssetAllowedForTier('cover', 1, 2)).toBe(false);
      expect(isAssetAllowedForTier('hero', 0, 2)).toBe(false);
      expect(isAssetAllowedForTier('header', 0, 2)).toBe(false);
      expect(isAssetAllowedForTier('logo', 0, 2)).toBe(false);
      expect(isAssetAllowedForTier('screenshot', 0, 2)).toBe(false);
      expect(isAssetAllowedForTier('inline_img', 0, 2)).toBe(false);
      expect(isAssetAllowedForTier('inline_poster', 0, 2)).toBe(false);

      // P1 (40-game detail LRU): allows up to 4 screenshots, 0 inline
      expect(isAssetAllowedForTier('hero', 0, 1)).toBe(true);
      expect(isAssetAllowedForTier('screenshot', 3, 1)).toBe(true);
      expect(isAssetAllowedForTier('screenshot', 4, 1)).toBe(false);
      expect(isAssetAllowedForTier('inline_img', 0, 1)).toBe(false);
    });

    it('3. <ModalShell> enforces preventClose Escape interception, pointer-origin backdrop guard, and stacked <dialog> single-Escape dismissal', () => {
      // A. preventClose={true} intercepts Escape (`cancel`) and suppresses backdrop dismissal
      const lockedClose = vi.fn();
      const lockedModal = mountModalShellHarness({
        isOpen: true,
        onClose: lockedClose,
        preventClose: true,
        ariaLabel: 'Critical Progress',
        children: React.createElement('div', null, 'Extracting MSIXVC'),
      });
      expect(lockedModal.dialogEl.open).toBe(true);
      expect(lockedModal.getTree().props.closedby).toBe('none');

      const notCancelled = lockedModal.dialogEl.dispatchEvent({ type: 'cancel' });
      expect(notCancelled).toBe(false); // preventDefault() called
      expect(lockedClose).not.toHaveBeenCalled();

      lockedModal.getTree().props.onPointerDown({ target: lockedModal.dialogEl });
      lockedModal.getTree().props.onClick({
        target: lockedModal.dialogEl,
        clientX: 10,
        clientY: 10,
      });
      expect(lockedClose).not.toHaveBeenCalled();
      lockedModal.unmount();

      // B. Pointer-origin guard: drag starting inside modal content & releasing on backdrop must NOT close
      const parentClose = vi.fn();
      const parentModal = mountModalShellHarness({
        isOpen: true,
        onClose: parentClose,
        ariaLabel: 'Parent Dialog',
        children: React.createElement('div', null, 'Parent Content'),
      });
      const innerContentTarget = {};
      parentModal.getTree().props.onPointerDown({ target: innerContentTarget });
      parentModal.getTree().props.onClick({
        target: parentModal.dialogEl,
        clientX: 10, // Outside rect (200..800, 100..500)
        clientY: 10,
      });
      expect(parentClose).not.toHaveBeenCalled();

      // C. Stacked <dialog> single-Escape dismissal: Escape targeting child dialog closes ONLY child
      const childClose = vi.fn();
      const childModal = mountModalShellHarness({
        isOpen: true,
        onClose: childClose,
        ariaLabel: 'Nested Picker Dialog',
        children: React.createElement('div', null, 'Nested Content'),
      });

      // Simulate Escape bubbling/delivering child's cancel event to both child and parent listeners
      childModal.dialogEl.dispatchEvent({ type: 'cancel', target: childModal.dialogEl });
      parentModal.dialogEl.dispatchEvent({ type: 'cancel', target: childModal.dialogEl });

      expect(childClose).toHaveBeenCalledTimes(1);
      expect(parentClose).toHaveBeenCalledTimes(0);

      // Genuine pointerdown + click on parent backdrop outside rect closes parent cleanly
      parentModal.getTree().props.onPointerDown({ target: parentModal.dialogEl });
      parentModal.getTree().props.onClick({
        target: parentModal.dialogEl,
        clientX: 10,
        clientY: 10,
      });
      expect(parentClose).toHaveBeenCalledTimes(1);

      childModal.unmount();
      parentModal.unmount();
    });

    it('4. <SteamLanguagesTable>, <GlobalSyncProgressBar>, and <LibraryFilterPanel> render semantic <th scope="col"> and sr-only assistive controls', () => {
      const steamHtml = renderToString(
        React.createElement(SteamLanguagesTable, {
          languageOptions: [
            { name: 'English', hasInterface: true, hasAudio: true, hasSubtitles: true },
            { name: 'Japanese', hasInterface: true, hasAudio: true, hasSubtitles: true },
            { name: 'French', hasInterface: true, hasAudio: false, hasSubtitles: true },
            { name: 'German', hasInterface: true, hasAudio: false, hasSubtitles: true },
            { name: 'Spanish', hasInterface: true, hasAudio: false, hasSubtitles: true },
            { name: 'Korean', hasInterface: true, hasAudio: false, hasSubtitles: true },
          ],
          languageTableSchema: 'steam',
        })
      );
      const steamDoc = new TestDOMParser().parseFromString(steamHtml, 'text/html');
      const colHeaders = steamDoc.querySelectorAll('th[scope="col"]');
      expect(colHeaders.length).toBe(4);
      expect(colHeaders[0].getAttribute('aria-label')).toBe('Language');
      expect(colHeaders.map((h) => h.textContent.trim())).toEqual([
        '',
        'Interface',
        'Full Audio',
        'Subtitles',
      ]);

      const checkIcons = steamDoc.querySelectorAll('span.check[aria-hidden="true"]');
      expect(checkIcons.length).toBeGreaterThan(0);
      const supportCells = steamDoc.querySelectorAll('td[aria-label="Supported"]');
      const unsupportedCells = steamDoc.querySelectorAll('td[aria-label="Not supported"]');
      expect(supportCells.length).toBeGreaterThan(0);
      expect(unsupportedCells.length).toBeGreaterThan(0);

      const audioTextHtml = renderToString(
        React.createElement(SteamLanguagesTable, {
          rawSupportedLanguagesHtml: 'AUDIO: English, Japanese | TEXT: English, Japanese, French',
          languageTableSchema: 'audio_text',
        })
      );
      const audioDoc = new TestDOMParser().parseFromString(audioTextHtml, 'text/html');
      expect(audioDoc.querySelectorAll('th[scope="col"]').length).toBe(3);

      // Verify sr-only assistive technology progress & search label semantics
      const scopeId = syncJobManager.beginPriorityScope('Syncing Xbox Library', 'Forza Horizon 5');
      const progressHtml = renderToString(React.createElement(GlobalSyncProgressBar));
      syncJobManager.endPriorityScope(scopeId);
      const progressDoc = new TestDOMParser().parseFromString(progressHtml, 'text/html');
      const srOnlyProgress = progressDoc.querySelectorAll('progress.sr-only');
      expect(srOnlyProgress.length).toBe(1);
      expect(srOnlyProgress[0].getAttribute('aria-label')).toContain('progress');

      const filterHtml = renderToString(
        React.createElement(LibraryFilterPanel, {
          filterState: DEFAULT_LIBRARY_FILTER_STATE,
          filterIndex: buildLibraryFilterIndex(
            [
              {
                id: 'g1',
                title: 'Sample Game',
                sortTitle: 'Sample Game',
                headerImage: '',
                developers: ['Studio A'],
                publishers: ['Publisher B'],
                genres: ['RPG'],
                tags: [],
                platforms: [{ platformId: 'steam', platformGameId: '10', installed: true }],
              },
            ],
            { hostPlatform: 'darwin' }
          ),
          totalCount: 1,
          filteredCount: 1,
          onChange: () => {},
          onReset: () => {},
          onClose: () => {},
        })
      );
      const filterDoc = new TestDOMParser().parseFromString(filterHtml, 'text/html');
      const srOnlyLabels = filterDoc.querySelectorAll('label.sr-only');
      expect(srOnlyLabels.length).toBeGreaterThanOrEqual(2);
    });

    it('5. mathematical WCAG 2.2 AA relative-luminance contrast assertions (>= 4.5:1) pass on Play/Install button tokens and muted slate text', () => {
      const baseGame: CanonicalGame = {
        id: 'steam_400',
        title: 'Portal',
        sortTitle: 'Portal',
        headerImage: '',
        developers: ['Valve'],
        publishers: ['Valve'],
        genres: ['Puzzle'],
        tags: [],
        platforms: [{ platformId: 'steam', platformGameId: '400', installed: false }],
      };

      // Render uninstalled (<SteamLibraryActionBar> -> Install button) & installed (-> Play button)
      const installHtml = renderToString(
        React.createElement(SteamLibraryActionBar, { game: baseGame })
      );
      const installedGame: CanonicalGame = {
        ...baseGame,
        platforms: [{ platformId: 'steam', platformGameId: '400', installed: true }],
      };
      const playHtml = renderToString(
        React.createElement(SteamLibraryActionBar, { game: installedGame })
      );

      // Verify live rendered inline gradient tokens match the audited button tokens
      expect(installHtml).toContain('#214b6b');
      expect(installHtml).toContain('#123049');
      expect(playHtml).toContain('#2f6f18');
      expect(playHtml).toContain('#1f5110');
      expect(playHtml).toContain('text-[#94a3b8]');

      const auditedPairs: Array<{ label: string; fg: string; bg: string }> = [
        { label: 'Play button text (#ffffff) on light gradient stop (#2f6f18)', fg: '#ffffff', bg: '#2f6f18' },
        { label: 'Play button text (#ffffff) on dark gradient stop (#1f5110)', fg: '#ffffff', bg: '#1f5110' },
        { label: 'Expired Play button (#ffffff) on slate-600 stop (#475569)', fg: '#ffffff', bg: '#475569' },
        { label: 'Expired Play button (#ffffff) on slate-700 stop (#334155)', fg: '#ffffff', bg: '#334155' },
        { label: 'Install button text (#ffffff) on light gradient stop (#214b6b)', fg: '#ffffff', bg: '#214b6b' },
        { label: 'Install button text (#ffffff) on dark gradient stop (#123049)', fg: '#ffffff', bg: '#123049' },
        { label: 'Muted slate-400 (#94a3b8) on app background (#0b0f14)', fg: '#94a3b8', bg: '#0b0f14' },
        { label: 'Muted slate-400 (#94a3b8) on steam-darkest (#0e141b)', fg: '#94a3b8', bg: '#0e141b' },
        { label: 'Muted slate-400 (#94a3b8) on card surface (#16202d)', fg: '#94a3b8', bg: '#16202d' },
        { label: 'Steam subtext (#8f98a0) on app background (#0b0f14)', fg: '#8f98a0', bg: '#0b0f14' },
        { label: 'Steam subtext (#8f98a0) on card surface (#16202d)', fg: '#8f98a0', bg: '#16202d' },
        { label: 'Language table header (#b0aeac) on panel surface (#101822)', fg: '#b0aeac', bg: '#101822' },
      ];

      for (const pair of auditedPairs) {
        const ratio = computeWcagContrastRatio(pair.fg, pair.bg);
        expect(ratio, `${pair.label} contrast=${ratio.toFixed(2)}:1 must be >= 4.5:1`).toBeGreaterThanOrEqual(
          4.5
        );
      }
    });
  });
});
