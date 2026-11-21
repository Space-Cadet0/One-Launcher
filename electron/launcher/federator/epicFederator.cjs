// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isContainedWithinRoot } = require('../securityAndPathUtils.cjs');
const { diagLog } = require('../../utils/diagnosticLogger.cjs');
const {
  getSqliteDatabaseSync,
  isExistingDirectory,
  isExistingDirectoryAsync,
  isExistingFile,
  isExistingFileAsync,
  validateFederatedImageFile,
  validateFederatedImageFileAsync,
  discoverStorefrontCacheRoots,
  discoverStorefrontCacheRootsAsync,
  formatUnixSecondsOrIsoDate,
  stripVideoTagsAndHtmlToPlainText,
  sanitizeOfflineHtmlRemovingVideos,
} = require('./cacheRootDiscovery.cjs');

/**
 * Checks Heroic Games Launcher's `images-cache/<sha256(upstreamUrl)>` directory.
 *
 * @param {string} url
 * @param {any} roots
 * @param {Record<string, any>} [options]
 */
function resolveHeroicImagesCacheAsset(url, roots, options = {}) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
    return null;
  }
  const cleanUrl = url.trim();
  const shaHex = crypto.createHash('sha256').update(cleanUrl).digest('hex');

  for (const heroicRoot of roots.heroicRoots || []) {
    const imgCacheDir = path.join(heroicRoot, 'images-cache');
    if (!isExistingDirectory(imgCacheDir)) continue;

    const candidates = [
      path.join(imgCacheDir, shaHex),
      path.join(imgCacheDir, `${shaHex}.webp`),
      path.join(imgCacheDir, `${shaHex}.jpg`),
      path.join(imgCacheDir, `${shaHex}.png`),
    ];
    for (const candidate of candidates) {
      const validated = validateFederatedImageFile(candidate, imgCacheDir, options);
      if (validated.valid) {
        return {
          path: validated.path,
          mimeType: validated.mimeType,
          ext: validated.ext,
          sizeBytes: validated.sizeBytes,
          source: 'heroic_images_cache',
        };
      }
    }
  }

  return null;
}

/**
 * Async variant of `resolveHeroicImagesCacheAsset` using `fs.promises`.
 *
 * @param {string} url
 * @param {any} roots
 * @param {Record<string, any>} [options]
 */
async function resolveHeroicImagesCacheAssetAsync(url, roots, options = {}) {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
    return null;
  }
  const cleanUrl = url.trim();
  const shaHex = crypto.createHash('sha256').update(cleanUrl).digest('hex');

  for (const heroicRoot of roots.heroicRoots || []) {
    const imgCacheDir = path.join(heroicRoot, 'images-cache');
    if (!(await isExistingDirectoryAsync(imgCacheDir))) continue;

    const candidates = [
      path.join(imgCacheDir, shaHex),
      path.join(imgCacheDir, `${shaHex}.webp`),
      path.join(imgCacheDir, `${shaHex}.jpg`),
      path.join(imgCacheDir, `${shaHex}.png`),
    ];
    for (const candidate of candidates) {
      const validated = await validateFederatedImageFileAsync(candidate, imgCacheDir, options);
      if (validated.valid) {
        return {
          path: validated.path,
          mimeType: validated.mimeType,
          ext: validated.ext,
          sizeBytes: validated.sizeBytes,
          source: 'heroic_images_cache',
        };
      }
    }
  }

  return null;
}

/**
 * @param {any} json
 * @param {string} [fallbackAppName]
 */
