import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockStorage } = vi.hoisted(() => {
  class MemoryStorage implements Storage {
    private store = new Map<string, string>();
    get length(): number {
      return this.store.size;
    }
    clear(): void {
      this.store.clear();
    }
    getItem(key: string): string | null {
      return this.store.get(key) ?? null;
    }
    key(index: number): string | null {
      return Array.from(this.store.keys())[index] ?? null;
    }
    removeItem(key: string): void {
      this.store.delete(key);
    }
    setItem(key: string, value: string): void {
      this.store.set(key, String(value));
    }
  }

  const storage = new MemoryStorage();
  const target = new EventTarget();
  const g = globalThis as unknown as {
    localStorage?: Storage;
    window?: Record<string, unknown>;
    CustomEvent?: typeof CustomEvent;
  };

  g.localStorage = storage;

  if (typeof g.CustomEvent === 'undefined') {
    class PolyfillCustomEvent<T = unknown> extends Event {
      public readonly detail: T;
      constructor(type: string, eventInitDict?: CustomEventInit<T>) {
        super(type, eventInitDict);
        this.detail = (eventInitDict?.detail ?? null) as T;
      }
    }
    g.CustomEvent = PolyfillCustomEvent as unknown as typeof CustomEvent;
  }

  if (typeof g.window === 'undefined') {
    g.window = {
      localStorage: storage,
      location: { hostname: '' },
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    };
  } else {
    g.window.localStorage = storage;
  }

  return { mockStorage: storage };
});

import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import type { CanonicalGame } from '../src/contracts/game';
import type { CriticScoreData } from '../src/contracts/critic';
import type { UserGameOverride } from '../src/contracts/override';
import {
  STORAGE_KEY_USER_OVERRIDES,
  saveUserOverride,
  loadUserOverrides,
  hydrateUserOverridesFromVault,
  patchUserOverrideReviewScore,
  applyUserOverrideToGame,
  getUserOverridesRevision,
} from '../src/services/storage/userOverrideStorage';
import {
  CriticScoreService,
  criticScoreService,
  KNOWN_CRITIC_SCORES,
} from '../src/services/critic/criticScoreService';
import { steamReviewResolver } from '../src/services/critic/steamReviewResolver';
import { storefrontReviewHarvester } from '../src/services/critic/storefrontReviewHarvester';
import { metacriticResolver } from '../src/services/critic/metacriticResolver';
import { storefrontStarResolver } from '../src/services/critic/storefrontStarResolver';
import { onlineLifecycleManager } from '../src/services/network/onlineLifecycleManager';
import {
  findBestHltbMatch,
  fetchAndCacheHltb,
  HLTB_DATABASE,
  HLTB_TITLE_DATABASE,
} from '../src/services/hltb/howLongToBeat';
import {
  normalizeTitleKey,
  normalizeTitleForStoreSearch,
  stripStorefrontDistributionSuffixes,
  stripPlatformAndDistributionNoise,
} from '../src/services/common/titleUtils';
import {
  stripHtmlToPlainSynopsis,
  isEmptyMarkdownLinkArtifact,
  clearSynopsisTextMemo,
} from '../src/services/common/synopsisTextUtils';
import {
  hasEffectiveVerticalCover,
  hasGenuineStoreSynopsis,
  isSynopsisAlreadyProbed,
  getGranularUnmatchedReasons,
} from '../src/components/Library/MatchManager/matchManagerDiagnostics';
import { igdbCoverService } from '../src/services/igdb/igdbCoverService';
import { metadataScraperService } from '../src/services/scraper/metadataScraperService';
import {
  clearStagedMemoryFallback,
  hydrateAllStagedCacheFromVault,
} from '../src/services/storage/stagedCacheService';

function makeGame(overrides: Partial<CanonicalGame> = {}): CanonicalGame {
  return {
    id: overrides.id ?? 'gog-900001',
    title: overrides.title ?? 'Synthetic Chronicle',
    sortTitle: overrides.sortTitle ?? 'Synthetic Chronicle',
    steamAppId: overrides.steamAppId,
    platforms: overrides.platforms ?? [
      {
        platformId: 'gog',
        platformGameId: '900001',
        installed: false,
      },
    ],
    headerImage: overrides.headerImage ?? 'https://images.gog-statics.com/sample_header.jpg',
    capsuleImage: overrides.capsuleImage,
    developers: overrides.developers ?? ['Synthetic Studio'],
    publishers: overrides.publishers ?? ['Synthetic Publishing'],
    genres: overrides.genres ?? ['Action'],
    tags: overrides.tags ?? [],
    releaseDate: overrides.releaseDate ?? '2024-01-15',
    shortDescription: overrides.shortDescription,
    enrichedMetadata: overrides.enrichedMetadata,
  };
}

