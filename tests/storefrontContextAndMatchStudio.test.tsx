import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { CanonicalGame } from '../src/contracts/game';
import type { UserGameOverride, SearchMatchCandidate } from '../src/contracts/override';
import { LauncherService, launcherService } from '../src/services/launcher/launcherService';
import { SteamLibraryActionBar } from '../src/components/SteamStoreDetail/SteamLibraryActionBar';
import { FixMatchWizardModal } from '../src/components/Library/FixMatchWizardModal';
import {
  LibraryMatchManagerModal,
  getGranularUnmatchedReasons,
  hasGenuineStoreSynopsis,
  isSynopsisAlreadyProbed,
} from '../src/components/Library/LibraryMatchManagerModal';
import {
  metadataScraperService,
  buildCandidateStoreUrl,
} from '../src/services/scraper/metadataScraperService';
import {
  sanitizeGameCatalog,
  getSuppressedCatalogEntries,
  registerSuppressedCatalogEntries,
  SuppressedCatalogEntry,
} from '../src/services/integrations/catalogSanitizer';
import {
  saveUserOverride,
  removeUserOverride,
  loadUserOverrides,
  hideStorefrontEntry,
  unhideStorefrontEntry,
  isStorefrontEntryHidden,
  loadHiddenStorefrontEntries,
  isNonGameStorefrontEntryConfirmed,
  confirmNonGameStorefrontEntry,
  confirmMultipleNonGameStorefrontEntries,
  unconfirmNonGameStorefrontEntry,
} from '../src/services/storage/userOverrideStorage';
import { syncJobManager } from '../src/services/network/syncJobManager';
import { requestScheduler } from '../src/services/network/requestScheduler';
import {
  fallbackMetadataProvider,
  isGenericPlaceholderSynopsis,
} from '../src/services/steam/fallbackMetadataProvider';
import axios from 'axios';

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
} else {
  if (typeof (window as any).addEventListener === 'undefined') {
    (window as any).addEventListener = (type: string, listener: any) =>
      eventTarget.addEventListener(type, listener);
    (window as any).removeEventListener = (type: string, listener: any) =>
      eventTarget.removeEventListener(type, listener);
    (window as any).dispatchEvent = (event: any) => eventTarget.dispatchEvent(event);
  }
  if (!(window as any).location) {
    (window as any).location = { hostname: 'example.com' };
  }
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

// ---------------------------------------------------------------------------
// Stateful React 19 Component Test Harness (Zero External DOM Dependencies)
// ---------------------------------------------------------------------------
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

function getTextContent(node: any): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(getTextContent).join('');
  if (typeof node === 'object' && node.props) return getTextContent(node.props.children);
  return '';
}

type DeferInfer<T> = [T][T extends any ? 0 : never];

function createStatefulRenderer<P extends Record<string, any>>(
  Component: React.FC<P>,
  initialProps: DeferInfer<P>
) {
  const states: any[] = [];
  const effectDeps: Array<any[] | undefined> = [];
  const memos: Array<{ value: any; deps?: any[] }> = [];
  const callbacks: Array<{ fn: any; deps?: any[] }> = [];
  let currentProps = { ...initialProps };

  const render = (nextProps?: Partial<P>) => {
    if (nextProps) {
      currentProps = { ...currentProps, ...nextProps };
    }
    let stateIdx = 0;
    let effectIdx = 0;
    let memoIdx = 0;
    let callbackIdx = 0;
    const pendingEffects: Array<() => void> = [];

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
      useEffect(fn: () => any, deps?: any[]) {
        const idx = effectIdx++;
        const prevDeps = effectDeps[idx];
        const hasChanged =
          prevDeps === undefined ||
          deps === undefined ||
          deps.length !== prevDeps.length ||
          deps.some((d, i) => !Object.is(d, prevDeps[i]));
        if (hasChanged) {
          effectDeps[idx] = deps ? [...deps] : undefined;
          pendingEffects.push(fn);
        }
      },
      useRef(initial: any) {
        return { current: initial };
      },
      useMemo(fn: () => any, deps?: any[]) {
        const idx = memoIdx++;
        const prev = memos[idx];
        const hasChanged =
          !prev ||
          deps === undefined ||
          prev.deps === undefined ||
          deps.length !== prev.deps.length ||
          deps.some((d, i) => !Object.is(d, prev.deps![i]));
        if (hasChanged) {
          memos[idx] = { value: fn(), deps: deps ? [...deps] : undefined };
        }
        return memos[idx].value;
      },
      useCallback(fn: any, deps?: any[]) {
        const idx = callbackIdx++;
        const prev = callbacks[idx];
        const hasChanged =
          !prev ||
          deps === undefined ||
          prev.deps === undefined ||
          deps.length !== prev.deps.length ||
          deps.some((d, i) => !Object.is(d, prev.deps![i]));
        if (hasChanged) {
          callbacks[idx] = { fn, deps: deps ? [...deps] : undefined };
        }
        return callbacks[idx].fn;
      },
    };

    try {
      const vnode = (Component as any)(currentProps);
      const html = renderToString(vnode);
      const text = getTextContent(vnode);
      for (const eff of pendingEffects) {
        try {
          eff();
        } catch {}
      }
      return { vnode, html, text };
    } finally {
      internals.H = prevH;
    }
  };

  return { render };
}

