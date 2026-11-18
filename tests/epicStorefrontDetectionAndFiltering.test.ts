import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { epicIntegration } from '../src/services/integrations/epicIntegration';

const nodeRequire = createRequire(import.meta.url);

const nonGameClassifier = nodeRequire('../electron/storefronts/nonGameClassifier.cjs');
const storeSync = nodeRequire('../electron/storeSync.cjs');

describe('Epic Storefront Detection & Non-Game Filtering Pipeline', () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix = 'epic-filter-test-'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    storeSync.trimStoreSyncMemory();
    for (const d of tempDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // Ignored
      }
    }
    tempDirs.length = 0;
  });

  // ============================================================================
  // 1. Unit Tests for classifyNonGameStorefrontItem
  // ============================================================================
  describe('classifyNonGameStorefrontItem: Semantic Disambiguation', () => {
    const { classifyNonGameStorefrontItem } = nonGameClassifier;

    it('admits Epic base games with itemType="APPLICATION" and game category segments', () => {
      // Standard Epic Library API payload representation for base games
      const result = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Control',
        platformId: 'epic',
        platformGameId: 'Calluna',
        catalogItemId: 'syn_control_base_001',
        itemType: 'APPLICATION',
        categories: [{ path: 'games' }, { path: 'applications' }],
      });
      expect(result).toBeNull();

      const celesteResult = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Celeste',
        platformId: 'epic',
        platformGameId: 'Salt',
        catalogItemId: 'syn_celeste_001',
        itemType: 'APPLICATION',
        categories: [{ path: 'games' }],
      });
      expect(celesteResult).toBeNull();
    });

    it('admits Epic base games with itemType="DURABLE" (production Legendary / EGS schema)', () => {
      // Production Legendary cache represents permanent game licenses as itemType="DURABLE"
      const hwResult = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'HOT WHEELS UNLEASHED™',
        platformId: 'epic',
        platformGameId: '0006475a83f143ba807174654bc09d38',
        catalogItemId: 'dff2626bd13b457387875f9ba12f3309',
        itemType: 'DURABLE',
        categories: [{ path: 'games' }, { path: 'applications' }],
      });
      expect(hwResult).toBeNull();

      const gwResult = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Ghostwire Tokyo',
        platformId: 'epic',
        platformGameId: '007ff8f4e30845a687e66aa77eb3e965',
        catalogItemId: 'cat_ghostwire_001',
        itemType: 'DURABLE',
        categories: [{ path: 'games' }, { path: 'games/edition/base' }],
      });
      expect(gwResult).toBeNull();

      const msResult = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Mortal Shell',
        platformId: 'epic',
        platformGameId: '0055e45ce7654c55aade646467349e83',
        catalogItemId: 'cat_mortalshell_001',
        itemType: 'DURABLE',
        categories: [{ path: 'games' }],
      });
      expect(msResult).toBeNull();
    });

    it('admits Epic base games with modding or vaulted edition subpaths in categories', () => {
      const result = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'City of Gangsters',
        platformId: 'epic',
        platformGameId: '002b00085aeb49b1a3f3c42e3f918f2f',
        catalogItemId: 'cat_cog_001',
        itemType: 'DURABLE',
        categories: [{ path: 'games' }, { path: 'mods' }, { path: 'vault' }],
      });
      expect(result).toBeNull();
    });

    it('accurately suppresses legitimate Epic DLCs, add-ons, and expansions', () => {
      // 1. DLC with explicit addons category and mainGameItem
      const foundationResult = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Control - The Foundation',
        platformId: 'epic',
        platformGameId: 'CallunaDLC1',
        catalogItemId: 'syn_control_dlc_foundation_002',
        itemType: 'ADD_ON',
        mainGameItem: { id: 'syn_control_base_001' },
        categories: [{ path: 'addons' }],
      });
      expect(foundationResult).toBe('Filtered: DLC / Add-On / Expansion Content');

      // 2. DLC that carries itemType: "DURABLE" and parent mainGameItem
      const outerWorldsDlc = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'The Outer Worlds: Peril on Gorgon',
        platformId: 'epic',
        platformGameId: 'GorgonDLC',
        catalogItemId: 'syn_gorgon_dlc_001',
        itemType: 'DURABLE',
        mainGameItem: { id: 'syn_outer_worlds_base_001' },
        categories: [{ path: 'games' }],
      });
      expect(outerWorldsDlc).toBe('Filtered: DLC / Add-On / Expansion Content');

      // 3. DLC with itemType: "DURABLE" and title-based season pass pattern
      const bl3SeasonPass = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Borderlands 3: Season Pass',
        platformId: 'epic',
        platformGameId: 'OakSeasonPass',
        catalogItemId: 'cat_oak_sp',
        itemType: 'DURABLE',
        categories: [{ path: 'games' }],
      });
      expect(bl3SeasonPass).toBe('Filtered: DLC / Add-On / Expansion Content');

      // 4. DLC with explicit addons category without games segment
      const fnvLonesomeRoad = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Fallout New Vegas: Lonesome Road',
        platformId: 'epic',
        platformGameId: 'fnv_dlc_04',
        catalogItemId: 'cat_fnv_dlc_04',
        itemType: 'DURABLE',
        categories: [{ path: 'addons' }],
      });
      expect(fnvLonesomeRoad).toBe('Filtered: DLC / Add-On / Expansion Content');

      // 5. Add-on in title matching DLC regex
      const tswAddon = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Train Sim World® 7: Sand Patch Grade Add-On',
        platformId: 'epic',
        platformGameId: 'tsw_sandpatch',
        itemType: 'DURABLE',
        categories: [{ path: 'games' }],
      });
      expect(tswAddon).toBe('Filtered: DLC / Add-On / Expansion Content');
    });

    it('accurately suppresses legitimate tools, editors, engines, dedicated servers, and sandboxes', () => {
      // 1. Pre-game editor with itemType: APPLICATION but without games category
      const editorResult = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Football Manager 2024 Pre-game editor',
        platformId: 'epic',
        platformGameId: 'FM2024Editor',
        itemType: 'APPLICATION',
        categories: [{ path: 'applications' }],
      });
      expect(editorResult).toBe('Filtered: Tool / Editor / Redistributable / Server');

      // 2. Unreal Engine plugin / asset
      const uePlugin = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Unreal Engine 5.4',
        platformId: 'epic',
        platformGameId: 'UE_5.4',
        namespace: 'ue',
        itemType: 'APPLICATION',
        categories: [{ path: 'engines' }],
      });
      expect(uePlugin).toBe('Filtered: Tool / Editor / Redistributable / Server');

      // 3. Dedicated Server
      const dedicatedServer = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Palworld Dedicated Server',
        platformId: 'epic',
        platformGameId: 'PalworldServer',
        itemType: 'APPLICATION',
        categories: [{ path: 'games' }],
      });
      expect(dedicatedServer).toBe('Filtered: Tool / Editor / Redistributable / Server');

      // 4. Standalone Storefront Launcher
      const launcherResult = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Epic Games Launcher',
        platformId: 'epic',
      });
      expect(launcherResult).toBe('Filtered: Tool / Editor / Redistributable / Server');

      // 5. Beta / Test Branch
      const betaResult = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Killing Floor 2 Public Beta',
        platformId: 'epic',
        categories: [{ path: 'games' }],
      });
      expect(betaResult).toBe('Filtered: Beta / Test Branch / Legacy Client');

      // 6. Digital Soundtrack / Extras
      const ostResult = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Death Stranding Digital Soundtrack',
        platformId: 'epic',
        itemType: 'EXTRA',
        categories: [{ path: 'digitalextras' }],
      });
      expect(ostResult).toBe('Filtered: Digital Soundtrack / Artbook / Bonus Content');

      // 7. Private sandbox
      const privResult = classifyNonGameStorefrontItem({
        store: 'epic',
        title: 'Internal Staging Test Build',
        platformId: 'epic',
        sandboxType: 'PRIVATE',
        categories: [{ path: 'games' }],
      });
      expect(privResult).toBe('Filtered: Beta / Test Branch / Legacy Client');
    });

    it('preserves storefront-specific semantics for Xbox vs Epic for Durable products', () => {
      // In Xbox catalog, Durable indicates DLC / Add-on
      const xboxDlc = classifyNonGameStorefrontItem({
        store: 'xbox',
        title: 'Forza Horizon 5 VIP Membership',
        platformId: 'xbox',
        platformGameId: '9N8765432100',
        productKind: 'Durable',
        categories: [],
      });
      expect(xboxDlc).toBe('Filtered: DLC / Add-On / Expansion Content');

      // In Xbox catalog, Game indicates base game
      const xboxGame = classifyNonGameStorefrontItem({
        store: 'xbox',
        title: 'Forza Horizon 5',
        platformId: 'xbox',
        platformGameId: '9N1234567890',
        productKind: 'Game',
        categories: [],
      });
      expect(xboxGame).toBeNull();
    });
  });

  // ============================================================================
  // 2. Integration Tests for storeSync.fetchEpicOwnedGames
  // ============================================================================
  describe('fetchEpicOwnedGames: Online Storefront Ingestion & Suppression', () => {
    it('preserves base games with APPLICATION and DURABLE while suppressing legitimate DLCs and sandboxes', async () => {
      const emptyLegendaryDir = makeTempDir('fetch-epic-empty-');

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/library/api/public/playtime/')) {
          return { ok: true, json: async () => [] };
        }
        if (url.includes('launcher.store.epicgames.com/graphql')) {
          return {
            ok: true,
            json: async () => ({
              data: { PlayerProfile: { playerProfile: { achievementsSummaries: { data: [] } } } },
            }),
          };
        }
        if (url.includes('/launcher/api/public/assets/Mac')) {
          return { ok: true, json: async () => [] };
        }
        if (url.includes('/library/api/public/items')) {
          return {
            ok: true,
            json: async () => ({
              records: [
                {
                  appName: 'Calluna',
                  namespace: 'calluna-ns-001',
                  catalogItemId: 'syn_control_base_001',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Control',
                    itemType: 'APPLICATION',
                    entitlementType: 'EXECUTABLE',
                    categories: [{ path: 'games' }, { path: 'applications' }],
                  },
                },
                {
                  appName: 'CallunaDLC1',
                  namespace: 'calluna-ns-001',
                  catalogItemId: 'syn_control_dlc_foundation_002',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Control - The Foundation',
                    itemType: 'ADDON',
                    mainGameItem: { id: 'syn_control_base_001' },
                    categories: [{ path: 'addons' }],
                  },
                },
                {
                  appName: 'HotWheels',
                  namespace: 'hw-ns-002',
                  catalogItemId: 'syn_hw_base_002',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'HOT WHEELS UNLEASHED™',
                    itemType: 'DURABLE',
                    entitlementType: 'EXECUTABLE',
                    categories: [{ path: 'games' }, { path: 'applications' }],
                  },
                },
                {
                  appName: 'UE_5.4',
                  namespace: 'ue',
                  catalogItemId: 'syn_ue_003',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Unreal Engine 5.4',
                    itemType: 'APPLICATION',
                    categories: [{ path: 'engines' }],
                  },
                },
                {
                  appName: 'PrivateStagingApp',
                  namespace: 'priv-ns-004',
                  catalogItemId: 'syn_priv_004',
                  sandboxType: 'PRIVATE',
                  metadata: {
                    title: 'Private Staging Build',
                    itemType: 'APPLICATION',
                    categories: [{ path: 'games' }],
                  },
                },
              ],
              responseMetadata: {},
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      });

      const outMeta: Record<string, unknown> = {};
      const games = await storeSync.fetchEpicOwnedGames('synthetic_epic_token', 'synthetic_epic_acct', {
        fetchFn: fetchMock,
        legendaryBaseDirs: [emptyLegendaryDir],
        outMeta,
      });

      expect(outMeta.authoritativeComplete).toBe(true);

      // Both Control (APPLICATION) and HOT WHEELS UNLEASHED (DURABLE) are admitted
      const titles = (games as Array<{ title: string }>).map((g) => g.title);
      expect(titles).toContain('Control');
      expect(titles).toContain('HOT WHEELS UNLEASHED™');
      expect(titles).not.toContain('Control - The Foundation');
      expect(titles).not.toContain('Unreal Engine 5.4');
      expect(titles).not.toContain('Private Staging Build');

      // Suppressed items recorded with proper reasons
      const suppressed = outMeta.suppressedItems as Array<{ platformGameId: string; reason: string }>;
      const suppressedIds = suppressed.map((s) => s.platformGameId);
      expect(suppressedIds).toContain('CallunaDLC1');
      const foundationSuppression = suppressed.find((s) => s.platformGameId === 'CallunaDLC1');
      expect(foundationSuppression?.reason).toBe('Filtered: DLC / Add-On / Expansion Content');
    });

    it('defers classification for unhydrated candidate items and admits them once catalog hydration resolves games categories', async () => {
      const emptyLegendaryDir = makeTempDir('fetch-epic-unhydrated-');

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/library/api/public/playtime/')) {
          return { ok: true, json: async () => [] };
        }
        if (url.includes('launcher.store.epicgames.com/graphql')) {
          return {
            ok: true,
            json: async () => ({
              data: { PlayerProfile: { playerProfile: { achievementsSummaries: { data: [] } } } },
            }),
          };
        }
        if (url.includes('/launcher/api/public/assets/Mac')) {
          return { ok: true, json: async () => [] };
        }
        if (url.includes('/library/api/public/items')) {
          return {
            ok: true,
            json: async () => ({
              records: [
                // Unhydrated base game 1: empty categories and generic title 'Live'
                {
                  appName: 'UnhydratedApp1',
                  namespace: 'unhydrated-ns',
                  catalogItemId: 'cat_unhydrated_001',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Live',
                    itemType: 'APPLICATION',
                    categories: [],
                  },
                },
                // Unhydrated base game 2: DURABLE permanent license with title but empty categories
                {
                  appName: 'UnhydratedApp2',
                  namespace: 'unhydrated-ns',
                  catalogItemId: 'cat_unhydrated_002',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'HOT WHEELS UNLEASHED™',
                    itemType: 'DURABLE',
                    categories: [],
                  },
                },
                // Unhydrated DLC item: DURABLE with title but empty categories, resolved as DLC in catalog
                {
                  appName: 'UnhydratedDlcApp',
                  namespace: 'unhydrated-ns',
                  catalogItemId: 'cat_unhydrated_dlc_003',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Live',
                    itemType: 'DURABLE',
                    categories: [],
                  },
                },
              ],
              responseMetadata: {},
            }),
          };
        }
        if (url.includes('/bulk/items')) {
          if (url.includes('cat_unhydrated_001')) {
            return {
              ok: true,
              json: async () => ({
                cat_unhydrated_001: {
                  id: 'cat_unhydrated_001',
                  title: 'Alan Wake 2',
                  itemType: 'APPLICATION',
                  categories: [{ path: 'games' }],
                },
              }),
            };
          }
          if (url.includes('cat_unhydrated_002')) {
            return {
              ok: true,
              json: async () => ({
                cat_unhydrated_002: {
                  id: 'cat_unhydrated_002',
                  title: 'HOT WHEELS UNLEASHED™',
                  itemType: 'DURABLE',
                  categories: [{ path: 'games' }, { path: 'applications' }],
                },
              }),
            };
          }
          if (url.includes('cat_unhydrated_dlc_003')) {
            return {
              ok: true,
              json: async () => ({
                cat_unhydrated_dlc_003: {
                  id: 'cat_unhydrated_dlc_003',
                  title: 'Alan Wake 2: Night Springs',
                  itemType: 'DURABLE',
                  categories: [{ path: 'addons' }],
                  mainGameItem: { id: 'cat_unhydrated_001' },
                },
              }),
            };
          }
        }
        return { ok: true, json: async () => ({}) };
      });

      const outMeta: Record<string, unknown> = {};
      const games = await storeSync.fetchEpicOwnedGames('synthetic_epic_token', 'synthetic_epic_acct', {
        fetchFn: fetchMock,
        legendaryBaseDirs: [emptyLegendaryDir],
        outMeta,
      });

      expect(outMeta.authoritativeComplete).toBe(true);

      const titles = (games as Array<{ title: string }>).map((g) => g.title);
      expect(titles).toContain('Alan Wake 2');
      expect(titles).toContain('HOT WHEELS UNLEASHED™');
      expect(titles).not.toContain('Alan Wake 2: Night Springs');

      const suppressed = (outMeta.suppressedItems || []) as Array<{ platformGameId: string; reason: string }>;
      const suppressedIds = suppressed.map((s) => s.platformGameId);
      expect(suppressedIds).toContain('UnhydratedDlcApp');
      expect(suppressedIds).not.toContain('UnhydratedApp1');
      expect(suppressedIds).not.toContain('UnhydratedApp2');

      const dlcEntry = suppressed.find((s) => s.platformGameId === 'UnhydratedDlcApp');
      expect(dlcEntry?.reason).toBe('Filtered: DLC / Add-On / Expansion Content');
    });

    it('hydrates categories via local Legendary metadata fallback when catalog lookup encounters an error', async () => {
      const legBase = makeTempDir('fetch-epic-local-fallback-');
      const metaDir = path.join(legBase, 'metadata');
      fs.mkdirSync(metaDir, { recursive: true });

      fs.writeFileSync(
        path.join(metaDir, 'OfflineApp.json'),
        JSON.stringify({
          app_name: 'OfflineApp',
          app_title: 'Sifu',
          metadata: {
            id: 'cat_sifu_001',
            title: 'Sifu',
            itemType: 'APPLICATION',
            categories: [{ path: 'games' }],
          },
        }),
        'utf8'
      );

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/library/api/public/playtime/')) {
          return { ok: true, json: async () => [] };
        }
        if (url.includes('launcher.store.epicgames.com/graphql')) {
          return {
            ok: true,
            json: async () => ({
              data: { PlayerProfile: { playerProfile: { achievementsSummaries: { data: [] } } } },
            }),
          };
        }
        if (url.includes('/launcher/api/public/assets/Mac')) {
          return { ok: true, json: async () => [] };
        }
        if (url.includes('/library/api/public/items')) {
          return {
            ok: true,
            json: async () => ({
              records: [
                {
                  appName: 'OfflineApp',
                  namespace: 'offline-ns',
                  catalogItemId: 'cat_sifu_001',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Live',
                    itemType: 'APPLICATION',
                    categories: [],
                  },
                },
              ],
              responseMetadata: {},
            }),
          };
        }
        if (url.includes('/bulk/items')) {
          // Simulate 500 error from catalog
          return { ok: false, status: 500 };
        }
        return { ok: true, json: async () => ({}) };
      });

      const outMeta: Record<string, unknown> = {};
      const games = await storeSync.fetchEpicOwnedGames('synthetic_epic_token', 'synthetic_epic_acct', {
        fetchFn: fetchMock,
        legendaryBaseDirs: [legBase],
        outMeta,
      });

      const titles = (games as Array<{ title: string }>).map((g) => g.title);
      expect(titles).toContain('Sifu');

      const suppressed = (outMeta.suppressedItems || []) as Array<{ platformGameId: string }>;
      expect(suppressed.map((s) => s.platformGameId)).not.toContain('OfflineApp');
    });
  });

  // ============================================================================
  // 3. Integration Tests for storeSync.scanLocalSuppressedStorefrontItems
  // ============================================================================
  describe('scanLocalSuppressedStorefrontItems: Local Metadata Cache Scanning', () => {
    it('scans local Legendary metadata without false positives for DURABLE / APPLICATION base games', () => {
      const legBase = makeTempDir('legendary-meta-test-');
      const metaDir = path.join(legBase, 'metadata');
      fs.mkdirSync(metaDir, { recursive: true });

      // 1. Base Game: Control (itemType: DURABLE, categories: [games, applications])
      fs.writeFileSync(
        path.join(metaDir, 'Calluna.json'),
        JSON.stringify({
          app_name: 'Calluna',
          app_title: 'Control',
          metadata: {
            id: 'syn_control_base',
            title: 'Control',
            itemType: 'DURABLE',
            categories: [{ path: 'games' }, { path: 'applications' }],
            mainGameItem: null,
          },
        }),
        'utf8'
      );

      // 2. Base Game: Celeste (itemType: APPLICATION, categories: [games])
      fs.writeFileSync(
        path.join(metaDir, 'Salt.json'),
        JSON.stringify({
          app_name: 'Salt',
          app_title: 'Celeste',
          metadata: {
            id: 'syn_celeste_base',
            title: 'Celeste',
            itemType: 'APPLICATION',
            categories: [{ path: 'games' }],
            mainGameItem: null,
          },
        }),
        'utf8'
      );

      // 3. Legitimate DLC: Control - The Foundation
      fs.writeFileSync(
        path.join(metaDir, 'CallunaDLC1.json'),
        JSON.stringify({
          app_name: 'CallunaDLC1',
          app_title: 'Control - The Foundation',
          metadata: {
            id: 'syn_control_dlc_1',
            title: 'Control - The Foundation',
            itemType: 'DURABLE',
            categories: [{ path: 'addons' }],
            mainGameItem: { id: 'syn_control_base', namespace: 'calluna-ns' },
          },
        }),
        'utf8'
      );

      // 4. Legitimate DLC: The Outer Worlds: Peril on Gorgon
      fs.writeFileSync(
        path.join(metaDir, 'GorgonDLC.json'),
        JSON.stringify({
          app_name: 'GorgonDLC',
          app_title: 'The Outer Worlds: Peril on Gorgon',
          metadata: {
            id: 'syn_gorgon_dlc',
            title: 'The Outer Worlds: Peril on Gorgon',
            itemType: 'DURABLE',
            categories: [{ path: 'games' }],
            mainGameItem: { id: 'syn_outer_worlds_base', namespace: 'tow-ns' },
          },
        }),
        'utf8'
      );

      // 5. Legitimate Tool: Football Manager Editor
      fs.writeFileSync(
        path.join(metaDir, 'FMEditor.json'),
        JSON.stringify({
          app_name: 'FMEditor',
          app_title: 'Football Manager 2024 Pre-game editor',
          metadata: {
            id: 'syn_fm_editor',
            title: 'Football Manager 2024 Pre-game editor',
            itemType: 'APPLICATION',
            categories: [{ path: 'applications' }],
          },
        }),
        'utf8'
      );

      // 6. Legitimate Soundtrack: Death Stranding OST
      fs.writeFileSync(
        path.join(metaDir, 'DeathStrandingOST.json'),
        JSON.stringify({
          app_name: 'DeathStrandingOST',
          app_title: 'Death Stranding Digital Soundtrack',
          metadata: {
            id: 'syn_ds_ost',
            title: 'Death Stranding Digital Soundtrack',
            itemType: 'EXTRA',
            categories: [{ path: 'digitalextras' }, { path: 'soundtrack' }],
          },
        }),
        'utf8'
      );

      const suppressed = storeSync.scanLocalSuppressedStorefrontItems({
        legendaryDirs: [legBase],
        legendaryBaseDirs: [legBase],
        allowUnverifiedLocalCache: true,
      }) as Array<{ platformId: string; platformGameId: string; reason: string }>;

      const suppressedEpic = suppressed.filter((x) => x.platformId === 'epic');
      const suppressedIds = suppressedEpic.map((x) => x.platformGameId);

      // Base games MUST NOT be suppressed
      expect(suppressedIds).not.toContain('Calluna');
      expect(suppressedIds).not.toContain('Salt');

      // Genuine DLCs and non-games MUST be suppressed
      expect(suppressedIds).toContain('CallunaDLC1');
      expect(suppressedIds).toContain('GorgonDLC');
      expect(suppressedIds).toContain('FMEditor');
      expect(suppressedIds).toContain('DeathStrandingOST');

      const dlcEntry = suppressedEpic.find((x) => x.platformGameId === 'CallunaDLC1');
      expect(dlcEntry?.reason).toBe('Filtered: DLC / Add-On / Expansion Content');

      const gorgonEntry = suppressedEpic.find((x) => x.platformGameId === 'GorgonDLC');
      expect(gorgonEntry?.reason).toBe('Filtered: DLC / Add-On / Expansion Content');

      const editorEntry = suppressedEpic.find((x) => x.platformGameId === 'FMEditor');
      expect(editorEntry?.reason).toBe('Filtered: Tool / Editor / Redistributable / Server');

      const ostEntry = suppressedEpic.find((x) => x.platformGameId === 'DeathStrandingOST');
      expect(ostEntry?.reason).toBe('Filtered: Digital Soundtrack / Artbook / Bonus Content');
    });
  });

  // ============================================================================
  // 4. Unit Tests for epicIntegration.fetchOwnedGamesDetailed (Renderer Fallback Parity)
  // ============================================================================
  describe('fetchOwnedGamesDetailed (Renderer Fallback Parity)', () => {
    it('admits base games with mod support category paths and vault giveaway editions', async () => {
      const axiosSpy = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (String(url).includes('/library/api/public/items')) {
          return {
            data: {
              records: [
                {
                  appName: 'ModdedBaseGame',
                  sandboxName: 'ModdedBaseGame',
                  catalogItemId: 'cat_modded_base_001',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Modded Base Game',
                    itemType: 'APPLICATION',
                    categories: [{ path: 'games_mods_support' }],
                  },
                },
                {
                  appName: 'VaultGiveawayGame',
                  sandboxName: 'VaultGiveawayGame',
                  catalogItemId: 'cat_vault_giveaway_002',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'City of Gangsters (Vault Edition)',
                    itemType: 'APPLICATION',
                    categories: [{ path: 'games' }, { path: 'vault' }],
                  },
                },
                {
                  appName: 'StandaloneModAsset',
                  sandboxName: 'StandaloneModAsset',
                  catalogItemId: 'cat_mod_only_003',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Standalone Mod Asset Pack',
                    itemType: 'APPLICATION',
                    categories: [{ path: 'mods' }],
                  },
                },
              ],
            },
          };
        }
        return { data: {} };
      });

      try {
        const { games } = await epicIntegration.fetchOwnedGamesDetailed('test_token');
        const titles = games.map((g) => g.title);
        expect(titles).toContain('Modded Base Game');
        expect(titles).toContain('City of Gangsters (Vault Edition)');
        expect(titles).not.toContain('Standalone Mod Asset Pack');
      } finally {
        axiosSpy.mockRestore();
      }
    });

    it('admits standalone editions with self-referential mainGameItem and filters real DLCs', async () => {
      const axiosSpy = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (String(url).includes('/library/api/public/items')) {
          return {
            data: {
              records: [
                // Standalone game where mainGameItem.id === catalogItemId
                {
                  appName: 'SelfReferentialGame',
                  sandboxName: 'SelfReferentialGame',
                  catalogItemId: 'cat_self_ref_001',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Self-Referential Standalone Edition',
                    itemType: 'APPLICATION',
                    categories: [{ path: 'games' }],
                    mainGameItem: { id: 'cat_self_ref_001' },
                  },
                },
                // Actual DLC where mainGameItem.id !== catalogItemId
                {
                  appName: 'RealDlcContent',
                  sandboxName: 'RealDlcContent',
                  catalogItemId: 'cat_real_dlc_002',
                  sandboxType: 'PUBLIC',
                  metadata: {
                    title: 'Standalone Game - Season Pass DLC',
                    itemType: 'APPLICATION',
                    categories: [{ path: 'games' }],
                    mainGameItem: { id: 'cat_self_ref_001' },
                  },
                },
              ],
            },
          };
        }
        return { data: {} };
      });

      try {
        const { games } = await epicIntegration.fetchOwnedGamesDetailed('test_token');
        const titles = games.map((g) => g.title);
        expect(titles).toContain('Self-Referential Standalone Edition');
        expect(titles).not.toContain('Standalone Game - Season Pass DLC');
      } finally {
        axiosSpy.mockRestore();
      }
    });
  });
});
