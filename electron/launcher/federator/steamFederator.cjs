// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  STEAM_GENRE_ID_NAMES,
  getLazyLauncherEngine,
  isExistingDirectory,
  isExistingDirectoryAsync,
  isExistingFile,
  isExistingFileAsync,
  validateFederatedImageFile,
  validateFederatedImageFileAsync,
  discoverStorefrontCacheRoots,
  discoverStorefrontCacheRootsAsync,
  isFederatedStoreUrlCompatible,
  formatUnixSecondsOrIsoDate,
  stripVideoTagsAndHtmlToPlainText,
  sanitizeOfflineHtmlRemovingVideos,
} = require('./cacheRootDiscovery.cjs');

/**
 * Helper to resolve Steam client icon hash from `appinfo.vdf` if not present in the URL.
 * @param {string} steamRoot
 * @param {string} appId
 * @returns {string}
 */
function readSteamVdfClientIcon(steamRoot, appId) {
  const launcherEngine = getLazyLauncherEngine();
  const appinfoPath = path.join(steamRoot, 'appcache', 'appinfo.vdf');
  if (launcherEngine && typeof launcherEngine.readSteamAppInfoParsedEntry === 'function') {
    try {
      const parsed = launcherEngine.readSteamAppInfoParsedEntry(appinfoPath, appId);
      const root = parsed?.appinfo || parsed;
      return String(root?.common?.clienticon || root?.common?.icon || '').trim();
    } catch {}
  }
  return '';
}

/**
 * Resolves a local Steam image asset across user custom grids, modern nested SHA-1
 * `appcache/librarycache/<appId>/<sha1>/...` directories (1-2 levels), direct `<appId>/...`,
 * legacy flat `<appId>_...`, and `steam/games/*.ico`.
 *
 * @param {string} appId
 * @param {string} role
 * @param {string} url
 * @param {any} roots
 * @param {Record<string, any>} [options]
 */
