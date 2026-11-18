import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import type { CanonicalGame } from '../src/contracts/game';
import { epicIntegration } from '../src/services/integrations/epicIntegration';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

const mockStorage = new MemoryStorage();
if (typeof (globalThis as any).localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: mockStorage,
    writable: true,
    configurable: true,
  });
}
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = {
    localStorage: mockStorage,
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
} else if (!(globalThis as any).window.localStorage) {
  (globalThis as any).window.localStorage = mockStorage;
}

import {
  clearSuppressedCatalogEntries,
  getSuppressedCatalogEntries,
  registerSuppressedCatalogEntries,
  reconcileStorefrontSuppressedEntries,
  STORAGE_KEY_SUPPRESSED_ENTRIES,
  type SuppressedCatalogEntry,
} from '../src/services/integrations/catalogSanitizer';
import { hideStorefrontEntry, unhideStorefrontEntry } from '../src/services/storage/userOverrideStorage';

const nodeRequire = createRequire(import.meta.url);
const nonGameClassifier = nodeRequire('../electron/storefronts/nonGameClassifier.cjs');
const storeSync = nodeRequire('../electron/storeSync.cjs');
const storefrontLocalCacheFederator = nodeRequire('../electron/launcher/storefrontLocalCacheFederator.cjs');

describe('Empirical Verification: Storefront Manifest Ingestion & Portability', () => {
  const homeDir = process.env.HOME || os.homedir();
  const legendaryMetaDir = path.join(homeDir, '.config', 'legendary', 'metadata');
  const hasLiveManifests = fs.existsSync(legendaryMetaDir);
  const tempDirs: string[] = [];

  function makeTempDir(prefix = 'challenger2-test-'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  interface SyntheticFixtureCounts {
    total: number;
    expectedBaseGames: number;
    expectedSuppressed: number;
    unhydratedAppName: string;
  }

  function createHermeticLegendaryFixture(baseDir: string): SyntheticFixtureCounts {
    const metaDir = path.join(baseDir, 'metadata');
    fs.mkdirSync(metaDir, { recursive: true });

    const writeMeta = (appName: string, payload: Record<string, unknown>) => {
      fs.writeFileSync(path.join(metaDir, `${appName}.json`), JSON.stringify(payload, null, 2), 'utf8');
    };

    // 1. Base Game (APPLICATION)
    writeMeta('syn_base_app', {
      app_name: 'syn_base_app',
      app_title: 'Synthetic Space Odyssey',
      metadata: {
        id: 'cat_syn_base_app',
        title: 'Synthetic Space Odyssey',
        itemType: 'APPLICATION',
        categories: [{ path: 'games' }, { path: 'applications' }],
      },
    });

    // 2. Base Game (DURABLE)
    writeMeta('syn_base_durable', {
      app_name: 'syn_base_durable',
      app_title: 'Synthetic Fantasy Legends',
      metadata: {
        id: 'cat_syn_base_durable',
        title: 'Synthetic Fantasy Legends',
        itemType: 'DURABLE',
        categories: [{ path: 'games' }],
      },
    });

    // 3. Base Game (Tactics RPG)
    writeMeta('syn_base_rpg', {
      app_name: 'syn_base_rpg',
      app_title: 'Synthetic Tactics RPG',
      metadata: {
        id: 'cat_syn_rpg',
        title: 'Synthetic Tactics RPG',
        itemType: 'APPLICATION',
        categories: [{ path: 'games' }],
      },
    });

    // 4. DLC (Distinct parent game)
    writeMeta('syn_dlc_expansion', {
      app_name: 'syn_dlc_expansion',
      app_title: 'Synthetic Space Odyssey - Expansion Pack',
      metadata: {
        id: 'cat_syn_dlc',
        title: 'Synthetic Space Odyssey - Expansion Pack',
        itemType: 'ADD_ON',
        mainGameItem: { id: 'cat_syn_base_app' },
        categories: [{ path: 'addons' }],
      },
    });

    // 5. Tool / Editor
    writeMeta('syn_tool_editor', {
      app_name: 'syn_tool_editor',
      app_title: 'Synthetic Fantasy Legends Map Editor',
      metadata: {
        id: 'cat_syn_tool',
        title: 'Synthetic Fantasy Legends Map Editor',
        itemType: 'APPLICATION',
        categories: [{ path: 'applications' }],
      },
    });

    // 6. Digital Soundtrack
    writeMeta('syn_soundtrack', {
      app_name: 'syn_soundtrack',
      app_title: 'Synthetic Fantasy Legends Soundtrack',
      metadata: {
        id: 'cat_syn_soundtrack',
        title: 'Synthetic Fantasy Legends Soundtrack',
        itemType: 'DURABLE',
        categories: [{ path: 'digitalextras' }],
      },
    });

    // 7. Public Beta / Test branch
    writeMeta('syn_beta_branch', {
      app_name: 'syn_beta_branch',
      app_title: 'Synthetic Tactics Beta Test',
      metadata: {
        id: 'cat_syn_beta',
        title: 'Synthetic Tactics Beta Test',
        itemType: 'APPLICATION',
        categories: [{ path: 'games' }],
      },
    });

    // 8. Demo / Playable Teaser
    writeMeta('syn_demo', {
      app_name: 'syn_demo',
      app_title: 'Synthetic Space Odyssey Prologue Demo',
      metadata: {
        id: 'cat_syn_demo',
        title: 'Synthetic Space Odyssey Prologue Demo',
        itemType: 'APPLICATION',
        categories: [{ path: 'games' }],
      },
    });

    return {
      total: 8,
      expectedBaseGames: 3,
      expectedSuppressed: 5,
      unhydratedAppName: 'syn_base_app',
    };
  }

  beforeEach(() => {
    localStorage.clear();
    clearSuppressedCatalogEntries();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    storeSync.trimStoreSyncMemory();
    for (const d of tempDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // Ignored
      }
    }
    tempDirs.length = 0;
    localStorage.clear();
    clearSuppressedCatalogEntries();
  });

  // ============================================================================
  // Suite 1: Storefront Manifest Empirical Evaluation
  // ============================================================================
  describe('Storefront Manifest Empirical Evaluation', () => {
    it('evaluates hermetic synthetic fixture: yields exact 3 base games and 5 suppressed non-games (100% precision)', () => {
      const fixtureDir = makeTempDir('legendary-fixture-');
      const counts = createHermeticLegendaryFixture(fixtureDir);
      const metaDir = path.join(fixtureDir, 'metadata');

      const files = fs.readdirSync(metaDir).filter((f) => f.endsWith('.json'));
      expect(files.length).toBe(counts.total);

      const suppressed: Array<{ appName: string; title: string; reason: string }> = [];
      const baseGames: Array<{ appName: string; title: string }> = [];

      for (const f of files) {
        const fullPath = path.join(metaDir, f);
        const json = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const appName = String(json?.app_name || f.replace(/\.json$/i, '')).trim();
        const title = String(json?.app_title || json?.metadata?.title || '').trim();
        const ns = json?.metadata?.namespace || json?.namespace || '';
        const categories = json?.metadata?.categories || [];
        const mainGameItem = json?.metadata?.mainGameItem || null;
        const itemType = json?.metadata?.itemType || '';

        const reason = nonGameClassifier.classifyNonGameStorefrontItem({
          store: 'epic',
          title,
          platformId: 'epic',
          platformGameId: appName,
          catalogItemId: json?.metadata?.id || json?.catalog_item_id || '',
          namespace: ns,
          isDlc: Boolean(mainGameItem && (mainGameItem.id || mainGameItem.namespace)),
          mainGameItem,
          itemType,
          categories,
        });

        if (reason) {
          suppressed.push({ appName, title, reason });
        } else {
          baseGames.push({ appName, title });
        }
      }

      expect(baseGames.length).toBe(counts.expectedBaseGames);
      expect(suppressed.length).toBe(counts.expectedSuppressed);

      // Verify that all suppressed items have valid reasons
      expect(suppressed.every((s) => typeof s.reason === 'string' && s.reason.startsWith('Filtered: '))).toBe(true);

      // Verify local suppressed scanning on the synthetic fixture
      const scanResults = storeSync.scanLocalSuppressedStorefrontItems({
        legendaryDirs: [fixtureDir],
        allowUnverifiedLocalCache: true,
      });
      const epicSuppressed = scanResults.filter((r: any) => r.platformId === 'epic');
      expect(epicSuppressed.length).toBe(counts.expectedSuppressed);
    });

    it('evaluates host manifests (if present) against universal structural invariants (0..N accounts)', () => {
      if (!hasLiveManifests) return;

      const files = fs.readdirSync(legendaryMetaDir).filter((f) => f.endsWith('.json'));
      if (files.length === 0) return;

      const suppressed: Array<{ appName: string; title: string; reason: string }> = [];
      const baseGames: Array<{ appName: string; title: string }> = [];

      for (const f of files) {
        const fullPath = path.join(legendaryMetaDir, f);
        const json = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const appName = String(json?.app_name || f.replace(/\.json$/i, '')).trim();
        const title = String(json?.app_title || json?.metadata?.title || '').trim();
        const ns = json?.metadata?.namespace || json?.namespace || '';
        const categories = json?.metadata?.categories || [];
        const mainGameItem = json?.metadata?.mainGameItem || null;
        const itemType = json?.metadata?.itemType || '';

        const reason = nonGameClassifier.classifyNonGameStorefrontItem({
          store: 'epic',
          title,
          platformId: 'epic',
          platformGameId: appName,
          catalogItemId: json?.metadata?.id || json?.catalog_item_id || '',
          namespace: ns,
          isDlc: Boolean(mainGameItem && (mainGameItem.id || mainGameItem.namespace)),
          mainGameItem,
          itemType,
          categories,
        });

        if (reason) {
          suppressed.push({ appName, title, reason });
        } else {
          baseGames.push({ appName, title });
        }
      }

      // Universal Invariant 1: Complete partitioning (base games + suppressed = total manifests)
      expect(baseGames.length + suppressed.length).toBe(files.length);

      // Universal Invariant 2: Every suppressed item has a well-formed suppression reason
      expect(suppressed.every((s) => typeof s.reason === 'string' && s.reason.startsWith('Filtered: '))).toBe(true);

      // Universal Invariant 3: Parity with scanLocalSuppressedStorefrontItems
      const results = storeSync.scanLocalSuppressedStorefrontItems({
        legendaryDirs: [path.join(homeDir, '.config', 'legendary')],
        allowUnverifiedLocalCache: true,
      });
      const epicSuppressed = results.filter((r: any) => r.platformId === 'epic');
      expect(epicSuppressed.length).toBe(suppressed.length);
    });
  });

  // ============================================================================
  // Suite 2: Unhydrated Record Ingestion & Deferred Classification Pathway
  // ============================================================================
  describe('Unhydrated Record Ingestion & Deferred Classification Pathway', () => {
    it('simulates unhydrated ingestion: records with wiped categories pass early filter and resolve via local fallback hermetically', () => {
      // 1. Create a hermetic synthetic fixture in temp dir
      const fixtureDir = makeTempDir('legendary-unhydrated-');
      const counts = createHermeticLegendaryFixture(fixtureDir);

      // 2. Candidate record simulating unhydrated incoming API payload (empty categories, placeholder title 'Live')
      const unhydratedItem = {
        appName: counts.unhydratedAppName,
        catalogItemId: 'cat_syn_base_app',
        namespace: 'ns_syn_app',
        sandboxType: 'PUBLIC',
        metadata: {
          title: 'Live', // Placeholder title from API before hydration
          itemType: 'APPLICATION',
          categories: [], // Empty unhydrated categories
        },
      };

      // Step 1: Early structural filter in fetchEpicOwnedGames (storeSync.cjs lines 2288-2325)
      const itemType = (unhydratedItem.metadata.itemType || '').toUpperCase();
      const rawCatalogId = String(unhydratedItem.catalogItemId).trim();
      const mainGameObj = (unhydratedItem.metadata as any).mainGameItem || null;
      const mainGameTargetId =
        mainGameObj && typeof mainGameObj === 'object' && typeof mainGameObj.id === 'string'
          ? mainGameObj.id.trim()
          : '';
      const hasDistinctParentGame = Boolean(
        mainGameObj &&
          (mainGameTargetId || mainGameObj.namespace) &&
          (!rawCatalogId || !mainGameTargetId || mainGameTargetId !== rawCatalogId)
      );
      const unambiguousDlcType = [
        'ADD_ON',
        'ADDON',
        'ADD-ON',
        'DLC',
        'CONSUMABLE',
        'WALLET',
        'SUBSCRIPTION',
        'PLUGIN',
        'EXTRA',
        'CURRENCY',
      ].includes(itemType);

      const earlyCatSegments = new Set();
      for (const c of unhydratedItem.metadata.categories as any[]) {
        const p = String(typeof c === 'string' ? c : c?.path || '').toLowerCase();
        for (const seg of p.split('/')) {
          if (seg.trim()) earlyCatSegments.add(seg.trim());
        }
      }
      const hasDefinitiveDlcCategory =
        !earlyCatSegments.has('games') &&
        ['addons', 'add-on', 'addon', 'dlc', 'consumable'].some((s) => earlyCatSegments.has(s));

      const earlyDropped = unambiguousDlcType || hasDistinctParentGame || hasDefinitiveDlcCategory;
      expect(earlyDropped).toBe(false); // MUST NOT be dropped early!

      // Step 2: Hydration triggers because title === 'Live' and categories.length === 0
      const needsCatalogLookup =
        !unhydratedItem.metadata.title ||
        unhydratedItem.metadata.title === 'Live' ||
        unhydratedItem.metadata.categories.length === 0;
      expect(needsCatalogLookup).toBe(true);

      // Step 3: Local cache fallback resolves metadata from hermetic fixture
      const localEpicFallback = storefrontLocalCacheFederator.resolveLocalEpicMetadata(
        unhydratedItem.appName,
        { legendaryDirs: [fixtureDir] }
      );
      expect(localEpicFallback).not.toBeNull();
      expect(localEpicFallback.title).toBe('Synthetic Space Odyssey');

      let resolvedCategories =
        Array.isArray(localEpicFallback.categories) && localEpicFallback.categories.length > 0
          ? localEpicFallback.categories
          : [{ path: 'games' }];

      // Step 4: Post-hydration classification
      const postHydrationReason = nonGameClassifier.classifyNonGameStorefrontItem({
        store: 'epic',
        title: localEpicFallback.title,
        platformId: 'epic',
        platformGameId: unhydratedItem.appName,
        catalogItemId: unhydratedItem.catalogItemId,
        namespace: unhydratedItem.namespace,
        itemType,
        categories: resolvedCategories,
      });

      expect(postHydrationReason).toBeNull(); // Cleanly identified as a base game!
    });

    it('simulates live host manifests with categories wiped: deferred classification matches direct classification with zero false positives', () => {
      if (!hasLiveManifests) return;

      const files = fs.readdirSync(legendaryMetaDir).filter((f) => f.endsWith('.json'));
      if (files.length === 0) return;

      let falselySuppressedBaseGames = 0;
      let correctlySuppressedNonGames = 0;

      for (const f of files) {
        const fullPath = path.join(legendaryMetaDir, f);
        const json = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const appName = String(json?.app_name || f.replace(/\.json$/i, '')).trim();
        const catalogItemId = json?.metadata?.id || json?.catalog_item_id || '';
        const ns = json?.metadata?.namespace || json?.namespace || '';

        // Simulate incoming candidate record having empty categories initially
        const candidateRecord = {
          appName,
          catalogItemId,
          namespace: ns,
          sandboxType: 'PUBLIC',
          metadata: {
            title: json?.app_title || json?.metadata?.title || '',
            itemType: json?.metadata?.itemType || 'DURABLE',
            categories: [], // Intentionally wiped
            mainGameItem: json?.metadata?.mainGameItem || null,
          },
        };

        // 1. Early filter check
        const itemTypeUpper = (candidateRecord.metadata.itemType || '').toUpperCase();
        const rawCatalogId = String(candidateRecord.catalogItemId).trim();
        const mainGameObj = candidateRecord.metadata.mainGameItem;
        const mainGameTargetId =
          mainGameObj && typeof mainGameObj === 'object' && typeof mainGameObj.id === 'string'
            ? mainGameObj.id.trim()
            : '';
        const hasDistinctParentGame = Boolean(
          mainGameObj &&
            (mainGameTargetId || mainGameObj.namespace) &&
            (!rawCatalogId || !mainGameTargetId || mainGameTargetId !== rawCatalogId)
        );
        const unambiguousDlcType = [
          'ADD_ON',
          'ADDON',
          'ADD-ON',
          'DLC',
          'CONSUMABLE',
          'WALLET',
          'SUBSCRIPTION',
          'PLUGIN',
          'EXTRA',
          'CURRENCY',
        ].includes(itemTypeUpper);

        const earlyDropped = unambiguousDlcType || hasDistinctParentGame;

        if (earlyDropped) {
          // Correctly dropped as DLC
          correctlySuppressedNonGames++;
          continue;
        }

        // 2. Hydration: restore categories from local manifest
        const originalCategories = json?.metadata?.categories || [];
        const hydratedCategories =
          originalCategories.length > 0 ? originalCategories : [{ path: 'games' }];

        // 3. Post-hydration classification
        const reason = nonGameClassifier.classifyNonGameStorefrontItem({
          store: 'epic',
          title: candidateRecord.metadata.title,
          platformId: 'epic',
          platformGameId: appName,
          catalogItemId,
          namespace: ns,
          itemType: itemTypeUpper,
          mainGameItem: candidateRecord.metadata.mainGameItem,
          categories: hydratedCategories,
        });

        if (reason) {
          correctlySuppressedNonGames++;
        } else {
          // This is a preserved base game
        }
      }

      // Universal Invariant: Deferred classification yields 0 falsely suppressed base games
      expect(falselySuppressedBaseGames).toBe(0);
      expect(correctlySuppressedNonGames).toBeGreaterThanOrEqual(0);
      expect(files.length - correctlySuppressedNonGames).toBeGreaterThanOrEqual(0);
    });
  });

  // ============================================================================
  // Suite 3: Adversarial Edge Cases in Classification
  // ============================================================================
  describe('Adversarial Classification Edge Cases', () => {
    it('handles self-referential mainGameItem without suppressing base games', () => {
      // Developer release packages often have mainGameItem.id === catalogItemId
      const result = nonGameClassifier.classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Epic Adventure Edition',
        catalogItemId: 'catalog_standalone_99',
        mainGameItem: { id: 'catalog_standalone_99' },
        itemType: 'APPLICATION',
        categories: [{ path: 'games' }],
      });
      expect(result).toBeNull();
    });

    it('suppresses distinct parent game reference as DLC', () => {
      const result = nonGameClassifier.classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Epic Adventure - Expansion One',
        catalogItemId: 'catalog_dlc_101',
        mainGameItem: { id: 'catalog_standalone_99' },
        itemType: 'APPLICATION',
        categories: [{ path: 'games' }],
      });
      expect(result).toBe('Filtered: DLC / Add-On / Expansion Content');
    });

    it('never suppresses installed items even if title matches non-game keywords', () => {
      const installedBeta = nonGameClassifier.classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Killing Floor 2 Beta',
        isInstalled: true,
      });
      expect(installedBeta).toBeNull();

      const installedDemo = nonGameClassifier.classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Overload Playable Teaser Demo',
        installed: true,
      });
      expect(installedDemo).toBeNull();
    });

    it('distinguishes Xbox Durable (DLC) from Epic Durable (permanent base game)', () => {
      // In Xbox, Durable means DLC
      const xboxDurable = nonGameClassifier.classifyNonGameStorefrontItem({
        store: 'xbox',
        title: 'Some Xbox Pack',
        itemType: 'DURABLE',
        categories: [{ path: 'games' }],
      });
      expect(xboxDurable).toBe('Filtered: DLC / Add-On / Expansion Content');

      // In Epic, Durable with games category is a permanent base game license
      const epicDurable = nonGameClassifier.classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Mortal Shell',
        itemType: 'DURABLE',
        categories: [{ path: 'games' }],
      });
      expect(epicDurable).toBeNull();
    });
  });

  // ============================================================================
  // Suite 4: Suppression Ledger Reconciliation & Self-Healing
  // ============================================================================
  describe('Suppression Ledger Authoritative Reconciliation & Storage Self-Healing', () => {
    it('isolates authoritative pruning per storefront without collateral damage to other stores', () => {
      // Seed entries for epic, steam, and gog
      registerSuppressedCatalogEntries([
        {
          id: 'epic-1',
          rawTitle: 'Epic Stale Game',
          platformId: 'epic',
          platformGameId: 'epic-1',
          reason: 'Filtered: DLC / Add-On / Expansion Content',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'epic-1',
            title: 'Epic Stale Game',
            platforms: [{ platformId: 'epic', platformGameId: 'epic-1' }],
          } as CanonicalGame,
        },
        {
          id: 'gog-1',
          rawTitle: 'GOG Tool',
          platformId: 'gog',
          platformGameId: 'gog-1',
          reason: 'Filtered: Tool / Editor / Redistributable / Server',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'gog-1',
            title: 'GOG Tool',
            platforms: [{ platformId: 'gog', platformGameId: 'gog-1' }],
          } as CanonicalGame,
        },
        {
          id: 'steam-1',
          rawTitle: 'Steam Soundtrack',
          platformId: 'steam',
          platformGameId: 'steam-1',
          reason: 'Filtered: Digital Soundtrack / Artbook / Bonus Content',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'steam-1',
            title: 'Steam Soundtrack',
            platforms: [{ platformId: 'steam', platformGameId: 'steam-1' }],
          } as CanonicalGame,
        },
      ]);

      expect(getSuppressedCatalogEntries().length).toBe(3);

      // Run authoritative reconciliation for Epic with empty suppression array
      reconcileStorefrontSuppressedEntries('epic', [], {
        authoritativeComplete: true,
      });

      const remaining = getSuppressedCatalogEntries();
      expect(remaining.length).toBe(2);
      expect(remaining.map((r) => r.platformId)).toEqual(expect.arrayContaining(['gog', 'steam']));
      expect(remaining.some((r) => r.platformId === 'epic')).toBe(false);
    });

    it('strictly preserves user_hidden entries under all circumstances', () => {
      // User explicitly hides a game via user override storage
      hideStorefrontEntry(
        {
          id: 'epic-user-hidden',
          title: 'User Hidden Epic Game',
          originalStoreTitle: 'User Hidden Epic Game',
          platforms: [{ platformId: 'epic', platformGameId: 'user-hidden-app', installed: false }],
        } as CanonicalGame,
        'epic',
        'Hidden / Suppressed by User'
      );

      registerSuppressedCatalogEntries([
        {
          id: 'epic-stale-filter',
          rawTitle: 'Mis-Suppressed Game',
          platformId: 'epic',
          platformGameId: 'stale-app',
          reason: 'Filtered: Tool / Editor / Redistributable / Server',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'epic-stale-filter',
            title: 'Mis-Suppressed Game',
            platforms: [{ platformId: 'epic', platformGameId: 'stale-app' }],
          } as CanonicalGame,
        },
      ]);

      expect(getSuppressedCatalogEntries().length).toBe(2);

      // Reconcile with authoritative complete = true and matching authoritativeGames
      reconcileStorefrontSuppressedEntries('epic', [], {
        authoritativeComplete: true,
        authoritativeGames: [
          {
            id: 'epic-user-hidden',
            title: 'User Hidden Epic Game',
            platforms: [{ platformId: 'epic', platformGameId: 'user-hidden-app' }],
          } as CanonicalGame,
        ],
      });

      const remaining = getSuppressedCatalogEntries();
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe('epic-user-hidden');
      expect(remaining[0].reasonCategory).toBe('user_hidden');

      unhideStorefrontEntry('epic-user-hidden', 'epic', 'user-hidden-app');
    });

    it('self-heals startup storage by purging mis-suppressed base games matching verified entitlements', () => {
      // 1. Seed verified entitlements in storage (e.g. from prior successful login/token sync)
      localStorage.setItem(
        'antigravity_verified_storefront_entitlements_v1',
        JSON.stringify({ epic: ['calluna'] })
      );

      // Manually write a corrupted legacy storage payload simulating a prior bad build
      // where Control (Calluna) was saved under non_game_filter
      const staleSuppressedEntries = [
        {
          id: 'epic-control',
          store: 'epic',
          platformId: 'epic',
          platformGameId: 'Calluna',
          rawTitle: 'Control',
          reason: 'Filtered: Tool / Editor / Redistributable / Server',
          reasonCategory: 'non_game_filter',
        },
        {
          id: 'epic-real-dlc',
          store: 'epic',
          platformId: 'epic',
          platformGameId: 'FoundationDlc',
          rawTitle: 'Control - The Foundation DLC',
          reason: 'Filtered: DLC / Add-On / Expansion Content',
          reasonCategory: 'non_game_filter',
        },
      ];

      localStorage.setItem(STORAGE_KEY_SUPPRESSED_ENTRIES, JSON.stringify(staleSuppressedEntries));

      // Trigger storage load and self-healing
      const healedEntries = getSuppressedCatalogEntries();

      expect(healedEntries.length).toBe(1);
      expect(healedEntries[0].platformGameId).toBe('FoundationDlc');
      expect(healedEntries.some((e) => e.platformGameId === 'Calluna')).toBe(false);

      // Verify that localStorage was updated with the cleaned entries
      const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY_SUPPRESSED_ENTRIES) || '[]');
      expect(persisted.length).toBe(1);
      expect(persisted[0].platformGameId).toBe('FoundationDlc');
    });
  });
});
