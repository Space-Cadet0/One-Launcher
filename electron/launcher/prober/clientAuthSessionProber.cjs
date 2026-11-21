// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CLIENT_LOGIN_TARGET_CATALOG } = require('../policy/environmentCatalog.cjs');
const { isStoreDisconnectedTombstoned } = require('../securityAndPathUtils.cjs');
const {
  resolveDriveCPathCaseInsensitive,
  resolveBottleSteamExe,
} = require('../wineAndCrossOverManager.cjs');
const { resolveGogGalaxyClientBinaryPath } = require('../gogRegistryAndDirectInstaller.cjs');
const {
  resolveEpicClientBinaryPath,
  isMockOrCorruptedToken,
  isPoisonedStorefrontToken,
} = require('../epicLegendaryAndEosCoordinator.cjs');
const { steamId64ToAccountId32 } = require('../../storefronts/steamLocalScanner.cjs');
const chainedPublisherLaunchers = require('../chainedPublisherLaunchers.cjs');
const {
  explicitHomedirOpt,
  resolveReadOnlyPaths,
  getSetupWizardState,
  loadSavedTokensReadOnly,
  resolveConnectedStorefronts,
} = require('./setupWizardStateStore.cjs');
const {
  getMacNativeInstaller,
  detectRunnersReadOnly,
  listBottleUserDirsAsync,
  buildBottleEnvironmentSummaryAsync,
} = require('./bottleAndRunnerProber.cjs');

/**
 * @typedef {import('./setupWizardStateStore.cjs').ClientLoginTargetId} ClientLoginTargetId
 * @typedef {import('./setupWizardStateStore.cjs').ClientAuthProbeState} ClientAuthProbeState
 * @typedef {import('./setupWizardStateStore.cjs').DiscoveredLocalStoreHint} DiscoveredLocalStoreHint
 * @typedef {import('./setupWizardStateStore.cjs').StorefrontId} StorefrontId
 */

/**
 * Lazy accessor breaking the circular `require()` cycle between `environmentHealthProber.cjs`
 * and `sessionAndProcessSupervisor.cjs` during module initialization.
 *
 * @returns {Record<string, any>}
 */
function getSessionSupervisor() {
  return /** @type {Record<string, any>} */ (require('../sessionAndProcessSupervisor.cjs'));
}

/**
 * Resolve the canonical label for a client login target from Wave 1's `environmentCatalog.cjs`.
 *
 * @param {ClientLoginTargetId} targetId
 * @param {'darwin' | 'win32' | 'linux'} hostPlatform
 * @returns {string}
 */
function getLoginTargetLabel(targetId, hostPlatform) {
  const entry = CLIENT_LOGIN_TARGET_CATALOG[targetId];
  if (!entry) return targetId;
  return hostPlatform === 'darwin' ? entry.macLabel : entry.label;
}

/**
 * Parse `Steam/config/loginusers.vdf` to extract active user session metadata (`SteamID64`,
 * `PersonaName`, `AccountName`, `MostRecent`, `AllowAutoLogin`).
 *
 * @param {string} vdfText
 * @returns {{ steamId64: string, personaName: string, accountName: string, mostRecent: boolean, allowAutoLogin: boolean, timestamp: number } | null}
 */
function parseSteamLoginUsersVdfDetails(vdfText) {
  if (!vdfText || typeof vdfText !== 'string') return null;
  const userBlockRegex = /"(\d{17})"\s*\{([^{}]*)\}/g;

  /** @type {Array<{ steamId64: string, personaName: string, accountName: string, mostRecent: boolean, allowAutoLogin: boolean, explicitlyLoggedOut: boolean, timestamp: number }>} */
  const users = [];
  let hasAnyMostRecentKey = false;

  let m;
  while ((m = userBlockRegex.exec(vdfText)) !== null) {
    const steamId64 = m[1];
    if (!steamId64ToAccountId32(steamId64)) continue;
    const body = m[2] || '';

    const personaMatch = body.match(/"PersonaName"\s+"([^"]*)"/i);
    const accountMatch = body.match(/"AccountName"\s+"([^"]*)"/i);
    const mrMatch = body.match(/"MostRecent"\s+"(\d+)"/i);
    const autoMatch = body.match(/"AllowAutoLogin"\s+"(\d+)"/i);
    const remMatch = body.match(/"RememberPassword"\s+"(\d+)"/i);
    const tsMatch = body.match(/"Timestamp"\s+"(\d+)"/i);

    if (mrMatch) hasAnyMostRecentKey = true;
    const mostRecent = Boolean(mrMatch && mrMatch[1] === '1');
    const allowAutoLogin = autoMatch
      ? autoMatch[1] === '1'
      : remMatch
        ? remMatch[1] === '1'
        : mostRecent;
    const explicitlyLoggedOut = Boolean(
      !mostRecent &&
        ((autoMatch && autoMatch[1] === '0') || (remMatch && remMatch[1] === '0'))
    );
    const timestamp = tsMatch ? Number(tsMatch[1]) || 0 : 0;

    users.push({
      steamId64,
      personaName: personaMatch ? personaMatch[1].trim() : '',
      accountName: accountMatch ? accountMatch[1].trim() : '',
      mostRecent,
      allowAutoLogin,
      explicitlyLoggedOut,
      timestamp,
    });
  }

  if (users.length === 0) return null;

  const mostRecentUsers = users
    .filter((u) => u.mostRecent)
    .sort((a, b) => b.timestamp - a.timestamp);
  if (mostRecentUsers.length > 0) {
    const chosen = mostRecentUsers[0];
    return {
      steamId64: chosen.steamId64,
      personaName: chosen.personaName,
      accountName: chosen.accountName,
      mostRecent: chosen.mostRecent,
      allowAutoLogin: chosen.allowAutoLogin,
      timestamp: chosen.timestamp,
    };
  }

  if (!hasAnyMostRecentKey) {
    const fallbackUsers = users
      .filter((u) => !u.explicitlyLoggedOut && (u.allowAutoLogin || u.timestamp > 0))
      .sort((a, b) => b.timestamp - a.timestamp);
    if (fallbackUsers.length > 0) {
      const chosen = fallbackUsers[0];
      return {
        steamId64: chosen.steamId64,
        personaName: chosen.personaName,
        accountName: chosen.accountName,
        mostRecent: false,
        allowAutoLogin: chosen.allowAutoLogin,
        timestamp: chosen.timestamp,
      };
    }
  }

  return null;
}

/**
 * Query GOG `galaxy-2.0.db` (`Users` table) strictly read-only via `node:sqlite`.
 * Handles both real GOG Galaxy 2.0/2.1 schemas (`CREATE TABLE Users('id' INT64 NOT NULL PRIMARY KEY)`
 * with 17-digit `INT64` IDs and no `username` column) and schemas with an optional `username` column,
 * casting `id` to `TEXT` inside SQLite to prevent 64-bit IEEE-754 precision loss.
 * Never creates or modifies database/WAL files.
 *
 * @param {string} dbPath
 * @param {string} [preferredUserId]
 * @returns {{ userId: string, username: string } | null}
 */
