import React, { useEffect, useState, useRef, useMemo } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { SteamEnrichedMetadata } from '../../contracts/steam';
import { CriticScoreData } from '../../contracts/critic';
import { StorefrontId } from '../../contracts/platform';
import { toOlMediaUrl, unwrapOlMediaUrl } from '../../contracts/network';
import { getStorefrontDisplayName } from '../Common/StorefrontIcon';
import { steamApi, SteamStoreBrowseAssets } from '../../services/steam/steamApi';
import { steamMatcher } from '../../services/steam/steamMatcher';
import { RequestPriority } from '../../services/network/requestScheduler';
import {
  fallbackMetadataProvider,
  isGenericPlaceholderSynopsis,
  stripHtmlToPlainSynopsis,
} from '../../services/steam/fallbackMetadataProvider';
import { loadIntegrations } from '../../services/integrations/integrationStorage';
import { onlineLifecycleManager } from '../../services/network/onlineLifecycleManager';
import { sanitizeSafeDomFragment } from '../../utils/safeHtmlSanitizer';
import { MediaGallery } from './MediaGallery';
import { SteamHeroDetails } from './SteamHeroDetails';
import { SteamLibraryActionBar } from './SteamLibraryActionBar';
import { HowLongToBeatCard } from './HowLongToBeatCard';
import { getOpenCriticData } from '../../services/critic/criticScoreService';
import { OpenCriticCard } from './OpenCriticCard';
import { SystemRequirements } from './SystemRequirements';
import { PlatformBadges } from './PlatformBadges';
import { NativeOsBadges } from '../Common/NativeOsBadges';
import { getNativeOsPlatforms } from '../../services/platform/nativeOsService';
import { SteamLanguagesTable } from './SteamLanguagesTable';
import { SteamFeaturesList } from './SteamFeaturesList';
import { SteamSidebarNotices } from './SteamSidebarNotices';
import {
  isGameOwnedOnSteam,
  getEffectiveTags,
} from '../../services/steam/steamFeatureNormalizer';
import { steamAchievementsService } from '../../services/steam/steamAchievementsService';
import {
  getUserOverrideForGame,
  inferMetadataRouteFromOverride,
  updateRoutedMetadataSnapshot,
} from '../../services/storage/userOverrideStorage';
import {
  Sparkles,
  ArrowLeft,
  AlertCircle,
  Activity,
  CheckCircle2,
} from 'lucide-react';
import { ActiveGameFilter } from '../../contracts/filter';
import { GameCollection } from '../../contracts/collection';
import { launcherService } from '../../services/launcher/launcherService';

export interface SteamStorePageProps {
  game: CanonicalGame;
  collections?: GameCollection[];
  onBackToLibrary?: () => void;
  onManageCollections?: () => void;
  onToggleInstallStatus?: (platformId?: StorefrontId) => void;
  onApplyFilter?: (filter: ActiveGameFilter) => void;
  onGameUpdated?: (updated: CanonicalGame) => void;
  connectedStorefronts?: StorefrontId[];
  onOpenIntegrations?: () => void;
  onFixMatch?: () => void;
  onHideGame?: (game: CanonicalGame, targetPlatformId?: StorefrontId) => void;
  onViewAchievements?: (storefrontId?: StorefrontId) => void;
}

const RICH_HTML_DESC_RE = /<(video|img|p|h[1-6]|div|ul)\b/i;

function isSkeletonMetadata(meta?: SteamEnrichedMetadata | null): boolean {
  return Boolean(meta && meta.metadataQuality === 'skeleton_fallback');
}

function hasRichMetadata(meta?: SteamEnrichedMetadata | null): boolean {
  return Boolean(meta && meta.metadataQuality !== 'skeleton_fallback');
}

function isAuthoritativeSteamMetadata(
  meta?: SteamEnrichedMetadata | null,
  expectedAppId?: number | null
): boolean {
  return (
    Boolean(meta) &&
    Number(meta!.appId) > 0 &&
    (!expectedAppId || Number(meta!.appId) === Number(expectedAppId)) &&
    meta!.metadataQuality !== 'storefront_native' &&
    meta!.metadataQuality !== 'skeleton_fallback' &&
    meta!.metadataQuality !== 'local_federated' &&
    meta!.enrichedSource !== 'xbox'
  );
}

function isSentinelReleaseDate(raw?: string | null): boolean {
  if (!raw) return false;
  const match = raw.match(/\b(\d{4})\b/);
  if (!match) return false;
  const year = Number(match[1]);
  const maxValidYear = new Date().getFullYear() + 10;
  return Number.isFinite(year) && (year < 1975 || year > maxValidYear);
}

function isMicrosoftStoreAssetUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const normalized = url.trim().startsWith('//') ? `https:${url.trim()}` : url.trim();
    const unwrapped = normalized.startsWith('ol-media://')
      ? unwrapOlMediaUrl(normalized)
      : normalized;
    const host = new URL(unwrapped).hostname.toLowerCase();
    return (
      host === 's-microsoft.com' ||
      host.endsWith('.s-microsoft.com') ||
      host === 'xboxlive.com' ||
      host.endsWith('.xboxlive.com')
    );
  } catch {
    return false;
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    Boolean(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  );
}

function mergePreservingXboxHints(
  incoming: SteamEnrichedMetadata | null | undefined,
  baseline?: SteamEnrichedMetadata | null
): SteamEnrichedMetadata | null {
  if (!incoming) return null;
  if (baseline?.xboxDeliveryHints && !incoming.xboxDeliveryHints) {
    return {
      ...incoming,
      xboxDeliveryHints: baseline.xboxDeliveryHints,
    };
  }
  return incoming;
}

function normalizeProtocolRelativeUrl(raw?: string | null): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (trimmed.startsWith('//') && !trimmed.startsWith('///')) {
    return `https:${trimmed}`;
  }
  return trimmed;
}

function normalizeSrcsetUrls(rawSrcset?: string | null): string {
  if (!rawSrcset) return '';
  return rawSrcset
    .split(',')
    .map((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return '';
      const parts = trimmed.split(/\s+/);
      const normalizedUrl = normalizeProtocolRelativeUrl(parts[0]);
      if (!normalizedUrl) return '';
      return parts.length > 1 ? `${normalizedUrl} ${parts.slice(1).join(' ')}` : normalizedUrl;
    })
    .filter(Boolean)
    .join(', ');
}

interface AboutThisGameHtmlProps {
  html: string;
  isOnline: boolean;
  onlineGeneration: number;
  gameId: string;
  steamAppId?: number | string | null;
  gogId?: string | null;
  epicAppName?: string | null;
  xboxProductId?: string | null;
  packageFamilyName?: string | null;
  xboxTitleId?: string | null;
  onMountedDom?: () => void;
}

