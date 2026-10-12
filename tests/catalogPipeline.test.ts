import { describe, it, expect } from 'vitest';
import { FULL_USER_STEAM_GAMES } from '../src/services/storage/fullUserSteamGames';
import { GOG_USER_LIBRARY } from '../src/services/storage/gogUserLibrary';
import { EPIC_USER_LIBRARY } from '../src/services/storage/epicUserLibrary';
import { sanitizeGameCatalog } from '../src/services/integrations/catalogSanitizer';
import { mergeStorefrontGames } from '../src/services/integrations/integrationStorage';

describe('Catalog Pipeline & Merging', () => {
  it('raw libraries contain exact verified store counts', () => {
    expect(FULL_USER_STEAM_GAMES).toHaveLength(168);
    expect(GOG_USER_LIBRARY).toHaveLength(314);
    expect(EPIC_USER_LIBRARY).toHaveLength(403);
  });

  it('merging Steam, GOG, and Epic produces exactly 811 unique canonical games', () => {
    let catalog = sanitizeGameCatalog(FULL_USER_STEAM_GAMES);
    expect(catalog).toHaveLength(168);

    catalog = mergeStorefrontGames(catalog, GOG_USER_LIBRARY, 'gog');

    // GOG filter count must be exactly 314
    const gogCountAfterGog = catalog.filter((g) =>
      g.platforms.some((p) => p.platformId === 'gog')
    ).length;
    expect(gogCountAfterGog).toBe(314);

    catalog = mergeStorefrontGames(catalog, EPIC_USER_LIBRARY, 'epic');

    // Total unique games must be exactly 811
    expect(catalog).toHaveLength(811);

    // Platform filter counts
    const steamCount = catalog.filter((g) =>
      g.platforms.some((p) => p.platformId === 'steam')
    ).length;
    const gogCount = catalog.filter((g) =>
      g.platforms.some((p) => p.platformId === 'gog')
    ).length;
    const epicCount = catalog.filter((g) =>
      g.platforms.some((p) => p.platformId === 'epic')
    ).length;

    expect(steamCount).toBe(168);
    expect(gogCount).toBe(314);
    expect(epicCount).toBe(403);
  });

  it('preserves key titles with accurate metadata and SteamAppIDs', () => {
    let catalog = sanitizeGameCatalog(FULL_USER_STEAM_GAMES);
    catalog = mergeStorefrontGames(catalog, GOG_USER_LIBRARY, 'gog');
    catalog = mergeStorefrontGames(catalog, EPIC_USER_LIBRARY, 'epic');

    // Agony & Agony UNRATED
    const agony = catalog.find((g) => g.title.toLowerCase() === 'agony');
    expect(agony).toBeDefined();
    expect(agony!.steamAppId).toBe(487720);
    expect(agony!.capsuleImage).toBeTruthy();

    const agonyUnrated = catalog.find((g) => g.title.toLowerCase() === 'agony unrated');
    expect(agonyUnrated).toBeDefined();
    expect(agonyUnrated!.steamAppId).toBe(879420);
    expect(agonyUnrated!.capsuleImage).toBeTruthy();

    // Prey
    const prey = catalog.find((g) => g.title.toLowerCase() === 'prey');
    expect(prey).toBeDefined();
    expect(prey!.steamAppId).toBe(480490);

    // Deus Ex games
    const dxInvisibleWar = catalog.find((g) =>
      g.title.toLowerCase().includes('invisible war')
    );
    expect(dxInvisibleWar).toBeDefined();
    expect(dxInvisibleWar!.capsuleImage).toBeTruthy();

    const dxHumanRev = catalog.find((g) =>
      g.title.toLowerCase().includes('human revolution')
    );
    expect(dxHumanRev).toBeDefined();
    expect(dxHumanRev!.capsuleImage).toBeTruthy();
    expect(dxHumanRev!.shortDescription).toBeTruthy();

    // Blood Omen: Legacy of Kain (GOG title, should not have false SteamAppId)
    const bloodOmen = catalog.find(
      (g) => g.title.toLowerCase() === 'blood omen: legacy of Kain'.toLowerCase()
    );
    expect(bloodOmen).toBeDefined();
    expect(bloodOmen!.steamAppId).toBeUndefined();

    // DOOM + DOOM II
    const doomPlus = catalog.find((g) => g.title === 'DOOM + DOOM II');
    expect(doomPlus).toBeDefined();
    expect(doomPlus!.steamAppId).toBeUndefined();

    // Citadel Remonstered (verified English IGDB cover)
    const citadel = catalog.find((g) => g.title.toLowerCase() === 'citadel remonstered');
    expect(citadel).toBeDefined();
    expect(citadel!.capsuleImage).toBe(
      'https://images.igdb.com/igdb/image/upload/t_cover_big/coc0q5.webp'
    );
    expect(citadel!.iconUrl).toBe(
      'https://images.igdb.com/igdb/image/upload/t_cover_big/coc0q5.webp'
    );

    // Wildgate (verified vertical IGDB cover)
    const wildgate = catalog.find((g) => g.title.toLowerCase() === 'wildgate');
    expect(wildgate).toBeDefined();
    expect(wildgate!.capsuleImage).toBe(
      'https://images.igdb.com/igdb/image/upload/t_cover_big/co9kqs.jpg'
    );
  });

  it('audits covers across all 811 games for unsuitable or non-standard URLs', () => {
    let catalog = sanitizeGameCatalog(FULL_USER_STEAM_GAMES);
    catalog = mergeStorefrontGames(catalog, GOG_USER_LIBRARY, 'gog');
    catalog = mergeStorefrontGames(catalog, EPIC_USER_LIBRARY, 'epic');

    // Verify Citadel Remonstered has no foreign Wikimedia box art
    const citadel = catalog.find((g) => g.title.toLowerCase() === 'citadel remonstered');
    expect(citadel?.capsuleImage).not.toContain('Cytadela_cover.jpg');
    expect(citadel?.capsuleImage).toBe(
      'https://images.igdb.com/igdb/image/upload/t_cover_big/coc0q5.webp'
    );

    // Verify zero games in the entire 811 catalog use Wikimedia or Wikipedia covers
    const wikimediaGames = catalog.filter(
      (g) => g.capsuleImage?.includes('wikipedia') || g.capsuleImage?.includes('wikimedia')
    );
    expect(wikimediaGames).toHaveLength(0);
  });

  it('rigorously verifies the 7 games reported by the user and prevents regressions', () => {
    let catalog = sanitizeGameCatalog(FULL_USER_STEAM_GAMES);
    catalog = mergeStorefrontGames(catalog, GOG_USER_LIBRARY, 'gog');
    catalog = mergeStorefrontGames(catalog, EPIC_USER_LIBRARY, 'epic');

    // 1. Deus Ex: Game of the Year Edition
    const deusEx = catalog.find((g) => g.title.toLowerCase().includes('deus ex') && g.title.toLowerCase().includes('goty'));
    expect(deusEx).toBeDefined();
    expect(deusEx?.steamAppId).toBe(6910);
    expect(deusEx?.capsuleImage).toBe(
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/6910/library_600x900_2x.jpg'
    );
    expect(deusEx?.capsuleImage).not.toContain('_glx_vertical_cover.jpg');

    // 2. Eschalon: Book I
    const eschalon = catalog.find((g) => g.title.toLowerCase().includes('eschalon: book i'));
    expect(eschalon).toBeDefined();
    expect(eschalon?.capsuleImage).toBe(
      'https://images.igdb.com/igdb/image/upload/t_cover_big/co214q.webp'
    );

    // 3. Fallout: London
    const falloutLondon = catalog.find((g) => g.title.toLowerCase().includes('fallout: london'));
    expect(falloutLondon).toBeDefined();
    expect(falloutLondon?.capsuleImage).toBe(
      'https://images.gog-statics.com/b9a00e7d9a9d8cb5d17ec67aa41dc8d392358e0340d679f855fa113c444c11ee.jpg'
    );
    expect(falloutLondon?.capsuleImage).not.toContain('co8j9u'); // Must not be Dicey Demons!

    // 4. GRIP: Combat Racing
    const grip = catalog.find((g) => g.title === 'GRIP');
    expect(grip).toBeDefined();
    expect(grip?.steamAppId).toBe(396900);
    expect(grip?.capsuleImage).toBe(
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/396900/library_600x900_2x.jpg'
    );
    expect(grip?.shortDescription).toContain('combat racer');
    expect(grip?.shortDescription).not.toContain('DLCs included');

    // 5. Resident Evil Requiem
    const reRequiem = catalog.find((g) => g.title.toLowerCase().includes('resident evil requiem'));
    expect(reRequiem).toBeDefined();
    expect(reRequiem?.steamAppId).toBe(3764200);
    expect(reRequiem?.capsuleImage).toBe(
      'https://images.igdb.com/igdb/image/upload/t_cover_big/cobmj0.jpg'
    );

    // 6. Summer's Gone: Season 1
    const summersGone = catalog.find((g) => g.title.toLowerCase().includes("summer's gone"));
    expect(summersGone).toBeDefined();
    expect(summersGone?.capsuleImage).toBe(
      'https://images.gog-statics.com/754d59c26ea2a81d688ef36948f9a53aa036154f42c21ea3aa3a2bcc71e1b097.jpg'
    );
    expect(summersGone?.capsuleImage).not.toContain('_glx_vertical_cover.jpg');

    // 7. Tomb Raider GOTY
    const tombRaiderGoty = catalog.find((g) => g.title === 'Tomb Raider GOTY');
    expect(tombRaiderGoty).toBeDefined();
    expect(tombRaiderGoty?.capsuleImage).toBe(
      'https://images.gog-statics.com/754dd55607aecdc8a2989a9e4a280d0caa3875fe88c1974ba6e10dd1b9a3b1d6.jpg'
    );
    expect(tombRaiderGoty?.capsuleImage).not.toContain('_glx_vertical_cover.jpg');

    // Global integrity: ensure zero games use Dicey Demons (co8j9u)
    const diceyDemonsGames = catalog.filter((g) => g.capsuleImage?.includes('co8j9u'));
    expect(diceyDemonsGames).toHaveLength(0);

    // 8. DARQ / DARQ: Complete Edition (Epic library matching Steam 433550)
    const darq = catalog.find((g) => g.title.toLowerCase().startsWith('darq'));
    expect(darq).toBeDefined();
    expect(darq?.steamAppId).toBe(433550);
    expect(darq?.title).toBe('DARQ: Complete Edition');
    expect(darq?.capsuleImage).toBe(
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/433550/library_600x900_2x.jpg'
    );
    expect(darq?.shortDescription).toContain('Lloyd');
    expect(darq?.shortDescription).toContain('lucid nightmare');
    expect(darq?.developers).toContain('Unfold Games');
    expect(darq?.genres).toContain('Adventure');
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
  });
});
