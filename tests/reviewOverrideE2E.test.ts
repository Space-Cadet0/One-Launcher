import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { CanonicalGame } from '../src/contracts/game';
import type {
  UserGameOverride,
  SearchMatchCandidate,
  ScrapedMetadataBundle,
} from '../src/contracts/override';
import type { CriticScoreData, CriticSource, StorefrontReviewAnchor } from '../src/contracts/critic';
import { FixMatchWizardModal } from '../src/components/Library/FixMatchWizardModal';
import {
  saveUserOverride,
  loadUserOverrides,
  removeUserOverride,
  applyUserOverrideToGame,
  getUserOverrideForGame,
  STORAGE_KEY_USER_OVERRIDES,
} from '../src/services/storage/userOverrideStorage';
import {
  criticScoreService,
  getOpenCriticData,
} from '../src/services/critic/criticScoreService';
import {
  MutabilityTier,
  loadStagedCache,
  evictStagedCache,
} from '../src/services/storage/stagedCacheService';
import {
  reviewCandidateService,
  ReviewCandidateOption,
} from '../src/services/scraper/reviewCandidateService';
import { requestScheduler, Priority } from '../src/services/network/requestScheduler';
import { metacriticResolver } from '../src/services/critic/metacriticResolver';
import { steamReviewResolver } from '../src/services/critic/steamReviewResolver';
import { storefrontStarResolver } from '../src/services/critic/storefrontStarResolver';
import { storefrontReviewHarvester } from '../src/services/critic/storefrontReviewHarvester';