function readGogGalaxyDbUserReadOnly(dbPath, preferredUserId = '') {
  if (!dbPath) return null;
  try {
    if (!fs.existsSync(dbPath)) return null;
    const st = fs.statSync(dbPath);
    if (!st.isFile() || st.size <= 0) return null;
  } catch {
    return null;
  }

  /** @type {any} */
  let db = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    const cols = /** @type {Array<Record<string, any>>} */ (
      db.prepare('PRAGMA table_info(Users)').all()
    );
    if (!Array.isArray(cols) || cols.length === 0) {
      return null;
    }
    const hasIdCol = cols.some((c) => String(c?.name || '').toLowerCase() === 'id');
    if (!hasIdCol) {
      return null;
    }
    const hasUsernameCol = cols.some((c) => String(c?.name || '').toLowerCase() === 'username');
    const selectCols = hasUsernameCol
      ? 'CAST(id AS TEXT) AS userId, username'
      : 'CAST(id AS TEXT) AS userId';

    if (preferredUserId) {
      try {
        const matchedRow = /** @type {any} */ (
          db
            .prepare(`SELECT ${selectCols} FROM Users WHERE CAST(id AS TEXT) = ? LIMIT 1`)
            .get(String(preferredUserId))
        );
        if (matchedRow && matchedRow.userId !== undefined && matchedRow.userId !== null) {
          return {
            userId: String(matchedRow.userId).trim(),
            username: hasUsernameCol ? String(matchedRow.username || '').trim() : '',
          };
        }
      } catch {}
    }
    const row = /** @type {any} */ (
      db.prepare(`SELECT ${selectCols} FROM Users LIMIT 1`).get()
    );
    if (row && row.userId !== undefined && row.userId !== null) {
      return {
        userId: String(row.userId).trim(),
        username: hasUsernameCol ? String(row.username || '').trim() : '',
      };
    }
  } catch {
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
  return null;
}

/**
 * Look up a property case-insensitively inside a parsed Wine registry section object,
 * distinguishing an explicitly present empty string from an absent key.
 *
 * @param {Record<string, string> | undefined} props
 * @param {string} targetKey
 * @returns {{ present: boolean, value: string }}
 */
function lookupRegPropEntryCaseInsensitive(props, targetKey) {
  if (!props || typeof props !== 'object') {
    return { present: false, value: '' };
  }
  const lower = targetKey.toLowerCase();
  for (const [k, v] of Object.entries(props)) {
    if (k.toLowerCase() === lower) {
      return { present: true, value: String(v || '').trim() };
    }
  }
  return { present: false, value: '' };
}

/**
 * Parse Wine/CrossOver `user.reg` `[Software\\GOG.com\\Galaxy]` and
 * `[Software\\GOG.com\\Galaxy\\settings]` sections for GOG Galaxy login state
 * via canonical `parseWineRegistrySections`.
 * Never returns raw auth/refresh tokens.
 *
 * @param {string} userRegText
 * @returns {{ sawGalaxySection: boolean, hasRefreshToken: boolean, userId: string, username: string }}
 */
function parseWineGogRegistryUser(userRegText) {
  if (!userRegText || typeof userRegText !== 'string') {
    return { sawGalaxySection: false, hasRefreshToken: false, userId: '', username: '' };
  }

  const sections = chainedPublisherLaunchers.parseWineRegistrySections(userRegText);
  const galaxySec = sections.get('software\\gog.com\\galaxy');
  const settingsSec = sections.get('software\\gog.com\\galaxy\\settings');
  const sawGalaxySection = Boolean(galaxySec || settingsSec);
  if (!sawGalaxySection) {
    return { sawGalaxySection: false, hasRefreshToken: false, userId: '', username: '' };
  }

  const refreshEntry = lookupRegPropEntryCaseInsensitive(galaxySec, 'refreshToken');
  const hasRefreshToken = refreshEntry.present && refreshEntry.value.length > 0;

  const settingsUid = lookupRegPropEntryCaseInsensitive(settingsSec, 'userId');
  const galaxyUid = lookupRegPropEntryCaseInsensitive(galaxySec, 'userId');
  const userId = settingsUid.present ? settingsUid.value : galaxyUid.value;

  const settingsUname = lookupRegPropEntryCaseInsensitive(settingsSec, 'username');
  const galaxyUname = lookupRegPropEntryCaseInsensitive(galaxySec, 'username');
  const username = settingsUname.present ? settingsUname.value : galaxyUname.value;

  return { sawGalaxySection, hasRefreshToken, userId, username };
}

/**
 * Parse Epic Games Launcher `GameUserSettings.ini` for `[RememberMe]`, `[Offline]`, and UE5
 * per-account `[<32-hex-accountId>_General]` / `[<32-hex-accountId>_Launcher]` state.
 * Never returns raw auth tokens.
 *
 * @param {string} iniText
 * @returns {{ authenticated: boolean, accountId: string, displayLabel: string, candidateAccountIds: string[] }}
 */
function parseEpicGameUserSettingsIni(iniText) {
  if (!iniText || typeof iniText !== 'string') {
    return { authenticated: false, accountId: '', displayLabel: '', candidateAccountIds: [] };
  }

  /** @type {Record<string, Record<string, string>>} */
  const sections = {};
  /** @type {string[]} */
  const candidateAccountIds = [];
  const seenCandidateIds = new Set();
  let currentSection = '';
  for (const rawLine of iniText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const secMatch = line.match(/^\[([^\]]+)\]$/);
    if (secMatch) {
      const rawSecName = secMatch[1].trim();
      currentSection = rawSecName.toLowerCase();
      if (!sections[currentSection]) {
        sections[currentSection] = {};
      }
      const acctSecMatch = rawSecName.match(
        /^([a-f0-9]{32})_(?:general|launcher|autoinstall|dismissednotification|dismisseddialog|library|friends)$/i
      );
      if (acctSecMatch) {
        const candId = acctSecMatch[1].toLowerCase();
        if (!seenCandidateIds.has(candId)) {
          seenCandidateIds.add(candId);
          candidateAccountIds.push(candId);
        }
      }
      continue;
    }
    if (!currentSection) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim().toLowerCase();
    const val = line.slice(eqIdx + 1).trim();
    sections[currentSection][key] = val;
  }

  const rememberMe = sections['rememberme'] || {};
  const offline = sections['offline'] || {};
  const enableRaw = String(rememberMe['enable'] || '')
    .trim()
    .toLowerCase();
  const rememberEnabled = enableRaw === 'true' || enableRaw === '1';
  const rawData = String(rememberMe['data'] || '')
    .replace(/^"+|"+$/g, '')
    .trim();

  const hasNonEmptyData =
    Boolean(rawData) &&
    rawData !== '[]' &&
    rawData !== '[[]]' &&
    rawData.toLowerCase() !== 'none' &&
    rawData.toLowerCase() !== 'null';

  let accountId = String(
    rememberMe['accountid'] ||
      offline['accountid'] ||
      offline['userid'] ||
      sections['launcher']?.['accountid'] ||
      ''
  ).trim();
  let displayLabel = String(
    rememberMe['displayname'] ||
      rememberMe['email'] ||
      offline['displayname'] ||
      offline['username'] ||
      ''
  ).trim();

  if (hasNonEmptyData) {
    const cleanB64 = rawData.replace(/^\[+|\]+$/g, '').trim();
    if (/^[A-Za-z0-9+/=]+$/.test(cleanB64) && cleanB64.length >= 16) {
      try {
        const decoded = Buffer.from(cleanB64, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        const entry = Array.isArray(parsed) ? parsed[0] : parsed;
        if (entry && typeof entry === 'object') {
          if (!accountId && (entry.AccountId || entry.accountId || entry.UserId)) {
            accountId = String(entry.AccountId || entry.accountId || entry.UserId).trim();
          }
          if (!displayLabel && (entry.DisplayName || entry.Name || entry.Email)) {
            displayLabel = String(entry.DisplayName || entry.Name || entry.Email).trim();
          }
          if (entry.Token === '') {
            return {
              authenticated: false,
              accountId: '',
              displayLabel: '',
              candidateAccountIds: [],
            };
          }
        }
      } catch {}
    }
  }

  const authenticated = Boolean(
    (rememberEnabled && hasNonEmptyData) || (!enableRaw && hasNonEmptyData)
  );
  if (authenticated && !accountId && candidateAccountIds.length === 1) {
    accountId = candidateAccountIds[0];
  }
  return {
    authenticated,
    accountId: authenticated ? accountId : '',
    displayLabel: authenticated ? displayLabel || accountId : '',
    candidateAccountIds: authenticated ? candidateAccountIds : [],
  };
}

