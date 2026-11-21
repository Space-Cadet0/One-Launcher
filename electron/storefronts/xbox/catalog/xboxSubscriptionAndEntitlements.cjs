'use strict';

/**
 * Xbox DisplayCatalog Batch Hydration, Active Subscription Tier Detection (PCGAFD + Collections v6),
 * Owned Entitlements Discovery & Inherited Bundle Ownership Resolution, SIGL v3/v2 Catalog Feeds,
 * Layer-3 Desktop License Gate & Multi-Pass Tier Attribution.
 */

const crypto = require('node:crypto');
const { normalizeStoreMsaTicket, XSTS_RELYING_PARTIES } = require('../xboxAuthManager.cjs');
const xboxConfigAndIds = require('../xboxConfigAndIds.cjs');
const { buildXboxFetchSignal, makeCorrelationVector } = xboxConfigAndIds;

const {
  PCGAFD_ENTITLEMENTS_URL,
  PCGAFD_SUBSCRIPTIONS_URL,
  COLLECTIONS_QUERY_V6_URL,
  DISPLAY_CATALOG_PRODUCTS_URL,
  GAMEPASS_SIGL_V2_URL,
  GAMEPASS_SIGL_V3_URL,
  GAMEPASS_SIGL_IDS,
  XBOX_GAMING_PASS_REGISTRY,
  PCGAFD_KNOWN_SUBSCRIPTION_PRODUCT_IDS,
  NON_GAMING_OR_PERK_PASS_IGNORE_SET,
  resolveFetchImpl,
  alignXboxLocaleWithMarket,
  resolveDefaultXboxLocaleAndMarket,
  isXboxPassProductId,
  deriveExpandedCapabilitySetFromSubscription,
} = require('./xboxCatalogConstants.cjs');

const {
  DISPLAY_CATALOG_CACHE_TTL_MS,
  SIGL_FRESH_SKIP_NETWORK_MS,
  projectCompactDisplayCatalogProduct,
  parseDesktopPassGrantBoundMs,
  hasStaleCachedDesktopPassGrants,
} = require('./xboxCatalogSqliteCache.cjs');

// ============================================================================
// 1. DisplayCatalog Batch Hydration & Autosuggest ID Extraction
// ============================================================================

async function hydrateDisplayCatalogProducts(bigIds, options = {}) {
  const defaults = resolveDefaultXboxLocaleAndMarket(options);
  const {
    market = defaults.market,
    languages = `${defaults.locale},neutral`,
    cacheStore,
    bypassCache = false,
    cachedSourceIds = null,
  } = options;
  const evalNowMs =
    typeof options.nowMs === 'number' && Number.isFinite(options.nowMs)
      ? options.nowMs
      : Date.now();
  const fetchImpl = resolveFetchImpl(options);

  const uniqueIds = Array.from(
    new Set(
      (bigIds || [])
        .map((id) => String(id || '').trim().toUpperCase())
        .filter((id) => /^[A-Z0-9]{12}$/.test(id))
    )
  );

  const staleCachedFallback = new Map();
  const hydratedMap =
    cacheStore && !bypassCache
      ? cacheStore.getProducts(uniqueIds, market, evalNowMs)
      : new Map();
  if (hydratedMap.size > 0) {
    for (const [id, prod] of Array.from(hydratedMap.entries())) {
      if (hasStaleCachedDesktopPassGrants(prod, evalNowMs)) {
        staleCachedFallback.set(id, prod);
        hydratedMap.delete(id);
      } else if (cachedSourceIds instanceof Set) {
        cachedSourceIds.add(id);
      }
    }
  }
  const missingIds = uniqueIds.filter((id) => !hydratedMap.has(id));

  let failedBatchCount = 0;
  const failedProductIds = new Set();
  const attachHydrationStats = (mapObj) => {
    try {
      Object.defineProperties(mapObj, {
        failedBatchCount: { value: failedBatchCount, enumerable: false, configurable: true },
        failedProductIds: { value: failedProductIds, enumerable: false, configurable: true },
      });
    } catch {}
    if (options.hydrationStats && typeof options.hydrationStats === 'object') {
      options.hydrationStats.failedBatchCount =
        (Number(options.hydrationStats.failedBatchCount) || 0) + failedBatchCount;
      if (options.hydrationStats.failedProductIds instanceof Set) {
        for (const fid of failedProductIds) {
          options.hydrationStats.failedProductIds.add(fid);
        }
      }
    }
    return mapObj;
  };

  if (missingIds.length === 0 || typeof fetchImpl !== 'function') {
    return attachHydrationStats(hydratedMap);
  }

  const maxRetries =
    typeof options.maxBatchRetries === 'number' && options.maxBatchRetries >= 0
      ? options.maxBatchRetries
      : 2;
  const retryBaseDelayMs =
    typeof options.retryBaseDelayMs === 'number' && options.retryBaseDelayMs >= 0
      ? options.retryBaseDelayMs
      : 60;

  const parseRetryAfterMs = (res) => {
    try {
      const hdr =
        res && res.headers && typeof res.headers.get === 'function'
          ? res.headers.get('retry-after') || res.headers.get('Retry-After')
          : res?.headers?.['retry-after'] || res?.headers?.['Retry-After'];
      if (!hdr) return 0;
      const secs = Number(hdr);
      if (Number.isFinite(secs) && secs >= 0) {
        return Math.min(2000, Math.round(secs * 1000));
      }
    } catch {}
    return 0;
  };

  const newlyFetched = new Map();
  const batches = [];
  for (let i = 0; i < missingIds.length; i += 25) {
    batches.push(missingIds.slice(i, i + 25));
  }

  const CONCURRENCY = 4;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async (batch) => {
        const url = `${DISPLAY_CATALOG_PRODUCTS_URL}?bigIds=${batch.join(',')}&market=${encodeURIComponent(market)}&languages=${encodeURIComponent(languages)}`;
        let succeeded = false;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (options.signal?.aborted) break;
          try {
            const res = await fetchImpl(url, {
              method: 'GET',
              headers: {
                Accept: 'application/json',
                'MS-CV': makeCorrelationVector(),
              },
              signal: buildXboxFetchSignal(options.signal),
            });
            if (!res.ok) {
              const retryableStatus =
                res.status === 429 ||
                res.status === 500 ||
                res.status === 502 ||
                res.status === 503 ||
                res.status === 504;
              if (retryableStatus && attempt < maxRetries && !options.signal?.aborted) {
                const waitMs =
                  parseRetryAfterMs(res) ||
                  Math.min(1500, retryBaseDelayMs * Math.pow(2, attempt));
                if (waitMs > 0) {
                  await new Promise((r) => setTimeout(r, waitMs));
                }
                continue;
              }
              break;
            }
            const json = await res.json();
            const products = Array.isArray(json?.Products) ? json.Products : [];
            for (const prod of products) {
              const pid = String(prod?.ProductId || '').trim().toUpperCase();
              if (pid) {
                const compact = projectCompactDisplayCatalogProduct(prod);
                hydratedMap.set(pid, compact);
                newlyFetched.set(pid, compact);
                if (cachedSourceIds instanceof Set) {
                  cachedSourceIds.delete(pid);
                }
              }
            }
            succeeded = true;
            break;
          } catch {
            if (attempt < maxRetries && !options.signal?.aborted) {
              const waitMs = Math.min(1500, retryBaseDelayMs * Math.pow(2, attempt));
              if (waitMs > 0) {
                await new Promise((r) => setTimeout(r, waitMs));
              }
              continue;
            }
            break;
          }
        }

        if (!succeeded) {
          failedBatchCount += 1;
          let expiredCacheFallback = null;
          if (cacheStore && typeof cacheStore.getProducts === 'function') {
            try {
              expiredCacheFallback = cacheStore.getProducts(batch, market, 0);
            } catch {}
          }
          for (const bid of batch) {
            failedProductIds.add(bid);
            if (!hydratedMap.has(bid)) {
              const preserved =
                staleCachedFallback.get(bid) ||
                (expiredCacheFallback instanceof Map ? expiredCacheFallback.get(bid) : null);
              if (preserved) {
                hydratedMap.set(bid, preserved);
                if (cachedSourceIds instanceof Set) {
                  cachedSourceIds.add(bid);
                }
              }
            }
          }
        }
      })
    );
  }

  if (newlyFetched.size > 0 && cacheStore) {
    cacheStore.setProducts(newlyFetched, market);
  }

  return attachHydrationStats(hydratedMap);
}

const lookupDisplayCatalogProducts = hydrateDisplayCatalogProducts;

function extractAutosuggestBigIds(json) {
  if (!json || typeof json !== 'object') return [];
  const orderedIds = [];
  const seen = new Set();
  const pushId = (raw) => {
    const clean = String(raw || '').trim().toUpperCase();
    if (/^[A-Z0-9]{12}$/.test(clean) && !seen.has(clean)) {
      seen.add(clean);
      orderedIds.push(clean);
    }
  };

  if (Array.isArray(json.Results)) {
    for (const group of json.Results) {
      if (!group || typeof group !== 'object') continue;
      pushId(group.ProductId || group.BigId || group.Id);
      if (Array.isArray(group.Products)) {
        for (const prod of group.Products) {
          if (prod && typeof prod === 'object') {
            pushId(prod.ProductId || prod.BigId || prod.Id);
          }
        }
      }
    }
  }

  if (Array.isArray(json.Products)) {
    for (const prod of json.Products) {
      if (prod && typeof prod === 'object') {
        pushId(prod.ProductId || prod.BigId || prod.Id);
      }
    }
  }

  if (Array.isArray(json.Payload?.SearchResults)) {
    for (const item of json.Payload.SearchResults) {
      if (item && typeof item === 'object') {
        pushId(item.ProductId || item.BigId || item.Id);
      }
    }
  }

  return orderedIds;
}

// ============================================================================
// 2. Active Subscription Tier Detector (`PCGAFD` + `collections` v6 Fallback)
// ============================================================================

function formatMultiPassTierDisplayName(primary, activeMatched, expandedCapabilitySet) {
  if (!primary) return 'None';
  if (primary.tierId === 'ultimate') {
    return primary.displayName;
  }

  const labels = [primary.displayName];
  const primaryBundled = new Set([
    primary.productId,
    ...(Array.isArray(primary.bundledPassIds) ? primary.bundledPassIds : []),
  ]);

  const hasUnbundledEaPlay =
    !primary.includesEaPlayPc &&
    !primaryBundled.has('CFQ7TTC0K5DH') &&
    expandedCapabilitySet.has('CFQ7TTC0K5DH');
  if (hasUnbundledEaPlay) {
    labels.push('EA Play');
  }

  const ubiPass = activeMatched.find(
    (m) =>
      m.tierId === 'ubisoft_classics' &&
      !primaryBundled.has(m.productId) &&
      m.productId !== primary.productId
  );
  if (ubiPass) {
    labels.push(ubiPass.productId === 'CFQ7TTC0QH5H' ? 'Ubisoft+ Premium' : 'Ubisoft+');
  }

  return labels.join(' + ');
}

