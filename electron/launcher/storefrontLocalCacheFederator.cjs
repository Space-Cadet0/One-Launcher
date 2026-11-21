// @ts-check
'use strict';

const cacheRootDiscovery = require('./federator/cacheRootDiscovery.cjs');
const steamFederator = require('./federator/steamFederator.cjs');
const gogFederator = require('./federator/gogFederator.cjs');
const epicFederator = require('./federator/epicFederator.cjs');
const xboxManifestFederator = require('./federator/xboxManifestFederator.cjs');

const {
  detectImageMagicBytes,
  validateFederatedImageFile,
  validateFederatedImageFileAsync,
  resolveFederatorUserDataDir,
  discoverWindowsLocalDrivesAsync,
  getKnownWindowsLocalDrivesSync,
  clearCachedWindowsLocalDrives,
  discoverStorefrontCacheRoots,
  discoverStorefrontCacheRootsAsync,
  invalidateStorefrontCacheRoots,
  isFederatedStoreUrlCompatible,
  extractSteamAppIdFromParams,
  extractGogIdFromParams,
  extractEpicAppNameFromParams,
  extractXboxParams,
} = cacheRootDiscovery;

const {
  resolveSteamFederatedAsset,
  resolveSteamFederatedAssetAsync,
  resolveLocalSteamMetadata,
  resolveLocalSteamMetadataAsync,
} = steamFederator;

const {
  resolveGogFederatedAsset,
  resolveGogFederatedAssetAsync,
  resolveLocalGogMetadata,
  listLocalGogCatalogGames,
  clearGogFederatorCaches,
} = gogFederator;

const {
  resolveHeroicImagesCacheAsset,
  resolveHeroicImagesCacheAssetAsync,
  parseLegendaryMetadataJson,
  resolveLocalEpicMetadata,
  resolveLocalEpicMetadataAsync,
  listLocalEpicCatalogGames,
  resolveLocalAmazonMetadata,
} = epicFederator;

const {
  parseMicrosoftGameConfigXml,
  resolveXboxFederatedAsset,
  resolveXboxFederatedAssetAsync,
  resolveLocalXboxMetadata,
  resolveLocalXboxMetadataAsync,
  listLocalXboxInstalledGames,
  clearXboxManifestCaches,
} = xboxManifestFederator;

/**
 * Synchronous zero-I/O pre-check indicating whether a media asset request could possibly match
 * any first-party storefront local cache (used by `OfflineVaultService.resolveMediaRequest` to
 * skip Tier-2 without awaiting when URLs are non-storefront CDNs or explicit roots are empty).
 *
 * @param {Record<string, any>} [params]
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function canPotentiallyFederateAsset(params = {}, options = {}) {
  if (!params || typeof params !== 'object') return false;
  if (params.ov) {
    const ovStr = String(params.ov).trim().toLowerCase();
    if (ovStr && ovStr !== '0' && ovStr !== 'false') {
      return false;
    }
  }
  const role = String(params.role || 'cover').trim().toLowerCase();
  const ordinal = Number(params.ordinal ?? params.ord ?? 0) || 0;
  if (role === 'achievement_icon' || (role === 'icon' && ordinal > 0)) {
    return false;
  }
  const url = typeof params.url === 'string' ? params.url.trim() : '';

  const steamAppId = extractSteamAppIdFromParams(params);
  const canSteam = Boolean(
    steamAppId &&
      isFederatedStoreUrlCompatible('steam', url, { steamAppId }) &&
      !(Array.isArray(options.steamRoots) && options.steamRoots.length === 0)
  );
  if (canSteam) return true;

  const gogId = extractGogIdFromParams(params);
  const explicitGogEmpty =
    (Array.isArray(options.gogGalaxyRoots) && options.gogGalaxyRoots.length === 0) ||
    (Array.isArray(options.gogRoots) && options.gogRoots.length === 0);
  const canGog = Boolean(
    gogId && isFederatedStoreUrlCompatible('gog', url, { gogId }) && !explicitGogEmpty
  );
  if (canGog) return true;

  const xboxParams = extractXboxParams(params);
  const explicitXboxEmpty =
    Array.isArray(options.xboxGamesRoots) &&
    options.xboxGamesRoots.length === 0 &&
    (!options.xboxAppCacheDirs ||
      (Array.isArray(options.xboxAppCacheDirs) && options.xboxAppCacheDirs.length === 0));
  const canXbox = Boolean(
    (xboxParams.productId || xboxParams.pfn || xboxParams.titleId) &&
      isFederatedStoreUrlCompatible('xbox', url, xboxParams) &&
      !explicitXboxEmpty
  );
  if (canXbox) return true;

  const epicAppName = extractEpicAppNameFromParams(params);
  const explicitHeroicEmpty =
    Array.isArray(options.heroicRoots) && options.heroicRoots.length === 0;
  const canEpic = Boolean(
    (epicAppName || url) &&
      isFederatedStoreUrlCompatible('epic', url, { epicAppName }) &&
      !explicitHeroicEmpty
  );
  return canEpic;
}

/**
 * Unified zero-copy local first-party cache resolver across Steam, GOG Galaxy, Heroic, and Xbox.
 *
 * @param {Record<string, any>} [params]
 * @param {Record<string, any>} [options]
 */
