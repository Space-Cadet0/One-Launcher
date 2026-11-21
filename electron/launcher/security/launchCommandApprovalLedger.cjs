// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const {
  resolveEffectiveUserDataDir,
  atomicWriteFileSync,
  atomicWriteSecureFileSync,
} = require('./pathContainmentAndFs.cjs');

const MAX_STATE_CACHE_FILES = 64;

/**
 * Dynamic-linker, runtime startup, interpreter preload, and shell startup environment keys
 * that can execute arbitrary code when passed to a child process.
 */
const DANGEROUS_LAUNCH_ENV_KEYS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FORCE_FLAT_NAMESPACE',
  'DYLD_ROOT_PATH',
  'DYLD_SHARED_REGION',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'ELECTRON_RUN_AS_NODE',
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'DOTNET_STARTUP_HOOKS',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'PROMPT_COMMAND',
  'IFS',
  'GCONV_PATH',
  'HOSTALIASES',
  'CX_ENV',
]);

const DANGEROUS_ENV_KEYS_ALT = Array.from(DANGEROUS_LAUNCH_ENV_KEYS)
  .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

// Matches dangerous env assignments at start-of-string, after whitespace, newlines (`\r`/`\n`),
// or shell command separators (`;`, `|`, `&`, `` ` ``, `(`, `)`) — preventing `;LD_PRELOAD=...`
// and newline env injection bypasses.
const DANGEROUS_INLINE_ENV_ASSIGN_RE = new RegExp(
  `(^|[\\s;|&\`()\\r\\n])(?:${DANGEROUS_ENV_KEYS_ALT})\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s;|&\`()\\r\\n]*)`,
  'gi'
);

const LAUNCH_SHELL_OR_EXEC_FIELDS = [
  'preLaunchCommand',
  'postExitCommand',
  'wrapperCommand',
  'customExecutable',
  'customExecutablePath',
  'executablePath',
];

const LAUNCH_ENV_MAP_FIELDS = new Set([
  'environmentVariables',
  'env',
  'envVars',
  'environment',
  'customEnv',
]);

const FORBIDDEN_RENDERER_IPC_KEYS = new Set([
  'execFileSync',
  'execFileSyncFn',
  'execFile',
  'execFileImpl',
  'execFileFn',
  'spawnFn',
  'gameSpawnFn',
  'bottleClientSpawnFn',
  'execFn',
  'fsImpl',
  'killImpl',
  'fetchImpl',
  'openExternalFn',
  'recoverEpicAuthFn',
  'refreshGogTokenFn',
  'bottleSteamProcessListFn',
  'getProcessListOutput',
  'mockProcessListOutput',
  'userDataDir',
  'homedir',
  'appPath',
  'resourcesPath',
  'brewBinaryPath',
  'legendaryBinaryPath',
  'gogdlBinaryPath',
  'wineBinaryPath',
  'crossoverPath',
  'whiskyPath',
  'gptkPath',
  'tokensFilePath',
  'filePath',
  'settingsFilePath',
  'configFilePath',
  'gogGalaxyDbPath',
  'gogGalaxyConfigPath',
  'gogGalaxyStorageDir',
  'eglManifestsDir',
  'allowExternalTokenRefresh',
  'allowCodesignInTest',
  'allowRegistryDiscoveryInTest',
  'enforceWindowsAclInTest',
  'machineIdOverride',
  'vaultSecretOverride',
  'windowsRegistryOutput',
  'windowsKnownFolders',
  'customApplicationsDir',
  'applicationsDirs',
  'arch',
  'platform',
  'allowLoopbackInstallerUrls',
  'mockFeeds',
  'previewPortalHtml',
  'previewCandidateUrls',
  'fetchFn',
  'httpGetText',
  'previewSessionFetch',
  'sessionFetch',
  'mockDirectDownload',
  'capturePreviewDownloadFn',
  'onExtractArchive',
  'onExecDitto',
  'onExecHdiutil',
  'onExecBrew',
  'verifySignatureFn',
  'electronMod',
  'skipProcessCheck',
  'skipStagingCodesignVerify',
  'skipBottleProvisioning',
  'skipNetwork',
]);

/**
 * Strict allowlist of user-facing keys accepted by `launcher:save-settings` /
 * `launcher:save-performance-settings`.
 */