/**
 * @typedef {Object} XboxClassifiedSubscription
 * @property {boolean} hasActiveSubscription
 * @property {boolean} hasPcCatalogAccess
 * @property {string} [primaryProductId]
 * @property {string} tierId
 * @property {string} tierDisplayName
 * @property {string} [status]
 * @property {string} [endDate]
 * @property {string} [earliestActivePassEndDate]
 * @property {boolean} [autoRenew]
 * @property {boolean} [isTrial]
 * @property {string} market
 * @property {string[]} activeProductIds
 * @property {string[]} activeEntitlementKeys
 * @property {string[]} expandedCapabilityPassIds
 * @property {boolean} [includesEaPlayPc]
 * @property {string} [siglMode]
 * @property {string[]} [dynamicSiglIds]
 * @property {string} subscriptionFingerprint
 * @property {boolean} authoritativeDetection
 * @property {string} checkedAt
 */

/**
 * @param {any[]} [records]
 * @param {number} [nowMs]
 * @param {Record<string, any>} [options]
 * @returns {XboxClassifiedSubscription}
 */
function classifySubscriptionRecords(records = [], nowMs = Date.now(), options = {}) {
  const mkt = String(options.market || 'US')
    .trim()
    .toUpperCase();
  const authoritativeDetection =
    typeof options.authoritativeDetection === 'boolean' ? options.authoritativeDetection : true;
  const dynamicPassRegistry =
    options.dynamicPassRegistry && typeof options.dynamicPassRegistry === 'object'
      ? options.dynamicPassRegistry
      : null;
  const checkedAt = new Date(nowMs).toISOString();

  /** @type {Map<string, any>} */
  const mergedByProductId = new Map();

  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue;
    const productId = String(
      raw.productId || raw.ProductId || raw.bigId || raw.BigId || raw.id || raw.Id || ''
    )
      .trim()
      .toUpperCase();
    if (!productId) continue;

    if (NON_GAMING_OR_PERK_PASS_IGNORE_SET.has(productId)) {
      continue;
    }

    const rawKind = String(raw.productKind || raw.ProductKind || '')
      .trim()
      .toLowerCase();
    if (
      rawKind &&
      rawKind !== 'pass' &&
      !XBOX_GAMING_PASS_REGISTRY[productId] &&
      !dynamicPassRegistry?.[productId]
    ) {
      continue;
    }

    if (raw.isActive === false) {
      continue;
    }

    const status = String(raw.status || raw.state || 'Active').trim();
    if (/(expired|cancel|revok|ban|suspend|inactive|ended)/i.test(status)) {
      continue;
    }
    const statusLower = status.toLowerCase();
    if (
      statusLower !== 'active' &&
      statusLower !== 'ingraceperiod' &&
      statusLower !== 'warned'
    ) {
      continue;
    }

    const endDateRaw =
      raw.endDate ||
      raw.expirationDate ||
      raw.recurrenceData?.endDate ||
      raw.trialData?.endDate ||
      '';
    if (endDateRaw) {
      const endTs = Date.parse(String(endDateRaw));
      if (!Number.isNaN(endTs) && endTs <= nowMs) {
        continue;
      }
    }

    const knownTier = XBOX_GAMING_PASS_REGISTRY[productId] || dynamicPassRegistry?.[productId];
    if (!knownTier) continue;

    const explicitSkuId = String(raw.skuId || raw.SkuId || '').trim();
    const resolvedSkuId = explicitSkuId || knownTier.defaultSkuId || '0010';
    const rawAutoRenew =
      typeof raw.autoRenew === 'boolean'
        ? raw.autoRenew
        : typeof raw.recurrenceData?.autoRenew === 'boolean'
          ? raw.recurrenceData.autoRenew
          : undefined;
    const rawIsTrial =
      typeof raw.isTrial === 'boolean'
        ? raw.isTrial
        : typeof raw.trialData?.isInTrialPeriod === 'boolean'
          ? raw.trialData.isInTrialPeriod
          : undefined;
    const dynSiglIds = Array.isArray(raw.siglIds || raw.collectionIds)
      ? (raw.siglIds || raw.collectionIds).map((x) => String(x).trim()).filter(Boolean)
      : [];

    const existing = mergedByProductId.get(productId);
    if (!existing) {
      mergedByProductId.set(productId, {
        productId,
        skuId: resolvedSkuId,
        hasExplicitSku: Boolean(explicitSkuId),
        ...knownTier,
        status,
        endDate: endDateRaw ? String(endDateRaw) : undefined,
        autoRenew: rawAutoRenew,
        isTrial: rawIsTrial,
        dynamicSiglIds: dynSiglIds,
      });
    } else {
      if (explicitSkuId && !existing.hasExplicitSku) {
        existing.skuId = explicitSkuId;
        existing.hasExplicitSku = true;
      }
      if (!existing.endDate && endDateRaw) {
        existing.endDate = String(endDateRaw);
      } else if (existing.endDate && endDateRaw) {
        const prevTs = Date.parse(existing.endDate);
        const curTs = Date.parse(String(endDateRaw));
        if (!Number.isNaN(curTs) && (Number.isNaN(prevTs) || curTs > prevTs)) {
          existing.endDate = String(endDateRaw);
        }
      }
      if (existing.autoRenew === undefined && rawAutoRenew !== undefined) {
        existing.autoRenew = rawAutoRenew;
      }
      if (existing.isTrial === undefined && rawIsTrial !== undefined) {
        existing.isTrial = rawIsTrial;
      }
      if (dynSiglIds.length > 0) {
        existing.dynamicSiglIds = Array.from(new Set([...existing.dynamicSiglIds, ...dynSiglIds]));
      }
    }
  }

  const activeMatched = Array.from(mergedByProductId.values());

  if (activeMatched.length === 0) {
    const subscriptionFingerprint = `v2|mkt=${mkt}|tier=none|passes=|caps=`;
    return {
      hasActiveSubscription: false,
      hasPcCatalogAccess: false,
      tierId: 'none',
      tierDisplayName: 'None',
      market: mkt,
      activeProductIds: [],
      activeEntitlementKeys: [],
      expandedCapabilityPassIds: [],
      subscriptionFingerprint,
      authoritativeDetection,
      checkedAt,
    };
  }

  activeMatched.sort((a, b) => b.rank - a.rank);

  const bestPc = activeMatched.find((t) => t.hasPcCatalogAccess);
  const primary = bestPc || activeMatched[0];
  const anyPcAccess = activeMatched.some((t) => t.hasPcCatalogAccess);
  const includesEaPlayPc = activeMatched.some((t) => t.includesEaPlayPc);

  const activeProductIds = Array.from(new Set(activeMatched.map((t) => t.productId))).sort();
  const expandedCapabilitySet = new Set(activeProductIds);
  const expandQueue = [...activeProductIds];
  while (expandQueue.length > 0) {
    const curr = expandQueue.shift();
    const def = XBOX_GAMING_PASS_REGISTRY[curr] || dynamicPassRegistry?.[curr];
    if (def && Array.isArray(def.bundledPassIds)) {
      for (const childPassId of def.bundledPassIds) {
        if (childPassId && !expandedCapabilitySet.has(childPassId)) {
          expandedCapabilitySet.add(childPassId);
          expandQueue.push(childPassId);
        }
      }
    }
  }
  const expandedCapabilityPassIds = Array.from(expandedCapabilitySet).sort();

  const activeEntitlementKeys = Array.from(
    new Set(
      activeMatched.map((t) => `${t.productId}:${t.skuId || t.defaultSkuId || '0010'}`)
    )
  );

  let earliestEndTs = Infinity;
  let earliestActivePassEndDate;
  for (const m of activeMatched) {
    if (!m.endDate) continue;
    const ts = Date.parse(m.endDate);
    if (!Number.isNaN(ts) && ts < earliestEndTs) {
      earliestEndTs = ts;
      earliestActivePassEndDate = m.endDate;
    }
  }

  const allDynamicSiglIds = Array.from(
    new Set(activeMatched.flatMap((t) => t.dynamicSiglIds || []))
  );

  const tierDisplayName = formatMultiPassTierDisplayName(
    primary,
    activeMatched,
    expandedCapabilitySet
  );
  const subscriptionFingerprint = `v2|mkt=${mkt}|tier=${primary.tierId}|passes=${activeProductIds.join(',')}|caps=${expandedCapabilityPassIds.join(',')}`;

  return {
    hasActiveSubscription: true,
    hasPcCatalogAccess: anyPcAccess,
    primaryProductId: primary.productId,
    tierId: primary.tierId,
    tierDisplayName,
    status: primary.status,
    endDate: primary.endDate,
    ...(earliestActivePassEndDate ? { earliestActivePassEndDate } : {}),
    autoRenew: primary.autoRenew,
    ...(primary.isTrial !== undefined ? { isTrial: primary.isTrial } : {}),
    market: mkt,
    activeProductIds,
    activeEntitlementKeys,
    expandedCapabilityPassIds,
    includesEaPlayPc,
    siglMode: primary.siglMode,
    dynamicSiglIds: allDynamicSiglIds,
    subscriptionFingerprint,
    authoritativeDetection,
    checkedAt,
  };
}

function extractEntitlementOrSubscriptionRecords(json) {
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json)) return json;
  for (const key of ['entitlements', 'subscriptions', 'items']) {
    const val = json[key];
    if (Array.isArray(val)) return val;
    if (val && typeof val === 'object') {
      return Object.entries(val).map(([productId, entry]) =>
        entry && typeof entry === 'object' ? { productId, ...entry } : { productId }
      );
    }
  }
  return [];
}

