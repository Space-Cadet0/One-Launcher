// @ts-check
'use strict';

const {
  projectRedactedXboxSummary: baseProjectRedactedXboxSummary,
  loadSavedTokensAsync,
  saveTokens,
  saveTokensAsync,
} = require('../tokenVault.cjs');
const storefrontLocalCacheFederator = require('../../launcher/storefrontLocalCacheFederator.cjs');
const xboxStorefront = require('../xbox/index.cjs');
const {
  resolveDefaultStoreLocaleAndCountry,
  resolveStoreVaultOptions,
} = require('./storeSyncShared.cjs');

const MAX_XBOX_PROVIDER_CACHE_ENTRIES = 32;

/** @type {Map<string, any>} */
const xboxProviderCache = new Map();

/**
 * Safely dispose an Xbox auth provider if it exposes `dispose()` (preventing `onVaultChange`
 * listener leaks when cached or ephemeral providers are evicted/replaced).
 *
 * @param {any} provider
 */
function disposeXboxProviderSafe(provider) {
  if (!provider || typeof provider !== 'object') return;
  try {
    if (typeof provider.dispose === 'function') {
      provider.dispose();
    }
  } catch {}
}

/**
 * Evicts and disposes all cached Xbox auth providers.
 */
function disposeAllCachedXboxProviders() {
  for (const provider of xboxProviderCache.values()) {
    disposeXboxProviderSafe(provider);
  }
  xboxProviderCache.clear();
}

/**
 * @param {any} sub
 * @returns {Record<string, any> | undefined}
 */
function projectSafeXboxSubscription(sub) {
  if (!sub || typeof sub !== 'object') return undefined;
  return {
    hasActiveSubscription: Boolean(sub.hasActiveSubscription),
    hasPcCatalogAccess: Boolean(sub.hasPcCatalogAccess),
    ...(sub.primaryProductId ? { primaryProductId: String(sub.primaryProductId) } : {}),
    tierId: String(sub.tierId || 'none'),
    tierDisplayName: String(sub.tierDisplayName || 'None'),
    ...(sub.status ? { status: String(sub.status) } : {}),
    ...(sub.endDate ? { endDate: String(sub.endDate) } : {}),
    ...(sub.earliestActivePassEndDate
      ? { earliestActivePassEndDate: String(sub.earliestActivePassEndDate) }
      : {}),
    ...(typeof sub.autoRenew === 'boolean' ? { autoRenew: sub.autoRenew } : {}),
    ...(typeof sub.isTrial === 'boolean' ? { isTrial: sub.isTrial } : {}),
    ...(sub.market ? { market: String(sub.market) } : {}),
    activeProductIds: Array.isArray(sub.activeProductIds)
      ? sub.activeProductIds.map((/** @type {unknown} */ x) => String(x))
      : [],
    ...(Array.isArray(sub.activeEntitlementKeys)
      ? { activeEntitlementKeys: sub.activeEntitlementKeys.map((/** @type {unknown} */ x) => String(x)) }
      : {}),
    ...(Array.isArray(sub.expandedCapabilityPassIds)
      ? {
          expandedCapabilityPassIds: sub.expandedCapabilityPassIds.map((/** @type {unknown} */ x) =>
            String(x)
          ),
        }
      : {}),
    ...(typeof sub.includesEaPlayPc === 'boolean'
      ? { includesEaPlayPc: sub.includesEaPlayPc }
      : {}),
    ...(sub.siglMode ? { siglMode: String(sub.siglMode) } : {}),
    ...(Array.isArray(sub.dynamicSiglIds)
      ? { dynamicSiglIds: sub.dynamicSiglIds.map((/** @type {unknown} */ x) => String(x)) }
      : {}),
    ...(sub.subscriptionFingerprint
      ? { subscriptionFingerprint: String(sub.subscriptionFingerprint) }
      : {}),
    ...(typeof sub.authoritativeDetection === 'boolean'
      ? { authoritativeDetection: sub.authoritativeDetection }
      : {}),
    ...(sub.checkedAt ? { checkedAt: String(sub.checkedAt) } : {}),
  };
}

/**
 * @param {any} entry
 * @returns {Record<string, any> | null}
 */
