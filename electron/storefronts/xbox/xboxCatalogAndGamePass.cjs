'use strict';

/**
 * Xbox PC / Mac Owned Entitlements, 2025/2026 Game Pass Tiers, SIGL v2 Delta Cache,
 * Recursive `BundledSkus` BFS, 5-Gate Structural Filter, Strict Active-Access Gate,
 * and `.msixvc` Package Delivery Resolver (`xboxCatalogAndGamePass.cjs`).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { classifyNonGameStorefrontItem } = require('../nonGameClassifier.cjs');
const { normalizeStoreMsaTicket, XSTS_RELYING_PARTIES } = require('./xboxAuthManager.cjs');

let xboxConfigAndIds = null;
try {
  xboxConfigAndIds = require('./xboxConfigAndIds.cjs');
} catch {
  // Optional Wave 1B sibling module
}

const PCGAFD_ENTITLEMENTS_URL = 'https://beige.xboxservices.com/PCGAFD/entitlements';
const PCGAFD_SUBSCRIPTIONS_URL = 'https://beige.xboxservices.com/PCGAFD/entitlements/subscriptions';
const COLLECTIONS_QUERY_V6_URL = 'https://collections.mp.microsoft.com/v6.0/collections/query';
const DISPLAY_CATALOG_PRODUCTS_URL = 'https://displaycatalog.mp.microsoft.com/v7.0/products';
const DISPLAY_CATALOG_AUTOSUGGEST_URL =
  'https://displaycatalog.mp.microsoft.com/v7.0/productFamilies/autosuggest';
const GAMEPASS_SIGL_V2_URL = 'https://catalog.gamepass.com/sigls/v2';
const PACKAGES_PC_BASE_URL = 'https://packagespc.xboxlive.com/GetBasePackage';
const FE3_DELIVERY_SOAP_URL = 'https://fe3cr.delivery.mp.microsoft.com/ClientWebService/client.asmx';

const XBOX_HTTP_TIMEOUT_MS = 20_000;
const CROSS_PLATFORM_ENTITLEMENT_CACHE_TTL_MS = 30 * 60_000; // 30 minutes
const CATALOG_DB_COMPACTION_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MB

function buildXboxFetchSignal(callerSignal, timeoutMs = XBOX_HTTP_TIMEOUT_MS) {
  const timeoutSignal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  if (callerSignal && timeoutSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([callerSignal, timeoutSignal]);
  }
  return callerSignal || timeoutSignal;
}

function resolveFetchImpl(options = {}) {
  return options.customFetch || options.fetchImpl || globalThis.fetch;
}

function resolveDefaultXboxLocaleAndMarket(options = {}) {
  let detectedLocale = '';
  let detectedMarket = '';
  try {
    const reqElectron = require('electron');
    const app = reqElectron?.app;
    if (app) {
      if (typeof app.getLocale === 'function') {
        detectedLocale = String(app.getLocale() || '').trim();
      }
      if (typeof app.getLocaleCountryCode === 'function') {
        detectedMarket = String(app.getLocaleCountryCode() || '').trim().toUpperCase();
      }
    }
  } catch {}

  if (detectedLocale && !detectedLocale.includes('-')) {
    const country = /^[A-Z]{2}$/.test(detectedMarket) ? detectedMarket : 'US';
    detectedLocale = `${detectedLocale.toLowerCase()}-${country}`;
  }
  if (!detectedMarket && detectedLocale.includes('-')) {
    const parts = detectedLocale.split('-');
    const region = parts[parts.length - 1].toUpperCase();
    if (/^[A-Z]{2}$/.test(region)) {
      detectedMarket = region;
    }
  }

  const locale =
    (typeof options.locale === 'string' && options.locale.trim()) ||
    detectedLocale ||
    'en-US';
  const market =
    (typeof options.market === 'string' && options.market.trim().toUpperCase()) ||
    (/^[A-Z]{2}$/.test(detectedMarket) ? detectedMarket : '') ||
    'US';

  return { locale, market };
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Empirically verified SIGL v2 Collection GUIDs
const GAMEPASS_SIGL_IDS = Object.freeze({
  ALL_PC: 'fdd9e2a7-0fee-49f6-ad69-4354098401ff',
  EA_PLAY_PC: '1d33fbb9-b895-4732-a8ca-a55c8b99fa2c',
  PREMIUM: '09a72c0d-c466-426a-9580-b78955d8173a',
  LEAVING_SOON: '393f05bf-e596-4ef6-9487-6d4fa0eab987',
  RECENTLY_ADDED_PC: 'f13cf6b4-57e6-4459-89df-6aec18cf0538',
});

// Complete 2025/2026 Xbox Game Pass Subscription ProductId Registry
const XBOX_SUBSCRIPTION_TIERS = Object.freeze({
  CFQ7TTC0KHS0: {
    tierId: 'ultimate',
    rank: 1,
    displayName: 'Xbox Game Pass Ultimate',
    hasPcCatalogAccess: true,
    includesEaPlayPc: true,
    siglMode: 'all_pc_plus_ea',
  },
  CFQ7TTC0KGQ8: {
    tierId: 'pc',
    rank: 2,
    displayName: 'PC Game Pass',
    hasPcCatalogAccess: true,
    includesEaPlayPc: true,
    siglMode: 'all_pc_plus_ea',
  },
  CFQ7TTC0P85B: {
    tierId: 'premium',
    rank: 3,
    displayName: 'Xbox Game Pass Premium',
    hasPcCatalogAccess: true,
    includesEaPlayPc: false,
    siglMode: 'premium_pc_intersection',
  },
  CFQ7TTC0K5DJ: {
    tierId: 'essential',
    rank: 4,
    displayName: 'Xbox Game Pass Essential',
    hasPcCatalogAccess: true,
    includesEaPlayPc: false,
    siglMode: 'essential_pc',
  },
  CFQ7TTC0K5DH: {
    tierId: 'ea_play',
    rank: 5,
    displayName: 'EA Play',
    hasPcCatalogAccess: true,
    includesEaPlayPc: true,
    siglMode: 'ea_play_only',
  },
  CFQ7TTC10QFD: {
    tierId: 'pc',
    rank: 6,
    displayName: 'PC Game Pass Starter',
    hasPcCatalogAccess: true,
    includesEaPlayPc: false,
    siglMode: 'all_pc_only',
  },
  CFQ7TTC0K6L8: {
    tierId: 'console_only',
    rank: 7,
    displayName: 'Xbox Game Pass for Console',
    hasPcCatalogAccess: false,
    includesEaPlayPc: false,
    siglMode: 'none',
  },
});

const XBOX_PASS_PRODUCT_IDS = new Set(Object.keys(XBOX_SUBSCRIPTION_TIERS));

function isXboxPassProductId(bigId) {
  if (!bigId || typeof bigId !== 'string') return false;
  const upper = bigId.trim().toUpperCase();
  return XBOX_PASS_PRODUCT_IDS.has(upper) || upper.startsWith('CFQ7TTC');
}

// 3rd-party PC launcher PFN publisher hashes
const THIRD_PARTY_PFN_PUBLISHERS = Object.freeze([
  { suffix: '_ngz4m417e0mpw', handoff: 'ubisoft' },
  { suffix: '_kdg5n7x41qwkg', handoff: 'bnet' },
  { suffix: '_htdcg2kgmrmva', handoff: 'riot' },
  { suffix: '_q5ha1ztykcgvj', handoff: 'ea' },
]);

// Universal Storefront / Publisher Ecosystem Handoff Table (keyed strictly by storefront/ecosystem, never by game ID)
const EXTERNAL_STOREFRONT_HANDOFF_TABLE = Object.freeze({
  ea: Object.freeze({
    externalLauncher: 'EA App',
    externalLauncherUrl: 'https://www.ea.com/ea-app',
  }),
  ubisoft: Object.freeze({
    externalLauncher: 'Ubisoft Connect',
    externalLauncherUrl: 'https://ubisoftconnect.com/',
  }),
  riot: Object.freeze({
    externalLauncher: 'Riot Client',
    externalLauncherUrl: 'https://www.riotgames.com/',
  }),
  bnet: Object.freeze({
    externalLauncher: 'Battle.net',
    externalLauncherUrl: 'https://download.battle.net/',
  }),
});

const ALLOWED_EXTERNAL_LAUNCHER_HOSTS = new Set([
  'www.ea.com',
  'ea.com',
  'ubisoftconnect.com',
  'www.ubisoftconnect.com',
  'www.riotgames.com',
  'riotgames.com',
  'download.battle.net',
  'www.battle.net',
  'battle.net',
  'www.minecraft.net',
  'minecraft.net',
  'www.xbox.com',
  'xbox.com',
]);

/**
 * Validates that an external launcher URL uses `https:` and belongs to the official publisher allowlist.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
function validateAllowedExternalLauncherUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.protocol !== 'https:') return '';
    if (!ALLOWED_EXTERNAL_LAUNCHER_HOSTS.has(parsed.hostname.toLowerCase())) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

/**
 * Resolves `{ externalLauncher, externalLauncherUrl }` structurally from storefront ecosystem handoff
 * (`ea`, `ubisoft`, `riot`, `bnet`) or cross-platform standalone launcher publisher/PFN ecosystem.
 *
 * @param {{
 *   externalStorefrontHandoff?: string,
 *   isCrossPlatformLauncherRuntime?: boolean,
 *   hasMsixvcPackage?: boolean,
 *   packageFamilyName?: string,
 *   publisherName?: string,
 *   developerName?: string,
 *   productId?: string,
 * }} params
 * @returns {{ externalLauncher: string, externalLauncherUrl: string } | null}
 */