function resolveFederatedAsset(params = {}, options = {}) {
  if (!params || typeof params !== 'object') return null;
  if (params.ov) {
    const ovStr = String(params.ov).trim().toLowerCase();
    if (ovStr && ovStr !== '0' && ovStr !== 'false') {
      return null;
    }
  }
  const role = String(params.role || 'cover').trim().toLowerCase();
  const ordinal = Number(params.ordinal ?? params.ord ?? 0) || 0;
  if (role === 'achievement_icon' || (role === 'icon' && ordinal > 0)) {
    return null;
  }
  const url = typeof params.url === 'string' ? params.url.trim() : '';
  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);

  const steamAppId = extractSteamAppIdFromParams(params);
  if (
    steamAppId &&
    roots.steamRoots.length > 0 &&
    isFederatedStoreUrlCompatible('steam', url, { steamAppId })
  ) {
    const steamHit = resolveSteamFederatedAsset(steamAppId, role, url, roots, options);
    if (steamHit) return steamHit;
  }

  const gogId = extractGogIdFromParams(params);
  if (
    gogId &&
    roots.gogRoots.length > 0 &&
    isFederatedStoreUrlCompatible('gog', url, { gogId })
  ) {
    const gogHit = resolveGogFederatedAsset(gogId, role, url, roots, options);
    if (gogHit) return gogHit;
  }

  const xboxParams = extractXboxParams(params);
  if (
    (xboxParams.productId || xboxParams.pfn || xboxParams.titleId) &&
    ((roots.xboxGamesRoots && roots.xboxGamesRoots.length > 0) ||
      (roots.xboxAppCacheDirs && roots.xboxAppCacheDirs.length > 0)) &&
    isFederatedStoreUrlCompatible('xbox', url, xboxParams)
  ) {
    const xboxHit = resolveXboxFederatedAsset(xboxParams, role, url, roots, {
      ...options,
      title: params.title || options.title,
    });
    if (xboxHit) return xboxHit;
  }

  const epicAppName = extractEpicAppNameFromParams(params);
  if (isFederatedStoreUrlCompatible('epic', url, { epicAppName })) {
    let effectiveUrl = url;
    if (
      !effectiveUrl &&
      epicAppName &&
      roots.legendaryDirs.length > 0 &&
      roots.heroicRoots.length > 0
    ) {
      const localEpic = resolveLocalEpicMetadata(epicAppName, {
        ...options,
        _precomputedRoots: roots,
      });
      if (localEpic) {
        if (role === 'cover' && localEpic.capsuleImage) {
          effectiveUrl = localEpic.capsuleImage;
        } else if (role === 'header' && localEpic.headerImage) {
          effectiveUrl = localEpic.headerImage;
        }
      }
    }

    if (effectiveUrl && roots.heroicRoots.length > 0) {
      const heroicHit = resolveHeroicImagesCacheAsset(effectiveUrl, roots, options);
      if (heroicHit) return heroicHit;
    }
  }

  return null;
}

/**
 * Async variant of `resolveFederatedAsset` using `fs.promises` for Tier-2 Steam/GOG/Heroic/Xbox
 * local cache walks so async media requests never stall Electron's main thread.
 *
 * @param {Record<string, any>} [params]
 * @param {Record<string, any>} [options]
 */