const ALLOWED_LAUNCHER_SETTINGS_KEYS = new Set([
  'inGameLauncherBehavior',
  'postGameLauncherBehavior',
  'pauseDownloadsInGame',
  'pauseDownloadsWhilePlaying',
  'throttleDownloadsInGame',
  'pauseHydrationInGame',
  'pauseBackgroundSyncInGame',
  'pauseAnimationsInBackground',
  'hibernateRendererInGame',
  'muteAudioInBackground',
  'storefrontClientLifecycle',
  'autoShutdownWinePrefixOnExit',
  'suppressWineDebugLogging',
  'defaultBottleDisplayScalingMode',
  'defaultDisplayAspectRatio',
  'crossoverDisplayScalingMode',
  'crossoverDisplayAspect',
  'enableFullscreenHotkey',
  'defaultPerformanceHud',
  'ignoreLeadingTheWhenSorting',
  'reset',
  'hardwareAcceleration',
  'disableHardwareAcceleration',
  'backgroundThrottling',
  'lowMemoryMode',
  'lowPowerIdleMode',
  'memorySaverMode',
  'aggressiveMemoryTrim',
  'autoTrimMemory',
  'trimMemoryOnLaunch',
  'trimMemoryInGame',
  'maxConcurrentDownloads',
  'downloadConcurrency',
  'downloadSpeedLimitKbps',
  'downloadBandwidthLimit',
  'maxDownloadSpeedMbps',
  'downloadLimitMbps',
  'defaultInstallDir',
  'defaultInstallPath',
  'defaultInstallDirectory',
  'installDirectory',
  'libraryDirectories',
  'extraLibraryPaths',
  'additionalLibraryPaths',
  'libraryPaths',
  'defaultCompatLayer',
  'preferredCompatLayer',
  'preferredMacCompatLayer',
  'defaultBottleName',
  'autoUpdateCompatLayers',
  'enableCloudSaves',
  'enableCloudSaveSync',
  'cloudSaveSync',
  'cloudSaveSyncEnabled',
  'autoCloudSync',
  'autoSyncCloudSaves',
  'enableEsync',
  'enableFsync',
  'enableMsync',
  'enableDxvk',
  'enableD3dMetal',
  'enableGameMode',
  'minimizeToTray',
  'minimizeToTrayOnClose',
  'closeToTray',
  'startMinimized',
  'launchAtLogin',
  'launchOnStartup',
  'autoLaunch',
  'autoCheckUpdates',
  'autoCheckForUpdates',
  'checkForUpdatesOnStartup',
  'closeStorefrontClientAfterExit',
  'closeStorefrontClientsAfterExit',
  'autoCloseStorefrontClients',
  'closeHelperClientsPostSession',
  'suppressStorefrontClientPopups',
  'offlineVaultTier',
  'xboxSyncMode',
  'reduceMotion',
  'language',
  'locale',
  'theme',
  'telemetryEnabled',
  'diagnosticsEnabled',
  'debugLogging',
]);

/**
 * @template T
 * @param {Map<string, T>} map
 * @param {string} key
 * @param {T} value
 */
function setBoundedCache(map, key, value) {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= MAX_STATE_CACHE_FILES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/**
 * Strip dangerous dynamic-linker, Python/Perl/Ruby/JVM/.NET/shell startup, and Node/Electron
 * runtime injection environment keys from an `env` map or inline command string (including
 * semicolon/pipe/newline-prefixed injections like `;LD_PRELOAD=...` or `\nNODE_OPTIONS=...`).
 *
 * @param {unknown} rawEnv
 * @returns {string | Record<string, string>}
 */
function sanitizeLaunchEnvironmentMap(rawEnv) {
  if (typeof rawEnv === 'string') {
    let cleaned = rawEnv.replace(/\0/g, '');
    // Run iteratively in case adjacent dangerous assignments share a delimiter (e.g. `LD_PRELOAD=a;NODE_OPTIONS=b`)
    for (let pass = 0; pass < 4; pass += 1) {
      const next = cleaned.replace(DANGEROUS_INLINE_ENV_ASSIGN_RE, '$1');
      if (next === cleaned) break;
      cleaned = next;
    }
    return cleaned.trim();
  }
  if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
    return {};
  }
  /** @type {Record<string, string>} */
  const cleanEnv = {};
  for (const [rawKey, rawVal] of Object.entries(rawEnv)) {
    if (rawKey === '__proto__' || rawKey === 'constructor' || rawKey === 'prototype') continue;
    const trimmedKey = String(rawKey || '').trim();
    if (!trimmedKey || /[\0=\r\n\s]/.test(trimmedKey)) continue;
    if (DANGEROUS_LAUNCH_ENV_KEYS.has(trimmedKey.toUpperCase())) continue;
    if (
      rawVal === undefined ||
      rawVal === null ||
      typeof rawVal === 'function' ||
      typeof rawVal === 'object'
    ) {
      continue;
    }
    const strVal = String(rawVal);
    if (strVal.includes('\0') || /[\r\n]/.test(strVal)) continue;
    cleanEnv[trimmedKey] = strVal;
  }
  return cleanEnv;
}

