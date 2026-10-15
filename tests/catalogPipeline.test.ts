import { describe, it, expect } from 'vitest';
import { FULL_USER_STEAM_GAMES } from '../src/services/storage/fullUserSteamGames';
import { GOG_USER_LIBRARY } from '../src/services/storage/gogUserLibrary';
import { EPIC_USER_LIBRARY } from '../src/services/storage/epicUserLibrary';
import {
  sanitizeGameCatalog,
  normalizeCanonicalTitle,
  isEpicNonGameEntry,
  isNonGameCatalogEntry,
} from '../src/services/integrations/catalogSanitizer';
import { mergeStorefrontGames } from '../src/services/integrations/integrationStorage';
import { CanonicalGame } from '../src/contracts/game';

describe('Catalog Pipeline & Merging', () => {
  it('raw libraries in src/ are clean-sheet empty arrays (zero hardcoded user library snapshots)', () => {
    expect(FULL_USER_STEAM_GAMES).toHaveLength(0);
    expect(GOG_USER_LIBRARY).toHaveLength(0);
    expect(EPIC_USER_LIBRARY).toHaveLength(0);
  });

  it('merging Steam, GOG, and Epic deduplicates cross-storefront editions and filters non-game entries', () => {
    const steamGames: CanonicalGame[] = [
      {
        id: 'steam-203160',
        title: 'Tomb Raider',
        steamAppId: 203160,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '203160' }],
      },
      {
        id: 'steam-391220',
        title: 'Rise of the Tomb Raider',
        steamAppId: 391220,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '391220' }],
      },
      {
        id: 'steam-22380',
        title: 'Fallout: New Vegas',
        steamAppId: 22380,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '22380' }],
      },
      {
        id: 'steam-1313',
        title: 'SiN Multiplayer',
        steamAppId: 1313,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '1313' }],
      },
    ];

    const gogGames: CanonicalGame[] = [
      {
        id: 'gog-tomb-raider-goty',
        title: 'Tomb Raider GOTY',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: 'tomb-raider-goty' }],
      },
      {
        id: 'gog-shadowrun-hk',
        title: 'Shadowrun Hong Kong - Extended Edition',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: 'shadowrun-hk' }],
      },
      {
        id: 'gog-postal',
        title: 'POSTAL: Classic and Uncut',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: 'postal-classic' }],
      },
      {
        id: 'gog-urbek-prologue',
        title: 'Urbek City Builder Prologue',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: 'urbek-prologue' }],
      },
    ];

    const epicGames: CanonicalGame[] = [
      {
        id: 'epic-rotr',
        title: 'Rise of the Tomb Raider: 20 Year Celebration',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'epic', platformGameId: 'epic-rotr' }],
      },
      {
        id: 'epic-fnv',
        title: 'Fallout: New Vegas Ultimate Edition',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'epic', platformGameId: 'epic-fnv' }],
      },
      {
        id: 'epic-shadowrun-hk',
        title: 'Shadowrun Hong Kong',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'epic', platformGameId: 'epic-sr-hk' }],
      },
      {
        id: 'epic-postal',
        title: 'POSTAL',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'epic', platformGameId: 'epic-postal' }],
      },
      {
        id: 'epic-kf2-beta',
        title: 'KillingFloor2Beta',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'epic', platformGameId: 'KillingFloor2Beta' }],
      },
    ];

    let catalog = sanitizeGameCatalog(steamGames);
    // All 4 verified Steam entitlements (including SiN Multiplayer) are preserved
    expect(catalog).toHaveLength(4);

    catalog = mergeStorefrontGames(catalog, gogGames, 'gog');
    // Tomb Raider GOTY merges into Tomb Raider; Urbek Prologue, Shadowrun HK & POSTAL added -> 7 unique games
    expect(catalog).toHaveLength(7);

    catalog = mergeStorefrontGames(catalog, epicGames, 'epic');
    // All 4 cross-storefront Epic games merge into existing Steam/GOG entries; KillingFloor2Beta added -> 8 unique games
    expect(catalog).toHaveLength(8);

    const tr = catalog.find((g) => normalizeCanonicalTitle(g.title) === 'tomb raider');
    expect(tr?.platforms.map((p) => p.platformId)).toEqual(expect.arrayContaining(['steam', 'gog']));

    const rotr = catalog.find((g) => normalizeCanonicalTitle(g.title) === 'rise of the tomb raider');
    expect(rotr?.platforms.map((p) => p.platformId)).toEqual(expect.arrayContaining(['steam', 'epic']));
  });

  it('normalizes canonical titles across edition variants and filters non-game betas/prologues', () => {
    expect(normalizeCanonicalTitle('Tomb Raider GOTY')).toBe('tomb raider');
    expect(normalizeCanonicalTitle('Rise of the Tomb Raider: 20 Year Celebration')).toBe('rise of the tomb raider');
    expect(normalizeCanonicalTitle('Shadowrun Hong Kong - Extended Edition')).toBe('shadowrun hong kong');
    expect(normalizeCanonicalTitle('POSTAL: Classic and Uncut')).toBe('postal');
    expect(normalizeCanonicalTitle('Fallout: New Vegas Ultimate Edition')).toBe('fallout new vegas');
    expect(normalizeCanonicalTitle('Control Ultimate Edition')).toBe('control');

    expect(isNonGameCatalogEntry({ id: '1', title: 'Fall of Porcupine: Prologue', platforms: [] })).toBe(true);
    expect(isNonGameCatalogEntry({ id: '2', title: 'Total War: PHARAOH - Public Testing', platforms: [] })).toBe(true);
    expect(isNonGameCatalogEntry({ id: '3', title: 'Football Manager 2022 Pre-Game Editor', platforms: [] })).toBe(true);
    expect(isEpicNonGameEntry({ id: '4', title: 'The Witcher 3: Wild Hunt - Game of the Year Edition', platforms: [] })).toBe(false);
  });

  it('preserves key titles with accurate metadata and SteamAppIDs when sanitized', () => {
    const sampleCatalog: CanonicalGame[] = [
      {
        id: 'steam-487720',
        title: 'Agony',
        steamAppId: 487720,
        isVerifiedEntitlement: true,
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/487720/library_600x900_2x.jpg',
        platforms: [{ platformId: 'steam', platformGameId: '487720' }],
      },
      {
        id: 'steam-879420',
        title: 'Agony UNRATED',
        steamAppId: 879420,
        isVerifiedEntitlement: true,
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/879420/library_600x900_2x.jpg',
        platforms: [{ platformId: 'steam', platformGameId: '879420' }],
      },
      {
        id: 'gog-blood-omen',
        title: 'Blood Omen: Legacy of Kain',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '1421404581' }],
      },
      {
        id: 'gog-doom-plus',
        title: 'DOOM + DOOM II',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '1413291984' }],
      },
    ];

    const catalog = sanitizeGameCatalog(sampleCatalog);

    const agony = catalog.find((g) => g.title.toLowerCase() === 'agony');
    expect(agony).toBeDefined();
    expect(agony!.steamAppId).toBe(487720);

    const agonyUnrated = catalog.find((g) => g.title.toLowerCase() === 'agony unrated');
    expect(agonyUnrated).toBeDefined();
    expect(agonyUnrated!.steamAppId).toBe(879420);

    const bloodOmen = catalog.find((g) => g.title.toLowerCase() === 'blood omen: legacy of kain');
    expect(bloodOmen).toBeDefined();
    expect(bloodOmen!.steamAppId).toBeUndefined();

    const doomPlus = catalog.find((g) => g.title === 'DOOM + DOOM II');
    expect(doomPlus).toBeDefined();
    expect(doomPlus!.steamAppId).toBeUndefined();
  });

  it('algorithmically matches edition variants while safeguarding numbered sequels', async () => {
    const { computeTitleSimilarity } = await import('../src/services/steam/steamMatcher');

    // Single-word and base title to edition variants must match with high similarity (>= 0.90)
    expect(computeTitleSimilarity('DARQ', 'DARQ: Complete Edition')).toBeGreaterThanOrEqual(0.9);
    expect(computeTitleSimilarity('Control', 'Control Ultimate Edition')).toBeGreaterThanOrEqual(0.9);
    expect(computeTitleSimilarity('Death Stranding', "DEATH STRANDING DIRECTOR'S CUT")).toBeGreaterThanOrEqual(0.9);

    // Sequels must never match
    expect(computeTitleSimilarity('The Witcher 2', 'The Witcher 3')).toBe(0);
    expect(computeTitleSimilarity('Doom', 'Doom II')).toBe(0);
    expect(computeTitleSimilarity('Quake', 'Quake 2')).toBe(0);

    // Cycle 4: Disjoint substantive words in multi-word franchise titles must return 0
    expect(
      computeTitleSimilarity(
        'Vampire: The Masquerade - Reckoning of New York',
        'Vampire: The Masquerade - Coteries of New York'
      )
    ).toBe(0);
  });

  it('Cycle 4: filters test branches/content, strips + Official Walkthrough, collapses (Original)/(Classic), and rejects corrupted blurbs', async () => {
    const { isPlaceholderDesc, sanitizeShortDescriptionText } = await import(
      '../src/services/integrations/catalogSanitizer'
    );

    // Non-game test branch & content packs
    expect(
      isNonGameCatalogEntry({
        id: 'gog-1',
        title: 'Galactic Civilizations III (Test branch)',
        platforms: [],
      })
    ).toBe(true);
    expect(
      isNonGameCatalogEntry({
        id: 'epic-1',
        title: 'Death Stranding Content',
        platforms: [],
      })
    ).toBe(true);

    // Placeholder / CJK / publisher copy-paste bleed blurbs
    expect(isPlaceholderDesc('Description is not set', 'Star Wars Jedi Knight: Dark Forces II')).toBe(true);
    expect(
      isPlaceholderDesc(
        '『Warhammer 40,000: Gladius – Relics of War』は、ターン制の4Xストラテジーゲームです。',
        'Warhammer 40,000: Gladius - Relics of War'
      )
    ).toBe(true);
    expect(
      isPlaceholderDesc(
        'Set in the midst of a rebellion against a totalitarian regime, LUNARK is a 2D cinematic platformer.',
        'River City Girls 2'
      )
    ).toBe(true);
    expect(
      sanitizeShortDescriptionText('Collect awesome monsters to use during turn-based battles[/b] in this open-world RPG.')
    ).toBe('Collect awesome monsters to use during turn-based battles in this open-world RPG.');

    // Walkthrough suffix stripping & redundant (Original)/(Classic) edition collapsing
    const rawCatalog: CanonicalGame[] = [
      {
        id: 'gog-leap',
        title: 'Leap of Faith + Official Walkthrough',
        sortTitle: 'Leap of Faith + Official Walkthrough',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '1495134696', installed: true }],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      },
      {
        id: 'gog-quake2-orig',
        title: 'Quake II (Original)',
        sortTitle: 'Quake II (Original)',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '1458058109', installed: true }],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      },
      {
        id: 'gog-quake2',
        title: 'Quake II',
        sortTitle: 'Quake II',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '1432944809', installed: true }],
        headerImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      },
    ];

    const sanitized = sanitizeGameCatalog(rawCatalog, { allowNewPurchases: true });
    expect(sanitized).toHaveLength(3);
    expect(sanitized.find((g) => g.title === 'Leap of Faith')).toBeDefined();
    expect(sanitized.find((g) => g.title === 'Quake II')).toBeDefined();
    expect(sanitized.find((g) => g.title === 'Quake II (Original)')).toBeDefined();
  });

  it('Test A: disambiguates same-storefront original vs remastered/enhanced editions with unique game.id, steamAppId, and titles', () => {
    const rawEditions: CanonicalGame[] = [
      {
        id: 'gog-2022341186',
        title: 'BioShock',
        steamAppId: 7670,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '2022341186', installed: false }],
      },
      {
        id: 'gog-1439656515',
        title: 'BioShock™ Remastered',
        steamAppId: 409710,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '1439656515', installed: true }],
      },
      {
        id: 'epic-9d2d0eb64d5c44529cece33fe2a46482',
        title: 'Grand Theft Auto V',
        steamAppId: 271590,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'epic', platformGameId: '9d2d0eb64d5c44529cece33fe2a46482', installed: false }],
      },
      {
        id: 'epic-8769e24080ea413b8ebca3f1b8c50951',
        title: 'Grand Theft Auto V Enhanced',
        steamAppId: 3240220,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'epic', platformGameId: '8769e24080ea413b8ebca3f1b8c50951', installed: false }],
      },
    ];

    const result = sanitizeGameCatalog(rawEditions);
    expect(result).toHaveLength(4);
    expect(new Set(result.map((g) => g.id)).size).toBe(4);
    expect(new Set(result.map((g) => g.title)).size).toBe(4);

    const bioshockOrig = result.find((g) =>
      g.platforms.some((p) => p.platformId === 'gog' && p.platformGameId === '2022341186')
    );
    const bioshockRem = result.find((g) =>
      g.platforms.some((p) => p.platformId === 'gog' && p.platformGameId === '1439656515')
    );
    expect(bioshockOrig).toBeDefined();
    expect(bioshockRem).toBeDefined();
    expect(bioshockOrig!.id).not.toBe(bioshockRem!.id);
    expect(bioshockOrig!.steamAppId).not.toBe(bioshockRem!.steamAppId);
    expect(bioshockOrig!.title).toBe('BioShock');
    expect(bioshockRem!.title).toBe('BioShock™ Remastered');

    const gtaOrig = result.find((g) =>
      g.platforms.some((p) => p.platformId === 'epic' && p.platformGameId === '9d2d0eb64d5c44529cece33fe2a46482')
    );
    const gtaEnh = result.find((g) =>
      g.platforms.some((p) => p.platformId === 'epic' && p.platformGameId === '8769e24080ea413b8ebca3f1b8c50951')
    );
    expect(gtaOrig).toBeDefined();
    expect(gtaEnh).toBeDefined();
    expect(gtaOrig!.id).not.toBe(gtaEnh!.id);
    expect(gtaOrig!.steamAppId).not.toBe(gtaEnh!.steamAppId);
    expect(gtaOrig!.title).toBe('Grand Theft Auto V');
    expect(gtaEnh!.title).toBe('Grand Theft Auto V Enhanced');
  });

  it('Test B: self-heals already-corrupted catalog state with duplicate game.id and overwritten titles', () => {
    const corrupted: CanonicalGame[] = [
      {
        id: 'steam-409710',
        title: 'BioShock™ Remastered',
        steamAppId: 409710,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '2022341186' }],
      },
      {
        id: 'steam-409710',
        title: 'BioShock™ Remastered',
        steamAppId: 409710,
        isVerifiedEntitlement: true,
        platforms: [
          { platformId: 'gog', platformGameId: '1439656515' },
          { platformId: 'epic', platformGameId: 'bc2c95c6ff564a16b26644f1d3ac3c55' },
        ],
      },
      {
        id: 'steam-3240220',
        title: 'Grand Theft Auto V',
        steamAppId: 3240220,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'epic', platformGameId: '9d2d0eb64d5c44529cece33fe2a46482' }],
      },
      {
        id: 'steam-3240220',
        title: 'Grand Theft Auto V Enhanced',
        steamAppId: 3240220,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'epic', platformGameId: '8769e24080ea413b8ebca3f1b8c50951' }],
      },
    ];

    const result = sanitizeGameCatalog(corrupted);
    expect(result).toHaveLength(4);
    expect(new Set(result.map((g) => g.id)).size).toBe(4);

    const entry1 = result.find((g) =>
      g.platforms.some((p) => p.platformId === 'gog' && p.platformGameId === '2022341186')
    );
    const entry2 = result.find((g) =>
      g.platforms.some((p) => p.platformId === 'gog' && p.platformGameId === '1439656515')
    );
    const entry3 = result.find((g) =>
      g.platforms.some((p) => p.platformId === 'epic' && p.platformGameId === '9d2d0eb64d5c44529cece33fe2a46482')
    );
    const entry4 = result.find((g) =>
      g.platforms.some((p) => p.platformId === 'epic' && p.platformGameId === '8769e24080ea413b8ebca3f1b8c50951')
    );

    expect(entry1).toBeDefined();
    expect(entry1!.title).toBe('BioShock™');
    expect(entry1!.title).not.toMatch(/remastered/i);
    expect(entry1!.id).toBe('gog-2022341186');
    expect(entry1!.steamAppId).toBeUndefined();

    expect(entry2).toBeDefined();
    expect(entry2!.title).toBe('BioShock™ Remastered');
    expect(entry2!.id).toBe('steam-409710');
    expect(entry2!.steamAppId).toBe(409710);

    expect(entry3).toBeDefined();
    expect(entry4).toBeDefined();
    expect(entry3!.id).toBe('epic-9d2d0eb64d5c44529cece33fe2a46482');
    expect(entry3!.steamAppId).toBeUndefined();
    expect(entry4!.id).toBe('steam-3240220');
    expect(entry4!.steamAppId).toBe(3240220);
  });

  it('Test C: steamMatcher.matchGameToSteamInstant guards against cross-matching base titles to Remastered/Enhanced cache entries', async () => {
    const { steamMatcher } = await import('../src/services/steam/steamMatcher');
    const steamEnrichedCache = (await import('../src/services/storage/steamEnrichedCache.json')).default as Record<
      string,
      any
    >;

    const prev409710 = steamEnrichedCache['409710'];
    const prev3240220 = steamEnrichedCache['3240220'];

    try {
      steamEnrichedCache['409710'] = { name: 'BioShock™ Remastered' };
      steamEnrichedCache['3240220'] = { name: 'Grand Theft Auto V Enhanced' };
      steamMatcher.clearCache();

      // Base titles must NOT match Remastered / Enhanced entries in steamEnrichedCache
      expect(steamMatcher.matchGameToSteamInstant('BioShock')).toBeNull();
      expect(steamMatcher.matchGameToSteamInstant('Grand Theft Auto V')).toBeNull();

      // Exact edition titles DO match their respective Remastered / Enhanced entries
      expect(steamMatcher.matchGameToSteamInstant('BioShock™ Remastered')).toBe(409710);
      expect(steamMatcher.matchGameToSteamInstant('Grand Theft Auto V Enhanced')).toBe(3240220);
    } finally {
      if (prev409710 === undefined) {
        delete steamEnrichedCache['409710'];
      } else {
        steamEnrichedCache['409710'] = prev409710;
      }
      if (prev3240220 === undefined) {
        delete steamEnrichedCache['3240220'];
      } else {
        steamEnrichedCache['3240220'] = prev3240220;
      }
      steamMatcher.clearCache();
    }
  });
});


