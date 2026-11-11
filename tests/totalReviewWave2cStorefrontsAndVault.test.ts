import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nodeRequire = createRequire(import.meta.url);

const tokenVault = nodeRequire('../electron/storefronts/tokenVault.cjs');
const nonGameClassifier = nodeRequire('../electron/storefronts/nonGameClassifier.cjs');
const storeSync = nodeRequire('../electron/storeSync.cjs');
const epicAuthRecoveryMod = nodeRequire('../electron/storefronts/epicAuthRecovery.cjs');
const steamLocalScanner = nodeRequire('../electron/storefronts/steamLocalScanner.cjs');
const gogScriptInterpreter = nodeRequire('../electron/storefronts/gog/gogScriptInterpreter.cjs');
const xboxConfigAndIds = nodeRequire('../electron/storefronts/xbox/xboxConfigAndIds.cjs');
const xboxCatalogAndGamePass = nodeRequire('../electron/storefronts/xbox/xboxCatalogAndGamePass.cjs');
const xboxAuthManager = nodeRequire('../electron/storefronts/xbox/xboxAuthManager.cjs');
const xboxTitleStorageSync = nodeRequire('../electron/storefronts/xbox/xboxTitleStorageSync.cjs');
const xboxRuntimeLoopbackServer = nodeRequire('../electron/storefronts/xbox/xboxRuntimeLoopbackServer.cjs');
const msixvcXvdParser = nodeRequire('../electron/storefronts/xbox/msixvcXvdParser.cjs');
const msixvcStreamExtractor = nodeRequire('../electron/storefronts/xbox/msixvcStreamExtractor.cjs');

// ============================================================================
// Self-Contained Synthetic Fixture Builders (Zero PII, Zero External Coupling)
// ============================================================================

interface SyntheticSegmentFile {
  path: string;
  data: Buffer;
}

function buildSyntheticSegmentMetadata(files: SyntheticSegmentFile[], pduidGuid: string): Buffer {
  const headerLength = 64;
  const pathChunks: Buffer[] = [];
  const pathMeta: Array<{ codeUnits: number; relByteOffset: number }> = [];
  let pathByteCursor = 0;

  for (const f of files) {
    const encoded = Buffer.from(`${f.path}\0`, 'utf16le');
    pathMeta.push({
      codeUnits: f.path.length,
      relByteOffset: pathByteCursor,
    });
    pathChunks.push(encoded);
    pathByteCursor += encoded.length;
  }

  const pathsTable = Buffer.concat(pathChunks);
  const rawTotal = headerLength + files.length * 16 + pathsTable.length;
  const buf = Buffer.alloc(Math.max(128, rawTotal), 0);

  buf.write(' PFX', 0, 'ascii');
  buf.writeUInt32LE(0, 0x04);
  buf.writeUInt32LE(1, 0x08);
  buf.writeUInt32LE(headerLength, 0x0c);
  buf.writeUInt32LE(files.length, 0x10);
  buf.writeUInt32LE(pathsTable.length, 0x14);
  msixvcXvdParser.writeGuidLE(pduidGuid, buf, 0x18);

  for (let i = 0; i < files.length; i += 1) {
    const recOff = headerLength + i * 16;
    buf.writeUInt16LE(0, recOff + 0x00);
    buf.writeUInt16LE(pathMeta[i].codeUnits, recOff + 0x02);
    buf.writeUInt32LE(pathMeta[i].relByteOffset, recOff + 0x04);
    buf.writeBigUInt64LE(BigInt(files[i].data.length), recOff + 0x08);
  }

  pathsTable.copy(buf, headerLength + files.length * 16);
  return buf;
}

function buildSyntheticUserData(
  packageFullName: string,
  entries: Array<{ name: string; data: Buffer }>
): Buffer {
  const headerLen = 16;
  const pkgHeaderLen = 528;
  const tableBytes = entries.length * 528;
  const payloadBytes = entries.reduce((acc, e) => acc + e.data.length, 0);
  const buf = Buffer.alloc(headerLen + pkgHeaderLen + tableBytes + payloadBytes, 0);

  buf.writeUInt32LE(headerLen, 0);
  buf.writeUInt32LE(1, 4);
  buf.writeUInt32LE(0, 8);
  buf.writeUInt32LE(0, 12);

  buf.writeUInt32LE(1, headerLen);
  Buffer.from(`${packageFullName}\0`, 'utf16le').copy(buf, headerLen + 4, 0, 520);
  buf.writeUInt32LE(entries.length, headerLen + 524);

  let relDataCursor = pkgHeaderLen + tableBytes;
  for (let i = 0; i < entries.length; i += 1) {
    const eOff = headerLen + pkgHeaderLen + i * 528;
    Buffer.from(`${entries[i].name}\0`, 'utf16le').copy(buf, eOff, 0, 520);
    buf.writeUInt32LE(entries[i].data.length, eOff + 520);
    buf.writeUInt32LE(relDataCursor, eOff + 524);
    entries[i].data.copy(buf, headerLen + relDataCursor);
    relDataCursor += entries[i].data.length;
  }

  return buf;
}

function buildSyntheticUnencryptedMsixvc(files: SyntheticSegmentFile[]): {
  container: Buffer;
  vduidGuid: string;
} {
  const vduidGuid = '11223344-5566-7788-99aa-bbccddeeff00';
  const contentIdGuid = 'aabbccdd-1122-3344-5566-77889900aabb';
  const segMetaBuf = buildSyntheticSegmentMetadata(files, vduidGuid);
  const userDataBuf = buildSyntheticUserData(
    'SyntheticPub.SyntheticTitle_1.0.0.0_x64__8wekyb3d8bbwe',
    [{ name: 'SegmentMetadata.bin', data: segMetaBuf }]
  );
  const xvcInfoHeaderSize = 0xd38;
  const xvcRegionHeaderSize = 0x70;
  const xvcDataLength = xvcInfoHeaderSize + xvcRegionHeaderSize;
  const xvdPageSize = 4096;

  let totalDrivePages = 0;
  for (const f of files) {
    totalDrivePages += f.data.length === 0 ? 1 : msixvcXvdParser.bytesToPages(f.data.length);
  }
  const driveSize = Math.max(1, totalDrivePages) * xvdPageSize;

  const hdr = Buffer.alloc(0x3000, 0);
  hdr.write('msft-xvd', 0x200, 'ascii');
  // READ_ONLY (0x01) | ENCRYPTION_DISABLED (0x02) | DATA_INTEGRITY_DISABLED (0x04)
  hdr.writeUInt32LE(0x01 | 0x02 | 0x04, 0x208);
  hdr.writeUInt32LE(3, 0x20c);
  hdr.writeBigUInt64LE(BigInt(driveSize), 0x218);
  msixvcXvdParser.writeGuidLE(vduidGuid, hdr, 0x220);
  hdr.writeUInt32LE(0, 0x280);
  hdr.writeUInt32LE(userDataBuf.length, 0x28c);
  hdr.writeUInt32LE(xvcDataLength, 0x290);
  msixvcXvdParser.writeGuidLE(contentIdGuid, hdr, 0x39c);
  msixvcXvdParser.writeGuidLE(vduidGuid, hdr, 0x3ac);

  const parsedHeader = msixvcXvdParser.parseXvdHeader(hdr);
  const layout = msixvcXvdParser.computeXvdLayout(parsedHeader);
  const container = Buffer.alloc(layout.totalContainerBytes, 0);

  hdr.copy(container, 0);
  userDataBuf.copy(container, layout.userData.byteOffset);

  const xvcBuf = Buffer.alloc(xvcDataLength, 0);
  msixvcXvdParser.writeGuidLE(contentIdGuid, xvcBuf, 0x000);
  xvcBuf.writeUInt32LE(1, 0xd10);
  xvcBuf.writeUInt32LE(1, 0xd14);
  const rOff = xvcInfoHeaderSize;
  xvcBuf.writeUInt32LE(1, rOff + 0x00);
  xvcBuf.writeUInt16LE(0xffff, rOff + 0x04);
  xvcBuf.writeUInt32LE(0, rOff + 0x0c);
  Buffer.from('PayloadRegion\0', 'utf16le').copy(xvcBuf, rOff + 0x10);
  xvcBuf.writeBigUInt64LE(BigInt(layout.driveData.byteOffset), rOff + 0x50);
  xvcBuf.writeBigUInt64LE(BigInt(driveSize), rOff + 0x58);
  xvcBuf.copy(container, layout.xvcInfo.byteOffset);

  let pageCursor = layout.driveData.byteOffset;
  for (const f of files) {
    const pages = f.data.length === 0 ? 1 : msixvcXvdParser.bytesToPages(f.data.length);
    for (let p = 0; p < pages; p += 1) {
      const sliceStart = p * xvdPageSize;
      if (sliceStart < f.data.length) {
        f.data.copy(
          container,
          pageCursor,
          sliceStart,
          Math.min(f.data.length, sliceStart + xvdPageSize)
        );
      }
      pageCursor += xvdPageSize;
    }
  }

  return { container, vduidGuid };
}

