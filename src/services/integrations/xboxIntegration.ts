import type {
  CanonicalGame,
  GamePlatformOwnership,
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
  authoritativeComplete?: boolean;
  subscriptionChanged?: boolean;
}

export type XboxSyncCredentialsInput = StorefrontCredentials & {
  syncMode?: XboxGamePassSyncMode;
  forceRefresh?: boolean;
};

export function formatXboxSubscriptionDate(isoDate?: string | null): string | null {
  if (!isoDate || typeof isoDate !== 'string') return null;
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return null;
  const year = parsed.getUTCFullYear();
  if (year < 1980 || year >= 9990) return null;
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(parsed);
  } catch {
    return parsed.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
}

export interface XboxSyncModeCopySpec {
  legendLabel: string;
  playedModeLabel: string;
  playedModeDescription: string;
  fullCatalogLabel: string;
  fullCatalogDescription: string;
}

export function resolveXboxSyncModeCatalogCopy(
  subscription?: XboxSubscriptionSummary | null
): XboxSyncModeCopySpec {
  const legendLabel = 'Game Pass & Subscription Sync Mode';
  if (subscription?.hasActiveSubscription && subscription.hasPcCatalogAccess) {
    let activePcTierName = '';
    let shortTier = '';
    switch (subscription.tierId) {
      case 'ultimate':
        activePcTierName = 'Game Pass Ultimate PC';
        shortTier = 'Game Pass Ultimate';
        break;
      case 'pc':
        activePcTierName = 'PC Game Pass';
        shortTier = 'PC Game Pass';
        break;
      case 'premium':
        activePcTierName = 'Game Pass Premium PC';
        shortTier = 'Game Pass Premium';
        break;
      case 'essential':
        activePcTierName = 'Game Pass Essential PC';
        shortTier = 'Game Pass Essential';
        break;
      case 'ea_play':
        activePcTierName = 'EA Play PC';
        shortTier = 'EA Play';
        break;
      case 'ubisoft_classics':
        activePcTierName = 'Ubisoft+ Classics PC';
        shortTier = 'Ubisoft+ Classics';
        break;
      case 'starter':
        activePcTierName = 'PC Game Pass Starter';
        shortTier = 'PC Game Pass Starter';
        break;
      default: {
        const cleaned = String(subscription.tierDisplayName || '')
          .replace(/^Xbox\s+/i, '')
          .trim();
        if (cleaned) {
          shortTier = cleaned;
          activePcTierName = /\bpc\b/i.test(cleaned) ? cleaned : `${cleaned} PC`;
        } else {
          shortTier = 'Subscription';
          activePcTierName = 'Subscription';
        }
        break;
      }
    }
    const isPartnerOnlyTier =
      subscription.tierId === 'ea_play' || subscription.tierId === 'ubisoft_classics';
    return {
      legendLabel,
      playedModeLabel: isPartnerOnlyTier
        ? `Owned + Played ${shortTier} (Recommended)`
        : 'Owned + Played Game Pass (Recommended)',
      playedModeDescription: `Syncs permanent Microsoft Store purchases plus ${shortTier} titles you have played or installed locally.`,
      fullCatalogLabel: `Full ${activePcTierName} Catalog`,
      fullCatalogDescription: `Includes the entire active ${shortTier} Windows PC catalog alongside your permanent Microsoft Store purchases.`,
    };
  }

  if (subscription?.hasActiveSubscription && !subscription.hasPcCatalogAccess) {
    const consoleTier = subscription.tierDisplayName || 'Xbox Game Pass for Console';
    return {
      legendLabel,
      playedModeLabel: 'Owned + Installed PC Games (Recommended)',
      playedModeDescription:
        'Syncs permanent Microsoft Store / Xbox Play Anywhere PC purchases plus any Xbox PC titles installed locally.',
      fullCatalogLabel: 'Full Subscription Catalog (No PC Catalog)',
      fullCatalogDescription: `Your ${consoleTier} plan is console-only and does not include a Windows PC catalog; only permanent Microsoft Store / Xbox Play Anywhere PC purchases can be synced.`,
    };
  }

  if (subscription && !subscription.hasActiveSubscription) {
    return {
      legendLabel,
      playedModeLabel: 'Owned + Installed PC Games (Recommended)',
      playedModeDescription:
        'Syncs permanent Microsoft Store / Xbox Play Anywhere PC purchases plus any Xbox PC titles installed locally.',
      fullCatalogLabel: 'Full Subscription Catalog (No Active Subscription)',
      fullCatalogDescription:
        'No active PC Game Pass, EA Play, or Ubisoft+ subscription detected on this account. Requires an active PC subscription to sync the full catalog.',
    };
  }

  return {
    legendLabel,
    playedModeLabel: 'Owned + Played Game Pass (Recommended)',
    playedModeDescription:
      'Syncs permanent Microsoft Store purchases plus Game Pass or partner subscription titles you have played or installed locally.',
    fullCatalogLabel: 'Full Subscription Catalog',
    fullCatalogDescription:
      'Includes the entire active PC subscription catalog (Game Pass, EA Play, or Ubisoft+) alongside your permanent purchases.',
  };
}