async function resolveCollectionsMsaCredentials({
  collectionsToken,
  storeToken,
  authProvider,
  signal,
}) {
  let bareTicket = '';
  if (collectionsToken) {
    bareTicket = normalizeStoreMsaTicket(collectionsToken, { target: 'collections_bare' });
  }
  if (!bareTicket && storeToken) {
    bareTicket = normalizeStoreMsaTicket(storeToken, { target: 'collections_bare' });
  }
  if (!bareTicket && authProvider) {
    try {
      if (typeof authProvider.getValidStoreToken === 'function') {
        const raw = await authProvider.getValidStoreToken({ target: 'collections', signal });
        bareTicket = normalizeStoreMsaTicket(raw, { target: 'collections_bare' });
      } else if (typeof authProvider.getStoreMsaToken === 'function') {
        const raw = await authProvider.getStoreMsaToken({
          target: 'collections',
          strictMsaOnly: true,
          signal,
        });
        bareTicket = normalizeStoreMsaTicket(raw, { target: 'collections_bare' });
      }
    } catch {}
  }

  if (bareTicket) {
    return {
      hasMsaTicket: true,
      authorizationHeader: `WLID1.0="${bareTicket}"`,
      beneficiaries: [
        {
          identityType: 'msa',
          identityValue: bareTicket,
          localTicketReference: 'primary',
        },
      ],
    };
  }
  return {
    hasMsaTicket: false,
    authorizationHeader: '',
    beneficiaries: [],
  };
}

async function resolveDynamicUnknownPassDefinitions(unknownPassIds, options = {}) {
  const dynamicPassRegistry = {};
  if (
    !Array.isArray(unknownPassIds) ||
    unknownPassIds.length === 0 ||
    typeof options.fetchImpl !== 'function'
  ) {
    return dynamicPassRegistry;
  }

  const hydrated = new Map();
  let frontier = Array.from(new Set(unknownPassIds));
  for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
    const batchMap = await hydrateDisplayCatalogProducts(frontier, {
      market: options.market,
      languages: `${options.locale},neutral`,
      cacheStore: options.cacheStore,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });
    const nextIds = new Set();
    for (const [pid, prod] of batchMap.entries()) {
      hydrated.set(pid, prod);
      const skus = Array.isArray(prod?.DisplaySkuAvailabilities)
        ? prod.DisplaySkuAvailabilities
        : [];
      for (const av of skus) {
        for (const b of av?.Sku?.Properties?.BundledSkus || []) {
          const cid = String(b?.BigId || '').trim().toUpperCase();
          if (cid && /^[A-Z0-9]{12}$/.test(cid) && !hydrated.has(cid)) {
            nextIds.add(cid);
          }
        }
      }
    }
    frontier = Array.from(nextIds);
  }

  for (const rootId of unknownPassIds) {
    const rootProd = hydrated.get(rootId);
    if (!rootProd) continue;

    const matchedKnownPassIds = new Set();
    const visited = new Set([rootId]);
    let queue = [{ id: rootId, depth: 0 }];
    while (queue.length > 0) {
      const { id, depth } = queue.shift();
      const prod = hydrated.get(id);
      if (!prod || depth >= 3) continue;
      for (const av of prod.DisplaySkuAvailabilities || []) {
        for (const b of av?.Sku?.Properties?.BundledSkus || []) {
          const cid = String(b?.BigId || '').trim().toUpperCase();
          if (!cid || visited.has(cid)) continue;
          visited.add(cid);
          if (XBOX_GAMING_PASS_REGISTRY[cid]) {
            matchedKnownPassIds.add(cid);
          }
          queue.push({ id: cid, depth: depth + 1 });
        }
      }
    }

    const rootTitle = String(
      rootProd.LocalizedProperties?.[0]?.ProductTitle || rootProd.ProductTitle || ''
    ).trim();
    const isGamingTitleMatch = /(game\s*pass|ea\s*play|ubisoft\+)/i.test(rootTitle);
    if (matchedKnownPassIds.size === 0 && !isGamingTitleMatch) {
      continue;
    }

    const matchedDefs = Array.from(matchedKnownPassIds)
      .map((id) => XBOX_GAMING_PASS_REGISTRY[id])
      .filter(Boolean)
      .sort((a, b) => b.rank - a.rank);
    const bestChild = matchedDefs[0] || null;
    const inferredTierId = bestChild
      ? bestChild.tierId
      : /ubisoft\+/i.test(rootTitle)
        ? 'ubisoft_classics'
        : /ea\s*play/i.test(rootTitle)
          ? 'ea_play'
          : 'starter';
    const firstSkuId = String(
      rootProd.DisplaySkuAvailabilities?.[0]?.Sku?.SkuId || bestChild?.defaultSkuId || '0001'
    );

    dynamicPassRegistry[rootId] = {
      tierId: inferredTierId,
      rank: bestChild ? bestChild.rank : 32,
      displayName: rootTitle || bestChild?.displayName || 'PC Game Pass',
      tierDisplayName: rootTitle || bestChild?.tierDisplayName || 'PC Game Pass',
      hasPcCatalogAccess: bestChild
        ? matchedDefs.some((d) => d.hasPcCatalogAccess)
        : !/\bconsole\b/i.test(rootTitle),
      includesEaPlayPc: Boolean(
        matchedDefs.some((d) => d.includesEaPlayPc) || /ea\s*play/i.test(rootTitle)
      ),
      defaultSkuId: firstSkuId,
      siglMode: bestChild ? bestChild.siglMode : 'starter_dynamic',
      bundledPassIds: Array.from(matchedKnownPassIds),
    };
  }

  return dynamicPassRegistry;
}

/**
 * Authoritatively detects active Xbox Game Pass / EA Play / Ubisoft+ subscription tiers by fusing
 * `PCGAFD/entitlements/subscriptions` + `collections.mp.microsoft.com/v6.0/collections/query` (`productTypes: ["Pass"]`),
 * with DisplayCatalog `BundledSkus` DAG discovery for future regional/partner passes.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<XboxClassifiedSubscription>}
 */
async function detectXboxSubscriptions(options = {}) {
  const defaults = resolveDefaultXboxLocaleAndMarket(options);
  const {
    storeToken,
    collectionsToken,
    authProvider,
    market = defaults.market,
    locale = defaults.locale,
    cacheStore,
    nowMs = Date.now(),
  } = options;
  const mkt = String(market || 'US')
    .trim()
    .toUpperCase();
  const fetchImpl = resolveFetchImpl(options);

  const rawTicket =
    storeToken ||
    (authProvider && typeof authProvider.getStoreMsaToken === 'function'
      ? await authProvider.getStoreMsaToken({ target: 'pcgafd', signal: options.signal })
      : '');
  let pcgafdTicket = normalizeStoreMsaTicket(rawTicket, { target: 'pcgafd' });
  if (!pcgafdTicket && authProvider && typeof authProvider.getXstsToken === 'function') {
    try {
      const mpXsts = await authProvider.getXstsToken(XSTS_RELYING_PARTIES.MS_STORE, {
        signal: options.signal,
      });
      if (mpXsts?.authorizationHeader) {
        pcgafdTicket = mpXsts.authorizationHeader;
      }
    } catch {}
  }

  const colCreds = await resolveCollectionsMsaCredentials({
    collectionsToken,
    storeToken,
    authProvider,
    signal: options.signal,
  });

  const collectedRecords = [];
  let pcgafdOk = false;
  let collectionsOk = false;

  const queryPcgafd = async () => {
    if (!pcgafdTicket || typeof fetchImpl !== 'function') return [];
    const subUrl = `${PCGAFD_SUBSCRIPTIONS_URL}?market=${encodeURIComponent(mkt)}&language=${encodeURIComponent(locale)}&appVersion=0.2.3`;
    const res = await fetchImpl(subUrl, {
      method: 'POST',
      headers: {
        Authorization: pcgafdTicket,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-MS-API-Version': '1.1',
        'Calling-App-Name': 'OneLauncher',
        'MS-CV': makeCorrelationVector(),
      },
      body: JSON.stringify({
        productIds: PCGAFD_KNOWN_SUBSCRIPTION_PRODUCT_IDS,
      }),
      signal: buildXboxFetchSignal(options.signal),
    });
    if (!res.ok) return [];
    const json = await res.json();
    pcgafdOk = true;
    return extractEntitlementOrSubscriptionRecords(json);
  };

  const queryCollections = async (authHeaderOverride, beneficiariesOverride) => {
    const authHeader = authHeaderOverride || colCreds.authorizationHeader;
    if (!authHeader || typeof fetchImpl !== 'function') return [];
    const items = [];
    let ct = '';
    const seenCursors = new Set();
    for (let page = 0; page < 5; page++) {
      const colRes = await fetchImpl(COLLECTIONS_QUERY_V6_URL, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'MS-CV': makeCorrelationVector(),
        },
        body: JSON.stringify({
          market: mkt,
          includeDuplicates: true,
          productTypes: ['Pass'],
          statusFilters: ['Active'],
          entitlementFilters: ['*:*'],
          maxPageSize: 1000,
          beneficiaries: beneficiariesOverride ?? colCreds.beneficiaries,
          ...(ct ? { continuationToken: ct } : {}),
        }),
        signal: buildXboxFetchSignal(options.signal),
      });
      if (!colRes.ok) {
        if (page === 0) return [];
        break;
      }
      const colJson = await colRes.json();
      collectionsOk = true;
      const pageItems = extractEntitlementOrSubscriptionRecords(colJson);
      items.push(...pageItems);
      const nextCt = typeof colJson?.continuationToken === 'string' ? colJson.continuationToken : '';
      if (!nextCt || seenCursors.has(nextCt) || pageItems.length === 0) break;
      seenCursors.add(nextCt);
      ct = nextCt;
    }
    return items;
  };

  if (colCreds.hasMsaTicket) {
    const [pcgafdSettled, colSettled] = await Promise.allSettled([
      queryPcgafd(),
      queryCollections(),
    ]);
    if (pcgafdSettled.status === 'fulfilled') {
      collectedRecords.push(...pcgafdSettled.value);
    }
    if (colSettled.status === 'fulfilled') {
      collectedRecords.push(...colSettled.value);
    }
  } else {
    try {
      const pcgafdItems = await queryPcgafd();
      collectedRecords.push(...pcgafdItems);
    } catch {}

    if ((!pcgafdOk || collectedRecords.length === 0) && pcgafdTicket && typeof fetchImpl === 'function') {
      try {
        const fallbackColItems = await queryCollections(pcgafdTicket, []);
        collectedRecords.push(...fallbackColItems);
      } catch {}
    }
  }

  const unknownCandidatePassIds = [];
  for (const rec of collectedRecords) {
    if (!rec || typeof rec !== 'object') continue;
    const pid = String(
      rec.productId || rec.ProductId || rec.bigId || rec.BigId || rec.id || rec.Id || ''
    )
      .trim()
      .toUpperCase();
    if (
      !pid ||
      !/^[A-Z0-9]{12}$/.test(pid) ||
      XBOX_GAMING_PASS_REGISTRY[pid] ||
      NON_GAMING_OR_PERK_PASS_IGNORE_SET.has(pid)
    ) {
      continue;
    }
    const status = String(rec.status || rec.state || 'Active').trim();
    if (rec.isActive === false || /(expired|cancel|revok|ban|suspend|inactive|ended)/i.test(status)) {
      continue;
    }
    if (isXboxPassProductId(pid, rec) && !unknownCandidatePassIds.includes(pid)) {
      unknownCandidatePassIds.push(pid);
    }
  }

  const dynamicPassRegistry =
    unknownCandidatePassIds.length > 0
      ? await resolveDynamicUnknownPassDefinitions(unknownCandidatePassIds, {
          market: mkt,
          locale,
          cacheStore,
          fetchImpl,
          signal: options.signal,
        })
      : null;

  const authoritativeDetection = Boolean(pcgafdOk || collectionsOk);
  return classifySubscriptionRecords(collectedRecords, nowMs, {
    market: mkt,
    authoritativeDetection,
    dynamicPassRegistry,
  });
}