async function resolveFederatedAssetAsync(params = {}, options = {}) {
  if (!params || typeof params !== 'object') return null;
  if (params.ov) {
    const ovStr = String(params.ov).trim().toLowerCase();
    if (ovStr && ovStr !== '0' && ovStr !== 'false') {
      return null;
    }
  }
  const role = String(params.role || 'cover').trim().toLowerCase();
  const ordinal = Number(params.ordinal ?? params.ord ?? 0) || 0;
  if (role === 'achievement_icon' || (role === 'icon' && ordinal > 0)) {
    return null;
  }
  const url = typeof params.url === 'string' ? params.url.trim() : '';
  const roots = options._precomputedRoots || (await discoverStorefrontCacheRootsAsync(options));

  const steamAppId = extractSteamAppIdFromParams(params);
  if (
    steamAppId &&
    roots.steamRoots.length > 0 &&
    isFederatedStoreUrlCompatible('steam', url, { steamAppId })
  ) {
    const steamHit = await resolveSteamFederatedAssetAsync(steamAppId, role, url, roots, options);
    if (steamHit) return steamHit;
  }

  const gogId = extractGogIdFromParams(params);
  if (
    gogId &&
    roots.gogRoots.length > 0 &&
    isFederatedStoreUrlCompatible('gog', url, { gogId })
  ) {
    const gogHit = await resolveGogFederatedAssetAsync(gogId, role, url, roots, options);
    if (gogHit) return gogHit;
  }

  const xboxParams = extractXboxParams(params);
  if (
    (xboxParams.productId || xboxParams.pfn || xboxParams.titleId) &&
    ((roots.xboxGamesRoots && roots.xboxGamesRoots.length > 0) ||
      (roots.xboxAppCacheDirs && roots.xboxAppCacheDirs.length > 0)) &&
    isFederatedStoreUrlCompatible('xbox', url, xboxParams)
  ) {
    const xboxHit = await resolveXboxFederatedAssetAsync(xboxParams, role, url, roots, {
      ...options,
      title: params.title || options.title,
    });
    if (xboxHit) return xboxHit;
  }

  const epicAppName = extractEpicAppNameFromParams(params);
  if (isFederatedStoreUrlCompatible('epic', url, { epicAppName })) {
    let effectiveUrl = url;
    if (
      !effectiveUrl &&
      epicAppName &&
      roots.legendaryDirs.length > 0 &&
      roots.heroicRoots.length > 0
    ) {
      const localEpic = await resolveLocalEpicMetadataAsync(epicAppName, {
        ...options,
        _precomputedRoots: roots,
      });
      if (localEpic) {
        if (role === 'cover' && localEpic.capsuleImage) {
          effectiveUrl = localEpic.capsuleImage;
        } else if (role === 'header' && localEpic.headerImage) {
          effectiveUrl = localEpic.headerImage;
        }
      }
    }

    if (effectiveUrl && roots.heroicRoots.length > 0) {
      const heroicHit = await resolveHeroicImagesCacheAssetAsync(effectiveUrl, roots, options);
      if (heroicHit) return heroicHit;
    }
  }

  return null;
}

/**
 * Unified local metadata resolver across Steam, GOG Galaxy, Epic/Legendary/Heroic, Xbox, and Amazon Games.
 *
 * @param {Record<string, any>} [payload]
 * @param {Record<string, any>} [options]
 */
function resolveLocalMetadata(payload = {}, options = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);
  const mergedOpts = { ...options, _precomputedRoots: roots, title: payload.title };

  const gogId = extractGogIdFromParams(payload);
  if (gogId) {
    const gogMeta = resolveLocalGogMetadata(gogId, mergedOpts);
    if (gogMeta) return gogMeta;
  }

  const epicAppName = extractEpicAppNameFromParams(payload);
  if (epicAppName) {
    const epicMeta = resolveLocalEpicMetadata(epicAppName, mergedOpts);
    if (epicMeta) return epicMeta;
  }

  const xboxParams = extractXboxParams(payload);
  if (xboxParams.productId || xboxParams.pfn || xboxParams.titleId) {
    const xboxMeta = resolveLocalXboxMetadata(payload, mergedOpts);
    if (xboxMeta) return xboxMeta;
  }

  const steamAppId = extractSteamAppIdFromParams(payload);
  if (steamAppId) {
    const steamMeta = resolveLocalSteamMetadata(steamAppId, mergedOpts);
    if (steamMeta) return steamMeta;
  }

  const amazonId =
    payload.amazonId ||
    (typeof payload.gameId === 'string' && /^amazon[-_]/i.test(payload.gameId)
      ? payload.gameId.replace(/^amazon[-_]/i, '')
      : '');
  if (amazonId) {
    const amzMeta = resolveLocalAmazonMetadata(amazonId, mergedOpts);
    if (amzMeta) return amzMeta;
  }

  if (payload.title && roots.legendaryDirs.length > 0) {
    const epicByTitle = resolveLocalEpicMetadata('', mergedOpts);
    if (epicByTitle) return epicByTitle;
  }

  return null;
}

