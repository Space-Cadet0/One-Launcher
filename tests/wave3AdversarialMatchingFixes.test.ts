import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorefrontReviewAnchor } from '../src/contracts/critic';
import { computeEntityMatchConfidence } from '../src/services/common/entityResolver';
import {
  isIntermediateNumeralSubtitleMatch,
  isSequelMismatch,
  stripIntermediateSubtitleNumeral,
} from '../src/services/common/titleUtils';
import {
  isAnchorSlugCompatible,
  isTitleCompatible,
  metacriticResolver,
} from '../src/services/critic/metacriticResolver';
import { requestScheduler } from '../src/services/network/requestScheduler';
import { computeTitleSimilarity } from '../src/services/steam/steamMatcher';

function makeComposerJsonResponse(payload: {
  slug: string;
  title: string;
  releaseDate: string;
  description?: string;
  criticScore?: number | null;
  criticCount?: number;
  userScore?: number | null;
  userCount?: number;
}): Response {
  const criticScoreSummary =
    typeof payload.criticScore === 'number'
      ? {
          score: payload.criticScore,
          reviewCount: payload.criticCount ?? 30,
          max: 100,
        }
      : null;

  const userScoreSummary =
    typeof payload.userScore === 'number'
      ? {
          score: payload.userScore,
          reviewCount: payload.userCount ?? 250,
          max: 10,
        }
      : null;

  return new Response(
    JSON.stringify({
      data: {
        item: {
          type: 'game-title',
          slug: payload.slug,
          title: payload.title,
          releaseDate: payload.releaseDate,
          description: payload.description ?? `${payload.title} critical reception summary.`,
          criticScoreSummary,
          userScoreSummary,
          platforms: [
            {
              slug: 'pc',
              name: 'PC',
              releaseDate: payload.releaseDate,
              criticScoreSummary,
              userScoreSummary,
            },
          ],
        },
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }
  );
}

function makeComposer404Response(): Response {
  return new Response(JSON.stringify({ code: 404, message: 'Not Found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Wave 3 Adversarial Matching & Metacritic Resolver Remediation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    requestScheduler.reset();
    metacriticResolver.clearCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    requestScheduler.reset();
    metacriticResolver.clearCache();
  });

  // =========================================================================
  // [P1-5] Intermediate Numeral Subtitle Matching vs Generic SKU/Genre/Tagline Subtitles
  // =========================================================================
  describe('[P1-5] isIntermediateNumeralSubtitleMatch generic SKU/genre/tagline rejection', () => {
    const genuineDistinctivePairs: ReadonlyArray<readonly [string, string]> = [
      ['Deus Ex 2: Invisible War', 'Deus Ex: Invisible War'],
      ['Thief 2: The Metal Age', 'Thief: The Metal Age'],
      ["Baldur's Gate 2: Shadows of Amn", "Baldur's Gate: Shadows of Amn"],
      ['Star Wars Jedi Knight II: Jedi Outcast', 'Star Wars Jedi Knight: Jedi Outcast'],
      ['The Elder Scrolls III: Morrowind', 'The Elder Scrolls: Morrowind'],
      ['The Witcher 2: Assassins of Kings', 'The Witcher: Assassins of Kings'],
    ];

    it.each(genuineDistinctivePairs)(
      'accepts genuine distinctive subtitle pair bidirectionally: %s <-> %s',
      (numberedTitle, unnumberedTitle) => {
        expect(isIntermediateNumeralSubtitleMatch(numberedTitle, unnumberedTitle)).toBe(true);
        expect(isIntermediateNumeralSubtitleMatch(unnumberedTitle, numberedTitle)).toBe(true);
        expect(isSequelMismatch(numberedTitle, unnumberedTitle)).toBe(false);
        expect(isSequelMismatch(unnumberedTitle, numberedTitle)).toBe(false);
        expect(stripIntermediateSubtitleNumeral(numberedTitle)).toBe(unnumberedTitle);
        expect(computeTitleSimilarity(numberedTitle, unnumberedTitle)).toBe(1);
        expect(computeTitleSimilarity(unnumberedTitle, numberedTitle)).toBe(1);

        const entityMatch = computeEntityMatchConfidence(
          { title: numberedTitle, releaseYear: 2003, developers: ['Studio'] },
          { title: unnumberedTitle, releaseYear: 2003, developers: ['Studio'] }
        );
        expect(entityMatch.isAccepted).toBe(true);
        expect(entityMatch.titleScore).toBe(100);
      }
    );

    const genericSequelCollisionPairs: ReadonlyArray<readonly [string, string]> = [
      ['Fallout 2: A Post Nuclear Role Playing Game', 'Fallout: A Post Nuclear Role Playing Game'],
      ['Fallout 2: A Post-Nuclear Role-Playing Game', 'Fallout: A Post-Nuclear Role-Playing Game'],
      ['Destiny 2: Legendary Edition', 'Destiny: Legendary Edition'],
      ['StarCraft II: Battle Chest', 'StarCraft: Battle Chest'],
      ['Overwatch 2: Season Pass', 'Overwatch: Season Pass'],
      ['Diablo II: Expansion Set', 'Diablo: Expansion Set'],
      ['Halo 2: Original Soundtrack', 'Halo: Original Soundtrack'],
      ['XCOM 2: Starter Pack', 'XCOM: Starter Pack'],
      ['Destiny 2: Annual Pass', 'Destiny: Annual Pass'],
      ['Warcraft II: War Chest', 'Warcraft: War Chest'],
      ['Fallout 2: Heroic Edition', 'Fallout: Heroic Edition'],
      ['Borderlands 2: Action Adventure', 'Borderlands: Action Adventure'],
    ];

    it.each(genericSequelCollisionPairs)(
      'strictly rejects distinct sequel pair sharing generic SKU/genre/tagline subtitle: %s <-> %s',
      (numberedTitle, unnumberedTitle) => {
        expect(isIntermediateNumeralSubtitleMatch(numberedTitle, unnumberedTitle)).toBe(false);
        expect(isIntermediateNumeralSubtitleMatch(unnumberedTitle, numberedTitle)).toBe(false);
        expect(isSequelMismatch(numberedTitle, unnumberedTitle)).toBe(true);
        expect(isSequelMismatch(unnumberedTitle, numberedTitle)).toBe(true);
        expect(stripIntermediateSubtitleNumeral(numberedTitle)).toBeNull();
        expect(isTitleCompatible(numberedTitle, unnumberedTitle)).toBe(false);
        expect(isTitleCompatible(unnumberedTitle, numberedTitle)).toBe(false);

        // steamMatcher must return 0
        expect(computeTitleSimilarity(numberedTitle, unnumberedTitle)).toBe(0);
        expect(computeTitleSimilarity(unnumberedTitle, numberedTitle)).toBe(0);

        // entityResolver must return titleScore 0 and isAccepted false even within a 1-year release window
        const entityEval = computeEntityMatchConfidence(
          { title: numberedTitle, releaseYear: 1998, developers: ['Black Isle Studios'] },
          { title: unnumberedTitle, releaseYear: 1997, developers: ['Black Isle Studios'] }
        );
        expect(entityEval.titleScore).toBe(0);
        expect(entityEval.isAccepted).toBe(false);
      }
    );
  });

  // =========================================================================
  // [P1-4] deferredOlderCritic Remake Guard on Step 3 Finder Transient Outage
  // =========================================================================
  describe('[P1-4] deferredOlderCritic Finder transient outage guard', () => {
    const outageModes: ReadonlyArray<{
      label: string;
      makeFinderResponse: () => Promise<Response>;
    }> = [
      {
        label: 'HTTP 503 Service Unavailable',
        makeFinderResponse: async () => new Response('Service Unavailable', { status: 503 }),
      },
      {
        label: 'HTTP 429 Too Many Requests',
        makeFinderResponse: async () => new Response('Rate Limited', { status: 429 }),
      },
      {
        label: 'HTTP 200 Cloudflare WAF HTML challenge',
        makeFinderResponse: async () =>
          new Response(
            '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cf-browser-verification</body></html>',
            { status: 200, headers: { 'content-type': 'text/html' } }
          ),
      },
      {
        label: 'Network error (TypeError: Failed to fetch)',
        makeFinderResponse: async () => {
          throw new TypeError('Failed to fetch');
        },
      },
    ];

    it.each(outageModes)(
      'refuses to promote 2008 classic score for Dead Space (2023) when Step 3 Finder fails with $label and avoids caching false positive/negative',
      async ({ makeFinderResponse }) => {
        let finderMode: 'outage' | 'recovered' = 'outage';

        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes('/composer/metacritic/pages/games/dead-space/web')) {
            return makeComposerJsonResponse({
              slug: 'dead-space',
              title: 'Dead Space',
              releaseDate: '2008-10-14',
              criticScore: 86,
              criticCount: 28,
              userScore: 8.9,
              userCount: 1500,
            });
          }
          if (url.includes('/composer/metacritic/pages/games/dead-space-2023/web')) {
            return makeComposer404Response();
          }
          if (url.includes('/composer/metacritic/pages/games/dead-space-remake/web')) {
            return makeComposerJsonResponse({
              slug: 'dead-space-remake',
              title: 'Dead Space',
              releaseDate: '2023-01-27',
              criticScore: 89,
              criticCount: 73,
              userScore: 8.6,
              userCount: 1850,
            });
          }
          if (url.includes('/finder/metacritic/search/')) {
            if (finderMode === 'outage') {
              return makeFinderResponse();
            }
            return new Response(
              JSON.stringify({
                data: {
                  items: [
                    {
                      slug: 'dead-space',
                      title: 'Dead Space',
                      releaseDate: '2008-10-14',
                      criticScoreSummary: { score: 86, reviewCount: 28 },
                    },
                    {
                      slug: 'dead-space-remake',
                      title: 'Dead Space',
                      releaseDate: '2023-01-27',
                      criticScoreSummary: { score: 89, reviewCount: 73 },
                    },
                  ],
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          return makeComposer404Response();
        });

        const duringOutage = await metacriticResolver.resolveMetacritic('Dead Space', 2023);
        expect(duringOutage.critic).toBeNull();
        expect(duringOutage.user).toBeNull();
        expect(metacriticResolver.hadRecentTransientFailure('Dead Space')).toBe(true);

        // Because the outage result was NOT cached as a positive or negative entry,
        // recovering Finder immediately resolves the 2023 remake without clearCache().
        finderMode = 'recovered';
        requestScheduler.reset();

        const afterRecovery = await metacriticResolver.resolveMetacritic('Dead Space', 2023);
        expect(afterRecovery.critic).not.toBeNull();
        expect(afterRecovery.critic?.score).toBe(89);
        expect(afterRecovery.critic?.url).toContain('dead-space-remake');
        expect(metacriticResolver.hadRecentTransientFailure('Dead Space')).toBe(false);
      }
    );

    it('refuses to promote deferredOlderUser when Step 3 Finder suffers a 503 outage', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/composer/metacritic/pages/games/classic-user-only/web')) {
          return makeComposerJsonResponse({
            slug: 'classic-user-only',
            title: 'Classic User Only',
            releaseDate: '2004-05-01',
            criticScore: null,
            userScore: 8.4,
            userCount: 120,
          });
        }
        if (url.includes('/composer/metacritic/pages/games/classic-user-only-2023/web')) {
          return makeComposer404Response();
        }
        if (url.includes('/finder/metacritic/search/')) {
          return new Response('Service Unavailable', { status: 503 });
        }
        return makeComposer404Response();
      });

      const bundle = await metacriticResolver.resolveMetacritic('Classic User Only', 2023);
      expect(bundle.critic).toBeNull();
      expect(bundle.user).toBeNull();
      expect(metacriticResolver.hadRecentTransientFailure('Classic User Only')).toBe(true);
    });

    it('promotes deferredOlderCritic for legitimate older re-releases when Step 3 Finder succeeds (HTTP 200) with no ±2 year remake', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/composer/metacritic/pages/games/deus-ex-invisible-war/web')) {
          return makeComposerJsonResponse({
            slug: 'deus-ex-invisible-war',
            title: 'Deus Ex: Invisible War',
            releaseDate: '2003-12-02',
            criticScore: 80,
            criticCount: 28,
            userScore: 7.4,
            userCount: 310,
          });
        }
        if (url.includes('/finder/metacritic/search/')) {
          return new Response(
            JSON.stringify({
              data: {
                items: [
                  {
                    slug: 'deus-ex-invisible-war',
                    title: 'Deus Ex: Invisible War',
                    releaseDate: '2003-12-02',
                    criticScoreSummary: { score: 80, reviewCount: 28 },
                  },
                ],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return makeComposer404Response();
      });

      const bundle = await metacriticResolver.resolveMetacritic('Deus Ex 2: Invisible War', '2012-07-03');
      expect(bundle.critic).not.toBeNull();
      expect(bundle.critic?.score).toBe(80);
      expect(bundle.critic?.url).toContain('deus-ex-invisible-war');
      expect(bundle.user?.userScoreRaw).toBe(7.4);
      expect(metacriticResolver.hadRecentTransientFailure('Deus Ex 2: Invisible War')).toBe(false);
    });
  });

  // =========================================================================
  // [P1-6] isAnchorSlugCompatible Unbounded Prefix Expansion Hardening
  // =========================================================================
  describe('[P1-6] isAnchorSlugCompatible rejects bare franchise prefix expansion to sequels/spinoffs', () => {
    const bareFranchiseCollisions: ReadonlyArray<readonly [string, string]> = [
      ['Deus Ex', 'deus-ex-mankind-divided'],
      ['Deus Ex', 'deus-ex-human-revolution'],
      ['Grand Theft Auto', 'grand-theft-auto-vice-city'],
      ["Assassin's Creed", 'assassins-creed-valhalla'],
      ['Call of Duty', 'call-of-duty-ghosts'],
      ['Metal Gear', 'metal-gear-solid'],
      ['Silent Hill', 'silent-hill-downpour'],
      ['Resident Evil', 'resident-evil-revelations'],
      ['Final Fantasy', 'final-fantasy-tactics'],
      ['Tomb Raider', 'tomb-raider-underworld'],
    ];

    it.each(bareFranchiseCollisions)(
      'rejects bare unnumbered franchise title %s against spinoff/sequel slug %s',
      (title, anchorSlug) => {
        expect(isAnchorSlugCompatible(title, anchorSlug)).toBe(false);
      }
    );

    it('still allows legitimate canonical subtitle expansion for explicit installment numerals (>= 2) and trailing clause punctuation (! / ?)', () => {
      expect(isAnchorSlugCompatible('Cat Quest II', 'cat-quest-ii-the-lupus-empire')).toBe(true);
      expect(isAnchorSlugCompatible('POSTAL 2', 'postal-2-share-the-pain')).toBe(true);
      expect(isAnchorSlugCompatible('Monsters are Coming!', 'monsters-are-coming-rock-road')).toBe(
        true
      );
      expect(
        isAnchorSlugCompatible('Monsters are Coming!', 'monsters-are-coming!-rock-road')
      ).toBe(true);
      expect(isAnchorSlugCompatible("Who's Next?", 'whos-next-the-mystery-chronicle')).toBe(true);

      // Exact base matches, remastered anchors, and episodic pilot anchors stay intact
      expect(isAnchorSlugCompatible('Deus Ex', 'deus-ex')).toBe(true);
      expect(isAnchorSlugCompatible('BioShock Remastered', 'bioshock-the-collection')).toBe(true);
      expect(
        isAnchorSlugCompatible('The Walking Dead', 'the-walking-dead-episode-1---a-new-day')
      ).toBe(true);
    });

    it('continues rejecting conflict tokens and mismatched numerals even when installment numeral or clause punctuation is present', () => {
      expect(isAnchorSlugCompatible('Cat Quest II', 'cat-quest-ii-season-pass')).toBe(false);
      expect(isAnchorSlugCompatible('Cat Quest II', 'cat-quest-ii-dlc')).toBe(false);
      expect(isAnchorSlugCompatible('POSTAL 2', 'postal-2-remake')).toBe(false);
      expect(isAnchorSlugCompatible('POSTAL 2', 'postal-2-3')).toBe(false);
      expect(isAnchorSlugCompatible('Monsters are Coming!', 'monsters-are-coming-2')).toBe(false);
      expect(
        isAnchorSlugCompatible('Monsters are Coming!', 'monsters-are-coming-rock-road-dlc')
      ).toBe(false);
    });
  });

  // =========================================================================
  // [P2-3] Step 1 Synthesized `${anchorSlug}-${queryYr}` 404 Must Probe `anchorSlug` First
  // =========================================================================
  describe('[P2-3] Step 1 synthesized year-anchor 404 probes base anchorSlug before Step 4 fallback', () => {
    it('probes base anchorSlug ("prey") after synthesized "prey-2017" 404s and returns authentic Composer critic + user data', async () => {
      const requestedUrls: string[] = [];

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        requestedUrls.push(url);

        if (url.includes('/composer/metacritic/pages/games/prey-2017/web')) {
          return makeComposer404Response();
        }
        if (url.includes('/composer/metacritic/pages/games/prey/web')) {
          return makeComposerJsonResponse({
            slug: 'prey',
            title: 'Prey',
            releaseDate: '2017-05-05',
            description: 'Sci-fi immersive sim aboard Talos I.',
            criticScore: 82,
            criticCount: 55,
            userScore: 8.1,
            userCount: 920,
          });
        }
        return makeComposer404Response();
      });

      const anchor: StorefrontReviewAnchor = {
        storefront: 'steam',
        metacriticSlug: 'prey',
        metacriticScore: 82,
        metacriticUrl: 'https://www.metacritic.com/game/prey/',
        isVerifiedGroundTruth: true,
      };

      const bundle = await metacriticResolver.resolveMetacritic('Prey (2017)', 2017, anchor);

      expect(requestedUrls.some((u) => u.includes('/games/prey-2017/web'))).toBe(true);
      expect(requestedUrls.some((u) => u.includes('/games/prey/web'))).toBe(true);

      // Authentic Composer response (numReviews: 55, real description, user score 8.1),
      // NOT premature buildAnchorFallbackCritic (numReviews: 20, user: null).
      expect(bundle.critic).not.toBeNull();
      expect(bundle.critic?.score).toBe(82);
      expect(bundle.critic?.numReviews).toBe(55);
      expect(bundle.critic?.summary).toContain('Talos I');
      expect(bundle.critic?.summary).not.toContain('store review anchor');
      expect(bundle.user).not.toBeNull();
      expect(bundle.user?.userScoreRaw).toBe(8.1);
      expect(bundle.user?.numReviews).toBe(920);
    });

    it('rejects a 2006 page on base anchorSlug ("prey") via titleYear validation and lets Step 4 provide the verified storefront fallback', async () => {
      const requestedUrls: string[] = [];

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        requestedUrls.push(url);

        if (url.includes('/composer/metacritic/pages/games/prey-2017/web')) {
          return makeComposer404Response();
        }
        if (url.includes('/composer/metacritic/pages/games/prey/web')) {
          return makeComposerJsonResponse({
            slug: 'prey',
            title: 'Prey',
            releaseDate: '2006-07-11',
            description: '2006 Human Head Studios shooter.',
            criticScore: 83,
            criticCount: 44,
            userScore: 8.2,
            userCount: 410,
          });
        }
        if (url.includes('/finder/metacritic/search/')) {
          return new Response(JSON.stringify({ data: { items: [] } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return makeComposer404Response();
      });

      const anchor: StorefrontReviewAnchor = {
        storefront: 'steam',
        metacriticSlug: 'prey',
        metacriticScore: 82,
        metacriticUrl: 'https://www.metacritic.com/game/prey/',
        isVerifiedGroundTruth: true,
      };

      const bundle = await metacriticResolver.resolveMetacritic('Prey (2017)', 2017, anchor);

      expect(requestedUrls.some((u) => u.includes('/games/prey-2017/web'))).toBe(true);
      expect(requestedUrls.some((u) => u.includes('/games/prey/web'))).toBe(true);
      expect(requestedUrls.some((u) => u.includes('/finder/metacritic/search/'))).toBe(true);

      // Must reject 2006's MC 83 and fall back cleanly in Step 4 to Steam's verified 82 anchor
      expect(bundle.critic).not.toBeNull();
      expect(bundle.critic?.score).toBe(82);
      expect(bundle.critic?.summary).toContain('Verified by official STEAM store review anchor');
      expect(bundle.user).toBeNull();
    });
  });

  // =========================================================================
  // [P2-5] isTitleCompatible Edition-Suffix Early Return Candidate Extra-Token Guard
  // =========================================================================
  describe('[P2-5] isTitleCompatible blocks edition-suffix queries from matching spinoffs/mods', () => {
    const editionToSpinoffRejections: ReadonlyArray<readonly [string, string]> = [
      ['Fallout Complete Edition', 'Fallout Shelter'],
      ['Portal: Enhanced Edition', 'Portal: Revolution'],
      ['Diablo: Deluxe Edition', 'Diablo Immortal'],
      ['Fallout: Complete Edition', 'Fallout: New Vegas'],
      ['Deus Ex: Deluxe Edition', 'Deus Ex: Human Revolution'],
      ["Assassin's Creed: Complete Edition", "Assassin's Creed: Valhalla"],
      ['Portal 2: Enhanced Edition', 'Portal 2: Revolution'],
      ['Half-Life 2: Complete Edition', 'Half-Life 2: Deathmatch'],
    ];

    it.each(editionToSpinoffRejections)(
      'rejects edition query %s against distinct spinoff/mod candidate %s',
      (queryTitle, candidateTitle) => {
        expect(isTitleCompatible(queryTitle, candidateTitle)).toBe(false);
      }
    );

    const editionToBaseAcceptances: ReadonlyArray<readonly [string, string]> = [
      ["The Outer Worlds: Spacer's Choice Edition", 'The Outer Worlds'],
      ['Rise of the Tomb Raider: 20 Year Celebration', 'Rise of the Tomb Raider'],
      ['Fallout Complete Edition', 'Fallout'],
      ['Portal: Enhanced Edition', 'Portal'],
      ['Diablo: Deluxe Edition', 'Diablo'],
      ['For Honor: Valhalla Edition', 'For Honor'],
      ['Battlefield V EA Play Edition', 'Battlefield V'],
      ['Trine 4: Definitive Edition', 'Trine 4: The Nightmare Prince'],
      ['Trine 4: Definitive Edition', 'trine 4 the nightmare prince'],
    ];

    it.each(editionToBaseAcceptances)(
      'preserves true edition-to-base compatibility: %s -> %s',
      (queryTitle, candidateTitle) => {
        expect(isTitleCompatible(queryTitle, candidateTitle)).toBe(true);
      }
    );
  });
});
