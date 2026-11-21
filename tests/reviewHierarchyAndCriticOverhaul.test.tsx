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

import type { CriticScoreData, CriticSource } from '../src/contracts/critic';
import type { CanonicalGame } from '../src/contracts/game';
import {
  extractParentheticalReleaseYear,
  isIntermediateNumeralSubtitleMatch,
  isYearEditionToken,
  normalizeTitleKey,
  stripIntermediateSubtitleNumeral,
  stripPackagingEditionPhrases,
} from '../src/services/common/titleUtils';
import { computeEntityMatchConfidence } from '../src/services/common/entityResolver';
import {
  calculateTier,
  getReviewSourceAuthorityRank,
  getReviewSourceDisplayMeta,
  type ReviewSourceShortTag,
} from '../src/services/critic/criticUtils';
import {
  CriticScoreService,
  criticScoreService,
} from '../src/services/critic/criticScoreService';
import {
  generateMetacriticSlugCandidates,
  isAnchorSlugCompatible,
  isTitleCompatible,
  metacriticResolver,
  toCanonicalMetacriticSlug,
} from '../src/services/critic/metacriticResolver';
import { openCriticResolver } from '../src/services/critic/openCriticResolver';
import {
  buildVerifiedSteamMetacriticAnchor,
  resolveGameReviewScore,
} from '../src/services/critic/reviewScoreResolver';
import { steamReviewResolver } from '../src/services/critic/steamReviewResolver';
import { storefrontReviewHarvester } from '../src/services/critic/storefrontReviewHarvester';
import { storefrontStarResolver } from '../src/services/critic/storefrontStarResolver';
import { wikidataBridge } from '../src/services/critic/wikidataBridge';
import * as openCriticModule from '../src/services/opencritic/openCritic';
import { computeTitleSimilarity } from '../src/services/steam/steamMatcher';
import { onlineLifecycleManager } from '../src/services/network/onlineLifecycleManager';
import { requestScheduler } from '../src/services/network/requestScheduler';
import { syncJobManager } from '../src/services/network/syncJobManager';
import {
  MutabilityTier,
  TIER_TTLS,
  clearStagedMemoryFallback,
  hydrateAllStagedCacheFromVault,
  loadStagedCache,
  saveStagedCache,
} from '../src/services/storage/stagedCacheService';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function makeCanonicalGame(overrides: Partial<CanonicalGame> = {}): CanonicalGame {
  return {
    id: overrides.id ?? 'steam-286690',
    title: overrides.title ?? 'Metro 2033 Redux',
    sortTitle: overrides.sortTitle ?? overrides.title ?? 'Metro 2033 Redux',
    steamAppId: overrides.steamAppId,
    releaseDate: overrides.releaseDate ?? '2014-08-26',
    platforms: overrides.platforms ?? [
      { platformId: 'steam', platformGameId: '286690', installed: false },
    ],
    headerImage: overrides.headerImage ?? '',
    developers: overrides.developers ?? ['4A Games'],
    publishers: overrides.publishers ?? ['Deep Silver'],
    genres: overrides.genres ?? ['Action'],
    tags: overrides.tags ?? [],
    reviewSummary: overrides.reviewSummary,
    enrichedMetadata: overrides.enrichedMetadata,
  };
}

