// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadSavedTokensAsync } = require('../tokenVault.cjs');
const {
  buildStoreFetchSignal,
  buildPlatformStoreUserAgent,
  sanitizeSafeHttpsMediaUrl,
  resolveDefaultStoreLocaleAndCountry,
  resolveStoreVaultOptions,
  resolveSafeLegendaryMetaFilePath,
  classifyAchievementRarityTier,
} = require('../sync/storeSyncShared.cjs');
const {
  renewEpicTokens,
  getEpicNamespaceByLookupKey,
  getLocalLegendaryBaseDirs,
  resolveEpicNamespaceAndIds,
} = require('./epicAuthAndNamespaces.cjs');

const MAX_EPIC_PRODUCT_ID_CACHE_ENTRIES = 2000;
const MAX_EPIC_SCHEMA_FILE_CACHE_ENTRIES = 2000;

/** @type {Map<string, string>} */
const epicSandboxProductIdCache = new Map();
/** @type {Map<string, { mtimeMs: number, size: number, summary: Record<string, any> }>} */
const epicSchemaFileCache = new Map();

/**
 * @param {string} sandboxId
 * @param {string} productId
 */
function setBoundedEpicSandboxProductId(sandboxId, productId) {
  const key = String(sandboxId || '').trim().toLowerCase();
  const val = String(productId || '').trim();
  if (!key || !val) return;
  if (epicSandboxProductIdCache.has(key)) epicSandboxProductIdCache.delete(key);
  epicSandboxProductIdCache.set(key, val);
  while (epicSandboxProductIdCache.size > MAX_EPIC_PRODUCT_ID_CACHE_ENTRIES) {
    const oldest = epicSandboxProductIdCache.keys().next().value;
    if (oldest === undefined) break;
    epicSandboxProductIdCache.delete(oldest);
  }
}

/**
 * Detect Epic GraphQL authentication failure across BOTH HTTP 401/403 AND HTTP 200 GraphQL
 * `errors` (`UNAUTHENTICATED`, `token_verification_failed`, etc.) or `{ __typename: 'ServiceError' }` (`C7`).
 *
 * @param {number} status
 * @param {any} json
 * @returns {boolean}
 */
function isEpicGraphqlAuthFailure(status, json) {
  if (status === 401 || status === 403) return true;
  if (!json || typeof json !== 'object') return false;
  if (Array.isArray(json.errors)) {
    for (const err of json.errors) {
      if (!err || typeof err !== 'object') continue;
      const code = String(err.extensions?.code || err.errorCode || '').toUpperCase();
      const msg = String(err.message || '');
      const svcResp = String(err.serviceResponse || '');
      const numCode = Number(err.numericErrorCode || 0);
      if (
        code === 'UNAUTHENTICATED' ||
        code === 'UNAUTHORIZED' ||
        numCode === 1011 ||
        numCode === 1012 ||
        /unauthenticated|unauthorized|token_verification_failed|invalid_token|expired|authentication|401/i.test(
          `${code} ${msg} ${svcResp}`
        )
      ) {
        return true;
      }
    }
  }
  const paNode = json?.data?.PlayerProfile?.playerProfile?.productAchievements;
  if (paNode && typeof paNode === 'object') {
    if (paNode.__typename === 'ServiceError') return true;
    const paStatus = Number(paNode.status || 0);
    if (paStatus === 401 || paStatus === 403) return true;
  }
  return false;
}

/**
 * Compute partial achievement progress for a locked Epic achievement (`progress` in `(0, 1)`).
 *
 * @param {unknown} rawProgress
 * @param {any} statThresholds
 */
function computeEpicPartialProgress(rawProgress, statThresholds) {
  const progress = Number(rawProgress);
  if (!Number.isFinite(progress) || progress <= 0 || progress >= 1) {
    return undefined;
  }

  /** @type {Array<[string, number]>} */
  const thresholdEntries = [];
  if (Array.isArray(statThresholds)) {
    for (const item of statThresholds) {
      const val = Number(item?.threshold ?? item?.value ?? item);
      if (Number.isFinite(val) && val > 1) {
        thresholdEntries.push([String(item?.name || 'stat'), val]);
      }
    }
  } else if (statThresholds && typeof statThresholds === 'object') {
    for (const [k, rawVal] of Object.entries(statThresholds)) {
      const val = Number(rawVal);
      if (Number.isFinite(val) && val > 1) {
        thresholdEntries.push([k, val]);
      }
    }
  }

  const percentage = Math.min(99, Math.max(1, Math.round(progress * 100)));
  if (thresholdEntries.length === 1) {
    const max = Math.round(Number(thresholdEntries[0][1]));
    const current = Math.max(1, Math.min(max - 1, Math.round(progress * max)));
    return {
      current,
      max,
      percentage,
    };
  }

  return {
    current: percentage,
    max: 100,
    percentage,
    unit: '%',
  };
}

/**
 * Step 1 of universal Epic cloud achievements (`Task 10a + 10b`):
 * Public zero-auth `GET api.epicgames.dev/epic/achievements/v1/public/achievements/product/<sandboxId>/locale/<locale>`
 * with backup GraphQL `Achievement.productAchievementsRecordBySandbox`.
 *
 * @param {string} sandboxId
 * @param {Record<string, any>} [options]
 */