function projectRedactedXboxSummary(entry) {
  const base = /** @type {Record<string, any> | null} */ (baseProjectRedactedXboxSummary(entry));
  if (!base) return null;
  if (entry?.subscription && typeof entry.subscription === 'object') {
    base.subscription = projectSafeXboxSubscription(entry.subscription);
  }
  if (typeof entry?.market === 'string' && /^[A-Z]{2}$/i.test(entry.market.trim())) {
    base.market = entry.market.trim().toUpperCase();
  }
  return base;
}

/**
 * Resolves (or caches) an Xbox auth provider for the requested vault scope.
 * Never leaks listeners on LRU eviction (calls `provider.dispose?.()`).
 *
 * @param {Record<string, any>} [options]
 */
function getXboxAuthProvider(options = {}) {
  if (options.authProviderOverride) {
    return options.authProviderOverride;
  }
  const vaultOpts = resolveStoreVaultOptions(options);
  if (options.fetchFn) {
    return xboxStorefront.createXboxAuthProvider({
      ...vaultOpts,
      userDataDir: options.userDataDir,
      fetchImpl: options.fetchFn,
    });
  }
  const scopeKey = String(
    vaultOpts.tokensFilePath || vaultOpts.filePath || vaultOpts.userDataDir || 'default'
  );
  if (!xboxProviderCache.has(scopeKey)) {
    if (xboxProviderCache.size >= MAX_XBOX_PROVIDER_CACHE_ENTRIES) {
      const oldestKey = xboxProviderCache.keys().next().value;
      if (oldestKey !== undefined) {
        const evicted = xboxProviderCache.get(oldestKey);
        xboxProviderCache.delete(oldestKey);
        disposeXboxProviderSafe(evicted);
      }
    }
    xboxProviderCache.set(
      scopeKey,
      xboxStorefront.createXboxAuthProvider({
        ...vaultOpts,
        userDataDir: options.userDataDir,
      })
    );
  }
  return xboxProviderCache.get(scopeKey);
}

/**
 * Helper to execute an async operation with an Xbox provider and automatically dispose ephemeral
 * custom-`fetchFn` providers in `finally` so test/custom-fetch calls never leak vault listeners.
 *
 * @template T
 * @param {Record<string, any>} options
 * @param {(provider: any) => Promise<T>} task
 * @returns {Promise<T>}
 */
async function withXboxAuthProvider(options, task) {
  const isEphemeral = Boolean(!options?.authProviderOverride && options?.fetchFn);
  const provider = getXboxAuthProvider(options);
  try {
    return await task(provider);
  } finally {
    if (isEphemeral) {
      disposeXboxProviderSafe(provider);
    }
  }
}

/**
 * Syncs the authenticated user's Xbox PC / Mac library, active Game Pass subscription tier,
 * `TitleHub` achievement summaries, and `UserStats` `MinutesPlayed` playtime.
 *
 * @param {Record<string, any>} [options]
 */
