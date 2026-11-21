// @ts-check
'use strict';

const xboxDeviceClep = require('./xboxDeviceClep.cjs');
const xboxAuthManager = require('./xboxAuthManager.cjs');
const xboxCatalogAndGamePass = require('./xboxCatalogAndGamePass.cjs');
const xboxAchievementsAndStats = require('./xboxAchievementsAndStats.cjs');
const msixvcXvdParser = require('./msixvcXvdParser.cjs');
const msixvcStreamExtractor = require('./msixvcStreamExtractor.cjs');
const xboxTitleStorageSync = require('./xboxTitleStorageSync.cjs');
const xboxRuntimeLoopbackServer = require('./xboxRuntimeLoopbackServer.cjs');

let xboxConfigAndIds = null;
try {
  xboxConfigAndIds = require('./xboxConfigAndIds.cjs');
} catch (err) {
  const errCode = /** @type {any} */ (err)?.code;
  const errMsg = String(/** @type {any} */ (err)?.message || '');
  const isMissingOptionalSelf =
    (errCode === 'MODULE_NOT_FOUND' || errCode === 'ENOENT') &&
    errMsg.includes('xboxConfigAndIds.cjs');
  if (!isMissingOptionalSelf) {
    throw err;
  }
}

/**
 * Intentional wrapper overrides where a downstream module intentionally wraps or adapts
 * an export name also present in an earlier module. Any OTHER diverging collision throws
 * immediately to prevent silent export clobbering across the Xbox barrel.
 */
const ALLOWED_DIVERGING_OVERRIDES = new Set([
  'deriveDefaultScidFromTitleId',
  'parseMicrosoftGameConfig',
  'parseAppxManifest',
]);

/**
 * Validates that no two Xbox modules export distinct values under the same barrel key
 * unless explicitly listed in `ALLOWED_DIVERGING_OVERRIDES`.
 *
 * @param {Array<[string, Record<string, any>]>} entries
 */
function assertNoUnexpectedBarrelCollisions(entries) {
  /** @type {Map<string, { owner: string, value: any }>} */
  const seen = new Map();
  for (const [moduleName, mod] of entries) {
    if (!mod || typeof mod !== 'object') continue;
    for (const key of Object.keys(mod)) {
      const value = mod[key];
      const existing = seen.get(key);
      if (existing && existing.value !== value && !ALLOWED_DIVERGING_OVERRIDES.has(key)) {
        throw new Error(
          `[xbox/index] Unexpected diverging export collision for "${key}" between ${existing.owner} and ${moduleName}`
        );
      }
      seen.set(key, { owner: moduleName, value });
    }
  }
}

assertNoUnexpectedBarrelCollisions([
  ...(xboxConfigAndIds ? [/** @type {[string, Record<string, any>]} */ (['xboxConfigAndIds', xboxConfigAndIds])] : []),
  ['xboxDeviceClep', xboxDeviceClep],
  ['xboxAuthManager', xboxAuthManager],
  ['xboxCatalogAndGamePass', xboxCatalogAndGamePass],
  ['xboxAchievementsAndStats', xboxAchievementsAndStats],
  ['msixvcXvdParser', msixvcXvdParser],
  ['msixvcStreamExtractor', msixvcStreamExtractor],
  ['xboxTitleStorageSync', xboxTitleStorageSync],
  ['xboxRuntimeLoopbackServer', xboxRuntimeLoopbackServer],
]);

module.exports = {
  ...(xboxConfigAndIds || {}),
  ...xboxDeviceClep,
  ...xboxAuthManager,
  ...xboxCatalogAndGamePass,
  ...xboxAchievementsAndStats,
  ...msixvcXvdParser,
  ...msixvcStreamExtractor,
  ...xboxTitleStorageSync,
  ...xboxRuntimeLoopbackServer,
  ...(xboxConfigAndIds ? { xboxConfigAndIds } : {}),
  xboxDeviceClep,
  xboxAuthManager,
  xboxCatalogAndGamePass,
  xboxAchievementsAndStats,
  msixvcXvdParser,
  msixvcStreamExtractor,
  xboxTitleStorageSync,
  xboxRuntimeLoopbackServer,
};
