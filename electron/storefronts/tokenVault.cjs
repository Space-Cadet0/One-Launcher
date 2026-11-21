// @ts-check
'use strict';

const vaultKeyMaterial = require('./vault/vaultKeyMaterial.cjs');
const vaultCrypto = require('./vault/vaultCrypto.cjs');
const vaultMutexAndAtomicIo = require('./vault/vaultMutexAndAtomicIo.cjs');
const vaultStoreOperations = require('./vault/vaultStoreOperations.cjs');

/**
 * Facade module preserving 100% of existing `tokenVault.cjs` exports
 * backed by 4 cohesive sub-modules under `electron/storefronts/vault/`.
 */
module.exports = {
  // Key material & vault path resolution
  getMachineIdentityKeyMaterial: vaultKeyMaterial.getMachineIdentityKeyMaterial,
  getMachineIdentityKeyMaterialAsync: vaultKeyMaterial.getMachineIdentityKeyMaterialAsync,
  getHardwareFingerprint: vaultKeyMaterial.getMachineIdentityKeyMaterial,
  getTokensFilePath: vaultKeyMaterial.getTokensFilePath,
  getOrCreateVaultSecret: vaultKeyMaterial.getOrCreateVaultSecret,
  getOrCreateVaultSecretAsync: vaultKeyMaterial.getOrCreateVaultSecretAsync,

  // AES-256-GCM envelope crypto & credential sanitization
  encryptTokensPayload: vaultCrypto.encryptTokensPayload,
  encryptTokensPayloadAsync: vaultCrypto.encryptTokensPayloadAsync,
  decryptTokensPayload: vaultCrypto.decryptTokensPayload,
  decryptTokensPayloadAsync: vaultCrypto.decryptTokensPayloadAsync,
  isMockOrCorruptedToken: vaultCrypto.isMockOrCorruptedToken,
  sanitizeStorefrontTokensObject: vaultCrypto.sanitizeStorefrontTokensObject,
  projectRedactedXboxSummary: vaultCrypto.projectRedactedXboxSummary,

  // Mutex serialization & atomic secure disk I/O
  runWithVaultMutex: vaultMutexAndAtomicIo.runWithVaultMutex,
  acquireVaultLock: vaultMutexAndAtomicIo.acquireVaultLock,
  writeVaultAtomic: vaultMutexAndAtomicIo.writeVaultAtomic,

  // Storefront vault CRUD & cache lifecycle
  onVaultChange: vaultStoreOperations.onVaultChange,
  invalidateVaultMemoryCache: vaultStoreOperations.invalidateVaultMemoryCache,
  storeToken: vaultStoreOperations.storeToken,
  retrieveToken: vaultStoreOperations.retrieveToken,
  deleteToken: vaultStoreOperations.deleteToken,
  writeTokensFile: vaultStoreOperations.writeTokensFile,
  writeTokensFileAsync: vaultStoreOperations.writeTokensFileAsync,
  loadSavedTokens: vaultStoreOperations.loadSavedTokens,
  loadSavedTokensAsync: vaultStoreOperations.loadSavedTokensAsync,
  saveTokens: vaultStoreOperations.saveTokens,
  saveTokensAsync: vaultStoreOperations.saveTokensAsync,
  clearTokens: vaultStoreOperations.clearTokens,
  clearTokensAsync: vaultStoreOperations.clearTokensAsync,
};
