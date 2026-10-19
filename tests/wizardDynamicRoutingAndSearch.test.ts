import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { CanonicalGame } from '../src/contracts/game';
import type {
  UserGameOverride,
  SearchMatchCandidate,
  ScrapedMetadataBundle,
  ReviewScoreRoute,
} from '../src/contracts/override';
import type { CriticScoreData } from '../src/contracts/critic';
import { FixMatchWizardModal } from '../src/components/Library/FixMatchWizardModal';
import { syncJobManager, SyncJobManager } from '../src/services/network/syncJobManager';
import { requestScheduler, Priority } from '../src/services/network/requestScheduler';
import {
  saveUserOverride,
  loadUserOverrides,
  inferReviewRouteFromOverride,
  inferMetadataRouteFromOverride,
  updateRoutedMetadataSnapshot,
  applyUserOverrideToGame,
  STORAGE_KEY_USER_OVERRIDES,
} from '../src/services/storage/userOverrideStorage';
import { criticScoreService } from '../src/services/critic/criticScoreService';
import {
  MutabilityTier,
  loadStagedCache,
  saveStagedCache,
} from '../src/services/storage/stagedCacheService';
import { metadataScraperService } from '../src/services/scraper/metadataScraperService';
import {
  reviewCandidateService,
  ReviewCandidateOption,
} from '../src/services/scraper/reviewCandidateService';
import { metacriticResolver } from '../src/services/critic/metacriticResolver';
import { steamReviewResolver } from '../src/services/critic/steamReviewResolver';
import { storefrontStarResolver } from '../src/services/critic/storefrontStarResolver';
import { storefrontReviewHarvester } from '../src/services/critic/storefrontReviewHarvester';
import { steamApi } from '../src/services/steam/steamApi';
import { fallbackMetadataProvider } from '../src/services/steam/fallbackMetadataProvider';
import { igdbCoverService } from '../src/services/igdb/igdbCoverService';

// ---------------------------------------------------------------------------
// Environment Polyfills & Test Setup
// ---------------------------------------------------------------------------

class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

const mockStorage = new MockStorage();

if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = mockStorage;
}

const eventTarget = new EventTarget();

if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = {
    addEventListener: (type: string, listener: any) => eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: any) =>
      eventTarget.removeEventListener(type, listener),
    dispatchEvent: (event: any) => eventTarget.dispatchEvent(event),
    localStorage: mockStorage,
    location: { hostname: 'example.com' },
  };
} else {
  if (typeof (window as any).addEventListener === 'undefined') {
    (window as any).addEventListener = (type: string, listener: any) =>
      eventTarget.addEventListener(type, listener);
    (window as any).removeEventListener = (type: string, listener: any) =>
      eventTarget.removeEventListener(type, listener);
    (window as any).dispatchEvent = (event: any) => eventTarget.dispatchEvent(event);
  }
  if (!(window as any).location) {
    (window as any).location = { hostname: 'example.com' };
  }
}

