import axios from 'axios';
import {
  CanonicalGame,
  GamePlatformOwnership,
  StoreAchievementSummary,
} from '../../contracts/game';
import { StorefrontCredentials } from '../../contracts/integration';
import { hasStructuralEpicCodenameTraits } from './epicCodenames';
import { normalizeChainedHandoffId } from './catalogSanitizer';
import { steamMatcher } from '../steam/steamMatcher';
import { steamApi } from '../steam/steamApi';
import { isKnownDeadSteamCover } from '../igdb/igdbCoverService';
import {
  reconcileCapsuleImage,
  reconcileHeaderImage,
  type ArtworkRecoveryContext,
} from '../storage/metadataReconciliation';
import { cacheUserEpicAchievements } from '../storage/knownGameAchievements';
import { reconcileAchievementSummaries } from '../storage/achievementReconciliation';
import { getAlphabeticalTitleSortKey } from '../common/titleSortUtils';
import { hasElectronBridge } from '../common/runtimeEnv';
import {
  buildDevProxyUrlForRoute,
  getDevProxyBaseForRoute,
} from '../network/browserDevProxy';

const DEFAULT_EPIC_AVATAR_URL = 'https://cdn2.unrealengine.com/egs-badge.png';
const EPIC_CATALOG_BATCH_SIZE = 50;
const EPIC_CATALOG_BATCH_CONCURRENCY = 4;
const EPIC_STEAM_MATCH_CONCURRENCY = 4;

const STRUCTURAL_EPIC_ADDON_APPNAME_RE =
  /(?:_|-)(?:cosmetic|mtx|microtransaction|dlc|addon|add_on|battlepass|seasonpass|starterpack|currencypack|skinpack|outfitpack|questpack|crewpack)[a-z0-9_-]*$/i;

const STRUCTURAL_EPIC_ADDON_TITLE_RE =
  /\b(?:dlc|season\s+pass|battle\s+pass|expansion\s+pass|add-on|addon|upgrade\s+pack|supporter\s+pack|cosmetic\s+pack|cosmetic\s+bundle|weapon\s+pack|skin\s+pack|outfit\s+pack|quest\s+pack|starter\s+pack|crew\s+pack|currency\s+pack|in-game\s+currency)\b/i;

const EPIC_HEX_HASH_TITLE_RE = /^[0-9a-f]{20,}$/i;
const EPIC_UUID_TITLE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface EpicCategoryItem {
  path?: string;
}

interface EpicKeyImage {
  type?: string;
  url?: string;
}

interface EpicMainGameRef {
  id?: string;
  namespace?: string;
}

type EpicCustomAttributeValue =
  | { type?: string; value?: string }
  | string
  | undefined;

type EpicCustomAttributes =
  | Record<string, EpicCustomAttributeValue>
  | Array<{ key?: string; type?: string; value?: string }>;

interface EpicCatalogItemMetadata {
  title?: string;
  description?: string;
  developer?: string;
  publisher?: string;
  releaseDate?: string;
  itemType?: string;
  categories?: EpicCategoryItem[];
  keyImages?: EpicKeyImage[];
  mainGameItem?: EpicMainGameRef;
  customAttributes?: EpicCustomAttributes;
}

interface EpicLibraryRecord {
  appName?: string;
  namespace?: string;
  catalogItemId?: string;
  sandboxName?: string;
  sandboxType?: string;
  mainGameItem?: EpicMainGameRef;
  metadata?: EpicCatalogItemMetadata;
}

interface EpicLibraryPageResponse {
  records?: EpicLibraryRecord[];
  responseMetadata?: {
    nextCursor?: string;
  };
}

interface EpicGraphQlAchievementSummaryItem {
  totalUnlocked?: number;
  totalXP?: number;
  sandboxId?: string;
  product?: {
    name?: string;
    slug?: string;
  };
  productAchievements?: {
    totalAchievements?: number;
    totalProductXP?: number;
  };
}

interface EpicGraphQlResponse {
  data?: {
    PlayerProfile?: {
      playerProfile?: {
        achievementsSummaries?: {
          data?: EpicGraphQlAchievementSummaryItem[];
        };
      };
    };
  };
}

interface AxiosErrorLike {
  message?: string;
  code?: string;
  response?: {
    status?: number;
    data?: unknown;
  };
}

interface PreparedEpicGameCandidate {
  item: EpicLibraryRecord;
  appId: string;
  title: string;
  tallCover?: string;
  wideBanner?: string;
  metaDescription: string;
  metaDeveloper: string;
  partnerHandoffMeta: Partial<GamePlatformOwnership> | null;
}

function isInvalidEpicTitle(title: string): boolean {
  return (
    !title ||
    title === 'Live' ||
    EPIC_HEX_HASH_TITLE_RE.test(title) ||
    EPIC_UUID_TITLE_RE.test(title)
  );
}

