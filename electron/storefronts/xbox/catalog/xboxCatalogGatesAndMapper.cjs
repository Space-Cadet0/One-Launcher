'use strict';

/**
 * Xbox DisplayCatalog 5-Gate Structural PC/Mac Filter, Metadata Record Mapper,
 * Autosuggest Product Lookup & Full Library + Game Pass Catalog Sync Orchestrator.
 */

const crypto = require('node:crypto');
const { classifyNonGameStorefrontItem } = require('../../nonGameClassifier.cjs');
const xboxConfigAndIds = require('../xboxConfigAndIds.cjs');
const { buildXboxFetchSignal, makeCorrelationVector } = xboxConfigAndIds;

const {
  DISPLAY_CATALOG_AUTOSUGGEST_URL,
  CROSS_PLATFORM_ENTITLEMENT_CACHE_TTL_MS,
  XBOX_GAMING_PASS_REGISTRY,
  resolveFetchImpl,
  resolveDefaultXboxLocaleAndMarket,
  detectThirdPartyPfnHandoff,
  resolveStructuralExternalLauncherHandoff,
  normalizeXboxSyncMode,
  evaluateXboxActiveAccessGate,
  deriveExpandedCapabilitySetFromSubscription,
} = require('./xboxCatalogConstants.cjs');

const {
  LAYER3_REJECTED_TTL_MS,
  hasStaleCachedDesktopPassGrants,
  openXboxCatalogCacheStore,
} = require('./xboxCatalogSqliteCache.cjs');

const {
  selectPreferredLocalizedEntry,
  normalizeStoreImageUrl,
  extractDisplayCatalogMovies,
  extractDisplayCatalogCategories,
  formatPlainDescriptionToHtml,
  sanitizeDisplayCatalogReleaseDate,
  stripXboxPlatformDisambiguators,
  deriveDefaultScidFromTitleId,
} = require('./xboxCatalogMediaAndSanitizer.cjs');

const {
  hydrateDisplayCatalogProducts,
  lookupDisplayCatalogProducts,
  extractAutosuggestBigIds,
  detectXboxSubscriptions,
  fetchXboxOwnedEntitlements,
  fetchActiveTierSiglSets,
  evaluateLayer3DesktopLicenseGate,
  resolveGamePassTierAttribution,
} = require('./xboxSubscriptionAndEntitlements.cjs');

function isDesktopEligiblePackage(pkg) {
  if (!pkg || typeof pkg !== 'object') return false;
  const format = String(pkg.PackageFormat || '').trim().toLowerCase();
  if (format === 'xvc' || format === 'xap') {
    return false;
  }

  const deps = Array.isArray(pkg.PlatformDependencies) ? pkg.PlatformDependencies : [];
  const platformNamesLower = deps
    .map((d) => String(d?.PlatformName || d || '').trim().toLowerCase())
    .filter(Boolean);

  const hasWindowsDesktop = platformNamesLower.includes('windows.desktop');
  const hasWindowsUniversal = platformNamesLower.includes('windows.universal');
  const hasWindows8x = platformNamesLower.includes('windows.windows8x');
  const isXboxConsoleOnly =
    platformNamesLower.length > 0 &&
    platformNamesLower.every((n) => n === 'windows.xbox' || n === 'xbox');

  if (isXboxConsoleOnly) return false;
  if (hasWindowsDesktop) return true;

  if (hasWindowsUniversal || hasWindows8x) {
    const validUwpFormats = [
      'msixvc',
      'appxbundle',
      'msixbundle',
      'appx',
      'msix',
      'eappx',
      'eappxbundle',
    ];
    const archs = (Array.isArray(pkg.Architectures) ? pkg.Architectures : []).map((a) =>
      String(a || '').toLowerCase()
    );
    const validArch =
      archs.length === 0 ||
      archs.some((a) => ['x64', 'x86', 'arm64', 'neutral'].includes(a));
    return validUwpFormats.includes(format) && validArch;
  }

  return false;
}

function extractProductCandidatePfn(product) {
  if (!product || typeof product !== 'object') return '';
  if (product.Properties?.PackageFamilyName) {
    return String(product.Properties.PackageFamilyName).trim();
  }
  const skuAvails = Array.isArray(product.DisplaySkuAvailabilities)
    ? product.DisplaySkuAvailabilities
    : [];
  for (const avail of skuAvails) {
    const sp = avail?.Sku?.Properties;
    if (!sp || sp.IsTrial === true) continue;
    if (sp.FulfillmentData?.PackageFamilyName) {
      return String(sp.FulfillmentData.PackageFamilyName).trim();
    }
    if (Array.isArray(sp.Packages)) {
      for (const pkg of sp.Packages) {
        if (pkg?.PackageFamilyName && isDesktopEligiblePackage(pkg)) {
          return String(pkg.PackageFamilyName).trim();
        }
      }
    }
  }
  return '';
}

/**
 * Evaluates a DisplayCatalog `Product` object through the **5-Gate Structural Filter**:
 * - Gate 1: `ProductKind` / `ProductType === 'Game'`
 * - Gate 2: PC (`Windows.Desktop` / desktop `Windows.Universal`) or structurally verified cross-platform
 *           launcher runtime edition, strictly rejecting Console-only (`Windows.Xbox` / `XVC` / `Xap`) games!
 * - Gate 3: 3rd-party PC storefront PFN handoff detection (`ubisoft`, `bnet`, `riot`, `ea`, `rockstar`)
 * - Gate 4: Pure bundle wrapper detection (`BundledSkus` expansion)
 * - Gate 5: `classifyNonGameStorefrontItem` (DLCs, soundtracks, artbooks, companion apps, launchers, test branches)
 */