function resolveStructuralExternalLauncherHandoff(params = {}) {
  const handoffKey = String(params.externalStorefrontHandoff || '').trim().toLowerCase();
  if (handoffKey && Object.prototype.hasOwnProperty.call(EXTERNAL_STOREFRONT_HANDOFF_TABLE, handoffKey)) {
    const entry =
      EXTERNAL_STOREFRONT_HANDOFF_TABLE[
        /** @type {keyof typeof EXTERNAL_STOREFRONT_HANDOFF_TABLE} */ (handoffKey)
      ];
    const safeUrl = validateAllowedExternalLauncherUrl(entry.externalLauncherUrl);
    if (safeUrl) {
      return {
        externalLauncher: entry.externalLauncher,
        externalLauncherUrl: safeUrl,
      };
    }
  }

  if (params.isCrossPlatformLauncherRuntime === true && !params.hasMsixvcPackage) {
    const lowerPfn = String(params.packageFamilyName || '').trim().toLowerCase();
    const lowerPub = String(params.publisherName || '').trim().toLowerCase();
    const lowerDev = String(params.developerName || '').trim().toLowerCase();

    if (
      lowerPub.includes('mojang') ||
      lowerDev.includes('mojang') ||
      lowerPfn.startsWith('microsoft.4297127d64ec6')
    ) {
      const safeUrl = validateAllowedExternalLauncherUrl('https://www.minecraft.net/download');
      if (safeUrl) {
        return {
          externalLauncher: 'Minecraft Launcher',
          externalLauncherUrl: safeUrl,
        };
      }
    }

    const cleanProductId = String(params.productId || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    const pdpUrl = cleanProductId
      ? `https://www.xbox.com/games/store/_/${encodeURIComponent(cleanProductId)}`
      : 'https://www.xbox.com/';
    const safePdpUrl = validateAllowedExternalLauncherUrl(pdpUrl);
    const cleanPubLabel = String(params.publisherName || '').trim();
    if (safePdpUrl) {
      return {
        externalLauncher: cleanPubLabel ? `${cleanPubLabel} Launcher` : 'External Launcher',
        externalLauncherUrl: safePdpUrl,
      };
    }
  }

  return null;
}

const DISPLAY_CATALOG_CACHE_TTL_MS = 14 * 24 * 3600_000; // 14 days
const SIGL_FRESH_SKIP_NETWORK_MS = 5 * 60_000; // 5 minutes ultra-fast skip

// ============================================================================
// 1. Persistent Singleton SQLite V2 Compressed Delta Cache (`<= 3.5 MB` for 1,000+ Titles)
// ============================================================================

const RELEVANT_IMAGE_PURPOSES = new Set([
  'poster',
  'superheroart',
  'titledheroart',
  'featurepromotionalsquareart',
  'boxart',
  'tile',
  'appicon',
  'logo',
  'screenshot',
]);

/**
 * Projects a raw ~42 KB DisplayCatalog Product payload down to the exact compact schema
 * required for 5-Gate evaluation, artwork/trailer/rating rendering, bundle BFS, and `.msixvc`
 * package delivery resolution, before `zlib.deflateRawSync` compression (~850 bytes/title).
 */
function projectCompactDisplayCatalogProduct(prod) {
  if (!prod || typeof prod !== 'object') return prod;
  if (prod._compactV2 === true) return prod;

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
        ...(rawProps.ServiceConfigId ? { ServiceConfigId: rawProps.ServiceConfigId } : {}),
        ...(rawProps.Scid ? { Scid: rawProps.Scid } : {}),
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
  for (const avail of rawSkuAvails) {
    const sku = avail?.Sku;
    if (!sku || typeof sku !== 'object') continue;
    const sp = sku.Properties || {};
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

    // Collapse verbose Availabilities down to earliest StartDate + AllowedPlatforms
    let earliestStartDate = '';
    const allowedPlatformNames = new Set();
    if (Array.isArray(avail.Availabilities)) {
      for (const av of avail.Availabilities) {
        const sd = av?.Conditions?.StartDate || av?.StartDate || '';
        if (typeof sd === 'string' && sd && (!earliestStartDate || sd < earliestStartDate)) {
          earliestStartDate = sd;
        }
        const allowed = av?.Conditions?.ClientConditions?.AllowedPlatforms;
        if (Array.isArray(allowed)) {
          for (const ap of allowed) {
            const pName = typeof ap === 'string' ? ap : ap?.PlatformName;
            if (pName) allowedPlatformNames.add(String(pName));
          }
        }
      }
    }

    const compactAvails =
      earliestStartDate || allowedPlatformNames.size > 0
        ? [
            {
              Conditions: {
                ...(earliestStartDate ? { StartDate: earliestStartDate } : {}),
                ...(allowedPlatformNames.size > 0
                  ? {
                      ClientConditions: {
                        AllowedPlatforms: Array.from(allowedPlatformNames).map((PlatformName) => ({
                          PlatformName,
                        })),
                      },
                    }
                  : {}),
              },
            },
          ]
        : undefined;

    compactSkuAvails.push({
      Sku: {
        ...(sku.SkuId ? { SkuId: sku.SkuId } : {}),
        ...(compactSkuMkt ? { MarketProperties: compactSkuMkt } : {}),
        Properties: {
          ...(sp.IsTrial !== undefined ? { IsTrial: sp.IsTrial } : {}),
          ...(compactFd && Object.keys(compactFd).length > 0 ? { FulfillmentData: compactFd } : {}),
          ...(compactBundled && compactBundled.length > 0 ? { BundledSkus: compactBundled } : {}),
          ...(compactPackages && compactPackages.length > 0 ? { Packages: compactPackages } : {}),
        },
      },
      ...(compactAvails ? { Availabilities: compactAvails } : {}),
    });
  }

  return {
    _compactV2: true,
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
      return JSON.parse(zlib.inflateRawSync(buf).toString('utf8'));
    } catch {
      return JSON.parse(buf.toString('utf8'));
    }
  }
  if (typeof rawPayload === 'string') {
    if (rawPayload.startsWith('z1:')) {
      const inflated = zlib.inflateRawSync(Buffer.from(rawPayload.slice(3), 'base64'));
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

function getSqliteFileTotalBytes(dbPath) {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const st = fs.statSync(`${dbPath}${suffix}`);
      total += Number(st.size || 0);
    } catch {}
  }
  return total;
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
      // Directory/file was cleaned up externally (e.g., fresh temp dir in tests)
      try {
        existingSingleton.db.close();
      } catch {}
      sqliteCacheStoreByDbPath.delete(dbPath);
    }

    try {
      registerCacheProcessExitCleanup();
      const preOpenBytes = getSqliteFileTotalBytes(dbPath);
      const db = new DatabaseSync(dbPath);
      db.exec(`
        PRAGMA busy_timeout = 5000;
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
          updated_at INTEGER NOT NULL
        );
      `);

      // Evict expired rows & migrate oversized legacy uncompressed caches down to <= 3.5 MB
      try {
        const cutoff = Date.now() - DISPLAY_CATALOG_CACHE_TTL_MS;
        const delInfo = db
          .prepare('DELETE FROM display_catalog_products WHERE updated_at < ?')
          .run(cutoff);

        const hasLegacyUncompressedRows = Boolean(
          db
            .prepare(
              "SELECT 1 FROM display_catalog_products WHERE typeof(product_json) = 'text' LIMIT 1"
            )
            .get()
        );

        const needsCompaction =
          preOpenBytes > CATALOG_DB_COMPACTION_THRESHOLD_BYTES ||
          (hasLegacyUncompressedRows && preOpenBytes > 3 * 1024 * 1024);

        if (needsCompaction) {
          const legacyRows = db
            .prepare(
              "SELECT cache_key, product_json FROM display_catalog_products WHERE typeof(product_json) = 'text'"
            )
            .all();
          if (legacyRows.length > 0) {
            const updateStmt = db.prepare(
              'UPDATE display_catalog_products SET product_json = ? WHERE cache_key = ?'
            );
            db.exec('BEGIN');
            try {
              for (const r of legacyRows) {
                try {
                  const parsed = deserializeCatalogProductPayload(r.product_json);
                  if (parsed) {
                    updateStmt.run(serializeCatalogProductPayload(parsed), r.cache_key);
                  }
                } catch {}
              }
              db.exec('COMMIT');
            } catch {
              try {
                db.exec('ROLLBACK');
              } catch {}
            }
          }
          db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
          db.exec('VACUUM;');
        } else if (Number(delInfo?.changes || 0) > 100) {
          db.exec('PRAGMA wal_checkpoint(PASSIVE);');
        }
      } catch {}

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
      const getProductStmt = db.prepare(
        'SELECT product_json, updated_at FROM display_catalog_products WHERE cache_key = ?'
      );
      const deleteExpiredKeyStmt = db.prepare(
        'DELETE FROM display_catalog_products WHERE cache_key = ?'
      );
      const upsertProductStmt = db.prepare(
        `INSERT INTO display_catalog_products (cache_key, big_id, market, product_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           product_json = excluded.product_json,
           updated_at = excluded.updated_at`
      );

      const handle = {
        dbPath,
        getSigl(cacheKey) {
          const row = getSiglStmt.get(cacheKey);
          if (!row) return null;
          try {
            return {
              etag: String(row.etag || ''),
              sha256: String(row.sha256 || ''),
              ids: JSON.parse(String(row.ids_json || '[]')),
              fetchedAt: Number(row.fetched_at || 0),
            };
          } catch {
            return null;
          }
        },
        setSigl(cacheKey, { etag = '', sha256 = '', ids = [], fetchedAt = Date.now() }) {
          setSiglStmt.run(cacheKey, etag, sha256, JSON.stringify(ids), fetchedAt);
        },
        getProducts(bigIds, market = 'US') {
          const out = new Map();
          if (!Array.isArray(bigIds) || bigIds.length === 0) return out;
          const mkt = String(market || 'US').toUpperCase();
          const now = Date.now();
          for (const rawId of bigIds) {
            const id = String(rawId || '').trim().toUpperCase();
            if (!id) continue;
            const key = `${mkt}:${id}`;
            const row = getProductStmt.get(key);
            if (!row) continue;
            if (now - Number(row.updated_at || 0) > DISPLAY_CATALOG_CACHE_TTL_MS) {
              try {
                deleteExpiredKeyStmt.run(key);
              } catch {}
              continue;
            }
            try {
              const decoded = deserializeCatalogProductPayload(row.product_json);
              if (decoded) {
                out.set(id, decoded);
              }
            } catch {}
          }
          return out;
        },
        setProducts(productsMap, market = 'US') {
          if (!productsMap || productsMap.size === 0) return;
          const mkt = String(market || 'US').toUpperCase();
          const now = Date.now();
          db.exec('BEGIN');
          try {
            for (const [id, prod] of productsMap.entries()) {
              const upper = String(id || '').trim().toUpperCase();
              if (!upper || !prod) continue;
              const compressedBlob = serializeCatalogProductPayload(prod);
              upsertProductStmt.run(`${mkt}:${upper}`, upper, mkt, compressedBlob, now);
            }
            db.exec('COMMIT');
          } catch (err) {
            try {
              db.exec('ROLLBACK');
            } catch {}
            throw err;
          }
        },
        pruneExpired(nowMs = Date.now()) {
          const cutoff = nowMs - DISPLAY_CATALOG_CACHE_TTL_MS;
          const info = db
            .prepare('DELETE FROM display_catalog_products WHERE updated_at < ?')
            .run(cutoff);
          return Number(info?.changes || 0);
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
    getSigl(cacheKey) {
      return state.sigls?.[cacheKey] || null;
    },
    setSigl(cacheKey, entry) {
      state.sigls = state.sigls || {};
      state.sigls[cacheKey] = entry;
      flushJson();
    },
    getProducts(bigIds, market = 'US') {
      const out = new Map();
      const mkt = String(market || 'US').toUpperCase();
      const now = Date.now();
      for (const rawId of bigIds || []) {
        const id = String(rawId || '').trim().toUpperCase();
        const entry = state.products?.[`${mkt}:${id}`];
        if (entry && now - Number(entry.updatedAt || 0) <= DISPLAY_CATALOG_CACHE_TTL_MS) {
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
        };
      }
      flushJson();
    },
    pruneExpired() {
      flushJson();
      return 0;
    },
    close() {},
    destroy() {},
  };
}

// ============================================================================
// 2. Sync Mode Normalization & STRICT ACTIVE-ACCESS GATE
// ============================================================================

/**
 * Normalizes any sync mode string into one of the three canonical modes:
 * `'owned_and_played'` (default), `'full_pc_game_pass'`, or `'owned_only'`.
 *
 * @param {string} [rawMode]
 * @returns {'owned_and_played' | 'full_pc_game_pass' | 'owned_only'}
 */
function normalizeXboxSyncMode(rawMode) {
  const clean = String(rawMode || '')
    .trim()
    .toLowerCase();
  if (clean === 'owned_only') return 'owned_only';
  if (clean === 'full_pc_game_pass' || clean === 'owned_and_full_catalog') {
    return 'full_pc_game_pass';
  }
  return 'owned_and_played';
}

/**
 * STRICT ACTIVE-ACCESS GATE (Core Mandate):
 * `TitleHub` (`titlehistory`) is strictly an achievement/playtime decorator and an engagement
 * signal WITHIN an active PC-eligible Game Pass subscription whose current live SIGL catalog
 * still includes that title. It MUST NEVER admit an unentitled, expired, console-only-sub, or
 * rotated-out game into the library!
 *
 * @param {{
 *   syncMode?: string,
 *   isOwnedPermanent: boolean,
 *   subscription?: { hasActiveSubscription?: boolean, hasPcCatalogAccess?: boolean, tierDisplayName?: string },
 *   inActiveTierPcSigl?: boolean,
 *   isPlayedInTitleHub?: boolean,
 *   isInstalledLocally?: boolean,
 * }} [params]
 * @returns {{
 *   admit: boolean,
 *   ownershipType?: 'owned' | 'subscription' | 'owned_and_subscription',
 *   subscriptionExpired: boolean,
 *   reason: string,
 * }}
 */
function evaluateXboxActiveAccessGate(params = /** @type {any} */ ({})) {
  const mode = normalizeXboxSyncMode(params.syncMode);
  const isOwnedPermanent = Boolean(params.isOwnedPermanent);
  const hasPcSub = Boolean(
    params.subscription?.hasActiveSubscription && params.subscription?.hasPcCatalogAccess
  );
  const inActiveTierPcSigl = Boolean(params.inActiveTierPcSigl);
  const isPlayedInTitleHub = Boolean(params.isPlayedInTitleHub);
  const isInstalledLocally = Boolean(params.isInstalledLocally);

  const hasLiveGamePassAccess = hasPcSub && inActiveTierPcSigl;

  // 1. Permanently owned games are ALWAYS admitted across all 3 sync modes
  if (isOwnedPermanent) {
    return {
      admit: true,
      ownershipType: hasLiveGamePassAccess ? 'owned_and_subscription' : 'owned',
      subscriptionExpired: false,
      reason: 'owned_permanent',
    };
  }

  // 2. Under `owned_only`, strictly exclude all non-permanently-owned titles
  if (mode === 'owned_only') {
    return {
      admit: false,
      subscriptionExpired: false,
      reason: 'excluded_owned_only_mode',
    };
  }

  // 3. Under `full_pc_game_pass`, admit if user currently holds an active PC Game Pass tier
  //    AND the game is in that tier's live PC SIGL (or if physically installed locally)
  if (mode === 'full_pc_game_pass') {
    if (hasLiveGamePassAccess) {
      return {
        admit: true,
        ownershipType: 'subscription',
        subscriptionExpired: false,
        reason: 'active_pc_game_pass_catalog',
      };
    }
    if (isInstalledLocally) {
      return {
        admit: true,
        ownershipType: 'subscription',
        subscriptionExpired: true,
        reason: 'installed_locally_subscription_lapsed_or_rotated',
      };
    }
    return {
      admit: false,
      subscriptionExpired: false,
      reason: hasPcSub ? 'rotated_out_of_active_sigl' : 'no_active_pc_game_pass',
    };
  }

  // 4. Default `owned_and_played`:
  //    Admit non-owned Game Pass titles ONLY IF:
  //    - Active PC-eligible subscription AND in active tier's live PC SIGL AND (played in TitleHub OR installed locally), OR
  //    - Physically installed on local disk right now (marked `subscriptionExpired: true`).
  if (hasLiveGamePassAccess && (isPlayedInTitleHub || isInstalledLocally)) {
    return {
      admit: true,
      ownershipType: 'subscription',
      subscriptionExpired: false,
      reason: isInstalledLocally
        ? 'active_pc_game_pass_installed'
        : 'active_pc_game_pass_played',
    };
  }

  if (!hasLiveGamePassAccess && isInstalledLocally) {
    return {
      admit: true,
      ownershipType: 'subscription',
      subscriptionExpired: true,
      reason: 'installed_locally_subscription_lapsed_or_rotated',
    };
  }

  return {
    admit: false,
    subscriptionExpired: false,
    reason: !hasPcSub
      ? 'no_active_pc_game_pass_subscription'
      : !inActiveTierPcSigl
        ? 'rotated_out_of_active_sigl'
        : 'unplayed_uninstalled_game_pass_catalog_title',
  };
}

// ============================================================================
// 3. Active Subscription Tier Detector (`PCGAFD` + `collections` v6 Fallback)
// ============================================================================

function makeCorrelationVector() {
  return `${crypto.randomBytes(16).toString('base64').replace(/=+$/g, '')}.0`;
}

function classifySubscriptionRecords(records = [], nowMs = Date.now()) {
  const activeMatched = [];

  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue;
    const productId = String(raw.productId || raw.bigId || raw.id || '')
      .trim()
      .toUpperCase();
    if (!productId) continue;

    const status = String(raw.status || raw.state || 'Active').trim();
    const statusLower = status.toLowerCase();
    if (
      statusLower !== 'active' &&
      statusLower !== 'ingraceperiod' &&
      statusLower !== 'warned'
    ) {
      continue;
    }

    const endDateRaw =
      raw.endDate ||
      raw.expirationDate ||
      raw.recurrenceData?.endDate ||
      raw.trialData?.endDate ||
      '';
    if (endDateRaw) {
      const endTs = Date.parse(String(endDateRaw));
      if (!Number.isNaN(endTs) && endTs <= nowMs) {
        continue;
      }
    }

    const knownTier = XBOX_SUBSCRIPTION_TIERS[productId];
    if (knownTier) {
      const skuId = String(raw.skuId || raw.SkuId || '0010').trim() || '0010';
      activeMatched.push({
        productId,
        skuId,
        ...knownTier,
        status,
        endDate: endDateRaw ? String(endDateRaw) : undefined,
        autoRenew:
          typeof raw.autoRenew === 'boolean'
            ? raw.autoRenew
            : typeof raw.recurrenceData?.autoRenew === 'boolean'
              ? raw.recurrenceData.autoRenew
              : undefined,
        dynamicSiglIds: Array.isArray(raw.siglIds || raw.collectionIds)
          ? (raw.siglIds || raw.collectionIds).map((x) => String(x).trim()).filter(Boolean)
          : [],
      });
    }
  }

  if (activeMatched.length === 0) {
    return {
      hasActiveSubscription: false,
      hasPcCatalogAccess: false,
      tierId: 'none',
      tierDisplayName: 'None',
      activeProductIds: [],
      activeEntitlementKeys: [],
    };
  }

  activeMatched.sort((a, b) => a.rank - b.rank);
  // Prefer highest-ranked PC-capable subscription if user holds multiple (e.g., Console + EA Play or Ultimate)
  const bestPc = activeMatched.find((t) => t.hasPcCatalogAccess);
  const primary = bestPc || activeMatched[0];
  const anyPcAccess = activeMatched.some((t) => t.hasPcCatalogAccess);
  const includesEaPlayPc = activeMatched.some((t) => t.includesEaPlayPc);

  return {
    hasActiveSubscription: true,
    hasPcCatalogAccess: anyPcAccess,
    primaryProductId: primary.productId,
    tierId: primary.tierId,
    tierDisplayName: primary.displayName,
    status: primary.status,
    endDate: primary.endDate,
    autoRenew: primary.autoRenew,
    activeProductIds: Array.from(new Set(activeMatched.map((t) => t.productId))),
    activeEntitlementKeys: Array.from(
      new Set(activeMatched.map((t) => `${t.productId}:${t.skuId || '0010'}`))
    ),
    includesEaPlayPc,
    siglMode: primary.siglMode,
    dynamicSiglIds: primary.dynamicSiglIds || [],
  };
}

function extractEntitlementOrSubscriptionRecords(json) {
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json)) return json;
  for (const key of ['entitlements', 'subscriptions', 'items']) {
    const val = json[key];
    if (Array.isArray(val)) return val;
    if (val && typeof val === 'object') {
      return Object.entries(val).map(([productId, entry]) =>
        entry && typeof entry === 'object' ? { productId, ...entry } : { productId }
      );
    }
  }
  return [];
}

/**
 * Detects active Xbox Game Pass / EA Play subscription tiers from `PCGAFD/entitlements/subscriptions`
 * with automatic fallback to `collections.mp.microsoft.com/v6.0/collections/query` (`productTypes: ["Pass"]`).
 */
async function detectXboxSubscriptions(options = {}) {
  const defaults = resolveDefaultXboxLocaleAndMarket(options);
  const {
    storeToken,
    authProvider,
    market = defaults.market,
    locale = defaults.locale,
    nowMs = Date.now(),
  } = options;
  const fetchImpl = resolveFetchImpl(options);

  const rawTicket =
    storeToken ||
    (authProvider && typeof authProvider.getStoreMsaToken === 'function'
      ? await authProvider.getStoreMsaToken({ target: 'pcgafd' })
      : '');
  let pcgafdTicket = normalizeStoreMsaTicket(rawTicket, { target: 'pcgafd' });
  if (!pcgafdTicket && authProvider && typeof authProvider.getXstsToken === 'function') {
    try {
      const mpXsts = await authProvider.getXstsToken(XSTS_RELYING_PARTIES.MS_STORE);
      if (mpXsts?.authorizationHeader) {
        pcgafdTicket = mpXsts.authorizationHeader;
      }
    } catch {}
  }

  const collectedRecords = [];

  // Primary: PCGAFD `/entitlements/subscriptions` (supports both `t=...` MSA tickets and `XBL3.0 x=<uhs>;<mpXsts>`)
  if (pcgafdTicket && typeof fetchImpl === 'function') {
    try {
      const subUrl = `${PCGAFD_SUBSCRIPTIONS_URL}?market=${encodeURIComponent(market)}&language=${encodeURIComponent(locale)}&appVersion=0.2.3`;
      const res = await fetchImpl(subUrl, {
        method: 'POST',
        headers: {
          Authorization: pcgafdTicket,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-MS-API-Version': '1.1',
          'Calling-App-Name': 'OneLauncher',
          'MS-CV': makeCorrelationVector(),
        },
        body: JSON.stringify({
          productIds: Object.keys(XBOX_SUBSCRIPTION_TIERS),
        }),
        signal: buildXboxFetchSignal(options.signal),
      });

      if (res.ok) {
        const json = await res.json();
        const subs = extractEntitlementOrSubscriptionRecords(json);
        collectedRecords.push(...subs);
      }
    } catch {}
  }

  // Fallback: `collections.mp.microsoft.com/v6.0/collections/query` (`productTypes: ["Pass"]`)
  if (collectedRecords.length === 0 && typeof fetchImpl === 'function') {
    try {
      let authHeader = pcgafdTicket
        ? /^xbl3\.0\s+/i.test(pcgafdTicket)
          ? pcgafdTicket
          : `WLID1.0="${pcgafdTicket}"`
        : '';
      if (authProvider && typeof authProvider.getXstsToken === 'function') {
        try {
          const mpXsts = await authProvider.getXstsToken(XSTS_RELYING_PARTIES.MS_STORE);
          if (mpXsts?.authorizationHeader) {
            authHeader = mpXsts.authorizationHeader;
          }
        } catch {}
      }

      if (authHeader) {
        const colRes = await fetchImpl(COLLECTIONS_QUERY_V6_URL, {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'MS-CV': makeCorrelationVector(),
          },
          body: JSON.stringify({
            market: String(market || 'US').toUpperCase(),
            locale,
            maxPageSize: 100,
            beneficiaries: [{ identityType: 'b2b' }],
            productTypes: ['Pass'],
            statusFilters: ['Active'],
            validityType: 'All',
          }),
          signal: buildXboxFetchSignal(options.signal),
        });
        if (colRes.ok) {
          const colJson = await colRes.json();
          if (Array.isArray(colJson?.items)) {
            collectedRecords.push(...colJson.items);
          }
        }
      }
    } catch {}
  }

  return classifySubscriptionRecords(collectedRecords, nowMs);
}

// ============================================================================
// 4. Owned Entitlements Discovery (`PCGAFD/entitlements` + `collections` v6)
// ============================================================================

function extractSatisfyingBigId(candidate) {
  if (!candidate) return '';
  let raw = '';
  if (typeof candidate === 'string') {
    raw = candidate;
  } else if (typeof candidate === 'object') {
    raw = String(
      candidate.productId ||
        candidate.ProductId ||
        candidate.bigId ||
        candidate.BigId ||
        candidate.id ||
        candidate.Id ||
        candidate.entitlementKey ||
        candidate.key ||
        ''
    );
  }
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) return '';
  let prefix = trimmed;
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':').map((p) => p.trim());
    prefix = parts[0] === 'BIG' && parts.length >= 2 ? parts[1] : parts[0];
  }
  return /^[A-Z0-9]{12}$/.test(prefix) ? prefix : '';
}

/**
 * Classifies an individual `PCGAFD` or `collections` entitlement record, strictly separating
 * permanent digital purchases (`ownershipType: 'owned'`) from subscription-satisfied entitlements
 * and rejecting trials, expired rentals, shared entitlements, consumables, and passes.
 */
function classifyXboxEntitlement(ent, nowMs = Date.now()) {
  if (!ent || typeof ent !== 'object') {
    return { include: false, reason: 'invalid_record' };
  }

  const productId = String(
    ent.productId || ent.ProductId || ent.bigId || ent.BigId || ent.id || ent.Id || ''
  )
    .trim()
    .toUpperCase();
  if (!productId || !/^[A-Z0-9]{12}$/.test(productId)) {
    return { include: false, reason: 'invalid_product_id' };
  }

  if (isXboxPassProductId(productId)) {
    return { include: false, reason: 'subscription_pass_sku', productId };
  }

  const status = String(ent.status || ent.state || 'Active').trim().toLowerCase();
  if (status !== 'active') {
    return { include: false, reason: `inactive_status:${status}`, productId };
  }

  if (typeof ent.sharingSource === 'string') {
    const sharing = ent.sharingSource.trim().toLowerCase();
    if (sharing && sharing !== 'none') {
      return { include: false, reason: `shared_entitlement:${sharing}`, productId };
    }
  }

  if (ent.endDate || ent.expirationDate) {
    const endTs = Date.parse(String(ent.endDate || ent.expirationDate));
    if (!Number.isNaN(endTs) && endTs <= nowMs) {
      return { include: false, reason: 'expired_entitlement', productId };
    }
  }

  const acqType = String(ent.acquisitionType || '').trim().toLowerCase();
  if (
    ent.isTrial === true ||
    ent.trialData?.isInTrialPeriod === true ||
    Number(ent.trialTimeRemaining || 0) > 0 ||
    acqType === 'trial'
  ) {
    return { include: false, reason: 'free_trial', productId };
  }

  const kind = String(ent.productKind || ent.productType || '').trim().toLowerCase();
  if (
    ['pass', 'subscription', 'consumable', 'unmanagedconsumable', 'durable', 'avataritem'].includes(
      kind
    )
  ) {
    return { include: false, reason: `non_game_kind:${kind}`, productId };
  }

  const rawSatisfyingCandidates = [
    ent.satisfiedByProductId,
    ent.satisfyingPassId,
    ent.passProductId,
    ...(Array.isArray(ent.satisfiedByProductIds) ? ent.satisfiedByProductIds : []),
    ...(Array.isArray(ent.satisfiedEntitlements) ? ent.satisfiedEntitlements : []),
    ...(Array.isArray(ent.satisfyingEntitlementKeys) ? ent.satisfyingEntitlementKeys : []),
    ...(Array.isArray(ent.satisfyingPassIds) ? ent.satisfyingPassIds : []),
    ...(Array.isArray(ent.passProductIds) ? ent.passProductIds : []),
  ];

  const satisfiedByPassIds = [];
  const parentIds = [];
  const seenPassIds = new Set();
  const seenParentIds = new Set();

  for (const cand of rawSatisfyingCandidates) {
    const candBigId = extractSatisfyingBigId(cand);
    if (!candBigId) continue;
    if (isXboxPassProductId(candBigId)) {
      if (!seenPassIds.has(candBigId)) {
        seenPassIds.add(candBigId);
        satisfiedByPassIds.push(candBigId);
      }
    } else if (candBigId !== productId && !seenParentIds.has(candBigId)) {
      seenParentIds.add(candBigId);
      parentIds.push(candBigId);
    }
  }

  // Unknown special licensing flags (`isPositron` !== false when present) never become permanent ownership
  const hasSpecialFlag = ent.isPositron !== undefined && ent.isPositron !== false;
  const isSubscriptionSatisfied =
    satisfiedByPassIds.length > 0 || acqType === 'recurring' || hasSpecialFlag;

  const skuId = String(ent.skuId || ent.SkuId || '0010').trim() || '0010';
  const primarySatisfiedBy = satisfiedByPassIds[0] || parentIds[0] || '';

  if (isSubscriptionSatisfied) {
    return {
      include: true,
      productId,
      skuId,
      ownershipType: 'subscription',
      satisfiedByProductId: primarySatisfiedBy || undefined,
      satisfiedByPassIds,
      parentIds,
    };
  }

  return {
    include: true,
    productId,
    skuId,
    ownershipType: 'owned',
    satisfiedByProductId: parentIds[0] || undefined,
    satisfiedByPassIds,
    parentIds,
  };
}