function resolveSteamFederatedAsset(appId, role, url, roots, options = {}) {
  if (!appId || !/^\d+$/.test(appId)) return null;
  if (url && !isFederatedStoreUrlCompatible('steam', url, { steamAppId: appId })) {
    return null;
  }
  const exts = ['webp', 'png', 'jpg', 'jpeg'];

  for (const steamRoot of roots.steamRoots || []) {
    /** @type {string[]} */
    const candidates = [];

    // 1. User custom grid overrides: userdata/<steam3Id>/config/grid/
    const userdataDir = path.join(steamRoot, 'userdata');
    if (isExistingDirectory(userdataDir)) {
      try {
        for (const uid of fs.readdirSync(userdataDir)) {
          if (!/^\d+$/.test(uid)) continue;
          const gridDir = path.join(userdataDir, uid, 'config', 'grid');
          if (!isExistingDirectory(gridDir)) continue;
          if (role === 'cover') {
            for (const ext of exts) {
              candidates.push(path.join(gridDir, `${appId}p.${ext}`));
            }
          } else if (role === 'header') {
            for (const ext of exts) {
              candidates.push(path.join(gridDir, `${appId}.${ext}`));
              candidates.push(path.join(gridDir, `${appId}_hero.${ext}`));
            }
          } else if (role === 'icon') {
            for (const ext of [...exts, 'ico']) {
              candidates.push(path.join(gridDir, `${appId}_icon.${ext}`));
            }
          }
        }
      } catch {}
    }

    // 2. Modern Steam librarycache/<appId>/ (direct + 1-2 nested SHA1 subdirectories) & legacy flat
    const libCacheDir = path.join(steamRoot, 'appcache', 'librarycache');
    const appCacheDir = path.join(libCacheDir, appId);

    const roleStemNames =
      role === 'cover'
        ? ['library_600x900', 'library_capsule', 'library_600x900_2x']
        : role === 'header'
          ? ['header', 'library_header', 'library_hero']
          : role === 'icon'
            ? ['icon', `${appId}_icon`]
            : [];

    if (isExistingDirectory(appCacheDir)) {
      const searchDirs = [appCacheDir];
      try {
        const level1 = fs.readdirSync(appCacheDir, { withFileTypes: true });
        for (const ent1 of level1) {
          if (ent1.isDirectory() && !ent1.name.startsWith('.')) {
            const sub1 = path.join(appCacheDir, ent1.name);
            searchDirs.push(sub1);
            try {
              const level2 = fs.readdirSync(sub1, { withFileTypes: true });
              for (const ent2 of level2) {
                if (ent2.isDirectory() && !ent2.name.startsWith('.')) {
                  searchDirs.push(path.join(sub1, ent2.name));
                }
              }
            } catch {}
          }
        }
      } catch {}

      for (const dir of searchDirs) {
        for (const stem of roleStemNames) {
          for (const ext of role === 'icon' ? [...exts, 'ico'] : exts) {
            candidates.push(path.join(dir, `${stem}.${ext}`));
          }
        }
      }

      if (role === 'icon') {
        try {
          for (const fileName of fs.readdirSync(appCacheDir)) {
            if (/^[0-9a-f]{40}\.(?:jpg|jpeg|png|webp|ico)$/i.test(fileName)) {
              candidates.push(path.join(appCacheDir, fileName));
            }
          }
        } catch {}
      }
    }

    // 3. Legacy flat files in appcache/librarycache/
    if (isExistingDirectory(libCacheDir)) {
      if (role === 'cover') {
        for (const ext of exts) {
          candidates.push(path.join(libCacheDir, `${appId}_library_600x900.${ext}`));
          candidates.push(path.join(libCacheDir, `${appId}_library_capsule.${ext}`));
        }
      } else if (role === 'header') {
        for (const ext of exts) {
          candidates.push(path.join(libCacheDir, `${appId}_header.${ext}`));
          candidates.push(path.join(libCacheDir, `${appId}_library_hero.${ext}`));
        }
      } else if (role === 'icon') {
        for (const ext of [...exts, 'ico']) {
          candidates.push(path.join(libCacheDir, `${appId}_icon.${ext}`));
        }
      }
    }

    // 4. steam/games/*.ico for icons
    if (role === 'icon') {
      const gamesIcoDirs = [
        path.join(steamRoot, 'steam', 'games'),
        path.join(steamRoot, 'Steam', 'games'),
      ];
      const urlHashMatch =
        typeof url === 'string' ? url.match(/\/([0-9a-f]{40})\.(?:ico|jpg|png)/i) : null;
      const vdfClientIcon = !urlHashMatch ? readSteamVdfClientIcon(steamRoot, appId) : '';
      for (const icoDir of gamesIcoDirs) {
        if (!isExistingDirectory(icoDir)) continue;
        if (urlHashMatch && urlHashMatch[1]) {
          candidates.push(path.join(icoDir, `${urlHashMatch[1]}.ico`));
        }
        if (vdfClientIcon && /^[0-9a-f]{40}$/i.test(vdfClientIcon)) {
          candidates.push(path.join(icoDir, `${vdfClientIcon}.ico`));
        }
        candidates.push(path.join(icoDir, `${appId}.ico`));
      }
    }

    for (const candidate of candidates) {
      if (
        !isFederatedStoreUrlCompatible('steam', url, {
          steamAppId: appId,
          candidatePath: candidate,
        })
      ) {
        continue;
      }
      const validated = validateFederatedImageFile(candidate, steamRoot, options);
      if (validated.valid) {
        return {
          path: validated.path,
          mimeType: validated.mimeType,
          ext: validated.ext,
          sizeBytes: validated.sizeBytes,
          source: 'steam_local_cache',
        };
      }
    }
  }

  return null;
}

/**
 * Async variant of `resolveSteamFederatedAsset` using `fs.promises` so Tier-2 local Steam cache
 * walks never block Electron's main thread.
 *
 * @param {string} appId
 * @param {string} role
 * @param {string} url
 * @param {any} roots
 * @param {Record<string, any>} [options]
 */
