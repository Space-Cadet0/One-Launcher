// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const {
  getSqliteDatabaseSync,
  setBoundedCache,
  validateFederatedImageFile,
  validateFederatedImageFileAsync,
  discoverStorefrontCacheRoots,
  resolveGogDbPathForRoot,
  resolveGogDbPathForRootAsync,
  isFederatedStoreUrlCompatible,
  formatUnixSecondsOrIsoDate,
  stripVideoTagsAndHtmlToPlainText,
  sanitizeOfflineHtmlRemovingVideos,
  normalizeGogImageTemplateUrl,
} = require('./cacheRootDiscovery.cjs');

/** @type {Map<string, any>} */
const gogGalaxyDbSnapshotLookup = new Map();
const MAX_GOG_DB_SNAPSHOT_ENTRIES = 4;

/** @type {Map<string, string>} */
const gogRootWebCacheDirLookup = new Map();
const MAX_GOG_ROOT_WEBCACHE_DIR_ENTRIES = 16;

/**
 * Opens GOG Galaxy 2.0 `galaxy-2.0.db` (`{ readOnly: true }`) ONCE per `(dbPath, mtimeMs, size)`
 * across an entire GOG federation scan, indexing `WebCache` resources and `GamePieces` raw rows
 * in memory and immediately closing the SQLite descriptor so Windows file locks are never held.
 *
 * @param {string} dbPath
 * @param {any} DatabaseSync
 */
