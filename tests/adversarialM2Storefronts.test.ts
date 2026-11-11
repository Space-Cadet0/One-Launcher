import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import axios from 'axios';
import { FallbackMetadataProvider } from '../src/services/steam/fallbackMetadataProvider';
import {
  KNOWN_GAME_PATCHES,
  sanitizeGameCatalog,
  normalizeCanonicalTitle,
} from '../src/services/integrations/catalogSanitizer';
import type { CanonicalGame } from '../src/contracts/game';
import {
  walkHygieneFiles,
  scanRepoForPiiViolations,
  scanWorkspaceRootForPollutedEntries,
} from './helpers/piiHygieneGuard';

const require = createRequire(import.meta.url);
const { normalizeXblRpsTicket } = require('../electron/storefronts/xbox/xboxAuthManager.cjs');
const launcherEngine = require('../electron/launcherEngine.cjs');
const {
  extractEpicThirdPartyPartnerMetadata,
} = require('../electron/launcher/epicLegendaryAndEosCoordinator.cjs');
const {
  buildChainedLauncherLaunchSpec,
  normalizeChainedHandoffId,
} = require('../electron/launcher/chainedPublisherLaunchers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

describe('Adversarial Stress Verification: Milestone M2 Universal Portability & Storefronts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-adv-m2-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir && fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // ============================================================================
  // Dimension 1: Universal Portability & Zero-PII Invariant
  // ============================================================================
  describe('1. Universal Portability & Zero-PII Invariant', () => {
    it('1.1 strictly confirms KNOWN_GAME_PATCHES is empty ({}) and contains zero per-game patches or lore tokens', () => {
      expect(KNOWN_GAME_PATCHES).toEqual({});
      expect(Object.keys(KNOWN_GAME_PATCHES)).toHaveLength(0);

      const catalogSanitizerSource = fs.readFileSync(
        path.join(REPO_ROOT, 'src/services/integrations/catalogSanitizer.ts'),
        'utf8'
      );

      // Verify the exported constant is an empty object literal
      expect(catalogSanitizerSource).toMatch(
        /export\s+const\s+KNOWN_GAME_PATCHES\s*:\s*Record<string,\s*(?:Partial<CanonicalGame>|CatalogGamePatch)>\s*=\s*\{\s*\}\s*;/
      );

      // Verify absence of hardcoded game lore identifiers in sanitizer
      expect(catalogSanitizerSource).not.toContain('SHODAN');
      expect(catalogSanitizerSource).not.toContain('RAPTURE');
      expect(catalogSanitizerSource).not.toContain('3010850');
    });

    it('1.2 scans all repository targets (electron, src, scripts, tests, config) for zero personal paths (/Users/mike), webmail, or secrets', () => {
      const scanTargets = [
        'electron',
        'src',
        'build',
        'public',
        'scripts',
        'tests',
        'package.json',
        'README.md',
        'index.html',
        'vite.config.ts',
        'vitest.config.ts',
      ];
      const extRegex = /\.(?:cjs|mjs|js|ts|tsx|json|html|css|md|nsh|nsi|ps1|bat|py|c|h)$/i;
      const violations = scanRepoForPiiViolations(REPO_ROOT, scanTargets, extRegex);
      expect(violations).toEqual([]);

      const rootPollution = scanWorkspaceRootForPollutedEntries(REPO_ROOT);
      expect(rootPollution).toEqual([]);
    });

    it('1.3 sanitizeGameCatalog uniformly resolves arbitrary unfamiliar games without crashing or applying hardcoded lore', () => {
      const arbitraryGame: CanonicalGame = {
        id: 'steam-999999',
        title: 'Project Andromeda Void 2026',
        sortTitle: 'Project Andromeda Void 2026',
        steamAppId: 999999,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '999999', installed: false }],
        headerImage: 'https://cdn.example.com/header.jpg',
        capsuleImage: 'https://cdn.example.com/capsule.jpg',
        developers: ['Synthetic Studio'],
        publishers: ['Synthetic Publisher'],
        genres: ['Action'],
        tags: ['Sci-Fi'],
      };

      const result = sanitizeGameCatalog([arbitraryGame], {
        validSteamAppIds: new Set([999999]),
        validSteamTitles: new Set(['Project Andromeda Void 2026']),
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('steam-999999');
      expect(result[0].title).toBe('Project Andromeda Void 2026');
      expect(result[0].steamAppId).toBe(999999);
      expect(result[0].developers).toEqual(['Synthetic Studio']);
    });
  });

  // ============================================================================
  // Dimension 2: Xbox OAuth & Compact JWE Normalization
  // ============================================================================
  describe('2. Xbox OAuth & Compact JWE Normalization (normalizeXblRpsTicket)', () => {
    // Helper to generate syntactically valid Compact JWE
    function makeCompactJwe(headerObj: Record<string, unknown> = { alg: 'RSA1_5', enc: 'A128CBC-HS256' }) {
      const headerB64 = Buffer.from(JSON.stringify(headerObj), 'utf8').toString('base64url');
      const encKey = Buffer.from('mock_encrypted_key', 'utf8').toString('base64url');
      const iv = Buffer.from('mock_initialization_vector', 'utf8').toString('base64url');
      const cipher = Buffer.from('mock_ciphertext_data', 'utf8').toString('base64url');
      const tag = Buffer.from('mock_auth_tag', 'utf8').toString('base64url');
      return `${headerB64}.${encKey}.${iv}.${cipher}.${tag}`;
    }

    it('2.1 strictly rewrites 5-segment Compact JWEs to t=<bare> regardless of input prefix or whitespace', () => {
      const validJwe = makeCompactJwe();

      // Bare JWE
      expect(normalizeXblRpsTicket(validJwe)).toBe(`t=${validJwe}`);

      // d= prefixed JWE (RST2 TOKEN_BROKER ticket)
      expect(normalizeXblRpsTicket(`d=${validJwe}`)).toBe(`t=${validJwe}`);

      // t= prefixed JWE
      expect(normalizeXblRpsTicket(`t=${validJwe}`)).toBe(`t=${validJwe}`);

      // Uppercase D= and T= prefixes
      expect(normalizeXblRpsTicket(`D=${validJwe}`)).toBe(`t=${validJwe}`);
      expect(normalizeXblRpsTicket(`T=${validJwe}`)).toBe(`t=${validJwe}`);

      // Whitespace padded
      expect(normalizeXblRpsTicket(`   d=${validJwe}   `)).toBe(`t=${validJwe}`);
      expect(normalizeXblRpsTicket(`\t\n${validJwe}\n`)).toBe(`t=${validJwe}`);
    });

    it('2.2 rejects non-5-segment strings from being treated as JWE and handles them safely', () => {
      // 4-segment string
      const fourParts = 'part1.part2.part3.part4';
      expect(normalizeXblRpsTicket(fourParts)).toBe(`t=${fourParts}`);
      expect(normalizeXblRpsTicket(`d=${fourParts}`)).toBe(`d=${fourParts}`);
      expect(normalizeXblRpsTicket(`t=${fourParts}`)).toBe(`t=${fourParts}`);

      // 6-segment string
      const sixParts = 'part1.part2.part3.part4.part5.part6';
      expect(normalizeXblRpsTicket(sixParts)).toBe(`t=${sixParts}`);
      expect(normalizeXblRpsTicket(`d=${sixParts}`)).toBe(`d=${sixParts}`);
      expect(normalizeXblRpsTicket(`t=${sixParts}`)).toBe(`t=${sixParts}`);

      // 1-segment string
      const onePart = 'singlepart';
      expect(normalizeXblRpsTicket(onePart)).toBe(`t=${onePart}`);
      expect(normalizeXblRpsTicket(`d=${onePart}`)).toBe(`d=${onePart}`);
    });

    it('2.3 rejects 5-segment candidates with non-Base64URL characters, oversized headers, or invalid padding', () => {
      const validJwe = makeCompactJwe();
      const parts = validJwe.split('.');

      // Illegal characters (e.g. *, +, /, @, !)
      const withAsterisk = parts.map((p, idx) => (idx === 3 ? p + '*bad' : p)).join('.');
      expect(normalizeXblRpsTicket(`d=${withAsterisk}`)).toBe(`d=${withAsterisk}`);

      const withPlus = parts.map((p, idx) => (idx === 1 ? p + '+' : p)).join('.');
      expect(normalizeXblRpsTicket(`d=${withPlus}`)).toBe(`d=${withPlus}`);

      // Invalid Base64URL segment length (seg.length % 4 === 1 is mathematically impossible in valid Base64)
      const invalidLenSeg = parts.map((p, idx) => (idx === 2 ? 'a' : p)).join('.');
      expect(normalizeXblRpsTicket(`d=${invalidLenSeg}`)).toBe(`d=${invalidLenSeg}`);

      // Oversized header (> 8192 chars)
      const oversizedHeader = 'a'.repeat(8193);
      const oversizedJwe = `${oversizedHeader}.${parts[1]}.${parts[2]}.${parts[3]}.${parts[4]}`;
      expect(normalizeXblRpsTicket(`d=${oversizedJwe}`)).toBe(`d=${oversizedJwe}`);
    });

    it('2.4 rejects 5-segment candidates whose header decodes to malformed JSON or missing alg/enc', () => {
      const encKey = Buffer.from('k').toString('base64url');
      const iv = Buffer.from('i').toString('base64url');
      const cipher = Buffer.from('c').toString('base64url');
      const tag = Buffer.from('t').toString('base64url');

      // Header is not JSON
      const notJsonHeader = Buffer.from('THIS IS NOT JSON', 'utf8').toString('base64url');
      const badHeaderJwe = `${notJsonHeader}.${encKey}.${iv}.${cipher}.${tag}`;
      expect(normalizeXblRpsTicket(`d=${badHeaderJwe}`)).toBe(`d=${badHeaderJwe}`);

      // Header is JSON primitive number
      const numHeader = Buffer.from('12345', 'utf8').toString('base64url');
      expect(normalizeXblRpsTicket(`d=${numHeader}.${encKey}.${iv}.${cipher}.${tag}`)).toBe(
        `d=${numHeader}.${encKey}.${iv}.${cipher}.${tag}`
      );

      // Header is JSON array
      const arrHeader = Buffer.from('["alg", "enc"]', 'utf8').toString('base64url');
      expect(normalizeXblRpsTicket(`d=${arrHeader}.${encKey}.${iv}.${cipher}.${tag}`)).toBe(
        `d=${arrHeader}.${encKey}.${iv}.${cipher}.${tag}`
      );

      // Header missing alg
      const noAlgHeader = Buffer.from(JSON.stringify({ enc: 'A128CBC-HS256' }), 'utf8').toString('base64url');
      expect(normalizeXblRpsTicket(`d=${noAlgHeader}.${encKey}.${iv}.${cipher}.${tag}`)).toBe(
        `d=${noAlgHeader}.${encKey}.${iv}.${cipher}.${tag}`
      );

      // Header missing enc
      const noEncHeader = Buffer.from(JSON.stringify({ alg: 'RSA1_5' }), 'utf8').toString('base64url');
      expect(normalizeXblRpsTicket(`d=${noEncHeader}.${encKey}.${iv}.${cipher}.${tag}`)).toBe(
        `d=${noEncHeader}.${encKey}.${iv}.${cipher}.${tag}`
      );

      // Header with empty alg or enc string
      const emptyAlgHeader = Buffer.from(JSON.stringify({ alg: '', enc: 'A128CBC' }), 'utf8').toString('base64url');
      expect(normalizeXblRpsTicket(`d=${emptyAlgHeader}.${encKey}.${iv}.${cipher}.${tag}`)).toBe(
        `d=${emptyAlgHeader}.${encKey}.${iv}.${cipher}.${tag}`
      );
    });

    it('2.5 handles non-JWE opaque tickets, whitespace, empty values, and extreme inputs safely without crashing', () => {
      // Empty / whitespace inputs
      expect(normalizeXblRpsTicket('')).toBe('');
      expect(normalizeXblRpsTicket('   ')).toBe('');
      expect(normalizeXblRpsTicket(null)).toBe('');
      expect(normalizeXblRpsTicket(undefined)).toBe('');
      expect(normalizeXblRpsTicket('d=')).toBe('');
      expect(normalizeXblRpsTicket('t=')).toBe('');

      // Non-JWE opaque tickets
      const opaque = 'EwB4Aq1BAAA_mock_opaque_compact_ticket_abc123';
      expect(normalizeXblRpsTicket(`d=${opaque}`)).toBe(`d=${opaque}`);
      expect(normalizeXblRpsTicket(`t=${opaque}`)).toBe(`t=${opaque}`);
      expect(normalizeXblRpsTicket(opaque)).toBe(`t=${opaque}`);
      expect(normalizeXblRpsTicket(opaque, { defaultPrefix: 'd=' })).toBe(`d=${opaque}`);

      // Case-normalization for opaque prefixes
      expect(normalizeXblRpsTicket(`D=${opaque}`)).toBe(`d=${opaque}`);
      expect(normalizeXblRpsTicket(`T=${opaque}`)).toBe(`t=${opaque}`);

      // Extreme 100k length input
      const hugeInput = 'd=' + 'x'.repeat(100000);
      const res = normalizeXblRpsTicket(hugeInput);
      expect(res.startsWith('d=')).toBe(true);
      expect(res.length).toBe(100002);
    });
  });

  // ============================================================================
  // Dimension 3: Steam Cold Start Edge Cases
  // ============================================================================
  describe('3. Steam Cold Start & Cloud Log Resilience', () => {
    it('3.1 waitForSteamColdStartupCloudReady handles missing steamRoot and nonexistent logs gracefully', async () => {
      const nonExistentDir = path.join(tmpDir, 'nonexistent_steam');

      // When enableTwoStageSteamColdStart is active, missing logs should cleanly time out without exceptions
      const res = await launcherEngine.waitForSteamColdStartupCloudReady(nonExistentDir, '480', {
        enableTwoStageSteamColdStart: true,
        maxStartupCloudWaitMs: 30,
        pollIntervalMs: 10,
        platform: 'win32',
      });

      expect(res).toBeDefined();
      expect(res.ready).toBe(false);
      expect(res.timedOut).toBe(true);
      expect(res.reason).toBe('timeout');
      expect(res.waitedMs).toBeGreaterThanOrEqual(0);
    });

    it('3.2 waitForSteamColdStartupCloudReady handles 0-byte/empty cloud_log.txt and settles when client sync arrives', async () => {
      const steamDir = path.join(tmpDir, 'steam_empty_log');
      const logsDir = path.join(steamDir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const cloudLogPath = path.join(logsDir, 'cloud_log.txt');

      // Create 0-byte cloud log initially
      fs.writeFileSync(cloudLogPath, '', 'utf8');

      // 1. When log remains empty, wait times out safely without crashing
      const timeoutRes = await launcherEngine.waitForSteamColdStartupCloudReady(steamDir, '480', {
        enableTwoStageSteamColdStart: true,
        maxStartupCloudWaitMs: 30,
        pollIntervalMs: 10,
        platform: 'win32',
      });
      expect(timeoutRes.ready).toBe(false);
      expect(timeoutRes.timedOut).toBe(true);
      expect(timeoutRes.reason).toBe('timeout');

      // 2. When Steam logs client sync OK after boot, it settles successfully
      const syncPromise = launcherEngine.waitForSteamColdStartupCloudReady(steamDir, '480', {
        enableTwoStageSteamColdStart: true,
        maxStartupCloudWaitMs: 500,
        pollIntervalMs: 20,
        settleAfterClientSyncMs: 30,
        platform: 'win32',
      });

      // Simulate Steam writing log lines after cold startup process launches
      setTimeout(() => {
        fs.appendFileSync(
          cloudLogPath,
          '[2026-11-11 10:00:00] [AppID 480] Starting sync (init,)\n' +
            '[2026-11-11 10:00:01] OnRemoteStorageSyncedClient() - result OK\n' +
            '[2026-11-11 10:00:01] [AppID 480] Eval complete\n',
          'utf8'
        );
      }, 25);

      const syncRes = await syncPromise;
      expect(syncRes).toBeDefined();
      expect(syncRes.ready).toBe(true);
      expect(syncRes.reason).toBe('startup_cloud_synced');
    });

    it('3.3 waitForSteamCloudSyncCompletion exits immediately with no_active_cloud_job when log is missing or empty', async () => {
      const steamDir = path.join(tmpDir, 'steam_sync_test');
      const logsDir = path.join(steamDir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      // 1. Completely missing log file
      const resMissing = await launcherEngine.waitForSteamCloudSyncCompletion(steamDir, '620', {
        platform: 'win32',
      });
      expect(resMissing.completed).toBe(true);
      expect(resMissing.waitedMs).toBe(0);
      expect(resMissing.reason).toBe('no_active_cloud_job');

      // 2. Empty log file (0 bytes)
      const cloudLog = path.join(logsDir, 'cloud_log.txt');
      fs.writeFileSync(cloudLog, '', 'utf8');

      const resEmpty = await launcherEngine.waitForSteamCloudSyncCompletion(steamDir, '620', {
        platform: 'win32',
      });
      expect(resEmpty.completed).toBe(true);
      expect(resEmpty.waitedMs).toBe(0);
      expect(resEmpty.reason).toBe('no_active_cloud_job');

      // 3. Empty appId
      const resNoApp = await launcherEngine.waitForSteamCloudSyncCompletion(steamDir, '', {
        platform: 'win32',
      });
      expect(resNoApp.completed).toBe(true);
      expect(resNoApp.reason).toBe('no_active_cloud_job');
    });
  });

  // ============================================================================
  // Dimension 4: GOG Catalog Scraper Malicious Query & Sandbox Injection
  // ============================================================================
  describe('4. GOG Catalog Scraper Sandbox Guard & Fallbacks', () => {
    it('4.1 rejects injected TEST DEVELOPER and TEST PUBLISHER sandbox candidates from catalog fallback', async () => {
      const requestedUrls: string[] = [];

      vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        requestedUrls.push(url);
        if (url.includes('/v1/catalog')) {
          return {
            data: {
              productCount: 1,
              products: [
                {
                  id: '99990001',
                  slug: 'malicious_sandbox_entry',
                  title: 'Adversarial Test Edition',
                  developers: ['TEST DEVELOPER'],
                  publishers: ['TEST PUBLISHER'],
                },
              ],
            },
          };
        }
        return { data: {} };
      });

      const provider = new FallbackMetadataProvider();
      const res = await provider.fetchGogProductMetadata('99990001', 'Adversarial Test Edition');

      expect(requestedUrls.some((u) => u.includes('/v1/catalog'))).toBe(true);
      expect(res?.developers || []).not.toContain('TEST DEVELOPER');
      expect(res?.publishers || []).not.toContain('TEST PUBLISHER');
    });

    it('4.2 discards recommended products when productCount === 0 to prevent zero-match poisoning', async () => {
      vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (url.includes('/v1/catalog')) {
          return {
            data: {
              productCount: 0, // Zero search matches found by GOG
              products: [
                {
                  id: '123456789',
                  slug: 'unrelated_promoted_title',
                  title: 'Unrelated Best Seller',
                  developers: ['Unrelated Dev'],
                  publishers: ['Unrelated Pub'],
                },
              ],
            },
          };
        }
        return { data: {} };
      });

      const provider = new FallbackMetadataProvider();
      const res = await provider.fetchGogProductMetadata('99990002', 'Nonexistent Indie Title');

      expect(res?.developers || []).not.toContain('Unrelated Dev');
      expect(res?.publishers || []).not.toContain('Unrelated Pub');
    });

    it('4.3 gracefully tolerates API network rejections (500, 404, network timeout) without throwing', async () => {
      vi.spyOn(axios, 'get').mockRejectedValue(new Error('Network Gateway Timeout 504'));

      const provider = new FallbackMetadataProvider();
      const res = await provider.fetchGogProductMetadata('99990003', 'Failing Connection Title');
      expect(res).toBeDefined();
    });
  });

  // ============================================================================
  // Dimension 5: Epic Third-Party Partner Handoff Edge Cases
  // ============================================================================
  describe('5. Epic Third-Party Partner Launcher Handoff', () => {
    it('5.1 extractEpicThirdPartyPartnerMetadata handles null, undefined, primitive, and empty inputs gracefully', () => {
      expect(extractEpicThirdPartyPartnerMetadata(null)).toEqual({});
      expect(extractEpicThirdPartyPartnerMetadata(undefined)).toEqual({});
      expect(extractEpicThirdPartyPartnerMetadata('not_an_object')).toEqual({});
      expect(extractEpicThirdPartyPartnerMetadata({})).toEqual({});
      expect(
        extractEpicThirdPartyPartnerMetadata({
          customAttributes: {},
          metadata: {},
        })
      ).toEqual({});
    });

    it('5.2 correctly classifies EA and Ubisoft partner launchers across case variations and nested schemas', () => {
      // 1. EA App via string customAttributes
      const eaMeta1 = extractEpicThirdPartyPartnerMetadata({
        customAttributes: {
          ThirdPartyManagedApp: 'The EA App',
          PartnerLinkType: 'origin',
          PartnerLinkId: 'Origin.OFR.50.000123',
          RegistryPath: 'Software\\Electronic Arts\\EA Core',
        },
      });
      expect(eaMeta1.chainedLauncherHandoff).toBe('ea');
      expect(eaMeta1.externalStorefrontHandoff).toBe('ea');
      expect(eaMeta1.chainedHandoffTopology).toBe('partner_launcher_link');
      expect(eaMeta1.chainedExternalInstallId).toBe('Origin.OFR.50.000123');
      expect(eaMeta1.epicPartnerRegistryPath).toBe('Software\\Electronic Arts\\EA Core');

      // 2. Ubisoft Connect via { value: '...' } schema
      const ubiMeta = extractEpicThirdPartyPartnerMetadata({
        game: {
          customAttributes: {
            ThirdPartyManagedApp: { value: 'Ubisoft Connect' },
            PartnerLinkType: { value: 'uplay' },
            PartnerLinkId: { value: '45678' },
          },
        },
      });
      expect(ubiMeta.chainedLauncherHandoff).toBe('ubisoft');
      expect(ubiMeta.externalStorefrontHandoff).toBe('ubisoft');
      expect(ubiMeta.chainedHandoffTopology).toBe('partner_launcher_link');
      expect(ubiMeta.chainedExternalInstallId).toBe('45678');

      // 3. Unrecognized partner launcher preserves registry paths without false handoff
      const unknownPartner = extractEpicThirdPartyPartnerMetadata({
        customAttributes: {
          ThirdPartyManagedApp: 'UnknownCustomPublisher',
          RegistryPath: 'Software\\Unknown\\Game',
        },
      });
      expect(unknownPartner.chainedLauncherHandoff).toBeUndefined();
      expect(unknownPartner.epicPartnerRegistryPath).toBe('Software\\Unknown\\Game');
    });

    it('5.3 buildChainedLauncherLaunchSpec generates origin2:// and uplay:// launch specs and defaults safely', () => {
      // EA launch spec with external id
      const eaSpec = buildChainedLauncherLaunchSpec({
        handoffId: 'ea',
        externalInstallId: 'Origin.OFR.50.000999',
        launcherBinaryPath: 'C:\\Program Files\\EA Games\\EALauncher.exe',
        platform: 'win32',
      });
      expect(eaSpec.uri).toBe('origin2://game/launch?offerIds=Origin.OFR.50.000999&autoDownload=1');
      expect(eaSpec.args).toContain(
        'origin2://game/launch?offerIds=Origin.OFR.50.000999&autoDownload=1'
      );

      // Ubisoft launch spec with external id
      const ubiSpec = buildChainedLauncherLaunchSpec({
        handoffId: 'ubisoft',
        externalInstallId: '98765',
        launcherBinaryPath: 'C:\\Program Files\\Ubisoft\\Ubisoft Game Launcher\\upc.exe',
        platform: 'win32',
      });
      expect(ubiSpec.uri).toBe('uplay://launch/98765/0');
      expect(ubiSpec.args).toContain('uplay://launch/98765/0');

      // Edge case: missing external id and missing launcher binary
      const emptyEaSpec = buildChainedLauncherLaunchSpec({
        handoffId: 'ea',
        platform: 'win32',
      });
      expect(emptyEaSpec).toBeDefined();
      expect(emptyEaSpec.uri).toBeUndefined();

      // Unknown handoff ID falls back to standard execution without throwing
      const unknownSpec = buildChainedLauncherLaunchSpec({
        handoffId: 'custom_unknown_handoff',
        gameExecutablePath: 'C:\\Games\\Custom\\game.exe',
        platform: 'win32',
      });
      expect(unknownSpec.launcherExe).toBe('C:\\Games\\Custom\\game.exe');
      expect(unknownSpec.args).toEqual([]);
    });
  });
});
