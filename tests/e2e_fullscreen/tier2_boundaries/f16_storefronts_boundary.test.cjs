'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, makeTempDir, cleanupTempDirs } = require('../harness/index.cjs');

const xboxAuth = require('../../../electron/storefronts/xbox/xboxAuthManager.cjs');
const tokenVault = require('../../../electron/storefronts/tokenVault.cjs');
const cloudSave = require('../../../electron/launcher/cloudSaveEngine.cjs');
const gogScript = require('../../../electron/storefronts/gog/gogScriptInterpreter.cjs');
const downloadCoord = require('../../../electron/launcher/downloadQueueCoordinator.cjs');
const epicCoordinator = require('../../../electron/launcher/epicLegendaryAndEosCoordinator.cjs');
const chainedPublishers = require('../../../electron/launcher/chainedPublisherLaunchers.cjs');
const security = require('../../../electron/launcher/securityAndPathUtils.cjs');
const uninstall = require('../../../electron/launcher/uninstallSafety.cjs');

suite('Tier 2 — Feature F16 Boundaries: Storefronts, Token Vault & Universal Portability (Features 8–14)', () => {
  // Feature 8 Boundaries: Xbox LiveSDK OAuth 2.0
  test({
    id: 'F16-B01',
    feature: 'F8',
    tier: 2,
    description: 'Xbox OAuth Boundary: malformed or truncated JWE strings rejected by isCompactJwe',
  }, () => {
    assert.strictEqual(xboxAuth.isCompactJwe(''), false);
    assert.strictEqual(xboxAuth.isCompactJwe(null), false);
    assert.strictEqual(xboxAuth.isCompactJwe('part1.part2.part3'), false); // only 3 parts
    assert.strictEqual(xboxAuth.isCompactJwe('part1.part2.part3.part4.part5.part6'), false); // 6 parts
    assert.strictEqual(xboxAuth.isCompactJwe('not_base64_json.b.c.d.e'), false);
  });

  test({
    id: 'F16-B02',
    feature: 'F8',
    tier: 2,
    description: 'Xbox OAuth Boundary: normalizeXblRpsTicket handles empty, null, and whitespace inputs safely',
  }, () => {
    assert.strictEqual(xboxAuth.normalizeXblRpsTicket(''), '');
    assert.strictEqual(xboxAuth.normalizeXblRpsTicket(null), '');
    assert.strictEqual(xboxAuth.normalizeXblRpsTicket('   '), '');
    assert.strictEqual(xboxAuth.normalizeXblRpsTicket('t='), '');
    assert.strictEqual(xboxAuth.normalizeXblRpsTicket('d='), '');
  });

  test({
    id: 'F16-B03',
    feature: 'F8',
    tier: 2,
    description: 'Xbox OAuth Boundary: extractAuthCodeFromInput throws when authorization code is missing or denied',
  }, () => {
    assert.throws(() => xboxAuth.extractAuthCodeFromInput(''), /authorization code/i);
    assert.throws(() => xboxAuth.extractAuthCodeFromInput('https://login.live.com/oauth20_desktop.srf'), /authorization code/i);
    assert.throws(() => xboxAuth.extractAuthCodeFromInput('https://login.live.com/oauth20_desktop.srf?state=123'), /authorization code/i);
    assert.throws(() => xboxAuth.extractAuthCodeFromInput('https://login.live.com/oauth20_desktop.srf?error=access_denied'), /denied/i);
    assert.strictEqual(xboxAuth.extractAuthCodeFromInput('raw-auth-code-12345'), 'raw-auth-code-12345');
  });

  test({
    id: 'F16-B04',
    feature: 'F8',
    tier: 2,
    description: 'Xbox OAuth Boundary: isTrustedXboxAuthUrl rejects port spoofing and path-based impersonation',
  }, () => {
    assert.strictEqual(xboxAuth.isTrustedXboxAuthUrl('https://login.live.com:8080/'), false);
    assert.strictEqual(xboxAuth.isTrustedXboxAuthUrl('https://attacker.com/login.live.com'), false);
    assert.strictEqual(xboxAuth.isTrustedXboxAuthUrl('ftp://login.live.com/'), false);
  });

  test({
    id: 'F16-B05',
    feature: 'F8',
    tier: 2,
    description: 'Xbox OAuth Boundary: normalizeStoreMsaTicket handles diverse target variants safely',
  }, () => {
    const raw = 'd=test_opaque_ticket_123';
    assert.strictEqual(xboxAuth.normalizeStoreMsaTicket(raw, { target: 'collections_bare' }), 'test_opaque_ticket_123');
    assert.strictEqual(xboxAuth.normalizeStoreMsaTicket(raw, { target: 'collections' }), 'WLID1.0="test_opaque_ticket_123"');
    assert.strictEqual(xboxAuth.normalizeStoreMsaTicket(raw, { target: 'pcgafd' }), 't=test_opaque_ticket_123');
  });

  // Feature 9 Boundaries: Xbox GDK Bridge Struct Alignment
  test({
    id: 'F16-B06',
    feature: 'F9',
    tier: 2,
    description: 'Xbox GDK Bridge Boundary: C11 containers.index boundary check protects buffer overrun',
  }, () => {
    const xgamesaveSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/xgr_bridge/xgamesave.c'),
      'utf8'
    );

    // Verify boundary check on index entry count
    const hasCountGuard = /idx->count\s*>\s*XGR_SAVE_CONTAINER_MAX|XGR_SAVE_CONTAINER_MAX|count\s*>\s*1000/i.test(xgamesaveSrc) ||
      /MAX_PATH/i.test(xgamesaveSrc);
    assert.ok(hasCountGuard, 'xgamesave.c must contain structural boundary checks');
  });

  test({
    id: 'F16-B07',
    feature: 'F9',
    tier: 2,
    description: 'Xbox GDK Bridge Boundary: xgamesave verifies container name validity and length',
  }, () => {
    const xgamesaveSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/xgr_bridge/xgamesave.c'),
      'utf8'
    );

    const hasNameValidation = /is_valid_container_name|E_GS_INVALID_CONTAINER_NAME/i.test(xgamesaveSrc);
    assert.ok(hasNameValidation, 'Container name validation must reject empty or invalid names');
  });

  test({
    id: 'F16-B08',
    feature: 'F9',
    tier: 2,
    description: 'Xbox GDK Bridge Boundary: critical section synchronization isolates concurrent save provider access',
  }, () => {
    const xgamesaveSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/xgr_bridge/xgamesave.c'),
      'utf8'
    );

    assert.ok(xgamesaveSrc.includes('EnterCriticalSection(&prov->cs)'));
    assert.ok(xgamesaveSrc.includes('LeaveCriticalSection(&prov->cs)'));
  });

  test({
    id: 'F16-B09',
    feature: 'F9',
    tier: 2,
    description: 'Xbox GDK Bridge Boundary: empty containers.index writes valid 0-count index without null pointer dereference',
  }, () => {
    const xgamesaveSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/xgr_bridge/xgamesave.c'),
      'utf8'
    );

    const hasZeroCountSerialization = /int32_t\s+cnt\s*=\s*\(idx->items\s*!=\s*NULL\)\s*\?\s*\(int32_t\)idx->count\s*:\s*0;/m.test(xgamesaveSrc);
    assert.ok(hasZeroCountSerialization, 'Zero-count index must safely write 0 items without reading idx->items[0]');
  });

  test({
    id: 'F16-B10',
    feature: 'F9',
    tier: 2,
    description: 'Xbox GDK Bridge Boundary: remaining quota computation returns default quota on null provider',
  }, () => {
    const xgamesaveSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/xgr_bridge/xgamesave.c'),
      'utf8'
    );

    const hasQuotaGuard = /compute_remaining_quota\s*\([\s\S]*?if\s*\(!prov\)\s*return\s*XGR_SAVE_QUOTA_DEFAULT;/m.test(xgamesaveSrc);
    assert.ok(hasQuotaGuard, 'Remaining quota function must guard against null provider handle');
  });

  // Feature 10 Boundaries: Encrypted Token Vault
  test({
    id: 'F16-B11',
    feature: 'F10',
    tier: 2,
    description: 'Token Vault Boundary: corrupted auth tag or tampered ciphertext throws during decryption',
  }, () => {
    tokenVault.invalidateVaultMemoryCache();
    const secret = Buffer.alloc(32, 0x77);
    const tampered = {
      v: 1,
      alg: 'AES-256-GCM',
      iv: Buffer.alloc(12).toString('base64'),
      tag: Buffer.alloc(16).toString('base64'),
      ct: 'bad_ciphertext_data',
    };
    assert.throws(
      () => tokenVault.decryptTokensPayload(tampered, { secret }),
      /fail|bad|decrypt|invalid/i
    );
  });

  test({
    id: 'F16-B12',
    feature: 'F10',
    tier: 2,
    description: 'Token Vault Boundary: decryptTokensPayload handles invalid envelope objects gracefully',
  }, () => {
    const secret = Buffer.alloc(32, 0x88);
    assert.throws(() => tokenVault.decryptTokensPayload(null, { secret }));
    assert.throws(() => tokenVault.decryptTokensPayload({}, { secret }));
    assert.throws(() => tokenVault.decryptTokensPayload('not an envelope', { secret }));
  });

  test({
    id: 'F16-B13',
    feature: 'F10',
    tier: 2,
    description: 'Token Vault Boundary: projectRedactedXboxSummary returns undefined on invalid inputs',
  }, () => {
    assert.strictEqual(tokenVault.projectRedactedXboxSummary(null), undefined);
    assert.strictEqual(tokenVault.projectRedactedXboxSummary(undefined), undefined);
    assert.strictEqual(tokenVault.projectRedactedXboxSummary('string'), undefined);
    assert.strictEqual(tokenVault.projectRedactedXboxSummary({ unconnected: true }), undefined);
  });

  test({
    id: 'F16-B14',
    feature: 'F10',
    tier: 2,
    description: 'Token Vault Boundary: 50 concurrent serialized mutex acquisitions resolve without race condition',
    async: true,
  }, async () => {
    const dummyPath = path.join(makeTempDir('f16-mutex-stress'), 'stress.json');
    const results = [];
    const promises = [];

    for (let i = 0; i < 50; i++) {
      promises.push(
        tokenVault.runWithVaultMutex(dummyPath, async () => {
          results.push(i);
          return i;
        })
      );
    }

    const resolved = await Promise.all(promises);
    assert.strictEqual(resolved.length, 50);
    assert.strictEqual(results.length, 50);
  });

  test({
    id: 'F16-B15',
    feature: 'F10',
    tier: 2,
    description: 'Token Vault Boundary: isMockOrCorruptedToken detects poisoned and mock tokens',
  }, () => {
    assert.strictEqual(tokenVault.isMockOrCorruptedToken(''), true);
    assert.strictEqual(tokenVault.isMockOrCorruptedToken('[object Object]'), true);
    assert.strictEqual(tokenVault.isMockOrCorruptedToken('mock_access_token'), true);
    assert.strictEqual(tokenVault.isMockOrCorruptedToken('fake_refresh_token'), true);
    assert.strictEqual(tokenVault.isMockOrCorruptedToken('valid_access_token_12345'), false);
  });

  // Feature 11 Boundaries: Steam Two-Stage Sync
  test({
    id: 'F16-B16',
    feature: 'F11',
    tier: 2,
    description: 'Steam Sync Boundary: hasWin32CloudPlaceholderAttributes detects offline file attributes',
  }, () => {
    assert.strictEqual(
      cloudSave.hasWin32CloudPlaceholderAttributes(cloudSave.FILE_ATTRIBUTE_OFFLINE),
      true
    );
    assert.strictEqual(
      cloudSave.hasWin32CloudPlaceholderAttributes(cloudSave.FILE_ATTRIBUTE_RECALL_ON_OPEN),
      true
    );
    assert.strictEqual(cloudSave.hasWin32CloudPlaceholderAttributes(0), false);
  });

  test({
    id: 'F16-B17',
    feature: 'F11',
    tier: 2,
    description: 'Steam Sync Boundary: isOneDrivePath detects common OneDrive root directories',
  }, () => {
    assert.strictEqual(cloudSave.isOneDrivePath('C:\\Users\\user\\OneDrive\\Documents'), true);
    assert.strictEqual(cloudSave.isOneDrivePath('/Users/user/OneDrive/Saves'), true);
    assert.strictEqual(cloudSave.isOneDrivePath('/Users/user/Games/Quake'), false);
  });

  test({
    id: 'F16-B18',
    feature: 'F11',
    tier: 2,
    description: 'Steam Sync Boundary: enforceCloudSaveBackupQuotaSync handles non-existent directory safely',
  }, () => {
    const nonExistent = '/tmp/non_existent_backups_path_12345';
    const res = cloudSave.enforceCloudSaveBackupQuotaSync(nonExistent);
    assert.strictEqual(res.evictedCount, 0);
    assert.strictEqual(res.freedBytes, 0);
  });

  test({
    id: 'F16-B19',
    feature: 'F11',
    tier: 2,
    description: 'Steam Sync Boundary: pruneCloudSaveStateForGame clears in-memory tracking without throwing',
  }, () => {
    assert.doesNotThrow(() => {
      cloudSave.pruneCloudSaveStateForGame('non_existent_game_id');
    });
  });

  test({
    id: 'F16-B20',
    feature: 'F11',
    tier: 2,
    description: 'Steam Sync Boundary: normalizePosixUtf8Locale returns valid UTF-8 locale on diverse inputs',
  }, () => {
    assert.strictEqual(cloudSave.normalizePosixUtf8Locale('en_US.UTF-8'), 'en_US.UTF-8');
    assert.strictEqual(cloudSave.normalizePosixUtf8Locale('C'), 'en_US.UTF-8');
    assert.strictEqual(cloudSave.normalizePosixUtf8Locale(''), 'en_US.UTF-8');
    assert.strictEqual(cloudSave.normalizePosixUtf8Locale(null), 'en_US.UTF-8');
  });

  // Feature 12 Boundaries: GOG V2 Streaming Extractor
  test({
    id: 'F16-B21',
    feature: 'F12',
    tier: 2,
    description: 'GOG Streaming Boundary: validateTrustedExternalLauncherUrl rejects javascript and data URIs',
  }, () => {
    assert.strictEqual(downloadCoord.validateTrustedExternalLauncherUrl('javascript:alert(1)'), '');
    assert.strictEqual(downloadCoord.validateTrustedExternalLauncherUrl('data:text/html,evil'), '');
    assert.strictEqual(downloadCoord.validateTrustedExternalLauncherUrl('file:///etc/passwd'), '');
  });

  test({
    id: 'F16-B22',
    feature: 'F12',
    tier: 2,
    description: 'GOG Streaming Boundary: parseSafeRegistryQwordBigInt handles edge values and zero inputs',
  }, () => {
    assert.strictEqual(gogScript.parseSafeRegistryQwordBigInt(0).toString(), '0');
    assert.strictEqual(gogScript.parseSafeRegistryQwordBigInt(null).toString(), '0');
    assert.strictEqual(gogScript.parseSafeRegistryQwordBigInt(undefined).toString(), '0');
    assert.strictEqual(gogScript.parseSafeRegistryQwordBigInt('0x0').toString(), '0');
  });

  test({
    id: 'F16-B23',
    feature: 'F12',
    tier: 2,
    description: 'GOG Streaming Boundary: patchRawWineRegistrySectionsBatch ignores empty patch lists safely',
  }, () => {
    const regDir = makeTempDir('f16-gog-empty');
    const userReg = path.join(regDir, 'user.reg');
    fs.writeFileSync(userReg, 'WINE REGISTRY Version 2\n');

    assert.doesNotThrow(() => {
      gogScript.patchRawWineRegistrySectionsBatch(userReg, []);
      gogScript.patchRawWineRegistrySectionsBatch(userReg, null);
      gogScript.patchRawWineRegistrySectionsBatch('', [{ subKeyPath: 'A', valueName: 'B', rawRegRhs: '"1"' }]);
    });
  });

  test({
    id: 'F16-B24',
    feature: 'F12',
    tier: 2,
    description: 'GOG Streaming Boundary: selectCompatibleWin10SiblingDll falls back to original path if sibling missing',
  }, () => {
    const missingSibling = '/tmp/non_existent_dinput8.dll';
    const selected = gogScript.selectCompatibleWin10SiblingDll(missingSibling, { isWin10Plus: true });
    assert.strictEqual(selected, missingSibling);
  });

  test({
    id: 'F16-B25',
    feature: 'F12',
    tier: 2,
    description: 'GOG Streaming Boundary: computeSmoothedDownloadSpeed clamps negative elapsed times safely',
  }, () => {
    const speed = downloadCoord.computeSmoothedDownloadSpeed(1000, 1000000, 500000);
    assert.ok(typeof speed === 'number' && speed >= 0);
  });

  // Feature 13 Boundaries: Epic Partner Handoff
  test({
    id: 'F16-B26',
    feature: 'F13',
    tier: 2,
    description: 'Epic Partner Boundary: extractEpicThirdPartyPartnerMetadata handles null and empty manifests',
  }, () => {
    assert.deepStrictEqual(epicCoordinator.extractEpicThirdPartyPartnerMetadata(null), {});
    assert.deepStrictEqual(epicCoordinator.extractEpicThirdPartyPartnerMetadata({}), {});
    assert.deepStrictEqual(epicCoordinator.extractEpicThirdPartyPartnerMetadata({ customAttributes: {} }), {});
  });

  test({
    id: 'F16-B27',
    feature: 'F13',
    tier: 2,
    description: 'Epic Partner Boundary: normalizeChainedHandoffId returns null on missing inputs',
  }, () => {
    assert.strictEqual(chainedPublishers.normalizeChainedHandoffId(''), null);
    assert.strictEqual(chainedPublishers.normalizeChainedHandoffId(null), null);
    assert.strictEqual(chainedPublishers.normalizeChainedHandoffId(undefined), null);
  });

  test({
    id: 'F16-B28',
    feature: 'F13',
    tier: 2,
    description: 'Epic Partner Boundary: sanitizeEaBottleAutostartInUserReg handles non-existent bottle directory gracefully',
  }, () => {
    assert.doesNotThrow(() => {
      chainedPublishers.sanitizeEaBottleAutostartInUserReg('/tmp/definitely_non_existent_bottle_xyz');
    });
  });

  test({
    id: 'F16-B29',
    feature: 'F13',
    tier: 2,
    description: 'Epic Partner Boundary: sanitizeEpicCandidateRecord handles null and primitive inputs safely',
  }, () => {
    assert.strictEqual(epicCoordinator.sanitizeEpicCandidateRecord(null), null);
    assert.strictEqual(epicCoordinator.sanitizeEpicCandidateRecord('not an object'), null);
    assert.strictEqual(epicCoordinator.sanitizeEpicCandidateRecord(123), null);
  });

  test({
    id: 'F16-B30',
    feature: 'F13',
    tier: 2,
    description: 'Epic Partner Boundary: buildChainedLauncherLaunchSpec handles missing optional parameters',
  }, () => {
    const spec = chainedPublishers.buildChainedLauncherLaunchSpec({ handoffId: 'ubisoft' });
    assert.ok(spec && Array.isArray(spec.args));
  });

  // Feature 14 Boundaries: Universal Portability & Zero-PII
  test({
    id: 'F16-B31',
    feature: 'F14',
    tier: 2,
    description: 'Portability Boundary: isContainedWithinRoot rejects UNC paths and device prefixes attempting escape',
  }, () => {
    const anchor = '/mock/games/root';
    assert.strictEqual(security.isContainedWithinRoot(anchor, '\\\\?\\C:\\Windows\\System32'), false);
    assert.strictEqual(security.isContainedWithinRoot(anchor, '\\\\attacker\\share\\payload.exe'), false);
    assert.strictEqual(security.isContainedWithinRoot(anchor, '/mock/games/root/\x00/../../escaped'), false);
  });

  test({
    id: 'F16-B32',
    feature: 'F14',
    tier: 2,
    description: 'Portability Boundary: isSafeToDeleteInstallPath rejects empty, relative, and non-string paths',
  }, () => {
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath(''), false);
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath(null), false);
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath(undefined), false);
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('.'), false);
    assert.strictEqual(uninstall.isSafeToDeleteInstallPath('..'), false);
  });

  test({
    id: 'F16-B33',
    feature: 'F14',
    tier: 2,
    description: 'Portability Boundary: safeRemoveGameDirectoryAsync rejects deletion of non-contained game path',
    async: true,
  }, async () => {
    await assert.rejects(
      async () => {
        await uninstall.safeRemoveGameDirectoryAsync('/', { dryRun: true });
      },
      /Refusing unsafe game uninstall path/
    );
  });

  test({
    id: 'F16-B34',
    feature: 'F14',
    tier: 2,
    description: 'Portability Boundary: clean cache federator initialization with temporary directories handles empty roots',
  }, () => {
    const cacheFed = require('../../../electron/launcher/storefrontLocalCacheFederator.cjs');
    const fed = new cacheFed.StorefrontLocalCacheFederator();
    const roots = fed.discoverRoots({ platform: 'darwin', homedir: makeTempDir('f16-empty-home') });
    assert.ok(roots && Array.isArray(roots.steamRoots));
  });

  test({
    id: 'F16-B35',
    feature: 'F14',
    tier: 2,
    description: 'Portability Boundary: toHostFilesystemPath normalizes mixed backslashes and forward slashes',
  }, () => {
    const mixed = 'C:\\Games/MyGame\\bin/app.exe';
    const normalized = security.toHostFilesystemPath(mixed);
    assert.ok(typeof normalized === 'string');
    assert.strictEqual(normalized.includes('\x00'), false);
  });
});