const AboutThisGameHtml: React.FC<AboutThisGameHtmlProps> = ({
  html,
  isOnline,
  onlineGeneration,
  gameId,
  steamAppId,
  gogId,
  epicAppName,
  xboxProductId,
  packageFamilyName,
  xboxTitleId,
  onMountedDom,
}) => {
  const descRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = descRef.current;
    if (!container || typeof container.replaceChildren !== 'function') return;

    const fragment = sanitizeSafeDomFragment(html);
    if (!fragment) return;
    const reducedMotion = prefersReducedMotion();

    const collapseBrokenElement = (el: HTMLElement) => {
      el.style.display = 'none';
      const wrapper = typeof el.closest === 'function' ? el.closest('.bb_img_ctn') : null;
      if (wrapper && wrapper instanceof HTMLElement) {
        const hasVisibleChild = Array.from(wrapper.children).some(
          (child) => child !== el && (child as HTMLElement).style?.display !== 'none'
        );
        if (!hasVisibleChild && !(wrapper.textContent || '').trim()) {
          wrapper.style.display = 'none';
        }
      }
    };

    const attachImgFallbackOrCollapse = (targetImg: HTMLElement) => {
      targetImg.addEventListener(
        'error',
        () => {
          const currentAttrSrc = (
            targetImg.getAttribute('src') ||
            (targetImg as HTMLImageElement).src ||
            ''
          ).trim();
          const alreadyRetried =
            targetImg.dataset?.retriedDirect === '1' ||
            targetImg.getAttribute('data-retried-direct') === '1';
          if (
            !alreadyRetried &&
            currentAttrSrc.startsWith('ol-media://') &&
            onlineLifecycleManager.isOnline()
          ) {
            const directUrl = unwrapOlMediaUrl(currentAttrSrc);
            if (directUrl && directUrl !== currentAttrSrc && /^https?:\/\//i.test(directUrl)) {
              if (targetImg.dataset) {
                targetImg.dataset.retriedDirect = '1';
              }
              targetImg.setAttribute('data-retried-direct', '1');
              targetImg.addEventListener('error', () => collapseBrokenElement(targetImg), {
                once: true,
              });
              targetImg.setAttribute('src', directUrl);
              return;
            }
          }
          collapseBrokenElement(targetImg);
        },
        { once: true }
      );
    };

    // Rewrite inline <img> sources via ol-media://, apply below-the-fold lazy loading, and hide broken assets
    const images = Array.from(fragment.querySelectorAll('img'));
    images.forEach((imgEl, idx) => {
      const rawSrc = normalizeProtocolRelativeUrl(imgEl.getAttribute('src'));
      const rawSrcset = imgEl.getAttribute('srcset');
      if (rawSrcset !== null) {
        if (!isOnline) {
          imgEl.removeAttribute('srcset');
        } else {
          const normalizedSrcset = normalizeSrcsetUrls(rawSrcset);
          if (normalizedSrcset) {
            imgEl.setAttribute('srcset', normalizedSrcset);
          } else {
            imgEl.removeAttribute('srcset');
          }
        }
      }
      if (!rawSrc) {
        collapseBrokenElement(imgEl);
        return;
      }
      if (/^https?:\/\//i.test(rawSrc) || rawSrc.startsWith('ol-media://')) {
        imgEl.setAttribute(
          'src',
          toOlMediaUrl({
            url: rawSrc,
            gameId,
            role: 'inline_img',
            ordinal: idx,
            steamAppId,
            gogId,
            epicAppName,
            xboxProductId,
            packageFamilyName,
            xboxTitleId,
          })
        );
      } else {
        imgEl.setAttribute('src', rawSrc);
      }
      imgEl.setAttribute('loading', 'lazy');
      imgEl.setAttribute('decoding', 'async');
      imgEl.removeAttribute('fetchpriority');
      attachImgFallbackOrCollapse(imgEl);
    });

    // Handle inline <video> elements: replace with static cached poster when offline, or attach graceful fallback when online
    const videos = Array.from(fragment.querySelectorAll('video'));
    videos.forEach((videoEl, vIdx) => {
      const rawPoster = normalizeProtocolRelativeUrl(videoEl.getAttribute('poster'));
      const resolvedPoster =
        rawPoster && (/^https?:\/\//i.test(rawPoster) || rawPoster.startsWith('ol-media://'))
          ? toOlMediaUrl({
              url: rawPoster,
              gameId,
              role: 'inline_poster',
              ordinal: vIdx,
              steamAppId,
              gogId,
              epicAppName,
              xboxProductId,
              packageFamilyName,
              xboxTitleId,
            })
          : rawPoster;

      const buildPosterImg = (): HTMLImageElement | null => {
        if (
          !resolvedPoster ||
          typeof document === 'undefined' ||
          typeof document.createElement !== 'function'
        ) {
          return null;
        }
        const posterImg = document.createElement('img');
        posterImg.setAttribute('src', resolvedPoster);
        posterImg.setAttribute('alt', videoEl.getAttribute('title') || '');
        posterImg.setAttribute('loading', 'lazy');
        posterImg.setAttribute('decoding', 'async');
        posterImg.className = 'bb_img';
        attachImgFallbackOrCollapse(posterImg);
        return posterImg;
      };

      if (!isOnline) {
        const posterImg = buildPosterImg();
        if (posterImg) {
          videoEl.replaceWith(posterImg);
        } else {
          const wrapper =
            typeof videoEl.closest === 'function' ? videoEl.closest('.bb_img_ctn') : null;
          videoEl.remove();
          if (
            wrapper &&
            wrapper instanceof HTMLElement &&
            wrapper.children.length === 0 &&
            !(wrapper.textContent || '').trim()
          ) {
            wrapper.style.display = 'none';
          }
        }
        return;
      }

      const rawVideoSrc = normalizeProtocolRelativeUrl(videoEl.getAttribute('src'));
      if (rawVideoSrc) {
        videoEl.setAttribute('src', rawVideoSrc);
      } else if (videoEl.hasAttribute('src')) {
        videoEl.removeAttribute('src');
      }

      const rawSources = Array.from(videoEl.querySelectorAll('source'));
      const validSources: HTMLElement[] = [];
      rawSources.forEach((sourceEl) => {
        const normalizedSourceSrc = normalizeProtocolRelativeUrl(sourceEl.getAttribute('src'));
        if (normalizedSourceSrc) {
          sourceEl.setAttribute('src', normalizedSourceSrc);
          validSources.push(sourceEl as unknown as HTMLElement);
        } else {
          sourceEl.remove();
        }
      });

      if (!rawVideoSrc && validSources.length === 0) {
        const posterImg = buildPosterImg();
        if (posterImg) {
          videoEl.replaceWith(posterImg);
        } else {
          collapseBrokenElement(videoEl);
        }
        return;
      }

      if (resolvedPoster) {
        videoEl.setAttribute('poster', resolvedPoster);
      }
      videoEl.muted = true;
      (videoEl as HTMLVideoElement).defaultMuted = true;
      (videoEl as HTMLVideoElement).loop = true;
      (videoEl as HTMLVideoElement).playsInline = true;
      videoEl.setAttribute('muted', '');
      videoEl.setAttribute('playsinline', '');
      videoEl.setAttribute('loop', '');
      if (reducedMotion) {
        videoEl.autoplay = false;
        videoEl.removeAttribute('autoplay');
        videoEl.controls = true;
        videoEl.setAttribute('controls', '');
      } else {
        videoEl.autoplay = true;
        videoEl.setAttribute('autoplay', '');
      }

      const replaceFailedVideoWithPoster = () => {
        if (!videoEl.isConnected) return;
        const posterImg = buildPosterImg();
        if (posterImg) {
          videoEl.replaceWith(posterImg);
        } else {
          collapseBrokenElement(videoEl);
        }
      };

      if (validSources.length > 0) {
        const lastSource = validSources[validSources.length - 1];
        lastSource.addEventListener('error', replaceFailedVideoWithPoster, { once: true });
      } else {
        videoEl.addEventListener('error', replaceFailedVideoWithPoster, { once: true });
      }
    });

    // Mount sanitized & transformed DOM nodes directly without re-serializing to HTML strings (prevents mXSS)
    container.replaceChildren(fragment);

    let videoObserver: IntersectionObserver | null = null;
    if (typeof container.querySelectorAll === 'function') {
      const mountedVideos = Array.from(container.querySelectorAll('video'));
      const canAutoplayNow =
        isOnline &&
        !reducedMotion &&
        !(typeof document !== 'undefined' && Boolean(document.hidden)) &&
        !launcherService.isInGameHibernating() &&
        launcherService.getRunningGames().length === 0;

      if (canAutoplayNow) {
        mountedVideos.forEach((videoEl) => {
          videoEl.play()?.catch?.(() => {});
        });
      }

      if (mountedVideos.length > 0 && typeof IntersectionObserver === 'function') {
        videoObserver = new IntersectionObserver(
          (entries) => {
            const shouldHibernateNow =
              !onlineLifecycleManager.isOnline() ||
              prefersReducedMotion() ||
              (typeof document !== 'undefined' && Boolean(document.hidden)) ||
              launcherService.isInGameHibernating() ||
              launcherService.getRunningGames().length > 0;

            for (const entry of entries) {
              const targetVideo = entry.target as HTMLVideoElement;
              if (!entry.isIntersecting) {
                if (targetVideo.dataset) {
                  targetVideo.dataset.offscreenPaused = '1';
                }
                if (!targetVideo.paused) {
                  try {
                    targetVideo.pause();
                  } catch {
                    // Ignore pause errors
                  }
                }
              } else {
                if (targetVideo.dataset) {
                  delete targetVideo.dataset.offscreenPaused;
                }
                if (!shouldHibernateNow && targetVideo.autoplay && targetVideo.paused) {
                  targetVideo.play()?.catch?.(() => {});
                }
              }
            }
          },
          { rootMargin: '150px 0px' }
        );
        mountedVideos.forEach((videoEl) => videoObserver?.observe(videoEl));
      }
    }

    onMountedDom?.();

    return () => {
      videoObserver?.disconnect();
      if (typeof container.querySelectorAll === 'function') {
        container.querySelectorAll('video').forEach((v) => {
          try {
            v.pause();
            v.removeAttribute('src');
            if (typeof v.querySelectorAll === 'function') {
              v.querySelectorAll('source').forEach((s) => {
                s.removeAttribute('src');
                s.remove();
              });
            }
            v.load?.();
          } catch {
            // Ignore teardown errors
          }
        });
      }
      container.replaceChildren();
    };
  }, [
    html,
    isOnline,
    onlineGeneration,
    gameId,
    steamAppId,
    gogId,
    epicAppName,
    xboxProductId,
    packageFamilyName,
    xboxTitleId,
  ]);

  return (
    <div
      ref={descRef}
      data-testid="about-this-game-content"
      className="steam-description-content text-sm space-y-3 leading-relaxed"
    />
  );
};

