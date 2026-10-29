import { describe, it, expect } from 'vitest';
import {
  reconcileAchievementSummaries,
  getAchievementSourceRank,
  detectAchievementConflict,
} from '../src/services/storage/achievementReconciliation';
import { StoreAchievementSummary } from '../src/contracts/game';

describe('Achievement Source Authority & Ranking', () => {
  it('correctly ranks source authorities', () => {
    expect(getAchievementSourceRank('live_cloud_api')).toBe(3);
    expect(getAchievementSourceRank('live_cloud_xml')).toBe(3);
    expect(getAchievementSourceRank('live_cloud_graphql')).toBe(3);
    expect(getAchievementSourceRank('local_client_cache')).toBe(2);
    expect(getAchievementSourceRank('baseline_fallback')).toBe(1);
    expect(getAchievementSourceRank(undefined)).toBe(1);
  });
});

describe('Achievement Conflict Detection', () => {
  it('flags discrepancies in unlocked count', () => {
    const existing: StoreAchievementSummary = {
      unlocked: 10,
      total: 40,
      percentage: 25,
      source: 'local_client_cache',
    };
    const incoming: StoreAchievementSummary = {
      unlocked: 0,
      total: 40,
      percentage: 0,
      source: 'live_cloud_xml',
    };

    const conflict = detectAchievementConflict(existing, incoming);
    expect(conflict.hasConflict).toBe(true);
    expect(conflict.unlockedDelta).toBe(-10);
    expect(conflict.details).toContain('Discrepancy: existing [local_client_cache: 10/40] vs incoming [live_cloud_xml: 0/40]');
  });

  it('reports no conflict when summaries match exactly', () => {
    const existing: StoreAchievementSummary = {
      unlocked: 57,
      total: 57,
      percentage: 100,
      source: 'live_cloud_xml',
    };
    const incoming: StoreAchievementSummary = {
      unlocked: 57,
      total: 57,
      percentage: 100,
      source: 'live_cloud_xml',
    };

    const conflict = detectAchievementConflict(existing, incoming);
    expect(conflict.hasConflict).toBe(false);
  });
});

