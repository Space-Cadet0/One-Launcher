import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { makeCanonicalGame, makeUserGameOverride } from './helpers/factories';
import type { CanonicalGame } from '../src/contracts/game';
import type { SteamEnrichedMetadata } from '../src/contracts/steam';
import type { ElectronAPI } from '../src/types/electron';

// ---------------------------------------------------------------------------
// Headless Browser & Storage Harness (Zero Real Network / Zero PII)
// ---------------------------------------------------------------------------
const testEnv = vi.hoisted(() => {
  class MemoryStorage implements Storage {
    private data = new Map<string, string>();
    get length(): number {
      return this.data.size;
    }
    clear(): void {
      this.data.clear();
    }
    getItem(key: string): string | null {
      return this.data.get(key) ?? null;
    }
    key(index: number): string | null {
      return Array.from(this.data.keys())[index] ?? null;
    }
    removeItem(key: string): void {
      this.data.delete(key);
    }
    setItem(key: string, value: string): void {
      this.data.set(key, String(value));
    }
  }

  const localStorageMock = new MemoryStorage();
  const eventTarget = new EventTarget();
  const windowObj: Record<string, unknown> = {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      eventTarget.removeEventListener(type, listener),
    dispatchEvent: (event: Event) => eventTarget.dispatchEvent(event),
    localStorage: localStorageMock,
    location: {
      hostname: 'example.invalid',
      origin: 'https://example.invalid',
      protocol: 'https:',
    },
    navigator: { onLine: true, platform: 'MacIntel', userAgent: 'NodeVitest/1.0' },
    electronAPI: { platform: 'darwin' },
  };

  Object.defineProperty(globalThis, 'window', {
    value: windowObj,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageMock,
    configurable: true,
    writable: true,
  });

  return { localStorageMock, windowObj };
});

import {
  syncJobManager,
  evaluateGameNeedsStoreMediaSync,
} from '../src/services/network/syncJobManager';
import {
  clearStagedMemoryFallback,
  hasFreshMediaSyncAttempt,
  MEDIA_ATTEMPT_KEY_PREFIX,
  loadStagedCache,
  type MediaSyncAttemptRecord,
} from '../src/services/storage/stagedCacheService';
import {
  applyUserOverrideToGame,
  applyUserOverridesToCatalog,
  getUserOverrideForGame,
  isEnrichedMetadataIncompatibleWithOverride,
  saveUserOverride,
  updateRoutedMetadataSnapshot,
} from '../src/services/storage/userOverrideStorage';
import { fallbackMetadataProvider } from '../src/services/steam/fallbackMetadataProvider';
import { requestScheduler } from '../src/services/network/requestScheduler';

const nodeRequire = createRequire(import.meta.url);

interface OfflineVaultGameDetailRecord {
  enrichedMetadata?: SteamEnrichedMetadata | null;
  metadataQuality?: string;
  enrichedAt?: number;
}

interface OfflineVaultInstance {
  ensureOpen(): unknown;
  close(): void;
  upsertGames(games: CanonicalGame[]): { success: boolean; upserted?: number; skipped?: number };
  saveGameDetail(
    payload: {
      gameId: string;
      canonicalTitle?: string;
      steamAppId?: number | null;
      enrichedMetadata?: SteamEnrichedMetadata | null;
      metadataQuality?: string;
      enrichedAt?: number;
      isExplicitNonSteam?: boolean;
      forceReplaceEnriched?: boolean;
    }
  ): { success: boolean };
  getGameDetail(gameId: string): OfflineVaultGameDetailRecord | null;
  getCatalogSnapshot(): {
    success: boolean;
    games: CanonicalGame[];
    details: Record<string, OfflineVaultGameDetailRecord>;
  };
  db: {
    prepare(sql: string): {
      run(...args: unknown[]): unknown;
      get(...args: unknown[]): Record<string, unknown> | undefined;
    };
  };
}

interface OfflineVaultModule {
  OfflineVaultService: new (options: { userDataDir: string; platform?: string }) => OfflineVaultInstance;
}

interface InstalledGameScanRecord {
  platformId: string;
  platformGameId: string;
  title: string;
  installPath?: string;
  executablePath?: string;
}

interface InstalledGameScanResult {
  success: boolean;
  installedGames: InstalledGameScanRecord[];
}

interface InstalledGameScannerModule {
  scanAllInstalledGames(options: Record<string, unknown>): InstalledGameScanResult;
  scanAllInstalledGamesAsync(options: Record<string, unknown>): Promise<InstalledGameScanResult>;
}

interface EpicCoordinatorModule {
  syncEpicFirstPartyLauncher(options: Record<string, unknown>): {
    synced: number;
  };
}

const { OfflineVaultService } = nodeRequire(
  '../electron/launcher/offlineVaultService.cjs'
) as OfflineVaultModule;
const installedGameScanner = nodeRequire(
  '../electron/launcher/installedGameScanner.cjs'
) as InstalledGameScannerModule;
const epicCoordinator = nodeRequire(
  '../electron/launcher/epicLegendaryAndEosCoordinator.cjs'
) as EpicCoordinatorModule;

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const EMPTY_REVIEW_SUMMARY = {
  reviewScore: 0,
  reviewScoreDesc: 'No user reviews',
  totalPositive: 0,
  totalNegative: 0,
  totalReviews: 0,
  positivePercent: 0,
};

