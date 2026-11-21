// @ts-check
'use strict';

const {
  LAUNCH_SHELL_OR_EXEC_FIELDS,
  isContainedWithinRoot,
  sanitizeLaunchConfigRecursive,
  collectLaunchCommandsRecursive,
  computeLaunchCommandFingerprint,
  isLaunchCommandApproved,
} = require('../../launcher/securityAndPathUtils.cjs');

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
 * `wrapperCommand`, `customExecutable`, `customExecutablePath`, `executablePath`) across ALL
 * nesting depths (`top-level`, `launchConfig`, `platformConfigs.*`, `storefrontConfigs.*`).
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
 * Normalize an identifier string for case-insensitive matching against main-process records.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeIdToken(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return String(raw).trim().toLowerCase();
  }
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * Resolve authoritative install root paths for `(gameId, platformId)` strictly from
 * main-process managed installs (`launcherEngine.loadManagedInstalledGames`) and the
 * main-process verified installed-games scan registry — NEVER trusting renderer-supplied
 * `installPath` strings.
 *
 * @param {Record<string, any>} cleanPayload
 * @param {any} launcherEngine
 * @param {Record<string, any>} [options]
 * @returns {string[]}
 */
function resolveAuthoritativeInstallRootsForLaunch(cleanPayload, launcherEngine, options = {}) {
  const reqGameId = normalizeIdToken(cleanPayload.gameId);
  const reqPlatformId = normalizeIdToken(cleanPayload.platformId);
  const reqPlatformGameId = normalizeIdToken(
    cleanPayload.platformGameId ?? cleanPayload.steamAppId ?? cleanPayload.appId
  );

  // Extract normalized platform + id from composite gameId (e.g. "steam-620", "gog:1234")
  let parsedGamePlatform = '';
  let parsedGameSubId = '';
  const compositeMatch = reqGameId.match(/^([a-z0-9]+)[:_-](.+)$/);
  if (compositeMatch) {
    parsedGamePlatform = compositeMatch[1];
    parsedGameSubId = compositeMatch[2].trim();
  }

  /** @type {any[]} */
  const candidateRecords = [];
  if (typeof launcherEngine?.loadManagedInstalledGames === 'function') {
    try {
      const managed = launcherEngine.loadManagedInstalledGames(options?.userDataDir);
      if (Array.isArray(managed)) {
        for (const rec of managed) {
          if (rec && typeof rec === 'object') {
            candidateRecords.push(rec);
          }
        }
      }
    } catch {}
  }

  if (Array.isArray(options?.verifiedInstalledGames)) {
    for (const rec of options.verifiedInstalledGames) {
      if (!rec || typeof rec !== 'object') continue;
      // Never trust synthetic custom-config override entries from non-0600 launch configs
      if (rec.source === 'custom_config' || rec.isCustomOverride === true) continue;
      candidateRecords.push(rec);
    }
  }

  /** @type {Set<string>} */
  const authoritativeRoots = new Set();

  for (const rec of candidateRecords) {
    const recInstallPath =
      typeof rec.installPath === 'string' && !rec.installPath.includes('\0')
        ? rec.installPath.trim()
        : '';
    if (!recInstallPath) continue;

    const recPlatform = normalizeIdToken(rec.platformId);
    if (reqPlatformId && recPlatform && reqPlatformId !== recPlatform) {
      continue;
    }

    const recGameId = normalizeIdToken(rec.gameId);
    const recPlatformGameId = normalizeIdToken(rec.platformGameId);
    const recAppId = normalizeIdToken(rec.appId ?? rec.steamAppId);
    const strippedRecPid = recPlatformGameId.replace(/^(?:steam|gog|epic|xbox|ea|ubisoft|bnet|rockstar)[:_-]/, '');
    const strippedReqPid = reqPlatformGameId.replace(/^(?:steam|gog|epic|xbox|ea|ubisoft|bnet|rockstar)[:_-]/, '');

    let matched = false;
    if (reqGameId && recGameId && reqGameId === recGameId) {
      matched = true;
    } else if (reqGameId && recPlatform && recPlatformGameId) {
      if (
        reqGameId === `${recPlatform}-${recPlatformGameId}` ||
        reqGameId === `${recPlatform}:${recPlatformGameId}` ||
        reqGameId === `${recPlatform}_${recPlatformGameId}` ||
        (strippedRecPid &&
          (reqGameId === `${recPlatform}-${strippedRecPid}` ||
            reqGameId === `${recPlatform}:${strippedRecPid}` ||
            reqGameId === `${recPlatform}_${strippedRecPid}`))
      ) {
        matched = true;
      }
    }

    if (!matched && reqPlatformGameId && recPlatformGameId) {
      if (
        reqPlatformGameId === recPlatformGameId ||
        (strippedReqPid && strippedRecPid && strippedReqPid === strippedRecPid)
      ) {
        matched = true;
      }
    }

    if (!matched && parsedGameSubId && recPlatformGameId) {
      if (
        (!parsedGamePlatform || !recPlatform || parsedGamePlatform === recPlatform) &&
        (parsedGameSubId === recPlatformGameId ||
          (strippedRecPid && parsedGameSubId === strippedRecPid))
      ) {
        matched = true;
      }
    }

    if (!matched && recAppId && (recPlatform === 'steam' || !recPlatform)) {
      if (
        (reqPlatformGameId && reqPlatformGameId === recAppId) ||
        (parsedGamePlatform === 'steam' && parsedGameSubId === recAppId)
      ) {
        matched = true;
      }
    }

    if (matched) {
      authoritativeRoots.add(recInstallPath);
    }
  }

  return Array.from(authoritativeRoots);
}

/**
 * Recursively strip unapproved shell/executable fields (`preLaunchCommand`, `postExitCommand`,
 * `wrapperCommand`, `customExecutable`, `customExecutablePath`, `executablePath`) from a
 * renderer launch payload at ALL nesting depths unless explicitly confirmed in
 * `approved_launch_commands.json` (or for depth-0 `executablePath`, strictly contained within
 * an authoritative main-process `installPath` from `loadManagedInstalledGames` / verified scan
 * registry for `(gameId, platformId)`).
 *
 * Security invariants (`SUP-01`):
 * - NEVER trusts renderer-supplied `cleanPayload.installPath` to auto-approve `executablePath`.
 * - NEVER auto-approves commands merely present in `one_launcher_configs.json` (`approvedInSavedCfg` removed).
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

  const authoritativeInstallRoots = resolveAuthoritativeInstallRootsForLaunch(
    cleanPayload,
    launcherEngine,
    options
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
        if (typeof val === 'string' && val.trim() && !val.includes('\0')) {
          const trimmed = val.trim();
          if (
            depth === 0 &&
            key === 'executablePath' &&
            authoritativeInstallRoots.length > 0 &&
            authoritativeInstallRoots.some((root) => isContainedWithinRoot(root, trimmed))
          ) {
            out[key] = trimmed;
            continue;
          }
          const fp = computeLaunchCommandFingerprint(key, trimmed);
          const approvedInVault = gameId ? isLaunchCommandApproved(gameId, fp, options) : false;
          if (approvedInVault) {
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

module.exports = {
  sanitizeRendererIpcOptions,
  collectShellCommandsFromConfig,
  resolveAuthoritativeInstallRootsForLaunch,
  stripUnconfirmedInlineShellCommands,
};
