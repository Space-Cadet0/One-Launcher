import { describe, it, expect, beforeEach } from 'vitest';
import { criticScoreService } from '../src/services/critic/criticScoreService';
import { toCanonicalMetacriticSlug } from '../src/services/critic/metacriticResolver';
import { storefrontStarResolver } from '../src/services/critic/storefrontStarResolver';

describe('Phase 1 Verification: UAT Reported Review Score Cases', () => {
  beforeEach(() => {
    criticScoreService.clearCache();
  });

  describe('Metacritic Slug Normalization', () => {
    it('correctly maps titles to canonical Metacritic slugs', () => {
      expect(toCanonicalMetacriticSlug('Portal 2')).toBe('portal-2');
      expect(toCanonicalMetacriticSlug('Dead Cells')).toBe('dead-cells');
      expect(toCanonicalMetacriticSlug('Slay the Spire')).toBe('slay-the-spire');
      expect(toCanonicalMetacriticSlug('BioShock® 2')).toBe('bioshock-2');
      expect(toCanonicalMetacriticSlug("NO MAN'S SKY")).toBe('no-mans-sky');
      expect(toCanonicalMetacriticSlug('Valheim')).toBe('valheim');
      expect(toCanonicalMetacriticSlug('Vampire Survivors')).toBe('vampire-survivors');
    });
  });

  describe('Dynamic Cascading Resolutions for All 8 UAT Titles', () => {
    it('Portal 2 resolves authentic Metacritic score 95 (Mighty)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Portal 2');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.isVerified).toBe(true);
      expect(result?.score).toBe(95);
      expect(result?.tier).toBe('Mighty');
      expect(result?.url).toContain('metacritic.com/game/portal-2');
    }, 35000);

    it('Dead Cells resolves authentic Metacritic score 89 (Mighty)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Dead Cells');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.isVerified).toBe(true);
      expect(result?.score).toBe(89);
      expect(result?.tier).toBe('Mighty');
      expect(result?.url).toContain('metacritic.com/game/dead-cells');
    }, 35000);

    it('Slay the Spire resolves authentic Metacritic score 89 (Mighty)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Slay the Spire');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.isVerified).toBe(true);
      expect(result?.score).toBe(89);
      expect(result?.tier).toBe('Mighty');
      expect(result?.url).toContain('metacritic.com/game/slay-the-spire');
    }, 35000);

    it('BioShock® 2 resolves authentic Metacritic score 88 (Mighty)', async () => {
      const result = await criticScoreService.resolveDynamicScore('BioShock® 2');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.isVerified).toBe(true);
      expect(result?.score).toBe(88);
      expect(result?.tier).toBe('Mighty');
      expect(result?.url).toContain('metacritic.com/game/bioshock-2');
    }, 35000);

    it("NO MAN'S SKY resolves Tier 3 Metacritic User Score (7.9/10)", async () => {
      const result = await criticScoreService.resolveDynamicScore("NO MAN'S SKY");
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic_user');
      expect(result?.userScoreRaw).toBe(7.9);
      expect(result?.score).toBe(79);
      expect(result?.tier).toBe('Strong');
      expect(result?.url).toContain('metacritic.com/game/no-mans-sky');
    }, 35000);

    it('Valheim cascades past 0-review Metacritic to authentic Steam Synthetic (Fair/Strong)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Valheim');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('steam');
      expect(result?.isSynthetic).toBe(true);
      expect(result?.score).toBeGreaterThanOrEqual(70);
      expect(result?.numReviews).toBeGreaterThan(500);
      expect(result?.url).toContain('store.steampowered.com/app/892970');
    }, 35000);

    it('BioShock 2 Remastered resolves Tier 3 Metacritic User Score (7.8/10)', async () => {
      const result = await criticScoreService.resolveDynamicScore('BioShock 2 Remastered', 409720);
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic_user');
      expect(result?.userScoreRaw).toBe(7.8);
      expect(result?.score).toBe(78);
      expect(result?.tier).toBe('Strong');
      expect(result?.url).toContain('metacritic.com/game/bioshock-2-remastered');
    }, 35000);

    it('Vampire Survivors cascades past 0-review Metacritic to authentic Steam Synthetic (Strong)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Vampire Survivors', 1794680);
      expect(result).not.toBeNull();
      expect(result?.source).toBe('steam');
      expect(result?.isSynthetic).toBe(true);
      expect(result?.score).toBeGreaterThanOrEqual(74);
      expect(result?.url).toContain('store.steampowered.com/app/1794680');
    }, 35000);

    it('MDK 2 resolves authentic Tier 1 Metacritic score 83 (Strong)', async () => {
      const result = await criticScoreService.resolveDynamicScore('MDK 2');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.score).toBe(83);
      expect(result?.tier).toBe('Strong');
      expect(result?.url).toMatch(/metacritic\.com\/game\/mdk-?2/);
    }, 35000);

    it('Hitman: Codename 47 resolves authentic Tier 1 Metacritic score 73 (Fair)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Hitman: Codename 47');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.score).toBe(73);
      expect(result?.tier).toBe('Fair');
      expect(result?.url).toContain('metacritic.com/game/hitman-codename-47');
    }, 35000);

    it('Postal 2 resolves authentic Tier 1 Metacritic score 50 (Weak)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Postal 2');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.score).toBe(50);
      expect(result?.tier).toBe('Weak');
      expect(result?.url).toContain('metacritic.com/game/postal-2');
    }, 35000);

    it('Fortnite resolves authentic Tier 1 Metacritic score 78 (Strong)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Fortnite');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.score).toBe(78);
      expect(result?.tier).toBe('Strong');
      expect(result?.url).toContain('metacritic.com/game/fortnite');
    }, 35000);
  });

  describe('Task 1 Verification: Strengthened Metacritic Matching (Zero Per-Game Patches)', () => {
    it('Deus ex 2: invisible war resolves Tier 1 Metacritic score (80 PC / 84 Overall)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Deus ex 2: invisible war', 6920);
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect([80, 84]).toContain(result?.score);
      expect(['Strong', 'Mighty']).toContain(result?.tier);
      expect(result?.url).toContain('metacritic.com/game/deus-ex-invisible-war');
      expect(result?.isVerified).toBe(true);
    }, 35000);

    it('Predator: Hunting Grounds Standard Edition resolves Tier 1 Metacritic score 56 (Weak)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Predator: Hunting Grounds Standard Edition', 1556200);
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.score).toBe(56);
      expect(result?.tier).toBe('Weak');
      expect(result?.url).toContain('metacritic.com/game/predator-hunting-grounds');
      expect(result?.isVerified).toBe(true);
    }, 35000);

    it('STAR WARS™ Battlefront™ II (Classic, 2005) resolves Tier 1 Metacritic score 83 (Strong)', async () => {
      const result = await criticScoreService.resolveDynamicScore('STAR WARS™ Battlefront™ II (Classic, 2005)', 6060);
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.score).toBe(83);
      expect(result?.tier).toBe('Strong');
      expect(result?.url).toContain('metacritic.com/game/star-wars-battlefront-ii-2005');
      expect(result?.isVerified).toBe(true);
    }, 35000);

    it('Styx: Shards of Darkness - Deluxe Edition resolves Tier 1 Metacritic score 72 (Fair)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Styx: Shards of Darkness - Deluxe Edition', 355790);
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.score).toBe(72);
      expect(result?.tier).toBe('Fair');
      expect(result?.url).toContain('metacritic.com/game/styx-shards-of-darkness');
      expect(result?.isVerified).toBe(true);
    }, 35000);

    it('Worms Revolution Gold Edition resolves Tier 1 Metacritic score 73 (Fair)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Worms Revolution Gold Edition', 200170);
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.score).toBe(73);
      expect(result?.tier).toBe('Fair');
      expect(result?.url).toContain('metacritic.com/game/worms-revolution');
      expect(result?.isVerified).toBe(true);
    }, 35000);

    it('Disco Elysium resolves Tier 1 Metacritic score 91 (Mighty)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Disco Elysium');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.score).toBe(91);
      expect(result?.tier).toBe('Mighty');
      expect(result?.url).toContain('metacritic.com/game/disco-elysium-2019');
      expect(result?.isVerified).toBe(true);
    }, 35000);

    it('Factorio resolves Tier 3 Metacritic User Score (8.1/10 -> 81 Strong)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Factorio');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic_user');
      expect(result?.userScoreRaw).toBe(8.1);
      expect(result?.score).toBe(81);
      expect(result?.tier).toBe('Strong');
      expect(result?.url).toContain('metacritic.com/game/factorio-2020');
    }, 35000);

    it('NiGHTS into Dreams... resolves Tier 1 Metacritic score 72 (Fair)', async () => {
      const result = await criticScoreService.resolveDynamicScore('NiGHTS into Dreams...', 219950);
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.score).toBe(72);
      expect(result?.tier).toBe('Fair');
      expect(result?.url).toContain('metacritic.com/game/nights-into-dreams-2012');
      expect(result?.isVerified).toBe(true);
    }, 35000);

    it('Never Alone (Kisima Ingitchuna) resolves Tier 1 Metacritic score 72 (Fair)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Never Alone (Kisima Ingitchuna)');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.score).toBe(72);
      expect(result?.tier).toBe('Fair');
      expect(result?.url).toContain('metacritic.com/game/never-alone-2014');
      expect(result?.isVerified).toBe(true);
    }, 35000);

    it('Amnesia resolves Tier 1 Metacritic score 85 (Mighty)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Amnesia');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.score).toBe(85);
      expect(result?.tier).toBe('Mighty');
      expect(result?.url).toContain('metacritic.com/game/amnesia-the-dark-descent');
      expect(result?.isVerified).toBe(true);
    }, 35000);
  });

  describe('Task 2 Verification: Tier 5 Storefront Star Rating (GOG / Epic Converted to 0-100)', () => {
    it('storefrontStarResolver correctly extracts and converts GOG 5-star ratings to 0-100 scale', async () => {
      const subnautica = await storefrontStarResolver.resolveStorefrontScore('Subnautica');
      expect(subnautica).not.toBeNull();
      expect(subnautica?.source).toBe('gog');
      expect(subnautica?.starRatingRaw).toBe(4.1);
      expect(subnautica?.score).toBe(82);
      expect(subnautica?.tier).toBe('Strong');
      expect(subnautica?.url).toContain('gog.com/en/game/subnautica');

      const terraria = await storefrontStarResolver.resolveStorefrontScore('Terraria');
      expect(terraria).not.toBeNull();
      expect(terraria?.source).toBe('gog');
      expect(terraria?.starRatingRaw).toBe(4.1);
      expect(terraria?.score).toBe(82);
      expect(terraria?.tier).toBe('Strong');
      expect(terraria?.url).toContain('gog.com/en/game/terraria');
    }, 35000);

    it('Celeste resolves Tier 5 GOG star rating in dynamic cascade (3.3★ -> 66/100 Fair)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Celeste');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('gog');
      expect(result?.starRatingRaw).toBe(3.3);
      expect(result?.score).toBe(66);
      expect(result?.tier).toBe('Fair');
      expect(result?.url).toContain('gog.com/en/game/celeste');
    }, 35000);

    it('DOOM (1993) resolves Tier 3 Metacritic User Score in dynamic cascade (8.4/10 -> 84 Mighty)', async () => {
      const result = await criticScoreService.resolveDynamicScore('DOOM (1993)');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic_user');
      expect(result?.userScoreRaw).toBe(8.4);
      expect(result?.score).toBe(84);
      expect(result?.tier).toBe('Mighty');
      expect(result?.url).toContain('metacritic.com/game/doom-1993');
    }, 35000);

    it('verifies tier hierarchy: higher tiers take precedence over Tier 5 storefront ratings', async () => {
      // Subnautica has authentic Tier 3 Metacritic User Score
      const subnauticaCascade = await criticScoreService.resolveDynamicScore('Subnautica');
      expect(subnauticaCascade).not.toBeNull();
      expect(subnauticaCascade?.source).toBe('metacritic_user');

      // Terraria has authentic Tier 4 Steam Community Sentiment
      const terrariaCascade = await criticScoreService.resolveDynamicScore('Terraria');
      expect(terrariaCascade).not.toBeNull();
      expect(terrariaCascade?.source).toBe('steam');
    }, 60000);

    it('betas, editors and test branches strictly remain Tier 6 Unrated (null)', async () => {
      const simEditor = await criticScoreService.resolveDynamicScore('Simulation Manager 2024 Pre-Game Editor');
      expect(simEditor).toBeNull();

      const cyberpunkGoodies = await criticScoreService.resolveDynamicScore('Cyberpunk 2077 Digital Goodies');
      expect(cyberpunkGoodies).toBeNull();
    }, 35000);
  });
});
