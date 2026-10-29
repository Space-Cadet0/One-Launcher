import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  isTitleCompatible,
  generateMetacriticSlugCandidates,
} from '../src/services/critic/metacriticResolver';
import { criticScoreService } from '../src/services/critic/criticScoreService';
import {
  saveStagedCache,
  loadStagedCache,
  MutabilityTier,
} from '../src/services/storage/stagedCacheService';
import { SyncJobManager } from '../src/services/network/syncJobManager';
import { OpenCriticCard } from '../src/components/SteamStoreDetail/OpenCriticCard';
import {
  loadCollections,
  saveCollections,
  DEFAULT_COLLECTION_ICONS,
} from '../src/services/storage/collectionStorage';
import { useCollectionsManager } from '../src/hooks/useCollectionsManager';
import { ManageCollectionsModal } from '../src/components/Library/ManageCollectionsModal';
import {
  CollectionIcon,
  getEffectiveCollectionIconId,
} from '../src/components/Common/CollectionIcon';
import {
  getNativeOsPlatforms,
  getStorefrontNativeOsPlatforms,
  getStorefrontNativeOsFlags,
  isNativelyAvailableOnMac,
  isNativelyAvailableOnWindows,
  matchesNativeOsQuery,
} from '../src/services/platform/nativeOsService';
import { matchesGameFilter } from '../src/services/filter/gameFilterService';
import { NativeOsBadges } from '../src/components/Common/NativeOsBadges';
import { LibraryGridView } from '../src/components/Library/LibraryGridView';
import { SteamStorePage } from '../src/components/SteamStoreDetail/SteamStorePage';
import { CanonicalGame } from '../src/contracts/game';
import { CriticScoreData } from '../src/contracts/critic';

// ---------------------------------------------------------------------------
// Headless Browser Environment Polyfills
// ---------------------------------------------------------------------------
class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

const mockStorage = new MockStorage();

if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = mockStorage;
}

const eventTarget = new EventTarget();

if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = {
    addEventListener: (type: string, listener: any) => eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: any) =>
      eventTarget.removeEventListener(type, listener),
    dispatchEvent: (event: any) => eventTarget.dispatchEvent(event),
    localStorage: mockStorage,
    location: { hostname: 'example.com' },
    open: vi.fn(),
  };
}

if (typeof (globalThis as any).CustomEvent === 'undefined') {
  (globalThis as any).CustomEvent = class CustomEvent {
    type: string;
    detail: any;
    constructor(type: string, init?: any) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
}

// Helper to run functional React components / hooks with stateful interactions in SSR/Node tests
function createHookHarness<T>(renderFn: () => T) {
  const states: any[] = [];
  const effectsRan: boolean[] = [];

  const run = (): T => {
    let stateIdx = 0;
    let effectIdx = 0;
    const internals = (React as any)
      .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prevH = internals.H;
    internals.H = {
      useState(initial: any) {
        const idx = stateIdx++;
        if (idx >= states.length) {
          states.push(typeof initial === 'function' ? initial() : initial);
        }
        const setState = (updater: any) => {
          states[idx] = typeof updater === 'function' ? updater(states[idx]) : updater;
        };
        return [states[idx], setState];
      },
      useEffect(fn: () => any) {
        const idx = effectIdx++;
        if (!effectsRan[idx]) {
          effectsRan[idx] = true;
          fn();
        }
      },
      useRef(initial: any) {
        return { current: initial };
      },
      useMemo(fn: () => any) {
        return fn();
      },
      useCallback(fn: any) {
        return fn;
      },
    };
    try {
      return renderFn();
    } finally {
      internals.H = prevH;
    }
  };

  return { run, states };
}

function findElements(node: any, predicate: (el: any) => boolean, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, acc);
    return acc;
  }
  if (predicate(node)) acc.push(node);
  if (node.props && node.props.children) {
    findElements(node.props.children, predicate, acc);
  }
  return acc;
}