function loadGogGalaxyDbSnapshot(dbPath, DatabaseSync) {
  if (!dbPath || !DatabaseSync) return null;
  let sig = '';
  try {
    const st = fs.statSync(dbPath);
    sig = `${dbPath}::${st.mtimeMs}::${st.size}`;
  } catch {
    return null;
  }
  if (gogGalaxyDbSnapshotLookup.has(sig)) {
    return gogGalaxyDbSnapshotLookup.get(sig);
  }

  /** @type {Map<string, Array<{ userId: any, resourceType: any, filename: any }>>} */
  const webCacheByGogId = new Map();
  /** @type {Map<string, Map<string, string>>} */
  const piecesByGogId = new Map();
  /** @type {Map<string, any>} */
  const parsedMetaByGogId = new Map();
  /** @type {Map<string, Set<string>>} */
  const visibleLibraryUsersByGogId = new Map();

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tableRows = db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
        .all();
      const tableNamesLower = new Set(
        tableRows.map((/** @type {any} */ t) => String(t?.name || '').toLowerCase())
      );
      const hasLibraryReleases = tableNamesLower.has('libraryreleases');
      const hasReleaseProperties = tableNamesLower.has('releaseproperties');

      if (hasLibraryReleases) {
        const lrCols = new Set(
          db
            .prepare('PRAGMA table_info(LibraryReleases)')
            .all()
            .map((/** @type {any} */ c) => String(c?.name || '').toLowerCase())
        );
        const userIdExpr = lrCols.has('userid')
          ? "CAST(COALESCE(lr.userId, '') AS TEXT) AS userId"
          : "'' AS userId";

        let lrRows = [];
        if (hasReleaseProperties) {
          const rpCols = new Set(
            db
              .prepare('PRAGMA table_info(ReleaseProperties)')
              .all()
              .map((/** @type {any} */ c) => String(c?.name || '').toLowerCase())
          );
          const visClause = rpCols.has('isvisibleinlibrary')
            ? 'AND COALESCE(rp.isVisibleInLibrary, 1) = 1'
            : '';
          const dlcClause = rpCols.has('isdlc') ? 'AND COALESCE(rp.isDlc, 0) = 0' : '';
          lrRows = db
            .prepare(
              `
              SELECT DISTINCT lr.releaseKey AS releaseKey, ${userIdExpr}
              FROM LibraryReleases lr
              LEFT JOIN ReleaseProperties rp ON rp.releaseKey = lr.releaseKey
              WHERE lr.releaseKey LIKE 'gog_%'
                ${visClause}
                ${dlcClause}
            `
            )
            .all();
        } else {
          lrRows = db
            .prepare(
              `
              SELECT DISTINCT lr.releaseKey AS releaseKey, ${userIdExpr}
              FROM LibraryReleases lr
              WHERE lr.releaseKey LIKE 'gog_%'
            `
            )
            .all();
        }

        for (const r of lrRows) {
          if (!r || typeof r.releaseKey !== 'string' || !r.releaseKey.startsWith('gog_')) continue;
          const gid = r.releaseKey.slice(4).trim();
          if (!/^\d+$/.test(gid)) continue;
          let userSet = visibleLibraryUsersByGogId.get(gid);
          if (!userSet) {
            userSet = new Set();
            visibleLibraryUsersByGogId.set(gid, userSet);
          }
          const uid = String(r.userId ?? '').trim();
          if (uid) {
            userSet.add(uid);
          } else {
            userSet.add('');
            userSet.add('*');
          }
        }
      }
    } catch (lrErr) {
      diagLog.debug('federator.gogSnapshotLibraryReleases', lrErr, { dbPath });
    }

    try {
      const wcRows = db
        .prepare(
          `
          SELECT
            wc.releaseKey AS releaseKey,
            CAST(wc.userId AS TEXT) AS userId,
            wcrt.type AS resourceType,
            wcr.filename AS filename
          FROM WebCache wc
          JOIN WebCacheResources wcr ON wcr.webCacheId = wc.id
          JOIN WebCacheResourceTypes wcrt ON wcrt.id = wcr.webCacheResourceTypeId
          WHERE wc.releaseKey LIKE 'gog_%'
        `
        )
        .all();
      for (const r of wcRows) {
        if (!r || typeof r.releaseKey !== 'string' || !r.releaseKey.startsWith('gog_')) continue;
        const gid = r.releaseKey.slice(4);
        if (!/^\d+$/.test(gid)) continue;
        let arr = webCacheByGogId.get(gid);
        if (!arr) {
          arr = [];
          webCacheByGogId.set(gid, arr);
        }
        arr.push({
          userId: r.userId,
          resourceType: r.resourceType,
          filename: r.filename,
        });
      }
    } catch (wcErr) {
      diagLog.debug('federator.gogSnapshotWebCache', wcErr, { dbPath });
    }

    try {
      const gpRows = db
        .prepare(
          `
          SELECT gp.releaseKey AS releaseKey, gpt.type AS pieceType, gp.value AS valueJson
          FROM GamePieces gp
          JOIN GamePieceTypes gpt ON gpt.id = gp.gamePieceTypeId
          WHERE gp.releaseKey LIKE 'gog_%'
        `
        )
        .all();
      for (const r of gpRows) {
        if (!r || typeof r.releaseKey !== 'string' || !r.releaseKey.startsWith('gog_')) continue;
        const gid = r.releaseKey.slice(4);
        if (!/^\d+$/.test(gid)) continue;
        let mapForGame = piecesByGogId.get(gid);
        if (!mapForGame) {
          mapForGame = new Map();
          piecesByGogId.set(gid, mapForGame);
        }
        if (r.pieceType && typeof r.valueJson === 'string' && !mapForGame.has(r.pieceType)) {
          mapForGame.set(r.pieceType, r.valueJson);
        }
      }
    } catch (gpErr) {
      diagLog.debug('federator.gogSnapshotGamePieces', gpErr, { dbPath });
    }
  } catch (err) {
    diagLog.debug('federator.gogSnapshotOpen', err, { dbPath });
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }

  const snapshot = {
    webCacheByGogId,
    piecesByGogId,
    parsedMetaByGogId,
    visibleLibraryUsersByGogId,
  };
  setBoundedCache(gogGalaxyDbSnapshotLookup, sig, snapshot, MAX_GOG_DB_SNAPSHOT_ENTRIES);
  return snapshot;
}

/**
 * Queries GOG Galaxy 2.0 `galaxy-2.0.db` read-only (via single-open snapshot cache) with
 * `CAST(wc.userId AS TEXT)` 64-bit safety to locate cached images in
 * `<gogRoot>/{webcache,WebCache}/<userId>/gog/<productId>/<filename>`.
 * Supports both `(gogId, role, url, roots, options)` and legacy `(gogId, role, roots, options)`.
 *
 * @param {string} gogId
 * @param {string} role
 * @param {any} urlOrRoots
 * @param {any} [rootsOrOptions]
 * @param {Record<string, any>} [maybeOptions]
 */
