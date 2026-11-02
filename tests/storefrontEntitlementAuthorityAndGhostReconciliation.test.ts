import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import axios from 'axios';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite');

// ============================================================================
// Hoisted Headless Browser & IndexedDB Polyfills (Hermetic Node Test Harness)
// ============================================================================
const hoisted = vi.hoisted(() => {
  const idbStore = new Map<string, unknown>();
  const lsStore = new Map<string, string>();
  const eventTarget = new EventTarget();

  if (typeof globalThis.CustomEvent === 'undefined') {
    class PolyfillCustomEvent<T = unknown> extends Event {
      readonly detail: T;
      constructor(type: string, params?: CustomEventInit<T>) {
        super(type, params);
        this.detail = (params?.detail ?? null) as T;
      }
    }
    (globalThis as Record<string, unknown>).CustomEvent = PolyfillCustomEvent;
  }

  const localStorageMock: Storage = {
    get length() {
      return lsStore.size;
    },
    clear() {
      lsStore.clear();
    },
    getItem(key: string) {
      return lsStore.has(key) ? lsStore.get(key)! : null;
    },
    key(index: number) {
      return Array.from(lsStore.keys())[index] ?? null;
    },
    removeItem(key: string) {
      lsStore.delete(key);
    },
    setItem(key: string, value: string) {
      lsStore.set(key, String(value));
    },
  };

  const windowShim: Record<string, unknown> = {
    localStorage: localStorageMock,
    location: { origin: 'http://localhost:5173', protocol: 'http:' },
    screenX: 0,
    screenY: 0,
    outerWidth: 1280,
    outerHeight: 800,
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };

  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageMock,
    configurable: true,
    writable: true,
  });

  Object.defineProperty(globalThis, 'indexedDB', {
    value: {},
    configurable: true,
    writable: true,
  });

  if (typeof (globalThis as Record<string, unknown>).window === 'undefined') {
    Object.defineProperty(globalThis, 'window', {
      value: windowShim,
      configurable: true,
      writable: true,
    });
  } else {
    Object.assign((globalThis as unknown as { window: Record<string, unknown> }).window, windowShim);
  }

  return { idbStore, lsStore, windowShim };
});

vi.mock('idb-keyval', () => ({
  createStore: vi.fn(() => 'mock-vault-store'),
  get: vi.fn(async (key: string) => {
    const val = hoisted.idbStore.get(key);
    return val === undefined ? undefined : structuredClone(val);
  }),
  set: vi.fn(async (key: string, val: unknown) => {
    hoisted.idbStore.set(key, structuredClone(val));
  }),
  del: vi.fn(async (key: string) => {
    hoisted.idbStore.delete(key);
  }),
  clear: vi.fn(async () => {
    hoisted.idbStore.clear();
  }),
  keys: vi.fn(async () => Array.from(hoisted.idbStore.keys())),
}));

import type { CanonicalGame } from '../src/contracts/game';
import type { EnvironmentHealthSnapshot } from '../src/contracts/environmentSetup';
import {
  STORAGE_KEY_VERIFIED_ENTITLEMENTS,
  clearIntegrationStorage,
  flushPendingCatalogSave,
  getVerifiedUserEntitlements,
  hydrateCatalogFromIndexedDb,
  loadCurrentCatalog,
  loadIntegrations,
  mergeStorefrontGames,
  recordVerifiedUserEntitlements,
  saveCurrentCatalog,
  saveIntegrations,
} from '../src/services/integrations/integrationStorage';

const IDB_KEY_MAIN_CATALOG = 'idb_universal_game_library_catalog_v2';
import { clearSuppressedCatalogEntries } from '../src/services/integrations/catalogSanitizer';
import { EpicIntegrationService } from '../src/services/integrations/epicIntegration';
import { GogIntegrationService } from '../src/services/integrations/gogIntegration';
import { IntegrationsModal } from '../src/components/Navigation/IntegrationsModal';
import { StorefrontAccountsStep } from '../src/components/Launcher/SystemSetupWizard/steps/StorefrontAccountsStep';
import { environmentSetupService } from '../src/services/launcher/environmentSetupService';
import { createDomain12DeepRenderer } from './helpers/xboxTestHarness';
import { scanContentForPiiViolations } from './helpers/piiHygieneGuard';

const storeSync = nodeRequire('../electron/storeSync.cjs');
const federator = nodeRequire('../electron/launcher/storefrontLocalCacheFederator.cjs');
const { registerStoreSyncIpcHandlers } = nodeRequire('../electron/ipc/storeSyncIpcHandlers.cjs');

// ============================================================================
// Synthetic PII-Free Test Fixtures & Helpers
// ============================================================================
const SYNTHETIC_GOG_USER_ID = '100000001';
const SYNTHETIC_GOG_USERNAME = 'synthetic_gog_user_1';
const SYNTHETIC_GOG_OTHER_USER_ID = 'different_user_999';
const SYNTHETIC_EPIC_ACCOUNT_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SYNTHETIC_EPIC_MISMATCH_ID = 'fedcba9876543210fedcba9876543210';

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

function makeTempDir(prefix = 'ol-entitlement-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDirs(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore transient cleanup race
      }
    }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  const serialized = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => JSON.parse(serialized),
    text: async () => serialized,
  } as unknown as Response;
}

function createSyntheticGalaxyDb(
  gogRootDir: string,
  seedOptions: { includeStandardFixtures?: boolean } = { includeStandardFixtures: true }
): string {
  const storageDir = path.join(gogRootDir, 'storage');
  fs.mkdirSync(storageDir, { recursive: true });
  const dbPath = path.join(storageDir, 'galaxy-2.0.db');

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE LimitedDetails (
        productId INTEGER PRIMARY KEY,
        title TEXT,
        images TEXT,
        is_production INTEGER DEFAULT 1
      );
      CREATE TABLE GamePieceTypes (
        id INTEGER PRIMARY KEY,
        type TEXT NOT NULL
      );
      CREATE TABLE GamePieces (
        releaseKey TEXT NOT NULL,
        gamePieceTypeId INTEGER NOT NULL,
        userId TEXT,
        value TEXT NOT NULL
      );
      CREATE TABLE LibraryReleases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT NOT NULL,
        releaseKey TEXT NOT NULL
      );
      CREATE TABLE ReleaseProperties (
        releaseKey TEXT PRIMARY KEY,
        isDlc INTEGER DEFAULT 0,
        isVisibleInLibrary INTEGER DEFAULT 1,
        gameId TEXT
      );
    `);

    db.exec(`
      INSERT INTO GamePieceTypes (id, type) VALUES
        (1, 'title'),
        (2, 'summary'),
        (3, 'originalImages'),
        (4, 'meta');
    `);

    if (seedOptions.includeStandardFixtures !== false) {
      const insertLimited = db.prepare(
        'INSERT INTO LimitedDetails (productId, title, images, is_production) VALUES (?, ?, ?, 1)'
      );
      const insertPiece = db.prepare(
        'INSERT INTO GamePieces (releaseKey, gamePieceTypeId, userId, value) VALUES (?, ?, ?, ?)'
      );
      const insertLibRelease = db.prepare(
        'INSERT INTO LibraryReleases (userId, releaseKey) VALUES (?, ?)'
      );
      const insertProps = db.prepare(
        'INSERT INTO ReleaseProperties (releaseKey, isDlc, isVisibleInLibrary, gameId) VALUES (?, ?, ?, ?)'
      );

      const seedProductPieces = (
        gogId: string,
        title: string,
        summary: string,
        isDlcFlag = false
      ) => {
        const rk = `gog_${gogId}`;
        insertLimited.run(
          Number(gogId),
          title,
          JSON.stringify({ logo2x: `https://images.gog-statics.com/syn_${gogId}_logo.jpg` })
        );
        insertPiece.run(rk, 1, 'synthetic_user_1', JSON.stringify({ title }));
        insertPiece.run(rk, 2, 'synthetic_user_1', JSON.stringify({ summary }));
        insertPiece.run(
          rk,
          3,
          'synthetic_user_1',
          JSON.stringify({
            verticalCover: `https://images.gog-statics.com/syn_${gogId}_cover.webp`,
            background: `https://images.gog-statics.com/syn_${gogId}_bg.webp`,
          })
        );
        insertPiece.run(
          rk,
          4,
          'synthetic_user_1',
          JSON.stringify({
            releaseDate: 1704067200,
            developers: ['Synthetic Studio'],
            publishers: ['Synthetic Publisher'],
            genres: ['RPG'],
            isDlc: isDlcFlag,
          })
        );
      };

      // 1001: Visible owned base game
      seedProductPieces('1001', 'Synthetic RPG', 'Visible owned synthetic base game synopsis.');
      insertLibRelease.run('synthetic_user_1', 'gog_1001');
      insertProps.run('gog_1001', 0, 1, '1001');

      // 1002: Hidden grant wrapper (isVisibleInLibrary = 0, isDlc = 0)
      seedProductPieces(
        '1002',
        'Synthetic Adventure - Prime Edition',
        'Hidden wrapper synopsis used for per-ID metadata enrichment.'
      );
      insertLibRelease.run('synthetic_user_1', 'gog_1002');
      insertProps.run('gog_1002', 0, 0, '1002');

      // 1003: DLC (isVisibleInLibrary = 1, isDlc = 1)
      seedProductPieces('1003', 'Synthetic RPG Expansion Pass', 'Synthetic DLC pack.', true);
      insertLibRelease.run('synthetic_user_1', 'gog_1003');
      insertProps.run('gog_1003', 1, 1, '1001');

      // 1004: Product in LimitedDetails + GamePieces with NO LibraryReleases row
      seedProductPieces(
        '1004',
        'Synthetic Unowned Storefront Catalog Entry',
        'Cached catalog product never owned by user.'
      );
    }
  } finally {
    db.close();
  }

  return dbPath;
}

