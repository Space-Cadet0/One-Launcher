import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { CanonicalGame } from '../src/contracts/game';
import { SteamStorePage } from '../src/components/SteamStoreDetail/SteamStorePage';
import { SteamLibraryActionBar } from '../src/components/SteamStoreDetail/SteamLibraryActionBar';
import { GameLaunchConfigModal } from '../src/components/Launcher/GameLaunchConfigModal';
import { GameInstallModal } from '../src/components/Launcher/GameInstallModal';
import { launcherService } from '../src/services/launcher/launcherService';
import { steamApi } from '../src/services/steam/steamApi';
import { steamAchievementsService } from '../src/services/steam/steamAchievementsService';

vi.mock('dompurify', () => ({
  default: {
    sanitize: (html: string) => html,
  },
}));

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
    innerWidth: 1440,
    innerHeight: 900,
  };
}

if (typeof (globalThis as any).document === 'undefined') {
  (globalThis as any).document = {
    addEventListener: (type: string, listener: any) => eventTarget.addEventListener(type, listener),
    removeEventListener: (type: string, listener: any) =>
      eventTarget.removeEventListener(type, listener),
    body: {},
  };
}

// ---------------------------------------------------------------------------
// Stateful React 19 Component Test Harness
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
  if (node && typeof node === 'object' && node.props) {
    return getTextContent(node.props.children);
  }
  return '';
}

function createComponentHarness<P extends object>(Component: React.FC<P>, initialProps: P) {
  const states: any[] = [];
  const refs: Array<{ current: any }> = [];
  const prevDeps: Array<any[] | undefined> = [];
  const cleanups: Array<(() => void) | undefined> = [];
  let currentProps = initialProps;

  const render = (nextProps?: Partial<P>) => {
    if (nextProps) {
      currentProps = { ...currentProps, ...nextProps };
    }
    let stateIdx = 0;
    let refIdx = 0;
    let effectIdx = 0;
    const pendingEffects: Array<{ idx: number; fn: () => any }> = [];

    const internals = (React as any)
      .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prevH = internals.H;

    const runEffectHook = (fn: () => any, deps?: any[]) => {
      const idx = effectIdx++;
      const oldDeps = prevDeps[idx];
      const changed =
        !oldDeps ||
        !deps ||
        oldDeps.length !== deps.length ||
        deps.some((d, i) => !Object.is(d, oldDeps[i]));
      if (changed) {
        prevDeps[idx] = deps;
        pendingEffects.push({ idx, fn });
      }
    };

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
      useRef(initial: any) {
        const idx = refIdx++;
        if (idx >= refs.length) {
          refs.push({ current: initial });
        }
        return refs[idx];
      },
      useEffect: runEffectHook,
      useLayoutEffect: runEffectHook,
      useMemo(fn: () => any) {
        return fn();
      },
      useCallback(fn: any) {
        return fn;
      },
    };

    let tree: any;
    try {
      tree = Component(currentProps);
    } finally {
      internals.H = prevH;
    }

    for (const eff of pendingEffects) {
      if (typeof cleanups[eff.idx] === 'function') {
        cleanups[eff.idx]!();
      }
      const cleanup = eff.fn();
      cleanups[eff.idx] = typeof cleanup === 'function' ? cleanup : undefined;
    }

    return tree;
  };

  const unmount = () => {
    for (const c of cleanups) {
      if (typeof c === 'function') c();
    }
  };

  return { render, unmount, states, refs };
}

