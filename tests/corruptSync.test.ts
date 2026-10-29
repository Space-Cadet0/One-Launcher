import { describe, it, expect, vi } from 'vitest';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { CanonicalGame } from '../src/contracts/game';
import { sanitizeGameCatalog } from '../src/services/integrations/catalogSanitizer';
import { epicIntegration } from '../src/services/integrations/epicIntegration';
import { makeCanonicalGame } from './helpers/factories';

describe('Corrupt Sync Recovery & DLC Purging', () => {
  it('purges SDK/redistributable AppIDs, mock entries, and stale codename/beta injections', () => {
    const validGames: CanonicalGame[] = [
      makeCanonicalGame({
        id: 'steam-1145360',
        title: 'Hades',
        steamAppId: 1145360,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '1145360' }],
      }),
      makeCanonicalGame({
        id: 'gog-1207658924',
        title: 'Blood Omen: Legacy of Kain',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '1207658924' }],
      }),
    ];

    const corruptInjections: CanonicalGame[] = [
      makeCanonicalGame({
        id: 'mock-hades',
        title: 'Hades',
        steamAppId: 1145360,
        platforms: [{ platformId: 'epic', platformGameId: 'epic-hades' }],
      }),
      makeCanonicalGame({
        id: 'epic-hazlenut',
        title: 'Hazlenut',
        platforms: [{ platformId: 'epic', platformGameId: 'Hazelnut' }],
      }),
      makeCanonicalGame({
        id: 'epic-herring',
        title: 'Herring',
        platforms: [{ platformId: 'epic', platformGameId: 'Herring' }],
      }),
      makeCanonicalGame({
        id: 'gog-anno-1404',
        title: 'Anno 1404: Gold Edition',
        platforms: [{ platformId: 'gog', platformGameId: 'unowned-anno' }],
      }),
      makeCanonicalGame({
        id: 'steam-480',
        title: 'Spacewar',
        steamAppId: 480,
        platforms: [{ platformId: 'steam', platformGameId: '480' }],
      }),
      makeCanonicalGame({
        id: 'steam-228980',
        title: 'Steamworks Common Redistributables',
        steamAppId: 228980,
        platforms: [{ platformId: 'steam', platformGameId: '228980' }],
      }),
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

  it('correctly cleans raw Epic records, DLCs, UE tools, Live/hex hashes, and unmapped codenames', async () => {
    const rawRecordsPath = path.resolve(__dirname, './fixtures/syntheticEpicRecords.json');
    expect(fs.existsSync(rawRecordsPath)).toBe(true);

    const rawRecords = JSON.parse(fs.readFileSync(rawRecordsPath, 'utf-8'));
    expect(rawRecords).toHaveLength(15);

    // 1. Test sanitizeGameCatalog against corrupted cached entries derived from raw records
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
      ...rawRecords.map((r: { catalogItemId?: string; appName?: string; metadata?: { title?: string; categories?: Array<{ path?: string }>; mainGameItem?: { id: string; title: string } }; sandboxName?: string; recordType?: string }) => ({
        id: 'epic-' + (r.catalogItemId || r.appName),
        title: (r.metadata?.title || r.sandboxName || '').trim(),
        isVerifiedEntitlement: r.recordType === 'APPLICATION' && Boolean(r.metadata?.categories?.some((c) => c.path === 'games')),
        platforms: [{ platformId: 'epic' as const, platformGameId: String(r.catalogItemId || r.appName || '') }],
      })),
    ];

    const sanitized = sanitizeGameCatalog(corruptCachedGames);

    // Verify raw codenames, UE engine tools, and hex hashes are purged by sanitizeGameCatalog
    const badNames = [
      'cobaltfalcon',
      'crimsonharbor',
      'obsidianspire',
      'amberquasar',
      'silvervortex',
      'verdantecho',
      'quartzcipher',
      'onyxmirage',
      '0123456789abcdef0123456789abcdef',
      'unreal engine 5.4',
    ];
    for (const bad of badNames) {
      const found = sanitized.filter((g) => g.title.toLowerCase() === bad);
      expect(found).toHaveLength(0);
    }

    // Verify verified standalone synthetic games survive cleanly
    expect(sanitized.some((g) => g.title === 'Control')).toBe(true);
    expect(sanitized.some((g) => g.title === 'Celeste')).toBe(true);

    // 2. Verify epicIntegration.fetchOwnedGames filters DLCs (mainGameItem), UE namespace, PRIVATE Live/hex sandboxes, and codenames
    const getSpy = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.includes('/library/api/public/items')) {
        return { status: 200, data: { records: rawRecords, responseMetadata: {} } };
      }
      return { status: 200, data: {} };
    });
    try {
      const synced = await epicIntegration.fetchOwnedGames('synthetic-epic-token');
      expect(synced.map((g) => g.title)).toEqual(expect.arrayContaining(['Control', 'Celeste']));
      expect(synced.some((g) => g.title.includes('Foundation') || g.title.includes('Deluxe Upgrade'))).toBe(false);
      expect(synced.some((g) => g.title.toLowerCase() === 'live')).toBe(false);
      expect(synced.some((g) => g.title.toLowerCase().includes('unreal engine'))).toBe(false);
    } finally {
      getSpy.mockRestore();
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
