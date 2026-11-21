'use strict';

/**
 * Shared Xbox Catalog & Game Pass Protocol Constants, Locale/Market Alignment,
 * Subscription Tier Registry, Allowlisted URL Validators & Structural Access Gates.
 */

const PCGAFD_ENTITLEMENTS_URL = 'https://beige.xboxservices.com/PCGAFD/entitlements';
const PCGAFD_SUBSCRIPTIONS_URL = 'https://beige.xboxservices.com/PCGAFD/entitlements/subscriptions';
const COLLECTIONS_QUERY_V6_URL = 'https://collections.mp.microsoft.com/v6.0/collections/query';
const DISPLAY_CATALOG_PRODUCTS_URL = 'https://displaycatalog.mp.microsoft.com/v7.0/products';
const DISPLAY_CATALOG_AUTOSUGGEST_URL =
  'https://displaycatalog.mp.microsoft.com/v7.0/productFamilies/autosuggest';
const GAMEPASS_SIGL_V2_URL = 'https://catalog.gamepass.com/sigls/v2';
const GAMEPASS_SIGL_V3_URL = 'https://catalog.gamepass.com/sigls/v3';
const PACKAGES_PC_BASE_URL = 'https://packagespc.xboxlive.com/GetBasePackage';
const FE3_DELIVERY_SOAP_URL = 'https://fe3cr.delivery.mp.microsoft.com/ClientWebService/client.asmx';

const CROSS_PLATFORM_ENTITLEMENT_CACHE_TTL_MS = 30 * 60_000; // 30 minutes

function resolveFetchImpl(options = {}) {
  return options.customFetch || options.fetchImpl || globalThis.fetch;
}

const ENGLISH_SPEAKING_MARKETS = new Set([
  'US',
  'GB',
  'AU',
  'CA',
  'NZ',
  'IE',
  'SG',
  'ZA',
  'IN',
]);

/**
 * Aligns an Xbox/Store BCP-47 locale tag with the resolved 2-letter ISO 3166-1 alpha-2 `market`
 * so systems reporting `locale = 'en-US'` with `countryCode = 'GB'` query SIGL v3 and
 * DisplayCatalog with regional English (`en-GB` / `en-gb`) rather than mismatched `en-US` + `GB`.
 * Preserves explicit non-English language tags (e.g., `fr-FR`, `de-DE`, `ja-JP`).
 *
 * @param {string} [rawLocale]
 * @param {string} [rawMarket]
 * @returns {string}
 */
