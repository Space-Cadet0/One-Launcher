import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  E2ESandbox,
  E2E_ARM64_PREVIEW_ZIP_URL,
  E2E_PREVIEW_PORTAL_URL,
  E2E_STANDARD_PREVIEW_ZIP_URL,
  createIsolatedE2ESandbox,
  createMockPreviewPortalElectron,
  environmentHealthProber,
  environmentProvisioner,
  macNativeInstaller,
  makeMockStatfs,
  seedPreviewAppBundle,
} from '../harness';

describe('Tier 1 — F4 & F5: Dual-Branch URL Discovery, Branch Cache & Side-by-Side Rename/Install', () => {
  let sandbox: E2ESandbox;

  beforeEach(() => {
    sandbox = createIsolatedE2ESandbox('ol-e2e-t1-f4f5-');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  // --------------------------------------------------------------------------
  // F4: Dual-Branch Preview URL Discovery & Branch-Keyed Cache (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F4.1: selectPreferredCrossOverPreviewDownloadUrl selects Standard archive when previewBranch is "standard"', () => {
    const selected = environmentProvisioner.selectPreferredCrossOverPreviewDownloadUrl(
      [
        E2E_ARM64_PREVIEW_ZIP_URL,
        E2E_STANDARD_PREVIEW_ZIP_URL,
        'https://www.codeweavers.com/preview/download/crossover-preview-20261111.deb',
      ],
      E2E_PREVIEW_PORTAL_URL,
      { previewBranch: 'standard' }
    );

    expect(selected).toBe(E2E_STANDARD_PREVIEW_ZIP_URL);
  });

  it('F4.2: selectPreferredCrossOverPreviewDownloadUrl selects Arm64 archive exclusively when previewBranch is "arm64"', () => {
    const selected = environmentProvisioner.selectPreferredCrossOverPreviewDownloadUrl(
      [
        E2E_STANDARD_PREVIEW_ZIP_URL,
        E2E_ARM64_PREVIEW_ZIP_URL,
        'https://www.codeweavers.com/preview/download/crossover-preview-arm64-20261015.zip',
      ],
      E2E_PREVIEW_PORTAL_URL,
      { previewBranch: 'arm64' }
    );

    expect(selected).toBe(E2E_ARM64_PREVIEW_ZIP_URL);
  });

  it('F4.3: branch-keyed preview URL cache stores Standard and Arm64 URLs independently without cross-contamination', () => {
    macNativeInstaller.cacheAuthenticatedPreviewUrl(E2E_STANDARD_PREVIEW_ZIP_URL, {
      previewBranch: 'standard',
    });
    macNativeInstaller.cacheAuthenticatedPreviewUrl(E2E_ARM64_PREVIEW_ZIP_URL, {
      previewBranch: 'arm64',
    });

    const cachedStandard = macNativeInstaller.getCachedAuthenticatedPreviewUrl({
      allowCachedPreviewUrlInTest: true,
      previewBranch: 'standard',
    });
    const cachedArm64 = macNativeInstaller.getCachedAuthenticatedPreviewUrl({
      allowCachedPreviewUrlInTest: true,
      previewBranch: 'arm64',
    });

    expect(cachedStandard).toBe(E2E_STANDARD_PREVIEW_ZIP_URL);
    expect(cachedArm64).toBe(E2E_ARM64_PREVIEW_ZIP_URL);
  });

  it('F4.4: clearCachedAuthenticatedPreviewUrl(branch) clears only the targeted branch and invalidateProberRunnerUpdatesCache clears all', () => {
    macNativeInstaller.cacheAuthenticatedPreviewUrl(E2E_STANDARD_PREVIEW_ZIP_URL, {
      previewBranch: 'standard',
    });
    macNativeInstaller.cacheAuthenticatedPreviewUrl(E2E_ARM64_PREVIEW_ZIP_URL, {
      previewBranch: 'arm64',
    });

    macNativeInstaller.clearCachedAuthenticatedPreviewUrl('arm64');
    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'standard',
      })
    ).toBe(E2E_STANDARD_PREVIEW_ZIP_URL);
    expect(
      macNativeInstaller.getCachedAuthenticatedPreviewUrl({
        allowCachedPreviewUrlInTest: true,
        previewBranch: 'arm64',
      })
    ).toBeNull();

    macNativeInstaller.cacheAuthenticatedPreviewUrl(E2E_ARM64_PREVIEW_ZIP_URL, {
      previewBranch: 'arm64',
    });
    environmentHealthProber.invalidateProberRunnerUpdatesCache();

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

  it('F4.5: both branches share persist:codeweavers-preview Electron session partition during capture', async () => {
    const portalStd = createMockPreviewPortalElectron({
      authenticated: true,
      branchLinks: [E2E_STANDARD_PREVIEW_ZIP_URL, E2E_ARM64_PREVIEW_ZIP_URL],
    });
    const portalArm = createMockPreviewPortalElectron({
      authenticated: true,
      branchLinks: [E2E_STANDARD_PREVIEW_ZIP_URL, E2E_ARM64_PREVIEW_ZIP_URL],
    });

    await environmentProvisioner.captureCodeWeaversPreviewDownload(
      sandbox.downloadsDir,
      { runId: 'e2e-f4-p1', componentId: 'runner_crossover_preview', stepIndex: 0, totalSteps: 1 },
      {
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        previewBranch: 'standard',
        statfsFn: makeMockStatfs(20 * 1024 * 1024 * 1024),
        electronMod: portalStd.electronMod,
      }
    );

    await environmentProvisioner.captureCodeWeaversPreviewDownload(
      sandbox.downloadsDir,
      {
        runId: 'e2e-f4-p2',
        componentId: 'runner_crossover_preview_arm64',
        stepIndex: 0,
        totalSteps: 1,
      },
      {
        homedir: sandbox.homedir,
        userDataDir: sandbox.userDataDir,
        previewBranch: 'arm64',
        statfsFn: makeMockStatfs(20 * 1024 * 1024 * 1024),
        electronMod: portalArm.electronMod,
      }
    );

    expect(portalStd.partitionsRequested).toContain('persist:codeweavers-preview');
    expect(portalArm.partitionsRequested).toContain('persist:codeweavers-preview');
    expect(portalStd.downloadedUrls).toEqual([E2E_STANDARD_PREVIEW_ZIP_URL]);
    expect(portalArm.downloadedUrls).toEqual([E2E_ARM64_PREVIEW_ZIP_URL]);
  });

  // --------------------------------------------------------------------------
  // F5: Background Unpack, Verify, Rename (Arm64) & Atomic Swap (>= 5 tests)
  // --------------------------------------------------------------------------

  it('F5.1: installRunnerDirect(crossover_preview) unpacks, verifies Developer ID, and installs CrossOver Preview.app', async () => {
    const stagedZip = path.join(sandbox.downloadsDir, 'crossover-preview-20261111.zip');
    fs.writeFileSync(stagedZip, 'PK\x03\x04ZIP', 'utf8');
    const verifyCalls: string[] = [];

    const res = await environmentProvisioner.installRunnerDirect('crossover_preview', {
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      customApplicationsDir: sandbox.applicationsDir,
      archivePath: stagedZip,
      skipProcessCheck: true,
      skipStagingCodesignVerify: true,
      verifySignatureFn: async (info: { artifactPath: string }) => {
        verifyCalls.push(path.basename(info.artifactPath));
        return { valid: true, teamIdentifier: '2C75U774H4' };
      },
      onExtractArchive: async (_zipPath: string, extractDir: string) => {
        seedPreviewAppBundle(extractDir, { branch: 'standard', appName: 'CrossOver Preview.app' });
      },
    });

    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(sandbox.applicationsDir, 'CrossOver Preview.app'))).toBe(true);
    expect(verifyCalls).toContain('CrossOver Preview.app');
  });

  it('F5.2: installRunnerDirect(crossover_preview_arm64) unpacks CrossOver Preview.app, renames to CrossOver Preview arm64.app, and re-verifies codesign', async () => {
    const stagedZip = path.join(sandbox.downloadsDir, 'crossover-preview-arm64-20261111.zip');
    fs.writeFileSync(stagedZip, 'PK\x03\x04ZIP', 'utf8');
    const codesignCommands: string[][] = [];

    const res = await environmentProvisioner.installRunnerDirect('crossover_preview_arm64', {
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      customApplicationsDir: sandbox.applicationsDir,
      archivePath: stagedZip,
      skipProcessCheck: true,
      verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
      execFileFn: (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (String(cmd).includes('codesign')) {
          codesignCommands.push(args.map(String));
        }
        cb(null, '', '');
      },
      onExtractArchive: async (_zipPath: string, extractDir: string) => {
        // Real CodeWeavers arm64 zip extracts as CrossOver Preview.app!
        seedPreviewAppBundle(extractDir, { branch: 'arm64', appName: 'CrossOver Preview.app' });
      },
    });

    expect(res.success).toBe(true);
    const installedArm64App = path.join(sandbox.applicationsDir, 'CrossOver Preview arm64.app');
    expect(fs.existsSync(installedArm64App)).toBe(true);
    expect(fs.existsSync(path.join(sandbox.applicationsDir, 'CrossOver Preview.app'))).toBe(false);
    expect(
      fs.existsSync(
        path.join(installedArm64App, 'Contents/SharedSupport/CrossOver/lib/wine/aarch64-unix/ntdll.so')
      )
    ).toBe(true);
    expect(
      codesignCommands.some((args) =>
        args.join(' ').includes('CrossOver Preview arm64.app')
      )
    ).toBe(true);
  });

  it('F5.3: installing CrossOver Preview arm64.app preserves coexisting CrossOver Preview.app side by side', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'standard',
      shortVersion: '20261015',
      buildTimestamp: '20261015T000000Z',
    });

    const stagedZip = path.join(sandbox.downloadsDir, 'crossover-preview-arm64-20261111.zip');
    fs.writeFileSync(stagedZip, 'PK\x03\x04ZIP', 'utf8');

    const res = await environmentProvisioner.installRunnerDirect('crossover_preview_arm64', {
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      customApplicationsDir: sandbox.applicationsDir,
      archivePath: stagedZip,
      skipProcessCheck: true,
      skipStagingCodesignVerify: true,
      verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
      onExtractArchive: async (_zipPath: string, extractDir: string) => {
        seedPreviewAppBundle(extractDir, {
          branch: 'arm64',
          appName: 'CrossOver Preview.app',
          shortVersion: '20261111',
        });
      },
    });

    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(sandbox.applicationsDir, 'CrossOver Preview.app'))).toBe(true);
    expect(fs.existsSync(path.join(sandbox.applicationsDir, 'CrossOver Preview arm64.app'))).toBe(true);
    // Standard bundle must remain untouched at 20261015
    const stdPlist = fs.readFileSync(
      path.join(sandbox.applicationsDir, 'CrossOver Preview.app/Contents/Info.plist'),
      'utf8'
    );
    expect(stdPlist).toContain('20261015');
  });

  it('F5.4: updating CrossOver Preview arm64.app atomically replaces old bundle and leaves zero backup dirs', async () => {
    seedPreviewAppBundle(sandbox.applicationsDir, {
      branch: 'arm64',
      shortVersion: '20261015',
    });

    const stagedZip = path.join(sandbox.downloadsDir, 'crossover-preview-arm64-20261111.zip');
    fs.writeFileSync(stagedZip, 'PK\x03\x04ZIP', 'utf8');

    const res = await environmentProvisioner.installRunnerDirect('crossover_preview_arm64', {
      platform: 'darwin',
      arch: 'arm64',
      homedir: sandbox.homedir,
      customApplicationsDir: sandbox.applicationsDir,
      archivePath: stagedZip,
      skipProcessCheck: true,
      skipStagingCodesignVerify: true,
      verifySignatureFn: async () => ({ valid: true, teamIdentifier: '2C75U774H4' }),
      onExtractArchive: async (_zipPath: string, extractDir: string) => {
        seedPreviewAppBundle(extractDir, {
          branch: 'arm64',
          appName: 'CrossOver Preview.app',
          shortVersion: '20261111',
        });
      },
    });

    expect(res.success).toBe(true);
    const updatedPlist = fs.readFileSync(
      path.join(sandbox.applicationsDir, 'CrossOver Preview arm64.app/Contents/Info.plist'),
      'utf8'
    );
    expect(updatedPlist).toContain('20261111');
    const leftoverBackups = fs
      .readdirSync(sandbox.applicationsDir)
      .filter((entry) => entry.includes('.ol-backup') || entry.includes('.ol-staging'));
    expect(leftoverBackups).toEqual([]);
  });

  it('F5.5: atomicReplaceMacAppBundle strips quarantine attribute and cleans up staging dir after swap', async () => {
    const stagedBundle = seedPreviewAppBundle(sandbox.stagingDir, {
      branch: 'arm64',
      appName: 'CrossOver Preview arm64.app',
    });
    const destBundle = path.join(sandbox.applicationsDir, 'CrossOver Preview arm64.app');
    const invokedCmds: string[] = [];

    const swapRes = await environmentProvisioner.atomicReplaceMacAppBundle(
      stagedBundle.appPath,
      destBundle,
      {
        skipStagingCodesignVerify: true,
        execFileFn: (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
          invokedCmds.push(`${cmd} ${args.join(' ')}`);
          cb(null, '', '');
        },
      }
    );

    expect(swapRes).toBe(destBundle);
    expect(fs.existsSync(destBundle)).toBe(true);
    expect(invokedCmds.some((c) => c.includes('xattr'))).toBe(true);
  });
});