async function syncXboxLibrary(options = {}) {
  return withXboxAuthProvider(options, async (provider) => {
    const vaultOpts = resolveStoreVaultOptions(options);
    const savedXbox = (await loadSavedTokensAsync(vaultOpts))?.xbox || {};
    const syncMode = xboxStorefront.normalizeXboxSyncMode(
      options.syncMode || savedXbox.syncMode || 'owned_and_played'
    );

    const forceRefresh = Boolean(options.forceRefresh);
    const [session, storeToken, collectionsToken] = await Promise.all([
      provider.getValidXboxSession({ forceRefresh }),
      provider.getStoreMsaToken({
        target: 'pcgafd',
        forceRefresh,
      }),
      typeof provider.getValidStoreToken === 'function'
        ? provider.getValidStoreToken({ target: 'collections', forceRefresh }).catch(() => '')
        : provider.getStoreMsaToken({ target: 'collections', forceRefresh }).catch(() => ''),
    ]);

    if (
      (options.platform || process.platform) === 'win32' &&
      typeof storefrontLocalCacheFederator.discoverWindowsLocalDrivesAsync === 'function'
    ) {
      await storefrontLocalCacheFederator.discoverWindowsLocalDrivesAsync(options).catch(() => {});
    }

    const localInstallsByPfn = new Map();
    const localInstalledProductIds = new Set();
    try {
      const localList = storefrontLocalCacheFederator.listLocalXboxInstalledGames(options);
      for (const loc of localList) {
        if (loc.xboxProductId) {
          localInstalledProductIds.add(String(loc.xboxProductId).toUpperCase());
        }
        const installRecord = {
          installed: true,
          installPath: loc.installPath,
          executablePath: loc.executablePath,
        };
        if (loc.packageFamilyName) {
          const pfnLower = String(loc.packageFamilyName).trim().toLowerCase();
          if (pfnLower) {
            localInstallsByPfn.set(pfnLower, installRecord);
            const idPrefix = pfnLower.split('_')[0];
            if (idPrefix && !localInstallsByPfn.has(idPrefix)) {
              localInstallsByPfn.set(idPrefix, installRecord);
            }
          }
        }
        if (loc.identityName) {
          const idLower = String(loc.identityName).trim().toLowerCase();
          if (idLower) {
            localInstallsByPfn.set(idLower, installRecord);
          }
        }
      }
    } catch {}

    const fetchImpl = options.fetchFn || globalThis.fetch;
    const { locale, country } = resolveDefaultStoreLocaleAndCountry({
      ...options,
      fallbackMarket: savedXbox.market || savedXbox.subscription?.market || '',
    });

    const titleHubDecorations = await xboxStorefront.fetchXboxTitleHubSummaries({
      xuid: session.xuid,
      authorizationHeader: session.authorizationHeader,
      locale,
      fetchImpl,
    });

    const catalogResult = await xboxStorefront.syncXboxCatalog({
      authProvider: provider,
      storeToken,
      collectionsToken,
      cachedSubscription: savedXbox.subscription || null,
      forceRefresh,
      syncMode,
      titleHubDecorations,
      localInstallsByPfn,
      localInstalledProductIds,
      market: country,
      locale,
      userDataDir: options.userDataDir,
      fetchImpl,
    });

    const unplayedPfns = [];
    for (const game of catalogResult.games) {
      const plat = /** @type {any} */ (game.platforms?.[0]);
      if (plat?.packageFamilyName && !plat.achievements) {
        const pLower = plat.packageFamilyName.toLowerCase();
        const idPrefix = pLower.split('_')[0];
        if (
          !titleHubDecorations.byPfn?.[pLower] &&
          !(idPrefix && titleHubDecorations.byPfn?.[idPrefix])
        ) {
          unplayedPfns.push(plat.packageFamilyName);
        }
      }
    }

    let mergedAchievementsMap = { ...(titleHubDecorations.achievementsMap || {}) };
    if (unplayedPfns.length > 0 && session.xuid) {
      const batchTh = await xboxStorefront.fetchXboxTitleHubSummaries({
        xuid: session.xuid,
        authorizationHeader: session.authorizationHeader,
        pfns: unplayedPfns,
        skipHistory: true,
        locale,
        fetchImpl,
      });
      mergedAchievementsMap = { ...mergedAchievementsMap, ...(batchTh.achievementsMap || {}) };
      for (const game of catalogResult.games) {
        const plat = /** @type {any} */ (game.platforms?.[0]);
        if (!plat?.packageFamilyName) continue;
        const pLower = plat.packageFamilyName.toLowerCase();
        const idPrefix = pLower.split('_')[0];
        const dec = batchTh.byPfn?.[pLower] || (idPrefix ? batchTh.byPfn?.[idPrefix] : null);
        if (dec) {
          if (!plat.xboxTitleId && dec.titleId) plat.xboxTitleId = dec.titleId;
          if (!plat.scid && dec.scid) plat.scid = dec.scid;
          if (!plat.achievements && dec.summary) plat.achievements = dec.summary;
        }
      }
    }

    const admittedTitleIds = catalogResult.games
      .map((/** @type {any} */ g) => /** @type {any} */ (g.platforms?.[0])?.xboxTitleId)
      .filter(Boolean);

    if (admittedTitleIds.length > 0 && session.xuid) {
      const playtimeMap = await xboxStorefront.fetchXboxPlaytimeBatch({
        xuid: session.xuid,
        authorizationHeader: session.authorizationHeader,
        titleIds: admittedTitleIds,
        fetchImpl,
      });
      for (const game of catalogResult.games) {
        const plat = /** @type {any} */ (game.platforms?.[0]);
        if (!plat?.xboxTitleId) continue;
        const mins = playtimeMap.get(String(plat.xboxTitleId));
        if (typeof mins === 'number' && mins > 0) {
          plat.playtimeMinutes = mins;
        }
      }
    }

    for (const game of catalogResult.games) {
      const plat = /** @type {any} */ (game.platforms?.[0]);
      if (plat?.achievements && plat.xboxProductId) {
        mergedAchievementsMap[plat.xboxProductId] = plat.achievements;
        mergedAchievementsMap[`xbox-${plat.xboxProductId}`] = plat.achievements;
      }
    }

    const nextXboxPersist = {
      accountName: session.gamertag,
      gamertag: session.gamertag,
      modernGamertag: session.modernGamertag,
      xuid: session.xuid,
      avatarUrl: session.gamerpicUrl || savedXbox.avatarUrl,
      gamerpicUrl: session.gamerpicUrl || savedXbox.gamerpicUrl,
      gamerscore: session.gamerscore || savedXbox.gamerscore || 0,
      market: catalogResult.subscription?.market || country,
      subscription: catalogResult.subscription,
      syncMode: catalogResult.syncMode,
    };

    /** @param {any} sub */
    const normalizeSubForDiff = (sub) => {
      if (!sub || typeof sub !== 'object') return null;
      const { checkedAt: _ignoredCheckedAt, ...rest } = sub;
      return rest;
    };
    const savedSubNorm = JSON.stringify(normalizeSubForDiff(savedXbox.subscription));
    const nextSubNorm = JSON.stringify(normalizeSubForDiff(nextXboxPersist.subscription));
    const savedCheckedMs = savedXbox.subscription?.checkedAt
      ? Date.parse(String(savedXbox.subscription.checkedAt))
      : NaN;
    const savedSubTimestampStale =
      Boolean(nextXboxPersist.subscription) &&
      (!Number.isFinite(savedCheckedMs) || Date.now() - savedCheckedMs > 24 * 60 * 60 * 1000);

    const xboxTokensChanged =
      savedXbox.accountName !== nextXboxPersist.accountName ||
      savedXbox.gamertag !== nextXboxPersist.gamertag ||
      savedXbox.modernGamertag !== nextXboxPersist.modernGamertag ||
      savedXbox.xuid !== nextXboxPersist.xuid ||
      savedXbox.avatarUrl !== nextXboxPersist.avatarUrl ||
      savedXbox.gamerpicUrl !== nextXboxPersist.gamerpicUrl ||
      Number(savedXbox.gamerscore || 0) !== Number(nextXboxPersist.gamerscore || 0) ||
      savedXbox.market !== nextXboxPersist.market ||
      savedXbox.syncMode !== nextXboxPersist.syncMode ||
      savedSubNorm !== nextSubNorm ||
      savedSubTimestampStale;

    if (xboxTokensChanged) {
      await saveTokensAsync('xbox', nextXboxPersist, vaultOpts);
    }

    const authoritativeComplete = Boolean(catalogResult.authoritativeComplete);
    const subscriptionChanged = Boolean(catalogResult.subscriptionChanged);

    /** @type {any} */ (syncXboxLibrary).lastAchievementsMap = mergedAchievementsMap;
    /** @type {any} */ (syncXboxLibrary).lastSuppressedItems = catalogResult.suppressedItems || [];
    /** @type {any} */ (syncXboxLibrary).lastAuthoritativeComplete = authoritativeComplete;
    /** @type {any} */ (fetchXboxOwnedGames).lastAchievementsMap = mergedAchievementsMap;
    /** @type {any} */ (fetchXboxOwnedGames).lastSuppressedItems =
      catalogResult.suppressedItems || [];
    /** @type {any} */ (fetchXboxOwnedGames).lastAuthoritativeComplete = authoritativeComplete;

    return {
      accountName: session.gamertag,
      gamertag: session.gamertag,
      modernGamertag: session.modernGamertag,
      xuid: session.xuid,
      avatarUrl: session.gamerpicUrl || undefined,
      gamerscore: session.gamerscore || 0,
      market: catalogResult.subscription?.market || country,
      subscription: catalogResult.subscription,
      syncMode: catalogResult.syncMode,
      authoritativeComplete,
      subscriptionChanged,
      games: catalogResult.games,
      achievements: mergedAchievementsMap,
      suppressedItems: catalogResult.suppressedItems || [],
    };
  });
}

