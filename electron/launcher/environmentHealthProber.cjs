// @ts-check
'use strict';

/**
 * Facade re-exporting all environment health probing, setup wizard state persistence,
 * client login detection, and 24-hour runner update cache helpers from cohesive
 * sub-modules under `electron/launcher/prober/`.
 *
 * Preserves 100% of existing `module.exports` and exported JSDoc `@typedef` contracts
 * while eliminating circular `require()` dependencies with `macNativeInstallerAndCodesign.cjs`
 * and `sessionAndProcessSupervisor.cjs`.
 */

/**
 * @typedef {import('./prober/setupWizardStateStore.cjs').EnvironmentComponentId} EnvironmentComponentId
 * @typedef {import('./prober/setupWizardStateStore.cjs').EnvironmentComponentCategory} EnvironmentComponentCategory
 * @typedef {import('./prober/setupWizardStateStore.cjs').EnvironmentComponentStatus} EnvironmentComponentStatus
 * @typedef {import('./prober/setupWizardStateStore.cjs').RecommendationTier} RecommendationTier
 * @typedef {import('./prober/setupWizardStateStore.cjs').ClientLoginTargetId} ClientLoginTargetId
 * @typedef {import('./prober/setupWizardStateStore.cjs').NonNativeRunnerType} NonNativeRunnerType
 * @typedef {import('./prober/setupWizardStateStore.cjs').StorefrontId} StorefrontId
 * @typedef {import('./prober/setupWizardStateStore.cjs').SetupWizardPersistedState} SetupWizardPersistedState
 * @typedef {import('./prober/setupWizardStateStore.cjs').DiscoveredLocalStoreHint} DiscoveredLocalStoreHint
 * @typedef {import('./prober/setupWizardStateStore.cjs').ClientAuthProbeState} ClientAuthProbeState
 * @typedef {import('./prober/setupWizardStateStore.cjs').EnvironmentComponentState} EnvironmentComponentState
 * @typedef {import('./prober/setupWizardStateStore.cjs').BottleEnvironmentSummary} BottleEnvironmentSummary
 * @typedef {import('./prober/setupWizardStateStore.cjs').EnvironmentHealthSnapshot} EnvironmentHealthSnapshot
 */

const {
  getSetupWizardState,
  saveSetupWizardState,
  loadSavedTokensReadOnly,
} = require('./prober/setupWizardStateStore.cjs');
const {
  PROBER_RUNNER_UPDATES_TTL_MS,
  getRunnerUpdateCheckCachePath,
  invalidateProberRunnerUpdatesCache,
  refreshRunnerUpdateCheckCacheAsync,
} = require('./prober/bottleAndRunnerProber.cjs');
const {
  parseSteamLoginUsersVdfDetails,
  readGogGalaxyDbUserReadOnly,
  parseWineGogRegistryUser,
  parseEpicGameUserSettingsIni,
  probeClientLoginStates,
} = require('./prober/clientAuthSessionProber.cjs');
const { probeEnvironmentHealth } = require('./prober/healthSnapshotAssembler.cjs');

module.exports = {
  getSetupWizardState,
  saveSetupWizardState,
  loadSavedTokensReadOnly,
  probeClientLoginStates,
  probeEnvironmentHealth,
  invalidateProberRunnerUpdatesCache,
  refreshRunnerUpdateCheckCacheAsync,
  getRunnerUpdateCheckCachePath,
  PROBER_RUNNER_UPDATES_TTL_MS,
  parseSteamLoginUsersVdfDetails,
  parseEpicGameUserSettingsIni,
  parseWineGogRegistryUser,
  readGogGalaxyDbUserReadOnly,
};
