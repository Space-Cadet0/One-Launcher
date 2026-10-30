// @ts-check
'use strict';

const os = require('node:os');
const path = require('node:path');
const { diagLog } = require('../utils/diagnosticLogger.cjs');
const {
  FORBIDDEN_RENDERER_IPC_KEYS,
  LAUNCH_SHELL_OR_EXEC_FIELDS,
  ALLOWED_LAUNCHER_SETTINGS_KEYS,
  isContainedWithinRoot,
  sanitizeLaunchConfigRecursive,
  sanitizeLauncherSettingsPayload,
  collectLaunchCommandsRecursive,
  computeLaunchCommandFingerprint,
  isLaunchCommandApproved,
  confirmAndApproveLaunchCommands,
  revokeApprovedLaunchCommands,
} = require('../launcher/securityAndPathUtils.cjs');

const ALLOWED_STOREFRONT_IDS = new Set([
  'steam',
  'gog',
  'epic',
  'amazon',
  'xbox',
  'ubisoft',
  'ea',
  'bnet',
  'itch',
  'rockstar',
  'humble',
  'custom',
]);

const ALLOWED_ENVIRONMENT_COMPONENT_IDS = new Set([
  'rosetta2',
  'win_vcredist',
  'win_webview2',
  'runner_crossover',
  'runner_crossover_preview',
  'runner_wine',
  'runner_gptk',
  'bottle_default',
  'host_steam',
  'bottle_steam',
  'host_gog',
  'bottle_gog',
  'host_epic',
  'bottle_epic',
  'xbox_runtime',
]);

const ALLOWED_ENVIRONMENT_TASK_ACTIONS = new Set([
  'install_rosetta2',
  'install_win_vcredist',
  'install_runner',
  'ensure_bottle',
  'install_client',
  'sync_first_party_manifests',
]);

const ALLOWED_NON_NATIVE_RUNNERS = new Set([
  'crossover',
  'crossover_preview',
  'gptk',
  'wine',
]);

const ALLOWED_PREFERRED_RUNNER_TYPES = new Set([
  'crossover',
  'crossover_preview',
  'gptk',
  'wine',
  'skip',
]);

const ALLOWED_BOTTLE_MODES = new Set([
  'reuse_existing',
  'create_dedicated',
]);

const ALLOWED_CLIENT_LOGIN_TARGET_IDS = new Set([
  'host_steam',
  'bottle_steam',
  'host_gog',
  'bottle_gog',
  'host_epic',
  'bottle_epic',
]);

const ALLOWED_SETUP_WIZARD_STATE_PATCH_KEYS = [
  'completedAt',
  'dismissedAt',
  'lastHealthCheckAt',
  'preferredRunnerType',
  'preferredBottleName',
  'configuredComponents',
  'addConfiguredComponents',
];

const SAFE_BOTTLE_NAME_SLUG_RE = /^[A-Za-z0-9 _.-]{1,64}$/;

/**
 * Validate and normalize a safe CrossOver/Wine bottle name slug (`[A-Za-z0-9 _.-]{1,64}`),
 * rejecting null bytes, path separators, and `.` / `..` segments.
 *
 * @param {unknown} rawName
 * @returns {string | null}
 */
function sanitizeSafeBottleNameSlug(rawName) {
  if (typeof rawName !== 'string') return null;
  const trimmed = rawName.trim();
  if (!trimmed || trimmed.length > 64) return null;
  if (trimmed.includes('\0') || trimmed.includes('/') || trimmed.includes('\\')) return null;
  if (!SAFE_BOTTLE_NAME_SLUG_RE.test(trimmed)) return null;
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('..')) return null;
  return trimmed;
}

/**
 * Filter an untrusted list down to deduplicated valid `StorefrontId` values.
 *
 * @param {unknown} rawList
 * @returns {string[]}
 */
function sanitizeStorefrontIdList(rawList) {
  if (!Array.isArray(rawList)) return [];
  /** @type {Set<string>} */
  const out = new Set();
  for (const item of rawList) {
    if (typeof item === 'string') {
      const normalized = item.trim();
      if (ALLOWED_STOREFRONT_IDS.has(normalized)) {
        out.add(normalized);
        if (out.size >= 24) break;
      }
    }
  }
  return Array.from(out);
}

/**
 * Filter an untrusted list down to deduplicated valid `EnvironmentComponentId` values.
 *
 * @param {unknown} rawList
 * @returns {string[]}
 */
function sanitizeComponentIdList(rawList) {
  if (!Array.isArray(rawList)) return [];
  /** @type {Set<string>} */
  const out = new Set();
  for (const item of rawList) {
    if (typeof item === 'string') {
      const normalized = item.trim();
      if (ALLOWED_ENVIRONMENT_COMPONENT_IDS.has(normalized)) {
        out.add(normalized);
      }
    }
  }
  return Array.from(out);
}

/**
 * Validate an optional `.dmg` path from the renderer: expands leading `~/` via `os.homedir()`,
 * requires an absolute path ending in `.dmg` with zero null bytes, zero `..` traversal segments,
 * and neither path nor basename starting with `-`.
 *
 * @param {unknown} rawDmgPath
 * @returns {{ ok: boolean, value?: string, error?: string }}
 */
