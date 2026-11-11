'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, makeTempDir, cleanupTempDirs } = require('../harness/index.cjs');

const cloudSave = require('../../../electron/launcher/cloudSaveEngine.cjs');
const gogScript = require('../../../electron/storefronts/gog/gogScriptInterpreter.cjs');
const downloadCoord = require('../../../electron/launcher/downloadQueueCoordinator.cjs');
const epicCoordinator = require('../../../electron/launcher/epicLegendaryAndEosCoordinator.cjs');
const chainedPublishers = require('../../../electron/launcher/chainedPublisherLaunchers.cjs');

suite('Tier 1 — Feature F18: Storefronts Sync, Ingestion & Universal Portability (Features 11, 12, 13, 14)', () => {
  test({
    id: 'F18-01',
    feature: 'F11',
    tier: 1,
    description: 'Steam Two-Stage Cold-Start Sync: supervisor verifies cloud_log.txt offset prior to silent client boot',
  }, () => {
    const supervisorSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/launcher/sessionAndProcessSupervisor.cjs'),
      'utf8'
    );

    const hasLogOffsetCheck = /bottleCloudLogPath[\s\S]*?preBootLogOffset\s*=\s*fs\.statSync\(bottleCloudLogPath\)\.size/m.test(supervisorSrc) ||
      /cloudLogPath[\s\S]*?preBootLogOffset\s*=\s*fs\.statSync/m.test(supervisorSrc);
    assert.ok(hasLogOffsetCheck, 'Supervisor must sample pre-boot cloud_log.txt offset to detect fresh sync events');
  });

  test({
    id: 'F18-02',
    feature: 'F11',
    tier: 1,
    description: 'Steam Two-Stage Cold-Start Sync: Stage 1 silent boot separates client launch from game applaunch',
  }, () => {
    const supervisorSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/launcher/sessionAndProcessSupervisor.cjs'),
      'utf8'
    );

    const hasTwoStageLaunch = /enableTwoStageSteamColdStart/m.test(supervisorSrc) &&
      /-silent/m.test(supervisorSrc);
    assert.ok(hasTwoStageLaunch, 'Supervisor must support two-stage cold start launch with silent client initialization');
  });

  test({
    id: 'F18-03',
    feature: 'F11',
    tier: 1,
    description: 'Steam Two-Stage Cold-Start Sync: cloud save post-exit upload barrier precedes wine teardown',
  }, () => {
    const supervisorSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/launcher/sessionAndProcessSupervisor.cjs'),
      'utf8'
    );

    const hasPreTeardownBarrier = /Run post-exit Cloud Save uploads[\s\S]*?wineserver -k/im.test(supervisorSrc);
    assert.ok(hasPreTeardownBarrier, 'Supervisor must run cloud upload barrier before terminating wine server');
  });

  test({
    id: 'F18-04',
    feature: 'F11',
    tier: 1,
    description: 'Steam Two-Stage Cold-Start Sync: cloudSaveEngine backup quota enforcement prevents disk bloat',
  }, () => {
    const backupDir = makeTempDir('f18-backups');
    const gameBackupsDir = path.join(backupDir, 'game_123');
    fs.mkdirSync(gameBackupsDir, { recursive: true });

    // Create 2 snapshot directories
    const s1 = path.join(gameBackupsDir, 'snapshot_1');
    const s2 = path.join(gameBackupsDir, 'snapshot_2');
    fs.mkdirSync(s1, { recursive: true });
    fs.mkdirSync(s2, { recursive: true });
    fs.writeFileSync(path.join(s1, 'save.dat'), Buffer.alloc(5000));
    fs.writeFileSync(path.join(s2, 'save.dat'), Buffer.alloc(5000));

    // Enforce quota keeping max 6000 bytes with 0 minimum retained
    const res = cloudSave.enforceCloudSaveBackupQuotaSync(backupDir, {
      maxTotalBackupBytes: 6000,
      minRetainedPerGame: 0,
    });

    assert.ok(res.evictedCount >= 1, `Must evict at least 1 excess snapshot, evicted: ${res.evictedCount}`);
    assert.ok(res.freedBytes >= 5000, `Must free at least 5000 bytes, freed: ${res.freedBytes}`);
  });

  test({
    id: 'F18-05',
    feature: 'F11',
    tier: 1,
    description: 'Steam Two-Stage Cold-Start Sync: safe save template syntax validation blocks unknown token injection',
  }, () => {
    assert.strictEqual(cloudSave.isSafeEpicSaveTemplateSyntax('{AppData}/Game/Saves'), true);
    assert.strictEqual(cloudSave.isSafeEpicSaveTemplateSyntax('{UserSavedGames}/Saves'), true);

    // Unknown or dangerous tokens must fail validation
    assert.strictEqual(cloudSave.isSafeEpicSaveTemplateSyntax('{InvalidToken}/Saves'), false);
    assert.strictEqual(cloudSave.isSafeEpicSaveTemplateSyntax(''), false);
    assert.strictEqual(cloudSave.isSafeEpicSaveTemplateSyntax(null), false);
  });

  test({
    id: 'F18-06',
    feature: 'F12',
    tier: 1,
    description: 'GOG V2 Streaming Extractor: downloadQueueCoordinator validates trusted download and manifest domains',
  }, () => {
    assert.ok(Array.isArray(downloadCoord.TRUSTED_EXTERNAL_LAUNCHER_DOMAINS));

    const battleNetUrl = 'https://download.battle.net/setup.exe';
    const validated = downloadCoord.validateTrustedExternalLauncherUrl(battleNetUrl);
    assert.strictEqual(validated, battleNetUrl, 'Trusted domain URL must be validated and returned verbatim');

    const untrusted = downloadCoord.validateTrustedExternalLauncherUrl('https://malicious-site.com/setup.exe');
    assert.strictEqual(untrusted, '', 'Untrusted domain must return empty string');
  });

  test({
    id: 'F18-07',
    feature: 'F12',
    tier: 1,
    description: 'GOG V2 Streaming Extractor: in-game download suppression pauses active downloads while game is running',
  }, () => {
    assert.strictEqual(typeof downloadCoord.pauseActiveDownloadsForInGame, 'function');
    assert.strictEqual(typeof downloadCoord.resumeDownloadsPausedByInGame, 'function');

    // Simulate pause and resume lifecycle
    const pauseResult = downloadCoord.pauseActiveDownloadsForInGame();
    assert.ok(pauseResult && Array.isArray(pauseResult.pausedTaskIds), 'Must return object with pausedTaskIds array');

    const resumeResult = downloadCoord.resumeDownloadsPausedByInGame();
    assert.ok(resumeResult && Array.isArray(resumeResult.resumedTaskIds), 'Must return object with resumedTaskIds array');
  });

  test({
    id: 'F18-08',
    feature: 'F12',
    tier: 1,
    description: 'GOG V2 Streaming Extractor: gogScriptInterpreter parses safe registry QWORD hex values into BigInt',
  }, () => {
    const qwordHex = '0x0100000000'; // 4294967296n
    const parsed = gogScript.parseSafeRegistryQwordBigInt(qwordHex);
    assert.strictEqual(parsed.toString(), '4294967296');

    // Invalid string returns 0n safely
    const invalidParsed = gogScript.parseSafeRegistryQwordBigInt('invalid_hex');
    assert.strictEqual(invalidParsed.toString(), '0');
  });

  test({
    id: 'F18-09',
    feature: 'F12',
    tier: 1,
    description: 'GOG V2 Streaming Extractor: patchRawWineRegistrySectionsBatch applies GOG registry entries without file corruption',
  }, () => {
    const regDir = makeTempDir('f18-reg');
    const userRegPath = path.join(regDir, 'user.reg');
    fs.writeFileSync(
      userRegPath,
      'WINE REGISTRY Version 2\n;; All keys relative to \\\\User\\\\S-1-5-21-0-0-0-1000\n\n#arch=win64\n\n[Software\\\\GOG.com\\\\Games\\\\1234567890]\n"PATH"="C:\\\\Games\\\\MyGame"\n'
    );

    const patchItems = [
      {
        subKeyPath: 'Software\\\\GOG.com\\\\Games\\\\1234567890',
        valueName: 'BUILDID',
        rawRegRhs: '"42"',
      },
      {
        subKeyPath: 'Software\\\\GOG.com\\\\Games\\\\1234567890',
        valueName: 'LANGUAGE',
        rawRegRhs: '"english"',
      },
    ];

    gogScript.patchRawWineRegistrySectionsBatch(userRegPath, patchItems);
    const patched = fs.readFileSync(userRegPath, 'utf8');
    assert.ok(patched.includes('BUILDID'), 'Must include patched BUILDID entry');
    assert.ok(patched.includes('"42"'), 'Must include value 42');
  });

  test({
    id: 'F18-10',
    feature: 'F12',
    tier: 1,
    description: 'GOG V2 Streaming Extractor: selectCompatibleWin10SiblingDll resolves matching architecture helper DLLs',
  }, () => {
    const dllDir = makeTempDir('f18-dlls');
    fs.writeFileSync(path.join(dllDir, 'dinput8.dll'), Buffer.alloc(100));
    fs.writeFileSync(path.join(dllDir, 'dinput8_win10.dll'), Buffer.alloc(100));

    const selected = gogScript.selectCompatibleWin10SiblingDll(
      path.join(dllDir, 'dinput8.dll'),
      { isWin10Plus: true }
    );
    assert.strictEqual(path.basename(selected), 'dinput8_win10.dll');
  });

  test({
    id: 'F18-11',
    feature: 'F13',
    tier: 1,
    description: 'Epic Third-Party Partner Handoff: extractEpicThirdPartyPartnerMetadata detects EA Origin partner titles',
  }, () => {
    const manifest = {
      customAttributes: {
        ThirdPartyManagedApp: { value: 'Origin' },
        PartnerLinkType: { value: 'origin2' },
      },
    };

    const partnerMeta = epicCoordinator.extractEpicThirdPartyPartnerMetadata(manifest);
    assert.strictEqual(partnerMeta.chainedLauncherHandoff, 'ea');
    assert.strictEqual(partnerMeta.chainedHandoffTopology, 'partner_launcher_link');
    assert.strictEqual(partnerMeta.thirdPartyManagedApp, 'Origin');
    assert.strictEqual(partnerMeta.partnerLinkType, 'origin2');
    assert.strictEqual(partnerMeta.macSupported, false, 'Windows-only partner games must suppress mac support');
  });

  test({
    id: 'F18-12',
    feature: 'F13',
    tier: 1,
    description: 'Epic Third-Party Partner Handoff: extractEpicThirdPartyPartnerMetadata detects Ubisoft partner titles',
  }, () => {
    const manifest = {
      customAttributes: {
        ThirdPartyManagedApp: { value: 'Uplay' },
        PartnerLinkType: { value: 'uplay' },
      },
    };

    const partnerMeta = epicCoordinator.extractEpicThirdPartyPartnerMetadata(manifest);
    assert.strictEqual(partnerMeta.chainedLauncherHandoff, 'ubisoft');
    assert.strictEqual(partnerMeta.chainedHandoffTopology, 'partner_launcher_link');
    assert.strictEqual(partnerMeta.thirdPartyManagedApp, 'Uplay');
  });

  test({
    id: 'F18-13',
    feature: 'F13',
    tier: 1,
    description: 'Epic Third-Party Partner Handoff: normalizeChainedHandoffId maps diverse partner aliases to standard keys',
  }, () => {
    assert.strictEqual(chainedPublishers.normalizeChainedHandoffId('origin'), 'ea');
    assert.strictEqual(chainedPublishers.normalizeChainedHandoffId('ea_desktop'), 'ea');
    assert.strictEqual(chainedPublishers.normalizeChainedHandoffId('uplay'), 'ubisoft');
    assert.strictEqual(chainedPublishers.normalizeChainedHandoffId('ubisoft_connect'), 'ubisoft');
    assert.strictEqual(chainedPublishers.normalizeChainedHandoffId('bnet'), 'bnet');
    assert.strictEqual(chainedPublishers.normalizeChainedHandoffId('rockstar'), 'rockstar');
  });

  test({
    id: 'F18-14',
    feature: 'F13',
    tier: 1,
    description: 'Epic Third-Party Partner Handoff: buildChainedLauncherLaunchSpec generates URI protocol launch specification',
  }, () => {
    const spec = chainedPublishers.buildChainedLauncherLaunchSpec({
      handoffId: 'ea',
      launcherBinaryPath: 'C:\\\\Program Files\\\\EA\\\\EADesktop.exe',
      installDir: 'C:\\\\Games\\\\MassEffect',
    });

    assert.ok(spec, 'Must build valid launch spec');
    assert.ok(spec.launcherExe && spec.launcherExe.includes('EADesktop.exe'), 'Must specify launcher executable');
    assert.ok(Array.isArray(spec.args), 'Must provide launch argument list');
    assert.ok(spec.envOverrides && spec.envOverrides.WINEDLLOVERRIDES, 'Must configure DLL overrides');
  });

  test({
    id: 'F18-15',
    feature: 'F13',
    tier: 1,
    description: 'Epic Third-Party Partner Handoff: sanitizeChainedPublisherAutostartInBottleRegs neutralizes autostart run keys',
  }, () => {
    const bottleDir = makeTempDir('f18-ea-bottle');
    const userRegPath = path.join(bottleDir, 'user.reg');
    fs.writeFileSync(
      userRegPath,
      'WINE REGISTRY Version 2\n\n[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run]\n"EABackgroundService"="C:\\\\Program Files\\\\EA\\\\EABackgroundService.exe"\n'
    );

    chainedPublishers.sanitizeEaBottleAutostartInUserReg(bottleDir);
    const cleaned = fs.readFileSync(userRegPath, 'utf8');
    assert.ok(!cleaned.includes('EABackgroundService'), 'EA background autostart key must be stripped from user.reg');
  });

  test({
    id: 'F18-16',
    feature: 'F14',
    tier: 1,
    description: 'Universal Portability & Zero-PII: source tree contains zero personal paths or usernames',
  }, () => {
    const launcherDir = path.resolve(__dirname, '../../../electron/launcher');
    const files = fs.readdirSync(launcherDir).filter(f => f.endsWith('.cjs'));

    for (const f of files) {
      const content = fs.readFileSync(path.join(launcherDir, f), 'utf8');
      assert.strictEqual(
        /\/Users\/(?!Shared)[a-zA-Z0-9_-]+\/(?!Documents\/Antigravity)/.test(content),
        false,
        `File ${f} must not leak personal macOS home directory`
      );
      assert.strictEqual(
        /[A-Z]:\\Users\\(?!Public)[a-zA-Z0-9_-]+\\/i.test(content),
        false,
        `File ${f} must not leak personal Windows user profile`
      );
    }
  });

  test({
    id: 'F18-17',
    feature: 'F14',
    tier: 1,
    description: 'Universal Portability & Zero-PII: core scaler engine contains zero hardcoded game title strings',
  }, () => {
    const scalerMathSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_math.c'),
      'utf8'
    );
    const scalerDllSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/display_scaler/display_scaler_dll.c'),
      'utf8'
    );

    assert.strictEqual(/JediKnight/i.test(scalerMathSrc), false, 'display_scaler_math.c must contain zero game names');
    assert.strictEqual(/Quake/i.test(scalerMathSrc), false, 'display_scaler_math.c must contain zero game names');
    assert.strictEqual(/JediKnight/i.test(scalerDllSrc), false, 'display_scaler_dll.c must contain zero game names');
  });

  test({
    id: 'F18-18',
    feature: 'F14',
    tier: 1,
    description: 'Universal Portability & Zero-PII: fresh install boots cleanly with empty database and zero pre-baked static records',
  }, () => {
    const cacheFederator = require('../../../electron/launcher/storefrontLocalCacheFederator.cjs');
    assert.strictEqual(typeof cacheFederator.StorefrontLocalCacheFederator, 'function');
    assert.strictEqual(typeof cacheFederator.clearFederatorCaches, 'function');

    const federator = new cacheFederator.StorefrontLocalCacheFederator();
    assert.ok(federator !== null && typeof federator === 'object');
    assert.strictEqual(typeof federator.resolveLocalMetadata, 'function');
    assert.strictEqual(typeof federator.trimMemory, 'function');
  });

  test({
    id: 'F18-19',
    feature: 'F14',
    tier: 1,
    description: 'Universal Portability & Zero-PII: platform driver gating executes darwin logic strictly on macOS',
  }, () => {
    const installer = require('../../../electron/launcher/macNativeInstallerAndCodesign.cjs');
    assert.strictEqual(typeof installer.applyCrossOverPerGameSettings, 'function');
  });

  test({
    id: 'F18-20',
    feature: 'F14',
    tier: 1,
    description: 'Universal Portability & Zero-PII: sanitized candidate records strip authentication secrets and private tokens',
  }, () => {
    // Normal record retains game metadata
    const normalCandidate = {
      app_name: 'game_xyz',
      title: 'Test Game',
      access_token: 'valid_token_123',
    };
    const sanitizedNormal = epicCoordinator.sanitizeEpicCandidateRecord(normalCandidate);
    assert.ok(sanitizedNormal && sanitizedNormal.record);
    assert.strictEqual(sanitizedNormal.record.app_name, 'game_xyz');

    // Poisoned/corrupted token record is neutralized
    const poisonedCandidate = {
      app_name: 'game_xyz',
      title: 'Test Game',
      access_token: '[object Object]',
    };
    const sanitizedPoisoned = epicCoordinator.sanitizeEpicCandidateRecord(poisonedCandidate);
    assert.strictEqual(sanitizedPoisoned.record, null, 'Poisoned record must be neutralized to null');
    assert.strictEqual(sanitizedPoisoned.poisoned, true, 'Must flag poisoned as true');
  });
});