// ============================================================================
// 3. Owned Entitlements Discovery (`PCGAFD/entitlements` + `collections` v6)
// ============================================================================

function extractSatisfyingBigId(candidate) {
  if (!candidate) return '';
  let raw = '';
  if (typeof candidate === 'string') {
    raw = candidate;
  } else if (typeof candidate === 'object') {
    raw = String(
      candidate.productId ||
        candidate.ProductId ||
        candidate.bigId ||
        candidate.BigId ||
        candidate.id ||
        candidate.Id ||
        candidate.entitlementKey ||
        candidate.key ||
        ''
    );
  }
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) return '';
  let prefix = trimmed;
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':').map((p) => p.trim());
    prefix = parts[0] === 'BIG' && parts.length >= 2 ? parts[1] : parts[0];
  }
  return /^[A-Z0-9]{12}$/.test(prefix) ? prefix : '';
}

function classifyXboxEntitlement(ent, nowMs = Date.now(), options = {}) {
  if (!ent || typeof ent !== 'object') {
    return { include: false, reason: 'invalid_record' };
  }

  const productId = String(
    ent.productId || ent.ProductId || ent.bigId || ent.BigId || ent.id || ent.Id || ''
  )
    .trim()
    .toUpperCase();
  if (!productId || !/^[A-Z0-9]{12}$/.test(productId)) {
    return { include: false, reason: 'invalid_product_id' };
  }

  if (isXboxPassProductId(productId, ent)) {
    return { include: false, reason: 'subscription_pass_sku', productId };
  }

  const status = String(ent.status || ent.state || 'Active').trim().toLowerCase();
  if (status !== 'active') {
    return { include: false, reason: `inactive_status:${status}`, productId };
  }

  if (typeof ent.sharingSource === 'string') {
    const sharing = ent.sharingSource.trim().toLowerCase();
    if (sharing && sharing !== 'none') {
      return { include: false, reason: `shared_entitlement:${sharing}`, productId };
    }
  }

  if (ent.endDate || ent.expirationDate) {
    const endTs = Date.parse(String(ent.endDate || ent.expirationDate));
    if (!Number.isNaN(endTs) && endTs <= nowMs) {
      return { include: false, reason: 'expired_entitlement', productId };
    }
  }

  const acqType = String(ent.acquisitionType || '').trim().toLowerCase();
  if (
    ent.isTrial === true ||
    ent.trialData?.isInTrialPeriod === true ||
    Number(ent.trialTimeRemaining || 0) > 0 ||
    acqType === 'trial'
  ) {
    return { include: false, reason: 'free_trial', productId };
  }

  const kind = String(ent.productKind || ent.productType || '').trim().toLowerCase();
  const excludedKinds = options?.includeAddOns
    ? ['pass', 'subscription', 'avataritem']
    : ['pass', 'subscription', 'consumable', 'unmanagedconsumable', 'durable', 'avataritem'];
  if (excludedKinds.includes(kind)) {
    return { include: false, reason: `non_game_kind:${kind}`, productId };
  }

  const rawSatisfyingCandidates = [
    ent.satisfiedByProductId,
    ent.satisfyingPassId,
    ent.passProductId,
    ...(Array.isArray(ent.satisfiedByProductIds) ? ent.satisfiedByProductIds : []),
    ...(Array.isArray(ent.satisfiedEntitlements) ? ent.satisfiedEntitlements : []),
    ...(Array.isArray(ent.satisfyingEntitlementKeys) ? ent.satisfyingEntitlementKeys : []),
    ...(Array.isArray(ent.satisfyingPassIds) ? ent.satisfyingPassIds : []),
    ...(Array.isArray(ent.passProductIds) ? ent.passProductIds : []),
  ];

  const satisfiedByPassIds = [];
  const parentIds = [];
  const seenPassIds = new Set();
  const seenParentIds = new Set();

  for (const cand of rawSatisfyingCandidates) {
    const candBigId = extractSatisfyingBigId(cand);
    if (!candBigId) continue;
    if (isXboxPassProductId(candBigId)) {
      if (!seenPassIds.has(candBigId)) {
        seenPassIds.add(candBigId);
        satisfiedByPassIds.push(candBigId);
      }
    } else if (candBigId !== productId && !seenParentIds.has(candBigId)) {
      seenParentIds.add(candBigId);
      parentIds.push(candBigId);
    }
  }

  const hasSpecialFlag = ent.isPositron !== undefined && ent.isPositron !== false;
  const isSubscriptionSatisfied =
    satisfiedByPassIds.length > 0 || acqType === 'recurring' || hasSpecialFlag;

  const skuId = String(ent.skuId || ent.SkuId || '0010').trim() || '0010';
  const primarySatisfiedBy = satisfiedByPassIds[0] || parentIds[0] || '';

  if (isSubscriptionSatisfied) {
    return {
      include: true,
      productId,
      skuId,
      ownershipType: 'subscription',
      satisfiedByProductId: primarySatisfiedBy || undefined,
      satisfiedByPassIds,
      parentIds,
    };
  }

  return {
    include: true,
    productId,
    skuId,
    ownershipType: 'owned',
    satisfiedByProductId: parentIds[0] || undefined,
    satisfiedByPassIds,
    parentIds,
  };
}

function getClassifiedEntitlementRank(classified) {
  if (!classified || !classified.include) return 1;
  if (classified.ownershipType === 'owned') return 3;
  if (classified.ownershipType === 'subscription') return 2;
  return 1;
}

function mergeClassifiedEntitlement(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const existingRank = getClassifiedEntitlementRank(existing);
  const incomingRank = getClassifiedEntitlementRank(incoming);

  const unionedPassIds = Array.from(
    new Set([
      ...(existing.ownershipType === 'subscription' ? existing.satisfiedByPassIds || [] : []),
      ...(incoming.ownershipType === 'subscription' ? incoming.satisfiedByPassIds || [] : []),
    ])
  );

  if (incomingRank > existingRank) {
    if (incoming.ownershipType === 'subscription') {
      return {
        ...incoming,
        satisfiedByPassIds: unionedPassIds,
        satisfiedByProductId:
          unionedPassIds[0] || incoming.satisfiedByProductId || existing.satisfiedByProductId,
      };
    }
    return incoming;
  }

  if (existingRank > incomingRank) {
    if (existing.ownershipType === 'subscription') {
      return {
        ...existing,
        satisfiedByPassIds: unionedPassIds,
        satisfiedByProductId:
          unionedPassIds[0] || existing.satisfiedByProductId || incoming.satisfiedByProductId,
      };
    }
    return existing;
  }

  if (existingRank === 3) {
    const existingDirect = !existing.parentIds || existing.parentIds.length === 0;
    const incomingDirect = !incoming.parentIds || incoming.parentIds.length === 0;
    if (existingDirect) return existing;
    if (incomingDirect) return incoming;
    const mergedParents = Array.from(
      new Set([...(existing.parentIds || []), ...(incoming.parentIds || [])])
    );
    return {
      ...existing,
      parentIds: mergedParents,
      satisfiedByProductId: mergedParents[0] || existing.satisfiedByProductId,
    };
  }

  if (existingRank === 2) {
    const mergedParents = Array.from(
      new Set([...(existing.parentIds || []), ...(incoming.parentIds || [])])
    );
    const primaryPass =
      unionedPassIds[0] || existing.satisfiedByProductId || incoming.satisfiedByProductId;
    return {
      ...existing,
      satisfiedByPassIds: unionedPassIds,
      satisfiedByProductId: primaryPass || undefined,
      parentIds: mergedParents,
    };
  }

  if (incoming.reason === 'subscription_pass_sku' && existing.reason !== 'subscription_pass_sku') {
    return incoming;
  }
  return existing;
}

