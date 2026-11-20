import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';

import type { CanonicalGame } from '../src/contracts/game';
import type { UserGameOverride } from '../src/contracts/override';
import type { ResolvedGameTag, TagFacetCount, UserTagOverride } from '../src/contracts/tags';
import {
  STORAGE_KEY_USER_TAG_OVERRIDES,
  USER_TAG_OVERRIDES_UPDATED_EVENT,
  addUserTagForGame,
  extractGameTagPlatformAliases,
  getUserTagOverrideForGame,
  getUserTagOverridesRevision,
  hydrateUserTagOverridesFromVault,
  loadUserTagOverrides,
  removeUserTagForGame,
  resetUserTagsForGame,
  saveUserTagOverride,
} from '../src/services/storage/userTagStorage';
import {
  buildTagFacetCounts,
  collectBaseSyncedTags,
  resolveEffectiveGameTags,
} from '../src/services/tags/gameTagResolver';
import { getEffectiveTags } from '../src/services/steam/steamFeatureNormalizer';
import { matchesGameFilter } from '../src/services/filter/gameFilterService';
import { SteamHeroDetails } from '../src/components/SteamStoreDetail/SteamHeroDetails';
import { TagManagerPopover } from '../src/components/SteamStoreDetail/TagManagerPopover';
import { renderGameHoverPopout } from '../src/components/Library/Grid/GameHoverPopout';
import {
  createDomain12DeepRenderer,
  createMemoryStorage,
  findElements,
  getTextContent,
  makeCanonicalGameFixture,
  nodeRequire,
} from './helpers/xboxTestHarness';

const ROOT_DIR = path.resolve(__dirname, '..');
const offlineVaultIpcMod = nodeRequire('../../electron/ipc/offlineVaultIpcHandlers.cjs');

function findByTestId(
  tree: unknown,
  testId: string
): React.ReactElement<Record<string, unknown>> | undefined {
  return findElements(
    tree,
    (el) => el.props?.['data-testid'] === testId
  )[0] as React.ReactElement<Record<string, unknown>> | undefined;
}