function resolveGogFederatedAsset(gogId, role, urlOrRoots, rootsOrOptions, maybeOptions) {
  let url = '';
  let roots = urlOrRoots;
  let options = rootsOrOptions || {};
  if (typeof urlOrRoots === 'string' || urlOrRoots === null || urlOrRoots === undefined) {
    url = typeof urlOrRoots === 'string' ? urlOrRoots.trim() : '';
    roots = rootsOrOptions;
    options = maybeOptions || {};
  }

  if (!gogId || !/^\d+$/.test(gogId)) return null;
  if (!roots || !Array.isArray(roots.gogRoots)) return null;
  if (url && !isFederatedStoreUrlCompatible('gog', url, { gogId })) {
    return null;
  }

  const gogResourceType =
    role === 'cover'
      ? 'verticalCover'
      : role === 'header'
        ? 'background'
        : role === 'icon'
          ? 'squareIcon'
          : '';
  if (!gogResourceType) return null;

  const DatabaseSync = getSqliteDatabaseSync();
  if (!DatabaseSync) return null;

  for (const gogRoot of roots.gogRoots) {
    const dbPath = resolveGogDbPathForRoot(gogRoot);
    if (!dbPath) continue;

    const snapshot = loadGogGalaxyDbSnapshot(dbPath, DatabaseSync);
    const rows = snapshot?.webCacheByGogId?.get(gogId) || null;
    if (!Array.isArray(rows) || rows.length === 0) continue;

    let actualWebCacheFolder = gogRootWebCacheDirLookup.get(gogRoot);
    if (actualWebCacheFolder === undefined) {
      actualWebCacheFolder = '';
      try {
        const rootEntries = fs.readdirSync(gogRoot);
        actualWebCacheFolder =
          rootEntries.find((e) => e.toLowerCase() === 'webcache') || '';
      } catch {}
      setBoundedCache(
        gogRootWebCacheDirLookup,
        gogRoot,
        actualWebCacheFolder,
        MAX_GOG_ROOT_WEBCACHE_DIR_ENTRIES
      );
    }

    for (const row of rows) {
      if (!row || row.resourceType !== gogResourceType) continue;
      const userIdStr = String(row.userId || '').trim();
      const filename = String(row.filename || '').trim();
      if (!userIdStr || !filename || filename.includes('..') || /[\\/]/.test(filename)) {
        continue;
      }

      const webCacheDirs = actualWebCacheFolder
        ? [path.join(gogRoot, actualWebCacheFolder, userIdStr, 'gog', gogId)]
        : [
            path.join(gogRoot, 'WebCache', userIdStr, 'gog', gogId),
            path.join(gogRoot, 'webcache', userIdStr, 'gog', gogId),
          ];
      for (const dir of webCacheDirs) {
        const candidatePath = path.join(dir, filename);
        if (
          !isFederatedStoreUrlCompatible('gog', url, {
            gogId,
            candidatePath,
          })
        ) {
          continue;
        }
        const validated = validateFederatedImageFile(candidatePath, gogRoot, options);
        if (validated.valid) {
          return {
            path: validated.path,
            mimeType: validated.mimeType,
            ext: validated.ext,
            sizeBytes: validated.sizeBytes,
            source: 'gog_galaxy_webcache',
          };
        }
      }
    }
  }

  return null;
}

/**
 * Async variant of `resolveGogFederatedAsset` using `fs.promises`.
 *
 * @param {string} gogId
 * @param {string} role
 * @param {any} urlOrRoots
 * @param {any} [rootsOrOptions]
 * @param {Record<string, any>} [maybeOptions]
 */
