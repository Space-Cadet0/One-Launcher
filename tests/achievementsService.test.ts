import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  achievementDetailService,
  classifyRarityTier,
} from '../src/services/achievements/achievementDetailService';
import {
  KNOWN_GAMES_WITHOUT_ACHIEVEMENTS,
  BALDURS_GATE_2_ACHIEVEMENTS,
} from '../src/services/achievements/canonicalAchievementSchemas';
import { CANONICAL_KNOWN_STORE_STEAM_MAPPINGS } from '../src/services/steam/steamMatcher';
import { getAchievementTrophyTier } from '../src/components/Achievements/GameAchievementsModal';
import { CanonicalGame } from '../src/contracts/game';

class LocalStorageMock {
  private store: Record<string, string> = {};
  clear() {
    this.store = {};
  }
  getItem(key: string) {
    return this.store[key] || null;
  }
  setItem(key: string, value: string) {
    this.store[key] = String(value);
  }
  removeItem(key: string) {
    delete this.store[key];
  }
}

const mockStorage = new LocalStorageMock();
(globalThis as any).localStorage = mockStorage;

describe('AchievementDetailService & Classification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockStorage.clear();
    achievementDetailService.clearCache();
    KNOWN_GAMES_WITHOUT_ACHIEVEMENTS.add('akalabeth: world of doom');
    CANONICAL_KNOWN_STORE_STEAM_MAPPINGS.set("baldur's gate ii: enhanced edition", 257350);
    if (BALDURS_GATE_2_ACHIEVEMENTS.length === 0) {
      BALDURS_GATE_2_ACHIEVEMENTS.push({
        apiName: 'A_DARING_ESCAPE',
        name: 'A Daring Escape',
        description: 'Escape from the dungeon of the wizard Irenicus.',
        iconHash: '257350',
        pct: 32.0,
      });
    }
  });

  describe('classifyRarityTier', () => {
    it('correctly classifies ultra rare achievements (< 10%)', () => {
      expect(classifyRarityTier(0.1)).toBe('ultra_rare');
      expect(classifyRarityTier(5.0)).toBe('ultra_rare');
      expect(classifyRarityTier(9.9)).toBe('ultra_rare');
    });

    it('correctly classifies rare achievements (10% - 24.9%)', () => {
      expect(classifyRarityTier(10.0)).toBe('rare');
      expect(classifyRarityTier(18.5)).toBe('rare');
      expect(classifyRarityTier(24.9)).toBe('rare');
    });

    it('correctly classifies uncommon achievements (25% - 49.9%)', () => {
      expect(classifyRarityTier(25.0)).toBe('uncommon');
      expect(classifyRarityTier(38.0)).toBe('uncommon');
      expect(classifyRarityTier(49.9)).toBe('uncommon');
    });

    it('correctly classifies common achievements (>= 50%)', () => {
      expect(classifyRarityTier(50.0)).toBe('common');
      expect(classifyRarityTier(75.5)).toBe('common');
      expect(classifyRarityTier(100.0)).toBe('common');
    });

    it('safely defaults to common for undefined, null, or invalid percentages', () => {
      expect(classifyRarityTier(undefined)).toBe('common');
      expect(classifyRarityTier(null as any)).toBe('common');
      expect(classifyRarityTier(NaN)).toBe('common');
    });
  });

  describe('fetchGameAchievements', () => {
    const mockGame: CanonicalGame = {
      id: 'steam-1091500',
      title: 'Cyberpunk 2077',
      sortTitle: 'Cyberpunk 2077',
      steamAppId: 1091500,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '1091500',
          installed: true,
          achievements: {
            total: 44,
            unlocked: 22,
            percentage: 50,
            isMastered: false,
            syncedAt: '2026-10-10T12:00:00Z',
          },
        },
      ],
      capsuleImage: 'https://example.com/cyberpunk-capsule.jpg',
      headerImage: 'https://example.com/cyberpunk-header.jpg',
      shortDescription: 'Cyberpunk RPG game.',
      developers: ['CD PROJEKT RED'],
      publishers: ['CD PROJEKT RED'],
      genres: ['RPG'],
      tags: ['Open World', 'Cyberpunk'],
    };

    it('returns empty object if game is null or undefined', async () => {
      const res = await achievementDetailService.fetchGameAchievements(null as any);
      expect(res).toEqual({});
    });

    it('retrieves detailed achievements for a Steam game', async () => {
      const result = await achievementDetailService.fetchGameAchievements(mockGame);
      expect(result).toBeDefined();
      expect(result.steam).toBeDefined();

      const steamData = result.steam!;
      expect(steamData.storefrontId).toBe('steam');
      expect(steamData.storefrontName).toBe('Steam');
      expect(steamData.total).toBeGreaterThanOrEqual(44);
      expect(steamData.unlocked).toBeGreaterThanOrEqual(0);
      expect(steamData.achievements.length).toBe(steamData.total);

      // Verify structure of individual achievement items
      const firstAch = steamData.achievements[0];
      expect(firstAch.id).toBeDefined();
      expect(firstAch.apiName).toBeDefined();
      expect(firstAch.name).toBeDefined();
      expect(firstAch.iconUnlockedUrl).toBeDefined();
      expect(firstAch.rarityTier).toBeDefined();
      expect(firstAch.storefrontId).toBe('steam');

      // Verify achievements collection has valid unlock statuses
      expect(steamData.achievements.every((a) => typeof a.unlocked === 'boolean')).toBe(true);
    });

    it('caches detailed achievements in localStorage and reuses cache', async () => {
      // First fetch sets cache
      const initialResult = await achievementDetailService.fetchGameAchievements(mockGame);

      const cachedKey = `antigravity_detailed_achievements_${mockGame.id}`;
      const cachedRaw = mockStorage.getItem(cachedKey);
      expect(cachedRaw).not.toBeNull();

      const parsed = JSON.parse(cachedRaw!);
      expect(parsed.steam).toBeDefined();
      expect(parsed.steam.total).toBe(initialResult.steam?.total);

      // Clear in-memory cache to force reading from storage
      achievementDetailService.clearCache();

      // Modifying cache to verify hydration from cache on next call
      parsed.steam.total = 99;
      mockStorage.setItem(cachedKey, JSON.stringify(parsed));

      const cachedResult = await achievementDetailService.fetchGameAchievements(mockGame);
      expect(cachedResult.steam?.total).toBe(99);
    });

    it('aggregates multi-storefront achievements for games owned on Steam, GOG, and Epic', async () => {
      const multiStoreGame: CanonicalGame = {
        id: 'multi-game-1',
        title: 'DOOM Eternal',
        sortTitle: 'DOOM Eternal',
        steamAppId: 782330,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '782330',
            installed: true,
            achievements: {
              total: 33,
              unlocked: 33,
              percentage: 100,
              isMastered: true,
            },
          },
          {
            platformId: 'gog',
            platformGameId: 'doom_eternal_gog',
            installed: false,
            achievements: {
              total: 33,
              unlocked: 10,
              percentage: 30,
              isMastered: false,
            },
          },
          {
            platformId: 'epic',
            platformGameId: 'doom_eternal_epic',
            installed: false,
            achievements: {
              total: 33,
              unlocked: 5,
              percentage: 15,
              isMastered: false,
            },
          },
        ],
        capsuleImage: 'https://example.com/doom.jpg',
        headerImage: 'https://example.com/doom-header.jpg',
        shortDescription: 'Hell on Earth.',
        developers: ['id Software'],
        publishers: ['Bethesda Softworks'],
        genres: ['Action', 'FPS'],
        tags: ['Fast-Paced'],
      };

      const result = await achievementDetailService.fetchGameAchievements(multiStoreGame);

      // Steam check
      expect(result.steam).toBeDefined();
      expect(result.steam?.total).toBeGreaterThanOrEqual(33);

      // GOG check
      expect(result.gog).toBeDefined();
      expect(result.gog?.total).toBe(33);
      expect(result.gog?.unlocked).toBe(10);
      expect(result.gog?.achievements.length).toBe(33);
      expect(result.gog?.achievements[0].storefrontId).toBe('gog');

      // Epic check
      expect(result.epic).toBeDefined();
      expect(result.epic?.total).toBe(33);
      expect(result.epic?.unlocked).toBe(5);
      expect(result.epic?.totalXp).toBeGreaterThan(0);
      expect(result.epic?.earnedXp).toBeGreaterThan(0);
      expect(result.epic?.achievements[0].xp).toBeDefined();
      expect(result.epic?.achievements[0].storefrontId).toBe('epic');
    });

    it('safely handles games without achievements gracefully', async () => {
      const gameWithoutAchs: CanonicalGame = {
        id: 'no-achs-game',
        title: 'Classic DOS Game',
        sortTitle: 'Classic DOS Game',
        steamAppId: null,
        platforms: [{ platformId: 'custom', platformGameId: 'custom-1', installed: true }],
        capsuleImage: 'https://example.com/classic.jpg',
        headerImage: 'https://example.com/classic-header.jpg',
        shortDescription: 'Old DOS game.',
        developers: ['Old Dev'],
        publishers: ['Old Pub'],
        genres: ['Adventure'],
        tags: ['Retro'],
      };

      const result = await achievementDetailService.fetchGameAchievements(gameWithoutAchs);
      expect(result).toBeDefined();
      expect(result.steam).toBeUndefined();
      expect(result.epic).toBeUndefined();
      expect(result.gog).toBeUndefined();
    });

    it('populates all 93 possible GOG achievements for unplayed Baldur\'s Gate II: Enhanced Edition', async () => {
      // Simulates real user library: owned on GOG with 0 playtime / no prior achievement summary
      const bg2Gog: CanonicalGame = {
        id: 'steam-257350',
        title: "Baldur's Gate II: Enhanced Edition",
        sortTitle: "Baldur's Gate II: Enhanced Edition",
        steamAppId: 257350,
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1207666373',
            installed: false,
            playtimeMinutes: 0,
            // achievements is intentionally undefined (unplayed on GOG)
          },
        ],
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/257350/library_600x900_2x.jpg',
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/257350/header.jpg',
        shortDescription: 'Return to a timeless RPG masterpiece.',
        developers: ['Beamdog'],
        publishers: ['Beamdog'],
        genres: ['Role-playing'],
        tags: ['Fantasy', 'CRPG'],
      };

      const result = await achievementDetailService.fetchGameAchievements(bg2Gog);
      expect(result.gog).toBeDefined();

      const gogData = result.gog!;
      expect(gogData.storefrontId).toBe('gog');
      expect(gogData.storefrontName).toBe('GOG GALAXY');
      expect(gogData.total).toBe(93);
      expect(gogData.unlocked).toBe(0);
      expect(gogData.percentage).toBe(0);
      expect(gogData.isMastered).toBe(false);
      expect(gogData.supportsAchievements).toBe(true);
      expect(gogData.achievements).toHaveLength(93);

      // Verify all achievements on unplayed GOG are locked
      expect(gogData.achievements.every((a) => a.unlocked === false)).toBe(true);

      // Verify authentic named entries and real medal icons (not capsule covers!)
      const firstAch = gogData.achievements[0];
      expect(firstAch.name).toBe('A Daring Escape');
      expect(firstAch.description).toBe('Escape from the dungeon of the wizard Irenicus.');
      expect(firstAch.iconUnlockedUrl).toContain('257350');
      expect(firstAch.iconUnlockedUrl).not.toContain('library_600x900');
      expect(firstAch.globalPercentage).toBe(32.0);
      expect(firstAch.storefrontId).toBe('gog');
    });

    it('enforces strict storefront isolation: Steam progress does NOT mark GOG achievements as unlocked', async () => {
      // Game owned on both Steam and GOG
      const bg2MultiStore: CanonicalGame = {
        id: 'steam-257350',
        title: "Baldur's Gate II: Enhanced Edition",
        sortTitle: "Baldur's Gate II: Enhanced Edition",
        steamAppId: 257350,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '257350',
            installed: true,
            achievements: {
              total: 93,
              unlocked: 47,
              percentage: 51,
              isMastered: false,
            },
          },
          {
            platformId: 'gog',
            platformGameId: '1207666373',
            installed: false,
            // GOG has no unlocked achievements
          },
        ],
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/257350/library_600x900_2x.jpg',
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/257350/header.jpg',
        shortDescription: 'Baldurs Gate II',
        developers: ['Beamdog'],
        publishers: ['Beamdog'],
        genres: ['RPG'],
        tags: ['CRPG'],
      };

      const result = await achievementDetailService.fetchGameAchievements(bg2MultiStore);
      expect(result.steam).toBeDefined();
      expect(result.gog).toBeDefined();

      // Steam has 47 unlocked
      expect(result.steam?.total).toBe(93);
      expect(result.steam?.unlocked).toBe(47);
      expect(result.steam?.percentage).toBe(51);

      // GOG remains strictly 0 unlocked
      expect(result.gog?.total).toBe(93);
      expect(result.gog?.unlocked).toBe(0);
      expect(result.gog?.percentage).toBe(0);
      expect(result.gog?.achievements.every((a) => a.unlocked === false)).toBe(true);
    });

    it('retrieves complete 88 Epic achievements with XP for Alan Wake 2', async () => {
      vi.spyOn(achievementDetailService, 'getCanonicalGameSchema').mockResolvedValueOnce(
        Array.from({ length: 88 }, (_, i) => ({
          id: `epic:alan-wake-2:${i}`,
          apiName: `AW2_${i}`,
          name: i === 0 ? 'Bright Falls Finest' : `Alan Wake 2 Achievement #${i + 1}`,
          description: 'Complete objective.',
          unlocked: false,
          iconUnlockedUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co7dcz.jpg',
          xp: i === 0 ? 250 : 15,
          storefrontId: 'epic',
        }))
      );

      const alanWake2: CanonicalGame = {
        id: 'epic-93f2a8c3547846eda966cb3c152a026e',
        title: 'Alan Wake 2',
        sortTitle: 'Alan Wake 2',
        steamAppId: null,
        platforms: [
          {
            platformId: 'epic',
            platformGameId: '93f2a8c3547846eda966cb3c152a026e',
            installed: false,
            achievements: {
              total: 88,
              unlocked: 59,
              percentage: 67,
              xp: { earned: 830, total: 1360 },
              isMastered: false,
            },
          },
        ],
        capsuleImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co7dcz.jpg',
        headerImage: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co7dcz.jpg',
        shortDescription: 'Survival horror.',
        developers: ['Remedy Entertainment'],
        publishers: ['Epic Games Publishing'],
        genres: ['Action', 'Horror'],
        tags: ['Atmospheric'],
      };

      const result = await achievementDetailService.fetchGameAchievements(alanWake2);
      expect(result.epic).toBeDefined();

      const epicData = result.epic!;
      expect(epicData.total).toBe(88);
      expect(epicData.unlocked).toBe(59);
      expect(epicData.percentage).toBe(67);
      expect(epicData.totalXp).toBe(1360);
      expect(epicData.earnedXp).toBe(830);
      expect(epicData.achievements).toHaveLength(88);
      expect(epicData.achievements[0].xp).toBe(250);
    });

    it('correctly flags retro titles as not supporting achievements without phantom records', async () => {
      const akalabeth: CanonicalGame = {
        id: 'gog-1207658744',
        title: 'Akalabeth: World of Doom',
        sortTitle: 'Akalabeth: World of Doom',
        steamAppId: null,
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1207658744',
            installed: false,
          },
        ],
        capsuleImage: 'https://images.gog.com/akalabeth.jpg',
        headerImage: 'https://images.gog.com/akalabeth.jpg',
        shortDescription: 'Classic Richard Garriott RPG.',
        developers: ['Richard Garriott'],
        publishers: ['California Pacific'],
        genres: ['RPG'],
        tags: ['Retro'],
      };

      const result = await achievementDetailService.fetchGameAchievements(akalabeth);
      expect(result.gog).toBeDefined();
      expect(result.gog?.supportsAchievements).toBe(false);
      expect(result.gog?.total).toBe(0);
      expect(result.gog?.unlocked).toBe(0);
      expect(result.gog?.achievements).toHaveLength(0);
    });

    it('bridges schema for unplayed GOG titles lacking steamAppId via title match', async () => {
      // Game without steamAppId preset on the object
      const gogOnlyBg2: CanonicalGame = {
        id: 'gog-1207666373',
        title: "Baldur's Gate II: Enhanced Edition",
        sortTitle: "Baldur's Gate II: Enhanced Edition",
        steamAppId: null,
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1207666373',
            installed: false,
            playtimeMinutes: 0,
          },
        ],
        capsuleImage: 'https://example.com/bg2.jpg',
        headerImage: 'https://example.com/bg2-header.jpg',
        shortDescription: 'Legendary RPG.',
        developers: ['Beamdog'],
        publishers: ['Beamdog'],
        genres: ['RPG'],
        tags: ['Classic'],
      };

      const result = await achievementDetailService.fetchGameAchievements(gogOnlyBg2);
      expect(result.gog).toBeDefined();
      expect(result.gog?.total).toBe(93);
      expect(result.gog?.unlocked).toBe(0);
      expect(result.gog?.percentage).toBe(0);
      expect(result.gog?.achievements).toHaveLength(93);
      expect(result.gog?.achievements.every((a) => !a.unlocked)).toBe(true);
    });
  });

  describe('PlayStation Trophy Tier Classification', () => {
    it('classifies platinum trophies for capstone achievements or 250 XP', () => {
      expect(
        getAchievementTrophyTier(
          {
            id: '1',
            apiName: 'PLAT',
            name: 'Bright Falls Finest: Unlock All Achievements',
            unlocked: false,
            iconUnlockedUrl: '',
            storefrontId: 'epic',
            xp: 250,
          },
          88,
          0
        )
      ).toBe('platinum');

      expect(
        getAchievementTrophyTier(
          {
            id: '2',
            apiName: 'PLAT2',
            name: 'All Achievements Unlocked',
            unlocked: false,
            iconUnlockedUrl: '',
            storefrontId: 'steam',
          },
          50,
          49
        )
      ).toBe('platinum');
    });

    it('classifies gold trophies for ultra-rare achievements or XP >= 100', () => {
      expect(
        getAchievementTrophyTier(
          {
            id: '3',
            apiName: 'GOLD1',
            name: 'Dragon Slayer',
            unlocked: false,
            iconUnlockedUrl: '',
            storefrontId: 'steam',
            globalPercentage: 5.2,
          },
          50,
          10
        )
      ).toBe('gold');

      expect(
        getAchievementTrophyTier(
          {
            id: '4',
            apiName: 'GOLD2',
            name: 'Master Investigator',
            unlocked: false,
            iconUnlockedUrl: '',
            storefrontId: 'epic',
            xp: 100,
            globalPercentage: 12.0,
          },
          88,
          15
        )
      ).toBe('gold');
    });

    it('classifies silver trophies for rare/uncommon achievements (10% - 34.9%) or XP >= 50', () => {
      expect(
        getAchievementTrophyTier(
          {
            id: '5',
            apiName: 'SILV1',
            name: 'Planehopper',
            unlocked: false,
            iconUnlockedUrl: '',
            storefrontId: 'steam',
            globalPercentage: 18.5,
          },
          93,
          20
        )
      ).toBe('silver');

      expect(
        getAchievementTrophyTier(
          {
            id: '6',
            apiName: 'SILV2',
            name: 'Coffee Thermos Collector',
            unlocked: false,
            iconUnlockedUrl: '',
            storefrontId: 'epic',
            xp: 50,
            globalPercentage: 42.0,
          },
          88,
          25
        )
      ).toBe('silver');
    });

    it('classifies bronze trophies for common achievements (>= 35%) or XP < 50', () => {
      expect(
        getAchievementTrophyTier(
          {
            id: '7',
            apiName: 'BRONZ1',
            name: 'First Steps',
            unlocked: false,
            iconUnlockedUrl: '',
            storefrontId: 'steam',
            globalPercentage: 78.4,
          },
          50,
          2
        )
      ).toBe('bronze');

      expect(
        getAchievementTrophyTier(
          {
            id: '8',
            apiName: 'BRONZ2',
            name: 'Escape its Grasp',
            unlocked: false,
            iconUnlockedUrl: '',
            storefrontId: 'epic',
            xp: 20,
            globalPercentage: 82.4,
          },
          88,
          1
        )
      ).toBe('bronze');
    });
  });
});
