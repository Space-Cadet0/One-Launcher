import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const macNativeInstaller = require('../electron/launcher/macNativeInstallerAndCodesign.cjs');
const environmentProvisioner = require('../electron/launcher/environmentProvisioner.cjs');
const engineStateRegistry = require('../electron/launcher/engineStateRegistry.cjs');

const tempDirs: string[] = [];

function makeTempDir(prefix = 'ol-m1-preview-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function seedSyntheticPreviewBundle(
  parentDir: string,
  opts: {
    appName?: string;
    shortVersion?: string;
    bundleVersion?: string;
    suFeedUrl?: string;
    arm64?: boolean;
  } = {}
) {
  const appName = opts.appName || 'CrossOver Preview.app';
  const appPath = path.join(parentDir, appName);
  const contentsDir = path.join(appPath, 'Contents');
  const binDir = path.join(contentsDir, 'SharedSupport/CrossOver/bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'wine'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (opts.arm64) {
    const aarchDir = path.join(contentsDir, 'SharedSupport/CrossOver/lib/wine/aarch64-unix');
    fs.mkdirSync(aarchDir, { recursive: true });
    fs.writeFileSync(path.join(aarchDir, 'ntdll.so'), 'ELF-MOCK', 'utf8');
  }
  const shortVer = opts.shortVersion || '20261015';
  const bundleVer = opts.bundleVersion || '27.0.0.41303';
  const suFeedUrl = opts.suFeedUrl || 'https://www.codeweavers.com/xml/versions/cxmac.xml';
  fs.writeFileSync(
    path.join(contentsDir, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.codeweavers.CrossOver</string>
  <key>CFBundleShortVersionString</key>
  <string>${shortVer}</string>
  <key>CFBundleVersion</key>
  <string>${bundleVer}</string>
  <key>SUFeedURL</key>
  <string>${suFeedUrl}</string>
</dict>
</plist>`,
    'utf8'
  );
  return appPath;
}

describe('Milestone 1 — CrossOver Preview Remediation & Dual-Branch Arm64 Download/Install/Update (F1–F5)', () => {
  beforeEach(() => {
    macNativeInstaller.clearCachedAuthenticatedPreviewUrl();
  });

  afterEach(() => {
    macNativeInstaller.clearCachedAuthenticatedPreviewUrl();
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  it('F1: captureCodeWeaversPreviewDownload reveals auth window immediately on Cloudflare challenge DOM and OAuth/challenge will-redirect', async () => {
    const dir = makeTempDir('ol-m1-f1-');

    const runWindowProbeTest = async (scenario: 'cf-dom' | 'oauth-redirect') => {
      let createdWinOpts: any = null;
      let showCount = 0;
      const wcListeners: Record<string, Function[]> = {};

      class MockBrowserWindow {
        webContents = {
          setUserAgent: vi.fn(),
          getURL: () => 'https://www.codeweavers.com/preview/download',
          executeJavaScript: vi.fn(async () =>
            scenario === 'cf-dom'
              ? { hrefs: [], hasPasswordInput: false, hasChallengeDom: true, rawHtml: '<div id="challenge-form"></div>' }
              : { hrefs: [], hasPasswordInput: false, hasChallengeDom: false, rawHtml: '' }
          ),
          on: vi.fn((evt: string, fn: Function) => {
            wcListeners[evt] = wcListeners[evt] || [];
            wcListeners[evt].push(fn);
          }),
        };
        constructor(opts: any) {
          createdWinOpts = opts;
          if (opts?.show) showCount += 1;
        }
        loadURL(_url: string) {
          setImmediate(() => {
            if (scenario === 'oauth-redirect') {
              for (const fn of wcListeners['will-redirect'] || []) {
                fn({}, 'https://github.com/login/oauth/authorize?client_id=abc');
              }
            } else {
              for (const fn of wcListeners['did-finish-load'] || []) {
                fn();
              }
            }
          });
          return Promise.resolve();
        }
        show() {
          showCount += 1;
        }
        focus() {}
        moveTop() {}
        isDestroyed() {
          return false;
        }
        close() {}
        destroy() {}
        on() {}
      }

      const mockSession = {
        setUserAgent: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
        cookies: { flushStore: vi.fn().mockResolvedValue(undefined) },
      };

      const abortController = new AbortController();
      const promise = environmentProvisioner.captureCodeWeaversPreviewDownload(
        path.join(dir, scenario),
        { runId: `f1-${scenario}`, componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
        {
          authenticateOnly: false,
          allowInteractivePreviewCapture: true,
          freeDiskBytes: 20 * 1024 * 1024 * 1024,
          electronMod: {
            BrowserWindow: MockBrowserWindow,
            session: { fromPartition: () => mockSession },
          },
        },
        abortController.signal
      );

      await new Promise((r) => setTimeout(r, 40));
      expect(createdWinOpts.show).toBe(false);
      expect(showCount).toBe(1);

      abortController.abort();
      await expect(promise).rejects.toThrow(/cancelled/i);
    };

    await runWindowProbeTest('cf-dom');
    await runWindowProbeTest('oauth-redirect');
  });

  it('F2: ignores SUFeedURL = cxmac.xml Stable feed for both crossover_preview and crossover_preview_arm64 in checkCompatibilityLayerUpdates and installRunnerDirect, and never applies stableSurpassesPreview to arm64', async () => {
    const dir = makeTempDir('ol-m1-f2-');
    const appsDir = path.join(dir, 'Applications');
    const stdApp = seedSyntheticPreviewBundle(appsDir, {
      appName: 'CrossOver Preview.app',
      shortVersion: '20261015',
      bundleVersion: '27.0.0.41303',
      suFeedUrl: 'https://www.codeweavers.com/xml/versions/cxmac.xml',
    });
    const armApp = seedSyntheticPreviewBundle(appsDir, {
      appName: 'CrossOver Preview arm64.app',
      shortVersion: '20261015',
      bundleVersion: '27.0.0.41303',
      suFeedUrl: 'https://www.codeweavers.com/xml/versions/cxmac.xml',
      arm64: true,
    });

    const portalFetchUrls: string[] = [];
    const mockSessionFetch = vi.fn(async (url: string) => {
      portalFetchUrls.push(url);
      if (url === 'https://www.codeweavers.com/preview/download') {
        return {
          ok: true,
          status: 200,
          url,
          text: async () => `
            <a href="/preview/download/crossover-preview-20261111.zip">Standard</a>
            <a href="/preview/download/crossover-preview-arm64-20261111.zip">Arm64</a>
          `,
        };
      }
      throw new Error(`Unexpected previewSession fetch URL: ${url}`);
    });

    const mockHttpGetText = vi.fn(async (url: string) => {
      if (url === 'https://www.codeweavers.com/xml/versions/cxmac.xml') {
        // Stable CrossOver has higher semver 28.0.0 than 27.0.0!
        return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel><item>
    <enclosure url="https://media.codeweavers.com/pub/crossover/cxmac/demo/crossover-28.0.0.zip"
               sparkle:version="28.0.0.50000" sparkle:shortVersionString="28.0.0" />
  </item></channel>
</rss>`;
      }
      return null;
    });

    const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      httpGetText: mockHttpGetText,
      previewSessionFetch: mockSessionFetch,
      layers: [
        {
          id: 'crossover_preview',
          type: 'crossover_preview',
          name: 'CrossOver Preview',
          appPath: stdApp,
          version: '27.0.0',
          previewDate: '20261015',
        },
        {
          id: 'crossover_preview_arm64',
          type: 'crossover_preview_arm64',
          name: 'CrossOver Preview (Arm64)',
          appPath: armApp,
          version: '27.0.0',
          previewDate: '20261015',
        },
      ],
    });

    expect(mockSessionFetch).toHaveBeenCalledTimes(1);
    expect(portalFetchUrls).toEqual(['https://www.codeweavers.com/preview/download']);

    // Neither branch was hijacked by cxmac.xml (28.0.0)
    expect(updates.crossover_preview.downloadUrl).toBe(
      'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
    );
    expect(updates.crossover_preview.latestVersion).toBe('20261111');
    expect(updates.crossover_preview.stableSurpassesPreview).toBe(true);

    expect(updates.crossover_preview_arm64.downloadUrl).toBe(
      'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.zip'
    );
    expect(updates.crossover_preview_arm64.latestVersion).toBe('20261111');
    // stableSurpassesPreview must NEVER be set/applied to crossover_preview_arm64
    expect(updates.crossover_preview_arm64.stableSurpassesPreview).toBeUndefined();

    // installRunnerDirect must also ignore cxmac.xml SUFeedURL and NOT call cxmac.xml for crossover_preview_arm64
    let capturedForArm64 = false;
    const arm64Direct = await environmentProvisioner.installRunnerDirect('crossover_preview_arm64', {
      platform: 'darwin',
      arch: 'arm64',
      homedir: dir,
      customApplicationsDir: appsDir,
      existingLayer: {
        id: 'crossover_preview_arm64',
        type: 'crossover_preview_arm64',
        appPath: armApp,
        version: '27.0.0',
        previewDate: '20261015',
      },
      fetchFn: vi.fn(async (u: string) => {
        if (String(u).includes('cxmac.xml')) {
          throw new Error('Must NOT fetch cxmac.xml Stable feed for crossover_preview_arm64');
        }
        throw new Error(`Unexpected fetch ${u}`);
      }),
      capturePreviewDownloadFn: async () => {
        capturedForArm64 = true;
        return {
          authenticated: true,
          downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.zip',
        };
      },
      authenticateOnly: true,
    });
    expect(capturedForArm64).toBe(true);
    expect(arm64Direct.authenticated).toBe(true);
  });

  it('F3: authRequired leaves downloadUrl undefined (with portalUrl), onWillDownload attaches listeners before flushStore(), authenticateOnly skips disk check, updateCompatibilityLayer normalizes 2-arg calls, and date parsing is NaN-safe', async () => {
    const dir = makeTempDir('ol-m1-f3-');

    // 1. authRequired: true -> downloadUrl is undefined, portalUrl is exposed
    const authUpdates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      layers: [],
      previewSessionFetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        url: 'https://www.codeweavers.com/login',
        text: async () => '<html><title>Sign In | CodeWeavers</title><input type="password" /></html>',
      })),
    });
    expect(authUpdates.crossover_preview.authRequired).toBe(true);
    expect(authUpdates.crossover_preview.downloadUrl).toBeUndefined();
    expect(authUpdates.crossover_preview.portalUrl).toBe('https://www.codeweavers.com/preview/download');
    expect(authUpdates.crossover_preview_arm64.authRequired).toBe(true);
    expect(authUpdates.crossover_preview_arm64.downloadUrl).toBeUndefined();
    expect(authUpdates.crossover_preview_arm64.portalUrl).toBe('https://www.codeweavers.com/preview/download');

    // 2. onWillDownload attaches setSavePath, updated, and done synchronously BEFORE await flushStore()
    let willDownloadHandler: ((evt: any, item: any) => void) | null = null;
    let resolveFlush!: () => void;
    const flushDeferred = new Promise<void>((r) => {
      resolveFlush = r;
    });
    const wcListeners: Record<string, Function[]> = {};
    const mockSession = {
      setUserAgent: vi.fn(),
      on: vi.fn((evt: string, fn: any) => {
        if (evt === 'will-download') willDownloadHandler = fn;
      }),
      removeListener: vi.fn(),
      cookies: { flushStore: vi.fn(() => flushDeferred) },
    };
    class SyncDownloadBrowserWindow {
      webContents = {
        setUserAgent: vi.fn(),
        getURL: () => 'https://www.codeweavers.com/preview/download',
        executeJavaScript: vi.fn(async () => ({
          hrefs: ['https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'],
          hasPasswordInput: false,
        })),
        downloadURL: vi.fn((targetUrl: string) => {
          let savedPath = '';
          let doneCb: Function | null = null;
          const item = {
            getURL: () => targetUrl,
            getURLChain: () => [targetUrl],
            getFilename: () => 'crossover-preview-20261111.zip',
            getTotalBytes: () => 100,
            getReceivedBytes: () => 100,
            cancel: vi.fn(),
            setSavePath: (p: string) => {
              savedPath = p;
            },
            on: vi.fn(),
            once: vi.fn((evt: string, fn: Function) => {
              if (evt === 'done') doneCb = fn;
            }),
          };
          willDownloadHandler!({}, item);
          // Immediately assert setSavePath and done listener were attached synchronously BEFORE flushStore resolved!
          expect(savedPath).toContain('CrossOverPreview.zip');
          expect(typeof doneCb).toBe('function');
          fs.writeFileSync(savedPath, Buffer.from('PK\x03\x04ZIP'));
          resolveFlush();
          setImmediate(() => doneCb!({}, 'completed'));
        }),
        on: vi.fn((evt: string, fn: Function) => {
          wcListeners[evt] = wcListeners[evt] || [];
          wcListeners[evt].push(fn);
        }),
      };
      loadURL() {
        setImmediate(() => {
          for (const fn of wcListeners['did-finish-load'] || []) fn();
        });
        return Promise.resolve();
      }
      show() {}
      focus() {}
      moveTop() {}
      isDestroyed() {
        return false;
      }
      close() {}
      destroy() {}
      on() {}
    }

    const syncRes = await environmentProvisioner.captureCodeWeaversPreviewDownload(
      path.join(dir, 'sync-race'),
      { runId: 'f3-sync', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
      {
        freeDiskBytes: 20 * 1024 * 1024 * 1024,
        electronMod: {
          BrowserWindow: SyncDownloadBrowserWindow,
          session: { fromPartition: () => mockSession },
        },
      }
    );
    expect(syncRes.resolvedVersion).toBe('20261111');

    // 3. authenticateOnly skips 1.2 GB free disk space check & destDir mkdir
    const authDestDir = path.join(dir, 'never-created-auth-dir');
    const authOnlyRes = await environmentProvisioner.captureCodeWeaversPreviewDownload(
      authDestDir,
      { runId: 'f3-auth-disk', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
      {
        authenticateOnly: true,
        freeDiskBytes: 50 * 1024 * 1024, // 50 MB < 1.2 GB — must NOT throw!
        capturePreviewDownloadFn: async () => ({
          authenticated: true,
          downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        }),
      }
    );
    expect(authOnlyRes.authenticated).toBe(true);
    expect(fs.existsSync(authDestDir)).toBe(false);

    // 4. 2-arg updateCompatibilityLayer forwards switchToStableCrossOver
    const stableSwapDir = path.join(dir, 'StableSwapApps');
    const stdInstalled = seedSyntheticPreviewBundle(stableSwapDir, {
      appName: 'CrossOver Preview.app',
      shortVersion: '20261015',
      bundleVersion: '24.0.0.1000',
    });
    const fakeStableZip = path.join(dir, 'crossover-28.0.0.zip');
    fs.writeFileSync(fakeStableZip, Buffer.from('PK\x03\x04STABLE'));
    const stableUpdateRes = await macNativeInstaller.updateCompatibilityLayer('crossover_preview', {
      homedir: dir,
      customApplicationsDir: stableSwapDir,
      switchToStableCrossOver: true,
      skipProcessCheck: true,
      skipStagingCodesignVerify: true,
      layers: [
        {
          id: 'crossover_preview',
          type: 'crossover_preview',
          name: 'CrossOver Preview',
          appPath: stdInstalled,
          version: '24.0.0',
        },
      ],
      fetchFn: vi.fn(async (url: string): Promise<any> => {
        if (url.includes('cxmac.xml')) {
          return {
            ok: true,
            status: 200,
            url,
            text: async (): Promise<string> =>
              `<?xml version="1.0"?><rss><channel><item><enclosure url="https://media.codeweavers.com/pub/crossover/cxmac/demo/crossover-28.0.0.zip" sparkle:version="28.0.0.50000" sparkle:shortVersionString="28.0.0" /></item></channel></rss>`,
            arrayBuffer: async (): Promise<Buffer> => Buffer.from('PK\x03\x04STABLE'),
          };
        }
        if (url.includes('crossover-28.0.0.zip')) {
          return {
            ok: true,
            status: 200,
            url,
            headers: new Headers({ 'content-length': '10' }),
            arrayBuffer: async (): Promise<Buffer> => Buffer.from('PK\x03\x04STABLE'),
          };
        }
        return { ok: false, status: 404, text: async (): Promise<string> => '' };
      }),
      freeDiskBytes: 20 * 1024 * 1024 * 1024,
      onExtractArchive: async (_arch: string, stagingDir: string) => {
        seedSyntheticPreviewBundle(stagingDir, {
          appName: 'CrossOver.app',
          shortVersion: '28.0.0',
          bundleVersion: '28.0.0.50000',
        });
      },
      verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
      onExecDitto: async (src: string, dst: string) => {
        await fs.promises.cp(src, dst, { recursive: true, force: true });
      },
    });
    expect(stableUpdateRes.success).toBe(true);
    expect(fs.existsSync(path.join(stableSwapDir, 'CrossOver.app'))).toBe(true);

    // 5. extractPreviewFilenameVersionHint strips query/hash & prefers dotted ISO date over semver
    expect(
      environmentProvisioner.extractPreviewFilenameVersionHint(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip?v=2.0#dl'
      )
    ).toBe('20261111');
    expect(
      environmentProvisioner.extractPreviewFilenameVersionHint('crossover-preview-2026.11.11.dmg')
    ).toBe('20261111');
    expect(environmentProvisioner.parseNumericPreviewDate('27.0.1')).toBeNull();
    expect(environmentProvisioner.parseNumericPreviewDate('20261111')).toBe(20261111);

    // 6. runEnvironmentSetupTasks refuses to mark status: 'completed' when capture returns authenticated: true without installing
    const wizardSetupFail = await environmentProvisioner.runEnvironmentSetupTasks(
      {
        runId: 'f3-wizard-not-installed',
        tasks: [
          {
            componentId: 'runner_crossover_preview_arm64',
            action: 'install_runner',
            runnerType: 'crossover_preview_arm64',
          },
        ],
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: dir,
        customApplicationsDir: path.join(dir, 'WizardNoInstallApps'),
        rosettaInstalled: true,
        skipProcessCheck: true,
        capturePreviewDownloadFn: async () => ({
          authenticated: true,
          downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.zip',
        }),
      }
    );
    expect(wizardSetupFail.success).toBe(false);
    expect(wizardSetupFail.outcomes[0].status).toBe('failed');
  });

  it('F4: single /preview/download probe populates branch-keyed cache, isolates clearCachedAuthenticatedPreviewUrl(branch), hooks invalidateScanCaches, and never serves cached URLs on probe failure or Cloudflare challenge', async () => {
    const mockPortalFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      url: 'https://www.codeweavers.com/preview/download',
      text: async () => `
        <a href="/preview/download/crossover-preview-20261111.zip">Standard</a>
        <a href="/preview/download/crossover-preview-arm64-20261111.zip">Arm64</a>
      `,
    }));

    const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      layers: [],
      previewSessionFetch: mockPortalFetch,
    });
    expect(mockPortalFetch).toHaveBeenCalledTimes(1);
    expect(updates.crossover_preview.downloadUrl).toBe(
      'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'
    );
    expect(updates.crossover_preview_arm64.downloadUrl).toBe(
      'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.zip'
    );

    // Branch-isolated clearing
    macNativeInstaller.clearCachedAuthenticatedPreviewUrl('arm64');
    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'standard',
      })
    ).toBe('https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip');
    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'arm64',
      })
    ).toBeNull();

    // invalidateScanCaches() clears preview cache via registerExternalCacheInvalidator
    engineStateRegistry.invalidateScanCaches();
    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'standard',
      })
    ).toBeNull();

    // Seed cache again, then simulate Cloudflare challenge & network failure -> must NEVER serve cache!
    macNativeInstaller.setCachedAuthenticatedPreviewUrl(
      'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
      'standard'
    );

    const cfUpdates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      layers: [],
      isTest: false,
      fetchFn: vi.fn(async () => ({
        ok: true,
        status: 200,
        url: 'https://www.codeweavers.com/preview/download',
        text: async () => '<html><head><title>Just a moment...</title></head><body><div id="challenge-form"></div></body></html>',
      })),
    });
    expect(cfUpdates.crossover_preview.authRequired).toBe(true);
    expect(cfUpdates.crossover_preview.downloadUrl).toBeUndefined();

    macNativeInstaller.setCachedAuthenticatedPreviewUrl(
      'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
      'standard'
    );
    const failedProbeUpdates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      layers: [],
      isTest: false,
      fetchFn: vi.fn(async () => ({
        ok: false,
        status: 503,
        url: 'https://www.codeweavers.com/preview/download',
        text: async () => 'Service Unavailable',
      })),
    });
    expect(failedProbeUpdates.crossover_preview.authRequired).toBe(true);
    expect(failedProbeUpdates.crossover_preview.downloadUrl).toBeUndefined();
  });

  it('F5: streams authenticated archive via previewSession.fetch (0 BrowserWindows), falls back on 401/HTML, renames CrossOver Preview.app -> CrossOver Preview arm64.app, re-runs codesign, checks target write permissions, and sweeps orphaned temp artifacts', async () => {
    const dir = makeTempDir('ol-m1-f5-');
    const appsDir = path.join(dir, 'Applications');
    const stdApp = seedSyntheticPreviewBundle(appsDir, {
      appName: 'CrossOver Preview.app',
      shortVersion: '20261015',
      bundleVersion: '27.0.0.41303',
    });

    const codesignCommands: string[][] = [];
    const xattrCommands: string[][] = [];
    let browserWindowOpened = false;

    class ForbiddenBrowserWindow {
      constructor() {
        browserWindowOpened = true;
      }
    }

    const mockStreamSessionFetch = vi.fn(async (url: string) => {
      expect(url).toBe('https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.zip');
      return {
        ok: true,
        status: 200,
        url,
        headers: new Headers({
          'content-type': 'application/zip',
          'content-length': '12',
        }),
        arrayBuffer: async () => Buffer.from('PK\x03\x04ARM64ZIP'),
      };
    });

    const armInstallRes = await environmentProvisioner.installRunnerDirect(
      'crossover_preview_arm64',
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: dir,
        customApplicationsDir: appsDir,
        downloadUrl:
          'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.zip',
        freeDiskBytes: 20 * 1024 * 1024 * 1024,
        skipProcessCheck: true,
        previewSessionFetch: mockStreamSessionFetch,
        electronMod: {
          BrowserWindow: ForbiddenBrowserWindow,
          session: { fromPartition: () => ({}) },
        },
        verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
        execFileFn: (cmd: string, args: string[], _opts: any, cb: Function) => {
          if (String(cmd).includes('codesign')) codesignCommands.push(args.map(String));
          if (String(cmd).includes('xattr')) xattrCommands.push(args.map(String));
          cb(null, '', '');
        },
        onExecDitto: async (src: string, dst: string) => {
          await fs.promises.cp(src, dst, { recursive: true, force: true });
        },
        onExtractArchive: async (_zip: string, stagingDir: string) => {
          // Real CodeWeavers arm64 zip extracts as CrossOver Preview.app!
          seedSyntheticPreviewBundle(stagingDir, {
            appName: 'CrossOver Preview.app',
            shortVersion: '20261111',
            bundleVersion: '27.0.0.41303',
            arm64: true,
          });
        },
      }
    );

    expect(armInstallRes.success).toBe(true);
    expect(armInstallRes.installed).toBe(true);
    expect(browserWindowOpened).toBe(false);
    expect(mockStreamSessionFetch).toHaveBeenCalledTimes(1);
    const armInstalledPath = path.join(appsDir, 'CrossOver Preview arm64.app');
    expect(armInstallRes.installedPath).toBe(armInstalledPath);
    expect(fs.existsSync(armInstalledPath)).toBe(true);
    // Standard CrossOver Preview.app must remain untouched at 20261015
    expect(fs.readFileSync(path.join(stdApp, 'Contents/Info.plist'), 'utf8')).toContain('20261015');
    // Quarantine stripped & post-rename codesign verified on CrossOver Preview arm64.app
    expect(xattrCommands.some((a) => a.includes('com.apple.quarantine'))).toBe(true);
    expect(
      codesignCommands.some(
        (a) => a.includes('--verify') && a.join(' ').includes('CrossOver Preview arm64.app')
      )
    ).toBe(true);

    // Distinct receipt key for crossover_preview_arm64
    const receipts = macNativeInstaller.readRunnerInstallReceipts({ homedir: dir });
    expect(Object.values(receipts).some((r: any) => r.runnerType === 'crossover_preview_arm64')).toBe(true);

    // Fallback to BrowserWindow when previewSessionFetch returns HTML login gate
    let fallbackCaptured = false;
    const htmlFallbackRes = await environmentProvisioner.installRunnerDirect('crossover_preview', {
      platform: 'darwin',
      arch: 'arm64',
      homedir: dir,
      customApplicationsDir: appsDir,
      downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
      freeDiskBytes: 20 * 1024 * 1024 * 1024,
      skipProcessCheck: true,
      skipStagingCodesignVerify: true,
      previewSessionFetch: vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        url,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html>Sign in</html>',
      })),
      // Mock captureCodeWeaversPreviewDownload path via BrowserWindow returning authenticated
      electronMod: {
        BrowserWindow: class {
          private listeners: Record<string, Function[]> = {};
          webContents = {
            setUserAgent: vi.fn(),
            getURL: () => 'https://www.codeweavers.com/preview/download',
            executeJavaScript: vi.fn(async () => ({
              hrefs: ['https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'],
              hasPasswordInput: false,
            })),
            downloadURL: vi.fn(() => {
              fallbackCaptured = true;
            }),
            on: (e: string, fn: Function) => {
              this.listeners[e] = this.listeners[e] || [];
              this.listeners[e].push(fn);
            },
          };
          loadURL() {
            setImmediate(() => {
              for (const fn of this.listeners['did-finish-load'] || []) fn();
            });
            return Promise.resolve();
          }
          show() {}
          focus() {}
          moveTop() {}
          hide() {}
          isDestroyed() {
            return false;
          }
          close() {}
          destroy() {}
          on() {}
        },
        session: {
          fromPartition: () => ({
            setUserAgent: vi.fn(),
            on: vi.fn(),
            removeListener: vi.fn(),
            cookies: { flushStore: vi.fn().mockResolvedValue(undefined) },
          }),
        },
      },
      allowInteractivePreviewCapture: true,
      timeoutMs: 60,
    }).catch((err: any) => err);
    expect(fallbackCaptured).toBe(true);
    expect(htmlFallbackRes).toBeInstanceOf(Error);

    // Sweeps orphaned .ol-staging-* / .ol-backup-* artifacts when target is intact
    const orphanStaging = path.join(appsDir, '.CrossOver Preview arm64.app.ol-staging-999-old');
    const orphanBackup = path.join(appsDir, '.CrossOver Preview arm64.app.ol-backup-999-old');
    fs.mkdirSync(orphanStaging, { recursive: true });
    fs.mkdirSync(orphanBackup, { recursive: true });
    const newStage = seedSyntheticPreviewBundle(dir, {
      appName: 'CrossOver Preview arm64.app',
      shortVersion: '20261112',
      arm64: true,
    });
    await environmentProvisioner.atomicReplaceMacAppBundle(newStage, armInstalledPath, {
      skipStagingCodesignVerify: true,
      onExecDitto: async (src: string, dst: string) => {
        await fs.promises.cp(src, dst, { recursive: true, force: true });
      },
      execFileFn: (_c: string, _a: string[], _o: any, cb: Function) => cb(null, '', ''),
    });
    expect(fs.existsSync(orphanStaging)).toBe(false);
    expect(fs.existsSync(orphanBackup)).toBe(false);

    // Unwritable existing .app / parent fails fast on explicit update before downloading
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
      const roAppsDir = path.join(dir, 'ReadOnlyApps');
      const roArmApp = seedSyntheticPreviewBundle(roAppsDir, {
        appName: 'CrossOver Preview arm64.app',
        shortVersion: '20261015',
        arm64: true,
      });
      fs.chmodSync(roAppsDir, 0o555);
      try {
        await expect(
          environmentProvisioner.installRunnerDirect('crossover_preview_arm64', {
            platform: 'darwin',
            arch: 'arm64',
            _runnerOperation: 'update',
            existingLayer: {
              id: 'crossover_preview_arm64',
              type: 'crossover_preview_arm64',
              name: 'CrossOver Preview (Arm64)',
              appPath: roArmApp,
              version: '27.0.0',
              previewDate: '20261015',
            },
            skipProcessCheck: true,
          })
        ).rejects.toThrow(/permission denied/i);
      } finally {
        fs.chmodSync(roAppsDir, 0o755);
      }
    }
  });

  it('R2-1/2/3: streamPreviewFetch fails closed on SHA-256 / Developer ID / codesign / busy / disk errors (never BrowserWindow/openExternalUri), validates previewPortalPageUrl, and preserves browser User-Agent', async () => {
    const dir = makeTempDir('ol-m1-r2-stream-');
    const appsDir = path.join(dir, 'Applications');
    fs.mkdirSync(appsDir, { recursive: true });

    const makeZipResponse = (url: string) => ({
      ok: true,
      status: 200,
      url,
      headers: new Headers({
        'content-type': 'application/zip',
        'content-length': '12',
      }),
      arrayBuffer: async () => Buffer.from('PK\x03\x04ARM64ZIP'),
    });

    const runFailClosedScenario = async (
      scenario: 'sha256' | 'devid' | 'codesign' | 'busy' | 'disk0' | 'ssrf'
    ) => {
      let browserWindowOpened = false;
      let externalOpened = false;
      class ForbiddenBrowserWindow {
        constructor() {
          browserWindowOpened = true;
        }
      }

      const busySessionId = `busy-${Date.now()}`;
      try {
        await expect(
          environmentProvisioner.installRunnerDirect('crossover_preview_arm64', {
            platform: 'darwin',
            arch: 'arm64',
            homedir: dir,
            customApplicationsDir: appsDir,
            downloadUrl:
              scenario === 'ssrf'
                ? undefined
                : 'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.zip',
            ...(scenario === 'ssrf'
              ? { previewPortalUrl: 'https://evil.example.com/preview/download' }
              : {}),
            ...(scenario === 'disk0'
              ? { statfsFn: async () => ({ bsize: 4096, blocks: 1000, bavail: 0, bfree: 0 }) }
              : { freeDiskBytes: 20 * 1024 * 1024 * 1024 }),
            skipProcessCheck: scenario !== 'busy',
            ...(scenario === 'sha256' ? { expectedSha256: 'a'.repeat(64) } : {}),
            previewSessionFetch: vi.fn(async (url: string) => {
              if (scenario === 'ssrf') {
                throw new Error(`Must NOT probe untrusted previewPortalUrl: ${url}`);
              }
              return makeZipResponse(url);
            }),
            openExternalFn: async () => {
              externalOpened = true;
            },
            electronMod: {
              BrowserWindow: ForbiddenBrowserWindow,
              session: { fromPartition: () => ({}) },
            },
            verifySignatureFn: async () =>
              scenario === 'devid'
                ? { valid: false, teamIdentifier: 'BADTEAM123', reason: 'Developer ID mismatch' }
                : { valid: true, teamIdentifier: '2C75U774H4' },
            execFileFn: (cmd: string, args: string[], _opts: any, cb: Function) => {
              if (scenario === 'codesign' && String(cmd).includes('codesign')) {
                cb(new Error('codesign --verify --deep --strict failed'), '', 'invalid signature');
                return;
              }
              cb(null, '', '');
            },
            onExecDitto: async (src: string, dst: string) => {
              await fs.promises.cp(src, dst, { recursive: true, force: true });
            },
            onExtractArchive: async (_zip: string, stagingDir: string) => {
              if (scenario === 'busy') {
                engineStateRegistry.activeSessions.set(busySessionId, {
                  sessionId: busySessionId,
                  gameId: 'test-game',
                  title: 'Test Game',
                  compatibilityLayer: 'crossover_preview_arm64',
                  pid: process.pid,
                  launchedAt: Date.now(),
                });
              }
              seedSyntheticPreviewBundle(stagingDir, {
                appName: 'CrossOver Preview.app',
                shortVersion: '20261111',
                bundleVersion: '27.0.0.41303',
                arm64: true,
              });
            },
          })
        ).rejects.toThrow();

        expect(browserWindowOpened).toBe(false);
        expect(externalOpened).toBe(false);
      } finally {
        engineStateRegistry.activeSessions.delete(busySessionId);
      }
    };

    await runFailClosedScenario('sha256');
    await runFailClosedScenario('devid');
    await runFailClosedScenario('codesign');
    await runFailClosedScenario('busy');
    await runFailClosedScenario('disk0');
    await runFailClosedScenario('ssrf');

    // Preserve session browser User-Agent on archive requests via previewSession.fetch (never force OneGameLauncher/1.0)
    const capturedHeaders: Array<Record<string, any> | undefined> = [];
    let configuredSessionUa = '';
    const sessionAppsDir = path.join(dir, 'SessionUaApps');
    await environmentProvisioner.installRunnerDirect('crossover_preview', {
      platform: 'darwin',
      arch: 'arm64',
      homedir: dir,
      customApplicationsDir: sessionAppsDir,
      downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
      freeDiskBytes: 20 * 1024 * 1024 * 1024,
      skipProcessCheck: true,
      skipStagingCodesignVerify: true,
      electronMod: {
        session: {
          fromPartition: () => ({
            setUserAgent: (ua: string) => {
              configuredSessionUa = ua;
            },
            fetch: vi.fn(async (url: string, opts: any) => {
              capturedHeaders.push(opts?.headers);
              return makeZipResponse(url);
            }),
          }),
        },
      },
      verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
      execFileFn: (_c: string, _a: string[], _o: any, cb: Function) => cb(null, '', ''),
      onExecDitto: async (src: string, dst: string) => {
        await fs.promises.cp(src, dst, { recursive: true, force: true });
      },
      onExtractArchive: async (_zip: string, stagingDir: string) => {
        seedSyntheticPreviewBundle(stagingDir, {
          appName: 'CrossOver Preview.app',
          shortVersion: '20261111',
          bundleVersion: '27.0.0.41303',
        });
      },
    });
    expect(configuredSessionUa).toContain('Mozilla/5.0');
    expect(capturedHeaders.length).toBe(1);
    expect(capturedHeaders[0]?.['User-Agent']).not.toBe('OneGameLauncher/1.0');
  });

  it('R2-4/5/7: onWillDownload sync done emits 0 post-settled 0% progress events, 0-byte free disk fails cleanly, and Cloudflare variant DOM/title reveals immediately', async () => {
    const dir = makeTempDir('ol-m1-r2-capture-');

    // 1. onWillDownload synchronous 'done' before flushStore() resolves -> 0 progress events emitted AFTER resolve
    let willDownloadHandler: ((evt: any, item: any) => void) | null = null;
    let resolveFlush!: () => void;
    const flushDeferred = new Promise<void>((r) => {
      resolveFlush = r;
    });
    const wcListeners: Record<string, Function[]> = {};
    const emittedEvents: any[] = [];
    let resolved = false;
    const eventsAfterResolve: any[] = [];

    const mockSession = {
      setUserAgent: vi.fn(),
      on: vi.fn((evt: string, fn: any) => {
        if (evt === 'will-download') willDownloadHandler = fn;
      }),
      removeListener: vi.fn(),
      cookies: { flushStore: vi.fn(() => flushDeferred) },
    };

    class InstantDoneWindow {
      webContents = {
        setUserAgent: vi.fn(),
        getURL: () => 'https://www.codeweavers.com/preview/download',
        executeJavaScript: vi.fn(async () => ({
          hrefs: ['https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'],
          hasPasswordInput: false,
        })),
        downloadURL: vi.fn((targetUrl: string) => {
          let savedPath = '';
          let doneCb: Function | null = null;
          const item = {
            getURL: () => targetUrl,
            getURLChain: () => [targetUrl],
            getFilename: () => 'crossover-preview-20261111.zip',
            getTotalBytes: () => 5000,
            getReceivedBytes: () => 5000,
            cancel: vi.fn(),
            setSavePath: (p: string) => {
              savedPath = p;
            },
            on: vi.fn(),
            once: vi.fn((evt: string, fn: Function) => {
              if (evt === 'done') doneCb = fn;
            }),
          };
          willDownloadHandler!({}, item);
          fs.writeFileSync(savedPath, Buffer.from('PK\x03\x04ZIP'));
          // Fire 'done' synchronously BEFORE flushStore() resolves!
          doneCb!({}, 'completed');
          setImmediate(() => resolveFlush());
        }),
        on: vi.fn((evt: string, fn: Function) => {
          wcListeners[evt] = wcListeners[evt] || [];
          wcListeners[evt].push(fn);
        }),
      };
      loadURL() {
        setImmediate(() => {
          for (const fn of wcListeners['did-finish-load'] || []) fn();
        });
        return Promise.resolve();
      }
      show() {}
      focus() {}
      moveTop() {}
      isDestroyed() {
        return false;
      }
      close() {}
      destroy() {}
      on() {}
    }

    await environmentProvisioner.captureCodeWeaversPreviewDownload(
      path.join(dir, 'sync-done-before-flush'),
      { runId: 'r2-sync-done', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
      {
        freeDiskBytes: 20 * 1024 * 1024 * 1024,
        onProgress: (evt: any) => {
          emittedEvents.push(evt);
          if (resolved) eventsAfterResolve.push(evt);
        },
        electronMod: {
          BrowserWindow: InstantDoneWindow,
          session: { fromPartition: () => mockSession },
        },
      }
    );
    resolved = true;
    await new Promise((r) => setTimeout(r, 30));
    expect(eventsAfterResolve).toEqual([]);
    expect(emittedEvents.some((e) => e.phase === 'downloading' && e.bytesDownloaded === 0)).toBe(false);

    // 2. 0-byte free disk space triggers Insufficient disk space (while authenticateOnly skips it)
    const zeroStatfs = async () => ({ bsize: 4096, blocks: 1000, bavail: 0, bfree: 0 });
    await expect(
      environmentProvisioner.captureCodeWeaversPreviewDownload(
        path.join(dir, 'zero-disk'),
        { runId: 'r2-zero-disk', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
        {
          statfsFn: zeroStatfs,
          authenticateOnly: false,
        }
      )
    ).rejects.toThrow(/Insufficient disk space/i);

    // Also verify authenticateOnly: true still skips 0-byte disk check
    const authZeroDiskRes = await environmentProvisioner.captureCodeWeaversPreviewDownload(
      path.join(dir, 'zero-disk-auth-skipped'),
      { runId: 'r2-zero-disk-auth', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
      {
        statfsFn: zeroStatfs,
        authenticateOnly: true,
        capturePreviewDownloadFn: async () => ({
          authenticated: true,
          downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        }),
      }
    );
    expect(authZeroDiskRes.authenticated).toBe(true);

    // 3. Cloudflare variant DOM/title reveal (cf-browser-verification / challenge-platform / Just a moment)
    let cfVariantShowCount = 0;
    const cfListeners: Record<string, Function[]> = {};
    class CfVariantWindow {
      webContents = {
        setUserAgent: vi.fn(),
        getURL: () => 'https://www.codeweavers.com/preview/download',
        executeJavaScript: vi.fn(async () => ({
          hrefs: [],
          hasPasswordInput: false,
          hasChallengeDom: false,
          rawHtml: '<div id="cf-browser-verification" class="challenge-platform">Checking browser...</div>',
          pageTitle: 'Just a moment...',
        })),
        on: vi.fn((evt: string, fn: Function) => {
          cfListeners[evt] = cfListeners[evt] || [];
          cfListeners[evt].push(fn);
        }),
      };
      constructor(opts: any) {
        if (opts?.show) cfVariantShowCount += 1;
      }
      loadURL() {
        setImmediate(() => {
          for (const fn of cfListeners['did-finish-load'] || []) fn();
        });
        return Promise.resolve();
      }
      show() {
        cfVariantShowCount += 1;
      }
      focus() {}
      moveTop() {}
      isDestroyed() {
        return false;
      }
      close() {}
      destroy() {}
      on() {}
    }

    const cfAbort = new AbortController();
    const cfPromise = environmentProvisioner.captureCodeWeaversPreviewDownload(
      path.join(dir, 'cf-variant'),
      { runId: 'r2-cf-var', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
      {
        allowInteractivePreviewCapture: true,
        freeDiskBytes: 20 * 1024 * 1024 * 1024,
        electronMod: {
          BrowserWindow: CfVariantWindow,
          session: {
            fromPartition: () => ({
              setUserAgent: vi.fn(),
              on: vi.fn(),
              removeListener: vi.fn(),
              cookies: { flushStore: vi.fn().mockResolvedValue(undefined) },
            }),
          },
        },
      },
      cfAbort.signal
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(cfVariantShowCount).toBe(1);
    cfAbort.abort();
    await expect(cfPromise).rejects.toThrow(/cancelled/i);
  });

  it('R2-6/8/9/10: full-path /arm64/ classification & non-preview zip filter, skipNetwork with fetchFn, existingLayer.previewDate normalization, and empty {} cache helpers', async () => {
    const dir = makeTempDir('ol-m1-r2-misc-');

    // 6. Full-path /arm64/ classification & non-preview stable filename rejection
    expect(
      environmentProvisioner.classifyCrossOverPreviewArchiveBranch(
        'https://www.codeweavers.com/preview/download/arm64/crossover-preview-20261111.zip'
      )
    ).toBe('arm64');
    expect(
      environmentProvisioner.classifyCrossOverPreviewArchiveBranch(
        'https://www.codeweavers.com/preview/download/crossover-26.3.0.zip'
      )
    ).toBeNull();
    expect(
      environmentProvisioner.selectPreferredCrossOverPreviewDownloadUrl(
        [
          'https://www.codeweavers.com/preview/download/crossover-26.3.0.zip',
          'https://www.codeweavers.com/preview/download/arm64/crossover-preview-20261111.zip',
        ],
        'https://www.codeweavers.com/preview/download',
        { previewBranch: 'standard' }
      )
    ).toBeNull();
    expect(
      environmentProvisioner.selectPreferredCrossOverPreviewDownloadUrl(
        [
          'https://www.codeweavers.com/preview/download/crossover-26.3.0.zip',
          'https://www.codeweavers.com/preview/download/arm64/crossover-preview-20261111.zip',
        ],
        'https://www.codeweavers.com/preview/download',
        { previewBranch: 'arm64' }
      )
    ).toBe('https://www.codeweavers.com/preview/download/arm64/crossover-preview-20261111.zip');

    // 8. skipNetwork: true alongside fetchFn preserves downloadUrl & does not force authRequired: true
    const skipNetUpdates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      layers: [],
      skipNetwork: true,
      fetchFn: vi.fn(async () => {
        throw new Error('fetchFn must not be called when skipNetwork: true');
      }),
    });
    expect(skipNetUpdates.crossover_preview.authRequired).toBe(false);
    expect(skipNetUpdates.crossover_preview.downloadUrl).toBe('https://www.codeweavers.com/preview/download');
    expect(skipNetUpdates.crossover_preview_arm64.authRequired).toBe(false);
    expect(skipNetUpdates.crossover_preview_arm64.downloadUrl).toBe(
      'https://www.codeweavers.com/preview/download'
    );

    // 9. existingLayer.previewDate = '2026-11-11' (dashed ISO) & 'NaN' normalize properly for alreadyUpToDate
    const dashedRes = await environmentProvisioner.installRunnerDirect('crossover_preview', {
      platform: 'darwin',
      arch: 'arm64',
      homedir: dir,
      _runnerOperation: 'update',
      existingLayer: {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(dir, 'CrossOver Preview.app'),
        version: '27.0.0',
        displayVersion: '27.0.0 (Preview 20261111)',
        previewDate: '2026-11-11',
      },
      downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
      skipProcessCheck: true,
    });
    expect(dashedRes.alreadyUpToDate).toBe(true);

    const nanFallbackRes = await environmentProvisioner.installRunnerDirect('crossover_preview', {
      platform: 'darwin',
      arch: 'arm64',
      homedir: dir,
      _runnerOperation: 'update',
      existingLayer: {
        id: 'crossover_preview',
        type: 'crossover_preview',
        name: 'CrossOver Preview',
        appPath: path.join(dir, 'CrossOver Preview.app'),
        version: '27.0.0',
        displayVersion: '27.0.0 (Preview 20261111)',
        previewDate: 'NaN',
      },
      downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
      skipProcessCheck: true,
    });
    expect(nanFallbackRes.alreadyUpToDate).toBe(true);

    // 10. Empty {} options object in cache helpers classifies from URL and clears both branches
    const stdUrl = 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip';
    const arm64Url = 'https://www.codeweavers.com/preview/download/arm64/crossover-preview-20261111.zip';
    macNativeInstaller.setCachedAuthenticatedPreviewUrl(stdUrl, {});
    macNativeInstaller.setCachedAuthenticatedPreviewUrl(arm64Url, {});
    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'standard',
      })
    ).toBe(stdUrl);
    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'arm64',
      })
    ).toBe(arm64Url);

    macNativeInstaller.clearCachedAuthenticatedPreviewUrl({});
    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'standard',
      })
    ).toBeNull();
    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'arm64',
      })
    ).toBeNull();
  });

  it('R3-1/2/3/4/5: untrusted downloadUrl in interactive mode, untrusted stream redirect resp.url, OAuth host as previewPortalUrl fail closed (INSTALLER_URL_BLOCKED, 0 BrowserWindow), OAuth redirect still falls back cleanly, portal URL fails Sparkle enclosure check, and captureCodeWeaversPreviewDownload normalizes previewDate', async () => {
    const dir = makeTempDir('ol-m1-r3-security-');
    const appsDir = path.join(dir, 'Applications');
    fs.mkdirSync(appsDir, { recursive: true });

    let browserWindowCount = 0;
    let externalOpenCount = 0;
    let fetchCallCount = 0;
    class CountingBrowserWindow {
      constructor() {
        browserWindowCount += 1;
      }
    }
    const mockElectronBase = {
      BrowserWindow: CountingBrowserWindow,
      session: {
        fromPartition: () => ({
          setUserAgent: vi.fn(),
          on: vi.fn(),
          removeListener: vi.fn(),
          cookies: { flushStore: vi.fn().mockResolvedValue(undefined) },
        }),
      },
    };

    // 1. Untrusted options.downloadUrl in interactive mode -> INSTALLER_URL_BLOCKED (0 BrowserWindow, 0 openExternal)
    await expect(
      environmentProvisioner.installRunnerDirect('crossover_preview', {
        platform: 'darwin',
        arch: 'arm64',
        homedir: dir,
        customApplicationsDir: appsDir,
        allowInteractivePreviewCapture: true,
        freeDiskBytes: 20 * 1024 * 1024 * 1024,
        downloadUrl: 'https://evil.example.com/crossover-preview-20261111.zip',
        previewSessionFetch: vi.fn(async () => {
          fetchCallCount += 1;
          return { ok: true, status: 200 };
        }),
        openExternalFn: async () => {
          externalOpenCount += 1;
        },
        electronMod: mockElectronBase,
      })
    ).rejects.toMatchObject({ code: 'INSTALLER_URL_BLOCKED' });
    expect(browserWindowCount).toBe(0);
    expect(externalOpenCount).toBe(0);
    expect(fetchCallCount).toBe(0);

    // Also untrusted downloadUrl with credentials or github.com fails closed upfront
    await expect(
      environmentProvisioner.installRunnerDirect('crossover_preview_arm64', {
        platform: 'darwin',
        arch: 'arm64',
        homedir: dir,
        customApplicationsDir: appsDir,
        allowInteractivePreviewCapture: true,
        downloadUrl: 'https://github.com/attacker/crossover-preview-arm64-20261111.zip',
        electronMod: mockElectronBase,
      })
    ).rejects.toMatchObject({ code: 'INSTALLER_URL_BLOCKED' });
    expect(browserWindowCount).toBe(0);

    // 2. Untrusted redirect resp.url in streamPreviewFetch -> INSTALLER_URL_BLOCKED (0 BrowserWindow, 0 openExternal)
    await expect(
      environmentProvisioner.installRunnerDirect('crossover_preview_arm64', {
        platform: 'darwin',
        arch: 'arm64',
        homedir: dir,
        customApplicationsDir: appsDir,
        allowInteractivePreviewCapture: true,
        freeDiskBytes: 20 * 1024 * 1024 * 1024,
        downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.zip',
        previewSessionFetch: vi.fn(async () => ({
          ok: true,
          status: 200,
          url: 'https://evil.example.com/malware.zip',
          headers: new Headers({ 'content-type': 'application/zip', 'content-length': '10' }),
          arrayBuffer: async () => Buffer.from('PK\x03\x04BADZIP'),
        })),
        openExternalFn: async () => {
          externalOpenCount += 1;
        },
        electronMod: mockElectronBase,
      })
    ).rejects.toMatchObject({ code: 'INSTALLER_URL_BLOCKED' });
    expect(browserWindowCount).toBe(0);
    expect(externalOpenCount).toBe(0);

    // 2b. Legitimate OAuth redirect resp.url in streamPreviewFetch (github.com returning 200 HTML) still triggers PREVIEW_AUTH_REQUIRED fallback to BrowserWindow
    let oauthFallbackWindowCreated = false;
    class OAuthFallbackWindow {
      wcListeners: Record<string, Function[]> = {};
      webContents = {
        setUserAgent: vi.fn(),
        getURL: () => 'https://github.com/login/oauth/authorize',
        executeJavaScript: vi.fn(async () => ({ hrefs: [], hasPasswordInput: true })),
        on: vi.fn((evt: string, fn: Function) => {
          this.wcListeners[evt] = this.wcListeners[evt] || [];
          this.wcListeners[evt].push(fn);
        }),
        removeAllListeners: vi.fn(),
      };
      constructor() {
        oauthFallbackWindowCreated = true;
      }
      loadURL() {
        setImmediate(() => {
          for (const fn of this.wcListeners['did-finish-load'] || []) fn();
        });
        return Promise.resolve();
      }
      show() {}
      focus() {}
      moveTop() {}
      hide() {}
      isDestroyed() {
        return false;
      }
      close() {}
      destroy() {}
      on() {}
      removeAllListeners() {}
    }
    await expect(
      environmentProvisioner.installRunnerDirect('crossover_preview', {
        platform: 'darwin',
        arch: 'arm64',
        homedir: dir,
        customApplicationsDir: appsDir,
        allowInteractivePreviewCapture: true,
        timeoutMs: 60,
        freeDiskBytes: 20 * 1024 * 1024 * 1024,
        downloadUrl: 'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        previewSessionFetch: vi.fn(async () => ({
          ok: true,
          status: 200,
          url: 'https://github.com/login/oauth/authorize',
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html><title>Sign in to GitHub</title></html>',
        })),
        electronMod: {
          BrowserWindow: OAuthFallbackWindow,
          session: mockElectronBase.session,
        },
      })
    ).rejects.toThrow(/timed out after 60ms/i);
    expect(oauthFallbackWindowCreated).toBe(true);

    // 3. OAuth IdP host (github.com) as initial previewPortalUrl -> INSTALLER_URL_BLOCKED in both installRunnerDirect and captureCodeWeaversPreviewDownload
    await expect(
      environmentProvisioner.installRunnerDirect('crossover_preview', {
        platform: 'darwin',
        arch: 'arm64',
        homedir: dir,
        customApplicationsDir: appsDir,
        allowInteractivePreviewCapture: true,
        previewPortalUrl: 'https://github.com/attacker/fake-codeweavers-portal',
        previewSessionFetch: vi.fn(async () => {
          fetchCallCount += 1;
          return { ok: true, status: 200 };
        }),
        openExternalFn: async () => {
          externalOpenCount += 1;
        },
        electronMod: mockElectronBase,
      })
    ).rejects.toMatchObject({ code: 'INSTALLER_URL_BLOCKED' });
    await expect(
      environmentProvisioner.installRunnerDirect('crossover_preview', {
        platform: 'darwin',
        arch: 'arm64',
        homedir: dir,
        customApplicationsDir: appsDir,
        skipNetwork: true,
        previewPortalUrl: 'https://github.com/attacker/fake-codeweavers-portal',
        openExternalFn: async () => {
          externalOpenCount += 1;
        },
      })
    ).rejects.toMatchObject({ code: 'INSTALLER_URL_BLOCKED' });
    await expect(
      environmentProvisioner.captureCodeWeaversPreviewDownload(
        path.join(dir, 'oauth-portal-direct'),
        { runId: 'r3-oauth-portal', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
        {
          freeDiskBytes: 20 * 1024 * 1024 * 1024,
          previewPortalUrl: 'https://github.com/attacker/fake-codeweavers-portal',
          electronMod: mockElectronBase,
        }
      )
    ).rejects.toMatchObject({ code: 'INSTALLER_URL_BLOCKED' });
    expect(browserWindowCount).toBe(0);
    expect(externalOpenCount).toBe(0);
    expect(fetchCallCount).toBe(0);

    // 4. classifyCrossOverPreviewArchiveBranch & isPreviewSparkleEnclosureValid reject non-archive portal URLs
    expect(
      environmentProvisioner.classifyCrossOverPreviewArchiveBranch(
        'https://www.codeweavers.com/preview/download'
      )
    ).toBeNull();
    expect(
      macNativeInstaller.isPreviewSparkleEnclosureValid(
        'https://www.codeweavers.com/preview/download',
        { previewBranch: 'standard' }
      )
    ).toBe(false);
    expect(
      macNativeInstaller.isPreviewSparkleEnclosureValid(
        'https://www.codeweavers.com/preview/download',
        { previewBranch: 'arm64' }
      )
    ).toBe(false);
    expect(
      macNativeInstaller.isPreviewSparkleEnclosureValid(
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        { previewBranch: 'standard' }
      )
    ).toBe(true);
    expect(
      macNativeInstaller.isPreviewSparkleEnclosureValid(
        'https://www.codeweavers.com/preview/download/arm64/crossover-preview-20261111.zip',
        { previewBranch: 'arm64' }
      )
    ).toBe(true);

    // 5. captureCodeWeaversPreviewDownload normalizes dashed existingLayer.previewDate ('2026-11-11') in defense-in-depth up-to-date check
    const wcListenersCapture: Record<string, Function[]> = {};
    let downloadUrlTriggered = false;
    class UpToDateCaptureWindow {
      webContents = {
        setUserAgent: vi.fn(),
        getURL: () => 'https://www.codeweavers.com/preview/download',
        executeJavaScript: vi.fn(async () => ({
          hrefs: ['https://www.codeweavers.com/preview/download/crossover-preview-20261111.zip'],
          hasPasswordInput: false,
        })),
        downloadURL: vi.fn(() => {
          downloadUrlTriggered = true;
        }),
        on: vi.fn((evt: string, fn: Function) => {
          wcListenersCapture[evt] = wcListenersCapture[evt] || [];
          wcListenersCapture[evt].push(fn);
        }),
        removeAllListeners: vi.fn(),
      };
      loadURL() {
        setImmediate(() => {
          for (const fn of wcListenersCapture['did-finish-load'] || []) fn();
        });
        return Promise.resolve();
      }
      show() {}
      focus() {}
      moveTop() {}
      hide() {}
      isDestroyed() {
        return false;
      }
      close() {}
      destroy() {}
      on() {}
      removeAllListeners() {}
    }
    const captureAlreadyUpToDate = await environmentProvisioner.captureCodeWeaversPreviewDownload(
      path.join(dir, 'capture-normalized-date'),
      { runId: 'r3-preview-date', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
      {
        _runnerOperation: 'update',
        freeDiskBytes: 20 * 1024 * 1024 * 1024,
        existingLayer: {
          id: 'crossover_preview',
          type: 'crossover_preview',
          name: 'CrossOver Preview',
          appPath: path.join(dir, 'CrossOver Preview.app'),
          version: '27.0.0',
          previewDate: '2026-11-11',
        },
        electronMod: {
          BrowserWindow: UpToDateCaptureWindow,
          session: mockElectronBase.session,
        },
      }
    );
    expect(captureAlreadyUpToDate.alreadyUpToDate).toBe(true);
    expect(downloadUrlTriggered).toBe(false);
  });

  it('R4-1/2/3: rejects embedded credentials across Sparkle feed/enclosure/portal validators and cache, requires archive extension on Sparkle enclosures, normalizes object previewDate, and aborts early on pre-aborted signal', async () => {
    const dir = makeTempDir('ol-m1-r4-');
    const appsDir = path.join(dir, 'Applications');

    // 1. Direct Sparkle feed & enclosure credential & non-archive checks
    expect(
      macNativeInstaller.isPreviewSparkleFeedUrl(
        'https://attacker:secret@www.codeweavers.com/xml/versions/cxpreview.xml'
      )
    ).toBe(false);
    expect(
      macNativeInstaller.isPreviewSparkleFeedUrl(
        'https://token@www.codeweavers.com/preview/sparkle.xml'
      )
    ).toBe(false);
    expect(
      macNativeInstaller.isPreviewSparkleFeedUrl(
        'https://www.codeweavers.com/xml/versions/cxpreview.xml'
      )
    ).toBe(true);

    expect(
      macNativeInstaller.isPreviewSparkleEnclosureValid(
        'https://attacker:secret@www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
        { previewBranch: 'standard' }
      )
    ).toBe(false);
    expect(
      macNativeInstaller.isPreviewSparkleEnclosureValid(
        'https://attacker:secret@www.codeweavers.com/preview/download/arm64/crossover-preview-20261111.zip',
        { previewBranch: 'arm64' }
      )
    ).toBe(false);
    expect(
      macNativeInstaller.isPreviewSparkleEnclosureValid(
        'https://www.codeweavers.com/preview/download/arm64',
        { previewBranch: 'arm64' }
      )
    ).toBe(false);

    // 2. setCachedAuthenticatedPreviewUrl refuses credentialed, untrusted, or bare portal URLs
    macNativeInstaller.clearCachedAuthenticatedPreviewUrl();
    macNativeInstaller.setCachedAuthenticatedPreviewUrl(
      'https://attacker:secret@www.codeweavers.com/preview/download/crossover-preview-20261111.zip',
      'standard'
    );
    macNativeInstaller.setCachedAuthenticatedPreviewUrl(
      'https://attacker:secret@www.codeweavers.com/preview/download/arm64/crossover-preview-20261111.zip',
      'arm64'
    );
    macNativeInstaller.setCachedAuthenticatedPreviewUrl(
      'https://evil.example.com/preview/download/crossover-preview-20261111.zip',
      'standard'
    );
    macNativeInstaller.setCachedAuthenticatedPreviewUrl(
      'https://www.codeweavers.com/preview/download/arm64',
      'arm64'
    );
    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'standard',
      })
    ).toBeNull();
    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'arm64',
      })
    ).toBeNull();

    // 3. checkCompatibilityLayerUpdates never fetches credentialed previewFeedUrl/previewPortalUrl and never leaks credentialed enclosures into downloadUrl or cache
    const stdApp = seedSyntheticPreviewBundle(appsDir, {
      appName: 'CrossOver Preview.app',
      shortVersion: '20261015',
      bundleVersion: '27.0.0.41303',
      suFeedUrl: 'https://attacker:secret@www.codeweavers.com/xml/versions/cxpreview.xml',
    });
    const armApp = seedSyntheticPreviewBundle(appsDir, {
      appName: 'CrossOver Preview arm64.app',
      shortVersion: '20261015',
      bundleVersion: '27.0.0.41303',
      suFeedUrl: 'https://www.codeweavers.com/xml/versions/cxpreview-arm64.xml',
      arm64: true,
    });

    const fetchedSparkleUrls: string[] = [];
    const sparkleCheck = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      previewFeedUrl: 'https://attacker:secret@www.codeweavers.com/xml/versions/cxpreview.xml',
      previewBranch: 'standard',
      previewPortalUrl: 'https://attacker:secret@www.codeweavers.com/preview/download',
      layers: [
        {
          id: 'crossover_preview',
          type: 'crossover_preview',
          name: 'CrossOver Preview',
          appPath: stdApp,
          version: '27.0.0',
          previewDate: '2026-10-15',
        },
        {
          id: 'crossover_preview_arm64',
          type: 'crossover_preview_arm64',
          name: 'CrossOver Preview (Arm64)',
          appPath: armApp,
          version: '27.0.0',
          previewDate: '2026-10-15',
        },
      ],
      previewSessionFetch: vi.fn(async (url: string) => {
        fetchedSparkleUrls.push(url);
        if (url === 'https://www.codeweavers.com/xml/versions/cxpreview-arm64.xml') {
          return {
            ok: true,
            status: 200,
            url,
            text: async () => `<?xml version="1.0"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel><item>
    <enclosure url="https://attacker:secret@www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.zip"
               sparkle:version="27.0.0.41303" sparkle:shortVersionString="20261111" />
  </item></channel>
</rss>`,
          };
        }
        throw new Error(`Unexpected previewSessionFetch URL: ${url}`);
      }),
    });

    expect(fetchedSparkleUrls).not.toContain(
      'https://attacker:secret@www.codeweavers.com/xml/versions/cxpreview.xml'
    );
    expect(fetchedSparkleUrls).not.toContain(
      'https://attacker:secret@www.codeweavers.com/preview/download'
    );
    expect(sparkleCheck.crossover_preview.authRequired).toBe(true);
    expect(sparkleCheck.crossover_preview.downloadUrl).toBeUndefined();
    expect(sparkleCheck.crossover_preview.portalUrl).toBe('https://www.codeweavers.com/preview/download');
    expect(sparkleCheck.crossover_preview_arm64.authRequired).toBe(true);
    expect(sparkleCheck.crossover_preview_arm64.downloadUrl).toBeUndefined();
    expect(sparkleCheck.crossover_preview_arm64.portalUrl).toBe('https://www.codeweavers.com/preview/download');
    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'standard',
      })
    ).toBeNull();
    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'arm64',
      })
    ).toBeNull();

    // Also test credentialed Sparkle enclosure on standard branch directly
    const stdCredentialedEnclosureCheck = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      previewFeedUrl: 'https://www.codeweavers.com/xml/versions/cxpreview.xml',
      previewBranch: 'standard',
      layers: [],
      previewSessionFetch: vi.fn(async (url: string) => {
        if (url === 'https://www.codeweavers.com/xml/versions/cxpreview.xml') {
          return {
            ok: true,
            status: 200,
            url,
            text: async () => `<?xml version="1.0"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel><item>
    <enclosure url="https://attacker:secret@www.codeweavers.com/preview/download/crossover-preview-20261111.zip"
               sparkle:version="27.0.0.41303" sparkle:shortVersionString="20261111" />
  </item></channel>
</rss>`,
          };
        }
        return {
          ok: true,
          status: 200,
          url: 'https://www.codeweavers.com/login',
          text: async () => '<input type="password" />',
        };
      }),
    });
    expect(stdCredentialedEnclosureCheck.crossover_preview.authRequired).toBe(true);
    expect(stdCredentialedEnclosureCheck.crossover_preview.downloadUrl).toBeUndefined();

    // 4. extractRunnerPreviewDate object overload normalizes dashed & dotted dates while keeping NaN safe
    expect(macNativeInstaller.extractRunnerPreviewDate({ previewDate: '2026-11-11' })).toBe('20261111');
    expect(macNativeInstaller.extractRunnerPreviewDate({ previewBuildDate: '2026.11.11' })).toBe('20261111');
    expect(macNativeInstaller.extractRunnerPreviewDate({ previewDate: 'NaN' })).toBeNull();
    expect(
      macNativeInstaller.extractRunnerPreviewDate({
        previewDate: 'NaN',
        displayVersion: '27.0.0 (Preview 20261111)',
      })
    ).toBe('20261111');

    // 5. installRunnerDirect rejects immediately on pre-aborted signal without invoking onExtractArchive
    const localZip = path.join(dir, 'crossover-preview-arm64-20261111.zip');
    fs.writeFileSync(localZip, Buffer.from('PK\x03\x04ZIP'));
    const preAborted = new AbortController();
    preAborted.abort();
    let extractCalled = false;
    await expect(
      environmentProvisioner.installRunnerDirect('crossover_preview_arm64', {
        platform: 'darwin',
        arch: 'arm64',
        homedir: dir,
        customApplicationsDir: appsDir,
        archivePath: localZip,
        signal: preAborted.signal,
        onExtractArchive: async () => {
          extractCalled = true;
        },
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(extractCalled).toBe(false);
  });
});