describe('Review Hierarchy & Critic Resolver Overhaul — Hermetic End-to-End Regression Suite', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    mockStorage.clear();
    clearStagedMemoryFallback();
    await hydrateAllStagedCacheFromVault();
    localStorage.setItem('antigravity_critic_schema_v16', '1');
    onlineLifecycleManager.ensureInitialized();
    window.dispatchEvent(new Event('online'));
    requestScheduler.reset();
    requestScheduler.setEnforceDelays(false);
    syncJobManager.reset();
    criticScoreService.clearCache();
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
  // 1. Target Case 1: Metro 2033 Redux & Bare 4-Digit Title Numbers
  // =========================================================================
  describe('Target Case 1: Metro 2033 Redux (steam-286690, 2014) & 4-Digit Title Numbers', () => {
    it('resolves MC 90 via Metacritic Composer (metro-2033-redux) without treating "2033" as titleYear', async () => {
      expect(extractParentheticalReleaseYear('Metro 2033 Redux')).toBeNull();
      expect(extractParentheticalReleaseYear('Cyberpunk 2077')).toBeNull();
      expect(extractParentheticalReleaseYear('Battlefield 2042')).toBeNull();
      expect(extractParentheticalReleaseYear('Sea of Thieves: 2026 Edition')).toBeNull();
      expect(extractParentheticalReleaseYear('DOOM (2016)')).toBe(2016);
      expect(extractParentheticalReleaseYear('STAR WARS Battlefront II (Classic, 2005)')).toBe(2005);
      expect(extractParentheticalReleaseYear('Resident Evil 4 [2023]')).toBe(2023);

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const steamSpy = vi.spyOn(steamReviewResolver, 'resolveScore');

      const resolved = await criticScoreService.resolveDynamicScore(
        'Metro 2033 Redux',
        286690,
        2014,
        null,
        {
          gameId: 'steam-286690',
          platforms: [{ platformId: 'steam', platformGameId: '286690' }],
        }
      );

      expect(resolved).not.toBeNull();
      expect(resolved?.source).toBe('metacritic');
      expect(resolved?.score).toBe(90);
      expect(resolved?.tier).toBe('Mighty');
      expect(resolved?.numReviews).toBe(5);
      expect(resolved?.isVerified).toBe(true);
      expect(resolved?.url).toContain('metro-2033-redux');
      expect(
        fetchSpy.mock.calls.some(([url]) =>
          String(url).includes('/composer/metacritic/pages/games/metro-2033-redux/web')
        )
      ).toBe(true);
      expect(steamSpy).not.toHaveBeenCalled();
    });

    it('falls back cleanly to OC 84 (81% recommended, 16 reviews) via Wikidata P1733=286690 -> P2864=957 + OpenCritic SSR when Metacritic is 404, NEVER dropping to STM', async () => {
      const offlineFetch = globalThis.fetch;
      const requestedUrls: string[] = [];

      vi.spyOn(storefrontReviewHarvester, 'getStorefrontAnchor').mockResolvedValue(null);
      const steamSpy = vi.spyOn(steamReviewResolver, 'resolveScore');
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          requestedUrls.push(url);
          if (url.includes('metacritic.com')) {
            return new Response('Not Found', {
              status: 404,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          return offlineFetch(input, init);
        }
      );

      const resolved = await criticScoreService.resolveDynamicScore(
        'Metro 2033 Redux',
        286690,
        2014,
        null,
        {
          gameId: 'steam-286690',
          platforms: [{ platformId: 'steam', platformGameId: '286690' }],
          steamPositivePercent: 89,
        }
      );

      expect(resolved).not.toBeNull();
      expect(resolved?.source).toBe('opencritic');
      expect(resolved?.id).toBe(957);
      expect(resolved?.score).toBe(84);
      expect(resolved?.percentRecommended).toBe(81);
      expect(resolved?.numReviews).toBe(16);
      expect(resolved?.tier).toBe(calculateTier(84, 81));
      expect(resolved?.isVerified).toBe(true);
      expect(resolved?.url).toBe('https://opencritic.com/game/957/metro-2033-redux');

      expect(
        requestedUrls.some((u) => u.includes('query.wikidata.org/sparql') && u.includes('286690'))
      ).toBe(true);
      expect(requestedUrls.some((u) => u.includes('opencritic.com/game/957/game'))).toBe(true);
      expect(steamSpy).not.toHaveBeenCalled();

      // Verify Wikidata bridge cached P1733=286690 -> P2864=957
      const cachedWd = wikidataBridge.getCachedLinks({ steamAppId: 286690 });
      expect(cachedWd?.openCriticId).toBe(957);
    });

    it('resolves Cyberpunk 2077 (MC 86) & Battlefield 2042 (MC 68), accepts Sea of Thieves: 2026 Edition, and blocks Metro 2033 -> Metro and DOOM (2016) -> DOOM (1993)', async () => {
      const cyberpunk = await criticScoreService.resolveDynamicScore(
        'Cyberpunk 2077',
        1091500,
        2020
      );
      expect(cyberpunk?.source).toBe('metacritic');
      expect(cyberpunk?.score).toBe(86);
      expect(cyberpunk?.isVerified).toBe(true);

      const bf2042 = await criticScoreService.resolveDynamicScore(
        'Battlefield 2042',
        1517290,
        2021
      );
      expect(bf2042?.source).toBe('metacritic');
      expect(bf2042?.score).toBe(68);
      expect(bf2042?.isVerified).toBe(true);

      // Sea of Thieves: 2026 Edition strips year-edition phrase safely
      expect(isYearEditionToken('Sea of Thieves: 2026 Edition', '2026')).toBe(true);
      expect(isTitleCompatible('Sea of Thieves: 2026 Edition', 'Sea of Thieves')).toBe(true);

      // Bare 4-digit title numbers are preserved as substantive tokens (Trap T3)
      expect(isYearEditionToken('Metro 2033 Redux', '2033')).toBe(false);
      expect(isYearEditionToken('Cyberpunk 2077', '2077')).toBe(false);
      expect(isYearEditionToken('Battlefield 2042', '2042')).toBe(false);
      expect(isTitleCompatible('Metro 2033', 'Metro')).toBe(false);
      expect(isTitleCompatible('Metro 2033 Redux', 'Metro')).toBe(false);
      expect(isTitleCompatible('Cyberpunk 2077', 'Cyberpunk')).toBe(false);
      expect(isTitleCompatible('Battlefield 2042', 'Battlefield 1942')).toBe(false);
      expect(isTitleCompatible('SimCity 2000 Special Edition', 'SimCity')).toBe(false);

      // DOOM (2016) MUST NEVER match DOOM (1993) across Metacritic or entity resolution
      const doom2016Bundle = await metacriticResolver.resolveMetacritic('DOOM (2016)', 2016);
      expect(doom2016Bundle.critic).toBeNull();
      expect(doom2016Bundle.user).toBeNull();

      const doomEntityEval = computeEntityMatchConfidence(
        { title: 'DOOM (2016)', releaseYear: 2016, developers: ['id Software'] },
        { title: 'DOOM (1993)', releaseYear: 1993, developers: ['id Software'] }
      );
      expect(doomEntityEval.isAccepted).toBe(false);
      expect(doomEntityEval.isRebootCollision).toBe(true);
    });
  });

  // =========================================================================
  // 2. Target Case 2: Deus Ex 2: Invisible War, Intermediate Numerals & Monotonic Lattice
  // =========================================================================
  describe('Target Case 2: Deus Ex 2: Invisible War (gog-1207659068, 2012-07-03), Intermediate Numerals & Monotonic Authority Lattice', () => {
    it('resolves PC Metascore MC 80 (28 critic reviews) via deus-ex-invisible-war (2003-12-02) despite 9-year GOG storefront re-release drift', async () => {
      vi.spyOn(storefrontReviewHarvester, 'getStorefrontAnchor').mockResolvedValue(null);

      const candidates = generateMetacriticSlugCandidates(
        'Deus Ex 2: Invisible War',
        '2012-07-03'
      );
      expect(candidates).toContain('deus-ex-invisible-war');
      expect(candidates.indexOf('deus-ex-invisible-war')).toBeLessThan(
        candidates.indexOf('deus-ex-2-invisible-war-2012')
      );

      const resolved = await criticScoreService.resolveDynamicScore(
        'Deus Ex 2: Invisible War',
        null,
        '2012-07-03',
        null,
        {
          gameId: 'gog-1207659068',
          platforms: [{ platformId: 'gog', platformGameId: '1207659068' }],
        }
      );

      expect(resolved).not.toBeNull();
      expect(resolved?.source).toBe('metacritic');
      expect(resolved?.score).toBe(80);
      expect(resolved?.numReviews).toBe(28);
      expect(resolved?.isVerified).toBe(true);
      expect(resolved?.url).toContain('deus-ex-invisible-war');
    });

    it('matches valid intermediate-numeral subtitle pairs and rejects subset/trailing/generic false positives across titleUtils, entityResolver, and steamMatcher', () => {
      // Positive matches (bidirectional)
      expect(
        isIntermediateNumeralSubtitleMatch('Deus Ex 2: Invisible War', 'Deus Ex: Invisible War')
      ).toBe(true);
      expect(
        isIntermediateNumeralSubtitleMatch('Deus Ex: Invisible War', 'Deus Ex 2: Invisible War')
      ).toBe(true);
      expect(stripIntermediateSubtitleNumeral('Deus Ex 2: Invisible War')).toBe(
        'Deus Ex: Invisible War'
      );

      expect(
        isIntermediateNumeralSubtitleMatch(
          'The Elder Scrolls III: Morrowind',
          'The Elder Scrolls: Morrowind'
        )
      ).toBe(true);
      expect(
        isIntermediateNumeralSubtitleMatch(
          'The Elder Scrolls: Morrowind',
          'The Elder Scrolls III: Morrowind'
        )
      ).toBe(true);
      expect(stripIntermediateSubtitleNumeral('The Elder Scrolls III: Morrowind')).toBe(
        'The Elder Scrolls: Morrowind'
      );

      // steamMatcher.computeTitleSimilarity accepts both pairs at 1.0
      expect(computeTitleSimilarity('Deus Ex 2: Invisible War', 'Deus Ex: Invisible War')).toBe(1);
      expect(
        computeTitleSimilarity('The Elder Scrolls III: Morrowind', 'The Elder Scrolls: Morrowind')
      ).toBe(1);

      // entityResolver.computeEntityMatchConfidence accepts both pairs (and preserves Quake <-> Quake Remastered!)
      const deusExEval = computeEntityMatchConfidence(
        { title: 'Deus Ex 2: Invisible War', releaseYear: 2003, developers: ['Ion Storm'] },
        { title: 'Deus Ex: Invisible War', releaseYear: 2003, developers: ['Ion Storm'] }
      );
      expect(deusExEval.isAccepted).toBe(true);
      expect(deusExEval.titleScore).toBe(100);

      const morrowindEval = computeEntityMatchConfidence(
        {
          title: 'The Elder Scrolls III: Morrowind',
          releaseYear: 2002,
          developers: ['Bethesda Game Studios'],
        },
        {
          title: 'The Elder Scrolls: Morrowind',
          releaseYear: 2002,
          developers: ['Bethesda Game Studios'],
        }
      );
      expect(morrowindEval.isAccepted).toBe(true);
      expect(morrowindEval.titleScore).toBe(100);

      // Trap T5 preservation: entityResolver still merges Quake <-> Quake Remastered
      const quakeRemasterEval = computeEntityMatchConfidence(
        { title: 'Quake', releaseYear: 1996, developers: ['id Software'] },
        { title: 'Quake Remastered', releaseYear: 2021, developers: ['id Software'] }
      );
      expect(quakeRemasterEval.isAccepted).toBe(true);

      // Negative rejections (Trap T4 subset hole, trailing numeral, generic subtitle)
      const negativePairs: Array<[string, string]> = [
        ['Deus Ex 2: Invisible', 'Deus Ex: Invisible War'],
        ['Total War: WARHAMMER II', 'Total War: WARHAMMER'],
        ['Half-Life 2: Episode One', 'Half-Life: Episode One'],
        ['Deus Ex 2: Invisible War', 'Deus Ex: Human Revolution'],
        ['Deus Ex 2: Invisible War', 'Deus Ex'],
        ['Mafia II', 'Mafia'],
      ];

      for (const [titleA, titleB] of negativePairs) {
        expect(isIntermediateNumeralSubtitleMatch(titleA, titleB)).toBe(false);
        expect(isIntermediateNumeralSubtitleMatch(titleB, titleA)).toBe(false);
        expect(computeTitleSimilarity(titleA, titleB)).toBe(0);
        expect(
          computeEntityMatchConfidence({ title: titleA }, { title: titleB }).isAccepted
        ).toBe(false);
      }
    });

    it('enforces Monotonic Authority Lattice so GOG 68 or STM cannot overwrite cached MC 80/84 during refresh', async () => {
      // 1. Verify exact rank hierarchy
      const makeScore = (
        source: CriticSource,
        score: number,
        numReviews?: number
      ): CriticScoreData => ({
        source,
        score,
        tier: calculateTier(score),
        numReviews,
        url: '',
        isVerified: source === 'metacritic' || source === 'opencritic',
      });

      expect(getReviewSourceAuthorityRank(makeScore('custom', 90), { isUserOverride: true })).toBe(
        5
      );
      expect(getReviewSourceAuthorityRank(makeScore('metacritic', 80, 28))).toBe(4);
      expect(getReviewSourceAuthorityRank(makeScore('opencritic', 84, 16))).toBe(3);
      expect(getReviewSourceAuthorityRank(makeScore('metacritic_user', 78, 40))).toBe(2);
      expect(getReviewSourceAuthorityRank(makeScore('steam', 82, 500))).toBe(2);
      expect(getReviewSourceAuthorityRank(makeScore('metacritic_user', 78, 12))).toBe(1);
      expect(getReviewSourceAuthorityRank(makeScore('steam', 82, 5))).toBe(1);
      expect(getReviewSourceAuthorityRank(makeScore('gog', 68, 120))).toBe(1);
      expect(getReviewSourceAuthorityRank(makeScore('epic', 86, 40))).toBe(1);
      expect(getReviewSourceAuthorityRank(makeScore('xbox', 84, 60))).toBe(1);
      expect(getReviewSourceAuthorityRank(makeScore('custom', 80))).toBe(1);
      expect(getReviewSourceAuthorityRank(null)).toBe(0);

      // 2. Seed valid cached MC 80 for Deus Ex 2: Invisible War
      const cachedMc80: CriticScoreData = {
        id: 'mc-deus-ex-invisible-war',
        source: 'metacritic',
        score: 80,
        tier: 'Strong',
        numReviews: 28,
        url: 'https://www.metacritic.com/game/deus-ex-invisible-war/critic-reviews/',
        isVerified: true,
      };
      saveStagedCache(
        'antigravity_critic_v8_title:deus ex 2: invisible war',
        cachedMc80,
        MutabilityTier.TIER_1_IMMUTABLE,
        { source: 'metacritic', isVerified: true, dynamicResolved: true }
      );

      // Simulate refresh where Tier 1/2 return empty and Tier 4/5 return STM 71 and GOG 68
      vi.spyOn(storefrontReviewHarvester, 'getStorefrontAnchor').mockResolvedValue(null);
      vi.spyOn(metacriticResolver, 'resolveMetacritic').mockResolvedValue({
        critic: null,
        user: null,
      });
      vi.spyOn(wikidataBridge, 'resolveForGame').mockResolvedValue(null);
      vi.spyOn(openCriticResolver, 'resolveForGame').mockResolvedValue(null);
      vi.spyOn(steamReviewResolver, 'resolveScore').mockResolvedValue({
        id: 'steam-6920',
        source: 'steam',
        score: 71,
        tier: 'Fair',
        numReviews: 2620,
        url: 'https://store.steampowered.com/app/6920',
        isVerified: false,
        isSynthetic: true,
      });
      vi.spyOn(storefrontStarResolver, 'resolveStorefrontScore').mockResolvedValue({
        id: 'gog-1207659068',
        source: 'gog',
        score: 68,
        tier: 'Fair',
        starRatingRaw: 3.4,
        numReviews: 120,
        url: 'https://www.gog.com/en/game/deus_ex_invisible_war',
        isVerified: false,
      });

      const afterSteamAttempt = await criticScoreService.resolveDynamicScore(
        'Deus Ex 2: Invisible War',
        null,
        '2012-07-03',
        null,
        { bypassAttempted: true, gameId: 'gog-1207659068' }
      );
      expect(afterSteamAttempt?.source).toBe('metacritic');
      expect(afterSteamAttempt?.score).toBe(80);
      expect(
        loadStagedCache<CriticScoreData>('antigravity_critic_v8_title:deus ex 2: invisible war')
          .data?.source
      ).toBe('metacritic');
      expect(
        loadStagedCache<CriticScoreData>('antigravity_critic_v8_title:deus ex 2: invisible war')
          .data?.score
      ).toBe(80);

      // Even when Steam returns null and only GOG 68 is returned, cached MC 84 stays protected
      const cachedMc84: CriticScoreData = {
        ...cachedMc80,
        score: 84,
        tier: 'Mighty',
        numReviews: 50,
      };
      saveStagedCache(
        'antigravity_critic_v8_title:deus ex 2: invisible war',
        cachedMc84,
        MutabilityTier.TIER_1_IMMUTABLE,
        { source: 'metacritic', isVerified: true, dynamicResolved: true }
      );
      vi.spyOn(steamReviewResolver, 'resolveScore').mockResolvedValue(null);

      const afterGogAttempt = await criticScoreService.resolveDynamicScore(
        'Deus Ex 2: Invisible War',
        null,
        '2012-07-03',
        null,
        { bypassAttempted: true, gameId: 'gog-1207659068' }
      );
      expect(afterGogAttempt?.source).toBe('metacritic');
      expect(afterGogAttempt?.score).toBe(84);
      expect(
        loadStagedCache<CriticScoreData>('antigravity_critic_v8_title:deus ex 2: invisible war')
          .data?.score
      ).toBe(84);

      // Vault seeding also rejects downgrades while allowing upward monotonic promotion
      const gogDowngradeSeeded = criticScoreService.seedFromVaultIfMissing(
        null,
        'Deus Ex 2: Invisible War',
        {
          id: 'gog-1207659068',
          source: 'gog',
          score: 68,
          tier: 'Fair',
          starRatingRaw: 3.4,
          numReviews: 120,
          url: 'https://www.gog.com/en/game/deus_ex_invisible_war',
          isVerified: false,
        },
        '2003-12-02'
      );
      expect(gogDowngradeSeeded).toBe(false);
    });
  });

  // =========================================================================
  // 3. Trap T1 Remake Protection (deferredOlderCritic)
  // =========================================================================
  describe('Trap T1: Remake Protection via deferredOlderCritic', () => {
    it('resolves Dead Space (2023) to dead-space-2023 (MC 89), NEVER the 2008 original (MC 86), while keeping Dead Space (2008) on MC 86', async () => {
      const bundle2023 = await metacriticResolver.resolveMetacritic('Dead Space', 2023);
      expect(bundle2023.critic).not.toBeNull();
      expect(bundle2023.critic?.source).toBe('metacritic');
      expect(bundle2023.critic?.score).toBe(89);
      expect(bundle2023.critic?.numReviews).toBe(73);
      expect(bundle2023.critic?.url).toContain('dead-space-2023');

      metacriticResolver.clearCache();

      const bundle2008 = await metacriticResolver.resolveMetacritic('Dead Space', 2008);
      expect(bundle2008.critic).not.toBeNull();
      expect(bundle2008.critic?.source).toBe('metacritic');
      expect(bundle2008.critic?.score).toBe(86);
      expect(bundle2008.critic?.numReviews).toBe(28);
      expect(bundle2008.critic?.url).toContain('/dead-space/');
      expect(bundle2008.critic?.url).not.toContain('dead-space-2023');
    });

    it('discards deferredOlderCritic when Step 3 Finder search reveals a ±2 year remake candidate', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/composer/metacritic/pages/games/eclipse-protocol/web')) {
          return new Response(
            JSON.stringify({
              data: {
                item: {
                  type: 'game-title',
                  slug: 'eclipse-protocol',
                  title: 'Eclipse Protocol',
                  releaseDate: '2007-11-12',
                  criticScoreSummary: { score: 81, reviewCount: 30, max: 100 },
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (url.includes('/composer/metacritic/pages/games/eclipse-protocol-2023/web')) {
          return new Response(JSON.stringify({ code: 404 }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/composer/metacritic/pages/games/eclipse-protocol-remake/web')) {
          return new Response(
            JSON.stringify({
              data: {
                item: {
                  type: 'game-title',
                  slug: 'eclipse-protocol-remake',
                  title: 'Eclipse Protocol',
                  releaseDate: '2023-04-14',
                  criticScoreSummary: { score: 91, reviewCount: 62, max: 100 },
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (url.includes('/finder/metacritic/search/')) {
          return new Response(
            JSON.stringify({
              data: {
                items: [
                  {
                    slug: 'eclipse-protocol',
                    title: 'Eclipse Protocol',
                    releaseDate: '2007-11-12',
                    criticScoreSummary: { score: 81, reviewCount: 30 },
                  },
                  {
                    slug: 'eclipse-protocol-remake',
                    title: 'Eclipse Protocol',
                    releaseDate: '2023-04-14',
                    criticScoreSummary: { score: 91, reviewCount: 62 },
                  },
                ],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response('Not Found', { status: 404 });
      });

      const bundle = await metacriticResolver.resolveMetacritic('Eclipse Protocol', 2023);
      expect(bundle.critic).not.toBeNull();
      expect(bundle.critic?.score).toBe(91);
      expect(bundle.critic?.url).toContain('eclipse-protocol-remake');
    });
  });

  // =========================================================================
  // 4. Trap T2 Phrase-Safe Edition Stripping
  // =========================================================================
  describe('Trap T2: Phrase-Safe Edition Stripping Without Content-Word Pollution', () => {
    it('preserves substantive content words in franchise titles while stripping exact packaging phrases and launcher suffixes', () => {
      // Content words MUST be preserved (never stripped as standalone edition tokens)
      expect(stripPackagingEditionPhrases("Assassin's Creed Valhalla")).toBe(
        "Assassin's Creed Valhalla"
      );
      expect(stripPackagingEditionPhrases('Deus Ex: Human Revolution')).toBe(
        'Deus Ex: Human Revolution'
      );
      expect(stripPackagingEditionPhrases('Resident Evil')).toBe('Resident Evil');
      expect(stripPackagingEditionPhrases('Worms Revolution')).toBe('Worms Revolution');
      expect(stripPackagingEditionPhrases('Godzilla Voxel Wars')).toBe('Godzilla Voxel Wars');

      expect(isTitleCompatible("Assassin's Creed Valhalla", "Assassin's Creed")).toBe(false);
      expect(isTitleCompatible('Deus Ex: Human Revolution', 'Deus Ex')).toBe(false);
      expect(isTitleCompatible('Resident Evil', 'Resident')).toBe(false);
      expect(isTitleCompatible('Worms Revolution', 'Worms')).toBe(false);
      expect(isTitleCompatible('Godzilla Voxel Wars', 'Godzilla')).toBe(false);

      // Exact multi-word packaging edition phrases & trailing launcher suffix strip cleanly
      expect(stripPackagingEditionPhrases('For Honor: Valhalla Edition')).toBe('For Honor');
      expect(stripPackagingEditionPhrases('Battlefield V EA Play Edition')).toBe('Battlefield V');
      expect(stripPackagingEditionPhrases('Call of Duty: Black Ops 6 - Launcher')).toBe(
        'Call of Duty: Black Ops 6'
      );
      expect(stripPackagingEditionPhrases('Diablo III: Ultimate Evil Edition')).toBe('Diablo III');
      expect(stripPackagingEditionPhrases('Dead Cells: Trials of Fear Edition')).toBe('Dead Cells');

      expect(isTitleCompatible('For Honor: Valhalla Edition', 'For Honor')).toBe(true);
      expect(isTitleCompatible('Battlefield V EA Play Edition', 'Battlefield V')).toBe(true);
      expect(
        isTitleCompatible('Call of Duty: Black Ops 6 - Launcher', 'Call of Duty: Black Ops 6')
      ).toBe(true);

      // Ground-truth anchor compatibility (remaster/collection & canonical subtitle suffix) stays separate from heuristic isTitleCompatible
      expect(isAnchorSlugCompatible('BioShock Remastered', 'bioshock-the-collection')).toBe(true);
      expect(isAnchorSlugCompatible('Cat Quest II', 'cat-quest-ii-the-lupus-empire')).toBe(true);
      expect(isTitleCompatible('Pool of Radiance', 'Pool of Radiance: Ruins of Myth Drannor')).toBe(
        false
      );
    });
  });

  // =========================================================================
  // 5. Diacritics, Comma-Numbers & Acronyms
  // =========================================================================
  describe('Diacritics, Comma-Numbers & Dotted Acronym Compatibility', () => {
    it('resolves God of War Ragnarök (MC 94) & Warhammer 40,000: Darktide (MC 75) and validates L.A. Noire & OpenCritic non-ASCII slugs', async () => {
      expect(toCanonicalMetacriticSlug('God of War Ragnarök')).toBe('god-of-war-ragnarok');
      expect(toCanonicalMetacriticSlug('Warhammer 40,000: Darktide')).toBe(
        'warhammer-40000-darktide'
      );
      expect(toCanonicalMetacriticSlug('L.A. Noire')).toBe('la-noire');
      expect(normalizeTitleKey('L.A. Noire')).toBe('la noire');

      const gow = await criticScoreService.resolveDynamicScore(
        'God of War Ragnarök',
        2322010,
        2022
      );
      expect(gow?.source).toBe('metacritic');
      expect(gow?.score).toBe(94);
      expect(gow?.numReviews).toBe(141);
      expect(gow?.isVerified).toBe(true);
      expect(gow?.url).toContain('god-of-war-ragnarok');

      // OpenCritic non-ASCII slug projection allows `god-of-war-ragnar-k`
      expect(
        criticScoreService.isScoreSemanticallyCompatible('God of War Ragnarök', {
          id: 12919,
          source: 'opencritic',
          score: 93,
          tier: 'Mighty',
          url: 'https://opencritic.com/game/12919/god-of-war-ragnar-k',
          isVerified: true,
        })
      ).toBe(true);

      const darktide = await criticScoreService.resolveDynamicScore(
        'Warhammer 40,000: Darktide',
        1361210,
        2022
      );
      expect(darktide?.source).toBe('metacritic');
      expect(darktide?.score).toBe(75);
      expect(darktide?.numReviews).toBe(52);
      expect(darktide?.isVerified).toBe(true);
      expect(darktide?.url).toContain('warhammer-40000-darktide');

      // 2-letter dotted acronym matching
      expect(isTitleCompatible('L.A. Noire', 'LA Noire')).toBe(true);
      expect(isTitleCompatible('L.A. Noire', 'L.A. Noire: The Complete Edition')).toBe(true);
      expect(isTitleCompatible('L.A. Noire', 'L.A. Noire: The VR Case Files')).toBe(false);
    });
  });

  // =========================================================================
  // 6. Stage 0 v16 Self-Heal, Transient 6h Cap, Unified Resolver & All 8 Display Metas
  // =========================================================================
  describe('Stage 0 v16 Self-Heal, Transient 6h Cap, Unified Resolver & Display Meta Matrix', () => {
    it('executes Stage 0 lazy v16 migration: promotes shadowed MC alias + SQLite write-through, un-pins 180d fallback to 7d non-destructively, and preserves Tier 0 overrides', () => {
      vi.useFakeTimers();
      const baseTime = new Date('2026-10-16T12:00:00.000Z').getTime();
      vi.setSystemTime(baseTime);

      localStorage.removeItem('antigravity_critic_schema_v16');

      const saveGameDetailSpy = vi.fn().mockResolvedValue({ success: true });
      (window as unknown as { electronAPI?: unknown }).electronAPI = {
        offlineVault: {
          saveGameDetail: saveGameDetailSpy,
        },
      };

      localStorage.setItem(
        'universal_game_library_catalog',
        JSON.stringify([
          { id: 'steam-286690', steamAppId: 286690, title: 'Metro 2033 Redux' },
          { id: 'steam-880001', steamAppId: 880001, title: 'Pinned Fallback Odyssey' },
          { id: 'steam-880002', steamAppId: 880002, title: 'User Overridden Classic' },
        ])
      );

      // 1) Shadowed-alias pair: active id:286690 downgraded to STM 82, shadowed title alias has verified MC 90
      saveStagedCache<CriticScoreData>(
        'antigravity_critic_v8_id:286690',
        {
          id: 'steam-286690',
          source: 'steam',
          score: 82,
          tier: 'Strong',
          numReviews: 50000,
          url: 'https://store.steampowered.com/app/286690',
          isVerified: false,
          isSynthetic: true,
        },
        MutabilityTier.TIER_1_IMMUTABLE,
        { source: 'steam', isVerified: false, dynamicResolved: true, cachedAt: baseTime }
      );
      saveStagedCache<CriticScoreData>(
        'antigravity_critic_v8_title:metro 2033 redux',
        {
          id: 'mc-metro-2033-redux',
          source: 'metacritic',
          score: 90,
          tier: 'Mighty',
          numReviews: 5,
          url: 'https://www.metacritic.com/game/metro-2033-redux/critic-reviews/',
          isVerified: true,
        },
        MutabilityTier.TIER_1_IMMUTABLE,
        { source: 'metacritic', isVerified: true, dynamicResolved: true, cachedAt: baseTime }
      );

      // 2) Poisoned 180d immutable non-critic fallback (STM 79)
      saveStagedCache<CriticScoreData>(
        'antigravity_critic_v8_id:880001',
        {
          id: 'steam-880001',
          source: 'steam',
          score: 79,
          tier: 'Strong',
          numReviews: 320,
          url: 'https://store.steampowered.com/app/880001',
          isVerified: false,
          isSynthetic: true,
        },
        MutabilityTier.TIER_1_IMMUTABLE,
        { source: 'steam', isVerified: false, dynamicResolved: true, cachedAt: baseTime }
      );

      // 3) Tier 0 User Override (must NEVER be touched)
      saveStagedCache<CriticScoreData>(
        'antigravity_critic_v8_id:880002',
        {
          id: 'custom-880002',
          source: 'custom',
          score: 97,
          tier: 'Mighty',
          url: '',
          isVerified: true,
        },
        MutabilityTier.TIER_0_USER_OVERRIDE,
        { source: 'custom', isVerified: true, dynamicResolved: true, cachedAt: baseTime }
      );

      const hydratedEvents: Array<{ hydratedFromVault?: boolean }> = [];
      const onUpdated = ((e: Event) => {
        const detail = (e as CustomEvent<{ hydratedFromVault?: boolean }>).detail;
        if (detail?.hydratedFromVault) hydratedEvents.push(detail);
      }) as EventListener;
      window.addEventListener('antigravity_critic_updated', onUpdated);

      const freshService = new CriticScoreService();
      try {
        // Trigger ensureHydrated() — M2 contract: migration runs lazily via setTimeout(0), NOT synchronously
        freshService.getCriticScore(
          null,
          'Nonexistent Migration Probe',
          undefined,
          undefined,
          undefined,
          false,
          true
        );
        expect(localStorage.getItem('antigravity_critic_schema_v16')).toBeNull();

        // Advance timers for chunked migration + 250ms debounced SQLite write-through
        vi.advanceTimersByTime(500);

        expect(localStorage.getItem('antigravity_critic_schema_v16')).toBe('1');

        // Shadowed MC 90 alias promoted onto canonical id:286690
        const healedMetro = loadStagedCache<CriticScoreData>('antigravity_critic_v8_id:286690');
        expect(healedMetro.valid).toBe(true);
        expect(healedMetro.data?.source).toBe('metacritic');
        expect(healedMetro.data?.score).toBe(90);
        expect(hydratedEvents.length).toBeGreaterThanOrEqual(1);
        expect(saveGameDetailSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            gameId: 'steam-286690',
            steamAppId: 286690,
            criticScore: expect.objectContaining({ source: 'metacritic', score: 90 }),
          })
        );

        // Poisoned 180d STM 79 un-pinned non-destructively to 7d (score remains visible!)
        const unpinnedFallback = loadStagedCache<CriticScoreData>(
          'antigravity_critic_v8_id:880001'
        );
        expect(unpinnedFallback.valid).toBe(true);
        expect(unpinnedFallback.data?.source).toBe('steam');
        expect(unpinnedFallback.data?.score).toBe(79);
        expect(unpinnedFallback.entry?.tier).toBe(MutabilityTier.TIER_2_MATURE);
        expect(unpinnedFallback.entry?.ttlMs).toBe(7 * DAY_MS);

        // Tier 0 User Override preserved untouched
        const untouchedOverride = loadStagedCache<CriticScoreData>(
          'antigravity_critic_v8_id:880002'
        );
        expect(untouchedOverride.valid).toBe(true);
        expect(untouchedOverride.entry?.tier).toBe(MutabilityTier.TIER_0_USER_OVERRIDE);
        expect(untouchedOverride.entry?.ttlMs).toBe(Infinity);
        expect(untouchedOverride.data?.score).toBe(97);
      } finally {
        window.removeEventListener('antigravity_critic_updated', onUpdated);
        freshService.disposeEventListeners();
      }
    });

    it('caps non-critic fallback TTL at 6 hours when Tier 1/2 had a transient failure, vs 14 days on clean non-transient fallback', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-16T12:00:00.000Z'));

      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(storefrontReviewHarvester, 'getStorefrontAnchor').mockResolvedValue(null);
      vi.spyOn(wikidataBridge, 'resolveForGame').mockResolvedValue(null);
      vi.spyOn(openCriticResolver, 'resolveForGame').mockResolvedValue(null);
      vi.spyOn(storefrontStarResolver, 'resolveStorefrontScore').mockResolvedValue(null);
      vi.spyOn(steamReviewResolver, 'resolveScore').mockResolvedValue({
        id: 'steam-775500',
        source: 'steam',
        score: 84,
        tier: 'Strong',
        percentRecommended: 88,
        numReviews: 500,
        url: 'https://store.steampowered.com/app/775500',
        isVerified: false,
        isSynthetic: true,
      });

      // Case A: Transient error on Tier 1 Metacritic -> provisional 6h TTL cap
      const mcSpy = vi
        .spyOn(metacriticResolver, 'resolveMetacritic')
        .mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const transientResult = await criticScoreService.resolveDynamicScore(
        'Transient Outage Chronicle',
        775500,
        2019
      );
      expect(transientResult?.source).toBe('steam');
      expect(transientResult?.score).toBe(84);

      const transientStaged = loadStagedCache<CriticScoreData>('antigravity_critic_v8_id:775500');
      expect(transientStaged.valid).toBe(true);
      expect(transientStaged.entry?.tier).toBe(MutabilityTier.TIER_3_FRESH);
      expect(transientStaged.entry?.ttlMs).toBe(6 * HOUR_MS);

      // Case B: Clean miss on Tier 1/2 (no transient failure) -> 14d non-critic cap (NOT 180d immutable)
      mcSpy.mockResolvedValueOnce({ critic: null, user: null });
      const cleanResult = await criticScoreService.resolveDynamicScore(
        'Clean Miss Chronicle',
        775501,
        2019
      );
      expect(cleanResult?.source).toBe('steam');
      expect(cleanResult?.score).toBe(84);

      const cleanStaged = loadStagedCache<CriticScoreData>('antigravity_critic_v8_id:775501');
      expect(cleanStaged.valid).toBe(true);
      expect(cleanStaged.entry?.tier).toBe(MutabilityTier.TIER_2_MATURE);
      expect(cleanStaged.entry?.ttlMs).toBe(14 * DAY_MS);
      expect(cleanStaged.entry?.ttlMs).toBeLessThan(TIER_TTLS.immutable);
    });

    it('returns complete, authoritative display metadata across all 8 CriticSource values (MC, OC, MCU, STM, GOG, EGS, XBX, CST)', () => {
      const matrix: Array<{
        score: CriticScoreData;
        shortTag: ReviewSourceShortTag;
        label: string;
        shortLabel: string;
        cardHeading: string;
        actionLabel: string;
        isPressCritic: boolean;
        isStoreRating: boolean;
        authorityRank: number;
        ariaContains: string[];
      }> = [
        {
          score: {
            source: 'metacritic',
            score: 90,
            tier: 'Mighty',
            numReviews: 45,
            url: 'https://www.metacritic.com/game/metro-2033-redux/critic-reviews/',
            isVerified: true,
          },
          shortTag: 'MC',
          label: 'Metacritic Metascore',
          shortLabel: 'Metacritic',
          cardHeading: 'Metacritic Reviews',
          actionLabel: 'View on Metacritic',
          isPressCritic: true,
          isStoreRating: false,
          authorityRank: 4,
          ariaContains: ['Metacritic Metascore', '90 out of 100', 'Mighty'],
        },
        {
          score: {
            source: 'opencritic',
            score: 84,
            tier: 'Mighty',
            percentRecommended: 85,
            numReviews: 16,
            url: 'https://opencritic.com/game/957/metro-2033-redux',
            isVerified: true,
          },
          shortTag: 'OC',
          label: 'OpenCritic',
          shortLabel: 'OpenCritic',
          cardHeading: 'OpenCritic Reviews',
          actionLabel: 'View on OpenCritic',
          isPressCritic: true,
          isStoreRating: false,
          authorityRank: 3,
          ariaContains: ['OpenCritic', '84 out of 100', '85% recommended'],
        },
        {
          score: {
            source: 'metacritic_user',
            score: 78,
            userScoreRaw: 7.8,
            tier: 'Strong',
            numReviews: 112,
            url: 'https://www.metacritic.com/game/bioshock-2-remastered/user-reviews/',
            isVerified: false,
          },
          shortTag: 'MCU',
          label: 'Metacritic User Score',
          shortLabel: 'MC User Score',
          cardHeading: 'Metacritic User Score',
          actionLabel: 'View Metacritic User Reviews',
          isPressCritic: false,
          isStoreRating: false,
          authorityRank: 2,
          ariaContains: ['Metacritic User Score', '7.8 out of 10', '78 out of 100'],
        },
        {
          score: {
            source: 'steam',
            score: 88,
            tier: 'Mighty',
            percentRecommended: 93,
            numReviews: 2400,
            url: 'https://store.steampowered.com/app/286690',
            isVerified: false,
            isSynthetic: true,
          },
          shortTag: 'STM',
          label: 'Steam Community',
          shortLabel: 'Steam Community',
          cardHeading: 'Steam Community Score',
          actionLabel: 'View on Steam Store',
          isPressCritic: false,
          isStoreRating: false,
          authorityRank: 2,
          ariaContains: ['Steam Community', '88 out of 100', '93% recommended'],
        },
        {
          score: {
            source: 'gog',
            score: 84,
            starRatingRaw: 4.2,
            tier: 'Strong',
            numReviews: 310,
            url: 'https://www.gog.com/en/game/deus_ex_invisible_war',
            isVerified: false,
          },
          shortTag: 'GOG',
          label: 'GOG Player Rating',
          shortLabel: 'GOG Rating',
          cardHeading: 'GOG Player Rating',
          actionLabel: 'View on GOG',
          isPressCritic: false,
          isStoreRating: true,
          authorityRank: 1,
          ariaContains: ['GOG Player Rating', '4.2 out of 5 stars', '84 out of 100'],
        },
        {
          score: {
            source: 'epic',
            score: 88,
            starRatingRaw: 4.4,
            tier: 'Mighty',
            numReviews: 95,
            url: 'https://store.epicgames.com/p/alan-wake-2',
            isVerified: false,
          },
          shortTag: 'EGS',
          label: 'Epic Store Rating',
          shortLabel: 'Epic Rating',
          cardHeading: 'Epic Store Rating',
          actionLabel: 'View on Epic Store',
          isPressCritic: false,
          isStoreRating: true,
          authorityRank: 1,
          ariaContains: ['Epic Store Rating', '4.4 out of 5 stars', '88 out of 100'],
        },
        {
          score: {
            source: 'xbox',
            score: 86,
            starRatingRaw: 4.3,
            tier: 'Mighty',
            numReviews: 140,
            url: 'https://www.xbox.com/en-US/games/store/sample/9NBLGGH12345',
            isVerified: false,
          },
          shortTag: 'XBX',
          label: 'Xbox Store Rating',
          shortLabel: 'Xbox Rating',
          cardHeading: 'Xbox Store Rating',
          actionLabel: 'View on Xbox Store',
          isPressCritic: false,
          isStoreRating: true,
          authorityRank: 1,
          ariaContains: ['Xbox Store Rating', '4.3 out of 5 stars', '86 out of 100'],
        },
        {
          score: {
            source: 'custom',
            score: 95,
            tier: 'Mighty',
            url: 'https://example.com/custom-review',
            isVerified: false,
          },
          shortTag: 'CST',
          label: 'Custom Score',
          shortLabel: 'Custom Score',
          cardHeading: 'Custom Review Score',
          actionLabel: 'View Review Source',
          isPressCritic: false,
          isStoreRating: false,
          authorityRank: 1,
          ariaContains: ['Custom Score', '95 out of 100', 'Mighty'],
        },
      ];

      expect(matrix).toHaveLength(8);
      for (const item of matrix) {
        const meta = getReviewSourceDisplayMeta(item.score);
        expect(meta.shortTag).toBe(item.shortTag);
        expect(meta.label).toBe(item.label);
        expect(meta.shortLabel).toBe(item.shortLabel);
        expect(meta.cardHeading).toBe(item.cardHeading);
        expect(meta.actionLabel).toBe(item.actionLabel);
        expect(meta.externalLinkPrefix.length).toBeGreaterThan(0);
        expect(meta.isPressCritic).toBe(item.isPressCritic);
        expect(meta.isStoreRating).toBe(item.isStoreRating);
        expect(meta.authorityRank).toBe(item.authorityRank);
        for (const fragment of item.ariaContains) {
          expect(meta.ariaLabel).toContain(fragment);
        }
      }
    });

    it('delegates resolveGameReviewScore through openCriticModule.getOpenCriticData (Trap T10) and excludes legacy local_federated fake metacritic anchors', () => {
      const spy = vi.spyOn(openCriticModule, 'getOpenCriticData');

      // Legacy local_federated GOG star rating masquerading inside enrichedMetadata.metacritic MUST be excluded
      const gogFakeAnchorGame = makeCanonicalGame({
        id: 'gog-1207659068',
        title: 'Deus Ex 2: Invisible War',
        steamAppId: undefined,
        platforms: [{ platformId: 'gog', platformGameId: '1207659068', installed: false }],
        enrichedMetadata: {
          appId: 0,
          name: 'Deus Ex 2: Invisible War',
          shortDescription: '',
          detailedDescription: '',
          aboutTheGame: '',
          headerImage: '',
          capsuleImage: '',
          iconUrl: '',
          developers: ['Ion Storm'],
          publishers: ['Eidos'],
          releaseDate: '2012-07-03',
          genres: ['RPG'],
          tags: [],
          categories: [],
          screenshots: [],
          movies: [],
          systemRequirements: {},
          enrichedSource: 'gog',
          metadataQuality: 'local_federated',
          metacritic: { score: 68, url: '' },
          reviewSummary: {
            reviewScore: 0,
            reviewScoreDesc: '',
            totalPositive: 0,
            totalNegative: 0,
            totalReviews: 0,
            positivePercent: 0,
          },
        },
      });
      expect(buildVerifiedSteamMetacriticAnchor(gogFakeAnchorGame)).toBeUndefined();

      // Genuine Steam enrichedMetadata.metacritic anchor IS extracted cleanly
      const verifiedSteamGame = makeCanonicalGame({
        id: 'steam-286690',
        title: 'Metro 2033 Redux',
        steamAppId: 286690,
        enrichedMetadata: {
          appId: 286690,
          name: 'Metro 2033 Redux',
          shortDescription: '',
          detailedDescription: '',
          aboutTheGame: '',
          headerImage: '',
          capsuleImage: '',
          iconUrl: '',
          developers: ['4A Games'],
          publishers: ['Deep Silver'],
          releaseDate: '2014-08-26',
          genres: ['Action'],
          tags: [],
          categories: [],
          screenshots: [],
          movies: [],
          systemRequirements: {},
          enrichedSource: 'steam',
          metacritic: {
            score: 90,
            url: 'https://www.metacritic.com/game/pc/metro-2033-redux',
          },
          reviewSummary: {
            reviewScore: 8,
            reviewScoreDesc: 'Very Positive',
            totalPositive: 72000,
            totalNegative: 8000,
            totalReviews: 80000,
            positivePercent: 90,
          },
        },
      });

      const anchor = buildVerifiedSteamMetacriticAnchor(verifiedSteamGame);
      expect(anchor?.storefront).toBe('steam');
      expect(anchor?.metacriticSlug).toBe('metro-2033-redux');
      expect(anchor?.metacriticScore).toBe(90);

      resolveGameReviewScore(verifiedSteamGame, { skipBackgroundTrigger: true });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[6]).toBe(true);
      expect(spy.mock.calls[0]?.[7]).toEqual({
        gameId: 'steam-286690',
        platforms: verifiedSteamGame.platforms,
      });
    });

    it('runs Stage 1 Wikidata batch pre-pass & Stage 2 priority-ordered non-destructive sync without wiping verified MC cache', async () => {
      // Seed verified MC 90 for Cyberpunk 2077 (fresh) and non-critic STM fallback for Metro 2033 Redux
      saveStagedCache<CriticScoreData>(
        'antigravity_critic_v8_id:1091500',
        {
          id: 'mc-cyberpunk-2077',
          source: 'metacritic',
          score: 86,
          tier: 'Mighty',
          numReviews: 100,
          url: 'https://www.metacritic.com/game/cyberpunk-2077/critic-reviews/',
          isVerified: true,
        },
        MutabilityTier.TIER_1_IMMUTABLE,
        { source: 'metacritic', isVerified: true, dynamicResolved: true }
      );
      saveStagedCache<CriticScoreData>(
        'antigravity_critic_v8_id:286690',
        {
          id: 'steam-286690',
          source: 'steam',
          score: 82,
          tier: 'Strong',
          numReviews: 50000,
          url: 'https://store.steampowered.com/app/286690',
          isVerified: false,
          isSynthetic: true,
        },
        MutabilityTier.TIER_2_MATURE,
        { source: 'steam', isVerified: false, dynamicResolved: false }
      );

      const batchSpy = vi.spyOn(wikidataBridge, 'batchResolveByStoreIds');
      const clearCacheSpy = vi.spyOn(criticScoreService, 'clearCache');
      const resolutionOrder: string[] = [];
      const originalResolve = criticScoreService.resolveDynamicScore.bind(criticScoreService);
      vi.spyOn(criticScoreService, 'resolveDynamicScore').mockImplementation(
        async (title, steamAppId, releaseYear, anchor, options) => {
          resolutionOrder.push(title);
          return originalResolve(title, steamAppId, releaseYear, anchor, options);
        }
      );

      const catalog: CanonicalGame[] = [
        makeCanonicalGame({
          id: 'steam-1091500',
          title: 'Cyberpunk 2077',
          steamAppId: 1091500,
          releaseDate: '2020-12-10',
          platforms: [{ platformId: 'steam', platformGameId: '1091500', installed: false }],
        }),
        makeCanonicalGame({
          id: 'steam-286690',
          title: 'Metro 2033 Redux',
          steamAppId: 286690,
          releaseDate: '2014-08-26',
          platforms: [{ platformId: 'steam', platformGameId: '286690', installed: false }],
        }),
        makeCanonicalGame({
          id: 'steam-1517290',
          title: 'Battlefield 2042',
          steamAppId: 1517290,
          releaseDate: '2021-11-19',
          platforms: [{ platformId: 'steam', platformGameId: '1517290', installed: false }],
        }),
      ];

      await syncJobManager.startCriticScoreSync(catalog, { forceRefresh: true });

      // Stage 2: Manual forceRefresh (without deepReverify) MUST NOT call nuclear clearCache()
      expect(clearCacheSpy).not.toHaveBeenCalled();

      // Stage 1: Wikidata batch SPARQL pre-pass runs for upgrade-eligible games (excluding fresh MC)
      expect(batchSpy).toHaveBeenCalledTimes(1);
      const batchItems = batchSpy.mock.calls[0]?.[0] ?? [];
      expect(batchItems.some((item) => item.steamAppId === 286690)).toBe(true);
      expect(batchItems.some((item) => item.steamAppId === 1517290)).toBe(true);
      expect(batchItems.some((item) => item.steamAppId === 1091500)).toBe(false);

      // Stage 2 Priority Ordering: uncached (Battlefield 2042) -> fallback (Metro 2033 Redux) -> verified MC (Cyberpunk 2077)
      expect(resolutionOrder[0]).toBe('Battlefield 2042');
      expect(resolutionOrder[1]).toBe('Metro 2033 Redux');
      expect(resolutionOrder[2]).toBe('Cyberpunk 2077');

      // Metro 2033 Redux upgraded from STM 82 -> verified MC 90; Cyberpunk 2077 stayed verified MC 86
      expect(loadStagedCache<CriticScoreData>('antigravity_critic_v8_id:286690').data?.source).toBe(
        'metacritic'
      );
      expect(loadStagedCache<CriticScoreData>('antigravity_critic_v8_id:286690').data?.score).toBe(
        90
      );
      expect(loadStagedCache<CriticScoreData>('antigravity_critic_v8_id:1091500').data?.score).toBe(
        86
      );
    });
  });
});
