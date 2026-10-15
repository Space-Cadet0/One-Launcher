import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { CanonicalGame } from '../src/contracts/game';
import { GameCollection } from '../src/contracts/collection';
import { FixMatchWizardModal } from '../src/components/Library/FixMatchWizardModal';
import { GameContextMenu } from '../src/components/Library/GameContextMenu';

describe('Fix Match & Context Menu UI Components', () => {
  const mockGame: CanonicalGame = {
    id: 'steam-1091500',
    title: 'Cyberpunk 2077',
    sortTitle: 'Cyberpunk 2077',
    steamAppId: 1091500,
    platforms: [{ platformId: 'steam', platformGameId: '1091500', installed: true }],
    capsuleImage: 'https://example.com/cover.jpg',
    headerImage: 'https://example.com/header.jpg',
    shortDescription: 'Cyberpunk RPG game.',
    developers: ['CD PROJEKT RED'],
    publishers: ['CD PROJEKT RED'],
    genres: ['RPG'],
    tags: ['Open World'],
  };

  const mockCollections: GameCollection[] = [
    { id: 'favs', name: 'Favorites', gameIds: ['steam-1091500'] },
    { id: 'rpgs', name: 'RPGs', gameIds: [] },
  ];

  it('exports FixMatchWizardModal as a valid React component function', () => {
    expect(typeof FixMatchWizardModal).toBe('function');
  });

  it('exports GameContextMenu as a valid React component function', () => {
    expect(typeof GameContextMenu).toBe('function');
  });

  it('renders empty string when GameContextMenu is closed or game is null', () => {
    const closedHtml = renderToString(
      React.createElement(GameContextMenu, {
        isOpen: false,
        x: 100,
        y: 100,
        game: mockGame,
        collections: mockCollections,
        onClose: vi.fn(),
        onFixMatch: vi.fn(),
        onSyncStoreMedia: vi.fn(),
        onToggleCollection: vi.fn(),
        onManageCollections: vi.fn(),
      })
    );
    expect(closedHtml).toBe('');

    const noGameHtml = renderToString(
      React.createElement(GameContextMenu, {
        isOpen: true,
        x: 100,
        y: 100,
        game: null,
        collections: mockCollections,
        onClose: vi.fn(),
        onFixMatch: vi.fn(),
        onSyncStoreMedia: vi.fn(),
        onToggleCollection: vi.fn(),
        onManageCollections: vi.fn(),
      })
    );
    expect(noGameHtml).toBe('');
  });

  it('renders menu items when GameContextMenu is open with valid game', () => {
    const openHtml = renderToString(
      React.createElement(GameContextMenu, {
        isOpen: true,
        x: 150,
        y: 250,
        game: mockGame,
        collections: mockCollections,
        onClose: vi.fn(),
        onFixMatch: vi.fn(),
        onSyncStoreMedia: vi.fn(),
        onToggleCollection: vi.fn(),
        onManageCollections: vi.fn(),
      })
    );
    expect(openHtml).toContain('Fix Match &amp; Metadata...');
    expect(openHtml).toContain('Sync Store Media (This Game)');
    expect(openHtml).toContain('Assign to Collection');
    expect(openHtml).toContain('Cyberpunk 2077');
  });

  it('renders empty string when FixMatchWizardModal is closed or game is null', () => {
    const closedHtml = renderToString(
      React.createElement(FixMatchWizardModal, {
        isOpen: false,
        game: mockGame,
        onClose: vi.fn(),
        onApplyOverride: vi.fn(),
      })
    );
    expect(closedHtml).toBe('');

    const noGameHtml = renderToString(
      React.createElement(FixMatchWizardModal, {
        isOpen: true,
        game: null,
        onClose: vi.fn(),
        onApplyOverride: vi.fn(),
      })
    );
    expect(noGameHtml).toBe('');
  });

  it('renders modal content with candidate discovery when FixMatchWizardModal is open', () => {
    const openHtml = renderToString(
      React.createElement(FixMatchWizardModal, {
        isOpen: true,
        game: mockGame,
        onClose: vi.fn(),
        onApplyOverride: vi.fn(),
      })
    );
    expect(openHtml).toContain('Fix Match &amp; Metadata');
    expect(openHtml).toContain('1. Match Discovery');
    expect(openHtml).toContain('2. Cover Art');
    expect(openHtml).toContain('3. Review Score &amp; Source');
    expect(openHtml).toContain('4. Metadata &amp; Confirm');
    expect(openHtml).toContain('Game is not on Steam (IGDB/GOG only)');
  });

  it('audits catalog games to identify which games are matched vs non-Steam for canSyncCurrentGame', async () => {
    const { sanitizeGameCatalog } = await import('../src/services/integrations/catalogSanitizer');
    const { mergeStorefrontGames } = await import('../src/services/integrations/integrationStorage');
    const { steamMatcher } = await import('../src/services/steam/steamMatcher');

    const steamFixture: CanonicalGame[] = [
      {
        id: 'steam-1091500',
        title: 'Cyberpunk 2077',
        sortTitle: 'Cyberpunk 2077',
        steamAppId: 1091500,
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'steam', platformGameId: '1091500', installed: true }],
        headerImage: '',
        developers: ['CD PROJEKT RED'],
        publishers: ['CD PROJEKT RED'],
        genres: ['RPG'],
        tags: [],
      },
    ];
    const gogFixture: CanonicalGame[] = [
      {
        id: 'gog-1',
        title: 'DOOM I Enhanced',
        sortTitle: 'DOOM I Enhanced',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'gog', platformGameId: '1', installed: false }],
        headerImage: '',
        developers: ['id Software'],
        publishers: ['Bethesda'],
        genres: ['Action'],
        tags: [],
      },
    ];
    const epicFixture: CanonicalGame[] = [
      {
        id: 'epic-1',
        title: 'Alan Wake 2',
        sortTitle: 'Alan Wake 2',
        isVerifiedEntitlement: true,
        platforms: [{ platformId: 'epic', platformGameId: '1', installed: false }],
        headerImage: '',
        developers: ['Remedy'],
        publishers: ['Epic Games'],
        genres: ['Action'],
        tags: [],
      },
    ];

    let catalog = sanitizeGameCatalog(steamFixture);
    catalog = mergeStorefrontGames(catalog, gogFixture, 'gog');
    catalog = mergeStorefrontGames(catalog, epicFixture, 'epic');

    const blockedGames = catalog.filter((g) => !g.steamAppId && !steamMatcher.matchGameToSteamInstant(g.title));
    const matchedGames = catalog.filter((g) => g.steamAppId || steamMatcher.matchGameToSteamInstant(g.title));

    expect(catalog).toHaveLength(3);
    expect(matchedGames.length + blockedGames.length).toBe(catalog.length);
    expect(blockedGames.length).toBeGreaterThanOrEqual(1);
  });

  it('renders Fix Match & Metadata in TopNavBar burger menu for DOOM I/II games even when canSyncCurrentGame is false', async () => {
    const { TopNavBar } = await import('../src/components/Navigation/TopNavBar');

    const testTitles = ['DOOM I Enhanced', 'DOOM II Enhanced', 'DOOM II + Master Levels'];

    for (const title of testTitles) {
      const html = renderToString(
        React.createElement(TopNavBar, {
          selectedPlatform: 'all',
          onSelectPlatform: vi.fn(),
          installedOnly: false,
          onToggleInstalledOnly: vi.fn(),
          totalGamesCount: 811,
          filteredCount: 811,
          isSyncing: false,
          onTriggerSync: vi.fn(),
          onHomeClick: vi.fn(),
          onOpenIntegrations: vi.fn(),
          currentGameTitle: title,
          canSyncCurrentGame: false, // CRITICAL: canSyncCurrentGame is FALSE!
          defaultMenuOpen: true,     // Open burger menu
          onOpenFixMatch: vi.fn(),
        })
      );

      expect(html).toContain('Fix Match &amp; Metadata...');
      expect(html).toContain(title);
    }
  });

  it('renders Match & Metadata Wizard inside SteamLibraryActionBar Manage Game menu when onFixMatch prop is supplied', async () => {
    const { SteamLibraryActionBar } = await import('../src/components/SteamStoreDetail/SteamLibraryActionBar');

    const states: any[] = [];
    const refs: { current: any }[] = [];
    const findElements = (node: any, predicate: (el: any) => boolean, acc: any[] = []): any[] => {
      if (!node || typeof node !== 'object') return acc;
      if (Array.isArray(node)) {
        for (const child of node) findElements(child, predicate, acc);
        return acc;
      }
      if (predicate(node)) acc.push(node);
      if (node.props && node.props.children) findElements(node.props.children, predicate, acc);
      return acc;
    };

    const renderBar = () => {
      let stateIdx = 0;
      let refIdx = 0;
      const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
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
        useRef(initial: any) {
          const idx = refIdx++;
          if (idx >= refs.length) refs.push({ current: initial });
          return refs[idx];
        },
        useEffect() {},
        useMemo(fn: () => any) {
          return fn();
        },
        useCallback(fn: any) {
          return fn;
        },
      };
      try {
        const vnode = (SteamLibraryActionBar as any)({
          game: mockGame,
          collections: mockCollections,
          onFixMatch: vi.fn(),
        });
        return { vnode, html: renderToString(vnode) };
      } finally {
        internals.H = prevH;
      }
    };

    const closed = renderBar();
    expect(closed.html).not.toContain('Fix match, cover poster &amp; scraped metadata...');

    const manageCogBtn = findElements(
      closed.vnode,
      (el) => el.type === 'button' && el.props?.['aria-label'] === 'Manage Game'
    )[0];
    expect(manageCogBtn).toBeDefined();
    manageCogBtn.props.onClick();

    const open = renderBar();
    expect(open.html).toContain('Match &amp; Metadata Wizard...');
  });

  it('cleans special punctuation such as plus signs from search queries', async () => {
    const { cleanSearchQuery } = await import('../src/services/scraper/metadataScraperService');

    expect(cleanSearchQuery('DOOM II + Master Levels')).toBe('DOOM II Master Levels');
    expect(cleanSearchQuery('DOOM + DOOM II')).toBe('DOOM DOOM II');
    expect(cleanSearchQuery("Broken Sword: Director's Cut")).toBe('Broken Sword Directors Cut');
    expect(cleanSearchQuery('LEGO® Star Wars™ III')).toBe('LEGO Star Wars III');
  });

  it('correctly formats match percentage and prevents 10000% overflow', async () => {
    const { formatMatchPercentage } = await import('../src/components/Library/FixMatchWizardModal');

    expect(formatMatchPercentage(100)).toBe('100% Match');
    expect(formatMatchPercentage(98)).toBe('98% Match');
    expect(formatMatchPercentage(85)).toBe('85% Match');
    expect(formatMatchPercentage(1.0)).toBe('100% Match');
    expect(formatMatchPercentage(0.954)).toBe('95% Match');
    expect(formatMatchPercentage(undefined)).toBeNull();
    expect(formatMatchPercentage(0)).toBeNull();
    expect(formatMatchPercentage(-5)).toBeNull();
  });
});