describe('Wave 1: Critic, HLTB, Override Storage & Match Diagnostics Hardening', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    mockStorage.clear();
    clearStagedMemoryFallback();
    await hydrateAllStagedCacheFromVault();
    localStorage.setItem('antigravity_critic_schema_v16', '1');
    onlineLifecycleManager.ensureInitialized();
    window.dispatchEvent(new Event('online'));
    clearSynopsisTextMemo();
    criticScoreService.clearCache();
    steamReviewResolver.clearCache();
    storefrontReviewHarvester.clearCache();
    metacriticResolver.clearCache();
    storefrontStarResolver.clearCache();
    igdbCoverService.clearCache();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    onlineLifecycleManager.ensureInitialized();
    window.dispatchEvent(new Event('online'));
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  // =========================================================================
  // 1. userOverrideStorage.ts (C4, M3, L2)
  // =========================================================================
  describe('Override Encapsulation, Deduplicated v2 Disk Envelope & URL Sanitization (C4, M3, L2)', () => {
    it('M3: stores deduplicated v2 envelope on disk while projecting aliases transparently in loadUserOverrides()', () => {
      const ov: UserGameOverride = {
        gameId: 'gog-1458058109',
        platformId: 'gog',
        platformGameId: '1458058109',
        title: 'Synthetic Resistance',
        matchedStore: 'gog',
        shortDescription: 'A detailed description repeated if stored under multiple alias keys.',
        capsuleImage: 'https://images.gog-statics.com/resistance_cover.jpg',
        updatedAt: '2026-01-10T00:00:00.000Z',
      };

      saveUserOverride(ov);

      const rawDisk = localStorage.getItem(STORAGE_KEY_USER_OVERRIDES);
      expect(rawDisk).toBeTruthy();
      const parsedDisk = JSON.parse(rawDisk!) as {
        __v: number;
        records: Record<string, UserGameOverride>;
        aliases: Record<string, string>;
      };

      expect(parsedDisk.__v).toBe(2);
      expect(Object.keys(parsedDisk.records)).toEqual(['gog-1458058109']);
      expect(parsedDisk.aliases['gog:1458058109']).toBe('gog-1458058109');
      expect(rawDisk!.match(/A detailed description repeated/g)?.length).toBe(1);

      // Transparent projection preserves v1 caller semantics
      const loaded = loadUserOverrides();
      expect(loaded['gog-1458058109']?.title).toBe('Synthetic Resistance');
      expect(loaded['gog:1458058109']?.title).toBe('Synthetic Resistance');
      expect(Object.keys(loaded)).toContain('gog-1458058109');
      expect(Object.keys(loaded)).toContain('gog:1458058109');
    });

    it('M3: seamlessly loads legacy flat v1 maps and hybrid v2 spread objects', () => {
      const legacyV1 = {
        'gog-551100': {
          gameId: 'gog-551100',
          platformId: 'gog',
          platformGameId: '551100',
          title: 'Legacy V1 Entry',
          updatedAt: '2025-05-01T00:00:00.000Z',
        },
      };
      localStorage.setItem(STORAGE_KEY_USER_OVERRIDES, JSON.stringify(legacyV1));
      const fromV1 = loadUserOverrides();
      expect(fromV1['gog-551100']?.title).toBe('Legacy V1 Entry');

      // Hybrid spread onto v2 payload (matches legacy test pattern)
      saveUserOverride({
        gameId: 'gog-551101',
        platformId: 'gog',
        platformGameId: '551101',
        matchedStore: 'gog',
        title: 'Base V2 Entry',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      const v2Raw = JSON.parse(localStorage.getItem(STORAGE_KEY_USER_OVERRIDES)!) as Record<string, unknown>;
      const spreadPayload = {
        ...v2Raw,
        'gog-551102': {
          gameId: 'gog-551102',
          platformId: 'gog',
          platformGameId: '551102',
          title: 'Spread Override Entry',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
      };
      localStorage.setItem(STORAGE_KEY_USER_OVERRIDES, JSON.stringify(spreadPayload));

      const fromHybrid = loadUserOverrides();
      expect(fromHybrid['gog-551101']?.title).toBe('Base V2 Entry');
      expect(fromHybrid['gog-551102']?.title).toBe('Spread Override Entry');

      // Auto-upgraded hybrid spread to canonical v2 envelope on read
      const upgradedDisk = JSON.parse(localStorage.getItem(STORAGE_KEY_USER_OVERRIDES)!) as {
        __v: number;
        records: Record<string, UserGameOverride>;
        aliases: Record<string, string>;
      };
      expect(upgradedDisk.__v).toBe(2);
      expect(Object.keys(upgradedDisk).sort()).toEqual(['__v', 'aliases', 'records']);
      expect(upgradedDisk.records['gog-551101']?.title).toBe('Base V2 Entry');
      expect(upgradedDisk.records['gog-551102']?.title).toBe('Spread Override Entry');
    });

    it('M3-AutoMigrate: upgrades legacy flat v1 localStorage overrides to deduplicated v2 on startup even when hydratedFromVault.length === 0', async () => {
      const longSynopsis = 'Synthetic legacy duplicated synopsis payload. '.repeat(30);
      const canonicalRecord: UserGameOverride = {
        gameId: 'gog-552200',
        platformId: 'gog',
        platformGameId: '552200',
        matchedStore: 'gog',
        title: 'Synthetic Auto-Migrated Legacy Override',
        shortDescription: longSynopsis,
        updatedAt: '2026-03-01T12:00:00.000Z',
      };
      // Legacy flat v1 layout with duplicated canonical + colon alias copy
      const legacyV1Payload = {
        'gog-552200': canonicalRecord,
        'gog:552200': { ...canonicalRecord },
      };
      const rawV1 = JSON.stringify(legacyV1Payload);
      localStorage.setItem(STORAGE_KEY_USER_OVERRIDES, rawV1);

      // Mock offlineVault returning identical timestamp so hydratedFromVault.length === 0
      (window as unknown as { electronAPI?: unknown }).electronAPI = {
        offlineVault: {
          getUserOverrides: vi.fn().mockResolvedValue({
            'gog-552200': canonicalRecord,
          }),
          saveUserOverride: vi.fn().mockResolvedValue({ success: true }),
        },
      };

      await hydrateUserOverridesFromVault();

      const rawAfter = localStorage.getItem(STORAGE_KEY_USER_OVERRIDES)!;
      expect(rawAfter.length).toBeLessThan(rawV1.length);
      const parsedAfter = JSON.parse(rawAfter) as {
        __v: number;
        records: Record<string, UserGameOverride>;
        aliases: Record<string, string>;
      };
      expect(parsedAfter.__v).toBe(2);
      expect(Object.keys(parsedAfter.records)).toEqual(['gog-552200']);
      expect(parsedAfter.aliases['gog:552200']).toBe('gog-552200');
    });

    it('C4: patchUserOverrideReviewScore updates immutably, bumps updatedAt + revision, persists v2, and syncs to offlineVault', () => {
      const vaultSaveSpy = vi.fn().mockResolvedValue(true);
      (window as unknown as { electronAPI?: unknown }).electronAPI = {
        offlineVault: {
          saveUserOverride: vaultSaveSpy,
        },
      };

      saveUserOverride({
        gameId: 'gog-700100',
        platformId: 'gog',
        platformGameId: '700100',
        matchedStore: 'gog',
        title: 'Routed Score Game',
        reviewScoreOverride: {
          source: 'opencritic',
          score: 78,
          tier: 'Strong',
          url: 'https://opencritic.com/game/1234/routed-score-game',
          isVerified: true,
        },
        reviewRoute: {
          mode: 'routed',
          source: 'opencritic',
          openCriticId: 1234,
          targetTitle: 'Routed Score Game',
        },
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      const snapshotBefore = loadUserOverrides();
      const recordBefore = snapshotBefore['gog-700100'];
      const revBefore = getUserOverridesRevision();
      vaultSaveSpy.mockClear();

      const refreshed: CriticScoreData = {
        source: 'opencritic',
        score: 84,
        tier: 'Mighty',
        numReviews: 45,
        url: 'https://opencritic.com/game/1234/routed-score-game',
        isVerified: true,
      };

      patchUserOverrideReviewScore('gog:700100', refreshed);

      // Immutable: old object reference MUST NOT be mutated
      expect(recordBefore.reviewScoreOverride?.score).toBe(78);
      expect(getUserOverridesRevision()).toBe(revBefore + 1);

      const snapshotAfter = loadUserOverrides();
      expect(snapshotAfter['gog-700100']?.reviewScoreOverride?.score).toBe(84);
      expect(snapshotAfter['gog:700100']?.reviewScoreOverride?.score).toBe(84);
      expect(Date.parse(snapshotAfter['gog-700100']!.updatedAt)).toBeGreaterThan(
        Date.parse('2026-01-01T00:00:00.000Z')
      );

      // Deduplicated v2 format preserved on disk
      const disk = JSON.parse(localStorage.getItem(STORAGE_KEY_USER_OVERRIDES)!) as { __v: number };
      expect(disk.__v).toBe(2);

      // Synced to Electron offlineVault
      expect(vaultSaveSpy).toHaveBeenCalledTimes(1);
      expect(vaultSaveSpy.mock.calls[0][0]).toBe('gog-700100');
      expect((vaultSaveSpy.mock.calls[0][1] as UserGameOverride).reviewScoreOverride?.score).toBe(84);
    });

    it('C4: criticScoreService.resolveDynamicScore routed refresh persists via patchUserOverrideReviewScore (no in-place mutation)', async () => {
      const vaultSaveSpy = vi.fn().mockResolvedValue(true);
      (window as unknown as { electronAPI?: unknown }).electronAPI = {
        offlineVault: {
          saveUserOverride: vaultSaveSpy,
        },
      };

      saveUserOverride({
        gameId: 'gog-700199',
        platformId: 'gog',
        platformGameId: '700199',
        matchedStore: 'gog',
        title: 'Routed Refresh Game',
        reviewScoreOverride: {
          source: 'opencritic',
          score: 71,
          tier: 'Fair',
          url: 'https://opencritic.com/game/4321/routed-refresh-game',
          isVerified: true,
        },
        reviewRoute: {
          mode: 'routed',
          source: 'opencritic',
          openCriticId: 4321,
          targetTitle: 'Routed Refresh Game',
        },
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      const beforeRecord = loadUserOverrides()['gog-700199'];
      const revBefore = getUserOverridesRevision();
      vaultSaveSpy.mockClear();

      const ocSsrState = JSON.stringify({
        'game/4321': {
          id: 4321,
          name: 'Routed Refresh Game',
          topCriticScore: 87,
          percentRecommended: 92,
          numReviews: 55,
          tier: 'Mighty',
          url: 'https://opencritic.com/game/4321/routed-refresh-game',
        },
      })
        .replace(/&/g, '&a;')
        .replace(/"/g, '&q;')
        .replace(/'/g, '&s;')
        .replace(/</g, '&l;')
        .replace(/>/g, '&g;');
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          `<!DOCTYPE html><html><head><title>Routed Refresh Game Reviews - OpenCritic</title><link rel="canonical" href="https://opencritic.com/game/4321/routed-refresh-game" /></head><body><script id="serverApp-state" type="application/json">${ocSsrState}</script></body></html>`,
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        )
      );

      const resolved = await criticScoreService.resolveDynamicScore('Routed Refresh Game', null, 2024, null, {
        gameId: 'gog-700199',
        platforms: [{ platformId: 'gog', platformGameId: '700199' }],
        bypassAttempted: true,
      });

      expect(resolved?.score).toBe(87);
      expect(beforeRecord.reviewScoreOverride?.score).toBe(71);
      expect(getUserOverridesRevision()).toBeGreaterThan(revBefore);
      expect(loadUserOverrides()['gog-700199']?.reviewScoreOverride?.score).toBe(87);
      expect(vaultSaveSpy).toHaveBeenCalledTimes(1);
    });

    it('L2: strips unsafe URI schemes from override image and review URL fields while keeping https: and ol-media:', () => {
      type OverrideWithExtraArt = UserGameOverride & { heroImage?: string; logoImage?: string };
      const unsafeOverride: OverrideWithExtraArt = {
        gameId: 'gog-800200',
        platformId: 'gog',
        platformGameId: '800200',
        matchedStore: 'gog',
        title: 'Sanitized Media Game',
        capsuleImage: 'javascript:alert(1)',
        headerImage: 'file:///etc/passwd',
        heroImage: 'http://insecure.example.com/hero.jpg',
        logoImage: 'ol-media://vault/valid-logo.png',
        iconUrl: 'data:text/html,<script>alert(1)</script>',
        reviewScoreOverride: {
          source: 'custom',
          score: 88,
          tier: 'Mighty',
          url: 'javascript:void(0)',
          isVerified: true,
        },
        reviewRoute: {
          mode: 'static',
          source: 'custom',
          url: 'file:///etc/hosts',
        },
        updatedAt: '2026-03-01T00:00:00.000Z',
      };
      saveUserOverride(unsafeOverride);

      const stored = loadUserOverrides()['gog-800200'] as OverrideWithExtraArt;
      expect(stored.capsuleImage).toBeUndefined();
      expect(stored.headerImage).toBeUndefined();
      expect(stored.heroImage).toBeUndefined();
      expect(stored.logoImage).toBe('ol-media://vault/valid-logo.png');
      expect(stored.iconUrl).toBeUndefined();
      expect(stored.reviewScoreOverride?.url || '').toBe('');
      expect(stored.reviewRoute?.url).toBeUndefined();

      const applied = applyUserOverrideToGame(
        makeGame({ id: 'gog-800200', capsuleImage: 'https://images.gog-statics.com/safe.jpg' }),
        stored
      );
      expect(applied.capsuleImage).toBe('https://images.gog-statics.com/safe.jpg');
      expect(applied.iconUrl).toBeUndefined();

      // Verify FixMatchWizardModal enforces sanitizeAllowedStoreUri on override URL fields and first-class Xbox source
      const wizardSrc = fs.readFileSync(
        path.resolve(__dirname, '../src/components/Library/FixMatchWizardModal.tsx'),
        'utf-8'
      );
      expect(wizardSrc).toContain('sanitizeAllowedStoreUri');
      expect(wizardSrc).toContain("selectedCandidate.source === 'xbox'");
    });
  });

  // =========================================================================
  // 2. CriticScoreService & Sub-Resolvers (H4, H5, H6, H7, M2, L1)
  // =========================================================================
  describe('CriticScoreService & Sub-Resolvers Hardening (H4, H5, H6, H7, M2, L1)', () => {
    it('H4: single-game override removal performs O(1) targeted eviction without wiping unrelated cached games or calling clearCache()', () => {
      const targetScore: CriticScoreData = {
        id: 'mc-target-game',
        source: 'metacritic',
        score: 82,
        tier: 'Strong',
        url: 'https://www.metacritic.com/game/target-game/critic-reviews/',
        isVerified: true,
      };
      const unrelatedScore: CriticScoreData = {
        id: 'mc-unrelated-keeper',
        source: 'metacritic',
        score: 91,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/unrelated-keeper/critic-reviews/',
        isVerified: true,
      };

      criticScoreService.seedFromVaultIfMissing(500001, 'Target Game', targetScore, '2020-01-01');
      criticScoreService.seedFromVaultIfMissing(500002, 'Unrelated Keeper', unrelatedScore, '2020-01-01');

      expect(criticScoreService.getCriticScore(500001, 'Target Game', undefined, undefined, undefined, false, true)?.score).toBe(82);
      expect(criticScoreService.getCriticScore(500002, 'Unrelated Keeper', undefined, undefined, undefined, false, true)?.score).toBe(91);

      const clearCacheSpy = vi.spyOn(criticScoreService, 'clearCache');
      const evictSpy = vi.spyOn(criticScoreService, 'evictCriticCacheForGame');

      window.dispatchEvent(
        new CustomEvent('antigravity:user-override-removed', {
          detail: {
            gameId: 'steam-500001',
            oldOverride: {
              gameId: 'steam-500001',
              title: 'Target Game',
              steamAppId: 500001,
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        })
      );

      expect(clearCacheSpy).not.toHaveBeenCalled();
      expect(evictSpy).toHaveBeenCalledTimes(1);

      // Target game evicted from both memory & localStorage
      expect(localStorage.getItem('antigravity_critic_v8_id:500001')).toBeNull();
      expect(
        criticScoreService.getCriticScore(500001, 'Target Game', undefined, undefined, undefined, false, true)
      ).toBeNull();

      // Unrelated game remains intact in memory & localStorage
      expect(localStorage.getItem('antigravity_critic_v8_id:500002')).not.toBeNull();
      expect(
        criticScoreService.getCriticScore(500002, 'Unrelated Keeper', undefined, undefined, undefined, false, true)?.score
      ).toBe(91);
    });

    it('H7: getCriticScore() is pure during synchronous render (0 sync localStorage writes and 0 sync fetch calls)', async () => {
      KNOWN_CRITIC_SCORES[991122] = {
        id: 'mc-pure-render-verified',
        source: 'metacritic',
        score: 89,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/pure-render-verified/critic-reviews/',
        isVerified: true,
      };
      // Seed a poisoned staged entry to verify eviction is also deferred
      localStorage.setItem(
        'antigravity_critic_v8_title:poisoned render probe',
        JSON.stringify({
          data: {
            id: 'mc-totally-different-game',
            source: 'metacritic',
            score: 95,
            tier: 'Mighty',
            url: 'https://www.metacritic.com/game/totally-different-game/critic-reviews/',
            isVerified: true,
          },
          tier: 'immutable',
          cachedAt: Date.now(),
          ttlMs: 31536000000,
        })
      );

      const setItemSpy = vi.spyOn(mockStorage, 'setItem');
      const removeItemSpy = vi.spyOn(mockStorage, 'removeItem');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify([]), { status: 404 })
      );

      try {
        // 1. Verified KNOWN_CRITIC_SCORES hit
        const verified = criticScoreService.getCriticScore(991122, 'Pure Render Verified');
        expect(verified?.score).toBe(89);

        // 2. Poisoned cache entry rejection
        const rejected = criticScoreService.getCriticScore(null, 'Poisoned Render Probe');
        expect(rejected).toBeNull();

        // 3. Uncached title triggering dynamic resolution
        const uncached = criticScoreService.getCriticScore(null, 'Uncached Render Probe');
        expect(uncached).toBeNull();

        // Strictly zero synchronous storage mutations or network fetches during render!
        expect(setItemSpy).not.toHaveBeenCalled();
        expect(removeItemSpy).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();

        // After microtask flush, deferred persistence & eviction execute outside render
        await Promise.resolve();
        await Promise.resolve();
        expect(localStorage.getItem('antigravity_critic_v8_id:991122')).not.toBeNull();
        expect(localStorage.getItem('antigravity_critic_v8_title:poisoned render probe')).toBeNull();
      } finally {
        delete KNOWN_CRITIC_SCORES[991122];
      }
    });

    it('H7: findMatchingUserOverride enforces entitlement scoping (platforms) and breaks title ties by newest updatedAt', () => {
      saveUserOverride({
        gameId: 'gog-1001',
        platformId: 'gog',
        platformGameId: '1001',
        matchedStore: 'gog',
        title: 'Shared Horizon Title',
        reviewScoreOverride: { source: 'custom', score: 72, tier: 'Fair', url: '', isVerified: true },
        updatedAt: '2025-01-01T00:00:00.000Z',
      });
      saveUserOverride({
        gameId: 'epic-2002',
        platformId: 'epic',
        platformGameId: '2002',
        matchedStore: 'epic',
        title: 'Shared Horizon Title',
        reviewScoreOverride: { source: 'custom', score: 93, tier: 'Mighty', url: '', isVerified: true },
        updatedAt: '2026-06-01T00:00:00.000Z',
      });

      // Exact GOG entitlement gets GOG override (72), not Epic (93)
      const gogMatch = criticScoreService.findMatchingUserOverride(
        undefined,
        'Shared Horizon Title',
        undefined,
        [{ platformId: 'gog', platformGameId: '1001' }]
      );
      expect(gogMatch?.gameId).toBe('gog-1001');
      expect(gogMatch?.reviewScoreOverride?.score).toBe(72);

      // Unrelated Steam entitlement receives NO cross-entitlement bleed
      const steamMatch = criticScoreService.findMatchingUserOverride(
        555555,
        'Shared Horizon Title',
        'steam-555555',
        [{ platformId: 'steam', platformGameId: '555555' }]
      );
      expect(steamMatch).toBeUndefined();

      // Title-only fallback (no gameId/platforms) deterministically picks newest updatedAt (epic-2002)
      const titleOnly = criticScoreService.findMatchingUserOverride(undefined, 'Shared Horizon Title');
      expect(titleOnly?.gameId).toBe('epic-2002');
      expect(titleOnly?.reviewScoreOverride?.score).toBe(93);
    });

    it('M2: skips synchronous full localStorage scan and 12 MB catalog parse on startup once schema v16 flag is set', () => {
      localStorage.setItem('antigravity_critic_schema_v16', '1');
      localStorage.setItem(
        'universal_game_library_catalog',
        JSON.stringify([{ id: 'steam-1234', steamAppId: 1234, title: 'Sentinel Catalog Game' }])
      );

      const keySpy = vi.spyOn(mockStorage, 'key');
      const parseSpy = vi.spyOn(JSON, 'parse');

      const freshService = new CriticScoreService();
      try {
        freshService.getCriticScore(null, 'Nonexistent Startup Probe', undefined, undefined, undefined, false, true);
        expect(keySpy).not.toHaveBeenCalled();
        const parsedCatalog = parseSpy.mock.calls.some(
          ([arg]) => typeof arg === 'string' && arg.includes('Sentinel Catalog Game')
        );
        expect(parsedCatalog).toBe(false);
      } finally {
        freshService.disposeEventListeners();
      }
    });

    it('H5: steamReviewResolver classifies WAF HTML 200 SyntaxError as transient (never poisoning session cache) and expires genuine misses after 15m TTL', async () => {
      let wafAttempts = 0;
      let zeroReviewPhase: 'empty' | 'populated' = 'empty';
      let zeroReviewFetches = 0;

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/appreviews/770123')) {
          wafAttempts += 1;
          if (wafAttempts === 1) {
            // HTTP 200 with HTML challenge body and application/json header so res.json() throws SyntaxError
            return new Response('<!DOCTYPE html><html><body>Just a moment...</body></html>', {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(
            JSON.stringify({
              success: 1,
              query_summary: {
                total_positive: 90,
                total_reviews: 100,
                review_score_desc: 'Very Positive',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.includes('/app/770123')) {
          return new Response('<html><body>Checking your browser...</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        if (url.includes('/appreviews/770124')) {
          zeroReviewFetches += 1;
          if (zeroReviewPhase === 'empty') {
            return new Response(
              JSON.stringify({
                success: 1,
                query_summary: { total_positive: 0, total_reviews: 0 },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response(
            JSON.stringify({
              success: 1,
              query_summary: { total_positive: 45, total_reviews: 50 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      // 1. WAF HTML challenge with HTTP 200 -> res.json() throws SyntaxError -> transient_error, NOT cached
      const first = await steamReviewResolver.resolveScore('Synthetic WAF Game', 770123);
      expect(first).toBeNull();
      expect(steamReviewResolver.hadTransientError('Synthetic WAF Game', 770123)).toBe(true);

      // 2. Immediate retry succeeds because SyntaxError was NOT cached as permanent null
      const retried = await steamReviewResolver.resolveScore('Synthetic WAF Game', 770123);
      expect(retried).not.toBeNull();
      expect(retried?.score).toBeGreaterThan(0);
      expect(steamReviewResolver.hadTransientError('Synthetic WAF Game', 770123)).toBe(false);

      // 3. Genuine miss is negatively cached with bounded 15-minute TTL
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-01T12:00:00.000Z'));

      const miss1 = await steamReviewResolver.resolveScore('Synthetic Zero Reviews', 770124);
      expect(miss1).toBeNull();
      expect(zeroReviewFetches).toBe(1);

      // Within 15 min: served from negative cache (no extra fetch)
      vi.advanceTimersByTime(5 * 60 * 1000);
      const miss2 = await steamReviewResolver.resolveScore('Synthetic Zero Reviews', 770124);
      expect(miss2).toBeNull();
      expect(zeroReviewFetches).toBe(1);

      // Past 15 min TTL: re-fetches and upgrades when reviews appear
      zeroReviewPhase = 'populated';
      vi.advanceTimersByTime(11 * 60 * 1000);
      const upgraded = await steamReviewResolver.resolveScore('Synthetic Zero Reviews', 770124);
      expect(upgraded?.score).toBeGreaterThan(0);
      expect(zeroReviewFetches).toBe(2);
    });

    it('H6: storefrontReviewHarvester honors and records steam_appdetails_404_v1_ negative cache for delisted AppIDs', async () => {
      const axiosSpy = vi.spyOn(axios, 'get');

      // 1. Pre-seeded 404 negative cache -> 0 network calls
      localStorage.setItem(
        'antigravity_staged_steam_appdetails_404_v1_884040',
        JSON.stringify({
          data: true,
          tier: 'negative',
          cachedAt: Date.now(),
          ttlMs: 14 * 24 * 60 * 60 * 1000,
        })
      );
      const preCached = await storefrontReviewHarvester.getSteamAnchor(884040);
      expect(preCached).toBeNull();
      expect(axiosSpy).not.toHaveBeenCalled();

      // 2. Live delisted response ({ success: false }) records 14d negative cache so 2nd lookup skips network
      axiosSpy.mockResolvedValueOnce({
        status: 200,
        data: { '884041': { success: false } },
      } as unknown as Awaited<ReturnType<typeof axios.get>>);

      const firstMiss = await storefrontReviewHarvester.getSteamAnchor(884041);
      expect(firstMiss).toBeNull();
      expect(axiosSpy).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('antigravity_staged_steam_appdetails_404_v1_884041')).not.toBeNull();

      storefrontReviewHarvester.clearCache();
      const secondMiss = await storefrontReviewHarvester.getSteamAnchor(884041);
      expect(secondMiss).toBeNull();
      expect(axiosSpy).toHaveBeenCalledTimes(1);
    });

    it('L1: metacriticResolver tags offline anchor-only bundles with offlinePartialUserScore and upgrades user score once online', async () => {
      window.dispatchEvent(new Event('offline'));

      const offlineBundle = await metacriticResolver.resolveMetacritic(
        'Offline Anchor Chronicle',
        2024,
        {
          storefront: 'steam',
          metacriticScore: 86,
          metacriticSlug: 'offline-anchor-chronicle',
          metacriticUrl: 'https://www.metacritic.com/game/offline-anchor-chronicle/critic-reviews/',
        }
      );

      expect(offlineBundle.critic?.score).toBe(86);
      expect(offlineBundle.user).toBeNull();
      expect(offlineBundle.offlinePartialUserScore).toBe(true);

      // Reconnect -> partial cache is invalidated and live fetch populates both critic + user score
      const mockHtml = `
        <html>
          <head>
            <script type="application/ld+json">
              {"@type":"VideoGame","name":"Offline Anchor Chronicle","datePublished":"2024-03-01","aggregateRating":{"ratingValue":86,"reviewCount":42}}
            </script>
          </head>
          <body>
            <div class="c-siteReviewScore_user"><span>8.4</span></div>
            <span>Based on 215 User Ratings</span>
          </body>
        </html>
      `;
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(mockHtml, { status: 200, headers: { 'Content-Type': 'text/html' } })
      );

      onlineLifecycleManager.ensureInitialized();
    window.dispatchEvent(new Event('online'));

      const onlineBundle = await metacriticResolver.resolveMetacritic(
        'Offline Anchor Chronicle',
        2024,
        {
          storefront: 'steam',
          metacriticScore: 86,
          metacriticSlug: 'offline-anchor-chronicle',
          metacriticUrl: 'https://www.metacritic.com/game/offline-anchor-chronicle/critic-reviews/',
        }
      );

      expect(onlineBundle.critic?.score).toBe(86);
      expect(onlineBundle.user?.score).toBe(84);
      expect(onlineBundle.offlinePartialUserScore).toBeUndefined();
    });
  });

  // =========================================================================
  // 3. HLTB Collision Guard, Dedup & Debounce (H2, M1, L3)
  // =========================================================================
  describe('HLTB Subtitle Collision Guard, In-Flight Dedup & 2000ms Debounce (H2, M1, L3)', () => {
    it('H2: rejects conflicting colon subtitles (Mirage vs Valhalla) while allowing one-sided subtitle matches (Witcher 3 -> Wild Hunt)', () => {
      const mirageVsValhalla = findBestHltbMatch("Assassin's Creed: Mirage", [
        { game_name: "Assassin's Creed: Valhalla", comp_main: 216000, comp_plus: 350000, comp_100: 510000 },
      ]);
      expect(mirageVsValhalla).toBeNull();

      const siegeVsVegas = findBestHltbMatch("Tom Clancy's Rainbow Six: Siege", [
        { game_name: "Tom Clancy's Rainbow Six: Vegas", comp_main: 36000 },
      ]);
      expect(siegeVsVegas).toBeNull();

      const witcherBaseToSubtitle = findBestHltbMatch('The Witcher 3', [
        { game_name: 'The Witcher 3: Wild Hunt', comp_main: 185400, comp_plus: 370800, comp_100: 622800 },
      ]);
      expect(witcherBaseToSubtitle?.game_name).toBe('The Witcher 3: Wild Hunt');

      const witcherSubtitleToBase = findBestHltbMatch('The Witcher 3: Wild Hunt', [
        { game_name: 'The Witcher 3', comp_main: 185400 },
      ]);
      expect(witcherSubtitleToBase?.game_name).toBe('The Witcher 3');
    });

    it('M1 & L3: deduplicates concurrent fetchAndCacheHltb requests, debounces persistence to 2000ms, flushes on pagehide, and keeps stub DBs empty', async () => {
      expect(Object.keys(HLTB_DATABASE)).toEqual([]);
      expect(Object.keys(HLTB_TITLE_DATABASE)).toEqual([]);

      vi.useFakeTimers();

      let resolveSearch: ((val: { success: boolean; data: Array<{ game_name: string; comp_main: number }> }) => void) | null = null;
      const searchSpy = vi.fn(
        () =>
          new Promise<{ success: boolean; data: Array<{ game_name: string; comp_main: number }> }>((resolve) => {
            resolveSearch = resolve;
          })
      );

      (window as unknown as { electronAPI?: unknown }).electronAPI = {
        searchHltb: searchSpy,
      };

      // Concurrent viewport + background trickle calls share a single in-flight request
      const p1 = fetchAndCacheHltb('Dedup Chrono Quest', 980101);
      const p2 = fetchAndCacheHltb('Dedup Chrono Quest', 980101);
      expect(searchSpy).toHaveBeenCalledTimes(1);

      resolveSearch!({
        success: true,
        data: [{ game_name: 'Dedup Chrono Quest', comp_main: 43200 }],
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1?.mainStoryHours).toBe(12);
      expect(r2?.mainStoryHours).toBe(12);

      // Not persisted yet at 250ms (old 150ms debounce is gone)
      vi.advanceTimersByTime(250);
      expect(localStorage.getItem('one_launcher_hltb_lru_v3')).toBeNull();

      // Persists after 2000ms debounce
      vi.advanceTimersByTime(1850);
      expect(localStorage.getItem('one_launcher_hltb_lru_v3')).toContain('dedup chrono quest');

      // Also flushes immediately on pagehide when dirty
      localStorage.removeItem('one_launcher_hltb_lru_v3');
      searchSpy.mockResolvedValueOnce({
        success: true,
        data: [{ game_name: 'Pagehide Flush Quest', comp_main: 28800 }],
      });
      const r3 = await fetchAndCacheHltb('Pagehide Flush Quest', 980102);
      expect(r3?.mainStoryHours).toBe(8);
      expect(localStorage.getItem('one_launcher_hltb_lru_v3')).toBeNull();

      window.dispatchEvent(new Event('pagehide'));
      expect(localStorage.getItem('one_launcher_hltb_lru_v3')).toContain('pagehide flush quest');
    });
  });

  // =========================================================================
  // 4. Title Normalization Unification & First-Class Xbox Candidate Source (M5, M6)
  // =========================================================================
  describe('Title Normalization Unification & First-Class Xbox Candidate Source (M5, M6)', () => {
    it('M5: strips storefront distribution suffixes, HTML entities, and ligatures while preserving Remastered, Director\'s Cut, and sequel numbers', () => {
      expect(stripStorefrontDistributionSuffixes('Synthetic Odyssey - Amazon Prime')).toBe('Synthetic Odyssey');
      expect(stripStorefrontDistributionSuffixes('Synthetic Odyssey (Amazon Prime)')).toBe('Synthetic Odyssey');
      expect(stripPlatformAndDistributionNoise('Synthetic Odyssey PC Edition')).toBe('Synthetic Odyssey');
      expect(stripPlatformAndDistributionNoise('Synthetic Odyssey Game Preview')).toBe('Synthetic Odyssey');
      expect(stripPlatformAndDistributionNoise('Synthetic Odyssey Windows Edition')).toBe('Synthetic Odyssey');

      expect(normalizeTitleKey('Æther &amp; Blade 2 Remastered - Amazon Prime')).toBe(
        'aether blade 2 remastered'
      );
      expect(normalizeTitleKey("Shadow&#39;s Edge III: Director's Cut (Windows Edition)")).toBe(
        'shadows edge iii directors cut'
      );
      expect(
        normalizeTitleForStoreSearch("Shadow&#39;s Edge 2 Remastered - Amazon Prime", {
          stripEditions: false,
        })
      ).toBe("Shadow's Edge 2 Remastered");
      expect(
        normalizeTitleForStoreSearch('Synthetic Odyssey Remastered - Amazon Prime', {
          stripEditions: true,
        })
      ).toBe('Synthetic Odyssey');
    });

    it('M6: metadataScraperService emits first-class source: "xbox" for Xbox DisplayCatalog candidates', async () => {
      const fetchXboxSpy = vi.fn().mockResolvedValue({
        success: true,
        results: [
          {
            xboxProductId: '9NBLGGH4XBOX',
            title: 'Synthetic Xbox Horizon',
            capsuleImage: 'https://store-images.s-microsoft.com/image/apps.12345.poster.jpg',
            releaseDate: '2025-04-01',
            developer: 'Xbox Synthetic Dev',
            shortDescription: 'Explore a synthetic open world with full cross-play support.',
          },
        ],
      });

      (window as unknown as { electronAPI?: unknown }).electronAPI = {
        fetchXboxProductMetadata: fetchXboxSpy,
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ items: [], products: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const candidates = await metadataScraperService.searchStorefronts(
        'Synthetic Xbox Horizon',
        'xbox'
      );

      const xboxCandidates = candidates.filter((c) => c.source === 'xbox');
      expect(xboxCandidates.length).toBeGreaterThanOrEqual(1);
      expect(xboxCandidates.some((c) => c.id === 'xbox-9NBLGGH4XBOX')).toBe(true);
    });
  });

  // =========================================================================
  // 5. Synopsis Sanitizer & Match Studio Diagnostics (C3, H8)
  // =========================================================================
  describe('Synopsis Sanitizer & Match Studio Diagnostics (C3, H8)', () => {
    it('H8: strips empty-label Markdown links like [](/discover/v-bucks) and flags standalone link artifacts as missing synopsis', () => {
      expect(isEmptyMarkdownLinkArtifact('[](/discover/v-bucks)')).toBe(true);
      expect(stripHtmlToPlainSynopsis('[](/discover/v-bucks)')).toBe('');
      expect(
        stripHtmlToPlainSynopsis('[](/discover/v-bucks)\nBuild, battle, and create with friends.')
      ).toBe('Build, battle, and create with friends.');

      const brokenArtifactGame = makeGame({
        id: 'epic-empty-link-1',
        title: 'Battle Builder Royale',
        platforms: [{ platformId: 'epic', platformGameId: 'empty-link-1', installed: false }],
        capsuleImage: 'https://cdn1.epicgames.com/offer/sample/portrait_cover.jpg',
        shortDescription: '[](/discover/v-bucks)',
        enrichedMetadata: {
          appId: 0,
          name: 'Battle Builder Royale',
          shortDescription: '[](/discover/v-bucks)',
          detailedDescription: '',
          aboutTheGame: '',
          headerImage: 'https://cdn1.epicgames.com/offer/sample/header.jpg',
          releaseDate: '2024-01-15',
          genres: ['Action'],
          tags: [],
          categories: [],
          screenshots: [],
          movies: [],
          systemRequirements: {},
          reviewSummary: {
            reviewScore: 0,
            reviewScoreDesc: '',
            totalPositive: 0,
            totalNegative: 0,
            totalReviews: 0,
            positivePercent: 0,
          },
          developers: ['Builder Studio'],
          publishers: ['Builder Pub'],
          metadataQuality: 'authoritative',
        },
      });

      expect(hasGenuineStoreSynopsis(brokenArtifactGame)).toBe(false);
      // Unprobed empty-markdown artifact triggers Match Studio auto-repair probe
      expect(isSynopsisAlreadyProbed(brokenArtifactGame)).toBe(false);
      // Once probed without finding a replacement, flagged cleanly as Missing Store Synopsis
      expect(
        getGranularUnmatchedReasons(brokenArtifactGame, undefined, {
          [brokenArtifactGame.id]: null,
        }).map((r) => r.label)
      ).toContain('Missing Store Synopsis');
    });

    it('H8: accepts genuine official short taglines (>= 10 chars) with authoritative provenance while flagging < 10 char junk and unenriched short stubs', () => {
      const officialTaglines = [
        'Relive Half-Life.',
        'THE LEGEND BEGINS',
        'Eliminate the Enemy',
        'NOTHING HITS LIKE MADDEN',
      ];

      for (const [idx, tagline] of officialTaglines.entries()) {
        const verifiedGame = makeGame({
          id: `steam-${600100 + idx}`,
          title: `Authoritative Classic ${idx + 1}`,
          steamAppId: 600100 + idx,
          platforms: [{ platformId: 'steam', platformGameId: String(600100 + idx), installed: false }],
          capsuleImage: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${600100 + idx}/library_600x900_2x.jpg`,
          shortDescription: tagline,
        });
        expect(hasGenuineStoreSynopsis(verifiedGame)).toBe(true);
        expect(getGranularUnmatchedReasons(verifiedGame).map((r) => r.label)).not.toContain(
          'Missing Store Synopsis'
        );
      }

      // < 10 char junk is STILL flagged even with Steam provenance
      const tooShortJunk = makeGame({
        id: 'steam-600199',
        title: 'Tiny Junk Tagline Game',
        steamAppId: 600199,
        platforms: [{ platformId: 'steam', platformGameId: '600199', installed: false }],
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/600199/library_600x900_2x.jpg',
        shortDescription: 'Play now!',
      });
      expect(hasGenuineStoreSynopsis(tooShortJunk)).toBe(false);
      expect(getGranularUnmatchedReasons(tooShortJunk).map((r) => r.label)).toContain(
        'Missing Store Synopsis'
      );

      // Unenriched non-authoritative GOG short stub (< 25 chars) is STILL flagged
      const unenrichedStub = makeGame({
        id: 'gog-600200',
        title: 'Unenriched Stub Game',
        platforms: [{ platformId: 'gog', platformGameId: '600200', installed: false }],
        capsuleImage: 'https://images.gog-statics.com/vertical_box.jpg',
        shortDescription: 'Too short blurb.',
      });
      expect(hasGenuineStoreSynopsis(unenrichedStub)).toBe(false);
      expect(getGranularUnmatchedReasons(unenrichedStub).map((r) => r.label)).toContain(
        'Missing Store Synopsis'
      );
    });

    it('C3: checks effective 2:3 cover availability across GOG vertical cache and IGDB cover cache before flagging Missing 2:3 Cover Art', () => {
      const gameWithWideHeaderOnly = makeGame({
        id: 'gog-712345',
        title: 'Cached Vertical Cover Quest',
        platforms: [{ platformId: 'gog', platformGameId: '712345', installed: false }],
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/100/header.jpg',
        shortDescription: 'A complete tactical RPG adventure with deep party customization.',
      });

      // Without cached cover: flagged as Missing 2:3 Cover Art
      expect(hasEffectiveVerticalCover(gameWithWideHeaderOnly)).toBe(false);
      expect(getGranularUnmatchedReasons(gameWithWideHeaderOnly).map((r) => r.label)).toContain(
        'Missing 2:3 Cover Art'
      );

      // With cached GOG vertical cover: NOT flagged
      const gogSpy = vi
        .spyOn(igdbCoverService, 'getGogVerticalCoverInstant')
        .mockReturnValue('https://images.gog-statics.com/cached_vertical_712345_boxart.jpg');
      expect(hasEffectiveVerticalCover(gameWithWideHeaderOnly)).toBe(true);
      expect(getGranularUnmatchedReasons(gameWithWideHeaderOnly).map((r) => r.label)).not.toContain(
        'Missing 2:3 Cover Art'
      );
      gogSpy.mockRestore();

      // With cached IGDB cover: NOT flagged
      const igdbSpy = vi
        .spyOn(igdbCoverService, 'getIgdbCoverInstant')
        .mockReturnValue('https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co9999.jpg');
      expect(hasEffectiveVerticalCover(gameWithWideHeaderOnly)).toBe(true);
      expect(getGranularUnmatchedReasons(gameWithWideHeaderOnly).map((r) => r.label)).not.toContain(
        'Missing 2:3 Cover Art'
      );
      igdbSpy.mockRestore();
    });
  });
});
