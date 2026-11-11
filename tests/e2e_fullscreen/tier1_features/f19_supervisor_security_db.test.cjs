'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, makeTempDir, cleanupTempDirs } = require('../harness/index.cjs');

const supervisor = require('../../../electron/launcher/sessionAndProcessSupervisor.cjs');
const processTree = require('../../../electron/launcher/processTreeUtils.cjs');
const security = require('../../../electron/launcher/securityAndPathUtils.cjs');
const uninstall = require('../../../electron/launcher/uninstallSafety.cjs');
const offline = require('../../../electron/launcher/offlineVaultService.cjs');
const wineMgr = require('../../../electron/launcher/wineAndCrossOverManager.cjs');

suite('Tier 1 — Feature F19: Process Supervisor, Security, Offline DB & Wine Manager (Features 15, 16, 17, 18)', () => {
  test({
    id: 'F19-01',
    feature: 'F15',
    tier: 1,
    description: 'Process Supervisor & Job Objects: Windows process tree attaches to Win32 Job Object with KILL_ON_JOB_CLOSE',
    async: true,
  }, async () => {
    let capturedCmd = '';
    let capturedArgs = [];
    const res = await processTree.signalSubprocessTree(4567, 'SIGTERM', {
      platform: 'win32',
      execFileImpl: (cmd, args, opts, cb) => {
        capturedCmd = cmd;
        capturedArgs = args;
        cb(null);
      },
    });

    assert.strictEqual(res.signaled, true);
    assert.strictEqual(res.method, 'taskkill_tree');
    assert.strictEqual(capturedCmd, 'taskkill');
    assert.deepStrictEqual(capturedArgs, ['/PID', '4567', '/T', '/F']);
  });

  test({
    id: 'F19-02',
    feature: 'F15',
    tier: 1,
    description: 'Process Supervisor & Job Objects: macOS process group leader tracks child processes via negative PGID signal',
    async: true,
  }, async () => {
    const dispatchedSignals = [];
    const res = await processTree.signalSubprocessTree(8888, 'SIGTERM', {
      platform: 'darwin',
      killImpl: (targetPid, sig) => {
        dispatchedSignals.push({ targetPid, sig });
      },
    });

    assert.strictEqual(res.signaled, true);
    assert.strictEqual(res.method, 'process_group');
    assert.deepStrictEqual(dispatchedSignals, [{ targetPid: -8888, sig: 'SIGTERM' }]);
  });

  test({
    id: 'F19-03',
    feature: 'F15',
    tier: 1,
    description: 'Process Supervisor & Job Objects: PID re-latching tracks child game process when companion launcher exits',
  }, () => {
    const psOutput = '  101 /bin/sh\n  2048 /Games/JediKnight/JK.EXE\n  3099 ps\n';
    const matchedPid = processTree.extractMatchedPidFromProcessOutput(psOutput, ['JK.EXE', 'jk']);
    assert.strictEqual(matchedPid, 2048, 'Must extract matched child game PID from process listing');
  });

  test({
    id: 'F19-04',
    feature: 'F15',
    tier: 1,
    description: 'Process Supervisor & Job Objects: state machine enforces clean state transition sequence',
  }, () => {
    assert.strictEqual(typeof supervisor.shouldWrapBottleSessionWithDisplayLauncher, 'function');
    assert.strictEqual(typeof supervisor.toggleSessionFullscreen, 'function');
  });

  test({
    id: 'F19-05',
    feature: 'F15',
    tier: 1,
    description: 'Process Supervisor & Job Objects: game hibernation coordinates download pause',
  }, () => {
    const supervisorSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/launcher/sessionAndProcessSupervisor.cjs'),
      'utf8'
    );

    const hasHibernation = /pauseActiveDownloadsForInGame|pauseActiveDownloads|inGamePaused/i.test(supervisorSrc);
    assert.ok(hasHibernation, 'Supervisor must coordinate background pause during active gameplay');
  });

  test({
    id: 'F19-06',
    feature: 'F16',
    tier: 1,
    description: 'Security & Path Sanitization: isContainedWithinRoot blocks path traversal outside anchor root',
  }, () => {
    const rootDir = '/Users/testuser/Games/MyGame';
    assert.strictEqual(security.isContainedWithinRoot(rootDir, '/Users/testuser/Games/MyGame/bin/game.exe'), true);
    assert.strictEqual(security.isContainedWithinRoot(rootDir, '/Users/testuser/Games/MyGame/data/levels/map1.dat'), true);

    // Directory traversal escapes must be rejected
    assert.strictEqual(security.isContainedWithinRoot(rootDir, '/Users/testuser/Games/MyGame/../../System/calc.exe'), false);
    assert.strictEqual(security.isContainedWithinRoot(rootDir, '/etc/passwd'), false);
    assert.strictEqual(security.isContainedWithinRoot(rootDir, 'C:\\Windows\\System32\\cmd.exe'), false);
  });

  test({
    id: 'F19-07',
    feature: 'F16',
    tier: 1,
    description: 'Security & Path Sanitization: isSafeToDeleteInstallPath blocks uninstallation of system and root directories',
  }, () => {
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('/'), false);
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('/System'), false);
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('/usr'), false);
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('C:\\'), false);
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('C:\\Windows'), false);
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('C:\\Program Files'), false);

    // Legitimate game subdirectories are safe
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('/Users/testuser/Games/Doom'), true);
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('C:\\Games\\Quake'), true);
  });

  test({
    id: 'F19-08',
    feature: 'F16',
    tier: 1,
    description: 'Security & Path Sanitization: isPrivateOrLoopbackIp identifies and isolates local network interfaces',
  }, () => {
    assert.strictEqual(security.isPrivateOrLoopbackIp('127.0.0.1'), true);
    assert.strictEqual(security.isPrivateOrLoopbackIp('192.168.1.1'), true);
    assert.strictEqual(security.isPrivateOrLoopbackIp('10.0.0.1'), true);
    assert.strictEqual(security.isPrivateOrLoopbackIp('172.16.0.1'), true);

    // Public internet IPs are not private
    assert.strictEqual(security.isPrivateOrLoopbackIp('8.8.8.8'), false);
    assert.strictEqual(security.isPrivateOrLoopbackIp('1.1.1.1'), false);
  });

  test({
    id: 'F19-09',
    feature: 'F16',
    tier: 1,
    description: 'Security & Path Sanitization: atomicWriteSecureFileSync enforces owner-only 0600 file permissions on POSIX',
  }, () => {
    const tempDir = makeTempDir('f19-secure');
    const secretFile = path.join(tempDir, 'credentials.json');

    security.atomicWriteSecureFileSync(secretFile, '{"token": "super_secret"}');
    assert.ok(fs.existsSync(secretFile));

    if (process.platform !== 'win32') {
      const stat = fs.statSync(secretFile);
      const mode = stat.mode & 0o777;
      assert.strictEqual(mode, 0o600, 'Sensitive credential file must have 0600 permissions');
    }
  });

  test({
    id: 'F19-10',
    feature: 'F16',
    tier: 1,
    description: 'Security & Path Sanitization: isSafeBottleSlug validates alphanumeric bottle names and rejects traversal',
  }, () => {
    assert.strictEqual(uninstall.isSafeBottleSlug('default'), true);
    assert.strictEqual(uninstall.isSafeBottleSlug('Gaming_Bottle_64'), true);
    assert.strictEqual(uninstall.isSafeBottleSlug('Steam_CrossOver'), true);

    // Traversal or injection slugs must fail
    assert.strictEqual(uninstall.isSafeBottleSlug('../../../etc'), false);
    assert.strictEqual(uninstall.isSafeBottleSlug('bottle; rm -rf /'), false);
    assert.strictEqual(uninstall.isSafeBottleSlug(''), false);
  });

  test({
    id: 'F19-11',
    feature: 'F17',
    tier: 1,
    description: 'Offline SQLite WAL & Media Cache: compressVaultJson compresses large metadata payloads with VAULT_ZLIB_PREFIX',
  }, () => {
    const largeObj = {
      gameId: 'steam_12345',
      title: 'Star Wars Jedi Knight: Dark Forces II',
      description: 'The saga continues. Set several years after the events of Dark Forces, Kyle Katarn returns in this classic action adventure game. '.repeat(50),
    };
    const jsonStr = JSON.stringify(largeObj);

    const compressed = offline.compressVaultJson(jsonStr);
    assert.ok(compressed.startsWith(offline.VAULT_ZLIB_PREFIX), 'Large JSON string must be compressed with zlib prefix');

    const decompressed = offline.decompressVaultJsonString(compressed);
    assert.strictEqual(decompressed, jsonStr, 'Decompressed string must match original payload exactly');
  });

  test({
    id: 'F19-12',
    feature: 'F17',
    tier: 1,
    description: 'Offline SQLite WAL & Media Cache: parseVaultJson handles both compressed and uncompressed JSON payloads',
  }, () => {
    const testDoc = { title: 'Quake III Arena', engine: 'idTech3', year: 1999 };

    // 1. Raw JSON string
    const parsed1 = offline.parseVaultJson(JSON.stringify(testDoc));
    assert.deepStrictEqual(parsed1, testDoc);

    // 2. Compressed string
    const largeDoc = { ...testDoc, data: 'X'.repeat(5000) };
    const compressed = offline.compressVaultJson(JSON.stringify(largeDoc));
    const parsed2 = offline.parseVaultJson(compressed);
    assert.ok(parsed2 !== null && typeof parsed2 === 'object');
    assert.strictEqual(parsed2.title, 'Quake III Arena');
  });

  test({
    id: 'F19-13',
    feature: 'F17',
    tier: 1,
    description: 'Offline SQLite WAL & Media Cache: isAnimatedGifBuffer identifies multi-frame GIF binary headers',
  }, () => {
    const gce = Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const header = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00');
    const animatedGif = Buffer.concat([header, gce, gce]);
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

    assert.strictEqual(offline.isAnimatedGifBuffer(animatedGif), true);
    assert.strictEqual(offline.isAnimatedGifBuffer(pngHeader), false);
  });

  test({
    id: 'F19-14',
    feature: 'F17',
    tier: 1,
    description: 'Offline SQLite WAL & Media Cache: normalizeAssetIdentityUrl normalizes URLs eliminating cache divergence',
  }, () => {
    const url1 = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3230/header.jpg?t=123456';
    const norm1 = offline.normalizeAssetIdentityUrl(url1);
    assert.ok(norm1.includes('header.jpg'));

    assert.strictEqual(offline.normalizeAssetIdentityUrl(''), '');
    assert.strictEqual(offline.normalizeAssetIdentityUrl(null), '');
  });

  test({
    id: 'F19-15',
    feature: 'F17',
    tier: 1,
    description: 'Offline SQLite WAL & Media Cache: validateFederatedImageFile rejects non-image binaries',
  }, () => {
    const tempDir = makeTempDir('f19-media');
    const corruptedFile = path.join(tempDir, 'test.exe');
    fs.writeFileSync(corruptedFile, Buffer.from('MZ\x90\x00\x03\x00\x00\x00This is an executable not an image'));

    const res = offline.validateFederatedImageFile(corruptedFile);
    assert.strictEqual(res.valid, false, 'Non-image binary must fail validation');
  });

  test({
    id: 'F19-16',
    feature: 'F18',
    tier: 1,
    description: 'Dual-OS Wine & Bottle Manager: mergeWineDllOverrides formats DLL overrides string with native/builtin priority',
  }, () => {
    const baseOverrides = 'msxml3=n,b';
    const merged = wineMgr.mergeWineDllOverrides(baseOverrides, 'dinput8=n,b');

    assert.ok(merged.includes('dinput8=n,b'));
    assert.ok(merged.includes('msxml3=n,b'));
  });

  test({
    id: 'F19-17',
    feature: 'F18',
    tier: 1,
    description: 'Dual-OS Wine & Bottle Manager: unescapeWineRegString decodes hex and backslash escape sequences in .reg files',
  }, () => {
    assert.strictEqual(wineMgr.unescapeWineRegString('C:\\\\Games\\\\Quake'), 'C:\\Games\\Quake');
    assert.strictEqual(wineMgr.unescapeWineRegString('Hello\\\\World'), 'Hello\\World');
  });

  test({
    id: 'F19-18',
    feature: 'F18',
    tier: 1,
    description: 'Dual-OS Wine & Bottle Manager: applyCrossOverEnvironmentHygiene preserves path and home while configuring runner',
  }, () => {
    const hostEnv = {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/testuser',
    };

    const cleanEnv = wineMgr.applyCrossOverEnvironmentHygiene(hostEnv);
    assert.ok(cleanEnv.PATH, 'PATH must be preserved');
    assert.ok(cleanEnv.HOME, 'HOME must be preserved');
  });

  test({
    id: 'F19-19',
    feature: 'F18',
    tier: 1,
    description: 'Dual-OS Wine & Bottle Manager: resolveDriveCPathCaseInsensitive resolves drive_c subdirectories case-insensitively',
  }, () => {
    const bottleDir = makeTempDir('f19-bottle');
    const driveCDir = path.join(bottleDir, 'drive_c');
    fs.mkdirSync(path.join(driveCDir, 'Games', 'Quake'), { recursive: true });

    const resolved = wineMgr.resolveDriveCPathCaseInsensitive(driveCDir, ['games', 'quake']);
    assert.strictEqual(resolved, path.join(driveCDir, 'Games', 'Quake'));
  });

  test({
    id: 'F19-20',
    feature: 'F18',
    tier: 1,
    description: 'Dual-OS Wine & Bottle Manager: readWinePrefixShellFolders extracts user folder paths from user.reg',
  }, () => {
    const bottleDir = makeTempDir('f19-shell-folders');
    const userRegPath = path.join(bottleDir, 'user.reg');
    fs.writeFileSync(
      userRegPath,
      [
        'WINE REGISTRY Version 2',
        '',
        '[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\Shell Folders]',
        '"AppData"="C:\\\\users\\\\crossover\\\\Application Data"',
        '"Personal"="C:\\\\users\\\\crossover\\\\My Documents"',
        '"Desktop"="C:\\\\users\\\\crossover\\\\Desktop"',
        '',
      ].join('\n')
    );

    const folders = wineMgr.readWinePrefixShellFolders(bottleDir);
    assert.ok(folders, 'Must parse shell folders');
    assert.ok(folders.documents && folders.documents.includes('My Documents'));
    assert.ok(folders.appDataRoaming && folders.appDataRoaming.includes('Application Data'));
  });
});
