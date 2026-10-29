import { describe, it, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import {
  criticScoreService,
  getOpenCriticData,
} from '../src/services/critic/criticScoreService';
import {
  metacriticResolver,
  toCanonicalMetacriticSlug,
  generateMetacriticSlugCandidates,
  rankCandidateSlugs,
  isTitleCompatible,
} from '../src/services/critic/metacriticResolver';
import {
  storefrontReviewHarvester,
  extractMetacriticSlugFromUrl,
} from '../src/services/critic/storefrontReviewHarvester';
import { StorefrontReviewAnchor } from '../src/contracts/critic';
import { steamMatcher } from '../src/services/steam/steamMatcher';
import { storefrontStarResolver } from '../src/services/critic/storefrontStarResolver';
import { EPIC_USER_LIBRARY } from '../src/services/storage/epicUserLibrary';
import { GOG_USER_LIBRARY } from '../src/services/storage/gogUserLibrary';

describe('Phase 4: Storefront-Anchored Review Verification Engine End-to-End Suite', () => {
  beforeEach(() => {
    criticScoreService.purgeAllScoreCache();
    metacriticResolver.clearCache();
    storefrontReviewHarvester.clearCache();
  });

  // =========================================================================
  // Rule 1: Direct Ground Truth Anchoring
  // =========================================================================
  describe('Rule 1: Direct Ground Truth Anchoring', () => {
    it('Steam App ID 287390 (Metro Last Light Redux) resolves to canonical Metacritic review URL and score 76', async () => {
      // 1. Verify Steam anchor harvesting
      const steamAnchor = await storefrontReviewHarvester.getSteamAnchor(287390);
      expect(steamAnchor).not.toBeNull();
      expect(steamAnchor?.storefront).toBe('steam');
      expect(steamAnchor?.metacriticScore).toBe(76);
      expect(steamAnchor?.metacriticSlug).toBe('metro-last-light-redux');
      expect(steamAnchor?.isVerifiedGroundTruth).toBe(true);

      // 2. Verify dynamic end-to-end resolution
      const dynamicScore = await criticScoreService.resolveDynamicScore('Metro Last Light Redux', 287390);
      expect(dynamicScore).not.toBeNull();
      expect(dynamicScore?.score).toBe(76);
      expect(dynamicScore?.source).toBe('metacritic');
      expect(dynamicScore?.url).toBe('https://www.metacritic.com/game/metro-last-light-redux/critic-reviews/');
      expect(dynamicScore?.tier).toBe('Strong');
      expect(dynamicScore?.isVerified).toBe(true);

      // 3. Verify instant cache lookup after resolution
      const instantScore = criticScoreService.getCriticScore(287390, 'Metro Last Light Redux');
      expect(instantScore).not.toBeNull();
      expect(instantScore?.score).toBe(76);
      expect(instantScore?.source).toBe('metacritic');
      expect(instantScore?.url).toBe('https://www.metacritic.com/game/metro-last-light-redux/critic-reviews/');
      expect(instantScore?.isVerified).toBe(true);
    }, 30000);

    it('METAL GEAR SOLID Δ: SNAKE EATER resolves to canonical Metacritic review URL and score 85', async () => {
      // 1. Verify transliteration of Greek Delta 'Δ' -> 'delta'
      const slug = toCanonicalMetacriticSlug('METAL GEAR SOLID Δ: SNAKE EATER');
      expect(slug).toBe('metal-gear-solid-delta-snake-eater');

      // 2. Verify candidate generation includes the canonical transliterated slug
      const candidates = generateMetacriticSlugCandidates('METAL GEAR SOLID Δ: SNAKE EATER');
      expect(candidates).toContain('metal-gear-solid-delta-snake-eater');

      // 3. Verify dynamic end-to-end resolution
      const dynamicScore = await criticScoreService.resolveDynamicScore('METAL GEAR SOLID Δ: SNAKE EATER');
      expect(dynamicScore).not.toBeNull();
      expect(dynamicScore?.score).toBe(85);
      expect(dynamicScore?.tier).toBe('Mighty');
      expect(dynamicScore?.url).toBe('https://www.metacritic.com/game/metal-gear-solid-delta-snake-eater/critic-reviews/');
      expect(dynamicScore?.isVerified).toBe(true);

      // 4. Verify instant cache lookup after resolution
      const instantScore = criticScoreService.getCriticScore(null, 'METAL GEAR SOLID Δ: SNAKE EATER');
      expect(instantScore).not.toBeNull();
      expect(instantScore?.score).toBe(85);
      expect(instantScore?.source).toBe('metacritic');
      expect(instantScore?.url).toBe('https://www.metacritic.com/game/metal-gear-solid-delta-snake-eater/critic-reviews/');
      expect(instantScore?.isVerified).toBe(true);
    }, 30000);

    it('Disco Elysium resolves to canonical Metacritic review URL (disco-elysium-2019)', async () => {
      // 1. Verify dynamic end-to-end resolution
      const dynamicScore = await criticScoreService.resolveDynamicScore('Disco Elysium');
      expect(dynamicScore).not.toBeNull();
      expect(dynamicScore?.source).toBe('metacritic');
      expect(dynamicScore?.url).toBe('https://www.metacritic.com/game/disco-elysium-2019/critic-reviews/');
      expect(dynamicScore?.score).toBe(91);
      expect(dynamicScore?.tier).toBe('Mighty');
      expect(dynamicScore?.isVerified).toBe(true);

      // 2. Verify instant cache lookup after resolution
      const instantScore = criticScoreService.getCriticScore(null, 'Disco Elysium');
      expect(instantScore).not.toBeNull();
      expect(instantScore?.source).toBe('metacritic');
      expect(instantScore?.url).toBe('https://www.metacritic.com/game/disco-elysium-2019/critic-reviews/');
      expect(instantScore?.isVerified).toBe(true);
      expect(instantScore?.score).toBe(91);
    }, 30000);

    it('Never Alone (Kisima Ingitchuna) resolves to canonical Metacritic review URL (never-alone-2014)', async () => {
      // 1. Verify parenthetical subtitle handling in slug generation
      const candidates = generateMetacriticSlugCandidates('Never Alone (Kisima Ingitchuna)', 2014);
      expect(candidates).toContain('never-alone');
      expect(candidates).toContain('never-alone-2014');

      // 2. Verify dynamic end-to-end resolution
      const dynamicScore = await criticScoreService.resolveDynamicScore('Never Alone (Kisima Ingitchuna)');
      expect(dynamicScore).not.toBeNull();
      expect(dynamicScore?.source).toBe('metacritic');
      expect(dynamicScore?.url).toBe('https://www.metacritic.com/game/never-alone-2014/critic-reviews/');
      expect(dynamicScore?.score).toBe(72);
      expect(dynamicScore?.isVerified).toBe(true);

      // 3. Verify instant lookup after resolution
      const instantScore = criticScoreService.getCriticScore(null, 'Never Alone (Kisima Ingitchuna)');
      expect(instantScore).not.toBeNull();
      expect(instantScore?.source).toBe('metacritic');
      expect(instantScore?.url).toBe('https://www.metacritic.com/game/never-alone-2014/critic-reviews/');
      expect(instantScore?.score).toBe(72);
      expect(instantScore?.isVerified).toBe(true);
    }, 30000);

    it('NiGHTS into Dreams... resolves to canonical Metacritic review URL (nights-into-dreams-2012)', async () => {
      // 1. Verify canonical slug generation handles trailing ellipses
      const slug = toCanonicalMetacriticSlug('NiGHTS into Dreams...');
      expect(slug).toBe('nights-into-dreams');

      // 2. Verify dynamic end-to-end resolution
      const dynamicScore = await criticScoreService.resolveDynamicScore('NiGHTS into Dreams...');
      expect(dynamicScore).not.toBeNull();
      expect(dynamicScore?.source).toBe('metacritic');
      expect(dynamicScore?.url).toBe('https://www.metacritic.com/game/nights-into-dreams-2012/critic-reviews/');
      expect(dynamicScore?.score).toBe(72);
      expect(dynamicScore?.isVerified).toBe(true);

      // 3. Verify instant cache lookup after resolution
      const instantScore = criticScoreService.getCriticScore(null, 'NiGHTS into Dreams...');
      expect(instantScore).not.toBeNull();
      expect(instantScore?.source).toBe('metacritic');
      expect(instantScore?.url).toBe('https://www.metacritic.com/game/nights-into-dreams-2012/critic-reviews/');
      expect(instantScore?.score).toBe(72);
      expect(instantScore?.isVerified).toBe(true);
    }, 30000);

    it('Overcooked! 2 resolves to canonical Metacritic review URL and score 81', async () => {
      // 1. Verify URL slug extraction
      const extracted = extractMetacriticSlugFromUrl('https://www.metacritic.com/game/overcooked-2/');
      expect(extracted).toBe('overcooked-2');

      // 2. Verify dynamic end-to-end resolution
      const dynamicScore = await criticScoreService.resolveDynamicScore('Overcooked! 2');
      expect(dynamicScore).not.toBeNull();
      expect(dynamicScore?.score).toBe(81);
      expect(dynamicScore?.tier).toBe('Strong');
      expect(dynamicScore?.url).toBe('https://www.metacritic.com/game/overcooked-2/critic-reviews/');
      expect(dynamicScore?.isVerified).toBe(true);

      // 3. Verify instant cache lookup after resolution
      const instantScore = criticScoreService.getCriticScore(null, 'Overcooked! 2');
      expect(instantScore).not.toBeNull();
      expect(instantScore?.score).toBe(81);
      expect(instantScore?.source).toBe('metacritic');
      expect(instantScore?.url).toBe('https://www.metacritic.com/game/overcooked-2/critic-reviews/');
      expect(instantScore?.isVerified).toBe(true);
    }, 30000);
  });

  // =========================================================================
  // Rule 2: Cross-Ecosystem Corroboration
  // =========================================================================
  describe('Rule 2: Cross-Ecosystem Corroboration', () => {
    it('Prodeus (GOG OpenCritic anchor 82) is corroborated as Tier 2 OpenCritic (or Tier 1 if Metacritic present) with score 82', async () => {
      const origGet = axios.get.bind(axios);
      const getSpy = vi.spyOn(axios, 'get').mockImplementation(async (url: string, config?: any) => {
        if (typeof url === 'string' && url.includes('gog.com/en/game/prodeus')) {
          try {
            const res = await origGet(url, config);
            if (typeof res?.data === 'string' && res.data.includes('Top Critic Average')) {
              return res;
            }
          } catch {
            // Fall through to authentic GOG HTML snapshot when www.gog.com is in 503 maintenance
          }
          return {
            status: 200,
            data: '<div class="critics-rating"><div class="circle-score"><span class="circle-score__text">82</span></div><span class="critics-rating__label">Top Critic Average</span><a href="https://opencritic.com/game/10450/prodeus">OpenCritic</a></div>',
          } as any;
        }
        return origGet(url, config);
      });

      try {
        // 1. Harvest official GOG store anchor for Prodeus
        const gogAnchor = await storefrontReviewHarvester.getGogAnchor('prodeus', 'Prodeus');
        expect(gogAnchor).not.toBeNull();
        expect(gogAnchor?.storefront).toBe('gog');
        expect(gogAnchor?.openCriticScore).toBe(82);
        expect(gogAnchor?.isVerifiedGroundTruth).toBe(true);
        expect(gogAnchor?.rawStoreUrl).toContain('gog.com/en/game/prodeus');

        // 2. Resolve dynamic score using harvested storefront anchor
        const corroborated = await criticScoreService.resolveDynamicScore(
          'Prodeus',
          null,
          null,
          gogAnchor
        );
        expect(corroborated).not.toBeNull();
        expect(corroborated?.isVerified).toBe(true);
        expect(['opencritic', 'metacritic']).toContain(corroborated?.source);
        // When Metacritic is present, resolves Tier 1 score 84 (Mighty); when Tier 2 OpenCritic, score 82 (Strong)
        expect([82, 84]).toContain(corroborated?.score);
        expect(['Strong', 'Mighty']).toContain(corroborated?.tier);

        // 3. Verify direct Tier 2 OpenCritic corroboration with GOG anchor (when unlinked to Metacritic)
        const unlinkedOpenCriticScore = await criticScoreService.resolveDynamicScore(
          'Unmatched Indie Game With GOG Anchor',
          null,
          null,
          gogAnchor
        );
        expect(unlinkedOpenCriticScore).not.toBeNull();
        expect(unlinkedOpenCriticScore?.isVerified).toBe(true);
        expect(unlinkedOpenCriticScore?.source).toBe('opencritic');
        expect(unlinkedOpenCriticScore?.score).toBe(82);
      } finally {
        getSpy.mockRestore();
      }
    }, 30000);

    it('Factorio resolves authentic community / user sentiment', async () => {
      // 1. Verify dynamic cascade resolves authentic user sentiment without failing or hallucinating
      const dynamicScore = await criticScoreService.resolveDynamicScore('Factorio');
      expect(dynamicScore).not.toBeNull();
      expect(['metacritic_user', 'steam']).toContain(dynamicScore?.source);
      expect(dynamicScore?.score).toBeGreaterThanOrEqual(80);
      expect(dynamicScore?.tier).toBe('Strong');

      // 2. Verify instant score retrieval resolves authentic player/user sentiment from cache
      const instantScore = criticScoreService.getCriticScore(null, 'Factorio');
      expect(instantScore).not.toBeNull();
      expect(['metacritic_user', 'steam']).toContain(instantScore?.source);
      expect(instantScore?.score).toBeGreaterThanOrEqual(80);
      expect(instantScore?.numReviews).toBeGreaterThanOrEqual(4);
    }, 30000);

    it('Alan Wake 2 and Control on Epic corroborate review data', async () => {
      // 1. Alan Wake 2 on Epic Games Store
      const aw2Anchor = await storefrontReviewHarvester.getEpicAnchor('alan-wake-2', 'Alan Wake 2');
      if (aw2Anchor) {
        expect(aw2Anchor.storefront).toBe('epic');
        expect(aw2Anchor.openCriticScore).toBe(89);
        expect(aw2Anchor.isVerifiedGroundTruth).toBe(true);
      }

      const aw2Dynamic = await criticScoreService.resolveDynamicScore('Alan Wake 2', null, 2023, aw2Anchor);
      expect(aw2Dynamic).not.toBeNull();

      const aw2Score = criticScoreService.getCriticScore(null, 'Alan Wake 2');
      expect(aw2Score).not.toBeNull();
      expect(aw2Score?.score).toBe(89);
      expect(aw2Score?.tier).toBe('Mighty');
      expect(aw2Score?.isVerified).toBe(true);
      expect(['metacritic', 'opencritic']).toContain(aw2Score?.source);

      // 2. Control on Epic Games Store
      const controlAnchor = await storefrontReviewHarvester.getEpicAnchor('control', 'Control');
      if (controlAnchor) {
        expect(controlAnchor.storefront).toBe('epic');
        expect(controlAnchor.openCriticScore).toBe(84);
        expect(controlAnchor.isVerifiedGroundTruth).toBe(true);
      }

      const controlDynamic = await criticScoreService.resolveDynamicScore('Control', 870780, 2019, controlAnchor);
      expect(controlDynamic).not.toBeNull();

      const controlScore = criticScoreService.getCriticScore(870780, 'Control');
      expect(controlScore).not.toBeNull();
      expect(controlScore?.score).toBeGreaterThanOrEqual(82);
      expect(controlScore?.tier).toBe('Strong');
      expect(controlScore?.isVerified).toBe(true);
      expect(['metacritic', 'opencritic']).toContain(controlScore?.source);
    }, 30000);
  });

  // =========================================================================
  // Rule 3: Non-Blocking Graceful Fallback
  // =========================================================================
  describe('Rule 3: Non-Blocking Graceful Fallback', () => {
    it('unlinked indies and unreleased titles flow through the cascade without errors or blocking', async () => {
      // Test unlinked fictional indie title
      const fakeIndieTitle = 'Super Pixel Dungeon Quest 2099 Deluxe Beta';

      // 1. Synchronous getCriticScore returns non-blocking immediately (0ms)
      const t0 = performance.now();
      const instant = criticScoreService.getCriticScore(null, fakeIndieTitle);
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeLessThan(50); // Instant, non-blocking execution
      expect(instant).toBeNull();

      // 2. Harvester returns null gracefully without throwing
      const anchor = await storefrontReviewHarvester.getStorefrontAnchor({
        title: fakeIndieTitle,
      });
      expect(anchor).toBeNull();

      // 3. Dynamic cascade completes gracefully and settles into Tier 6 Null / Unrated
      const dynamic = await criticScoreService.resolveDynamicScore(fakeIndieTitle);
      expect(dynamic).toBeNull();
    }, 20000);

    it('dev tools, playtests, and test branches strictly remain Tier 6 Unrated (null)', async () => {
      const devTools = [
        'Simulation Manager 2024 Pre-Game Editor',
        'Resource Archiver',
        'Company of Heroes (Public Testing)',
      ];

      for (const title of devTools) {
        // Synchronous check must strictly be null
        const score = criticScoreService.getCriticScore(null, title);
        expect(score).toBeNull();

        // Dynamic cascade must strictly remain null (zero hallucinated scores)
        const dynamic = await criticScoreService.resolveDynamicScore(title);
        expect(dynamic).toBeNull();
      }
    }, 20000);

    it('backward compatible getOpenCriticData operates non-blocking and handles missing scores safely', () => {
      const data = getOpenCriticData(undefined, 'Unrated Indie Prototype Game');
      expect(data).toBeNull();
    });
  });

  // =========================================================================
  // Rule 4: Conflict Resolution & Vetoing
  // =========================================================================
  describe('Rule 4: Conflict Resolution & Vetoing', () => {
    it('Kingdom: Classic does not match Kingdom Come: Deliverance', async () => {
      // 1. isTitleCompatible strictly rejects Kingdom: Classic against Kingdom Come: Deliverance
      const compatible = isTitleCompatible('Kingdom: Classic', 'Kingdom Come: Deliverance');
      expect(compatible).toBe(false);

      // 2. rankCandidateSlugs vetoes 'kingdom-come-deliverance' when searching for 'Kingdom: Classic'
      const candidates = ['kingdom-come-deliverance', 'kingdom-come', 'kingdom'];
      const ranked = rankCandidateSlugs('Kingdom: Classic', candidates);
      expect(ranked).not.toContain('kingdom-come-deliverance');
      expect(ranked).not.toContain('kingdom-come');
      expect(ranked).toContain('kingdom');

      // 3. Dynamic & cached score for Kingdom: Classic resolves to Kingdom (and never Kingdom Come)
      const dynamic = await criticScoreService.resolveDynamicScore('Kingdom: Classic');
      const score = criticScoreService.getCriticScore(null, 'Kingdom: Classic') || dynamic;
      expect(score).not.toBeNull();
      expect(score?.url).not.toContain('kingdom-come');
    }, 30000);

    it('a storefront anchor vetoes any conflicting heuristic search candidate', () => {
      // Provided a verified ground truth anchor for Metro Last Light Redux
      const anchor: StorefrontReviewAnchor = {
        storefront: 'steam',
        metacriticSlug: 'metro-last-light-redux',
        metacriticScore: 76,
        isVerifiedGroundTruth: true,
      };

      // Heuristic candidates containing conflicting franchise titles
      const candidates = [
        'metro-last-light',
        'metro-2033',
        'metro-exodus',
        'metro-last-light-redux',
        'metro-red-pack',
      ];

      const ranked = rankCandidateSlugs('Metro Last Light Redux', candidates, anchor);

      // Must place anchor match at index 0 and veto conflicting slugs
      expect(ranked).toHaveLength(1);
      expect(ranked[0]).toBe('metro-last-light-redux');
      expect(ranked).not.toContain('metro-last-light');
      expect(ranked).not.toContain('metro-2033');
      expect(ranked).not.toContain('metro-exodus');
    });

    it('returns empty candidate list if all search candidates conflict with storefront anchor', () => {
      const anchor: StorefrontReviewAnchor = {
        storefront: 'steam',
        metacriticSlug: 'metal-gear-solid-delta-snake-eater',
        isVerifiedGroundTruth: true,
      };

      // Conflicting search results (e.g. original 1998 MGS or MGS 5)
      const candidates = [
        'metal-gear-solid',
        'metal-gear-solid-v-the-phantom-pain',
        'metal-gear-solid-peace-walker',
      ];

      const ranked = rankCandidateSlugs('METAL GEAR SOLID Δ: SNAKE EATER', candidates, anchor);
      expect(ranked).toEqual([]);
    });

    it('rejects candidate OpenCritic score if it drastically conflicts (> 5 pts) with verified storefront anchor', async () => {
      // Anchored with OpenCritic score 82
      const anchor: StorefrontReviewAnchor = {
        storefront: 'gog',
        openCriticScore: 82,
        openCriticId: 10189,
        isVerifiedGroundTruth: true,
      };

      // When resolving dynamic score for unlinked title with anchor, the result strictly reflects the verified anchor
      const score = await criticScoreService.resolveDynamicScore(
        'Unmatched Indie Shooter With GOG Anchor 12345',
        null,
        null,
        anchor
      );
      expect(score).not.toBeNull();
      expect(score?.source).toBe('opencritic');
      expect(score?.score).toBe(82);
    }, 20000);

    it('XCOM: Enemy Unknown Complete Pack resolves to canonical xcom-enemy-unknown (score 89) and rejects The Bureau', async () => {
      // 1. Verify candidate generation strips "Complete Pack" and generates xcom-enemy-unknown
      const candidates = generateMetacriticSlugCandidates('XCOM: Enemy Unknown Complete Pack');
      expect(candidates).toContain('xcom-enemy-unknown');

      // 2. Verify isTitleCompatible rejects The Bureau: XCOM Declassified
      expect(isTitleCompatible('XCOM: Enemy Unknown Complete Pack', 'The Bureau: XCOM Declassified')).toBe(false);
      expect(isTitleCompatible('XCOM: Enemy Unknown Complete Pack', 'XCOM: Enemy Unknown')).toBe(true);

      // 3. Verify dynamic and instant critic score resolution
      await criticScoreService.resolveDynamicScore('XCOM: Enemy Unknown Complete Pack');
      const instant = criticScoreService.getCriticScore(null, 'XCOM: Enemy Unknown Complete Pack');
      expect(instant).not.toBeNull();
      expect(instant?.source).toBe('metacritic');
      expect(instant?.score).toBe(89);
      expect(instant?.url).toBe('https://www.metacritic.com/game/xcom-enemy-unknown/critic-reviews/');
      expect(instant?.url).not.toContain('the-bureau');

      // 4. Verify Steam matcher maps to App ID 200510
      const steamAppId = await steamMatcher.matchGameToSteam('XCOM: Enemy Unknown Complete Pack');
      expect(steamAppId).toBe(200510);
    }, 30000);

    it('Fallout: London resolves to authentic GOG star rating and rejects Fallout (1997) Metacritic', async () => {
      // 1. Verify isTitleCompatible rejects base Fallout
      expect(isTitleCompatible('Fallout: London', 'Fallout')).toBe(false);

      // 2. Verify dynamic resolution via storefrontStarResolver and criticScoreService
      const sfScore = await storefrontStarResolver.resolveStorefrontScore('Fallout: London');
      expect(sfScore).not.toBeNull();
      expect(sfScore?.source).toBe('gog');
      expect(sfScore?.score).toBeGreaterThanOrEqual(70);
      expect(sfScore?.url).toBe('https://www.gog.com/en/game/fallout_london');

      const resolved = await criticScoreService.resolveDynamicScore('Fallout: London');
      const instant = criticScoreService.getCriticScore(null, 'Fallout: London') || resolved;
      expect(instant).not.toBeNull();
      expect(instant?.source).toBe('gog');
      expect(instant?.url).toBe('https://www.gog.com/en/game/fallout_london');
      expect(instant?.url).not.toContain('store.steampowered.com/search');
      expect(instant?.url).not.toContain('metacritic.com/game/fallout');
    }, 30000);
  });
});

