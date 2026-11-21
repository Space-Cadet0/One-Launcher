// @ts-check
'use strict';

/**
 * 100% backwards-compatible facade re-exporting pure launch policy resolution,
 * config sanitizers, and environment catalog from `electron/launcher/policy/*.cjs`.
 *
 * Mirrored 1:1 with `src/contracts/{launchPolicyResolver,launchConfigSanitizers,environmentCatalog}.ts`
 * and enforced by Gate 13 in `tests/staticArchitectureInvariants.test.ts`.
 */

const configSanitizers = require('./policy/configSanitizers.cjs');
const launchPolicyCore = require('./policy/launchPolicyCore.cjs');
const environmentCatalog = require('./policy/environmentCatalog.cjs');

module.exports = {
  ...configSanitizers,
  ...environmentCatalog,
  ...launchPolicyCore,
};
