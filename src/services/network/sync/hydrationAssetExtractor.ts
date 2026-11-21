import type { CanonicalGame } from '../../../contracts/game';
import { unwrapOlMediaUrl } from '../../../contracts/network';
import { getCoverCandidates } from '../../../components/Library/Grid/gridCoverUtils';

export type FavoritableGame = CanonicalGame & {
  isFavorite?: boolean;
  favorited?: boolean;
  isFavorited?: boolean;
};

export interface HydrationQueueGameEntry {
  gameId: string;
  title?: string;
  steamAppId?: number | null;
  gogId?: string | null;
  epicAppName?: string | null;
  xboxProductId?: string | null;
  packageFamilyName?: string | null;
  isInstalled?: boolean;
  isFavorited?: boolean;
  priority?: number;
  assets: Array<{ role: string; ordinal?: number; url: string }>;
}

function normalizeStaticHydrationAssetUrl(raw?: string | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const clean = unwrapOlMediaUrl(raw).trim();
  if (!clean || !/^https?:\/\//i.test(clean)) return null;
  if (/\.(?:mp4|webm|m3u8|mpd|mov|avi|mkv|ogv)(?:[?#]|$)/i.test(clean)) return null;
  if (
    /steamstatic\.com\/store_trailers\/.*\/movie/i.test(clean) &&
    !/\.(?:jpg|jpeg|png|webp|gif|avif)(?:[?#]|$)/i.test(clean)
  ) {
    return null;
  }
  return clean;
}

export function extractStaticHydrationAssets(
  game: CanonicalGame,
  meta?: CanonicalGame['enrichedMetadata']
): Array<{ role: string; ordinal?: number; url: string }> {
  const assets: Array<{ role: string; ordinal?: number; url: string }> = [];
  const seen = new Set<string>();

  const addAsset = (role: string, rawUrl?: string | null, ordinal?: number) => {
    const url = normalizeStaticHydrationAssetUrl(rawUrl);
    if (!url) return;
    const dedupeKey = `${role}:${url}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    assets.push(ordinal !== undefined ? { role, ordinal, url } : { role, url });
  };

  const candidateGame: CanonicalGame =
    meta && meta !== game.enrichedMetadata ? { ...game, enrichedMetadata: meta } : game;
  const alignedCoverUrl =
    getCoverCandidates(candidateGame, undefined, undefined, {
      scheduleSwrReprobe: false,
    })[0] ||
    game.capsuleImage ||
    meta?.capsuleImage;

  addAsset('cover', alignedCoverUrl, 0);
  addAsset('header', meta?.headerImage || game.headerImage, 0);
  addAsset('icon', game.iconUrl, 0);

  const topScreenshots = (meta?.screenshots || []).slice(0, 5);
  for (let idx = 0; idx < topScreenshots.length; idx++) {
    const shot = topScreenshots[idx];
    addAsset('screenshot_thumb', shot?.pathThumbnail || shot?.pathFull, idx);
  }

  const htmlSource = meta?.detailedDescription || meta?.aboutTheGame || '';
  if (htmlSource.trim()) {
    const imgRegex = /<img\b[^>]*?\bsrc=["']([^"']+)["']/gi;
    let imgMatch: RegExpExecArray | null;
    let imgOrd = 0;
    while ((imgMatch = imgRegex.exec(htmlSource)) !== null && imgOrd < 12) {
      addAsset('inline_img', imgMatch[1], imgOrd);
      imgOrd++;
    }

    const posterRegex = /<video\b[^>]*?\bposter=["']([^"']+)["']/gi;
    let posterMatch: RegExpExecArray | null;
    let posterOrd = 0;
    while ((posterMatch = posterRegex.exec(htmlSource)) !== null && posterOrd < 6) {
      addAsset('inline_poster', posterMatch[1], posterOrd);
      posterOrd++;
    }
  }

  return assets;
}

export function buildHydrationGameEntry(
  game: CanonicalGame,
  assets: Array<{ role: string; ordinal?: number; url: string }>,
  priority?: number
): HydrationQueueGameEntry {
  const gogPlat = game.platforms?.find((p) => p.platformId === 'gog');
  const epicPlat = game.platforms?.find((p) => p.platformId === 'epic');
  const xboxPlat = game.platforms?.find((p) => p.platformId === 'xbox');
  const isInstalled = Boolean(game.platforms?.some((p) => p.installed));
  const isFavorited = Boolean(
    (game as FavoritableGame).isFavorite || (game as FavoritableGame).favorited
  );
  return {
    gameId: game.id,
    title: game.title,
    steamAppId: game.steamAppId ?? null,
    gogId: gogPlat?.platformGameId ?? null,
    epicAppName: epicPlat?.platformGameId ?? null,
    xboxProductId: xboxPlat?.xboxProductId ?? xboxPlat?.platformGameId ?? null,
    packageFamilyName: xboxPlat?.packageFamilyName ?? null,
    isInstalled,
    isFavorited,
    ...(priority !== undefined ? { priority } : {}),
    assets,
  };
}

/**
 * Builds a polite P2 background hydration batch (cover + icon ONLY) aligned with
 * `getCoverCandidates(game)[0]` so `MediaHydrationEngine` pre-warms the exact cover
 * URL requested by `GameCardCover`.
 */
export function buildP2CoverHydrationBatch(games: CanonicalGame[]): HydrationQueueGameEntry[] {
  const batch: HydrationQueueGameEntry[] = [];
  for (const g of games) {
    if (!g?.id) continue;
    const p2Assets = extractStaticHydrationAssets(g, g.enrichedMetadata).filter(
      (a) => a.role === 'cover' || a.role === 'icon'
    );
    if (p2Assets.length === 0) continue;
    batch.push(buildHydrationGameEntry(g, p2Assets, 2));
  }
  return batch;
}