function getClassifiedEntitlementRank(classified) {
  if (!classified || !classified.include) return 1;
  if (classified.ownershipType === 'owned') return 3;
  if (classified.ownershipType === 'subscription') return 2;
  return 1;
}

function mergeClassifiedEntitlement(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const existingRank = getClassifiedEntitlementRank(existing);
  const incomingRank = getClassifiedEntitlementRank(incoming);

  const unionedPassIds = Array.from(
    new Set([
      ...(existing.ownershipType === 'subscription' ? existing.satisfiedByPassIds || [] : []),
      ...(incoming.ownershipType === 'subscription' ? incoming.satisfiedByPassIds || [] : []),
    ])
  );

  if (incomingRank > existingRank) {
    if (incoming.ownershipType === 'subscription') {
      return {
        ...incoming,
        satisfiedByPassIds: unionedPassIds,
        satisfiedByProductId:
          unionedPassIds[0] || incoming.satisfiedByProductId || existing.satisfiedByProductId,
      };
    }
    return incoming;
  }

  if (existingRank > incomingRank) {
    if (existing.ownershipType === 'subscription') {
      return {
        ...existing,
        satisfiedByPassIds: unionedPassIds,
        satisfiedByProductId:
          unionedPassIds[0] || existing.satisfiedByProductId || incoming.satisfiedByProductId,
      };
    }
    return existing;
  }

  if (existingRank === 3) {
    const existingDirect = !existing.parentIds || existing.parentIds.length === 0;
    const incomingDirect = !incoming.parentIds || incoming.parentIds.length === 0;
    if (existingDirect) return existing;
    if (incomingDirect) return incoming;
    const mergedParents = Array.from(
      new Set([...(existing.parentIds || []), ...(incoming.parentIds || [])])
    );
    return {
      ...existing,
      parentIds: mergedParents,
      satisfiedByProductId: mergedParents[0] || existing.satisfiedByProductId,
    };
  }

  if (existingRank === 2) {
    const mergedParents = Array.from(
      new Set([...(existing.parentIds || []), ...(incoming.parentIds || [])])
    );
    const primaryPass =
      unionedPassIds[0] || existing.satisfiedByProductId || incoming.satisfiedByProductId;
    return {
      ...existing,
      satisfiedByPassIds: unionedPassIds,
      satisfiedByProductId: primaryPass || undefined,
      parentIds: mergedParents,
    };
  }

  if (incoming.reason === 'subscription_pass_sku' && existing.reason !== 'subscription_pass_sku') {
    return incoming;
  }
  return existing;
}

/**
 * Queries `GET https://beige.xboxservices.com/PCGAFD/entitlements` across all `x-ms-ct` continuation
 * pages (with automatic `collections` v6 fallback) to discover every played AND unplayed digital purchase.
 */
async function fetchXboxOwnedEntitlements(options = {}) {
  const defaults = resolveDefaultXboxLocaleAndMarket(options);
  const {
    storeToken,
    authProvider,
    market = defaults.market,
    locale = defaults.locale,
    nowMs = Date.now(),
  } = options;
  const fetchImpl = resolveFetchImpl(options);

  const rawTicket =
    storeToken ||
    (authProvider && typeof authProvider.getStoreMsaToken === 'function'
      ? await authProvider.getStoreMsaToken({ target: 'pcgafd' })
      : '');
  let pcgafdTicket = normalizeStoreMsaTicket(rawTicket, { target: 'pcgafd' });
  if (!pcgafdTicket && authProvider && typeof authProvider.getXstsToken === 'function') {
    try {
      const mpXsts = await authProvider.getXstsToken(XSTS_RELYING_PARTIES.MS_STORE);
      if (mpXsts?.authorizationHeader) {
        pcgafdTicket = mpXsts.authorizationHeader;
      }
    } catch {}
  }

  const rawEntitlements = [];

  if (pcgafdTicket && typeof fetchImpl === 'function') {
    let continuationToken = '';
    const seenCursors = new Set();
    for (let page = 0; page < 25; page++) {
      const url = `${PCGAFD_ENTITLEMENTS_URL}?market=${encodeURIComponent(market)}&locale=${encodeURIComponent(locale)}&language=${encodeURIComponent(locale)}&appVersion=0.2.3`;
      const headers = {
        Authorization: pcgafdTicket,
        Accept: 'application/json',
        'X-MS-API-Version': '1.1',
        'Calling-App-Name': 'OneLauncher',
        'MS-CV': makeCorrelationVector(),
      };
      if (continuationToken) {
        headers['x-ms-ct'] = continuationToken;
      }

      const res = await fetchImpl(url, {
        method: 'GET',
        headers,
        signal: buildXboxFetchSignal(options.signal),
      });
      if (!res.ok) break;

      const json = await res.json();
      const items = extractEntitlementOrSubscriptionRecords(json);
      rawEntitlements.push(...items);

      const nextCt =
        (typeof res.headers?.get === 'function' ? res.headers.get('x-ms-ct') : '') ||
        json?.continuationToken ||
        '';
      if (!nextCt || seenCursors.has(nextCt) || items.length === 0) {
        break;
      }
      seenCursors.add(nextCt);
      continuationToken = nextCt;
    }
  }

  // Fallback to `collections.mp.microsoft.com/v6.0/collections/query` if PCGAFD returned nothing
  if (rawEntitlements.length === 0 && typeof fetchImpl === 'function') {
    let authHeader = pcgafdTicket
      ? /^xbl3\.0\s+/i.test(pcgafdTicket)
        ? pcgafdTicket
        : `WLID1.0="${pcgafdTicket}"`
      : '';
    if (authProvider && typeof authProvider.getXstsToken === 'function') {
      try {
        const mpXsts = await authProvider.getXstsToken(XSTS_RELYING_PARTIES.MS_STORE);
        if (mpXsts?.authorizationHeader) {
          authHeader = mpXsts.authorizationHeader;
        }
      } catch {}
    }

    if (authHeader) {
      let ct = undefined;
      for (let page = 0; page < 15; page++) {
        const colRes = await fetchImpl(COLLECTIONS_QUERY_V6_URL, {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'MS-CV': makeCorrelationVector(),
          },
          body: JSON.stringify({
            market: String(market || 'US').toUpperCase(),
            locale,
            maxPageSize: 500,
            beneficiaries: [{ identityType: 'b2b' }],
            productTypes: ['Game', 'Application'],
            statusFilters: ['Active'],
            validityType: 'All',
            ...(ct ? { continuationToken: ct } : {}),
          }),
          signal: buildXboxFetchSignal(options.signal),
        });
        if (!colRes.ok) break;
        const colJson = await colRes.json();
        const items = Array.isArray(colJson?.items) ? colJson.items : [];
        rawEntitlements.push(...items);
        if (!colJson?.continuationToken || items.length === 0) break;
        ct = colJson.continuationToken;
      }
    }
  }

  // Classify all records, rank/merge multi-SKU rows per `productId` (`owned` rank 3 > `subscription`
  // rank 2 > `include: false` rank 1, unioning `satisfiedByPassIds` across subscription rows), and
  // walk `parentIds` / `satisfiedByProductId` parent chains so bundle children inherit true entitlement!
  const classifiedById = new Map();
  const classifiedRowsById = new Map();
  for (const raw of rawEntitlements) {
    const classified = classifyXboxEntitlement(raw, nowMs);
    if (classified.productId) {
      classifiedById.set(
        classified.productId,
        mergeClassifiedEntitlement(classifiedById.get(classified.productId), classified)
      );
      const rows = classifiedRowsById.get(classified.productId) || [];
      rows.push(classified);
      classifiedRowsById.set(classified.productId, rows);
    }
  }

  const resolvedMemo = new Map();

  const resolveInheritedOwnership = (item, visited = new Set()) => {
    if (!item || !item.include) return { include: false };

    if (item.ownershipType === 'subscription') {
      const passIds = Array.isArray(item.satisfiedByPassIds) ? item.satisfiedByPassIds : [];
      const primary = passIds[0] || item.satisfiedByProductId || undefined;
      return {
        ...item,
        ownershipType: 'subscription',
        satisfiedByProductId: primary,
        satisfiedByPassIds: passIds.length > 0 ? passIds : primary ? [primary] : [],
      };
    }

    const parents =
      Array.isArray(item.parentIds) && item.parentIds.length > 0
        ? item.parentIds
        : item.satisfiedByProductId
          ? [item.satisfiedByProductId]
          : [];

    if (parents.length === 0) {
      return item;
    }

    if (visited.size >= 16) {
      return { include: false };
    }

    const nextVisited = new Set(visited);
    if (item.productId) {
      nextVisited.add(item.productId);
    }

    let hasOwnedParent = false;
    let hasSubscriptionParent = false;
    let hasMissingParent = false;
    const inheritedPassIds = [];
    const addPassId = (pid) => {
      if (pid && !inheritedPassIds.includes(pid)) {
        inheritedPassIds.push(pid);
      }
    };
    let fallbackSubParentId = '';

    for (const parentId of parents) {
      if (!parentId) continue;
      if (isXboxPassProductId(parentId)) {
        hasSubscriptionParent = true;
        addPassId(parentId);
        continue;
      }
      if (nextVisited.has(parentId)) {
        continue;
      }

      const parentEntry = classifiedById.get(parentId);
      if (!parentEntry) {
        hasMissingParent = true;
        continue;
      }

      if (!parentEntry.include) {
        if (parentEntry.reason === 'subscription_pass_sku') {
          hasSubscriptionParent = true;
          addPassId(parentId);
        }
        continue;
      }

      const resolvedParent = resolveProductIdOwnership(parentId, nextVisited);
      if (!resolvedParent.include) {
        continue;
      }

      if (resolvedParent.ownershipType === 'owned') {
        hasOwnedParent = true;
        break;
      }

      if (resolvedParent.ownershipType === 'subscription') {
        hasSubscriptionParent = true;
        for (const p of resolvedParent.satisfiedByPassIds || []) {
          addPassId(p);
        }
        if (resolvedParent.satisfiedByProductId) {
          if (isXboxPassProductId(resolvedParent.satisfiedByProductId)) {
            addPassId(resolvedParent.satisfiedByProductId);
          } else if (!fallbackSubParentId) {
            fallbackSubParentId = resolvedParent.satisfiedByProductId;
          }
        }
        if (!fallbackSubParentId) {
          fallbackSubParentId = parentId;
        }
      }
    }

    if (hasOwnedParent) {
      return {
        ...item,
        ownershipType: 'owned',
      };
    }

    if (hasSubscriptionParent) {
      const primarySub = inheritedPassIds[0] || fallbackSubParentId || undefined;
      return {
        ...item,
        ownershipType: 'subscription',
        satisfiedByProductId: primarySub,
        satisfiedByPassIds: inheritedPassIds,
      };
    }

    if (hasMissingParent) {
      // If parent wasn't returned in the entitlement map, keep direct item classification
      return item;
    }

    return { include: false };
  };

  function resolveProductIdOwnership(productId, visited = new Set()) {
    if (visited.size === 0 && resolvedMemo.has(productId)) {
      return resolvedMemo.get(productId);
    }

    const merged = classifiedById.get(productId);
    if (!merged) {
      return { include: false };
    }
    if (!merged.include) {
      const out = { include: false, reason: merged.reason, productId };
      if (visited.size === 0) resolvedMemo.set(productId, out);
      return out;
    }

    const rows = classifiedRowsById.get(productId) || [merged];
    let winningOwned = null;
    const subscriptionRows = [];

    for (const row of rows) {
      if (!row || !row.include) continue;
      const resolvedRow = resolveInheritedOwnership(row, visited);
      if (!resolvedRow.include) continue;
      if (resolvedRow.ownershipType === 'owned') {
        const isDirect = !row.parentIds || row.parentIds.length === 0;
        if (!winningOwned || (isDirect && winningOwned.parentIds?.length > 0)) {
          winningOwned = resolvedRow;
        }
      } else if (resolvedRow.ownershipType === 'subscription') {
        subscriptionRows.push(resolvedRow);
      }
    }

    let finalResolved;
    if (winningOwned) {
      finalResolved = winningOwned;
    } else if (subscriptionRows.length > 0) {
      const unionedPassIds = [];
      for (const subRow of subscriptionRows) {
        for (const pid of subRow.satisfiedByPassIds || []) {
          if (pid && !unionedPassIds.includes(pid)) {
            unionedPassIds.push(pid);
          }
        }
        if (
          subRow.satisfiedByProductId &&
          isXboxPassProductId(subRow.satisfiedByProductId) &&
          !unionedPassIds.includes(subRow.satisfiedByProductId)
        ) {
          unionedPassIds.push(subRow.satisfiedByProductId);
        }
      }
      const primary = subscriptionRows[0];
      finalResolved = {
        ...primary,
        ownershipType: 'subscription',
        satisfiedByPassIds: unionedPassIds,
        satisfiedByProductId: unionedPassIds[0] || primary.satisfiedByProductId || undefined,
      };
    } else {
      finalResolved = { include: false, productId };
    }

    if (visited.size === 0) {
      resolvedMemo.set(productId, finalResolved);
    }
    return finalResolved;
  }

  const ownedProductIds = new Set();
  const ownedSkuByProduct = new Map();
  const subscriptionSatisfiedIds = new Map(); // productId -> Set<passId>

  for (const productId of classifiedById.keys()) {
    const resolved = resolveProductIdOwnership(productId);
    if (!resolved.include) continue;
    if (resolved.ownershipType === 'owned') {
      ownedProductIds.add(resolved.productId);
      if (!ownedSkuByProduct.has(resolved.productId)) {
        ownedSkuByProduct.set(resolved.productId, resolved.skuId);
      }
    } else if (resolved.ownershipType === 'subscription') {
      const set = subscriptionSatisfiedIds.get(resolved.productId) || new Set();
      for (const passId of resolved.satisfiedByPassIds || []) {
        if (passId) set.add(passId);
      }
      if (resolved.satisfiedByProductId) {
        set.add(resolved.satisfiedByProductId);
      }
      subscriptionSatisfiedIds.set(resolved.productId, set);
    }
  }

  return {
    ownedProductIds,
    ownedSkuByProduct,
    subscriptionSatisfiedIds,
    totalRawCount: rawEntitlements.length,
  };
}

// ============================================================================
// 5. SIGL v2 Catalog Feeds (`catalog.gamepass.com/sigls/v2`)
// ============================================================================

async function fetchSingleSiglFeed(siglId, options = {}) {
  const defaults = resolveDefaultXboxLocaleAndMarket(options);
  const {
    market = defaults.market,
    language = defaults.locale.toLowerCase(),
    cacheStore,
    forceNetwork = false,
  } = options;
  const fetchImpl = resolveFetchImpl(options);
  const mkt = String(market || 'US').toUpperCase();
  const lang = String(language || 'en-us').toLowerCase();
  const cacheKey = `${siglId}:${mkt}:${lang}`;

  const cached = cacheStore ? cacheStore.getSigl(cacheKey) : null;
  if (
    !forceNetwork &&
    cached &&
    Array.isArray(cached.ids) &&
    Date.now() - cached.fetchedAt < SIGL_FRESH_SKIP_NETWORK_MS
  ) {
    return cached.ids;
  }

  if (typeof fetchImpl !== 'function') {
    return cached?.ids || [];
  }

  const url = `${GAMEPASS_SIGL_V2_URL}?id=${encodeURIComponent(siglId)}&language=${encodeURIComponent(lang)}&market=${encodeURIComponent(mkt)}`;
  const headers = { Accept: 'application/json' };
  if (cached?.etag) {
    headers['If-None-Match'] = cached.etag;
  }

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: buildXboxFetchSignal(options.signal),
    });
    if (res.status === 304 && cached?.ids) {
      cacheStore?.setSigl(cacheKey, { ...cached, fetchedAt: Date.now() });
      return cached.ids;
    }
    if (!res.ok) {
      return cached?.ids || [];
    }
    const text = await res.text();
    const sha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    const etag = (typeof res.headers?.get === 'function' ? res.headers.get('etag') : '') || '';

    const parsed = JSON.parse(text);
    const ids = [];
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        // Index 0 is sigl metadata header (`{ siglId, title, ... }`), subsequent elements have `{ id: "9N..." }`
        const id = typeof entry?.id === 'string' ? entry.id.trim().toUpperCase() : '';
        if (id && /^[A-Z0-9]{12}$/.test(id)) {
          ids.push(id);
        }
      }
    }

    const deduped = Array.from(new Set(ids));
    cacheStore?.setSigl(cacheKey, {
      etag,
      sha256,
      ids: deduped,
      fetchedAt: Date.now(),
    });
    return deduped;
  } catch {
    return cached?.ids || [];
  }
}

/**
 * Resolves the exact set of PC-eligible Game Pass `BigId`s for the user's active subscription tier,
 * plus `leavingSoonSet` and `recentlyAddedSet` decorators.
 */