function validateOptionalDmgPath(rawDmgPath) {
  if (rawDmgPath === undefined || rawDmgPath === null || rawDmgPath === '') {
    return { ok: true };
  }
  if (typeof rawDmgPath !== 'string') {
    return { ok: false, error: 'Invalid dmgPath: expected a string ending in .dmg.' };
  }
  if (rawDmgPath.includes('\0')) {
    return { ok: false, error: 'Invalid dmgPath: null bytes are forbidden.' };
  }
  const trimmed = rawDmgPath.trim();
  if (!trimmed || trimmed.length > 1024) {
    return { ok: false, error: 'Invalid dmgPath length.' };
  }
  if (trimmed.startsWith('-')) {
    return { ok: false, error: 'Invalid dmgPath: leading hyphen is forbidden.' };
  }
  const rawSegments = trimmed.split(/[\\/]+/);
  if (rawSegments.includes('..')) {
    return { ok: false, error: 'Invalid dmgPath: directory traversal segments are forbidden.' };
  }

  let resolved = trimmed;
  if (resolved.startsWith('~/') || resolved.startsWith('~\\')) {
    const homeDir = os.homedir();
    if (!homeDir) {
      return { ok: false, error: 'Invalid dmgPath: unable to resolve user home directory.' };
    }
    resolved = path.join(homeDir, resolved.slice(2));
  }

  if (
    !path.isAbsolute(resolved) ||
    resolved.startsWith('-') ||
    path.basename(resolved).startsWith('-')
  ) {
    return {
      ok: false,
      error: 'Invalid dmgPath: must be an absolute path whose basename does not start with "-".',
    };
  }
  if (resolved.split(/[\\/]+/).includes('..')) {
    return { ok: false, error: 'Invalid dmgPath: directory traversal segments are forbidden.' };
  }
  if (!/\.dmg$/i.test(resolved)) {
    return { ok: false, error: 'Invalid dmgPath: path must end in .dmg.' };
  }
  return { ok: true, value: resolved };
}

/**
 * Validate and sanitize a `RunEnvironmentSetupRequest` payload from the renderer.
 *
 * @param {unknown} rawPayload
 * @returns {{ ok: boolean, payload?: Record<string, any>, runId: string, error?: string }}
 */
function sanitizeEnvironmentSetupTasksPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return { ok: false, runId: '', error: 'Invalid environment setup payload.' };
  }
  const rawRootObj = /** @type {Record<string, unknown>} */ (rawPayload);
  if (typeof rawRootObj.runId === 'string' && rawRootObj.runId.includes('\0')) {
    return { ok: false, runId: '', error: 'Invalid runId: null bytes are forbidden.' };
  }
  if (Array.isArray(rawRootObj.tasks)) {
    for (const rawEntry of rawRootObj.tasks) {
      if (rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry)) {
        const entryRec = /** @type {Record<string, unknown>} */ (rawEntry);
        if (typeof entryRec.dmgPath === 'string' && entryRec.dmgPath.includes('\0')) {
          return { ok: false, runId: '', error: 'Invalid dmgPath: null bytes are forbidden.' };
        }
        if (typeof entryRec.bottleName === 'string' && entryRec.bottleName.includes('\0')) {
          return { ok: false, runId: '', error: 'Invalid bottleName: null bytes are forbidden.' };
        }
      }
    }
  }
  const cleanRoot = sanitizeRendererIpcOptions(rawPayload);
  let cleanRunId = '';
  if (cleanRoot.runId !== undefined && cleanRoot.runId !== null && cleanRoot.runId !== '') {
    if (typeof cleanRoot.runId !== 'string') {
      return { ok: false, runId: '', error: 'Invalid runId in setup request.' };
    }
    const trimmedRunId = cleanRoot.runId.trim();
    if (!trimmedRunId || trimmedRunId.length > 128 || trimmedRunId.includes('\0')) {
      return { ok: false, runId: '', error: 'Invalid runId length or characters.' };
    }
    cleanRunId = trimmedRunId;
  }

  if (!Array.isArray(cleanRoot.tasks) || cleanRoot.tasks.length > 32) {
    return {
      ok: false,
      runId: cleanRunId,
      error: 'Invalid environment setup tasks array.',
    };
  }

  /** @type {Array<Record<string, any>>} */
  const sanitizedTasks = [];

  for (const rawTask of cleanRoot.tasks) {
    if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) {
      return { ok: false, runId: cleanRunId, error: 'Invalid task entry in tasks array.' };
    }
    const cleanTaskInput = sanitizeRendererIpcOptions(rawTask);
    const action = typeof cleanTaskInput.action === 'string' ? cleanTaskInput.action.trim() : '';
    const componentId =
      typeof cleanTaskInput.componentId === 'string' ? cleanTaskInput.componentId.trim() : '';

    if (
      !ALLOWED_ENVIRONMENT_TASK_ACTIONS.has(action) ||
      !ALLOWED_ENVIRONMENT_COMPONENT_IDS.has(componentId)
    ) {
      return {
        ok: false,
        runId: cleanRunId,
        error: 'Invalid environment setup task action or componentId.',
      };
    }

    /** @type {Record<string, any>} */
    const taskOut = {
      action,
      componentId,
    };

    if (
      cleanTaskInput.runnerType !== undefined &&
      cleanTaskInput.runnerType !== null &&
      cleanTaskInput.runnerType !== ''
    ) {
      if (
        typeof cleanTaskInput.runnerType !== 'string' ||
        !ALLOWED_NON_NATIVE_RUNNERS.has(cleanTaskInput.runnerType.trim())
      ) {
        return { ok: false, runId: cleanRunId, error: 'Invalid runnerType in setup task.' };
      }
      taskOut.runnerType = cleanTaskInput.runnerType.trim();
    }

    if (
      cleanTaskInput.bottleMode !== undefined &&
      cleanTaskInput.bottleMode !== null &&
      cleanTaskInput.bottleMode !== ''
    ) {
      if (
        typeof cleanTaskInput.bottleMode !== 'string' ||
        !ALLOWED_BOTTLE_MODES.has(cleanTaskInput.bottleMode.trim())
      ) {
        return { ok: false, runId: cleanRunId, error: 'Invalid bottleMode in setup task.' };
      }
      taskOut.bottleMode = cleanTaskInput.bottleMode.trim();
    }

    if (
      cleanTaskInput.bottleName !== undefined &&
      cleanTaskInput.bottleName !== null &&
      cleanTaskInput.bottleName !== ''
    ) {
      const safeBottleName = sanitizeSafeBottleNameSlug(cleanTaskInput.bottleName);
      if (!safeBottleName) {
        return { ok: false, runId: cleanRunId, error: 'Invalid bottleName slug in setup task.' };
      }
      taskOut.bottleName = safeBottleName;
    }

    const dmgCheck = validateOptionalDmgPath(cleanTaskInput.dmgPath);
    if (!dmgCheck.ok) {
      return { ok: false, runId: cleanRunId, error: dmgCheck.error };
    }
    if (dmgCheck.value) {
      taskOut.dmgPath = dmgCheck.value;
    }

    sanitizedTasks.push(taskOut);
  }

  /** @type {Record<string, any>} */
  const payloadOut = {
    tasks: sanitizedTasks,
  };
  if (cleanRunId) {
    payloadOut.runId = cleanRunId;
  }
  if (Array.isArray(cleanRoot.connectedStorefronts)) {
    payloadOut.connectedStorefronts = sanitizeStorefrontIdList(cleanRoot.connectedStorefronts);
  }

  return { ok: true, payload: payloadOut, runId: cleanRunId };
}

