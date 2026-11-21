import type { CriticScoreData, StorefrontReviewAnchor } from '../../../contracts/critic';
import type { CanonicalGame, GamePlatformOwnership } from '../../../contracts/game';
import type { ReviewScoreRoute, UserGameOverride } from '../../../contracts/override';
import type { StorefrontId } from '../../../contracts/platform';
import { Priority } from '../../network/requestScheduler';
import {
  getUserOverrideForGame,
  isUserOverrideCompatibleWithGame,
  loadUserOverrides,
} from '../../storage/userOverrideStorage';
import { normalizeCriticTitleKey } from '../criticUtils';
import { metacriticResolver } from '../metacriticResolver';
import { openCriticResolver } from '../openCriticResolver';
import { steamReviewResolver } from '../steamReviewResolver';
import { storefrontStarResolver } from '../storefrontStarResolver';
import { normalizeWikidataGogSlug } from '../wikidataBridge';
import {
  type CompiledReviewOverrideIndex,
  type CriticEntitlementPlatform,
  NON_OVERRIDE_EVENT_TYPES,
} from './criticServiceTypes';

export function extractValidGameOverrideFromEventDetail(
  detail: unknown
): { override: UserGameOverride; oldGame?: CanonicalGame } | null {
  if (!detail || typeof detail !== 'object') return null;
  const record = detail as Record<string, unknown>;
  const hasExplicitOverride = Boolean(record.override && typeof record.override === 'object');
  if (
    !hasExplicitOverride &&
    ('isHidden' in record ||
      'hiddenGameId' in record ||
      'unhiddenKey' in record ||
      (typeof record.type === 'string' && NON_OVERRIDE_EVENT_TYPES.has(record.type)))
  ) {
    return null;
  }

  const candidate = (hasExplicitOverride ? record.override : record) as Partial<UserGameOverride> & {
    type?: unknown;
  };
  if (!candidate || typeof candidate !== 'object') return null;
  if (typeof candidate.type === 'string' && NON_OVERRIDE_EVENT_TYPES.has(candidate.type)) {
    return null;
  }

  const hasValidIdentifier =
    (typeof candidate.gameId === 'string' && candidate.gameId.trim().length > 0) ||
    (typeof candidate.title === 'string' && candidate.title.trim().length > 0) ||
    (typeof candidate.steamAppId === 'number' && candidate.steamAppId > 0) ||
    (typeof candidate.platformGameId === 'string' && candidate.platformGameId.trim().length > 0);
  if (!hasValidIdentifier) {
    return null;
  }

  const oldGame =
    record.oldGame && typeof record.oldGame === 'object'
      ? (record.oldGame as CanonicalGame)
      : undefined;
  return { override: candidate as UserGameOverride, oldGame };
}