function buildSyntheticDisplayCatalogProduct(overrides: {
  productId?: string;
  title?: string;
  pfn?: string;
  xboxTitleId?: string;
  wuCategoryId?: string;
  contentId?: string;
} = {}) {
  const productId = overrides.productId || '9N0000000001';
  const title = overrides.title || 'Synthetic Horizon Quest';
  const pfn = overrides.pfn || `SyntheticPub.${productId}_8wekyb3d8bbwe`;
  const xboxTitleId = overrides.xboxTitleId || '19088743';
  const wuCategoryId = overrides.wuCategoryId || '11111111-2222-3333-4444-555555555555';
  const contentId = overrides.contentId || 'aabbccdd-1122-3344-5566-77889900aabb';

  return {
    ProductId: productId,
    ProductKind: 'Game',
    LocalizedProperties: [
      {
        ProductTitle: title,
        DeveloperName: 'Synthetic Studio',
        PublisherName: 'Synthetic Publisher',
        ShortDescription: 'Synthetic fixture description.',
        Images: [
          {
            ImagePurpose: 'Poster',
            Uri: '//store-images.s-microsoft.com/image/apps.1001.poster.png',
          },
        ],
      },
    ],
    MarketProperties: [{ OriginalReleaseDate: '2025-05-10T00:00:00Z' }],
    Properties: {
      PackageFamilyName: pfn,
      XboxLiveGoldRequired: false,
      Categories: ['Action & adventure'],
    },
    AlternateIds: [{ IdType: 'XboxTitleId', Value: xboxTitleId }],
    DisplaySkuAvailabilities: [
      {
        Sku: {
          SkuId: '0010',
          Properties: {
            BundledSkus: [],
            FulfillmentData: {
              PackageFamilyName: pfn,
              WuCategoryId: wuCategoryId,
            },
            Packages: [
              {
                PackageId: 'pkg-001',
                PackageFormat: 'MSIXVC',
                PackageFullName: `SyntheticPub.${productId}_1.0.0.0_x64__8wekyb3d8bbwe`,
                PackageFamilyName: pfn,
                ContentId: contentId,
                Architectures: ['x64'],
                MaxDownloadSizeInBytes: 67108864,
                PlatformDependencies: [{ PlatformName: 'Windows.Desktop' }],
              },
            ],
          },
        },
      },
    ],
  };
}

function makeJsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(raw, {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

function sendBinaryLoopbackRpc(
  port: number,
  frameObj: Record<string, unknown>
): Promise<{ closed: boolean; response?: any }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    let settled = false;

    sock.on('connect', () => {
      sock.write(xboxRuntimeLoopbackServer.encodeRpcFrame(frameObj));
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (buf.length >= 4 + len && !settled) {
          settled = true;
          const json = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
          sock.end();
          resolve({ closed: false, response: json });
        }
      }
    });

    sock.on('close', () => {
      if (!settled) {
        settled = true;
        resolve({ closed: true });
      }
    });

    sock.on('error', (err) => {
      if (!settled) {
        settled = true;
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') {
          resolve({ closed: true });
        } else {
          reject(err);
        }
      }
    });
  });
}

// ============================================================================
// Temp Directory Lifecycle
// ============================================================================

const tempDirs: string[] = [];
function makeTempDir(prefix = 'wave2c-test-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  vi.restoreAllMocks();
  tokenVault.invalidateVaultMemoryCache();
  storeSync.trimStoreSyncMemory();
  steamLocalScanner.trimSteamLocalScannerMemory();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

// ============================================================================
// 1. [P0] Epic Base-Game Suppression Fix (Finding #1)
// ============================================================================

describe('Wave 2C Deliverable 1 — Epic Base-Game Category Segment Classification', () => {
  it('admits Epic base games carrying { path: "applications" } and { path: "games" } without substring false positives', () => {
    const { classifyNonGameStorefrontItem } = nonGameClassifier;

    // Base game carrying both "games" and "applications" (standard Epic base-game metadata)
    expect(
      classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Synthetic Citadel Odyssey',
        platformId: 'epic',
        platformGameId: 'SyntheticCitadelApp',
        categories: [{ path: 'games' }, { path: 'games/edition/base' }, { path: 'applications' }],
      })
    ).toBeNull();

    // Base game whose category paths include "mods" or "vault" alongside "games" (or substring words)
    expect(
      classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Synthetic Moddable Strategy',
        platformId: 'epic',
        platformGameId: 'SyntheticModdableApp',
        categories: [
          { path: 'games' },
          { path: 'games_mods_support' },
          { path: 'vaulted_edition' },
          { path: 'mods' },
        ],
      })
    ).toBeNull();

    // True DLCs, UE engine assets, and PRIVATE sandboxes remain suppressed
    expect(
      classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Synthetic Expansion Pack',
        platformId: 'epic',
        platformGameId: 'SyntheticExpansionDlc',
        mainGameItem: { id: 'base-catalog-id-001' },
        categories: [{ path: 'addons' }, { path: 'applications' }],
      })
    ).toMatch(/DLC/i);

    expect(
      classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Synthetic Engine Plugin',
        platformId: 'epic',
        platformGameId: 'SyntheticUeAsset',
        namespace: 'ue',
        categories: [{ path: 'engines' }],
      })
    ).toMatch(/Engine|Editor/i);

    expect(
      classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Synthetic Staging Build',
        platformId: 'epic',
        platformGameId: 'SyntheticPrivateSandbox',
        sandboxType: 'PRIVATE',
        categories: [{ path: 'games' }],
      })
    ).toMatch(/Beta|Test Branch/i);
  });

  it('routes fetchEpicOwnedGames through canonical classifyNonGameStorefrontItem and preserves base games with { path: "applications" }', async () => {
    const emptyLegendaryDir = makeTempDir('wave2c-epic-empty-');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/library/api/public/playtime/')) {
        return makeJsonResponse([]);
      }
      if (url.includes('launcher.store.epicgames.com/graphql')) {
        return makeJsonResponse({ data: { PlayerProfile: { playerProfile: { achievementsSummaries: { data: [] } } } } });
      }
      if (url.includes('/launcher/api/public/assets/Mac')) {
        return makeJsonResponse([]);
      }
      if (url.includes('/library/api/public/items')) {
        return makeJsonResponse({
          records: [
            {
              appName: 'SyntheticBaseAlpha',
              namespace: 'ns_alpha_001',
              catalogItemId: 'cat_alpha_001',
              sandboxType: 'PUBLIC',
              metadata: {
                title: 'Synthetic Base Alpha',
                itemType: 'EXECUTABLE',
                categories: [{ path: 'games' }, { path: 'applications' }, { path: 'games/edition/base' }],
              },
            },
            {
              appName: 'SyntheticAddonBeta',
              namespace: 'ns_alpha_001',
              catalogItemId: 'cat_addon_002',
              sandboxType: 'PUBLIC',
              metadata: {
                title: 'Synthetic Alpha Expansion',
                itemType: 'ADD_ON',
                mainGameItem: { id: 'cat_alpha_001' },
                categories: [{ path: 'addons' }, { path: 'applications' }],
              },
            },
            {
              appName: 'SyntheticPrivateGamma',
              namespace: 'ns_gamma_003',
              catalogItemId: 'cat_gamma_003',
              sandboxType: 'PRIVATE',
              metadata: {
                title: 'Synthetic Internal Staging',
                categories: [{ path: 'games' }],
              },
            },
          ],
          responseMetadata: {},
        });
      }
      return makeJsonResponse({}, 404);
    });

    const outMeta: Record<string, any> = {};
    const games = await storeSync.fetchEpicOwnedGames('synthetic_epic_access_token', 'acct_0001', {
      fetchFn: fetchMock,
      legendaryBaseDirs: [emptyLegendaryDir],
      outMeta,
    });

    expect(outMeta.authoritativeComplete).toBe(true);
    expect(games.map((g: any) => g.title)).toEqual(['Synthetic Base Alpha']);
    expect(outMeta.suppressedItems.map((s: any) => s.platformGameId)).toEqual(['SyntheticAddonBeta']);
  });
});

// ============================================================================
// 2. [P0] Authoritative In-Memory TokenVault + Sync/Async Mutex + Win32 DPAPI (Finding #2)
// ============================================================================

