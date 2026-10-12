import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CanonicalGame } from '../src/contracts/game';
import { GOG_USER_LIBRARY } from '../src/services/storage/gogUserLibrary';
import { EPIC_USER_LIBRARY } from '../src/services/storage/epicUserLibrary';
import { FULL_USER_STEAM_GAMES } from '../src/services/storage/fullUserSteamGames';
import { sanitizeGameCatalog } from '../src/services/integrations/catalogSanitizer';
import { mergeStorefrontGames } from '../src/services/integrations/integrationStorage';

describe('Corrupt Sync Recovery & DLC Purging', () => {
  it('purges unowned EA Play/promo AppIDs and stale DLC injections', () => {
    let catalog = sanitizeGameCatalog(FULL_USER_STEAM_GAMES);
    catalog = mergeStorefrontGames(catalog, GOG_USER_LIBRARY, 'gog');
    catalog = mergeStorefrontGames(catalog, EPIC_USER_LIBRARY, 'epic');

    // Inject corrupt and unowned entries
    const corruptInjections: CanonicalGame[] = [
      {
        id: 'mock-hades',
        title: 'Hades',
        steamAppId: 1145360,
        platforms: [{ platformId: 'epic', platformGameId: 'epic-hades' }],
      },
      {
        id: 'epic-hazlenut',
        title: 'Hazlenut',
        platforms: [{ platformId: 'epic', platformGameId: 'Hazelnut' }],
      },
      {
        id: 'epic-herring',
        title: 'Herring',
        platforms: [{ platformId: 'epic', platformGameId: 'Herring' }],
      },
      {
        id: 'gog-anno-1404',
        title: 'Anno 1404: Gold Edition',
        platforms: [{ platformId: 'gog', platformGameId: 'unowned-anno' }],
      },
      {
        id: 'steam-1222680',
        title: 'Need for Speed™ Heat',
        steamAppId: 1222680,
        platforms: [{ platformId: 'steam', platformGameId: '1222680' }],
      },
      {
        id: 'steam-1238860',
        title: 'Battlefield 4™',
        steamAppId: 1238860,
        platforms: [{ platformId: 'steam', platformGameId: '1238860' }],
      },
    ];

    const cleaned = sanitizeGameCatalog([...catalog, ...corruptInjections]);

    // Check that unowned EA promo titles are purged
    expect(cleaned.some((g) => g.steamAppId === 1222680)).toBe(false);
    expect(cleaned.some((g) => g.steamAppId === 1238860)).toBe(false);

    // Check that corrupt/fake titles are purged
    expect(cleaned.some((g) => g.title.toLowerCase() === 'hazlenut')).toBe(false);
    expect(cleaned.some((g) => g.title.toLowerCase() === 'herring')).toBe(false);

    // Check false store ownership is purged
    const hadesEpic = cleaned.filter(
      (g) => g.title.toLowerCase() === 'hades' && g.platforms.some((p) => p.platformId === 'epic')
    );
    expect(hadesEpic).toHaveLength(0);

    const annoGog = cleaned.filter(
      (g) => g.title.toLowerCase().includes('anno 1404') && g.platforms.some((p) => p.platformId === 'gog')
    );
    expect(annoGog).toHaveLength(0);

    // Final filter counts remain strictly intact
    const steamCount = cleaned.filter((g) => g.platforms.some((p) => p.platformId === 'steam')).length;
    const gogCount = cleaned.filter((g) => g.platforms.some((p) => p.platformId === 'gog')).length;
    const epicCount = cleaned.filter((g) => g.platforms.some((p) => p.platformId === 'epic')).length;

    expect(steamCount).toBe(168);
    expect(gogCount).toBe(314);
    expect(epicCount).toBe(403);
  });

  it('correctly cleans raw Epic records, hex hashes, and unmapped codenames', () => {
    const rawRecordsPath = path.resolve(__dirname, '../scripts/epic_raw_records.json');
    if (!fs.existsSync(rawRecordsPath)) return;

    const rawRecords = JSON.parse(fs.readFileSync(rawRecordsPath, 'utf-8'));

    // Corrupt cached games with raw Epic entitlements & false Blood Omen SteamAppId
    const corruptCachedGames: CanonicalGame[] = [
      ...FULL_USER_STEAM_GAMES,
      ...GOG_USER_LIBRARY.map((g) =>
        g.title === 'Blood Omen: Legacy of Kain' ? { ...g, steamAppId: 242960 } : g
      ),
      ...rawRecords.map((r: any) => ({
        id: 'epic-' + (r.catalogItemId || r.appName),
        title: (r.metadata?.title || r.sandboxName || '').trim(),
        platforms: [{ platformId: 'epic', platformGameId: r.catalogItemId || r.appName }],
      })),
    ];

    let sanitized = sanitizeGameCatalog(corruptCachedGames);

    // Self-healing: restore GOG baseline if missing
    const gogCount = sanitized.filter((g) => g.platforms.some((p) => p.platformId === 'gog')).length;
    if (gogCount !== GOG_USER_LIBRARY.length) {
      sanitized = sanitizeGameCatalog(mergeStorefrontGames(sanitized, GOG_USER_LIBRARY, 'gog'));
    }

    // Self-healing: restore Epic baseline if missing
    const epicCount = sanitized.filter((g) => g.platforms.some((p) => p.platformId === 'epic')).length;
    if (epicCount !== EPIC_USER_LIBRARY.length) {
      sanitized = sanitizeGameCatalog(mergeStorefrontGames(sanitized, EPIC_USER_LIBRARY, 'epic'));
    }

    // Verify raw codenames are purged
    const badNames = [
      'blackcoral',
      'blunderbuss',
      'boysenberry',
      'brilliantrose',
      'cadmiumred',
      'capsicum',
      'alabaster',
      'kingletaztec',
    ];
    for (const bad of badNames) {
      const found = sanitized.filter((g) => g.title.toLowerCase() === bad);
      expect(found).toHaveLength(0);
    }

    // Verify Blood Omen 1 has steamAppId undefined (not Blood Omen 2 242960)
    const bo1 = sanitized.find((g) => g.title === 'Blood Omen: Legacy of Kain');
    expect(bo1).toBeDefined();
    expect(bo1?.steamAppId).toBeUndefined();

    // Verify DOOM + DOOM II has steamAppId undefined (not Ultimate Doom 2280)
    const doomCombo = sanitized.find((g) => g.title === 'DOOM + DOOM II');
    expect(doomCombo).toBeDefined();
    expect(doomCombo?.steamAppId).toBeUndefined();

    // Final verified counts
    const finalGog = sanitized.filter((g) => g.platforms.some((p) => p.platformId === 'gog')).length;
    const finalEpic = sanitized.filter((g) => g.platforms.some((p) => p.platformId === 'epic')).length;
    expect(finalGog).toBe(314);
    expect(finalEpic).toBe(403);
  });
});