async function resolveGogFederatedAssetAsync(gogId, role, urlOrRoots, rootsOrOptions, maybeOptions) {
  let url = '';
  let roots = urlOrRoots;
  let options = rootsOrOptions || {};
  if (typeof urlOrRoots === 'string' || urlOrRoots === null || urlOrRoots === undefined) {
    url = typeof urlOrRoots === 'string' ? urlOrRoots.trim() : '';
    roots = rootsOrOptions;
    options = maybeOptions || {};
  }

  if (!gogId || !/^\d+$/.test(gogId)) return null;
  if (!roots || !Array.isArray(roots.gogRoots)) return null;
  if (url && !isFederatedStoreUrlCompatible('gog', url, { gogId })) {
    return null;
  }

  const gogResourceType =
    role === 'cover'
      ? 'verticalCover'
      : role === 'header'
        ? 'background'
        : role === 'icon'
          ? 'squareIcon'
          : '';
  if (!gogResourceType) return null;

  const DatabaseSync = getSqliteDatabaseSync();
  if (!DatabaseSync) return null;

  for (const gogRoot of roots.gogRoots) {
    const dbPath = await resolveGogDbPathForRootAsync(gogRoot);
    if (!dbPath) continue;

    const snapshot = loadGogGalaxyDbSnapshot(dbPath, DatabaseSync);
    const rows = snapshot?.webCacheByGogId?.get(gogId) || null;
    if (!Array.isArray(rows) || rows.length === 0) continue;

    let actualWebCacheFolder = gogRootWebCacheDirLookup.get(gogRoot);
    if (actualWebCacheFolder === undefined) {
      actualWebCacheFolder = '';
      try {
        const rootEntries = await fs.promises.readdir(gogRoot);
        actualWebCacheFolder =
          rootEntries.find((e) => e.toLowerCase() === 'webcache') || '';
      } catch {}
      setBoundedCache(
        gogRootWebCacheDirLookup,
        gogRoot,
        actualWebCacheFolder,
        MAX_GOG_ROOT_WEBCACHE_DIR_ENTRIES
      );
    }

    for (const row of rows) {
      if (!row || row.resourceType !== gogResourceType) continue;
      const userIdStr = String(row.userId || '').trim();
      const filename = String(row.filename || '').trim();
      if (!userIdStr || !filename || filename.includes('..') || /[\\/]/.test(filename)) {
        continue;
      }

      const webCacheDirs = actualWebCacheFolder
        ? [path.join(gogRoot, actualWebCacheFolder, userIdStr, 'gog', gogId)]
        : [
            path.join(gogRoot, 'WebCache', userIdStr, 'gog', gogId),
            path.join(gogRoot, 'webcache', userIdStr, 'gog', gogId),
          ];
      for (const dir of webCacheDirs) {
        const candidatePath = path.join(dir, filename);
        if (
          !isFederatedStoreUrlCompatible('gog', url, {
            gogId,
            candidatePath,
          })
        ) {
          continue;
        }
        const validated = await validateFederatedImageFileAsync(candidatePath, gogRoot, options);
        if (validated.valid) {
          return {
            path: validated.path,
            mimeType: validated.mimeType,
            ext: validated.ext,
            sizeBytes: validated.sizeBytes,
            source: 'gog_galaxy_webcache',
          };
        }
      }
    }
  }

  return null;
}

/**
 * @param {string} cleanGogId
 * @param {Map<string, string>} piecesByType
 */
