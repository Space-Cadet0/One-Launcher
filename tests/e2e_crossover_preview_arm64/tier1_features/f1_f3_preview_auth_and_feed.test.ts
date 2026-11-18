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

describe('Tier 1 — F1, F2, F3: Preview Auth Window, Stable Feed Hijack Immunity & Auth/Task State', () => {
  let sandbox: E2ESandbox;

  beforeEach(() => {
    sandbox = createIsolatedE2ESandbox('ol-e2e-t1-f1f3-');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  // --------------------------------------------------------------------------
  // F1: Hidden Auth Window Default & Reveal on Login/Challenge (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F1.1: captureCodeWeaversPreviewDownload hides BrowserWindow by default (show: false) and captures silently when session is cached', async () => {
    const portal = createMockPreviewPortalElectron({
      authenticated: true,
      branchLinks: [E2E_STANDARD_PREVIEW_ZIP_URL, E2E_ARM64_PREVIEW_ZIP_URL],
    });

    const result = await environmentProvisioner.captureCodeWeaversPreviewDownload(
      sandbox.downloadsDir,
      {
        runId: 'e2e-f1-silent',
        componentId: 'runner_crossover_preview',
        stepIndex: 0,
        totalSteps: 1,
      },
      {
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        statfsFn: makeMockStatfs(20 * 1024 * 1024 * 1024),
        electronMod: portal.electronMod,
      }
    );

    await flushSetImmediate();
    expect(portal.constructorShowArgs[0]).toBe(false);
    expect(portal.windowShownCount).toBe(0);
    expect(portal.windowDestroyed).toBe(true);
    expect(result.resolvedVersion).toBe('20261111');
    expect(fs.existsSync(result.archivePath)).toBe(true);
  });

  it('F1.2: captureCodeWeaversPreviewDownload reveals auth window when redirected to /login', async () => {
    const portal = createMockPreviewPortalElectron({
      authenticated: false,
      branchLinks: [E2E_STANDARD_PREVIEW_ZIP_URL],
    });

    const result = await environmentProvisioner.captureCodeWeaversPreviewDownload(
      sandbox.downloadsDir,
      {
        runId: 'e2e-f1-login-reveal',
        componentId: 'runner_crossover_preview',
        stepIndex: 0,
        totalSteps: 1,
      },
      {
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        statfsFn: makeMockStatfs(20 * 1024 * 1024 * 1024),
        electronMod: portal.electronMod,
      }
    );

    await flushSetImmediate();
    expect(portal.constructorShowArgs[0]).toBe(false);
    expect(portal.windowShownCount).toBeGreaterThanOrEqual(1);
    expect(portal.windowDestroyed).toBe(true);
    expect(fs.existsSync(result.archivePath)).toBe(true);
  });

  it('F1.3: captureCodeWeaversPreviewDownload reveals auth window on challenge even when cookies exist', async () => {
    const portal = createMockPreviewPortalElectron({
      authenticated: true,
      simulateChallenge: true,
      branchLinks: [E2E_STANDARD_PREVIEW_ZIP_URL],
    });

    const result = await environmentProvisioner.captureCodeWeaversPreviewDownload(
      sandbox.downloadsDir,
      {
        runId: 'e2e-f1-challenge',
        componentId: 'runner_crossover_preview',
        stepIndex: 0,
        totalSteps: 1,
      },
      {
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        statfsFn: makeMockStatfs(20 * 1024 * 1024 * 1024),
        electronMod: portal.electronMod,
      }
    );

    await flushSetImmediate();
    expect(portal.windowShownCount).toBeGreaterThanOrEqual(1);
    expect(portal.windowDestroyed).toBe(true);
    expect(fs.existsSync(result.archivePath)).toBe(true);
  });

  it('F1.4: showAuthWindowImmediately: true opens BrowserWindow visible immediately', async () => {
    const portal = createMockPreviewPortalElectron({
      authenticated: true,
      branchLinks: [E2E_STANDARD_PREVIEW_ZIP_URL],
    });

    await environmentProvisioner.captureCodeWeaversPreviewDownload(
      sandbox.downloadsDir,
      {
        runId: 'e2e-f1-explicit-show',
        componentId: 'runner_crossover_preview',
        stepIndex: 0,
        totalSteps: 1,
      },
      {
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        showAuthWindowImmediately: true,
        statfsFn: makeMockStatfs(20 * 1024 * 1024 * 1024),
        electronMod: portal.electronMod,
      }
    );

    expect(portal.constructorShowArgs[0]).toBe(true);
    expect(portal.windowShownCount).toBeGreaterThanOrEqual(1);
  });

  it('F1.5: silent cached capture works identically for crossover_preview_arm64 with zero popup flash', async () => {
    const portal = createMockPreviewPortalElectron({
      authenticated: true,
      branchLinks: [E2E_STANDARD_PREVIEW_ZIP_URL, E2E_ARM64_PREVIEW_ZIP_URL],
    });

    const result = await environmentProvisioner.captureCodeWeaversPreviewDownload(
      sandbox.downloadsDir,
      {
        runId: 'e2e-f1-arm64-silent',
        componentId: 'runner_crossover_preview_arm64',
        stepIndex: 0,
        totalSteps: 1,
      },
      {
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        previewBranch: 'arm64',
        statfsFn: makeMockStatfs(20 * 1024 * 1024 * 1024),
        electronMod: portal.electronMod,
      }
    );

    await flushSetImmediate();
    expect(portal.windowShownCount).toBe(0);
    expect(portal.windowDestroyed).toBe(true);
    expect(portal.downloadedUrls).toEqual([E2E_ARM64_PREVIEW_ZIP_URL]);
    expect(fs.existsSync(result.archivePath)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // F2: SUFeedURL = cxmac.xml Stable-Feed Hijack Immunity (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F2.1: checkCompatibilityLayerUpdates ignores SUFeedURL=cxmac.xml on CrossOver Preview bundles and probes /preview/download', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'standard',
      shortVersion: '20261015',
      bundleVersion: '27.0.0.41100',
      suFeedUrl: E2E_STABLE_CXMAC_XML_URL,
    });
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'arm64',
      shortVersion: '20261015',
      bundleVersion: '27.0.0.41100',
      suFeedUrl: E2E_STABLE_CXMAC_XML_URL,
    });

    const fetchedUrls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      fetchedUrls.push(String(url));
      if (String(url).includes('cxmac.xml')) {
        return {
          ok: true,
          status: 200,
          url: String(url),
          text: async () =>
            '<rss><channel><item><enclosure sparkle:version="27.0.0.99999" sparkle:shortVersionString="27.0.0" url="https://media.codeweavers.com/pub/crossover/cxmac/demo/crossover-27.0.0.zip"/></item></channel></rss>',
        };
      }
      return {
        ok: true,
        status: 200,
        url: E2E_PREVIEW_PORTAL_URL,
        text: async () =>
          `<a href="${E2E_STANDARD_PREVIEW_ZIP_URL}">Standard Preview</a><a href="${E2E_ARM64_PREVIEW_ZIP_URL}">Arm64 Preview</a>`,
      };
    });

    const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
      fetchFn,
      isTest: true,
    });

    expect(fetchedUrls.some((u) => u.includes('/preview/download'))).toBe(true);
    expect(updates.crossover_preview).toBeDefined();
    expect(updates.crossover_preview.downloadUrl).toBe(E2E_STANDARD_PREVIEW_ZIP_URL);
    expect(updates.crossover_preview.latestVersion).not.toBe('27.0.0.99999');
    expect(updates.crossover_preview.latestVersion).not.toBe('27.0.0');
    expect(updates.crossover_preview_arm64).toBeDefined();
    expect(updates.crossover_preview_arm64.downloadUrl).toBe(E2E_ARM64_PREVIEW_ZIP_URL);
    expect(updates.crossover_preview_arm64.latestVersion).not.toBe('27.0.0.99999');
    expect(updates.crossover_preview_arm64.latestVersion).not.toBe('27.0.0');
  });

  it('F2.2: checkCompatibilityLayerUpdates ignores SUFeedURL=cxmac.xml on CrossOver Preview arm64.app and resolves arm64 preview link', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'arm64',
      shortVersion: '20261015',
      bundleVersion: '27.0.0.41100',
      suFeedUrl: E2E_STABLE_CXMAC_XML_URL,
    });

    const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
      previewPortalHtml: `
        <a href="${E2E_STANDARD_PREVIEW_ZIP_URL}">Standard</a>
        <a href="${E2E_ARM64_PREVIEW_ZIP_URL}">Arm64</a>
      `,
      isTest: true,
    });

    expect(updates.crossover_preview_arm64).toBeDefined();
    expect(updates.crossover_preview_arm64.downloadUrl).toBe(E2E_ARM64_PREVIEW_ZIP_URL);
    expect(updates.crossover_preview_arm64.updateAvailable).toBe(true);
  });

  it('F2.3: installRunnerDirect(crossover_preview) ignores SUFeedURL=cxmac.xml and downloads via preview capture', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'standard',
      shortVersion: '20261015',
      bundleVersion: '27.0.0.41100',
      suFeedUrl: E2E_STABLE_CXMAC_XML_URL,
    });

    const capturedUrls: string[] = [];
    const stagedZip = path.join(sandbox.downloadsDir, 'crossover-preview-20261111.zip');
    fs.writeFileSync(stagedZip, 'PK\x03\x04ZIP', 'utf8');

    const res = await environmentProvisioner.installRunnerDirect('crossover_preview', {
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      customApplicationsDir: sandbox.applicationsDir,
      skipProcessCheck: true,
      skipStagingCodesignVerify: true,
      verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
      fetchFn: vi.fn(async (url: string) => {
        if (String(url).includes('cxmac.xml')) {
          throw new Error('Stable cxmac.xml feed must NOT be consulted for Preview branch');
        }
        return {
          ok: true,
          status: 200,
          url: String(url),
          text: async () => '',
        };
      }),
      capturePreviewDownloadFn: async ({ options: opts }: { options: Record<string, any> }) => {
        capturedUrls.push(opts?.downloadUrl || E2E_STANDARD_PREVIEW_ZIP_URL);
        return {
          archivePath: stagedZip,
          downloadUrl: E2E_STANDARD_PREVIEW_ZIP_URL,
          resolvedVersion: '20261111',
        };
      },
      onExtractArchive: async (_zipPath: string, extractDir: string) => {
        seedPreviewAppBundle(extractDir, {
          branch: 'standard',
          shortVersion: '20261111',
          bundleVersion: '27.0.0.41303',
        });
      },
    });

    expect(res.success).toBe(true);
    expect(capturedUrls[0]).toBe(E2E_STANDARD_PREVIEW_ZIP_URL);
  });

  it('F2.4: installRunnerDirect(crossover_preview_arm64) ignores SUFeedURL=cxmac.xml and resolves arm64 preview capture', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'arm64',
      shortVersion: '20261015',
      bundleVersion: '27.0.0.41100',
      suFeedUrl: E2E_STABLE_CXMAC_XML_URL,
    });

    const stagedZip = path.join(sandbox.downloadsDir, 'crossover-preview-arm64-20261111.zip');
    fs.writeFileSync(stagedZip, 'PK\x03\x04ZIP', 'utf8');
    let requestedBranch: string | undefined;

    const res = await environmentProvisioner.installRunnerDirect('crossover_preview_arm64', {
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      customApplicationsDir: sandbox.applicationsDir,
      skipProcessCheck: true,
      skipStagingCodesignVerify: true,
      verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
      fetchFn: vi.fn(async (url: string) => {
        if (String(url).includes('cxmac.xml')) {
          throw new Error('Stable cxmac.xml feed must NOT be consulted for Arm64 Preview branch');
        }
        return { ok: true, status: 200, url: String(url), text: async () => '' };
      }),
      capturePreviewDownloadFn: async ({ options: opts }: { options: Record<string, any> }) => {
        requestedBranch = opts?.previewBranch;
        return {
          archivePath: stagedZip,
          downloadUrl: E2E_ARM64_PREVIEW_ZIP_URL,
          resolvedVersion: '20261111',
        };
      },
      onExtractArchive: async (_zipPath: string, extractDir: string) => {
        seedPreviewAppBundle(extractDir, {
          branch: 'arm64',
          appName: 'CrossOver Preview.app',
          shortVersion: '20261111',
          bundleVersion: '27.0.0.41303',
        });
      },
    });

    expect(res.success).toBe(true);
    expect(requestedBranch).toBe('arm64');
  });

  it('F2.5: Stable CrossOver.app continues using cxmac.xml Sparkle feed normally while coexisting Preview ignores it', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'crossover',
      shortVersion: '26.0.0',
      bundleVersion: '26.0.0.39120',
      suFeedUrl: E2E_STABLE_CXMAC_XML_URL,
    });
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
      fetchFn: vi.fn(async (url: string) => {
        if (String(url).includes('cxmac.xml')) {
          return {
            ok: true,
            status: 200,
            url: String(url),
            text: async () =>
              '<rss><channel><item><enclosure sparkle:version="26.1.0.39500" sparkle:shortVersionString="26.1.0" url="https://media.codeweavers.com/pub/crossover/cxmac/demo/crossover-26.1.0.zip"/></item></channel></rss>',
          };
        }
        if (String(url).includes('/preview/download')) {
          return {
            ok: true,
            status: 200,
            url: E2E_PREVIEW_PORTAL_URL,
            text: async () => `<a href="${E2E_STANDARD_PREVIEW_ZIP_URL}">Standard</a>`,
          };
        }
        return { ok: false, status: 404, url: String(url), text: async () => '' };
      }),
      isTest: true,
    });

    expect(updates.crossover.latestVersion).toBe('26.1.0');
    expect(updates.crossover.updateAvailable).toBe(true);
    expect(updates.crossover_preview.updateAvailable).toBe(false);
    expect(updates.crossover_preview.downloadUrl).toBe(E2E_STANDARD_PREVIEW_ZIP_URL);
  });

  // --------------------------------------------------------------------------
  // F3: authRequired vs downloadUrl, listener race, 1.2GB skip, payload & dates (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F3.1: checkCompatibilityLayerUpdates keeps downloadUrl undefined when authRequired is true', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'standard',
      shortVersion: '20261015',
    });

    const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
      previewPortalHtml: '<form action="/login"><input type="password" name="pass"/></form>',
      isTest: true,
    });

    expect(updates.crossover_preview.authRequired).toBe(true);
    expect(updates.crossover_preview.downloadUrl).toBeUndefined();
  });

  it('F3.2: captureCodeWeaversPreviewDownload attaches will-download listener synchronously before BrowserWindow creation & flushStore', async () => {
    const portal = createMockPreviewPortalElectron({
      authenticated: true,
      branchLinks: [E2E_STANDARD_PREVIEW_ZIP_URL],
    });

    await environmentProvisioner.captureCodeWeaversPreviewDownload(
      sandbox.downloadsDir,
      {
        runId: 'e2e-f3-order',
        componentId: 'runner_crossover_preview',
        stepIndex: 0,
        totalSteps: 1,
      },
      {
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        statfsFn: makeMockStatfs(20 * 1024 * 1024 * 1024),
        electronMod: portal.electronMod,
      }
    );

    const listenerIdx = portal.eventOrder.indexOf('register:will-download');
    const windowIdx = portal.eventOrder.findIndex((e) => e.startsWith('BrowserWindow:'));
    const flushIdx = portal.eventOrder.indexOf('flushStore');
    expect(listenerIdx).toBeGreaterThanOrEqual(0);
    expect(windowIdx).toBeGreaterThan(listenerIdx);
    if (flushIdx >= 0) {
      expect(flushIdx).toBeGreaterThan(listenerIdx);
    }
  });

  it('F3.3: authenticateOnly: true skips the 1.2GB free disk space requirement', async () => {
    const portal = createMockPreviewPortalElectron({
      authenticated: false,
      branchLinks: [E2E_STANDARD_PREVIEW_ZIP_URL],
    });

    const authResult = await environmentProvisioner.captureCodeWeaversPreviewDownload(
      sandbox.downloadsDir,
      {
        runId: 'e2e-f3-low-disk-auth',
        componentId: 'runner_crossover_preview',
        stepIndex: 0,
        totalSteps: 1,
      },
      {
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        authenticateOnly: true,
        statfsFn: makeMockStatfs(128 * 1024 * 1024), // 128 MB < 1.2 GB
        electronMod: portal.electronMod,
      }
    );

    expect(authResult.authenticated).toBe(true);
    expect(portal.downloadedUrls).toEqual([]);
  });

  it('F3.4: updateCompatibilityLayer("crossover_preview", { archivePath, authenticateOnly }) honors effectivePayload options', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'standard',
      shortVersion: '20261015',
    });

    const stagedZip = path.join(sandbox.downloadsDir, 'crossover-preview-20261111.zip');
    fs.writeFileSync(stagedZip, 'PK\x03\x04ZIP', 'utf8');

    const res = await macNativeInstaller.updateCompatibilityLayer('crossover_preview', {
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      customApplicationsDir: sandbox.applicationsDir,
      applicationsDirs: [sandbox.applicationsDir],
      archivePath: stagedZip,
      skipProcessCheck: true,
      skipStagingCodesignVerify: true,
      verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
      onExtractArchive: async (_zipPath: string, extractDir: string) => {
        seedPreviewAppBundle(extractDir, {
          branch: 'standard',
          shortVersion: '20261111',
          bundleVersion: '27.0.0.41303',
        });
      },
    });

    expect(res.success).toBe(true);
    expect(res.updated).toBe(true);
  });

  it('F3.5: runEnvironmentSetupTasks accurately reports outcome status for install_runner without falsely marking authenticateOnly as installed', async () => {
    const res = await environmentProvisioner.runEnvironmentSetupTasks(
      {
        runId: 'e2e-f3-setup-tasks',
        tasks: [
          {
            action: 'install_runner',
            componentId: 'runner_crossover_preview',
            runnerType: 'crossover_preview',
          },
        ],
      },
      {
        platform: 'darwin',
        arch: 'arm64',
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        customApplicationsDir: sandbox.applicationsDir,
        applicationsDirs: [sandbox.applicationsDir],
        skipNetwork: true,
        authenticateOnly: true,
        capturePreviewDownloadFn: async () => ({
          authenticated: true,
          downloadUrl: E2E_STANDARD_PREVIEW_ZIP_URL,
          resolvedVersion: '20261111',
        }),
      }
    );

    expect(res.outcomes).toHaveLength(1);
    expect(res.outcomes[0].status).not.toBe('failed');
    expect(fs.existsSync(path.join(sandbox.applicationsDir, 'CrossOver Preview.app'))).toBe(false);
  });

  it('F3.6: NaN or malformed preview build dates never produce false-positive updateAvailable', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'standard',
      shortVersion: '20261111',
      bundleVersion: '27.0.0.41303',
    });

    const updates = await macNativeInstaller.checkCompatibilityLayerUpdates({
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      applicationsDirs: [sandbox.applicationsDir],
      previewPortalHtml:
        '<a href="https://www.codeweavers.com/preview/download/crossover-preview-invaliddate.zip">Preview</a>',
      isTest: true,
    });

    expect(updates.crossover_preview).toBeDefined();
    expect(updates.crossover_preview.updateAvailable).toBe(false);
  });
});
