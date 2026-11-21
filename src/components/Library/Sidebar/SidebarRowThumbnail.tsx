import React, { useEffect, useMemo, useState } from 'react';
import { CanonicalGame } from '../../../contracts/game';
import { toOlMediaUrl } from '../../../contracts/network';
import { igdbCoverService, isKnownDeadSteamCover } from '../../../services/igdb/igdbCoverService';
import { steamApi } from '../../../services/steam/steamApi';
import { onlineLifecycleManager } from '../../../services/network/onlineLifecycleManager';
import {
  clearFailedSidebarIconUrls,
  hasSidebarIconUrlFailed,
  markSidebarIconUrlFailed,
  subscribeFailedMediaUrlReset,
} from '../../../services/media/failedMediaUrlRegistry';

const sidebarReconnectSubscribers = new Set<() => void>();
let sidebarOnlineUnsub: (() => void) | null = null;
let sidebarRegistryResetUnsub: (() => void) | null = null;

function notifySidebarIconSubscribers(): void {
  for (const listener of Array.from(sidebarReconnectSubscribers)) {
    listener();
  }
}

function subscribeSidebarIconReset(cb: () => void): () => void {
  sidebarReconnectSubscribers.add(cb);
  if (!sidebarOnlineUnsub) {
    sidebarOnlineUnsub = onlineLifecycleManager.onOnline(() => {
      clearFailedSidebarIconUrls();
    });
  }
  if (!sidebarRegistryResetUnsub) {
    sidebarRegistryResetUnsub = subscribeFailedMediaUrlReset((event) => {
      if (event.scope === 'sidebar_icon' || event.scope === 'all') {
        notifySidebarIconSubscribers();
      }
    });
  }
  return () => {
    sidebarReconnectSubscribers.delete(cb);
    if (sidebarReconnectSubscribers.size === 0) {
      if (sidebarOnlineUnsub) {
        sidebarOnlineUnsub();
        sidebarOnlineUnsub = null;
      }
      if (sidebarRegistryResetUnsub) {
        sidebarRegistryResetUnsub();
        sidebarRegistryResetUnsub = null;
      }
    }
  };
}

function isUnhashedSteamAppAssetUrl(url: string, appId?: number | null): boolean {
  if (!appId) return false;
  if (!url.includes(`/apps/${appId}/`)) return false;
  return !/\/apps\/\d+\/[a-f0-9]{40}\//i.test(url);
}

function toSidebarIconUrl(rawUrl?: string | null): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.includes('default.png') || trimmed.includes('egs-badge.png')) {
    return null;
  }
  const hasSha1Subdir = /\/apps\/\d+\/[a-f0-9]{40}\//i.test(trimmed);
  let transformed = hasSha1Subdir
    ? trimmed
    : trimmed.replace(/\/library_600x900(?:_2x)?\.jpg(\?.*)?$/i, '/capsule_sm_120.jpg$1');
  transformed = transformed.replace(/\/t_cover_big(?:_2x)?\//i, '/t_thumb/');
  if (/cdn[12]?\.epicgames\.com\//i.test(transformed) && !/[?&][hw]=/i.test(transformed)) {
    transformed = `${transformed}${transformed.includes('?') ? '&' : '?'}h=96&resize=1`;
  }
  return transformed;
}

/**
 * Lightweight sidebar thumbnail relying directly on virtualizer windowing + native
 * `<img loading="lazy" decoding="async">` without per-row IntersectionObservers or `src` blanking.
 */
