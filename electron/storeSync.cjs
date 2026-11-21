// @ts-check
'use strict';

const tokenVault = require('./storefronts/tokenVault.cjs');
const { classifyNonGameStorefrontItem } = require('./storefronts/nonGameClassifier.cjs');
const shared = require('./storefronts/sync/storeSyncShared.cjs');
const gog = require('./storefronts/gog/gogCatalogAndAchievements.cjs');
const epicAuth = require('./storefronts/epic/epicAuthAndNamespaces.cjs');
const epicCatalog = require('./storefronts/epic/epicCatalogAndOfferCache.cjs');
const epicAchievements = require('./storefronts/epic/epicAchievementsProvider.cjs');
const suppressedScanner = require('./storefronts/sync/suppressedItemsScanner.cjs');
const xboxOrchestrator = require('./storefronts/sync/xboxSyncOrchestrator.cjs');

// Scoped vault-change handler:
// - NEVER wipes `xboxProviderCache` on routine Xbox token saves/writes (prevents listener leak).
// - Disposes cached Xbox providers cleanly (`provider.dispose?.()`) on Xbox/global token clears.
// - Scopes `recentlyRotatedTokens` clearing strictly to the mutated `storefrontId` & `filePath`.
tokenVault.onVaultChange((evt) => {
  if (!evt || typeof evt !== 'object') return;
  if (evt.action === 'clear') {
    if (!evt.storefrontId || evt.storefrontId === 'xbox') {
      xboxOrchestrator.disposeAllCachedXboxProviders();
    }
    if (!evt.storefrontId || evt.storefrontId === 'epic') {
      epicAuth.resetEpicCloudAuthState();
    }
    shared.clearRecentlyRotatedTokensForScope(evt.storefrontId, evt.filePath);
  } else if (evt.action === 'write') {
    if (!evt.storefrontId || evt.storefrontId === 'epic') {
      epicAuth.resetEpicCloudAuthState();
    }
    shared.clearRecentlyRotatedTokensForScope(evt.storefrontId, evt.filePath);
  }
});

function trimStoreSyncMemory() {
  gog.trimGogSyncMemory();
  epicCatalog.trimEpicCatalogAndOfferMemory();
  xboxOrchestrator.trimXboxSyncMemory();
  shared.trimStoreSyncSharedMemory();
  epicAuth.trimEpicAuthAndNamespaceMemory();
  epicAchievements.trimEpicAchievementsMemory();
  suppressedScanner.trimSuppressedItemsScannerMemory();
}

/**
 * Facade module preserving 100% of existing `electron/storeSync.cjs` exports backed by
 * 7 cohesive sub-modules under `electron/storefronts/{sync,gog,epic}/`.
 */