function evaluateDisplayCatalogProduct(product, evalOptions = {}) {
  if (!product || typeof product !== 'object') {
    return { eligible: false, gate: 'invalid_product', reason: 'Empty DisplayCatalog product' };
  }

  const productId = String(product.ProductId || '').trim().toUpperCase();
  const localized = selectPreferredLocalizedEntry(product.LocalizedProperties);
  const marketProps =
    (Array.isArray(product.MarketProperties) && product.MarketProperties[0]) || {};
  const props = product.Properties || {};

  const title = String(localized.ProductTitle || product.ProductTitle || '').trim();
  const productKind = String(product.ProductKind || product.ProductType || '').trim();
  const kindLower = productKind.toLowerCase();

  // Gate 1: Must be `Game`
  if (kindLower !== 'game') {
    return {
      eligible: false,
      gate: 'gate1_product_kind',
      reason: `Non-game ProductKind: ${productKind || 'Unknown'}`,
      productId,
      title,
    };
  }

  if (props.IsDemoOrTrial === true) {
    return {
      eligible: false,
      gate: 'gate1_demo_or_trial',
      reason: 'Filtered: Demo or Trial SKU',
      productId,
      title,
    };
  }

  const skuAvailabilities = Array.isArray(product.DisplaySkuAvailabilities)
    ? product.DisplaySkuAvailabilities
    : [];

  const desktopPackages = [];
  const allPackages = [];
  const bundledSkus = [];
  const allowedPlatformsLower = new Set();
  let fulfillmentData = null;
  let skuFulfillmentType = '';
  let skuMaxInstallBytes = 0;
  let selectedSkuId = '0010';

  for (const avail of skuAvailabilities) {
    const sku = avail?.Sku;
    if (!sku) continue;
    const skuProps = sku.Properties || {};
    if (skuProps.IsTrial === true) continue;
    if (sku.SkuId && selectedSkuId === '0010') {
      selectedSkuId = String(sku.SkuId);
    }
    if (!fulfillmentData && skuProps.FulfillmentData) {
      fulfillmentData = skuProps.FulfillmentData;
    }
    if (!skuFulfillmentType && skuProps.FulfillmentType) {
      skuFulfillmentType = String(skuProps.FulfillmentType).trim();
    }
    const candSkuInstallBytes =
      Number(skuProps.MaxInstallSizeInBytes || skuProps.ApproximateSizeInBytes || 0) || 0;
    if (candSkuInstallBytes > skuMaxInstallBytes) {
      skuMaxInstallBytes = candSkuInstallBytes;
    }
    if (Array.isArray(avail?.Availabilities)) {
      for (const av of avail.Availabilities) {
        const allowed = av?.Conditions?.ClientConditions?.AllowedPlatforms;
        if (Array.isArray(allowed)) {
          for (const ap of allowed) {
            const pName = String(typeof ap === 'string' ? ap : ap?.PlatformName || '')
              .trim()
              .toLowerCase();
            if (pName) allowedPlatformsLower.add(pName);
          }
        }
      }
    }
    if (Array.isArray(skuProps.BundledSkus)) {
      for (const b of skuProps.BundledSkus) {
        const bId = String(b?.BigId || '').trim().toUpperCase();
        if (bId && /^[A-Z0-9]{12}$/.test(bId) && bId !== productId) {
          bundledSkus.push({
            bigId: bId,
            skuId: String(b?.SkuId || '0010'),
            isPrimary: Boolean(b?.IsPrimary),
          });
        }
      }
    }
    if (Array.isArray(skuProps.Packages)) {
      for (const pkg of skuProps.Packages) {
        allPackages.push({ ...pkg, _skuId: sku.SkuId });
        if (isDesktopEligiblePackage(pkg)) {
          desktopPackages.push({ ...pkg, _skuId: sku.SkuId });
        }
      }
    }
  }

  const pfn = String(
    props.PackageFamilyName ||
      fulfillmentData?.PackageFamilyName ||
      desktopPackages[0]?.PackageFamilyName ||
      ''
  ).trim();

  const developerName = String(localized.DeveloperName || '').trim();
  const publisherName = String(localized.PublisherName || '').trim();

  const preferredPkg =
    desktopPackages.find(
      (p) =>
        String(p.PackageFormat || '').toLowerCase() === 'msixvc' &&
        Array.isArray(p.Architectures) &&
        p.Architectures.some((a) => String(a).toLowerCase() === 'x64')
    ) ||
    desktopPackages.find((p) => String(p.PackageFormat || '').toLowerCase() === 'msixvc') ||
    desktopPackages[0] ||
    null;

  const STUB_PACKAGE_MAX_BYTES = 32 * 1024 * 1024;
  const CROSS_PLATFORM_BOOTSTRAPPER_MAX_BYTES = 100 * 1024 * 1024;
  const rawMaxDownloadBytes = Number(preferredPkg?.MaxDownloadSizeInBytes || 0) || 0;

  const hasMsixvcPackage = desktopPackages.some(
    (p) => String(p.PackageFormat || '').toLowerCase() === 'msixvc'
  );
  const hasStandaloneMsixvc = Boolean(
    hasMsixvcPackage &&
      !/gdkstubgame/i.test(skuFulfillmentType) &&
      rawMaxDownloadBytes > STUB_PACKAGE_MAX_BYTES
  );

  const externalStorefrontHandoff = detectThirdPartyPfnHandoff(
    pfn,
    publisherName,
    hasStandaloneMsixvc,
    {
      packagesCount: allPackages.length,
      fulfillmentType: skuFulfillmentType,
      maxDownloadBytes: rawMaxDownloadBytes,
    }
  );

  const isConsoleRestrictedAllowedPlatforms =
    allowedPlatformsLower.size > 0 &&
    Array.from(allowedPlatformsLower).every((p) => p === 'windows.xbox' || p === 'xbox');

  const hasOnlyZeroOrSmallBootstrapperPkg =
    allPackages.length === 0 ||
    (!externalStorefrontHandoff &&
      rawMaxDownloadBytes > 0 &&
      rawMaxDownloadBytes <= CROSS_PLATFORM_BOOTSTRAPPER_MAX_BYTES);

  const isCrossPlatformLauncherRuntime =
    !externalStorefrontHandoff &&
    bundledSkus.length === 0 &&
    hasOnlyZeroOrSmallBootstrapperPkg &&
    !isConsoleRestrictedAllowedPlatforms &&
    (Boolean(product._crossPlatformLauncherRuntime) ||
      Boolean(evalOptions?.crossPlatformRuntimeProductIds?.has?.(productId)) ||
      (Boolean(evalOptions?.crossPlatformRuntimeVerified) &&
        Boolean(evalOptions?.fromDesktopSiblingBundle) &&
        desktopPackages.length === 0) ||
      allowedPlatformsLower.has('macos') ||
      allowedPlatformsLower.has('osx') ||
      allowedPlatformsLower.has('linux') ||
      /\bjava\s+edition\b/i.test(title));

  // Gate 4: Pure bundle wrapper (`Packages: []` with `BundledSkus.length > 0`)
  if (!isCrossPlatformLauncherRuntime && desktopPackages.length === 0 && bundledSkus.length > 0) {
    return {
      eligible: false,
      isBundleWrapper: true,
      bundledSkus,
      selectedSkuId,
      gate: 'gate4_bundle_wrapper',
      reason: 'Bundle wrapper SKU expanded into child base games',
      productId,
      title,
    };
  }

  // Gate 2: PC (`Windows.Desktop` / desktop `Windows.Universal` / 3rd-party PC PFN) or cross-platform runtime
  const hasThirdPartyPcStub = Boolean(
    externalStorefrontHandoff &&
      allPackages.every((p) => String(p.PackageFormat || '').toLowerCase() !== 'xvc')
  );
  const hasAllowedDesktopWithoutPackages =
    desktopPackages.length === 0 &&
    allPackages.length === 0 &&
    bundledSkus.length === 0 &&
    !isConsoleRestrictedAllowedPlatforms &&
    allowedPlatformsLower.has('windows.desktop');

  if (
    !isCrossPlatformLauncherRuntime &&
    !hasAllowedDesktopWithoutPackages &&
    desktopPackages.length === 0 &&
    !hasThirdPartyPcStub
  ) {
    return {
      eligible: false,
      gate: 'gate2_console_only',
      reason: 'Console-only Xbox title (no Windows.Desktop or Mac package)',
      productId,
      title,
    };
  }

  // Gate 5: General non-game storefront classifier (DLC, soundtrack, artbook, server, tool, launcher client, beta)
  const genreCategories = Array.isArray(props.Categories) ? [...props.Categories] : [];
  if (props.Category && !genreCategories.includes(props.Category)) {
    genreCategories.push(props.Category);
  }

  const nonGameReason = classifyNonGameStorefrontItem({
    title,
    platformId: 'xbox',
    platformGameId: productId,
    isDlc: false,
    itemType: productKind,
    categories: genreCategories,
    isInstalled: Boolean(evalOptions?.isInstalled),
  });

  if (nonGameReason) {
    return {
      eligible: false,
      isSuppressedNonGame: true,
      gate: 'gate5_non_game_classifier',
      reason: nonGameReason,
      productId,
      title,
    };
  }

  // Extract AlternateIds (`ServiceConfigId`, `XboxTitleId`, `MsaAppId`)
  let xboxTitleId = '';
  let msaAppId = '';
  let explicitScid = '';
  const scidUuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rawPropScid = String(props.ServiceConfigId || props.Scid || '').trim();
  if (scidUuidRe.test(rawPropScid)) {
    explicitScid = rawPropScid.toLowerCase();
  }
  for (const alt of Array.isArray(product.AlternateIds) ? product.AlternateIds : []) {
    const idType = String(alt?.IdType || '').trim().toLowerCase();
    const val = String(alt?.Value || '').trim();
    if (!val) continue;
    if ((idType === 'serviceconfigid' || idType === 'scid') && !explicitScid && scidUuidRe.test(val)) {
      explicitScid = val.toLowerCase();
    } else if (idType === 'xboxtitleid' && !xboxTitleId) {
      if (/^0x[0-9a-f]+$/i.test(val)) {
        xboxTitleId = BigInt(val).toString(10);
      } else if (/^[0-9]+$/.test(val)) {
        xboxTitleId = val;
      } else if (/^[0-9a-f]+$/i.test(val)) {
        xboxTitleId = BigInt(`0x${val}`).toString(10);
      } else {
        xboxTitleId = val;
      }
    } else if ((idType === 'msaappid' || idType === 'appid') && !msaAppId) {
      msaAppId = val;
    }
  }
  const scid = explicitScid || deriveDefaultScidFromTitleId(xboxTitleId);

  const images = Array.isArray(localized.Images) ? localized.Images : [];
  const findImageByPurpose = (purposes, suffix = '') => {
    for (const purpose of purposes) {
      const hit = images.find(
        (img) =>
          img &&
          String(img.ImagePurpose || '').toLowerCase() === purpose.toLowerCase() &&
          img.Uri
      );
      if (hit) {
        const u = normalizeStoreImageUrl(hit.Uri, suffix);
        if (u) return u;
      }
    }
    return '';
  };

  const capsuleImage = findImageByPurpose(['Poster'], '?w=600&h=900&q=90&mode=scale');
  const headerImage =
    findImageByPurpose(
      ['SuperHeroArt', 'TitledHeroArt', 'FeaturePromotionalSquareArt'],
      '?w=1920&h=1080&q=90'
    ) || capsuleImage;
  const iconUrl =
    findImageByPurpose(['BoxArt', 'Tile', 'AppIcon'], '?w=256&h=256&q=90') || capsuleImage;
  const logoUrl = findImageByPurpose(['Logo'], '?w=600&q=90');

  const screenshots = images
    .filter((img) => String(img?.ImagePurpose || '').toLowerCase() === 'screenshot' && img.Uri)
    .slice(0, 12)
    .map((img) => normalizeStoreImageUrl(img.Uri, '?w=1920&h=1080&q=85'))
    .filter(Boolean);

  const movies = extractDisplayCatalogMovies(
    localized,
    headerImage || screenshots[0] || capsuleImage || ''
  );
  const storeCategories = extractDisplayCatalogCategories(product);

  let averageRating;
  let rating100;
  let ratingCount = 0;
  if (Array.isArray(marketProps.UsageData) && marketProps.UsageData.length > 0) {
    const validUsage = marketProps.UsageData.filter(
      (u) => u && Number(u.RatingCount || 0) > 0 && Number(u.AverageRating || 0) > 0
    );
    const allTime = validUsage.find(
      (u) => String(u.AggregateTimeSpan || '').toLowerCase() === 'alltime'
    );
    const bestUsage =
      allTime ||
      validUsage
        .slice()
        .sort((a, b) => Number(b.RatingCount || 0) - Number(a.RatingCount || 0))[0] ||
      null;
    if (bestUsage) {
      ratingCount = Math.max(0, Math.floor(Number(bestUsage.RatingCount || 0)));
      averageRating = Math.round(Number(bestUsage.AverageRating) * 100) / 100;
      if (ratingCount >= 4 && averageRating > 0) {
        rating100 = Math.round(averageRating * 20);
      }
    }
  }

  let releaseDate = sanitizeDisplayCatalogReleaseDate(marketProps.OriginalReleaseDate);
  if (!releaseDate) {
    for (const avail of skuAvailabilities) {
      const skuMarket = Array.isArray(avail?.Sku?.MarketProperties)
        ? avail.Sku.MarketProperties[0]
        : null;
      const skuDate = sanitizeDisplayCatalogReleaseDate(
        skuMarket?.OriginalReleaseDate || skuMarket?.FirstAvailableDate
      );
      if (skuDate) {
        releaseDate = skuDate;
        break;
      }
      if (Array.isArray(avail?.Availabilities)) {
        for (const av of avail.Availabilities) {
          const condStart = sanitizeDisplayCatalogReleaseDate(
            av?.Conditions?.StartDate || av?.StartDate
          );
          if (condStart && (!releaseDate || condStart < releaseDate)) {
            releaseDate = condStart;
          }
        }
      }
      if (releaseDate) break;
    }
  }

  const osPlatforms = isCrossPlatformLauncherRuntime
    ? { windows: true, mac: true, linux: true }
    : { windows: true, mac: false, linux: false };

  const bottleCompatibilityTier = externalStorefrontHandoff
    ? 'tier_c_external_launcher'
    : !isCrossPlatformLauncherRuntime && !hasMsixvcPackage
      ? 'tier_b_legacy_uwp'
      : 'tier_a_supported';

  const contentId = String(preferredPkg?.ContentId || fulfillmentData?.ContentId || '').trim();
  const packageFullName = String(preferredPkg?.PackageFullName || '').trim();
  const wuCategoryId = String(
    fulfillmentData?.WuCategoryId || preferredPkg?.FulfillmentData?.WuCategoryId || ''
  ).trim();
  const rawMaxInstallBytes =
    Number(
      preferredPkg?.MaxInstallSizeInBytes ||
        skuMaxInstallBytes ||
        props?.MaxInstallSizeInBytes ||
        props?.ApproximateSizeInBytes ||
        localized?.ApproximateSizeInBytes ||
        0
    ) || 0;
  const pcMaxInstallSizeBytes = rawMaxInstallBytes > 0 ? rawMaxInstallBytes : undefined;
  const isExternalLauncherStubPackage = Boolean(
    externalStorefrontHandoff &&
      ((rawMaxDownloadBytes > 0 && rawMaxDownloadBytes <= STUB_PACKAGE_MAX_BYTES) ||
        /gdkstubgame/i.test(skuFulfillmentType))
  );
  const maxDownloadSizeBytes =
    externalStorefrontHandoff && rawMaxDownloadBytes <= STUB_PACKAGE_MAX_BYTES
      ? pcMaxInstallSizeBytes && pcMaxInstallSizeBytes > STUB_PACKAGE_MAX_BYTES
        ? pcMaxInstallSizeBytes
        : undefined
      : rawMaxDownloadBytes > 0
        ? rawMaxDownloadBytes
        : undefined;

  const handoffDescriptor = resolveStructuralExternalLauncherHandoff({
    externalStorefrontHandoff,
    isCrossPlatformLauncherRuntime,
    hasMsixvcPackage,
    hasStandaloneMsixvc,
    packageFamilyName: pfn,
    publisherName,
    developerName,
    productId,
  });

  const cleanTitle = stripXboxPlatformDisambiguators(title);

  return {
    eligible: true,
    productId,
    selectedSkuId: String(preferredPkg?._skuId || selectedSkuId || '0010'),
    title: cleanTitle,
    rawTitle: title,
    shortDescription: String(localized.ShortDescription || '').trim(),
    detailedDescription: String(localized.ProductDescription || localized.ShortDescription || '').trim(),
    developers: developerName ? [developerName] : [],
    publishers: publisherName ? [publisherName] : [],
    genres: genreCategories,
    categories: storeCategories,
    releaseDate,
    capsuleImage,
    headerImage,
    iconUrl,
    logoUrl,
    screenshots,
    movies,
    averageRating,
    rating100,
    ratingCount,
    packageFamilyName: pfn || undefined,
    packageFullName: packageFullName || undefined,
    appUserModelId: pfn ? `${pfn}!App` : undefined,
    contentId: contentId || undefined,
    wuCategoryId: wuCategoryId || undefined,
    maxDownloadSizeBytes,
    pcMaxInstallSizeBytes: pcMaxInstallSizeBytes || undefined,
    isExternalLauncherStubPackage: isExternalLauncherStubPackage || undefined,
    xboxTitleId: xboxTitleId || undefined,
    scid: scid || undefined,
    msaAppId: msaAppId || undefined,
    platforms: osPlatforms,
    isCrossPlatformLauncherRuntime: Boolean(isCrossPlatformLauncherRuntime),
    chainedLauncherHandoff: externalStorefrontHandoff,
    externalStorefrontHandoff,
    chainedHandoffTopology: externalStorefrontHandoff ? 'publisher_managed' : undefined,
    externalLauncher: handoffDescriptor?.externalLauncher,
    externalLauncherUrl: handoffDescriptor?.externalLauncherUrl,
    xboxBottleCompatibilityTier: bottleCompatibilityTier,
    xboxBottleCompatibilityReason: handoffDescriptor?.xboxBottleCompatibilityReason || undefined,
    bundledSkus,
  };
}