/**
 * @param {Record<string, any>} [options]
 */
async function fetchXboxOwnedGames(options = {}) {
  const result = await syncXboxLibrary(options);
  return result.games;
}

/**
 * @param {any} codeOrPayload
 * @param {Record<string, any>} [options]
 */
async function loginXbox(codeOrPayload, options = {}) {
  return withXboxAuthProvider(options, async (provider) => {
    const forwardedOpts = { ...options, authProviderOverride: provider };
    if (
      codeOrPayload &&
      typeof codeOrPayload === 'object' &&
      (codeOrPayload.daProperty || codeOrPayload.sDAToken)
    ) {
      const daProp = codeOrPayload.daProperty || codeOrPayload;
      const ex = await provider.exchangeTokenBrokerDaProperty(daProp, {
        isSecondLeg: Boolean(codeOrPayload.isSecondLeg || options.isSecondLeg),
      });
      if (ex && ex.requiresInlineConsent) {
        return ex;
      }
      return syncXboxLibrary(forwardedOpts);
    }
    const codeVal = typeof codeOrPayload === 'string' ? codeOrPayload : codeOrPayload?.code;
    const cleanCode = typeof codeVal === 'string' ? codeVal.trim() : '';
    if (cleanCode === 'xbox_token_broker' || cleanCode === 'token_broker') {
      return syncXboxLibrary(forwardedOpts);
    }
    await provider.exchangeAuthCode(codeOrPayload);
    return syncXboxLibrary(forwardedOpts);
  });
}

