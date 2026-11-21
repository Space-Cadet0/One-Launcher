/**
 * Steam detailed achievement provider:
 * - Global rarity percentages (`ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002`)
 * - Canonical Steam schema resolution (`IPlayerService/GetGameAchievements/v1`, HTML, Global Pct)
 * - Live Electron IPC + Steam Community XML + schema fallback with O(1) global-pct lookup,
 *   URL-encoded vanity IDs, and canonical ISO 8601 `unlockedAt` timestamps.
 */

import axios from 'axios';
import { CanonicalGame, StoreAchievementSummary } from '../../contracts/game';
import { DetailedAchievement, StorefrontAchievementsData } from '../../contracts/achievement';
import { getDevProxyBaseForRoute } from '../network/browserDevProxy';
import { onlineLifecycleManager } from '../network/onlineLifecycleManager';
import { RequestPriority, requestScheduler } from '../network/requestScheduler';
import { steamAchievementsService } from '../steam/steamAchievementsService';
import {
  KNOWN_USER_STEAM_ACHIEVEMENTS,
  getKnownSteamAchievements,
} from '../storage/knownGameAchievements';
import {
  ACHIEVEMENT_CACHE_VERSION,
  classifyRarityTier,
  deduplicateDetailedAchievements,
  extractLiveAchievementsList,
  extractXmlTag,
  getErrorMessage,
  normalizeAchievementMatchKey,
  normalizeAchievementProgress,
  normalizeUnlockTimestamp,
  type RawStoreAchievementRecord,
  type SteamGameAchievementApiItem,
  type SteamGlobalPctItem,
} from './achievementNormalizer';

