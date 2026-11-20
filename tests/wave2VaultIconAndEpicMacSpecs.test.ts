import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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
}

interface NormalizeResult {
  valid: boolean;
  buffer?: Buffer;
  ext?: string;
  mimeType?: string;
  normalized?: boolean;
  animated?: boolean;
}

interface EvictResult {
  evictedCount: number;
  freedBytes: number;
}

interface OfflineVaultInstance {
  ensureOpen: () => SqliteDbHandle;
  shutdown: () => void;
  upsertGames: (games: Array<Record<string, unknown>>) => { success: boolean; upserted?: number };
  resolveMediaRequest: (
    params: Record<string, unknown>,
    reqOpts?: { localCacheOnly?: boolean; signal?: AbortSignal }
  ) => Promise<VaultMediaResult>;
  normalizeImageBuffer: (
    rawBuffer: Buffer,
    roleOrContentType?: string,
    maybeRole?: string
  ) => NormalizeResult;
  maybeEvictBlobs: (opts?: { maxBytes?: number; forceIfOverMax?: boolean }) => EvictResult;
  getSqliteDiskBytes: () => number;
  getBlobFilePath: (sha256: string, ext: string) => string;
}

interface OfflineVaultModule {
  ROLE_MAX_WIDTHS: Record<string, number>;
  normalizeAssetIdentityUrl: (url: string) => string;
  buildAssetUrlKey: (gameId: string, role: string, ordinal: number, sourceUrl: string) => string;
  isFederatedAssetRowCompatible: (
    sourceUrl: unknown,
    federatedPath: unknown,
    params?: Record<string, unknown> | null
  ) => boolean;
  createOfflineVaultService: (options: Record<string, unknown>) => OfflineVaultInstance;
}