async function resolveSteamFederatedAssetAsync(appId, role, url, roots, options = {}) {
  if (!appId || !/^\d+$/.test(appId)) return null;
  if (url && !isFederatedStoreUrlCompatible('steam', url, { steamAppId: appId })) {
    return null;
  }
  const exts = ['webp', 'png', 'jpg', 'jpeg'];

  for (const steamRoot of roots.steamRoots || []) {
    /** @type {string[]} */
    const candidates = [];

    // 1. User custom grid overrides: userdata/<steam3Id>/config/grid/
    const userdataDir = path.join(steamRoot, 'userdata');
    if (await isExistingDirectoryAsync(userdataDir)) {
      try {
        for (const uid of await fs.promises.readdir(userdataDir)) {
          if (!/^\d+$/.test(uid)) continue;
          const gridDir = path.join(userdataDir, uid, 'config', 'grid');
          if (!(await isExistingDirectoryAsync(gridDir))) continue;
          if (role === 'cover') {
            for (const ext of exts) {
              candidates.push(path.join(gridDir, `${appId}p.${ext}`));
            }
          } else if (role === 'header') {
            for (const ext of exts) {
              candidates.push(path.join(gridDir, `${appId}.${ext}`));
              candidates.push(path.join(gridDir, `${appId}_hero.${ext}`));
            }
          } else if (role === 'icon') {
            for (const ext of [...exts, 'ico']) {
              candidates.push(path.join(gridDir, `${appId}_icon.${ext}`));
            }
          }
        }
      } catch {}
    }

    // 2. Modern Steam librarycache/<appId>/ (direct + 1-2 nested SHA1 subdirectories) & legacy flat
    const libCacheDir = path.join(steamRoot, 'appcache', 'librarycache');
    const appCacheDir = path.join(libCacheDir, appId);

    const roleStemNames =
      role === 'cover'
        ? ['library_600x900', 'library_capsule', 'library_600x900_2x']
        : role === 'header'
          ? ['header', 'library_header', 'library_hero']
          : role === 'icon'
            ? ['icon', `${appId}_icon`]
            : [];

    if (await isExistingDirectoryAsync(appCacheDir)) {
      const searchDirs = [appCacheDir];
      /** @type {string[]} */
      const topLevelFiles = [];
      try {
        const level1 = await fs.promises.readdir(appCacheDir, { withFileTypes: true });
        for (const ent1 of level1) {
          if (ent1.isDirectory() && !ent1.name.startsWith('.')) {
            const sub1 = path.join(appCacheDir, ent1.name);
            searchDirs.push(sub1);
            try {
              const level2 = await fs.promises.readdir(sub1, { withFileTypes: true });
              for (const ent2 of level2) {
                if (ent2.isDirectory() && !ent2.name.startsWith('.')) {
                  searchDirs.push(path.join(sub1, ent2.name));
                }
              }
            } catch {}
          } else if (ent1.isFile()) {
            topLevelFiles.push(ent1.name);
          }
        }
      } catch {}

      for (const dir of searchDirs) {
        for (const stem of roleStemNames) {
          for (const ext of role === 'icon' ? [...exts, 'ico'] : exts) {
            candidates.push(path.join(dir, `${stem}.${ext}`));
          }
        }
      }

      if (role === 'icon') {
        for (const fileName of topLevelFiles) {
          if (/^[0-9a-f]{40}\.(?:jpg|jpeg|png|webp|ico)$/i.test(fileName)) {
            candidates.push(path.join(appCacheDir, fileName));
          }
        }
      }
    }

    // 3. Legacy flat files in appcache/librarycache/
    if (await isExistingDirectoryAsync(libCacheDir)) {
      if (role === 'cover') {
        for (const ext of exts) {
          candidates.push(path.join(libCacheDir, `${appId}_library_600x900.${ext}`));
          candidates.push(path.join(libCacheDir, `${appId}_library_capsule.${ext}`));
        }
      } else if (role === 'header') {
        for (const ext of exts) {
          candidates.push(path.join(libCacheDir, `${appId}_header.${ext}`));
          candidates.push(path.join(libCacheDir, `${appId}_library_hero.${ext}`));
        }
      } else if (role === 'icon') {
        for (const ext of [...exts, 'ico']) {
          candidates.push(path.join(libCacheDir, `${appId}_icon.${ext}`));
        }
      }
    }

    // 4. steam/games/*.ico for icons
    if (role === 'icon') {
      const gamesIcoDirs = [
        path.join(steamRoot, 'steam', 'games'),
        path.join(steamRoot, 'Steam', 'games'),
      ];
      const urlHashMatch =
        typeof url === 'string' ? url.match(/\/([0-9a-f]{40})\.(?:ico|jpg|png)/i) : null;
      const vdfClientIcon = !urlHashMatch ? readSteamVdfClientIcon(steamRoot, appId) : '';
      for (const icoDir of gamesIcoDirs) {
        if (!(await isExistingDirectoryAsync(icoDir))) continue;
        if (urlHashMatch && urlHashMatch[1]) {
          candidates.push(path.join(icoDir, `${urlHashMatch[1]}.ico`));
        }
        if (vdfClientIcon && /^[0-9a-f]{40}$/i.test(vdfClientIcon)) {
          candidates.push(path.join(icoDir, `${vdfClientIcon}.ico`));
        }
        candidates.push(path.join(icoDir, `${appId}.ico`));
      }
    }

    for (const candidate of candidates) {
      if (
        !isFederatedStoreUrlCompatible('steam', url, {
          steamAppId: appId,
          candidatePath: candidate,
        })
      ) {
        continue;
      }
      const validated = await validateFederatedImageFileAsync(candidate, steamRoot, options);
      if (validated.valid) {
        return {
          path: validated.path,
          mimeType: validated.mimeType,
          ext: validated.ext,
          sizeBytes: validated.sizeBytes,
          source: 'steam_local_cache',
        };
      }
    }
  }

  return null;
}

