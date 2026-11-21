// @ts-check
'use strict';

const path = require('node:path');
const {
  LAUNCH_PROFILE_KEYS,
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  VALID_IN_GAME_BEHAVIORS,
  sanitizeLaunchMethod,
  sanitizeLegacyCompatLayer,
  normalizeStorefrontClientLifecycle,
  resolveEffectiveLifecyclePolicy,
  migrateLegacyHudConfig,
  resolveEffectivePerformanceHud,
  resolveEffectiveDisplayScalingMode,
  resolveEffectiveDisplayAspectRatio,
  sanitizeLauncherPerformanceSettings,
} = require('../policy/configSanitizers.cjs');

/**
 * Managed install sentinel & registry (`one_launcher_installed.json`),
 * `0o600` owner-only launch configuration persistence (`one_launcher_configs.json`),
 * and global launcher performance settings (`one_launcher_performance_settings.json`).
 *
 * Delegates all HUD, lifecycle, display-scaling, and performance settings sanitization
 * to Wave 1's canonical `electron/launcher/policy/configSanitizers.cjs`.
 */

const ONE_LAUNCHER_MANAGED_SENTINEL = '.one_launcher_managed';
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_IN_GAME_BEHAVIOR_SET = new Set(VALID_IN_GAME_BEHAVIORS);
const ARCHIVE_ASSET_EXT_RE =
  /\.(kpf|pak|wad|pk3|pk4|vpk|bsa|ba2|upk|uasset|umap|pck|bundle|assets|ress|resource|zip|7z|rar)$/i;

/**
 * @param {unknown} key
 * @returns {boolean}
 */
function isForbiddenObjectKey(key) {
  return typeof key !== 'string' || !key || FORBIDDEN_OBJECT_KEYS.has(key);
}

/**
 * Shallow-sanitize a plain environment map against prototype-pollution keys.
 * @param {unknown} rawEnv
 * @returns {Record<string, any> | undefined}
 */
