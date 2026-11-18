import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Storage mock for environments where global localStorage is absent
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
    location: { hostname: '' },
    localStorage: mockStorage,
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
} else {
  if (!(globalThis as any).window.location) {
    (globalThis as any).window.location = { hostname: '' };
  }
  if (!(globalThis as any).window.localStorage) {
    (globalThis as any).window.localStorage = mockStorage;
  }
}

const nodeRequire = createRequire(import.meta.url);
const nonGameClassifier = nodeRequire('../electron/storefronts/nonGameClassifier.cjs');
const storeSync = nodeRequire('../electron/storeSync.cjs');

const { classifyNonGameStorefrontItem } = nonGameClassifier;

import type { CanonicalGame } from '../src/contracts/game';
import type { StorefrontId } from '../src/contracts/platform';
import {
  clearSuppressedCatalogEntries,
  getSuppressedCatalogEntries,
  normalizeCanonicalTitle,
  reconcileStorefrontSuppressedEntries,
  registerSuppressedCatalogEntries,
  type SuppressedCatalogEntry,
} from '../src/services/integrations/catalogSanitizer';
import { epicIntegration } from '../src/services/integrations/epicIntegration';
import { hideStorefrontEntry, unhideStorefrontEntry } from '../src/services/storage/userOverrideStorage';

