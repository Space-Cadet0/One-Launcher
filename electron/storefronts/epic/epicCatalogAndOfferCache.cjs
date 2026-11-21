// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { toHostFilesystemPath } = require('../../launcher/securityAndPathUtils.cjs');
const { getTokensFilePath } = require('../tokenVault.cjs');
const { classifyNonGameStorefrontItem } = require('../nonGameClassifier.cjs');
const storefrontLocalCacheFederator = require('../../launcher/storefrontLocalCacheFederator.cjs');
const {
  MAX_STORE_SYNC_CACHE_ENTRIES,
  buildStoreFetchSignal,
  buildPlatformStoreUserAgent,
  sanitizeSafeHttpsMediaUrl,
  resolveDefaultStoreLocaleAndCountry,
  escapeHtmlEntities,
  atomicWriteFileSync,
  atomicWriteFileAsync,
  resolveStoreVaultOptions,
  attachStoreSyncCallMetadata,
  setBoundedCacheEntry,
} = require('../sync/storeSyncShared.cjs');
const {
  resolveEpicPartnerChainedHandoff,
  readLocalLegendaryCustomAttributes,
  readLocalLegendaryCustomAttributesAsync,
  registerEpicNamespaceMapping,
  getEpicCatalogAccessToken,
  getLocalLegendaryBaseDirs,
  extractEpicMacSupportFromLegendaryDirsAsync,
  resolveEpicNamespaceAndIds,
} = require('./epicAuthAndNamespaces.cjs');
const { fetchEpicAchievements } = require('./epicAchievementsProvider.cjs');

const EPIC_OFFER_CACHE_FILENAME = 'one_launcher_epic_offer_cache.json';
const EPIC_OFFER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const EPIC_OFFER_DISK_CACHE_MAX_ENTRIES = 2000;
const MAX_EPIC_OFFER_DISK_CACHE_PATHS = 32;
const EPIC_OFFER_DEBOUNCE_MS = 250;

/** @type {Map<string, any>} */
const epicOfferMetadataCache = new Map();

/**
 * @typedef {{
 *   entries: Record<string, { miss: boolean, cachedAt: number, data: any }>,
 *   dirtyGen: number,
 *   flushedGen: number,
 *   lastNowMs: number,
 *   inFlightFlush: Promise<void> | null,
 *   debounceTimer: ReturnType<typeof setTimeout> | null,
 * }} EpicOfferDiskCacheSlot
 */

/** @type {Map<string, EpicOfferDiskCacheSlot>} */
const epicOfferDiskCacheByPath = new Map();

/**
 * @param {string} rawLong
 * @returns {string}
 */