describe('Wave 2C Deliverable 2 — Unified In-Memory TokenVault & Win32 DPAPI SafeStorage', () => {
  it('shares one authoritative in-memory state across concurrent saveTokensAsync and sync saveTokens without cross-storefront clobbering', async () => {
    const userDataDir = makeTempDir('wave2c-vault-concurrency-');
    const vaultOpts = { userDataDir, machineIdOverride: 'synthetic-machine-fp-001' };

    const pEpic = tokenVault.saveTokensAsync(
      'epic',
      { access_token: 'epic_live_token_001', refresh_token: 'epic_ref_001' },
      vaultOpts
    );

    // Interleave synchronous writes & deletes while async scrypt KDF is in flight!
    tokenVault.saveTokens(
      'gog',
      { access_token: 'gog_live_token_001', refresh_token: 'gog_ref_001' },
      vaultOpts
    );
    tokenVault.saveTokens('steam', { steamId: '76561198000000001' }, vaultOpts);
    const pXbox = tokenVault.saveTokensAsync(
      'xbox',
      { xuid: '2533274790000001', gamertag: 'SyntheticOne', xstsToken: 'xsts_live_001' },
      vaultOpts
    );
    tokenVault.clearTokens('steam', vaultOpts);

    await Promise.all([pEpic, pXbox]);

    // Verify immediate in-memory view
    const memLoaded = tokenVault.loadSavedTokens(vaultOpts);
    expect(memLoaded.epic?.access_token).toBe('epic_live_token_001');
    expect(memLoaded.gog?.access_token).toBe('gog_live_token_001');
    expect(memLoaded.xbox?.xuid).toBe('2533274790000001');
    expect(memLoaded.steam).toBeUndefined();

    // Invalidate memory cache to prove serialized disk flush persisted the merged state
    tokenVault.invalidateVaultMemoryCache(vaultOpts);
    const diskLoaded = await tokenVault.loadSavedTokensAsync(vaultOpts);
    expect(diskLoaded.epic?.access_token).toBe('epic_live_token_001');
    expect(diskLoaded.gog?.access_token).toBe('gog_live_token_001');
    expect(diskLoaded.xbox?.xuid).toBe('2533274790000001');
    expect(diskLoaded.steam).toBeUndefined();
  });

  it('wraps vault.key with mock Win32 DPAPI safeStorage, migrates legacy hex vault.key + v1:aes256gcm payloads, and fails closed if vault.key is deleted', async () => {
    const userDataDir = makeTempDir('wave2c-vault-dpapi-');
    const dpapiXorMask = 0x5a;
    const mockSafeStorage = {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((plain: string) => {
        const buf = Buffer.from(plain, 'utf8');
        for (let i = 0; i < buf.length; i++) buf[i] ^= dpapiXorMask;
        return buf;
      }),
      decryptString: vi.fn((cipher: Buffer) => {
        const buf = Buffer.from(cipher);
        for (let i = 0; i < buf.length; i++) buf[i] ^= dpapiXorMask;
        return buf.toString('utf8');
      }),
    };

    // Seed a legacy plaintext 64-char hex vault.key + legacy v1:aes256gcm:<salt>:<iv>:<tag>:<ct> tokens.json
    const legacySecretHex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const vaultKeyPath = path.join(userDataDir, 'vault.key');
    const tokensPath = path.join(userDataDir, 'tokens.json');
    fs.writeFileSync(vaultKeyPath, legacySecretHex, { mode: 0o600 });

    const hwFp = 'synthetic-win32-hw-001';
    const hwIdentityMaterial = tokenVault.getMachineIdentityKeyMaterial({ machineIdOverride: hwFp });
    const legacySalt = crypto.randomBytes(16);
    const legacyIv = crypto.randomBytes(12);
    const legacyKey = crypto.scryptSync(`${hwIdentityMaterial}:${legacySecretHex}`, legacySalt, 32, {
      N: 16384,
      r: 8,
      p: 1,
    });
    const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, legacyIv);
    const ct = Buffer.concat([
      cipher.update(JSON.stringify({ access_token: 'legacy_v1_epic_tok', refresh_token: 'legacy_v1_ref' }), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const legacyV1String = `v1:aes256gcm:${legacySalt.toString('hex')}:${legacyIv.toString('hex')}:${tag.toString('hex')}:${ct.toString('base64')}`;
    fs.writeFileSync(tokensPath, JSON.stringify({ epic: legacyV1String }, null, 2), { mode: 0o600 });

    const vaultOpts = {
      userDataDir,
      machineIdOverride: hwFp,
      safeStorage: mockSafeStorage,
    };

    // Loading migrates legacy plaintext vault.key -> dpapi:v1:<base64> and decrypts v1:aes256gcm seamlessly!
    const migratedRead = await tokenVault.loadSavedTokensAsync(vaultOpts);
    expect(migratedRead.epic?.access_token).toBe('legacy_v1_epic_tok');

    const wrappedKeyDisk = fs.readFileSync(vaultKeyPath, 'utf8').trim();
    expect(wrappedKeyDisk.startsWith('dpapi:v1:')).toBe(true);
    expect(mockSafeStorage.encryptString).toHaveBeenCalled();

    // Saving upgrades tokens.json to whole-vault _encrypted_v2/_encrypted_v3 AES-256-GCM envelope
    await tokenVault.saveTokensAsync(
      'gog',
      { access_token: 'gog_v2_token', refresh_token: 'gog_v2_ref' },
      vaultOpts
    );
    const rawTokensJson = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
    expect(rawTokensJson._encrypted_v2).toBe(true);
    expect(rawTokensJson._encrypted_v3).toBe(true);
    expect(rawTokensJson.alg).toBe('aes-256-gcm');
    expect(typeof rawTokensJson.data).toBe('string');

    // Fail-closed check: externally deleting vault.key prevents decrypting tokens.json after cache clear
    fs.unlinkSync(vaultKeyPath);
    tokenVault.invalidateVaultMemoryCache(vaultOpts);
    const afterDelete = await tokenVault.loadSavedTokensAsync(vaultOpts);
    expect(afterDelete).toEqual({});
  });

  it('creates .bak backup copy during writes and recovers automatically when tokens.json is 0-byte or corrupted', async () => {
    const userDataDir = makeTempDir('wave2c-vault-bak-');
    const vaultOpts = { userDataDir, machineIdOverride: 'synthetic-bak-machine-001' };
    const tokensPath = path.join(userDataDir, 'tokens.json');
    const bakPath = `${tokensPath}.bak`;

    // 1. Initial write creates tokens.json
    await tokenVault.saveTokensAsync(
      'epic',
      { access_token: 'epic_bak_initial_token', refresh_token: 'epic_bak_initial_ref' },
      vaultOpts
    );
    expect(fs.existsSync(tokensPath)).toBe(true);

    // 2. Second write preserves previous tokens in .bak backup file
    await tokenVault.saveTokensAsync(
      'gog',
      { access_token: 'gog_bak_second_token', refresh_token: 'gog_bak_second_ref' },
      vaultOpts
    );
    expect(fs.existsSync(bakPath)).toBe(true);
    const bakStat = fs.statSync(bakPath);
    expect(bakStat.size).toBeGreaterThan(0);

    // 3. Simulate sudden power failure / truncation leaving tokens.json 0 bytes
    fs.writeFileSync(tokensPath, '');
    expect(fs.statSync(tokensPath).size).toBe(0);

    // Invalidate in-memory cache to force reading from disk
    tokenVault.invalidateVaultMemoryCache(vaultOpts);

    // Async loader must detect 0-byte primary, recover from .bak, and restore primary file on disk
    const recoveredAsync = await tokenVault.loadSavedTokensAsync(vaultOpts);
    expect(recoveredAsync.epic?.access_token).toBe('epic_bak_initial_token');
    expect(fs.statSync(tokensPath).size).toBeGreaterThan(0);

    // 4. Simulate corruption (gibberish non-JSON content)
    fs.writeFileSync(tokensPath, 'CORRUPTED_NON_JSON_DATA_GARBAGE');
    tokenVault.invalidateVaultMemoryCache(vaultOpts);

    // Sync loader must detect corrupted primary, recover from .bak, and restore primary file on disk
    const recoveredSync = tokenVault.loadSavedTokens(vaultOpts);
    expect(recoveredSync.epic?.access_token).toBe('epic_bak_initial_token');
    expect(fs.statSync(tokensPath).size).toBeGreaterThan(0);
    const primaryJson = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
    expect(primaryJson._encrypted_v3).toBe(true);
  });

  it('enforces 5000ms mutex lock timeout and unblocks queued tasks without deadlocks', async () => {
    const userDataDir = makeTempDir('wave2c-vault-mutex-');
    const tokensPath = path.join(userDataDir, 'tokens.json');

    // 1. Short timeout verification using parameter
    const shortTimeoutMs = 60;
    const timedOutTask = tokenVault.runWithVaultMutex(
      tokensPath,
      () => new Promise((resolve) => setTimeout(resolve, 200)),
      shortTimeoutMs
    );
    await expect(timedOutTask).rejects.toThrow(`Vault mutex lock timed out after ${shortTimeoutMs}ms`);

    // 2. Deadlock prevention: subsequent task queued behind a timed-out task runs successfully
    const hangTask = tokenVault.runWithVaultMutex(
      tokensPath,
      () => new Promise((resolve) => setTimeout(resolve, 300)),
      shortTimeoutMs
    );
    const nextTask = tokenVault.runWithVaultMutex(
      tokensPath,
      async () => 'recovered_queue_task_result',
      5000
    );

    await expect(hangTask).rejects.toThrow(`Vault mutex lock timed out after ${shortTimeoutMs}ms`);
    const nextResult = await nextTask;
    expect(nextResult).toBe('recovered_queue_task_result');

    // 3. Default 5000ms timeout with vitest fake timers
    vi.useFakeTimers();
    try {
      const defaultTimeoutPromise = tokenVault.runWithVaultMutex(
        tokensPath,
        () => new Promise(() => {}) // never resolves
      );
      // Advance by 5001ms to trigger the default 5000ms timeout
      await vi.advanceTimersByTimeAsync(5005);
      await expect(defaultTimeoutPromise).rejects.toThrow('Vault mutex lock timed out after 5000ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('conforms to canonical contract interface exports (storeToken, retrieveToken, deleteToken, acquireVaultLock, writeVaultAtomic)', async () => {
    const userDataDir = makeTempDir('wave2c-vault-contract-');
    const vaultOpts = { userDataDir, machineIdOverride: 'synthetic-contract-machine-001' };
    const tokensPath = path.join(userDataDir, 'tokens.json');

    expect(typeof tokenVault.storeToken).toBe('function');
    expect(typeof tokenVault.retrieveToken).toBe('function');
    expect(typeof tokenVault.deleteToken).toBe('function');
    expect(typeof tokenVault.acquireVaultLock).toBe('function');
    expect(typeof tokenVault.writeVaultAtomic).toBe('function');

    // 1. storeToken persists credentials
    await tokenVault.storeToken(
      'epic',
      'account_synthetic_01',
      { access_token: 'epic_tok_c1', refresh_token: 'epic_ref_c1' },
      vaultOpts
    );

    // 2. retrieveToken retrieves by store and checks accountId
    const retrievedValid = await tokenVault.retrieveToken('epic', 'account_synthetic_01', vaultOpts);
    expect(retrievedValid?.access_token).toBe('epic_tok_c1');
    expect(retrievedValid?.accountId).toBe('account_synthetic_01');

    // AccountId mismatch returns null
    const retrievedMismatch = await tokenVault.retrieveToken('epic', 'different_account_id', vaultOpts);
    expect(retrievedMismatch).toBeNull();

    // Missing store returns null
    const retrievedMissing = await tokenVault.retrieveToken('gog', undefined, vaultOpts);
    expect(retrievedMissing).toBeNull();

    // 2b. Unattributed token retrieval and deletion isolation
    await tokenVault.storeToken('gog', undefined, { access_token: 'gog_unattributed' }, vaultOpts);
    expect(await tokenVault.retrieveToken('gog', 'user_mismatch', vaultOpts)).toBeNull();
    expect(await tokenVault.deleteToken('gog', 'user_mismatch', vaultOpts)).toBe(false);
    expect(await tokenVault.retrieveToken('gog', undefined, vaultOpts)).toEqual(
      expect.objectContaining({ access_token: 'gog_unattributed' })
    );
    expect(await tokenVault.deleteToken('gog', undefined, vaultOpts)).toBe(true);
    expect(await tokenVault.retrieveToken('gog', undefined, vaultOpts)).toBeNull();

    // 3. deleteToken removes token and returns boolean
    const deletedFalse = await tokenVault.deleteToken('epic', 'mismatched_account_id', vaultOpts);
    expect(deletedFalse).toBe(false);

    const deletedTrue = await tokenVault.deleteToken('epic', 'account_synthetic_01', vaultOpts);
    expect(deletedTrue).toBe(true);

    const retrievedAfterDelete = await tokenVault.retrieveToken('epic', 'account_synthetic_01', vaultOpts);
    expect(retrievedAfterDelete).toBeNull();

    // 4. writeVaultAtomic writes atomically
    const testFilePath = path.join(userDataDir, 'test-atomic.txt');
    await tokenVault.writeVaultAtomic(testFilePath, 'atomic_content_123');
    expect(fs.readFileSync(testFilePath, 'utf8')).toBe('atomic_content_123');

    // 5. acquireVaultLock runs task under lock (callback pattern)
    let lockExecuted = false;
    const lockResult = await tokenVault.acquireVaultLock(tokensPath, async () => {
      lockExecuted = true;
      return 'lock_completed';
    });
    expect(lockExecuted).toBe(true);
    expect(lockResult).toBe('lock_completed');

    // 5b. acquireVaultLock handle release pattern
    const lockHandle = tokenVault.acquireVaultLock(tokensPath, 3000);
    expect(typeof lockHandle.release).toBe('function');
    expect(lockHandle.acquired).toBeInstanceOf(Promise);
    await lockHandle.acquired;

    let subsequentTaskRan = false;
    const subsequentTask = tokenVault.acquireVaultLock(tokensPath, async () => {
      subsequentTaskRan = true;
      return 'subsequent_ok';
    });

    lockHandle.release();
    await lockHandle.lockPromise;
    const subsequentResult = await subsequentTask;
    expect(subsequentTaskRan).toBe(true);
    expect(subsequentResult).toBe('subsequent_ok');
  });

  it('supports selective cache invalidation with { userDataDir } preserving other cached vaults and scrubbing derived keys', async () => {
    const dirA = makeTempDir('wave2c-vault-selective-a-');
    const dirB = makeTempDir('wave2c-vault-selective-b-');
    const optsA = { userDataDir: dirA, machineIdOverride: 'synthetic-selective-machine-001' };
    const optsB = { userDataDir: dirB, machineIdOverride: 'synthetic-selective-machine-001' };

    // Seed both vaults
    await tokenVault.saveTokensAsync('epic', { access_token: 'vault_a_token' }, optsA);
    await tokenVault.saveTokensAsync('epic', { access_token: 'vault_b_token' }, optsB);

    // Warm in-memory cache for both
    const loadedA1 = tokenVault.loadSavedTokens(optsA);
    const loadedB1 = tokenVault.loadSavedTokens(optsB);
    expect(loadedA1.epic?.access_token).toBe('vault_a_token');
    expect(loadedB1.epic?.access_token).toBe('vault_b_token');

    // Selectively invalidate ONLY vault A
    tokenVault.invalidateVaultMemoryCache(optsA);

    // Vault B must STILL be served from cache without disk re-reading
    const loadedB2 = tokenVault.loadSavedTokens(optsB);
    expect(loadedB2.epic?.access_token).toBe('vault_b_token');

    // Global invalidation evicts all vaults and scrubs keys
    tokenVault.invalidateVaultMemoryCache();
    const loadedB3 = await tokenVault.loadSavedTokensAsync(optsB);
    expect(loadedB3.epic?.access_token).toBe('vault_b_token');
  });
});

// ============================================================================
// 3. [P0] Rotating OAuth Refresh Single-Flight, userDataDir, outMeta & Namespace Cache (Finding #3 & #14)
// ============================================================================

describe('Wave 2C Deliverable 3 — Rotating OAuth Single-Flight, outMeta Isolation & Epic Namespace Cache', () => {
  it('coalesces concurrent Epic & GOG refreshes per vault path, forwards userDataDir, and prevents consumed single-use token replay', async () => {
    const userDataDir = makeTempDir('wave2c-oauth-singleflight-');
    let epicRefreshNetworkCalls = 0;
    let gogRefreshNetworkCalls = 0;

    await storeSync.saveTokensAsync(
      'epic',
      {
        access_token: 'expired_epic_tok',
        refresh_token: 'eg1_initial_single_use_ref',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
      { userDataDir }
    );
    await storeSync.saveTokensAsync(
      'gog',
      {
        access_token: 'expired_gog_tok',
        refresh_token: 'gog_initial_ref',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
      { userDataDir }
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const bodyStr = String(init?.body || '');
      if (url.includes('account-public-service-prod03.ol.epicgames.com/account/api/oauth/token')) {
        epicRefreshNetworkCalls += 1;
        await new Promise((r) => setTimeout(r, 25));
        // Single-use rotation: fail if consumed token is ever replayed!
        if (epicRefreshNetworkCalls > 1 && bodyStr.includes('eg1_initial_single_use_ref')) {
          return makeJsonResponse({ errorCode: 'errors.com.epicgames.account.auth_token.invalid_refresh_token' }, 400);
        }
        return makeJsonResponse({
          access_token: `epic_rotated_access_${epicRefreshNetworkCalls}`,
          refresh_token: `eg1_rotated_ref_${epicRefreshNetworkCalls}`,
          expires_in: 7200,
        });
      }
      if (url.includes('auth.gog.com/token')) {
        gogRefreshNetworkCalls += 1;
        await new Promise((r) => setTimeout(r, 25));
        return makeJsonResponse({
          access_token: `gog_rotated_access_${gogRefreshNetworkCalls}`,
          refresh_token: `gog_rotated_ref_${gogRefreshNetworkCalls}`,
          expires_in: 3600,
        });
      }
      return makeJsonResponse({}, 404);
    });

    // Fire 3 concurrent Epic renewals (even with mismatched stale tokens!) + 2 concurrent GOG renewals
    const [e1, e2, e3, g1, g2] = await Promise.all([
      storeSync.renewEpicTokens('eg1_initial_single_use_ref', { userDataDir, fetchFn: fetchMock }),
      storeSync.renewEpicTokens('eg1_initial_single_use_ref', { userDataDir, fetchFn: fetchMock }),
      storeSync.renewEpicTokens('eg1_external_stale_legendary_ref', { userDataDir, fetchFn: fetchMock }),
      storeSync.renewGogTokens('gog_initial_ref', { userDataDir, fetchFn: fetchMock }),
      storeSync.renewGogTokens('gog_initial_ref', { userDataDir, fetchFn: fetchMock }),
    ]);

    expect(epicRefreshNetworkCalls).toBe(1);
    expect(gogRefreshNetworkCalls).toBe(1);
    expect(e1.access_token).toBe('epic_rotated_access_1');
    expect(e2.access_token).toBe('epic_rotated_access_1');
    expect(e3.access_token).toBe('epic_rotated_access_1');
    expect(g1.access_token).toBe('gog_rotated_access_1');
    expect(g2.access_token).toBe('gog_rotated_access_1');

    // Straggler arriving AFTER lock release with old consumed refresh token returns rotated token with 0 extra network calls
    const straggler = await storeSync.renewEpicTokens('eg1_initial_single_use_ref', {
      userDataDir,
      fetchFn: fetchMock,
    });
    expect(straggler.access_token).toBe('epic_rotated_access_1');
    expect(epicRefreshNetworkCalls).toBe(1);

    // Persisted into custom userDataDir
    const persisted = await storeSync.loadSavedTokensAsync({ userDataDir });
    expect(persisted.epic?.refresh_token).toBe('eg1_rotated_ref_1');
    expect(persisted.gog?.refresh_token).toBe('gog_rotated_ref_1');
  });

  it('isolates per-call outMeta on concurrent GOG syncs even when trimStoreSyncMemory runs mid-flight', async () => {
    const outMetaSuccess: Record<string, any> = {};
    const outMetaPartial: Record<string, any> = {};

    const fetchSuccess = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('getFilteredProducts')) {
        await new Promise((r) => setTimeout(r, 20));
        storeSync.trimStoreSyncMemory();
        return makeJsonResponse({
          totalPages: 1,
          products: [{ id: 100001, title: 'Synthetic Galaxy Pioneer', worksOn: { Windows: true, Mac: false } }],
        });
      }
      return makeJsonResponse({ items: [] });
    });

    const fetchPartial = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('getFilteredProducts')) {
        return makeJsonResponse({ error: 'gateway timeout' }, 503);
      }
      return makeJsonResponse({ items: [] });
    });

    const [gamesOk, gamesFail] = await Promise.all([
      storeSync.fetchGogOwnedGames('gog_tok_ok', 'SynthUser', '9001', {
        fetchFn: fetchSuccess,
        outMeta: outMetaSuccess,
      }),
      storeSync.fetchGogOwnedGames('gog_tok_fail', 'SynthUser', '9001', {
        fetchFn: fetchPartial,
        outMeta: outMetaPartial,
      }),
    ]);

    expect(gamesOk).toHaveLength(1);
    expect(outMetaSuccess.authoritativeComplete).toBe(true);
    expect((gamesOk as any).authoritativeComplete).toBe(true);

    expect(gamesFail).toHaveLength(0);
    expect(outMetaPartial.authoritativeComplete).toBe(false);
    expect((gamesFail as any).authoritativeComplete).toBe(false);
  });

  it('retains >600 Epic cloud assets without self-eviction, retries transient 503 after backoff, and evicts xboxProviderCache on clearTokens', async () => {
    const userDataDir = makeTempDir('wave2c-epic-nscache-');
    const emptyLegDir = makeTempDir('wave2c-epic-ns-empty-');
    await storeSync.saveTokensAsync(
      'epic',
      {
        access_token: 'epic_valid_assets_tok',
        refresh_token: 'epic_valid_assets_ref',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      },
      { userDataDir }
    );

    let nowMs = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    let cloudCalls = 0;
    const syntheticAssets = Array.from({ length: 650 }, (_, idx) => ({
      appName: `SynthAsset_${idx}`,
      namespace: `ns_synth_${idx}`,
      catalogItemId: `cat_synth_${idx}`,
      assetId: `asset_synth_${idx}`,
    }));

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/launcher/api/public/assets/Windows')) {
        cloudCalls += 1;
        if (cloudCalls === 1) {
          return makeJsonResponse({ error: 'service unavailable' }, 503);
        }
        return makeJsonResponse(syntheticAssets);
      }
      return makeJsonResponse({}, 404);
    });

    // First call hits HTTP 503 -> unresolved
    const firstTry = await storeSync.resolveEpicNamespaceAndIds(
      { appName: 'SynthAsset_0' },
      { userDataDir, legendaryBaseDirs: [emptyLegDir], fetchFn: fetchMock }
    );
    expect(firstTry.namespace).toBeNull();
    expect(cloudCalls).toBe(1);

    // Advance past 15s error backoff -> retries and populates all 650 assets without self-evicting asset #0!
    nowMs += 20_000;
    const secondTry = await storeSync.resolveEpicNamespaceAndIds(
      { appName: 'SynthAsset_0' },
      { userDataDir, legendaryBaseDirs: [emptyLegDir], fetchFn: fetchMock }
    );
    const tailTry = await storeSync.resolveEpicNamespaceAndIds(
      { appName: 'SynthAsset_649' },
      { userDataDir, legendaryBaseDirs: [emptyLegDir], fetchFn: fetchMock }
    );
    expect(cloudCalls).toBe(2);
    expect(secondTry.namespace).toBe('ns_synth_0');
    expect(tailTry.namespace).toBe('ns_synth_649');

    // Verify xboxProviderCache eviction on clearTokens('xbox')
    const p1 = storeSync.getXboxAuthProvider({ userDataDir });
    const p2 = storeSync.getXboxAuthProvider({ userDataDir });
    expect(p1).toBe(p2);
    storeSync.clearTokens('xbox', { userDataDir });
    const p3 = storeSync.getXboxAuthProvider({ userDataDir });
    expect(p3).not.toBe(p1);
  });
});

