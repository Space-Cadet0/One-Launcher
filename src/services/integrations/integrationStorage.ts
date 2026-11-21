/**
 * Storefront integration & unified catalog storage barrel facade.
 * Delegates implementation to cohesive sub-modules under `./catalog/*`
 * while preserving 100% backwards-compatible exports and runtime semantics.
 */
export {
  STORAGE_KEY_VERIFIED_ENTITLEMENTS,
  STORAGE_KEY_XBOX_PROFILE,
  type XboxCachedProfileState,
  type VerifiedUserEntitlements,
  type RecordVerifiedEntitlementsOptions,
  loadXboxProfileState,
  saveXboxProfileState,
  clearXboxProfileState,
  getVerifiedUserEntitlements,
  formatXboxIntegrationStatusMessage,
  recordVerifiedUserEntitlements,
  clearVerifiedUserEntitlements,
  DEFAULT_INTEGRATIONS,
  loadIntegrations,
  saveIntegrations,
} from './catalog/entitlementsAndProfileStore';

export {
  computeCatalogFingerprint,
  computeCatalogGamesFingerprint,
  slimGameForLocalStorageQuota,
  compactGameForStorage,
} from './catalog/catalogSlimming';

export {
  normalizePlatformGameIdForLookup,
  preserveLocalInstallFieldsAcrossSanitize,
  type ReconcileCatalogInstalledOptions,
  reconcileCatalogGamesWithInstalledRecords,
} from './catalog/installedReconciler';

export {
  type MergeStorefrontGamesOptions,
  parseLastPlayedEpochMs,
  pickNewerLastPlayed,
  mergeStorefrontGames,
  mergeSyncedGamesIntoCatalog,
  mergeUpdatedGamePreservingLivePlatformState,
  mergeHydratedCatalogPreservingLiveState,
  removeStorefrontGames,
} from './catalog/catalogMerger';

export {
  type SaveCatalogOptions,
  scheduleLazySteamAnchorVaultRecovery,
  hydrateCatalogFromIndexedDb,
  loadNormalizedCatalogAsync,
  flushPendingCatalogSave,
  loadCurrentCatalog,
  loadSavedCatalog,
  saveCurrentCatalog,
  clearIntegrationStorage,
} from './catalog/catalogPersistence';

export {
  connectSteamIntegration,
  connectGogIntegration,
  connectEpicIntegration,
  connectXboxIntegration,
  disconnectIntegration,
} from './catalog/storefrontConnectorOrchestrator';
