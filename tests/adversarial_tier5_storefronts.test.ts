import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const nodeRequire = createRequire(import.meta.url);

// Storefronts and Vault
const tokenVault = nodeRequire('../electron/storefronts/tokenVault.cjs');
const xboxAuth = nodeRequire('../electron/storefronts/xbox/xboxAuthManager.cjs');
const msixvc = nodeRequire('../electron/storefronts/xbox/msixvcStreamExtractor.cjs');
const gogScript = nodeRequire('../electron/storefronts/gog/gogScriptInterpreter.cjs');

// Launcher & Supervisor
const securityUtils = nodeRequire('../electron/launcher/securityAndPathUtils.cjs');
const uninstallSafety = nodeRequire('../electron/launcher/uninstallSafety.cjs');
const epicCoordinator = nodeRequire('../electron/launcher/epicLegendaryAndEosCoordinator.cjs');
const supervisor = nodeRequire('../electron/launcher/sessionAndProcessSupervisor.cjs');
const processTree = nodeRequire('../electron/launcher/processTreeUtils.cjs');
const offlineVault = nodeRequire('../electron/launcher/offlineVaultService.cjs');

// Frontend
import {
  isCurrentlyFastScrolling,
  recordScrollActivity,
  addPendingFastScrollMount,
  removePendingFastScrollMount,
  notifyImageUnmounted,
} from '../src/components/Library/Grid/gridScrollTracker';
import {
  acquireModalOverlayLock,
  emergencyResetModalOverlayLock,
  checkModalOverlaySelfHealing,
  isModalOverlayOpen,
} from '../src/utils/modalOverlayLock';
import { AppErrorBoundary } from '../src/components/Common/AppErrorBoundary';
import {
  KNOWN_GAME_PATCHES,
  sanitizeGameCatalog,
} from '../src/services/integrations/catalogSanitizer';
import type { CanonicalGame } from '../src/contracts/game';
import { scanRepoForPiiViolations, scanWorkspaceRootForPollutedEntries } from './helpers/piiHygieneGuard';

const REPO_ROOT = path.resolve(__dirname, '..');