/**
 * @param {string} envKey
 * @param {unknown} envValue
 * @returns {string}
 */
function computeLaunchEnvApprovalFingerprint(envKey, envValue) {
  return crypto
    .createHash('sha256')
    .update(`env:${String(envKey || '').trim().toUpperCase()}\0${String(envValue ?? '')}`)
    .digest('hex');
}

/**
 * Sanitize `environmentVariables` at child-process spawn time.
 * Always strips `DANGEROUS_LAUNCH_ENV_KEYS` (even from hand-edited `one_launcher_configs.json`),
 * permitting `DYLD_INSERT_LIBRARIES` ONLY when its exact `(gameId, key, value)` SHA-256 digest
 * was recorded in `approved_launch_commands.json` by trusted main-process `saveGameLaunchConfig`.
 *
 * @param {unknown} rawEnvMap
 * @param {{ gameId?: string, options?: Record<string, any> }} [approvalCtx]
 * @returns {Record<string, string>}
 */
function sanitizeSpawnEnvironmentMap(rawEnvMap, approvalCtx = {}) {
  if (!rawEnvMap || typeof rawEnvMap !== 'object' || Array.isArray(rawEnvMap)) {
    return {};
  }
  const clean = /** @type {Record<string, string>} */ (sanitizeLaunchEnvironmentMap(rawEnvMap));
  const cleanGameId = String(approvalCtx?.gameId || '').trim();
  if (cleanGameId) {
    for (const [k, v] of Object.entries(rawEnvMap)) {
      if (
        String(k || '').trim().toUpperCase() === 'DYLD_INSERT_LIBRARIES' &&
        typeof v === 'string' &&
        v.trim()
      ) {
        const cleanVal = v.replace(/\0/g, '');
        if (/[\r\n]/.test(cleanVal)) continue;
        const fp = computeLaunchEnvApprovalFingerprint('DYLD_INSERT_LIBRARIES', cleanVal);
        if (isLaunchCommandApproved(cleanGameId, fp, approvalCtx?.options || {})) {
          clean[k.trim()] = cleanVal;
        }
      }
    }
  }
  return clean;
}

/**
 * Build a safe child-process environment by merging `sanitizeSpawnEnvironmentMap(userEnvMap)`
 * onto `baseEnv` BEFORE applying trusted One Launcher `internalOverrides`.
 *
 * @param {Record<string, string | undefined>} [baseEnv]
 * @param {unknown} [userEnvMap]
 * @param {Record<string, string | undefined>} [internalOverrides]
 * @param {{ gameId?: string, options?: Record<string, any> }} [approvalCtx]
 * @returns {Record<string, string | undefined>}
 */
function buildSafeChildEnvironment(
  baseEnv = {},
  userEnvMap = null,
  internalOverrides = {},
  approvalCtx = {}
) {
  const safeBaseEnv = /** @type {Record<string, string>} */ (
    sanitizeLaunchEnvironmentMap(baseEnv || {})
  );
  const safeUserEnv = sanitizeSpawnEnvironmentMap(userEnvMap, approvalCtx);
  return {
    ...safeBaseEnv,
    ...safeUserEnv,
    ...(internalOverrides || {}),
  };
}

/**
 * Recursively sanitize renderer launch configs / launch payloads at ALL nesting depths
 * (top-level, `launchConfig`, `platformConfigs.*`, `storefrontConfigs.*`), stripping
 * forbidden DI keys, prototype pollution keys, and dangerous dynamic-linker env variables.
 *
 * @param {any} rawValue
 * @param {number} [depth=0]
 * @returns {any}
 */
