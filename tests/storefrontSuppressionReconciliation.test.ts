import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
import type { CanonicalGame } from '../src/contracts/game';

describe('Storefront Suppression Reconciliation & Self-Healing', () => {
  beforeEach(() => {
    localStorage.clear();
    clearSuppressedCatalogEntries();
  });

  afterEach(() => {
    unhideStorefrontEntry('epic-hidden-by-user', 'epic', 'HiddenApp123');
    localStorage.clear();
    clearSuppressedCatalogEntries();
  });

  // ============================================================================
  // Requirement 2a: Authoritative Pruning on Empty / Reduced Suppression Arrays
  // ============================================================================
  describe('Authoritative Pruning (authoritativeComplete === true)', () => {
    it('prunes stale non_game_filter entries when authoritative sync returns an empty array', () => {
      // 1. Seed mis-suppressed Epic entries
      registerSuppressedCatalogEntries([
        {
          id: 'epic-control',
          rawTitle: 'Control',
          platformId: 'epic',
          platformGameId: 'Calluna',
          reason: 'Filtered: Tool / Editor / Redistributable / Server',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'epic-control',
            title: 'Control',
            originalStoreTitle: 'Control',
            platforms: [{ platformId: 'epic', platformGameId: 'Calluna', installed: false }],
          } as CanonicalGame,
        },
        {
          id: 'epic-hotwheels',
          rawTitle: 'HOT WHEELS UNLEASHED™',
          platformId: 'epic',
          platformGameId: '0006475a83f143ba807174654bc09d38',
          reason: 'Filtered: DLC / Add-On / Expansion Content',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'epic-hotwheels',
            title: 'HOT WHEELS UNLEASHED™',
            originalStoreTitle: 'HOT WHEELS UNLEASHED™',
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

      expect(getSuppressedCatalogEntries()).toHaveLength(2);

      // 2. Perform authoritative sync for Epic returning 0 suppressed items
      registerSuppressedCatalogEntries([], {
        storefrontId: 'epic',
        authoritativeComplete: true,
      });

      // Stale Epic suppressions must be completely pruned
      const remaining = getSuppressedCatalogEntries();
      expect(remaining).toHaveLength(0);

      // Storage ledger must also reflect zero entries
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_SUPPRESSED_ENTRIES) || '[]');
      expect(stored).toHaveLength(0);
    });

    it('prunes stale entries not present in incoming authoritative entries while updating valid ones', () => {
      // 1. Seed two Epic non-game entries
      registerSuppressedCatalogEntries([
        {
          id: 'epic-stale-game',
          rawTitle: 'Alan Wake 2 (Mis-Suppressed)',
          platformId: 'epic',
          platformGameId: 'AlanWake2',
          reason: 'Filtered: Tool / Editor / Redistributable / Server',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'epic-stale-game',
            title: 'Alan Wake 2',
            originalStoreTitle: 'Alan Wake 2',
            platforms: [{ platformId: 'epic', platformGameId: 'AlanWake2', installed: false }],
          } as CanonicalGame,
        },
        {
          id: 'epic-real-dlc',
          rawTitle: 'Alan Wake 2: Night Springs DLC',
          platformId: 'epic',
          platformGameId: 'NightSpringsDLC',
          reason: 'Filtered: DLC / Add-On / Expansion Content',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'epic-real-dlc',
            title: 'Alan Wake 2: Night Springs DLC',
            originalStoreTitle: 'Alan Wake 2: Night Springs DLC',
            platforms: [
              { platformId: 'epic', platformGameId: 'NightSpringsDLC', installed: false },
            ],
          } as CanonicalGame,
        },
      ]);

      expect(getSuppressedCatalogEntries()).toHaveLength(2);

      // 2. Authoritative sync only returns the real DLC
      const realDlcEntry: SuppressedCatalogEntry = {
        id: 'epic-real-dlc',
        rawTitle: 'Alan Wake 2: Night Springs DLC',
        platformId: 'epic',
        platformGameId: 'NightSpringsDLC',
        reason: 'Filtered: DLC / Add-On / Expansion Content',
        reasonCategory: 'non_game_filter',
        rawGame: {
          id: 'epic-real-dlc',
          title: 'Alan Wake 2: Night Springs DLC',
          originalStoreTitle: 'Alan Wake 2: Night Springs DLC',
          platforms: [
            { platformId: 'epic', platformGameId: 'NightSpringsDLC', installed: false },
          ],
        } as CanonicalGame,
      };

      reconcileStorefrontSuppressedEntries('epic', [realDlcEntry], {
        authoritativeComplete: true,
      });

      const remaining = getSuppressedCatalogEntries();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].platformGameId).toBe('NightSpringsDLC');
      expect(remaining.map((r) => r.platformGameId)).not.toContain('AlanWake2');
    });

    it('scopes pruning strictly to the target storefront and preserves other storefront records', () => {
      // 1. Seed records across multiple storefronts
      registerSuppressedCatalogEntries([
        {
          id: 'epic-stale',
          rawTitle: 'Epic Base Game',
          platformId: 'epic',
          platformGameId: 'EpicBaseGameApp',
          reason: 'Filtered: Tool / Editor / Redistributable / Server',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'epic-stale',
            title: 'Epic Base Game',
            originalStoreTitle: 'Epic Base Game',
            platforms: [{ platformId: 'epic', platformGameId: 'EpicBaseGameApp', installed: false }],
          } as CanonicalGame,
        },
        {
          id: 'steam-soundtrack',
          rawTitle: 'Portal 2 Soundtrack',
          platformId: 'steam',
          platformGameId: '323180',
          reason: 'Filtered: Digital Soundtrack / Artbook / Bonus Content',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'steam-soundtrack',
            title: 'Portal 2 Soundtrack',
            originalStoreTitle: 'Portal 2 Soundtrack',
            platforms: [{ platformId: 'steam', platformGameId: '323180', installed: false }],
          } as CanonicalGame,
        },
      ]);

      expect(getSuppressedCatalogEntries()).toHaveLength(2);

      // 2. Authoritative Epic sync returns empty array
      registerSuppressedCatalogEntries([], {
        storefrontId: 'epic',
        authoritativeComplete: true,
      });

      const remaining = getSuppressedCatalogEntries();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].platformId).toBe('steam');
      expect(remaining[0].platformGameId).toBe('323180');
    });
  });

  // ============================================================================
  // Requirement 2b: Strict Invariant Preservation of user_hidden Entries
  // ============================================================================
  describe('user_hidden Invariant Preservation', () => {
    it('strictly preserves user_hidden entries under authoritative empty sync', () => {
      // 1. User explicitly hides a game via user override storage
      hideStorefrontEntry(
        {
          id: 'epic-hidden-by-user',
          title: 'My Hidden Game',
          originalStoreTitle: 'My Hidden Game',
          platforms: [{ platformId: 'epic', platformGameId: 'HiddenApp123', installed: false }],
        } as CanonicalGame,
        'epic',
        'Hidden / Suppressed by User'
      );

      // And register an auto-filtered entry
      registerSuppressedCatalogEntries([
        {
          id: 'epic-auto-filtered',
          rawTitle: 'Stale Auto Filtered',
          platformId: 'epic',
          platformGameId: 'AutoFilteredApp',
          reason: 'Filtered: Tool / Editor / Redistributable / Server',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'epic-auto-filtered',
            title: 'Stale Auto Filtered',
            originalStoreTitle: 'Stale Auto Filtered',
            platforms: [{ platformId: 'epic', platformGameId: 'AutoFilteredApp', installed: false }],
          } as CanonicalGame,
        },
      ]);

      expect(getSuppressedCatalogEntries()).toHaveLength(2);

      // 2. Authoritative sync with empty suppression list
      registerSuppressedCatalogEntries([], {
        storefrontId: 'epic',
        authoritativeComplete: true,
      });

      // The user_hidden entry MUST survive; auto-filtered must be removed
      const remaining = getSuppressedCatalogEntries();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].platformGameId).toBe('HiddenApp123');
      expect(remaining[0].reasonCategory).toBe('user_hidden');
    });
  });

  // ============================================================================
  // Requirement 2c: Positive Game Entitlement Reconciliation with authoritativeGames
  // ============================================================================
  describe('Positive Entitlement Reconciliation (authoritativeGames)', () => {
    it('unsuppresses non_game_filter entries matching verified entitlements in authoritativeGames', () => {
      // 1. Seed mis-suppressed entries for Control and Sifu
      registerSuppressedCatalogEntries([
        {
          id: 'epic-calluna',
          rawTitle: 'Control',
          platformId: 'epic',
          platformGameId: 'Calluna',
          reason: 'Filtered: Tool / Editor / Redistributable / Server',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'epic-calluna',
            title: 'Control',
            originalStoreTitle: 'Control',
            platforms: [{ platformId: 'epic', platformGameId: 'Calluna', installed: false }],
          } as CanonicalGame,
        },
        {
          id: 'epic-legitimate-dlc',
          rawTitle: 'Control Foundation DLC',
          platformId: 'epic',
          platformGameId: 'CallunaDLC1',
          reason: 'Filtered: DLC / Add-On / Expansion Content',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'epic-legitimate-dlc',
            title: 'Control Foundation DLC',
            originalStoreTitle: 'Control Foundation DLC',
            platforms: [{ platformId: 'epic', platformGameId: 'CallunaDLC1', installed: false }],
          } as CanonicalGame,
        },
      ]);

      expect(getSuppressedCatalogEntries()).toHaveLength(2);

      // 2. Provide authoritativeGames containing Control as a verified entitlement
      const verifiedControlGame = {
        id: 'epic-calluna',
        title: 'Control',
        originalStoreTitle: 'Control',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'epic', platformGameId: 'Calluna', installed: false }],
      } as CanonicalGame;

      registerSuppressedCatalogEntries(
        [
          // Legitimate DLC continues to be suppressed
          {
            id: 'epic-legitimate-dlc',
            rawTitle: 'Control Foundation DLC',
            platformId: 'epic',
            platformGameId: 'CallunaDLC1',
            reason: 'Filtered: DLC / Add-On / Expansion Content',
            reasonCategory: 'non_game_filter',
            rawGame: {
              id: 'epic-legitimate-dlc',
              title: 'Control Foundation DLC',
              originalStoreTitle: 'Control Foundation DLC',
              platforms: [{ platformId: 'epic', platformGameId: 'CallunaDLC1', installed: false }],
            } as CanonicalGame,
          },
        ],
        {
          storefrontId: 'epic',
          authoritativeGames: [verifiedControlGame],
          authoritativeComplete: false, // Even if partial sync, positive games are unsuppressed
        }
      );

      const remaining = getSuppressedCatalogEntries();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].platformGameId).toBe('CallunaDLC1');
      expect(remaining.map((r) => r.platformGameId)).not.toContain('Calluna');
    });

    it('unsuppresses verified games matching by catalogItemId or canonical title', () => {
      registerSuppressedCatalogEntries([
        {
          id: 'epic-cat-item-match',
          rawTitle: 'Death Stranding Director’s Cut',
          platformId: 'epic',
          platformGameId: 'dff2626bd13b457387875f9ba12f3309',
          reason: 'Filtered: Tool / Editor / Redistributable / Server',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'epic-cat-item-match',
            title: 'Death Stranding Director’s Cut',
            originalStoreTitle: 'Death Stranding Director’s Cut',
            platforms: [
              {
                platformId: 'epic',
                platformGameId: 'dff2626bd13b457387875f9ba12f3309',
                installed: false,
              },
            ],
          } as CanonicalGame,
        },
      ]);

      expect(getSuppressedCatalogEntries()).toHaveLength(1);

      // Verified game that matches via catalogItemId on platform
      const verifiedGame = {
        id: 'epic-dsdc',
        title: 'Death Stranding Director\'s Cut',
        originalStoreTitle: 'Death Stranding Director\'s Cut',
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'GingerApp',
            catalogItemId: 'dff2626bd13b457387875f9ba12f3309',
            installed: false,
          },
        ],
      } as CanonicalGame;

      registerSuppressedCatalogEntries([], {
        storefrontId: 'epic',
        authoritativeGames: [verifiedGame],
      });

      expect(getSuppressedCatalogEntries()).toHaveLength(0);
    });
  });

  // ============================================================================
  // Requirement 2d: Offline / Partial Sync Safety (authoritativeComplete === false)
  // ============================================================================
  describe('Offline & Partial Sync Safety', () => {
    it('does NOT prune existing non_game_filter entries when authoritativeComplete is false or omitted', () => {
      // 1. Seed valid DLC suppression
      registerSuppressedCatalogEntries([
        {
          id: 'epic-fallout-dlc',
          rawTitle: 'Fallout 3: Broken Steel',
          platformId: 'epic',
          platformGameId: 'Fallout3DLC3',
          reason: 'Filtered: DLC / Add-On / Expansion Content',
          reasonCategory: 'non_game_filter',
          rawGame: {
            id: 'epic-fallout-dlc',
            title: 'Fallout 3: Broken Steel',
            originalStoreTitle: 'Fallout 3: Broken Steel',
            platforms: [{ platformId: 'epic', platformGameId: 'Fallout3DLC3', installed: false }],
          } as CanonicalGame,
        },
      ]);

      expect(getSuppressedCatalogEntries()).toHaveLength(1);

      // 2. Simulate network disconnection or partial fetch: returns empty array, but authoritativeComplete is false
      registerSuppressedCatalogEntries([], {
        storefrontId: 'epic',
        authoritativeComplete: false,
      });

      // Must NOT be deleted because sync was not authoritative
      const remaining = getSuppressedCatalogEntries();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].platformGameId).toBe('Fallout3DLC3');
    });
  });

  // ============================================================================
  // Requirement 2e: Storage Load Self-Healing
  // ============================================================================
  describe('Storage Load Self-Healing', () => {
    it('automatically drops mis-suppressed verified base games on startup storage load', () => {
      // 1. Seed verified entitlements in storage (e.g. from prior successful login/token sync)
      localStorage.setItem(
        'antigravity_verified_storefront_entitlements_v1',
        JSON.stringify({ epic: ['calluna'] })
      );

      // Manually write a corrupted legacy storage payload simulating a prior bad build
      // where Control (a known verified base game entitlement) was saved under non_game_filter
      const staleSuppressedPayload = [
        {
          id: 'epic-control',
          store: 'epic',
          platformId: 'epic',
          platformGameId: 'Calluna',
          rawTitle: 'Control',
          reason: 'Filtered: Tool / Editor / Redistributable / Server',
          reasonCategory: 'non_game_filter',
          suppressedAt: Date.now() - 100000,
        },
        {
          id: 'epic-real-dlc',
          store: 'epic',
          platformId: 'epic',
          platformGameId: 'CallunaDLC1',
          rawTitle: 'Control Foundation DLC',
          reason: 'Filtered: DLC / Add-On / Expansion Content',
          reasonCategory: 'non_game_filter',
          suppressedAt: Date.now() - 100000,
        },
      ];

      localStorage.setItem(
        STORAGE_KEY_SUPPRESSED_ENTRIES,
        JSON.stringify(staleSuppressedPayload)
      );

      // 2. Call getSuppressedCatalogEntries to trigger syncSuppressedEntriesWithStorage
      const entries = getSuppressedCatalogEntries();

      // Mis-suppressed Control must be self-healed and dropped
      expect(entries).toHaveLength(1);
      expect(entries[0].platformGameId).toBe('CallunaDLC1');
      expect(entries.map((e) => e.platformGameId)).not.toContain('Calluna');

      // Storage must also have been re-persisted with the cleaned list
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_SUPPRESSED_ENTRIES) || '[]');
      expect(stored).toHaveLength(1);
      expect(stored[0].platformGameId).toBe('CallunaDLC1');
    });
  });
});