function alignXboxLocaleWithMarket(rawLocale, rawMarket) {
  const market = /^[A-Z]{2}$/.test(String(rawMarket || '').trim().toUpperCase())
    ? String(rawMarket).trim().toUpperCase()
    : 'US';
  const trimmed = String(rawLocale || '').trim();
  if (!trimmed) {
    return ENGLISH_SPEAKING_MARKETS.has(market) ? `en-${market}` : 'en-US';
  }
  const normalized = trimmed.replace(/_/g, '-');
  if (!normalized.includes('-')) {
    const lang = normalized.toLowerCase();
    return `${lang}-${market}`;
  }
  const parts = normalized.split('-').filter(Boolean);
  const baseLang = (parts[0] || 'en').toLowerCase();
  const region = (parts[parts.length - 1] || '').toUpperCase();
  if (
    baseLang === 'en' &&
    /^[A-Z]{2}$/.test(region) &&
    region !== market &&
    ENGLISH_SPEAKING_MARKETS.has(market)
  ) {
    return `en-${market}`;
  }
  if (/^[A-Z]{2}$/.test(region)) {
    return `${baseLang}-${region}`;
  }
  return normalized;
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

  const explicitLocale =
    typeof options.locale === 'string' && options.locale.trim() ? options.locale.trim() : '';
  const explicitMarket =
    typeof options.market === 'string' && /^[A-Z]{2}$/i.test(options.market.trim())
      ? options.market.trim().toUpperCase()
      : '';

  if (!detectedMarket) {
    const localeForRegion = explicitLocale || detectedLocale;
    if (localeForRegion && localeForRegion.replace(/_/g, '-').includes('-')) {
      const parts = localeForRegion.replace(/_/g, '-').split('-');
      const region = parts[parts.length - 1].toUpperCase();
      if (/^[A-Z]{2}$/.test(region)) {
        detectedMarket = region;
      }
    }
  }

  const market =
    explicitMarket ||
    (/^[A-Z]{2}$/.test(detectedMarket) ? detectedMarket : '') ||
    'US';

  const rawLocale = explicitLocale || detectedLocale || 'en-US';
  const locale = alignXboxLocaleWithMarket(rawLocale, market);

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

// Empirically verified SIGL v3 & v2 Collection GUIDs
const GAMEPASS_SIGL_IDS = Object.freeze({
  ULTIMATE_ALL_PC: '97c6c862-d28a-4907-a3d5-c401f2296a53',
  PC_GAME_PASS_ALL: '609d944c-d395-4c0a-9ea4-e9f39b52c1ad',
  ALL_PC: 'fdd9e2a7-0fee-49f6-ad69-4354098401ff',
  EA_PLAY_PC: '1d33fbb9-b895-4732-a8ca-a55c8b99fa2c',
  UBISOFT_CLASSICS_PC: '66ec875c-a391-44f5-9a54-a28bd6f976ce',
  PREMIUM: '09a72c0d-c466-426a-9580-b78955d8173a',
  ESSENTIAL: '34031711-5a70-4196-bab7-45757dc2294e',
  LEAVING_SOON: 'cc7fc951-d00f-410e-9e02-5e4628e04163',
  RECENTLY_ADDED_PC: '06323672-b8c8-43cc-b0de-32d5a9834749',
  LEGACY_LEAVING_SOON_V2: '393f05bf-e596-4ef6-9487-6d4fa0eab987',
  LEGACY_RECENTLY_ADDED_V2: 'f13cf6b4-57e6-4459-89df-6aec18cf0538',
});

// Authoritative 2025/2026 Xbox Gaming Pass & Partner Subscription Registry
const XBOX_GAMING_PASS_REGISTRY = Object.freeze({
  CFQ7TTC0KHS0: Object.freeze({
    tierId: 'ultimate',
    rank: 100,
    displayName: 'Xbox Game Pass Ultimate',
    tierDisplayName: 'Xbox Game Pass Ultimate',
    hasPcCatalogAccess: true,
    includesEaPlayPc: true,
    defaultSkuId: '0004',
    siglMode: 'ultimate_v3',
    bundledPassIds: Object.freeze([
      'CFQ7TTC0KGQ8',
      'CFQ7TTC0P85B',
      'CFQ7TTC0K5DJ',
      'CFQ7TTC0K6L8',
      'CFQ7TTC0K5DH',
      'CFQ7TTBZT8LN',
      'CFQ7TTBZT8K1',
    ]),
  }),
  CFQ7TTC0KGQ8: Object.freeze({
    tierId: 'pc',
    rank: 90,
    displayName: 'PC Game Pass',
    tierDisplayName: 'PC Game Pass',
    hasPcCatalogAccess: true,
    includesEaPlayPc: true,
    defaultSkuId: '0001',
    siglMode: 'pc_v3',
    bundledPassIds: Object.freeze(['CFQ7TTC0K5DH']),
  }),
  CFQ7TTC0P85B: Object.freeze({
    tierId: 'premium',
    rank: 70,
    displayName: 'Xbox Game Pass Premium',
    tierDisplayName: 'Xbox Game Pass Premium',
    hasPcCatalogAccess: true,
    includesEaPlayPc: false,
    defaultSkuId: '0001',
    siglMode: 'premium_pc_intersection',
    bundledPassIds: Object.freeze(['CFQ7TTC0K5DJ']),
  }),
  CFQ7TTC0K5DJ: Object.freeze({
    tierId: 'essential',
    rank: 50,
    displayName: 'Xbox Game Pass Essential',
    tierDisplayName: 'Xbox Game Pass Essential',
    hasPcCatalogAccess: true,
    includesEaPlayPc: false,
    defaultSkuId: '000K',
    siglMode: 'essential_pc',
    bundledPassIds: Object.freeze([]),
  }),
  CFQ7TTC0K5DH: Object.freeze({
    tierId: 'ea_play',
    rank: 40,
    displayName: 'EA Play',
    tierDisplayName: 'EA Play',
    hasPcCatalogAccess: true,
    includesEaPlayPc: true,
    defaultSkuId: '0006',
    siglMode: 'ea_play_only',
    bundledPassIds: Object.freeze([]),
  }),
  CFQ7TTC0QH5H: Object.freeze({
    tierId: 'ubisoft_classics',
    rank: 38,
    displayName: 'Ubisoft+ Premium',
    tierDisplayName: 'Ubisoft+ Premium',
    hasPcCatalogAccess: true,
    includesEaPlayPc: false,
    defaultSkuId: '0003',
    siglMode: 'ubisoft_classics_pc',
    bundledPassIds: Object.freeze(['CFQ7TTBZT8LN', 'CFQ7TTBZT8K1']),
  }),
  CFQ7TTBZT8LN: Object.freeze({
    tierId: 'ubisoft_classics',
    rank: 35,
    displayName: 'Ubisoft+ Classics',
    tierDisplayName: 'Ubisoft+ Classics',
    hasPcCatalogAccess: true,
    includesEaPlayPc: false,
    defaultSkuId: '0002',
    siglMode: 'ubisoft_classics_pc',
    bundledPassIds: Object.freeze([]),
  }),
  CFQ7TTC0P85C: Object.freeze({
    tierId: 'starter',
    rank: 30,
    displayName: 'PC Game Pass Starter',
    tierDisplayName: 'PC Game Pass Starter',
    hasPcCatalogAccess: true,
    includesEaPlayPc: false,
    defaultSkuId: '0002',
    siglMode: 'starter_dynamic',
    bundledPassIds: Object.freeze([]),
  }),
  CFQ7TTC10QFD: Object.freeze({
    tierId: 'starter',
    rank: 30,
    displayName: 'PC Game Pass Starter',
    tierDisplayName: 'PC Game Pass Starter',
    hasPcCatalogAccess: true,
    includesEaPlayPc: false,
    defaultSkuId: '0002',
    siglMode: 'starter_dynamic',
    bundledPassIds: Object.freeze([]),
  }),
  CFQ7TTC0K6L8: Object.freeze({
    tierId: 'console_only',
    rank: 10,
    displayName: 'Xbox Game Pass for Console',
    tierDisplayName: 'Xbox Game Pass for Console',
    hasPcCatalogAccess: false,
    includesEaPlayPc: false,
    defaultSkuId: '0004',
    siglMode: 'none',
    bundledPassIds: Object.freeze([]),
  }),
});

const XBOX_SUBSCRIPTION_TIERS = XBOX_GAMING_PASS_REGISTRY;

const PCGAFD_KNOWN_SUBSCRIPTION_PRODUCT_IDS = Object.freeze([
  'CFQ7TTC0KHS0', // Ultimate
  'CFQ7TTC0KGQ8', // PC Game Pass
  'CFQ7TTC0P85B', // Premium
  'CFQ7TTC0K5DJ', // Essential
  'CFQ7TTC0K6L8', // Console
  'CFQ7TTC0K5DH', // EA Play
  'CFQ7TTC0QH5H', // Ubisoft+ Multi-Access / Premium
  'CFQ7TTBZT8LN', // Ubisoft+ Classics (PC)
  'CFQ7TTBZT8K1', // Ubisoft+ Classics (Console)
  'CFQ7TTC0P85C', // Game Pass Starter
  'CFQ7TTC10QFD', // Legacy Regional Starter
]);

// Protocol-level Microsoft Store `CFQ7TT*` non-catalog subscription pass SKUs (productivity,
// cloud storage, console-only child aliases, and non-catalog perk passes) skipped before
// DisplayCatalog dynamic pass hydration to avoid wasted round-trips.
const NON_GAMING_OR_PERK_PASS_IGNORE_SET = new Set([
  'CFQ7TTC0K5BF', // Productivity subscription pass
  'CFQ7TTC0K5BG', // Productivity subscription pass
  'CFQ7TTC0K5BH', // Cloud storage subscription pass
  'CFQ7TTC0K8P5', // Legacy multiplayer pass alias (superseded by CFQ7TTC0K5DJ)
  'CFQ7TTC0TS2G', // Non-catalog add-on / cloud subscription pass
  'CFQ7TTC0L23L', // Non-catalog perk subscription pass
  'CFQ7TTC0L7S5', // Non-catalog perk subscription pass
  'CFQ7TTBZT8K1', // Console-only child subscription pass SKU
]);

const XBOX_PASS_PRODUCT_IDS = new Set([
  ...Object.keys(XBOX_GAMING_PASS_REGISTRY),
  ...PCGAFD_KNOWN_SUBSCRIPTION_PRODUCT_IDS,
  ...NON_GAMING_OR_PERK_PASS_IGNORE_SET,
]);

function isXboxPassProductId(bigId, rawRecord) {
  const upper = typeof bigId === 'string' ? bigId.trim().toUpperCase() : '';
  if (upper && (XBOX_PASS_PRODUCT_IDS.has(upper) || /^CFQ7TT[A-Z0-9]{6}$/.test(upper))) {
    return true;
  }
  const kind = String(rawRecord?.productKind || rawRecord?.ProductKind || '')
    .trim()
    .toLowerCase();
  return kind === 'pass';
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
  rockstar: Object.freeze({
    externalLauncher: 'Rockstar Games Launcher',
    externalLauncherUrl: 'https://socialclub.rockstargames.com/rockstar-games-launcher',
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
  'socialclub.rockstargames.com',
  'www.rockstargames.com',
  'rockstargames.com',
  'gamedownloads.rockstargames.com',
  'www.xbox.com',
  'xbox.com',
]);

const ALLOWED_PACKAGE_DELIVERY_HTTPS_HOST_SUFFIXES = Object.freeze([
  '.xboxlive.com',
  '.xboxservices.com',
  '.delivery.mp.microsoft.com',
  '.windowsupdate.com',
  '.download.microsoft.com',
  '.msecnd.net',
  '.microsoft.com',
  '.akamaized.net',
]);

const ALLOWED_PACKAGE_DELIVERY_HTTP_EXACT_HOSTS = new Set([
  'assets1.xboxlive.com',
  'assets2.xboxlive.com',
  'dlassets.xboxlive.com',
  'dlassets2.xboxlive.com',
  'xvcf1.xboxlive.com',
  'xvcf2.xboxlive.com',
]);

const ALLOWED_PACKAGE_DELIVERY_HTTP_HOST_SUFFIXES = Object.freeze([
  '.dl.delivery.mp.microsoft.com',
  '.download.windowsupdate.com',
]);

function matchesDomainSuffix(hostname, suffixes) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  for (const suffix of suffixes) {
    const bare = suffix.startsWith('.') ? suffix.slice(1) : suffix;
    if (host === bare || host.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

/**
 * Validates an Xbox / Microsoft Delivery Optimization package download URL.
 * - Rejects embedded credentials, non-default ports, and arbitrary/unallowlisted hosts.
 * - Allows `https:` on official Microsoft / Xbox CDN domains.
 * - Allows `http:` STRICTLY on Microsoft's official Delivery Optimization / XVCF hosts
 *   (`assets1/2.xboxlive.com`, `dlassets/2.xboxlive.com`, `xvcf1/2.xboxlive.com`,
 *   `*.dl.delivery.mp.microsoft.com`, `*.download.windowsupdate.com`) whose payloads are
 *   cryptographically verified via full XVD L0->L3->topHashBlockHash Merkle chains.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
function normalizeAllowedPackageDeliveryUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) return '';
    if (parsed.port) return '';
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (parsed.protocol === 'https:') {
      return matchesDomainSuffix(host, ALLOWED_PACKAGE_DELIVERY_HTTPS_HOST_SUFFIXES)
        ? parsed.toString()
        : '';
    }
    if (parsed.protocol === 'http:') {
      if (
        ALLOWED_PACKAGE_DELIVERY_HTTP_EXACT_HOSTS.has(host) ||
        matchesDomainSuffix(host, ALLOWED_PACKAGE_DELIVERY_HTTP_HOST_SUFFIXES)
      ) {
        return parsed.toString();
      }
      return '';
    }
    return '';
  } catch {
    return '';
  }
}

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
    if (parsed.username || parsed.password || parsed.port) return '';
    if (!ALLOWED_EXTERNAL_LAUNCHER_HOSTS.has(parsed.hostname.toLowerCase())) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

/**
 * Resolves `{ externalLauncher, externalLauncherUrl }` structurally from storefront ecosystem handoff
 * (`ea`, `ubisoft`, `riot`, `bnet`, `rockstar`) or cross-platform standalone launcher runtime metadata.
 *
 * @param {{
 *   externalStorefrontHandoff?: string,
 *   isCrossPlatformLauncherRuntime?: boolean,
 *   hasMsixvcPackage?: boolean,
 *   hasStandaloneMsixvc?: boolean,
 *   packageFamilyName?: string,
 *   publisherName?: string,
 *   developerName?: string,
 *   productId?: string,
 * }} params
 * @returns {{ externalLauncher: string, externalLauncherUrl: string, xboxBottleCompatibilityReason?: string } | null}
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
        xboxBottleCompatibilityReason:
          handoffKey === 'riot'
            ? 'Requires Riot Vanguard Windows kernel anti-cheat driver (vgk.sys), which cannot run inside macOS Wine/CrossOver bottles.'
            : `Requires ${entry.externalLauncher}`,
      };
    }
  }

  if (params.isCrossPlatformLauncherRuntime === true && !params.hasStandaloneMsixvc) {
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

/**
 * @param {unknown} pfn
 * @param {unknown} [publisherName]
 * @param {boolean} [hasStandaloneMsixvc]
 * @param {{ packagesCount?: number, fulfillmentType?: string, maxDownloadBytes?: number }} [extra]
 * @returns {string | undefined}
 */
function detectThirdPartyPfnHandoff(
  pfn,
  publisherName = '',
  hasStandaloneMsixvc = false,
  extra = {}
) {
  const STUB_MAX_BYTES = 32 * 1024 * 1024;
  const packagesCount = Number(extra?.packagesCount ?? 0) || 0;
  const fulfillmentType = String(extra?.fulfillmentType || '').trim();
  const maxDownloadBytes = Number(extra?.maxDownloadBytes ?? 0) || 0;
  const isStubFulfillment = /gdkstubgame/i.test(fulfillmentType);

  // If the product ships a verified full native GDK MSIXVC (> 32 MiB and not a GDKStubGame wrapper),
  // never misclassify it as an external publisher launcher stub even if its PFN shares a publisher suffix.
  if (
    hasStandaloneMsixvc &&
    !isStubFulfillment &&
    (maxDownloadBytes === 0 || maxDownloadBytes > STUB_MAX_BYTES)
  ) {
    return undefined;
  }

  const lowerPfn = String(pfn || '').trim().toLowerCase();
  if (lowerPfn) {
    for (const rule of THIRD_PARTY_PFN_PUBLISHERS) {
      if (lowerPfn.endsWith(rule.suffix)) {
        return rule.handoff;
      }
    }
  }

  const pubLower = String(publisherName || '').toLowerCase();
  const isStubOrZeroPkg =
    packagesCount === 0 ||
    isStubFulfillment ||
    (maxDownloadBytes > 0 && maxDownloadBytes <= STUB_MAX_BYTES);

  if (
    !hasStandaloneMsixvc &&
    (pubLower.includes('electronic arts') ||
      lowerPfn.startsWith('electronicarts.') ||
      (/^electronicartsmobile\./i.test(lowerPfn) && packagesCount === 0 && !fulfillmentType))
  ) {
    return 'ea';
  }

  if (
    !hasStandaloneMsixvc &&
    isStubOrZeroPkg &&
    (/\brockstar\s+games\b/i.test(pubLower) || lowerPfn.startsWith('rockstargames.'))
  ) {
    return 'rockstar';
  }

  return undefined;
}

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

function deriveExpandedCapabilitySetFromSubscription(subscription) {
  const expanded = new Set();
  if (!subscription?.hasActiveSubscription) return expanded;

  const seedIds = [];
  if (Array.isArray(subscription.expandedCapabilityPassIds)) {
    for (const id of subscription.expandedCapabilityPassIds) {
      if (id) seedIds.push(String(id).trim().toUpperCase());
    }
  }
  if (Array.isArray(subscription.activeProductIds)) {
    for (const id of subscription.activeProductIds) {
      if (id) seedIds.push(String(id).trim().toUpperCase());
    }
  }
  if (subscription.primaryProductId) {
    seedIds.push(String(subscription.primaryProductId).trim().toUpperCase());
  }

  for (const id of seedIds) {
    if (!id) continue;
    expanded.add(id);
    const def = XBOX_GAMING_PASS_REGISTRY[id];
    if (def && Array.isArray(def.bundledPassIds)) {
      for (const childId of def.bundledPassIds) {
        expanded.add(childId);
      }
    }
  }

  // Support minimal synthetic unit-test subscription objects that omit `activeProductIds`
  if (expanded.size === 0 && subscription.hasPcCatalogAccess) {
    const tierId = String(subscription.tierId || '').toLowerCase();
    const mode = String(subscription.siglMode || '').toLowerCase();
    if (tierId === 'ultimate' || mode === 'ultimate_v3') {
      for (const id of [
        'CFQ7TTC0KHS0',
        'CFQ7TTC0KGQ8',
        'CFQ7TTC0P85B',
        'CFQ7TTC0K5DJ',
        'CFQ7TTC0K5DH',
        'CFQ7TTBZT8LN',
      ]) {
        expanded.add(id);
      }
    } else if (tierId === 'pc' || mode === 'pc_v3' || mode === 'all_pc_plus_ea') {
      expanded.add('CFQ7TTC0KGQ8');
      expanded.add('CFQ7TTC0K5DH');
    } else if (tierId === 'premium' || mode === 'premium_pc_intersection') {
      expanded.add('CFQ7TTC0P85B');
      expanded.add('CFQ7TTC0K5DJ');
    } else if (tierId === 'essential' || mode === 'essential_pc') {
      expanded.add('CFQ7TTC0K5DJ');
    } else if (tierId === 'ea_play' || mode === 'ea_play_only') {
      expanded.add('CFQ7TTC0K5DH');
    } else if (tierId === 'ubisoft_classics' || mode === 'ubisoft_classics_pc') {
      expanded.add('CFQ7TTBZT8LN');
    } else if (tierId === 'starter' || mode === 'starter_dynamic' || mode === 'all_pc_only') {
      expanded.add('CFQ7TTC0P85C');
    }
    if (subscription.includesEaPlayPc) {
      expanded.add('CFQ7TTC0K5DH');
    }
  }

  return expanded;
}

module.exports = {
  PCGAFD_ENTITLEMENTS_URL,
  PCGAFD_SUBSCRIPTIONS_URL,
  COLLECTIONS_QUERY_V6_URL,
  DISPLAY_CATALOG_PRODUCTS_URL,
  DISPLAY_CATALOG_AUTOSUGGEST_URL,
  GAMEPASS_SIGL_V2_URL,
  GAMEPASS_SIGL_V3_URL,
  PACKAGES_PC_BASE_URL,
  FE3_DELIVERY_SOAP_URL,
  CROSS_PLATFORM_ENTITLEMENT_CACHE_TTL_MS,
  GAMEPASS_SIGL_IDS,
  XBOX_GAMING_PASS_REGISTRY,
  XBOX_SUBSCRIPTION_TIERS,
  PCGAFD_KNOWN_SUBSCRIPTION_PRODUCT_IDS,
  NON_GAMING_OR_PERK_PASS_IGNORE_SET,
  XBOX_PASS_PRODUCT_IDS,
  THIRD_PARTY_PFN_PUBLISHERS,
  EXTERNAL_STOREFRONT_HANDOFF_TABLE,
  ALLOWED_EXTERNAL_LAUNCHER_HOSTS,
  ALLOWED_PACKAGE_DELIVERY_HTTPS_HOST_SUFFIXES,
  ALLOWED_PACKAGE_DELIVERY_HTTP_EXACT_HOSTS,
  ALLOWED_PACKAGE_DELIVERY_HTTP_HOST_SUFFIXES,
  resolveFetchImpl,
  alignXboxLocaleWithMarket,
  resolveDefaultXboxLocaleAndMarket,
  escapeXml,
  isXboxPassProductId,
  normalizeAllowedPackageDeliveryUrl,
  validateAllowedExternalLauncherUrl,
  resolveStructuralExternalLauncherHandoff,
  detectThirdPartyPfnHandoff,
  normalizeXboxSyncMode,
  evaluateXboxActiveAccessGate,
  deriveExpandedCapabilitySetFromSubscription,
};