function sanitizeLaunchConfigRecursive(rawValue, depth = 0) {
  if (depth > 10) return undefined;
  if (rawValue === null || rawValue === undefined) return rawValue;
  if (typeof rawValue === 'function') return undefined;
  if (Array.isArray(rawValue)) {
    return rawValue
      .map((item) => sanitizeLaunchConfigRecursive(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof rawValue !== 'object') {
    return typeof rawValue === 'string' ? rawValue.replace(/\0/g, '') : rawValue;
  }

  /** @type {Record<string, any>} */
  const clean = {};
  for (const [key, value] of Object.entries(rawValue)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (FORBIDDEN_RENDERER_IPC_KEYS.has(key)) continue;
    if (typeof value === 'function') continue;

    if (LAUNCH_ENV_MAP_FIELDS.has(key)) {
      clean[key] = sanitizeLaunchEnvironmentMap(value);
      continue;
    }

    const sanitizedChild = sanitizeLaunchConfigRecursive(value, depth + 1);
    if (sanitizedChild !== undefined) {
      clean[key] = sanitizedChild;
    }
  }
  return clean;
}

/**
 * Strict allowlist validator for `launcher:save-settings` / `launcher:save-performance-settings`.
 * Migrates legacy boolean `enableMetalHud` / `enableMangoHud` onto `defaultPerformanceHud`
 * when `defaultPerformanceHud` is not explicitly provided, without ever emitting the retired keys.
 *
 * @param {any} rawSettings
 * @returns {Record<string, any>}
 */
function sanitizeLauncherSettingsPayload(rawSettings) {
  if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
    return {};
  }
  /** @type {Record<string, any>} */
  const clean = {};
  for (const [key, value] of Object.entries(rawSettings)) {
    if (!Object.prototype.hasOwnProperty.call(rawSettings, key)) continue;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (!ALLOWED_LAUNCHER_SETTINGS_KEYS.has(key)) continue;

    if (typeof value === 'boolean') {
      clean[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      clean[key] = value;
    } else if (typeof value === 'string' && !value.includes('\0') && value.length <= 2048) {
      clean[key] = value;
    } else if (Array.isArray(value)) {
      clean[key] = value
        .filter((v) => typeof v === 'string' && !v.includes('\0') && v.length <= 2048)
        .slice(0, 64);
    }
  }
  const hasLegacyMetalHud =
    Object.prototype.hasOwnProperty.call(rawSettings, 'enableMetalHud') &&
    typeof rawSettings.enableMetalHud === 'boolean';
  const hasLegacyMangoHud =
    Object.prototype.hasOwnProperty.call(rawSettings, 'enableMangoHud') &&
    typeof rawSettings.enableMangoHud === 'boolean';
  if (clean.defaultPerformanceHud === undefined && (hasLegacyMetalHud || hasLegacyMangoHud)) {
    clean.defaultPerformanceHud =
      rawSettings.enableMetalHud === true || rawSettings.enableMangoHud === true;
  }
  return clean;
}

/**
 * Compute deterministic SHA-256 fingerprint for a `{ field, command }` launch override.
 *
 * @param {string} field
 * @param {unknown} rawCommand
 * @returns {string}
 */
function computeLaunchCommandFingerprint(field, rawCommand) {
  const normField = String(field || '').trim();
  const normCmd = String(rawCommand || '').trim();
  return crypto.createHash('sha256').update(`${normField}:${normCmd}`, 'utf8').digest('hex');
}

/**
 * Recursively collect every non-empty shell/executable field across ALL nesting depths.
 *
 * @param {unknown} cfg
 * @param {string} [scopePrefix]
 * @param {number} [depth]
 * @returns {Array<{ scopePath: string, field: string, value: string, fingerprint: string }>}
 */
function collectLaunchCommandsRecursive(cfg, scopePrefix = '', depth = 0) {
  /** @type {Array<{ scopePath: string, field: string, value: string, fingerprint: string }>} */
  const collected = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || depth > 10) {
    return collected;
  }

  for (const [key, value] of Object.entries(cfg)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (LAUNCH_ENV_MAP_FIELDS.has(key)) continue;

    if (LAUNCH_SHELL_OR_EXEC_FIELDS.includes(key)) {
      if (typeof value === 'string' && value.trim()) {
        const trimmed = value.trim();
        const scopePath = scopePrefix ? `${scopePrefix}.${key}` : key;
        collected.push({
          scopePath,
          field: key,
          value: trimmed,
          fingerprint: computeLaunchCommandFingerprint(key, trimmed),
        });
      }
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nextPrefix = scopePrefix ? `${scopePrefix}.${key}` : key;
      const nested = collectLaunchCommandsRecursive(value, nextPrefix, depth + 1);
      for (const item of nested) {
        collected.push(item);
      }
    }
  }

  return collected;
}

// ============================================================================
// Main-Process Approved Launch Commands Store (`userData/approved_launch_commands.json`)
// ============================================================================

/** @type {Map<string, { mtimeMs: number, size: number, data: { games: Record<string, any> } }>} */
const approvedCommandsCacheByFile = new Map();

/**
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function getApprovedLaunchCommandsFilePath(options = {}) {
  const userDataDir = resolveEffectiveUserDataDir(options);
  return path.join(userDataDir, 'approved_launch_commands.json');
}

/**
 * @param {Record<string, any>} [options]
 * @returns {{ games: Record<string, any> }}
 */
function readApprovedLaunchCommandsObject(options = {}) {
  const filePath = getApprovedLaunchCommandsFilePath(options);
  try {
    if (!fs.existsSync(filePath)) {
      approvedCommandsCacheByFile.delete(filePath);
      return { games: {} };
    }
    const st = fs.statSync(filePath);
    const cached = approvedCommandsCacheByFile.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.data;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const normalized =
      parsed && typeof parsed === 'object' && parsed.games && typeof parsed.games === 'object'
        ? parsed
        : { games: {} };
    setBoundedCache(approvedCommandsCacheByFile, filePath, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      data: normalized,
    });
    return normalized;
  } catch (err) {
    diagLog.warn('security.readApprovedLaunchCommands', err, { filePath });
    return { games: {} };
  }
}

