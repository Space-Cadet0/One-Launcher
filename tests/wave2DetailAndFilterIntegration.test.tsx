import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

import type { CanonicalGame } from '../src/contracts/game';
import type { SteamEnrichedMetadata } from '../src/contracts/steam';
import type { TagFacetCount, UserTagOverride } from '../src/contracts/tags';
import {
  DEFAULT_LIBRARY_FILTER_STATE,
  activeGameFilterToLibraryFilterState,
  doesLibraryFilterStateStillMatchActiveFilter,
} from '../src/contracts/filter';
import { SteamStorePage } from '../src/components/SteamStoreDetail/SteamStorePage';
import { SteamLibraryActionBar } from '../src/components/SteamStoreDetail/SteamLibraryActionBar';
import { steamApi } from '../src/services/steam/steamApi';
import { steamAchievementsService } from '../src/services/steam/steamAchievementsService';
import { fallbackMetadataProvider } from '../src/services/steam/fallbackMetadataProvider';
import { launcherService } from '../src/services/launcher/launcherService';
import {
  STORAGE_KEY_USER_TAG_OVERRIDES,
  USER_TAG_OVERRIDES_UPDATED_EVENT,
  addUserTagForGame,
  getUserTagOverrideForGame,
} from '../src/services/storage/userTagStorage';
import { hydrateCatalogFromIndexedDb } from '../src/services/integrations/integrationStorage';
import {
  createDomain12DeepRenderer,
  createMemoryStorage,
  findElements,
  getTextContent,
  makeCanonicalGameFixture,
} from './helpers/xboxTestHarness';

const ROOT_DIR = path.resolve(__dirname, '..');

function makeSteamMetaFixture(
  overrides: Partial<SteamEnrichedMetadata> = {}
): SteamEnrichedMetadata {
  return {
    appId: 0,
    name: 'Synthetic Fixture Game',
    shortDescription: 'Synthetic short description.',
    detailedDescription: '<p>Synthetic detailed description.</p>',
    aboutTheGame: '<p>Synthetic detailed description.</p>',
    headerImage: '',
    developers: ['Synthetic Studio'],
    publishers: ['Synthetic Publisher'],
    releaseDate: 'Jan 1, 2024',
    genres: ['RPG'],
    tags: ['Single-player'],
    categories: [],
    screenshots: [],
    movies: [],
    systemRequirements: {},
    reviewSummary: {
      reviewScore: 8,
      reviewScoreDesc: 'Very Positive',
      totalPositive: 800,
      totalNegative: 100,
      totalReviews: 900,
      positivePercent: 89,
    },
    ...overrides,
  };
}