async function fetchXboxOwnedEntitlements(options = {}) {
  const defaults = resolveDefaultXboxLocaleAndMarket(options);
  const {
    storeToken,
    collectionsToken,
    authProvider,
    market = defaults.market,
    locale = defaults.locale,
    nowMs = Date.now(),
  } = options;
  const mkt = String(market || 'US')
    .trim()
    .toUpperCase();
  const fetchImpl = resolveFetchImpl(options);

  const rawTicket =
    storeToken ||
    (authProvider && typeof authProvider.getStoreMsaToken === 'function'
      ? await authProvider.getStoreMsaToken({ target: 'pcgafd', signal: options.signal })
      : '');
  let pcgafdTicket = normalizeStoreMsaTicket(rawTicket, { target: 'pcgafd' });
  if (!pcgafdTicket && authProvider && typeof authProvider.getXstsToken === 'function') {
    try {
      const mpXsts = await authProvider.getXstsToken(XSTS_RELYING_PARTIES.MS_STORE, {
        signal: options.signal,
      });
      if (mpXsts?.authorizationHeader) {
        pcgafdTicket = mpXsts.authorizationHeader;
      }
    } catch {}
  }

  const rawEntitlements = [];
  let pcgafdOk = false;
  let collectionsOk = false;

  if (pcgafdTicket && typeof fetchImpl === 'function') {
    try {
      let continuationToken = '';
      const seenCursors = new Set();
      let allPagesOk = true;
      for (let page = 0; page < 25; page++) {
        const url = `${PCGAFD_ENTITLEMENTS_URL}?market=${encodeURIComponent(mkt)}&locale=${encodeURIComponent(locale)}&language=${encodeURIComponent(locale)}&appVersion=0.2.3`;
        const headers = {
          Authorization: pcgafdTicket,
          Accept: 'application/json',
          'X-MS-API-Version': '1.1',
          'Calling-App-Name': 'OneLauncher',
          'MS-CV': makeCorrelationVector(),
        };
        if (continuationToken) {
          headers['x-ms-ct'] = continuationToken;
        }

        const res = await fetchImpl(url, {
          method: 'GET',
          headers,
          signal: buildXboxFetchSignal(options.signal),
        });
        if (!res.ok) {
          allPagesOk = false;
          break;
        }

        const json = await res.json();
        const items = extractEntitlementOrSubscriptionRecords(json);
        rawEntitlements.push(...items);

        const nextCt =
          (typeof res.headers?.get === 'function' ? res.headers.get('x-ms-ct') : '') ||
          json?.continuationToken ||
          '';
        if (!nextCt || seenCursors.has(nextCt) || items.length === 0) {
          break;
        }
        seenCursors.add(nextCt);
        continuationToken = nextCt;
      }
      if (allPagesOk) {
        pcgafdOk = true;
      }
    } catch {
      pcgafdOk = false;
    }
  }

  if ((!pcgafdOk || rawEntitlements.length === 0) && typeof fetchImpl === 'function') {
    const colCreds = await resolveCollectionsMsaCredentials({
      collectionsToken,
      storeToken,
      authProvider,
      signal: options.signal,
    });
    const authHeader = colCreds.hasMsaTicket
      ? colCreds.authorizationHeader
      : pcgafdTicket || '';
    const beneficiaries = colCreds.hasMsaTicket ? colCreds.beneficiaries : [];

    if (authHeader) {
      try {
        let ct = '';
        const seenColCursors = new Set();
        let colPagesOk = true;
        for (let page = 0; page < 15; page++) {
          const colRes = await fetchImpl(COLLECTIONS_QUERY_V6_URL, {
            method: 'POST',
            headers: {
              Authorization: authHeader,
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'MS-CV': makeCorrelationVector(),
            },
            body: JSON.stringify({
              market: mkt,
              includeDuplicates: true,
              maxPageSize: 1000,
              beneficiaries,
              productTypes: options.includeAddOns
                ? ['Game', 'Application', 'Durable', 'Consumable', 'UnmanagedConsumable']
                : ['Game', 'Application', 'Durable'],
              statusFilters: ['Active'],
              entitlementFilters: ['*:*'],
              ...(ct ? { continuationToken: ct } : {}),
            }),
            signal: buildXboxFetchSignal(options.signal),
          });
          if (!colRes.ok) {
            colPagesOk = false;
            break;
          }
          const colJson = await colRes.json();
          const items = extractEntitlementOrSubscriptionRecords(colJson);
          rawEntitlements.push(...items);
          const nextCt =
            typeof colJson?.continuationToken === 'string' ? colJson.continuationToken : '';
          if (!nextCt || seenColCursors.has(nextCt) || items.length === 0) break;
          seenColCursors.add(nextCt);
          ct = nextCt;
        }
        if (colPagesOk) {
          collectionsOk = true;
        }
      } catch {}
    }
  }

  const classifiedById = new Map();
  const classifiedRowsById = new Map();
  for (const raw of rawEntitlements) {
    const classified = classifyXboxEntitlement(raw, nowMs, {
      includeAddOns: Boolean(options.includeAddOns),
    });
    if (classified.productId) {
      classifiedById.set(
        classified.productId,
        mergeClassifiedEntitlement(classifiedById.get(classified.productId), classified)
      );
      const rows = classifiedRowsById.get(classified.productId) || [];
      rows.push(classified);
      classifiedRowsById.set(classified.productId, rows);
    }
  }

  const resolvedMemo = new Map();

  const resolveInheritedOwnership = (item, visited = new Set()) => {
    if (!item || !item.include) return { include: false };

    if (item.ownershipType === 'subscription') {
      const passIds = Array.isArray(item.satisfiedByPassIds) ? item.satisfiedByPassIds : [];
      const primary = passIds[0] || item.satisfiedByProductId || undefined;
      return {
        ...item,
        ownershipType: 'subscription',
        satisfiedByProductId: primary,
        satisfiedByPassIds: passIds.length > 0 ? passIds : primary ? [primary] : [],
      };
    }

    const parents =
      Array.isArray(item.parentIds) && item.parentIds.length > 0
        ? item.parentIds
        : item.satisfiedByProductId
          ? [item.satisfiedByProductId]
          : [];

    if (parents.length === 0) {
      return item;
    }

    if (visited.size >= 16) {
      return { include: false };
    }

    const nextVisited = new Set(visited);
    if (item.productId) {
      nextVisited.add(item.productId);
    }

    let hasOwnedParent = false;
    let hasSubscriptionParent = false;
    let hasMissingParent = false;
    const inheritedPassIds = [];
    const addPassId = (pid) => {
      if (pid && !inheritedPassIds.includes(pid)) {
        inheritedPassIds.push(pid);
      }
    };
    let fallbackSubParentId = '';

    for (const parentId of parents) {
      if (!parentId) continue;
      if (isXboxPassProductId(parentId)) {
        hasSubscriptionParent = true;
        addPassId(parentId);
        continue;
      }
      if (nextVisited.has(parentId)) {
        continue;
      }

      const parentEntry = classifiedById.get(parentId);
      if (!parentEntry) {
        hasMissingParent = true;
        continue;
      }

      if (!parentEntry.include) {
        if (parentEntry.reason === 'subscription_pass_sku') {
          hasSubscriptionParent = true;
          addPassId(parentId);
        }
        continue;
      }

      const resolvedParent = resolveProductIdOwnership(parentId, nextVisited);
      if (!resolvedParent.include) {
        continue;
      }

      if (resolvedParent.ownershipType === 'owned') {
        hasOwnedParent = true;
        break;
      }

      if (resolvedParent.ownershipType === 'subscription') {
        hasSubscriptionParent = true;
        for (const p of resolvedParent.satisfiedByPassIds || []) {
          addPassId(p);
        }
        if (resolvedParent.satisfiedByProductId) {
          if (isXboxPassProductId(resolvedParent.satisfiedByProductId)) {
            addPassId(resolvedParent.satisfiedByProductId);
          } else if (!fallbackSubParentId) {
            fallbackSubParentId = resolvedParent.satisfiedByProductId;
          }
        }
        if (!fallbackSubParentId) {
          fallbackSubParentId = parentId;
        }
      }
    }

    if (hasOwnedParent) {
      return {
        ...item,
        ownershipType: 'owned',
      };
    }

    if (hasSubscriptionParent) {
      const primarySub = inheritedPassIds[0] || fallbackSubParentId || undefined;
      return {
        ...item,
        ownershipType: 'subscription',
        satisfiedByProductId: primarySub,
        satisfiedByPassIds: inheritedPassIds,
      };
    }

    if (hasMissingParent) {
      return item;
    }

    return { include: false };
  };

  function resolveProductIdOwnership(productId, visited = new Set()) {
    if (visited.size === 0 && resolvedMemo.has(productId)) {
      return resolvedMemo.get(productId);
    }

    const merged = classifiedById.get(productId);
    if (!merged) {
      return { include: false };
    }
    if (!merged.include) {
      const out = { include: false, reason: merged.reason, productId };
      if (visited.size === 0) resolvedMemo.set(productId, out);
      return out;
    }

    const rows = classifiedRowsById.get(productId) || [merged];
    let winningOwned = null;
    const subscriptionRows = [];

    for (const row of rows) {
      if (!row || !row.include) continue;
      const resolvedRow = resolveInheritedOwnership(row, visited);
      if (!resolvedRow.include) continue;
      if (resolvedRow.ownershipType === 'owned') {
        const isDirect = !row.parentIds || row.parentIds.length === 0;
        if (!winningOwned || (isDirect && winningOwned.parentIds?.length > 0)) {
          winningOwned = resolvedRow;
        }
      } else if (resolvedRow.ownershipType === 'subscription') {
        subscriptionRows.push(resolvedRow);
      }
    }

    let finalResolved;
    if (winningOwned) {
      finalResolved = winningOwned;
    } else if (subscriptionRows.length > 0) {
      const unionedPassIds = [];
      for (const subRow of subscriptionRows) {
        for (const pid of subRow.satisfiedByPassIds || []) {
          if (pid && !unionedPassIds.includes(pid)) {
            unionedPassIds.push(pid);
          }
        }
        if (
          subRow.satisfiedByProductId &&
          isXboxPassProductId(subRow.satisfiedByProductId) &&
          !unionedPassIds.includes(subRow.satisfiedByProductId)
        ) {
          unionedPassIds.push(subRow.satisfiedByProductId);
        }
      }
      const primary = subscriptionRows[0];
      finalResolved = {
        ...primary,
        ownershipType: 'subscription',
        satisfiedByPassIds: unionedPassIds,
        satisfiedByProductId: unionedPassIds[0] || primary.satisfiedByProductId || undefined,
      };
    } else {
      finalResolved = { include: false, productId };
    }

    if (visited.size === 0) {
      resolvedMemo.set(productId, finalResolved);
    }
    return finalResolved;
  }

  const ownedProductIds = new Set();
  const ownedSkuByProduct = new Map();
  const subscriptionSatisfiedIds = new Map();

  for (const productId of classifiedById.keys()) {
    const resolved = resolveProductIdOwnership(productId);
    if (!resolved.include) continue;
    if (resolved.ownershipType === 'owned') {
      ownedProductIds.add(resolved.productId);
      if (!ownedSkuByProduct.has(resolved.productId)) {
        ownedSkuByProduct.set(resolved.productId, resolved.skuId);
      }
    } else if (resolved.ownershipType === 'subscription') {
      const set = subscriptionSatisfiedIds.get(resolved.productId) || new Set();
      for (const passId of resolved.satisfiedByPassIds || []) {
        if (passId) set.add(passId);
      }
      if (resolved.satisfiedByProductId) {
        set.add(resolved.satisfiedByProductId);
      }
      subscriptionSatisfiedIds.set(resolved.productId, set);
    }
  }

  return {
    ownedProductIds,
    ownedSkuByProduct,
    subscriptionSatisfiedIds,
    totalRawCount: rawEntitlements.length,
    authoritative: Boolean(pcgafdOk || collectionsOk),
  };
}

// ============================================================================
// 4. Authoritative SIGL v3 Catalog Feeds + Deterministic v2 Fallback
// ============================================================================