/**
 * @param {string} gameId
 * @param {string} fingerprint
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function isLaunchCommandApproved(gameId, fingerprint, options = {}) {
  const cleanGameId = String(gameId || '').trim();
  const cleanFp = String(fingerprint || '').trim();
  if (!cleanGameId || !cleanFp) return false;
  const store = readApprovedLaunchCommandsObject(options);
  const gameApprovals = store?.games?.[cleanGameId];
  if (!gameApprovals || typeof gameApprovals !== 'object') return false;
  return Boolean(
    Object.prototype.hasOwnProperty.call(gameApprovals, cleanFp) &&
      gameApprovals[cleanFp]?.approved === true
  );
}

/**
 * @param {string} gameId
 * @param {Array<{ fingerprint: string, field?: string, scopePath?: string }>} entries
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function approveLaunchCommands(gameId, entries, options = {}) {
  const cleanGameId = String(gameId || '').trim();
  if (!cleanGameId || !Array.isArray(entries) || entries.length === 0) return false;
  const filePath = getApprovedLaunchCommandsFilePath(options);
  const current = readApprovedLaunchCommandsObject(options);
  const prevForGame =
    current?.games?.[cleanGameId] && typeof current.games[cleanGameId] === 'object'
      ? { ...current.games[cleanGameId] }
      : {};
  const nowIso = new Date().toISOString();

  for (const entry of entries) {
    if (!entry || !entry.fingerprint) continue;
    prevForGame[entry.fingerprint] = {
      approved: true,
      field: String(entry.field || ''),
      scopePath: String(entry.scopePath || entry.field || ''),
      approvedAt: nowIso,
    };
  }

  const nextPayload = {
    games: {
      ...(current?.games || {}),
      [cleanGameId]: prevForGame,
    },
    updatedAt: nowIso,
  };

  try {
    atomicWriteSecureFileSync(filePath, JSON.stringify(nextPayload, null, 2), options);
    approvedCommandsCacheByFile.delete(filePath);
    return true;
  } catch (err) {
    diagLog.warn('security.writeApprovedLaunchCommands', err, { filePath, gameId: cleanGameId });
    return false;
  }
}

/**
 * @param {string} gameId
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
function revokeApprovedLaunchCommands(gameId, options = {}) {
  const cleanGameId = String(gameId || '').trim();
  if (!cleanGameId) return false;
  const filePath = getApprovedLaunchCommandsFilePath(options);
  const current = readApprovedLaunchCommandsObject(options);
  if (!current?.games || !Object.prototype.hasOwnProperty.call(current.games, cleanGameId)) {
    return true;
  }
  const nextGames = { ...current.games };
  delete nextGames[cleanGameId];
  const nextPayload = { games: nextGames, updatedAt: new Date().toISOString() };
  try {
    atomicWriteSecureFileSync(filePath, JSON.stringify(nextPayload, null, 2), options);
    approvedCommandsCacheByFile.delete(filePath);
    return true;
  } catch (err) {
    diagLog.warn('security.revokeApprovedLaunchCommands', err, { filePath, gameId: cleanGameId });
    return false;
  }
}

/**
 * Enforce interactive `dialog.showMessageBox` user confirmation for any unapproved shell/executable
 * field at ANY nesting depth.
 *
 * @param {{
 *   gameId: string,
 *   configOrPayload: unknown,
 *   dialog: any,
 *   parentWindow?: any,
 *   options?: Record<string, any>,
 * }} params
 */
