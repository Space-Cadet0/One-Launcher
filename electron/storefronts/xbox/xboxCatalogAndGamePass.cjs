'use strict';

/**
 * Xbox PC / Mac Owned Entitlements, 2025/2026 Game Pass Tiers, SIGL v3/v2 Delta Cache,
 * Recursive `BundledSkus` BFS, 5-Gate Structural Filter, Strict Active-Access Gate,
 * and `.msixvc` Package Delivery Resolver — Thin Facade (`xboxCatalogAndGamePass.cjs`).
 */

const {
  GAMEPASS_SIGL_IDS,
  XBOX_GAMING_PASS_REGISTRY,
  XBOX_SUBSCRIPTION_TIERS,
  PCGAFD_KNOWN_SUBSCRIPTION_PRODUCT_IDS,
  NON_GAMING_OR_PERK_PASS_IGNORE_SET,
  XBOX_PASS_PRODUCT_IDS,
  EXTERNAL_STOREFRONT_HANDOFF_TABLE,
  alignXboxLocaleWithMarket,
  resolveDefaultXboxLocaleAndMarket,
  isXboxPassProductId,
  normalizeAllowedPackageDeliveryUrl,
  detectThirdPartyPfnHandoff,
  resolveStructuralExternalLauncherHandoff,
  normalizeXboxSyncMode,
  evaluateXboxActiveAccessGate,
} = require('./catalog/xboxCatalogConstants.cjs');

const {
  LAYER3_REJECTED_TTL_MS,
  projectCompactDisplayCatalogProduct,
  hasStaleCachedDesktopPassGrants,
  openXboxCatalogCacheStore,
  closeXboxCatalogCacheStore,
} = require('./catalog/xboxCatalogSqliteCache.cjs');

const {
  normalizeDisplayCatalogImageUri,
  extractDisplayCatalogMovies,
  extractDisplayCatalogCategories,
  formatPlainDescriptionToHtml,
  sanitizeDisplayCatalogReleaseDate,
  stripXboxPlatformDisambiguators,
  deriveDefaultScidFromTitleId,
} = require('./catalog/xboxCatalogMediaAndSanitizer.cjs');

const {
  hydrateDisplayCatalogProducts,
  lookupDisplayCatalogProducts,
  classifySubscriptionRecords,
  detectXboxSubscriptions,
  classifyXboxEntitlement,
  fetchXboxOwnedEntitlements,
  fetchSingleSiglFeed,
  fetchSingleSiglV3Feed,
  fetchActiveTierSiglSets,
  evaluateLayer3DesktopLicenseGate,
} = require('./catalog/xboxSubscriptionAndEntitlements.cjs');

const {
  evaluateDisplayCatalogProduct,
  buildXboxProductMetadataRecord,
  clearCrossPlatformEntitlementCache,
  syncXboxCatalog,
  fetchXboxProductMetadata,
} = require('./catalog/xboxCatalogGatesAndMapper.cjs');

const { resolveXboxPackageDeliveryInfo } = require('./catalog/xboxPackageDelivery.cjs');

module.exports = {
  GAMEPASS_SIGL_IDS,
  XBOX_GAMING_PASS_REGISTRY,
  XBOX_SUBSCRIPTION_TIERS,
  PCGAFD_KNOWN_SUBSCRIPTION_PRODUCT_IDS,
  NON_GAMING_OR_PERK_PASS_IGNORE_SET,
  XBOX_PASS_PRODUCT_IDS,
  EXTERNAL_STOREFRONT_HANDOFF_TABLE,
  alignXboxLocaleWithMarket,
  resolveDefaultXboxLocaleAndMarket,
  isXboxPassProductId,
  normalizeAllowedPackageDeliveryUrl,
  detectThirdPartyPfnHandoff,
  resolveStructuralExternalLauncherHandoff,
  projectCompactDisplayCatalogProduct,
  hasStaleCachedDesktopPassGrants,
  openXboxCatalogCacheStore,
  closeXboxCatalogCacheStore,
  LAYER3_REJECTED_TTL_MS,
  normalizeXboxSyncMode,
  evaluateXboxActiveAccessGate,
  evaluateLayer3DesktopLicenseGate,
  classifySubscriptionRecords,
  detectXboxSubscriptions,
  classifyXboxEntitlement,
  fetchXboxOwnedEntitlements,
  fetchSingleSiglFeed,
  fetchSingleSiglV3Feed,
  fetchActiveTierSiglSets,
  hydrateDisplayCatalogProducts,
  lookupDisplayCatalogProducts,
  normalizeDisplayCatalogImageUri,
  extractDisplayCatalogMovies,
  extractDisplayCatalogCategories,
  formatPlainDescriptionToHtml,
  sanitizeDisplayCatalogReleaseDate,
  stripXboxPlatformDisambiguators,
  deriveDefaultScidFromTitleId,
  evaluateDisplayCatalogProduct,
  buildXboxProductMetadataRecord,
  clearCrossPlatformEntitlementCache,
  syncXboxCatalog,
  fetchXboxProductMetadata,
  resolveXboxPackageDeliveryInfo,
};