/**
 * Shared accumulator parser for `userdata/<uid>/config/librarycache/<appId>.json`.
 * @param {any} rawJson
 * @param {any} state
 */
function mergeSteamLibraryCacheJson(rawJson, state) {
  if (Array.isArray(rawJson)) {
    for (const entry of rawJson) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [section, payload] = entry;
      const data = payload?.data || payload;
      if (section === 'descriptions' && data && typeof data === 'object') {
        if (!state.shortDescription && typeof data.strSnippet === 'string') {
          state.shortDescription = stripVideoTagsAndHtmlToPlainText(data.strSnippet);
        }
        if (!state.detailedDescription && typeof data.strFullDescription === 'string') {
          state.detailedDescription = sanitizeOfflineHtmlRemovingVideos(data.strFullDescription);
        }
      } else if (section === 'associations' && data && typeof data === 'object') {
        if (Array.isArray(data.rgDevelopers)) {
          for (const d of data.rgDevelopers) {
            const n = typeof d === 'string' ? d : d?.strName;
            if (n) state.developersSet.add(String(n).trim());
          }
        }
        if (Array.isArray(data.rgPublishers)) {
          for (const p of data.rgPublishers) {
            const n = typeof p === 'string' ? p : p?.strName;
            if (n) state.publishersSet.add(String(n).trim());
          }
        }
      }
    }
  } else if (rawJson && typeof rawJson === 'object') {
    if (!state.name && typeof rawJson.name === 'string') state.name = rawJson.name.trim();
    if (!state.shortDescription && typeof rawJson.shortDescription === 'string') {
      state.shortDescription = stripVideoTagsAndHtmlToPlainText(rawJson.shortDescription);
    }
    if (!state.detailedDescription && typeof rawJson.detailedDescription === 'string') {
      state.detailedDescription = sanitizeOfflineHtmlRemovingVideos(rawJson.detailedDescription);
    }
    if (Array.isArray(rawJson.developers)) {
      rawJson.developers.forEach((/** @type {any} */ d) => d && state.developersSet.add(String(d).trim()));
    }
    if (Array.isArray(rawJson.publishers)) {
      rawJson.publishers.forEach((/** @type {any} */ p) => p && state.publishersSet.add(String(p).trim()));
    }
    if (Array.isArray(rawJson.genres)) {
      rawJson.genres.forEach((/** @type {any} */ g) => g && state.genresSet.add(String(g).trim()));
    }
    if (!state.releaseDate && rawJson.releaseDate) {
      state.releaseDate = formatUnixSecondsOrIsoDate(rawJson.releaseDate);
    }
  }
}

/**
 * Shared extractor from parsed `appinfo.vdf` entry into accumulator state.
 * @param {string} appinfoPath
 * @param {number} numericAppId
 * @param {any} launcherEngine
 * @param {any} state
 */
