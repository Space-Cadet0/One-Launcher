import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { InstalledGameRecord } from '../src/contracts/launcher';
import { HowLongToBeatCard } from '../src/components/SteamStoreDetail/HowLongToBeatCard';
import {
  renderGameHoverPopout,
  type RenderGameHoverPopoutArgs,
} from '../src/components/Library/Grid/GameHoverPopout';
import { criticScoreService } from '../src/services/critic/criticScoreService';
import {
  metacriticResolver,
  toCanonicalMetacriticSlug,
} from '../src/services/critic/metacriticResolver';
import { steamReviewResolver } from '../src/services/critic/steamReviewResolver';
import { storefrontStarResolver } from '../src/services/critic/storefrontStarResolver';
import { storefrontReviewHarvester } from '../src/services/critic/storefrontReviewHarvester';
import {
  HLTB_DATABASE,
  HLTB_QUERY_NORM_VERSION,
  HLTB_TITLE_DATABASE,
  fetchAndCacheHltb,
  findBestHltbMatch,
  getHowLongToBeat,
  hasAttemptedHltbLookup,
  seedHltbFromVaultIfMissing,
  wasCorruptedByLegacyV1HltbTokenizer,
  type HltbData,
  type HltbSearchResultItem,
} from '../src/services/hltb/howLongToBeat';
import {
  buildHltbSearchTermPasses,
  decodeTitleHtmlEntities,
  foldLatinLigaturesAndDiacritics,
  normalizeTitleKey,
  sanitizeTitleForSearchQuery,
  stripTrademarkSymbols,
} from '../src/services/common/titleUtils';
import {
  KNOWN_IGDB_COVERS,
  computeTokenSimilarity as computeIgdbTokenSimilarity,
  normalizeCacheKey as normalizeIgdbCacheKey,
  normalizeKey as normalizeIgdbKey,
} from '../src/services/igdb/igdbCoverService';
import { LauncherService } from '../src/services/launcher/launcherService';
import { requestScheduler, DOMAIN_CONFIGS } from '../src/services/network/requestScheduler';
import {
  createDomain12DeepRenderer,
  createMemoryStorage,
  findElements,
  getTextContent,
  makeCanonicalGameFixture,
} from './helpers/xboxTestHarness';
import {
  loadLocalKeyedHmacConfig,
  scanContentForPiiViolations,
} from './helpers/piiHygieneGuard';

const cjsRequire = createRequire(import.meta.url);
const storeSyncIpc = cjsRequire('../electron/ipc/storeSyncIpcHandlers.cjs') as {
  buildHltbSearchTermPasses: (rawTitle: string) => string[][];
  registerStoreSyncIpcHandlers: (deps: {
    ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void };
    storeSync: Record<string, unknown>;
  }) => void;
};
const storeSyncMod = cjsRequire('../electron/storeSync.cjs') as {
  fetchIgdbCover: (gameTitle: string) => Promise<string | null>;
};
const offlineVaultMod = cjsRequire('../electron/launcher/offlineVaultService.cjs') as {
  createOfflineVaultService: (options?: { userDataDir?: string }) => {
    saveGameDetail: (payload: Record<string, unknown>) => { success: boolean; error?: string };
    getGameDetail: (gameId: string) => {
      gameId: string;
      hltb: HltbData | null;
      enrichedMetadata: unknown;
      achievements: unknown;
      criticScore: unknown;
    } | null;
    shutdown: () => void;
  };
};

