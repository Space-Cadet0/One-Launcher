'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, makeTempDir, cleanupTempDirs } = require('../harness/index.cjs');

const supervisor = require('../../../electron/launcher/sessionAndProcessSupervisor.cjs');
const processTree = require('../../../electron/launcher/processTreeUtils.cjs');
const security = require('../../../electron/launcher/securityAndPathUtils.cjs');
const uninstall = require('../../../electron/launcher/uninstallSafety.cjs');
const offline = require('../../../electron/launcher/offlineVaultService.cjs');
const media = require('../../../electron/launcher/mediaHydrationEngine.cjs');
const wineMgr = require('../../../electron/launcher/wineAndCrossOverManager.cjs');

suite('Tier 2 — Feature F17 Boundaries: Process Supervisor, Security, Offline DB & Wine Manager (Features 15–18)', () => {
  // Feature 15 Boundaries: Process Supervisor & Tree Lifecycle
  test({
    id: 'F17-B01',
    feature: 'F15',
    tier: 2,
    description: 'Process Supervisor Boundary: signalSubprocessTree handles non-existent PID gracefully without throwing',
    async: true,
  }, async () => {
    // Non-existent PID should not throw uncaught exceptions
    const res = await processTree.signalSubprocessTree(999999, 'SIGTERM', {
      platform: 'darwin',
    });
    assert.strictEqual(typeof res, 'object');
    assert.strictEqual(typeof res.signaled, 'boolean');
    assert.strictEqual(res.signaled, false);
  });

  test({
    id: 'F17-B02',
    feature: 'F15',
    tier: 2,
    description: 'Process Supervisor Boundary: isProcessAlive returns false for invalid, negative, or zero PIDs',
  }, () => {
    assert.strictEqual(processTree.isProcessAlive(0), false);
    assert.strictEqual(processTree.isProcessAlive(-1), false);
    assert.strictEqual(processTree.isProcessAlive(-99999), false);
    assert.strictEqual(processTree.isProcessAlive(null), false);
    assert.strictEqual(processTree.isProcessAlive(undefined), false);
    assert.strictEqual(processTree.isProcessAlive(NaN), false);
    assert.strictEqual(processTree.isProcessAlive('not_a_pid'), false);
  });

  test({
    id: 'F17-B03',
    feature: 'F15',
    tier: 2,
    description: 'Process Supervisor Boundary: waitForProcessExit resolves true immediately on dead PID',
    async: true,
  }, async () => {
    const start = Date.now();
    const exited = await processTree.waitForProcessExit(-99999, 200);
    const elapsed = Date.now() - start;
    assert.strictEqual(exited, true);
    assert.ok(elapsed < 150, `Expected quick resolution, took ${elapsed}ms`);
  });

  test({
    id: 'F17-B04',
    feature: 'F15',
    tier: 2,
    description: 'Process Supervisor Boundary: extractMatchedPidFromProcessOutput handles empty or corrupt ps/tasklist output',
  }, () => {
    assert.strictEqual(processTree.extractMatchedPidFromProcessOutput('', ['game.exe'], 'darwin'), 0);
    assert.strictEqual(processTree.extractMatchedPidFromProcessOutput(null, ['game.exe'], 'darwin'), 0);
    assert.strictEqual(processTree.extractMatchedPidFromProcessOutput('invalid table output', [], 'darwin'), 0);
    assert.strictEqual(processTree.extractMatchedPidFromProcessOutput('12345 /usr/bin/ps -ef', ['game.exe'], 'darwin'), 0);
    assert.strictEqual(processTree.extractMatchedPidFromProcessOutput('"System Idle Process","0"', ['game.exe'], 'win32'), 0);
  });

  test({
    id: 'F17-B05',
    feature: 'F15',
    tier: 2,
    description: 'Process Supervisor Boundary: execCliWithTreeTimeout enforces timeout boundary on hanging process',
    async: true,
  }, async () => {
    const keepAlive = setInterval(() => {}, 10);
    const res = await processTree.execCliWithTreeTimeout('hanging_test_cli', [], {}, {
      timeoutMs: 30,
      execFileImpl: () => {},
    });
    clearInterval(keepAlive);
    assert.strictEqual(res.timedOut, true);
  });

  // Feature 16 Boundaries: Security Validation & Path Containment
  test({
    id: 'F17-B06',
    feature: 'F16',
    tier: 2,
    description: 'Security Boundary: isContainedWithinRoot rejects complex traversal and UNC patterns',
  }, () => {
    const root = '/mock/games/root';
    assert.strictEqual(security.isContainedWithinRoot(root, '/mock/games/root/../../etc/passwd'), false);
    assert.strictEqual(security.isContainedWithinRoot(root, '/mock/games/root/sub/../../..'), false);
    assert.strictEqual(security.isContainedWithinRoot(root, '\\\\?\\C:\\Windows'), false);
    assert.strictEqual(security.isContainedWithinRoot(root, '\\\\192.168.1.1\\share\\exploit.exe'), false);
    assert.strictEqual(security.isContainedWithinRoot(root, '/mock/games/root/\x00/sub/test'), false);
  });

  test({
    id: 'F17-B07',
    feature: 'F16',
    tier: 2,
    description: 'Security Boundary: isSafeToDeleteInstallPath rejects critical host system roots and folders',
  }, () => {
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('/'), false);
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('/System'), false);
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('/Library'), false);
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('/Applications'), false);
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('C:\\'), false);
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('C:\\Windows'), false);
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('C:\\Program Files'), false);
  });

  test({
    id: 'F17-B08',
    feature: 'F16',
    tier: 2,
    description: 'Security Boundary: safeRemoveGameDirectoryAsync refuses root and home directories',
    async: true,
  }, async () => {
    await assert.rejects(
      async () => {
        await uninstall.safeRemoveGameDirectoryAsync('/Applications', { dryRun: true });
      },
      /Refusing unsafe game uninstall path/
    );
  });

  test({
    id: 'F17-B09',
    feature: 'F16',
    tier: 2,
    description: 'Security Boundary: isSafeBottleChainedGameDirToDelete protects root bottle directories',
  }, () => {
    const bottleRoot = '/mock/bottles/gaming';
    assert.strictEqual(supervisor.isSafeBottleChainedGameDirToDelete(bottleRoot, bottleRoot), false);
    assert.strictEqual(supervisor.isSafeBottleChainedGameDirToDelete(bottleRoot, path.join(bottleRoot, 'drive_c')), false);
    assert.strictEqual(supervisor.isSafeBottleChainedGameDirToDelete(bottleRoot, path.join(bottleRoot, 'drive_c', 'windows')), false);
    assert.strictEqual(supervisor.isSafeBottleChainedGameDirToDelete(bottleRoot, '/etc'), false);
  });

  test({
    id: 'F17-B10',
    feature: 'F16',
    tier: 2,
    description: 'Security Boundary: parseLaunchArguments splits arguments and handles edge whitespace safely',
  }, () => {
    assert.deepStrictEqual(supervisor.parseLaunchArguments(''), []);
    assert.deepStrictEqual(supervisor.parseLaunchArguments('   '), []);
    assert.deepStrictEqual(supervisor.parseLaunchArguments(null), []);
    const parsed = supervisor.parseLaunchArguments('-windowed -w 1920 -h 1080 +exec "autoexec.cfg"');
    assert.deepStrictEqual(parsed, ['-windowed', '-w', '1920', '-h', '1080', '+exec', 'autoexec.cfg']);
  });

  // Feature 17 Boundaries: Local Database, Storage Integrity & Media Cache
  test({
    id: 'F17-B11',
    feature: 'F17',
    tier: 2,
    description: 'Offline DB Boundary: parseVaultJson safely recovers from corrupt payloads and HTML error pages',
  }, () => {
    assert.strictEqual(offline.parseVaultJson('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>'), null);
    assert.strictEqual(offline.parseVaultJson('{ "truncated": true, '), null);
    assert.strictEqual(offline.parseVaultJson(''), null);
    assert.strictEqual(offline.parseVaultJson(null), null);
    const valid = offline.parseVaultJson('{"games": {"g1": {"id": "g1"}}}');
    assert.ok(valid && valid.games && valid.games.g1);
  });

  test({
    id: 'F17-B12',
    feature: 'F17',
    tier: 2,
    description: 'Offline DB Boundary: decompressVaultJsonString handles corrupted zlib payload with header safely',
  }, () => {
    const corruptWithPrefix = offline.VAULT_ZLIB_PREFIX + 'not_valid_deflate_base64_data';
    const result = offline.decompressVaultJsonString(corruptWithPrefix);
    assert.strictEqual(result, null);
  });

  test({
    id: 'F17-B13',
    feature: 'F17',
    tier: 2,
    description: 'Offline DB Boundary: isWafOrChallengeResponse detects anti-bot challenges and blocks',
  }, () => {
    assert.strictEqual(offline.isWafOrChallengeResponse(200, ''), false);
    assert.strictEqual(offline.isWafOrChallengeResponse(429, ''), true);
    assert.strictEqual(offline.isWafOrChallengeResponse(403, ''), true);
    assert.strictEqual(offline.isWafOrChallengeResponse(200, '<!DOCTYPE html><title>Just a moment...</title>Cloudflare challenge'), true);
    assert.strictEqual(offline.isWafOrChallengeResponse(200, '{"ok": true, "data": []}'), false);
  });

  test({
    id: 'F17-B14',
    feature: 'F17',
    tier: 2,
    description: 'Media Hydration Boundary: isAssetAllowedForTier enforces tier caps on ordinals and asset roles',
  }, () => {
    // P2 uninstalled: only cover/capsule/icon at ordinal 0
    assert.strictEqual(media.isAssetAllowedForTier('cover', 0, 2), true);
    assert.strictEqual(media.isAssetAllowedForTier('cover', 1, 2), false);
    assert.strictEqual(media.isAssetAllowedForTier('screenshot', 0, 2), false);

    // P1 detail LRU: screenshots up to 4 (0..3)
    assert.strictEqual(media.isAssetAllowedForTier('screenshot', 0, 1), true);
    assert.strictEqual(media.isAssetAllowedForTier('screenshot', 3, 1), true);
    assert.strictEqual(media.isAssetAllowedForTier('screenshot', 4, 1), false);
    assert.strictEqual(media.isAssetAllowedForTier('inline_img', 0, 1), false);

    // P0 installed: screenshots up to 6, inline_img up to 8
    assert.strictEqual(media.isAssetAllowedForTier('screenshot', 5, 0), true);
    assert.strictEqual(media.isAssetAllowedForTier('screenshot', 6, 0), false);
    assert.strictEqual(media.isAssetAllowedForTier('inline_img', 7, 0), true);
    assert.strictEqual(media.isAssetAllowedForTier('inline_img', 8, 0), false);
  });

  test({
    id: 'F17-B15',
    feature: 'F17',
    tier: 2,
    description: 'Offline DB Boundary: validateFederatedImageFile rejects non-existent or zero-byte files safely',
    async: true,
  }, async () => {
    const nonExistent = '/tmp/non_existent_vault_asset_xyz.jpg';
    const res = await offline.validateFederatedImageFile(nonExistent);
    assert.strictEqual(res.valid, false);
  });

  // Feature 18 Boundaries: Wine, CrossOver & Compatibility Layers
  test({
    id: 'F17-B16',
    feature: 'F18',
    tier: 2,
    description: 'Wine Manager Boundary: unescapeWineRegString handles escaped backslashes, quotes, and empty strings',
  }, () => {
    assert.strictEqual(wineMgr.unescapeWineRegString(''), '');
    assert.strictEqual(wineMgr.unescapeWineRegString(null), '');
    const escaped = '"C:\\\\Games\\\\MyGame\\\\game.exe"';
    const unescaped = wineMgr.unescapeWineRegString(escaped);
    assert.strictEqual(unescaped, '"C:\\Games\\MyGame\\game.exe"');
  });

  test({
    id: 'F17-B17',
    feature: 'F18',
    tier: 2,
    description: 'Wine Manager Boundary: mergeWineDllOverrides dedupes keys and normalizes semicolon separation',
  }, () => {
    const existing = 'd3d11=n;dxgi=n';
    const additions = 'dxgi=b;d3d9=n;d3d11=b';
    const merged = wineMgr.mergeWineDllOverrides(existing, additions);
    assert.ok(merged.includes('d3d11=n')); // existing preserved
    assert.ok(merged.includes('dxgi=n'));  // existing preserved
    assert.ok(merged.includes('d3d9=n'));  // addition appended
  });

  test({
    id: 'F17-B18',
    feature: 'F18',
    tier: 2,
    description: 'Wine Manager Boundary: applyStrictRosettaAvxEnv configures ROSETTA_ADVERTISE_AVX boundary states',
  }, () => {
    const envTrue = wineMgr.applyStrictRosettaAvxEnv({}, true);
    assert.strictEqual(envTrue.ROSETTA_ADVERTISE_AVX, '1');

    const envFalse = wineMgr.applyStrictRosettaAvxEnv({ ROSETTA_ADVERTISE_AVX: '1' }, false);
    assert.strictEqual(envFalse.ROSETTA_ADVERTISE_AVX, undefined);
  });

  test({
    id: 'F17-B19',
    feature: 'F18',
    tier: 2,
    description: 'Wine Manager Boundary: computeMacPrimaryDisplaySafeInsetTop clamps inset safely within 0..80',
  }, () => {
    assert.strictEqual(supervisor.computeMacPrimaryDisplaySafeInsetTop(false, { safeInsetTop: -10 }), 0);
    assert.strictEqual(supervisor.computeMacPrimaryDisplaySafeInsetTop(false, { safeInsetTop: 44 }), 44);
    assert.strictEqual(supervisor.computeMacPrimaryDisplaySafeInsetTop(false, { safeInsetTop: 200 }), 80);
  });

  test({
    id: 'F17-B20',
    feature: 'F18',
    tier: 2,
    description: 'Wine Manager Boundary: normalizeWineArgumentBackslashes handles empty and complex paths',
  }, () => {
    assert.strictEqual(supervisor.normalizeWineArgumentBackslashes(''), '');
    assert.strictEqual(supervisor.normalizeWineArgumentBackslashes(null), null);
    const pathArg = 'Z:\\mock\\Game/app.exe';
    const normalized = supervisor.normalizeWineArgumentBackslashes(pathArg);
    assert.ok(typeof normalized === 'string');
    assert.strictEqual(normalized.includes('\x00'), false);
  });
});