function parseLegendaryMetadataJson(json, fallbackAppName) {
  if (!json || typeof json !== 'object') return null;
  const meta = json.metadata && typeof json.metadata === 'object' ? json.metadata : json;
  const appName = String(json.app_name || meta.app_name || fallbackAppName || '').trim();
  const title = String(json.app_title || meta.title || '').trim();
  if (!appName || appName === '1') return null;
  if (json.sandboxType === 'PRIVATE' || meta.sandboxType === 'PRIVATE') return null;
  if (appName.startsWith('Fortnite_')) return null;

  const namespace = String(meta.namespace || json.namespace || '').trim();
  if (
    namespace === 'ue' ||
    namespace === '89efe5924d3d467c839449ab6ab52e7f' ||
    namespace.startsWith('ue-')
  ) {
    return null;
  }

  const itemTypeUpper = String(meta.itemType || json.itemType || '')
    .trim()
    .toUpperCase();
  if (
    [
      'ADD_ON',
      'DLC',
      'CONSUMABLE',
      'WALLET',
      'SUBSCRIPTION',
      'PLUGIN',
      'EXTRA',
      'CURRENCY',
      'ENGINE',
      'EDITOR',
      'LEARNING',
      'INVALID',
    ].includes(itemTypeUpper)
  ) {
    return null;
  }

  const rawCategories = Array.isArray(meta.categories)
    ? meta.categories
    : Array.isArray(json.categories)
      ? json.categories
      : [];
  const categoryPaths = rawCategories
    .map((/** @type {any} */ c) => String(typeof c === 'string' ? c : c?.path || '').trim().toLowerCase())
    .filter(Boolean);
  if (categoryPaths.length > 0) {
    const categorySegments = new Set();
    for (const cp of categoryPaths) {
      categorySegments.add(cp);
      for (const seg of cp.split('/')) {
        if (seg) categorySegments.add(seg);
      }
    }
    const hasNonGameCategory = [
      'addons',
      'dlc',
      'mods',
      'digitalextras',
      'consumable',
      'vault',
      'engines',
      'plugins',
      'assets',
    ].some((sub) => categorySegments.has(sub));
    if (hasNonGameCategory) return null;

    if (categorySegments.has('applications') && !categorySegments.has('games')) {
      return null;
    }
  }

  const isDlc = Boolean(
    meta.mainGameItem && (meta.mainGameItem.id || meta.mainGameItem.namespace)
  );

  const rawDesc = String(meta.description || json.description || '').trim();
  const rawLong = String(meta.longDescription || meta.technicalDetails || '').trim();
  const shortDescription = stripVideoTagsAndHtmlToPlainText(rawDesc || rawLong).slice(0, 360);
  const detailedDescription = sanitizeOfflineHtmlRemovingVideos(rawLong || rawDesc);

  const developer = String(meta.developer || json.developer || '').trim();
  const publisher = String(meta.publisher || json.publisher || '').trim();

  const releaseInfo = Array.isArray(meta.releaseInfo) ? meta.releaseInfo : [];
  let rawReleaseDate = meta.releaseDate || meta.creationDate || '';
  if (!rawReleaseDate && releaseInfo.length > 0 && releaseInfo[0]?.dateAdded) {
    rawReleaseDate = releaseInfo[0].dateAdded;
  }
  const releaseDate = formatUnixSecondsOrIsoDate(rawReleaseDate) || '';

  const hasMacAsset = Boolean(json.asset_infos?.Mac && Object.keys(json.asset_infos.Mac).length > 0);
  const hasMacRelease = releaseInfo.some(
    (/** @type {any} */ r) =>
      r &&
      Array.isArray(r.platform) &&
      r.platform.some((/** @type {any} */ p) => /^mac$/i.test(String(p)))
  );

  const keyImages = Array.isArray(meta.keyImages)
    ? meta.keyImages
    : Array.isArray(json.keyImages)
      ? json.keyImages
      : [];

  /** @param {string[]} types */
  const findKeyImageUrl = (types) => {
    for (const t of types) {
      const hit = keyImages.find(
        (/** @type {any} */ img) =>
          img &&
          typeof img.url === 'string' &&
          /^https?:\/\//i.test(img.url) &&
          img.type === t &&
          !/\.(?:mp4|webm|m3u8|ts)(?:$|\?)/i.test(img.url)
      );
      if (hit) return hit.url;
    }
    return undefined;
  };

  const capsuleImage = findKeyImageUrl(['DieselGameBoxTall', 'OfferImageTall']);
  const headerImage = findKeyImageUrl([
    'DieselGameBox',
    'OfferImageWide',
    'Thumbnail',
    'DieselStoreFrontWide',
  ]);
  const screenshotUrls = keyImages
    .filter(
      (/** @type {any} */ img) =>
        img &&
        typeof img.url === 'string' &&
        /^https?:\/\//i.test(img.url) &&
        ['featuredMedia', 'GalleryImage', 'Screenshot'].includes(img.type) &&
        !/\.(?:mp4|webm|m3u8|ts)(?:$|\?)/i.test(img.url)
    )
    .map((/** @type {any} */ img) => img.url);

  const screenshots = Array.from(new Set(screenshotUrls)).map((url, idx) => ({
    id: idx,
    pathThumbnail: url,
    pathFull: url,
  }));

  return {
    appId: 0,
    appName,
    isDlc,
    namespace: meta.namespace || json.namespace || undefined,
    catalogItemId: meta.id || json.catalog_item_id || json.id || undefined,
    name: title || undefined,
    title: title || undefined,
    shortDescription,
    detailedDescription: detailedDescription || shortDescription,
    aboutTheGame: detailedDescription || shortDescription,
    headerImage: headerImage || capsuleImage,
    capsuleImage: capsuleImage || headerImage,
    keyImages,
    releaseInfo,
    developers: developer ? [developer] : [],
    publishers: publisher ? [publisher] : ['Epic Games Store'],
    genres: [],
    tags: ['Epic Games Store'],
    categories: [],
    screenshots,
    movies: [],
    releaseDate,
    platforms: {
      windows: true,
      mac: hasMacAsset || hasMacRelease,
      linux: false,
    },
    metadataQuality: 'local_federated',
  };
}