function extractFirstOfferParagraph(rawLong) {
  if (!rawLong) return '';
  const cleaned = String(rawLong)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();

  if (!cleaned) return '';
  const paragraphs = cleaned
    .split(/\r?\n+/)
    .map((line) =>
      line.replace(/^#{1,6}\s+/, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\s+/g, ' ').trim()
    )
    .filter(
      (line) => line.length >= 25 && !/^(about|overview|description|features|story)$/i.test(line)
    );

  if (paragraphs.length === 0) return '';
  let first = paragraphs[0];
  if (first.length > 280) {
    const sub = first.substring(0, 280);
    const lastSpace = sub.lastIndexOf(' ');
    first = (lastSpace > 180 ? sub.substring(0, lastSpace) : sub).trim() + '...';
  }
  return first;
}

/**
 * @param {Record<string, any>} [payload]
 * @param {Record<string, any>} [options]
 */
function resolveLocalEpicOfferMetadataFallback(payload = {}, options = {}) {
  try {
    const rawAppName = String(payload.appName || payload.slug || '')
      .replace(/^epic-/i, '')
      .trim();
    const fedOpts = {
      ...options,
      ...(payload.homedir ? { homedir: payload.homedir } : {}),
      ...(payload.userDataDir ? { userDataDir: payload.userDataDir } : {}),
      ...(payload.legendaryDirs ? { legendaryDirs: payload.legendaryDirs } : {}),
      ...(payload.heroicRoot ? { heroicRoot: payload.heroicRoot } : {}),
      title: payload.title,
    };
    const localMeta = storefrontLocalCacheFederator.resolveLocalEpicMetadata(rawAppName, fedOpts);
    const localLegendaryAttrs = readLocalLegendaryCustomAttributes(
      rawAppName,
      payload.legendaryDirs || getLocalLegendaryBaseDirs(fedOpts)
    );
    const partnerHandoff = resolveEpicPartnerChainedHandoff(
      localMeta?.customAttributes,
      localLegendaryAttrs
    );
    if (!localMeta && !partnerHandoff) return null;

    const screenshots = Array.isArray(localMeta?.screenshots)
      ? localMeta.screenshots
          .map((/** @type {any} */ s) =>
            sanitizeSafeHttpsMediaUrl(
              typeof s === 'string' ? s : s?.pathFull || s?.pathThumbnail || '',
              { allowProtocolRelative: true }
            )
          )
          .filter(Boolean)
      : [];

    return {
      title: localMeta?.title || payload.title || undefined,
      shortDescription: localMeta?.shortDescription || undefined,
      detailedDescription:
        localMeta?.detailedDescription || localMeta?.shortDescription || undefined,
      aboutTheGame: localMeta?.aboutTheGame || localMeta?.detailedDescription || undefined,
      screenshots,
      movies: undefined,
      headerImage:
        sanitizeSafeHttpsMediaUrl(localMeta?.headerImage, { allowProtocolRelative: true }) ||
        undefined,
      capsuleImage:
        sanitizeSafeHttpsMediaUrl(localMeta?.capsuleImage, { allowProtocolRelative: true }) ||
        undefined,
      releaseDate: localMeta?.releaseDate || undefined,
      developers:
        Array.isArray(localMeta?.developers) && localMeta.developers.length > 0
          ? localMeta.developers
          : undefined,
      publishers:
        Array.isArray(localMeta?.publishers) && localMeta.publishers.length > 0
          ? localMeta.publishers
          : undefined,
      genres:
        Array.isArray(localMeta?.genres) && localMeta.genres.length > 0
          ? localMeta.genres
          : undefined,
      namespace: localMeta?.namespace || payload.namespace || undefined,
      catalogItemId: localMeta?.catalogItemId || payload.catalogItemId || undefined,
      ...(partnerHandoff
        ? {
            chainedLauncherHandoff: partnerHandoff.chainedLauncherHandoff,
            externalStorefrontHandoff: partnerHandoff.externalStorefrontHandoff,
            chainedHandoffTopology: 'partner_launcher_link',
            ...(partnerHandoff.epicPartnerRegistryPath
              ? { epicPartnerRegistryPath: partnerHandoff.epicPartnerRegistryPath }
              : {}),
            ...(partnerHandoff.epicPartnerRegistryKey
              ? { epicPartnerRegistryKey: partnerHandoff.epicPartnerRegistryKey }
              : {}),
            platforms: { windows: true, mac: false, linux: false },
          }
        : {}),
      fromLocalCache: true,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the path to the persistent 7-day Epic product-offer metadata cache in `userDataDir`.
 *
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function getEpicOfferCachePath(options = {}) {
  if (typeof options?.userDataDir === 'string' && options.userDataDir.trim()) {
    return path.join(toHostFilesystemPath(options.userDataDir.trim()), EPIC_OFFER_CACHE_FILENAME);
  }
  const tokensPath = getTokensFilePath(resolveStoreVaultOptions(options));
  return path.join(path.dirname(toHostFilesystemPath(tokensPath)), EPIC_OFFER_CACHE_FILENAME);
}

/**
 * Prune expired entries and enforce bounded cache size in place.
 *
 * @param {Record<string, { miss: boolean, cachedAt: number, data: any }>} entries
 * @param {number} nowMs
 */
function pruneEpicOfferCacheEntries(entries, nowMs) {
  const keys = Object.keys(entries);
  for (const k of keys) {
    const e = entries[k];
    if (!e || typeof e.cachedAt !== 'number' || nowMs - e.cachedAt >= EPIC_OFFER_CACHE_TTL_MS) {
      delete entries[k];
    }
  }
  const remainingKeys = Object.keys(entries);
  if (remainingKeys.length > EPIC_OFFER_DISK_CACHE_MAX_ENTRIES) {
    remainingKeys
      .sort((a, b) => Number(entries[a]?.cachedAt || 0) - Number(entries[b]?.cachedAt || 0))
      .slice(0, remainingKeys.length - EPIC_OFFER_DISK_CACHE_MAX_ENTRIES)
      .forEach((k) => {
        delete entries[k];
      });
  }
}

/**
 * Load (and memoize in-memory per file path) the persistent 7-day Epic offer cache.
 *
 * @param {string} cachePath
 * @returns {Promise<EpicOfferDiskCacheSlot>}
 */
async function loadEpicOfferDiskCacheAsync(cachePath) {
  const resolvedPath = path.resolve(toHostFilesystemPath(cachePath));
  const existing = epicOfferDiskCacheByPath.get(resolvedPath);
  if (existing) return existing;

  /** @type {Record<string, { miss: boolean, cachedAt: number, data: any }>} */
  let entries = {};
  try {
    const raw = await fs.promises.readFile(resolvedPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      entries = parsed.entries;
    }
  } catch {}

  if (epicOfferDiskCacheByPath.size >= MAX_EPIC_OFFER_DISK_CACHE_PATHS) {
    for (const [k, slot] of epicOfferDiskCacheByPath.entries()) {
      if (!slot.inFlightFlush && slot.dirtyGen === slot.flushedGen) {
        if (slot.debounceTimer) clearTimeout(slot.debounceTimer);
        epicOfferDiskCacheByPath.delete(k);
        break;
      }
    }
  }

  /** @type {EpicOfferDiskCacheSlot} */
  const slot = {
    entries,
    dirtyGen: 0,
    flushedGen: 0,
    lastNowMs: Date.now(),
    inFlightFlush: null,
    debounceTimer: null,
  };
  epicOfferDiskCacheByPath.set(resolvedPath, slot);
  return slot;
}

/**
 * Serialized per-`cachePath` async mutex writer for `one_launcher_epic_offer_cache.json`.
 * Multiple concurrent callers coalesce into a single atomic rename write per dirty generation.
 *
 * @param {string} cachePath
 * @returns {Promise<void>}
 */
async function flushEpicOfferDiskCacheAsync(cachePath) {
  if (!cachePath) return;
  const resolvedPath = path.resolve(toHostFilesystemPath(cachePath));
  const slot = epicOfferDiskCacheByPath.get(resolvedPath);
  if (!slot) return;

  if (slot.debounceTimer) {
    clearTimeout(slot.debounceTimer);
    slot.debounceTimer = null;
  }

  if (slot.inFlightFlush) {
    await slot.inFlightFlush;
    if (slot.dirtyGen <= slot.flushedGen) {
      return;
    }
  }

  const runLoop = (async () => {
    while (slot.dirtyGen > slot.flushedGen) {
      const targetGen = slot.dirtyGen;
      pruneEpicOfferCacheEntries(slot.entries, slot.lastNowMs || Date.now());
      const serialized = JSON.stringify({ schemaVersion: 1, entries: slot.entries });
      await atomicWriteFileAsync(resolvedPath, serialized);
      slot.flushedGen = targetGen;
    }
  })()
    .catch(() => {})
    .finally(() => {
      if (slot.inFlightFlush === runLoop) {
        slot.inFlightFlush = null;
      }
    });

  slot.inFlightFlush = runLoop;
  await runLoop;
}

/**
 * Persist an Epic offer cache entry (positive hit or confirmed negative miss) using a debounced
 * async mutex writer + atomic rename.
 * - When `deferFlush === true` (used inside 6-wide concurrent Epic library batches), marks dirty
 *   and schedules a 250ms `.unref()` debounced flush; the batch coordinator calls
 *   `flushEpicOfferDiskCacheAsync` once on completion, eliminating the 6-wide rewrite storm.
 * - When `deferFlush === false` (standalone single-game fetch), coalesces through the per-path
 *   async mutex so disk durability is guaranteed on resolve without overlapping writes.
 *
 * @param {string} cachePath
 * @param {string} cacheKey
 * @param {{ miss: boolean, cachedAt: number, data: any }} record
 * @param {number} nowMs
 * @param {boolean} [deferFlush]
 */
async function saveEpicOfferDiskCacheEntryAsync(
  cachePath,
  cacheKey,
  record,
  nowMs,
  deferFlush = false
) {
  try {
    const resolvedPath = path.resolve(toHostFilesystemPath(cachePath));
    const slot = await loadEpicOfferDiskCacheAsync(resolvedPath);
    slot.entries[cacheKey] = record;
    slot.lastNowMs = nowMs;
    slot.dirtyGen += 1;

    if (deferFlush) {
      if (!slot.debounceTimer) {
        slot.debounceTimer = setTimeout(() => {
          slot.debounceTimer = null;
          flushEpicOfferDiskCacheAsync(resolvedPath).catch(() => {});
        }, EPIC_OFFER_DEBOUNCE_MS);
        if (typeof slot.debounceTimer.unref === 'function') {
          slot.debounceTimer.unref();
        }
      }
      return;
    }

    await flushEpicOfferDiskCacheAsync(resolvedPath);
  } catch {}
}

/**
 * Extracts multi-OS system requirements (`systemRequirements`, `macRequirements`, `linuxRequirements`)
 * from Epic Content API `requirements.systems`, formatting and HTML-escaping untrusted fields.
 *
 * @param {Array<{ systemType?: string, details?: Array<{ title?: string, minimum?: string, recommended?: string }> }> | null | undefined} systems
 */
function extractEpicRequirementsByOs(systems) {
  if (!Array.isArray(systems) || systems.length === 0) {
    return {};
  }

  let systemRequirements = undefined;
  let macRequirements = undefined;
  let linuxRequirements = undefined;
  let fallbackRequirements = undefined;

  for (const sys of systems) {
    const details = Array.isArray(sys?.details) ? sys.details : [];
    if (details.length === 0) continue;

    const minReq = details
      .map((r) => {
        const rawTitle =
          typeof r?.title === 'string' ? r.title.trim().replace(/:$/, '').trim() : '';
        const rawMin = typeof r?.minimum === 'string' ? r.minimum.trim() : '';
        return rawTitle && rawMin
          ? `<strong>${escapeHtmlEntities(rawTitle)}:</strong> ${escapeHtmlEntities(rawMin)}`
          : '';
      })
      .filter(Boolean)
      .join('<br>');

    const recReq = details
      .map((r) => {
        const rawTitle =
          typeof r?.title === 'string' ? r.title.trim().replace(/:$/, '').trim() : '';
        const rawRec = typeof r?.recommended === 'string' ? r.recommended.trim() : '';
        return rawTitle && rawRec
          ? `<strong>${escapeHtmlEntities(rawTitle)}:</strong> ${escapeHtmlEntities(rawRec)}`
          : '';
      })
      .filter(Boolean)
      .join('<br>');

    if (!minReq && !recReq) continue;
    const parsed = {
      ...(minReq ? { minimum: minReq } : {}),
      ...(recReq ? { recommended: recReq } : {}),
    };

    const sysType = String(sys?.systemType || '').trim();
    if (/mac|os\s*x|darwin/i.test(sysType)) {
      if (!macRequirements) macRequirements = parsed;
    } else if (/linux|ubuntu|steam\s*os/i.test(sysType)) {
      if (!linuxRequirements) linuxRequirements = parsed;
    } else if (/win/i.test(sysType)) {
      if (!systemRequirements) systemRequirements = parsed;
    } else if (!fallbackRequirements) {
      fallbackRequirements = parsed;
    }
  }

  if (!systemRequirements && fallbackRequirements) {
    systemRequirements = fallbackRequirements;
  }

  return {
    ...(systemRequirements ? { systemRequirements } : {}),
    ...(macRequirements ? { macRequirements } : {}),
    ...(linuxRequirements ? { linuxRequirements } : {}),
  };
}

/**
 * Fetch rich Epic Store product offer metadata (descriptions, screenshots, HLS/MP4 trailers,
 * multi-OS system requirements, partner handoff) with strict HTTPS URL validation and coalesced
 * 7-day persistent disk caching.
 *
 * @param {Record<string, any>} [payload]
 * @param {Record<string, any>} [options]
 */
async function fetchEpicProductOfferMetadata(payload = {}, options = {}) {
  const fetchImpl = typeof options?.fetchFn === 'function' ? options.fetchFn : fetch;
  const deferFlush = options?.deferOfferCacheFlush === true;
  const nowMs =
    typeof options?.nowMs === 'number' && Number.isFinite(options.nowMs)
      ? options.nowMs
      : Date.now();
  const usePersistentOfferCache =
    options?.forceRefresh !== true &&
    options?.bypassOfferCache !== true &&
    (Boolean(options?.userDataDir || payload?.userDataDir) || !options?.fetchFn);
  const offerCachePath = usePersistentOfferCache
    ? getEpicOfferCachePath(options?.userDataDir ? options : payload)
    : '';

  try {
    const resolved = /** @type {Record<string, any> | null} */ (
      await resolveEpicNamespaceAndIds(payload, options)
    );
    const namespace = resolved?.namespace;
    const catalogItemId = resolved?.catalogItemId || payload.catalogItemId;
    if (!namespace) {
      return resolveLocalEpicOfferMetadataFallback(payload, options);
    }

    const cacheKey = `${namespace}:${String(catalogItemId || resolved?.appName || payload.title || '').toLowerCase()}`;
    if (!options?.fetchFn && options?.forceRefresh !== true && epicOfferMetadataCache.has(cacheKey)) {
      return epicOfferMetadataCache.get(cacheKey);
    }

    if (usePersistentOfferCache && offerCachePath) {
      const diskState = await loadEpicOfferDiskCacheAsync(offerCachePath);
      const diskEntry = diskState.entries[cacheKey];
      if (
        diskEntry &&
        typeof diskEntry.cachedAt === 'number' &&
        nowMs - diskEntry.cachedAt < EPIC_OFFER_CACHE_TTL_MS
      ) {
        if (diskEntry.miss) {
          return diskEntry.data ?? null;
        }
        if (diskEntry.data) {
          if (!options?.fetchFn) {
            setBoundedCacheEntry(
              epicOfferMetadataCache,
              cacheKey,
              diskEntry.data,
              MAX_STORE_SYNC_CACHE_ENTRIES
            );
          }
          return diskEntry.data;
        }
      }
    }

    let token =
      (typeof options?.accessToken === 'string' && options.accessToken.trim()) ||
      (await getEpicCatalogAccessToken(false, options));
    if (!token) {
      token = await getEpicCatalogAccessToken(true, options);
    }
    if (!token) {
      return resolveLocalEpicOfferMetadataFallback(
        { ...payload, appName: payload.appName || resolved?.appName },
        options
      );
    }

    const { locale, country } = resolveDefaultStoreLocaleAndCountry({
      ...options,
      locale: payload.locale || options.locale,
      country: payload.country || options.country,
      market: payload.market || options.market,
    });

    const offersUrl = `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${encodeURIComponent(namespace)}/offers?count=20&locale=${encodeURIComponent(locale)}&country=${encodeURIComponent(country)}`;
    let res = await fetchImpl(offersUrl, {
      headers: {
        Authorization: `bearer ${token}`,
        'User-Agent': buildPlatformStoreUserAgent('EpicGamesLauncher'),
      },
      signal: buildStoreFetchSignal(options.signal),
    });

    if (res.status === 401 || res.status === 403) {
      token = await getEpicCatalogAccessToken(true, options);
      if (token) {
        res = await fetchImpl(offersUrl, {
          headers: {
            Authorization: `bearer ${token}`,
            'User-Agent': buildPlatformStoreUserAgent('EpicGamesLauncher'),
          },
          signal: buildStoreFetchSignal(options.signal),
        });
      }
    }

    if (!res.ok) {
      const localFallback = resolveLocalEpicOfferMetadataFallback(
        { ...payload, appName: payload.appName || resolved?.appName },
        options
      );
      if (res.status === 404 && usePersistentOfferCache && offerCachePath) {
        await saveEpicOfferDiskCacheEntryAsync(
          offerCachePath,
          cacheKey,
          { miss: true, cachedAt: nowMs, data: localFallback || null },
          nowMs,
          deferFlush
        );
      }
      return localFallback;
    }
    const data = /** @type {any} */ (await res.json());
    const elements = Array.isArray(data?.elements) ? data.elements : [];
    if (elements.length === 0) {
      const localFallback = resolveLocalEpicOfferMetadataFallback(
        { ...payload, appName: payload.appName || resolved?.appName },
        options
      );
      if (usePersistentOfferCache && offerCachePath) {
        await saveEpicOfferDiskCacheEntryAsync(
          offerCachePath,
          cacheKey,
          { miss: true, cachedAt: nowMs, data: localFallback || null },
          nowMs,
          deferFlush
        );
      }
      return localFallback;
    }

    const normTarget = String(payload.title || resolved?.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');

    const baseGameOffers = elements.filter((/** @type {any} */ el) => el && el.offerType === 'BASE_GAME');
    let offer = null;
    if (baseGameOffers.length > 0) {
      offer =
        (normTarget
          ? baseGameOffers.find(
              (/** @type {any} */ el) =>
                String(el.title || '')
                  .toLowerCase()
                  .replace(/[^a-z0-9]/g, '') === normTarget
            )
          : null) || baseGameOffers[0];
    }
    if (!offer && normTarget) {
      offer = elements.find(
        (/** @type {any} */ el) =>
          el &&
          String(el.title || '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '') === normTarget
      );
    }
    if (!offer) {
      offer =
        elements.find(
          (/** @type {any} */ el) =>
            el &&
            el.offerType !== 'ADD_ON' &&
            el.offerType !== 'DLC' &&
            el.offerType !== 'CONSUMABLE'
        ) || elements[0];
    }
    if (!offer) {
      if (usePersistentOfferCache && offerCachePath) {
        await saveEpicOfferDiskCacheEntryAsync(
          offerCachePath,
          cacheKey,
          { miss: true, cachedAt: nowMs, data: null },
          nowMs,
          deferFlush
        );
      }
      return null;
    }

    const offerTitle = String(offer.title || payload.title || resolved?.title || '').trim();
    let rawShort = String(offer.description || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (
      rawShort.toLowerCase() === offerTitle.toLowerCase() ||
      /^description is not set\.?$/i.test(rawShort)
    ) {
      rawShort = '';
    }

    const rawLong = String(offer.longDescription || offer.technicalDetails || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();

    if (!rawShort && rawLong) {
      rawShort = extractFirstOfferParagraph(rawLong);
    }

    const keyImages = Array.isArray(offer.keyImages) ? offer.keyImages : [];
    /** @type {Set<string>} */
    const screenshotSet = new Set();
    for (const img of keyImages) {
      if (!img || typeof img.url !== 'string') continue;
      if (
        img.type === 'featuredMedia' ||
        img.type === 'GalleryImage' ||
        img.type === 'Screenshot'
      ) {
        const safeUrl = sanitizeSafeHttpsMediaUrl(img.url);
        if (safeUrl) screenshotSet.add(safeUrl);
      }
    }
    for (const img of keyImages) {
      if (!img || typeof img.url !== 'string') continue;
      if (img.type === 'heroCarouselVideo') {
        try {
          const parsedVideoUrl = new URL(img.url);
          const coverParam = parsedVideoUrl.searchParams.get('cover');
          const safeCover = sanitizeSafeHttpsMediaUrl(coverParam);
          if (safeCover) {
            screenshotSet.add(safeCover);
          }
        } catch {}
      }
    }

    const headerImage =
      sanitizeSafeHttpsMediaUrl(
        keyImages.find((/** @type {any} */ img) => img?.type === 'OfferImageWide')?.url
      ) ||
      sanitizeSafeHttpsMediaUrl(
        keyImages.find((/** @type {any} */ img) => img?.type === 'DieselGameBox')?.url
      ) ||
      sanitizeSafeHttpsMediaUrl(
        keyImages.find((/** @type {any} */ img) => img?.type === 'Thumbnail')?.url
      ) ||
      undefined;
    const capsuleImage =
      sanitizeSafeHttpsMediaUrl(
        keyImages.find((/** @type {any} */ img) => img?.type === 'OfferImageTall')?.url
      ) ||
      sanitizeSafeHttpsMediaUrl(
        keyImages.find((/** @type {any} */ img) => img?.type === 'DieselGameBoxTall')?.url
      ) ||
      undefined;

    /** @type {any[]} */
    const movies = [];
    let systemRequirements = undefined;
    let macRequirements = undefined;
    let linuxRequirements = undefined;
    let languages = undefined;

    const rawSlugCandidates = [
      ...(Array.isArray(offer.catalogNs?.mappings)
        ? offer.catalogNs.mappings.map((/** @type {any} */ m) => m?.pageSlug)
        : []),
      typeof offer.productSlug === 'string' ? offer.productSlug.split('/')[0] : '',
      typeof offer.urlSlug === 'string' ? offer.urlSlug : '',
      ...(Array.isArray(offer.customAttributes)
        ? offer.customAttributes
            .filter((/** @type {any} */ a) => a && /slug/i.test(String(a.key || '')))
            .map((/** @type {any} */ a) => String(a.value || '').replace(/\/home$/i, ''))
        : offer.customAttributes && typeof offer.customAttributes === 'object'
          ? [
              offer.customAttributes['com.epicgames.app.productSlug']?.value?.replace(
                /\/home$/i,
                ''
              ),
              ...Object.entries(offer.customAttributes)
                .filter(([k]) => /slug/i.test(k))
                .map(([, v]) =>
                  String(/** @type {any} */ (v)?.value || v || '').replace(/\/home$/i, '')
                ),
            ]
          : []),
      offerTitle
        ? offerTitle
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
        : '',
      payload.slug
        ? String(payload.slug)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
        : '',
    ];

    const candidateSlugs = Array.from(
      new Set(
        rawSlugCandidates
          .map((s) => String(s || '').trim().toLowerCase())
          .filter((s) => s.length > 1 && !/^[0-9a-f]{20,}$/i.test(s))
      )
    );

    const contentLocalesToTry = locale.toLowerCase() !== 'en-us' ? [locale, 'en-US'] : ['en-US'];

    for (const cSlug of candidateSlugs) {
      try {
        let contentData = null;
        for (const contentLoc of contentLocalesToTry) {
          const contentUrl = `https://store-content.ak.epicgames.com/api/${encodeURIComponent(contentLoc)}/content/products/${encodeURIComponent(cSlug)}`;
          const contentRes = await fetchImpl(contentUrl, {
            headers: {
              'User-Agent': buildPlatformStoreUserAgent('EpicGamesLauncher'),
              Accept: 'application/json',
            },
            signal: buildStoreFetchSignal(options.signal),
          });
          if (contentRes.ok) {
            contentData = /** @type {any} */ (await contentRes.json());
            break;
          }
        }
        if (!contentData) continue;
        const home =
          (Array.isArray(contentData?.pages) &&
            contentData.pages.find((/** @type {any} */ p) => p && p.type === 'productHome')) ||
          contentData?.pages?.[0];
        if (!home?.data) continue;

        const d = home.data;
        const carouselItems = Array.isArray(d.carousel?.items) ? d.carousel.items : [];
        carouselItems.forEach((/** @type {any} */ item, /** @type {number} */ idx) => {
          if (!item) return;
          const rawImg =
            item.image?.src ||
            item.image?.url ||
            (typeof item.image === 'string' ? item.image : null) ||
            item.src ||
            item.url;
          const safeCarouselImg = sanitizeSafeHttpsMediaUrl(rawImg);
          if (safeCarouselImg) {
            screenshotSet.add(safeCarouselImg);
          }

          if (item.video?.recipes) {
            try {
              const recipes =
                typeof item.video.recipes === 'string'
                  ? JSON.parse(item.video.recipes)
                  : item.video.recipes;
              const langObj =
                recipes?.[locale] ||
                recipes?.[locale.split('-')[0]] ||
                recipes?.['en-US'] ||
                recipes?.['en'] ||
                (recipes && typeof recipes === 'object' ? Object.values(recipes)[0] : null);
              if (Array.isArray(langObj)) {
                const hlsOutput = langObj
                  .find((r) => r && r.recipe === 'video-hls')
                  ?.outputs?.find((/** @type {any} */ o) => o && o.key === 'manifest');
                const mp4Output = langObj
                  .find((r) => r && (r.recipe === 'video-fmp4' || r.recipe === 'video-webm'))
                  ?.outputs?.find((/** @type {any} */ o) => o && o.key === 'manifest');
                const thumbOutput = langObj
                  .find(
                    (r) =>
                      Array.isArray(r?.outputs) &&
                      r.outputs.some((/** @type {any} */ o) => o?.key === 'thumbnail')
                  )
                  ?.outputs?.find((/** @type {any} */ o) => o?.key === 'thumbnail');

                const safeHlsUrl = sanitizeSafeHttpsMediaUrl(hlsOutput?.url);
                const safeMp4Url = sanitizeSafeHttpsMediaUrl(mp4Output?.url);
                const videoUrl = safeHlsUrl || safeMp4Url;
                const thumbUrl = sanitizeSafeHttpsMediaUrl(thumbOutput?.url);
                if (videoUrl) {
                  movies.push({
                    id: idx,
                    name: `Trailer ${movies.length + 1}`,
                    thumbnail: thumbUrl,
                    webm: { '480': videoUrl, max: videoUrl },
                    mp4: { '480': videoUrl, max: videoUrl },
                    hls: safeHlsUrl || undefined,
                  });
                }
                if (thumbUrl) {
                  screenshotSet.add(thumbUrl);
                }
              }
            } catch {}
          }
        });

        const galleryImages = Array.isArray(d.gallery?.galleryImages) ? d.gallery.galleryImages : [];
        for (const g of galleryImages) {
          const gUrl = g?.src || g?.url || (typeof g === 'string' ? g : null);
          const safeGalleryUrl = sanitizeSafeHttpsMediaUrl(gUrl);
          if (safeGalleryUrl) {
            screenshotSet.add(safeGalleryUrl);
          }
        }

        const parsedEpicReqs = extractEpicRequirementsByOs(d.requirements?.systems);
        if (parsedEpicReqs.systemRequirements) {
          systemRequirements = parsedEpicReqs.systemRequirements;
        }
        if (parsedEpicReqs.macRequirements) {
          macRequirements = parsedEpicReqs.macRequirements;
        }
        if (parsedEpicReqs.linuxRequirements) {
          linuxRequirements = parsedEpicReqs.linuxRequirements;
        }

        if (Array.isArray(d.requirements?.languages) && d.requirements.languages.length > 0) {
          languages = d.requirements.languages.filter(
            (/** @type {unknown} */ l) => typeof l === 'string' && l.trim().length > 0
          );
        } else if (
          typeof d.requirements?.languages === 'string' &&
          d.requirements.languages.trim()
        ) {
          languages = [d.requirements.languages.trim()];
        }

        if (!rawLong) {
          const contentDesc = String(
            d.about?.description || d.about?.about || d.markdown?.markdown || ''
          )
            .replace(/<!--[\s\S]*?-->/g, '')
            .trim();
          if (contentDesc) {
            rawShort = rawShort || extractFirstOfferParagraph(contentDesc);
          }
        }

        break;
      } catch {}
    }

    let screenshots = Array.from(screenshotSet);
    if (screenshots.length === 0 && headerImage) {
      screenshots = [headerImage];
    }

    const rawDate =
      offer.pcReleaseDate || offer.releaseDate || offer.effectiveDate || offer.viewableDate || '';
    const releaseDate =
      rawDate && !String(rawDate).startsWith('2099')
        ? String(rawDate).substring(0, 10)
        : undefined;

    const devName = String(offer.developerDisplayName || offer.seller?.name || '').trim();
    const pubName = String(offer.publisherDisplayName || offer.seller?.name || '').trim();
    const localLegendaryAttrs = await readLocalLegendaryCustomAttributesAsync(
      payload.appName || resolved?.appName || '',
      payload.legendaryDirs || getLocalLegendaryBaseDirs(options)
    );
    const partnerHandoff = resolveEpicPartnerChainedHandoff(
      offer.customAttributes,
      payload.customAttributes,
      localLegendaryAttrs
    );

    const result = {
      title: offerTitle || undefined,
      shortDescription: rawShort || undefined,
      detailedDescription: rawLong || rawShort || undefined,
      aboutTheGame: rawLong || rawShort || undefined,
      screenshots,
      movies: movies.length > 0 ? movies : undefined,
      systemRequirements,
      ...(macRequirements ? { macRequirements } : {}),
      ...(linuxRequirements ? { linuxRequirements } : {}),
      languages,
      supportedLanguages:
        Array.isArray(languages) && languages.length > 0 ? languages.join(' | ') : undefined,
      headerImage,
      capsuleImage,
      releaseDate,
      developers: devName ? [devName] : undefined,
      publishers: pubName ? [pubName] : undefined,
      namespace,
      catalogItemId: catalogItemId || offer.id || undefined,
      ...(offer.customAttributes ? { customAttributes: offer.customAttributes } : {}),
      ...(partnerHandoff
        ? {
            chainedLauncherHandoff: partnerHandoff.chainedLauncherHandoff,
            externalStorefrontHandoff: partnerHandoff.externalStorefrontHandoff,
            chainedHandoffTopology: 'partner_launcher_link',
            ...(partnerHandoff.epicPartnerRegistryPath
              ? { epicPartnerRegistryPath: partnerHandoff.epicPartnerRegistryPath }
              : {}),
            ...(partnerHandoff.epicPartnerRegistryKey
              ? { epicPartnerRegistryKey: partnerHandoff.epicPartnerRegistryKey }
              : {}),
            platforms: { windows: true, mac: false, linux: false },
          }
        : {}),
    };

    if (!options?.fetchFn) {
      setBoundedCacheEntry(epicOfferMetadataCache, cacheKey, result, MAX_STORE_SYNC_CACHE_ENTRIES);
    }
    if (usePersistentOfferCache && offerCachePath) {
      await saveEpicOfferDiskCacheEntryAsync(
        offerCachePath,
        cacheKey,
        { miss: false, cachedAt: nowMs, data: result },
        nowMs,
        deferFlush
      );
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('fetchEpicProductOfferMetadata warning:', msg);
    return resolveLocalEpicOfferMetadataFallback(payload, options);
  }
}

/**
 * Fetch Epic Games Owned Library & Playtime with `seenCursors` cycle protection and coalesced
 * single-flush offer cache persistence.
 *
 * @param {string} accessToken
 * @param {string} accountId
 * @param {Record<string, any>} [options]
 */
async function fetchEpicOwnedGames(accessToken, accountId, options = {}) {
  const fetchImpl = typeof options?.fetchFn === 'function' ? options.fetchFn : fetch;
  /** @type {Map<string, { totalTime: number, lastPlayed: string | null }>} */
  const playtimeMap = new Map();
  let encounteredEpicOfflineFailure = false;
  let completedAllLibraryPages = false;
  let abortedLibraryPaginationEarly = false;
  let catalogBatchEncounteredError = false;
  let hadUnresolvedCatalogFailure = false;

  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    return attachStoreSyncCallMetadata(
      [],
      fetchEpicOwnedGames,
      { authoritativeComplete: false, achievementsMap: {}, suppressedItems: [] },
      options
    );
  }

  const playtimePromise = (async () => {
    if (!accountId) return;
    try {
      const playtimeUrl = `https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account/${encodeURIComponent(accountId)}/all`;
      const ptRes = await fetchImpl(playtimeUrl, {
        headers: {
          Authorization: `bearer ${accessToken}`,
          'User-Agent': buildPlatformStoreUserAgent('EpicGamesLauncher'),
        },
        signal: buildStoreFetchSignal(options.signal),
      });

      if (ptRes.ok) {
        const ptData = await ptRes.json();
        if (Array.isArray(ptData)) {
          for (const item of ptData) {
            if (item.artifactId) {
              playtimeMap.set(item.artifactId, {
                totalTime: Math.round((item.totalTime || 0) / 60),
                lastPlayed: item.lastPlayed || null,
              });
            }
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('Epic playtime fetch warning:', msg);
    }
  })();

  const achievementsPromise = fetchEpicAchievements(accessToken, accountId, options).catch(
    () => ({})
  );

  const localLegendaryDirs = getLocalLegendaryBaseDirs(options);
  const macEpicAppIdsPromise = (async () => {
    const macIds = await extractEpicMacSupportFromLegendaryDirsAsync(localLegendaryDirs);
    if (accessToken) {
      const macAbort = new AbortController();
      const macTimeout = setTimeout(() => macAbort.abort(), 4000);
      try {
        const macRes = await fetchImpl(
          'https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/public/assets/Mac?label=Live',
          {
            signal: buildStoreFetchSignal(macAbort.signal, 4000),
            headers: {
              Authorization: `bearer ${accessToken}`,
              'User-Agent': buildPlatformStoreUserAgent('EpicGamesLauncher'),
            },
          }
        );
        if (macRes.ok) {
          const macAssets = await macRes.json();
          if (Array.isArray(macAssets)) {
            for (const a of macAssets) {
              const an = String(a?.appName || a?.app_name || '').toLowerCase().trim();
              const cid = String(a?.catalogItemId || a?.catalog_item_id || '').toLowerCase().trim();
              const aid = String(a?.assetId || a?.asset_id || '').toLowerCase().trim();
              if (an) macIds.add(an);
              if (cid) macIds.add(cid);
              if (aid) macIds.add(aid);
            }
          }
        }
      } catch {}
      clearTimeout(macTimeout);
    }
    return macIds;
  })();

  /** @type {Map<string, any>} */
  const gamesMap = new Map();
  const knownAppIds = new Set();
  const seenCandidateKeys = new Set();
  /** @type {any[]} */
  const suppressedItems = [];

  /**
   * @param {any} item
   * @param {string} title
   * @param {string} reason
   * @param {string} [description]
   * @param {string} [developer]
   * @param {any[]} [keyImages]
   */
  const pushEpicSuppressedItem = (
    item,
    title,
    reason,
    description = '',
    developer = '',
    keyImages = []
  ) => {
    if (!title || title === 'Live' || /^[0-9a-f]{20,}$/i.test(title)) return;
    const appName = item.appName || item.catalogItemId || title;
    const tallCover =
      sanitizeSafeHttpsMediaUrl(
        Array.isArray(keyImages)
          ? keyImages.find(
              (img) => img.type === 'DieselGameBoxTall' || img.type === 'OfferImageTall'
            )?.url
          : ''
      ) || '';
    const wideBanner =
      sanitizeSafeHttpsMediaUrl(
        Array.isArray(keyImages)
          ? keyImages.find((img) => img.type === 'DieselGameBox' || img.type === 'OfferImageWide')
              ?.url
          : ''
      ) ||
      tallCover ||
      '';
    const rawGame = {
      id: `epic-${appName}`,
      title,
      originalStoreTitle: title,
      sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
      isVerifiedEntitlement: true,
      platforms: [
        {
          platformId: 'epic',
          platformGameId: String(appName),
          originalTitle: title,
          namespace: item.namespace || undefined,
          catalogItemId: item.catalogItemId || undefined,
          installed: false,
        },
      ],
      headerImage: wideBanner,
      capsuleImage: tallCover || wideBanner,
      shortDescription: description || '',
      releaseDate: '',
      developers: developer ? [developer] : [],
      publishers: ['Epic Games Store'],
      genres: [],
      tags: ['Epic Games Store'],
    };
    suppressedItems.push({
      id: `epic-${appName}`,
      rawTitle: title,
      platformId: 'epic',
      platformGameId: String(appName),
      reason,
      reasonCategory: 'non_game_filter',
      rawGame,
    });
  };

  /** @type {Record<string, any>} */
  let achievementsMap = {};
  const batchOfferCachePath =
    options?.forceRefresh !== true &&
    options?.bypassOfferCache !== true &&
    (Boolean(options?.userDataDir) || !options?.fetchFn)
      ? getEpicOfferCachePath(options)
      : '';

  try {
    /** @type {string | undefined} */
    let cursor = undefined;
    let hasMore = true;
    let pageCount = 0;
    const seenCursors = new Set();
    /** @type {any[]} */
    const candidateRecords = [];

    while (hasMore && pageCount < 100) {
      const fetchUrl = cursor
        ? `https://library-service.live.use1a.on.epicgames.com/library/api/public/items?includeMetadata=true&cursor=${encodeURIComponent(cursor)}`
        : 'https://library-service.live.use1a.on.epicgames.com/library/api/public/items?includeMetadata=true';

      const res = await fetchImpl(fetchUrl, {
        headers: {
          Authorization: `bearer ${accessToken}`,
          'User-Agent': buildPlatformStoreUserAgent('EpicGamesLauncher'),
        },
        signal: buildStoreFetchSignal(options.signal),
      });

      if (!res.ok) {
        if (pageCount === 0 && (res.status === 401 || res.status === 403)) {
          throw new Error(`Epic library API unauthorized (${res.status})`);
        }
        encounteredEpicOfflineFailure = true;
        abortedLibraryPaginationEarly = true;
        console.warn(`Epic library fetch returned status ${res.status}`);
        break;
      }

      const data = /** @type {any} */ (await res.json());
      const records = data.records || [];
      candidateRecords.push(...records);

      const nextCursor =
        typeof data.responseMetadata?.nextCursor === 'string'
          ? data.responseMetadata.nextCursor.trim()
          : '';
      pageCount++;
      if (!nextCursor) {
        cursor = undefined;
        hasMore = false;
        break;
      }
      if (seenCursors.has(nextCursor)) {
        abortedLibraryPaginationEarly = true;
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      hasMore = true;
    }

    if (!abortedLibraryPaginationEarly && !encounteredEpicOfflineFailure && !hasMore) {
      completedAllLibraryPages = true;
    }

    /** @type {any[]} */
    const filteredItems = [];
    for (const item of candidateRecords) {
      if (!item.appName || item.appName === '1' || item.sandboxType === 'PRIVATE') continue;
      if (
        item.namespace === 'ue' ||
        item.namespace === '89efe5924d3d467c839449ab6ab52e7f' ||
        item.namespace?.startsWith('ue-')
      ) {
        continue;
      }

      const metaTitle = (item.metadata?.title || '').trim();
      const itemType = (item.metadata?.itemType || '').toUpperCase();
      const rawCatalogId = String(item.catalogItemId || item.metadata?.id || '').trim();
      const mainGameObj = item.metadata?.mainGameItem || item.mainGameItem || null;
      const mainGameTargetId =
        mainGameObj && typeof mainGameObj === 'object' && typeof mainGameObj.id === 'string'
          ? mainGameObj.id.trim()
          : '';
      const hasDistinctParentGame = Boolean(
        mainGameObj &&
          (mainGameTargetId || mainGameObj.namespace) &&
          (!rawCatalogId || !mainGameTargetId || mainGameTargetId !== rawCatalogId)
      );

      const unambiguousDlcType = [
        'ADD_ON',
        'ADDON',
        'ADD-ON',
        'DLC',
        'CONSUMABLE',
        'WALLET',
        'SUBSCRIPTION',
        'PLUGIN',
        'EXTRA',
        'CURRENCY',
      ].includes(itemType);

      const rawCategories = Array.isArray(item.metadata?.categories) ? item.metadata.categories : [];
      const earlyCatSegments = new Set();
      for (const c of rawCategories) {
        const p = String(typeof c === 'string' ? c : c?.path || '').toLowerCase();
        for (const seg of p.split('/')) {
          if (seg.trim()) earlyCatSegments.add(seg.trim());
        }
      }
      const hasDefinitiveDlcCategory =
        !earlyCatSegments.has('games') &&
        ['addons', 'add-on', 'addon', 'dlc', 'consumable'].some((s) => earlyCatSegments.has(s));

      if (unambiguousDlcType || hasDistinctParentGame || hasDefinitiveDlcCategory) {
        if (metaTitle) {
          pushEpicSuppressedItem(
            item,
            metaTitle,
            'Filtered: DLC / Add-On / Expansion Content',
            item.metadata?.description || '',
            item.metadata?.developer || '',
            item.metadata?.keyImages || []
          );
        }
        continue;
      }

      const appNameLower = (item.appName || '').toLowerCase().trim();
      const catalogIdLower = (item.catalogItemId || '').toLowerCase().trim();
      if (
        (appNameLower && seenCandidateKeys.has(`app:${appNameLower}`)) ||
        (catalogIdLower && seenCandidateKeys.has(`cat:${catalogIdLower}`))
      ) {
        continue;
      }
      if (appNameLower) seenCandidateKeys.add(`app:${appNameLower}`);
      if (catalogIdLower) seenCandidateKeys.add(`cat:${catalogIdLower}`);

      filteredItems.push(item);
    }

    /** @param {string} rawTitle */
    const isUnhydratedTitleValue = (rawTitle) =>
      !rawTitle ||
      rawTitle === 'Live' ||
      /^[0-9a-f]{20,}$/i.test(rawTitle) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawTitle);

    /** @type {Map<string, Set<string>>} */
    const bulkIdsByNamespace = new Map();
    for (const item of filteredItems) {
      const title = (item.metadata?.title || '').trim();
      const cats = Array.isArray(item.metadata?.categories) ? item.metadata.categories : [];
      const needsLookup = isUnhydratedTitleValue(title) || cats.length === 0;
      if (needsLookup && item.namespace && item.catalogItemId) {
        let idSet = bulkIdsByNamespace.get(item.namespace);
        if (!idSet) {
          idSet = new Set();
          bulkIdsByNamespace.set(item.namespace, idSet);
        }
        idSet.add(String(item.catalogItemId));
      }
    }

    /** @type {Map<string, any>} */
    const catalogMetaByNsAndId = new Map();
    const EPIC_BULK_ITEMS_MAX_IDS = 50;
    /** @type {Array<{ namespace: string, ids: string[] }>} */
    const bulkChunks = [];
    for (const [namespace, idSet] of bulkIdsByNamespace.entries()) {
      const allIds = Array.from(idSet);
      for (let idx = 0; idx < allIds.length; idx += EPIC_BULK_ITEMS_MAX_IDS) {
        bulkChunks.push({ namespace, ids: allIds.slice(idx, idx + EPIC_BULK_ITEMS_MAX_IDS) });
      }
    }

    const BULK_CHUNK_CONCURRENCY = 4;
    for (let cIdx = 0; cIdx < bulkChunks.length; cIdx += BULK_CHUNK_CONCURRENCY) {
      const chunkSlice = bulkChunks.slice(cIdx, cIdx + BULK_CHUNK_CONCURRENCY);
      await Promise.all(
        chunkSlice.map(async ({ namespace, ids }) => {
          let remainingIds = [...ids];
          const maxAttempts = remainingIds.length;
          for (let pass = 0; pass < maxAttempts && remainingIds.length > 0; pass++) {
            const catAbort = new AbortController();
            const catTimer = setTimeout(() => catAbort.abort(), 8000);
            try {
              const idQuery = remainingIds
                .map((cid) => `id=${encodeURIComponent(cid)}`)
                .join('&');
              const catUrl = `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${encodeURIComponent(namespace)}/bulk/items?${idQuery}&includeDLCDetails=true&includeMainGameDetails=true`;
              const cRes = await fetchImpl(catUrl, {
                signal: buildStoreFetchSignal(catAbort.signal, 8000),
                headers: {
                  Authorization: `bearer ${accessToken}`,
                  'User-Agent': buildPlatformStoreUserAgent('EpicGamesLauncher'),
                },
              });
              if (!cRes.ok) {
                catalogBatchEncounteredError = true;
                break;
              }
              const cData = /** @type {any} */ (await cRes.json());
              let matchedCount = 0;
              /** @type {string[]} */
              const nextRemaining = [];
              for (const cid of remainingIds) {
                if (cData && typeof cData === 'object' && cData[cid]) {
                  catalogMetaByNsAndId.set(`${namespace}:${cid}`, cData[cid]);
                  matchedCount += 1;
                } else {
                  nextRemaining.push(cid);
                }
              }
              if (nextRemaining.length === 0 || matchedCount === 0) {
                break;
              }
              remainingIds = nextRemaining;
            } catch {
              catalogBatchEncounteredError = true;
              break;
            } finally {
              clearTimeout(catTimer);
            }
          }
        })
      );
    }

    const [, resolvedAchievementsMap, macEpicAppIds] = await Promise.all([
      playtimePromise,
      achievementsPromise,
      macEpicAppIdsPromise,
    ]);
    achievementsMap = resolvedAchievementsMap || {};

    /** @param {any} relList */
    const hasReleaseInfoPlatformMac = (relList) =>
      Array.isArray(relList) &&
      relList.some(
        (r) =>
          r &&
          Array.isArray(r.platform) &&
          r.platform.some((/** @type {any} */ p) => /^mac$/i.test(String(p)))
      );

    const offerFetchBatchOpts = { ...options, deferOfferCacheFlush: true };
    const BATCH_SIZE = 6;
    for (let i = 0; i < filteredItems.length; i += BATCH_SIZE) {
      const batch = filteredItems.slice(i, i + BATCH_SIZE);
      const resolvedBatch = await Promise.all(
        batch.map(async (item) => {
          const appNameLower = (item.appName || '').toLowerCase().trim();
          const catalogIdLower = (item.catalogItemId || '').toLowerCase().trim();
          let title = (item.metadata?.title || '').trim();
          let description = item.metadata?.description || '';
          let developer = item.metadata?.developer || '';
          let keyImages = item.metadata?.keyImages || [];
          let hasReleaseInfoMac = hasReleaseInfoPlatformMac(item.metadata?.releaseInfo);
          let catalogCustomAttributes = null;
          let categories = Array.isArray(item.metadata?.categories)
            ? [...item.metadata.categories]
            : [];
          let itemType = (item.metadata?.itemType || '').toUpperCase();
          let mainGameItem = item.metadata?.mainGameItem || item.mainGameItem || null;

          const needsCatalogLookup = isUnhydratedTitleValue(title) || categories.length === 0;

          if (needsCatalogLookup && item.namespace && item.catalogItemId) {
            let resolvedFromCatalog = false;
            const meta = catalogMetaByNsAndId.get(`${item.namespace}:${item.catalogItemId}`) || null;
            if (meta) {
              catalogCustomAttributes = meta.customAttributes || null;
              if (hasReleaseInfoPlatformMac(meta.releaseInfo)) {
                hasReleaseInfoMac = true;
              }
              if (meta.title) {
                title = meta.title;
                resolvedFromCatalog = true;
              }
              if (Array.isArray(meta.categories) && meta.categories.length > 0) {
                categories = meta.categories;
              }
              if (meta.itemType) {
                itemType = meta.itemType.toUpperCase();
              }
              if (meta.mainGameItem) {
                mainGameItem = meta.mainGameItem;
              }
              description = meta.description || description;
              developer = meta.developer || developer;
              keyImages = meta.keyImages || keyImages;
            }
            const isUnhydratedTitle = isUnhydratedTitleValue(title);

            if (!resolvedFromCatalog && (isUnhydratedTitle || categories.length === 0)) {
              const localEpicFallback = storefrontLocalCacheFederator.resolveLocalEpicMetadata(
                item.appName,
                options
              );
              if (localEpicFallback && localEpicFallback.title) {
                if (localEpicFallback.isDlc) return null;
                if (isUnhydratedTitle) {
                  title = localEpicFallback.title;
                }
                description = localEpicFallback.shortDescription || description;
                developer = localEpicFallback.developers?.[0] || developer;
                keyImages =
                  Array.isArray(localEpicFallback.keyImages) &&
                  localEpicFallback.keyImages.length > 0
                    ? localEpicFallback.keyImages
                    : keyImages;
                if (
                  Array.isArray(localEpicFallback.categories) &&
                  localEpicFallback.categories.length > 0
                ) {
                  categories = localEpicFallback.categories;
                }
                if (localEpicFallback.platforms?.mac) {
                  hasReleaseInfoMac = true;
                }
              } else if (isUnhydratedTitle) {
                if (catalogBatchEncounteredError) {
                  hadUnresolvedCatalogFailure = true;
                }
                return null;
              }
            }
          }

          if (isUnhydratedTitleValue(title)) {
            if (catalogBatchEncounteredError) {
              hadUnresolvedCatalogFailure = true;
            }
            return null;
          }

          if (categories.length === 0) {
            categories = [{ path: 'games' }];
          }

          let cleanDesc = String(description || '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/\[\/?[a-z0-9_*=\s"'-]+\]/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (
            cleanDesc.toLowerCase() === title.toLowerCase().trim() ||
            /^description is not set\.?$/i.test(cleanDesc) ||
            (!/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(title) &&
              /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(cleanDesc))
          ) {
            cleanDesc = '';
          } else {
            const bleedMatch = cleanDesc.match(/,\s+([A-Z][A-Z0-9]{3,})\s+is\s+(?:a|an|the)\b/);
            if (bleedMatch && bleedMatch[1] && !title.toUpperCase().includes(bleedMatch[1])) {
              cleanDesc = '';
            }
          }

          const nonGameReason = classifyNonGameStorefrontItem({
            store: 'epic',
            title,
            platformId: 'epic',
            platformGameId: item.appName,
            catalogItemId: item.catalogItemId || '',
            namespace: item.namespace || '',
            itemType,
            mainGameItem,
            categories,
          });
          if (nonGameReason) {
            pushEpicSuppressedItem(item, title, nonGameReason, cleanDesc, developer, keyImages);
            return null;
          }

          registerEpicNamespaceMapping({
            appName: item.appName,
            namespace: item.namespace,
            catalogItemId: item.catalogItemId,
            title,
          });

          /** @type {any} */
          let offerMeta = null;
          if (!cleanDesc && item.namespace) {
            try {
              offerMeta = await fetchEpicProductOfferMetadata(
                {
                  appName: item.appName,
                  namespace: item.namespace,
                  catalogItemId: item.catalogItemId,
                  title,
                },
                offerFetchBatchOpts
              );
              if (offerMeta?.shortDescription) {
                cleanDesc = offerMeta.shortDescription;
              }
              if (!developer && offerMeta?.developers?.[0]) {
                developer = offerMeta.developers[0];
              }
            } catch {}
          }
          if (!cleanDesc || !developer || !Array.isArray(keyImages) || keyImages.length === 0) {
            const localEpic = storefrontLocalCacheFederator.resolveLocalEpicMetadata(item.appName, {
              ...options,
              title,
            });
            if (localEpic) {
              if (!cleanDesc && localEpic.shortDescription) {
                cleanDesc = localEpic.shortDescription;
              }
              if (!developer && localEpic.developers?.[0]) {
                developer = localEpic.developers[0];
              }
              if (
                (!Array.isArray(keyImages) || keyImages.length === 0) &&
                localEpic.keyImages?.length
              ) {
                keyImages = localEpic.keyImages;
              }
              if (!offerMeta) {
                offerMeta = localEpic;
              }
            }
          }

          const localLegendaryCustomAttrs = await readLocalLegendaryCustomAttributesAsync(
            item.appName,
            localLegendaryDirs
          );
          const partnerHandoff =
            resolveEpicPartnerChainedHandoff(
              item.metadata?.customAttributes,
              item.customAttributes,
              catalogCustomAttributes,
              offerMeta?.customAttributes,
              localLegendaryCustomAttrs
            ) ||
            (offerMeta?.chainedLauncherHandoff === 'ea' ||
            offerMeta?.chainedLauncherHandoff === 'ubisoft'
              ? {
                  chainedLauncherHandoff: offerMeta.chainedLauncherHandoff,
                  externalStorefrontHandoff: offerMeta.chainedLauncherHandoff,
                  chainedHandoffTopology: 'partner_launcher_link',
                  ...(offerMeta.epicPartnerRegistryPath
                    ? { epicPartnerRegistryPath: offerMeta.epicPartnerRegistryPath }
                    : {}),
                  ...(offerMeta.epicPartnerRegistryKey
                    ? { epicPartnerRegistryKey: offerMeta.epicPartnerRegistryKey }
                    : {}),
                }
              : null);

          return {
            item,
            appNameLower,
            catalogIdLower,
            namespaceLower: (item.namespace || '').toLowerCase().trim(),
            title,
            description: cleanDesc,
            developer,
            keyImages,
            offerMeta,
            hasReleaseInfoMac,
            partnerHandoff,
          };
        })
      );

      for (const entry of resolvedBatch) {
        if (!entry) continue;
        const {
          item,
          appNameLower,
          catalogIdLower,
          namespaceLower,
          title,
          description,
          developer,
          keyImages,
          offerMeta,
          hasReleaseInfoMac,
          partnerHandoff,
        } = entry;
        const lower = title.toLowerCase().trim();
        if (knownAppIds.has(appNameLower)) continue;

        const hasEpicMac = partnerHandoff
          ? false
          : macEpicAppIds.has(appNameLower) ||
            Boolean(catalogIdLower && macEpicAppIds.has(catalogIdLower)) ||
            Boolean(hasReleaseInfoMac);

        const tallCover =
          sanitizeSafeHttpsMediaUrl(
            keyImages.find(
              (/** @type {any} */ img) =>
                img.type === 'DieselGameBoxTall' || img.type === 'OfferImageTall'
            )?.url
          ) ||
          sanitizeSafeHttpsMediaUrl(offerMeta?.capsuleImage) ||
          '';
        const wideBanner =
          sanitizeSafeHttpsMediaUrl(
            keyImages.find(
              (/** @type {any} */ img) =>
                img.type === 'DieselGameBox' || img.type === 'OfferImageWide'
            )?.url
          ) ||
          sanitizeSafeHttpsMediaUrl(offerMeta?.headerImage) ||
          tallCover;
        const pt =
          playtimeMap.get(item.appName) || playtimeMap.get(item.catalogItemId) || {
            totalTime: 0,
            lastPlayed: null,
          };

        const headerImg = wideBanner || 'https://cdn2.unrealengine.com/egs-badge.png';
        const capsuleImg = tallCover || wideBanner || 'https://cdn2.unrealengine.com/egs-badge.png';

        const finalDev = developer || offerMeta?.developers?.[0] || '';
        const gameId = `epic-${item.appName}`;
        const normTitle = lower.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
        const gameAch =
          (namespaceLower ? achievementsMap[namespaceLower] : null) ||
          achievementsMap[lower] ||
          achievementsMap[normTitle] ||
          achievementsMap[appNameLower] ||
          (catalogIdLower ? achievementsMap[catalogIdLower] : null);

        if (gameAch) {
          achievementsMap[appNameLower] = gameAch;
          achievementsMap[`epic-${appNameLower}`] = gameAch;
          achievementsMap[gameId.toLowerCase()] = gameAch;
          achievementsMap[lower] = gameAch;
          achievementsMap[normTitle] = gameAch;
        }

        const resolvedReleaseDate =
          offerMeta?.releaseDate ||
          (item.metadata?.releaseDate && !String(item.metadata.releaseDate).startsWith('2099')
            ? String(item.metadata.releaseDate).split('T')[0]
            : '');
        const resolvedDevs = finalDev ? [finalDev] : offerMeta?.developers || [];
        const resolvedPubs = item.metadata?.publisher
          ? [item.metadata.publisher]
          : offerMeta?.publishers || ['Epic Games Store'];
        const resolvedGenres =
          Array.isArray(offerMeta?.genres) && offerMeta.genres.length > 0 ? offerMeta.genres : [];

        const newGame = {
          id: gameId,
          title,
          sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
          steamAppId: undefined,
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'epic',
              platformGameId: item.appName,
              namespace: item.namespace || offerMeta?.namespace || undefined,
              catalogItemId: item.catalogItemId || offerMeta?.catalogItemId || undefined,
              installed: false,
              playtimeMinutes: pt.totalTime || 0,
              lastPlayed: pt.lastPlayed || undefined,
              achievements: gameAch || undefined,
              platforms: { windows: true, mac: hasEpicMac, linux: false },
              ...(partnerHandoff
                ? {
                    chainedLauncherHandoff: partnerHandoff.chainedLauncherHandoff,
                    externalStorefrontHandoff: partnerHandoff.externalStorefrontHandoff,
                    chainedHandoffTopology: 'partner_launcher_link',
                    ...(partnerHandoff.epicPartnerRegistryPath
                      ? { epicPartnerRegistryPath: partnerHandoff.epicPartnerRegistryPath }
                      : {}),
                    ...(partnerHandoff.epicPartnerRegistryKey
                      ? { epicPartnerRegistryKey: partnerHandoff.epicPartnerRegistryKey }
                      : {}),
                  }
                : {}),
            },
          ],
          headerImage: headerImg,
          capsuleImage: capsuleImg,
          shortDescription: description || offerMeta?.shortDescription || '',
          detailedDescription: offerMeta?.detailedDescription || undefined,
          releaseDate: resolvedReleaseDate,
          developers: resolvedDevs,
          publishers: resolvedPubs,
          genres: resolvedGenres,
          tags: ['Epic Games Store'],
          enrichedMetadata: offerMeta
            ? {
                appId: 0,
                name: title,
                shortDescription: description || offerMeta.shortDescription || '',
                detailedDescription: offerMeta.detailedDescription || description || '',
                aboutTheGame:
                  offerMeta.aboutTheGame || offerMeta.detailedDescription || description || '',
                headerImage: offerMeta.headerImage || headerImg,
                capsuleImage: offerMeta.capsuleImage || capsuleImg,
                developers: resolvedDevs,
                publishers: resolvedPubs,
                genres: resolvedGenres,
                tags: ['Epic Games Store'],
                categories: [],
                screenshots: Array.isArray(offerMeta.screenshots)
                  ? offerMeta.screenshots.map((/** @type {string} */ url, /** @type {number} */ idx) => ({
                      id: idx,
                      pathThumbnail: url,
                      pathFull: url,
                    }))
                  : [],
                movies: [],
                releaseDate: resolvedReleaseDate || 'Available Now',
                platforms: { windows: true, mac: hasEpicMac, linux: false },
                ...(partnerHandoff
                  ? {
                      chainedLauncherHandoff: partnerHandoff.chainedLauncherHandoff,
                      externalStorefrontHandoff: partnerHandoff.externalStorefrontHandoff,
                      chainedHandoffTopology: 'partner_launcher_link',
                      ...(partnerHandoff.epicPartnerRegistryPath
                        ? { epicPartnerRegistryPath: partnerHandoff.epicPartnerRegistryPath }
                        : {}),
                      ...(partnerHandoff.epicPartnerRegistryKey
                        ? { epicPartnerRegistryKey: partnerHandoff.epicPartnerRegistryKey }
                        : {}),
                    }
                  : {}),
              }
            : undefined,
        };

        gamesMap.set(gameId, newGame);
        knownAppIds.add(appNameLower);
        if (catalogIdLower) knownAppIds.add(catalogIdLower);
      }
    }
  } catch (err) {
    encounteredEpicOfflineFailure = true;
    completedAllLibraryPages = false;
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Error fetching Epic library items:', msg);
    const [, settledAch] = await Promise.all([
      playtimePromise.catch(() => {}),
      achievementsPromise.catch(() => ({})),
      macEpicAppIdsPromise.catch(() => new Set()),
    ]);
    if (settledAch && Object.keys(achievementsMap).length === 0) {
      achievementsMap = settledAch;
    }
    if (msg.includes('Epic library API unauthorized')) {
      attachStoreSyncCallMetadata(
        [],
        fetchEpicOwnedGames,
        { authoritativeComplete: false, achievementsMap, suppressedItems },
        options
      );
      throw err;
    }
  } finally {
    if (batchOfferCachePath) {
      await flushEpicOfferDiskCacheAsync(batchOfferCachePath).catch(() => {});
    }
  }

  const epicAuthoritative = Boolean(
    completedAllLibraryPages && !encounteredEpicOfflineFailure && !hadUnresolvedCatalogFailure
  );
  return attachStoreSyncCallMetadata(
    Array.from(gamesMap.values()),
    fetchEpicOwnedGames,
    { authoritativeComplete: epicAuthoritative, achievementsMap, suppressedItems },
    options
  );
}

function trimEpicCatalogAndOfferMemory() {
  /** @type {any} */ (fetchEpicOwnedGames).lastAchievementsMap = null;
  /** @type {any} */ (fetchEpicOwnedGames).lastSuppressedItems = null;
  /** @type {any} */ (fetchEpicOwnedGames).lastAuthoritativeComplete = null;

  // Flush any dirty debounced entries synchronously before evicting in-memory disk cache handles
  for (const [resolvedPath, slot] of epicOfferDiskCacheByPath.entries()) {
    if (slot.debounceTimer) {
      clearTimeout(slot.debounceTimer);
      slot.debounceTimer = null;
    }
    if (slot.dirtyGen > slot.flushedGen) {
      try {
        pruneEpicOfferCacheEntries(slot.entries, slot.lastNowMs || Date.now());
        atomicWriteFileSync(
          resolvedPath,
          JSON.stringify({ schemaVersion: 1, entries: slot.entries })
        );
        slot.flushedGen = slot.dirtyGen;
      } catch {}
    }
  }
  epicOfferDiskCacheByPath.clear();

  while (epicOfferMetadataCache.size > 100) {
    const oldestKey = epicOfferMetadataCache.keys().next().value;
    if (oldestKey === undefined) break;
    epicOfferMetadataCache.delete(oldestKey);
  }
}

module.exports = {
  epicOfferMetadataCache,
  getEpicOfferCachePath,
  flushEpicOfferDiskCacheAsync,
  extractEpicRequirementsByOs,
  fetchEpicProductOfferMetadata,
  fetchEpicOwnedGames,
  trimEpicCatalogAndOfferMemory,
};