describe('Wave 1: Decoupled User Tag Overrides, Authoritative Resolver & Anchored TagManagerPopover', () => {
  const globalRecord = globalThis as Record<string, unknown>;
  let prevWindow: unknown;
  let prevLocalStorage: unknown;
  let mockStorage: Storage;
  let windowListeners: Map<string, Set<(e: Event) => void>>;

  beforeEach(() => {
    prevWindow = globalRecord.window;
    prevLocalStorage = globalRecord.localStorage;
    mockStorage = createMemoryStorage();
    windowListeners = new Map();

    globalRecord.localStorage = mockStorage;
    globalRecord.window = {
      localStorage: mockStorage,
      addEventListener: (type: string, fn: (e: Event) => void) => {
        let set = windowListeners.get(type);
        if (!set) {
          set = new Set();
          windowListeners.set(type, set);
        }
        set.add(fn);
      },
      removeEventListener: (type: string, fn: (e: Event) => void) => {
        windowListeners.get(type)?.delete(fn);
      },
      dispatchEvent: vi.fn((event: Event) => {
        const set = windowListeners.get(event.type);
        if (set) {
          for (const fn of Array.from(set)) {
            fn(event);
          }
        }
        return true;
      }),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (prevWindow === undefined) {
      delete globalRecord.window;
    } else {
      globalRecord.window = prevWindow;
    }
    if (prevLocalStorage === undefined) {
      delete globalRecord.localStorage;
    } else {
      globalRecord.localStorage = prevLocalStorage;
    }
  });

  // ---------------------------------------------------------------------------
  // 1. Decoupled Delta Tag Store (`userTagStorage.ts`) & Split-Game Safety (C10)
  // ---------------------------------------------------------------------------
  describe('1. Decoupled Delta Tag Store, __v: 2 Persistence & C10 Split-Game Isolation', () => {
    it('persists __v: 2 deduplicated envelope, bumps revision, dispatches event, and auto-prunes empty deltas', () => {
      const game = makeCanonicalGameFixture({
        id: 'steam-1086940',
        title: "Baldur's Gate 3",
        steamAppId: 1086940,
        platforms: [{ platformId: 'steam', platformGameId: '1086940', installed: true }],
        tags: ['Single-player', 'Co-op', 'RPG'],
      });

      const receivedEvents: Array<{ gameId?: string }> = [];
      (globalRecord.window as Window).addEventListener(USER_TAG_OVERRIDES_UPDATED_EVENT, (ev) => {
        receivedEvents.push((ev as CustomEvent<{ gameId?: string }>).detail);
      });

      const rev0 = getUserTagOverridesRevision();
      const saved = addUserTagForGame(game, '  Cozy   Night  ', game.tags);
      expect(saved).not.toBeNull();
      expect(saved?.addedTags).toEqual(['Cozy Night']);
      expect(saved?.removedTags).toEqual([]);
      expect(saved?.platformAliases).toEqual(['steam:1086940']);
      expect(getUserTagOverridesRevision()).toBeGreaterThan(rev0);
      expect(receivedEvents.at(-1)?.gameId).toBe('steam-1086940');

      // Verify deduplicated __v: 2 envelope and zero pollution of `universal_game_library_user_overrides`
      const rawEnvelope = JSON.parse(mockStorage.getItem(STORAGE_KEY_USER_TAG_OVERRIDES) || '{}');
      expect(rawEnvelope.__v).toBe(2);
      expect(rawEnvelope.records['steam-1086940'].addedTags).toEqual(['Cozy Night']);
      expect(rawEnvelope.aliases['steam:1086940']).toBe('steam-1086940');
      expect(mockStorage.getItem('universal_game_library_user_overrides')).toBeNull();

      // Removing the custom tag auto-prunes the empty record cleanly
      const afterRemoveCustom = removeUserTagForGame(game, 'Cozy Night', game.tags);
      expect(afterRemoveCustom).toBeNull();
      expect(getUserTagOverrideForGame(game)).toBeUndefined();

      // Removing a synced tag persists in removedTags; re-adding exact casing restores & auto-prunes
      const afterRemoveSynced = removeUserTagForGame(game, 'Co-op', game.tags);
      expect(afterRemoveSynced?.removedTags).toEqual(['Co-op']);
      const afterRestoreSynced = addUserTagForGame(game, 'Co-op', game.tags);
      expect(afterRestoreSynced).toBeNull();
      expect(getUserTagOverrideForGame(game)).toBeUndefined();
    });

    it('preserves tag edits across multi-store merges via platformAliases while isolating split games (C10)', () => {
      // Case A: GOG-only game edited before later merging with Steam
      const gogBeforeMerge = makeCanonicalGameFixture({
        id: 'gog-1423049311',
        title: 'Witcher 3',
        platforms: [{ platformId: 'gog', platformGameId: '1423049311', installed: false }],
        tags: ['GOG', 'DRM-Free'],
      });
      addUserTagForGame(gogBeforeMerge, 'Story Rich', ['DRM-Free']);

      const mergedSteamAndGog = makeCanonicalGameFixture({
        id: 'steam-292030',
        title: 'Witcher 3',
        steamAppId: 292030,
        platforms: [
          { platformId: 'steam', platformGameId: '292030', installed: true },
          { platformId: 'gog', platformGameId: '1423049311', installed: false },
        ],
        tags: ['Single-player', 'DRM-Free'],
      });
      const resolvedAfterMerge = resolveEffectiveGameTags(mergedSteamAndGog);
      expect(resolvedAfterMerge.userAddedTags).toEqual(['Story Rich']);
      expect(resolvedAfterMerge.tags[0]).toBe('Story Rich');

      // Case B: Split game isolation (C10)
      mockStorage.clear();
      const mergedInitial = makeCanonicalGameFixture({
        id: 'steam-123',
        title: 'Shared Title',
        steamAppId: 123,
        platforms: [
          { platformId: 'steam', platformGameId: '123', installed: true },
          { platformId: 'gog', platformGameId: '456', installed: false },
        ],
      });
      addUserTagForGame(mergedInitial, 'Shared Tag', []);

      const splitSteamCopy = makeCanonicalGameFixture({
        id: 'steam-123',
        title: 'Shared Title (Steam)',
        steamAppId: 123,
        platforms: [{ platformId: 'steam', platformGameId: '123', installed: true }],
      });
      const splitGogCopy = makeCanonicalGameFixture({
        id: 'gog-456',
        title: 'Shared Title (GOG)',
        platforms: [{ platformId: 'gog', platformGameId: '456', installed: false }],
      });

      // Editing split GOG copy writes strictly under `gog-456` with ONLY `['gog:456']` aliases
      const gogSaved = addUserTagForGame(splitGogCopy, 'GOG Exclusive', []);
      expect(gogSaved?.gameId).toBe('gog-456');
      expect(gogSaved?.platformAliases).toEqual(['gog:456']);
      expect(extractGameTagPlatformAliases(splitGogCopy)).toEqual(['gog:456']);

      // Exact game.id lookup beats alias fallback: Steam copy is completely unmutated!
      expect(resolveEffectiveGameTags(splitSteamCopy).userAddedTags).toEqual(['Shared Tag']);
      expect(resolveEffectiveGameTags(splitGogCopy).userAddedTags).toEqual([
        'Shared Tag',
        'GOG Exclusive',
      ]);

      // Resetting split GOG copy must NEVER delete sibling Steam copy's record AND must prune
      // `'gog:456'` from Steam's aliases so `gog-456` does not resurrect `'Shared Tag'` (`F7`)
      resetUserTagsForGame(splitGogCopy);
      const loadedMap = loadUserTagOverrides();
      expect(loadedMap['steam-123']?.addedTags).toEqual(['Shared Tag']);
      expect(loadedMap['steam-123']?.platformAliases).toEqual(['steam:123']);
      expect(loadedMap['gog-456']).toBeUndefined();
      expect(getUserTagOverrideForGame(splitGogCopy)).toBeUndefined();
      expect(resolveEffectiveGameTags(splitGogCopy).userAddedTags).toEqual([]);

      // Direct Reset on a freshly split child (without editing it first) also prevents resurrection
      mockStorage.clear();
      addUserTagForGame(mergedInitial, 'Cozy', []);
      expect(resolveEffectiveGameTags(splitGogCopy).userAddedTags).toEqual(['Cozy']);
      resetUserTagsForGame(splitGogCopy);
      expect(getUserTagOverrideForGame(splitGogCopy)).toBeUndefined();
      expect(resolveEffectiveGameTags(splitGogCopy).userAddedTags).toEqual([]);
      expect(resolveEffectiveGameTags(splitSteamCopy).userAddedTags).toEqual(['Cozy']);
    });

    it('passes platformAliases: [] to saveUserTagOverride IPC when sibling-alias pruning empties a sibling record so disk aliases are cleared', async () => {
      const splitGogCopy = makeCanonicalGameFixture({
        id: 'gog-456',
        title: 'Shared Title (GOG)',
        platforms: [{ platformId: 'gog', platformGameId: '456', installed: false }],
      });

      const saveTagIpcCalls: Array<{ gameId: string; payload: UserTagOverride }> = [];
      const tmpDiskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-sibling-prune-'));
      const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
      const ipcReg = offlineVaultIpcMod.registerOfflineVaultIpcHandlers({
        ipcMain: {
          handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
            ipcHandlers.set(channel, fn);
          },
        },
        offlineVaultService: { userDataDir: tmpDiskDir },
        mediaHydrationEngine: null,
        userDataDir: tmpDiskDir,
      });

      try {
        const ipcSaveTag = ipcHandlers.get('offlineVault:save-user-tag-override')!;
        const ipcGetTags = ipcHandlers.get('offlineVault:get-user-tag-overrides')!;
        const pendingIpcWrites: Array<Promise<unknown>> = [];

        (globalRecord.window as unknown as { electronAPI: unknown }).electronAPI = {
          isElectron: true,
          platform: 'darwin',
          offlineVault: {
            saveUserTagOverride: vi.fn((gameId: string, payload: UserTagOverride) => {
              saveTagIpcCalls.push({ gameId, payload });
              const p = ipcSaveTag({}, gameId, payload);
              pendingIpcWrites.push(p);
              return p;
            }),
            removeUserTagOverride: vi.fn((arg: unknown) => {
              const p = ipcHandlers.get('offlineVault:remove-user-tag-override')!({}, arg);
              pendingIpcWrites.push(p);
              return p;
            }),
          },
        };

        // Seed sibling record whose ONLY platformAlias is `'gog:456'`
        saveUserTagOverride({
          gameId: 'steam-999',
          platformAliases: ['gog:456'],
          addedTags: ['Steam Only Tag'],
          removedTags: [],
          updatedAt: '2026-06-01T00:00:00.000Z',
        });

        // Now claiming `'gog:456'` on `splitGogCopy` prunes `'gog:456'` from `steam-999` -> length 0!
        addUserTagForGame(splitGogCopy, 'GOG Exclusive', []);
        await Promise.all(pendingIpcWrites);

        const siblingSyncCall = saveTagIpcCalls.filter((c) => c.gameId === 'steam-999').at(-1);
        expect(siblingSyncCall).toBeDefined();
        expect(siblingSyncCall?.payload.platformAliases).toEqual([]);

        const diskAfterPrune = (await ipcGetTags({})) as Record<string, UserTagOverride>;
        expect(diskAfterPrune['steam-999']?.addedTags).toEqual(['Steam Only Tag']);
        expect(diskAfterPrune['steam-999']?.platformAliases).toBeUndefined();
      } finally {
        ipcReg.dispose();
        try {
          fs.rmSync(tmpDiskDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('reconciles localStorage and Electron vault via hydrateUserTagOverridesFromVault (newest updatedAt wins) and responds to StorageEvent', async () => {
      const olderLocal: UserTagOverride = {
        gameId: 'steam-10',
        platformAliases: ['steam:10'],
        addedTags: ['Old Local'],
        removedTags: [],
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      const newerLocal: UserTagOverride = {
        gameId: 'steam-20',
        platformAliases: ['steam:20'],
        addedTags: ['Fresh Local'],
        removedTags: [],
        updatedAt: '2026-05-01T00:00:00.000Z',
      };
      saveUserTagOverride(olderLocal, { silentEvent: true });
      saveUserTagOverride(newerLocal, { silentEvent: true });

      const vaultRecords: Record<string, UserTagOverride> = {
        'steam-10': {
          gameId: 'steam-10',
          platformAliases: ['steam:10'],
          addedTags: ['Newer Vault'],
          removedTags: ['Co-op'],
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
        'steam-20': {
          gameId: 'steam-20',
          platformAliases: ['steam:20'],
          addedTags: ['Stale Vault'],
          removedTags: [],
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
        'gog-30': {
          gameId: 'gog-30',
          platformAliases: ['gog:30'],
          addedTags: ['Vault Only'],
          removedTags: [],
          updatedAt: '2026-04-01T00:00:00.000Z',
        },
      };

      const saveUserTagOverrideMock = vi.fn().mockResolvedValue({ success: true });
      (globalRecord.window as unknown as { electronAPI: unknown }).electronAPI = {
        isElectron: true,
        platform: 'darwin',
        offlineVault: {
          getUserTagOverrides: vi.fn().mockResolvedValue(vaultRecords),
          saveUserTagOverride: saveUserTagOverrideMock,
          removeUserTagOverride: vi.fn().mockResolvedValue({ success: true }),
        },
      };

      const changed = await hydrateUserTagOverridesFromVault();
      expect(changed).toBe(true);

      const merged = loadUserTagOverrides();
      expect(merged['steam-10']?.addedTags).toEqual(['Newer Vault']);
      expect(merged['steam-10']?.removedTags).toEqual(['Co-op']);
      expect(merged['steam-20']?.addedTags).toEqual(['Fresh Local']);
      expect(merged['gog-30']?.addedTags).toEqual(['Vault Only']);

      expect(saveUserTagOverrideMock).toHaveBeenCalledWith({
        batchOverrides: {
          'steam-20': expect.objectContaining({ gameId: 'steam-20', addedTags: ['Fresh Local'] }),
        },
      });

      // StorageEvent invalidates cache & increments revision
      const revBeforeStorage = getUserTagOverridesRevision();
      const storageListeners = windowListeners.get('storage');
      expect(storageListeners?.size).toBeGreaterThan(0);
      for (const fn of Array.from(storageListeners || [])) {
        fn({ type: 'storage', key: STORAGE_KEY_USER_TAG_OVERRIDES } as unknown as Event);
      }
      expect(getUserTagOverridesRevision()).toBeGreaterThan(revBeforeStorage);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Electron IPC Hardening (`offlineVaultIpcHandlers.cjs`)
  // ---------------------------------------------------------------------------
  describe('2. Electron IPC Hardening (`user_tag_overrides.json`, zero media-blob reset, strict limits)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-user-tags-ipc-'));
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    });

    it('stores tag overrides in dedicated user_tag_overrides.json without touching offlineVaultService.saveUserOverride, enforces sanitization/caps & 2 MB limit', async () => {
      const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
      const mockIpcMain = {
        handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
          handlers.set(channel, fn);
        },
      };
      const saveUserOverrideSpy = vi.fn();
      const removeUserOverrideSpy = vi.fn();
      const mockOfflineVaultService = {
        userDataDir: tmpDir,
        saveUserOverride: saveUserOverrideSpy,
        removeUserOverride: removeUserOverrideSpy,
      };

      const reg = offlineVaultIpcMod.registerOfflineVaultIpcHandlers({
        ipcMain: mockIpcMain,
        offlineVaultService: mockOfflineVaultService,
        mediaHydrationEngine: null,
        userDataDir: tmpDir,
      });

      try {
        const getTags = handlers.get('offlineVault:get-user-tag-overrides')!;
        const saveTag = handlers.get('offlineVault:save-user-tag-override')!;
        const removeTag = handlers.get('offlineVault:remove-user-tag-override')!;

        expect(getTags).toBeTypeOf('function');
        expect(saveTag).toBeTypeOf('function');
        expect(removeTag).toBeTypeOf('function');

        // Reject prototype-pollution / control-char / overlong gameIds
        expect(await saveTag({}, '__proto__', { addedTags: ['Bad'] })).toEqual(
          expect.objectContaining({ success: false })
        );
        expect(await saveTag({}, 'constructor', { addedTags: ['Bad'] })).toEqual(
          expect.objectContaining({ success: false })
        );
        expect(await saveTag({}, 'game\0id', { addedTags: ['Bad'] })).toEqual(
          expect.objectContaining({ success: false })
        );
        expect(await saveTag({}, 'x'.repeat(257), { addedTags: ['Bad'] })).toEqual(
          expect.objectContaining({ success: false })
        );

        // Sanitize control chars, collapse spaces, clamp <=64 chars, cap <=100 tags & <=50 aliases
        const overlongTag = 'A'.repeat(90);
        const manyTags = Array.from({ length: 130 }, (_, i) => `Tag-${i}`);
        const manyAliases = Array.from({ length: 70 }, (_, i) => `steam:${1000 + i}`);

        const saveRes = (await saveTag({}, 'steam-1086940', {
          addedTags: ['\x00Cozy\x1f  \t  RPG\x7f', overlongTag, ...manyTags],
          removedTags: ['Family\nSharing', 'Cozy RPG'], // duplicate of addedTag stripped from removedTags
          platformAliases: ['__proto__', ...manyAliases],
          updatedAt: '2026-07-01T12:00:00.000Z',
        })) as { success: boolean; override?: UserTagOverride };

        expect(saveRes.success).toBe(true);
        expect(saveRes.override?.addedTags[0]).toBe('Cozy RPG');
        expect(saveRes.override?.addedTags[1]).toBe('A'.repeat(64));
        expect(saveRes.override?.addedTags.length).toBe(100);
        expect(saveRes.override?.removedTags).toEqual(['FamilySharing']);
        expect(saveRes.override?.platformAliases?.length).toBe(50);
        expect(saveRes.override?.platformAliases).not.toContain('__proto__');

        // Verify ZERO media-blob invalidation calls on `offlineVaultService`!
        expect(saveUserOverrideSpy).not.toHaveBeenCalled();
        expect(removeUserOverrideSpy).not.toHaveBeenCalled();

        // Dedicated file written separately from user_overrides.json
        expect(fs.existsSync(path.join(tmpDir, 'user_tag_overrides.json'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'user_overrides.json'))).toBe(false);

        // Concurrent saves serialize cleanly without clobbering sibling games
        await Promise.all([
          saveTag({}, 'gog-101', { addedTags: ['DRM-Free Fav'], removedTags: [] }),
          saveTag({}, 'epic-202', { addedTags: ['Indie Gem'], removedTags: [] }),
        ]);
        const allOnDisk = (await getTags({})) as Record<string, UserTagOverride>;
        expect(Object.keys(allOnDisk).sort()).toEqual(['epic-202', 'gog-101', 'steam-1086940']);

        // Remove works without affecting sibling games or calling offlineVaultService.removeUserOverride
        await removeTag({}, 'gog-101');
        const afterRemove = (await getTags({})) as Record<string, UserTagOverride>;
        expect(afterRemove['gog-101']).toBeUndefined();
        expect(afterRemove['steam-1086940']).toBeDefined();
        expect(removeUserOverrideSpy).not.toHaveBeenCalled();

        // Enforce 2 MB serialized payload cap
        const hugeBatch: Record<string, UserTagOverride> = {};
        const bigTags = Array.from({ length: 100 }, (_, i) => `T${i}_${'x'.repeat(58)}`);
        for (let g = 0; g < 360; g += 1) {
          hugeBatch[`game-bulk-${g}`] = {
            gameId: `game-bulk-${g}`,
            addedTags: bigTags,
            removedTags: [],
            updatedAt: '2026-08-01T00:00:00.000Z',
          };
        }
        const oversizedRes = (await saveTag({}, { batchOverrides: hugeBatch })) as {
          success: boolean;
          error?: string;
        };
        expect(oversizedRes.success).toBe(false);
        expect(oversizedRes.error).toMatch(/2 MB/i);

        // Existing valid data remains intact after rejected oversized write
        const afterOversized = (await getTags({})) as Record<string, UserTagOverride>;
        expect(afterOversized['steam-1086940']).toBeDefined();
      } finally {
        reg.dispose();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Authoritative Tag Resolver, Normalizer, Filter Service & Hover Popout
  // ---------------------------------------------------------------------------
  describe('3. Authoritative Tag Resolver, Valve Tokens, FixMatch Precedence & Consumers', () => {
    it('deduplicates DualShock/DualSense tags on Steam-owned games and maps/strips #category_* Valve tokens', () => {
      const rawSteamTags = [
        '  Single-player  ',
        'DualShock Controller Support',
        'dualshock controller support',
        'DualSense Controller Support',
        'DualSense Controller Support',
        '#category_playable_at_your_own_pace',
        '#category_contrast_controls',
        '#category_unlocalized_future_token_999',
      ];
      expect(getEffectiveTags(rawSteamTags, true)).toEqual([
        'Single-player',
        'DualShock Controller Support',
        'DualSense Controller Support',
        'Playable at Your Own Pace',
        'Contrast Controls',
      ]);
    });

    it('honors !isDynamicRouted Fix Match precedence (C10), merges dynamic storefront tags, and suppresses bare stubs when richer tags exist', () => {
      const gogHybrid = makeCanonicalGameFixture({
        id: 'gog-1207666073',
        title: 'Akalabeth',
        platforms: [{ platformId: 'gog', platformGameId: '1207666073', installed: false }],
        tags: ['GOG', 'DRM-Free'],
        enrichedMetadata: {
          tags: ['Role-playing', 'Adventure', 'Fantasy', 'Steam Achievements'],
        } as CanonicalGame['enrichedMetadata'],
      });
      // Non-Steam rebrands Steam Achievements -> Achievements, merges DRM-Free, suppresses bare "GOG"
      expect(collectBaseSyncedTags(gogHybrid)).toEqual([
        'Role-playing',
        'Adventure',
        'Fantasy',
        'Achievements',
        'DRM-Free',
      ]);

      // Bare storefront stub preserved when it is the ONLY tag
      const bareEpic = makeCanonicalGameFixture({
        id: 'epic-stub',
        title: 'Unenriched Epic Game',
        platforms: [{ platformId: 'epic', platformGameId: 'stub', installed: false }],
        tags: ['Epic Games Store'],
      });
      expect(collectBaseSyncedTags(bareEpic)).toEqual(['Epic Games Store']);

      // Custom (!isDynamicRouted) Fix Match override tags beat stale enrichedMetadata.tags (C10)
      const customFixMatchOverride: UserGameOverride = {
        gameId: 'gog-1207666073',
        matchedStore: 'custom',
        tags: ['Classic CRPG', 'Turn-Based'],
        metadataRoute: { mode: 'custom', source: 'custom' },
        updatedAt: '2026-07-01T00:00:00.000Z',
      };
      expect(
        collectBaseSyncedTags(gogHybrid, {
          fixMatchOverride: customFixMatchOverride,
          isDynamicRouted: false,
        })
      ).toEqual(['Classic CRPG', 'Turn-Based', 'DRM-Free']);

      // Dynamic routed Fix Match lets live/enriched metadata win over stale override snapshot
      expect(
        collectBaseSyncedTags(gogHybrid, {
          liveMetadata: { tags: ['Live Tag', 'RPG'] },
          fixMatchOverride: {
            ...customFixMatchOverride,
            matchedStore: 'steam',
            metadataRoute: { mode: 'routed', source: 'steam' },
          },
          isDynamicRouted: true,
        })
      ).toEqual(['Live Tag', 'RPG', 'DRM-Free']);
    });

    it('emits user addedTags first without stripping via getEffectiveTags, hides removedTags across syncs, and supports preloaded overridesMap + gameFilterService + GameHoverPopout', () => {
      const gogGame = makeCanonicalGameFixture({
        id: 'gog-777',
        title: 'Synthetic Adventure',
        platforms: [{ platformId: 'gog', platformGameId: '777', installed: true }],
        genres: ['Adventure', 'Horror'],
        tags: ['GOG', 'DRM-Free', 'Horror', 'Single-player', 'Leaving Soon'],
      });

      // User adds "RPG" (custom casing) and even a Steam-branded tag (never stripped by getEffectiveTags!), and removes "Horror"
      addUserTagForGame(gogGame, 'RPG', ['DRM-Free', 'Horror', 'Single-player', 'Leaving Soon']);
      addUserTagForGame(gogGame, 'Steam Workshop', [
        'DRM-Free',
        'Horror',
        'Single-player',
        'Leaving Soon',
      ]);
      removeUserTagForGame(gogGame, 'Horror', [
        'DRM-Free',
        'Horror',
        'Single-player',
        'Leaving Soon',
      ]);

      // Simulate future upstream sync: "Leaving Soon" disappears, "HDR available" arrives, "Horror" still present upstream
      const resyncedGogGame: CanonicalGame = {
        ...gogGame,
        tags: ['GOG', 'DRM-Free', 'Horror', 'Single-player', 'HDR available', 'rpg'],
      };

      const snapshot = loadUserTagOverrides();
      const resolved = resolveEffectiveGameTags(resyncedGogGame, { overridesMap: snapshot });

      expect(resolved.hasUserEdits).toBe(true);
      expect(resolved.userAddedTags).toEqual(['RPG', 'Steam Workshop']);
      // User tags FIRST (exact casing 'RPG' supersedes synced 'rpg'; 'Steam Workshop' preserved on GOG!);
      // 'Horror' stays suppressed; 'Leaving Soon' vanished; 'HDR available' flowed in automatically!
      expect(resolved.tags).toEqual([
        'RPG',
        'Steam Workshop',
        'DRM-Free',
        'Single-player',
        'HDR available',
      ]);

      // `matchesGameFilter` honors user-added and user-removed tags (even when removed tag exists in `genres`!)
      expect(
        matchesGameFilter(resyncedGogGame, { type: 'tag', label: 'Tag', value: 'Steam Workshop' })
      ).toBe(true);
      expect(matchesGameFilter(resyncedGogGame, { type: 'tag', label: 'Tag', value: 'RPG' })).toBe(
        true
      );
      expect(
        matchesGameFilter(resyncedGogGame, { type: 'tag', label: 'Tag', value: 'Horror' })
      ).toBe(false);

      // `buildTagFacetCounts` aggregates counts cleanly using preloaded snapshot
      const facets = buildTagFacetCounts([resyncedGogGame], snapshot);
      expect(facets.find((f) => f.key === 'rpg')).toEqual({ key: 'rpg', label: 'RPG', count: 1 });
      expect(facets.find((f) => f.key === 'horror')).toBeUndefined();

      // `GameHoverPopout` reflects resolved user tags (user-added tags first, removed tag absent)
      const hoverHtml = renderToString(
        renderGameHoverPopout({
          hoveredGame: resyncedGogGame,
          previewPos: { x: 100, y: 100, align: 'right' },
          popoutRef: { current: null },
          userOverridesMap: {},
          connectedSet: new Set(['gog']),
          dynamicBlurb: null,
          hoverHeaderFailed: false,
          onSetHoverHeaderFailed: () => {},
          onPopoutMouseEnter: () => {},
          onPopoutMouseLeave: () => {},
          onSelectGame: () => {},
          onContextMenu: () => {},
        })
      );
      expect(hoverHtml).toContain('Steam Workshop');
      expect(hoverHtml).not.toContain('>Horror<');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Anchored `+` Tag Manager Popover, SteamHeroDetails & CSS Standards (C5 & C12)
  // ---------------------------------------------------------------------------
  describe('4. TagManagerPopover & SteamHeroDetails (`modern-web-guidance`, C5 & C12)', () => {
    it('always renders + button on tagless games, renders all user-added tags ahead of synced slice, and emits valid CSS --<dashed-ident> anchor tokens without aria-haspopup/role="menu"', () => {
      // Tagless game still shows + button
      const emptyHeroHtml = renderToString(
        <SteamHeroDetails title="Tagless Game" tags={[]} />
      );
      expect(emptyHeroHtml).toContain('aria-label="Manage tags"');
      expect(emptyHeroHtml).toContain('No tags yet');
      expect(emptyHeroHtml).not.toContain('aria-haspopup');
      expect(emptyHeroHtml).not.toContain('role="menu"');

      // 5 user-added tags + 6 synced tags -> ALL 5 user-added tags rendered first + 3 synced tags
      const entries: ResolvedGameTag[] = [
        { key: 'u1', label: 'UserOne', source: 'user' },
        { key: 'u2', label: 'UserTwo', source: 'user' },
        { key: 'u3', label: 'UserThree', source: 'user' },
        { key: 'u4', label: 'UserFour', source: 'user' },
        { key: 'u5', label: 'UserFive', source: 'user' },
        { key: 's1', label: 'Synced1', source: 'synced' },
        { key: 's2', label: 'Synced2', source: 'synced' },
        { key: 's3', label: 'Synced3', source: 'synced' },
        { key: 's4', label: 'Synced4', source: 'synced' },
        { key: 's5', label: 'Synced5', source: 'synced' },
      ];

      const renderer = createDomain12DeepRenderer(SteamHeroDetails, {
        title: 'Heavy Tagged Game',
        tagEntries: entries,
        hasUserTagEdits: true,
        onAddTag: vi.fn(),
        onRemoveTag: vi.fn(),
        onResetTags: vi.fn(),
      });

      try {
        const tree = renderer.render();
        const tagButtons = findElements(
          tree,
          (el) =>
            el.type === 'button' &&
            (el.props?.['data-tag-source'] === 'user' || el.props?.['data-tag-source'] === 'synced')
        );
        const labels = tagButtons.map((b) => getTextContent(b));
        expect(labels).toEqual([
          'UserOne',
          'UserTwo',
          'UserThree',
          'UserFour',
          'UserFive',
          'Synced1',
          'Synced2',
          'Synced3',
        ]);

        // Verify C5 valid CSS `<dashed-ident>` anchorName & positionAnchor match strictly
        const triggerBtn = findByTestId(tree, 'hero-tag-manager-trigger')!;
        const popoverDialog = findByTestId(tree, 'tag-manager-popover')!;
        expect(triggerBtn).toBeDefined();
        expect(popoverDialog).toBeDefined();
        expect(triggerBtn.props.type).toBe('button');
        expect(triggerBtn.props['aria-label']).toBe('Manage tags');
        expect(triggerBtn.props['aria-haspopup']).toBeUndefined();
        expect(triggerBtn.props.role).toBeUndefined();
        expect(triggerBtn.props['aria-controls']).toBe(popoverDialog.props.id);

        const triggerStyle = triggerBtn.props.style as React.CSSProperties;
        const dialogStyle = popoverDialog.props.style as React.CSSProperties;
        expect(triggerStyle.anchorName).toMatch(/^--[a-zA-Z0-9_-]+$/);
        expect(dialogStyle.positionAnchor).toBe(triggerStyle.anchorName);
        expect(popoverDialog.type).toBe('dialog');
        expect(popoverDialog.props.popover).toBe('auto');
      } finally {
        renderer.unmount();
      }
    });

    it('supports frequency-sorted search filtering, 1-click toggle, IME-safe Enter (C12), CSP-safe form submit, nested Escape focus return, Reset, and debounced aria-live status', () => {
      vi.useFakeTimers();
      const onAddTag = vi.fn();
      const onRemoveTag = vi.fn();
      const onResetTags = vi.fn();

      const libraryTags: TagFacetCount[] = [
        { key: 'single-player', label: 'Single-player', count: 420 },
        { key: 'co-op', label: 'Co-op', count: 185 },
        { key: 'cozy', label: 'Cozy', count: 42 },
        { key: 'story rich', label: 'Story Rich', count: 310 },
        { key: 'local co-op', label: 'Local Co-op', count: 95 },
      ];

      const entries: ResolvedGameTag[] = [
        { key: 'cozy', label: 'Cozy', source: 'user' },
        { key: 'single-player', label: 'Single-player', source: 'synced' },
      ];

      const renderer = createDomain12DeepRenderer(TagManagerPopover, {
        gameTitle: 'Synthetic Game',
        entries,
        availableLibraryTags: libraryTags,
        hasUserEdits: true,
        onAddTag,
        onRemoveTag,
        onResetTags,
      });

      try {
        let tree = renderer.render();
        const triggerBtn = findByTestId(tree, 'hero-tag-manager-trigger')!;
        expect(triggerBtn.props['aria-expanded']).toBe(false);

        // Open popover via trigger button (JSDOM fallback mode)
        (triggerBtn.props.onClick as () => void)();
        tree = renderer.render();
        expect(findByTestId(tree, 'hero-tag-manager-trigger')!.props['aria-expanded']).toBe(true);
        expect(findByTestId(tree, 'tag-manager-popover')!.props['data-fallback-open']).toBe('true');

        // Default list sorted strictly by frequency descending
        const initialOptions = findElements(
          tree,
          (el) =>
            el.type === 'button' &&
            typeof el.props?.['data-testid'] === 'string' &&
            String(el.props['data-testid']).startsWith('tag-manager-option-')
        );
        expect(initialOptions.map((o) => o.props['data-testid'])).toEqual([
          'tag-manager-option-single-player',
          'tag-manager-option-story rich',
          'tag-manager-option-co-op',
          'tag-manager-option-local co-op',
          'tag-manager-option-cozy',
        ]);

        // 1-click toggle: applied tag has aria-pressed=true -> calls onRemoveTag; unapplied -> calls onAddTag
        const appliedOption = findByTestId(tree, 'tag-manager-option-cozy')!;
        const unappliedOption = findByTestId(tree, 'tag-manager-option-co-op')!;
        expect(appliedOption.props['aria-pressed']).toBe(true);
        expect(unappliedOption.props['aria-pressed']).toBe(false);

        (appliedOption.props.onClick as () => void)();
        expect(onRemoveTag).toHaveBeenCalledWith('Cozy');
        (unappliedOption.props.onClick as () => void)();
        expect(onAddTag).toHaveBeenCalledWith('Co-op');

        // Type into search input -> filters dynamically (prefix before substring!)
        const input = findByTestId(tree, 'tag-manager-search-input')!;
        expect(input.props.autoCorrect).toBe('off');
        expect(input.props.autoCapitalize).toBe('none');
        expect(input.props.spellCheck).toBe(false);

        (input.props.onChange as (e: { target: { value: string } }) => void)({
          target: { value: 'co' },
        });
        tree = renderer.render();
        const filteredOptions = findElements(
          tree,
          (el) =>
            el.type === 'button' &&
            typeof el.props?.['data-testid'] === 'string' &&
            String(el.props['data-testid']).startsWith('tag-manager-option-')
        );
        // Prefix matches ('Co-op' count 185, 'Cozy' count 42) come before substring match ('Local Co-op' count 95)
        expect(filteredOptions.map((o) => o.props['data-testid'])).toEqual([
          'tag-manager-option-co-op',
          'tag-manager-option-cozy',
          'tag-manager-option-local co-op',
        ]);

        // Debounced live status announces after 200ms
        vi.advanceTimersByTime(220);
        tree = renderer.render();
        const liveStatus = findByTestId(tree, 'tag-manager-live-status')!;
        expect(liveStatus.props.role).toBe('status');
        expect(liveStatus.props['aria-live']).toBe('polite');
        expect(getTextContent(liveStatus)).toContain('3 matching tags');

        // Type brand-new tag "Deck Verified"
        (findByTestId(tree, 'tag-manager-search-input')!.props.onChange as (e: {
          target: { value: string };
        }) => void)({ target: { value: 'Deck Verified' } });
        tree = renderer.render();

        // IME-composing Enter (`isComposing: true` AND WebKit `keyCode: 229`) MUST NOT submit (C12)
        const onKeyDown = findByTestId(tree, 'tag-manager-search-input')!.props.onKeyDown as (
          e: Record<string, unknown>
        ) => void;
        onAddTag.mockClear();

        const imePrevent1 = vi.fn();
        onKeyDown({ key: 'Enter', isComposing: true, preventDefault: imePrevent1 });
        expect(onAddTag).not.toHaveBeenCalled();
        expect(imePrevent1).toHaveBeenCalledTimes(1);

        const imePrevent2 = vi.fn();
        onKeyDown({ key: 'Enter', keyCode: 229, preventDefault: imePrevent2 });
        expect(onAddTag).not.toHaveBeenCalled();
        expect(imePrevent2).toHaveBeenCalledTimes(1);

        // Explicit <form onSubmit> calls e.preventDefault() unconditionally (CSP form-action 'none')
        const formEl = findElements(tree, (el) => el.type === 'form')[0];
        const submitBtn = findByTestId(tree, 'tag-manager-submit-btn')!;
        expect(submitBtn.props.type).toBe('submit');
        expect(getTextContent(submitBtn)).toContain('Deck Verified');

        const formPrevent = vi.fn();
        (formEl.props.onSubmit as (e: { preventDefault: () => void }) => void)({
          preventDefault: formPrevent,
        });
        expect(formPrevent).toHaveBeenCalledTimes(1);
        expect(onAddTag).toHaveBeenCalledWith('Deck Verified');

        // Nested Escape: first clears query WITHOUT closing popover, second closes popover & returns focus to +
        tree = renderer.render();
        (findByTestId(tree, 'tag-manager-search-input')!.props.onChange as (e: {
          target: { value: string };
        }) => void)({ target: { value: 'temp query' } });
        tree = renderer.render();

        const triggerHost = renderer.getHostElementByTestId('hero-tag-manager-trigger');
        const focusSpy = vi.fn();
        if (triggerHost) {
          (triggerHost as unknown as { focus: () => void }).focus = focusSpy;
        }

        const esc1Prevent = vi.fn();
        const esc1Stop = vi.fn();
        (findByTestId(tree, 'tag-manager-search-input')!.props.onKeyDown as (
          e: Record<string, unknown>
        ) => void)({ key: 'Escape', preventDefault: esc1Prevent, stopPropagation: esc1Stop });
        tree = renderer.render();
        expect(esc1Prevent).toHaveBeenCalledTimes(1);
        expect(esc1Stop).toHaveBeenCalledTimes(1);
        expect(findByTestId(tree, 'tag-manager-search-input')!.props.value).toBe('');
        expect(findByTestId(tree, 'hero-tag-manager-trigger')!.props['aria-expanded']).toBe(true);

        // Second Escape on empty query closes popover and returns focus to trigger
        const esc2Prevent = vi.fn();
        const esc2Stop = vi.fn();
        (findByTestId(tree, 'tag-manager-search-input')!.props.onKeyDown as (
          e: Record<string, unknown>
        ) => void)({ key: 'Escape', preventDefault: esc2Prevent, stopPropagation: esc2Stop });
        tree = renderer.render();
        expect(findByTestId(tree, 'hero-tag-manager-trigger')!.props['aria-expanded']).toBe(false);
        expect(focusSpy).toHaveBeenCalledTimes(1);

        // Reset button invokes onResetTags when hasUserEdits === true, hidden when false
        const resetBtn = findByTestId(tree, 'tag-manager-reset-btn')!;
        expect(resetBtn).toBeDefined();
        (resetBtn.props.onClick as () => void)();
        expect(onResetTags).toHaveBeenCalledTimes(1);

        tree = renderer.render({ hasUserEdits: false });
        expect(findByTestId(tree, 'tag-manager-reset-btn')).toBeUndefined();
      } finally {
        renderer.unmount();
      }
    });

    it('prevents native popover="auto" light-dismiss from immediately re-opening on trigger click (F6)', () => {
      const renderer = createDomain12DeepRenderer(TagManagerPopover, {
        gameTitle: 'Popover Race Game',
        entries: [],
        availableLibraryTags: [{ key: 'rpg', label: 'RPG', count: 5 }],
        hasUserEdits: false,
        onAddTag: vi.fn(),
        onRemoveTag: vi.fn(),
      });

      try {
        let tree = renderer.render();
        const dialogHost = renderer.getHostElementByTestId('tag-manager-popover') as unknown as {
          showPopover: () => void;
          hidePopover: () => void;
          matches: (sel: string) => boolean;
          addEventListener: (type: string, fn: (e: Event) => void) => void;
          removeEventListener: (type: string, fn: (e: Event) => void) => void;
        };
        const toggleListeners = new Set<(e: Event) => void>();
        let domPopoverOpen = false;
        const showPopoverSpy = vi.fn(() => {
          domPopoverOpen = true;
        });
        const hidePopoverSpy = vi.fn(() => {
          domPopoverOpen = false;
        });
        dialogHost.showPopover = showPopoverSpy;
        dialogHost.hidePopover = hidePopoverSpy;
        dialogHost.matches = (sel: string) => sel === ':popover-open' && domPopoverOpen;
        dialogHost.addEventListener = (type: string, fn: (e: Event) => void) => {
          if (type === 'toggle') toggleListeners.add(fn);
        };
        dialogHost.removeEventListener = (type: string, fn: (e: Event) => void) => {
          if (type === 'toggle') toggleListeners.delete(fn);
        };

        // Re-render so effect binds native `toggle` listener on our patched host
        tree = renderer.render({ gameTitle: 'Popover Race Game!' });
        const triggerOpen = findByTestId(tree, 'hero-tag-manager-trigger')!;
        (triggerOpen.props.onPointerDown as () => void)();
        (triggerOpen.props.onClick as () => void)();
        tree = renderer.render();
        expect(showPopoverSpy).toHaveBeenCalledTimes(1);
        expect(findByTestId(tree, 'hero-tag-manager-trigger')!.props['aria-expanded']).toBe(true);

        // Now simulate clicking `+` while open:
        // 1. pointerdown runs while popover is open
        const triggerClose = findByTestId(tree, 'hero-tag-manager-trigger')!;
        (triggerClose.props.onPointerDown as () => void)();
        // 2. Native popover="auto" light-dismiss fires `toggle` (newState: 'closed') on pointerup BEFORE click
        domPopoverOpen = false;
        for (const fn of toggleListeners) {
          fn({ type: 'toggle', newState: 'closed' } as unknown as Event);
        }
        tree = renderer.render();
        expect(findByTestId(tree, 'hero-tag-manager-trigger')!.props['aria-expanded']).toBe(false);
        // 3. click fires right after -> MUST NOT call showPopover() again!
        (findByTestId(tree, 'hero-tag-manager-trigger')!.props.onClick as () => void)();
        tree = renderer.render();
        expect(showPopoverSpy).toHaveBeenCalledTimes(1);
        expect(findByTestId(tree, 'hero-tag-manager-trigger')!.props['aria-expanded']).toBe(false);

        // Next click on `+` while closed opens normally
        (findByTestId(tree, 'hero-tag-manager-trigger')!.props.onPointerDown as () => void)();
        (findByTestId(tree, 'hero-tag-manager-trigger')!.props.onClick as () => void)();
        tree = renderer.render();
        expect(showPopoverSpy).toHaveBeenCalledTimes(2);
        expect(findByTestId(tree, 'hero-tag-manager-trigger')!.props['aria-expanded']).toBe(true);
      } finally {
        renderer.unmount();
      }
    });

    it('enforces @supports (position-area: block-end) gating, logical keywords, @starting-style, overlay & allow-discrete, and reduced-motion rules in src/index.css', () => {
      const css = fs.readFileSync(path.join(ROOT_DIR, 'src/index.css'), 'utf8');
      const popoverSectionIdx = css.indexOf('.ol-tag-popover');
      expect(popoverSectionIdx).toBeGreaterThan(-1);
      const popoverCss = css.slice(popoverSectionIdx);

      // Base `.ol-tag-popover` block must NOT unconditionally set `inset: auto` or `display: flex`
      const baseRuleMatch = popoverCss.match(/\.ol-tag-popover\s*\{([^}]*)\}/);
      expect(baseRuleMatch).not.toBeNull();
      const baseRuleBody = baseRuleMatch![1];
      expect(baseRuleBody).not.toMatch(/\binset\s*:/);
      expect(baseRuleBody).not.toMatch(/\bdisplay\s*:/);
      expect(baseRuleBody).toContain('overlay');
      expect(baseRuleBody).toContain('transition-behavior: allow-discrete');

      // Anchor positioning strictly inside `@supports (position-area: block-end)` with logical keywords only
      const supportsMatch = popoverCss.match(
        /@supports\s*\(position-area:\s*block-end\)\s*\{[\s\S]*?\n\}/
      );
      expect(supportsMatch).not.toBeNull();
      const supportsBlock = supportsMatch![0];
      expect(supportsBlock).toContain('inset: auto');
      expect(supportsBlock).toContain('margin: 0');
      expect(supportsBlock).toContain('position-area: block-end span-inline-start');
      expect(supportsBlock).toContain('position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline');
      // Never mix physical keywords into position-area
      expect(supportsBlock).not.toMatch(/position-area:[^;]*\b(top|bottom|left|right)\b/);

      // Entry transition + reduced motion rules
      expect(popoverCss).toContain('@starting-style');
      expect(popoverCss).toContain('@media (prefers-reduced-motion: no-preference)');
      expect(popoverCss).toContain('@media (prefers-reduced-motion: reduce)');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Zero TypeScript AnyKeyword AST Guard across all Wave 1 Tag Files
  // ---------------------------------------------------------------------------
  describe('5. Zero TypeScript AnyKeyword AST Guard across Wave 1 Tag Modules in src/**', () => {
    it('contains zero TypeScript AnyKeyword nodes across all new and modified src/** files', () => {
      const ownedSrcFiles = [
        'src/contracts/tags.ts',
        'src/types/electron.d.ts',
        'src/services/storage/userTagStorage.ts',
        'src/services/tags/gameTagResolver.ts',
        'src/services/steam/steamFeatureNormalizer.ts',
        'src/services/filter/gameFilterService.ts',
        'src/components/SteamStoreDetail/TagManagerPopover.tsx',
        'src/components/SteamStoreDetail/SteamHeroDetails.tsx',
        'src/components/Library/Grid/GameHoverPopout.tsx',
      ];

      const violations: string[] = [];
      for (const relPath of ownedSrcFiles) {
        const fullPath = path.join(ROOT_DIR, relPath);
        const content = fs.readFileSync(fullPath, 'utf8');
        const sf = ts.createSourceFile(
          fullPath,
          content,
          ts.ScriptTarget.Latest,
          true,
          fullPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );
        const visit = (node: ts.Node): void => {
          if (node.kind === ts.SyntaxKind.AnyKeyword) {
            const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            violations.push(`${relPath}:${pos.line + 1}`);
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }

      expect(violations).toEqual([]);
    });
  });
});