// ============================================================================
// 4. [P0] Xbox authoritativeComplete Hydration Integrity & FE3 XML Scoping (Finding #4 & #16)
// ============================================================================

describe('Wave 2C Deliverable 4 — Xbox DisplayCatalog Hydration Retry, authoritativeComplete & FE3 XML Scoping', () => {
  it('retries transient 429/503 DisplayCatalog responses and marks syncXboxCatalog authoritativeComplete=false while preserving cached titles on batch failure', async () => {
    const userDataDir = makeTempDir('wave2c-xbox-dcat-');

    // 1. Transient 429 -> 200 retry succeeds cleanly
    let retryAttempt = 0;
    const retryFetch = vi.fn(async () => {
      retryAttempt += 1;
      if (retryAttempt === 1) {
        return makeJsonResponse({ error: 'rate_limited' }, 429, { 'Retry-After': '0' });
      }
      return makeJsonResponse({
        Products: [buildSyntheticDisplayCatalogProduct({ productId: '9N0000000001', title: 'Synthetic Retry Title' })],
      });
    });

    const retryResult = await xboxCatalogAndGamePass.hydrateDisplayCatalogProducts(
      ['9N0000000001'],
      {
        market: 'US',
        languages: 'en-US',
        fetchImpl: retryFetch,
      }
    );
    expect(retryAttempt).toBe(2);
    expect(retryResult.failedBatchCount).toBe(0);
    expect(retryResult.size).toBe(1);

    // 2. Seed SQLite catalog cache with an owned game on an initial healthy sync
    const healthyFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('collections.mp.microsoft.com')) {
        return makeJsonResponse({
          items: [
            {
              productId: '9N0000000002',
              productKind: 'Game',
              acquisitionType: 'Single',
              status: 'Active',
              satisfiedByProductIds: [],
            },
          ],
        });
      }
      if (url.includes('displaycatalog.mp.microsoft.com')) {
        return makeJsonResponse({
          Products: [
            buildSyntheticDisplayCatalogProduct({
              productId: '9N0000000002',
              title: 'Synthetic Owned Vault Title',
            }),
          ],
        });
      }
      return makeJsonResponse({});
    });

    const initialSync = await xboxCatalogAndGamePass.syncXboxCatalog({
      syncMode: 'owned_and_played',
      xuid: '2533274790000002',
      storeToken: 'XBL3.0 x=synth;storetok',
      collectionsToken: 'XBL3.0 x=synth;colltok',
      checkMinecraftJava: false,
      market: 'US',
      locale: 'en-US',
      userDataDir,
      fetchImpl: healthyFetch,
    });
    expect(initialSync.authoritativeComplete).toBe(true);
    expect(initialSync.games).toHaveLength(1);

    // 3. Subsequent sync where a new owned product's DisplayCatalog hydration fails all retries (503)
    const degradedFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('collections.mp.microsoft.com')) {
        return makeJsonResponse({
          items: [
            {
              productId: '9N0000000002',
              productKind: 'Game',
              acquisitionType: 'Single',
              status: 'Active',
              satisfiedByProductIds: [],
            },
            {
              productId: '9N0000000003',
              productKind: 'Game',
              acquisitionType: 'Single',
              status: 'Active',
              satisfiedByProductIds: [],
            },
          ],
        });
      }
      if (url.includes('displaycatalog.mp.microsoft.com')) {
        return makeJsonResponse({ error: 'upstream outage' }, 503, { 'Retry-After': '0' });
      }
      return makeJsonResponse({});
    });

    const degradedSync = await xboxCatalogAndGamePass.syncXboxCatalog({
      syncMode: 'owned_and_played',
      xuid: '2533274790000002',
      storeToken: 'XBL3.0 x=synth;storetok',
      collectionsToken: 'XBL3.0 x=synth;colltok',
      checkMinecraftJava: false,
      maxBatchRetries: 1,
      retryBaseDelayMs: 5,
      market: 'US',
      locale: 'en-US',
      userDataDir,
      fetchImpl: degradedFetch,
    });

    expect(degradedSync.displayCatalogHydrationFailedBatchCount).toBeGreaterThan(0);
    expect(degradedSync.authoritativeComplete).toBe(false);
    // Owned titles are preserved (cached 9N0000000002 + stub 9N0000000003), NEVER pruned!
    const returnedStoreIds = degradedSync.games.map(
      (g: any) => g.platforms?.[0]?.xboxProductId || g.platforms?.[0]?.platformGameId
    );
    expect(returnedStoreIds).toContain('9N0000000002');
    expect(returnedStoreIds).toContain('9N0000000003');
    xboxCatalogAndGamePass.closeXboxCatalogCacheStore(userDataDir);
  });

  it('parses FE3 SOAP <UpdateInfo> and <FileLocation> XML blocks order-independently without sibling cross-bleed', async () => {
    let fe3Step = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('displaycatalog.mp.microsoft.com')) {
        return makeJsonResponse({
          Products: [
            buildSyntheticDisplayCatalogProduct({
              productId: '9N0000000009',
              wuCategoryId: '99999999-8888-7777-6666-555555555555',
            }),
          ],
        });
      }
      if (url.includes('packagespc.xboxlive.com')) {
        return makeJsonResponse({}, 404);
      }
      if (url.includes('fe3cr.delivery.mp.microsoft.com')) {
        fe3Step += 1;
        if (fe3Step === 1) {
          // Reversed attribute order: RevisionNumber BEFORE UpdateID + decoy sibling block without UpdateIdentity
          const syncSoapXml = `<?xml version="1.0" encoding="utf-8"?>
            <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
              <s:Body>
                <UpdateInfo><ID>101</ID></UpdateInfo>
                <UpdateInfo>
                  <UpdateIdentity RevisionNumber="4" UpdateID="deadbeef-1111-2222-3333-444455556666" />
                  <ID>202</ID>
                </UpdateInfo>
              </s:Body>
            </s:Envelope>`;
          return new Response(syncSoapXml, { status: 200 });
        }
        const extSoapXml = `<?xml version="1.0" encoding="utf-8"?>
          <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
            <s:Body>
              <FileLocation>
                <Url>http://tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/synth/SyntheticPkg_1.0.0.0_x64.msixvc?P1=1&amp;P2=2</Url>
                <FileDigest>AAECAwQ=</FileDigest>
              </FileLocation>
            </s:Body>
          </s:Envelope>`;
        return new Response(extSoapXml, { status: 200 });
      }
      return makeJsonResponse({}, 404);
    });

    const delivery = await xboxCatalogAndGamePass.resolveXboxPackageDeliveryInfo({
      storeId: '9N0000000009',
      fetchImpl: fetchMock,
    });
    expect(delivery.fileName).toBe('SyntheticPkg_1.0.0.0_x64.msixvc');
    expect(delivery.primaryDownloadUrl).toContain('P1=1&P2=2');
  });
});