/**
 * @param {Record<string, any>} [options]
 */
async function fetchXboxAchievements(options = {}) {
  return withXboxAuthProvider(options, async (provider) => {
    const session = await provider.getValidXboxSession();
    const { locale } = resolveDefaultStoreLocaleAndCountry(options);
    const fetchImpl = options.fetchFn || globalThis.fetch;

    const rawTitleId = String(options?.titleId || options?.xboxTitleId || '').trim();
    const rawProductId = String(options?.productId || options?.xboxProductId || '')
      .replace(/^xbox[-_:]/i, '')
      .trim()
      .toUpperCase();
    const rawPfn = String(options?.pfn || options?.packageFamilyName || '').trim();

    if (rawTitleId) {
      const cleanTitleId =
        typeof xboxStorefront.normalizeTitleIdString === 'function'
          ? xboxStorefront.normalizeTitleIdString(rawTitleId)
          : rawTitleId;
      const container = await xboxStorefront.fetchXboxDetailedAchievements({
        xuid: session.xuid,
        titleId: cleanTitleId,
        authorizationHeader: session.authorizationHeader,
        locale,
        signal: options.signal,
        fetchImpl,
      });
      const total = Number(container?.total || 0);
      const unlocked = Number(container?.unlocked || 0);
      const totalGs = Number(container?.gamerscore?.total ?? container?.totalGamerscore ?? 0);
      const earnedGs = Number(container?.gamerscore?.earned ?? container?.earnedGamerscore ?? 0);
      /** @type {Record<string, any>} */
      const achievementsMap = {};
      if (total > 0 || unlocked > 0 || totalGs > 0) {
        const summary = {
          unlocked,
          total,
          percentage:
            typeof container?.percentage === 'number'
              ? container.percentage
              : total > 0
                ? Math.min(100, Math.round((unlocked / total) * 100))
                : 0,
          gamerscore: {
            earned: earnedGs,
            total: totalGs,
          },
          isMastered: Boolean(
            container?.isMastered ||
              (total > 0 && unlocked >= total) ||
              (totalGs > 0 && earnedGs >= totalGs)
          ),
          source: 'live_cloud_api',
          syncedAt: container?.syncedAt || new Date().toISOString(),
        };
        if (cleanTitleId) {
          achievementsMap[cleanTitleId] = summary;
        }
        if (rawTitleId && rawTitleId !== cleanTitleId) {
          achievementsMap[rawTitleId] = summary;
        }
        if (rawProductId) {
          achievementsMap[rawProductId] = summary;
          achievementsMap[`xbox-${rawProductId}`] = summary;
          achievementsMap[rawProductId.toLowerCase()] = summary;
        }
        if (rawPfn) {
          achievementsMap[rawPfn.toLowerCase()] = summary;
        }
        if (typeof options?.title === 'string' && options.title.trim()) {
          achievementsMap[options.title.toLowerCase().trim()] = summary;
        }
      }
      return achievementsMap;
    }

    if (rawPfn && (!Array.isArray(options?.pfns) || options.pfns.length === 0)) {
      const singlePfnTitleHub = await xboxStorefront.fetchXboxTitleHubSummaries({
        xuid: session.xuid,
        authorizationHeader: session.authorizationHeader,
        pfns: [rawPfn],
        skipHistory: true,
        locale,
        signal: options.signal,
        fetchImpl,
      });
      return singlePfnTitleHub.achievementsMap || {};
    }

    const titleHub = await xboxStorefront.fetchXboxTitleHubSummaries({
      xuid: session.xuid,
      authorizationHeader: session.authorizationHeader,
      pfns: options.pfns || [],
      locale,
      signal: options.signal,
      fetchImpl,
    });
    return titleHub.achievementsMap || {};
  });
}

