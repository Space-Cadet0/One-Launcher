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
    expect(openHtml).toContain('3. Review &amp; Apply');
    expect(openHtml).toContain('Game is not on Steam (IGDB/GOG only)');
  });

  it('audits all 811 games to identify which games were blocked by canSyncCurrentGame', async () => {
    const { FULL_USER_STEAM_GAMES } = await import('../src/services/storage/fullUserSteamGames');
    const { GOG_USER_LIBRARY } = await import('../src/services/storage/gogUserLibrary');
    const { EPIC_USER_LIBRARY } = await import('../src/services/storage/epicUserLibrary');
    const { sanitizeGameCatalog } = await import('../src/services/integrations/catalogSanitizer');
    const { mergeStorefrontGames } = await import('../src/services/integrations/integrationStorage');
    const { steamMatcher } = await import('../src/services/steam/steamMatcher');

    let catalog = sanitizeGameCatalog(FULL_USER_STEAM_GAMES);
    catalog = mergeStorefrontGames(catalog, GOG_USER_LIBRARY, 'gog');
    catalog = mergeStorefrontGames(catalog, EPIC_USER_LIBRARY, 'epic');

    const blockedGames = catalog.filter((g) => !g.steamAppId && !steamMatcher.matchGameToSteamInstant(g.title));
    const matchedGames = catalog.filter((g) => g.steamAppId || steamMatcher.matchGameToSteamInstant(g.title));

    console.log(`[AUDIT] Total games in catalog: ${catalog.length}`);
    console.log(`[AUDIT] Games with Steam match (previously allowed): ${matchedGames.length}`);
    console.log(`[AUDIT] Games WITHOUT Steam match (previously BLOCKED in burger menu): ${blockedGames.length}`);
    console.log(`[AUDIT] ALL 105 BLOCKED GAMES:`, JSON.stringify(blockedGames.map(g => g.title), null, 2));

    expect(catalog).toHaveLength(811);
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

  it('renders Wand button in SteamLibraryActionBar when onFixMatch prop is supplied', async () => {
    const { SteamLibraryActionBar } = await import('../src/components/SteamStoreDetail/SteamLibraryActionBar');

    const html = renderToString(
      React.createElement(SteamLibraryActionBar, {
        game: mockGame,
        collections: mockCollections,
        onFixMatch: vi.fn(),
      })
    );

    expect(html).toContain('Fix match, cover poster &amp; scraped metadata...');
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