// ============================================================================
// 5. [P0/P1] MSIXVC/XVD Allocation Caps, readSafeU64LE & .olpart Resume Integrity (Finding #8)
// ============================================================================

describe('Wave 2C Deliverable 5 — MSIXVC/XVD Safe U64 Bounds, Metadata Caps & .olpart Resume Verification', () => {
  it('enforces readSafeU64LE <= Number.MAX_SAFE_INTEGER and rejects oversized XVD userData allocations', async () => {
    const okBuf = Buffer.alloc(8);
    okBuf.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER), 0);
    expect(msixvcXvdParser.readSafeU64LE(okBuf, 0, 'testMaxSafe')).toBe(Number.MAX_SAFE_INTEGER);

    const overflowBuf = Buffer.alloc(8);
    overflowBuf.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 0);
    expect(() => msixvcXvdParser.readSafeU64LE(overflowBuf, 0, 'testOverflow')).toThrow(RangeError);

    expect(msixvcXvdParser.MAX_XVD_METADATA_ALLOC_BYTES).toBe(64 * 1024 * 1024);
    expect(msixvcXvdParser.MAX_NTFS_READ_ALL_BYTES).toBe(16 * 1024 * 1024);

    // Craft an XVD header claiming a 128 MiB userData section (> 64 MiB cap)
    const maliciousHdr = Buffer.alloc(0x3000, 0);
    maliciousHdr.write('msft-xvd', 0x200, 'ascii');
    maliciousHdr.writeUInt32LE(0x01 | 0x02 | 0x04, 0x208);
    maliciousHdr.writeUInt32LE(3, 0x20c);
    maliciousHdr.writeBigUInt64LE(4096n, 0x218);
    maliciousHdr.writeUInt32LE(128 * 1024 * 1024, 0x28c); // 128 MiB userDataLength!
    expect(() => msixvcXvdParser.parseXvdHeader(maliciousHdr)).toThrow(RangeError);

    const maliciousDynHdr = Buffer.alloc(0x3000, 0);
    maliciousDynHdr.write('msft-xvd', 0x200, 'ascii');
    maliciousDynHdr.writeUInt32LE(0x01 | 0x02 | 0x04, 0x208);
    maliciousDynHdr.writeUInt32LE(3, 0x20c);
    maliciousDynHdr.writeBigUInt64LE(4096n, 0x218);
    maliciousDynHdr.writeUInt32LE(1, 0x280); // Dynamic XVD
    maliciousDynHdr.writeBigUInt64LE(BigInt(128 * 1024 * 1024), 0x294); // 128 MiB dynamicHeaderLength!
    expect(() => msixvcXvdParser.parseXvdHeader(maliciousDynHdr)).toThrow(RangeError);
  });

  it('verifies <target>.olpart size covers contiguous completed slices on resume, purging stale journal slices to prevent sparse holes', async () => {
    const installDir = makeTempDir('wave2c-msixvc-resume-');
    // 4-page (16 KiB) deterministic non-zero payload split into 4 slices via chunkTargetBytes: 4096
    const expectedPayload = Buffer.alloc(16 * 1024);
    for (let i = 0; i < expectedPayload.length; i += 1) {
      expectedPayload[i] = (i * 31 + 17) & 0xff || 0x7f; // strictly non-zero bytes!
    }

    const { container, vduidGuid } = buildSyntheticUnencryptedMsixvc([
      { path: 'Files/Data/ArchiveChunk.pak', data: expectedPayload },
    ]);

    // Seed a stale resume journal claiming slices [0, 1] completed, while .olpart is truncated to only 2048 bytes!
    const targetFile = path.join(installDir, 'Data', 'ArchiveChunk.pak');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(`${targetFile}.olpart`, expectedPayload.subarray(0, 2048));
    const journalPath = path.join(installDir, msixvcStreamExtractor.RESUME_JOURNAL_FILENAME);
    fs.writeFileSync(
      journalPath,
      JSON.stringify({
        version: 1,
        status: 'in_progress',
        vduidGuid,
        completedFiles: {},
        completedLargeSlices: {
          'Data/ArchiveChunk.pak': [0, 1],
        },
      })
    );

    await msixvcStreamExtractor.extractMsixvcImage({
      msixvcBuffer: container,
      installDir,
      chunkTargetBytes: 4096,
      concurrency: 2,
    });

    const extracted = fs.readFileSync(targetFile);
    expect(extracted.length).toBe(expectedPayload.length);
    expect(extracted.equals(expectedPayload)).toBe(true);
    expect(fs.existsSync(`${targetFile}.olpart`)).toBe(false);
  });
});