describe('Phase 3B & 4.1: Review Scoring Engine Hardening, HLTB Guard, and RequestScheduler Domain Expansion', () => {
  beforeEach(() => {
    criticScoreService.clearCache();
    requestScheduler.reset();
    vi.restoreAllMocks();
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function disallowLiveSockets(
      this: net.Socket,
      ...args: unknown[]
    ) {
      throw new Error(
        `Hermetic offline test guard blocked outbound net.Socket.connect(${JSON.stringify(args[0])})`
      );
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('RequestScheduler howlongtobeat.com Domain Configuration', () => {
    it('configures howlongtobeat.com token bucket and resolves HLTB URLs and proxies', () => {
      expect(DOMAIN_CONFIGS['howlongtobeat.com']).toEqual({
        requestsPerSecond: 1.0,
        burst: 2,
      });
      expect(requestScheduler.resolveDomain('howlongtobeat.com')).toBe('howlongtobeat.com');
      expect(requestScheduler.resolveDomain('https://howlongtobeat.com/api/search/site')).toBe('howlongtobeat.com');
      expect(requestScheduler.resolveDomain('/api/hltb/api/search/site/init?t=123')).toBe('howlongtobeat.com');
    });
  });

  describe('OpenCritic Live API Hardening (Tier 2)', () => {
    it('rejects OpenCritic candidate when release year differs by >= 4 years (2006 game vs 2017 reboot)', async () => {
      vi.spyOn(storefrontReviewHarvester, 'getStorefrontAnchor').mockResolvedValue(null);
      vi.spyOn(metacriticResolver, 'resolveMetacritic').mockResolvedValue({ critic: null, user: null });
      vi.spyOn(steamReviewResolver, 'resolveScore').mockResolvedValue(null);
      vi.spyOn(storefrontStarResolver, 'resolveStorefrontScore').mockResolvedValue(null);

      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/game/search')) {
          return {
            ok: true,
            json: async () => [{ id: 4001, name: 'Shadowbound', dist: 0.0 }],
          };
        }
        if (url.includes('/api/game/4001')) {
          return {
            ok: true,
            json: async () => ({
              id: 4001,
              name: 'Shadowbound',
              firstReleaseDate: '2017-05-05T00:00:00.000Z',
              topCriticScore: 82,
              percentRecommended: 80,
              numReviews: 95,
            }),
          };
        }
        return { ok: false };
      });
      vi.stubGlobal('fetch', fetchMock);

      // Querying original 2006 Shadowbound should reject the 2017 reboot from OpenCritic
      const score2006 = await criticScoreService.resolveDynamicScore('Shadowbound', 993970, 2006);
      expect(score2006).toBeNull();

      // Querying 2017 Shadowbound should accept the 2017 OpenCritic candidate
      criticScoreService.clearCache();
      const score2017 = await criticScoreService.resolveDynamicScore('Shadowbound', 994804, 2017);
      expect(score2017).not.toBeNull();
      expect(score2017?.source).toBe('opencritic');
      expect(score2017?.score).toBe(82);
    });
  });

  describe('Sample-Size Weighting Between Tier 3 (Metacritic User) and Tier 4 (Steam Community)', () => {
    it('prefers Tier 4 Steam score when Tier 3 Metacritic User Score has < 25 ratings and Steam has high sample size', async () => {
      vi.spyOn(storefrontReviewHarvester, 'getStorefrontAnchor').mockResolvedValue(null);
      vi.spyOn(metacriticResolver, 'resolveMetacritic').mockResolvedValue({
        critic: null,
        user: {
          id: 'mc-user-tiny',
          source: 'metacritic_user',
          score: 52,
          tier: 'Weak',
          numReviews: 6,
          url: 'https://www.metacritic.com/game/obscure-gem/user-reviews/',
          isVerified: false,
          isSynthetic: true,
        },
      });
      vi.spyOn(steamReviewResolver, 'resolveScore').mockResolvedValue({
        id: 999111,
        source: 'steam',
        score: 88,
        tier: 'Mighty',
        numReviews: 1200,
        url: 'https://store.steampowered.com/app/999111',
        isVerified: false,
        isSynthetic: true,
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

      const res = await criticScoreService.resolveDynamicScore('Obscure Gem', 999111, 2023);
      expect(res).not.toBeNull();
      expect(res?.source).toBe('steam');
      expect(res?.score).toBe(88);
      expect(res?.numReviews).toBe(1200);
    });

    it('retains Tier 3 Metacritic User Score when numReviews >= 25 without downgrading to Tier 4 Steam', async () => {
      vi.spyOn(storefrontReviewHarvester, 'getStorefrontAnchor').mockResolvedValue(null);
      vi.spyOn(metacriticResolver, 'resolveMetacritic').mockResolvedValue({
        critic: null,
        user: {
          id: 'mc-user-solid',
          source: 'metacritic_user',
          score: 79,
          tier: 'Strong',
          numReviews: 42,
          url: 'https://www.metacritic.com/game/solid-game/user-reviews/',
          isVerified: false,
          isSynthetic: true,
        },
      });
      const steamSpy = vi.spyOn(steamReviewResolver, 'resolveScore').mockResolvedValue({
        id: 999222,
        source: 'steam',
        score: 85,
        tier: 'Mighty',
        numReviews: 5000,
        url: 'https://store.steampowered.com/app/999222',
        isVerified: false,
        isSynthetic: true,
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

      const res = await criticScoreService.resolveDynamicScore('Solid Game', 999222, 2023);
      expect(res).not.toBeNull();
      expect(res?.source).toBe('metacritic_user');
      expect(res?.score).toBe(79);
      expect(steamSpy).not.toHaveBeenCalled();
    });
  });

  describe('findBestHltbMatch Hardening', () => {
    it('rejects sequel mismatches ("Doom" vs "Doom II")', () => {
      const candidates = [
        { game_id: 2709, game_name: 'Doom II', comp_main: 18000 },
        { game_id: 2710, game_name: 'Doom 3', comp_main: 36000 },
      ];
      expect(findBestHltbMatch('Doom', candidates)).toBeNull();
    });

    it('rejects unrelated results[0] fallback when token similarity < 0.6', () => {
      const candidates = [
        { game_id: 9999, game_name: 'Completely Different Galaxies', comp_main: 36000 },
        { game_id: 8888, game_name: 'Prey for the Gods', comp_main: 25000 },
      ];
      expect(findBestHltbMatch('Prey', candidates)).toBeNull();
    });

    it('accepts valid exact and edition matches', () => {
      const candidates = [
        { game_id: 101, game_name: 'Cyberpunk 2077: Phantom Liberty', comp_main: 40000 },
        { game_id: 102, game_name: 'Cyberpunk 2077', comp_main: 93600 },
      ];
      const matchExact = findBestHltbMatch('Cyberpunk 2077', candidates);
      expect(matchExact?.game_id).toBe(102);

      const matchEdition = findBestHltbMatch('Cyberpunk 2077: Ultimate Edition', [
        { game_id: 102, game_name: 'Cyberpunk 2077', comp_main: 93600 },
      ]);
      expect(matchEdition?.game_id).toBe(102);
    });

    it('prefers exact edition match first, falls back to exact base match, and handles diacritics & trademarks', () => {
      const horizonCandidates = [
        { game_id: 201, game_name: 'Horizon Zero Dawn', comp_main: 108000 },
        { game_id: 202, game_name: 'Horizon Zero Dawn: Complete Edition', comp_main: 126000 },
      ];
      expect(
        findBestHltbMatch('Horizon Zero Dawn™ – Complete Edition', horizonCandidates)?.game_id
      ).toBe(202);

      const vanguardCandidates = [
        { game_id: 301, game_name: 'Call of Duty: Vanguard - Zombies', comp_main: 14400 },
        { game_id: 302, game_name: 'Call of Duty: Vanguard', comp_main: 21600 },
      ];
      expect(
        findBestHltbMatch('Call of Duty®: Vanguard - Standard Edition', vanguardCandidates)?.game_id
      ).toBe(302);

      expect(
        findBestHltbMatch('Brutal Legend', [{ game_id: 401, game_name: 'Brütal Legend', comp_main: 32400 }])
          ?.game_id
      ).toBe(401);
      expect(
        findBestHltbMatch('Pokémon Legends', [{ game_id: 402, game_name: 'Pokemon Legends', comp_main: 54000 }])
          ?.game_id
      ).toBe(402);
    });
  });

  describe('Wave 2: Trademark / Typography / Edition Multi-Pass Sanitization & Self-Healing', () => {
    it('strips trademarks and HTML entities BEFORE apostrophes & ligature/NFD folding without NFKC expansion', () => {
      expect(decodeTitleHtmlEntities('STAR WARS&trade; Jedi: Survivor&#8482; &amp; More')).toBe(
        'STAR WARS™ Jedi: Survivor™ & More'
      );
      expect(normalizeTitleKey('TEKKEN™ 8')).toBe('tekken 8');
      expect(normalizeTitleKey("Tony Hawk™'s Pro Skater™ 1 + 2")).toBe(
        'tony hawks pro skater 1 2'
      );
      expect(normalizeTitleKey('Watch Dogs®2')).toBe('watch dogs 2');
      expect(normalizeTitleKey('God of War Ragnarök')).toBe('god of war ragnarok');
      expect(normalizeTitleKey('Mørkredd')).toBe('morkredd');
      expect(normalizeTitleKey('Weiß & Æon')).toBe('weiss aeon');

      expect(toCanonicalMetacriticSlug('God of War Ragnarök™')).toBe('god-of-war-ragnarok');
      expect(toCanonicalMetacriticSlug("Tony Hawk™'s Pro Skater™ 1 + 2")).toBe(
        'tony-hawks-pro-skater-1-2'
      );
      expect(toCanonicalMetacriticSlug('Mørkredd')).toBe('morkredd');
    });

    it('builds identical deduplicated multi-pass HLTB search terms across TypeScript and Electron CJS', () => {
      expect(sanitizeTitleForSearchQuery('DOOM® (2016)')).toBe('DOOM 2016');
      expect(sanitizeTitleForSearchQuery('STAR WARS™ Battlefront II (Classic, 2005)')).toBe(
        'STAR WARS Battlefront II'
      );
      expect(sanitizeTitleForSearchQuery('Fallout: New Vegas - Amazon Prime')).toBe(
        'Fallout New Vegas'
      );
      expect(sanitizeTitleForSearchQuery('Battlefield™ V EA Play Edition')).toBe('Battlefield V');
      expect(sanitizeTitleForSearchQuery('Marvel’s Spider-Man™ (PC)')).toBe("Marvel's Spider-Man");

      const sampleTitles = [
        'Synthetic Obscure Arcade',
        'TEKKEN™ 8',
        'Call of Duty®: Vanguard - Standard Edition',
        'Marvel’s Spider-Man: Miles Morales - Ultimate Edition',
        'Horizon Zero Dawn™ – Complete Edition',
        'STAR WARS&trade; Battlefront II (Classic, 2005)',
        "Tony Hawk™'s Pro Skater™ 1 + 2",
      ];

      for (const title of sampleTitles) {
        expect(storeSyncIpc.buildHltbSearchTermPasses(title)).toEqual(
          buildHltbSearchTermPasses(title)
        );
      }

      // Clean title without edition/hyphen/subtitle produces exactly 1 pass
      expect(buildHltbSearchTermPasses('Synthetic Obscure Arcade')).toEqual([
        ['Synthetic', 'Obscure', 'Arcade'],
      ]);

      // Subtitle + edition title produces 3 progressive passes
      expect(buildHltbSearchTermPasses('Call of Duty®: Vanguard - Standard Edition')).toEqual([
        ['Call', 'of', 'Duty', 'Vanguard', 'Standard', 'Edition'],
        ['Call', 'of', 'Duty', 'Vanguard'],
        ['Call', 'of', 'Duty'],
      ]);
    });

    it('executes multi-pass HLTB fallback inside a single Electron IPC hltb:search call and refreshes 403 token once', async () => {
      const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
      storeSyncIpc.registerStoreSyncIpcHandlers({
        ipcMain: {
          handle: (channel, fn) => {
            handlers.set(channel, fn as (event: unknown, ...args: unknown[]) => Promise<unknown>);
          },
        },
        storeSync: {},
      });

      const hltbHandler = handlers.get('hltb:search');
      expect(hltbHandler).toBeDefined();

      const postedTermPasses: string[][] = [];
      let searchAttempt = 0;
      const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/search/site/init')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ token: 'tok-fresh' }),
          };
        }
        if (url.includes('/api/search/site')) {
          searchAttempt += 1;
          if (searchAttempt === 1) {
            return { ok: false, status: 403, json: async () => ({}) };
          }
          const body = JSON.parse(String(init?.body || '{}')) as { searchTerms?: string[] };
          postedTermPasses.push(body.searchTerms || []);
          // Pass 1 (with Standard Edition) returns empty; Pass 2 (edition-stripped) returns match!
          if ((body.searchTerms || []).includes('Standard')) {
            return { ok: true, status: 200, json: async () => ({ data: [] }) };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ game_id: 96566, game_name: 'Call of Duty: Vanguard', comp_main: 21600 }],
            }),
          };
        }
        return { ok: false, status: 500 };
      });
      vi.stubGlobal('fetch', fetchMock);

      const ipcResult = (await hltbHandler!(
        {},
        'Call of Duty®: Vanguard - Standard Edition'
      )) as { success: boolean; data: Array<{ game_id: number }> };

      expect(ipcResult.success).toBe(true);
      expect(ipcResult.data).toHaveLength(1);
      expect(ipcResult.data[0]?.game_id).toBe(96566);
      // Pass 1 tried, Pass 2 succeeded, Pass 3 skipped!
      expect(postedTermPasses).toEqual([
        ['Call', 'of', 'Duty', 'Vanguard', 'Standard', 'Edition'],
        ['Call', 'of', 'Duty', 'Vanguard'],
      ]);
    });

    it('self-heals legacy v1 poisoned negative cache entries (norm + app_id) while preserving clean v1 negatives, v2 negatives, and legacy v1 positive keys', async () => {
      expect(wasCorruptedByLegacyV1HltbTokenizer('Synthetic Indie Mini')).toBe(false);
      expect(wasCorruptedByLegacyV1HltbTokenizer('Synthetic Obscure Arcade')).toBe(false);
      expect(wasCorruptedByLegacyV1HltbTokenizer('TEKKEN™ 8')).toBe(true);
      expect(wasCorruptedByLegacyV1HltbTokenizer('Marvel’s Spider-Man')).toBe(true);
      expect(wasCorruptedByLegacyV1HltbTokenizer('Horizon Zero Dawn – Complete Edition')).toBe(true);
      expect(wasCorruptedByLegacyV1HltbTokenizer('DOOM (2016)')).toBe(true);
      expect(wasCorruptedByLegacyV1HltbTokenizer('Fallout 76 (PC)')).toBe(true);

      const now = Date.now();
      const memStore = new Map<string, string>();
      const mockStorage: Storage = {
        get length() {
          return memStore.size;
        },
        clear: () => memStore.clear(),
        getItem: (k: string) => memStore.get(k) ?? null,
        key: (i: number) => Array.from(memStore.keys())[i] ?? null,
        removeItem: (k: string) => {
          memStore.delete(k);
        },
        setItem: (k: string, v: string) => {
          memStore.set(k, v);
        },
      };

      // Seed:
      // 1) Legacy v1 positive entry keyed as "death s door" (old non-alphanumeric space split)
      // 2) Legacy v1 poisoned negative entry for "TEKKEN™ 8" under BOTH "tekken 8" and "app_1778820"
      // 3) Legacy v1 clean negative entry for "Synthetic Indie Mini" (must NOT be invalidated)
      // 4) Version 2 negative entry for "Unlisted Trademark Title™" (must NOT re-fetch)
      mockStorage.setItem(
        'one_launcher_hltb_lru_v3',
        JSON.stringify({
          'death s door': {
            mainStoryHours: 9,
            mainExtraHours: 12,
            completionistHours: 15.5,
            allStylesHours: 11,
            isAccurate: true,
            cachedAt: now,
          },
          'tekken 8': {
            mainStoryHours: 0,
            mainExtraHours: 0,
            completionistHours: 0,
            allStylesHours: 0,
            isAccurate: false,
            unmatched: true,
            cachedAt: now,
          },
          app_1778820: {
            mainStoryHours: 0,
            mainExtraHours: 0,
            completionistHours: 0,
            allStylesHours: 0,
            isAccurate: false,
            unmatched: true,
            cachedAt: now,
          },
          'synthetic indie mini': {
            mainStoryHours: 0,
            mainExtraHours: 0,
            completionistHours: 0,
            allStylesHours: 0,
            isAccurate: false,
            unmatched: true,
            cachedAt: now,
          },
          'unlisted trademark title': {
            mainStoryHours: 0,
            mainExtraHours: 0,
            completionistHours: 0,
            allStylesHours: 0,
            isAccurate: false,
            unmatched: true,
            cachedAt: now,
            queryNormVersion: HLTB_QUERY_NORM_VERSION,
          },
        })
      );

      const searchHltbMock = vi.fn().mockImplementation(async (query: string) => {
        if (query.includes('TEKKEN')) {
          return {
            success: true,
            data: [{ game_id: 113507, game_name: 'Tekken 8', comp_main: 14400, comp_all: 36000 }],
          };
        }
        // Simulate Pass 1 returning unrelated soundtrack noise, Pass 2 stripped returning real game
        if (query === 'Dishonored® - Definitive Edition') {
          return {
            success: true,
            data: [{ game_id: 999991, game_name: 'Completely Unrelated Soundtrack', comp_main: 3600 }],
          };
        }
        if (query === 'dishonored') {
          return {
            success: true,
            data: [{ game_id: 2602, game_name: 'Dishonored', comp_main: 43200, comp_all: 61200 }],
          };
        }
        return { success: true, data: [] };
      });

      const prevWindow = (globalThis as { window?: unknown }).window;
      const prevLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
      try {
        Object.defineProperty(globalThis, 'localStorage', {
          value: mockStorage,
          configurable: true,
          writable: true,
        });
        Object.defineProperty(globalThis, 'window', {
          value: {
            localStorage: mockStorage,
            location: { hostname: 'localhost' },
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
            electronAPI: { searchHltb: searchHltbMock },
          },
          configurable: true,
          writable: true,
        });

        vi.resetModules();
        const freshHltb = await import('../src/services/hltb/howLongToBeat');

        // 1. Legacy v1 positive entry ("death s door") hits immediately for "Death's Door"
        expect(freshHltb.getHowLongToBeat("Death's Door")?.mainStoryHours).toBe(9);
        expect(freshHltb.hasAttemptedHltbLookup("Death's Door")).toBe(true);

        // 2. Clean v1 negative entry ("Synthetic Indie Mini") & v2 negative entry stay valid
        expect(freshHltb.hasAttemptedHltbLookup('Synthetic Indie Mini')).toBe(true);
        expect(freshHltb.hasAttemptedHltbLookup('Unlisted Trademark Title™')).toBe(true);

        // 3. Poisoned v1 negative entry ("TEKKEN™ 8" + app_1778820) self-heals and re-fetches cleanly!
        expect(freshHltb.hasAttemptedHltbLookup('TEKKEN™ 8', 1778820)).toBe(false);
        const healedTekken = await freshHltb.fetchAndCacheHltb('TEKKEN™ 8', 1778820);
        expect(healedTekken?.mainStoryHours).toBe(4);
        expect(healedTekken?.hltbGameId).toBe(113507);
        expect(freshHltb.getHowLongToBeat('TEKKEN™ 8', 1778820)?.mainStoryHours).toBe(4);

        // 4. Single stripped fallback fires when Pass 1 returned non-empty noise rejected by findBestHltbMatch
        const healedDishonored = await freshHltb.fetchAndCacheHltb(
          'Dishonored® - Definitive Edition',
          205100
        );
        expect(healedDishonored?.mainStoryHours).toBe(12);
        expect(searchHltbMock).toHaveBeenCalledWith('Dishonored® - Definitive Edition');
        expect(searchHltbMock).toHaveBeenCalledWith('dishonored');
      } finally {
        if (prevWindow === undefined) {
          delete (globalThis as { window?: unknown }).window;
        } else {
          Object.defineProperty(globalThis, 'window', {
            value: prevWindow,
            configurable: true,
            writable: true,
          });
        }
        if (prevLocalStorage === undefined) {
          delete (globalThis as { localStorage?: unknown }).localStorage;
        } else {
          Object.defineProperty(globalThis, 'localStorage', {
            value: prevLocalStorage,
            configurable: true,
            writable: true,
          });
        }
        // Keep static imports referenced so noUnusedLocals stays satisfied
        expect(typeof fetchAndCacheHltb).toBe('function');
        expect(typeof getHowLongToBeat).toBe('function');
        expect(typeof hasAttemptedHltbLookup).toBe('function');
      }
    });
  });

  describe('Wave 3A: Hermetic Dual-OS HLTB Symbol/Edition Matrix, Vault Self-Heal & Cross-Storefront Normalizers', () => {
    it('resolves the full 16-title real-world symbol/punctuation/edition matrix across TS + CJS buildHltbSearchTermPasses and findBestHltbMatch on darwin and win32', async () => {
      const matrix: Array<{
        rawTitle: string;
        expectedPasses: string[][];
        canonicalCandidate: HltbSearchResultItem;
        sequelDistractor: HltbSearchResultItem;
      }> = [
        {
          rawTitle: 'BioShock™',
          expectedPasses: [['BioShock']],
          canonicalCandidate: { game_id: 1065, game_name: 'BioShock', comp_main: 43200 },
          sequelDistractor: { game_id: 1066, game_name: 'BioShock 2', comp_main: 39600 },
        },
        {
          rawTitle: 'DARK SOULS™ III',
          expectedPasses: [['DARK', 'SOULS', 'III']],
          canonicalCandidate: { game_id: 26803, game_name: 'Dark Souls III', comp_main: 115200 },
          sequelDistractor: { game_id: 2125, game_name: 'Dark Souls II', comp_main: 129600 },
        },
        {
          rawTitle: 'STAR WARS Jedi: Survivor™',
          expectedPasses: [
            ['STAR', 'WARS', 'Jedi', 'Survivor'],
            ['STAR', 'WARS', 'Jedi'],
          ],
          canonicalCandidate: {
            game_id: 108358,
            game_name: 'Star Wars Jedi: Survivor',
            comp_main: 72000,
          },
          sequelDistractor: {
            game_id: 999901,
            game_name: 'Star Wars Jedi: Survivor 2',
            comp_main: 72000,
          },
        },
        {
          rawTitle: 'Diablo® IV',
          expectedPasses: [['Diablo', 'IV']],
          canonicalCandidate: { game_id: 71960, game_name: 'Diablo IV', comp_main: 93600 },
          sequelDistractor: { game_id: 2515, game_name: 'Diablo III', comp_main: 64800 },
        },
        {
          rawTitle: "Tony Hawk™'s Pro Skater™ 1 + 2",
          expectedPasses: [['Tony', "Hawk's", 'Pro', 'Skater', '1', '2']],
          canonicalCandidate: {
            game_id: 78305,
            game_name: "Tony Hawk's Pro Skater 1 + 2",
            comp_main: 36000,
          },
          sequelDistractor: {
            game_id: 9453,
            game_name: "Tony Hawk's Pro Skater 2",
            comp_main: 25200,
          },
        },
        {
          rawTitle: 'Tom Clancy’s The Division 2',
          expectedPasses: [['Tom', "Clancy's", 'The', 'Division', '2']],
          canonicalCandidate: {
            game_id: 57479,
            game_name: "Tom Clancy's The Division 2",
            comp_main: 93600,
          },
          sequelDistractor: {
            game_id: 20073,
            game_name: "Tom Clancy's The Division",
            comp_main: 75600,
          },
        },
        {
          rawTitle: 'CRISIS CORE –FINAL FANTASY VII– REUNION',
          expectedPasses: [['CRISIS', 'CORE', 'FINAL', 'FANTASY', 'VII', 'REUNION']],
          canonicalCandidate: {
            game_id: 109432,
            game_name: 'Crisis Core: Final Fantasy VII Reunion',
            comp_main: 64800,
          },
          sequelDistractor: {
            game_id: 109434,
            game_name: 'Final Fantasy VII Rebirth',
            comp_main: 169200,
          },
        },
        {
          rawTitle: 'Watch_Dogs® 2',
          expectedPasses: [['Watch', 'Dogs', '2']],
          canonicalCandidate: { game_id: 37861, game_name: 'Watch Dogs 2', comp_main: 68400 },
          sequelDistractor: { game_id: 11101, game_name: 'Watch Dogs', comp_main: 64800 },
        },
        {
          rawTitle: 'Call of Duty®: Vanguard - Standard Edition',
          expectedPasses: [
            ['Call', 'of', 'Duty', 'Vanguard', 'Standard', 'Edition'],
            ['Call', 'of', 'Duty', 'Vanguard'],
            ['Call', 'of', 'Duty'],
          ],
          canonicalCandidate: {
            game_id: 96566,
            game_name: 'Call of Duty: Vanguard',
            comp_main: 21600,
          },
          sequelDistractor: {
            game_id: 108882,
            game_name: 'Call of Duty: Modern Warfare II',
            comp_main: 28800,
          },
        },
        {
          rawTitle: 'The Sims™ 4 EA Play Edition',
          expectedPasses: [['The', 'Sims', '4']],
          canonicalCandidate: { game_id: 21265, game_name: 'The Sims 4', comp_main: 126000 },
          sequelDistractor: { game_id: 9616, game_name: 'The Sims 3', comp_main: 162000 },
        },
        {
          rawTitle: 'Subnautica™ (PC)',
          expectedPasses: [['Subnautica']],
          canonicalCandidate: { game_id: 23740, game_name: 'Subnautica', comp_main: 108000 },
          sequelDistractor: { game_id: 999902, game_name: 'Subnautica 2', comp_main: 90000 },
        },
        {
          rawTitle: 'DOOM (2016)',
          expectedPasses: [['DOOM', '2016']],
          canonicalCandidate: { game_id: 2708, game_name: 'DOOM (2016)', comp_main: 41400 },
          sequelDistractor: { game_id: 1491, game_name: 'DOOM (1993)', comp_main: 18000 },
        },
        {
          rawTitle: 'God of War Ragnarök™',
          expectedPasses: [['God', 'of', 'War', 'Ragnarok']],
          canonicalCandidate: {
            game_id: 83146,
            game_name: 'God of War Ragnarök',
            comp_main: 95400,
          },
          sequelDistractor: { game_id: 4039, game_name: 'God of War II', comp_main: 43200 },
        },
        {
          rawTitle: 'Mørkredd',
          expectedPasses: [['Morkredd']],
          canonicalCandidate: { game_id: 86522, game_name: 'Mørkredd', comp_main: 12600 },
          sequelDistractor: {
            game_id: 999903,
            game_name: 'Unrelated Nordic Puzzle',
            comp_main: 7200,
          },
        },
        {
          rawTitle: 'BioShock&trade;',
          expectedPasses: [['BioShock']],
          canonicalCandidate: { game_id: 1065, game_name: 'BioShock', comp_main: 43200 },
          sequelDistractor: { game_id: 1066, game_name: 'BioShock 2', comp_main: 39600 },
        },
        {
          rawTitle: 'TEKKEN(TM) 8',
          expectedPasses: [['TEKKEN', '8']],
          canonicalCandidate: { game_id: 113507, game_name: 'Tekken 8', comp_main: 14400 },
          sequelDistractor: { game_id: 46226, game_name: 'Tekken 7', comp_main: 12600 },
        },
      ];

      expect(stripTrademarkSymbols('TEKKEN(TM) 8')).toBe('TEKKEN 8');
      expect(foldLatinLigaturesAndDiacritics('God of War Ragnarök & Mørkredd')).toBe(
        'God of War Ragnarok & Morkredd'
      );

      const originalPlatform = process.platform;
      try {
        for (const targetOs of ['darwin', 'win32'] as const) {
          Object.defineProperty(process, 'platform', {
            value: targetOs,
            configurable: true,
          });

          for (const entry of matrix) {
            const tsPasses = buildHltbSearchTermPasses(entry.rawTitle);
            const cjsPasses = storeSyncIpc.buildHltbSearchTermPasses(entry.rawTitle);

            expect(tsPasses).toEqual(entry.expectedPasses);
            expect(cjsPasses).toEqual(tsPasses);
            expect(wasCorruptedByLegacyV1HltbTokenizer(entry.rawTitle)).toBe(true);

            for (const pass of tsPasses) {
              expect(pass.length).toBeGreaterThan(0);
              for (const token of pass) {
                expect(token).not.toMatch(/[™®©℠℗_()[\]]/);
                expect(token).not.toMatch(/&[a-z0-9#]+;/i);
                expect(token).not.toMatch(/[^\x00-\x7f]/);
              }
            }

            // Canonical candidate wins over sequel/unrelated distractor
            const matched = findBestHltbMatch(entry.rawTitle, [
              entry.sequelDistractor,
              entry.canonicalCandidate,
            ]);
            expect(matched?.game_id).toBe(entry.canonicalCandidate.game_id);

            // Distractor alone is cleanly rejected
            expect(findBestHltbMatch(entry.rawTitle, [entry.sequelDistractor])).toBeNull();
          }

          // Multi-candidate subtitle disambiguation when base prefix shares franchise words
          expect(
            findBestHltbMatch('STAR WARS Jedi: Survivor™', [
              { game_id: 60345, game_name: 'Star Wars Jedi: Fallen Order', comp_main: 61200 },
              { game_id: 108358, game_name: 'Star Wars Jedi: Survivor', comp_main: 72000 },
            ])?.game_id
          ).toBe(108358);

          expect(
            findBestHltbMatch('Subnautica™ (PC)', [
              { game_id: 59555, game_name: 'Subnautica: Below Zero', comp_main: 46800 },
              { game_id: 23740, game_name: 'Subnautica', comp_main: 108000 },
            ])?.game_id
          ).toBe(23740);
        }

        // Verify Electron IPC hltb:search base-word filter skips Pass 1 noise lacking shared base words
        const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
        storeSyncIpc.registerStoreSyncIpcHandlers({
          ipcMain: {
            handle: (channel, fn) => {
              handlers.set(channel, fn as (event: unknown, ...args: unknown[]) => Promise<unknown>);
            },
          },
          storeSync: {},
        });
        const hltbHandler = handlers.get('hltb:search')!;
        const seenPasses: string[][] = [];
        vi.stubGlobal(
          'fetch',
          vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.includes('/api/search/site/init')) {
              return { ok: true, status: 200, json: async () => ({ token: 'tok-matrix' }) };
            }
            const parsedBody = JSON.parse(String(init?.body || '{}')) as { searchTerms?: string[] };
            const terms = parsedBody.searchTerms || [];
            seenPasses.push(terms);
            if (terms.includes('Standard')) {
              // Non-empty noise sharing zero base words with "Call of Duty" -> must advance to Pass 2!
              return {
                ok: true,
                status: 200,
                json: async () => ({
                  data: [{ game_id: 888888, game_name: 'Unrelated Kart Trivia', comp_main: 3600 }],
                }),
              };
            }
            return {
              ok: true,
              status: 200,
              json: async () => ({
                data: [{ game_id: 96566, game_name: 'Call of Duty: Vanguard', comp_main: 21600 }],
              }),
            };
          })
        );

        const ipcRes = (await hltbHandler(
          {},
          'Call of Duty®: Vanguard - Standard Edition'
        )) as { success: boolean; data: Array<{ game_id: number }> };
        expect(ipcRes.success).toBe(true);
        expect(ipcRes.data[0]?.game_id).toBe(96566);
        expect(seenPasses).toEqual([
          ['Call', 'of', 'Duty', 'Vanguard', 'Standard', 'Edition'],
          ['Call', 'of', 'Duty', 'Vanguard'],
        ]);
      } finally {
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
      }
    });

    it('self-heals poisoned v1 negative entries for "bioshock" + "app_7670" across BOTH one_launcher_hltb_lru_v3 AND IndexedDB vault hltb_lru_v3 while enforcing the 5,000-entry LRU capacity', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      const mockStorage = createMemoryStorage();
      const vaultStoreMap = new Map<string, unknown>();

      const poisonedNegativeRecord = {
        mainStoryHours: 0,
        mainExtraHours: 0,
        completionistHours: 0,
        allStylesHours: 0,
        isAccurate: false,
        unmatched: true,
        cachedAt: now,
      };

      const initialCachePayload: Record<string, unknown> = {
        bioshock: { ...poisonedNegativeRecord },
        app_7670: { ...poisonedNegativeRecord },
        'synthetic indie mini': { ...poisonedNegativeRecord },
        'bioshock infinite': {
          mainStoryHours: 11.5,
          mainExtraHours: 14.5,
          completionistHours: 26,
          allStylesHours: 13,
          hltbGameId: 1067,
          isAccurate: true,
          cachedAt: now,
        },
      };

      // Seed BOTH localStorage (`one_launcher_hltb_lru_v3`) AND IndexedDB vault (`hltb_lru_v3`)
      mockStorage.setItem('one_launcher_hltb_lru_v3', JSON.stringify(initialCachePayload));
      vaultStoreMap.set('hltb_lru_v3', {
        bioshock: { ...poisonedNegativeRecord, cachedAt: now + 10 },
        app_7670: { ...poisonedNegativeRecord, cachedAt: now + 10 },
      });

      const searchHltbMock = vi.fn().mockImplementation(async (query: string) => {
        if (query === 'BioShock™') {
          return {
            success: true,
            data: [
              {
                game_id: 1065,
                game_name: 'BioShock',
                game_type: 'game',
                comp_main: 43200,
                comp_plus: 54000,
                comp_100: 79200,
                comp_all: 50400,
              },
            ],
          };
        }
        return { success: true, data: [] };
      });

      const prevWindow = (globalThis as { window?: unknown }).window;
      const prevLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

      try {
        Object.defineProperty(globalThis, 'localStorage', {
          value: mockStorage,
          configurable: true,
          writable: true,
        });
        Object.defineProperty(globalThis, 'window', {
          value: {
            localStorage: mockStorage,
            location: { hostname: 'localhost' },
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
            electronAPI: { searchHltb: searchHltbMock },
          },
          configurable: true,
          writable: true,
        });

        vi.resetModules();
        vi.doMock('../src/services/storage/indexedDbVault', () => ({
          isIndexedDbAvailable: () => true,
          vaultGet: vi.fn(async (key: string) => vaultStoreMap.get(key)),
          vaultSet: vi.fn(async (key: string, val: unknown) => {
            vaultStoreMap.set(key, val);
            return true;
          }),
          vaultDelete: vi.fn(async (key: string) => {
            vaultStoreMap.delete(key);
            return true;
          }),
        }));

        const healedHltbMod = await import('../src/services/hltb/howLongToBeat');
        // Allow async hydrateHltbCacheFromVault() to merge IndexedDB `hltb_lru_v3`
        await Promise.resolve();
        await Promise.resolve();

        // 1. Poisoned `"bioshock"` + `"app_7670"` from BOTH localStorage & IndexedDB vault self-heals!
        expect(healedHltbMod.hasAttemptedHltbLookup('BioShock™', 7670)).toBe(false);
        const healedBioShock = await healedHltbMod.fetchAndCacheHltb('BioShock™', 7670);
        expect(healedBioShock).toMatchObject({
          mainStoryHours: 12,
          mainExtraHours: 15,
          completionistHours: 22,
          allStylesHours: 14,
          hltbGameId: 1065,
          isAccurate: true,
        });
        expect(searchHltbMock).toHaveBeenCalledTimes(1);
        expect(searchHltbMock).toHaveBeenCalledWith('BioShock™');

        // Flush the 150ms persistence debounce so both localStorage and IndexedDB vault are updated
        await vi.advanceTimersByTimeAsync(200);

        const persistedLocal = JSON.parse(
          mockStorage.getItem('one_launcher_hltb_lru_v3') || '{}'
        ) as Record<string, { isAccurate?: boolean; unmatched?: boolean; mainStoryHours?: number }>;
        const persistedVault = (vaultStoreMap.get('hltb_lru_v3') || {}) as Record<
          string,
          { isAccurate?: boolean; unmatched?: boolean; mainStoryHours?: number }
        >;

        expect(persistedLocal.bioshock?.isAccurate).toBe(true);
        expect(persistedLocal.bioshock?.unmatched).toBeUndefined();
        expect(persistedLocal.bioshock?.mainStoryHours).toBe(12);
        expect(persistedLocal.app_7670?.isAccurate).toBe(true);
        expect(persistedLocal.app_7670?.mainStoryHours).toBe(12);

        expect(persistedVault.bioshock?.isAccurate).toBe(true);
        expect(persistedVault.bioshock?.mainStoryHours).toBe(12);
        expect(persistedVault.app_7670?.isAccurate).toBe(true);
        expect(persistedVault.app_7670?.mainStoryHours).toBe(12);

        // 2. Clean v1 negative entry ("Synthetic Indie Mini") stays cached with ZERO network calls
        searchHltbMock.mockClear();
        expect(healedHltbMod.hasAttemptedHltbLookup('Synthetic Indie Mini')).toBe(true);
        expect(await healedHltbMod.fetchAndCacheHltb('Synthetic Indie Mini')).toBeNull();
        expect(searchHltbMock).not.toHaveBeenCalled();

        // 3. Existing positive entry ("BioShock Infinite") remains intact
        expect(healedHltbMod.getHowLongToBeat('BioShock Infinite')?.mainStoryHours).toBe(11.5);

        // 4. Verify MAX_HLTB_CACHE_ENTRIES = 5000 bounded LRU eviction
        const lruSeed: Record<string, unknown> = {};
        for (let i = 0; i < 5005; i += 1) {
          lruSeed[`synthetic lru ${i}`] = {
            mainStoryHours: i + 1,
            mainExtraHours: i + 2,
            completionistHours: i + 3,
            allStylesHours: i + 1,
            isAccurate: true,
            cachedAt: now + i,
          };
        }
        mockStorage.setItem('one_launcher_hltb_lru_v3', JSON.stringify(lruSeed));
        vaultStoreMap.clear();

        vi.resetModules();
        const capHltbMod = await import('../src/services/hltb/howLongToBeat');
        // Oldest 5 entries (0..4) evicted; entries 5..5004 (exactly 5,000 entries, > legacy 2,500) retained!
        expect(capHltbMod.getHowLongToBeat('Synthetic LRU 0')).toBeNull();
        expect(capHltbMod.getHowLongToBeat('Synthetic LRU 4')).toBeNull();
        expect(capHltbMod.getHowLongToBeat('Synthetic LRU 5')?.mainStoryHours).toBe(6);
        expect(capHltbMod.getHowLongToBeat('Synthetic LRU 3500')?.mainStoryHours).toBe(3501);
        expect(capHltbMod.getHowLongToBeat('Synthetic LRU 5004')?.mainStoryHours).toBe(5005);
      } finally {
        vi.doUnmock('../src/services/storage/indexedDbVault');
        vi.useRealTimers();
        if (prevWindow === undefined) {
          delete (globalThis as { window?: unknown }).window;
        } else {
          Object.defineProperty(globalThis, 'window', {
            value: prevWindow,
            configurable: true,
            writable: true,
          });
        }
        if (prevLocalStorage === undefined) {
          delete (globalThis as { localStorage?: unknown }).localStorage;
        } else {
          Object.defineProperty(globalThis, 'localStorage', {
            value: prevLocalStorage,
            configurable: true,
            writable: true,
          });
        }
      }
    });

    it('hydrates HowLongToBeatCard from SQLite OfflineVaultService without network traffic, persists live fetches via saveGameDetail on darwin + win32, and sanitizes fallback HLTB search URLs', async () => {
      const originalPlatform = process.platform;
      const prevWindow = (globalThis as { window?: unknown }).window;
      const prevLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
      const mockStorage = createMemoryStorage();
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'one-launcher-hltb-vault-'));

      try {
        Object.defineProperty(globalThis, 'localStorage', {
          value: mockStorage,
          configurable: true,
          writable: true,
        });

        for (const targetOs of ['darwin', 'win32'] as const) {
          Object.defineProperty(process, 'platform', {
            value: targetOs,
            configurable: true,
          });

          const vaultDir = path.join(tempRoot, targetOs);
          fs.mkdirSync(vaultDir, { recursive: true });
          const vault = offlineVaultMod.createOfflineVaultService({ userDataDir: vaultDir });

          try {
            const searchHltbMock = vi.fn().mockImplementation(async (query: string) => {
              if (query.includes('BioShock')) {
                return {
                  success: true,
                  data: [
                    {
                      game_id: 1065,
                      game_name: 'BioShock',
                      game_type: 'game',
                      comp_main: 43200,
                      comp_plus: 54000,
                      comp_100: 79200,
                      comp_all: 50400,
                    },
                  ],
                };
              }
              if (query.includes('Diablo')) {
                return {
                  success: true,
                  data: [
                    {
                      game_id: 71960,
                      game_name: 'Diablo IV',
                      game_type: 'game',
                      comp_main: 43200,
                      comp_plus: 54000,
                      comp_100: 79200,
                      comp_all: 50400,
                    },
                  ],
                };
              }
              return { success: true, data: [] };
            });

            const saveGameDetailSpy = vi.fn(async (payload: Record<string, unknown>) =>
              vault.saveGameDetail(payload)
            );

            Object.defineProperty(globalThis, 'window', {
              value: {
                localStorage: mockStorage,
                location: { hostname: 'localhost' },
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                dispatchEvent: vi.fn(),
                electronAPI: {
                  searchHltb: searchHltbMock,
                  offlineVault: {
                    saveGameDetail: saveGameDetailSpy,
                  },
                },
              },
              configurable: true,
              writable: true,
            });

            // 1) Pre-seeded SQLite OfflineVaultService `hltb` renders HowLongToBeatCard immediately with 0 network calls
            vault.saveGameDetail({
              gameId: `steam-409710-${targetOs}`,
              steamAppId: 409710,
              canonicalTitle: 'BioShock™ Remastered',
              hltb: {
                mainStoryHours: 10.5,
                mainExtraHours: 14,
                completionistHours: 21,
                allStylesHours: 13,
                hltbGameId: 39864,
                isAccurate: true,
              },
            });
            const hydratedDetail = vault.getGameDetail(`steam-409710-${targetOs}`);
            expect(hydratedDetail?.hltb?.mainStoryHours).toBe(10.5);

            const hydratedCard = createDomain12DeepRenderer(HowLongToBeatCard, {
              gameId: `steam-409710-${targetOs}`,
              gameTitle: 'BioShock™ Remastered',
              appId: 409710,
              hltb: hydratedDetail?.hltb ?? undefined,
            });
            const hydratedTree = hydratedCard.render();
            const hydratedText = getTextContent(hydratedTree);
            expect(hydratedText).toContain('Verified');
            expect(hydratedText).toContain('10½h');
            expect(hydratedText).toContain('14h');
            expect(hydratedText).toContain('21h');
            expect(searchHltbMock).not.toHaveBeenCalled();
            const hydratedLinks = findElements(hydratedTree, (el) => el.type === 'a');
            expect(hydratedLinks[0]?.props?.href).toBe('https://howlongtobeat.com/game/39864');
            hydratedCard.unmount();

            // 2) Uncached live HLTB fetch persists durably to SQLite via offlineVault.saveGameDetail
            const liveTitle = targetOs === 'darwin' ? 'BioShock™' : 'Diablo® IV';
            const liveAppId = targetOs === 'darwin' ? 7670 : 2344520;
            const expectedHltbId = targetOs === 'darwin' ? 1065 : 71960;
            const expectedFallbackHref =
              targetOs === 'darwin'
                ? 'https://howlongtobeat.com/?q=BioShock'
                : 'https://howlongtobeat.com/?q=Diablo%20IV';
            const liveGameId = `steam-${liveAppId}`;

            const liveCard = createDomain12DeepRenderer(HowLongToBeatCard, {
              gameId: liveGameId,
              gameTitle: liveTitle,
              appId: liveAppId,
            });

            // Initial render runs effect -> sets isLoading=true; second render shows Fetching... with sanitized fallback URL
            liveCard.render();
            const loadingTree = liveCard.render();
            const loadingLinks = findElements(loadingTree, (el) => el.type === 'a');
            expect(loadingLinks[0]?.props?.href).toBe(expectedFallbackHref);

            // Flush async searchHltb + saveGameDetail promise chain
            await new Promise((resolve) => setTimeout(resolve, 15));
            const resolvedTree = liveCard.render();
            const resolvedText = getTextContent(resolvedTree);
            expect(resolvedText).toContain('Verified');
            expect(resolvedText).toContain('12h');
            expect(resolvedText).toContain('15h');
            expect(resolvedText).toContain('22h');
            expect(saveGameDetailSpy).toHaveBeenCalledWith(
              expect.objectContaining({
                gameId: liveGameId,
                steamAppId: liveAppId,
                canonicalTitle: liveTitle,
                hltb: expect.objectContaining({
                  mainStoryHours: 12,
                  completionistHours: 22,
                  hltbGameId: expectedHltbId,
                  isAccurate: true,
                }),
              })
            );

            // Confirm durable SQLite row round-trip in OfflineVaultService
            const sqlitePersisted = vault.getGameDetail(liveGameId);
            expect(sqlitePersisted?.hltb).toMatchObject({
              mainStoryHours: 12,
              mainExtraHours: 15,
              completionistHours: 22,
              allStylesHours: 14,
              hltbGameId: expectedHltbId,
              isAccurate: true,
            });
            liveCard.unmount();

            // 3) Fallback `/?q=...` URL strips trademarks, editions, diacritics, and platform tags
            const fallbackCard = createDomain12DeepRenderer(HowLongToBeatCard, {
              gameId: `xbox-subnautica-${targetOs}`,
              gameTitle: 'Subnautica™ (PC)',
              hltb: {
                mainStoryHours: 30,
                mainExtraHours: 45,
                completionistHours: 60,
                allStylesHours: 42,
                isAccurate: true,
              },
            });
            const fallbackTree = fallbackCard.render();
            const fallbackAnchors = findElements(fallbackTree, (el) => el.type === 'a');
            expect(fallbackAnchors[0]?.props?.href).toBe(
              'https://howlongtobeat.com/?q=Subnautica'
            );
            fallbackCard.unmount();

            const eaFallbackCard = createDomain12DeepRenderer(HowLongToBeatCard, {
              gameId: `ea-sims4-${targetOs}`,
              gameTitle: 'The Sims™ 4 EA Play Edition',
              hltb: {
                mainStoryHours: 35,
                mainExtraHours: 80,
                completionistHours: 140,
                allStylesHours: 65,
                isAccurate: true,
              },
            });
            const eaAnchors = findElements(eaFallbackCard.render(), (el) => el.type === 'a');
            expect(eaAnchors[0]?.props?.href).toBe('https://howlongtobeat.com/?q=The%20Sims%204');
            eaFallbackCard.unmount();
          } finally {
            vault.shutdown();
          }
        }
      } finally {
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
        if (prevWindow === undefined) {
          delete (globalThis as { window?: unknown }).window;
        } else {
          Object.defineProperty(globalThis, 'window', {
            value: prevWindow,
            configurable: true,
            writable: true,
          });
        }
        if (prevLocalStorage === undefined) {
          delete (globalThis as { localStorage?: unknown }).localStorage;
        } else {
          Object.defineProperty(globalThis, 'localStorage', {
            value: prevLocalStorage,
            configurable: true,
            writable: true,
          });
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('debounces GameHoverPopout lazy HLTB hydration by 180ms on hover and cancels cleanly on early mouseout', async () => {
      vi.useFakeTimers();
      const prevWindow = (globalThis as { window?: unknown }).window;
      const prevLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
      const mockStorage = createMemoryStorage();

      const HoverPopoutHost: React.FC<RenderGameHoverPopoutArgs> = (props) =>
        renderGameHoverPopout(props);

      const searchHltbMock = vi.fn().mockImplementation(async (query: string) => {
        if (query === 'God of War Ragnarök™') {
          return {
            success: true,
            data: [
              {
                game_id: 83146,
                game_name: 'God of War Ragnarök',
                game_type: 'game',
                comp_main: 95400,
                comp_plus: 140400,
                comp_100: 194400,
                comp_all: 129600,
              },
            ],
          };
        }
        return { success: true, data: [] };
      });
      const saveGameDetailMock = vi.fn().mockResolvedValue({ success: true });

      try {
        Object.defineProperty(globalThis, 'localStorage', {
          value: mockStorage,
          configurable: true,
          writable: true,
        });
        Object.defineProperty(globalThis, 'window', {
          value: {
            localStorage: mockStorage,
            location: { hostname: 'localhost' },
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
            electronAPI: {
              searchHltb: searchHltbMock,
              offlineVault: { saveGameDetail: saveGameDetailMock },
            },
          },
          configurable: true,
          writable: true,
        });

        const basePopoutProps = {
          previewPos: { x: 100, y: 120, align: 'left' as const },
          popoutRef: { current: null },
          userOverridesMap: {},
          connectedSet: new Set(['steam'] as const),
          dynamicBlurb: null,
          hoverHeaderFailed: false,
          onSetHoverHeaderFailed: vi.fn(),
          onPopoutMouseEnter: vi.fn(),
          onPopoutMouseLeave: vi.fn(),
          onSelectGame: vi.fn(),
          onContextMenu: vi.fn(),
        };

        // 1) Transient hover unmounted at 120ms (< 180ms) cancels the timer with ZERO HLTB traffic
        const transientGame = makeCanonicalGameFixture({
          id: 'steam-374320',
          title: 'DARK SOULS™ III',
          steamAppId: 374320,
          platforms: [{ platformId: 'steam', platformGameId: '374320', installed: true }],
        });
        const transientPopout = createDomain12DeepRenderer(HoverPopoutHost, {
          ...basePopoutProps,
          hoveredGame: transientGame,
        });
        transientPopout.render();
        await vi.advanceTimersByTimeAsync(120);
        expect(searchHltbMock).not.toHaveBeenCalled();
        transientPopout.unmount();
        await vi.advanceTimersByTimeAsync(500);
        expect(searchHltbMock).not.toHaveBeenCalled();

        // 2) Sustained hover (>= 180ms) fires lazy HLTB hydration, persists to offlineVault, and renders hours
        const sustainedGame = makeCanonicalGameFixture({
          id: 'steam-2322010',
          title: 'God of War Ragnarök™',
          steamAppId: 2322010,
          platforms: [{ platformId: 'steam', platformGameId: '2322010', installed: true }],
        });
        const sustainedPopout = createDomain12DeepRenderer(HoverPopoutHost, {
          ...basePopoutProps,
          hoveredGame: sustainedGame,
        });
        sustainedPopout.render();

        await vi.advanceTimersByTimeAsync(150);
        expect(searchHltbMock).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(35);
        await Promise.resolve();
        await Promise.resolve();

        expect(searchHltbMock).toHaveBeenCalledTimes(1);
        expect(searchHltbMock).toHaveBeenCalledWith('God of War Ragnarök™');
        expect(saveGameDetailMock).toHaveBeenCalledWith(
          expect.objectContaining({
            gameId: 'steam-2322010',
            steamAppId: 2322010,
            canonicalTitle: 'God of War Ragnarök™',
            hltb: expect.objectContaining({
              mainStoryHours: 26.5,
              completionistHours: 54,
              hltbGameId: 83146,
              isAccurate: true,
            }),
          })
        );

        const hydratedPopoutText = getTextContent(sustainedPopout.render());
        expect(hydratedPopoutText).toContain('HowLongToBeat');
        expect(hydratedPopoutText).toContain('26½h');
        expect(hydratedPopoutText).toContain('54h');
        sustainedPopout.unmount();
      } finally {
        vi.useRealTimers();
        if (prevWindow === undefined) {
          delete (globalThis as { window?: unknown }).window;
        } else {
          Object.defineProperty(globalThis, 'window', {
            value: prevWindow,
            configurable: true,
            writable: true,
          });
        }
        if (prevLocalStorage === undefined) {
          delete (globalThis as { localStorage?: unknown }).localStorage;
        } else {
          Object.defineProperty(globalThis, 'localStorage', {
            value: prevLocalStorage,
            configurable: true,
            writable: true,
          });
        }
      }
    });

    it('normalizes trademarks, HTML entities, ligatures, and platform suffixes across IGDB/Lutris, Metacritic, and LauncherService on darwin and win32', async () => {
      // 1) Metacritic canonical slug normalizer
      expect(toCanonicalMetacriticSlug('God of War Ragnarök™')).toBe('god-of-war-ragnarok');
      expect(toCanonicalMetacriticSlug('BioShock&trade;')).toBe('bioshock');
      expect(toCanonicalMetacriticSlug('TEKKEN(TM) 8')).toBe('tekken-8');
      expect(toCanonicalMetacriticSlug('Watch_Dogs® 2')).toBe('watch-dogs-2');
      expect(toCanonicalMetacriticSlug('CRISIS CORE –FINAL FANTASY VII– REUNION')).toBe(
        'crisis-core-final-fantasy-vii-reunion'
      );
      expect(toCanonicalMetacriticSlug('Subnautica™ (PC)')).toBe('subnautica');
      expect(toCanonicalMetacriticSlug('Mørkredd')).toBe('morkredd');

      // 2) Client-side IGDB cover service normalizers & token similarity
      expect(normalizeIgdbKey('BioShock™')).toBe('bioshock');
      expect(normalizeIgdbKey('BioShock&trade;')).toBe('bioshock');
      expect(normalizeIgdbKey('Subnautica™ (PC)')).toBe('subnautica');
      expect(normalizeIgdbKey('Watch_Dogs® 2')).toBe('watch dogs 2');
      expect(normalizeIgdbKey('DOOM® (2016)')).toBe('doom');
      expect(normalizeIgdbCacheKey('BioShock™:2007')).toBe('bioshock:2007');
      expect(
        computeIgdbTokenSimilarity(
          'Call of Duty®: Vanguard - Standard Edition',
          'Call of Duty: Vanguard'
        )
      ).toBe(0.92);
      expect(computeIgdbTokenSimilarity('BioShock™', 'BioShock 2')).toBe(0);

      // 3) Electron storeSync.cjs fetchIgdbCover + Dual-OS LauncherService installed-record title matching
      const originalPlatform = process.platform;
      try {
        for (const targetOs of ['darwin', 'win32'] as const) {
          Object.defineProperty(process, 'platform', {
            value: targetOs,
            configurable: true,
          });

          const observedLutrisQueries: string[] = [];
          vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(async (url: string) => {
              const parsed = new URL(url);
              const q = parsed.searchParams.get('search') || '';
              observedLutrisQueries.push(q);
              return {
                ok: true,
                status: 200,
                json: async () => ({
                  results: [
                    {
                      name: 'BioShock 2',
                      coverart: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co9999.jpg',
                    },
                    {
                      name: q,
                      coverart: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1r7f.jpg',
                    },
                  ],
                }),
              };
            })
          );

          for (const dirtyTitle of [
            'BioShock™',
            'BioShock&trade;',
            'Subnautica™ (PC)',
            'Watch_Dogs® 2',
            'TEKKEN(TM) 8',
          ]) {
            const cover = await storeSyncMod.fetchIgdbCover(dirtyTitle);
            expect(cover).toBe('https://images.igdb.com/igdb/image/upload/t_cover_big/co1r7f.jpg');
          }

          expect(observedLutrisQueries).toEqual([
            'BioShock',
            'BioShock',
            'Subnautica',
            'Watch Dogs 2',
            'TEKKEN 8',
          ]);

          // Dual-OS LauncherService installed-game lookup via normalizeTitleForMatch
          const launcher = new LauncherService();
          const installRoot =
            targetOs === 'win32' ? 'C:\\Users\\player\\Games' : '/Users/player/Games';
          const sep = targetOs === 'win32' ? '\\' : '/';
          const seededRecords: InstalledGameRecord[] = [
            {
              platformId: 'gog',
              platformGameId: 'local-gog-scan-1',
              title: 'BioShock',
              installPath: `${installRoot}${sep}BioShock`,
            },
            {
              platformId: 'epic',
              platformGameId: 'local-epic-scan-2',
              title: 'God of War Ragnarok',
              installPath: `${installRoot}${sep}GodOfWarRagnarok`,
            },
            {
              platformId: 'xbox',
              platformGameId: 'local-xbox-scan-3',
              title: 'Subnautica',
              installPath: `${installRoot}${sep}Subnautica`,
            },
            {
              platformId: 'gog',
              platformGameId: 'local-gog-scan-4',
              title: 'Watch Dogs 2',
              installPath: `${installRoot}${sep}WatchDogs2`,
            },
          ];
          (
            launcher as unknown as {
              installedRecords: InstalledGameRecord[];
              installedIndexMutationSeq: number;
            }
          ).installedRecords = seededRecords;
          (
            launcher as unknown as {
              installedIndexMutationSeq: number;
            }
          ).installedIndexMutationSeq += 1;

          expect(
            launcher.getInstalledRecordForGame(
              makeCanonicalGameFixture({
                id: 'gog-bioshock',
                title: 'BioShock&trade;',
                platforms: [
                  { platformId: 'gog', platformGameId: 'cloud-gog-9001', installed: false },
                ],
              })
            )?.installPath
          ).toBe(`${installRoot}${sep}BioShock`);

          expect(
            launcher.getInstalledRecordForGame(
              makeCanonicalGameFixture({
                id: 'epic-gowr',
                title: 'God of War Ragnarök™',
                platforms: [
                  { platformId: 'epic', platformGameId: 'cloud-epic-9002', installed: false },
                ],
              })
            )?.installPath
          ).toBe(`${installRoot}${sep}GodOfWarRagnarok`);

          expect(
            launcher.getInstalledRecordForGame(
              makeCanonicalGameFixture({
                id: 'xbox-subnautica',
                title: 'Subnautica™ (PC)',
                platforms: [
                  { platformId: 'xbox', platformGameId: 'cloud-xbox-9003', installed: false },
                ],
              })
            )?.installPath
          ).toBe(`${installRoot}${sep}Subnautica`);

          expect(
            launcher.getInstalledRecordForGame(
              makeCanonicalGameFixture({
                id: 'gog-wd2',
                title: 'Watch_Dogs® 2',
                platforms: [
                  { platformId: 'gog', platformGameId: 'cloud-gog-9004', installed: false },
                ],
              })
            )?.installPath
          ).toBe(`${installRoot}${sep}WatchDogs2`);
        }
      } finally {
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
      }
    });

    it('enforces Zero-PII hygiene and zero hardcoded per-game IDs across HLTB and normalizer modules', () => {
      // 1. Universal algorithmic portability: zero hardcoded per-game HLTB or IGDB lookup tables
      expect(Object.keys(HLTB_TITLE_DATABASE)).toEqual([]);
      expect(Object.keys(HLTB_DATABASE)).toEqual([]);
      expect(Object.keys(KNOWN_IGDB_COVERS)).toEqual([]);

      const repoRoot = path.resolve(__dirname, '..');
      const hmacConfig = loadLocalKeyedHmacConfig(repoRoot);

      const hltbCoreFiles = [
        'src/services/common/titleUtils.ts',
        'src/services/hltb/howLongToBeat.ts',
        'electron/ipc/storeSyncIpcHandlers.cjs',
      ];
      for (const relPath of hltbCoreFiles) {
        const content = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
        // Zero hardcoded BioShock / Tekken / Vanguard AppIDs or HLTB IDs in production HLTB logic
        expect(content).not.toMatch(/\b(?:7670|1778820|113507|96566)\b/);
      }

      // 2. Zero-PII static hygiene scan across all Wave 2 & Wave 3A modules + this test file
      const auditedFiles = [
        ...hltbCoreFiles,
        'src/components/SteamStoreDetail/HowLongToBeatCard.tsx',
        'src/components/SteamStoreDetail/SteamStorePage.tsx',
        'src/components/Library/Grid/GameHoverPopout.tsx',
        'src/hooks/useBackgroundMediaWarmup.ts',
        'src/services/integrations/integrationStorage.ts',
        'src/services/igdb/igdbCoverService.ts',
        'src/services/critic/metacriticResolver.ts',
        'src/services/launcher/launcherService.ts',
        'electron/storeSync.cjs',
        'tests/scoringAndHltbHardening.test.ts',
      ];

      for (const relPath of auditedFiles) {
        const content = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
        expect(scanContentForPiiViolations(content, relPath, hmacConfig)).toEqual([]);
      }
    });

    it('converges stacked <Platform> - <Distribution> suffixes identically in TS and CJS and resolves HowLongToBeatCard from getGameDetail before firing live IPC', async () => {
      const stackedTitle = 'Battlefield™ V - Windows 10 - EA Play Pro';
      expect(buildHltbSearchTermPasses(stackedTitle)).toEqual([['Battlefield', 'V']]);
      expect(storeSyncIpc.buildHltbSearchTermPasses(stackedTitle)).toEqual([['Battlefield', 'V']]);

      const prevWindow = (globalThis as { window?: unknown }).window;
      const prevLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
      const mockStorage = createMemoryStorage();

      try {
        Object.defineProperty(globalThis, 'localStorage', {
          value: mockStorage,
          configurable: true,
          writable: true,
        });

        const searchHltbMock = vi.fn().mockResolvedValue({ success: true, data: [] });
        const getGameDetailMock = vi.fn().mockResolvedValue({
          gameId: 'origin-bfv',
          hltb: {
            mainStoryHours: 6.5,
            mainExtraHours: 14,
            completionistHours: 36,
            allStylesHours: 11,
            hltbGameId: 57363,
            isAccurate: true,
          },
        });

        Object.defineProperty(globalThis, 'window', {
          value: {
            localStorage: mockStorage,
            location: { hostname: 'localhost' },
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
            electronAPI: {
              searchHltb: searchHltbMock,
              offlineVault: {
                getGameDetail: getGameDetailMock,
                saveGameDetail: vi.fn(),
              },
            },
          },
          configurable: true,
          writable: true,
        });

        // Mount HowLongToBeatCard WITHOUT initial `hltb` prop (simulating SteamStorePage initial mount before vaultDetail settles)
        const card = createDomain12DeepRenderer(HowLongToBeatCard, {
          gameId: 'origin-bfv',
          gameTitle: stackedTitle,
          appId: 1238810,
        });
        card.render();
        await new Promise((r) => setTimeout(r, 15));
        const settledTree = card.render();
        const settledText = getTextContent(settledTree);
        expect(settledText).toContain('Verified');
        expect(settledText).toContain('6½h');
        expect(settledText).toContain('36h');
        expect(getGameDetailMock).toHaveBeenCalledWith('origin-bfv');
        expect(searchHltbMock).not.toHaveBeenCalled();

        // seedHltbFromVaultIfMissing also populated synchronous memoryCache under both title and appId
        const syncHit = getHowLongToBeat(stackedTitle, 1238810);
        expect(syncHit?.hltbGameId).toBe(57363);
        expect(syncHit?.mainStoryHours).toBe(6.5);

        // Non-destructive guard: seedHltbFromVaultIfMissing does not clobber existing positive entry
        seedHltbFromVaultIfMissing(stackedTitle, 1238810, {
          mainStoryHours: 99,
          mainExtraHours: 99,
          completionistHours: 99,
          allStylesHours: 99,
          hltbGameId: 99999,
          isAccurate: true,
        });
        expect(getHowLongToBeat(stackedTitle, 1238810)?.mainStoryHours).toBe(6.5);

        card.unmount();
      } finally {
        if (prevWindow === undefined) {
          delete (globalThis as { window?: unknown }).window;
        } else {
          Object.defineProperty(globalThis, 'window', {
            value: prevWindow,
            configurable: true,
            writable: true,
          });
        }
        if (prevLocalStorage === undefined) {
          delete (globalThis as { localStorage?: unknown }).localStorage;
        } else {
          Object.defineProperty(globalThis, 'localStorage', {
            value: prevLocalStorage,
            configurable: true,
            writable: true,
          });
        }
      }
    });
  });
});
