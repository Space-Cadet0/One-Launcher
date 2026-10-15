import { describe, it, expect } from 'vitest';
import {
  computeEntityMatchConfidence,
  parseReleaseYear,
} from '../src/services/common/entityResolver';
import { sanitizeGameCatalog } from '../src/services/integrations/catalogSanitizer';
import { mergeStorefrontGames } from '../src/services/integrations/integrationStorage';
import { FULL_USER_STEAM_GAMES } from '../src/services/storage/fullUserSteamGames';
import { GOG_USER_LIBRARY } from '../src/services/storage/gogUserLibrary';
import { EPIC_USER_LIBRARY } from '../src/services/storage/epicUserLibrary';
import { CanonicalGame } from '../src/contracts/game';

describe('Multi-Vector Entity Resolution (entityResolver)', () => {
  it('accurately parses 4-digit release years from numbers, ISO dates, and parenthetical strings', () => {
    expect(parseReleaseYear(2017)).toBe(2017);
    expect(parseReleaseYear('2017-05-05')).toBe(2017);
    expect(parseReleaseYear('10 Dec, 1993')).toBe(1993);
    expect(parseReleaseYear('Prey (2006)')).toBe(2006);
    expect(parseReleaseYear('TBA')).toBeNull();
    expect(parseReleaseYear(null)).toBeNull();
  });

  it('prevents same-name reboot collisions across decades while accepting matching release years', () => {
    // 1. Prey (2006, Human Head Studios) vs Prey (2017, Arkane Studios)
    const preyCollision = computeEntityMatchConfidence(
      { title: 'Prey', releaseYear: 2006, developers: ['Human Head Studios'] },
      { title: 'Prey', releaseYear: 2017, developers: ['Arkane Studios'] }
    );
    expect(preyCollision.isRebootCollision).toBe(true);
    expect(preyCollision.isAccepted).toBe(false);
    expect(preyCollision.yearAdjustment).toBeLessThanOrEqual(-35);

    const preyMatch2017 = computeEntityMatchConfidence(
      { title: 'Prey', releaseYear: '2017-05-05', developers: ['Arkane Studios'] },
      { title: 'Prey', releaseYear: 2017, developers: ['Arkane Studios LLC'] }
    );
    expect(preyMatch2017.isRebootCollision).toBe(false);
    expect(preyMatch2017.isAccepted).toBe(true);
    expect(preyMatch2017.yearAdjustment).toBeGreaterThan(0);
    expect(preyMatch2017.developerBonus).toBeGreaterThan(0);
    expect(preyMatch2017.confidence).toBe(100);

    // 2. DOOM (1993) vs DOOM (2016)
    const doomCollision = computeEntityMatchConfidence(
      { title: 'DOOM (1993)', releaseYear: 1993 },
      { title: 'DOOM', releaseYear: 2016 }
    );
    expect(doomCollision.isRebootCollision).toBe(true);
    expect(doomCollision.isAccepted).toBe(false);

    const doom2016Match = computeEntityMatchConfidence(
      { title: 'DOOM (2016)' },
      { title: 'DOOM', releaseYear: 2016 }
    );
    expect(doom2016Match.isRebootCollision).toBe(false);
    expect(doom2016Match.isAccepted).toBe(true);
    expect(doom2016Match.confidence).toBe(100);

    // 3. Tomb Raider (1996, Core Design) vs Tomb Raider (2013, Crystal Dynamics)
    const trCollision = computeEntityMatchConfidence(
      { title: 'Tomb Raider', releaseYear: 1996, developers: ['Core Design'] },
      { title: 'Tomb Raider', releaseYear: 2013, developers: ['Crystal Dynamics'] }
    );
    expect(trCollision.isRebootCollision).toBe(true);
    expect(trCollision.isAccepted).toBe(false);

    // 4. Star Wars Battlefront II (2005, Pandemic Studios) vs Star Wars Battlefront II (2017, DICE)
    const swbfCollision = computeEntityMatchConfidence(
      { title: 'Star Wars Battlefront II', releaseYear: 2005, developers: ['Pandemic Studios'] },
      { title: 'STAR WARS™ Battlefront™ II', releaseYear: 2017, developers: ['EA DICE'] }
    );
    expect(swbfCollision.isRebootCollision).toBe(true);
    expect(swbfCollision.isAccepted).toBe(false);
  });

  it('allows legitimate remastered and definitive editions across years without false reboot collision', () => {
    const quakeRemaster = computeEntityMatchConfidence(
      { title: 'Quake', releaseYear: 1996, developers: ['id Software'] },
      { title: 'Quake Remastered', releaseYear: 2021, developers: ['id Software', 'Nightdive Studios'] }
    );
    expect(quakeRemaster.isRebootCollision).toBe(false);
    expect(quakeRemaster.isAccepted).toBe(true);
    expect(quakeRemaster.developerBonus).toBe(12);
    expect(quakeRemaster.confidence).toBeGreaterThanOrEqual(90);
  });

  it('strictly rejects numbered sequel mismatches immediately with 0 confidence', () => {
    expect(
      computeEntityMatchConfidence({ title: 'Doom' }, { title: 'Doom II' }).confidence
    ).toBe(0);
    expect(
      computeEntityMatchConfidence({ title: 'The Witcher 2' }, { title: 'The Witcher 3' }).confidence
    ).toBe(0);
    expect(
      computeEntityMatchConfidence({ title: 'Subnautica' }, { title: 'Subnautica: Below Zero' }).isAccepted
    ).toBe(false);
    expect(
      computeEntityMatchConfidence({ title: 'Risk of Rain' }, { title: 'Risk of Rain 2' }).confidence
    ).toBe(0);
  });

  it('flags borderline confidence matches (55 <= confidence < 80) with needsMatchReview = true', () => {
    // 5 shared tokens out of 7 union tokens -> Jaccard = 5/7 = 0.714 (titleScore = 71) -> 55 <= 71 < 80
    const borderline = computeEntityMatchConfidence(
      { title: 'Warhammer 40000 Dawn of War Crusade' },
      { title: 'Warhammer 40000 Dawn of War Winter' }
    );
    expect(borderline.confidence).toBe(71);
    expect(borderline.isAccepted).toBe(true);
    expect(borderline.needsMatchReview).toBe(true);
  });

  it('rejects 1-word article hijacks (Agony vs The Agony) and unnumbered multi-word subtitle hijacks (Broken Sword vs Broken Sword - Parzivals Stone)', () => {
    const agonyHijack = computeEntityMatchConfidence(
      { title: 'Agony' },
      { title: 'The Agony' }
    );
    expect(agonyHijack.isAccepted).toBe(false);
    expect(agonyHijack.confidence).toBeLessThan(68);

    const brokenSwordHijack = computeEntityMatchConfidence(
      { title: 'Broken Sword' },
      { title: "Broken Sword - Parzival's Stone" }
    );
    expect(brokenSwordHijack.isAccepted).toBe(false);
    expect(brokenSwordHijack.confidence).toBeLessThan(68);

    const ascendantHijack = computeEntityMatchConfidence(
      { title: 'Ascendant' },
      { title: 'Ascendant Hearts' }
    );
    expect(ascendantHijack.isAccepted).toBe(false);
    expect(ascendantHijack.confidence).toBeLessThan(68);
  });
});