async function fetchActiveTierSiglSets(subscription, entitlementData, options = {}) {
  const activePcSiglSet = new Set();
  const leavingSoonSet = new Set();
  const recentlyAddedSet = new Set();

  if (!subscription?.hasActiveSubscription || !subscription?.hasPcCatalogAccess) {
    return { activePcSiglSet, leavingSoonSet, recentlyAddedSet };
  }

  const mode = subscription.siglMode || 'none';

  const [allPcIds, eaPlayPcIds, leavingIds, recentIds] = await Promise.all([
    mode === 'ea_play_only'
      ? Promise.resolve([])
      : fetchSingleSiglFeed(GAMEPASS_SIGL_IDS.ALL_PC, options),
    subscription.includesEaPlayPc || mode === 'ea_play_only'
      ? fetchSingleSiglFeed(GAMEPASS_SIGL_IDS.EA_PLAY_PC, options)
      : Promise.resolve([]),
    fetchSingleSiglFeed(GAMEPASS_SIGL_IDS.LEAVING_SOON, options),
    fetchSingleSiglFeed(GAMEPASS_SIGL_IDS.RECENTLY_ADDED_PC, options),
  ]);

  const allPcSet = new Set(allPcIds);

  if (mode === 'all_pc_plus_ea' || mode === 'all_pc_only') {
    for (const id of allPcIds) activePcSiglSet.add(id);
    if (mode === 'all_pc_plus_ea') {
      for (const id of eaPlayPcIds) activePcSiglSet.add(id);
    }
  } else if (mode === 'ea_play_only') {
    for (const id of eaPlayPcIds) activePcSiglSet.add(id);
  } else if (mode === 'premium_pc_intersection') {
    const premiumIds = await fetchSingleSiglFeed(GAMEPASS_SIGL_IDS.PREMIUM, options);
    for (const id of premiumIds) {
      // Intersect with All PC SIGL when populated so Console-only Premium games don't pollute hydrate batches
      if (allPcSet.size === 0 || allPcSet.has(id)) {
        activePcSiglSet.add(id);
      }
    }
  } else if (mode === 'essential_pc') {
    const dynIds = Array.isArray(subscription.dynamicSiglIds) ? subscription.dynamicSiglIds : [];
    for (const dynSigl of dynIds) {
      const ids = await fetchSingleSiglFeed(dynSigl, options);
      for (const id of ids) {
        if (allPcSet.size === 0 || allPcSet.has(id)) {
          activePcSiglSet.add(id);
        }
      }
    }
    // Also admit any PC entitlement explicitly satisfied by Essential (`CFQ7TTC0K5DJ`)
    if (entitlementData?.subscriptionSatisfiedIds) {
      for (const [prodId, passSet] of entitlementData.subscriptionSatisfiedIds.entries()) {
        if (passSet.has('CFQ7TTC0K5DJ') && (allPcSet.size === 0 || allPcSet.has(prodId))) {
          activePcSiglSet.add(prodId);
        }
      }
    }
  }

  for (const id of leavingIds) leavingSoonSet.add(id);
  for (const id of recentIds) recentlyAddedSet.add(id);

  return { activePcSiglSet, leavingSoonSet, recentlyAddedSet };
}

// ============================================================================
// 6. DisplayCatalog Batch Hydration, Recursive `BundledSkus` BFS & 5-Gate Filter
// ============================================================================

async function hydrateDisplayCatalogProducts(bigIds, options = {}) {
  const defaults = resolveDefaultXboxLocaleAndMarket(options);
  const {
    market = defaults.market,
    languages = `${defaults.locale},neutral`,
    cacheStore,
  } = options;
  const fetchImpl = resolveFetchImpl(options);

  const uniqueIds = Array.from(
    new Set(
      (bigIds || [])
        .map((id) => String(id || '').trim().toUpperCase())
        .filter((id) => /^[A-Z0-9]{12}$/.test(id))
    )
  );

  const hydratedMap = cacheStore ? cacheStore.getProducts(uniqueIds, market) : new Map();
  const missingIds = uniqueIds.filter((id) => !hydratedMap.has(id));

  if (missingIds.length === 0 || typeof fetchImpl !== 'function') {
    return hydratedMap;
  }

  const newlyFetched = new Map();
  const batches = [];
  for (let i = 0; i < missingIds.length; i += 25) {
    batches.push(missingIds.slice(i, i + 25));
  }

  const CONCURRENCY = 4;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async (batch) => {
        const url = `${DISPLAY_CATALOG_PRODUCTS_URL}?bigIds=${batch.join(',')}&market=${encodeURIComponent(market)}&languages=${encodeURIComponent(languages)}`;
        try {
          const res = await fetchImpl(url, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              'MS-CV': makeCorrelationVector(),
            },
            signal: buildXboxFetchSignal(options.signal),
          });
          if (!res.ok) return;
          const json = await res.json();
          const products = Array.isArray(json?.Products) ? json.Products : [];
          for (const prod of products) {
            const pid = String(prod?.ProductId || '').trim().toUpperCase();
            if (pid) {
              const compact = projectCompactDisplayCatalogProduct(prod);
              hydratedMap.set(pid, compact);
              newlyFetched.set(pid, compact);
            }
          }
        } catch {}
      })
    );
  }

  if (newlyFetched.size > 0 && cacheStore) {
    cacheStore.setProducts(newlyFetched, market);
  }

  return hydratedMap;
}

const lookupDisplayCatalogProducts = hydrateDisplayCatalogProducts;