function inferTierFromSatisfyingPassIds(
  satisfyingPassIds?: string[]
): { tierId: NonNullable<GamePlatformOwnership['subscriptionTierId']>; label: string } | null {
  if (!Array.isArray(satisfyingPassIds) || satisfyingPassIds.length === 0) return null;
  const upper = new Set(satisfyingPassIds.map((id) => String(id || '').trim().toUpperCase()));
  if (upper.has('CFQ7TTC0K5DH') && !upper.has('CFQ7TTC0KGQ8') && !upper.has('CFQ7TTC0KHS0')) {
    return { tierId: 'ea_play', label: 'EA Play' };
  }
  if (upper.has('CFQ7TTC0QH5H') && !upper.has('CFQ7TTC0KHS0')) {
    return { tierId: 'ubisoft_classics', label: 'Ubisoft+ Premium' };
  }
  if (upper.has('CFQ7TTBZT8LN') && !upper.has('CFQ7TTC0KHS0')) {
    return { tierId: 'ubisoft_classics', label: 'Ubisoft+ Classics' };
  }
  if (upper.has('CFQ7TTC0KHS0')) {
    return { tierId: 'ultimate', label: 'Game Pass Ultimate' };
  }
  if (upper.has('CFQ7TTC0KGQ8')) {
    return { tierId: 'pc', label: 'PC Game Pass' };
  }
  if (upper.has('CFQ7TTC0P85B')) {
    return { tierId: 'premium', label: 'Game Pass Premium' };
  }
  if (upper.has('CFQ7TTC0K5DJ')) {
    return { tierId: 'essential', label: 'Game Pass Essential' };
  }
  if (upper.has('CFQ7TTC0P85C') || upper.has('CFQ7TTC10QFD')) {
    return { tierId: 'starter', label: 'PC Game Pass Starter' };
  }
  return null;
}

export function resolveXboxDetailTierBadgeLabel(
  platformEntry: GamePlatformOwnership,
  fallback: 'GP' | 'Game Pass' = 'Game Pass'
): string {
  const rawTier = String(platformEntry.gamePassTier || '').trim();
  if (rawTier) {
    const shortened = rawTier.replace(/^Xbox\s+/i, '').trim();
    return shortened || rawTier;
  }
  switch (platformEntry.subscriptionTierId) {
    case 'ultimate':
      return 'Game Pass Ultimate';
    case 'pc':
      return 'PC Game Pass';
    case 'premium':
      return 'Game Pass Premium';
    case 'essential':
      return 'Game Pass Essential';
    case 'ea_play':
      return 'EA Play';
    case 'ubisoft_classics':
      return 'Ubisoft+ Classics';
    case 'starter':
      return 'PC Game Pass Starter';
    default: {
      const inferred = inferTierFromSatisfyingPassIds(platformEntry.satisfyingPassIds);
      return inferred ? inferred.label : fallback;
    }
  }
}

export function resolveXboxCompactTierBadge(platformEntry?: GamePlatformOwnership | null): {
  shortLabel: string;
  fullTitle: string;
} {
  const rawTier = String(platformEntry?.gamePassTier || '').trim();
  const inferred =
    !rawTier && (!platformEntry?.subscriptionTierId || platformEntry.subscriptionTierId === 'none')
      ? inferTierFromSatisfyingPassIds(platformEntry?.satisfyingPassIds)
      : null;
  const tierId =
    platformEntry?.subscriptionTierId && platformEntry.subscriptionTierId !== 'none'
      ? platformEntry.subscriptionTierId
      : inferred?.tierId;
  const fullTitle =
    rawTier ||
    inferred?.label ||
    (tierId && tierId !== 'none' && platformEntry
      ? resolveXboxDetailTierBadgeLabel(platformEntry, 'Game Pass')
      : 'Xbox Game Pass');

  if (!rawTier && (!tierId || tierId === 'none')) {
    return { shortLabel: 'GP', fullTitle };
  }

  if (tierId === 'ea_play' || /\bea\s*play\b/i.test(rawTier)) {
    return { shortLabel: 'EA', fullTitle };
  }
  if (tierId === 'ubisoft_classics' || /\bubisoft\b/i.test(rawTier)) {
    return { shortLabel: 'Ubi+', fullTitle };
  }
  if (tierId === 'ultimate' || /\bultimate\b/i.test(rawTier)) {
    return { shortLabel: 'GPU', fullTitle };
  }
  if (tierId === 'premium' || /\bpremium\b/i.test(rawTier)) {
    return { shortLabel: 'GPP', fullTitle };
  }
  if (tierId === 'essential' || /\b(?:essential|core)\b/i.test(rawTier)) {
    return { shortLabel: 'GPE', fullTitle };
  }
  if (tierId === 'starter' || /\bstarter\b/i.test(rawTier)) {
    return { shortLabel: 'GPS', fullTitle };
  }
  if (tierId === 'pc' || /^pc\s+game\s+pass$/i.test(rawTier)) {
    return { shortLabel: 'PCGP', fullTitle };
  }
  return { shortLabel: 'GP', fullTitle };
}

export class XboxIntegrationService {
  async syncXboxAccount(
    credentials?: XboxSyncCredentialsInput
  ): Promise<XboxSyncAccountResult> {
    if (typeof window !== 'undefined' && window.electronAPI?.syncStore) {
      const payload = credentials
        ? {
            ...credentials,
            ...(credentials.forceRefresh !== undefined
              ? { forceRefresh: Boolean(credentials.forceRefresh) }
              : {}),
          }
        : undefined;
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
        authoritativeComplete:
          res.authoritativeComplete !== undefined ? Boolean(res.authoritativeComplete) : true,
        subscriptionChanged: Boolean(res.subscriptionChanged),
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
      authoritativeComplete: true,
      subscriptionChanged: false,
    };
  }

  async connectAccount(
    credentials: XboxSyncCredentialsInput
  ): Promise<XboxSyncAccountResult> {
    return this.syncXboxAccount(credentials);
  }

  async fetchOwnedGames(
    credentials?: XboxSyncCredentialsInput
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