function makeTempDir(prefix = 'adv-t5-'): string {
  const tmp = path.join(
    os.tmpdir(),
    `${prefix}${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  );
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return tmp;
}

function makeCompactJwe(headerObj: Record<string, unknown> = { alg: 'RSA1_5', enc: 'A128CBC-HS256' }): string {
  const headerB64 = Buffer.from(JSON.stringify(headerObj), 'utf8').toString('base64url');
  const encKey = Buffer.from('mock_encrypted_key', 'utf8').toString('base64url');
  const iv = Buffer.from('mock_initialization_vector', 'utf8').toString('base64url');
  const cipher = Buffer.from('mock_ciphertext_data', 'utf8').toString('base64url');
  const tag = Buffer.from('mock_auth_tag', 'utf8').toString('base64url');
  return `${headerB64}.${encKey}.${iv}.${cipher}.${tag}`;
}

describe('Milestone M5 Phase 2: Tier 5 White-Box Adversarial Stress Suite (Storefronts, Supervisor & Frontend)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir('tier5-adv-');
  });

  afterEach(() => {
    emergencyResetModalOverlayLock();
    vi.restoreAllMocks();
    if (tmpDir && fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // ==========================================================================
  // Suite 1: Storefronts & Encrypted Token Vault Concurrency & Cryptographic Resilience
  // ==========================================================================
  describe('Suite 1: Token Vault Multi-Mutex Concurrency & Cryptographic Resilience', () => {
    it('1.1 multi-vault isolation: concurrent locks on distinct vault paths execute concurrently without mutual blocking', async () => {
      const dirA = path.join(tmpDir, 'vaultA');
      const dirB = path.join(tmpDir, 'vaultB');
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });
      const pathA = path.join(dirA, 'tokens.json');
      const pathB = path.join(dirB, 'tokens.json');

      const executionOrder: string[] = [];

      // Lock on vault A held for 60ms
      const taskA = tokenVault.runWithVaultMutex(pathA, async () => {
        executionOrder.push('A_start');
        await new Promise((resolve) => setTimeout(resolve, 60));
        executionOrder.push('A_end');
        return 'resA';
      });

      // Lock on vault B started immediately after A
      const taskB = tokenVault.runWithVaultMutex(pathB, async () => {
        executionOrder.push('B_start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        executionOrder.push('B_end');
        return 'resB';
      });

      const [resA, resB] = await Promise.all([taskA, taskB]);
      expect(resA).toBe('resA');
      expect(resB).toBe('resB');

      // Vault B must start and finish before Vault A finishes because they are independent paths
      expect(executionOrder.indexOf('B_start')).toBeLessThan(executionOrder.indexOf('A_end'));
      expect(executionOrder.indexOf('B_end')).toBeLessThan(executionOrder.indexOf('A_end'));
    });

    it('1.2 massive parallel async contention on single vault: 50 concurrent operations serialize with zero lost updates', async () => {
      const tokensPath = path.join(tmpDir, 'tokens.json');
      const opts = { userDataDir: tmpDir, machineIdOverride: 'adv-t5-mach' };

      // Initialize baseline token on disk first so subsequent overwrites trigger .bak creation
      await tokenVault.saveTokensAsync('init', { access_token: 'init_baseline_token' }, opts);
      expect(fs.existsSync(tokensPath)).toBe(true);

      const storefronts = ['xbox', 'steam', 'gog', 'epic', 'ea'];
      const parallelOps: Promise<void>[] = [];

      // Launch 50 concurrent saves across 5 storefronts
      for (let i = 0; i < 50; i++) {
        const store = storefronts[i % storefronts.length];
        const tokenVal = `token_v_${i}_${crypto.randomBytes(4).toString('hex')}`;
        parallelOps.push(
          tokenVault.saveTokensAsync(store, { access_token: tokenVal, iteration: i }, opts)
        );
      }

      await Promise.all(parallelOps);

      // Invalidate memory cache to force fresh disk read
      tokenVault.invalidateVaultMemoryCache(opts);

      const loaded = await tokenVault.loadSavedTokensAsync(opts);
      // All 5 storefronts must be present
      for (const store of storefronts) {
        expect(loaded[store]).toBeDefined();
        expect(typeof loaded[store]?.access_token).toBe('string');
        expect(typeof loaded[store]?.iteration).toBe('number');
      }

      // Verify .bak backup was maintained
      const bakPath = `${tokensPath}.bak`;
      expect(fs.existsSync(bakPath)).toBe(true);
      expect(fs.statSync(bakPath).size).toBeGreaterThan(0);
    });

    it('1.3 mutex lock timeout & unjamming: timed-out task rejects while subsequent queued tasks execute successfully', async () => {
      const tokensPath = path.join(tmpDir, 'tokens.json');
      const executionLog: string[] = [];

      // Task 1: hangs longer than lock timeout (timeout = 40ms)
      const hangingTask = tokenVault.runWithVaultMutex(
        tokensPath,
        async () => {
          executionLog.push('task1_start');
          await new Promise((resolve) => setTimeout(resolve, 80));
          executionLog.push('task1_end');
        },
        40
      );

      // Task 2: queued right after Task 1
      const succeedingTask = tokenVault.runWithVaultMutex(
        tokensPath,
        async () => {
          executionLog.push('task2_start');
          return 'task2_ok';
        },
        500
      );

      // Task 1 must reject with timeout
      await expect(hangingTask).rejects.toThrow(/Vault mutex lock timed out after 40ms/);

      // Task 2 must execute and resolve despite Task 1 timeout
      const res2 = await succeedingTask;
      expect(res2).toBe('task2_ok');
      expect(executionLog).toContain('task2_start');
    });

    it('1.4 acquireVaultLock handle lifecycle & async disposal ([Symbol.asyncDispose])', async () => {
      const tokensPath = path.join(tmpDir, 'tokens.json');

      // Manual acquire and release
      const handle1 = tokenVault.acquireVaultLock(tokensPath);
      await handle1.acquired;
      expect(handle1.isAcquired).toBe(true);
      expect(handle1.isReleased).toBe(false);

      handle1.release();
      expect(handle1.isReleased).toBe(true);
      // Double release is a safe no-op
      handle1.release();
      await handle1.lockPromise;

      // Async disposal support
      const handle2 = tokenVault.acquireVaultLock(tokensPath);
      await handle2.acquired;
      expect(handle2.isAcquired).toBe(true);
      await handle2[Symbol.asyncDispose]();
      expect(handle2.isReleased).toBe(true);
    });

    it('1.5 ciphertext & authentication tag tampering triggers fallback to .bak', async () => {
      const tokensPath = path.join(tmpDir, 'tokens.json');
      const opts = { userDataDir: tmpDir, machineIdOverride: 'adv-t5-tamper' };

      // Write two versions to establish primary and .bak
      await tokenVault.saveTokensAsync('epic', { access_token: 'epic_valid_v1' }, opts);
      await tokenVault.saveTokensAsync('xbox', { access_token: 'xbox_valid_v2' }, opts);

      // Primary file exists and has valid encrypted JSON envelope
      const rawContent = fs.readFileSync(tokensPath, 'utf8');
      const envelope = JSON.parse(rawContent) as Record<string, string>;

      // Tamper with ciphertext by flipping characters in the base64 payload
      const tamperedData = envelope.data.slice(0, 10) + 'AAAA' + envelope.data.slice(14);
      envelope.data = tamperedData;
      fs.writeFileSync(tokensPath, JSON.stringify(envelope));

      tokenVault.invalidateVaultMemoryCache(opts);

      // Loading should detect GCM tag mismatch and fall back to .bak seamlessly
      const recovered = await tokenVault.loadSavedTokensAsync(opts);
      expect(recovered.epic?.access_token).toBe('epic_valid_v1');
    });

    it('1.6 catastrophic dual corruption returns empty object {} safely without unhandled crashes', async () => {
      const tokensPath = path.join(tmpDir, 'tokens.json');
      const bakPath = `${tokensPath}.bak`;
      const opts = { userDataDir: tmpDir, machineIdOverride: 'adv-t5-dual-corrupt' };

      // Write non-JSON garbage to both primary and backup
      fs.writeFileSync(tokensPath, '<<TOTAL_PRIMARY_DISK_CORRUPTION_0xDEADBEEF>>');
      fs.writeFileSync(bakPath, '<<TOTAL_BACKUP_DISK_CORRUPTION_0xBAADF00D>>');

      tokenVault.invalidateVaultMemoryCache(opts);

      const recoveredAsync = await tokenVault.loadSavedTokensAsync(opts);
      expect(recoveredAsync).toEqual({});

      tokenVault.invalidateVaultMemoryCache(opts);
      const recoveredSync = tokenVault.loadSavedTokens(opts);
      expect(recoveredSync).toEqual({});
    });
  });

  // ==========================================================================
  // Suite 2: Xbox LiveSDK Desktop OAuth 2.0 & Cryptographic Proof Hardening
  // ==========================================================================
  describe('Suite 2: Xbox LiveSDK Desktop OAuth & JWE Token Normalization', () => {
    it('2.1 normalizeXblRpsTicket handles Unicode whitespace, byte-order marks, and prefix variations', () => {
      const validJwe = makeCompactJwe();

      // Full-width space (\u3000), zero-width space (\u200B), BOM (\uFEFF)
      expect(xboxAuth.normalizeXblRpsTicket(`\uFEFFd=${validJwe}`)).toBe(`t=${validJwe}`);
      expect(xboxAuth.normalizeXblRpsTicket(`\u3000t=${validJwe}\u3000`)).toBe(`t=${validJwe}`);
      expect(xboxAuth.normalizeXblRpsTicket(`\r\n\t d=${validJwe} \r\n`)).toBe(`t=${validJwe}`);

      // Bare JWE
      expect(xboxAuth.normalizeXblRpsTicket(validJwe)).toBe(`t=${validJwe}`);

      // Mixed prefix casings
      expect(xboxAuth.normalizeXblRpsTicket(`D=${validJwe}`)).toBe(`t=${validJwe}`);
      expect(xboxAuth.normalizeXblRpsTicket(`T=${validJwe}`)).toBe(`t=${validJwe}`);
    });

    it('2.2 rejects JWE candidates with prototype pollution attempts, malformed headers, or invalid encodings', () => {
      const parts = makeCompactJwe().split('.');

      // Prototype pollution header attempt
      const protoPayload = Buffer.from(
        JSON.stringify({ __proto__: { admin: true }, alg: 'RSA1_5', enc: 'A128CBC-HS256' })
      ).toString('base64url');
      const protoJwe = `${protoPayload}.${parts[1]}.${parts[2]}.${parts[3]}.${parts[4]}`;
      const normalizedProto = xboxAuth.normalizeXblRpsTicket(`d=${protoJwe}`);
      expect(normalizedProto).toBe(`t=${protoJwe}`);
      // Ensure Object prototype was not polluted
      expect((Object.prototype as Record<string, unknown>).admin).toBeUndefined();

      // Non-object JSON header (array)
      const arrayHeader = Buffer.from(JSON.stringify(['RSA1_5', 'A128CBC-HS256'])).toString('base64url');
      const arrayJwe = `${arrayHeader}.${parts[1]}.${parts[2]}.${parts[3]}.${parts[4]}`;
      expect(xboxAuth.normalizeXblRpsTicket(`d=${arrayJwe}`)).toBe(`d=${arrayJwe}`);

      // Missing alg or enc
      const noEncHeader = Buffer.from(JSON.stringify({ alg: 'RSA1_5' })).toString('base64url');
      const noEncJwe = `${noEncHeader}.${parts[1]}.${parts[2]}.${parts[3]}.${parts[4]}`;
      expect(xboxAuth.normalizeXblRpsTicket(`d=${noEncJwe}`)).toBe(`d=${noEncJwe}`);

      // Oversized header (>8192 chars)
      const hugeHeader = 'a'.repeat(8195);
      const hugeJwe = `${hugeHeader}.${parts[1]}.${parts[2]}.${parts[3]}.${parts[4]}`;
      expect(xboxAuth.normalizeXblRpsTicket(`d=${hugeJwe}`)).toBe(`d=${hugeJwe}`);
    });

    it('2.3 ephemeral ECDSA P-256 proof keypair exports conforming JWK and signs request headers', () => {
      const keyPair = xboxAuth.generateXboxProofKeyPair();
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey).toBeDefined();

      const jwk = xboxAuth.exportProofKeyJwkFromPrivateKey(keyPair.privateKey);
      expect(jwk.kty).toBe('EC');
      expect(jwk.crv).toBe('P-256');
      expect(jwk.use).toBe('sig');
      expect(typeof jwk.x).toBe('string');
      expect(typeof jwk.y).toBe('string');
      expect(jwk.x.length).toBeGreaterThanOrEqual(42);
      expect(jwk.y.length).toBeGreaterThanOrEqual(42);

      // Signature verification roundtrip with options object
      const method = 'POST';
      const pathAndQuery = '/user/authenticate';
      const body = JSON.stringify({ Properties: { AuthMethod: 'RPS' } });

      const signatureHeader = xboxAuth.signXboxRequest({
        method,
        pathAndQuery,
        body,
        ecPrivateKey: keyPair.privateKey,
      });
      expect(typeof signatureHeader).toBe('string');
      expect(signatureHeader.length).toBeGreaterThan(64);

      const isValid = xboxAuth.verifyXboxRequestSignature({
        method,
        pathAndQuery,
        body,
        signatureBase64: signatureHeader,
        ecPublicKey: keyPair.publicKey,
      });
      expect(isValid).toBe(true);

      // Verify signature tampered body is rejected
      const isTamperedValid = xboxAuth.verifyXboxRequestSignature({
        method,
        pathAndQuery,
        body: body + '_tampered',
        signatureBase64: signatureHeader,
        ecPublicKey: keyPair.publicKey,
      });
      expect(isTamperedValid).toBe(false);
    });

    it('2.4 extractAuthCodeFromInput handles duplicate code params, error descriptions, and URL fragments', () => {
      // Clean URL with code
      expect(
        xboxAuth.extractAuthCodeFromInput('https://login.live.com/oauth20_desktop.srf?code=AUTH_CODE_VALID_123')
      ).toBe('AUTH_CODE_VALID_123');

      // Duplicate code query parameters: extractAuthCodeFromInput extracts first or valid param safely
      const dupUrl = 'https://login.live.com/oauth20_desktop.srf?code=AUTH_CODE_FIRST&code=AUTH_CODE_SECOND';
      const extractedDup = xboxAuth.extractAuthCodeFromInput(dupUrl);
      expect(['AUTH_CODE_FIRST', 'AUTH_CODE_SECOND']).toContain(extractedDup);

      // URL with error
      expect(() =>
        xboxAuth.extractAuthCodeFromInput(
          'https://login.live.com/oauth20_desktop.srf?error=access_denied&error_description=The+user+canceled'
        )
      ).toThrow(/access_denied/i);

      // Raw code string
      expect(xboxAuth.extractAuthCodeFromInput('raw-code-sample-456')).toBe('raw-code-sample-456');

      // Missing code throws
      expect(() =>
        xboxAuth.extractAuthCodeFromInput('https://login.live.com/oauth20_desktop.srf?state=1234')
      ).toThrow(/authorization code/i);
    });

    it('2.5 normalizeStoreMsaTicket formats correctly for collections_bare, collections, and pcgafd targets', () => {
      const raw = 'd=sample_opaque_ticket_token';
      expect(xboxAuth.normalizeStoreMsaTicket(raw, { target: 'collections_bare' })).toBe('sample_opaque_ticket_token');
      expect(xboxAuth.normalizeStoreMsaTicket(raw, { target: 'collections' })).toBe('WLID1.0="sample_opaque_ticket_token"');
      expect(xboxAuth.normalizeStoreMsaTicket(raw, { target: 'pcgafd' })).toBe('t=sample_opaque_ticket_token');
      expect(xboxAuth.normalizeStoreMsaTicket('', { target: 'collections' })).toBe('');
    });
  });

  // ==========================================================================
  // Suite 3: MSIXVC Stream Extractor & GOG Script Security
  // ==========================================================================
  describe('Suite 3: MSIXVC Stream Extractor & GOG Script Security', () => {
    it('3.1 normalizeRelativeInstallPath blocks Win32 reserved device names, trailing dots, control chars, and traversals', () => {
      const reservedDevices = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9', 'con.txt', 'Aux.log'];
      for (const dev of reservedDevices) {
        expect(() => msixvc.normalizeRelativeInstallPath(`bin/${dev}`)).toThrow(/Win32 reserved device name/i);
        expect(() => msixvc.normalizeRelativeInstallPath(dev)).toThrow(/Win32 reserved device name/i);
      }

      // Trailing dot or space in segments
      expect(() => msixvc.normalizeRelativeInstallPath('game.exe.')).toThrow(/trailing dot or space/i);
      expect(() => msixvc.normalizeRelativeInstallPath('folder /game.exe')).toThrow(/trailing dot or space/i);

      // Path traversal
      expect(() => msixvc.normalizeRelativeInstallPath('../../etc/passwd')).toThrow(/path traversal/i);
      expect(() => msixvc.normalizeRelativeInstallPath('folder/../../../escaped')).toThrow(/path traversal/i);

      // Drive-qualified paths
      expect(() => msixvc.normalizeRelativeInstallPath('C:/Windows/System32')).toThrow(/drive-qualified/i);

      // Null bytes and ASCII control characters
      expect(() => msixvc.normalizeRelativeInstallPath('folder/\0/evil.exe')).toThrow(/invalid empty, null, or control/i);
      expect(() => msixvc.normalizeRelativeInstallPath('folder/\x01/evil.exe')).toThrow(/invalid empty, null, or control/i);

      // Valid paths strip 'files/' prefix when requested
      expect(msixvc.normalizeRelativeInstallPath('files/bin/game.exe', true)).toBe('bin/game.exe');
      expect(msixvc.normalizeRelativeInstallPath('bin/game.exe', true)).toBe('bin/game.exe');
    });

    it('3.2 resolveSafeDestinationPath strictly checks containment against install root', () => {
      const installRoot = path.join(tmpDir, 'install');
      fs.mkdirSync(installRoot, { recursive: true });

      const resolved = msixvc.resolveSafeDestinationPath(installRoot, 'game/data/asset.pak');
      expect(resolved.startsWith(installRoot)).toBe(true);
      expect(resolved).toBe(path.join(installRoot, 'game', 'data', 'asset.pak'));
    });

    it('3.3 gogScriptInterpreter selectCompatibleWin10SiblingDll & Wine registry patch batching', () => {
      const gogInstall = path.join(tmpDir, 'gog_game');
      fs.mkdirSync(gogInstall, { recursive: true });

      // Create test DLLs: winmm.dll and winmm_w10.dll
      const baseDll = path.join(gogInstall, 'winmm.dll');
      const w10Dll = path.join(gogInstall, 'winmm_w10.dll');
      fs.writeFileSync(baseDll, 'LEGACY_DLL_CONTENT');
      fs.writeFileSync(w10Dll, 'MODERN_W10_DLL_CONTENT');

      // selectCompatibleWin10SiblingDll chooses _w10 sibling
      const selected = gogScript.selectCompatibleWin10SiblingDll(baseDll);
      expect(selected).toBe(w10Dll);

      // Non-DLL inputs returned untouched
      expect(gogScript.selectCompatibleWin10SiblingDll('')).toBe('');
      expect(gogScript.selectCompatibleWin10SiblingDll('not_a_dll.txt')).toBe('not_a_dll.txt');

      // patchRawWineRegistrySectionsBatch creates WINE REGISTRY Version 2 format
      const regFile = path.join(tmpDir, 'user.reg');
      gogScript.patchRawWineRegistrySectionsBatch(regFile, [
        {
          subKeyPath: 'Software\\GOG.com\\Games\\12345',
          valueName: 'PATH',
          rawRegRhs: '"C:\\\\Games\\\\Test"',
        },
      ]);
      expect(fs.existsSync(regFile)).toBe(true);
      const regContent = fs.readFileSync(regFile, 'utf8');
      expect(regContent).toContain('WINE REGISTRY Version 2');
      expect(regContent).toContain('Software\\\\GOG.com\\\\Games\\\\12345');
    });

    it('3.4 extractEpicThirdPartyPartnerMetadata handles deep nesting and detects partner handoffs', () => {
      // Build 30-level nested manifest payload
      let nestedObj: Record<string, unknown> = {
        partner: 'EA',
        launchUri: 'origin2://game/launch?id=12345',
      };
      for (let i = 0; i < 30; i++) {
        nestedObj = { level: i, child: nestedObj };
      }

      // Should handle deep nesting without stack overflow
      const meta = epicCoordinator.extractEpicThirdPartyPartnerMetadata(nestedObj);
      expect(meta).toBeDefined();

      // Detects EA handoff namespace
      const eaPayload = {
        customAttributes: {
          ThirdPartyManagedApp: 'theeaapp',
          PartnerLinkType: 'origin',
        },
      };
      const eaMeta = epicCoordinator.extractEpicThirdPartyPartnerMetadata(eaPayload);
      expect(eaMeta).toBeDefined();
      expect(eaMeta.chainedLauncherHandoff).toBe('ea');
      expect(eaMeta.externalStorefrontHandoff).toBe('ea');

      // Null / primitive / empty inputs return empty object {} without throwing
      expect(epicCoordinator.extractEpicThirdPartyPartnerMetadata(null)).toEqual({});
      expect(epicCoordinator.extractEpicThirdPartyPartnerMetadata(undefined)).toEqual({});
      expect(epicCoordinator.extractEpicThirdPartyPartnerMetadata('string_primitive')).toEqual({});
      expect(epicCoordinator.extractEpicThirdPartyPartnerMetadata(12345)).toEqual({});
    });

    it('3.5 isPoisonedStorefrontToken & isMockOrCorruptedToken filter invalid, rotated, or mock tokens', () => {
      expect(epicCoordinator.isMockOrCorruptedToken('mock-access-token-123')).toBe(true);
      expect(epicCoordinator.isMockOrCorruptedToken('fake-token-abc')).toBe(true);
      expect(epicCoordinator.isMockOrCorruptedToken('test-refresh-token')).toBe(true);
      expect(epicCoordinator.isMockOrCorruptedToken('epic-rotated-access-token')).toBe(true);
      expect(epicCoordinator.isMockOrCorruptedToken('gog-rotated-refresh-token')).toBe(true);
      expect(epicCoordinator.isMockOrCorruptedToken('token_with_control_\x00_char')).toBe(true);
      expect(epicCoordinator.isMockOrCorruptedToken('   ')).toBe(true);

      expect(epicCoordinator.isPoisonedStorefrontToken('epic-rotated-token-123')).toBe(true);
      expect(epicCoordinator.isPoisonedStorefrontToken('gog-rotated-token-456')).toBe(true);
    });
  });

  // ==========================================================================
  // Suite 4: Process Supervisor, Security Isolation & SQLite WAL Resiliency
  // ==========================================================================
  describe('Suite 4: Process Supervisor, Security Isolation & SQLite WAL Resiliency', () => {
    it('4.1 isContainedWithinRoot verifies cross-platform path containment and normalizes casings', () => {
      // POSIX paths
      expect(securityUtils.isContainedWithinRoot('/Games', '/Games/Quake3/quake3.exe', 'darwin')).toBe(true);
      expect(securityUtils.isContainedWithinRoot('/Games', '/GamesSpecial/evil.exe', 'darwin')).toBe(false);
      expect(securityUtils.isContainedWithinRoot('/Games', '/etc/passwd', 'darwin')).toBe(false);
      expect(securityUtils.isContainedWithinRoot('/Games', '/Games/../etc/passwd', 'darwin')).toBe(false);

      // Windows paths
      expect(securityUtils.isContainedWithinRoot('C:\\Games', 'c:\\games\\doom\\doom.exe', 'win32')).toBe(true);
      expect(securityUtils.isContainedWithinRoot('C:\\Games', 'C:\\GamesSpecial\\evil.exe', 'win32')).toBe(false);
      expect(securityUtils.isContainedWithinRoot('C:\\Games', 'D:\\Games\\doom.exe', 'win32')).toBe(false);
      expect(securityUtils.isContainedWithinRoot('C:\\Games', 'C:\\Games\\..\\..\\Windows\\system32', 'win32')).toBe(false);

      // Windows UNC paths
      expect(securityUtils.isContainedWithinRoot('\\\\server\\share\\games', '\\\\server\\share\\games\\app.exe', 'win32')).toBe(true);
      expect(securityUtils.isContainedWithinRoot('\\\\server\\share1', '\\\\server\\share2\\app.exe', 'win32')).toBe(false);

      // Null byte injection in middle of path
      expect(securityUtils.isContainedWithinRoot('/Games\0/escape', '/Games/test', 'darwin')).toBe(false);
      expect(securityUtils.isContainedWithinRoot('/Games', '/Games\0/escape', 'darwin')).toBe(false);
    });

    it('4.2 isSafeToDeleteInstallPath & assertSafeGameUninstallDirectory fail-closed on system roots and shallow paths', () => {
      // System roots must fail safety checks (returns boolean false)
      expect(uninstallSafety.isSafeToDeleteInstallPath('/')).toBe(false);
      expect(uninstallSafety.isSafeToDeleteInstallPath('/System')).toBe(false);
      expect(uninstallSafety.isSafeToDeleteInstallPath('/Applications')).toBe(false);
      expect(uninstallSafety.isSafeToDeleteInstallPath('/Applications/Utilities')).toBe(false);
      expect(uninstallSafety.isSafeToDeleteInstallPath('C:\\')).toBe(false);
      expect(uninstallSafety.isSafeToDeleteInstallPath('C:\\Windows')).toBe(false);
      expect(uninstallSafety.isSafeToDeleteInstallPath('C:\\Program Files')).toBe(false);
      expect(uninstallSafety.isSafeToDeleteInstallPath('C:\\Users\\Mike')).toBe(false);

      // Shallow paths (<3 segments) must fail safety checks
      expect(uninstallSafety.isSafeToDeleteInstallPath('/opt')).toBe(false);
      expect(uninstallSafety.isSafeToDeleteInstallPath('C:\\Games')).toBe(false);

      // Volume GUID paths
      expect(uninstallSafety.isSafeToDeleteInstallPath('Volume{12345678-1234-1234-1234-123456789abc}\\Game')).toBe(false);

      // assertSafeGameUninstallDirectory throws on dangerous directories
      expect(() => uninstallSafety.assertSafeGameUninstallDirectory('/System')).toThrow(/Refusing unsafe game uninstall path/i);
      expect(() => uninstallSafety.assertSafeGameUninstallDirectory('C:\\Windows')).toThrow(/Refusing unsafe game uninstall path/i);
    });

    it('4.3 IPC sender origin auditing & wrapIpcMainWithSenderCheck gateway enforcement', () => {
      // isTrustedAppRendererUrl: packaged mode rejects localhost/http
      expect(
        securityUtils.isTrustedAppRendererUrl('http://localhost:5173', { isPackaged: true })
      ).toBe(false);

      // Packaged mode accepts expected file: URL
      expect(
        securityUtils.isTrustedAppRendererUrl(
          'file:///Applications/OneLauncher.app/Contents/Resources/app/dist/index.html',
          {
            isPackaged: true,
            expectedFileHref: 'file:///Applications/OneLauncher.app/Contents/Resources/app/dist/index.html',
          }
        )
      ).toBe(true);

      // Packaged mode rejects unexpected file: URL outside expected dir
      expect(
        securityUtils.isTrustedAppRendererUrl('file:///tmp/evil.html', {
          isPackaged: true,
          expectedFileHref: 'file:///Applications/OneLauncher.app/Contents/Resources/app/dist/index.html',
        })
      ).toBe(false);

      // Unpackaged mode rejects spoofed hostnames
      expect(securityUtils.isTrustedAppRendererUrl('http://evil-localhost.com:5173', { isPackaged: false })).toBe(false);
      expect(securityUtils.isTrustedAppRendererUrl('http://attacker.com:5173', { isPackaged: false })).toBe(false);

      // isTrustedIpcSenderEvent rejects subframes (iframe attacks)
      const mockIframeEvent = {
        senderFrame: { parent: {}, routingId: 10, url: 'file:///app/index.html' },
        sender: { mainFrame: { routingId: 1 } },
      };
      expect(securityUtils.isTrustedIpcSenderEvent(mockIframeEvent)).toBe(false);

      // assertTrustedIpcSender throws ERR_UNTRUSTED_IPC_SENDER on subframe event
      expect(() => securityUtils.assertTrustedIpcSender(mockIframeEvent)).toThrowError();
      try {
        securityUtils.assertTrustedIpcSender(mockIframeEvent);
      } catch (err: unknown) {
        expect((err as { code?: string }).code).toBe('ERR_UNTRUSTED_IPC_SENDER');
      }

      // wrapIpcMainWithSenderCheck intercepts calls
      let handlerExecuted = false;
      const mockIpcMain = {
        handle: vi.fn((channel: string, listener: (evt: unknown, ...args: unknown[]) => unknown) => {
          // Attempt to invoke with untrusted iframe event
          listener(mockIframeEvent);
        }),
      };
      const wrapped = securityUtils.wrapIpcMainWithSenderCheck(mockIpcMain);
      expect(() => {
        wrapped.handle('test-channel', () => {
          handlerExecuted = true;
        });
      }).toThrowError();
      expect(handlerExecuted).toBe(false);
    });

    it('4.4 buildSafeChildEnvironment strips all 15 dangerous loader/linker variables and prototype pollution', () => {
      const dangerousKeys = [
        'LD_PRELOAD',
        'LD_LIBRARY_PATH',
        'LD_AUDIT',
        'DYLD_INSERT_LIBRARIES',
        'DYLD_LIBRARY_PATH',
        'DYLD_FRAMEWORK_PATH',
        'DYLD_FALLBACK_LIBRARY_PATH',
        'DYLD_FORCE_FLAT_NAMESPACE',
        'NODE_OPTIONS',
        'ELECTRON_RUN_AS_NODE',
        'PYTHONHOME',
        'PYTHONPATH',
        'PYTHONSTARTUP',
        'BASH_ENV',
        'CX_ENV',
      ];

      const ambient: Record<string, string> = {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        USER: 'gamer',
      };
      for (const k of dangerousKeys) {
        ambient[k] = '/opt/malicious/lib.dylib';
        ambient[k.toLowerCase()] = '/opt/malicious/lib_lower.dylib';
      }

      const safeEnv = securityUtils.buildSafeChildEnvironment(ambient, {});
      const survivingKeys = Object.keys(safeEnv).map((k) => k.toUpperCase());
      for (const k of dangerousKeys) {
        expect(survivingKeys).not.toContain(k);
      }
      expect(safeEnv.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
      expect(safeEnv.USER).toBe('gamer');
    });

    it('4.5 offline SQLite WAL compression and corrupted data handling', () => {
      // compressVaultJson & decompressVaultJsonString transparent round-trip for large JSON
      const largePayload = {
        gameId: 'steam-1091500',
        summary: 'Cyberpunk 2077 open world adventure RPG '.repeat(20),
        reviews: Array.from({ length: 50 }, (_, i) => ({ id: i, score: 95, text: 'Masterpiece' })),
      };

      const compressed = offlineVault.compressVaultJson(largePayload);
      expect(typeof compressed).toBe('string');
      expect(compressed.startsWith(offlineVault.VAULT_ZLIB_PREFIX)).toBe(true);

      const decompressed = offlineVault.decompressVaultJsonString(compressed);
      expect(decompressed).toBeDefined();
      const parsed = offlineVault.parseVaultJson(compressed);
      expect(parsed).toEqual(largePayload);

      // Corrupted compressed base64 returns null gracefully without throwing
      const corruptZlib = `${offlineVault.VAULT_ZLIB_PREFIX}NOT_VALID_BASE64_GARBAGE!@#$%`;
      expect(offlineVault.decompressVaultJsonString(corruptZlib)).toBeNull();
      expect(offlineVault.parseVaultJson(corruptZlib)).toBeNull();

      // Plain uncompressed strings pass through untouched
      const plainStr = 'plain_uncompressed_sample_text';
      expect(offlineVault.decompressVaultJsonString(plainStr)).toBe(plainStr);

      // OfflineVaultService instance test
      const vaultSvc = new offlineVault.OfflineVaultService({ userDataDir: tmpDir });
      vaultSvc.init();
      expect(vaultSvc.db).toBeDefined();

      vaultSvc.recordP1DetailGame('test-game-123');
      expect(vaultSvc.isP1DetailGame('test-game-123')).toBe(true);

      vaultSvc.shutdown();
    });
  });

  // ==========================================================================
  // Suite 5: React 19 Frontend Resilience, Error Boundaries & Virtual Grid
  // ==========================================================================
  describe('Suite 5: React 19 Frontend Resilience, Error Boundaries & Virtual Grid', () => {
    it('5.1 high-velocity scroll debouncing queues mounts and flushes cleanly on calm', async () => {
      let callbackFired = false;
      const onMount = () => {
        callbackFired = true;
      };

      // Ensure window is defined for scroll tracker
      const originalWindow = globalThis.window;
      if (typeof globalThis.window === 'undefined') {
        (globalThis as unknown as Record<string, unknown>).window = {};
      }

      try {
        // High velocity scroll step (>300px)
        recordScrollActivity(500, 'main-grid');
        expect(isCurrentlyFastScrolling()).toBe(true);

        addPendingFastScrollMount(onMount);
        expect(callbackFired).toBe(false);

        // Notify image unmounted debounces
        notifyImageUnmounted();

        // Wait for 150ms (>120ms calm threshold)
        await new Promise((resolve) => setTimeout(resolve, 150));

        expect(callbackFired).toBe(true);
        expect(isCurrentlyFastScrolling()).toBe(false);
      } finally {
        (globalThis as unknown as Record<string, unknown>).window = originalWindow;
      }
    });

    it('5.2 AppErrorBoundary normalizes primitive throws and handles modal overlay cleanup', () => {
      // Raw string throw
      const stateStr = AppErrorBoundary.getDerivedStateFromError('UNCAUGHT_STORAGE_FAILURE');
      expect(stateStr.hasError).toBe(true);
      expect(stateStr.error?.message).toContain('UNCAUGHT_STORAGE_FAILURE');

      // Null throw
      const stateNull = AppErrorBoundary.getDerivedStateFromError(null);
      expect(stateNull.hasError).toBe(true);
      expect(stateNull.error?.message).toBe('Unknown application error');

      // Numeric throw
      const stateNum = AppErrorBoundary.getDerivedStateFromError(500);
      expect(stateNum.hasError).toBe(true);
      expect(stateNum.error?.message).toBe('500');

      // Error instance
      const customErr = new Error('Database locked');
      const stateErr = AppErrorBoundary.getDerivedStateFromError(customErr);
      expect(stateErr.hasError).toBe(true);
      expect(stateErr.error).toBe(customErr);
    });

    it('5.3 emergencyResetModalOverlayLock clears locks and checkModalOverlaySelfHealing heals DOM', () => {
      const originalDoc = globalThis.document;
      let mockOpenDialogs: unknown[] = [{}];

      // Synthetic DOM document with open dialog initially
      (globalThis as unknown as Record<string, unknown>).document = {
        querySelectorAll: () => mockOpenDialogs,
        documentElement: { removeAttribute: vi.fn() },
        getElementById: vi.fn(),
      };

      try {
        // Simulate active modal locks while dialog is open in DOM
        acquireModalOverlayLock();
        expect(isModalOverlayOpen()).toBe(true);

        // Simulate dialog unmounting / crashing: zero open dialogs remain in DOM
        mockOpenDialogs = [];

        // Self-healing: with zero open dialogs, checkModalOverlaySelfHealing automatically detects leak and resets locks
        const healed = checkModalOverlaySelfHealing();
        expect(healed).toBe(false);
        expect(isModalOverlayOpen()).toBe(false);

        // Direct emergency reset test
        mockOpenDialogs = [{}];
        acquireModalOverlayLock();
        emergencyResetModalOverlayLock();
        expect(isModalOverlayOpen()).toBe(false);
      } finally {
        (globalThis as unknown as Record<string, unknown>).document = originalDoc;
      }
    });

    it('5.4 universal zero-PII invariant: KNOWN_GAME_PATCHES is empty and repo contains zero personal paths', () => {
      expect(KNOWN_GAME_PATCHES).toEqual({});
      expect(Object.keys(KNOWN_GAME_PATCHES)).toHaveLength(0);

      // Arbitrary unfamiliar game resolves without hardcoded lore
      const arbitraryGame: CanonicalGame = {
        id: 'synthetic-void-game',
        title: 'Project Andromeda 3000',
        sortTitle: 'Project Andromeda 3000',
        headerImage: 'https://cdn.example.invalid/header.jpg',
        capsuleImage: 'https://cdn.example.invalid/capsule.jpg',
        platforms: [{ platformId: 'steam', platformGameId: '1234567', installed: false }],
        developers: ['Synthetic Corp'],
        publishers: ['Synthetic Distro'],
        genres: ['Strategy'],
        tags: ['Space'],
      };

      const sanitized = sanitizeGameCatalog([arbitraryGame], {
        validSteamAppIds: new Set([1234567]),
        validSteamTitles: new Set(['Project Andromeda 3000']),
      });
      expect(sanitized).toHaveLength(1);
      expect(sanitized[0].id).toBe('synthetic-void-game');

      // PII scan of targets
      const scanTargets = [
        'electron',
        'src',
        'build',
        'public',
        'scripts',
        'tests',
        'package.json',
      ];
      const extRegex = /\.(?:cjs|mjs|js|ts|tsx|json|html|css|md|nsh|nsi|ps1|bat|py|c|h)$/i;
      const violations = scanRepoForPiiViolations(REPO_ROOT, scanTargets, extRegex);
      expect(violations).toEqual([]);

      const rootPollution = scanWorkspaceRootForPollutedEntries(REPO_ROOT);
      expect(rootPollution).toEqual([]);
    });
  });
});