async function confirmAndApproveLaunchCommands({
  gameId,
  configOrPayload,
  dialog,
  parentWindow,
  options = {},
}) {
  const allEntries = collectLaunchCommandsRecursive(configOrPayload);
  if (allEntries.length === 0) {
    return { approved: true, unapprovedEntries: [] };
  }

  const cleanGameId = String(gameId || '').trim();
  if (!cleanGameId) {
    return {
      approved: false,
      error: 'Custom shell commands and executables require a valid gameId.',
    };
  }

  /** @type {Map<string, { scopePath: string, field: string, value: string, fingerprint: string }>} */
  const unapprovedByFp = new Map();
  for (const entry of allEntries) {
    if (!isLaunchCommandApproved(cleanGameId, entry.fingerprint, options)) {
      if (!unapprovedByFp.has(entry.fingerprint)) {
        unapprovedByFp.set(entry.fingerprint, entry);
      }
    }
  }

  const unapprovedEntries = [...unapprovedByFp.values()];
  if (unapprovedEntries.length === 0) {
    return { approved: true, unapprovedEntries: [] };
  }

  if (!dialog || typeof dialog.showMessageBox !== 'function') {
    return {
      approved: false,
      error: 'Custom shell commands require native OS confirmation.',
    };
  }

  const formattedCommands = unapprovedEntries
    .map((entry) => `${entry.scopePath}: ${entry.value}`)
    .join('\n');

  const boxOptions = {
    type: 'warning',
    buttons: ['Allow Shell Command', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'Confirm Custom Launch Command or Executable',
    message: 'Allow custom launch command or executable for this game?',
    detail:
      'Custom pre-launch, post-exit, wrapper commands, and custom executables run directly with your user permissions:\n\n' +
      formattedCommands,
  };

  const result =
    parentWindow && !parentWindow.isDestroyed?.()
      ? await dialog.showMessageBox(parentWindow, boxOptions)
      : await dialog.showMessageBox(boxOptions);

  if (!result || result.response !== 0) {
    return {
      approved: false,
      cancelled: true,
      error: 'Custom shell command cancelled by user.',
    };
  }

  approveLaunchCommands(cleanGameId, unapprovedEntries, options);
  return { approved: true, unapprovedEntries };
}

// ============================================================================
// Account Logout Tombstones (`one_launcher_disconnected_stores.json`)
// ============================================================================

/** @type {Map<string, { mtimeMs: number, size: number, data: { stores: Record<string, any> } }>} */
const tombstoneCacheByFile = new Map();

/**
 * @param {unknown} store
 * @returns {string}
 */
function normalizeStoreKey(store) {
  return String(store || '')
    .trim()
    .toLowerCase();
}

/**
 * @param {Record<string, any> | string} [options]
 * @returns {string}
 */
function getDisconnectedStoresFilePath(options = {}) {
  const userDataDir = resolveEffectiveUserDataDir(options);
  return path.join(userDataDir, 'one_launcher_disconnected_stores.json');
}

/**
 * @param {Record<string, any> | string} [options]
 * @returns {{ stores: Record<string, any> }}
 */
function readDisconnectedStoresObject(options = {}) {
  const filePath = getDisconnectedStoresFilePath(options);
  try {
    if (!fs.existsSync(filePath)) {
      tombstoneCacheByFile.delete(filePath);
      return { stores: {} };
    }
    const st = fs.statSync(filePath);
    const cached = tombstoneCacheByFile.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.data;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const normalized =
      parsed && typeof parsed === 'object' && parsed.stores && typeof parsed.stores === 'object'
        ? parsed
        : { stores: {} };
    setBoundedCache(tombstoneCacheByFile, filePath, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      data: normalized,
    });
    return normalized;
  } catch (err) {
    diagLog.warn('security.readDisconnectedStores', err, { filePath });
    return { stores: {} };
  }
}

/**
 * @param {string} store
 * @param {Record<string, any> | string} [options]
 * @returns {boolean}
 */
