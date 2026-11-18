import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nodeRequire = createRequire(import.meta.url);
const storeSync = nodeRequire('../electron/storeSync.cjs');
const nonGameClassifier = nodeRequire('../electron/storefronts/nonGameClassifier.cjs');

const { classifyNonGameStorefrontItem } = nonGameClassifier;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('Milestone M1 Challenger 1: Epic Boundary Verification — "Live" vs Real Titled with Empty Categories', () => {
  let originalFetch: typeof globalThis.fetch;
  let testDirs: string[] = [];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const d of testDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    testDirs = [];
  });

  it('drops unhydrated "Live" item with empty categories but admits real titled item with empty categories defaulting to [{ path: "games" }]', async () => {
    const tmpDir = makeTempDir('ol-challenger-boundary-');
    testDirs.push(tmpDir);

    const isolatedOpts = {
      homedir: tmpDir,
      userDataDir: path.join(tmpDir, 'vault'),
      legendaryBaseDirs: [],
      legendaryDirs: [],
      skipNetwork: true,
    };

    // Library returns 2 items:
    // 1) "EpicLiveApp" with title "Live" and empty categories
    // 2) "EpicRealTitledApp" with real title "Synthetic Odyssey", empty categories, itemType APPLICATION
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/playtime/account/')) return jsonResponse([], 200);
      if (url.includes('/assets/Mac')) return jsonResponse([], 200);
      if (url.includes('/library/api/public/items')) {
        return jsonResponse(
          {
            records: [
              {
                appName: 'EpicLiveApp',
                namespace: 'ns_live',
                catalogItemId: 'cat_live_01',
                sandboxType: 'PUBLIC',
                itemType: 'APPLICATION',
                metadata: {
                  title: 'Live',
                  categories: [],
                },
              },
              {
                appName: 'EpicRealTitledApp',
                namespace: 'ns_realtitled',
                catalogItemId: 'cat_real_02',
                sandboxType: 'PUBLIC',
                itemType: 'APPLICATION',
                metadata: {
                  title: 'Synthetic Odyssey',
                  description: 'A genuine standalone synthetic game.',
                  developer: 'Synthetica Games',
                  categories: [],
                },
              },
            ],
            responseMetadata: {},
          },
          200
        );
      }
      // Catalog returns empty map (neither item resolved from catalog)
      if (url.includes('catalog-public-service-prod06.ol.epicgames.com')) {
        return jsonResponse({}, 200);
      }
      return jsonResponse({}, 200);
    }) as typeof fetch;

    const games = await storeSync.fetchEpicOwnedGames(
      'syn_token_boundary_test',
      'syn_account_boundary_test',
      isolatedOpts
    );

    // 1. "EpicLiveApp" MUST be dropped as unhydrated
    const liveItem = games.find((g: any) => g.id === 'epic-EpicLiveApp');
    expect(liveItem).toBeUndefined();

    // 2. "EpicRealTitledApp" MUST be admitted
    const realItem = games.find((g: any) => g.id === 'epic-EpicRealTitledApp');
    expect(realItem).toBeDefined();
    expect(realItem.title).toBe('Synthetic Odyssey');

    // 3. Confirm EpicRealTitledApp is NOT in suppressedItems
    const suppressed = (storeSync.fetchEpicOwnedGames.lastSuppressedItems || []).find(
      (s: any) => s.platformGameId === 'EpicRealTitledApp'
    );
    expect(suppressed).toBeUndefined();

    // 4. Since catalog returned 200 (no upstream error), lastAuthoritativeComplete should be true
    expect(storeSync.fetchEpicOwnedGames.lastAuthoritativeComplete).toBe(true);
  });

  it('handles "Live" item when catalog fails with 500: flags lastAuthoritativeComplete === false while still admitting real titled item', async () => {
    const tmpDir = makeTempDir('ol-challenger-boundary-cat500-');
    testDirs.push(tmpDir);

    const isolatedOpts = {
      homedir: tmpDir,
      userDataDir: path.join(tmpDir, 'vault'),
      legendaryBaseDirs: [],
      legendaryDirs: [],
      skipNetwork: true,
    };

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/playtime/account/')) return jsonResponse([], 200);
      if (url.includes('/assets/Mac')) return jsonResponse([], 200);
      if (url.includes('/library/api/public/items')) {
        return jsonResponse(
          {
            records: [
              {
                appName: 'EpicLiveApp500',
                namespace: 'ns_live',
                catalogItemId: 'cat_live_500',
                sandboxType: 'PUBLIC',
                itemType: 'APPLICATION',
                metadata: {
                  title: 'Live',
                },
              },
              {
                appName: 'EpicRealTitledApp500',
                namespace: 'ns_realtitled',
                catalogItemId: 'cat_real_500',
                sandboxType: 'PUBLIC',
                itemType: 'APPLICATION',
                metadata: {
                  title: 'Synthetic Horizon 500',
                  description: 'Game with real title that survives catalog failure.',
                  developer: 'Synthetica',
                },
              },
            ],
            responseMetadata: {},
          },
          200
        );
      }
      if (url.includes('catalog-public-service-prod06.ol.epicgames.com')) {
        return jsonResponse({ error: 'Internal Server Error' }, 500);
      }
      return jsonResponse({}, 200);
    }) as typeof fetch;

    const games = await storeSync.fetchEpicOwnedGames(
      'syn_token_cat500',
      'syn_account_cat500',
      isolatedOpts
    );

    // EpicLiveApp500 failed catalog and has title 'Live' -> dropped & triggers authoritativeComplete: false
    expect(games.find((g: any) => g.id === 'epic-EpicLiveApp500')).toBeUndefined();

    // EpicRealTitledApp500 has real title -> admitted
    const realItem = games.find((g: any) => g.id === 'epic-EpicRealTitledApp500');
    expect(realItem).toBeDefined();
    expect(realItem.title).toBe('Synthetic Horizon 500');

    // Authoritative complete is false because catalog failed for unhydrated EpicLiveApp500
    expect(storeSync.fetchEpicOwnedGames.lastAuthoritativeComplete).toBe(false);
  });

  it('even if catalog upstream explicitly returns title "Live", the item is rejected as unhydrated', async () => {
    const tmpDir = makeTempDir('ol-challenger-boundary-catreturns-live-');
    testDirs.push(tmpDir);

    const isolatedOpts = {
      homedir: tmpDir,
      userDataDir: path.join(tmpDir, 'vault'),
      legendaryBaseDirs: [],
      legendaryDirs: [],
      skipNetwork: true,
    };

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/playtime/account/')) return jsonResponse([], 200);
      if (url.includes('/assets/Mac')) return jsonResponse([], 200);
      if (url.includes('/library/api/public/items')) {
        return jsonResponse(
          {
            records: [
              {
                appName: 'EpicCatalogReturnsLive',
                namespace: 'ns_live_cat',
                catalogItemId: 'cat_live_from_catalog',
                sandboxType: 'PUBLIC',
                metadata: {},
              },
            ],
            responseMetadata: {},
          },
          200
        );
      }
      if (url.includes('catalog-public-service-prod06.ol.epicgames.com')) {
        return jsonResponse(
          {
            cat_live_from_catalog: {
              id: 'cat_live_from_catalog',
              title: 'Live',
              categories: [{ path: 'games' }],
            },
          },
          200
        );
      }
      return jsonResponse({}, 200);
    }) as typeof fetch;

    const games = await storeSync.fetchEpicOwnedGames(
      'syn_token_cat_live',
      'syn_account_cat_live',
      isolatedOpts
    );

    // Even though catalog returned title: 'Live', it must be rejected!
    expect(games.find((g: any) => g.id === 'epic-EpicCatalogReturnsLive')).toBeUndefined();
    expect(games).toHaveLength(0);
  });

  it('preserves valid titles that contain "Live" as a substring (e.g. "Livewire" or "Live and Learn")', async () => {
    const tmpDir = makeTempDir('ol-challenger-boundary-substring-live-');
    testDirs.push(tmpDir);

    const isolatedOpts = {
      homedir: tmpDir,
      userDataDir: path.join(tmpDir, 'vault'),
      legendaryBaseDirs: [],
      legendaryDirs: [],
      skipNetwork: true,
    };

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/playtime/account/')) return jsonResponse([], 200);
      if (url.includes('/assets/Mac')) return jsonResponse([], 200);
      if (url.includes('/library/api/public/items')) {
        return jsonResponse(
          {
            records: [
              {
                appName: 'EpicLivewire',
                namespace: 'ns_livewire',
                catalogItemId: 'cat_livewire',
                sandboxType: 'PUBLIC',
                itemType: 'APPLICATION',
                metadata: {
                  title: 'Livewire',
                  categories: [],
                },
              },
              {
                appName: 'EpicLiveAndLearn',
                namespace: 'ns_livelearn',
                catalogItemId: 'cat_livelearn',
                sandboxType: 'PUBLIC',
                itemType: 'DURABLE',
                metadata: {
                  title: 'Live and Learn',
                  categories: [],
                },
              },
            ],
            responseMetadata: {},
          },
          200
        );
      }
      if (url.includes('catalog-public-service-prod06.ol.epicgames.com')) {
        return jsonResponse({}, 200);
      }
      return jsonResponse({}, 200);
    }) as typeof fetch;

    const games = await storeSync.fetchEpicOwnedGames(
      'syn_token_substring_live',
      'syn_account_substring_live',
      isolatedOpts
    );

    expect(games.map((g: any) => g.title).sort()).toEqual(['Live and Learn', 'Livewire']);
    
    // Neither game should be suppressed
    const suppressedIds = (storeSync.fetchEpicOwnedGames.lastSuppressedItems || []).map(
      (s: any) => s.platformGameId
    );
    expect(suppressedIds).not.toContain('EpicLivewire');
    expect(suppressedIds).not.toContain('EpicLiveAndLearn');
  });

  it('verifies hex hashes and UUIDs are treated as unhydrated stubs and dropped when unresolved', async () => {
    const tmpDir = makeTempDir('ol-challenger-boundary-hex-uuid-');
    testDirs.push(tmpDir);

    const isolatedOpts = {
      homedir: tmpDir,
      userDataDir: path.join(tmpDir, 'vault'),
      legendaryBaseDirs: [],
      legendaryDirs: [],
      skipNetwork: true,
    };

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/playtime/account/')) return jsonResponse([], 200);
      if (url.includes('/assets/Mac')) return jsonResponse([], 200);
      if (url.includes('/library/api/public/items')) {
        return jsonResponse(
          {
            records: [
              {
                appName: 'EpicHexHash',
                namespace: 'ns_hex',
                catalogItemId: 'cat_hex',
                sandboxType: 'PUBLIC',
                metadata: {
                  title: '0123456789abcdef0123456789abcdef', // 32-char hex hash
                },
              },
              {
                appName: 'EpicUUID',
                namespace: 'ns_uuid',
                catalogItemId: 'cat_uuid',
                sandboxType: 'PUBLIC',
                metadata: {
                  title: '12345678-1234-1234-1234-123456789abc', // UUID string
                },
              },
              {
                appName: 'EpicEmptyTitle',
                namespace: 'ns_empty',
                catalogItemId: 'cat_empty',
                sandboxType: 'PUBLIC',
                metadata: {
                  title: '',
                },
              },
            ],
            responseMetadata: {},
          },
          200
        );
      }
      if (url.includes('catalog-public-service-prod06.ol.epicgames.com')) {
        return jsonResponse({}, 200);
      }
      return jsonResponse({}, 200);
    }) as typeof fetch;

    const games = await storeSync.fetchEpicOwnedGames(
      'syn_token_hex_uuid',
      'syn_account_hex_uuid',
      isolatedOpts
    );

    expect(games).toHaveLength(0);
  });

  it('proves classifyNonGameStorefrontItem suppresses APPLICATION and DURABLE without categories, but admits them with [{ path: "games" }]', () => {
    // Case 1: Epic APPLICATION without games category -> suppressed as Tool / Editor
    const suppressedApp = classifyNonGameStorefrontItem({
      store: 'epic',
      title: 'Synthetic Real Game',
      itemType: 'APPLICATION',
      categories: [],
    });
    expect(suppressedApp).toBe('Filtered: Tool / Editor / Redistributable / Server');

    // Case 2: Epic APPLICATION WITH defaulted [{ path: 'games' }] -> admitted (null)
    const admittedApp = classifyNonGameStorefrontItem({
      store: 'epic',
      title: 'Synthetic Real Game',
      itemType: 'APPLICATION',
      categories: [{ path: 'games' }],
    });
    expect(admittedApp).toBeNull();

    // Case 3: Epic DURABLE without games category -> suppressed as DLC
    const suppressedDurable = classifyNonGameStorefrontItem({
      store: 'epic',
      title: 'Synthetic Real Game',
      itemType: 'DURABLE',
      categories: [],
    });
    expect(suppressedDurable).toBe('Filtered: DLC / Add-On / Expansion Content');

    // Case 4: Epic DURABLE WITH defaulted [{ path: 'games' }] -> admitted (null)
    const admittedDurable = classifyNonGameStorefrontItem({
      store: 'epic',
      title: 'Synthetic Real Game',
      itemType: 'DURABLE',
      categories: [{ path: 'games' }],
    });
    expect(admittedDurable).toBeNull();
  });
});
