// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadSavedTokens } = require('../tokenVault.cjs');
const { classifyNonGameStorefrontItem } = require('../nonGameClassifier.cjs');
const { GOG_CLIENT_ID } = require('./storeSyncShared.cjs');
const { getLocalLegendaryBaseDirs } = require('../epic/epicAuthAndNamespaces.cjs');

const MAX_SUPPRESSED_EPIC_CACHE_ENTRIES = 4000;
const MAX_SUPPRESSED_GOG_CACHE_ENTRIES = 128;

/** @type {Map<string, { mtimeMs: number, size: number, entry: any }>} */
const suppressedEpicMetaFileCache = new Map();
/** @type {Map<string, { mtimeMs: number, size: number, entries: any[] }>} */
const suppressedGogCacheFileCache = new Map();

/**
 * Scans local storefront metadata caches (Legendary/Heroic Epic metadata, Heroic GOG library cache,
 * saved Steam tokens) to discover owned non-game items (betas, test branches, prologues, tools,
 * soundtracks/artbooks, DLCs) for the Library Match & Overrides Studio while keeping them
 * suppressed from the main game library.
 *
 * @param {Record<string, any>} [customOptions]
 * @returns {any[]}
 */
function scanLocalSuppressedStorefrontItems(customOptions = {}) {
  /** @type {Map<string, any>} */
  const resultsMap = new Map();
  const hasExplicitIsolation = Boolean(customOptions.homedir || customOptions.userDataDir);
  const homeDir = customOptions.homedir || process.env.HOME || process.env.USERPROFILE || '';
  const allowUnverifiedLocalCache = customOptions.allowUnverifiedLocalCache === true;

  /** @type {Record<string, any>} */
  let savedTokens = {};
  try {
    savedTokens = loadSavedTokens(customOptions) || {};
  } catch {
    savedTokens = {};
  }
  const rawEpicAccountId =
    customOptions.epicAccountId !== undefined
      ? customOptions.epicAccountId
      : savedTokens?.epic?.account_id;
  const expectedEpicAccountId =
    typeof rawEpicAccountId === 'string' ? rawEpicAccountId.trim().toLowerCase() : '';
  const rawGogUserId =
    customOptions.gogUserId !== undefined
      ? customOptions.gogUserId
      : savedTokens?.gog?.user_id || savedTokens?.gog?.userId;
  const expectedGogUserId =
    rawGogUserId !== undefined && rawGogUserId !== null ? String(rawGogUserId).trim() : '';
  const hasConnectedGogSession = Boolean(
    expectedGogUserId ||
      (typeof savedTokens?.gog?.access_token === 'string' &&
        savedTokens.gog.access_token.trim().length > 0)
  );

  /** @param {any} entry */
  const addSuppressedEntry = (entry) => {
    if (!entry || !entry.platformId || !entry.platformGameId || !entry.rawTitle) return;
    const key = `${entry.platformId}:${entry.platformGameId}`;
    if (!resultsMap.has(key)) {
      resultsMap.set(key, entry);
    }
  };

  // 1. Scan Legendary / Heroic Epic metadata directories (mtimeMs-cached per JSON file)
  const legendaryDirs =
    allowUnverifiedLocalCache || expectedEpicAccountId
      ? customOptions.legendaryDirs ||
        customOptions.legendaryBaseDirs ||
        getLocalLegendaryBaseDirs(customOptions)
      : [];
  for (const baseDir of legendaryDirs) {
    const metaDir = fs.existsSync(path.join(baseDir, 'metadata'))
      ? path.join(baseDir, 'metadata')
      : path.basename(baseDir).toLowerCase() === 'metadata' && fs.existsSync(baseDir)
        ? baseDir
        : '';
    if (!metaDir) continue;
    if (!allowUnverifiedLocalCache) {
      const userJsonPath = path.join(path.dirname(metaDir), 'user.json');
      if (!fs.existsSync(userJsonPath)) {
        continue;
      }
      try {
        const userJson = JSON.parse(fs.readFileSync(userJsonPath, 'utf-8'));
        const localAccountId = String(userJson?.account_id || '').trim().toLowerCase();
        if (!localAccountId || localAccountId !== expectedEpicAccountId) {
          continue;
        }
      } catch {
        continue;
      }
    }
    try {
      const files = fs.readdirSync(metaDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const fullMetaPath = path.join(metaDir, file);
        try {
          const st = fs.statSync(fullMetaPath);
          const cached = suppressedEpicMetaFileCache.get(fullMetaPath);
          if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
            if (cached.entry) {
              addSuppressedEntry(cached.entry);
            }
            continue;
          }

          const json = JSON.parse(fs.readFileSync(fullMetaPath, 'utf-8'));
          const appName = String(json?.app_name || file.replace(/\.json$/i, '')).trim();
          const title = String(json?.app_title || json?.metadata?.title || '').trim();
          if (
            !appName ||
            !title ||
            title === '1' ||
            title === 'Live' ||
            /^[0-9a-f]{20,}$/i.test(title)
          ) {
            suppressedEpicMetaFileCache.set(fullMetaPath, {
              mtimeMs: st.mtimeMs,
              size: st.size,
              entry: null,
            });
            continue;
          }
          const ns = json?.metadata?.namespace || json?.namespace || '';
          if (
            ns === 'ue' ||
            ns === '89efe5924d3d467c839449ab6ab52e7f' ||
            String(ns).startsWith('ue-')
          ) {
            suppressedEpicMetaFileCache.set(fullMetaPath, {
              mtimeMs: st.mtimeMs,
              size: st.size,
              entry: null,
            });
            continue;
          }

          const categories = json?.metadata?.categories || [];
          const mainGameItem = json?.metadata?.mainGameItem || null;
          const hasMainGame = Boolean(
            mainGameItem && (mainGameItem.id || mainGameItem.namespace)
          );
          const itemType = json?.metadata?.itemType || '';
          const reason = classifyNonGameStorefrontItem({
            store: 'epic',
            title,
            platformId: 'epic',
            platformGameId: appName,
            catalogItemId: json?.metadata?.id || json?.catalog_item_id || '',
            namespace: ns,
            isDlc: hasMainGame,
            mainGameItem,
            itemType,
            categories,
          });

          let entry = null;
          if (reason) {
            const keyImages = json?.metadata?.keyImages || [];
            const tallCover =
              (Array.isArray(keyImages) &&
                keyImages.find(
                  (img) => img.type === 'DieselGameBoxTall' || img.type === 'OfferImageTall'
                )?.url) ||
              '';
            const wideBanner =
              (Array.isArray(keyImages) &&
                keyImages.find(
                  (img) => img.type === 'DieselGameBox' || img.type === 'OfferImageWide'
                )?.url) ||
              tallCover ||
              '';
            const developer = json?.metadata?.developer || '';
            const description = json?.metadata?.description || '';
            const catId = json?.metadata?.id || json?.catalog_item_id || undefined;

            const rawGame = {
              id: `epic-${appName}`,
              title,
              originalStoreTitle: title,
              sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
              isVerifiedEntitlement: true,
              platforms: [
                {
                  platformId: 'epic',
                  platformGameId: appName,
                  originalTitle: title,
                  namespace: ns || undefined,
                  catalogItemId: catId,
                  installed: false,
                },
              ],
              headerImage: wideBanner,
              capsuleImage: tallCover || wideBanner,
              shortDescription: description,
              releaseDate: '',
              developers: developer ? [developer] : [],
              publishers: ['Epic Games Store'],
              genres: [],
              tags: ['Epic Games Store'],
            };

            entry = {
              id: `epic-${appName}`,
              rawTitle: title,
              platformId: 'epic',
              platformGameId: appName,
              reason,
              reasonCategory: 'non_game_filter',
              rawGame,
            };
            addSuppressedEntry(entry);
          }

          if (suppressedEpicMetaFileCache.size > MAX_SUPPRESSED_EPIC_CACHE_ENTRIES) {
            const firstKey = suppressedEpicMetaFileCache.keys().next().value;
            if (firstKey !== undefined) suppressedEpicMetaFileCache.delete(firstKey);
          }
          suppressedEpicMetaFileCache.set(fullMetaPath, {
            mtimeMs: st.mtimeMs,
            size: st.size,
            entry,
          });
        } catch {}
      }
    } catch {}
  }

  // 2. Scan Heroic GOG library cache (gog_library.json, mtimeMs-cached, bounded)
  const gogCacheFiles =
    allowUnverifiedLocalCache || hasConnectedGogSession
      ? customOptions.gogCacheFiles ||
        [
          homeDir
            ? path.join(homeDir, 'Library/Application Support/heroic/store_cache/gog_library.json')
            : '',
          homeDir ? path.join(homeDir, '.config/heroic/store_cache/gog_library.json') : '',
          !hasExplicitIsolation && process.env.APPDATA
            ? path.join(process.env.APPDATA, 'heroic/store_cache/gog_library.json')
            : '',
        ].filter(Boolean)
      : [];

  for (const gogFile of gogCacheFiles) {
    if (!fs.existsSync(gogFile)) continue;
    if (!allowUnverifiedLocalCache) {
      const heroicGogAuthPath = path.join(
        path.dirname(path.dirname(gogFile)),
        'gog_store',
        'auth.json'
      );
      if (!fs.existsSync(heroicGogAuthPath)) {
        continue;
      }
      try {
        const authJson = JSON.parse(fs.readFileSync(heroicGogAuthPath, 'utf-8'));
        const authEntry =
          authJson?.[GOG_CLIENT_ID] || authJson?.['46899977096215655'] || authJson;
        const hasActiveHeroicSession = Boolean(
          String(authEntry?.access_token || authEntry?.refresh_token || '').trim()
        );
        if (!hasActiveHeroicSession) {
          continue;
        }
        const localGogUserId = String(authEntry?.user_id || authEntry?.userId || '').trim();
        if (expectedGogUserId && (!localGogUserId || localGogUserId !== expectedGogUserId)) {
          continue;
        }
      } catch {
        continue;
      }
    }
    try {
      const st = fs.statSync(gogFile);
      const cachedGog = suppressedGogCacheFileCache.get(gogFile);
      if (cachedGog && cachedGog.mtimeMs === st.mtimeMs && cachedGog.size === st.size) {
        for (const ent of cachedGog.entries) {
          addSuppressedEntry(ent);
        }
        continue;
      }

      const fileEntries = [];
      const json = JSON.parse(fs.readFileSync(gogFile, 'utf-8'));
      const gamesList = Array.isArray(json?.games) ? json.games : [];
      for (const item of gamesList) {
        if (item?.is_visible_in_library === false || item?.isVisibleInLibrary === false) {
          continue;
        }
        const appName = String(item?.app_name || '').trim();
        const title = String(item?.title || '').trim();
        if (!appName || !title) continue;
        const isDlc = Boolean(item?.install?.is_dlc);
        const reason = classifyNonGameStorefrontItem({
          title,
          platformId: 'gog',
          platformGameId: appName,
          isDlc,
        });
        if (reason) {
          const headerImg = item?.art_cover || item?.art_square || '';
          const capsuleImg = item?.art_square || item?.art_cover || '';
          const rawGame = {
            id: `gog-${appName}`,
            title,
            originalStoreTitle: title,
            sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
            isVerifiedEntitlement: true,
            platforms: [
              {
                platformId: 'gog',
                platformGameId: appName,
                originalTitle: title,
                installed: false,
              },
            ],
            headerImage: headerImg,
            capsuleImage: capsuleImg,
            shortDescription: item?.extra?.about?.description || '',
            releaseDate: '',
            developers: item?.developer ? [item.developer] : [],
            publishers: [],
            genres: Array.isArray(item?.extra?.genres) ? item.extra.genres : [],
            tags: ['GOG', 'DRM-Free'],
          };
          const ent = {
            id: `gog-${appName}`,
            rawTitle: title,
            platformId: 'gog',
            platformGameId: appName,
            reason,
            reasonCategory: 'non_game_filter',
            rawGame,
          };
          fileEntries.push(ent);
          addSuppressedEntry(ent);
        }
      }
      if (suppressedGogCacheFileCache.size >= MAX_SUPPRESSED_GOG_CACHE_ENTRIES) {
        const oldestKey = suppressedGogCacheFileCache.keys().next().value;
        if (oldestKey !== undefined) suppressedGogCacheFileCache.delete(oldestKey);
      }
      suppressedGogCacheFileCache.set(gogFile, {
        mtimeMs: st.mtimeMs,
        size: st.size,
        entries: fileEntries,
      });
    } catch {}
  }

  // 3. Also check saved Steam tokens games list for any non-game entries
  try {
    const steamGames = Array.isArray(savedTokens?.steam?.games) ? savedTokens.steam.games : [];
    for (const g of steamGames) {
      const title = String(g?.title || '').trim();
      const appId = String(
        g?.steamAppId || g?.platforms?.[0]?.platformGameId || g?.id || ''
      ).replace(/^steam-/, '');
      if (!title || !appId) continue;
      const reason = classifyNonGameStorefrontItem({
        title,
        platformId: 'steam',
        platformGameId: appId,
        isDlc: false,
      });
      if (reason) {
        addSuppressedEntry({
          id: `steam-${appId}`,
          rawTitle: title,
          platformId: 'steam',
          platformGameId: appId,
          reason,
          reasonCategory: 'non_game_filter',
          rawGame: {
            ...g,
            id: `steam-${appId}`,
            originalStoreTitle: g.originalStoreTitle || title,
            isVerifiedEntitlement: true,
          },
        });
      }
    }
  } catch {}

  return Array.from(resultsMap.values());
}

function trimSuppressedItemsScannerMemory() {
  suppressedEpicMetaFileCache.clear();
  suppressedGogCacheFileCache.clear();
}

module.exports = {
  scanLocalSuppressedStorefrontItems,
  trimSuppressedItemsScannerMemory,
};