// ============================================================================
// Cross-Platform Runtime Entitlement Cache (Cleared on logout / cache reset)
// ============================================================================

const CROSS_PLATFORM_ENTITLEMENT_HASH_CACHE_MAX = 4;
const crossPlatformEntitlementByTokenHash = new Map();
const crossPlatformEntitlementByProvider = new WeakMap();

function clearCrossPlatformEntitlementCache() {
  crossPlatformEntitlementByTokenHash.clear();
}

function resolveCrossPlatformEntitlementChecker(authProvider) {
  if (!authProvider || typeof authProvider !== 'object') return null;
  if (typeof authProvider.checkCrossPlatformRuntimeEntitlement === 'function') {
    return () => authProvider.checkCrossPlatformRuntimeEntitlement();
  }
  if (typeof authProvider.checkMinecraftJavaEntitlement === 'function') {
    return () => authProvider.checkMinecraftJavaEntitlement();
  }
  return null;
}

async function getCachedCrossPlatformRuntimeEntitlement({ authProvider, storeToken }) {
  const checker = resolveCrossPlatformEntitlementChecker(authProvider);
  if (!checker) {
    return null;
  }
  const now = Date.now();
  for (const [k, v] of crossPlatformEntitlementByTokenHash.entries()) {
    if (!v || now >= v.expiresAtMs) {
      crossPlatformEntitlementByTokenHash.delete(k);
    }
  }
  const tokenKey =
    typeof storeToken === 'string' && storeToken.trim()
      ? crypto.createHash('sha256').update(storeToken.trim()).digest('hex')
      : '';

  if (tokenKey) {
    const cached = crossPlatformEntitlementByTokenHash.get(tokenKey);
    if (cached && now < cached.expiresAtMs) {
      return cached.result;
    }
  } else {
    const cached = crossPlatformEntitlementByProvider.get(authProvider);
    if (cached && now < cached.expiresAtMs) {
      return cached.result;
    }
  }

  const result = await checker();
  const entry = { result, expiresAtMs: now + CROSS_PLATFORM_ENTITLEMENT_CACHE_TTL_MS };
  if (tokenKey) {
    if (
      !crossPlatformEntitlementByTokenHash.has(tokenKey) &&
      crossPlatformEntitlementByTokenHash.size >= CROSS_PLATFORM_ENTITLEMENT_HASH_CACHE_MAX
    ) {
      const oldestKey = crossPlatformEntitlementByTokenHash.keys().next().value;
      if (oldestKey !== undefined) {
        crossPlatformEntitlementByTokenHash.delete(oldestKey);
      }
    }
    crossPlatformEntitlementByTokenHash.set(tokenKey, entry);
  } else {
    crossPlatformEntitlementByProvider.set(authProvider, entry);
  }
  return result;
}

