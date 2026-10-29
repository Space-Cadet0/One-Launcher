import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { CanonicalGame } from '../src/contracts/game';
import { makeCanonicalGame } from './helpers/factories';
import {
  mergeStorefrontGames,
  saveCurrentCatalog,
  loadCurrentCatalog,
  removeStorefrontGames,
  getVerifiedUserEntitlements,
  clearVerifiedUserEntitlements,
} from '../src/services/integrations/integrationStorage';
import {
  sanitizeGameCatalog,
  normalizeCanonicalTitle,
  isUnmappedEpicInternalCodename,
} from '../src/services/integrations/catalogSanitizer';
import { UNMAPPED_EPIC_INTERNAL_CODENAMES } from '../src/services/integrations/epicCodenames';
import { isUnsuitableHeaderUrl } from '../src/services/igdb/igdbCoverService';

const require = createRequire(import.meta.url);
const launcherEngine = require('../electron/launcherEngine.cjs');

const store = new Map<string, string>();
const mockStorage: Storage = {
  get length() {
    return store.size;
  },
  clear: () => store.clear(),
  getItem: (k: string) => store.get(k) ?? null,
  key: (index: number) => Array.from(store.keys())[index] ?? null,
  removeItem: (k: string) => {
    store.delete(k);
  },
  setItem: (k: string, v: string) => {
    store.set(k, String(v));
  },
};

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: mockStorage,
    writable: true,
  });
}

if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = {
    localStorage: globalThis.localStorage,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
} else if (!(globalThis as any).window.localStorage) {
  (globalThis as any).window.localStorage = globalThis.localStorage;
}

