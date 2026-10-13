import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { CanonicalGame } from '../src/contracts/game';
import { GameAchievementsModal } from '../src/components/Achievements/GameAchievementsModal';

describe('GameAchievementsModal Component', () => {
  const mockGame: CanonicalGame = {
    id: 'steam-1091500',
    title: 'Cyberpunk 2077',
    sortTitle: 'Cyberpunk 2077',
    steamAppId: 1091500,
    platforms: [
      {
        platformId: 'steam',
        platformGameId: '1091500',
        installed: true,
        achievements: {
          total: 44,
          unlocked: 22,
          percentage: 50,
          isMastered: false,
        },
      },
      {
        platformId: 'gog',
        platformGameId: 'cyberpunk_gog',
        installed: false,
        achievements: {
          total: 44,
          unlocked: 10,
          percentage: 22,
          isMastered: false,
        },
      },
    ],
    capsuleImage: 'https://example.com/cyberpunk-capsule.jpg',
    headerImage: 'https://example.com/cyberpunk-header.jpg',
    shortDescription: 'Cyberpunk RPG game.',
    developers: ['CD PROJEKT RED'],
    publishers: ['CD PROJEKT RED'],
    genres: ['RPG'],
    tags: ['Open World', 'Cyberpunk'],
  };

  it('exports GameAchievementsModal as a valid React component function', () => {
    expect(typeof GameAchievementsModal).toBe('function');
  });

  it('renders nothing when isOpen is false', () => {
    const html = renderToString(
      React.createElement(GameAchievementsModal, {
        isOpen: false,
        game: mockGame,
        onClose: vi.fn(),
      })
    );
    expect(html).toBe('');
  });

  it('renders nothing when game is null even if isOpen is true', () => {
    const html = renderToString(
      React.createElement(GameAchievementsModal, {
        isOpen: true,
        game: null,
        onClose: vi.fn(),
      })
    );
    expect(html).toBe('');
  });

  it('renders complete achievements modal structure when open with game', () => {
    const html = renderToString(
      React.createElement(GameAchievementsModal, {
        isOpen: true,
        game: mockGame,
        onClose: vi.fn(),
      })
    );

    // Header and title
    expect(html).toContain('Cyberpunk 2077');
    expect(html).toContain('Achievements');

    // Search and filter toolbar
    expect(html).toContain('Search achievements...');
    expect(html).toContain('All');
    expect(html).toContain('Unlocked');
    expect(html).toContain('Locked');

    // Sorting controls
    expect(html).toContain('Default Order');
    expect(html).toContain('Unlock Date (Recent)');
    expect(html).toContain('Rarity (Rarest First)');
    expect(html).toContain('Rarity (Most Common)');
    expect(html).toContain('Alphabetical (A-Z)');

    // Storefront switcher tabs
    expect(html).toContain('Steam');
    expect(html).toContain('GOG');
  });

  it('accepts initialStorefrontId to select starting storefront tab', () => {
    const html = renderToString(
      React.createElement(GameAchievementsModal, {
        isOpen: true,
        game: mockGame,
        initialStorefrontId: 'gog',
        onClose: vi.fn(),
      })
    );

    expect(html).toContain('GOG');
  });
});
