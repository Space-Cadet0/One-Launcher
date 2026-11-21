// @ts-check
'use strict';

const regQueryClient = require('./registry/regQueryClient.cjs');
const storefrontRegistryDiscoverers = require('./registry/storefrontRegistryDiscoverers.cjs');
const publisherLauncherRegistryDiscoverer = require('./registry/publisherLauncherRegistryDiscoverer.cjs');

/**
 * Facade module preserving 100% of existing `windowsRegistryDiscovery.cjs` exports
 * backed by 3 cohesive sub-modules under `electron/utils/registry/`.
 */
module.exports = {
  // Core reg.exe client, bounded concurrency, OEM/UTF-8 decoding & cache management
  invalidateWindowsRegistryDiscoveryCache: regQueryClient.invalidateWindowsRegistryDiscoveryCache,
  refreshWindowsStorefrontRegistryCacheAsync:
    regQueryClient.refreshWindowsStorefrontRegistryCacheAsync,
  queryWindowsRegistryStringValue: regQueryClient.queryWindowsRegistryStringValue,
  queryWindowsRegistryStringValueAsync: regQueryClient.queryWindowsRegistryStringValueAsync,
  parseRegQuerySubkeysOutput: regQueryClient.parseRegQuerySubkeysOutput,
  enumerateWindowsRegistrySubkeys: regQueryClient.enumerateWindowsRegistrySubkeys,
  enumerateWindowsRegistrySubkeysAsync: regQueryClient.enumerateWindowsRegistrySubkeysAsync,
  decodeRegExeOutput: regQueryClient.decodeRegExeOutput,

  // Storefront client registry discoverers (spyable via `vi.spyOn`)
  discoverWindowsSteamRegistryPaths:
    storefrontRegistryDiscoverers.discoverWindowsSteamRegistryPaths,
  discoverWindowsGogGalaxyRegistryPaths:
    storefrontRegistryDiscoverers.discoverWindowsGogGalaxyRegistryPaths,
  discoverWindowsEpicRegistryPaths:
    storefrontRegistryDiscoverers.discoverWindowsEpicRegistryPaths,

  // Chained publisher launcher registry discoverers
  normalizePublisherLauncherId: publisherLauncherRegistryDiscoverer.normalizePublisherLauncherId,
  discoverWindowsPublisherLauncherPaths:
    publisherLauncherRegistryDiscoverer.discoverWindowsPublisherLauncherPaths,
  discoverWindowsPublisherLauncherPathsAsync:
    publisherLauncherRegistryDiscoverer.discoverWindowsPublisherLauncherPathsAsync,
};
