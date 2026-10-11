const assert = require('assert');

// Source priority ranks:
// 3: live_cloud_api, live_cloud_xml, live_cloud_graphql
// 2: local_client_cache
// 1: baseline_fallback, unspecified

function getAchievementSourceRank(source) {
  switch (source) {
    case 'live_cloud_api':
    case 'live_cloud_xml':
    case 'live_cloud_graphql':
      return 3;
    case 'local_client_cache':
      return 2;
    case 'baseline_fallback':
    default:
      return 1;
  }
}

function detectAchievementConflict(existing, incoming) {
  if (!existing || !incoming) {
    return { hasConflict: false, unlockedDelta: 0, totalDelta: 0 };
  }

  const unlockedDelta = incoming.unlocked - existing.unlocked;
  const totalDelta = incoming.total - existing.total;

  const hasConflict = unlockedDelta !== 0 || (existing.total > 0 && incoming.total > 0 && totalDelta !== 0);

  if (!hasConflict) {
    return { hasConflict: false, unlockedDelta: 0, totalDelta: 0 };
  }

  const existingSrc = existing.source || 'unspecified_cache';
  const incomingSrc = incoming.source || 'unspecified_source';

  const details = `Discrepancy: existing [${existingSrc}: ${existing.unlocked}/${existing.total}] vs incoming [${incomingSrc}: ${incoming.unlocked}/${incoming.total}]`;

  return {
    hasConflict: true,
    details,
    unlockedDelta,
    totalDelta,
  };
}

function reconcileAchievementSummaries(existing, incoming, context) {
  if (!existing && !incoming) return undefined;
  if (!existing) return incoming ? { ...incoming } : undefined;
  if (!incoming) return { ...existing };

  const conflict = detectAchievementConflict(existing, incoming);
  const existingRank = getAchievementSourceRank(existing.source);
  const incomingRank = getAchievementSourceRank(incoming.source);

  let winner;
  let resolutionReason;

  if (incomingRank > existingRank) {
    winner = { ...incoming };
    resolutionReason = `Incoming source (${incoming.source || 'cloud'}) has higher authority than existing (${existing.source || 'cache'})`;
  } else if (existingRank > incomingRank) {
    winner = { ...existing };
    resolutionReason = `Existing source (${existing.source || 'cloud'}) has higher authority than incoming (${incoming.source || 'baseline'})`;
  } else {
    if (incoming.syncedAt && existing.syncedAt && incoming.syncedAt !== existing.syncedAt) {
      if (incoming.syncedAt > existing.syncedAt) {
        winner = { ...incoming };
        resolutionReason = `Incoming has newer timestamp (${incoming.syncedAt} > ${existing.syncedAt})`;
      } else {
        winner = { ...existing };
        resolutionReason = `Existing has newer timestamp (${existing.syncedAt} >= ${incoming.syncedAt})`;
      }
    } else {
      if (incoming.unlocked >= existing.unlocked) {
        winner = { ...incoming };
        resolutionReason = `Incoming has equal or higher progress (${incoming.unlocked} >= ${existing.unlocked})`;
      } else {
        winner = { ...existing };
        resolutionReason = `Existing has higher progress (${existing.unlocked} > ${incoming.unlocked})`;
      }
    }
  }

  if (conflict.hasConflict) {
    winner.hasConflict = true;
    winner.conflictDetails = `${conflict.details}. Resolution: ${resolutionReason}.`;
  }

  return winner;
}

console.log('=== RUNNING ACHIEVEMENT RECONCILIATION & CONFLICT TESTS ===');

// Test 1: Authoritative Cloud XML (0 trophies) overrides stale cache (10 trophies) -> Fixes Soul Reaver
{
  const cached = { unlocked: 10, total: 40, percentage: 25, source: 'local_client_cache' };
  const cloudXml = { unlocked: 0, total: 40, percentage: 0, source: 'live_cloud_xml', syncedAt: '2026-10-11T12:00:00Z' };

  const res = reconcileAchievementSummaries(cached, cloudXml, { appId: 2521380, title: 'Legacy of Kain: Soul Reaver' });
  assert.strictEqual(res.unlocked, 0, 'Cloud XML with 0 trophies must override cache with 10 trophies');
  assert.strictEqual(res.hasConflict, true, 'Discrepancy must be detected and flagged');
  assert.ok(res.conflictDetails.includes('Discrepancy: existing [local_client_cache: 10/40] vs incoming [live_cloud_xml: 0/40]'));
  console.log('PASS: Test 1 - Cloud XML (0 trophies) overrides stale cache (10 trophies) with conflict tracking');
}

// Test 2: Cloud XML (15 trophies) overrides stale cache (10 trophies)
{
  const cached = { unlocked: 10, total: 40, percentage: 25, source: 'local_client_cache' };
  const cloudXml = { unlocked: 15, total: 40, percentage: 38, source: 'live_cloud_xml', syncedAt: '2026-10-11T12:00:00Z' };

  const res = reconcileAchievementSummaries(cached, cloudXml, { appId: 1091500 });
  assert.strictEqual(res.unlocked, 15);
  assert.strictEqual(res.hasConflict, true);
  console.log('PASS: Test 2 - Cloud XML upgrade (15 trophies) successfully accepted with conflict tracking');
}