/**
 * Async variant of `resolveLocalMetadata` using `fs.promises` for Steam, Epic, and Xbox local lookups.
 *
 * @param {Record<string, any>} [payload]
 * @param {Record<string, any>} [options]
 */
async function resolveLocalMetadataAsync(payload = {}, options = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const roots = options._precomputedRoots || (await discoverStorefrontCacheRootsAsync(options));
  const mergedOpts = { ...options, _precomputedRoots: roots, title: payload.title };

  const gogId = extractGogIdFromParams(payload);
  if (gogId) {
    const gogMeta = resolveLocalGogMetadata(gogId, mergedOpts);
    if (gogMeta) return gogMeta;
  }

  const epicAppName = extractEpicAppNameFromParams(payload);
  if (epicAppName) {
    const epicMeta = await resolveLocalEpicMetadataAsync(epicAppName, mergedOpts);
    if (epicMeta) return epicMeta;
  }

  const xboxParams = extractXboxParams(payload);
  if (xboxParams.productId || xboxParams.pfn || xboxParams.titleId) {
    const xboxMeta = await resolveLocalXboxMetadataAsync(payload, mergedOpts);
    if (xboxMeta) return xboxMeta;
  }

  const steamAppId = extractSteamAppIdFromParams(payload);
  if (steamAppId) {
    const steamMeta = await resolveLocalSteamMetadataAsync(steamAppId, mergedOpts);
    if (steamMeta) return steamMeta;
  }

  const amazonId =
    payload.amazonId ||
    (typeof payload.gameId === 'string' && /^amazon[-_]/i.test(payload.gameId)
      ? payload.gameId.replace(/^amazon[-_]/i, '')
      : '');
  if (amazonId) {
    const amzMeta = resolveLocalAmazonMetadata(amazonId, mergedOpts);
    if (amzMeta) return amzMeta;
  }

  if (payload.title && roots.legendaryDirs.length > 0) {
    const epicByTitle = await resolveLocalEpicMetadataAsync('', mergedOpts);
    if (epicByTitle) return epicByTitle;
  }

  return null;
}

function clearFederatorCaches() {
  invalidateStorefrontCacheRoots();
  clearGogFederatorCaches();
  clearXboxManifestCaches();
  clearCachedWindowsLocalDrives();
}

class StorefrontLocalCacheFederator {
  /**
   * @param {Record<string, any>} [defaultOptions]
   */
  constructor(defaultOptions = {}) {
    this.defaultOptions = { ...defaultOptions };
    this.options = this.defaultOptions;
    const platform = this.defaultOptions.platform || process.platform;
    if (
      platform === 'win32' &&
      !this.defaultOptions.homedir &&
      !this.defaultOptions.userDataDir &&
      !process.env.VITEST &&
      process.env.NODE_ENV !== 'test'
    ) {
      discoverWindowsLocalDrivesAsync(this.defaultOptions).catch(() => {});
    }
  }

  discoverRoots(overrides = {}) {
    return discoverStorefrontCacheRoots({ ...this.defaultOptions, ...overrides });
  }

  discoverRootsAsync(overrides = {}) {
    return discoverStorefrontCacheRootsAsync({ ...this.defaultOptions, ...overrides });
  }

  discoverStorefrontCacheRootsAsync(overrides = {}) {
    return discoverStorefrontCacheRootsAsync({ ...this.defaultOptions, ...overrides });
  }

  invalidateCacheRoots() {
    invalidateStorefrontCacheRoots();
  }