/**
 * Resolves local Epic / Legendary / Heroic metadata from `<legendaryDir>/metadata/<appName>.json`.
 *
 * @param {string} appName
 * @param {Record<string, any>} [options]
 */
function resolveLocalEpicMetadata(appName, options = {}) {
  const cleanAppName = String(appName || '').replace(/^epic[-_]/i, '').trim();
  const normTargetTitle = String(options.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!cleanAppName && !normTargetTitle) return null;

  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);

  if (cleanAppName && !cleanAppName.includes('..') && !/[\\/]/.test(cleanAppName)) {
    for (const legDir of roots.legendaryDirs || []) {
      const exactFile = path.join(legDir, 'metadata', `${cleanAppName}.json`);
      if (isExistingFile(exactFile) && isContainedWithinRoot(legDir, exactFile, options.platform)) {
        try {
          const json = JSON.parse(fs.readFileSync(exactFile, 'utf8'));
          const parsed = parseLegendaryMetadataJson(json, cleanAppName);
          if (parsed) return parsed;
        } catch {}
      }
    }
  }

  const lowerApp = cleanAppName.toLowerCase();
  for (const legDir of roots.legendaryDirs || []) {
    const metaDir = path.join(legDir, 'metadata');
    if (!isExistingDirectory(metaDir)) continue;
    try {
      const files = fs.readdirSync(metaDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const stemLower = f.slice(0, -5).toLowerCase();
        if (lowerApp && stemLower === lowerApp) {
          const fp = path.join(metaDir, f);
          if (!isContainedWithinRoot(legDir, fp, options.platform)) continue;
          try {
            const json = JSON.parse(fs.readFileSync(fp, 'utf8'));
            const parsed = parseLegendaryMetadataJson(json, f.slice(0, -5));
            if (parsed) return parsed;
          } catch {}
        }
      }
      if (normTargetTitle) {
        for (const f of files) {
          if (!f.endsWith('.json')) continue;
          const fp = path.join(metaDir, f);
          if (!isContainedWithinRoot(legDir, fp, options.platform)) continue;
          try {
            const json = JSON.parse(fs.readFileSync(fp, 'utf8'));
            const candTitle = String(json?.app_title || json?.metadata?.title || '')
              .toLowerCase()
              .replace(/[^a-z0-9]/g, '');
            if (candTitle && candTitle === normTargetTitle) {
              const parsed = parseLegendaryMetadataJson(json, f.slice(0, -5));
              if (parsed) return parsed;
            }
          } catch {}
        }
      }
    } catch {}
  }

  return null;
}