/**
 * @param {Record<string, any>} [payload]
 * @param {Record<string, any>} [options]
 */
async function fetchXboxDetailedGameAchievements(payload = {}, options = {}) {
  return withXboxAuthProvider(options, async (provider) => {
    const session = await provider.getValidXboxSession();
    const fetchImpl = options.fetchFn || globalThis.fetch;
    const { locale } = resolveDefaultStoreLocaleAndCountry(options);

    let titleId = String(payload.xboxTitleId || payload.titleId || '').trim();
    const productId = String(
      payload.xboxProductId || payload.productId || payload.platformGameId || payload.gameId || ''
    )
      .replace(/^xbox[-_:]/i, '')
      .trim()
      .toUpperCase();

    if (!titleId && /^[A-Z0-9]{12}$/.test(productId)) {
      const meta = /** @type {Record<string, any> | null} */ (
        await xboxStorefront.fetchXboxProductMetadata(
          { xboxProductId: productId },
          { userDataDir: options.userDataDir, locale, fetchImpl }
        )
      );
      if (meta?.xboxTitleId) {
        titleId = String(meta.xboxTitleId);
      } else if (meta?.packageFamilyName) {
        const th = await xboxStorefront.fetchXboxTitleHubSummaries({
          xuid: session.xuid,
          authorizationHeader: session.authorizationHeader,
          pfns: [meta.packageFamilyName],
          locale,
          fetchImpl,
        });
        const pLower = String(meta.packageFamilyName).toLowerCase();
        const idPrefix = pLower.split('_')[0];
        const hit = th.byPfn?.[pLower] || (idPrefix ? th.byPfn?.[idPrefix] : null);
        if (hit?.titleId) titleId = String(hit.titleId);
      }
    }

    return xboxStorefront.fetchXboxDetailedAchievements({
      xuid: session.xuid,
      titleId,
      authorizationHeader: session.authorizationHeader,
      locale,
      fetchImpl,
    });
  });
}

/**
 * @param {Record<string, any>} [payload]
 * @param {Record<string, any>} [options]
 */
async function getXboxGameAchievementSchema(payload = {}, options = {}) {
  const container = await fetchXboxDetailedGameAchievements(payload, options);
  return Array.isArray(container?.achievements) ? container.achievements : [];
}

/**
 * @param {Record<string, any>} [payload]
 * @param {Record<string, any>} [options]
 */