/**
 * Validate and sanitize a `StartGuidedClientLoginRequest` payload from the renderer.
 *
 * @param {unknown} rawPayload
 * @returns {{ ok: boolean, payload?: Record<string, any>, targetId: string, error?: string }}
 */
function sanitizeGuidedClientLoginPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return {
      ok: false,
      targetId: 'host_steam',
      error: 'Invalid guided client login payload.',
    };
  }
  const rawRootObj = /** @type {Record<string, unknown>} */ (rawPayload);
  if (typeof rawRootObj.bottleName === 'string' && rawRootObj.bottleName.includes('\0')) {
    return {
      ok: false,
      targetId: 'host_steam',
      error: 'Invalid bottleName: null bytes are forbidden.',
    };
  }
  const cleanRoot = sanitizeRendererIpcOptions(rawPayload);
  const rawTargetId = typeof cleanRoot.targetId === 'string' ? cleanRoot.targetId.trim() : '';
  if (!ALLOWED_CLIENT_LOGIN_TARGET_IDS.has(rawTargetId)) {
    return {
      ok: false,
      targetId: 'host_steam',
      error: 'Invalid guided client login targetId.',
    };
  }

  /** @type {Record<string, any>} */
  const payloadOut = {
    targetId: rawTargetId,
  };

  if (
    cleanRoot.runnerType !== undefined &&
    cleanRoot.runnerType !== null &&
    cleanRoot.runnerType !== ''
  ) {
    if (
      typeof cleanRoot.runnerType !== 'string' ||
      !ALLOWED_NON_NATIVE_RUNNERS.has(cleanRoot.runnerType.trim())
    ) {
      return { ok: false, targetId: rawTargetId, error: 'Invalid runnerType for guided login.' };
    }
    payloadOut.runnerType = cleanRoot.runnerType.trim();
  }

  if (
    cleanRoot.bottleName !== undefined &&
    cleanRoot.bottleName !== null &&
    cleanRoot.bottleName !== ''
  ) {
    const safeBottleName = sanitizeSafeBottleNameSlug(cleanRoot.bottleName);
    if (!safeBottleName) {
      return { ok: false, targetId: rawTargetId, error: 'Invalid bottleName slug for guided login.' };
    }
    payloadOut.bottleName = safeBottleName;
  }

  if (typeof cleanRoot.autoCloseOnSuccess === 'boolean') {
    payloadOut.autoCloseOnSuccess = cleanRoot.autoCloseOnSuccess;
  }

  if (typeof cleanRoot.forceInteractiveLogin === 'boolean') {
    payloadOut.forceInteractiveLogin = cleanRoot.forceInteractiveLogin;
  }

  if (typeof cleanRoot.timeoutMs === 'number' && Number.isFinite(cleanRoot.timeoutMs)) {
    payloadOut.timeoutMs = Math.min(900000, Math.max(5000, Math.floor(cleanRoot.timeoutMs)));
  }

  return { ok: true, payload: payloadOut, targetId: rawTargetId };
}

/**
 * Strictly allowlist safe keys on `SetupWizardPersistedState` patches from the renderer.
 *
 * @param {unknown} rawPatch
 * @returns {Record<string, any>}
 */
function sanitizeSetupWizardStatePatch(rawPatch) {
  const cleanRoot = sanitizeRendererIpcOptions(rawPatch);
  /** @type {Record<string, any>} */
  const out = {};

  for (const tsKey of ['completedAt', 'dismissedAt', 'lastHealthCheckAt']) {
    if (Object.prototype.hasOwnProperty.call(cleanRoot, tsKey)) {
      const val = cleanRoot[tsKey];
      if (val === null) {
        out[tsKey] = null;
      } else if (typeof val === 'string' && !val.includes('\0')) {
        const trimmed = val.trim();
        if (trimmed && trimmed.length <= 64) {
          out[tsKey] = trimmed;
        }
      }
    }
  }

  if (
    typeof cleanRoot.preferredRunnerType === 'string' &&
    ALLOWED_PREFERRED_RUNNER_TYPES.has(cleanRoot.preferredRunnerType.trim())
  ) {
    out.preferredRunnerType = cleanRoot.preferredRunnerType.trim();
  }

  if (cleanRoot.preferredBottleName !== undefined && cleanRoot.preferredBottleName !== null) {
    const safeBottle = sanitizeSafeBottleNameSlug(cleanRoot.preferredBottleName);
    if (safeBottle) {
      out.preferredBottleName = safeBottle;
    }
  }

  if (Array.isArray(cleanRoot.configuredComponents)) {
    out.configuredComponents = sanitizeComponentIdList(cleanRoot.configuredComponents);
  }

  if (Array.isArray(cleanRoot.addConfiguredComponents)) {
    out.addConfiguredComponents = sanitizeComponentIdList(cleanRoot.addConfiguredComponents);
  }

  return out;
}

