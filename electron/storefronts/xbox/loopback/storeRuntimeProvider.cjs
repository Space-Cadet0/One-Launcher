// @ts-check
'use strict';

const {
  buildXboxFetchSignal,
  resolveDefaultXboxLocale,
} = require('../xboxConfigAndIds.cjs');

const ENTITLEMENT_CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Creates a live `XStore` runtime provider backed by `xboxCatalogAndGamePass.cjs` and
 * `xboxDeviceClep.cjs` with 60s entitlement caching, real license state reporting,
 * and safe offline fallbacks.
 *
 * @param {Record<string, any>} [options]
 */
function createXboxStoreRuntimeProvider(options = {}) {
  const {
    authProvider = null,
    gameMetadata = {},
    fetchImpl,
    tokenVault,
    userDataDir,
    cacheStore,
  } = options;

  /** @type {any} */
  let catalogMod = null;
  /** @type {any} */
  let clepMod = null;
  const getCatalogMod = () => {
    if (!catalogMod) catalogMod = require('../xboxCatalogAndGamePass.cjs');
    return catalogMod;
  };
  const getClepMod = () => {
    if (!clepMod) clepMod = require('../xboxDeviceClep.cjs');
    return clepMod;
  };

  const resolvedLocale = resolveDefaultXboxLocale(options.locale || gameMetadata.locale);
  const resolvedMarket =
    String(
      options.market ||
        gameMetadata.market ||
        (resolvedLocale.includes('-') ? resolvedLocale.split('-').pop() : 'US')
    )
      .trim()
      .toUpperCase() || 'US';

  const installedDlcStoreIds = new Set(
    (Array.isArray(options.dlcPackages) ? options.dlcPackages : [])
      .map((dlc) => String(dlc?.storeId || '').trim().toUpperCase())
      .filter(Boolean)
  );

  /** @type {any} */
  let cachedEntitlements = null;
  let cachedEntitlementsAt = 0;
  /** @type {Promise<any> | null} */
  let inFlightEntitlements = null;

  function createEmptyEntitlements() {
    return {
      ownedProductIds: new Set(),
      ownedSkuByProduct: new Map(),
      subscriptionSatisfiedIds: new Map(),
      totalRawCount: 0,
      authoritative: false,
    };
  }

  async function getCachedEntitlements() {
    const now = Date.now();
    if (cachedEntitlements && now - cachedEntitlementsAt < ENTITLEMENT_CACHE_TTL_MS) {
      return cachedEntitlements;
    }
    if (!authProvider) {
      return createEmptyEntitlements();
    }
    if (inFlightEntitlements) return inFlightEntitlements;

    inFlightEntitlements = (async () => {
      try {
        const { fetchXboxOwnedEntitlements } = getCatalogMod();
        const res = await fetchXboxOwnedEntitlements({
          authProvider,
          market: resolvedMarket,
          locale: resolvedLocale,
          fetchImpl,
          includeAddOns: true,
        });
        cachedEntitlements = res;
        cachedEntitlementsAt = Date.now();
        return res;
      } catch {
        return cachedEntitlements || createEmptyEntitlements();
      } finally {
        inFlightEntitlements = null;
      }
    })();

    return inFlightEntitlements;
  }

  /**
   * @param {unknown} rawKind
   * @param {boolean} [isBaseGame]
   */
  function mapProductKindBit(rawKind, isBaseGame = false) {
    const k = String(rawKind || '').trim().toLowerCase();
    if (k === 'game') return 0x04;
    if (k === 'durable') return 0x02;
    if (k === 'consumable') return 0x01;
    if (k === 'unmanagedconsumable') return 0x10;
    return isBaseGame ? 0x04 : 0x02;
  }

  /**
   * @param {unknown} amount
   * @param {unknown} currencyCode
   */
  function formatCompactPrice(amount, currencyCode) {
    const num = Number.isFinite(Number(amount)) ? Number(amount) : 0;
    const cur = String(currencyCode || 'USD').toUpperCase();
    const raw = cur === 'USD' ? `$${num.toFixed(2)}` : `${num.toFixed(2)} ${cur}`;
    return raw.slice(0, 15);
  }

  /**
   * @param {any} prod
   * @param {string} storeIdFallback
   * @param {any} entitlements
   * @param {boolean} [isBaseGame]
   */
  function mapCatalogProductToXStore(prod, storeIdFallback, entitlements, isBaseGame = false) {
    const storeId = String(prod?.ProductId || storeIdFallback || '').trim().toUpperCase();
    const loc = Array.isArray(prod?.LocalizedProperties) ? prod.LocalizedProperties[0] : null;
    const dsaList = Array.isArray(prod?.DisplaySkuAvailabilities)
      ? prod.DisplaySkuAvailabilities
      : [];
    const chosenDsa =
      dsaList.find((/** @type {any} */ d) => !d?.Sku?.Properties?.IsTrial) || dsaList[0] || null;
    const sku = chosenDsa?.Sku || null;
    const skuId =
      String(
        entitlements?.ownedSkuByProduct?.get?.(storeId) || sku?.SkuId || '0010'
      ).trim() || '0010';
    const avail = Array.isArray(chosenDsa?.Availabilities) ? chosenDsa.Availabilities[0] : null;
    const priceObj = avail?.OrderManagementData?.Price || null;

    const listPrice = Number.isFinite(Number(priceObj?.ListPrice))
      ? Number(priceObj.ListPrice)
      : 0;
    const msrp = Number.isFinite(Number(priceObj?.MSRP)) ? Number(priceObj.MSRP) : listPrice;
    const currencyCode = String(priceObj?.CurrencyCode || 'USD').trim().toUpperCase() || 'USD';
    const isOnSale = msrp > listPrice && listPrice >= 0;

    const inAppOfferToken = String(
      sku?.Properties?.InAppOfferToken || prod?.Properties?.InAppOfferToken || ''
    ).trim();
    const productKind = mapProductKindBit(prod?.ProductKind, isBaseGame);
    const isEntitled = Boolean(
      entitlements?.ownedProductIds?.has?.(storeId) ||
        entitlements?.subscriptionSatisfiedIds?.has?.(storeId)
    );
    const isInUserCollection = entitlements?.authoritative
      ? isEntitled
      : Boolean(isEntitled || isBaseGame);

    return {
      storeId,
      title: String(loc?.ProductTitle || sku?.LocalizedProperties?.[0]?.SkuTitle || storeId).trim(),
      description: String(loc?.ShortDescription || loc?.ProductDescription || '').trim(),
      language: resolvedLocale,
      inAppOfferToken,
      linkUri: storeId ? `ms-windows-store://pdp/?ProductId=${storeId}` : '',
      productKind,
      hasDigitalDownload: true,
      isInUserCollection,
      skuId,
      currencyCode,
      price: listPrice,
      basePrice: msrp,
      formattedPrice: formatCompactPrice(listPrice, currencyCode),
      formattedBasePrice: formatCompactPrice(msrp, currencyCode),
      isOnSale,
    };
  }

  /**
   * @param {{ productIds?: string[], customDeveloperString?: string, parentProductId?: string }} [params]
   */
  async function queryLicenseToken({
    productIds = [],
    customDeveloperString = '',
    parentProductId = '',
  } = {}) {
    if (!authProvider) return '';
    try {
      if (typeof authProvider.queryLicenseToken === 'function') {
        const direct = await authProvider.queryLicenseToken({
          productIds,
          customDeveloperString,
          parentProductId,
        });
        return String(direct?.token || direct || '');
      }

      const msaStoreToken =
        typeof authProvider.getStoreMsaToken === 'function'
          ? await authProvider.getStoreMsaToken({ forLicensing: true })
          : '';
      if (!msaStoreToken) return '';

      let deviceContext =
        typeof authProvider.ensureDeviceContext === 'function'
          ? await authProvider.ensureDeviceContext()
          : typeof authProvider.getDeviceLicenseContext === 'function'
            ? await authProvider.getDeviceLicenseContext()
            : null;
      if (!deviceContext && (tokenVault || userDataDir)) {
        const { ensureDeviceLicenseContext } = getClepMod();
        deviceContext = await ensureDeviceLicenseContext({
          tokenVault,
          userDataDir,
          fetchImpl,
          msaStoreToken,
        });
      }
      if (!deviceContext) return '';

      const { acquireStoreLicenseToken } = getClepMod();
      const baseStoreId = String(parentProductId || gameMetadata.storeId || productIds[0] || '')
        .trim()
        .toUpperCase();
      const res = await acquireStoreLicenseToken({
        parentProductId: baseStoreId,
        productIds:
          Array.isArray(productIds) && productIds.length > 0
            ? productIds
            : baseStoreId
              ? [baseStoreId]
              : [],
        customDeveloperString,
        msaStoreToken,
        deviceContext,
        fetchImpl,
      });
      if (typeof res === 'string') return res;
      return String(res?.token || res?.licenseToken || res?.LicenseToken || '');
    } catch {
      return '';
    }
  }

  return {
    async queryEntitlements() {
      const ent = await getCachedEntitlements();
      return {
        ownedProductIds: Array.from(ent.ownedProductIds || []),
        subscriptionProductIds: Array.from((ent.subscriptionSatisfiedIds || new Map()).keys()),
      };
    },

    /** @param {{ storeId?: string, packageFamilyName?: string }} [params] */
    async getGameLicense({ storeId } = {}) {
      const baseStoreId = String(gameMetadata.storeId || '').trim().toUpperCase();
      const cleanId = String(storeId || baseStoreId).trim().toUpperCase();
      const ent = await getCachedEntitlements();
      const isOwned = Boolean(cleanId && ent.ownedProductIds?.has?.(cleanId));
      const isSubscriptionEntitled = Boolean(
        cleanId && ent.subscriptionSatisfiedIds?.has?.(cleanId)
      );
      const isInstalledDlc = Boolean(cleanId && installedDlcStoreIds.has(cleanId));
      const isOfflineBaseGame = Boolean(!cleanId || (baseStoreId && cleanId === baseStoreId));

      // When live entitlements are authoritatively fetched, report real entitlement state
      // instead of unconditional `isActive: true`. Only fall back to active for the launched
      // base title or locally installed DLC when offline / entitlements cannot be verified.
      const isActive = ent.authoritative
        ? Boolean(isOwned || isSubscriptionEntitled)
        : Boolean(isOwned || isSubscriptionEntitled || isInstalledDlc || isOfflineBaseGame);

      const skuId = ent.ownedSkuByProduct?.get?.(cleanId) || '0010';
      return {
        skuStoreId: cleanId ? `${cleanId}/${skuId}` : '9N0000000000/0010',
        isActive,
        isTrialOwnedByThisUser: false,
        isDiscLicense: false,
        isTrial: false,
        trialTimeRemainingInSeconds: 0,
        trialUniqueId: '',
        expirationDate: isActive ? Math.floor(Date.now() / 1000) + 30 * 86400 : 0,
      };
    },

    /** @param {Record<string, any>} [params] */
    async queryProducts({
      mode = 'xstore.queryProducts',
      productKinds = 0x1f,
      storeIds = [],
      maxItems = 25,
      baseStoreId = '',
      dlcPackages = [],
    } = {}) {
      const ent = await getCachedEntitlements();
      const effectiveBaseId = String(baseStoreId || gameMetadata.storeId || '')
        .trim()
        .toUpperCase();
      const dlcList =
        Array.isArray(dlcPackages) && dlcPackages.length > 0
          ? dlcPackages
          : Array.isArray(options.dlcPackages)
            ? options.dlcPackages
            : [];

      const candidateSet = new Set();
      if (mode === 'xstore.queryProducts') {
        for (const id of storeIds || []) {
          const clean = String(id || '').trim().toUpperCase();
          if (clean) candidateSet.add(clean);
        }
      } else {
        if (effectiveBaseId) candidateSet.add(effectiveBaseId);
        for (const id of storeIds || []) {
          const clean = String(id || '').trim().toUpperCase();
          if (clean) candidateSet.add(clean);
        }
        for (const dlc of dlcList) {
          const clean = String(dlc?.storeId || '').trim().toUpperCase();
          if (clean) candidateSet.add(clean);
        }
        if (mode === 'xstore.queryEntitledProducts') {
          for (const id of ent.ownedProductIds || []) candidateSet.add(id);
          for (const id of (ent.subscriptionSatisfiedIds || new Map()).keys()) {
            candidateSet.add(id);
          }
        }
      }

      const cap = Math.max(1, Math.min(Number(maxItems) || 25, 100));
      const candidateIds = Array.from(candidateSet).slice(0, cap);
      let hydrated = new Map();
      if (candidateIds.length > 0) {
        try {
          const { lookupDisplayCatalogProducts } = getCatalogMod();
          hydrated = await lookupDisplayCatalogProducts(candidateIds, {
            market: resolvedMarket,
            languages: resolvedLocale,
            cacheStore,
            fetchImpl,
          });
        } catch {
          // Offline fallback handled below
        }
      }

      const dlcByStoreId = new Map();
      for (const dlc of dlcList) {
        if (dlc?.storeId) dlcByStoreId.set(String(dlc.storeId).toUpperCase(), dlc);
      }

      const products = [];
      for (const cid of candidateIds) {
        const isBase = Boolean(effectiveBaseId && cid === effectiveBaseId);
        const prod = hydrated.get(cid);
        if (prod) {
          const mapped = mapCatalogProductToXStore(prod, cid, ent, isBase);
          if (dlcByStoreId.has(cid)) {
            mapped.isInUserCollection = true;
          }
          if ((mapped.productKind & productKinds) !== 0) {
            products.push(mapped);
          }
        } else if (isBase || dlcByStoreId.has(cid)) {
          const dlc = dlcByStoreId.get(cid);
          const fallbackKind = isBase ? 0x04 : 0x02;
          const isEntitledOrOffline =
            !ent.authoritative ||
            Boolean(ent.ownedProductIds?.has?.(cid) || ent.subscriptionSatisfiedIds?.has?.(cid)) ||
            dlcByStoreId.has(cid);
          if ((fallbackKind & productKinds) !== 0) {
            products.push({
              storeId: cid,
              title: isBase
                ? String(gameMetadata.displayName || 'Xbox Game')
                : String(dlc?.displayName || cid),
              description: '',
              language: resolvedLocale,
              inAppOfferToken: '',
              linkUri: `ms-windows-store://pdp/?ProductId=${cid}`,
              productKind: fallbackKind,
              hasDigitalDownload: true,
              isInUserCollection: isEntitledOrOffline,
              skuId: '0010',
              currencyCode: 'USD',
              price: 0,
              basePrice: 0,
              formattedPrice: '$0.00',
              formattedBasePrice: '$0.00',
              isOnSale: false,
            });
          }
        }
      }

      return { products };
    },

    /** @param {{ storeId?: string, dlcPackages?: any[] }} [params] */
    async queryAddOnLicenses({ storeId = '', dlcPackages = [] } = {}) {
      const ent = await getCachedEntitlements();
      const effectiveBaseId = String(storeId || gameMetadata.storeId || '')
        .trim()
        .toUpperCase();
      const dlcList =
        Array.isArray(dlcPackages) && dlcPackages.length > 0
          ? dlcPackages
          : Array.isArray(options.dlcPackages)
            ? options.dlcPackages
            : [];

      const addonIds = new Set();
      for (const dlc of dlcList) {
        const sid = String(dlc?.storeId || '').trim().toUpperCase();
        if (sid && sid !== effectiveBaseId) addonIds.add(sid);
      }

      const entCandidateIds = [];
      for (const sid of ent.ownedProductIds || []) {
        if (sid && sid !== effectiveBaseId) entCandidateIds.push(sid);
      }
      for (const sid of (ent.subscriptionSatisfiedIds || new Map()).keys()) {
        if (sid && sid !== effectiveBaseId && !entCandidateIds.includes(sid)) {
          entCandidateIds.push(sid);
        }
      }

      const lookupList = Array.from(new Set([...addonIds, ...entCandidateIds.slice(0, 50)]));
      let hydrated = new Map();
      if (lookupList.length > 0) {
        try {
          const { lookupDisplayCatalogProducts } = getCatalogMod();
          hydrated = await lookupDisplayCatalogProducts(lookupList, {
            market: resolvedMarket,
            languages: resolvedLocale,
            cacheStore,
            fetchImpl,
          });
        } catch {
          // Offline fallback handled below
        }
      }

      const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
      const licenses = [];
      for (const sid of lookupList) {
        const prod = hydrated.get(sid);
        const isInstalledDlc = addonIds.has(sid);
        if (prod) {
          const kindStr = String(prod.ProductKind || '').trim().toLowerCase();
          if (kindStr === 'game' && !isInstalledDlc) continue;
          const sku = prod?.DisplaySkuAvailabilities?.[0]?.Sku;
          const skuId =
            String(ent.ownedSkuByProduct?.get?.(sid) || sku?.SkuId || '0010').trim() || '0010';
          const offerToken = String(
            sku?.Properties?.InAppOfferToken || prod?.Properties?.InAppOfferToken || ''
          ).trim();
          licenses.push({
            skuStoreId: `${sid}/${skuId}`,
            inAppOfferToken: offerToken,
            isActive: true,
            expirationDate: exp,
          });
        } else if (isInstalledDlc) {
          const skuId = String(ent.ownedSkuByProduct?.get?.(sid) || '0010').trim() || '0010';
          licenses.push({
            skuStoreId: `${sid}/${skuId}`,
            inAppOfferToken: '',
            isActive: true,
            expirationDate: exp,
          });
        }
      }

      return { licenses };
    },

    queryLicenseToken,

    /** @param {{ serviceTicket?: string, publisherUserId?: string }} [params] */
    async getCollectionsId({ serviceTicket = '', publisherUserId = '' } = {}) {
      if (authProvider && typeof authProvider.getCollectionsId === 'function') {
        try {
          const tok = await authProvider.getCollectionsId({ serviceTicket, publisherUserId });
          if (tok) return String(tok);
        } catch {
          // Fall through to B2C endpoint
        }
      }
      const effFetch = fetchImpl || globalThis.fetch;
      if (
        authProvider &&
        typeof authProvider.getStoreMsaToken === 'function' &&
        typeof effFetch === 'function'
      ) {
        try {
          const msaTicket = await authProvider.getStoreMsaToken({ forLicensing: false });
          if (msaTicket) {
            const res = await effFetch(
              'https://collections.mp.microsoft.com/v6.0/collections/b2ctoken',
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                  Authorization: `WLID1.0="${msaTicket}"`,
                },
                body: JSON.stringify({
                  serviceTicket: String(serviceTicket || ''),
                  publisherUserId: String(publisherUserId || ''),
                }),
                signal: buildXboxFetchSignal(undefined, 15_000),
              }
            );
            if (res.ok) {
              const json = await res.json();
              const b2c = String(json?.token || json?.b2cToken || json?.collectionsId || '');
              if (b2c) return b2c;
            }
          }
        } catch {
          // Fall through to license token fallback
        }
      }
      return queryLicenseToken({
        productIds: gameMetadata.storeId ? [String(gameMetadata.storeId)] : [],
        customDeveloperString: serviceTicket || publisherUserId,
      });
    },

    /** @param {{ serviceTicket?: string, publisherUserId?: string }} [params] */
    async getPurchaseId({ serviceTicket = '', publisherUserId = '' } = {}) {
      if (authProvider && typeof authProvider.getPurchaseId === 'function') {
        try {
          const tok = await authProvider.getPurchaseId({ serviceTicket, publisherUserId });
          if (tok) return String(tok);
        } catch {
          // Fall through to B2C endpoint
        }
      }
      const effFetch = fetchImpl || globalThis.fetch;
      if (
        authProvider &&
        typeof authProvider.getStoreMsaToken === 'function' &&
        typeof effFetch === 'function'
      ) {
        try {
          const msaTicket = await authProvider.getStoreMsaToken({ forLicensing: false });
          if (msaTicket) {
            const res = await effFetch(
              'https://purchase.mp.microsoft.com/v6.0/users/me/b2ctoken',
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                  Authorization: `WLID1.0="${msaTicket}"`,
                },
                body: JSON.stringify({
                  serviceTicket: String(serviceTicket || ''),
                  publisherUserId: String(publisherUserId || ''),
                }),
                signal: buildXboxFetchSignal(undefined, 15_000),
              }
            );
            if (res.ok) {
              const json = await res.json();
              const b2c = String(json?.token || json?.b2cToken || json?.purchaseId || '');
              if (b2c) return b2c;
            }
          }
        } catch {
          // Fall through to license token fallback
        }
      }
      return queryLicenseToken({
        productIds: gameMetadata.storeId ? [String(gameMetadata.storeId)] : [],
        customDeveloperString: serviceTicket || publisherUserId,
      });
    },
  };
}

module.exports = {
  ENTITLEMENT_CACHE_TTL_MS,
  createXboxStoreRuntimeProvider,
};