function normalizeStoreImageUrl(rawUri, querySuffix = '') {
  if (!rawUri || typeof rawUri !== 'string') return '';
  let url = rawUri.trim();
  if (!url) return '';
  if (url.startsWith('//')) {
    url = `https:${url}`;
  } else if (url.startsWith('http://')) {
    url = `https://${url.slice(7)}`;
  }
  if (!/^https:\/\//i.test(url)) return '';
  if (querySuffix && !url.includes('?')) {
    return `${url}${querySuffix}`;
  }
  return url;
}

function normalizeDisplayCatalogMediaUrl(rawUri) {
  if (!rawUri || typeof rawUri !== 'string') return '';
  let url = rawUri.trim();
  if (!url) return '';
  if (url.startsWith('//')) {
    url = `https:${url}`;
  } else if (url.startsWith('http://')) {
    url = `https://${url.slice(7)}`;
  }
  if (!/^https:\/\//i.test(url)) return '';
  return url;
}

function normalizeDisplayCatalogImageUri(rawUri, defaultSizingQuery = '?w=1280&h=720&q=85') {
  const base = normalizeDisplayCatalogMediaUrl(rawUri);
  if (!base) return '';
  if (!defaultSizingQuery) return base;
  try {
    const parsed = new URL(base);
    if (
      parsed.hostname.toLowerCase().endsWith('s-microsoft.com') &&
      !parsed.searchParams.has('w') &&
      !parsed.searchParams.has('h')
    ) {
      const cleanQuery = defaultSizingQuery.replace(/^[?&]/, '');
      return `${base}${base.includes('?') ? '&' : '?'}${cleanQuery}`;
    }
  } catch {}
  return base;
}

/**
 * Extracts official HLS (`.m3u8`) and MP4 trailer streams from Microsoft DisplayCatalog
 * `LocalizedProperties[0].CMSVideos` and `LocalizedProperties[0].Videos`.
 *
 * Sorts `HeroTrailer` first, then `Trailer`, then ascending numeric `SortOrder` (fallback `999`),
 * deduplicating by canonical stream URL and emitting `SteamMovie`-compatible objects.
 */
function extractDisplayCatalogMovies(localProps, fallbackThumbnail = '') {
  if (!localProps || typeof localProps !== 'object') return [];
  const cmsVideos = Array.isArray(localProps.CMSVideos) ? localProps.CMSVideos : [];
  const legacyVideos = Array.isArray(localProps.Videos) ? localProps.Videos : [];
  const combined = [...cmsVideos, ...legacyVideos];
  if (combined.length === 0) return [];

  const candidates = [];
  for (let i = 0; i < combined.length; i++) {
    const v = combined[i];
    if (!v || typeof v !== 'object') continue;

    const rawHls = normalizeDisplayCatalogMediaUrl(v.HLS || v.Hls || '');
    const rawUri = normalizeDisplayCatalogMediaUrl(v.URI || v.Uri || '');

    const hlsUrl = rawHls || (/\.m3u8(?:$|[?#])/i.test(rawUri) ? rawUri : '');
    const mp4Url = /\.mp4(?:$|[?#])/i.test(rawUri) ? rawUri : '';
    if (!hlsUrl && !mp4Url) continue;

    const purposeRaw = String(v.VideoPurpose || v.Purpose || '').trim();
    const purposeLower = purposeRaw.toLowerCase();
    const purposeRank =
      purposeLower === 'herotrailer' ? 0 : purposeLower === 'trailer' ? 1 : 2;
    const numericSort = Number(v.SortOrder);
    const sortOrder = Number.isFinite(numericSort) ? numericSort : 999;

    const thumb =
      normalizeDisplayCatalogImageUri(
        v.PreviewImage?.Uri || v.PreviewImage?.URI || v.Image?.Uri || v.Image?.URI || '',
        '?w=1280&h=720&q=85'
      ) || fallbackThumbnail || '';

    const name =
      String(v.VideoPositionInfo || v.Title || purposeRaw || 'Trailer').trim() || 'Trailer';

    candidates.push({
      originalIdx: i,
      purposeRank,
      sortOrder,
      name,
      thumbnail: thumb,
      hlsUrl,
      mp4Url,
    });
  }

  candidates.sort((a, b) => {
    if (a.purposeRank !== b.purposeRank) return a.purposeRank - b.purposeRank;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.originalIdx - b.originalIdx;
  });

  const seenStreams = new Set();
  const movies = [];
  for (const cand of candidates) {
    const hlsKey = cand.hlsUrl ? cand.hlsUrl.toLowerCase() : '';
    const mp4Key = cand.mp4Url ? cand.mp4Url.toLowerCase() : '';
    if ((hlsKey && seenStreams.has(hlsKey)) || (mp4Key && seenStreams.has(mp4Key))) {
      continue;
    }
    if (hlsKey) seenStreams.add(hlsKey);
    if (mp4Key) seenStreams.add(mp4Key);

    const idx = movies.length;
    movies.push({
      id: 100000 + idx,
      name: cand.name,
      thumbnail: cand.thumbnail,
      ...(cand.hlsUrl ? { hls: cand.hlsUrl } : {}),
      ...(cand.mp4Url ? { mp4: { max: cand.mp4Url, 480: cand.mp4Url } } : {}),
    });
  }

  return movies;
}

const DISPLAY_CATALOG_CAPABILITY_MAP = Object.freeze({
  singleplayer: 'Single-player',
  xblonlinemultiplayer: 'Online PvP / Multiplayer',
  onlinemultiplayerwithgold: 'Online PvP / Multiplayer',
  xblonlinecoop: 'Online Co-op',
  xbllocalcoop: 'Shared/Split Screen Co-op',
  xbllocalmultiplayer: 'Shared/Split Screen PvP',
  xblcrossplatformmultiplayer: 'Cross-Platform Multiplayer',
  xblcrossplatformcoop: 'Cross-Platform Co-op',
  xblachievements: 'Xbox Achievements',
  xblpresence: 'Xbox Achievements',
  xblcloudsaves: 'Xbox Cloud Saves',
  xpa: 'Xbox Play Anywhere',
  pcgamepad: 'Full controller support',
  consolegamepad: 'Full controller support',
  consolekeyboardmouse: 'Keyboard & Mouse Support',
  capability4k: '4K Ultra HD',
  '4kultrahd': '4K Ultra HD',
  capabilityhdr: 'HDR',
  hdr: 'HDR',
  '60fps': 'High Frame Rate',
  '120fps': 'High Frame Rate',
  capabilityvrr: 'Variable Refresh Rate',
  raytracing: 'Ray Tracing',
});

/**
 * Maps Microsoft Store `Properties.Attributes` capability flags (plus `XboxLiveGoldRequired`)
 * into deduplicated `SteamCategory`-compatible `{ id, description }` chips.
 */
function extractDisplayCatalogCategories(product) {
  if (!product || typeof product !== 'object') return [];
  const props = product.Properties || {};
  const attrs = Array.isArray(props.Attributes) ? props.Attributes : [];

  const descriptions = [];
  const seen = new Set();
  const pushLabel = (label) => {
    if (!label || seen.has(label)) return;
    seen.add(label);
    descriptions.push(label);
  };

  for (const attr of attrs) {
    const rawName = typeof attr === 'string' ? attr : attr?.Name;
    if (!rawName || typeof rawName !== 'string') continue;
    const mapped = DISPLAY_CATALOG_CAPABILITY_MAP[rawName.trim().toLowerCase()];
    if (mapped) {
      pushLabel(mapped);
    }
  }

  if (props.XboxLiveGoldRequired === true) {
    pushLabel('Online PvP / Multiplayer');
  }

  return descriptions.map((description, idx) => ({
    id: idx + 1,
    description,
  }));
}

const SAFE_DESCRIPTION_HTML_TAGS = new Set([
  'p',
  'div',
  'span',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'b',
  'i',
  'u',
  'blockquote',
  'code',
  'pre',
  'video',
  'source',
  'img',
  'a',
]);

const VOID_DESCRIPTION_HTML_TAGS = new Set(['br', 'hr', 'img', 'source']);
const SAFE_MEDIA_BOOLEAN_ATTRS = new Set([
  'controls',
  'autoplay',
  'loop',
  'muted',
  'playsinline',
]);
const SAFE_TEXT_ATTRS = new Set(['alt', 'title', 'type', 'preload', 'width', 'height']);

function sanitizeDescriptionTagAttributes(tagLower, rawAttrs, escapeHtml) {
  if (!rawAttrs || !rawAttrs.trim()) return { attrStr: '', hasValidMediaSrc: false };
  const sanitizedPairs = [];
  let hasValidMediaSrc = false;
  const attrRegex = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = attrRegex.exec(rawAttrs)) !== null) {
    const attrName = String(m[1] || '').toLowerCase();
    if (!attrName || attrName.startsWith('on') || attrName === 'style' || attrName === 'srcdoc') {
      continue;
    }
    const rawVal = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : null;
    if (attrName === 'class') {
      if (rawVal !== null && /^[a-zA-Z0-9_\-\s]+$/.test(rawVal)) {
        sanitizedPairs.push(`class="${escapeHtml(rawVal)}"`);
      }
      continue;
    }
    if (attrName === 'src' || attrName === 'poster' || attrName === 'href') {
      if (rawVal !== null) {
        try {
          const parsed = new URL(rawVal.trim());
          if (parsed.protocol === 'https:') {
            sanitizedPairs.push(`${attrName}="${escapeHtml(rawVal.trim())}"`);
            if (attrName === 'src') hasValidMediaSrc = true;
          }
        } catch {}
      }
      continue;
    }
    if (SAFE_MEDIA_BOOLEAN_ATTRS.has(attrName) && (tagLower === 'video' || tagLower === 'source')) {
      sanitizedPairs.push(attrName);
      continue;
    }
    if (SAFE_TEXT_ATTRS.has(attrName) && rawVal !== null && rawVal.length <= 200) {
      sanitizedPairs.push(`${attrName}="${escapeHtml(rawVal)}"`);
    }
  }
  return {
    attrStr: sanitizedPairs.length > 0 ? ` ${sanitizedPairs.join(' ')}` : '',
    hasValidMediaSrc,
  };
}

/**
 * Formats plain-text Microsoft Store `ProductDescription` synopses into clean semantic HTML
 * while strictly sanitizing pre-existing HTML descriptions against XSS (`<script>`, `<img onerror>`, etc.).
 */
function formatPlainDescriptionToHtml(text) {
  if (!text || typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';

  const escapeHtml = (str) =>
    String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  if (
    /<\/?(?:p|div|span|br|hr|h[1-6]|ul|ol|li|strong|em|b|i|u|blockquote|code|pre|img|video|source|a|script|style|iframe|svg|object|embed|form|math)\b/i.test(
      trimmed
    )
  ) {
    // Strip dangerous container elements (and any unclosed script/style/iframe blocks) first
    const withoutDangerousBlocks = trimmed
      .replace(/<(script|style|iframe|object|svg|math|form)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(script|style|iframe|object|svg|math|form)\b[\s\S]*$/gi, '');

    const tagRegex = /<(\/?)([a-zA-Z0-9]+)(\s[^<>]*?)?(\/?)>/g;
    let out = '';
    let lastIndex = 0;
    let match;
    while ((match = tagRegex.exec(withoutDangerousBlocks)) !== null) {
      if (match.index > lastIndex) {
        out += escapeHtml(withoutDangerousBlocks.slice(lastIndex, match.index));
      }
      lastIndex = tagRegex.lastIndex;
      const isClosing = Boolean(match[1]);
      const tagLower = String(match[2] || '').toLowerCase();
      const rawAttrs = String(match[3] || '');
      const isSelfClosing = Boolean(match[4]);
      if (!SAFE_DESCRIPTION_HTML_TAGS.has(tagLower)) {
        continue;
      }
      if (isClosing) {
        if (!VOID_DESCRIPTION_HTML_TAGS.has(tagLower)) {
          out += `</${tagLower}>`;
        }
        continue;
      }
      if (tagLower === 'br') {
        out += isSelfClosing ? '<br />' : '<br>';
        continue;
      }
      const { attrStr, hasValidMediaSrc } = sanitizeDescriptionTagAttributes(
        tagLower,
        rawAttrs,
        escapeHtml
      );
      if ((tagLower === 'img' || tagLower === 'source') && !hasValidMediaSrc) {
        continue;
      }
      if (VOID_DESCRIPTION_HTML_TAGS.has(tagLower)) {
        out += isSelfClosing ? `<${tagLower}${attrStr} />` : `<${tagLower}${attrStr}>`;
      } else {
        out += `<${tagLower}${attrStr}>`;
      }
    }
    if (lastIndex < withoutDangerousBlocks.length) {
      out += escapeHtml(withoutDangerousBlocks.slice(lastIndex));
    }
    return out.trim();
  }

  const isFeatureHeadingLine = (line) =>
    line.length >= 3 &&
    line.length <= 60 &&
    /[A-Z]{2}/.test(line) &&
    line === line.toUpperCase() &&
    !/[.:]$/.test(line);

  const rawBlocks = trimmed
    .split(/\r?\n\s*\r?\n+/)
    .map((b) => b.trim())
    .filter(Boolean);

  const htmlBlocks = [];
  for (let bIdx = 0; bIdx < rawBlocks.length; bIdx++) {
    const lines = rawBlocks[bIdx]
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;

    if (lines.every((l) => /^[-*•·]\s+/.test(l))) {
      const items = lines
        .map((l) => `<li>${escapeHtml(l.replace(/^[-*•·]\s+/, '').trim())}</li>`)
        .join('');
      htmlBlocks.push(`<ul>${items}</ul>`);
      continue;
    }

    if (lines.length === 1 && bIdx < rawBlocks.length - 1 && isFeatureHeadingLine(lines[0])) {
      htmlBlocks.push(`<h3 class="bb_tag">${escapeHtml(lines[0])}</h3>`);
      continue;
    }

    if (lines.length >= 2 && isFeatureHeadingLine(lines[0])) {
      const heading = `<h3 class="bb_tag">${escapeHtml(lines[0])}</h3>`;
      const bodyLines = lines.slice(1);
      if (bodyLines.every((l) => /^[-*•·]\s+/.test(l))) {
        const items = bodyLines
          .map((l) => `<li>${escapeHtml(l.replace(/^[-*•·]\s+/, '').trim())}</li>`)
          .join('');
        htmlBlocks.push(`${heading}\n<ul>${items}</ul>`);
      } else {
        htmlBlocks.push(`${heading}\n<p>${bodyLines.map(escapeHtml).join('<br />')}</p>`);
      }
      continue;
    }

    htmlBlocks.push(`<p>${lines.map(escapeHtml).join('<br />')}</p>`);
  }

  return htmlBlocks.join('\n');
}

/**
 * Sanitizes DisplayCatalog ISO release dates, rejecting empty/invalid timestamps and universal
 * storefront sentinel dates (`0001-01-01`, `1753-01-01`, `2099-*`, `2799-12-31`, `2999-*`, `9998-*`, `9999-*`)
 * where `year < 1975` or `year > currentUTCYear + 10`.
 */
function sanitizeDisplayCatalogReleaseDate(rawDate) {
  if (!rawDate || typeof rawDate !== 'string') return '';
  const trimmed = rawDate.trim();
  if (!trimmed) return '';

  const maxYear = new Date().getUTCFullYear() + 10;
  const isoPrefix = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoPrefix) {
    const year = Number(isoPrefix[1]);
    const month = Number(isoPrefix[2]);
    const day = Number(isoPrefix[3]);
    if (
      !Number.isFinite(year) ||
      year < 1975 ||
      year > maxYear ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > 31
    ) {
      return '';
    }
    const utcCheck = new Date(Date.UTC(year, month - 1, day));
    if (
      Number.isNaN(utcCheck.getTime()) ||
      utcCheck.getUTCFullYear() !== year ||
      utcCheck.getUTCMonth() !== month - 1 ||
      utcCheck.getUTCDate() !== day
    ) {
      return '';
    }
    return `${isoPrefix[1]}-${isoPrefix[2]}-${isoPrefix[3]}`;
  }

  const parsedMs = Date.parse(trimmed);
  if (Number.isNaN(parsedMs)) return '';
  const dt = new Date(parsedMs);
  const year = dt.getUTCFullYear();
  if (year < 1975 || year > maxYear) return '';
  return dt.toISOString().slice(0, 10);
}

function detectThirdPartyPfnHandoff(pfn, publisherName = '', hasStandaloneMsixvc = false) {
  const lowerPfn = String(pfn || '').trim().toLowerCase();
  if (lowerPfn) {
    for (const rule of THIRD_PARTY_PFN_PUBLISHERS) {
      if (lowerPfn.endsWith(rule.suffix)) {
        return rule.handoff;
      }
    }
  }
  const pubLower = String(publisherName || '').toLowerCase();
  if (
    !hasStandaloneMsixvc &&
    (pubLower.includes('electronic arts') || lowerPfn.startsWith('electronicarts.'))
  ) {
    return 'ea';
  }
  return undefined;
}

function isDesktopEligiblePackage(pkg) {
  if (!pkg || typeof pkg !== 'object') return false;
  const format = String(pkg.PackageFormat || '').trim().toLowerCase();
  // Explicitly reject Xbox Console XVC and legacy Xbox 360 Xap packages
  if (format === 'xvc' || format === 'xap') {
    return false;
  }

  const deps = Array.isArray(pkg.PlatformDependencies) ? pkg.PlatformDependencies : [];
  const platformNames = deps
    .map((d) => String(d?.PlatformName || d || '').trim())
    .filter(Boolean);

  const hasWindowsDesktop = platformNames.includes('Windows.Desktop');
  const hasWindowsUniversal = platformNames.includes('Windows.Universal');
  const isXboxConsoleOnly =
    platformNames.length > 0 && platformNames.every((n) => n === 'Windows.Xbox' || n === 'Xbox');

  if (isXboxConsoleOnly) return false;
  if (hasWindowsDesktop) return true;

  if (hasWindowsUniversal) {
    const validUwpFormats = ['msixvc', 'appxbundle', 'msixbundle', 'appx', 'msix'];
    const archs = (Array.isArray(pkg.Architectures) ? pkg.Architectures : []).map((a) =>
      String(a || '').toLowerCase()
    );
    const validArch =
      archs.length === 0 ||
      archs.some((a) => ['x64', 'x86', 'arm64', 'neutral'].includes(a));
    return validUwpFormats.includes(format) && validArch;
  }

  return false;
}

const NATURAL_PC_PREDECESSOR_RE =
  /(?:^|\s)(?:my|your|our|the|his|her|its|a|an|this|that|new|old|custom|virtual|retro|mini|pocket|super|dream|ultimate|gaming|home|office|build\s+a)\s+pc$/i;
const NATURAL_WINDOWS_PREDECESSOR_RE =
  /(?:^|\s)(?:the|of|in|into|through|behind|between|beyond|under|over|from|with|without|two|three|four|many|broken|stained|open|closed|shattered|dark|rear|glass)\s+windows$/i;

/**
 * Strips Microsoft Store / Xbox PC platform disambiguators (e.g. "(PC)", "- PC", ": PC",
 * "for PC", "(Windows)", "- Windows", "for Windows", "Windows 10 Edition", "PC Edition",
 * "Diablo IV PC", "Dead by Daylight Windows", "(Game Preview)") so Xbox PC game titles
 * display cleanly and merge canonically with Steam, GOG, and Epic titles.
 *
 * @param {string} rawTitle
 * @returns {string}
 */
function stripXboxPlatformDisambiguators(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') return '';
  let cur = rawTitle.replace(/\s+/g, ' ').trim();
  for (let pass = 0; pass < 3; pass++) {
    const prev = cur;
    cur = cur
      .replace(
        /\s*[\(\[]\s*(?:pc(?:\s*(?:&|and)\s*(?:console|xbox))?|console\s*(?:&|and)\s*pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11|xbox(?:\s+pc|\s+one(?:\s*(?:&|and)\s*xbox\s+series\s+x\s*[\|\/]\s*s)?|\s+series\s+x\s*[\|\/]\s*s|\s+play\s+anywhere|\s*(?:&|and)\s*pc)?|microsoft\s+store|game\s+preview|(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11)\s+(?:edition|version))\s*[\)\]]/gi,
        ''
      )
      .replace(
        /([\(\[][^\)\]]+?)\s*[:\-–—]\s*(?:pc|windows(?:\s*10|\s*11)?(?:\s+version)?|win\s*10|win\s*11|xbox(?:\s+series\s+x\s*[\|\/]\s*s)?)\s*([\)\]])/gi,
        '$1$2'
      )
      .replace(
        /(?:\s*[:\-–—]\s*|\s+for\s+)(?:pc(?:\s*(?:&|and)\s*(?:console|xbox))?|console\s*(?:&|and)\s*pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11|microsoft\s+store|xbox(?:\s+pc|\s+one|\s+series\s+x\s*[\|\/]\s*s)?)(?:\s+(?:edition|version))?\s*$/gi,
        ''
      )
      .replace(
        /(?:[:\-–—]\s*|\s+)(?:pc|windows(?:\s*10|\s*11)?|win\s*10|win\s*11)\s+(?:edition|version)\s*$/gi,
        ''
      )
      .replace(/(?:[:\-–—]\s*|\s+)xbox\s+series\s+x\s*[\|\/]\s*s\s*$/gi, '')
      .replace(/(?:[:\-–—]\s*|\s+)game\s+preview\s*$/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (/\s+pc$/i.test(cur) && !NATURAL_PC_PREDECESSOR_RE.test(cur)) {
      const withoutTrailingPc = cur.replace(/\s+pc$/i, '').trim();
      if (withoutTrailingPc.length >= 2) {
        cur = withoutTrailingPc;
      }
    }

    if (/\s+windows(?:\s*10|\s*11)?$/i.test(cur) && !NATURAL_WINDOWS_PREDECESSOR_RE.test(cur)) {
      const withoutTrailingWin = cur.replace(/\s+windows(?:\s*10|\s*11)?$/i, '').trim();
      if (withoutTrailingWin.length >= 2) {
        cur = withoutTrailingWin;
      }
    }

    if (cur === prev) break;
  }
  return cur || rawTitle.trim();
}

/**
 * Deterministically derives the canonical Xbox Live `SCID`
 * (`00000000-0000-0000-0000-0000<8-hex-titleId>`) from a `TitleId`.
 *
 * - `MicrosoftGame.config` `<TitleId>` XML elements, leading-zero 8-char hex strings, `0x`-prefixed
 *   strings, strings with `[a-fA-F]`, or calls with `{ preferHex: true | format: 'hex' | source: 'msgameconfig' }`
 *   are parsed strictly as base-16 hexadecimal (`parseInt(cleanHex, 16) >>> 0`).
 * - Store DisplayCatalog / TitleHub numeric `XboxTitleId` / `modernTitleId` integers are parsed as base-10 decimal.
 *
 * @param {string | number | bigint | null | undefined} rawTitleId
 * @param {{ preferHex?: boolean, isHex?: boolean, format?: string, source?: string } | string} [options]
 * @returns {string}
 */
function deriveDefaultScidFromTitleId(rawTitleId, options = undefined) {
  if (rawTitleId === null || rawTitleId === undefined) return '';

  if (
    options &&
    xboxConfigAndIds &&
    typeof xboxConfigAndIds.deriveDefaultScidFromTitleId === 'function'
  ) {
    try {
      const delegated = xboxConfigAndIds.deriveDefaultScidFromTitleId(rawTitleId, options);
      if (delegated) return delegated;
    } catch {}
  }

  let str = String(rawTitleId).trim();
  if (!str) return '';

  let forceHex =
    options === 'hex' ||
    Boolean(
      options &&
        typeof options === 'object' &&
        (options.preferHex === true ||
          options.isHex === true ||
          String(options.format || '').toLowerCase() === 'hex' ||
          String(options.source || '').toLowerCase() === 'msgameconfig')
    );

  // Extract inner value if caller passed raw `<TitleId>...</TitleId>` XML from `MicrosoftGame.config`
  const xmlMatch = str.match(/<TitleId>\s*([0-9a-fA-FxX]+)\s*<\/TitleId>/i);
  if (xmlMatch) {
    str = xmlMatch[1].trim();
    forceHex = true;
  }

  let num;
  try {
    if (typeof rawTitleId === 'number' || typeof rawTitleId === 'bigint') {
      if (forceHex && typeof rawTitleId === 'number' && Number.isInteger(rawTitleId)) {
        num = BigInt(rawTitleId >>> 0);
      } else {
        num = BigInt(rawTitleId);
      }
    } else if (forceHex) {
      const cleanHex = str.replace(/^0x/i, '');
      if (!/^[0-9a-f]{1,8}$/i.test(cleanHex)) return '';
      num = BigInt((parseInt(cleanHex, 16) >>> 0));
    } else if (/^0x[0-9a-f]+$/i.test(str)) {
      num = BigInt(str);
    } else if (/^0[0-9a-f]{1,7}$/i.test(str)) {
      // Decimal integers never start with a leading zero; zero-padded TitleIds are hex
      num = BigInt((parseInt(str, 16) >>> 0));
    } else if (/^[0-9]+$/.test(str)) {
      num = BigInt(str);
    } else if (/^[0-9a-f]{1,8}$/i.test(str)) {
      num = BigInt((parseInt(str, 16) >>> 0));
    } else {
      return '';
    }
  } catch {
    return '';
  }

  if (num <= 0n || num > 0xffffffffn) return '';
  const hex8 = num.toString(16).toLowerCase().padStart(8, '0');
  return `00000000-0000-0000-0000-0000${hex8}`;
}

function selectPreferredLocalizedEntry(localizedList) {
  if (!Array.isArray(localizedList) || localizedList.length === 0) return {};
  const validEntries = localizedList.filter((l) => l && typeof l === 'object');
  if (validEntries.length === 0) return {};

  const primary = validEntries[0];
  const base =
    validEntries.find((l) => typeof l.ProductTitle === 'string' && l.ProductTitle.trim()) ||
    primary;
  if (validEntries.length === 1) return base;

  const baseImages = Array.isArray(base.Images) ? base.Images : [];
  const basePurposes = new Set();
  const seenImageUris = new Set();
  for (const img of baseImages) {
    if (!img || !img.Uri) continue;
    seenImageUris.add(String(img.Uri));
    const p = String(img.ImagePurpose || '').trim().toLowerCase();
    if (p) basePurposes.add(p);
  }

  let mergedImages = baseImages;
  for (const entry of validEntries) {
    if (entry === base || !Array.isArray(entry.Images) || entry.Images.length === 0) continue;
    for (const img of entry.Images) {
      if (!img || !img.Uri) continue;
      const uriStr = String(img.Uri);
      const purposeLower = String(img.ImagePurpose || '').trim().toLowerCase();
      if (!basePurposes.has(purposeLower) && !seenImageUris.has(uriStr)) {
        if (mergedImages === baseImages) {
          mergedImages = [...baseImages];
        }
        seenImageUris.add(uriStr);
        mergedImages.push(img);
      }
    }
  }

  const withShortDesc = !base.ShortDescription
    ? validEntries.find((l) => typeof l.ShortDescription === 'string' && l.ShortDescription.trim())
    : null;
  const withProdDesc = !base.ProductDescription
    ? validEntries.find(
        (l) => typeof l.ProductDescription === 'string' && l.ProductDescription.trim()
      )
    : null;
  const withDev = !base.DeveloperName
    ? validEntries.find((l) => typeof l.DeveloperName === 'string' && l.DeveloperName.trim())
    : null;
  const withPub = !base.PublisherName
    ? validEntries.find((l) => typeof l.PublisherName === 'string' && l.PublisherName.trim())
    : null;
  const withCmsVideos =
    !Array.isArray(base.CMSVideos) || base.CMSVideos.length === 0
      ? validEntries.find((l) => Array.isArray(l.CMSVideos) && l.CMSVideos.length > 0)
      : null;
  const withLegacyVideos =
    !Array.isArray(base.Videos) || base.Videos.length === 0
      ? validEntries.find((l) => Array.isArray(l.Videos) && l.Videos.length > 0)
      : null;

  if (
    mergedImages === baseImages &&
    !withShortDesc &&
    !withProdDesc &&
    !withDev &&
    !withPub &&
    !withCmsVideos &&
    !withLegacyVideos
  ) {
    return base;
  }

  return {
    ...base,
    ...(withShortDesc ? { ShortDescription: withShortDesc.ShortDescription } : {}),
    ...(withProdDesc ? { ProductDescription: withProdDesc.ProductDescription } : {}),
    ...(withDev ? { DeveloperName: withDev.DeveloperName } : {}),
    ...(withPub ? { PublisherName: withPub.PublisherName } : {}),
    ...(mergedImages !== baseImages ? { Images: mergedImages } : {}),
    ...(withCmsVideos ? { CMSVideos: withCmsVideos.CMSVideos } : {}),
    ...(withLegacyVideos ? { Videos: withLegacyVideos.Videos } : {}),
  };
}

/**
 * Evaluates a DisplayCatalog `Product` object through the **5-Gate Structural Filter**:
 * - Gate 1: `ProductKind` / `ProductType === 'Game'`
 * - Gate 2: PC (`Windows.Desktop` / desktop `Windows.Universal`) or structurally verified cross-platform
 *           launcher runtime edition, strictly rejecting Console-only (`Windows.Xbox` / `XVC` / `Xap`) games!
 * - Gate 3: 3rd-party PC storefront PFN handoff detection (`ubisoft`, `bnet`, `riot`, `ea`)
 * - Gate 4: Pure bundle wrapper detection (`BundledSkus` expansion)
 * - Gate 5: `classifyNonGameStorefrontItem` (DLCs, soundtracks, artbooks, companion apps, test branches)
 */
function evaluateDisplayCatalogProduct(product, evalOptions = {}) {
  if (!product || typeof product !== 'object') {
    return { eligible: false, gate: 'invalid_product', reason: 'Empty DisplayCatalog product' };
  }

  const productId = String(product.ProductId || '').trim().toUpperCase();
  const localized = selectPreferredLocalizedEntry(product.LocalizedProperties);
  const marketProps =
    (Array.isArray(product.MarketProperties) && product.MarketProperties[0]) || {};
  const props = product.Properties || {};

  const title = String(localized.ProductTitle || product.ProductTitle || '').trim();
  const productKind = String(product.ProductKind || product.ProductType || '').trim();
  const kindLower = productKind.toLowerCase();

  // Gate 1: Must be `Game`
  if (kindLower !== 'game') {
    return {
      eligible: false,
      gate: 'gate1_product_kind',
      reason: `Non-game ProductKind: ${productKind || 'Unknown'}`,
      productId,
      title,
    };
  }

  if (props.IsDemoOrTrial === true) {
    return {
      eligible: false,
      gate: 'gate1_demo_or_trial',
      reason: 'Filtered: Demo or Trial SKU',
      productId,
      title,
    };
  }

  // Inspect SKUs, BundledSkus, AllowedPlatforms, and Packages
  const skuAvailabilities = Array.isArray(product.DisplaySkuAvailabilities)
    ? product.DisplaySkuAvailabilities
    : [];

  const desktopPackages = [];
  const allPackages = [];
  const bundledSkus = [];
  const allowedPlatformsLower = new Set();
  let fulfillmentData = null;
  let selectedSkuId = '0010';

  for (const avail of skuAvailabilities) {
    const sku = avail?.Sku;
    if (!sku) continue;
    const skuProps = sku.Properties || {};
    if (skuProps.IsTrial === true) continue;
    if (sku.SkuId && selectedSkuId === '0010') {
      selectedSkuId = String(sku.SkuId);
    }
    if (!fulfillmentData && skuProps.FulfillmentData) {
      fulfillmentData = skuProps.FulfillmentData;
    }
    if (Array.isArray(avail?.Availabilities)) {
      for (const av of avail.Availabilities) {
        const allowed = av?.Conditions?.ClientConditions?.AllowedPlatforms;
        if (Array.isArray(allowed)) {
          for (const ap of allowed) {
            const pName = String(typeof ap === 'string' ? ap : ap?.PlatformName || '')
              .trim()
              .toLowerCase();
            if (pName) allowedPlatformsLower.add(pName);
          }
        }
      }
    }
    if (Array.isArray(skuProps.BundledSkus)) {
      for (const b of skuProps.BundledSkus) {
        const bId = String(b?.BigId || '').trim().toUpperCase();
        if (bId && /^[A-Z0-9]{12}$/.test(bId) && bId !== productId) {
          bundledSkus.push({
            bigId: bId,
            skuId: String(b?.SkuId || '0010'),
            isPrimary: Boolean(b?.IsPrimary),
          });
        }
      }
    }
    if (Array.isArray(skuProps.Packages)) {
      for (const pkg of skuProps.Packages) {
        allPackages.push({ ...pkg, _skuId: sku.SkuId });
        if (isDesktopEligiblePackage(pkg)) {
          desktopPackages.push({ ...pkg, _skuId: sku.SkuId });
        }
      }
    }
  }

  const pfn = String(
    props.PackageFamilyName ||
      fulfillmentData?.PackageFamilyName ||
      desktopPackages[0]?.PackageFamilyName ||
      ''
  ).trim();

  const developerName = String(localized.DeveloperName || '').trim();
  const publisherName = String(localized.PublisherName || '').trim();

  const hasMsixvcPackage = desktopPackages.some(
    (p) => String(p.PackageFormat || '').toLowerCase() === 'msixvc'
  );
  const externalStorefrontHandoff = detectThirdPartyPfnHandoff(
    pfn,
    publisherName,
    hasMsixvcPackage
  );

  const isConsoleRestrictedAllowedPlatforms =
    allowedPlatformsLower.size > 0 &&
    Array.from(allowedPlatformsLower).every((p) => p === 'windows.xbox' || p === 'xbox');

  const isCrossPlatformLauncherRuntime =
    desktopPackages.length === 0 &&
    bundledSkus.length === 0 &&
    allPackages.length === 0 &&
    !isConsoleRestrictedAllowedPlatforms &&
    (Boolean(product._crossPlatformLauncherRuntime) ||
      Boolean(evalOptions?.crossPlatformRuntimeProductIds?.has?.(productId)) ||
      (Boolean(evalOptions?.crossPlatformRuntimeVerified) &&
        Boolean(evalOptions?.fromDesktopSiblingBundle)) ||
      allowedPlatformsLower.has('macos') ||
      allowedPlatformsLower.has('osx') ||
      allowedPlatformsLower.has('linux') ||
      /\bjava\s+edition\b/i.test(title));

  // Gate 4: Pure bundle wrapper (`Packages: []` with `BundledSkus.length > 0`)
  if (!isCrossPlatformLauncherRuntime && desktopPackages.length === 0 && bundledSkus.length > 0) {
    return {
      eligible: false,
      isBundleWrapper: true,
      bundledSkus,
      selectedSkuId,
      gate: 'gate4_bundle_wrapper',
      reason: 'Bundle wrapper SKU expanded into child base games',
      productId,
      title,
    };
  }

  // Gate 2: PC (`Windows.Desktop` / desktop `Windows.Universal` / 3rd-party PC PFN) or cross-platform desktop/Mac runtime
  const hasThirdPartyPcStub = Boolean(
    externalStorefrontHandoff &&
      allPackages.every((p) => String(p.PackageFormat || '').toLowerCase() !== 'xvc')
  );
  const hasAllowedDesktopWithoutPackages =
    desktopPackages.length === 0 &&
    allPackages.length === 0 &&
    bundledSkus.length === 0 &&
    !isConsoleRestrictedAllowedPlatforms &&
    allowedPlatformsLower.has('windows.desktop');

  if (
    !isCrossPlatformLauncherRuntime &&
    !hasAllowedDesktopWithoutPackages &&
    desktopPackages.length === 0 &&
    !hasThirdPartyPcStub
  ) {
    return {
      eligible: false,
      gate: 'gate2_console_only',
      reason: 'Console-only Xbox title (no Windows.Desktop or Mac package)',
      productId,
      title,
    };
  }

  // Gate 5: Non-game storefront classifier (DLC, soundtrack, artbook, server, tool, beta)
  const genreCategories = Array.isArray(props.Categories) ? [...props.Categories] : [];
  if (props.Category && !genreCategories.includes(props.Category)) {
    genreCategories.push(props.Category);
  }
  const nonGameReason = classifyNonGameStorefrontItem({
    title,
    platformId: 'xbox',
    platformGameId: productId,
    isDlc: false,
    itemType: productKind,
    categories: genreCategories,
  });

  if (nonGameReason) {
    return {
      eligible: false,
      isSuppressedNonGame: true,
      gate: 'gate5_non_game_classifier',
      reason: nonGameReason,
      productId,
      title,
    };
  }

  // Prefer x64 MSIXVC desktop package when multiple exist
  const preferredPkg =
    desktopPackages.find(
      (p) =>
        String(p.PackageFormat || '').toLowerCase() === 'msixvc' &&
        Array.isArray(p.Architectures) &&
        p.Architectures.some((a) => String(a).toLowerCase() === 'x64')
    ) ||
    desktopPackages.find((p) => String(p.PackageFormat || '').toLowerCase() === 'msixvc') ||
    desktopPackages[0] ||
    null;

  // Extract AlternateIds (`ServiceConfigId`, `XboxTitleId`, `MsaAppId`)
  // Prefer explicit `ServiceConfigId` first; fall back to `deriveDefaultScidFromTitleId(xboxTitleId)`.
  let xboxTitleId = '';
  let msaAppId = '';
  let explicitScid = '';
  const scidUuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rawPropScid = String(props.ServiceConfigId || props.Scid || '').trim();
  if (scidUuidRe.test(rawPropScid)) {
    explicitScid = rawPropScid.toLowerCase();
  }
  for (const alt of Array.isArray(product.AlternateIds) ? product.AlternateIds : []) {
    const idType = String(alt?.IdType || '').trim().toLowerCase();
    const val = String(alt?.Value || '').trim();
    if (!val) continue;
    if ((idType === 'serviceconfigid' || idType === 'scid') && !explicitScid && scidUuidRe.test(val)) {
      explicitScid = val.toLowerCase();
    } else if (idType === 'xboxtitleid' && !xboxTitleId) {
      if (/^0x[0-9a-f]+$/i.test(val)) {
        xboxTitleId = BigInt(val).toString(10);
      } else if (/^[0-9]+$/.test(val)) {
        xboxTitleId = val;
      } else if (/^[0-9a-f]+$/i.test(val)) {
        xboxTitleId = BigInt(`0x${val}`).toString(10);
      } else {
        xboxTitleId = val;
      }
    } else if ((idType === 'msaappid' || idType === 'appid') && !msaAppId) {
      msaAppId = val;
    }
  }
  const scid = explicitScid || deriveDefaultScidFromTitleId(xboxTitleId);

  // Extract Artwork (`Poster` 2:3, `SuperHeroArt`/`TitledHeroArt` 16:9, `BoxArt` 1:1, `Logo`, `Screenshot[]`)
  const images = Array.isArray(localized.Images) ? localized.Images : [];
  const findImageByPurpose = (purposes, suffix = '') => {
    for (const purpose of purposes) {
      const hit = images.find(
        (img) =>
          img &&
          String(img.ImagePurpose || '').toLowerCase() === purpose.toLowerCase() &&
          img.Uri
      );
      if (hit) {
        const u = normalizeStoreImageUrl(hit.Uri, suffix);
        if (u) return u;
      }
    }
    return '';
  };

  const capsuleImage = findImageByPurpose(['Poster'], '?w=600&h=900&q=90&mode=scale');
  const headerImage =
    findImageByPurpose(['SuperHeroArt', 'TitledHeroArt', 'FeaturePromotionalSquareArt'], '?w=1920&h=1080&q=90') ||
    capsuleImage;
  const iconUrl =
    findImageByPurpose(['BoxArt', 'Tile', 'AppIcon'], '?w=256&h=256&q=90') || capsuleImage;
  const logoUrl = findImageByPurpose(['Logo'], '?w=600&q=90');

  const screenshots = images
    .filter((img) => String(img?.ImagePurpose || '').toLowerCase() === 'screenshot' && img.Uri)
    .slice(0, 12)
    .map((img) => normalizeStoreImageUrl(img.Uri, '?w=1920&h=1080&q=85'))
    .filter(Boolean);

  const movies = extractDisplayCatalogMovies(
    localized,
    headerImage || screenshots[0] || capsuleImage || ''
  );
  const storeCategories = extractDisplayCatalogCategories(product);

  // Extract 5-star UsageData rating -> AllTime first, then highest RatingCount
  let averageRating;
  let rating100;
  let ratingCount = 0;
  if (Array.isArray(marketProps.UsageData) && marketProps.UsageData.length > 0) {
    const validUsage = marketProps.UsageData.filter(
      (u) => u && Number(u.RatingCount || 0) > 0 && Number(u.AverageRating || 0) > 0
    );
    const allTime = validUsage.find(
      (u) => String(u.AggregateTimeSpan || '').toLowerCase() === 'alltime'
    );
    const bestUsage =
      allTime ||
      validUsage
        .slice()
        .sort((a, b) => Number(b.RatingCount || 0) - Number(a.RatingCount || 0))[0] ||
      null;
    if (bestUsage) {
      ratingCount = Math.max(0, Math.floor(Number(bestUsage.RatingCount || 0)));
      averageRating = Math.round(Number(bestUsage.AverageRating) * 100) / 100;
      if (ratingCount >= 4 && averageRating > 0) {
        rating100 = Math.round(averageRating * 20);
      }
    }
  }

  let releaseDate = sanitizeDisplayCatalogReleaseDate(marketProps.OriginalReleaseDate);
  if (!releaseDate) {
    for (const avail of skuAvailabilities) {
      const skuMarket =
        Array.isArray(avail?.Sku?.MarketProperties) ? avail.Sku.MarketProperties[0] : null;
      const skuDate = sanitizeDisplayCatalogReleaseDate(
        skuMarket?.OriginalReleaseDate || skuMarket?.FirstAvailableDate
      );
      if (skuDate) {
        releaseDate = skuDate;
        break;
      }
      if (Array.isArray(avail?.Availabilities)) {
        for (const av of avail.Availabilities) {
          const condStart = sanitizeDisplayCatalogReleaseDate(
            av?.Conditions?.StartDate || av?.StartDate
          );
          if (condStart && (!releaseDate || condStart < releaseDate)) {
            releaseDate = condStart;
          }
        }
      }
      if (releaseDate) break;
    }
  }

  const osPlatforms = isCrossPlatformLauncherRuntime
    ? { windows: true, mac: true, linux: true }
    : { windows: true, mac: false, linux: false };

  const bottleCompatibilityTier = externalStorefrontHandoff
    ? 'tier_c_external_launcher'
    : !isCrossPlatformLauncherRuntime && !hasMsixvcPackage
      ? 'tier_b_legacy_uwp'
      : 'tier_a_supported';

  const contentId = String(
    preferredPkg?.ContentId || fulfillmentData?.ContentId || ''
  ).trim();
  const packageFullName = String(preferredPkg?.PackageFullName || '').trim();
  const wuCategoryId = String(
    fulfillmentData?.WuCategoryId || preferredPkg?.FulfillmentData?.WuCategoryId || ''
  ).trim();
  const maxDownloadSizeBytes =
    Number(preferredPkg?.MaxDownloadSizeInBytes || 0) || undefined;

  const handoffDescriptor = resolveStructuralExternalLauncherHandoff({
    externalStorefrontHandoff,
    isCrossPlatformLauncherRuntime,
    hasMsixvcPackage,
    packageFamilyName: pfn,
    publisherName,
    developerName,
    productId,
  });

  const cleanTitle = stripXboxPlatformDisambiguators(title);

  return {
    eligible: true,
    productId,
    selectedSkuId: String(preferredPkg?._skuId || selectedSkuId || '0010'),
    title: cleanTitle,
    rawTitle: title,
    shortDescription: String(localized.ShortDescription || '').trim(),
    detailedDescription: String(localized.ProductDescription || localized.ShortDescription || '').trim(),
    developers: developerName ? [developerName] : [],
    publishers: publisherName ? [publisherName] : [],
    genres: genreCategories,
    categories: storeCategories,
    releaseDate,
    capsuleImage,
    headerImage,
    iconUrl,
    logoUrl,
    screenshots,
    movies,
    averageRating,
    rating100,
    ratingCount,
    packageFamilyName: pfn || undefined,
    packageFullName: packageFullName || undefined,
    appUserModelId: pfn ? `${pfn}!App` : undefined,
    contentId: contentId || undefined,
    wuCategoryId: wuCategoryId || undefined,
    maxDownloadSizeBytes,
    xboxTitleId: xboxTitleId || undefined,
    scid: scid || undefined,
    msaAppId: msaAppId || undefined,
    platforms: osPlatforms,
    externalStorefrontHandoff,
    externalLauncher: handoffDescriptor?.externalLauncher,
    externalLauncherUrl: handoffDescriptor?.externalLauncherUrl,
    xboxBottleCompatibilityTier: bottleCompatibilityTier,
    bundledSkus,
  };
}

// ============================================================================
// 7. Full Xbox Library & Game Pass Sync Orchestrator (`syncXboxCatalog`)
// ============================================================================

const crossPlatformEntitlementByTokenHash = new Map();
const crossPlatformEntitlementByProvider = new WeakMap();

async function getCachedCrossPlatformRuntimeEntitlement({ authProvider, storeToken }) {
  if (!authProvider || typeof authProvider.checkMinecraftJavaEntitlement !== 'function') {
    return null;
  }
  const now = Date.now();
  const tokenKey =
    typeof storeToken === 'string' && storeToken.trim()
      ? crypto.createHash('sha256').update(storeToken.trim()).digest('hex')
      : '';

  if (tokenKey) {
    const cached = crossPlatformEntitlementByTokenHash.get(tokenKey);
    if (cached && now < cached.expiresAtMs) {
      return cached.result;
    }
  } else {
    const cached = crossPlatformEntitlementByProvider.get(authProvider);
    if (cached && now < cached.expiresAtMs) {
      return cached.result;
    }
  }

  const result = await authProvider.checkMinecraftJavaEntitlement();
  const entry = { result, expiresAtMs: now + CROSS_PLATFORM_ENTITLEMENT_CACHE_TTL_MS };
  if (tokenKey) {
    crossPlatformEntitlementByTokenHash.set(tokenKey, entry);
  } else {
    crossPlatformEntitlementByProvider.set(authProvider, entry);
  }
  return result;
}

/**
 * Full end-to-end Xbox Owned + Game Pass Catalog Sync:
 * 1. Detects active Game Pass subscription tier (`detectXboxSubscriptions`)
 * 2. Fetches permanently owned `BigId`s (`fetchXboxOwnedEntitlements`)
 * 3. Fetches active tier's live SIGL v2 feeds (cached with ETag/SQLite)
 * 4. Applies pre-hydration candidate pruning + hydrates DisplayCatalog in batches of 25
 * 5. Expands `BundledSkus` wrappers recursively (BFS up to depth 2)
 * 6. Enforces the **Strict Active-Access Gate** + **5-Gate Structural PC/Mac Filter**
 * 7. Decorates admitted titles with `TitleHub` achievements, `UserStats` playtime, and local install paths!
 */
async function syncXboxCatalog(options = {}) {
  const defaults = resolveDefaultXboxLocaleAndMarket(options);
  const {
    authProvider,
    storeToken,
    syncMode: rawSyncMode = 'owned_and_played',
    titleHubDecorations = {},
    playtimeByTitleId = new Map(),
    localInstallsByPfn = new Map(),
    localInstalledProductIds = new Set(),
    market = defaults.market,
    locale = defaults.locale,
    userDataDir,
    checkMinecraftJava = true,
  } = options;
  const fetchImpl = resolveFetchImpl(options);
  const syncMode = normalizeXboxSyncMode(rawSyncMode);

  const cacheStore = openXboxCatalogCacheStore(userDataDir);
  try {
    const [subscription, entitlementData] = await Promise.all([
      detectXboxSubscriptions({
        storeToken,
        authProvider,
        market,
        locale,
        fetchImpl,
        signal: options.signal,
      }),
      fetchXboxOwnedEntitlements({
        storeToken,
        authProvider,
        market,
        locale,
        fetchImpl,
        signal: options.signal,
      }),
    ]);

    const { activePcSiglSet, leavingSoonSet, recentlyAddedSet } = await fetchActiveTierSiglSets(
      subscription,
      entitlementData,
      { market, language: locale.toLowerCase(), cacheStore, fetchImpl, signal: options.signal }
    );

    const ownedSet = new Set(entitlementData.ownedProductIds);
    const crossPlatformRuntimeProductIds = new Set();
    let crossPlatformRuntimeVerified = false;

    if (
      checkMinecraftJava &&
      authProvider &&
      typeof authProvider.checkMinecraftJavaEntitlement === 'function' &&
      (ownedSet.size > 0 || activePcSiglSet.size > 0 || process.platform === 'darwin')
    ) {
      const mcEnt = await getCachedCrossPlatformRuntimeEntitlement({ authProvider, storeToken });
      if (mcEnt?.owned) {
        crossPlatformRuntimeVerified = true;
        const dynamicProdId = String(mcEnt.productId || mcEnt.bigId || '')
          .trim()
          .toUpperCase();
        if (dynamicProdId && /^[A-Z0-9]{12}$/.test(dynamicProdId)) {
          crossPlatformRuntimeProductIds.add(dynamicProdId);
          if (!subscription.hasPcCatalogAccess || mcEnt.permanentOwnership === true) {
            ownedSet.add(dynamicProdId);
          } else {
            activePcSiglSet.add(dynamicProdId);
          }
        }
      }
    }

    // Build lookup sets from TitleHub decorations (`byProductId`, `byPfn`, `byTitleId`) —
    // strictly for engagement check inside active SIGL + achievement/lastPlayed decoration!
    const playedProductIds = new Set(
      (titleHubDecorations.playedProductIds || []).map((x) => String(x).toUpperCase())
    );
    const playedPfns = new Set();
    for (const rawPfn of titleHubDecorations.playedPfns || []) {
      const lower = String(rawPfn || '').trim().toLowerCase();
      if (!lower) continue;
      playedPfns.add(lower);
      if (lower.includes('_')) {
        playedPfns.add(lower.split('_')[0]);
      }
    }
    const playedTitleIds = new Set(
      (titleHubDecorations.playedTitleIds || []).map((x) => String(x))
    );

    // Candidate BigIds to hydrate from DisplayCatalog:
    // - Always hydrate all permanently owned BigIds + locally installed BigIds
    // - If `subscription.hasPcCatalogAccess === true`, hydrate `activePcSiglSet` (cached in SQLite so repeat runs < 300ms!)
    const candidateSeedIds = new Set([...ownedSet, ...localInstalledProductIds]);
    if (subscription.hasPcCatalogAccess && syncMode !== 'owned_only') {
      for (const siglBigId of activePcSiglSet) {
        candidateSeedIds.add(siglBigId);
      }
    }

    // Parent satisfaction lineage for `BundledSkus` BFS (Depth <= 2)
    // Maps childBigId -> { ownedFromParent: boolean, inSiglFromParent: boolean, parentKeys: string[] }
    const bundleLineage = new Map();
    const hydratedProducts = await hydrateDisplayCatalogProducts(Array.from(candidateSeedIds), {
      market,
      languages: `${locale},neutral`,
      cacheStore,
      fetchImpl,
      signal: options.signal,
    });

    // In `owned_only` mode, keep zero-extra-HTTP behavior for unowned SIGL titles while populating
    // read-only cached DisplayCatalog entries for `activePcSiglSet` wrappers so an owned child of a
    // Game Pass bundle wrapper still detects `inSiglFromParent: true`.
    const cachedSiglSeedIds = [];
    if (
      subscription.hasPcCatalogAccess &&
      syncMode === 'owned_only' &&
      cacheStore &&
      activePcSiglSet.size > 0
    ) {
      const cachedSiglProducts = cacheStore.getProducts(Array.from(activePcSiglSet), market);
      for (const [siglId, siglProd] of cachedSiglProducts.entries()) {
        if (!hydratedProducts.has(siglId)) {
          hydratedProducts.set(siglId, siglProd);
        }
        cachedSiglSeedIds.push(siglId);
      }
    }

    // Recursive `BundledSkus` BFS (up to depth 2)
    let frontierIds = Array.from(new Set([...candidateSeedIds, ...cachedSiglSeedIds]));
    for (let depth = 0; depth < 2; depth++) {
      const nextNetworkChildIds = [];
      const nextCacheOnlyChildIds = [];
      const nextFrontier = new Set();

      for (const parentId of frontierIds) {
        const prod = hydratedProducts.get(parentId);
        if (!prod) continue;
        const parentOwned =
          ownedSet.has(parentId) || Boolean(bundleLineage.get(parentId)?.ownedFromParent);
        const parentInSigl =
          activePcSiglSet.has(parentId) || Boolean(bundleLineage.get(parentId)?.inSiglFromParent);
        if (!parentOwned && !parentInSigl) continue;

        const skus = Array.isArray(prod.DisplaySkuAvailabilities)
          ? prod.DisplaySkuAvailabilities
          : [];
        for (const avail of skus) {
          const sku = avail?.Sku;
          const bundled = sku?.Properties?.BundledSkus;
          if (!Array.isArray(bundled) || bundled.length === 0) continue;
          const parentKey = `${parentId}:${sku.SkuId || '0010'}`;

          for (const child of bundled) {
            const childId = String(child?.BigId || '').trim().toUpperCase();
            if (!childId || !/^[A-Z0-9]{12}$/.test(childId) || childId === parentId) continue;

            const prev = bundleLineage.get(childId) || {
              ownedFromParent: false,
              inSiglFromParent: false,
              parentKeys: [],
            };
            const newlyOwned = parentOwned && !prev.ownedFromParent;
            const newlyInSigl = parentInSigl && !prev.inSiglFromParent;
            if (newlyOwned) prev.ownedFromParent = true;
            if (newlyInSigl) prev.inSiglFromParent = true;
            if (!prev.parentKeys.includes(parentKey)) {
              prev.parentKeys.push(parentKey);
            }
            bundleLineage.set(childId, prev);

            if (!hydratedProducts.has(childId)) {
              if (syncMode === 'owned_only' && !parentOwned) {
                nextCacheOnlyChildIds.push(childId);
              } else {
                nextNetworkChildIds.push(childId);
              }
            } else if (newlyOwned || newlyInSigl) {
              nextFrontier.add(childId);
            }
          }
        }
      }

      if (nextCacheOnlyChildIds.length > 0 && cacheStore) {
        const networkSet = new Set(nextNetworkChildIds);
        const cacheLookupIds = Array.from(
          new Set(nextCacheOnlyChildIds.filter((id) => !networkSet.has(id)))
        );
        if (cacheLookupIds.length > 0) {
          const cachedChildren = cacheStore.getProducts(cacheLookupIds, market);
          for (const [cid, cprod] of cachedChildren.entries()) {
            hydratedProducts.set(cid, cprod);
            nextFrontier.add(cid);
          }
        }
      }

      if (nextNetworkChildIds.length > 0) {
        const uniqueNetworkChildIds = Array.from(new Set(nextNetworkChildIds));
        const childHydrated = await hydrateDisplayCatalogProducts(uniqueNetworkChildIds, {
          market,
          languages: `${locale},neutral`,
          cacheStore,
          fetchImpl,
          signal: options.signal,
        });
        for (const [cid, cprod] of childHydrated.entries()) {
          hydratedProducts.set(cid, cprod);
          nextFrontier.add(cid);
        }
      }

      if (nextFrontier.size === 0) break;
      frontierIds = Array.from(nextFrontier);
    }

    // Identify parent bundles that contain at least one Windows.Desktop child SKU so sibling
    // package-less cross-platform launcher editions (verified by runtime entitlement) are admitted structurally.
    const parentKeysWithDesktopChild = new Set();
    for (const [childId, lin] of bundleLineage.entries()) {
      const childProd = hydratedProducts.get(childId);
      if (!childProd) continue;
      const skus = Array.isArray(childProd.DisplaySkuAvailabilities)
        ? childProd.DisplaySkuAvailabilities
        : [];
      const hasDesktopPkg = skus.some(
        (av) =>
          Array.isArray(av?.Sku?.Properties?.Packages) &&
          av.Sku.Properties.Packages.some((pkg) => isDesktopEligiblePackage(pkg))
      );
      if (hasDesktopPkg) {
        for (const pk of lin.parentKeys || []) {
          parentKeysWithDesktopChild.add(pk);
        }
      }
    }

    // If crossPlatformRuntimeVerified is true and an entitled standalone candidate has zero packages
    // (and zero console restrictions), mark it structurally verified as well.
    if (crossPlatformRuntimeVerified) {
      for (const candId of [...ownedSet, ...activePcSiglSet]) {
        const prod = hydratedProducts.get(candId);
        if (!prod) continue;
        const kind = String(prod.ProductKind || prod.ProductType || '').toLowerCase();
        if (kind !== 'game') continue;
        const skus = Array.isArray(prod.DisplaySkuAvailabilities)
          ? prod.DisplaySkuAvailabilities
          : [];
        const hasAnyPkg = skus.some(
          (av) => Array.isArray(av?.Sku?.Properties?.Packages) && av.Sku.Properties.Packages.length > 0
        );
        const hasAnyBundled = skus.some(
          (av) => Array.isArray(av?.Sku?.Properties?.BundledSkus) && av.Sku.Properties.BundledSkus.length > 0
        );
        const locTitle = String(
          prod.LocalizedProperties?.[0]?.ProductTitle || prod.ProductTitle || ''
        );
        if (!hasAnyPkg && !hasAnyBundled && /\bjava\b/i.test(locTitle)) {
          crossPlatformRuntimeProductIds.add(candId);
        }
      }
    }

    const games = [];
    const suppressedItems = [];
    const seenProductIds = new Set();

    const lineageCandidateIds =
      syncMode === 'owned_only'
        ? Array.from(bundleLineage.entries())
            .filter(([, lin]) => lin.ownedFromParent)
            .map(([cid]) => cid)
        : Array.from(bundleLineage.keys());

    const allEvaluatedIds = Array.from(
      new Set([...candidateSeedIds, ...lineageCandidateIds])
    );

    for (const productId of allEvaluatedIds) {
      if (seenProductIds.has(productId)) continue;
      const product = hydratedProducts.get(productId);
      if (!product) continue;

      const lineage = bundleLineage.get(productId);
      const fromDesktopSiblingBundle = Boolean(
        lineage?.parentKeys?.some((pk) => parentKeysWithDesktopChild.has(pk))
      );

      const evalResult = evaluateDisplayCatalogProduct(product, {
        crossPlatformRuntimeVerified,
        crossPlatformRuntimeProductIds,
        fromDesktopSiblingBundle,
      });
      if (!evalResult.eligible) {
        if (evalResult.isSuppressedNonGame && evalResult.title) {
          suppressedItems.push({
            id: `xbox-${productId}`,
            rawTitle: evalResult.title,
            platformId: 'xbox',
            platformGameId: productId,
            reason: evalResult.reason,
            reasonCategory: 'non_game_filter',
          });
        }
        continue;
      }

      const isOwnedPermanent = ownedSet.has(productId) || Boolean(lineage?.ownedFromParent);
      const inActiveTierPcSigl =
        activePcSiglSet.has(productId) || Boolean(lineage?.inSiglFromParent);

      const pfnLower = String(evalResult.packageFamilyName || '').trim().toLowerCase();
      const identityLower = pfnLower.includes('_') ? pfnLower.split('_')[0] : pfnLower;
      const titleIdStr = String(evalResult.xboxTitleId || '');

      const localInstall =
        localInstallsByPfn instanceof Map
          ? (pfnLower ? localInstallsByPfn.get(pfnLower) : null) ||
            (identityLower ? localInstallsByPfn.get(identityLower) : null) ||
            null
          : null;
      const isInstalledLocally =
        Boolean(localInstall?.installed) || localInstalledProductIds.has(productId);

      const isPlayedInTitleHub =
        playedProductIds.has(productId) ||
        (pfnLower ? playedPfns.has(pfnLower) : false) ||
        (identityLower ? playedPfns.has(identityLower) : false) ||
        (titleIdStr ? playedTitleIds.has(titleIdStr) : false);

      // CRITICAL: Enforce the Strict Active-Access Gate
      const gateDecision = evaluateXboxActiveAccessGate({
        syncMode,
        isOwnedPermanent,
        subscription,
        inActiveTierPcSigl,
        isPlayedInTitleHub,
        isInstalledLocally,
      });

      if (!gateDecision.admit) {
        continue;
      }

      seenProductIds.add(productId);

      // Resolve TitleHub achievement summary & UserStats playtime decoration
      const achDecoration =
        (titleIdStr && titleHubDecorations.byTitleId?.[titleIdStr]) ||
        (pfnLower && titleHubDecorations.byPfn?.[pfnLower]) ||
        (identityLower && titleHubDecorations.byPfn?.[identityLower]) ||
        titleHubDecorations.byProductId?.[productId] ||
        null;

      const resolvedTitleId = titleIdStr || achDecoration?.titleId || undefined;
      const resolvedScid =
        achDecoration?.scid ||
        evalResult.scid ||
        deriveDefaultScidFromTitleId(resolvedTitleId) ||
        undefined;

      const playtimeMinutes =
        (resolvedTitleId && playtimeByTitleId instanceof Map
          ? playtimeByTitleId.get(String(resolvedTitleId))
          : undefined) ??
        achDecoration?.minutesPlayed ??
        0;

      const lastPlayed = achDecoration?.lastTimePlayed || undefined;
      const achievementSummary = achDecoration?.summary || undefined;

      const nativePlatforms = [
        ...(evalResult.platforms.windows ? ['windows'] : []),
        ...(evalResult.platforms.mac ? ['mac'] : []),
      ];

      const isLeavingSoon =
        gateDecision.ownershipType !== 'owned' && leavingSoonSet.has(productId);
      const isRecentlyAddedToGamePass =
        inActiveTierPcSigl && recentlyAddedSet.has(productId);

      const tags = ['Xbox'];
      if (gateDecision.ownershipType === 'owned' || gateDecision.ownershipType === 'owned_and_subscription') {
        tags.push('Microsoft Store');
      }
      if (gateDecision.ownershipType === 'subscription' || gateDecision.ownershipType === 'owned_and_subscription') {
        tags.push(subscription.tierDisplayName || 'Xbox Game Pass');
      }
      if (isLeavingSoon) tags.push('Leaving Soon');
      if (evalResult.externalStorefrontHandoff) {
        tags.push(`Requires ${evalResult.externalStorefrontHandoff.toUpperCase()}`);
      }

      const satisfyingEntitlementKeys = Array.from(
        new Set([
          ...(ownedSet.has(productId)
            ? [`${productId}:${entitlementData.ownedSkuByProduct.get(productId) || evalResult.selectedSkuId}`]
            : []),
          ...(lineage?.parentKeys || []),
          ...(inActiveTierPcSigl
            ? Array.isArray(subscription.activeEntitlementKeys) &&
              subscription.activeEntitlementKeys.length > 0
              ? subscription.activeEntitlementKeys
              : subscription.primaryProductId
                ? [`${subscription.primaryProductId}:0010`]
                : []
            : []),
        ])
      );

      const rawStoreTitle = evalResult.rawTitle || evalResult.title;
      const formattedHtml = formatPlainDescriptionToHtml(
        evalResult.detailedDescription || evalResult.shortDescription || ''
      );

      games.push({
        id: `xbox-${productId}`,
        title: evalResult.title,
        originalStoreTitle: rawStoreTitle,
        sortTitle: evalResult.title.replace(/^(The|A|An)\s+/i, ''),
        isVerifiedEntitlement: true,
        nativePlatforms,
        worksOn: evalResult.platforms,
        platforms: [
          {
            platformId: 'xbox',
            platformGameId: productId,
            storefrontAppId: productId,
            originalTitle: rawStoreTitle,
            installed: Boolean(localInstall?.installed),
            installPath: localInstall?.installPath || undefined,
            executablePath: localInstall?.executablePath || undefined,
            installSize: evalResult.maxDownloadSizeBytes,
            platforms: evalResult.platforms,
            xboxProductId: productId,
            packageFamilyName: evalResult.packageFamilyName,
            appUserModelId: evalResult.appUserModelId,
            xboxTitleId: resolvedTitleId,
            scid: resolvedScid,
            msaAppId: evalResult.msaAppId,
            ownershipType: gateDecision.ownershipType,
            gamePassTier:
              gateDecision.ownershipType !== 'owned'
                ? subscription.tierDisplayName
                : undefined,
            isLeavingSoon: isLeavingSoon || undefined,
            isRecentlyAddedToGamePass: isRecentlyAddedToGamePass || undefined,
            subscriptionExpired: gateDecision.subscriptionExpired || undefined,
            externalStorefrontHandoff: evalResult.externalStorefrontHandoff,
            ...(evalResult.externalLauncher ? { externalLauncher: evalResult.externalLauncher } : {}),
            ...(evalResult.externalLauncherUrl
              ? { externalLauncherUrl: evalResult.externalLauncherUrl }
              : {}),
            xboxBottleCompatibilityTier: evalResult.xboxBottleCompatibilityTier,
            playtimeMinutes: Number(playtimeMinutes || 0) || 0,
            lastPlayed,
            achievements: achievementSummary,
          },
        ],
        headerImage: evalResult.headerImage || evalResult.capsuleImage || '',
        capsuleImage: evalResult.capsuleImage || evalResult.headerImage || '',
        iconUrl: evalResult.iconUrl || undefined,
        shortDescription: evalResult.shortDescription || '',
        detailedDescription: formattedHtml || evalResult.detailedDescription || undefined,
        releaseDate: evalResult.releaseDate || '',
        developers: evalResult.developers,
        publishers: evalResult.publishers,
        genres: evalResult.genres,
        tags,
        rating: evalResult.rating100,
        enrichedMetadata: {
          name: evalResult.title,
          shortDescription: evalResult.shortDescription || '',
          detailedDescription: formattedHtml,
          aboutTheGame: formattedHtml,
          headerImage: evalResult.headerImage || evalResult.capsuleImage || '',
          capsuleImage: evalResult.capsuleImage || evalResult.headerImage || '',
          developers: evalResult.developers,
          publishers: evalResult.publishers,
          genres: evalResult.genres,
          tags,
          categories: evalResult.categories || [],
          screenshots: evalResult.screenshots.map((url, idx) => ({
            id: idx,
            pathThumbnail: url,
            pathFull: url,
          })),
          movies: evalResult.movies || [],
          releaseDate: evalResult.releaseDate || 'TBA',
          platforms: evalResult.platforms,
          metadataQuality: 'storefront_native',
          enrichedSource: 'xbox',
          xboxDeliveryHints: {
            contentId: evalResult.contentId,
            packageFullName: evalResult.packageFullName,
            wuCategoryId: evalResult.wuCategoryId,
            satisfyingEntitlementKeys,
          },
        },
      });
    }

    return {
      games,
      suppressedItems,
      subscription,
      syncMode,
      stats: {
        ownedCount: ownedSet.size,
        activeSiglCount: activePcSiglSet.size,
        admittedCount: games.length,
        suppressedCount: suppressedItems.length,
      },
    };
  } finally {
    cacheStore.close();
  }
}

function extractAutosuggestBigIds(json) {
  if (!json || typeof json !== 'object') return [];
  const orderedIds = [];
  const seen = new Set();
  const pushId = (raw) => {
    const clean = String(raw || '').trim().toUpperCase();
    if (/^[A-Z0-9]{12}$/.test(clean) && !seen.has(clean)) {
      seen.add(clean);
      orderedIds.push(clean);
    }
  };

  if (Array.isArray(json.Results)) {
    for (const group of json.Results) {
      if (!group || typeof group !== 'object') continue;
      pushId(group.ProductId || group.BigId || group.Id);
      if (Array.isArray(group.Products)) {
        for (const prod of group.Products) {
          if (prod && typeof prod === 'object') {
            pushId(prod.ProductId || prod.BigId || prod.Id);
          }
        }
      }
    }
  }

  if (Array.isArray(json.Products)) {
    for (const prod of json.Products) {
      if (prod && typeof prod === 'object') {
        pushId(prod.ProductId || prod.BigId || prod.Id);
      }
    }
  }

  if (Array.isArray(json.Payload?.SearchResults)) {
    for (const item of json.Payload.SearchResults) {
      if (item && typeof item === 'object') {
        pushId(item.ProductId || item.BigId || item.Id);
      }
    }
  }

  return orderedIds;
}

function buildXboxProductMetadataRecord(evalResult) {
  const formattedHtml = formatPlainDescriptionToHtml(
    evalResult.detailedDescription || evalResult.shortDescription || ''
  );
  const sanitizedReleaseDate = sanitizeDisplayCatalogReleaseDate(evalResult.releaseDate);
  return {
    productId: evalResult.productId,
    xboxProductId: evalResult.productId,
    title: evalResult.title,
    name: evalResult.title,
    rawTitle: evalResult.rawTitle,
    shortDescription: evalResult.shortDescription,
    description: evalResult.shortDescription || evalResult.detailedDescription,
    detailedDescription: formattedHtml,
    aboutTheGame: formattedHtml || evalResult.shortDescription || '',
    headerImage: evalResult.headerImage,
    capsuleImage: evalResult.capsuleImage,
    posterUrl: evalResult.capsuleImage,
    heroUrl: evalResult.headerImage,
    boxArtUrl: evalResult.iconUrl || evalResult.capsuleImage,
    iconUrl: evalResult.iconUrl,
    logoUrl: evalResult.logoUrl,
    screenshots: evalResult.screenshots,
    movies: evalResult.movies || [],
    categories: evalResult.categories || [],
    releaseDate: sanitizedReleaseDate,
    developers: evalResult.developers,
    publishers: evalResult.publishers,
    genres: evalResult.genres,
    platforms: evalResult.platforms,
    packageFamilyName: evalResult.packageFamilyName,
    packageFullName: evalResult.packageFullName,
    contentId: evalResult.contentId,
    wuCategoryId: evalResult.wuCategoryId,
    xboxTitleId: evalResult.xboxTitleId,
    scid: evalResult.scid,
    msaAppId: evalResult.msaAppId,
    maxDownloadSizeBytes: evalResult.maxDownloadSizeBytes,
    ...(evalResult.externalStorefrontHandoff
      ? { externalStorefrontHandoff: evalResult.externalStorefrontHandoff }
      : {}),
    ...(evalResult.externalLauncher ? { externalLauncher: evalResult.externalLauncher } : {}),
    ...(evalResult.externalLauncherUrl
      ? { externalLauncherUrl: evalResult.externalLauncherUrl }
      : {}),
    rating: evalResult.rating100,
    averageRating: evalResult.averageRating,
    ratingCount: evalResult.ratingCount,
    metadataQuality: 'storefront_native',
    enrichedSource: 'xbox',
  };
}

/**
 * Fetches rich DisplayCatalog metadata for a single Xbox `ProductId` (`BigId`), or queries
 * Microsoft DisplayCatalog `autosuggest` + batch product lookup when `payload.query` / `payload.title`
 * is provided without a direct `BigId`.
 */
async function fetchXboxProductMetadata(payload = {}, options = {}) {
  const rawId = String(
    payload.xboxProductId || payload.productId || payload.storeId || payload.platformGameId || ''
  )
    .replace(/^xbox[-_:]/i, '')
    .trim()
    .toUpperCase();
  const hasValidBigId = Boolean(rawId && /^[A-Z0-9]{12}$/.test(rawId));
  const rawQuery = String(payload.query || payload.title || '').trim();
  const isExplicitQuerySearch = payload.query !== undefined && String(payload.query || '').trim() !== '';

  if (!hasValidBigId && !rawQuery) {
    return isExplicitQuerySearch ? { success: false, results: [] } : null;
  }

  const defaults = resolveDefaultXboxLocaleAndMarket({
    market: payload.market || options.market,
    locale: options.locale,
  });
  const market = payload.market || options.market || defaults.market;
  const languages = payload.languages || options.languages || `${defaults.locale},neutral`;
  const fetchImpl = resolveFetchImpl(options);
  const limit = Math.max(1, Math.min(20, Math.floor(Number(payload.limit) || 5)));

  const cacheStore = openXboxCatalogCacheStore(options.userDataDir || payload.userDataDir);
  try {
    if (hasValidBigId) {
      const map = await lookupDisplayCatalogProducts([rawId], {
        market,
        languages,
        cacheStore,
        fetchImpl,
        signal: options.signal,
      });
      const prod = map.get(rawId);
      if (prod) {
        let evalResult = evaluateDisplayCatalogProduct(prod);
        if (
          !evalResult.eligible &&
          evalResult.isBundleWrapper &&
          Array.isArray(evalResult.bundledSkus) &&
          evalResult.bundledSkus.length > 0
        ) {
          const orderedChildren = evalResult.bundledSkus
            .slice()
            .sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)))
            .map((b) => b.bigId);
          const childMap = await lookupDisplayCatalogProducts(orderedChildren, {
            market,
            languages,
            cacheStore,
            fetchImpl,
            signal: options.signal,
          });
          for (const childId of orderedChildren) {
            const childProd = childMap.get(childId);
            if (!childProd) continue;
            const childEval = evaluateDisplayCatalogProduct(childProd);
            if (childEval.eligible) {
              evalResult = childEval;
              break;
            }
          }
        }
        if (evalResult.eligible) {
          const record = buildXboxProductMetadataRecord(evalResult);
          return {
            success: true,
            product: record,
            ...(isExplicitQuerySearch ? { results: [record] } : {}),
            ...record,
          };
        }
      }
      if (!rawQuery) {
        return isExplicitQuerySearch ? { success: false, results: [] } : null;
      }
    }

    if (typeof fetchImpl !== 'function') {
      return isExplicitQuerySearch ? { success: false, results: [] } : null;
    }

    const autosuggestLang = String(languages).split(',')[0].trim() || defaults.locale;
    const searchUrl =
      `${DISPLAY_CATALOG_AUTOSUGGEST_URL}?market=${encodeURIComponent(market)}` +
      `&languages=${encodeURIComponent(autosuggestLang)}` +
      `&query=${encodeURIComponent(rawQuery)}` +
      `&productFamilyNames=Games`;

    let candidateIds = [];
    try {
      const searchRes = await fetchImpl(searchUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'MS-CV': makeCorrelationVector(),
        },
        signal: buildXboxFetchSignal(options.signal),
      });
      if (searchRes && searchRes.ok) {
        const searchJson = await searchRes.json();
        candidateIds = extractAutosuggestBigIds(searchJson).slice(0, Math.min(25, Math.max(limit * 3, 10)));
      }
    } catch {}

    if (candidateIds.length === 0) {
      return isExplicitQuerySearch ? { success: false, results: [] } : null;
    }

    const hydrated = await lookupDisplayCatalogProducts(candidateIds, {
      market,
      languages,
      cacheStore,
      fetchImpl,
      signal: options.signal,
    });

    const evalsByCandidate = new Map();
    const bundleChildIds = [];
    for (const cid of candidateIds) {
      const prod = hydrated.get(cid);
      if (!prod) continue;
      const ev = evaluateDisplayCatalogProduct(prod);
      evalsByCandidate.set(cid, ev);
      if (!ev.eligible && ev.isBundleWrapper && Array.isArray(ev.bundledSkus)) {
        const sortedChildren = ev.bundledSkus
          .slice()
          .sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)));
        for (const child of sortedChildren.slice(0, 2)) {
          if (child?.bigId && !hydrated.has(child.bigId)) {
            bundleChildIds.push(child.bigId);
          }
        }
      }
    }

    if (bundleChildIds.length > 0) {
      const childHydrated = await lookupDisplayCatalogProducts(bundleChildIds, {
        market,
        languages,
        cacheStore,
        fetchImpl,
        signal: options.signal,
      });
      for (const [k, v] of childHydrated.entries()) {
        hydrated.set(k, v);
      }
    }

    const results = [];
    const seenProductIds = new Set();
    for (const cid of candidateIds) {
      if (results.length >= limit) break;
      let ev = evalsByCandidate.get(cid);
      if (!ev) continue;
      if (!ev.eligible && ev.isBundleWrapper && Array.isArray(ev.bundledSkus)) {
        const sortedChildren = ev.bundledSkus
          .slice()
          .sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)));
        for (const child of sortedChildren) {
          const childProd = hydrated.get(child.bigId);
          if (!childProd) continue;
          const childEv = evaluateDisplayCatalogProduct(childProd);
          if (childEv.eligible) {
            ev = childEv;
            break;
          }
        }
      }
      if (!ev.eligible || seenProductIds.has(ev.productId)) continue;
      seenProductIds.add(ev.productId);
      results.push(buildXboxProductMetadataRecord(ev));
    }

    if (results.length === 0) {
      return isExplicitQuerySearch ? { success: false, results: [] } : null;
    }

    const firstResult = results[0];
    return {
      success: true,
      product: firstResult,
      results,
      ...firstResult,
    };
  } finally {
    cacheStore.close();
  }
}