async function fetchEpicPublicAchievementSchema(sandboxId, options = {}) {
  const cleanSandbox = String(sandboxId || '').trim();
  if (!cleanSandbox) return null;
  const fetchImpl = typeof options?.fetchFn === 'function' ? options.fetchFn : fetch;
  const { locale } = resolveDefaultStoreLocaleAndCountry(options);
  const effectiveLocale = String(locale || 'en-US').trim() || 'en-US';

  let saw404 = false;

  try {
    const restUrl = `https://api.epicgames.dev/epic/achievements/v1/public/achievements/product/${encodeURIComponent(
      cleanSandbox
    )}/locale/${encodeURIComponent(effectiveLocale)}`;
    const res = await fetchImpl(restUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': buildPlatformStoreUserAgent('EpicGamesLauncher'),
      },
      signal: buildStoreFetchSignal(options?.signal),
    });
    if (res.ok) {
      const data = /** @type {any} */ (await res.json());
      const rawAchievements = Array.isArray(data?.achievements) ? data.achievements : [];
      const productId = String(data?.productId || '').trim();
      if (productId) {
        setBoundedEpicSandboxProductId(cleanSandbox, productId);
      }
      if (rawAchievements.length > 0 || productId) {
        return {
          productId,
          sandboxId: String(data?.sandboxId || cleanSandbox),
          totalAchievements: Number(data?.totalAchievements || rawAchievements.length) || 0,
          totalProductXP: Number(data?.totalProductXP || 0) || 0,
          achievementSets: data?.achievementSets || null,
          rawAchievements,
          definitiveNotFound: rawAchievements.length === 0,
        };
      }
    } else if (res.status === 404) {
      saw404 = true;
    }
  } catch {}

  try {
    const gqlQuery = `query Achievement($sandboxId: String!, $locale: String!) {
      Achievement {
        productAchievementsRecordBySandbox(sandboxId: $sandboxId, locale: $locale) {
          productId
          sandboxId
          totalAchievements
          totalProductXP
          achievementSets {
            achievementSetId
            isBase
            totalAchievements
            totalXP
          }
          achievements {
            achievement {
              sandboxId
              name
              hidden
              isBase
              achievementSetId
              unlockedDisplayName
              lockedDisplayName
              unlockedDescription
              lockedDescription
              flavorText
              XP
              unlockedIconLink
              lockedIconLink
              statThresholds
              tier {
                name
                hexColor
                min
                max
              }
              rarity {
                percent
              }
            }
          }
        }
      }
    }`;
    const gqlRes = await fetchImpl('https://launcher.store.epicgames.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': buildPlatformStoreUserAgent('EpicGamesLauncher'),
      },
      body: JSON.stringify({
        query: gqlQuery,
        variables: { sandboxId: cleanSandbox, locale: effectiveLocale },
      }),
      signal: buildStoreFetchSignal(options?.signal),
    });
    if (gqlRes.ok) {
      const gqlJson = /** @type {any} */ (await gqlRes.json());
      const rec = gqlJson?.data?.Achievement?.productAchievementsRecordBySandbox;
      if (rec && typeof rec === 'object') {
        const rawAchievements = Array.isArray(rec.achievements) ? rec.achievements : [];
        const productId = String(rec.productId || '').trim();
        if (productId) {
          setBoundedEpicSandboxProductId(cleanSandbox, productId);
        }
        if (rawAchievements.length > 0 || productId) {
          return {
            productId,
            sandboxId: String(rec.sandboxId || cleanSandbox),
            totalAchievements: Number(rec.totalAchievements || rawAchievements.length) || 0,
            totalProductXP: Number(rec.totalProductXP || 0) || 0,
            achievementSets: rec.achievementSets || null,
            rawAchievements,
            definitiveNotFound: rawAchievements.length === 0,
          };
        }
      }
    }
  } catch {}

  if (saw404) {
    return {
      productId: '',
      sandboxId: cleanSandbox,
      totalAchievements: 0,
      totalProductXP: 0,
      achievementSets: null,
      rawAchievements: [],
      definitiveNotFound: true,
    };
  }

  return null;
}

/**
 * Retrieve per-achievement schema definitions for an Epic Games Store title via public
 * Epic Cloud API (`api.epicgames.dev`) first, falling back to local Legendary `metadata/*.json`
 * with strict path containment on `rawAppName`.
 *
 * @param {Record<string, any>} [payload]
 * @param {Record<string, any>} [options]
 */