/**
 * Probe all 15 host & bottled storefront client authentication states strictly read-only.
 *
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<ClientLoginTargetId, ClientAuthProbeState>>}
 */
async function probeClientLoginStates(options = {}) {
  const rawPlatform = String(options.platform || process.platform).toLowerCase();
  /** @type {'darwin' | 'win32' | 'linux'} */
  const hostPlatform =
    rawPlatform === 'win32' ? 'win32' : rawPlatform === 'linux' ? 'linux' : 'darwin';
  const { homedir, userDataDir } = resolveReadOnlyPaths(options);

  const savedTokens = await loadSavedTokensReadOnly(userDataDir, options);
  const connectedStorefronts = resolveConnectedStorefronts(savedTokens, userDataDir, options);
  const wizardState = getSetupWizardState(options);

  let activeBottlePath = typeof options.bottlePath === 'string' ? options.bottlePath : '';
  let activeBottleName =
    typeof options.preferredBottleName === 'string' ? options.preferredBottleName : '';

  if (hostPlatform === 'darwin' && !activeBottlePath) {
    const runners = Array.isArray(options._detectedRunners)
      ? options._detectedRunners
      : detectRunnersReadOnly(options);
    const overriddenState = {
      ...wizardState,
      ...(options.preferredRunnerType ? { preferredRunnerType: options.preferredRunnerType } : {}),
      ...(options.preferredBottleName ? { preferredBottleName: options.preferredBottleName } : {}),
    };
    const summary =
      options._bottleSummary ||
      (await buildBottleEnvironmentSummaryAsync(
        hostPlatform,
        homedir,
        runners,
        overriddenState,
        options
      ));
    activeBottlePath = summary.activeBottlePath || '';
    activeBottleName = summary.recommendedBottleName || '';
    if (!activeBottlePath && summary.runnerInstalled && runners.length > 0) {
      const layer =
        (options.preferredRunnerType &&
          runners.find((/** @type {any} */ r) => r.type === options.preferredRunnerType)) ||
        runners[0];
      if (layer) {
        if (
          (layer.type === 'crossover' ||
            layer.type === 'crossover_preview' ||
            layer.type === 'crossover_preview_arm64') &&
          layer.bottlesDir
        ) {
          const fallbackDefault =
            layer.type === 'crossover_preview_arm64' ? 'OneLauncher-arm64' : 'OneLauncher';
          const candidatePath = path.join(layer.bottlesDir, activeBottleName || fallbackDefault);
          try {
            await fs.promises.access(candidatePath, fs.constants.F_OK);
            activeBottlePath = candidatePath;
          } catch {}
        } else {
          const candidatePrefix = path.join(
            homedir,
            'Games/OneLauncher/Prefixes',
            activeBottleName || 'default'
          );
          try {
            await fs.promises.access(candidatePrefix, fs.constants.F_OK);
            activeBottlePath = candidatePrefix;
          } catch {}
        }
      }
    }
  }

  const clientResolverOpts = {
    ...options,
    ...explicitHomedirOpt(options),
    platform: hostPlatform,
  };
  const sessionSup = getSessionSupervisor();
  const resolveSteamClientBinaryPath =
    typeof options.resolveSteamClientBinaryPathFn === 'function'
      ? options.resolveSteamClientBinaryPathFn
      : sessionSup.resolveSteamClientBinaryPath;
  const hostSteamBin =
    typeof resolveSteamClientBinaryPath === 'function'
      ? resolveSteamClientBinaryPath(clientResolverOpts)
      : null;
  const hostGogBin = resolveGogGalaxyClientBinaryPath(clientResolverOpts);
  const hostEpicBin = resolveEpicClientBinaryPath(clientResolverOpts);

  const macNative = getMacNativeInstaller();
  const bottleSteamBin =
    hostPlatform === 'darwin' && activeBottlePath ? resolveBottleSteamExe(activeBottlePath) : null;
  const bottleGogBin =
    hostPlatform === 'darwin' && activeBottlePath
      ? macNative.resolveBottleGogGalaxyExe(activeBottlePath)
      : null;
  const bottleEpicBin =
    hostPlatform === 'darwin' && activeBottlePath
      ? macNative.resolveBottleEpicLauncherExe(activeBottlePath)
      : null;

  const olSteamId = connectedStorefronts.includes('steam')
    ? String(
        (typeof savedTokens?.steam === 'string' ? savedTokens.steam : '') ||
          savedTokens?.steam?.steamId ||
          savedTokens?.steam?.accountId ||
          options.oneLauncherSteamId ||
          ''
      ).trim()
    : '';
  const olGogUserId = connectedStorefronts.includes('gog')
    ? String(
        savedTokens?.gog?.user_id || savedTokens?.gog?.userId || options.oneLauncherGogUserId || ''
      ).trim()
    : '';
  const olGogUsername = connectedStorefronts.includes('gog')
    ? String(
        savedTokens?.gog?.username ||
          savedTokens?.gog?.user_name ||
          options.oneLauncherGogUsername ||
          ''
      ).trim()
    : '';
  let olEpicAccountId = connectedStorefronts.includes('epic')
    ? String(
        savedTokens?.epic?.account_id ||
          savedTokens?.epic?.accountId ||
          options.oneLauncherEpicAccountId ||
          ''
      ).trim()
    : '';
  let olEpicDisplayName = connectedStorefronts.includes('epic')
    ? String(
        savedTokens?.epic?.displayName ||
          savedTokens?.epic?.display_name ||
          options.oneLauncherEpicDisplayName ||
          ''
      ).trim()
    : '';
  if (connectedStorefronts.includes('epic') && (!olEpicAccountId || !olEpicDisplayName)) {
    try {
      const legUserJsonPath = path.join(userDataDir, 'legendaryConfig/legendary/user.json');
      const rawLegUser = await fs.promises.readFile(legUserJsonPath, 'utf8');
      const parsedLegUser = JSON.parse(rawLegUser);
      if (parsedLegUser && typeof parsedLegUser === 'object') {
        if (!olEpicAccountId) {
          olEpicAccountId = String(
            parsedLegUser.account_id || parsedLegUser.accountId || ''
          ).trim();
        }
        if (!olEpicDisplayName) {
          olEpicDisplayName = String(
            parsedLegUser.displayName || parsedLegUser.display_name || ''
          ).trim();
        }
      }
    } catch {}
  }

  // 1. Steam helper (host & bottle)
  const probeSteamTarget = async (
    /** @type {'host_steam' | 'bottle_steam'} */ targetId,
    /** @type {'host' | 'bottle'} */ scope,
    /** @type {string} */ label,
    /** @type {string | null} */ binPath,
    /** @type {string[]} */ vdfCandidates
  ) => {
    const installed = Boolean(binPath);
    /** @type {ReturnType<typeof parseSteamLoginUsersVdfDetails>} */
    let activeUser = null;
    for (const vdfPath of vdfCandidates) {
      if (!vdfPath) continue;
      try {
        const text = await fs.promises.readFile(vdfPath, 'utf8');
        const parsed = parseSteamLoginUsersVdfDetails(text);
        if (parsed) {
          activeUser = parsed;
          break;
        }
      } catch {}
    }

    const authenticated = Boolean(activeUser && activeUser.steamId64);
    const autoLoginEnabled = Boolean(activeUser?.allowAutoLogin);
    const detectedAccountLabel = activeUser
      ? activeUser.personaName || activeUser.accountName || activeUser.steamId64
      : undefined;

    /** @type {boolean | null} */
    let accountMatchesOneLauncher = null;
    /** @type {string | undefined} */
    let mismatchReason;
    if (authenticated && activeUser?.steamId64 && olSteamId && /^\d{17}$/.test(olSteamId)) {
      accountMatchesOneLauncher = activeUser.steamId64 === olSteamId;
      if (!accountMatchesOneLauncher) {
        mismatchReason = `Signed into a different Steam account (${detectedAccountLabel}) than One Launcher (${olSteamId}).`;
      }
    }

    const statusSummary = !installed
      ? scope === 'bottle' && hostPlatform !== 'darwin'
        ? 'Not needed on Windows'
        : 'Not installed'
      : !authenticated
        ? 'Sign-in needed'
        : accountMatchesOneLauncher === false
          ? mismatchReason || 'Different Steam account signed in'
          : !autoLoginEnabled
            ? `Signed in as ${detectedAccountLabel} (Remember me off)`
            : `Signed in as ${detectedAccountLabel}`;

    /** @type {ClientAuthProbeState} */
    const state = {
      targetId,
      storefrontId: 'steam',
      scope,
      label,
      installed,
      ...(binPath ? { binaryPath: binPath } : {}),
      ...(scope === 'bottle' && activeBottleName ? { bottleName: activeBottleName } : {}),
      ...(scope === 'bottle' && activeBottlePath ? { bottlePath: activeBottlePath } : {}),
      authenticated,
      autoLoginEnabled,
      ...(detectedAccountLabel ? { detectedAccountLabel } : {}),
      accountMatchesOneLauncher,
      ...(mismatchReason ? { mismatchReason } : {}),
      statusSummary,
      ...(activeUser?.steamId64 ? { _steamId64: activeUser.steamId64 } : {}),
    };
    return state;
  };

  // 2. GOG Galaxy helper (host & bottle)
  const probeGogTarget = async (
    /** @type {'host_gog' | 'bottle_gog'} */ targetId,
    /** @type {'host' | 'bottle'} */ scope,
    /** @type {string} */ label,
    /** @type {string | null} */ binPath,
    /** @type {string[]} */ configCandidates,
    /** @type {string[]} */ dbCandidates,
    /** @type {string} */ wineUserRegPath = ''
  ) => {
    const installed = Boolean(binPath);
    let configUserId = '';
    let configUsername = '';
    let explicitlySignedOut = false;
    let perUserConfigMissingUser = false;

    for (const cfgPath of configCandidates) {
      if (!cfgPath) continue;
      try {
        const raw = await fs.promises.readFile(cfgPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const hasUidProp =
            Object.prototype.hasOwnProperty.call(parsed, 'userId') ||
            Object.prototype.hasOwnProperty.call(parsed, 'user_id');
          const uid = String(parsed.userId ?? parsed.user_id ?? '').trim();
          const uname = String(parsed.username ?? parsed.user_name ?? '').trim();
          if (uid) {
            configUserId = uid;
            configUsername = uname;
            explicitlySignedOut = false;
            perUserConfigMissingUser = false;
            break;
          }
          if (hasUidProp) {
            explicitlySignedOut = true;
            break;
          }
          const normalizedCfgPath = cfgPath.replace(/\\/g, '/').toLowerCase();
          const isPerUserConfigurationJson =
            normalizedCfgPath.endsWith('/configuration/config.json') ||
            Object.prototype.hasOwnProperty.call(parsed, 'keepLoggedIn') ||
            Object.prototype.hasOwnProperty.call(parsed, 'whenClosingMainWindow');
          if (isPerUserConfigurationJson) {
            perUserConfigMissingUser = true;
          }
        }
      } catch {}
    }

    if (!configUserId && !explicitlySignedOut && wineUserRegPath) {
      try {
        const regText = await fs.promises.readFile(wineUserRegPath, 'utf8');
        const regUser = parseWineGogRegistryUser(regText);
        if (regUser.hasRefreshToken && regUser.userId) {
          configUserId = regUser.userId;
          if (regUser.username) {
            configUsername = regUser.username;
          }
          perUserConfigMissingUser = false;
        } else if (regUser.sawGalaxySection && !regUser.hasRefreshToken) {
          perUserConfigMissingUser = true;
        }
      } catch {}
    }

    /** @type {{ userId: string, username: string } | null} */
    let dbUser = null;
    if (!explicitlySignedOut && (!perUserConfigMissingUser || Boolean(configUserId))) {
      for (const dbPath of dbCandidates) {
        dbUser = readGogGalaxyDbUserReadOnly(dbPath, configUserId);
        if (dbUser) break;
      }
    }

    const suppressDbOnlySession = explicitlySignedOut || perUserConfigMissingUser;
    const detectedUserId = configUserId || (suppressDbOnlySession ? '' : dbUser?.userId || '');
    const authenticated = Boolean(
      detectedUserId || (!suppressDbOnlySession && (configUsername || dbUser?.username))
    );

    /** @type {boolean | null} */
    let accountMatchesOneLauncher = null;
    if (authenticated && detectedUserId && olGogUserId) {
      accountMatchesOneLauncher = detectedUserId === olGogUserId;
    }

    const detectedUsername =
      configUsername ||
      dbUser?.username ||
      (accountMatchesOneLauncher === true && olGogUsername ? olGogUsername : '');
    const detectedAccountLabel = authenticated
      ? detectedUsername || (detectedUserId ? `GOG User ${detectedUserId}` : undefined)
      : undefined;

    /** @type {string | undefined} */
    let mismatchReason;
    if (accountMatchesOneLauncher === false && detectedUserId && olGogUserId) {
      const olDesc = olGogUsername ? `${olGogUsername} (${olGogUserId})` : olGogUserId;
      mismatchReason = `Signed into a different GOG account (${detectedAccountLabel || detectedUserId}) than One Launcher (${olDesc}).`;
    }

    const statusSummary = !installed
      ? scope === 'bottle' && hostPlatform !== 'darwin'
        ? 'Not needed on Windows'
        : 'Not installed'
      : !authenticated
        ? 'Sign-in needed'
        : accountMatchesOneLauncher === false
          ? mismatchReason || 'Different GOG account signed in'
          : `Signed in as ${detectedAccountLabel || 'GOG User'}`;

    /** @type {ClientAuthProbeState} */
    const state = {
      targetId,
      storefrontId: 'gog',
      scope,
      label,
      installed,
      ...(binPath ? { binaryPath: binPath } : {}),
      ...(scope === 'bottle' && activeBottleName ? { bottleName: activeBottleName } : {}),
      ...(scope === 'bottle' && activeBottlePath ? { bottlePath: activeBottlePath } : {}),
      authenticated,
      ...(detectedAccountLabel ? { detectedAccountLabel } : {}),
      accountMatchesOneLauncher,
      ...(mismatchReason ? { mismatchReason } : {}),
      statusSummary,
    };
    return state;
  };

  // 3. Epic Games Launcher helper (host & bottle)
  const probeEpicTarget = async (
    /** @type {'host_epic' | 'bottle_epic'} */ targetId,
    /** @type {'host' | 'bottle'} */ scope,
    /** @type {string} */ label,
    /** @type {string | null} */ binPath,
    /** @type {string[]} */ iniCandidates
  ) => {
    const installed = Boolean(binPath);
    let authenticated = false;
    let detectedAccountId = '';
    let detectedLabel = '';

    for (const iniPath of iniCandidates) {
      if (!iniPath) continue;
      try {
        const rawIni = await fs.promises.readFile(iniPath, 'utf8');
        const parsed = parseEpicGameUserSettingsIni(rawIni);
        if (parsed.authenticated) {
          authenticated = true;
          detectedAccountId = parsed.accountId;
          detectedLabel = parsed.displayLabel;
          if (!detectedAccountId && parsed.candidateAccountIds.length > 1) {
            const savedDataDirs = Array.from(
              new Set([
                path.resolve(path.dirname(iniPath), '../../Data'),
                ...(scope === 'host' && hostPlatform === 'darwin'
                  ? [
                      path.join(
                        homedir,
                        'Library/Application Support/Epic/EpicGamesLauncher/Saved/Data'
                      ),
                    ]
                  : []),
              ])
            );
            let newestId = '';
            let newestMtimeMs = -1;
            for (const candId of parsed.candidateAccountIds) {
              for (const savedDataDir of savedDataDirs) {
                for (const fileName of [
                  `${candId}.dat`,
                  `OC_${candId}.dat`,
                  `${candId.toUpperCase()}.dat`,
                  `OC_${candId.toUpperCase()}.dat`,
                ]) {
                  try {
                    const st = await fs.promises.stat(path.join(savedDataDir, fileName));
                    if (st.isFile() && st.mtimeMs >= newestMtimeMs) {
                      newestMtimeMs = st.mtimeMs;
                      newestId = candId;
                    }
                  } catch {}
                }
              }
            }
            if (newestId) {
              detectedAccountId = newestId;
            } else if (
              olEpicAccountId &&
              parsed.candidateAccountIds.some(
                (id) => id.toLowerCase() === olEpicAccountId.toLowerCase()
              )
            ) {
              detectedAccountId =
                parsed.candidateAccountIds.find(
                  (id) => id.toLowerCase() === olEpicAccountId.toLowerCase()
                ) || '';
            } else {
              detectedAccountId = parsed.candidateAccountIds[parsed.candidateAccountIds.length - 1];
            }
          }
          break;
        }
      } catch {}
    }

    const isHex32Label = /^[a-f0-9]{32}$/i.test(detectedLabel);
    /** @type {boolean | null} */
    let accountMatchesOneLauncher = null;
    /** @type {string | undefined} */
    let mismatchReason;
    if (authenticated && detectedAccountId && olEpicAccountId) {
      accountMatchesOneLauncher =
        detectedAccountId.toLowerCase() === olEpicAccountId.toLowerCase();
      if (!accountMatchesOneLauncher) {
        const detectedDesc =
          detectedLabel && !isHex32Label
            ? detectedLabel
            : /^[a-f0-9]{32}$/i.test(detectedAccountId)
              ? `Epic ID ${detectedAccountId.slice(0, 8)}…`
              : detectedAccountId;
        const olDesc = olEpicDisplayName || olEpicAccountId;
        mismatchReason = `Signed into a different Epic account (${detectedDesc}) than One Launcher (${olDesc}).`;
      }
    }

    if (authenticated && (!detectedLabel || isHex32Label)) {
      if (accountMatchesOneLauncher === true && olEpicDisplayName) {
        detectedLabel = olEpicDisplayName;
      } else if (isHex32Label) {
        detectedLabel = '';
      }
    }

    const statusSummary = !installed
      ? scope === 'bottle' && hostPlatform !== 'darwin'
        ? 'Not needed on Windows'
        : 'Not installed'
      : !authenticated
        ? 'Sign-in needed'
        : accountMatchesOneLauncher === false
          ? mismatchReason || 'Different Epic account signed in'
          : `Signed in${detectedLabel ? ` as ${detectedLabel}` : ''}`;

    /** @type {ClientAuthProbeState} */
    const state = {
      targetId,
      storefrontId: 'epic',
      scope,
      label,
      installed,
      ...(binPath ? { binaryPath: binPath } : {}),
      ...(scope === 'bottle' && activeBottleName ? { bottleName: activeBottleName } : {}),
      ...(scope === 'bottle' && activeBottlePath ? { bottlePath: activeBottlePath } : {}),
      authenticated,
      ...(detectedLabel ? { detectedAccountLabel: detectedLabel } : {}),
      accountMatchesOneLauncher,
      ...(mismatchReason ? { mismatchReason } : {}),
      statusSummary,
    };
    return state;
  };

  // Assemble candidate file lists
  const hostSteamVdfs = [
    typeof options.hostSteamLoginUsersVdfPath === 'string'
      ? options.hostSteamLoginUsersVdfPath
      : '',
    ...(hostPlatform === 'darwin'
      ? [path.join(homedir, 'Library/Application Support/Steam/config/loginusers.vdf')]
      : hostPlatform === 'win32'
        ? [
            hostSteamBin ? path.join(path.dirname(hostSteamBin), 'config', 'loginusers.vdf') : '',
            path.join(homedir, 'Program Files (x86)/Steam/config/loginusers.vdf'),
            path.join(homedir, 'Steam/config/loginusers.vdf'),
            ...(!options.homedir
              ? [
                  'C:\\Program Files (x86)\\Steam\\config\\loginusers.vdf',
                  'C:\\Program Files\\Steam\\config\\loginusers.vdf',
                ]
              : []),
          ]
        : [
            path.join(homedir, '.local/share/Steam/config/loginusers.vdf'),
            path.join(homedir, '.steam/steam/config/loginusers.vdf'),
          ]),
  ].filter(Boolean);

  const bottleSteamVdfs =
    hostPlatform === 'darwin' && activeBottlePath
      ? [
          bottleSteamBin
            ? path.join(path.dirname(bottleSteamBin), 'config', 'loginusers.vdf')
            : '',
          path.join(activeBottlePath, 'drive_c/Program Files (x86)/Steam/config/loginusers.vdf'),
          path.join(activeBottlePath, 'drive_c/Program Files/Steam/config/loginusers.vdf'),
        ].filter(Boolean)
      : [];

  const programDataWin = process.env.PROGRAMDATA || 'C:\\ProgramData';
  const winLocalAppData =
    !options.homedir && process.env.LOCALAPPDATA
      ? process.env.LOCALAPPDATA
      : path.join(homedir, 'AppData/Local');
  const winProgramDataRoot = !options.homedir ? programDataWin : path.join(homedir, 'ProgramData');
  const bottleUserDirs =
    hostPlatform === 'darwin' && activeBottlePath
      ? await listBottleUserDirsAsync(activeBottlePath)
      : [];

  const hostGogRoots =
    hostPlatform === 'darwin'
      ? !options.homedir
        ? [
            path.join(homedir, 'Library/Application Support/GOG.com/Galaxy'),
            '/Users/Shared/GOG.com/Galaxy',
          ]
        : [
            path.join(homedir, 'Library/Application Support/GOG.com/Galaxy'),
            path.join(homedir, 'Users/Shared/GOG.com/Galaxy'),
            path.join(homedir, 'GOG.com/Galaxy'),
          ]
      : hostPlatform === 'win32'
        ? [
            path.join(winLocalAppData, 'GOG.com/Galaxy'),
            path.join(winProgramDataRoot, 'GOG.com/Galaxy'),
          ]
        : [];

  const hostGogConfigs = Array.from(
    new Set(
      [
        typeof options.gogGalaxyConfigPath === 'string' ? options.gogGalaxyConfigPath : '',
        ...hostGogRoots.map((root) => path.join(root, 'Configuration', 'config.json')),
        ...hostGogRoots.map((root) => path.join(root, 'config.json')),
      ].filter(Boolean)
    )
  );

  const hostGogDbRoots = Array.from(
    new Set([
      ...hostGogRoots,
      ...(typeof options.gogGalaxyConfigPath === 'string' && options.gogGalaxyConfigPath
        ? [path.dirname(options.gogGalaxyConfigPath)]
        : []),
    ])
  );
  const hostGogDbs = Array.from(
    new Set(
      [
        typeof options.gogGalaxyDbPath === 'string' ? options.gogGalaxyDbPath : '',
        ...hostGogDbRoots.flatMap((root) => [
          path.join(root, 'storage', 'galaxy-2.0.db'),
          path.join(root, 'Storage', 'galaxy-2.0.db'),
        ]),
      ].filter(Boolean)
    )
  );

  const bottleGogConfigs =
    hostPlatform === 'darwin' && activeBottlePath
      ? Array.from(
          new Set(
            [
              typeof options.bottleGogGalaxyConfigPath === 'string'
                ? options.bottleGogGalaxyConfigPath
                : '',
              ...bottleUserDirs.flatMap((uDir) => [
                resolveDriveCPathCaseInsensitive(uDir, [
                  'AppData',
                  'Local',
                  'GOG.com',
                  'Galaxy',
                  'Configuration',
                  'config.json',
                ]),
                path.join(uDir, 'AppData/Local/GOG.com/Galaxy/Configuration/config.json'),
                resolveDriveCPathCaseInsensitive(uDir, [
                  'AppData',
                  'Local',
                  'GOG.com',
                  'Galaxy',
                  'config.json',
                ]),
                path.join(uDir, 'AppData/Local/GOG.com/Galaxy/config.json'),
              ]),
              path.join(
                activeBottlePath,
                'drive_c/ProgramData/GOG.com/Galaxy/Configuration/config.json'
              ),
              path.join(activeBottlePath, 'drive_c/ProgramData/GOG.com/Galaxy/config.json'),
            ].filter(Boolean)
          )
        )
      : [];
  const bottleGogDbs =
    hostPlatform === 'darwin' && activeBottlePath
      ? Array.from(
          new Set(
            [
              typeof options.bottleGogGalaxyDbPath === 'string'
                ? options.bottleGogGalaxyDbPath
                : '',
              path.join(activeBottlePath, 'drive_c/ProgramData/GOG.com/Galaxy/storage/galaxy-2.0.db'),
              path.join(activeBottlePath, 'drive_c/ProgramData/GOG.com/Galaxy/Storage/galaxy-2.0.db'),
            ].filter(Boolean)
          )
        )
      : [];
  const bottleUserRegPath =
    hostPlatform === 'darwin' && activeBottlePath ? path.join(activeBottlePath, 'user.reg') : '';

  const macEpicSubpaths = [
    'MacEditor/GameUserSettings.ini',
    'MacPortal/GameUserSettings.ini',
    'Mac/GameUserSettings.ini',
  ];
  const winEpicSubpaths = [
    'WindowsEditor/GameUserSettings.ini',
    'WindowsPortal/GameUserSettings.ini',
    'Windows/GameUserSettings.ini',
  ];

  const hostEpicInis = [
    typeof options.hostEpicGameUserSettingsIniPath === 'string'
      ? options.hostEpicGameUserSettingsIniPath
      : '',
    ...(hostPlatform === 'darwin'
      ? [
          path.join(homedir, 'Library/Application Support/Epic/EpicGamesLauncher/Saved/Config'),
          path.join(homedir, 'Library/Preferences/Unreal Engine/EpicGamesLauncher'),
        ].flatMap((root) => macEpicSubpaths.map((sub) => path.join(root, sub)))
      : hostPlatform === 'win32'
        ? winEpicSubpaths.map((sub) =>
            path.join(winLocalAppData, 'EpicGamesLauncher/Saved/Config', sub)
          )
        : []),
  ].filter(Boolean);

  /** @type {string[]} */
  const bottleEpicInis = [];
  for (const uDir of bottleUserDirs) {
    for (const sub of winEpicSubpaths) {
      bottleEpicInis.push(path.join(uDir, 'AppData/Local/EpicGamesLauncher/Saved/Config', sub));
    }
  }

  // Read & parse bottle system.reg once (< 5ms) and share across all bottle publisher probes
  /** @type {Promise<Map<string, Record<string, string>> | undefined>} */
  const parsedBottleSystemRegPromise =
    hostPlatform === 'darwin' && activeBottlePath
      ? fs.promises
          .readFile(path.join(activeBottlePath, 'system.reg'), 'utf8')
          .then((raw) => chainedPublisherLaunchers.parseWineRegistrySections(raw))
          .catch(() => undefined)
      : Promise.resolve(undefined);

  const [
    hostSteam,
    bottleSteam,
    hostGog,
    bottleGog,
    hostEpic,
    bottleEpic,
    parsedBottleSystemReg,
  ] = await Promise.all([
    probeSteamTarget(
      'host_steam',
      'host',
      getLoginTargetLabel('host_steam', hostPlatform),
      hostSteamBin,
      hostSteamVdfs
    ),
    probeSteamTarget(
      'bottle_steam',
      'bottle',
      getLoginTargetLabel('bottle_steam', hostPlatform),
      bottleSteamBin,
      bottleSteamVdfs
    ),
    probeGogTarget(
      'host_gog',
      'host',
      getLoginTargetLabel('host_gog', hostPlatform),
      hostGogBin,
      hostGogConfigs,
      hostGogDbs
    ),
    probeGogTarget(
      'bottle_gog',
      'bottle',
      getLoginTargetLabel('bottle_gog', hostPlatform),
      bottleGogBin,
      bottleGogConfigs,
      bottleGogDbs,
      bottleUserRegPath
    ),
    probeEpicTarget(
      'host_epic',
      'host',
      getLoginTargetLabel('host_epic', hostPlatform),
      hostEpicBin,
      hostEpicInis
    ),
    probeEpicTarget(
      'bottle_epic',
      'bottle',
      getLoginTargetLabel('bottle_epic', hostPlatform),
      bottleEpicBin,
      bottleEpicInis
    ),
    parsedBottleSystemRegPromise,
  ]);

  const chainedAny = /** @type {Record<string, any>} */ (chainedPublisherLaunchers);
  const discoverBottlePublisher =
    typeof chainedAny.discoverBottlePublisherLauncherAsync === 'function'
      ? chainedAny.discoverBottlePublisherLauncherAsync
      : chainedPublisherLaunchers.discoverBottlePublisherLauncher;
  const discoverHostPublisher =
    typeof chainedAny.discoverHostPublisherLauncherAsync === 'function'
      ? chainedAny.discoverHostPublisherLauncherAsync
      : chainedPublisherLaunchers.discoverHostPublisherLauncher;

  /**
   * Build `ClientAuthProbeState` for a chained publisher launcher (`ubisoft`, `ea`, `bnet`, `rockstar`, `riot`).
   * Uses async publisher discovery when exposed by `chainedPublisherLaunchers.cjs`.
   *
   * @param {ClientLoginTargetId} targetId
   * @param {'ubisoft' | 'ea' | 'bnet' | 'rockstar' | 'riot'} storefrontId
   * @param {'host' | 'bottle'} scope
   * @param {boolean} applicable
   * @param {{ allowMacNativeDiscovery?: boolean }} [opts]
   * @returns {Promise<ClientAuthProbeState>}
   */
  const probePublisherTargetAsync = async (targetId, storefrontId, scope, applicable, opts = {}) => {
    const label = getLoginTargetLabel(targetId, hostPlatform);
    const canProbeOnCurrentHost =
      applicable || (opts.allowMacNativeDiscovery === true && hostPlatform === 'darwin');
    const discovered = !canProbeOnCurrentHost
      ? { installed: false, hasLocalSession: false }
      : scope === 'bottle'
        ? activeBottlePath
          ? await discoverBottlePublisher(activeBottlePath, storefrontId, {
              parsedSystemReg: parsedBottleSystemReg,
            })
          : { installed: false, hasLocalSession: false }
        : await discoverHostPublisher(storefrontId, clientResolverOpts);

    const effectiveApplicable =
      applicable ||
      Boolean(
        opts.allowMacNativeDiscovery === true &&
          hostPlatform === 'darwin' &&
          discovered.installed &&
          discovered.binaryPath
      );

    const installed = Boolean(effectiveApplicable && discovered.installed && discovered.binaryPath);
    const authenticated = Boolean(installed && discovered.hasLocalSession);
    const statusSummary = !effectiveApplicable
      ? scope === 'bottle'
        ? 'Not needed on Windows'
        : 'Not available natively on Mac'
      : !installed
        ? 'Not installed'
        : !authenticated
          ? 'Sign-in needed'
          : 'Signed in';

    /** @type {ClientAuthProbeState} */
    const state = {
      targetId,
      storefrontId,
      scope,
      label,
      installed,
      ...(installed && discovered.binaryPath ? { binaryPath: discovered.binaryPath } : {}),
      ...(scope === 'bottle' && activeBottleName ? { bottleName: activeBottleName } : {}),
      ...(scope === 'bottle' && activeBottlePath ? { bottlePath: activeBottlePath } : {}),
      authenticated,
      accountMatchesOneLauncher: null,
      statusSummary,
      ...(discovered.version ? { _version: discovered.version } : {}),
    };
    return state;
  };

  const [
    hostUbisoft,
    bottleUbisoft,
    hostEa,
    bottleEa,
    hostBnet,
    bottleBnet,
    hostRockstar,
    bottleRockstar,
    hostRiot,
  ] = await Promise.all([
    probePublisherTargetAsync('host_ubisoft', 'ubisoft', 'host', hostPlatform === 'win32'),
    probePublisherTargetAsync('bottle_ubisoft', 'ubisoft', 'bottle', hostPlatform === 'darwin'),
    probePublisherTargetAsync('host_ea', 'ea', 'host', hostPlatform === 'win32', {
      allowMacNativeDiscovery: true,
    }),
    probePublisherTargetAsync('bottle_ea', 'ea', 'bottle', hostPlatform === 'darwin'),
    probePublisherTargetAsync(
      'host_bnet',
      'bnet',
      'host',
      hostPlatform === 'win32' || hostPlatform === 'darwin'
    ),
    probePublisherTargetAsync('bottle_bnet', 'bnet', 'bottle', hostPlatform === 'darwin'),
    probePublisherTargetAsync('host_rockstar', 'rockstar', 'host', hostPlatform === 'win32'),
    probePublisherTargetAsync('bottle_rockstar', 'rockstar', 'bottle', hostPlatform === 'darwin'),
    probePublisherTargetAsync('host_riot', 'riot', 'host', hostPlatform === 'win32', {
      allowMacNativeDiscovery: true,
    }),
  ]);

  const cleanProbeState = (/** @type {any} */ st) => {
    const { _steamId64, _version, ...pub } = st;
    return pub;
  };

  return {
    host_steam: cleanProbeState(hostSteam),
    bottle_steam: cleanProbeState(bottleSteam),
    host_gog: hostGog,
    bottle_gog: bottleGog,
    host_epic: hostEpic,
    bottle_epic: bottleEpic,
    host_ubisoft: cleanProbeState(hostUbisoft),
    bottle_ubisoft: cleanProbeState(bottleUbisoft),
    host_ea: cleanProbeState(hostEa),
    bottle_ea: cleanProbeState(bottleEa),
    host_bnet: cleanProbeState(hostBnet),
    bottle_bnet: cleanProbeState(bottleBnet),
    host_rockstar: cleanProbeState(hostRockstar),
    bottle_rockstar: cleanProbeState(bottleRockstar),
    host_riot: cleanProbeState(hostRiot),
  };
}