// Test 3: Static baseline (5 trophies) cannot downgrade or overwrite live Cloud XML (0 trophies)
{
  const cloudXml = { unlocked: 0, total: 40, percentage: 0, source: 'live_cloud_xml', syncedAt: '2026-10-11T12:00:00Z' };
  const baseline = { unlocked: 5, total: 40, percentage: 12, source: 'baseline_fallback' };

  const res = reconcileAchievementSummaries(cloudXml, baseline, { appId: 2521380 });
  assert.strictEqual(res.unlocked, 0, 'Static baseline must NEVER override live cloud XML');
  assert.strictEqual(res.source, 'live_cloud_xml');
  console.log('PASS: Test 3 - Static baseline blocked from corrupting live cloud XML');
}

// Test 4: Local client cache (15 trophies) supersedes baseline (10 trophies)
{
  const baseline = { unlocked: 10, total: 40, percentage: 25, source: 'baseline_fallback' };
  const localCache = { unlocked: 15, total: 40, percentage: 38, source: 'local_client_cache', syncedAt: '2026-10-11T12:00:00Z' };

  const res = reconcileAchievementSummaries(baseline, localCache);
  assert.strictEqual(res.unlocked, 15, 'Local client cache must supersede static baseline');
  console.log('PASS: Test 4 - Local client cache supersedes baseline');
}

// Test 5: Same rank uses timestamp when available
{
  const olderCloud = { unlocked: 5, total: 40, percentage: 12, source: 'live_cloud_xml', syncedAt: '2026-10-10T10:00:00Z' };
  const newerCloud = { unlocked: 8, total: 40, percentage: 20, source: 'live_cloud_xml', syncedAt: '2026-10-11T10:00:00Z' };

  const res = reconcileAchievementSummaries(olderCloud, newerCloud);
  assert.strictEqual(res.unlocked, 8);
  console.log('PASS: Test 5 - Newer timestamp wins for equal rank');
}

// Test 6: Identical summaries produce NO conflict
{
  const a = { unlocked: 57, total: 57, percentage: 100, source: 'live_cloud_xml' };
  const b = { unlocked: 57, total: 57, percentage: 100, source: 'live_cloud_xml' };

  const res = reconcileAchievementSummaries(a, b);
  assert.strictEqual(res.hasConflict, undefined);
  console.log('PASS: Test 6 - Matching values produce no conflict');
}

// Test 7: GOG live cloud XML (0 trophies) overrides stale cache (25 trophies) with conflict tracking
{
  const staleCache = { unlocked: 25, total: 57, percentage: 44, source: 'local_client_cache' };
  const liveGogCloud = { unlocked: 0, total: 57, percentage: 0, source: 'live_cloud_xml', syncedAt: '2026-10-11T12:00:00Z' };

  const res = reconcileAchievementSummaries(staleCache, liveGogCloud, { title: 'Cyberpunk 2077', store: 'gog' });
  assert.strictEqual(res.unlocked, 0, 'Live GOG cloud (0 trophies) must override stale cache (25 trophies)');
  assert.strictEqual(res.hasConflict, true, 'Discrepancy must be detected and flagged');
  assert.ok(res.conflictDetails.includes('Discrepancy: existing [local_client_cache: 25/57] vs incoming [live_cloud_xml: 0/57]'));
  console.log('PASS: Test 7 - GOG live cloud XML (0 trophies) overrides stale cache (25 trophies) with conflict tracking');
}

// Test 8: Epic live cloud GraphQL (59 trophies, 830 XP) overrides stale baseline and preserves XP
{
  const baseline = { unlocked: 0, total: 88, percentage: 0, source: 'baseline_fallback' };
  const epicLive = {
    unlocked: 59,
    total: 88,
    percentage: 67,
    xp: { earned: 830, total: 1360 },
    source: 'live_cloud_graphql',
    syncedAt: '2026-10-11T12:00:00Z',
  };

  const res = reconcileAchievementSummaries(baseline, epicLive, { title: 'Alan Wake 2', store: 'epic' });
  assert.strictEqual(res.unlocked, 59, 'Epic live cloud GraphQL must override baseline');
  assert.strictEqual(res.xp.earned, 830, 'XP earned must be preserved');
  assert.strictEqual(res.hasConflict, true, 'Discrepancy must be flagged');
  console.log('PASS: Test 8 - Epic live cloud GraphQL (59 trophies, 830 XP) overrides stale baseline and preserves XP');
}

// Test 9: GOG / Epic static baseline cannot downgrade live cloud data
{
  const liveEpic = { unlocked: 59, total: 88, percentage: 67, source: 'live_cloud_graphql' };
  const staleBaseline = { unlocked: 0, total: 88, percentage: 0, source: 'baseline_fallback' };

  const res = reconcileAchievementSummaries(liveEpic, staleBaseline, { title: 'Alan Wake 2', store: 'epic' });
  assert.strictEqual(res.unlocked, 59, 'Baseline cannot downgrade live cloud data');
  assert.strictEqual(res.source, 'live_cloud_graphql');
  console.log('PASS: Test 9 - Epic static baseline blocked from corrupting live cloud GraphQL');
}

console.log('ALL ACHIEVEMENT RECONCILIATION TESTS PASSED!');