// ============================================================================
// 8. `.msixvc` Package Delivery Resolver (`packagespc.xboxlive.com` + `FE3` SOAP)
// ============================================================================

async function resolveFe3DeliveryUrls(wuCategoryId, fetchImpl, signal = undefined) {
  if (!wuCategoryId || typeof fetchImpl !== 'function') return [];

  const safeWuCategoryId = escapeXml(String(wuCategoryId).trim());

  const syncSoap =
    `<s:Envelope xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:s="http://www.w3.org/2003/05/soap-envelope">` +
    `<s:Header>` +
    `<a:Action s:mustUnderstand="1">http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService/SyncUpdates</a:Action>` +
    `<a:MessageID>urn:uuid:${crypto.randomUUID()}</a:MessageID>` +
    `<a:To s:mustUnderstand="1">${escapeXml(FE3_DELIVERY_SOAP_URL)}</a:To>` +
    `</s:Header>` +
    `<s:Body>` +
    `<SyncUpdates xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService">` +
    `<cookie><Expiration>2099-01-01T00:00:00Z</Expiration></cookie>` +
    `<parameters>` +
    `<ExpressQuery>false</ExpressQuery>` +
    `<InstalledNonLeafUpdateIDs><int>1</int><int>2</int><int>10</int><int>19</int></InstalledNonLeafUpdateIDs>` +
    `<SkipSoftwareSync>false</SkipSoftwareSync>` +
    `<NeedTwoGroupOutOfScopeUpdates>true</NeedTwoGroupOutOfScopeUpdates>` +
    `<FilterAppCategoryIds><CategoryIdentifier><Id>${safeWuCategoryId}</Id></CategoryIdentifier></FilterAppCategoryIds>` +
    `<TreatAppCategoryIdsAsInstalled>true</TreatAppCategoryIdsAsInstalled>` +
    `</parameters>` +
    `</SyncUpdates>` +
    `</s:Body>` +
    `</s:Envelope>`;

  const syncRes = await fetchImpl(FE3_DELIVERY_SOAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
    body: syncSoap,
    signal: buildXboxFetchSignal(signal),
  });
  if (!syncRes.ok) return [];
  const syncXml = await syncRes.text();

  const updatePairs = [];
  const infoRegex = /<UpdateInfo>[\s\S]*?<ID>(\d+)<\/ID>[\s\S]*?<UpdateIdentity UpdateID="([^"]+)" RevisionNumber="(\d+)"/gi;
  let m;
  while ((m = infoRegex.exec(syncXml)) !== null) {
    updatePairs.push({ intId: m[1], updateId: m[2], revisionNumber: m[3] });
  }
  if (updatePairs.length === 0) return [];

  const revXml = updatePairs
    .map(
      (u) =>
        `<UpdateIdentity><UpdateID>${escapeXml(u.updateId)}</UpdateID><RevisionNumber>${escapeXml(u.revisionNumber)}</RevisionNumber></UpdateIdentity>`
    )
    .join('');

  const extSoap =
    `<s:Envelope xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:s="http://www.w3.org/2003/05/soap-envelope">` +
    `<s:Header>` +
    `<a:Action s:mustUnderstand="1">http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService/GetExtendedUpdateInfo2</a:Action>` +
    `<a:MessageID>urn:uuid:${crypto.randomUUID()}</a:MessageID>` +
    `<a:To s:mustUnderstand="1">${escapeXml(FE3_DELIVERY_SOAP_URL)}</a:To>` +
    `</s:Header>` +
    `<s:Body>` +
    `<GetExtendedUpdateInfo2 xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService">` +
    `<updateIDs>${revXml}</updateIDs>` +
    `<infoTypes><XmlUpdateFragmentType>FileUrl</XmlUpdateFragmentType></infoTypes>` +
    `<deviceAttributes>E:BranchReadinessLevel=CB&amp;ProcessorArchitecture=AMD64&amp;OSVersion=10.0.26100.0</deviceAttributes>` +
    `</GetExtendedUpdateInfo2>` +
    `</s:Body>` +
    `</s:Envelope>`;

  const extRes = await fetchImpl(FE3_DELIVERY_SOAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
    body: extSoap,
    signal: buildXboxFetchSignal(signal),
  });
  if (!extRes.ok) return [];
  const extXml = await extRes.text();

  const files = [];
  const locRegex = /<FileLocation>[\s\S]*?<Url>([^<]+)<\/Url>[\s\S]*?<\/FileLocation>/gi;
  let lm;
  while ((lm = locRegex.exec(extXml)) !== null) {
    const rawUrl = lm[1].replace(/&amp;/g, '&').trim();
    if (/^https?:\/\//i.test(rawUrl)) {
      files.push({
        fileName: path.posix.basename(new URL(rawUrl).pathname) || 'package.msixvc',
        downloadUrls: [rawUrl],
        source: 'fe3_soap',
      });
    }
  }
  return files;
}

