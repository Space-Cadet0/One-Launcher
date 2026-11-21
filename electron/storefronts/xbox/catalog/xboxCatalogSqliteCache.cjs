'use strict';

/**
 * Persistent Singleton SQLite V3 Compressed Delta Cache for Xbox DisplayCatalog & SIGL Snapshots.
 *
 * Features:
 * - `PRAGMA quick_check(1)` on open + Windows-NTFS-safe corruption quarantine (`db.close()` BEFORE `fs.renameSync`)
 * - Zero synchronous open-time compaction or truncating WAL checkpoints on main thread
 * - Batched `IN (...)` reads & transactional batched `DELETE`/`UPDATE` writes
 * - Cached prepared statements & throttled `pruneExpired`
 * - Bounded `zlib.inflateRawSync` decompression (`maxOutputLength: 16 MiB`)
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const {
  RELEVANT_IMAGE_PURPOSES,
  selectPreferredLocalizedEntry,
} = require('./xboxCatalogMediaAndSanitizer.cjs');

const DISPLAY_CATALOG_CACHE_TTL_MS = 7 * 24 * 3600_000; // 7 days (prevents post-rotation licensing staleness)
const LAYER3_REJECTED_TTL_MS = 24 * 3600_000; // 24 hours (prevents per-startup bypassCache re-fetch of ineligible SKUs)
const SIGL_FRESH_SKIP_NETWORK_MS = 5 * 60_000; // 5 minutes ultra-fast skip
const PRUNE_THROTTLE_MS = 60_000; // 1 minute throttle between automatic expired-row sweeps
const SQLITE_IN_BATCH_SIZE = 200;
const MAX_INFLATED_PRODUCT_BYTES = 16 * 1024 * 1024;

/**
 * Projects a raw ~42 KB DisplayCatalog Product payload down to the exact compact V3 schema
 * required for 5-Gate evaluation, Layer-3 desktop subscription licensing (`_compactDesktopLicensing`),
 * artwork/trailer/rating rendering, bundle BFS, and `.msixvc` package delivery resolution,
 * before `zlib.deflateRawSync` compression (~920 bytes/title).
 */