function parseCacheControlMaxAgeMs(res) {
  try {
    const rawHeader =
      typeof res?.headers?.get === 'function'
        ? res.headers.get('cache-control') || res.headers.get('Cache-Control') || ''
        : res?.headers?.['cache-control'] || res?.headers?.['Cache-Control'] || '';
    const match = /max-age\s*=\s*(\d+)/i.exec(String(rawHeader || ''));
    if (match) {
      const sec = Number(match[1]);
      if (Number.isFinite(sec) && sec > 0) {
        return Math.min(300_000, Math.max(60_000, sec * 1000));
      }
    }
  } catch {}
  return SIGL_FRESH_SKIP_NETWORK_MS;
}

function parseSiglFeedBigIds(parsed) {
  const ids = [];
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const rawId =
        typeof entry === 'string'
          ? entry
          : typeof entry?.id === 'string'
            ? entry.id
            : typeof entry?.ProductId === 'string'
              ? entry.ProductId
              : '';
      const id = rawId.trim().toUpperCase();
      if (id && /^[A-Z0-9]{12}$/.test(id)) {
        ids.push(id);
      }
    }
  }
  return Array.from(new Set(ids));
}

async function fetchSingleSiglFeed(siglId, options = {}) {
  const defaults = resolveDefaultXboxLocaleAndMarket(options);
  const {
    market = defaults.market,
    language = defaults.locale.toLowerCase(),
    cacheStore,
    forceNetwork = false,
    _returnDetailedStatus = false,
  } = options;
  const fetchImpl = resolveFetchImpl(options);
  const mkt = String(market || 'US').toUpperCase();
  const lang = alignXboxLocaleWithMarket(language, mkt).toLowerCase();
  const cacheKey = `${siglId}:${mkt}:${lang}`;

  const cached = cacheStore ? cacheStore.getSigl(cacheKey) : null;
  const softTtlMs = Math.min(
    300_000,
    Math.max(60_000, Number(cached?.maxAgeMs || SIGL_FRESH_SKIP_NETWORK_MS))
  );
  if (
    !forceNetwork &&
    cached &&
    Array.isArray(cached.ids) &&
    Date.now() - cached.fetchedAt < softTtlMs
  ) {
    return _returnDetailedStatus
      ? { ok: true, status: 200, fromCache: true, ids: cached.ids, cachedFetchedAt: cached.fetchedAt }
      : cached.ids;
  }

  if (typeof fetchImpl !== 'function') {
    const fallbackIds = cached?.ids || [];
    return _returnDetailedStatus
      ? {
          ok: fallbackIds.length > 0,
          status: 0,
          fromCache: fallbackIds.length > 0,
          ids: fallbackIds,
          cachedFetchedAt: Number(cached?.fetchedAt || 0),
        }
      : fallbackIds;
  }

  const url = `${GAMEPASS_SIGL_V2_URL}?id=${encodeURIComponent(siglId)}&language=${encodeURIComponent(lang)}&market=${encodeURIComponent(mkt)}`;
  const headers = { Accept: 'application/json' };
  if (!forceNetwork && cached?.etag) {
    headers['If-None-Match'] = cached.etag;
  }

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: buildXboxFetchSignal(options.signal),
    });
    if (res.status === 304 && cached?.ids) {
      const now = Date.now();
      cacheStore?.setSigl(cacheKey, { ...cached, fetchedAt: now });
      return _returnDetailedStatus
        ? { ok: true, status: 304, fromCache: true, ids: cached.ids, cachedFetchedAt: now }
        : cached.ids;
    }
    if (!res.ok) {
      const fallbackIds = cached?.ids || [];
      return _returnDetailedStatus
        ? {
            ok: false,
            status: res.status,
            fromCache: fallbackIds.length > 0,
            ids: fallbackIds,
            cachedFetchedAt: Number(cached?.fetchedAt || 0),
          }
        : fallbackIds;
    }
    const text = await res.text();
    const etag = (typeof res.headers?.get === 'function' ? res.headers.get('etag') : '') || '';
    const maxAgeMs = parseCacheControlMaxAgeMs(res);

    const parsed = JSON.parse(text);
    const deduped = parseSiglFeedBigIds(parsed);
    const sha256 = crypto
      .createHash('sha256')
      .update(JSON.stringify(deduped.slice().sort()), 'utf8')
      .digest('hex');

    cacheStore?.setSigl(cacheKey, {
      etag,
      sha256,
      ids: deduped,
      maxAgeMs,
      fetchedAt: Date.now(),
    });
    return _returnDetailedStatus
      ? { ok: true, status: res.status, fromCache: false, ids: deduped, cachedFetchedAt: Date.now() }
      : deduped;
  } catch {
    const fallbackIds = cached?.ids || [];
    return _returnDetailedStatus
      ? {
          ok: false,
          status: 0,
          fromCache: fallbackIds.length > 0,
          ids: fallbackIds,
          cachedFetchedAt: Number(cached?.fetchedAt || 0),
        }
      : fallbackIds;
  }
}

async function fetchSingleSiglV3Feed(siglId, options = {}) {
  const defaults = resolveDefaultXboxLocaleAndMarket(options);
  const {
    market = defaults.market,
    language = defaults.locale.toLowerCase(),
    platformContext = 'pc',
    subscriptionContext = '',
    cacheStore,
    forceNetwork = false,
  } = options;
  const fetchImpl = resolveFetchImpl(options);
  const mkt = String(market || 'US').toUpperCase();
  const lang = alignXboxLocaleWithMarket(language, mkt).toLowerCase();
  const plat = String(platformContext || 'pc')
    .trim()
    .toLowerCase();
  const subCtx = String(subscriptionContext || '')
    .trim()
    .toLowerCase();
  const cacheKey = `v3:${siglId}:${mkt}:${lang}:${plat}:${subCtx}`;

  const cached = cacheStore ? cacheStore.getSigl(cacheKey) : null;
  const softTtlMs = Math.min(
    300_000,
    Math.max(60_000, Number(cached?.maxAgeMs || SIGL_FRESH_SKIP_NETWORK_MS))
  );
  if (
    !forceNetwork &&
    cached &&
    Array.isArray(cached.ids) &&
    Date.now() - cached.fetchedAt < softTtlMs
  ) {
    return {
      ok: true,
      status: 200,
      fromCache: true,
      ids: cached.ids,
      cachedFetchedAt: Number(cached.fetchedAt || 0),
    };
  }

  if (typeof fetchImpl !== 'function') {
    const fallbackIds = cached?.ids || [];
    return {
      ok: fallbackIds.length > 0,
      status: 0,
      fromCache: fallbackIds.length > 0,
      ids: fallbackIds,
      cachedFetchedAt: Number(cached?.fetchedAt || 0),
    };
  }

  const queryParams = new URLSearchParams({
    id: siglId,
    language: lang,
    market: mkt,
    platformContext: plat,
  });
  if (subCtx) {
    queryParams.set('subscriptionContext', subCtx);
  }
  const url = `${GAMEPASS_SIGL_V3_URL}?${queryParams.toString()}`;
  const headers = { Accept: 'application/json' };
  if (!forceNetwork && cached?.etag) {
    headers['If-None-Match'] = cached.etag;
  }

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: buildXboxFetchSignal(options.signal),
    });
    if (res.status === 304 && cached?.ids) {
      const now = Date.now();
      cacheStore?.setSigl(cacheKey, { ...cached, fetchedAt: now });
      return {
        ok: true,
        status: 304,
        fromCache: true,
        ids: cached.ids,
        cachedFetchedAt: now,
      };
    }
    if (!res.ok) {
      const fallbackIds = cached?.ids || [];
      return {
        ok: false,
        status: res.status,
        fromCache: fallbackIds.length > 0,
        ids: fallbackIds,
        cachedFetchedAt: Number(cached?.fetchedAt || 0),
      };
    }

    const text = await res.text();
    const etag = (typeof res.headers?.get === 'function' ? res.headers.get('etag') : '') || '';
    const maxAgeMs = parseCacheControlMaxAgeMs(res);
    const parsed = JSON.parse(text);
    const deduped = parseSiglFeedBigIds(parsed);
    const sha256 = crypto
      .createHash('sha256')
      .update(JSON.stringify(deduped.slice().sort()), 'utf8')
      .digest('hex');
    const now = Date.now();

    cacheStore?.setSigl(cacheKey, {
      etag,
      sha256,
      ids: deduped,
      maxAgeMs,
      fetchedAt: now,
    });
    return {
      ok: true,
      status: res.status,
      fromCache: false,
      ids: deduped,
      cachedFetchedAt: now,
    };
  } catch {
    const fallbackIds = cached?.ids || [];
    return {
      ok: false,
      status: 0,
      fromCache: fallbackIds.length > 0,
      ids: fallbackIds,
      cachedFetchedAt: Number(cached?.fetchedAt || 0),
    };
  }
}