describe('Phase 4 QA Suite: Storefront-Context-Aware Install/Play, Fix & Match Clarity & Library Match Studio', () => {
  beforeEach(() => {
    mockStorage.clear();
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    (launcherService as any).installedRecords = [];
    (launcherService as any).activeSessions.clear();
    (launcherService as any).downloadQueue = [];
    (launcherService as any).launchConfigs = {};
    syncJobManager.reset();
    requestScheduler.setEnforceDelays(false);
  });

  afterEach(() => {
    syncJobManager.reset();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. ISSUE 1: STOREFRONT-CONTEXT-AWARE INSTALL / PLAY & PER-STORE ISOLATION
  // =========================================================================
  describe('Issue 1: Storefront-Context-Aware Install / Play Button & Per-Storefront Isolation', () => {
    it('evaluates isGameInstalled per storefront and switches SteamLibraryActionBar between Play (GOG installed) and Install (Steam not installed)', async () => {
      const multiStoreGame: CanonicalGame = {
        id: 'steam-22380',
        title: 'Fallout: New Vegas',
        sortTitle: 'Fallout: New Vegas',
        steamAppId: 22380,
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1454587428',
            installed: true,
            installPath: '/Applications/Fallout New Vegas.app',
            executablePath: '/Applications/Fallout New Vegas.app/Contents/MacOS/FalloutNV',
          },
          {
            platformId: 'steam',
            platformGameId: '22380',
            installed: false,
          },
        ],
        headerImage: 'https://cdn.example.com/fnv_header.jpg',
        developers: ['Obsidian Entertainment'],
        publishers: ['Bethesda Softworks'],
        genres: ['RPG'],
        tags: ['Post-apocalyptic'],
      };

      // 1. Verify per-storefront installation queries
      expect(launcherService.isGameInstalled(multiStoreGame, 'gog')).toBe(true);
      expect(launcherService.isGameInstalled(multiStoreGame, 'steam')).toBe(false);
      expect(launcherService.isGameInstalled(multiStoreGame)).toBe(true);

      // 2. Render SteamLibraryActionBar -> defaults to installed GOG platform and shows Play
      const { render } = createStatefulRenderer(SteamLibraryActionBar, {
        game: multiStoreGame,
      });

      const initialRender = render();
      const targetSelect = findElements(
        initialRender.vnode,
        (el) => el.type === 'select' && el.props?.['aria-label'] === 'Target Storefront'
      )[0];
      expect(targetSelect).toBeDefined();
      expect(targetSelect.props.value).toBe('gog');

      // Verify dropdown options show per-storefront install state
      const optionTexts = findElements(targetSelect, (el) => el.type === 'option').map((opt) =>
        getTextContent(opt).replace(/\s+/g, ' ').trim()
      );
      expect(optionTexts).toContain('GOG.com • Installed');
      expect(optionTexts).toContain('Steam • Not Installed');

      // Primary action button is Play when GOG is selected
      const playButton = findElements(
        initialRender.vnode,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Play'
      )[0];
      expect(playButton).toBeDefined();

      // 3. Switch Target Storefront dropdown from 'gog' to 'steam'
      targetSelect.props.onChange({ target: { value: 'steam' } });
      const steamSelectedRender = render();

      const updatedSelect = findElements(
        steamSelectedRender.vnode,
        (el) => el.type === 'select' && el.props?.['aria-label'] === 'Target Storefront'
      )[0];
      expect(updatedSelect.props.value).toBe('steam');

      // Primary button immediately switches from Play to Install!
      const playBtnAfterSwitch = findElements(
        steamSelectedRender.vnode,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Play'
      )[0];
      const installBtnAfterSwitch = findElements(
        steamSelectedRender.vnode,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Install'
      )[0];
      expect(playBtnAfterSwitch).toBeUndefined();
      expect(installBtnAfterSwitch).toBeDefined();
    });

    it('keeps Play active when both GOG and Steam are installed and routes launchGame to the selected storefront', async () => {
      const bothInstalledGame: CanonicalGame = {
        id: 'steam-22380',
        title: 'Fallout: New Vegas',
        sortTitle: 'Fallout: New Vegas',
        steamAppId: 22380,
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1454587428',
            installed: true,
            installPath: '/Applications/Fallout New Vegas.app',
            executablePath: '/Applications/Fallout New Vegas.app/Contents/MacOS/FalloutNV',
          },
          {
            platformId: 'steam',
            platformGameId: '22380',
            installed: true,
            installPath: '/Users/test/Library/Application Support/Steam/steamapps/common/Fallout New Vegas',
            executablePath:
              '/Users/test/Library/Application Support/Steam/steamapps/common/Fallout New Vegas/FalloutNV.exe',
          },
        ],
        headerImage: 'https://cdn.example.com/fnv_header.jpg',
        developers: ['Obsidian Entertainment'],
        publishers: ['Bethesda Softworks'],
        genres: ['RPG'],
        tags: [],
      };

      const launchSpy = vi.spyOn(launcherService, 'launchGame').mockResolvedValue({
        success: true,
        message: 'Launched Fallout: New Vegas',
      });

      const { render } = createStatefulRenderer(SteamLibraryActionBar, {
        game: bothInstalledGame,
      });

      // Default is 'gog' -> Play is active -> clicking Play launches 'gog'
      const gogRender = render();
      const gogPlayBtn = findElements(
        gogRender.vnode,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Play'
      )[0];
      expect(gogPlayBtn).toBeDefined();
      await gogPlayBtn.props.onClick();
      expect(launchSpy).toHaveBeenCalledWith(bothInstalledGame, 'gog');

      // Switch dropdown to 'steam' -> Play stays active -> clicking Play launches 'steam'
      const selectEl = findElements(
        gogRender.vnode,
        (el) => el.type === 'select' && el.props?.['aria-label'] === 'Target Storefront'
      )[0];
      selectEl.props.onChange({ target: { value: 'steam' } });

      const steamRender = render();
      const steamPlayBtn = findElements(
        steamRender.vnode,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Play'
      )[0];
      expect(steamPlayBtn).toBeDefined();
      await steamPlayBtn.props.onClick();
      expect(launchSpy).toHaveBeenCalledWith(bothInstalledGame, 'steam');
    });

    it('setManualInstallStatus mutates only the targeted storefront without altering other owned storefronts', () => {
      const localService = new LauncherService();
      const game: CanonicalGame = {
        id: 'steam-292030',
        title: 'The Witcher 3: Wild Hunt',
        sortTitle: 'Witcher 3: Wild Hunt',
        steamAppId: 292030,
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1207664643',
            installed: false,
          },
          {
            platformId: 'steam',
            platformGameId: '292030',
            installed: false,
          },
        ],
        headerImage: '',
        developers: ['CD PROJEKT RED'],
        publishers: ['CD PROJEKT RED'],
        genres: ['RPG'],
        tags: [],
      };

      // Seed GOG as installed in installedRecords
      localService.setManualInstallStatus(game, true, 'gog');
      expect(localService.isGameInstalled(game, 'gog')).toBe(true);
      expect(localService.isGameInstalled(game, 'steam')).toBe(false);

      // Mark Steam as manually installed -> both are installed
      localService.setManualInstallStatus(game, true, 'steam');
      expect(localService.isGameInstalled(game, 'steam')).toBe(true);
      expect(localService.isGameInstalled(game, 'gog')).toBe(true);

      // Mark Steam as uninstalled -> Steam becomes false, GOG remains true
      localService.setManualInstallStatus(game, false, 'steam');
      expect(localService.isGameInstalled(game, 'steam')).toBe(false);
      expect(localService.isGameInstalled(game, 'gog')).toBe(true);
    });
  });

  // =========================================================================
  // 2. ISSUE 2: FIX & MATCH WIZARD CLARITY, UNSANITIZED TITLES & STORE LINKS
  // =========================================================================
  describe('Issue 2: Fix & Match Wizard Source vs. Cloud Clarity, Unsanitized Titles & Direct Store Links', () => {
    it('buildCandidateStoreUrl generates valid external storefront URLs across steam, gog, epic, and igdb', () => {
      expect(
        buildCandidateStoreUrl({
          source: 'steam',
          title: 'Sid Meier’s Civilization® IV: Colonization',
          steamAppId: 16810,
        })
      ).toBe('https://store.steampowered.com/app/16810');

      expect(
        buildCandidateStoreUrl({
          source: 'gog',
          title: 'Disco Elysium',
          gogId: 'disco_elysium',
        })
      ).toBe('https://www.gog.com/en/game/disco_elysium');

      expect(
        buildCandidateStoreUrl({
          source: 'gog',
          title: 'The Saboteur',
          gogId: '1458058109',
        })
      ).toBe('https://www.gog.com/en/games?query=The%20Saboteur');

      expect(
        buildCandidateStoreUrl({
          source: 'epic',
          title: 'Alan Wake 2',
          epicSlug: 'alan-wake-2',
        })
      ).toBe('https://store.epicgames.com/en-US/p/alan-wake-2');

      expect(
        buildCandidateStoreUrl({
          source: 'igdb',
          title: 'Bloodborne: The Old Hunters',
          igdbId: 'bloodborne-the-old-hunters',
        })
      ).toBe('https://www.igdb.com/games/bloodborne-the-old-hunters');
    });

    it('searchStorefronts and getSuggestedMatches preserve unsanitized punctuation/editions in candidate titles and attach storeUrl', async () => {
      const querySteamSpy = vi
        .spyOn(metadataScraperService as any, 'querySteamStore')
        .mockResolvedValue([
          {
            id: 16810,
            name: "Sid Meier's Civilization IV: Colonization - Complete Edition",
          },
        ]);
      const queryLutrisSpy = vi
        .spyOn(metadataScraperService as any, 'queryLutrisGames')
        .mockResolvedValue([]);

      try {
        const searchResults = await metadataScraperService.searchStorefronts(
          "Sid Meier's Civilization IV: Colonization - Complete Edition",
          'steam'
        );
        expect(searchResults.length).toBeGreaterThan(0);
        const colonizationCand = searchResults.find((c) => c.steamAppId === 16810);
        expect(colonizationCand).toBeDefined();
        // Full unsanitized title with apostrophe, colon, and hyphen preserved!
        expect(colonizationCand?.title).toBe(
          "Sid Meier's Civilization IV: Colonization - Complete Edition"
        );
        expect(colonizationCand?.storeUrl).toBe('https://store.steampowered.com/app/16810');

        const mockGame: CanonicalGame = {
          id: 'gog-16810',
          title: "Sid Meier's Civilization IV: Colonization - Complete Edition",
          sortTitle: "Sid Meier's Civilization IV: Colonization",
          platforms: [{ platformId: 'gog', platformGameId: '16810', installed: false }],
          headerImage: '',
          developers: ['Firaxis Games'],
          publishers: ['2K'],
          genres: ['Strategy'],
          tags: [],
        };

        const suggested = await metadataScraperService.getSuggestedMatches(
          mockGame,
          "Sid Meier's Civilization IV: Colonization - Complete Edition",
          'Steam',
          false
        );
        expect(suggested.length).toBeGreaterThan(0);
        expect(suggested.every((c) => Boolean(c.storeUrl))).toBe(true);
        const matchedCand = suggested.find((c) => c.steamAppId === 16810);
        expect(matchedCand?.title).toBe(
          "Sid Meier's Civilization IV: Colonization - Complete Edition"
        );
      } finally {
        querySteamSpy.mockRestore();
        queryLutrisSpy.mockRestore();
      }
    });

    it('sanitizeGameCatalog preserves originalStoreTitle on CanonicalGame and originalTitle on GamePlatformOwnership across overrides', () => {
      const rawGame: CanonicalGame = {
        id: 'gog-civ4col',
        title: "Sid Meier's Civilization IV: Colonization + Official Walkthrough",
        sortTitle: "Sid Meier's Civilization IV: Colonization",
        isVerifiedEntitlement: true,
        platforms: [
          {
            platformId: 'gog',
            platformGameId: 'civ4col',
            installed: true,
          },
        ],
        headerImage: 'https://images.gog.com/civ4col.jpg',
        developers: ['Firaxis Games'],
        publishers: ['2K'],
        genres: ['Strategy'],
        tags: [],
      };

      saveUserOverride({
        gameId: 'gog-civ4col',
        platformId: 'gog',
        platformGameId: 'civ4col',
        originalSourceTitle: "Sid Meier's Civilization IV: Colonization + Official Walkthrough",
        originalSourcePlatformId: 'gog',
        matchedStore: 'steam',
        matchedId: 3900,
        steamAppId: 3900,
        title: "Sid Meier's Civilization IV",
        updatedAt: new Date().toISOString(),
      });

      const sanitized = sanitizeGameCatalog([rawGame], { allowNewPurchases: true });
      expect(sanitized).toHaveLength(1);
      const result = sanitized[0];

      // Active title is overridden to Civilization IV, while originalStoreTitle and platform.originalTitle remain intact!
      expect(result.title).toBe("Sid Meier's Civilization IV");
      expect(result.originalStoreTitle).toBe(
        "Sid Meier's Civilization IV: Colonization + Official Walkthrough"
      );
      expect(result.platforms[0].originalTitle).toBe(
        "Sid Meier's Civilization IV: Colonization + Official Walkthrough"
      );
    });

    it('FixMatchWizardModal displays Source Scrape Title vs Active Display Title, comparison banner, and Store Page links on candidate cards', async () => {
      const overriddenGame: CanonicalGame = {
        id: 'gog-civ4col',
        title: "Sid Meier's Civilization IV",
        originalStoreTitle: "Sid Meier's Civilization IV: Colonization",
        sortTitle: "Sid Meier's Civilization IV",
        steamAppId: 3900,
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1207659012',
            originalTitle: "Sid Meier's Civilization IV: Colonization",
            installed: true,
          },
        ],
        headerImage: '',
        developers: ['Firaxis Games'],
        publishers: ['2K'],
        genres: ['Strategy'],
        tags: [],
      };

      const existingOverride: UserGameOverride = {
        gameId: 'gog-civ4col',
        platformId: 'gog',
        platformGameId: '1207659012',
        originalSourceTitle: "Sid Meier's Civilization IV: Colonization",
        originalSourcePlatformId: 'gog',
        matchedStore: 'steam',
        matchedId: 3900,
        steamAppId: 3900,
        title: "Sid Meier's Civilization IV",
        updatedAt: new Date().toISOString(),
      };

      const mockCandidates: SearchMatchCandidate[] = [
        {
          id: 'steam-16810',
          source: 'steam',
          title: "Sid Meier's Civilization IV: Colonization",
          steamAppId: 16810,
          storeUrl: 'https://store.steampowered.com/app/16810',
          confidenceScore: 100,
        },
      ];

      const getSuggestedSpy = vi
        .spyOn(metadataScraperService, 'getSuggestedMatches')
        .mockResolvedValue(mockCandidates);

      try {
        const { render } = createStatefulRenderer(FixMatchWizardModal, {
          isOpen: true,
          game: overriddenGame,
          existingOverride,
          onClose: vi.fn(),
          onApplyOverride: vi.fn(),
        });

        render();
        await new Promise((r) => setTimeout(r, 15));
        const loaded = render();

        // Header shows both Source Scrape Title and Active Display Title
        expect(loaded.text).toContain('Source Scrape Title:');
        expect(loaded.text).toContain("Sid Meier's Civilization IV: Colonization");
        expect(loaded.text).toContain('Active Display Title:');
        expect(loaded.text).toContain("Sid Meier's Civilization IV");

        // Step 1 comparison banner shows Original Storefront Entitlement vs Currently Routed To
        expect(loaded.text).toContain('Original Storefront Entitlement:');
        expect(loaded.text).toContain('Currently Routed To:');
        expect(loaded.text).toContain('(Platform ID: 1207659012)');

        // Candidate card renders clickable Store Page button
        const storePageButtons = findElements(
          loaded.vnode,
          (el) => el.type === 'button' && getTextContent(el).includes('Store Page')
        );
        expect(storePageButtons.length).toBeGreaterThan(0);
      } finally {
        getSuggestedSpy.mockRestore();
      }
    });
  });

  // =========================================================================
  // 3. ENHANCEMENT 1: LIBRARY MATCH & OVERRIDES STUDIO (LibraryMatchManagerModal)
  // =========================================================================
  describe('Enhancement 1: Library Match & Overrides Studio (LibraryMatchManagerModal)', () => {
    it('records suppressed entries during sanitizeGameCatalog and restores them when a UserGameOverride is saved', () => {
      const suppressedCandidate: CanonicalGame = {
        id: 'epic-cyberpunk-ost',
        title: 'Cyberpunk 2077 Official Soundtrack',
        sortTitle: 'Cyberpunk 2077 Official Soundtrack',
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'cyberpunk-ost',
            installed: false,
          },
        ],
        headerImage: '',
        developers: ['CD PROJEKT RED'],
        publishers: ['CD PROJEKT RED'],
        genres: ['Music'],
        tags: ['DLC', 'Add-On'],
      };

      // Without override, entry is filtered as non-game and recorded in getSuppressedCatalogEntries()
      const pass1 = sanitizeGameCatalog([suppressedCandidate], { allowNewPurchases: true });
      expect(pass1).toHaveLength(0);

      const suppressedList = getSuppressedCatalogEntries();
      const recorded = suppressedList.find((e) => e.id === 'epic-cyberpunk-ost');
      expect(recorded).toBeDefined();
      expect(recorded?.reasonCategory).toBe('non_game_filter');
      expect(recorded?.rawTitle).toBe('Cyberpunk 2077 Official Soundtrack');

      // Save a UserGameOverride for the suppressed entry -> re-running sanitizeGameCatalog restores it!
      saveUserOverride({
        gameId: 'epic-cyberpunk-ost',
        platformId: 'epic',
        platformGameId: 'cyberpunk-ost',
        originalSourceTitle: 'Cyberpunk 2077 Official Soundtrack',
        originalSourcePlatformId: 'epic',
        matchedStore: 'steam',
        matchedId: 1091500,
        steamAppId: 1091500,
        title: 'Cyberpunk 2077',
        updatedAt: new Date().toISOString(),
      });

      const pass2 = sanitizeGameCatalog([suppressedCandidate], { allowNewPurchases: true });
      expect(pass2).toHaveLength(1);
      expect(pass2[0].title).toBe('Cyberpunk 2077');
      expect(pass2[0].originalStoreTitle).toBe('Cyberpunk 2077 Official Soundtrack');
    });

    it('renders all 5 studio sections in LibraryMatchManagerModal and dispatches restore, edit, and reset actions', () => {
      // 1. Unmatched game (missing artwork & no steamAppId)
      const unmatchedGame: CanonicalGame = {
        id: 'epic-mystery-slug',
        title: 'Project Mystery Alpha',
        originalStoreTitle: 'Project Mystery Alpha',
        sortTitle: 'Project Mystery Alpha',
        needsMatchReview: true,
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'mystery-slug-01',
            originalTitle: 'Project Mystery Alpha',
            installed: false,
          },
        ],
        headerImage: '',
        capsuleImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      // 2. Low-Confidence Automatic Match (has cover artwork, but matchConfidence < 85 and shifted title)
      const lowConfidenceGame: CanonicalGame = {
        id: 'gog-1458058109',
        title: 'The Saboteur',
        originalStoreTitle: 'The Saboteur (2009 Classic Release)',
        sortTitle: 'Saboteur',
        matchConfidence: 68,
        needsMatchReview: true,
        capsuleImage: 'https://cdn.example.com/saboteur_cover.jpg',
        headerImage: 'https://cdn.example.com/saboteur_header.jpg',
        shortDescription:
          'Undermine the Nazi occupation in open-world Paris with stealth and demolition.',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1458058109',
            originalTitle: 'The Saboteur (2009 Classic Release)',
            installed: false,
          },
        ],
        developers: ['Pandemic Studios'],
        publishers: ['Electronic Arts'],
        genres: ['Action'],
        tags: [],
      };

      // 3. Suppressed entry registered in catalogSanitizer
      const suppressedRawGame: CanonicalGame = {
        id: 'gog-witcher-goodies',
        title: 'The Witcher 3 Digital Goodies',
        originalStoreTitle: 'The Witcher 3 Digital Goodies',
        sortTitle: 'Witcher 3 Digital Goodies',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '99887766',
            originalTitle: 'The Witcher 3 Digital Goodies',
            installed: false,
          },
        ],
        headerImage: '',
        developers: ['CD PROJEKT RED'],
        publishers: ['CD PROJEKT RED'],
        genres: [],
        tags: [],
      };
      const suppressedEntry: SuppressedCatalogEntry = {
        id: 'gog-witcher-goodies',
        rawTitle: 'The Witcher 3 Digital Goodies',
        platformId: 'gog',
        platformGameId: '99887766',
        reason: 'Filtered as non-game / beta / trial / SDK / add-on entry',
        reasonCategory: 'non_game_filter',
        rawGame: suppressedRawGame,
      };
      registerSuppressedCatalogEntries([suppressedEntry]);

      // 4. Overridden game (Source -> Target)
      const overriddenGame: CanonicalGame = {
        id: 'gog-civ4col',
        title: "Sid Meier's Civilization IV",
        originalStoreTitle: "Sid Meier's Civilization IV: Colonization",
        sortTitle: "Sid Meier's Civilization IV",
        steamAppId: 3900,
        capsuleImage: 'https://cdn.example.com/civ4.jpg',
        headerImage: 'https://cdn.example.com/civ4_header.jpg',
        shortDescription:
          'Rule the world by establishing and leading a civilization from the dawn of man into the space age.',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1207659012',
            originalTitle: "Sid Meier's Civilization IV: Colonization",
            installed: true,
          },
        ],
        developers: ['Firaxis Games'],
        publishers: ['2K'],
        genres: ['Strategy'],
        tags: [],
      };
      saveUserOverride({
        gameId: 'gog-civ4col',
        platformId: 'gog',
        platformGameId: '1207659012',
        originalSourceTitle: "Sid Meier's Civilization IV: Colonization",
        originalSourcePlatformId: 'gog',
        matchedStore: 'steam',
        matchedId: 3900,
        steamAppId: 3900,
        title: "Sid Meier's Civilization IV",
        updatedAt: new Date().toISOString(),
      });

      // 5. Merged multi-storefront game (GOG installed + Steam not installed)
      const mergedGame: CanonicalGame = {
        id: 'steam-22380',
        title: 'Fallout: New Vegas',
        originalStoreTitle: 'Fallout: New Vegas Ultimate Edition',
        sortTitle: 'Fallout: New Vegas',
        steamAppId: 22380,
        capsuleImage: 'https://cdn.example.com/fnv.jpg',
        headerImage: 'https://cdn.example.com/fnv_header.jpg',
        shortDescription: 'Welcome to Vegas. New Vegas. Enjoy your stay!',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1454587428',
            originalTitle: 'Fallout: New Vegas Ultimate Edition',
            installed: true,
            installPath: '/Applications/Fallout New Vegas.app',
          },
          {
            platformId: 'steam',
            platformGameId: '22380',
            originalTitle: 'Fallout: New Vegas',
            installed: false,
          },
        ],
        developers: ['Obsidian Entertainment'],
        publishers: ['Bethesda Softworks'],
        genres: ['RPG'],
        tags: [],
      };

      const onFixMatchForGame = vi.fn();
      const onResetOverrideForGame = vi.fn();

      const { render } = createStatefulRenderer(LibraryMatchManagerModal, {
        isOpen: true,
        games: [unmatchedGame, lowConfidenceGame, overriddenGame, mergedGame],
        onClose: vi.fn(),
        onFixMatchForGame,
        onResetOverrideForGame,
      });

      const rendered = render();

      // Verify all 5 sections render with their headers and items
      expect(rendered.text).toContain('Unmatched Games');
      expect(rendered.text).toContain('Project Mystery Alpha');

      expect(rendered.text).toContain('Low-Confidence Automatic Matches');
      expect(rendered.text).toContain('The Saboteur');
      expect(rendered.text).toContain('68% Confidence');

      expect(rendered.text).toContain('Suppressed & Filtered Storefront Entries');
      expect(rendered.text).toContain('The Witcher 3 Digital Goodies');

      expect(rendered.text).toContain('Manual Matching Overrides');
      expect(rendered.text).toContain("Sid Meier's Civilization IV: Colonization");
      expect(rendered.text).toContain("Sid Meier's Civilization IV");

      expect(rendered.text).toContain('Merged Multi-Storefront Listings');
      expect(rendered.text).toContain('Fallout: New Vegas');
      expect(rendered.text).toContain('2 Storefronts');
      expect(rendered.text).toContain('#1454587428');
      expect(rendered.text).toContain('#22380');
      expect(rendered.text).toContain('Installed');
      expect(rendered.text).toContain('Not Installed');

      // Clicking "Match & Restore to Library" on suppressed entry calls onFixMatchForGame(suppressedRawGame)
      const restoreBtn = findElements(
        rendered.vnode,
        (el) => el.type === 'button' && getTextContent(el).includes('Match & Restore to Library')
      )[0];
      expect(restoreBtn).toBeDefined();
      restoreBtn.props.onClick();
      expect(onFixMatchForGame).toHaveBeenCalledWith(suppressedRawGame);

      // Clicking "Edit Match" on the manual override calls onFixMatchForGame(overriddenGame)
      const editMatchBtn = findElements(
        rendered.vnode,
        (el) => el.type === 'button' && getTextContent(el).includes('Edit Match')
      )[0];
      expect(editMatchBtn).toBeDefined();
      editMatchBtn.props.onClick();
      expect(onFixMatchForGame).toHaveBeenCalledWith(overriddenGame);

      // Clicking "Reset" on the manual override calls onResetOverrideForGame('gog-civ4col')
      const resetBtn = findElements(
        rendered.vnode,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Reset'
      )[0];
      expect(resetBtn).toBeDefined();
      resetBtn.props.onClick();
      expect(onResetOverrideForGame).toHaveBeenCalledWith('gog-civ4col');

      removeUserOverride('gog-civ4col');
      expect(loadUserOverrides()['gog-civ4col']).toBeUndefined();
    });

    it('separates Unmatched vs Low-Confidence tabs and accordion sections with Inspect, Fix Match, and Hide actions', () => {
      const genuinelyUnmatched: CanonicalGame = {
        id: 'epic-raw-entitlement-77',
        title: 'Codename Cobalt Untracked',
        originalStoreTitle: 'Codename Cobalt Untracked',
        sortTitle: 'Codename Cobalt Untracked',
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'cobalt-77',
            originalTitle: 'Codename Cobalt Untracked',
            installed: false,
          },
        ],
        headerImage: '',
        capsuleImage: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      const lowConfidenceMatched: CanonicalGame = {
        id: 'gog-99112233',
        title: 'Gothic II: Gold Edition',
        originalStoreTitle: 'Gothic 2 Complete Classic',
        sortTitle: 'Gothic II: Gold Edition',
        matchConfidence: 68,
        needsMatchReview: true,
        capsuleImage: 'https://cdn.example.com/gothic2_cover.jpg',
        headerImage: 'https://cdn.example.com/gothic2_header.jpg',
        shortDescription:
          'Return to Khorinis in this classic fantasy role-playing adventure expansion.',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '99112233',
            originalTitle: 'Gothic 2 Complete Classic',
            installed: true,
          },
        ],
        developers: ['Piranha Bytes'],
        publishers: ['THQ Nordic'],
        genres: ['RPG'],
        tags: [],
      };

      const onInspectGame = vi.fn();
      const onFixMatchForGame = vi.fn();
      const onHideGame = vi.fn();
      const onClose = vi.fn();

      const { render } = createStatefulRenderer(LibraryMatchManagerModal, {
        isOpen: true,
        games: [genuinelyUnmatched, lowConfidenceMatched],
        onClose,
        onInspectGame,
        onFixMatchForGame,
        onHideGame,
      });

      const allRender = render();

      // Verify distinct filter tabs exist with accurate counts
      const unmatchedTabBtn = findElements(
        allRender.vnode,
        (el) => el.type === 'button' && getTextContent(el).includes('Unmatched (1)')
      )[0];
      const lowConfTabBtn = findElements(
        allRender.vnode,
        (el) => el.type === 'button' && getTextContent(el).includes('Low-Confidence (1)')
      )[0];
      expect(unmatchedTabBtn).toBeDefined();
      expect(lowConfTabBtn).toBeDefined();

      // Verify both accordion sections render in "all" view with granular diagnostic badges
      expect(allRender.text).toContain('Unmatched Games');
      expect(allRender.text).toContain('Codename Cobalt Untracked');
      expect(allRender.text).toContain('Missing All Artwork');
      expect(allRender.text).not.toContain('Unmatched Identity');

      expect(allRender.text).toContain('Low-Confidence Automatic Matches');
      expect(allRender.text).toContain('Gothic II: Gold Edition');
      expect(allRender.text).toContain('Gothic 2 Complete Classic');
      expect(allRender.text).toContain('68% Confidence');

      // Switch to 'unmatched' tab -> shows Unmatched Games, hides Low-Confidence Automatic Matches
      unmatchedTabBtn.props.onClick();
      const unmatchedOnlyRender = render();
      expect(unmatchedOnlyRender.text).toContain('Unmatched Games');
      expect(unmatchedOnlyRender.text).toContain('Codename Cobalt Untracked');
      expect(unmatchedOnlyRender.text).not.toContain('Low-Confidence Automatic Matches');

      // Verify Inspect, Fix Match, and Hide buttons inside Unmatched Games section
      const unmatchedInspectBtn = findElements(
        unmatchedOnlyRender.vnode,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Inspect'
      )[0];
      const unmatchedFixBtn = findElements(
        unmatchedOnlyRender.vnode,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Fix Match'
      )[0];
      const unmatchedHideBtn = findElements(
        unmatchedOnlyRender.vnode,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Hide'
      )[0];
      expect(unmatchedInspectBtn).toBeDefined();
      expect(unmatchedFixBtn).toBeDefined();
      expect(unmatchedHideBtn).toBeDefined();

      unmatchedInspectBtn.props.onClick();
      expect(onInspectGame).toHaveBeenCalledWith(genuinelyUnmatched);
      unmatchedFixBtn.props.onClick();
      expect(onFixMatchForGame).toHaveBeenCalledWith(genuinelyUnmatched);
      unmatchedHideBtn.props.onClick();
      expect(onHideGame).toHaveBeenCalledWith(genuinelyUnmatched);

      // Switch to 'low_confidence' tab -> shows Low-Confidence Automatic Matches, hides Unmatched Games
      lowConfTabBtn.props.onClick();
      const lowConfOnlyRender = render();
      expect(lowConfOnlyRender.text).toContain('Low-Confidence Automatic Matches');
      expect(lowConfOnlyRender.text).toContain('Gothic II: Gold Edition');
      expect(lowConfOnlyRender.text).not.toContain('Unmatched Games');

      // Verify Inspect, Verify / Fix Match, and Hide buttons inside Low-Confidence Automatic Matches section
      const lowConfInspectBtn = findElements(
        lowConfOnlyRender.vnode,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Inspect'
      )[0];
      const lowConfVerifyFixBtn = findElements(
        lowConfOnlyRender.vnode,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Verify / Fix Match'
      )[0];
      const lowConfHideBtn = findElements(
        lowConfOnlyRender.vnode,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Hide'
      )[0];
      expect(lowConfInspectBtn).toBeDefined();
      expect(lowConfVerifyFixBtn).toBeDefined();
      expect(lowConfHideBtn).toBeDefined();

      lowConfInspectBtn.props.onClick();
      expect(onInspectGame).toHaveBeenCalledWith(lowConfidenceMatched);
      lowConfVerifyFixBtn.props.onClick();
      expect(onFixMatchForGame).toHaveBeenCalledWith(lowConfidenceMatched);
      lowConfHideBtn.props.onClick();
      expect(onHideGame).toHaveBeenCalledWith(lowConfidenceMatched);
    });

    it('outputs granular diagnostic badges via getGranularUnmatchedReasons, removes No Steam Cross-Match, filters Unmatched Games via the Sub-Filter Pill Bar, and renders Compact Inline Storefront Pills in Merged listings', () => {
      // Game A: Missing All Artwork + Unresolved Codename + Missing Synopsis + Missing Dev/Year
      const codenameMissingAllArt: CanonicalGame = {
        id: 'epic-codename-x99',
        title: 'falcon_build_99',
        originalStoreTitle: 'falcon_build_99',
        sortTitle: 'falcon_build_99',
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'falcon_build_99',
            originalTitle: 'falcon_build_99',
            installed: false,
          },
        ],
        headerImage: '',
        capsuleImage: '',
        shortDescription: '',
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };

      // Game B: Has 16:9 headerImage + developer + releaseDate, but missing 2:3 vertical cover and no synopsis
      const missingVerticalOnly: CanonicalGame = {
        id: 'gog-445566',
        title: 'Starlight Odyssey',
        originalStoreTitle: 'Starlight Odyssey',
        sortTitle: 'Starlight Odyssey',
        headerImage: 'https://cdn.example.com/starlight_header.jpg',
        capsuleImage: '',
        shortDescription: '',
        releaseDate: '2024',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '445566',
            originalTitle: 'Starlight Odyssey',
            installed: true,
          },
        ],
        developers: ['Nova Forge Studios'],
        publishers: ['Nova Forge Studios'],
        genres: ['RPG'],
        tags: [],
      };

      // Game C: Has both 2:3 capsuleImage & headerImage, no steamAppId, short synopsis (<25 chars -> probed & invalid), and has developer/year
      const shortSynopsisGogOnly: CanonicalGame = {
        id: 'gog-77889900',
        title: 'Chronicles of Aethelgard',
        originalStoreTitle: 'Chronicles of Aethelgard',
        sortTitle: 'Chronicles of Aethelgard',
        headerImage: 'https://cdn.example.com/aethelgard_header.jpg',
        capsuleImage: 'https://cdn.example.com/aethelgard_cover.jpg',
        shortDescription: 'Too short blurb.',
        releaseDate: '2021',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '77889900',
            originalTitle: 'Chronicles of Aethelgard',
            installed: false,
          },
        ],
        developers: ['Aethelgard Team'],
        publishers: ['Aethelgard Team'],
        genres: ['Adventure'],
        tags: [],
      };

      // 1. Direct unit checks on getGranularUnmatchedReasons (verifying No Steam Cross-Match is never produced)
      const reasonsA = getGranularUnmatchedReasons(codenameMissingAllArt).map((r) => r.label);
      expect(reasonsA).toContain('Missing All Artwork');
      expect(reasonsA).toContain('Unresolved Store Codename / Slug');
      expect(reasonsA).toContain('Missing Store Synopsis');
      expect(reasonsA).toContain('Missing Developer & Release Year');
      expect(reasonsA.some((l) => l.includes('No Steam Cross-Match'))).toBe(false);
      expect(reasonsA).not.toContain('Unmatched Identity');

      const reasonsB = getGranularUnmatchedReasons({
        ...missingVerticalOnly,
        steamAppId: 445566,
        shortDescription:
          'Explore distant star systems and command your flagship in a tactical space RPG.',
      }).map((r) => r.label);
      expect(reasonsB).toEqual(['Missing 2:3 Cover Art']);

      const reasonsC = getGranularUnmatchedReasons(shortSynopsisGogOnly).map((r) => r.label);
      expect(reasonsC).toEqual(['Missing Store Synopsis']);
      expect(reasonsC.some((l) => l.includes('No Steam Cross-Match'))).toBe(false);

      // 2. Render LibraryMatchManagerModal with all 3 unmatched games + 1 merged multi-storefront game
      const mergedGame: CanonicalGame = {
        id: 'steam-292030',
        title: 'The Witcher 3: Wild Hunt',
        originalStoreTitle: 'The Witcher 3: Wild Hunt',
        sortTitle: 'Witcher 3: Wild Hunt',
        steamAppId: 292030,
        capsuleImage: 'https://cdn.example.com/w3_cover.jpg',
        headerImage: 'https://cdn.example.com/w3_header.jpg',
        shortDescription:
          'You are Geralt of Rivia, mercenary monster slayer, in a war-torn open world.',
        releaseDate: '2015',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1207664643',
            originalTitle: 'The Witcher 3: Wild Hunt - GOTY',
            installed: true,
          },
          {
            platformId: 'steam',
            platformGameId: '292030',
            originalTitle: 'The Witcher 3: Wild Hunt',
            installed: false,
          },
        ],
        developers: ['CD PROJEKT RED'],
        publishers: ['CD PROJEKT RED'],
        genres: ['RPG'],
        tags: [],
      };

      const { render } = createStatefulRenderer(LibraryMatchManagerModal, {
        isOpen: true,
        games: [codenameMissingAllArt, missingVerticalOnly, shortSynopsisGogOnly, mergedGame],
        onClose: vi.fn(),
        onFixMatchForGame: vi.fn(),
        onHideGame: vi.fn(),
      });

      const initial = render();

      // Verify granular badges are rendered in Unmatched Games and neither "No Steam Cross-Match" nor "Unmatched Identity" is ever rendered
      expect(initial.text).toContain('Missing All Artwork');
      expect(initial.text).toContain('Missing 2:3 Cover Art');
      expect(initial.text).toContain('Unresolved Store Codename / Slug');
      expect(initial.text).toContain('Missing Store Synopsis');
      expect(initial.text).toContain('Missing Developer & Release Year');
      expect(initial.text).not.toContain('No Steam Cross-Match');
      expect(initial.text).not.toContain('Unmatched Identity');

      // Verify Sub-Filter Pill Bar counts and filtering inside Unmatched Games
      expect(initial.text).toContain('Filter by Reason:');
      expect(initial.text).toContain('All (3)');
      expect(initial.text).toContain('Missing Artwork (2)');
      expect(initial.text).toContain('Missing Synopsis (3)');
      expect(initial.text).toContain('Missing Dev / Year (1)');

      // Click "Missing Artwork (2)" pill -> shows falcon_build_99 and Starlight Odyssey, hides Chronicles of Aethelgard
      const artworkFilterBtn = findElements(
        initial.vnode,
        (el) => el.type === 'button' && getTextContent(el).includes('Missing Artwork (2)')
      )[0];
      expect(artworkFilterBtn).toBeDefined();
      artworkFilterBtn.props.onClick();
      const afterArtworkFilter = render();
      expect(afterArtworkFilter.text).toContain('falcon_build_99');
      expect(afterArtworkFilter.text).toContain('Starlight Odyssey');
      expect(afterArtworkFilter.text).not.toContain('Chronicles of Aethelgard');

      // Click "Missing Synopsis (3)" pill -> shows all 3 unmatched games missing synopsis
      const synopsisFilterBtn = findElements(
        afterArtworkFilter.vnode,
        (el) => el.type === 'button' && getTextContent(el).includes('Missing Synopsis (3)')
      )[0];
      expect(synopsisFilterBtn).toBeDefined();
      synopsisFilterBtn.props.onClick();
      const afterSynopsisFilter = render();
      expect(afterSynopsisFilter.text).toContain('falcon_build_99');
      expect(afterSynopsisFilter.text).toContain('Chronicles of Aethelgard');
      expect(afterSynopsisFilter.text).toContain('Starlight Odyssey');

      // Click "Missing Dev / Year (1)" pill -> shows only falcon_build_99
      const devYearFilterBtn = findElements(
        afterSynopsisFilter.vnode,
        (el) => el.type === 'button' && getTextContent(el).includes('Missing Dev / Year (1)')
      )[0];
      expect(devYearFilterBtn).toBeDefined();
      devYearFilterBtn.props.onClick();
      const afterDevYearFilter = render();
      expect(afterDevYearFilter.text).toContain('falcon_build_99');
      expect(afterDevYearFilter.text).not.toContain('Starlight Odyssey');
      expect(afterDevYearFilter.text).not.toContain('Chronicles of Aethelgard');

      // Verify Compact Inline Storefront Pills in Merged Multi-Storefront Listings
      expect(afterDevYearFilter.text).toContain('The Witcher 3: Wild Hunt');
      expect(afterDevYearFilter.text).toContain('2 Storefronts');
      expect(afterDevYearFilter.text).toContain('#1207664643');
      expect(afterDevYearFilter.text).toContain('#292030');
      expect(afterDevYearFilter.text).toContain('The Witcher 3: Wild Hunt - GOTY');
    });

    it('promotes enrichedMetadata synopsis in sanitizeGameCatalog and accurately classifies Citadel Remonstered vs Galactic Civilizations III (Test branch)', () => {
      // 1. Citadel Remonstered (GOG 1786501441) with empty raw shortDescription but rich enrichedMetadata.aboutTheGame
      const citadelRaw: CanonicalGame = {
        id: 'gog-1786501441',
        title: 'Citadel Remonstered',
        originalStoreTitle: 'Citadel Remonstered',
        sortTitle: 'Citadel Remonstered',
        isVerifiedEntitlement: true,
        capsuleImage: 'https://images.gog.com/citadel_vertical_cover.jpg',
        headerImage: 'https://images.gog.com/citadel_horizontal_header.jpg',
        shortDescription: '',
        releaseDate: '2024',
        enrichedMetadata: {
          appId: 0,
          name: 'Citadel Remonstered',
          shortDescription: '',
          detailedDescription:
            '<p>Explore the labyrinthine Citadel, recruit quirky monster companions, and battle strategic bosses in this retro-inspired dungeon RPG.</p>',
          aboutTheGame:
            '<p>Explore the labyrinthine Citadel, recruit quirky monster companions, and battle strategic bosses in this retro-inspired dungeon RPG.</p>',
          headerImage: 'https://images.gog.com/citadel_horizontal_header.jpg',
          developers: ['Citadel Team'],
          publishers: ['Citadel Team'],
          genres: ['RPG'],
          tags: [],
          categories: [],
          screenshots: [],
          movies: [],
          releaseDate: '2024',
          systemRequirements: {},
          reviewSummary: {
            reviewScore: 0,
            reviewScoreDesc: 'No user reviews',
            totalPositive: 0,
            totalNegative: 0,
            totalReviews: 0,
            positivePercent: 0,
          },
        },
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1786501441',
            originalTitle: 'Citadel Remonstered',
            installed: false,
          },
        ],
        developers: ['Citadel Team'],
        publishers: ['Citadel Team'],
        genres: ['RPG'],
        tags: [],
      };

      // Also test an unprobed normal GOG game (valid cover + header, no enrichedMetadata yet)
      const citadelUnprobed: CanonicalGame = {
        ...citadelRaw,
        enrichedMetadata: undefined,
        shortDescription: '',
      };
      expect(isSynopsisAlreadyProbed(citadelUnprobed)).toBe(false);
      expect(getGranularUnmatchedReasons(citadelUnprobed)).toEqual([]);

      // 2. Galactic Civilizations III (Test branch) with synthetic placeholder template description
      const galCivTestBranchRaw: CanonicalGame = {
        id: 'gog-1441974651',
        title: 'Galactic Civilizations III (Test branch)',
        originalStoreTitle: 'Galactic Civilizations III (Test branch)',
        sortTitle: 'Galactic Civilizations III (Test branch)',
        isVerifiedEntitlement: true,
        capsuleImage: 'https://images.gog.com/galciv3_cover.jpg',
        headerImage: 'https://images.gog.com/galciv3_header.jpg',
        shortDescription: 'Galactic Civilizations III (Test branch) is a Action title.',
        releaseDate: '2015',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1441974651',
            originalTitle: 'Galactic Civilizations III (Test branch)',
            installed: false,
          },
        ],
        developers: ['Stardock Entertainment'],
        publishers: ['Stardock Entertainment'],
        genres: ['Strategy'],
        tags: [],
      };

      // Run sanitizeGameCatalog on both games -> Test branch is suppressed by default into getSuppressedCatalogEntries()
      const defaultSanitized = sanitizeGameCatalog([citadelRaw, galCivTestBranchRaw], {
        allowNewPurchases: true,
      });
      expect(defaultSanitized.find((g) => g.id === 'gog-1441974651')).toBeUndefined();
      expect(
        getSuppressedCatalogEntries().some(
          (e) => e.rawTitle === 'Galactic Civilizations III (Test branch)'
        )
      ).toBe(true);

      // When user chooses to include/restore the test branch into their library:
      unhideStorefrontEntry('gog-1441974651', 'gog', '1441974651');

      const sanitized = sanitizeGameCatalog([citadelRaw, galCivTestBranchRaw], {
        allowNewPurchases: true,
      });
      const sanitizedCitadel = sanitized.find((g) => g.id === 'gog-1786501441')!;
      const sanitizedGalCivTest = sanitized.find((g) => g.id === 'gog-1441974651')!;

      expect(sanitizedCitadel).toBeDefined();
      // enrichedMetadata.aboutTheGame is promoted to game.shortDescription!
      expect(sanitizedCitadel.shortDescription).toContain(
        'Explore the labyrinthine Citadel, recruit quirky monster companions'
      );
      expect(hasGenuineStoreSynopsis(sanitizedCitadel)).toBe(true);
      expect(getGranularUnmatchedReasons(sanitizedCitadel)).toEqual([]);

      // Synthetic placeholder template is stripped and test branch is flagged as already probed with missing_synopsis
      expect(sanitizedGalCivTest).toBeDefined();
      expect(sanitizedGalCivTest.shortDescription).toBe('');
      expect(hasGenuineStoreSynopsis(sanitizedGalCivTest)).toBe(false);
      expect(isSynopsisAlreadyProbed(sanitizedGalCivTest)).toBe(true);
      const galCivReasons = getGranularUnmatchedReasons(sanitizedGalCivTest);
      expect(galCivReasons.map((r) => r.code)).toContain('missing_synopsis');
      expect(galCivReasons.map((r) => r.label)).toContain('Missing Store Synopsis');

      // Render LibraryMatchManagerModal -> Citadel Remonstered is NOT in Unmatched Games, Galactic Civilizations III (Test branch) IS in Unmatched Games under Missing Store Synopsis
      const { render } = createStatefulRenderer(LibraryMatchManagerModal, {
        isOpen: true,
        games: [sanitizedCitadel, sanitizedGalCivTest],
        onClose: vi.fn(),
        onFixMatchForGame: vi.fn(),
      });

      const rendered = render();
      expect(rendered.text).toContain('Unmatched (1)');
      expect(rendered.text).toContain('Missing Synopsis (1)');
      expect(rendered.text).toContain('Galactic Civilizations III (Test branch)');
      expect(rendered.text).toContain('Missing Store Synopsis');
      expect(rendered.text).not.toContain('Citadel Remonstered');
    });

    it('supports per-storefront Fix / Split Entry and Hide Entry in Merged Multi-Storefront Listings and unmerges in sanitizeGameCatalog', () => {
      const mergedGame: CanonicalGame = {
        id: 'steam-16810',
        title: "Sid Meier's Civilization IV: Colonization",
        originalStoreTitle: "Sid Meier's Civilization IV: Colonization",
        sortTitle: "Sid Meier's Civilization IV: Colonization",
        steamAppId: 16810,
        isVerifiedEntitlement: true,
        capsuleImage: 'https://cdn.example.com/col_cover.jpg',
        headerImage: 'https://cdn.example.com/col_header.jpg',
        shortDescription: 'Colonize the New World and fight for independence.',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '16810',
            originalTitle: "Sid Meier's Civilization IV: Colonization",
            installed: true,
          },
          {
            platformId: 'gog',
            platformGameId: '1207658889',
            originalTitle: "Sid Meier's Colonization (1994 Classic)",
            installed: false,
          },
        ],
        developers: ['Firaxis Games'],
        publishers: ['2K'],
        genres: ['Strategy'],
        tags: [],
      };

      const onFixMatchForGame = vi.fn();
      const onHideGame = vi.fn();

      const { render } = createStatefulRenderer(LibraryMatchManagerModal, {
        isOpen: true,
        games: [mergedGame],
        onClose: vi.fn(),
        onFixMatchForGame,
        onHideGame,
      });

      const rendered = render();

      // Verify inline compact storefront pills render #platformGameId, Fix / Split Entry, and Hide Entry buttons
      expect(rendered.text).toContain('2 Storefronts');
      expect(rendered.text).toContain('#16810');
      expect(rendered.text).toContain('#1207658889');

      const splitButtons = findElements(
        rendered.vnode,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Fix / Split Entry'
      );
      const hideEntryButtons = findElements(
        rendered.vnode,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Hide Entry'
      );
      expect(splitButtons).toHaveLength(2);
      expect(hideEntryButtons).toHaveLength(2);

      // Click Fix / Split Entry on the GOG entitlement (2nd inline pill)
      splitButtons[1].props.onClick();
      expect(onFixMatchForGame).toHaveBeenCalledTimes(1);
      const splitArg = onFixMatchForGame.mock.calls[0][0];
      expect(splitArg.id).toBe('gog-1207658889');
      expect(splitArg.title).toBe("Sid Meier's Colonization (1994 Classic)");
      expect(splitArg.platforms).toHaveLength(1);
      expect(splitArg.platforms[0].platformId).toBe('gog');
      expect(splitArg.platforms[0].platformGameId).toBe('1207658889');
      expect(splitArg.isSplittingFromMerged).toBe(true);

      // Click Hide Entry on the GOG entitlement (2nd inline pill)
      hideEntryButtons[1].props.onClick();
      expect(onHideGame).toHaveBeenCalledWith(mergedGame, 'gog');

      // Save a UserGameOverride for the split GOG entitlement with splitFromMerged: true
      saveUserOverride({
        gameId: 'gog-1207658889',
        platformId: 'gog',
        platformGameId: '1207658889',
        originalSourceTitle: "Sid Meier's Colonization (1994 Classic)",
        originalSourcePlatformId: 'gog',
        splitFromMerged: true,
        matchedStore: 'gog',
        matchedId: '1207658889',
        steamAppId: null,
        isExplicitNonSteam: true,
        title: "Sid Meier's Colonization (Classic 1994)",
        updatedAt: new Date().toISOString(),
      });

      // Run sanitizeGameCatalog on the merged game -> verify it splits into 2 separate CanonicalGame entries and does NOT re-merge!
      const sanitized = sanitizeGameCatalog([mergedGame], { allowNewPurchases: true });
      expect(sanitized).toHaveLength(2);

      const steamEntry = sanitized.find((g) =>
        g.platforms.some((p) => p.platformId === 'steam' && p.platformGameId === '16810')
      );
      const gogSplitEntry = sanitized.find((g) =>
        g.platforms.some((p) => p.platformId === 'gog' && p.platformGameId === '1207658889')
      );

      expect(steamEntry).toBeDefined();
      expect(steamEntry?.platforms).toHaveLength(1);
      expect(steamEntry?.title).toBe("Sid Meier's Civilization IV: Colonization");

      expect(gogSplitEntry).toBeDefined();
      expect(gogSplitEntry?.platforms).toHaveLength(1);
      expect(gogSplitEntry?.id).toBe('gog-1207658889');
      expect(gogSplitEntry?.title).toBe("Sid Meier's Colonization (Classic 1994)");
    });

    it('hides individual or full storefront entries via hideStorefrontEntry, surfaces them in Suppressed with Unhide / Restore, and restores via unhideStorefrontEntry', () => {
      const mergedGame: CanonicalGame = {
        id: 'steam-22380',
        title: 'Fallout: New Vegas',
        originalStoreTitle: 'Fallout: New Vegas',
        sortTitle: 'Fallout: New Vegas',
        steamAppId: 22380,
        isVerifiedEntitlement: true,
        capsuleImage: 'https://cdn.example.com/fnv.jpg',
        headerImage: 'https://cdn.example.com/fnv_header.jpg',
        shortDescription: 'Welcome to Vegas. New Vegas. Enjoy your stay!',
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '22380',
            originalTitle: 'Fallout: New Vegas',
            installed: true,
          },
          {
            platformId: 'gog',
            platformGameId: '1454587428',
            originalTitle: 'Fallout: New Vegas Ultimate Edition',
            installed: true,
          },
        ],
        developers: ['Obsidian Entertainment'],
        publishers: ['Bethesda Softworks'],
        genres: ['RPG'],
        tags: [],
      };

      const singleGame: CanonicalGame = {
        id: 'epic-fn-festival',
        title: 'Mystery Festival Pack',
        originalStoreTitle: 'Mystery Festival Pack',
        sortTitle: 'Mystery Festival Pack',
        isVerifiedEntitlement: true,
        capsuleImage: 'https://cdn.example.com/festival.jpg',
        headerImage: 'https://cdn.example.com/festival_header.jpg',
        shortDescription: 'A standalone single-storefront title to test hiding and restoring.',
        platforms: [
          {
            platformId: 'epic',
            platformGameId: 'festival-pack-01',
            originalTitle: 'Mystery Festival Pack',
            installed: false,
          },
        ],
        developers: ['Epic Games'],
        publishers: ['Epic Games'],
        genres: ['Action'],
        tags: [],
      };

      // 1. Hide only the GOG entitlement of the multi-storefront merged game
      hideStorefrontEntry(mergedGame, 'gog');
      expect(isStorefrontEntryHidden('gog', '1454587428')).toBe(true);
      expect(isStorefrontEntryHidden('steam', '22380')).toBe(false);

      const afterPartialHide = sanitizeGameCatalog([mergedGame], { allowNewPurchases: true });
      expect(afterPartialHide).toHaveLength(1);
      expect(afterPartialHide[0].platforms).toHaveLength(1);
      expect(afterPartialHide[0].platforms[0].platformId).toBe('steam');

      const suppressedAfterPartial = getSuppressedCatalogEntries();
      const hiddenGogSuppressed = suppressedAfterPartial.find(
        (e) => e.platformId === 'gog' && e.platformGameId === '1454587428'
      );
      expect(hiddenGogSuppressed).toBeDefined();
      expect(hiddenGogSuppressed?.reasonCategory).toBe('user_hidden');

      // 2. Hide the entire single-storefront game
      hideStorefrontEntry(singleGame);
      expect(isStorefrontEntryHidden('epic', 'festival-pack-01', 'epic-fn-festival')).toBe(true);

      const afterFullHide = sanitizeGameCatalog([mergedGame, singleGame], {
        allowNewPurchases: true,
      });
      expect(afterFullHide).toHaveLength(1);
      expect(afterFullHide.find((g) => g.id === 'epic-fn-festival')).toBeUndefined();

      const suppressedAfterFull = getSuppressedCatalogEntries();
      const hiddenSingleSuppressed = suppressedAfterFull.find(
        (e) => e.platformId === 'epic' && e.platformGameId === 'festival-pack-01'
      );
      expect(hiddenSingleSuppressed).toBeDefined();
      expect(hiddenSingleSuppressed?.reasonCategory).toBe('user_hidden');

      // 3. Render LibraryMatchManagerModal with onUnhideEntry provided -> verify Unhide / Restore button triggers onUnhideEntry
      const onUnhideEntry = vi.fn();
      const { render } = createStatefulRenderer(LibraryMatchManagerModal, {
        isOpen: true,
        games: afterFullHide,
        onClose: vi.fn(),
        onFixMatchForGame: vi.fn(),
        onUnhideEntry,
      });

      const modalRender = render();
      const unhideButtons = findElements(
        modalRender.vnode,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Unhide / Restore'
      );
      expect(unhideButtons.length).toBeGreaterThanOrEqual(2);

      // Click Unhide / Restore on the hidden single-storefront entry
      const singleUnhideBtn =
        unhideButtons.find((_, idx) => idx === 1) || unhideButtons[0];
      singleUnhideBtn.props.onClick();
      expect(onUnhideEntry).toHaveBeenCalledTimes(1);
      const unhideArg: SuppressedCatalogEntry = onUnhideEntry.mock.calls[0][0];

      // 4. Call unhideStorefrontEntry for both hidden entries and verify full restoration in sanitizeGameCatalog
      unhideStorefrontEntry(
        unhideArg.id,
        unhideArg.platformId,
        unhideArg.platformGameId
      );
      unhideStorefrontEntry('gog-1454587428', 'gog', '1454587428');
      unhideStorefrontEntry('epic-fn-festival', 'epic', 'festival-pack-01');

      expect(isStorefrontEntryHidden('gog', '1454587428')).toBe(false);
      expect(isStorefrontEntryHidden('epic', 'festival-pack-01', 'epic-fn-festival')).toBe(false);
      expect(Object.keys(loadHiddenStorefrontEntries())).toHaveLength(0);

      const restoredCatalog = sanitizeGameCatalog([mergedGame, singleGame], {
        allowNewPurchases: true,
      });
      expect(restoredCatalog).toHaveLength(2);
      const restoredMerged = restoredCatalog.find((g) => g.id === 'steam-22380');
      const restoredSingle = restoredCatalog.find((g) => g.id === 'epic-fn-festival');
      expect(restoredMerged?.platforms).toHaveLength(2);
      expect(restoredSingle).toBeDefined();
    });

    it('resolves genuine Epic Store synopsis, markdown-stripped longDescription, and full-HD featuredMedia screenshots for 32-char hex AppName titles (Lost in the Hole) and re-probes stale synthetic entries', async () => {
      const fetchEpicProductMetadataMock = vi.fn().mockResolvedValue({
        slug: 'lost-in-the-hole-65319f',
        shortDescription:
          'In the creepy world of an abandoned lab, the player explores a dark and mysterious environment...',
        detailedDescription:
          '<!--textBlock-->\n<!--title-->\n# Lost in the Hole\n<!--text-->\nIn the creepy world of an abandoned lab, the player explores a dark and mysterious environment filled with secrets.\n\nUncover what happened to the facility and escape the depths.',
        aboutTheGame:
          '<!--textBlock-->\n<!--title-->\n# Lost in the Hole\n<!--text-->\nIn the creepy world of an abandoned lab, the player explores a dark and mysterious environment filled with secrets.\n\nUncover what happened to the facility and escape the depths.',
        screenshots: [
          {
            id: 0,
            pathThumbnail:
              'https://cdn1.epicgames.com/spt-assets/5302859a16f7432f890f0a4d09fa9d5c/lost-in-the-hole-1a2b3.jpg',
            pathFull:
              'https://cdn1.epicgames.com/spt-assets/5302859a16f7432f890f0a4d09fa9d5c/lost-in-the-hole-1a2b3.jpg',
          },
          {
            id: 1,
            pathThumbnail:
              'https://cdn1.epicgames.com/spt-assets/5302859a16f7432f890f0a4d09fa9d5c/lost-in-the-hole-4c5d6.jpg',
            pathFull:
              'https://cdn1.epicgames.com/spt-assets/5302859a16f7432f890f0a4d09fa9d5c/lost-in-the-hole-4c5d6.jpg',
          },
          {
            id: 2,
            pathThumbnail:
              'https://cdn1.epicgames.com/spt-assets/5302859a16f7432f890f0a4d09fa9d5c/lost-in-the-hole-7e8f9.jpg',
            pathFull:
              'https://cdn1.epicgames.com/spt-assets/5302859a16f7432f890f0a4d09fa9d5c/lost-in-the-hole-7e8f9.jpg',
          },
        ],
        movies: [],
        pcRequirements: { minimum: 'OS: Windows 10 64-bit' },
        releaseDate: '2024-12-11',
        developers: ['Horizon Studios'],
        publishers: ['Horizon Studios'],
        genres: ['Action', 'Adventure', 'Indie'],
      });

      (window as any).electronAPI = {
        ...((window as any).electronAPI || {}),
        fetchEpicProductMetadata: fetchEpicProductMetadataMock,
      };

      const lostInTheHoleGame: CanonicalGame = {
        id: 'epic-67070b97b6af438f90462fa9e198f2ce',
        title: 'Lost in the Hole',
        sortTitle: 'Lost in the Hole',
        capsuleImage:
          'https://cdn1.epicgames.com/spt-assets/5302859a16f7432f890f0a4d09fa9d5c/lost-in-the-hole-tall.jpg',
        headerImage:
          'https://cdn1.epicgames.com/spt-assets/5302859a16f7432f890f0a4d09fa9d5c/lost-in-the-hole-wide.jpg',
        platforms: [
          {
            platformId: 'epic',
            platformGameId: '67070b97b6af438f90462fa9e198f2ce',
            namespace: 'a4fc4d02412b45da816e5f08061833a7',
            catalogItemId: '67d92b98e3ff46fe8763fba2c267639a',
            installed: false,
          } as any,
        ],
        developers: [],
        publishers: [],
        genres: ['Action'],
        tags: [],
      };

      const enriched =
        await fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(lostInTheHoleGame);

      // 1. Verify IPC received the 32-char hex AppName, namespace, catalogItemId, and title
      expect(fetchEpicProductMetadataMock).toHaveBeenCalledWith(
        expect.objectContaining({
          appName: '67070b97b6af438f90462fa9e198f2ce',
          namespace: 'a4fc4d02412b45da816e5f08061833a7',
          catalogItemId: '67d92b98e3ff46fe8763fba2c267639a',
          title: 'Lost in the Hole',
        })
      );

      // 2. Verify genuine store synopsis and stripped <!--textBlock--> / <!--text--> HTML comments
      expect(enriched.shortDescription).toBe(
        'In the creepy world of an abandoned lab, the player explores a dark and mysterious environment...'
      );
      expect(enriched.detailedDescription).not.toContain('<!--textBlock-->');
      expect(enriched.detailedDescription).not.toContain('<!--text-->');
      expect(enriched.detailedDescription).toContain('<h2 class="bb_tag">Lost in the Hole</h2>');
      expect(enriched.detailedDescription).toContain(
        'In the creepy world of an abandoned lab, the player explores a dark and mysterious environment filled with secrets.'
      );
      expect(enriched.aboutTheGame).not.toContain('<!--');

      // 3. Verify full-HD featuredMedia screenshots and developer/release metadata
      expect(enriched.screenshots).toHaveLength(3);
      expect(enriched.screenshots[0].pathFull).toBe(
        'https://cdn1.epicgames.com/spt-assets/5302859a16f7432f890f0a4d09fa9d5c/lost-in-the-hole-1a2b3.jpg'
      );
      expect(enriched.releaseDate).toBe('2024-12-11');
      expect(enriched.developers).toEqual(['Horizon Studios']);

      // 4. Verify hasGenuineStoreSynopsis and getGranularUnmatchedReasons on the enriched game
      const hydratedGame: CanonicalGame = {
        ...lostInTheHoleGame,
        shortDescription: enriched.shortDescription,
        developers: enriched.developers,
        publishers: enriched.publishers,
        enrichedMetadata: enriched,
      };
      expect(hasGenuineStoreSynopsis(hydratedGame)).toBe(true);
      expect(getGranularUnmatchedReasons(hydratedGame)).toEqual([]);

      // 5. Verify stale localStorage Epic entry with synthetic fallback synopsis + 1 fallback screenshot is NOT treated as already probed
      const staleSyntheticEpicGame: CanonicalGame = {
        ...lostInTheHoleGame,
        shortDescription: 'Lost in the Hole is a Action title developed by Horizon Studios.',
        developers: ['Horizon Studios'],
        enrichedMetadata: {
          ...enriched,
          shortDescription: 'Lost in the Hole is a Action title developed by Horizon Studios.',
          detailedDescription:
            '<p>Lost in the Hole is a Action title developed by Horizon Studios.</p>',
          aboutTheGame: '<p>Lost in the Hole is a Action title developed by Horizon Studios.</p>',
          screenshots: [
            {
              id: 0,
              pathThumbnail: lostInTheHoleGame.headerImage!,
              pathFull: lostInTheHoleGame.headerImage!,
            },
          ],
        },
      };
      expect(hasGenuineStoreSynopsis(staleSyntheticEpicGame)).toBe(false);
      expect(isSynopsisAlreadyProbed(staleSyntheticEpicGame)).toBe(false);
      // Because isSynopsisAlreadyProbed is false, it is queued for automatic re-probe rather than prematurely flagged
      expect(getGranularUnmatchedReasons(staleSyntheticEpicGame)).toEqual([]);
      // If a probe completes and returns null, it is then flagged with Missing Synopsis
      expect(
        getGranularUnmatchedReasons(staleSyntheticEpicGame, undefined, {
          [staleSyntheticEpicGame.id]: null,
        }).map((r) => r.label)
      ).toContain('Missing Store Synopsis');

      // Once enriched with genuine Epic Store metadata + multi-screenshot featuredMedia, isSynopsisAlreadyProbed is true
      expect(isSynopsisAlreadyProbed(hydratedGame)).toBe(true);
    });

    it('purges GOG localization placeholder tokens (product_description_1413291984) and resolves public GOG catalog product (1317223010) for DOOM + DOOM II', async () => {
      // 1. Verify isGenericPlaceholderSynopsis detects GOG localization placeholder tokens
      expect(isGenericPlaceholderSynopsis('product_description_1413291984', 'DOOM + DOOM II')).toBe(
        true
      );
      expect(
        isGenericPlaceholderSynopsis(
          'product_description_1413291984\n<br>product_feature_1413291984',
          'DOOM + DOOM II'
        )
      ).toBe(true);

      // 2. Verify isSynopsisAlreadyProbed returns false when cached enrichedMetadata contains product_description_1413291984,
      // and sanitizeGameCatalog purges the placeholder tokens from both game.shortDescription and game.enrichedMetadata
      const staleDoomGame: CanonicalGame = {
        id: 'gog-1413291984',
        title: 'DOOM + DOOM II',
        sortTitle: 'DOOM + DOOM II',
        capsuleImage: 'https://images.gog-statics.com/doom_vert.jpg',
        headerImage: 'https://images.gog-statics.com/doom_horiz.jpg',
        shortDescription: 'product_description_1413291984',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1413291984',
            installed: true,
          },
        ],
        developers: ['id Software'],
        publishers: ['Bethesda Softworks'],
        genres: ['Action', 'Shooter'],
        tags: ['FPS'],
        enrichedMetadata: {
          appId: 0,
          name: 'DOOM + DOOM II',
          shortDescription: 'product_description_1413291984',
          detailedDescription: 'product_description_1413291984\n<br>product_feature_1413291984',
          aboutTheGame: 'product_description_1413291984\n<br>product_feature_1413291984',
          headerImage: 'https://images.gog-statics.com/doom_horiz.jpg',
          capsuleImage: 'https://images.gog-statics.com/doom_vert.jpg',
          iconUrl: '',
          developers: ['id Software'],
          publishers: ['Bethesda Softworks'],
          releaseDate: 'TBA',
          genres: ['Action', 'Shooter'],
          tags: ['FPS'],
          categories: [],
          screenshots: [],
          movies: [],
          systemRequirements: {},
          reviewSummary: {
            reviewScore: 8,
            reviewScoreDesc: 'Positive',
            totalPositive: 80,
            totalNegative: 20,
            totalReviews: 100,
            positivePercent: 80,
          },
        },
      };

      expect(isSynopsisAlreadyProbed(staleDoomGame)).toBe(false);

      const sanitizedCatalog = sanitizeGameCatalog([staleDoomGame], { allowNewPurchases: true });
      expect(sanitizedCatalog).toHaveLength(1);
      const sanitizedDoom = sanitizedCatalog[0];
      expect(sanitizedDoom.shortDescription || '').not.toContain('product_description_1413291984');
      expect(sanitizedDoom.enrichedMetadata?.shortDescription).toBe('');
      expect(sanitizedDoom.enrichedMetadata?.aboutTheGame).toBe('');
      expect(sanitizedDoom.enrichedMetadata?.detailedDescription).toBe('');

      // 3. Verify fallbackMetadataProvider.fetchGogProductMetadata("1413291984", "DOOM + DOOM II")
      // rejects placeholder tokens from 1413291984 and resolves public catalog product 1317223010
      const axiosGetSpy = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (url.includes('/products/1413291984')) {
          return {
            data: {
              title: 'DOOM + DOOM II',
              slug: 'doom_1993_doom_ii',
              links: {
                purchase_link: 'https://www.gog.com/en/checkout/manual/doom_doom_ii',
              },
              description: {
                lead: 'product_description_1413291984',
                full: 'product_description_1413291984\n<br>product_feature_1413291984',
              },
              screenshots: [],
            },
          } as any;
        }
        if (url.includes('/v2/games/1413291984')) {
          return {
            data: {
              description: 'product_description_1413291984\n<br>product_feature_1413291984',
            },
          } as any;
        }
        if (url.includes('/v1/catalog')) {
          return {
            data: {
              products: [
                {
                  id: '1317223010',
                  slug: 'doom_doom_ii',
                  title: 'DOOM + DOOM II',
                  releaseDate: '2024.08.08',
                  developers: ['id Software', 'Nightdive Studios'],
                  publishers: ['Bethesda Softworks'],
                  coverVertical: 'https://images.gog-statics.com/doom_vert.jpg',
                  coverHorizontal: 'https://images.gog-statics.com/doom_horiz.jpg',
                  screenshots: [
                    'https://images.gog-statics.com/s1_{formatter}.png',
                    'https://images.gog-statics.com/s2_{formatter}.png',
                  ],
                },
              ],
            },
          } as any;
        }
        if (url.includes('/products/1317223010')) {
          return {
            data: {
              title: 'DOOM + DOOM II',
              slug: 'doom_doom_ii',
              description: {
                lead: 'Developed by id Software, and originally released in 1993, DOOM pioneered and popularized the first-person shooter, setting a standard for all FPS games.',
                full: 'Developed by id Software, and originally released in 1993, DOOM pioneered and popularized the first-person shooter, setting a standard for all FPS games. An enhanced version was released for PC, consoles, and mobile devices in 2019.',
              },
            },
          } as any;
        }
        throw new Error(`Unexpected URL in mock: ${url}`);
      });

      try {
        const gogMeta = await fallbackMetadataProvider.fetchGogProductMetadata(
          '1413291984',
          'DOOM + DOOM II'
        );

        expect(gogMeta).not.toBeNull();
        expect(gogMeta?.shortDescription).toBe(
          'Developed by id Software, and originally released in 1993, DOOM pioneered and popularized the first-person shooter, setting a standard for all FPS games.'
        );
        expect(gogMeta?.aboutTheGame).toContain(
          'An enhanced version was released for PC, consoles, and mobile devices in 2019.'
        );
        expect(gogMeta?.aboutTheGame).not.toContain('product_description_1413291984');
        expect(gogMeta?.releaseDate).toBe('2024-08-08');
        expect(gogMeta?.developers).toEqual(['id Software', 'Nightdive Studios']);
        expect(gogMeta?.publishers).toEqual(['Bethesda Softworks']);
        expect(gogMeta?.screenshots).toHaveLength(2);
        expect(gogMeta?.screenshots?.[0].pathFull).toBe(
          'https://images.gog-statics.com/s1_ggvgl_2x.png'
        );
        expect(gogMeta?.screenshots?.[0].pathThumbnail).toBe(
          'https://images.gog-statics.com/s1_ggvgm.png'
        );
      } finally {
        axiosGetSpy.mockRestore();
      }
    });

    it('separates User-Suppressed Titles from Auto-Filtered Non-Games, persists suppressed entries across sanitizeGameCatalog passes, and supports category sub-filters and Include in Library', () => {
      // 1. User hides a real game ("Portal 2")
      const portal2: CanonicalGame = {
        id: 'steam-620',
        title: 'Portal 2',
        sortTitle: 'Portal 2',
        steamAppId: 620,
        isVerifiedEntitlement: true,
        capsuleImage: 'https://cdn.akamai.steamstatic.com/steam/apps/620/library_600x900.jpg',
        headerImage: 'https://cdn.akamai.steamstatic.com/steam/apps/620/header.jpg',
        shortDescription: 'Portal 2 draws from the award-winning formula of innovative gameplay.',
        releaseDate: '2011',
        platforms: [{ platformId: 'steam', platformGameId: '620', installed: false }],
        developers: ['Valve'],
        publishers: ['Valve'],
        genres: ['Action'],
        tags: [],
      };
      hideStorefrontEntry(portal2);

      // 2. Non-game storefront items across categories (Beta/Test, Prologue, Tool/SDK, Soundtrack, DLC)
      const nonGameItems: CanonicalGame[] = [
        {
          id: 'epic-apex-arena-test',
          title: 'Apex Arena - Public Testing',
          sortTitle: 'Apex Arena - Public Testing',
          isVerifiedEntitlement: true,
          capsuleImage: '',
          headerImage: '',
          shortDescription: '',
          releaseDate: '2021',
          platforms: [{ platformId: 'epic', platformGameId: 'apex-arena-test', installed: false }],
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        },
        {
          id: 'gog-syn-city-prologue',
          title: 'Synthetic City Prologue',
          sortTitle: 'Synthetic City Prologue',
          isVerifiedEntitlement: true,
          capsuleImage: '',
          headerImage: '',
          shortDescription: '',
          releaseDate: '2022',
          platforms: [{ platformId: 'gog', platformGameId: '1500000001', installed: false }],
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        },
        {
          id: 'steam-1628350',
          title: 'Steamworks Common Redistributables',
          sortTitle: 'Steamworks Common Redistributables',
          steamAppId: 228980,
          isVerifiedEntitlement: true,
          capsuleImage: '',
          headerImage: '',
          shortDescription: '',
          releaseDate: '2019',
          platforms: [{ platformId: 'steam', platformGameId: '228980', installed: false }],
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        },
        {
          id: 'gog-witcher-goodies',
          title: 'The Witcher Goodies Collection',
          sortTitle: 'The Witcher Goodies Collection',
          isVerifiedEntitlement: true,
          capsuleImage: '',
          headerImage: '',
          shortDescription: '',
          releaseDate: '2020',
          platforms: [{ platformId: 'gog', platformGameId: '19820001', installed: false }],
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        },
        {
          id: 'epic-dying-light-dlc',
          title: 'Dying Light Book of Laughs DLC',
          sortTitle: 'Dying Light Book of Laughs DLC',
          isVerifiedEntitlement: true,
          capsuleImage: '',
          headerImage: '',
          shortDescription: '',
          releaseDate: '2020',
          platforms: [{ platformId: 'epic', platformGameId: 'dl-dlc-1', installed: false }],
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        },
      ];

      // First pass: sanitize catalog containing Portal 2 (hidden) + 5 non-game items
      const firstPass = sanitizeGameCatalog([portal2, ...nonGameItems], {
        allowNewPurchases: true,
      });
      expect(firstPass).toHaveLength(0);

      // Second pass: calling sanitizeGameCatalog on the already-sanitized catalog (simulating App startup / re-sanitization)
      // MUST preserve all previously discovered suppressed entries in localStorage!
      const secondPass = sanitizeGameCatalog(firstPass, { allowNewPurchases: true });
      expect(secondPass).toHaveLength(0);

      const allSuppressed = getSuppressedCatalogEntries();
      expect(allSuppressed.some((e) => e.rawTitle === 'Portal 2' && e.reasonCategory === 'user_hidden')).toBe(true);
      expect(allSuppressed.some((e) => e.rawTitle === 'Apex Arena - Public Testing' && e.reasonCategory === 'non_game_filter')).toBe(true);
      expect(allSuppressed.some((e) => e.rawTitle === 'Synthetic City Prologue' && e.reasonCategory === 'non_game_filter')).toBe(true);
      expect(allSuppressed.some((e) => e.rawTitle === 'Steamworks Common Redistributables' && e.reasonCategory === 'non_game_filter')).toBe(true);
      expect(allSuppressed.some((e) => e.rawTitle === 'The Witcher Goodies Collection' && e.reasonCategory === 'non_game_filter')).toBe(true);
      expect(allSuppressed.some((e) => e.rawTitle === 'Dying Light Book of Laughs DLC' && e.reasonCategory === 'non_game_filter')).toBe(true);

      const onUnhideEntry = vi.fn((entry: SuppressedCatalogEntry) => {
        unhideStorefrontEntry(
          entry.rawGame?.id || `${entry.platformId}:${entry.platformGameId}`,
          entry.platformId,
          entry.platformGameId
        );
      });

      const { render } = createStatefulRenderer(LibraryMatchManagerModal, {
        isOpen: true,
        games: [],
        onClose: vi.fn(),
        onFixMatchForGame: vi.fn(),
        onUnhideEntry,
      });

      // Render "All Sections" view
      let rendered = render();
      expect(rendered.text).toContain('User-Suppressed (1)');
      expect(rendered.text).toContain('Auto-Filtered Non-Games (5)');
      expect(rendered.text).toContain('User-Suppressed Titles');
      expect(rendered.text).toContain('Suppressed & Filtered Storefront Entries');
      expect(rendered.text).toContain('Betas / Test / Legacy (1)');
      expect(rendered.text).toContain('Prologues / Demos (1)');
      expect(rendered.text).toContain('Tools / SDKs / Servers (1)');
      expect(rendered.text).toContain('Soundtracks / Goodies (1)');
      expect(rendered.text).toContain('DLC / Add-ons (1)');

      // Switch to User-Suppressed tab -> shows ONLY Portal 2, NOT the 5 auto-filtered non-games
      const userSuppressedTabBtn = findElements(
        rendered.vnode,
        (el) => el.type === 'button' && getTextContent(el).includes('User-Suppressed (1)')
      )[0];
      expect(userSuppressedTabBtn).toBeDefined();
      userSuppressedTabBtn.props.onClick();

      rendered = render();
      expect(rendered.text).toContain('Portal 2');
      expect(rendered.text).not.toContain('Apex Arena - Public Testing');
      expect(rendered.text).not.toContain('Synthetic City Prologue');

      // Switch to Auto-Filtered Non-Games tab -> shows ONLY the 5 auto-filtered non-games, NOT Portal 2
      const autoFilteredTabBtn = findElements(
        rendered.vnode,
        (el) => el.type === 'button' && getTextContent(el).includes('Auto-Filtered Non-Games (5)')
      )[0];
      expect(autoFilteredTabBtn).toBeDefined();
      autoFilteredTabBtn.props.onClick();

      rendered = render();
      expect(rendered.text).not.toContain('Portal 2');
      expect(rendered.text).toContain('Apex Arena - Public Testing');
      expect(rendered.text).toContain('Synthetic City Prologue');
      expect(rendered.text).toContain('Steamworks Common Redistributables');
      expect(rendered.text).toContain('The Witcher Goodies Collection');
      expect(rendered.text).toContain('Dying Light Book of Laughs DLC');

      // Filter by "Prologues / Demos (1)" sub-filter pill
      const prologueFilterBtn = findElements(
        rendered.vnode,
        (el) => el.type === 'button' && getTextContent(el).includes('Prologues / Demos (1)')
      )[0];
      expect(prologueFilterBtn).toBeDefined();
      prologueFilterBtn.props.onClick();

      rendered = render();
      expect(rendered.text).toContain('Synthetic City Prologue');
      expect(rendered.text).not.toContain('Apex Arena - Public Testing');
      expect(rendered.text).not.toContain('Steamworks Common Redistributables');

      // Click "Include in Library" on Synthetic City Prologue
      const includeBtn = findElements(
        rendered.vnode,
        (el) => el.type === 'button' && getTextContent(el).includes('Include in Library')
      )[0];
      expect(includeBtn).toBeDefined();
      includeBtn.props.onClick();
      expect(onUnhideEntry).toHaveBeenCalledTimes(1);

      // Re-running sanitizeGameCatalog now includes Synthetic City Prologue in the active library!
      const restoredCatalog = sanitizeGameCatalog(nonGameItems, { allowNewPurchases: true });
      expect(restoredCatalog.map((g) => g.title)).toEqual(['Synthetic City Prologue']);
    });

    it('renders the docked Studio Tab Bar (role="tablist" / role="tab") and supports the Two-Accordion Review & Confirmation Workflow in Auto-Filtered Non-Games', () => {
      const nonGameItems: CanonicalGame[] = [
        {
          id: 'epic-apex-arena-test',
          title: 'Apex Arena - Public Testing',
          sortTitle: 'Apex Arena - Public Testing',
          isVerifiedEntitlement: true,
          capsuleImage: '',
          headerImage: '',
          shortDescription: '',
          releaseDate: '2021',
          platforms: [{ platformId: 'epic', platformGameId: 'apex-arena-test', installed: false }],
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        },
        {
          id: 'gog-syn-city-prologue',
          title: 'Synthetic City Prologue',
          sortTitle: 'Synthetic City Prologue',
          isVerifiedEntitlement: true,
          capsuleImage: '',
          headerImage: '',
          shortDescription: '',
          releaseDate: '2022',
          platforms: [{ platformId: 'gog', platformGameId: '1500000001', installed: false }],
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        },
        {
          id: 'steam-1628350',
          title: 'Steamworks Common Redistributables',
          sortTitle: 'Steamworks Common Redistributables',
          steamAppId: 228980,
          isVerifiedEntitlement: true,
          capsuleImage: '',
          headerImage: '',
          shortDescription: '',
          releaseDate: '2019',
          platforms: [{ platformId: 'steam', platformGameId: '228980', installed: false }],
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        },
        {
          id: 'gog-witcher-goodies',
          title: 'The Witcher Goodies Collection',
          sortTitle: 'The Witcher Goodies Collection',
          isVerifiedEntitlement: true,
          capsuleImage: '',
          headerImage: '',
          shortDescription: '',
          releaseDate: '2020',
          platforms: [{ platformId: 'gog', platformGameId: '19820001', installed: false }],
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        },
        {
          id: 'epic-dying-light-dlc',
          title: 'Dying Light Book of Laughs DLC',
          sortTitle: 'Dying Light Book of Laughs DLC',
          isVerifiedEntitlement: true,
          capsuleImage: '',
          headerImage: '',
          shortDescription: '',
          releaseDate: '2020',
          platforms: [{ platformId: 'epic', platformGameId: 'dl-dlc-1', installed: false }],
          developers: [],
          publishers: [],
          genres: [],
          tags: [],
        },
      ];

      sanitizeGameCatalog(nonGameItems, { allowNewPurchases: true });

      const { render } = createStatefulRenderer(LibraryMatchManagerModal, {
        isOpen: true,
        games: [],
        onClose: vi.fn(),
        onFixMatchForGame: vi.fn(),
        onUnhideEntry: vi.fn(),
      });

      // 1. Verify Change 1: Docked Studio Tab Bar with role="tablist", role="tab", aria-selected, and data-tab-id
      let rendered = render();
      const tablist = findElements(
        rendered.vnode,
        (el) =>
          el.props?.role === 'tablist' &&
          el.props?.['aria-label'] === 'Library Match Studio Tabs'
      )[0];
      expect(tablist).toBeDefined();

      const tabButtons = findElements(
        tablist,
        (el) => el.type === 'button' && el.props?.role === 'tab'
      );
      expect(tabButtons).toHaveLength(7);
      expect(tabButtons.map((b) => b.props['data-tab-id'])).toEqual([
        'all',
        'unmatched',
        'low_confidence',
        'user_suppressed',
        'suppressed',
        'overrides',
        'merged',
      ]);

      // Initially "all" tab is active (aria-selected=true) and all others have aria-selected=false
      expect(
        tabButtons.find((b) => b.props['data-tab-id'] === 'all')?.props['aria-selected']
      ).toBe(true);
      expect(
        tabButtons
          .filter((b) => b.props['data-tab-id'] !== 'all')
          .every((b) => b.props['aria-selected'] === false)
      ).toBe(true);

      // Switch to "suppressed" (Auto-Filtered Non-Games) tab and verify aria-selected updates cleanly
      const suppressedTab = tabButtons.find((b) => b.props['data-tab-id'] === 'suppressed')!;
      suppressedTab.props.onClick();
      rendered = render();

      const updatedTabs = findElements(
        rendered.vnode,
        (el) => el.type === 'button' && el.props?.role === 'tab'
      );
      expect(
        updatedTabs.find((b) => b.props['data-tab-id'] === 'suppressed')?.props['aria-selected']
      ).toBe(true);
      expect(
        updatedTabs
          .filter((b) => b.props['data-tab-id'] !== 'suppressed')
          .every((b) => b.props['aria-selected'] === false)
      ).toBe(true);

      // 2. Verify Change 2: Two-Accordion Review & Confirmation Workflow in Auto-Filtered Non-Games
      // Both Accordion 1 (5 Pending Review) and Accordion 2 (0 Confirmed) render initially
      expect(rendered.text).toContain('Suppressed & Filtered Storefront Entries');
      expect(rendered.text).toContain('5 Pending Review');
      expect(rendered.text).toContain('Reviewed & Confirmed Non-Games');
      expect(rendered.text).toContain('0 Confirmed');
      expect(rendered.text).toContain('Auto-Filtered Non-Games (5)');

      // 3. Click "Confirm Suppressed" on the first item ("Apex Arena - Public Testing")
      const singleConfirmBtns = findElements(
        rendered.vnode,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Confirm Suppressed'
      );
      expect(singleConfirmBtns).toHaveLength(5);
      singleConfirmBtns[0].props.onClick();

      rendered = render();
      expect(
        isNonGameStorefrontEntryConfirmed('epic', 'apex-arena-test', 'epic-apex-arena-test')
      ).toBe(true);
      expect(rendered.text).toContain('4 Pending Review');
      expect(rendered.text).toContain('1 Confirmed');
      expect(rendered.text).toContain('Auto-Filtered Non-Games (4)');
      expect(rendered.text).toContain('✓ 1');
      expect(rendered.text).toContain('Confirmed Suppressed');

      // 4. Select two items via checkboxes ("Dying Light Book of Laughs DLC" & "Steamworks Common Redistributables") and click "Confirm Selected (2)"
      const dlCheckbox = findElements(
        rendered.vnode,
        (el) =>
          el.type === 'input' &&
          el.props?.type === 'checkbox' &&
          el.props?.['aria-label'] === 'Select Dying Light Book of Laughs DLC'
      )[0];
      const swCheckbox = findElements(
        rendered.vnode,
        (el) =>
          el.type === 'input' &&
          el.props?.type === 'checkbox' &&
          el.props?.['aria-label'] === 'Select Steamworks Common Redistributables'
      )[0];
      expect(dlCheckbox).toBeDefined();
      expect(swCheckbox).toBeDefined();

      dlCheckbox.props.onChange();
      swCheckbox.props.onChange();
      rendered = render();

      const confirmSelectedBtn = findElements(
        rendered.vnode,
        (el) => el.type === 'button' && getTextContent(el).includes('Confirm Selected (2)')
      )[0];
      expect(confirmSelectedBtn).toBeDefined();
      confirmSelectedBtn.props.onClick();

      rendered = render();
      expect(rendered.text).toContain('2 Pending Review');
      expect(rendered.text).toContain('3 Confirmed');
      expect(rendered.text).toContain('Auto-Filtered Non-Games (2)');
      expect(rendered.text).toContain('✓ 3');

      // 5. Click "Confirm All Shown (2)" to move the remaining 2 items into Accordion 2 (Reviewed & Confirmed Non-Games)
      const confirmAllShownBtn = findElements(
        rendered.vnode,
        (el) => el.type === 'button' && getTextContent(el).includes('Confirm All Shown (2)')
      )[0];
      expect(confirmAllShownBtn).toBeDefined();
      confirmAllShownBtn.props.onClick();

      rendered = render();
      expect(rendered.text).toContain('0 Pending Review');
      expect(rendered.text).toContain('5 Confirmed');
      expect(rendered.text).toContain('Auto-Filtered Non-Games (0)');
      expect(rendered.text).toContain('✓ 5');
      expect(rendered.text).toContain(
        'All auto-filtered storefront entries have been reviewed and confirmed!'
      );

      // 6. Simulate a future library sync where a NEW non-game storefront item is added to the user's library
      const newlyAcquiredGoodies: CanonicalGame = {
        id: 'gog-cyberpunk-goodies',
        title: 'Cyberpunk 2077 Digital Goodies',
        sortTitle: 'Cyberpunk 2077 Digital Goodies',
        isVerifiedEntitlement: true,
        capsuleImage: '',
        headerImage: '',
        shortDescription: '',
        releaseDate: '2023',
        platforms: [{ platformId: 'gog', platformGameId: '2099887766', installed: false }],
        developers: [],
        publishers: [],
        genres: [],
        tags: [],
      };
      const syncedCatalog = sanitizeGameCatalog([...nonGameItems, newlyAcquiredGoodies], {
        allowNewPurchases: true,
      });

      rendered = render({ games: syncedCatalog });
      // ONLY the newly added unreviewed item appears in Accordion 1 (1 Pending Review), while all 5 previously confirmed items stay in Accordion 2 (5 Confirmed)!
      expect(rendered.text).toContain('1 Pending Review');
      expect(rendered.text).toContain('5 Confirmed');
      expect(rendered.text).toContain('Auto-Filtered Non-Games (1)');
      expect(rendered.text).toContain('✓ 5');
      expect(rendered.text).toContain('Cyberpunk 2077 Digital Goodies');
      expect(rendered.text).toContain('Soundtracks / Goodies (1)');

      const pendingCheckboxesAfterSync = findElements(
        rendered.vnode,
        (el) => el.type === 'input' && el.props?.type === 'checkbox'
      );
      expect(pendingCheckboxesAfterSync).toHaveLength(1);
      expect(pendingCheckboxesAfterSync[0].props['aria-label']).toBe(
        'Select Cyberpunk 2077 Digital Goodies'
      );

      // 7. Click "Move to Pending Review" on a confirmed item in Accordion 2 -> moves it back to Accordion 1 (Pending Review)
      const moveToPendingBtns = findElements(
        rendered.vnode,
        (el) => el.type === 'button' && getTextContent(el).trim() === 'Move to Pending Review'
      );
      expect(moveToPendingBtns).toHaveLength(5);
      moveToPendingBtns[0].props.onClick();

      rendered = render();
      expect(rendered.text).toContain('2 Pending Review');
      expect(rendered.text).toContain('4 Confirmed');
      expect(rendered.text).toContain('Auto-Filtered Non-Games (2)');
      expect(rendered.text).toContain('✓ 4');
    });
  });
});