function createEventedWindow(storage: Storage, platform: 'darwin' | 'win32' = 'darwin') {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  return {
    innerWidth: 1440,
    innerHeight: 900,
    localStorage: storage,
    location: { hostname: 'localhost' },
    electronAPI: {
      isElectron: true,
      platform,
      arch: platform === 'darwin' ? 'arm64' : 'x64',
    },
    addEventListener: (type: string, fn: (e: Event) => void) => {
      let bucket = listeners.get(type);
      if (!bucket) {
        bucket = new Set();
        listeners.set(type, bucket);
      }
      bucket.add(fn);
    },
    removeEventListener: (type: string, fn: (e: Event) => void) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (event: Event) => {
      const bucket = listeners.get(event.type);
      if (bucket) {
        for (const fn of Array.from(bucket)) {
          fn(event);
        }
      }
      return true;
    },
    open: vi.fn(),
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Wave 2 Integration: SteamStorePage (T2/T3/T6/T7), ActionBar (T5), Vault Tag Hydration & App.tsx Wiring (C9/C11)', () => {
  const globalRecord = globalThis as Record<string, unknown>;
  let prevWindow: unknown;
  let prevDocument: unknown;
  let prevLocalStorage: unknown;
  let mockStorage: Storage;

  beforeEach(() => {
    prevWindow = globalRecord.window;
    prevDocument = globalRecord.document;
    prevLocalStorage = globalRecord.localStorage;
    mockStorage = createMemoryStorage();

    globalRecord.localStorage = mockStorage;
    globalRecord.window = createEventedWindow(mockStorage, 'darwin');
    globalRecord.document = {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      querySelectorAll: () => [],
    };

    vi.spyOn(steamApi, 'fetchStoreBrowseAssets').mockResolvedValue(null);
    vi.spyOn(steamApi, 'getStoreBrowseAssetsInstant').mockReturnValue(null);
    vi.spyOn(steamApi, 'isStoreRateLimited').mockReturnValue(false);
    vi.spyOn(steamAchievementsService, 'fetchPlayerGameAchievements').mockResolvedValue(null);
    vi.spyOn(launcherService, 'isInGameHibernating').mockReturnValue(false);
    vi.spyOn(launcherService, 'getRunningGames').mockReturnValue([]);
    vi.spyOn(launcherService, 'isGameInstalled').mockReturnValue(false);
    vi.spyOn(launcherService, 'isGameRunning').mockReturnValue(false);
    vi.spyOn(launcherService, 'getActiveDownload').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevWindow === undefined) {
      delete globalRecord.window;
    } else {
      globalRecord.window = prevWindow;
    }
    if (prevDocument === undefined) {
      delete globalRecord.document;
    } else {
      globalRecord.document = prevDocument;
    }
    if (prevLocalStorage === undefined) {
      delete globalRecord.localStorage;
    } else {
      globalRecord.localStorage = prevLocalStorage;
    }
  });

  // ---------------------------------------------------------------------------
  // Task 2: Remove <Sparkles /> Icon Before "About This Game"
  // ---------------------------------------------------------------------------
  describe('Task 2 — Clean "About This Game" Heading Without Preceding Icon', () => {
    it('renders "About This Game" h2 without any Sparkles/SVG icon child or flex gap classes', () => {
      vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue(null);

      const game = makeCanonicalGameFixture({
        id: 'steam-1086940',
        steamAppId: 1086940,
        title: "Baldur's Gate 3",
        shortDescription: 'Gather your party and return to the Forgotten Realms.',
        detailedDescription: '<p>Rich story-driven RPG set in Faerun.</p>',
        platforms: [{ platformId: 'steam', platformGameId: '1086940', installed: false }],
      });

      const page = createDomain12DeepRenderer(SteamStorePage, {
        game,
        collections: [],
        connectedStorefronts: ['steam'],
      });
      const tree = page.render();

      const aboutHeading = findElements(
        tree,
        (el) => el.type === 'h2' && getTextContent(el).trim() === 'About This Game'
      )[0];
      expect(aboutHeading).toBeDefined();
      expect(aboutHeading.props.className).not.toContain('flex items-center gap-2');
      // Heading contains strictly the text "About This Game" and zero icon/SVG elements
      const svgChildren = findElements(
        aboutHeading,
        (el) => el.type === 'svg' || typeof el.type === 'function'
      );
      expect(svgChildren).toHaveLength(0);
      expect(getTextContent(aboutHeading).trim()).toBe('About This Game');

      page.unmount();
    });
  });

  // ---------------------------------------------------------------------------
  // Tasks 3 & 6 (C9): Requirements Persistence, __quotaSlimmed Heal, Mac & Linux Gating
  // ---------------------------------------------------------------------------
  describe('Tasks 3 & 6 (C9) — Requirements Change Persistence, __quotaSlimmed Healing & Multi-Store OS Specs', () => {
    it('persists newly fetched macRequirements on legacy Steam Mac titles via onGameUpdated and renders the macOS tab', async () => {
      const legacyMeta = makeSteamMetaFixture({
        appId: 1086940,
        name: "Baldur's Gate 3",
        metadataQuality: 'authoritative',
        shortDescription: 'Gather your party and return to the Forgotten Realms.',
        detailedDescription: '<p>Full RPG synopsis.</p>',
        aboutTheGame: '<p>Full RPG synopsis.</p>',
        developers: ['Larian Studios'],
        publishers: ['Larian Studios'],
        releaseDate: 'Aug 3, 2023',
        platforms: { windows: true, mac: true, linux: false },
        systemRequirements: {
          minimum: '<strong>Minimum:</strong> Windows 10 64-bit',
        },
        screenshots: [
          {
            id: 1,
            pathThumbnail: 'https://cdn.example/1t.jpg',
            pathFull: 'https://cdn.example/1.jpg',
          },
        ],
      });

      const upgradedMeta: SteamEnrichedMetadata = {
        ...legacyMeta,
        fetchedAt: Date.now(),
        macRequirements: {
          minimum: '<strong>Minimum:</strong> macOS 14.7.1 Apple Silicon M1',
        },
      };

      vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue(upgradedMeta);

      const game = makeCanonicalGameFixture({
        id: 'steam-1086940',
        steamAppId: 1086940,
        title: "Baldur's Gate 3",
        shortDescription: legacyMeta.shortDescription,
        detailedDescription: legacyMeta.detailedDescription,
        developers: ['Larian Studios'],
        publishers: ['Larian Studios'],
        releaseDate: 'Aug 3, 2023',
        platforms: [{ platformId: 'steam', platformGameId: '1086940', installed: true }],
        enrichedMetadata: legacyMeta,
      });

      const onGameUpdated = vi.fn();
      const page = createDomain12DeepRenderer(SteamStorePage, {
        game,
        collections: [],
        connectedStorefronts: ['steam'],
        onGameUpdated,
      });

      page.render();
      await flushMicrotasks();
      await flushMicrotasks();
      // First render passes new macRequirements into SystemRequirements; second flushes SystemRequirements tab auto-select effect on darwin
      page.render();
      const settledTree = page.render();

      expect(onGameUpdated).toHaveBeenCalledTimes(1);
      const updatedGame = onGameUpdated.mock.calls[0][0] as CanonicalGame;
      expect(updatedGame.enrichedMetadata?.macRequirements?.minimum).toContain('macOS 14.7.1');

      const settledText = getTextContent(settledTree);
      expect(settledText).toContain('macOS 14.7.1 Apple Silicon M1');

      page.unmount();
    });

    it('detects __quotaSlimmed persisted metadata and persists healed non-slimmed Steam metadata via onGameUpdated', async () => {
      const slimmedMeta = makeSteamMetaFixture({
        appId: 374320,
        name: 'DARK SOULS III',
        metadataQuality: 'authoritative',
        __quotaSlimmed: true,
        hasScreenshotsCount: 8,
        shortDescription: '',
        detailedDescription: '',
        aboutTheGame: '',
        screenshots: [],
        movies: [],
      });

      const healedMeta = makeSteamMetaFixture({
        appId: 374320,
        name: 'DARK SOULS III',
        metadataQuality: 'authoritative',
        fetchedAt: Date.now(),
        shortDescription: 'Dark Souls continues to push the boundaries.',
        detailedDescription: '<p>Embrace the darkness.</p>',
        aboutTheGame: '<p>Embrace the darkness.</p>',
        systemRequirements: { minimum: 'Windows 10 64-bit' },
        screenshots: [
          {
            id: 1,
            pathThumbnail: 'https://cdn.example/ds3t.jpg',
            pathFull: 'https://cdn.example/ds3.jpg',
          },
        ],
      });

      vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue(healedMeta);

      const game = makeCanonicalGameFixture({
        id: 'steam-374320',
        steamAppId: 374320,
        title: 'DARK SOULS III',
        shortDescription: '',
        detailedDescription: '',
        platforms: [{ platformId: 'steam', platformGameId: '374320', installed: false }],
        enrichedMetadata: slimmedMeta,
      });

      const onGameUpdated = vi.fn();
      const page = createDomain12DeepRenderer(SteamStorePage, {
        game,
        collections: [],
        connectedStorefronts: ['steam'],
        onGameUpdated,
      });

      page.render();
      await flushMicrotasks();
      await flushMicrotasks();

      expect(onGameUpdated).toHaveBeenCalledTimes(1);
      const updated = onGameUpdated.mock.calls[0][0] as CanonicalGame;
      expect(updated.enrichedMetadata?.__quotaSlimmed).toBeUndefined();
      expect(updated.shortDescription).toContain('Dark Souls continues');

      page.unmount();
    });

    it('enables live Steam macRequirements on Steam, renders GOG/Epic linuxRequirements, and keeps Xbox PC builds strictly isolated', () => {
      vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue(null);
      vi.spyOn(fallbackMetadataProvider, 'getEnrichedMetadataForNonSteamGame').mockResolvedValue(
        makeSteamMetaFixture({ metadataQuality: 'skeleton_fallback' })
      );

      // 1. Live Steam metadata discovering platforms.mac === true shows macOS tab on Steam
      const steamLiveMacMeta = makeSteamMetaFixture({
        appId: 555001,
        name: 'Steam Live Mac Discovery',
        metadataQuality: 'authoritative',
        platforms: { windows: true, mac: true, linux: true },
        systemRequirements: { minimum: 'Windows 10' },
        macRequirements: { minimum: 'macOS 13 Ventura' },
        linuxRequirements: { minimum: 'Ubuntu 22.04 LTS' },
      });
      const steamGame = makeCanonicalGameFixture({
        id: 'steam-555001',
        steamAppId: 555001,
        title: 'Steam Live Mac Discovery',
        nativePlatforms: ['windows'],
        platforms: [{ platformId: 'steam', platformGameId: '555001', installed: false }],
        enrichedMetadata: steamLiveMacMeta,
      });
      const steamPage = createDomain12DeepRenderer(SteamStorePage, {
        game: steamGame,
        collections: [],
        connectedStorefronts: ['steam'],
      });
      const steamTree = steamPage.render();
      const steamMacTab = findElements(
        steamTree,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'macOS'
      );
      const steamLinuxTab = findElements(
        steamTree,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Linux'
      );
      expect(steamMacTab.length).toBeGreaterThanOrEqual(1);
      expect(steamLinuxTab.length).toBeGreaterThanOrEqual(1);
      steamPage.unmount();

      // 2. GOG game with native Linux specs renders the Linux tab
      const gogLinuxMeta = makeSteamMetaFixture({
        appId: 0,
        name: 'GOG Linux Adventure',
        metadataQuality: 'scraped',
        enrichedSource: 'gog',
        platforms: { windows: true, mac: true, linux: true },
        systemRequirements: { minimum: 'Windows 10' },
        macRequirements: { minimum: 'macOS 12' },
        linuxRequirements: { minimum: 'Ubuntu 20.04 64-bit' },
      });
      const gogGame = makeCanonicalGameFixture({
        id: 'gog-123456',
        title: 'GOG Linux Adventure',
        isExplicitNonSteam: true,
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '123456',
            installed: false,
            platforms: { windows: true, mac: true, linux: true },
          },
        ],
        enrichedMetadata: gogLinuxMeta,
      });
      const gogPage = createDomain12DeepRenderer(SteamStorePage, {
        game: gogGame,
        collections: [],
        connectedStorefronts: ['gog'],
      });
      const gogTree = gogPage.render();
      const gogLinuxTab = findElements(
        gogTree,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Linux'
      );
      expect(gogLinuxTab.length).toBeGreaterThanOrEqual(1);
      gogPage.unmount();

      // 3. Epic game with Epic-sourced Linux specs renders the Linux tab
      const epicLinuxMeta = makeSteamMetaFixture({
        appId: 0,
        name: 'Epic Multi-OS Game',
        metadataQuality: 'scraped',
        enrichedSource: 'epic',
        platforms: { windows: true, mac: true, linux: true },
        systemRequirements: { minimum: 'Windows 10' },
        macRequirements: { minimum: 'macOS 13' },
        linuxRequirements: { minimum: 'Debian 12 64-bit' },
      });
      const epicGame = makeCanonicalGameFixture({
        id: 'epic-multi-os',
        title: 'Epic Multi-OS Game',
        isExplicitNonSteam: true,
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'epic-multi-os',
            installed: false,
            platforms: { windows: true, mac: true, linux: true },
          },
        ],
        enrichedMetadata: epicLinuxMeta,
      });
      const epicPage = createDomain12DeepRenderer(SteamStorePage, {
        game: epicGame,
        collections: [],
        connectedStorefronts: ['epic'],
      });
      const epicTree = epicPage.render();
      const epicLinuxTab = findElements(
        epicTree,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Linux'
      );
      expect(epicLinuxTab.length).toBeGreaterThanOrEqual(1);
      epicPage.unmount();

      // 4. Xbox PC build with cross-matched Steam metadata NEVER leaks macRequirements or linuxRequirements
      const xboxGame = makeCanonicalGameFixture({
        id: 'xbox-9NXBOXONLY01',
        steamAppId: 555001,
        title: 'Xbox PC Only Build',
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: '9NXBOXONLY01',
            xboxProductId: '9NXBOXONLY01',
            installed: false,
            platforms: { windows: true, mac: false, linux: false },
          },
        ],
        enrichedMetadata: steamLiveMacMeta,
      });
      const xboxPage = createDomain12DeepRenderer(SteamStorePage, {
        game: xboxGame,
        collections: [],
        connectedStorefronts: ['xbox'],
      });
      const xboxTree = xboxPage.render();
      expect(
        findElements(xboxTree, (el) => el.type === 'button' && getTextContent(el).trim() === 'macOS')
      ).toHaveLength(0);
      expect(
        findElements(xboxTree, (el) => el.type === 'button' && getTextContent(el).trim() === 'Linux')
      ).toHaveLength(0);
      xboxPage.unmount();
    });
  });

  // ---------------------------------------------------------------------------
  // Task 7: SteamStorePage Tag Manager Popover Wiring & Vault Hydration
  // ---------------------------------------------------------------------------
  describe('Task 7 — SteamStorePage Tag Manager Wiring & Vault Tag Hydration', () => {
    it('passes availableLibraryTags to TagManagerPopover, prioritizes user-added tags, and updates reactively on USER_TAG_OVERRIDES_UPDATED_EVENT', () => {
      vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue(null);

      const game = makeCanonicalGameFixture({
        id: 'steam-292030',
        steamAppId: 292030,
        title: 'The Witcher 3: Wild Hunt',
        platforms: [{ platformId: 'steam', platformGameId: '292030', installed: true }],
        tags: ['Single-player', 'RPG', 'Open World'],
      });

      const libraryTags: TagFacetCount[] = [
        { key: 'single-player', label: 'Single-player', count: 42 },
        { key: 'story rich', label: 'Story Rich', count: 19 },
        { key: 'cozy', label: 'Cozy', count: 7 },
      ];

      const page = createDomain12DeepRenderer(SteamStorePage, {
        game,
        collections: [],
        availableLibraryTags: libraryTags,
        connectedStorefronts: ['steam'],
      });

      const tree1 = page.render();
      // Library tag option from availableLibraryTags is wired into TagManagerPopover
      const storyRichOption = findElements(
        tree1,
        (el) => el.props?.['data-testid'] === 'tag-manager-option-story rich'
      )[0];
      expect(storyRichOption).toBeDefined();

      // Click option to add "Story Rich" via SteamStorePage -> onAddTag
      storyRichOption.props.onClick();
      const tree2 = page.render();

      const heroTagButtons = findElements(
        tree2,
        (el) => el.type === 'button' && typeof el.props?.['data-tag-source'] === 'string'
      );
      expect(heroTagButtons[0]?.props?.['data-tag-source']).toBe('user');
      expect(getTextContent(heroTagButtons[0])).toBe('Story Rich');
      expect(getUserTagOverrideForGame(game)?.addedTags).toEqual(['Story Rich']);

      // External update via USER_TAG_OVERRIDES_UPDATED_EVENT refreshes SteamStorePage immediately
      addUserTagForGame(game, 'Deck Favorite', game.tags);
      const tree3 = page.render();
      const updatedHeroTags = findElements(
        tree3,
        (el) => el.type === 'button' && typeof el.props?.['data-tag-source'] === 'string'
      ).map((el) => getTextContent(el));
      expect(updatedHeroTags.slice(0, 2)).toEqual(['Story Rich', 'Deck Favorite']);

      // Reset restores synced tags cleanly
      const resetBtn = findElements(
        tree3,
        (el) => el.props?.['data-testid'] === 'tag-manager-reset-btn'
      )[0];
      expect(resetBtn).toBeDefined();
      resetBtn.props.onClick();
      const tree4 = page.render();
      expect(getUserTagOverrideForGame(game)).toBeUndefined();
      const resetHeroTags = findElements(
        tree4,
        (el) => el.type === 'button' && typeof el.props?.['data-tag-source'] === 'string'
      );
      expect(resetHeroTags.every((el) => el.props['data-tag-source'] === 'synced')).toBe(true);

      page.unmount();
    });

    it('hydrates user tag overrides from offlineVault during hydrateCatalogFromIndexedDb()', async () => {
      const vaultTagRecord: UserTagOverride = {
        gameId: 'steam-1086940',
        platformAliases: ['steam:1086940'],
        addedTags: ['Vault Hydrated Tag'],
        removedTags: ['Family Sharing'],
        updatedAt: '2026-11-20T12:00:00.000Z',
      };
      const getUserTagOverridesMock = vi.fn().mockResolvedValue({
        'steam-1086940': vaultTagRecord,
      });

      const win = globalRecord.window as Record<string, unknown>;
      win.electronAPI = {
        isElectron: true,
        platform: 'darwin',
        arch: 'arm64',
        offlineVault: {
          getUserOverrides: vi.fn().mockResolvedValue({}),
          getUserTagOverrides: getUserTagOverridesMock,
          getCatalogSnapshot: vi.fn().mockResolvedValue({ success: false, games: [] }),
        },
      };

      await hydrateCatalogFromIndexedDb();

      expect(getUserTagOverridesMock).toHaveBeenCalledTimes(1);
      const rawStored = mockStorage.getItem(STORAGE_KEY_USER_TAG_OVERRIDES);
      expect(rawStored).toContain('Vault Hydrated Tag');
      expect(
        getUserTagOverrideForGame({ id: 'steam-1086940', steamAppId: 1086940 })?.addedTags
      ).toEqual(['Vault Hydrated Tag']);
    });
  });

  // ---------------------------------------------------------------------------
  // Task 5: SteamLibraryActionBar Consolidated Host Capabilities
  // ---------------------------------------------------------------------------
  describe('Task 5 — SteamLibraryActionBar Host Capabilities Consolidation', () => {
    it('routes isWindowsHost through launcherService.getHostCapabilities().isWindows', () => {
      const game = makeCanonicalGameFixture({
        id: 'steam-1091500',
        steamAppId: 1091500,
        title: 'Cyberpunk 2077',
        platforms: [{ platformId: 'steam', platformGameId: '1091500', installed: true }],
      });

      const getCapsSpy = vi.spyOn(launcherService, 'getHostCapabilities');
      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('win32');
      const winBar = createDomain12DeepRenderer(SteamLibraryActionBar, {
        game,
        collections: [],
        connectedStorefronts: ['steam'],
      });
      const winTreeInitial = winBar.render();
      const winManageBtn = findElements(
        winTreeInitial,
        (el) => el.type === 'button' && el.props?.['aria-label'] === 'Manage Game'
      )[0];
      expect(winManageBtn).toBeDefined();
      winManageBtn.props.onClick();
      const winMenuText = getTextContent(winBar.render());
      expect(winMenuText).toContain('Launch Settings...');
      expect(winMenuText).not.toContain('Launch & Compatibility Settings...');
      expect(getCapsSpy).toHaveBeenCalled();
      winBar.unmount();

      vi.spyOn(launcherService, 'getHostPlatform').mockReturnValue('darwin');
      const macBar = createDomain12DeepRenderer(SteamLibraryActionBar, {
        game,
        collections: [],
        connectedStorefronts: ['steam'],
      });
      const macTreeInitial = macBar.render();
      const macManageBtn = findElements(
        macTreeInitial,
        (el) => el.type === 'button' && el.props?.['aria-label'] === 'Manage Game'
      )[0];
      expect(macManageBtn).toBeDefined();
      macManageBtn.props.onClick();
      const macMenuText = getTextContent(macBar.render());
      expect(macMenuText).toContain('Launch & Compatibility Settings...');
      macBar.unmount();
    });
  });

  // ---------------------------------------------------------------------------
  // Task 8 & C11: activeFilter Chip Desync Prevention + App.tsx Wiring
  // ---------------------------------------------------------------------------
  describe('Task 8 & C11 — activeFilter Synchronization & Cross-App Wiring', () => {
    it('clears stale activeFilter when its matching Tag/Genre/Creator/Feature chip is removed or criteria hit zero', () => {
      const tagFilter = { type: 'tag' as const, label: 'Tag', value: 'Cozy' };
      const initialState = activeGameFilterToLibraryFilterState(tagFilter);
      expect(initialState.tags).toEqual(['Cozy']);

      // Still matches initially
      expect(doesLibraryFilterStateStillMatchActiveFilter(tagFilter, initialState)).toBe(true);

      // Adding an orthogonal facet (Genre) keeps Tag activeFilter valid
      const withGenre = { ...initialState, genres: ['rpg'] };
      expect(doesLibraryFilterStateStillMatchActiveFilter(tagFilter, withGenre)).toBe(true);

      // Removing the Tag chip while Genre stays active -> returns false so App clears stale activeFilter
      const afterRemoveTagChip = { ...withGenre, tags: [] };
      expect(doesLibraryFilterStateStillMatchActiveFilter(tagFilter, afterRemoveTagChip)).toBe(
        false
      );

      // Removing the only Tag chip (0 active criteria) -> returns false
      const emptyState = { ...initialState, tags: [] };
      expect(doesLibraryFilterStateStillMatchActiveFilter(tagFilter, emptyState)).toBe(false);

      // Broadening Tags in ANY mode (adding a second tag) clears single-value activeFilter so OR works
      const broadenedAny = { ...initialState, tags: ['Cozy', 'indie'], tagMatchMode: 'any' as const };
      expect(doesLibraryFilterStateStillMatchActiveFilter(tagFilter, broadenedAny)).toBe(false);

      // Narrowing Tags in ALL mode preserves activeFilter since 'Cozy' is still required
      const narrowedAll = { ...initialState, tags: ['Cozy', 'indie'], tagMatchMode: 'all' as const };
      expect(doesLibraryFilterStateStillMatchActiveFilter(tagFilter, narrowedAll)).toBe(true);

      // Genre, Creator, Feature, and OS chip removals also return false
      const creatorFilter = { type: 'developer' as const, label: 'Developer', value: 'Larian Studios' };
      const creatorState = activeGameFilterToLibraryFilterState(creatorFilter);
      expect(
        doesLibraryFilterStateStillMatchActiveFilter(creatorFilter, {
          ...creatorState,
          creators: [],
          genres: ['rpg'],
        })
      ).toBe(false);

      const featureFilter = { type: 'feature' as const, label: 'Feature', value: 'HDR available' };
      const featureState = activeGameFilterToLibraryFilterState(featureFilter);
      expect(
        doesLibraryFilterStateStillMatchActiveFilter(featureFilter, {
          ...featureState,
          features: [],
          tags: ['cozy'],
        })
      ).toBe(false);

      // Unmapped activeFilter clears when all filter criteria are cleared to 0
      const franchiseFilter = { type: 'franchise' as const, label: 'Franchise', value: 'Witcher' };
      expect(
        doesLibraryFilterStateStillMatchActiveFilter(franchiseFilter, DEFAULT_LIBRARY_FILTER_STATE)
      ).toBe(false);
    });

    it('wires tagOverridesVersion, availableLibraryTags, ignoreLeadingTheWhenSorting, host-aware Setup Wizard initialStep, and handleUpdateLibraryFilterState in src/App.tsx', () => {
      const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/App.tsx'), 'utf8');

      // 1. USER_TAG_OVERRIDES_UPDATED_EVENT -> tagOverridesVersion -> libraryFilterIndex deps
      expect(appSrc).toContain('USER_TAG_OVERRIDES_UPDATED_EVENT');
      expect(appSrc).toContain('[games, gameRefreshKey, tagOverridesVersion]');

      // 2. availableLibraryTags passed to SteamStorePage
      expect(appSrc).toContain('availableLibraryTags={libraryFilterIndex.tagCounts}');

      // 3. ignoreLeadingTheWhenSorting subscribed via launcherService and passed to both Sidebar & GridView
      expect(appSrc).toContain('ignoreLeadingTheWhenSorting={ignoreLeadingTheWhenSorting}');
      expect(
        (appSrc.match(/ignoreLeadingTheWhenSorting=\{ignoreLeadingTheWhenSorting\}/g) || []).length
      ).toBeGreaterThanOrEqual(2);

      // 4. Host-aware initialStep when Settings opens Setup Wizard
      expect(appSrc).toContain(
        "launcherService.getHostCapabilities().supportsWindowsTranslation\n        ? 'compatibility'\n        : 'prerequisites'"
      );

      // 5. C11 wrapped onUpdateLibraryFilterState passed to LibraryGridView
      expect(appSrc).toContain('onUpdateLibraryFilterState={handleUpdateLibraryFilterState}');
      expect(appSrc).toContain('doesLibraryFilterStateStillMatchActiveFilter');
    });
  });

  // ---------------------------------------------------------------------------
  // Non-Negotiable AST Gate: Zero `any` (`SyntaxKind.AnyKeyword`) Across Wave 2 src/**
  // ---------------------------------------------------------------------------
  describe('Static AST Gate — Zero AnyKeyword Across All Wave 2 Owned src/** Files', () => {
    const WAVE2_SRC_FILES = [
      'src/contracts/filter.ts',
      'src/services/filter/libraryFilterIndex.ts',
      'src/components/Library/LibraryFilterPanel.tsx',
      'src/components/Library/Grid/LibraryGridToolbar.tsx',
      'src/components/SteamStoreDetail/SteamStorePage.tsx',
      'src/components/SteamStoreDetail/SteamLibraryActionBar.tsx',
      'src/services/integrations/integrationStorage.ts',
      'src/App.tsx',
    ];

    it('contains zero TypeScript AnyKeyword nodes in every Wave 2 src/** file', () => {
      const violations: string[] = [];

      for (const relPath of WAVE2_SRC_FILES) {
        const absPath = path.join(ROOT_DIR, relPath);
        const content = fs.readFileSync(absPath, 'utf8');
        const sf = ts.createSourceFile(
          absPath,
          content,
          ts.ScriptTarget.Latest,
          true,
          relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );

        const visit = (node: ts.Node) => {
          if (node.kind === ts.SyntaxKind.AnyKeyword) {
            const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            violations.push(`${relPath}:${line + 1}:${character + 1}`);
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }

      expect(violations).toEqual([]);
    });
  });
});