describe('Adversarial Stress & Fuzzing Harness — Epic Storefront Filtering & Suppression (Round 2 M1)', () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix = 'adv-fuzzer-'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    localStorage.clear();
    clearSuppressedCatalogEntries();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    storeSync.trimStoreSyncMemory();
    localStorage.clear();
    clearSuppressedCatalogEntries();
    for (const d of tempDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // Ignored
      }
    }
    tempDirs.length = 0;
  });

  // ============================================================================
  // Suite 1: Epic Unhydrated Schema Fuzzing & Boundary Edge Cases
  // ============================================================================
  describe('Suite 1: Epic Unhydrated Schemas & Boundary Edge Cases', () => {
    it('handles empty categories array and preserves candidate for hydration', () => {
      // An unhydrated item has title "Live" or hex hash and empty categories: []
      const unhydratedApp = {
        store: 'epic',
        title: 'Live',
        platformId: 'epic',
        platformGameId: 'UnhydratedApp001',
        catalogItemId: 'cat_unhydrated_001',
        itemType: 'APPLICATION',
        categories: [],
      };
      const res = classifyNonGameStorefrontItem(unhydratedApp);
      expect(typeof res === 'string' || res === null).toBe(true);
    });

    it('fuzzes malformed categories with non-array, undefined, poisoned primitives, and missing paths', () => {
      const poisonedCategoryVectors = [
        null,
        undefined,
        12345,
        'games',
        true,
        false,
        {},
        { path: null },
        { path: undefined },
        { path: '' },
        { path: '   ' },
        { path: 9999 },
        { path: {} },
        { path: [] },
        { wrongKey: 'games' },
        { path: 'games' },
      ];

      for (const vector of poisonedCategoryVectors) {
        expect(() => {
          classifyNonGameStorefrontItem({
            store: 'epic',
            title: 'Resilient Game Title',
            platformId: 'epic',
            platformGameId: 'ResilientGame001',
            itemType: 'DURABLE',
            categories: [vector as any],
          });
        }).not.toThrow();
      }

      // Completely non-array category parameters
      const nonArrayCategoryParams = [
        null,
        undefined,
        'games',
        12345,
        true,
        { path: 'games' },
        Symbol('categories'),
      ];

      for (const nonArrayParam of nonArrayCategoryParams) {
        expect(() => {
          classifyNonGameStorefrontItem({
            store: 'epic',
            title: 'Resilient Non-Array Title',
            platformId: 'epic',
            platformGameId: 'ResilientGame002',
            itemType: 'DURABLE',
            categories: nonArrayParam as any,
          });
        }).not.toThrow();
      }
    });

    it('fuzzes unusual and malformed itemTypes across casing, whitespace, and invalid tokens', () => {
      const validGameItemTypes = [
        'APPLICATION',
        'application',
        'Application',
        'aPpLiCaTiOn',
        'DURABLE',
        'durable',
        'Durable',
        'dUrAbLe',
        'GAME',
        'game',
        'BASE_GAME',
        'base_game',
      ];

      for (const itemType of validGameItemTypes) {
        const result = classifyNonGameStorefrontItem({
          store: 'epic',
          title: 'Cyberpunk 2077',
          platformId: 'epic',
          platformGameId: 'CyberpunkApp',
          itemType,
          categories: [{ path: 'games' }],
        });
        expect(result).toBeNull();
      }

      const definitiveDlcItemTypes = [
        'ADD_ON',
        'ADDON',
        'ADD-ON',
        'DLC',
        'dlc',
        'Dlc',
        'CONSUMABLE',
        'consumable',
        'WALLET',
        'wallet',
        'SUBSCRIPTION',
        'subscription',
        'PLUGIN',
        'plugin',
        'EXTRA',
        'extra',
        'CURRENCY',
        'currency',
      ];

      for (const itemType of definitiveDlcItemTypes) {
        const result = classifyNonGameStorefrontItem({
          store: 'epic',
          title: 'Cyberpunk 2077 Expansion',
          platformId: 'epic',
          platformGameId: 'CyberpunkExpansionApp',
          itemType,
          categories: [{ path: 'games' }],
        });
        expect(result).toBe('Filtered: DLC / Add-On / Expansion Content');
      }

      const anomalousItemTypes = [
        '',
        '   ',
        null,
        undefined,
        'UNKNOWN',
        'PACKAGE',
        'BUNDLE',
        'STANDALONE_BUNDLE',
        'RANDOM_CUSTOM_TYPE',
        '12345',
      ];

      for (const itemType of anomalousItemTypes) {
        expect(() => {
          classifyNonGameStorefrontItem({
            store: 'epic',
            title: 'Anomalous Type Game',
            platformId: 'epic',
            platformGameId: 'AnomalousApp',
            itemType: itemType as any,
            categories: [{ path: 'games' }],
          });
        }).not.toThrow();
      }
    });

    it('handles self-referential mainGameItem IDs without false DLC suppression', () => {
      // Standalone package where mainGameItem.id === catalogItemId
      const selfRefByCatalogId = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Borderlands 3: Super Deluxe Edition',
        platformId: 'epic',
        platformGameId: 'Oak',
        catalogItemId: 'catalog_borderlands3_deluxe',
        itemType: 'DURABLE',
        categories: [{ path: 'games' }],
        mainGameItem: { id: 'catalog_borderlands3_deluxe' },
      });
      expect(selfRefByCatalogId).toBeNull();

      // Standalone package where mainGameItem.id is padded with spaces
      const selfRefWithWhitespace = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Borderlands 3: Super Deluxe Edition',
        platformId: 'epic',
        platformGameId: 'Oak',
        catalogItemId: 'catalog_borderlands3_deluxe',
        itemType: 'DURABLE',
        categories: [{ path: 'games' }],
        mainGameItem: { id: '  catalog_borderlands3_deluxe  ' },
      });
      expect(selfRefWithWhitespace).toBeNull();

      // Real DLC where mainGameItem.id !== catalogItemId
      const realDlc = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Borderlands 3: Season Pass',
        platformId: 'epic',
        platformGameId: 'OakSeasonPass',
        catalogItemId: 'catalog_b3_season_pass',
        itemType: 'DURABLE',
        categories: [{ path: 'games' }],
        mainGameItem: { id: 'catalog_borderlands3_deluxe' },
      });
      expect(realDlc).toBe('Filtered: DLC / Add-On / Expansion Content');
    });

    it('handles circular references in item objects without infinite loops or stack overflow', () => {
      // Circular mainGameItem pointing to itself
      const circularMainGame: Record<string, any> = { id: 'cat_recursive_01' };
      circularMainGame.self = circularMainGame;

      const itemWithCircularMainGame: Record<string, any> = {
        store: 'epic',
        title: 'Recursive Universe Simulator',
        platformId: 'epic',
        platformGameId: 'RecursiveGame01',
        catalogItemId: 'cat_recursive_01',
        id: 'cat_recursive_01',
        itemType: 'DURABLE',
        categories: [{ path: 'games' }],
        mainGameItem: circularMainGame,
      };

      expect(() => {
        const res = classifyNonGameStorefrontItem(itemWithCircularMainGame);
        // Self-referential ID is recognized, so it is admitted
        expect(res).toBeNull();
      }).not.toThrow();

      // Self-referential object where item is its own mainGameItem (with matching catalog ID)
      const selfItem: Record<string, any> = {
        store: 'epic',
        title: 'Self Loop Game',
        platformId: 'epic',
        platformGameId: 'SelfLoopGame',
        catalogItemId: 'cat_self_loop',
        id: 'cat_self_loop',
        itemType: 'DURABLE',
        categories: [{ path: 'games' }],
      };
      selfItem.mainGameItem = selfItem;

      expect(() => {
        const res = classifyNonGameStorefrontItem(selfItem);
        expect(res).toBeNull();
      }).not.toThrow();
    });
  });

  // ============================================================================
  // Suite 2: Category Segment Permutations & Casing Fuzzing
  // ============================================================================
  describe('Suite 2: Category Segment Permutations & Casing Fuzzing', () => {
    it('accurately parses games_mods_support with and without games segment', () => {
      // 1. When accompanied by games segment: admitted as a base game
      const withGames = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Cities Skylines',
        platformId: 'epic',
        platformGameId: 'Skylines01',
        itemType: 'DURABLE',
        categories: [{ path: 'games' }, { path: 'games_mods_support' }],
      });
      expect(withGames).toBeNull();

      // 2. In renderer fallback epicIntegration.ts, games_mods_support does not trigger addon filtering
      const categories = [{ path: 'games_mods_support' }];
      const categorySegments = new Set<string>();
      for (const c of categories) {
        for (const seg of String(c?.path || '').toLowerCase().split('/')) {
          if (seg.trim()) categorySegments.add(seg.trim());
        }
      }
      const hasGamesSegment = categorySegments.has('games');
      const isAddonCategory =
        ['addons', 'add-on', 'addon', 'dlc', 'consumable', 'digitalextras'].some((sub) =>
          categorySegments.has(sub)
        ) ||
        (!hasGamesSegment && (categorySegments.has('mods') || categorySegments.has('vault')));

      expect(isAddonCategory).toBe(false);
    });

    it('filters games/mods/dlc because dlc segment is present', () => {
      const res = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Game DLC Pack',
        platformId: 'epic',
        platformGameId: 'GameDlc01',
        itemType: 'DURABLE',
        categories: [{ path: 'games/mods/dlc' }],
      });
      expect(res).toBe('Filtered: DLC / Add-On / Expansion Content');
    });

    it('preserves mods/games because games segment is present and overrides soft mod filtering', () => {
      const res = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Moddable Base Game',
        platformId: 'epic',
        platformGameId: 'ModBase01',
        itemType: 'DURABLE',
        categories: [{ path: 'mods/games' }],
      });
      expect(res).toBeNull();
    });

    it('filters standalone vault/special/edition without games, but preserves it when games is present', () => {
      // Standalone vault without games
      const standaloneVault = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Vault Mystery Reward',
        platformId: 'epic',
        platformGameId: 'VaultReward01',
        itemType: 'DURABLE',
        categories: [{ path: 'vault/special/edition' }],
      });
      expect(standaloneVault).toBe('Filtered: DLC / Add-On / Expansion Content');

      // Vault giveaway edition with games segment
      const vaultWithGames = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'City of Gangsters (Vault Edition)',
        platformId: 'epic',
        platformGameId: 'CityGangsters01',
        itemType: 'DURABLE',
        categories: [{ path: 'games/vault/special/edition' }],
      });
      expect(vaultWithGames).toBeNull();

      const vaultSeparateGames = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'City of Gangsters (Vault Edition 2)',
        platformId: 'epic',
        platformGameId: 'CityGangsters02',
        itemType: 'DURABLE',
        categories: [{ path: 'games' }, { path: 'vault/special/edition' }],
      });
      expect(vaultSeparateGames).toBeNull();
    });

    it('resiliently handles uppercase, lowercase, spaces, and mixed delimiters', () => {
      const variations = [
        'GAMES',
        '  games  ',
        '  GAMES  ',
        'games/edition/base',
        'GAMES/EDITION/BASE',
        '  games  /  edition  ',
        'mods / games',
        'vault / games / giveaway',
        'games / mods / support',
      ];

      for (const variation of variations) {
        const res = classifyNonGameStorefrontItem({
          store: 'epic',
          title: `Game With Category: ${variation}`,
          platformId: 'epic',
          platformGameId: `Game_${variation.replace(/[^a-z0-9]/gi, '_')}`,
          itemType: 'APPLICATION',
          categories: [{ path: variation }],
        });
        expect(res).toBeNull();
      }
    });
  });

  // ============================================================================
  // Suite 3: Suppression Ledger Stress & Storefront Isolation
  // ============================================================================
  describe('Suite 3: Suppression Ledger Stress & Storefront Isolation', () => {
    it('endures rapid bursts of 500+ registration and reconciliation calls without state corruption', () => {
      const stores: StorefrontId[] = ['epic', 'steam', 'gog', 'xbox'];

      // Seed initial items across stores
      for (const store of stores) {
        const seedItems: SuppressedCatalogEntry[] = Array.from({ length: 10 }, (_, i) => ({
          id: `${store}-seed-${i}`,
          rawTitle: `${store.toUpperCase()} Seed Game ${i}`,
          platformId: store,
          platformGameId: `app_${store}_${i}`,
          reason: 'Filtered: Tool / Editor / Redistributable / Server',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: `${store}-seed-${i}`,
            title: `${store.toUpperCase()} Seed Game ${i}`,
            platforms: [{ platformId: store, platformGameId: `app_${store}_${i}`, installed: false }],
          } as CanonicalGame,
        }));
        registerSuppressedCatalogEntries(seedItems);
      }

      expect(getSuppressedCatalogEntries().length).toBe(40);

      // Perform 500 rapid bursts with varying options
      for (let burst = 0; burst < 500; burst++) {
        const store = stores[burst % stores.length];
        const isAuthoritative = burst % 3 === 0;
        const sendEmpty = burst % 2 === 0;

        const entries: SuppressedCatalogEntry[] = sendEmpty
          ? []
          : [
              {
                id: `${store}-burst-${burst}`,
                rawTitle: `${store} Burst Entry ${burst}`,
                platformId: store,
                platformGameId: `burst_${burst}`,
                reason: 'Filtered: DLC / Add-On / Expansion Content',
                reasonCategory: 'non_game_filter',
                rawGame: {
                  id: `${store}-burst-${burst}`,
                  title: `${store} Burst Entry ${burst}`,
                  platforms: [{ platformId: store, platformGameId: `burst_${burst}`, installed: false }],
                } as CanonicalGame,
              },
            ];

        reconcileStorefrontSuppressedEntries(store, entries, {
          authoritativeComplete: isAuthoritative,
        });
      }

      // Ensure ledger snapshot is accessible and valid
      const snapshot = getSuppressedCatalogEntries();
      expect(Array.isArray(snapshot)).toBe(true);
      for (const entry of snapshot) {
        expect(entry).toHaveProperty('id');
        expect(entry).toHaveProperty('platformId');
        expect(entry).toHaveProperty('reasonCategory');
      }
    });

    it('strictly isolates storefront pruning so Epic reconciliation NEVER touches Steam, GOG, or Xbox entries', () => {
      // 1. Seed 10 entries for each storefront
      const storefronts: StorefrontId[] = ['steam', 'gog', 'xbox', 'epic'];
      for (const sf of storefronts) {
        const items: SuppressedCatalogEntry[] = Array.from({ length: 5 }, (_, i) => ({
          id: `${sf}-iso-${i}`,
          rawTitle: `${sf.toUpperCase()} Game ${i}`,
          platformId: sf,
          platformGameId: `${sf}_game_${i}`,
          reason: 'Filtered: Tool / Editor / Redistributable / Server',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: `${sf}-iso-${i}`,
            title: `${sf.toUpperCase()} Game ${i}`,
            platforms: [{ platformId: sf, platformGameId: `${sf}_game_${i}`, installed: false }],
          } as CanonicalGame,
        }));
        registerSuppressedCatalogEntries(items);
      }

      expect(getSuppressedCatalogEntries().length).toBe(20);

      // 2. Authoritative Epic sync returns EMPTY array
      reconcileStorefrontSuppressedEntries('epic', [], { authoritativeComplete: true });

      const afterEpicSync = getSuppressedCatalogEntries();
      expect(afterEpicSync.length).toBe(15);
      expect(afterEpicSync.filter((e) => e.platformId === 'epic').length).toBe(0);
      expect(afterEpicSync.filter((e) => e.platformId === 'steam').length).toBe(5);
      expect(afterEpicSync.filter((e) => e.platformId === 'gog').length).toBe(5);
      expect(afterEpicSync.filter((e) => e.platformId === 'xbox').length).toBe(5);

      // 3. Authoritative Steam sync returns 1 updated entry
      const steamRetained: SuppressedCatalogEntry[] = [
        {
          id: 'steam-iso-0',
          rawTitle: 'STEAM Game 0',
          platformId: 'steam',
          platformGameId: 'steam_game_0',
          reason: 'Filtered: DLC / Add-On / Expansion Content',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'steam-iso-0',
            title: 'STEAM Game 0',
            platforms: [{ platformId: 'steam', platformGameId: 'steam_game_0', installed: false }],
          } as CanonicalGame,
        },
      ];
      reconcileStorefrontSuppressedEntries('steam', steamRetained, { authoritativeComplete: true });

      const afterSteamSync = getSuppressedCatalogEntries();
      expect(afterSteamSync.length).toBe(11);
      expect(afterSteamSync.filter((e) => e.platformId === 'steam').length).toBe(1);
      expect(afterSteamSync.filter((e) => e.platformId === 'gog').length).toBe(5);
      expect(afterSteamSync.filter((e) => e.platformId === 'xbox').length).toBe(5);

      // 4. Non-authoritative sync for GOG does NOT prune anything
      reconcileStorefrontSuppressedEntries('gog', [], { authoritativeComplete: false });
      const afterGogPartial = getSuppressedCatalogEntries();
      expect(afterGogPartial.filter((e) => e.platformId === 'gog').length).toBe(5);
    });

    it('guarantees user_hidden records survive all onslaughts: empty arrays, authoritative passes, and game entitlements', () => {
      // 1. Add user_hidden entries across multiple stores via user override storage
      hideStorefrontEntry(
        {
          id: 'epic-user-hidden-1',
          title: 'Hidden Epic Title',
          originalStoreTitle: 'Hidden Epic Title',
          platforms: [{ platformId: 'epic', platformGameId: 'HiddenEpicApp1', installed: false }],
        } as CanonicalGame,
        'epic'
      );

      hideStorefrontEntry(
        {
          id: 'steam-user-hidden-2',
          title: 'Hidden Steam Title',
          originalStoreTitle: 'Hidden Steam Title',
          platforms: [{ platformId: 'steam', platformGameId: '123456', installed: false }],
        } as CanonicalGame,
        'steam'
      );

      // Also register an auto-filtered entry
      registerSuppressedCatalogEntries([
        {
          id: 'epic-auto-filtered-4',
          rawTitle: 'Auto Filtered Tool',
          platformId: 'epic',
          platformGameId: 'EpicToolApp',
          reason: 'Filtered: Tool / Editor / Redistributable / Server',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'epic-auto-filtered-4',
            title: 'Auto Filtered Tool',
            platforms: [{ platformId: 'epic', platformGameId: 'EpicToolApp', installed: false }],
          } as CanonicalGame,
        },
      ]);

      const initialSuppressed = getSuppressedCatalogEntries();
      const hiddenEntries = initialSuppressed.filter((e) => e.reasonCategory === 'user_hidden');
      expect(hiddenEntries.length).toBeGreaterThanOrEqual(2);

      // 2. Launch authoritative empty sync on Epic
      reconcileStorefrontSuppressedEntries('epic', [], { authoritativeComplete: true });

      let suppressed = getSuppressedCatalogEntries();
      // Auto-filtered tool is pruned, user_hidden Epic entry survives!
      expect(suppressed.find((e) => e.id === 'epic-auto-filtered-4')).toBeUndefined();
      expect(suppressed.find((e) => e.id.includes('epic-user-hidden-1'))).toBeDefined();
      expect(suppressed.find((e) => e.id.includes('steam-user-hidden-2'))).toBeDefined();

      // 3. Attempt to unsuppress user_hidden entries by presenting matching authoritativeGames!
      const matchingAuthoritativeGames: CanonicalGame[] = [
        {
          id: 'epic-user-hidden-1',
          title: 'Hidden Epic Title',
          platforms: [{ platformId: 'epic', platformGameId: 'HiddenEpicApp1', installed: false }],
        } as CanonicalGame,
      ];

      registerSuppressedCatalogEntries([], {
        storefrontId: 'epic',
        authoritativeComplete: true,
        authoritativeGames: matchingAuthoritativeGames,
      });

      suppressed = getSuppressedCatalogEntries();
      // user_hidden records MUST NOT be unsuppressed by positive game entitlements!
      expect(suppressed.find((e) => e.id.includes('epic-user-hidden-1'))).toBeDefined();

      // Cleanup user overrides
      unhideStorefrontEntry('epic-user-hidden-1', 'epic', 'HiddenEpicApp1');
      unhideStorefrontEntry('steam-user-hidden-2', 'steam', '123456');
    });

    it('correctly unsuppresses verified games via authoritativeGames across IDs, composite keys, and canonical titles', () => {
      // 1. Seed mis-suppressed entries
      registerSuppressedCatalogEntries([
        {
          id: 'epic-game-by-id',
          rawTitle: 'Control',
          platformId: 'epic',
          platformGameId: 'Calluna',
          reason: 'Filtered: Tool / Editor / Redistributable / Server',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'epic-game-by-id',
            title: 'Control',
            platforms: [{ platformId: 'epic', platformGameId: 'Calluna', installed: false }],
          } as CanonicalGame,
        },
        {
          id: 'epic-game-by-title',
          rawTitle: 'HOT WHEELS UNLEASHED™: Game of the Year Edition',
          platformId: 'epic',
          platformGameId: '0006475a83f143ba807174654bc09d38',
          reason: 'Filtered: DLC / Add-On / Expansion Content',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'epic-game-by-title',
            title: 'HOT WHEELS UNLEASHED™: Game of the Year Edition',
            platforms: [
              {
                platformId: 'epic',
                platformGameId: '0006475a83f143ba807174654bc09d38',
                installed: false,
              },
            ],
          } as CanonicalGame,
        },
      ]);

      expect(getSuppressedCatalogEntries().length).toBe(2);

      // 2. Reconcile with authoritativeGames: one matching by ID, one matching by normalized canonical title
      const authoritativeGames: CanonicalGame[] = [
        {
          id: 'epic-game-by-id',
          title: 'Control',
          platforms: [{ platformId: 'epic', platformGameId: 'Calluna', installed: true }],
        } as CanonicalGame,
        {
          id: 'epic-canonical-hotwheels',
          title: 'Hot Wheels Unleashed',
          platforms: [
            {
              platformId: 'epic',
              platformGameId: 'different_plat_game_id',
              catalogItemId: '0006475a83f143ba807174654bc09d38',
              installed: true,
            },
          ],
        } as CanonicalGame,
      ];

      registerSuppressedCatalogEntries([], {
        storefrontId: 'epic',
        authoritativeGames,
      });

      const remaining = getSuppressedCatalogEntries();
      expect(remaining.length).toBe(0);
    });
  });

  // ============================================================================
  // Suite 4: End-to-End Ingestion & Fallback Parity Under Offline Network Guard
  // ============================================================================
  describe('Suite 4: End-to-End Ingestion & Fallback Parity Under Offline Network Guard', () => {
    it('executes storeSync.fetchEpicOwnedGames with unhydrated batch, hydration, and fallback cleanly under offline guard', async () => {
      const emptyLegBase = makeTempDir('adv-fetch-epic-leg-');

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/library/api/public/playtime/')) {
          return { ok: true, json: async () => [] };
        }
        if (url.includes('launcher.store.epicgames.com/graphql')) {
          return {
            ok: true,
            json: async () => ({
              data: { PlayerProfile: { playerProfile: { achievementsSummaries: { data: [] } } } },
            }),
          };
        }
        if (url.includes('/launcher/api/public/assets/Mac')) {
          return { ok: true, json: async () => [] };
        }
        if (url.includes('/library/api/public/items')) {
          return {
            ok: true,
            json: async () => ({
              records: [
                // 1. Unhydrated base game (empty categories, title "Live", should be hydrated via bulk/items)
                {
                  appName: 'UnhydratedBaseApp',
                  namespace: 'ns_unhydrated',
                  catalogItemId: 'cat_unhydrated_base',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Live',
                    itemType: 'APPLICATION',
                    categories: [],
                  },
                },
                // 2. Unhydrated definitive DLC (itemType "ADD_ON", should be suppressed immediately)
                {
                  appName: 'UnhydratedDlcApp',
                  namespace: 'ns_dlc',
                  catalogItemId: 'cat_unhydrated_dlc',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Live DLC Content',
                    itemType: 'ADD_ON',
                    categories: [],
                  },
                },
                // 3. Standalone edition with self-referential mainGameItem (id === catalogItemId)
                {
                  appName: 'SelfRefBaseApp',
                  namespace: 'ns_self_ref',
                  catalogItemId: 'cat_self_ref',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Self-Referential Standalone Edition',
                    itemType: 'DURABLE',
                    categories: [{ path: 'games' }],
                    mainGameItem: { id: 'cat_self_ref' },
                  },
                },
              ],
              responseMetadata: {},
            }),
          };
        }
        if (url.includes('/bulk/items')) {
          return {
            ok: true,
            json: async () => ({
              cat_unhydrated_base: {
                id: 'cat_unhydrated_base',
                title: 'Hydrated Adventure',
                itemType: 'APPLICATION',
                categories: [{ path: 'games' }],
                description: 'A great hydrated adventure',
              },
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      });

      const outMeta: Record<string, unknown> = {};
      const games = await storeSync.fetchEpicOwnedGames('synthetic_token', 'synthetic_acct', {
        fetchFn: fetchMock,
        legendaryBaseDirs: [emptyLegBase],
        outMeta,
      });

      expect(outMeta.authoritativeComplete).toBe(true);

      const titles = (games as Array<{ title: string }>).map((g) => g.title);
      expect(titles).toContain('Hydrated Adventure');
      expect(titles).toContain('Self-Referential Standalone Edition');
      expect(titles).not.toContain('Live DLC Content');

      const suppressed = (outMeta.suppressedItems || []) as Array<{ platformGameId: string; reason: string }>;
      const suppressedIds = suppressed.map((s) => s.platformGameId);
      expect(suppressedIds).toContain('UnhydratedDlcApp');
      expect(suppressedIds).not.toContain('UnhydratedBaseApp');
      expect(suppressedIds).not.toContain('SelfRefBaseApp');
    });

    it('verifies epicIntegration.fetchOwnedGamesDetailed category segment matching and self-referential parity', async () => {
      const axiosSpy = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (String(url).includes('/library/api/public/items')) {
          return {
            data: {
              records: [
                // 1. Mod-supported game with path: 'games_mods_support'
                {
                  appName: 'ModdedBaseGame',
                  sandboxName: 'ModdedBaseGame',
                  catalogItemId: 'cat_modded_base',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Modded Base Game',
                    itemType: 'APPLICATION',
                    categories: [{ path: 'games_mods_support' }],
                  },
                },
                // 2. Mod-supported game with path: 'mods/games'
                {
                  appName: 'ModsAndGamesGame',
                  sandboxName: 'ModsAndGamesGame',
                  catalogItemId: 'cat_mods_games',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Mods And Games Title',
                    itemType: 'APPLICATION',
                    categories: [{ path: 'mods/games' }],
                  },
                },
                // 3. Vault giveaway game with separate games and vault categories
                {
                  appName: 'VaultGiveawayGame',
                  sandboxName: 'VaultGiveawayGame',
                  catalogItemId: 'cat_vault_giveaway',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'City of Gangsters (Vault Edition)',
                    itemType: 'APPLICATION',
                    categories: [{ path: 'games' }, { path: 'vault' }],
                  },
                },
                // 4. Pure add-on with category path: 'games/mods/dlc'
                {
                  appName: 'ModDlcAddon',
                  sandboxName: 'ModDlcAddon',
                  catalogItemId: 'cat_mod_dlc',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Mod DLC Add-on',
                    itemType: 'APPLICATION',
                    categories: [{ path: 'games/mods/dlc' }],
                  },
                },
                // 5. Standalone vault category without games: 'vault/special/edition'
                {
                  appName: 'StandaloneVaultReward',
                  sandboxName: 'StandaloneVaultReward',
                  catalogItemId: 'cat_vault_standalone',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Standalone Vault Asset',
                    itemType: 'APPLICATION',
                    categories: [{ path: 'vault/special/edition' }],
                  },
                },
                // 6. Standalone edition where mainGameItem.id === catalogItemId
                {
                  appName: 'SelfRefEdition',
                  sandboxName: 'SelfRefEdition',
                  catalogItemId: 'cat_self_ref_ed',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Self-Referential Game Edition',
                    itemType: 'APPLICATION',
                    categories: [{ path: 'games' }],
                    mainGameItem: { id: 'cat_self_ref_ed' },
                  },
                },
                // 7. Actual DLC where mainGameItem.id !== catalogItemId
                {
                  appName: 'RealParentDlc',
                  sandboxName: 'RealParentDlc',
                  catalogItemId: 'cat_dlc_parent',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Real DLC for Game Edition',
                    itemType: 'APPLICATION',
                    categories: [{ path: 'games' }],
                    mainGameItem: { id: 'cat_self_ref_ed' },
                  },
                },
              ],
            },
          };
        }
        return { data: {} };
      });

      try {
        const { games } = await epicIntegration.fetchOwnedGamesDetailed('synthetic_access_token');
        const titles = games.map((g) => g.title);

        // Base games admitted:
        expect(titles).toContain('Modded Base Game');
        expect(titles).toContain('Mods And Games Title');
        expect(titles).toContain('City of Gangsters (Vault Edition)');
        expect(titles).toContain('Self-Referential Game Edition');

        // Add-ons, DLCs, and non-game assets filtered:
        expect(titles).not.toContain('Mod DLC Add-on');
        expect(titles).not.toContain('Standalone Vault Asset');
        expect(titles).not.toContain('Real DLC for Game Edition');
      } finally {
        axiosSpy.mockRestore();
      }
    });
  });

  // ============================================================================
  // Suite 5: High-Frequency Fuzzing Generators & Invariant Fuzzing (1000 Iterations)
  // ============================================================================
  describe('Suite 5: High-Frequency Fuzzing Generators & Invariant Fuzzing', () => {
    it('executes 1000 pseudo-random item permutations through classifyNonGameStorefrontItem without throwing', () => {
      const stores = ['epic', 'steam', 'gog', 'xbox', 'ePiC', '', undefined, null];
      const titles = [
        'Normal Game',
        'Live',
        '0006475a83f143ba807174654bc09d38',
        '3f4e3c81-8b8a-4d2c-9a1b-1c2d3e4f5a6b',
        '遊戲：神話傳說',
        'Game ⚔️ With Emoji 🎮',
        'DLC / Expansion Pack',
        'Unreal Engine 5.4 Editor',
        'Beta Playtest Branch',
        '',
        '   ',
        undefined,
        null,
      ];
      const itemTypes = [
        'APPLICATION',
        'DURABLE',
        'ADD_ON',
        'DLC',
        'CONSUMABLE',
        'GAME',
        'TOOL',
        'ENGINE',
        'UNKNOWN',
        '',
        undefined,
        null,
      ];
      const categoriesLists = [
        [],
        [{ path: 'games' }],
        [{ path: 'games' }, { path: 'mods' }],
        [{ path: 'games_mods_support' }],
        [{ path: 'games/mods/dlc' }],
        [{ path: 'mods/games' }],
        [{ path: 'vault/special/edition' }],
        [{ path: 'games' }, { path: 'vault' }],
        [{ path: 'engines' }],
        [null, undefined, {}, { path: '' }],
        null,
        undefined,
      ];

      for (let i = 0; i < 1000; i++) {
        const store = stores[i % stores.length];
        const title = titles[(i * 3) % titles.length];
        const itemType = itemTypes[(i * 5) % itemTypes.length];
        const categories = categoriesLists[(i * 7) % categoriesLists.length];
        const isInstalled = i % 11 === 0;
        const catalogItemId = `cat_id_${i}`;
        const selfRef = i % 4 === 0;
        const mainGameItem = selfRef ? { id: catalogItemId } : i % 5 === 0 ? { id: `other_parent_${i}` } : null;

        expect(() => {
          const res = classifyNonGameStorefrontItem({
            store: store as any,
            title: title as any,
            platformId: store as any,
            platformGameId: `app_${i}`,
            catalogItemId,
            itemType: itemType as any,
            categories: categories as any,
            mainGameItem,
            isInstalled,
          });

          // Invariant 1: If locally installed, it is NEVER suppressed
          if (isInstalled) {
            expect(res).toBeNull();
          }

          // Invariant 2: Output is either null (admitted) or a string starting with "Filtered: "
          if (res !== null) {
            expect(typeof res).toBe('string');
            expect(res.startsWith('Filtered: ')).toBe(true);
          }
        }).not.toThrow();
      }
    });

    it('fuzzes normalizeCanonicalTitle with 1000 adversarial strings without memory leaks or errors', () => {
      const adversarialTitles = [
        'Game Title: Complete Edition (GOTY)',
        'Game Title - Extended Cut 20 Year Celebration',
        'Game IV: Part III - Chapter II',
        'The The Game: An Ultimate Collection Pack',
        'The Witcher® 3: Wild Hunt™ - Game of the Year Edition',
        'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z',
        'Game with [unclosed bracket and (parentheses',
        '🎮 🚀 ⚔️ 🔥',
        'Game $100% *special* ^chars+?/.\\',
        '   Lots    of    spaces   ',
        '',
      ];

      for (let i = 0; i < 1000; i++) {
        const base = adversarialTitles[i % adversarialTitles.length];
        const mutated = `${base} ${i}`;
        const norm = normalizeCanonicalTitle(mutated);
        expect(typeof norm).toBe('string');
      }
    });

    it('resiliently handles corrupted, poisoned, and primitive values in localStorage during syncSuppressedEntriesWithStorage', () => {
      const corruptedStoragePayloads = [
        '{ malformed json',
        '12345',
        'true',
        '"just a plain string"',
        'null',
        '[]',
        JSON.stringify([null, undefined, 42, true, 'string', {}]),
        JSON.stringify([
          { id: null },
          { id: '' },
          { id: 'epic-corrupt-1', store: 'epic', reasonCategory: null },
          { id: 'epic-corrupt-2', platformId: 'epic', platformGameId: null },
          { id: 'epic-corrupt-3', platformId: 'epic', platformGameId: 'app_3', reasonCategory: 'non_game_filter' },
        ]),
      ];

      for (const payload of corruptedStoragePayloads) {
        localStorage.setItem('universal_game_library_suppressed_entries_v1', payload);

        expect(() => {
          // Calling getSuppressedCatalogEntries triggers syncSuppressedEntriesWithStorage()
          const entries = getSuppressedCatalogEntries();
          expect(Array.isArray(entries)).toBe(true);
        }).not.toThrow();
      }
    });

    it('handles concurrent Promise.all reconciliation bursts cleanly', async () => {
      const concurrentTasks = Array.from({ length: 50 }, (_, i) => {
        return Promise.resolve().then(() => {
          const store: StorefrontId = i % 2 === 0 ? 'epic' : 'steam';
          reconcileStorefrontSuppressedEntries(store, [], {
            authoritativeComplete: true,
          });
        });
      });

      await expect(Promise.all(concurrentTasks)).resolves.toBeDefined();
      expect(Array.isArray(getSuppressedCatalogEntries())).toBe(true);
    });
  });
});