async function fetchActiveTierSiglSets(subscription, entitlementData, options = {}) {
  const activePcSiglSet = new Set();
  const leavingSoonSet = new Set();
  const recentlyAddedSet = new Set();
  /** @type {Map<string, Set<string>>} */
  const grantingCapabilitiesByProductId = new Map();
  let siglFetchAuthoritative = true;

  if (!subscription?.hasActiveSubscription || !subscription?.hasPcCatalogAccess) {
    return {
      activePcSiglSet,
      leavingSoonSet,
      recentlyAddedSet,
      grantingCapabilitiesByProductId,
      siglFetchAuthoritative,
    };
  }

  const expandedCaps = deriveExpandedCapabilitySetFromSubscription(subscription);
  const isHttp400Or404 = (res) => res?.status === 400 || res?.status === 404;

  const admitIdsForCap = (ids, capPassId) => {
    for (const rawId of ids || []) {
      const id = String(rawId || '').trim().toUpperCase();
      if (!id || !/^[A-Z0-9]{12}$/.test(id)) continue;
      activePcSiglSet.add(id);
      if (capPassId) {
        let capSet = grantingCapabilitiesByProductId.get(id);
        if (!capSet) {
          capSet = new Set();
          grantingCapabilitiesByProductId.set(id, capSet);
        }
        capSet.add(capPassId);
      }
    }
  };

  const fetchV2Detailed = (siglId) =>
    fetchSingleSiglFeed(siglId, { ...options, _returnDetailedStatus: true });

  const resolvePcSupersetFallback = async () => {
    const ultV3 = await fetchSingleSiglV3Feed(GAMEPASS_SIGL_IDS.ULTIMATE_ALL_PC, {
      ...options,
      platformContext: 'pc',
      subscriptionContext: 'cfq7ttc0khs0',
    });
    if (ultV3.ok) {
      return { ok: true, ids: ultV3.ids };
    }
    if (isHttp400Or404(ultV3)) {
      const allPcV2 = await fetchV2Detailed(GAMEPASS_SIGL_IDS.ALL_PC);
      return { ok: allPcV2.ok, ids: allPcV2.ids };
    }
    return { ok: false, ids: ultV3.ids };
  };

  const tasks = [];

  if (expandedCaps.has('CFQ7TTC0KHS0')) {
    tasks.push(
      (async () => {
        const res = await fetchSingleSiglV3Feed(GAMEPASS_SIGL_IDS.ULTIMATE_ALL_PC, {
          ...options,
          platformContext: 'pc',
          subscriptionContext: 'cfq7ttc0khs0',
        });
        if (res.ok) {
          admitIdsForCap(res.ids, 'CFQ7TTC0KHS0');
          return;
        }
        if (isHttp400Or404(res)) {
          const [allPcV2, eaPcV2] = await Promise.all([
            fetchV2Detailed(GAMEPASS_SIGL_IDS.ALL_PC),
            fetchV2Detailed(GAMEPASS_SIGL_IDS.EA_PLAY_PC),
          ]);
          if (allPcV2.ok || eaPcV2.ok) {
            admitIdsForCap([...allPcV2.ids, ...eaPcV2.ids], 'CFQ7TTC0KHS0');
          } else {
            siglFetchAuthoritative = false;
            admitIdsForCap([...allPcV2.ids, ...eaPcV2.ids, ...res.ids], 'CFQ7TTC0KHS0');
          }
          return;
        }
        siglFetchAuthoritative = false;
        admitIdsForCap(res.ids, 'CFQ7TTC0KHS0');
      })()
    );
  } else {
    if (expandedCaps.has('CFQ7TTC0KGQ8')) {
      tasks.push(
        (async () => {
          const isStarterOnlyMode = String(subscription.siglMode || '') === 'all_pc_only';
          const res = await fetchSingleSiglV3Feed(GAMEPASS_SIGL_IDS.PC_GAME_PASS_ALL, {
            ...options,
            platformContext: 'pc',
            subscriptionContext: 'cfq7ttc0kgq8',
          });
          if (res.ok) {
            admitIdsForCap(res.ids, 'CFQ7TTC0KGQ8');
            return;
          }
          if (isHttp400Or404(res)) {
            if (
              res.ids.length > 0 &&
              Date.now() - Number(res.cachedFetchedAt || 0) <= DISPLAY_CATALOG_CACHE_TTL_MS
            ) {
              admitIdsForCap(res.ids, 'CFQ7TTC0KGQ8');
              return;
            }
            const [ultV3, ubiV3] = await Promise.all([
              fetchSingleSiglV3Feed(GAMEPASS_SIGL_IDS.ULTIMATE_ALL_PC, {
                ...options,
                platformContext: 'pc',
                subscriptionContext: 'cfq7ttc0khs0',
              }),
              fetchSingleSiglV3Feed(GAMEPASS_SIGL_IDS.UBISOFT_CLASSICS_PC, {
                ...options,
                platformContext: 'pc',
                subscriptionContext: 'cfq7ttbzt8ln',
              }),
            ]);
            if (ultV3.ok) {
              const ubiExclude = new Set(ubiV3.ok ? ubiV3.ids : []);
              admitIdsForCap(
                ultV3.ids.filter((id) => !ubiExclude.has(id)),
                'CFQ7TTC0KGQ8'
              );
              return;
            }
            const [allPcV2, eaPcV2] = await Promise.all([
              fetchV2Detailed(GAMEPASS_SIGL_IDS.ALL_PC),
              isStarterOnlyMode
                ? Promise.resolve({ ok: true, ids: [] })
                : fetchV2Detailed(GAMEPASS_SIGL_IDS.EA_PLAY_PC),
            ]);
            if (allPcV2.ok || eaPcV2.ok) {
              admitIdsForCap([...allPcV2.ids, ...eaPcV2.ids], 'CFQ7TTC0KGQ8');
            } else {
              siglFetchAuthoritative = false;
              admitIdsForCap([...allPcV2.ids, ...eaPcV2.ids], 'CFQ7TTC0KGQ8');
            }
            return;
          }
          siglFetchAuthoritative = false;
          admitIdsForCap(res.ids, 'CFQ7TTC0KGQ8');
        })()
      );
    } else if (expandedCaps.has('CFQ7TTC0P85B')) {
      tasks.push(
        (async () => {
          const res = await fetchSingleSiglV3Feed(GAMEPASS_SIGL_IDS.PREMIUM, {
            ...options,
            platformContext: 'pc',
            subscriptionContext: 'cfq7ttc0p85b',
          });
          if (res.ok) {
            admitIdsForCap(res.ids, 'CFQ7TTC0P85B');
            return;
          }
          if (isHttp400Or404(res)) {
            const [premV2, pcSuperset] = await Promise.all([
              fetchV2Detailed(GAMEPASS_SIGL_IDS.PREMIUM),
              resolvePcSupersetFallback(),
            ]);
            if (premV2.ok) {
              const pcSet = new Set(pcSuperset.ids);
              const intersected =
                pcSet.size > 0 ? premV2.ids.filter((id) => pcSet.has(id)) : premV2.ids;
              admitIdsForCap(intersected, 'CFQ7TTC0P85B');
            } else {
              siglFetchAuthoritative = false;
              admitIdsForCap(res.ids, 'CFQ7TTC0P85B');
            }
            return;
          }
          siglFetchAuthoritative = false;
          admitIdsForCap(res.ids, 'CFQ7TTC0P85B');
        })()
      );
    } else if (expandedCaps.has('CFQ7TTC0K5DJ')) {
      tasks.push(
        (async () => {
          const res = await fetchSingleSiglV3Feed(GAMEPASS_SIGL_IDS.ESSENTIAL, {
            ...options,
            platformContext: 'pc',
            subscriptionContext: 'cfq7ttc0k5dj',
          });
          if (res.ok) {
            admitIdsForCap(res.ids, 'CFQ7TTC0K5DJ');
            if (entitlementData?.subscriptionSatisfiedIds) {
              const essSet = new Set(res.ids);
              for (const [prodId, passSet] of entitlementData.subscriptionSatisfiedIds.entries()) {
                if (passSet.has('CFQ7TTC0K5DJ') && (essSet.size === 0 || essSet.has(prodId))) {
                  admitIdsForCap([prodId], 'CFQ7TTC0K5DJ');
                }
              }
            }
            return;
          }
          if (isHttp400Or404(res)) {
            const [essV2, pcSuperset] = await Promise.all([
              fetchV2Detailed(GAMEPASS_SIGL_IDS.ESSENTIAL),
              resolvePcSupersetFallback(),
            ]);
            const pcSet = new Set(pcSuperset.ids);
            if (essV2.ok && essV2.ids.length > 0) {
              const intersected =
                pcSet.size > 0 ? essV2.ids.filter((id) => pcSet.has(id)) : essV2.ids;
              admitIdsForCap(intersected, 'CFQ7TTC0K5DJ');
            }
            if (entitlementData?.subscriptionSatisfiedIds) {
              for (const [prodId, passSet] of entitlementData.subscriptionSatisfiedIds.entries()) {
                if (passSet.has('CFQ7TTC0K5DJ') && (pcSet.size === 0 || pcSet.has(prodId))) {
                  admitIdsForCap([prodId], 'CFQ7TTC0K5DJ');
                }
              }
            }
            if (!essV2.ok && !pcSuperset.ok && !Array.isArray(subscription.dynamicSiglIds)) {
              siglFetchAuthoritative = false;
            }
            return;
          }
          siglFetchAuthoritative = false;
          admitIdsForCap(res.ids, 'CFQ7TTC0K5DJ');
        })()
      );
    }

    if (expandedCaps.has('CFQ7TTC0K5DH') && !expandedCaps.has('CFQ7TTC0KGQ8')) {
      tasks.push(
        (async () => {
          const res = await fetchSingleSiglV3Feed(GAMEPASS_SIGL_IDS.EA_PLAY_PC, {
            ...options,
            platformContext: 'pc',
            subscriptionContext: 'cfq7ttc0kgq8',
          });
          if (res.ok) {
            admitIdsForCap(res.ids, 'CFQ7TTC0K5DH');
            return;
          }
          if (isHttp400Or404(res)) {
            const eaV2 = await fetchV2Detailed(GAMEPASS_SIGL_IDS.EA_PLAY_PC);
            if (eaV2.ok) {
              admitIdsForCap(eaV2.ids, 'CFQ7TTC0K5DH');
            } else {
              siglFetchAuthoritative = false;
              admitIdsForCap(res.ids, 'CFQ7TTC0K5DH');
            }
            return;
          }
          siglFetchAuthoritative = false;
          admitIdsForCap(res.ids, 'CFQ7TTC0K5DH');
        })()
      );
    }

    if (expandedCaps.has('CFQ7TTBZT8LN') || expandedCaps.has('CFQ7TTC0QH5H')) {
      const ubiCapId = expandedCaps.has('CFQ7TTC0QH5H') ? 'CFQ7TTC0QH5H' : 'CFQ7TTBZT8LN';
      tasks.push(
        (async () => {
          const res = await fetchSingleSiglV3Feed(GAMEPASS_SIGL_IDS.UBISOFT_CLASSICS_PC, {
            ...options,
            platformContext: 'pc',
            subscriptionContext: 'cfq7ttbzt8ln',
          });
          if (res.ok) {
            admitIdsForCap(res.ids, ubiCapId);
            return;
          }
          const hasFreshCachedSnapshot =
            Array.isArray(res.ids) &&
            res.ids.length > 0 &&
            Date.now() - Number(res.cachedFetchedAt || 0) <= DISPLAY_CATALOG_CACHE_TTL_MS;
          if (!isHttp400Or404(res) || !hasFreshCachedSnapshot) {
            siglFetchAuthoritative = false;
          }
          admitIdsForCap(res.ids, ubiCapId);
        })()
      );
    }

    const dynIds = Array.isArray(subscription.dynamicSiglIds) ? subscription.dynamicSiglIds : [];
    const dynCapId =
      subscription.primaryProductId ||
      (expandedCaps.has('CFQ7TTC0P85C') ? 'CFQ7TTC0P85C' : 'CFQ7TTC10QFD');
    if (dynIds.length > 0) {
      tasks.push(
        (async () => {
          const pcSuperset =
            expandedCaps.has('CFQ7TTC0K5DJ') && !expandedCaps.has('CFQ7TTC0P85B')
              ? await resolvePcSupersetFallback()
              : { ok: true, ids: [] };
          const pcFilterSet = new Set(pcSuperset.ids);
          for (const dynSigl of dynIds) {
            const v3Res = await fetchSingleSiglV3Feed(dynSigl, {
              ...options,
              platformContext: 'pc',
              subscriptionContext: String(dynCapId || '').toLowerCase(),
            });
            let ids = v3Res.ids;
            if (!v3Res.ok && isHttp400Or404(v3Res)) {
              const v2Res = await fetchV2Detailed(dynSigl);
              ids = v2Res.ids;
            }
            const filtered =
              pcFilterSet.size > 0 ? ids.filter((id) => pcFilterSet.has(id)) : ids;
            admitIdsForCap(filtered, dynCapId);
          }
        })()
      );
    } else if (
      (expandedCaps.has('CFQ7TTC0P85C') || expandedCaps.has('CFQ7TTC10QFD')) &&
      tasks.length === 0
    ) {
      tasks.push(
        (async () => {
          const subCtx = expandedCaps.has('CFQ7TTC0P85C') ? 'cfq7ttc0p85c' : 'cfq7ttc10qfd';
          const v3Res = await fetchSingleSiglV3Feed(GAMEPASS_SIGL_IDS.PC_GAME_PASS_ALL, {
            ...options,
            platformContext: 'pc',
            subscriptionContext: subCtx,
          });
          if (v3Res.ok) {
            admitIdsForCap(v3Res.ids, dynCapId);
            return;
          }
          if (isHttp400Or404(v3Res)) {
            const v2Res = await fetchV2Detailed(GAMEPASS_SIGL_IDS.ALL_PC);
            admitIdsForCap(v2Res.ids, dynCapId);
            if (!v2Res.ok) siglFetchAuthoritative = false;
            return;
          }
          siglFetchAuthoritative = false;
          admitIdsForCap(v3Res.ids, dynCapId);
        })()
      );
    }
  }

  const decoratorSubCtx = expandedCaps.has('CFQ7TTC0KHS0')
    ? 'cfq7ttc0khs0'
    : expandedCaps.has('CFQ7TTC0KGQ8')
      ? 'cfq7ttc0kgq8'
      : expandedCaps.has('CFQ7TTC0P85B')
        ? 'cfq7ttc0p85b'
        : expandedCaps.has('CFQ7TTC0K5DJ')
          ? 'cfq7ttc0k5dj'
          : 'cfq7ttc0kgq8';

  tasks.push(
    (async () => {
      const v3Res = await fetchSingleSiglV3Feed(GAMEPASS_SIGL_IDS.LEAVING_SOON, {
        ...options,
        platformContext: 'pc',
        subscriptionContext: decoratorSubCtx,
      });
      if (v3Res.ok) {
        for (const id of v3Res.ids) leavingSoonSet.add(id);
        return;
      }
      if (isHttp400Or404(v3Res)) {
        const v2Primary = await fetchV2Detailed(GAMEPASS_SIGL_IDS.LEAVING_SOON);
        if (v2Primary.ok && v2Primary.ids.length > 0) {
          for (const id of v2Primary.ids) leavingSoonSet.add(id);
          return;
        }
        if (isHttp400Or404(v2Primary)) {
          const v2Legacy = await fetchV2Detailed(GAMEPASS_SIGL_IDS.LEGACY_LEAVING_SOON_V2);
          for (const id of v2Legacy.ids) leavingSoonSet.add(id);
        }
        return;
      }
      for (const id of v3Res.ids) leavingSoonSet.add(id);
    })(),
    (async () => {
      const v3Res = await fetchSingleSiglV3Feed(GAMEPASS_SIGL_IDS.RECENTLY_ADDED_PC, {
        ...options,
        platformContext: 'pc',
        subscriptionContext: decoratorSubCtx,
      });
      if (v3Res.ok) {
        for (const id of v3Res.ids) recentlyAddedSet.add(id);
        return;
      }
      if (isHttp400Or404(v3Res)) {
        const v2Primary = await fetchV2Detailed(GAMEPASS_SIGL_IDS.RECENTLY_ADDED_PC);
        if (v2Primary.ok && v2Primary.ids.length > 0) {
          for (const id of v2Primary.ids) recentlyAddedSet.add(id);
          return;
        }
        if (isHttp400Or404(v2Primary)) {
          const v2Legacy = await fetchV2Detailed(GAMEPASS_SIGL_IDS.LEGACY_RECENTLY_ADDED_V2);
          for (const id of v2Legacy.ids) recentlyAddedSet.add(id);
        }
        return;
      }
      for (const id of v3Res.ids) recentlyAddedSet.add(id);
    })()
  );

  await Promise.all(tasks);

  return {
    activePcSiglSet,
    leavingSoonSet,
    recentlyAddedSet,
    grantingCapabilitiesByProductId,
    siglFetchAuthoritative,
  };
}