function buildXboxProductMetadataRecord(evalResult) {
  const formattedHtml = formatPlainDescriptionToHtml(
    evalResult.detailedDescription || evalResult.shortDescription || ''
  );
  const sanitizedReleaseDate = sanitizeDisplayCatalogReleaseDate(evalResult.releaseDate);
  return {
    productId: evalResult.productId,
    xboxProductId: evalResult.productId,
    title: evalResult.title,
    name: evalResult.title,
    rawTitle: evalResult.rawTitle,
    shortDescription: evalResult.shortDescription,
    description: evalResult.shortDescription || evalResult.detailedDescription,
    detailedDescription: formattedHtml,
    aboutTheGame: formattedHtml || evalResult.shortDescription || '',
    headerImage: evalResult.headerImage,
    capsuleImage: evalResult.capsuleImage,
    posterUrl: evalResult.capsuleImage,
    heroUrl: evalResult.headerImage,
    boxArtUrl: evalResult.iconUrl || evalResult.capsuleImage,
    iconUrl: evalResult.iconUrl,
    logoUrl: evalResult.logoUrl,
    screenshots: evalResult.screenshots,
    movies: evalResult.movies || [],
    categories: evalResult.categories || [],
    releaseDate: sanitizedReleaseDate,
    developers: evalResult.developers,
    publishers: evalResult.publishers,
    genres: evalResult.genres,
    platforms: evalResult.platforms,
    packageFamilyName: evalResult.packageFamilyName,
    packageFullName: evalResult.packageFullName,
    contentId: evalResult.contentId,
    wuCategoryId: evalResult.wuCategoryId,
    xboxTitleId: evalResult.xboxTitleId,
    scid: evalResult.scid,
    msaAppId: evalResult.msaAppId,
    maxDownloadSizeBytes: evalResult.maxDownloadSizeBytes,
    ...(evalResult.pcMaxInstallSizeBytes
      ? { pcMaxInstallSizeBytes: evalResult.pcMaxInstallSizeBytes }
      : {}),
    ...(evalResult.isExternalLauncherStubPackage ? { isExternalLauncherStubPackage: true } : {}),
    ...(evalResult.isCrossPlatformLauncherRuntime ? { isCrossPlatformLauncherRuntime: true } : {}),
    ...(evalResult.xboxBottleCompatibilityTier
      ? { xboxBottleCompatibilityTier: evalResult.xboxBottleCompatibilityTier }
      : {}),
    ...(evalResult.xboxBottleCompatibilityReason
      ? { xboxBottleCompatibilityReason: evalResult.xboxBottleCompatibilityReason }
      : {}),
    ...(evalResult.externalStorefrontHandoff
      ? {
          chainedLauncherHandoff: evalResult.externalStorefrontHandoff,
          externalStorefrontHandoff: evalResult.externalStorefrontHandoff,
          chainedHandoffTopology: 'publisher_managed',
        }
      : {}),
    ...(evalResult.externalLauncher ? { externalLauncher: evalResult.externalLauncher } : {}),
    ...(evalResult.externalLauncherUrl
      ? { externalLauncherUrl: evalResult.externalLauncherUrl }
      : {}),
    rating: evalResult.rating100,
    averageRating: evalResult.averageRating,
    ratingCount: evalResult.ratingCount,
    metadataQuality: 'storefront_native',
    enrichedSource: 'xbox',
  };
}

/**
 * Full end-to-end Xbox Owned + Game Pass Catalog Sync.
 */