function normalizeEpicBearerToken(rawToken: string): string {
  const trimmed = rawToken.trim();
  if (/^bearer\s+/i.test(trimmed)) {
    return trimmed.replace(/^bearer\s+/i, '').trim();
  }
  return trimmed;
}

function parseTokenExpiryMs(raw: string | number | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw < 1e12 ? raw * 1000 : raw;
  }
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatSafeEpicError(err: unknown): string {
  if (err && typeof err === 'object') {
    const axErr = err as AxiosErrorLike;
    const parts: string[] = [];
    if (typeof axErr.response?.status === 'number') {
      parts.push(`HTTP ${axErr.response.status}`);
    }
    if (typeof axErr.code === 'string' && axErr.code.trim()) {
      parts.push(axErr.code.trim());
    }
    if (typeof axErr.message === 'string' && axErr.message.trim()) {
      parts.push(axErr.message.trim());
    }
    if (parts.length > 0) {
      return parts.join(' - ');
    }
  }
  if (typeof err === 'string' && err.trim()) {
    return err.trim();
  }
  return 'Epic Games request failed';
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      await worker(items[idx]);
    }
  });
  await Promise.all(workers);
}

/**
 * Extracts partner launcher handoff metadata (e.g., EA App / Origin `ThirdPartyManagedApp`,
 * `PartnerLinkType`, and `RegistryPath`) from Epic `metadata.customAttributes`.
 */
export function extractEpicPartnerHandoffMetadata(
  ...sources: Array<EpicCustomAttributes | undefined | null>
): Partial<GamePlatformOwnership> | null {
  const attrMap = new Map<string, string>();
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    if (Array.isArray(src)) {
      for (const entry of src) {
        const key = String(entry?.key || '').trim().toLowerCase();
        const val = String(entry?.value || '').trim();
        if (key && val && !attrMap.has(key)) {
          attrMap.set(key, val);
        }
      }
    } else {
      for (const [rawKey, rawVal] of Object.entries(src)) {
        const key = String(rawKey || '').trim().toLowerCase();
        const val =
          typeof rawVal === 'string'
            ? rawVal.trim()
            : rawVal && typeof rawVal === 'object' && typeof rawVal.value === 'string'
            ? rawVal.value.trim()
            : '';
        if (key && val && !attrMap.has(key)) {
          attrMap.set(key, val);
        }
      }
    }
  }

  if (attrMap.size === 0) return null;

  const thirdPartyManagedApp = attrMap.get('thirdpartymanagedapp');
  const partnerLinkType = attrMap.get('partnerlinktype');
  const registryPath = attrMap.get('registrypath');

  const handoff =
    normalizeChainedHandoffId(thirdPartyManagedApp) ||
    normalizeChainedHandoffId(partnerLinkType);
  if (!handoff) return null;

  return {
    chainedLauncherHandoff: handoff,
    externalStorefrontHandoff: handoff,
    chainedHandoffTopology: 'partner_launcher_link',
    ...(registryPath ? { epicPartnerRegistryPath: registryPath } : {}),
    ...(handoff !== 'bnet'
      ? { platforms: { windows: true, mac: false, linux: false } }
      : {}),
  };
}

export class EpicIntegrationService {
  private getLibraryBaseUrl(): string {
    return getDevProxyBaseForRoute('epicLibrary');
  }

  private getCatalogBaseUrl(): string {
    return getDevProxyBaseForRoute('epicCatalog');
  }

  private getGraphQLBaseUrl(): string {
    return buildDevProxyUrlForRoute('epicGraphql', '/graphql');
  }

  /**
   * Extracts clean 32-character Epic Account ID from a URL or raw string
   */
  extractEpicAccountId(input?: string): string | null {
    if (!input) return null;
    const clean = input.trim();
    // Matches 32-character hex ID (e.g. from https://store.epicgames.com/u/a1b2c3d4e5f60718293a4b5c6d7e8f90)
    const match = clean.match(/([a-f0-9]{32})/i);
    if (match) return match[1].toLowerCase();
    return clean;
  }

