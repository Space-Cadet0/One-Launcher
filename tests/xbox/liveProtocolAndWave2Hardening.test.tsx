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

// 8. Live Protocol Parity Regressions (OAuth Scope, TokenBroker 2-Leg, PCGAFD Object Maps, PascalCase Delivery & UserStats)
// ===========================================================================

describe('8. Live Protocol Parity Regressions (OAuth Scope, TokenBroker, PCGAFD Object Maps & PascalCase Delivery)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-xbox-parity-test-'));
  });

  afterEach(() => {
    xboxCatalogAndGamePass.closeXboxCatalogCacheStore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('never sends unpreauthorized service::www.microsoft.com::MBI_SSL to oauth20_token.srf and resolves XBL3.0 mpXsts for PCGAFD', async () => {
    const oauthBodies: string[] = [];

    const mockFetch = vi.fn(async (urlInput: string | URL, init?: RequestInit) => {
      const url = String(urlInput);
      const bodyText =
        typeof init?.body === 'string'
          ? init.body
          : Buffer.isBuffer(init?.body)
            ? init.body.toString('utf8')
            : init?.body instanceof Uint8Array
              ? Buffer.from(init.body).toString('utf8')
              : '';

      if (url.includes('login.live.com/oauth20_token.srf')) {
        oauthBodies.push(bodyText);
        if (bodyText.includes('www.microsoft.com')) {
          return new Response(
            JSON.stringify({
              error: 'invalid_scope',
              error_description:
                "The provided value for the input parameter 'scope' has not been pre-authorized for this client application.",
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            access_token: 'EwB.synthetic_xbl_access_token',
            refresh_token: 'M.C507_SN1.2.U.synthetic_refresh_token',
            expires_in: 3600,
            user_id: '0003BFFD00001234',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('user.auth.xboxlive.com/user/authenticate')) {
        return new Response(
          JSON.stringify({
            Token: 'xasu-token-synthetic',
            NotAfter: new Date(Date.now() + 86400_000).toISOString(),
            DisplayClaims: { xui: [{ uhs: '8877665544332211' }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('xsts.auth.xboxlive.com/xsts/authorize')) {
        const parsed = JSON.parse(bodyText || '{}');
        const rp = parsed?.RelyingParty || parsed?.Properties?.RelyingParty || '';
        const tokenLabel = rp.includes('mp.microsoft.com') ? 'mp-xsts-jwt' : 'xbl-xsts-jwt';
        return new Response(
          JSON.stringify({
            Token: tokenLabel,
            NotAfter: new Date(Date.now() + 3600_000).toISOString(),
            DisplayClaims: {
              xui: [
                {
                  uhs: '8877665544332211',
                  xid: '2533274790395904',
                  gtg: 'SyntheticPilot',
                  mgt: 'SyntheticPilot',
                  agg: 'Adult',
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('profile.xboxlive.com')) {
        return new Response(
          JSON.stringify({
            profileUsers: [
              {
                id: '2533274790395904',
                settings: [
                  { id: 'Gamertag', value: 'SyntheticPilot' },
                  { id: 'Gamerscore', value: '14250' },
                  { id: 'GameDisplayPicRaw', value: 'https://images-eds-ssl.xboxlive.com/avatar.png' },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected fetch URL in OAuth test: ${url}`);
    });

    const provider = xboxAuthManager.createXboxAuthProvider({
      userDataDir: tmpDir,
      tokenVault,
      fetchImpl: mockFetch,
    });

    const session = await provider.exchangeAuthCode('M.C507_SN1.2.U.synthetic_auth_code');
    expect(session.gamertag).toBe('SyntheticPilot');
    expect(oauthBodies.length).toBe(1);
    expect(oauthBodies[0]).toContain('user.auth.xboxlive.com');
    expect(oauthBodies[0]).not.toContain('www.microsoft.com');

    // PCGAFD resolves XBL3.0 x=<uhs>;<mpXsts> cleanly, whereas licensing returns '' when no compact MSA storeTicket exists
    const pcgafdAuth = await provider.getStoreMsaToken({ target: 'pcgafd' });
    expect(pcgafdAuth).toBe('XBL3.0 x=8877665544332211;mp-xsts-jwt');

    const licensingTicket = await provider.getStoreMsaToken({ target: 'licensing' });
    expect(licensingTicket).toBe('');
  });

  it('builds InlineLogin.srf request headers and executes 2-leg exchangeTokenBrokerDaProperty with independent EncryptedPP + Body SP800-108 decryption', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;

    // Build authentic 284-byte ClepHmacState BinarySecret wrapping clepHmacSecret
    const clepHmacSecret = Buffer.alloc(32, 0xaa);
    const scheduleKey = Buffer.alloc(16, 0x55);
    const scheduleBuf = xboxDeviceClep.buildKeyScheduleForTargetKey(scheduleKey);
    const plain48 = Buffer.concat([Buffer.alloc(12, 0), clepHmacSecret, Buffer.alloc(4, 0)]);
    const enc48 = xboxDeviceClep.encryptCbcZeroIv(scheduleKey, plain48);
    const hmacStateBuf = Buffer.alloc(284, 0);
    hmacStateBuf.writeUInt32LE(1, 0);
    enc48.copy(hmacStateBuf, 4);
    scheduleBuf.copy(hmacStateBuf, 52);

    function encryptSoapBlockWithDerivedKey(
      plainXml: string,
      keyId: string
    ): { derivedKeyTokenXml: string; encryptedDataXml: string } {
      const nonce = crypto.randomBytes(32);
      const aesKey = xboxDeviceClep.deriveDoubleDerivedHmacKey(clepHmacSecret, nonce);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
      const encryptedPayload = Buffer.concat([
        iv,
        cipher.update(Buffer.from(plainXml, 'utf8')),
        cipher.final(),
      ]);
      const derivedKeyTokenXml =
        `<wssc:DerivedKeyToken xmlns:wssc="http://schemas.xmlsoap.org/ws/2005/02/sc" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" wsu:Id="${keyId}">` +
        `<wssc:Nonce>${nonce.toString('base64')}</wssc:Nonce>` +
        `</wssc:DerivedKeyToken>`;
      const encryptedDataXml =
        `<EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#" Type="http://www.w3.org/2001/04/xmlenc#Element">` +
        `<EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/>` +
        `<KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
        `<wsse:SecurityTokenReference xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">` +
        `<wsse:Reference URI="#${keyId}"/>` +
        `</wsse:SecurityTokenReference></KeyInfo>` +
        `<CipherData><CipherValue>${encryptedPayload.toString('base64')}</CipherValue></CipherData>` +
        `</EncryptedData>`;
      return { derivedKeyTokenXml, encryptedDataXml };
    }

    // Seed pre-provisioned device context so unit test never calls network deviceaddcredential.srf
    tokenVault.saveTokens(
      'xbox',
      {
        deviceContext: {
          deviceMembername: '02abcdefghijklmn',
          devicePassword: 'syntheticpassword1234',
          clepRsaKeyPem: privatePem,
          deviceKeyHex: '00112233445566778899aabbccddeeff',
          deviceDat: 't=synthetic_device_compact_ticket&p=',
          deviceMsToken: 't=synthetic_device_compact_ticket&p=',
          deviceDatExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
          deviceLegacyTokenXml:
            '<EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#" Id="Assertion0"><CipherData><CipherValue>SYNTHETIC_DEVICE_XML</CipherValue></CipherData></EncryptedData>',
          deviceBinarySecretB64: hmacStateBuf.toString('base64'),
        },
      },
      { userDataDir: tmpDir }
    );

    const inlineReq = xboxAuthManager.buildInlineLoginRequest({
      url: '',
      deviceMsToken: 't=synthetic_device_compact_ticket&p=',
    });
    expect(inlineReq.url.startsWith(xboxAuthManager.MSA_INLINE_LOGIN_URL)).toBe(true);
    expect(inlineReq.url).toContain('clientid=000000004424da1f');
    expect(inlineReq.userAgent).toBe(xboxAuthManager.CXH_USER_AGENT);
    expect(inlineReq.userAgent).toContain('MSAppHost/3.0');
    expect(inlineReq.headers['cxh-protocol']).toBe('TokenBroker');
    expect(inlineReq.headers.hostapp).toBe('CloudExperienceHost');
    expect(inlineReq.headers['cxh-correlationid']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(xboxAuthManager.isTrustedXboxAuthUrl('https://login.live.com/ppsecure/post.srf')).toBe(true);
    expect(xboxAuthManager.isTrustedXboxAuthUrl('http://login.live.com/InlineLogin.srf')).toBe(false);
    expect(xboxAuthManager.isTrustedXboxAuthUrl('https://evil.example.com/login.live.com')).toBe(false);

    let rst2CallIndex = 0;
    const mockFetch = vi.fn(async (urlInput: string | URL, init?: RequestInit) => {
      const url = String(urlInput);
      const body = typeof init?.body === 'string' ? init.body : '';

      if (url.includes('login.live.com/RST2.srf')) {
        rst2CallIndex += 1;
        // Leg 1 returns psf:inlineauthurl (0x80048853 consent required) inside encrypted Header PP
        if (rst2CallIndex === 1) {
          const ppEnc = encryptSoapBlockWithDerivedKey(
            `<psf:pp xmlns:psf="http://schemas.microsoft.com/Passport/SoapServices/SOAPFault">` +
              `<psf:inlineauthurl>https://login.live.com/InlineLogin.srf?id=80604&amp;contextid=2</psf:inlineauthurl>` +
              `</psf:pp>`,
            'EncKeyPP1'
          );
          const faultBody =
            `<s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>wst:FailedAuthentication</s:Value></s:Subcode></s:Code>` +
            `<s:Detail><psf:error xmlns:psf="http://schemas.microsoft.com/Passport/SoapServices/SOAPFault"><psf:value>0x80048853</psf:value></psf:error></s:Detail></s:Fault>`;
          return new Response(
            `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">` +
              `<s:Header><wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">${ppEnc.derivedKeyTokenXml}</wsse:Security>` +
              `<psf:EncryptedPP xmlns:psf="http://schemas.microsoft.com/Passport/SoapServices/SOAPFault">${ppEnc.encryptedDataXml}</psf:EncryptedPP></s:Header>` +
              `<s:Body>${faultBody}</s:Body></s:Envelope>`,
            { status: 200, headers: { 'Content-Type': 'application/soap+xml' } }
          );
        }

        // Leg 2 / Subsequent RST2 exchanges: use TWO DISTINCT derived keys for EncryptedPP vs Body!
        const ppEnc = encryptSoapBlockWithDerivedKey(
          `<psf:pp xmlns:psf="http://schemas.microsoft.com/Passport/SoapServices/SOAPFault"><psf:credProperties><psf:credProperty Name="CID">abcd1234ef567890</psf:credProperty></psf:credProperties></psf:pp>`,
          'EncKeyPP2'
        );

        const rstrItems: string[] = [];
        if (body.includes('user.auth.xboxlive.com')) {
          rstrItems.push(
            `<wst:RequestSecurityTokenResponse>` +
              `<wst:TokenType>urn:passport:compact</wst:TokenType>` +
              `<wsp:AppliesTo xmlns:wsp="http://schemas.xmlsoap.org/ws/2004/09/policy"><wsa:EndpointReference xmlns:wsa="http://www.w3.org/2005/08/addressing"><wsa:Address>user.auth.xboxlive.com</wsa:Address></wsa:EndpointReference></wsp:AppliesTo>` +
              `<wst:Lifetime><wsu:Expires xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${new Date(Date.now() + 28800_000).toISOString()}</wsu:Expires></wst:Lifetime>` +
              `<wst:RequestedSecurityToken><wsse:BinarySecurityToken xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" Id="Compact0">t=compact_xbl_rps_ticket&amp;p=</wsse:BinarySecurityToken></wst:RequestedSecurityToken>` +
              `</wst:RequestSecurityTokenResponse>`
          );
        }
        if (body.includes('http://Passport.NET/tb')) {
          rstrItems.push(
            `<wst:RequestSecurityTokenResponse>` +
              `<wst:TokenType>urn:passport:legacy</wst:TokenType>` +
              `<wsp:AppliesTo xmlns:wsp="http://schemas.xmlsoap.org/ws/2004/09/policy"><wsa:EndpointReference xmlns:wsa="http://www.w3.org/2005/08/addressing"><wsa:Address>http://Passport.NET/tb</wsa:Address></wsa:EndpointReference></wsp:AppliesTo>` +
              `<wst:RequestedSecurityToken><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#" Id="AssertionUserTb"><CipherData><CipherValue>USER_TB_LEGACY_BLOB</CipherValue></CipherData></EncryptedData></wst:RequestedSecurityToken>` +
              `<wst:RequestedProofToken><wst:BinarySecret>${Buffer.alloc(32, 0x42).toString('base64')}</wst:BinarySecret></wst:RequestedProofToken>` +
              `</wst:RequestSecurityTokenResponse>`
          );
        }
        if (body.includes('www.microsoft.com')) {
          rstrItems.push(
            `<wst:RequestSecurityTokenResponse>` +
              `<wst:TokenType>urn:passport:compact</wst:TokenType>` +
              `<wsp:AppliesTo xmlns:wsp="http://schemas.xmlsoap.org/ws/2004/09/policy"><wsa:EndpointReference xmlns:wsa="http://www.w3.org/2005/08/addressing"><wsa:Address>www.microsoft.com</wsa:Address></wsa:EndpointReference></wsp:AppliesTo>` +
              `<wst:Lifetime><wsu:Expires xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${new Date(Date.now() + 28800_000).toISOString()}</wsu:Expires></wst:Lifetime>` +
              `<wst:RequestedSecurityToken><wsse:BinarySecurityToken xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" Id="Compact0">t=compact_store_msa_ticket_live&amp;p=</wsse:BinarySecurityToken></wst:RequestedSecurityToken>` +
              `</wst:RequestSecurityTokenResponse>`
          );
        }
        const rstrPlain =
          `<wst:RequestSecurityTokenResponseCollection xmlns:wst="http://schemas.xmlsoap.org/ws/2005/02/trust">` +
          rstrItems.join('') +
          `</wst:RequestSecurityTokenResponseCollection>`;

        const bodyEnc = encryptSoapBlockWithDerivedKey(rstrPlain, 'EncKeyBody2');
        return new Response(
          `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">` +
            `<s:Header><wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">${ppEnc.derivedKeyTokenXml}${bodyEnc.derivedKeyTokenXml}</wsse:Security>` +
            `<psf:EncryptedPP xmlns:psf="http://schemas.microsoft.com/Passport/SoapServices/SOAPFault">${ppEnc.encryptedDataXml}</psf:EncryptedPP></s:Header>` +
            `<s:Body>${bodyEnc.encryptedDataXml}</s:Body></s:Envelope>`,
          { status: 200, headers: { 'Content-Type': 'application/soap+xml' } }
        );
      }

      if (url.includes('user.auth.xboxlive.com/user/authenticate')) {
        return new Response(
          JSON.stringify({
            Token: 'xasu-tb-token',
            NotAfter: new Date(Date.now() + 86400_000).toISOString(),
            DisplayClaims: { xui: [{ uhs: '998877665544' }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('xsts.auth.xboxlive.com/xsts/authorize')) {
        return new Response(
          JSON.stringify({
            Token: 'xsts-tb-token',
            NotAfter: new Date(Date.now() + 3600_000).toISOString(),
            DisplayClaims: {
              xui: [{ uhs: '998877665544', xid: '2533274799999999', gtg: 'InlineBrokerPilot' }],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('profile.xboxlive.com')) {
        return new Response(
          JSON.stringify({ profileUsers: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected fetch URL in TokenBroker test: ${url}`);
    });

    const provider = xboxAuthManager.createXboxAuthProvider({
      userDataDir: tmpDir,
      tokenVault,
      fetchImpl: mockFetch,
    });

    const syntheticDaProp = {
      UserName: 'pilot@example.test',
      PUID: '0003BFFDAA11BB22',
      sDAToken:
        '<EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#" Id="AssertionDA"><CipherData><CipherValue>DA_CIPHER</CipherValue></CipherData></EncryptedData>',
      sDASessionKey: Buffer.alloc(32, 0x33).toString('base64'),
    };

    // Leg 1 -> returns inlineAuthUrl continuation
    const leg1 = await provider.exchangeTokenBrokerDaProperty(syntheticDaProp, {
      isSecondLeg: false,
    });
    expect(leg1.requiresInlineConsent).toBe(true);
    expect(leg1.inlineAuthUrl).toBe('https://login.live.com/InlineLogin.srf?id=80604&contextid=2');

    // Leg 2 -> mints both Passport.NET/tb userStsLegacyTokenXml and compact storeTicket (`t=...&p=`)!
    const leg2 = await provider.exchangeTokenBrokerDaProperty(syntheticDaProp, {
      isSecondLeg: true,
    });
    expect(leg2.gamertag).toBe('InlineBrokerPilot');

    const licensingTicket = await provider.getStoreMsaToken({ target: 'licensing' });
    expect(licensingTicket).toBe('t=compact_store_msa_ticket_live&p=');
  });

  it('parses PCGAFD object-map entitlements, propagates recursive satisfiedByProductId ownership, excludes shared/subscription parents, and parses PascalCase packagespc PackageFiles', async () => {
    let capturedSubBody: any = null;

    const mockFetch = vi.fn(async (urlInput: string | URL, init?: RequestInit) => {
      const url = String(urlInput);
      if (url.includes('/PCGAFD/entitlements/subscriptions')) {
        capturedSubBody = JSON.parse(String(init?.body || '{}'));
        return new Response(
          JSON.stringify({
            entitlements: {
              CFQ7TTC0KGQ8: {
                status: 'Active',
                endDate: '2099-01-01T00:00:00Z',
                autoRenew: true,
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/PCGAFD/entitlements')) {
        return new Response(
          JSON.stringify({
            entitlements: {
              // Root bundle permanently owned
              '9NROOTBNDL01': {
                status: 'Active',
                sharingSource: 'None',
                isTrial: false,
                skuId: '0010',
              },
              // Child satisfied by owned root bundle -> inherits permanent ownership!
              '9NCHLDGAME01': {
                status: 'Active',
                sharingSource: 'None',
                isTrial: false,
                satisfiedByProductId: '9NROOTBNDL01',
                skuId: '0010',
              },
              // Child satisfied by PC Game Pass CFQ7TTC0KGQ8 -> subscription, NOT permanent ownership!
              '9NSUBSGAME01': {
                status: 'Active',
                sharingSource: 'None',
                isTrial: false,
                satisfiedByProductId: 'CFQ7TTC0KGQ8',
                skuId: '0010',
              },
              // Shared from another account (`sharingSource: 'External'`) -> excluded from permanent ownership!
              '9NSHRDGAME01': {
                status: 'Active',
                sharingSource: 'External',
                isTrial: false,
                skuId: '0010',
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('displaycatalog.mp.microsoft.com')) {
        return new Response(
          JSON.stringify({
            Products: [buildDisplayCatalogGameFixture({ productId: '9NCHLDGAME01' })],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('packagespc.xboxlive.com/GetBasePackage/')) {
        // Exact live PascalCase response shape verified against production packagespc.xboxlive.com!
        return new Response(
          JSON.stringify({
            PackageFound: true,
            ContentId: 'aabbccdd-1122-3344-5566-77889900aabb',
            PackageFiles: [
              {
                ContentId: 'aabbccdd-1122-3344-5566-77889900aabb',
                FileName: 'SyntheticHorizon_1.0.0.0_x64.msixvc',
                FileSize: 4294967296,
                KeyBlob: 'ekb-live-001',
                CdnRootPaths: ['https://assets1.xboxlive.com', 'https://assets2.xboxlive.com'],
                RelativeUrl: '/12/34/SyntheticHorizon_1.0.0.0_x64.msixvc',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected fetch URL in PCGAFD/packagespc test: ${url}`);
    });

    const sub = await xboxCatalogAndGamePass.detectXboxSubscriptions({
      storeToken: 'XBL3.0 x=12345;mp-xsts-jwt',
      fetchImpl: mockFetch,
    });
    expect(sub.hasActiveSubscription).toBe(true);
    expect(sub.tierId).toBe('pc');
    // Body must contain ONLY productIds (market/language live in query string)
    expect(Object.keys(capturedSubBody)).toEqual(['productIds']);

    const ents = await xboxCatalogAndGamePass.fetchXboxOwnedEntitlements({
      storeToken: 'XBL3.0 x=12345;mp-xsts-jwt',
      fetchImpl: mockFetch,
    });
    expect(ents.ownedProductIds).toContain('9NROOTBNDL01');
    expect(ents.ownedProductIds).toContain('9NCHLDGAME01');
    expect(ents.ownedProductIds).not.toContain('9NSUBSGAME01');
    expect(ents.ownedProductIds).not.toContain('9NSHRDGAME01');

    const deliv = await xboxCatalogAndGamePass.resolveXboxPackageDeliveryInfo({
      storeId: '9NCHLDGAME01',
      userDataDir: tmpDir,
      authProvider: {
        getXstsToken: async () => ({ authorizationHeader: 'XBL3.0 x=12345;update-xsts' }),
      },
      fetchImpl: mockFetch,
    });
    expect(deliv.primaryDownloadUrl).toBe(
      'https://assets1.xboxlive.com/12/34/SyntheticHorizon_1.0.0.0_x64.msixvc'
    );
    expect(deliv.maxDownloadSizeBytes).toBe(4294967296);
    expect(deliv.packageFiles).toHaveLength(1);
  });

  it('sends stats without Hero groups in fetchXboxPlaytimeBatch (> 10 titles) and MKMS_CONTENT_CLIENT_CHALLENGE in acquireContentCik Attempt 1', async () => {
    let capturedUserStatsBody: any = null;
    let capturedContentLicenseBody: any = null;

    const deviceKey16 = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const rawCik32 = Buffer.alloc(32, 0x5a);
    const wrappedCik40 = xboxDeviceClep.wrapContentCik(rawCik32, deviceKey16);
    const keyIdBuf = xboxDeviceClep.encodeMixedEndianGuid('11223344-5566-7788-99aa-bbccddeeff00');
    // Build minimal synthetic SPLicenseBlock TLV containing BLOCK_ID.PACKED_CONTENT_KEYS (u16 idLen=16, u16 keyLen=40, 16B GUID, 40B wrappedCIK)
    const entryHdr = Buffer.alloc(4, 0);
    entryHdr.writeUInt16LE(16, 0);
    entryHdr.writeUInt16LE(40, 2);
    const entryPayload = Buffer.concat([entryHdr, keyIdBuf, wrappedCik40]);
    const spHeader = Buffer.alloc(8, 0);
    const tagHdr = Buffer.alloc(8, 0);
    tagHdr.writeUInt32LE(xboxDeviceClep.BLOCK_ID.PACKED_CONTENT_KEYS, 0);
    tagHdr.writeUInt32LE(entryPayload.length, 4);
    const unsignedSpBuf = Buffer.concat([spHeader, tagHdr, entryPayload]);

    // Unsigned SPLicense missing Tag 0x0101 / 0x00cc must fail closed!
    expect(() =>
      xboxDeviceClep.parseSpLicenseBuffer(unsignedSpBuf, { verifyCmacWithKey: deviceKey16 })
    ).toThrow('SPLicense missing required signature tag (expected 0x0101 AES-CMAC or 0x00cc SIGNATURE_BLOCK)');

    // Sign SPLicense with valid AES-128-CMAC Tag 0x0101 over preceding TLV bytes
    const cmacTag16 = xboxDeviceClep.aes128Cmac(deviceKey16, unsignedSpBuf);
    const cmacHdr = Buffer.alloc(8, 0);
    cmacHdr.writeUInt32LE(xboxDeviceClep.BLOCK_ID.CMAC_SIGNATURE, 0);
    cmacHdr.writeUInt32LE(cmacTag16.length, 4);
    const spBuf = Buffer.concat([unsignedSpBuf, cmacHdr, cmacTag16]);
    const outerXml = `<LicenseResponse><SPLicenseBlock>${spBuf.toString('base64')}</SPLicenseBlock></LicenseResponse>`;

    const mockFetch = vi.fn(async (urlInput: string | URL, init?: RequestInit) => {
      const url = String(urlInput);
      const bodyObj = JSON.parse(String(init?.body || '{}'));
      if (url.includes('userstats.xboxlive.com/batch')) {
        capturedUserStatsBody = bodyObj;
        return new Response(
          JSON.stringify({
            statlistscollection: [
              {
                stats: bodyObj.stats.map((s: any, idx: number) => ({
                  titleid: s.titleId,
                  name: 'MinutesPlayed',
                  value: String((idx + 1) * 15),
                })),
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('licensing.mp.microsoft.com/v7.0/licenses/content')) {
        capturedContentLicenseBody = bodyObj;
        return new Response(
          JSON.stringify({
            license: {
              keys: [{ value: Buffer.from(outerXml, 'utf8').toString('base64') }],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    // 25 titleIds (> 10): must NOT include `groups` (which triggers HTTP 400 InvalidRequestError on live Xbox UserStats!)
    const twentyFiveTitleIds = Array.from({ length: 25 }, (_, i) => String(18000000 + i));
    const ptMap = await xboxAchievementsAndStats.fetchXboxPlaytimeBatch({
      xuid: '2533274790395904',
      authorizationHeader: 'XBL3.0 x=12345;xbl-xsts',
      titleIds: twentyFiveTitleIds,
      fetchImpl: mockFetch,
    });
    expect(capturedUserStatsBody.groups).toBeUndefined();
    expect(capturedUserStatsBody.stats).toHaveLength(25);
    expect(ptMap.size).toBe(25);
    expect(ptMap.get('18000000')).toBe(15);

    const cikRes = await xboxDeviceClep.acquireContentCik({
      contentId: 'aabbccdd-1122-3344-5566-77889900aabb',
      packageFullNames: ['Publisher.SampleGame_1.0.0.0_x64__8wekyb3d8bbwe'],
      msaStoreToken: 't=compact_msa_ticket&p=',
      localTicketReference: '0003BFFDAA11BB22',
      deviceContext: {
        deviceMsToken: 't=device_compact_ticket&p=',
        deviceKeyBuffer: deviceKey16,
      },
      fetchImpl: mockFetch,
    });

    expect(capturedContentLicenseBody.clientChallenge).toBe(
      xboxDeviceClep.MKMS_CONTENT_CLIENT_CHALLENGE
    );
    expect(capturedContentLicenseBody.packageFullNames).toBeUndefined();
    const userGroup = Object.values(capturedContentLicenseBody.users)[0] as any[];
    expect(userGroup[0].localTicketReference).toBe('0003BFFDAA11BB22');
    expect(cikRes.cikBuffer.equals(rawCik32)).toBe(true);
  });
});

// ===========================================================================
// 9. Clean Xbox Titles, Cross-Storefront Deduplication, Xbox Sphere Logo & On-Demand Store License Recovery
// ===========================================================================

describe('9. Clean Xbox Titles, Cross-Storefront Deduplication, Xbox Sphere Logo & On-Demand Store License Recovery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-xbox-ux-dl-test-'));
  });

  afterEach(() => {
    launcherEngine.setXboxStoreLicenseRecoveryHook(null);
    launcherEngine.clearDownloadQueue({ includeActive: true });
    xboxCatalogAndGamePass.closeXboxCatalogCacheStore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('strips all Microsoft Store / Xbox PC disambiguators in both TS and CJS without mutating natural-language game titles', () => {
    const cases: Array<[string, string]> = [
      ['Fallout 76 (PC)', 'Fallout 76'],
      ['Quake (PC)', 'Quake'],
      ['Wolfenstein: The Old Blood (PC)', 'Wolfenstein: The Old Blood'],
      ['DOOM Eternal (BATTLEMODE - PC)', 'DOOM Eternal (BATTLEMODE)'],
      ['Battlefield™ 6 - PC', 'Battlefield™ 6'],
      ['EA SPORTS FC™ 26 - PC', 'EA SPORTS FC™ 26'],
      ['Cities: Skylines II - PC Edition', 'Cities: Skylines II'],
      ['Cities: Skylines - Windows 10 Edition', 'Cities: Skylines'],
      ['Minecraft Legends - Windows', 'Minecraft Legends'],
      ['SnowRunner - Windows', 'SnowRunner'],
      ['Minecraft for Windows', 'Minecraft'],
      ['Minecraft Dungeons for Windows', 'Minecraft Dungeons'],
      ['Call of Duty®: WWII (Windows)', 'Call of Duty®: WWII'],
      ['Genesis Noir: Windows Edition', 'Genesis Noir'],
      ['Diablo® IV PC', 'Diablo® IV'],
      ['VALORANT PC', 'VALORANT'],
      ["Shadowrun: Dragonfall - Director's Cut PC", "Shadowrun: Dragonfall - Director's Cut"],
      ['Dead by Daylight Windows', 'Dead by Daylight'],
      ['Cooking Simulator Windows', 'Cooking Simulator'],
      ['9 Kings (Game Preview)', '9 Kings'],
      ['Grounded 2 (Game Preview) (PC)', 'Grounded 2'],
      // Natural-language titles that MUST NEVER be truncated:
      ['PC Building Simulator', 'PC Building Simulator'],
      ['PC Building Simulator 2', 'PC Building Simulator 2'],
      ['Build My PC', 'Build My PC'],
      ['Upgrade Your PC', 'Upgrade Your PC'],
      ['Broken Windows', 'Broken Windows'],
      ['Through the Windows', 'Through the Windows'],
    ];

    for (const [raw, expected] of cases) {
      expect(stripStorefrontPlatformDisambiguators(raw)).toBe(expected);
      expect(xboxCatalogAndGamePass.stripXboxPlatformDisambiguators(raw)).toBe(expected);
    }

    // Verify DisplayCatalog evaluation emits clean title while retaining rawTitle
    const evaluated = xboxCatalogAndGamePass.evaluateDisplayCatalogProduct({
      ProductId: '9P1Z43KRNQD4',
      ProductKind: 'Game',
      LocalizedProperties: [
        {
          ProductTitle: 'Quake (PC)',
          DeveloperName: 'id Software',
          PublisherName: 'Bethesda Softworks',
          Images: [],
        },
      ],
      MarketProperties: [{}],
      Properties: { PackageFamilyName: 'BethesdaSoftworks.ProjectSilver_3275kfvn8vcwc' },
      DisplaySkuAvailabilities: [
        {
          Sku: {
            SkuId: '0010',
            Properties: {
              Packages: [
                {
                  PackageFormat: 'Msixvc',
                  PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }],
                  Architectures: ['x64'],
                  ContentId: '11223344-5566-7788-99aa-bbccddeeff00',
                  PackageFullName: 'BethesdaSoftworks.ProjectSilver_1.0.0.0_x64__3275kfvn8vcwc',
                },
              ],
            },
          },
        },
      ],
    });
    expect(evaluated.eligible).toBe(true);
    expect(evaluated.title).toBe('Quake');
    expect(evaluated.rawTitle).toBe('Quake (PC)');
  });

  it('retroactively cleans persisted "(PC)" / "- PC" Xbox titles and merges cross-storefront duplicates in any element order', () => {
    const xboxQuake = makeCanonicalGameFixture({
      id: 'xbox-9P1Z43KRNQD4',
      title: 'Quake (PC)',
      isVerifiedEntitlement: true,
      platforms: [
        {
          platformId: 'xbox',
          platformGameId: '9P1Z43KRNQD4',
          storefrontAppId: '9P1Z43KRNQD4',
          xboxProductId: '9P1Z43KRNQD4',
          ownershipType: 'owned',
          installed: false,
        },
      ],
      enrichedMetadata: {
        name: 'Quake (PC)',
        shortDescription: 'Dark fantasy FPS.',
        detailedDescription: 'Dark fantasy FPS.',
        aboutTheGame: 'Dark fantasy FPS.',
        headerImage: 'https://store-images.s-microsoft.com/quake-hero.jpg',
        developers: ['id Software'],
        publishers: ['Bethesda Softworks'],
        genres: ['Action'],
        categories: [],
        screenshots: [],
        movies: [],
        releaseDate: '1996-06-22',
        platforms: { windows: true, mac: false, linux: false },
        xboxDeliveryHints: {
          contentId: '11223344-5566-7788-99aa-bbccddeeff00',
          packageFullName: 'BethesdaSoftworks.ProjectSilver_1.0.0.0_x64__3275kfvn8vcwc',
        },
      } as any,
    });

    const steamQuake = makeCanonicalGameFixture({
      id: 'steam-2310',
      steamAppId: 2310,
      title: 'Quake',
      isVerifiedEntitlement: true,
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2310/header.jpg',
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '2310',
          installed: false,
        },
      ],
    });

    const xboxBattlefield = makeCanonicalGameFixture({
      id: 'xbox-9NBATTLEFLD6',
      title: 'Battlefield™ 6 - PC',
      isVerifiedEntitlement: true,
      platforms: [
        {
          platformId: 'xbox',
          platformGameId: '9NBATTLEFLD6',
          xboxProductId: '9NBATTLEFLD6',
          ownershipType: 'owned',
          installed: false,
        },
      ],
    });

    const steamBattlefield = makeCanonicalGameFixture({
      id: 'steam-2807960',
      steamAppId: 2807960,
      title: 'Battlefield 6',
      isVerifiedEntitlement: true,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '2807960',
          installed: false,
        },
      ],
    });

    // Order A: Steam first, Xbox second
    const sanitizedOrderA = sanitizeGameCatalog(
      [steamQuake, xboxQuake, steamBattlefield, xboxBattlefield],
      { allowNewPurchases: true, validSteamAppIds: new Set([2310, 2807960]) }
    );
    expect(sanitizedOrderA).toHaveLength(2);
    const mergedQuakeA = sanitizedOrderA.find((g) => g.steamAppId === 2310)!;
    expect(mergedQuakeA.title).toBe('Quake');
    expect(mergedQuakeA.platforms.map((p) => p.platformId).sort()).toEqual(['steam', 'xbox']);
    expect((mergedQuakeA.enrichedMetadata as any)?.xboxDeliveryHints?.contentId).toBe(
      '11223344-5566-7788-99aa-bbccddeeff00'
    );

    // Order B: Xbox first, Steam second — must produce identical canonical title & merged platforms
    const sanitizedOrderB = sanitizeGameCatalog(
      [xboxQuake, steamQuake, xboxBattlefield, steamBattlefield],
      { allowNewPurchases: true, validSteamAppIds: new Set([2310, 2807960]) }
    );
    expect(sanitizedOrderB).toHaveLength(2);
    const mergedBfB = sanitizedOrderB.find((g) => g.steamAppId === 2807960)!;
    expect(mergedBfB.title).toBe('Battlefield 6');
    expect(mergedBfB.platforms.map((p) => p.platformId).sort()).toEqual(['steam', 'xbox']);
    const mergedQuakeB = sanitizedOrderB.find((g) => g.steamAppId === 2310)!;
    expect((mergedQuakeB.enrichedMetadata as any)?.xboxDeliveryHints?.contentId).toBe(
      '11223344-5566-7788-99aa-bbccddeeff00'
    );

    // Verify loadCurrentCatalog() rewrites unstripped standalone Xbox titles in localStorage on startup
    const prevWin = (globalThis as any).window;
    const prevStorage = (globalThis as any).localStorage;
    const memStorage = createMemoryStorage();
    (globalThis as any).localStorage = memStorage;
    (globalThis as any).window = { ...(prevWin || {}), localStorage: memStorage };
    try {
      const dirtyStandaloneXbox = makeCanonicalGameFixture({
        id: 'xbox-9NFALLOUT76P',
        title: 'Fallout 76 (PC)',
        isVerifiedEntitlement: true,
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NFALLOUT76P',
            xboxProductId: '9NFALLOUT76P',
            ownershipType: 'owned',
            installed: false,
          },
        ],
      });
      memStorage.setItem('universal_game_library_catalog', JSON.stringify([dirtyStandaloneXbox]));
      const loaded = loadCurrentCatalog();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].title).toBe('Fallout 76');
      expect(loaded[0].platforms[0].originalTitle).toBe('Fallout 76 (PC)');
      const persistedAfterLoad = JSON.parse(
        memStorage.getItem('universal_game_library_catalog') || '[]'
      );
      expect(persistedAfterLoad[0]?.title).toBe('Fallout 76');
    } finally {
      (globalThis as any).window = prevWin;
      (globalThis as any).localStorage = prevStorage;
    }
  });

  it('renders the 4-segment Xbox Sphere SVG mark with proper decorative/standalone a11y semantics and Xbox green in DownloadManagerDrawer', () => {
    const standaloneEl = StorefrontIcon({ storefrontId: 'xbox', className: 'w-4 h-4' }) as any;
    expect(standaloneEl.type).toBe('svg');
    expect(standaloneEl.props.viewBox).toBe('0 0 16 16');
    expect(standaloneEl.props.role).toBe('img');
    expect(standaloneEl.props['aria-label']).toBe('Xbox');
    expect(standaloneEl.props['aria-hidden']).toBeUndefined();
    const dAttr = String(standaloneEl.props.children?.props?.d || '');
    // Verify 4-panel Xbox Sphere geometry (4 distinct subpaths starting with M/m)
    expect((dAttr.match(/[Mm]/g) || []).length).toBeGreaterThanOrEqual(4);

    const decorativeEl = StorefrontIcon({
      storefrontId: 'xbox',
      className: 'w-3 h-3 text-[#52d652]',
      decorative: true,
    }) as any;
    expect(decorativeEl.props['aria-hidden']).toBe('true');
    expect(decorativeEl.props['aria-label']).toBeUndefined();
    expect(decorativeEl.props.role).toBeUndefined();

    vi.spyOn(launcherService, 'getDownloadQueue').mockReturnValue([
      {
        taskId: 'dl-xbox-quake',
        gameId: 'xbox-9P1Z43KRNQD4',
        title: 'Quake',
        platformId: 'xbox',
        platformGameId: '9P1Z43KRNQD4',
        installPath: '/Users/testuser/Games/OneLauncher/Quake',
        status: 'downloading',
        progressPercent: 42,
        bytesDownloaded: 700_000_000,
        totalBytes: 1_750_000_000,
        speedBytesPerSec: 45_000_000,
        statusMessage: 'Decrypting & streaming Quake (42%)...',
      } as any,
    ]);

    const prevWin = (globalThis as any).window;
    const memStorage = createMemoryStorage();
    (globalThis as any).window = {
      ...(prevWin || {}),
      localStorage: memStorage,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    try {
      const drawerHarness = createComponentHarness(DownloadManagerDrawer, {
        isOpen: true,
        onClose: vi.fn(),
      });
      const drawerTree = drawerHarness.render();
      const xboxSvgs = findElements(
        drawerTree,
        (el) => el.type === 'svg' && el.props?.viewBox === '0 0 16 16'
      );
      expect(xboxSvgs.length).toBeGreaterThanOrEqual(1);
      expect(String(xboxSvgs[0].props.className || '')).toContain('text-[#52d652]');
      expect(xboxSvgs[0].props['aria-hidden']).toBe('true');
      drawerHarness.unmount();
    } finally {
      (globalThis as any).window = prevWin;
    }
  });

  it('invokes xboxStoreLicenseRecoveryHook on-demand during installGame when storeTicket is missing, acquires CIK, and decrypts encrypted MSIXVC without failing', async () => {
    const installDir = path.join(tmpDir, 'QuakeInstall');
    const msixvcFile = path.join(tmpDir, 'QuakeEncrypted.msixvc');
    const rawCik32 = Buffer.from(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      'hex'
    );
    const keyGuid = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';
    const contentIdGuid = '11223344-5566-7788-99aa-bbccddeeff00';
    const deviceKey16 = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

    const syntheticMsixvcBuf = buildSyntheticMsixvcImage({
      contentIdGuid,
      keyGuid,
      cik32: rawCik32,
      gameConfigXml: `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="BethesdaSoftworks.ProjectSilver" Publisher="CN=3275KFVN8VCWC" Version="1.0.19.0" />
  <TitleId>6432DF20</TitleId>
  <MSAAppId>0000000048193752</MSAAppId>
  <ShellVisuals DefaultDisplayName="Quake (PC)" />
  <ExecutableList>
    <Executable Name="Quake_x64_msstore.exe" Id="Game" />
  </ExecutableList>
</Game>`,
      files: [
        {
          path: 'Quake_x64_msstore.exe',
          data: Buffer.from('MZ-synthetic-quake-binary-payload-verified', 'utf8'),
        },
      ],
    });
    fs.writeFileSync(msixvcFile, syntheticMsixvcBuf);

    // Simulate an OAuth2-restored session where storeTicket starts empty until recovery runs
    let provisionedStoreTicket = '';
    const mockAuthProvider = {
      getStoreMsaToken: vi.fn(async (opts?: { forLicensing?: boolean }) => {
        if (opts?.forLicensing) return provisionedStoreTicket;
        return 'XBL3.0 x=12345;mp_xsts_jwt';
      }),
      ensureDeviceContext: vi.fn(async () => ({
        deviceMsToken: 't=device_ticket',
        deviceKeyBuffer: deviceKey16,
      })),
    };

    const recoveryHook = vi.fn(async (ctx: any) => {
      expect(ctx.title).toBe('Quake');
      expect(ctx.contentId).toBe(contentIdGuid);
      provisionedStoreTicket = 't=recovered_compact_msa_store_ticket';
      return { recovered: true };
    });

    const acquireCikSpy = vi.fn(async (params: any) => {
      expect(params.msaStoreToken).toBe('t=recovered_compact_msa_store_ticket');
      expect(params.contentId).toBe(contentIdGuid);
      return {
        contentId: contentIdGuid,
        keyId: keyGuid,
        cikBuffer: rawCik32,
        cikHex: rawCik32.toString('hex'),
        keys: [
          {
            keyId: keyGuid,
            cikBuffer: rawCik32,
            cikHex: rawCik32.toString('hex'),
          },
        ],
      };
    });

    let completedStatus: string | undefined;
    let sawAuthStatusBanner = false;
    const unsubDownload = launcherEngine.onDownloadUpdated(({ task: taskSnap }: any) => {
      if (
        taskSnap?.gameId === 'xbox-9P1Z43KRNQD4' &&
        String(taskSnap?.statusMessage || '').includes('Sign in once in the Microsoft window')
      ) {
        sawAuthStatusBanner = true;
      }
      if (
        taskSnap?.gameId === 'xbox-9P1Z43KRNQD4' &&
        (taskSnap?.status === 'completed' || taskSnap?.status === 'failed')
      ) {
        completedStatus = taskSnap.status;
      }
    });

    try {
      const startRes = await launcherEngine.installGame(
        {
          gameId: 'xbox-9P1Z43KRNQD4',
          title: 'Quake',
          platformId: 'xbox',
          platformGameId: '9P1Z43KRNQD4',
          installDir: tmpDir,
          contentId: contentIdGuid,
          msixvcPath: msixvcFile,
        },
        {
          platform: 'darwin',
          userDataDir: tmpDir,
          xboxAuthProvider: mockAuthProvider,
          xboxStoreLicenseRecoveryHook: recoveryHook,
          acquireContentCikFn: acquireCikSpy,
          resolveXboxDeliveryFn: async () => ({
            contentId: contentIdGuid,
            packageFamilyName: 'BethesdaSoftworks.ProjectSilver_3275kfvn8vcwc',
            packageFullName: 'BethesdaSoftworks.ProjectSilver_1.0.19.0_x64__3275kfvn8vcwc',
            xboxTitleId: '1681055520',
            msaAppId: '0000000048193752',
            maxDownloadSizeBytes: syntheticMsixvcBuf.length,
            downloadUrls: ['http://127.0.0.1:9/unused-local-msixvc-path-used'],
            satisfyingEntitlementKeys: ['9P1Z43KRNQD4:0010'],
          }),
          extractMsixvcFn: (extractOpts: any) =>
            msixvcStreamExtractor.extractMsixvcStream(extractOpts),
        }
      );

      expect(startRes.success).toBe(true);
      const finalDir = startRes.task.finalInstallPath || installDir;

      // Wait for async background Xbox download/decryption task to finish
      for (let i = 0; i < 60 && !completedStatus; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(recoveryHook).toHaveBeenCalledTimes(1);
      expect(sawAuthStatusBanner).toBe(true);
      expect(acquireCikSpy).toHaveBeenCalledTimes(1);
      expect(completedStatus).toBe('completed');

      const extractedExe = path.join(finalDir, 'Quake_x64_msstore.exe');
      expect(fs.existsSync(extractedExe)).toBe(true);
      expect(fs.readFileSync(extractedExe, 'utf8')).toBe(
        'MZ-synthetic-quake-binary-payload-verified'
      );

      // Also verify inspectInstalledXboxGameDir strips "(PC)" from ShellVisuals DefaultDisplayName!
      const scannedXboxInstall = launcherEngine.inspectInstalledXboxGameDir(finalDir, {
        platform: 'darwin',
      });
      expect(scannedXboxInstall?.title).toBe('Quake');
    } finally {
      unsubDownload();
    }
  });
});

// ===========================================================================
// 10. Wave 2 Production Hardening: SPLicense XML, 7-Region XVD, 14B ECDSA /
//     RPS TitleStorage, Non-Nesting Scanner, Strict PE & CrossOver GameInput
// ===========================================================================

describe('10. Wave 2 Production Hardening: SPLicense XML, 7-Region XVD, 14B ECDSA / RPS TitleStorage, Non-Nesting Scanner & CrossOver GameInput', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-xbox-wave2-hardening-'));
  });

  afterEach(() => {
    xboxCatalogAndGamePass.closeXboxCatalogCacheStore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('decodes Base64 <License xmlns:xsi=...> XML without <?xml past offset 950 and retries satisfyingEntitlementKeys when Attempt 1 returns 0 PackedContentKeys', async () => {
    const deviceKey16 = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const rawCik32 = Buffer.from(
      '101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f',
      'hex'
    );
    const keyGuid = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';
    const contentId = '11223344-5566-7788-99aa-bbccddeeff00';
    const licenseId = '99887766-5544-3322-1100-aabbccddeeff';

    const spLicenseWithKeyB64 = buildSyntheticSpLicenseBlockBase64({
      deviceKey16,
      licenseIdGuid: licenseId,
      packageFullName: 'SyntheticPublisher.SyntheticTitle_1.0.0.0_x64__8wekyb3d8bbwe',
      contentKeys: [{ keyIdGuid: keyGuid, cik32: rawCik32 }],
    });

    // Build an outer `<License xmlns:xsi=...>` XML WITHOUT `<?xml` prolog where `<SPLicenseBlock>`
    // appears well past byte offset 950 (matching live `licensing.mp.microsoft.com` payloads)
    const longMetadataPadding = 'M'.repeat(1024);
    const outerLicenseXmlWithKey =
      `<License xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns="http://schemas.microsoft.com/onestore/security/mkms/License/v1">` +
      `<Metadata><IssuedDate>2026-10-26T00:00:00Z</IssuedDate><Padding>${longMetadataPadding}</Padding></Metadata>` +
      `<SPLicenseBlock>${spLicenseWithKeyB64}</SPLicenseBlock>` +
      `</License>`;
    expect(outerLicenseXmlWithKey.startsWith('<?xml')).toBe(false);
    expect(outerLicenseXmlWithKey.indexOf('<SPLicenseBlock>')).toBeGreaterThan(950);

    const outerLicenseBlobB64 = Buffer.from(outerLicenseXmlWithKey, 'utf8').toString('base64');
    expect(xboxDeviceClep.extractSpLicenseBase64(outerLicenseBlobB64)).toBe(spLicenseWithKeyB64);

    const parsedSp = xboxDeviceClep.parseSpLicenseBase64(outerLicenseBlobB64, {
      verifyCmacWithKey: deviceKey16,
    });
    expect(parsedSp.licenseId).toBe(licenseId);
    expect(parsedSp.packedContentKeys).toHaveLength(1);
    expect(parsedSp.packedContentKeys[0].keyId).toBe(keyGuid);

    // Key-less `<SPLicenseBlock>` (0 `PackedContentKeys`) returned on Attempt 1 (bare ContentId)
    const keylessSpBlockB64 = buildSyntheticSpLicenseBlockBase64({
      deviceKey16,
      licenseIdGuid: licenseId,
      packageFullName: 'SyntheticPublisher.SyntheticTitle_1.0.0.0_x64__8wekyb3d8bbwe',
      contentKeys: [],
    });
    const keylessOuterBlobB64 = Buffer.from(
      `<License xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Metadata>${longMetadataPadding}</Metadata><SPLicenseBlock>${keylessSpBlockB64}</SPLicenseBlock></License>`,
      'utf8'
    ).toString('base64');

    const observedBodies: any[] = [];
    const observedAuthHeaders: string[] = [];
    const mockFetch = vi.fn(async (_url: string, init: any) => {
      observedAuthHeaders.push(String(init?.headers?.Authorization || ''));
      const reqBody = JSON.parse(String(init?.body || '{}'));
      observedBodies.push(reqBody);
      const hasEntitlementKeys =
        Array.isArray(reqBody.satisfyingEntitlementKeys) &&
        reqBody.satisfyingEntitlementKeys.length > 0;
      return new Response(
        JSON.stringify({
          license: {
            licenseBlob: hasEntitlementKeys ? outerLicenseBlobB64 : keylessOuterBlobB64,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const cikResult = await xboxDeviceClep.acquireContentCik({
      contentId,
      satisfyingEntitlementKeys: ['big:CFQ7TTC0KGQ8:0010', '9NSYNTHTITLE:0010'],
      msaStoreToken: 'd=raw_user_delegation_ticket',
      deviceContext: {
        deviceMsToken: 'd=raw_device_delegation_ticket',
        deviceKeyBuffer: deviceKey16,
      },
      fetchImpl: mockFetch,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(observedAuthHeaders).toEqual([
      't=raw_device_delegation_ticket',
      't=raw_device_delegation_ticket',
    ]);
    expect(observedBodies[0].satisfyingEntitlementKeys).toBeUndefined();
    expect(observedBodies[1].satisfyingEntitlementKeys).toEqual([
      { productId: 'CFQ7TTC0KGQ8', skuId: '0010' },
      { productId: '9NSYNTHTITLE', skuId: '0010' },
    ]);
    expect(cikResult.cikBuffer.equals(rawCik32)).toBe(true);
    expect(cikResult.keyId).toBe(keyGuid);

    // Also verify decimal TitleId -> SCID derivation & Game Pass activeEntitlementKeys propagation
    expect(xboxCatalogAndGamePass.deriveDefaultScidFromTitleId('1681055520')).toBe(
      '00000000-0000-0000-0000-00006432df20'
    );
    const subClassified = xboxCatalogAndGamePass.classifySubscriptionRecords([
      {
        productId: 'CFQ7TTC0KGQ8',
        skuId: '0010',
        status: 'Active',
        endDate: '2099-01-01T00:00:00Z',
      },
    ]);
    expect(subClassified.activeEntitlementKeys).toContain('CFQ7TTC0KGQ8:0010');
  });

  it('skips 0x40000002 FS-MD while extracting 0x40000003 unencrypted prefix + 0x3E9 encrypted payload in a 7-region .msixvc with regionIdInXts = false', async () => {
    const vduidGuid = '22334455-6677-8899-aabb-ccddeeff0011';
    const contentIdGuid = '33445566-7788-99aa-bbcc-ddeeff001122';
    const keyGuid = '44556677-8899-aabb-ccdd-eeff00112233';
    const rawCik32 = Buffer.from(
      'a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf',
      'hex'
    );

    const gameConfigXml = `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="SyntheticStudio.SevenRegionGame" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.2.0.0" />
  <TitleId>6432DF20</TitleId>
  <ExecutableList>
    <Executable Name="gamelaunchhelper.exe" Id="Helper" />
    <Executable Name="Bin/SevenRegion_x64.exe" Id="Game" OverrideWorkingDirectory="base" />
  </ExecutableList>
</Game>`;
    const appxManifestXml = `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
  <Identity Name="SyntheticStudio.SevenRegionGame" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.2.0.0" />
</Package>`;

    const segFiles: SyntheticSegmentFile[] = [
      // segments[0..2]: unencrypted prefix files in region 0x40000003
      { path: 'MicrosoftGame.config', data: Buffer.from(gameConfigXml, 'utf8') },
      { path: 'AppxManifest.xml', data: Buffer.from(appxManifestXml, 'utf8') },
      { path: 'base/default.cfg', data: Buffer.from('unbindall\nbind SPACE "+jump"\n', 'utf8') },
      // segments[3..4]: encrypted payload files in region 0x3E9
      { path: 'Bin/SevenRegion_x64.exe', data: buildValidMinimalPe64Buffer('SEVEN-REGION-EXE') },
      { path: 'base/pak0.pak', data: Buffer.alloc(6000, 0x5a) },
    ];

    const segMetaBuf = buildSyntheticSegmentMetadata(segFiles, vduidGuid);
    const userDataBuf = buildSyntheticUserData(
      'SyntheticStudio.SevenRegionGame_1.2.0.0_x64__8wekyb3d8bbwe',
      [
        { name: 'SegmentMetadata.bin', data: segMetaBuf },
        { name: 'MicrosoftGame.config', data: Buffer.from(gameConfigXml, 'utf8') },
      ]
    );

    const xvcRegionCount = 7;
    const xvcDataLength =
      msixvcXvdParser.XVC_INFO_HEADER_SIZE + xvcRegionCount * msixvcXvdParser.XVC_REGION_HEADER_SIZE;

    const fsMdPoisonPages = 2; // 2 pages of 0xEE poison for 0x40000002 FS-MD inside driveData
    const prefixPages = segFiles
      .slice(0, 3)
      .reduce((acc, f) => acc + msixvcXvdParser.bytesToPages(f.data.length), 0);
    const payloadPages = segFiles
      .slice(3)
      .reduce((acc, f) => acc + msixvcXvdParser.bytesToPages(f.data.length), 0);
    const totalDrivePages = fsMdPoisonPages + prefixPages + payloadPages;
    const driveSize = totalDrivePages * msixvcXvdParser.XVD_PAGE_SIZE;

    // Header: READ_ONLY ONLY (regionIdInXts = false!)
    const hdr = Buffer.alloc(msixvcXvdParser.XVD_HEADER_SECTION_SIZE, 0);
    hdr.write('msft-xvd', 0x200, 'ascii');
    hdr.writeUInt32LE(msixvcXvdParser.XVD_VOLUME_FLAGS.READ_ONLY, 0x208);
    hdr.writeUInt32LE(3, 0x20c);
    hdr.writeBigUInt64LE(BigInt(driveSize), 0x218);
    msixvcXvdParser.writeGuidLE(vduidGuid, hdr, 0x220);
    hdr.writeUInt32LE(0, 0x280);
    hdr.writeUInt32LE(userDataBuf.length, 0x28c);
    hdr.writeUInt32LE(xvcDataLength, 0x290);
    msixvcXvdParser.writeGuidLE(contentIdGuid, hdr, 0x39c);
    msixvcXvdParser.writeGuidLE(vduidGuid, hdr, 0x3ac);

    const parsedHeader = msixvcXvdParser.parseXvdHeader(hdr);
    expect(parsedHeader.regionIdInXts).toBe(false);
    const layout = msixvcXvdParser.computeXvdLayout(parsedHeader);
    const container = Buffer.alloc(layout.totalContainerBytes, 0);
    hdr.copy(container, 0);
    userDataBuf.copy(container, layout.userData.byteOffset);

    const fsMdByteOffset = layout.driveData.byteOffset;
    const fsMdByteLength = fsMdPoisonPages * msixvcXvdParser.XVD_PAGE_SIZE;
    const prefixByteOffset = fsMdByteOffset + fsMdByteLength;
    const prefixByteLength = prefixPages * msixvcXvdParser.XVD_PAGE_SIZE;
    const payloadByteOffset = prefixByteOffset + prefixByteLength;
    const payloadByteLength = payloadPages * msixvcXvdParser.XVD_PAGE_SIZE;

    // Fill 0x40000002 FS-MD region with 0xEE poison bytes so accidental mapping corrupts segments[0..1]
    container.fill(0xee, fsMdByteOffset, fsMdByteOffset + fsMdByteLength);

    const sevenRegions = [
      { id: 0x40000005, keyId: 0xffff, flags: 1, firstSeg: 0, desc: 'XVC-HD', off: 0, len: 0x3000 },
      { id: 0x40000004, keyId: 0xffff, flags: 1, firstSeg: 0, desc: 'XVC-EXVD', off: 0, len: 0 },
      { id: 0x40000006, keyId: 0xffff, flags: 1, firstSeg: 0, desc: 'XVC-MDU', off: 0, len: 0 },
      {
        id: 0x40000001,
        keyId: 0xffff,
        flags: 1,
        firstSeg: 0,
        desc: 'XVC-MD',
        off: layout.xvcInfo.byteOffset,
        len: layout.xvcInfo.alignedByteLength,
      },
      {
        id: 0x40000002,
        keyId: 0xffff,
        flags: 0,
        firstSeg: 0,
        desc: 'FS-MD',
        off: fsMdByteOffset,
        len: fsMdByteLength,
      },
      {
        id: 0x40000003,
        keyId: 0xffff,
        flags: 0,
        firstSeg: 0,
        desc: '',
        off: prefixByteOffset,
        len: prefixByteLength,
      },
      {
        id: 0x000003e9,
        keyId: 0,
        flags: 0,
        firstSeg: 3,
        desc: 'Chunk0',
        off: payloadByteOffset,
        len: payloadByteLength,
      },
    ];

    const xvcBuf = Buffer.alloc(xvcDataLength, 0);
    msixvcXvdParser.writeGuidLE(contentIdGuid, xvcBuf, 0x000);
    xvcBuf.writeUInt32LE(1, 0xd10);
    xvcBuf.writeUInt32LE(sevenRegions.length, 0xd14);
    xvcBuf.writeUInt16LE(1, 0xd1e); // keyCount = 1
    msixvcXvdParser.writeGuidLE(keyGuid, xvcBuf, 0x010);

    sevenRegions.forEach((r, idx) => {
      const rOff = msixvcXvdParser.XVC_INFO_HEADER_SIZE + idx * msixvcXvdParser.XVC_REGION_HEADER_SIZE;
      xvcBuf.writeUInt32LE(r.id >>> 0, rOff + 0x00);
      xvcBuf.writeUInt16LE(r.keyId & 0xffff, rOff + 0x04);
      xvcBuf.writeUInt32LE(r.flags >>> 0, rOff + 0x08);
      xvcBuf.writeUInt32LE(r.firstSeg >>> 0, rOff + 0x0c);
      if (r.desc) {
        Buffer.from(`${r.desc}\0`, 'utf16le').copy(xvcBuf, rOff + 0x10);
      }
      xvcBuf.writeBigUInt64LE(BigInt(r.off), rOff + 0x50);
      xvcBuf.writeBigUInt64LE(BigInt(r.len), rOff + 0x58);
    });
    xvcBuf.copy(container, layout.xvcInfo.byteOffset);

    // Write unencrypted prefix segments[0..2] into 0x40000003 and encrypted segments[3..4] into 0x3E9
    const osslKey = msixvcStreamExtractor.buildOpenSslXtsKey(rawCik32);
    let cursorByteOffset = prefixByteOffset;
    let unitSeq = 500;
    for (let sIdx = 0; sIdx < segFiles.length; sIdx += 1) {
      const f = segFiles[sIdx];
      const pages = msixvcXvdParser.bytesToPages(f.data.length);
      const isEncSeg = sIdx >= 3;
      for (let p = 0; p < pages; p += 1) {
        const plainPage = Buffer.alloc(msixvcXvdParser.XVD_PAGE_SIZE, 0);
        const start = p * msixvcXvdParser.XVD_PAGE_SIZE;
        f.data.copy(
          plainPage,
          0,
          start,
          Math.min(f.data.length, start + msixvcXvdParser.XVD_PAGE_SIZE)
        );
        const dataUnit = unitSeq;
        unitSeq += 3;

        const hashedIdx = Math.floor(
          (cursorByteOffset - layout.userData.byteOffset) / msixvcXvdParser.XVD_PAGE_SIZE
        );
        const l0Page = Math.floor(hashedIdx / msixvcXvdParser.XVD_HASH_ENTRIES_PER_PAGE);
        const entryIdx = hashedIdx % msixvcXvdParser.XVD_HASH_ENTRIES_PER_PAGE;
        const entryByteOff =
          layout.hashTree.level0ByteOffset +
          l0Page * msixvcXvdParser.XVD_PAGE_SIZE +
          entryIdx * msixvcXvdParser.XVD_HASH_ENTRY_SIZE;
        container.writeUInt32LE(dataUnit, entryByteOff + 20);

        if (isEncSeg) {
          // Critical: regionIdInXts === false -> tweak regionId MUST be 0 (not 0x3E9!)
          const tweak = msixvcStreamExtractor.buildXvdXtsTweak(dataUnit, 0, parsedHeader.vduidLow8);
          msixvcStreamExtractor.encryptXvdPage(plainPage, osslKey, tweak).copy(container, cursorByteOffset);
        } else {
          plainPage.copy(container, cursorByteOffset);
        }
        cursorByteOffset += msixvcXvdParser.XVD_PAGE_SIZE;
      }
    }

    const parsedXvc = msixvcXvdParser.parseXvcInfo(xvcBuf);
    expect(parsedXvc.regions.map((r: any) => msixvcXvdParser.isStructuralXvcRegion(r))).toEqual([
      true,
      true,
      true,
      true,
      true, // 0x40000002 FS-MD is strictly structural
      false, // 0x40000003 unencrypted prefix
      false, // 0x3E9 encrypted payload
    ]);

    const inspected = await msixvcXvdParser.inspectMsixvcContainer({
      rangeReader: msixvcXvdParser.createBufferRangeReader(container),
      cik: rawCik32,
    });
    expect(inspected.mappedSegments).toHaveLength(5);
    expect(inspected.mappedSegments.slice(0, 3).every((s: any) => s.regionId === 0x40000003 && !s.isEncrypted)).toBe(true);
    expect(inspected.mappedSegments.slice(3).every((s: any) => s.regionId === 0x3e9 && s.isEncrypted)).toBe(true);
    expect(inspected.gameConfig?.overrideWorkingDirectory).toBe('base');

    const extractDir = path.join(tmpDir, 'SevenRegionExtracted');
    await msixvcStreamExtractor.extractMsixvcStream({
      msixvcBuffer: container,
      installDir: extractDir,
      cikMap: { [keyGuid]: rawCik32 },
    });

    expect(fs.existsSync(path.join(extractDir, '.onelauncher-xbox-journal.json'))).toBe(false);
    expect(fs.readFileSync(path.join(extractDir, 'base', 'default.cfg'), 'utf8')).toBe(
      'unbindall\nbind SPACE "+jump"\n'
    );
    expect(
      fs.readFileSync(path.join(extractDir, 'Bin', 'SevenRegion_x64.exe')).equals(segFiles[3].data)
    ).toBe(true);
    expect(fs.readFileSync(path.join(extractDir, 'base', 'pak0.pak')).equals(segFiles[4].data)).toBe(
      true
    );
  });

  it('enforces pre-flight missing-CIK guard in extractMsixvcStream with zero folders, journals, or .olpart files written to disk', async () => {
    const rawCik32 = Buffer.from(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      'hex'
    );
    const encryptedBuf = buildSyntheticMsixvcImage({
      cik32: rawCik32,
      files: [{ path: 'Files/EncryptedGame.exe', data: buildValidMinimalPe64Buffer('CIK-GUARD') }],
    });

    const untouchedInstallDir = path.join(tmpDir, 'UntouchedMissingCikInstall');
    expect(fs.existsSync(untouchedInstallDir)).toBe(false);

    await expect(
      msixvcStreamExtractor.extractMsixvcStream({
        msixvcBuffer: encryptedBuf,
        installDir: untouchedInstallDir,
        // Intentionally omit cik / cikMap / cikKeys
      })
    ).rejects.toThrow(/Missing Content Integrity Key \(CIK\)/i);

    expect(fs.existsSync(untouchedInstallDir)).toBe(false);
  });

  it('signs 14-byte [v1,0,ticks8B,0] ECDSA payloads into 76-byte wire headers, mints Win32 RPS DeviceToken + ProofKey XSTS for TitleStorage, parses ownerChangeId, handles benign 404/400:2000 & 403:2016, and avoids wgs/wgs', async () => {
    // 1. Verify 14-byte `buildXboxSignaturePayload` prefix vs 76-byte wire Signature header + `body` signing
    const { privateKeyPem, publicKeyPem } = xboxAuthManager.generateXboxProofKeyPair();
    const sampleTicks = 134059968000000000n;
    const builtPayload = xboxAuthManager.buildXboxSignaturePayload({
      method: 'PUT',
      url: 'https://titlestorage.xboxlive.com/connectedstorage/users/xuid(2533274790000001)/scids/00000000-0000-0000-0000-00006432df20/lock',
      authorizationHeader: 'XBL3.0 x=uhs123;jwt456',
      body: '{"friendlyName":"OneLauncher"}',
      windowsTicks: sampleTicks,
    });
    expect(builtPayload.prefix14.length).toBe(14);
    expect(builtPayload.prefix14.readUInt32BE(0)).toBe(1);
    expect(builtPayload.prefix14[4]).toBe(0x00);
    expect(builtPayload.prefix14.readBigUInt64BE(5)).toBe(sampleTicks);
    expect(builtPayload.prefix14[13]).toBe(0x00);

    const sigB64 = xboxAuthManager.signXboxRequest({
      method: 'PUT',
      url: 'https://titlestorage.xboxlive.com/connectedstorage/users/xuid(2533274790000001)/scids/00000000-0000-0000-0000-00006432df20/lock',
      authorizationHeader: 'XBL3.0 x=uhs123;jwt456',
      body: '{"friendlyName":"OneLauncher"}',
      ecPrivateKey: privateKeyPem,
      timestampMs: 1761510000000,
    });
    expect(Buffer.from(sigB64, 'base64').length).toBe(76);
    expect(
      xboxAuthManager.verifyXboxRequestSignature({
        signatureBase64: sigB64,
        method: 'PUT',
        url: 'https://titlestorage.xboxlive.com/connectedstorage/users/xuid(2533274790000001)/scids/00000000-0000-0000-0000-00006432df20/lock',
        authorizationHeader: 'XBL3.0 x=uhs123;jwt456',
        body: '{"friendlyName":"OneLauncher"}',
        ecPublicKey: publicKeyPem,
      })
    ).toBe(true);
    expect(
      xboxAuthManager.verifyXboxRequestSignature({
        signatureBase64: sigB64,
        method: 'PUT',
        url: 'https://titlestorage.xboxlive.com/connectedstorage/users/xuid(2533274790000001)/scids/00000000-0000-0000-0000-00006432df20/lock',
        authorizationHeader: 'XBL3.0 x=uhs123;jwt456',
        body: '{"friendlyName":"Tampered"}',
        ecPublicKey: publicKeyPem,
      })
    ).toBe(false);

    // 2. Verify `getTokenAndSignatureForUrl` for `titlestorage.xboxlive.com` mints Win32 RPS DeviceToken + ProofKey XSTS
    const futureIso = new Date(Date.now() + 3600_000).toISOString();
    const vaultStore: Record<string, any> = {
      xbox: {
        xblAccessToken: 't=valid_user_rps_ticket',
        xblRefreshToken: 'refresh_tok',
        msaExpiresAt: futureIso,
        xblUserToken: 'user_jwt_token',
        xblUserNotAfter: futureIso,
        xstsToken: 'plain_user_only_xsts_jwt',
        xstsUhs: '888999000111',
        xstsNotAfter: futureIso,
        xuid: '2533274790000001',
        gamertag: 'TestPilot',
        proofPrivateKeyPem: privateKeyPem,
        proofPublicKeyPem: publicKeyPem,
        proofKeyJwk: xboxAuthManager.exportProofKeyJwkFromPrivateKey(privateKeyPem),
        deviceContext: {
          deviceMembername: '0200000000000001@device.idp.live.com',
          devicePassword: 'synthetic-password',
          hwDeviceId: 'hw-seed-001',
          deviceToken: 'd=raw_provisioned_device_rps_ticket',
          deviceDat: 't=raw_device_ms_store_ticket',
          deviceMsToken: 't=raw_device_ms_store_ticket',
          deviceDatExpiresAt: futureIso,
          deviceKeyHex: '00112233445566778899aabbccddeeff',
          clepRsaKeyPem: '-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----',
        },
      },
    };
    const memVault = {
      loadSavedTokens: () => ({ ...vaultStore }),
      saveTokens: (providerOrAll: any, data?: any) => {
        if (typeof providerOrAll === 'string') {
          vaultStore[providerOrAll] = { ...(vaultStore[providerOrAll] || {}), ...(data || {}) };
        } else if (providerOrAll && typeof providerOrAll === 'object') {
          Object.assign(vaultStore, providerOrAll);
        }
      },
      getProviderTokens: (id: string) => (vaultStore[id] ? { ...vaultStore[id] } : null),
      saveProviderTokens: (id: string, data: any) => {
        vaultStore[id] = { ...(vaultStore[id] || {}), ...data };
      },
      getHardwareFingerprint: () => 'synthetic-host-fp',
    };

    let capturedDeviceAuthBody: any = null;
    let capturedXstsBody: any = null;
    const authFetch = vi.fn(async (reqUrl: string, init: any) => {
      if (reqUrl.includes('device.auth.xboxlive.com/device/authenticate')) {
        capturedDeviceAuthBody = JSON.parse(String(init?.body || '{}'));
        return new Response(
          JSON.stringify({ Token: 'rps_device_jwt_token', NotAfter: futureIso }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (reqUrl.includes('xsts.auth.xboxlive.com/xsts/authorize')) {
        capturedXstsBody = JSON.parse(String(init?.body || '{}'));
        return new Response(
          JSON.stringify({
            Token: 'device_bound_titlestorage_xsts_jwt',
            NotAfter: futureIso,
            DisplayClaims: { xui: [{ uhs: '888999000111', xid: '2533274790000001', gtg: 'TestPilot' }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected URL in TitleStorage auth test: ${reqUrl}`);
    });

    const provider = xboxAuthManager.createXboxAuthProvider({
      tokenVault: memVault,
      userDataDir: tmpDir,
      fetchImpl: authFetch,
    });

    const tsLockUrl =
      'https://titlestorage.xboxlive.com/connectedstorage/users/xuid(2533274790000001)/scids/00000000-0000-0000-0000-00006432df20/lock?friendlyName=OneLauncher';
    const tsSigned = await provider.getTokenAndSignatureForUrl({
      method: 'PUT',
      url: tsLockUrl,
      body: '{"lockReq":true}',
      msaAppId: '0000000048193752',
    });

    expect(capturedDeviceAuthBody?.Properties?.AuthMethod).toBe('RPS');
    expect(capturedDeviceAuthBody?.Properties?.DeviceType).toBe('Win32');
    expect(capturedDeviceAuthBody?.Properties?.RpsTicket).toBe(
      't=raw_provisioned_device_rps_ticket'
    );
    expect(capturedDeviceAuthBody?.Properties?.Id).toMatch(
      /^\{[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}$/
    );
    expect(capturedDeviceAuthBody?.Properties?.SerialNumber).toMatch(
      /^\{[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}$/
    );
    expect(capturedDeviceAuthBody?.Properties?.ProofKey?.kty).toBe('EC');

    expect(capturedXstsBody?.Properties?.UserTokens).toEqual(['user_jwt_token']);
    expect(capturedXstsBody?.Properties?.DeviceToken).toBe('rps_device_jwt_token');
    expect(capturedXstsBody?.Properties?.TitleToken).toBeUndefined();
    expect(capturedXstsBody?.Properties?.ProofKey?.kty).toBe('EC');
    expect(tsSigned.token).toBe('XBL3.0 x=888999000111;device_bound_titlestorage_xsts_jwt');
    expect(
      xboxAuthManager.verifyXboxRequestSignature({
        signatureBase64: tsSigned.signature,
        method: 'PUT',
        url: tsLockUrl,
        authorizationHeader: tsSigned.token,
        body: '{"lockReq":true}',
        ecPublicKey: publicKeyPem,
      })
    ).toBe(true);

    // 3. Verify `ownerChangeId` parsing, benign 400:2000 skip, and 403:2016 read-only fallback
    const lockClient = xboxTitleStorageSync.createTitleStorageClient({
      xuid: '2533274790000001',
      scid: '00000000-0000-0000-0000-00006432df20',
      authorizationHeader: tsSigned.token,
      fetchImpl: async () =>
        new Response(JSON.stringify({ quotaBytes: 134217728, ownerChangeId: 'change-id-42' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    const lockRes = await lockClient.acquireLock();
    expect(lockRes.ownerChangeId).toBe('change-id-42');
    expect(lockRes.ownerChangedId).toBe('change-id-42');

    const skip400Dir = path.join(tmpDir, 'wgs_skip_400');
    const skipRes = await xboxTitleStorageSync.syncXboxTitleStorage({
      mode: 'pre_launch',
      wgsUserDir: skip400Dir,
      xuid: '2533274790000001',
      scid: '00000000-0000-0000-0000-00006432df20',
      authorizationHeader: tsSigned.token,
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: 2000, description: 'Invalid SCID' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    expect(skipRes.skipped).toBe(true);
    expect(skipRes.unsupportedForTitle).toBe(true);

    const roFallbackDir = path.join(tmpDir, 'wgs_ro_403');
    const roRes = await xboxTitleStorageSync.syncXboxTitleStorage({
      mode: 'pre_launch',
      wgsUserDir: roFallbackDir,
      xuid: '2533274790000001',
      scid: '00000000-0000-0000-0000-00006432df20',
      authorizationHeader: tsSigned.token,
      fetchImpl: async (reqUrl: string, init: any) => {
        if (init?.method === 'PUT' && reqUrl.includes('/lock')) {
          return new Response(JSON.stringify({ code: 2016, description: 'Session lock denied' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ blobs: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    expect(roRes.synced).toBe(true);
    expect(roRes.readOnlyFallback).toBe(true);

    // 4. Verify idempotent single-`wgs` path resolution in `xboxRuntimeLoopbackServer`
    const sysAppDataPath = path.join(tmpDir, 'Packages', 'Pub.Game_8wekyb3d8bbwe', 'SystemAppData');
    const alreadyWgsPath = path.join(sysAppDataPath, 'wgs');
    const hexScid = '0009000000000001_00000000-0000-0000-0000-00006432df20';
    const fromSys = xboxRuntimeLoopbackServer.resolveTitleSaveDirs(sysAppDataPath, hexScid);
    const fromWgs = xboxRuntimeLoopbackServer.resolveTitleSaveDirs(alreadyWgsPath, hexScid);
    expect(fromWgs).toEqual(fromSys);
    expect(fromWgs.wgsUserDir).not.toContain(path.join('wgs', 'wgs'));
  });

  it('isolates VITEST default install dir to os.tmpdir() and prevents <root>/GameA/GameB nesting via collectXboxLibraryRoots and getGameInstallInfo', async () => {
    // 1. Default install dir under VITEST must stay strictly inside `os.tmpdir()`, never real `$HOME`
    const vitestDefaultXboxDir = launcherEngine.getDefaultInstallDir('xbox', {
      platform: 'darwin',
    });
    expect(path.resolve(vitestDefaultXboxDir).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    expect(path.resolve(vitestDefaultXboxDir).startsWith(path.resolve(os.homedir()))).toBe(false);

    // 2. Populate an isolated Xbox library root containing an already-installed sibling Xbox game
    const fakeHome = path.join(tmpDir, 'isolated-home');
    const xboxLibRoot = path.join(fakeHome, 'Games', 'OneLauncher', 'Xbox');
    const installedSiblingDir = path.join(xboxLibRoot, 'SiblingGameAlpha');
    fs.mkdirSync(installedSiblingDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedSiblingDir, 'MicrosoftGame.config'),
      `<Game configVersion="1"><Identity Name="Pub.Alpha" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.0.0.0" /><ExecutableList><Executable Name="Alpha.exe" Id="Game" /></ExecutableList></Game>`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(installedSiblingDir, '.onelauncher-xbox-receipt.json'),
      JSON.stringify({ status: 'completed', xboxProductId: '9NALPHAGAME0' }),
      'utf8'
    );
    fs.writeFileSync(path.join(installedSiblingDir, 'Alpha.exe'), buildValidMinimalPe64Buffer());

    const roots = launcherEngine.collectXboxLibraryRoots({
      platform: 'darwin',
      homedir: fakeHome,
      userDataDir: path.join(tmpDir, 'userData'),
      xboxGamesDirs: [installedSiblingDir, xboxLibRoot],
      customRoots: [installedSiblingDir],
    });
    expect(roots).toEqual([xboxLibRoot]);
    expect(roots).not.toContain(installedSiblingDir);

    const installInfo = await launcherEngine.getGameInstallInfo(
      {
        platformId: 'xbox',
        platformGameId: '9NBETAGAME00',
        title: 'Sibling Game Beta',
      },
      {
        platform: 'darwin',
        homedir: fakeHome,
        userDataDir: path.join(tmpDir, 'userData'),
        xboxGamesDirs: [installedSiblingDir, xboxLibRoot],
        skipNetwork: true,
      }
    );
    expect(installInfo.defaultInstallDir).toBe(xboxLibRoot);
  });

  it('rejects .onelauncher-xbox-journal.json, .olpart, and stub/encrypted .exe under strictPe: true while preserving catalog installSize against stub scan sizes', () => {
    const configXml = `<Game configVersion="1">
      <Identity Name="Synthetic.StrictCheck" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.0.0.0" />
      <StoreId>9NSTRICTCHK0</StoreId>
      <ExecutableList><Executable Name="StrictGame_x64.exe" Id="Game" /></ExecutableList>
    </Game>`;

    // Case A: Active extraction journal `.onelauncher-xbox-journal.json` -> MUST return null
    const journalDir = path.join(tmpDir, 'InProgressJournalGame');
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, 'MicrosoftGame.config'), configXml, 'utf8');
    fs.writeFileSync(
      path.join(journalDir, '.onelauncher-xbox-journal.json'),
      JSON.stringify({ version: 1, status: 'in_progress' }),
      'utf8'
    );
    fs.writeFileSync(path.join(journalDir, 'StrictGame_x64.exe'), buildValidMinimalPe64Buffer());
    expect(
      launcherEngine.inspectInstalledXboxGameDir(journalDir, { platform: 'darwin', strictPe: true })
    ).toBeNull();

    // Case B: Partial `.olpart` executable -> MUST return null
    const olpartDir = path.join(tmpDir, 'PartialOlpartGame');
    fs.mkdirSync(olpartDir, { recursive: true });
    fs.writeFileSync(path.join(olpartDir, 'MicrosoftGame.config'), configXml, 'utf8');
    fs.writeFileSync(
      path.join(olpartDir, 'StrictGame_x64.exe.olpart'),
      buildValidMinimalPe64Buffer()
    );
    expect(
      launcherEngine.inspectInstalledXboxGameDir(olpartDir, { platform: 'darwin', strictPe: true })
    ).toBeNull();

    // Case C: 42-byte stub `.exe` & encrypted ciphertext `.exe` under `strictPe: true` -> MUST return null
    const stubExeDir = path.join(tmpDir, 'Stub42ByteExeGame');
    fs.mkdirSync(stubExeDir, { recursive: true });
    fs.writeFileSync(path.join(stubExeDir, 'MicrosoftGame.config'), configXml, 'utf8');
    fs.writeFileSync(
      path.join(stubExeDir, 'StrictGame_x64.exe'),
      Buffer.from('MZ-42-byte-synthetic-stub-without-pe-hdr!!', 'utf8')
    );
    expect(
      launcherEngine.inspectInstalledXboxGameDir(stubExeDir, { platform: 'darwin', strictPe: true })
    ).toBeNull();

    const encryptedExeDir = path.join(tmpDir, 'EncryptedExeGame');
    fs.mkdirSync(encryptedExeDir, { recursive: true });
    fs.writeFileSync(path.join(encryptedExeDir, 'MicrosoftGame.config'), configXml, 'utf8');
    fs.writeFileSync(path.join(encryptedExeDir, 'StrictGame_x64.exe'), crypto.randomBytes(512));
    expect(
      launcherEngine.inspectInstalledXboxGameDir(encryptedExeDir, {
        platform: 'darwin',
        strictPe: true,
      })
    ).toBeNull();

    // Case D: Completed receipt + valid MZ + PE\0\0 (0x8664) executable -> ACCEPTED
    const validCompletedDir = path.join(tmpDir, 'CompletedValidPeGame');
    fs.mkdirSync(validCompletedDir, { recursive: true });
    fs.writeFileSync(path.join(validCompletedDir, 'MicrosoftGame.config'), configXml, 'utf8');
    fs.writeFileSync(
      path.join(validCompletedDir, '.onelauncher-xbox-receipt.json'),
      JSON.stringify({
        status: 'completed',
        xboxProductId: '9NSTRICTCHK0',
        title: 'Strict Verified Game',
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(validCompletedDir, 'StrictGame_x64.exe'),
      buildValidMinimalPe64Buffer()
    );
    const accepted = launcherEngine.inspectInstalledXboxGameDir(validCompletedDir, {
      platform: 'darwin',
      strictPe: true,
    });
    expect(accepted).not.toBeNull();
    expect(accepted.xboxProductId).toBe('9NSTRICTCHK0');
    expect(accepted.executablePath).toBe(path.join(validCompletedDir, 'StrictGame_x64.exe'));

    // Case E: `reconcileCatalogGamesWithInstalledRecords` preserves 1.63 GB catalog `installSize` against < 1 MB stub scan size
    const catalogBytes = 1_750_199_193; // ~1.63 GiB
    const catalogGame = makeCanonicalGameFixture({
      id: 'xbox-9NSTRICTCHK0',
      title: 'Strict Verified Game',
      platforms: [
        {
          platformId: 'xbox',
          platformGameId: '9NSTRICTCHK0',
          xboxProductId: '9NSTRICTCHK0',
          installed: false,
          installSize: catalogBytes,
        },
      ],
    });
    const reconciled = reconcileCatalogGamesWithInstalledRecords([catalogGame], [
      {
        platformId: 'xbox',
        platformGameId: '9NSTRICTCHK0',
        xboxProductId: '9NSTRICTCHK0',
        title: 'Strict Verified Game',
        installPath: validCompletedDir,
        executablePath: accepted.executablePath,
        installSize: 512 * 1024, // 512 KiB stub folder scan size
      } as any,
    ]);
    expect(reconciled[0].platforms[0].installed).toBe(true);
    expect(reconciled[0].platforms[0].installSize).toBe(catalogBytes);
  });

  it('verifies one_gameinput_bridge.dll PE32+, stages GameInput + *_app.dll CRT aliases + user.reg DllOverrides, and passes CrossOver --dll + OverrideWorkingDirectory cwd in launchGame', async () => {
    // 1. Verify prebuilt `one_gameinput_bridge.dll` PE32+ exports, marker, and clean imports
    const giVerified = buildXboxBridge.verifyGameInputBridgeDll();
    expect(giVerified.machine).toBe('0x8664');
    expect(giVerified.exports.slice().sort()).toEqual(['DllCanUnloadNow', 'GameInputCreate']);
    expect(giVerified.marker).toBe('OneLauncher.GameInputBridge.v1');

    // 2. Provision CrossOver bottle with `gameinput.dll`, `gameinputredist.dll`, `*_app.dll` CRT aliases, and `user.reg` DllOverrides
    const fakeHome = path.join(tmpDir, 'cx-home');
    const cxWineBin = path.join(
      fakeHome,
      'Applications',
      'CrossOver.app',
      'Contents',
      'SharedSupport',
      'CrossOver',
      'bin',
      'wine'
    );
    fs.mkdirSync(path.dirname(cxWineBin), { recursive: true });
    fs.writeFileSync(cxWineBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const bottleDir = path.join(
      fakeHome,
      'Library',
      'Application Support',
      'CrossOver',
      'Bottles',
      'XboxHardenedBottle'
    );
    const sys32Dir = path.join(bottleDir, 'drive_c', 'windows', 'system32');
    fs.mkdirSync(sys32Dir, { recursive: true });
    fs.writeFileSync(
      path.join(bottleDir, 'system.reg'),
      'WINE REGISTRY Version 2\n\n#arch=win64\n',
      'utf8'
    );
    // Seed donor CRT DLLs to verify `*_app.dll` UWP VCLibs alias provisioning
    const donorVcRuntime = buildValidMinimalPe64Buffer('DONOR-VCRUNTIME140');
    const donorMsvcp = buildValidMinimalPe64Buffer('DONOR-MSVCP140');
    fs.writeFileSync(path.join(sys32Dir, 'vcruntime140.dll'), donorVcRuntime);
    fs.writeFileSync(path.join(sys32Dir, 'msvcp140.dll'), donorMsvcp);

    // Seed game layout with `Content/MicrosoftGame.config`, `gamelaunchhelper.exe`, `SubBin/Primary_x64.exe`, `Content/base`, and retail `GameInput.dll`
    const gameRootDir = path.join(fakeHome, 'Games', 'OneLauncher', 'Xbox', 'SyntheticShooter');
    const contentRootDir = path.join(gameRootDir, 'Content');
    const subBinDir = path.join(contentRootDir, 'SubBin');
    const overrideWorkDir = path.join(contentRootDir, 'base');
    fs.mkdirSync(subBinDir, { recursive: true });
    fs.mkdirSync(overrideWorkDir, { recursive: true });
    fs.writeFileSync(path.join(gameRootDir, 'layout.xml'), '<PackageLayout />', 'utf8');

    const primaryExePath = path.join(subBinDir, 'PrimaryShooter_x64.exe');
    const helperExePath = path.join(contentRootDir, 'gamelaunchhelper.exe');
    const localGameInputDll = path.join(subBinDir, 'GameInput.dll');
    fs.writeFileSync(primaryExePath, buildValidMinimalPe64Buffer('PRIMARY-SHOOTER-EXE'));
    fs.writeFileSync(helperExePath, buildValidMinimalPe64Buffer('HELPER-EXE'));
    fs.writeFileSync(localGameInputDll, buildValidMinimalPe64Buffer('RETAIL-MSFT-GAMEINPUT'));
    fs.writeFileSync(
      path.join(contentRootDir, 'MicrosoftGame.config'),
      `<?xml version="1.0" encoding="utf-8"?>
<Game configVersion="1">
  <Identity Name="SyntheticStudio.Shooter" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" Version="1.0.0.0" />
  <TitleId>6432DF20</TitleId>
  <StoreId>9NSYNTHSHOOT</StoreId>
  <ExecutableList>
    <Executable Name="gamelaunchhelper.exe" Id="Helper" />
    <Executable Name="SubBin\\PrimaryShooter_x64.exe" Id="Game" OverrideWorkingDirectory="base" />
  </ExecutableList>
</Game>`,
      'utf8'
    );

    const provisioned = await wineAndCrossOverManager.prepareXboxBottleEnvironment({
      bottlePath: bottleDir,
      installDir: gameRootDir,
      executablePath: primaryExePath,
      packageFamilyName: 'SyntheticStudio.Shooter_8wekyb3d8bbwe',
      xuid: '2533274790000001',
      scid: '00000000-0000-0000-0000-00006432df20',
      env: {},
    });

    expect(provisioned.bridgeStaged).toBe(true);
    expect(provisioned.gameInputStaged).toBe(true);
    expect(fs.existsSync(path.join(sys32Dir, 'xgameruntime.dll'))).toBe(true);
    expect(fs.existsSync(path.join(sys32Dir, 'gameinput.dll'))).toBe(true);
    expect(fs.existsSync(path.join(sys32Dir, 'gameinputredist.dll'))).toBe(true);
    expect(fs.readFileSync(path.join(sys32Dir, 'vcruntime140_app.dll')).equals(donorVcRuntime)).toBe(
      true
    );
    expect(fs.readFileSync(path.join(sys32Dir, 'msvcp140_app.dll')).equals(donorMsvcp)).toBe(true);
    expect(fs.existsSync(`${localGameInputDll}.msft.bak`)).toBe(true);
    expect(
      fs
        .readFileSync(localGameInputDll)
        .includes(Buffer.from('OneLauncher.GameInputBridge.v1', 'ascii'))
    ).toBe(true);

    const userRegContent = fs.readFileSync(path.join(bottleDir, 'user.reg'), 'utf8');
    expect(userRegContent).toContain('[Software\\\\Wine\\\\DllOverrides]');
    expect(userRegContent).toContain('"xgameruntime"="native,builtin"');
    expect(userRegContent).toContain('"gameinput"="native,builtin"');
    expect(userRegContent).toContain('"gameinputredist"="native,builtin"');

    // 3. Verify `launchGame` passes `--dll` to CrossOver `bin/wine`, skips `gamelaunchhelper.exe`, and sets `cwd` to `Content/base`
    let capturedCmd = '';
    let capturedArgs: string[] = [];
    let capturedOpts: any = null;
    const mockChild = {
      pid: 42424,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((ev: string, cb: (...a: any[]) => void) => {
        if (ev === 'exit' || ev === 'close') {
          setTimeout(() => cb(0, null), 20);
        }
      }),
      unref: vi.fn(),
    };

    const launchRes = await launcherEngine.launchGame(
      {
        gameId: 'xbox-9NSYNTHSHOOT',
        title: 'Synthetic Shooter',
        platformId: 'xbox',
        platformGameId: '9NSYNTHSHOOT',
        installPath: gameRootDir,
        launchConfig: {
          preferredLaunchMethod: 'compatibility_layer',
          compatibilityLayer: 'crossover',
          winePrefix: bottleDir,
        },
      },
      {
        platform: 'darwin',
        homedir: fakeHome,
        userDataDir: path.join(tmpDir, 'launchUserData'),
        enableCloudSaveSync: false,
        gameSpawnFn: (cmd: string, args: string[], opts: any) => {
          capturedCmd = cmd;
          capturedArgs = args;
          capturedOpts = opts;
          return mockChild;
        },
      }
    );

    expect(launchRes.success).toBe(true);
    expect(capturedCmd).toBe(cxWineBin);
    expect(capturedArgs[0]).toBe('--dll');
    expect(capturedArgs[1]).toContain('xgameruntime=n');
    expect(capturedArgs[1]).toContain('gameinput=n');
    expect(capturedArgs[1]).toContain('gameinputredist=n');
    expect(capturedArgs[2]).toBe(primaryExePath);
    expect(capturedArgs.join(' ')).not.toContain('gamelaunchhelper.exe');
    expect(capturedOpts?.cwd).toBe(overrideWorkDir);

    await launcherEngine.stopGame('xbox-9NSYNTHSHOOT').catch(() => {});
  });
});