function createSampleGame(overrides?: Partial<CanonicalGame>): CanonicalGame {
  return {
    id: 'steam-1091500',
    title: 'Cyberpunk 2077',
    steamAppId: 1091500,
    headerImage: 'https://cdn.akamai.steamstatic.com/steam/apps/1091500/header.jpg',
    shortDescription: 'An open-world, action-adventure RPG set in the dark future of Night City.',
    developers: ['CD PROJEKT RED'],
    publishers: ['CD PROJEKT RED'],
    genres: ['RPG', 'Action'],
    tags: ['Cyberpunk', 'Open World', 'RPG'],
    releaseDate: '10 Dec, 2020',
    platforms: [
      {
        platformId: 'steam',
        platformGameId: '1091500',
        installed: true,
        installPath: '/Users/test/Games/Cyberpunk 2077',
        executablePath: '/Users/test/Games/Cyberpunk 2077/bin/x64/Cyberpunk2077.exe',
        isWindowsBinaryOnMac: true,
        playtimeMinutes: 1240,
      },
    ],
    enrichedMetadata: {
      appId: 1091500,
      name: 'Cyberpunk 2077',
      shortDescription: 'An open-world, action-adventure RPG set in the dark future of Night City.',
      aboutTheGame: '<p>Cyberpunk 2077 is an open-world action-adventure RPG.</p>',
      headerImage: 'https://cdn.akamai.steamstatic.com/steam/apps/1091500/header.jpg',
      developers: ['CD PROJEKT RED'],
      publishers: ['CD PROJEKT RED'],
      genres: ['RPG', 'Action'],
      tags: ['Cyberpunk', 'Open World'],
      releaseDate: '10 Dec, 2020',
      screenshots: [
        {
          id: 1,
          pathThumbnail: 'https://cdn.akamai.steamstatic.com/steam/apps/1091500/ss_1.jpg',
          pathFull: 'https://cdn.akamai.steamstatic.com/steam/apps/1091500/ss_1_full.jpg',
        },
      ],
      movies: [],
      categories: ['Single-player', 'Steam Achievements'],
      supportedLanguages: 'English<strong>*</strong>',
    },
    ...overrides,
  };
}

