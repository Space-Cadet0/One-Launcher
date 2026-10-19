import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import {
  normalizeCanonicalTitle,
  hasSameStorefrontConflict,
  sanitizeGameCatalog,
  getSuppressedCatalogEntries,
} from '../src/services/integrations/catalogSanitizer';
import { unhideStorefrontEntry } from '../src/services/storage/userOverrideStorage';
import {
  mergeStorefrontGames,
} from '../src/services/integrations/integrationStorage';
import { steamAchievementsService } from '../src/services/steam/steamAchievementsService';
import { CanonicalGame } from '../src/contracts/game';

const store = new Map<string, string>();
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    },
    writable: true,
  });
}

describe('PDF Ground-Truth Storefront Reconciliation Fixes', () => {
  beforeEach(() => {
    store.clear();
    vi.restoreAllMocks();
  });

  it('normalizeCanonicalTitle preserves distinct remake/remaster/edition suffixes while stripping cross-storefront packaging', () => {
    // Distinct remakes/remasters/editions must NOT collapse into base games
    expect(normalizeCanonicalTitle('Mafia: Definitive Edition')).not.toBe(normalizeCanonicalTitle('Mafia'));
    expect(normalizeCanonicalTitle('Metro Exodus Enhanced Edition')).not.toBe(normalizeCanonicalTitle('Metro Exodus'));
    expect(normalizeCanonicalTitle('Little Nightmares Enhanced Edition')).not.toBe(normalizeCanonicalTitle('Little Nightmares'));
    expect(normalizeCanonicalTitle('Grand Theft Auto V Enhanced')).not.toBe(normalizeCanonicalTitle('Grand Theft Auto V'));
    expect(normalizeCanonicalTitle('BioShock™ Remastered')).not.toBe(normalizeCanonicalTitle('BioShock™'));
    expect(normalizeCanonicalTitle('BioShock™ 2 Remastered')).not.toBe(normalizeCanonicalTitle('BioShock™ 2'));
    expect(normalizeCanonicalTitle('Thief™ Gold')).not.toBe(normalizeCanonicalTitle('Thief: The Dark Project'));
    expect(normalizeCanonicalTitle('Mafia II (Classic)')).not.toBe(normalizeCanonicalTitle('Mafia II: Definitive Edition'));
    expect(normalizeCanonicalTitle('Quake II (Original)')).not.toBe(normalizeCanonicalTitle('Quake II'));

    // Cross-storefront packaging/DLC bundles SHOULD normalize to the same canonical title
    expect(normalizeCanonicalTitle('Deus Ex: Game of the Year Edition')).toBe(normalizeCanonicalTitle('Deus Ex GOTY Edition'));
    expect(normalizeCanonicalTitle('Tomb Raider GOTY')).toBe(normalizeCanonicalTitle('Tomb Raider: Game of the Year Edition'));
    expect(normalizeCanonicalTitle('Rise of the Tomb Raider: 20 Year Celebration')).toBe(normalizeCanonicalTitle('Rise of the Tomb Raider'));
    expect(normalizeCanonicalTitle('UnderRail + Official Walkthrough')).toBe(normalizeCanonicalTitle('UnderRail'));
  });

  it('hasSameStorefrontConflict prevents two distinct entitlements from the same storefront from collapsing', () => {
    const metroBase: CanonicalGame = {
      id: 'steam-412020',
      title: 'Metro Exodus',
      steamAppId: 412020,
      platforms: [{ platformId: 'steam', platformGameId: '412020', installed: false }],
    };
    const metroEnhanced: CanonicalGame = {
      id: 'steam-1449560',
      title: 'Metro Exodus Enhanced Edition',
      steamAppId: 1449560,
      platforms: [{ platformId: 'steam', platformGameId: '1449560', installed: false }],
    };
    expect(hasSameStorefrontConflict(metroBase, metroEnhanced)).toBe(true);

    // Cross-storefront identical game has NO same-storefront conflict
    const metroGog: CanonicalGame = {
      id: 'gog-1407287452',
      title: 'Metro Exodus',
      platforms: [{ platformId: 'gog', platformGameId: '1407287452', installed: false }],
    };
    expect(hasSameStorefrontConflict(metroBase, metroGog)).toBe(false);
  });

  it('mergeStorefrontGames repairs corrupted platformGameId and detaches un-merged editions from base games', () => {
    // Simulate corrupted pre-fix state where Mafia (2002, steam-40990) had GOG Mafia: Definitive Edition attached,
    // and Metro Exodus (steam-412020) had platformGameId overwritten to '1449560' with 1643 playtimeMinutes
    const corruptedInitial: CanonicalGame[] = [
      {
        id: 'steam-40990',
        title: 'Mafia',
        steamAppId: 40990,
        platforms: [
          { platformId: 'steam', platformGameId: '40990', installed: false },
          { platformId: 'gog', platformGameId: '1993581340', installed: false },
        ],
      },
      {
        id: 'steam-412020',
        title: 'Metro Exodus',
        steamAppId: 412020,
        platforms: [
          { platformId: 'steam', platformGameId: '1449560', installed: false, playtimeMinutes: 1643 },
        ],
      },
    ];
    localStorage.setItem('antigravity_merged_catalog', JSON.stringify(corruptedInitial));

    // Sync Steam with both Metro Exodus (0m) and Metro Exodus Enhanced Edition (1643m)
    const afterSteam = mergeStorefrontGames(
      corruptedInitial,
      [
        {
          id: 'steam-412020',
          title: 'Metro Exodus',
          steamAppId: 412020,
          isVerifiedEntitlement: true,
          platforms: [{ platformId: 'steam', platformGameId: '412020', installed: false, playtimeMinutes: 0 }],
        },
        {
          id: 'steam-1449560',
          title: 'Metro Exodus Enhanced Edition',
          steamAppId: 1449560,
          isVerifiedEntitlement: true,
          platforms: [{ platformId: 'steam', platformGameId: '1449560', installed: false, playtimeMinutes: 1643 }],
        },
        {
          id: 'steam-40990',
          title: 'Mafia',
          steamAppId: 40990,
          isVerifiedEntitlement: true,
          platforms: [{ platformId: 'steam', platformGameId: '40990', installed: false, playtimeMinutes: 0 }],
        },
      ],
      'steam'
    );

    // Sync GOG with Mafia: Definitive Edition
    const updated = mergeStorefrontGames(
      afterSteam,
      [
        {
          id: 'gog-1993581340',
          title: 'Mafia: Definitive Edition',
          isVerifiedEntitlement: true,
          platforms: [{ platformId: 'gog', platformGameId: '1993581340', installed: false }],
        },
      ],
      'gog'
    );

    const metroBase = updated.find((g) => g.id === 'steam-412020');
    const metroEnhanced = updated.find((g) => g.id === 'steam-1449560');
    const mafia2002 = updated.find((g) => g.id === 'steam-40990');
    const mafiaDefinitive = updated.find((g) => g.id === 'gog-1993581340');

    expect(metroBase).toBeDefined();
    expect(metroBase?.platforms.find((p) => p.platformId === 'steam')?.platformGameId).toBe('412020');

    expect(metroEnhanced).toBeDefined();
    expect(metroEnhanced?.title).toBe('Metro Exodus Enhanced Edition');
    expect(metroEnhanced?.platforms.find((p) => p.platformId === 'steam')?.playtimeMinutes).toBe(1643);

    expect(mafia2002).toBeDefined();
    expect(mafia2002?.platforms.some((p) => p.platformId === 'gog')).toBe(false);

    expect(mafiaDefinitive).toBeDefined();
    expect(mafiaDefinitive?.title).toBe('Mafia: Definitive Edition');
    expect(mafiaDefinitive?.platforms.some((p) => p.platformId === 'gog' && p.platformGameId === '1993581340')).toBe(true);
  });

  it('sanitizeGameCatalog suppresses prologues/betas into getSuppressedCatalogEntries by default and preserves them when restored by user', () => {
    const catalog: CanonicalGame[] = [
      {
        id: 'steam-1309',
        title: 'SiN Multiplayer',
        steamAppId: 1309,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '1309', installed: false }],
      },
      {
        id: 'gog-1589624510',
        title: 'Urbek City Builder Prologue',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '1589624510', installed: false }],
      },
      {
        id: 'epic-chivalry2-testing',
        title: 'Chivalry 2 - Public Testing',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'epic', platformGameId: 'chivalry2-testing', installed: false }],
      },
      {
        id: 'epic-unverified-beta',
        title: 'Some Random Unverified Tech Beta',
        isVerifiedEntitlement: false,
        platforms: [{ platformId: 'epic', platformGameId: 'random-beta', installed: false }],
      },
      {
        id: 'epic-UnrealTournamentDev',
        title: 'Unreal Tournament',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'epic', platformGameId: 'UnrealTournamentDev', installed: false }],
      },
      {
        id: 'epic-unreal-engine-5',
        title: 'Unreal Engine 5',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'epic', platformGameId: 'unreal-engine-5', installed: false }],
      },
    ];

    const sanitized = sanitizeGameCatalog(catalog);
    // Standalone base game (Unreal Tournament) is preserved
    expect(sanitized.some((g) => g.id === 'epic-UnrealTournamentDev')).toBe(true);
    // Non-game betas, prologues, test branches, and engine tools are suppressed by default
    expect(sanitized.some((g) => g.id === 'steam-1309')).toBe(false);
    expect(sanitized.some((g) => g.id === 'gog-1589624510')).toBe(false);
    expect(sanitized.some((g) => g.id === 'epic-chivalry2-testing')).toBe(false);
    expect(sanitized.some((g) => g.id === 'epic-unverified-beta')).toBe(false);
    expect(sanitized.some((g) => g.id === 'epic-unreal-engine-5')).toBe(false);

    // And recorded in getSuppressedCatalogEntries() for the Library Match & Overrides Studio
    const suppressed = getSuppressedCatalogEntries();
    expect(suppressed.some((e) => e.rawTitle === 'SiN Multiplayer')).toBe(true);
    expect(suppressed.some((e) => e.rawTitle === 'Urbek City Builder Prologue')).toBe(true);
    expect(suppressed.some((e) => e.rawTitle === 'Chivalry 2 - Public Testing')).toBe(true);

    // When explicitly restored by the user via unhideStorefrontEntry, they are included in the active library
    unhideStorefrontEntry('steam', '1309', 'steam-1309');
    unhideStorefrontEntry('gog', '1589624510', 'gog-1589624510');
    unhideStorefrontEntry('epic', 'chivalry2-testing', 'epic-chivalry2-testing');

    const restoredSanitized = sanitizeGameCatalog(catalog);
    expect(restoredSanitized.some((g) => g.id === 'steam-1309')).toBe(true);
    expect(restoredSanitized.some((g) => g.id === 'gog-1589624510')).toBe(true);
    expect(restoredSanitized.some((g) => g.id === 'epic-chivalry2-testing')).toBe(true);
  });

  it('steamAchievementsService.fetchPlayerGameAchievements extracts achievements from redirected HTML when Steam strips ?xml=1', async () => {
    // Mock axios.get returning HTML from a redirected custom friendlyURL (like /id/Space-Cadet/stats/TheWitcher2)
    const mockHtml = `
      <html>
        <head>
          <meta name="Description" content="27 of 52 (52%) achievements earned">
        </head>
        <body>
          <div id="topSummaryAchievements">27 of 52 (52%) Achievements Earned:</div>
        </body>
      </html>
    `;
    vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: mockHtml,
    });

    const res = await steamAchievementsService.fetchPlayerGameAchievements(20920, '76561198244849198');
    expect(res).toMatchObject({
      unlocked: 27,
      total: 52,
      percentage: 52,
      isMastered: false,
    });
  });
});