function projectCompactDisplayCatalogProduct(prod) {
  if (!prod || typeof prod !== 'object') return prod;
  if (prod._compactV3 === true) return prod;

  const projectLocalizedEntry = (loc) => {
    if (!loc || typeof loc !== 'object') return null;
    const rawImages = Array.isArray(loc.Images) ? loc.Images : [];
    const compactImages = [];
    let screenshotCount = 0;
    for (const img of rawImages) {
      if (!img || !img.Uri) continue;
      const purpose = String(img.ImagePurpose || '').trim();
      const lower = purpose.toLowerCase();
      if (!RELEVANT_IMAGE_PURPOSES.has(lower)) continue;
      if (lower === 'screenshot') {
        if (screenshotCount >= 12) continue;
        screenshotCount++;
      }
      compactImages.push({ ImagePurpose: purpose, Uri: img.Uri });
    }

    const projectVideos = (arr) => {
      if (!Array.isArray(arr) || arr.length === 0) return undefined;
      const kept = [];
      for (const v of arr) {
        if (!v || typeof v !== 'object') continue;
        const hls = v.HLS || v.Hls || undefined;
        const uri = v.URI || v.Uri || undefined;
        if (!hls && !uri) continue;
        const prevUri =
          v.PreviewImage?.Uri || v.PreviewImage?.URI || v.Image?.Uri || v.Image?.URI || undefined;
        kept.push({
          ...(v.VideoPurpose || v.Purpose
            ? { VideoPurpose: v.VideoPurpose || v.Purpose }
            : {}),
          ...(v.SortOrder !== undefined ? { SortOrder: v.SortOrder } : {}),
          ...(v.VideoPositionInfo ? { VideoPositionInfo: v.VideoPositionInfo } : {}),
          ...(v.Title ? { Title: v.Title } : {}),
          ...(hls ? { HLS: hls } : {}),
          ...(uri ? { URI: uri } : {}),
          ...(prevUri ? { PreviewImage: { Uri: prevUri } } : {}),
        });
        if (kept.length >= 6) break;
      }
      return kept.length > 0 ? kept : undefined;
    };

    const cmsVideos = projectVideos(loc.CMSVideos);
    const legacyVideos = projectVideos(loc.Videos);

    return {
      ...(loc.Language ? { Language: loc.Language } : {}),
      ...(loc.ProductTitle ? { ProductTitle: loc.ProductTitle } : {}),
      ...(loc.ShortDescription ? { ShortDescription: loc.ShortDescription } : {}),
      ...(loc.ProductDescription ? { ProductDescription: loc.ProductDescription } : {}),
      ...(loc.DeveloperName ? { DeveloperName: loc.DeveloperName } : {}),
      ...(loc.PublisherName ? { PublisherName: loc.PublisherName } : {}),
      ...(loc.ApproximateSizeInBytes
        ? { ApproximateSizeInBytes: loc.ApproximateSizeInBytes }
        : {}),
      ...(compactImages.length > 0 ? { Images: compactImages } : {}),
      ...(cmsVideos ? { CMSVideos: cmsVideos } : {}),
      ...(legacyVideos ? { Videos: legacyVideos } : {}),
    };
  };

  const rawLocList = Array.isArray(prod.LocalizedProperties) ? prod.LocalizedProperties : [];
  const compactLocalized = [];
  if (rawLocList.length > 0) {
    const mergedPreferred = selectPreferredLocalizedEntry(rawLocList);
    const projected = projectLocalizedEntry(mergedPreferred);
    if (projected) compactLocalized.push(projected);
  }

  const rawMarket = Array.isArray(prod.MarketProperties) ? prod.MarketProperties[0] : null;
  const compactMarket = rawMarket
    ? [
        {
          ...(rawMarket.OriginalReleaseDate
            ? { OriginalReleaseDate: rawMarket.OriginalReleaseDate }
            : {}),
          ...(Array.isArray(rawMarket.UsageData) && rawMarket.UsageData.length > 0
            ? {
                UsageData: rawMarket.UsageData.filter(
                  (u) => u && Number(u.RatingCount || 0) > 0
                ).map((u) => ({
                  AggregateTimeSpan: u.AggregateTimeSpan,
                  RatingCount: u.RatingCount,
                  AverageRating: u.AverageRating,
                })),
              }
            : {}),
        },
      ]
    : undefined;

  const rawProps = prod.Properties && typeof prod.Properties === 'object' ? prod.Properties : null;
  const compactProps = rawProps
    ? {
        ...(rawProps.IsDemoOrTrial !== undefined ? { IsDemoOrTrial: rawProps.IsDemoOrTrial } : {}),
        ...(rawProps.PackageFamilyName ? { PackageFamilyName: rawProps.PackageFamilyName } : {}),
        ...(rawProps.InAppOfferToken ? { InAppOfferToken: rawProps.InAppOfferToken } : {}),
        ...(rawProps.ServiceConfigId ? { ServiceConfigId: rawProps.ServiceConfigId } : {}),
        ...(rawProps.Scid ? { Scid: rawProps.Scid } : {}),
        ...(rawProps.MaxInstallSizeInBytes
          ? { MaxInstallSizeInBytes: rawProps.MaxInstallSizeInBytes }
          : {}),
        ...(rawProps.ApproximateSizeInBytes
          ? { ApproximateSizeInBytes: rawProps.ApproximateSizeInBytes }
          : {}),
        ...(rawProps.Category ? { Category: rawProps.Category } : {}),
        ...(Array.isArray(rawProps.Categories) ? { Categories: rawProps.Categories } : {}),
        ...(rawProps.XboxLiveGoldRequired !== undefined
          ? { XboxLiveGoldRequired: rawProps.XboxLiveGoldRequired }
          : {}),
        ...(Array.isArray(rawProps.Attributes) && rawProps.Attributes.length > 0
          ? {
              Attributes: rawProps.Attributes.map((a) =>
                typeof a === 'string' ? a : a?.Name ? { Name: a.Name } : null
              ).filter(Boolean),
            }
          : {}),
      }
    : undefined;

  const rawAltIds = Array.isArray(prod.AlternateIds) ? prod.AlternateIds : [];
  const compactAltIds = rawAltIds
    .filter((a) => a && a.IdType && a.Value)
    .map((a) => ({ IdType: a.IdType, Value: a.Value }));

  const rawSkuAvails = Array.isArray(prod.DisplaySkuAvailabilities)
    ? prod.DisplaySkuAvailabilities
    : [];
  const compactSkuAvails = [];
  let hasRawLicensingData = Boolean(prod._compactDesktopLicensing?.hasRawLicensingData);
  let hasDesktopLicenseAvailability = Boolean(
    prod._compactDesktopLicensing?.hasDesktopLicenseAvailability
  );
  let hasUnconditionalDesktopFulfill = Boolean(
    prod._compactDesktopLicensing?.hasUnconditionalDesktopFulfill
  );
  const passGrantsMap = new Map();
  if (Array.isArray(prod._compactDesktopLicensing?.passGrants)) {
    for (const pg of prod._compactDesktopLicensing.passGrants) {
      if (pg && pg.passId) {
        const key = `${pg.passId}|${pg.skuId || ''}|${pg.start || ''}|${pg.end || ''}`;
        passGrantsMap.set(key, pg);
      }
    }
  }

  for (const avail of rawSkuAvails) {
    const sku = avail?.Sku;
    if (!sku || typeof sku !== 'object') continue;
    const sp = sku.Properties || {};
    const isTrialSku = sp.IsTrial === true;
    const fd = sp.FulfillmentData;
    const compactFd =
      fd && typeof fd === 'object'
        ? {
            ...(fd.PackageFamilyName ? { PackageFamilyName: fd.PackageFamilyName } : {}),
            ...(fd.ContentId ? { ContentId: fd.ContentId } : {}),
            ...(fd.WuCategoryId ? { WuCategoryId: fd.WuCategoryId } : {}),
            ...(fd.ProductId ? { ProductId: fd.ProductId } : {}),
          }
        : undefined;

    const compactPackages = Array.isArray(sp.Packages)
      ? sp.Packages.map((pkg) => {
          if (!pkg || typeof pkg !== 'object') return null;
          return {
            ...(pkg.PackageFormat ? { PackageFormat: pkg.PackageFormat } : {}),
            ...(Array.isArray(pkg.PlatformDependencies)
              ? {
                  PlatformDependencies: pkg.PlatformDependencies.map((d) =>
                    typeof d === 'string'
                      ? d
                      : d?.PlatformName
                        ? { PlatformName: d.PlatformName }
                        : null
                  ).filter(Boolean),
                }
              : {}),
            ...(Array.isArray(pkg.Architectures) ? { Architectures: pkg.Architectures } : {}),
            ...(pkg.PackageFamilyName ? { PackageFamilyName: pkg.PackageFamilyName } : {}),
            ...(pkg.PackageFullName ? { PackageFullName: pkg.PackageFullName } : {}),
            ...(pkg.ContentId ? { ContentId: pkg.ContentId } : {}),
            ...(pkg.MaxDownloadSizeInBytes
              ? { MaxDownloadSizeInBytes: pkg.MaxDownloadSizeInBytes }
              : {}),
            ...(pkg.MaxInstallSizeInBytes
              ? { MaxInstallSizeInBytes: pkg.MaxInstallSizeInBytes }
              : {}),
            ...(pkg.FulfillmentData?.WuCategoryId
              ? { FulfillmentData: { WuCategoryId: pkg.FulfillmentData.WuCategoryId } }
              : {}),
          };
        }).filter(Boolean)
      : undefined;

    const compactBundled = Array.isArray(sp.BundledSkus)
      ? sp.BundledSkus.filter((b) => b && b.BigId).map((b) => ({
          BigId: b.BigId,
          ...(b.SkuId ? { SkuId: b.SkuId } : {}),
          ...(b.IsPrimary !== undefined ? { IsPrimary: b.IsPrimary } : {}),
        }))
      : undefined;

    const skuMkt = Array.isArray(sku.MarketProperties) ? sku.MarketProperties[0] : null;
    const compactSkuMkt =
      skuMkt && (skuMkt.OriginalReleaseDate || skuMkt.FirstAvailableDate)
        ? [
            {
              ...(skuMkt.OriginalReleaseDate
                ? { OriginalReleaseDate: skuMkt.OriginalReleaseDate }
                : {}),
              ...(skuMkt.FirstAvailableDate
                ? { FirstAvailableDate: skuMkt.FirstAvailableDate }
                : {}),
            },
          ]
        : undefined;

    let earliestStartDate = '';
    let compactPrice = null;
    const allowedPlatformNames = new Set();
    if (Array.isArray(avail.Availabilities)) {
      for (const av of avail.Availabilities) {
        const sd = av?.Conditions?.StartDate || av?.StartDate || '';
        const ed = av?.Conditions?.EndDate || av?.EndDate || '';
        if (typeof sd === 'string' && sd && (!earliestStartDate || sd < earliestStartDate)) {
          earliestStartDate = sd;
        }
        const rawPrice = av?.OrderManagementData?.Price;
        if (!compactPrice && rawPrice && typeof rawPrice === 'object') {
          if (
            rawPrice.ListPrice !== undefined ||
            rawPrice.MSRP !== undefined ||
            rawPrice.CurrencyCode
          ) {
            compactPrice = {
              ...(rawPrice.ListPrice !== undefined ? { ListPrice: rawPrice.ListPrice } : {}),
              ...(rawPrice.MSRP !== undefined ? { MSRP: rawPrice.MSRP } : {}),
              ...(rawPrice.CurrencyCode ? { CurrencyCode: rawPrice.CurrencyCode } : {}),
            };
          }
        }
        const allowed = av?.Conditions?.ClientConditions?.AllowedPlatforms;
        const avPlatformsLower = [];
        if (Array.isArray(allowed)) {
          for (const ap of allowed) {
            const pName = typeof ap === 'string' ? ap : ap?.PlatformName;
            if (pName) {
              allowedPlatformNames.add(String(pName));
              avPlatformsLower.push(String(pName).trim().toLowerCase());
            }
          }
        }

        if (!isTrialSku && av?.LicensingData && typeof av.LicensingData === 'object') {
          hasRawLicensingData = true;
          const actionsLower = Array.isArray(av.Actions)
            ? av.Actions.map((a) => String(a || '').trim().toLowerCase())
            : [];
          const hasLicenseOrFulfill =
            actionsLower.length === 0 ||
            actionsLower.includes('license') ||
            actionsLower.includes('fulfill');
          const isDesktopPlatformAvail =
            avPlatformsLower.length === 0 ||
            avPlatformsLower.some(
              (p) =>
                p === 'windows.desktop' ||
                p === 'windows.universal' ||
                p === 'windows.windows8x'
            );

          if (hasLicenseOrFulfill && isDesktopPlatformAvail) {
            hasDesktopLicenseAvailability = true;
            const satGroups = Array.isArray(av.LicensingData.SatisfyingEntitlementKeys)
              ? av.LicensingData.SatisfyingEntitlementKeys
              : [];
            const startStr = typeof sd === 'string' && sd.trim() ? sd.trim() : undefined;
            const endStr = typeof ed === 'string' && ed.trim() ? ed.trim() : undefined;

            if (satGroups.length === 0) {
              const endTs = endStr ? Date.parse(endStr) : NaN;
              if (!endStr || Number.isNaN(endTs) || endTs > Date.now()) {
                hasUnconditionalDesktopFulfill = true;
              }
            } else {
              for (const grp of satGroups) {
                const rawKeys = Array.isArray(grp?.EntitlementKeys)
                  ? grp.EntitlementKeys
                  : typeof grp === 'string'
                    ? [grp]
                    : grp?.EntitlementKey
                      ? [grp.EntitlementKey]
                      : [];
                for (const rk of rawKeys) {
                  const m = /^(?:big:)?(CFQ7TT[A-Z0-9]{6})(?::([A-Z0-9]{1,8}))?$/i.exec(
                    String(rk || '').trim()
                  );
                  if (m) {
                    const passId = m[1].toUpperCase();
                    const skuId = m[2] ? m[2].toUpperCase() : undefined;
                    const gKey = `${passId}|${skuId || ''}|${startStr || ''}|${endStr || ''}`;
                    if (!passGrantsMap.has(gKey)) {
                      passGrantsMap.set(gKey, {
                        passId,
                        ...(skuId ? { skuId } : {}),
                        ...(startStr ? { start: startStr } : {}),
                        ...(endStr ? { end: endStr } : {}),
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    const compactAvails =
      earliestStartDate || allowedPlatformNames.size > 0 || compactPrice
        ? [
            {
              ...(earliestStartDate || allowedPlatformNames.size > 0
                ? {
                    Conditions: {
                      ...(earliestStartDate ? { StartDate: earliestStartDate } : {}),
                      ...(allowedPlatformNames.size > 0
                        ? {
                            ClientConditions: {
                              AllowedPlatforms: Array.from(allowedPlatformNames).map(
                                (PlatformName) => ({
                                  PlatformName,
                                })
                              ),
                            },
                          }
                        : {}),
                    },
                  }
                : {}),
              ...(compactPrice ? { OrderManagementData: { Price: compactPrice } } : {}),
            },
          ]
        : undefined;

    compactSkuAvails.push({
      Sku: {
        ...(sku.SkuId ? { SkuId: sku.SkuId } : {}),
        ...(compactSkuMkt ? { MarketProperties: compactSkuMkt } : {}),
        Properties: {
          ...(sp.IsTrial !== undefined ? { IsTrial: sp.IsTrial } : {}),
          ...(sp.InAppOfferToken ? { InAppOfferToken: sp.InAppOfferToken } : {}),
          ...(sp.FulfillmentType ? { FulfillmentType: sp.FulfillmentType } : {}),
          ...(sp.MaxInstallSizeInBytes ? { MaxInstallSizeInBytes: sp.MaxInstallSizeInBytes } : {}),
          ...(sp.ApproximateSizeInBytes
            ? { ApproximateSizeInBytes: sp.ApproximateSizeInBytes }
            : {}),
          ...(compactFd && Object.keys(compactFd).length > 0 ? { FulfillmentData: compactFd } : {}),
          ...(compactBundled && compactBundled.length > 0 ? { BundledSkus: compactBundled } : {}),
          ...(compactPackages && compactPackages.length > 0 ? { Packages: compactPackages } : {}),
        },
      },
      ...(compactAvails ? { Availabilities: compactAvails } : {}),
    });
  }

  return {
    _compactV3: true,
    _compactDesktopLicensing: {
      hasRawLicensingData,
      hasDesktopLicenseAvailability,
      hasUnconditionalDesktopFulfill,
      passGrants: Array.from(passGrantsMap.values()),
    },
    ProductId: prod.ProductId,
    ...(prod.ProductTitle ? { ProductTitle: prod.ProductTitle } : {}),
    ...(prod.ProductKind ? { ProductKind: prod.ProductKind } : {}),
    ...(prod.ProductType ? { ProductType: prod.ProductType } : {}),
    ...(compactLocalized.length > 0 ? { LocalizedProperties: compactLocalized } : {}),
    ...(compactMarket ? { MarketProperties: compactMarket } : {}),
    ...(compactProps ? { Properties: compactProps } : {}),
    ...(compactAltIds.length > 0 ? { AlternateIds: compactAltIds } : {}),
    ...(compactSkuAvails.length > 0 ? { DisplaySkuAvailabilities: compactSkuAvails } : {}),
    ...(prod._crossPlatformLauncherRuntime ? { _crossPlatformLauncherRuntime: true } : {}),
  };
}

function serializeCatalogProductPayload(prod) {
  const compact = projectCompactDisplayCatalogProduct(prod);
  const jsonBytes = Buffer.from(JSON.stringify(compact), 'utf8');
  return zlib.deflateRawSync(jsonBytes, { level: zlib.constants.Z_DEFAULT_COMPRESSION });
}

function deserializeCatalogProductPayload(rawPayload) {
  if (!rawPayload) return null;
  if (rawPayload instanceof Uint8Array || Buffer.isBuffer(rawPayload)) {
    const buf = Buffer.from(rawPayload);
    try {
      return JSON.parse(
        zlib.inflateRawSync(buf, { maxOutputLength: MAX_INFLATED_PRODUCT_BYTES }).toString('utf8')
      );
    } catch {
      return JSON.parse(buf.toString('utf8'));
    }
  }
  if (typeof rawPayload === 'string') {
    if (rawPayload.startsWith('z1:')) {
      const inflated = zlib.inflateRawSync(Buffer.from(rawPayload.slice(3), 'base64'), {
        maxOutputLength: MAX_INFLATED_PRODUCT_BYTES,
      });
      return JSON.parse(inflated.toString('utf8'));
    }
    return JSON.parse(rawPayload);
  }
  return null;
}

function getSqliteDatabaseSync() {
  try {
    const mod = require('node:sqlite');
    return mod && typeof mod.DatabaseSync === 'function' ? mod.DatabaseSync : null;
  } catch {
    return null;
  }
}

function resolveDefaultUserDataDir(customDir) {
  if (customDir && typeof customDir === 'string' && customDir.trim()) {
    return customDir.trim();
  }
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    return path.join(os.tmpdir(), `one-launcher-test-home-${process.pid}`, '.one-launcher');
  }
  try {
    const reqElectron = require('electron');
    if (reqElectron?.app?.getPath) {
      return reqElectron.app.getPath('userData');
    }
  } catch {}
  return path.join(os.homedir(), '.one-launcher');
}

function isSqliteCorruptionError(err) {
  if (!err) return false;
  const code = String(err.errcode || err.code || '').toUpperCase();
  const msg = String(err.message || err).toLowerCase();
  return (
    code.includes('SQLITE_CORRUPT') ||
    code.includes('SQLITE_NOTADB') ||
    msg.includes('database disk image is malformed') ||
    msg.includes('file is not a database') ||
    msg.includes('malformed') ||
    msg.includes('corrupt')
  );
}

/**
 * Quarantines a corrupt SQLite database file and removes its WAL/SHM sidecars.
 * CALLER MUST `db.close()` BEFORE calling this helper (Windows NTFS `EBUSY` invariant!).
 *
 * @param {string} dbPath
 */
function quarantineCorruptSqliteFilesSync(dbPath) {
  const stamp = `${Date.now()}.${process.pid}`;
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${dbPath}${suffix}`;
    try {
      if (!fs.existsSync(src)) continue;
      if (suffix === '') {
        const quarantined = `${dbPath}.corrupt.${stamp}`;
        try {
          fs.renameSync(src, quarantined);
        } catch {
          try {
            fs.unlinkSync(src);
          } catch {}
        }
      } else {
        try {
          fs.unlinkSync(src);
        } catch {}
      }
    } catch {}
  }
}

const sqliteCacheStoreByDbPath = new Map();
let exitCleanupRegistered = false;

function registerCacheProcessExitCleanup() {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once('exit', () => {
    for (const entry of sqliteCacheStoreByDbPath.values()) {
      try {
        entry.db.close();
      } catch {}
    }
    sqliteCacheStoreByDbPath.clear();
  });
}

function closeXboxCatalogCacheStore(userDataDirOrOptions) {
  if (!userDataDirOrOptions) {
    for (const entry of sqliteCacheStoreByDbPath.values()) {
      try {
        entry.db.close();
      } catch {}
    }
    sqliteCacheStoreByDbPath.clear();
    return;
  }
  let targetDbPath = '';
  if (typeof userDataDirOrOptions === 'object' && userDataDirOrOptions.dbPath) {
    targetDbPath = path.resolve(userDataDirOrOptions.dbPath);
  } else if (
    typeof userDataDirOrOptions === 'string' &&
    /\.(?:sqlite|db)$/i.test(userDataDirOrOptions.trim())
  ) {
    targetDbPath = path.resolve(userDataDirOrOptions.trim());
  } else {
    const baseDir = resolveDefaultUserDataDir(
      typeof userDataDirOrOptions === 'object'
        ? userDataDirOrOptions.userDataDir
        : userDataDirOrOptions
    );
    targetDbPath = path.resolve(path.join(baseDir, 'xbox_catalog_cache_v1.sqlite'));
  }
  const existing = sqliteCacheStoreByDbPath.get(targetDbPath);
  if (existing) {
    try {
      existing.db.close();
    } catch {}
    sqliteCacheStoreByDbPath.delete(targetDbPath);
  }
}

function parseDesktopPassGrantBoundMs(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Detects whether a cached compact DisplayCatalog product has `_compactDesktopLicensing`
 * whose `passGrants[]` window rolled over (`end <= nowMs`) with zero remaining active grants,
 * so `hydrateDisplayCatalogProducts` treats it as a cache miss and re-fetches live.
 */
function hasStaleCachedDesktopPassGrants(product, nowMs = Date.now()) {
  const lic = product && typeof product === 'object' ? product._compactDesktopLicensing : null;
  if (!lic || lic.hasRawLicensingData !== true) return false;
  if (lic.hasUnconditionalDesktopFulfill === true) return false;
  const passGrants = lic.passGrants;
  if (!Array.isArray(passGrants) || passGrants.length === 0) return false;
  const evalNowMs =
    typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();

  let hasExpiredGrant = false;
  let hasActiveGrant = false;
  for (const g of passGrants) {
    if (!g || typeof g !== 'object') continue;
    const startMs = parseDesktopPassGrantBoundMs(g.start);
    const endMs = parseDesktopPassGrantBoundMs(g.end);
    if (endMs !== null && endMs <= evalNowMs) {
      hasExpiredGrant = true;
    }
    const startedOk = startMs === null || startMs <= evalNowMs;
    const notEndedOk = endMs === null || endMs > evalNowMs;
    if (startedOk && notEndedOk) {
      hasActiveGrant = true;
      break;
    }
  }
  return Boolean(hasExpiredGrant && !hasActiveGrant);
}

function initCatalogSqliteSchemaAndVerify(DatabaseSync, dbPath) {
  const openAndCheck = () => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout = 5000;');
      const quickCheckRows = db.prepare('PRAGMA quick_check(1)').all();
      const firstResult = String(quickCheckRows?.[0]?.quick_check || '').trim().toLowerCase();
      if (!Array.isArray(quickCheckRows) || quickCheckRows.length !== 1 || firstResult !== 'ok') {
        throw new Error(`SQLITE_CORRUPT: PRAGMA quick_check failed (${firstResult || 'empty'})`);
      }

      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS sigl_snapshots (
          cache_key TEXT PRIMARY KEY,
          etag TEXT,
          sha256 TEXT,
          ids_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS display_catalog_products (
          cache_key TEXT PRIMARY KEY,
          big_id TEXT NOT NULL,
          market TEXT NOT NULL,
          product_json BLOB NOT NULL,
          updated_at INTEGER NOT NULL,
          layer3_rejected_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS sync_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      // Guarded schema migration for existing v1 SQLite caches lacking `layer3_rejected_at`
      try {
        const productCols = db.prepare('PRAGMA table_info(display_catalog_products)').all();
        const hasLayer3RejectedCol =
          Array.isArray(productCols) &&
          productCols.some((col) => col && col.name === 'layer3_rejected_at');
        if (!hasLayer3RejectedCol) {
          db.exec(
            'ALTER TABLE display_catalog_products ADD COLUMN layer3_rejected_at INTEGER NOT NULL DEFAULT 0'
          );
        }
      } catch {}

      return db;
    } catch (err) {
      // CRITICAL (Windows NTFS): always close DB handle BEFORE renaming/quarantining files!
      try {
        db.close();
      } catch {}
      throw err;
    }
  };

  try {
    return openAndCheck();
  } catch (firstErr) {
    if (isSqliteCorruptionError(firstErr)) {
      quarantineCorruptSqliteFilesSync(dbPath);
      return openAndCheck();
    }
    throw firstErr;
  }
}

function openXboxCatalogCacheStore(userDataDirOrOptions) {
  let explicitDbPath = '';
  let customUserDataDir = userDataDirOrOptions;
  if (userDataDirOrOptions && typeof userDataDirOrOptions === 'object') {
    explicitDbPath = userDataDirOrOptions.dbPath ? String(userDataDirOrOptions.dbPath).trim() : '';
    customUserDataDir = userDataDirOrOptions.userDataDir;
  } else if (
    typeof userDataDirOrOptions === 'string' &&
    /\.(?:sqlite|db)$/i.test(userDataDirOrOptions.trim())
  ) {
    explicitDbPath = userDataDirOrOptions.trim();
    customUserDataDir = path.dirname(explicitDbPath);
  }

  const baseDir = explicitDbPath
    ? path.dirname(path.resolve(explicitDbPath))
    : resolveDefaultUserDataDir(customUserDataDir);
  try {
    fs.mkdirSync(baseDir, { recursive: true });
  } catch {}

  const DatabaseSync = getSqliteDatabaseSync();
  if (DatabaseSync) {
    const dbPath = path.resolve(
      explicitDbPath || path.join(baseDir, 'xbox_catalog_cache_v1.sqlite')
    );

    const existingSingleton = sqliteCacheStoreByDbPath.get(dbPath);
    if (existingSingleton) {
      if (fs.existsSync(dbPath)) {
        return existingSingleton.handle;
      }
      try {
        existingSingleton.db.close();
      } catch {}
      sqliteCacheStoreByDbPath.delete(dbPath);
    }

    let db = null;
    try {
      registerCacheProcessExitCleanup();
      db = initCatalogSqliteSchemaAndVerify(DatabaseSync, dbPath);

      const getSiglStmt = db.prepare(
        'SELECT etag, sha256, ids_json, fetched_at FROM sigl_snapshots WHERE cache_key = ?'
      );
      const setSiglStmt = db.prepare(
        `INSERT INTO sigl_snapshots (cache_key, etag, sha256, ids_json, fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           etag = excluded.etag,
           sha256 = excluded.sha256,
           ids_json = excluded.ids_json,
           fetched_at = excluded.fetched_at`
      );
      const upsertProductStmt = db.prepare(
        `INSERT INTO display_catalog_products (cache_key, big_id, market, product_json, updated_at, layer3_rejected_at)
         VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(cache_key) DO UPDATE SET
           product_json = excluded.product_json,
           updated_at = excluded.updated_at,
           layer3_rejected_at = 0`
      );
      const pruneExpiredStmt = db.prepare(
        'DELETE FROM display_catalog_products WHERE updated_at < ?'
      );
      const getMetaStmt = db.prepare('SELECT value FROM sync_metadata WHERE key = ?');
      const setMetaStmt = db.prepare(
        `INSERT INTO sync_metadata (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`
      );

      let lastPruneWallMs = 0;
      let lastPruneCutoffMs = 0;

      // Lightweight open-time expiry prune (throttled via sync_metadata, NEVER running blocking VACUUM!)
      try {
        const nowOpen = Date.now();
        const prevPruneRow = getMetaStmt.get('last_expired_prune_at');
        const prevPruneAt = Number(prevPruneRow?.value || 0);
        if (!Number.isFinite(prevPruneAt) || nowOpen - prevPruneAt >= 6 * 3600_000) {
          const cutoff = nowOpen - DISPLAY_CATALOG_CACHE_TTL_MS;
          const delInfo = pruneExpiredStmt.run(cutoff);
          setMetaStmt.run('last_expired_prune_at', String(nowOpen), nowOpen);
          lastPruneWallMs = nowOpen;
          lastPruneCutoffMs = cutoff;
          if (Number(delInfo?.changes || 0) > 100) {
            db.exec('PRAGMA wal_checkpoint(PASSIVE);');
          }
        }
      } catch {}

      const handleRuntimeCorruption = (err) => {
        if (!isSqliteCorruptionError(err)) return false;
        const entry = sqliteCacheStoreByDbPath.get(dbPath);
        if (entry) {
          sqliteCacheStoreByDbPath.delete(dbPath);
        }
        try {
          db.close();
        } catch {}
        quarantineCorruptSqliteFilesSync(dbPath);
        return true;
      };

      const batchDeleteKeysInTx = (keys) => {
        if (!Array.isArray(keys) || keys.length === 0) return;
        db.exec('BEGIN IMMEDIATE');
        try {
          for (let i = 0; i < keys.length; i += SQLITE_IN_BATCH_SIZE) {
            const chunk = keys.slice(i, i + SQLITE_IN_BATCH_SIZE);
            const placeholders = chunk.map(() => '?').join(',');
            db.prepare(
              `DELETE FROM display_catalog_products WHERE cache_key IN (${placeholders})`
            ).run(...chunk);
          }
          db.exec('COMMIT');
        } catch {
          try {
            db.exec('ROLLBACK');
          } catch {}
        }
      };

      const batchUpdateLayer3RejectedInTx = (keys, ts) => {
        if (!Array.isArray(keys) || keys.length === 0) return;
        db.exec('BEGIN IMMEDIATE');
        try {
          for (let i = 0; i < keys.length; i += SQLITE_IN_BATCH_SIZE) {
            const chunk = keys.slice(i, i + SQLITE_IN_BATCH_SIZE);
            const placeholders = chunk.map(() => '?').join(',');
            db.prepare(
              `UPDATE display_catalog_products SET layer3_rejected_at = ? WHERE cache_key IN (${placeholders})`
            ).run(ts, ...chunk);
          }
          db.exec('COMMIT');
        } catch {
          try {
            db.exec('ROLLBACK');
          } catch {}
        }
      };

      const handle = {
        dbPath,
        getMeta(key) {
          try {
            const row = getMetaStmt.get(String(key || ''));
            return row ? String(row.value || '') : '';
          } catch (err) {
            handleRuntimeCorruption(err);
            return '';
          }
        },
        setMeta(key, value) {
          try {
            setMetaStmt.run(String(key || ''), String(value ?? ''), Date.now());
          } catch (err) {
            if (!handleRuntimeCorruption(err)) throw err;
          }
        },
        getSigl(cacheKey) {
          try {
            const row = getSiglStmt.get(cacheKey);
            if (!row) return null;
            const parsedPayload = JSON.parse(String(row.ids_json || '[]'));
            const ids = Array.isArray(parsedPayload)
              ? parsedPayload
              : Array.isArray(parsedPayload?.ids)
                ? parsedPayload.ids
                : [];
            const maxAgeMs =
              !Array.isArray(parsedPayload) && Number(parsedPayload?.maxAgeMs) > 0
                ? Number(parsedPayload.maxAgeMs)
                : 0;
            return {
              etag: String(row.etag || ''),
              sha256: String(row.sha256 || ''),
              ids,
              ...(maxAgeMs > 0 ? { maxAgeMs } : {}),
              fetchedAt: Number(row.fetched_at || 0),
            };
          } catch (err) {
            handleRuntimeCorruption(err);
            return null;
          }
        },
        setSigl(cacheKey, { etag = '', sha256 = '', ids = [], maxAgeMs = 0, fetchedAt = Date.now() }) {
          try {
            const serializedIds =
              Number(maxAgeMs) > 0
                ? JSON.stringify({ ids, maxAgeMs: Number(maxAgeMs) })
                : JSON.stringify(ids);
            setSiglStmt.run(cacheKey, etag, sha256, serializedIds, fetchedAt);
          } catch (err) {
            if (!handleRuntimeCorruption(err)) throw err;
          }
        },
        getProducts(bigIds, market = 'US', nowMsOrOptions) {
          const out = new Map();
          if (!Array.isArray(bigIds) || bigIds.length === 0) return out;
          const mkt = String(market || 'US').toUpperCase();
          const now = Date.now();
          const evalNowMs =
            typeof nowMsOrOptions === 'number' && Number.isFinite(nowMsOrOptions)
              ? nowMsOrOptions
              : typeof nowMsOrOptions?.nowMs === 'number' && Number.isFinite(nowMsOrOptions.nowMs)
                ? nowMsOrOptions.nowMs
                : now;

          /** @type {string[]} */
          const uniqueKeys = [];
          const seenKeys = new Set();
          for (const rawId of bigIds) {
            const id = String(rawId || '').trim().toUpperCase();
            if (!id) continue;
            const key = `${mkt}:${id}`;
            if (!seenKeys.has(key)) {
              seenKeys.add(key);
              uniqueKeys.push(key);
            }
          }
          if (uniqueKeys.length === 0) return out;

          /** @type {string[]} */
          const expiredOrStaleKeys = [];
          try {
            for (let i = 0; i < uniqueKeys.length; i += SQLITE_IN_BATCH_SIZE) {
              const chunk = uniqueKeys.slice(i, i + SQLITE_IN_BATCH_SIZE);
              const placeholders = chunk.map(() => '?').join(',');
              const rows = db
                .prepare(
                  `SELECT cache_key, big_id, product_json, updated_at FROM display_catalog_products WHERE cache_key IN (${placeholders})`
                )
                .all(...chunk);

              for (const row of rows) {
                if (!row) continue;
                const key = String(row.cache_key || '');
                const id = String(row.big_id || '').trim().toUpperCase();
                if (!id) continue;
                if (now - Number(row.updated_at || 0) > DISPLAY_CATALOG_CACHE_TTL_MS) {
                  expiredOrStaleKeys.push(key);
                  continue;
                }
                try {
                  const decoded = deserializeCatalogProductPayload(row.product_json);
                  if (decoded && decoded._compactV3 === true) {
                    if (hasStaleCachedDesktopPassGrants(decoded, evalNowMs)) {
                      expiredOrStaleKeys.push(key);
                      continue;
                    }
                    out.set(id, decoded);
                  } else {
                    // Evict pre-_compactV3 row so DisplayCatalog re-hydrates SatisfyingEntitlementKeys
                    expiredOrStaleKeys.push(key);
                  }
                } catch {
                  expiredOrStaleKeys.push(key);
                }
              }
            }

            if (expiredOrStaleKeys.length > 0) {
              batchDeleteKeysInTx(expiredOrStaleKeys);
            }
          } catch (err) {
            handleRuntimeCorruption(err);
          }
          return out;
        },
        setProducts(productsMap, market = 'US') {
          if (!productsMap || productsMap.size === 0) return;
          const mkt = String(market || 'US').toUpperCase();
          const now = Date.now();
          try {
            db.exec('BEGIN IMMEDIATE');
            try {
              for (const [id, prod] of productsMap.entries()) {
                const upper = String(id || '').trim().toUpperCase();
                if (!upper || !prod) continue;
                const compressedBlob = serializeCatalogProductPayload(prod);
                upsertProductStmt.run(`${mkt}:${upper}`, upper, mkt, compressedBlob, now);
              }
              db.exec('COMMIT');
            } catch (txErr) {
              try {
                db.exec('ROLLBACK');
              } catch {}
              throw txErr;
            }
          } catch (err) {
            if (!handleRuntimeCorruption(err)) {
              throw err;
            }
          }
        },
        getLayer3RejectedMap(bigIds, market = 'US') {
          const out = new Map();
          if (!Array.isArray(bigIds) || bigIds.length === 0) return out;
          const mkt = String(market || 'US').toUpperCase();
          /** @type {string[]} */
          const uniqueKeys = [];
          const seenKeys = new Set();
          for (const rawId of bigIds) {
            const id = String(rawId || '').trim().toUpperCase();
            if (!id) continue;
            const key = `${mkt}:${id}`;
            if (!seenKeys.has(key)) {
              seenKeys.add(key);
              uniqueKeys.push(key);
            }
          }
          if (uniqueKeys.length === 0) return out;

          try {
            for (let i = 0; i < uniqueKeys.length; i += SQLITE_IN_BATCH_SIZE) {
              const chunk = uniqueKeys.slice(i, i + SQLITE_IN_BATCH_SIZE);
              const placeholders = chunk.map(() => '?').join(',');
              const rows = db
                .prepare(
                  `SELECT big_id, layer3_rejected_at FROM display_catalog_products WHERE cache_key IN (${placeholders}) AND layer3_rejected_at > 0`
                )
                .all(...chunk);
              for (const row of rows) {
                const id = String(row?.big_id || '').trim().toUpperCase();
                const ts = Number(row?.layer3_rejected_at || 0);
                if (id && Number.isFinite(ts) && ts > 0) {
                  out.set(id, ts);
                }
              }
            }
          } catch (err) {
            handleRuntimeCorruption(err);
          }
          return out;
        },
        markLayer3Rejected(bigIds, market = 'US', rejectedAtMs = Date.now()) {
          if (!Array.isArray(bigIds) || bigIds.length === 0) return;
          const mkt = String(market || 'US').toUpperCase();
          const ts =
            Number.isFinite(rejectedAtMs) && rejectedAtMs > 0 ? Math.floor(rejectedAtMs) : Date.now();
          const keys = Array.from(
            new Set(
              bigIds
                .map((rawId) => String(rawId || '').trim().toUpperCase())
                .filter(Boolean)
                .map((id) => `${mkt}:${id}`)
            )
          );
          try {
            batchUpdateLayer3RejectedInTx(keys, ts);
          } catch (err) {
            handleRuntimeCorruption(err);
          }
        },
        clearLayer3Rejected(bigIds, market = 'US') {
          if (!Array.isArray(bigIds) || bigIds.length === 0) return;
          const mkt = String(market || 'US').toUpperCase();
          const keys = Array.from(
            new Set(
              bigIds
                .map((rawId) => String(rawId || '').trim().toUpperCase())
                .filter(Boolean)
                .map((id) => `${mkt}:${id}`)
            )
          );
          try {
            batchUpdateLayer3RejectedInTx(keys, 0);
          } catch (err) {
            handleRuntimeCorruption(err);
          }
        },
        pruneExpired(nowMs = Date.now(), pruneOpts = {}) {
          const wallNow = Date.now();
          const effectiveNow =
            typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : wallNow;
          const cutoff = effectiveNow - DISPLAY_CATALOG_CACHE_TTL_MS;
          const force = Boolean(pruneOpts && pruneOpts.force === true);
          if (
            !force &&
            lastPruneWallMs > 0 &&
            wallNow - lastPruneWallMs < PRUNE_THROTTLE_MS &&
            cutoff <= lastPruneCutoffMs + 1000
          ) {
            return 0;
          }
          try {
            const info = pruneExpiredStmt.run(cutoff);
            lastPruneWallMs = wallNow;
            lastPruneCutoffMs = cutoff;
            return Number(info?.changes || 0);
          } catch (err) {
            handleRuntimeCorruption(err);
            return 0;
          }
        },
        // Intentional no-op on per-call wrapper so singleton DatabaseSync remains open across concurrent syncs
        close() {},
        destroy() {
          closeXboxCatalogCacheStore({ dbPath });
        },
      };

      sqliteCacheStoreByDbPath.set(dbPath, { db, handle });
      return handle;
    } catch {
      if (db) {
        try {
          db.close();
        } catch {}
      }
      // Fall through to JSON store if SQLite cannot open
    }
  }

  // Fallback JSON cache store (compact projected + TTL-pruned)
  const jsonPath = path.join(baseDir, 'xbox_catalog_cache_v1.json');
  let state = { sigls: {}, products: {} };
  try {
    if (fs.existsSync(jsonPath)) {
      state = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) || state;
    }
  } catch {}

  const flushJson = () => {
    try {
      const now = Date.now();
      if (state.products) {
        for (const [k, v] of Object.entries(state.products)) {
          if (!v || now - Number(v.updatedAt || 0) > DISPLAY_CATALOG_CACHE_TTL_MS) {
            delete state.products[k];
          }
        }
      }
      const tmp = `${jsonPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, jsonPath);
    } catch {}
  };

  return {
    getMeta(key) {
      return state.meta?.[String(key || '')] || '';
    },
    setMeta(key, value) {
      state.meta = state.meta || {};
      state.meta[String(key || '')] = String(value ?? '');
      flushJson();
    },
    getSigl(cacheKey) {
      return state.sigls?.[cacheKey] || null;
    },
    setSigl(cacheKey, entry) {
      state.sigls = state.sigls || {};
      state.sigls[cacheKey] = entry;
      flushJson();
    },
    getProducts(bigIds, market = 'US', nowMsOrOptions) {
      const out = new Map();
      const mkt = String(market || 'US').toUpperCase();
      const now = Date.now();
      const evalNowMs =
        typeof nowMsOrOptions === 'number' && Number.isFinite(nowMsOrOptions)
          ? nowMsOrOptions
          : typeof nowMsOrOptions?.nowMs === 'number' && Number.isFinite(nowMsOrOptions.nowMs)
            ? nowMsOrOptions.nowMs
            : now;
      for (const rawId of bigIds || []) {
        const id = String(rawId || '').trim().toUpperCase();
        const key = `${mkt}:${id}`;
        const entry = state.products?.[key];
        if (
          entry &&
          entry.product?._compactV3 === true &&
          now - Number(entry.updatedAt || 0) <= DISPLAY_CATALOG_CACHE_TTL_MS
        ) {
          if (hasStaleCachedDesktopPassGrants(entry.product, evalNowMs)) {
            if (state.products) {
              delete state.products[key];
            }
            continue;
          }
          out.set(id, entry.product);
        }
      }
      return out;
    },
    setProducts(productsMap, market = 'US') {
      const mkt = String(market || 'US').toUpperCase();
      state.products = state.products || {};
      const now = Date.now();
      for (const [id, product] of productsMap.entries()) {
        state.products[`${mkt}:${String(id).toUpperCase()}`] = {
          product: projectCompactDisplayCatalogProduct(product),
          updatedAt: now,
          layer3RejectedAt: 0,
        };
      }
      flushJson();
    },
    getLayer3RejectedMap(bigIds, market = 'US') {
      const out = new Map();
      const mkt = String(market || 'US').toUpperCase();
      for (const rawId of bigIds || []) {
        const id = String(rawId || '').trim().toUpperCase();
        const entry = state.products?.[`${mkt}:${id}`];
        const ts = Number(entry?.layer3RejectedAt || 0);
        if (Number.isFinite(ts) && ts > 0) {
          out.set(id, ts);
        }
      }
      return out;
    },
    markLayer3Rejected(bigIds, market = 'US', rejectedAtMs = Date.now()) {
      if (!Array.isArray(bigIds) || bigIds.length === 0) return;
      const mkt = String(market || 'US').toUpperCase();
      const ts =
        Number.isFinite(rejectedAtMs) && rejectedAtMs > 0 ? Math.floor(rejectedAtMs) : Date.now();
      let dirty = false;
      for (const rawId of bigIds) {
        const id = String(rawId || '').trim().toUpperCase();
        const entry = state.products?.[`${mkt}:${id}`];
        if (entry) {
          entry.layer3RejectedAt = ts;
          dirty = true;
        }
      }
      if (dirty) flushJson();
    },
    clearLayer3Rejected(bigIds, market = 'US') {
      if (!Array.isArray(bigIds) || bigIds.length === 0) return;
      const mkt = String(market || 'US').toUpperCase();
      let dirty = false;
      for (const rawId of bigIds) {
        const id = String(rawId || '').trim().toUpperCase();
        const entry = state.products?.[`${mkt}:${id}`];
        if (entry && entry.layer3RejectedAt) {
          entry.layer3RejectedAt = 0;
          dirty = true;
        }
      }
      if (dirty) flushJson();
    },
    pruneExpired() {
      flushJson();
      return 0;
    },
    close() {},
    destroy() {},
  };
}

module.exports = {
  DISPLAY_CATALOG_CACHE_TTL_MS,
  LAYER3_REJECTED_TTL_MS,
  SIGL_FRESH_SKIP_NETWORK_MS,
  projectCompactDisplayCatalogProduct,
  serializeCatalogProductPayload,
  deserializeCatalogProductPayload,
  parseDesktopPassGrantBoundMs,
  hasStaleCachedDesktopPassGrants,
  openXboxCatalogCacheStore,
  closeXboxCatalogCacheStore,
  isSqliteCorruptionError,
  quarantineCorruptSqliteFilesSync,
};