describe('Review Sync Deduplication, Reviews Card Cleanup, Collection Icons & Native OS Support', () => {
  beforeEach(() => {
    localStorage.clear();
    criticScoreService.clearCache();
  });

  // ===========================================================================
  // 1. BUG 1 FIXES: REPEATED STARTUP REVIEW SCORE SYNCING
  // ===========================================================================
  describe('1. Bug 1 Fixes: Repeated Startup Review Score Syncing', () => {
    it('isTitleCompatible accepts edition suffixes replacing original release subtitles ("Trine 4: Definitive Edition" vs "trine 4 the nightmare prince") while rejecting sequel mismatches', () => {
      expect(
        isTitleCompatible('Trine 4: Definitive Edition', 'trine 4 the nightmare prince')
      ).toBe(true);
      expect(
        isTitleCompatible('Trine 4: Definitive Edition', 'Trine 4: The Nightmare Prince')
      ).toBe(true);

      // Must still reject sequel mismatches and distinct non-edition subtitles
      expect(isTitleCompatible('Trine 3', 'Trine 4: The Nightmare Prince')).toBe(false);
      expect(isTitleCompatible('Trine 4: Definitive Edition', 'Trine 3: The Artifacts of Power')).toBe(
        false
      );
      expect(isTitleCompatible('Quake II RTX', 'Quake II Enhanced Edition')).toBe(false);
    });

    it('generateMetacriticSlugCandidates collapses dotted acronyms ("S.T.A.L.K.E.R. 2: Heart of Chornobyl" -> "stalker-2-heart-of-chornobyl" in top 3)', () => {
      const candidates = generateMetacriticSlugCandidates('S.T.A.L.K.E.R. 2: Heart of Chornobyl');
      expect(candidates.slice(0, 3)).toContain('stalker-2-heart-of-chornobyl');
    });

    it('criticScoreService.getCriticScore heals a poisoned id:<steamAppId> cache entry (2186680 with mc-nights-into-dreams-2012) from a valid title:<title> entry and persists the healed id:<steamAppId>', () => {
      const appId = 2186680;
      const title = 'Warhammer 40,000: Rogue Trader';
      const lowerTitle = title.toLowerCase();

      const poisonedIdData: CriticScoreData = {
        id: 'mc-nights-into-dreams-2012',
        source: 'metacritic',
        score: 72,
        tier: 'Fair',
        numReviews: 14,
        url: 'https://www.metacritic.com/game/nights-into-dreams-2012/',
        summary: 'NiGHTS into dreams... review consensus.',
        isVerified: true,
      };

      const validTitleData: CriticScoreData = {
        id: 'mc-warhammer-40000-rogue-trader',
        source: 'metacritic',
        score: 75,
        tier: 'Strong',
        numReviews: 52,
        url: 'https://www.metacritic.com/game/warhammer-40000-rogue-trader/',
        summary: 'Warhammer 40,000: Rogue Trader review consensus.',
        isVerified: true,
      };

      saveStagedCache(
        `antigravity_critic_v8_id:${appId}`,
        poisonedIdData,
        MutabilityTier.TIER_2_MATURE,
        { source: 'metacritic', isVerified: true, dynamicResolved: true }
      );
      saveStagedCache(
        `antigravity_critic_v8_title:${lowerTitle}`,
        validTitleData,
        MutabilityTier.TIER_2_MATURE,
        { source: 'metacritic', isVerified: true, dynamicResolved: true }
      );

      const resolved = criticScoreService.getCriticScore(
        appId,
        title,
        undefined,
        2023,
        null,
        false,
        true
      );

      expect(resolved).not.toBeNull();
      expect(resolved?.id).toBe('mc-warhammer-40000-rogue-trader');
      expect(resolved?.score).toBe(75);
      expect(resolved?.url).toContain('warhammer-40000-rogue-trader');

      // Verify localStorage id:2186680 was healed and persisted with the valid Rogue Trader entry
      const healedStaged = loadStagedCache<CriticScoreData>(
        `antigravity_critic_v8_id:${appId}`,
        false
      );
      expect(healedStaged.valid).toBe(true);
      expect(healedStaged.data?.id).toBe('mc-warhammer-40000-rogue-trader');
      expect(healedStaged.data?.score).toBe(75);
      expect(healedStaged.entry?.dynamicResolved).toBe(true);
      expect(criticScoreService.hasValidCachedResolution(appId, title)).toBe(true);
    });

    it('hasValidCachedResolution returns true for TIER_0_USER_OVERRIDE unrated null entries and dynamicResolved entries, and startCriticScoreSync skips them without duplicate runs', async () => {
      const stalkerTitle = 'S.T.A.L.K.E.R. 2: Heart of Chornobyl';
      const trineTitle = 'Trine 4: Definitive Edition';
      const uncachedTitle = 'Brand New Uncached Indie 2026';

      // 1. Save explicit TIER_0_USER_OVERRIDE unrated null for S.T.A.L.K.E.R. 2
      saveStagedCache<CriticScoreData>(
        `antigravity_critic_v8_title:${stalkerTitle.toLowerCase()}`,
        null,
        MutabilityTier.TIER_0_USER_OVERRIDE
      );
      expect(criticScoreService.hasValidCachedResolution(undefined, stalkerTitle)).toBe(true);

      // 2. Save dynamicResolved: true score for Trine 4: Definitive Edition
      saveStagedCache<CriticScoreData>(
        `antigravity_critic_v8_title:${trineTitle.toLowerCase()}`,
        {
          id: 'mc-trine-4-the-nightmare-prince',
          source: 'metacritic',
          score: 80,
          tier: 'Strong',
          numReviews: 38,
          url: 'https://www.metacritic.com/game/trine-4-the-nightmare-prince/',
          isVerified: true,
        },
        MutabilityTier.TIER_1_IMMUTABLE,
        { source: 'metacritic', isVerified: true, dynamicResolved: true }
      );
      expect(criticScoreService.hasValidCachedResolution(undefined, trineTitle)).toBe(true);
      expect(criticScoreService.hasValidCachedResolution(undefined, uncachedTitle)).toBe(false);

      // 3. Verify startCriticScoreSync skips S.T.A.L.K.E.R. 2 and Trine 4 during background startup sync
      // and ignores duplicate background invocations while already running
      const manager = new SyncJobManager();
      const resolvedTitles: string[] = [];
      let releaseResolution!: () => void;
      const resolutionGate = new Promise<void>((r) => {
        releaseResolution = r;
      });

      const resolveSpy = vi
        .spyOn(criticScoreService, 'resolveDynamicScore')
        .mockImplementation(async (title: string) => {
          resolvedTitles.push(title);
          await resolutionGate;
          return null;
        });

      const games: CanonicalGame[] = [
        {
          id: 'gog-stalker2',
          title: stalkerTitle,
          sortTitle: stalkerTitle,
          isExplicitNonSteam: true,
          platforms: [{ platformId: 'gog', platformGameId: 'stalker2', installed: false }],
          headerImage: '',
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        },
        {
          id: 'epic-trine4',
          title: trineTitle,
          sortTitle: trineTitle,
          isExplicitNonSteam: true,
          platforms: [{ platformId: 'epic', platformGameId: 'trine4', installed: false }],
          headerImage: '',
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        },
        {
          id: 'gog-uncached-2026',
          title: uncachedTitle,
          sortTitle: uncachedTitle,
          isExplicitNonSteam: true,
          platforms: [{ platformId: 'gog', platformGameId: 'uncached2026', installed: false }],
          headerImage: '',
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        },
      ];

      try {
        const firstSyncPromise = manager.startCriticScoreSync(games, {
          isBackgroundWarmup: true,
        });

        // Wait a tick for the loop to enter resolveDynamicScore
        await new Promise((r) => setTimeout(r, 10));
        expect(manager.getState()?.status).toBe('running');
        expect(manager.getState()?.total).toBe(1);
        expect(manager.getState()?.currentItemName).toBe(uncachedTitle);

        // Trigger a second concurrent background warmup — must be a no-op!
        await manager.startCriticScoreSync(games, { isBackgroundWarmup: true });

        releaseResolution();
        await firstSyncPromise;

        expect(resolvedTitles).toEqual([uncachedTitle]);
        expect(resolvedTitles).not.toContain(stalkerTitle);
        expect(resolvedTitles).not.toContain(trineTitle);
      } finally {
        resolveSpy.mockRestore();
      }
    });
  });

  // ===========================================================================
  // 2. CHANGE 1: REMOVE CRITIC CONSENSUS IN REVIEWS CARD
  // ===========================================================================
  describe('2. Change 1: Remove Critic Consensus in OpenCriticCard', () => {
    it('does not render "Critic Consensus:" or openCritic.summary even when openCritic.summary is populated', () => {
      const sampleScore: CriticScoreData = {
        id: 'mc-baldurs-gate-3',
        source: 'metacritic',
        score: 96,
        tier: 'Mighty',
        percentRecommended: 98,
        numReviews: 118,
        url: 'https://www.metacritic.com/game/baldurs-gate-3/',
        summary: 'THIS_SUMMARY_TEXT_MUST_NEVER_BE_RENDERED_IN_OPENCRITIC_CARD',
        isVerified: true,
      };

      const html = renderToString(
        React.createElement(OpenCriticCard, {
          openCritic: sampleScore,
          gameTitle: "Baldur's Gate 3",
        })
      );

      expect(html).toContain('Metacritic Reviews');
      expect(html).toContain('96');
      expect(html).not.toContain('Critic Consensus:');
      expect(html).not.toContain('THIS_SUMMARY_TEXT_MUST_NEVER_BE_RENDERED_IN_OPENCRITIC_CARD');
    });
  });

  // ===========================================================================
  // 3. ENHANCEMENT 1: COLLECTION ICONS & EDITING
  // ===========================================================================
  describe('3. Enhancement 1: Collection Icons & Editing', () => {
    it('backfills default icons on default collections and supports creating & editing icons on both default and custom collections via useCollectionsManager and ManageCollectionsModal', () => {
      // Simulate legacy stored collections missing the icon property
      localStorage.setItem(
        'antigravity_user_collections',
        JSON.stringify([
          { id: 'favorites', name: 'Favorites', isDefault: true, gameIds: [] },
          { id: 'currently-playing', name: 'Currently Playing', isDefault: true, gameIds: [] },
          { id: 'backlog', name: 'Backlog', isDefault: false, gameIds: [] },
          { id: 'completed', name: 'Completed', isDefault: false, gameIds: [] },
        ])
      );

      const loaded = loadCollections();
      expect(loaded.find((c) => c.id === 'favorites')?.icon).toBe(DEFAULT_COLLECTION_ICONS.favorites);
      expect(loaded.find((c) => c.id === 'currently-playing')?.icon).toBe(
        DEFAULT_COLLECTION_ICONS['currently-playing']
      );
      expect(loaded.find((c) => c.id === 'backlog')?.icon).toBe(DEFAULT_COLLECTION_ICONS.backlog);
      expect(loaded.find((c) => c.id === 'completed')?.icon).toBe(
        DEFAULT_COLLECTION_ICONS.completed
      );

      // Test useCollectionsManager hook CRUD with custom icons
      const harness = createHookHarness(() => useCollectionsManager());
      let mgr = harness.run();

      const createdId = mgr.handleCreateCollection('Tactical RPGs', 'sword');
      mgr = harness.run();
      const createdCol = mgr.collections.find((c) => c.id === createdId);
      expect(createdCol).toBeDefined();
      expect(createdCol?.name).toBe('Tactical RPGs');
      expect(createdCol?.icon).toBe('sword');

      // Rename and change icon of default collection ('favorites' -> 'rocket') and custom collection ('sword' -> 'crown')
      mgr.handleRenameCollection('favorites', 'Top Favorites', 'rocket');
      mgr.handleUpdateCollectionIcon(createdId, 'crown');
      mgr = harness.run();

      expect(mgr.collections.find((c) => c.id === 'favorites')?.name).toBe('Top Favorites');
      expect(mgr.collections.find((c) => c.id === 'favorites')?.icon).toBe('rocket');
      expect(mgr.collections.find((c) => c.id === createdId)?.icon).toBe('crown');
      expect(getEffectiveCollectionIconId({ id: 'favorites', icon: 'rocket' })).toBe('rocket');

      // Test ManageCollectionsModal icon picker for creating & editing collections
      const onCreateMock = vi.fn();
      const onRenameMock = vi.fn();
      const modalHarness = createHookHarness(() => {
        const vnode = (ManageCollectionsModal as any)({
          isOpen: true,
          onClose: vi.fn(),
          collections: mgr.collections,
          onCreateCollection: onCreateMock,
          onRenameCollection: onRenameMock,
          onDeleteCollection: vi.fn(),
          onToggleGameInCollection: vi.fn(),
        });
        return { vnode, html: renderToString(vnode) };
      });

      const m1 = modalHarness.run();
      expect(m1.html).toContain('data-testid="collection-row-icon-favorites"');
      expect(m1.html).toContain('data-collection-icon="rocket"');

      // Click the icon button on the 'favorites' default collection row to open its inline editor + icon grid
      const favRowIconBtn = findElements(
        m1.vnode,
        (el) => el.props?.['data-testid'] === 'collection-row-icon-favorites'
      )[0];
      expect(favRowIconBtn).toBeDefined();
      favRowIconBtn.props.onClick({ stopPropagation: () => {} });

      const m2 = modalHarness.run();
      expect(m2.html).toContain('data-testid="edit-collection-icon-grid-favorites"');

      // Select 'trophy' icon option inside the edit icon grid and click Save
      const trophyOptionBtn = findElements(
        m2.vnode,
        (el) => el.type === 'button' && el.props?.['data-icon-option'] === 'trophy'
      )[0];
      expect(trophyOptionBtn).toBeDefined();
      trophyOptionBtn.props.onClick();

      const m3 = modalHarness.run();
      const saveEditBtn = findElements(
        m3.vnode,
        (el) => el.type === 'button' && el.props?.children === 'Save'
      )[0];
      expect(saveEditBtn).toBeDefined();
      saveEditBtn.props.onClick();
      expect(onRenameMock).toHaveBeenCalledWith('favorites', 'Top Favorites', 'trophy');

      // Open "Create New Collection" form, pick 'flame' icon, enter name, and submit
      const m4 = modalHarness.run();
      const openCreateBtn = findElements(
        m4.vnode,
        (el) =>
          el.type === 'button' &&
          JSON.stringify(el.props?.children || '').includes('Create New Collection')
      )[0];
      expect(openCreateBtn).toBeDefined();
      openCreateBtn.props.onClick();

      const m5 = modalHarness.run();
      expect(m5.html).toContain('data-testid="new-collection-icon-grid"');
      const flameOptionBtn = findElements(
        m5.vnode,
        (el) => el.type === 'button' && el.props?.['data-icon-option'] === 'flame'
      )[0];
      expect(flameOptionBtn).toBeDefined();
      flameOptionBtn.props.onClick();

      const nameInput = findElements(m5.vnode, (el) => el.type === 'input')[0];
      expect(nameInput).toBeDefined();
      nameInput.props.onChange({ target: { value: 'Action Blockbusters' } });

      const m6 = modalHarness.run();
      const createForm = findElements(m6.vnode, (el) => el.type === 'form')[0];
      expect(createForm).toBeDefined();
      createForm.props.onSubmit({ preventDefault: () => {} });

      expect(onCreateMock).toHaveBeenCalledWith('Action Blockbusters', 'flame');
    });
  });

  // ===========================================================================
  // 4. ENHANCEMENT 2: NATIVE OS PLATFORM BADGES, FILTERING & SEARCH
  // ===========================================================================
  describe('4. Enhancement 2: Native OS Platform Badges, Filtering & Search', () => {
    const dualNativeGame: CanonicalGame = {
      id: 'steam-1086940',
      title: "Baldur's Gate 3",
      sortTitle: "Baldur's Gate 3",
      steamAppId: 1086940,
      enrichedMetadata: {
        appId: 1086940,
        name: "Baldur's Gate 3",
        shortDescription: 'Party-based RPG set in the universe of Dungeons & Dragons.',
        detailedDescription: '',
        aboutTheGame: '',
        headerImage: '',
        developers: ['Larian Studios'],
        publishers: ['Larian Studios'],
        genres: ['RPG'],
        tags: ['RPG'],
        categories: [],
        releaseDate: 'Aug 3, 2023',
        platforms: { windows: true, mac: true, linux: false },
        screenshots: [],
        movies: [],
        systemRequirements: {},
        reviewSummary: {
          reviewScore: 9,
          reviewScoreDesc: 'Overwhelmingly Positive',
          totalPositive: 500000,
          totalNegative: 15000,
          totalReviews: 515000,
          positivePercent: 97,
        },
      },
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '1086940',
          installed: true,
          installPath: "/Applications/Baldur's Gate 3.app",
          executablePath: "/Applications/Baldur's Gate 3.app/Contents/MacOS/BaldursGate3",
          isWindowsBinaryOnMac: false,
        },
      ],
      headerImage: '',
      developers: ['Larian Studios'],
      publishers: ['Larian Studios'],
      genres: ['RPG'],
      tags: ['RPG'],
    };

    const windowsOnlyCrossOverGame: CanonicalGame = {
      id: 'steam-2320',
      title: 'Quake II',
      sortTitle: 'Quake II',
      steamAppId: 2320,
      enrichedMetadata: {
        appId: 2320,
        name: 'Quake II',
        shortDescription: 'Classic sci-fi FPS by id Software.',
        detailedDescription: 'Classic sci-fi FPS by id Software.',
        aboutTheGame: 'Classic sci-fi FPS by id Software.',
        headerImage: '',
        developers: ['id Software'],
        publishers: ['Bethesda Softworks'],
        genres: ['Action'],
        tags: ['FPS'],
        categories: [],
        releaseDate: '1997',
        platforms: { windows: true, mac: false, linux: false },
        screenshots: [],
        movies: [],
        systemRequirements: {},
        reviewSummary: {
          reviewScore: 9,
          reviewScoreDesc: 'Overwhelmingly Positive',
          totalPositive: 12000,
          totalNegative: 400,
          totalReviews: 12400,
          positivePercent: 97,
        },
      },
      platforms: [
        {
          platformId: 'steam',
          platformGameId: '2320',
          installed: true,
          installPath:
            '/Users/test_player/Library/Application Support/CrossOver/Bottles/OneLauncher/drive_c/Program Files (x86)/Steam/steamapps/common/Quake 2',
          executablePath:
            '/Users/test_player/Library/Application Support/CrossOver/Bottles/OneLauncher/drive_c/Program Files (x86)/Steam/steamapps/common/Quake 2/quake2.exe',
          isWindowsBinaryOnMac: true,
        },
      ],
      headerImage: '',
      developers: ['id Software'],
      publishers: ['Bethesda Softworks'],
      genres: ['Action'],
      tags: ['FPS'],
    };

    it('getNativeOsPlatforms identifies native windows and mac support while strictly excluding CrossOver / Wine / Windows .exe installs on macOS', () => {
      expect(getNativeOsPlatforms(dualNativeGame)).toEqual(['windows', 'mac']);
      expect(isNativelyAvailableOnMac(dualNativeGame)).toBe(true);
      expect(isNativelyAvailableOnWindows(dualNativeGame)).toBe(true);

      // Even though Quake II is installed on macOS inside a CrossOver bottle, it must ONLY report ['windows']
      expect(getNativeOsPlatforms(windowsOnlyCrossOverGame)).toEqual(['windows']);
      expect(isNativelyAvailableOnMac(windowsOnlyCrossOverGame)).toBe(false);
      expect(isNativelyAvailableOnWindows(windowsOnlyCrossOverGame)).toBe(true);
    });

    it('matchesGameFilter and matchesNativeOsQuery accurately filter and search by native OS (macOS / Windows)', () => {
      expect(matchesGameFilter(dualNativeGame, { type: 'os', label: 'Native OS', value: 'macOS' })).toBe(true);
      expect(matchesGameFilter(dualNativeGame, { type: 'os', label: 'Native OS', value: 'Windows' })).toBe(true);
      expect(matchesGameFilter(windowsOnlyCrossOverGame, { type: 'os', label: 'Native OS', value: 'macOS' })).toBe(
        false
      );
      expect(matchesGameFilter(windowsOnlyCrossOverGame, { type: 'os', label: 'Native OS', value: 'Windows' })).toBe(
        true
      );

      expect(matchesNativeOsQuery(dualNativeGame, 'macos')).toBe(true);
      expect(matchesNativeOsQuery(dualNativeGame, 'native mac')).toBe(true);
      expect(matchesNativeOsQuery(windowsOnlyCrossOverGame, 'macos')).toBe(false);
      expect(matchesNativeOsQuery(windowsOnlyCrossOverGame, 'windows')).toBe(true);
      expect(matchesNativeOsQuery(windowsOnlyCrossOverGame, 'os:windows')).toBe(true);
    });

    it('renders bottom-left cover native OS badges in LibraryGridView and interactive detail native OS badges in SteamStorePage / NativeOsBadges', () => {
      // 1. Direct NativeOsBadges cover-badge and detail-pill variants
      const coverBadgeHtml = renderToString(
        React.createElement(NativeOsBadges, {
          platforms: ['windows', 'mac'],
          variant: 'cover-badge',
        })
      );
      expect(coverBadgeHtml).toContain('data-testid="cover-native-os-badge"');
      expect(coverBadgeHtml).toContain('data-native-os="mac"');
      expect(coverBadgeHtml).toContain('data-native-os="windows"');

      const detailPillHtml = renderToString(
        React.createElement(NativeOsBadges, {
          platforms: ['windows', 'mac'],
          variant: 'detail-pill',
        })
      );
      expect(detailPillHtml).toContain('data-testid="detail-native-os-badges"');
      expect(detailPillHtml).toContain('data-testid="detail-native-os-pill-mac"');
      expect(detailPillHtml).toContain('data-testid="detail-native-os-pill-windows"');

      // 2. LibraryGridView renders bottom-left cover native OS badge on game cards
      const gridHtml = renderToString(
        React.createElement(LibraryGridView, {
          games: [dualNativeGame, windowsOnlyCrossOverGame],
          onSelectGame: vi.fn(),
          searchQuery: '',
          title: 'All Games',
          connectedStorefronts: ['steam', 'gog', 'epic'],
        })
      );
      expect(gridHtml).toContain('data-testid="cover-native-os-badge"');
      expect(gridHtml).toContain('Natively available on macOS &amp; Windows');
      expect(gridHtml).toContain('Natively available on Windows');

      // 3. SteamStorePage renders detail native OS badges in header metadata
      const detailPageHtml = renderToString(
        React.createElement(SteamStorePage, {
          game: dualNativeGame,
          connectedStorefronts: ['steam'],
        })
      );
      expect(detailPageHtml).toContain('data-testid="detail-native-os-badges"');
      expect(detailPageHtml).toContain('data-testid="detail-native-os-pill-mac"');
      expect(detailPageHtml).toContain('data-testid="detail-native-os-pill-windows"');
    });

    it('strictly isolates per-storefront native OS flags so Epic-only or GOG-only Windows builds never inherit Steam mac:true metadata (e.g. 20 Minutes Till Dawn)', () => {
      const epicOnlyTwentyMinutesTillDawn: CanonicalGame = {
        id: 'epic-4656facc740742a39e265b026e13d075',
        title: '20 Minutes Till Dawn',
        sortTitle: '20 Minutes Till Dawn',
        steamAppId: 1966900,
        enrichedMetadata: {
          appId: 1966900,
          name: '20 Minutes Till Dawn',
          shortDescription: 'Survive the endless horde for 20 minutes.',
          detailedDescription: 'Survive the endless horde for 20 minutes.',
          aboutTheGame: 'Survive the endless horde for 20 minutes.',
          headerImage: '',
          developers: ['flanne'],
          publishers: ['Erabit'],
          genres: ['Action'],
          tags: [],
          categories: [],
          releaseDate: 'Jun 8, 2023',
          platforms: { windows: true, mac: true, linux: false },
          screenshots: [],
          movies: [],
          systemRequirements: {},
          reviewSummary: {
            reviewScore: 8,
            reviewScoreDesc: 'Very Positive',
            totalPositive: 20000,
            totalNegative: 1500,
            totalReviews: 21500,
            positivePercent: 93,
          },
        },
        platforms: [
          {
            platformId: 'epic',
            platformGameId: '4656facc740742a39e265b026e13d075',
            installed: false,
            platforms: { windows: true, mac: false },
          },
        ],
        headerImage: '',
        developers: ['flanne'],
        publishers: ['Erabit'],
        genres: ['Action'],
        tags: [],
      };

      expect(getStorefrontNativeOsFlags(epicOnlyTwentyMinutesTillDawn, 'epic')).toEqual({
        windows: true,
        mac: false,
        isExplicit: true,
      });
      expect(getStorefrontNativeOsPlatforms(epicOnlyTwentyMinutesTillDawn, 'epic')).toEqual([
        'windows',
      ]);
      expect(getNativeOsPlatforms(epicOnlyTwentyMinutesTillDawn)).toEqual(['windows']);
      expect(isNativelyAvailableOnMac(epicOnlyTwentyMinutesTillDawn)).toBe(false);
      expect(isNativelyAvailableOnWindows(epicOnlyTwentyMinutesTillDawn)).toBe(true);
      expect(
        matchesGameFilter(epicOnlyTwentyMinutesTillDawn, { type: 'os', label: 'Native OS', value: 'macOS' })
      ).toBe(false);
      expect(
        matchesGameFilter(epicOnlyTwentyMinutesTillDawn, { type: 'os', label: 'Native OS', value: 'Windows' })
      ).toBe(true);
      expect(matchesNativeOsQuery(epicOnlyTwentyMinutesTillDawn, 'macos')).toBe(false);
    });

    it('resolves per-storefront native OS support independently for multi-store duplicate ownership (Steam Mac + Windows vs GOG Windows-only)', () => {
      const multiStoreGame: CanonicalGame = {
        id: 'steam-999111',
        title: 'Cross-Store RPG',
        sortTitle: 'Cross-Store RPG',
        steamAppId: 999111,
        enrichedMetadata: {
          appId: 999111,
          name: 'Cross-Store RPG',
          shortDescription: 'Owned on both Steam and GOG.',
          detailedDescription: 'Owned on both Steam and GOG.',
          aboutTheGame: 'Owned on both Steam and GOG.',
          headerImage: '',
          developers: ['Studio X'],
          publishers: ['Studio X'],
          genres: ['RPG'],
          tags: [],
          categories: [],
          releaseDate: '2024',
          platforms: { windows: true, mac: true, linux: false },
          screenshots: [],
          movies: [],
          systemRequirements: {},
          reviewSummary: {
            reviewScore: 8,
            reviewScoreDesc: 'Very Positive',
            totalPositive: 500,
            totalNegative: 50,
            totalReviews: 550,
            positivePercent: 91,
          },
        },
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '999111',
            installed: false,
            platforms: { windows: true, mac: true },
          },
          {
            platformId: 'gog',
            platformGameId: '1234567890',
            installed: false,
            platforms: { windows: true, mac: false },
          },
        ],
        headerImage: '',
        developers: ['Studio X'],
        publishers: ['Studio X'],
        genres: ['RPG'],
        tags: [],
      };

      expect(getStorefrontNativeOsPlatforms(multiStoreGame, 'steam')).toEqual(['windows', 'mac']);
      expect(getStorefrontNativeOsPlatforms(multiStoreGame, 'gog')).toEqual(['windows']);
      expect(getNativeOsPlatforms(multiStoreGame, 'steam')).toEqual(['windows', 'mac']);
      expect(getNativeOsPlatforms(multiStoreGame, 'gog')).toEqual(['windows']);
      expect(getNativeOsPlatforms(multiStoreGame)).toEqual(['windows', 'mac']);
    });
  });
});