async function getEpicGameAchievementSchema(payload = {}, options = {}) {
  const rawAppName = String(payload.appName || payload.platformGameId || payload.gameId || '')
    .replace(/^epic[-_]/i, '')
    .trim();
  const rawNamespace = String(payload.namespace || payload.sandboxId || '').trim();
  const rawCatalogId = String(payload.catalogItemId || '').trim();
  const rawTitle = String(payload.title || '').trim();
  /** @param {unknown} s */
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const normTitle = norm(rawTitle);

  /**
   * @param {any} rawItem
   * @param {number} idx
   */
  const mapRawEpicAchievement = (rawItem, idx) => {
    const ach =
      rawItem?.achievement && typeof rawItem.achievement === 'object'
        ? rawItem.achievement
        : rawItem;
    const xpVal = Number(ach?.xp ?? ach?.XP ?? 0) || 0;
    const rawPct =
      typeof ach?.completed_percent === 'number'
        ? ach.completed_percent
        : typeof ach?.rarity?.percent === 'number'
          ? ach.rarity.percent
          : undefined;
    const unlockedIcon =
      sanitizeSafeHttpsMediaUrl(ach?.unlocked_icon_url || ach?.unlockedIconLink, {
        allowProtocolRelative: true,
      }) || undefined;
    const lockedIcon =
      sanitizeSafeHttpsMediaUrl(ach?.locked_icon_url || ach?.lockedIconLink, {
        allowProtocolRelative: true,
      }) || undefined;
    return {
      id: String(ach?.achievement_id || ach?.name || `epic_ach_${idx + 1}`),
      apiName: String(ach?.achievement_id || ach?.name || `epic_ach_${idx + 1}`),
      name: String(
        ach?.unlocked_display_name ||
          ach?.unlockedDisplayName ||
          ach?.locked_display_name ||
          ach?.lockedDisplayName ||
          ach?.achievement_id ||
          ach?.name ||
          `Achievement ${idx + 1}`
      ),
      description: String(
        ach?.unlocked_description ||
          ach?.unlockedDescription ||
          ach?.locked_description ||
          ach?.lockedDescription ||
          ach?.flavorText ||
          ''
      ),
      hidden: Boolean(ach?.hidden),
      isBaseGame: typeof ach?.isBase === 'boolean' ? ach.isBase : true,
      ...(ach?.achievementSetId ? { achievementSetId: String(ach.achievementSetId) } : {}),
      xp: xpVal,
      tierName: ach?.tier?.name ? String(ach.tier.name) : undefined,
      globalPercentage: rawPct !== undefined ? Number(rawPct) : undefined,
      iconUnlockedUrl: unlockedIcon,
      iconLockedUrl: lockedIcon,
    };
  };

  if (!options.localOnly && !options.skipNetwork) {
    try {
      let sandboxId = rawNamespace;
      if (!sandboxId) {
        const resolved = await resolveEpicNamespaceAndIds(payload, options);
        if (resolved?.namespace) sandboxId = String(resolved.namespace).trim();
      }
      if (sandboxId) {
        const cloudSchema = await fetchEpicPublicAchievementSchema(sandboxId, options);
        if (cloudSchema && cloudSchema.rawAchievements.length > 0) {
          return cloudSchema.rawAchievements.map(mapRawEpicAchievement);
        }
      }
    } catch {}
  }

  /**
   * @param {string} filePath
   * @param {string} [fallbackFileName]
   */
  const readParsedEpicSchemaMetaAsync = async (filePath, fallbackFileName = '') => {
    const st = await fs.promises.stat(filePath);
    const cached = epicSchemaFileCache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.summary;
    }
    const rawText = await fs.promises.readFile(filePath, 'utf-8');
    const json = JSON.parse(rawText);
    if (!json || typeof json !== 'object') return null;
    const achList = json?.achievements?.achievements;
    const summary = {
      appName: String(json.app_name || fallbackFileName.replace(/\.json$/i, '')).trim(),
      namespace: String(json.namespace || json.metadata?.namespace || '').trim(),
      catalogItemId: String(json.catalog_item_id || json.id || json.metadata?.id || '').trim(),
      title: String(json.app_title || json.metadata?.title || '').trim(),
      mappedAchievements:
        Array.isArray(achList) && achList.length > 0 ? achList.map(mapRawEpicAchievement) : [],
    };
    if (epicSchemaFileCache.size > MAX_EPIC_SCHEMA_FILE_CACHE_ENTRIES) {
      const firstKey = epicSchemaFileCache.keys().next().value;
      if (firstKey !== undefined) epicSchemaFileCache.delete(firstKey);
    }
    epicSchemaFileCache.set(filePath, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      summary,
    });
    return summary;
  };

  try {
    const baseDirs = getLocalLegendaryBaseDirs(options);
    for (const baseDir of baseDirs) {
      if (!baseDir) continue;
      const metaDir = path.join(baseDir, 'metadata');
      try {
        const dirSt = await fs.promises.stat(metaDir);
        if (!dirSt.isDirectory()) continue;
      } catch {
        continue;
      }

      if (rawAppName) {
        const directFile = resolveSafeLegendaryMetaFilePath(baseDir, rawAppName);
        if (directFile) {
          try {
            const directSummary = await readParsedEpicSchemaMetaAsync(
              directFile,
              `${rawAppName}.json`
            );
            if (directSummary && directSummary.mappedAchievements.length > 0) {
              return directSummary.mappedAchievements;
            }
          } catch {}
        }
      }

      /** @type {string[]} */
      let files = [];
      try {
        const dirEntries = await fs.promises.readdir(metaDir);
        files = dirEntries.filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }

      for (const f of files) {
        try {
          const summary = await readParsedEpicSchemaMetaAsync(path.join(metaDir, f), f);
          if (!summary) continue;

          const isMatch =
            (rawAppName && summary.appName.toLowerCase() === rawAppName.toLowerCase()) ||
            (rawNamespace &&
              summary.namespace &&
              summary.namespace.toLowerCase() === rawNamespace.toLowerCase()) ||
            (rawCatalogId &&
              summary.catalogItemId &&
              summary.catalogItemId.toLowerCase() === rawCatalogId.toLowerCase()) ||
            (normTitle && summary.title && norm(summary.title) === normTitle);

          if (isMatch && summary.mappedAchievements.length > 0) {
            return summary.mappedAchievements;
          }
        } catch {}
      }
    }
  } catch {}

  return [];
}

/**
 * Universal 2-step cloud Epic per-achievement unlocks, ISO timestamps & partial progress (`Task 10a + 10b`).
 *
 * @param {Record<string, any>} [payload]
 * @param {Record<string, any>} [options]
 */
