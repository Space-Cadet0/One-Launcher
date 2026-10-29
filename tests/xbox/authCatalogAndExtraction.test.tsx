import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import axios from 'axios';

import {
  saveIntegrations,
  saveXboxProfileState,
  loadXboxProfileState,
  mergeStorefrontGames,
  mergeUpdatedGamePreservingLivePlatformState,
  loadCurrentCatalog,
  compactGameForStorage,
  reconcileCatalogGamesWithInstalledRecords,
} from '../../src/services/integrations/integrationStorage';
import { sanitizeGameCatalog } from '../../src/services/integrations/catalogSanitizer';
import {
  stripStorefrontPlatformDisambiguators,
  stripYearEditionPhrases,
  normalizeTitleKey,
  splitCamelCaseTitle,
  alignCompoundWordTokens,
  extractSequelIdentifier,
  isSequelMismatch,
  sanitizeStoreReleaseDate,
} from '../../src/services/common/titleUtils';
import {
  computeEntityMatchConfidence,
  parseReleaseYear,
} from '../../src/services/common/entityResolver';
import {
  SteamMatcherService,
  computeTitleSimilarity,
} from '../../src/services/steam/steamMatcher';
import {
  SteamApiService,
  steamApi,
  truncateHtmlSafely,
} from '../../src/services/steam/steamApi';
import { steamAchievementsService } from '../../src/services/steam/steamAchievementsService';
import { fallbackMetadataProvider } from '../../src/services/steam/fallbackMetadataProvider';
import { requestScheduler } from '../../src/services/network/requestScheduler';
import { onlineLifecycleManager } from '../../src/services/network/onlineLifecycleManager';
import {
  pickBestEnrichedMetadata,
  pickPreferredCapsuleImage,
  pickPreferredDetailedDescription,
} from '../../src/services/storage/librarySync';
import * as indexedDbVault from '../../src/services/storage/indexedDbVault';
import { getStorefrontNativeOsFlags } from '../../src/services/platform/nativeOsService';
import { reconcileCatalogTrophiesRecords } from '../../src/utils/catalogMergeUtils';
import { resolveEffectiveLaunchPolicy as resolveTsLaunchPolicy } from '../../src/contracts/launchPolicyResolver';
import { LauncherService, launcherService } from '../../src/services/launcher/launcherService';
import { achievementDetailService } from '../../src/services/achievements/achievementDetailService';
import { StorefrontIcon } from '../../src/components/Common/StorefrontIcon';
import { DownloadManagerDrawer } from '../../src/components/Launcher/DownloadManagerDrawer';
import { IntegrationsModal } from '../../src/components/Navigation/IntegrationsModal';
import { GameAchievementsModal } from '../../src/components/Achievements/GameAchievementsModal';
import { GameInstallModal } from '../../src/components/Launcher/GameInstallModal';
import { LibraryGridView } from '../../src/components/Library/LibraryGridView';
import { LibrarySidebar } from '../../src/components/Library/LibrarySidebar';
import { PlatformBadges } from '../../src/components/SteamStoreDetail/PlatformBadges';
import { SteamLibraryActionBar } from '../../src/components/SteamStoreDetail/SteamLibraryActionBar';
import { SteamStorePage } from '../../src/components/SteamStoreDetail/SteamStorePage';
import { buildLibraryFilterIndex } from '../../src/services/filter/libraryFilterIndex';
import { criticScoreService } from '../../src/services/critic/criticScoreService';
import {
  saveStagedCache,
  loadStagedCache,
  STAGED_CACHE_VERSION,
} from '../../src/services/storage/stagedCacheService';
import type { CanonicalGame } from '../../src/contracts/game';
import type { StorefrontIntegration } from '../../src/contracts/integration';
import type { SteamEnrichedMetadata } from '../../src/contracts/steam';

import {
  nodeRequire,
  xboxAuthManager,
  xboxBoringSslCrypto,
  xboxDeviceClep,
  xboxCatalogAndGamePass,
  xboxAchievementsAndStats,
  msixvcXvdParser,
  msixvcStreamExtractor,
  xboxRuntimeLoopbackServer,
  xboxTitleStorageSync,
  tokenVault,
  binaryAndManifestInspectors,
  cjsLaunchPolicyResolver,
  uninstallSafety,
  cloudSaveEngine,
  wineAndCrossOverManager,
  offlineVaultMod,
  federatorMod,
  launcherEngine,
  buildXboxBridge,
  setDomPurifyFragmentBuilder,
  getDomPurifyFragmentBuilder,
  sanitizeHtmlStringViaDomParser,
  createMemoryStorage,
  makeCanonicalGameFixture,
  buildValidMinimalPe64Buffer,
  buildSyntheticSpLicenseBlockBase64,
  buildSyntheticSegmentMetadata,
  buildSyntheticUserData,
  buildSyntheticMsixvcImage,
  buildDisplayCatalogGameFixture,
  findElements,
  getTextContent,
  expandFunctionVNodes,
  createComponentHarness,
  flushMicrotasks,
  sendLoopbackRpc,
  Domain12TextNode,
  Domain12DocumentFragment,
  Domain12HTMLElement,
  buildDomain12FragmentFromHtml,
  createDomain12DeepRenderer,
  buildValidJpegBuffer,
  buildSyntheticAnimatedGif89aBuffer,
  makeMockFetchBinaryResponse,
  type SyntheticSegmentFile,
  type SyntheticMsixvcOptions,
} from '../helpers/xboxTestHarness';

vi.mock('dompurify', () => ({
  default: {
    sanitize: (html: string, cfg?: { RETURN_DOM_FRAGMENT?: boolean }) => {
      const builder = getDomPurifyFragmentBuilder();
      if (cfg?.RETURN_DOM_FRAGMENT && builder) {
        return builder(String(html || ''));
      }
      return sanitizeHtmlStringViaDomParser(String(html || ''));
    },
  },
}));

// ===========================================================================
// 1. Dual-Plane Auth, ProofKey Request Signing, CLEP & Token Vault Redaction
// ===========================================================================

describe('1. Xbox Dual-Plane Auth, ProofKey Signing, CLEP Crypto & Token Redaction', () => {
  let origLocalStorage: any;
  let origWindow: any;

  beforeEach(() => {
    origLocalStorage = (globalThis as any).localStorage;
    origWindow = (globalThis as any).window;
    const mem = createMemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: mem,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: { localStorage: mem },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: origLocalStorage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: origWindow,
      configurable: true,
      writable: true,
    });
  });

  it('detects 5-segment Compact JWEs and normalizes Microsoft Store MSA tickets across licensing vs PCGAFD', () => {
    const headerB64 = Buffer.from(
      JSON.stringify({ alg: 'RSA-OAEP', enc: 'A256GCM' }),
      'utf8'
    ).toString('base64url');
    const compactJwe = `${headerB64}.YWJjZA.MTIzNDU2Nzg5MDEy.Y2lwaGVydGV4dA.dGFnMTIzNDU`;

    expect(xboxAuthManager.isCompactJwe(compactJwe)).toBe(true);
    expect(xboxAuthManager.isCompactJwe('t=EwB4Aq1BAAAU7opaque_compact_ticket')).toBe(false);
    expect(xboxAuthManager.isCompactJwe('a.b.c.d.e')).toBe(false);

    // Licensing target strips d=/t= on 5-dot Compact JWEs, prefixes t= on opaque tickets
    expect(
      xboxAuthManager.normalizeStoreMsaTicket(`d=${compactJwe}`, { target: 'licensing' })
    ).toBe(compactJwe);
    expect(
      xboxAuthManager.normalizeStoreMsaTicket('d=EwB4Aq1BAAAU7opaque', { target: 'licensing' })
    ).toBe('t=EwB4Aq1BAAAU7opaque');

    // PCGAFD / Store target always normalizes to t=<bare>
    expect(
      xboxAuthManager.normalizeStoreMsaTicket(`d=${compactJwe}`, { target: 'pcgafd' })
    ).toBe(`t=${compactJwe}`);
  });

  it('normalizes Xbox Live RPS tickets without ever double-prefixing t= or d=', () => {
    expect(xboxAuthManager.normalizeXblRpsTicket('t=EwB4Aq1BAAA')).toBe('t=EwB4Aq1BAAA');
    expect(xboxAuthManager.normalizeXblRpsTicket('d=EwB4Aq1BAAA')).toBe('d=EwB4Aq1BAAA');
    expect(xboxAuthManager.normalizeXblRpsTicket('EwB4Aq1BAAA')).toBe('t=EwB4Aq1BAAA');
    expect(
      xboxAuthManager.normalizeXblRpsTicket('EwB4Aq1BAAA', { defaultPrefix: 'd=' })
    ).toBe('d=EwB4Aq1BAAA');
  });

  it('generates P-256 ProofKey JWK and produces verifiable 76-byte IEEE P1363 Signature headers', () => {
    const kp = xboxAuthManager.generateXboxProofKeyPair();
    expect(kp.proofKeyJwk.kty).toBe('EC');
    expect(kp.proofKeyJwk.crv).toBe('P-256');
    expect(kp.proofKeyJwk.alg).toBe('ES256');
    expect(typeof kp.proofKeyJwk.x).toBe('string');
    expect(typeof kp.proofKeyJwk.y).toBe('string');

    const fixedTs = Date.UTC(2026, 9, 26, 12, 0, 0);
    const body = JSON.stringify({ RelyingParty: 'http://xboxlive.com', TokenType: 'JWT' });
    const sigB64 = xboxAuthManager.signXboxRequest({
      method: 'POST',
      url: 'https://sisu.xboxlive.com/authorize?flow=test',
      authorizationHeader: 'XBL3.0 x=2533274790395904;eyJ0eXAiOiJKV1QifQ',
      bodyBuffer: body,
      ecPrivateKey: kp.privateKeyPem,
      timestampMs: fixedTs,
    });

    const sigBytes = Buffer.from(sigB64, 'base64');
    expect(sigBytes.length).toBe(76);
    expect(sigBytes.readUInt32BE(0)).toBe(1);

    const expectedTicks = (BigInt(fixedTs) + 11644473600000n) * 10000n;
    expect(sigBytes.readBigUInt64BE(4)).toBe(expectedTicks);

    const verified = xboxAuthManager.verifyXboxRequestSignature({
      signatureBase64: sigB64,
      method: 'POST',
      url: 'https://sisu.xboxlive.com/authorize?flow=test',
      authorizationHeader: 'XBL3.0 x=2533274790395904;eyJ0eXAiOiJKV1QifQ',
      bodyBuffer: body,
      ecPublicKey: kp.publicKeyPem,
    });
    expect(verified).toBe(true);

    const tampered = xboxAuthManager.verifyXboxRequestSignature({
      signatureBase64: sigB64,
      method: 'POST',
      url: 'https://sisu.xboxlive.com/authorize?flow=tampered',
      authorizationHeader: 'XBL3.0 x=2533274790395904;eyJ0eXAiOiJKV1QifQ',
      bodyBuffer: body,
      ecPublicKey: kp.publicKeyPem,
    });
    expect(tampered).toBe(false);
  });

  it('maps XSTS error codes (2148916233, 2148916238, 2148916227) and extracts dot-containing Microsoft OAuth codes', () => {
    const noProfile = xboxAuthManager.mapXboxXstsError({ XErr: 2148916233 }, 401);
    expect(noProfile.xerr).toBe(2148916233);
    expect(noProfile.code).toBe('XBOX_PROFILE_MISSING');
    expect(noProfile.message.toLowerCase()).toContain('gamertag');

    const childAcct = xboxAuthManager.mapXboxXstsError({ XErr: 2148916238 }, 401);
    expect(childAcct.xerr).toBe(2148916238);
    expect(childAcct.code).toBe('XBOX_CHILD_FAMILY_CONSENT_REQUIRED');
    expect(childAcct.message.toLowerCase()).toContain('family');

    const banned = xboxAuthManager.mapXboxXstsError({ XErr: 2148916227 }, 401);
    expect(banned.xerr).toBe(2148916227);
    expect(banned.code).toBe('XBOX_ACCOUNT_BANNED');
    expect(banned.message.toLowerCase()).toContain('suspension');

    const dotCode = 'M.C507_BAY.2.U.a1b2c3d4-e5f6-7890-abcd-ef0123456789';
    expect(xboxAuthManager.extractAuthCodeFromInput(dotCode)).toBe(dotCode);
    expect(
      xboxAuthManager.extractAuthCodeFromInput(
        `https://login.live.com/oauth20_desktop.srf?code=${encodeURIComponent(dotCode)}&lc=1033`
      )
    ).toBe(dotCode);
  });

  it('executes invertible 2048-byte CLEP Feistel obfuscation and matches NIST SP 800-38B / RFC 4493 AES-128-CMAC vectors', () => {
    const original = Buffer.alloc(2048);
    for (let i = 0; i < original.length; i += 1) {
      original[i] = (i * 37 + 19) & 0xff;
    }

    const obfuscated = xboxDeviceClep.clepObfuscate(original);
    expect(obfuscated.equals(original)).toBe(false);

    const restored = xboxDeviceClep.clepDeobfuscate(obfuscated);
    expect(restored.equals(original)).toBe(true);

    // RFC 4493 / NIST SP 800-38B official AES-128-CMAC test vectors
    const rfcKey = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
    expect(xboxDeviceClep.aes128Cmac(rfcKey, Buffer.alloc(0)).toString('hex')).toBe(
      'bb1d6929e95937287fa37d129b756746'
    );
    const msg16 = Buffer.from('6bc1bee22e409f96e93d7e117393172a', 'hex');
    expect(xboxDeviceClep.aes128Cmac(rfcKey, msg16).toString('hex')).toBe(
      '070a16b46b4d4144f79bdd9dd04a287c'
    );
  });

  it('round-trips RFC 3394 40-byte wrapped Content Integrity Keys (CIK) via xboxDeviceClep', () => {
    const rawCik32 = crypto.randomBytes(32);
    const deviceKey16 = crypto.randomBytes(16);

    const wrapped40 = xboxDeviceClep.wrapContentCik(rawCik32, deviceKey16);
    expect(wrapped40.length).toBe(40);

    const unwrapped32 = xboxDeviceClep.unwrapContentCik(wrapped40, deviceKey16);
    expect(unwrapped32.equals(rawCik32)).toBe(true);
  });

  it('redacts secrets in tokenVault.projectRedactedXboxSummary and strips token fields in saveIntegrations', () => {
    const rawVaultEntry = {
      gamertag: 'PlayerOne',
      modernGamertag: 'PlayerOne#1001',
      xuid: '2533274790395904',
      gamerscore: 14250,
      syncMode: 'owned_and_played',
      msaRefreshToken: 'M.SECRET_REFRESH_TOKEN_DO_NOT_LEAK',
      xstsXboxLiveToken: 'SECRET_XSTS_JWT_DO_NOT_LEAK',
      proofPrivateKeyPem: '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----',
      deviceContext: { deviceKeyHex: '00112233445566778899aabbccddeeff' },
      subscription: {
        hasActiveSubscription: true,
        hasPcCatalogAccess: true,
        tierId: 'pc',
        tierDisplayName: 'PC Game Pass',
      },
    };

    const redacted = tokenVault.projectRedactedXboxSummary(rawVaultEntry);
    expect(redacted.connected).toBe(true);
    expect(redacted.modernGamertag).toBe('PlayerOne#1001');
    expect(redacted.gamerscore).toBe(14250);
    expect(redacted.hasDeviceContext).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain('SECRET_REFRESH_TOKEN');
    expect(JSON.stringify(redacted)).not.toContain('SECRET_XSTS_JWT');
    expect(JSON.stringify(redacted)).not.toContain('BEGIN PRIVATE KEY');
    expect(JSON.stringify(redacted)).not.toContain('00112233445566778899aabbccddeeff');

    const integrations: StorefrontIntegration[] = [
      {
        storefrontId: 'xbox',
        name: 'Xbox',
        isConnected: true,
        accountName: 'PlayerOne#1001',
        accountId: '2533274790395904',
        gamesCount: 4,
        authMethod: 'oauth',
        credentials: {
          ...({
            access_token: 'LEAKED_ACCESS',
            refresh_token: 'LEAKED_REFRESH',
            xstsToken: 'LEAKED_XSTS',
            userHash: 'LEAKED_UHASH',
            webToken: 'LEAKED_WEBTOKEN',
          } as Record<string, string>),
        },
      },
    ];

    saveIntegrations(integrations);
    const persistedRaw = globalThis.localStorage.getItem('antigravity_storefront_integrations') || '';
    expect(persistedRaw).toContain('PlayerOne#1001');
    expect(persistedRaw).not.toContain('LEAKED_ACCESS');
    expect(persistedRaw).not.toContain('LEAKED_REFRESH');
    expect(persistedRaw).not.toContain('LEAKED_XSTS');
    expect(persistedRaw).not.toContain('LEAKED_UHASH');
  });
});

