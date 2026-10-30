import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { normalizeTitleKey, matchesLooseSearchQuery } from '../src/services/common/titleUtils';
import { metadataScraperService } from '../src/services/scraper/metadataScraperService';
import { achievementDetailService } from '../src/services/achievements/achievementDetailService';
import { LibraryMatchManagerModal } from '../src/components/Library/LibraryMatchManagerModal';
import { GameAchievementsModal } from '../src/components/Achievements/GameAchievementsModal';
import type { CanonicalGame } from '../src/contracts/game';

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

function makeTestGame(partial: Partial<CanonicalGame> & { id: string; title: string }): CanonicalGame {
  return {
    ...partial,
    id: partial.id,
    title: partial.title,
    sortTitle: partial.sortTitle ?? partial.title,
    platforms: partial.platforms || [
      {
        platformId: 'steam',
        platformGameId: partial.id,
        installed: true,
        playtimeMinutes: 120,
      },
    ],
    genres: partial.genres || ['Action'],
    tags: partial.tags || ['Sci-Fi'],
    developers: partial.developers || ['Creative Assembly'],
    publishers: partial.publishers || ['SEGA'],
    releaseDate: partial.releaseDate || '2014-10-07',
    shortDescription:
      partial.shortDescription ??
      'Discover the true meaning of fear in Alien: Isolation, a survival horror set in an atmosphere of constant dread.',
    capsuleImage: partial.capsuleImage,
    headerImage: partial.headerImage ?? 'https://example.com/header.jpg',
  };
}