module.exports = {
  // Constants & shared HTTP/FS/title helpers
  GOG_CLIENT_ID: shared.GOG_CLIENT_ID,
  EPIC_CLIENT_ID: shared.EPIC_CLIENT_ID,
  atomicWriteFileSync: shared.atomicWriteFileSync,
  escapeHtmlEntities: shared.escapeHtmlEntities,
  destroyScraperWindowCleanly: shared.destroyScraperWindowCleanly,
  trimStoreSyncMemory,
  fetchIgdbCover: shared.fetchIgdbCover,
  computeTokenSimilarity: shared.computeTokenSimilarity,

  // Token vault re-exports
  getMachineIdentityKeyMaterial: tokenVault.getMachineIdentityKeyMaterial,
  getOrCreateVaultSecret: tokenVault.getOrCreateVaultSecret,
  getOrCreateVaultSecretAsync: tokenVault.getOrCreateVaultSecretAsync,
  encryptTokensPayload: tokenVault.encryptTokensPayload,
  encryptTokensPayloadAsync: tokenVault.encryptTokensPayloadAsync,
  decryptTokensPayload: tokenVault.decryptTokensPayload,
  decryptTokensPayloadAsync: tokenVault.decryptTokensPayloadAsync,
  isMockOrCorruptedToken: tokenVault.isMockOrCorruptedToken,
  sanitizeStorefrontTokensObject: tokenVault.sanitizeStorefrontTokensObject,
  projectRedactedXboxSummary: xboxOrchestrator.projectRedactedXboxSummary,
  getTokensFilePath: tokenVault.getTokensFilePath,
  writeTokensFile: tokenVault.writeTokensFile,
  writeTokensFileAsync: tokenVault.writeTokensFileAsync,
  onVaultChange: tokenVault.onVaultChange,
  invalidateVaultMemoryCache: tokenVault.invalidateVaultMemoryCache,
  loadSavedTokens: tokenVault.loadSavedTokens,
  loadSavedTokensAsync: tokenVault.loadSavedTokensAsync,
  saveTokens: tokenVault.saveTokens,
  saveTokensAsync: tokenVault.saveTokensAsync,
  clearTokens: tokenVault.clearTokens,
  clearTokensAsync: tokenVault.clearTokensAsync,

  // Steam owned-games cache & `appdetails` EA handoff
  getSteamOwnedGamesCachePath: shared.getSteamOwnedGamesCachePath,
  loadSteamOwnedGamesCache: shared.loadSteamOwnedGamesCache,
  saveSteamOwnedGamesCache: shared.saveSteamOwnedGamesCache,
  clearSteamOwnedGamesCache: shared.clearSteamOwnedGamesCache,
  detectSteamAppDetailsChainedHandoff: shared.detectSteamAppDetailsChainedHandoff,
  enrichSteamGameFromAppDetails: shared.enrichSteamGameFromAppDetails,
  applySteamAppDetailsHandoffEnrichment: shared.enrichSteamGameFromAppDetails,
  fetchSteamProductAppDetailsMetadata: shared.fetchSteamProductAppDetailsMetadata,

  // GOG auth, catalog, Galaxy metadata & achievements
  exchangeGogCode: gog.exchangeGogCode,
  renewGogTokens: gog.renewGogTokens,
  normalizeGogAvatarUrl: gog.normalizeGogAvatarUrl,
  fetchGogAccount: gog.fetchGogAccount,
  parseGogOsFlags: gog.parseGogOsFlags,
  bulkLoadLocalGalaxyMetadataMap: gog.bulkLoadLocalGalaxyMetadataMap,
  fetchGogOwnedGames: gog.fetchGogOwnedGames,
  resolveGogClientId: gog.resolveGogClientId,
  parseGogProfileAchievementsHtml: gog.parseGogProfileAchievementsHtml,
  fetchGogDetailedGameAchievements: gog.fetchGogDetailedGameAchievements,
  fetchGogAchievements: gog.fetchGogAchievements,

  // Epic auth, namespaces, offer cache, catalog & achievements
  epicOfferMetadataCache: epicCatalog.epicOfferMetadataCache,
  getEpicOfferCachePath: epicCatalog.getEpicOfferCachePath,
  exchangeEpicCode: epicAuth.exchangeEpicCode,
  renewEpicTokens: epicAuth.renewEpicTokens,
  fetchEpicOwnedGames: epicCatalog.fetchEpicOwnedGames,
  fetchEpicAchievements: epicAchievements.fetchEpicAchievements,
  fetchEpicPublicAchievementSchema: epicAchievements.fetchEpicPublicAchievementSchema,
  fetchEpicDetailedGameAchievements: epicAchievements.fetchEpicDetailedGameAchievements,
  computeEpicPartialProgress: epicAchievements.computeEpicPartialProgress,
  isEpicGraphqlAuthFailure: epicAchievements.isEpicGraphqlAuthFailure,
  getEpicGameAchievementSchema: epicAchievements.getEpicGameAchievementSchema,
  extractEpicRequirementsByOs: epicCatalog.extractEpicRequirementsByOs,
  fetchEpicProductOfferMetadata: epicCatalog.fetchEpicProductOfferMetadata,
  extractEpicCustomAttributesMap: epicAuth.extractEpicCustomAttributesMap,
  resolveEpicPartnerChainedHandoff: epicAuth.resolveEpicPartnerChainedHandoff,
  resolveEpicNamespaceAndIds: epicAuth.resolveEpicNamespaceAndIds,
  extractEpicMacSupportFromLegendaryDirs: epicAuth.extractEpicMacSupportFromLegendaryDirs,
  extractEpicMacSupportFromLegendaryDirsAsync: epicAuth.extractEpicMacSupportFromLegendaryDirsAsync,

  // Xbox orchestration
  getXboxAuthProvider: xboxOrchestrator.getXboxAuthProvider,
  loginXbox: xboxOrchestrator.loginXbox,
  syncXboxLibrary: xboxOrchestrator.syncXboxLibrary,
  fetchXboxOwnedGames: xboxOrchestrator.fetchXboxOwnedGames,
  fetchXboxAchievements: xboxOrchestrator.fetchXboxAchievements,
  fetchXboxDetailedGameAchievements: xboxOrchestrator.fetchXboxDetailedGameAchievements,
  getXboxGameAchievementSchema: xboxOrchestrator.getXboxGameAchievementSchema,
  fetchXboxProductOfferMetadata: xboxOrchestrator.fetchXboxProductOfferMetadata,
  getXboxStatus: xboxOrchestrator.getXboxStatus,
  setXboxSyncMode: xboxOrchestrator.setXboxSyncMode,
  xboxStorefront: xboxOrchestrator.xboxStorefront,

  // Classification & local suppressed storefront scanner
  classifyNonGameStorefrontItem,
  scanLocalSuppressedStorefrontItems: suppressedScanner.scanLocalSuppressedStorefrontItems,
};
