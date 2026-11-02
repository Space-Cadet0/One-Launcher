'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  formatWgsUserScidFolderName,
  loadWgsSyncSidecar,
  saveWgsSyncSidecar,
  syncXboxTitleStorage,
} = require('./xboxTitleStorageSync.cjs');
const {
  resolveDefaultXboxLocale,
  postXboxTitlePresenceHeartbeat,
} = require('./xboxAchievementsAndStats.cjs');

const MAX_RPC_FRAME_BYTES = 16 * 1024 * 1024; // 16 MiB (authenticated sockets)
const MAX_UNAUTH_RPC_FRAME_BYTES = 4096; // 4 KiB strict limit until sessionToken/key verified (D8.7)
const MAX_CONCURRENT_SOCKETS = 16;
const DEFAULT_SOCKET_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes
const ENTITLEMENT_CACHE_TTL_MS = 60_000; // 60 seconds
const MAX_DLC_PACKAGES = 32;
const CROCKFORD_BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';
const MINIMAL_1X1_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function computePublisherHash(publisher) {
  const clean = String(publisher || '').trim();
  if (!clean) return '8wekyb3d8bbwe';
  const utf16le = Buffer.from(clean, 'utf16le');
  const digest = crypto.createHash('sha256').update(utf16le).digest();
  let bits = 0n;
  for (let i = 0; i < 8; i++) {
    bits = (bits << 8n) | BigInt(digest[i]);
  }
  // Pad 64 bits -> 65 bits (13 * 5) with 1 trailing zero bit per MSIX PublisherId spec
  bits <<= 1n;
  let out = '';
  for (let i = 12; i >= 0; i--) {
    const idx = Number((bits >> BigInt(i * 5)) & 0x1fn);
    out += CROCKFORD_BASE32[idx];
  }
  return out;
}