/**
 * Recursively strip internal dependency-injection keys, prototype-pollution keys, and
 * dangerous dynamic-linker/runtime env keys (`LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`,
 * `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`, etc.) from untrusted renderer IPC payloads.
 *
 * @param {unknown} rawOptions
 * @returns {Record<string, any>}
 */
function sanitizeRendererIpcOptions(rawOptions) {
  if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    return {};
  }
  const sanitized = sanitizeLaunchConfigRecursive(rawOptions);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized : {};
}

/**
 * Collect all non-empty shell/executable strings (`preLaunchCommand`, `postExitCommand`,
 * `wrapperCommand`, `customExecutable`, `executablePath`) across ALL nesting depths
 * (`top-level`, `launchConfig`, `platformConfigs.*`, `storefrontConfigs.*`).
 *
 * @param {Record<string, any> | null | undefined} cfg
 * @returns {Set<string>}
 */
function collectShellCommandsFromConfig(cfg) {
  /** @type {Set<string>} */
  const commands = new Set();
  const entries = collectLaunchCommandsRecursive(cfg);
  for (const entry of entries) {
    commands.add(`${entry.field}:${entry.value}`);
  }
  return commands;
}

/**
 * Recursively strip unapproved shell/executable fields (`preLaunchCommand`, `postExitCommand`,
 * `wrapperCommand`, `customExecutable`, `executablePath`) from a renderer launch payload at
 * ALL nesting depths (`top-level`, `launchConfig`, `platformConfigs.*`, `storefrontConfigs.*`)
 * unless confirmed in `approved_launch_commands.json` (or matching an already-approved config).
 *
 * @param {Record<string, any>} rawPayload
 * @param {any} launcherEngine
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
function stripUnconfirmedInlineShellCommands(rawPayload, launcherEngine, options = {}) {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return rawPayload;
  }
  const cleanPayload = sanitizeRendererIpcOptions(rawPayload);
  const gameId = typeof cleanPayload.gameId === 'string' ? cleanPayload.gameId.trim() : '';

  const storedConfigCommands = collectShellCommandsFromConfig(
    typeof launcherEngine?.getGameLaunchConfigs === 'function' && gameId
      ? launcherEngine.getGameLaunchConfigs()?.[gameId]
      : null
  );

  /**
   * @param {any} node
   * @param {number} depth
   * @returns {any}
   */
  const stripNode = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 10) {
      return node;
    }
    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, val] of Object.entries(node)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (LAUNCH_SHELL_OR_EXEC_FIELDS.includes(key)) {
        if (typeof val === 'string' && val.trim()) {
          const trimmed = val.trim();
          if (
            depth === 0 &&
            key === 'executablePath' &&
            typeof cleanPayload.installPath === 'string' &&
            cleanPayload.installPath.trim() &&
            isContainedWithinRoot(cleanPayload.installPath, trimmed)
          ) {
            out[key] = trimmed;
            continue;
          }
          const fp = computeLaunchCommandFingerprint(key, trimmed);
          const approvedInVault = gameId ? isLaunchCommandApproved(gameId, fp, options) : false;
          const approvedInSavedCfg = storedConfigCommands.has(`${key}:${trimmed}`);
          if (approvedInVault || approvedInSavedCfg) {
            out[key] = trimmed;
          }
        }
        continue;
      }
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        out[key] = stripNode(val, depth + 1);
      } else {
        out[key] = val;
      }
    }
    return out;
  };

  return stripNode(cleanPayload, 0);
}

/**
 * Universal Game Launcher, Compatibility Layer & Download Manager IPC Handlers
 * Extracted from electron/main.cjs for clean modular boundary separation.
 *
 * @param {{ ipcMain: any, launcherEngine: any, dialog?: any, getMainWindow?: () => any, options?: Record<string, any> }} deps
 */
