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
      expect(toCanonicalMetacriticSlug('Alien Breed 2: Assault')).toBe('alien-breed-2-assault');
      expect(toCanonicalMetacriticSlug('Alien Breed 3: Descent')).toBe('alien-breed-3-descent');
      expect(toCanonicalMetacriticSlug('Ancient Enemy')).toBe('ancient-enemy');
      expect(toCanonicalMetacriticSlug('BioShock® 2')).toBe('bioshock-2');
      expect(toCanonicalMetacriticSlug("DEMON'S TILT")).toBe('demons-tilt');
      expect(toCanonicalMetacriticSlug('Airship Kingdoms Adrift')).toBe('airship-kingdoms-adrift');
      expect(toCanonicalMetacriticSlug('Ascendant')).toBe('ascendant');
    });
  });

  describe('Dynamic Cascading Resolutions for All 8 UAT Titles', () => {
    it('Alien Breed 2: Assault resolves authentic Metacritic score 67 (Fair)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Alien Breed 2: Assault');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.isVerified).toBe(true);
      expect(result?.score).toBe(67);
      expect(result?.tier).toBe('Fair');
      expect(result?.url).toContain('metacritic.com/game/alien-breed-2-assault');
    }, 35000);

    it('Alien Breed 3: Descent resolves authentic Metacritic score 68 (Fair)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Alien Breed 3: Descent');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.isVerified).toBe(true);
      expect(result?.score).toBe(68);
      expect(result?.tier).toBe('Fair');
      expect(result?.url).toContain('metacritic.com/game/alien-breed-3-descent');
    }, 35000);

    it('Ancient Enemy resolves authentic Metacritic score 73 (Fair)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Ancient Enemy');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.isVerified).toBe(true);
      expect(result?.score).toBe(73);
      expect(result?.tier).toBe('Fair');
      expect(result?.url).toContain('metacritic.com/game/ancient-enemy');
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

    it("DEMON'S TILT resolves Tier 3 Metacritic User Score (7.9/10)", async () => {
      const result = await criticScoreService.resolveDynamicScore("DEMON'S TILT");
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic_user');
      expect(result?.userScoreRaw).toBe(7.9);
      expect(result?.score).toBe(79);
      expect(result?.tier).toBe('Strong');
      expect(result?.url).toContain('metacritic.com/game/demons-tilt');
    }, 35000);

    it('Airship Kingdoms Adrift cascades past 0-review Metacritic to authentic Steam Synthetic (Fair)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Airship Kingdoms Adrift');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('steam');
      expect(result?.isSynthetic).toBe(true);
      expect(result?.score).toBeGreaterThanOrEqual(70);
      expect(result?.numReviews).toBeGreaterThan(500);
      expect(result?.url).toContain('store.steampowered.com/app/1597310');
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

    it('Ascendant cascades past 0-review Metacritic to authentic Steam Synthetic (Strong)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Ascendant', 296930);
      expect(result).not.toBeNull();
      expect(result?.source).toBe('steam');
      expect(result?.isSynthetic).toBe(true);
      expect(result?.score).toBeGreaterThanOrEqual(74);
      expect(result?.url).toContain('store.steampowered.com/app/296930');
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

    it('Blade of Darkness resolves Tier 1 Metacritic score 75 (Strong)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Blade of Darkness');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.score).toBe(75);
      expect(result?.tier).toBe('Strong');
      expect(result?.url).toContain('metacritic.com/game/blade-of-darkness-2001');
      expect(result?.isVerified).toBe(true);
    }, 35000);

    it('Bloody Hell resolves Tier 3 Metacritic User Score (8.1/10 -> 81 Strong)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Bloody Hell');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic_user');
      expect(result?.userScoreRaw).toBe(8.1);
      expect(result?.score).toBe(81);
      expect(result?.tier).toBe('Strong');
      expect(result?.url).toContain('metacritic.com/game/bloody-hell-2023');
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

    it('Kamaeru resolves Tier 1 Metacritic score 70 (Fair)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Kamaeru');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic');
      expect(result?.score).toBe(70);
      expect(result?.tier).toBe('Fair');
      expect(result?.url).toContain('metacritic.com/game/kamaeru-a-frog-refuge');
      expect(result?.isVerified).toBe(true);
    }, 35000);
  });

  describe('Task 2 Verification: Tier 5 Storefront Star Rating (GOG / Epic Converted to 0-100)', () => {
    it('storefrontStarResolver correctly extracts and converts GOG 5-star ratings to 0-100 scale', async () => {
      const bioMenace = await storefrontStarResolver.resolveStorefrontScore('Bio Menace');
      expect(bioMenace).not.toBeNull();
      expect(bioMenace?.source).toBe('gog');
      expect(bioMenace?.starRatingRaw).toBe(4.1);
      expect(bioMenace?.score).toBe(82);
      expect(bioMenace?.tier).toBe('Strong');
      expect(bioMenace?.url).toContain('gog.com/en/game/bio_menace');

      const amazonQueen = await storefrontStarResolver.resolveStorefrontScore('Flight of the Amazon Queen');
      expect(amazonQueen).not.toBeNull();
      expect(amazonQueen?.source).toBe('gog');
      expect(amazonQueen?.starRatingRaw).toBe(4.1);
      expect(amazonQueen?.score).toBe(82);
      expect(amazonQueen?.tier).toBe('Strong');
      expect(amazonQueen?.url).toContain('gog.com/en/game/flight_of_the_amazon_queen');
    }, 35000);

    it('Lure of the Temptress resolves Tier 5 GOG star rating in dynamic cascade (3.3★ -> 66/100 Fair)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Lure of the Temptress');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('gog');
      expect(result?.starRatingRaw).toBe(3.3);
      expect(result?.score).toBe(66);
      expect(result?.tier).toBe('Fair');
      expect(result?.url).toContain('gog.com/en/game/lure_of_the_temptress');
    }, 35000);

    it('Tyrian 2000 resolves Tier 3 Metacritic User Score in dynamic cascade (8.4/10 -> 84 Mighty)', async () => {
      const result = await criticScoreService.resolveDynamicScore('Tyrian 2000');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('metacritic_user');
      expect(result?.userScoreRaw).toBe(8.4);
      expect(result?.score).toBe(84);
      expect(result?.tier).toBe('Mighty');
      expect(result?.url).toContain('metacritic.com/game/tyrian-2000');
    }, 35000);

    it('verifies tier hierarchy: higher tiers take precedence over Tier 5 storefront ratings', async () => {
      // Bio Menace has authentic Tier 3 Metacritic User Score
      const bioMenaceCascade = await criticScoreService.resolveDynamicScore('Bio Menace');
      expect(bioMenaceCascade).not.toBeNull();
      expect(bioMenaceCascade?.source).toBe('metacritic_user');

      // Flight of the Amazon Queen has authentic Tier 4 Steam Community Sentiment
      const amazonQueenCascade = await criticScoreService.resolveDynamicScore('Flight of the Amazon Queen');
      expect(amazonQueenCascade).not.toBeNull();
      expect(amazonQueenCascade?.source).toBe('steam');
    }, 60000);

    it('betas, editors and test branches strictly remain Tier 6 Unrated (null)', async () => {
      const fmEditor = await criticScoreService.resolveDynamicScore('Football Manager 2024 Pre-Game Editor');
      expect(fmEditor).toBeNull();

      const cyberpunkGoodies = await criticScoreService.resolveDynamicScore('Cyberpunk 2077 Digital Goodies');
      expect(cyberpunkGoodies).toBeNull();
    }, 35000);
  });
});