export function parseSteamCommunityHtml(html: string, appId: number): DetailedAchievement[] {
  const results: DetailedAchievement[] = [];
  const rowMatches = html.split(/<div class="achieveRow\s*"/i);
  for (let i = 1; i < rowMatches.length; i++) {
    const block = rowMatches[i];
    const imgMatch = block.match(/<img[^>]+src="([^">]+)"/i);
    const nameMatch = block.match(/<h3>([^<]+)<\/h3>/i);
    const descMatch = block.match(/<h5>([^<]*)<\/h5>/i);
    const pctMatch = block.match(/<div class="achievePercent">([0-9.]+)%<\/div>/i);

    if (nameMatch) {
      const name = nameMatch[1].trim();
      const desc = descMatch ? descMatch[1].trim() : '';
      const icon = imgMatch
        ? imgMatch[1].trim()
        : `https://shared.fastly.steamstatic.com/community_assets/images/apps/${appId}/header.jpg`;
      const pctVal = pctMatch ? parseFloat(pctMatch[1]) : undefined;

      results.push({
        id: `steam:${appId}:${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
        apiName: name.toUpperCase().replace(/[^A-Z0-9]/g, '_'),
        name,
        description: desc || undefined,
        unlocked: false,
        iconUnlockedUrl: icon,
        iconLockedUrl: icon,
        globalPercentage: pctVal,
        rarityTier: pctVal !== undefined ? classifyRarityTier(pctVal) : undefined,
        isSecret: !desc,
        storefrontId: 'steam',
      });
    }
  }
  return results;
}

export async function fetchSteamGlobalPercentages(appId: number): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const url = `${getDevProxyBaseForRoute('steamApi')}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/?gameid=${appId}`;
    const res = await requestScheduler.schedule(
      url,
      () => axios.get(url, { timeout: 6000 }),
      RequestPriority.P0_INTERACTIVE,
      'api.steampowered.com'
    );
    const list = (
      res.data as { achievementpercentages?: { achievements?: SteamGlobalPctItem[] } } | undefined
    )?.achievementpercentages?.achievements;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item.name) {
          const pct = parseFloat(String(item.percent ?? ''));
          const rounded = !isNaN(pct) ? Math.round(pct * 10) / 10 : 0;
          map.set(item.name.toLowerCase(), rounded);
        }
      }
    }
  } catch (err: unknown) {
    console.warn(
      `[AchievementDetailService] Global percentages fetch warning for Steam ${appId}:`,
      getErrorMessage(err)
    );
  }
  return map;
}

export async function fetchSteamCanonicalSchemaForAppId(
  appId: number
): Promise<DetailedAchievement[]> {
  const steamApiBase = getDevProxyBaseForRoute('steamApi');
  const steamCommunityBase = getDevProxyBaseForRoute('steamCommunity');

  // Primary zero-auth official REST JSON schema: IPlayerService/GetGameAchievements/v1
  try {
    const gameAchUrl = `${steamApiBase}/IPlayerService/GetGameAchievements/v1/?appid=${appId}&language=english`;
    const gameAchRes = await requestScheduler.schedule(
      gameAchUrl,
      () => axios.get(gameAchUrl, { timeout: 6000 }),
      RequestPriority.P0_INTERACTIVE,
      'api.steampowered.com'
    );
    const gameAchList = (
      gameAchRes.data as { response?: { achievements?: SteamGameAchievementApiItem[] } } | undefined
    )?.response?.achievements;
    if (Array.isArray(gameAchList) && gameAchList.length > 0) {
      return gameAchList.map((item: SteamGameAchievementApiItem, idx: number) => {
        const apiName = String(item.internal_name || `ACH_${idx + 1}`).trim();
        const rawPct = parseFloat(String(item.player_percent_unlocked ?? ''));
        const pctVal = !isNaN(rawPct) ? Math.round(rawPct * 10) / 10 : undefined;
        const rawIcon = String(item.icon || '').trim();
        const rawGrayIcon = String(item.icon_gray || '').trim();
        const resolveIconUrl = (src: string): string => {
          if (!src) {
            return `https://shared.fastly.steamstatic.com/community_assets/images/apps/${appId}/header.jpg`;
          }
          if (/^https?:\/\//i.test(src)) return src;
          if (src.startsWith('//')) return `https:${src}`;
          return `https://shared.fastly.steamstatic.com/community_assets/images/apps/${appId}/${src.replace(/^\/+/, '')}`;
        };
        const iconUnlockedUrl = resolveIconUrl(rawIcon);
        const iconLockedUrl = rawGrayIcon ? resolveIconUrl(rawGrayIcon) : iconUnlockedUrl;

        return {
          id: `steam:${appId}:${apiName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
          apiName,
          name: String(item.localized_name || apiName),
          description: String(item.localized_desc || '').trim() || undefined,
          unlocked: false,
          iconUnlockedUrl,
          iconLockedUrl,
          globalPercentage: pctVal,
          rarityTier: pctVal !== undefined ? classifyRarityTier(pctVal) : undefined,
          isSecret: Boolean(item.hidden),
          storefrontId: 'steam',
        };
      });
    }
  } catch (err: unknown) {
    console.warn(
      `[AchievementDetailService] IPlayerService schema fetch warning for AppID ${appId}:`,
      getErrorMessage(err)
    );
  }

  // Secondary fallback (also keeps offline achieveRow HTML fixtures working)
  try {
    const liveHtmlUrl = `${steamCommunityBase}/stats/${appId}/achievements/`;
    const res = await requestScheduler.schedule(
      liveHtmlUrl,
      () => axios.get(liveHtmlUrl, { timeout: 4000, responseType: 'text' }),
      RequestPriority.P0_INTERACTIVE,
      'steamcommunity.com'
    );
    const html = typeof res.data === 'string' ? res.data : '';
    if (html.includes('achieveRow')) {
      const parsed = parseSteamCommunityHtml(html, appId);
      if (parsed.length > 0) {
        return parsed;
      }
    }
  } catch (err: unknown) {
    console.warn(
      `[AchievementDetailService] Live public schema fetch warning for AppID ${appId}:`,
      getErrorMessage(err)
    );
  }

  // Tertiary zero-auth fallback: ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/
  try {
    const url = `${steamApiBase}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/?gameid=${appId}`;
    const apiRes = await requestScheduler.schedule(
      url,
      () => axios.get(url, { timeout: 6000 }),
      RequestPriority.P0_INTERACTIVE,
      'api.steampowered.com'
    );
    const apiList = (
      apiRes.data as { achievementpercentages?: { achievements?: SteamGlobalPctItem[] } } | undefined
    )?.achievementpercentages?.achievements;
    if (Array.isArray(apiList) && apiList.length > 0) {
      return apiList.map((item: SteamGlobalPctItem, idx: number) => {
        const rawApiName = String(item.name || `ACH_${idx + 1}`);
        const strippedApi = rawApiName.replace(/^ACH_/i, '');
        const rawPct = parseFloat(String(item.percent ?? ''));
        const pctVal = !isNaN(rawPct) ? Math.round(rawPct * 10) / 10 : undefined;
        const humanName = strippedApi
          .replace(/_/g, ' ')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/\b\w/g, (c) => c.toUpperCase());
        const iconUrl = `https://shared.fastly.steamstatic.com/community_assets/images/apps/${appId}/header.jpg`;

        return {
          id: `steam:${appId}:${rawApiName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
          apiName: rawApiName,
          name: humanName,
          description: undefined,
          unlocked: false,
          iconUnlockedUrl: iconUrl,
          iconLockedUrl: iconUrl,
          globalPercentage: pctVal,
          rarityTier: pctVal !== undefined ? classifyRarityTier(pctVal) : undefined,
          isSecret: false,
          storefrontId: 'steam',
        };
      });
    }
  } catch {
    // No schema available
  }

  return [];
}

export interface SteamProviderDependencies {
  fetchGlobalPercentages: (appId: number) => Promise<Map<string, number>>;
  getCanonicalSchema: (game: CanonicalGame) => Promise<DetailedAchievement[]>;
}

export async function fetchSteamDetailedAchievementsProvider(
  appId: number,
  gameTitle: string,
  deps: SteamProviderDependencies,
  existingSummary?: StoreAchievementSummary,
  canonicalSchema?: DetailedAchievement[],
  lazyCanonicalSchema?: () => Promise<DetailedAchievement[]>
): Promise<StorefrontAchievementsData | null> {
  const creds = steamAchievementsService.getActiveSteamCredentials();
  const knownUser =
    getKnownSteamAchievements(appId) ||
    steamAchievementsService.getCachedAchievements(appId) ||
    KNOWN_USER_STEAM_ACHIEVEMENTS[appId];
  const resolvedSummaryUnlocked = Math.max(
    existingSummary?.unlocked ?? 0,
    knownUser ? knownUser.unlocked : 0
  );
  const resolvedSummaryTotal = Math.max(
    existingSummary?.total ?? 0,
    knownUser ? knownUser.total : 0
  );
  const ipcExistingSummary =
    existingSummary || knownUser
      ? { unlocked: resolvedSummaryUnlocked, total: resolvedSummaryTotal }
      : undefined;
  let ipcSchemaFallbackResult: StorefrontAchievementsData | null = null;

  // 1. Unified Electron Main-Process Provider (SSR renderContext.queryData + Web API + Bottle Binary VDF)
  if (typeof window !== 'undefined' && window.electronAPI?.getStoreAchievements) {
    try {
      const liveRes = await window.electronAPI.getStoreAchievements({
        platformId: 'steam',
        storefrontId: 'steam',
        gameId: `steam-${appId}`,
        platformGameId: String(appId),
        steamAppId: appId,
        steamId: creds.steamId || undefined,
        apiKey: creds.apiKey || undefined,
        existingSummary: ipcExistingSummary,
        title: gameTitle,
      });
      const { list: rawSteamList, envelope: steamEnv } = extractLiveAchievementsList(liveRes);
      if (rawSteamList && rawSteamList.length > 0) {
        const achievements: DetailedAchievement[] = rawSteamList.map(
          (rawAch: RawStoreAchievementRecord, idx: number): DetailedAchievement => {
            const globalPct =
              typeof rawAch.globalPercentage === 'number'
                ? rawAch.globalPercentage
                : typeof rawAch.rarity === 'number'
                  ? rawAch.rarity
                  : undefined;
            const unlockedIcon =
              rawAch.iconUnlockedUrl ||
              rawAch.unlockedIconUrl ||
              `https://shared.fastly.steamstatic.com/community_assets/images/apps/${appId}/header.jpg`;
            const lockedIcon = rawAch.iconLockedUrl || rawAch.lockedIconUrl || unlockedIcon;
            const validProgress = normalizeAchievementProgress(rawAch.progress);
            const normalizedUnlockedAt = normalizeUnlockTimestamp(
              rawAch.unlockedAt ?? rawAch.unlockTime
            );

            return {
              id: rawAch.id || `steam:${appId}:${rawAch.apiName || idx}`,
              apiName: String(rawAch.apiName || rawAch.id || `STEAM_ACH_${idx + 1}`),
              name: String(rawAch.name || rawAch.apiName || `Achievement #${idx + 1}`),
              description: rawAch.description || undefined,
              unlocked: Boolean(rawAch.unlocked || rawAch.isUnlocked),
              unlockedAt: normalizedUnlockedAt,
              iconUnlockedUrl: unlockedIcon,
              iconLockedUrl: lockedIcon,
              globalPercentage: globalPct,
              rarityTier: globalPct !== undefined ? classifyRarityTier(globalPct) : undefined,
              ...(validProgress ? { progress: validProgress } : {}),
              isSecret: Boolean(rawAch.isSecret || rawAch.hidden || rawAch.isHidden),
              ...(typeof rawAch.isBaseGame === 'boolean' ? { isBaseGame: rawAch.isBaseGame } : {}),
              ...(rawAch.achievementSetId ? { achievementSetId: rawAch.achievementSetId } : {}),
              storefrontId: 'steam',
            };
          }
        );

        const total = achievements.length;
        const exactUnlocked = achievements.filter((a) => a.unlocked).length;
        const summaryUnlocked = resolvedSummaryUnlocked;
        const envPrecision = steamEnv?.unlockPrecision;
        const isSummaryOnly =
          envPrecision === 'summary_count_only' || (exactUnlocked === 0 && summaryUnlocked > 0);
        const unlocked = isSummaryOnly
          ? Math.max(
              summaryUnlocked,
              typeof steamEnv?.unlocked === 'number' ? steamEnv.unlocked : 0
            )
          : exactUnlocked;
        const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;

        const ipcResult: StorefrontAchievementsData = deduplicateDetailedAchievements({
          storefrontId: 'steam',
          storefrontName: 'Steam',
          total,
          unlocked,
          percentage,
          isMastered: total > 0 && unlocked >= total,
          achievements,
          syncedAt: steamEnv?.syncedAt || new Date().toISOString(),
          source: steamEnv?.source || (isSummaryOnly ? 'schema_fallback' : 'live_cloud'),
          unlockPrecision: isSummaryOnly ? 'summary_count_only' : 'exact',
          supportsAchievements: true,
          cacheVersion: ACHIEVEMENT_CACHE_VERSION,
        });

        if (
          steamEnv?.source === 'schema_fallback' &&
          exactUnlocked === 0 &&
          Boolean(creds.steamId) &&
          onlineLifecycleManager.isOnline()
        ) {
          ipcSchemaFallbackResult = ipcResult;
        } else {
          return ipcResult;
        }
      }
    } catch {
      // Fall through to browser XML / canonical schema fallback
    }
  }

  if (onlineLifecycleManager.isOnline()) {
    const steamId = creds.steamId;

    let globalPercentages = new Map<string, number>();
    try {
      globalPercentages = await deps.fetchGlobalPercentages(appId);
    } catch {
      // Proceed without global rarity percentages
    }

    if (steamId) {
      // Pre-build O(1) normalized lookup map (replaces O(A * G) nested scan)
      const normalizedGlobalPct = new Map<string, number>();
      for (const [k, v] of globalPercentages.entries()) {
        const normKey = normalizeAchievementMatchKey(k);
        if (normKey && !normalizedGlobalPct.has(normKey)) {
          normalizedGlobalPct.set(normKey, v);
        }
      }

      const isNumeric = /^\d{17}$/.test(steamId);
      const pathSegment = isNumeric
        ? `profiles/${steamId}`
        : `id/${encodeURIComponent(steamId)}`;
      const communityBase = getDevProxyBaseForRoute('steamCommunity');
      const xmlUrl = `${communityBase}/${pathSegment}/stats/${appId}/?xml=1`;

      try {
        const res = await requestScheduler.schedule(
          xmlUrl,
          () => axios.get(xmlUrl, { timeout: 8000, responseType: 'text' }),
          RequestPriority.P0_INTERACTIVE,
          'steamcommunity.com'
        );
        let xml = typeof res.data === 'string' ? res.data : '';

        // Handle older Steam titles with custom Steam Community friendlyURL redirects
        if (!xml.includes('<achievement closed=') && !xml.includes('<achievements>')) {
          const friendlyMatch = xml.match(/steamcommunity\.com\/stats\/([^/"'?]+)\/achievements/i);
          if (friendlyMatch?.[1]) {
            try {
              const friendlyUrl = `${communityBase}/${pathSegment}/stats/${encodeURIComponent(
                friendlyMatch[1]
              )}/?xml=1`;
              const friendlyRes = await requestScheduler.schedule(
                friendlyUrl,
                () => axios.get(friendlyUrl, { timeout: 8000, responseType: 'text' }),
                RequestPriority.P0_INTERACTIVE,
                'steamcommunity.com'
              );
              if (typeof friendlyRes.data === 'string') {
                xml = friendlyRes.data;
              }
            } catch {
              // Ignore friendly redirect fallback errors
            }
          }
        }

        if (xml.includes('<achievement closed=') || xml.includes('<achievements>')) {
          const achievementBlocks = xml.split('<achievement closed="');
          const achievements: DetailedAchievement[] = [];

          for (let i = 1; i < achievementBlocks.length; i++) {
            const rawBlock = achievementBlocks[i];
            const isClosed = rawBlock.charAt(0) === '1';
            const innerBlock = rawBlock.substring(rawBlock.indexOf('>') + 1);

            const name = extractXmlTag(innerBlock, 'name');
            const apiName = extractXmlTag(innerBlock, 'apiname');
            const description = extractXmlTag(innerBlock, 'description');
            const iconClosed = extractXmlTag(innerBlock, 'iconClosed');
            const iconOpen = extractXmlTag(innerBlock, 'iconOpen');
            const unlockTimestampRaw = extractXmlTag(innerBlock, 'unlockTimestamp');
            const unlockTimestamp = unlockTimestampRaw
              ? parseInt(unlockTimestampRaw, 10)
              : undefined;

            let progress: DetailedAchievement['progress'] = undefined;
            const progressMatch = innerBlock.match(/<progress[^>]*>(\d+)\s*\/\s*(\d+)<\/progress>/i);
            if (progressMatch) {
              const current = parseInt(progressMatch[1], 10);
              const max = parseInt(progressMatch[2], 10);
              progress = normalizeAchievementProgress({ current, max });
            }

            const cleanKey = normalizeAchievementMatchKey(apiName || name);
            const globalPct = cleanKey ? normalizedGlobalPct.get(cleanKey) : undefined;

            achievements.push({
              id: `steam:${appId}:${apiName || name}`,
              apiName: apiName || name,
              name: name || apiName || `Achievement #${i}`,
              description: description || undefined,
              unlocked: isClosed,
              unlockedAt: normalizeUnlockTimestamp(unlockTimestamp),
              iconUnlockedUrl: iconClosed || iconOpen,
              iconLockedUrl: iconOpen || iconClosed,
              globalPercentage: globalPct,
              rarityTier: globalPct !== undefined ? classifyRarityTier(globalPct) : undefined,
              progress,
              isSecret: !description && Boolean(name),
              storefrontId: 'steam',
            });
          }

          const total = achievements.length;
          const unlocked = achievements.filter((a) => a.unlocked).length;
          const percentage = total > 0 ? Math.round((unlocked / total) * 100) : 0;

          return deduplicateDetailedAchievements({
            storefrontId: 'steam',
            storefrontName: 'Steam',
            total,
            unlocked,
            percentage,
            isMastered: total > 0 && unlocked >= total,
            achievements,
            syncedAt: new Date().toISOString(),
            source: 'live_cloud',
            unlockPrecision: 'exact',
            supportsAchievements: true,
            cacheVersion: ACHIEVEMENT_CACHE_VERSION,
          });
        }
      } catch (err: unknown) {
        console.warn(
          `[AchievementDetailService] Steam XML stats fetch failed for ${appId}:`,
          getErrorMessage(err)
        );
      }
    }
  }

  if (ipcSchemaFallbackResult) {
    return ipcSchemaFallbackResult;
  }

  // Fallback: If live SSR/XML failed or profile is private, use canonical schema without fabricating unlocks
  const schema =
    canonicalSchema && canonicalSchema.length > 0
      ? canonicalSchema
      : lazyCanonicalSchema
        ? await lazyCanonicalSchema()
        : onlineLifecycleManager.isOnline()
          ? await deps.getCanonicalSchema({
              id: `steam-${appId}`,
              title: gameTitle,
              sortTitle: gameTitle,
              steamAppId: appId,
              platforms: [],
              headerImage: '',
              capsuleImage: '',
              developers: [],
              publishers: [],
              genres: [],
              tags: [],
            })
          : [];

  const unlockedCount = resolvedSummaryUnlocked;
  const totalCount =
    schema.length > 0 ? schema.length : existingSummary?.total ?? (knownUser ? knownUser.total : 0);

  if (schema.length > 0) {
    const achievements: DetailedAchievement[] = schema.map((baseAch, idx) => ({
      ...baseAch,
      id: `steam:${appId}:${baseAch.apiName || idx}`,
      unlocked: Boolean(baseAch.unlocked),
      unlockedAt: normalizeUnlockTimestamp(baseAch.unlockedAt),
      storefrontId: 'steam',
    }));

    const exactUnlocked = achievements.filter((a) => a.unlocked).length;
    const effectiveUnlocked = exactUnlocked > 0 ? exactUnlocked : unlockedCount;
    const unlockPrecision: 'exact' | 'summary_count_only' =
      effectiveUnlocked > 0 && exactUnlocked === 0 ? 'summary_count_only' : 'exact';
    const percentage = totalCount > 0 ? Math.round((effectiveUnlocked / totalCount) * 100) : 0;

    return deduplicateDetailedAchievements({
      storefrontId: 'steam',
      storefrontName: 'Steam',
      total: totalCount,
      unlocked: effectiveUnlocked,
      percentage,
      isMastered: totalCount > 0 && effectiveUnlocked >= totalCount,
      achievements,
      syncedAt: existingSummary?.syncedAt || new Date().toISOString(),
      source: exactUnlocked > 0 ? 'live_cloud' : 'schema_fallback',
      unlockPrecision,
      supportsAchievements: true,
      cacheVersion: ACHIEVEMENT_CACHE_VERSION,
    });
  }

  const isOffline = !onlineLifecycleManager.isOnline();
  const hasKnownSteamAchievements = totalCount > 0 || unlockedCount > 0;
  const percentage = totalCount > 0 ? Math.round((unlockedCount / totalCount) * 100) : 0;
  return {
    storefrontId: 'steam',
    storefrontName: 'Steam',
    total: totalCount,
    unlocked: unlockedCount,
    percentage,
    isMastered: totalCount > 0 && unlockedCount >= totalCount,
    achievements: [],
    syncedAt: existingSummary?.syncedAt,
    source: 'schema_fallback',
    unlockPrecision: unlockedCount > 0 ? 'summary_count_only' : 'exact',
    supportsAchievements: hasKnownSteamAchievements || isOffline,
    schemaUnavailableOffline: hasKnownSteamAchievements || isOffline,
  };
}