function isStoreDisconnectedTombstoned(store, options = {}) {
  const normStore = normalizeStoreKey(store);
  if (!normStore) return false;
  const parsed = readDisconnectedStoresObject(options);
  return Boolean(
    parsed?.stores &&
      Object.prototype.hasOwnProperty.call(parsed.stores, normStore) &&
      parsed.stores[normStore]?.disconnected === true
  );
}

/**
 * @param {string} store
 * @param {Record<string, any>} [options]
 */
function clearStoreDisconnectedTombstone(store, options = {}) {
  const normStore = normalizeStoreKey(store);
  if (!normStore) return { success: false };
  const filePath = getDisconnectedStoresFilePath(options);
  const current = readDisconnectedStoresObject(options);
  if (current?.stores && Object.prototype.hasOwnProperty.call(current.stores, normStore)) {
    const nextStores = { ...current.stores };
    delete nextStores[normStore];
    const nextPayload = { stores: nextStores, updatedAt: new Date().toISOString() };
    try {
      atomicWriteSecureFileSync(filePath, JSON.stringify(nextPayload, null, 2), options);
      tombstoneCacheByFile.delete(filePath);
    } catch (err) {
      diagLog.warn('security.clearTombstone', err, { store: normStore, filePath });
    }
  }
  return { success: true, store: normStore, tombstoned: false };
}

/**
 * Purge One Launcher's helper CLI credential files AND persist a logout tombstone.
 *
 * @param {string} store
 * @param {Record<string, any>} [options]
 */
function purgeStoreHelperCredentials(store, options = {}) {
  const normStore = normalizeStoreKey(store);
  if (!normStore) return { success: false, error: 'Missing store identifier' };

  const userDataDir = resolveEffectiveUserDataDir(options);
  const filePath = getDisconnectedStoresFilePath(options);
  const current = readDisconnectedStoresObject(options);
  const nextPayload = {
    stores: {
      ...(current?.stores || {}),
      [normStore]: {
        disconnected: true,
        disconnectedAt: new Date().toISOString(),
      },
    },
    updatedAt: new Date().toISOString(),
  };

  try {
    atomicWriteSecureFileSync(filePath, JSON.stringify(nextPayload, null, 2), options);
    tombstoneCacheByFile.delete(filePath);
  } catch (err) {
    diagLog.warn('security.writeTombstone', err, { store: normStore, filePath });
  }

  /** @type {string[]} */
  const unlinkedPaths = [];
  /** @type {string[]} */
  const candidateFiles = [];
  if (normStore === 'epic') {
    candidateFiles.push(path.join(userDataDir, 'legendaryConfig', 'legendary', 'user.json'));
    if (options.legendaryConfigDir) {
      candidateFiles.push(path.join(options.legendaryConfigDir, 'user.json'));
    }
    if (options.legendaryConfigPath) {
      candidateFiles.push(path.join(options.legendaryConfigPath, 'user.json'));
    }
  } else if (normStore === 'gog') {
    candidateFiles.push(
      path.join(userDataDir, 'gog_store', 'auth.json'),
      path.join(userDataDir, 'gogdlConfig', 'auth.json')
    );
    if (options.gogAuthPath) {
      candidateFiles.push(options.gogAuthPath);
    }
  }

  for (const credFile of candidateFiles) {
    if (!credFile) continue;
    try {
      if (fs.existsSync(credFile)) {
        fs.unlinkSync(credFile);
        unlinkedPaths.push(credFile);
      }
    } catch (err) {
      diagLog.warn('security.purgeHelperCredFile', err, { store: normStore, credFile });
    }
  }

  return {
    success: true,
    store: normStore,
    tombstoned: true,
    unlinkedPaths,
  };
}

// ============================================================================
// Official Epic Games Launcher Import Registry (`one_launcher_epic_imports.json`)
// ============================================================================

/**
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function getEpicImportsFilePath(options = {}) {
  const userDataDir = resolveEffectiveUserDataDir(options);
  return path.join(userDataDir, 'one_launcher_epic_imports.json');
}

/**
 * @param {Record<string, any>} [options]
 * @returns {{ imports: Record<string, any> }}
 */
function getImportedEpicInstalls(options = {}) {
  const filePath = getEpicImportsFilePath(options);
  try {
    if (!fs.existsSync(filePath)) return { imports: {} };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.imports && typeof parsed.imports === 'object') {
      return parsed;
    }
  } catch (err) {
    diagLog.warn('security.readEpicImports', err, { filePath });
  }
  return { imports: {} };
}

/**
 * @param {unknown} rawPath
 * @returns {string}
 */