async function fetchEpicDetailedGameAchievements(payload = {}, options = {}) {
  const fetchImpl = typeof options?.fetchFn === 'function' ? options.fetchFn : fetch;
  const vaultOpts = resolveStoreVaultOptions(options?.userDataDir ? options : payload);
  const syncedAt = new Date().toISOString();

  let sandboxId = String(payload.sandboxId || payload.namespace || '').trim();
  if (!sandboxId) {
    try {
      const resolved = await resolveEpicNamespaceAndIds(payload, { ...options, ...vaultOpts });
      if (resolved?.namespace) {
        sandboxId = String(resolved.namespace).trim();
      }
    } catch {}
  }

  if (!sandboxId) {
    const localFallback = await getEpicGameAchievementSchema(payload, {
      ...options,
      localOnly: true,
    });
    if (localFallback.length > 0) {
      return {
        storefrontId: 'epic',
        storefrontName: 'Epic Games',
        total: localFallback.length,
        unlocked: 0,
        percentage: 0,
        isMastered: false,
        achievements: localFallback,
        syncedAt,
        source: 'local_cache',
        supportsAchievements: true,
        cacheVersion: 2,
      };
    }
    return null;
  }

  const publicSchema = await fetchEpicPublicAchievementSchema(sandboxId, options);
  if (publicSchema?.definitiveNotFound && publicSchema.rawAchievements.length === 0) {
    return {
      storefrontId: 'epic',
      storefrontName: 'Epic Games',
      total: 0,
      unlocked: 0,
      percentage: 0,
      isMastered: false,
      achievements: [],
      syncedAt,
      source: 'live_cloud',
      unlockPrecision: 'exact',
      supportsAchievements: false,
      cacheVersion: 2,
    };
  }

  if (!publicSchema || publicSchema.rawAchievements.length === 0) {
    const localFallback = await getEpicGameAchievementSchema(payload, {
      ...options,
      localOnly: true,
    });
    if (localFallback.length > 0) {
      return {
        storefrontId: 'epic',
        storefrontName: 'Epic Games',
        total: localFallback.length,
        unlocked: 0,
        percentage: 0,
        isMastered: false,
        achievements: localFallback,
        syncedAt,
        source: 'local_cache',
        supportsAchievements: true,
        cacheVersion: 2,
      };
    }
    return null;
  }

  /** @type {Record<string, any>} */
  let savedEpic = {};
  if (!options.accessToken || !options.accountId) {
    try {
      const saved = await loadSavedTokensAsync(vaultOpts);
      savedEpic = saved?.epic || {};
    } catch {}
  }

  let accessToken = String(options.accessToken || savedEpic.access_token || '').trim();
  const refreshToken = String(options.refreshToken || savedEpic.refresh_token || '').trim();
  let accountId = String(options.accountId || savedEpic.account_id || '').trim();

  if ((!accessToken || !accountId) && typeof options.ensureLegendaryAuth === 'function') {
    try {
      const legAuth = await options.ensureLegendaryAuth();
      accessToken = accessToken || String(legAuth?.accessToken || '').trim();
      accountId = accountId || String(legAuth?.accountId || '').trim();
    } catch {}
  }

  /** @type {Map<string, Record<string, any>>} */
  const playerMap = new Map();
  let hasAuthoritativePlayerResponse = false;
  /** @type {number | undefined} */
  let playerTotalXP = undefined;

  if (publicSchema.productId && accountId && (accessToken || refreshToken)) {
    const playerQuery = `query playerProductAchievements($epicAccountId: String!, $productId: String!) {
      PlayerProfile {
        playerProfile(epicAccountId: $epicAccountId) {
          productAchievements(productId: $productId) {
            __typename
            ... on PlayerProductAchievementsResponseSuccess {
              data {
                sandboxId
                epicAccountId
                totalUnlocked
                totalXP
                playerAchievements {
                  playerAchievement {
                    achievementName
                    unlocked
                    unlockDate
                    progress
                    XP
                    achievementSetId
                    isBase
                  }
                }
              }
            }
          }
        }
      }
    }`;

    /** @param {string} tokenToUse */
    const executePlayerQuery = async (tokenToUse) => {
      const authHeader = /^bearer\s+/i.test(tokenToUse) ? tokenToUse : `Bearer ${tokenToUse}`;
      const res = await fetchImpl('https://launcher.store.epicgames.com/graphql', {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': buildPlatformStoreUserAgent('EpicGamesLauncher'),
        },
        body: JSON.stringify({
          query: playerQuery,
          variables: {
            epicAccountId: accountId,
            productId: publicSchema.productId,
          },
        }),
        signal: buildStoreFetchSignal(options?.signal),
      });
      /** @type {any} */
      let json = null;
      try {
        json = await res.json();
      } catch {}
      return { status: res.status, ok: res.ok, json };
    };

    try {
      if (!accessToken && refreshToken) {
        const renewed = await renewEpicTokens(refreshToken, {
          ...options,
          ...vaultOpts,
          preferVaultRefreshToken: true,
        });
        accessToken = String(renewed?.access_token || '').trim();
        accountId = String(renewed?.account_id || accountId).trim();
      }

      if (accessToken) {
        let gqlAttempt = await executePlayerQuery(accessToken);
        if (isEpicGraphqlAuthFailure(gqlAttempt.status, gqlAttempt.json) && refreshToken) {
          try {
            const renewed = await renewEpicTokens(refreshToken, {
              ...options,
              ...vaultOpts,
              preferVaultRefreshToken: true,
            });
            if (renewed?.access_token) {
              accessToken = String(renewed.access_token).trim();
              accountId = String(renewed.account_id || accountId).trim();
              gqlAttempt = await executePlayerQuery(accessToken);
            }
          } catch {}
        }

        const paNode = gqlAttempt.json?.data?.PlayerProfile?.playerProfile?.productAchievements;
        const paData = paNode?.data;
        if (
          gqlAttempt.ok &&
          paNode &&
          paNode.__typename !== 'ServiceError' &&
          paData &&
          typeof paData === 'object'
        ) {
          hasAuthoritativePlayerResponse = true;
          if (typeof paData.totalXP === 'number' && Number.isFinite(paData.totalXP)) {
            playerTotalXP = paData.totalXP;
          }
          const rawPlayerItems = Array.isArray(paData.playerAchievements)
            ? paData.playerAchievements
            : [];
          for (const entry of rawPlayerItems) {
            const pa = entry?.playerAchievement || entry;
            if (!pa || typeof pa !== 'object' || !pa.achievementName) continue;
            playerMap.set(String(pa.achievementName).trim().toLowerCase(), pa);
          }
        }
      }
    } catch {}
  }

  /** @type {Map<string, boolean>} */
  const setIsBaseMap = new Map();
  if (Array.isArray(publicSchema.achievementSets)) {
    for (const s of publicSchema.achievementSets) {
      if (s?.achievementSetId) {
        setIsBaseMap.set(String(s.achievementSetId), s.isBase !== false);
      }
    }
  } else if (publicSchema.achievementSets && typeof publicSchema.achievementSets === 'object') {
    for (const [setId, s] of Object.entries(publicSchema.achievementSets)) {
      if (s && typeof s === 'object') {
        setIsBaseMap.set(String(setId), /** @type {any} */ (s).isBase !== false);
      }
    }
  }

  let sumXp = 0;
  let sumEarnedXp = 0;

  const achievements = publicSchema.rawAchievements.map((/** @type {any} */ rawItem, /** @type {number} */ idx) => {
    const ach =
      rawItem?.achievement && typeof rawItem.achievement === 'object'
        ? rawItem.achievement
        : rawItem;
    const apiName = String(ach?.name || ach?.achievement_id || `EPIC_ACH_${idx + 1}`).trim();
    const playerEntry = playerMap.get(apiName.toLowerCase());

    const unlocked = Boolean(playerEntry?.unlocked === true);
    const rawUnlockDate =
      typeof playerEntry?.unlockDate === 'string' ? playerEntry.unlockDate.trim() : '';
    const unlockedAt =
      unlocked &&
      rawUnlockDate &&
      rawUnlockDate.toUpperCase() !== 'N/A' &&
      !Number.isNaN(Date.parse(rawUnlockDate))
        ? new Date(Date.parse(rawUnlockDate)).toISOString()
        : undefined;

    const progress = !unlocked
      ? computeEpicPartialProgress(playerEntry?.progress, ach?.statThresholds)
      : undefined;

    const xpVal = Number(ach?.XP ?? ach?.xp ?? playerEntry?.XP ?? 0) || 0;
    sumXp += xpVal;
    if (unlocked) sumEarnedXp += xpVal;

    const rawRarityPct =
      typeof ach?.rarity?.percent === 'number'
        ? ach.rarity.percent
        : typeof ach?.completed_percent === 'number'
          ? ach.completed_percent
          : undefined;
    const globalPercentage =
      rawRarityPct !== undefined && Number.isFinite(rawRarityPct)
        ? Number(Number(rawRarityPct).toFixed(1))
        : undefined;

    const setId =
      ach?.achievementSetId || playerEntry?.achievementSetId
        ? String(ach?.achievementSetId || playerEntry?.achievementSetId)
        : undefined;
    const isBaseGame =
      typeof ach?.isBase === 'boolean'
        ? ach.isBase
        : typeof playerEntry?.isBase === 'boolean'
          ? playerEntry.isBase
          : setId && setIsBaseMap.has(setId)
            ? setIsBaseMap.get(setId)
            : true;

    const iconUnlockedUrl = sanitizeSafeHttpsMediaUrl(
      ach?.unlockedIconLink || ach?.unlocked_icon_url || '',
      { allowProtocolRelative: true }
    );
    const iconLockedUrl =
      sanitizeSafeHttpsMediaUrl(ach?.lockedIconLink || ach?.locked_icon_url || '', {
        allowProtocolRelative: true,
      }) || iconUnlockedUrl;

    const name = String(
      ach?.unlockedDisplayName ||
        ach?.unlocked_display_name ||
        ach?.lockedDisplayName ||
        ach?.locked_display_name ||
        apiName
    ).trim();
    const description = String(
      ach?.unlockedDescription ||
        ach?.unlocked_description ||
        ach?.lockedDescription ||
        ach?.locked_description ||
        ach?.flavorText ||
        ''
    ).trim();

    return {
      id: `epic:${sandboxId}:${apiName}`,
      apiName,
      name,
      description: description || undefined,
      unlocked,
      ...(unlockedAt ? { unlockedAt } : {}),
      iconUnlockedUrl,
      iconLockedUrl,
      ...(globalPercentage !== undefined
        ? {
            globalPercentage,
            rarityTier: classifyAchievementRarityTier(globalPercentage),
          }
        : {}),
      ...(progress ? { progress } : {}),
      isSecret: Boolean(ach?.hidden),
      hidden: Boolean(ach?.hidden),
      xp: xpVal,
      ...(ach?.tier?.name ? { tierName: String(ach.tier.name) } : {}),
      isBaseGame,
      ...(setId ? { achievementSetId: setId } : {}),
      storefrontId: 'epic',
    };
  });

  const total = achievements.length;
  const unlocked = achievements.filter((/** @type {any} */ a) => a.unlocked).length;
  const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
  const totalXp = publicSchema.totalProductXP > 0 ? publicSchema.totalProductXP : sumXp;
  const earnedXp = hasAuthoritativePlayerResponse
    ? playerTotalXP !== undefined
      ? playerTotalXP
      : sumEarnedXp
    : undefined;

  return {
    storefrontId: 'epic',
    storefrontName: 'Epic Games',
    total,
    unlocked,
    percentage,
    isMastered: total > 0 && unlocked >= total,
    ...(totalXp > 0 ? { totalXp } : {}),
    ...(earnedXp !== undefined ? { earnedXp } : {}),
    ...(totalXp > 0 || earnedXp !== undefined
      ? { xp: { earned: earnedXp ?? 0, total: totalXp } }
      : {}),
    achievements,
    syncedAt,
    source: 'live_cloud',
    ...(hasAuthoritativePlayerResponse ? { unlockPrecision: 'exact' } : {}),
    supportsAchievements: total > 0,
    cacheVersion: 2,
  };
}