describe('Stage C: Universal Portability, Fresh-Install Survival & De-Hackification Suite', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
    clearVerifiedUserEntitlements();
  });

  it('Test 1: Brand-New User Multi-Storefront Sync, Persistence & App Restart Survival', () => {
    // Simulate a brand-new user with completely distinct Steam, GOG, and Epic libraries
    // owning titles not present in any static snapshot
    const steamGames: CanonicalGame[] = [
      makeCanonicalGame({
        id: 'steam-999001',
        title: 'Starlight Odyssey',
        steamAppId: 999001,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '999001', installed: false, playtimeMinutes: 120 }],
      }),
      makeCanonicalGame({
        id: 'steam-999002',
        title: 'Cyber Chrono',
        steamAppId: 999002,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '999002', installed: false, playtimeMinutes: 45 }],
      }),
    ];

    const gogGames: CanonicalGame[] = [
      makeCanonicalGame({
        id: 'gog-888001',
        title: 'Starlight Odyssey',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '888001', installed: true, playtimeMinutes: 30 }],
      }),
      makeCanonicalGame({
        id: 'gog-888002',
        title: 'Dungeon Weaver',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '888002', installed: false, playtimeMinutes: 0 }],
      }),
    ];

    const epicGames: CanonicalGame[] = [
      makeCanonicalGame({
        id: 'epic-777001',
        title: 'Cyber Chrono',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'epic', platformGameId: '777001', installed: false, playtimeMinutes: 15 }],
      }),
      makeCanonicalGame({
        id: 'epic-777002',
        title: 'Aether Drift',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'epic', platformGameId: '777002', installed: true, playtimeMinutes: 60 }],
      }),
    ];

    let catalog = mergeStorefrontGames([], steamGames, 'steam');
    catalog = mergeStorefrontGames(catalog, gogGames, 'gog');
    catalog = mergeStorefrontGames(catalog, epicGames, 'epic');

    // Verify dynamic entitlement registry recorded Steam, GOG, and Epic ownership
    const entitlements = getVerifiedUserEntitlements();
    expect(entitlements.steam).toEqual(expect.arrayContaining([999001, 999002]));
    expect(entitlements.gog).toEqual(
      expect.arrayContaining(['888001', '888002', 'starlight odyssey', 'dungeon weaver'])
    );
    expect(entitlements.epic).toEqual(
      expect.arrayContaining(['777001', '777002', 'cyber chrono', 'aether drift'])
    );

    // Persist catalog and simulate an application restart
    saveCurrentCatalog(catalog);
    const reloaded = loadCurrentCatalog();
    expect(reloaded).toHaveLength(4);

    // Also pass through sanitizeGameCatalog without allowNewPurchases and with non-empty baseline sets
    const reSanitized = sanitizeGameCatalog(reloaded, {
      validSteamAppIds: new Set([10, 20]),
      validSteamTitles: new Set(['some other steam game']),
      validGogTitles: new Set(['some other gog game']),
      validGogProductIds: new Set(['111111']),
      validEpicTitles: new Set(['some other epic game']),
    });

    expect(reSanitized).toHaveLength(4);
    expect(reSanitized.map((g) => g.title)).toEqual([
      'Aether Drift',
      'Cyber Chrono',
      'Dungeon Weaver',
      'Starlight Odyssey',
    ]);

    const starlight = reSanitized.find((g) => normalizeCanonicalTitle(g.title) === 'starlight odyssey');
    expect(starlight).toBeDefined();
    expect(starlight!.platforms.map((p) => p.platformId)).toEqual(
      expect.arrayContaining(['steam', 'gog'])
    );

    const cyberChrono = reSanitized.find((g) => normalizeCanonicalTitle(g.title) === 'cyber chrono');
    expect(cyberChrono).toBeDefined();
    expect(cyberChrono!.platforms.map((p) => p.platformId)).toEqual(
      expect.arrayContaining(['steam', 'epic'])
    );

    const dungeonWeaver = reSanitized.find((g) => normalizeCanonicalTitle(g.title) === 'dungeon weaver');
    expect(dungeonWeaver).toBeDefined();
    expect(dungeonWeaver!.platforms.map((p) => p.platformId)).toEqual(['gog']);

    const aetherDrift = reSanitized.find((g) => normalizeCanonicalTitle(g.title) === 'aether drift');
    expect(aetherDrift).toBeDefined();
    expect(aetherDrift!.platforms.map((p) => p.platformId)).toEqual(['epic']);
  });

  it('Test 2: Storefront Disconnection & Dynamic Entitlement Revocation', () => {
    const steamGames: CanonicalGame[] = [
      makeCanonicalGame({
        id: 'steam-999001',
        title: 'Starlight Odyssey',
        steamAppId: 999001,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '999001', installed: false }],
      }),
    ];
    const gogGames: CanonicalGame[] = [
      makeCanonicalGame({
        id: 'gog-888001',
        title: 'Starlight Odyssey',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '888001', installed: true }],
      }),
      makeCanonicalGame({
        id: 'gog-888002',
        title: 'Dungeon Weaver',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '888002', installed: false }],
      }),
    ];

    let catalog = mergeStorefrontGames([], steamGames, 'steam');
    catalog = mergeStorefrontGames(catalog, gogGames, 'gog');
    expect(catalog).toHaveLength(2);
    expect(getVerifiedUserEntitlements().gog.length).toBeGreaterThan(0);

    // Disconnect GOG
    const afterDisconnect = removeStorefrontGames(catalog, 'gog');

    // GOG entitlements are revoked
    expect(getVerifiedUserEntitlements().gog).toEqual([]);
    // Steam entitlements remain intact
    expect(getVerifiedUserEntitlements().steam).toEqual([999001]);

    // GOG-only Dungeon Weaver is removed; Starlight Odyssey remains with Steam ownership only
    expect(afterDisconnect).toHaveLength(1);
    expect(afterDisconnect[0].title).toBe('Starlight Odyssey');
    expect(afterDisconnect[0].platforms.map((p) => p.platformId)).toEqual(['steam']);
  });

  it('Test 3: Behavioral De-Hackification Verification (No Per-Game AppID Overrides, Generic Sanitizer Registries)', () => {
    // 1. Games containing 'e-day' in title are never mutated to hardcoded Steam AppID 3010850
    const eDayGame: CanonicalGame = {
      id: 'steam-999123',
      title: 'Project E-Day Tactics',
      sortTitle: 'Project E-Day Tactics',
      steamAppId: 999123,
      isVerifiedEntitlement: true,
      platforms: [{ platformId: 'steam', platformGameId: '999123', installed: false }],
      headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/999123/header.jpg',
      capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/999123/library_600x900.jpg',
      developers: ['Tactics Studio'],
      publishers: ['Tactics Studio'],
      genres: ['Strategy'],
      tags: ['Strategy'],
    };

    // 2. Unmapped Epic internal codename is suppressed while legitimate Epic game ('epic-hades') is preserved
    const sampleCodename = Array.from(UNMAPPED_EPIC_INTERNAL_CODENAMES)[0] || 'snapdragon';
    const unmappedCodename: CanonicalGame = {
      id: `epic-${sampleCodename}`,
      title: sampleCodename,
      sortTitle: sampleCodename,
      isVerifiedEntitlement: true,
      platforms: [{ platformId: 'epic', platformGameId: `${sampleCodename}-id`, installed: false }],
      headerImage: '',
      capsuleImage: '',
      developers: [],
      publishers: [],
      genres: [],
      tags: [],
    };
    const legitimateHades: CanonicalGame = {
      id: 'epic-hades',
      title: 'Hades',
      sortTitle: 'Hades',
      isVerifiedEntitlement: true,
      platforms: [{ platformId: 'epic', platformGameId: 'Min', installed: true }],
      headerImage: 'https://cdn1.epicgames.com/min/offer/hades-wide.jpg',
      capsuleImage: 'https://cdn1.epicgames.com/min/offer/hades-tall.jpg',
      developers: ['Supergiant Games'],
      publishers: ['Supergiant Games'],
      genres: ['Action', 'Roguelike'],
      tags: ['Action'],
    };

    expect(isUnmappedEpicInternalCodename(unmappedCodename)).toBe(true);
    expect(isUnmappedEpicInternalCodename(legitimateHades)).toBe(false);
    expect(
      isUnsuitableHeaderUrl(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/480/header.jpg'
      )
    ).toBe(true);
    expect(
      isUnsuitableHeaderUrl(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1145360/header.jpg'
      )
    ).toBe(false);

    saveCurrentCatalog([eDayGame, unmappedCodename, legitimateHades], { immediate: true });
    const loaded = loadCurrentCatalog();
    expect(loaded.map((g) => g.id).sort()).toEqual(['epic-hades', 'steam-999123']);
    const loadedEDay = loaded.find((g) => g.id === 'steam-999123');
    expect(loadedEDay?.steamAppId).toBe(999123);
  });

  it('Test 4: launcherEngine.shutdownLauncherEngine() Lifecycle Cleanup', async () => {
    expect(typeof launcherEngine.shutdownLauncherEngine).toBe('function');

    // Create a manual download task to ensure active queue / controllers cleanup works without throwing
    const initRes = await launcherEngine.installGame({
      gameId: 'gog-shutdown-test',
      title: 'Shutdown Test Game',
      platformId: 'gog',
      platformGameId: 'shutdown-test-id',
      manualControl: true,
    });
    expect(initRes.success).toBe(true);

    expect(() => launcherEngine.shutdownLauncherEngine()).not.toThrow();

    launcherEngine.cancelDownload(initRes.task.taskId);
  });
});