// ============================================================================
// 6. [P1] Loopback RPC Server Hardening & Persistent Session Cloud Lock (Finding #12 & #16)
// ============================================================================

describe('Wave 2C Deliverable 6 — Loopback RPC Containment, Pre-Body Auth, B2C Timeout & Persistent Cloud Lock', () => {
  it('enforces PFN traversal containment, accepts both packageFamilyName and pfn, and attaches timeout signals to B2C token fetches', async () => {
    expect(() => xboxRuntimeLoopbackServer.validateSafePackageFamilyName('../../../etc')).toThrow();
    expect(() => xboxRuntimeLoopbackServer.validateSafePackageFamilyName('Pub..App_8wekyb3d8bbwe')).toThrow();
    expect(xboxRuntimeLoopbackServer.validateSafePackageFamilyName('SyntheticPub.App_8wekyb3d8bbwe')).toBe(
      'SyntheticPub.App_8wekyb3d8bbwe'
    );

    // Verify getCollectionsId & getPurchaseId attach an AbortSignal timeout
    const capturedSignals: Array<AbortSignal | null | undefined> = [];
    const b2cFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedSignals.push(init?.signal);
      return makeJsonResponse({ token: 'synthetic_b2c_token_001' });
    });
    const storeProvider = xboxRuntimeLoopbackServer.createXboxStoreRuntimeProvider({
      authProvider: {
        getStoreMsaToken: async () => 't=synthetic_msa',
      },
      gameMetadata: { storeId: '9N0000000001' },
      fetchImpl: b2cFetch,
    });

    expect(
      await storeProvider.getCollectionsId({ serviceTicket: 'svc_1', publisherUserId: 'pub_1' })
    ).toBe('synthetic_b2c_token_001');
    expect(
      await storeProvider.getPurchaseId({ serviceTicket: 'svc_2', publisherUserId: 'pub_2' })
    ).toBe('synthetic_b2c_token_001');
    expect(capturedSignals).toHaveLength(2);
    expect(capturedSignals[0]).toBeDefined();
    expect(capturedSignals[1]).toBeDefined();
  });

  it('rejects unauthenticated HTTP requests upon header arrival before reading body and evicts idle unauth sockets on slot exhaustion', async () => {
    const bottleUsersDir = makeTempDir('wave2c-loopback-users-');
    const srv = await xboxRuntimeLoopbackServer.startXboxRuntimeLoopbackServer({
      bottleUsersDir,
      maxConcurrentSockets: 2,
      enableCloudSaveSync: false,
      gameMetadata: {
        titleId: '19088743',
        scid: '00000000-0000-0000-0000-000001234567',
      },
    });

    const idleSockets: net.Socket[] = [];
    try {
      // 1. Send HTTP headers ONLY (declaring a 512 KB body that we never send) with invalid token -> immediate 401!
      const unauthHttpResp = await new Promise<string>((resolve, reject) => {
        const s = net.createConnection({ host: '127.0.0.1', port: srv.port }, () => {
          s.write(
            `POST /rpc HTTP/1.1\r\n` +
              `Host: 127.0.0.1:${srv.port}\r\n` +
              `X-One-Launcher-Token: ${'0'.repeat(64)}\r\n` +
              `Content-Type: application/json\r\n` +
              `Content-Length: 524288\r\n\r\n`
          );
        });
        let raw = '';
        s.on('data', (c) => {
          raw += c.toString('utf8');
        });
        s.on('close', () => resolve(raw));
        s.on('error', reject);
      });
      expect(unauthHttpResp).toContain('HTTP/1.1 401 Unauthorized');

      // 2. Browser Origin header is rejected with 403 Forbidden even with valid token
      const originHttpResp = await new Promise<string>((resolve, reject) => {
        const s = net.createConnection({ host: '127.0.0.1', port: srv.port }, () => {
          s.write(
            `POST /rpc HTTP/1.1\r\n` +
              `Host: 127.0.0.1:${srv.port}\r\n` +
              `Origin: https://evil.example\r\n` +
              `X-One-Launcher-Token: ${srv.sessionKey}\r\n` +
              `Content-Length: 2\r\n\r\n{}`
          );
        });
        let raw = '';
        s.on('data', (c) => {
          raw += c.toString('utf8');
        });
        s.on('close', () => resolve(raw));
        s.on('error', reject);
      });
      expect(originHttpResp).toContain('HTTP/1.1 403 Forbidden');

      // 3. Saturate maxConcurrentSockets (2) with idle unauthenticated TCP connections, then send a valid RPC!
      for (let i = 0; i < 2; i++) {
        const idle = net.createConnection({ host: '127.0.0.1', port: srv.port });
        idle.on('error', () => {});
        await new Promise<void>((res) => idle.once('connect', () => res()));
        idleSockets.push(idle);
      }

      const initRes = await sendBinaryLoopbackRpc(srv.port, {
        id: 1,
        key: srv.sessionKey,
        method: 'session.init',
        params: {
          titleId: '01234567',
          pfn: 'SyntheticPub.Title_8wekyb3d8bbwe',
        },
      });
      expect(initRes.closed).toBe(false);
      expect(initRes.response?.ok).toBe(true);
      expect(initRes.response?.result?.packageFamilyName).toBe('SyntheticPub.Title_8wekyb3d8bbwe');

      // Traversal PFN in session.init returns E_INVALIDARG (-2147024809)
      const badPfnRes = await sendBinaryLoopbackRpc(srv.port, {
        id: 2,
        key: srv.sessionKey,
        method: 'session.init',
        params: {
          pfn: '../../EscapeAttempt',
        },
      });
      expect(badPfnRes.response?.ok).toBe(false);
      expect(badPfnRes.response?.hr).toBe(-2147024809);
    } finally {
      for (const s of idleSockets) s.destroy();
      await srv.close();
    }
  });

  it('holds the TitleStorage session lock across xgamesave.init and xgamesave.submit_update autosaves, tracks real remainingQuotaBytes, and releases lock on server.close()', async () => {
    const bottleUsersDir = makeTempDir('wave2c-cloud-lock-');
    const scid = '00000000-0000-0000-0000-000001234567';
    const xuid = '2533274790000099';
    const pfn = 'SyntheticPub.CloudSaveTitle_8wekyb3d8bbwe';

    let lockAcquireCount = 0;
    let lockReleaseCount = 0;
    let lockReleaseUploadedFlag = '';
    let uploadedManifestCount = 0;
    const totalQuotaBytes = 64 * 1024 * 1024;

    // Spin up a local loopback mock TitleStorage server to also verify allowedLoopbackOrigin atom URI handling!
    const tsServer = http.createServer((req, res) => {
      const reqUrl = req.url || '/';
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.method === 'PUT' && reqUrl.includes('/lock')) {
          lockAcquireCount += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ quotaBytes: totalQuotaBytes, ownerChangeId: 'lock-001' }));
          return;
        }
        if (req.method === 'DELETE' && reqUrl.includes('/lock')) {
          lockReleaseCount += 1;
          lockReleaseUploadedFlag = reqUrl;
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method === 'GET' && reqUrl.includes('/blobs/') && !reqUrl.includes(',savedgame') && !reqUrl.includes(',binary')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ blobs: [], pagingInfo: { continuationToken: null } }));
          return;
        }
        if (req.method === 'PUT' && reqUrl.includes(',savedgame')) {
          uploadedManifestCount += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === 'PUT') {
          res.writeHead(201);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });

    await new Promise<void>((resolve) => tsServer.listen(0, '127.0.0.1', () => resolve()));
    const tsAddr = tsServer.address() as net.AddressInfo;
    const tsOrigin = `http://127.0.0.1:${tsAddr.port}`;

    const mockAuthProvider = {
      getUserProfile: async () => ({ xuid, gamertag: 'SynthSaver' }),
      getTokenAndSignatureForUrl: async () => ({
        authorization: 'XBL3.0 x=synth;tok',
        signature: 'AAAA',
      }),
    };

    const srv = await xboxRuntimeLoopbackServer.startXboxRuntimeLoopbackServer({
      bottleUsersDir,
      authProvider: mockAuthProvider,
      titleStorageOrigin: tsOrigin,
      enableCloudSaveSync: true,
      gameMetadata: {
        titleId: '19088743',
        scid,
        packageFamilyName: pfn,
      },
    });

    try {
      const initRpc = await sendBinaryLoopbackRpc(srv.port, {
        id: 10,
        key: srv.sessionKey,
        method: 'xgamesave.init',
        params: { xuid, scid, pfn },
      });
      expect(initRpc.response?.ok).toBe(true);
      expect(lockAcquireCount).toBe(1);
      expect(lockReleaseCount).toBe(0); // Lock kept held for session!

      // Stage a 4096-byte XGS save blob on disk and trigger two autosave commits
      const sysAppData = path.join(bottleUsersDir, 'Packages', pfn, 'SystemAppData');
      const { wgsUserDir, xgsUserDir } = xboxRuntimeLoopbackServer.resolveTitleSaveDirs(
        sysAppData,
        initRpc.response.result.hexXuidScid
      );
      const containerDir = path.join(xgsUserDir, 'SlotOne');
      fs.mkdirSync(containerDir, { recursive: true });
      const blobPayload = Buffer.alloc(4096, 0x42);
      fs.writeFileSync(path.join(containerDir, 'progress.dat'), blobPayload);
      await xboxTitleStorageSync.importXgsFolderIntoWgs(xgsUserDir, wgsUserDir);

      const commitRpc = await sendBinaryLoopbackRpc(srv.port, {
        id: 11,
        key: srv.sessionKey,
        method: 'xgamesave.submit_update',
        params: { xuid, scid, pfn, containerName: 'SlotOne', waitForCloud: true },
      });
      expect(commitRpc.response?.ok).toBe(true);
      expect(uploadedManifestCount).toBe(1);
      // Lock was REUSED — zero extra PUT /lock or DELETE /lock churn!
      expect(lockAcquireCount).toBe(1);
      expect(lockReleaseCount).toBe(0);
      expect(commitRpc.response?.result?.remainingQuotaBytes).toBe(totalQuotaBytes - 4096);

      const quotaRpc = await sendBinaryLoopbackRpc(srv.port, {
        id: 12,
        key: srv.sessionKey,
        method: 'xgamesave.remaining_quota',
        params: { xuid, scid },
      });
      expect(quotaRpc.response?.result?.remainingQuotaBytes).toBe(totalQuotaBytes - 4096);
    } finally {
      await srv.close();
      await new Promise<void>((resolve) => tsServer.close(() => resolve()));
    }

    // Closing the loopback server releases the held cloud lock cleanly with newSavesUploaded=true!
    expect(lockReleaseCount).toBe(1);
    expect(lockReleaseUploadedFlag).toContain('newSavesUploaded=true');
  });
});