/**
 * Fetch Epic Games Player Achievements from official launcher GraphQL service and reconcile
 * with local Legendary `metadata/*.json` achievement schemas via async `fs.promises` (with
 * strict path containment on `targetAppName`).
 *
 * @param {string} accessToken
 * @param {string} accountId
 * @param {Record<string, any>} [options]
 */
async function fetchEpicAchievements(accessToken, accountId, options = {}) {
  /** @type {Record<string, any>} */
  const achievementsMap = {};
  /** @type {Map<string, Array<{ appNameLower: string, catalogIdLower: string, titleLower: string, normTitle: string }>>} */
  const sandboxMetaLookup = new Map();
  const syncedAt = new Date().toISOString();

  let targetSandboxId = String(options?.sandboxId || options?.namespace || '').trim();
  const targetAppName = String(options?.appName || '')
    .replace(/^epic[-_]/i, '')
    .trim();
  const targetCatalogItemId = String(options?.catalogItemId || '').trim();
  const targetTitle = String(options?.title || '').trim();
  const isSingleGameScoped = Boolean(targetSandboxId || targetAppName);

  /**
   * @param {any} json
   * @param {string} [fallbackName]
   */
  const registerLocalLegendaryMetaObject = (json, fallbackName = '') => {
    if (!json || typeof json !== 'object') return;
    const appName = String(json.app_name || fallbackName.replace(/\.json$/i, '')).trim();
    const appNameLower = appName.toLowerCase();
    const sandboxIdLower = String(json.namespace || json.metadata?.namespace || '')
      .toLowerCase()
      .trim();
    const catalogIdLower = String(json.catalog_item_id || json.id || json.metadata?.id || '')
      .toLowerCase()
      .trim();
    const title = String(json.app_title || json.metadata?.title || '').trim();
    const titleLower = title.toLowerCase();
    const normTitle = titleLower
      .replace(/[:\-–—]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (isSingleGameScoped) {
      const targetSbLower = targetSandboxId.toLowerCase();
      const targetAppLower = targetAppName.toLowerCase();
      const matchesTarget =
        (targetAppLower && appNameLower === targetAppLower) ||
        (targetSbLower && sandboxIdLower === targetSbLower);
      if (!matchesTarget) return;
      if (!targetSandboxId && sandboxIdLower) {
        targetSandboxId = String(json.namespace || json.metadata?.namespace || '').trim();
      }
    }

    if (sandboxIdLower) {
      const existingList = sandboxMetaLookup.get(sandboxIdLower) || [];
      existingList.push({
        appNameLower,
        catalogIdLower,
        titleLower,
        normTitle,
      });
      sandboxMetaLookup.set(sandboxIdLower, existingList);
    }

    const achBlock = json.achievements;
    const achArray = Array.isArray(achBlock?.achievements) ? achBlock.achievements : [];
    const total =
      Number(achBlock?.total_achievements || 0) ||
      (achArray.length > 0 ? achArray.length : 0);

    if (total > 0) {
      const totalXP =
        Number(achBlock?.total_product_xp || 0) ||
        achArray.reduce((/** @type {number} */ sum, /** @type {any} */ rawItem) => {
          const a =
            rawItem?.achievement && typeof rawItem.achievement === 'object'
              ? rawItem.achievement
              : rawItem;
          return sum + (Number(a?.xp ?? a?.XP ?? 0) || 0);
        }, 0);
      const seededSummary = {
        unlocked: 0,
        total,
        percentage: 0,
        xp: { earned: 0, total: totalXP },
        isMastered: false,
        source: 'local_client_cache',
        syncedAt,
      };
      if (appNameLower && !achievementsMap[appNameLower]) {
        achievementsMap[appNameLower] = seededSummary;
        achievementsMap[`epic-${appNameLower}`] = seededSummary;
      }
      if (sandboxIdLower && !achievementsMap[sandboxIdLower]) {
        achievementsMap[sandboxIdLower] = seededSummary;
      }
      if (catalogIdLower && !achievementsMap[catalogIdLower]) {
        achievementsMap[catalogIdLower] = seededSummary;
      }
      if (titleLower && !achievementsMap[titleLower]) {
        achievementsMap[titleLower] = seededSummary;
      }
      if (normTitle && !achievementsMap[normTitle]) {
        achievementsMap[normTitle] = seededSummary;
      }
    }
  };

  try {
    const baseDirs = getLocalLegendaryBaseDirs(options);
    if (isSingleGameScoped) {
      if (!targetSandboxId && targetAppName) {
        const cachedNs = getEpicNamespaceByLookupKey('app:' + targetAppName.toLowerCase());
        if (cachedNs?.namespace) {
          targetSandboxId = cachedNs.namespace;
        }
      }
      let foundDirectMeta = false;
      if (targetAppName) {
        for (const baseDir of baseDirs) {
          const directFile = resolveSafeLegendaryMetaFilePath(baseDir, targetAppName);
          if (!directFile) continue;
          try {
            const raw = await fs.promises.readFile(directFile, 'utf-8');
            const json = JSON.parse(raw);
            registerLocalLegendaryMetaObject(json, `${targetAppName}.json`);
            foundDirectMeta = true;
            break;
          } catch {}
        }
      }
      if (!foundDirectMeta && targetSandboxId) {
        const targetSbLower = targetSandboxId.toLowerCase();
        for (const baseDir of baseDirs) {
          if (!baseDir) continue;
          const metaDir = path.join(baseDir, 'metadata');
          /** @type {string[]} */
          let files = [];
          try {
            files = (await fs.promises.readdir(metaDir)).filter((f) => f.endsWith('.json'));
          } catch {
            continue;
          }
          const META_CONCURRENCY = 16;
          for (let i = 0; i < files.length; i += META_CONCURRENCY) {
            const chunk = files.slice(i, i + META_CONCURRENCY);
            const parsedChunk = await Promise.all(
              chunk.map(async (f) => {
                try {
                  const raw = await fs.promises.readFile(path.join(metaDir, f), 'utf-8');
                  if (!raw.toLowerCase().includes(targetSbLower)) return null;
                  return { f, json: JSON.parse(raw) };
                } catch {
                  return null;
                }
              })
            );
            for (const entry of parsedChunk) {
              if (entry) registerLocalLegendaryMetaObject(entry.json, entry.f);
            }
          }
        }
      }
      if (targetSandboxId && targetAppName) {
        const sbLower = targetSandboxId.toLowerCase();
        const existingList = sandboxMetaLookup.get(sbLower) || [];
        const appLower = targetAppName.toLowerCase();
        if (!existingList.some((m) => m.appNameLower === appLower)) {
          const titleLower = targetTitle.toLowerCase();
          existingList.push({
            appNameLower: appLower,
            catalogIdLower: targetCatalogItemId.toLowerCase(),
            titleLower,
            normTitle: titleLower.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim(),
          });
          sandboxMetaLookup.set(sbLower, existingList);
        }
      }
    } else {
      for (const baseDir of baseDirs) {
        if (!baseDir) continue;
        const metaDir = path.join(baseDir, 'metadata');
        /** @type {string[]} */
        let files = [];
        try {
          files = (await fs.promises.readdir(metaDir)).filter((f) => f.endsWith('.json'));
        } catch {
          continue;
        }
        const META_CONCURRENCY = 16;
        for (let i = 0; i < files.length; i += META_CONCURRENCY) {
          const chunk = files.slice(i, i + META_CONCURRENCY);
          const parsedChunk = await Promise.all(
            chunk.map(async (f) => {
              try {
                const raw = await fs.promises.readFile(path.join(metaDir, f), 'utf-8');
                return { f, json: JSON.parse(raw) };
              } catch {
                return null;
              }
            })
          );
          for (const entry of parsedChunk) {
            if (entry) registerLocalLegendaryMetaObject(entry.json, entry.f);
          }
        }
      }
    }
  } catch {}

  if (!accountId || options.skipNetwork) {
    return achievementsMap;
  }

  /** @param {any[]} dataList */
  const indexEpicAchievementItems = (dataList) => {
    const targetSbLower = targetSandboxId.toLowerCase();
    const targetAppLower = targetAppName.toLowerCase();
    for (const item of dataList) {
      if (!item || typeof item !== 'object') continue;
      const sbLower = item.sandboxId
        ? String(item.sandboxId).toLowerCase().trim()
        : targetSbLower;
      if (isSingleGameScoped) {
        const localMatches = sbLower ? sandboxMetaLookup.get(sbLower) || [] : [];
        const matchesSb = Boolean(targetSbLower && sbLower === targetSbLower);
        const matchesApp = Boolean(
          targetAppLower && localMatches.some((m) => m.appNameLower === targetAppLower)
        );
        if (!matchesSb && !matchesApp) continue;
      }

      const total = item.productAchievements?.totalAchievements || 0;
      const unlocked = item.totalUnlocked || 0;
      const totalXP = item.productAchievements?.totalProductXP || 0;
      const earnedXP = item.totalXP || 0;
      const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
      const isMastered = total > 0 && unlocked >= total;

      const summary = {
        unlocked,
        total,
        percentage,
        xp: { earned: earnedXP, total: totalXP },
        isMastered,
        source: 'live_cloud_graphql',
        syncedAt,
      };

      if (sbLower) {
        achievementsMap[sbLower] = summary;
        const localMatches = sandboxMetaLookup.get(sbLower) || [];
        for (const m of localMatches) {
          if (m.appNameLower) {
            achievementsMap[m.appNameLower] = summary;
            achievementsMap[`epic-${m.appNameLower}`] = summary;
          }
          if (m.catalogIdLower) {
            achievementsMap[m.catalogIdLower] = summary;
          }
          if (m.titleLower) {
            achievementsMap[m.titleLower] = summary;
          }
          if (m.normTitle) {
            achievementsMap[m.normTitle] = summary;
          }
        }
      }
      if (isSingleGameScoped && targetAppName) {
        const appLower = targetAppName.toLowerCase();
        achievementsMap[appLower] = summary;
        achievementsMap[`epic-${appLower}`] = summary;
      }
      if (isSingleGameScoped && targetCatalogItemId) {
        achievementsMap[targetCatalogItemId.toLowerCase()] = summary;
      }
      if (item.product?.slug) achievementsMap[item.product.slug.toLowerCase()] = summary;
      if (item.product?.name) {
        achievementsMap[item.product.name.toLowerCase().trim()] = summary;
        const norm = item.product.name
          .toLowerCase()
          .replace(/[:\-–—]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        achievementsMap[norm] = summary;
      }
    }
  };

  try {
    const { locale } = resolveDefaultStoreLocaleAndCountry(options);
    /** @type {Record<string, string>} */
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': buildPlatformStoreUserAgent('EpicGamesLauncher'),
    };
    if (accessToken) {
      headers['Authorization'] = accessToken.startsWith('bearer ')
        ? accessToken
        : `bearer ${accessToken}`;
    }
    const fetchImpl = options.fetchFn || fetch;

    if (isSingleGameScoped && targetSandboxId) {
      const cachedProdId =
        String(options.productId || '').trim() ||
        epicSandboxProductIdCache.get(targetSandboxId.toLowerCase()) ||
        '';

      /**
       * @param {string} resolvedProductId
       * @param {any} [fallbackTotals]
       */
      const tryQueryByProductId = async (resolvedProductId, fallbackTotals = null) => {
        if (!resolvedProductId) return false;
        const prodQuery = `query playerProductAchievements($epicAccountId: String!, $productId: String!) {
          PlayerProfile {
            playerProfile(epicAccountId: $epicAccountId) {
              productAchievements(productId: $productId) {
                __typename
                ... on PlayerProductAchievementsResponseSuccess {
                  data {
                    sandboxId
                    epicAccountId
                    totalUnlocked
                    totalXP
                    playerAchievements {
                      playerAchievement {
                        achievementName
                        unlocked
                        unlockDate
                        progress
                        XP
                        achievementSetId
                        isBase
                      }
                    }
                  }
                }
              }
            }
          }
        }`;
        const prodRes = await fetchImpl('https://launcher.store.epicgames.com/graphql', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            query: prodQuery,
            variables: {
              epicAccountId: accountId,
              productId: resolvedProductId,
            },
          }),
          signal: buildStoreFetchSignal(options.signal),
        });
        if (!prodRes.ok) return false;
        const prodJson = /** @type {any} */ (await prodRes.json());
        const paNode = prodJson?.data?.PlayerProfile?.playerProfile?.productAchievements;
        const paData = paNode?.data;
        if (!paData || paNode?.__typename === 'ServiceError') return false;
        const totals =
          fallbackTotals || (await fetchEpicPublicAchievementSchema(targetSandboxId, options));
        indexEpicAchievementItems([
          {
            sandboxId: paData.sandboxId || targetSandboxId,
            totalUnlocked: Number(paData.totalUnlocked || 0),
            totalXP: Number(paData.totalXP || 0),
            product: options.title ? { name: String(options.title) } : undefined,
            productAchievements: {
              totalAchievements: Number(totals?.totalAchievements || 0),
              totalProductXP: Number(totals?.totalProductXP || 0),
            },
          },
        ]);
        return true;
      };

      if (cachedProdId) {
        try {
          const hit = await tryQueryByProductId(cachedProdId);
          if (hit) return achievementsMap;
        } catch {}
      }

      const singleQuery = `query playerProfileProductAchievements($epicAccountId: String!, $sandboxId: String!, $locale: String!) {
        PlayerProfile {
          playerProfile(epicAccountId: $epicAccountId) {
            epicAccountId
            displayName
            productAchievements(sandboxId: $sandboxId) {
              ... on PlayerAchievementGameRecordsSuccess {
                data {
                  totalUnlocked
                  totalXP
                  sandboxId
                  product(locale: $locale) {
                    name
                    slug
                  }
                  productAchievements(locale: $locale) {
                    totalAchievements
                    totalProductXP
                  }
                }
              }
            }
          }
        }
      }`;

      const singleRes = await fetchImpl('https://launcher.store.epicgames.com/graphql', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: singleQuery,
          variables: {
            epicAccountId: accountId,
            sandboxId: targetSandboxId,
            locale,
          },
        }),
        signal: buildStoreFetchSignal(options.signal),
      });

      if (singleRes.ok) {
        const singleJson = /** @type {any} */ (await singleRes.json());
        const profileNode = singleJson?.data?.PlayerProfile?.playerProfile;
        const targetedRaw = profileNode?.productAchievements?.data;
        const summaryFallbackRaw = profileNode?.achievementsSummaries?.data;
        const hasSchemaError = Array.isArray(singleJson?.errors) && singleJson.errors.length > 0;

        if (targetedRaw) {
          const list = Array.isArray(targetedRaw) ? targetedRaw : [targetedRaw];
          indexEpicAchievementItems(list);
          return achievementsMap;
        }
        if (Array.isArray(summaryFallbackRaw)) {
          indexEpicAchievementItems(summaryFallbackRaw);
          return achievementsMap;
        }
        if (!hasSchemaError) {
          return achievementsMap;
        }
      } else if (singleRes.status === 401 || singleRes.status === 403) {
        console.warn(`Epic single-game achievements query returned status ${singleRes.status}`);
        return achievementsMap;
      }

      try {
        const publicSchema = await fetchEpicPublicAchievementSchema(targetSandboxId, options);
        if (publicSchema?.productId) {
          const hit = await tryQueryByProductId(publicSchema.productId, publicSchema);
          if (hit) return achievementsMap;
        }
      } catch {}
    }

    const query = `query playerProfile($epicAccountId: String!, $locale: String!) {
      PlayerProfile {
        playerProfile(epicAccountId: $epicAccountId) {
          epicAccountId
          displayName
          achievementsSummaries {
            ... on PlayerAchievementResponseSuccess {
              data {
                totalUnlocked
                totalXP
                sandboxId
                product(locale: $locale) {
                  name
                  slug
                }
                productAchievements(locale: $locale) {
                  totalAchievements
                  totalProductXP
                }
              }
            }
          }
        }
      }
    }`;

    const res = await fetchImpl('https://launcher.store.epicgames.com/graphql', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        variables: {
          epicAccountId: accountId,
          locale,
        },
      }),
      signal: buildStoreFetchSignal(options.signal),
    });

    if (!res.ok) {
      console.warn(`Epic achievements query returned status ${res.status}`);
      return achievementsMap;
    }

    const json = /** @type {any} */ (await res.json());
    const dataList = json?.data?.PlayerProfile?.playerProfile?.achievementsSummaries?.data || [];
    indexEpicAchievementItems(dataList);

    return achievementsMap;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('Epic achievements fetch warning:', msg);
    return achievementsMap;
  }
}

function trimEpicAchievementsMemory() {
  epicSchemaFileCache.clear();
}

module.exports = {
  isEpicGraphqlAuthFailure,
  computeEpicPartialProgress,
  fetchEpicPublicAchievementSchema,
  fetchEpicDetailedGameAchievements,
  fetchEpicAchievements,
  getEpicGameAchievementSchema,
  trimEpicAchievementsMemory,
};
