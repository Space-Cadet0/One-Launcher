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
} catch {}

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
