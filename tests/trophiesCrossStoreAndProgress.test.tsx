import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import React from 'react';
import { renderToString } from 'react-dom/server';
import axios from 'axios';
import type { CanonicalGame } from '../src/contracts/game';
import type { MultiStoreAchievementsMap } from '../src/contracts/achievement';
import { achievementDetailService } from '../src/services/achievements/achievementDetailService';
import { steamAchievementsService } from '../src/services/steam/steamAchievementsService';
import { onlineLifecycleManager } from '../src/services/network/onlineLifecycleManager';
import { GameAchievementsModal } from '../src/components/Achievements/GameAchievementsModal';
import { SteamLibraryActionBar } from '../src/components/SteamStoreDetail/SteamLibraryActionBar';
import {
  usePostSessionReconciler,
  type UsePostSessionReconcilerParams,
} from '../src/hooks/usePostSessionReconciler';
import * as integrationStorage from '../src/services/integrations/integrationStorage';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const storeSync = require('../electron/storeSync.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const steamAchProvider = require('../electron/storefronts/steamAchievementsProvider.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const xboxAchievementsAndStats = require('../electron/storefronts/xbox/xboxAchievementsAndStats.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { registerStoreSyncIpcHandlers } = require('../electron/ipc/storeSyncIpcHandlers.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const federatorMod = require('../electron/launcher/storefrontLocalCacheFederator.cjs');

/**
 * Helper to encode a JS object tree into Steam Binary KeyValues (`.bin`) format.
 */
function encodeBinaryVdfMap(obj: Record<string, unknown>): Buffer {
  const parts: Buffer[] = [];
  for (const [key, val] of Object.entries(obj)) {
    const keyBuf = Buffer.from(`${key}\0`, 'utf8');
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      parts.push(Buffer.from([0x00]), keyBuf, encodeBinaryVdfMap(val as Record<string, unknown>));
    } else if (typeof val === 'string') {
      parts.push(Buffer.from([0x01]), keyBuf, Buffer.from(`${val}\0`, 'utf8'));
    } else if (typeof val === 'number') {
      if (Number.isInteger(val)) {
        const numBuf = Buffer.alloc(4);
        numBuf.writeInt32LE(val | 0, 0);
        parts.push(Buffer.from([0x02]), keyBuf, numBuf);
      } else {
        const floatBuf = Buffer.alloc(4);
        floatBuf.writeFloatLE(val, 0);
        parts.push(Buffer.from([0x03]), keyBuf, floatBuf);
      }
    }
  }
  parts.push(Buffer.from([0x08]));
  return Buffer.concat(parts);
}

function makeMockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface TestVNode {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
}

function findElements(
  node: unknown,
  predicate: (el: TestVNode) => boolean,
  acc: TestVNode[] = []
): TestVNode[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, acc);
    return acc;
  }
  const vnode = node as TestVNode;
  if (predicate(vnode)) acc.push(vnode);
  if (vnode.props && 'children' in vnode.props) {
    findElements(vnode.props.children, predicate, acc);
  }
  return acc;
}

function createFiveHookHarness<P>(Component: React.FC<P>, initialProps: P) {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const effectCleanups: Array<(() => void) | undefined> = [];
  const effectDeps: Array<unknown[] | undefined> = [];
  let currentProps = initialProps;

  const render = (nextProps?: P): React.ReactElement | null => {
    if (nextProps !== undefined) currentProps = nextProps;
    let stateIdx = 0;
    let refIdx = 0;
    let effectIdx = 0;
    const internals = (React as unknown as Record<string, { H: unknown }>)
      .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prevH = internals.H;
    internals.H = {
      useState<T>(initial: T | (() => T)) {
        const idx = stateIdx++;
        if (idx >= states.length) {
          states.push(typeof initial === 'function' ? (initial as () => T)() : initial);
        }
        const setState = (updater: T | ((prev: T) => T)) => {
          states[idx] =
            typeof updater === 'function'
              ? (updater as (prev: T) => T)(states[idx] as T)
              : updater;
        };
        return [states[idx], setState];
      },
      useEffect(fn: () => void | (() => void), deps?: unknown[]) {
        const idx = effectIdx++;
        const prevDeps = effectDeps[idx];
        const changed =
          !prevDeps ||
          !deps ||
          prevDeps.length !== deps.length ||
          deps.some((d, i) => !Object.is(d, prevDeps[i]));
        if (changed) {
          effectCleanups[idx]?.();
          effectDeps[idx] = deps;
          const cleanup = fn();
          effectCleanups[idx] = typeof cleanup === 'function' ? cleanup : undefined;
        }
      },
      useRef<T>(initial: T) {
        const idx = refIdx++;
        if (idx >= refs.length) {
          refs.push({ current: initial });
        }
        return refs[idx];
      },
      useMemo<T>(fn: () => T) {
        return fn();
      },
      useCallback<T>(fn: T) {
        return fn;
      },
    };
    try {
      return Component(currentProps) as React.ReactElement | null;
    } finally {
      internals.H = prevH;
    }
  };

  const unmount = () => {
    for (const c of effectCleanups) c?.();
  };

  return { render, unmount };
}