interface FederatorModule {
  resolveFederatedAsset: (
    params: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => {
    path: string;
    mimeType: string;
    sizeBytes: number;
    source?: string;
  } | null;
}

interface EpicRequirementBlock {
  minimum?: string;
  recommended?: string;
}

interface EpicRequirementsByOsResult {
  systemRequirements?: EpicRequirementBlock;
  macRequirements?: EpicRequirementBlock;
  linuxRequirements?: EpicRequirementBlock;
}

interface EpicProductOfferMetadata {
  title?: string;
  shortDescription?: string;
  detailedDescription?: string;
  aboutTheGame?: string;
  screenshots?: string[];
  systemRequirements?: EpicRequirementBlock;
  macRequirements?: EpicRequirementBlock;
  linuxRequirements?: EpicRequirementBlock;
  supportedLanguages?: string;
  languages?: string[];
  namespace?: string;
}

interface StoreSyncModule {
  epicOfferMetadataCache: Map<string, unknown>;
  extractEpicRequirementsByOs: (
    systems?: Array<{
      systemType?: string;
      details?: Array<{ title?: string; minimum?: string; recommended?: string }>;
    }> | null
  ) => EpicRequirementsByOsResult;
  fetchEpicProductOfferMetadata: (
    payload?: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<EpicProductOfferMetadata | null>;
}

const offlineVaultMod = require('../electron/launcher/offlineVaultService.cjs') as OfflineVaultModule;
const federatorMod = require('../electron/launcher/storefrontLocalCacheFederator.cjs') as FederatorModule;
const storeSync = require('../electron/storeSync.cjs') as StoreSyncModule;

function makePngBuffer(size: number, seedByte: number): Buffer {
  const buf = Buffer.alloc(Math.max(size, 64), seedByte & 0xff);
  // Valid 8-byte PNG signature + IHDR marker
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  Buffer.from('IHDR', 'ascii').copy(buf, 12);
  buf.writeUInt32BE(seedByte & 0xffff, 16);
  return buf;
}

function makeWebpBuffer(size: number, seedInt: number): Buffer {
  const buf = Buffer.alloc(Math.max(size, 64), (seedInt * 17 + 3) & 0xff);
  Buffer.from('RIFF', 'ascii').copy(buf, 0);
  buf.writeUInt32LE(buf.length - 8, 4);
  Buffer.from('WEBP', 'ascii').copy(buf, 8);
  buf.writeUInt32LE(seedInt >>> 0, 16);
  return buf;
}

function makeJpegBuffer(size: number, seedByte: number): Buffer {
  const buf = Buffer.alloc(Math.max(size, 64), seedByte & 0xff);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xe0;
  buf[buf.length - 2] = 0xff;
  buf[buf.length - 1] = 0xd9;
  return buf;
}

function makeMockHttpResponse(opts: {
  status: number;
  body: Buffer | string;
  contentType?: string;
}): Response {
  const payload = typeof opts.body === 'string' ? Buffer.from(opts.body, 'utf8') : opts.body;
  const headers = new Headers();
  if (opts.contentType) {
    headers.set('content-type', opts.contentType);
  }
  headers.set('content-length', String(payload.length));
  return new Response(new Uint8Array(payload), {
    status: opts.status,
    headers,
  });
}

describe('Wave 2 — OfflineVault achievement_icon Role & Epic Multi-OS System Requirements', () => {
  const tempDirs: string[] = [];
  const activeVaults: OfflineVaultInstance[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function createTrackedVault(options: Record<string, unknown>): OfflineVaultInstance {
    const vault = offlineVaultMod.createOfflineVaultService({
      disableJitter: true,
      dnsLookup: async () => [{ address: '93.184.216.34' }],
      freeDiskBytesFn: () => 50 * 1024 * 1024 * 1024,
      ...options,
    });
    activeVaults.push(vault);
    return vault;
  }

  beforeEach(() => {
    storeSync.epicOfferMetadataCache.clear();
  });

  afterEach(() => {
    while (activeVaults.length > 0) {
      const v = activeVaults.pop();
      try {
        v?.shutdown();
      } catch {}
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir && fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
    storeSync.epicOfferMetadataCache.clear();
    vi.restoreAllMocks();
  });

  describe('Task 10 (C6) — offlineVaultService.cjs achievement_icon role isolation, alpha preservation & eviction', () => {
    it('sets ROLE_MAX_WIDTHS.achievement_icon = 128 and content-addresses distinct achievement icons per URL hash on the same game', async () => {
      expect(offlineVaultMod.ROLE_MAX_WIDTHS.achievement_icon).toBe(128);

      const urlA =
        'https://shared.fastly.steamstatic.com/community_assets/images/apps/1643320/aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111.jpg';
      const urlB =
        'https://shared.fastly.steamstatic.com/community_assets/images/apps/1643320/bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222.jpg';

      const expectedHashA = crypto.createHash('sha256').update(urlA).digest('hex').slice(0, 32);
      const expectedHashB = crypto.createHash('sha256').update(urlB).digest('hex').slice(0, 32);

      const keyA = offlineVaultMod.buildAssetUrlKey('steam-1643320', 'achievement_icon', 0, urlA);
      const keyB = offlineVaultMod.buildAssetUrlKey('steam-1643320', 'achievement_icon', 0, urlB);

      expect(keyA).toBe(`steam-1643320::achievement_icon::${expectedHashA}`);
      expect(keyB).toBe(`steam-1643320::achievement_icon::${expectedHashB}`);
      expect(keyA).not.toBe(keyB);

      // Xbox EDS proxy URLs distinguish different achievement icons via `?url=...`
      const xboxNormA = offlineVaultMod.normalizeAssetIdentityUrl(
        'https://images-eds-ssl.xboxlive.com/image?url=trophy_token_alpha&w=128&h=128'
      );
      const xboxNormB = offlineVaultMod.normalizeAssetIdentityUrl(
        'https://images-eds-ssl.xboxlive.com/image?url=trophy_token_beta&w=128&h=128'
      );
      expect(xboxNormA).not.toBe(xboxNormB);

      const sandbox = makeTempDir('ol-w2-ach-keys-');
      const pngA = makePngBuffer(1024, 0x11);
      const pngB = makePngBuffer(1024, 0x22);

      const fetchImpl = vi.fn(async (input: string) => {
        if (input === urlA) {
          return makeMockHttpResponse({ status: 200, body: pngA, contentType: 'image/png' });
        }
        if (input === urlB) {
          return makeMockHttpResponse({ status: 200, body: pngB, contentType: 'image/png' });
        }
        return makeMockHttpResponse({ status: 404, body: 'not found' });
      });

      const vault = createTrackedVault({
        userDataDir: sandbox,
        fetchImpl,
      });

      const resA = await vault.resolveMediaRequest({
        gameId: 'steam-1643320',
        role: 'achievement_icon',
        ordinal: 0,
        url: urlA,
        steamAppId: '1643320',
      });
      const resB = await vault.resolveMediaRequest({
        gameId: 'steam-1643320',
        role: 'achievement_icon',
        ordinal: 0,
        url: urlB,
        steamAppId: '1643320',
      });

      expect(resA.kind).toBe('buffer');
      expect(resB.kind).toBe('buffer');
      expect(resA.source).toBe('upstream_persisted');
      expect(resB.source).toBe('upstream_persisted');
      expect(resA.filePath).toBeTruthy();
      expect(resB.filePath).toBeTruthy();
      expect(resA.filePath).not.toBe(resB.filePath);
      expect(resA.mimeType).toBe('image/png');
      expect(resB.mimeType).toBe('image/png');

      // Second read for each icon serves directly from Tier-1A vault_blob without hitting network again
      const cachedA = await vault.resolveMediaRequest({
        gameId: 'steam-1643320',
        role: 'achievement_icon',
        ordinal: 0,
        url: urlA,
        steamAppId: '1643320',
      });
      expect(cachedA.kind).toBe('file');
      expect(cachedA.source).toBe('vault_blob');
      expect(cachedA.filePath).toBe(resA.filePath);
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      const db = vault.ensureOpen();
      const rows = db
        .prepare(
          "SELECT url_key, asset_role, blob_sha256, storage_kind FROM game_media_assets WHERE game_id = 'steam-1643320' AND asset_role = 'achievement_icon' ORDER BY url_key"
        )
        .all();

      expect(rows).toHaveLength(2);
      const storedKeys = rows.map((r) => String(r.url_key));
      expect(storedKeys).toContain(keyA);
      expect(storedKeys).toContain(keyB);
      expect(String(rows[0].blob_sha256)).not.toBe(String(rows[1].blob_sha256));
      expect(rows.every((r) => r.storage_kind === 'blob')).toBe(true);
    });

    it('bypasses Tier-2 Steam/Xbox local cache federation for achievement_icon and (icon && ordinal > 0), and self-heals pre-existing federated rows', async () => {
      const sandbox = makeTempDir('ol-w2-ach-fed-');

      // Create realistic local Steam appcache game icon AND Xbox WindowsApps Square150x150Logo
      const steamIconDir = path.join(sandbox, 'Steam', 'appcache', 'librarycache', '1643320');
      fs.mkdirSync(steamIconDir, { recursive: true });
      const steamAppIconPath = path.join(
        steamIconDir,
        '0123456789abcdef0123456789abcdef01234567.jpg'
      );
      fs.writeFileSync(steamAppIconPath, makeJpegBuffer(512, 0xaa));

      const xboxDir = path.join(sandbox, 'XboxGames', 'SyntheticTitle', 'Content');
      fs.mkdirSync(xboxDir, { recursive: true });
      const xboxAppIconPath = path.join(xboxDir, 'Square150x150Logo.png');
      fs.writeFileSync(xboxAppIconPath, makePngBuffer(512, 0xbb));

      // Verify compatibility predicate rejects achievement_icon & icon(ordinal>0) directly
      expect(
        offlineVaultMod.isFederatedAssetRowCompatible(
          'https://shared.fastly.steamstatic.com/community_assets/images/apps/1643320/trophy_icon.jpg',
          steamAppIconPath,
          { role: 'achievement_icon', ordinal: 0, steamAppId: '1643320' }
        )
      ).toBe(false);
      expect(
        offlineVaultMod.isFederatedAssetRowCompatible(
          'https://images-eds-ssl.xboxlive.com/image?url=trophy1',
          xboxAppIconPath,
          { role: 'icon', ordinal: 1, xboxProductId: '9NBLGGH537BL' }
        )
      ).toBe(false);
      // Game app icon at ordinal 0 remains allowed
      expect(
        offlineVaultMod.isFederatedAssetRowCompatible(
          'https://images-eds-ssl.xboxlive.com/image?url=appicon',
          xboxAppIconPath,
          { role: 'icon', ordinal: 0, xboxProductId: '9NBLGGH537BL' }
        )
      ).toBe(true);

      // Verify real federator also refuses achievement_icon / icon(ordinal>0)
      expect(
        federatorMod.resolveFederatedAsset(
          {
            gameId: 'steam-1643320',
            role: 'achievement_icon',
            ordinal: 0,
            steamAppId: '1643320',
            url: 'https://shared.fastly.steamstatic.com/community_assets/images/apps/1643320/trophy1.jpg',
          },
          { steamRoots: [path.join(sandbox, 'Steam')] }
        )
      ).toBeNull();

      // Aggressive spy federator that would return a game app icon if ever invoked!
      const resolveFederatedAssetSpy = vi.fn((payload: Record<string, unknown>) => {
        if (payload.xboxProductId) {
          return {
            path: xboxAppIconPath,
            mimeType: 'image/png',
            sizeBytes: 512,
            source: 'xbox_local_cache',
          };
        }
        return {
          path: steamAppIconPath,
          mimeType: 'image/jpeg',
          sizeBytes: 512,
          source: 'steam_librarycache',
        };
      });

      const steamAchUrl =
        'https://shared.fastly.steamstatic.com/community_assets/images/apps/1643320/fedcba9876543210fedcba9876543210fedcba98.png';
      const xboxAchUrl = 'https://images-eds-ssl.xboxlive.com/image?url=xbox_trophy_unique_01';
      const legacyOrd1Url =
        'https://shared.fastly.steamstatic.com/community_assets/images/apps/1643320/legacy_ord1_trophy.png';
      const realSteamAchBytes = makePngBuffer(1200, 0x33);
      const realXboxAchBytes = makePngBuffer(1400, 0x44);
      const realLegacyOrd1Bytes = makePngBuffer(1300, 0x55);

      const fetchImpl = vi.fn(async (input: string) => {
        if (input === steamAchUrl) {
          return makeMockHttpResponse({
            status: 200,
            body: realSteamAchBytes,
            contentType: 'image/png',
          });
        }
        if (input === xboxAchUrl) {
          return makeMockHttpResponse({
            status: 200,
            body: realXboxAchBytes,
            contentType: 'image/png',
          });
        }
        if (input === legacyOrd1Url) {
          return makeMockHttpResponse({
            status: 200,
            body: realLegacyOrd1Bytes,
            contentType: 'image/png',
          });
        }
        return makeMockHttpResponse({ status: 404, body: 'missing' });
      });

      const vault = createTrackedVault({
        userDataDir: sandbox,
        fetchImpl,
        federator: { resolveFederatedAsset: resolveFederatedAssetSpy },
      });

      // 1. Steam achievement_icon MUST NOT call Tier-2 federator
      const steamRes = await vault.resolveMediaRequest({
        gameId: 'steam-1643320',
        role: 'achievement_icon',
        ordinal: 0,
        steamAppId: '1643320',
        url: steamAchUrl,
      });
      expect(steamRes.kind).toBe('buffer');
      expect(steamRes.source).toBe('upstream_persisted');
      expect(steamRes.filePath).not.toBe(steamAppIconPath);
      expect(fs.readFileSync(String(steamRes.filePath)).equals(realSteamAchBytes)).toBe(true);

      // 2. Xbox achievement_icon MUST NOT call Tier-2 federator
      const xboxRes = await vault.resolveMediaRequest({
        gameId: 'xbox-9NBLGGH537BL',
        role: 'achievement_icon',
        ordinal: 0,
        xboxProductId: '9NBLGGH537BL',
        url: xboxAchUrl,
      });
      expect(xboxRes.kind).toBe('buffer');
      expect(xboxRes.source).toBe('upstream_persisted');
      expect(xboxRes.filePath).not.toBe(xboxAppIconPath);
      expect(fs.readFileSync(String(xboxRes.filePath)).equals(realXboxAchBytes)).toBe(true);

      // 3. Legacy (role === 'icon' && ordinal > 0) MUST ALSO skip Tier-2 federator
      const legacyOrd1Res = await vault.resolveMediaRequest({
        gameId: 'steam-1643320',
        role: 'icon',
        ordinal: 1,
        steamAppId: '1643320',
        url: legacyOrd1Url,
      });
      expect(legacyOrd1Res.kind).toBe('buffer');
      expect(legacyOrd1Res.source).toBe('upstream_persisted');
      expect(legacyOrd1Res.filePath).not.toBe(steamAppIconPath);

      // Zero Tier-2 federation calls across all three achievement icon requests!
      expect(resolveFederatedAssetSpy).toHaveBeenCalledTimes(0);

      // 4. Positive control: game app icon (role: 'icon', ordinal: 0) STILL uses Tier-2 federation
      const appIconRes = await vault.resolveMediaRequest({
        gameId: 'xbox-9NBLGGH537BL',
        role: 'icon',
        ordinal: 0,
        xboxProductId: '9NBLGGH537BL',
        url: 'https://images-eds-ssl.xboxlive.com/image?url=app_icon_0',
      });
      expect(appIconRes.kind).toBe('file');
      expect(appIconRes.source).toBe('xbox_local_cache');
      expect(appIconRes.filePath).toBe(xboxAppIconPath);
      expect(resolveFederatedAssetSpy).toHaveBeenCalledTimes(1);

      // 5. Poisoned pre-upgrade Tier-1B federated row with role='icon', ordinal=1 is rejected and self-healed to Tier-3 blob
      const poisonedUrl =
        'https://shared.fastly.steamstatic.com/community_assets/images/apps/1643320/poisoned_trophy.png';
      const poisonedKey = offlineVaultMod.buildAssetUrlKey(
        'steam-1643320',
        'icon',
        1,
        poisonedUrl
      );
      const db = vault.ensureOpen();
      db.prepare(
        `INSERT INTO game_media_assets (
          url_key, game_id, asset_role, ordinal, source_url, storage_kind,
          blob_sha256, federated_path, failure_count, next_retry_at, last_status_code, last_verified_at
        ) VALUES (?, ?, 'icon', 1, ?, 'federated', NULL, ?, 0, 0, 200, ?)`
      ).run(poisonedKey, 'steam-1643320', poisonedUrl, steamAppIconPath, Date.now());

      const poisonedBytes = makePngBuffer(1100, 0x66);
      fetchImpl.mockImplementationOnce(async () =>
        makeMockHttpResponse({ status: 200, body: poisonedBytes, contentType: 'image/png' })
      );

      const healedRes = await vault.resolveMediaRequest({
        gameId: 'steam-1643320',
        role: 'icon',
        ordinal: 1,
        steamAppId: '1643320',
        url: poisonedUrl,
      });
      expect(healedRes.kind).toBe('buffer');
      expect(healedRes.source).toBe('upstream_persisted');
      expect(healedRes.filePath).not.toBe(steamAppIconPath);
      expect(fs.readFileSync(String(healedRes.filePath)).equals(poisonedBytes)).toBe(true);
    });

    it('preserves alpha-channel PNG for achievement_icon > 45 KB and > 256 KB (resizing to 128px max width and never converting to JPEG)', async () => {
      const sandbox = makeTempDir('ol-w2-ach-alpha-');

      const resizeSpy = vi.fn();
      const toPngSpy = vi.fn(() => makePngBuffer(28 * 1024, 0x77));
      const toJpegSpy = vi.fn(() => makeJpegBuffer(20 * 1024, 0x88));

      const mockNativeImage = {
        createFromBuffer: vi.fn((_buf: Buffer) => {
          const imgHandle = {
            isEmpty: () => false,
            getSize: () => ({ width: 512, height: 512 }),
            resize: (opts: { width: number; height?: number }) => {
              resizeSpy(opts);
              return imgHandle;
            },
            toPNG: toPngSpy,
            toJPEG: toJpegSpy,
          };
          return imgHandle;
        }),
      };

      const vault = createTrackedVault({
        userDataDir: sandbox,
        nativeImage: mockNativeImage,
      });

      // Case 1: 80 KB transparent PNG (> 45 KB PASS_THROUGH_MAX_BYTES, <= 256 KB alpha pass-through)
      const png80Kb = makePngBuffer(80 * 1024, 0x41);
      const res80 = vault.normalizeImageBuffer(png80Kb, 'image/png', 'achievement_icon');
      expect(res80.valid).toBe(true);
      expect(res80.ext).toBe('png');
      expect(res80.mimeType).toBe('image/png');
      expect(res80.normalized).toBe(false);
      expect(toJpegSpy).not.toHaveBeenCalled();

      // Case 2: 320 KB oversized 512x512 PNG (> 256 KB) -> resizes to width 128 and calls toPNG(), NEVER toJPEG()
      const png320Kb = makePngBuffer(320 * 1024, 0x42);
      const res320 = vault.normalizeImageBuffer(png320Kb, 'image/png', 'achievement_icon');
      expect(res320.valid).toBe(true);
      expect(res320.ext).toBe('png');
      expect(res320.mimeType).toBe('image/png');
      expect(res320.normalized).toBe(true);
      expect(resizeSpy).toHaveBeenCalledWith({ width: 128, height: 128 });
      expect(toPngSpy).toHaveBeenCalledTimes(1);
      expect(toJpegSpy).not.toHaveBeenCalled();

      // Case 3: Even if nativeImage lacks toPNG (or returns larger buffer), achievement_icon PNG still NEVER converts to JPEG
      const toJpegNoPngSpy = vi.fn(() => makeJpegBuffer(16 * 1024, 0x99));
      const vaultNoToPng = createTrackedVault({
        userDataDir: makeTempDir('ol-w2-ach-alpha-fallback-'),
        nativeImage: {
          createFromBuffer: () => ({
            isEmpty: () => false,
            getSize: () => ({ width: 512, height: 512 }),
            resize: function self() {
              return this;
            },
            toJPEG: toJpegNoPngSpy,
          }),
        },
      });
      const resFallback = vaultNoToPng.normalizeImageBuffer(
        png320Kb,
        'image/png',
        'achievement_icon'
      );
      expect(resFallback.valid).toBe(true);
      expect(resFallback.ext).toBe('png');
      expect(resFallback.mimeType).toBe('image/png');
      expect(toJpegNoPngSpy).not.toHaveBeenCalled();

      // Case 4: End-to-end Tier-3 resolveMediaRequest stores a 90 KB achievement_icon PNG as image/png blob
      const achUrl =
        'https://shared-static-prod.epicgames.com/epic-achievements/alpha-trophy-90kb.png';
      const png90Kb = makePngBuffer(90 * 1024, 0x43);
      const e2eVault = createTrackedVault({
        userDataDir: makeTempDir('ol-w2-ach-e2e-png-'),
        nativeImage: mockNativeImage,
        fetchImpl: vi.fn(async () =>
          makeMockHttpResponse({ status: 200, body: png90Kb, contentType: 'image/png' })
        ),
      });
      const e2eRes = await e2eVault.resolveMediaRequest({
        gameId: 'epic-aw2',
        role: 'achievement_icon',
        ordinal: 0,
        url: achUrl,
      });
      expect(e2eRes.kind).toBe('buffer');
      expect(e2eRes.source).toBe('upstream_persisted');
      expect(e2eRes.mimeType).toBe('image/png');
      expect(String(e2eRes.filePath)).toMatch(/\.png$/);
      expect(toJpegSpy).not.toHaveBeenCalled();
    });

    it('assigns achievement_icon eviction retention rank 25 (< 55 and < 100 even on installed games) so 100+ trophy icons never starve covers', async () => {
      const sandbox = makeTempDir('ol-w2-ach-evict-');
      const nowMs = Date.now();

      const installedCoverUrl = 'https://cdn.example.invalid/installed-cover.webp';
      const uninstalledCoverUrl = 'https://cdn.example.invalid/uninstalled-cover.webp';
      const installedCoverBuf = makeWebpBuffer(10 * 1024, 1001);
      const uninstalledCoverBuf = makeWebpBuffer(10 * 1024, 1002);

      // Prepare 16 distinct achievement icons on the INSTALLED game
      const iconCount = 16;
      const iconSizeBytes = 20 * 1024;
      const iconMap = new Map<string, Buffer>();
      for (let i = 0; i < iconCount; i++) {
        iconMap.set(
          `https://cdn.example.invalid/trophy-${i}.webp`,
          makeWebpBuffer(iconSizeBytes, 2000 + i)
        );
      }

      const fetchImpl = vi.fn(async (input: string) => {
        if (input === installedCoverUrl) {
          return makeMockHttpResponse({
            status: 200,
            body: installedCoverBuf,
            contentType: 'image/webp',
          });
        }
        if (input === uninstalledCoverUrl) {
          return makeMockHttpResponse({
            status: 200,
            body: uninstalledCoverBuf,
            contentType: 'image/webp',
          });
        }
        const iconBuf = iconMap.get(input);
        if (iconBuf) {
          return makeMockHttpResponse({
            status: 200,
            body: iconBuf,
            contentType: 'image/webp',
          });
        }
        return makeMockHttpResponse({ status: 404, body: 'missing' });
      });

      const vault = createTrackedVault({
        userDataDir: sandbox,
        fetchImpl,
      });

      vault.upsertGames([
        {
          id: 'steam-installed-100',
          title: 'Installed Trophy Heavy Game',
          steamAppId: 100,
          isInstalled: true,
          platforms: [{ platformId: 'steam', platformGameId: '100', installed: true }],
        },
        {
          id: 'steam-uninstalled-200',
          title: 'Uninstalled Library Game',
          steamAppId: 200,
          isInstalled: false,
          platforms: [{ platformId: 'steam', platformGameId: '200', installed: false }],
        },
      ]);

      // Populate covers FIRST (older last_accessed_at) and achievement icons AFTER (newer last_accessed_at!)
      // so eviction MUST rely on retention_rank (25 < 55 < 100), not recency!
      const installedCoverRes = await vault.resolveMediaRequest({
        gameId: 'steam-installed-100',
        role: 'cover',
        ordinal: 0,
        url: installedCoverUrl,
      });
      const uninstalledCoverRes = await vault.resolveMediaRequest({
        gameId: 'steam-uninstalled-200',
        role: 'cover',
        ordinal: 0,
        url: uninstalledCoverUrl,
      });
      expect(installedCoverRes.kind).toBe('buffer');
      expect(uninstalledCoverRes.kind).toBe('buffer');
      expect(installedCoverRes.source).toBe('upstream_persisted');
      expect(uninstalledCoverRes.source).toBe('upstream_persisted');

      // Make covers explicitly older than achievement icons in media_blobs
      const db = vault.ensureOpen();
      db.prepare('UPDATE media_blobs SET last_accessed_at = ?').run(nowMs - 60_000);

      for (const iconUrl of iconMap.keys()) {
        const res = await vault.resolveMediaRequest({
          gameId: 'steam-installed-100',
          role: 'achievement_icon',
          ordinal: 0,
          url: iconUrl,
        });
        expect(res.kind).toBe('buffer');
        expect(res.source).toBe('upstream_persisted');
      }

      // Compute exact budget cap so targetTotalBytes (= 0.8 * maxBytes) keeps SQLite + both covers intact
      // while forcing eviction of achievement_icon blobs!
      const sqliteBytes = vault.getSqliteDiskBytes();
      const coversBytes = installedCoverBuf.length + uninstalledCoverBuf.length;
      const desiredTargetBytes = sqliteBytes + coversBytes + 16 * 1024;
      const moderateMaxBytes = Math.ceil(desiredTargetBytes / 0.8);

      // Verify current total exceeds moderateMaxBytes so eviction triggers
      const totalBlobRow = db
        .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM media_blobs')
        .get();
      const totalBlobsBefore = Number(totalBlobRow?.total || 0);
      expect(sqliteBytes + totalBlobsBefore).toBeGreaterThan(moderateMaxBytes);

      const evictModerate = vault.maybeEvictBlobs({
        maxBytes: moderateMaxBytes,
        forceIfOverMax: true,
      });
      expect(evictModerate.evictedCount).toBeGreaterThan(0);

      // BOTH the installed game's cover (rank 100) AND the uninstalled game's cover (rank 55) MUST survive!
      const installedCoverRow = db
        .prepare(
          "SELECT storage_kind, blob_sha256 FROM game_media_assets WHERE game_id = 'steam-installed-100' AND asset_role = 'cover'"
        )
        .get();
      const uninstalledCoverRow = db
        .prepare(
          "SELECT storage_kind, blob_sha256 FROM game_media_assets WHERE game_id = 'steam-uninstalled-200' AND asset_role = 'cover'"
        )
        .get();
      expect(installedCoverRow?.storage_kind).toBe('blob');
      expect(uninstalledCoverRow?.storage_kind).toBe('blob');
      expect(fs.existsSync(String(installedCoverRes.filePath))).toBe(true);
      expect(fs.existsSync(String(uninstalledCoverRes.filePath))).toBe(true);

      // Evicted blobs must come from achievement_icon on the installed game!
      const remainingAchIcons = db
        .prepare(
          "SELECT COUNT(*) AS cnt FROM game_media_assets WHERE game_id = 'steam-installed-100' AND asset_role = 'achievement_icon' AND storage_kind = 'blob'"
        )
        .get();
      expect(Number(remainingAchIcons?.cnt || 0)).toBeLessThan(iconCount);

      // Under extreme pressure (maxBytes = 1), ALL remaining installed-game achievement_icon blobs (rank 25 < 100)
      // MUST be evicted while the installed game's cover (rank 100 pinned) STILL survives!
      vault.maybeEvictBlobs({ maxBytes: 1, forceIfOverMax: true });
      const postExtremeAchIcons = db
        .prepare(
          "SELECT COUNT(*) AS cnt FROM game_media_assets WHERE game_id = 'steam-installed-100' AND asset_role = 'achievement_icon' AND storage_kind = 'blob'"
        )
        .get();
      expect(Number(postExtremeAchIcons?.cnt || 0)).toBe(0);

      const installedCoverAfterExtreme = db
        .prepare(
          "SELECT storage_kind FROM game_media_assets WHERE game_id = 'steam-installed-100' AND asset_role = 'cover'"
        )
        .get();
      expect(installedCoverAfterExtreme?.storage_kind).toBe('blob');
      expect(fs.existsSync(String(installedCoverRes.filePath))).toBe(true);
    });
  });

  describe('Task 6 — storeSync.cjs Epic Content API multi-OS system requirements parser', () => {
    it('extractEpicRequirementsByOs parses Windows, Mac (OSX/Darwin), and Linux (Ubuntu/SteamOS) regardless of ordering with strict HTML escaping', () => {
      // Non-Windows first to verify we never hardcode systems[0] as Windows!
      const parsed = storeSync.extractEpicRequirementsByOs([
        {
          systemType: 'Mac',
          details: [
            {
              title: 'OS:',
              minimum: 'macOS 13.0 <script>alert("mac")</script>',
              recommended: 'macOS 14.5 & Apple Silicon',
            },
            {
              title: 'Processor',
              minimum: 'Apple M1',
              recommended: 'Apple M3 Pro',
            },
          ],
        },
        {
          systemType: 'Steam OS',
          details: [
            {
              title: 'OS',
              minimum: 'SteamOS 3.5 <img src=x onerror=alert(1)>',
              recommended: 'Ubuntu 24.04 LTS',
            },
          ],
        },
        {
          systemType: 'Windows',
          details: [
            {
              title: 'OS',
              minimum: 'Windows 10 64-bit',
              recommended: 'Windows 11 64-bit',
            },
            {
              title: 'Memory',
              minimum: '8 GB RAM',
              recommended: '16 GB RAM',
            },
          ],
        },
      ]);

      expect(parsed.systemRequirements?.minimum).toBe(
        '<strong>OS:</strong> Windows 10 64-bit<br><strong>Memory:</strong> 8 GB RAM'
      );
      expect(parsed.systemRequirements?.recommended).toBe(
        '<strong>OS:</strong> Windows 11 64-bit<br><strong>Memory:</strong> 16 GB RAM'
      );

      expect(parsed.macRequirements?.minimum).toContain('<strong>OS:</strong> macOS 13.0');
      expect(parsed.macRequirements?.minimum).not.toContain('OS::');
      expect(parsed.macRequirements?.minimum).toContain(
        '&lt;script&gt;alert(&quot;mac&quot;)&lt;/script&gt;'
      );
      expect(parsed.macRequirements?.minimum).not.toContain('<script>');
      expect(parsed.macRequirements?.recommended).toContain(
        'macOS 14.5 &amp; Apple Silicon'
      );
      expect(parsed.macRequirements?.recommended).toContain('<strong>Processor:</strong> Apple M3 Pro');

      expect(parsed.linuxRequirements?.minimum).toContain(
        '&lt;img src=x onerror=alert(1)&gt;'
      );
      expect(parsed.linuxRequirements?.minimum).not.toContain('<img');
      expect(parsed.linuxRequirements?.recommended).toBe(
        '<strong>OS:</strong> Ubuntu 24.04 LTS'
      );
    });

    it('extractEpicRequirementsByOs handles variant OS labels, fallback behavior, and empty/Mac-only inputs cleanly', () => {
      // Variant labels: OSX + Ubuntu
      const variantParsed = storeSync.extractEpicRequirementsByOs([
        { systemType: 'OSX', details: [{ title: 'OS', minimum: 'OS X 10.15' }] },
        { systemType: 'Ubuntu', details: [{ title: 'OS', minimum: 'Ubuntu 22.04' }] },
      ]);
      expect(variantParsed.systemRequirements).toBeUndefined();
      expect(variantParsed.macRequirements?.minimum).toBe('<strong>OS:</strong> OS X 10.15');
      expect(variantParsed.macRequirements?.recommended).toBeUndefined();
      expect(variantParsed.linuxRequirements?.minimum).toBe('<strong>OS:</strong> Ubuntu 22.04');

      // Unrecognized systemType falls back to systemRequirements ONLY when Windows is absent
      const fallbackOnly = storeSync.extractEpicRequirementsByOs([
        { systemType: 'PC', details: [{ title: 'OS', minimum: '64-bit PC' }] },
      ]);
      expect(fallbackOnly.systemRequirements?.minimum).toBe('<strong>OS:</strong> 64-bit PC');

      // Explicit Windows overrides an earlier unrecognized entry
      const explicitWins = storeSync.extractEpicRequirementsByOs([
        { systemType: 'Generic', details: [{ title: 'OS', minimum: 'Generic Spec' }] },
        { systemType: 'Windows', details: [{ title: 'OS', minimum: 'Windows 11' }] },
      ]);
      expect(explicitWins.systemRequirements?.minimum).toBe('<strong>OS:</strong> Windows 11');

      // Empty / null inputs
      expect(storeSync.extractEpicRequirementsByOs([])).toEqual({});
      expect(storeSync.extractEpicRequirementsByOs(null)).toEqual({});
      expect(storeSync.extractEpicRequirementsByOs(undefined)).toEqual({});
    });

    it('fetchEpicProductOfferMetadata returns populated systemRequirements, macRequirements, and linuxRequirements end-to-end', async () => {
      const fetchFn = vi.fn(async (input: string) => {
        if (input.includes('/offers')) {
          return makeMockHttpResponse({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              elements: [
                {
                  id: 'offer-disco-multi-os',
                  title: 'Disco Elysium - The Final Cut',
                  offerType: 'BASE_GAME',
                  urlSlug: 'disco-elysium',
                  description: 'A groundbreaking narrative RPG.',
                  developerDisplayName: 'ZA/UM',
                  publisherDisplayName: 'ZA/UM',
                  keyImages: [
                    { type: 'OfferImageWide', url: 'https://cdn1.epicgames.com/disco/wide.jpg' },
                    { type: 'OfferImageTall', url: 'https://cdn1.epicgames.com/disco/tall.jpg' },
                  ],
                },
              ],
            }),
          });
        }
        if (input.includes('store-content.ak.epicgames.com')) {
          return makeMockHttpResponse({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              pages: [
                {
                  type: 'productHome',
                  data: {
                    requirements: {
                      systems: [
                        {
                          systemType: 'Windows',
                          details: [
                            { title: 'OS', minimum: 'Windows 7', recommended: 'Windows 10' },
                            { title: 'Memory', minimum: '2 GB RAM', recommended: '8 GB RAM' },
                          ],
                        },
                        {
                          systemType: 'Mac',
                          details: [
                            {
                              title: 'OS',
                              minimum: 'macOS 10.13 High Sierra',
                              recommended: 'macOS 13.0 Ventura (Apple Silicon)',
                            },
                            {
                              title: 'Processor',
                              minimum: 'Intel Core 2 Duo',
                              recommended: 'Apple M1 & newer',
                            },
                          ],
                        },
                        {
                          systemType: 'Linux',
                          details: [
                            {
                              title: 'OS',
                              minimum: 'Ubuntu 20.04',
                              recommended: 'SteamOS 3.0',
                            },
                          ],
                        },
                      ],
                      languages: ['Audio: English', 'Text: English, French'],
                    },
                  },
                },
              ],
            }),
          });
        }
        return makeMockHttpResponse({ status: 404, body: '{}' });
      });

      const meta = await storeSync.fetchEpicProductOfferMetadata(
        {
          namespace: 'ns-disco-multi-os',
          catalogItemId: 'cat-disco-multi-os',
          title: 'Disco Elysium - The Final Cut',
          slug: 'disco-elysium',
        },
        {
          fetchFn,
          accessToken: 'eg1~synthetic_test_token',
          bypassOfferCache: true,
        }
      );

      expect(meta).toBeTruthy();
      expect(meta?.systemRequirements?.minimum).toContain('<strong>OS:</strong> Windows 7');
      expect(meta?.systemRequirements?.recommended).toContain('<strong>Memory:</strong> 8 GB RAM');

      expect(meta?.macRequirements?.minimum).toContain(
        '<strong>OS:</strong> macOS 10.13 High Sierra'
      );
      expect(meta?.macRequirements?.recommended).toContain(
        '<strong>OS:</strong> macOS 13.0 Ventura (Apple Silicon)'
      );
      expect(meta?.macRequirements?.recommended).toContain(
        '<strong>Processor:</strong> Apple M1 &amp; newer'
      );

      expect(meta?.linuxRequirements?.minimum).toBe('<strong>OS:</strong> Ubuntu 20.04');
      expect(meta?.linuxRequirements?.recommended).toBe('<strong>OS:</strong> SteamOS 3.0');
    });
  });
});