function seedLegendaryMetadataFixture(legendaryDir: string): void {
  const metaDir = path.join(legendaryDir, 'metadata');
  fs.mkdirSync(metaDir, { recursive: true });

  const writeMeta = (appName: string, payload: Record<string, unknown>) => {
    fs.writeFileSync(path.join(metaDir, `${appName}.json`), JSON.stringify(payload, null, 2), 'utf8');
  };

  // 1. Valid APPLICATION base game
  writeMeta('SynValidBaseApp', {
    app_name: 'SynValidBaseApp',
    app_title: 'Synthetic Galaxy Tactics',
    metadata: {
      id: 'cat_syn_valid_base',
      title: 'Synthetic Galaxy Tactics',
      namespace: 'ns_syn_tactics',
      itemType: 'APPLICATION',
      categories: [{ path: 'games' }, { path: 'applications' }],
      description: 'Valid base game for synthetic Epic catalog tests.',
      developer: 'Synthetic Works',
      publisher: 'Synthetic Publishing',
      keyImages: [
        { type: 'DieselGameBoxTall', url: 'https://cdn1.epicgames.com/syn_valid_tall.jpg' },
        { type: 'DieselGameBox', url: 'https://cdn1.epicgames.com/syn_valid_wide.jpg' },
      ],
    },
  });

  // 2. PRIVATE sandbox
  writeMeta('SynPrivateSandbox', {
    app_name: 'SynPrivateSandbox',
    app_title: 'Synthetic Staging Branch',
    sandboxType: 'PRIVATE',
    metadata: {
      id: 'cat_syn_priv',
      title: 'Synthetic Staging Branch',
      namespace: 'ns_syn_priv',
      sandboxType: 'PRIVATE',
      itemType: 'APPLICATION',
      categories: [{ path: 'games' }],
    },
  });

  // 3. ue namespace engine asset
  writeMeta('SynUnrealAssetPack', {
    app_name: 'SynUnrealAssetPack',
    app_title: 'Synthetic Foliage Pack',
    metadata: {
      id: 'cat_syn_ue',
      title: 'Synthetic Foliage Pack',
      namespace: 'ue',
      itemType: 'APPLICATION',
      categories: [{ path: 'games' }],
    },
  });

  // 4. mainGameItem DLC
  writeMeta('SynTacticsDlcPack', {
    app_name: 'SynTacticsDlcPack',
    app_title: 'Synthetic Galaxy Tactics - Season Pass DLC',
    metadata: {
      id: 'cat_syn_dlc',
      title: 'Synthetic Galaxy Tactics - Season Pass DLC',
      namespace: 'ns_syn_tactics',
      itemType: 'APPLICATION',
      categories: [{ path: 'games' }],
      mainGameItem: {
        id: 'cat_syn_valid_base',
        namespace: 'ns_syn_tactics',
      },
    },
  });

  // 5. Fortnite_* cosmetic grant
  writeMeta('Fortnite_SynCosmetic01', {
    app_name: 'Fortnite_SynCosmetic01',
    app_title: 'Synthetic Cosmetic Grant',
    metadata: {
      id: 'cat_syn_fn',
      title: 'Synthetic Cosmetic Grant',
      namespace: 'fn',
      itemType: 'APPLICATION',
      categories: [{ path: 'games' }],
    },
  });
}

function findVNodes(root: unknown, predicate: (node: Record<string, any>) => boolean): Record<string, any>[] {
  const matches: Record<string, any>[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, any>;
    if (predicate(obj)) matches.push(obj);
    if (obj.props?.children !== undefined) {
      visit(obj.props.children);
    }
  };
  visit(root);
  return matches;
}

function extractVNodeText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractVNodeText).join('');
  if (typeof node === 'object' && (node as Record<string, any>).props?.children !== undefined) {
    return extractVNodeText((node as Record<string, any>).props.children);
  }
  return '';
}

function makeSyntheticGame(overrides: Partial<CanonicalGame> & Pick<CanonicalGame, 'id' | 'title' | 'platforms'>): CanonicalGame {
  return {
    sortTitle: overrides.title,
    headerImage: 'https://images.gog-statics.com/syn_header.jpg',
    capsuleImage: 'https://images.gog-statics.com/syn_capsule.jpg',
    shortDescription: 'Synthetic description',
    releaseDate: '2025-01-15',
    developers: ['Synthetic Studio'],
    publishers: ['Synthetic Publisher'],
    genres: ['RPG'],
    tags: ['Synthetic'],
    ...overrides,
  };
}

