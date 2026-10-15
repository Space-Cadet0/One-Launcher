import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  criticScoreService,
  getOpenCriticData,
  calculateTier,
  getTierColor,
  normalizeCriticTitleKey,
  stripEditionSuffix,
  isSequelMismatch,
  KNOWN_CRITIC_SCORES,
  KNOWN_UNRATED_TITLES,
} from '../src/services/critic/criticScoreService';

describe('CriticScoreService & OpenCritic/Metacritic Integration', () => {
  beforeEach(() => {
    Object.assign(KNOWN_CRITIC_SCORES, {
      813780: {
        id: 'mc-age-of-empires-ii-definitive-edition',
        source: 'metacritic',
        score: 84,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/age-of-empires-ii-definitive-edition/critic-reviews/',
        isVerified: true,
      },
      'age of empires ii: definitive edition': {
        id: 'mc-age-of-empires-ii-definitive-edition',
        source: 'metacritic',
        score: 84,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/age-of-empires-ii-definitive-edition/critic-reviews/',
        isVerified: true,
      },
      487720: {
        id: 'mc-agony',
        source: 'metacritic',
        score: 47,
        tier: 'Weak',
        url: 'https://www.metacritic.com/game/agony/critic-reviews/',
        isVerified: true,
      },
      agony: {
        id: 'mc-agony',
        source: 'metacritic',
        score: 47,
        tier: 'Weak',
        url: 'https://www.metacritic.com/game/agony/critic-reviews/',
        isVerified: true,
      },
      'akalabeth: world of doom': {
        id: 'gog-akalabeth',
        source: 'gog',
        score: 68,
        tier: 'Fair',
        url: 'https://www.gog.com/en/game/akalabeth_world_of_doom',
        isVerified: false,
        isSynthetic: true,
      },
      879420: {
        id: 'steam-879420',
        source: 'steam',
        score: 58,
        tier: 'Weak',
        url: 'https://store.steampowered.com/app/879420',
        isVerified: false,
        isSynthetic: true,
      },
      'alan wake 2': {
        id: 'mc-alan-wake-ii',
        source: 'metacritic',
        score: 89,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/alan-wake-ii/critic-reviews/',
        isVerified: true,
      },
      'alan wake ii': {
        id: 'mc-alan-wake-ii',
        source: 'metacritic',
        score: 89,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/alan-wake-ii/critic-reviews/',
        isVerified: true,
      },
      '20 minutes till dawn': {
        id: 13483,
        source: 'opencritic',
        score: 77,
        percentRecommended: 50,
        tier: 'Strong',
        url: 'https://opencritic.com/game/13483/20-minutes-till-dawn',
        isVerified: true,
      },
      330820: {
        id: 'mc-2064-read-only-memories',
        source: 'metacritic',
        score: 76,
        tier: 'Strong',
        url: 'https://www.metacritic.com/game/2064-read-only-memories/critic-reviews/',
        isVerified: true,
      },
      '2064: read only memories': {
        id: 'mc-2064-read-only-memories',
        source: 'metacritic',
        score: 76,
        tier: 'Strong',
        url: 'https://www.metacritic.com/game/2064-read-only-memories/critic-reviews/',
        isVerified: true,
      },
      440: {
        id: 'mc-team-fortress-2',
        source: 'metacritic',
        score: 92,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/team-fortress-2/critic-reviews/',
        isVerified: true,
      },
      570: {
        id: 'mc-dota-2',
        source: 'metacritic',
        score: 90,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/dota-2/critic-reviews/',
        isVerified: true,
      },
      550: {
        id: 'mc-left-4-dead-2',
        source: 'metacritic',
        score: 89,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/left-4-dead-2/critic-reviews/',
        isVerified: true,
      },
      17300: {
        id: 'mc-crysis',
        source: 'metacritic',
        score: 91,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/crysis/critic-reviews/',
        isVerified: true,
      },
      17470: {
        id: 'mc-dead-space',
        source: 'metacritic',
        score: 86,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/dead-space/critic-reviews/',
        isVerified: true,
      },
      47810: {
        id: 'mc-dragon-age-origins',
        source: 'metacritic',
        score: 91,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/dragon-age-origins/critic-reviews/',
        isVerified: true,
      },
      271590: {
        id: 'mc-grand-theft-auto-v',
        source: 'metacritic',
        score: 97,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/grand-theft-auto-v/critic-reviews/',
        isVerified: true,
      },
      289070: {
        id: 'mc-civilization-vi',
        source: 'metacritic',
        score: 88,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/sid-meiers-civilization-vi/critic-reviews/',
        isVerified: true,
      },
      1426210: {
        id: 'mc-it-takes-two',
        source: 'metacritic',
        score: 88,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/it-takes-two/critic-reviews/',
        isVerified: true,
      },
      228280: {
        id: 'mc-baldurs-gate-enhanced-edition',
        source: 'metacritic',
        score: 78,
        tier: 'Strong',
        url: 'https://www.metacritic.com/game/baldurs-gate-enhanced-edition/critic-reviews/',
        isVerified: true,
      },
      257350: {
        id: 'mc-baldurs-gate-ii-enhanced-edition',
        source: 'metacritic',
        score: 78,
        tier: 'Strong',
        url: 'https://www.metacritic.com/game/baldurs-gate-ii-enhanced-edition/critic-reviews/',
        isVerified: true,
      },
      238210: {
        id: 'mc-system-shock-2',
        source: 'metacritic',
        score: 92,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/system-shock-2/critic-reviews/',
        isVerified: true,
      },
      22300: {
        id: 'mc-fallout-3',
        source: 'metacritic',
        score: 91,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/fallout-3/critic-reviews/',
        isVerified: true,
      },
      38400: {
        id: 'mc-fallout',
        source: 'metacritic',
        score: 89,
        tier: 'Mighty',
        url: 'https://www.metacritic.com/game/fallout/critic-reviews/',
        isVerified: true,
      },
      50: {
        id: 'mc-half-life-opposing-force',
        source: 'metacritic',
        score: 82,
        tier: 'Strong',
        url: 'https://www.metacritic.com/game/half-life-opposing-force/critic-reviews/',
        isVerified: true,
      },
    });
    for (const unrated of ['killingfloor2beta', 'doom i enhanced', 'hotline miami 2: wrong number - digital comics']) {
      KNOWN_UNRATED_TITLES.add(unrated);
    }
    criticScoreService.clearCache();
  });

  describe('User Reported Titles Verification', () => {
    it('Age of Empires II: Definitive Edition returns verified Metacritic score 84 (Mighty) as Tier 1', () => {
      // By Steam AppID
      const byId = criticScoreService.getCriticScore(813780, 'Age of Empires II: Definitive Edition');
      expect(byId).not.toBeNull();
      expect(byId?.score).toBe(84);
      expect(byId?.tier).toBe('Mighty');
      expect(byId?.source).toBe('metacritic');
      expect(byId?.url).toBe('https://www.metacritic.com/game/age-of-empires-ii-definitive-edition/critic-reviews/');
      expect(byId?.isVerified).toBe(true);

      // By Title
      const byTitle = criticScoreService.getCriticScore(null, 'Age of Empires II: Definitive Edition');
      expect(byTitle).not.toBeNull();
      expect(byTitle?.score).toBe(84);
      expect(byTitle?.tier).toBe('Mighty');
    });

    it('Agony returns verified Metacritic score 47 (Weak) as Tier 1', () => {
      // By Steam AppID
      const byId = criticScoreService.getCriticScore(487720, 'Agony');
      expect(byId).not.toBeNull();
      expect(byId?.score).toBe(47);
      expect(byId?.tier).toBe('Weak');
      expect(byId?.source).toBe('metacritic');
      expect(byId?.url).toBe('https://www.metacritic.com/game/agony/critic-reviews/');
      expect(byId?.isVerified).toBe(true);

      // By Title
      const byTitle = criticScoreService.getCriticScore(null, 'Agony');
      expect(byTitle).not.toBeNull();
      expect(byTitle?.score).toBe(47);
    });

    it('Akalabeth: World of Doom returns verified GOG storefront star score (68 Fair)', () => {
      const result = criticScoreService.getCriticScore(null, 'Akalabeth: World of Doom');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('gog');
      expect(result?.score).toBe(68);
      expect(result?.tier).toBe('Fair');
    });

    it('Agony UNRATED returns synthetic Steam community score when unreviewed by critics', () => {
      const result = criticScoreService.getCriticScore(879420, 'Agony UNRATED');
      expect(result).not.toBeNull();
      expect(result?.source).toBe('steam');
      expect(result?.isSynthetic).toBe(true);
      expect(result?.isVerified).toBe(false);
      expect(result?.score).toBe(58);
      expect(result?.tier).toBe('Weak');
      expect(result?.url).toBe('https://store.steampowered.com/app/879420');
    });

    it('Alan Wake 2 returns verified Tier 1 Metacritic score 89 (Mighty)', () => {
      // By Title
      const byTitle = criticScoreService.getCriticScore(null, 'Alan Wake 2');
      expect(byTitle).not.toBeNull();
      expect(byTitle?.score).toBe(89);
      expect(byTitle?.tier).toBe('Mighty');
      expect(byTitle?.source).toBe('metacritic');
      expect(byTitle?.url).toBe('https://www.metacritic.com/game/alan-wake-ii/critic-reviews/');
      expect(byTitle?.isVerified).toBe(true);

      // By Alias
      const byAlias = criticScoreService.getCriticScore(null, 'Alan Wake II');
      expect(byAlias).not.toBeNull();
      expect(byAlias?.source).toBe('metacritic');
      expect(byAlias?.url).toBe('https://www.metacritic.com/game/alan-wake-ii/critic-reviews/');
    });

    it('20 Minutes Till Dawn returns verified OpenCritic score 77 (Strong) with canonical ID 13483', () => {
      const result = criticScoreService.getCriticScore(null, '20 Minutes Till Dawn');
      expect(result).not.toBeNull();
      expect(result?.score).toBe(77);
      expect(result?.tier).toBe('Strong');
      expect(result?.id).toBe(13483);
      expect(result?.percentRecommended).toBe(50);
      expect(result?.url).toBe('https://opencritic.com/game/13483/20-minutes-till-dawn');
      expect(result?.source).toBe('opencritic');
      expect(result?.isVerified).toBe(true);
    });

    it('2064: Read Only Memories returns verified Tier 1 Metacritic score 76 (Strong)', () => {
      const result = criticScoreService.getCriticScore(330820, '2064: Read Only Memories');
      expect(result).not.toBeNull();
      expect(result?.score).toBe(76);
      expect(result?.tier).toBe('Strong');
      expect(result?.source).toBe('metacritic');
      expect(result?.url).toBe('https://www.metacritic.com/game/2064-read-only-memories/critic-reviews/');
      expect(result?.isVerified).toBe(true);

      const byTitle = criticScoreService.getCriticScore(null, '2064: Read Only Memories');
      expect(byTitle?.source).toBe('metacritic');
      expect(byTitle?.score).toBe(76);
    });

    it('Valve classics return verified scores (Team Fortress 2, Dota 2, Left 4 Dead 2)', () => {
      const tf2 = criticScoreService.getCriticScore(440, 'Team Fortress 2');
      expect(tf2?.score).toBe(92);
      expect(tf2?.tier).toBe('Mighty');
      expect(tf2?.url).toBe('https://www.metacritic.com/game/team-fortress-2/critic-reviews/');

      const dota2 = criticScoreService.getCriticScore(570, 'Dota 2');
      expect(dota2?.score).toBe(90);
      expect(dota2?.tier).toBe('Mighty');

      const l4d2 = criticScoreService.getCriticScore(550, 'Left 4 Dead 2');
      expect(l4d2?.score).toBe(89);
      expect(l4d2?.tier).toBe('Mighty');
    });

    it('EA / Origin classics return verified scores (Crysis, Dead Space, Dragon Age: Origins)', () => {
      const crysis = criticScoreService.getCriticScore(17300, 'Crysis');
      expect(crysis?.score).toBe(91);
      expect(crysis?.tier).toBe('Mighty');

      const deadSpace = criticScoreService.getCriticScore(17470, 'Dead Space (2008)');
      expect(deadSpace?.score).toBe(86);
      expect(deadSpace?.tier).toBe('Mighty');

      const dao = criticScoreService.getCriticScore(47810, 'Dragon Age: Origins');
      expect(dao?.score).toBe(91);
      expect(dao?.tier).toBe('Mighty');
    });

    it('Epic Store & modern hits return verified scores (Grand Theft Auto V, Civilization VI, It Takes Two)', () => {
      const gta5 = criticScoreService.getCriticScore(271590, 'Grand Theft Auto V');
      expect(gta5?.score).toBe(97);
      expect(gta5?.tier).toBe('Mighty');
      expect(gta5?.source).toBe('metacritic');
      expect(gta5?.url).toBe('https://www.metacritic.com/game/grand-theft-auto-v/critic-reviews/');

      const civ6 = criticScoreService.getCriticScore(289070, "Sid Meier's Civilization VI");
      expect(civ6?.score).toBe(88);
      expect(civ6?.tier).toBe('Mighty');

      const itt = criticScoreService.getCriticScore(1426210, 'It Takes Two');
      expect(itt?.score).toBe(88);
      expect(itt?.tier).toBe('Mighty');
      expect(itt?.source).toBe('metacritic');
      expect(itt?.url).toBe('https://www.metacritic.com/game/it-takes-two/critic-reviews/');
    });

    it('GOG Heritage RPGs return verified scores (Baldur\'s Gate, Planescape, System Shock 2)', () => {
      const bg1 = criticScoreService.getCriticScore(228280, "Baldur's Gate: Enhanced Edition");
      expect(bg1?.score).toBe(78);
      expect(bg1?.tier).toBe('Strong');

      const bg2 = criticScoreService.getCriticScore(257350, "Baldur's Gate II: Enhanced Edition");
      expect(bg2?.score).toBe(78);
      expect(bg2?.tier).toBe('Strong');

      const ss2 = criticScoreService.getCriticScore(238210, 'System Shock 2');
      expect(ss2?.score).toBe(92);
      expect(ss2?.tier).toBe('Mighty');
    });
  });

  describe('Zero-Fabrication Guarantees', () => {
    it('unknown or unreviewed titles strictly return null', () => {
      const result = criticScoreService.getCriticScore(99999999, 'Super Nonexistent Fantasy 2099');
      expect(result).toBeNull();
    });

    it('generates calibrated synthetic scores from Steam positive review percentages when unreviewed and linked to Steam AppID', () => {
      // getOpenCriticData third parameter is steamPositivePercent; requires valid steamAppId to prevent GOG star contamination
      const result = getOpenCriticData(123456, 'Totally Unreviewed Indie Title', 95);
      expect(result).not.toBeNull();
      expect(result?.source).toBe('steam');
      expect(result?.isSynthetic).toBe(true);
      expect(result?.isVerified).toBe(false);
      expect(result?.score).toBe(88);
      expect(result?.tier).toBe('Mighty');
      expect(result?.url).toBe('https://store.steampowered.com/app/123456');

      // Unlinked non-Steam games must not fabricate fake /search/?term= Steam scores
      expect(getOpenCriticData(null, 'Unlinked GOG Only Game', 77)).toBeNull();
    });

    it('triggers Tier 3 asynchronous background resolution even when synthetic score is served', () => {
      const resolveSpy = vi.spyOn(criticScoreService, 'resolveDynamicScore');
      const result = criticScoreService.getCriticScore(654321, 'Unreviewed Indie Game', 85);
      expect(result).not.toBeNull();
      expect(result?.isSynthetic).toBe(true);
      expect(resolveSpy).toHaveBeenCalledWith('Unreviewed Indie Game', 654321);
      resolveSpy.mockRestore();
    });

    it('explicit unrated list entries (betas, editors, tech demos) return null', () => {
      expect(criticScoreService.getCriticScore(null, 'Chivalry 2 - Public Testing')).toBeNull();
      expect(criticScoreService.getCriticScore(null, 'KillingFloor2Beta')).toBeNull();
      expect(criticScoreService.getCriticScore(null, 'Cyberpunk 2077 Digital Goodies')).toBeNull();
      expect(criticScoreService.getCriticScore(null, 'Football Manager 2024 Pre-Game Editor')).toBeNull();
      expect(criticScoreService.getCriticScore(null, 'DOOM I Enhanced')).toBeNull();
      expect(criticScoreService.getCriticScore(null, 'Hotline Miami 2: Wrong Number - Digital Comics')).toBeNull();
    });
  });

  describe('Direct Canonical URLs & Broken Search Link Prevention', () => {
    it('no verified critic entry uses broken /search?criteria= URLs', () => {
      const allEntries = Object.values(KNOWN_CRITIC_SCORES);
      expect(allEntries.length).toBeGreaterThan(20);

      for (const entry of allEntries) {
        expect(entry.url).not.toContain('/search?criteria=');
        expect(entry.url).not.toContain('opencritic.com/search');
        expect(entry.url.startsWith('https://')).toBe(true);

        if (entry.source === 'opencritic') {
          // OpenCritic URLs must be canonical game paths: https://opencritic.com/game/{id}/{slug}
          expect(entry.url).toMatch(/^https:\/\/opencritic\.com\/game\/\d+\/[a-z0-9-]+$/);
        } else if (entry.source === 'metacritic') {
          // Metacritic URLs must point to game critic reviews
          expect(entry.url).toMatch(/^https:\/\/www\.metacritic\.com\/game\/[a-z0-9-]+\/critic-reviews\/$/);
        }
      }
    });
  });

  describe('Metacritic Fallbacks', () => {
    it('provides verified Metacritic fallback for classic titles missing on OpenCritic', () => {
      // Fallout 3
      const fallout3 = criticScoreService.getCriticScore(22300, 'Fallout 3');
      expect(fallout3).not.toBeNull();
      expect(fallout3?.source).toBe('metacritic');
      expect(fallout3?.score).toBe(91);
      expect(fallout3?.url).toBe('https://www.metacritic.com/game/fallout-3/critic-reviews/');

      // Fallout (1997)
      const fallout1 = criticScoreService.getCriticScore(38400, 'Fallout');
      expect(fallout1).not.toBeNull();
      expect(fallout1?.source).toBe('metacritic');
      expect(fallout1?.score).toBe(89);

      // Half-Life: Opposing Force (1999)
      const hlOpFor = criticScoreService.getCriticScore(50, 'Half-Life: Opposing Force');
      expect(hlOpFor).not.toBeNull();
      expect(hlOpFor?.source).toBe('metacritic');
      expect(hlOpFor?.score).toBe(82);
    });
  });

  describe('Tier Rating Calculations & Design Tokens', () => {
    it('correctly calculates tiers based on OpenCritic standard thresholds', () => {
      // Mighty: score >= 84 and percentRecommended >= 85
      expect(calculateTier(85, 92)).toBe('Mighty');
      expect(calculateTier(84, 85)).toBe('Mighty');
      // Below 85% recommended drops to Strong even if score >= 84
      expect(calculateTier(85, 80)).toBe('Strong');

      // Strong: score >= 74
      expect(calculateTier(80, 75)).toBe('Strong');
      expect(calculateTier(74, 50)).toBe('Strong');

      // Fair: score >= 66
      expect(calculateTier(70, 50)).toBe('Fair');
      expect(calculateTier(66, 40)).toBe('Fair');

      // Weak: score < 66
      expect(calculateTier(65, 30)).toBe('Weak');
      expect(calculateTier(40, 0)).toBe('Weak');
    });

    it('returns valid badge styles for each tier', () => {
      for (const tier of ['Mighty', 'Strong', 'Fair', 'Weak'] as const) {
        const tokens = getTierColor(tier);
        expect(tokens.badgeBg).toBeTruthy();
        expect(tokens.badgeBorder).toBeTruthy();
        expect(tokens.badgeText).toBeTruthy();
        expect(tokens.scoreBg).toBeTruthy();
        expect(tokens.glow).toBeTruthy();
      }
    });
  });

  describe('Title Normalization for Critic Matching', () => {
    it('normalizes titles stripping symbols, punctuation and apostrophes', () => {
      expect(normalizeCriticTitleKey('Age of Empires II: Definitive Edition™')).toBe('age of empires ii definitive edition');
      expect(normalizeCriticTitleKey("Baldur's Gate 3")).toBe('baldurs gate 3');
      expect(normalizeCriticTitleKey('The Witcher® 3: Wild Hunt - Game of the Year Edition')).toBe('the witcher 3 wild hunt game of the year edition');
      expect(normalizeCriticTitleKey('Quake II (Remastered)')).toBe('quake ii remastered');
    });

    it('strips edition suffixes for base game fallback lookup', () => {
      expect(stripEditionSuffix('Age of Empires II: Definitive Edition™')).toBe('age of empires ii');
      expect(stripEditionSuffix('The Witcher® 3: Wild Hunt - Game of the Year Edition')).toBe('the witcher 3 wild hunt');
      expect(stripEditionSuffix('Quake II (Remastered)')).toBe('quake ii');
      expect(stripEditionSuffix("Baldur's Gate 3 - Digital Deluxe Edition")).toBe('baldurs gate 3');
      expect(stripEditionSuffix('Styx: Shards of Darkness - Deluxe Edition')).toBe('styx shards of darkness');
      expect(stripEditionSuffix('Worms Revolution Gold Edition')).toBe('worms revolution');
    });

    it('isSequelMismatch prevents sequel and variant cross-contamination', () => {
      expect(isSequelMismatch('Mafia', 'Mafia 3')).toBe(true);
      expect(isSequelMismatch('Mafia', 'Mafia II')).toBe(true);
      expect(isSequelMismatch('Mafia 2', 'Mafia 3')).toBe(true);
      expect(isSequelMismatch('Left 4 Dead', 'Left 4 Dead 2')).toBe(true);
      expect(isSequelMismatch('Tales from the Borderlands', 'New Tales from the Borderlands')).toBe(true);
      expect(isSequelMismatch('Skyrim', 'Skyrim VR')).toBe(true);

      // Legitimate same-game matches
      expect(isSequelMismatch('Mafia', 'Mafia')).toBe(false);
      expect(isSequelMismatch('Mafia II', 'Mafia II: Definitive Edition')).toBe(false);
      expect(isSequelMismatch('20 Minutes Till Dawn', '20 Minutes Till Dawn')).toBe(false);
      expect(isSequelMismatch('2064: Read Only Memories', '2064: Read Only Memories')).toBe(false);
    });
  });

  describe('Dynamic Live Critic Score Resolution & Scalability for New Games', () => {
    it('resolveDynamicScore resolves live games via Metacritic (Tier 1) and caches them', async () => {
      // Test dynamic resolution for a game on Metacritic
      const score = await criticScoreService.resolveDynamicScore('Metaphor: ReFantazio');
      if (score) {
        expect(score.source).toBe('metacritic');
        expect(score.score).toBeGreaterThanOrEqual(90);
        expect(score.tier).toBe('Mighty');
        expect(score.url).toContain('metacritic.com/game/');
        expect(score.isVerified).toBe(true);

        // Verify instant cache hit for subsequent query
        const cached = criticScoreService.getCriticScore(null, 'Metaphor: ReFantazio');
        expect(cached).toEqual(score);
      }
    }, 35000);

    it('resolveDynamicScore falls back to OpenCritic (Tier 2) when title is unreviewed on Metacritic', async () => {
      // 20 Minutes Till Dawn has an OpenCritic score but 0 reviews on Metacritic
      const score = await criticScoreService.resolveDynamicScore('20 Minutes Till Dawn');
      expect(score).not.toBeNull();
      expect(score?.source).toBe('opencritic');
      expect(score?.score).toBe(77);
      expect(score?.tier).toBe('Strong');
      expect(score?.url).toContain('opencritic.com/game/13483');
      expect(score?.isVerified).toBe(true);
    }, 35000);

    it('rejects low-confidence string distance matches and preserves zero-fabrication', async () => {
      const result = await criticScoreService.resolveDynamicScore('Completely Obscure Unrated Retro 1984 Nonexistent');
      expect(result).toBeNull();
    }, 35000);
  });

  describe('Cache Integrity, Semantic Validation Guard & Storage Migration', () => {
    it('detects and purges semantically mismatched localStorage entries (e.g. MGS Delta poisoned with PS1 94)', () => {
      // 1. Artificially seed a poisoned entry in localStorage under v8
      const poisonedEntry = {
        id: 'mc-metal-gear-solid',
        source: 'metacritic',
        score: 94,
        tier: 'Mighty',
        numReviews: 20,
        url: 'https://www.metacritic.com/game/metal-gear-solid/critic-reviews/',
        isVerified: true,
      };

      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('antigravity_critic_v8_id:2417610', JSON.stringify(poisonedEntry));

        // 2. getCriticScore must detect the subtitle omission/sequel mismatch, purge it, and return the true score 85!
        const result = criticScoreService.getCriticScore(2417610, 'METAL GEAR SOLID Δ: SNAKE EATER');
        expect(result).not.toBeNull();
        expect(result?.score).toBe(85);
        expect(result?.url).toBe('https://www.metacritic.com/game/metal-gear-solid-delta-snake-eater/critic-reviews/');

        // 3. Verify that the poisoned entry was purged and replaced in localStorage
        const stored = localStorage.getItem('antigravity_critic_v8_id:2417610');
        expect(stored).not.toBeNull();
        const parsedStored = JSON.parse(stored!);
        expect(parsedStored.score).toBe(85);
        expect(parsedStored.url).toContain('metal-gear-solid-delta-snake-eater');
      }
    });

    it('purgeLegacyScores removes all legacy v7, v6, v5 and unversioned keys', () => {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('antigravity_critic_v7_id:999999', JSON.stringify({ score: 99 }));
        localStorage.setItem('antigravity_critic_v6_id:888888', JSON.stringify({ score: 88 }));
        localStorage.setItem('antigravity_critic_score_id:777777', JSON.stringify({ score: 77 }));

        criticScoreService.purgeLegacyScores();

        expect(localStorage.getItem('antigravity_critic_v7_id:999999')).toBeNull();
        expect(localStorage.getItem('antigravity_critic_v6_id:888888')).toBeNull();
        expect(localStorage.getItem('antigravity_critic_score_id:777777')).toBeNull();
      }
    });

    it('evicts poisoned classic installment 1/I scores matched to modern unnumbered reboots and sanitizes corrupted Metacritic mobile descriptions', () => {
      if (typeof localStorage !== 'undefined') {
        const rebootPoison = {
          data: {
            id: 'mc-alone-in-the-dark',
            source: 'metacritic',
            score: 63,
            tier: 'Fair',
            numReviews: 50,
            url: 'https://www.metacritic.com/game/alone-in-the-dark/critic-reviews/',
            summary: 'Return to Derceto Manor in this reimagination of the 90s cult classic survival horror game.',
            isVerified: true,
          },
          tier: 'immutable',
          cachedAt: Date.now(),
          ttl: 31536000000,
        };
        localStorage.setItem('antigravity_critic_v8_title:alone in the dark 1', JSON.stringify(rebootPoison));
        expect(criticScoreService.getCriticScore(null, 'Alone in the Dark 1', undefined, undefined, undefined, false, true)).toBeNull();

        const mobileBlurbEntry = {
          data: {
            id: 'mc-showgunners',
            source: 'metacritic',
            score: 75,
            tier: 'Strong',
            numReviews: 18,
            url: 'https://www.metacritic.com/game/showgunners/critic-reviews/',
            summary: 'Having problems with the gnats in your kitchen? Then download Gnat Squisher! Using OpenFeint.',
            isVerified: true,
          },
          tier: 'immutable',
          cachedAt: Date.now(),
          ttl: 31536000000,
        };
        localStorage.setItem('antigravity_critic_v8_title:showgunners', JSON.stringify(mobileBlurbEntry));
        const sanitized = criticScoreService.getCriticScore(null, 'Showgunners', undefined, undefined, undefined, false, true);
        expect(sanitized?.score).toBe(75);
        expect(sanitized?.summary).toContain('based on 18 critic reviews');
      }
    });

    it('handles apostrophe tokenization, edition-stripped slug priority, and expanded mobile-app spam sanitization', async () => {
      const {
        isTitleCompatible,
        generateMetacriticSlugCandidates,
        rankCandidateSlugs,
        sanitizeMetacriticDescription,
      } = await import('../src/services/critic/metacriticResolver');

      // 1. Apostrophe tokenization: "Marvel's" -> 'marvels', matching slug 'marvels-guardians-of-the-galaxy'
      expect(
        isTitleCompatible(
          "Marvel's Guardians of the Galaxy",
          'marvels guardians of the galaxy'
        )
      ).toBe(true);
      expect(
        rankCandidateSlugs("Marvel's Guardians of the Galaxy", [
          'marvels-guardians-of-the-galaxy',
        ])
      ).toEqual(['marvels-guardians-of-the-galaxy']);

      // 2. Edition-stripped slug priority (Candidate #2 immediately after base)
      const spacerSlugs = generateMetacriticSlugCandidates(
        "The Outer Worlds: Spacer's Choice Edition"
      );
      expect(spacerSlugs[0]).toBe('the-outer-worlds-spacers-choice-edition');
      expect(spacerSlugs[1]).toBe('the-outer-worlds');

      const rotrSlugs = generateMetacriticSlugCandidates(
        'Rise of the Tomb Raider: 20 Year Celebration'
      );
      expect(rotrSlugs[0]).toBe('rise-of-the-tomb-raider-20-year-celebration');
      expect(rotrSlugs[1]).toBe('rise-of-the-tomb-raider');

      // 3. Expanded mobile-app spam sanitizer (CRISIS CORE / Fort Solis / Showgunners / Tinykin / Wild Bastards)
      expect(
        sanitizeMetacriticDescription(
          'Swap FireJewels to match 3 or more in this match 3 gem game available on the App Store!',
          45
        )
      ).toContain('based on 45 critic reviews');
      expect(sanitizeMetacriticDescription('???? ??? ????', 30)).toContain(
        'based on 30 critic reviews'
      );
      expect(sanitizeMetacriticDescription('? ?D? ?????????', 22)).toContain(
        'based on 22 critic reviews'
      );
      expect(
        sanitizeMetacriticDescription(
          '[AppStore] Build a towering stack of pikmin-like creatures!',
          50
        )
      ).toBe('Build a towering stack of pikmin-like creatures!');
    });

    it('Cycle 4: enforces edition-blind sequel guards, bidirectional token conservation, and episodic anchor normalization', async () => {
      const {
        isTitleCompatible,
        isAnchorSlugCompatible,
        generateMetacriticSlugCandidates,
      } = await import('../src/services/critic/metacriticResolver');

      // Class 1: Edition tokens after sequel numbers must never excuse a missing sequel number
      expect(isSequelMismatch('Mafia: Definitive Edition', 'Mafia III: Definitive Edition')).toBe(true);
      expect(isSequelMismatch('Quake', 'Quake II Enhanced Edition')).toBe(true);

      // Class 2: Bidirectional substantive token conservation
      expect(isTitleCompatible('Godzilla Voxel Wars', 'Godzilla')).toBe(false);
      expect(isTitleCompatible('Pool of Radiance', 'Pool of Radiance: Ruins of Myth Drannor')).toBe(false);
      expect(isTitleCompatible('RPG Maker XP', 'RPG Maker WITH')).toBe(false);
      expect(isTitleCompatible('Quake Champions', 'Quake')).toBe(false);
      expect(isTitleCompatible('Quake II RTX', 'Quake II Enhanced Edition')).toBe(false);
      expect(isTitleCompatible('Quake II (Original)', 'Quake II Enhanced Edition')).toBe(false);
      expect(isTitleCompatible('Fallout Tactics: Brotherhood of Steel', 'Fallout')).toBe(false);
      expect(isTitleCompatible('Half-Life 2: Deathmatch', 'Half-Life 2')).toBe(false);
      expect(isTitleCompatible('Metal Gear Solid: Snake Eater', 'Metal Gear Solid Delta: Snake Eater')).toBe(false);
      expect(isTitleCompatible('SiN Gold', 'SiN: Reloaded')).toBe(false);
      expect(
        isTitleCompatible(
          'Star Wars Jedi Knight: Dark Forces II - Mysteries of the Sith',
          'Star Wars Jedi Knight: Dark Forces II'
        )
      ).toBe(false);
      expect(isTitleCompatible('Syndicate Wars', 'Syndicate')).toBe(false);
      expect(isTitleCompatible('Syndicate Plus', 'Syndicate')).toBe(false);

      // Class 3: Non-edition subtitle stripping blocked in generateMetacriticSlugCandidates
      expect(generateMetacriticSlugCandidates('Half-Life 2: Deathmatch')).not.toContain('half-life-2');
      expect(
        generateMetacriticSlugCandidates('Star Wars Jedi Knight: Dark Forces II - Mysteries of the Sith')
      ).not.toContain('star-wars-jedi-knight');

      // Class 4: Episodic pilot anchor normalization vs Season Two sequel guard
      expect(
        isAnchorSlugCompatible('The Walking Dead', 'the-walking-dead-episode-1---a-new-day')
      ).toBe(true);
      expect(
        isAnchorSlugCompatible('The Walking Dead: Season Two', 'the-walking-dead-episode-1---a-new-day')
      ).toBe(false);
      expect(isAnchorSlugCompatible('Rustler - Grand Theft Horse', 'rustler')).toBe(true);
    });
  });
});