if (typeof (globalThis as any).CustomEvent === 'undefined') {
  (globalThis as any).CustomEvent = class CustomEvent {
    type: string;
    detail: any;
    constructor(type: string, init?: any) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
}

criticScoreService.initEventListeners();

describe('Fix & Match Wizard: Priority Scopes, Dynamic Routing & Cross-Storefront Search', () => {
  beforeEach(() => {
    mockStorage.clear();
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    criticScoreService.clearCache();
    syncJobManager.reset();
    requestScheduler.setEnforceDelays(false);
  });

  afterEach(() => {
    syncJobManager.reset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ===========================================================================
  // TASK 3: SyncJobManager Priority Scope Lifecycle & GlobalSyncProgressBar Fix
  // ===========================================================================
  describe('Task 3: SyncJobManager Priority Scopes, Auto-Clear & Timeout Guards', () => {
    it('handles overlapping priority scopes (scope 1 ends first, scope 2 ends second) without getting stuck in running and auto-clears after 1500ms', () => {
      vi.useFakeTimers();
      const manager = new SyncJobManager();

      const scope1 = manager.beginPriorityScope('Matching Game Metadata', 'The Saboteur');
      expect(manager.getState()?.id).toBe(`priority-${scope1}`);
      expect(manager.getState()?.headline).toBe('Matching Game Metadata');
      expect(manager.getState()?.status).toBe('running');

      // Overlapping second priority scope begins before scope 1 finishes
      const scope2 = manager.beginPriorityScope('Scraping Match Metadata', 'The Saboteur');

      // Scope 1 finishes first while Scope 2 is still running
      manager.endPriorityScope(scope1);

      const midState = manager.getState();
      expect(midState).not.toBeNull();
      expect(midState?.id).toBe(`priority-${scope2}`);
      expect(midState?.headline).toBe('Scraping Match Metadata');
      expect(midState?.status).toBe('running');
      expect(midState?.isPreempted).toBe(true);

      // Scope 2 finishes second -> must transition to 'completed' (never stuck in 'running')
      manager.endPriorityScope(scope2);

      const completedState = manager.getState();
      expect(completedState).not.toBeNull();
      expect(completedState?.id).toBe(`priority-${scope2}`);
      expect(completedState?.status).toBe('completed');
      expect(completedState?.isPreempted).toBe(false);

      // Advance 1500ms -> state auto-clears to null
      vi.advanceTimersByTime(1500);
      expect(manager.getState()).toBeNull();
    });

    it('endAllPriorityScopes() clears all active scopes, calls requestScheduler.endInteractiveScope, resolves preemptionResolvers, and clears standalone priority-* state', async () => {
      const manager = new SyncJobManager();
      const endInteractiveSpy = vi.spyOn(requestScheduler, 'endInteractiveScope');

      const scopeA = manager.beginPriorityScope('Matching Game Metadata', 'Prodeus');
      const scopeB = manager.beginPriorityScope('Scraping Match Metadata', 'Prodeus');
      expect(manager.isPriorityPreempted()).toBe(true);
      expect(manager.getState()?.id.startsWith('priority-')).toBe(true);

      // Simulate a background task waiting on preemptionResolvers
      let backgroundResumed = false;
      const waitPromise = (manager as any).waitWhilePausedOrPreempted().then(() => {
        backgroundResumed = true;
      });

      manager.endAllPriorityScopes();
      await waitPromise;

      expect(manager.isPriorityPreempted()).toBe(false);
      expect(endInteractiveSpy).toHaveBeenCalledWith(scopeA);
      expect(endInteractiveSpy).toHaveBeenCalledWith(scopeB);
      expect(backgroundResumed).toBe(true);
      expect(manager.getState()).toBeNull();
    });

    it('runPriorityAction timeout race rejects a hung promise after timeoutMs and cleans up its priority scope in finally', async () => {
      vi.useFakeTimers();
      const manager = new SyncJobManager();

      const hungAction = manager.runPriorityAction(
        'Scraping Match Metadata',
        'Hung Title',
        () => new Promise<string>(() => {}),
        2500
      );

      expect(manager.isPriorityPreempted()).toBe(true);
      expect(manager.getState()?.headline).toBe('Scraping Match Metadata');

      const rejectionAssertion = expect(hungAction).rejects.toThrow(
        'Priority action "Scraping Match Metadata" timed out after 2500ms'
      );

      await vi.advanceTimersByTimeAsync(2500);
      await rejectionAssertion;

      // Priority scope must be cleaned up in finally
      expect(manager.isPriorityPreempted()).toBe(false);
      expect(manager.getState()?.status).toBe('completed');
    });
  });

  // ===========================================================================
  // TASK 2: Dynamic Review & Metadata Routing vs. Static Custom Values
  // ===========================================================================
  describe('Task 2: ReviewScoreRoute Inference, Mutability Tiers & Live Route Sync', () => {
    it('inferReviewRouteFromOverride accurately infers unrated, static, and routed modes with provider identifiers', () => {
      // 1. Unrated
      const unratedOv: UserGameOverride = {
        gameId: 'gog-1',
        matchedStore: 'gog',
        reviewScoreOverride: null,
        updatedAt: new Date().toISOString(),
      };
      expect(inferReviewRouteFromOverride(unratedOv)).toEqual({ mode: 'unrated' });

      // 2. Static custom
      const staticOv: UserGameOverride = {
        gameId: 'steam-100',
        matchedStore: 'steam',
        reviewScoreOverride: {
          source: 'custom',
          score: 90,
          tier: 'Mighty',
          url: 'https://example.com/custom-review',
          isVerified: false,
        },
        updatedAt: new Date().toISOString(),
      };
      expect(inferReviewRouteFromOverride(staticOv)).toEqual({
        mode: 'static',
        source: 'custom',
        url: 'https://example.com/custom-review',
      });

      // 3. Routed provider with extracted slugs/IDs
      const routedOv: UserGameOverride = {
        gameId: 'gog-1458058109',
        matchedStore: 'gog',
        matchedId: '1458058109',
        title: 'The Saboteur',
        steamAppId: 24880,
        storefrontAnchor: {
          storefront: 'gog',
          metacriticSlug: 'the-saboteur',
          openCriticId: 4321,
        },
        reviewScoreOverride: {
          source: 'metacritic',
          score: 76,
          tier: 'Strong',
          url: 'https://www.metacritic.com/game/pc/the-saboteur/critic-reviews/',
          isVerified: true,
        },
        updatedAt: new Date().toISOString(),
      };
      expect(inferReviewRouteFromOverride(routedOv)).toEqual({
        mode: 'routed',
        source: 'metacritic',
        url: 'https://www.metacritic.com/game/pc/the-saboteur/critic-reviews/',
        metacriticSlug: 'the-saboteur',
        openCriticId: 4321,
        steamAppId: 24880,
        gogId: '1458058109',
        epicId: undefined,
        targetTitle: 'The Saboteur',
      });
    });

    it('saveUserOverride persists reviewRoute and metadataRoute and auto-populates reviewRoute when omitted', () => {
      const override: UserGameOverride = {
        gameId: 'gog-saboteur',
        platformId: 'gog',
        platformGameId: '1458058109',
        matchedStore: 'gog',
        matchedId: '1458058109',
        title: 'The Saboteur',
        reviewScoreOverride: {
          source: 'opencritic',
          score: 78,
          tier: 'Strong',
          url: 'https://opencritic.com/game/999/the-saboteur',
          isVerified: true,
        },
        metadataRoute: {
          source: 'steam',
          matchedId: 24880,
          steamAppId: 24880,
          gogId: '1458058109',
        },
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(override);

      const stored = loadUserOverrides()['gog-saboteur'];
      expect(stored).toBeDefined();
      expect(stored.metadataRoute).toEqual({
        mode: 'routed',
        source: 'steam',
        matchedId: 24880,
        steamAppId: 24880,
        gogId: '1458058109',
      });
      expect(stored.reviewRoute).toBeDefined();
      expect(stored.reviewRoute?.mode).toBe('routed');
      expect(stored.reviewRoute?.source).toBe('opencritic');
      expect(stored.reviewRoute?.openCriticId).toBe(999);
    });

    it('Step 4 dynamic MetadataSourceRoute: updates routed metadata snapshots while protecting custom-edited fields and invalidating stale enrichedMetadata', async () => {
      // 1. Save a routed override where customSynopsisEdited is true (pinned) and customTitleEdited is false (routed)
      const override: UserGameOverride = {
        gameId: 'epic-saboteur',
        platformId: 'epic',
        platformGameId: 'saboteur-epic-id',
        matchedStore: 'epic',
        matchedId: 'saboteur-epic-id',
        title: 'The Saboteur',
        shortDescription: 'My custom hand-crafted synopsis that should never be overwritten!',
        detailedDescription: '<p>Initial description</p>',
        developers: ['Pandemic Studios'],
        steamAppId: null,
        isExplicitNonSteam: true,
        capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co_custom.jpg',
        metadataRoute: {
          mode: 'routed',
          source: 'gog',
          matchedId: '1458058109',
          gogId: '1458058109',
          targetTitle: 'The Saboteur',
          customTitleEdited: false,
          customSynopsisEdited: true,
        },
        updatedAt: new Date().toISOString(),
      };
      saveUserOverride(override);

      // 2. Verify applyUserOverrideToGame invalidates stale Steam enrichedMetadata when routed to GOG/non-Steam
      const staleGame: CanonicalGame = {
        id: 'epic-saboteur',
        title: 'Saboteur Old',
        sortTitle: 'Saboteur Old',
        steamAppId: 99999,
        capsuleImage: 'old.jpg',
        headerImage: 'old-header.jpg',
        platforms: [{ platformId: 'epic', platformGameId: 'saboteur-epic-id', installed: true }],
        enrichedMetadata: {
          appId: 99999,
          name: 'Wrong Old Steam Game',
          shortDescription: 'Wrong',
          detailedDescription: 'Wrong',
          aboutTheGame: 'Wrong',
          headerImage: 'wrong.jpg',
          capsuleImage: 'wrong.jpg',
          iconUrl: '',
          developers: ['Wrong Dev'],
          publishers: ['Wrong Pub'],
          releaseDate: '2000',
          genres: ['Wrong'],
          tags: [],
          categories: [],
          screenshots: [{ id: 1, pathThumbnail: 'wrong-ss.jpg', pathFull: 'wrong-ss.jpg' }],
          movies: [],
          systemRequirements: {},
        },
      };

      const applied = applyUserOverrideToGame(staleGame, override);
      expect(applied.enrichedMetadata).toBeUndefined();
      expect(applied.isExplicitNonSteam).toBe(true);
      expect(applied.capsuleImage).toBe(
        'https://images.igdb.com/igdb/image/upload/t_cover_big/co_custom.jpg'
      );

      // 3. Verify fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame routes via metadataRoute.gogId
      // even though the game's platform is 'epic' (not 'gog')!
      vi.spyOn(fallbackMetadataProvider, 'fetchGogProductMetadata').mockResolvedValueOnce({
        name: 'The Saboteur (GOG Updated)',
        shortDescription: 'Official GOG store synopsis',
        detailedDescription: '<p>Updated GOG About This Game full HTML with new patch notes</p>',
        aboutTheGame: '<p>Updated GOG About This Game full HTML with new patch notes</p>',
        developers: ['Pandemic Studios', 'EA'],
        publishers: ['Electronic Arts'],
        genres: ['Action', 'Open World'],
        releaseDate: 'Dec 4, 2009',
        screenshots: [
          {
            id: 101,
            pathThumbnail: 'https://images.gog.com/ss1_thumb.jpg',
            pathFull: 'https://images.gog.com/ss1_full.jpg',
          },
        ],
        movies: [
          {
            id: 202,
            name: 'GOG Launch Trailer',
            thumbnail: 'https://images.gog.com/trailer_thumb.jpg',
            mp4: { '480': 'https://video.gog.com/trailer.mp4', max: 'https://video.gog.com/trailer.mp4' },
            highlight: true,
          },
        ],
        systemRequirements: {
          minimum: '<strong>Minimum:</strong> Windows XP / Vista / 7 / 10',
        },
      });

      const enriched = await fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(applied);
      expect(fallbackMetadataProvider.fetchGogProductMetadata).toHaveBeenCalledWith(
        '1458058109',
        'The Saboteur'
      );
      expect(enriched.screenshots).toHaveLength(1);
      expect(enriched.screenshots[0].pathFull).toBe('https://images.gog.com/ss1_full.jpg');
      expect(enriched.movies).toHaveLength(1);
      expect(enriched.systemRequirements.minimum).toContain('Windows XP');
      expect(enriched.detailedDescription).toContain('Updated GOG About This Game full HTML');

      // 4. Verify updateRoutedMetadataSnapshot updated the unpinned fields in localStorage
      // while preserving the user's pinned customSynopsisEdited!
      const updatedStored = loadUserOverrides()['epic-saboteur'];
      expect(updatedStored.title).toBe('The Saboteur (GOG Updated)');
      expect(updatedStored.shortDescription).toBe(
        'My custom hand-crafted synopsis that should never be overwritten!'
      );
      expect(updatedStored.detailedDescription).toBe(
        '<p>Updated GOG About This Game full HTML with new patch notes</p>'
      );
      expect(updatedStored.developers).toEqual(['Pandemic Studios', 'EA']);
      expect(updatedStored.genres).toEqual(['Action', 'Open World']);
    });

    it('criticScoreService.handleUserOverride saves unrated and static overrides with TIER_0_USER_OVERRIDE, and routed overrides with dynamic mutability tier', () => {
      // 1. Unrated -> TIER_0_USER_OVERRIDE
      criticScoreService.handleUserOverride({
        gameId: 'steam-111',
        steamAppId: 111,
        matchedStore: 'steam',
        title: 'Unrated Game',
        reviewScoreOverride: null,
        reviewRoute: { mode: 'unrated' },
        updatedAt: new Date().toISOString(),
      });
      const unratedStaged = loadStagedCache<CriticScoreData>('antigravity_critic_v8_id:111', false);
      expect(unratedStaged.entry?.tier).toBe(MutabilityTier.TIER_0_USER_OVERRIDE);
      expect(unratedStaged.entry?.data).toBeNull();

      // 2. Static custom -> TIER_0_USER_OVERRIDE
      criticScoreService.handleUserOverride({
        gameId: 'steam-222',
        steamAppId: 222,
        matchedStore: 'steam',
        title: 'Static Custom Game',
        reviewScoreOverride: {
          source: 'custom',
          score: 92,
          tier: 'Mighty',
          url: 'https://example.com',
          isVerified: false,
        },
        reviewRoute: { mode: 'static', source: 'custom', url: 'https://example.com' },
        updatedAt: new Date().toISOString(),
      });
      const staticStaged = loadStagedCache<CriticScoreData>('antigravity_critic_v8_id:222', false);
      expect(staticStaged.entry?.tier).toBe(MutabilityTier.TIER_0_USER_OVERRIDE);
      expect(staticStaged.entry?.data?.score).toBe(92);

      // 3. Routed provider -> Dynamic Mutability Tier (TIER_3_FRESH / TIER_2_MATURE / TIER_1_IMMUTABLE)
      criticScoreService.handleUserOverride({
        gameId: 'steam-333',
        steamAppId: 333,
        matchedStore: 'steam',
        title: 'Routed Recent Game',
        releaseDate: new Date().toISOString().slice(0, 10), // Fresh release
        reviewScoreOverride: {
          source: 'metacritic',
          score: 81,
          tier: 'Strong',
          url: 'https://www.metacritic.com/game/routed-recent-game/',
          isVerified: true,
        },
        reviewRoute: {
          mode: 'routed',
          source: 'metacritic',
          metacriticSlug: 'routed-recent-game',
          targetTitle: 'Routed Recent Game',
        },
        updatedAt: new Date().toISOString(),
      });
      const routedStaged = loadStagedCache<CriticScoreData>('antigravity_critic_v8_id:333', false);
      expect(routedStaged.entry?.tier).not.toBe(MutabilityTier.TIER_0_USER_OVERRIDE);
      expect([
        MutabilityTier.TIER_3_FRESH,
        MutabilityTier.TIER_2_MATURE,
        MutabilityTier.TIER_1_IMMUTABLE,
      ]).toContain(routedStaged.entry?.tier);
      expect(routedStaged.entry?.data?.score).toBe(81);
    });

    it('resolveRoutedScore and resolveDynamicScore dynamically fetch updated scores across providers and update caches + localStorage while falling back when offline', async () => {
      // 1. Metacritic Critic & User routes
      vi.spyOn(metacriticResolver, 'resolveMetacritic').mockResolvedValue({
        critic: {
          id: 'mc-saboteur',
          source: 'metacritic',
          score: 79,
          tier: 'Strong',
          url: 'https://www.metacritic.com/game/the-saboteur/critic-reviews/',
          numReviews: 45,
          isVerified: true,
        },
        user: {
          id: 'mc-user-saboteur',
          source: 'metacritic_user',
          score: 85,
          userScoreRaw: 8.5,
          tier: 'Mighty',
          url: 'https://www.metacritic.com/game/the-saboteur/user-reviews/',
          numReviews: 320,
          isVerified: false,
        },
      });

      const mcCriticRes = await criticScoreService.resolveRoutedScore(
        {
          mode: 'routed',
          source: 'metacritic',
          metacriticSlug: 'the-saboteur',
          targetTitle: 'The Saboteur',
        },
        'The Saboteur',
        2009
      );
      expect(mcCriticRes?.score).toBe(79);
      expect(mcCriticRes?.source).toBe('metacritic');

      const mcUserRes = await criticScoreService.resolveRoutedScore(
        {
          mode: 'routed',
          source: 'metacritic_user',
          metacriticSlug: 'the-saboteur',
          targetTitle: 'The Saboteur',
        },
        'The Saboteur',
        2009
      );
      expect(mcUserRes?.score).toBe(85);
      expect(mcUserRes?.source).toBe('metacritic_user');

      // 2. OpenCritic route via resolveRoutedScore
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 4321,
          name: 'The Saboteur',
          topCriticScore: 82.4,
          percentRecommended: 84,
          tier: 'Strong',
          numReviews: 38,
          reviewSummary: { summary: 'Stylish open-world WWII action.' },
        }),
      } as unknown as Response);

      const ocRes = await criticScoreService.resolveRoutedScore(
        {
          mode: 'routed',
          source: 'opencritic',
          openCriticId: 4321,
          targetTitle: 'The Saboteur',
        },
        'The Saboteur',
        2009
      );
      expect(ocRes?.score).toBe(82);
      expect(ocRes?.source).toBe('opencritic');
      fetchSpy.mockRestore();

      // 3. Steam route via resolveRoutedScore
      vi.spyOn(steamReviewResolver, 'resolveScore').mockResolvedValue({
        id: 'steam-24880',
        source: 'steam',
        score: 88,
        tier: 'Mighty',
        percentRecommended: 90,
        numReviews: 4200,
        url: 'https://store.steampowered.com/app/24880',
        isVerified: false,
        isSynthetic: true,
      });

      const steamRes = await criticScoreService.resolveRoutedScore(
        {
          mode: 'routed',
          source: 'steam',
          steamAppId: 24880,
          targetTitle: 'The Saboteur',
        },
        'The Saboteur'
      );
      expect(steamRes?.score).toBe(88);
      expect(steamRes?.source).toBe('steam');

      // 4. GOG route via resolveRoutedScore
      vi.spyOn(storefrontStarResolver, 'resolveScore').mockResolvedValue({
        id: 'gog-1458058109',
        source: 'gog',
        score: 86,
        tier: 'Mighty',
        starRatingRaw: 4.3,
        numReviews: 910,
        url: 'https://www.gog.com/en/game/saboteur',
        isVerified: false,
      });

      const gogRes = await criticScoreService.resolveRoutedScore(
        {
          mode: 'routed',
          source: 'gog',
          gogId: '1458058109',
          targetTitle: 'The Saboteur',
        },
        'The Saboteur'
      );
      expect(gogRes?.score).toBe(86);
      expect(gogRes?.source).toBe('gog');

      // 5. Full resolveDynamicScore updates inMemoryCache, stagedCache, and STORAGE_KEY_USER_OVERRIDES
      saveUserOverride({
        gameId: 'gog-1458058109',
        platformId: 'gog',
        platformGameId: '1458058109',
        matchedStore: 'gog',
        matchedId: '1458058109',
        title: 'The Saboteur',
        steamAppId: null,
        reviewScoreOverride: {
          source: 'metacritic',
          score: 73, // Initial snapshot score
          tier: 'Fair',
          url: 'https://www.metacritic.com/game/the-saboteur/critic-reviews/',
          isVerified: true,
        },
        reviewRoute: {
          mode: 'routed',
          source: 'metacritic',
          metacriticSlug: 'the-saboteur',
          targetTitle: 'The Saboteur',
        },
        updatedAt: new Date().toISOString(),
      });

      const refreshed = await criticScoreService.resolveDynamicScore(
        'The Saboteur',
        null,
        2009,
        undefined,
        { bypassAttempted: true, gameId: 'gog-1458058109' }
      );
      expect(refreshed?.score).toBe(79); // Updated from 73 -> 79!

      const stagedAfter = loadStagedCache<CriticScoreData>(
        'antigravity_critic_v8_title:the saboteur',
        false
      );
      expect(stagedAfter.data?.score).toBe(79);

      const overridesAfter = loadUserOverrides();
      expect(overridesAfter['gog-1458058109'].reviewScoreOverride?.score).toBe(79);
      expect(overridesAfter['gog:1458058109'].reviewScoreOverride?.score).toBe(79);

      // 6. Graceful offline fallback when resolver fails/returns null
      vi.spyOn(metacriticResolver, 'resolveMetacritic').mockRejectedValueOnce(
        new Error('Network offline')
      );
      const fallbackResult = await criticScoreService.resolveDynamicScore(
        'The Saboteur',
        null,
        2009,
        undefined,
        { bypassAttempted: true, gameId: 'gog-1458058109' }
      );
      expect(fallbackResult?.score).toBe(79);
    });

    it('syncJobManager.startCriticScoreSync refreshes routed user overrides when forceRefresh: true or when staged cache entry has expired', async () => {
      const game: CanonicalGame = {
        id: 'gog-1458058109',
        title: 'The Saboteur',
        sortTitle: 'Saboteur',
        platforms: [{ platformId: 'gog', platformGameId: '1458058109', installed: true }],
        headerImage: '',
        developers: ['Pandemic Studios'],
        publishers: ['EA'],
        genres: ['Action'],
        tags: [],
        releaseDate: '2009',
      };

      saveUserOverride({
        gameId: game.id,
        matchedStore: 'gog',
        matchedId: '1458058109',
        title: 'The Saboteur',
        steamAppId: null,
        reviewScoreOverride: {
          source: 'metacritic',
          score: 75,
          tier: 'Strong',
          url: 'https://www.metacritic.com/game/the-saboteur/critic-reviews/',
          isVerified: true,
        },
        reviewRoute: {
          mode: 'routed',
          source: 'metacritic',
          metacriticSlug: 'the-saboteur',
          targetTitle: 'The Saboteur',
        },
        updatedAt: new Date().toISOString(),
      });

      const resolveDynamicSpy = vi
        .spyOn(criticScoreService, 'resolveDynamicScore')
        .mockResolvedValue({
          source: 'metacritic',
          score: 79,
          tier: 'Strong',
          url: 'https://www.metacritic.com/game/the-saboteur/critic-reviews/',
          isVerified: true,
        });

      // Case A: Staged cache entry is expired / evicted -> background sync includes the routed game
      localStorage.removeItem('antigravity_critic_v8_title:the saboteur');
      await syncJobManager.startCriticScoreSync([game], { forceRefresh: false });
      expect(resolveDynamicSpy).toHaveBeenCalledWith(
        'The Saboteur',
        expect.anything(),
        '2009',
        undefined,
        expect.objectContaining({ gameId: 'gog-1458058109' })
      );

      // Case B: forceRefresh: true -> refreshes even when staged cache is valid
      resolveDynamicSpy.mockClear();
      saveStagedCache(
        'antigravity_critic_v8_title:the saboteur',
        {
          source: 'metacritic',
          score: 79,
          tier: 'Strong',
          url: 'https://www.metacritic.com/game/the-saboteur/critic-reviews/',
          isVerified: true,
        },
        MutabilityTier.TIER_2_MATURE
      );

      await syncJobManager.startCriticScoreSync([game], { forceRefresh: true });
      expect(resolveDynamicSpy).toHaveBeenCalledWith(
        'The Saboteur',
        expect.anything(),
        '2009',
        undefined,
        expect.objectContaining({ bypassAttempted: true, gameId: 'gog-1458058109' })
      );
    });
  });

  // ===========================================================================
  // TASK 1: Cross-Storefront Scraping, Independent Search & UI Controls
  // ===========================================================================
  describe('Task 1: Cross-Storefront Harvesting & Independent Stage 2/3/4 Search', () => {
    it('scrapeMatchDetails on a GOG or IGDB candidate resolves crossStoreSteamAppId, includes Steam portrait covers, Steam descriptions, and both GOG/IGDB + Steam metadata sources', async () => {
      vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue({
        steamAppId: 24880,
        name: 'The Saboteur™',
        shortDescription: 'Steam synopsis for The Saboteur in occupied Paris.',
        detailedDescription:
          '<p>Steam detailed overview paragraph for The Saboteur.</p><p>Second paragraph.</p>',
        developers: ['Pandemic Studios'],
        publishers: ['Electronic Arts'],
        genres: ['Action', 'Open World'],
        tags: ['WWII', 'Stealth'],
        releaseDate: 'Dec 8, 2009',
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/24880/header.jpg',
      } as any);

      vi.spyOn(fallbackMetadataProvider, 'fetchGogProductMetadata').mockResolvedValue({
        title: 'The Saboteur',
        shortDescription: 'GOG synopsis for The Saboteur.',
        detailedDescription: 'GOG detailed overview for The Saboteur.',
        capsuleImage: 'https://images.gog.com/saboteur_vertical.jpg',
        headerImage: 'https://images.gog.com/saboteur_horizontal.jpg',
        developers: ['Pandemic Studios'],
        publishers: ['EA'],
        genres: ['Action'],
        releaseDate: '2009-12-04',
      } as any);

      vi.spyOn(storefrontReviewHarvester, 'getGogAnchor').mockResolvedValue(null);

      // 1. Test GOG candidate
      const gogCandidate: SearchMatchCandidate = {
        id: 'gog-1458058109',
        source: 'gog',
        title: 'The Saboteur',
        gogId: '1458058109',
        steamAppId: 24880,
        capsuleImage: 'https://images.gog.com/saboteur_vertical.jpg',
      };

      const gogBundle = await metadataScraperService.scrapeMatchDetails(gogCandidate, null);

      expect(gogBundle.matchedStore).toBe('gog');
      expect(gogBundle.steamAppId).toBeNull(); // Explicitly unlinks primary steamAppId
      expect(gogBundle.metadataRoute?.steamAppId).toBe(24880); // Preserves crossStoreSteamAppId

      // Includes Steam portrait covers (library_600x900_2x.jpg, library_capsule.jpg)
      const gogCoverUrls = gogBundle.availableCovers.map((c) => c.url);
      expect(gogCoverUrls).toContain(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/24880/library_600x900_2x.jpg'
      );
      expect(gogCoverUrls).toContain(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/24880/library_capsule.jpg'
      );

      // Includes Steam descriptions in availableDescriptions
      const gogDescSources = (gogBundle.availableDescriptions || []).map((d) => d.source);
      expect(gogDescSources).toContain('GOG Store Synopsis');
      expect(gogDescSources).toContain('Steam Store Synopsis');

      // Populates availableMetadataSources with both GOG.com Metadata and Steam Store Metadata
      const gogMetaLabels = (gogBundle.availableMetadataSources || []).map((s) => s.sourceLabel);
      expect(gogMetaLabels).toContain('GOG.com Metadata');
      expect(gogMetaLabels).toContain('Steam Store Metadata');

      // 2. Test IGDB candidate
      const igdbCandidate: SearchMatchCandidate = {
        id: 'igdb-saboteur',
        source: 'igdb',
        title: 'The Saboteur',
        igdbId: 9991,
        steamAppId: 24880,
        description: 'IGDB overview for The Saboteur.',
        capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1234.jpg',
      };

      const igdbBundle = await metadataScraperService.scrapeMatchDetails(igdbCandidate, null);
      expect(igdbBundle.matchedStore).toBe('igdb');
      expect(igdbBundle.metadataRoute?.steamAppId).toBe(24880);
      expect(igdbBundle.availableCovers.map((c) => c.url)).toContain(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/24880/library_600x900_2x.jpg'
      );
      expect((igdbBundle.availableDescriptions || []).map((d) => d.source)).toContain(
        'Steam Store Synopsis'
      );
      const igdbMetaLabels = (igdbBundle.availableMetadataSources || []).map((s) => s.sourceLabel);
      expect(igdbMetaLabels).toContain('IGDB Metadata');
      expect(igdbMetaLabels).toContain('Steam Store Metadata');
    });

    it('searchCoverOptions returns deduplicated ScrapedCoverOption[] for Stage 2 title search', async () => {
      vi.spyOn(metadataScraperService, 'searchStorefronts').mockResolvedValue([
        {
          id: 'steam-24880',
          source: 'steam',
          title: 'The Saboteur',
          steamAppId: 24880,
          capsuleImage:
            'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/24880/library_600x900_2x.jpg',
        },
        {
          id: 'gog-1458058109',
          source: 'gog',
          title: 'The Saboteur',
          gogId: '1458058109',
          capsuleImage: 'https://images.gog.com/saboteur_vertical.jpg',
        },
      ]);
      vi.spyOn(igdbCoverService, 'fetchIgdbCover').mockResolvedValue(
        'https://images.igdb.com/igdb/image/upload/t_cover_big/co_saboteur.jpg'
      );

      const covers = await metadataScraperService.searchCoverOptions('The Saboteur', 'All');
      expect(covers.length).toBeGreaterThanOrEqual(4);
      expect(covers.some((c) => c.source === 'steam' && c.dimensions === '600x900')).toBe(true);
      expect(covers.some((c) => c.source === 'steam' && c.dimensions === 'library_capsule')).toBe(
        true
      );
      expect(covers.some((c) => c.source === 'gog')).toBe(true);
      expect(covers.some((c) => c.source === 'igdb')).toBe(true);
    });

    it('searchMetadataSources returns MetadataSourceOption[] across storefronts for Stage 4 title search', async () => {
      vi.spyOn(metadataScraperService, 'searchStorefronts').mockResolvedValue([
        {
          id: 'steam-24880',
          source: 'steam',
          title: 'The Saboteur',
          steamAppId: 24880,
        },
        {
          id: 'gog-1458058109',
          source: 'gog',
          title: 'The Saboteur',
          gogId: '1458058109',
          description: 'GOG description for The Saboteur.',
        },
        {
          id: 'igdb-9991',
          source: 'igdb',
          title: 'The Saboteur',
          igdbId: 9991,
          description: 'IGDB description for The Saboteur.',
        },
      ]);

      vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue({
        steamAppId: 24880,
        name: 'The Saboteur',
        shortDescription: 'Steam synopsis for The Saboteur.',
        developers: ['Pandemic Studios'],
        genres: ['Action'],
        releaseDate: 'Dec 8, 2009',
      } as any);

      vi.spyOn(fallbackMetadataProvider, 'fetchGogProductMetadata').mockResolvedValue({
        title: 'The Saboteur',
        shortDescription: 'GOG synopsis for The Saboteur.',
        developers: ['Pandemic Studios'],
      } as any);

      const sources = await metadataScraperService.searchMetadataSources('The Saboteur', 'All');
      expect(sources.length).toBeGreaterThanOrEqual(3);
      expect(sources.some((s) => s.source === 'steam' && s.steamAppId === 24880)).toBe(true);
      expect(sources.some((s) => s.source === 'gog' && s.gogId === '1458058109')).toBe(true);
      expect(sources.some((s) => s.source === 'igdb')).toBe(true);
    });

    it('reviewCandidateService.discoverReviews resolves Steam reviews when scrapedBundle.steamAppId === null, supports customSearchQuery, and attaches reviewRoute to every candidate', async () => {
      vi.spyOn(metacriticResolver, 'resolveMetacritic').mockResolvedValue({
        critic: {
          id: 'mc-saboteur',
          source: 'metacritic',
          score: 76,
          tier: 'Strong',
          url: 'https://www.metacritic.com/game/the-saboteur/critic-reviews/',
          numReviews: 45,
          isVerified: true,
        },
        user: null,
      });

      vi.spyOn(steamReviewResolver, 'resolveScore').mockResolvedValue({
        id: 'steam-24880',
        source: 'steam',
        score: 88,
        tier: 'Mighty',
        percentRecommended: 90,
        numReviews: 4100,
        url: 'https://store.steampowered.com/app/24880',
        summary: 'Very Positive (90% of 4,100 user reviews)',
        isVerified: false,
        isSynthetic: true,
      });

      vi.spyOn(storefrontStarResolver, 'resolveStorefrontScore').mockResolvedValue(null);
      vi.spyOn(storefrontReviewHarvester, 'getStorefrontAnchor').mockResolvedValue(null);

      const gogGame: CanonicalGame = {
        id: 'gog-1458058109',
        title: 'The Saboteur',
        sortTitle: 'Saboteur',
        platforms: [{ platformId: 'gog', platformGameId: '1458058109', installed: true }],
        headerImage: '',
        developers: ['Pandemic Studios'],
        publishers: ['EA'],
        genres: ['Action'],
        tags: [],
      };

      const nonSteamBundle: ScrapedMetadataBundle = {
        matchedStore: 'gog',
        matchedId: '1458058109',
        title: 'The Saboteur',
        sortTitle: 'Saboteur',
        steamAppId: null, // Explicitly null from non-Steam Stage 1 match
        capsuleImage: 'https://images.gog.com/saboteur_vertical.jpg',
        availableCovers: [],
        availableMetadataSources: [
          {
            id: 'steam-24880',
            source: 'steam',
            sourceLabel: 'Steam Store Metadata',
            matchedId: 24880,
            steamAppId: 24880,
            title: 'The Saboteur',
          },
        ],
        metadataRoute: {
          source: 'gog',
          matchedId: '1458058109',
          steamAppId: 24880,
          gogId: '1458058109',
        },
      };

      // 1. Discovers Steam reviews even when scrapedBundle.steamAppId === null
      const discovery = await reviewCandidateService.discoverReviews(
        gogGame,
        null,
        nonSteamBundle
      );
      const steamCand = discovery.candidates.find((c) => c.source === 'steam');
      expect(steamCand).toBeDefined();
      expect(steamCand?.score).toBe(88);

      // Every candidate has reviewRoute: { mode: 'routed', ... }
      for (const cand of discovery.candidates) {
        expect(cand.reviewRoute).toBeDefined();
        expect(cand.reviewRoute?.mode).toBe('routed');
        expect(cand.reviewRoute?.source).toBe(cand.source);
      }

      // 2. Supports customSearchQuery in Stage 3 to discover reviews for a searched title
      vi.spyOn(metadataScraperService, 'searchStorefronts').mockResolvedValue([
        {
          id: 'steam-6060',
          source: 'steam',
          title: 'Star Wars: Battlefront 2 (Classic, 2005)',
          steamAppId: 6060,
        },
      ]);

      const customDiscovery = await reviewCandidateService.discoverReviews(
        gogGame,
        null,
        nonSteamBundle,
        'Star Wars: Battlefront 2 (Classic, 2005)'
      );
      expect(customDiscovery.candidates.length).toBeGreaterThan(0);
      expect(customDiscovery.candidates[0].reviewRoute?.targetTitle).toBe(
        'Star Wars: Battlefront 2 (Classic, 2005)'
      );
    });

    it('FixMatchWizardModal renders Stage 2 cover search bar & filter pills, Stage 3 review search bar & Live Route badge, and Stage 4 Metadata Source & Storefront Search controls', () => {
      const game: CanonicalGame = {
        id: 'gog-1458058109',
        title: 'The Saboteur',
        sortTitle: 'Saboteur',
        platforms: [{ platformId: 'gog', platformGameId: '1458058109', installed: true }],
        headerImage: '',
        developers: ['Pandemic Studios'],
        publishers: ['EA'],
        genres: ['Action'],
        tags: [],
        releaseDate: '2009',
      };

      const candidate: SearchMatchCandidate = {
        id: 'gog-1458058109',
        source: 'gog',
        title: 'The Saboteur',
        gogId: '1458058109',
        capsuleImage: 'https://images.gog.com/saboteur_vertical.jpg',
      };

      const bundle: ScrapedMetadataBundle = {
        matchedStore: 'gog',
        matchedId: '1458058109',
        title: 'The Saboteur',
        sortTitle: 'Saboteur',
        steamAppId: null,
        capsuleImage: 'https://images.gog.com/saboteur_vertical.jpg',
        availableCovers: [
          {
            url: 'https://images.gog.com/saboteur_vertical.jpg',
            source: 'gog',
            label: 'GOG Official Cover',
          },
          {
            url: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/24880/library_600x900_2x.jpg',
            source: 'steam',
            label: 'Steam Portrait (600x900)',
          },
        ],
        availableDescriptions: [
          { source: 'GOG Store Synopsis', text: 'GOG blurb for The Saboteur.' },
          { source: 'Steam Store Synopsis', text: 'Steam blurb for The Saboteur.' },
        ],
        availableMetadataSources: [
          {
            id: 'gog-1458058109',
            source: 'gog',
            sourceLabel: 'GOG.com Metadata',
            matchedId: '1458058109',
            gogId: '1458058109',
            title: 'The Saboteur',
            shortDescription: 'GOG blurb for The Saboteur.',
          },
          {
            id: 'steam-24880',
            source: 'steam',
            sourceLabel: 'Steam Store Metadata',
            matchedId: 24880,
            steamAppId: 24880,
            title: 'The Saboteur™',
            shortDescription: 'Steam blurb for The Saboteur.',
          },
        ],
        shortDescription: 'GOG blurb for The Saboteur.',
        developers: ['Pandemic Studios'],
        publishers: ['EA'],
        genres: ['Action'],
        tags: ['WWII'],
        releaseDate: '2009',
      };

      const reviewCands: ReviewCandidateOption[] = [
        {
          id: 'mc-metascore',
          source: 'metacritic',
          sourceLabel: 'Metacritic Metascore',
          score: 76,
          tier: 'Strong',
          url: 'https://www.metacritic.com/game/the-saboteur/',
          isVerified: true,
          reviewRoute: {
            mode: 'routed',
            source: 'metacritic',
            metacriticSlug: 'the-saboteur',
            targetTitle: 'The Saboteur',
          },
        },
      ];

      // Stage 2 HTML check
      const step2Html = renderToString(
        React.createElement(FixMatchWizardModal, {
          isOpen: true,
          game,
          initialStep: 2,
          initialCandidate: candidate,
          initialScrapedBundle: bundle,
          onClose: vi.fn(),
          onApplyOverride: vi.fn(),
        })
      );
      expect(step2Html).toContain(
        'Search cover art by game title across Steam, IGDB, GOG, Epic...'
      );
      expect(step2Html).toContain('Search Covers');
      expect(step2Html).toContain('GOG Official Cover');
      expect(step2Html).toContain('Steam Portrait (600x900)');

      // Stage 3 HTML check
      const step3Html = renderToString(
        React.createElement(FixMatchWizardModal, {
          isOpen: true,
          game,
          initialStep: 3,
          initialCandidate: candidate,
          initialScrapedBundle: bundle,
          initialReviewCandidates: reviewCands,
          initialSelectedReviewOptionId: 'mc-metascore',
          initialSelectedReviewData: {
            source: 'metacritic',
            score: 76,
            tier: 'Strong',
            url: 'https://www.metacritic.com/game/the-saboteur/',
            isVerified: true,
          },
          onClose: vi.fn(),
          onApplyOverride: vi.fn(),
        })
      );
      expect(step3Html).toContain(
        'Search review scores by title across Metacritic, OpenCritic, Steam &amp; GOG...'
      );
      expect(step3Html).toContain('Search Reviews');
      expect(step3Html).toContain('Live Route • Auto-updates on sync');

      // Stage 4 HTML check
      const step4Html = renderToString(
        React.createElement(FixMatchWizardModal, {
          isOpen: true,
          game,
          initialStep: 4,
          initialCandidate: candidate,
          initialScrapedBundle: bundle,
          initialReviewCandidates: reviewCands,
          initialSelectedReviewOptionId: 'mc-metascore',
          initialSelectedReviewData: {
            source: 'metacritic',
            score: 76,
            tier: 'Strong',
            url: 'https://www.metacritic.com/game/the-saboteur/',
            isVerified: true,
          },
          onClose: vi.fn(),
          onApplyOverride: vi.fn(),
        })
      );
      expect(step4Html).toContain('Metadata Source &amp; Storefront Search');
      expect(step4Html).toContain('Search Metadata');
      expect(step4Html).toContain('GOG.com Metadata');
      expect(step4Html).toContain('Steam Store Metadata');
      expect(step4Html).toContain('Live Route • Auto-updates on sync');
    });
  });
});