function parseGogPiecesMapToMetadata(cleanGogId, piecesByType) {
  if (!piecesByType || piecesByType.size === 0) return null;

  /** @param {string} type */
  const getParsed = (type) => {
    const raw = piecesByType.get(type);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const titleObj = getParsed('title') || getParsed('originalTitle');
  const summaryObj = getParsed('summary');
  const metaObj = getParsed('meta');
  const origMetaObj = getParsed('originalMeta');
  const mediaObj = getParsed('media');
  const storeMediaObj = getParsed('storeMedia');
  const osObj = getParsed('osCompatibility');
  const storeOsObj = getParsed('storeOsCompatibility');
  const storeTagsObj = getParsed('storeTags');
  const localizationsObj = getParsed('localizations');
  const storeFeaturesObj = getParsed('storeFeatures');
  const reviewScoreObj = getParsed('reviewScore');
  const origImagesObj = getParsed('originalImages');
  const storeImagesObj = getParsed('storeImages');
  const isDlcPieceObj = getParsed('isDlc');
  const isDlc = Boolean(
    isDlcPieceObj === true ||
      isDlcPieceObj?.isDlc ||
      metaObj?.isDlc ||
      origMetaObj?.isDlc ||
      /^(?:dlc|pack|addon|add-on)$/i.test(
        String(metaObj?.productType || origMetaObj?.productType || '').trim()
      )
  );

  const name = String(titleObj?.title || '').trim();
  const rawSummaryHtml = String(summaryObj?.summary || summaryObj?.description || '').trim();
  const detailedDescription = sanitizeOfflineHtmlRemovingVideos(rawSummaryHtml);
  const shortDescription = stripVideoTagsAndHtmlToPlainText(rawSummaryHtml).slice(0, 360);

  const developers = Array.from(
    new Set([
      ...(Array.isArray(metaObj?.developers) ? metaObj.developers : []),
      ...(Array.isArray(origMetaObj?.developers) ? origMetaObj.developers : []),
    ])
  )
    .map((d) => (typeof d === 'string' ? d.trim() : String(d?.name || '').trim()))
    .filter(Boolean);

  const publishers = Array.from(
    new Set([
      ...(Array.isArray(metaObj?.publishers) ? metaObj.publishers : []),
      ...(Array.isArray(origMetaObj?.publishers) ? origMetaObj.publishers : []),
    ])
  )
    .map((p) => (typeof p === 'string' ? p.trim() : String(p?.name || '').trim()))
    .filter(Boolean);

  const genres = Array.from(
    new Set([
      ...(Array.isArray(metaObj?.genres) ? metaObj.genres : []),
      ...(Array.isArray(origMetaObj?.genres) ? origMetaObj.genres : []),
    ])
  )
    .map((g) => (typeof g === 'string' ? g.trim() : String(g?.name || '').trim()))
    .filter(Boolean);

  const tags = Array.from(
    new Set([
      ...(Array.isArray(storeTagsObj?.tags)
        ? storeTagsObj.tags.map((/** @type {any} */ t) => (typeof t === 'string' ? t : t?.name))
        : []),
      ...(Array.isArray(metaObj?.themes) ? metaObj.themes : []),
    ])
  )
    .map((t) => String(t || '').trim())
    .filter(Boolean);

  const categories = Array.isArray(storeFeaturesObj?.features)
    ? storeFeaturesObj.features
        .map((/** @type {any} */ f) => String(typeof f === 'string' ? f : f?.name || '').trim())
        .filter(Boolean)
    : [];

  const supportedLanguages = Array.isArray(localizationsObj?.localizations)
    ? Array.from(
        new Set(
          localizationsObj.localizations
            .map((/** @type {any} */ loc) => String(loc?.language || loc?.code || '').trim())
            .filter(Boolean)
        )
      ).join(', ')
    : undefined;

  const supportedOsArr = [
    ...(Array.isArray(osObj?.supported) ? osObj.supported : []),
    ...(Array.isArray(storeOsObj?.supported) ? storeOsObj.supported : []),
  ];
  let platforms = { windows: true, mac: false, linux: false };
  if (supportedOsArr.length > 0) {
    const slugs = supportedOsArr
      .map((item) =>
        String(typeof item === 'string' ? item : item?.slug || item?.name || '').toLowerCase()
      )
      .filter(Boolean);
    platforms = {
      windows: slugs.some((s) => s.includes('win')),
      mac: slugs.some((s) => s.includes('osx') || s.includes('mac')),
      linux: slugs.some((s) => s.includes('linux')),
    };
  }

  const releaseDate =
    formatUnixSecondsOrIsoDate(metaObj?.releaseDate) ||
    formatUnixSecondsOrIsoDate(origMetaObj?.releaseDate) ||
    '';

  const capsuleImage = normalizeGogImageTemplateUrl(origImagesObj?.verticalCover, 'webp');
  const headerImage =
    normalizeGogImageTemplateUrl(origImagesObj?.background, 'webp') ||
    normalizeGogImageTemplateUrl(storeImagesObj?.horizontalCover, 'png');
  const iconUrl = normalizeGogImageTemplateUrl(origImagesObj?.squareIcon, 'webp');

  const screenshotUrls = Array.from(
    new Set([
      ...(Array.isArray(storeMediaObj?.screenshots)
        ? storeMediaObj.screenshots.map((/** @type {any} */ u) =>
            normalizeGogImageTemplateUrl(u, 'jpg')
          )
        : []),
      ...(Array.isArray(mediaObj?.screenshots)
        ? mediaObj.screenshots.map((/** @type {any} */ u) =>
            normalizeGogImageTemplateUrl(u, 'webp')
          )
        : []),
    ])
  ).filter(Boolean);

  const screenshots = screenshotUrls.slice(0, 12).map((url, idx) => ({
    id: idx,
    pathThumbnail: url,
    pathFull: url,
  }));

  const rawCritics = metaObj?.criticsScore ?? origMetaObj?.criticsScore;
  const rawUserScore = reviewScoreObj?.score?.value ?? reviewScoreObj?.value;
  const gogCriticScoreVal =
    typeof rawCritics === 'number' && rawCritics > 0 ? Math.round(rawCritics) : undefined;
  const gogUserReviewScoreVal =
    typeof rawUserScore === 'number' && rawUserScore > 0
      ? Math.round(rawUserScore <= 5 ? rawUserScore * 20 : rawUserScore)
      : undefined;
  const gogReviewScoreVal = gogCriticScoreVal ?? gogUserReviewScoreVal;

  if (
    !name &&
    !shortDescription &&
    developers.length === 0 &&
    publishers.length === 0 &&
    genres.length === 0 &&
    !capsuleImage &&
    !headerImage &&
    screenshots.length === 0
  ) {
    return null;
  }

  return {
    appId: 0,
    gogId: cleanGogId,
    isDlc,
    name: name || undefined,
    title: name || undefined,
    shortDescription,
    detailedDescription: detailedDescription || shortDescription,
    aboutTheGame: detailedDescription || shortDescription,
    headerImage: headerImage || undefined,
    capsuleImage: capsuleImage || undefined,
    iconUrl: iconUrl || undefined,
    developers,
    publishers,
    genres,
    tags,
    categories,
    ...(supportedLanguages ? { supportedLanguages } : {}),
    screenshots,
    movies: [],
    releaseDate,
    platforms,
    ...(gogCriticScoreVal ? { gogCriticScore: gogCriticScoreVal } : {}),
    ...(gogReviewScoreVal ? { reviewScore: gogReviewScoreVal } : {}),
    metadataQuality: 'local_federated',
  };
}

/**
 * Resolves local GOG metadata from `galaxy-2.0.db` (`GamePieces` joined with `GamePieceTypes`).
 *
 * @param {string | number} gogId
 * @param {Record<string, any>} [options]
 */
function resolveLocalGogMetadata(gogId, options = {}) {
  const cleanGogId = String(gogId || '').replace(/^gog[-_]/i, '').trim();
  if (!cleanGogId || !/^\d+$/.test(cleanGogId)) return null;

  const DatabaseSync = getSqliteDatabaseSync();
  if (!DatabaseSync) return null;

  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);

  for (const gogRoot of roots.gogRoots || []) {
    const dbPath = resolveGogDbPathForRoot(gogRoot);
    if (!dbPath) continue;

    const snapshot = loadGogGalaxyDbSnapshot(dbPath, DatabaseSync);
    if (!snapshot) continue;

    if (snapshot.parsedMetaByGogId.has(cleanGogId)) {
      const cachedParsed = snapshot.parsedMetaByGogId.get(cleanGogId);
      if (cachedParsed) return cachedParsed;
      continue;
    }

    const piecesByType = snapshot.piecesByGogId.get(cleanGogId);
    if (piecesByType && piecesByType.size > 0) {
      const parsed = parseGogPiecesMapToMetadata(cleanGogId, piecesByType);
      snapshot.parsedMetaByGogId.set(cleanGogId, parsed || null);
      if (parsed) return parsed;
    } else {
      snapshot.parsedMetaByGogId.set(cleanGogId, null);
    }
  }

  return null;
}

