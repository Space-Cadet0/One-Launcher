import type {
  CanonicalGame,
  StoreAchievementSummary,
  XboxGamePassSyncMode,
  XboxSubscriptionSummary,
} from '../../contracts/game';
import type { StorefrontCredentials } from '../../contracts/integration';
import { XBOX_USER_LIBRARY } from '../storage/storefrontLibraries';
import { steamMatcher } from '../steam/steamMatcher';
import { steamApi } from '../steam/steamApi';
import { RequestPriority } from '../network/requestScheduler';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import { isMicrosoftStoreCdnUrl, sanitizeStoreReleaseDate } from '../common/titleUtils';

export interface XboxSyncAccountResult {
  accountName: string;
  gamertag?: string;
  modernGamertag?: string;
  xuid?: string;
  avatarUrl?: string;
  gamerscore?: number;
  subscription?: XboxSubscriptionSummary;
  syncMode?: XboxGamePassSyncMode;
  games: CanonicalGame[];
  achievements?: Record<string, StoreAchievementSummary | unknown>;
  suppressedItems?: unknown[];
}

export class XboxIntegrationService {
  async syncXboxAccount(
    credentials?: StorefrontCredentials & { syncMode?: XboxGamePassSyncMode }
  ): Promise<XboxSyncAccountResult> {
    if (typeof window !== 'undefined' && window.electronAPI?.syncStore) {
      const payload = credentials ? { ...credentials } : undefined;
      const res = await window.electronAPI.syncStore('xbox', payload);
      if (!res || !res.success) {
        throw new Error(res?.error || 'Failed to synchronize Xbox / Game Pass library.');
      }

      const accountName =
        res.modernGamertag ||
        res.gamertag ||
        res.accountName ||
        credentials?.webToken ||
        'Xbox Live Account';

      const matchedSteamIds: number[] = [];
      let games: CanonicalGame[] = Array.isArray(res.games)
        ? res.games.map((g) => {
            const matchedAppId = g.isExplicitNonSteam
              ? undefined
              : g.steamAppId || steamMatcher.peekCachedMatch(g.title) || undefined;
            if (matchedAppId) {
              matchedSteamIds.push(matchedAppId);
            }
            const sanitizedDate = sanitizeStoreReleaseDate(g.releaseDate) || 'TBA';
            const nextEnriched = g.enrichedMetadata
              ? {
                  ...g.enrichedMetadata,
                  releaseDate:
                    sanitizeStoreReleaseDate(g.enrichedMetadata.releaseDate) || sanitizedDate,
                  ...(!g.enrichedMetadata.appId || Number(g.enrichedMetadata.appId) <= 0
                    ? {
                        metadataQuality:
                          g.enrichedMetadata.metadataQuality === 'scraped'
                            ? ('scraped' as const)
                            : ('storefront_native' as const),
                        enrichedSource: g.enrichedMetadata.enrichedSource || ('xbox' as const),
                      }
                    : {}),
                }
              : undefined;

            return {
              ...g,
              ...(matchedAppId ? { steamAppId: matchedAppId } : {}),
              releaseDate: sanitizedDate,
              ...(nextEnriched ? { enrichedMetadata: nextEnriched } : {}),
              isVerifiedEntitlement: g.isVerifiedEntitlement ?? true,
            };
          })
        : [];

      if (matchedSteamIds.length > 0 && onlineLifecycleManager.isOnline()) {
        const browseMap = await steamApi
          .fetchStoreBrowseAssetsBatch(matchedSteamIds, RequestPriority.P1_VIEWPORT)
          .catch(() => new Map());
        if (browseMap.size > 0) {
          games = games.map((g) => {
            if (!g.steamAppId) return g;
            const assets = browseMap.get(g.steamAppId) || steamApi.peekCachedBrowseAssets(g.steamAppId);
            if (!assets) return g;
            const nextCapsule =
              assets.capsuleImage && (!g.capsuleImage || isMicrosoftStoreCdnUrl(g.capsuleImage))
                ? assets.capsuleImage
                : g.capsuleImage;
            const nextHeader =
              assets.headerImage && (!g.headerImage || isMicrosoftStoreCdnUrl(g.headerImage))
                ? assets.headerImage
                : g.headerImage;
            const nextIcon =
              assets.iconUrl && (!g.iconUrl || isMicrosoftStoreCdnUrl(g.iconUrl))
                ? assets.iconUrl
                : g.iconUrl;
            if (
              nextCapsule === g.capsuleImage &&
              nextHeader === g.headerImage &&
              nextIcon === g.iconUrl
            ) {
              return g;
            }
            return {
              ...g,
              capsuleImage: nextCapsule,
              headerImage: nextHeader || g.headerImage,
              iconUrl: nextIcon,
            };
          });
        }
      }

      return {
        accountName,
        gamertag: res.gamertag || res.accountName,
        modernGamertag: res.modernGamertag || res.gamertag || res.accountName,
        xuid: res.xuid || res.accountId,
        avatarUrl: res.avatarUrl,
        gamerscore: typeof res.gamerscore === 'number' ? res.gamerscore : undefined,
        subscription: res.subscription,
        syncMode: res.syncMode,
        games,
        achievements: res.achievements as Record<string, StoreAchievementSummary | unknown> | undefined,
        suppressedItems: res.suppressedItems,
      };
    }

    const accountName = credentials?.webToken || 'Xbox Live Account';
    const avatarUrl = 'https://assets.xboxservices.com/assets/default-gamerpic.png';
    const games = XBOX_USER_LIBRARY.map((g) => ({
      ...g,
      isVerifiedEntitlement: true,
    }));
    return {
      accountName,
      gamertag: accountName,
      modernGamertag: accountName,
      avatarUrl,
      syncMode: credentials?.syncMode || 'owned_and_played',
      games,
    };
  }

  async connectAccount(
    credentials: StorefrontCredentials & { syncMode?: XboxGamePassSyncMode }
  ): Promise<XboxSyncAccountResult> {
    return this.syncXboxAccount(credentials);
  }

  async fetchOwnedGames(
    credentials?: StorefrontCredentials & { syncMode?: XboxGamePassSyncMode }
  ): Promise<CanonicalGame[]> {
    const res = await this.syncXboxAccount(credentials);
    return res.games;
  }

  async getXboxConnectionStatus(refreshSubscription = false) {
    if (typeof window !== 'undefined' && window.electronAPI?.getXboxStatus) {
      return window.electronAPI.getXboxStatus({ refreshSubscription });
    }
    return null;
  }

  async updateXboxSyncMode(
    syncMode: XboxGamePassSyncMode
  ): Promise<{ success: boolean; syncMode?: XboxGamePassSyncMode; error?: string }> {
    if (typeof window !== 'undefined' && window.electronAPI?.setXboxSyncMode) {
      return window.electronAPI.setXboxSyncMode(syncMode);
    }
    return { success: true, syncMode };
  }

  async fetchUserAchievements(
    pfns?: string[]
  ): Promise<Record<string, StoreAchievementSummary | unknown>> {
    if (typeof window !== 'undefined' && window.electronAPI?.fetchXboxAchievements) {
      try {
        return (await window.electronAPI.fetchXboxAchievements(pfns ? { pfns } : undefined)) || {};
      } catch (err) {
        console.warn('[XboxIntegration] Failed to fetch Xbox achievements:', err);
        return {};
      }
    }
    return {};
  }
}

export const xboxIntegration = new XboxIntegrationService();