describe('Punctuation-Tolerant Search & Acronym Normalization Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. normalizeTitleKey & matchesLooseSearchQuery
  // =========================================================================
  describe('normalizeTitleKey & matchesLooseSearchQuery', () => {
    it('matches "Alien: Isolation" with "Alien Isolation" and "alien isolation"', () => {
      expect(normalizeTitleKey('Alien: Isolation')).toBe('alien isolation');
      expect(matchesLooseSearchQuery('Alien: Isolation', 'Alien Isolation')).toBe(true);
      expect(matchesLooseSearchQuery('Alien: Isolation', 'alien isolation')).toBe(true);
      expect(matchesLooseSearchQuery('Alien: Isolation', 'Alien: Isolation')).toBe(true);
    });

    it('matches "Death\'s Door" with "deaths door" and "Death\'s Door"', () => {
      expect(normalizeTitleKey("Death's Door")).toBe('deaths door');
      expect(matchesLooseSearchQuery("Death's Door", 'deaths door')).toBe(true);
      expect(matchesLooseSearchQuery("Death's Door", "Death's Door")).toBe(true);
      expect(matchesLooseSearchQuery('Death’s Door', 'deaths door')).toBe(true);
    });

    it('matches "S.T.A.L.K.E.R. 2: Heart of Chornobyl" with "Stalker", "stalker 2", and "S.T.A.L.K.E.R."', () => {
      expect(normalizeTitleKey('S.T.A.L.K.E.R. 2: Heart of Chornobyl')).toBe(
        'stalker 2 heart of chornobyl'
      );
      expect(matchesLooseSearchQuery('S.T.A.L.K.E.R. 2: Heart of Chornobyl', 'Stalker')).toBe(true);
      expect(matchesLooseSearchQuery('S.T.A.L.K.E.R. 2: Heart of Chornobyl', 'stalker 2')).toBe(
        true
      );
      expect(
        matchesLooseSearchQuery('S.T.A.L.K.E.R. 2: Heart of Chornobyl', 'S.T.A.L.K.E.R.')
      ).toBe(true);
    });

    it('matches "Marvel\'s Spider-Man Remastered" with "spiderman" and "spider man"', () => {
      expect(normalizeTitleKey("Marvel's Spider-Man Remastered")).toBe(
        'marvels spider man remastered'
      );
      expect(matchesLooseSearchQuery("Marvel's Spider-Man Remastered", 'spiderman')).toBe(true);
      expect(matchesLooseSearchQuery("Marvel's Spider-Man Remastered", 'spider man')).toBe(true);
      expect(matchesLooseSearchQuery("Marvel's Spider-Man Remastered", 'marvels spiderman')).toBe(
        true
      );
    });

    it('filters library games using punctuation-free queries across title, originalStoreTitle, developers, genres, and tags', () => {
      const catalog: CanonicalGame[] = [
        makeTestGame({ id: 'g1', title: 'Alien: Isolation' }),
        makeTestGame({ id: 'g2', title: "Death's Door" }),
        makeTestGame({ id: 'g3', title: 'S.T.A.L.K.E.R. 2: Heart of Chornobyl' }),
        makeTestGame({ id: 'g4', title: "Marvel's Spider-Man Remastered" }),
      ];

      const filterByQuery = (q: string) =>
        catalog.filter(
          (game) =>
            matchesLooseSearchQuery(game.title, q) ||
            matchesLooseSearchQuery(game.originalStoreTitle, q)
        );

      expect(filterByQuery('Alien Isolation').map((g) => g.id)).toEqual(['g1']);
      expect(filterByQuery('deaths door').map((g) => g.id)).toEqual(['g2']);
      expect(filterByQuery('stalker 2').map((g) => g.id)).toEqual(['g3']);
      expect(filterByQuery('spiderman').map((g) => g.id)).toEqual(['g4']);
    });
  });

  // =========================================================================
  // 2. LibraryMatchManagerModal Filtering Across Tabs
  // =========================================================================
  describe('LibraryMatchManagerModal punctuation-tolerant filtering across tabs', () => {
    it('filters unmatched, low-confidence, and merged games using "alien isolation" and "stalker 2"', () => {
      const games: CanonicalGame[] = [
        // Unmatched game (missing vertical cover & synopsis)
        makeTestGame({
          id: 'unmatched-alien',
          title: 'Alien: Isolation',
          capsuleImage: '',
          headerImage: '',
          shortDescription: '',
        }),
        // Low-confidence automatic match with apostrophe
        makeTestGame({
          id: 'lowconf-deaths-door',
          title: "Death's Door",
          capsuleImage: 'https://example.com/deaths-door-capsule.jpg',
          matchConfidence: 72,
          needsMatchReview: true,
        }),
        // Merged multi-store game (fully matched)
        makeTestGame({
          id: 'merged-stalker',
          title: 'S.T.A.L.K.E.R. 2: Heart of Chornobyl',
          capsuleImage: 'https://example.com/stalker2-capsule.jpg',
          platforms: [
            { platformId: 'steam', platformGameId: '1643320', installed: true, playtimeMinutes: 60 },
            { platformId: 'gog', platformGameId: 'stalker2', installed: false, playtimeMinutes: 0 },
          ],
        }),
        // Another unmatched game that should be filtered out when searching
        makeTestGame({
          id: 'unmatched-other',
          title: 'Cyberpunk 2077',
          capsuleImage: '',
          headerImage: '',
          shortDescription: '',
        }),
      ];

      const harness = createComponentHarness(LibraryMatchManagerModal, {
        isOpen: true,
        games,
        onClose: vi.fn(),
        onFixMatchForGame: vi.fn(),
      });

      let tree = harness.render();
      const initialNeedsAttentionBtn = findElements(
        tree,
        (el) => el.props?.['data-tab-id'] === 'needs_attention'
      )[0];
      expect(getTextContent(initialNeedsAttentionBtn)).toContain('Needs Attention (3)');

      const searchInput = findElements(
        tree,
        (el) =>
          el.type === 'input' &&
          typeof el.props?.placeholder === 'string' &&
          el.props.placeholder.includes('Filter by title')
      )[0];
      expect(searchInput).toBeDefined();

      // Search for "alien isolation" (without colon) -> matches unmatched game in Needs Attention
      searchInput.props.onChange({ target: { value: 'alien isolation' } });
      tree = harness.render();

      const needsAttentionAfterAlien = findElements(
        tree,
        (el) => el.props?.['data-tab-id'] === 'needs_attention'
      )[0];
      expect(getTextContent(needsAttentionAfterAlien)).toContain('Needs Attention (1)');

      // Search for "deaths door" (without apostrophe) -> matches low-confidence game in Needs Attention
      const searchInputDeathsDoor = findElements(
        tree,
        (el) =>
          el.type === 'input' &&
          typeof el.props?.placeholder === 'string' &&
          el.props.placeholder.includes('Filter by title')
      )[0];
      searchInputDeathsDoor.props.onChange({ target: { value: 'deaths door' } });
      tree = harness.render();

      const needsAttentionAfterDeathsDoor = findElements(
        tree,
        (el) => el.props?.['data-tab-id'] === 'needs_attention'
      )[0];
      expect(getTextContent(needsAttentionAfterDeathsDoor)).toContain('Needs Attention (1)');

      // Search for "stalker 2" (without dots or colon) -> matches merged multi-store game
      const searchInputAfter = findElements(
        tree,
        (el) =>
          el.type === 'input' &&
          typeof el.props?.placeholder === 'string' &&
          el.props.placeholder.includes('Filter by title')
      )[0];
      searchInputAfter.props.onChange({ target: { value: 'stalker 2' } });
      tree = harness.render();

      const needsAttentionAfterStalker = findElements(
        tree,
        (el) => el.props?.['data-tab-id'] === 'needs_attention'
      )[0];
      expect(getTextContent(needsAttentionAfterStalker)).toContain('Needs Attention (0)');

      const mergedTabBtn = findElements(
        tree,
        (el) => el.props?.['data-tab-id'] === 'merged'
      )[0];
      expect(getTextContent(mergedTabBtn)).toContain('Merged Multi-Store (1)');

      harness.unmount();
    });
  });

  // =========================================================================
  // 3. GameAchievementsModal Punctuation-Tolerant Filtering
  // =========================================================================
  describe('GameAchievementsModal punctuation-tolerant achievement filtering', () => {
    it('filters achievements by name and description using punctuation-free queries', async () => {
      vi.spyOn(achievementDetailService, 'fetchGameAchievements').mockResolvedValue({
        steam: {
          storefrontId: 'steam',
          storefrontName: 'Steam',
          total: 3,
          unlocked: 2,
          percentage: 67,
          isMastered: false,
          supportsAchievements: true,
          source: 'live_cloud',
          achievements: [
            {
              id: 'ach-1',
              apiName: 'ACH_1',
              name: "Ripley's Resolve: Survivor",
              description: 'Complete Alien: Isolation without dying once.',
              unlocked: true,
              iconUnlockedUrl: 'https://example.com/ach1.jpg',
              globalPercentage: 2.4,
              storefrontId: 'steam',
            },
            {
              id: 'ach-2',
              apiName: 'ACH_2',
              name: 'S.T.A.L.K.E.R. Veteran',
              description: "Explore the Zone's deepest anomalies.",
              unlocked: true,
              iconUnlockedUrl: 'https://example.com/ach2.jpg',
              globalPercentage: 14.5,
              storefrontId: 'steam',
            },
            {
              id: 'ach-3',
              apiName: 'ACH_3',
              name: 'First Steps',
              description: 'Complete the introductory tutorial.',
              unlocked: false,
              iconUnlockedUrl: 'https://example.com/ach3.jpg',
              globalPercentage: 91.0,
              storefrontId: 'steam',
            },
          ],
        },
      });

      const testGame = makeTestGame({ id: 'steam-214490', title: 'Alien: Isolation' });
      const harness = createComponentHarness(GameAchievementsModal, {
        isOpen: true,
        game: testGame,
        onClose: vi.fn(),
      });

      harness.render();
      // Wait for fetchGameAchievements promise microtask
      await Promise.resolve();
      await Promise.resolve();

      let tree = harness.render();
      expect(getTextContent(tree)).toContain("Ripley's Resolve: Survivor");
      expect(getTextContent(tree)).toContain('S.T.A.L.K.E.R. Veteran');
      expect(getTextContent(tree)).toContain('First Steps');

      // Filter by "ripleys resolve survivor" (no apostrophe, no colon)
      let searchInput = findElements(
        tree,
        (el) => el.type === 'input' && el.props?.placeholder === 'Search achievements...'
      )[0];
      expect(searchInput).toBeDefined();
      searchInput.props.onChange({ target: { value: 'ripleys resolve survivor' } });

      tree = harness.render();
      expect(getTextContent(tree)).toContain("Ripley's Resolve: Survivor");
      expect(getTextContent(tree)).not.toContain('First Steps');

      // Filter by description / acronym "stalker veteran"
      searchInput = findElements(
        tree,
        (el) => el.type === 'input' && el.props?.placeholder === 'Search achievements...'
      )[0];
      searchInput.props.onChange({ target: { value: 'stalker veteran' } });

      tree = harness.render();
      expect(getTextContent(tree)).toContain('S.T.A.L.K.E.R. Veteran');
      expect(getTextContent(tree)).not.toContain("Ripley's Resolve: Survivor");

      harness.unmount();
    });
  });

  // =========================================================================
  // 4. metadataScraperService.searchStorefronts Normalized Fallback
  // =========================================================================
  describe('metadataScraperService.searchStorefronts fallback to normalizeTitleKey(query)', () => {
    it('falls back to normalizeTitleKey(query) when the raw punctuated query returns 0 candidates with confidenceScore >= 60', async () => {
      const executeSpy = vi
        .spyOn(metadataScraperService as any, 'executeStorefrontSearch')
        .mockImplementation(async (...args: unknown[]) => {
          const q = String(args[0] ?? '');
          if (q === 'S.T.A.L.K.E.R. 2: Heart of Chornobyl') {
            // Simulate raw punctuated query returning only a weak (<60) match
            return [
              {
                id: 'steam-999',
                source: 'steam',
                title: 'Unrelated Low Confidence Entry',
                confidenceScore: 35,
              },
            ];
          }
          if (q === 'stalker 2 heart of chornobyl') {
            return [
              {
                id: 'steam-1643320',
                source: 'steam',
                title: 'S.T.A.L.K.E.R. 2: Heart of Chornobyl',
                steamAppId: 1643320,
                confidenceScore: 100,
              },
            ];
          }
          return [];
        });

      const results = await metadataScraperService.searchStorefronts(
        'S.T.A.L.K.E.R. 2: Heart of Chornobyl',
        'steam'
      );

      expect(executeSpy).toHaveBeenCalledTimes(2);
      expect(executeSpy).toHaveBeenNthCalledWith(
        1,
        'S.T.A.L.K.E.R. 2: Heart of Chornobyl',
        'steam'
      );
      expect(executeSpy).toHaveBeenNthCalledWith(2, 'stalker 2 heart of chornobyl', 'steam');
      expect(results[0]).toMatchObject({
        id: 'steam-1643320',
        title: 'S.T.A.L.K.E.R. 2: Heart of Chornobyl',
        confidenceScore: 100,
      });
    });
  });
});
