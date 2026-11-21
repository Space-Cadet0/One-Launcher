// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const {
  atomicWriteFileSync,
  isContainedWithinRoot,
  resolveHostWindowsKnownFolders,
} = require('../securityAndPathUtils.cjs');
const { readWinePrefixShellFolders } = require('../wineAndCrossOverManager.cjs');
const {
  inspectMicrosoftGameConfig,
  inspectAppxManifest,
} = require('../binaryAndManifestInspectors.cjs');
const { formatWgsUserScidFolderName } = require('../../storefronts/xbox/xboxTitleStorageSync.cjs');
const {
  MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES,
  MAX_GOG_PRODUCT_CLIENT_ID_CACHE_ENTRIES,
  BENIGN_CLOUD_SYNC_SKIP_REASONS,
  withCloudManifestFileLock,
  atomicWriteFileAsync,
  resolveIsolatedDefaultHomedir,
  sanitizeGogGameClientId,
  isSafeGogLocationName,
  verifySavePathRealContainmentSync,
} = require('./oneDriveAndPathGuards.cjs');

/** @type {WeakMap<object, { normalizedAnchor: string, containmentPlatform: string }>} */
const gogLocationAnchorByEntry = new WeakMap();

/** @type {Map<string, { normalizedAnchor: string, containmentPlatform: string }>} */
const epicAnchorByResolvedPath = new Map();
const MAX_EPIC_ANCHOR_CACHE_ENTRIES = 128;

/**
 * Retrieve the recorded placeholder anchor metadata for a resolved GOG location object
 * without adding extra enumerable keys to the public `{ name, location, resolvedPath }` shape.
 *
 * @param {any} locEntry
 * @returns {{ normalizedAnchor: string, containmentPlatform: string } | null}
 */
function getResolvedGogLocationAnchor(locEntry) {
  if (!locEntry || typeof locEntry !== 'object') return null;
  return gogLocationAnchorByEntry.get(locEntry) || null;
}

/**
 * Retrieve the recorded placeholder anchor metadata for a resolved Epic save path string.
 *
 * @param {string} resolvedPath
 * @returns {{ normalizedAnchor: string, containmentPlatform: string } | null}
 */
function getResolvedEpicPathAnchor(resolvedPath) {
  if (!resolvedPath || typeof resolvedPath !== 'string') return null;
  return epicAnchorByResolvedPath.get(resolvedPath) || null;
}

/**
 * @param {string} rawExpanded
 * @param {string} targetPlatform
 * @param {boolean} useCompatLayer
 * @returns {string}
 */
