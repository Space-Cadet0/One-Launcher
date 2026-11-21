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
  isKnownDeadSteamCover,
  isUnsuitableCoverUrl,
} from '../../../services/igdb/igdbCoverService';
import { getUserOverrideForGame } from '../../../services/storage/userOverrideStorage';
import { onlineLifecycleManager } from '../../../services/network/onlineLifecycleManager';
import {
  isUserActivelyScrolling,
  onScrollIdle,
} from '../../../utils/scrollActivityTracker';
import {
  isCurrentlyFastScrolling,
  addPendingFastScrollMount,
  removePendingFastScrollMount,
  notifyImageUnmounted,
} from './gridScrollTracker';
import {
  buildExplicitOverrideCoverUrlSet,
  emittedCoverSelfHealKeys,
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
  isVirtualized?: boolean;
}

export const GameCardCover: React.FC<GameCardCoverProps> = React.memo(
  ({
    game,
    overrideCoverUrl,
    userOverride,
    onNeedCoverLookup,
    cardIndex,
    isVirtualized = false,
  }) => {
    const [steamMatchVersion, setSteamMatchVersion] = useState(0);
    const [failedTick, setFailedTick] = useState(0);
    const [headerFallbackFailed, setHeaderFallbackFailed] = useState(false);
    const isMountedRef = useRef(true);

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

    // Effect 0 MUST remain subscribeToCoverUpdates (relied on by O(1) shared listener tests)
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

    useEffect(() => {
      isMountedRef.current = true;
      return () => {
        isMountedRef.current = false;
      };
    }, []);

    const isAboveFold = cardIndex === undefined || cardIndex < 28;
    const [isCoverMounted, setIsCoverMounted] = useState<boolean>(() =>
      isVirtualized
        ? !isCurrentlyFastScrolling()
        : isAboveFold || typeof IntersectionObserver === 'undefined'
    );
    const coverContainerRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
      if (isCoverMounted) return undefined;

      if (isVirtualized) {
        if (!isCurrentlyFastScrolling()) {
          setIsCoverMounted(true);
          return undefined;
        }
        let pendingMount: (() => void) | null = () => {
          pendingMount = null;
          setIsCoverMounted(true);
        };
        addPendingFastScrollMount(pendingMount);
        return () => {
          if (pendingMount) {
            removePendingFastScrollMount(pendingMount);
            pendingMount = null;
          }
        };
      }

      if (typeof IntersectionObserver === 'undefined') {
        setIsCoverMounted(true);
        return undefined;
      }
      const el = coverContainerRef.current;
      if (!el) {
        setIsCoverMounted(true);
        return undefined;
      }

      let pendingMount: (() => void) | null = null;

      const cancelPendingMount = () => {
        if (pendingMount) {
          removePendingFastScrollMount(pendingMount);
          pendingMount = null;
        }
      };

      const observer = new IntersectionObserver(
        (entries) => {
          const isIntersecting = entries.some((entry) => entry.isIntersecting);
          if (isIntersecting) {
            if (isCurrentlyFastScrolling()) {
              if (!pendingMount) {
                pendingMount = () => {
                  pendingMount = null;
                  setIsCoverMounted(true);
                  observer.disconnect();
                };
                addPendingFastScrollMount(pendingMount);
              }
            } else {
              cancelPendingMount();
              setIsCoverMounted(true);
              observer.disconnect();
            }
          } else {
            cancelPendingMount();
          }
        },
        { rootMargin: '600px 0px' }
      );
      observer.observe(el);

      return () => {
        cancelPendingMount();
        observer.disconnect();
      };
    }, [isCoverMounted, isVirtualized]);

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

    // Task 4 Stage 3 Split-Brain Self-Heal:
    // If GameCardCover resolves a valid cached GOG/IGDB cover while the catalog record's
    // capsuleImage is missing or unsuitable, emit a deduplicated once-per-game-per-session
    // event so the catalog record heals automatically even if hasAttemptedGogVerticalCover is already true.
    useEffect(() => {
      if (effectiveOverride?.capsuleImage) return;
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;

      const needsCatalogCoverHeal =
        !game.capsuleImage ||
        isUnsuitableCoverUrl(game.capsuleImage) ||
        isGogCroppedHorizontalCover(game.capsuleImage, game.headerImage);
      if (!needsCatalogCoverHeal) return;

      const gogInstantCover = gogPlatformGameId
        ? igdbCoverService.getGogVerticalCoverInstant(gogPlatformGameId, game.title)
        : null;
      if (
        gogInstantCover &&
        !isUnsuitableCoverUrl(gogInstantCover) &&
        !isGogCroppedHorizontalCover(gogInstantCover, game.headerImage)
      ) {
        const healKey = `${game.id}:gog`;
        if (!emittedCoverSelfHealKeys.has(healKey)) {
          emittedCoverSelfHealKeys.add(healKey);
          const cleanGogId = String(gogPlatformGameId).replace(/^gog-/, '');
          try {
            window.dispatchEvent(
              new CustomEvent('antigravity:gog-cover-updated', {
                detail: {
                  gameId: game.id,
                  gogId: cleanGogId,
                  title: game.title,
                  coverUrl: gogInstantCover,
                },
              })
            );
          } catch {
            // Ignore event dispatch errors
          }
        }
        return;
      }

      const igdbInstantCover = igdbCoverService.getIgdbCoverInstant(
        game.title,
        game.steamAppId,
        game.id
      );
      if (igdbInstantCover && !isUnsuitableCoverUrl(igdbInstantCover)) {
        const healKey = `${game.id}:igdb`;
        if (!emittedCoverSelfHealKeys.has(healKey)) {
          emittedCoverSelfHealKeys.add(healKey);
          try {
            window.dispatchEvent(
              new CustomEvent('antigravity:igdb-cover-updated', {
                detail: {
                  gameId: game.id,
                  title: game.title,
                  coverUrl: igdbInstantCover,
                },
              })
            );
          } catch {
            // Ignore event dispatch errors
          }
        }
      }
    }, [
      game.id,
      game.title,
      game.steamAppId,
      game.capsuleImage,
      game.headerImage,
      gogPlatformGameId,
      effectiveOverride?.capsuleImage,
      steamMatchVersion,
    ]);

    const imgLoading: 'eager' | 'lazy' = isVirtualized || isAboveFold ? 'eager' : 'lazy';

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
            <img
              src={fallbackHeaderUrl}
              alt=""
              aria-hidden="true"
              loading={imgLoading}
              decoding="async"
              className="absolute inset-0 w-full h-full object-cover scale-125 blur-md opacity-40 brightness-75 pointer-events-none"
            />
            <img
              src={fallbackHeaderUrl}
              alt={game.title}
              width={460}
              height={215}
              loading={imgLoading}
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
          width={600}
          height={900}
          loading={imgLoading}
          fetchPriority={cardIndex === 0 ? 'high' : undefined}
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
              const steamCoverMatch = unwrappedCurrentSrc.match(
                /\/apps\/(\d+)\/(?:([a-f0-9]{40})\/)?library_(?:600x900|capsule)(?:_2x)?\.jpg/i
              );
              if (steamCoverMatch) {
                const appIdNum = Number(steamCoverMatch[1]);
                const sha1 = steamCoverMatch[2];
                const isUnhashed600x900 =
                  !sha1 && /\/library_600x900(?:_2x)?\.jpg/i.test(unwrappedCurrentSrc);
                const isUnhashed1x =
                  !sha1 && /\/library_600x900\.jpg(?:[?#]|$)/i.test(unwrappedCurrentSrc);

                const markRemainingUnhashedFailed = (): boolean => {
                  let markedAny = false;
                  const unhashedPrefix = `/apps/${appIdNum}/library_600x900`;
                  for (const cand of candidates) {
                    if (cand.includes(unhashedPrefix) && !failedCoverUrls.has(cand)) {
                      failedCoverUrls.add(cand);
                      markedAny = true;
                    }
                  }
                  const canonical2x = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appIdNum}/library_600x900_2x.jpg`;
                  if (!failedCoverUrls.has(canonical2x)) {
                    failedCoverUrls.add(canonical2x);
                    markedAny = true;
                  }
                  return markedAny;
                };

                if (sha1) {
                  // SHA1-hashed Steam URL: verify only that exact URL without poisoning the AppID
                  if (
                    onlineLifecycleManager.isOnline() &&
                    typeof igdbCoverService.verifyAndRecordDeadSteamCover === 'function'
                  ) {
                    void igdbCoverService
                      .verifyAndRecordDeadSteamCover(appIdNum, unwrappedCurrentSrc)
                      .catch(() => {});
                  }
                } else if (isUnhashed600x900 && !isUserExplicitCover) {
                  if (isUnhashed1x && isKnownDeadSteamCover(appIdNum)) {
                    markRemainingUnhashedFailed();
                  }
                  const hasRemainingUnhashedSteam = candidates.some(
                    (c) =>
                      !failedCoverUrls.has(c) && c.includes(`/apps/${appIdNum}/library_600x900`)
                  );
                  if (onlineLifecycleManager.isOnline()) {
                    if (typeof igdbCoverService.verifyAndRecordDeadSteamCover === 'function') {
                      if (isUnhashed1x || !hasRemainingUnhashedSteam) {
                        void igdbCoverService
                          .verifyAndRecordDeadSteamCover(appIdNum, unwrappedCurrentSrc)
                          .then((confirmedDead) => {
                            if (confirmedDead && isUnhashed1x) {
                              const markedAny = markRemainingUnhashedFailed();
                              if (markedAny && isMountedRef.current) {
                                setFailedTick((t) => t + 1);
                              }
                            }
                          })
                          .catch(() => {});
                      }
                    } else if (!hasRemainingUnhashedSteam) {
                      igdbCoverService.recordDeadSteamCover(appIdNum);
                    }
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