export const SidebarRowThumbnail: React.FC<{ game: CanonicalGame }> = React.memo(({ game }) => {
  const [failedTick, setFailedTick] = useState(0);

  useEffect(() => {
    return subscribeSidebarIconReset(() => {
      setFailedTick((t) => t + 1);
    });
  }, []);

  const iconCandidates = useMemo(() => {
    const list: string[] = [];
    const seen = new Set<string>();
    const deadSteam = game.steamAppId ? isKnownDeadSteamCover(game.steamAppId) : false;

    const pushCandidate = (raw?: string | null) => {
      const formatted = toSidebarIconUrl(raw);
      if (!formatted || seen.has(formatted)) return;
      seen.add(formatted);
      list.push(formatted);
    };

    const browseAssets = game.steamAppId
      ? steamApi.getStoreBrowseAssetsInstant(game.steamAppId)
      : null;

    const rawSources = [
      game.iconUrl,
      browseAssets?.iconUrl,
      game.capsuleImage,
      browseAssets?.capsuleImage,
      game.enrichedMetadata?.capsuleImage,
      browseAssets?.headerImage,
      game.enrichedMetadata?.headerImage,
      game.headerImage,
    ];

    for (const src of rawSources) {
      if (!src) continue;
      if (deadSteam && isUnhashedSteamAppAssetUrl(src, game.steamAppId)) {
        continue;
      }
      if (
        /\/apps\/\d+\/[a-f0-9]{40}\//i.test(src) ||
        src.includes('steamcommunity/public/images/apps/')
      ) {
        pushCandidate(src);
      }
    }

    for (const src of rawSources) {
      if (!src) continue;
      if (deadSteam && isUnhashedSteamAppAssetUrl(src, game.steamAppId)) {
        continue;
      }
      pushCandidate(src);
    }

    const igdbInstant = igdbCoverService.getIgdbCoverInstant(
      game.title,
      game.steamAppId,
      game.id
    );
    if (igdbInstant) {
      pushCandidate(igdbInstant);
    }

    if (game.steamAppId && !deadSteam) {
      pushCandidate(
        `https://cdn.akamai.steamstatic.com/steam/apps/${game.steamAppId}/capsule_sm_120.jpg`
      );
      pushCandidate(
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.steamAppId}/capsule_sm_120.jpg`
      );
      pushCandidate(`https://cdn.akamai.steamstatic.com/steam/apps/${game.steamAppId}/header.jpg`);
    }

    return list;
  }, [
    game.id,
    game.title,
    game.steamAppId,
    game.iconUrl,
    game.capsuleImage,
    game.headerImage,
    game.enrichedMetadata?.capsuleImage,
    game.enrichedMetadata?.headerImage,
  ]);

  const gogPlatformGameId =
    game.platforms?.find((p) => p.platformId === 'gog')?.platformGameId || null;
  const epicPlatformGameId =
    game.platforms?.find((p) => p.platformId === 'epic')?.platformGameId || null;

  const rawActiveIconUrl = useMemo(
    () => iconCandidates.find((u) => !hasSidebarIconUrlFailed(u)) || null,
    [iconCandidates, failedTick]
  );

  const activeIconUrl = useMemo(() => {
    if (rawActiveIconUrl) {
      const wrapped = toOlMediaUrl({
        url: rawActiveIconUrl,
        gameId: game.id,
        role: 'icon',
        ordinal: 0,
        steamAppId: game.steamAppId || null,
        gogId: gogPlatformGameId,
        epicAppName: epicPlatformGameId,
      });
      if (!hasSidebarIconUrlFailed(wrapped)) {
        return wrapped;
      }
    }
    const federatedIcon = toOlMediaUrl({
      url: '',
      gameId: game.id,
      role: 'icon',
      ordinal: 0,
      steamAppId: game.steamAppId || null,
      gogId: gogPlatformGameId,
      epicAppName: epicPlatformGameId,
    });
    if (federatedIcon && !hasSidebarIconUrlFailed(federatedIcon)) {
      return federatedIcon;
    }
    return null;
  }, [
    rawActiveIconUrl,
    game.id,
    game.steamAppId,
    gogPlatformGameId,
    epicPlatformGameId,
    failedTick,
  ]);

  return (
    <div className="w-6 h-6 rounded bg-black/60 overflow-hidden flex-shrink-0 border border-steam-border/40 group-hover:border-steam-accent/50 relative pointer-events-none">
      {activeIconUrl ? (
        <img
          src={activeIconUrl}
          alt=""
          className="w-full h-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => {
            markSidebarIconUrlFailed(activeIconUrl);
            if (rawActiveIconUrl) {
              markSidebarIconUrlFailed(rawActiveIconUrl);
            }
            setFailedTick((t) => t + 1);
          }}
        />
      ) : null}
      <div
        className={`w-full h-full ${
          activeIconUrl ? 'hidden' : 'flex'
        } items-center justify-center bg-gradient-to-br from-[#1b2838] to-[#2a475e] text-[10px] font-bold text-steam-accent select-none`}
        aria-hidden="true"
      >
        {game.title.charAt(0).toUpperCase()}
      </div>
    </div>
  );
});
