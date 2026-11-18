import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  E2ESandbox,
  E2E_ARM64_PREVIEW_ZIP_URL,
  E2E_PREVIEW_PORTAL_URL,
  E2E_STABLE_CXMAC_XML_URL,
  E2E_STANDARD_PREVIEW_ZIP_URL,
  createIsolatedE2ESandbox,
  createMockPreviewPortalElectron,
  environmentProvisioner,
  flushSetImmediate,
  macNativeInstaller,
  makeMockStatfs,
  seedPreviewAppBundle,
} from '../harness';

describe('Tier 2 — F1–F5 Boundaries: Preview Portal, Feed Hijack, Cache & Atomic Install Edge Cases', () => {
  let sandbox: E2ESandbox;

  beforeEach(() => {
    sandbox = createIsolatedE2ESandbox('ol-e2e-t2-portal-');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  // --------------------------------------------------------------------------
  // F1 Boundaries (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F1.B1: user closing the auth BrowserWindow cancels capture cleanly with cancelled: true', async () => {
    const portal = createMockPreviewPortalElectron({
      authenticated: false,
      cancelAuth: true,
    });

    const result = await environmentProvisioner.captureCodeWeaversPreviewDownload(
      sandbox.downloadsDir,
      { runId: 't2-f1-cancel', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
      {
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        statfsFn: makeMockStatfs(20 * 1024 * 1024 * 1024),
        electronMod: portal.electronMod,
      }
    ).catch((err: unknown) => ({
      cancelled: true,
      error: err instanceof Error ? err.message : String(err),
    }));

    expect(result.cancelled === true || /cancel|closed/i.test(String(result.error || ''))).toBe(true);
    expect(portal.windowDestroyed).toBe(true);
  });

  it('F1.B2: aborted signal before portal navigation cleans up BrowserWindow without hanging', async () => {
    const portal = createMockPreviewPortalElectron({ authenticated: true });
    const ac = new AbortController();
    ac.abort();

    const res = await environmentProvisioner
      .captureCodeWeaversPreviewDownload(
        sandbox.downloadsDir,
        { runId: 't2-f1-abort', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
        {
          homedir: sandbox.homedir,
          userDataDir: sandbox.userDataDir,
          statfsFn: makeMockStatfs(20 * 1024 * 1024 * 1024),
          electronMod: portal.electronMod,
        },
        ac.signal
      )
      .catch((err: unknown) => ({ cancelled: true, error: String(err) }));

    expect(res.cancelled === true || /abort|cancel/i.test(String(res.error || ''))).toBe(true);
  });

  it('F1.B3: explicit show: false still stays hidden when session is authenticated (zero popup flash)', async () => {
    const portal = createMockPreviewPortalElectron({
      authenticated: true,
      branchLinks: [E2E_STANDARD_PREVIEW_ZIP_URL],
    });

    await environmentProvisioner.captureCodeWeaversPreviewDownload(
      sandbox.downloadsDir,
      { runId: 't2-f1-show-false', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
      {
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        show: false,
        showAuthWindowImmediately: false,
        statfsFn: makeMockStatfs(20 * 1024 * 1024 * 1024),
        electronMod: portal.electronMod,
      }
    );

    expect(portal.constructorShowArgs[0]).toBe(false);
    expect(portal.windowShownCount).toBe(0);
  });

  it('F1.B4: authenticateOnly opens Sign-In window and settles cleanly with authenticated: true without downloading', async () => {
    const portal = createMockPreviewPortalElectron({
      authenticated: true,
      branchLinks: [E2E_STANDARD_PREVIEW_ZIP_URL, E2E_ARM64_PREVIEW_ZIP_URL],
    });

    const res = await environmentProvisioner.captureCodeWeaversPreviewDownload(
      sandbox.downloadsDir,
      { runId: 't2-f1-auth-only', componentId: 'runner_crossover_preview_arm64', stepIndex: 0, totalSteps: 1 },
      {
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        authenticateOnly: true,
        previewBranch: 'arm64',
        electronMod: portal.electronMod,
      }
    );

    await flushSetImmediate();
    expect(res.authenticated).toBe(true);
    expect(portal.constructorShowArgs[0]).toBe(true);
    expect(portal.windowShownCount).toBeGreaterThanOrEqual(1);
    expect(portal.downloadedUrls).toEqual([]);
    expect(portal.windowDestroyed).toBe(true);
  });

  it('F1.B5: missing electronMod in non-Electron test environment fails gracefully without crashing process', async () => {
    const res = await environmentProvisioner
      .captureCodeWeaversPreviewDownload(
        sandbox.downloadsDir,
        { runId: 't2-f1-no-electron', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
        {
          homedir: sandbox.homedir,
          userDataDir: sandbox.userDataDir,
          statfsFn: makeMockStatfs(20 * 1024 * 1024 * 1024),
          electronMod: {},
        }
      )
      .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));

    expect(res.error || res.success === false).toBeTruthy();
  });

  // --------------------------------------------------------------------------
  // F2 Boundaries (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F2.B1: cxmac.xml advertising higher version 99.0.0 never hijacks crossover_preview downloadUrl or latestVersion', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'standard',
      shortVersion: '20261111',
      bundleVersion: '27.0.0.41303',
      suFeedUrl: E2E_STABLE_CXMAC_XML_URL,
    });

    const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
      mockFeeds: {
        crossover: {
          latestVersion: '99.0.0',
          downloadUrl: 'https://media.codeweavers.com/pub/crossover/cxmac/demo/crossover-99.0.0.zip',
        },
        crossover_preview: {
          latestVersion: '20261111',
          previewDate: '20261111',
          previewBranch: 'standard',
          downloadUrl: E2E_STANDARD_PREVIEW_ZIP_URL,
          canAutoUpdate: true,
        },
      },
      isTest: true,
    });

    expect(updates.crossover.latestVersion).toBe('99.0.0');
    expect(updates.crossover_preview.latestVersion).toBe('20261111');
    expect(updates.crossover_preview.latestVersion).not.toBe('99.0.0');
    expect(updates.crossover_preview.downloadUrl).toBe(E2E_STANDARD_PREVIEW_ZIP_URL);
  });

  it('F2.B2: cxmac.xml advertising higher version 99.0.0 never hijacks crossover_preview_arm64 update metadata', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'arm64',
      shortVersion: '20261111',
      bundleVersion: '27.0.0.41303',
      suFeedUrl: E2E_STABLE_CXMAC_XML_URL,
    });

    const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
      mockFeeds: {
        crossover: {
          latestVersion: '99.0.0',
          downloadUrl: 'https://media.codeweavers.com/pub/crossover/cxmac/demo/crossover-99.0.0.zip',
        },
        crossover_preview_arm64: {
          latestVersion: '20261111',
          previewDate: '20261111',
          previewBranch: 'arm64',
          downloadUrl: E2E_ARM64_PREVIEW_ZIP_URL,
          canAutoUpdate: true,
        },
      },
      isTest: true,
    });

    expect(updates.crossover.latestVersion).toBe('99.0.0');
    expect(updates.crossover_preview_arm64.updateAvailable).toBe(false);
    expect(updates.crossover_preview_arm64.latestVersion).toBe('20261111');
    expect(updates.crossover_preview_arm64.latestVersion).not.toBe('99.0.0');
    expect(updates.crossover_preview_arm64.downloadUrl).toBe(E2E_ARM64_PREVIEW_ZIP_URL);
  });

  it('F2.B3: custom non-preview SUFeedURL in Info.plist is also ignored for both Preview branches', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'arm64',
      shortVersion: '20261015',
      suFeedUrl: 'https://www.codeweavers.com/xml/versions/custom-stable.xml',
    });

    const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
      previewPortalHtml: `<a href="${E2E_ARM64_PREVIEW_ZIP_URL}">Arm64 Preview</a>`,
      isTest: true,
    });

    expect(updates.crossover_preview_arm64.downloadUrl).toBe(E2E_ARM64_PREVIEW_ZIP_URL);
  });

  it('F2.B4: network failure on cxmac.xml does not fail Preview branch update checks', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'standard',
      shortVersion: '20261015',
      suFeedUrl: E2E_STABLE_CXMAC_XML_URL,
    });

    const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
      fetchFn: vi.fn(async (url: string) => {
        if (String(url).includes('cxmac.xml')) {
          throw new Error('cxmac.xml offline');
        }
        return {
          ok: true,
          status: 200,
          url: E2E_PREVIEW_PORTAL_URL,
          text: async () => `<a href="${E2E_STANDARD_PREVIEW_ZIP_URL}">Preview</a>`,
        };
      }),
      previewPortalHtml: `<a href="${E2E_STANDARD_PREVIEW_ZIP_URL}">Preview</a>`,
      isTest: true,
    });

    expect(updates.crossover_preview.updateAvailable).toBe(true);
    expect(updates.crossover_preview.downloadUrl).toBe(E2E_STANDARD_PREVIEW_ZIP_URL);
  });

  it('F2.B5: installRunnerDirect refuses to treat cxmac.xml stable zip as a Preview install when runnerType is crossover_preview_arm64', async () => {
    const portal = createMockPreviewPortalElectron({
      authenticated: true,
      branchLinks: [E2E_ARM64_PREVIEW_ZIP_URL],
    });
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).includes('cxmac.xml')) {
        throw new Error('Must not fetch cxmac.xml for crossover_preview_arm64');
      }
      return { ok: true, status: 200, url: String(url), text: async () => '' };
    });

    const res = await environmentProvisioner.installRunnerDirect('crossover_preview_arm64', {
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      customApplicationsDir: sandbox.applicationsDir,
      skipProcessCheck: true,
      skipStagingCodesignVerify: true,
      allowInteractivePreviewCapture: true,
      statfsFn: makeMockStatfs(20 * 1024 * 1024 * 1024),
      electronMod: portal.electronMod,
      fetchFn,
      verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
      onExtractArchive: async (_zip: string, dir: string) => {
        seedPreviewAppBundle(dir, { branch: 'arm64', appName: 'CrossOver Preview.app' });
      },
    });

    expect(res.success).toBe(true);
    expect(fetchFn.mock.calls.some((c) => String(c[0]).includes('cxmac.xml'))).toBe(false);
  });

  // --------------------------------------------------------------------------
  // F3 Boundaries (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F3.B1: authRequired: true never leaks default portal URL as downloadUrl for crossover_preview_arm64', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64', shortVersion: '20261015' });

    const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
      previewPortalHtml: '<html><body><form action="/login"><input type="password"/></form></body></html>',
      isTest: true,
    });

    expect(updates.crossover_preview_arm64.authRequired).toBe(true);
    expect(updates.crossover_preview_arm64.downloadUrl).toBeUndefined();
  });

  it('F3.B2: interrupted download item rejects cleanly without leaving final .zip artifact', async () => {
    const portal = createMockPreviewPortalElectron({
      authenticated: true,
      branchLinks: [E2E_STANDARD_PREVIEW_ZIP_URL],
      failDownloadState: 'interrupted',
    });

    const res = await environmentProvisioner
      .captureCodeWeaversPreviewDownload(
        sandbox.downloadsDir,
        { runId: 't2-f3-interrupted', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
        {
          homedir: sandbox.homedir,
          userDataDir: sandbox.userDataDir,
          statfsFn: makeMockStatfs(20 * 1024 * 1024 * 1024),
          electronMod: portal.electronMod,
        }
      )
      .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));

    expect(res.error || res.success === false).toBeTruthy();
    expect(fs.readdirSync(sandbox.downloadsDir).filter((f) => f.endsWith('.zip'))).toEqual([]);
  });

  it('F3.B3: authenticateOnly: true succeeds even when statfsFn reports 0 free bytes', async () => {
    const portal = createMockPreviewPortalElectron({ authenticated: true });

    const res = await environmentProvisioner.captureCodeWeaversPreviewDownload(
      sandbox.downloadsDir,
      { runId: 't2-f3-zero-disk', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
      {
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        authenticateOnly: true,
        statfsFn: makeMockStatfs(0),
        electronMod: portal.electronMod,
      }
    );

    expect(res.authenticated).toBe(true);
  });

  it('F3.B4: captureCodeWeaversPreviewDownload with non-authenticateOnly low disk space (<1.2GB) fails cleanly with disk space error', async () => {
    const portal = createMockPreviewPortalElectron({ authenticated: true });

    const res = await environmentProvisioner
      .captureCodeWeaversPreviewDownload(
        sandbox.downloadsDir,
        { runId: 't2-f3-low-disk-dl', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
        {
          homedir: sandbox.homedir,
          userDataDir: sandbox.userDataDir,
          authenticateOnly: false,
          statfsFn: makeMockStatfs(100 * 1024 * 1024),
          electronMod: portal.electronMod,
        }
      )
      .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));

    expect(String(res.error || '')).toMatch(/space|disk|MB|GB/i);
  });

  it('F3.B5: NaN / empty / malformed preview dates on candidate links do not throw or trigger false updateAvailable', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'arm64',
      shortVersion: 'not-a-date',
      bundleVersion: '27.0.0.41303',
    });

    const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
      previewPortalHtml:
        '<a href="https://www.codeweavers.com/preview/download/crossover-preview-arm64-NaN.zip">Arm64</a>',
      isTest: true,
    });

    expect(updates.crossover_preview_arm64).toBeDefined();
    expect(updates.crossover_preview_arm64.updateAvailable).toBe(false);
  });

  // --------------------------------------------------------------------------
  // F4 Boundaries (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F4.B1: selectPreferredCrossOverPreviewDownloadUrl returns null for standard when only arm64 candidate exists', () => {
    const selected = environmentProvisioner.selectPreferredCrossOverPreviewDownloadUrl(
      [E2E_ARM64_PREVIEW_ZIP_URL],
      E2E_PREVIEW_PORTAL_URL,
      { previewBranch: 'standard' }
    );
    expect(selected).toBeNull();
  });

  it('F4.B2: selectPreferredCrossOverPreviewDownloadUrl returns null for arm64 when only standard candidate exists', () => {
    const selected = environmentProvisioner.selectPreferredCrossOverPreviewDownloadUrl(
      [E2E_STANDARD_PREVIEW_ZIP_URL],
      E2E_PREVIEW_PORTAL_URL,
      { previewBranch: 'arm64' }
    );
    expect(selected).toBeNull();
  });

  it('F4.B3: selectPreferredCrossOverPreviewDownloadUrl rejects Linux packages and untrusted hosts', () => {
    const selected = environmentProvisioner.selectPreferredCrossOverPreviewDownloadUrl(
      [
        'https://evil.example.com/preview/download/crossover-preview-arm64-20261111.zip',
        'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.deb',
        'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261111.rpm',
        'https://www.codeweavers.com/preview/download/crossover-preview-arm64-src.tar.gz',
      ],
      E2E_PREVIEW_PORTAL_URL,
      { previewBranch: 'arm64' }
    );
    expect(selected).toBeNull();
  });

  it('F4.B4: auth failure / login redirect during update check invalidates cached branch URL', async () => {
    macNativeInstaller.cacheAuthenticatedPreviewUrl(E2E_ARM64_PREVIEW_ZIP_URL, {
      previewBranch: 'arm64',
    });

    seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64', shortVersion: '20261015' });

    const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
      previewPortalHtml: '<form action="/login"><input type="password"/></form>',
      isTest: true,
    });

    expect(updates.crossover_preview_arm64.authRequired).toBe(true);
    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'arm64',
      })
    ).toBeNull();
  });

  it('F4.B5: selectPreferredCrossOverPreviewDownloadUrl picks newest YYYYMMDD arm64 build regardless of input order', () => {
    const older = 'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261015.zip';
    const newer = E2E_ARM64_PREVIEW_ZIP_URL;
    const selected = environmentProvisioner.selectPreferredCrossOverPreviewDownloadUrl(
      [older, newer],
      E2E_PREVIEW_PORTAL_URL,
      { previewBranch: 'arm64' }
    );
    expect(selected).toBe(newer);
  });

  // --------------------------------------------------------------------------
  // F5 Boundaries (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F5.B1: strict codesign failure after arm64 rename aborts install and preserves pre-existing CrossOver Preview arm64.app', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'arm64',
      shortVersion: '20261015',
    });
    const stagedZip = path.join(sandbox.downloadsDir, 'crossover-preview-arm64-20261111.zip');
    fs.writeFileSync(stagedZip, 'PK\x03\x04ZIP', 'utf8');

    await expect(
      environmentProvisioner.installRunnerDirect('crossover_preview_arm64', {
        platform: 'darwin',
        arch: 'arm64',
        homedir: sandbox.homedir,
        customApplicationsDir: sandbox.applicationsDir,
        archivePath: stagedZip,
        skipProcessCheck: true,
        verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
        execFileFn: (
          cmd: string,
          args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          if (String(cmd).includes('codesign') && args.includes('--strict')) {
            cb(new Error('codesign strict verification failed'), '', 'sealed resource missing');
            return;
          }
          cb(null, '', '');
        },
        onExtractArchive: async (_zip: string, extractDir: string) => {
          seedPreviewAppBundle(extractDir, {
            branch: 'arm64',
            appName: 'CrossOver Preview.app',
            shortVersion: '20261111',
          });
        },
      })
    ).rejects.toThrow(/codesign|strict|verification/i);

    const preservedPlist = fs.readFileSync(
      path.join(sandbox.applicationsDir, 'CrossOver Preview arm64.app/Contents/Info.plist'),
      'utf8'
    );
    expect(preservedPlist).toContain('20261015');
  });

  it('F5.B2: wrong CodeWeavers Developer ID Team ID is rejected before touching applicationsDir', async () => {
    const stagedZip = path.join(sandbox.downloadsDir, 'crossover-preview-arm64-20261111.zip');
    fs.writeFileSync(stagedZip, 'PK\x03\x04ZIP', 'utf8');

    await expect(
      environmentProvisioner.installRunnerDirect('crossover_preview_arm64', {
        platform: 'darwin',
        arch: 'arm64',
        homedir: sandbox.homedir,
        customApplicationsDir: sandbox.applicationsDir,
        archivePath: stagedZip,
        skipProcessCheck: true,
        verifySignatureFn: async () => ({
          valid: false,
          teamIdentifier: 'WRONGTEAM1',
          error: 'Team mismatch',
        }),
        onExtractArchive: async (_zip: string, extractDir: string) => {
          seedPreviewAppBundle(extractDir, { branch: 'arm64', appName: 'CrossOver Preview.app' });
        },
      })
    ).rejects.toThrow(/team mismatch|signature/i);

    expect(fs.existsSync(path.join(sandbox.applicationsDir, 'CrossOver Preview arm64.app'))).toBe(
      false
    );
  });

  it('F5.B3: non-writable target applicationsDir fails fast with permission/access error', async () => {
    const readOnlyAppsDir = path.join(sandbox.tmpRoot, 'ReadOnlyApps');
    fs.mkdirSync(readOnlyAppsDir, { recursive: true });
    fs.chmodSync(readOnlyAppsDir, 0o555);
    const stagedZip = path.join(sandbox.downloadsDir, 'crossover-preview-arm64-20261111.zip');
    fs.writeFileSync(stagedZip, 'PK\x03\x04ZIP', 'utf8');

    try {
      await expect(
        environmentProvisioner.installRunnerDirect('crossover_preview_arm64', {
          platform: 'darwin',
          arch: 'arm64',
          homedir: sandbox.homedir,
          customApplicationsDir: readOnlyAppsDir,
          archivePath: stagedZip,
          skipProcessCheck: true,
          skipStagingCodesignVerify: true,
          verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
          onExtractArchive: async (_zip: string, extractDir: string) => {
            seedPreviewAppBundle(extractDir, { branch: 'arm64', appName: 'CrossOver Preview.app' });
          },
        })
      ).rejects.toThrow(/permission|writable|access|EACCES|EROFS/i);
    } finally {
      fs.chmodSync(readOnlyAppsDir, 0o755);
    }
  });

  it('F5.B4: archive containing no .app bundle fails cleanly and leaves no staging directories', async () => {
    const stagedZip = path.join(sandbox.downloadsDir, 'empty-preview.zip');
    fs.writeFileSync(stagedZip, 'PK\x03\x04EMPTY', 'utf8');

    await expect(
      environmentProvisioner.installRunnerDirect('crossover_preview_arm64', {
        platform: 'darwin',
        arch: 'arm64',
        homedir: sandbox.homedir,
        customApplicationsDir: sandbox.applicationsDir,
        archivePath: stagedZip,
        skipProcessCheck: true,
        onExtractArchive: async (_zip: string, extractDir: string) => {
          fs.writeFileSync(path.join(extractDir, 'README.txt'), 'not an app', 'utf8');
        },
      })
    ).rejects.toThrow(/No macOS \.app bundle/i);

    expect(fs.existsSync(path.join(sandbox.applicationsDir, 'CrossOver Preview arm64.app'))).toBe(
      false
    );
  });

  it('F5.B5: running CrossOver Preview process blocks replacement cleanly via assertRunnerSafeToReplace', async () => {
    const appBundle = seedPreviewAppBundle(sandbox.applicationsDir, { branch: 'arm64' });
    const safeRes = await environmentProvisioner.assertRunnerSafeToReplace(
      'crossover_preview_arm64',
      appBundle.appPath,
      null,
      {
        platform: 'darwin',
        homedir: sandbox.homedir,
        mockProcessListOutput: `${process.pid + 100} ${appBundle.appPath}/Contents/MacOS/CrossOver\n`,
      }
    );

    expect(safeRes.ok).toBe(false);
    expect(String(safeRes.error || '')).toMatch(/running|close|quit/i);
  });
});