function makeRichSteamMetadata(overrides: Partial<SteamEnrichedMetadata> = {}): SteamEnrichedMetadata {
  return {
    appId: 2280,
    name: 'Classic Shooter Bundle',
    shortDescription:
      'A full authoritative Steam synopsis describing this classic first-person shooter collection.',
    detailedDescription:
      '<p>A full authoritative Steam detailed description with rich content and features.</p>',
    aboutTheGame:
      '<p>A full authoritative Steam detailed description with rich content and features.</p>',
    headerImage: 'https://cdn.akamai.steamstatic.com/steam/apps/2280/header.jpg',
    capsuleImage: 'https://cdn.akamai.steamstatic.com/steam/apps/2280/library_600x900.jpg',
    developers: ['Classic Studio'],
    publishers: ['Classic Publisher'],
    releaseDate: '1993-12-10',
    genres: ['Action'],
    tags: ['FPS'],
    categories: [],
    supportedLanguages: 'English',
    screenshots: [
      {
        id: 1,
        pathThumbnail: 'https://cdn.akamai.steamstatic.com/steam/apps/2280/ss_1.jpg',
        pathFull: 'https://cdn.akamai.steamstatic.com/steam/apps/2280/ss_1_full.jpg',
      },
    ],
    movies: [],
    systemRequirements: { minimum: 'Windows 10' },
    reviewSummary: EMPTY_REVIEW_SUMMARY,
    metadataQuality: 'authoritative',
    enrichedSource: 'steam',
    fetchedAt: Date.now() - 10_000,
    ...overrides,
  };
}