async function syncXboxCatalog(options = {}) {
  const defaults = resolveDefaultXboxLocaleAndMarket(options);
  const {
    authProvider,
    storeToken,
    collectionsToken,
    cachedSubscription = null,
    forceRefresh = false,
    nowMs = Date.now(),
    syncMode: rawSyncMode = 'owned_and_played',
    titleHubDecorations = {},
    playtimeByTitleId = new Map(),
    localInstallsByPfn = new Map(),
    localInstalledProductIds = new Set(),
    market = defaults.market,
    locale = defaults.locale,
    userDataDir,
  } = options;
  const checkCrossPlatformRuntime =
    options.checkCrossPlatformRuntime !== undefined
      ? Boolean(options.checkCrossPlatformRuntime)
      : options.checkMinecraftJava !== undefined
        ? Boolean(options.checkMinecraftJava)
        : true;
  const fetchImpl = resolveFetchImpl(options);
  const syncMode = normalizeXboxSyncMode(rawSyncMode);

  const cacheStore = openXboxCatalogCacheStore(userDataDir);
  try {
    const [detectedSubscription, entitlementData] = await Promise.all([
      detectXboxSubscriptions({
        storeToken,
        collectionsToken,
        authProvider,
        market,
        locale,
        cacheStore,
        nowMs,
        fetchImpl,
        signal: options.signal,
      }),
      fetchXboxOwnedEntitlements({
        storeToken,
        collectionsToken,
        authProvider,
        market,
        locale,
        nowMs,
        fetchImpl,
        signal: options.signal,
      }),
    ]);

    let subscription = detectedSubscription;
    if (
      detectedSubscription.authoritativeDetection === false &&
      cachedSubscription &&
      cachedSubscription.hasActiveSubscription
    ) {
      const expRaw =
        cachedSubscription.earliestActivePassEndDate || cachedSubscription.endDate || '';
      const expTs = expRaw ? Date.parse(String(expRaw)) : NaN;
      if (!expRaw || Number.isNaN(expTs) || expTs > nowMs) {
        subscription = {
          ...cachedSubscription,
          authoritativeDetection: false,
        };
      }
    }

    const prevFingerprint =
      (cachedSubscription && typeof cachedSubscription.subscriptionFingerprint === 'string'
        ? cachedSubscription.subscriptionFingerprint
        : '') ||
      (cacheStore && typeof cacheStore.getMeta === 'function'
        ? cacheStore.getMeta('lastSubscriptionFingerprint')
        : '');
    const subscriptionChanged = Boolean(
      prevFingerprint &&
        subscription.subscriptionFingerprint &&
        prevFingerprint !== subscription.subscriptionFingerprint
    );
    const forceSiglNetwork = Boolean(forceRefresh || subscriptionChanged);

    const {
      activePcSiglSet,
      leavingSoonSet,
      recentlyAddedSet,
      grantingCapabilitiesByProductId,
      siglFetchAuthoritative,
    } = await fetchActiveTierSiglSets(subscription, entitlementData, {
      market,
      language: locale.toLowerCase(),
      cacheStore,
      forceNetwork: forceSiglNetwork,
      fetchImpl,
      signal: options.signal,
    });

    const expandedCapabilityPassSet = deriveExpandedCapabilitySetFromSubscription(subscription);

    const ownedSet = new Set(entitlementData.ownedProductIds);
    const crossPlatformRuntimeProductIds = new Set();
    let crossPlatformRuntimeVerified = false;

    if (
      checkCrossPlatformRuntime &&
      resolveCrossPlatformEntitlementChecker(authProvider) &&
      (ownedSet.size > 0 || activePcSiglSet.size > 0 || process.platform === 'darwin')
    ) {
      const runtimeEnt = await getCachedCrossPlatformRuntimeEntitlement({
        authProvider,
        storeToken,
      });
      if (runtimeEnt?.owned) {
        crossPlatformRuntimeVerified = true;
        const dynamicProdId = String(runtimeEnt.productId || runtimeEnt.bigId || '')
          .trim()
          .toUpperCase();
        if (dynamicProdId && /^[A-Z0-9]{12}$/.test(dynamicProdId)) {
          crossPlatformRuntimeProductIds.add(dynamicProdId);
          if (!subscription.hasPcCatalogAccess || runtimeEnt.permanentOwnership === true) {
            ownedSet.add(dynamicProdId);
          } else {
            activePcSiglSet.add(dynamicProdId);
          }
        }
      }
    }

    const playedProductIds = new Set(
      (titleHubDecorations.playedProductIds || []).map((x) => String(x).toUpperCase())
    );
    const playedPfns = new Set();
    for (const rawPfn of titleHubDecorations.playedPfns || []) {
      const lower = String(rawPfn || '').trim().toLowerCase();
      if (!lower) continue;
      playedPfns.add(lower);
      if (lower.includes('_')) {
        playedPfns.add(lower.split('_')[0]);
      }
    }
    const playedTitleIds = new Set(
      (titleHubDecorations.playedTitleIds || []).map((x) => String(x))
    );

    const candidateSeedIds = new Set([...ownedSet, ...localInstalledProductIds]);
    if (subscription.hasPcCatalogAccess && syncMode !== 'owned_only') {
      for (const siglBigId of activePcSiglSet) {
        candidateSeedIds.add(siglBigId);
      }
    }

    const bundleLineage = new Map();
    const cachedSourceIds = new Set();
    const hydrationStats = { failedBatchCount: 0, failedProductIds: new Set() };
    const hydratedProducts = await hydrateDisplayCatalogProducts(Array.from(candidateSeedIds), {
      market,
      languages: `${locale},neutral`,
      cacheStore,
      fetchImpl,
      signal: options.signal,
      nowMs,
      cachedSourceIds,
      hydrationStats,
      maxBatchRetries: options.maxBatchRetries,
      retryBaseDelayMs: options.retryBaseDelayMs,
    });

    const cachedSiglSeedIds = [];
    if (
      subscription.hasPcCatalogAccess &&
      syncMode === 'owned_only' &&
      cacheStore &&
      activePcSiglSet.size > 0
    ) {
      const cachedSiglProducts = cacheStore.getProducts(Array.from(activePcSiglSet), market, nowMs);
      for (const [siglId, siglProd] of cachedSiglProducts.entries()) {
        if (hasStaleCachedDesktopPassGrants(siglProd, nowMs)) continue;
        if (!hydratedProducts.has(siglId)) {
          hydratedProducts.set(siglId, siglProd);
          cachedSourceIds.add(siglId);
        }
        cachedSiglSeedIds.push(siglId);
      }
    }

    let frontierIds = Array.from(new Set([...candidateSeedIds, ...cachedSiglSeedIds]));
    for (let depth = 0; depth < 2; depth++) {
      const nextNetworkChildIds = [];
      const nextCacheOnlyChildIds = [];
      const nextFrontier = new Set();

      for (const parentId of frontierIds) {
        const prod = hydratedProducts.get(parentId);
        if (!prod) continue;
        const parentOwned =
          ownedSet.has(parentId) || Boolean(bundleLineage.get(parentId)?.ownedFromParent);
        const parentInSigl =
          activePcSiglSet.has(parentId) || Boolean(bundleLineage.get(parentId)?.inSiglFromParent);
        if (!parentOwned && !parentInSigl) continue;

        const skus = Array.isArray(prod.DisplaySkuAvailabilities)
          ? prod.DisplaySkuAvailabilities
          : [];
        for (const avail of skus) {
          const sku = avail?.Sku;
          const bundled = sku?.Properties?.BundledSkus;
          if (!Array.isArray(bundled) || bundled.length === 0) continue;
          const parentKey = `${parentId}:${sku.SkuId || '0010'}`;

          for (const child of bundled) {
            const childId = String(child?.BigId || '').trim().toUpperCase();
            if (!childId || !/^[A-Z0-9]{12}$/.test(childId) || childId === parentId) continue;

            const prev = bundleLineage.get(childId) || {
              ownedFromParent: false,
              inSiglFromParent: false,
              parentKeys: [],
            };
            const newlyOwned = parentOwned && !prev.ownedFromParent;
            const newlyInSigl = parentInSigl && !prev.inSiglFromParent;
            if (newlyOwned) prev.ownedFromParent = true;
            if (newlyInSigl) prev.inSiglFromParent = true;
            if (!prev.parentKeys.includes(parentKey)) {
              prev.parentKeys.push(parentKey);
            }
            bundleLineage.set(childId, prev);

            if (!hydratedProducts.has(childId)) {
              if (syncMode === 'owned_only' && !parentOwned) {
                nextCacheOnlyChildIds.push(childId);
              } else {
                nextNetworkChildIds.push(childId);
              }
            } else if (newlyOwned || newlyInSigl) {
              nextFrontier.add(childId);
            }
          }
        }
      }

      if (nextCacheOnlyChildIds.length > 0 && cacheStore) {
        const networkSet = new Set(nextNetworkChildIds);
        const cacheLookupIds = Array.from(
          new Set(nextCacheOnlyChildIds.filter((id) => !networkSet.has(id)))
        );
        if (cacheLookupIds.length > 0) {
          const cachedChildren = cacheStore.getProducts(cacheLookupIds, market, nowMs);
          for (const [cid, cprod] of cachedChildren.entries()) {
            if (hasStaleCachedDesktopPassGrants(cprod, nowMs)) continue;
            hydratedProducts.set(cid, cprod);
            cachedSourceIds.add(cid);
            nextFrontier.add(cid);
          }
        }
      }

      if (nextNetworkChildIds.length > 0) {
        const uniqueNetworkChildIds = Array.from(new Set(nextNetworkChildIds));
        const childHydrated = await hydrateDisplayCatalogProducts(uniqueNetworkChildIds, {
          market,
          languages: `${locale},neutral`,
          cacheStore,
          fetchImpl,
          signal: options.signal,
          nowMs,
          cachedSourceIds,
          hydrationStats,
          maxBatchRetries: options.maxBatchRetries,
          retryBaseDelayMs: options.retryBaseDelayMs,
        });
        for (const [cid, cprod] of childHydrated.entries()) {
          hydratedProducts.set(cid, cprod);
          nextFrontier.add(cid);
        }
      }

      if (nextFrontier.size === 0) break;
      frontierIds = Array.from(nextFrontier);
    }

    if (syncMode !== 'owned_only') {
      const prelimLineageIds = Array.from(bundleLineage.keys());
      const prelimIds = Array.from(new Set([...candidateSeedIds, ...prelimLineageIds]));
      const rejectedAtMap =
        cacheStore && typeof cacheStore.getLayer3RejectedMap === 'function'
          ? cacheStore.getLayer3RejectedMap(prelimIds, market)
          : new Map();
      const staleLayer3RefreshIds = new Set();
      const newlyRejectedLayer3Ids = new Set();
      const clearedLayer3Ids = new Set();

      for (const pid of prelimIds) {
        const prod = hydratedProducts.get(pid);
        if (!prod) continue;
        const lin = bundleLineage.get(pid);
        const rawInSigl = activePcSiglSet.has(pid) || Boolean(lin?.inSiglFromParent);
        if (!rawInSigl) continue;
        const preLayer3 = evaluateLayer3DesktopLicenseGate(
          prod,
          lin,
          hydratedProducts,
          expandedCapabilityPassSet,
          nowMs
        );
        if (!preLayer3.allowed) {
          const prevRejectedAt = Number(rejectedAtMap.get(pid) || 0);
          const isWithinRejectionTtl =
            !forceRefresh &&
            !subscriptionChanged &&
            prevRejectedAt > 0 &&
            nowMs - prevRejectedAt < LAYER3_REJECTED_TTL_MS;

          if (cachedSourceIds.has(pid)) {
            if (!isWithinRejectionTtl && typeof fetchImpl === 'function') {
              staleLayer3RefreshIds.add(pid);
              if (Array.isArray(lin?.parentKeys)) {
                for (const pk of lin.parentKeys) {
                  const pBigId = String(pk || '').split(':')[0];
                  if (pBigId && cachedSourceIds.has(pBigId)) {
                    staleLayer3RefreshIds.add(pBigId);
                  }
                }
              }
            }
          } else if (!hydrationStats.failedProductIds.has(pid)) {
            newlyRejectedLayer3Ids.add(pid);
          }
        } else if (rejectedAtMap.has(pid)) {
          clearedLayer3Ids.add(pid);
        }
      }

      if (staleLayer3RefreshIds.size > 0 && typeof fetchImpl === 'function') {
        const refreshedLayer3Map = await hydrateDisplayCatalogProducts(
          Array.from(staleLayer3RefreshIds),
          {
            market,
            languages: `${locale},neutral`,
            cacheStore,
            fetchImpl,
            signal: options.signal,
            nowMs,
            bypassCache: true,
            hydrationStats,
            maxBatchRetries: options.maxBatchRetries,
            retryBaseDelayMs: options.retryBaseDelayMs,
          }
        );
        for (const [rid, rprod] of refreshedLayer3Map.entries()) {
          hydratedProducts.set(rid, rprod);
          cachedSourceIds.delete(rid);
        }
        const failedRefreshIds =
          /** @type {any} */ (refreshedLayer3Map)?.failedProductIds instanceof Set
            ? /** @type {Set<string>} */ (/** @type {any} */ (refreshedLayer3Map).failedProductIds)
            : new Set();
        for (const rid of staleLayer3RefreshIds) {
          if (failedRefreshIds.has(rid)) continue;
          const rprod = hydratedProducts.get(rid);
          if (!rprod) continue;
          const rlin = bundleLineage.get(rid);
          const rawInSigl = activePcSiglSet.has(rid) || Boolean(rlin?.inSiglFromParent);
          if (!rawInSigl) continue;
          const postLayer3 = evaluateLayer3DesktopLicenseGate(
            rprod,
            rlin,
            hydratedProducts,
            expandedCapabilityPassSet,
            nowMs
          );
          if (!postLayer3.allowed) {
            newlyRejectedLayer3Ids.add(rid);
          } else {
            clearedLayer3Ids.add(rid);
          }
        }
      }

      if (newlyRejectedLayer3Ids.size > 0 && cacheStore && typeof cacheStore.markLayer3Rejected === 'function') {
        cacheStore.markLayer3Rejected(Array.from(newlyRejectedLayer3Ids), market, nowMs);
      }
      if (clearedLayer3Ids.size > 0 && cacheStore && typeof cacheStore.clearLayer3Rejected === 'function') {
        cacheStore.clearLayer3Rejected(Array.from(clearedLayer3Ids), market);
      }
    }

    const parentKeysWithDesktopChild = new Set();
    for (const [childId, lin] of bundleLineage.entries()) {
      const childProd = hydratedProducts.get(childId);
      if (!childProd) continue;
      const skus = Array.isArray(childProd.DisplaySkuAvailabilities)
        ? childProd.DisplaySkuAvailabilities
        : [];
      const hasDesktopPkg = skus.some(
        (av) =>
          Array.isArray(av?.Sku?.Properties?.Packages) &&
          av.Sku.Properties.Packages.some((pkg) => isDesktopEligiblePackage(pkg))
      );
      if (hasDesktopPkg) {
        for (const pk of lin.parentKeys || []) {
          parentKeysWithDesktopChild.add(pk);
        }
      }
    }

    // Structural cross-platform runtime admission when verified by runtime entitlement:
    // admit packageless / <=100 MiB bootstrapper SKUs that explicitly declare non-Windows desktop platforms
    // (macOS/OSX/Linux) or `_crossPlatformLauncherRuntime` in DisplayCatalog metadata.
    if (crossPlatformRuntimeVerified) {
      for (const candId of [...ownedSet, ...activePcSiglSet]) {
        const prod = hydratedProducts.get(candId);
        if (!prod) continue;
        const kind = String(prod.ProductKind || prod.ProductType || '').toLowerCase();
        if (kind !== 'game') continue;
        const skus = Array.isArray(prod.DisplaySkuAvailabilities)
          ? prod.DisplaySkuAvailabilities
          : [];
        let maxPkgDlBytes = 0;
        let hasAnyPkg = false;
        let declaresCrossPlatformOs = Boolean(prod._crossPlatformLauncherRuntime);
        for (const av of skus) {
          const pkgs = av?.Sku?.Properties?.Packages;
          if (Array.isArray(pkgs) && pkgs.length > 0) {
            hasAnyPkg = true;
            for (const p of pkgs) {
              const dl = Number(p?.MaxDownloadSizeInBytes || 0) || 0;
              if (dl > maxPkgDlBytes) maxPkgDlBytes = dl;
            }
          }
          if (!declaresCrossPlatformOs && Array.isArray(av?.Availabilities)) {
            for (const availability of av.Availabilities) {
              const allowed = availability?.Conditions?.ClientConditions?.AllowedPlatforms;
              if (Array.isArray(allowed)) {
                for (const ap of allowed) {
                  const pName = String(typeof ap === 'string' ? ap : ap?.PlatformName || '')
                    .trim()
                    .toLowerCase();
                  if (pName === 'macos' || pName === 'osx' || pName === 'linux') {
                    declaresCrossPlatformOs = true;
                  }
                }
              }
            }
          }
        }
        const hasAnyBundled = skus.some(
          (av) =>
            Array.isArray(av?.Sku?.Properties?.BundledSkus) &&
            av.Sku.Properties.BundledSkus.length > 0
        );
        if (
          (!hasAnyPkg || (maxPkgDlBytes > 0 && maxPkgDlBytes <= 100 * 1024 * 1024)) &&
          !hasAnyBundled &&
          declaresCrossPlatformOs
        ) {
          crossPlatformRuntimeProductIds.add(candId);
        }
      }
    }

    const games = [];
    const suppressedItems = [];
    const seenProductIds = new Set();

    const lineageCandidateIds =
      syncMode === 'owned_only'
        ? Array.from(bundleLineage.entries())
            .filter(([, lin]) => lin.ownedFromParent)
            .map(([cid]) => cid)
        : Array.from(bundleLineage.keys());

    const allEvaluatedIds = Array.from(
      new Set([...candidateSeedIds, ...lineageCandidateIds])
    );

    for (const productId of allEvaluatedIds) {
      if (seenProductIds.has(productId)) continue;
      const product = hydratedProducts.get(productId);
      if (!product) {
        if (
          hydrationStats.failedProductIds.has(productId) &&
          (ownedSet.has(productId) || localInstalledProductIds.has(productId))
        ) {
          seenProductIds.add(productId);
          const achDec = titleHubDecorations.byProductId?.[productId] || null;
          const stubTitle = String(achDec?.name || `Xbox Owned Title (${productId})`).trim();
          const isLocalInst = localInstalledProductIds.has(productId);
          games.push({
            id: `xbox-${productId}`,
            title: stubTitle,
            originalStoreTitle: stubTitle,
            sortTitle: stubTitle.replace(/^(The|A|An)\s+/i, '') || stubTitle,
            isVerifiedEntitlement: true,
            hydrationIncompleteStub: true,
            nativePlatforms: ['windows'],
            worksOn: { windows: true, mac: false, linux: false },
            platforms: [
              {
                platformId: 'xbox',
                platformGameId: productId,
                storefrontAppId: productId,
                originalTitle: stubTitle,
                installed: isLocalInst,
                platforms: { windows: true, mac: false, linux: false },
                xboxProductId: productId,
                xboxTitleId: achDec?.titleId || undefined,
                scid: achDec?.scid || undefined,
                ownershipType: ownedSet.has(productId) ? 'owned' : 'subscription',
                playtimeMinutes: Number(achDec?.minutesPlayed || 0) || 0,
                lastPlayed: achDec?.lastTimePlayed || undefined,
                achievements: achDec?.summary || undefined,
              },
            ],
            headerImage: achDec?.displayImage || '',
            capsuleImage: achDec?.displayImage || '',
            shortDescription: '',
            releaseDate: '',
            developers: [],
            publishers: [],
            genres: [],
            tags: ['Xbox', 'Microsoft Store'],
          });
        }
        continue;
      }

      const lineage = bundleLineage.get(productId);
      const fromDesktopSiblingBundle = Boolean(
        lineage?.parentKeys?.some((pk) => parentKeysWithDesktopChild.has(pk))
      );

      const prePfnLower = extractProductCandidatePfn(product).toLowerCase();
      const preIdentityLower = prePfnLower.includes('_') ? prePfnLower.split('_')[0] : prePfnLower;
      const preLocalInstall =
        localInstallsByPfn instanceof Map
          ? (prePfnLower ? localInstallsByPfn.get(prePfnLower) : null) ||
            (preIdentityLower ? localInstallsByPfn.get(preIdentityLower) : null) ||
            null
          : null;
      const preIsInstalledLocally =
        Boolean(preLocalInstall?.installed) || localInstalledProductIds.has(productId);

      const evalResult = evaluateDisplayCatalogProduct(product, {
        crossPlatformRuntimeVerified,
        crossPlatformRuntimeProductIds,
        fromDesktopSiblingBundle,
        isInstalled: preIsInstalledLocally,
      });
      if (!evalResult.eligible) {
        if (evalResult.isSuppressedNonGame && evalResult.title) {
          const cleanTitle = (evalResult.title || '').trim();
          suppressedItems.push({
            id: `xbox-${productId}`,
            rawTitle: cleanTitle,
            platformId: 'xbox',
            platformGameId: productId,
            reason: evalResult.reason,
            reasonCategory: 'non_game_filter',
            rawGame: {
              id: `xbox-${productId}`,
              title: cleanTitle,
              originalStoreTitle: cleanTitle,
              sortTitle: cleanTitle.replace(/^(The|A|An)\s+/i, '').trim() || cleanTitle,
              isVerifiedEntitlement: true,
              platforms: [
                {
                  platformId: 'xbox',
                  platformGameId: productId,
                  installed: preIsInstalledLocally,
                  originalTitle: cleanTitle,
                },
              ],
              headerImage: '',
              capsuleImage: '',
              developers: [],
              publishers: [],
              genres: [],
              tags: ['Xbox'],
            },
          });
        }
        continue;
      }

      const isOwnedPermanent = ownedSet.has(productId) || Boolean(lineage?.ownedFromParent);
      const rawInActiveTierPcSigl =
        activePcSiglSet.has(productId) || Boolean(lineage?.inSiglFromParent);
      const layer3License = rawInActiveTierPcSigl
        ? evaluateLayer3DesktopLicenseGate(
            product,
            lineage,
            hydratedProducts,
            expandedCapabilityPassSet,
            nowMs
          )
        : { allowed: false, matchingPassIds: [] };
      const inActiveTierPcSigl = rawInActiveTierPcSigl && layer3License.allowed;

      const pfnLower = String(evalResult.packageFamilyName || '').trim().toLowerCase();
      const identityLower = pfnLower.includes('_') ? pfnLower.split('_')[0] : pfnLower;
      const titleIdStr = String(evalResult.xboxTitleId || '');

      const localInstall =
        localInstallsByPfn instanceof Map
          ? (pfnLower ? localInstallsByPfn.get(pfnLower) : null) ||
            (identityLower ? localInstallsByPfn.get(identityLower) : null) ||
            null
          : null;
      const isInstalledLocally =
        Boolean(localInstall?.installed) || localInstalledProductIds.has(productId);

      const isPlayedInTitleHub =
        playedProductIds.has(productId) ||
        (pfnLower ? playedPfns.has(pfnLower) : false) ||
        (identityLower ? playedPfns.has(identityLower) : false) ||
        (titleIdStr ? playedTitleIds.has(titleIdStr) : false);

      const gateDecision = evaluateXboxActiveAccessGate({
        syncMode,
        isOwnedPermanent,
        subscription,
        inActiveTierPcSigl,
        isPlayedInTitleHub,
        isInstalledLocally,
      });

      if (!gateDecision.admit) {
        continue;
      }

      seenProductIds.add(productId);

      const achDecoration =
        (titleIdStr && titleHubDecorations.byTitleId?.[titleIdStr]) ||
        (pfnLower && titleHubDecorations.byPfn?.[pfnLower]) ||
        (identityLower && titleHubDecorations.byPfn?.[identityLower]) ||
        titleHubDecorations.byProductId?.[productId] ||
        null;

      const resolvedTitleId = titleIdStr || achDecoration?.titleId || undefined;
      const resolvedScid =
        achDecoration?.scid ||
        evalResult.scid ||
        deriveDefaultScidFromTitleId(resolvedTitleId) ||
        undefined;

      const playtimeMinutes =
        (resolvedTitleId && playtimeByTitleId instanceof Map
          ? playtimeByTitleId.get(String(resolvedTitleId))
          : undefined) ??
        achDecoration?.minutesPlayed ??
        0;

      const lastPlayed = achDecoration?.lastTimePlayed || undefined;
      const achievementSummary = achDecoration?.summary || undefined;

      const nativePlatforms = [
        ...(evalResult.platforms.windows ? ['windows'] : []),
        ...(evalResult.platforms.mac ? ['mac'] : []),
      ];

      const isLeavingSoon =
        gateDecision.ownershipType !== 'owned' && leavingSoonSet.has(productId);
      const isRecentlyAddedToGamePass =
        inActiveTierPcSigl && recentlyAddedSet.has(productId);

      const tierAttribution =
        gateDecision.ownershipType !== 'owned'
          ? resolveGamePassTierAttribution(
              productId,
              lineage,
              grantingCapabilitiesByProductId,
              layer3License,
              subscription
            )
          : null;

      const tags = ['Xbox'];
      if (gateDecision.ownershipType === 'owned' || gateDecision.ownershipType === 'owned_and_subscription') {
        tags.push('Microsoft Store');
      }
      if (gateDecision.ownershipType === 'subscription' || gateDecision.ownershipType === 'owned_and_subscription') {
        tags.push(tierAttribution?.gamePassTier || subscription.tierDisplayName || 'Xbox Game Pass');
      }
      if (isLeavingSoon) tags.push('Leaving Soon');
      if (evalResult.externalStorefrontHandoff) {
        tags.push(`Requires ${evalResult.externalStorefrontHandoff.toUpperCase()}`);
      }

      const satisfyingEntitlementKeys = Array.from(
        new Set([
          ...(ownedSet.has(productId)
            ? [`${productId}:${entitlementData.ownedSkuByProduct.get(productId) || evalResult.selectedSkuId}`]
            : []),
          ...(lineage?.parentKeys || []),
          ...(inActiveTierPcSigl
            ? Array.isArray(subscription.activeEntitlementKeys) &&
              subscription.activeEntitlementKeys.length > 0
              ? subscription.activeEntitlementKeys
              : subscription.primaryProductId
                ? [
                    `${subscription.primaryProductId}:${XBOX_GAMING_PASS_REGISTRY[subscription.primaryProductId]?.defaultSkuId || '0010'}`,
                  ]
                : []
            : []),
        ])
      );

      const rawStoreTitle = evalResult.rawTitle || evalResult.title;
      const formattedHtml = formatPlainDescriptionToHtml(
        evalResult.detailedDescription || evalResult.shortDescription || ''
      );

      games.push({
        id: `xbox-${productId}`,
        title: evalResult.title,
        originalStoreTitle: rawStoreTitle,
        sortTitle: evalResult.title.replace(/^(The|A|An)\s+/i, ''),
        isVerifiedEntitlement: true,
        nativePlatforms,
        worksOn: evalResult.platforms,
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: productId,
            storefrontAppId: productId,
            originalTitle: rawStoreTitle,
            installed: Boolean(localInstall?.installed),
            installPath: localInstall?.installPath || undefined,
            executablePath: localInstall?.executablePath || undefined,
            installSize: evalResult.maxDownloadSizeBytes,
            maxDownloadSizeBytes: evalResult.maxDownloadSizeBytes,
            ...(evalResult.pcMaxInstallSizeBytes
              ? { pcMaxInstallSizeBytes: evalResult.pcMaxInstallSizeBytes }
              : {}),
            ...(evalResult.isExternalLauncherStubPackage
              ? { isExternalLauncherStubPackage: true }
              : {}),
            platforms: evalResult.platforms,
            xboxProductId: productId,
            packageFamilyName: evalResult.packageFamilyName,
            appUserModelId: evalResult.appUserModelId,
            xboxTitleId: resolvedTitleId,
            scid: resolvedScid,
            msaAppId: evalResult.msaAppId,
            ownershipType: gateDecision.ownershipType,
            gamePassTier:
              gateDecision.ownershipType !== 'owned'
                ? tierAttribution?.gamePassTier || subscription.tierDisplayName
                : undefined,
            ...(gateDecision.ownershipType !== 'owned' && tierAttribution?.subscriptionTierId
              ? { subscriptionTierId: tierAttribution.subscriptionTierId }
              : {}),
            ...(gateDecision.ownershipType !== 'owned' &&
            Array.isArray(tierAttribution?.satisfyingPassIds) &&
            tierAttribution.satisfyingPassIds.length > 0
              ? { satisfyingPassIds: tierAttribution.satisfyingPassIds }
              : {}),
            isLeavingSoon: isLeavingSoon || undefined,
            isRecentlyAddedToGamePass: isRecentlyAddedToGamePass || undefined,
            subscriptionExpired: gateDecision.subscriptionExpired || undefined,
            chainedLauncherHandoff: evalResult.externalStorefrontHandoff,
            externalStorefrontHandoff: evalResult.externalStorefrontHandoff,
            ...(evalResult.externalStorefrontHandoff
              ? { chainedHandoffTopology: 'publisher_managed' }
              : {}),
            ...(evalResult.isCrossPlatformLauncherRuntime
              ? { isCrossPlatformLauncherRuntime: true }
              : {}),
            ...(evalResult.externalLauncher ? { externalLauncher: evalResult.externalLauncher } : {}),
            ...(evalResult.externalLauncherUrl
              ? { externalLauncherUrl: evalResult.externalLauncherUrl }
              : {}),
            xboxBottleCompatibilityTier: evalResult.xboxBottleCompatibilityTier,
            ...(evalResult.xboxBottleCompatibilityReason
              ? { xboxBottleCompatibilityReason: evalResult.xboxBottleCompatibilityReason }
              : {}),
            playtimeMinutes: Number(playtimeMinutes || 0) || 0,
            lastPlayed,
            achievements: achievementSummary,
          },
        ],
        maxDownloadSizeBytes: evalResult.maxDownloadSizeBytes,
        ...(evalResult.pcMaxInstallSizeBytes
          ? { pcMaxInstallSizeBytes: evalResult.pcMaxInstallSizeBytes }
          : {}),
        ...(evalResult.isExternalLauncherStubPackage
          ? { isExternalLauncherStubPackage: true }
          : {}),
        ...(evalResult.isCrossPlatformLauncherRuntime
          ? { isCrossPlatformLauncherRuntime: true }
          : {}),
        ...(evalResult.externalStorefrontHandoff
          ? {
              chainedLauncherHandoff: evalResult.externalStorefrontHandoff,
              externalStorefrontHandoff: evalResult.externalStorefrontHandoff,
              chainedHandoffTopology: 'publisher_managed',
            }
          : {}),
        ...(evalResult.externalLauncher ? { externalLauncher: evalResult.externalLauncher } : {}),
        ...(evalResult.externalLauncherUrl
          ? { externalLauncherUrl: evalResult.externalLauncherUrl }
          : {}),
        xboxBottleCompatibilityTier: evalResult.xboxBottleCompatibilityTier,
        ...(evalResult.xboxBottleCompatibilityReason
          ? { xboxBottleCompatibilityReason: evalResult.xboxBottleCompatibilityReason }
          : {}),
        headerImage: evalResult.headerImage || evalResult.capsuleImage || '',
        capsuleImage: evalResult.capsuleImage || evalResult.headerImage || '',
        iconUrl: evalResult.iconUrl || undefined,
        shortDescription: evalResult.shortDescription || '',
        detailedDescription: formattedHtml || evalResult.detailedDescription || undefined,
        releaseDate: evalResult.releaseDate || '',
        developers: evalResult.developers,
        publishers: evalResult.publishers,
        genres: evalResult.genres,
        tags,
        rating: evalResult.rating100,
        enrichedMetadata: {
          name: evalResult.title,
          shortDescription: evalResult.shortDescription || '',
          detailedDescription: formattedHtml,
          aboutTheGame: formattedHtml,
          headerImage: evalResult.headerImage || evalResult.capsuleImage || '',
          capsuleImage: evalResult.capsuleImage || evalResult.headerImage || '',
          developers: evalResult.developers,
          publishers: evalResult.publishers,
          genres: evalResult.genres,
          tags,
          categories: evalResult.categories || [],
          screenshots: evalResult.screenshots.map((url, idx) => ({
            id: idx,
            pathThumbnail: url,
            pathFull: url,
          })),
          movies: evalResult.movies || [],
          releaseDate: evalResult.releaseDate || 'TBA',
          platforms: evalResult.platforms,
          metadataQuality: 'storefront_native',
          enrichedSource: 'xbox',
          xboxDeliveryHints: {
            contentId: evalResult.contentId,
            packageFullName: evalResult.packageFullName,
            wuCategoryId: evalResult.wuCategoryId,
            satisfyingEntitlementKeys,
            maxDownloadSizeBytes: evalResult.maxDownloadSizeBytes,
            ...(evalResult.pcMaxInstallSizeBytes
              ? { pcMaxInstallSizeBytes: evalResult.pcMaxInstallSizeBytes }
              : {}),
            ...(evalResult.isExternalLauncherStubPackage
              ? { isExternalLauncherStubPackage: true }
              : {}),
          },
        },
      });
    }

    const displayCatalogHydrationFailedBatchCount = Number(hydrationStats.failedBatchCount) || 0;
    const authoritativeComplete = Boolean(
      displayCatalogHydrationFailedBatchCount === 0 &&
        subscription.authoritativeDetection !== false &&
        siglFetchAuthoritative !== false &&
        (String(rawSyncMode || '').trim().toLowerCase() === 'subscription_only' ||
          entitlementData.authoritative !== false)
    );

    if (
      authoritativeComplete &&
      subscription.subscriptionFingerprint &&
      cacheStore &&
      typeof cacheStore.setMeta === 'function'
    ) {
      try {
        cacheStore.setMeta('lastSubscriptionFingerprint', subscription.subscriptionFingerprint);
      } catch {}
    }

    return {
      games,
      suppressedItems,
      subscription,
      syncMode,
      authoritativeComplete,
      displayCatalogHydrationFailedBatchCount,
      subscriptionChanged,
      stats: {
        ownedCount: ownedSet.size,
        activeSiglCount: activePcSiglSet.size,
        admittedCount: games.length,
        suppressedCount: suppressedItems.length,
        displayCatalogHydrationFailedBatchCount,
      },
    };
  } finally {
    cacheStore.close();
  }
}