  /**
   * Fetches user achievement progress from official launcher GraphQL service
   */
  async fetchUserAchievements(
    epicAccountId: string,
    accessToken?: string
  ): Promise<Record<string, StoreAchievementSummary>> {
    const cleanAccountId = this.extractEpicAccountId(epicAccountId);
    if (!cleanAccountId) return {};

    try {
      const cleanToken = accessToken ? normalizeEpicBearerToken(accessToken) : '';

      // 1. In Electron desktop runtime, delegate to native IPC if available
      if (hasElectronBridge() && window.electronAPI?.fetchEpicAchievements) {
        const nativeMap = await window.electronAPI.fetchEpicAchievements(
          cleanAccountId,
          accessToken
        );
        if (nativeMap && Object.keys(nativeMap).length > 0) {
          cacheUserEpicAchievements(nativeMap);
          return nativeMap;
        }
        // In Electron, OAuth tokens stay encrypted in main-process storage (renderer sees '' or
        // 'saved_in_electron'). Do not issue an unauthenticated direct GraphQL POST from renderer.
        if (!cleanToken || cleanToken === 'saved_in_electron') {
          return nativeMap || {};
        }
      }

      // 2. Fetch directly or via proxy
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

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher',
      };
      if (cleanToken && cleanToken !== 'saved_in_electron') {
        headers['Authorization'] = `bearer ${cleanToken}`;
      }

      const res = await axios.post<EpicGraphQlResponse>(
        this.getGraphQLBaseUrl(),
        {
          query,
          variables: {
            epicAccountId: cleanAccountId,
            locale: 'en-US',
          },
        },
        { headers, timeout: 10000 }
      );

      const dataList =
        res.data?.data?.PlayerProfile?.playerProfile?.achievementsSummaries?.data || [];
      const achievementsMap: Record<string, StoreAchievementSummary> = {};

      for (const item of dataList) {
        const total = item.productAchievements?.totalAchievements || 0;
        const unlocked = item.totalUnlocked || 0;
        const totalXP = item.productAchievements?.totalProductXP || 0;
        const earnedXP = item.totalXP || 0;
        const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;
        const isMastered = total > 0 && unlocked >= total;

        const summary: StoreAchievementSummary = {
          unlocked,
          total,
          percentage,
          xp: { earned: earnedXP, total: totalXP },
          isMastered,
          source: 'live_cloud_graphql',
          syncedAt: new Date().toISOString(),
        };

        if (item.sandboxId) achievementsMap[item.sandboxId.toLowerCase()] = summary;
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

      cacheUserEpicAchievements(achievementsMap);
      return achievementsMap;
    } catch (err: unknown) {
      console.warn('Epic achievements fetch failed:', formatSafeEpicError(err));
      return {};
    }
  }