/**
 * Resolves `.msixvc` CDN download URLs, `ContentId`, `PackageFullName`, `PackageFamilyName`,
 * and `satisfyingEntitlementKeys` for a given `storeId` (`BigId`) via DisplayCatalog +
 * `GET https://packagespc.xboxlive.com/GetBasePackage/{ContentId}` (`x-xbl-contract-version: 3`)
 * with automatic `FE3` Windows Update SOAP fallback.
 *
 * Consumed directly by Wave 1B's `msixvcStreamExtractor.cjs` and Wave 2A's download manager!
 */
async function resolveXboxPackageDeliveryInfo(params = {}) {
  const defaults = resolveDefaultXboxLocaleAndMarket(params);
  const {
    storeId,
    contentId: explicitContentId,
    authProvider,
    market = defaults.market,
    languages = `${defaults.locale},neutral`,
    userDataDir,
  } = params;
  const fetchImpl = resolveFetchImpl(params);

  const cleanStoreId = String(storeId || '')
    .replace(/^xbox[-_:]/i, '')
    .trim()
    .toUpperCase();

  let evalMeta = null;
  if (cleanStoreId && /^[A-Z0-9]{12}$/.test(cleanStoreId)) {
    const cacheStore = openXboxCatalogCacheStore(userDataDir);
    try {
      const map = await hydrateDisplayCatalogProducts([cleanStoreId], {
        market,
        languages,
        cacheStore,
        fetchImpl,
        signal: params.signal,
      });
      const prod = map.get(cleanStoreId);
      if (prod) {
        const res = evaluateDisplayCatalogProduct(prod);
        // Expand primary bundled child if caller passed a bundle wrapper BigId
        if (!res.eligible && res.isBundleWrapper && res.bundledSkus?.length > 0) {
          const primaryChild =
            res.bundledSkus.find((b) => b.isPrimary) || res.bundledSkus[0];
          const childMap = await hydrateDisplayCatalogProducts([primaryChild.bigId], {
            market,
            languages,
            cacheStore,
            fetchImpl,
            signal: params.signal,
          });
          const childProd = childMap.get(primaryChild.bigId);
          if (childProd) {
            evalMeta = evaluateDisplayCatalogProduct(childProd);
            evalMeta._parentBundleKey = `${cleanStoreId}:${res.selectedSkuId || '0010'}`;
          }
        } else if (res.eligible) {
          evalMeta = res;
        }
      }
    } finally {
      cacheStore.close();
    }
  }

  const contentId = String(explicitContentId || evalMeta?.contentId || '').trim();
  const wuCategoryId = String(params.wuCategoryId || evalMeta?.wuCategoryId || '').trim();

  if (!contentId && !wuCategoryId && !evalMeta?.externalLauncherUrl) {
    throw new Error(
      `Unable to resolve ContentId or WuCategoryId for Xbox product ${cleanStoreId || '(unknown)'}`
    );
  }

  const packageFiles = [];

  // Primary: `GET https://packagespc.xboxlive.com/GetBasePackage/{ContentId}` (`x-xbl-contract-version: 3`)
  if (contentId && authProvider && typeof authProvider.getXstsToken === 'function') {
    try {
      const updateXsts = await authProvider.getXstsToken(XSTS_RELYING_PARTIES.UPDATE_XBL);
      const pkgUrl = `${PACKAGES_PC_BASE_URL}/${encodeURIComponent(contentId)}`;
      const res = await fetchImpl(pkgUrl, {
        method: 'GET',
        headers: {
          Authorization: updateXsts.authorizationHeader,
          'x-xbl-contract-version': '3',
          Accept: 'application/json',
          'MS-CV': makeCorrelationVector(),
        },
        signal: buildXboxFetchSignal(params.signal),
      });

      if (res.ok) {
        const json = await res.json();
        const rawFiles = Array.isArray(json?.PackageFiles)
          ? json.PackageFiles
          : Array.isArray(json?.packageFiles)
            ? json.packageFiles
            : [];
        for (const pf of rawFiles) {
          const fileName = String(pf?.FileName ?? pf?.fileName ?? '').trim();
          const relUrl = String(pf?.RelativeUrl ?? pf?.relativeUrl ?? '').trim();
          const roots = Array.isArray(pf?.CdnRootPaths)
            ? pf.CdnRootPaths
            : Array.isArray(pf?.cdnRootPaths)
              ? pf.cdnRootPaths
              : Array.isArray(pf?.BackgroundCdnRootPaths)
                ? pf.BackgroundCdnRootPaths
                : [];
          const downloadUrls = roots
            .map((r) => {
              const base = String(r || '').trim().replace(/\/+$/, '');
              if (!base || !relUrl) return '';
              return relUrl.startsWith('/') ? `${base}${relUrl}` : `${base}/${relUrl}`;
            })
            .filter((u) => /^https?:\/\//i.test(u));

          if (downloadUrls.length > 0) {
            const rawSize = Number(pf?.FileSize ?? pf?.fileSize ?? 0);
            const rawLicenseId = pf?.EkbId ?? pf?.ekbId ?? pf?.KeyBlob ?? undefined;
            packageFiles.push({
              fileName,
              fileSize: rawSize > 0 ? rawSize : undefined,
              isMsixvc: /\.(?:msixvc|xvc|eappx)$/i.test(fileName),
              licenseId: rawLicenseId || undefined,
              downloadUrls,
              source: 'packagespc',
            });
          }
        }
      }
    } catch {}
  }

  // Fallback: FE3 Windows Update SOAP if `packagespc` returned no `.msixvc` URLs
  if (packageFiles.length === 0 && wuCategoryId) {
    try {
      const fe3Files = await resolveFe3DeliveryUrls(wuCategoryId, fetchImpl, params.signal);
      packageFiles.push(...fe3Files);
    } catch {}
  }

  const primaryMsixvc =
    packageFiles.find((f) => /\.msixvc$/i.test(f.fileName)) ||
    packageFiles.find((f) => 'isMsixvc' in f && Boolean(f.isMsixvc)) ||
    packageFiles[0] ||
    null;

  const satisfyingEntitlementKeys = [];
  if (evalMeta?.productId) {
    satisfyingEntitlementKeys.push(`${evalMeta.productId}:${evalMeta.selectedSkuId || '0010'}`);
  }
  if (evalMeta?._parentBundleKey && !satisfyingEntitlementKeys.includes(evalMeta._parentBundleKey)) {
    satisfyingEntitlementKeys.push(evalMeta._parentBundleKey);
  }
  if (authProvider) {
    try {
      const subInfo = await detectXboxSubscriptions({
        authProvider,
        market,
        fetchImpl,
        signal: params.signal,
      });
      if (Array.isArray(subInfo?.activeEntitlementKeys)) {
        for (const subKey of subInfo.activeEntitlementKeys) {
          if (subKey && !satisfyingEntitlementKeys.includes(subKey)) {
            satisfyingEntitlementKeys.push(subKey);
          }
        }
      }
    } catch {}
  }

  return {
    storeId: evalMeta?.productId || cleanStoreId,
    title: evalMeta?.title || undefined,
    contentId: contentId || undefined,
    wuCategoryId: wuCategoryId || undefined,
    packageFamilyName: evalMeta?.packageFamilyName || undefined,
    packageFullName: evalMeta?.packageFullName || undefined,
    xboxTitleId: evalMeta?.xboxTitleId || undefined,
    scid: evalMeta?.scid || deriveDefaultScidFromTitleId(evalMeta?.xboxTitleId) || undefined,
    msaAppId: evalMeta?.msaAppId || undefined,
    maxDownloadSizeBytes:
      (primaryMsixvc && 'fileSize' in primaryMsixvc ? primaryMsixvc.fileSize : undefined) ||
      evalMeta?.maxDownloadSizeBytes,
    primaryDownloadUrl: primaryMsixvc?.downloadUrls?.[0] || undefined,
    downloadUrls: primaryMsixvc?.downloadUrls || [],
    fileName: primaryMsixvc?.fileName || undefined,
    packageFiles,
    satisfyingEntitlementKeys,
    externalStorefrontHandoff: evalMeta?.externalStorefrontHandoff || undefined,
    externalLauncher: evalMeta?.externalLauncher || undefined,
    externalLauncherUrl: evalMeta?.externalLauncherUrl || undefined,
  };
}

module.exports = {
  GAMEPASS_SIGL_IDS,
  XBOX_SUBSCRIPTION_TIERS,
  XBOX_PASS_PRODUCT_IDS,
  EXTERNAL_STOREFRONT_HANDOFF_TABLE,
  resolveStructuralExternalLauncherHandoff,
  projectCompactDisplayCatalogProduct,
  openXboxCatalogCacheStore,
  closeXboxCatalogCacheStore,
  normalizeXboxSyncMode,
  evaluateXboxActiveAccessGate,
  classifySubscriptionRecords,
  detectXboxSubscriptions,
  classifyXboxEntitlement,
  fetchXboxOwnedEntitlements,
  fetchSingleSiglFeed,
  fetchActiveTierSiglSets,
  hydrateDisplayCatalogProducts,
  lookupDisplayCatalogProducts,
  normalizeDisplayCatalogImageUri,
  extractDisplayCatalogMovies,
  extractDisplayCatalogCategories,
  formatPlainDescriptionToHtml,
  sanitizeDisplayCatalogReleaseDate,
  stripXboxPlatformDisambiguators,
  deriveDefaultScidFromTitleId,
  evaluateDisplayCatalogProduct,
  syncXboxCatalog,
  fetchXboxProductMetadata,
  resolveXboxPackageDeliveryInfo,
};