/**
 * Async variant of `resolveLocalEpicMetadata` using `fs.promises` so Tier-2 Epic metadata walks
 * never block Electron's main thread.
 *
 * @param {string} appName
 * @param {Record<string, any>} [options]
 */
async function resolveLocalEpicMetadataAsync(appName, options = {}) {
  const cleanAppName = String(appName || '').replace(/^epic[-_]/i, '').trim();
  const normTargetTitle = String(options.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!cleanAppName && !normTargetTitle) return null;

  const roots = options._precomputedRoots || (await discoverStorefrontCacheRootsAsync(options));

  if (cleanAppName && !cleanAppName.includes('..') && !/[\\/]/.test(cleanAppName)) {
    for (const legDir of roots.legendaryDirs || []) {
      const exactFile = path.join(legDir, 'metadata', `${cleanAppName}.json`);
      if (
        (await isExistingFileAsync(exactFile)) &&
        isContainedWithinRoot(legDir, exactFile, options.platform)
      ) {
        try {
          const json = JSON.parse(await fs.promises.readFile(exactFile, 'utf8'));
          const parsed = parseLegendaryMetadataJson(json, cleanAppName);
          if (parsed) return parsed;
        } catch {}
      }
    }
  }

  const lowerApp = cleanAppName.toLowerCase();
  for (const legDir of roots.legendaryDirs || []) {
    const metaDir = path.join(legDir, 'metadata');
    if (!(await isExistingDirectoryAsync(metaDir))) continue;
    try {
      const files = await fs.promises.readdir(metaDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const stemLower = f.slice(0, -5).toLowerCase();
        if (lowerApp && stemLower === lowerApp) {
          const fp = path.join(metaDir, f);
          if (!isContainedWithinRoot(legDir, fp, options.platform)) continue;
          try {
            const json = JSON.parse(await fs.promises.readFile(fp, 'utf8'));
            const parsed = parseLegendaryMetadataJson(json, f.slice(0, -5));
            if (parsed) return parsed;
          } catch {}
        }
      }
      if (normTargetTitle) {
        for (const f of files) {
          if (!f.endsWith('.json')) continue;
          const fp = path.join(metaDir, f);
          if (!isContainedWithinRoot(legDir, fp, options.platform)) continue;
          try {
            const json = JSON.parse(await fs.promises.readFile(fp, 'utf8'));
            const candTitle = String(json?.app_title || json?.metadata?.title || '')
              .toLowerCase()
              .replace(/[^a-z0-9]/g, '');
            if (candTitle && candTitle === normTargetTitle) {
              const parsed = parseLegendaryMetadataJson(json, f.slice(0, -5));
              if (parsed) return parsed;
            }
          } catch {}
        }
      }
    } catch {}
  }

  return null;
}

/**
 * Enumerates all local Legendary `metadata/*.json` base games with optional Epic account verification.
 *
 * @param {Record<string, any>} [filterOptions]
 */
function listLocalEpicCatalogGames(filterOptions = {}) {
  const options = filterOptions && typeof filterOptions === 'object' ? filterOptions : {};
  const expectedAccountId = String(options.epicAccountId || options.accountId || '')
    .trim()
    .toLowerCase();
  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);
  const byAppName = new Map();

  for (const legDir of roots.legendaryDirs || []) {
    const metaDir = isExistingDirectory(path.join(legDir, 'metadata'))
      ? path.join(legDir, 'metadata')
      : path.basename(legDir).toLowerCase() === 'metadata' && isExistingDirectory(legDir)
        ? legDir
        : '';
    if (!metaDir) continue;

    const containRoot = path.dirname(metaDir);
    const userJsonPath = path.join(containRoot, 'user.json');
    if (!isExistingFile(userJsonPath)) continue;
    let localAccountId = '';
    try {
      const userJson = JSON.parse(fs.readFileSync(userJsonPath, 'utf8'));
      localAccountId = String(userJson?.account_id || '').trim().toLowerCase();
    } catch {
      localAccountId = '';
    }
    if (!localAccountId) continue;
    if (expectedAccountId && localAccountId !== expectedAccountId) continue;

    try {
      for (const f of fs.readdirSync(metaDir)) {
        if (!f.endsWith('.json')) continue;
        const fp = path.join(metaDir, f);
        if (!isContainedWithinRoot(containRoot, fp, options.platform)) continue;
        try {
          const json = JSON.parse(fs.readFileSync(fp, 'utf8'));
          const parsed = parseLegendaryMetadataJson(json, f.slice(0, -5));
          if (!parsed || parsed.isDlc || !parsed.appName || !parsed.title) continue;
          const key = parsed.appName.toLowerCase();
          if (!byAppName.has(key)) {
            byAppName.set(key, parsed);
          }
        } catch {}
      }
    } catch {}
  }

  return Array.from(byAppName.values());
}

