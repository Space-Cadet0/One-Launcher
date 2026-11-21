// @ts-check
'use strict';

/**
 * Xbox Live & Microsoft Store Dual-Plane Authentication Manager (`xboxAuthManager.cjs`).
 *
 * Thin facade preserving 100% of existing `module.exports` keys and signatures backed by
 * 5 cohesive sub-modules under `electron/storefronts/xbox/auth/`.
 */

const xboxAuthConstantsAndUrl = require('./auth/xboxAuthConstantsAndUrl.cjs');
const xboxProofKeyAndSigning = require('./auth/xboxProofKeyAndSigning.cjs');
const xboxTicketAndNsalRouter = require('./auth/xboxTicketAndNsalRouter.cjs');
const xboxAuthProvider = require('./auth/xboxAuthProvider.cjs');

const facade = {
  XBOX_LIVESDK_CLIENT_ID: xboxAuthConstantsAndUrl.XBOX_LIVESDK_CLIENT_ID,
  XBOX_TOKEN_BROKER_CLIENT_ID: xboxAuthConstantsAndUrl.XBOX_TOKEN_BROKER_CLIENT_ID,
  XBOX_TOKEN_BROKER_SCOPE: xboxAuthConstantsAndUrl.XBOX_TOKEN_BROKER_SCOPE,
  XBOX_OAUTH_REDIRECT_URI: xboxAuthConstantsAndUrl.XBOX_OAUTH_REDIRECT_URI,
  MSA_INLINE_LOGIN_URL: xboxAuthConstantsAndUrl.MSA_INLINE_LOGIN_URL,
  CXH_USER_AGENT: xboxAuthConstantsAndUrl.CXH_USER_AGENT,
  TRUSTED_XBOX_AUTH_HOSTS: xboxAuthConstantsAndUrl.TRUSTED_XBOX_AUTH_HOSTS,
  SCOPE_XBL_MBI_SSL: xboxAuthConstantsAndUrl.SCOPE_XBL_MBI_SSL,
  SCOPE_MSSTORE_MBI_SSL: xboxAuthConstantsAndUrl.SCOPE_MSSTORE_MBI_SSL,
  SCOPE_DCAT_MBI_SSL: xboxAuthConstantsAndUrl.SCOPE_DCAT_MBI_SSL,
  XSTS_RELYING_PARTIES: xboxAuthConstantsAndUrl.XSTS_RELYING_PARTIES,
  MINECRAFT_ENTITLEMENT_CACHE_TTL_MS: xboxAuthConstantsAndUrl.MINECRAFT_ENTITLEMENT_CACHE_TTL_MS,
  buildRpXstsCacheKey: xboxAuthConstantsAndUrl.buildRpXstsCacheKey,
  racePromiseWithCallerSignal: xboxAuthConstantsAndUrl.racePromiseWithCallerSignal,
  getCachedEcPrivateKeyObject: xboxProofKeyAndSigning.getCachedEcPrivateKeyObject,
  generateXboxOAuthState: xboxAuthConstantsAndUrl.generateXboxOAuthState,
  verifyXboxOAuthState: xboxAuthConstantsAndUrl.verifyXboxOAuthState,
  isCompactJwe: xboxTicketAndNsalRouter.isCompactJwe,
  normalizeDecimalTitleId: xboxAuthConstantsAndUrl.normalizeDecimalTitleId,
  normalizeStoreMsaTicket: xboxTicketAndNsalRouter.normalizeStoreMsaTicket,
  normalizeXblRpsTicket: xboxTicketAndNsalRouter.normalizeXblRpsTicket,
  formatStoreAuthTickets: xboxTicketAndNsalRouter.formatStoreAuthTickets,
  generateXboxProofKeyPair: xboxProofKeyAndSigning.generateXboxProofKeyPair,
  exportProofKeyJwkFromPrivateKey: xboxProofKeyAndSigning.exportProofKeyJwkFromPrivateKey,
  deriveDashedUuidFromSeed: xboxProofKeyAndSigning.deriveDashedUuidFromSeed,
  buildXboxSignaturePayload: xboxProofKeyAndSigning.buildXboxSignaturePayload,
  signXboxRequest: xboxProofKeyAndSigning.signXboxRequest,
  verifyXboxRequestSignature: xboxProofKeyAndSigning.verifyXboxRequestSignature,
  mapXboxXstsError: xboxAuthConstantsAndUrl.mapXboxXstsError,
  resolvePreNsalBuiltInRelyingPartyForUrl:
    xboxTicketAndNsalRouter.resolvePreNsalBuiltInRelyingPartyForUrl,
  resolvePostNsalFallbackRelyingPartyForUrl:
    xboxTicketAndNsalRouter.resolvePostNsalFallbackRelyingPartyForUrl,
  resolveBuiltInRelyingPartyForUrl: xboxTicketAndNsalRouter.resolveBuiltInRelyingPartyForUrl,
  matchDynamicTitleEndpointRelyingParty:
    xboxTicketAndNsalRouter.matchDynamicTitleEndpointRelyingParty,
  extractAuthCodeFromInput: xboxAuthConstantsAndUrl.extractAuthCodeFromInput,
  buildXboxAuthorizationUrl: xboxAuthConstantsAndUrl.buildXboxAuthorizationUrl,
  isTrustedXboxAuthUrl: xboxAuthConstantsAndUrl.isTrustedXboxAuthUrl,
  buildInlineLoginRequest: xboxAuthConstantsAndUrl.buildInlineLoginRequest,
  createXboxAuthProvider: xboxAuthProvider.createXboxAuthProvider,
};

xboxAuthProvider.bindFacade(facade);

module.exports = facade;