// ============================================================================
// 7. [P1/P2] Xbox Auth Hot-Path, Steam Nested-Brace VDF, Preload & Storefront Polish (Findings #13, #15, #16, #17)
// ============================================================================

describe('Wave 2C Deliverable 7 — Xbox Auth Hot-Path, Steam Nested VDF, Preload Re-Verification & Storefront Polish', () => {
  it('caches ECDSA KeyObjects, deduplicates concurrent Xbox XSTS/DeviceToken requests, and isolates single-flight promises from individual caller AbortSignals', async () => {
    const proof = xboxAuthManager.generateXboxProofKeyPair();
    const k1 = xboxAuthManager.getCachedEcPrivateKeyObject(proof.privateKeyPem);
    const k2 = xboxAuthManager.getCachedEcPrivateKeyObject(proof.privateKeyPem);
    expect(k1).toBe(k2);

    // Caller AbortSignal isolation on shared promise
    let resolveShared!: (val: string) => void;
    const sharedPromise = new Promise<string>((res) => {
      resolveShared = res;
    });
    const abortCtrl = new AbortController();
    const abortedCaller = xboxAuthManager.racePromiseWithCallerSignal(sharedPromise, abortCtrl.signal);
    const healthyCaller = xboxAuthManager.racePromiseWithCallerSignal(sharedPromise, undefined);

    abortCtrl.abort();
    await expect(abortedCaller).rejects.toMatchObject({ name: 'AbortError' });
    resolveShared('shared-success-token');
    await expect(healthyCaller).resolves.toBe('shared-success-token');

    // Single-flight XSTS deduplication in createXboxAuthProvider
    const userDataDir = makeTempDir('wave2c-xbox-auth-sf-');
    const futureExpiry = new Date(Date.now() + 3600_000).toISOString();
    tokenVault.saveTokens(
      'xbox',
      {
        xuid: '2533274790000077',
        gamertag: 'SynthPilot',
        uhs: 'synthuhs',
        xblAccessToken: 'msa_valid_xbl_tok',
        msaExpiresAt: futureExpiry,
        xblUserToken: 'xasu_valid_user_tok',
        xblUserNotAfter: futureExpiry,
        xstsToken: 'xsts_base_tok',
        xstsExpiresOn: futureExpiry,
        proofKey: proof,
      },
      { userDataDir }
    );

    let xstsNetworkCount = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('xsts.auth.xboxlive.com/xsts/authorize')) {
        xstsNetworkCount += 1;
        await new Promise((r) => setTimeout(r, 25));
        return makeJsonResponse({
          Token: 'rp_xsts_deduped_token',
          NotAfter: futureExpiry,
          DisplayClaims: { xui: [{ uhs: 'synthuhs', xid: '2533274790000077', gtg: 'SynthPilot' }] },
        });
      }
      return makeJsonResponse({}, 404);
    });

    const provider = xboxAuthManager.createXboxAuthProvider({
      userDataDir,
      tokenVault,
      fetchImpl,
    });

    const c1Abort = new AbortController();
    const pA = provider.getXstsToken('https://synthetic-rp.xboxlive.com/', { signal: c1Abort.signal });
    const pB = provider.getXstsToken('https://synthetic-rp.xboxlive.com/');
    c1Abort.abort();

    await expect(pA).rejects.toMatchObject({ name: 'AbortError' });
    const resB = await pB;
    expect(resB.token).toBe('rp_xsts_deduped_token');
    expect(xstsNetworkCount).toBe(1);
  });

  it('parses Steam localconfig.vdf apps with nested cloud/autocloud blocks and preserves Math.max LastPlayed', async () => {
    const sampleVdf = `
"UserLocalConfigStore"
{
  "Software"
  {
    "Valve"
    {
      "Steam"
      {
        "apps"
        {
          "100010"
          {
            "cloud"
            {
              "last_sync_state"   "synchronized"
              "quota_nested"
              {
                "Playtime"        "999999"
              }
            }
            "Playtime"            "120"
            "PlaytimeDisconnected" "35"
            "autocloud"
            {
              "LastExit"          "1700000100"
            }
            "LastPlayed"          "1710000500"
          }
          "100020"
          {
            "Playtime"            "45"
            "LastPlayed"          "1705000000"
          }
        }
      }
    }
  }
}
`;
    const parsed = steamLocalScanner.parseLocalConfigPlaytime(sampleVdf);
    // Ignores nested quota_nested Playtime (depth > appDepth + 1) AND survives nested braces before LastPlayed!
    expect(parsed[100010]).toMatchObject({
      playtimeMinutes: 155,
      lastPlayedEpoch: 1710000500,
    });
    expect(parsed[100020]).toMatchObject({
      playtimeMinutes: 45,
      lastPlayedEpoch: 1705000000,
    });

    // Verify parseSteamGamesListJson takes Math.max(rtime_last_played, local LastPlayed)
    const steamRoot = makeTempDir('wave2c-steam-root-');
    const cfgDir = path.join(steamRoot, 'userdata', '1', 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'localconfig.vdf'), sampleVdf, 'utf8');

    const gamesListPayload = JSON.stringify({
      strProfileName: 'SyntheticSteamUser',
      rgGames: [
        {
          appid: 100010,
          name: 'Synthetic Cloud Adventure',
          playtime_forever: 100,
          rtime_last_played: 1700000000, // older than localconfig's 1710000500!
        },
      ],
    });

    const result = await steamLocalScanner.parseSteamGamesListJson(
      gamesListPayload,
      '76561197960265729', // Valve base constant 76561197960265728 + 1
      'SyntheticSteamUser',
      undefined,
      [],
      null,
      {
        userdataDirs: [path.join(steamRoot, 'userdata')],
        skipStoreBrowseEnrichment: true,
      }
    );

    expect(result.games).toHaveLength(1);
    expect(result.games[0].platforms[0].playtimeMinutes).toBe(155);
    expect(result.games[0].platforms[0].lastPlayed).toBe(
      new Date(1710000500 * 1000).toISOString()
    );
  });

  it('re-verifies trusted HTTPS top-frame host inside xboxAuthPreload notify() at call time', () => {
    const preloadPath = nodeRequire.resolve('../electron/xboxAuthPreload.cjs');
    const electronResolved = 'electron';
    const Module = nodeRequire('node:module');
    const origLoad = Module._load;

    let exposedApi: any = null;
    const sentPayloads: string[] = [];

    const origWin = (globalThis as any).window;
    const origLoc = (globalThis as any).location;
    const mutableLocation = {
      href: 'https://login.live.com/ppsecure/InlineLogin.srf?id=80597',
      protocol: 'https:',
      hostname: 'login.live.com',
      host: 'login.live.com',
      port: '',
      pathname: '/ppsecure/InlineLogin.srf',
    };
    const fakeTopWindow: Record<string, any> = {};
    fakeTopWindow.top = fakeTopWindow;

    try {
      Object.defineProperty(globalThis, 'window', {
        value: fakeTopWindow,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, 'location', {
        value: mutableLocation,
        configurable: true,
        writable: true,
      });

      Module._load = function (request: string, parent: unknown, isMain: boolean) {
        if (request === electronResolved) {
          return {
            contextBridge: {
              exposeInMainWorld: (_name: string, api: unknown) => {
                exposedApi = api;
              },
            },
            ipcRenderer: {
              send: (_channel: string, payload: string) => {
                sentPayloads.push(payload);
              },
            },
            webFrame: {
              executeJavaScript: async () => {},
            },
          };
        }
        return origLoad.call(this, request, parent, isMain);
      };

      delete nodeRequire.cache[preloadPath];
      nodeRequire(preloadPath);

      expect(exposedApi).toBeTruthy();
      exposedApi.notify('{"status":"ok"}');
      expect(sentPayloads).toEqual(['{"status":"ok"}']);

      // Mutate location to an untrusted host or non-default port -> notify() MUST block at call time!
      mutableLocation.href = 'https://untrusted.example.com/callback';
      mutableLocation.hostname = 'untrusted.example.com';
      mutableLocation.host = 'untrusted.example.com';
      exposedApi.notify('{"status":"spoofed"}');
      expect(sentPayloads).toHaveLength(1);

      mutableLocation.href = 'https://login.live.com:8443/InlineLogin.srf';
      mutableLocation.hostname = 'login.live.com';
      mutableLocation.host = 'login.live.com:8443';
      mutableLocation.port = '8443';
      exposedApi.notify('{"status":"bad_port"}');
      expect(sentPayloads).toHaveLength(1);
    } finally {
      Module._load = origLoad;
      delete nodeRequire.cache[preloadPath];
      Object.defineProperty(globalThis, 'window', {
        value: origWin,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, 'location', {
        value: origLoc,
        configurable: true,
        writable: true,
      });
    }
  });

  it('escalates interactive Epic auth recovery instead of coalescing onto a failing silent recovery flight, and guards GOG QWORD BigInt + batched .reg writes', async () => {
    const emptyHome = makeTempDir('wave2c-epic-recovery-home-');
    const origHome = process.env.HOME;
    process.env.HOME = emptyHome;

    try {
      let interactiveWindowCreatedCount = 0;
      const synthHexCode = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
      class FakeBrowserWindow {
        webContents: any;
        private listeners = new Map<string, Array<(...args: any[]) => void>>();
        private destroyed = false;
        private isInteractiveWindow: boolean;
        private currentUrl = '';
        constructor(opts?: { show?: boolean }) {
          this.isInteractiveWindow = Boolean(opts?.show);
          if (this.isInteractiveWindow) {
            interactiveWindowCreatedCount += 1;
          }
          const wcListeners = new Map<string, Array<(...args: any[]) => void>>();
          this.webContents = {
            setWindowOpenHandler: () => {},
            getURL: () => this.currentUrl,
            on: (ev: string, fn: (...args: any[]) => void) => {
              const arr = wcListeners.get(ev) || [];
              arr.push(fn);
              wcListeners.set(ev, arr);
            },
            executeJavaScript: async () => '',
          };
          setTimeout(() => {
            if (this.destroyed) return;
            if (!this.isInteractiveWindow) {
              // Silent background window lands on login page -> immediately resolves null
              this.currentUrl = 'https://www.epicgames.com/id/login';
              const finishHandlers = wcListeners.get('did-finish-load') || [];
              for (const h of finishHandlers) h();
              return;
            }
            // Interactive window redirects to authorized callback with 32-char hex authorization code
            const redirectUrl = `https://localhost/launcher/authorized?code=${synthHexCode}`;
            this.currentUrl = redirectUrl;
            const handlers = wcListeners.get('will-redirect') || [];
            for (const h of handlers) {
              h({ preventDefault: () => {} }, redirectUrl);
            }
          }, 15);
        }
        on(ev: string, fn: (...args: any[]) => void) {
          const arr = this.listeners.get(ev) || [];
          arr.push(fn);
          this.listeners.set(ev, arr);
        }
        loadURL(url: string) {
          this.currentUrl = url;
          return Promise.resolve();
        }
        isDestroyed() {
          return this.destroyed;
        }
        destroy() {
          this.destroyed = true;
        }
        close() {
          this.destroyed = true;
          const closed = this.listeners.get('closed') || [];
          for (const fn of closed) fn();
        }
      }

      const mockStoreSync = {
        loadSavedTokensAsync: async () => ({
          epic: {
            access_token: 'expired_tok',
            refresh_token: 'expired_ref',
            expires_at: new Date(Date.now() - 10_000).toISOString(),
          },
        }),
        renewEpicTokens: async () => {
          await new Promise((r) => setTimeout(r, 30));
          throw new Error('Silent refresh failed');
        },
        exchangeEpicCode: async (code: string) => ({
          access_token: `interactive_tok_for_${code}`,
          refresh_token: 'interactive_ref_001',
        }),
        saveTokensAsync: async () => {},
        destroyScraperWindowCleanly: (w: any) => w?.close?.(),
      };

      const recoverEpic = epicAuthRecoveryMod.createEpicAuthRecovery({
        BrowserWindow: FakeBrowserWindow,
        session: { fromPartition: () => ({}) },
        storeSync: mockStoreSync,
        launcherEngine: { isStoreDisconnectedTombstoned: () => false },
        isValidOAuthRedirectUrl: () => true,
      });

      // Start silent recovery first, then arrive with allowInteractive: true while silent is mid-flight!
      const silentPromise = recoverEpic({ allowInteractive: false });
      const interactivePromise = recoverEpic({ allowInteractive: true });

      const [silentRes, interactiveRes] = await Promise.all([silentPromise, interactivePromise]);
      expect(silentRes).toBeNull();
      expect(interactiveWindowCreatedCount).toBe(1);
      expect(interactiveRes?.access_token).toBe(`interactive_tok_for_${synthHexCode}`);
    } finally {
      process.env.HOME = origHome;
    }

    // GOG QWORD BigInt parser & batched raw Wine .reg writer
    expect(gogScriptInterpreter.parseSafeRegistryQwordBigInt(' 0x20 ')).toBe(32n);
    expect(gogScriptInterpreter.parseSafeRegistryQwordBigInt('64.0')).toBe(64n);
    expect(gogScriptInterpreter.parseSafeRegistryQwordBigInt('malformed-qword-value')).toBe(0n);
    expect(gogScriptInterpreter.parseSafeRegistryQwordBigInt('')).toBe(0n);

    const bottleDir = makeTempDir('wave2c-gog-reg-');
    const userRegPath = path.join(bottleDir, 'user.reg');
    fs.writeFileSync(userRegPath, 'WINE REGISTRY Version 2\n\n', 'utf8');
    const cjsFs = nodeRequire('node:fs');
    const renameSpy = vi.spyOn(cjsFs, 'renameSync');

    gogScriptInterpreter.patchRawWineRegistrySectionsBatch(
      userRegPath,
      [
        { subKeyPath: 'Software\\SyntheticStudio\\GameOne', valueName: 'InstallDir', rawRegRhs: '"C:\\\\Games\\\\One"' },
        { subKeyPath: 'Software\\SyntheticStudio\\GameOne', valueName: 'BinaryBlob', rawRegRhs: 'hex:01,02,03,04' },
        { subKeyPath: 'Software\\SyntheticStudio\\GameTwo', valueName: '@', rawRegRhs: '"DefaultVal"' },
      ],
      { skipLiveWineRegSync: true }
    );

    // Batched into a SINGLE atomic rename write on user.reg!
    expect(renameSpy).toHaveBeenCalledTimes(1);
    const regContent = fs.readFileSync(userRegPath, 'utf8');
    expect(regContent).toContain('[Software\\\\SyntheticStudio\\\\GameOne]');
    expect(regContent).toContain('"BinaryBlob"=hex:01,02,03,04');
    expect(regContent).toContain('[Software\\\\SyntheticStudio\\\\GameTwo]');

    // Consolidated xboxConfigAndIds helpers sanity check
    expect(xboxConfigAndIds.normalizeStoreImageUrl('//store-images.s-microsoft.com/img.png')).toBe(
      'https://store-images.s-microsoft.com/img.png'
    );
    expect(xboxConfigAndIds.makeCorrelationVector().endsWith('.0')).toBe(true);
  });
});
