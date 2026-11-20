import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface UnsafeUrlError extends Error {
  code?: string;
  isSsrfBlocked?: boolean;
  isDnsUnavailable?: boolean;
}

interface SecurityAndPathUtilsModule {
  ALLOWED_LAUNCHER_SETTINGS_KEYS: Set<string>;
  sanitizeLauncherSettingsPayload: (raw: unknown) => Record<string, unknown>;
  recordImportedEpicInstall: (
    entryOrApp: string | Record<string, unknown>,
    pathOrOpts?: string | Record<string, unknown>,
    maybeOpts?: Record<string, unknown>
  ) => boolean;
  getImportedEpicInstalls: (opts?: Record<string, unknown>) => {
    imports: Record<string, Record<string, unknown>>;
    updatedAt?: string;
  };
  assertSafePublicHttpsUrlSyntax: (urlStr: unknown) => {
    url: string;
    hostname: string;
    isIpLiteral: boolean;
  };
  assertSafePublicHttpsUrl: (
    urlStr: unknown,
    options?: {
      dnsLookup?: (
        hostname: string,
        opts: { all: true }
      ) => Promise<Array<{ address: string }>>;
      skipDnsForReservedTestTld?: boolean;
    }
  ) => Promise<{ url: string; hostname: string; addresses: string[] }>;
  clearPublicDnsSafetyCache: () => void;
}

interface SqlitePreparedStatement {
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  all: (...params: unknown[]) => Array<Record<string, unknown>>;
  run: (...params: unknown[]) => { changes?: number };
}

interface SqliteDbHandle {
  prepare: (sql: string) => SqlitePreparedStatement;
  exec: (sql: string) => void;
}

interface VaultMediaResult {
  kind: 'file' | 'buffer' | 'error';
  filePath?: string;
  buffer?: Buffer;
  mimeType?: string;
  sizeBytes?: number;
  cacheControl?: string;
  source?: string;
  status?: number;
  reason?: string;
  nextRetryAt?: number;
}

interface OfflineVaultInstance {
  ensureOpen: () => SqliteDbHandle;
  shutdown: () => void;
  upsertGames: (games: Array<Record<string, unknown>>) => { success: boolean; upserted?: number };
  deleteGames: (ids: string[]) => { success: boolean; deleted: number };
  saveUserOverride: (
    gameId: string,
    record?: Record<string, unknown>,
    extraKeys?: string[]
  ) => { success: boolean; invalidated: number };
  removeUserOverride: (
    gameId: string,
    extraKeys?: string[]
  ) => { success: boolean; invalidated: number };
  sweepOrphanBlobs: (opts?: { reclaimLegacyP2NonCover?: boolean }) => {
    success: boolean;
    orphanBlobsRemoved: number;
    freedBytes: number;
  };
  resolveLocalCachedMedia: (params: Record<string, unknown>) => Promise<VaultMediaResult | null>;
  resolveMediaRequest: (
    params: Record<string, unknown>,
    reqOpts?: { localCacheOnly?: boolean; signal?: AbortSignal }
  ) => Promise<VaultMediaResult>;
  isAssetAlreadyHydratedOrBackedOff: (params: Record<string, unknown>) => boolean;
  isAssetBackedOffFailure: (params: Record<string, unknown>) => boolean;
  getBlobFilePath: (sha256: string, ext: string) => string;
}

interface OfflineVaultModule {
  normalizeAssetIdentityUrl: (url: string) => string;
  createOfflineVaultService: (options: Record<string, unknown>) => OfflineVaultInstance;
}

interface OfflineVaultIpcModule {
  createOlMediaProtocolHandler: (deps: {
    offlineVaultService?: OfflineVaultInstance;
    getOfflineVault?: () => OfflineVaultInstance;
    dnsLookup?: (
      hostname: string,
      opts: { all: true }
    ) => Promise<Array<{ address: string }>>;
  }) => (request: Request) => Promise<Response>;
}

const securityUtils = require('../electron/launcher/securityAndPathUtils.cjs') as SecurityAndPathUtilsModule;
const offlineVaultMod = require('../electron/launcher/offlineVaultService.cjs') as OfflineVaultModule;
const offlineVaultIpc = require('../electron/ipc/offlineVaultIpcHandlers.cjs') as OfflineVaultIpcModule;

function makeValidImageBuffer(format: 'jpeg' | 'png' | 'webp', fillByte: number, size = 256): Buffer {
  const buf = Buffer.alloc(Math.max(size, 64), fillByte);
  if (format === 'jpeg') {
    buf[0] = 0xff;
    buf[1] = 0xd8;
    buf[2] = 0xff;
    buf[3] = 0xe0;
    buf[buf.length - 2] = 0xff;
    buf[buf.length - 1] = 0xd9;
  } else if (format === 'png') {
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  } else {
    Buffer.from('RIFF', 'ascii').copy(buf, 0);
    buf.writeUInt32LE(buf.length - 8, 4);
    Buffer.from('WEBP', 'ascii').copy(buf, 8);
  }
  return buf;
}

function makeMockHttpResponse(opts: {
  status: number;
  body: Buffer | string;
  contentType?: string;
}): Response {
  const bodyPayload = typeof opts.body === 'string' ? opts.body : new Uint8Array(opts.body);
  return new Response(bodyPayload, {
    status: opts.status,
    headers: {
      'content-type': opts.contentType || (typeof opts.body === 'string' ? 'text/plain' : 'image/jpeg'),
    },
  });
}

function makeHermeticFederator() {
  return {
    resolveFederatedAsset: () => null,
    resolveLocalStoreAsset: () => null,
  };
}