/**
 * Fetches rich DisplayCatalog metadata for a single Xbox `ProductId` (`BigId`), or queries
 * Microsoft DisplayCatalog `autosuggest` + batch product lookup when `payload.query` / `payload.title`
 * is provided without a direct `BigId`.
 */
async function fetchXboxProductMetadata(payload = {}, options = {}) {
  const rawId = String(
    payload.xboxProductId || payload.productId || payload.storeId || payload.platformGameId || ''
  )
    .replace(/^xbox[-_:]/i, '')
    .trim()
    .toUpperCase();
  const hasValidBigId = Boolean(rawId && /^[A-Z0-9]{12}$/.test(rawId));
  const rawQuery = String(payload.query || payload.title || '').trim();
  const isExplicitQuerySearch =
    payload.query !== undefined && String(payload.query || '').trim() !== '';

  if (!hasValidBigId && !rawQuery) {
    return isExplicitQuerySearch ? { success: false, results: [] } : null;
  }

  const defaults = resolveDefaultXboxLocaleAndMarket({
    market: payload.market || options.market,
    locale: options.locale,
  });
  const market = payload.market || options.market || defaults.market;
  const languages = payload.languages || options.languages || `${defaults.locale},neutral`;
  const fetchImpl = resolveFetchImpl(options);
  const limit = Math.max(1, Math.min(20, Math.floor(Number(payload.limit) || 5)));

  const cacheStore = openXboxCatalogCacheStore(options.userDataDir || payload.userDataDir);
  try {
    if (hasValidBigId) {
      const map = await lookupDisplayCatalogProducts([rawId], {
        market,
        languages,
        cacheStore,
        fetchImpl,
        signal: options.signal,
      });
      const prod = map.get(rawId);
      if (prod) {
        let evalResult = evaluateDisplayCatalogProduct(prod);
        if (
          !evalResult.eligible &&
          evalResult.isBundleWrapper &&
          Array.isArray(evalResult.bundledSkus) &&
          evalResult.bundledSkus.length > 0
        ) {
          const orderedChildren = evalResult.bundledSkus
            .slice()
            .sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)))
            .map((b) => b.bigId);
          const childMap = await lookupDisplayCatalogProducts(orderedChildren, {
            market,
            languages,
            cacheStore,
            fetchImpl,
            signal: options.signal,
          });
          for (const childId of orderedChildren) {
            const childProd = childMap.get(childId);
            if (!childProd) continue;
            const childEval = evaluateDisplayCatalogProduct(childProd);
            if (childEval.eligible) {
              evalResult = childEval;
              break;
            }
          }
        }
        if (evalResult.eligible) {
          const record = buildXboxProductMetadataRecord(evalResult);
          return {
            success: true,
            product: record,
            ...(isExplicitQuerySearch ? { results: [record] } : {}),
            ...record,
          };
        }
      }
      if (!rawQuery) {
        return isExplicitQuerySearch ? { success: false, results: [] } : null;
      }
    }

    if (typeof fetchImpl !== 'function') {
      return isExplicitQuerySearch ? { success: false, results: [] } : null;
    }

    const autosuggestLang = String(languages).split(',')[0].trim() || defaults.locale;
    const searchUrl =
      `${DISPLAY_CATALOG_AUTOSUGGEST_URL}?market=${encodeURIComponent(market)}` +
      `&languages=${encodeURIComponent(autosuggestLang)}` +
      `&query=${encodeURIComponent(rawQuery)}` +
      `&productFamilyNames=Games`;

    let candidateIds = [];
    try {
      const searchRes = await fetchImpl(searchUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'MS-CV': makeCorrelationVector(),
        },
        signal: buildXboxFetchSignal(options.signal),
      });
      if (searchRes && searchRes.ok) {
        const searchJson = await searchRes.json();
        candidateIds = extractAutosuggestBigIds(searchJson).slice(
          0,
          Math.min(25, Math.max(limit * 3, 10))
        );
      }
    } catch {}

    if (candidateIds.length === 0) {
      return isExplicitQuerySearch ? { success: false, results: [] } : null;
    }

    const hydrated = await lookupDisplayCatalogProducts(candidateIds, {
      market,
      languages,
      cacheStore,
      fetchImpl,
      signal: options.signal,
    });

    const evalsByCandidate = new Map();
    const bundleChildIds = [];
    for (const cid of candidateIds) {
      const prod = hydrated.get(cid);
      if (!prod) continue;
      const ev = evaluateDisplayCatalogProduct(prod);
      evalsByCandidate.set(cid, ev);
      if (!ev.eligible && ev.isBundleWrapper && Array.isArray(ev.bundledSkus)) {
        const sortedChildren = ev.bundledSkus
          .slice()
          .sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)));
        for (const child of sortedChildren.slice(0, 2)) {
          if (child?.bigId && !hydrated.has(child.bigId)) {
            bundleChildIds.push(child.bigId);
          }
        }
      }
    }

    if (bundleChildIds.length > 0) {
      const childHydrated = await lookupDisplayCatalogProducts(bundleChildIds, {
        market,
        languages,
        cacheStore,
        fetchImpl,
        signal: options.signal,
      });
      for (const [k, v] of childHydrated.entries()) {
        hydrated.set(k, v);
      }
    }

    const results = [];
    const seenProductIds = new Set();
    for (const cid of candidateIds) {
      if (results.length >= limit) break;
      let ev = evalsByCandidate.get(cid);
      if (!ev) continue;
      if (!ev.eligible && ev.isBundleWrapper && Array.isArray(ev.bundledSkus)) {
        const sortedChildren = ev.bundledSkus
          .slice()
          .sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)));
        for (const child of sortedChildren) {
          const childProd = hydrated.get(child.bigId);
          if (!childProd) continue;
          const childEv = evaluateDisplayCatalogProduct(childProd);
          if (childEv.eligible) {
            ev = childEv;
            break;
          }
        }
      }
      if (!ev.eligible || seenProductIds.has(ev.productId)) continue;
      seenProductIds.add(ev.productId);
      results.push(buildXboxProductMetadataRecord(ev));
    }

    if (results.length === 0) {
      return isExplicitQuerySearch ? { success: false, results: [] } : null;
    }

    const firstResult = results[0];
    return {
      success: true,
      product: firstResult,
      results,
      ...firstResult,
    };
  } finally {
    cacheStore.close();
  }
}

module.exports = {
  isDesktopEligiblePackage,
  extractProductCandidatePfn,
  evaluateDisplayCatalogProduct,
  buildXboxProductMetadataRecord,
  clearCrossPlatformEntitlementCache,
  syncXboxCatalog,
  fetchXboxProductMetadata,
};