function hostPathToWindowsPath(hostPath) {
  const raw = String(hostPath || '').trim();
  if (!raw) return '';
  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    const win = raw.replace(/\//g, '\\');
    return win.length > 3 ? win.replace(/\\+$/, '') : win;
  }
  if (process.platform === 'win32') {
    const resolved = path.resolve(raw).replace(/\//g, '\\');
    return resolved.length > 3 ? resolved.replace(/\\+$/, '') : resolved;
  }
  const slashNorm = path.resolve(raw).replace(/\\/g, '/');
  const lower = slashNorm.toLowerCase();
  const driveCIdx = lower.lastIndexOf('/drive_c/');
  if (driveCIdx >= 0) {
    const rel = slashNorm.slice(driveCIdx + '/drive_c/'.length).replace(/\//g, '\\');
    return rel ? `C:\\${rel.replace(/\\+$/, '')}` : 'C:\\';
  }
  if (lower.endsWith('/drive_c')) {
    return 'C:\\';
  }
  const zRel = slashNorm.replace(/^\/+/, '').replace(/\//g, '\\');
  return zRel ? `Z:\\${zRel.replace(/\\+$/, '')}` : 'Z:\\';
}

function decodeBasicXmlEntities(str) {
  return String(str || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractXmlAttr(tagText, attrName) {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*["']([^"']*)["']`, 'i');
  const m = re.exec(tagText);
  return m ? decodeBasicXmlEntities(m[1]).trim() : '';
}

function extractXmlElementText(xml, tagName) {
  const re = new RegExp(`<(?:\\w+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`, 'i');
  const m = re.exec(xml);
  return m ? decodeBasicXmlEntities(m[1]).trim() : '';
}

function formatGdkPackageIdentifier(rawId, storeId, fallbackSeed) {
  const cleanRaw = String(rawId || '').trim();
  if (cleanRaw && cleanRaw.length <= 32) {
    return cleanRaw;
  }
  const cleanStoreId = String(storeId || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
  const digest = crypto
    .createHash('sha256')
    .update(String(fallbackSeed || cleanRaw || cleanStoreId || 'dlc'))
    .digest('hex');
  if (cleanStoreId) {
    return `${cleanStoreId}_dlc_${digest.slice(0, 12)}`;
  }
  return `dlc_${digest.slice(0, 24)}`;
}

/**
 * Discovers installed Xbox DLC (`XPackageKind_Content`) packages under `<gameRootDir>/.onelauncher-dlc/*`.
 */
function discoverInstalledDlcPackages(gameRootDir) {
  if (!gameRootDir || typeof gameRootDir !== 'string') return [];
  const dlcRoot = path.join(path.resolve(gameRootDir), '.onelauncher-dlc');
  let entries;
  try {
    if (!fs.existsSync(dlcRoot)) return [];
    entries = fs.readdirSync(dlcRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const subdirs = entries
    .filter((e) => e && e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_DLC_PACKAGES);

  const discovered = [];
  for (const dirName of subdirs) {
    const baseDir = path.join(dlcRoot, dirName);
    const candidateRoots = [baseDir, path.join(baseDir, 'Content')];

    let mountHost = baseDir;
    let xmlContent = '';
    for (const cand of candidateRoots) {
      const mgcPath = path.join(cand, 'MicrosoftGame.config');
      const appxPath = path.join(cand, 'AppxManifest.xml');
      try {
        if (fs.existsSync(mgcPath)) {
          xmlContent = fs.readFileSync(mgcPath, 'utf8');
          mountHost = cand;
          break;
        }
        if (fs.existsSync(appxPath)) {
          xmlContent = fs.readFileSync(appxPath, 'utf8');
          mountHost = cand;
          break;
        }
      } catch {}
    }

    let metaJson = null;
    try {
      const metaPath = path.join(baseDir, '.onelauncher-dlc.json');
      if (fs.existsSync(metaPath)) {
        metaJson = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      }
    } catch {}

    // Strip <DevelopmentOnly> blocks before parsing Identity/StoreId
    const cleanXml = xmlContent.replace(/<DevelopmentOnly\b[^>]*>[\s\S]*?<\/DevelopmentOnly>/gi, '');
    const idTagMatch = /<(?:(?:\w+):)?Identity\b([^>]*)>/i.exec(cleanXml);
    const idAttrs = idTagMatch ? idTagMatch[1] : '';

    const identityName =
      String(metaJson?.identityName || '').trim() ||
      extractXmlAttr(idAttrs, 'Name') ||
      `DLC.${dirName.replace(/[^A-Za-z0-9._-]/g, '') || 'Content'}`;
    const publisher =
      String(metaJson?.publisher || '').trim() ||
      extractXmlAttr(idAttrs, 'Publisher') ||
      'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';
    const version =
      String(metaJson?.version || '').trim() ||
      extractXmlAttr(idAttrs, 'Version') ||
      '1.0.0.0';
    const arch =
      String(metaJson?.processorArchitecture || '').trim() ||
      extractXmlAttr(idAttrs, 'ProcessorArchitecture') ||
      'x64';

    const shellMatch = /<(?:(?:\w+):)?ShellVisuals\b([^>]*)>/i.exec(cleanXml);
    const shellDisplayName = shellMatch ? extractXmlAttr(shellMatch[1], 'DefaultDisplayName') : '';
    const rawDisplayName =
      String(metaJson?.displayName || '').trim() ||
      shellDisplayName ||
      extractXmlElementText(cleanXml, 'DisplayName') ||
      identityName;
    const displayName = rawDisplayName.startsWith('ms-resource:') ? identityName : rawDisplayName;

    const xmlStoreId = extractXmlElementText(cleanXml, 'StoreId').toUpperCase();
    const fallbackStoreId = /^[A-Z0-9]{12}$/i.test(dirName) ? dirName.toUpperCase() : '';
    const storeId =
      String(metaJson?.storeId || '').trim().toUpperCase() || xmlStoreId || fallbackStoreId;

    const pubHash = computePublisherHash(publisher);
    const packageFullName =
      String(metaJson?.packageFullName || '').trim() ||
      `${identityName}_${version}_${arch}__${pubHash}`;
    const packageIdentifier = formatGdkPackageIdentifier(
      metaJson?.packageIdentifier,
      storeId,
      packageFullName
    );

    const mountPathWin = hostPathToWindowsPath(mountHost);
    discovered.push({
      packageIdentifier,
      packageFullName,
      storeId,
      displayName,
      version,
      mountPathHost: mountHost,
      mountPathWin,
    });
  }

  return discovered;
}

/**
 * Creates a live `XStore` runtime provider backed by `xboxCatalogAndGamePass.cjs` and
 * `xboxDeviceClep.cjs` with 60s entitlement caching and safe offline fallbacks.
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

  let catalogMod = null;
  let clepMod = null;
  const getCatalogMod = () => {
    if (!catalogMod) catalogMod = require('./xboxCatalogAndGamePass.cjs');
    return catalogMod;
  };
  const getClepMod = () => {
    if (!clepMod) clepMod = require('./xboxDeviceClep.cjs');
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

  let cachedEntitlements = null;
  let cachedEntitlementsAt = 0;
  let inFlightEntitlements = null;

  async function getCachedEntitlements() {
    const now = Date.now();
    if (cachedEntitlements && now - cachedEntitlementsAt < ENTITLEMENT_CACHE_TTL_MS) {
      return cachedEntitlements;
    }
    if (!authProvider) {
      return {
        ownedProductIds: new Set(),
        ownedSkuByProduct: new Map(),
        subscriptionSatisfiedIds: new Map(),
        totalRawCount: 0,
      };
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
        return (
          cachedEntitlements || {
            ownedProductIds: new Set(),
            ownedSkuByProduct: new Map(),
            subscriptionSatisfiedIds: new Map(),
            totalRawCount: 0,
          }
        );
      } finally {
        inFlightEntitlements = null;
      }
    })();

    return inFlightEntitlements;
  }

  function mapProductKindBit(rawKind, isBaseGame = false) {
    const k = String(rawKind || '').trim().toLowerCase();
    if (k === 'game') return 0x04;
    if (k === 'durable') return 0x02;
    if (k === 'consumable') return 0x01;
    if (k === 'unmanagedconsumable') return 0x10;
    return isBaseGame ? 0x04 : 0x02;
  }

  function formatCompactPrice(amount, currencyCode) {
    const num = Number.isFinite(Number(amount)) ? Number(amount) : 0;
    const cur = String(currencyCode || 'USD').toUpperCase();
    const raw = cur === 'USD' ? `$${num.toFixed(2)}` : `${num.toFixed(2)} ${cur}`;
    return raw.slice(0, 15);
  }

  function mapCatalogProductToXStore(prod, storeIdFallback, entitlements, isBaseGame = false) {
    const storeId = String(prod?.ProductId || storeIdFallback || '').trim().toUpperCase();
    const loc = Array.isArray(prod?.LocalizedProperties) ? prod.LocalizedProperties[0] : null;
    const dsaList = Array.isArray(prod?.DisplaySkuAvailabilities)
      ? prod.DisplaySkuAvailabilities
      : [];
    const chosenDsa =
      dsaList.find((d) => !d?.Sku?.Properties?.IsTrial) || dsaList[0] || null;
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
    const isInUserCollection = Boolean(
      isBaseGame ||
        entitlements?.ownedProductIds?.has?.(storeId) ||
        entitlements?.subscriptionSatisfiedIds?.has?.(storeId)
    );

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
        productIds: Array.isArray(productIds) && productIds.length > 0 ? productIds : baseStoreId ? [baseStoreId] : [],
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

    /** @param {{ storeId?: string }} [params] */
    async getGameLicense({ storeId } = {}) {
      const cleanId = String(storeId || gameMetadata.storeId || '').trim().toUpperCase();
      const ent = await getCachedEntitlements();
      const skuId = ent.ownedSkuByProduct?.get?.(cleanId) || '0010';
      return {
        skuStoreId: cleanId ? `${cleanId}/${skuId}` : '9N0000000000/0010',
        isActive: true,
        isTrialOwnedByThisUser: false,
        isDiscLicense: false,
        isTrial: false,
        trialTimeRemainingInSeconds: 0,
        trialUniqueId: '',
        expirationDate: Math.floor(Date.now() / 1000) + 30 * 86400,
      };
    },

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
      const dlcList = Array.isArray(dlcPackages) && dlcPackages.length > 0
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
        } catch {}
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
              isInUserCollection: true,
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

    async queryAddOnLicenses({ storeId = '', dlcPackages = [] } = {}) {
      const ent = await getCachedEntitlements();
      const effectiveBaseId = String(storeId || gameMetadata.storeId || '')
        .trim()
        .toUpperCase();
      const dlcList = Array.isArray(dlcPackages) && dlcPackages.length > 0
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
        } catch {}
      }

      const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
      const licenses = [];
      for (const sid of lookupList) {
        const prod = hydrated.get(sid);
        const isInstalledDlc = addonIds.has(sid);
        if (prod) {
          const kindStr = String(prod.ProductKind || '').trim().toLowerCase();
          // Exclude unrelated standalone base games from add-on licenses unless installed in .onelauncher-dlc
          if (kindStr === 'game' && !isInstalledDlc) continue;
          // If baseStoreId is known and AllowedPlatforms/Satisfying/Related exists, keep add-ons
          const sku = prod?.DisplaySkuAvailabilities?.[0]?.Sku;
          const skuId = String(ent.ownedSkuByProduct?.get?.(sid) || sku?.SkuId || '0010').trim() || '0010';
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

    async getCollectionsId({ serviceTicket = '', publisherUserId = '' } = {}) {
      if (authProvider && typeof authProvider.getCollectionsId === 'function') {
        try {
          const tok = await authProvider.getCollectionsId({ serviceTicket, publisherUserId });
          if (tok) return String(tok);
        } catch {}
      }
      const effFetch = fetchImpl || globalThis.fetch;
      if (authProvider && typeof authProvider.getStoreMsaToken === 'function' && typeof effFetch === 'function') {
        try {
          const msaTicket = await authProvider.getStoreMsaToken({ forLicensing: false });
          if (msaTicket) {
            const res = await effFetch('https://collections.mp.microsoft.com/v6.0/collections/b2ctoken', {
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
            });
            if (res.ok) {
              const json = await res.json();
              const b2c = String(json?.token || json?.b2cToken || json?.collectionsId || '');
              if (b2c) return b2c;
            }
          }
        } catch {}
      }
      return queryLicenseToken({
        productIds: gameMetadata.storeId ? [String(gameMetadata.storeId)] : [],
        customDeveloperString: serviceTicket || publisherUserId,
      });
    },

    async getPurchaseId({ serviceTicket = '', publisherUserId = '' } = {}) {
      if (authProvider && typeof authProvider.getPurchaseId === 'function') {
        try {
          const tok = await authProvider.getPurchaseId({ serviceTicket, publisherUserId });
          if (tok) return String(tok);
        } catch {}
      }
      const effFetch = fetchImpl || globalThis.fetch;
      if (authProvider && typeof authProvider.getStoreMsaToken === 'function' && typeof effFetch === 'function') {
        try {
          const msaTicket = await authProvider.getStoreMsaToken({ forLicensing: false });
          if (msaTicket) {
            const res = await effFetch('https://purchase.mp.microsoft.com/v6.0/users/me/b2ctoken', {
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
            });
            if (res.ok) {
              const json = await res.json();
              const b2c = String(json?.token || json?.b2cToken || json?.purchaseId || '');
              if (b2c) return b2c;
            }
          }
        } catch {}
      }
      return queryLicenseToken({
        productIds: gameMetadata.storeId ? [String(gameMetadata.storeId)] : [],
        customDeveloperString: serviceTicket || publisherUserId,
      });
    },
  };
}

function verifySessionKeyConstantTime(candidateKey, expectedKeyBuf) {
  if (typeof candidateKey !== 'string' || candidateKey.length !== 64) {
    return false;
  }
  const candBuf = Buffer.from(candidateKey, 'utf8');
  if (candBuf.length !== expectedKeyBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(candBuf, expectedKeyBuf);
}

function encodeRpcFrame(payloadObj) {
  const jsonBuf = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const frame = Buffer.allocUnsafe(4 + jsonBuf.length);
  frame.writeUInt32LE(jsonBuf.length, 0);
  jsonBuf.copy(frame, 4);
  return frame;
}

/**
 * Idempotently resolves `{ wgsUserDir, xgsUserDir }` from either a `SystemAppData`
 * directory OR an already-appended `.../SystemAppData/wgs` directory (preventing `wgs/wgs`).
 */
function resolveTitleSaveDirs(baseSaveDirInput, hexXuidScidInput) {
  let baseSaveDir = baseSaveDirInput;
  let hexXuidScid = hexXuidScidInput;
  if (baseSaveDirInput && typeof baseSaveDirInput === 'object') {
    baseSaveDir =
      baseSaveDirInput.baseSaveDir ||
      baseSaveDirInput.saveRootDir ||
      baseSaveDirInput.wgsRootDir ||
      '';
    hexXuidScid =
      baseSaveDirInput.hexXuidScid ||
      (baseSaveDirInput.xuid && baseSaveDirInput.scid
        ? formatWgsUserScidFolderName(baseSaveDirInput.xuid, baseSaveDirInput.scid)
        : '');
  }
  if (!baseSaveDir || !hexXuidScid) return null;
  const cleanBase = path.resolve(String(baseSaveDir));
  const leaf = path.basename(cleanBase).toLowerCase();
  if (leaf === 'wgs') {
    return {
      wgsUserDir: path.join(cleanBase, hexXuidScid),
      xgsUserDir: path.join(path.dirname(cleanBase), 'xgs', hexXuidScid),
    };
  }
  if (leaf === 'xgs') {
    return {
      wgsUserDir: path.join(path.dirname(cleanBase), 'wgs', hexXuidScid),
      xgsUserDir: path.join(cleanBase, hexXuidScid),
    };
  }
  return {
    wgsUserDir: path.join(cleanBase, 'wgs', hexXuidScid),
    xgsUserDir: path.join(cleanBase, 'xgs', hexXuidScid),
  };
}

function resolveTitleSaveRootDir(baseSaveDir, hexXuidScid) {
  const dirs = resolveTitleSaveDirs(baseSaveDir, hexXuidScid);
  return dirs ? dirs.wgsUserDir : null;
}

/**
 * Starts One Launcher's per-session authenticated `127.0.0.1` loopback RPC server
 * for `one_xgameruntime_bridge.dll` running inside a CrossOver / GPTK / Wine bottle.
 */
function normalizeLoopbackDecimalTitleId(rawTitleId, { preferHex = false } = {}) {
  const s = String(rawTitleId || '').trim();
  if (!s) return '';
  if (/^0x[0-9a-f]{1,8}$/i.test(s)) {
    return String(parseInt(s.slice(2), 16));
  }
  if (/^[0-9a-f]{1,8}$/i.test(s) && (preferHex || /[a-f]/i.test(s))) {
    return String(parseInt(s, 16));
  }
  if (/^\d+$/.test(s)) {
    return String(Number(s));
  }
  return '';
}

async function startXboxRuntimeLoopbackServer(options = {}) {
  const {
    authProvider = null,
    storeProvider = null,
    userProfile = {},
    gameMetadata = {},
    saveRootDir = null, // Host path to bottle's `%LOCALAPPDATA%\Packages\<PFN>\SystemAppData` (or `.../SystemAppData/wgs`)
    wgsRootDir = null, // Optional alias for `.../SystemAppData/wgs`
    bottleUsersDir = null, // Optional host path `<Bottle>/drive_c/users/<wineuser>/AppData/Local`
    enableCloudSaveSync = Boolean(authProvider?.getTokenAndSignatureForUrl),
    titleStorageOrigin,
    fetchImpl,
    onTelemetry,
  } = options;

  const maxConcurrentSockets = Math.max(
    1,
    Math.min(
      MAX_CONCURRENT_SOCKETS,
      Number.isInteger(options.maxConcurrentSockets)
        ? options.maxConcurrentSockets
        : MAX_CONCURRENT_SOCKETS
    )
  );
  const socketIdleTimeoutMs =
    Number(options.socketIdleTimeoutMs) > 0
      ? Number(options.socketIdleTimeoutMs)
      : DEFAULT_SOCKET_IDLE_TIMEOUT_MS;

  const sessionKey = crypto.randomBytes(32).toString('hex'); // 64 hex chars
  const expectedKeyBuf = Buffer.from(sessionKey, 'utf8');
  const activeSockets = new Set();
  const inFlightSaveInits = new Map();
  const VALID_SCID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  /** @type {Set<string>} */
  const activeScids = new Set();

  const initialRawTitleId = String(gameMetadata.titleId || options.titleId || '');
  const resolvedLocale = resolveDefaultXboxLocale(options.locale || gameMetadata.locale);
  const initialInviteUri = String(options.inviteUri || gameMetadata.inviteUri || '').trim();
  const gameRootDir = String(options.gameRootDir || gameMetadata.gameRootDir || '').trim();
  const discoveredDlcs = Array.isArray(options.dlcPackages)
    ? options.dlcPackages
    : gameRootDir
      ? discoverInstalledDlcPackages(gameRootDir)
      : [];

  const state = {
    titleId: initialRawTitleId,
    titleIdDecimal: String(
      gameMetadata.titleIdDecimal ||
        options.titleIdDecimal ||
        normalizeLoopbackDecimalTitleId(initialRawTitleId)
    ),
    scid: String(gameMetadata.scid || options.scid || '').trim().toLowerCase(),
    fallbackScid: String(gameMetadata.fallbackScid || options.fallbackScid || '')
      .trim()
      .toLowerCase(),
    msaAppId: String(gameMetadata.msaAppId || options.msaAppId || ''),
    storeId: String(gameMetadata.storeId || options.storeId || '').trim().toUpperCase(),
    packageFamilyName: String(
      gameMetadata.packageFamilyName || options.packageFamilyName || options.pfn || ''
    ),
    locale: resolvedLocale,
    inviteUri: initialInviteUri,
    dlcPackages: discoveredDlcs,
    lastXuid: String(userProfile?.xuid || ''),
    fullTrust: gameMetadata.fullTrust !== false,
    initializedSaves: new Set(),
    saveQuotas: new Map(),
    /** @type {Promise<any>} */
    pendingSaveChain: Promise.resolve(),
  };

  const effectiveStoreProvider =
    storeProvider ||
    (authProvider
      ? createXboxStoreRuntimeProvider({
          authProvider,
          userProfile,
          gameMetadata: {
            ...gameMetadata,
            storeId: state.storeId,
            locale: state.locale,
          },
          fetchImpl,
          tokenVault: options.tokenVault,
          userDataDir: options.userDataDir,
          cacheStore: options.cacheStore,
          locale: state.locale,
          market: options.market || gameMetadata.market,
          dlcPackages: state.dlcPackages,
        })
      : null);

  const canSendPresence =
    options.enablePresenceHeartbeat === true ||
    (options.enablePresenceHeartbeat !== false &&
      Boolean(authProvider && typeof authProvider.getXstsToken === 'function'));
  const presenceIntervalMs =
    Number(options.presenceHeartbeatIntervalMs) > 0
      ? Number(options.presenceHeartbeatIntervalMs)
      : DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS;
  let presenceTimer = null;
  let presenceActivated = false;
  let isClosing = false;

  async function sendPresenceUpdate(presenceState) {
    if (!canSendPresence) return;
    if (presenceState !== 'inactive' && isClosing) return;
    const tidDec = state.titleIdDecimal;
    if (presenceState !== 'inactive' && (!/^\d+$/.test(tidDec) || Number(tidDec) <= 0)) {
      return;
    }
    if (presenceState === 'active') {
      presenceActivated = true;
    }
    await postXboxTitlePresenceHeartbeat({
      authProvider,
      xuid: state.lastXuid || userProfile?.xuid,
      titleIdDecimal: tidDec,
      state: presenceState,
      fetchImpl,
    });
  }

  function resolveSystemAppDataHostDir(pfnOverride) {
    const explicitSaveRoot = saveRootDir || wgsRootDir;
    if (explicitSaveRoot) return explicitSaveRoot;
    const pfn = pfnOverride || state.packageFamilyName;
    if (bottleUsersDir && pfn) {
      return path.join(bottleUsersDir, 'Packages', pfn, 'SystemAppData');
    }
    return null;
  }

  async function resolveActiveUserProfile() {
    const fromProvider =
      typeof authProvider?.getUserProfile === 'function'
        ? await authProvider.getUserProfile()
        : null;
    const merged = { ...userProfile, ...(fromProvider || {}) };
    const xuid = String(merged.xuid || '2533274790395904');
    const gamertag = String(merged.gamertag || 'PlayerOne').slice(0, 15);
    const modernGamertag = String(merged.modernGamertag || gamertag).slice(0, 96);
    const modernGamertagSuffix = String(merged.modernGamertagSuffix || '');
    const uniqueModernGamertag = String(
      merged.uniqueModernGamertag ||
        (modernGamertagSuffix ? `${modernGamertag}#${modernGamertagSuffix}` : modernGamertag)
    ).slice(0, 100);

    return {
      xuid,
      gamertag,
      modernGamertag,
      modernGamertagSuffix,
      uniqueModernGamertag,
      ageGroup: Number(merged.ageGroup || 3), // XUserAgeGroup_Adult = 3
    };
  }

  async function dispatchRpcMethod(method, params = {}) {
    if (typeof onTelemetry === 'function') {
      try {
        onTelemetry({ event: 'rpc_call', method });
      } catch {
        // Ignore telemetry listener errors
      }
    }

    switch (method) {
      case 'auth':
      case 'session.auth': {
        return { authenticated: true };
      }

      case 'session.init': {
        if (params.titleId) {
          const rawTid = String(params.titleId).trim();
          state.titleId = rawTid;
          const decTid = normalizeLoopbackDecimalTitleId(rawTid, {
            preferHex: /^[0-9A-Fa-f]{8}$/.test(rawTid),
          });
          if (decTid) state.titleIdDecimal = decTid;
        }
        if (params.scid) state.scid = String(params.scid).toLowerCase();
        if (params.msaAppId) state.msaAppId = String(params.msaAppId);
        if (params.storeId) state.storeId = String(params.storeId).toUpperCase();
        if (params.packageFamilyName) state.packageFamilyName = String(params.packageFamilyName);
        if (typeof params.fullTrust === 'boolean') state.fullTrust = params.fullTrust;

        const profile = await resolveActiveUserProfile();
        if (profile.xuid) state.lastXuid = profile.xuid;
        void sendPresenceUpdate('active');

        return {
          ...profile,
          titleId: state.titleId,
          titleIdDecimal: state.titleIdDecimal || undefined,
          scid: state.scid,
          msaAppId: state.msaAppId,
          storeId: state.storeId,
          packageFamilyName: state.packageFamilyName,
          locale: state.locale,
          offline: !authProvider,
          dlcPackages: state.dlcPackages,
          ...(state.inviteUri ? { inviteUri: state.inviteUri } : {}),
          sandbox: 'RETAIL',
        };
      }

      case 'xuser.getTokenAndSignature': {
        const httpMethod = String(params.method || 'GET').toUpperCase();
        const url = String(params.url || '');
        if (!url) {
          throw new Error('xuser.getTokenAndSignature requires a non-empty url');
        }
        const headers = params.headers && typeof params.headers === 'object' ? params.headers : {};
        const bodyBuffer = params.bodyBase64
          ? Buffer.from(String(params.bodyBase64), 'base64')
          : Buffer.alloc(0);

        if (authProvider && typeof authProvider.getTokenAndSignatureForUrl === 'function') {
          const res = await authProvider.getTokenAndSignatureForUrl({
            method: httpMethod,
            url,
            headers,
            body: bodyBuffer,
            bodyBuffer,
            forceRefresh: Boolean(params.forceRefresh),
            options: Number(params.options || 0),
            titleId: state.titleIdDecimal || state.titleId,
            scid: state.scid,
            msaAppId: state.msaAppId,
          });
          return {
            token: String(res?.token || res?.authorization || ''),
            signature: String(res?.signature || ''),
          };
        }

        const profile = await resolveActiveUserProfile();
        return {
          token: `XBL3.0 x=${profile.xuid};offline_session_token`,
          signature: '',
        };
      }

      case 'xuser.getGamerPicture': {
        if (authProvider && typeof authProvider.getGamerPicture === 'function') {
          const pic = await authProvider.getGamerPicture({ size: params.size || 1 });
          if (pic) {
            const b64 = Buffer.isBuffer(pic) ? pic.toString('base64') : String(pic);
            return { pngBase64: b64 };
          }
        }
        return { pngBase64: MINIMAL_1X1_PNG_BASE64 };
      }

      case 'xstore.getGameLicense': {
        if (effectiveStoreProvider && typeof effectiveStoreProvider.getGameLicense === 'function') {
          const lic = await effectiveStoreProvider.getGameLicense({
            storeId: state.storeId,
            packageFamilyName: state.packageFamilyName,
          });
          if (lic) return lic;
        }
        return {
          skuStoreId: state.storeId ? `${state.storeId}/0010` : '9N0000000000/0010',
          isActive: true,
          isTrialOwnedByThisUser: false,
          isDiscLicense: false,
          isTrial: false,
          trialTimeRemainingInSeconds: 0,
          trialUniqueId: '',
          expirationDate: Math.floor(Date.now() / 1000) + 30 * 86400,
        };
      }

      case 'xstore.acquirePackageLicense': {
        const packageIdentifier = String(params.packageIdentifier || '');
        if (effectiveStoreProvider && typeof effectiveStoreProvider.acquirePackageLicense === 'function') {
          const res = await effectiveStoreProvider.acquirePackageLicense({ packageIdentifier });
          if (res) return res;
        }
        return {
          packageIdentifier,
          licensable: true,
        };
      }

      case 'xstore.queryEntitledProducts':
      case 'xstore.queryAssociatedProducts':
      case 'xstore.queryProducts': {
        if (effectiveStoreProvider && typeof effectiveStoreProvider.queryProducts === 'function') {
          const res = await effectiveStoreProvider.queryProducts({
            mode: method,
            productKinds: Number(params.productKinds || 0x1f),
            storeIds: Array.isArray(params.storeIds)
              ? params.storeIds
              : Array.isArray(params.productIds)
                ? params.productIds
                : [],
            maxItems: Number(params.maxItems || 25),
            baseStoreId: state.storeId,
            dlcPackages: state.dlcPackages,
          });
          if (res) return res;
        }
        const defaultProducts = [];
        if (state.storeId && method !== 'xstore.queryProducts') {
          defaultProducts.push({
            storeId: state.storeId,
            title: gameMetadata.displayName || 'Xbox Game',
            description: '',
            language: state.locale || 'en-US',
            inAppOfferToken: '',
            linkUri: '',
            productKind: 0x04, // XStoreProductKind_Game
            hasDigitalDownload: true,
            isInUserCollection: true,
            skuId: '0010',
          });
        }
        return { products: defaultProducts };
      }

      case 'xstore.queryAddOnLicenses': {
        if (effectiveStoreProvider && typeof effectiveStoreProvider.queryAddOnLicenses === 'function') {
          const res = await effectiveStoreProvider.queryAddOnLicenses({
            storeId: state.storeId,
            dlcPackages: state.dlcPackages,
          });
          if (res) return res;
        }
        return { licenses: [] };
      }

      case 'xstore.queryLicenseToken': {
        const productIds = Array.isArray(params.productIds)
          ? params.productIds.map((p) => String(p || '').trim()).filter(Boolean)
          : [];
        const customDeveloperString = String(params.customDeveloperString || '');
        if (effectiveStoreProvider && typeof effectiveStoreProvider.queryLicenseToken === 'function') {
          const token = await effectiveStoreProvider.queryLicenseToken({
            productIds,
            customDeveloperString,
            parentProductId: state.storeId,
          });
          return { token: String(token || '') };
        }
        return { token: '' };
      }

      case 'xstore.getCollectionsId': {
        if (effectiveStoreProvider && typeof effectiveStoreProvider.getCollectionsId === 'function') {
          const token = await effectiveStoreProvider.getCollectionsId({
            serviceTicket: String(params.serviceTicket || ''),
            publisherUserId: String(params.publisherUserId || ''),
          });
          return { token: String(token || '') };
        }
        if (authProvider && typeof authProvider.getCollectionsId === 'function') {
          const token = await authProvider.getCollectionsId({
            serviceTicket: String(params.serviceTicket || ''),
            publisherUserId: String(params.publisherUserId || ''),
          });
          return { token: String(token || '') };
        }
        return { token: '' };
      }

      case 'xstore.getPurchaseId': {
        if (effectiveStoreProvider && typeof effectiveStoreProvider.getPurchaseId === 'function') {
          const token = await effectiveStoreProvider.getPurchaseId({
            serviceTicket: String(params.serviceTicket || ''),
            publisherUserId: String(params.publisherUserId || ''),
          });
          return { token: String(token || '') };
        }
        if (authProvider && typeof authProvider.getPurchaseId === 'function') {
          const token = await authProvider.getPurchaseId({
            serviceTicket: String(params.serviceTicket || ''),
            publisherUserId: String(params.publisherUserId || ''),
          });
          return { token: String(token || '') };
        }
        return { token: '' };
      }

      case 'xgamesave.init': {
        const profile = await resolveActiveUserProfile();
        const xuid = String(params.xuid || profile.xuid);
        const scid = String(params.scid || state.scid).trim().toLowerCase();
        if (VALID_SCID_UUID_RE.test(scid)) {
          activeScids.add(scid);
        }
        const pfn = String(params.packageFamilyName || state.packageFamilyName);
        const hexXuidScid = formatWgsUserScidFolderName(xuid, scid);
        const sysAppDataDir = resolveSystemAppDataHostDir(pfn);

        let quotaBytes = 256 * 1024 * 1024;
        let synced = false;

        if (sysAppDataDir && scid && enableCloudSaveSync) {
          const saveDirs = resolveTitleSaveDirs(sysAppDataDir, hexXuidScid);
          const { wgsUserDir, xgsUserDir } = saveDirs;
          const syncKey = `${xuid}:${scid}`;
          if (state.initializedSaves.has(syncKey)) {
            synced = true;
            quotaBytes = state.saveQuotas.get(syncKey) || quotaBytes;
          } else {
            let initPromise = inFlightSaveInits.get(syncKey);
            if (!initPromise) {
              const executeInit = async () => {
                const res = await syncXboxTitleStorage({
                  mode: 'pre_launch',
                  wgsUserDir,
                  xgsUserDir,
                  xuid,
                  scid,
                  fallbackScid: state.fallbackScid || state.scid,
                  preserveLocalWgsDirOnFallback: true,
                  packageFamilyName: pfn,
                  msaAppId: state.msaAppId,
                  titleId: state.titleId,
                  authProvider,
                  titleStorageOrigin,
                  fetchImpl,
                });
                const resolvedQuota = res?.quotaBytes || 256 * 1024 * 1024;
                const resolvedSynced = Boolean(res?.synced);
                state.saveQuotas.set(syncKey, resolvedQuota);
                state.initializedSaves.add(syncKey);
                return { quotaBytes: resolvedQuota, synced: resolvedSynced };
              };
              const chained = state.pendingSaveChain.then(executeInit, executeInit);
              state.pendingSaveChain = chained.catch(() => {});
              initPromise = chained.finally(() => {
                inFlightSaveInits.delete(syncKey);
              });
              inFlightSaveInits.set(syncKey, initPromise);
            }
            const initRes = await initPromise;
            quotaBytes = initRes.quotaBytes;
            synced = initRes.synced;
          }
        }

        return {
          synced,
          quotaBytes,
          hexXuidScid,
          scid,
          packageFamilyName: pfn,
        };
      }

      case 'xgamesave.commit': {
        try {
          const profile = await resolveActiveUserProfile();
          const xuid = String(params.xuid || profile.xuid);
          const scid = String(params.scid || state.scid).trim().toLowerCase();
          if (VALID_SCID_UUID_RE.test(scid)) {
            activeScids.add(scid);
          }
          const pfn = String(params.packageFamilyName || state.packageFamilyName);
          const containerName = String(params.containerName || '');
          const deleted = Boolean(params.deleted);
          const hexXuidScid = formatWgsUserScidFolderName(xuid, scid);
          const sysAppDataDir = resolveSystemAppDataHostDir(pfn);

          if (sysAppDataDir && scid) {
            const { wgsUserDir, xgsUserDir } = resolveTitleSaveDirs(sysAppDataDir, hexXuidScid);

            const enqueueCommit = async () => {
              try {
                if (deleted && containerName) {
                  const sidecar = await loadWgsSyncSidecar(wgsUserDir);
                  if (!sidecar.deletedContainers.includes(containerName)) {
                    sidecar.deletedContainers.push(containerName);
                    await saveWgsSyncSidecar(wgsUserDir, sidecar);
                  }
                }
                if (enableCloudSaveSync) {
                  await syncXboxTitleStorage({
                    mode: 'in_session',
                    wgsUserDir,
                    xgsUserDir,
                    xuid,
                    scid,
                    fallbackScid: state.fallbackScid || state.scid,
                    preserveLocalWgsDirOnFallback: true,
                    packageFamilyName: pfn,
                    msaAppId: state.msaAppId,
                    titleId: state.titleId,
                    authProvider,
                    titleStorageOrigin,
                    fetchImpl,
                  });
                }
              } catch (commitErr) {
                if (typeof onTelemetry === 'function') {
                  try {
                    onTelemetry({
                      event: 'rpc_commit_error',
                      error: commitErr?.message || String(commitErr),
                    });
                  } catch {
                    // Ignore telemetry listener errors
                  }
                }
                throw commitErr;
              }
            };

            const commitPromise = state.pendingSaveChain.then(enqueueCommit, enqueueCommit);
            state.pendingSaveChain = commitPromise.catch(() => {});
            if (params.waitForCloud === true) {
              await commitPromise;
            }
          }

          return {
            committed: true,
            remainingQuota: 256 * 1024 * 1024,
          };
        } catch (err) {
          throw Object.assign(
            err instanceof Error ? err : new Error(String(err)),
            {
              hr: Number.isInteger(err?.hr) ? err.hr : -2147467259, // E_FAIL (0x80004005)
            }
          );
        }
      }

      default:
        throw Object.assign(new Error(`Unsupported XGR RPC method: ${method}`), {
          hr: -2147467263, // E_NOTIMPL (0x80004001)
        });
    }
  }

  const server = net.createServer((socket) => {
    if (activeSockets.size >= maxConcurrentSockets) {
      socket.destroy();
      return;
    }

    activeSockets.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(socketIdleTimeoutMs);
    socket.on('timeout', () => {
      socket.destroy();
    });

    // Two-stage O(1) frame reader: 4-byte length header -> single Buffer.allocUnsafe(bodyLen) + cursor copy
    const headerBuf = Buffer.allocUnsafe(4);
    let headerFilled = 0;
    let bodyLen = 0;
    let frameBuf = null;
    let frameFilled = 0;
    let socketAuthenticated = false;
    const parsedReqQueue = [];

    const drainParsedReqQueue = async () => {
      while (parsedReqQueue.length > 0 && !socket.destroyed) {
        const req = parsedReqQueue.shift();
        const reqId = req.id ?? 0;
        try {
          const result = await dispatchRpcMethod(String(req.method || ''), req.params || {});
          if (!socket.destroyed) {
            socket.write(encodeRpcFrame({ id: reqId, ok: true, hr: 0, result }));
          }
        } catch (err) {
          const hr = Number.isInteger(err?.hr) ? err.hr : -2147467259; // E_FAIL (0x80004005)
          if (!socket.destroyed) {
            socket.write(
              encodeRpcFrame({
                id: reqId,
                ok: false,
                hr,
                error: err?.message || String(err),
              })
            );
          }
        }
      }
    };

    let processingChain = Promise.resolve();

    socket.on('data', (chunk) => {
      let offset = 0;
      while (offset < chunk.length && !socket.destroyed) {
        if (headerFilled < 4) {
          const needHeader = 4 - headerFilled;
          const takeHeader = Math.min(needHeader, chunk.length - offset);
          chunk.copy(headerBuf, headerFilled, offset, offset + takeHeader);
          headerFilled += takeHeader;
          offset += takeHeader;
          if (headerFilled < 4) {
            break;
          }

          bodyLen = headerBuf.readUInt32LE(0);
          const maxAllowed = socketAuthenticated
            ? MAX_RPC_FRAME_BYTES
            : MAX_UNAUTH_RPC_FRAME_BYTES;
          if (bodyLen === 0 || bodyLen > maxAllowed) {
            socket.destroy();
            return;
          }
          frameBuf = Buffer.allocUnsafe(bodyLen);
          frameFilled = 0;
        }

        const needBody = bodyLen - frameFilled;
        const takeBody = Math.min(needBody, chunk.length - offset);
        chunk.copy(frameBuf, frameFilled, offset, offset + takeBody);
        frameFilled += takeBody;
        offset += takeBody;

        if (frameFilled === bodyLen) {
          const completedBuf = frameBuf;
          frameBuf = null;
          frameFilled = 0;
          headerFilled = 0;
          bodyLen = 0;

          let req;
          try {
            req = JSON.parse(completedBuf.toString('utf8'));
          } catch {
            socket.destroy();
            return;
          }

          const candidateToken = req && typeof req === 'object' ? (req.key ?? req.sessionToken) : '';
          if (!req || !verifySessionKeyConstantTime(candidateToken, expectedKeyBuf)) {
            socket.destroy();
            return;
          }

          socketAuthenticated = true;
          parsedReqQueue.push(req);
        }
      }

      if (parsedReqQueue.length > 0 && !socket.destroyed) {
        processingChain = processingChain.then(drainParsedReqQueue, drainParsedReqQueue);
      }
    });

    socket.on('error', () => {
      socket.destroy();
    });

    socket.on('close', () => {
      activeSockets.delete(socket);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  if (canSendPresence) {
    if (/^\d+$/.test(state.titleIdDecimal) && Number(state.titleIdDecimal) > 0) {
      void sendPresenceUpdate('active');
    }
    presenceTimer = setInterval(() => {
      void sendPresenceUpdate('active');
    }, presenceIntervalMs);
    if (typeof presenceTimer.unref === 'function') {
      presenceTimer.unref();
    }
  }

  const initialSaveRootHost = resolveSystemAppDataHostDir(state.packageFamilyName);
  const initialSaveRootWin = initialSaveRootHost ? hostPathToWindowsPath(initialSaveRootHost) : '';

  let closePromise = null;
  async function closeServer() {
    if (closePromise) return closePromise;
    isClosing = true;
    if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
    closePromise = (async () => {
      await state.pendingSaveChain.catch(() => {});
      if (presenceActivated) {
        await sendPresenceUpdate('inactive');
      }
      for (const sock of activeSockets) {
        sock.destroy();
      }
      activeSockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    })();
    return closePromise;
  }

  return {
    host: '127.0.0.1',
    port,
    sessionKey,
    storeProvider: effectiveStoreProvider,
    env: {
      ONE_XGR_PORT: String(port),
      ONE_XGR_KEY: sessionKey,
      ONE_XGR_LOCALE: state.locale,
      ...(initialSaveRootWin ? { ONE_XGR_SAVE_ROOT: initialSaveRootWin } : {}),
      ...(state.inviteUri ? { ONE_XGR_INVITE_URI: state.inviteUri } : {}),
    },
    getState() {
      return {
        titleId: state.titleId,
        titleIdDecimal: state.titleIdDecimal || undefined,
        scid: state.scid,
        fallbackScid: state.fallbackScid,
        msaAppId: state.msaAppId,
        storeId: state.storeId,
        packageFamilyName: state.packageFamilyName,
        locale: state.locale,
        dlcPackages: state.dlcPackages,
      };
    },
    getActiveScids() {
      return Array.from(activeScids);
    },
    async flushPendingSaves() {
      await state.pendingSaveChain.catch(() => {});
    },
    close: closeServer,
    stop: closeServer,
  };
}

module.exports = {
  MAX_RPC_FRAME_BYTES,
  MAX_UNAUTH_RPC_FRAME_BYTES,
  MAX_CONCURRENT_SOCKETS,
  DEFAULT_SOCKET_IDLE_TIMEOUT_MS,
  DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS,
  verifySessionKeyConstantTime,
  encodeRpcFrame,
  resolveTitleSaveDirs,
  resolveTitleSaveRootDir,
  hostPathToWindowsPath,
  discoverInstalledDlcPackages,
  createXboxStoreRuntimeProvider,
  startXboxRuntimeLoopbackServer,
};