describe('Game Detail Page Refresh & Modal Stability Fix', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(steamApi, 'fetchGameMetadata').mockResolvedValue({
      appId: 1091500,
      name: 'Cyberpunk 2077',
      shortDescription: 'Live enriched description from background Steam store sync.',
      aboutTheGame: '<p>Live enriched About This Game content.</p>',
      headerImage: 'https://cdn.akamai.steamstatic.com/steam/apps/1091500/header.jpg',
      developers: ['CD PROJEKT RED'],
      publishers: ['CD PROJEKT RED'],
      genres: ['RPG', 'Action'],
      tags: ['Cyberpunk', 'Open World', 'Sci-fi'],
      releaseDate: '10 Dec, 2020',
      screenshots: [
        {
          id: 1,
          pathThumbnail: 'https://cdn.akamai.steamstatic.com/steam/apps/1091500/ss_1.jpg',
          pathFull: 'https://cdn.akamai.steamstatic.com/steam/apps/1091500/ss_1_full.jpg',
        },
        {
          id: 2,
          pathThumbnail: 'https://cdn.akamai.steamstatic.com/steam/apps/1091500/ss_2.jpg',
          pathFull: 'https://cdn.akamai.steamstatic.com/steam/apps/1091500/ss_2_full.jpg',
        },
      ],
      movies: [],
      categories: ['Single-player', 'Steam Achievements'],
      supportedLanguages: 'English<strong>*</strong>',
    } as any);
    vi.spyOn(steamAchievementsService, 'fetchPlayerGameAchievements').mockResolvedValue({
      unlocked: 25,
      total: 44,
      percentage: 57,
      source: 'steam_api',
    } as any);
    vi.spyOn(launcherService, 'detectCompatibilityLayers').mockResolvedValue([
      {
        type: 'crossover',
        name: 'CrossOver macOS',
        version: '24.0.5',
        executablePath: '/Applications/CrossOver.app',
        availableBottles: ['Steam', 'CyberpunkBottle'],
      },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('verifies src/App.tsx uses stable key={currentEntry.selectedGameId || selectedGame.id} on SteamStorePage without gameRefreshKey', () => {
    const appPath = path.resolve(__dirname, '../src/App.tsx');
    const appSource = fs.readFileSync(appPath, 'utf-8');

    // Must not use gameRefreshKey in SteamStorePage's React key
    expect(appSource).not.toContain('key={`${selectedGame.id}-${gameRefreshKey}`}');
    expect(appSource).toContain('key={currentEntry.selectedGameId || selectedGame.id}');
  });

  it('preserves SteamStorePage without unmounting or flashing loading skeleton when parent re-renders with a new CanonicalGame reference', () => {
    const initialGame = createSampleGame();
    const pageHarness = createComponentHarness(SteamStorePage, {
      game: initialGame,
      collections: [],
    });

    const tree1 = pageHarness.render();
    expect(getTextContent(tree1)).not.toContain('Loading Steam Media...');

    // Verify SteamLibraryActionBar is rendered with initialGame
    const actionBarNode1 = findElements(
      tree1,
      (el) => el.type === SteamLibraryActionBar
    )[0];
    expect(actionBarNode1).toBeDefined();
    expect(actionBarNode1.props.game.id).toBe('steam-1091500');

    // Simulate background onGameUpdated / storefront sync returning a brand-new CanonicalGame object reference
    const refreshedGame: CanonicalGame = {
      ...initialGame,
      shortDescription: 'Updated short description from background sync',
      platforms: [
        {
          ...initialGame.platforms[0],
          playtimeMinutes: 1265,
          achievements: {
            unlocked: 25,
            total: 44,
            percentage: 57,
          },
        },
      ],
      enrichedMetadata: {
        ...initialGame.enrichedMetadata!,
        shortDescription: 'Updated short description from background sync',
      },
    };

    expect(refreshedGame).not.toBe(initialGame);

    // Re-render SteamStorePage with the new CanonicalGame object reference
    const tree2 = pageHarness.render({ game: refreshedGame });

    // Must NOT flash "Loading Steam Media..." skeleton
    expect(getTextContent(tree2)).not.toContain('Loading Steam Media...');

    // Even if a transient re-render passes a game object while enrichedMetadata is being merged,
    // same game.id must never flip isLoading back to true
    const transientGameRef: CanonicalGame = {
      ...refreshedGame,
      enrichedMetadata: undefined,
    };
    const tree3 = pageHarness.render({ game: transientGameRef });
    expect(getTextContent(tree3)).not.toContain('Loading Steam Media...');

    pageHarness.unmount();
  });

  it('keeps GameLaunchConfigModal open and preserves unsaved user edits (-novid -console) when SteamStorePage / parent re-renders with a new CanonicalGame reference', () => {
    const initialGame = createSampleGame();

    // 1. Mount SteamStorePage and SteamLibraryActionBar
    const pageHarness = createComponentHarness(SteamStorePage, {
      game: initialGame,
      collections: [],
    });
    const pageTree1 = pageHarness.render();
    const actionBarProps1 = findElements(
      pageTree1,
      (el) => el.type === SteamLibraryActionBar
    )[0].props;

    const actionBarHarness = createComponentHarness(SteamLibraryActionBar, actionBarProps1);
    let actionBarTree = actionBarHarness.render();

    // Initially, GameLaunchConfigModal is closed (isOpen = false)
    let launchModalNode = findElements(
      actionBarTree,
      (el) => el.type === GameLaunchConfigModal
    )[0];
    expect(launchModalNode).toBeDefined();
    expect(launchModalNode.props.isOpen).toBe(false);

    // 2. Open Manage dropdown menu and click "Launch & Compatibility Settings..."
    const manageBtn = findElements(
      actionBarTree,
      (el) => el.type === 'button' && el.props?.['aria-label'] === 'Manage Game'
    )[0];
    expect(manageBtn).toBeDefined();
    manageBtn.props.onClick();

    actionBarTree = actionBarHarness.render();
    const launchSettingsMenuBtn = findElements(
      actionBarTree,
      (el) =>
        el.type === 'button' &&
        getTextContent(el).includes('Launch & Compatibility Settings')
    )[0];
    expect(launchSettingsMenuBtn).toBeDefined();
    launchSettingsMenuBtn.props.onClick();

    // Re-render SteamLibraryActionBar -> GameLaunchConfigModal is now open!
    actionBarTree = actionBarHarness.render();
    launchModalNode = findElements(
      actionBarTree,
      (el) => el.type === GameLaunchConfigModal
    )[0];
    expect(launchModalNode.props.isOpen).toBe(true);

    // 3. Mount GameLaunchConfigModal and make an unsaved user edit (-novid -console)
    const modalHarness = createComponentHarness(
      GameLaunchConfigModal,
      launchModalNode.props
    );
    let modalTree = modalHarness.render();
    expect(modalTree).not.toBeNull();
    expect(getTextContent(modalTree)).toContain('Launch & Compatibility Settings');

    // Find the Custom Launch Arguments input and type '-novid -console'
    const argsInputBefore = findElements(
      modalTree,
      (el) =>
        el.type === 'input' &&
        typeof el.props?.placeholder === 'string' &&
        el.props.placeholder.includes('-windowed')
    )[0];
    expect(argsInputBefore).toBeDefined();
    expect(argsInputBefore.props.value).toBe('');

    argsInputBefore.props.onChange({ target: { value: '-novid -console' } });

    modalTree = modalHarness.render();
    const argsInputEdited = findElements(
      modalTree,
      (el) =>
        el.type === 'input' &&
        typeof el.props?.placeholder === 'string' &&
        el.props.placeholder.includes('-windowed')
    )[0];
    expect(argsInputEdited.props.value).toBe('-novid -console');

    // 4. Simulate background onGameUpdated / storefront sync completing a few seconds after opening the game page
    const updatedGameFromSync: CanonicalGame = {
      ...initialGame,
      shortDescription: 'Background sync finished!',
      platforms: [
        {
          ...initialGame.platforms[0],
          playtimeMinutes: 1300,
          achievements: { unlocked: 30, total: 44, percentage: 68 },
        },
      ],
      enrichedMetadata: {
        ...initialGame.enrichedMetadata!,
        aboutTheGame: '<p>Newly synced store description.</p>',
      },
    };
    expect(updatedGameFromSync).not.toBe(initialGame);

    // Parent re-renders SteamStorePage with brand-new CanonicalGame reference
    const pageTreeAfterSync = pageHarness.render({ game: updatedGameFromSync });
    // Re-render again so SteamStorePage's useEffect([game]) propagates currentGame to SteamLibraryActionBar
    const pageTreeAfterEffect = pageHarness.render();

    expect(getTextContent(pageTreeAfterSync)).not.toContain('Loading Steam Media...');
    expect(getTextContent(pageTreeAfterEffect)).not.toContain('Loading Steam Media...');

    const actionBarPropsAfterSync = findElements(
      pageTreeAfterEffect,
      (el) => el.type === SteamLibraryActionBar
    )[0].props;
    expect(actionBarPropsAfterSync.game).toBe(updatedGameFromSync);

    // SteamLibraryActionBar re-renders with the new game object reference
    const actionBarTreeAfterSync = actionBarHarness.render(actionBarPropsAfterSync);
    const launchModalNodeAfterSync = findElements(
      actionBarTreeAfterSync,
      (el) => el.type === GameLaunchConfigModal
    )[0];

    // Modal MUST remain open (user is never kicked out!)
    expect(launchModalNodeAfterSync.props.isOpen).toBe(true);
    expect(launchModalNodeAfterSync.props.game).toBe(updatedGameFromSync);

    // GameLaunchConfigModal re-renders with the new game object reference
    const modalTreeAfterSync = modalHarness.render(launchModalNodeAfterSync.props);
    expect(modalTreeAfterSync).not.toBeNull();

    // Unsaved user edit ('-novid -console') MUST be 100% preserved!
    const argsInputAfterSync = findElements(
      modalTreeAfterSync,
      (el) =>
        el.type === 'input' &&
        typeof el.props?.placeholder === 'string' &&
        el.props.placeholder.includes('-windowed')
    )[0];
    expect(argsInputAfterSync).toBeDefined();
    expect(argsInputAfterSync.props.value).toBe('-novid -console');

    modalHarness.unmount();
    actionBarHarness.unmount();
    pageHarness.unmount();
  });

  it('preserves unsaved install directory edits inside GameInstallModal when game object reference updates for the same game.id', () => {
    const initialGame = createSampleGame({
      platforms: [
        {
          platformId: 'gog',
          platformGameId: '1423049311',
          installed: false,
          playtimeMinutes: 120,
        },
      ],
    });

    const installHarness = createComponentHarness(GameInstallModal, {
      isOpen: true,
      game: initialGame,
      initialPlatformId: 'gog',
      onClose: vi.fn(),
    });

    let tree = installHarness.render();
    expect(tree).not.toBeNull();

    // Find custom directory path input and edit it
    const dirInputs = findElements(tree, (el) => el.type === 'input');
    expect(dirInputs.length).toBeGreaterThan(0);
    const dirInput = dirInputs[0];
    dirInput.props.onChange({ target: { value: '/Volumes/ExternalSSD/GOGLibrary' } });

    tree = installHarness.render();
    expect(findElements(tree, (el) => el.type === 'input')[0].props.value).toBe(
      '/Volumes/ExternalSSD/GOGLibrary'
    );

    // Re-render with a brand-new CanonicalGame reference for the same game.id
    const refreshedGame: CanonicalGame = {
      ...initialGame,
      shortDescription: 'Updated in background',
    };
    tree = installHarness.render({ game: refreshedGame });

    // Custom install path must be preserved
    expect(findElements(tree, (el) => el.type === 'input')[0].props.value).toBe(
      '/Volumes/ExternalSSD/GOGLibrary'
    );

    installHarness.unmount();
  });
});