describe('UAT Boot Re-Sync Loop Fixes', () => {
  beforeEach(() => {
    testEnv.localStorageMock.clear();
    clearStagedMemoryFallback();
    syncJobManager.reset();
    requestScheduler.reset();
    testEnv.windowObj.electronAPI = { platform: 'darwin' };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncJobManager.reset();
    clearStagedMemoryFallback();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  it('replaces stale unlinked Steam metadata in SQLite and queues 0 repeat games on cold boot #2 (DOOM I Enhanced / Gears-shaped overridden non-Steam game)', async () => {
    const tmpDir = createTempDir('ol-boot-resync-override-');
    const vault = new OfflineVaultService({ userDataDir: tmpDir, platform: 'darwin' });
    try {
      const gameId = 'gog-990001';
      const staleSteamMeta = makeRichSteamMetadata({
        appId: 2280,
        name: 'Combined Shooter Bundle',
        metadataQuality: 'authoritative',
      });

      const initialBeforeOverride = makeCanonicalGame({
        id: gameId,
        title: 'Classic Standalone Enhanced',
        steamAppId: 2280,
        platforms: [{ platformId: 'gog', platformGameId: '990001', installed: true }],
        capsuleImage: 'https://images.gog-statics.com/cover-990001.jpg',
        headerImage: 'https://images.gog-statics.com/header-990001.jpg',
        shortDescription:
          'Developed by Classic Studio, this standalone enhanced release pioneered first-person action.',
        enrichedMetadata: staleSteamMeta,
      });

      // Seed SQLite with the pre-override authoritative Steam metadata (rank 4, appId 2280)
      vault.upsertGames([initialBeforeOverride]);
      expect(vault.getGameDetail(gameId)?.enrichedMetadata?.appId).toBe(2280);

      // User explicitly unlinks from Steam and routes metadata to GOG
      const userOverride = makeUserGameOverride({
        gameId,
        platformId: 'gog',
        platformGameId: '990001',
        matchedStore: 'gog',
        matchedId: '990001',
        title: 'Classic Standalone Enhanced',
        steamAppId: null,
        isExplicitNonSteam: true,
        capsuleImage: 'https://images.gog-statics.com/cover-990001.jpg',
        headerImage: 'https://images.gog-statics.com/header-990001.jpg',
        shortDescription:
          'Developed by Classic Studio, this standalone enhanced release pioneered first-person action.',
        metadataRoute: {
          mode: 'routed',
          source: 'gog',
          matchedId: '990001',
          gogId: '990001',
          targetTitle: 'Classic Standalone Enhanced',
          customTitleEdited: false,
          customSynopsisEdited: false,
        },
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      });
      saveUserOverride(userOverride);

      // Wire real OfflineVaultService to window.electronAPI.offlineVault
      const bridge: Partial<ElectronAPI> = {
        platform: 'darwin',
        offlineVault: {
          saveGameDetail: vi.fn(async (payload) => vault.saveGameDetail(payload)),
          getGameDetail: vi.fn(async (id: string) => vault.getGameDetail(id)),
          upsertGames: vi.fn(async (games: CanonicalGame[]) => vault.upsertGames(games)),
          getCatalogSnapshot: vi.fn(async () => vault.getCatalogSnapshot()),
          queueHydration: vi.fn(async () => ({ success: true, queued: 0 })),
        } as unknown as ElectronAPI['offlineVault'],
      };
      testEnv.windowObj.electronAPI = bridge;

      // Mock upstream non-Steam fetch returning scraped metadata (rank 3, appId 0, no trailers)
      const scrapedNonSteamMeta: SteamEnrichedMetadata = {
        appId: 0,
        name: 'Classic Standalone Enhanced',
        shortDescription:
          'Developed by Classic Studio, this standalone enhanced release pioneered first-person action.',
        detailedDescription:
          '<p>Standalone GOG product metadata with screenshots and no trailers.</p>',
        aboutTheGame: '<p>Standalone GOG product metadata with screenshots and no trailers.</p>',
        headerImage: 'https://images.gog-statics.com/header-990001.jpg',
        capsuleImage: 'https://images.gog-statics.com/cover-990001.jpg',
        developers: ['Classic Studio'],
        publishers: ['Classic Publisher'],
        releaseDate: '1993-12-10',
        genres: ['Action'],
        tags: ['GOG'],
        categories: [],
        supportedLanguages: 'English',
        screenshots: [
          {
            id: 0,
            pathThumbnail: 'https://images.gog-statics.com/shot-1.jpg',
            pathFull: 'https://images.gog-statics.com/shot-1.jpg',
          },
        ],
        movies: [],
        systemRequirements: { minimum: 'Windows 10' },
        reviewSummary: EMPTY_REVIEW_SUMMARY,
        metadataQuality: 'scraped',
        fetchedAt: Date.now(),
      };
      const nonSteamSpy = vi
        .spyOn(fallbackMetadataProvider, 'getEnrichedMetadataForNonSteamGame')
        .mockImplementation(async (game) => {
          // Simulate fallbackMetadataProvider calling updateRoutedMetadataSnapshot on fetch
          updateRoutedMetadataSnapshot(game.id, {
            title: scrapedNonSteamMeta.name,
            shortDescription: scrapedNonSteamMeta.shortDescription,
            detailedDescription: scrapedNonSteamMeta.detailedDescription,
            developers: scrapedNonSteamMeta.developers,
            publishers: scrapedNonSteamMeta.publishers,
            genres: scrapedNonSteamMeta.genres,
            tags: scrapedNonSteamMeta.tags,
            releaseDate: scrapedNonSteamMeta.releaseDate,
          });
          return scrapedNonSteamMeta;
        });

      // --- LAUNCH #1 ---
      const launch1Snap = vault.getCatalogSnapshot();
      const launch1Raw: CanonicalGame = {
        ...launch1Snap.games[0],
        enrichedMetadata: launch1Snap.details[gameId]?.enrichedMetadata ?? undefined,
      };
      const launch1Game = applyUserOverrideToGame(launch1Raw, userOverride);

      // On Launch #1, stale Steam appId 2280 was invalidated, so warmup must sync it once
      expect(launch1Game.enrichedMetadata).toBeUndefined();
      expect(
        evaluateGameNeedsStoreMediaSync(launch1Game, false, { isPostHydration: true }).eligible
      ).toBe(true);

      const updatedInLaunch1: CanonicalGame[] = [];
      await syncJobManager.startStoreMediaSync(
        [launch1Game],
        (updated) => {
          updatedInLaunch1.push(updated);
          vault.upsertGames([updated]);
        },
        {
          incremental: true,
          isBackgroundWarmup: true,
          isPostHydration: true,
          maxRepairTier: 2,
        }
      );

      expect(nonSteamSpy).toHaveBeenCalledTimes(1);
      expect(updatedInLaunch1).toHaveLength(1);

      // SQLite vault MUST now contain the replaced non-Steam scraped metadata (appId: 0)
      const persistedDetail = vault.getGameDetail(gameId);
      expect(persistedDetail?.enrichedMetadata?.appId).toBe(0);
      expect(persistedDetail?.enrichedMetadata?.metadataQuality).toBe('scraped');
      expect(persistedDetail?.enrichedMetadata?.fetchedAt).toBeGreaterThan(0);
      expect(persistedDetail?.enrichedMetadata?.lastMediaSyncAttemptAt).toBeGreaterThan(0);

      // Staged attempt timestamp must be >= override.updatedAt
      const latestOv = getUserOverrideForGame(launch1Game);
      const latestOvMs = latestOv?.updatedAt ? Date.parse(latestOv.updatedAt) : 0;
      const attemptEntry = loadStagedCache<MediaSyncAttemptRecord>(
        `${MEDIA_ATTEMPT_KEY_PREFIX}${gameId}`
      );
      expect(attemptEntry.valid).toBe(true);
      expect(attemptEntry.data?.attemptedAt ?? 0).toBeGreaterThanOrEqual(latestOvMs);

      // --- LAUNCH #2 (Cold Boot Restart) ---
      clearStagedMemoryFallback();
      syncJobManager.reset();
      nonSteamSpy.mockClear();

      const launch2Snap = vault.getCatalogSnapshot();
      const launch2Raw: CanonicalGame = {
        ...launch2Snap.games[0],
        enrichedMetadata: launch2Snap.details[gameId]?.enrichedMetadata ?? undefined,
      };
      const launch2Catalog = applyUserOverridesToCatalog([launch2Raw]);
      const launch2Game = launch2Catalog[0];

      // Non-Steam enrichedMetadata MUST survive cold boot intact
      expect(launch2Game.enrichedMetadata?.appId).toBe(0);
      expect(launch2Game.enrichedMetadata?.screenshots?.length).toBe(1);
      expect(
        evaluateGameNeedsStoreMediaSync(launch2Game, false, { isPostHydration: true }).eligible
      ).toBe(false);

      await syncJobManager.startStoreMediaSync([launch2Game], vi.fn(), {
        incremental: true,
        isBackgroundWarmup: true,
        isPostHydration: true,
        maxRepairTier: 2,
      });

      // Zero repeat fetches on Launch #2!
      expect(nonSteamSpy).toHaveBeenCalledTimes(0);

      // Explicit manual force sync STILL bypasses cooldown when requested by user
      expect(
        evaluateGameNeedsStoreMediaSync(launch2Game, true, { isManualSync: true }).eligible
      ).toBe(true);
    } finally {
      vault.close();
    }
  });

  it('persists negative 404 / empty-media attempt across cold boot restart so Launch #1 attempts once and Launch #2 queues 0 games', async () => {
    const delistedGame = makeCanonicalGame({
      id: 'gog-990002',
      title: 'Delisted Classic Edition',
      steamAppId: undefined,
      isExplicitNonSteam: true,
      platforms: [{ platformId: 'gog', platformGameId: '990002', installed: false }],
      capsuleImage: 'https://images.gog-statics.com/cover-990002.jpg',
      headerImage: 'https://images.gog-statics.com/header-990002.jpg',
      shortDescription: '',
      enrichedMetadata: undefined,
    });

    const skeletonFallback: SteamEnrichedMetadata = {
      appId: 0,
      name: delistedGame.title,
      shortDescription: 'Delisted Classic Edition is a PC library title.',
      detailedDescription: 'Delisted Classic Edition is a PC library title.',
      aboutTheGame: 'Delisted Classic Edition is a PC library title.',
      headerImage: delistedGame.headerImage,
      developers: [],
      publishers: [],
      releaseDate: 'TBA',
      genres: [],
      tags: [],
      categories: [],
      supportedLanguages: '',
      screenshots: [],
      movies: [],
      systemRequirements: {},
      reviewSummary: EMPTY_REVIEW_SUMMARY,
      metadataQuality: 'skeleton_fallback',
    };

    const fetchSpy = vi
      .spyOn(fallbackMetadataProvider, 'getEnrichedMetadataForNonSteamGame')
      .mockResolvedValue(skeletonFallback);

    // Launch #1: eligible and attempted once
    expect(
      evaluateGameNeedsStoreMediaSync(delistedGame, false, { isPostHydration: true }).eligible
    ).toBe(true);

    await syncJobManager.startStoreMediaSync([delistedGame], vi.fn(), {
      incremental: true,
      isBackgroundWarmup: true,
      isPostHydration: true,
      maxRepairTier: 2,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Verify durable negative attempt was persisted to localStorage
    const stored = loadStagedCache<MediaSyncAttemptRecord>(
      `${MEDIA_ATTEMPT_KEY_PREFIX}${delistedGame.id}`
    );
    expect(stored.valid).toBe(true);
    expect(stored.data?.outcome).toBe('unavailable_404');

    // Launch #2: simulate cold boot (wipe in-memory caches while localStorage persists)
    clearStagedMemoryFallback();
    syncJobManager.reset();
    fetchSpy.mockClear();

    expect(hasFreshMediaSyncAttempt(delistedGame.id, delistedGame.enrichedMetadata)).toBe(true);
    expect(
      evaluateGameNeedsStoreMediaSync(delistedGame, false, { isPostHydration: true }).eligible
    ).toBe(false);

    await syncJobManager.startStoreMediaSync([delistedGame], vi.fn(), {
      incremental: true,
      isBackgroundWarmup: true,
      isPostHydration: true,
      maxRepairTier: 2,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    // Explicit manual sync with forceRefresh still bypasses the passive negative cooldown
    expect(
      evaluateGameNeedsStoreMediaSync(delistedGame, true, { isManualSync: true }).eligible
    ).toBe(true);
  });

  it('keeps updateRoutedMetadataSnapshot idempotent (no updatedAt bump on identical snapshot) and flags incompatible Steam metadata during hydration', () => {
    const gameId = 'xbox-990003';
    const initialIso = '2026-11-20T10:00:00.000Z';
    const ov = makeUserGameOverride({
      gameId,
      platformId: 'xbox',
      platformGameId: '990003',
      matchedStore: 'igdb',
      matchedId: '174961',
      title: 'Remastered Shooter',
      sortTitle: 'Remastered Shooter',
      steamAppId: null,
      isExplicitNonSteam: true,
      shortDescription: 'A remastered tactical shooter with modern visuals.',
      detailedDescription: '<p>Full remastered description.</p>',
      developers: ['Remaster Studio'],
      publishers: ['Remaster Publisher'],
      genres: ['Shooter'],
      tags: ['Xbox'],
      releaseDate: '2016-02-01',
      metadataRoute: {
        mode: 'routed',
        source: 'custom',
        matchedId: '990003',
        igdbId: 174961,
        targetTitle: 'Remastered Shooter',
        customTitleEdited: false,
        customSynopsisEdited: false,
      },
      updatedAt: initialIso,
    });
    saveUserOverride(ov);
    const probeGame = makeCanonicalGame({
      id: gameId,
      title: 'Remastered Shooter',
      platforms: [{ platformId: 'xbox', platformGameId: '990003', installed: false }],
    });
    const savedInitialUpdatedAt = getUserOverrideForGame(probeGame)?.updatedAt;
    expect(savedInitialUpdatedAt).toBeTruthy();

    // Calling updateRoutedMetadataSnapshot with identical values must NOT bump updatedAt
    updateRoutedMetadataSnapshot(gameId, {
      title: 'Remastered Shooter',
      shortDescription: 'A remastered tactical shooter with modern visuals.',
      detailedDescription: '<p>Full remastered description.</p>',
      developers: ['Remaster Studio'],
      publishers: ['Remaster Publisher'],
      genres: ['Shooter'],
      tags: ['Xbox'],
      releaseDate: '2016-02-01',
    });
    expect(getUserOverrideForGame(probeGame)?.updatedAt).toBe(savedInitialUpdatedAt);

    // Incompatible Steam metadata (appId > 0) must be rejected for explicit non-Steam overrides,
    // while valid non-Steam metadata (appId: 0) is accepted.
    const staleSteam = makeRichSteamMetadata({ appId: 2523720 });
    const validNonSteam = makeRichSteamMetadata({ appId: 0, metadataQuality: 'scraped', enrichedSource: 'igdb' });
    expect(isEnrichedMetadataIncompatibleWithOverride(staleSteam, ov)).toBe(true);
    expect(isEnrichedMetadataIncompatibleWithOverride(validNonSteam, ov)).toBe(false);
  });

  it('excludes Epic DLC packs (is_dlc / mainGameItem / MainGameAppName) from installed game scans and repairs DLC MainGameAppName during first-party sync', async () => {
    const rootDir = createTempDir('ol-boot-resync-epic-dlc-');
    const homedir = path.join(rootDir, 'home');
    const userDataDir = path.join(rootDir, 'userData');
    const gameDir = path.join(rootDir, 'games', 'MedievalRpg');
    const binDir = path.join(gameDir, 'bin', 'Win64');
    const exePath = path.join(binDir, 'MedievalRpg.exe');
    const manifestsDir = path.join(
      homedir,
      'Library',
      'Application Support',
      'Epic',
      'EpicGamesLauncher',
      'Data',
      'Manifests'
    );
    const datDir = path.join(
      homedir,
      'Library',
      'Application Support',
      'Epic',
      'UnrealEngineLauncher'
    );
    const legendaryDir = path.join(userDataDir, 'legendaryConfig', 'legendary');
    const legendaryMetaDir = path.join(legendaryDir, 'metadata');

    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(manifestsDir, { recursive: true });
    fs.mkdirSync(datDir, { recursive: true });
    fs.mkdirSync(legendaryMetaDir, { recursive: true });
    fs.writeFileSync(exePath, 'MZ-dummy-exe');

    // Legendary installed.json with base game + 3 DLC packs (is_dlc: true, executable: '')
    fs.writeFileSync(
      path.join(legendaryDir, 'installed.json'),
      JSON.stringify({
        BaseRpg: {
          app_name: 'BaseRpg',
          title: 'Medieval RPG',
          install_path: gameDir,
          executable: 'bin/Win64/MedievalRpg.exe',
          is_dlc: false,
          platform: 'Windows',
          version: '1.9.8',
        },
        BaseRpgTexturePack: {
          app_name: 'BaseRpgTexturePack',
          title: 'HD Texture Pack',
          install_path: gameDir,
          executable: '',
          is_dlc: true,
          platform: 'Windows',
          version: '1.9.4',
        },
        BaseRpgSoundPack: {
          app_name: 'BaseRpgSoundPack',
          title: 'HD Sound Pack',
          install_path: gameDir,
          executable: '',
          is_dlc: true,
          platform: 'Windows',
          version: '1.9.8',
        },
        BaseRpgVoiceEnglish: {
          app_name: 'BaseRpgVoiceEnglish',
          title: 'HD Voice Pack - English',
          install_path: gameDir,
          executable: '',
          is_dlc: true,
          platform: 'Windows',
          version: '1.9.4',
        },
      })
    );

    // Legendary metadata JSONs where the 3 DLC packs declare mainGameItem pointing to BaseRpg
    fs.writeFileSync(
      path.join(legendaryMetaDir, 'BaseRpg.json'),
      JSON.stringify({
        app_name: 'BaseRpg',
        app_title: 'Medieval RPG',
        metadata: {
          id: 'cat-base-rpg',
          namespace: 'ns-rpg',
          itemType: 'DURABLE',
          categories: [{ path: 'public' }, { path: 'games' }],
        },
      })
    );
    for (const dlc of [
      { appName: 'BaseRpgTexturePack', title: 'HD Texture Pack', catId: 'cat-dlc-tex' },
      { appName: 'BaseRpgSoundPack', title: 'HD Sound Pack', catId: 'cat-dlc-snd' },
      { appName: 'BaseRpgVoiceEnglish', title: 'HD Voice Pack - English', catId: 'cat-dlc-vox' },
    ]) {
      fs.writeFileSync(
        path.join(legendaryMetaDir, `${dlc.appName}.json`),
        JSON.stringify({
          app_name: dlc.appName,
          app_title: dlc.title,
          metadata: {
            id: dlc.catId,
            namespace: 'ns-rpg',
            itemType: 'DURABLE',
            categories: [{ path: 'public' }, { path: 'games' }],
            mainGameItem: {
              id: 'cat-base-rpg',
              namespace: 'ns-rpg',
              releaseInfo: [{ appId: 'BaseRpg', platform: ['Windows'] }],
            },
          },
        })
      );
    }

    // Legacy broken .item manifests (where MainGameAppName mistakenly equaled AppName)
    // plus LauncherInstalled.dat containing all 4 entries
    for (const item of [
      { appName: 'BaseRpg', title: 'Medieval RPG', catId: 'cat-base-rpg' },
      { appName: 'BaseRpgTexturePack', title: 'HD Texture Pack', catId: 'cat-dlc-tex' },
      { appName: 'BaseRpgSoundPack', title: 'HD Sound Pack', catId: 'cat-dlc-snd' },
      { appName: 'BaseRpgVoiceEnglish', title: 'HD Voice Pack - English', catId: 'cat-dlc-vox' },
    ]) {
      fs.writeFileSync(
        path.join(manifestsDir, `${item.appName}.item`),
        JSON.stringify({
          AppName: item.appName,
          DisplayName: item.title,
          MainGameAppName: item.appName,
          bIsApplication: true,
          bIsIncompleteInstall: false,
          InstallLocation: gameDir,
          LaunchExecutable: 'bin/Win64/MedievalRpg.exe',
          CatalogItemId: item.catId,
          AppCategories: ['public', 'games', 'applications'],
        })
      );
    }

    // Also include a standalone native EGL DLC manifest without Legendary entry (MainGameAppName != AppName)
    fs.writeFileSync(
      path.join(manifestsDir, 'ExternalDlcPack.item'),
      JSON.stringify({
        AppName: 'ExternalDlcPack',
        DisplayName: 'Bonus Soundtrack Pack',
        MainGameAppName: 'BaseRpg',
        bIsApplication: true,
        bIsIncompleteInstall: false,
        InstallLocation: gameDir,
        LaunchExecutable: 'bin/Win64/MedievalRpg.exe',
        CatalogItemId: 'cat-ext-dlc',
        AppCategories: ['public', 'games', 'applications'],
      })
    );

    fs.writeFileSync(
      path.join(datDir, 'LauncherInstalled.dat'),
      JSON.stringify({
        InstallationList: [
          { AppName: 'BaseRpg', InstallLocation: gameDir, AppVersion: '1.9.8' },
          { AppName: 'BaseRpgTexturePack', InstallLocation: gameDir, AppVersion: '1.9.4' },
          { AppName: 'BaseRpgSoundPack', InstallLocation: gameDir, AppVersion: '1.9.8' },
          { AppName: 'BaseRpgVoiceEnglish', InstallLocation: gameDir, AppVersion: '1.9.4' },
          { AppName: 'ExternalDlcPack', InstallLocation: gameDir, AppVersion: '1.0.0' },
        ],
      })
    );

    const scanOpts = {
      platform: 'darwin',
      homedir,
      userDataDir,
      skipFirstPartySync: true,
    };

    const syncRes = installedGameScanner.scanAllInstalledGames(scanOpts);
    expect(syncRes.success).toBe(true);
    const syncEpicIds = syncRes.installedGames
      .filter((g) => g.platformId === 'epic')
      .map((g) => g.platformGameId);
    expect(syncEpicIds).toEqual(['BaseRpg']);

    const asyncRes = await installedGameScanner.scanAllInstalledGamesAsync(scanOpts);
    expect(asyncRes.success).toBe(true);
    const asyncEpicIds = asyncRes.installedGames
      .filter((g) => g.platformId === 'epic')
      .map((g) => g.platformGameId);
    expect(asyncEpicIds).toEqual(['BaseRpg']);

    // Verify syncEpicFirstPartyLauncher resolves parent MainGameAppName ('BaseRpg') from metadata mainGameItem
    const syncOutManifestsDir = path.join(rootDir, 'syncedManifests');
    const syncOutDat = path.join(rootDir, 'syncedDat', 'LauncherInstalled.dat');
    fs.mkdirSync(syncOutManifestsDir, { recursive: true });
    fs.mkdirSync(path.dirname(syncOutDat), { recursive: true });

    const fpRes = epicCoordinator.syncEpicFirstPartyLauncher({
      platform: 'win32',
      homedir,
      userDataDir,
      eglManifestsDir: syncOutManifestsDir,
      eglLauncherInstalledPath: syncOutDat,
    });
    expect(fpRes.synced).toBeGreaterThanOrEqual(4);
    const syncedFiles = fs
      .readdirSync(syncOutManifestsDir)
      .filter((f) => f.endsWith('.item'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(syncOutManifestsDir, f), 'utf8')) as Record<string, unknown>);
    const texManifest = syncedFiles.find((m) => m.AppName === 'BaseRpgTexturePack');
    expect(texManifest).toBeDefined();
    expect(texManifest?.MainGameAppName).toBe('BaseRpg');
  });

  it('allows legacy non-Steam SQLite rows (appId: 0, col quality authoritative, missing fetchedAt) to persist fresh scraped metadata', () => {
    const tmpDir = createTempDir('ol-boot-resync-legacy-gog-');
    const vault = new OfflineVaultService({ userDataDir: tmpDir, platform: 'darwin' });
    try {
      const gameId = 'gog-1449569170';
      vault.ensureOpen();
      // Simulate legacy DB row written with col metadata_quality='authoritative' but enriched.appId=0 & no metadataQuality/fetchedAt
      const legacyEnrichedJson = JSON.stringify({
        appId: 0,
        name: 'Legacy Retro Platformer',
        shortDescription: 'Classic retro side-scrolling action game originally released in 1993.',
        detailedDescription: '<p>Classic retro side-scrolling action game.</p>',
        screenshots: [{ id: 0, pathThumbnail: 'https://images.gog-statics.com/s1.jpg', pathFull: 'https://images.gog-statics.com/s1.jpg' }],
        movies: [],
        systemRequirements: { minimum: 'DOSBox' },
      });
      vault.db
        .prepare(
          `INSERT INTO vault_games (
            game_id, canonical_title, steam_app_id, is_installed, is_favorited,
            platforms_json, summary_json, enriched_json, metadata_quality, updated_at, enriched_at
          ) VALUES (?, ?, NULL, 0, 0, ?, ?, ?, 'authoritative', 1000, 1000)`
        )
        .run(
          gameId,
          'Legacy Retro Platformer',
          JSON.stringify([{ platformId: 'gog', platformGameId: '1449569170', platforms: { windows: true, mac: true } }]),
          JSON.stringify({ id: gameId, title: 'Legacy Retro Platformer' }),
          legacyEnrichedJson
        );

      const nowTs = Date.now();
      vault.saveGameDetail({
        gameId,
        canonicalTitle: 'Legacy Retro Platformer',
        steamAppId: null,
        enrichedMetadata: {
          appId: 0,
          name: 'Legacy Retro Platformer',
          shortDescription: 'Classic retro side-scrolling action game originally released in 1993.',
          detailedDescription: '<p>Classic retro side-scrolling action game.</p>',
          aboutTheGame: '<p>Classic retro side-scrolling action game.</p>',
          headerImage: 'https://images.gog-statics.com/h1.jpg',
          developers: ['Retro Studio'],
          publishers: ['Retro Pub'],
          releaseDate: '1993-08-03',
          genres: ['Action'],
          tags: ['GOG'],
          categories: [],
          supportedLanguages: 'English',
          screenshots: [{ id: 0, pathThumbnail: 'https://images.gog-statics.com/s1.jpg', pathFull: 'https://images.gog-statics.com/s1.jpg' }],
          movies: [],
          systemRequirements: { minimum: 'DOSBox' },
          reviewSummary: EMPTY_REVIEW_SUMMARY,
          metadataQuality: 'scraped',
          fetchedAt: nowTs,
          lastMediaSyncAttemptAt: nowTs,
          mediaSyncOutcome: 'partial_no_trailers',
        },
        metadataQuality: 'scraped',
        enrichedAt: nowTs,
      });

      const saved = vault.getGameDetail(gameId);
      expect(saved?.enrichedMetadata?.fetchedAt).toBe(nowTs);
      expect(saved?.enrichedMetadata?.lastMediaSyncAttemptAt).toBe(nowTs);
    } finally {
      vault.close();
    }
  });

  it('clears/replaces invalidated Steam blobs on explicit non-Steam skeleton_fallback or __quotaSlimmed upserts, clears steam_app_id on saveGameDetail, and preserves rank-0 guard for non-conflicting forceReplaceEnriched', () => {
    const tmpDir = createTempDir('ol-boot-resync-hard-invalidation-');
    const vault = new OfflineVaultService({ userDataDir: tmpDir, platform: 'darwin' });
    try {
      const gameId = 'steam-2537590';
      const staleSteamGame: CanonicalGame = {
        id: gameId,
        title: 'Synthetic Unlinked Flight Sim',
        sortTitle: 'synthetic unlinked flight sim',
        steamAppId: 2537590,
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2537590/header.jpg',
        capsuleImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2537590/capsule.jpg',
        shortDescription: 'Wrong Steam sequel description',
        releaseDate: '2024-11-19',
        developers: ['Steam Sequel Studio'],
        publishers: ['Steam Sequel Pub'],
        genres: ['Simulation'],
        tags: ['Flight'],
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NRRJLLXM68V',
            xboxProductId: '9NRRJLLXM68V',
            installed: false,
          },
        ],
        enrichedMetadata: {
          appId: 2537590,
          name: 'Wrong Steam Sequel',
          shortDescription: 'Wrong Steam sequel description',
          detailedDescription: '<p>Wrong Steam sequel detailed description with rich content exceeding threshold.</p>',
          aboutTheGame: '<p>Wrong Steam sequel</p>',
          headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2537590/header.jpg',
          developers: ['Steam Sequel Studio'],
          publishers: ['Steam Sequel Pub'],
          releaseDate: '2024-11-19',
          genres: ['Simulation'],
          tags: ['Flight'],
          categories: [],
          supportedLanguages: 'English',
          screenshots: [
            {
              id: 0,
              pathThumbnail: 'https://shared.akamai.steamstatic.com/s1.jpg',
              pathFull: 'https://shared.akamai.steamstatic.com/s1.jpg',
            },
          ],
          movies: [],
          systemRequirements: { minimum: 'Windows 10' },
          reviewSummary: EMPTY_REVIEW_SUMMARY,
          metadataQuality: 'authoritative',
          fetchedAt: Date.now(),
        },
      };

      // 1. Seed stale Steam authoritative blob on the row
      vault.upsertGames([staleSteamGame]);
      expect(vault.getGameDetail(gameId)?.enrichedMetadata?.appId).toBe(2537590);

      // 2. Unlinked isExplicitNonSteam: true upsert with skeleton_fallback MUST replace the stale Steam blob!
      const unlinkedSkeletonGame: CanonicalGame = {
        ...staleSteamGame,
        steamAppId: undefined,
        isExplicitNonSteam: true,
        enrichedMetadata: {
          ...staleSteamGame.enrichedMetadata!,
          appId: 0,
          name: 'Delisted Non-Steam Skeleton',
          shortDescription: 'Delisted title fallback synopsis',
          screenshots: [],
          metadataQuality: 'skeleton_fallback',
        },
      };
      vault.upsertGames([unlinkedSkeletonGame]);
      const afterUnlinkedSkeleton = vault.getGameDetail(gameId);
      expect(afterUnlinkedSkeleton?.enrichedMetadata?.appId).toBe(0);
      expect(afterUnlinkedSkeleton?.enrichedMetadata?.name).toBe('Delisted Non-Steam Skeleton');

      // 3. Re-seed stale Steam blob, then upsert unlinked isExplicitNonSteam: true with __quotaSlimmed -> clears to null!
      vault.upsertGames([staleSteamGame]);
      const unlinkedSlimmedGame: CanonicalGame = {
        ...staleSteamGame,
        steamAppId: undefined,
        isExplicitNonSteam: true,
        enrichedMetadata: {
          ...staleSteamGame.enrichedMetadata!,
          appId: 0,
          __quotaSlimmed: true,
        },
      };
      vault.upsertGames([unlinkedSlimmedGame]);
      const afterUnlinkedSlimmed = vault.getGameDetail(gameId);
      expect(afterUnlinkedSlimmed?.enrichedMetadata).toBeNull();

      // 4. Re-seed stale Steam blob + steam_app_id = 2537590, then call saveGameDetail with
      // { isExplicitNonSteam: true, steamAppId: null } -> clears vault_games.steam_app_id to NULL
      // AND clears stale Steam enriched_json!
      vault.upsertGames([staleSteamGame]);
      const beforeRow = vault.db
        .prepare('SELECT steam_app_id, enriched_json FROM vault_games WHERE game_id = ?')
        .get(gameId) as { steam_app_id: number | null; enriched_json: unknown } | undefined;
      expect(beforeRow?.steam_app_id).toBe(2537590);
      expect(beforeRow?.enriched_json).not.toBeNull();

      vault.saveGameDetail({
        gameId,
        canonicalTitle: 'Synthetic Unlinked Flight Sim',
        steamAppId: null,
        isExplicitNonSteam: true,
        forceReplaceEnriched: true,
      });
      const afterSaveDetailRow = vault.db
        .prepare('SELECT steam_app_id, enriched_json, metadata_quality, enriched_at FROM vault_games WHERE game_id = ?')
        .get(gameId) as
        | {
            steam_app_id: number | null;
            enriched_json: unknown;
            metadata_quality: string;
            enriched_at: number;
          }
        | undefined;
      expect(afterSaveDetailRow?.steam_app_id).toBeNull();
      expect(afterSaveDetailRow?.enriched_json).toBeNull();
      expect(afterSaveDetailRow?.metadata_quality).toBe('skeleton_fallback');
      expect(afterSaveDetailRow?.enriched_at).toBe(0);

      // 5. Non-conflicting forceReplaceEnriched: true (NO platform conflict, NO Steam appId conflict)
      // still protects existing rich metadata against a rank-0 skeleton_fallback downgrade!
      const gogGameId = 'gog-777001';
      vault.saveGameDetail({
        gameId: gogGameId,
        canonicalTitle: 'Synthetic Non-Conflicting GOG Game',
        steamAppId: null,
        enrichedMetadata: {
          ...staleSteamGame.enrichedMetadata!,
          appId: 0,
          name: 'Rich GOG Metadata',
          metadataQuality: 'scraped',
        },
        metadataQuality: 'scraped',
      });
      vault.saveGameDetail({
        gameId: gogGameId,
        canonicalTitle: 'Synthetic Non-Conflicting GOG Game',
        steamAppId: null,
        forceReplaceEnriched: true,
        enrichedMetadata: {
          ...staleSteamGame.enrichedMetadata!,
          appId: 0,
          name: 'Empty Skeleton Downgrade',
          screenshots: [],
          metadataQuality: 'skeleton_fallback',
        },
        metadataQuality: 'skeleton_fallback',
      });
      expect(vault.getGameDetail(gogGameId)?.enrichedMetadata?.name).toBe('Rich GOG Metadata');
    } finally {
      vault.close();
    }
  });
});