  /**
   * Exchanges an authorization code for an Epic Games access token via Main-Process IPC
   * so OAuth client secrets never reside in the renderer bundle.
   */
  async exchangeCodeForToken(
    authorizationCode: string
  ): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    displayName?: string;
    accountId?: string;
  } | null> {
    try {
      const cleanCode = authorizationCode.trim();
      if (!cleanCode) return null;

      if (hasElectronBridge() && window.electronAPI?.exchangeCode) {
        const res = await window.electronAPI.exchangeCode('epic', cleanCode);
        if (res?.success) {
          const tokenData = res.tokenData;
          return {
            accessToken: tokenData?.access_token || 'saved_in_electron',
            displayName: tokenData?.displayName || res.accountName,
            accountId: tokenData?.account_id || res.accountId,
          };
        }
      }
    } catch (err: unknown) {
      console.warn('Epic token exchange failed:', formatSafeEpicError(err));
    }
    return null;
  }

  /**
   * Renews an expired Epic Games session via Main-Process IPC without bundling OAuth Basic credentials.
   * Preserves any games / authoritativeComplete / transientOffline state returned by `syncStore('epic')`
   * so callers do not invoke a redundant second `syncStore('epic')` call.
   */
  async renewAccessToken(
    refreshToken: string
  ): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    displayName?: string;
    accountId?: string;
    games?: CanonicalGame[];
    authoritativeComplete?: boolean;
    transientOffline?: boolean;
  } | null> {
    try {
      const cleanToken = refreshToken.trim();
      if (!cleanToken) return null;

      if (hasElectronBridge() && window.electronAPI?.syncStore) {
        const res = await window.electronAPI.syncStore('epic', {
          epicRefreshToken: cleanToken,
        });
        if (res?.transientOffline) {
          return {
            accessToken: 'saved_in_electron',
            displayName: res.accountName,
            accountId: res.accountId,
            games: [],
            authoritativeComplete: false,
            transientOffline: true,
          };
        }
        if (res?.success) {
          return {
            accessToken: 'saved_in_electron',
            displayName: res.accountName,
            accountId: res.accountId,
            games: Array.isArray(res.games) ? res.games : [],
            authoritativeComplete: Boolean(res.authoritativeComplete),
          };
        }
      }
    } catch (err: unknown) {
      console.warn('Epic token renewal failed:', formatSafeEpicError(err));
    }
    return null;
  }

  /**
   * Fetches real owned games from Epic Games Library API, tracking whether all
   * cursor pages finished cleanly with verified response shapes and zero errors.
   */
  async fetchOwnedGamesDetailed(
    accessToken: string
  ): Promise<{ games: CanonicalGame[]; authoritativeComplete: boolean }> {
    const cleanToken = normalizeEpicBearerToken(accessToken || '');
    if (!cleanToken || cleanToken === 'saved_in_electron') {
      return { games: [], authoritativeComplete: false };
    }

    const games: CanonicalGame[] = [];
    const seenIds = new Set<string>();
    let completedAllPages = false;

    try {
      let cursor: string | undefined = undefined;
      let hasMore = true;
      let pageCount = 0;
      let fetchedAnyPage = false;
      let allPagesValid = true;
      let hadUnresolvedCatalogFailure = false;

      const candidateRecords: EpicLibraryRecord[] = [];
      const namespaceToCatalogIds = new Map<string, Set<string>>();

      while (hasMore && pageCount < 100) {
        const fetchUrl: string = cursor
          ? `${this.getLibraryBaseUrl()}/library/api/public/items?includeMetadata=true&cursor=${encodeURIComponent(cursor)}`
          : `${this.getLibraryBaseUrl()}/library/api/public/items?includeMetadata=true`;

        const response = await axios.get<EpicLibraryPageResponse>(fetchUrl, {
          headers: { Authorization: `Bearer ${cleanToken}` },
          timeout: 10000,
        });

        // Fail closed on HTTP 200 HTML login redirects or malformed non-object payloads
        const payload = response.data;
        if (!payload || typeof payload !== 'object' || !Array.isArray(payload.records)) {
          allPagesValid = false;
          console.warn(
            `Epic library page ${pageCount + 1} returned malformed or non-JSON payload; marking sync non-authoritative.`
          );
          break;
        }

        fetchedAnyPage = true;

        for (const item of payload.records) {
          // 1. Skip non-game records & private sandboxes
          if (!item.appName || item.appName === '1' || item.sandboxType === 'PRIVATE') continue;

          // 2. Skip Unreal Engine Marketplace assets & developer tools
          if (
            item.namespace === 'ue' ||
            item.namespace === '89efe5924d3d467c839449ab6ab52e7f' ||
            item.namespace?.startsWith('ue-')
          ) {
            continue;
          }

          // 3. Skip real DLCs & add-ons (only if mainGameItem targets a distinct parent item)
          const rawCatalogId = String(item.catalogItemId || '').trim();
          const mainGameRef = item.metadata?.mainGameItem || item.mainGameItem;
          const mainGameTargetId = String(mainGameRef?.id || '').trim();
          const mainGameNamespace = String(mainGameRef?.namespace || '').trim();
          const hasRealMainGame = Boolean(
            (mainGameTargetId || mainGameNamespace) &&
              (!rawCatalogId || !mainGameTargetId || mainGameTargetId !== rawCatalogId)
          );
          if (hasRealMainGame) continue;

          // 4. Skip non-application item types
          const itemType = (item.metadata?.itemType || '').toUpperCase();
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
            ].includes(itemType)
          ) {
            continue;
          }

          // 5. Skip non-game category paths using `/`-delimited segment parsing (preserving games+mods / games+vault base games)
          const categories = item.metadata?.categories || [];
          const categorySegments = new Set<string>();
          for (const c of categories) {
            const rawPath = String(c?.path || '').toLowerCase();
            for (const seg of rawPath.split('/')) {
              const trimmedSeg = seg.trim();
              if (trimmedSeg) categorySegments.add(trimmedSeg);
            }
          }
          const hasGamesSegment = categorySegments.has('games');
          const hasHardAddonSegment = [
            'addons',
            'add-on',
            'addon',
            'dlc',
            'digitalextras',
            'consumable',
            'audience',
            'engines',
            'editors',
            'plugins',
          ].some((seg) => categorySegments.has(seg));
          const hasSoftModOrVaultOnly =
            !hasGamesSegment && (categorySegments.has('mods') || categorySegments.has('vault'));
          if (hasHardAddonSegment || hasSoftModOrVaultOnly) continue;

          // 6. Structurally skip microtransaction / cosmetic add-on appNames
          if (STRUCTURAL_EPIC_ADDON_APPNAME_RE.test(item.appName)) continue;

          candidateRecords.push(item);

          const rawTitle = (item.metadata?.title || '').trim();
          if (isInvalidEpicTitle(rawTitle) && item.namespace && item.catalogItemId) {
            let idSet = namespaceToCatalogIds.get(item.namespace);
            if (!idSet) {
              idSet = new Set<string>();
              namespaceToCatalogIds.set(item.namespace, idSet);
            }
            idSet.add(item.catalogItemId);
          }
        }

        const nextCursor =
          typeof payload.responseMetadata?.nextCursor === 'string' &&
          payload.responseMetadata.nextCursor.trim()
            ? payload.responseMetadata.nextCursor
            : undefined;
        cursor = nextCursor;
        hasMore = Boolean(cursor);
        pageCount++;
      }

      // Batch `/bulk/items` catalog lookups per namespace (chunks of 50, bounded concurrency 4)
      const resolvedCatalogMeta = new Map<string, EpicCatalogItemMetadata>();
      const failedCatalogKeys = new Set<string>();

      const catalogBatches: Array<{ namespace: string; ids: string[] }> = [];
      for (const [namespace, idSet] of namespaceToCatalogIds.entries()) {
        const allIds = Array.from(idSet);
        for (let i = 0; i < allIds.length; i += EPIC_CATALOG_BATCH_SIZE) {
          catalogBatches.push({
            namespace,
            ids: allIds.slice(i, i + EPIC_CATALOG_BATCH_SIZE),
          });
        }
      }

      await runWithConcurrency(
        catalogBatches,
        EPIC_CATALOG_BATCH_CONCURRENCY,
        async ({ namespace, ids }) => {
          try {
            const idQuery = ids.map((id) => `id=${encodeURIComponent(id)}`).join('&');
            const catUrl = `${this.getCatalogBaseUrl()}/catalog/api/shared/namespace/${encodeURIComponent(namespace)}/bulk/items?${idQuery}&includeDLCDetails=true&includeMainGameDetails=true`;
            const cRes = await axios.get<Record<string, EpicCatalogItemMetadata>>(catUrl, {
              headers: { Authorization: `Bearer ${cleanToken}` },
              timeout: 8000,
            });
            const data = cRes.data;
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
              for (const cid of ids) {
                failedCatalogKeys.add(`${namespace}::${cid}`);
              }
              return;
            }
            for (const cid of ids) {
              const meta = data[cid];
              if (meta && typeof meta === 'object') {
                resolvedCatalogMeta.set(`${namespace}::${cid}`, meta);
              }
            }
          } catch {
            for (const cid of ids) {
              failedCatalogKeys.add(`${namespace}::${cid}`);
            }
          }
        }
      );

      // Resolve metadata and run structural filters across all candidates
      const preparedCandidates: PreparedEpicGameCandidate[] = [];

      for (const item of candidateRecords) {
        const rawCatalogId = String(item.catalogItemId || '').trim();
        let title = (item.metadata?.title || '').trim();
        let keyImages: EpicKeyImage[] = item.metadata?.keyImages || [];
        let metaDescription = item.metadata?.description || '';
        let metaDeveloper = item.metadata?.developer || '';
        let catalogFallbackCustomAttributes: EpicCustomAttributes | undefined;

        if (isInvalidEpicTitle(title) && item.namespace && item.catalogItemId) {
          const lookupKey = `${item.namespace}::${item.catalogItemId}`;
          const meta = resolvedCatalogMeta.get(lookupKey);
          const catalogLookupFailed = failedCatalogKeys.has(lookupKey);
          let resolvedFromCatalog = false;

          if (meta) {
            const metaCategorySegments = new Set<string>();
            for (const c of meta.categories || []) {
              for (const seg of String(c?.path || '').toLowerCase().split('/')) {
                const trimmedSeg = seg.trim();
                if (trimmedSeg) metaCategorySegments.add(trimmedSeg);
              }
            }
            const metaMainId = String(meta.mainGameItem?.id || '').trim();
            const metaMainNs = String(meta.mainGameItem?.namespace || '').trim();
            const hasMetaParentGame = Boolean(
              (metaMainId || metaMainNs) &&
                (!rawCatalogId || !metaMainId || metaMainId !== rawCatalogId)
            );
            const isDlc =
              ['addons', 'add-on', 'addon', 'dlc', 'digitalextras', 'consumable'].some((seg) =>
                metaCategorySegments.has(seg)
              ) || hasMetaParentGame;
            if (isDlc) continue;

            if (meta.title) {
              title = meta.title.trim();
              resolvedFromCatalog = true;
            }
            metaDescription = meta.description || metaDescription;
            metaDeveloper = meta.developer || metaDeveloper;
            keyImages = meta.keyImages || keyImages;
            catalogFallbackCustomAttributes = meta.customAttributes;
          }

          if (!resolvedFromCatalog && !item.metadata?.title) {
            if (catalogLookupFailed) {
              hadUnresolvedCatalogFailure = true;
            }
            continue;
          }
          if (catalogLookupFailed && isInvalidEpicTitle(title)) {
            hadUnresolvedCatalogFailure = true;
          }
        }

        // If title is missing, pure hex hash, or raw UUID, NEVER allow as a game entry
        if (isInvalidEpicTitle(title)) {
          continue;
        }

        const tallCover =
          keyImages.find((img: EpicKeyImage) => img.type === 'DieselGameBoxTall')?.url ||
          keyImages.find((img: EpicKeyImage) => img.type === 'OfferImageTall')?.url;
        const wideBanner =
          keyImages.find((img: EpicKeyImage) => img.type === 'DieselGameBox')?.url || tallCover;
        const appId = item.catalogItemId || item.appName || '';

        // Reject unmapped structural codenames lacking public metadata
        if (
          hasStructuralEpicCodenameTraits({
            id: `epic-${appId}`,
            title,
            isVerifiedEntitlement: true,
            headerImage: wideBanner,
            capsuleImage: tallCover,
            shortDescription: metaDescription,
            developers: metaDeveloper ? [metaDeveloper] : [],
            platforms: [
              {
                platformId: 'epic',
                platformGameId: String(appId),
                installed: false,
              },
            ],
          })
        ) {
          continue;
        }

        // Structurally filter cosmetic/currency/battle-pass add-on packs
        if (STRUCTURAL_EPIC_ADDON_TITLE_RE.test(title)) {
          continue;
        }

        const partnerHandoffMeta = extractEpicPartnerHandoffMetadata(
          item.metadata?.customAttributes,
          catalogFallbackCustomAttributes
        );

        preparedCandidates.push({
          item,
          appId,
          title,
          tallCover,
          wideBanner,
          metaDescription,
          metaDeveloper,
          partnerHandoffMeta,
        });
      }

      // Bounded-concurrency Steam title matching (deduplicated across identical titles)
      const uniqueTitlesByKey = new Map<string, string>();
      for (const cand of preparedCandidates) {
        const key = cand.title.toLowerCase().trim();
        if (key && !uniqueTitlesByKey.has(key)) {
          uniqueTitlesByKey.set(key, cand.title);
        }
      }
      const matchedSteamAppIdByKey = new Map<string, number | undefined>();
      await runWithConcurrency(
        Array.from(uniqueTitlesByKey.entries()),
        EPIC_STEAM_MATCH_CONCURRENCY,
        async ([key, title]) => {
          const matchedId = (await steamMatcher.matchGameToSteam(title)) || undefined;
          matchedSteamAppIdByKey.set(key, matchedId);
        }
      );

      // Assemble canonical games in deterministic original order
      for (const cand of preparedCandidates) {
        const {
          item,
          appId,
          title,
          tallCover,
          wideBanner,
          metaDescription,
          metaDeveloper,
          partnerHandoffMeta,
        } = cand;
        const steamAppId = matchedSteamAppIdByKey.get(title.toLowerCase().trim());

        const epicHeaderCandidate = wideBanner || '';
        const epicCapsuleCandidate = tallCover || undefined;
        const browseAssets = steamAppId ? steamApi.peekCachedBrowseAssets(steamAppId) : null;
        const steamHeaderCandidate = steamAppId
          ? browseAssets?.headerImage ||
            `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/header.jpg`
          : undefined;
        const steamCapsuleCandidate = steamAppId
          ? browseAssets?.capsuleImage ||
            (!isKnownDeadSteamCover(steamAppId)
              ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/library_600x900_2x.jpg`
              : undefined)
          : undefined;

        const artworkCtx: ArtworkRecoveryContext = {
          gameId: steamAppId ? `steam-${steamAppId}` : `epic-${appId}`,
          title,
          steamAppId,
        };
        const headerImg =
          reconcileHeaderImage(epicHeaderCandidate, steamHeaderCandidate, artworkCtx) ||
          epicHeaderCandidate ||
          steamHeaderCandidate ||
          '';
        const capsuleImg =
          reconcileCapsuleImage(epicCapsuleCandidate, steamCapsuleCandidate, {
            ...artworkCtx,
            headerUrl: headerImg,
          }) || '';

        const constructedGame: CanonicalGame = {
          id: steamAppId ? `steam-${steamAppId}` : `epic-${appId}`,
          title,
          sortTitle: getAlphabeticalTitleSortKey(title, true),
          steamAppId,
          isVerifiedEntitlement: true,
          platforms: [
            {
              platformId: 'epic',
              platformGameId: appId,
              ...(item.appName ? { storefrontAppId: item.appName } : {}),
              ...(item.namespace ? { namespace: item.namespace } : {}),
              ...(item.catalogItemId ? { catalogItemId: item.catalogItemId } : {}),
              installed: false,
              playtimeMinutes: 0,
              ...(partnerHandoffMeta || {}),
            },
          ],
          headerImage: headerImg,
          capsuleImage: capsuleImg,
          shortDescription: metaDescription || '',
          releaseDate: item.metadata?.releaseDate || '',
          developers: metaDeveloper ? [metaDeveloper] : [],
          publishers: item.metadata?.publisher ? [item.metadata.publisher] : [],
          genres: [],
          tags: [],
        };

        if (!seenIds.has(constructedGame.id)) {
          seenIds.add(constructedGame.id);
          games.push(constructedGame);
        }
      }

      completedAllPages =
        fetchedAnyPage && allPagesValid && !hasMore && !hadUnresolvedCatalogFailure;
    } catch (err: unknown) {
      completedAllPages = false;
      const axErr = (err && typeof err === 'object' ? err : {}) as AxiosErrorLike;
      if (axErr.response?.status === 401) {
        throw err;
      }
      console.warn('Failed to fetch Epic library records:', formatSafeEpicError(err));
    }
    return { games, authoritativeComplete: completedAllPages };
  }

  /**
   * Fetches real owned games from Epic Games Library API
   */
  async fetchOwnedGames(accessToken: string): Promise<CanonicalGame[]> {
    const { games } = await this.fetchOwnedGamesDetailed(accessToken);
    return games;
  }

  /**
   * Connect and synchronize Epic Games account
   */
  async connectAccount(
    credentials: StorefrontCredentials
  ): Promise<{
    accountName: string;
    avatarUrl?: string;
    games: CanonicalGame[];
    updatedCredentials?: StorefrontCredentials;
    authoritativeComplete?: boolean;
  }> {
    let accountName = credentials.epicAccountId?.trim() || 'Epic Games User';
    let targetAccountId = this.extractEpicAccountId(credentials.epicAccountId) || '';
    const avatarUrl = DEFAULT_EPIC_AVATAR_URL;
    let accessToken: string | undefined = undefined;
    const updatedCredentials: StorefrontCredentials = { ...credentials };

    let liveGames: CanonicalGame[] = [];
    let authoritativeComplete = false;
    let isElectronTransientOffline = false;
    let syncedViaElectronRenewal = false;

    // 1. If we have a refresh token, check if access token needs renewal
    if (credentials.epicRefreshToken) {
      const expiresAtMs = parseTokenExpiryMs(credentials.epicTokenExpiresAt);
      const isExpired = expiresAtMs !== null ? Date.now() > expiresAtMs - 60000 : false;

      if (!credentials.epicToken || isExpired) {
        const renewed = await this.renewAccessToken(credentials.epicRefreshToken);
        if (renewed?.accessToken) {
          accessToken = renewed.accessToken;
          if (renewed.displayName) accountName = renewed.displayName;
          if (renewed.accountId) targetAccountId = renewed.accountId;
          updatedCredentials.epicToken = renewed.accessToken;
          if (renewed.refreshToken) updatedCredentials.epicRefreshToken = renewed.refreshToken;
          if (renewed.expiresIn) {
            updatedCredentials.epicTokenExpiresAt = new Date(
              Date.now() + renewed.expiresIn * 1000
            ).toISOString();
          }
          if (
            renewed.accessToken === 'saved_in_electron' &&
            (renewed.transientOffline ||
              renewed.games !== undefined ||
              renewed.authoritativeComplete !== undefined)
          ) {
            syncedViaElectronRenewal = true;
            if (renewed.transientOffline) {
              isElectronTransientOffline = true;
            } else {
              if (Array.isArray(renewed.games)) liveGames = renewed.games;
              authoritativeComplete = Boolean(renewed.authoritativeComplete);
            }
          }
        }
      } else {
        const trimmedToken = credentials.epicToken.trim();
        accessToken =
          trimmedToken === 'saved_in_electron'
            ? 'saved_in_electron'
            : normalizeEpicBearerToken(trimmedToken);
      }
    } else if (credentials.epicToken) {
      accessToken = credentials.epicToken.trim();

      // If token looks like an authorization code, exchange it via IPC
      if (
        accessToken !== 'saved_in_electron' &&
        accessToken.length > 25 &&
        !accessToken.toLowerCase().startsWith('bearer ') &&
        !accessToken.startsWith('eg1~')
      ) {
        const tokenRes = await this.exchangeCodeForToken(accessToken);
        if (tokenRes?.accessToken) {
          accessToken = tokenRes.accessToken;
          if (tokenRes.displayName) {
            accountName = tokenRes.displayName;
          }
          if (tokenRes.accountId) {
            targetAccountId = tokenRes.accountId;
          }
          updatedCredentials.epicToken = tokenRes.accessToken;
          if (tokenRes.refreshToken) updatedCredentials.epicRefreshToken = tokenRes.refreshToken;
          if (tokenRes.expiresIn) {
            updatedCredentials.epicTokenExpiresAt = new Date(
              Date.now() + tokenRes.expiresIn * 1000
            ).toISOString();
          }
        } else {
          throw new Error(
            'Failed to exchange authorization code with Epic Games. The code may have expired or already been used. Please click "Re-open Sign-In Window" to generate a fresh code.'
          );
        }
      } else if (accessToken !== 'saved_in_electron') {
        accessToken = normalizeEpicBearerToken(accessToken);
      }
    }

    // 2. Fetch live owned games (which also resolves `targetAccountId` for saved-in-Electron sessions)
    if (accessToken && accessToken !== 'saved_in_electron') {
      try {
        const ownedRes = await this.fetchOwnedGamesDetailed(accessToken);
        liveGames = ownedRes.games;
        authoritativeComplete = ownedRes.authoritativeComplete;
      } catch (err: unknown) {
        // If 401 and refresh token is available, try one renewal attempt
        if (updatedCredentials.epicRefreshToken) {
          try {
            const renewed = await this.renewAccessToken(updatedCredentials.epicRefreshToken);
            if (renewed?.displayName) accountName = renewed.displayName;
            if (renewed?.accountId) targetAccountId = renewed.accountId;

            if (renewed?.accessToken && renewed.accessToken !== 'saved_in_electron') {
              accessToken = renewed.accessToken;
              updatedCredentials.epicToken = renewed.accessToken;
              if (renewed.refreshToken) updatedCredentials.epicRefreshToken = renewed.refreshToken;
              if (renewed.expiresIn) {
                updatedCredentials.epicTokenExpiresAt = new Date(
                  Date.now() + renewed.expiresIn * 1000
                ).toISOString();
              }
              const retryRes = await this.fetchOwnedGamesDetailed(accessToken);
              liveGames = retryRes.games;
              authoritativeComplete = retryRes.authoritativeComplete;
            } else if (renewed?.accessToken === 'saved_in_electron') {
              accessToken = 'saved_in_electron';
              updatedCredentials.epicToken = 'saved_in_electron';
              if (
                renewed.transientOffline ||
                renewed.games !== undefined ||
                renewed.authoritativeComplete !== undefined
              ) {
                if (renewed.transientOffline) {
                  isElectronTransientOffline = true;
                } else {
                  if (Array.isArray(renewed.games)) liveGames = renewed.games;
                  authoritativeComplete = Boolean(renewed.authoritativeComplete);
                }
              } else if (hasElectronBridge() && window.electronAPI?.syncStore) {
                const ipcSync = await window.electronAPI.syncStore('epic');
                if (ipcSync?.accountName) accountName = ipcSync.accountName;
                if (ipcSync?.accountId) targetAccountId = ipcSync.accountId;
                if (ipcSync?.transientOffline) {
                  isElectronTransientOffline = true;
                } else if (ipcSync?.success) {
                  if (Array.isArray(ipcSync.games)) liveGames = ipcSync.games;
                  authoritativeComplete = Boolean(ipcSync.authoritativeComplete);
                }
              }
            }
          } catch (renewErr: unknown) {
            console.warn('Epic token renewal fallback failed:', formatSafeEpicError(renewErr));
          }
        }
        if (liveGames.length === 0 && !authoritativeComplete && !isElectronTransientOffline) {
          console.warn('Live Epic games fetch failed:', formatSafeEpicError(err));
        }
      }
    } else if (
      accessToken === 'saved_in_electron' &&
      !syncedViaElectronRenewal &&
      hasElectronBridge() &&
      window.electronAPI?.syncStore
    ) {
      try {
        const ipcSync = await window.electronAPI.syncStore('epic');
        if (ipcSync?.accountName) accountName = ipcSync.accountName;
        if (ipcSync?.accountId) targetAccountId = ipcSync.accountId;
        if (ipcSync?.transientOffline) {
          isElectronTransientOffline = true;
        } else if (ipcSync?.success) {
          if (Array.isArray(ipcSync.games)) {
            liveGames = ipcSync.games;
          }
          authoritativeComplete = Boolean(ipcSync.authoritativeComplete);
        }
      } catch (ipcErr: unknown) {
        console.warn('Electron Epic sync fallback failed:', formatSafeEpicError(ipcErr));
      }
    }

    if (targetAccountId && !updatedCredentials.epicAccountId) {
      updatedCredentials.epicAccountId = targetAccountId;
    }

    if (isElectronTransientOffline) {
      return {
        accountName,
        avatarUrl,
        games: [],
        updatedCredentials,
        authoritativeComplete: false,
      };
    }

    // 3. Fetch user achievements AFTER syncStore('epic') resolves targetAccountId
    const achievementsMap = targetAccountId
      ? await this.fetchUserAchievements(targetAccountId, accessToken)
      : {};

    let baseGames: CanonicalGame[] = [];
    if (liveGames.length > 0 || authoritativeComplete) {
      baseGames = liveGames.map((g) => ({
        ...g,
        isVerifiedEntitlement: true,
      }));
    } else {
      authoritativeComplete = false;
      baseGames = [];
    }

    // Apply achievements to the resolved user library (matching namespace/sandboxId, title, platformGameId, catalogItemId, and game.id)
    const gamesWithAchievements = baseGames.map((game) => {
      const epicPlat = game.platforms.find((p) => p.platformId === 'epic');
      if (!epicPlat) return game;

      const normTitle = game.title
        .toLowerCase()
        .replace(/[:\-–—]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const achievement =
        (epicPlat.namespace ? achievementsMap[epicPlat.namespace.toLowerCase()] : undefined) ||
        achievementsMap[game.title.toLowerCase().trim()] ||
        achievementsMap[normTitle] ||
        (epicPlat.platformGameId
          ? achievementsMap[epicPlat.platformGameId.toLowerCase()]
          : undefined) ||
        (epicPlat.catalogItemId
          ? achievementsMap[epicPlat.catalogItemId.toLowerCase()]
          : undefined) ||
        achievementsMap[game.id.toLowerCase()];

      if (achievement) {
        return {
          ...game,
          platforms: game.platforms.map((p) =>
            p.platformId === 'epic'
              ? {
                  ...p,
                  achievements:
                    reconcileAchievementSummaries(p.achievements, achievement, {
                      title: game.title,
                      store: 'epic',
                    }) || achievement,
                }
              : p
          ),
        };
      }
      return game;
    });

    return {
      accountName,
      avatarUrl,
      games: gamesWithAchievements,
      updatedCredentials,
      authoritativeComplete,
    };
  }
}

export const epicIntegration = new EpicIntegrationService();