function registerLauncherIpcHandlers({ ipcMain, launcherEngine, dialog, getMainWindow, options: handlerOptions = {} }) {
  if (!ipcMain || !launcherEngine) return;

  ipcMain.handle('scan:steam-installed', async (/** @type {any} */ _event, /** @type {unknown} */ options) => {
    return launcherEngine.scanAllInstalledGames(sanitizeRendererIpcOptions(options));
  });

  ipcMain.handle('launcher:scan-installed', async (/** @type {any} */ _event, /** @type {unknown} */ options) => {
    return launcherEngine.scanAllInstalledGames(sanitizeRendererIpcOptions(options));
  });

  ipcMain.handle('launcher:detect-storefront-clients', async (/** @type {any} */ _event, /** @type {unknown} */ options) => {
    return launcherEngine.detectInstalledStorefrontClients(sanitizeRendererIpcOptions(options));
  });

  ipcMain.handle('launcher:detect-compat-layers', async (/** @type {any} */ _event, /** @type {unknown} */ options) => {
    return launcherEngine.detectCompatibilityLayers(sanitizeRendererIpcOptions(options));
  });

  ipcMain.handle('launcher:install-compat-layer', async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
    return await launcherEngine.installCompatibilityLayer(sanitizeRendererIpcOptions(payload));
  });

  ipcMain.handle('launcher:check-compat-updates', async (/** @type {any} */ _event, /** @type {unknown} */ options) => {
    return await launcherEngine.checkCompatibilityLayerUpdates(sanitizeRendererIpcOptions(options));
  });

  ipcMain.handle('launcher:update-compat-layer', async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
    return await launcherEngine.updateCompatibilityLayer(sanitizeRendererIpcOptions(payload));
  });

  ipcMain.handle('launcher:get-disk-space', async (/** @type {any} */ _event, /** @type {unknown} */ targetPath) => {
    return launcherEngine.getDiskSpace(typeof targetPath === 'string' ? targetPath : '');
  });

  ipcMain.handle('launcher:get-install-info', async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
    return await launcherEngine.getGameInstallInfo(sanitizeRendererIpcOptions(payload));
  });

  ipcMain.handle('launcher:launch-game', async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
    const sanitizedPayload = stripUnconfirmedInlineShellCommands(
      /** @type {Record<string, any>} */ (payload),
      launcherEngine,
      handlerOptions
    );
    return await launcherEngine.launchGame(sanitizedPayload);
  });

  ipcMain.handle('launcher:stop-game', async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
    const arg =
      typeof payload === 'string' ? payload : sanitizeRendererIpcOptions(payload);
    return await launcherEngine.stopGame(arg);
  });

  ipcMain.handle('launcher:get-running-games', async () => {
    return launcherEngine.getRunningGames();
  });

  ipcMain.handle('launcher:install-game', async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
    return await launcherEngine.installGame(sanitizeRendererIpcOptions(payload));
  });

  ipcMain.handle('launcher:pause-download', async (/** @type {any} */ _event, /** @type {unknown} */ taskId) => {
    return launcherEngine.pauseDownload(typeof taskId === 'string' ? taskId : String(taskId || ''));
  });

  ipcMain.handle('launcher:resume-download', async (/** @type {any} */ _event, /** @type {unknown} */ taskId) => {
    return launcherEngine.resumeDownload(typeof taskId === 'string' ? taskId : String(taskId || ''));
  });

  ipcMain.handle('launcher:cancel-download', async (/** @type {any} */ _event, /** @type {unknown} */ taskId) => {
    return launcherEngine.cancelDownload(typeof taskId === 'string' ? taskId : String(taskId || ''));
  });

  ipcMain.handle('launcher:get-download-queue', async () => {
    return launcherEngine.getDownloadQueue();
  });

  ipcMain.handle('launcher:uninstall-game', async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
    return await launcherEngine.uninstallGame(sanitizeRendererIpcOptions(payload));
  });

  ipcMain.handle('launcher:verify-game', async (/** @type {any} */ _event, /** @type {unknown} */ payload) => {
    return await launcherEngine.verifyGameFiles(sanitizeRendererIpcOptions(payload));
  });

  ipcMain.handle('launcher:browse-files', async (/** @type {any} */ _event, /** @type {unknown} */ targetPath) => {
    return await launcherEngine.browseLocalFiles(typeof targetPath === 'string' ? targetPath : '');
  });

  ipcMain.handle('launcher:select-executable', async (/** @type {any} */ _event, /** @type {unknown} */ defaultPath) => {
    return await launcherEngine.selectExecutableDialog(
      typeof defaultPath === 'string' ? defaultPath : undefined
    );
  });

  ipcMain.handle('launcher:select-folder', async (/** @type {any} */ _event, /** @type {unknown} */ defaultPath) => {
    return await launcherEngine.selectFolderDialog(
      typeof defaultPath === 'string' ? defaultPath : undefined
    );
  });

  ipcMain.handle('launcher:save-launch-config', async (/** @type {any} */ _event, /** @type {unknown} */ config) => {
    const cleanConfig = sanitizeRendererIpcOptions(config);
    if (cleanConfig.reset && cleanConfig.gameId) {
      revokeApprovedLaunchCommands(cleanConfig.gameId, handlerOptions);
      return launcherEngine.saveGameLaunchConfig(cleanConfig);
    }

    const incomingEntries = collectLaunchCommandsRecursive(cleanConfig);
    if (incomingEntries.length > 0) {
      const parentWin = typeof getMainWindow === 'function' ? getMainWindow() : null;
      const approval = await confirmAndApproveLaunchCommands({
        gameId: cleanConfig.gameId,
        configOrPayload: cleanConfig,
        dialog,
        parentWindow: parentWin,
        options: handlerOptions,
      });
      if (!approval.approved) {
        return {
          success: false,
          error: approval.error || 'Custom shell command cancelled by user.',
        };
      }
    }

    return launcherEngine.saveGameLaunchConfig(cleanConfig);
  });

  ipcMain.handle('launcher:get-launch-configs', async () => {
    return launcherEngine.getGameLaunchConfigs();
  });

  ipcMain.handle('launcher:get-launch-config', async (/** @type {any} */ _event, /** @type {unknown} */ gameId) => {
    const allConfigs = launcherEngine.getGameLaunchConfigs() || {};
    if (typeof gameId === 'string' && gameId.trim()) {
      return allConfigs[gameId.trim()] || null;
    }
    return allConfigs;
  });

  ipcMain.handle('launcher:delete-launch-config', async (/** @type {any} */ _event, /** @type {unknown} */ rawArg) => {
    const gameId =
      typeof rawArg === 'string'
        ? rawArg.trim()
        : rawArg && typeof rawArg === 'object' && typeof (/** @type {any} */ (rawArg).gameId) === 'string'
          ? /** @type {any} */ (rawArg).gameId.trim()
          : '';
    if (!gameId) {
      return { success: false, error: 'Missing gameId for launch config deletion.' };
    }
    revokeApprovedLaunchCommands(gameId, handlerOptions);
    return launcherEngine.saveGameLaunchConfig({ gameId, reset: true });
  });

  ipcMain.handle('launcher:get-performance-settings', async () => {
    return launcherEngine.getLauncherPerformanceSettings({});
  });

  const handleSaveStrictSettings = async (/** @type {any} */ _event, /** @type {unknown} */ settings) => {
    const cleanSettings = sanitizeLauncherSettingsPayload(settings);
    return launcherEngine.saveLauncherPerformanceSettings(cleanSettings, {});
  };

  ipcMain.handle('launcher:save-performance-settings', handleSaveStrictSettings);
  ipcMain.handle('launcher:save-settings', handleSaveStrictSettings);

  ipcMain.handle('launcher:drain-pending-sessions', async () => {
    return launcherEngine.drainPendingCompletedSessions({});
  });

  /**
   * Build a contract-complete `EnvironmentHealthSnapshot` fallback when a partial test mock
   * omits `probeEnvironmentHealth`.
   *
   * @param {string[] | undefined} connectedStorefronts
   * @returns {Record<string, any>}
   */
  const buildContractSafeIpcSnapshotFallback = (connectedStorefronts) => {
    const hostPlatform =
      process.platform === 'win32'
        ? 'win32'
        : process.platform === 'linux'
          ? 'linux'
          : 'darwin';
    const isMac = hostPlatform === 'darwin';
    const isWin = hostPlatform === 'win32';
    const isAppleSiliconMac = isMac && process.arch === 'arm64';
    const storefronts = Array.isArray(connectedStorefronts) ? connectedStorefronts : [];

    /**
     * @param {string} id
     * @param {string} category
     * @param {string} status
     * @param {string} tier
     * @returns {Record<string, any>}
     */
    const mkComp = (id, category, status, tier) => ({
      id,
      category,
      title: id,
      shortLabel: id,
      status,
      canAutoInstall: status === 'missing',
      recommendationTier: tier,
      recommendationBadge: tier,
      defaultSelected: false,
      whyExplanation: '',
      statusDetail: 'Unavailable in partial engine mock.',
    });

    /**
     * @param {string} targetId
     * @param {'steam' | 'gog' | 'epic'} storefrontId
     * @param {'host' | 'bottle'} scope
     * @returns {Record<string, any>}
     */
    const mkLogin = (targetId, storefrontId, scope) => ({
      targetId,
      storefrontId,
      scope,
      label: targetId,
      installed: false,
      authenticated: false,
      accountMatchesOneLauncher: null,
      statusSummary: 'Unavailable in partial engine mock.',
    });

    return {
      probedAt: new Date().toISOString(),
      probeDurationMs: 0,
      hostPlatform,
      hostArch: process.arch,
      isAppleSiliconMac,
      hasWriteAccessToSystemApplications: false,
      preferredMacApplicationsDir: isMac ? '/Applications' : '',
      connectedStorefronts: storefronts,
      bundledHelpers: {
        gogdlReady: false,
        legendaryReady: false,
        xboxGdkBridgesReady: false,
        metalPreloadReady: false,
      },
      detectedRunners: [],
      bottleSummary: {
        runnerType: null,
        runnerInstalled: false,
        availableBottles: [],
        recommendedBottleMode: 'create_dedicated',
        recommendedBottleName: 'OneLauncher',
      },
      components: {
        rosetta2: mkComp(
          'rosetta2',
          'os_prerequisite',
          isAppleSiliconMac ? 'missing' : 'not_applicable',
          isAppleSiliconMac ? 'required' : 'not_needed'
        ),
        win_vcredist: mkComp(
          'win_vcredist',
          'os_prerequisite',
          isWin ? 'missing' : 'not_applicable',
          isWin ? 'required' : 'not_needed'
        ),
        win_webview2: mkComp(
          'win_webview2',
          'os_prerequisite',
          isWin ? 'ready' : 'not_applicable',
          isWin ? 'built_in' : 'not_needed'
        ),
        runner_crossover: mkComp(
          'runner_crossover',
          'compatibility_runner',
          isMac ? 'missing' : 'not_applicable',
          isMac ? 'recommended' : 'not_needed'
        ),
        runner_crossover_preview: mkComp(
          'runner_crossover_preview',
          'compatibility_runner',
          isMac ? 'missing' : 'not_applicable',
          isMac ? 'optional' : 'not_needed'
        ),
        runner_wine: mkComp(
          'runner_wine',
          'compatibility_runner',
          isMac ? 'missing' : 'not_applicable',
          isMac ? 'optional' : 'not_needed'
        ),
        runner_gptk: mkComp(
          'runner_gptk',
          'compatibility_runner',
          isAppleSiliconMac ? 'missing' : 'not_applicable',
          isAppleSiliconMac ? 'optional' : 'not_needed'
        ),
        bottle_default: mkComp(
          'bottle_default',
          'bottle',
          isMac ? 'missing' : 'not_applicable',
          isMac ? 'recommended' : 'not_needed'
        ),
        host_steam: mkComp('host_steam', 'host_client', 'missing', 'recommended'),
        bottle_steam: mkComp(
          'bottle_steam',
          'bottle_client',
          isMac ? 'missing' : 'not_applicable',
          isMac ? 'recommended' : 'not_needed'
        ),
        host_gog: mkComp('host_gog', 'host_client', 'missing', 'optional'),
        bottle_gog: mkComp(
          'bottle_gog',
          'bottle_client',
          isMac ? 'missing' : 'not_applicable',
          isMac ? 'optional' : 'not_needed'
        ),
        host_epic: mkComp('host_epic', 'host_client', 'missing', 'not_needed'),
        bottle_epic: mkComp(
          'bottle_epic',
          'bottle_client',
          isMac ? 'missing' : 'not_applicable',
          'not_needed'
        ),
        xbox_runtime: mkComp(
          'xbox_runtime',
          'built_in_runtime',
          isWin ? 'ready' : 'not_applicable',
          isWin ? 'built_in' : 'not_needed'
        ),
      },
      clientLogins: {
        host_steam: mkLogin('host_steam', 'steam', 'host'),
        bottle_steam: mkLogin('bottle_steam', 'steam', 'bottle'),
        host_gog: mkLogin('host_gog', 'gog', 'host'),
        bottle_gog: mkLogin('bottle_gog', 'gog', 'bottle'),
        host_epic: mkLogin('host_epic', 'epic', 'host'),
        bottle_epic: mkLogin('bottle_epic', 'epic', 'bottle'),
      },
      localStoreHints: [],
      counts: {
        readyCount: isWin ? 2 : 0,
        missingRecommendedCount: 0,
        removedSinceLastSetupCount: 0,
        pendingClientLoginCount: 0,
        accountMismatchCount: 0,
        updateAvailableCount: 0,
      },
    };
  };

  /**
   * Resolve a valid `EnvironmentHealthSnapshot` on IPC error/fallback paths by probing
   * `launcherEngine.probeEnvironmentHealth` when available, otherwise using a complete
   * contract-safe fallback snapshot.
   *
   * @param {string[] | undefined} connectedStorefronts
   * @returns {Promise<Record<string, any>>}
   */
  const resolveFallbackSnapshotForIpc = async (connectedStorefronts) => {
    if (typeof launcherEngine.probeEnvironmentHealth === 'function') {
      try {
        const probed = await launcherEngine.probeEnvironmentHealth(
          Array.isArray(connectedStorefronts) ? { connectedStorefronts } : {}
        );
        if (
          probed &&
          typeof probed === 'object' &&
          probed.components &&
          typeof probed.components.rosetta2 === 'object'
        ) {
          return probed;
        }
      } catch {
        // Fall through to contract-safe snapshot
      }
    }
    return buildContractSafeIpcSnapshotFallback(connectedStorefronts);
  };

  ipcMain.handle(
    'launcher:probe-environment-health',
    async (/** @type {any} */ _event, /** @type {unknown} */ rawOptions) => {
      const sanitized = sanitizeRendererIpcOptions(rawOptions);
      /** @type {Record<string, any>} */
      const cleanOpts = {};
      if (Array.isArray(sanitized.connectedStorefronts)) {
        cleanOpts.connectedStorefronts = sanitizeStorefrontIdList(sanitized.connectedStorefronts);
      }
      if (typeof launcherEngine.probeEnvironmentHealth !== 'function') {
        return buildContractSafeIpcSnapshotFallback(cleanOpts.connectedStorefronts);
      }
      try {
        const snapshot = await launcherEngine.probeEnvironmentHealth(cleanOpts);
        if (
          snapshot &&
          typeof snapshot === 'object' &&
          snapshot.components &&
          typeof snapshot.components.rosetta2 === 'object'
        ) {
          if (
            snapshot.hostPlatform === 'darwin' &&
            snapshot.isAppleSiliconMac &&
            snapshot.components.rosetta2.status === 'missing' &&
            typeof launcherEngine.ensureRosetta2InBackground === 'function'
          ) {
            void Promise.resolve(launcherEngine.ensureRosetta2InBackground()).catch(() => {});
          }
          return snapshot;
        }
      } catch (err) {
        diagLog.warn('launcher:probe-environment-health threw, falling back safely:', {
          error: err instanceof Error ? err.message : String(err || 'Unknown probe error'),
        });
      }
      return buildContractSafeIpcSnapshotFallback(cleanOpts.connectedStorefronts);
    }
  );

  ipcMain.handle(
    'launcher:run-environment-setup-tasks',
    async (/** @type {any} */ _event, /** @type {unknown} */ rawPayload) => {
      const rawStorefronts =
        rawPayload &&
        typeof rawPayload === 'object' &&
        !Array.isArray(rawPayload) &&
        Array.isArray(/** @type {Record<string, unknown>} */ (rawPayload).connectedStorefronts)
          ? sanitizeStorefrontIdList(
              /** @type {Record<string, unknown>} */ (rawPayload).connectedStorefronts
            )
          : undefined;

      const validation = sanitizeEnvironmentSetupTasksPayload(rawPayload);
      if (!validation.ok || !validation.payload) {
        const snapshot = await resolveFallbackSnapshotForIpc(rawStorefronts);
        return {
          success: false,
          runId: validation.runId || '',
          outcomes: [],
          snapshot,
          error: validation.error || 'Invalid environment setup request payload.',
        };
      }
      const cleanStorefronts = validation.payload.connectedStorefronts;
      if (typeof launcherEngine.runEnvironmentSetupTasks !== 'function') {
        const snapshot = await resolveFallbackSnapshotForIpc(cleanStorefronts);
        return {
          success: false,
          runId: validation.runId || '',
          outcomes: [],
          snapshot,
          error: 'Environment setup tasks handler is unavailable.',
        };
      }
      try {
        const res = await launcherEngine.runEnvironmentSetupTasks(validation.payload, {});
        if (res && typeof res === 'object') {
          if (
            !res.snapshot ||
            typeof res.snapshot !== 'object' ||
            !res.snapshot.components ||
            typeof res.snapshot.components.rosetta2 !== 'object'
          ) {
            const snapshot = await resolveFallbackSnapshotForIpc(cleanStorefronts);
            return { ...res, snapshot };
          }
          return res;
        }
        const snapshot = await resolveFallbackSnapshotForIpc(cleanStorefronts);
        return {
          success: false,
          runId: validation.runId || '',
          outcomes: [],
          snapshot,
          error: 'Invalid setup task result returned by engine.',
        };
      } catch (err) {
        const snapshot = await resolveFallbackSnapshotForIpc(cleanStorefronts);
        const errMsg =
          err && typeof err === 'object' && typeof (/** @type {any} */ (err).message) === 'string'
            ? /** @type {any} */ (err).message
            : 'Environment setup tasks failed.';
        return {
          success: false,
          runId: validation.runId || '',
          outcomes: [],
          snapshot,
          error: errMsg,
        };
      }
    }
  );

  ipcMain.handle(
    'launcher:cancel-environment-setup',
    async (/** @type {any} */ _event, /** @type {unknown} */ rawRunId) => {
      if (typeof rawRunId !== 'string') {
        return { success: false, cancelled: false };
      }
      const cleanRunId = rawRunId.trim();
      if (!cleanRunId || cleanRunId.length > 128 || cleanRunId.includes('\0')) {
        return { success: false, cancelled: false };
      }
      if (typeof launcherEngine.cancelEnvironmentSetup !== 'function') {
        return { success: false, cancelled: false };
      }
      return await launcherEngine.cancelEnvironmentSetup(cleanRunId, {});
    }
  );

  ipcMain.handle(
    'launcher:start-guided-client-login',
    async (/** @type {any} */ _event, /** @type {unknown} */ rawPayload) => {
      const validation = sanitizeGuidedClientLoginPayload(rawPayload);
      if (!validation.ok || !validation.payload) {
        const fallbackStorefront = validation.targetId.includes('gog')
          ? 'gog'
          : validation.targetId.includes('epic')
            ? 'epic'
            : 'steam';
        const fallbackScope = validation.targetId.startsWith('bottle_') ? 'bottle' : 'host';
        return {
          success: false,
          targetId: validation.targetId,
          authenticated: false,
          probeState: {
            targetId: validation.targetId,
            storefrontId: fallbackStorefront,
            scope: fallbackScope,
            label: validation.targetId,
            installed: false,
            authenticated: false,
            accountMatchesOneLauncher: null,
            statusSummary: validation.error || 'Invalid guided client login request.',
          },
          message: validation.error || 'Invalid guided client login request.',
          error: validation.error || 'Invalid guided client login request.',
        };
      }
      if (typeof launcherEngine.startGuidedClientLogin !== 'function') {
        const fallbackStorefront = validation.targetId.includes('gog')
          ? 'gog'
          : validation.targetId.includes('epic')
            ? 'epic'
            : 'steam';
        const fallbackScope = validation.targetId.startsWith('bottle_') ? 'bottle' : 'host';
        return {
          success: false,
          targetId: validation.targetId,
          authenticated: false,
          probeState: {
            targetId: validation.targetId,
            storefrontId: fallbackStorefront,
            scope: fallbackScope,
            label: validation.targetId,
            installed: false,
            authenticated: false,
            accountMatchesOneLauncher: null,
            statusSummary: 'Guided client login handler is unavailable.',
          },
          message: 'Guided client login handler is unavailable.',
          error: 'Guided client login handler is unavailable.',
        };
      }
      return await launcherEngine.startGuidedClientLogin(validation.payload, {});
    }
  );

  ipcMain.handle(
    'launcher:cancel-guided-client-login',
    async (/** @type {any} */ _event, /** @type {unknown} */ rawTargetId) => {
      if (typeof rawTargetId !== 'string') {
        return { success: false, cancelled: false };
      }
      const cleanTargetId = rawTargetId.trim();
      if (!ALLOWED_CLIENT_LOGIN_TARGET_IDS.has(cleanTargetId)) {
        return { success: false, cancelled: false };
      }
      if (typeof launcherEngine.cancelGuidedClientLogin !== 'function') {
        return { success: false, cancelled: false };
      }
      return await launcherEngine.cancelGuidedClientLogin(cleanTargetId, {});
    }
  );

  ipcMain.handle('launcher:get-setup-wizard-state', async () => {
    if (typeof launcherEngine.getSetupWizardState !== 'function') {
      return {
        schemaVersion: 1,
        completedAt: null,
        dismissedAt: null,
        lastHealthCheckAt: null,
        configuredComponents: [],
      };
    }
    return await launcherEngine.getSetupWizardState({});
  });

  ipcMain.handle(
    'launcher:save-setup-wizard-state',
    async (/** @type {any} */ _event, /** @type {unknown} */ rawPatch) => {
      const cleanPatch = sanitizeSetupWizardStatePatch(rawPatch);
      if (typeof launcherEngine.saveSetupWizardState !== 'function') {
        return {
          success: true,
          state: {
            schemaVersion: 1,
            completedAt: cleanPatch.completedAt ?? null,
            dismissedAt: cleanPatch.dismissedAt ?? null,
            lastHealthCheckAt: cleanPatch.lastHealthCheckAt ?? null,
            ...(cleanPatch.preferredRunnerType
              ? { preferredRunnerType: cleanPatch.preferredRunnerType }
              : {}),
            ...(cleanPatch.preferredBottleName
              ? { preferredBottleName: cleanPatch.preferredBottleName }
              : {}),
            configuredComponents: Array.isArray(cleanPatch.configuredComponents)
              ? cleanPatch.configuredComponents
              : Array.isArray(cleanPatch.addConfiguredComponents)
                ? cleanPatch.addConfiguredComponents
                : [],
          },
        };
      }
      return await launcherEngine.saveSetupWizardState(cleanPatch, {});
    }
  );
}

module.exports = {
  registerLauncherIpcHandlers,
  sanitizeRendererIpcOptions,
  sanitizeLauncherSettingsPayload,
  sanitizeSafeBottleNameSlug,
  validateOptionalDmgPath,
  sanitizeEnvironmentSetupTasksPayload,
  sanitizeGuidedClientLoginPayload,
  sanitizeSetupWizardStatePatch,
  collectShellCommandsFromConfig,
  stripUnconfirmedInlineShellCommands,
  FORBIDDEN_RENDERER_IPC_KEYS,
  ALLOWED_LAUNCHER_SETTINGS_KEYS,
  ALLOWED_SETUP_WIZARD_STATE_PATCH_KEYS,
};