// ============================================================================
// 5. Layer-3 Desktop License Gate & Multi-Pass Tier Attribution
// ============================================================================

function evaluateLayer3DesktopLicenseGate(
  product,
  lineage,
  hydratedProducts,
  expandedCapabilityPassSet,
  nowMs = Date.now()
) {
  const candidates = [product];
  if (lineage?.inSiglFromParent && Array.isArray(lineage.parentKeys)) {
    for (const pk of lineage.parentKeys) {
      const parentBigId = String(pk || '').split(':')[0];
      const parentProd = parentBigId ? hydratedProducts.get(parentBigId) : null;
      if (parentProd) {
        candidates.push(parentProd);
      }
    }
  }

  let anyRawLicensingData = false;
  let anyDesktopLicenseAvail = false;
  let anyMissingRawLicensingOnSiglParent = false;
  const allPassGrants = [];

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const lic = cand?._compactDesktopLicensing;
    if (!lic || lic.hasRawLicensingData !== true) {
      if (i > 0) {
        anyMissingRawLicensingOnSiglParent = true;
      }
      continue;
    }
    anyRawLicensingData = true;
    if (lic.hasDesktopLicenseAvailability) {
      anyDesktopLicenseAvail = true;
    }
    if (lic.hasUnconditionalDesktopFulfill) {
      return { allowed: true, matchingPassIds: [] };
    }
    if (Array.isArray(lic.passGrants)) {
      for (const pg of lic.passGrants) {
        if (pg && pg.passId) {
          allPassGrants.push(pg);
        }
      }
    }
  }

  if (!anyRawLicensingData) {
    return { allowed: true, matchingPassIds: [] };
  }

  if (allPassGrants.length === 0) {
    if (lineage?.inSiglFromParent && anyMissingRawLicensingOnSiglParent) {
      return { allowed: true, matchingPassIds: [] };
    }
    if (!anyDesktopLicenseAvail) {
      return { allowed: true, matchingPassIds: [] };
    }
    return { allowed: false, matchingPassIds: [] };
  }

  const matchingPassIds = [];
  for (const grant of allPassGrants) {
    if (grant.start !== undefined && grant.start !== null && grant.start !== '') {
      const startTs = parseDesktopPassGrantBoundMs(grant.start);
      if (startTs !== null && startTs > nowMs) continue;
    }
    if (grant.end !== undefined && grant.end !== null && grant.end !== '') {
      const endTs = parseDesktopPassGrantBoundMs(grant.end);
      if (endTs !== null && endTs <= nowMs) continue;
    }
    if (expandedCapabilityPassSet.has(grant.passId)) {
      if (!matchingPassIds.includes(grant.passId)) {
        matchingPassIds.push(grant.passId);
      }
    }
  }

  return {
    allowed: matchingPassIds.length > 0,
    matchingPassIds,
  };
}

function resolveGamePassTierAttribution(
  productId,
  lineage,
  grantingCapabilitiesByProductId,
  layer3Result,
  subscription
) {
  const defaultTierName = subscription?.tierDisplayName || 'Xbox Game Pass';
  const defaultTierId = subscription?.tierId || 'pc';
  const activePassIds = Array.isArray(subscription?.activeProductIds)
    ? subscription.activeProductIds
    : subscription?.primaryProductId
      ? [subscription.primaryProductId]
      : [];

  const capSet = new Set();
  const directCaps = grantingCapabilitiesByProductId?.get?.(productId);
  if (directCaps) {
    for (const c of directCaps) capSet.add(c);
  }
  if (lineage?.inSiglFromParent && Array.isArray(lineage.parentKeys)) {
    for (const pk of lineage.parentKeys) {
      const parentId = String(pk || '').split(':')[0];
      const pCaps = parentId ? grantingCapabilitiesByProductId?.get?.(parentId) : null;
      if (pCaps) {
        for (const c of pCaps) capSet.add(c);
      }
    }
  }
  if (Array.isArray(layer3Result?.matchingPassIds)) {
    for (const mp of layer3Result.matchingPassIds) {
      capSet.add(mp);
    }
  }

  const matchingActiveHeld = [];
  for (const heldId of activePassIds) {
    const def = XBOX_GAMING_PASS_REGISTRY[heldId];
    const covered = new Set([heldId, ...(def?.bundledPassIds || [])]);
    for (const c of capSet) {
      if (covered.has(c)) {
        matchingActiveHeld.push(heldId);
        break;
      }
    }
  }

  const satisfyingPassIds = Array.from(
    new Set(matchingActiveHeld.length > 0 ? matchingActiveHeld : Array.from(capSet))
  ).sort();

  if (subscription?.tierId === 'ultimate' || activePassIds.length <= 1 || matchingActiveHeld.length === 0) {
    return {
      gamePassTier: defaultTierName,
      subscriptionTierId: defaultTierId,
      satisfyingPassIds:
        satisfyingPassIds.length > 0
          ? satisfyingPassIds
          : activePassIds.slice().sort(),
    };
  }

  const bestHeldId = matchingActiveHeld
    .slice()
    .sort(
      (a, b) =>
        (XBOX_GAMING_PASS_REGISTRY[b]?.rank || 0) - (XBOX_GAMING_PASS_REGISTRY[a]?.rank || 0)
    )[0];
  const bestDef = XBOX_GAMING_PASS_REGISTRY[bestHeldId];
  return {
    gamePassTier: bestDef?.displayName || defaultTierName,
    subscriptionTierId: bestDef?.tierId || defaultTierId,
    satisfyingPassIds,
  };
}

module.exports = {
  hydrateDisplayCatalogProducts,
  lookupDisplayCatalogProducts,
  extractAutosuggestBigIds,
  classifySubscriptionRecords,
  detectXboxSubscriptions,
  classifyXboxEntitlement,
  fetchXboxOwnedEntitlements,
  fetchSingleSiglFeed,
  fetchSingleSiglV3Feed,
  fetchActiveTierSiglSets,
  evaluateLayer3DesktopLicenseGate,
  resolveGamePassTierAttribution,
};
