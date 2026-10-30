import React, { useState, useRef, useMemo, useEffect } from 'react';
import { AlertCircle, Gamepad2 } from 'lucide-react';
import { CanonicalGame } from '../../../contracts/game';
import { UserGameOverride } from '../../../contracts/override';
import { toOlMediaUrl, unwrapOlMediaUrl } from '../../../contracts/network';
import { steamMatcher } from '../../../services/steam/steamMatcher';
import { steamApi } from '../../../services/steam/steamApi';
import {
  igdbCoverService,
  isGogCroppedHorizontalCover,
} from '../../../services/igdb/igdbCoverService';
import { getUserOverrideForGame } from '../../../services/storage/userOverrideStorage';
import { onlineLifecycleManager } from '../../../services/network/onlineLifecycleManager';
import {
  isUserActivelyScrolling,
  onScrollIdle,
} from '../../../utils/scrollActivityTracker';
import {
  isCurrentlyFastScrolling,
  notifyImageUnmounted,
} from './gridScrollTracker';
import {
  buildExplicitOverrideCoverUrlSet,
  failedCoverUrls,
  getCoverCandidates,
  hasUncheckedSteamBrowseAssets,
  isMicrosoftOrXboxAssetUrl,
  subscribeToCoverUpdates,
} from './gridCoverUtils';

export interface GameCardCoverProps {
  game: CanonicalGame;
  overrideCoverUrl?: string | null;
  userOverride?: UserGameOverride | null;
  onNeedCoverLookup?: (game: CanonicalGame) => void;
  cardIndex?: number;
}