/**
 * Resolves local Amazon Games metadata from `GameProductInfo.sqlite` (read-only `DatabaseSync`).
 *
 * @param {string} productId
 * @param {Record<string, any>} [options]
 */
function resolveLocalAmazonMetadata(productId, options = {}) {
  const cleanId = String(productId || '').replace(/^amazon[-_]/i, '').trim();
  if (!cleanId) return null;

  const DatabaseSync = getSqliteDatabaseSync();
  if (!DatabaseSync) return null;

  const roots = options._precomputedRoots || discoverStorefrontCacheRoots(options);

  for (const dbPath of roots.amazonDbPaths || []) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((/** @type {any} */ r) => r.name);
      const targetTable = tables.includes('DbSet')
        ? 'DbSet'
        : tables.includes('Products')
          ? 'Products'
          : null;
      if (!targetTable) continue;

      const row = db.prepare(`SELECT * FROM "${targetTable}" WHERE Id = ? LIMIT 1`).get(cleanId);
      if (!row) continue;

      const title = String(row.ProductTitle || row.Title || '').trim();
      const rawDesc = String(row.ProductDescription || row.Description || '').trim();
      const shortDescription = stripVideoTagsAndHtmlToPlainText(rawDesc).slice(0, 360);
      const devStr = String(row.Developers || row.Developer || '').trim();
      const pubStr = String(row.ProductPublisher || row.Publisher || '').trim();
      const releaseDate = formatUnixSecondsOrIsoDate(row.ReleaseDate) || '';
      const iconUrl =
        typeof row.ProductIconUrl === 'string' && /^https?:\/\//i.test(row.ProductIconUrl)
          ? row.ProductIconUrl
          : undefined;
      const capsuleImage =
        typeof row.BoxArtUrl === 'string' && /^https?:\/\//i.test(row.BoxArtUrl)
          ? row.BoxArtUrl
          : iconUrl;
      const headerImage =
        typeof row.BackgroundUrl === 'string' && /^https?:\/\//i.test(row.BackgroundUrl)
          ? row.BackgroundUrl
          : capsuleImage;

      return {
        appId: 0,
        amazonId: cleanId,
        name: title || undefined,
        title: title || undefined,
        shortDescription,
        detailedDescription: sanitizeOfflineHtmlRemovingVideos(rawDesc) || shortDescription,
        aboutTheGame: sanitizeOfflineHtmlRemovingVideos(rawDesc) || shortDescription,
        headerImage,
        capsuleImage,
        iconUrl,
        developers: devStr ? devStr.split(',').map((s) => s.trim()).filter(Boolean) : [],
        publishers: pubStr ? [pubStr] : [],
        genres: [],
        tags: ['Amazon Games'],
        categories: [],
        screenshots: [],
        movies: [],
        releaseDate,
        platforms: { windows: true, mac: false, linux: false },
        metadataQuality: 'local_federated',
      };
    } catch (err) {
      diagLog.debug('federator.amazonMetadataQuery', err, { dbPath, cleanId });
    } finally {
      if (db) {
        try {
          db.close();
        } catch {}
      }
    }
  }

  return null;
}

module.exports = {
  resolveHeroicImagesCacheAsset,
  resolveHeroicImagesCacheAssetAsync,
  parseLegendaryMetadataJson,
  resolveLocalEpicMetadata,
  resolveLocalEpicMetadataAsync,
  listLocalEpicCatalogGames,
  resolveLocalAmazonMetadata,
};