export const SteamStorePage: React.FC<SteamStorePageProps> = ({
  game,
  collections,
  onBackToLibrary,
  onManageCollections,
  onToggleInstallStatus,
  onApplyFilter,
  onGameUpdated,
  connectedStorefronts,
  onOpenIntegrations,
  onFixMatch,
  onHideGame,
  onViewAchievements,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [currentGame, setCurrentGame] = useState<CanonicalGame>(game);
  const [, setLauncherTick] = useState(0);
  const [metadata, setMetadata] = useState<SteamEnrichedMetadata | null>(
    game.enrichedMetadata || null
  );
  const [currentSteamAppId, setCurrentSteamAppId] = useState<number | undefined>(game.steamAppId);
  const [isLoading, setIsLoading] = useState(!game.enrichedMetadata);
  const [isOnline, setIsOnline] = useState<boolean>(() => onlineLifecycleManager.isOnline());
  const [onlineGeneration, setOnlineGeneration] = useState<number>(() =>
    onlineLifecycleManager.getOnlineGeneration()
  );
  const [reloadTrigger, setReloadTrigger] = useState<number>(0);

  const isCooldown = steamApi.isStoreRateLimited();
  const activeGameIdRef = useRef<string>(game.id);
  const latestRichMetadataRef = useRef<SteamEnrichedMetadata | null>(
    hasRichMetadata(game.enrichedMetadata) ? game.enrichedMetadata! : null
  );

  useEffect(() => {
    setIsOnline(onlineLifecycleManager.isOnline());
    setOnlineGeneration(onlineLifecycleManager.getOnlineGeneration());

    const offConn = onlineLifecycleManager.onConnectivityChange((online, generation) => {
      setIsOnline(online);
      setOnlineGeneration(generation);
      if (online && !isAuthoritativeSteamMetadata(latestRichMetadataRef.current, game.steamAppId)) {
        setReloadTrigger((t) => t + 1);
      }
    });

    const offHydrated = onlineLifecycleManager.onGameHydrated((payload) => {
      if (payload.gameId !== game.id) return;
      const hydratedMeta = payload.detail?.enrichedMetadata;
      if (hydratedMeta && hasRichMetadata(hydratedMeta)) {
        if (
          isAuthoritativeSteamMetadata(latestRichMetadataRef.current) &&
          !isAuthoritativeSteamMetadata(hydratedMeta)
        ) {
          return;
        }
        const mergedHydrated =
          mergePreservingXboxHints(
            hydratedMeta,
            latestRichMetadataRef.current || game.enrichedMetadata
          ) || hydratedMeta;
        latestRichMetadataRef.current = mergedHydrated;
        setMetadata(mergedHydrated);
        setIsLoading(false);
      } else {
        setReloadTrigger((t) => t + 1);
      }
    });

    return () => {
      offConn();
      offHydrated();
    };
  }, [game.id]);

  useEffect(() => {
    const computePageLauncherSig = () => {
      const sess = launcherService.getActiveSession(game.id);
      const dl = launcherService.getActiveDownload(game.id);
      const selPlat = launcherService.getSelectedStorefrontForGame(game.id) || '';
      const rec = launcherService.getInstalledRecordForGame(game);
      return `${sess?.sessionId || ''}:${sess?.status || ''}|${dl?.taskId || ''}:${dl?.status || ''}:${Math.round(dl?.progressPercent || 0)}|${selPlat}|${rec?.platformId || ''}:${rec?.installPath || ''}:${rec?.executablePath || ''}`;
    };
    let prevSig = computePageLauncherSig();
    return launcherService.subscribe(() => {
      const nextSig = computePageLauncherSig();
      if (nextSig !== prevSig) {
        prevSig = nextSig;
        setLauncherTick((t) => t + 1);
      }
    });
  }, [game]);

  const [overrideTick, setOverrideTick] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return undefined;
    }
    const handleOverrideEvent = () => setOverrideTick((t) => t + 1);
    window.addEventListener('antigravity:user-override-updated', handleOverrideEvent);
    window.addEventListener('antigravity:user-override-removed', handleOverrideEvent);
    return () => {
      window.removeEventListener('antigravity:user-override-updated', handleOverrideEvent);
      window.removeEventListener('antigravity:user-override-removed', handleOverrideEvent);
    };
  }, []);

  const userOverride = useMemo(() => getUserOverrideForGame(game), [game, overrideTick]);
  const metadataRoute = useMemo(
    () => inferMetadataRouteFromOverride(userOverride),
    [userOverride]
  );
  const activeOverrideStampRef = useRef<string | undefined>(userOverride?.updatedAt);

  const connectedSet = useMemo(() => {
    if (connectedStorefronts && connectedStorefronts.length > 0) {
      return new Set<StorefrontId>(connectedStorefronts);
    }
    try {
      const integrations = loadIntegrations();
      const connected = integrations.filter((i) => i.isConnected).map((i) => i.storefrontId);
      if (connected.length > 0) {
        return new Set<StorefrontId>(connected);
      }
    } catch {
      // Fallback
    }
    return new Set<StorefrontId>(['steam', 'gog', 'epic', 'xbox']);
  }, [connectedStorefronts]);

  const disconnectedPlatforms = currentGame.platforms.filter(
    (p) => !connectedSet.has(p.platformId as StorefrontId)
  );

  const effectivePlatform =
    launcherService.getEffectivePlatformForGame(currentGame) || currentGame.platforms[0];
  const activeStoreId = effectivePlatform?.platformId || 'steam';
  const isRunning = launcherService.isGameRunning(currentGame.id);
  const isInstalled =
    launcherService.isGameInstalled(currentGame, activeStoreId) ||
    Boolean(effectivePlatform?.installed) ||
    currentGame.platforms.some((p) => p.installed);

  useEffect(() => {
    setCurrentGame(game);
    if (game.enrichedMetadata) {
      if (hasRichMetadata(game.enrichedMetadata)) {
        if (
          isAuthoritativeSteamMetadata(latestRichMetadataRef.current) &&
          !isAuthoritativeSteamMetadata(game.enrichedMetadata)
        ) {
          const preserved =
            mergePreservingXboxHints(latestRichMetadataRef.current, game.enrichedMetadata) ||
            latestRichMetadataRef.current!;
          latestRichMetadataRef.current = preserved;
          setMetadata(preserved);
        } else {
          const mergedIncoming =
            mergePreservingXboxHints(game.enrichedMetadata, latestRichMetadataRef.current) ||
            game.enrichedMetadata;
          latestRichMetadataRef.current = mergedIncoming;
          setMetadata((prev) =>
            prev && hasRichMetadata(prev)
              ? mergePreservingXboxHints({ ...prev, ...mergedIncoming }, prev) || {
                  ...prev,
                  ...mergedIncoming,
                }
              : mergedIncoming
          );
        }
      } else {
        setMetadata((prev) => (hasRichMetadata(prev) ? prev : game.enrichedMetadata!));
      }
      setIsLoading(false);
    }
  }, [game]);

  useEffect(() => {
    let isMounted = true;
    const isNewGame = activeGameIdRef.current !== game.id;
    const isOverrideUpdated = activeOverrideStampRef.current !== userOverride?.updatedAt;
    activeGameIdRef.current = game.id;
    activeOverrideStampRef.current = userOverride?.updatedAt;

    if (isNewGame) {
      latestRichMetadataRef.current = hasRichMetadata(game.enrichedMetadata)
        ? game.enrichedMetadata!
        : null;
    }

    if (isNewGame || isOverrideUpdated) {
      setMetadata(game.enrichedMetadata || null);
      setCurrentSteamAppId(game.steamAppId);
      if (isNewGame && !game.enrichedMetadata) {
        setIsLoading(true);
      }
    }

    async function loadData() {
      let existingRichMeta: SteamEnrichedMetadata | null = hasRichMetadata(game.enrichedMetadata)
        ? game.enrichedMetadata!
        : !isNewGame && hasRichMetadata(latestRichMetadataRef.current)
        ? latestRichMetadataRef.current
        : null;

      // Hydrate cached detail from SQLite offlineVault when game.enrichedMetadata was stripped, missing, or non-authoritative storefront_native
      if (
        (!existingRichMeta || !isAuthoritativeSteamMetadata(existingRichMeta, game.steamAppId)) &&
        typeof window !== 'undefined' &&
        window.electronAPI?.offlineVault?.getGameDetail
      ) {
        try {
          const vaultDetail = await window.electronAPI.offlineVault.getGameDetail(game.id);
          if (vaultDetail?.enrichedMetadata && hasRichMetadata(vaultDetail.enrichedMetadata)) {
            const shouldAdoptVault =
              !existingRichMeta ||
              (isAuthoritativeSteamMetadata(vaultDetail.enrichedMetadata) &&
                !isAuthoritativeSteamMetadata(existingRichMeta));
            if (shouldAdoptVault) {
              const mergedVault =
                mergePreservingXboxHints(
                  vaultDetail.enrichedMetadata,
                  game.enrichedMetadata || existingRichMeta
                ) || vaultDetail.enrichedMetadata;
              existingRichMeta = mergedVault;
              latestRichMetadataRef.current = mergedVault;
              if (isMounted) {
                setMetadata(mergedVault);
                setIsLoading(false);
              }
            }
          }
        } catch {
          // Ignore vault read error
        }
      }

      const currentOverride = getUserOverrideForGame(game);
      const route = inferMetadataRouteFromOverride(currentOverride);
      const isXboxCustomRoute =
        route?.source === 'custom' &&
        (String(route.matchedId || '').toLowerCase().startsWith('xbox-') ||
          /^[A-Z0-9]{12}$/i.test(String(route.matchedId || '').trim()));
      const isRoutedToNonSteamStore =
        route?.source === 'gog' || route?.source === 'epic' || isXboxCustomRoute;

      const resolveSafeMetadata = (
        incoming: SteamEnrichedMetadata | null | undefined,
        expectedSteamAppId?: number | null
      ): { resolved: SteamEnrichedMetadata | null; canPersistMetadata: boolean } => {
        if (incoming && !isSkeletonMetadata(incoming)) {
          if (
            !isOverrideUpdated &&
            !isRoutedToNonSteamStore &&
            isAuthoritativeSteamMetadata(existingRichMeta, expectedSteamAppId) &&
            !isAuthoritativeSteamMetadata(incoming, expectedSteamAppId)
          ) {
            const kept =
              mergePreservingXboxHints(existingRichMeta, incoming || game.enrichedMetadata) ||
              existingRichMeta!;
            latestRichMetadataRef.current = kept;
            return { resolved: kept, canPersistMetadata: false };
          }
          const mergedIncoming =
            mergePreservingXboxHints(incoming, game.enrichedMetadata || existingRichMeta) ||
            incoming;
          latestRichMetadataRef.current = mergedIncoming;
          return { resolved: mergedIncoming, canPersistMetadata: true };
        }
        // Non-destructive guard: NEVER overwrite existing rich metadata or persist skeleton_fallback over catalog data
        if (existingRichMeta && !isOverrideUpdated) {
          return { resolved: existingRichMeta, canPersistMetadata: false };
        }
        return { resolved: incoming || existingRichMeta || null, canPersistMetadata: false };
      };

      let targetAppId =
        route?.source === 'steam' && route.steamAppId
          ? route.steamAppId
          : game.steamAppId;

      // If user explicitly unlinked from Steam (steamAppId === null) or routed metadata to a non-Steam source
      const isExplicitNonSteam =
        game.isExplicitNonSteam === true ||
        currentOverride?.steamAppId === null ||
        currentOverride?.isExplicitNonSteam === true ||
        isRoutedToNonSteamStore ||
        route?.source === 'igdb';

      if (!targetAppId && !isExplicitNonSteam) {
        const instantEffective = steamMatcher.getEffectiveSteamAppId(game);
        if (instantEffective) {
          targetAppId = instantEffective;
          if (isMounted) {
            setCurrentSteamAppId(instantEffective);
          }
        }
      }

      // If no Steam App ID is set, intelligently search Steam Store for match with P0 priority & corroboration
      if (!targetAppId && !isExplicitNonSteam) {
        try {
          const matchOptions = {
            releaseYear: game.releaseDate,
            developers: game.developers,
            priority: RequestPriority.P0_INTERACTIVE,
          };
          const matched = await steamMatcher.matchGameToSteam(game.title, matchOptions);
          if (matched && isMounted) {
            targetAppId = matched;
            setCurrentSteamAppId(matched);
          }
        } catch (e) {
          console.warn('Steam matching failed:', e);
        }
      }

      const rawGameAny = game as CanonicalGame & {
        customCoverUrl?: string;
        hasCustomArtwork?: boolean;
      };
      const hasUserCoverOverride = Boolean(
        currentOverride?.capsuleImage ||
          rawGameAny.customCoverUrl ||
          rawGameAny.hasCustomArtwork
      );
      const hasUserHeaderOverride = Boolean(
        currentOverride?.headerImage || rawGameAny.hasCustomArtwork
      );

      const buildEnrichedTopLevelFields = (
        meta?: SteamEnrichedMetadata | null,
        browseAssets?: SteamStoreBrowseAssets | null
      ) => {
        if (!meta || isSkeletonMetadata(meta)) {
          return {
            nextShortDescription: game.shortDescription,
            nextDetailedDescription: game.detailedDescription,
            nextDevelopers: game.developers,
            nextPublishers: game.publishers,
            nextReleaseDate: game.releaseDate,
            nextHeaderImage: game.headerImage,
            nextCapsuleImage: game.capsuleImage,
            topLevelChanged: false,
          };
        }

        const cleanMetaShort = meta.shortDescription
          ? stripHtmlToPlainSynopsis(meta.shortDescription)
          : '';
        const cleanGameShort = game.shortDescription
          ? stripHtmlToPlainSynopsis(game.shortDescription)
          : '';
        const incomingShort =
          cleanMetaShort && !isGenericPlaceholderSynopsis(cleanMetaShort, game.title)
            ? cleanMetaShort
            : undefined;
        const shouldUpgradeShortFromSteam =
          !currentOverride?.shortDescription &&
          Boolean(incomingShort) &&
          (!cleanGameShort ||
            isGenericPlaceholderSynopsis(cleanGameShort, game.title) ||
            (Number(meta.appId) > 0 && !isAuthoritativeSteamMetadata(game.enrichedMetadata)));
        const nextShortDescription = shouldUpgradeShortFromSteam
          ? incomingShort
          : cleanGameShort || game.shortDescription;

        const incomingDetailed = meta.detailedDescription || meta.aboutTheGame || '';
        const metaHasRichHtmlOrSteam =
          RICH_HTML_DESC_RE.test(incomingDetailed) || Number(meta.appId) > 0;
        const existingHasRichHtml = RICH_HTML_DESC_RE.test(game.detailedDescription || '');
        const preferredMetaDetailed =
          RICH_HTML_DESC_RE.test(meta.detailedDescription || '')
            ? meta.detailedDescription
            : RICH_HTML_DESC_RE.test(meta.aboutTheGame || '')
            ? meta.aboutTheGame
            : meta.detailedDescription || meta.aboutTheGame;
        const nextDetailedDescription =
          !currentOverride?.detailedDescription &&
          preferredMetaDetailed &&
          (!game.detailedDescription ||
            isGenericPlaceholderSynopsis(game.detailedDescription, game.title) ||
            (metaHasRichHtmlOrSteam && !existingHasRichHtml) ||
            (isAuthoritativeSteamMetadata(meta) &&
              !isAuthoritativeSteamMetadata(game.enrichedMetadata)))
            ? preferredMetaDetailed
            : game.detailedDescription || meta.detailedDescription || meta.aboutTheGame;

        const validIncomingDevs =
          meta.developers?.filter((d) => d && d !== 'Unknown Developer') || [];
        const nextDevelopers =
          (!game.developers || game.developers.length === 0) && validIncomingDevs.length > 0
            ? validIncomingDevs
            : game.developers;
        const validIncomingPubs =
          meta.publishers?.filter((p) => p && p !== 'Unknown Publisher') || [];
        const nextPublishers =
          (!game.publishers || game.publishers.length === 0) && validIncomingPubs.length > 0
            ? validIncomingPubs
            : game.publishers;

        const gameHasMissingOrSentinelDate =
          !game.releaseDate ||
          game.releaseDate === 'TBA' ||
          isSentinelReleaseDate(game.releaseDate);
        const validMetaReleaseDate =
          meta.releaseDate && !isSentinelReleaseDate(meta.releaseDate)
            ? meta.releaseDate
            : undefined;
        const nextReleaseDate = gameHasMissingOrSentinelDate
          ? validMetaReleaseDate ||
            (isSentinelReleaseDate(game.releaseDate) ? 'TBA' : game.releaseDate)
          : game.releaseDate;

        const candidateSteamHeader = browseAssets?.headerImage || meta.headerImage;
        const nextHeaderImage =
          !hasUserHeaderOverride &&
          (!game.headerImage || isMicrosoftStoreAssetUrl(game.headerImage)) &&
          candidateSteamHeader &&
          !isMicrosoftStoreAssetUrl(candidateSteamHeader)
            ? candidateSteamHeader
            : game.headerImage;

        const candidateSteamCapsule = browseAssets?.capsuleImage || meta.capsuleImage;
        const nextCapsuleImage =
          !hasUserCoverOverride &&
          (!game.capsuleImage || isMicrosoftStoreAssetUrl(game.capsuleImage)) &&
          candidateSteamCapsule &&
          !isMicrosoftStoreAssetUrl(candidateSteamCapsule)
            ? candidateSteamCapsule
            : game.capsuleImage;

        const baselineMeta = existingRichMeta || game.enrichedMetadata;
        const richerScreenshots =
          (meta.screenshots?.length || 0) > (baselineMeta?.screenshots?.length || 0);
        const richerMovies =
          (meta.movies?.length || 0) > (baselineMeta?.movies?.length || 0);
        const upgradedPlaceholderSynopsis =
          Boolean(baselineMeta?.shortDescription) &&
          isGenericPlaceholderSynopsis(baselineMeta?.shortDescription, game.title) &&
          Boolean(nextShortDescription) &&
          !isGenericPlaceholderSynopsis(nextShortDescription, game.title);
        const updatedAbout =
          Boolean(meta.aboutTheGame) && meta.aboutTheGame !== baselineMeta?.aboutTheGame;
        const updatedLanguages =
          Boolean(
            meta.supportedLanguages &&
              meta.supportedLanguages !== baselineMeta?.supportedLanguages
          ) ||
          Boolean(
            (meta.languageOptions?.length || 0) > 0 &&
              (meta.languageOptions?.length !== baselineMeta?.languageOptions?.length ||
                JSON.stringify(meta.languageOptions) !==
                  JSON.stringify(baselineMeta?.languageOptions))
          ) ||
          Boolean(
            meta.languageTableSchema &&
              meta.languageTableSchema !== baselineMeta?.languageTableSchema
          );

        const topLevelChanged =
          nextShortDescription !== game.shortDescription ||
          nextDetailedDescription !== game.detailedDescription ||
          nextDevelopers !== game.developers ||
          nextReleaseDate !== game.releaseDate ||
          nextHeaderImage !== game.headerImage ||
          nextCapsuleImage !== game.capsuleImage ||
          richerScreenshots ||
          richerMovies ||
          upgradedPlaceholderSynopsis ||
          updatedAbout ||
          updatedLanguages;

        return {
          nextShortDescription,
          nextDetailedDescription,
          nextDevelopers,
          nextPublishers,
          nextReleaseDate,
          nextHeaderImage,
          nextCapsuleImage,
          topLevelChanged,
        };
      };

      // Case A: User explicitly routed Step 4 metadata to GOG or Epic
      if (isRoutedToNonSteamStore) {
        const crossSteamAppId = game.steamAppId || route?.steamAppId;
        const [rawFallbackData, liveAchs] = await Promise.all([
          fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(game, currentOverride),
          game.steamAppId
            ? steamAchievementsService.fetchPlayerGameAchievements(game.steamAppId)
            : Promise.resolve(null),
        ]);

        let fallbackData = rawFallbackData;
        if (
          fallbackData &&
          !isSkeletonMetadata(fallbackData) &&
          (!fallbackData.movies || fallbackData.movies.length === 0)
        ) {
          if (existingRichMeta?.movies && existingRichMeta.movies.length > 0) {
            fallbackData = {
              ...fallbackData,
              movies: existingRichMeta.movies,
            };
          } else if (crossSteamAppId) {
            try {
              const steamMetaForMovies = await steamApi.fetchGameMetadata(
                crossSteamAppId,
                RequestPriority.P0_INTERACTIVE
              );
              if (steamMetaForMovies?.movies && steamMetaForMovies.movies.length > 0) {
                fallbackData = {
                  ...fallbackData,
                  movies: steamMetaForMovies.movies,
                };
              }
            } catch {
              // Ignore cross-store movie fallback error
            }
          }
        }

        const { resolved, canPersistMetadata } = resolveSafeMetadata(fallbackData);

        if (isMounted && resolved) {
          setMetadata(resolved);
          const {
            nextShortDescription,
            nextDetailedDescription,
            nextDevelopers,
            nextPublishers,
            nextReleaseDate,
            nextHeaderImage,
            nextCapsuleImage,
            topLevelChanged,
          } = buildEnrichedTopLevelFields(canPersistMetadata ? resolved : null);
          let updatedPlatforms = game.platforms;
          let hasChanges =
            canPersistMetadata && (!game.enrichedMetadata || isOverrideUpdated || topLevelChanged);

          if (liveAchs) {
            const currentSteamPlat = game.platforms.find((p) => p.platformId === 'steam');
            const curAch = currentSteamPlat?.achievements;
            const achChanged =
              !curAch ||
              curAch.unlocked !== liveAchs.unlocked ||
              curAch.total !== liveAchs.total ||
              curAch.source !== liveAchs.source;
            if (achChanged) {
              hasChanges = true;
              updatedPlatforms = game.platforms.map((p) =>
                p.platformId === 'steam' ? { ...p, achievements: liveAchs } : p
              );
            }
          }

          if (hasChanges) {
            const updatedGame: CanonicalGame = {
              ...game,
              platforms: updatedPlatforms,
              shortDescription: nextShortDescription,
              detailedDescription: nextDetailedDescription,
              developers: nextDevelopers,
              publishers: nextPublishers,
              releaseDate: nextReleaseDate,
              headerImage: nextHeaderImage,
              capsuleImage: nextCapsuleImage,
              enrichedMetadata: canPersistMetadata
                ? resolved
                : existingRichMeta || game.enrichedMetadata,
            };
            setCurrentGame(updatedGame);
            onGameUpdated?.(updatedGame);
          }
        }
      } else if (targetAppId) {
        // Case B: Matched or routed to Steam
        const needsBrowseArtworkUpgrade =
          onlineLifecycleManager.isOnline() &&
          typeof steamApi.fetchStoreBrowseAssets === 'function' &&
          ((!hasUserCoverOverride &&
            (!game.capsuleImage || isMicrosoftStoreAssetUrl(game.capsuleImage))) ||
            (!hasUserHeaderOverride &&
              (!game.headerImage || isMicrosoftStoreAssetUrl(game.headerImage))));

        const browseAssetsPromise: Promise<SteamStoreBrowseAssets | null> | null =
          needsBrowseArtworkUpgrade
            ? Promise.resolve(
                steamApi.fetchStoreBrowseAssets(targetAppId, RequestPriority.P0_INTERACTIVE)
              ).catch(() => null)
            : null;

        const [liveData, liveAchs] = await Promise.all([
          steamApi.fetchGameMetadata(targetAppId, RequestPriority.P0_INTERACTIVE),
          steamAchievementsService.fetchPlayerGameAchievements(targetAppId),
        ]);

        const BROWSE_PENDING = Symbol('browse-pending');
        const settledBrowseOrPending = browseAssetsPromise
          ? await Promise.race([browseAssetsPromise, Promise.resolve(BROWSE_PENDING)])
          : null;
        const instantBrowse =
          typeof steamApi.getStoreBrowseAssetsInstant === 'function'
            ? steamApi.getStoreBrowseAssetsInstant(targetAppId)
            : null;
        const resolvedBrowseAssets: SteamStoreBrowseAssets | null =
          settledBrowseOrPending !== BROWSE_PENDING && settledBrowseOrPending
            ? settledBrowseOrPending
            : instantBrowse;

        if (isMounted) {
          let candidateMetadata: SteamEnrichedMetadata | null = null;
          if (liveData && !isSkeletonMetadata(liveData)) {
            candidateMetadata = resolvedBrowseAssets
              ? {
                  ...liveData,
                  headerImage: resolvedBrowseAssets.headerImage || liveData.headerImage,
                  capsuleImage: resolvedBrowseAssets.capsuleImage || liveData.capsuleImage,
                }
              : liveData;
            if (!candidateMetadata.movies || candidateMetadata.movies.length === 0) {
              if (existingRichMeta?.movies && existingRichMeta.movies.length > 0) {
                candidateMetadata = {
                  ...candidateMetadata,
                  movies: existingRichMeta.movies,
                };
              } else if (
                game.platforms.some(
                  (p) =>
                    p.platformId === 'epic' || p.platformId === 'gog' || p.platformId === 'xbox'
                )
              ) {
                try {
                  const nonSteamFallback =
                    await fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(
                      game,
                      currentOverride
                    );
                  if (nonSteamFallback?.movies && nonSteamFallback.movies.length > 0) {
                    candidateMetadata = {
                      ...candidateMetadata,
                      movies: nonSteamFallback.movies,
                    };
                  }
                } catch {
                  // Ignore fallback movie lookup error
                }
              }
            }
            if (currentOverride && route?.mode === 'routed' && route.source === 'steam') {
              updateRoutedMetadataSnapshot(game.id, {
                title: candidateMetadata.name,
                shortDescription: candidateMetadata.shortDescription,
                detailedDescription:
                  candidateMetadata.detailedDescription || candidateMetadata.aboutTheGame,
                headerImage: candidateMetadata.headerImage,
                developers: candidateMetadata.developers,
                publishers: candidateMetadata.publishers,
                genres: candidateMetadata.genres,
                tags: candidateMetadata.tags,
                releaseDate: candidateMetadata.releaseDate,
              });
            }
          } else if (
            !existingRichMeta ||
            isOverrideUpdated ||
            !isAuthoritativeSteamMetadata(existingRichMeta, targetAppId)
          ) {
            // Query non-Steam fallback only when authoritative Steam metadata is unavailable
            const fallbackData = await fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(
              game,
              currentOverride
            );
            if (isMounted) {
              candidateMetadata = fallbackData;
            }
          }

          const { resolved: resolvedMetadata, canPersistMetadata } = resolveSafeMetadata(
            candidateMetadata,
            targetAppId
          );

          if (isMounted && resolvedMetadata) {
            setMetadata(resolvedMetadata);
          }

          const {
            nextShortDescription,
            nextDetailedDescription,
            nextDevelopers,
            nextPublishers,
            nextReleaseDate,
            nextHeaderImage,
            nextCapsuleImage,
            topLevelChanged,
          } = buildEnrichedTopLevelFields(
            canPersistMetadata ? resolvedMetadata : null,
            resolvedBrowseAssets
          );

          let hasChanges = canPersistMetadata && topLevelChanged;
          let updatedPlatforms = game.platforms;

          if (liveAchs) {
            const currentSteamPlat = game.platforms.find((p) => p.platformId === 'steam');
            const curAch = currentSteamPlat?.achievements;
            const achChanged =
              !curAch ||
              curAch.unlocked !== liveAchs.unlocked ||
              curAch.total !== liveAchs.total ||
              curAch.source !== liveAchs.source;

            if (achChanged) {
              hasChanges = true;
              updatedPlatforms = game.platforms.map((p) => {
                if (p.platformId === 'steam') {
                  return {
                    ...p,
                    achievements: liveAchs,
                  };
                }
                return p;
              });
            }
          }

          if (targetAppId !== game.steamAppId) {
            hasChanges = true;
          }

          if (
            canPersistMetadata &&
            resolvedMetadata &&
            (!game.enrichedMetadata ||
              isOverrideUpdated ||
              !isAuthoritativeSteamMetadata(game.enrichedMetadata, targetAppId))
          ) {
            hasChanges = true;
          }

          let latestGameSnapshot: CanonicalGame = game;

          if (hasChanges && isMounted) {
            const updatedGame: CanonicalGame = {
              ...game,
              platforms: updatedPlatforms,
              steamAppId: targetAppId,
              shortDescription: nextShortDescription,
              detailedDescription: nextDetailedDescription,
              developers: nextDevelopers,
              publishers: nextPublishers,
              releaseDate: nextReleaseDate,
              headerImage: nextHeaderImage,
              capsuleImage: nextCapsuleImage,
              enrichedMetadata: canPersistMetadata
                ? resolvedMetadata || existingRichMeta || game.enrichedMetadata
                : existingRichMeta || game.enrichedMetadata,
            };
            latestGameSnapshot = updatedGame;
            setCurrentGame(updatedGame);
            onGameUpdated?.(updatedGame);
          }

          if (settledBrowseOrPending === BROWSE_PENDING && browseAssetsPromise) {
            void browseAssetsPromise.then((lateBrowse) => {
              if (!isMounted || !lateBrowse) return;
              const upgradedHeader =
                !hasUserHeaderOverride &&
                lateBrowse.headerImage &&
                (!latestGameSnapshot.headerImage ||
                  isMicrosoftStoreAssetUrl(latestGameSnapshot.headerImage))
                  ? lateBrowse.headerImage
                  : undefined;
              const upgradedCapsule =
                !hasUserCoverOverride &&
                lateBrowse.capsuleImage &&
                (!latestGameSnapshot.capsuleImage ||
                  isMicrosoftStoreAssetUrl(latestGameSnapshot.capsuleImage))
                  ? lateBrowse.capsuleImage
                  : undefined;
              if (!upgradedHeader && !upgradedCapsule) return;

              setMetadata((prev) =>
                prev
                  ? {
                      ...prev,
                      headerImage: upgradedHeader || prev.headerImage,
                      capsuleImage: upgradedCapsule || prev.capsuleImage,
                    }
                  : prev
              );

              const nextGame: CanonicalGame = {
                ...latestGameSnapshot,
                headerImage: upgradedHeader || latestGameSnapshot.headerImage,
                capsuleImage: upgradedCapsule || latestGameSnapshot.capsuleImage,
                enrichedMetadata: latestGameSnapshot.enrichedMetadata
                  ? {
                      ...latestGameSnapshot.enrichedMetadata,
                      headerImage:
                        upgradedHeader || latestGameSnapshot.enrichedMetadata.headerImage,
                      capsuleImage:
                        upgradedCapsule || latestGameSnapshot.enrichedMetadata.capsuleImage,
                    }
                  : latestGameSnapshot.enrichedMetadata,
              };
              latestGameSnapshot = nextGame;
              setCurrentGame(nextGame);
              onGameUpdated?.(nextGame);
            });
          }
        }
      } else {
        // Case C: Non-Steam game (e.g. GOG, Epic, Xbox, IGDB exclusive)
        let fallbackData = await fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(
          game,
          currentOverride
        );
        if (
          fallbackData &&
          !isSkeletonMetadata(fallbackData) &&
          (!fallbackData.movies || fallbackData.movies.length === 0) &&
          existingRichMeta?.movies &&
          existingRichMeta.movies.length > 0
        ) {
          fallbackData = {
            ...fallbackData,
            movies: existingRichMeta.movies,
          };
        }

        const { resolved, canPersistMetadata } = resolveSafeMetadata(fallbackData);

        if (isMounted && resolved) {
          setMetadata(resolved);
          if (canPersistMetadata) {
            const {
              nextShortDescription,
              nextDetailedDescription,
              nextDevelopers,
              nextPublishers,
              nextReleaseDate,
              nextHeaderImage,
              nextCapsuleImage,
              topLevelChanged,
            } = buildEnrichedTopLevelFields(resolved);
            const hasChanges = !game.enrichedMetadata || isOverrideUpdated || topLevelChanged;
            if (hasChanges) {
              const updatedGame: CanonicalGame = {
                ...game,
                shortDescription: nextShortDescription,
                detailedDescription: nextDetailedDescription,
                developers: nextDevelopers,
                publishers: nextPublishers,
                releaseDate: nextReleaseDate,
                headerImage: nextHeaderImage,
                capsuleImage: nextCapsuleImage,
                enrichedMetadata: resolved,
              };
              setCurrentGame(updatedGame);
              onGameUpdated?.(updatedGame);
            }
          }
        }
      }

      if (isMounted) setIsLoading(false);
    }

    loadData();

    return () => {
      isMounted = false;
    };
  }, [
    game.id,
    game.steamAppId,
    userOverride?.updatedAt,
    metadataRoute?.source,
    metadataRoute?.matchedId,
    metadataRoute?.steamAppId,
    metadataRoute?.gogId,
    reloadTrigger,
  ]);

  const isDynamicRouted =
    Boolean(userOverride) &&
    metadataRoute?.mode === 'routed' &&
    (metadataRoute.source === 'steam' ||
      metadataRoute.source === 'gog' ||
      metadataRoute.source === 'epic' ||
      (metadataRoute.source === 'custom' &&
        (String(metadataRoute.matchedId || '').toLowerCase().startsWith('xbox-') ||
          /^[A-Z0-9]{12}$/i.test(String(metadataRoute.matchedId || '').trim()))));

  const effectiveSteamId = steamMatcher.getEffectiveSteamAppId(game);
  const gogPlatform = currentGame.platforms.find((p) => p.platformId === 'gog');
  const epicPlatform = currentGame.platforms.find((p) => p.platformId === 'epic');
  const xboxPlatform = currentGame.platforms.find((p) => p.platformId === 'xbox');
  const rawCurrentGameXbox = currentGame as CanonicalGame & {
    xboxProductId?: string | null;
    packageFamilyName?: string | null;
    xboxTitleId?: string | null;
  };
  const effectiveGogId = metadataRoute?.gogId || gogPlatform?.platformGameId || null;
  const effectiveEpicAppName = epicPlatform?.platformGameId || null;
  const effectiveXboxProductId =
    rawCurrentGameXbox.xboxProductId || xboxPlatform?.xboxProductId || null;
  const effectivePackageFamilyName =
    rawCurrentGameXbox.packageFamilyName || xboxPlatform?.packageFamilyName || null;
  const effectiveXboxTitleId =
    rawCurrentGameXbox.xboxTitleId || xboxPlatform?.xboxTitleId || null;
  const resolvedSteamAppId =
    currentSteamAppId || currentGame.steamAppId || effectiveSteamId || null;

  const screenshots = metadata?.screenshots || [];
  const movies = metadata?.movies || [];
  const reviewSummary =
    metadata?.reviewSummary &&
    (metadata.reviewSummary.totalReviews > 0 || !game.reviewSummary?.totalReviews)
      ? metadata.reviewSummary
      : game.reviewSummary || metadata?.reviewSummary;

  const candidateMetaHeader =
    metadata?.headerImage &&
    !(
      isMicrosoftStoreAssetUrl(metadata.headerImage) &&
      currentGame.headerImage &&
      !isMicrosoftStoreAssetUrl(currentGame.headerImage)
    )
      ? metadata.headerImage
      : currentGame.headerImage || metadata?.headerImage;

  const rawEffectiveHeaderImage =
    userOverride?.headerImage ||
    candidateMetaHeader ||
    currentGame.headerImage ||
    game.headerImage;

  const headerOverrideToken = userOverride?.headerImage
    ? userOverride.updatedAt || '1'
    : undefined;
  const coverOverrideToken = userOverride?.capsuleImage
    ? userOverride.updatedAt || '1'
    : undefined;

  const effectiveHeaderImage = rawEffectiveHeaderImage
    ? toOlMediaUrl({
        url: rawEffectiveHeaderImage,
        gameId: game.id,
        role: 'header',
        ordinal: 0,
        steamAppId: resolvedSteamAppId,
        gogId: effectiveGogId,
        epicAppName: effectiveEpicAppName,
        xboxProductId: effectiveXboxProductId,
        packageFamilyName: effectivePackageFamilyName,
        xboxTitleId: effectiveXboxTitleId,
        ov: headerOverrideToken,
      })
    : undefined;

  const rawFallbackHeroImage =
    userOverride?.capsuleImage || currentGame.capsuleImage || game.capsuleImage;

  const fallbackHeroImage = rawFallbackHeroImage
    ? toOlMediaUrl({
        url: rawFallbackHeroImage,
        gameId: game.id,
        role: 'cover',
        ordinal: 0,
        steamAppId: resolvedSteamAppId,
        gogId: effectiveGogId,
        epicAppName: effectiveEpicAppName,
        xboxProductId: effectiveXboxProductId,
        packageFamilyName: effectivePackageFamilyName,
        xboxTitleId: effectiveXboxTitleId,
        ov: coverOverrideToken,
      })
    : undefined;

  const shortDescription =
    isDynamicRouted && !metadataRoute?.customSynopsisEdited
      ? (!isSkeletonMetadata(metadata) ? metadata?.shortDescription : undefined) ||
        userOverride?.shortDescription ||
        currentGame.shortDescription ||
        game.shortDescription ||
        metadata?.shortDescription
      : userOverride?.shortDescription ||
        (!isSkeletonMetadata(metadata) ? metadata?.shortDescription : undefined) ||
        currentGame.shortDescription ||
        game.shortDescription ||
        metadata?.shortDescription;

  const developers = isDynamicRouted
    ? metadata?.developers?.length
      ? metadata.developers
      : userOverride?.developers?.length
      ? userOverride.developers
      : currentGame.developers || game.developers || []
    : userOverride?.developers?.length
    ? userOverride.developers
    : metadata?.developers?.length
    ? metadata.developers
    : currentGame.developers || game.developers || [];

  const publishers = isDynamicRouted
    ? metadata?.publishers?.length
      ? metadata.publishers
      : userOverride?.publishers?.length
      ? userOverride.publishers
      : currentGame.publishers || game.publishers || []
    : userOverride?.publishers?.length
    ? userOverride.publishers
    : metadata?.publishers?.length
    ? metadata.publishers
    : currentGame.publishers || game.publishers || [];

  const cleanMetaReleaseDate =
    metadata?.releaseDate &&
    metadata.releaseDate !== 'TBA' &&
    !isSentinelReleaseDate(metadata.releaseDate)
      ? metadata.releaseDate
      : undefined;
  const cleanGameReleaseDate =
    currentGame.releaseDate &&
    currentGame.releaseDate !== 'TBA' &&
    !isSentinelReleaseDate(currentGame.releaseDate)
      ? currentGame.releaseDate
      : game.releaseDate &&
        game.releaseDate !== 'TBA' &&
        !isSentinelReleaseDate(game.releaseDate)
      ? game.releaseDate
      : undefined;

  const releaseDate = isDynamicRouted
    ? cleanMetaReleaseDate || userOverride?.releaseDate || cleanGameReleaseDate || 'TBA'
    : userOverride?.releaseDate || cleanMetaReleaseDate || cleanGameReleaseDate || 'TBA';

  const tags = isDynamicRouted
    ? metadata?.tags?.length
      ? metadata.tags
      : userOverride?.tags?.length
      ? userOverride.tags
      : currentGame.tags || game.tags || []
    : userOverride?.tags?.length
    ? userOverride.tags
    : metadata?.tags?.length
    ? metadata.tags
    : currentGame.tags || game.tags || [];

  const genres = isDynamicRouted
    ? metadata?.genres?.length
      ? metadata.genres
      : userOverride?.genres?.length
      ? userOverride.genres
      : currentGame.genres || game.genres || []
    : userOverride?.genres?.length
    ? userOverride.genres
    : metadata?.genres?.length
    ? metadata.genres
    : currentGame.genres || game.genres || [];

  const isOwnedOnSteam = isGameOwnedOnSteam(game.platforms);
  const effectiveTags = getEffectiveTags(tags, isOwnedOnSteam);

  const pickRichDetailed = (m?: SteamEnrichedMetadata | null): string | undefined => {
    if (!m || isSkeletonMetadata(m)) return undefined;
    if (RICH_HTML_DESC_RE.test(m.aboutTheGame || '')) return m.aboutTheGame;
    if (RICH_HTML_DESC_RE.test(m.detailedDescription || '')) return m.detailedDescription;
    return m.aboutTheGame || m.detailedDescription;
  };
  const gameRichDetailed =
    RICH_HTML_DESC_RE.test(currentGame.enrichedMetadata?.aboutTheGame || '')
      ? currentGame.enrichedMetadata?.aboutTheGame
      : RICH_HTML_DESC_RE.test(currentGame.enrichedMetadata?.detailedDescription || '')
      ? currentGame.enrichedMetadata?.detailedDescription
      : RICH_HTML_DESC_RE.test(currentGame.detailedDescription || '')
      ? currentGame.detailedDescription
      : currentGame.enrichedMetadata?.aboutTheGame ||
        currentGame.enrichedMetadata?.detailedDescription ||
        currentGame.detailedDescription ||
        game.enrichedMetadata?.aboutTheGame ||
        game.enrichedMetadata?.detailedDescription ||
        game.detailedDescription;

  const detailedDescription = isDynamicRouted
    ? pickRichDetailed(metadata) || userOverride?.detailedDescription || gameRichDetailed
    : userOverride?.detailedDescription || pickRichDetailed(metadata) || gameRichDetailed;

  const [openCriticData, setOpenCriticData] = useState<CriticScoreData | null>(() =>
    getOpenCriticData(
      effectiveSteamId || undefined,
      game.title,
      reviewSummary?.positivePercent,
      currentGame.releaseDate
    )
  );

  useEffect(() => {
    setOpenCriticData(
      getOpenCriticData(
        effectiveSteamId || undefined,
        game.title,
        reviewSummary?.positivePercent,
        currentGame.releaseDate
      )
    );

    const handleCriticUpdate = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          title?: string;
          steamAppId?: number;
          data: CriticScoreData | null;
        }>
      ).detail;
      if (
        detail &&
        (detail.title?.toLowerCase() === game.title.toLowerCase() ||
          (detail.steamAppId &&
            (detail.steamAppId === game.steamAppId || detail.steamAppId === effectiveSteamId)))
      ) {
        setOpenCriticData(detail.data);
      }
    };

    window.addEventListener('antigravity_critic_updated', handleCriticUpdate);
    return () => window.removeEventListener('antigravity_critic_updated', handleCriticUpdate);
  }, [game.steamAppId, game.title, reviewSummary?.positivePercent, effectiveSteamId]);

  const syncInlineVideoPlayback = () => {
    const root = containerRef.current;
    if (!root || typeof root.querySelectorAll !== 'function') return;
    const shouldHibernateMedia =
      !onlineLifecycleManager.isOnline() ||
      prefersReducedMotion() ||
      (typeof document !== 'undefined' && Boolean(document.hidden)) ||
      launcherService.isInGameHibernating() ||
      launcherService.getRunningGames().length > 0;
    const videos = root.querySelectorAll('video');
    videos.forEach((video) => {
      if (shouldHibernateMedia) {
        if (!video.paused) {
          try {
            video.pause();
          } catch {
            // Ignore pause error
          }
        }
      } else if (
        video.autoplay &&
        video.paused &&
        video.dataset?.offscreenPaused !== '1' &&
        video.closest('.steam-description-content')
      ) {
        video.play().catch(() => {});
      }
    });
  };

  useEffect(() => {
    syncInlineVideoPlayback();
    const unsubLauncher = launcherService.subscribe(syncInlineVideoPlayback);
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', syncInlineVideoPlayback);
    }
    return () => {
      unsubLauncher();
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', syncInlineVideoPlayback);
      }
    };
  }, [game.id, metadata, isOnline]);

  return (
    <div ref={containerRef} className="w-full min-h-full bg-[#0e141b] text-steam-text pb-24 relative">
      {/* Background Hero Ambient Glow */}
      {effectiveHeaderImage && (
        <div
          className="absolute top-0 left-0 right-0 h-96 opacity-15 pointer-events-none bg-cover bg-center filter blur-3xl"
          style={{
            backgroundImage: `url(${effectiveHeaderImage})`,
          }}
        />
      )}

      <div className="relative max-w-6xl mx-auto px-4 md:px-8 pt-6 space-y-6">
        {/* Navigation Breadcrumb */}
        <div className="flex items-center justify-between border-b border-steam-border/40 pb-4">
          <div className="flex items-center gap-2 text-xs text-steam-subtext">
            <button
              type="button"
              onClick={onBackToLibrary}
              className="inline-flex items-center gap-1.5 min-h-6 text-steam-accent hover:text-white hover:underline cursor-pointer uppercase tracking-wider text-[11px] font-bold transition-colors group"
              title="Return to All Games library grid"
            >
              <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
              <span>All Games</span>
            </button>
            <span>&gt;</span>
            <span className="text-white font-semibold truncate max-w-md">{game.title}</span>
          </div>
        </div>

        {/* Akamai Edge Cooldown Notice */}
        {isCooldown && (
          <div className="bg-[#1b2838]/90 border border-[#2a475e] text-xs text-steam-subtext rounded px-3.5 py-2.5 flex items-center justify-between shadow-sm">
            <span>
              <strong className="text-steam-accent">Local Library Mode:</strong> Live store web requests paused while Akamai CDN edge cooldown clears. Showing official local assets & artwork.
            </span>
            <span className="text-[11px] text-[#acb2b8] font-mono">Auto-resumes in ~15m</span>
          </div>
        )}

        {/* Storefront Not Connected Notice Banner */}
        {disconnectedPlatforms.length > 0 && (
          <div className="bg-amber-950/40 border border-amber-500/50 text-xs text-amber-200 rounded px-3.5 py-2.5 flex items-center justify-between gap-3 shadow-sm">
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                <strong className="text-amber-300">
                  {disconnectedPlatforms
                    .map((p) => getStorefrontDisplayName(p.platformId))
                    .join(', ')}{' '}
                  (Not Connected):
                </strong>{' '}
                This title is cataloged in your baseline library. Live purchase sync & cloud trophies will resume when reconnected.
              </span>
            </div>
            {onOpenIntegrations && (
              <button
                type="button"
                onClick={onOpenIntegrations}
                className="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/50 text-amber-200 text-xs font-semibold shrink-0 transition-colors cursor-pointer"
              >
                Connect Storefront
              </button>
            )}
          </div>
        )}

        {/* Game Title & Platform Badges Header */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h1 className="text-3xl md:text-4xl font-extrabold text-white tracking-tight drop-shadow">
              {game.title}
            </h1>
            <div className="flex flex-wrap items-center gap-2.5">
              {(isRunning || isInstalled) && (
                <div className="flex items-center gap-2 border-r border-[#2a475e]/70 pr-3 mr-1">
                  {isRunning ? (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-950/60 border border-emerald-500/40 text-xs font-semibold text-emerald-400">
                      <Activity className="w-3.5 h-3.5 text-emerald-400 animate-pulse shrink-0" />
                      <span>Active Session</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-950/40 border border-emerald-500/30 text-xs font-semibold text-emerald-400">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span>Ready to Play</span>
                    </span>
                  )}
                </div>
              )}
              <span className="text-xs uppercase tracking-wider text-steam-subtext font-semibold">
                Owned on:
              </span>
              <PlatformBadges
                platforms={currentGame.platforms}
                game={currentGame}
                steamAppId={currentSteamAppId || currentGame.steamAppId}
                size="md"
                connectedStorefronts={connectedStorefronts}
              />
              {(() => {
                const nativePlatforms = getNativeOsPlatforms(currentGame);
                if (nativePlatforms.length === 0) return null;
                return (
                  <div className="inline-flex items-center gap-1.5 ml-2 pl-2.5 border-l border-white/15">
                    <span className="text-xs uppercase tracking-wider text-steam-subtext font-semibold">
                      Native OS:
                    </span>
                    <NativeOsBadges
                      platforms={nativePlatforms}
                      variant="detail-pill"
                      onSelectOs={(os) =>
                        onApplyFilter?.({
                          type: 'os',
                          label: 'Native OS',
                          value: os === 'mac' ? 'macOS' : 'Windows',
                        })
                      }
                    />
                  </div>
                );
              })()}
            </div>
          </div>
        </div>

        {/* Steam Library Action & Stats Bar (Play Button, Library Status, Play Time, Last Played, Space Required, Achievements) */}
        <SteamLibraryActionBar
          game={currentGame}
          metadata={metadata}
          collections={collections}
          onManageCollections={onManageCollections}
          onToggleInstallStatus={onToggleInstallStatus}
          onApplyFilter={onApplyFilter}
          connectedStorefronts={connectedStorefronts}
          onFixMatch={onFixMatch}
          onHideGame={onHideGame}
          onViewAchievements={onViewAchievements}
        />

        {/* Main Steam Highlight Showcase (1:1 Steam 2-Column Split: Media Player + Details) */}
        <div className="flex flex-col lg:flex-row gap-4 bg-[#16202d]/95 rounded border border-steam-border p-4 shadow-xl">
          {/* Left Column: Media Gallery (Trailers + Screenshots) */}
          <div className="flex-1 min-w-0 lg:max-w-[616px]">
            {isLoading ? (
              <div className="aspect-video w-full bg-black/60 rounded flex flex-col items-center justify-center gap-3 animate-pulse border border-steam-border">
                <Sparkles className="w-8 h-8 text-steam-accent animate-spin" />
                <span className="text-xs text-steam-accent">Loading Steam Media...</span>
              </div>
            ) : (
              <MediaGallery
                screenshots={screenshots}
                movies={movies}
                headerImage={effectiveHeaderImage}
                title={game.title}
                autoplay={false}
                gameId={game.id}
                steamAppId={resolvedSteamAppId}
                gogId={effectiveGogId}
                epicAppName={effectiveEpicAppName}
                xboxProductId={effectiveXboxProductId}
                packageFamilyName={effectivePackageFamilyName}
                xboxTitleId={effectiveXboxTitleId}
              />
            )}
          </div>

          {/* Right Column: 1:1 Steam Details (Fixed 324px Width) */}
          <SteamHeroDetails
            headerImage={effectiveHeaderImage}
            fallbackImage={fallbackHeroImage}
            title={game.title}
            shortDescription={shortDescription}
            reviewSummary={reviewSummary}
            openCritic={openCriticData}
            releaseDate={releaseDate}
            developers={developers}
            publishers={publishers}
            tags={effectiveTags}
            onApplyFilter={onApplyFilter}
            gameId={game.id}
            steamAppId={resolvedSteamAppId}
            gogId={effectiveGogId}
            epicAppName={effectiveEpicAppName}
            xboxProductId={effectiveXboxProductId}
            packageFamilyName={effectivePackageFamilyName}
            xboxTitleId={effectiveXboxTitleId}
            headerOverrideToken={headerOverrideToken}
            coverOverrideToken={coverOverrideToken}
          />
        </div>

        {/* Gameplay Completion Dashboard (HowLongToBeat) */}
        <HowLongToBeatCard
          gameTitle={game.title}
          appId={currentSteamAppId || game.steamAppId}
          genres={game.genres}
          tags={game.tags}
        />

        {/* Critic Consensus Dashboard (OpenCritic / Metacritic) */}
        <OpenCriticCard
          gameTitle={game.title}
          openCritic={openCriticData}
        />

        {/* Content Section: Description & Technical Specs */}
        <div className="cv-section grid grid-cols-1 lg:grid-cols-12 gap-8 pt-4">
          {/* Main Column: "About This Game" */}
          <div className="lg:col-span-8 space-y-6">
            <div className="cv-store-section bg-[#16202d] rounded border border-steam-border p-6 shadow-md">
              <h2 className="text-sm font-bold tracking-wider text-steam-accent uppercase border-b border-steam-border/60 pb-3 mb-4 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-steam-accent" />
                About This Game
              </h2>

              {detailedDescription ? (
                <AboutThisGameHtml
                  html={detailedDescription}
                  isOnline={isOnline}
                  onlineGeneration={onlineGeneration}
                  gameId={game.id}
                  steamAppId={resolvedSteamAppId}
                  gogId={effectiveGogId}
                  epicAppName={effectiveEpicAppName}
                  xboxProductId={effectiveXboxProductId}
                  packageFamilyName={effectivePackageFamilyName}
                  xboxTitleId={effectiveXboxTitleId}
                  onMountedDom={syncInlineVideoPlayback}
                />
              ) : shortDescription &&
                !isGenericPlaceholderSynopsis(shortDescription, game.title) ? (
                <div className="steam-description-content text-sm space-y-3 leading-relaxed text-[#acb2b8]">
                  <p className="bb_paragraph">{shortDescription}</p>
                </div>
              ) : (
                <div className="text-sm text-steam-subtext italic">
                  {!isOnline
                    ? 'Storefront overview has not been cached for offline viewing yet. Full details will synchronize automatically once you reconnect.'
                    : isCooldown
                    ? 'Live store web requests are temporarily paused while CDN rate-limit cooldown clears. Full overview will synchronize automatically.'
                    : 'Extended store description is not currently available for this title.'}
                </div>
              )}
            </div>

            {/* System Requirements Section */}
            <div className="cv-store-section">
              <SystemRequirements
                gameId={currentGame.id}
                requirements={metadata?.systemRequirements}
                macRequirements={metadata?.macRequirements}
                linuxRequirements={metadata?.linuxRequirements}
                metadataQuality={
                  metadata?.metadataQuality === 'storefront_native'
                    ? isOnline
                      ? 'scraped'
                      : undefined
                    : metadata?.metadataQuality
                }
              />
            </div>
          </div>

          {/* Right Sidebar Details (1:1 Steam Right Column) */}
          <div className="lg:col-span-4 space-y-4">
            <SteamFeaturesList
              categories={metadata?.categories}
              title={game.title}
              isOwnedOnSteam={isOwnedOnSteam}
              hasAntiCheat={Boolean(metadata?.drmNotice?.toLowerCase().includes('anti-cheat'))}
              antiCheatName={
                metadata?.drmNotice?.includes('Easy') ? 'Easy Anti-Cheat' : 'Anti-Cheat Software'
              }
              hasEula={Boolean(
                metadata?.drmNotice?.toLowerCase().includes('eula') ||
                  metadata?.legalNotice?.toLowerCase().includes('eula')
              )}
              onApplyFilter={onApplyFilter}
            />

            {/* Exact 1:1 Languages Matrix Table */}
            <div className="cv-store-section">
              <SteamLanguagesTable
                rawSupportedLanguagesHtml={metadata?.supportedLanguages}
                languageOptions={metadata?.languageOptions}
                languageTableSchema={metadata?.languageTableSchema}
              />
            </div>

            {/* Controller Support, Deck Verified, Anti-Cheat, EULA, and Details */}
            <div className="cv-store-section">
              <SteamSidebarNotices
                title={game.title}
                steamAppId={currentSteamAppId || game.steamAppId}
                website={metadata?.website}
                deckCompatibility={metadata?.deckCompatibility}
                genres={genres}
                developers={developers}
                publishers={publishers}
                releaseDate={releaseDate}
                legalNotice={metadata?.legalNotice}
                onApplyFilter={onApplyFilter}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