describe('Catalog Ingestion Liberation for Newly Purchased & Installed Games', () => {
  it('preserves newly purchased Steam, GOG, and Epic games with isVerifiedEntitlement: true or installed: true', () => {
    let baseCatalog = sanitizeGameCatalog(FULL_USER_STEAM_GAMES);
    baseCatalog = mergeStorefrontGames(baseCatalog, GOG_USER_LIBRARY, 'gog');
    baseCatalog = mergeStorefrontGames(baseCatalog, EPIC_USER_LIBRARY, 'epic');
    const initialCount = baseCatalog.length;

    const newSteamPurchase: CanonicalGame = {
      id: 'steam-1145350',
      title: 'Hades II',
      sortTitle: 'Hades II',
      steamAppId: 1145350,
      isVerifiedEntitlement: true,
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '1145350',
          installed: false,
          playtimeMinutes: 45,
        },
      ],
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1145350/header.jpg',
      capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1145350/library_600x900_2x.jpg',
      developers: ['Supergiant Games'],
      publishers: ['Supergiant Games'],
      genres: ['Action', 'Roguelike'],
      tags: ['Mythology'],
    };

    const newGogPurchase: CanonicalGame = {
      id: 'gog-1999999999',
      title: 'Factorio: Space Age',
      sortTitle: 'Factorio: Space Age',
      isVerifiedEntitlement: true,
      platforms: [
        {
          platformId: 'gog',
          platformGameId: '1999999999',
          installed: false,
        },
      ],
      headerImage: 'https://images.gog-statics.com/avatars/default.png',
      developers: ['Wube Software'],
      publishers: ['Wube Software'],
      genres: ['Strategy'],
      tags: ['GOG'],
    };

    const newEpicInstalledGame: CanonicalGame = {
      id: 'epic-star-trucker',
      title: 'Star Trucker',
      sortTitle: 'Star Trucker',
      platforms: [
        {
          platformId: 'epic',
          platformGameId: 'star-trucker-app',
          installed: true,
          installPath: '/Users/Shared/Epic Games/StarTrucker',
        },
      ],
      headerImage: 'https://cdn2.unrealengine.com/egs-badge.png',
      developers: ['Monster and Monster'],
      publishers: ['Raw Fury'],
      genres: ['Simulation'],
      tags: ['Epic Games Store'],
    };

    let updated = mergeStorefrontGames(baseCatalog, [newSteamPurchase], 'steam');
    updated = mergeStorefrontGames(updated, [newGogPurchase], 'gog');
    updated = mergeStorefrontGames(updated, [newEpicInstalledGame], 'epic');

    expect(updated).toHaveLength(initialCount + 3);

    const hades2 = updated.find((g) => g.title === 'Hades II');
    expect(hades2).toBeDefined();
    expect(hades2?.steamAppId).toBe(1145350);
    expect(hades2?.isVerifiedEntitlement).toBe(true);
    expect(hades2?.platforms.some((p) => p.platformId === 'steam')).toBe(true);

    const factorio = updated.find((g) => g.title === 'Factorio: Space Age');
    expect(factorio).toBeDefined();
    expect(factorio?.isVerifiedEntitlement).toBe(true);
    expect(factorio?.platforms.some((p) => p.platformId === 'gog')).toBe(true);

    const starTrucker = updated.find((g) => g.title === 'Star Trucker');
    expect(starTrucker).toBeDefined();
    expect(starTrucker?.platforms.some((p) => p.platformId === 'epic' && p.installed === true)).toBe(true);
  });

  it('still rejects non-game redistributables and raw hex hashes even if allowNewPurchases or isVerifiedEntitlement is set', () => {
    const nonGameRedist: CanonicalGame = {
      id: 'steam-228980',
      title: 'Steamworks Common Redistributables',
      sortTitle: 'Steamworks Common Redistributables',
      steamAppId: 228980,
      isVerifiedEntitlement: true,
      platforms: [{ platformId: 'steam', platformGameId: '228980', installed: false }],
      headerImage: '',
      developers: [],
      publishers: [],
      genres: [],
      tags: [],
    };

    const cleaned = sanitizeGameCatalog([nonGameRedist], { allowNewPurchases: true });
    expect(cleaned).toHaveLength(0);
  });

  it('strips cached phantom Steam platform entries on non-Steam games while preserving steamAppId and folding playtime', () => {
    const epicGameWithPhantomSteam: CanonicalGame = {
      id: 'steam-1966900',
      title: '20 Minutes Till Dawn',
      sortTitle: '20 Minutes Till Dawn',
      steamAppId: 1966900,
      platforms: [
        {
          platformId: 'epic',
          platformGameId: 'd9d5bf08f174402a8d1a002b2f52a08b',
          playtimeMinutes: 17,
          installed: true,
        },
        {
          platformId: 'steam',
          platformGameId: '1966900',
          playtimeMinutes: 2,
          installed: true,
          installPath: '/Users/test/Games/OneLauncher/Epic/20MinutesTillDawn',
        },
      ],
      headerImage:
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1966900/header.jpg',
      developers: ['flanne'],
      publishers: ['Erabit'],
      genres: ['Action', 'Indie'],
      tags: ['Action Roguelike'],
    };

    const cleaned = sanitizeGameCatalog([epicGameWithPhantomSteam], {
      allowNewPurchases: true,
      validSteamAppIds: new Set([400]),
    } as any);

    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].steamAppId).toBe(1966900);
    expect(cleaned[0].platforms).toHaveLength(1);
    expect(cleaned[0].platforms[0].platformId).toBe('epic');
    expect(cleaned[0].platforms[0].platformGameId).toBe('d9d5bf08f174402a8d1a002b2f52a08b');
    expect(cleaned[0].platforms[0].playtimeMinutes).toBe(19);
  });
});

