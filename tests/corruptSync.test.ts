import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CanonicalGame } from '../src/contracts/game';
import { sanitizeGameCatalog } from '../src/services/integrations/catalogSanitizer';

describe('Corrupt Sync Recovery & DLC Purging', () => {
  it('purges SDK/redistributable AppIDs, mock entries, and stale codename/beta injections', () => {
    const validGames: CanonicalGame[] = [
      {
        id: 'steam-1145360',
        title: 'Hades',
        steamAppId: 1145360,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '1145360' }],
      },
      {
        id: 'gog-1207658924',
        title: 'Blood Omen: Legacy of Kain',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '1207658924' }],
      },
    ];

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
        id: 'steam-480',
        title: 'Spacewar',
        steamAppId: 480,
        platforms: [{ platformId: 'steam', platformGameId: '480' }],
      },
      {
        id: 'steam-228980',
        title: 'Steamworks Common Redistributables',
        steamAppId: 228980,
        platforms: [{ platformId: 'steam', platformGameId: '228980' }],
      },
    ];

    const cleaned = sanitizeGameCatalog([...validGames, ...corruptInjections]);

    // Check that SDK / redistributable AppIDs are purged
    expect(cleaned.some((g) => g.steamAppId === 480)).toBe(false);
    expect(cleaned.some((g) => g.steamAppId === 228980)).toBe(false);

    // Check that corrupt/fake codename titles are purged
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

    expect(cleaned).toHaveLength(2);
  });

  it('correctly cleans raw Epic records, hex hashes, and unmapped codenames', () => {
    const rawRecordsPath = path.resolve(__dirname, '../scripts/epic_raw_records.json');
    if (!fs.existsSync(rawRecordsPath)) return;

    const rawRecords = JSON.parse(fs.readFileSync(rawRecordsPath, 'utf-8'));

    const corruptCachedGames: CanonicalGame[] = [
      {
        id: 'gog-blood-omen',
        title: 'Blood Omen: Legacy of Kain',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '1207658924' }],
      },
      {
        id: 'gog-doom-combo',
        title: 'DOOM + DOOM II',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '1413291984' }],
      },
      ...rawRecords.map((r: any) => ({
        id: 'epic-' + (r.catalogItemId || r.appName),
        title: (r.metadata?.title || r.sandboxName || '').trim(),
        platforms: [{ platformId: 'epic', platformGameId: r.catalogItemId || r.appName }],
      })),
    ];

    const sanitized = sanitizeGameCatalog(corruptCachedGames);

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
  });
});