function mergeSteamAppInfoEntry(appinfoPath, numericAppId, launcherEngine, state) {
  let parsed = null;
  if (typeof launcherEngine.readSteamAppInfoParsedEntry === 'function') {
    parsed = launcherEngine.readSteamAppInfoParsedEntry(appinfoPath, numericAppId);
  } else if (
    typeof launcherEngine.getIndexedSteamAppInfoVdf === 'function' &&
    typeof launcherEngine.parseSteamBinaryVdfSlice === 'function'
  ) {
    const idx = launcherEngine.getIndexedSteamAppInfoVdf(appinfoPath);
    const slice = idx?.appIndex?.get(numericAppId);
    if (slice && idx?.buf) {
      parsed = launcherEngine.parseSteamBinaryVdfSlice(
        idx.buf,
        slice.payloadStart,
        slice.payloadEnd,
        idx.strings
      );
    }
  }

  const root = parsed?.appinfo || parsed;
  const common = root?.common;
  const extended = root?.extended;

  if (common && typeof common === 'object') {
    if (!state.name && typeof common.name === 'string' && common.name.trim()) {
      state.name = common.name.trim();
    }
    if (typeof common.oslist === 'string' && common.oslist.trim()) {
      const osLower = common.oslist.toLowerCase();
      state.platforms = {
        windows: osLower.includes('windows'),
        mac: osLower.includes('macos') || osLower.includes('osx') || /\bmac\b/.test(osLower),
        linux: osLower.includes('linux'),
      };
    }
    if (!state.releaseDate) {
      state.releaseDate =
        formatUnixSecondsOrIsoDate(common.original_release_date) ||
        formatUnixSecondsOrIsoDate(common.steam_release_date);
    }
    if (common.associations && typeof common.associations === 'object') {
      for (const assoc of Object.values(common.associations)) {
        if (!assoc || typeof assoc !== 'object' || !assoc.name) continue;
        const t = String(assoc.type || '').toLowerCase();
        if (t === 'developer') state.developersSet.add(String(assoc.name).trim());
        else if (t === 'publisher') state.publishersSet.add(String(assoc.name).trim());
      }
    }
    if (common.genres && typeof common.genres === 'object') {
      for (const gVal of Object.values(common.genres)) {
        const gKey = String(gVal).trim();
        if (STEAM_GENRE_ID_NAMES[gKey]) {
          state.genresSet.add(STEAM_GENRE_ID_NAMES[gKey]);
        } else if (gKey && !/^\d+$/.test(gKey)) {
          state.genresSet.add(gKey);
        }
      }
    }
    if (typeof common.metacritic_score === 'number' && common.metacritic_score > 0) {
      state.metacriticScore = common.metacritic_score;
    }
  }

  if (extended && typeof extended === 'object') {
    if (typeof extended.developer === 'string' && extended.developer.trim()) {
      state.developersSet.add(extended.developer.trim());
    }
    if (typeof extended.publisher === 'string' && extended.publisher.trim()) {
      state.publishersSet.add(extended.publisher.trim());
    }
  }
}

/**
 * @param {number} numericAppId
 * @param {any} state
 */
function finalizeLocalSteamMetadata(numericAppId, state) {
  const developers = Array.from(state.developersSet).filter(Boolean);
  const publishers = Array.from(state.publishersSet).filter(Boolean);
  const genres = Array.from(state.genresSet).filter(Boolean);

  if (
    !state.name &&
    developers.length === 0 &&
    publishers.length === 0 &&
    genres.length === 0 &&
    !state.releaseDate &&
    !state.platforms &&
    !state.shortDescription &&
    !state.detailedDescription
  ) {
    return null;
  }

  let shortDescription = state.shortDescription;
  if (!shortDescription && state.detailedDescription) {
    shortDescription = stripVideoTagsAndHtmlToPlainText(state.detailedDescription).slice(0, 320);
  }

  return {
    appId: numericAppId,
    name: state.name || undefined,
    shortDescription: shortDescription || '',
    detailedDescription: state.detailedDescription || shortDescription || '',
    aboutTheGame: state.detailedDescription || shortDescription || '',
    developers,
    publishers,
    genres,
    tags: genres,
    categories: [],
    screenshots: [],
    movies: [],
    releaseDate: state.releaseDate || '',
    platforms: state.platforms || { windows: true, mac: false, linux: false },
    ...(state.metacriticScore ? { metacritic: { score: state.metacriticScore } } : {}),
    metadataQuality: 'local_federated',
  };
}