/**
 * Enumerates owned/installed GOG games from local `galaxy-2.0.db`.
 *
 * @param {Record<string, any>} [filterOptions]
 */
function listLocalGogCatalogGames(filterOptions = {}) {
  const options = filterOptions && typeof filterOptions === 'object' ? filterOptions : {};
  const DatabaseSync = getSqliteDatabaseSync();
  if (!DatabaseSync) return [];

  const expectedUserId = String(options.gogUserId || options.userId || '').trim();
  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);
  const gamesById = new Map();

  for (const gogRoot of roots.gogRoots || []) {
    const dbPath = resolveGogDbPathForRoot(gogRoot);
    if (!dbPath) continue;

    const snapshot = loadGogGalaxyDbSnapshot(dbPath, DatabaseSync);
    if (!snapshot || !(snapshot.visibleLibraryUsersByGogId instanceof Map)) continue;

    for (const [gogId, piecesMap] of snapshot.piecesByGogId.entries()) {
      if (gamesById.has(gogId)) continue;
      if (!snapshot.visibleLibraryUsersByGogId.has(gogId)) continue;
      if (expectedUserId) {
        const users = snapshot.visibleLibraryUsersByGogId.get(gogId);
        if (!users || (!users.has(expectedUserId) && !users.has('') && !users.has('*'))) {
          continue;
        }
      }
      let meta = snapshot.parsedMetaByGogId.get(gogId);
      if (meta === undefined) {
        meta = parseGogPiecesMapToMetadata(gogId, piecesMap) || null;
        snapshot.parsedMetaByGogId.set(gogId, meta);
      }
      if (!meta || !meta.title || meta.isDlc) continue;
      gamesById.set(gogId, meta);
    }
  }

  return Array.from(gamesById.values());
}

function clearGogFederatorCaches() {
  gogGalaxyDbSnapshotLookup.clear();
  gogRootWebCacheDirLookup.clear();
}

module.exports = {
  loadGogGalaxyDbSnapshot,
  resolveGogFederatedAsset,
  resolveGogFederatedAssetAsync,
  parseGogPiecesMapToMetadata,
  resolveLocalGogMetadata,
  listLocalGogCatalogGames,
  clearGogFederatorCaches,
};