/**
 * Discover non-secret local store sessions for unconnected storefronts (`localStoreHints`).
 * Strictly read-only and never exposes tokens or credentials.
 *
 * @param {'darwin' | 'win32' | 'linux'} hostPlatform
 * @param {string} homedir
 * @param {string} userDataDir
 * @param {StorefrontId[]} connectedStorefronts
 * @param {Record<ClientLoginTargetId, ClientAuthProbeState>} clientLogins
 * @param {string} [activeBottlePath]
 * @param {Record<string, any>} [options]
 * @returns {Promise<DiscoveredLocalStoreHint[]>}
 */
async function discoverLocalStoreHints(
  hostPlatform,
  homedir,
  userDataDir,
  connectedStorefronts,
  clientLogins,
  activeBottlePath = '',
  options = {}
) {
  /** @type {DiscoveredLocalStoreHint[]} */
  const hints = [];

  // 1. Steam hint from local loginusers.vdf
  if (!connectedStorefronts.includes('steam')) {
    const steamVdfCandidates = [
      {
        label: hostPlatform === 'darwin' ? 'Steam (macOS)' : 'Steam Desktop Client',
        vdfPath:
          hostPlatform === 'darwin'
            ? path.join(homedir, 'Library/Application Support/Steam/config/loginusers.vdf')
            : hostPlatform === 'win32'
              ? clientLogins.host_steam.binaryPath
                ? path.join(
                    path.dirname(clientLogins.host_steam.binaryPath),
                    'config/loginusers.vdf'
                  )
                : path.join(homedir, 'Program Files (x86)/Steam/config/loginusers.vdf')
              : path.join(homedir, '.local/share/Steam/config/loginusers.vdf'),
      },
      ...(hostPlatform === 'darwin' && activeBottlePath
        ? [
            {
              label: 'Windows Steam (Inside Bottle)',
              vdfPath: path.join(
                activeBottlePath,
                'drive_c/Program Files (x86)/Steam/config/loginusers.vdf'
              ),
            },
          ]
        : []),
    ];

    for (const cand of steamVdfCandidates) {
      if (!cand.vdfPath) continue;
      try {
        const vdfText = await fs.promises.readFile(cand.vdfPath, 'utf8');
        const active = parseSteamLoginUsersVdfDetails(vdfText);
        if (active && active.steamId64) {
          hints.push({
            storefrontId: 'steam',
            sourceLabel: cand.label,
            hasReusableSession: true,
            ...(active.personaName ? { publicHandleHint: active.personaName } : {}),
            publicSteamId: active.steamId64,
          });
          break;
        }
      } catch {}
    }
  }

  // 2. Epic hint from local legendary / Heroic user.json
  if (
    !connectedStorefronts.includes('epic') &&
    !isStoreDisconnectedTombstoned('epic', userDataDir)
  ) {
    const epicCandidates = [
      {
        label: 'Local Legendary CLI Session',
        filePath: path.join(homedir, '.config/legendary/user.json'),
      },
      {
        label: 'Heroic Games Launcher (Epic)',
        filePath: path.join(
          homedir,
          'Library/Application Support/heroic/legendaryConfig/legendary/user.json'
        ),
      },
      {
        label: 'Heroic Games Launcher (Epic)',
        filePath: path.join(
          !options.homedir && process.env.APPDATA
            ? process.env.APPDATA
            : path.join(homedir, 'AppData/Roaming'),
          'heroic/legendaryConfig/legendary/user.json'
        ),
      },
    ];
    let foundEpicHint = false;
    for (const cand of epicCandidates) {
      try {
        const parsed = JSON.parse(await fs.promises.readFile(cand.filePath, 'utf8'));
        const tok = String(parsed?.access_token || parsed?.refresh_token || '').trim();
        if (
          tok &&
          !isMockOrCorruptedToken(tok) &&
          !isPoisonedStorefrontToken(tok, options)
        ) {
          const handle = String(
            parsed.displayName || parsed.display_name || parsed.account_id || ''
          ).trim();
          hints.push({
            storefrontId: 'epic',
            sourceLabel: cand.label,
            hasReusableSession: true,
            ...(handle ? { publicHandleHint: handle } : {}),
          });
          foundEpicHint = true;
          break;
        }
      } catch {}
    }
    if (
      !foundEpicHint &&
      (clientLogins.host_epic.authenticated || clientLogins.bottle_epic.authenticated)
    ) {
      const epicLogin = clientLogins.host_epic.authenticated
        ? clientLogins.host_epic
        : clientLogins.bottle_epic;
      hints.push({
        storefrontId: 'epic',
        sourceLabel: epicLogin.label,
        hasReusableSession: false,
        ...(epicLogin.detectedAccountLabel
          ? { publicHandleHint: epicLogin.detectedAccountLabel }
          : {}),
      });
    }
  }

  // 3. GOG hint from Heroic / local gogdl auth.json or GOG Galaxy
  if (
    !connectedStorefronts.includes('gog') &&
    !isStoreDisconnectedTombstoned('gog', userDataDir)
  ) {
    const gogCandidates = [
      {
        label: 'Heroic Games Launcher (GOG)',
        filePath: path.join(homedir, 'Library/Application Support/heroic/gog_store/auth.json'),
      },
      {
        label: 'Heroic Games Launcher (GOG)',
        filePath: path.join(
          !options.homedir && process.env.APPDATA
            ? process.env.APPDATA
            : path.join(homedir, 'AppData/Roaming'),
          'heroic/gog_store/auth.json'
        ),
      },
      {
        label: 'Heroic Games Launcher (GOG)',
        filePath: path.join(homedir, '.config/heroic/gog_store/auth.json'),
      },
      {
        label: 'Local gogdl Session',
        filePath: path.join(userDataDir, 'gogdlConfig/auth.json'),
      },
    ];
    let foundGogHint = false;
    for (const cand of gogCandidates) {
      try {
        const parsed = JSON.parse(await fs.promises.readFile(cand.filePath, 'utf8'));
        const entry = parsed?.['46899977096215655'] || parsed;
        const tok = String(entry?.access_token || entry?.refresh_token || '').trim();
        if (
          tok &&
          !isMockOrCorruptedToken(tok) &&
          !isPoisonedStorefrontToken(tok, options)
        ) {
          const handle = String(entry.username || entry.user_id || entry.userId || '').trim();
          hints.push({
            storefrontId: 'gog',
            sourceLabel: cand.label,
            hasReusableSession: true,
            ...(handle ? { publicHandleHint: handle } : {}),
          });
          foundGogHint = true;
          break;
        }
      } catch {}
    }
    if (
      !foundGogHint &&
      (clientLogins.host_gog.authenticated || clientLogins.bottle_gog.authenticated)
    ) {
      const gogLogin = clientLogins.host_gog.authenticated
        ? clientLogins.host_gog
        : clientLogins.bottle_gog;
      hints.push({
        storefrontId: 'gog',
        sourceLabel: gogLogin.label,
        hasReusableSession: false,
        ...(gogLogin.detectedAccountLabel
          ? { publicHandleHint: gogLogin.detectedAccountLabel }
          : {}),
      });
    }
  }

  return hints;
}

module.exports = {
  parseSteamLoginUsersVdfDetails,
  readGogGalaxyDbUserReadOnly,
  parseWineGogRegistryUser,
  parseEpicGameUserSettingsIni,
  probeClientLoginStates,
  discoverLocalStoreHints,
};