function sanitizeEnvRecordKeys(rawEnv) {
  if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) return undefined;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(rawEnv)) {
    if (isForbiddenObjectKey(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * @typedef {Object} InstallAndLaunchConfigStoreDeps
 * @property {typeof import('node:fs')} fs
 * @property {(customDir?: string) => string} getUserDataDir
 * @property {(rawPath: string, customRoots?: string[]) => string} toLocalFsPath
 * @property {(filePath: string) => any} readCachedStateJsonSync
 * @property {(filePath: string, value: any, options?: { secure?: boolean, preserveBackup?: boolean }) => void} writeCachedStateJsonSync
 * @property {(filePath: string, content: string | Buffer) => void} atomicWriteFileSync
 * @property {(options?: Record<string, any>) => void} invalidateScanCaches
 * @property {(raw: any) => number | undefined} parseByteCountOrFormattedSize
 * @property {(gameId: string, entries: Array<{ fingerprint: string, field?: string, scopePath?: string }>, options?: Record<string, any>) => boolean} approveLaunchCommands
 * @property {(envKey: string, envValue: unknown) => string} computeLaunchEnvApprovalFingerprint
 * @property {any} diagLog
 */

/**
 * @param {InstallAndLaunchConfigStoreDeps} deps
 */
function createInstallAndLaunchConfigStore(deps) {
  const {
    fs,
    getUserDataDir,
    toLocalFsPath,
    readCachedStateJsonSync,
    writeCachedStateJsonSync,
    atomicWriteFileSync,
    invalidateScanCaches,
    parseByteCountOrFormattedSize,
    approveLaunchCommands,
    computeLaunchEnvApprovalFingerprint,
    diagLog,
  } = deps;

  /**
   * Write `.one_launcher_managed` JSON sentinel inside directories created directly by One Launcher.
   *
   * @param {string} installDir
   * @param {any} [metadata]
   * @returns {boolean}
   */
  function writeManagedInstallSentinel(installDir, metadata = {}) {
    if (!installDir || typeof installDir !== 'string') return false;
    try {
      if (!fs.existsSync(installDir) || !fs.statSync(installDir).isDirectory()) {
        return false;
      }
      const sentinelPath = path.join(installDir, ONE_LAUNCHER_MANAGED_SENTINEL);
      const payload = {
        schemaVersion: 1,
        store: String(metadata.store || metadata.platformId || 'custom'),
        gameId: String(metadata.gameId || metadata.platformGameId || ''),
        installKind: String(metadata.installKind || 'managed'),
        createdAt: metadata.createdAt || new Date().toISOString(),
      };
      atomicWriteFileSync(sentinelPath, JSON.stringify(payload, null, 2));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {string} installDir
   * @returns {any | null}
   */
  function readManagedInstallSentinel(installDir) {
    if (!installDir || typeof installDir !== 'string') return null;
    try {
      const sentinelPath = path.join(installDir, ONE_LAUNCHER_MANAGED_SENTINEL);
      if (!fs.existsSync(sentinelPath)) return null;
      const parsed = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && Number(parsed.schemaVersion) >= 1) {
        return parsed;
      }
    } catch {}
    return null;
  }

  /**
   * @param {string} installDir
   * @param {string} [expectedStore]
   * @returns {boolean}
   */
  function hasManagedInstallSentinel(installDir, expectedStore) {
    const parsed = readManagedInstallSentinel(installDir);
    if (!parsed) return false;
    if (
      expectedStore &&
      String(parsed.store || '').toLowerCase() !== String(expectedStore).toLowerCase()
    ) {
      return false;
    }
    return true;
  }

  /**
   * @param {string} [userDataDir]
   * @returns {string}
   */
  function getManagedInstalledFilePath(userDataDir) {
    return path.join(getUserDataDir(userDataDir), 'one_launcher_installed.json');
  }

  /**
   * @param {string} [userDataDir]
   * @returns {any[]}
   */
  function loadManagedInstalledGames(userDataDir) {
    const filePath = getManagedInstalledFilePath(userDataDir);
    try {
      const parsed = readCachedStateJsonSync(filePath);
      if (!parsed) return [];
      /** @type {any[]} */
      let records = [];
      if (Array.isArray(parsed)) {
        records = parsed;
      } else if (parsed && typeof parsed === 'object') {
        records = Array.isArray(parsed.installedGames)
          ? parsed.installedGames
          : Object.values(parsed);
      }
      let modified = false;
      for (const r of records) {
        if (!r || typeof r !== 'object') continue;
        if (r.platformId && r.platformId !== 'steam' && r.appId !== undefined) {
          delete r.appId;
          modified = true;
        }
        if (r.installSize !== undefined) {
          const sanitizedSize = parseByteCountOrFormattedSize(r.installSize);
          if (sanitizedSize !== r.installSize) {
            if (sanitizedSize) {
              r.installSize = sanitizedSize;
            } else {
              delete r.installSize;
            }
            modified = true;
          }
        }
      }
      if (modified) {
        saveManagedInstalledGames(records, userDataDir);
      }
      return records;
    } catch {}
    return [];
  }

  /**
   * @param {any[]} records
   * @param {string} [userDataDir]
   * @returns {boolean}
   */
  function saveManagedInstalledGames(records, userDataDir) {
    const filePath = getManagedInstalledFilePath(userDataDir);
    try {
      invalidateScanCaches();
      writeCachedStateJsonSync(filePath, records);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {any} record
   * @param {string} [userDataDir]
   * @returns {any[]}
   */
  function upsertManagedInstallRecord(record, userDataDir) {
    const cleanRecord = { ...record };
    if (cleanRecord.platformId !== 'steam') {
      delete cleanRecord.appId;
    }
    if (cleanRecord.installSize !== undefined) {
      const validInstallSize = parseByteCountOrFormattedSize(cleanRecord.installSize);
      if (validInstallSize) {
        cleanRecord.installSize = validInstallSize;
      } else {
        delete cleanRecord.installSize;
      }
    }
    const existing = loadManagedInstalledGames(userDataDir);
    const idx = existing.findIndex(
      (r) =>
        r.platformId === cleanRecord.platformId &&
        String(r.platformGameId) === String(cleanRecord.platformGameId)
    );
    if (idx >= 0) {
      const merged = { ...existing[idx], ...cleanRecord };
      if (merged.platformId !== 'steam') {
        delete merged.appId;
      }
      existing[idx] = merged;
    } else {
      existing.push(cleanRecord);
    }
    saveManagedInstalledGames(existing, userDataDir);
    invalidateScanCaches();
    return existing;
  }

  /**
   * @param {any} rawConfig
   * @param {string} [platformId]
   * @returns {any}
   */
  function resolvePlatformLaunchConfig(rawConfig, platformId) {
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) return {};
    const platMap =
      rawConfig.platformConfigs &&
      typeof rawConfig.platformConfigs === 'object' &&
      !Array.isArray(rawConfig.platformConfigs)
        ? rawConfig.platformConfigs
        : rawConfig.storefrontConfigs &&
            typeof rawConfig.storefrontConfigs === 'object' &&
            !Array.isArray(rawConfig.storefrontConfigs)
          ? rawConfig.storefrontConfigs
          : null;

    const safePlatformId =
      typeof platformId === 'string' && !isForbiddenObjectKey(platformId) ? platformId : '';

    /** @type {Record<string, any>} */
    let resolved;
    if (
      safePlatformId &&
      platMap &&
      Object.hasOwn(platMap, safePlatformId) &&
      platMap[safePlatformId] &&
      typeof platMap[safePlatformId] === 'object'
    ) {
      resolved = {
        gameId: rawConfig.gameId,
        preferredPlatformId: safePlatformId,
        launchMethod: 'auto',
        ...platMap[safePlatformId],
      };
    } else if (
      safePlatformId &&
      platMap &&
      Object.keys(platMap).length > 0 &&
      rawConfig.preferredPlatformId &&
      rawConfig.preferredPlatformId !== safePlatformId
    ) {
      resolved = {
        gameId: rawConfig.gameId,
        preferredPlatformId: safePlatformId,
        launchMethod: 'auto',
      };
    } else {
      resolved = { ...rawConfig };
    }

    if (resolved.compatibilityLayer === 'whisky') {
      resolved.compatibilityLayer = 'crossover';
    }
    if (resolved.launchMethod === 'custom') {
      resolved.launchMethod = 'auto';
    }
    return migrateLegacyHudConfig(resolved);
  }

  /**
   * @param {string} [userDataDir]
   * @returns {string}
   */
  function getLaunchConfigsFilePath(userDataDir) {
    return path.join(getUserDataDir(userDataDir), 'one_launcher_configs.json');
  }

  /**
   * @param {any} [options]
   * @returns {Record<string, any>}
   */
  function getGameLaunchConfigs(options = {}) {
    const filePath = getLaunchConfigsFilePath(options.userDataDir);
    try {
      const parsed = readCachedStateJsonSync(filePath);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const shouldPruneMissingOnDisk = options.pruneMissingExecutables === true;
        let modified = false;

        /** @type {Record<string, any>} */
        const cleanParsed = Object.create(null);

        for (const [gameKey, cfg] of Object.entries(parsed)) {
          if (isForbiddenObjectKey(gameKey)) {
            modified = true;
            continue;
          }
          if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
            cleanParsed[gameKey] = cfg;
            continue;
          }
          if (cfg.compatibilityLayer === 'whisky') {
            cfg.compatibilityLayer = 'crossover';
            modified = true;
          }
          if (cfg.launchMethod === 'custom') {
            cfg.launchMethod = 'auto';
            modified = true;
          }
          if (cfg.customExecutablePath) {
            const isArchiveAsset = ARCHIVE_ASSET_EXT_RE.test(String(cfg.customExecutablePath));
            if (isArchiveAsset) {
              delete cfg.customExecutablePath;
              modified = true;
            } else if (shouldPruneMissingOnDisk) {
              const localExe = toLocalFsPath(cfg.customExecutablePath, options.customRoots);
              if (!localExe || !fs.existsSync(localExe)) {
                delete cfg.customExecutablePath;
                modified = true;
              }
            }
          }
          if (shouldPruneMissingOnDisk && cfg.workingDirectory) {
            const localDir = toLocalFsPath(cfg.workingDirectory, options.customRoots);
            if (!localDir || !fs.existsSync(localDir)) {
              delete cfg.workingDirectory;
              modified = true;
            }
          }
          if (cfg.platformConfigs && typeof cfg.platformConfigs === 'object') {
            for (const [platId, prof] of Object.entries(cfg.platformConfigs)) {
              if (isForbiddenObjectKey(platId)) {
                delete cfg.platformConfigs[platId];
                modified = true;
                continue;
              }
              if (!prof || typeof prof !== 'object') continue;
              if (prof.compatibilityLayer === 'whisky') {
                prof.compatibilityLayer = 'crossover';
                modified = true;
              }
              if (prof.launchMethod === 'custom') {
                prof.launchMethod = 'auto';
                modified = true;
              }
              if (prof.customExecutablePath) {
                const isArchiveAsset = ARCHIVE_ASSET_EXT_RE.test(
                  String(prof.customExecutablePath)
                );
                if (isArchiveAsset) {
                  delete prof.customExecutablePath;
                  modified = true;
                } else if (shouldPruneMissingOnDisk) {
                  const localExe = toLocalFsPath(prof.customExecutablePath, options.customRoots);
                  if (!localExe || !fs.existsSync(localExe)) {
                    delete prof.customExecutablePath;
                    modified = true;
                  }
                }
              }
              if (shouldPruneMissingOnDisk && prof.workingDirectory) {
                const localDir = toLocalFsPath(prof.workingDirectory, options.customRoots);
                if (!localDir || !fs.existsSync(localDir)) {
                  delete prof.workingDirectory;
                  modified = true;
                }
              }
            }
          }
          cleanParsed[gameKey] = cfg;
        }

        if (
          modified &&
          (options.pruneMissingExecutables === true || options.persistPrunedConfigs === true)
        ) {
          try {
            writeCachedStateJsonSync(filePath, { ...cleanParsed }, { secure: true });
          } catch {}
        }

        /** @type {Record<string, any>} */
        const migratedAll = {};
        for (const [k, v] of Object.entries(cleanParsed)) {
          if (isForbiddenObjectKey(k)) continue;
          migratedAll[k] = v && typeof v === 'object' ? migrateLegacyHudConfig(v) : v;
        }
        return migratedAll;
      }
    } catch {}
    return {};
  }

  /**
   * @param {string} gameId
   * @param {any} [options]
   * @returns {Record<string, any> | null}
   */
  function getGameLaunchConfig(gameId, options = {}) {
    if (typeof gameId !== 'string' || !gameId || isForbiddenObjectKey(gameId)) return null;
    const all = getGameLaunchConfigs(options);
    return Object.hasOwn(all, gameId) && all[gameId] ? migrateLegacyHudConfig(all[gameId]) : null;
  }

  /**
   * Extract profile fields from a launch config object safely without prototype pollution.
   * @param {Record<string, any>} src
   * @returns {Record<string, any>}
   */
  function buildCleanProfileFields(src) {
    /** @type {Record<string, any>} */
    const cleanProfile = {
      launchMethod: sanitizeLaunchMethod(src.launchMethod),
    };
    for (const key of LAUNCH_PROFILE_KEYS) {
      if (!Object.hasOwn(src, key)) continue;
      const val = src[key];
      if (val === undefined || val === null) continue;
      if (key === 'compatibilityLayer') {
        cleanProfile[key] = sanitizeLegacyCompatLayer(val) ?? val;
      } else if (key === 'launchMethod') {
        cleanProfile[key] = sanitizeLaunchMethod(val);
      } else if (key === 'environmentVariables') {
        const cleanEnv = sanitizeEnvRecordKeys(val);
        if (cleanEnv) {
          cleanProfile[key] = cleanEnv;
        }
      } else {
        cleanProfile[key] = val;
      }
    }
    return cleanProfile;
  }

  /**
   * Persist per-game launch config (`one_launcher_configs.json`) using `0o600` secure atomic writes,
   * strict prototype-pollution guards, and explicit user-approval gating for `DYLD_INSERT_LIBRARIES`.
   *
   * @param {any} config
   * @param {any} [options]
   * @returns {{ success: boolean, config?: Record<string, any>, error?: string }}
   */
  function saveGameLaunchConfig(config, options = {}) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return { success: false, error: 'Invalid launch config: missing gameId' };
    }
    const gameId = typeof config.gameId === 'string' ? config.gameId : '';
    if (!gameId || isForbiddenObjectKey(gameId)) {
      return { success: false, error: 'Invalid launch config: missing or unsafe gameId' };
    }

    const filePath = getLaunchConfigsFilePath(options.userDataDir);
    const existingRaw = getGameLaunchConfigs(options);
    /** @type {Record<string, any>} */
    const existing = Object.create(null);
    for (const [k, v] of Object.entries(existingRaw)) {
      if (!isForbiddenObjectKey(k)) {
        existing[k] = v;
      }
    }

    if (config.reset === true) {
      delete existing[gameId];
      try {
        invalidateScanCaches();
        writeCachedStateJsonSync(filePath, { ...existing }, { secure: true });
        return { success: true, config: { gameId } };
      } catch (/** @type {any} */ err) {
        return { success: false, error: err.message };
      }
    }

    const cleanProfile = buildCleanProfileFields(config);
    const prevConfig =
      Object.hasOwn(existing, gameId) && existing[gameId] && typeof existing[gameId] === 'object'
        ? existing[gameId]
        : {};

    /** @type {Record<string, any>} */
    const mergedPlatformConfigs = Object.create(null);
    if (prevConfig.platformConfigs && typeof prevConfig.platformConfigs === 'object') {
      for (const [platId, prevProf] of Object.entries(prevConfig.platformConfigs)) {
        if (!isForbiddenObjectKey(platId) && prevProf && typeof prevProf === 'object') {
          mergedPlatformConfigs[platId] = prevProf;
        }
      }
    }

    if (config.platformConfigs && typeof config.platformConfigs === 'object') {
      for (const [platId, p] of Object.entries(config.platformConfigs)) {
        if (isForbiddenObjectKey(platId)) continue;
        if (p && typeof p === 'object' && !Array.isArray(p)) {
          mergedPlatformConfigs[platId] = buildCleanProfileFields(p);
        }
      }
    }

    const resetPlatId =
      typeof config.resetPlatformId === 'string' && !isForbiddenObjectKey(config.resetPlatformId)
        ? config.resetPlatformId
        : '';
    const prefPlatIdFromCfg =
      typeof config.preferredPlatformId === 'string' &&
      !isForbiddenObjectKey(config.preferredPlatformId)
        ? config.preferredPlatformId
        : '';
    const prefPlatIdFromPrev =
      typeof prevConfig.preferredPlatformId === 'string' &&
      !isForbiddenObjectKey(prevConfig.preferredPlatformId)
        ? prevConfig.preferredPlatformId
        : '';

    if (resetPlatId) {
      delete mergedPlatformConfigs[resetPlatId];
    } else if (prefPlatIdFromCfg) {
      mergedPlatformConfigs[prefPlatIdFromCfg] = { ...cleanProfile };
    }

    const preferredPlatformId = prefPlatIdFromCfg || prefPlatIdFromPrev;
    /** @type {Record<string, any>} */
    const updated = {
      gameId,
      ...(preferredPlatformId ? { preferredPlatformId } : {}),
      ...cleanProfile,
    };

    for (const [k, v] of Object.entries(config)) {
      if (
        isForbiddenObjectKey(k) ||
        k === 'gameId' ||
        k === 'preferredPlatformId' ||
        k === 'reset' ||
        k === 'resetPlatformId' ||
        k === 'platformConfigs' ||
        LAUNCH_PROFILE_KEYS.includes(k)
      ) {
        continue;
      }
      if (v !== undefined && v !== null) {
        updated[k] = v;
      }
    }

    const mergedPlatPlain = { ...mergedPlatformConfigs };
    if (Object.keys(mergedPlatPlain).length > 0) {
      updated.platformConfigs = mergedPlatPlain;
    }

    existing[gameId] = updated;
    try {
      invalidateScanCaches();
      writeCachedStateJsonSync(filePath, { ...existing }, { secure: true });

      // Never auto-approve `DYLD_INSERT_LIBRARIES` unless explicitly confirmed by user approval flow.
      const hasExplicitUserApproval = Boolean(
        options &&
          (options.approveLaunchCommands === true ||
            options.confirmInlineShellExecution === true)
      );
      const envVars =
        hasExplicitUserApproval &&
        config.environmentVariables &&
        typeof config.environmentVariables === 'object' &&
        !Array.isArray(config.environmentVariables)
          ? config.environmentVariables
          : null;
      if (envVars) {
        for (const [envKey, envVal] of Object.entries(envVars)) {
          if (isForbiddenObjectKey(envKey)) continue;
          if (
            String(envKey || '').trim().toUpperCase() === 'DYLD_INSERT_LIBRARIES' &&
            typeof envVal === 'string' &&
            envVal.trim()
          ) {
            approveLaunchCommands(
              gameId,
              [
                {
                  fingerprint: computeLaunchEnvApprovalFingerprint(
                    'DYLD_INSERT_LIBRARIES',
                    envVal.replace(/\0/g, '')
                  ),
                  field: 'environmentVariables.DYLD_INSERT_LIBRARIES',
                  scopePath: 'environmentVariables.DYLD_INSERT_LIBRARIES',
                },
              ],
              options
            );
          }
        }
      }

      return { success: true, config: updated };
    } catch (/** @type {any} */ err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * @param {any} [options]
   * @returns {string}
   */
  function getPerformanceSettingsFilePath(options = {}) {
    const customDir =
      options && typeof options === 'object'
        ? options.userDataDir || options.baseDir
        : typeof options === 'string'
          ? options
          : undefined;
    return path.join(getUserDataDir(customDir), 'one_launcher_performance_settings.json');
  }

  /**
   * @param {any} [options]
   */
  function getLauncherPerformanceSettings(options = {}) {
    const filePath = getPerformanceSettingsFilePath(options);
    try {
      const parsed = readCachedStateJsonSync(filePath);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return sanitizeLauncherPerformanceSettings(parsed);
      }
    } catch {}
    return { ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS };
  }

  /**
   * Persist global launcher performance settings and honestly propagate disk write errors
   * via non-enumerable `{ success: false, error, settings }` instead of reporting `success: true`.
   *
   * @param {any} [settings]
   * @param {any} [options]
   */
  function saveLauncherPerformanceSettings(settings = {}, options = {}) {
    const filePath = getPerformanceSettingsFilePath(options);
    const current = getLauncherPerformanceSettings(options);
    /** @type {Record<string, any>} */
    const rawNext =
      settings && typeof settings === 'object' && !Array.isArray(settings) ? { ...settings } : {};
    if (
      rawNext.defaultPerformanceHud === undefined &&
      (typeof rawNext.enableMetalHud === 'boolean' || typeof rawNext.enableMangoHud === 'boolean')
    ) {
      rawNext.defaultPerformanceHud =
        rawNext.enableMetalHud === true || rawNext.enableMangoHud === true;
    }
    const merged =
      rawNext.reset === true
        ? { ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS }
        : sanitizeLauncherPerformanceSettings({ ...current, ...rawNext });
    try {
      writeCachedStateJsonSync(filePath, merged);
    } catch (/** @type {any} */ err) {
      const errMsg =
        err && typeof err.message === 'string' && err.message
          ? err.message
          : String(err || 'Failed to persist launcher performance settings.');
      try {
        diagLog.warn('engineStateRegistry', 'Failed to persist launcher performance settings', {
          error: errMsg,
        });
      } catch {}
      const failedResult = { ...current };
      Object.defineProperties(failedResult, {
        success: { value: false, enumerable: false },
        error: { value: errMsg, enumerable: false },
        settings: { value: current, enumerable: false },
      });
      return failedResult;
    }
    const result = { ...merged };
    Object.defineProperties(result, {
      success: { value: true, enumerable: false },
      settings: { value: merged, enumerable: false },
    });
    return result;
  }

  /**
   * @param {any} [launchConfig]
   * @param {any} [perfSettingsOrOptions]
   * @param {any} [maybeOptions]
   */
  function resolveEffectivePerformancePolicy(
    launchConfig = {},
    perfSettingsOrOptions = {},
    maybeOptions = undefined
  ) {
    const isExplicitPerfObject =
      maybeOptions !== undefined ||
      Boolean(
        perfSettingsOrOptions &&
          typeof perfSettingsOrOptions === 'object' &&
          ('inGameLauncherBehavior' in perfSettingsOrOptions ||
            'defaultBottleDisplayScalingMode' in perfSettingsOrOptions ||
            'defaultDisplayAspectRatio' in perfSettingsOrOptions ||
            'storefrontClientLifecycle' in perfSettingsOrOptions ||
            'enableFullscreenHotkey' in perfSettingsOrOptions ||
            'defaultPerformanceHud' in perfSettingsOrOptions)
      );
    const effectiveOpts =
      maybeOptions !== undefined
        ? maybeOptions
        : isExplicitPerfObject &&
            perfSettingsOrOptions &&
            typeof perfSettingsOrOptions === 'object' &&
            ('userDataDir' in perfSettingsOrOptions || 'baseDir' in perfSettingsOrOptions)
          ? perfSettingsOrOptions
          : isExplicitPerfObject
            ? {}
            : perfSettingsOrOptions;

    const diskBase = getLauncherPerformanceSettings(effectiveOpts);
    const base =
      isExplicitPerfObject && perfSettingsOrOptions && typeof perfSettingsOrOptions === 'object'
        ? sanitizeLauncherPerformanceSettings({ ...diskBase, ...perfSettingsOrOptions })
        : diskBase;
    const cfg = launchConfig && typeof launchConfig === 'object' ? launchConfig : {};

    const inGameOverride =
      cfg.inGameLauncherBehavior &&
      cfg.inGameLauncherBehavior !== 'default' &&
      VALID_IN_GAME_BEHAVIOR_SET.has(cfg.inGameLauncherBehavior)
        ? cfg.inGameLauncherBehavior
        : base.inGameLauncherBehavior;

    const normCfgStorefront =
      cfg.storefrontClientLifecycle && cfg.storefrontClientLifecycle !== 'default'
        ? normalizeStorefrontClientLifecycle(cfg.storefrontClientLifecycle)
        : 'default';

    const storefrontOverride = resolveEffectiveLifecyclePolicy(
      normCfgStorefront || 'default',
      base.storefrontClientLifecycle
    );

    const effectiveDisplayScalingMode = /** @type {string} */ (
      resolveEffectiveDisplayScalingMode(cfg, base)
    );
    const effectiveDisplayAspectRatio = /** @type {string} */ (
      resolveEffectiveDisplayAspectRatio(cfg, base)
    );
    const enableFullscreenHotkey = base.enableFullscreenHotkey !== false;
    const effectivePerformanceHud = resolveEffectivePerformanceHud(cfg, base);

    return {
      ...base,
      inGameLauncherBehavior: inGameOverride,
      storefrontClientLifecycle: storefrontOverride,
      effectiveDisplayScalingMode,
      effectiveDisplayAspectRatio,
      enableFullscreenHotkey,
      effectivePerformanceHud,
    };
  }

  return {
    ONE_LAUNCHER_MANAGED_SENTINEL,
    writeManagedInstallSentinel,
    readManagedInstallSentinel,
    hasManagedInstallSentinel,
    loadManagedInstalledGames,
    saveManagedInstalledGames,
    upsertManagedInstallRecord,
    LAUNCH_PROFILE_KEYS,
    migrateLegacyHudConfig,
    resolveEffectivePerformanceHud,
    normalizeStorefrontClientLifecycle,
    resolvePlatformLaunchConfig,
    getGameLaunchConfigs,
    getGameLaunchConfig,
    saveGameLaunchConfig,
    DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
    getLauncherPerformanceSettings,
    saveLauncherPerformanceSettings,
    resolveEffectivePerformancePolicy,
  };
}

module.exports = {
  ONE_LAUNCHER_MANAGED_SENTINEL,
  createInstallAndLaunchConfigStore,
};
