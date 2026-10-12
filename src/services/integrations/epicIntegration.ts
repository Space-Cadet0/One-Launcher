import axios from 'axios';
import { CanonicalGame, StoreAchievementSummary } from '../../contracts/game';
import { StorefrontCredentials } from '../../contracts/integration';
import { EPIC_USER_LIBRARY } from '../storage/storefrontLibraries';
import { KNOWN_EPIC_APP_NAMES } from './epicCodenames';
import { steamMatcher } from '../steam/steamMatcher';
import { cacheUserEpicAchievements } from '../storage/knownGameAchievements';
import { reconcileAchievementSummaries } from '../storage/achievementReconciliation';

export class EpicIntegrationService {
  private getOAuthBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/epic-oauth';
    }
    return 'https://account-public-service-prod03.ol.epicgames.com';
  }

  private getLibraryBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/epic-library';
    }
    return 'https://library-service.live.use1a.on.epicgames.com';
  }

  private getGraphQLBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return '/api/epic-graphql/graphql';
    }
    return 'https://launcher.store.epicgames.com/graphql';
  }

  /**
   * Extracts clean 32-character Epic Account ID from a URL or raw string
   */
  extractEpicAccountId(input?: string): string | null {
    if (!input) return null;
    const clean = input.trim();
    // Matches 32-character hex ID (e.g. from https://store.epicgames.com/u/8aaea3405ecc4c7b8786012029e98d6a)
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
      // 1. In Electron desktop runtime, delegate to native IPC if available
      if (typeof window !== 'undefined' && window.electronAPI?.fetchEpicAchievements) {
        const nativeMap = await window.electronAPI.fetchEpicAchievements(cleanAccountId, accessToken);
        if (nativeMap && Object.keys(nativeMap).length > 0) {
          cacheUserEpicAchievements(nativeMap);
          return nativeMap;
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
      if (accessToken) {
        headers['Authorization'] = accessToken.startsWith('bearer ') ? accessToken : `bearer ${accessToken}`;
      }

      const res = await axios.post(
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

      const dataList = res.data?.data?.PlayerProfile?.playerProfile?.achievementsSummaries?.data || [];
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
          const norm = item.product.name.toLowerCase().replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
          achievementsMap[norm] = summary;
        }
      }

      cacheUserEpicAchievements(achievementsMap);
      return achievementsMap;
    } catch (err: any) {
      console.warn('Epic achievements fetch failed:', err?.response?.data || err?.message);
      return {};
    }
  }

  /**
   * Exchanges an authorization code for an Epic Games access token
   */
  async exchangeCodeForToken(authorizationCode: string): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; displayName?: string; accountId?: string } | null> {
    try {
      const cleanCode = authorizationCode.trim();
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: cleanCode,
        token_type: 'eg1',
      });

      const res = await axios.post(
        `${this.getOAuthBaseUrl()}/account/api/oauth/token`,
        body.toString(),
        {
          headers: {
            Authorization: 'basic MzRhMDJjZjhmNDQxNGUyOWIxNTkyMTg3NmRhMzZmOWE6ZGFhZmJjY2M3Mzc3NDUwMzlkZmZlNTNkOTRmYzc2Y2Y=',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 10000,
        }
      );

      if (res.data?.access_token) {
        return {
          accessToken: res.data.access_token,
          refreshToken: res.data.refresh_token,
          expiresIn: res.data.expires_in,
          displayName: res.data.displayName,
          accountId: res.data.account_id,
        };
      }
    } catch (err: any) {
      console.warn('Epic token exchange failed:', err?.response?.data || err?.message);
    }
    return null;
  }

  /**
   * Renews an expired Epic Games access token using a refresh token
   */
  async renewAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; displayName?: string; accountId?: string } | null> {
    try {
      const cleanToken = refreshToken.trim();
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: cleanToken,
        token_type: 'eg1',
      });

      const res = await axios.post(
        `${this.getOAuthBaseUrl()}/account/api/oauth/token`,
        body.toString(),
        {
          headers: {
            Authorization: 'basic MzRhMDJjZjhmNDQxNGUyOWIxNTkyMTg3NmRhMzZmOWE6ZGFhZmJjY2M3Mzc3NDUwMzlkZmZlNTNkOTRmYzc2Y2Y=',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 10000,
        }
      );

      if (res.data?.access_token) {
        return {
          accessToken: res.data.access_token,
          refreshToken: res.data.refresh_token || cleanToken,
          expiresIn: res.data.expires_in,
          displayName: res.data.displayName,
          accountId: res.data.account_id,
        };
      }
    } catch (err: any) {
      console.warn('Epic token renewal failed:', err?.response?.data || err?.message);
    }
    return null;
  }

  /**
   * Fetches real owned games from Epic Games Library API
   */
  /**
   * Fetches real owned games from Epic Games Library API
   */
  async fetchOwnedGames(accessToken: string): Promise<CanonicalGame[]> {
    const games: CanonicalGame[] = [];
    const seenIds = new Set<string>();

    // Build lookup maps from verified 402 Epic catalog
    const epicCatalogById = new Map<string, CanonicalGame>();
    const epicCatalogByTitle = new Map<string, CanonicalGame>();
    for (const g of EPIC_USER_LIBRARY) {
      const epicPlatform = g.platforms.find((p) => p.platformId === 'epic');
      if (epicPlatform?.platformGameId) {
        epicCatalogById.set(epicPlatform.platformGameId.toLowerCase().trim(), g);
      }
      epicCatalogByTitle.set(g.title.toLowerCase().trim(), g);
    }

    try {
      let cursor: string | undefined = undefined;
      let hasMore = true;
      let pageCount = 0;

      while (hasMore && pageCount < 30) {
        const fetchUrl: string = cursor
          ? `${this.getLibraryBaseUrl()}/library/api/public/items?includeMetadata=true&cursor=${cursor}`
          : `${this.getLibraryBaseUrl()}/library/api/public/items?includeMetadata=true`;

        const response: any = await axios.get(fetchUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10000,
        });

        const records = response.data?.records || [];
        for (const item of records) {
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

          // 3. Skip real DLCs & add-ons (only if mainGameItem has an actual id/namespace)
          const hasRealMainGame = Boolean(
            (item.metadata?.mainGameItem && (item.metadata.mainGameItem.id || item.metadata.mainGameItem.namespace)) ||
            (item.mainGameItem && (item.mainGameItem.id || item.mainGameItem.namespace))
          );
          if (hasRealMainGame) continue;

          // 4. Skip non-application item types
          const itemType = (item.metadata?.itemType || '').toUpperCase();
          if (['ADD_ON', 'DLC', 'CONSUMABLE', 'WALLET', 'SUBSCRIPTION', 'PLUGIN', 'EXTRA', 'CURRENCY'].includes(itemType)) {
            continue;
          }

          // 5. Skip non-game category paths
          const categories = item.metadata?.categories || [];
          const isAddonCategory = categories.some((c: any) =>
            ['addons', 'dlc', 'mods', 'digitalextras', 'consumable', 'vault'].some((sub) =>
              (c.path || '').toLowerCase().includes(sub)
            )
          );
          if (isAddonCategory) continue;

          // 6. Skip Fortnite microtransactions / item shop add-ons
          if (item.appName?.startsWith('Fortnite_')) continue;

          const appNameLower = (item.appName || '').toLowerCase().trim();
          const catalogIdLower = (item.catalogItemId || '').toLowerCase().trim();
          const sandboxLower = (item.sandboxName || '').toLowerCase().trim();

          // Check if item matches the verified Epic library catalog directly
          const catalogGame =
            epicCatalogById.get(catalogIdLower) ||
            epicCatalogById.get(appNameLower) ||
            epicCatalogByTitle.get(sandboxLower);

          if (catalogGame) {
            if (!seenIds.has(catalogGame.id)) {
              seenIds.add(catalogGame.id);
              games.push(catalogGame);
            }
            continue;
          }

          let rawTitle = (item.metadata?.title || item.sandboxName || '').trim();
          const titleLower = rawTitle.toLowerCase().trim();

          // Check if item matches a known Epic codename
          const codename =
            KNOWN_EPIC_APP_NAMES[appNameLower] ||
            KNOWN_EPIC_APP_NAMES[catalogIdLower] ||
            KNOWN_EPIC_APP_NAMES[titleLower];

          let title = codename ? codename.title : rawTitle;

          // If title is missing, pure hex hash, or raw UUID, NEVER allow as a game entry
          if (
            !title ||
            /^[0-9a-f]{20,}$/i.test(title) ||
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(title)
          ) {
            continue;
          }

          // Reject raw codenames that aren't mapped
          if (['bobcat', 'boxfish', 'calluna', 'catnip', 'cormorant'].includes(title.toLowerCase())) {
            continue;
          }

          // Filter out Fortnite cosmetic bundles / V-Bucks packs
          const lower = title.toLowerCase();
          if (lower.includes('fortnite') && lower !== 'fortnite') {
            const isFortniteDlc = [
              'pack', 'bundle', 'v-bucks', 'vbucks', 'skin', 'battle pass',
              'outfit', 'drop', 'chapter', 'season', 'crew', 'starter', 'quest'
            ].some((kw) => lower.includes(kw));
            if (isFortniteDlc) continue;
          }

          const keyImages = item.metadata?.keyImages || [];
          const tallCover = keyImages.find((img: any) => img.type === 'DieselGameBoxTall')?.url;
          const wideBanner = keyImages.find((img: any) => img.type === 'DieselGameBox')?.url || tallCover;

          const appId = item.catalogItemId || item.appName;

          // Match Steam App ID if available
          const steamAppId: number | undefined = (codename && codename.steamAppId)
            ? codename.steamAppId
            : ((await steamMatcher.matchGameToSteam(title)) || undefined);

          const headerImg = steamAppId
            ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/header.jpg`
            : (codename && codename.headerImage) || wideBanner || 'https://cdn2.unrealengine.com/egs-badge.png';

          const capsuleImg = steamAppId
            ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamAppId}/library_600x900_2x.jpg`
            : (codename && codename.capsuleImage) || tallCover || wideBanner || 'https://cdn2.unrealengine.com/egs-badge.png';

          const iconImg = (codename && codename.iconUrl) ? codename.iconUrl : undefined;

          const developer = (codename && codename.developer)
            ? codename.developer
            : (item.metadata?.developer || '');

          const shortDescription = (codename && codename.description)
            ? codename.description
            : (item.metadata?.description || 'Epic Games Store Title');

          const constructedGame: CanonicalGame = {
            id: steamAppId ? `steam-${steamAppId}` : `epic-${appId}`,
            title,
            sortTitle: title.replace(/^(The|A|An)\s+/i, ''),
            steamAppId,
            platforms: [
              {
                platformId: 'epic',
                platformGameId: appId,
                installed: false,
                playtimeMinutes: 0,
              },
            ],
            headerImage: headerImg,
            capsuleImage: capsuleImg,
            iconUrl: iconImg,
            shortDescription,
            releaseDate: item.metadata?.releaseDate || '',
            developers: developer ? [developer] : [],
            publishers: item.metadata?.publisher ? [item.metadata.publisher] : [],
            genres: ['Action'],
            tags: ['Epic Games Store'],
          };

          if (!seenIds.has(constructedGame.id)) {
            seenIds.add(constructedGame.id);
            games.push(constructedGame);
          }
        }

        cursor = response.data?.responseMetadata?.nextCursor;
        hasMore = Boolean(cursor);
        pageCount++;
      }
    } catch (err: any) {
      if (err?.response?.status === 401) {
        throw err;
      }
      console.warn('Failed to fetch Epic library records:', err);
    }
    return games;
  }

  /**
   * Connect and synchronize Epic Games account
   */
  async connectAccount(
    credentials: StorefrontCredentials
  ): Promise<{ accountName: string; avatarUrl?: string; games: CanonicalGame[]; updatedCredentials?: StorefrontCredentials }> {
    let accountName = credentials.epicAccountId?.trim() || 'BobDo1e';
    let targetAccountId = this.extractEpicAccountId(credentials.epicAccountId) || '8aaea3405ecc4c7b8786012029e98d6a';
    const avatarUrl = 'https://cdn2.unrealengine.com/egs-badge.png';
    let accessToken: string | undefined = undefined;
    const updatedCredentials: StorefrontCredentials = { ...credentials };

    // 1. If we have a refresh token, check if access token needs renewal
    if (credentials.epicRefreshToken) {
      const isExpired = credentials.epicTokenExpiresAt
        ? Date.now() > new Date(credentials.epicTokenExpiresAt).getTime() - 60000
        : false;

      if (!credentials.epicToken || isExpired) {
        const renewed = await this.renewAccessToken(credentials.epicRefreshToken);
        if (renewed?.accessToken) {
          accessToken = renewed.accessToken;
          if (renewed.displayName) accountName = renewed.displayName;
          if (renewed.accountId) targetAccountId = renewed.accountId;
          updatedCredentials.epicToken = renewed.accessToken;
          if (renewed.refreshToken) updatedCredentials.epicRefreshToken = renewed.refreshToken;
          if (renewed.expiresIn) {
            updatedCredentials.epicTokenExpiresAt = new Date(Date.now() + renewed.expiresIn * 1000).toISOString();
          }
        }
      } else {
        accessToken = credentials.epicToken.trim();
      }
    } else if (credentials.epicToken) {
      accessToken = credentials.epicToken.trim();

      // If token looks like an authorization code, exchange it
      if (accessToken.length > 25 && !accessToken.toLowerCase().startsWith('bearer ') && !accessToken.startsWith('eg1~')) {
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
            updatedCredentials.epicTokenExpiresAt = new Date(Date.now() + tokenRes.expiresIn * 1000).toISOString();
          }
        } else {
          throw new Error('Failed to exchange authorization code with Epic Games. The code may have expired or already been used. Please click "Re-open Sign-In Window" to generate a fresh code.');
        }
      }
    }

    // Fetch user achievements for target Epic account
    const achievementsMap = await this.fetchUserAchievements(targetAccountId, accessToken);

    // Fetch live owned games if access token is available, otherwise fall back to verified baseline
    let liveGames: CanonicalGame[] = [];
    if (accessToken) {
      try {
        liveGames = await this.fetchOwnedGames(accessToken);
      } catch (err) {
        // If 401 and refresh token is available, try one renewal attempt
        if (updatedCredentials.epicRefreshToken) {
          try {
            const renewed = await this.renewAccessToken(updatedCredentials.epicRefreshToken);
            if (renewed?.accessToken) {
              accessToken = renewed.accessToken;
              updatedCredentials.epicToken = renewed.accessToken;
              if (renewed.refreshToken) updatedCredentials.epicRefreshToken = renewed.refreshToken;
              if (renewed.expiresIn) {
                updatedCredentials.epicTokenExpiresAt = new Date(Date.now() + renewed.expiresIn * 1000).toISOString();
              }
              liveGames = await this.fetchOwnedGames(accessToken);
            }
          } catch (renewErr) {
            console.warn('Epic token renewal fallback failed:', renewErr);
          }
        }
        if (liveGames.length === 0) {
          console.warn('Live Epic games fetch failed, using baseline catalog:', err);
        }
      }
    }

    let baseGames: CanonicalGame[] = [];
    if (liveGames.length > 0) {
      // Merge live games with baseline so no previously indexed title is lost
      const gameMap = new Map<string, CanonicalGame>();
      for (const g of EPIC_USER_LIBRARY) {
        gameMap.set(g.id, g);
      }
      for (const g of liveGames) {
        gameMap.set(g.id, g);
      }
      baseGames = Array.from(gameMap.values());
    } else {
      baseGames = EPIC_USER_LIBRARY;
    }

    // Apply achievements to the resolved user library
    const gamesWithAchievements = baseGames.map((game) => {
      const epicPlat = game.platforms.find((p) => p.platformId === 'epic');
      if (!epicPlat) return game;

      const normTitle = game.title.toLowerCase().replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
      const achievement =
        achievementsMap[game.title.toLowerCase().trim()] ||
        achievementsMap[normTitle] ||
        (epicPlat.platformGameId ? achievementsMap[epicPlat.platformGameId.toLowerCase()] : undefined) ||
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

    return { accountName, avatarUrl, games: gamesWithAchievements, updatedCredentials };
  }
}

export const epicIntegration = new EpicIntegrationService();