describe('Wave 1: Vault Media Non-Destructive Pinning, Unified url_resolution_cache & Zero-DNS Security', () => {
  const sandboxes: string[] = [];

  function makeTempSandbox(prefix = 'ol-wave1-vault-'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    sandboxes.push(dir);
    return dir;
  }

  beforeEach(() => {
    securityUtils.clearPublicDnsSafetyCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    securityUtils.clearPublicDnsSafetyCache();
    while (sandboxes.length > 0) {
      const dir = sandboxes.pop();
      if (dir && fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  // =========================================================================
  // 1. Global Settings Allowlist & Legacy HUD Migration (Task 1)
  // =========================================================================
  describe('1. securityAndPathUtils — Global Settings Allowlist & Legacy HUD Migration', () => {
    const EXACT_ELEVEN_PERF_KEYS = [
      'inGameLauncherBehavior',
      'postGameLauncherBehavior',
      'pauseBackgroundSyncInGame',
      'pauseDownloadsInGame',
      'storefrontClientLifecycle',
      'autoShutdownWinePrefixOnExit',
      'suppressWineDebugLogging',
      'defaultBottleDisplayScalingMode',
      'defaultDisplayAspectRatio',
      'enableFullscreenHotkey',
      'defaultPerformanceHud',
    ] as const;

    it('includes all 11 LauncherPerformanceSettings keys and excludes dead enableMetalHud / enableMangoHud keys', () => {
      for (const key of EXACT_ELEVEN_PERF_KEYS) {
        expect(securityUtils.ALLOWED_LAUNCHER_SETTINGS_KEYS.has(key)).toBe(true);
      }
      expect(securityUtils.ALLOWED_LAUNCHER_SETTINGS_KEYS.has('enableMetalHud')).toBe(false);
      expect(securityUtils.ALLOWED_LAUNCHER_SETTINGS_KEYS.has('enableMangoHud')).toBe(false);
    });

    it('migrates legacy enableMetalHud / enableMangoHud === true to defaultPerformanceHud without emitting dead keys', () => {
      const fromMetal = securityUtils.sanitizeLauncherSettingsPayload({
        enableMetalHud: true,
        inGameLauncherBehavior: 'hide_tray_hibernate',
      });
      expect(fromMetal).toEqual({
        inGameLauncherBehavior: 'hide_tray_hibernate',
        defaultPerformanceHud: true,
      });
      expect('enableMetalHud' in fromMetal).toBe(false);

      const fromMango = securityUtils.sanitizeLauncherSettingsPayload({
        enableMangoHud: true,
      });
      expect(fromMango).toEqual({ defaultPerformanceHud: true });
      expect('enableMangoHud' in fromMango).toBe(false);

      // Explicit defaultPerformanceHud: false MUST override legacy enableMetalHud: true
      const explicitOffWins = securityUtils.sanitizeLauncherSettingsPayload({
        defaultPerformanceHud: false,
        enableMetalHud: true,
        enableMangoHud: true,
      });
      expect(explicitOffWins).toEqual({ defaultPerformanceHud: false });
      expect('enableMetalHud' in explicitOffWins).toBe(false);
      expect('enableMangoHud' in explicitOffWins).toBe(false);

      // False legacy keys translate to defaultPerformanceHud: false (so legacy callers can turn it off) and are stripped
      const legacyFalse = securityUtils.sanitizeLauncherSettingsPayload({
        enableMetalHud: false,
        enableMangoHud: false,
      });
      expect(legacyFalse).toEqual({ defaultPerformanceHud: false });
      expect('enableMetalHud' in legacyFalse).toBe(false);
      expect('enableMangoHud' in legacyFalse).toBe(false);

      // All 11 keys pass cleanly while unknown keys are stripped
      const fullPayload = securityUtils.sanitizeLauncherSettingsPayload({
        inGameLauncherBehavior: 'zero_renderer_daemon',
        postGameLauncherBehavior: 'restore_window',
        pauseBackgroundSyncInGame: true,
        pauseDownloadsInGame: true,
        storefrontClientLifecycle: 'minimal_and_close_if_started',
        autoShutdownWinePrefixOnExit: true,
        suppressWineDebugLogging: true,
        defaultBottleDisplayScalingMode: 'auto_fullscreen',
        defaultDisplayAspectRatio: 'preserve_aspect',
        enableFullscreenHotkey: true,
        defaultPerformanceHud: true,
        injectedUnknownField: 'blocked',
      });
      expect(Object.keys(fullPayload).sort()).toEqual([...EXACT_ELEVEN_PERF_KEYS].sort());
      expect(fullPayload.injectedUnknownField).toBeUndefined();
    });
  });

  // =========================================================================
  // 2. Epic Import Ping-Pong Fix (S-05)
  // =========================================================================
  describe('2. securityAndPathUtils — Epic Import Source Ping-Pong Fix (S-05)', () => {
    it('does not rewrite one_launcher_epic_imports.json when only source differs between *.item and LauncherInstalled.dat', () => {
      const userDataDir = makeTempSandbox('ol-epic-imports-');
      const importsPath = path.join(userDataDir, 'one_launcher_epic_imports.json');
      const installDir = path.join(userDataDir, 'games', 'SynthEpicTitle');

      expect(
        securityUtils.recordImportedEpicInstall(
          {
            appName: 'SynthApp01',
            installPath: installDir,
            source: path.join(userDataDir, 'Manifests', 'synth01.item'),
          },
          { userDataDir }
        )
      ).toBe(true);
      expect(fs.existsSync(importsPath)).toBe(true);

      const initialRaw = fs.readFileSync(importsPath, 'utf8');
      const pastMtime = new Date(Date.now() - 60_000);
      fs.utimesSync(importsPath, pastMtime, pastMtime);
      const beforeMtimeMs = fs.statSync(importsPath).mtimeMs;

      // Alternate source (`LauncherInstalled.dat`) with trailing slash in installPath
      expect(
        securityUtils.recordImportedEpicInstall(
          {
            appName: 'SynthApp01',
            installPath: `${installDir}/`,
            source: path.join(userDataDir, 'UnrealEngineLauncher', 'LauncherInstalled.dat'),
          },
          { userDataDir }
        )
      ).toBe(true);

      // Alternate back to `*.item`
      expect(
        securityUtils.recordImportedEpicInstall(
          {
            appName: 'SynthApp01',
            installPath: installDir,
            source: path.join(userDataDir, 'Manifests', 'synth01.item'),
          },
          { userDataDir }
        )
      ).toBe(true);

      expect(fs.statSync(importsPath).mtimeMs).toBe(beforeMtimeMs);
      expect(fs.readFileSync(importsPath, 'utf8')).toBe(initialRaw);

      // Genuine installPath change MUST rewrite disk
      const movedDir = path.join(userDataDir, 'games', 'SynthEpicTitleMoved');
      expect(
        securityUtils.recordImportedEpicInstall(
          {
            appName: 'SynthApp01',
            installPath: movedDir,
            source: path.join(userDataDir, 'UnrealEngineLauncher', 'LauncherInstalled.dat'),
          },
          { userDataDir }
        )
      ).toBe(true);
      const updated = securityUtils.getImportedEpicInstalls({ userDataDir });
      expect(updated.imports.SynthApp01.installPath).toBe(movedDir);
    });
  });

  // =========================================================================
  // 3. Zero-DNS Lexical Validator & Bounded DNS Cache
  // =========================================================================
  describe('3. securityAndPathUtils — assertSafePublicHttpsUrlSyntax & Bounded DNS Cache', () => {
    it('synchronously rejects non-HTTPS, credentials, control chars, local/single-label/numeric-TLD hosts, and private/metadata IP literals with zero DNS calls', () => {
      const dnsSpy = vi.spyOn(dns.promises, 'lookup');

      const blockedUrls: unknown[] = [
        '',
        null,
        undefined,
        'http://cdn.example.com/cover.jpg',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'https://user:pass@cdn.example.com/cover.jpg',
        'https://user@cdn.example.com/cover.jpg',
        'https://cdn.example.com/cover\r\n.jpg',
        'https://cdn.example.com/cover\0.jpg',
        'https://localhost/cover.jpg',
        'https://sub.localhost/cover.jpg',
        'https://nas.local/cover.jpg',
        'https://metadata.google.internal/computeMetadata/v1/',
        'https://gateway.home.arpa/cover.jpg',
        'https://intranet/cover.jpg',
        'https://host.123/cover.jpg',
        'https://127.0.0.1/cover.jpg',
        'https://2130706433/cover.jpg',
        'https://0x7f.0.0.1/cover.jpg',
        'https://10.0.0.5/cover.jpg',
        'https://172.16.4.2/cover.jpg',
        'https://192.168.1.10/cover.jpg',
        'https://169.254.169.254/latest/meta-data',
        'https://100.64.0.1/cgnat.jpg',
        'https://0.0.0.0/a.jpg',
        'https://[::1]/a.jpg',
        'https://[::]/a.jpg',
        'https://[::ffff:127.0.0.1]/a.jpg',
        'https://[::ffff:169.254.169.254]/a.jpg',
        'https://[fc00::1]/a.jpg',
        'https://[fe80::1]/a.jpg',
      ];

      for (const bad of blockedUrls) {
        let caught: UnsafeUrlError | null = null;
        try {
          securityUtils.assertSafePublicHttpsUrlSyntax(bad);
        } catch (err) {
          caught = err as UnsafeUrlError;
        }
        expect(caught, `Expected URL to be blocked: ${String(bad)}`).not.toBeNull();
        expect(caught?.isSsrfBlocked).toBe(true);
        expect(caught?.isDnsUnavailable).toBe(false);
      }

      const validDomain = securityUtils.assertSafePublicHttpsUrlSyntax(
        'https://cdn.example.com/assets/cover.jpg'
      );
      expect(validDomain.hostname).toBe('cdn.example.com');
      expect(validDomain.isIpLiteral).toBe(false);

      const validPublicIpv4 = securityUtils.assertSafePublicHttpsUrlSyntax(
        'https://93.184.216.34/cover.jpg'
      );
      expect(validPublicIpv4.hostname).toBe('93.184.216.34');
      expect(validPublicIpv4.isIpLiteral).toBe(true);

      const validPublicIpv6 = securityUtils.assertSafePublicHttpsUrlSyntax(
        'https://[2606:2800:220:1:248:1893:25c8:1946]/cover.jpg'
      );
      expect(validPublicIpv6.isIpLiteral).toBe(true);

      expect(dnsSpy).not.toHaveBeenCalled();
    });

    it('caches positive DNS safety for 30s (bounded to 256 hosts), never caches negative/private results, and ALWAYS bypasses cache when custom dnsLookup is injected', async () => {
      let nowMs = 1_750_000_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

      const dnsSpy = vi.spyOn(dns.promises, 'lookup').mockImplementation((async (
        hostname: string
      ) => {
        if (hostname === 'rebind-private.example.com') {
          return [{ address: '127.0.0.1', family: 4 }];
        }
        return [{ address: '93.184.216.34', family: 4 }];
      }) as unknown as typeof dns.promises.lookup);

      // 1. Positive cache hit within 30s TTL -> 1 OS DNS lookup for 2 calls
      await securityUtils.assertSafePublicHttpsUrl('https://cdn-alpha.example.com/1.jpg');
      await securityUtils.assertSafePublicHttpsUrl('https://cdn-alpha.example.com/2.jpg');
      expect(dnsSpy).toHaveBeenCalledTimes(1);

      // 2. After 30s TTL expiry -> re-resolves via OS DNS
      nowMs += 30_001;
      await securityUtils.assertSafePublicHttpsUrl('https://cdn-alpha.example.com/3.jpg');
      expect(dnsSpy).toHaveBeenCalledTimes(2);

      // 3. Negative / private IP result is NEVER cached
      await expect(
        securityUtils.assertSafePublicHttpsUrl('https://rebind-private.example.com/1.jpg')
      ).rejects.toThrow(/private\/loopback/i);
      await expect(
        securityUtils.assertSafePublicHttpsUrl('https://rebind-private.example.com/2.jpg')
      ).rejects.toThrow(/private\/loopback/i);
      expect(dnsSpy).toHaveBeenCalledTimes(4);

      // 4. Bounded 256-host LRU eviction: fill 256 distinct hosts -> evicts `cdn-alpha.example.com`
      for (let i = 0; i < 256; i++) {
        await securityUtils.assertSafePublicHttpsUrl(`https://host-${i}.example.com/img.jpg`);
      }
      const callsAfterFill = dnsSpy.mock.calls.length;
      await securityUtils.assertSafePublicHttpsUrl('https://cdn-alpha.example.com/4.jpg');
      expect(dnsSpy.mock.calls.length).toBe(callsAfterFill + 1);

      // 5. Custom `options.dnsLookup` ALWAYS bypasses cache (DNS-rebinding determinism)
      let customCallCount = 0;
      const rebindingLookup = vi.fn(async () => {
        customCallCount++;
        return customCallCount === 1
          ? [{ address: '93.184.216.34' }]
          : [{ address: '127.0.0.1' }];
      });
      await securityUtils.assertSafePublicHttpsUrl('https://cdn-alpha.example.com/custom-1.jpg', {
        dnsLookup: rebindingLookup,
      });
      await expect(
        securityUtils.assertSafePublicHttpsUrl('https://cdn-alpha.example.com/custom-2.jpg', {
          dnsLookup: rebindingLookup,
        })
      ).rejects.toThrow(/private\/loopback/i);
      expect(rebindingLookup).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // 4. OfflineVaultService — Steam Alias Normalization, Non-Destructive Pinning & url_resolution_cache
  // =========================================================================
  describe('4. OfflineVaultService — Steam Alias Normalization, Non-Destructive Pinning & url_resolution_cache', () => {
    it('collapses /steam/apps/ and /store_item_assets/steam/apps/ across Steam CDN mirrors while preserving _2x distinction', () => {
      const fastly1x = offlineVaultMod.normalizeAssetIdentityUrl(
        'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/990001/library_600x900.jpg'
      );
      const akamaiLegacy1x = offlineVaultMod.normalizeAssetIdentityUrl(
        'https://cdn.akamai.steamstatic.com/steam/apps/990001/library_600x900.jpg'
      );
      const akamaiShared1x = offlineVaultMod.normalizeAssetIdentityUrl(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/990001/library_600x900.jpg?t=1700000123'
      );
      const cloudflareLegacy1x = offlineVaultMod.normalizeAssetIdentityUrl(
        'https://cdn.cloudflare.steamstatic.com/steam/apps/990001/library_600x900.jpg'
      );
      const akamaihdLegacy1x = offlineVaultMod.normalizeAssetIdentityUrl(
        'https://steamcdn-a.akamaihd.net/steam/apps/990001/library_600x900.jpg'
      );
      const akamai2x = offlineVaultMod.normalizeAssetIdentityUrl(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/990001/library_600x900_2x.jpg'
      );

      expect(fastly1x).toBe(
        'https://steamstatic.canonical/store_item_assets/steam/apps/990001/library_600x900.jpg'
      );
      expect(akamaiLegacy1x).toBe(fastly1x);
      expect(akamaiShared1x).toBe(fastly1x);
      expect(cloudflareLegacy1x).toBe(fastly1x);
      expect(akamaihdLegacy1x).toBe(fastly1x);
      expect(akamai2x).not.toBe(fastly1x);
    });

    it('never unpins a healthy fallback cover blob when dead Steam candidates return 404, shares mirror 404 backoff, and serves secondary cached covers in <1ms', async () => {
      const sandbox = makeTempSandbox('ol-nondestructive-');
      let fakeNow = 1_750_000_000_000;
      const fallbackBytes = makeValidImageBuffer('jpeg', 0x41, 320);
      const upgradedBytes = makeValidImageBuffer('jpeg', 0x5a, 384);

      const fallbackUrl = 'https://images.example.test/covers/synth_fallback_cover.jpg';
      const deadSteamFastly =
        'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/990001/library_600x900.jpg';
      const deadSteamLegacy =
        'https://cdn.akamai.steamstatic.com/steam/apps/990001/library_600x900.jpg';
      const upgradedUrl = 'https://images.example.test/covers/synth_upgraded_cover.jpg';

      const fetchedUrls: string[] = [];
      const fetchSpy = vi.fn(async (url: string) => {
        fetchedUrls.push(url);
        if (url.includes('library_600x900')) {
          return makeMockHttpResponse({ status: 404, body: 'Not Found' });
        }
        if (url === upgradedUrl) {
          return makeMockHttpResponse({
            status: 200,
            body: upgradedBytes,
            contentType: 'image/jpeg',
          });
        }
        return makeMockHttpResponse({
          status: 200,
          body: fallbackBytes,
          contentType: 'image/jpeg',
        });
      });

      const vault = offlineVaultMod.createOfflineVaultService({
        userDataDir: sandbox,
        federator: makeHermeticFederator(),
        disableJitter: true,
        nowFn: () => fakeNow,
        fetchImpl: fetchSpy,
        dnsLookup: async () => [{ address: '93.184.216.34' }],
      });

      try {
        // 1. Hydrate healthy fallback cover blob
        const initialRes = await vault.resolveMediaRequest({
          gameId: 'steam-990001',
          role: 'cover',
          ordinal: 0,
          url: fallbackUrl,
        });
        expect(initialRes.source).toBe('upstream_persisted');
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const db = vault.ensureOpen();
        const pinnedBefore = db
          .prepare('SELECT source_url, storage_kind, blob_sha256 FROM game_media_assets WHERE url_key = ?')
          .get('steam-990001::cover::0');
        expect(pinnedBefore?.storage_kind).toBe('blob');
        expect(pinnedBefore?.source_url).toBe(fallbackUrl);
        expect(typeof pinnedBefore?.blob_sha256).toBe('string');

        // 2. Request dead Steam Fastly URL -> 404, MUST NOT wipe healthy pinned fallback blob!
        const dead1 = await vault.resolveMediaRequest({
          gameId: 'steam-990001',
          role: 'cover',
          ordinal: 0,
          url: deadSteamFastly,
        });
        expect(dead1.kind).toBe('error');
        expect(dead1.status).toBe(404);
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        const pinnedAfterDead = db
          .prepare(
            'SELECT source_url, storage_kind, blob_sha256, failure_count, next_retry_at FROM game_media_assets WHERE url_key = ?'
          )
          .get('steam-990001::cover::0');
        expect(pinnedAfterDead?.storage_kind).toBe('blob');
        expect(pinnedAfterDead?.blob_sha256).toBe(pinnedBefore?.blob_sha256);
        expect(pinnedAfterDead?.source_url).toBe(fallbackUrl);
        expect(Number(pinnedAfterDead?.failure_count)).toBe(0);

        // 3. Request legacy `/steam/apps/` mirror alias -> fast-fails 404 from `url_resolution_cache` with ZERO network!
        const deadMirror = await vault.resolveMediaRequest({
          gameId: 'steam-990001',
          role: 'cover',
          ordinal: 0,
          url: deadSteamLegacy,
        });
        expect(deadMirror.kind).toBe('error');
        expect(deadMirror.status).toBe(404);
        expect(deadMirror.reason).toBe('adaptive_404_cooldown');
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        // 4. Immediately request healthy fallback URL -> instant Tier 1A vault_blob hit, ZERO network!
        const instantFallback = await vault.resolveMediaRequest({
          gameId: 'steam-990001',
          role: 'cover',
          ordinal: 0,
          url: fallbackUrl,
        });
        expect(instantFallback.kind).toBe('file');
        expect(instantFallback.source).toBe('vault_blob');
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        // 5. Advance 7h past 6h cooldown -> dead Steam 404 escalates failure_count to 2 (24h) while keeping blob pinned
        fakeNow += 7 * 60 * 60 * 1000;
        const dead2 = await vault.resolveMediaRequest({
          gameId: 'steam-990001',
          role: 'cover',
          ordinal: 0,
          url: deadSteamFastly,
        });
        expect(dead2.status).toBe(404);
        expect(fetchSpy).toHaveBeenCalledTimes(3);
        const deadCacheRow = db
          .prepare('SELECT failure_count, last_status_code FROM url_resolution_cache WHERE norm_url = ?')
          .get(offlineVaultMod.normalizeAssetIdentityUrl(deadSteamFastly));
        expect(Number(deadCacheRow?.failure_count)).toBe(2);
        expect(Number(deadCacheRow?.last_status_code)).toBe(404);
        const stillPinned = db
          .prepare('SELECT storage_kind, blob_sha256 FROM game_media_assets WHERE url_key = ?')
          .get('steam-990001::cover::0');
        expect(stillPinned?.storage_kind).toBe('blob');
        expect(stillPinned?.blob_sha256).toBe(pinnedBefore?.blob_sha256);

        // 6. Online upgrade with HTTP 200 swaps `game_media_assets` AFTER 200 OK; switching back hits `url_resolution_cache` with 0 network!
        const upgradedRes = await vault.resolveMediaRequest({
          gameId: 'steam-990001',
          role: 'cover',
          ordinal: 0,
          url: upgradedUrl,
        });
        expect(upgradedRes.source).toBe('upstream_persisted');
        expect(fetchSpy).toHaveBeenCalledTimes(4);

        const switchedBack = await vault.resolveMediaRequest({
          gameId: 'steam-990001',
          role: 'cover',
          ordinal: 0,
          url: fallbackUrl,
        });
        expect(switchedBack.kind).toBe('file');
        expect(switchedBack.source).toBe('vault_blob');
        expect(fetchSpy).toHaveBeenCalledTimes(4);
        const reboundRow = db
          .prepare('SELECT source_url, blob_sha256 FROM game_media_assets WHERE url_key = ?')
          .get('steam-990001::cover::0');
        expect(reboundRow?.source_url).toBe(fallbackUrl);
        expect(reboundRow?.blob_sha256).toBe(pinnedBefore?.blob_sha256);

        // 7. Helper parity: isAssetAlreadyHydratedOrBackedOff & isAssetBackedOffFailure consult url_resolution_cache
        expect(
          vault.isAssetAlreadyHydratedOrBackedOff({
            gameId: 'steam-990001',
            role: 'cover',
            ordinal: 0,
            url: upgradedUrl,
          })
        ).toBe(true);
        expect(
          vault.isAssetBackedOffFailure({
            gameId: 'steam-990001',
            role: 'cover',
            ordinal: 0,
            url: deadSteamFastly,
          })
        ).toBe(true);

        // 8. Pending-row instant 0s reset when source_url changes (non-blob pending slot)
        const pendingDeadUrl = 'https://images.example.test/covers/pending_dead.jpg';
        const pendingLiveUrl = 'https://images.example.test/covers/pending_live.jpg';
        fetchSpy.mockImplementationOnce(async () =>
          makeMockHttpResponse({ status: 404, body: '404' })
        );
        const pendingDeadRes = await vault.resolveMediaRequest({
          gameId: 'steam-990002',
          role: 'cover',
          ordinal: 0,
          url: pendingDeadUrl,
        });
        expect(pendingDeadRes.status).toBe(404);
        const pendingLiveRes = await vault.resolveMediaRequest({
          gameId: 'steam-990002',
          role: 'cover',
          ordinal: 0,
          url: pendingLiveUrl,
        });
        expect(pendingLiveRes.source).toBe('upstream_persisted');
      } finally {
        vault.shutdown();
      }
    });
  });

  // =========================================================================
  // 5. Non-Destructive upsertGames(), deleteGames(), & Bounded sweepOrphanBlobs()
  // =========================================================================
  describe('5. OfflineVaultService — Non-Destructive upsertGames(), deleteGames(), & Bounded sweepOrphanBlobs()', () => {
    it('does not wipe healthy on-disk cover blobs during upsertGames() URL mismatch, yet self-heals missing disk blobs and honors explicit user overrides', async () => {
      const sandbox = makeTempSandbox('ol-upsert-nondestructive-');
      const fakeNow = 1_750_000_000_000;
      const resizedEpicUrl = 'https://cdn.example.test/epic/cover.jpg?h=480&resize=1';
      const rawEpicUrl = 'https://cdn.example.test/epic/cover.jpg';
      const coverBytes = makeValidImageBuffer('jpeg', 0x33, 256);

      const vault = offlineVaultMod.createOfflineVaultService({
        userDataDir: sandbox,
        federator: makeHermeticFederator(),
        disableJitter: true,
        nowFn: () => fakeNow,
        fetchImpl: async () =>
          makeMockHttpResponse({ status: 200, body: coverBytes, contentType: 'image/jpeg' }),
        dnsLookup: async () => [{ address: '93.184.216.34' }],
      });

      try {
        vault.upsertGames([
          {
            id: 'epic-synth-1',
            title: 'Synthetic Epic Title',
            capsuleImage: rawEpicUrl,
            platforms: [{ platformId: 'epic', platformGameId: 'SynthEpic1', installed: false }],
          },
        ]);

        // Hydrate cover using resized query param (how GameCardCover renders Epic covers)
        const resolved = await vault.resolveMediaRequest({
          gameId: 'epic-synth-1',
          role: 'cover',
          ordinal: 0,
          url: resizedEpicUrl,
        });
        expect(resolved.source).toBe('upstream_persisted');

        const db = vault.ensureOpen();
        const beforeUpsert = db
          .prepare('SELECT source_url, storage_kind, blob_sha256 FROM game_media_assets WHERE url_key = ?')
          .get('epic-synth-1::cover::0');
        expect(beforeUpsert?.storage_kind).toBe('blob');

        // Re-run routine upsertGames() with raw Epic URL (no `?h=480`) -> MUST NOT wipe blob!
        vault.upsertGames([
          {
            id: 'epic-synth-1',
            title: 'Synthetic Epic Title',
            capsuleImage: rawEpicUrl,
            platforms: [{ platformId: 'epic', platformGameId: 'SynthEpic1', installed: false }],
          },
        ]);

        const afterUpsert = db
          .prepare('SELECT source_url, storage_kind, blob_sha256 FROM game_media_assets WHERE url_key = ?')
          .get('epic-synth-1::cover::0');
        expect(afterUpsert?.storage_kind).toBe('blob');
        expect(afterUpsert?.blob_sha256).toBe(beforeUpsert?.blob_sha256);
        expect(afterUpsert?.source_url).toBe(resizedEpicUrl);

        // Explicit user override MUST invalidate the cover row
        const overrideRes = vault.saveUserOverride('epic-synth-1', {
          capsuleImage: 'https://cdn.example.test/custom/override.jpg',
        });
        expect(overrideRes.success).toBe(true);
        expect(overrideRes.invalidated).toBeGreaterThanOrEqual(1);
        const afterOverride = db
          .prepare('SELECT storage_kind, blob_sha256 FROM game_media_assets WHERE url_key = ?')
          .get('epic-synth-1::cover::0');
        expect(afterOverride?.storage_kind).toBe('pending');
        expect(afterOverride?.blob_sha256).toBeNull();

        // Re-bind cover, then manually unlink disk blob -> upsertGames() MUST self-heal missing disk file!
        await vault.resolveMediaRequest({
          gameId: 'epic-synth-1',
          role: 'cover',
          ordinal: 0,
          url: resizedEpicUrl,
        });
        const boundRow = db
          .prepare(
            'SELECT gma.blob_sha256 AS sha, mb.ext AS ext FROM game_media_assets gma JOIN media_blobs mb ON mb.sha256 = gma.blob_sha256 WHERE gma.url_key = ?'
          )
          .get('epic-synth-1::cover::0');
        const blobPath = vault.getBlobFilePath(String(boundRow?.sha), String(boundRow?.ext));
        fs.unlinkSync(blobPath);

        vault.upsertGames([
          {
            id: 'epic-synth-1',
            title: 'Synthetic Epic Title',
            capsuleImage: rawEpicUrl,
            platforms: [{ platformId: 'epic', platformGameId: 'SynthEpic1', installed: false }],
          },
        ]);
        const healedRow = db
          .prepare('SELECT storage_kind, source_url, blob_sha256 FROM game_media_assets WHERE url_key = ?')
          .get('epic-synth-1::cover::0');
        expect(healedRow?.storage_kind).toBe('pending');
        expect(healedRow?.source_url).toBe(rawEpicUrl);
        expect(healedRow?.blob_sha256).toBeNull();
      } finally {
        vault.shutdown();
      }
    });

    it('skips rewriting byte-identical vault_games rows in upsertGames() without bumping updated_at, while updating mutated rows', () => {
      const sandbox = makeTempSandbox('ol-upsert-idempotent-');
      let fakeNow = 1_750_000_000_000;

      const vault = offlineVaultMod.createOfflineVaultService({
        userDataDir: sandbox,
        federator: makeHermeticFederator(),
        disableJitter: true,
        nowFn: () => fakeNow,
      });

      try {
        const gameA = {
          id: 'epic-idemp-1',
          title: 'Synthetic Idempotent Alpha',
          capsuleImage: 'https://cdn.example.test/idemp/a.jpg',
          platforms: [{ platformId: 'epic', platformGameId: 'idemp-1', installed: false }],
        };
        const gameB = {
          id: 'epic-idemp-2',
          title: 'Synthetic Idempotent Beta',
          capsuleImage: 'https://cdn.example.test/idemp/b.jpg',
          platforms: [{ platformId: 'epic', platformGameId: 'idemp-2', installed: false }],
        };

        const first = vault.upsertGames([gameA, gameB]) as {
          success: boolean;
          upserted?: number;
          skipped?: number;
        };
        expect(first.success).toBe(true);
        expect(first.upserted).toBe(2);
        expect(first.skipped).toBe(0);

        const db = vault.ensureOpen();
        const ts1A = db
          .prepare('SELECT updated_at FROM vault_games WHERE game_id = ?')
          .get('epic-idemp-1')?.updated_at;
        const ts1B = db
          .prepare('SELECT updated_at FROM vault_games WHERE game_id = ?')
          .get('epic-idemp-2')?.updated_at;
        expect(ts1A).toBe(1_750_000_000_000);
        expect(ts1B).toBe(1_750_000_000_000);

        // Advance clock by 65 seconds and re-upsert identical payloads -> 0 rows rewritten, updated_at unchanged!
        fakeNow += 65_000;
        const second = vault.upsertGames([
          structuredClone(gameA),
          structuredClone(gameB),
        ]) as { success: boolean; upserted?: number; skipped?: number };
        expect(second.success).toBe(true);
        expect(second.upserted).toBe(0);
        expect(second.skipped).toBe(2);

        expect(
          db.prepare('SELECT updated_at FROM vault_games WHERE game_id = ?').get('epic-idemp-1')
            ?.updated_at
        ).toBe(1_750_000_000_000);
        expect(
          db.prepare('SELECT updated_at FROM vault_games WHERE game_id = ?').get('epic-idemp-2')
            ?.updated_at
        ).toBe(1_750_000_000_000);

        // Mutate ONLY gameB -> exactly 1 row updated (gameB bumped), gameA untouched!
        fakeNow += 10_000;
        const third = vault.upsertGames([
          structuredClone(gameA),
          { ...structuredClone(gameB), title: 'Synthetic Idempotent Beta Remastered' },
        ]) as { success: boolean; upserted?: number; skipped?: number };
        expect(third.success).toBe(true);
        expect(third.upserted).toBe(1);
        expect(third.skipped).toBe(1);

        expect(
          db.prepare('SELECT updated_at FROM vault_games WHERE game_id = ?').get('epic-idemp-1')
            ?.updated_at
        ).toBe(1_750_000_000_000);
        expect(
          db.prepare('SELECT updated_at FROM vault_games WHERE game_id = ?').get('epic-idemp-2')
            ?.updated_at
        ).toBe(1_750_000_075_000);
      } finally {
        vault.shutdown();
      }
    });

    it('cleans url_resolution_cache on deleteGames() and bounds secondary blobs (max 1 newest <= 14d), stale 404s (> 30d), and nonexistent games in sweepOrphanBlobs()', async () => {
      const sandbox = makeTempSandbox('ol-sweep-bounded-');
      const DAY_MS = 24 * 60 * 60 * 1000;
      let fakeNow = 1_750_000_000_000;

      const bytesA = makeValidImageBuffer('jpeg', 0x11, 220);
      const bytesB = makeValidImageBuffer('jpeg', 0x22, 240);
      const bytesC = makeValidImageBuffer('jpeg', 0x33, 260);
      const bytesDeleteGame = makeValidImageBuffer('jpeg', 0x44, 280);

      const urlA = 'https://cdn.example.test/g1/cover_a.jpg';
      const urlB = 'https://cdn.example.test/g1/cover_b.jpg';
      const urlC = 'https://cdn.example.test/g1/cover_c.jpg';
      const urlDeadOld = 'https://cdn.example.test/g1/dead_old.jpg';
      const urlDeadRecent = 'https://cdn.example.test/g1/dead_recent.jpg';
      const urlDelGame = 'https://cdn.example.test/g2/cover.jpg';

      const vault = offlineVaultMod.createOfflineVaultService({
        userDataDir: sandbox,
        federator: makeHermeticFederator(),
        disableJitter: true,
        nowFn: () => fakeNow,
        fetchImpl: async (url: string) => {
          if (url === urlA) return makeMockHttpResponse({ status: 200, body: bytesA });
          if (url === urlB) return makeMockHttpResponse({ status: 200, body: bytesB });
          if (url === urlC) return makeMockHttpResponse({ status: 200, body: bytesC });
          if (url === urlDelGame) return makeMockHttpResponse({ status: 200, body: bytesDeleteGame });
          return makeMockHttpResponse({ status: 404, body: '404' });
        },
        dnsLookup: async () => [{ address: '93.184.216.34' }],
      });

      try {
        vault.upsertGames([
          {
            id: 'synth-g1',
            title: 'Synthetic Game One',
            capsuleImage: urlA,
            platforms: [{ platformId: 'gog', platformGameId: '1001', installed: false }],
          },
          {
            id: 'synth-g2',
            title: 'Synthetic Game Two',
            capsuleImage: urlDelGame,
            platforms: [{ platformId: 'gog', platformGameId: '1002', installed: false }],
          },
        ]);

        // Populate g2 cover, then delete g2 -> url_resolution_cache for g2 must be cleaned immediately
        await vault.resolveMediaRequest({ gameId: 'synth-g2', role: 'cover', ordinal: 0, url: urlDelGame });
        const db = vault.ensureOpen();
        expect(
          db.prepare('SELECT COUNT(*) AS cnt FROM url_resolution_cache WHERE game_id = ?').get('synth-g2')?.cnt
        ).toBe(1);
        vault.deleteGames(['synth-g2']);
        expect(
          db.prepare('SELECT COUNT(*) AS cnt FROM url_resolution_cache WHERE game_id = ?').get('synth-g2')?.cnt
        ).toBe(0);

        // Populate 3 sequential covers for g1 (A @ T0, B @ T0+1d, C @ T0+2d) + old 404 + recent 404
        await vault.resolveMediaRequest({ gameId: 'synth-g1', role: 'cover', ordinal: 0, url: urlA });
        await vault.resolveMediaRequest({ gameId: 'synth-g1', role: 'cover', ordinal: 0, url: urlDeadOld });

        fakeNow += 1 * DAY_MS;
        await vault.resolveMediaRequest({ gameId: 'synth-g1', role: 'cover', ordinal: 0, url: urlB });

        fakeNow += 1 * DAY_MS;
        await vault.resolveMediaRequest({ gameId: 'synth-g1', role: 'cover', ordinal: 0, url: urlC });

        // Insert a ghost game entry directly into url_resolution_cache to verify nonexistent game pruning
        db.prepare(
          `INSERT INTO url_resolution_cache (norm_url, game_id, blob_sha256, failure_count, next_retry_at, last_status_code, updated_at)
           VALUES (?, ?, NULL, 1, ?, 404, ?)`
        ).run('https://cdn.example.test/ghost/dead.jpg', 'nonexistent-game-id', fakeNow + DAY_MS, fakeNow);

        // Make urlDeadOld 35 days old, record urlDeadRecent now
        db.prepare('UPDATE url_resolution_cache SET updated_at = ? WHERE norm_url = ?').run(
          fakeNow - 35 * DAY_MS,
          offlineVaultMod.normalizeAssetIdentityUrl(urlDeadOld)
        );
        await vault.resolveMediaRequest({ gameId: 'synth-g1', role: 'cover', ordinal: 0, url: urlDeadRecent });

        const shaRowA = db
          .prepare('SELECT blob_sha256 FROM url_resolution_cache WHERE norm_url = ?')
          .get(offlineVaultMod.normalizeAssetIdentityUrl(urlA));
        const shaRowB = db
          .prepare('SELECT blob_sha256 FROM url_resolution_cache WHERE norm_url = ?')
          .get(offlineVaultMod.normalizeAssetIdentityUrl(urlB));
        const shaRowC = db
          .prepare('SELECT blob_sha256 FROM url_resolution_cache WHERE norm_url = ?')
          .get(offlineVaultMod.normalizeAssetIdentityUrl(urlC));

        // Sweep: C is primary, B is newest secondary (<= 14d -> KEPT!), A is 2nd older secondary (-> PRUNED!),
        // urlDeadOld (> 30d -> PRUNED!), urlDeadRecent (< 30d -> KEPT!), ghost game (-> PRUNED!)
        const sweep1 = vault.sweepOrphanBlobs({ reclaimLegacyP2NonCover: false });
        expect(sweep1.success).toBe(true);

        expect(
          db.prepare('SELECT 1 FROM url_resolution_cache WHERE norm_url = ?').get(
            offlineVaultMod.normalizeAssetIdentityUrl(urlC)
          )
        ).toBeTruthy();
        expect(
          db.prepare('SELECT 1 FROM url_resolution_cache WHERE norm_url = ?').get(
            offlineVaultMod.normalizeAssetIdentityUrl(urlB)
          )
        ).toBeTruthy();
        expect(
          db.prepare('SELECT 1 FROM url_resolution_cache WHERE norm_url = ?').get(
            offlineVaultMod.normalizeAssetIdentityUrl(urlA)
          )
        ).toBeUndefined();
        expect(
          db.prepare('SELECT 1 FROM url_resolution_cache WHERE norm_url = ?').get(
            offlineVaultMod.normalizeAssetIdentityUrl(urlDeadOld)
          )
        ).toBeUndefined();
        expect(
          db.prepare('SELECT 1 FROM url_resolution_cache WHERE norm_url = ?').get(
            offlineVaultMod.normalizeAssetIdentityUrl(urlDeadRecent)
          )
        ).toBeTruthy();
        expect(
          db.prepare('SELECT 1 FROM url_resolution_cache WHERE game_id = ?').get('nonexistent-game-id')
        ).toBeUndefined();

        // Underlying media_blobs: B and C MUST survive; A MUST be deleted!
        expect(db.prepare('SELECT 1 FROM media_blobs WHERE sha256 = ?').get(shaRowC?.blob_sha256)).toBeTruthy();
        expect(db.prepare('SELECT 1 FROM media_blobs WHERE sha256 = ?').get(shaRowB?.blob_sha256)).toBeTruthy();
        expect(db.prepare('SELECT 1 FROM media_blobs WHERE sha256 = ?').get(shaRowA?.blob_sha256)).toBeUndefined();

        // Advance 15 days -> secondary B is now > 14d old -> pruned by next sweep while primary C survives!
        fakeNow += 15 * DAY_MS;
        vault.sweepOrphanBlobs({ reclaimLegacyP2NonCover: false });
        expect(
          db.prepare('SELECT 1 FROM url_resolution_cache WHERE norm_url = ?').get(
            offlineVaultMod.normalizeAssetIdentityUrl(urlB)
          )
        ).toBeUndefined();
        expect(db.prepare('SELECT 1 FROM media_blobs WHERE sha256 = ?').get(shaRowB?.blob_sha256)).toBeUndefined();
        expect(db.prepare('SELECT 1 FROM media_blobs WHERE sha256 = ?').get(shaRowC?.blob_sha256)).toBeTruthy();
      } finally {
        vault.shutdown();
      }
    });
  });

  // =========================================================================
  // 6. Zero-DNS Fast Path in offlineVaultIpcHandlers.cjs & resolveLocalCachedMedia()
  // =========================================================================
  describe('6. offlineVaultIpcHandlers — Zero-DNS Fast Path & Strict SSRF / Upgrade Preservation', () => {
    it('serves exact cached hits and url_resolution_cache secondary hits with ZERO dns.promises.lookup calls while enforcing full DNS checks on online URL upgrades and blocking SSRF', async () => {
      const sandbox = makeTempSandbox('ol-zerodns-');
      let onlineNow = true;
      const bytesV1 = makeValidImageBuffer('jpeg', 0x61, 256);
      const bytesV2 = makeValidImageBuffer('jpeg', 0x72, 300);

      const urlV1 = 'https://cdn-primary.example.com/covers/v1.jpg';
      const urlV2 = 'https://cdn-upgrade.example.com/covers/v2.jpg';
      const urlRebind = 'https://evil-rebind.example.com/covers/poison.jpg';

      const fetchSpy = vi.fn(async (url: string) => {
        if (url === urlV2) return makeMockHttpResponse({ status: 200, body: bytesV2 });
        return makeMockHttpResponse({ status: 200, body: bytesV1 });
      });

      const dnsSpy = vi.spyOn(dns.promises, 'lookup').mockImplementation((async (
        hostname: string
      ) => {
        if (hostname === 'evil-rebind.example.com') {
          return [{ address: '127.0.0.1', family: 4 }];
        }
        return [{ address: '93.184.216.34', family: 4 }];
      }) as unknown as typeof dns.promises.lookup);

      const vault = offlineVaultMod.createOfflineVaultService({
        userDataDir: sandbox,
        federator: makeHermeticFederator(),
        disableJitter: true,
        isOnlineFn: () => onlineNow,
        fetchImpl: fetchSpy,
      });

      const handler = offlineVaultIpc.createOlMediaProtocolHandler({
        getOfflineVault: () => vault,
      });

      try {
        // 1. Cold miss for urlV1 -> runs DNS + fetches upstream
        const coldRes = await handler(
          new Request(
            `ol-media://asset?gameId=synth-zd-1&role=cover&ord=0&url=${encodeURIComponent(urlV1)}`,
            { headers: { 'sec-fetch-site': 'same-origin' } }
          )
        );
        expect(coldRes.status).toBe(200);
        expect(coldRes.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
        expect(dnsSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Reset spy & clear DNS cache to prove subsequent cached hits perform ZERO DNS lookups!
        dnsSpy.mockClear();
        fetchSpy.mockClear();
        securityUtils.clearPublicDnsSafetyCache();

        // 2. Warm cached hit for exact urlV1 -> ZERO dns.promises.lookup calls, ZERO fetch!
        const warmRes = await handler(
          new Request(
            `ol-media://asset?gameId=synth-zd-1&role=cover&ord=0&url=${encodeURIComponent(urlV1)}`,
            { headers: { 'sec-fetch-site': 'same-origin' } }
          )
        );
        expect(warmRes.status).toBe(200);
        expect(warmRes.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
        expect(warmRes.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
        expect(dnsSpy).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();

        // 3. SSRF literal IP / localhost -> blocked synchronously with 403 and ZERO DNS calls!
        const ssrfLiteralRes = await handler(
          new Request(
            `ol-media://asset?gameId=synth-zd-1&role=cover&ord=0&url=${encodeURIComponent('https://169.254.169.254/latest/meta-data')}`,
            { headers: { 'sec-fetch-site': 'same-origin' } }
          )
        );
        expect(ssrfLiteralRes.status).toBe(403);
        expect(dnsSpy).not.toHaveBeenCalled();

        // 4. New/different URL pointing to DNS-rebinding host while online -> resolveLocalCachedMedia returns null -> FULL DNS check catches 127.0.0.1 and returns 403!
        expect(
          await vault.resolveLocalCachedMedia({
            gameId: 'synth-zd-1',
            role: 'cover',
            ordinal: 0,
            url: urlRebind,
          })
        ).toBeNull();

        const rebindRes = await handler(
          new Request(
            `ol-media://asset?gameId=synth-zd-1&role=cover&ord=0&url=${encodeURIComponent(urlRebind)}`,
            { headers: { 'sec-fetch-site': 'same-origin' } }
          )
        );
        expect(rebindRes.status).toBe(403);
        expect(dnsSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).not.toHaveBeenCalled();

        // 5. New/different valid URL while online -> resolveLocalCachedMedia returns null -> runs DNS + Tier 3 upgrade!
        dnsSpy.mockClear();
        const upgradeRes = await handler(
          new Request(
            `ol-media://asset?gameId=synth-zd-1&role=cover&ord=0&url=${encodeURIComponent(urlV2)}`,
            { headers: { 'sec-fetch-site': 'same-origin' } }
          )
        );
        expect(upgradeRes.status).toBe(200);
        expect(dnsSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const upgradeBody = Buffer.from(await upgradeRes.arrayBuffer());
        expect(upgradeBody.length).toBeGreaterThan(0);

        // 6. Switching back to urlV1 (now in url_resolution_cache!) -> ZERO DNS calls, ZERO fetch!
        dnsSpy.mockClear();
        fetchSpy.mockClear();
        securityUtils.clearPublicDnsSafetyCache();
        const secondaryFastHit = await handler(
          new Request(
            `ol-media://asset?gameId=synth-zd-1&role=cover&ord=0&url=${encodeURIComponent(urlV1)}`,
            { headers: { 'sec-fetch-site': 'same-origin' } }
          )
        );
        expect(secondaryFastHit.status).toBe(200);
        expect(secondaryFastHit.headers.get('Cache-Control')).toBe(
          'public, max-age=31536000, immutable'
        );
        expect(dnsSpy).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();

        // 7. Offline fallback for an uncached new URL -> serves existing pinned blob with ZERO DNS calls!
        onlineNow = false;
        const offlineFallbackRes = await handler(
          new Request(
            `ol-media://asset?gameId=synth-zd-1&role=cover&ord=0&url=${encodeURIComponent('https://cdn-never-seen.example.com/new.jpg')}`,
            { headers: { 'sec-fetch-site': 'same-origin' } }
          )
        );
        expect(offlineFallbackRes.status).toBe(200);
        expect(offlineFallbackRes.headers.get('Cache-Control')).toBe('public, max-age=3600');
        expect(dnsSpy).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();

        // 8. Injected custom dnsLookup ALWAYS runs (bypassing fast path)
        onlineNow = true;
        const customDnsSpy = vi.fn(async () => [{ address: '93.184.216.34' }]);
        const customHandler = offlineVaultIpc.createOlMediaProtocolHandler({
          getOfflineVault: () => vault,
          dnsLookup: customDnsSpy,
        });
        const customRes = await customHandler(
          new Request(
            `ol-media://asset?gameId=synth-zd-1&role=cover&ord=0&url=${encodeURIComponent(urlV1)}`,
            { headers: { 'sec-fetch-site': 'same-origin' } }
          )
        );
        expect(customRes.status).toBe(200);
        expect(customDnsSpy).toHaveBeenCalledTimes(1);
      } finally {
        vault.shutdown();
      }
    });
  });
});
