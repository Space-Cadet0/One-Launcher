// @ts-check
'use strict';

/**
 * Virtual Windows Device Provisioning, `Clep` Challenge Generator, `RST2.srf` Device STS,
 * `<SPLicenseBlock>` Binary TLV Parser, `ClepSignState` Key Schedule & RFC 3394 `CIK` Unwrapper
 * (`xboxDeviceClep.cjs`).
 *
 * Thin facade preserving 100% of existing `module.exports` keys and signatures backed by
 * 5 cohesive sub-modules under `electron/storefronts/xbox/clep/`.
 */

const clepCryptoPrimitives = require('./clep/clepCryptoPrimitives.cjs');
const clepChallengeBuilder = require('./clep/clepChallengeBuilder.cjs');
const spLicenseParser = require('./clep/spLicenseParser.cjs');
const rst2SoapClient = require('./clep/rst2SoapClient.cjs');
const clepLicenseAcquisition = require('./clep/clepLicenseAcquisition.cjs');

const facade = {
  BLOCK_ID: clepCryptoPrimitives.BLOCK_ID,
  MKMS_CONTENT_CLIENT_CHALLENGE: clepLicenseAcquisition.MKMS_CONTENT_CLIENT_CHALLENGE,
  HOSTING_APP_DEFAULT_IDCRL: clepCryptoPrimitives.HOSTING_APP_DEFAULT_IDCRL,
  HOSTING_APP_MS_STORE: clepCryptoPrimitives.HOSTING_APP_MS_STORE,
  HOSTING_APP_TOKEN_BROKER: clepCryptoPrimitives.HOSTING_APP_TOKEN_BROKER,
  HOSTING_APP_XBOX_PC: clepCryptoPrimitives.HOSTING_APP_XBOX_PC,
  CLEP_INITIAL_STATE: clepCryptoPrimitives.CLEP_INITIAL_STATE,
  clepObfuscate: clepCryptoPrimitives.clepObfuscate,
  clepDeobfuscate: clepCryptoPrimitives.clepDeobfuscate,
  buildSyntheticHardwareTables: clepChallengeBuilder.buildSyntheticHardwareTables,
  buildClepChallengeBuffers: clepChallengeBuilder.buildClepChallengeBuffers,
  getLicenseChallenge: clepChallengeBuilder.getLicenseChallenge,
  deriveClepKeyFromSchedule: clepCryptoPrimitives.deriveClepKeyFromSchedule,
  buildKeyScheduleForTargetKey: clepCryptoPrimitives.buildKeyScheduleForTargetKey,
  decryptCbcZeroIv: clepCryptoPrimitives.decryptCbcZeroIv,
  encryptCbcZeroIv: clepCryptoPrimitives.encryptCbcZeroIv,
  aes128Cmac: clepCryptoPrimitives.aes128Cmac,
  parseBcryptRsaPrivateKeyToPem: clepCryptoPrimitives.parseBcryptRsaPrivateKeyToPem,
  exportPemToBcryptRsa2Blob: clepCryptoPrimitives.exportPemToBcryptRsa2Blob,
  formatMixedEndianGuid: clepCryptoPrimitives.formatMixedEndianGuid,
  encodeMixedEndianGuid: clepCryptoPrimitives.encodeMixedEndianGuid,
  aesKeyWrapRfc3394: clepCryptoPrimitives.aesKeyWrapRfc3394,
  aesKeyUnwrapRfc3394: clepCryptoPrimitives.aesKeyUnwrapRfc3394,
  unwrapContentCik: clepCryptoPrimitives.unwrapContentCik,
  wrapContentCik: clepCryptoPrimitives.wrapContentCik,
  extractAllSpLicenseBase64Blocks: spLicenseParser.extractAllSpLicenseBase64Blocks,
  extractSpLicenseBase64: spLicenseParser.extractSpLicenseBase64,
  verifyLicenseXmlDsigIfPresent: spLicenseParser.verifyLicenseXmlDsigIfPresent,
  parseSpLicenseBuffer: spLicenseParser.parseSpLicenseBuffer,
  parseSpLicenseBase64: spLicenseParser.parseSpLicenseBase64,
  generateSp800108SharedKey: clepCryptoPrimitives.generateSp800108SharedKey,
  deriveDoubleDerivedHmacKey: clepCryptoPrimitives.deriveDoubleDerivedHmacKey,
  unwrapClepHmacStateSecret: clepCryptoPrimitives.unwrapClepHmacStateSecret,
  buildSignedRst2SoapEnvelope: rst2SoapClient.buildSignedRst2SoapEnvelope,
  decryptRst2SoapEnvelope: rst2SoapClient.decryptRst2SoapEnvelope,
  decryptRst2EncryptedDataXml: rst2SoapClient.decryptRst2EncryptedDataXml,
  parseRst2TokenResponses: rst2SoapClient.parseRst2TokenResponses,
  exchangeUserTokenOnRst2: rst2SoapClient.exchangeUserTokenOnRst2,
  normalizeLicensingMsaTicket: clepLicenseAcquisition.normalizeLicensingMsaTicket,
  ensureDeviceLicenseContext: clepLicenseAcquisition.ensureDeviceLicenseContext,
  acquireTitleBrokerTicket: clepLicenseAcquisition.acquireTitleBrokerTicket,
  acquireContentCik: clepLicenseAcquisition.acquireContentCik,
  acquireStoreLicenseToken: clepLicenseAcquisition.acquireStoreLicenseToken,
};

spLicenseParser.bindFacade(facade);
clepLicenseAcquisition.bindFacade(facade);

module.exports = facade;