async function fetchXboxProductOfferMetadata(payload = {}, options = {}) {
  const { locale, country } = resolveDefaultStoreLocaleAndCountry(options);
  const cloudMeta = /** @type {Record<string, any> | null} */ (
    await xboxStorefront.fetchXboxProductMetadata(payload, {
      userDataDir: options.userDataDir,
      locale: payload.locale || locale,
      market: payload.market || country,
      fetchImpl: options.fetchFn || globalThis.fetch,
    })
  );
  if (
    cloudMeta &&
    (cloudMeta.xboxProductId ||
      cloudMeta.productId ||
      (Array.isArray(cloudMeta.results) && cloudMeta.results.length > 0))
  ) {
    return cloudMeta;
  }
  const localMeta = storefrontLocalCacheFederator.resolveLocalXboxMetadata(payload, options);
  if (localMeta) return localMeta;
  return cloudMeta;
}

/**
 * @param {Record<string, any>} [options]
 */
async function getXboxStatus(options = {}) {
  const vaultOpts = resolveStoreVaultOptions(options);
  const saved = await loadSavedTokensAsync(vaultOpts);
  const redacted = projectRedactedXboxSummary(saved?.xbox);
  if (!redacted) {
    return {
      connected: false,
      syncMode: 'owned_and_played',
    };
  }

  const cachedSub = saved?.xbox?.subscription;
  const expiryIso = cachedSub?.earliestActivePassEndDate || cachedSub?.endDate || '';
  const expiryTs = expiryIso ? Date.parse(String(expiryIso)) : NaN;
  const isExpiredByClock = Boolean(
    cachedSub?.hasActiveSubscription && !Number.isNaN(expiryTs) && Date.now() >= expiryTs
  );

  if (options.refreshSubscription || isExpiredByClock) {
    try {
      await withXboxAuthProvider(options, async (provider) => {
        const { locale, country } = resolveDefaultStoreLocaleAndCountry({
          ...options,
          fallbackMarket: saved?.xbox?.market || cachedSub?.market || '',
        });
        const [storeToken, collectionsToken] = await Promise.all([
          typeof provider.getStoreMsaToken === 'function'
            ? provider.getStoreMsaToken({ target: 'pcgafd' }).catch(() => '')
            : Promise.resolve(''),
          typeof provider.getValidStoreToken === 'function'
            ? provider.getValidStoreToken({ target: 'collections' }).catch(() => '')
            : typeof provider.getStoreMsaToken === 'function'
              ? provider.getStoreMsaToken({ target: 'collections' }).catch(() => '')
              : Promise.resolve(''),
        ]);
        const subscription = await xboxStorefront.detectXboxSubscriptions({
          authProvider: provider,
          storeToken,
          collectionsToken,
          market: country,
          locale,
          fetchImpl: options.fetchFn || globalThis.fetch,
        });
        if (subscription.authoritativeDetection !== false || isExpiredByClock) {
          await saveTokensAsync(
            'xbox',
            {
              market: subscription.market || country,
              subscription,
            },
            vaultOpts
          );
          redacted.subscription = projectSafeXboxSubscription(subscription);
          redacted.market = subscription.market || country;
        }
      });
    } catch {}
  }
  return redacted;
}

/**
 * @param {string} rawSyncMode
 * @param {Record<string, any>} [options]
 */
function setXboxSyncMode(rawSyncMode, options = {}) {
  const vaultOpts = resolveStoreVaultOptions(options);
  const syncMode = xboxStorefront.normalizeXboxSyncMode(rawSyncMode);
  saveTokens('xbox', { syncMode }, vaultOpts);
  return { success: true, syncMode };
}

function trimXboxSyncMemory() {
  /** @type {any} */ (syncXboxLibrary).lastAchievementsMap = null;
  /** @type {any} */ (syncXboxLibrary).lastSuppressedItems = null;
  /** @type {any} */ (fetchXboxOwnedGames).lastAchievementsMap = null;
  /** @type {any} */ (fetchXboxOwnedGames).lastSuppressedItems = null;
  disposeAllCachedXboxProviders();
}

module.exports = {
  xboxStorefront,
  projectSafeXboxSubscription,
  projectRedactedXboxSummary,
  getXboxAuthProvider,
  disposeAllCachedXboxProviders,
  loginXbox,
  syncXboxLibrary,
  fetchXboxOwnedGames,
  fetchXboxAchievements,
  fetchXboxDetailedGameAchievements,
  getXboxGameAchievementSchema,
  fetchXboxProductOfferMetadata,
  getXboxStatus,
  setXboxSyncMode,
  trimXboxSyncMemory,
};