  canPotentiallyFederateAsset(params = {}, overrides = {}) {
    return canPotentiallyFederateAsset(params, { ...this.defaultOptions, ...overrides });
  }

  resolveFederatedAsset(params = {}, overrides = {}) {
    return resolveFederatedAsset(params, { ...this.defaultOptions, ...overrides });
  }

  resolveFederatedAssetAsync(params = {}, overrides = {}) {
    return resolveFederatedAssetAsync(params, { ...this.defaultOptions, ...overrides });
  }

  resolveLocalSteamMetadata(appId, overrides = {}) {
    return resolveLocalSteamMetadata(appId, { ...this.defaultOptions, ...overrides });
  }

  resolveLocalGogMetadata(gogId, overrides = {}) {
    return resolveLocalGogMetadata(gogId, { ...this.defaultOptions, ...overrides });
  }

  resolveLocalEpicMetadata(appName, overrides = {}) {
    return resolveLocalEpicMetadata(appName, { ...this.defaultOptions, ...overrides });
  }

  resolveLocalEpicMetadataAsync(appName, overrides = {}) {
    return resolveLocalEpicMetadataAsync(appName, { ...this.defaultOptions, ...overrides });
  }

  resolveLocalXboxMetadata(productIdOrPayload, overrides = {}) {
    return resolveLocalXboxMetadata(productIdOrPayload, { ...this.defaultOptions, ...overrides });
  }

  resolveLocalAmazonMetadata(productId, overrides = {}) {
    return resolveLocalAmazonMetadata(productId, { ...this.defaultOptions, ...overrides });
  }

  resolveLocalMetadata(payload = {}, overrides = {}) {
    return resolveLocalMetadata(payload, { ...this.defaultOptions, ...overrides });
  }

  resolveLocalMetadataAsync(payload = {}, overrides = {}) {
    return resolveLocalMetadataAsync(payload, { ...this.defaultOptions, ...overrides });
  }

  listLocalEpicCatalogGames(overrides = {}) {
    return listLocalEpicCatalogGames({ ...this.defaultOptions, ...this.options, ...overrides });
  }

  listLocalGogCatalogGames(overrides = {}) {
    return listLocalGogCatalogGames({ ...this.defaultOptions, ...this.options, ...overrides });
  }

  listLocalXboxInstalledGames(overrides = {}) {
    return listLocalXboxInstalledGames({ ...this.defaultOptions, ...overrides });
  }

  trimMemory() {
    clearFederatorCaches();
  }
}

/**
 * @param {Record<string, any>} [options]
 */
function createStorefrontLocalCacheFederator(options = {}) {
  return new StorefrontLocalCacheFederator(options);
}

module.exports = {
  StorefrontLocalCacheFederator,
  createStorefrontLocalCacheFederator,
  detectImageMagicBytes,
  validateFederatedImageFile,
  validateFederatedImageFileAsync,
  resolveFederatorUserDataDir,
  discoverWindowsLocalDrivesAsync,
  getKnownWindowsLocalDrivesSync,
  discoverStorefrontCacheRoots,
  discoverStorefrontCacheRootsAsync,
  invalidateStorefrontCacheRoots,
  parseMicrosoftGameConfigXml,
  isFederatedStoreUrlCompatible,
  canPotentiallyFederateAsset,
  resolveFederatedAsset,
  resolveFederatedAssetAsync,
  resolveSteamFederatedAsset,
  resolveSteamFederatedAssetAsync,
  resolveGogFederatedAsset,
  resolveGogFederatedAssetAsync,
  resolveXboxFederatedAsset,
  resolveXboxFederatedAssetAsync,
  resolveLocalSteamMetadata,
  resolveLocalSteamMetadataAsync,
  resolveLocalGogMetadata,
  resolveLocalEpicMetadata,
  resolveLocalEpicMetadataAsync,
  parseLegendaryMetadataJson,
  resolveLocalXboxMetadata,
  resolveLocalXboxMetadataAsync,
  resolveLocalAmazonMetadata,
  resolveLocalMetadata,
  resolveLocalMetadataAsync,
  listLocalEpicCatalogGames,
  listLocalGogCatalogGames,
  listLocalXboxInstalledGames,
  clearFederatorCaches,
};