function normalizeEpicInstallPathForComparison(rawPath) {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return '';
  let normalized = trimmed.replace(/[\\/]+/g, '/');
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, '');
  }
  if (process.platform === 'win32' || /^[a-z]:\//i.test(normalized)) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/**
 * @param {any} appNameOrEntry
 * @param {any} [installPathOrOptions]
 * @param {Record<string, any>} [maybeOptions]
 * @returns {boolean}
 */
function recordImportedEpicInstall(appNameOrEntry, installPathOrOptions, maybeOptions = {}) {
  let rawApp = '';
  let rawPath = '';
  let rawSource = '';
  let rawExecutable = '';
  let rawVersion = '';
  /** @type {Record<string, any>} */
  let options = maybeOptions || {};

  if (appNameOrEntry && typeof appNameOrEntry === 'object') {
    rawApp = appNameOrEntry.appName || appNameOrEntry.app_name || '';
    rawPath = appNameOrEntry.installPath || appNameOrEntry.install_path || '';
    rawSource = appNameOrEntry.source || '';
    rawExecutable = appNameOrEntry.executable || appNameOrEntry.executablePath || '';
    rawVersion = appNameOrEntry.version || '';
    options =
      installPathOrOptions && typeof installPathOrOptions === 'object' ? installPathOrOptions : {};
  } else {
    rawApp = appNameOrEntry;
    rawPath = installPathOrOptions;
  }

  const cleanApp = String(rawApp || '').trim();
  const cleanPath = String(rawPath || '').trim();
  const cleanExecutable = String(rawExecutable || '').trim();
  const cleanVersion = String(rawVersion || '').trim();
  if (!cleanApp && !cleanPath) return false;
  const recordKey = cleanApp || cleanPath;
  const filePath = getEpicImportsFilePath(options);
  try {
    const existing = getImportedEpicInstalls(options);
    const prev = existing.imports ? existing.imports[recordKey] : null;
    if (
      prev &&
      prev.appName === cleanApp &&
      normalizeEpicInstallPathForComparison(prev.installPath) ===
        normalizeEpicInstallPathForComparison(cleanPath) &&
      (!cleanExecutable ||
        normalizeEpicInstallPathForComparison(prev.executable) ===
          normalizeEpicInstallPathForComparison(cleanExecutable)) &&
      (!cleanVersion || String(prev.version || '').trim() === cleanVersion)
    ) {
      return true;
    }
    const next = {
      imports: {
        ...(existing.imports || {}),
        [recordKey]: {
          appName: cleanApp,
          installPath: cleanPath,
          ...(cleanExecutable
            ? { executable: cleanExecutable }
            : prev?.executable
              ? { executable: prev.executable }
              : {}),
          ...(cleanVersion
            ? { version: cleanVersion }
            : prev?.version
              ? { version: prev.version }
              : {}),
          ...(rawSource
            ? { source: String(rawSource) }
            : prev?.source
              ? { source: prev.source }
              : {}),
          importedAt: prev?.importedAt || new Date().toISOString(),
        },
      },
      updatedAt: new Date().toISOString(),
    };
    atomicWriteFileSync(filePath, JSON.stringify(next, null, 2));
    return true;
  } catch (err) {
    diagLog.warn('security.recordEpicImport', err, { appName: cleanApp, installPath: cleanPath });
    return false;
  }
}

module.exports = {
  DANGEROUS_LAUNCH_ENV_KEYS,
  LAUNCH_ENV_MAP_FIELDS,
  LAUNCH_SHELL_OR_EXEC_FIELDS,
  FORBIDDEN_RENDERER_IPC_KEYS,
  ALLOWED_LAUNCHER_SETTINGS_KEYS,
  sanitizeLaunchEnvironmentMap,
  sanitizeSpawnEnvironmentMap,
  computeLaunchEnvApprovalFingerprint,
  buildSafeChildEnvironment,
  sanitizeLaunchConfigRecursive,
  sanitizeLauncherSettingsPayload,
  computeLaunchCommandFingerprint,
  collectLaunchCommandsRecursive,
  getApprovedLaunchCommandsFilePath,
  isLaunchCommandApproved,
  approveLaunchCommands,
  revokeApprovedLaunchCommands,
  confirmAndApproveLaunchCommands,
  getDisconnectedStoresFilePath,
  isStoreDisconnectedTombstoned,
  clearStoreDisconnectedTombstone,
  purgeStoreHelperCredentials,
  getImportedEpicInstalls,
  recordImportedEpicInstall,
};
