import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(__dirname, '..');

interface CompatBottleDetail {
  wineArch?: 'win64' | 'arm64';
  previewEnabled?: boolean;
  timestamp?: string;
  hasSteam?: boolean;
  steamSignedIn?: boolean;
  hasGogGalaxy?: boolean;
  hasEpicLauncher?: boolean;
}

interface CompatLayerRecord {
  id: string;
  type: string;
  name: string;
  binaryPath: string;
  bottlesDir?: string;
  availableBottles?: string[];
  bottleDetails?: Record<string, CompatBottleDetail>;
}

interface CompatRegistryMod {
  hasBottleSteamAppManifest: (bottlePath: string, appId: string | number) => boolean;
  detectCompatibilityLayers: (options?: Record<string, unknown>) => CompatLayerRecord[];
  invalidateCompatLayersCache: () => void;
}

interface CrossoverTunerMod {
  resolveCrossOverTargetBottleName: (
    chosenLayer: Record<string, unknown>,
    launchConfig?: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => string | null;
  predictTargetBottlePrefix: (
    chosenLayer: Record<string, unknown>,
    launchConfig?: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => string | null;
  ensureCompatibilityLayerReady: (
    chosenLayer: Record<string, unknown>,
    launchConfig?: Record<string, unknown>,
    env?: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
}

interface BottleDisplayEnvMod {
  DISPLAY_SCALER_ENV_KEYS: readonly string[];
  liveBottleSteamUiModeByPrefix: Map<string, 'silent' | 'standard'>;
  liveBottleDaemonEnvContractByPrefix: Map<string, string>;
  computeBottleGraphicsEnvContract: (
    envObj?: Record<string, unknown> | null,
    customUserEnv?: Record<string, unknown> | null
  ) => string;
  getLiveBottleSteamUiMode: (prefix: string) => 'silent' | 'standard' | undefined;
  setLiveBottleSteamUiMode: (prefix: string, mode: 'silent' | 'standard' | null | undefined) => void;
  deleteBottleDaemonEnvContract: (bottlePath: string) => void;
  resetBottleDisplayControllerState: () => void;
  resetSupervisorStateForTests: () => void;
  stripDisplayScalerEnvFromClientEnv: (
    envObj?: Record<string, unknown> | null
  ) => Record<string, unknown> | null | undefined;
}

interface ReadinessBarrierMod {
  lineMatchesBottlePrefix: (
    rawLine: string,
    normTargetPrefix: string,
    normRealTargetPrefix?: string,
    opts?: { allowUnscopedFallback?: boolean }
  ) => boolean;
  inspectRunningBottleSteam: (
    bottlePath?: string,
    options?: Record<string, unknown>
  ) => Promise<{ running: boolean; observedBackend: string; launchedSilent: boolean }>;
  isBottleWinExeRunning: (
    exeName: string,
    bottlePath?: string,
    options?: Record<string, unknown>
  ) => Promise<boolean>;
  waitForGogPostExitFlush: (
    params?: Record<string, unknown>
  ) => Promise<{ flushed: boolean; waitedMs: number; reason: string }>;
  waitForEpicLauncherCloudSyncCompletion: (
    options?: Record<string, unknown>
  ) => Promise<{ completed: boolean; waitedMs: number; timedOut?: boolean; reason: string }>;
}

interface TrayLifecycleMod {
  createTrayAndDaemonLifecycle: (deps: Record<string, unknown>) => {
    installSessionLifecycleHook: () => void;
    stopMacBottleFocusHelper: (opts?: Record<string, unknown>) => void;
    runSubsystemShutdownOnce: () => void;
  };
}

interface BuildDisplayScalerMod {
  verifyDisplayScalerBinaries: () => {
    scalerX86: { sizeBytes: number; sha256: string };
    scalerX64: { sizeBytes: number; sha256: string };
  };
}

interface BuildMacosHelpersMod {
  verifyMacosHelpers: () => {
    metalPreload: {
      sizeBytes: number;
      archs: string[];
      codesignFlags: string | null;
      linkedDeps: Record<string, string[]> | null;
    };
  };
}

const compatRegistry = nodeRequire(
  '../electron/launcher/mac/compatLayerRegistryAndDetection.cjs'
) as CompatRegistryMod;
const crossoverTuner = nodeRequire(
  '../electron/launcher/mac/crossoverBackendAndBottleTuner.cjs'
) as CrossoverTunerMod;
const bottleDisplayEnv = nodeRequire(
  '../electron/launcher/supervisor/bottleDisplayAndEnvController.cjs'
) as BottleDisplayEnvMod;
const readinessBarrier = nodeRequire(
  '../electron/launcher/storefrontReadinessBarrier.cjs'
) as ReadinessBarrierMod;
const trayLifecycle = nodeRequire(
  '../electron/ipc/trayAndDaemonLifecycle.cjs'
) as TrayLifecycleMod;
const buildDisplayScaler = nodeRequire(
  '../scripts/build-display-scaler.cjs'
) as BuildDisplayScalerMod;
const buildMacosHelpers = nodeRequire(
  '../scripts/build-macos-helpers.cjs'
) as BuildMacosHelpersMod;

const tempDirs: string[] = [];

function createSandbox(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFileEnsureDir(filePath: string, content = ''): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

afterEach(() => {
  vi.useRealTimers();
  bottleDisplayEnv.resetSupervisorStateForTests();
  compatRegistry.invalidateCompatLayersCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
});

describe('Phase 2 W1 — Native C11 Helpers + Bottle Affinity, Env Contract & Readiness Layer', () => {
  describe('1. Native C11 Display Scaler DLL & macOS Metal Preload Dylib', () => {
    it('adds ONE_DENYLIST_INSTALLERS_MSZ to ds_should_ignore_current_process while keeping one_display_scaler_x86.dll strictly < 122,880 B', () => {
      const dllSrc = fs.readFileSync(
        path.join(REPO_ROOT, 'electron', 'helpers', 'display_scaler', 'display_scaler_dll.c'),
        'utf8'
      );
      expect(dllSrc).toContain('ONE_DENYLIST_INSTALLERS_MSZ');
      expect(dllSrc).toMatch(
        /ds_should_ignore_current_process[\s\S]*?ONE_DENYLIST_WINE_SYSTEM_MSZ[\s\S]*?ONE_DENYLIST_STOREFRONT_DAEMONS_MSZ[\s\S]*?ONE_DENYLIST_INSTALLERS_MSZ/
      );

      const verified = buildDisplayScaler.verifyDisplayScalerBinaries();
      expect(verified.scalerX86.sizeBytes).toBeLessThan(122_880);
      expect(verified.scalerX86.sizeBytes).toBe(122_368);
      expect(verified.scalerX64.sizeBytes).toBeLessThan(122_880);
    });

    it('verifies universal libone_metal_preload.dylib (adhoc without runtime flag, zero Metal.framework linkage) and enforces wineloader/client/leaf-daemon HUD isolation in C11 ASan harness', () => {
      const verified = buildMacosHelpers.verifyMacosHelpers();
      expect(verified.metalPreload.archs).toEqual(['arm64', 'x86_64']);

      if (process.platform !== 'darwin') {
        return;
      }

      expect(verified.metalPreload.codesignFlags || '').toMatch(/0x2\(adhoc\)/i);
      expect(verified.metalPreload.codesignFlags || '').not.toMatch(/\bruntime\b/i);
      for (const arch of ['arm64', 'x86_64']) {
        const deps = verified.metalPreload.linkedDeps?.[arch] || [];
        expect(deps.some((d) => d.includes('Metal.framework'))).toBe(false);
        expect(deps.some((d) => d.includes('CoreFoundation.framework'))).toBe(false);
        expect(deps.some((d) => d.includes('CoreAudio.framework'))).toBe(false);
      }

      // Compile & run an ASan/UBSan C11 behavioral harness directly against one_metal_preload.c
      const sandbox = createSandbox('ol-w1-metal-preload-asan-');
      const harnessCPath = path.join(sandbox, 'preload_w1_harness.c');
      const harnessBinPath = path.join(sandbox, 'preload_w1_harness');
      const preloadSrcPath = path.join(REPO_ROOT, 'electron', 'helpers', 'one_metal_preload.c');

      const harnessSource = `
#include <assert.h>
#include <mach/mach.h>
#include <mach/thread_policy.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int g_mock_policy_calls = 0;
static int g_mock_argc = 3;
static char *g_argv_steam[] = { "/cx/wine64-preloader", "/cx/wineloader", "C:\\\\Program Files (x86)\\\\Steam\\\\steam.exe", "-silent", NULL };
static char *g_argv_webhelper[] = { "/cx/wine64-preloader", "/cx/wineloader64", "C:\\\\Program Files (x86)\\\\Steam\\\\bin\\\\cef\\\\steamwebhelper.exe", "--type=gpu-process", NULL };
static char *g_argv_overlay64[] = { "/cx/wine32on64-preloader", "/cx/wineloader32on64", "C:\\\\Program Files (x86)\\\\Steam\\\\gameoverlayui64.exe", NULL };
static char *g_argv_cef[] = { "/cx/wine64-preloader", "/cx/wineloader", "C:\\\\App\\\\cefprocess.exe", NULL };
static char *g_argv_ea_cef[] = { "/cx/wine64-preloader", "/cx/wineloader", "C:\\\\Program Files\\\\Electronic Arts\\\\EA Desktop\\\\EACefSubProcess.exe", NULL };
static char *g_argv_uplay_web[] = { "/cx/wine64-preloader", "/cx/wineloader", "C:\\\\Program Files (x86)\\\\Ubisoft\\\\UplayWebCore.exe", NULL };
static char *g_argv_blizz_browser[] = { "/cx/wine64-preloader", "/cx/wineloader", "C:\\\\Program Files (x86)\\\\Battle.net\\\\BlizzardBrowser.exe", NULL };
static char *g_argv_riot_render[] = { "/cx/wine64-preloader", "/cx/wineloader", "C:\\\\Riot Games\\\\Riot Client\\\\UX\\\\RiotClientUxRender.exe", NULL };
static char *g_argv_bnet_client[] = { "/cx/wine64-preloader", "/cx/wineloader", "C:\\\\Program Files (x86)\\\\Battle.net\\\\Battle.net.exe", NULL };
static char *g_argv_ea_launcher[] = { "/cx/wine64-preloader", "/cx/wineloader", "C:\\\\Program Files\\\\Electronic Arts\\\\EA Desktop\\\\EALauncher.exe", NULL };
static char *g_argv_riot_client[] = { "/cx/wine64-preloader", "/cx/wineloader", "C:\\\\Riot Games\\\\Riot Client\\\\RiotClientServices.exe", NULL };
static char *g_argv_installer[] = { "/cx/wine64-preloader", "/cx/wineloader", "C:\\\\Temp\\\\dxsetup.exe", NULL };
static char *g_argv_game[] = { "/cx/wine64-preloader", "/cx/wineloader", "C:\\\\Games\\\\RealTitle\\\\game.exe", NULL };
static char **g_active_argv = g_argv_game;

static kern_return_t mock_thread_policy_set(
    thread_act_t thread,
    thread_policy_flavor_t flavor,
    thread_policy_t policy_info,
    mach_msg_type_number_t count) {
  (void)thread;
  (void)flavor;
  (void)policy_info;
  (void)count;
  g_mock_policy_calls += 1;
  return KERN_SUCCESS;
}

static int *mock_ns_get_argc(void) { return &g_mock_argc; }
static char ***mock_ns_get_argv(void) { return &g_active_argv; }

#define thread_policy_set mock_thread_policy_set
#define _NSGetArgc mock_ns_get_argc
#define _NSGetArgv mock_ns_get_argv

#include ${JSON.stringify(preloadSrcPath)}

static void reset_test_env(void) {
  unsetenv("ONE_LAUNCHER_SUPPRESS_PRELOAD");
  setenv("ONE_LAUNCHER_AUDIO_BUFFER_CLAMP", "0", 1);
  setenv("ONE_LAUNCHER_METAL_PRELOAD", "0", 1);
  setenv("MTL_HUD_ENABLED", "1", 1);
  setenv("DXVK_HUD", "fps,frametimes", 1);
  g_skip_preload_for_process = 0;
  g_mock_policy_calls = 0;
}

int main(void) {
  /* 1. steam.exe behind wine64-preloader + wineloader: skips preload & RT promotion, KEEPS HUD env for child games! */
  reset_test_env();
  g_mock_argc = 4;
  g_active_argv = g_argv_steam;
  preload_metal_and_moltenvk();
  assert(g_skip_preload_for_process == 1);
  assert(getenv("MTL_HUD_ENABLED") != NULL && strcmp(getenv("MTL_HUD_ENABLED"), "1") == 0);
  assert(getenv("DXVK_HUD") != NULL && strcmp(getenv("DXVK_HUD"), "fps,frametimes") == 0);
  (void)one_launcher_pthread_setname_np("audio_client_timer");
  assert(g_mock_policy_calls == 0);

  /* 2. steamwebhelper.exe behind wineloader64: UNSETS MTL_HUD_ENABLED & DXVK_HUD, sets skip flag, blocks RT */
  reset_test_env();
  g_mock_argc = 4;
  g_active_argv = g_argv_webhelper;
  preload_metal_and_moltenvk();
  assert(g_skip_preload_for_process == 1);
  assert(getenv("MTL_HUD_ENABLED") == NULL);
  assert(getenv("DXVK_HUD") == NULL);
  (void)one_launcher_pthread_setname_np("audio_client_timer");
  assert(g_mock_policy_calls == 0);

  /* 3. gameoverlayui64.exe behind wineloader32on64 & cefprocess.exe: UNSETS HUD env, sets skip flag */
  reset_test_env();
  g_mock_argc = 3;
  g_active_argv = g_argv_overlay64;
  preload_metal_and_moltenvk();
  assert(g_skip_preload_for_process == 1);
  assert(getenv("MTL_HUD_ENABLED") == NULL);
  assert(getenv("DXVK_HUD") == NULL);

  reset_test_env();
  g_mock_argc = 3;
  g_active_argv = g_argv_cef;
  preload_metal_and_moltenvk();
  assert(g_skip_preload_for_process == 1);
  assert(getenv("MTL_HUD_ENABLED") == NULL);
  assert(getenv("DXVK_HUD") == NULL);

  /* 3b. Chained publisher leaf CEF helpers (EA/Ubisoft/Battle.net/Riot) UNSET HUD env & skip preload */
  char **leaf_publisher_argvs[] = { g_argv_ea_cef, g_argv_uplay_web, g_argv_blizz_browser, g_argv_riot_render };
  for (size_t i = 0; i < sizeof(leaf_publisher_argvs) / sizeof(leaf_publisher_argvs[0]); ++i) {
    reset_test_env();
    g_mock_argc = 3;
    g_active_argv = leaf_publisher_argvs[i];
    preload_metal_and_moltenvk();
    assert(g_skip_preload_for_process == 1);
    assert(getenv("MTL_HUD_ENABLED") == NULL);
    assert(getenv("DXVK_HUD") == NULL);
  }

  /* 3c. Chained publisher client binaries skip preload while preserving HUD env for child games */
  char **client_publisher_argvs[] = { g_argv_bnet_client, g_argv_ea_launcher, g_argv_riot_client };
  for (size_t i = 0; i < sizeof(client_publisher_argvs) / sizeof(client_publisher_argvs[0]); ++i) {
    reset_test_env();
    g_mock_argc = 3;
    g_active_argv = client_publisher_argvs[i];
    preload_metal_and_moltenvk();
    assert(g_skip_preload_for_process == 1);
    assert(getenv("MTL_HUD_ENABLED") != NULL && strcmp(getenv("MTL_HUD_ENABLED"), "1") == 0);
    assert(getenv("DXVK_HUD") != NULL);
  }

  /* 4. dxsetup.exe installer: skips preload & RT promotion */
  reset_test_env();
  g_mock_argc = 3;
  g_active_argv = g_argv_installer;
  preload_metal_and_moltenvk();
  assert(g_skip_preload_for_process == 1);
  (void)one_launcher_pthread_setname_np("audio_client_timer");
  assert(g_mock_policy_calls == 0);

  /* 5. Real game.exe behind wine64-preloader + wineloader: DOES NOT skip, retains HUD, allows RT promotion */
  reset_test_env();
  g_mock_argc = 3;
  g_active_argv = g_argv_game;
  preload_metal_and_moltenvk();
  assert(g_skip_preload_for_process == 0);
  assert(getenv("MTL_HUD_ENABLED") != NULL && strcmp(getenv("MTL_HUD_ENABLED"), "1") == 0);
  assert(getenv("DXVK_HUD") != NULL);
  (void)one_launcher_pthread_setname_np("audio_client_timer");
  assert(g_mock_policy_calls == 1);

  printf("PASS_W1_METAL_PRELOAD_ASAN\\n");
  return 0;
}
`;
      fs.writeFileSync(harnessCPath, harnessSource, 'utf8');
      execFileSync(
        '/usr/bin/clang',
        [
          '-std=c11',
          '-O1',
          '-g',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-fsanitize=address,undefined',
          '-fno-omit-frame-pointer',
          `-I${path.join(REPO_ROOT, 'electron', 'helpers')}`,
          harnessCPath,
          '-o',
          harnessBinPath,
        ],
        { stdio: 'pipe' }
      );
      const runRes = spawnSync(harnessBinPath, [], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ONE_LAUNCHER_AUDIO_BUFFER_CLAMP: '0',
          ONE_LAUNCHER_METAL_PRELOAD: '0',
        },
      });
      expect(runRes.status, runRes.stderr || runRes.stdout).toBe(0);
      expect(runRes.stdout).toContain('PASS_W1_METAL_PRELOAD_ASAN');
    }, 30_000);
  });

  describe('2. compatLayerRegistryAndDetection — hasBottleSteamAppManifest & bottleDetails storefront readiness', () => {
    it('verifies hasBottleSteamAppManifest across direct steamapps, C:\\, dosdevices Y:\\ symlink, and Z:\\ host library folders without mutating disk', () => {
      const sandbox = createSandbox('ol-w1-steam-manifest-');
      const bottleDir = path.join(sandbox, 'Bottles', 'OneLauncher');
      const steamRoot = path.join(bottleDir, 'drive_c', 'Program Files (x86)', 'Steam');
      const externalCLib = path.join(bottleDir, 'drive_c', 'GamesLib');
      const externalYHost = path.join(sandbox, 'MountedDriveY');
      const externalZHost = path.join(sandbox, 'HostSteamLib');

      writeFileEnsureDir(path.join(steamRoot, 'steam.exe'), 'MZ');
      writeFileEnsureDir(path.join(steamRoot, 'steamapps', 'appmanifest_1001.acf'), '"AppState" {}');
      writeFileEnsureDir(path.join(externalCLib, 'steamapps', 'appmanifest_1002.acf'), '"AppState" {}');
      writeFileEnsureDir(path.join(externalYHost, 'SteamLib', 'steamapps', 'appmanifest_1003.acf'), '"AppState" {}');
      writeFileEnsureDir(path.join(externalZHost, 'steamapps', 'appmanifest_1004.acf'), '"AppState" {}');

      fs.mkdirSync(path.join(bottleDir, 'dosdevices'), { recursive: true });
      fs.symlinkSync(externalYHost, path.join(bottleDir, 'dosdevices', 'y:'));

      const zWinPath = `Z:${externalZHost.replace(/\//g, '\\\\')}`;
      writeFileEnsureDir(
        path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'),
        `"libraryfolders"
{
  "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" }
  "1" { "path" "C:\\\\GamesLib" }
  "2" { "path" "Y:\\\\SteamLib" }
  "3" { "path" "${zWinPath}" }
}
`
      );

      expect(compatRegistry.hasBottleSteamAppManifest(bottleDir, '1001')).toBe(true);
      expect(compatRegistry.hasBottleSteamAppManifest(bottleDir, 'steam-1002')).toBe(true);
      expect(compatRegistry.hasBottleSteamAppManifest(bottleDir, 1003)).toBe(true);
      expect(compatRegistry.hasBottleSteamAppManifest(bottleDir, 'steam_1004')).toBe(true);
      expect(compatRegistry.hasBottleSteamAppManifest(bottleDir, '9999')).toBe(false);

      // Bottle without steam.exe always returns false
      const emptyBottle = path.join(sandbox, 'Bottles', 'NoSteam');
      fs.mkdirSync(path.join(emptyBottle, 'drive_c'), { recursive: true });
      expect(compatRegistry.hasBottleSteamAppManifest(emptyBottle, '1001')).toBe(false);
    });

    it('enriches layer.bottleDetails with hasSteam, steamSignedIn, hasGogGalaxy, and hasEpicLauncher', () => {
      const sandbox = createSandbox('ol-w1-bottle-details-');
      const appsDir = path.join(sandbox, 'Applications');
      const cxApp = path.join(appsDir, 'CrossOver.app');
      writeFileEnsureDir(
        path.join(cxApp, 'Contents', 'SharedSupport', 'CrossOver', 'bin', 'wine'),
        '#!/bin/sh\n'
      );

      const bottlesDir = path.join(sandbox, 'Library', 'Application Support', 'CrossOver', 'Bottles');
      const readyBottle = path.join(bottlesDir, 'OneLauncher');
      writeFileEnsureDir(
        path.join(readyBottle, 'cxbottle.conf'),
        '[Bottle]\n"WineArch" = "win64"\n'
      );
      writeFileEnsureDir(
        path.join(readyBottle, 'drive_c', 'Program Files (x86)', 'Steam', 'steam.exe'),
        'MZ'
      );
      writeFileEnsureDir(
        path.join(readyBottle, 'drive_c', 'Program Files (x86)', 'Steam', 'config', 'loginusers.vdf'),
        `"users"
{
  "76561198000000001"
  {
    "AccountName" "synthetic_user"
    "MostRecent" "1"
    "RememberPassword" "1"
  }
}
`
      );
      writeFileEnsureDir(
        path.join(readyBottle, 'drive_c', 'Program Files (x86)', 'GOG Galaxy', 'GalaxyClient.exe'),
        'MZ'
      );

      const signedOutBottle = path.join(bottlesDir, 'SignedOutBottle');
      writeFileEnsureDir(
        path.join(signedOutBottle, 'cxbottle.conf'),
        '[Bottle]\n"WineArch" = "win64"\n'
      );
      writeFileEnsureDir(
        path.join(signedOutBottle, 'drive_c', 'Program Files (x86)', 'Steam', 'steam.exe'),
        'MZ'
      );
      writeFileEnsureDir(
        path.join(signedOutBottle, 'drive_c', 'Program Files (x86)', 'Steam', 'config', 'loginusers.vdf'),
        `"users"
{
  "76561198000000002"
  {
    "AccountName" "logged_out_user"
    "MostRecent" "1"
    "RememberPassword" "0"
    "AllowAutoLogin" "0"
  }
}
`
      );
      writeFileEnsureDir(
        path.join(
          signedOutBottle,
          'drive_c',
          'Program Files (x86)',
          'Epic Games',
          'Launcher',
          'Portal',
          'Binaries',
          'Win64',
          'EpicGamesLauncher.exe'
        ),
        'MZ'
      );

      const layers = compatRegistry.detectCompatibilityLayers({
        platform: 'darwin',
        arch: 'arm64',
        homedir: sandbox,
        applicationsDirs: [appsDir],
        forceRefresh: true,
      });

      const cxLayer = layers.find((l) => l.type === 'crossover');
      expect(cxLayer).toBeDefined();
      expect(cxLayer?.bottleDetails?.OneLauncher).toMatchObject({
        wineArch: 'win64',
        hasSteam: true,
        steamSignedIn: true,
        hasGogGalaxy: true,
        hasEpicLauncher: false,
      });
      expect(cxLayer?.bottleDetails?.SignedOutBottle).toMatchObject({
        wineArch: 'win64',
        hasSteam: true,
        steamSignedIn: false,
        hasGogGalaxy: false,
        hasEpicLauncher: true,
      });
    });
  });

  describe('3. crossoverBackendAndBottleTuner — shared resolveCrossOverTargetBottleName & install-bottle affinity', () => {
    it('selects installBottleRoot FIRST over OneLauncher when explicitBottleName is unset and keeps predictTargetBottlePrefix 1:1 with ensureCompatibilityLayerReady', async () => {
      const sandbox = createSandbox('ol-w1-bottle-affinity-');
      const bottlesDir = path.join(sandbox, 'Library', 'Application Support', 'CrossOver', 'Bottles');
      const defaultBottle = path.join(bottlesDir, 'OneLauncher');
      const customBottle = path.join(bottlesDir, 'RetroGames');
      const arm64Bottle = path.join(bottlesDir, 'OneLauncher-arm64');

      writeFileEnsureDir(path.join(defaultBottle, 'cxbottle.conf'), '[Bottle]\n"WineArch" = "win64"\n');
      fs.mkdirSync(path.join(defaultBottle, 'drive_c'), { recursive: true });
      writeFileEnsureDir(path.join(customBottle, 'cxbottle.conf'), '[Bottle]\n"WineArch" = "win64"\n');
      const gameInstallDir = path.join(customBottle, 'drive_c', 'Games', 'SynthTitle');
      writeFileEnsureDir(path.join(gameInstallDir, 'game.exe'), 'MZ');
      writeFileEnsureDir(path.join(arm64Bottle, 'cxbottle.conf'), '[Bottle]\n"WineArch" = "arm64"\n');
      fs.mkdirSync(path.join(arm64Bottle, 'drive_c'), { recursive: true });

      const wineBin = path.join(sandbox, 'CrossOver.app', 'Contents', 'SharedSupport', 'CrossOver', 'bin', 'wine');
      writeFileEnsureDir(wineBin, '#!/bin/sh\n');

      const win64Layer = {
        type: 'crossover',
        binaryPath: wineBin,
        bottlesDir,
        availableBottles: ['OneLauncher', 'RetroGames', 'OneLauncher-arm64'],
        bottleDetails: {
          OneLauncher: { wineArch: 'win64' },
          RetroGames: { wineArch: 'win64' },
          'OneLauncher-arm64': { wineArch: 'arm64' },
        },
      };

      // 1. Install-bottle affinity picks RetroGames FIRST (even though OneLauncher exists)
      const resolvedName = crossoverTuner.resolveCrossOverTargetBottleName(
        win64Layer,
        {},
        { homedir: sandbox, installDir: gameInstallDir }
      );
      expect(resolvedName).toBe('RetroGames');

      const predicted = crossoverTuner.predictTargetBottlePrefix(
        win64Layer,
        {},
        { homedir: sandbox, installDir: gameInstallDir }
      );
      expect(predicted).toBe(path.resolve(customBottle));

      const env: Record<string, unknown> = {};
      const ready = await crossoverTuner.ensureCompatibilityLayerReady(
        win64Layer,
        {},
        env,
        { homedir: sandbox, installDir: gameInstallDir, skipBottleProvisioning: true }
      );
      expect(ready.targetBottle).toBe('RetroGames');
      expect(path.resolve(String(ready.winePrefix))).toBe(predicted);

      // 2. Explicit wineBottleName overrides install-bottle affinity
      expect(
        crossoverTuner.resolveCrossOverTargetBottleName(
          win64Layer,
          { wineBottleName: 'OneLauncher' },
          { homedir: sandbox, installDir: gameInstallDir }
        )
      ).toBe('OneLauncher');

      // 3. Cross-arch safety: win64 install bottle is NEVER picked under arm64 runner
      const arm64Layer = {
        ...win64Layer,
        type: 'crossover_preview_arm64',
      };
      expect(
        crossoverTuner.resolveCrossOverTargetBottleName(
          arm64Layer,
          {},
          { homedir: sandbox, installDir: gameInstallDir }
        )
      ).toBe('OneLauncher-arm64');

      // 4. Standalone Wine/GPTK honors non-CrossOver installBottleRoot when !winePrefixPath
      const standalonePrefix = path.join(sandbox, 'Games', 'OneLauncher', 'Prefixes', 'CustomWinePrefix');
      const standaloneGameDir = path.join(standalonePrefix, 'drive_c', 'Games', 'Indie');
      writeFileEnsureDir(path.join(standaloneGameDir, 'indie.exe'), 'MZ');
      const wineLayer = { type: 'wine', binaryPath: '/usr/local/bin/wine64' };
      expect(
        crossoverTuner.predictTargetBottlePrefix(
          wineLayer,
          {},
          { homedir: sandbox, installPath: standaloneGameDir }
        )
      ).toBe(path.resolve(standalonePrefix));

      // Standalone Wine must NOT hijack a CrossOver bottle (has cxbottle.conf)
      expect(
        crossoverTuner.predictTargetBottlePrefix(
          wineLayer,
          {},
          { homedir: sandbox, installPath: gameInstallDir }
        )
      ).toBe(path.resolve(path.join(sandbox, 'Games', 'OneLauncher', 'Prefixes', 'default')));
    });
  });

  describe('4. bottleDisplayAndEnvController — expanded env contract, Steam UI mode & Display Scaler stripping', () => {
    it('hashes all 18 env contract fields (including CX_ENV DYLD preload & sorted customEnv) while excluding per-session Display Scaler and SteamAppId keys', () => {
      const baseEnv = {
        CX_GRAPHICS_BACKEND: 'dxmt',
        CX_GRAPHICS_BACKEND_VERSION: '0.60',
        D3DM_ENABLE_METALFX: '1',
        DXMT_ENABLE_NVEXT: '1',
        DXMT_METALFX_SPATIAL_SWAPCHAIN: '1',
        DXMT_CONFIG: 'd3d11.preferredMaxFrameRate=120',
        DXVK_CONFIG: '',
        ROSETTA_ADVERTISE_AVX: '1',
        WINEMSYNC: '1',
        FEX_X87REDUCEDPRECISION: '1',
        MTL_HUD_ENABLED: '1',
        DXVK_HUD: 'fps',
        DXVK_FRAME_RATE: '120',
        D3DM_MAX_FPS: '120',
        WINEDLLOVERRIDES: 'winemenubuilder.exe=d',
        CX_ENV: 'MTL_HUD_ENABLED=1 DYLD_INSERT_LIBRARIES="/tmp/libone_metal_preload.dylib"',
        ONE_LAUNCHER_AUDIO_BUFFER_CLAMP: '1',
      };

      const contractA = bottleDisplayEnv.computeBottleGraphicsEnvContract(baseEnv, {
        B_VAR: '2',
        A_VAR: '1',
        SteamAppId: '100',
        SteamGameId: '100',
        WINEPREFIX: '/tmp/a',
        CX_BOTTLE: 'OneLauncher',
        ONE_LAUNCHER_DISPLAY_SCALING_MODE: 'force_fullscreen',
      });
      const contractB = bottleDisplayEnv.computeBottleGraphicsEnvContract(baseEnv, {
        A_VAR: '1',
        B_VAR: '2',
        SteamAppId: '999',
        WINEPREFIX: '/tmp/b',
        ONE_LAUNCHER_DISPLAY_SCALING_MODE: 'windowed',
      });
      expect(contractA).toBe(contractB);

      const parsed = JSON.parse(contractA) as Record<string, unknown>;
      expect(parsed.backend).toBe('dxmt');
      expect(parsed.backendVer).toBe('0.60');
      expect(parsed.mtlHud).toBe('1');
      expect(parsed.dxvkHud).toBe('fps');
      expect(parsed.dxvkFps).toBe('120');
      expect(parsed.d3dmFps).toBe('120');
      expect(parsed.wineDll).toBe('winemenubuilder.exe=d');
      expect(parsed.dyldPreload).toBe('/tmp/libone_metal_preload.dylib');
      expect(parsed.audioClamp).toBe('1');
      expect(parsed.customEnv).toEqual({ A_VAR: '1', B_VAR: '2' });

      // Changing HUD, FPS cap, audio clamp, or customUserEnv invalidates contract
      expect(
        bottleDisplayEnv.computeBottleGraphicsEnvContract({ ...baseEnv, MTL_HUD_ENABLED: '0' }, { A_VAR: '1', B_VAR: '2' })
      ).not.toBe(contractA);
      expect(
        bottleDisplayEnv.computeBottleGraphicsEnvContract(baseEnv, { A_VAR: '1', B_VAR: 'changed' })
      ).not.toBe(contractA);
    });

    it('tracks and clears liveBottleSteamUiModeByPrefix and strips ONLY Display Scaler keys in stripDisplayScalerEnvFromClientEnv', () => {
      const sandbox = createSandbox('ol-w1-ui-mode-');
      const bottleDir = path.join(sandbox, 'OneLauncher');
      fs.mkdirSync(bottleDir, { recursive: true });

      expect(bottleDisplayEnv.getLiveBottleSteamUiMode(bottleDir)).toBeUndefined();
      bottleDisplayEnv.setLiveBottleSteamUiMode(bottleDir, 'silent');
      expect(bottleDisplayEnv.getLiveBottleSteamUiMode(bottleDir)).toBe('silent');
      bottleDisplayEnv.setLiveBottleSteamUiMode(bottleDir, 'standard');
      expect(bottleDisplayEnv.getLiveBottleSteamUiMode(bottleDir)).toBe('standard');

      bottleDisplayEnv.deleteBottleDaemonEnvContract(bottleDir);
      expect(bottleDisplayEnv.getLiveBottleSteamUiMode(bottleDir)).toBeUndefined();

      bottleDisplayEnv.setLiveBottleSteamUiMode(bottleDir, 'silent');
      bottleDisplayEnv.resetBottleDisplayControllerState();
      expect(bottleDisplayEnv.getLiveBottleSteamUiMode(bottleDir)).toBeUndefined();

      const clientEnv: Record<string, unknown> = {
        MTL_HUD_ENABLED: '1',
        DXVK_HUD: 'fps',
        CX_GRAPHICS_BACKEND: 'd3dmetal',
        DYLD_INSERT_LIBRARIES: '/opt/helpers/libone_metal_preload.dylib',
        ONE_LAUNCHER_DISPLAY_SCALING_MODE: 'force_fullscreen',
        ONE_LAUNCHER_SAFE_INSET_TOP: '0',
        ONE_LAUNCHER_SCALER_DLL_X64: 'C:\\scaler.dll',
        CX_ENV:
          'MTL_HUD_ENABLED=1 CX_GRAPHICS_BACKEND=d3dmetal ONE_LAUNCHER_DISPLAY_SCALING_MODE=force_fullscreen ONE_LAUNCHER_SAFE_INSET_TOP=0 DYLD_INSERT_LIBRARIES=/opt/helpers/libone_metal_preload.dylib',
      };
      bottleDisplayEnv.stripDisplayScalerEnvFromClientEnv(clientEnv);

      expect(clientEnv.MTL_HUD_ENABLED).toBe('1');
      expect(clientEnv.DXVK_HUD).toBe('fps');
      expect(clientEnv.CX_GRAPHICS_BACKEND).toBe('d3dmetal');
      expect(clientEnv.DYLD_INSERT_LIBRARIES).toBe('/opt/helpers/libone_metal_preload.dylib');
      expect(clientEnv.ONE_LAUNCHER_DISPLAY_SCALING_MODE).toBeUndefined();
      expect(clientEnv.ONE_LAUNCHER_SAFE_INSET_TOP).toBeUndefined();
      expect(clientEnv.ONE_LAUNCHER_SCALER_DLL_X64).toBeUndefined();
      expect(String(clientEnv.CX_ENV)).toContain('MTL_HUD_ENABLED=1');
      expect(String(clientEnv.CX_ENV)).toContain('DYLD_INSERT_LIBRARIES=/opt/helpers/libone_metal_preload.dylib');
      expect(String(clientEnv.CX_ENV)).not.toContain('ONE_LAUNCHER_DISPLAY_SCALING_MODE');
      expect(String(clientEnv.CX_ENV)).not.toContain('ONE_LAUNCHER_SAFE_INSET_TOP');
    });
  });

  describe('5. storefrontReadinessBarrier — lineMatchesBottlePrefix, inspectRunningBottleSteam, GOG URI flush & Epic cloud sync wait', () => {
    it('matches space-containing WINEPREFIX accurately, rejects sibling/arm64 prefixes, preserves synthetic fallback, and extracts observedBackend + launchedSilent', async () => {
      const bottleWithSpaces =
        '/Users/tester/Library/Application Support/CrossOver/Bottles/OneLauncher';
      const arm64Bottle =
        '/Users/tester/Library/Application Support/CrossOver/Bottles/OneLauncher-arm64';

      const normTarget = bottleWithSpaces.toLowerCase();
      expect(
        readinessBarrier.lineMatchesBottlePrefix(
          `C:\\Program Files (x86)\\Steam\\steam.exe -silent WINEPREFIX=${bottleWithSpaces} CX_GRAPHICS_BACKEND=dxmt`,
          normTarget
        )
      ).toBe(true);
      expect(
        readinessBarrier.lineMatchesBottlePrefix(
          `C:\\Program Files (x86)\\Steam\\steam.exe -silent WINEPREFIX=${arm64Bottle} CX_GRAPHICS_BACKEND=d3dmetal`,
          normTarget
        )
      ).toBe(false);
      // Unquoted WINEPREFIX= followed immediately by a Windows drive path (C:\...)
      expect(
        readinessBarrier.lineMatchesBottlePrefix(
          `WINEPREFIX=${bottleWithSpaces} C:\\Program Files (x86)\\Steam\\steam.exe -silent`,
          normTarget
        )
      ).toBe(true);
      expect(
        readinessBarrier.lineMatchesBottlePrefix(
          `WINEPREFIX=${arm64Bottle} C:\\Program Files (x86)\\Steam\\steam.exe -silent`,
          normTarget
        )
      ).toBe(false);
      // Synthetic fallback with no WINEPREFIX= and no /Bottles/...
      expect(
        readinessBarrier.lineMatchesBottlePrefix('C:\\Program Files (x86)\\Steam\\steam.exe', normTarget)
      ).toBe(true);
      // Strict mode (allowUnscopedFallback: false) requires explicit WINEPREFIX= or /Bottles/ match
      expect(
        readinessBarrier.lineMatchesBottlePrefix(
          'C:\\Program Files (x86)\\Steam\\steam.exe',
          normTarget,
          '',
          { allowUnscopedFallback: false }
        )
      ).toBe(false);

      const probedSilent = await readinessBarrier.inspectRunningBottleSteam(bottleWithSpaces, {
        mockProcessListOutput: [
          `C:\\Program Files (x86)\\Steam\\steam.exe -silent WINEPREFIX=${arm64Bottle} CX_GRAPHICS_BACKEND=d3dmetal`,
          `C:\\Program Files (x86)\\Steam\\steam.exe -silent WINEPREFIX=${bottleWithSpaces} CX_GRAPHICS_BACKEND=dxmt`,
        ].join('\n'),
      });
      expect(probedSilent).toEqual({
        running: true,
        observedBackend: 'dxmt',
        launchedSilent: true,
      });

      const probedStandard = await readinessBarrier.inspectRunningBottleSteam(bottleWithSpaces, {
        mockProcessListOutput: `C:\\Program Files (x86)\\Steam\\steam.exe WINEPREFIX=${bottleWithSpaces} CX_GRAPHICS_BACKEND=d3dmetal`,
      });
      expect(probedStandard).toEqual({
        running: true,
        observedBackend: 'd3dmetal',
        launchedSilent: false,
      });

      const probedSynthetic = await readinessBarrier.inspectRunningBottleSteam(bottleWithSpaces, {
        mockProcessListOutput: 'C:\\Program Files (x86)\\Steam\\steam.exe',
      });
      expect(probedSynthetic).toEqual({
        running: true,
        observedBackend: '',
        launchedSilent: false,
      });
    });

    it('waits 0 ms in tests by default for GOG storefront_uri flush and monitors GalaxyClient.log cloud sync completion when enabled', async () => {
      const sandbox = createSandbox('ol-w1-gog-uri-flush-');
      const commLog = path.join(sandbox, 'CommunicationService.log');
      const clientLog = path.join(sandbox, 'GalaxyClient.log');
      writeFileEnsureDir(commLog, '[INFO] Communication service starting\n');
      writeFileEnsureDir(clientLog, '[INFO] GalaxyClient started\n');

      // Default in tests -> 0 ms skipped_in_test
      const skipped = await readinessBarrier.waitForGogPostExitFlush({
        homedir: sandbox,
        isStorefrontUri: true,
        gogCommunicationLogPath: commLog,
        gogClientLogPath: clientLog,
      });
      expect(skipped).toEqual({ flushed: true, waitedMs: 0, reason: 'skipped_in_test' });

      // Enabled in tests -> waits through in-flight Uploading and completes immediately on Upload finished
      fs.appendFileSync(clientLog, '[INFO] CloudStorage: Syncing saves\n[INFO] Uploading save.dat\n');
      const appendTimer = setTimeout(() => {
        fs.appendFileSync(clientLog, '[INFO] CloudStorage: Upload finished\n');
      }, 60);

      try {
        const res = await readinessBarrier.waitForGogPostExitFlush({
          homedir: sandbox,
          isStorefrontUri: true,
          enableUriCloudFlushWaitInTest: true,
          gogCommunicationLogPath: commLog,
          gogClientLogPath: clientLog,
          preExitOffset: 0,
          preExitClientOffset: 0,
          settleMs: 0,
          pollIntervalMs: 20,
          maxFlushWaitMs: 3000,
        });
        expect(res.flushed).toBe(true);
        expect(res.reason).toBe('cloud_sync_completed');
        expect(res.waitedMs).toBeLessThan(1500);
      } finally {
        clearTimeout(appendTimer);
      }
    });

    it('waits 0 ms in tests by default for Epic cloud sync completion and resolves early on CloudSync completion or quiet settle when configured', async () => {
      const sandbox = createSandbox('ol-w1-epic-cloud-wait-');
      const epicLog = path.join(sandbox, 'EpicGamesLauncher.log');
      writeFileEnsureDir(epicLog, '[0001] EpicGamesLauncher initialized\n');

      const skipped = await readinessBarrier.waitForEpicLauncherCloudSyncCompletion({
        homedir: sandbox,
        epicLogPath: epicLog,
      });
      expect(skipped).toEqual({ completed: true, waitedMs: 0, reason: 'skipped_in_test' });

      fs.appendFileSync(epicLog, '[0002] LogCloudSync: SaveSync uploading profile.sav\n');
      const appendTimer = setTimeout(() => {
        fs.appendFileSync(epicLog, '[0003] LogCloudSync: SaveSync Completed successfully\n');
      }, 60);

      try {
        const res = await readinessBarrier.waitForEpicLauncherCloudSyncCompletion({
          homedir: sandbox,
          epicLogPath: epicLog,
          enableEpicCloudSyncWaitInTest: true,
          preExitOffset: 0,
          pollIntervalMs: 20,
          maxWaitMs: 3000,
          quietSettleMs: 500,
        });
        expect(res.completed).toBe(true);
        expect(res.reason).toBe('cloud_sync_completed');
        expect(res.waitedMs).toBeLessThan(1500);
      } finally {
        clearTimeout(appendTimer);
      }

      // Quiet settle when no cloud sync activity occurs
      const quietRes = await readinessBarrier.waitForEpicLauncherCloudSyncCompletion({
        homedir: sandbox,
        epicLogPath: epicLog,
        maxWaitMs: 2000,
        quietSettleMs: 80,
        pollIntervalMs: 20,
      });
      expect(quietRes.completed).toBe(true);
      expect(quietRes.reason).toBe('quiet_settled');
    });
  });

  describe('6. trayAndDaemonLifecycle — 90 s (450-tick) focus-poll extension & session_updated rootPid re-arming', () => {
    it('extends focus-poll to 450 ticks for bottled sessions without initial pid, updates rootPid in-place on session_updated, and re-arms if stopped before activation', () => {
      vi.useFakeTimers();

      let hookFn: ((gameId: string, payload: Record<string, unknown>) => void) | null = null;
      let runningGames: Array<Record<string, unknown>> = [
        { gameId: 'steam-900001', title: 'Synthetic Bottled Steam Title' },
      ];
      let helperReturnValue = 0;
      const seenRootPids: number[] = [];

      const pollAndActivateSpy = vi.fn((opts: { rootPid?: number; bottlePath?: string }) => {
        seenRootPids.push(Number(opts?.rootPid || 0));
        return helperReturnValue;
      });

      const lifecycle = trayLifecycle.createTrayAndDaemonLifecycle({
        app: {
          hide: vi.fn(),
          show: vi.fn(),
          focus: vi.fn(),
          dock: { show: vi.fn() },
          quit: vi.fn(),
        },
        Menu: { buildFromTemplate: vi.fn(() => ({})) },
        Tray: null,
        nativeImage: null,
        launcherEngine: {
          setSessionLifecycleHook: (fn: (gameId: string, payload: Record<string, unknown>) => void) => {
            hookFn = fn;
          },
          getGameLaunchConfig: () => ({}),
          resolvePlatformLaunchConfig: (cfg: Record<string, unknown>) => cfg,
          resolveEffectivePerformancePolicy: () => ({
            inGameLauncherBehavior: 'keep_open',
            postGameLauncherBehavior: 'restore_window',
          }),
          trimLauncherEngineMemory: vi.fn(),
          getRunningGames: () => runningGames,
          getDownloadQueue: () => [],
          shutdownLauncherEngine: vi.fn(),
        },
        mediaHydrationEngine: { shutdown: vi.fn() },
        offlineVaultService: { shutdown: vi.fn() },
        flushDiagnosticLogSync: vi.fn(),
        electronDir: path.join(REPO_ROOT, 'electron'),
        getMainWindow: () => null,
        setMainWindow: vi.fn(),
        createMainWindow: vi.fn(),
        platform: 'darwin',
        coopActivateHelper: {
          pollAndActivateBottledGame: pollAndActivateSpy,
          restorePresentationOptions: vi.fn(() => true),
        },
        macBottleFocusPollMs: 100,
      });

      lifecycle.installSessionLifecycleHook();
      expect(hookFn).not.toBeNull();

      // 1. Bottled session WITH pid -> stops polling after 200 ticks
      hookFn!('steam-direct-1', {
        event: 'started',
        session: {
          gameId: 'steam-direct-1',
          pid: 1234,
          launchMethod: 'compatibility_layer',
          isBottledSession: true,
          executablePath: '/Bottles/OneLauncher/drive_c/game.exe',
          winePrefix: '/Bottles/OneLauncher',
        },
      });
      vi.advanceTimersByTime(250 * 100);
      expect(pollAndActivateSpy).toHaveBeenCalledTimes(200);

      // 2. Bottled session WITHOUT initial pid (Bottle Steam) -> extends up to 450 ticks & updates rootPid in-place on session_updated!
      pollAndActivateSpy.mockClear();
      seenRootPids.length = 0;
      hookFn!('steam-900001', {
        event: 'started',
        session: {
          gameId: 'steam-900001',
          pid: undefined,
          launchMethod: 'compatibility_layer',
          isBottledSession: true,
          executablePath: '/Bottles/OneLauncher/drive_c/game.exe',
          winePrefix: '/Bottles/OneLauncher',
        },
      });

      // Past 200 ticks (at 250 ticks), poller MUST STILL BE RUNNING with rootPid=0!
      vi.advanceTimersByTime(250 * 100);
      expect(pollAndActivateSpy).toHaveBeenCalledTimes(250);
      expect(seenRootPids[249]).toBe(0);

      // Late session_updated latches real PID 5555 -> updates active poller in-place!
      hookFn!('steam-900001', {
        event: 'session_updated',
        session: {
          gameId: 'steam-900001',
          pid: 5555,
          launchMethod: 'compatibility_layer',
          isBottledSession: true,
          executablePath: '/Bottles/OneLauncher/drive_c/game.exe',
          winePrefix: '/Bottles/OneLauncher',
        },
      });
      vi.advanceTimersByTime(5 * 100);
      expect(seenRootPids[seenRootPids.length - 1]).toBe(5555);

      // Advance past 450 ticks -> poller stops at 450 ticks (450 calls total, never activated)
      vi.advanceTimersByTime(220 * 100);
      expect(pollAndActivateSpy).toHaveBeenCalledTimes(450);

      // 3. Another session_updated with latched PID after poller timed out without activation -> RE-ARMS poller!
      pollAndActivateSpy.mockClear();
      seenRootPids.length = 0;
      helperReturnValue = 1 | 2 | (4321 << 16); // found + active!
      hookFn!('steam-900001', {
        event: 'session_updated',
        session: {
          gameId: 'steam-900001',
          pid: 6666,
          launchMethod: 'compatibility_layer',
          isBottledSession: true,
          executablePath: '/Bottles/OneLauncher/drive_c/game.exe',
          winePrefix: '/Bottles/OneLauncher',
        },
      });
      vi.advanceTimersByTime(5 * 100);
      expect(pollAndActivateSpy).toHaveBeenCalledTimes(3); // 3 active ticks -> activated & stopped!
      expect(seenRootPids[0]).toBe(6666);

      // 4. Subsequent session_updated AFTER activation succeeded -> MUST NOT re-arm!
      pollAndActivateSpy.mockClear();
      hookFn!('steam-900001', {
        event: 'session_updated',
        session: {
          gameId: 'steam-900001',
          pid: 7777,
          launchMethod: 'compatibility_layer',
          isBottledSession: true,
          executablePath: '/Bottles/OneLauncher/drive_c/game.exe',
          winePrefix: '/Bottles/OneLauncher',
        },
      });
      vi.advanceTimersByTime(10 * 100);
      expect(pollAndActivateSpy).not.toHaveBeenCalled();

      // 5. Concurrent session safety (P2-5): stopping an unrelated game MUST NOT clear active focus polling for another booting game!
      helperReturnValue = 0;
      pollAndActivateSpy.mockClear();
      runningGames = [
        { gameId: 'steam-booting-2', title: 'Booting Bottle Game' },
        { gameId: 'steam-unrelated-3', title: 'Unrelated Game' },
      ];
      hookFn!('steam-booting-2', {
        event: 'started',
        session: {
          gameId: 'steam-booting-2',
          pid: undefined,
          launchMethod: 'compatibility_layer',
          isBottledSession: true,
          executablePath: '/Bottles/OneLauncher/drive_c/booting2.exe',
          winePrefix: '/Bottles/OneLauncher',
        },
      });
      vi.advanceTimersByTime(3 * 100);
      expect(pollAndActivateSpy).toHaveBeenCalledTimes(3);

      // Unrelated game stops while steam-booting-2 is still running -> focus poller MUST keep running!
      runningGames = [{ gameId: 'steam-booting-2', title: 'Booting Bottle Game' }];
      hookFn!('steam-unrelated-3', { event: 'stopped' });
      vi.advanceTimersByTime(3 * 100);
      expect(pollAndActivateSpy).toHaveBeenCalledTimes(6);

      // Stopping steam-booting-2 itself DOES stop & clear the focus poller
      runningGames = [];
      hookFn!('steam-booting-2', { event: 'stopped' });
      vi.advanceTimersByTime(5 * 100);
      expect(pollAndActivateSpy).toHaveBeenCalledTimes(6);

      lifecycle.runSubsystemShutdownOnce();
    });
  });
});