// ---------------------------------------------------------------------------
// Environment Polyfills & Test Fixtures
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
    removeEventListener: (type: string, listener: any) => eventTarget.removeEventListener(type, listener),
    dispatchEvent: (event: any) => eventTarget.dispatchEvent(event),
    localStorage: mockStorage,
  };
} else {
  if (typeof (window as any).addEventListener === 'undefined') {
    (window as any).addEventListener = (type: string, listener: any) => eventTarget.addEventListener(type, listener);
    (window as any).removeEventListener = (type: string, listener: any) => eventTarget.removeEventListener(type, listener);
    (window as any).dispatchEvent = (event: any) => eventTarget.dispatchEvent(event);
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

// Ensure criticScoreService window listeners are initialized now that window is polyfilled
criticScoreService.initEventListeners();

describe('Phase 4: Comprehensive QA & End-to-End Regression Audit for Review Score & Source Override', { timeout: 30000 }, () => {
  const sampleGame: CanonicalGame = {
    id: 'steam-1091500',
    title: 'Cyberpunk 2077',
    sortTitle: 'Cyberpunk 2077',
    steamAppId: 1091500,
    platforms: [{ platformId: 'steam', platformGameId: '1091500', installed: true }],
    capsuleImage: 'https://example.com/cover_steam.jpg',
    headerImage: 'https://example.com/header_steam.jpg',
    shortDescription: 'Cyberpunk 2077 is an open-world action-adventure RPG set in Night City.',
    developers: ['CD PROJEKT RED'],
    publishers: ['CD PROJEKT RED'],
    genres: ['RPG', 'Action'],
    tags: ['Cyberpunk', 'Open World', 'Sci-fi'],
    releaseDate: 'Dec 10, 2020',
  };

  const sampleCandidate: SearchMatchCandidate = {
    id: 'steam-1091500',
    source: 'steam',
    title: 'Cyberpunk 2077',
    steamAppId: 1091500,
    capsuleImage: 'https://example.com/cover_match.jpg',
    headerImage: 'https://example.com/header_match.jpg',
    description: 'An open-world action RPG.',
    confidenceScore: 100,
  };

  const sampleScrapedBundle: ScrapedMetadataBundle = {
    matchedStore: 'steam',
    matchedId: 1091500,
    title: 'Cyberpunk 2077',
    sortTitle: 'Cyberpunk 2077',
    steamAppId: 1091500,
    capsuleImage: 'https://example.com/cover_selected.jpg',
    availableCovers: [
      {
        url: 'https://example.com/cover_selected.jpg',
        source: 'steam',
        label: 'Official Steam Portrait',
      },
      {
        url: 'https://example.com/cover_alt.jpg',
        source: 'steam',
        label: 'Alternate Cover Art',
      },
    ],
    headerImage: 'https://example.com/header_selected.jpg',
    shortDescription: 'Cyberpunk 2077 is an open-world action-adventure RPG.',
    developers: ['CD PROJEKT RED'],
    publishers: ['CD PROJEKT RED'],
    genres: ['RPG', 'Action'],
    tags: ['Cyberpunk', 'Open World'],
    releaseDate: 'Dec 10, 2020',
    storefrontAnchor: {
      storefront: 'steam',
      metacriticScore: 86,
      metacriticUrl: 'https://www.metacritic.com/game/cyberpunk-2077/',
    },
  };

  const sampleReviewCandidates: ReviewCandidateOption[] = [
    {
      id: 'anchor-metacritic',
      source: 'metacritic',
      sourceLabel: 'Metacritic Metascore',
      score: 86,
      tier: 'Mighty',
      url: 'https://www.metacritic.com/game/cyberpunk-2077/',
      summary: 'Universal acclaim based on 100 critic reviews.',
      numReviews: 100,
      isVerified: true,
      isRecommended: true,
      groundTruthSource: 'Verified by Steam Store Link',
    },
    {
      id: 'opencritic',
      source: 'opencritic',
      sourceLabel: 'OpenCritic',
      score: 76,
      tier: 'Strong',
      percentRecommended: 78,
      numReviews: 212,
      url: 'https://opencritic.com/game/8525/cyberpunk-2077',
      summary: 'Cyberpunk 2077 is an ambitious RPG.',
      isVerified: true,
    },
    {
      id: 'steam-community',
      source: 'steam',
      sourceLabel: 'Steam Community Reviews',
      score: 84,
      tier: 'Mighty',
      percentRecommended: 86,
      numReviews: 654210,
      url: 'https://store.steampowered.com/app/1091500',
      summary: 'Based on Steam community player reviews (86% positive).',
      isVerified: false,
      isSynthetic: true,
    },
  ];

  beforeEach(() => {
    mockStorage.clear();
    criticScoreService.clearCache();
    requestScheduler.setEnforceDelays(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Full Wizard Flow End-to-End
  // =========================================================================
  describe('1. Full Wizard Flow End-to-End (Steps 1 through 4)', () => {
    it('renders Step 1: Match Discovery with storefront candidates and search controls', () => {
      const html = renderToString(
        React.createElement(FixMatchWizardModal, {
          isOpen: true,
          game: sampleGame,
          initialStep: 1,
          onClose: vi.fn(),
          onApplyOverride: vi.fn(),
        })
      );

      expect(html).toContain('Fix Match &amp; Metadata');
      expect(html).toContain('Step 1 of 4');
      expect(html).toContain('1. Match Discovery');
      expect(html).toContain('2. Cover Art');
      expect(html).toContain('3. Review Score &amp; Source');
      expect(html).toContain('4. Metadata &amp; Confirm');
      expect(html).toContain('Search candidate game by title or keywords...');
      expect(html).toContain('Cyberpunk 2077');
    });

    it('renders Step 2: Cover Art selection with available covers and navigation', () => {
      const html = renderToString(
        React.createElement(FixMatchWizardModal, {
          isOpen: true,
          game: sampleGame,
          initialStep: 2,
          initialCandidate: sampleCandidate,
          initialScrapedBundle: sampleScrapedBundle,
          onClose: vi.fn(),
          onApplyOverride: vi.fn(),
        })
      );

      expect(html).toContain('Step 2 of 4');
      expect(html).toContain('Select 2:3 Vertical Cover Art');
      expect(html).toContain('Official Steam Portrait');
      expect(html).toContain('Next: Review Score &amp; Source');
      expect(html).toContain('Back');
    });

    it('renders Step 3: Review Score candidate options, manual custom override, and unrated card', () => {
      const html = renderToString(
        React.createElement(FixMatchWizardModal, {
          isOpen: true,
          game: sampleGame,
          initialStep: 3,
          initialCandidate: sampleCandidate,
          initialScrapedBundle: sampleScrapedBundle,
          initialReviewCandidates: sampleReviewCandidates,
          initialSelectedReviewOptionId: 'anchor-metacritic',
          initialSelectedReviewData: {
            source: 'metacritic',
            score: 86,
            tier: 'Mighty',
            url: 'https://www.metacritic.com/game/cyberpunk-2077/',
            summary: 'Universal acclaim based on 100 critic reviews.',
            numReviews: 100,
            isVerified: true,
          },
          onClose: vi.fn(),
          onApplyOverride: vi.fn(),
        })
      );

      expect(html).toContain('Step 3 of 4');
      expect(html).toContain('Select Review Score &amp; Source');
      expect(html).toContain('Metacritic Metascore');
      expect(html).toContain('86');
      expect(html).toContain('Mighty');
      expect(html).toContain('Verified by Steam Store Link');
      expect(html).toContain('OpenCritic');
      expect(html).toContain('76');
      expect(html).toContain('Manual / Custom Score');
      expect(html).toContain('Unrated / Hide Review Score');
      expect(html).toContain('Next: Metadata &amp; Confirm');
      expect(html).toContain('Back');
    });

    it('renders Step 3: Custom Override form with custom score, source, URL, and live tier preview', () => {
      const html = renderToString(
        React.createElement(FixMatchWizardModal, {
          isOpen: true,
          game: sampleGame,
          initialStep: 3,
          initialCandidate: sampleCandidate,
          initialScrapedBundle: sampleScrapedBundle,
          initialReviewCandidates: sampleReviewCandidates,
          initialSelectedReviewOptionId: 'custom',
          initialCustomScoreValue: 95,
          initialCustomScoreSource: 'custom',
          initialCustomScoreUrl: 'https://example.com/cyberpunk-masterpiece',
          initialCustomScoreSummary: 'Definitive next-gen masterpiece after patches.',
          initialCustomScoreNumReviews: 125,
          initialSelectedReviewData: {
            source: 'custom',
            score: 95,
            tier: 'Mighty',
            url: 'https://example.com/cyberpunk-masterpiece',
            summary: 'Definitive next-gen masterpiece after patches.',
            numReviews: 125,
            isVerified: false,
          },
          onClose: vi.fn(),
          onApplyOverride: vi.fn(),
        })
      );

      expect(html).toContain('Manual / Custom Score');
      expect(html).toContain('95');
      expect(html).toContain('Mighty');
      expect(html).toContain('Definitive next-gen masterpiece after patches.');
      expect(html).toContain('Score (0 - 100)');
      expect(html).toContain('Rating Source');
    });

    it('renders Step 4: Metadata review and confirmation with custom review badge preview and apply button', () => {
      let appliedOverride: UserGameOverride | null = null;
      const onApplySpy = vi.fn((override: UserGameOverride) => {
        appliedOverride = override;
      });

      const customReviewData: CriticScoreData = {
        source: 'custom',
        score: 95,
        tier: 'Mighty',
        url: 'https://example.com/cyberpunk-masterpiece',
        summary: 'Definitive next-gen masterpiece after patches.',
        numReviews: 125,
        isVerified: false,
      };

      const html = renderToString(
        React.createElement(FixMatchWizardModal, {
          isOpen: true,
          game: sampleGame,
          initialStep: 4,
          initialCandidate: sampleCandidate,
          initialScrapedBundle: sampleScrapedBundle,
          initialSelectedReviewData: customReviewData,
          onClose: vi.fn(),
          onApplyOverride: onApplySpy,
        })
      );

      expect(html).toContain('Step 4 of 4');
      expect(html).toContain('Review &amp; Confirm Game Metadata Override');
      expect(html).toContain('Review Score &amp; Source Override');
      expect(html).toContain('95');
      expect(html).toContain('Mighty');
      expect(html).toContain('custom');
      expect(html).toContain('(125 reviews)');
      expect(html).toContain('Definitive next-gen masterpiece after patches.');
      expect(html).toContain('Apply Match &amp; Scrape Data');
    });
  });

  // =========================================================================
  // 2. Storage & Reactive Event Propagation Pipeline
  // =========================================================================
  describe('2. Storage and Reactive Event Propagation Pipeline', () => {
    it('persists override in userOverrideStorage and dispatches antigravity:user-override-updated', () => {
      const dispatchSpy = vi.fn();
      window.addEventListener('antigravity:user-override-updated', dispatchSpy);

      const customScore: CriticScoreData = {
        source: 'custom',
        score: 93,
        tier: 'Mighty',
        url: 'https://example.com/reviews/cp2077',
        summary: 'Outstanding RPG experience',
        numReviews: 88,
        isVerified: true,
      };

      const override: UserGameOverride = {
        gameId: 'steam-1091500',
        steamAppId: 1091500,
        platformId: 'steam',
        platformGameId: '1091500',
        matchedStore: 'steam',
        matchedId: 1091500,
        title: 'Cyberpunk 2077',
        reviewScoreOverride: customScore,
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(override);

      // Verify localStorage persistence
      const overrides = loadUserOverrides();
      expect(overrides['steam-1091500']).toBeDefined();
      expect(overrides['steam-1091500'].reviewScoreOverride).toEqual(customScore);
      expect(overrides['steam:1091500']?.reviewScoreOverride).toEqual(customScore);

      // Verify event dispatch
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const eventDetail = dispatchSpy.mock.calls[0][0].detail;
      expect(eventDetail.override.gameId).toBe('steam-1091500');
      expect(eventDetail.override.reviewScoreOverride.score).toBe(93);

      window.removeEventListener('antigravity:user-override-updated', dispatchSpy);
    });

    it('criticScoreService catches event, saves to staged cache with TIER_0_USER_OVERRIDE, and dispatches antigravity_critic_updated', () => {
      const criticUpdatedSpy = vi.fn();
      window.addEventListener('antigravity_critic_updated', criticUpdatedSpy);

      const customScore: CriticScoreData = {
        source: 'opencritic',
        score: 91,
        tier: 'Mighty',
        url: 'https://opencritic.com/game/8525/cyberpunk-2077',
        summary: 'Universal acclaim',
        isVerified: true,
      };

      const override: UserGameOverride = {
        gameId: 'steam-1091500',
        steamAppId: 1091500,
        matchedStore: 'steam',
        title: 'Cyberpunk 2077',
        reviewScoreOverride: customScore,
        reviewRoute: {
          mode: 'static',
          source: 'opencritic',
          url: 'https://opencritic.com/game/8525/cyberpunk-2077',
        },
        updatedAt: new Date().toISOString(),
      };

      // Dispatch user override update event as userOverrideStorage does
      window.dispatchEvent(
        new CustomEvent('antigravity:user-override-updated', { detail: { override } })
      );

      // Verify criticScoreService caught the event and staged the score at Tier 0
      const staged = loadStagedCache<CriticScoreData>('antigravity_critic_v8_id:1091500', false);
      expect(staged.entry).toBeDefined();
      expect(staged.entry?.tier).toBe(MutabilityTier.TIER_0_USER_OVERRIDE);
      expect(staged.entry?.data).toEqual(customScore);

      // Verify antigravity_critic_updated was dispatched
      expect(criticUpdatedSpy).toHaveBeenCalledTimes(1);
      const updateDetail = criticUpdatedSpy.mock.calls[0][0].detail;
      expect(updateDetail.cacheKey).toBe('id:1091500');
      expect(updateDetail.steamAppId).toBe(1091500);
      expect(updateDetail.data).toEqual(customScore);

      window.removeEventListener('antigravity_critic_updated', criticUpdatedSpy);
    });

    it('attaches reviewScoreOverride to CanonicalGame in applyUserOverrideToGame', () => {
      const override: UserGameOverride = {
        gameId: sampleGame.id,
        matchedStore: 'steam',
        title: 'Cyberpunk 2077 (Enhanced)',
        reviewScoreOverride: {
          source: 'custom',
          score: 96,
          tier: 'Mighty',
          url: '',
          isVerified: true,
        },
        updatedAt: new Date().toISOString(),
      };

      const updatedGame = applyUserOverrideToGame(sampleGame, override);
      expect(updatedGame.title).toBe('Cyberpunk 2077 (Enhanced)');
      expect(updatedGame.reviewScoreOverride?.score).toBe(96);
      expect(updatedGame.reviewScoreOverride?.source).toBe('custom');
    });
  });

  // =========================================================================
  // 3. Zero-Network Short-Circuit Verification
  // =========================================================================
  describe('3. Zero-Network Short-Circuit Verification', () => {
    it('criticScoreService.getCriticScore immediately returns Tier 0 user override with zero network queries', () => {
      const resolveMetacriticSpy = vi.spyOn(metacriticResolver, 'resolveMetacritic');
      const resolveSteamSpy = vi.spyOn(steamReviewResolver, 'resolveScore');
      const resolveStorefrontStarSpy = vi.spyOn(storefrontStarResolver, 'resolveStorefrontScore');
      const harvestSpy = vi.spyOn(storefrontReviewHarvester, 'getStorefrontAnchor');

      const customScore: CriticScoreData = {
        source: 'metacritic',
        score: 97,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/custom',
        isVerified: true,
      };

      const override: UserGameOverride = {
        gameId: 'steam-1091500',
        steamAppId: 1091500,
        title: 'Cyberpunk 2077',
        matchedStore: 'steam',
        reviewScoreOverride: customScore,
        reviewRoute: {
          mode: 'static',
          source: 'metacritic',
          url: 'https://www.metacritic.com/custom',
        },
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(override);

      // Call getCriticScore synchronously
      const result = criticScoreService.getCriticScore(1091500, 'Cyberpunk 2077');

      // Must return override immediately
      expect(result).not.toBeNull();
      expect(result?.score).toBe(97);
      expect(result?.source).toBe('metacritic');

      // Absolutely zero network resolvers should have been invoked
      expect(resolveMetacriticSpy).not.toHaveBeenCalled();
      expect(resolveSteamSpy).not.toHaveBeenCalled();
      expect(resolveStorefrontStarSpy).not.toHaveBeenCalled();
      expect(harvestSpy).not.toHaveBeenCalled();
    });

    it('criticScoreService.resolveDynamicScore immediately returns user override with zero network queries', async () => {
      const resolveMetacriticSpy = vi.spyOn(metacriticResolver, 'resolveMetacritic');
      const resolveSteamSpy = vi.spyOn(steamReviewResolver, 'resolveScore');
      const resolveStorefrontStarSpy = vi.spyOn(storefrontStarResolver, 'resolveStorefrontScore');

      const customScore: CriticScoreData = {
        source: 'opencritic',
        score: 94,
        tier: 'Mighty',
        url: 'https://opencritic.com/custom',
        isVerified: true,
      };

      const override: UserGameOverride = {
        gameId: 'steam-1091500',
        steamAppId: 1091500,
        title: 'Cyberpunk 2077',
        matchedStore: 'steam',
        reviewScoreOverride: customScore,
        reviewRoute: {
          mode: 'static',
          source: 'opencritic',
          url: 'https://opencritic.com/custom',
        },
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(override);

      // Call resolveDynamicScore asynchronously
      const resolved = await criticScoreService.resolveDynamicScore('Cyberpunk 2077', 1091500);

      expect(resolved).not.toBeNull();
      expect(resolved?.score).toBe(94);
      expect(resolved?.source).toBe('opencritic');

      // Zero network queries triggered
      expect(resolveMetacriticSpy).not.toHaveBeenCalled();
      expect(resolveSteamSpy).not.toHaveBeenCalled();
      expect(resolveStorefrontStarSpy).not.toHaveBeenCalled();
    });

    it('zero network calls executed for non-Steam titles when user override is present', async () => {
      const resolveMetacriticSpy = vi.spyOn(metacriticResolver, 'resolveMetacritic');
      const resolveStorefrontStarSpy = vi.spyOn(storefrontStarResolver, 'resolveStorefrontScore');

      const indieCustomScore: CriticScoreData = {
        source: 'custom',
        score: 89,
        tier: 'Mighty',
        url: 'https://example.com/indie-game',
        isVerified: true,
      };

      const override: UserGameOverride = {
        gameId: 'non-steam-indie-xyz',
        title: 'Super Rare Unindexed Indie Title',
        matchedStore: 'custom',
        reviewScoreOverride: indieCustomScore,
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(override);

      const syncResult = criticScoreService.getCriticScore(null, 'Super Rare Unindexed Indie Title');
      expect(syncResult?.score).toBe(89);

      const asyncResult = await criticScoreService.resolveDynamicScore('Super Rare Unindexed Indie Title', null);
      expect(asyncResult?.score).toBe(89);

      expect(resolveMetacriticSpy).not.toHaveBeenCalled();
      expect(resolveStorefrontStarSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. Unrated (Null) Suppression & Badge Hiding
  // =========================================================================
  describe('4. Unrated (Null) Suppression & Dynamic Resolution Bypass', () => {
    it('persists explicit unrated (null) reviewScoreOverride in userOverrideStorage', () => {
      const unratedOverride: UserGameOverride = {
        gameId: 'steam-1091500',
        steamAppId: 1091500,
        title: 'Cyberpunk 2077',
        matchedStore: 'steam',
        reviewScoreOverride: null, // Explicit Unrated
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(unratedOverride);

      const loaded = loadUserOverrides();
      expect(loaded['steam-1091500']).toBeDefined();
      expect(loaded['steam-1091500'].reviewScoreOverride).toBeNull();
    });

    it('getCriticScore returns null immediately for unrated override without running heuristic cascade', () => {
      const resolveMetacriticSpy = vi.spyOn(metacriticResolver, 'resolveMetacritic');

      const unratedOverride: UserGameOverride = {
        gameId: 'steam-813780',
        steamAppId: 813780, // Age of Empires II: normally has Metacritic 84
        title: 'Age of Empires II: Definitive Edition',
        matchedStore: 'steam',
        reviewScoreOverride: null,
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(unratedOverride);

      const score = criticScoreService.getCriticScore(813780, 'Age of Empires II: Definitive Edition');
      expect(score).toBeNull();
      expect(resolveMetacriticSpy).not.toHaveBeenCalled();
    });

    it('resolveDynamicScore returns null immediately for unrated override without executing network requests', async () => {
      const resolveMetacriticSpy = vi.spyOn(metacriticResolver, 'resolveMetacritic');
      const resolveSteamSpy = vi.spyOn(steamReviewResolver, 'resolveScore');

      const unratedOverride: UserGameOverride = {
        gameId: 'steam-1091500',
        steamAppId: 1091500,
        title: 'Cyberpunk 2077',
        matchedStore: 'steam',
        reviewScoreOverride: null,
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(unratedOverride);

      const resolved = await criticScoreService.resolveDynamicScore('Cyberpunk 2077', 1091500);
      expect(resolved).toBeNull();
      expect(resolveMetacriticSpy).not.toHaveBeenCalled();
      expect(resolveSteamSpy).not.toHaveBeenCalled();
    });

    it('renders Step 4 confirmation showing review badge is suppressed when unrated', () => {
      const html = renderToString(
        React.createElement(FixMatchWizardModal, {
          isOpen: true,
          game: sampleGame,
          initialStep: 4,
          initialCandidate: sampleCandidate,
          initialScrapedBundle: sampleScrapedBundle,
          initialSelectedReviewData: null, // Unrated choice
          onClose: vi.fn(),
          onApplyOverride: vi.fn(),
        })
      );

      expect(html).toContain('Review Score &amp; Source Override');
      expect(html).toContain('Unrated (Review badge hidden)');
      expect(html).not.toContain('Universal acclaim');
    });

    it('applyUserOverrideToGame attaches reviewScoreOverride: null to CanonicalGame suppressing badge', () => {
      const unratedOverride: UserGameOverride = {
        gameId: sampleGame.id,
        matchedStore: 'steam',
        title: sampleGame.title,
        reviewScoreOverride: null,
        updatedAt: new Date().toISOString(),
      };

      const updated = applyUserOverrideToGame(sampleGame, unratedOverride);
      expect(updated.reviewScoreOverride).toBeNull();
    });
  });

  // =========================================================================
  // 5. Anti-Bot Safety & Request Scheduler Integration
  // =========================================================================
  describe('5. Anti-Bot Safety: RequestScheduler Priority.P0_INTERACTIVE Routing', () => {
    it('routes all interactive candidate discovery network calls through requestScheduler with Priority.P0_INTERACTIVE', async () => {
      const schedulerSpy = vi.spyOn(requestScheduler, 'schedule');

      // Mock resolvers to schedule via requestScheduler with P0_INTERACTIVE as the real implementation does
      vi.spyOn(metacriticResolver, 'resolveMetacritic').mockImplementation(async (_title, _yr, _anchor, priority = Priority.P0_INTERACTIVE) =>
        requestScheduler.schedule(
          'metacritic.com',
          async () => ({
            critic: {
              id: 'mc-metascore',
              source: 'metacritic',
              score: 86,
              tier: 'Mighty',
              url: 'https://www.metacritic.com/game/cyberpunk-2077/',
              isVerified: true,
            },
            user: {
              id: 'mc-userscore',
              source: 'metacritic_user',
              score: 72,
              tier: 'Fair',
              url: 'https://www.metacritic.com/game/cyberpunk-2077/',
              isVerified: false,
            },
          }),
          priority,
          'metacritic.com'
        )
      );

      vi.spyOn(steamReviewResolver, 'resolveScore').mockResolvedValue({
        id: 'steam-1091500',
        source: 'steam',
        score: 84,
        tier: 'Mighty',
        percentRecommended: 86,
        numReviews: 650000,
        url: 'https://store.steampowered.com/app/1091500',
        summary: '86% positive',
        isVerified: false,
        isSynthetic: true,
      });

      const candidates = await reviewCandidateService.discoverReviewCandidates(
        sampleGame,
        sampleCandidate,
        sampleScrapedBundle
      );

      expect(candidates.length).toBeGreaterThan(0);

      // Verify that every single scheduler invocation specified Priority.P0_INTERACTIVE
      expect(schedulerSpy).toHaveBeenCalled();
      for (const call of schedulerSpy.mock.calls) {
        const priorityArg = call[2];
        expect(priorityArg).toBe(Priority.P0_INTERACTIVE);
      }

      // Verify domains scheduled
      const scheduledDomains = schedulerSpy.mock.calls.map((c) => c[3] || c[0]);
      expect(scheduledDomains).toContain('metacritic.com');
      expect(scheduledDomains).toContain('api.opencritic.com');
    });

    it('isolates per-domain queues in requestScheduler for review candidate queries', async () => {
      const executedDomains: string[] = [];
      metacriticResolver.clearCache();

      vi.spyOn(requestScheduler, 'schedule').mockImplementation(async (domain, task, priority, domainKey) => {
        const resolvedDomain =
          typeof domainKey === 'string' ? domainKey : domainKey?.domainKey || domain;
        executedDomains.push(resolvedDomain);
        expect(priority).toBe(Priority.P0_INTERACTIVE);
        return task();
      });

      await reviewCandidateService.discoverReviewCandidates(
        sampleGame,
        sampleCandidate,
        sampleScrapedBundle
      );

      expect(executedDomains).toContain('metacritic.com');
      expect(executedDomains).toContain('api.opencritic.com');
    });
  });

  // =========================================================================
  // 6. Edge Cases & Robustness
  // =========================================================================
  describe('6. Edge Cases, Cross-Store Corroboration & Reversion', () => {
    it('supports games without store links (sideloaded/emulated/indie)', async () => {
      const nonStoreGame: CanonicalGame = {
        id: 'custom-flappy-bird-remake',
        title: 'Flappy Bird 2026 Community Edition',
        sortTitle: 'Flappy Bird 2026 Community Edition',
        platforms: [{ platformId: 'custom', platformGameId: 'flappy-custom', installed: true }],
        headerImage: '',
        developers: ['Indie Dev'],
        publishers: ['Self-published'],
        genres: ['Arcade'],
        tags: ['Retro'],
      };

      // Discovers candidates gracefully (empty or unrated)
      const result = await reviewCandidateService.discoverReviews(nonStoreGame);
      expect(result.candidates).toBeDefined();
      expect(result.recommendedCandidateId).toBeUndefined();

      // User creates custom override
      const customOverride: UserGameOverride = {
        gameId: nonStoreGame.id,
        title: nonStoreGame.title,
        matchedStore: 'custom',
        reviewScoreOverride: {
          source: 'custom',
          score: 82,
          tier: 'Strong',
          url: '',
          summary: 'Awesome fan remake',
          isVerified: false,
        },
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(customOverride);

      const score = criticScoreService.getCriticScore(null, 'Flappy Bird 2026 Community Edition');
      expect(score?.score).toBe(82);
      expect(score?.tier).toBe('Strong');
      expect(score?.source).toBe('custom');
    });

    it('cross-store corroboration: prioritizes verified store anchor Metacritic over unverified scrapes', async () => {
      const gogGame: CanonicalGame = {
        id: 'gog-1837805079',
        title: 'Cyberpunk 2077',
        sortTitle: 'Cyberpunk 2077',
        platforms: [{ platformId: 'gog', platformGameId: '1837805079', installed: true }],
        headerImage: 'https://example.com/gog_header.jpg',
        developers: ['CD PROJEKT RED'],
        publishers: ['CD PROJEKT RED'],
        genres: ['RPG'],
        tags: ['Cyberpunk'],
      };

      const gogBundle: ScrapedMetadataBundle = {
        matchedStore: 'gog',
        matchedId: '1837805079',
        title: 'Cyberpunk 2077',
        sortTitle: 'Cyberpunk 2077',
        capsuleImage: 'https://example.com/gog_cover.jpg',
        availableCovers: [],
        storefrontAnchor: {
          storefront: 'gog',
          openCriticScore: 76,
          openCriticUrl: 'https://opencritic.com/game/8525/cyberpunk-2077',
        },
      };

      const discovery = await reviewCandidateService.discoverReviews(gogGame, null, gogBundle);
      expect(discovery.candidates.length).toBeGreaterThan(0);

      // The candidate anchored to GOG OpenCritic should be marked recommended
      const anchored = discovery.candidates.find((c) => c.id === 'anchor-opencritic' || c.isRecommended);
      expect(anchored).toBeDefined();
      expect(anchored?.score).toBe(76);
      expect(anchored?.source).toBe('opencritic');
      expect(anchored?.groundTruthSource).toContain('GOG Store Link');
    });

    it('reverts back to default score cascade when user override is removed', async () => {
      const { KNOWN_CRITIC_SCORES } = await import('../src/services/critic/knownCriticScores');
      KNOWN_CRITIC_SCORES[813780] = {
        id: 813780,
        source: 'metacritic',
        score: 84,
        tier: 'Mighty',
        numReviews: 56,
        url: 'https://www.metacritic.com/game/age-of-empires-ii-definitive-edition/critic-reviews/',
        isVerified: true,
      };

      // 1. Setup user override for Age of Empires II
      const customOverride: UserGameOverride = {
        gameId: 'steam-813780',
        steamAppId: 813780,
        title: 'Age of Empires II: Definitive Edition',
        matchedStore: 'steam',
        reviewScoreOverride: {
          source: 'custom',
          score: 99,
          tier: 'Mighty',
          url: '',
          isVerified: true,
        },
        updatedAt: new Date().toISOString(),
      };

      saveUserOverride(customOverride);

      let currentScore = criticScoreService.getCriticScore(813780, 'Age of Empires II: Definitive Edition');
      expect(currentScore?.score).toBe(99);
      expect(currentScore?.source).toBe('custom');

      // 2. Remove user override
      removeUserOverride('steam-813780');

      // Check storage
      const overrides = loadUserOverrides();
      expect(overrides['steam-813780']).toBeUndefined();

      // Trigger cache clearing / re-evaluation
      criticScoreService.clearCache();

      // Now it should return normal default Metacritic 84
      currentScore = criticScoreService.getCriticScore(813780, 'Age of Empires II: Definitive Edition');
      expect(currentScore?.score).toBe(84);
      expect(currentScore?.source).toBe('metacritic');
    });
  });
});