/**
 * Resolves local Steam metadata for `appId` from `appcache/appinfo.vdf` and
 * `userdata/<steam3Id>/config/librarycache/<appId>.json`.
 *
 * @param {number | string} appId
 * @param {Record<string, any>} [options]
 */
function resolveLocalSteamMetadata(appId, options = {}) {
  const cleanStr = String(appId || '').replace(/^steam[-_]/i, '').trim();
  const numericAppId = parseInt(cleanStr, 10);
  if (!numericAppId || Number.isNaN(numericAppId)) return null;

  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);
  const launcherEngine = getLazyLauncherEngine();
  const state = {
    name: '',
    developersSet: new Set(),
    publishersSet: new Set(),
    genresSet: new Set(),
    releaseDate: undefined,
    platforms: null,
    shortDescription: '',
    detailedDescription: '',
    metacriticScore: undefined,
  };

  for (const steamRoot of roots.steamRoots || []) {
    const appinfoPath = path.join(steamRoot, 'appcache', 'appinfo.vdf');
    if (isExistingFile(appinfoPath) && launcherEngine) {
      mergeSteamAppInfoEntry(appinfoPath, numericAppId, launcherEngine, state);
    }

    const userdataDir = path.join(steamRoot, 'userdata');
    if (isExistingDirectory(userdataDir)) {
      try {
        for (const uid of fs.readdirSync(userdataDir)) {
          if (!/^\d+$/.test(uid)) continue;
          const jsonPath = path.join(
            userdataDir,
            uid,
            'config',
            'librarycache',
            `${numericAppId}.json`
          );
          if (!isExistingFile(jsonPath)) continue;
          try {
            const rawJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            mergeSteamLibraryCacheJson(rawJson, state);
          } catch {}
        }
      } catch {}
    }
  }

  return finalizeLocalSteamMetadata(numericAppId, state);
}

/**
 * Async variant of `resolveLocalSteamMetadata` using `fs.promises`.
 *
 * @param {number | string} appId
 * @param {Record<string, any>} [options]
 */
async function resolveLocalSteamMetadataAsync(appId, options = {}) {
  const cleanStr = String(appId || '').replace(/^steam[-_]/i, '').trim();
  const numericAppId = parseInt(cleanStr, 10);
  if (!numericAppId || Number.isNaN(numericAppId)) return null;

  const roots = options._precomputedRoots || (await discoverStorefrontCacheRootsAsync(options));
  const launcherEngine = getLazyLauncherEngine();
  const state = {
    name: '',
    developersSet: new Set(),
    publishersSet: new Set(),
    genresSet: new Set(),
    releaseDate: undefined,
    platforms: null,
    shortDescription: '',
    detailedDescription: '',
    metacriticScore: undefined,
  };

  for (const steamRoot of roots.steamRoots || []) {
    const appinfoPath = path.join(steamRoot, 'appcache', 'appinfo.vdf');
    if ((await isExistingFileAsync(appinfoPath)) && launcherEngine) {
      mergeSteamAppInfoEntry(appinfoPath, numericAppId, launcherEngine, state);
    }

    const userdataDir = path.join(steamRoot, 'userdata');
    if (await isExistingDirectoryAsync(userdataDir)) {
      try {
        for (const uid of await fs.promises.readdir(userdataDir)) {
          if (!/^\d+$/.test(uid)) continue;
          const jsonPath = path.join(
            userdataDir,
            uid,
            'config',
            'librarycache',
            `${numericAppId}.json`
          );
          if (!(await isExistingFileAsync(jsonPath))) continue;
          try {
            const rawJson = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
            mergeSteamLibraryCacheJson(rawJson, state);
          } catch {}
        }
      } catch {}
    }
  }

  return finalizeLocalSteamMetadata(numericAppId, state);
}

module.exports = {
  resolveSteamFederatedAsset,
  resolveSteamFederatedAssetAsync,
  resolveLocalSteamMetadata,
  resolveLocalSteamMetadataAsync,
};