describe('Achievement Reconciliation Rules', () => {
  // Test 1: Authoritative Cloud XML (0 trophies) overrides stale cache (10 trophies) -> Fixes Soul Reaver
  it('Test 1: Authoritative live Cloud XML overrides stale local cache with conflict tracking', () => {
    const cached: StoreAchievementSummary = {
      unlocked: 10,
      total: 40,
      percentage: 25,
      source: 'local_client_cache',
    };
    const cloudXml: StoreAchievementSummary = {
      unlocked: 0,
      total: 40,
      percentage: 0,
      source: 'live_cloud_xml',
      syncedAt: '2026-10-11T12:00:00Z',
    };

    const res = reconcileAchievementSummaries(cached, cloudXml, {
      appId: 2521380,
      title: 'Legacy of Kain: Soul Reaver',
    });
    expect(res).toBeDefined();
    expect(res!.unlocked).toBe(0);
    expect(res!.hasConflict).toBe(true);
    expect(res!.conflictDetails).toContain('Discrepancy: existing [local_client_cache: 10/40] vs incoming [live_cloud_xml: 0/40]');
  });

  // Test 2: Cloud XML upgrade (15 trophies) overrides stale cache (10 trophies)
  it('Test 2: Cloud XML progression upgrade successfully accepted with conflict tracking', () => {
    const cached: StoreAchievementSummary = {
      unlocked: 10,
      total: 40,
      percentage: 25,
      source: 'local_client_cache',
    };
    const cloudXml: StoreAchievementSummary = {
      unlocked: 15,
      total: 40,
      percentage: 38,
      source: 'live_cloud_xml',
      syncedAt: '2026-10-11T12:00:00Z',
    };

    const res = reconcileAchievementSummaries(cached, cloudXml, { appId: 1091500 });
    expect(res).toBeDefined();
    expect(res!.unlocked).toBe(15);
    expect(res!.hasConflict).toBe(true);
  });

  // Test 3: Static baseline (5 trophies) cannot downgrade or overwrite live Cloud XML (0 trophies)
  it('Test 3: Static baseline is blocked from corrupting or downgrading live Cloud XML', () => {
    const cloudXml: StoreAchievementSummary = {
      unlocked: 0,
      total: 40,
      percentage: 0,
      source: 'live_cloud_xml',
      syncedAt: '2026-10-11T12:00:00Z',
    };
    const baseline: StoreAchievementSummary = {
      unlocked: 5,
      total: 40,
      percentage: 12,
      source: 'baseline_fallback',
    };

    const res = reconcileAchievementSummaries(cloudXml, baseline, { appId: 2521380 });
    expect(res).toBeDefined();
    expect(res!.unlocked).toBe(0);
    expect(res!.source).toBe('live_cloud_xml');
  });

  // Test 4: Local client cache (15 trophies) supersedes baseline (10 trophies)
  it('Test 4: Local client cache supersedes static baseline', () => {
    const baseline: StoreAchievementSummary = {
      unlocked: 10,
      total: 40,
      percentage: 25,
      source: 'baseline_fallback',
    };
    const localCache: StoreAchievementSummary = {
      unlocked: 15,
      total: 40,
      percentage: 38,
      source: 'local_client_cache',
      syncedAt: '2026-10-11T12:00:00Z',
    };

    const res = reconcileAchievementSummaries(baseline, localCache);
    expect(res).toBeDefined();
    expect(res!.unlocked).toBe(15);
    expect(res!.source).toBe('local_client_cache');
  });

  // Test 5: Same rank uses timestamp when available
  it('Test 5: Newer timestamp wins for equal rank summaries', () => {
    const olderCloud: StoreAchievementSummary = {
      unlocked: 5,
      total: 40,
      percentage: 12,
      source: 'live_cloud_xml',
      syncedAt: '2026-10-10T10:00:00Z',
    };
    const newerCloud: StoreAchievementSummary = {
      unlocked: 8,
      total: 40,
      percentage: 20,
      source: 'live_cloud_xml',
      syncedAt: '2026-10-11T10:00:00Z',
    };

    const res = reconcileAchievementSummaries(olderCloud, newerCloud);
    expect(res).toBeDefined();
    expect(res!.unlocked).toBe(8);
  });

  // Test 6: Identical summaries produce NO conflict
  it('Test 6: Identical summaries produce no conflict', () => {
    const a: StoreAchievementSummary = {
      unlocked: 57,
      total: 57,
      percentage: 100,
      source: 'live_cloud_xml',
    };
    const b: StoreAchievementSummary = {
      unlocked: 57,
      total: 57,
      percentage: 100,
      source: 'live_cloud_xml',
    };

    const res = reconcileAchievementSummaries(a, b);
    expect(res).toBeDefined();
    expect(res!.hasConflict).toBeUndefined();
  });

  // Test 7: GOG live cloud XML (0 trophies) overrides stale cache (25 trophies)
  it('Test 7: GOG live cloud XML overrides stale cache with conflict tracking', () => {
    const staleCache: StoreAchievementSummary = {
      unlocked: 25,
      total: 57,
      percentage: 44,
      source: 'local_client_cache',
    };
    const liveGogCloud: StoreAchievementSummary = {
      unlocked: 0,
      total: 57,
      percentage: 0,
      source: 'live_cloud_xml',
      syncedAt: '2026-10-11T12:00:00Z',
    };

    const res = reconcileAchievementSummaries(staleCache, liveGogCloud, {
      title: 'Cyberpunk 2077',
      store: 'gog',
    });
    expect(res).toBeDefined();
    expect(res!.unlocked).toBe(0);
    expect(res!.hasConflict).toBe(true);
    expect(res!.conflictDetails).toContain('Discrepancy: existing [local_client_cache: 25/57] vs incoming [live_cloud_xml: 0/57]');
  });

  // Test 8: Epic live cloud GraphQL (40 trophies, 500 XP) overrides stale baseline and preserves XP
  it('Test 8: Epic live cloud GraphQL overrides stale baseline and preserves XP', () => {
    const baseline: StoreAchievementSummary = {
      unlocked: 0,
      total: 80,
      percentage: 0,
      source: 'baseline_fallback',
    };
    const epicLive: StoreAchievementSummary = {
      unlocked: 40,
      total: 80,
      percentage: 50,
      xp: { earned: 500, total: 1000 },
      source: 'live_cloud_graphql',
      syncedAt: '2026-10-11T12:00:00Z',
    };

    const res = reconcileAchievementSummaries(baseline, epicLive, {
      title: 'Alan Wake 2',
      store: 'epic',
    });
    expect(res).toBeDefined();
    expect(res!.unlocked).toBe(40);
    expect(res!.xp?.earned).toBe(500);
    expect(res!.hasConflict).toBe(true);
  });

  // Test 9: GOG / Epic static baseline cannot downgrade live cloud data
  it('Test 9: Epic static baseline is blocked from corrupting live cloud GraphQL', () => {
    const liveEpic: StoreAchievementSummary = {
      unlocked: 40,
      total: 80,
      percentage: 50,
      source: 'live_cloud_graphql',
    };
    const staleBaseline: StoreAchievementSummary = {
      unlocked: 0,
      total: 80,
      percentage: 0,
      source: 'baseline_fallback',
    };

    const res = reconcileAchievementSummaries(liveEpic, staleBaseline, {
      title: 'Alan Wake 2',
      store: 'epic',
    });
    expect(res).toBeDefined();
    expect(res!.unlocked).toBe(40);
    expect(res!.source).toBe('live_cloud_graphql');
  });
});