export const GameCardCover: React.FC<GameCardCoverProps> = React.memo(
  ({ game, overrideCoverUrl, userOverride, onNeedCoverLookup, cardIndex }) => {
    const [steamMatchVersion, setSteamMatchVersion] = useState(0);
    const [failedTick, setFailedTick] = useState(0);
    const [headerFallbackFailed, setHeaderFallbackFailed] = useState(false);

    const gogPlatformGameId = game.platforms?.find((p) => p.platformId === 'gog')?.platformGameId;
    const epicPlatformGameId = game.platforms?.find((p) => p.platformId === 'epic')?.platformGameId;
    const xboxPlatform = game.platforms?.find((p) => p.platformId === 'xbox');
    const rawGameXbox = game as CanonicalGame & {
      xboxProductId?: string | null;
      packageFamilyName?: string | null;
      xboxTitleId?: string | null;
      customCoverUrl?: string;
      hasCustomArtwork?: boolean;
    };
    const effectiveXboxProductId =
      rawGameXbox.xboxProductId || xboxPlatform?.xboxProductId || null;
    const effectivePackageFamilyName =
      rawGameXbox.packageFamilyName || xboxPlatform?.packageFamilyName || null;
    const effectiveXboxTitleId =
      rawGameXbox.xboxTitleId || xboxPlatform?.xboxTitleId || null;

    const effectiveOverride =
      userOverride !== undefined ? userOverride : getUserOverrideForGame(game);
    const effectiveCoverSteamAppId =
      effectiveOverride?.steamAppId === null || game.isExplicitNonSteam === true
        ? null
        : steamMatcher.getEffectiveSteamAppId(game) || game.steamAppId || null;

    useEffect(() => {
      return subscribeToCoverUpdates(
        game.id,
        game.title,
        gogPlatformGameId,
        effectiveCoverSteamAppId,
        () => {
          setHeaderFallbackFailed(false);
          setSteamMatchVersion((v) => v + 1);
          setFailedTick((t) => t + 1);
        }
      );
    }, [game.id, game.title, gogPlatformGameId, effectiveCoverSteamAppId]);

    const isAboveFold = cardIndex === undefined || cardIndex < 28;
    const [isCoverMounted, setIsCoverMounted] = useState<boolean>(
      () => isAboveFold || typeof IntersectionObserver === 'undefined'
    );
    const coverContainerRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
      if (isCoverMounted) return undefined;
      if (typeof IntersectionObserver === 'undefined') {
        setIsCoverMounted(true);
        return undefined;
      }
      const el = coverContainerRef.current;
      if (!el) {
        setIsCoverMounted(true);
        return undefined;
      }
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            setIsCoverMounted(true);
            observer.disconnect();
          }
        },
        { rootMargin: '600px 0px' }
      );
      observer.observe(el);
      return () => observer.disconnect();
    }, [isCoverMounted]);

    const candidates = useMemo(() => {
      return getCoverCandidates(game, overrideCoverUrl || undefined, effectiveOverride);
    }, [game, overrideCoverUrl, effectiveOverride, steamMatchVersion]);

    const explicitOverrideUrls = useMemo(() => {
      return buildExplicitOverrideCoverUrlSet(game, overrideCoverUrl, effectiveOverride);
    }, [game, overrideCoverUrl, effectiveOverride]);

    const attemptedBrowseLookupAppIdRef = useRef<number | null>(null);

    const rawFallbackHeaderUrl =
      effectiveOverride?.headerImage ||
      game.enrichedMetadata?.headerImage ||
      steamApi.getStoreBrowseAssetsInstant(effectiveCoverSteamAppId || game.steamAppId)
        ?.headerImage ||
      game.headerImage;

    const fallbackHeaderUrl =
      rawFallbackHeaderUrl &&
      !rawFallbackHeaderUrl.includes('default.png') &&
      !rawFallbackHeaderUrl.includes('egs-badge.png')
        ? toOlMediaUrl({
            url: rawFallbackHeaderUrl,
            gameId: game.id,
            role: 'header',
            ordinal: 0,
            steamAppId: effectiveCoverSteamAppId,
            gogId: gogPlatformGameId || null,
            epicAppName: epicPlatformGameId || null,
            xboxProductId: effectiveXboxProductId,
            packageFamilyName: effectivePackageFamilyName,
            xboxTitleId: effectiveXboxTitleId,
            ov: effectiveOverride?.headerImage ? effectiveOverride.updatedAt || '1' : undefined,
          })
        : undefined;

    useEffect(() => {
      setHeaderFallbackFailed(false);
    }, [game.id, fallbackHeaderUrl]);

    const rawCurrentSrc = useMemo(() => {
      for (const url of candidates) {
        if (url && !failedCoverUrls.has(url)) {
          return url;
        }
      }
      return null;
    }, [candidates, failedTick]);

    const isCurrentCandidateUserOverride = Boolean(
      rawCurrentSrc &&
        (explicitOverrideUrls.has(rawCurrentSrc) ||
          explicitOverrideUrls.has(unwrapOlMediaUrl(rawCurrentSrc)))
    );
    const coverOverrideToken = isCurrentCandidateUserOverride
      ? effectiveOverride?.updatedAt || '1'
      : undefined;

    const currentSrc = useMemo(() => {
      if (rawCurrentSrc) {
        const wrapped = toOlMediaUrl({
          url: rawCurrentSrc,
          gameId: game.id,
          role: 'cover',
          ordinal: 0,
          steamAppId: effectiveCoverSteamAppId,
          gogId: gogPlatformGameId || null,
          epicAppName: epicPlatformGameId || null,
          xboxProductId: effectiveXboxProductId,
          packageFamilyName: effectivePackageFamilyName,
          xboxTitleId: effectiveXboxTitleId,
          ov: coverOverrideToken,
        });
        if (!failedCoverUrls.has(wrapped)) {
          return wrapped;
        }
      }
      const federatedCover = toOlMediaUrl({
        url: '',
        gameId: game.id,
        role: 'cover',
        ordinal: 0,
        steamAppId: effectiveCoverSteamAppId,
        gogId: gogPlatformGameId || null,
        epicAppName: epicPlatformGameId || null,
        xboxProductId: effectiveXboxProductId,
        packageFamilyName: effectivePackageFamilyName,
        xboxTitleId: effectiveXboxTitleId,
      });
      if (federatedCover && !failedCoverUrls.has(federatedCover)) {
        return federatedCover;
      }
      return null;
    }, [
      rawCurrentSrc,
      coverOverrideToken,
      game.id,
      effectiveCoverSteamAppId,
      gogPlatformGameId,
      epicPlatformGameId,
      effectiveXboxProductId,
      effectivePackageFamilyName,
      effectiveXboxTitleId,
      failedTick,
    ]);

    const hasRenderedImage = Boolean(currentSrc || (fallbackHeaderUrl && !headerFallbackFailed));
    useEffect(() => {
      if (!hasRenderedImage) return undefined;
      return () => {
        notifyImageUnmounted();
      };
    }, [hasRenderedImage]);

    const hasCustomCoverOverride = Boolean(
      effectiveOverride?.capsuleImage ||
        rawGameXbox.customCoverUrl ||
        rawGameXbox.hasCustomArtwork
    );

    useEffect(() => {
      if (!onlineLifecycleManager.isOnline()) return;
      if (!currentSrc) {
        if (onNeedCoverLookup) {
          onNeedCoverLookup(game);
        } else if (
          !hasCustomCoverOverride &&
          effectiveCoverSteamAppId &&
          attemptedBrowseLookupAppIdRef.current !== effectiveCoverSteamAppId &&
          hasUncheckedSteamBrowseAssets(effectiveCoverSteamAppId) &&
          typeof steamApi.fetchStoreBrowseAssets === 'function'
        ) {
          attemptedBrowseLookupAppIdRef.current = effectiveCoverSteamAppId;
          steamApi.fetchStoreBrowseAssets(effectiveCoverSteamAppId).catch(() => null);
        }
        return;
      }

      if (
        !hasCustomCoverOverride &&
        effectiveCoverSteamAppId &&
        attemptedBrowseLookupAppIdRef.current !== effectiveCoverSteamAppId &&
        hasUncheckedSteamBrowseAssets(effectiveCoverSteamAppId) &&
        isMicrosoftOrXboxAssetUrl(rawCurrentSrc || currentSrc)
      ) {
        attemptedBrowseLookupAppIdRef.current = effectiveCoverSteamAppId;
        if (onNeedCoverLookup) {
          onNeedCoverLookup(game);
        } else if (typeof steamApi.fetchStoreBrowseAssets === 'function') {
          steamApi.fetchStoreBrowseAssets(effectiveCoverSteamAppId).catch(() => null);
        }
      }
    }, [
      currentSrc,
      rawCurrentSrc,
      game,
      onNeedCoverLookup,
      hasCustomCoverOverride,
      effectiveCoverSteamAppId,
    ]);

    useEffect(() => {
      if (effectiveOverride?.capsuleImage) return;
      if (!onlineLifecycleManager.isOnline()) return;
      let cancelIdleWait: (() => void) | null = null;
      const runLookup = () => {
        if (!onlineLifecycleManager.isOnline()) return;
        const isExplicitNonSteam =
          effectiveOverride?.steamAppId === null || game.isExplicitNonSteam === true;
        const hasResolvedSteamId =
          !isExplicitNonSteam && Boolean(steamMatcher.getEffectiveSteamAppId(game));

        if (
          !hasResolvedSteamId &&
          !isExplicitNonSteam &&
          !steamMatcher.hasAttemptedMatch(game.title)
        ) {
          steamMatcher
            .matchGameToSteam(game.title, {
              releaseYear: game.releaseDate,
              developers: game.developers,
            })
            .catch(() => null);
        }

        const gogPlat = game.platforms?.find((p) => p.platformId === 'gog');
        if (gogPlat?.platformGameId) {
          if (
            !igdbCoverService.hasAttemptedGogVerticalCover(gogPlat.platformGameId, game.title) &&
            (!hasResolvedSteamId || isGogCroppedHorizontalCover(game.capsuleImage, game.headerImage))
          ) {
            igdbCoverService
              .fetchGogVerticalCover(gogPlat.platformGameId, game.title)
              .catch(() => null);
          }
        }
      };
      const timer = setTimeout(() => {
        if (isCurrentlyFastScrolling() || isUserActivelyScrolling()) {
          cancelIdleWait = onScrollIdle(runLookup);
        } else {
          runLookup();
        }
      }, 250);
      return () => {
        clearTimeout(timer);
        if (cancelIdleWait) cancelIdleWait();
      };
    }, [
      game.id,
      game.title,
      game.releaseDate,
      game.developers,
      game.isExplicitNonSteam,
      game.capsuleImage,
      game.headerImage,
      game.platforms,
      effectiveOverride,
      steamMatchVersion,
    ]);

    const matchReviewBadge =
      game.needsMatchReview === true && !effectiveOverride ? (
        <div
          className="absolute bottom-9 left-2 z-20 flex items-center gap-1 bg-amber-950/95 border border-amber-500/60 text-amber-200 text-[9px] font-semibold px-1.5 py-0.5 rounded shadow"
          title="Low-confidence automatic match — click Fix Match to verify"
        >
          <AlertCircle aria-hidden="true" className="w-2.5 h-2.5 text-amber-300 shrink-0" />
          <span>Verify</span>
        </div>
      ) : null;

    if (!isCoverMounted) {
      return (
        <div ref={coverContainerRef} className="relative w-full h-full bg-[#141d29]">
          {matchReviewBadge}
        </div>
      );
    }

    if (!currentSrc) {
      if (fallbackHeaderUrl && !headerFallbackFailed) {
        return (
          <div className="grid-cover-fallback relative w-full h-full flex flex-col items-center justify-center text-center bg-gradient-to-b from-[#1b2838] to-[#0f161f] overflow-hidden select-none">
            <div
              aria-hidden="true"
              className="absolute inset-0 w-full h-full scale-125 blur-md opacity-40 brightness-75 pointer-events-none"
            />
            <img
              src={fallbackHeaderUrl}
              alt={game.title}
              loading={isAboveFold ? 'eager' : 'lazy'}
              decoding="async"
              className="relative z-10 w-full aspect-[460/215] object-cover shadow-lg border-y border-white/10"
              onError={() => setHeaderFallbackFailed(true)}
            />
            <span className="relative z-10 mt-2 text-[11px] font-semibold text-slate-200 line-clamp-2 leading-tight px-2">
              {game.title}
            </span>
            {matchReviewBadge}
          </div>
        );
      }

      return (
        <div className="grid-cover-fallback relative w-full h-full flex flex-col items-center justify-center p-4 text-center bg-gradient-to-b from-[#1b2838] to-[#0f161f] select-none">
          <Gamepad2
            aria-hidden="true"
            className="w-10 h-10 text-slate-400 mb-2 opacity-70 group-hover:scale-110 group-hover:text-steam-accent transition-all"
          />
          <span className="text-xs font-semibold text-slate-200 line-clamp-3 leading-tight px-1">
            {game.title}
          </span>
          {matchReviewBadge}
        </div>
      );
    }

    const unwrappedCurrentSrc = unwrapOlMediaUrl(rawCurrentSrc || currentSrc);
    const isUserExplicitCover =
      isCurrentCandidateUserOverride ||
      Boolean(unwrappedCurrentSrc && explicitOverrideUrls.has(unwrappedCurrentSrc));

    return (
      <div className="relative w-full h-full">
        <img
          key={currentSrc}
          src={currentSrc}
          alt={game.title}
          loading={isAboveFold ? 'eager' : 'lazy'}
          decoding="async"
          onLoad={(e) => {
            const { naturalWidth, naturalHeight } = e.currentTarget;
            if (naturalWidth && naturalHeight && !isUserExplicitCover) {
              const ratio = naturalWidth / naturalHeight;
              if (ratio > 0.94) {
                failedCoverUrls.add(currentSrc);
                if (rawCurrentSrc) failedCoverUrls.add(rawCurrentSrc);
                setFailedTick((t) => t + 1);
              }
            }
          }}
          onError={() => {
            if (currentSrc) {
              failedCoverUrls.add(currentSrc);
              if (rawCurrentSrc) failedCoverUrls.add(rawCurrentSrc);
              const m = unwrappedCurrentSrc.match(/\/apps\/(\d+)\/library_600x900(?:_2x)?\.jpg/i);
              if (m) {
                const appIdNum = Number(m[1]);
                const hasRemainingUnhashedSteam = candidates.some(
                  (c) => !failedCoverUrls.has(c) && c.includes(`/apps/${m[1]}/library_600x900`)
                );
                if (!hasRemainingUnhashedSteam && onlineLifecycleManager.isOnline()) {
                  const coverSvc = igdbCoverService as unknown as {
                    verifyAndRecordDeadSteamCover?: (
                      appId: number,
                      failedUrl?: string
                    ) => unknown;
                  };
                  if (typeof coverSvc.verifyAndRecordDeadSteamCover === 'function') {
                    void coverSvc.verifyAndRecordDeadSteamCover(appIdNum, unwrappedCurrentSrc);
                  } else {
                    igdbCoverService.recordDeadSteamCover(appIdNum);
                  }
                }
              }
            }
            setFailedTick((t) => t + 1);
          }}
          className="w-full h-full object-cover"
        />
        {matchReviewBadge}
      </div>
    );
  }
);