class MemoryStorage {
  private map = new Map<string, string>();
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

describe('Cross-Store Trophies, Individual Unlocks & Progress Bars (Tasks 10, 10a, 10b)', () => {
  const tempDirs: string[] = [];
  const storage = new MemoryStorage();
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevLocalStorage = (globalThis as Record<string, unknown>).localStorage;

  beforeEach(() => {
    vi.restoreAllMocks();
    storage.clear();
    achievementDetailService.clearCache();
    (globalThis as Record<string, unknown>).localStorage = storage;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).window = prevWindow;
    (globalThis as Record<string, unknown>).localStorage = prevLocalStorage;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  // =========================================================================
  // 1. Task 10a — GOG clientId Resolution, SSRF/Zlib Caps & Individual Unlocks
  // =========================================================================
  describe('1. GOG clientId resolution (C2), token refresh, pagination & profile fallback', () => {
    it('resolves productId -> clientId from zlib manifest, blocks non-GOG SSRF links, and enforces 2MB compressed / 4MB inflated caps', async () => {
      const validManifestZlib = zlib.deflateSync(
        Buffer.from(JSON.stringify({ clientId: '52799531131185574', baseProductId: '1901367087' }))
      );
      const requestedUrls: string[] = [];

      const fetchOk = vi.fn(async (input: string) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.includes('content-system.gog.com/products/1901367087/os/windows/builds')) {
          return makeMockJsonResponse({
            items: [{ link: 'https://cdn.gog-statics.com/manifests/synthetic_manifest.zlib' }],
          });
        }
        if (url === 'https://cdn.gog-statics.com/manifests/synthetic_manifest.zlib') {
          return new Response(new Uint8Array(validManifestZlib), { status: 200 });
        }
        return makeMockJsonResponse({}, 404);
      });

      const resolved = await storeSync.resolveGogClientId('1901367087', {
        fetchFn: fetchOk,
        forceRefresh: true,
      });
      expect(resolved).toBe('52799531131185574');

      // Second call hits in-memory LRU cache without network traffic
      const callCountAfterFirst = fetchOk.mock.calls.length;
      const cached = await storeSync.resolveGogClientId('1901367087', { fetchFn: fetchOk });
      expect(cached).toBe('52799531131185574');
      expect(fetchOk.mock.calls.length).toBe(callCountAfterFirst);

      // SSRF defense: upstream build link pointing to non-GOG host must NEVER be fetched
      const ssrfFetchedHosts: string[] = [];
      const fetchSsrf = vi.fn(async (input: string) => {
        const url = String(input);
        ssrfFetchedHosts.push(new URL(url).hostname);
        if (url.includes('content-system.gog.com')) {
          return makeMockJsonResponse({
            items: [{ link: 'https://evil-attacker.example.com/internal' }],
          });
        }
        return new Response('should-never-reach', { status: 200 });
      });
      const ssrfResult = await storeSync.resolveGogClientId('9900011122', {
        fetchFn: fetchSsrf,
        forceRefresh: true,
      });
      expect(ssrfResult).toBeNull();
      expect(ssrfFetchedHosts).not.toContain('evil-attacker.example.com');

      // Compressed > 2 MB cap
      const oversizedBuf = Buffer.alloc(2 * 1024 * 1024 + 64, 0x41);
      const fetchOversized = vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('content-system.gog.com')) {
          return makeMockJsonResponse({
            items: [{ link: 'https://cdn.gog-statics.com/manifests/oversized.zlib' }],
          });
        }
        return new Response(new Uint8Array(oversizedBuf), { status: 200 });
      });
      const oversizedResult = await storeSync.resolveGogClientId('9900011123', {
        fetchFn: fetchOversized,
        forceRefresh: true,
      });
      expect(oversizedResult).toBeNull();

      // Zlib decompression bomb (> 4 MB inflated from tiny compressed payload)
      const bombRaw = Buffer.alloc(5 * 1024 * 1024, 0x20);
      const bombZlib = zlib.deflateSync(bombRaw);
      expect(bombZlib.byteLength).toBeLessThan(64 * 1024);
      const fetchBomb = vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('content-system.gog.com')) {
          return makeMockJsonResponse({
            items: [{ link: 'https://cdn.gog-statics.com/manifests/bomb.zlib' }],
          });
        }
        return new Response(new Uint8Array(bombZlib), { status: 200 });
      });
      const bombResult = await storeSync.resolveGogClientId('9900011124', {
        fetchFn: fetchBomb,
        forceRefresh: true,
      });
      expect(bombResult).toBeNull();
    });

    it('enforces bounded manual redirect loop in resolveGogClientId: blocks 302 to http://127.0.0.1/internal, allows allowlisted GOG HTTPS hop, and caps >3 redirects (F4)', async () => {
      const requestedUrls: string[] = [];
      const seenRedirectModes: Array<string | undefined> = [];

      // 1. 302 redirect from gog-cdn-fastly.gog.com -> http://127.0.0.1/internal MUST be blocked
      const fetchRedirectSsrf = vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        requestedUrls.push(url);
        seenRedirectModes.push(init?.redirect);
        if (url.includes('content-system.gog.com/products/9900099901/os/windows/builds')) {
          return makeMockJsonResponse({
            items: [{ link: 'https://gog-cdn-fastly.gog.com/manifests/evil_redir.zlib' }],
          });
        }
        if (url === 'https://gog-cdn-fastly.gog.com/manifests/evil_redir.zlib') {
          return new Response(null, {
            status: 302,
            headers: { location: 'http://127.0.0.1/internal' },
          });
        }
        return makeMockJsonResponse({}, 404);
      });

      const blocked = await storeSync.resolveGogClientId('9900099901', {
        fetchFn: fetchRedirectSsrf,
        forceRefresh: true,
      });
      expect(blocked).toBeNull();
      expect(requestedUrls.some((u) => u.includes('127.0.0.1'))).toBe(false);
      expect(seenRedirectModes.every((mode) => mode === 'manual')).toBe(true);

      // 2. Legitimate 302 redirect within allowlisted GOG CDN hosts resolves clientId cleanly
      const validManifestZlib = zlib.deflateSync(
        Buffer.from(JSON.stringify({ clientId: '59999111222333444' }))
      );
      const fetchRedirectAllowed = vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('content-system.gog.com/products/9900099902/os/windows/builds')) {
          return makeMockJsonResponse({
            items: [{ link: 'https://gog-cdn-fastly.gog.com/manifests/hop0.zlib' }],
          });
        }
        if (url === 'https://gog-cdn-fastly.gog.com/manifests/hop0.zlib') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.gog-statics.com/manifests/hop1.zlib' },
          });
        }
        if (url === 'https://cdn.gog-statics.com/manifests/hop1.zlib') {
          return new Response(new Uint8Array(validManifestZlib), { status: 200 });
        }
        return makeMockJsonResponse({}, 404);
      });

      const allowed = await storeSync.resolveGogClientId('9900099902', {
        fetchFn: fetchRedirectAllowed,
        forceRefresh: true,
      });
      expect(allowed).toBe('59999111222333444');

      // 3. Exceeding maxRedirects (3) aborts safely instead of looping infinitely
      let hopCount = 0;
      const fetchRedirectLoop = vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('content-system.gog.com/products/9900099903/os/windows/builds')) {
          return makeMockJsonResponse({
            items: [{ link: 'https://gog-cdn-fastly.gog.com/manifests/loop0.zlib' }],
          });
        }
        hopCount++;
        return new Response(null, {
          status: 302,
          headers: { location: `https://gog-cdn-fastly.gog.com/manifests/loop${hopCount}.zlib` },
        });
      });

      const loopBlocked = await storeSync.resolveGogClientId('9900099903', {
        fetchFn: fetchRedirectLoop,
        forceRefresh: true,
      });
      expect(loopBlocked).toBeNull();
      // 3 OS builds * (initial hop + 3 redirects = 4 manifest fetches) = 12 manifest fetches max
      expect(hopCount).toBeLessThanOrEqual(12);
    });

    it('renews expiring GOG tokens, retries once on 401, paginates gameplay.gog.com, and falls back to profilesData with Unix ms conversion', async () => {
      const vaultDir = makeTempDir('gog-ach-vault-');
      tempDirs.push(vaultDir);
      let gameplayAttempts = 0;

      const fetchGog = vi.fn(async (input: string) => {
        const url = String(input);
        if (url === 'https://auth.gog.com/token') {
          return makeMockJsonResponse({
            access_token: 'fresh_gog_tok_2',
            refresh_token: 'fresh_gog_ref_2',
            expires_in: 3600,
            user_id: '555000111',
          });
        }
        if (url.includes('content-system.gog.com/products/1947927225/os/windows/builds')) {
          return makeMockJsonResponse({
            items: [{ link: 'https://cdn.gog-statics.com/manifests/quake2.zlib' }],
          });
        }
        if (url === 'https://cdn.gog-statics.com/manifests/quake2.zlib') {
          const z = zlib.deflateSync(Buffer.from(JSON.stringify({ clientId: '56429181748868111' })));
          return new Response(new Uint8Array(z), { status: 200 });
        }
        if (url.includes('gameplay.gog.com/clients/56429181748868111/users/555000111/achievements')) {
          if (!url.includes('page_token=')) {
            gameplayAttempts++;
            if (gameplayAttempts === 1) {
              return makeMockJsonResponse({ error: 'invalid_grant' }, 401);
            }
            return makeMockJsonResponse({
              total_count: 2,
              page_token: 'next_page_2',
              items: [
                {
                  achievement_id: 'ach_1',
                  achievement_key: 'EST_COMM',
                  name: 'Establish Communications',
                  description: 'Link with the command ship.',
                  date_unlocked: '2026-10-20T18:10:00Z',
                  rarity: 41.3,
                  visible: true,
                  image_url_unlocked: 'https://images.gog.com/a1_u.jpg',
                  image_url_locked: 'https://images.gog.com/a1_l.jpg',
                },
              ],
            });
          }
          return makeMockJsonResponse({
            total_count: 2,
            items: [
              {
                achievement_id: 'ach_2',
                achievement_key: 'SECRET_CORE',
                name: 'Destroy Strogg Core',
                description: 'Finish the final reactor.',
                date_unlocked: null,
                rarity: 6.4,
                visible: false,
                image_url_unlocked: 'https://images.gog.com/a2_u.jpg',
                image_url_locked: 'https://images.gog.com/a2_l.jpg',
              },
            ],
          });
        }
        return makeMockJsonResponse({}, 404);
      });

      const detail = await storeSync.fetchGogDetailedGameAchievements(
        { productId: '1947927225' },
        {
          userDataDir: vaultDir,
          accessToken: 'stale_gog_tok_1',
          refreshToken: 'ref_gog_1',
          userId: '555000111',
          username: 'SyntheticGogPlayer',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          fetchFn: fetchGog,
        }
      );

      expect(detail).toBeTruthy();
      expect(detail.unlockPrecision).toBe('exact');
      expect(detail.total).toBe(2);
      expect(detail.unlocked).toBe(1);
      expect(detail.achievements[0].unlockedAt).toBe('2026-10-20T18:10:00.000Z');
      expect(detail.achievements[1].isSecret).toBe(true);
      expect(detail.achievements[1].rarityTier).toBe('ultra_rare');

      // Profile fallback: converts Unix seconds `unlockDate * 1000` into ISO timestamp
      const profileHtml = `<html><script>window.profilesData = {}; window.profilesData.achievements = ${JSON.stringify(
        [
          {
            achievement: {
              id: '9001',
              clientId: '56429181748868111',
              name: 'Profile Fallback Trophy',
              description: 'Unlocked via profile fallback.',
              imageUrlUnlocked: '//images.gog.com/pf_u.jpg',
              imageUrlLocked: '//images.gog.com/pf_l.jpg',
              rarity: 18.2,
              visible: true,
            },
            stats: {
              '555000111': { isUnlocked: true, unlockDate: 1732052197 },
            },
          },
        ]
      )}; window.profilesData.matchedGame = {};</script></html>`;

      const fetchProfileOnly = vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('www.gog.com/u/SyntheticGogPlayer/game/888111222')) {
          return new Response(profileHtml, { status: 200 });
        }
        return makeMockJsonResponse({}, 404);
      });

      const fallbackDetail = await storeSync.fetchGogDetailedGameAchievements(
        { productId: '888111222' },
        {
          userDataDir: vaultDir,
          username: 'SyntheticGogPlayer',
          userId: '555000111',
          fetchFn: fetchProfileOnly,
        }
      );

      expect(fallbackDetail).toBeTruthy();
      expect(fallbackDetail.unlocked).toBe(1);
      expect(fallbackDetail.achievements[0].unlockedAt).toBe(
        new Date(1732052197 * 1000).toISOString()
      );
      expect(fallbackDetail.achievements[0].iconUnlockedUrl).toBe('https://images.gog.com/pf_u.jpg');
    });
  });

  // =========================================================================
  // 2. Task 10a + 10b — Epic Cloud 2-Step Unlocks, C7 200-GraphQL Retry & Partial Progress
  // =========================================================================
  describe('2. Epic 2-step cloud achievements, HTTP 200 GraphQL auth retry (C7) & statThresholds progress', () => {
    it('joins api.epicgames.dev schema with GraphQL unlocks, retries HTTP 200 UNAUTHENTICATED, guards unlockDate N/A, and computes 4/40 & % progress', async () => {
      const vaultDir = makeTempDir('epic-ach-vault-');
      tempDirs.push(vaultDir);
      let gqlCalls = 0;

      const fetchEpic = vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('api.epicgames.dev/epic/achievements/v1/public/achievements/product/sb_road_redemption/locale/')) {
          return makeMockJsonResponse({
            productId: 'ee0cf0e1ab6a4e1c83e5de0681fea012',
            sandboxId: 'sb_road_redemption',
            totalAchievements: 3,
            totalProductXP: 75,
            achievementSets: {
              base_set: { isBase: true, totalAchievements: 2, totalXP: 25 },
              dlc_set: { isBase: false, totalAchievements: 1, totalXP: 50 },
            },
            achievements: [
              {
                achievement: {
                  name: 'ACH_DEVILS_BRIDGE',
                  unlockedDisplayName: 'Devils Bridge',
                  unlockedDescription: 'Cross the bridge.',
                  unlockedIconLink: 'https://shared-static-prod.epicgames.com/u1.png',
                  lockedIconLink: 'https://shared-static-prod.epicgames.com/l1.png',
                  hidden: false,
                  isBase: true,
                  achievementSetId: 'base_set',
                  XP: 5,
                  rarity: { percent: 45 },
                },
              },
              {
                achievement: {
                  name: 'ACH_DEFLECT_40_ENEMIES',
                  unlockedDisplayName: 'Wax On Wax Off',
                  unlockedDescription: '40 Enemy Deflections',
                  unlockedIconLink: 'https://shared-static-prod.epicgames.com/u2.png',
                  lockedIconLink: 'https://shared-static-prod.epicgames.com/l2.png',
                  hidden: false,
                  isBase: true,
                  achievementSetId: 'base_set',
                  XP: 20,
                  statThresholds: { DeflectEnemyCount: 40 },
                  rarity: { percent: 6 },
                },
              },
              {
                achievement: {
                  name: 'ACH_MULTI_STAT_DLC',
                  unlockedDisplayName: 'Expansion Mastery',
                  unlockedDescription: 'Complete multiple DLC milestones.',
                  unlockedIconLink: 'https://shared-static-prod.epicgames.com/u3.png',
                  lockedIconLink: 'https://shared-static-prod.epicgames.com/l3.png',
                  hidden: true,
                  isBase: false,
                  achievementSetId: 'dlc_set',
                  XP: 50,
                  statThresholds: { BossKills: 5, RacesWon: 10 },
                  rarity: { percent: 14 },
                },
              },
            ],
          });
        }
        if (url === 'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token') {
          return makeMockJsonResponse({
            access_token: 'fresh_epic_tok_2',
            refresh_token: 'fresh_epic_ref_2',
            expires_in: 7200,
            account_id: 'syn_epic_acct_001',
          });
        }
        if (url === 'https://launcher.store.epicgames.com/graphql') {
          gqlCalls++;
          // Simulate HTTP 200 GraphQL UNAUTHENTICATED on attempt 1 (C7!)
          if (gqlCalls === 1) {
            return makeMockJsonResponse(
              {
                errors: [
                  {
                    message: 'Authentication failed',
                    extensions: { code: 'UNAUTHENTICATED' },
                  },
                ],
                data: {
                  PlayerProfile: {
                    playerProfile: {
                      productAchievements: { __typename: 'ServiceError' },
                    },
                  },
                },
              },
              200
            );
          }
          return makeMockJsonResponse({
            data: {
              PlayerProfile: {
                playerProfile: {
                  productAchievements: {
                    __typename: 'PlayerProductAchievementsResponseSuccess',
                    data: {
                      sandboxId: 'sb_road_redemption',
                      epicAccountId: 'syn_epic_acct_001',
                      totalUnlocked: 1,
                      totalXP: 5,
                      playerAchievements: [
                        {
                          playerAchievement: {
                            achievementName: 'ACH_DEVILS_BRIDGE',
                            unlocked: true,
                            unlockDate: '2026-10-23T18:08:57.404Z',
                            progress: 1,
                            XP: 5,
                            achievementSetId: 'base_set',
                            isBase: true,
                          },
                        },
                        {
                          playerAchievement: {
                            achievementName: 'ACH_DEFLECT_40_ENEMIES',
                            unlocked: false,
                            unlockDate: 'N/A',
                            progress: 0.1,
                            XP: 20,
                            achievementSetId: 'base_set',
                            isBase: true,
                          },
                        },
                        {
                          playerAchievement: {
                            achievementName: 'ACH_MULTI_STAT_DLC',
                            unlocked: false,
                            unlockDate: 'N/A',
                            progress: 0.45,
                            XP: 50,
                            achievementSetId: 'dlc_set',
                            isBase: false,
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          });
        }
        return makeMockJsonResponse({}, 404);
      });

      const res = await storeSync.fetchEpicDetailedGameAchievements(
        { sandboxId: 'sb_road_redemption', title: 'Synthetic Road' },
        {
          userDataDir: vaultDir,
          accessToken: 'expired_epic_tok_1',
          refreshToken: 'ref_epic_1',
          accountId: 'syn_epic_acct_001',
          fetchFn: fetchEpic,
        }
      );

      expect(gqlCalls).toBe(2);
      expect(res).toBeTruthy();
      expect(res.unlockPrecision).toBe('exact');
      expect(res.total).toBe(3);
      expect(res.unlocked).toBe(1);
      expect(res.earnedXp).toBe(5);
      expect(res.totalXp).toBe(75);

      const unlockedItem = res.achievements[0];
      expect(unlockedItem.unlocked).toBe(true);
      expect(unlockedItem.unlockedAt).toBe('2026-10-23T18:08:57.404Z');

      const singleStatItem = res.achievements[1];
      expect(singleStatItem.unlocked).toBe(false);
      expect(singleStatItem.unlockedAt).toBeUndefined(); // 'N/A' guarded!
      expect(singleStatItem.progress).toEqual({ current: 4, max: 40, percentage: 10 });

      const multiStatDlc = res.achievements[2];
      expect(multiStatDlc.isBaseGame).toBe(false);
      expect(multiStatDlc.isSecret).toBe(true);
      expect(multiStatDlc.progress).toEqual({ current: 45, max: 100, percentage: 45, unit: '%' });
    });
  });

  // =========================================================================
  // 3. Task 10b — Steam SSR JSON, Private-Profile Cascade & Multi-Root Binary VDF
  // =========================================================================
  describe('3. Steam SSR (44/50), private-profile guard & bounded multi-root bottle binary VDF (C2 & C12)', () => {
    it('parses Steam SSR renderContext.queryData structurally (including 44/50 progress, hidden real text, DLC flag & global %)', async () => {
      const dehydrated = {
        queries: [
          {
            // Deliberately renamed queryKey (`schema_v3`) to verify structural matching (C12)
            queryKey: ['achievements', 1643320, 'schema_v3'],
            state: {
              status: 'success',
              data: {
                groups: [
                  {
                    groupid: 0,
                    achievements: [
                      {
                        internal_key: 256,
                        api_name: 'Story_Start',
                        name: 'Welcome to the Zone',
                        description: 'Enter the perimeter.',
                        hidden: true,
                        icon_achieved: 'icon256.jpg',
                        icon_unachieved: 'icon256_gray.jpg',
                        min_progress: 0,
                        max_progress: 0,
                      },
                      {
                        internal_key: 269,
                        api_name: 'Progressive_NoObstacleTooBig',
                        name: 'No obstacle too big…',
                        description: 'Kill 50 enemies through obstacles.',
                        hidden: false,
                        icon_achieved: 'icon269.jpg',
                        icon_unachieved: 'icon269_gray.jpg',
                        min_progress: 0,
                        max_progress: 50,
                      },
                    ],
                  },
                  {
                    groupid: 1,
                    dlcappid: 2999999,
                    achievements: [
                      {
                        internal_key: 300,
                        api_name: 'DLC_Secret',
                        name: 'Hidden Expansion End',
                        description: 'Complete the secret DLC ending.',
                        hidden: true,
                        icon_achieved: 'icon300.jpg',
                        icon_unachieved: 'icon300_gray.jpg',
                      },
                    ],
                  },
                ],
              },
            },
          },
          {
            queryKey: ['achievements', 1643320, 'user_achievements', '76561198000000042'],
            state: {
              status: 'success',
              data: {
                achievements: {
                  '256': { internal_key: 256, unlocked: true, unlock_time: 1783855196 },
                  '269': { internal_key: 269, progress: 44 },
                },
              },
            },
          },
          {
            queryKey: ['achievements', 1643320, 'globalpercentages'],
            state: {
              status: 'success',
              data: {
                percentages: {
                  '256': 72.4,
                  '269': 16.70000076,
                  '300': 3.2,
                },
              },
            },
          },
        ],
      };

      const ssrPayload = JSON.stringify({
        route: '/profiles/:steamid/achievements/:appid',
        renderContext: {
          queryData: JSON.stringify(dehydrated),
        },
      });
      const html = `<!DOCTYPE html><html><script>window.__DATA__ = ${ssrPayload};</script></html>`;

      const fetchSsr = vi.fn(async () => new Response(html, { status: 200 }));
      const result = await steamAchProvider.fetchSteamDetailedGameAchievements(
        { steamAppId: 1643320 },
        { steamId: '76561198000000042', fetchFn: fetchSsr }
      );

      expect(result).toBeTruthy();
      expect(result.unlockPrecision).toBe('exact');
      expect(result.total).toBe(3);
      expect(result.unlocked).toBe(1);

      const progAch = result.achievements.find(
        (a: { apiName: string }) => a.apiName === 'Progressive_NoObstacleTooBig'
      );
      expect(progAch.progress).toEqual({ current: 44, max: 50, percentage: 88 });
      expect(progAch.globalPercentage).toBe(16.7);
      expect(progAch.rarityTier).toBe('rare');

      const dlcHidden = result.achievements.find(
        (a: { apiName: string }) => a.apiName === 'DLC_Secret'
      );
      expect(dlcHidden.isSecret).toBe(true);
      expect(dlcHidden.isBaseGame).toBe(false);
      expect(dlcHidden.description).toBe('Complete the secret DLC ending.');
      expect(dlcHidden.rarityTier).toBe('ultra_rare');
    });

    it('cascades on private profile to newest CrossOver bottle binary VDF with bit-31 unsigned shift and enforces <=16MB & depth<=16 limits', async () => {
      const rootDir = makeTempDir('steam-vdf-roots-');
      tempDirs.push(rootDir);

      const nativeStatsDir = path.join(rootDir, 'native-steam', 'appcache', 'stats');
      const bottleStatsDir = path.join(rootDir, 'bottle-steam', 'appcache', 'stats');
      fs.mkdirSync(nativeStatsDir, { recursive: true });
      fs.mkdirSync(bottleStatsDir, { recursive: true });

      const schemaVdf = encodeBinaryVdfMap({
        '1643320': {
          stats: {
            '1': {
              type: 4,
              bits: {
                '0': {
                  name: 'ACH_BIT0',
                  display: {
                    name: { english: 'First Step' },
                    desc: { english: 'Begin the journey.' },
                    hidden: '0',
                    icon: 'b0.jpg',
                    icon_gray: 'b0_g.jpg',
                  },
                },
                // Bit 31 tests unsigned right shift (`(bitmask >>> 31) & 1 === 1`)!
                '31': {
                  name: 'ACH_BIT31_SIGN',
                  display: {
                    name: { english: 'Bit 31 Edge Trophy' },
                    desc: { english: 'Unlocked at sign bit 31.' },
                    hidden: '1',
                    icon: 'b31.jpg',
                    icon_gray: 'b31_g.jpg',
                  },
                },
                '5': {
                  name: 'Progressive_NoObstacleTooBig',
                  display: {
                    name: { english: 'No obstacle too big…' },
                    desc: { english: 'Kill 50 enemies through obstacles.' },
                    hidden: '0',
                    icon: 'obs.jpg',
                    icon_gray: 'obs_g.jpg',
                  },
                  progress: {
                    min_val: '0',
                    max_val: '50',
                    value: { operation: 'statvalue', operand1: 'NoObstacleTooBig' },
                  },
                },
              },
            },
            '4': {
              type: 1,
              name: 'NoObstacleTooBig',
            },
          },
        },
      });

      const staleNativeUserVdf = encodeBinaryVdfMap({
        cache: {
          '1': { data: 1, AchievementTimes: { '0': 1700000000 } },
          '4': { data: 12 },
        },
      });
      // Bottle file is newer: bit 0 + bit 31 (0x80000001 -> signed int32 -2147483647) & stat 4 = 44!
      const newerBottleUserVdf = encodeBinaryVdfMap({
        cache: {
          '1': {
            data: -2147483647, // 0x80000001 -> bit 0 and bit 31 both set!
            AchievementTimes: { '0': 1700000000, '31': 1783855196 },
          },
          '4': { data: 44 },
        },
      });

      const nativeUserPath = path.join(nativeStatsDir, 'UserGameStats_1_1643320.bin');
      const bottleUserPath = path.join(bottleStatsDir, 'UserGameStats_1_1643320.bin');
      fs.writeFileSync(path.join(nativeStatsDir, 'UserGameStatsSchema_1643320.bin'), schemaVdf);
      fs.writeFileSync(nativeUserPath, staleNativeUserVdf);
      fs.writeFileSync(bottleUserPath, newerBottleUserVdf);

      // Make bottle file explicitly newer than native file
      const olderTime = new Date(Date.now() - 60_000);
      const newerTime = new Date(Date.now());
      fs.utimesSync(nativeUserPath, olderTime, olderTime);
      fs.utimesSync(bottleUserPath, newerTime, newerTime);

      const fetchPrivateSsr = vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('steamcommunity.com')) {
          return new Response(
            '<html><body><div class="profile_private_info">This profile is private.</div></body></html>',
            { status: 200 }
          );
        }
        return makeMockJsonResponse({
          response: {
            achievements: [
              {
                internal_name: 'Progressive_NoObstacleTooBig',
                localized_name: 'No obstacle too big…',
                player_percent_unlocked: '16.7',
              },
            ],
          },
        });
      });

      // Synthetic SteamID64 (base + 1 = accountId32 1)
      const res = await steamAchProvider.fetchSteamDetailedGameAchievements(
        { steamAppId: 1643320, existingSummary: { unlocked: 2, total: 3 } },
        {
          steamId: '76561197960265729',
          statsDirs: [nativeStatsDir, bottleStatsDir],
          fetchFn: fetchPrivateSsr,
        }
      );

      expect(res).toBeTruthy();
      expect(res.source).toBe('local_cache');
      expect(res.unlockPrecision).toBe('exact');
      expect(res.unlocked).toBe(2);

      const bit31 = res.achievements.find((a: { apiName: string }) => a.apiName === 'ACH_BIT31_SIGN');
      expect(bit31.unlocked).toBe(true);
      expect(bit31.unlockedAt).toBe(1783855196 * 1000);
      expect(bit31.isSecret).toBe(true);

      const prog = res.achievements.find(
        (a: { apiName: string }) => a.apiName === 'Progressive_NoObstacleTooBig'
      );
      expect(prog.progress).toEqual({ current: 44, max: 50, percentage: 88 });
      expect(prog.globalPercentage).toBe(16.7);

      // Private profile with NO local VDF must NEVER report 0 unlocked as `exact` when existingSummary.unlocked > 0
      const noVdfRes = await steamAchProvider.fetchSteamDetailedGameAchievements(
        { steamAppId: 1643320, existingSummary: { unlocked: 35, total: 76 } },
        {
          steamId: '76561197960265729',
          statsDirs: [path.join(rootDir, 'empty-dir')],
          fetchFn: fetchPrivateSsr,
        }
      );
      expect(noVdfRes.unlockPrecision).toBe('summary_count_only');
      expect(noVdfRes.unlocked).toBe(35);

      // C2 Security bounds: reject > 16 MB buffer and nesting depth > 16
      expect(() =>
        steamAchProvider.parseBinaryVdf(Buffer.alloc(1024), { maxBytes: 512 })
      ).toThrow(/exceeds safety cap/i);

      let deepObj: Record<string, unknown> = { leaf: 'ok' };
      for (let i = 0; i < 19; i++) {
        deepObj = { [`lvl_${i}`]: deepObj };
      }
      const deepBuf = encodeBinaryVdfMap(deepObj);
      expect(() => steamAchProvider.parseBinaryVdf(deepBuf)).toThrow(/nesting depth exceeds/i);
    });

    it('discovers local steamId & accountId32 from loginusers.vdf / userdataDirs when steamId is omitted and never emits exact unlockPrecision on unverified schema_fallback (F1)', async () => {
      const rootDir = makeTempDir('steam-local-discover-');
      tempDirs.push(rootDir);

      const bottleSteamRoot = path.join(rootDir, 'bottle-steam');
      const bottleConfigDir = path.join(bottleSteamRoot, 'config');
      const bottleUserdataDir = path.join(bottleSteamRoot, 'userdata');
      const bottleStatsDir = path.join(bottleSteamRoot, 'appcache', 'stats');
      fs.mkdirSync(bottleConfigDir, { recursive: true });
      fs.mkdirSync(path.join(bottleUserdataDir, '1'), { recursive: true });
      fs.mkdirSync(bottleStatsDir, { recursive: true });

      // Synthetic SteamID64 = 76561197960265728 + 1 = 76561197960265729
      fs.writeFileSync(
        path.join(bottleConfigDir, 'loginusers.vdf'),
        `"users"\n{\n  "76561197960265729"\n  {\n    "AccountName" "syntheticlocal"\n    "MostRecent" "1"\n    "Timestamp" "1783855196"\n  }\n}\n`,
        'utf8'
      );

      const schemaVdf = encodeBinaryVdfMap({
        '1643320': {
          stats: {
            '1': {
              type: 4,
              bits: {
                '0': {
                  name: 'ACH_LOCAL_FIRST',
                  display: {
                    name: { english: 'Local Explorer' },
                    desc: { english: 'Discovered locally.' },
                    hidden: '0',
                  },
                },
                '1': {
                  name: 'ACH_LOCAL_PROGRESS',
                  display: {
                    name: { english: 'Local Marksman' },
                    desc: { english: 'Score 50 hits.' },
                    hidden: '0',
                  },
                  progress: {
                    min_val: '0',
                    max_val: '50',
                    value: { operation: 'statvalue', operand1: 'LocalHits' },
                  },
                },
              },
            },
            '2': { type: 1, name: 'LocalHits' },
          },
        },
      });
      const userVdf = encodeBinaryVdfMap({
        cache: {
          '1': { data: 1, AchievementTimes: { '0': 1783855196 } },
          '2': { data: 44 },
        },
      });
      fs.writeFileSync(path.join(bottleStatsDir, 'UserGameStatsSchema_1643320.bin'), schemaVdf);
      fs.writeFileSync(path.join(bottleStatsDir, 'UserGameStats_1_1643320.bin'), userVdf);

      const requestedSsrUrls: string[] = [];
      const fetchPrivateForLocal = vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('steamcommunity.com')) {
          requestedSsrUrls.push(url);
          return new Response(
            '<html><body><div class="profile_private_info">This profile is private.</div></body></html>',
            { status: 200 }
          );
        }
        return makeMockJsonResponse({ response: { achievements: [] } });
      });

      // Omit steamId completely -> discovers 76561197960265729 from loginusers.vdf, queries SSR, then cascades to bottle VDF
      const discoveredRes = await steamAchProvider.fetchSteamDetailedGameAchievements(
        { steamAppId: 1643320 },
        {
          userdataDirs: [bottleUserdataDir],
          statsDirs: [bottleStatsDir],
          fetchFn: fetchPrivateForLocal,
        }
      );
      expect(requestedSsrUrls).toEqual([
        'https://steamcommunity.com/profiles/76561197960265729/achievements/1643320?l=english',
      ]);
      expect(discoveredRes).toBeTruthy();
      expect(discoveredRes.source).toBe('local_cache');
      expect(discoveredRes.unlockPrecision).toBe('exact');
      expect(discoveredRes.unlocked).toBe(1);
      const localProg = discoveredRes.achievements.find(
        (a: { apiName: string }) => a.apiName === 'ACH_LOCAL_PROGRESS'
      );
      expect(localProg?.progress).toEqual({ current: 44, max: 50, percentage: 88 });

      // schema_fallback with NO steamId / NO verified user query must NEVER emit unlockPrecision: 'exact'
      const emptyStatsDir = path.join(rootDir, 'empty-stats', 'appcache', 'stats');
      fs.mkdirSync(emptyStatsDir, { recursive: true });
      const fetchSchemaOnly = vi.fn(async () =>
        makeMockJsonResponse({
          response: {
            achievements: [
              {
                internal_name: 'ACH_1',
                localized_name: 'Unverified Schema Trophy',
                player_percent_unlocked: '42.0',
              },
            ],
          },
        })
      );
      const unverifiedRes = await steamAchProvider.fetchSteamDetailedGameAchievements(
        { steamAppId: 1643320 },
        {
          statsDirs: [emptyStatsDir],
          fetchFn: fetchSchemaOnly,
        }
      );
      expect(unverifiedRes).toBeTruthy();
      expect(unverifiedRes.source).toBe('schema_fallback');
      expect(unverifiedRes.unlockPrecision).toBe('summary_count_only');
    });
  });

  // =========================================================================
  // 4. Xbox Progress Fixes, Secret Preservation, Rarity Alignment & TitleHub
  // =========================================================================
  describe('4. Xbox achievements fixes & Tier-2 local cache federation bypass (C6)', () => {
    it('suppresses NotStarted zero-GUID 0/100 spam, tags InProgress with %, aggregates multi-req progress, preserves locked secret description & aligns rarity', () => {
      const notStartedBinary = xboxAchievementsAndStats.mapXboxV2Achievement(
        {
          id: '1',
          name: 'Closed an Oblivion Gate',
          description: 'Shut the first gate.',
          lockedDescription: 'Shut the first gate.',
          progressState: 'NotStarted',
          isSecret: false,
          rarity: { currentPercentage: 8.5 },
          progression: {
            requirements: [
              { id: '00000000-0000-0000-0000-000000000000', current: '0', target: '100' },
            ],
          },
        },
        '19088743'
      );
      expect(notStartedBinary.progress).toBeUndefined();
      expect(notStartedBinary.rarityTier).toBe('ultra_rare'); // <10%

      const inProgressPct = xboxAchievementsAndStats.mapXboxV2Achievement(
        {
          id: '2',
          name: 'Hoarder',
          description: 'Collect everything.',
          lockedDescription: 'Collect everything.',
          progressState: 'InProgress',
          isSecret: true,
          rarity: { currentPercentage: 22.0 },
          progression: {
            requirements: [
              { id: '00000000-0000-0000-0000-000000000000', current: '64', target: '100' },
            ],
          },
        },
        '19088743'
      );
      expect(inProgressPct.progress).toEqual({ current: 64, max: 100, percentage: 64, unit: '%' });
      expect(inProgressPct.description).toBe('Collect everything.'); // real locked secret description preserved!
      expect(inProgressPct.rarityTier).toBe('rare'); // 10% - 24.9%

      const multiReq = xboxAchievementsAndStats.mapXboxV2Achievement(
        {
          id: '3',
          name: 'Dual Mastery',
          description: 'Finish both goals.',
          progressState: 'InProgress',
          isSecret: false,
          rarity: { currentPercentage: 30.0 },
          progression: {
            requirements: [
              { id: '11111111-1111-1111-1111-111111111111', current: '10', target: '20' }, // 50%
              { id: '22222222-2222-2222-2222-222222222222', current: '10', target: '10' }, // 100%
            ],
          },
        },
        '19088743'
      );
      expect(multiReq.progress).toEqual({ current: 75, max: 100, percentage: 75, unit: '%' });
      expect(multiReq.rarityTier).toBe('uncommon'); // 25% - 49.9%

      // TitleHub must NOT fabricate total=49 from Gamerscore progressPercentage=41% when totalAchievements=0
      const parsedHub = xboxAchievementsAndStats.parseTitleHubEntry({
        titleId: '19088743',
        name: 'Resonance',
        achievement: {
          currentAchievements: 20,
          totalAchievements: 0,
          currentGamerscore: 410,
          totalGamerscore: 1000,
          progressPercentage: 41,
        },
      });
      expect(parsedHub.summary.unlocked).toBe(20);
      expect(parsedHub.summary.total).toBe(0);
      expect(parsedHub.summary.gamerscore).toEqual({ earned: 410, total: 1000 });
    });

    it('bypasses Tier-2 local cache federation for role=achievement_icon and (role=icon, ordinal>0) while keeping game icon federation intact', () => {
      const sandbox = makeTempDir('fed-ach-icon-');
      tempDirs.push(sandbox);
      const steamRoot = path.join(sandbox, 'steam');
      const appCacheDir = path.join(steamRoot, 'appcache', 'librarycache', '1643320');
      fs.mkdirSync(appCacheDir, { recursive: true });
      // Minimal valid JPEG header + bytes
      const fakeJpg = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
        Buffer.alloc(128, 0x33),
        Buffer.from([0xff, 0xd9]),
      ]);
      const appIconPath = path.join(appCacheDir, 'icon.jpg');
      fs.writeFileSync(appIconPath, fakeJpg);

      const fed = federatorMod.createStorefrontLocalCacheFederator({
        platform: 'darwin',
        homedir: sandbox,
        userDataDir: path.join(sandbox, 'ud'),
        steamRoots: [steamRoot],
      });

      expect(
        fed.resolveFederatedAsset({ steamAppId: 1643320, role: 'icon', ordinal: 0 })?.path
      ).toBe(path.resolve(appIconPath));
      expect(
        fed.resolveFederatedAsset({ steamAppId: 1643320, role: 'achievement_icon', ordinal: 1 })
      ).toBeNull();
      expect(
        fed.resolveFederatedAsset({ steamAppId: 1643320, role: 'icon', ordinal: 1 })
      ).toBeNull();
    });
  });

  // =========================================================================
  // 5. IPC Routing (`store:get-achievements`) for GOG, Epic, Steam & Xbox
  // =========================================================================
  describe('5. store:get-achievements IPC routes all 4 storefronts', () => {
    it('dispatches gog, epic, and xbox branches cleanly', async () => {
      const handlers = new Map<string, (e: unknown, p: Record<string, unknown>) => Promise<unknown>>();
      const gogSpy = vi.fn(async () => ({ storefrontId: 'gog', unlocked: 12, total: 35, achievements: [] }));
      const epicSpy = vi.fn(async () => ({ storefrontId: 'epic', unlocked: 59, total: 88, achievements: [] }));
      const xboxSpy = vi.fn(async () => ({ storefrontId: 'xbox', unlocked: 20, total: 36, achievements: [] }));

      registerStoreSyncIpcHandlers({
        ipcMain: {
          handle: (ch: string, fn: (e: unknown, p: Record<string, unknown>) => Promise<unknown>) =>
            handlers.set(ch, fn),
          on: vi.fn(),
          removeListener: vi.fn(),
        },
        BrowserWindow: vi.fn(),
        session: {},
        getMainWindow: () => null,
        storeSync: {
          loadSavedTokens: () => ({}),
          fetchGogDetailedGameAchievements: gogSpy,
          fetchEpicDetailedGameAchievements: epicSpy,
          fetchXboxDetailedGameAchievements: xboxSpy,
        },
        launcherEngine: {},
      });

      const handler = handlers.get('store:get-achievements')!;
      expect(await handler({}, { platformId: 'gog', platformGameId: '1901367087' })).toMatchObject({
        storefrontId: 'gog',
        unlocked: 12,
      });
      expect(await handler({}, { platformId: 'epic', namespace: 'sb_aw2' })).toMatchObject({
        storefrontId: 'epic',
        unlocked: 59,
      });
      expect(await handler({}, { platformId: 'xbox', xboxTitleId: '19088743' })).toMatchObject({
        storefrontId: 'xbox',
        unlocked: 20,
      });
    });

    it('uses loadSavedTokensAsync(sharedVaultOpts), forwards payload steamId/apiKey/existingSummary, and falls through schema_fallback with 0 unlocks to browser XML (F1)', async () => {
      const handlers = new Map<string, (e: unknown, p: Record<string, unknown>) => Promise<unknown>>();
      const loadSavedTokensAsyncSpy = vi.fn(async () => ({ steam: {} }));
      const steamProviderSpy = vi.fn(async () => ({
        storefrontId: 'steam',
        storefrontName: 'Steam',
        total: 2,
        unlocked: 0,
        percentage: 0,
        isMastered: false,
        source: 'schema_fallback',
        unlockPrecision: 'summary_count_only',
        supportsAchievements: true,
        achievements: [
          {
            id: 'steam:1643320:ACH_1',
            apiName: 'ACH_1',
            name: 'First Steps',
            unlocked: false,
            iconUnlockedUrl: 'https://shared.fastly.steamstatic.com/community_assets/images/apps/1643320/a1.jpg',
          },
          {
            id: 'steam:1643320:ACH_2',
            apiName: 'ACH_2',
            name: 'Zone Veteran',
            unlocked: false,
            iconUnlockedUrl: 'https://shared.fastly.steamstatic.com/community_assets/images/apps/1643320/a2.jpg',
          },
        ],
      }));

      registerStoreSyncIpcHandlers({
        ipcMain: {
          handle: (ch: string, fn: (e: unknown, p: Record<string, unknown>) => Promise<unknown>) =>
            handlers.set(ch, fn),
          on: vi.fn(),
          removeListener: vi.fn(),
        },
        BrowserWindow: vi.fn(),
        session: {},
        getMainWindow: () => null,
        options: { userDataDir: '/tmp/synthetic-vault-f1' },
        storeSync: {
          loadSavedTokensAsync: loadSavedTokensAsyncSpy,
          loadSavedTokens: () => ({}),
          fetchSteamDetailedGameAchievements: steamProviderSpy,
        },
        launcherEngine: {},
      });

      const ipcHandler = handlers.get('store:get-achievements')!;
      const ipcPayload = {
        platformId: 'steam',
        storefrontId: 'steam',
        gameId: 'steam-1643320',
        platformGameId: '1643320',
        steamAppId: 1643320,
        steamId: '76561198000000042',
        apiKey: 'SYNTHETIC_API_KEY',
        existingSummary: { unlocked: 1, total: 2 },
        title: 'Synthetic Zone',
      };
      await ipcHandler({}, ipcPayload);

      expect(loadSavedTokensAsyncSpy).toHaveBeenCalledWith(
        expect.objectContaining({ userDataDir: '/tmp/synthetic-vault-f1' })
      );
      expect(steamProviderSpy).toHaveBeenCalledWith(
        ipcPayload,
        expect.objectContaining({
          userDataDir: '/tmp/synthetic-vault-f1',
          steamId: '76561198000000042',
          apiKey: 'SYNTHETIC_API_KEY',
          existingSummary: { unlocked: 1, total: 2 },
        })
      );

      // End-to-end renderer AchievementDetailService -> IPC -> XML fallthrough when IPC returns schema_fallback with 0 unlocks
      const getStoreAchievementsMock = vi.fn(
        async (payload: Record<string, unknown>) => await ipcHandler({}, payload)
      );
      (globalThis as Record<string, unknown>).window = {
        localStorage: storage,
        addEventListener: () => {},
        removeEventListener: () => {},
        electronAPI: {
          isElectron: true,
          getStoreAchievements: getStoreAchievementsMock,
        },
      };

      vi.spyOn(onlineLifecycleManager, 'isOnline').mockReturnValue(true);
      vi.spyOn(steamAchievementsService, 'getActiveSteamCredentials').mockReturnValue({
        steamId: '76561198000000042',
        apiKey: 'SYNTHETIC_API_KEY',
      });
      vi.spyOn(achievementDetailService, 'fetchSteamGlobalPercentages').mockResolvedValue(
        new Map([['ach_1', 64.5]])
      );
      const axiosGetSpy = vi.spyOn(axios, 'get').mockResolvedValue({
        data: `<?xml version="1.0" encoding="UTF-8"?><playerstats><achievements>
          <achievement closed="1"><name><![CDATA[First Steps]]></name><apiname>ACH_1</apiname><description><![CDATA[Begin the run.]]></description><iconClosed>https://shared.fastly.steamstatic.com/a1.jpg</iconClosed><iconOpen>https://shared.fastly.steamstatic.com/a1_g.jpg</iconOpen><unlockTimestamp>1783855196</unlockTimestamp></achievement>
          <achievement closed="0"><name><![CDATA[Zone Veteran]]></name><apiname>ACH_2</apiname><description><![CDATA[Finish the run.]]></description><iconClosed>https://shared.fastly.steamstatic.com/a2.jpg</iconClosed><iconOpen>https://shared.fastly.steamstatic.com/a2_g.jpg</iconOpen></achievement>
        </achievements></playerstats>`,
      });

      const resolved = await achievementDetailService.fetchSteamDetailedAchievements(
        1643320,
        'Synthetic Zone',
        { unlocked: 1, total: 2, percentage: 50, isMastered: false }
      );

      expect(getStoreAchievementsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          steamAppId: 1643320,
          steamId: '76561198000000042',
          apiKey: 'SYNTHETIC_API_KEY',
          existingSummary: { unlocked: 1, total: 2 },
        })
      );
      expect(axiosGetSpy).toHaveBeenCalled();
      expect(resolved?.source).toBe('live_cloud');
      expect(resolved?.unlockPrecision).toBe('exact');
      expect(resolved?.unlocked).toBe(1);
      expect(resolved?.achievements[0].unlocked).toBe(true);
    });
  });

  // =========================================================================
  // 6. GameAchievementsModal UX, <progress>, In Progress, Spoilers & SWR
  // =========================================================================
  describe('6. GameAchievementsModal progress formatting, In Progress tab, Closest sort, spoiler masking & SWR', () => {
    it('renders instant cache + ol-setup-progress (44 / 50 (88%) & 64%), In Progress tab, Closest to Unlock sort, DLC badge, masked secret alt/aria-label, Reveal All Secrets & zero Platinum/Bronze', async () => {
      (globalThis as Record<string, unknown>).window = {
        localStorage: storage,
        addEventListener: () => {},
        removeEventListener: () => {},
        electronAPI: {
          isElectron: true,
          offlineVault: {
            saveGameDetail: vi.fn(async () => ({ success: true })),
          },
        },
      };

      const stalkerGame: CanonicalGame = {
        id: 'steam-1643320',
        title: 'S.T.A.L.K.E.R. 2: Heart of Chornobyl',
        sortTitle: 'S.T.A.L.K.E.R. 2: Heart of Chornobyl',
        steamAppId: 1643320,
        platforms: [
          { platformId: 'steam', platformGameId: '1643320', installed: true },
          { platformId: 'xbox', platformGameId: '9NTESTXBOX', xboxTitleId: '19088743', installed: false },
        ],
        capsuleImage: 'https://example.com/s2.jpg',
        headerImage: 'https://example.com/s2_h.jpg',
        developers: ['GSC'],
        publishers: ['GSC'],
        genres: ['Action'],
        tags: ['FPS'],
      };

      const cachedMap: MultiStoreAchievementsMap = {
        steam: {
          storefrontId: 'steam',
          storefrontName: 'Steam',
          total: 4,
          unlocked: 1,
          percentage: 25,
          isMastered: false,
          source: 'live_cloud',
          unlockPrecision: 'exact',
          supportsAchievements: true,
          cacheVersion: 2,
          syncedAt: new Date().toISOString(),
          achievements: [
            {
              id: 'steam:1643320:ach_done',
              apiName: 'ACH_DONE',
              name: 'First Steps',
              description: 'Enter the Zone.',
              unlocked: true,
              unlockedAt: '2026-10-01T12:00:00Z',
              iconUnlockedUrl: 'https://shared.fastly.steamstatic.com/community_assets/images/apps/1643320/a1.jpg',
              globalPercentage: 82.0,
              rarityTier: 'common',
              storefrontId: 'steam',
            },
            {
              id: 'steam:1643320:ach_10',
              apiName: 'ACH_LOW_PROG',
              name: 'Small Steps',
              description: 'Do 10 things.',
              unlocked: false,
              iconUnlockedUrl: 'https://shared.fastly.steamstatic.com/community_assets/images/apps/1643320/a2.jpg',
              globalPercentage: 45.0,
              rarityTier: 'uncommon',
              progress: { current: 2, max: 20, percentage: 10 },
              storefrontId: 'steam',
            },
            {
              id: 'steam:1643320:ach_44',
              apiName: 'Progressive_NoObstacleTooBig',
              name: 'No obstacle too big…',
              description: 'Kill 50 enemies through obstacles.',
              unlocked: false,
              iconUnlockedUrl: 'https://shared.fastly.steamstatic.com/community_assets/images/apps/1643320/a3.jpg',
              globalPercentage: 16.7,
              rarityTier: 'rare',
              progress: { current: 44, max: 50, percentage: 88 },
              storefrontId: 'steam',
            },
            {
              id: 'steam:1643320:ach_secret_dlc',
              apiName: 'DLC_SECRET_BOSS',
              name: 'Secret Boss Finale',
              description: 'Defeat the true hidden boss.',
              unlocked: false,
              isSecret: true,
              isBaseGame: false,
              tierName: 'platinum', // Must NEVER be rendered as 'Platinum' (C4!)
              iconUnlockedUrl: 'https://shared.fastly.steamstatic.com/community_assets/images/apps/1643320/a4.jpg',
              globalPercentage: 3.1,
              rarityTier: 'ultra_rare',
              progress: { current: 1, max: 2, percentage: 50 },
              storefrontId: 'steam',
            },
          ],
        },
        xbox: {
          storefrontId: 'xbox',
          storefrontName: 'Xbox',
          total: 1,
          unlocked: 0,
          percentage: 0,
          isMastered: false,
          source: 'live_cloud',
          unlockPrecision: 'exact',
          supportsAchievements: true,
          cacheVersion: 2,
          syncedAt: new Date().toISOString(),
          achievements: [
            {
              id: 'xbox:19088743:hoarder',
              apiName: 'hoarder',
              name: 'Hoarder',
              description: 'Collect items.',
              unlocked: false,
              iconUnlockedUrl: 'https://images-eds-ssl.xboxlive.com/hoarder.png',
              progress: { current: 64, max: 100, percentage: 64, unit: '%' },
              gamerscore: 50,
              storefrontId: 'xbox',
            },
          ],
        },
      };

      achievementDetailService.setCachedMultiStoreAchievements(stalkerGame.id, cachedMap);

      const harness = createFiveHookHarness(GameAchievementsModal, {
        isOpen: true,
        game: stalkerGame,
        onClose: vi.fn(),
      });

      // Frame 1 triggers effect -> instant cached paint (no blocking spinner!)
      harness.render();
      const vnode = harness.render();
      const html = renderToString(vnode).replace(/<!--\s*-->/g, '');

      expect(html).not.toContain('Loading official storefront achievements...');
      expect(html).toContain('ol-setup-progress');
      expect(html).not.toContain('class="sr-only"');
      expect(html).not.toContain('Platinum');
      expect(html).not.toContain('Bronze');
      expect(html).toContain('role=achievement_icon');
      expect(html).toContain('44 / 50');
      expect(html).toContain('(88%)');
      expect(html).toContain('In Progress (3)');
      expect(html).toContain('Closest to Unlock');
      expect(html).toContain('DLC');
      expect(html).toContain('Reveal All Secrets');
      expect(html).toContain('aria-label="Refresh achievements"');

      // C12 Spoiler safety: hidden achievement title/description NOT leaked in alt or aria-label!
      expect(html).not.toContain('Secret Boss Finale');
      expect(html).not.toContain('Defeat the true hidden boss.');
      expect(html).toContain('alt="Hidden Achievement"');
      expect(html).toContain('aria-label="Hidden achievement progress"');

      // Click "Reveal All Secrets" -> real hidden title & description now appear!
      const revealAllBtn = findElements(
        vnode,
        (el) => el.type === 'button' && renderToString(el as React.ReactElement).includes('Reveal All Secrets')
      )[0];
      expect(revealAllBtn).toBeTruthy();
      (revealAllBtn.props?.onClick as () => void)();
      const revealedHtml = renderToString(harness.render()).replace(/<!--\s*-->/g, '');
      expect(revealedHtml).toContain('Secret Boss Finale');
      expect(revealedHtml).toContain('Defeat the true hidden boss.');

      // Sort by Closest to Unlock -> 44/50 (88%) appears before 2/20 (10%)!
      const sortSelect = findElements(
        vnode,
        (el) => el.type === 'select' && el.props?.['aria-label'] === 'Sort achievements'
      )[0];
      expect(sortSelect).toBeTruthy();
      (sortSelect.props?.onChange as (e: { target: { value: string } }) => void)({
        target: { value: 'closest_progress' },
      });
      const sortedHtml = renderToString(harness.render()).replace(/<!--\s*-->/g, '');
      expect(sortedHtml.indexOf('No obstacle too big…')).toBeLessThan(
        sortedHtml.indexOf('Small Steps')
      );

      // Switch to Xbox tab -> resets filter tab and formats unit='%' as `64%` (never `64 / 100`)
      const xboxTabBtn = findElements(
        harness.render(),
        (el) => el.type === 'button' && renderToString(el as React.ReactElement).includes('Xbox')
      )[0];
      expect(xboxTabBtn).toBeTruthy();
      (xboxTabBtn.props?.onClick as () => void)();
      const xboxHtml = renderToString(harness.render()).replace(/<!--\s*-->/g, '');
      expect(xboxHtml).toContain('64%');
      expect(xboxHtml).not.toContain('64 / 100');

      harness.unmount();
    });

    it('avoids Refreshing... flicker on fresh Electron cache hits while triggering SWR when platform summary unlocked exceeds cached count (F2 & F8)', async () => {
      (globalThis as Record<string, unknown>).window = {
        localStorage: storage,
        addEventListener: () => {},
        removeEventListener: () => {},
        electronAPI: {
          isElectron: true,
          getStoreAchievements: vi.fn(async () => null),
        },
      };
      vi.spyOn(onlineLifecycleManager, 'isOnline').mockReturnValue(true);

      const freshGame: CanonicalGame = {
        id: 'steam-1643320',
        title: 'Synthetic Fresh Cache',
        sortTitle: 'Synthetic Fresh Cache',
        steamAppId: 1643320,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1643320',
            installed: true,
            achievements: { unlocked: 1, total: 2, percentage: 50, isMastered: false },
          },
        ],
        capsuleImage: 'https://example.com/c.jpg',
        headerImage: 'https://example.com/h.jpg',
        developers: ['Dev'],
        publishers: ['Pub'],
        genres: ['Action'],
        tags: ['FPS'],
      };

      const freshCachedMap: MultiStoreAchievementsMap = {
        steam: {
          storefrontId: 'steam',
          storefrontName: 'Steam',
          total: 2,
          unlocked: 1,
          percentage: 50,
          isMastered: false,
          source: 'live_cloud',
          unlockPrecision: 'exact',
          supportsAchievements: true,
          cacheVersion: 2,
          syncedAt: new Date().toISOString(),
          achievements: [
            {
              id: 'steam:1643320:a1',
              apiName: 'A1',
              name: 'First Steps',
              unlocked: true,
              iconUnlockedUrl: 'https://example.com/a1.jpg',
              storefrontId: 'steam',
            },
            {
              id: 'steam:1643320:a2',
              apiName: 'A2',
              name: 'Second Steps',
              unlocked: false,
              iconUnlockedUrl: 'https://example.com/a2.jpg',
              storefrontId: 'steam',
            },
          ],
        },
      };
      achievementDetailService.setCachedMultiStoreAchievements(freshGame.id, freshCachedMap);

      const fetchSpy = vi
        .spyOn(achievementDetailService, 'fetchGameAchievements')
        .mockResolvedValue(freshCachedMap);

      const freshHarness = createFiveHookHarness(GameAchievementsModal, {
        isOpen: true,
        game: freshGame,
        onClose: vi.fn(),
      });
      freshHarness.render();
      const freshHtml = renderToString(freshHarness.render()).replace(/<!--\s*-->/g, '');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(freshHtml).not.toContain('Refreshing...');
      freshHarness.unmount();

      // Now platform summary unlocked (2) exceeds cached unlocked (1) -> triggers background SWR and settles in same microtask!
      const higherSummaryGame: CanonicalGame = {
        ...freshGame,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1643320',
            installed: true,
            achievements: { unlocked: 2, total: 2, percentage: 100, isMastered: true },
          },
        ],
      };
      const updatedMap: MultiStoreAchievementsMap = {
        steam: {
          ...freshCachedMap.steam!,
          unlocked: 2,
          percentage: 100,
          isMastered: true,
          achievements: freshCachedMap.steam!.achievements.map((a) => ({ ...a, unlocked: true })),
        },
      };
      fetchSpy.mockResolvedValueOnce(updatedMap);

      const swrHarness = createFiveHookHarness(GameAchievementsModal, {
        isOpen: true,
        game: higherSummaryGame,
        onClose: vi.fn(),
      });
      swrHarness.render();
      expect(fetchSpy).toHaveBeenCalledWith(higherSummaryGame, true);
      await Promise.resolve();
      const settledHtml = renderToString(swrHarness.render()).replace(/<!--\s*-->/g, '');
      expect(settledHtml).not.toContain('Refreshing...');
      expect(settledHtml).toContain('2 of 2 Unlocked');
      swrHarness.unmount();
    });
  });

  // =========================================================================
  // 7. SteamLibraryActionBar Split Drawer Toggle & Zero Fabricated Metrics
  // =========================================================================
  describe('7. SteamLibraryActionBar split chevron drawer & zero synthetic 1000G/1000XP', () => {
    it('opens multi-store breakdown drawer via chevron toggle when onViewAchievements is provided, removes fake 1000G/1000XP & stops leaking Steam total', () => {
      (globalThis as Record<string, unknown>).window = {
        localStorage: storage,
        addEventListener: () => {},
        removeEventListener: () => {},
      };

      const multiGame: CanonicalGame = {
        id: 'steam-1643320',
        title: 'Synthetic Cross Store RPG',
        sortTitle: 'Synthetic Cross Store RPG',
        steamAppId: 1643320,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1643320',
            installed: true,
            achievements: { total: 76, unlocked: 35, percentage: 46, isMastered: false },
          },
          {
            platformId: 'epic',
            platformGameId: 'syn_epic_app',
            namespace: 'sb_syn_epic',
            installed: false,
            achievements: { total: 50, unlocked: 10, percentage: 20, isMastered: false },
          },
          {
            platformId: 'gog',
            platformGameId: '1234567890',
            installed: false,
            // No verified GOG achievement summary -> must NOT inherit Steam's 76!
          },
        ],
        capsuleImage: 'https://example.com/c.jpg',
        headerImage: 'https://example.com/h.jpg',
        developers: ['Dev'],
        publishers: ['Pub'],
        genres: ['RPG'],
        tags: ['RPG'],
      };

      const onViewAchievements = vi.fn();
      const harness = createFiveHookHarness(SteamLibraryActionBar, {
        game: multiGame,
        onViewAchievements,
      });

      const initialVnode = harness.render();
      const toggleBtn = findElements(
        initialVnode,
        (el) => el.props?.['data-testid'] === 'toggle-storefront-achievements-drawer'
      )[0];
      expect(toggleBtn).toBeTruthy();
      expect(toggleBtn.props?.['aria-expanded']).toBe(false);

      // Click split chevron -> opens inline Storefront Achievements Breakdown drawer
      (toggleBtn.props?.onClick as () => void)();
      const expandedVnode = harness.render();
      const expandedHtml = renderToString(expandedVnode).replace(/<!--\s*-->/g, '');
      const expandedText = expandedHtml.replace(/<[^>]+>/g, '');
      expect(expandedText).toContain('Storefront Achievements Breakdown');
      expect(expandedText).toContain('35 / 76');
      expect(expandedText).toContain('10 / 50');
      expect(expandedText).toContain('No Achievements'); // GOG did not inherit Steam's 76!
      expect(expandedText).not.toContain('1000 XP');
      expect(expandedText).not.toContain('1000 G');

      harness.unmount();
    });
  });

  // =========================================================================
  // 8. usePostSessionReconciler Per-Game Invalidation & Named Trophy Toast
  // =========================================================================
  describe('8. usePostSessionReconciler invalidates per-game cache & shows named unlock toast', () => {
    it('evicts localStorage cache, fetches fresh detailed Steam achievements, and emits named unlock toast', async () => {
      const target = new EventTarget();
      const getStoreAchievements = vi.fn(async () => ({
        storefrontId: 'steam',
        storefrontName: 'Steam',
        total: 2,
        unlocked: 2,
        percentage: 100,
        isMastered: true,
        source: 'live_cloud',
        unlockPrecision: 'exact',
        supportsAchievements: true,
        achievements: [
          {
            id: 'steam:1643320:a1',
            apiName: 'A1',
            name: 'First Steps',
            unlocked: true,
            unlockedAt: '2026-10-01T12:00:00Z',
            iconUnlockedUrl: 'https://example.com/a1.jpg',
            storefrontId: 'steam',
          },
          {
            id: 'steam:1643320:a2',
            apiName: 'Progressive_NoObstacleTooBig',
            name: 'No obstacle too big…',
            unlocked: true,
            unlockedAt: '2026-11-20T20:00:00Z',
            iconUnlockedUrl: 'https://example.com/a2.jpg',
            storefrontId: 'steam',
          },
        ],
      }));

      (globalThis as Record<string, unknown>).window = {
        localStorage: storage,
        addEventListener: target.addEventListener.bind(target),
        removeEventListener: target.removeEventListener.bind(target),
        dispatchEvent: target.dispatchEvent.bind(target),
        electronAPI: {
          isElectron: true,
          scanSteamAchievements: vi.fn(async () => ({ success: true, achievements: {} })),
          getStoreAchievements,
        },
      };

      const game: CanonicalGame = {
        id: 'steam-1643320',
        title: 'Synthetic Zone',
        sortTitle: 'Synthetic Zone',
        steamAppId: 1643320,
        platforms: [
          {
            platformId: 'steam',
            platformGameId: '1643320',
            installed: true,
            playtimeMinutes: 120,
            achievements: { unlocked: 1, total: 2, percentage: 50, isMastered: false },
          },
        ],
        capsuleImage: 'https://example.com/c.jpg',
        headerImage: 'https://example.com/h.jpg',
        developers: ['Dev'],
        publishers: ['Pub'],
        genres: ['Action'],
        tags: ['FPS'],
      };

      // Pre-populate stale detailed cache with only A1 unlocked
      achievementDetailService.setCachedMultiStoreAchievements(game.id, {
        steam: {
          storefrontId: 'steam',
          storefrontName: 'Steam',
          total: 2,
          unlocked: 1,
          percentage: 50,
          isMastered: false,
          source: 'live_cloud',
          unlockPrecision: 'exact',
          supportsAchievements: true,
          cacheVersion: 2,
          achievements: [
            {
              id: 'steam:1643320:a1',
              apiName: 'A1',
              name: 'First Steps',
              unlocked: true,
              iconUnlockedUrl: 'https://example.com/a1.jpg',
              storefrontId: 'steam',
            },
            {
              id: 'steam:1643320:a2',
              apiName: 'Progressive_NoObstacleTooBig',
              name: 'No obstacle too big…',
              unlocked: false,
              progress: { current: 44, max: 50, percentage: 88 },
              iconUnlockedUrl: 'https://example.com/a2.jpg',
              storefrontId: 'steam',
            },
          ],
        },
      });

      let currentGames: CanonicalGame[] = [game];
      const gamesRef = { current: currentGames };
      const setGames = vi.fn((updater: React.SetStateAction<CanonicalGame[]>) => {
        currentGames = typeof updater === 'function' ? updater(currentGames) : updater;
        gamesRef.current = currentGames;
      });
      const showSyncNotice = vi.fn();
      vi.spyOn(integrationStorage, 'saveCurrentCatalog').mockImplementation(() => {});

      const Probe: React.FC<UsePostSessionReconcilerParams> = (props) => {
        usePostSessionReconciler(props);
        return null;
      };
      const harness = createFiveHookHarness(Probe, { gamesRef, setGames, showSyncNotice });
      harness.render();

      target.dispatchEvent(
        new CustomEvent('antigravity:game-session-ended', {
          detail: {
            sessionId: 'sess-stalker-1',
            sessionEvent: 'stopped',
            gameId: game.id,
            platformId: 'steam',
            platformGameId: '1643320',
            sessionMinutesPlayed: 30,
          },
        })
      );

      await new Promise((r) => setTimeout(r, 40));

      expect(getStoreAchievements).toHaveBeenCalledTimes(1);
      expect(showSyncNotice).toHaveBeenCalledWith(
        expect.stringContaining('Unlocked "No obstacle too big…" in Synthetic Zone (2/2)'),
        6000
      );
      expect(currentGames[0].platforms[0].achievements?.unlocked).toBe(2);

      harness.unmount();
    });

    it('preserves cached GOG detailed achievements when a game session ends while offline (F5)', async () => {
      const target = new EventTarget();
      const getStoreAchievements = vi.fn(async () => null);
      (globalThis as Record<string, unknown>).window = {
        localStorage: storage,
        addEventListener: target.addEventListener.bind(target),
        removeEventListener: target.removeEventListener.bind(target),
        dispatchEvent: target.dispatchEvent.bind(target),
        electronAPI: {
          isElectron: true,
          getStoreAchievements,
        },
      };

      vi.spyOn(onlineLifecycleManager, 'isOnline').mockReturnValue(false);
      vi.spyOn(integrationStorage, 'saveCurrentCatalog').mockImplementation(() => {});

      const gogGame: CanonicalGame = {
        id: 'gog-1947927225',
        title: 'Synthetic Offline GOG Classic',
        sortTitle: 'Synthetic Offline GOG Classic',
        platforms: [
          {
            platformId: 'gog',
            platformGameId: '1947927225',
            installed: true,
            playtimeMinutes: 60,
            achievements: { unlocked: 2, total: 5, percentage: 40, isMastered: false },
          },
        ],
        capsuleImage: 'https://example.com/gog.jpg',
        headerImage: 'https://example.com/gog_h.jpg',
        developers: ['Dev'],
        publishers: ['Pub'],
        genres: ['RPG'],
        tags: ['DRM-Free'],
      };

      achievementDetailService.setCachedMultiStoreAchievements(gogGame.id, {
        gog: {
          storefrontId: 'gog',
          storefrontName: 'GOG GALAXY',
          total: 5,
          unlocked: 2,
          percentage: 40,
          isMastered: false,
          source: 'live_cloud',
          unlockPrecision: 'exact',
          supportsAchievements: true,
          cacheVersion: 2,
          syncedAt: '2026-11-19T12:00:00.000Z',
          achievements: [
            {
              id: 'gog:1947927225:a1',
              apiName: 'A1',
              name: 'Cached Trophy 1',
              unlocked: true,
              iconUnlockedUrl: 'https://images.gog.com/a1.jpg',
              storefrontId: 'gog',
            },
          ],
        },
      });

      const invalidateSpy = vi.spyOn(achievementDetailService, 'invalidateGame');
      let currentGames: CanonicalGame[] = [gogGame];
      const gamesRef = { current: currentGames };
      const setGames = vi.fn((updater: React.SetStateAction<CanonicalGame[]>) => {
        currentGames = typeof updater === 'function' ? updater(currentGames) : updater;
        gamesRef.current = currentGames;
      });
      const showSyncNotice = vi.fn();

      const Probe: React.FC<UsePostSessionReconcilerParams> = (props) => {
        usePostSessionReconciler(props);
        return null;
      };
      const harness = createFiveHookHarness(Probe, { gamesRef, setGames, showSyncNotice });
      harness.render();

      target.dispatchEvent(
        new CustomEvent('antigravity:game-session-ended', {
          detail: {
            sessionId: 'sess-gog-offline-1',
            sessionEvent: 'stopped',
            gameId: gogGame.id,
            platformId: 'gog',
            platformGameId: '1947927225',
            sessionMinutesPlayed: 15,
          },
        })
      );

      await new Promise((r) => setTimeout(r, 40));

      expect(invalidateSpy).not.toHaveBeenCalled();
      const stillCached = achievementDetailService.peekCachedGameAchievements(gogGame.id);
      expect(stillCached?.gog?.unlocked).toBe(2);
      expect(stillCached?.gog?.achievements[0].name).toBe('Cached Trophy 1');

      harness.unmount();
    });
  });
});