function normalizeResolvedCloudSavePath(rawExpanded, targetPlatform, useCompatLayer) {
  if (!rawExpanded || typeof rawExpanded !== 'string') return '';
  if (
    targetPlatform === 'win32' &&
    !useCompatLayer &&
    (process.platform === 'win32' ||
      /^[A-Za-z]:[\\/]/.test(rawExpanded) ||
      rawExpanded.startsWith('\\\\'))
  ) {
    const winNorm = path.win32.normalize(rawExpanded.replace(/\//g, '\\'));
    return /^[A-Za-z]:\\$/.test(winNorm) || winNorm === '\\'
      ? winNorm
      : winNorm.replace(/\\+$/, '');
  }
  if (process.platform !== 'win32') {
    const converted = rawExpanded.replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(converted)) {
      const winPosix = path.win32
        .normalize(rawExpanded.replace(/\//g, '\\'))
        .replace(/\\/g, '/');
      return /^[A-Za-z]:\/$/.test(winPosix) ? winPosix : winPosix.replace(/\/+$/, '');
    }
    const posixNorm = path.posix.normalize(converted);
    return posixNorm === '/' ? posixNorm : posixNorm.replace(/\/+$/, '');
  }
  const hostNorm = path.normalize(rawExpanded);
  return /^[A-Za-z]:\\$/.test(hostNorm) || hostNorm === '/' || hostNorm === '\\'
    ? hostNorm
    : hostNorm.replace(/[\\/]+$/, '');
}

/**
 * Resolve GOG remote-config cloudStorage locations across Windows (honoring OneDrive Known Folder
 * redirection), macOS native, and Wine/CrossOver bottles, enforcing strict lexical AND
 * `lstat` + `realpath` symlink/junction anchor-root containment and CLI flag-injection guards.
 *
 * @param {Array<Record<string, any>>} locations
 * @param {Record<string, any>} [context]
 * @returns {Array<{ name: string, location: string, resolvedPath: string }>}
 */
function resolveGogCloudSaveLocations(locations, context = {}) {
  if (!Array.isArray(locations) || locations.length === 0) return [];

  const targetPlatform = context.platform || process.platform;
  const useCompatLayer = Boolean(context.useCompatLayer);
  const homedir = context.homedir || os.homedir();
  const installPath = context.installPath ? String(context.installPath) : '';

  /** @type {Record<string, string>} */
  let placeholderMap;
  if (useCompatLayer) {
    if (!context.winePrefix || !String(context.winePrefix).trim()) {
      diagLog.warn(
        'cloudSave.gogMissingWinePrefixBlocked',
        'Blocked GOG cloud save path resolution under compatibility layer without winePrefix',
        { platform: targetPlatform, locationCount: locations.length }
      );
      return [];
    }
    const shell = readWinePrefixShellFolders(context.winePrefix);
    placeholderMap = {
      INSTALL: installPath,
      DOCUMENTS: shell.documents,
      SAVED_GAMES: shell.savedGames,
      APPLICATION_DATA_LOCAL: shell.appDataLocal,
      LOCAL_APPLICATION_DATA: shell.appDataLocal,
      APPLICATION_DATA_LOCAL_LOW: shell.appDataLocalLow,
      APPLICATION_DATA_ROAMING: shell.appDataRoaming,
      APPLICATION_DATA: shell.appDataRoaming,
      APPLICATION_SUPPORT: shell.appDataLocal,
      HOME: shell.userProfile,
    };
  } else if (targetPlatform === 'win32') {
    const winKnown = resolveHostWindowsKnownFolders({
      homedir,
      windowsKnownFolders: context.windowsKnownFolders,
      windowsRegistryOutput: context.windowsRegistryOutput,
      env: context.env,
    });
    placeholderMap = {
      INSTALL: installPath,
      DOCUMENTS: winKnown.documents,
      SAVED_GAMES: winKnown.savedGames,
      APPLICATION_DATA_LOCAL: winKnown.localAppData,
      LOCAL_APPLICATION_DATA: winKnown.localAppData,
      APPLICATION_DATA_LOCAL_LOW: winKnown.localLowAppData,
      APPLICATION_DATA_ROAMING: winKnown.roamingAppData,
      APPLICATION_DATA: winKnown.roamingAppData,
      APPLICATION_SUPPORT: winKnown.localAppData,
      HOME: winKnown.homedir,
    };
  } else {
    const macAppSupport = path.join(homedir, 'Library', 'Application Support');
    placeholderMap = {
      INSTALL: installPath,
      DOCUMENTS: path.join(homedir, 'Documents'),
      SAVED_GAMES: path.join(homedir, 'Saved Games'),
      APPLICATION_DATA_LOCAL: macAppSupport,
      LOCAL_APPLICATION_DATA: macAppSupport,
      APPLICATION_DATA_LOCAL_LOW: macAppSupport,
      APPLICATION_DATA_ROAMING: macAppSupport,
      APPLICATION_DATA: macAppSupport,
      APPLICATION_SUPPORT: macAppSupport,
      HOME: homedir,
    };
  }

  /** @type {Array<{ name: string, location: string, resolvedPath: string }>} */
  const resolvedList = [];
  for (const loc of locations) {
    if (!loc || typeof loc.location !== 'string' || !loc.location.trim()) continue;
    const rawTemplate = loc.location.trim();
    if (rawTemplate.includes('\0')) continue;

    const locationName = loc.name ? String(loc.name).trim() : '__default';
    if (locationName !== '__default' && !isSafeGogLocationName(locationName)) {
      diagLog.warn(
        'cloudSave.gogUnsafeLocationNameBlocked',
        'Blocked GOG cloud save location with unsafe CLI flag or path characters in name',
        { name: locationName, location: rawTemplate }
      );
      continue;
    }

    // Require a valid leading root placeholder token (`<?TOKEN?>`)
    let effectiveTemplate = rawTemplate;
    let anchorTokenName = '';

    if (
      /^<\?APPLICATION_DATA_LOCAL\?>[\\/]+\.\.[\\/]+LocalLow(?:[\\/]|$)/i.test(effectiveTemplate)
    ) {
      anchorTokenName = 'APPLICATION_DATA_LOCAL_LOW';
      effectiveTemplate = effectiveTemplate.replace(
        /^<\?APPLICATION_DATA_LOCAL\?>[\\/]+\.\.[\\/]+LocalLow/i,
        '<?APPLICATION_DATA_LOCAL_LOW?>'
      );
    } else if (
      /^<\?APPLICATION_DATA_LOCAL\?>[\\/]+\.\.[\\/]+Roaming(?:[\\/]|$)/i.test(effectiveTemplate)
    ) {
      anchorTokenName = 'APPLICATION_DATA_ROAMING';
      effectiveTemplate = effectiveTemplate.replace(
        /^<\?APPLICATION_DATA_LOCAL\?>[\\/]+\.\.[\\/]+Roaming/i,
        '<?APPLICATION_DATA_ROAMING?>'
      );
    } else {
      const rootMatch = effectiveTemplate.match(/^<\?([A-Z0-9_]+)\?>(?:[\\/]|$)/i);
      if (!rootMatch) {
        diagLog.warn(
          'cloudSave.gogMissingRootPlaceholder',
          'Rejected GOG cloud save location without valid leading placeholder token',
          { location: rawTemplate }
        );
        continue;
      }
      anchorTokenName = String(rootMatch[1] || '').toUpperCase();
    }

    if (anchorTokenName === 'INSTALL' && !installPath) {
      continue;
    }

    const rawAnchorRoot = placeholderMap[anchorTokenName];
    if (!rawAnchorRoot) {
      continue;
    }

    let missingToken = false;
    const expanded = effectiveTemplate.replace(/<\?([A-Z0-9_]+)\?>/gi, (full, tokenName) => {
      const upper = String(tokenName || '').toUpperCase();
      if (Object.prototype.hasOwnProperty.call(placeholderMap, upper) && placeholderMap[upper]) {
        return placeholderMap[upper];
      }
      missingToken = true;
      return full;
    });

    if (missingToken || /<\?[^?]+\?>/.test(expanded)) continue;
    const normalizedAnchor = normalizeResolvedCloudSavePath(
      rawAnchorRoot,
      targetPlatform,
      useCompatLayer
    );
    const resolvedPath = normalizeResolvedCloudSavePath(
      expanded,
      targetPlatform,
      useCompatLayer
    );
    if (!normalizedAnchor || !resolvedPath) continue;

    const containmentPlatform =
      /^[A-Za-z]:[\\/]/.test(normalizedAnchor) || normalizedAnchor.startsWith('\\\\')
        ? 'win32'
        : 'posix';

    const containment = verifySavePathRealContainmentSync(
      normalizedAnchor,
      resolvedPath,
      containmentPlatform
    );
    if (!containment.ok) {
      diagLog.warn(
        'cloudSave.gogPathTraversalBlocked',
        'Blocked GOG cloud save location escaping placeholder root',
        {
          location: rawTemplate,
          normalizedAnchor,
          resolvedPath,
          reason: containment.reason,
        }
      );
      continue;
    }

    const entry = {
      name: locationName,
      location: rawTemplate,
      resolvedPath,
    };
    gogLocationAnchorByEntry.set(entry, { normalizedAnchor, containmentPlatform });
    resolvedList.push(entry);
  }

  return resolvedList;
}

/**
 * Expand Epic Games CloudSaveFolder / CloudSaveFolder_MAC templates across Windows (honoring
 * OneDrive Known Folder redirection), macOS, and Wine/CrossOver bottles with strict lexical
 * AND `lstat` + `realpath` symlink/junction path containment.
 *
 * @param {string} template
 * @param {Record<string, any>} [context]
 * @returns {string}
 */
function resolveEpicSavePathTemplate(template, context = {}) {
  if (!template || typeof template !== 'string' || !template.trim()) return '';
  const rawTrimmed = template.trim();
  if (rawTrimmed.includes('\0')) return '';

  const targetPlatform = context.platform || process.platform;
  const useCompatLayer = Boolean(context.useCompatLayer);
  const homedir = context.homedir || os.homedir();
  const installPath = context.installPath ? String(context.installPath) : '';
  const epicAccountId = context.epicAccountId ? String(context.epicAccountId) : '';

  if (epicAccountId && (/[\\/]/.test(epicAccountId) || epicAccountId.includes('..'))) {
    diagLog.warn('cloudSave.invalidEpicAccountId', 'Rejected unsafe Epic account ID segment', {
      epicAccountId,
    });
    return '';
  }

  let userDir;
  let userProfile;
  let appData;
  let appDataLocalLow;
  let appDataRoaming;
  let userSavedGames;
  let userLibrary;

  if (useCompatLayer) {
    if (!context.winePrefix || !String(context.winePrefix).trim()) {
      userDir = '';
      userProfile = '';
      appData = '';
      appDataLocalLow = '';
      appDataRoaming = '';
      userSavedGames = '';
      userLibrary = '';
    } else {
      const shell = readWinePrefixShellFolders(context.winePrefix);
      userDir = shell.documents;
      userProfile = shell.userProfile;
      appData = shell.appDataLocal;
      appDataLocalLow = shell.appDataLocalLow;
      appDataRoaming = shell.appDataRoaming;
      userSavedGames = shell.savedGames;
      userLibrary = shell.appDataLocal;
    }
  } else if (targetPlatform === 'win32') {
    const winKnown = resolveHostWindowsKnownFolders({
      homedir,
      windowsKnownFolders: context.windowsKnownFolders,
      windowsRegistryOutput: context.windowsRegistryOutput,
      env: context.env,
    });
    userDir = winKnown.documents;
    userProfile =
      context.windowsKnownFolders?.userProfile ||
      (context.homedir ? winKnown.homedir : context.env?.USERPROFILE || winKnown.homedir);
    appData = winKnown.localAppData;
    appDataLocalLow = winKnown.localLowAppData;
    appDataRoaming = winKnown.roamingAppData;
    userSavedGames = winKnown.savedGames;
    userLibrary = winKnown.localAppData;
  } else {
    userDir = path.join(homedir, 'Documents');
    userProfile = homedir;
    appData = path.join(homedir, 'Library', 'Application Support');
    appDataLocalLow = appData;
    appDataRoaming = appData;
    userSavedGames = path.join(homedir, 'Saved Games');
    userLibrary = path.join(homedir, 'Library');
  }

  /** @type {Record<string, string>} */
  const rootTokenMap = {
    USERDIR: userDir,
    USERPROFILE: userProfile,
    APPDATA: appData,
    LOCALAPPDATA: appData,
    APPDATALOCALLOW: appDataLocalLow,
    ROAMINGAPPDATA: appDataRoaming,
    USERSAVEDGAMES: userSavedGames,
    USERLIBRARY: userLibrary,
    INSTALLDIR: installPath,
  };

  let effectiveTemplate = rawTrimmed;
  let anchorKey = '';
  let rewrittenDarwinAppDataParent = false;

  if (/^\{AppData\}[\\/]+\.\.[\\/]+LocalLow(?:[\\/]|$)/i.test(effectiveTemplate)) {
    anchorKey = 'APPDATALOCALLOW';
    effectiveTemplate = effectiveTemplate.replace(
      /^\{AppData\}[\\/]+\.\.[\\/]+LocalLow/i,
      '{AppDataLocalLow}'
    );
  } else if (/^\{AppData\}[\\/]+\.\.[\\/]+Roaming(?:[\\/]|$)/i.test(effectiveTemplate)) {
    anchorKey = 'ROAMINGAPPDATA';
    effectiveTemplate = effectiveTemplate.replace(
      /^\{AppData\}[\\/]+\.\.[\\/]+Roaming/i,
      '{RoamingAppData}'
    );
  } else if (
    targetPlatform === 'darwin' &&
    !useCompatLayer &&
    /^\{AppData\}[\\/]+\.\.(?:[\\/]+|$)/i.test(effectiveTemplate)
  ) {
    anchorKey = 'USERLIBRARY';
    rewrittenDarwinAppDataParent = true;
    effectiveTemplate = effectiveTemplate.replace(
      /^\{AppData\}[\\/]+\.\.(?:[\\/]+|$)/i,
      '{UserLibrary}/'
    );
  } else {
    const leadMatch = effectiveTemplate.match(/^\{([A-Za-z0-9_]+)\}(?:[\\/]|$)/);
    if (!leadMatch) {
      diagLog.warn(
        'cloudSave.epicMissingRootPlaceholder',
        'Rejected Epic save path template without valid leading placeholder token',
        { template: rawTrimmed }
      );
      return '';
    }
    anchorKey = String(leadMatch[1] || '').toUpperCase();
  }

  const rawAnchorRoot = rootTokenMap[anchorKey];
  if (!rawAnchorRoot) {
    return '';
  }

  let unresolved = false;
  const expanded = effectiveTemplate.replace(/\{([^}]+)\}/g, (full, tokenName) => {
    const upper = String(tokenName || '').trim().toUpperCase();
    if (upper === 'EPICID') {
      if (!epicAccountId) {
        unresolved = true;
        return full;
      }
      return epicAccountId;
    }
    if (Object.prototype.hasOwnProperty.call(rootTokenMap, upper) && rootTokenMap[upper]) {
      return rootTokenMap[upper];
    }
    unresolved = true;
    return full;
  });

  if (unresolved || /\{[^}]+\}/.test(expanded)) {
    return '';
  }

  const normalizedAnchor = normalizeResolvedCloudSavePath(
    rawAnchorRoot,
    targetPlatform,
    useCompatLayer
  );
  const resolvedPath = normalizeResolvedCloudSavePath(
    expanded,
    targetPlatform,
    useCompatLayer
  );
  if (!normalizedAnchor || !resolvedPath) return '';

  if (rewrittenDarwinAppDataParent && resolvedPath === normalizedAnchor) {
    diagLog.warn(
      'cloudSave.epicPathTraversalBlocked',
      'Blocked Epic save path template pointing directly at macOS Library root via {AppData}/..',
      { template: rawTrimmed, normalizedAnchor, resolvedPath }
    );
    return '';
  }

  const containmentPlatform =
    /^[A-Za-z]:[\\/]/.test(normalizedAnchor) || normalizedAnchor.startsWith('\\\\')
      ? 'win32'
      : 'posix';

  const containment = verifySavePathRealContainmentSync(
    normalizedAnchor,
    resolvedPath,
    containmentPlatform
  );
  if (!containment.ok) {
    diagLog.warn(
      'cloudSave.epicPathTraversalBlocked',
      'Blocked Epic save path template escaping placeholder root',
      {
        template: rawTrimmed,
        normalizedAnchor,
        resolvedPath,
        reason: containment.reason,
      }
    );
    return '';
  }

  if (epicAnchorByResolvedPath.size >= MAX_EPIC_ANCHOR_CACHE_ENTRIES) {
    const oldestKey = epicAnchorByResolvedPath.keys().next().value;
    if (oldestKey !== undefined) {
      epicAnchorByResolvedPath.delete(oldestKey);
    }
  }
  epicAnchorByResolvedPath.set(resolvedPath, { normalizedAnchor, containmentPlatform });

  return resolvedPath;
}

/**
 * Verify that an Epic `CloudSaveFolder` template is structurally safe (starts with a known
 * root placeholder and cannot escape it via `..`) even before `{EpicID}` or `{InstallDir}` is known.
 *
 * @param {string} template
 * @returns {boolean}
 */
function isSafeEpicSaveTemplateSyntax(template) {
  if (!template || typeof template !== 'string' || !template.trim()) return false;
  const probe = resolveEpicSavePathTemplate(template, {
    platform: 'darwin',
    useCompatLayer: false,
    homedir: '/probe_home',
    installPath: '/probe_install',
    epicAccountId: 'probe_epic_account_id',
  });
  return Boolean(probe);
}

/**
 * Resolves Xbox / GDK Connected Storage (`wgs`) and title save (`xgs`) locations across
 * Windows native (`%LOCALAPPDATA%\Packages\<PFN>\SystemAppData\wgs`) and macOS Wine/CrossOver bottles,
 * enforcing strict lexical and `lstat` + `realpath` symlink/junction containment.
 *
 * @param {Record<string, any>} [payload]
 * @param {Record<string, any>} [context]
 */
function resolveXboxSaveLocations(payload = {}, context = {}) {
  const targetPlatform = context.platform || process.platform;
  const winePrefix = String(
    context.winePrefix || payload.winePrefix || context.bottlePath || payload.bottlePath || ''
  ).trim();
  const useCompatLayer = Boolean(
    context.useCompatLayer || payload.useCompatLayer || winePrefix
  );
  const homedir = resolveIsolatedDefaultHomedir(
    context.homedir ? context : payload.homedir ? payload : context
  );

  let packageFamilyName = String(payload.packageFamilyName || '').trim();
  let scid = String(payload.scid || '').trim().toLowerCase();
  let fallbackScid = String(payload.fallbackScid || context.fallbackScid || '')
    .trim()
    .toLowerCase();
  let msaAppId = String(payload.msaAppId || context.msaAppId || '').trim();
  let titleId = String(
    payload.xboxTitleId || payload.titleId || context.xboxTitleId || context.titleId || ''
  ).trim();
  const installPath = String(payload.installPath || context.installPath || '').trim();
  if (
    (!packageFamilyName ||
      !scid ||
      !fallbackScid ||
      !msaAppId ||
      !titleId ||
      /^\d{9,}$/.test(titleId)) &&
    installPath
  ) {
    try {
      const cfg = inspectMicrosoftGameConfig(installPath);
      if (cfg) {
        if (!packageFamilyName && cfg.packageFamilyName) {
          packageFamilyName = cfg.packageFamilyName;
        }
        if (!scid && cfg.scid) {
          scid = String(cfg.scid).trim().toLowerCase();
        }
        if (!fallbackScid) {
          const cfgPrimaryScid = String(cfg.scid || '').trim().toLowerCase();
          const cfgFallbackScid = String(cfg.fallbackScid || '').trim().toLowerCase();
          if (cfgPrimaryScid && scid && cfgPrimaryScid !== scid) {
            fallbackScid = cfgPrimaryScid;
          } else if (cfgFallbackScid && cfgFallbackScid !== scid) {
            fallbackScid = cfgFallbackScid;
          }
        }
        if (!msaAppId && cfg.msaAppId) {
          msaAppId = String(cfg.msaAppId).trim();
        }
        if (
          cfg.titleId &&
          (!titleId || (/^\d{9,}$/.test(titleId) && /^[0-9A-Fa-f]{1,8}$/.test(cfg.titleId)))
        ) {
          titleId = String(cfg.titleId).trim();
        }
      } else {
        const appx = inspectAppxManifest(installPath);
        if (appx && !packageFamilyName && appx.packageFamilyName) {
          packageFamilyName = appx.packageFamilyName;
        }
      }
    } catch {}
  }

  if (
    !packageFamilyName ||
    packageFamilyName.includes('..') ||
    /[\\/:*?"<>|\0]/.test(packageFamilyName)
  ) {
    return null;
  }

  let localAppData = '';
  if (typeof context.localAppData === 'string' && context.localAppData.trim()) {
    localAppData = context.localAppData.trim();
  } else if (useCompatLayer && winePrefix) {
    const shell = readWinePrefixShellFolders(winePrefix);
    localAppData = shell.appDataLocal || '';
  } else if (targetPlatform === 'win32') {
    const winKnown = resolveHostWindowsKnownFolders({
      homedir,
      windowsKnownFolders: context.windowsKnownFolders,
      windowsRegistryOutput: context.windowsRegistryOutput,
      env: context.env,
    });
    localAppData = winKnown.localAppData || '';
  }

  if (!localAppData) return null;

  const useWinJoin =
    !useCompatLayer && targetPlatform === 'win32' && /^[A-Za-z]:[\\/]/.test(localAppData);
  const pJoin = useWinJoin ? path.win32.join : path.join;
  const containmentPlatform =
    /^[A-Za-z]:[\\/]/.test(localAppData) || localAppData.startsWith('\\\\') ? 'win32' : 'posix';

  const packageRootDir = pJoin(localAppData, 'Packages', packageFamilyName);
  const systemAppDataDir = pJoin(packageRootDir, 'SystemAppData');
  const wgsRootDir = pJoin(systemAppDataDir, 'wgs');
  const xgsRootDir = pJoin(systemAppDataDir, 'xgs');
  const localStateDir = pJoin(packageRootDir, 'LocalState');

  if (!verifySavePathRealContainmentSync(localAppData, wgsRootDir, containmentPlatform).ok) {
    diagLog.warn(
      'cloudSave.xboxSavePathContainmentBlocked',
      'Blocked Xbox WGS save root escaping LocalAppData via traversal or symlink',
      { packageFamilyName, localAppData, wgsRootDir }
    );
    return null;
  }

  let wgsUserDir = '';
  let xgsUserDir = '';
  const xuid = String(payload.xuid || context.xuid || '').trim();
  if (xuid && scid) {
    try {
      const folderName = formatWgsUserScidFolderName(xuid, scid);
      if (folderName && !folderName.includes('..') && !/[\\/\0]/.test(folderName)) {
        const candidateWgs = pJoin(wgsRootDir, folderName);
        const candidateXgs = pJoin(xgsRootDir, folderName);
        if (
          isContainedWithinRoot(wgsRootDir, candidateWgs, containmentPlatform) &&
          verifySavePathRealContainmentSync(localAppData, candidateWgs, containmentPlatform).ok
        ) {
          wgsUserDir = candidateWgs;
          xgsUserDir = candidateXgs;
        }
      }
    } catch {}
  }

  return {
    packageFamilyName,
    scid,
    ...(fallbackScid ? { fallbackScid } : {}),
    msaAppId,
    titleId,
    localAppData,
    packageRootDir,
    systemAppDataDir,
    wgsRootDir,
    xgsRootDir,
    localStateDir,
    wgsUserDir,
    xgsUserDir,
  };
}

/**
 * Prune `one_launcher_gog_cloud_configs.json` map to at most `maxEntries` (default 250) by LRU,
 * while preserving sanitized `__productClientIds` (capped at 500 entries) so cached per-game
 * GOG client IDs are never evicted as remote-config entries or poisoned with Galaxy's launcher ID.
 *
 * @param {Record<string, any>} cachedMap
 * @param {number} [maxEntries]
 * @returns {Record<string, any>}
 */
function pruneGogCloudConfigsMap(cachedMap, maxEntries = MAX_GOG_CLOUD_CONFIG_CACHE_ENTRIES) {
  if (!cachedMap || typeof cachedMap !== 'object') return {};

  let sanitizedProductIds = null;
  if (
    cachedMap.__productClientIds &&
    typeof cachedMap.__productClientIds === 'object' &&
    !Array.isArray(cachedMap.__productClientIds)
  ) {
    const validPairs = Object.entries(cachedMap.__productClientIds)
      .map(([prodId, rawClientId]) => [
        String(prodId || '').trim(),
        sanitizeGogGameClientId(rawClientId),
      ])
      .filter(([prodId, cid]) => Boolean(prodId && cid));
    const cappedPairs =
      validPairs.length > MAX_GOG_PRODUCT_CLIENT_ID_CACHE_ENTRIES
        ? validPairs.slice(-MAX_GOG_PRODUCT_CLIENT_ID_CACHE_ENTRIES)
        : validPairs;
    sanitizedProductIds = Object.fromEntries(cappedPairs);
  }

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  let sanitizedNoCloudIds = null;
  if (
    cachedMap.__noCloudProductIds &&
    typeof cachedMap.__noCloudProductIds === 'object' &&
    !Array.isArray(cachedMap.__noCloudProductIds)
  ) {
    const nowTs = Date.now();
    const validNegPairs = Object.entries(cachedMap.__noCloudProductIds)
      .map(
        ([prodId, rawTs]) =>
          /** @type {[string, number]} */ ([String(prodId || '').trim(), Number(rawTs)])
      )
      .filter(
        ([prodId, tsNum]) =>
          Boolean(prodId) && Number.isFinite(tsNum) && tsNum > 0 && nowTs - tsNum < SEVEN_DAYS_MS
      );
    const cappedNegPairs =
      validNegPairs.length > MAX_GOG_PRODUCT_CLIENT_ID_CACHE_ENTRIES
        ? validNegPairs.slice(-MAX_GOG_PRODUCT_CLIENT_ID_CACHE_ENTRIES)
        : validNegPairs;
    if (cappedNegPairs.length > 0) {
      sanitizedNoCloudIds = Object.fromEntries(cappedNegPairs);
    }
  }

  const entries = Object.entries(cachedMap).filter(
    ([k, v]) =>
      k &&
      k !== '__productClientIds' &&
      k !== '__noCloudProductIds' &&
      v &&
      typeof v === 'object' &&
      !Array.isArray(v)
  );

  /** @type {Record<string, any>} */
  const pruned = {};
  if (sanitizedProductIds) {
    pruned.__productClientIds = sanitizedProductIds;
  }
  if (sanitizedNoCloudIds) {
    pruned.__noCloudProductIds = sanitizedNoCloudIds;
  }

  if (entries.length <= maxEntries) {
    for (const [k, v] of entries) {
      pruned[k] = v;
    }
    return pruned;
  }

  entries.sort((a, b) => {
    const tsA = Number(a[1].lastAccessedAt || a[1].fetchedAt || 0);
    const tsB = Number(b[1].lastAccessedAt || b[1].fetchedAt || 0);
    return tsB - tsA;
  });
  for (const [k, v] of entries.slice(0, maxEntries)) {
    pruned[k] = v;
  }
  return pruned;
}

/**
 * Prune per-game sync timestamps (`one_launcher_cloud_sync_timestamps.json`) when uninstalling a game
 * so reinstalling the game later performs a clean cloud pull instead of skipping on a stale timestamp.
 *
 * @param {Record<string, any>} data
 * @param {string} platformId
 * @param {string} cleanId
 * @returns {boolean}
 */
function applyPruneCloudSaveTimestampsData(data, platformId, cleanId) {
  let modified = false;
  if (!data || typeof data !== 'object') return false;
  if ((!platformId || platformId === 'gog') && data.gog && typeof data.gog === 'object') {
    const prefix = `${cleanId}:`;
    for (const key of Object.keys(data.gog)) {
      if (key === cleanId || key.startsWith(prefix)) {
        delete data.gog[key];
        modified = true;
      }
    }
  }
  if (
    (!platformId || platformId === 'gog') &&
    data.gogLegacyMigrated &&
    typeof data.gogLegacyMigrated === 'object'
  ) {
    const prefix = `${cleanId}:`;
    for (const key of Object.keys(data.gogLegacyMigrated)) {
      if (key === cleanId || key.startsWith(prefix)) {
        delete data.gogLegacyMigrated[key];
        modified = true;
      }
    }
  }
  if ((!platformId || platformId === 'epic') && data.epic && typeof data.epic === 'object') {
    for (const key of Object.keys(data.epic)) {
      if (key === cleanId || key.startsWith(`${cleanId}:`)) {
        delete data.epic[key];
        modified = true;
      }
    }
  }
  if ((!platformId || platformId === 'xbox') && data.xbox && typeof data.xbox === 'object') {
    for (const key of Object.keys(data.xbox)) {
      if (key === cleanId || key.startsWith(`${cleanId}:`)) {
        delete data.xbox[key];
        modified = true;
      }
    }
  }
  return modified;
}

/**
 * @param {Record<string, any>} [payload]
 * @param {string} [userDataDir]
 * @returns {boolean}
 */
function pruneCloudSaveStateForGame(payload = {}, userDataDir) {
  if (!userDataDir || typeof userDataDir !== 'string') return false;
  const platformId = String(payload.platformId || '').toLowerCase();
  const cleanId = String(payload.platformGameId || payload.gameId || '')
    .replace(/^(epic|gog|steam|xbox)[-_]/i, '')
    .trim();
  if (!cleanId) return false;

  let modified = false;
  const timestampsPath = path.join(userDataDir, 'one_launcher_cloud_sync_timestamps.json');
  try {
    if (fs.existsSync(timestampsPath)) {
      const data = JSON.parse(fs.readFileSync(timestampsPath, 'utf8')) || {};
      modified = applyPruneCloudSaveTimestampsData(data, platformId, cleanId);
      if (modified) {
        atomicWriteFileSync(timestampsPath, JSON.stringify(data, null, 2));
      }
    }
  } catch (err) {
    diagLog.warn('cloudSave.pruneTimestampsOnUninstall', err, { cleanId, platformId });
  }
  return modified;
}

/**
 * Non-blocking asynchronous counterpart to `pruneCloudSaveStateForGame`, serialized
 * through `withCloudManifestFileLock` and persisted via `atomicWriteFileAsync`.
 *
 * @param {Record<string, any>} [payload]
 * @param {string} [userDataDir]
 * @returns {Promise<boolean>}
 */
async function pruneCloudSaveStateForGameAsync(payload = {}, userDataDir) {
  if (!userDataDir || typeof userDataDir !== 'string') return false;
  const platformId = String(payload.platformId || '').toLowerCase();
  const cleanId = String(payload.platformGameId || payload.gameId || '')
    .replace(/^(epic|gog|steam|xbox)[-_]/i, '')
    .trim();
  if (!cleanId) return false;

  const timestampsPath = path.join(userDataDir, 'one_launcher_cloud_sync_timestamps.json');
  return withCloudManifestFileLock(timestampsPath, async () => {
    let modified = false;
    try {
      let raw = '';
      try {
        raw = await fs.promises.readFile(timestampsPath, 'utf8');
      } catch (readErr) {
        if (String(/** @type {any} */ (readErr)?.code || '').toUpperCase() === 'ENOENT') {
          return false;
        }
        throw readErr;
      }
      const data = JSON.parse(raw) || {};
      modified = applyPruneCloudSaveTimestampsData(data, platformId, cleanId);
      if (modified) {
        await atomicWriteFileAsync(timestampsPath, JSON.stringify(data, null, 2));
      }
    } catch (err) {
      diagLog.warn('cloudSave.pruneTimestampsOnUninstallAsync', err, { cleanId, platformId });
    }
    return modified;
  });
}

/**
 * Build standardized Cloud Save Sync Telemetry event payload (`Point 5.3`).
 *
 * @param {{
 *   gameId?: string,
 *   platformId?: string,
 *   direction?: string,
 *   syncResult?: Record<string, any> | null,
 *   isSteam?: boolean,
 * }} params
 */
function buildCloudSyncTelemetryPayload({
  gameId,
  platformId,
  direction = 'post_exit',
  syncResult = null,
  isSteam = false,
}) {
  if (!gameId || !platformId || !syncResult || typeof syncResult !== 'object') {
    return null;
  }
  const timestamp = new Date().toISOString();
  const reason = syncResult.reason ? String(syncResult.reason) : '';

  if (isSteam) {
    if (syncResult.completed === false && reason === 'timeout') {
      return {
        gameId,
        platformId,
        status: 'cloud_sync_warning',
        event: 'cloud_sync_warning',
        cloudSync: {
          gameId,
          platformId,
          direction,
          synced: false,
          status: 'cloud_sync_warning',
          reason: 'timeout',
          backupPath: null,
          timestamp,
        },
      };
    }
    if (
      syncResult.completed === true &&
      (reason === 'cloud_sync_completed' || reason === 'cloud_log_settled')
    ) {
      return {
        gameId,
        platformId,
        event: 'cloud_sync_complete',
        cloudSync: {
          gameId,
          platformId,
          direction,
          synced: true,
          status: 'cloud_sync_complete',
          reason,
          backupPath: null,
          timestamp,
        },
      };
    }
    return null;
  }

  const extraTelemetry = {
    ...(syncResult.provider ? { provider: String(syncResult.provider) } : {}),
    ...(typeof syncResult.filesSynced === 'number'
      ? { filesSynced: syncResult.filesSynced }
      : {}),
    ...(typeof syncResult.bytesSynced === 'number'
      ? { bytesSynced: syncResult.bytesSynced }
      : {}),
  };

  if (syncResult.synced === true) {
    return {
      gameId,
      platformId,
      event: 'cloud_sync_complete',
      cloudSync: {
        gameId,
        platformId,
        direction,
        synced: true,
        status: 'cloud_sync_complete',
        ...(reason ? { reason } : {}),
        ...extraTelemetry,
        backupPath: syncResult.backupPath || null,
        timestamp,
      },
    };
  }

  if (syncResult.synced === false) {
    if (!reason || BENIGN_CLOUD_SYNC_SKIP_REASONS.has(reason)) {
      return null;
    }
    return {
      gameId,
      platformId,
      status: 'cloud_sync_warning',
      event: 'cloud_sync_warning',
      cloudSync: {
        gameId,
        platformId,
        direction,
        synced: false,
        status: 'cloud_sync_warning',
        reason,
        ...extraTelemetry,
        backupPath: syncResult.backupPath || null,
        timestamp,
      },
    };
  }

  return null;
}

module.exports = {
  getResolvedGogLocationAnchor,
  getResolvedEpicPathAnchor,
  normalizeResolvedCloudSavePath,
  resolveGogCloudSaveLocations,
  resolveEpicSavePathTemplate,
  isSafeEpicSaveTemplateSyntax,
  resolveXboxSaveLocations,
  pruneGogCloudConfigsMap,
  applyPruneCloudSaveTimestampsData,
  pruneCloudSaveStateForGame,
  pruneCloudSaveStateForGameAsync,
  buildCloudSyncTelemetryPayload,
};