function parseOverrideUpdatedAt(ov?: UserGameOverride): number {
  if (!ov || typeof ov.updatedAt !== 'string') return 0;
  const parsed = Date.parse(ov.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getCompiledReviewOverrideIndex(
  memo: WeakMap<object, CompiledReviewOverrideIndex>,
  overrides: Record<string, UserGameOverride>
): CompiledReviewOverrideIndex {
  const existing = memo.get(overrides);
  if (existing) return existing;

  const byKey = new Map<string, UserGameOverride>();
  const byGameId = new Map<string, UserGameOverride[]>();
  const bySteamId = new Map<number, UserGameOverride[]>();
  const byLowerTitle = new Map<string, UserGameOverride[]>();
  const byNormTitle = new Map<string, UserGameOverride[]>();
  let hasAnyReviewOverride = false;

  const pushUnique = <K>(map: Map<K, UserGameOverride[]>, key: K, ov: UserGameOverride) => {
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    if (!list.includes(ov)) {
      list.push(ov);
    }
  };

  for (const [k, ov] of Object.entries(overrides)) {
    if (!ov || (ov.reviewScoreOverride === undefined && ov.reviewRoute === undefined)) {
      continue;
    }
    hasAnyReviewOverride = true;
    byKey.set(k, ov);
    if (ov.gameId) {
      pushUnique(byGameId, ov.gameId, ov);
    }
    if (typeof ov.steamAppId === 'number' && ov.steamAppId > 0) {
      pushUnique(bySteamId, ov.steamAppId, ov);
    }
    if (ov.title) {
      const lower = ov.title.toLowerCase().trim();
      if (lower) {
        pushUnique(byLowerTitle, lower, ov);
      }
      const norm = normalizeCriticTitleKey(ov.title);
      if (norm) {
        pushUnique(byNormTitle, norm, ov);
      }
    }
  }

  const sortNewestFirst = (a: UserGameOverride, b: UserGameOverride) =>
    parseOverrideUpdatedAt(b) - parseOverrideUpdatedAt(a);
  for (const list of byGameId.values()) list.sort(sortNewestFirst);
  for (const list of bySteamId.values()) list.sort(sortNewestFirst);
  for (const list of byLowerTitle.values()) list.sort(sortNewestFirst);
  for (const list of byNormTitle.values()) list.sort(sortNewestFirst);

  const compiled: CompiledReviewOverrideIndex = {
    hasAnyReviewOverride,
    byKey,
    byGameId,
    bySteamId,
    byLowerTitle,
    byNormTitle,
  };
  memo.set(overrides, compiled);
  return compiled;
}

export function findMatchingUserOverrideWithMemo(
  memo: WeakMap<object, CompiledReviewOverrideIndex>,
  steamAppId?: number | null,
  title?: string,
  gameId?: string,
  platforms?: CriticEntitlementPlatform[]
): UserGameOverride | undefined {
  try {
    const overrides = loadUserOverrides();
    if (!overrides) return undefined;

    const idx = getCompiledReviewOverrideIndex(memo, overrides);
    if (!idx.hasAnyReviewOverride) return undefined;

    const normalizedPlatforms: GamePlatformOwnership[] = Array.isArray(platforms)
      ? platforms
          .filter((p) => Boolean(p && p.platformId))
          .map((p) => ({
            platformId: p.platformId as StorefrontId,
            platformGameId: String(p.platformGameId || p.xboxProductId || p.storefrontAppId || ''),
            ...(p.xboxProductId ? { xboxProductId: p.xboxProductId } : {}),
            storefrontAppId: p.storefrontAppId,
            installed: false,
          }))
      : [];
    const hasPlatforms = normalizedPlatforms.length > 0;
    const parsedGameIdPlatform = (() => {
      if (!gameId) return null;
      const m = gameId.match(/^(steam|gog|epic|xbox|ea|ubisoft|battlenet|itch)[-_:](\S+)$/i);
      if (!m) return null;
      return { platformId: m[1].toLowerCase(), platformGameId: m[2].toLowerCase() };
    })();

    const synthGame: CanonicalGame = {
      id: gameId || (steamAppId ? `steam-${steamAppId}` : title ? `game-${title.toLowerCase().trim()}` : ''),
      title: title || '',
      sortTitle: title || '',
      steamAppId: typeof steamAppId === 'number' && steamAppId > 0 ? steamAppId : undefined,
      platforms: normalizedPlatforms,
      headerImage: '',
      developers: [],
      publishers: [],
      genres: [],
      tags: [],
    };

    const isOverrideCompatible = (ov?: UserGameOverride): boolean => {
      if (!ov) return false;
      if (!isUserOverrideCompatibleWithGame(ov, synthGame)) {
        return false;
      }

      const pinnedPlatId = String(
        ov.platformId || (ov.reviewRoute?.xboxProductId ? 'xbox' : '')
      ).toLowerCase();
      const pinnedPlatGameId = String(
        ov.platformGameId || (pinnedPlatId === 'xbox' ? ov.reviewRoute?.xboxProductId || '' : '')
      ).toLowerCase();

      if (hasPlatforms && pinnedPlatId && pinnedPlatGameId) {
        const ownsMatchingPlat = normalizedPlatforms.some(
          (p) =>
            String(p.platformId).toLowerCase() === pinnedPlatId &&
            (String(p.platformGameId).toLowerCase() === pinnedPlatGameId ||
              (Boolean(p.xboxProductId) &&
                String(p.xboxProductId).toLowerCase() === pinnedPlatGameId))
        );
        if (ownsMatchingPlat) return true;
        const hasSamePlatformWithoutMatch = normalizedPlatforms.some(
          (p) => String(p.platformId).toLowerCase() === pinnedPlatId
        );
        if (hasSamePlatformWithoutMatch) {
          return false;
        }
        if (gameId && ov.gameId && gameId === ov.gameId) {
          const onlyConflictingStore = normalizedPlatforms.every(
            (p) => String(p.platformId).toLowerCase() !== pinnedPlatId
          );
          if (onlyConflictingStore) return false;
          return true;
        }
        return false;
      }

      if (!hasPlatforms && parsedGameIdPlatform && pinnedPlatId && pinnedPlatGameId) {
        if (
          parsedGameIdPlatform.platformId === pinnedPlatId &&
          parsedGameIdPlatform.platformGameId !== pinnedPlatGameId
        ) {
          return false;
        }
        if (gameId && ov.gameId && gameId === ov.gameId) return true;
        if (
          parsedGameIdPlatform.platformId !== pinnedPlatId ||
          parsedGameIdPlatform.platformGameId !== pinnedPlatGameId
        ) {
          return false;
        }
      }

      return true;
    };

    const pickNewestCompatible = (
      candidates: Iterable<UserGameOverride | undefined>
    ): UserGameOverride | undefined => {
      let best: UserGameOverride | undefined;
      let bestTs = -1;
      for (const cand of candidates) {
        if (!cand || !isOverrideCompatible(cand)) continue;
        const ts = parseOverrideUpdatedAt(cand);
        if (!best || ts > bestTs) {
          best = cand;
          bestTs = ts;
        }
      }
      return best;
    };

    const directMatch = getUserOverrideForGame(synthGame, overrides);
    if (
      directMatch &&
      (directMatch.reviewScoreOverride !== undefined || directMatch.reviewRoute !== undefined) &&
      isOverrideCompatible(directMatch)
    ) {
      return directMatch;
    }

    if (gameId) {
      const directGameCandidates: Array<UserGameOverride | undefined> = [
        idx.byKey.get(gameId),
        ...(idx.byGameId.get(gameId) || []),
      ];
      const byGame = pickNewestCompatible(directGameCandidates);
      if (byGame) return byGame;
    }

    if (hasPlatforms) {
      const platCandidates: Array<UserGameOverride | undefined> = [];
      for (const p of normalizedPlatforms) {
        if (!p.platformGameId) continue;
        const pId = String(p.platformId);
        const pLower = pId.toLowerCase();
        const bare = String(p.platformGameId);
        const bareLower = bare.toLowerCase();
        platCandidates.push(
          idx.byKey.get(`${pId}:${bare}`),
          idx.byKey.get(`${pLower}:${bareLower}`),
          idx.byKey.get(`${pId}-${bare}`),
          idx.byKey.get(`${pLower}-${bareLower}`),
          ...(pLower === 'xbox' ? [idx.byKey.get(`xbox:${bare.toUpperCase()}`)] : [])
        );
      }
      const byPlat = pickNewestCompatible(platCandidates);
      if (byPlat) return byPlat;
    }

    if (typeof steamAppId === 'number' && steamAppId > 0) {
      const steamCandidates: Array<UserGameOverride | undefined> = [
        idx.byKey.get(`steam-${steamAppId}`),
        idx.byKey.get(String(steamAppId)),
        ...(idx.bySteamId.get(steamAppId) || []),
      ];
      const bySteam = pickNewestCompatible(steamCandidates);
      if (bySteam) return bySteam;
    }

    const lower = title ? title.toLowerCase().trim() : '';
    const normSearchTitle = title ? normalizeCriticTitleKey(title) : '';
    const titleFallbackCandidates: Array<UserGameOverride | undefined> = [];
    if (lower) {
      titleFallbackCandidates.push(
        idx.byKey.get(lower),
        idx.byKey.get(`title:${lower}`),
        ...(idx.byLowerTitle.get(lower) || [])
      );
    }
    if (normSearchTitle) {
      titleFallbackCandidates.push(...(idx.byNormTitle.get(normSearchTitle) || []));
    }
    const byTitle = pickNewestCompatible(titleFallbackCandidates);
    if (byTitle) return byTitle;
  } catch {}
  return undefined;
}

/**
 * Resolves a routed review score dynamically from its pinned provider, falling back to fallbackScore if offline/unreachable.
 */
export async function resolveRoutedCriticScore(
  route: ReviewScoreRoute,
  fallbackTitle: string,
  releaseYear?: number | string | null,
  fallbackScore?: CriticScoreData | null
): Promise<CriticScoreData | null> {
  if (!route || route.mode === 'unrated') {
    return null;
  }
  if (route.mode === 'static') {
    return fallbackScore ?? null;
  }

  const targetTitle = (route.targetTitle || fallbackTitle || '').trim();
  const yearNum =
    typeof releaseYear === 'number'
      ? releaseYear
      : releaseYear
      ? parseInt(String(releaseYear).match(/\b(19\d\d|20\d\d)\b/)?.[1] || '', 10) || undefined
      : undefined;

  try {
    if (route.source === 'metacritic' || route.source === 'metacritic_user') {
      const slug =
        route.metacriticSlug ||
        route.url?.match(/metacritic\.com\/game\/(?:pc\/)?([^/?#]+)/i)?.[1];
      const anchorArg = slug
        ? ({
            gameId: slug,
            storefront: 'steam',
            metacriticSlug: slug,
            metacriticUrl: route.url,
          } as StorefrontReviewAnchor & { gameId?: string })
        : undefined;
      const bundle = await metacriticResolver.resolveMetacritic(
        targetTitle,
        yearNum,
        anchorArg,
        Priority.P1_VIEWPORT
      );
      if (route.source === 'metacritic' && bundle?.critic && bundle.critic.score > 0) {
        return bundle.critic;
      }
      if (route.source === 'metacritic_user' && bundle?.user && bundle.user.score > 0) {
        return bundle.user;
      }
    } else if (route.source === 'opencritic') {
      const routeWithExternal = route as ReviewScoreRoute & { externalId?: string | number };
      const rawExternalId =
        routeWithExternal.externalId !== undefined && routeWithExternal.externalId !== null
          ? Number(String(routeWithExternal.externalId).trim())
          : 0;
      const urlOcId = Number(route.url?.match(/\/game\/(\d+)/i)?.[1] || 0);
      const ocId =
        (typeof route.openCriticId === 'number' &&
        Number.isSafeInteger(route.openCriticId) &&
        route.openCriticId > 0
          ? route.openCriticId
          : 0) ||
        (Number.isSafeInteger(urlOcId) && urlOcId > 0 ? urlOcId : 0) ||
        (Number.isSafeInteger(rawExternalId) && rawExternalId > 0 ? rawExternalId : 0);

      const ocResolved =
        ocId > 0
          ? await openCriticResolver.resolveById(ocId, {
              expectedTitle: targetTitle || undefined,
              releaseYear: yearNum ?? releaseYear,
              priority: Priority.P1_VIEWPORT,
              isVerifiedAnchor: true,
              anchorUrl: route.url,
              bypassCache: true,
            })
          : targetTitle
          ? await openCriticResolver.resolveForGame({
              title: targetTitle,
              steamAppId: route.steamAppId ?? null,
              gogSlug: normalizeWikidataGogSlug(route.gogId) ?? null,
              releaseYear: yearNum ?? releaseYear,
              priority: Priority.P1_VIEWPORT,
              bypassCache: true,
            })
          : null;

      if (ocResolved && ocResolved.score > 0) {
        return {
          ...ocResolved,
          url: route.url || ocResolved.url,
          numReviews: ocResolved.numReviews ?? fallbackScore?.numReviews,
          summary: ocResolved.summary || fallbackScore?.summary,
        };
      }
    } else if (route.source === 'steam') {
      const appId =
        route.steamAppId ||
        Number(route.url?.match(/store\.steampowered\.com\/app\/(\d+)/i)?.[1] || 0);
      if (appId > 0) {
        const steamRes = await steamReviewResolver.resolveScore(targetTitle, appId);
        if (steamRes && steamRes.score > 0) {
          return steamRes;
        }
      }
    } else if (route.source === 'gog' || route.source === 'epic' || route.source === 'xbox') {
      const starRes = await storefrontStarResolver.resolveScore({
        title: targetTitle,
        gogId: route.gogId,
        epicId: route.epicId,
        xboxProductId: route.xboxProductId,
      });
      if (starRes && starRes.score > 0) {
        return {
          ...starRes,
          source: route.source,
        };
      }
    }
  } catch {}

  return fallbackScore ?? null;
}