// ===========================================================================
// 2. Entitlements, 2025/2026 Game Pass Tiers, 5-Gate Filter & Active-Access
// ===========================================================================

describe('2. Xbox Entitlements, 2025/2026 Game Pass Tiers, 5-Gate Filter & Active-Access Gate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-xbox-cat-test-'));
  });

  afterEach(() => {
    xboxCatalogAndGamePass.closeXboxCatalogCacheStore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('classifies 2025/2026 Game Pass subscription SKUs (Ultimate, PC, Premium, Essential, Console-only, expired)', () => {
    const nowMs = Date.UTC(2026, 9, 26, 0, 0, 0);

    const ultimate = xboxCatalogAndGamePass.classifySubscriptionRecords(
      [{ productId: 'CFQ7TTC0KHS0', status: 'Active', endDate: '2027-01-15T00:00:00Z', autoRenew: true }],
      nowMs
    );
    expect(ultimate.tierId).toBe('ultimate');
    expect(ultimate.hasPcCatalogAccess).toBe(true);
    expect(ultimate.includesEaPlayPc).toBe(true);

    const pcPass = xboxCatalogAndGamePass.classifySubscriptionRecords(
      [{ productId: 'CFQ7TTC0KGQ8', status: 'Active', endDate: '2027-01-15T00:00:00Z' }],
      nowMs
    );
    expect(pcPass.tierId).toBe('pc');
    expect(pcPass.hasPcCatalogAccess).toBe(true);

    const premium = xboxCatalogAndGamePass.classifySubscriptionRecords(
      [{ productId: 'CFQ7TTC0P85B', status: 'Active', endDate: '2027-01-15T00:00:00Z' }],
      nowMs
    );
    expect(premium.tierId).toBe('premium');
    expect(premium.hasPcCatalogAccess).toBe(true);
    expect(premium.siglMode).toBe('premium_pc_intersection');

    const essential = xboxCatalogAndGamePass.classifySubscriptionRecords(
      [{ productId: 'CFQ7TTC0K5DJ', status: 'Active', endDate: '2027-01-15T00:00:00Z' }],
      nowMs
    );
    expect(essential.tierId).toBe('essential');
    expect(essential.hasPcCatalogAccess).toBe(true);
    expect(essential.siglMode).toBe('essential_pc');

    const consoleOnly = xboxCatalogAndGamePass.classifySubscriptionRecords(
      [{ productId: 'CFQ7TTC0K6L8', status: 'Active', endDate: '2027-01-15T00:00:00Z' }],
      nowMs
    );
    expect(consoleOnly.hasActiveSubscription).toBe(true);
    expect(consoleOnly.hasPcCatalogAccess).toBe(false);

    const expired = xboxCatalogAndGamePass.classifySubscriptionRecords(
      [{ productId: 'CFQ7TTC0KHS0', status: 'Active', endDate: '2025-01-01T00:00:00Z' }],
      nowMs
    );
    expect(expired.hasActiveSubscription).toBe(false);
    expect(expired.hasPcCatalogAccess).toBe(false);
  });

  it('enforces Strict Active-Access Gate across owned_and_played, full_pc_game_pass, and owned_only modes', () => {
    const activePcSub = { hasActiveSubscription: true, hasPcCatalogAccess: true };
    const consoleOnlySub = { hasActiveSubscription: true, hasPcCatalogAccess: false };

    // TitleHub history with console-only or expired subscription MUST NOT admit uninstalled game
    expect(
      xboxCatalogAndGamePass.evaluateXboxActiveAccessGate({
        syncMode: 'owned_and_played',
        isOwnedPermanent: false,
        subscription: consoleOnlySub,
        inActiveTierPcSigl: true,
        isPlayedInTitleHub: true,
        isInstalledLocally: false,
      }).admit
    ).toBe(false);

    // TitleHub history for a game rotated OUT of active SIGL MUST NOT admit uninstalled game
    expect(
      xboxCatalogAndGamePass.evaluateXboxActiveAccessGate({
        syncMode: 'owned_and_played',
        isOwnedPermanent: false,
        subscription: activePcSub,
        inActiveTierPcSigl: false,
        isPlayedInTitleHub: true,
        isInstalledLocally: false,
      }).admit
    ).toBe(false);

    // Active PC sub + in live PC SIGL + played in TitleHub -> admitted in owned_and_played
    const playedActive = xboxCatalogAndGamePass.evaluateXboxActiveAccessGate({
      syncMode: 'owned_and_played',
      isOwnedPermanent: false,
      subscription: activePcSub,
      inActiveTierPcSigl: true,
      isPlayedInTitleHub: true,
      isInstalledLocally: false,
    });
    expect(playedActive.admit).toBe(true);
    expect(playedActive.ownershipType).toBe('subscription');
    expect(playedActive.subscriptionExpired).toBe(false);

    // Unplayed Game Pass title -> excluded in owned_and_played, admitted in full_pc_game_pass, excluded in owned_only
    expect(
      xboxCatalogAndGamePass.evaluateXboxActiveAccessGate({
        syncMode: 'owned_and_played',
        isOwnedPermanent: false,
        subscription: activePcSub,
        inActiveTierPcSigl: true,
        isPlayedInTitleHub: false,
        isInstalledLocally: false,
      }).admit
    ).toBe(false);

    expect(
      xboxCatalogAndGamePass.evaluateXboxActiveAccessGate({
        syncMode: 'full_pc_game_pass',
        isOwnedPermanent: false,
        subscription: activePcSub,
        inActiveTierPcSigl: true,
        isPlayedInTitleHub: false,
        isInstalledLocally: false,
      }).admit
    ).toBe(true);

    expect(
      xboxCatalogAndGamePass.evaluateXboxActiveAccessGate({
        syncMode: 'owned_only',
        isOwnedPermanent: false,
        subscription: activePcSub,
        inActiveTierPcSigl: true,
        isPlayedInTitleHub: true,
        isInstalledLocally: true,
      }).admit
    ).toBe(false);

    // Locally installed rotated-out Game Pass title -> retained with subscriptionExpired: true
    const localLapsed = xboxCatalogAndGamePass.evaluateXboxActiveAccessGate({
      syncMode: 'owned_and_played',
      isOwnedPermanent: false,
      subscription: activePcSub,
      inActiveTierPcSigl: false,
      isPlayedInTitleHub: true,
      isInstalledLocally: true,
    });
    expect(localLapsed.admit).toBe(true);
    expect(localLapsed.subscriptionExpired).toBe(true);
  });

  it('enforces the 5-Gate DisplayCatalog filter (ProductKind, Console XVC/Xap rejection, 3rd-party PFN handoff, BundledSkus, non-game DLC/soundtrack)', () => {
    // Gate 1: Non-game ProductKind
    const durable = xboxCatalogAndGamePass.evaluateDisplayCatalogProduct(
      buildDisplayCatalogGameFixture({ productKind: 'Durable', title: 'Expansion Pass' })
    );
    expect(durable.eligible).toBe(false);
    expect(durable.gate).toBe('gate1_product_kind');

    // Gate 2: Console-only Windows.Xbox / XVC rejected
    const consoleXvc = xboxCatalogAndGamePass.evaluateDisplayCatalogProduct(
      buildDisplayCatalogGameFixture({
        packageFormat: 'XVC',
        platformName: 'Windows.Xbox',
        title: 'Console Exclusive Showcase',
      })
    );
    expect(consoleXvc.eligible).toBe(false);
    expect(consoleXvc.gate).toBe('gate2_console_only');

    // Gate 3: 3rd-party PFN publisher suffix detects handoff
    const ubiStub = xboxCatalogAndGamePass.evaluateDisplayCatalogProduct(
      buildDisplayCatalogGameFixture({
        includePackages: false,
        pfn: 'Ubisoft.SampleTacticalGame_ngz4m417e0mpw',
        publisherName: 'Ubisoft',
      })
    );
    expect(ubiStub.eligible).toBe(true);
    expect(ubiStub.externalStorefrontHandoff).toBe('ubisoft');

    // Gate 4: Bundle wrapper expands BundledSkus
    const bundleWrapper = xboxCatalogAndGamePass.evaluateDisplayCatalogProduct(
      buildDisplayCatalogGameFixture({
        productId: '9NBUNDLEWR01',
        includePackages: false,
        pfn: '',
        bundledSkus: [{ BigId: '9NTESTGAME01', SkuId: '0010', IsPrimary: true }],
      })
    );
    expect(bundleWrapper.eligible).toBe(false);
    expect(bundleWrapper.isBundleWrapper).toBe(true);
    expect(bundleWrapper.bundledSkus[0].bigId).toBe('9NTESTGAME01');

    // Gate 5: Non-game soundtrack / artbook suppressed
    const soundtrack = xboxCatalogAndGamePass.evaluateDisplayCatalogProduct(
      buildDisplayCatalogGameFixture({
        title: 'Synthetic Horizon Original Soundtrack',
      })
    );
    expect(soundtrack.eligible).toBe(false);
    expect(soundtrack.gate).toBe('gate5_non_game_classifier');
  });

  it('expands Minecraft Java & Bedrock bundle (9NXP44L49SHJ) and flags 9PJ8266BHFWN as native macOS + Windows + Linux', () => {
    const mcJavaEval = xboxCatalogAndGamePass.evaluateDisplayCatalogProduct(
      buildDisplayCatalogGameFixture({
        productId: '9PJ8266BHFWN',
        title: 'Minecraft: Java Edition',
        includePackages: false,
      })
    );
    expect(mcJavaEval.eligible).toBe(true);
    expect(mcJavaEval.platforms).toEqual({ windows: true, mac: true, linux: true });
  });

  it('re-syncs cached SIGL + DisplayCatalog snapshots in < 300ms via openXboxCatalogCacheStore', () => {
    const store = xboxCatalogAndGamePass.openXboxCatalogCacheStore(tmpDir);
    const ids = Array.from({ length: 450 }, (_, i) => `9NSYNTH${String(i).padStart(5, '0')}`);
    const productsMap = new Map<string, any>();
    for (const id of ids) {
      productsMap.set(id, buildDisplayCatalogGameFixture({ productId: id, title: `Game ${id}` }));
    }

    store.setSigl('US:fdd9e2a7-0fee-49f6-ad69-4354098401ff', {
      etag: '"v1-etag"',
      sha256: 'abc123',
      ids,
      fetchedAt: Date.now(),
    });
    store.setProducts(productsMap, 'US');

    const t0 = performance.now();
    const siglSnap = store.getSigl('US:fdd9e2a7-0fee-49f6-ad69-4354098401ff');
    const hydrated = store.getProducts(ids, 'US');
    const elapsedMs = performance.now() - t0;

    store.close();

    expect(siglSnap?.ids.length).toBe(450);
    expect(hydrated.size).toBe(450);
    expect(elapsedMs).toBeLessThan(300);
  });

  it('runs end-to-end syncXboxCatalog against mocked Microsoft Store, SIGL v2, and DisplayCatalog endpoints', async () => {
    const mockFetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/PCGAFD/entitlements/subscriptions')) {
        return new Response(
          JSON.stringify({
            subscriptions: [
              { productId: 'CFQ7TTC0KGQ8', status: 'Active', endDate: '2027-06-01T00:00:00Z' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/PCGAFD/entitlements')) {
        return new Response(
          JSON.stringify({
            entitlements: [{ productId: '9NOWNEDGAM01', acquisitionType: 'Single' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('catalog.gamepass.com/sigls/v2')) {
        if (url.includes(xboxCatalogAndGamePass.GAMEPASS_SIGL_IDS.LEAVING_SOON)) {
          return new Response(JSON.stringify([{ siglId: 'meta' }, { id: '9NGPPASSGM02' }]), {
            status: 200,
            headers: { 'content-type': 'application/json', etag: '"leave-1"' },
          });
        }
        return new Response(
          JSON.stringify([{ siglId: 'meta' }, { id: '9NGPPASSGM02' }, { id: '9NUNPLAYED03' }]),
          { status: 200, headers: { 'content-type': 'application/json', etag: '"sigl-1"' } }
        );
      }
      if (url.includes('displaycatalog.mp.microsoft.com/v7.0/products')) {
        return new Response(
          JSON.stringify({
            Products: [
              buildDisplayCatalogGameFixture({
                productId: '9NOWNEDGAM01',
                title: 'Owned Odyssey',
              }),
              buildDisplayCatalogGameFixture({
                productId: '9NGPPASSGM02',
                title: 'Played Game Pass Quest',
              }),
              buildDisplayCatalogGameFixture({
                productId: '9NUNPLAYED03',
                title: 'Unplayed Catalog Filler',
                xboxTitleId: '99887766',
              }),
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    });

    const titleHubDecorations = {
      playedProductIds: ['9NGPPASSGM02'],
      playedTitleIds: ['19088743'],
      byTitleId: {
        '19088743': {
          titleId: '19088743',
          xboxProductId: '9NGPPASSGM02',
          isPlayed: true,
          lastTimePlayed: '2026-10-20T12:00:00Z',
        },
      },
      byProductId: {
        '9NGPPASSGM02': {
          titleId: '19088743',
          xboxProductId: '9NGPPASSGM02',
          isPlayed: true,
          lastTimePlayed: '2026-10-20T12:00:00Z',
        },
      },
    };

    const res = await xboxCatalogAndGamePass.syncXboxCatalog({
      storeToken: 't=mock_store_ticket',
      syncMode: 'owned_and_played',
      titleHubDecorations,
      userDataDir: tmpDir,
      fetchImpl: mockFetch,
      checkMinecraftJava: false,
    });

    const ids = res.games.map((g: any) => g.platforms[0]?.xboxProductId).sort();
    expect(ids).toEqual(['9NGPPASSGM02', '9NOWNEDGAM01']);
    const gpGame = res.games.find((g: any) => g.platforms[0]?.xboxProductId === '9NGPPASSGM02');
    expect(gpGame.platforms[0].ownershipType).toBe('subscription');
    expect(gpGame.platforms[0].isLeavingSoon).toBe(true);
  });

  it('rotates out uninstalled Game Pass titles while retaining locally installed lapsed titles with subscriptionExpired: true in mergeStorefrontGames', () => {
    const existingCatalog: CanonicalGame[] = [
      makeCanonicalGameFixture({
        id: 'xbox_9NROTATEDOUT',
        title: 'Rotated Uninstalled Game',
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NROTATEDOUT',
            xboxProductId: '9NROTATEDOUT',
            installed: false,
            ownershipType: 'subscription',
            playtimeMinutes: 45,
          },
        ],
      }),
      makeCanonicalGameFixture({
        id: 'xbox_9NLOCALINST1',
        title: 'Rotated Installed Game',
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NLOCALINST1',
            xboxProductId: '9NLOCALINST1',
            installed: true,
            installPath: '/Users/testuser/Games/OneLauncher/RotatedInstalledGame',
            ownershipType: 'subscription',
            playtimeMinutes: 120,
          },
        ],
      }),
      makeCanonicalGameFixture({
        id: 'xbox_9NPERMANENT1',
        title: 'Permanent Owned Game',
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NPERMANENT1',
            xboxProductId: '9NPERMANENT1',
            installed: false,
            ownershipType: 'owned',
            playtimeMinutes: 10,
          },
        ],
      }),
    ];

    const incomingSynced: CanonicalGame[] = [
      makeCanonicalGameFixture({
        id: 'xbox_9NPERMANENT1',
        title: 'Permanent Owned Game',
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NPERMANENT1',
            xboxProductId: '9NPERMANENT1',
            installed: false,
            ownershipType: 'owned',
            subscriptionExpired: false,
            playtimeMinutes: 10,
          },
        ],
      }),
    ];

    const merged = mergeStorefrontGames(existingCatalog, incomingSynced, 'xbox');
    expect(merged.some((g) => g.id === 'xbox_9NROTATEDOUT')).toBe(false);

    const retainedInstalled = merged.find((g) => g.id === 'xbox_9NLOCALINST1');
    expect(retainedInstalled).toBeDefined();
    expect(retainedInstalled?.platforms[0]?.subscriptionExpired).toBe(true);

    const keptOwned = merged.find((g) => g.id === 'xbox_9NPERMANENT1');
    expect(keptOwned).toBeDefined();
    expect(keptOwned?.platforms[0]?.subscriptionExpired).toBe(false);
  });

  it('reports explicit Windows-only native OS flags for standard Xbox titles and macOS-native support for Minecraft Java', () => {
    const standardXboxGame = makeCanonicalGameFixture({
      id: 'xbox_9NTESTGAME01',
      title: 'Synthetic Horizon Adventure',
      platforms: [
        {
          platformId: 'xbox',
          platformGameId: '9NTESTGAME01',
          xboxProductId: '9NTESTGAME01',
          installed: false,
        },
      ],
    });
    const standardFlags = getStorefrontNativeOsFlags(standardXboxGame, 'xbox');
    expect(standardFlags).toEqual({ windows: true, mac: false, isExplicit: true });

    const mcJavaGame = makeCanonicalGameFixture({
      id: 'xbox_9PJ8266BHFWN',
      title: 'Minecraft: Java Edition',
      platforms: [
        {
          platformId: 'xbox',
          platformGameId: '9PJ8266BHFWN',
          xboxProductId: '9PJ8266BHFWN',
          installed: false,
          platforms: { windows: true, mac: true, linux: true },
        },
      ],
    });
    const mcJavaFlags = getStorefrontNativeOsFlags(mcJavaGame, 'xbox');
    expect(mcJavaFlags.windows).toBe(true);
    expect(mcJavaFlags.mac).toBe(true);
    expect(mcJavaFlags.isExplicit).toBe(true);
  });
});

// ===========================================================================
// 3. Xbox Achievements (`v2` + `v1` Fallback), Gamerscore & Deduplicated Playtime
// ===========================================================================

describe('3. Xbox Achievements (v2 + v1 Fallback), Gamerscore & Deduplicated Playtime', () => {
  it('fetches v2 Xbox One / GDK achievements with earned/total Gamerscore and rejects sentinel 0001/1601 timestamps', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          achievements: [
            {
              id: 'ach-1',
              name: 'First Horizon',
              description: 'Complete the prologue.',
              lockedDescription: 'Complete the prologue.',
              progressState: 'Achieved',
              isSecret: false,
              progression: { timeUnlocked: '2026-08-14T19:30:00.000Z' },
              rewards: [{ type: 'Gamerscore', value: '25' }],
              mediaAssets: [{ type: 'Icon', url: 'https://images-eds.xboxlive.com/ach1.png' }],
            },
            {
              id: 'ach-2',
              name: 'Master Explorer',
              description: 'Discover every biome.',
              lockedDescription: 'Keep exploring.',
              progressState: 'NotStarted',
              isSecret: true,
              progression: { timeUnlocked: '0001-01-01T00:00:00.0000000Z' },
              rewards: [{ type: 'Gamerscore', value: '75' }],
              mediaAssets: [{ type: 'Icon', url: 'https://images-eds.xboxlive.com/ach2.png' }],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const container = await xboxAchievementsAndStats.fetchXboxDetailedAchievements({
      xuid: '2533274790395904',
      titleId: '19088743',
      authorizationHeader: 'XBL3.0 x=2533274790395904;mock_jwt',
      fetchImpl: mockFetch,
    });

    expect(container.unlocked).toBe(1);
    expect(container.total).toBe(2);
    expect(container.gamerscore).toEqual({ earned: 25, total: 100 });
    expect(container.achievements[0].unlockedAt).toBe('2026-08-14T19:30:00.000Z');
    expect(container.achievements[1].unlockedAt).toBeUndefined();
  });

  it('falls back automatically from empty v2 response to legacy v1 Xbox 360 / GFWL achievements with synthesized CDN icon URLs', async () => {
    const mockFetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/achievements?')) {
        return new Response(JSON.stringify({ achievements: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          achievements: [
            {
              id: 10,
              name: 'Classic Veteran',
              description: 'Cleared Act 1 on Xbox 360 / GFWL.',
              unlockedOnline: true,
              timeUnlocked: '2024-03-11T10:00:00.000Z',
              gamerscore: 50,
              imageId: 42,
              isSecret: false,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    // 0x4D5307E6 = 1297287142
    const container = await xboxAchievementsAndStats.fetchXboxDetailedAchievements({
      xuid: '2533274790395904',
      titleId: '1297287142',
      authorizationHeader: 'XBL3.0 x=2533274790395904;mock_jwt',
      fetchImpl: mockFetch,
    });

    expect(container.unlocked).toBe(1);
    expect(container.gamerscore).toEqual({ earned: 50, total: 50 });
    expect(container.achievements[0].iconUrl).toBe(
      'https://image-ssl.xboxlive.com/global/t.4d5307e6/ach/0/2a'
    );
  });

  it('deduplicates MinutesPlayed across userstats groups[] and root statlistscollection[] via Math.max without doubling', () => {
    const userStatsPayload = {
      groups: [
        {
          statlistscollection: [
            {
              stats: [
                { scid: '00000000-0000-0000-0000-000001234567', titleid: '19088743', name: 'MinutesPlayed', value: '185' },
              ],
            },
          ],
        },
      ],
      statlistscollection: [
        {
          stats: [
            { scid: '00000000-0000-0000-0000-000001234567', titleid: '19088743', name: 'MinutesPlayed', value: '185' },
          ],
        },
      ],
    };

    const playtimeMap = xboxAchievementsAndStats.extractMinutesPlayedFromUserStats(userStatsPayload);
    expect(playtimeMap.get('19088743')).toBe(185);
  });

  it('monotonically reconciles Xbox Gamerscore and achievement unlock counts in reconcileCatalogTrophiesRecords', () => {
    const initialCatalog: CanonicalGame[] = [
      makeCanonicalGameFixture({
        id: 'xbox_9NTESTGAME01',
        title: 'Synthetic Horizon Adventure',
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NTESTGAME01',
            xboxProductId: '9NTESTGAME01',
            xboxTitleId: '19088743',
            installed: true,
            achievements: {
              unlocked: 8,
              total: 20,
              percentage: 40,
              isMastered: false,
              gamerscore: { earned: 200, total: 1000 },
            },
          },
        ],
      }),
    ];

    // Stale lower payload should not downgrade unlocked or gamerscore.earned
    const afterStale = reconcileCatalogTrophiesRecords(
      initialCatalog,
      {},
      {},
      {},
      null,
      {
        '9NTESTGAME01': {
          unlocked: 3,
          total: 20,
          percentage: 15,
          gamerscore: { earned: 75, total: 1000 },
        },
      }
    );
    expect(afterStale[0].platforms[0].achievements?.unlocked).toBe(8);
    expect(afterStale[0].platforms[0].achievements?.gamerscore?.earned).toBe(200);

    // Higher payload advances unlocked and gamerscore.earned monotonically
    const afterHigher = reconcileCatalogTrophiesRecords(
      initialCatalog,
      {},
      {},
      {},
      null,
      {
        '9NTESTGAME01': {
          unlocked: 12,
          total: 20,
          percentage: 60,
          gamerscore: { earned: 350, total: 1000 },
        },
      }
    );
    expect(afterHigher[0].platforms[0].achievements?.unlocked).toBe(12);
    expect(afterHigher[0].platforms[0].achievements?.gamerscore?.earned).toBe(350);
  });

  it('preserves earned/total Gamerscore across multi-storefront canonical games without clobbering Steam or Epic summaries', () => {
    const dualStoreGame: CanonicalGame[] = [
      makeCanonicalGameFixture({
        id: 'steam_550001',
        steamAppId: 550001,
        title: 'Cross-Store Odyssey',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '550001',
            installed: true,
            achievements: { unlocked: 10, total: 30, percentage: 33, isMastered: false },
          },
          {
            platformId: 'xbox',
            platformGameId: '9NCROSSSTORE',
            xboxProductId: '9NCROSSSTORE',
            installed: false,
          },
        ],
      }),
    ];

    const reconciled = reconcileCatalogTrophiesRecords(
      dualStoreGame,
      {},
      {},
      {},
      new Set([550001]),
      {
        '9NCROSSSTORE': {
          unlocked: 15,
          total: 30,
          percentage: 50,
          gamerscore: { earned: 450, total: 1000 },
        },
      }
    );

    const steamPlat = reconciled[0].platforms.find((p) => p.platformId === 'steam')!;
    const xboxPlat = reconciled[0].platforms.find((p) => p.platformId === 'xbox')!;
    expect(steamPlat.achievements?.unlocked).toBe(10);
    expect(xboxPlat.achievements?.unlocked).toBe(15);
    expect(xboxPlat.achievements?.gamerscore).toEqual({ earned: 450, total: 1000 });
  });
});

// ===========================================================================
// 4. Windows `.GamingRoot`, `MicrosoftGame.config`, Launch Policy & Safety
// ===========================================================================

describe('4. Windows .GamingRoot, MicrosoftGame.config Inspector, Launch Policy Parity & Uninstall Safety', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-xbox-insp-test-'));
  });

  afterEach(() => {
    xboxCatalogAndGamePass.closeXboxCatalogCacheStore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses binary RGBX v1 .GamingRoot files with UTF-16LE paths and rejects malformed headers or path traversal', () => {
    const utf16Target = Buffer.from('\\XboxGames\\\0', 'utf16le');
    const gamingRoot = Buffer.alloc(8 + utf16Target.length);
    gamingRoot.write('RGBX', 0, 'ascii');
    gamingRoot.writeUInt32LE(1, 4);
    utf16Target.copy(gamingRoot, 8);

    const parsedWin = binaryAndManifestInspectors.parseGamingRootFile(gamingRoot, 'D:\\');
    expect(parsedWin).not.toBeNull();
    expect(parsedWin.valid).toBe(true);
    expect(parsedWin.folderName).toBe('XboxGames');
    expect(parsedWin.resolvedPath).toBe('D:\\XboxGames');

    // Reject invalid magic and traversal
    expect(
      binaryAndManifestInspectors.parseGamingRootFile(Buffer.from('NOPE00001234', 'ascii'), 'D:\\')
    ).toBeNull();

    const traversalBuf = Buffer.concat([
      Buffer.from([0x52, 0x47, 0x42, 0x58, 0x01, 0x00, 0x00, 0x00]),
      Buffer.from('..\\Windows\\System32\0', 'utf16le'),
    ]);
    expect(binaryAndManifestInspectors.parseGamingRootFile(traversalBuf, 'D:\\')).toBeNull();
  });

  it('computes deterministic Windows PackageFamilyName (8wekyb3d8bbwe) from Publisher DN', () => {
    const pfn = msixvcXvdParser.computePackageFamilyName(
      'Microsoft.XboxGamingOverlay',
      'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'
    );
    expect(pfn).toBe('Microsoft.XboxGamingOverlay_8wekyb3d8bbwe');
  });

  it('inspects MicrosoftGame.config to isolate primary game executable over gamelaunchhelper/crash handlers and flags DLC add-ons', () => {
    const gameConfigXml = `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="Publisher.SampleGame" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.4.2.0" />
  <TitleId>01234567</TitleId>
  <MSAAppId>0000000048999999</MSAAppId>
  <StoreId>9NTESTGAME01</StoreId>
  <ExecutableList>
    <Executable Name="gamelaunchhelper.exe" Id="Helper" />
    <Executable Name="CrashReportClient.exe" Id="CrashHandler" />
    <Executable Name="Binaries/WinGDK/SampleGame-WinGDK-Shipping.exe" Id="Game" />
  </ExecutableList>
  <ShellVisuals DefaultDisplayName="Synthetic Horizon" PublisherDisplayName="Synthetic Studio" />
</Game>`;

    const inspected = binaryAndManifestInspectors.inspectMicrosoftGameConfig(gameConfigXml);
    expect(inspected).not.toBeNull();
    expect(inspected.primaryExecutable).toBe('Binaries/WinGDK/SampleGame-WinGDK-Shipping.exe');
    expect(inspected.packageFamilyName).toBe('Publisher.SampleGame_8wekyb3d8bbwe');
    expect(inspected.appUserModelId).toBe('Publisher.SampleGame_8wekyb3d8bbwe!Game');
    expect(inspected.isDlcAddon).toBe(false);

    const dlcConfigXml = `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="Publisher.SampleGameExpansion" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.0.0.0" />
  <MainPackageDependency Name="Publisher.SampleGame" />
</Game>`;
    const dlcInspected = binaryAndManifestInspectors.inspectMicrosoftGameConfig(dlcConfigXml);
    expect(dlcInspected.isDlcAddon).toBe(true);
  });

  it('maintains 100% TS <-> CJS launch policy parity for Xbox on Windows native vs macOS CrossOver/Wine bottle', () => {
    const macBottleInput = {
      platformId: 'xbox' as const,
      hostPlatform: 'darwin' as const,
      detectedBuildType: 'windows_exe_on_mac' as const,
      isInstalled: true,
      hasExecutable: true,
      configuredLaunchMethod: 'compatibility_layer' as const,
    };

    const tsMac = resolveTsLaunchPolicy(macBottleInput);
    const cjsMac = cjsLaunchPolicyResolver.resolveEffectiveLaunchPolicy(macBottleInput);
    expect(tsMac).toEqual(cjsMac);
    expect(tsMac.effectiveLifecycle).toBe('fast_direct_bypass');
    expect(tsMac.spawnsStorefrontClient).toBe(false);
    expect(tsMac.syncsCloudSavesStandalone).toBe(true);

    const winNativeInput = {
      platformId: 'xbox' as const,
      hostPlatform: 'win32' as const,
      detectedBuildType: 'windows_native' as const,
      isInstalled: true,
      hasExecutable: true,
      configuredLaunchMethod: 'auto' as const,
    };
    const tsWin = resolveTsLaunchPolicy(winNativeInput);
    const cjsWin = cjsLaunchPolicyResolver.resolveEffectiveLaunchPolicy(winNativeInput);
    expect(tsWin).toEqual(cjsWin);
  });

  it('blocks destructive recursive deletion of C:\\XboxGames and WindowsApps roots while allowing standalone OneLauncher install folders', () => {
    expect(uninstallSafety.isSafeToDeleteInstallPath('C:\\XboxGames')).toBe(false);
    expect(uninstallSafety.isSafeToDeleteInstallPath('D:\\XboxGames')).toBe(false);
    expect(uninstallSafety.isSafeToDeleteInstallPath('C:\\Program Files\\WindowsApps')).toBe(false);
    expect(
      uninstallSafety.isSafeToDeleteInstallPath('C:\\Program Files\\ModifiableWindowsApps')
    ).toBe(false);

    expect(
      uninstallSafety.isSafeToDeleteInstallPath('C:\\Games\\OneLauncher\\SampleXboxGame')
    ).toBe(true);
    expect(
      uninstallSafety.isSafeToDeleteInstallPath('/Users/testuser/Games/OneLauncher/SampleXboxGame')
    ).toBe(true);
  });

  it('waits for GamingServices SystemAppData\\wgs quiet flush window and writes a rolling cloud save backup', async () => {
    const wgsRootDir = path.join(tmpDir, 'SystemAppData', 'wgs');
    const userDataDir = path.join(tmpDir, 'userData');
    const containerDir = path.join(wgsRootDir, '0009000001234567_00000000-0000-0000-0000-000001234567');
    fs.mkdirSync(containerDir, { recursive: true });
    fs.writeFileSync(path.join(containerDir, 'containers.index'), Buffer.from('WGS-SAVE-DATA'));

    const res = await cloudSaveEngine.waitForXboxCloudSaveFlush({
      wgsRootDir,
      userDataDir,
      gameId: 'xbox_9NTESTGAME01',
      pollIntervalMs: 30,
      quietWindowMs: 80,
      maxWaitMs: 1500,
    });

    expect(res.completed).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(res.reason).toBe('wgs_flushed');
    expect(res.backupPath).toBeTruthy();
    expect(fs.existsSync(res.backupPath)).toBe(true);
  });
});

// ===========================================================================
// 5. Pure-Node `.msixvc` / XVD Parser, AES-128-XTS Extractor & Security Guards
// ===========================================================================

describe('5. Pure-Node .msixvc / XVD Container Parser, AES-128-XTS Stream Extractor & Security Guards', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-xbox-xvd-test-'));
  });

  afterEach(() => {
    xboxCatalogAndGamePass.closeXboxCatalogCacheStore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses synthetic XVD v3 headers, L0 hash tree data_unit entries, user_data files, XvcInfo regions, and SegmentMetadata.bin', async () => {
    const gameConfigXml = `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="Publisher.SampleGame" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.0.0.0" />
  <TitleId>01234567</TitleId>
  <StoreId>9NTESTGAME01</StoreId>
  <ExecutableList><Executable Name="SampleGame.exe" Id="Game" /></ExecutableList>
</Game>`;

    const imageBuf = buildSyntheticMsixvcImage({
      gameConfigXml,
      files: [
        { path: 'Files/SampleGame.exe', data: Buffer.alloc(6000, 0x41) },
        { path: 'Files/Data/level01.pak', data: Buffer.alloc(2048, 0x42) },
      ],
    });

    const reader = msixvcXvdParser.createBufferRangeReader(imageBuf);
    const inspected = await msixvcXvdParser.inspectMsixvcContainer({ rangeReader: reader });

    expect(inspected.header.magic).toBe('msft-xvd');
    expect(inspected.header.formatVersion).toBe(3);
    expect(inspected.mappedSegments.length).toBe(2);
    expect(inspected.mappedSegments[0].path).toBe('Files/SampleGame.exe');
    expect(inspected.mappedSegments[0].fileSize).toBe(6000);
    expect(inspected.gameConfig?.primaryExecutable).toBe('SampleGame.exe');

    const l0Units = await msixvcXvdParser.readL0DataUnitsForPages(
      reader,
      inspected.layout,
      inspected.layout.driveData.byteOffset,
      3
    );
    expect(Array.from(l0Units)).toEqual([1000, 1007, 1014]);
  });

  it('classifies GDK Win32 (tier_a_supported), pure UWP CoreWindow (tier_b_legacy_uwp), and kernel anti-cheat (tier_c_kernel_anticheat) via probeMsixvcCompatibility', async () => {
    // 1. Tier A: GDK Win32 package
    const tierABuf = buildSyntheticMsixvcImage({
      gameConfigXml: `<Game configVersion="1">
        <Identity Name="Publisher.SampleGdk" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.0.0.0" />
        <TitleId>01234567</TitleId>
        <ExecutableList><Executable Name="SampleGdk.exe" Id="Game" /></ExecutableList>
      </Game>`,
    });
    const tierARes = await msixvcXvdParser.probeMsixvcCompatibility({
      rangeReader: msixvcXvdParser.createBufferRangeReader(tierABuf),
    });
    expect(tierARes.tier).toBe('tier_a_supported');
    expect(tierARes.supportedOnMacBottle).toBe(true);

    // 2. Tier B: Legacy pure-UWP CoreWindow (EntryPoint without FullTrustApplication or MicrosoftGame.config)
    const tierBBuf = buildSyntheticMsixvcImage({
      gameConfigXml: null,
      appxManifestXml: `<?xml version="1.0" encoding="utf-8"?>
        <Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
          <Identity Name="Publisher.LegacyUwp" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.0.0.0" />
          <Applications>
            <Application Id="App" Executable="LegacyUwp.exe" EntryPoint="LegacyUwp.App" />
          </Applications>
        </Package>`,
    });
    const tierBRes = await msixvcXvdParser.probeMsixvcCompatibility({
      rangeReader: msixvcXvdParser.createBufferRangeReader(tierBBuf),
    });
    expect(tierBRes.tier).toBe('tier_b_legacy_uwp');
    expect(tierBRes.supportedOnMacBottle).toBe(false);

    // 3. Tier C: Kernel Anti-Cheat driver in SegmentMetadata.bin
    const tierCBuf = buildSyntheticMsixvcImage({
      gameConfigXml: `<Game configVersion="1">
        <Identity Name="Publisher.ProtectedGame" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.0.0.0" />
        <ExecutableList><Executable Name="ProtectedGame.exe" Id="Game" /></ExecutableList>
      </Game>`,
      files: [
        { path: 'Files/ProtectedGame.exe', data: Buffer.from('MZ-GAME') },
        { path: 'Files/EasyAntiCheat/EasyAntiCheat_EOS.sys', data: Buffer.from('MZ-DRIVER') },
      ],
    });
    const tierCRes = await msixvcXvdParser.probeMsixvcCompatibility({
      rangeReader: msixvcXvdParser.createBufferRangeReader(tierCBuf),
    });
    expect(tierCRes.tier).toBe('tier_c_kernel_anticheat');
    expect(tierCRes.supportedOnMacBottle).toBe(false);
    expect(tierCRes.antiCheatSignals.length).toBeGreaterThan(0);
  });

  it('decrypts AES-128-XTS encrypted MSIXVC segments bit-exactly using RFC 3394 wrapped CIK and OpenSSL key-half swap', async () => {
    const rawCik32 = crypto.randomBytes(32);
    const deviceKey16 = crypto.randomBytes(16);
    const wrappedCik40 = msixvcStreamExtractor.wrapCikWithDeviceKey(rawCik32, deviceKey16);
    const keyGuid = 'fedcba98-7654-3210-fedc-ba9876543210';

    const exePayload = crypto.randomBytes(9157); // spans 3 XVD pages with non-aligned tail
    const pakPayload = crypto.randomBytes(5011); // spans 2 XVD pages
    const gameConfigXml = `<Game configVersion="1">
      <Identity Name="Publisher.EncryptedGame" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.0.0.0" />
      <TitleId>01234567</TitleId>
      <ExecutableList><Executable Name="EncryptedGame.exe" Id="Game" /></ExecutableList>
    </Game>`;

    const encryptedMsixvc = buildSyntheticMsixvcImage({
      keyGuid,
      cik32: rawCik32,
      gameConfigXml,
      files: [
        { path: 'Files/EncryptedGame.exe', data: exePayload },
        { path: 'Files/Content/world.pak', data: pakPayload },
      ],
    });

    const installDir = path.join(tmpDir, 'extracted-encrypted');
    const result = await msixvcStreamExtractor.extractMsixvcStream({
      rangeReader: msixvcXvdParser.createBufferRangeReader(encryptedMsixvc),
      installDir,
      cikMap: { [keyGuid]: wrappedCik40 },
      deviceKey: deviceKey16,
    });

    expect(result.primaryExecutablePath).toBe(path.join(installDir, 'EncryptedGame.exe'));
    const extractedExe = fs.readFileSync(path.join(installDir, 'EncryptedGame.exe'));
    const extractedPak = fs.readFileSync(path.join(installDir, 'Content', 'world.pak'));
    expect(extractedExe.equals(exePayload)).toBe(true);
    expect(extractedPak.equals(pakPayload)).toBe(true);
  });

  it('executes non-blocking MSIXVC extraction inside worker_threads via extractMsixvcInWorker', async () => {
    const rawCik32 = crypto.randomBytes(32);
    const exeBytes = Buffer.from('MZ-WORKER-EXTRACTED-GDK-EXE-PAYLOAD-2026', 'utf8');
    const msixvcPath = path.join(tmpDir, 'worker_fixture.msixvc');
    const installDir = path.join(tmpDir, 'worker-out');

    const img = buildSyntheticMsixvcImage({
      cik32: rawCik32,
      gameConfigXml: `<Game configVersion="1">
        <Identity Name="Publisher.WorkerGame" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.0.0.0" />
        <ExecutableList><Executable Name="WorkerGame.exe" Id="Game" /></ExecutableList>
      </Game>`,
      files: [{ path: 'Files/WorkerGame.exe', data: exeBytes }],
    });
    fs.writeFileSync(msixvcPath, img);

    const progressStatuses: string[] = [];
    const res = await msixvcStreamExtractor.extractMsixvcInWorker({
      msixvcPath,
      installDir,
      cik: rawCik32,
      onProgress: (p: any) => {
        if (p?.status) progressStatuses.push(p.status);
      },
    });

    expect(res.fileCount).toBeGreaterThanOrEqual(1);
    expect(progressStatuses).toContain('completed');
    expect(fs.readFileSync(path.join(installDir, 'WorkerGame.exe')).equals(exeBytes)).toBe(true);
  });

  it('supports crash-safe HTTP Range pause/abort and resume via .onelauncher-xbox-install.json without re-downloading completed files', async () => {
    // Space segments > 64 KiB apart with small chunkTargetBytes so each file is its own work unit
    const fileA = Buffer.alloc(4096, 0x51);
    const spacer = Buffer.alloc(80 * 1024, 0x52);
    const fileB = Buffer.alloc(4096, 0x53);

    const img = buildSyntheticMsixvcImage({
      gameConfigXml: `<Game configVersion="1">
        <Identity Name="Publisher.ResumeGame" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.0.0.0" />
        <ExecutableList><Executable Name="ResumeGame.exe" Id="Game" /></ExecutableList>
      </Game>`,
      files: [
        { path: 'Files/ResumeGame.exe', data: fileA },
        { path: 'Files/Data/spacer.bin', data: spacer },
        { path: 'Files/Data/final.bin', data: fileB },
      ],
    });

    const rangeRequests: Array<{ start: number; end: number }> = [];
    const server = http.createServer((req, res) => {
      const rangeHdr = req.headers.range;
      if (rangeHdr) {
        const m = /bytes=(\d+)-(\d+)/.exec(rangeHdr);
        if (m) {
          const start = Number(m[1]);
          const end = Math.min(img.length - 1, Number(m[2]));
          rangeRequests.push({ start, end });
          const slice = img.subarray(start, end + 1);
          res.writeHead(206, {
            'Content-Type': 'application/octet-stream',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${img.length}`,
            'Content-Length': String(slice.length),
          });
          res.end(slice);
          return;
        }
      }
      res.writeHead(200, { 'Content-Length': String(img.length) });
      res.end(img);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    const cdnUrl = `http://127.0.0.1:${port}/ResumeGame.msixvc`;
    const installDir = path.join(tmpDir, 'http-resume-out');

    try {
      const abortCtrl = new AbortController();
      await expect(
        msixvcStreamExtractor.extractMsixvcStream({
          urls: [cdnUrl],
          installDir,
          concurrency: 1,
          chunkTargetBytes: 4096,
          signal: abortCtrl.signal,
          onProgress: (p: any) => {
            if (p.completedFiles >= 1 && !abortCtrl.signal.aborted) {
              abortCtrl.abort();
            }
          },
        })
      ).rejects.toThrow(/paused or cancelled|abort/i);

      const journalPath = path.join(installDir, msixvcStreamExtractor.RESUME_JOURNAL_FILENAME);
      expect(fs.existsSync(journalPath)).toBe(true);

      const resumeResult = await msixvcStreamExtractor.extractMsixvcStream({
        urls: [cdnUrl],
        installDir,
        concurrency: 1,
        chunkTargetBytes: 4096,
      });

      expect(resumeResult.resumedUnits).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(journalPath)).toBe(false); // Cleaned up on completion
      expect(fs.readFileSync(path.join(installDir, 'ResumeGame.exe')).equals(fileA)).toBe(true);
      expect(fs.readFileSync(path.join(installDir, 'Data', 'final.bin')).equals(fileB)).toBe(true);
      expect(rangeRequests.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects path traversal (../), drive-qualified paths (C:\\), null bytes, and symlink directory escapes in MSIXVC extractor', async () => {
    const installDir = path.join(tmpDir, 'safe-root');
    fs.mkdirSync(installDir, { recursive: true });

    expect(() =>
      msixvcStreamExtractor.resolveSafeDestinationPath(installDir, 'Files/../../etc/passwd')
    ).toThrow(/traversal/i);
    expect(() =>
      msixvcStreamExtractor.resolveSafeDestinationPath(installDir, 'C:\\Windows\\System32\\cmd.exe')
    ).toThrow(/drive-qualified/i);
    expect(() =>
      msixvcStreamExtractor.normalizeRelativeInstallPath('Files/bad\0name.exe')
    ).toThrow(/null/i);

    // Symlink escape inside installDir must be blocked during extraction
    const outsideDir = path.join(tmpDir, 'outside-secret');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(installDir, 'SubDir'));

    const symlinkAttackImg = buildSyntheticMsixvcImage({
      files: [{ path: 'Files/SubDir/escaped.bin', data: Buffer.from('NO-ESCAPE') }],
    });

    await expect(
      msixvcStreamExtractor.extractMsixvcStream({
        rangeReader: msixvcXvdParser.createBufferRangeReader(symlinkAttackImg),
        installDir,
      })
    ).rejects.toThrow(/symlink/i);
    expect(fs.existsSync(path.join(outsideDir, 'escaped.bin'))).toBe(false);
  });
});

// ===========================================================================
// 6. Native `xgameruntime.dll` Bridge, Bottle Provisioner, RPC & `wgs` Sync
// ===========================================================================

describe('6. Native xgameruntime.dll Bridge, Bottle Provisioner, Loopback RPC & Connected Storage (wgs) Sync', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-xbox-bridge-test-'));
  });

  afterEach(() => {
    xboxCatalogAndGamePass.closeXboxCatalogCacheStore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('verifies prebuilt PE32+ x86_64 one_xgameruntime_bridge.dll exports, marker string, and zero MinGW runtime DLL dependencies', () => {
    const info = buildXboxBridge.verifyXboxBridgeDll();
    expect(info.sizeBytes).toBeGreaterThan(4096);
    expect(info.exports).toEqual(buildXboxBridge.EXPECTED_EXPORTS);
    expect(info.imports).not.toContain('libwinpthread-1.dll');
    expect(info.imports).not.toContain('libgcc_s_seh-1.dll');
    expect(info.imports).not.toContain('libstdc++-6.dll');

    const rawBytes = fs.readFileSync(buildXboxBridge.DLL_PATH);
    const peOffset = rawBytes.readUInt32LE(0x3c);
    expect(rawBytes.readUInt16LE(peOffset + 4)).toBe(0x8664); // IMAGE_FILE_MACHINE_AMD64
    expect(rawBytes.includes(Buffer.from('OneLauncher.XGRBridge.v1', 'ascii'))).toBe(true);
  });

  it('provisions CrossOver/Wine bottle with xgameruntime.dll, backs up retail non-marker DLL to .msft.bak, patches system.reg, and enforces strict ROSETTA_ADVERTISE_AVX', async () => {
    const bottlePath = path.join(tmpDir, 'CrossOverBottle');
    const sys32Dir = path.join(bottlePath, 'drive_c', 'windows', 'system32');
    const gameDir = path.join(tmpDir, 'GameInstall');
    fs.mkdirSync(sys32Dir, { recursive: true });
    fs.mkdirSync(path.join(bottlePath, 'drive_c', 'users', 'crossover'), { recursive: true });
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(bottlePath, 'system.reg'), 'WINE REGISTRY Version 2\n\n', 'utf8');

    // Stage a synthetic retail (non-OneLauncher) xgameruntime.dll alongside the game exe
    const retailDllPath = path.join(gameDir, 'xgameruntime.dll');
    fs.writeFileSync(retailDllPath, Buffer.from('MZ-RETAIL-MICROSOFT-XGAMERUNTIME-DLL'));

    const envAvxOff: Record<string, string> = { ROSETTA_ADVERTISE_AVX: '0' };
    const provisioned = await wineAndCrossOverManager.prepareXboxBottleEnvironment({
      bottlePath,
      installDir: gameDir,
      executablePath: path.join(gameDir, 'SampleGame.exe'),
      packageFamilyName: 'Publisher.SampleGame_8wekyb3d8bbwe',
      xuid: '2533274790395904',
      scid: '00000000-0000-0000-0000-000001234567',
      advertiseAvx: false,
      env: envAvxOff,
    });

    expect(provisioned.bridgeStaged).toBe(true);
    expect(fs.existsSync(path.join(sys32Dir, 'xgameruntime.dll'))).toBe(true);
    expect(fs.existsSync(`${retailDllPath}.msft.bak`)).toBe(true);
    expect(
      fs.readFileSync(`${retailDllPath}.msft.bak`).equals(Buffer.from('MZ-RETAIL-MICROSOFT-XGAMERUNTIME-DLL'))
    ).toBe(true);
    expect(
      fs.readFileSync(retailDllPath).includes(Buffer.from('OneLauncher.XGRBridge.v1', 'ascii'))
    ).toBe(true);

    const sysReg = fs.readFileSync(path.join(bottlePath, 'system.reg'), 'utf8');
    expect(sysReg).toContain('"ForceUseInprocGameSaves"=dword:00000001');
    expect(sysReg).toContain('"DisableHidraw"=dword:00000001');

    // Critical Rosetta invariant: ROSETTA_ADVERTISE_AVX must be UNSET (deleted) when disabled, never '0'
    expect('ROSETTA_ADVERTISE_AVX' in provisioned.env).toBe(false);
    expect(provisioned.env.WINEDLLOVERRIDES).toContain('xgameruntime=n');

    const envAvxOn = wineAndCrossOverManager.applyStrictRosettaAvxEnv({}, true);
    expect(envAvxOn.ROSETTA_ADVERTISE_AVX).toBe('1');
  });

  it('enforces constant-time session key authentication on 127.0.0.1 loopback RPC server and destroys unauthorized sockets', async () => {
    const rpc = await xboxRuntimeLoopbackServer.startXboxRuntimeLoopbackServer({
      userProfile: { xuid: '2533274790395904', gamertag: 'PlayerOne', modernGamertag: 'PlayerOne#1001' },
      gameMetadata: { titleId: '19088743', storeId: '9NTESTGAME01' },
      enableCloudSaveSync: false,
    });

    try {
      const badRes = await sendLoopbackRpc(rpc.port, {
        id: 1,
        key: '0'.repeat(64),
        method: 'session.init',
        params: {},
      });
      expect(badRes.closed).toBe(true);
      expect(badRes.response).toBeUndefined();
    } finally {
      await rpc.close();
    }
  });

  it('dispatches session.init, xuser.getTokenAndSignature, xstore.getGameLicense, and xstore.queryEntitledProducts over length-prefixed loopback frames', async () => {
    const rpc = await xboxRuntimeLoopbackServer.startXboxRuntimeLoopbackServer({
      userProfile: {
        xuid: '2533274790395904',
        gamertag: 'PlayerOne',
        modernGamertag: 'PlayerOne',
        modernGamertagSuffix: '1001',
      },
      gameMetadata: {
        titleId: '19088743',
        scid: '00000000-0000-0000-0000-000001234567',
        storeId: '9NTESTGAME01',
        packageFamilyName: 'Publisher.SampleGame_8wekyb3d8bbwe',
        displayName: 'Synthetic Horizon',
      },
      authProvider: {
        async getTokenAndSignatureForUrl({ url }: { url: string }) {
          return {
            token: `XBL3.0 x=2533274790395904;jwt_for_${new URL(url).hostname}`,
            signature: 'AAAAAQ_MOCK_76B_SIG',
          };
        },
      },
      enableCloudSaveSync: false,
    });

    try {
      const initReply = await sendLoopbackRpc(rpc.port, {
        id: 10,
        key: rpc.sessionKey,
        method: 'session.init',
        params: {},
      });
      expect(initReply.response?.ok).toBe(true);
      expect(initReply.response?.result?.xuid).toBe('2533274790395904');
      expect(initReply.response?.result?.uniqueModernGamertag).toBe('PlayerOne#1001');

      const tokenReply = await sendLoopbackRpc(rpc.port, {
        id: 11,
        key: rpc.sessionKey,
        method: 'xuser.getTokenAndSignature',
        params: { method: 'GET', url: 'https://achievements.xboxlive.com/users/xuid(1)/achievements' },
      });
      expect(tokenReply.response?.ok).toBe(true);
      expect(tokenReply.response?.result?.token).toContain('jwt_for_achievements.xboxlive.com');
      expect(tokenReply.response?.result?.signature).toBe('AAAAAQ_MOCK_76B_SIG');

      const licenseReply = await sendLoopbackRpc(rpc.port, {
        id: 12,
        key: rpc.sessionKey,
        method: 'xstore.getGameLicense',
        params: {},
      });
      expect(licenseReply.response?.ok).toBe(true);
      expect(licenseReply.response?.result?.isActive).toBe(true);
      expect(licenseReply.response?.result?.isTrial).toBe(false);

      const entitledReply = await sendLoopbackRpc(rpc.port, {
        id: 13,
        key: rpc.sessionKey,
        method: 'xstore.queryEntitledProducts',
        params: { productKinds: 0x04 },
      });
      expect(entitledReply.response?.ok).toBe(true);
      expect(entitledReply.response?.result?.products?.[0]?.storeId).toBe('9NTESTGAME01');
    } finally {
      await rpc.close();
    }
  });

  it('round-trips binary Windows Gaming Services containers.index (v14), container.N (v4), and xgs <-> wgs folder mirroring', async () => {
    const wgsUserDir = path.join(tmpDir, 'wgs_user');
    const xgsUserDir = path.join(tmpDir, 'xgs_user');
    const savePayload = Buffer.from('{"level":42,"inventory":["sword","shield"]}', 'utf8');

    await xboxTitleStorageSync.writeLocalWgsWorkspace(wgsUserDir, {
      storePkgAumid: 'Publisher.SampleGame_8wekyb3d8bbwe!Game',
      pkgDisplayName: 'Synthetic Horizon',
      containers: [
        {
          name: 'Slot01',
          displayName: 'Autosave Slot 1',
          containerNum: 2,
          dirty: false,
          modifiedIso: '2026-10-20T15:00:00.000Z',
          blobs: [{ name: 'progress.json', data: savePayload }],
        },
      ],
    });

    const readBack = await xboxTitleStorageSync.readLocalWgsWorkspace(wgsUserDir);
    expect(readBack.exists).toBe(true);
    expect(readBack.index?.version).toBe(14);
    expect(readBack.containers.get('Slot01')?.blobs.get('progress.json')?.data.equals(savePayload)).toBe(true);

    // Export to xgs folder mode, mutate a save file in xgs, and import back into wgs as dirty
    await xboxTitleStorageSync.exportWgsToXgsFolder(wgsUserDir, xgsUserDir);
    const xgsFile = path.join(xgsUserDir, 'Slot01', 'progress.json');
    expect(fs.readFileSync(xgsFile).equals(savePayload)).toBe(true);

    const updatedSave = Buffer.from('{"level":99,"inventory":["excalibur"]}', 'utf8');
    fs.writeFileSync(xgsFile, updatedSave);

    const mutated = await xboxTitleStorageSync.importXgsFolderIntoWgs(
      xgsUserDir,
      wgsUserDir,
      'Publisher.SampleGame_8wekyb3d8bbwe!Game'
    );
    expect(mutated).toBe(true);

    const afterImport = await xboxTitleStorageSync.readLocalWgsWorkspace(wgsUserDir);
    expect(afterImport.containers.get('Slot01')?.dirty).toBe(true);
    expect(
      afterImport.containers.get('Slot01')?.blobs.get('progress.json')?.data.equals(updatedSave)
    ).toBe(true);
  });

  it('synchronizes Connected Storage (v107) pre_launch download and post_exit upload including > 4 MiB multi-block Azure atom commits', async () => {
    const cloudContainers = new Map<
      string,
      { displayName: string; clientFileTime: string; etag: string; atoms: Record<string, string> }
    >();
    const cloudAtoms = new Map<string, Buffer>();
    const pendingBlocks = new Map<string, Map<string, Buffer>>();
    let lockCalls = 0;
    let unlockCalls = 0;

    // Seed a remote cloud save container before pre_launch
    const remoteAtomId = '11111111-2222-3333-4444-555555555555,binary';
    const remoteBlobData = Buffer.from('REMOTE-CLOUD-SAVE-SLOT-01', 'utf8');
    cloudAtoms.set(remoteAtomId, remoteBlobData);
    cloudContainers.set('CloudSlot', {
      displayName: 'CloudSlot',
      clientFileTime: '2026-10-25T10:00:00.000Z',
      etag: '"etag-1"',
      atoms: { 'save.dat': remoteAtomId },
    });

    let serverOrigin = '';
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const u = new URL(req.url || '/', serverOrigin);

        // Azure Blob block PUT handler: /azure-blocks/<uuid>?comp=block&blockid=...
        if (u.pathname.startsWith('/azure-blocks/') && req.method === 'PUT') {
          const uuid = u.pathname.split('/').pop()!;
          const blockId = u.searchParams.get('blockid') || '';
          if (!pendingBlocks.has(uuid)) pendingBlocks.set(uuid, new Map());
          pendingBlocks.get(uuid)!.set(blockId, body);
          res.writeHead(201);
          res.end();
          return;
        }

        const prefixMatch = /^\/connectedstorage\/users\/xuid\([^)]+\)\/scids\/[^/]+(.*)$/.exec(
          u.pathname
        );
        const subPath = prefixMatch ? decodeURIComponent(prefixMatch[1] || '') : '';

        if (subPath === '/lock' && req.method === 'PUT') {
          lockCalls += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ quotaBytes: 268435456 }));
          return;
        }
        if (subPath === '/lock' && req.method === 'DELETE') {
          unlockCalls += 1;
          res.writeHead(204);
          res.end();
          return;
        }
        if ((subPath === '' || subPath === '/') && req.method === 'GET') {
          const blobs = Array.from(cloudContainers.entries()).map(([name, meta]) => ({
            fileName: `${name},savedgame`,
            displayName: meta.displayName,
            clientFileTime: meta.clientFileTime,
            etag: meta.etag,
            size: 1024,
          }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ blobs }));
          return;
        }
        if (subPath.startsWith('/atoms/') && req.method === 'POST') {
          const uuid = subPath.slice('/atoms/'.length);
          if (u.searchParams.get('commit') === 'true') {
            const parsed = JSON.parse(body.toString('utf8'));
            const blkMap = pendingBlocks.get(uuid) || new Map();
            const assembled = Buffer.concat(
              (parsed.blockIds as string[]).map((id) => blkMap.get(id) || Buffer.alloc(0))
            );
            cloudAtoms.set(`${uuid},binary`, assembled);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{}');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ blobUri: `${serverOrigin}/azure-blocks/${uuid}` }));
          }
          return;
        }
        if (subPath.endsWith(',binary') && req.method === 'GET') {
          const atomKey = subPath.slice(1);
          const data = cloudAtoms.get(atomKey);
          if (!data) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(data);
          return;
        }
        if (subPath.endsWith(',binary') && req.method === 'PUT') {
          cloudAtoms.set(subPath.slice(1), body);
          res.writeHead(201);
          res.end();
          return;
        }
        if (subPath.endsWith(',savedgame') && req.method === 'GET') {
          const cName = subPath.slice(1, -',savedgame'.length);
          const meta = cloudContainers.get(cName);
          if (!meta) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ atoms: meta.atoms }));
          return;
        }
        if (subPath.endsWith(',savedgame') && req.method === 'PUT') {
          const cName = subPath.slice(1, -',savedgame'.length);
          const parsed = JSON.parse(body.toString('utf8'));
          cloudContainers.set(cName, {
            displayName: u.searchParams.get('displayName') || cName,
            clientFileTime: u.searchParams.get('clientFileTime') || new Date().toISOString(),
            etag: '"etag-updated"',
            atoms: parsed.atoms || {},
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    serverOrigin = `http://127.0.0.1:${port}`;

    const wgsUserDir = path.join(tmpDir, 'wgs_sync_client');
    const xuid = '2533274790395904';
    const scid = '00000000-0000-0000-0000-000001234567';

    try {
      // 1. pre_launch pulls remote CloudSlot into local binary wgs workspace
      const preRes = await xboxTitleStorageSync.syncXboxTitleStorage({
        mode: 'pre_launch',
        wgsUserDir,
        xuid,
        scid,
        packageFamilyName: 'Publisher.SampleGame_8wekyb3d8bbwe',
        authorizationHeader: 'XBL3.0 x=2533274790395904;mock_jwt',
        titleStorageOrigin: serverOrigin,
      });
      expect(preRes.downloadedContainers).toBe(1);
      expect(lockCalls).toBe(1);
      expect(unlockCalls).toBe(1);

      const localWs = await xboxTitleStorageSync.readLocalWgsWorkspace(wgsUserDir);
      expect(localWs.containers.get('CloudSlot')?.blobs.get('save.dat')?.data.equals(remoteBlobData)).toBe(true);

      // 2. Write a > 4 MiB dirty blob locally and run post_exit upload -> verifies multi-block Azure flow!
      const largeBlob = Buffer.alloc(xboxTitleStorageSync.LARGE_ATOM_THRESHOLD_BYTES + 65536, 0x6b);
      await xboxTitleStorageSync.writeLocalWgsWorkspace(wgsUserDir, {
        containers: [
          {
            name: 'LargeWorldSave',
            displayName: 'Large World Save',
            containerNum: 1,
            dirty: true,
            modifiedIso: '2026-10-26T12:00:00.000Z',
            blobs: [{ name: 'world_chunk.bin', data: largeBlob }],
          },
        ],
      });

      const postRes = await xboxTitleStorageSync.syncXboxTitleStorage({
        mode: 'post_exit',
        wgsUserDir,
        xuid,
        scid,
        packageFamilyName: 'Publisher.SampleGame_8wekyb3d8bbwe',
        authorizationHeader: 'XBL3.0 x=2533274790395904;mock_jwt',
        titleStorageOrigin: serverOrigin,
      });
      expect(postRes.uploadedContainers).toBe(1);
      expect(pendingBlocks.size).toBe(1); // Multi-block Azure upload executed!

      const uploadedMeta = cloudContainers.get('LargeWorldSave');
      expect(uploadedMeta).toBeDefined();
      const uploadedAtomKey = uploadedMeta!.atoms['world_chunk.bin'];
      expect(cloudAtoms.get(uploadedAtomKey)?.equals(largeBlob)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('bridges xgamesave.init and xgamesave.commit RPC calls from loopback server into Connected Storage sync', async () => {
    const saveRootDir = path.join(tmpDir, 'SystemAppData');
    let putManifestCount = 0;

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const url = req.url || '/';
        if (url.includes('/lock') && req.method === 'PUT') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ quotaBytes: 268435456 }));
          return;
        }
        if (url.includes('/lock') && req.method === 'DELETE') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (url.includes(',binary') && req.method === 'PUT') {
          res.writeHead(201);
          res.end();
          return;
        }
        if (url.includes(',savedgame') && req.method === 'PUT') {
          putManifestCount += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ blobs: [] }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const tsPort = (server.address() as net.AddressInfo).port;
    const tsOrigin = `http://127.0.0.1:${tsPort}`;

    const xuid = '2533274790395904';
    const scid = '00000000-0000-0000-0000-000001234567';
    const hexXuidScid = xboxTitleStorageSync.formatWgsUserScidFolderName(xuid, scid);
    const wgsUserDir = path.join(saveRootDir, 'wgs', hexXuidScid);

    const rpc = await xboxRuntimeLoopbackServer.startXboxRuntimeLoopbackServer({
      userProfile: { xuid, gamertag: 'PlayerOne', modernGamertag: 'PlayerOne#1001' },
      gameMetadata: {
        titleId: '19088743',
        scid,
        storeId: '9NTESTGAME01',
        packageFamilyName: 'Publisher.SampleGame_8wekyb3d8bbwe',
      },
      saveRootDir,
      titleStorageOrigin: tsOrigin,
      authProvider: {
        async getTokenAndSignatureForUrl() {
          return { token: `XBL3.0 x=${xuid};mock_jwt`, signature: '' };
        },
      },
      enableCloudSaveSync: true,
    });

    try {
      const initRes = await sendLoopbackRpc(rpc.port, {
        id: 21,
        key: rpc.sessionKey,
        method: 'xgamesave.init',
        params: { xuid, scid },
      });
      expect(initRes.response?.ok).toBe(true);
      expect(initRes.response?.result?.synced).toBe(true);

      await xboxTitleStorageSync.writeLocalWgsWorkspace(wgsUserDir, {
        containers: [
          {
            name: 'QuickSave',
            displayName: 'QuickSave',
            containerNum: 1,
            dirty: true,
            blobs: [{ name: 'state.bin', data: Buffer.from('QUICKSAVE-BYTES') }],
          },
        ],
      });

      const commitRes = await sendLoopbackRpc(rpc.port, {
        id: 22,
        key: rpc.sessionKey,
        method: 'xgamesave.commit',
        params: { xuid, scid, containerName: 'QuickSave', waitForCloud: true },
      });
      expect(commitRes.response?.ok).toBe(true);
      expect(commitRes.response?.result?.committed).toBe(true);
      expect(putManifestCount).toBe(1);
    } finally {
      await rpc.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ===========================================================================
// 7. Frontend UI Components, Auth Code Extraction & Accessibility Semantics
// ===========================================================================

describe('7. Frontend UI Components, Dot-Containing Auth Codes & Accessibility Semantics', () => {
  let origWindow: any;
  let origLocalStorage: any;

  beforeEach(() => {
    origWindow = (globalThis as any).window;
    origLocalStorage = (globalThis as any).localStorage;
    const mem = createMemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: mem,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: {
        localStorage: mem,
        screenX: 0,
        screenY: 0,
        outerWidth: 1280,
        outerHeight: 800,
        open: vi.fn(() => ({ closed: false, close: vi.fn() })),
        setInterval: vi.fn(() => 1),
        clearInterval: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        electronAPI: undefined,
      },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'window', {
      value: origWindow,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      value: origLocalStorage,
      configurable: true,
      writable: true,
    });
  });

  it("extracts dot-containing Microsoft OAuth codes from raw codes and redirect URLs in IntegrationsModal and invokes exchangeCode('xbox', ...)", async () => {
    const exchangeCodeSpy = vi.fn().mockResolvedValue({
      success: true,
      accountName: 'PlayerOne#1001',
      accountId: '2533274790395904',
      games: [],
    });

    const harness = createComponentHarness(IntegrationsModal, {
      isOpen: true,
      onClose: vi.fn(),
      onLibraryUpdated: vi.fn(),
    });

    let tree = harness.render();

    // Switch to Xbox tab
    const xboxTabBtn = findElements(
      tree,
      (el) => el.type === 'button' && getTextContent(el).includes('Xbox')
    )[0];
    expect(xboxTabBtn).toBeDefined();
    xboxTabBtn.props.onClick();
    tree = harness.render();

    // Click "Sign In to Xbox Live" (while window.electronAPI is undefined so redirect paste input opens)
    const signInBtn = findElements(
      tree,
      (el) => el.type === 'button' && getTextContent(el).includes('Sign In to Xbox Live')
    )[0];
    expect(signInBtn).toBeDefined();
    signInBtn.props.onClick();
    tree = harness.render();

    // Enable Electron code exchange bridge and paste redirect URL containing dots in code
    (globalThis as any).window.electronAPI = {
      isElectron: true,
      exchangeCode: exchangeCodeSpy,
      syncStore: vi.fn().mockResolvedValue({ success: true, games: [] }),
    };

    const redirectInput = findElements(
      tree,
      (el) => el.type === 'input' && String(el.props?.placeholder || '').includes('oauth20_desktop.srf')
    )[0];
    expect(redirectInput).toBeDefined();

    const msDotCode = 'M.C507_BAY.2.U.a1b2c3d4-e5f6-7890-abcd-ef0123456789';
    redirectInput.props.onChange({
      target: {
        value: `https://login.live.com/oauth20_desktop.srf?code=${msDotCode}&lc=1033`,
      },
    });
    await flushMicrotasks();

    expect(exchangeCodeSpy).toHaveBeenCalledWith('xbox', msDotCode);
    harness.unmount();
  });

  it('renders Gamerscore badge, Game Pass subscription renewal pill, and accessible <fieldset>/<legend> sync-mode radios in IntegrationsModal', () => {
    saveIntegrations([
      {
        storefrontId: 'xbox',
        name: 'Xbox',
        isConnected: true,
        accountName: 'PlayerOne#1001',
        accountId: '2533274790395904',
        gamesCount: 18,
        authMethod: 'oauth',
        credentials: {},
      },
    ]);
    saveXboxProfileState({
      connected: true,
      gamertag: 'PlayerOne',
      modernGamertag: 'PlayerOne#1001',
      xuid: '2533274790395904',
      gamerscore: 24850,
      syncMode: 'owned_and_played',
      subscription: {
        hasActiveSubscription: true,
        hasPcCatalogAccess: true,
        tierId: 'ultimate',
        tierDisplayName: 'Xbox Game Pass Ultimate',
        endDate: '2027-03-15T00:00:00.000Z',
        autoRenew: true,
      },
    });

    expect(loadXboxProfileState()?.gamerscore).toBe(24850);

    const harness = createComponentHarness(IntegrationsModal, {
      isOpen: true,
      onClose: vi.fn(),
      onLibraryUpdated: vi.fn(),
    });

    let tree = harness.render();
    const xboxTabBtn = findElements(
      tree,
      (el) => el.type === 'button' && getTextContent(el).includes('Xbox')
    )[0];
    xboxTabBtn.props.onClick();
    tree = harness.render();

    const gsBadge = findElements(
      tree,
      (el) => el.props?.['data-testid'] === 'xbox-gamerscore-badge'
    )[0];
    expect(gsBadge).toBeDefined();
    expect(getTextContent(gsBadge)).toContain('24,850 G');

    const subPill = findElements(
      tree,
      (el) => el.props?.['data-testid'] === 'xbox-subscription-pill'
    )[0];
    expect(subPill).toBeDefined();
    expect(getTextContent(subPill)).toContain('Xbox Game Pass Ultimate');
    expect(getTextContent(subPill)).toContain('Renews');

    const fieldset = findElements(
      tree,
      (el) => el.type === 'fieldset' && el.props?.['data-testid'] === 'xbox-sync-mode-fieldset'
    )[0];
    expect(fieldset).toBeDefined();

    const legends = findElements(fieldset, (el) => el.type === 'legend');
    expect(legends.length).toBe(1);
    expect(getTextContent(legends[0])).toContain('Game Pass');

    const radios = findElements(
      fieldset,
      (el) => el.type === 'input' && el.props?.type === 'radio' && el.props?.name === 'xboxGamePassSyncMode'
    );
    expect(radios.map((r) => r.props.value)).toEqual([
      'owned_and_played',
      'full_pc_game_pass',
      'owned_only',
    ]);
    harness.unmount();
  });

  it('renders Xbox storefront tab and earned/total Gamerscore breakdown in GameAchievementsModal', async () => {
    vi.spyOn(achievementDetailService, 'fetchGameAchievements').mockResolvedValue({
      xbox: {
        storefrontId: 'xbox',
        storefrontName: 'Xbox',
        unlocked: 6,
        total: 12,
        percentage: 50,
        isMastered: false,
        earnedGamerscore: 320,
        totalGamerscore: 1000,
        source: 'live_cloud',
        achievements: [
          {
            id: 'xbox:19088743:1',
            apiName: '1',
            name: 'Synthetic Pioneer',
            description: 'Cleared Chapter 1',
            unlocked: true,
            unlockedAt: '2026-09-01T12:00:00.000Z',
            iconUnlockedUrl: 'https://images-eds.xboxlive.com/ach1.png',
            isSecret: false,
            gamerscore: 50,
            storefrontId: 'xbox',
          },
        ],
      },
    });

    const sampleGame = makeCanonicalGameFixture({
      id: 'xbox_9NTESTGAME01',
      title: 'Synthetic Horizon Adventure',
      platforms: [
        {
          platformId: 'xbox',
          platformGameId: '9NTESTGAME01',
          xboxProductId: '9NTESTGAME01',
          xboxTitleId: '19088743',
          installed: true,
        },
      ],
    });

    const harness = createComponentHarness(GameAchievementsModal, {
      isOpen: true,
      game: sampleGame,
      initialStorefrontId: 'xbox',
      onClose: vi.fn(),
    });

    harness.render();
    await flushMicrotasks();
    const tree = harness.render();

    const gsNode = findElements(
      tree,
      (el) => el.props?.['data-testid'] === 'achievements-modal-xbox-gamerscore'
    )[0];
    expect(gsNode).toBeDefined();
    expect(getTextContent(gsNode)).toContain('320');
    expect(getTextContent(gsNode)).toContain('1,000 G');
    expect(getTextContent(gsNode)).toContain('Xbox Gamerscore');
    harness.unmount();
  });

  it('renders macOS MSIXVC compatibility tier banners (Tier A status vs Tier C alert blocker) in GameInstallModal', async () => {
    vi.spyOn(launcherService, 'isWindowsHost').mockReturnValue(false);
    vi.spyOn(launcherService, 'getCompatibilityLayers').mockReturnValue([
      {
        type: 'crossover',
        name: 'CrossOver',
        available: true,
        version: '25.0',
        bottles: ['XboxBottle'],
      } as any,
    ]);
    vi.spyOn(launcherService, 'getDiskSpace').mockResolvedValue({
      targetPath: '/Users/testuser/Games/OneLauncher',
      freeBytes: 200 * 1024 * 1024 * 1024,
      totalBytes: 500 * 1024 * 1024 * 1024,
      usedBytes: 300 * 1024 * 1024 * 1024,
    });

    const getInstallInfoSpy = vi.spyOn(launcherService, 'getGameInstallInfo').mockResolvedValue({
      gameId: 'xbox_9NTESTGAME01',
      platformId: 'xbox',
      platformGameId: '9NTESTGAME01',
      canDirectDownload: true,
      defaultInstallDir: '/Users/testuser/Games/OneLauncher',
      estimatedSizeBytes: 20 * 1024 * 1024 * 1024,
      installers: [{ id: 'msixvc-x64', os: 'windows', label: 'Win32 GDK MSIXVC (x64)' }],
      xboxCompatibility: {
        tier: 'tier_a_supported',
        supportedOnMacBottle: true,
        label: 'Standard Win32 GDK x64 package ready for CrossOver / Wine.',
      },
    } as any);

    const xboxGame = makeCanonicalGameFixture({
      id: 'xbox_9NTESTGAME01',
      title: 'Synthetic Horizon Adventure',
      platforms: [
        {
          platformId: 'xbox',
          platformGameId: '9NTESTGAME01',
          xboxProductId: '9NTESTGAME01',
          installed: false,
        },
      ],
    });

    const harnessA = createComponentHarness(GameInstallModal, {
      game: xboxGame,
      initialPlatformId: 'xbox',
      isOpen: true,
      onClose: vi.fn(),
    });
    harnessA.render();
    await flushMicrotasks();
    const treeA = harnessA.render();

    const bannerA = findElements(
      treeA,
      (el) => el.props?.['data-testid'] === 'xbox-compat-tier-banner'
    )[0];
    expect(bannerA).toBeDefined();
    expect(bannerA.props.role).toBe('status');
    expect(getTextContent(bannerA)).toContain('Tier A');
    harnessA.unmount();

    // Now verify Tier C kernel anti-cheat renders role="alert" and blocks installation
    getInstallInfoSpy.mockResolvedValueOnce({
      gameId: 'xbox_9NTESTGAME01',
      platformId: 'xbox',
      platformGameId: '9NTESTGAME01',
      canDirectDownload: false,
      defaultInstallDir: '/Users/testuser/Games/OneLauncher',
      installers: [{ id: 'msixvc-x64', os: 'windows', label: 'Win32 GDK MSIXVC (x64)' }],
      xboxCompatibility: {
        tier: 'tier_c_kernel_anticheat',
        supportedOnMacBottle: false,
        label: 'Requires Windows kernel anti-cheat driver (EasyAntiCheat_EOS.sys).',
      },
    } as any);

    const harnessC = createComponentHarness(GameInstallModal, {
      game: xboxGame,
      initialPlatformId: 'xbox',
      isOpen: true,
      onClose: vi.fn(),
    });
    harnessC.render();
    await flushMicrotasks();
    const treeC = harnessC.render();

    const bannerC = findElements(
      treeC,
      (el) => el.props?.['data-testid'] === 'xbox-compat-tier-banner'
    )[0];
    expect(bannerC).toBeDefined();
    expect(bannerC.props.role).toBe('alert');
    expect(getTextContent(bannerC)).toContain('Tier C');
    harnessC.unmount();
  });

  it('omits active Game Pass / Leaving Soon pills next to Play/Install while preserving Subscription Expired Xbox Store CTA in SteamLibraryActionBar', () => {
    vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(true);
    vi.spyOn(launcherService, 'isGameRunning').mockReturnValue(false);
    vi.spyOn(launcherService, 'getRunningGames').mockReturnValue([]);
    vi.spyOn(launcherService, 'getActiveDownload').mockReturnValue(undefined);

    const activeStandardGpGame = makeCanonicalGameFixture({
      id: 'xbox_9NTESTGAME01',
      title: 'Synthetic Horizon Adventure',
      platforms: [
        {
          platformId: 'xbox',
          platformGameId: '9NTESTGAME01',
          xboxProductId: '9NTESTGAME01',
          installed: true,
          installPath: '/Users/testuser/Games/OneLauncher/SyntheticHorizon',
          ownershipType: 'subscription',
          isLeavingSoon: false,
          subscriptionExpired: false,
          playtimeMinutes: 60,
        },
      ],
    });

    const harnessStandard = createComponentHarness(SteamLibraryActionBar, {
      game: activeStandardGpGame,
    } as any);
    const standardTree = harnessStandard.render();
    const gpPillStandard = findElements(
      standardTree,
      (el) => el.props?.['data-testid'] === 'actionbar-xbox-gamepass-pill'
    )[0];
    expect(gpPillStandard).toBeUndefined();
    harnessStandard.unmount();

    const activeLeavingSoonGpGame: CanonicalGame = {
      ...activeStandardGpGame,
      platforms: [
        {
          ...activeStandardGpGame.platforms[0],
          isLeavingSoon: true,
          subscriptionExpired: false,
        },
      ],
    };

    const harnessActive = createComponentHarness(SteamLibraryActionBar, {
      game: activeLeavingSoonGpGame,
    } as any);
    const activeTree = harnessActive.render();

    const gpPill = findElements(
      activeTree,
      (el) => el.props?.['data-testid'] === 'actionbar-xbox-gamepass-pill'
    )[0];
    expect(gpPill).toBeUndefined();
    harnessActive.unmount();

    // Expired subscription on locally installed game -> renders Xbox Store CTA link
    const expiredGpGame: CanonicalGame = {
      ...activeStandardGpGame,
      platforms: [
        {
          ...activeStandardGpGame.platforms[0],
          isLeavingSoon: false,
          subscriptionExpired: true,
        },
      ],
    };

    const harnessExpired = createComponentHarness(SteamLibraryActionBar, {
      game: expiredGpGame,
    } as any);
    const expiredTree = harnessExpired.render();

    const expiredCta = findElements(
      expiredTree,
      (el) => el.props?.['data-testid'] === 'xbox-expired-store-cta'
    )[0];
    expect(expiredCta).toBeDefined();
    expect(expiredCta.props.href).toBe('https://www.xbox.com/games/store/-/9NTESTGAME01');
    expect(getTextContent(expiredCta)).toContain('Subscription Expired');
    harnessExpired.unmount();
  });
});