describe('Storefront Entitlement Authority & Ghost Reconciliation Regression Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    hoisted.idbStore.clear();
    hoisted.lsStore.clear();
    delete hoisted.windowShim.electronAPI;
    clearIntegrationStorage();
    clearSuppressedCatalogEntries();
    storeSync.trimStoreSyncMemory();
    federator.clearFederatorCaches();
    flushPendingCatalogSave();
  });

  afterEach(() => {
    flushPendingCatalogSave();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    delete hoisted.windowShim.electronAPI;
    storeSync.trimStoreSyncMemory();
    federator.clearFederatorCaches();
    cleanupTempDirs();
  });

  afterAll(() => {
    cleanupTempDirs();
  });

  // ==========================================================================
  // 0. Self-Verifying Zero-PII Hygiene Invariant
  // ==========================================================================
  describe('0. Zero-PII Hygiene Self-Audit', () => {
    it('contains zero real user IDs, personal home paths, emails, or bearer tokens', () => {
      const selfPath = path.resolve(
        __dirname,
        'storefrontEntitlementAuthorityAndGhostReconciliation.test.ts'
      );
      const source = fs.readFileSync(selfPath, 'utf8');
      const violations = scanContentForPiiViolations(
        source,
        'tests/storefrontEntitlementAuthorityAndGhostReconciliation.test.ts',
        null
      );
      expect(violations).toEqual([]);
    });
  });

  // ==========================================================================
  // 1. Backend fetchGogOwnedGames & fetchEpicOwnedGames Entitlement Authority
  // ==========================================================================
  describe('1. Backend fetchGogOwnedGames & fetchEpicOwnedGames Entitlement Authority', () => {
    it('GOG transient 5xx & network outage on page 1 returns [] with lastAuthoritativeComplete === false and never falls back to listLocalGogCatalogGames', async () => {
      const tmpDir = makeTempDir('ol-gog-outage-');
      const gogRoot = path.join(tmpDir, 'gog-galaxy');
      const galaxyDbPath = createSyntheticGalaxyDb(gogRoot);
      const localCatalogSpy = vi.spyOn(federator, 'listLocalGogCatalogGames');

      // Case A: HTTP 503 on page 1
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/games/stats')) {
          return jsonResponse({ items: [] }, 200);
        }
        if (url.includes('/account/getFilteredProducts')) {
          return jsonResponse({ message: 'Service Unavailable' }, 503);
        }
        throw new Error(`Unexpected URL in GOG 503 test: ${url}`);
      }) as typeof fetch;

      const res503 = await storeSync.fetchGogOwnedGames(
        'syn_gog_tok_page1_503',
        SYNTHETIC_GOG_USERNAME,
        SYNTHETIC_GOG_USER_ID,
        {
          homedir: tmpDir,
          userDataDir: path.join(tmpDir, 'vault'),
          gogGalaxyRoots: [gogRoot],
          galaxyDbPath,
        }
      );

      expect(res503).toEqual([]);
      expect(storeSync.fetchGogOwnedGames.lastAuthoritativeComplete).toBe(false);
      expect(localCatalogSpy).not.toHaveBeenCalled();

      // Case B: Network ECONNRESET rejection on page 1
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/games/stats')) {
          return jsonResponse({ items: [] }, 200);
        }
        throw new Error('fetch failed: ECONNRESET');
      }) as typeof fetch;

      const resNetErr = await storeSync.fetchGogOwnedGames(
        'syn_gog_tok_net_err',
        SYNTHETIC_GOG_USERNAME,
        SYNTHETIC_GOG_USER_ID,
        {
          homedir: tmpDir,
          userDataDir: path.join(tmpDir, 'vault'),
          gogGalaxyRoots: [gogRoot],
          galaxyDbPath,
        }
      );

      expect(resNetErr).toEqual([]);
      expect(storeSync.fetchGogOwnedGames.lastAuthoritativeComplete).toBe(false);
      expect(localCatalogSpy).not.toHaveBeenCalled();
    });

    it('GOG mid-pagination failure (page 1 HTTP 200, page 2 HTTP 503) returns partial page-1 games with lastAuthoritativeComplete === false', async () => {
      const tmpDir = makeTempDir('ol-gog-midpage-');
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/games/stats')) {
          return jsonResponse({ items: [] }, 200);
        }
        if (url.includes('/account/getFilteredProducts')) {
          const parsed = new URL(url);
          const page = Number(parsed.searchParams.get('page') || '1');
          if (page === 1) {
            return jsonResponse(
              {
                totalPages: 2,
                products: [
                  {
                    id: 3001,
                    title: 'Synthetic RPG Page One',
                    image: '//images.gog-statics.com/syn_3001',
                    isHidden: false,
                  },
                ],
              },
              200
            );
          }
          return jsonResponse({ error: 'Upstream gateway timeout' }, 503);
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      const games = await storeSync.fetchGogOwnedGames(
        'syn_gog_tok_partial',
        SYNTHETIC_GOG_USERNAME,
        SYNTHETIC_GOG_USER_ID,
        { homedir: tmpDir, userDataDir: path.join(tmpDir, 'vault') }
      );

      expect(games.map((g: CanonicalGame) => g.id)).toEqual(['gog-3001']);
      expect(storeSync.fetchGogOwnedGames.lastAuthoritativeComplete).toBe(false);
    });

    it('GOG page-1 HTTP 401 throws unauthorized error so store:sync refresh-token recovery triggers, leaving lastAuthoritativeComplete === false', async () => {
      const tmpDir = makeTempDir('ol-gog-401-');
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/games/stats')) {
          return jsonResponse({ items: [] }, 200);
        }
        if (url.includes('/account/getFilteredProducts')) {
          return jsonResponse({ error: 'unauthorized' }, 401);
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      await expect(
        storeSync.fetchGogOwnedGames(
          'syn_gog_tok_expired',
          SYNTHETIC_GOG_USERNAME,
          SYNTHETIC_GOG_USER_ID,
          { homedir: tmpDir, userDataDir: path.join(tmpDir, 'vault') }
        )
      ).rejects.toThrow(/GOG getFilteredProducts unauthorized \(401\)/);

      expect(storeSync.fetchGogOwnedGames.lastAuthoritativeComplete).toBe(false);
    });

    it('GOG authentic 0-game account & complete multi-page sync set lastAuthoritativeComplete === true, keep hasHiddenProducts=false in URL, and filter isHidden: true items', async () => {
      const tmpDir = makeTempDir('ol-gog-auth-complete-');

      // Subcase A: Authentic 0-game account (products: [], totalPages: 1)
      const requestedZeroUrls: string[] = [];
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/games/stats')) {
          return jsonResponse({ items: [] }, 200);
        }
        if (url.includes('/account/getFilteredProducts')) {
          requestedZeroUrls.push(url);
          return jsonResponse({ products: [], totalPages: 1 }, 200);
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      const zeroGames = await storeSync.fetchGogOwnedGames(
        'syn_gog_tok_zero',
        SYNTHETIC_GOG_USERNAME,
        SYNTHETIC_GOG_USER_ID,
        { homedir: tmpDir, userDataDir: path.join(tmpDir, 'vault') }
      );

      expect(zeroGames).toEqual([]);
      expect(storeSync.fetchGogOwnedGames.lastAuthoritativeComplete).toBe(true);
      expect(requestedZeroUrls).toHaveLength(1);
      expect(requestedZeroUrls[0]).toContain('hasHiddenProducts=false');

      // Subcase B: Complete 2-page sync filtering isHidden: true items
      const requestedMultiUrls: string[] = [];
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/games/stats')) {
          return jsonResponse({ items: [] }, 200);
        }
        if (url.includes('/account/getFilteredProducts')) {
          requestedMultiUrls.push(url);
          const page = Number(new URL(url).searchParams.get('page') || '1');
          if (page === 1) {
            return jsonResponse(
              {
                totalPages: 2,
                hasHiddenProducts: true,
                products: [
                  {
                    id: 3101,
                    title: 'Synthetic RPG Alpha',
                    image: 'https://images.gog-statics.com/syn_3101.jpg',
                    isHidden: false,
                  },
                  {
                    id: 3102,
                    title: 'Synthetic Hidden Prime Wrapper',
                    image: 'https://images.gog-statics.com/syn_3102.jpg',
                    isHidden: true,
                  },
                ],
              },
              200
            );
          }
          return jsonResponse(
            {
              totalPages: 2,
              products: [
                {
                  id: 3103,
                  title: 'Synthetic Tactics Omega',
                  image: 'https://images.gog-statics.com/syn_3103.jpg',
                },
              ],
            },
            200
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      const multiGames = await storeSync.fetchGogOwnedGames(
        'syn_gog_tok_multi',
        SYNTHETIC_GOG_USERNAME,
        SYNTHETIC_GOG_USER_ID,
        { homedir: tmpDir, userDataDir: path.join(tmpDir, 'vault') }
      );

      expect(multiGames.map((g: CanonicalGame) => g.id)).toEqual(['gog-3101', 'gog-3103']);
      expect(storeSync.fetchGogOwnedGames.lastAuthoritativeComplete).toBe(true);
      expect(requestedMultiUrls).toHaveLength(2);
      for (const reqUrl of requestedMultiUrls) {
        expect(reqUrl).toContain('hasHiddenProducts=false');
      }
      expect(storeSync.fetchGogOwnedGames.lastSuppressedItems).toEqual([]);

      // Also verify direct-token renderer service parity for isHidden: true
      vi.spyOn(axios, 'get').mockResolvedValueOnce({
        data: {
          totalPages: 1,
          products: [
            { id: 3201, title: 'Synthetic Visible Direct', isHidden: false },
            { id: 3202, title: 'Synthetic Hidden Direct', isHidden: true },
          ],
        },
      } as any);
      const gogRendererSvc = new GogIntegrationService();
      const directDetailed = await gogRendererSvc.fetchOwnedGamesDetailed('syn_direct_gog_tok');
      expect(directDetailed.authoritativeComplete).toBe(true);
      expect(directDetailed.games.map((g) => g.id)).toEqual(['gog-3201']);
    });

    it('Epic transient outage, mid-pagination failure, and catalog-batch unresolved title failure set lastAuthoritativeComplete === false and never call listLocalEpicCatalogGames', async () => {
      const tmpDir = makeTempDir('ol-epic-failures-');
      const legDir = path.join(tmpDir, '.config', 'legendary');
      seedLegendaryMetadataFixture(legDir);
      fs.writeFileSync(
        path.join(legDir, 'user.json'),
        JSON.stringify({ account_id: SYNTHETIC_EPIC_ACCOUNT_ID }),
        'utf8'
      );

      const listLocalEpicSpy = vi.spyOn(federator, 'listLocalEpicCatalogGames');
      const isolatedEpicOpts = {
        homedir: tmpDir,
        userDataDir: path.join(tmpDir, 'vault'),
        legendaryBaseDirs: [legDir],
        legendaryDirs: [legDir],
        skipNetwork: true,
      };

      // Case A: Page-1 HTTP 503 transient outage
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/playtime/account/')) return jsonResponse([], 200);
        if (url.includes('/assets/Mac')) return jsonResponse([], 200);
        if (url.includes('/library/api/public/items')) {
          return jsonResponse({ errorCode: 'errors.com.epicgames.common.server_error' }, 503);
        }
        return jsonResponse({}, 200);
      }) as typeof fetch;

      const outageGames = await storeSync.fetchEpicOwnedGames(
        'syn_epic_tok_503',
        SYNTHETIC_EPIC_ACCOUNT_ID,
        isolatedEpicOpts
      );
      expect(outageGames).toEqual([]);
      expect(storeSync.fetchEpicOwnedGames.lastAuthoritativeComplete).toBe(false);
      expect(listLocalEpicSpy).not.toHaveBeenCalled();

      // Case B: Mid-pagination failure (page 1 succeeds with nextCursor, page 2 returns HTTP 502)
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/playtime/account/')) return jsonResponse([], 200);
        if (url.includes('/assets/Mac')) return jsonResponse([], 200);
        if (url.includes('/library/api/public/items')) {
          if (!url.includes('cursor=')) {
            return jsonResponse(
              {
                records: [
                  {
                    appName: 'SynEpicPageOneApp',
                    namespace: 'ns_syn_ep1',
                    catalogItemId: 'cat_syn_ep1',
                    sandboxType: 'PUBLIC',
                    metadata: {
                      title: 'Synthetic Epic Page One',
                      description: 'Complete inline description to skip offer lookup.',
                      developer: 'Synthetic Studio',
                    },
                  },
                ],
                responseMetadata: { nextCursor: 'cursor_page_2' },
              },
              200
            );
          }
          return jsonResponse({ error: 'Bad Gateway' }, 502);
        }
        return jsonResponse({}, 200);
      }) as typeof fetch;

      const midPageGames = await storeSync.fetchEpicOwnedGames(
        'syn_epic_tok_midpage',
        SYNTHETIC_EPIC_ACCOUNT_ID,
        isolatedEpicOpts
      );
      expect(midPageGames.map((g: CanonicalGame) => g.id)).toEqual(['epic-SynEpicPageOneApp']);
      expect(storeSync.fetchEpicOwnedGames.lastAuthoritativeComplete).toBe(false);
      expect(listLocalEpicSpy).not.toHaveBeenCalled();

      // Case C: Catalog-batch failure on untitled owned item with no local fallback
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/playtime/account/')) return jsonResponse([], 200);
        if (url.includes('/assets/Mac')) return jsonResponse([], 200);
        if (url.includes('/library/api/public/items')) {
          return jsonResponse(
            {
              records: [
                {
                  appName: 'SynUntitledCloudOnlyApp',
                  namespace: 'ns_syn_untitled',
                  catalogItemId: 'cat_syn_untitled_99',
                  sandboxType: 'PUBLIC',
                  metadata: {},
                },
              ],
              responseMetadata: {},
            },
            200
          );
        }
        if (url.includes('catalog-public-service-prod06.ol.epicgames.com')) {
          return jsonResponse({ error: 'Catalog upstream failure' }, 500);
        }
        return jsonResponse({}, 200);
      }) as typeof fetch;

      const unresolvedCatGames = await storeSync.fetchEpicOwnedGames(
        'syn_epic_tok_cat_fail',
        SYNTHETIC_EPIC_ACCOUNT_ID,
        {
          homedir: tmpDir,
          userDataDir: path.join(tmpDir, 'vault'),
          legendaryBaseDirs: [],
          legendaryDirs: [],
          skipNetwork: true,
        }
      );
      expect(unresolvedCatGames).toEqual([]);
      expect(storeSync.fetchEpicOwnedGames.lastAuthoritativeComplete).toBe(false);
      expect(listLocalEpicSpy).not.toHaveBeenCalled();
    });

    it('Epic authentic 0-game account & complete multi-page sync set lastAuthoritativeComplete === true, and trimStoreSyncMemory() resets both flags to null', async () => {
      const tmpDir = makeTempDir('ol-epic-auth-complete-');
      const isolatedOpts = {
        homedir: tmpDir,
        userDataDir: path.join(tmpDir, 'vault'),
        legendaryBaseDirs: [],
        legendaryDirs: [],
        skipNetwork: true,
      };

      // Subcase A: Authentic 0-game Epic account
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/playtime/account/')) return jsonResponse([], 200);
        if (url.includes('/assets/Mac')) return jsonResponse([], 200);
        if (url.includes('/library/api/public/items')) {
          return jsonResponse({ records: [], responseMetadata: {} }, 200);
        }
        return jsonResponse({}, 200);
      }) as typeof fetch;

      const zeroEpicGames = await storeSync.fetchEpicOwnedGames(
        'syn_epic_tok_zero',
        SYNTHETIC_EPIC_ACCOUNT_ID,
        isolatedOpts
      );
      expect(zeroEpicGames).toEqual([]);
      expect(storeSync.fetchEpicOwnedGames.lastAuthoritativeComplete).toBe(true);

      // Subcase B: Complete 2-page Epic sync with catalog bulk title lookup
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/playtime/account/')) return jsonResponse([], 200);
        if (url.includes('/assets/Mac')) return jsonResponse([], 200);
        if (url.includes('/library/api/public/items')) {
          if (!url.includes('cursor=')) {
            return jsonResponse(
              {
                records: [
                  {
                    appName: 'SynEpicUntitled1',
                    namespace: 'ns_syn_bulk',
                    catalogItemId: 'cat_syn_bulk_1',
                    sandboxType: 'PUBLIC',
                    metadata: {},
                  },
                ],
                responseMetadata: { nextCursor: 'cursor_2' },
              },
              200
            );
          }
          return jsonResponse(
            {
              records: [
                {
                  appName: 'SynEpicTitled2',
                  namespace: 'ns_syn_titled',
                  catalogItemId: 'cat_syn_titled_2',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Synthetic Horizon Two',
                    description: 'Detailed synthetic synopsis.',
                    developer: 'Synthetic North',
                  },
                },
              ],
              responseMetadata: {},
            },
            200
          );
        }
        if (url.includes('catalog-public-service-prod06.ol.epicgames.com')) {
          return jsonResponse(
            {
              cat_syn_bulk_1: {
                id: 'cat_syn_bulk_1',
                title: 'Synthetic Horizon One',
                description: 'Resolved cleanly from catalog bulk endpoint.',
                developer: 'Synthetic North',
                categories: [{ path: 'games' }],
                keyImages: [],
              },
            },
            200
          );
        }
        return jsonResponse({}, 200);
      }) as typeof fetch;

      const fullEpicGames = await storeSync.fetchEpicOwnedGames(
        'syn_epic_tok_full',
        SYNTHETIC_EPIC_ACCOUNT_ID,
        isolatedOpts
      );
      expect(fullEpicGames.map((g: CanonicalGame) => g.id).sort()).toEqual([
        'epic-SynEpicTitled2',
        'epic-SynEpicUntitled1',
      ]);
      expect(storeSync.fetchEpicOwnedGames.lastAuthoritativeComplete).toBe(true);

      // Verify trimStoreSyncMemory() resets both flags to null
      storeSync.fetchGogOwnedGames.lastAuthoritativeComplete = true;
      storeSync.trimStoreSyncMemory();
      expect(storeSync.fetchGogOwnedGames.lastAuthoritativeComplete).toBeNull();
      expect(storeSync.fetchEpicOwnedGames.lastAuthoritativeComplete).toBeNull();
    });
  });

  // ==========================================================================
  // 2. Local Cache Federator & Suppressed Scanner Visibility + Account-Boundary
  // ==========================================================================
  describe('2. Local Cache Federator & Suppressed Scanner Visibility + Account-Boundary Hardening', () => {
    it('listLocalGogCatalogGames enforces LibraryReleases + ReleaseProperties visibility/DLC/userId rules while resolveLocalGogMetadata still enriches hidden grant wrappers', () => {
      const tmpDir = makeTempDir('ol-gog-federator-');
      const gogRoot = path.join(tmpDir, 'gog-galaxy');
      createSyntheticGalaxyDb(gogRoot);

      // Matching userId: includes ONLY gog_1001 (visible base game)
      // Excludes: gog_1002 (isVisibleInLibrary=0), gog_1003 (isDlc=1), gog_1004 (no LibraryReleases row)
      const visibleGames = federator.listLocalGogCatalogGames({
        homedir: tmpDir,
        gogGalaxyRoots: [gogRoot],
        gogUserId: 'synthetic_user_1',
      });

      expect(visibleGames.map((g: { gogId: string }) => g.gogId)).toEqual(['1001']);
      expect(visibleGames[0].title).toBe('Synthetic RPG');

      // Per-ID resolveLocalGogMetadata('1002', ...) STILL resolves hidden grant wrapper artwork & synopsis!
      const hiddenWrapperMeta = federator.resolveLocalGogMetadata('1002', {
        homedir: tmpDir,
        gogGalaxyRoots: [gogRoot],
      });
      expect(hiddenWrapperMeta).not.toBeNull();
      expect(hiddenWrapperMeta.title).toBe('Synthetic Adventure - Prime Edition');
      expect(hiddenWrapperMeta.shortDescription).toContain('Hidden wrapper synopsis');
      expect(hiddenWrapperMeta.capsuleImage).toBe(
        'https://images.gog-statics.com/syn_1002_cover.webp'
      );
      expect(hiddenWrapperMeta.headerImage).toBe(
        'https://images.gog-statics.com/syn_1002_bg.webp'
      );

      // Mismatched gogUserId returns []
      const mismatchedUserGames = federator.listLocalGogCatalogGames({
        homedir: tmpDir,
        gogGalaxyRoots: [gogRoot],
        gogUserId: SYNTHETIC_GOG_OTHER_USER_ID,
      });
      expect(mismatchedUserGames).toEqual([]);
    });

    it('listLocalEpicCatalogGames enforces user.json presence + account_id match and excludes PRIVATE sandboxes, ue assets, mainGameItem DLCs, and Fortnite_* cosmetics', () => {
      const tmpDir = makeTempDir('ol-epic-federator-');
      const legDir = path.join(tmpDir, 'legendary');
      seedLegendaryMetadataFixture(legDir);

      // 1. Missing user.json -> returns [] (both without epicAccountId and with epicAccountId)
      expect(
        federator.listLocalEpicCatalogGames({
          homedir: tmpDir,
          legendaryDirs: [legDir],
        })
      ).toEqual([]);
      expect(
        federator.listLocalEpicCatalogGames({
          homedir: tmpDir,
          legendaryDirs: [legDir],
          epicAccountId: SYNTHETIC_EPIC_ACCOUNT_ID,
        })
      ).toEqual([]);

      // 2. Mismatched user.json account_id -> returns []
      fs.writeFileSync(
        path.join(legDir, 'user.json'),
        JSON.stringify({ account_id: SYNTHETIC_EPIC_MISMATCH_ID }),
        'utf8'
      );
      expect(
        federator.listLocalEpicCatalogGames({
          homedir: tmpDir,
          legendaryDirs: [legDir],
          epicAccountId: SYNTHETIC_EPIC_ACCOUNT_ID,
        })
      ).toEqual([]);

      // 3. Matching user.json account_id -> includes ONLY valid APPLICATION game
      fs.writeFileSync(
        path.join(legDir, 'user.json'),
        JSON.stringify({ account_id: SYNTHETIC_EPIC_ACCOUNT_ID }),
        'utf8'
      );
      const validEpicGames = federator.listLocalEpicCatalogGames({
        homedir: tmpDir,
        legendaryDirs: [legDir],
        epicAccountId: SYNTHETIC_EPIC_ACCOUNT_ID,
      });

      expect(validEpicGames.map((g: { appName: string }) => g.appName)).toEqual([
        'SynValidBaseApp',
      ]);
      expect(validEpicGames[0].title).toBe('Synthetic Galaxy Tactics');
    });

    it('scanLocalSuppressedStorefrontItems enforces Epic & GOG account boundaries (Finding 8A) and skips GOG is_visible_in_library: false items', () => {
      const tmpDir = makeTempDir('ol-suppressed-boundary-');
      const emptyVaultDir = path.join(tmpDir, 'empty-vault');
      fs.mkdirSync(emptyVaultDir, { recursive: true });

      // Seed Legendary directory with a non-game Epic soundtrack + DLC
      const legDir = path.join(tmpDir, 'legendary');
      fs.mkdirSync(path.join(legDir, 'metadata'), { recursive: true });
      fs.writeFileSync(
        path.join(legDir, 'metadata', 'SynEpicOstApp.json'),
        JSON.stringify({
          app_name: 'SynEpicOstApp',
          app_title: 'Synthetic RPG Official Soundtrack',
          metadata: {
            id: 'cat_syn_ost',
            title: 'Synthetic RPG Official Soundtrack',
            namespace: 'ns_syn_rpg',
            itemType: 'DLC',
            mainGameItem: { id: 'cat_syn_base', namespace: 'ns_syn_rpg' },
          },
        }),
        'utf8'
      );

      // Seed Heroic GOG cache with one visible non-game soundtrack and one hidden non-game item
      const heroicRoot = path.join(tmpDir, 'heroic');
      const storeCacheDir = path.join(heroicRoot, 'store_cache');
      const gogStoreDir = path.join(heroicRoot, 'gog_store');
      fs.mkdirSync(storeCacheDir, { recursive: true });
      fs.mkdirSync(gogStoreDir, { recursive: true });
      const gogLibraryFile = path.join(storeCacheDir, 'gog_library.json');
      const gogAuthFile = path.join(gogStoreDir, 'auth.json');

      fs.writeFileSync(
        gogLibraryFile,
        JSON.stringify({
          games: [
            {
              app_name: '9001',
              title: 'Synthetic Quest Official Soundtrack',
              is_visible_in_library: true,
              install: { is_dlc: false },
            },
            {
              app_name: '9002',
              title: 'Synthetic Hidden Artbook & Soundtrack',
              is_visible_in_library: false,
              install: { is_dlc: false },
            },
          ],
        }),
        'utf8'
      );

      // 1. Disconnected (savedTokens: {}, no epicAccountId / gogUserId) -> 0 Epic & 0 GOG items
      const disconnectedRes = storeSync.scanLocalSuppressedStorefrontItems({
        homedir: tmpDir,
        userDataDir: emptyVaultDir,
        legendaryDirs: [legDir],
        gogCacheFiles: [gogLibraryFile],
      });
      expect(disconnectedRes.filter((x: { platformId: string }) => x.platformId === 'epic')).toEqual([]);
      expect(disconnectedRes.filter((x: { platformId: string }) => x.platformId === 'gog')).toEqual([]);

      // 2. Missing Epic user.json & missing Heroic gog_store/auth.json -> 0 Epic & 0 GOG items
      const missingAuthFilesRes = storeSync.scanLocalSuppressedStorefrontItems({
        homedir: tmpDir,
        userDataDir: emptyVaultDir,
        epicAccountId: SYNTHETIC_EPIC_ACCOUNT_ID,
        gogUserId: SYNTHETIC_GOG_USER_ID,
        legendaryDirs: [legDir],
        gogCacheFiles: [gogLibraryFile],
      });
      expect(missingAuthFilesRes.filter((x: { platformId: string }) => x.platformId === 'epic')).toEqual([]);
      expect(missingAuthFilesRes.filter((x: { platformId: string }) => x.platformId === 'gog')).toEqual([]);

      // 3. Mismatched Epic user.json & mismatched Heroic gog_store/auth.json user_id -> 0 items
      fs.writeFileSync(
        path.join(legDir, 'user.json'),
        JSON.stringify({ account_id: SYNTHETIC_EPIC_MISMATCH_ID }),
        'utf8'
      );
      fs.writeFileSync(
        gogAuthFile,
        JSON.stringify({
          [storeSync.GOG_CLIENT_ID]: {
            access_token: 'syn_heroic_tok_mismatch',
            user_id: SYNTHETIC_GOG_OTHER_USER_ID,
          },
        }),
        'utf8'
      );
      const mismatchedRes = storeSync.scanLocalSuppressedStorefrontItems({
        homedir: tmpDir,
        userDataDir: emptyVaultDir,
        epicAccountId: SYNTHETIC_EPIC_ACCOUNT_ID,
        gogUserId: SYNTHETIC_GOG_USER_ID,
        legendaryDirs: [legDir],
        gogCacheFiles: [gogLibraryFile],
      });
      expect(mismatchedRes.filter((x: { platformId: string }) => x.platformId === 'epic')).toEqual([]);
      expect(mismatchedRes.filter((x: { platformId: string }) => x.platformId === 'gog')).toEqual([]);

      // 4. Matching Epic account_id + user.json AND matching gogUserId + gog_store/auth.json
      fs.writeFileSync(
        path.join(legDir, 'user.json'),
        JSON.stringify({ account_id: SYNTHETIC_EPIC_ACCOUNT_ID }),
        'utf8'
      );
      fs.writeFileSync(
        gogAuthFile,
        JSON.stringify({
          [storeSync.GOG_CLIENT_ID]: {
            access_token: 'syn_heroic_tok_valid',
            user_id: SYNTHETIC_GOG_USER_ID,
          },
        }),
        'utf8'
      );
      storeSync.trimStoreSyncMemory();

      const matchedRes = storeSync.scanLocalSuppressedStorefrontItems({
        homedir: tmpDir,
        userDataDir: emptyVaultDir,
        epicAccountId: SYNTHETIC_EPIC_ACCOUNT_ID,
        gogUserId: SYNTHETIC_GOG_USER_ID,
        legendaryDirs: [legDir],
        gogCacheFiles: [gogLibraryFile],
      });

      const epicSuppressed = matchedRes.filter(
        (x: { platformId: string }) => x.platformId === 'epic'
      );
      const gogSuppressed = matchedRes.filter(
        (x: { platformId: string }) => x.platformId === 'gog'
      );

      expect(epicSuppressed.map((x: { id: string }) => x.id)).toEqual(['epic-SynEpicOstApp']);
      // 9001 included; 9002 (is_visible_in_library: false) skipped!
      expect(gogSuppressed.map((x: { id: string }) => x.id)).toEqual(['gog-9001']);
    });
  });

  // ==========================================================================
  // 3. IPC & Renderer Auth / Direct-Token Guards
  // ==========================================================================
  describe('3. IPC & Renderer Auth / Direct-Token Guards', () => {
    it('store:sync IPC handler propagates authoritativeComplete and transientOffline accurately for complete syncs and transient outages', async () => {
      const handlers = new Map<string, (...args: any[]) => Promise<any>>();
      const mockIpcMain = {
        handle: vi.fn((channel: string, listener: (...args: any[]) => Promise<any>) => {
          handlers.set(channel, listener);
        }),
        on: vi.fn(),
        removeListener: vi.fn(),
      };

      const fetchGogOwnedGamesStub: any = vi.fn();
      const fetchEpicOwnedGamesStub: any = vi.fn();
      const mockStoreSync = {
        loadSavedTokens: vi.fn(() => ({
          gog: {
            access_token: 'syn_real_gog_access_token_123456',
            refresh_token: 'syn_real_gog_refresh_token_123456',
            user_id: SYNTHETIC_GOG_USER_ID,
          },
          epic: {
            access_token: 'syn_real_epic_access_token_123456',
            refresh_token: 'syn_real_epic_refresh_token_123456',
            account_id: SYNTHETIC_EPIC_ACCOUNT_ID,
            displayName: 'SyntheticEpicPlayer',
          },
        })),
        saveTokens: vi.fn(),
        fetchGogAccount: vi.fn(async () => ({
          username: SYNTHETIC_GOG_USERNAME,
          userId: SYNTHETIC_GOG_USER_ID,
          avatarUrl: 'https://images.gog-statics.com/syn_avatar_sdk_img_184.jpg',
        })),
        fetchGogOwnedGames: fetchGogOwnedGamesStub,
        renewGogTokens: vi.fn(),
        fetchEpicOwnedGames: fetchEpicOwnedGamesStub,
        renewEpicTokens: vi.fn(),
        scanLocalSuppressedStorefrontItems: vi.fn(() => []),
        trimStoreSyncMemory: vi.fn(() => {
          fetchGogOwnedGamesStub.lastAuthoritativeComplete = null;
          fetchEpicOwnedGamesStub.lastAuthoritativeComplete = null;
        }),
      };

      registerStoreSyncIpcHandlers({
        ipcMain: mockIpcMain,
        BrowserWindow: vi.fn(),
        session: {},
        getMainWindow: () => null,
        storeSync: mockStoreSync,
        launcherEngine: {
          isStoreDisconnectedTombstoned: () => false,
        },
      });

      const syncHandler = handlers.get('store:sync');
      expect(syncHandler).toBeTypeOf('function');

      // 1. GOG complete authentic 0-game sync -> authoritativeComplete: true, transientOffline: false
      fetchGogOwnedGamesStub.mockImplementationOnce(async () => {
        fetchGogOwnedGamesStub.lastAuthoritativeComplete = true;
        fetchGogOwnedGamesStub.lastAchievementsMap = {};
        fetchGogOwnedGamesStub.lastSuppressedItems = [];
        return [];
      });
      const gogZeroComplete = await syncHandler!({}, 'gog');
      expect(gogZeroComplete.success).toBe(true);
      expect(gogZeroComplete.games).toEqual([]);
      expect(gogZeroComplete.authoritativeComplete).toBe(true);
      expect(gogZeroComplete.transientOffline).toBe(false);

      // 2. GOG transient empty outage -> authoritativeComplete: false, transientOffline: true
      fetchGogOwnedGamesStub.mockImplementationOnce(async () => {
        fetchGogOwnedGamesStub.lastAuthoritativeComplete = false;
        fetchGogOwnedGamesStub.lastAchievementsMap = {};
        fetchGogOwnedGamesStub.lastSuppressedItems = [];
        return [];
      });
      const gogOutage = await syncHandler!({}, 'gog');
      expect(gogOutage.success).toBe(true);
      expect(gogOutage.games).toEqual([]);
      expect(gogOutage.authoritativeComplete).toBe(false);
      expect(gogOutage.transientOffline).toBe(true);

      // 3. Epic complete non-empty sync -> authoritativeComplete: true, transientOffline: false
      const epicGame = makeSyntheticGame({
        id: 'epic-SynCompleteApp',
        title: 'Synthetic Epic Complete',
        platforms: [{ platformId: 'epic', platformGameId: 'SynCompleteApp', installed: false }],
      });
      fetchEpicOwnedGamesStub.mockImplementationOnce(async () => {
        fetchEpicOwnedGamesStub.lastAuthoritativeComplete = true;
        fetchEpicOwnedGamesStub.lastAchievementsMap = {};
        fetchEpicOwnedGamesStub.lastSuppressedItems = [];
        return [epicGame];
      });
      const epicComplete = await syncHandler!({}, 'epic');
      expect(epicComplete.success).toBe(true);
      expect(epicComplete.authoritativeComplete).toBe(true);
      expect(epicComplete.transientOffline).toBe(false);
      expect(epicComplete.games).toHaveLength(1);

      // 4. Epic transient empty outage -> authoritativeComplete: false, transientOffline: true
      fetchEpicOwnedGamesStub.mockImplementationOnce(async () => {
        fetchEpicOwnedGamesStub.lastAuthoritativeComplete = false;
        fetchEpicOwnedGamesStub.lastAchievementsMap = {};
        fetchEpicOwnedGamesStub.lastSuppressedItems = [];
        return [];
      });
      const epicOutage = await syncHandler!({}, 'epic');
      expect(epicOutage.success).toBe(true);
      expect(epicOutage.authoritativeComplete).toBe(false);
      expect(epicOutage.transientOffline).toBe(true);
    });

    it('EpicIntegrationService.fetchOwnedGamesDetailed (Finding 7B) returns authoritativeComplete: false when catalog-public-service-prod06 throws for an untitled item, and true when all lookups succeed', async () => {
      const epicSvc = new EpicIntegrationService();

      // Case A: Catalog bulk lookup throws for an untitled owned item -> authoritativeComplete: false
      const axiosGetSpy = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (url.includes('/library/api/public/items')) {
          return {
            data: {
              records: [
                {
                  appName: 'SynDirectTitled',
                  namespace: 'ns_syn_dt',
                  catalogItemId: 'cat_syn_dt_1',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Synthetic Direct Titled',
                    developer: 'Synthetic Studio',
                  },
                },
                {
                  appName: 'SynDirectUntitled',
                  namespace: 'ns_syn_du',
                  catalogItemId: 'cat_syn_du_2',
                  sandboxType: 'PUBLIC',
                  metadata: {},
                },
              ],
              responseMetadata: {},
            },
          } as any;
        }
        if (url.includes('catalog-public-service-prod06.ol.epicgames.com')) {
          throw new Error('Synthetic 502 Bad Gateway on catalog bulk lookup');
        }
        throw new Error(`Unexpected axios URL: ${url}`);
      });

      const failedCatResult = await epicSvc.fetchOwnedGamesDetailed('syn_direct_epic_tok');
      expect(failedCatResult.authoritativeComplete).toBe(false);
      expect(failedCatResult.games.map((g) => g.id)).toEqual(['epic-cat_syn_dt_1']);

      // Case B: All pages and catalog bulk lookups succeed -> authoritativeComplete: true
      axiosGetSpy.mockImplementation(async (url: string) => {
        if (url.includes('/library/api/public/items')) {
          return {
            data: {
              records: [
                {
                  appName: 'SynDirectUntitled',
                  namespace: 'ns_syn_du',
                  catalogItemId: 'cat_syn_du_2',
                  sandboxType: 'PUBLIC',
                  metadata: {},
                },
              ],
              responseMetadata: {},
            },
          } as any;
        }
        if (url.includes('catalog-public-service-prod06.ol.epicgames.com')) {
          return {
            data: {
              cat_syn_du_2: {
                id: 'cat_syn_du_2',
                title: 'Synthetic Direct Resolved',
                description: 'Resolved via catalog lookup',
                developer: 'Synthetic Studio',
                categories: [{ path: 'games' }],
                keyImages: [],
              },
            },
          } as any;
        }
        throw new Error(`Unexpected axios URL: ${url}`);
      });

      const okResult = await epicSvc.fetchOwnedGamesDetailed('syn_direct_epic_tok');
      expect(okResult.authoritativeComplete).toBe(true);
      expect(okResult.games.map((g) => g.id)).toEqual(['epic-cat_syn_du_2']);
    });

    it('Authentic 0-game OAuth sign-in single-exchange guard (Finding 7A) in IntegrationsModal and StorefrontAccountsStep skips second exchangeCode, preserves SyntheticGogZero, and prunes stale uninstalled GOG ghosts', async () => {
      // ---- Part A: IntegrationsModal ----
      const staleGhostModal = makeSyntheticGame({
        id: 'gog-7701',
        title: 'Synthetic Stale Ghost Modal',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '7701', installed: false }],
      });
      const preservedSteamModal = makeSyntheticGame({
        id: 'steam-400',
        title: 'Synthetic Steam Anchor',
        steamAppId: 400,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '400', installed: false }],
      });
      saveCurrentCatalog([staleGhostModal, preservedSteamModal]);
      recordVerifiedUserEntitlements('gog', [staleGhostModal]);
      saveIntegrations(
        loadIntegrations().map((i) =>
          i.storefrontId === 'gog' ? { ...i, isConnected: false, accountName: undefined } : i
        )
      );

      let resolveModalLogin!: (val: any) => void;
      const loginStoreModalSpy = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveModalLogin = resolve;
          })
      );
      const exchangeCodeModalSpy = vi.fn(async () => ({
        success: false,
        error: 'exchangeCode should NEVER be invoked a second time!',
      }));
      const syncStoreModalSpy = vi.fn(async () => ({
        success: false,
        error: 'syncStore should NOT be invoked!',
      }));

      hoisted.windowShim.electronAPI = {
        isElectron: true,
        loginStore: loginStoreModalSpy,
        exchangeCode: exchangeCodeModalSpy,
        syncStore: syncStoreModalSpy,
        loadSavedTokens: vi.fn(async () => ({})),
        offlineVault: {
          deleteGames: vi.fn(async () => ({ success: true })),
          getStats: vi.fn(async () => null),
          onSyncProgress: vi.fn(() => () => {}),
        },
      };

      const onLibraryUpdatedModal = vi.fn();
      const modalRenderer = createDomain12DeepRenderer(IntegrationsModal, {
        isOpen: true,
        onClose: vi.fn(),
        onLibraryUpdated: onLibraryUpdatedModal,
      });

      try {
        let tree = modalRenderer.render();
        // Switch selectedTab from default 'steam' to 'gog'
        const gogTabBtn = findVNodes(
          tree,
          (n) => n.type === 'button' && extractVNodeText(n).includes('GOG.com')
        )[0];
        expect(gogTabBtn).toBeDefined();
        gogTabBtn.props.onClick();

        tree = modalRenderer.render();
        const signInGogBtn = findVNodes(
          tree,
          (n) => n.type === 'button' && extractVNodeText(n).includes('Sign In to GOG.com')
        )[0];
        expect(signInGogBtn).toBeDefined();
        signInGogBtn.props.onClick();

        expect(loginStoreModalSpy).toHaveBeenCalledWith('gog');

        resolveModalLogin({
          success: true,
          code: 'single_use_oauth_code',
          storefrontId: 'gog',
          accountName: 'SyntheticGogZero',
          games: [],
          authoritativeComplete: true,
          tokenData: { connected: true, user_id: SYNTHETIC_GOG_USER_ID },
        });
        await new Promise((r) => setTimeout(r, 20));
        modalRenderer.render();

        expect(exchangeCodeModalSpy).not.toHaveBeenCalled();
        expect(syncStoreModalSpy).not.toHaveBeenCalled();

        const gogIntegAfterModal = loadIntegrations().find((i) => i.storefrontId === 'gog');
        expect(gogIntegAfterModal?.isConnected).toBe(true);
        expect(gogIntegAfterModal?.accountName).toBe('SyntheticGogZero');
        expect(gogIntegAfterModal?.gamesCount).toBe(0);

        const catalogAfterModal = loadCurrentCatalog();
        expect(catalogAfterModal.map((g) => g.id)).toEqual(['steam-400']);
        expect(onLibraryUpdatedModal).toHaveBeenCalledTimes(1);
        expect(onLibraryUpdatedModal.mock.calls[0][0].map((g: CanonicalGame) => g.id)).toEqual([
          'steam-400',
        ]);
      } finally {
        modalRenderer.unmount();
      }

      // ---- Part B: StorefrontAccountsStep ----
      vi.spyOn(environmentSetupService, 'probeHealth').mockResolvedValue({} as EnvironmentHealthSnapshot);
      const staleGhostWizard = makeSyntheticGame({
        id: 'gog-7702',
        title: 'Synthetic Stale Ghost Wizard',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '7702', installed: false }],
      });
      saveCurrentCatalog([staleGhostWizard, preservedSteamModal]);
      recordVerifiedUserEntitlements('gog', [staleGhostWizard]);
      saveIntegrations(
        loadIntegrations().map((i) =>
          i.storefrontId === 'gog' ? { ...i, isConnected: false, accountName: undefined } : i
        )
      );

      const authLauncherWizardSpy = vi.fn(async () => ({
        success: true,
        code: 'single_use_oauth_code',
        storefrontId: 'gog' as const,
        accountName: 'SyntheticGogZero',
        games: [],
        authoritativeComplete: true,
        tokenData: { connected: true, user_id: SYNTHETIC_GOG_USER_ID },
      }));
      const exchangeCodeWizardSpy = vi.fn(async () => ({
        success: false,
        error: 'Double OAuth exchange attempted!',
      }));
      const syncStoreWizardSpy = vi.fn(async () => ({
        success: false,
        error: 'Unexpected fallback syncStore call!',
      }));

      hoisted.windowShim.electronAPI = {
        isElectron: true,
        openStorefrontAuthWindow: authLauncherWizardSpy,
        loginStore: authLauncherWizardSpy,
        exchangeCode: exchangeCodeWizardSpy,
        syncStore: syncStoreWizardSpy,
        loadSavedTokens: vi.fn(async () => ({})),
        offlineVault: {
          deleteGames: vi.fn(async () => ({ success: true })),
        },
      };

      const onLibraryUpdatedWizard = vi.fn();
      const onAccountsChangedWizard = vi.fn();
      const snapshotStub = {
        hostOs: 'darwin',
        localStoreHints: [],
      } as unknown as EnvironmentHealthSnapshot;

      const stepRenderer = createDomain12DeepRenderer(StorefrontAccountsStep, {
        snapshot: snapshotStub,
        connectedStorefronts: [],
        onAccountsChanged: onAccountsChangedWizard,
        onLibraryUpdated: onLibraryUpdatedWizard,
      });

      try {
        const stepTree = stepRenderer.render();
        const connectGogBtn = findVNodes(
          stepTree,
          (n) => n.props?.['data-testid'] === 'setup-connect-gog'
        )[0];
        expect(connectGogBtn).toBeDefined();

        await connectGogBtn.props.onClick();
        await new Promise((r) => setTimeout(r, 20));
        stepRenderer.render();

        expect(authLauncherWizardSpy).toHaveBeenCalledWith('gog');
        expect(exchangeCodeWizardSpy).not.toHaveBeenCalled();
        expect(syncStoreWizardSpy).not.toHaveBeenCalled();

        const gogIntegAfterWizard = loadIntegrations().find((i) => i.storefrontId === 'gog');
        expect(gogIntegAfterWizard?.isConnected).toBe(true);
        expect(gogIntegAfterWizard?.accountName).toBe('SyntheticGogZero');
        expect(gogIntegAfterWizard?.gamesCount).toBe(0);

        const catalogAfterWizard = loadCurrentCatalog();
        expect(catalogAfterWizard.map((g) => g.id)).toEqual(['steam-400']);
        expect(onLibraryUpdatedWizard).toHaveBeenCalledTimes(1);
      } finally {
        stepRenderer.unmount();
      }
    });
  });

  // ==========================================================================
  // 4. Frontend Multi-Layer Ghost Reconciliation & Safety Invariants
  // ==========================================================================
  describe('4. Frontend Multi-Layer Ghost Reconciliation & Cold-Boot Non-Resurrection', () => {
    it('preserves 100% of catalog on authoritativeComplete: false and surgically prunes only uninstalled storefront ghosts on authoritativeComplete: true', () => {
      const deleteGamesSpy = vi.fn(async (_ids: string[]) => ({
        success: true,
        deletedCount: _ids.length,
      }));
      hoisted.windowShim.electronAPI = {
        isElectron: true,
        offlineVault: {
          deleteGames: deleteGamesSpy,
        },
      };

      // 1. Valid owned GOG game (uninstalled)
      const gog2001 = makeSyntheticGame({
        id: 'gog-2001',
        title: 'Synthetic Chronicles',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '2001', installed: false }],
      });

      // 2. Uninstalled GOG ghost entries (with and without hyphen)
      const gog2002 = makeSyntheticGame({
        id: 'gog-2002',
        title: 'Synthetic Quest - Prime',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '2002', installed: false }],
      });
      const gog2003 = makeSyntheticGame({
        id: 'gog-2003',
        title: 'Synthetic Space Program Amazon Prime',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '2003', installed: false }],
      });

      // 3. Locally installed GOG game NOT in online API response
      const gog2004Installed = makeSyntheticGame({
        id: 'gog-2004',
        title: 'Synthetic Installed DRM-Free Classic',
        isVerifiedEntitlement: true,
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '2004',
            installed: true,
            installPath: '/tmp/synthetic-gog-2004',
          },
        ],
      });

      // 4. Cross-storefront merged Steam + GOG game where GOG 2005 is absent from online GOG API
      const steam500CrossStore = makeSyntheticGame({
        id: 'steam-500',
        title: 'Synthetic Cross-Platform Odyssey',
        steamAppId: 500,
        isVerifiedEntitlement: true,
        platforms: [
          { platformId: 'steam', platformGameId: '500', installed: false },
          { platformId: 'gog', platformGameId: '2005', installed: false },
        ],
      });

      // 5. Custom user game
      const custom1 = makeSyntheticGame({
        id: 'custom-1',
        title: 'Synthetic Homebrew Prototype',
        platforms: [
          {
            platformId: 'custom',
            platformGameId: 'custom-1',
            installed: true,
            installPath: '/tmp/synthetic-custom-1',
          },
        ],
      });

      const seededCatalog = [
        gog2001,
        gog2002,
        gog2003,
        gog2004Installed,
        steam500CrossStore,
        custom1,
      ];

      saveCurrentCatalog(seededCatalog);
      recordVerifiedUserEntitlements('steam', [steam500CrossStore]);
      recordVerifiedUserEntitlements('gog', [
        gog2001,
        gog2002,
        gog2003,
        gog2004Installed,
        steam500CrossStore,
      ]);

      const incomingOnlineGogGames: CanonicalGame[] = [
        makeSyntheticGame({
          id: 'gog-2001',
          title: 'Synthetic Chronicles',
          isVerifiedEntitlement: true,
          platforms: [{ platformId: 'gog', platformGameId: '2001', installed: false }],
        }),
      ];

      // ---- Step A: authoritativeComplete: false (transient/partial sync) -> ZERO pruning ----
      const afterTransient = mergeStorefrontGames(
        seededCatalog,
        incomingOnlineGogGames,
        'gog',
        { authoritativeComplete: false }
      );

      expect(afterTransient.map((g) => g.id).sort()).toEqual([
        'custom-1',
        'gog-2001',
        'gog-2002',
        'gog-2003',
        'gog-2004',
        'steam-500',
      ]);
      const transientCross = afterTransient.find((g) => g.id === 'steam-500');
      expect(transientCross?.platforms.map((p) => `${p.platformId}:${p.platformGameId}`)).toEqual([
        'steam:500',
        'gog:2005',
      ]);
      expect(deleteGamesSpy).not.toHaveBeenCalled();
      expect(getVerifiedUserEntitlements().gog).toEqual(
        expect.arrayContaining(['2001', '2002', '2003', '2004', '2005'])
      );

      // ---- Step B: authoritativeComplete: true -> surgical ghost reconciliation ----
      const afterAuthoritative = mergeStorefrontGames(
        afterTransient,
        incomingOnlineGogGames,
        'gog',
        { authoritativeComplete: true }
      );

      const remainingIds = afterAuthoritative.map((g) => g.id).sort();
      expect(remainingIds).toEqual(['custom-1', 'gog-2001', 'gog-2004', 'steam-500']);
      expect(remainingIds).not.toContain('gog-2002');
      expect(remainingIds).not.toContain('gog-2003');

      // Installed GOG game (gog-2004) is 100% preserved
      const preservedInstalled = afterAuthoritative.find((g) => g.id === 'gog-2004');
      expect(preservedInstalled).toBeDefined();
      expect(preservedInstalled?.platforms[0]?.installed).toBe(true);
      expect(preservedInstalled?.platforms[0]?.installPath).toBe('/tmp/synthetic-gog-2004');

      // Cross-storefront steam-500 keeps Steam platform and detaches ONLY stale uninstalled GOG 2005
      const reconciledCross = afterAuthoritative.find((g) => g.id === 'steam-500');
      expect(reconciledCross).toBeDefined();
      expect(reconciledCross?.platforms.map((p) => `${p.platformId}:${p.platformGameId}`)).toEqual([
        'steam:500',
      ]);

      // Custom game (custom-1) is 100% preserved
      expect(afterAuthoritative.find((g) => g.id === 'custom-1')).toBeDefined();

      // STORAGE_KEY_VERIFIED_ENTITLEMENTS removes pruned GOG IDs (2002, 2003, 2005) while preserving 2001 & installed 2004
      const persistedEntitlementsRaw = JSON.parse(
        localStorage.getItem(STORAGE_KEY_VERIFIED_ENTITLEMENTS) || '{}'
      ) as { gog?: string[]; steam?: number[] };
      expect(persistedEntitlementsRaw.gog).toEqual(expect.arrayContaining(['2001', '2004']));
      expect(persistedEntitlementsRaw.gog).not.toContain('2002');
      expect(persistedEntitlementsRaw.gog).not.toContain('2003');
      expect(persistedEntitlementsRaw.gog).not.toContain('2005');
      expect(persistedEntitlementsRaw.gog).not.toContain('synthetic quest - prime');
      expect(persistedEntitlementsRaw.gog).not.toContain('synthetic space program amazon prime');
      expect(persistedEntitlementsRaw.steam).toEqual([500]);
      expect(getVerifiedUserEntitlements().gog).toEqual(expect.arrayContaining(['2001', '2004']));
      expect(getVerifiedUserEntitlements().gog).not.toContain('2002');
      expect(getVerifiedUserEntitlements().gog).not.toContain('2003');
      expect(getVerifiedUserEntitlements().gog).not.toContain('2005');

      // offlineVault.deleteGames receives pruned GOG ghost IDs ('gog-2002', 'gog-2003', and standalone 'gog-2005') — NEVER 'steam-500', 'gog-2004', or 'custom-1'
      expect(deleteGamesSpy).toHaveBeenCalledTimes(1);
      const deletedVaultIds = [...(deleteGamesSpy.mock.calls[0]?.[0] || [])].sort();
      expect(deletedVaultIds).toEqual(expect.arrayContaining(['gog-2002', 'gog-2003']));
      expect(deletedVaultIds).not.toContain('steam-500');
      expect(deletedVaultIds).not.toContain('gog-2004');
      expect(deletedVaultIds).not.toContain('custom-1');
    });

    it('Cold-boot hydrateCatalogFromIndexedDb() does not resurrect pruned ghosts from stale offlineVault snapshot and dispatches offlineVault.deleteGames', async () => {
      const gog2001 = makeSyntheticGame({
        id: 'gog-2001',
        title: 'Synthetic Chronicles',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '2001', installed: false }],
      });
      const staleVaultGhost2002 = makeSyntheticGame({
        id: 'gog-2002',
        title: 'Synthetic Quest - Prime',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '2002', installed: false }],
      });

      // Seed authoritative IndexedDB catalog with ONLY [gog-2001]
      hoisted.idbStore.set(IDB_KEY_MAIN_CATALOG, [gog2001]);
      recordVerifiedUserEntitlements('gog', [gog2001]);

      const deleteGamesSpy = vi.fn(async (_ids: string[]) => ({
        success: true,
        deletedCount: _ids.length,
      }));
      const staleSnapshotPayload = {
        success: true,
        games: [gog2001, staleVaultGhost2002],
        suppressedItems: [],
      };
      const getCatalogSnapshotSpy = vi.fn(async () => staleSnapshotPayload);
      const getBootstrapSnapshotSpy = vi.fn(async () => staleSnapshotPayload);

      hoisted.windowShim.electronAPI = {
        isElectron: true,
        offlineVault: {
          getCatalogSnapshot: getCatalogSnapshotSpy,
          getBootstrapSnapshot: getBootstrapSnapshotSpy,
          deleteGames: deleteGamesSpy,
        },
      };

      const hydrated = await hydrateCatalogFromIndexedDb();
      flushPendingCatalogSave();

      expect(getCatalogSnapshotSpy).toHaveBeenCalledTimes(1);
      expect(hydrated).not.toBeNull();
      expect(hydrated!.map((g) => g.id)).toEqual(['gog-2001']);
      expect(hydrated!.map((g) => g.id)).not.toContain('gog-2002');

      expect(deleteGamesSpy).toHaveBeenCalledTimes(1);
      expect(deleteGamesSpy).toHaveBeenCalledWith(['gog-2002']);
    });
  });
});
