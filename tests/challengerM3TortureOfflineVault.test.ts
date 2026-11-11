// @ts-check
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const offlineVaultIpc = require('../electron/ipc/offlineVaultIpcHandlers.cjs');
const offlineVaultMod = require('../electron/launcher/offlineVaultService.cjs');

describe('Milestone M3 Empirical Adversarial Torture — Offline Media & SQLite Resilience', () => {
  const sandboxes: string[] = [];

  function makeSandbox(prefix = 'ol-m3-torture-'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    sandboxes.push(dir);
    return dir;
  }

  afterEach(() => {
    while (sandboxes.length > 0) {
      const dir = sandboxes.pop();
      if (dir && fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  describe('Suite 1: handleOlMediaRequest — Range Request Torture & RFC 7233 Compliance', () => {
    const FILE_SIZE = 10000;
    let testFilePath: string;
    let fileBuffer: Buffer;

    beforeEach(() => {
      const sandbox = makeSandbox('ol-media-torture-');
      testFilePath = path.join(sandbox, 'synthetic_media_10k.bin');
      fileBuffer = Buffer.alloc(FILE_SIZE);
      for (let i = 0; i < FILE_SIZE; i++) {
        fileBuffer[i] = i % 256;
      }
      fs.writeFileSync(testFilePath, fileBuffer);
    });

    function createMockHandler(opts: { filePath?: string; sizeBytes?: number; mimeType?: string } = {}) {
      const resolvedPath = opts.filePath !== undefined ? opts.filePath : testFilePath;
      const resolvedSize = opts.sizeBytes !== undefined ? opts.sizeBytes : FILE_SIZE;
      const mockVault = {
        resolveMediaRequest: async () => ({
          kind: 'file',
          filePath: resolvedPath,
          mimeType: opts.mimeType || 'application/octet-stream',
          sizeBytes: resolvedSize,
          cacheControl: 'public, max-age=31536000, immutable',
        }),
      };

      return offlineVaultIpc.createOlMediaProtocolHandler({
        getOfflineVault: () => mockVault,
        dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      });
    }

    it('serves full 200 response with Accept-Ranges: bytes when no Range header is sent', async () => {
      const handler = createMockHandler();
      const res = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { 'sec-fetch-site': 'same-origin' },
        })
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Accept-Ranges')).toBe('bytes');
      expect(res.headers.get('Content-Length')).toBe(String(FILE_SIZE));
      expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
      expect(res.headers.get('Content-Range')).toBeNull();

      const body = Buffer.from(await res.arrayBuffer());
      expect(body.length).toBe(FILE_SIZE);
      expect(body.equals(fileBuffer)).toBe(true);
    });

    it('accurately streams exact single byte bounds: bytes=0-0 and bytes=9999-9999', async () => {
      const handler = createMockHandler();

      // First byte: 0-0
      const res0 = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { 'sec-fetch-site': 'same-origin', range: 'bytes=0-0' },
        })
      );
      expect(res0.status).toBe(206);
      expect(res0.headers.get('Content-Range')).toBe(`bytes 0-0/${FILE_SIZE}`);
      expect(res0.headers.get('Content-Length')).toBe('1');
      expect(res0.headers.get('Accept-Ranges')).toBe('bytes');
      const body0 = Buffer.from(await res0.arrayBuffer());
      expect(body0.length).toBe(1);
      expect(body0[0]).toBe(fileBuffer[0]);

      // Last byte: 9999-9999
      const resLast = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { 'sec-fetch-site': 'same-origin', range: 'bytes=9999-9999' },
        })
      );
      expect(resLast.status).toBe(206);
      expect(resLast.headers.get('Content-Range')).toBe(`bytes 9999-9999/${FILE_SIZE}`);
      expect(resLast.headers.get('Content-Length')).toBe('1');
      const bodyLast = Buffer.from(await resLast.arrayBuffer());
      expect(bodyLast.length).toBe(1);
      expect(bodyLast[0]).toBe(fileBuffer[9999]);
    });

    it('accurately streams interior byte slices: bytes=1234-5678 and bytes=500-500', async () => {
      const handler = createMockHandler();
      const res = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { 'sec-fetch-site': 'same-origin', range: 'bytes=1234-5678' },
        })
      );

      const expectedLen = 5678 - 1234 + 1;
      expect(res.status).toBe(206);
      expect(res.headers.get('Content-Range')).toBe(`bytes 1234-5678/${FILE_SIZE}`);
      expect(res.headers.get('Content-Length')).toBe(String(expectedLen));
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.length).toBe(expectedLen);
      expect(body.equals(fileBuffer.subarray(1234, 5679))).toBe(true);

      // Single interior byte
      const resSingle = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { 'sec-fetch-site': 'same-origin', range: 'bytes=500-500' },
        })
      );
      expect(resSingle.status).toBe(206);
      expect(resSingle.headers.get('Content-Range')).toBe(`bytes 500-500/${FILE_SIZE}`);
      expect(resSingle.headers.get('Content-Length')).toBe('1');
      const singleBody = Buffer.from(await resSingle.arrayBuffer());
      expect(singleBody[0]).toBe(fileBuffer[500]);
    });

    it('handles open-ended byte ranges: bytes=9500- and bytes=0-', async () => {
      const handler = createMockHandler();

      // bytes=9500-
      const res9500 = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { 'sec-fetch-site': 'same-origin', range: 'bytes=9500-' },
        })
      );
      expect(res9500.status).toBe(206);
      expect(res9500.headers.get('Content-Range')).toBe(`bytes 9500-9999/${FILE_SIZE}`);
      expect(res9500.headers.get('Content-Length')).toBe('500');
      const body9500 = Buffer.from(await res9500.arrayBuffer());
      expect(body9500.length).toBe(500);
      expect(body9500.equals(fileBuffer.subarray(9500))).toBe(true);

      // bytes=0- (open-ended starting from 0)
      const res0 = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { 'sec-fetch-site': 'same-origin', range: 'bytes=0-' },
        })
      );
      expect(res0.status).toBe(206);
      expect(res0.headers.get('Content-Range')).toBe(`bytes 0-9999/${FILE_SIZE}`);
      expect(res0.headers.get('Content-Length')).toBe(String(FILE_SIZE));
      const body0 = Buffer.from(await res0.arrayBuffer());
      expect(body0.length).toBe(FILE_SIZE);
      expect(body0.equals(fileBuffer)).toBe(true);
    });

    it('handles suffix byte ranges: bytes=-1, bytes=-50, and suffix overshoot bytes=-50000', async () => {
      const handler = createMockHandler();

      // bytes=-1 (last 1 byte)
      const res1 = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { 'sec-fetch-site': 'same-origin', range: 'bytes=-1' },
        })
      );
      expect(res1.status).toBe(206);
      expect(res1.headers.get('Content-Range')).toBe(`bytes 9999-9999/${FILE_SIZE}`);
      expect(res1.headers.get('Content-Length')).toBe('1');
      const body1 = Buffer.from(await res1.arrayBuffer());
      expect(body1.length).toBe(1);
      expect(body1[0]).toBe(fileBuffer[9999]);

      // bytes=-50 (last 50 bytes)
      const res50 = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { 'sec-fetch-site': 'same-origin', range: 'bytes=-50' },
        })
      );
      expect(res50.status).toBe(206);
      expect(res50.headers.get('Content-Range')).toBe(`bytes 9950-9999/${FILE_SIZE}`);
      expect(res50.headers.get('Content-Length')).toBe('50');
      const body50 = Buffer.from(await res50.arrayBuffer());
      expect(body50.length).toBe(50);
      expect(body50.equals(fileBuffer.subarray(9950))).toBe(true);

      // RFC 7233 §2.1: Suffix length > file size returns the entire representation
      const resOver = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { 'sec-fetch-site': 'same-origin', range: 'bytes=-50000' },
        })
      );
      expect(resOver.status).toBe(206);
      expect(resOver.headers.get('Content-Range')).toBe(`bytes 0-9999/${FILE_SIZE}`);
      expect(resOver.headers.get('Content-Length')).toBe(String(FILE_SIZE));
      const bodyOver = Buffer.from(await resOver.arrayBuffer());
      expect(bodyOver.length).toBe(FILE_SIZE);
      expect(bodyOver.equals(fileBuffer)).toBe(true);
    });

    it('clamps end offset when end exceeds file length (RFC 7233 §2.1): bytes=5000-999999 and bytes=0-9999999999', async () => {
      const handler = createMockHandler();
      const res = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { 'sec-fetch-site': 'same-origin', range: 'bytes=5000-999999' },
        })
      );

      expect(res.status).toBe(206);
      expect(res.headers.get('Content-Range')).toBe(`bytes 5000-9999/${FILE_SIZE}`);
      expect(res.headers.get('Content-Length')).toBe('5000');
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.length).toBe(5000);
      expect(body.equals(fileBuffer.subarray(5000))).toBe(true);

      // Huge upper bound clamped to totalSize - 1
      const resHuge = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { 'sec-fetch-site': 'same-origin', range: 'bytes=0-9999999999' },
        })
      );
      expect(resHuge.status).toBe(206);
      expect(resHuge.headers.get('Content-Range')).toBe(`bytes 0-9999/${FILE_SIZE}`);
      expect(resHuge.headers.get('Content-Length')).toBe(String(FILE_SIZE));
    });

    it('returns HTTP 416 Range Not Satisfiable for out-of-bounds, inverted, and zero suffix ranges', async () => {
      const handler = createMockHandler();

      const invalidRanges = [
        'bytes=10000-10005', // start >= totalSize
        'bytes=10000-',      // open-ended start >= totalSize
        'bytes=999999-1000000', // far out of bounds
        'bytes=50-20',       // inverted: start > end
        'bytes=9000-1000',   // inverted: start > end
        'bytes=-0',          // zero suffix
      ];

      for (const range of invalidRanges) {
        const res = await handler(
          new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
            headers: { 'sec-fetch-site': 'same-origin', range },
          })
        );

        expect(res.status, `Range '${range}' should return 416`).toBe(416);
        expect(res.headers.get('Content-Range')).toBe(`bytes */${FILE_SIZE}`);
        expect(res.headers.get('Accept-Ranges')).toBe('bytes');
        expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
      }
    });

    it('ignores syntactically malformed and multi-part range headers per RFC 7233 §3.1, serving full HTTP 200', async () => {
      const handler = createMockHandler();

      const malformedRanges = [
        'bytes=abc-def',         // non-numeric
        'bytes=123',             // missing hyphen
        'items=0-10',            // invalid unit
        'bytes=0-10, 20-30',     // multi-range
        'bytes=--10',            // double hyphen
        'bytes=0 - 10',          // space around hyphen
        'bytes=xyz',             // invalid letters
        'bytes=10-20-30',        // multiple hyphens
      ];

      for (const range of malformedRanges) {
        const res = await handler(
          new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
            headers: { 'sec-fetch-site': 'same-origin', range },
          })
        );

        expect(res.status, `Malformed range '${range}' should fall back to 200`).toBe(200);
        expect(res.headers.get('Content-Length')).toBe(String(FILE_SIZE));
        expect(res.headers.get('Accept-Ranges')).toBe('bytes');
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.length).toBe(FILE_SIZE);
      }

      // Also test non-ASCII in mock request object
      const mockRes = await handler({
        url: 'ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin',
        headers: {
          'sec-fetch-site': 'same-origin',
          range: 'bytes=\uFF11\uFF10-\uFF12\uFF10',
        },
      });
      expect(mockRes.status).toBe(200);
      expect(mockRes.headers.get('Content-Length')).toBe(String(FILE_SIZE));
    });

    it('handles zero-byte file without crashing or throwing exceptions', async () => {
      const sandbox = makeSandbox('ol-zero-byte-');
      const emptyFile = path.join(sandbox, 'empty.bin');
      fs.writeFileSync(emptyFile, Buffer.alloc(0));

      const handler = createMockHandler({ filePath: emptyFile, sizeBytes: 0 });

      // Normal request on zero-byte file
      const resFull = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fempty.bin', {
          headers: { 'sec-fetch-site': 'same-origin' },
        })
      );
      expect(resFull.status).toBe(200);
      const fullBuf = Buffer.from(await resFull.arrayBuffer());
      expect(fullBuf.length).toBe(0);

      // Range request on zero-byte file
      const resRange = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fempty.bin', {
          headers: { 'sec-fetch-site': 'same-origin', range: 'bytes=0-10' },
        })
      );
      expect([200, 416]).toContain(resRange.status);
    });

    it('enforces origin isolation and CORP headers against untrusted callers', async () => {
      const handler = createMockHandler();

      // Untrusted sec-fetch-site: cross-site -> 403
      const crossSiteRes = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { 'sec-fetch-site': 'cross-site' },
        })
      );
      expect(crossSiteRes.status).toBe(403);
      expect(crossSiteRes.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');

      // Untrusted remote origin -> 403
      const evilOriginRes = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { origin: 'https://evil-attacker.example.com' },
        })
      );
      expect(evilOriginRes.status).toBe(403);

      // Untrusted LAN IP origin -> 403
      const lanOriginRes = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { origin: 'http://192.168.1.150:8080' },
        })
      );
      expect(lanOriginRes.status).toBe(403);

      // Trusted localhost -> 200
      const localRes = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { origin: 'http://localhost:5173' },
        })
      );
      expect(localRes.status).toBe(200);

      // Trusted 127.0.0.1 -> 200
      const loopbackRes = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { origin: 'http://127.0.0.1:5173' },
        })
      );
      expect(loopbackRes.status).toBe(200);

      // Trusted IPv6 loopback -> 200
      const ipv6Res = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { origin: 'http://[::1]:5173' },
        })
      );
      expect(ipv6Res.status).toBe(200);

      // Invalid protocol scheme -> 400
      const badProtoRes = await handler(
        new Request('http://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { 'sec-fetch-site': 'same-origin' },
        })
      );
      expect(badProtoRes.status).toBe(400);
      expect(badProtoRes.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    });

    it('honors AbortSignal and cancels active streams with status 499', async () => {
      const handler = createMockHandler();
      const controller = new AbortController();
      controller.abort();

      const res = await handler(
        new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
          headers: { 'sec-fetch-site': 'same-origin' },
          signal: controller.signal,
        })
      );
      expect(res.status).toBe(499);
      expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    });

    it('survives a barrage of 50 concurrent mixed range requests without stream corruption', async () => {
      const handler = createMockHandler();

      const tasks = Array.from({ length: 50 }, async (_, idx) => {
        const start = (idx * 170) % 8000;
        const end = start + 500;
        const res = await handler(
          new Request('ol-media://asset?url=https%3A%2F%2Fcdn.example.test%2Fmedia.bin', {
            headers: {
              'sec-fetch-site': 'same-origin',
              range: `bytes=${start}-${end}`,
            },
          })
        );

        expect(res.status).toBe(206);
        expect(res.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/${FILE_SIZE}`);
        const chunk = Buffer.from(await res.arrayBuffer());
        expect(chunk.length).toBe(end - start + 1);
        expect(chunk.equals(fileBuffer.subarray(start, end + 1))).toBe(true);
      });

      await Promise.all(tasks);
    });
  });

  describe('Suite 2: OfflineVaultService — SQLite Power-Loss Corruption & WAL Concurrency Torture', () => {
    it('self-heals from random power-loss header corruption, backs up damaged file, and re-initializes pristine schema', () => {
      const sandbox = makeSandbox('vault-corrupt-header-');
      const vaultDir = path.join(sandbox, 'offline-vault');
      fs.mkdirSync(vaultDir, { recursive: true });
      const dbPath = path.join(vaultDir, 'catalog_metadata.sqlite');

      // 1. Write garbage header
      const garbageBytes = crypto.randomBytes(512);
      fs.writeFileSync(dbPath, garbageBytes);

      const vault = new offlineVaultMod.OfflineVaultService({ userDataDir: sandbox });

      // 2. ensureOpen() must detect the corruption, backup, and recreate
      const db = vault.ensureOpen();
      expect(db).toBeDefined();

      // Verify backup exists with original garbage content
      const corruptFiles = fs.readdirSync(vaultDir).filter((f) => f.includes('.corrupt.'));
      expect(corruptFiles.length).toBe(1);
      const backupContent = fs.readFileSync(path.join(vaultDir, corruptFiles[0]));
      expect(backupContent.equals(garbageBytes)).toBe(true);

      // Verify new database is fully operational
      const row = db.prepare("SELECT value FROM vault_settings WHERE key = 'tier'").get();
      expect(row?.value).toBe('balanced');

      // Verify tables can be written to
      vault.upsertGames([
        {
          id: 'test-game-1',
          title: 'Resilience Test Game',
          isInstalled: true,
          platforms: [{ platformId: 'win32', installed: true }],
        },
      ]);
      const check = db.prepare('SELECT canonical_title FROM vault_games WHERE game_id = ?').get('test-game-1');
      expect(check?.canonical_title).toBe('Resilience Test Game');

      vault.shutdown();
    });

    it('self-heals when SQLite database file is zero-length (simulating interrupted file creation/power loss)', () => {
      const sandbox = makeSandbox('vault-zero-byte-');
      const vaultDir = path.join(sandbox, 'offline-vault');
      fs.mkdirSync(vaultDir, { recursive: true });
      const dbPath = path.join(vaultDir, 'catalog_metadata.sqlite');

      // Truncate to 0 bytes
      fs.writeFileSync(dbPath, Buffer.alloc(0));

      const vault = new offlineVaultMod.OfflineVaultService({ userDataDir: sandbox });
      const db = vault.ensureOpen();
      expect(db).toBeDefined();

      // Ensure queries work without error
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const tableNames = tables.map((t: any) => t.name);
      expect(tableNames).toContain('vault_games');
      expect(tableNames).toContain('vault_settings');
      expect(tableNames).toContain('media_blobs');
      expect(tableNames).toContain('game_media_assets');

      vault.shutdown();
    });

    it('self-heals mid-file truncated b-tree pages and cleans up orphaned -wal and -shm files', () => {
      const sandbox = makeSandbox('vault-wal-shm-orphan-');
      const vaultDir = path.join(sandbox, 'offline-vault');
      const dbPath = path.join(vaultDir, 'catalog_metadata.sqlite');

      // Step A: Create a valid database with data
      const vault1 = new offlineVaultMod.OfflineVaultService({ userDataDir: sandbox });
      vault1.ensureOpen();
      vault1.upsertGames([
        { id: 'game-a', title: 'Alpha', isInstalled: true },
        { id: 'game-b', title: 'Beta', isInstalled: false },
      ]);
      vault1.shutdown();

      // Step B: Truncate file halfway and plant orphan -wal and -shm files with distinctive markers
      const fullSize = fs.statSync(dbPath).size;
      expect(fullSize).toBeGreaterThan(1024);
      // Truncate to 512 bytes (invalid page size boundary)
      const fd = fs.openSync(dbPath, 'r+');
      fs.ftruncateSync(fd, 512);
      fs.closeSync(fd);

      const orphanWalMarker = 'ORPHAN_WAL_CORRUPT_BYTES_XYZ_12345';
      const orphanShmMarker = 'ORPHAN_SHM_CORRUPT_BYTES_XYZ_12345';
      fs.writeFileSync(`${dbPath}-wal`, orphanWalMarker);
      fs.writeFileSync(`${dbPath}-shm`, orphanShmMarker);

      // Step C: Open again — must self-heal, remove sidecars, and create fresh functional database
      const vault2 = new offlineVaultMod.OfflineVaultService({ userDataDir: sandbox });
      const db = vault2.ensureOpen();
      expect(db).toBeDefined();

      // Verify that the corrupt backup was created
      const corruptFiles = fs.readdirSync(vaultDir).filter((f) => f.includes('.corrupt.'));
      expect(corruptFiles.length).toBe(1);

      // Verify that the orphan WAL marker was purged (any existing WAL is a fresh SQLite WAL header, not the corrupt orphan)
      if (fs.existsSync(`${dbPath}-wal`)) {
        const walContent = fs.readFileSync(`${dbPath}-wal`);
        expect(walContent.includes(Buffer.from(orphanWalMarker))).toBe(false);
      }
      if (fs.existsSync(`${dbPath}-shm`)) {
        const shmContent = fs.readFileSync(`${dbPath}-shm`);
        expect(shmContent.includes(Buffer.from(orphanShmMarker))).toBe(false);
      }

      // Verify fresh functional operations
      vault2.upsertGames([{ id: 'fresh-1', title: 'Post-Healing Game', isInstalled: true }]);
      const snapshot = vault2.getCatalogSnapshot();
      expect(snapshot.success).toBe(true);
      expect(snapshot.games.length).toBe(1);
      expect(snapshot.games[0].id).toBe('fresh-1');

      vault2.shutdown();
    });

    it('survives sequential corruption cycles preserving historical .corrupt logs', async () => {
      const sandbox = makeSandbox('vault-seq-corrupt-');
      const vaultDir = path.join(sandbox, 'offline-vault');
      const dbPath = path.join(vaultDir, 'catalog_metadata.sqlite');

      for (let cycle = 1; cycle <= 3; cycle++) {
        // Corrupt file
        fs.mkdirSync(vaultDir, { recursive: true });
        fs.writeFileSync(dbPath, `CORRUPT_CYCLE_${cycle}_` + crypto.randomBytes(64).toString('hex'));

        // Delay 15ms so Date.now() timestamp advances
        await new Promise((r) => setTimeout(r, 15));

        const vault = new offlineVaultMod.OfflineVaultService({ userDataDir: sandbox });
        const db = vault.ensureOpen();
        expect(db).toBeDefined();
        vault.upsertGames([{ id: `cycle-game-${cycle}`, title: `Cycle Game ${cycle}` }]);
        vault.shutdown();
      }

      const corruptFiles = fs.readdirSync(vaultDir).filter((f) => f.includes('.corrupt.'));
      expect(corruptFiles.length).toBe(3);
    });

    it('executes atomic batch launcher utility purges during getCatalogSnapshot() across hundreds of rows without SQLITE_BUSY', () => {
      const sandbox = makeSandbox('vault-batch-purge-');
      const vault = new offlineVaultMod.OfflineVaultService({ userDataDir: sandbox });
      const db = vault.ensureOpen();

      // Seed 50 legitimate games and 50 standalone launcher utilities
      const totalLegit = 50;
      const totalUtils = 50;

      const legitGames = [];
      for (let i = 1; i <= totalLegit; i++) {
        legitGames.push({
          id: `legit-game-${i}`,
          title: `Action Adventure ${i}`,
          isInstalled: i % 2 === 0,
          platforms: [{ platformId: 'win32', installed: i % 2 === 0 }],
        });
      }
      vault.upsertGames(legitGames);

      // Insert 50 uninstalled standalone launcher utilities matching STANDALONE_LAUNCHER_UTILITY_TITLE_RE
      const insertUtilStmt = db.prepare(
        'INSERT INTO vault_games (game_id, canonical_title, is_installed, platforms_json, summary_json) VALUES (?, ?, 0, ?, ?)'
      );
      const insertAssetStmt = db.prepare(
        'INSERT INTO game_media_assets (url_key, game_id, asset_role, ordinal, source_url) VALUES (?, ?, ?, ?, ?)'
      );

      const utilityTitles = ['EA App', 'Ubisoft Connect', 'Battle.net'];

      for (let i = 1; i <= totalUtils; i++) {
        const utilId = `launcher-util-${i}`;
        const utilTitle = utilityTitles[i % utilityTitles.length];
        insertUtilStmt.run(
          utilId,
          utilTitle,
          JSON.stringify([{ platformId: 'ea', installed: false }]),
          JSON.stringify({ id: utilId, title: utilTitle })
        );
        insertAssetStmt.run(`asset-${utilId}-cover`, utilId, 'cover', 0, `https://cdn.example.test/${utilId}.jpg`);
      }

      // Pre-check count
      const preGamesCount = db.prepare('SELECT COUNT(*) as cnt FROM vault_games').get().cnt;
      const preAssetsCount = db.prepare('SELECT COUNT(*) as cnt FROM game_media_assets').get().cnt;
      expect(preGamesCount).toBe(totalLegit + totalUtils);
      expect(preAssetsCount).toBe(totalUtils);

      // Call getCatalogSnapshot() — should batch purge all 50 utilities in a single transaction
      const snapshot = vault.getCatalogSnapshot();
      expect(snapshot.success).toBe(true);
      expect(snapshot.games.length).toBe(totalLegit);

      // Verify database state: utilities purged from both vault_games and game_media_assets
      const postGamesCount = db.prepare('SELECT COUNT(*) as cnt FROM vault_games').get().cnt;
      const postAssetsCount = db.prepare('SELECT COUNT(*) as cnt FROM game_media_assets').get().cnt;
      expect(postGamesCount).toBe(totalLegit);
      expect(postAssetsCount).toBe(0);

      vault.shutdown();
    });

    it('handles heavy concurrent reads and snapshot calls in WAL mode without lock starvation', async () => {
      const sandbox = makeSandbox('vault-wal-concurrency-');
      const vault = new offlineVaultMod.OfflineVaultService({ userDataDir: sandbox });
      const db = vault.ensureOpen();

      // Seed baseline database
      vault.upsertGames([
        { id: 'game-1', title: 'Cyber Adventure', isInstalled: true },
        { id: 'game-2', title: 'Space Odyssey', isInstalled: false },
        { id: 'game-3', title: 'Medieval Tactics', isInstalled: true },
      ]);

      // Verify WAL mode is active
      const journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode;
      expect(String(journalMode).toLowerCase()).toBe('wal');

      // Concurrently execute 30 read snapshots while 10 write tasks are running
      const readTasks = Array.from({ length: 30 }, async (_, idx) => {
        const snap = vault.getCatalogSnapshot();
        expect(snap.success).toBe(true);
        expect(snap.games.length).toBeGreaterThanOrEqual(3);
        return snap.games.length;
      });

      const writeTasks = Array.from({ length: 10 }, async (_, idx) => {
        vault.upsertGames([
          { id: `concurrent-game-${idx}`, title: `Concurrent Game ${idx}`, isInstalled: true },
        ]);
        return idx;
      });

      // Run all simultaneously
      const results = await Promise.all([...readTasks, ...writeTasks]);
      expect(results.length).toBe(40);

      // Final snapshot should contain 3 baseline + 10 written games = 13
      const finalSnap = vault.getCatalogSnapshot();
      expect(finalSnap.games.length).toBe(13);

      vault.shutdown();
    });

    it('respects readOnly snapshot mode without performing mutating deletes or acquiring write locks', () => {
      const sandbox = makeSandbox('vault-readonly-');
      const vault = new offlineVaultMod.OfflineVaultService({ userDataDir: sandbox });
      const db = vault.ensureOpen();

      // Seed 1 normal game and 1 utility
      vault.upsertGames([{ id: 'real-1', title: 'Normal Game', isInstalled: true }]);
      db.prepare(
        'INSERT INTO vault_games (game_id, canonical_title, is_installed, platforms_json, summary_json) VALUES (?, ?, 0, ?, ?)'
      ).run(
        'util-1',
        'EA App',
        JSON.stringify([{ platformId: 'ea', installed: false }]),
        JSON.stringify({ id: 'util-1', title: 'EA App' })
      );

      // Call getCatalogSnapshot with readOnly: true
      const snap = vault.getCatalogSnapshot({ readOnly: true });
      expect(snap.success).toBe(true);
      // Utility is excluded from snapshot games
      expect(snap.games.some((g: any) => g.id === 'real-1')).toBe(true);
      expect(snap.games.some((g: any) => g.id === 'util-1')).toBe(false);

      // But utility is NOT purged from database because of readOnly: true
      const row = db.prepare('SELECT game_id FROM vault_games WHERE game_id = ?').get('util-1');
      expect(row?.game_id).toBe('util-1');

      vault.shutdown();
    });
  });
});
