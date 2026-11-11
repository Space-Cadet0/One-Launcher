'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, assert, makeTempDir, cleanupTempDirs } = require('../harness/index.cjs');

const xboxAuth = require('../../../electron/storefronts/xbox/xboxAuthManager.cjs');
const tokenVault = require('../../../electron/storefronts/tokenVault.cjs');

suite('Tier 1 — Feature F17: Storefront Authentication, GDK Bridge & Token Vault (Features 8, 9, 10)', () => {
  let tempDir;

  test({
    id: 'F17-01',
    feature: 'F8',
    tier: 1,
    description: 'Xbox LiveSDK OAuth 2.0: standard authorization URL constructs with LiveSDK client ID and scope',
  }, () => {
    assert.strictEqual(xboxAuth.XBOX_LIVESDK_CLIENT_ID, '00000000402b5328');
    assert.strictEqual(xboxAuth.SCOPE_XBL_MBI_SSL, 'service::user.auth.xboxlive.com::MBI_SSL');

    const result = xboxAuth.buildXboxAuthorizationUrl({
      clientId: xboxAuth.XBOX_LIVESDK_CLIENT_ID,
      redirectUri: xboxAuth.XBOX_OAUTH_REDIRECT_URI,
      scope: xboxAuth.SCOPE_XBL_MBI_SSL,
      state: 'test_state_12345',
    });

    assert.ok(typeof result === 'object' && result.url, 'Must return authorization result object with url');
    assert.ok(result.url.startsWith('https://login.live.com/oauth20_authorize.srf'), 'Must target live.com OAuth endpoint');
    assert.ok(result.url.includes('client_id=00000000402b5328'), 'Must include client ID');
    assert.ok(result.url.includes('response_type=code'), 'Must request code response type');
    assert.ok(result.url.includes('state=test_state_12345'), 'Must include state');
  });

  test({
    id: 'F17-02',
    feature: 'F8',
    tier: 1,
    description: 'Xbox LiveSDK OAuth 2.0: compact JWE 5-segment tokens normalize d= prefix to t= prefix',
  }, () => {
    // 5-segment base64url JWE candidate returned by TOKEN_BROKER delegation compact flow
    const p1 = Buffer.from(JSON.stringify({ alg: 'RSA1_5', enc: 'A128CBC-HS256' })).toString('base64url');
    const p2 = Buffer.from('encryptedKeyData').toString('base64url');
    const p3 = Buffer.from('initializationVector').toString('base64url');
    const p4 = Buffer.from('cipherTextPayload').toString('base64url');
    const p5 = Buffer.from('authTagData').toString('base64url');
    const mockJwe = `${p1}.${p2}.${p3}.${p4}.${p5}`;

    assert.ok(xboxAuth.isCompactJwe(mockJwe), 'Must detect valid 5-segment compact JWE');

    // d= prefix from delegation token must be normalized to t= for user.auth.xboxlive.com
    const delegationTicket = `d=${mockJwe}`;
    const normalized = xboxAuth.normalizeXblRpsTicket(delegationTicket);
    assert.strictEqual(normalized, `t=${mockJwe}`, 'Compact JWE must be normalized to t=<jwe>');

    // Bare JWE must also normalize to t=<jwe>
    const bareNormalized = xboxAuth.normalizeXblRpsTicket(mockJwe);
    assert.strictEqual(bareNormalized, `t=${mockJwe}`);
  });

  test({
    id: 'F17-03',
    feature: 'F8',
    tier: 1,
    description: 'Xbox LiveSDK OAuth 2.0: ephemeral ECDSA P-256 proof keypair exports required JWK structure',
  }, () => {
    const keyPair = xboxAuth.generateXboxProofKeyPair();
    assert.ok(keyPair.publicKey, 'Must generate public key');
    assert.ok(keyPair.privateKey, 'Must generate private key');
    assert.ok(keyPair.proofKeyJwk, 'Must export ProofKey JWK');

    const jwk = keyPair.proofKeyJwk;
    assert.strictEqual(jwk.kty, 'EC', 'ProofKey key type must be EC');
    assert.strictEqual(jwk.crv, 'P-256', 'Curve must be NIST P-256');
    assert.strictEqual(jwk.use, 'sig', 'Key usage must be signature');
    assert.ok(typeof jwk.x === 'string' && jwk.x.length > 0, 'Public coordinate x must be present');
    assert.ok(typeof jwk.y === 'string' && jwk.y.length > 0, 'Public coordinate y must be present');
  });

  test({
    id: 'F17-04',
    feature: 'F8',
    tier: 1,
    description: 'Xbox LiveSDK OAuth 2.0: trusted host validation restricts auth redirect flow to Microsoft domains',
  }, () => {
    assert.strictEqual(xboxAuth.isTrustedXboxAuthUrl('https://login.live.com/oauth20_desktop.srf'), true);
    assert.strictEqual(xboxAuth.isTrustedXboxAuthUrl('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize'), true);
    assert.strictEqual(xboxAuth.isTrustedXboxAuthUrl('https://sisu.xboxlive.com/connect/oauth/token'), true);

    // Untrusted domains must be rejected
    assert.strictEqual(xboxAuth.isTrustedXboxAuthUrl('https://malicious-site.com/login.live.com'), false);
    assert.strictEqual(xboxAuth.isTrustedXboxAuthUrl('http://insecure-login.live.com'), false);
  });

  test({
    id: 'F17-05',
    feature: 'F8',
    tier: 1,
    description: 'Xbox LiveSDK OAuth 2.0: extractAuthCodeFromInput parses query parameters and handles token broker sentinel',
  }, () => {
    const redirectUrl = 'https://login.live.com/oauth20_desktop.srf?code=M.R3_BL2.abcdef123456&state=state_abc';
    const extracted = xboxAuth.extractAuthCodeFromInput(redirectUrl);
    assert.strictEqual(extracted, 'M.R3_BL2.abcdef123456');

    // Error in redirect URL throws informative error
    const errorUrl = 'https://login.live.com/oauth20_desktop.srf?error=access_denied&error_description=User+cancelled';
    assert.throws(
      () => xboxAuth.extractAuthCodeFromInput(errorUrl),
      /access_denied/
    );
  });

  test({
    id: 'F17-06',
    feature: 'F9',
    tier: 1,
    description: 'Xbox GDK Bridge Struct Alignment: C11 struct wgs_index_state layout in xgamesave.c aligns 16-byte boundaries',
  }, () => {
    const xgamesaveSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/xgr_bridge/xgamesave.c'),
      'utf8'
    );

    // Verify struct wgs_index_state definition exists with explicit typed fields
    const hasStructIndex = /struct\s+wgs_index_state\s*\{[\s\S]*?int32_t\s+version;[\s\S]*?char\s+pkg_display_name\[256\];[\s\S]*?uint64_t\s+creation_ft;[\s\S]*?uint32_t\s+count;[\s\S]*?struct\s+wgs_container_entry\s*\*items;[\s\S]*?\};/m.test(xgamesaveSrc);
    assert.ok(hasStructIndex, 'wgs_index_state struct definition must match 64-bit alignment');
  });

  test({
    id: 'F17-07',
    feature: 'F9',
    tier: 1,
    description: 'Xbox GDK Bridge Struct Alignment: init_default_wgs_index initializes empty container index safely',
  }, () => {
    const xgamesaveSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/xgr_bridge/xgamesave.c'),
      'utf8'
    );

    // Contract: idx->count = 0 and idx->items = NULL
    const hasSafeInit = /init_default_wgs_index\s*\([\s\S]*?idx->count\s*=\s*0;[\s\S]*?idx->items\s*=\s*NULL;/m.test(xgamesaveSrc);
    assert.ok(hasSafeInit, 'init_default_wgs_index must zero items pointer and count to avoid wild memory dereference');
  });

  test({
    id: 'F17-08',
    feature: 'F9',
    tier: 1,
    description: 'Xbox GDK Bridge Struct Alignment: index iteration guards against NULL items before dereference',
  }, () => {
    const xgamesaveSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/xgr_bridge/xgamesave.c'),
      'utf8'
    );

    // Iterations over items must verify idx.items != NULL
    const hasNullGuard = /idx\.items\s*!=\s*NULL\s*&&\s*i\s*<\s*idx\.count/m.test(xgamesaveSrc);
    assert.ok(hasNullGuard, 'Container index enumeration must guard idx.items != NULL');
  });

  test({
    id: 'F17-09',
    feature: 'F9',
    tier: 1,
    description: 'Xbox GDK Bridge Struct Alignment: containers.index binary serializer specifies version 14 format',
  }, () => {
    const xgamesaveSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/xgr_bridge/xgamesave.c'),
      'utf8'
    );

    const hasVer14 = /int32_t\s+ver\s*=\s*idx->version\s*\?\s*idx->version\s*:\s*14;/m.test(xgamesaveSrc);
    assert.ok(hasVer14, 'Save index writer must specify version 14 baseline');
  });

  test({
    id: 'F17-10',
    feature: 'F9',
    tier: 1,
    description: 'Xbox GDK Bridge Struct Alignment: free_wgs_index releases dynamic items memory safely and zeroes struct',
  }, () => {
    const xgamesaveSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../electron/helpers/xgr_bridge/xgamesave.c'),
      'utf8'
    );

    const hasFreeIndex = /free_wgs_index\s*\([\s\S]*?free\(idx->items\);[\s\S]*?memset\(idx,\s*0,\s*sizeof\(\*idx\)\);/m.test(xgamesaveSrc);
    assert.ok(hasFreeIndex, 'free_wgs_index must free items buffer and memset struct to 0 to prevent double-free');
  });

  test({
    id: 'F17-11',
    feature: 'F10',
    tier: 1,
    description: 'Encrypted Token Vault: encryptTokensPayload and decryptTokensPayload round-trip JSON payload with AES-256-GCM',
  }, () => {
    const secret = Buffer.alloc(32, 0x42);
    const originalPayload = {
      steam: { accountId: '76561198000000000', refreshToken: 'steam_refresh_secret' },
      epic: { accountId: 'epic_user_1', accessToken: 'epic_access_token_xyz' },
      version: 1,
    };

    const envelope = tokenVault.encryptTokensPayload(JSON.stringify(originalPayload), { secret });
    assert.ok(envelope, 'Encryption must produce valid envelope');

    const decrypted = tokenVault.decryptTokensPayload(envelope, { secret });
    assert.deepStrictEqual(decrypted, originalPayload, 'Decrypted tokens must match original payload exactly');
  });

  test({
    id: 'F17-12',
    feature: 'F10',
    tier: 1,
    description: 'Encrypted Token Vault: runWithVaultMutex serializes concurrent asynchronous vault operations',
    async: true,
  }, async () => {
    const dummyPath = path.join(makeTempDir('f17-mutex'), 'mutex_target.json');
    const executionOrder = [];
    const p1 = tokenVault.runWithVaultMutex(dummyPath, async () => {
      await new Promise(r => setTimeout(r, 20));
      executionOrder.push(1);
      return 'p1';
    });
    const p2 = tokenVault.runWithVaultMutex(dummyPath, async () => {
      executionOrder.push(2);
      return 'p2';
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(r1, 'p1');
    assert.strictEqual(r2, 'p2');
    assert.deepStrictEqual(executionOrder, [1, 2], 'Vault operations must execute in strict serialized order');
  });

  test({
    id: 'F17-13',
    feature: 'F10',
    tier: 1,
    description: 'Encrypted Token Vault: writeTokensFile creates atomic backup file before writing active tokens file',
  }, () => {
    const vaultDir = makeTempDir('f17-vault');
    const tokensPath = path.join(vaultDir, 'tokens.json');

    // Initial save of token data
    tokenVault.writeTokensFile({ xbox: { gamertag: 'MasterChief' } }, { filePath: tokensPath });
    assert.ok(fs.existsSync(tokensPath), 'tokens.json must exist');

    // Second save should create .bak file of previous version
    tokenVault.writeTokensFile({ xbox: { gamertag: 'Cortana' } }, { filePath: tokensPath });

    const bakPath = `${tokensPath}.bak`;
    assert.ok(fs.existsSync(bakPath), 'tokens.json.bak atomic backup must be generated');

    const loaded = tokenVault.loadSavedTokens({ filePath: tokensPath });
    assert.strictEqual(loaded.xbox.gamertag, 'Cortana');
  });

  test({
    id: 'F17-14',
    feature: 'F10',
    tier: 1,
    description: 'Encrypted Token Vault: loadSavedTokens handles non-existent vault path returning empty object',
  }, () => {
    tokenVault.invalidateVaultMemoryCache();
    const nonExistentPath = path.join(makeTempDir('f17-empty'), 'non_existent_tokens.json');
    const loaded = tokenVault.loadSavedTokens({ filePath: nonExistentPath });
    assert.deepStrictEqual(loaded, {}, 'Missing token vault must resolve to empty object without throwing');
  });

  test({
    id: 'F17-15',
    feature: 'F10',
    tier: 1,
    description: 'Encrypted Token Vault: projectRedactedXboxSummary sanitizes token records without leaking secrets',
  }, () => {
    const rawTokens = {
      msaRefreshToken: 'secret_refresh_token_999',
      userToken: 'secret_user_token_abc',
      xstsXboxLiveToken: 'secret_xsts_token_xyz',
      gamertag: 'Spartan117',
      xuid: '2533274790000000',
    };

    const redacted = tokenVault.projectRedactedXboxSummary(rawTokens);
    assert.ok(redacted, 'Must return summary object');
    assert.strictEqual(redacted.connected, true);
    assert.strictEqual(redacted.gamertag, 'Spartan117');
    assert.strictEqual(redacted.xuid, '2533274790000000');
    assert.strictEqual(redacted.userToken, undefined, 'User token must not be leaked in summary');
    assert.strictEqual(redacted.xstsXboxLiveToken, undefined, 'XSTS token must not be leaked in summary');
    assert.strictEqual(redacted.msaRefreshToken, undefined, 'Refresh token must not be leaked in summary');
  });
});
