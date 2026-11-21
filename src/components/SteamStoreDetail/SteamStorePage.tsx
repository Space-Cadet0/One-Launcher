import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { SteamEnrichedMetadata } from '../../contracts/steam';
import { StorefrontId } from '../../contracts/platform';
import { toOlMediaUrl } from '../../contracts/network';
import { getStorefrontDisplayName } from '../Common/StorefrontIcon';
import { steamApi } from '../../services/steam/steamApi';
import { steamMatcher } from '../../services/steam/steamMatcher';
import { isGenericPlaceholderSynopsis } from '../../services/steam/fallbackMetadataProvider';
import { loadIntegrations } from '../../services/integrations/integrationStorage';
import { onlineLifecycleManager } from '../../services/network/onlineLifecycleManager';
import { isModalOverlayOpen } from '../../utils/modalOverlayLock';
import { MediaGallery, prefersReducedMotion } from './MediaGallery';
import { SteamHeroDetails } from './SteamHeroDetails';
import { SteamLibraryActionBar } from './SteamLibraryActionBar';
import { HowLongToBeatCard } from './HowLongToBeatCard';
import { OpenCriticCard } from './OpenCriticCard';
import { SystemRequirements } from './SystemRequirements';
import { PlatformBadges } from './PlatformBadges';
import { NativeOsBadges } from '../Common/NativeOsBadges';
import {
  getNativeOsPlatforms,
  getStorefrontNativeOsPlatforms,
} from '../../services/platform/nativeOsService';
import { SteamLanguagesTable } from './SteamLanguagesTable';
import { SteamFeaturesList } from './SteamFeaturesList';
import { SteamSidebarNotices } from './SteamSidebarNotices';
import { isGameOwnedOnSteam } from '../../services/steam/steamFeatureNormalizer';
import {
  getUserOverrideForGame,
  inferMetadataRouteFromOverride,
} from '../../services/storage/userOverrideStorage';
import {
  USER_TAG_OVERRIDES_UPDATED_EVENT,
  addUserTagForGame,
  removeUserTagForGame,
  resetUserTagsForGame,
} from '../../services/storage/userTagStorage';
import { resolveEffectiveGameTags } from '../../services/tags/gameTagResolver';
import type { TagFacetCount } from '../../contracts/tags';
import { Sparkles, AlertCircle, Activity, CheckCircle2 } from 'lucide-react';
import { ActiveGameFilter } from '../../contracts/filter';
import { GameCollection } from '../../contracts/collection';
import { launcherService } from '../../services/launcher/launcherService';
import {
  EMPTY_MOVIES,
  EMPTY_SCREENSHOTS,
  EMPTY_STRINGS,
  RICH_HTML_DESC_RE,
  isMicrosoftStoreAssetUrl,
  isSentinelReleaseDate,
  isSkeletonMetadata,
  resolveInitialDetailPlatformId,
  shouldAcceptCriticUpdateEvent,
} from './StorePage/steamDetailUtils';
import { AboutThisGameHtml } from './StorePage/AboutThisGameHtml';
import { StoreDetailBreadcrumb } from './StorePage/StoreDetailBreadcrumb';
import { useGameDetailMetadata } from './StorePage/useGameDetailMetadata';
import { useGameDetailCritic, useVaultCriticAdoption } from './StorePage/useGameDetailCritic';

export { shouldAcceptCriticUpdateEvent };

const MemoMediaGallery = React.memo(MediaGallery);
const MemoSteamLanguagesTable = React.memo(SteamLanguagesTable);

export interface SteamStorePageProps {
  game: CanonicalGame;
  collections?: GameCollection[];
  availableLibraryTags?: TagFacetCount[];
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

export const SteamStorePage: React.FC<SteamStorePageProps> = ({
  game,
  collections,
  availableLibraryTags,
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
  const [activePlatformId, setActivePlatformId] = useState<StorefrontId>(() =>
    resolveInitialDetailPlatformId(game)
  );
  const [, setLauncherTick] = useState(0);
  const [overrideTick, setOverrideTick] = useState(0);
  const [tagOverridesTick, setTagOverridesTick] = useState(0);

  const isCooldown = steamApi.isStoreRateLimited();

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return undefined;
    }
    const handleOverrideEvent = () => setOverrideTick((t) => t + 1);
    const handleTagOverrideEvent = () => setTagOverridesTick((t) => t + 1);
    window.addEventListener('antigravity:user-override-updated', handleOverrideEvent);
    window.addEventListener('antigravity:user-override-removed', handleOverrideEvent);
    window.addEventListener(USER_TAG_OVERRIDES_UPDATED_EVENT, handleTagOverrideEvent);
    return () => {
      window.removeEventListener('antigravity:user-override-updated', handleOverrideEvent);
      window.removeEventListener('antigravity:user-override-removed', handleOverrideEvent);
      window.removeEventListener(USER_TAG_OVERRIDES_UPDATED_EVENT, handleTagOverrideEvent);
    };
  }, []);

  const userOverride = useMemo(() => getUserOverrideForGame(game), [game, overrideTick]);
  const metadataRoute = useMemo(
    () => inferMetadataRouteFromOverride(userOverride),
    [userOverride]
  );

  const activeStoreSupportsMacRef = useRef(false);
  const vaultCritic = useVaultCriticAdoption(game.id);

  const {
    currentGame,
    metadata,
    vaultHltb,
    currentSteamAppId,
    isLoading,
    isOnline,
    onlineGeneration,
  } = useGameDetailMetadata({
    game,
    userOverride,
    metadataRoute,
    activeStoreSupportsMacRef,
    onGameUpdated,
    vaultCritic,
  });

  useEffect(() => {
    setActivePlatformId(resolveInitialDetailPlatformId(game));
  }, [game.id]);

  useEffect(() => {
    if (
      Array.isArray(currentGame.platforms) &&
      currentGame.platforms.length > 0 &&
      !currentGame.platforms.some((p) => p.platformId === activePlatformId)
    ) {
      setActivePlatformId(resolveInitialDetailPlatformId(currentGame));
    }
  }, [currentGame, activePlatformId]);

  const activeStoreNativePlatforms = useMemo(
    () =>
      Array.isArray(currentGame.platforms) && currentGame.platforms.length > 0
        ? getStorefrontNativeOsPlatforms(currentGame, activePlatformId)
        : getNativeOsPlatforms(currentGame),
    [currentGame, activePlatformId]
  );
  const activePlatformEntry = useMemo(
    () => currentGame.platforms?.find((p) => p.platformId === activePlatformId),
    [currentGame.platforms, activePlatformId]
  );
  const activeStoreSupportsMac =
    activeStoreNativePlatforms.includes('mac') ||
    (activePlatformId === 'steam' && metadata?.platforms?.mac === true);
  activeStoreSupportsMacRef.current = activeStoreSupportsMac;

  const activeStoreSupportsLinux = useMemo(() => {
    if (activePlatformId === 'xbox') return false;
    if (typeof activePlatformEntry?.platforms?.linux === 'boolean') {
      return activePlatformEntry.platforms.linux;
    }
    const hasLinuxReq = Boolean(
      metadata?.linuxRequirements?.minimum?.trim() ||
        metadata?.linuxRequirements?.recommended?.trim()
    );
    if (activePlatformId === 'steam') {
      return metadata?.platforms?.linux === true || hasLinuxReq;
    }
    if (activePlatformId === 'gog' || activePlatformId === 'epic') {
      const metadataMatchesActiveStore =
        metadata?.enrichedSource === activePlatformId ||
        (activePlatformId === 'gog' && Boolean(currentGame.worksOn?.linux));
      return Boolean(
        metadataMatchesActiveStore && (metadata?.platforms?.linux === true || hasLinuxReq)
      );
    }
    return false;
  }, [
    activePlatformId,
    activePlatformEntry?.platforms?.linux,
    currentGame.worksOn?.linux,
    metadata?.enrichedSource,
    metadata?.platforms?.linux,
    metadata?.linuxRequirements?.minimum,
    metadata?.linuxRequirements?.recommended,
  ]);

  // Only re-render page header status on session/install/storefront transitions (NOT 1Hz download progress ticks!)
  useEffect(() => {
    const computePageLauncherSig = () => {
      const sess = launcherService.getActiveSession(game.id);
      const dl = launcherService.getActiveDownload(game.id);
      const selPlat = launcherService.getSelectedStorefrontForGame(game.id) || '';
      const rec = launcherService.getInstalledRecordForGame(game);
      return `${sess?.sessionId || ''}:${sess?.status || ''}|${dl?.taskId || ''}:${dl?.status || ''}|${selPlat}|${rec?.platformId || ''}:${rec?.installPath || ''}:${rec?.executablePath || ''}`;
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

  const connectedSet = useMemo(() => {
    if (connectedStorefronts !== undefined) {
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

  // Hoisted module-level empty arrays preserve reference stability across re-renders (fixes live carousel reset!)
  const screenshots = metadata?.screenshots ?? EMPTY_SCREENSHOTS;
  const movies = metadata?.movies ?? EMPTY_MOVIES;
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
      : currentGame.developers || game.developers || EMPTY_STRINGS
    : userOverride?.developers?.length
    ? userOverride.developers
    : metadata?.developers?.length
    ? metadata.developers
    : currentGame.developers || game.developers || EMPTY_STRINGS;

  const publishers = isDynamicRouted
    ? metadata?.publishers?.length
      ? metadata.publishers
      : userOverride?.publishers?.length
      ? userOverride.publishers
      : currentGame.publishers || game.publishers || EMPTY_STRINGS
    : userOverride?.publishers?.length
    ? userOverride.publishers
    : metadata?.publishers?.length
    ? metadata.publishers
    : currentGame.publishers || game.publishers || EMPTY_STRINGS;

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

  const genres = isDynamicRouted
    ? metadata?.genres?.length
      ? metadata.genres
      : userOverride?.genres?.length
      ? userOverride.genres
      : currentGame.genres || game.genres || EMPTY_STRINGS
    : userOverride?.genres?.length
    ? userOverride.genres
    : metadata?.genres?.length
    ? metadata.genres
    : currentGame.genres || game.genres || EMPTY_STRINGS;

  const isOwnedOnSteam = isGameOwnedOnSteam(currentGame.platforms || game.platforms);

  const resolvedTagsResult = useMemo(
    () =>
      resolveEffectiveGameTags(currentGame, {
        liveMetadata: metadata,
        fixMatchOverride: userOverride,
        isDynamicRouted,
      }),
    [currentGame, metadata, userOverride, isDynamicRouted, tagOverridesTick]
  );
  const effectiveTags = resolvedTagsResult.tags;

  const handleAddTag = useCallback(
    (tag: string) => {
      addUserTagForGame(currentGame, tag, resolvedTagsResult.syncedTags);
      setTagOverridesTick((t) => t + 1);
    },
    [currentGame, resolvedTagsResult.syncedTags]
  );

  const handleRemoveTag = useCallback(
    (tag: string) => {
      removeUserTagForGame(currentGame, tag, resolvedTagsResult.syncedTags);
      setTagOverridesTick((t) => t + 1);
    },
    [currentGame, resolvedTagsResult.syncedTags]
  );

  const handleResetTags = useCallback(() => {
    resetUserTagsForGame(currentGame);
    setTagOverridesTick((t) => t + 1);
  }, [currentGame]);

  const handleSelectNativeOs = useCallback(
    (os: 'mac' | 'windows' | 'linux') => {
      onApplyFilter?.({
        type: 'os',
        label: 'Native OS',
        value: os === 'mac' ? 'macOS' : os === 'linux' ? 'Linux' : 'Windows',
      });
    },
    [onApplyFilter]
  );

  const pickRichDetailed = (m?: SteamEnrichedMetadata | null): string | undefined => {
    if (!m || isSkeletonMetadata(m)) return undefined;
    if (RICH_HTML_DESC_RE.test(m.aboutTheGame || '')) return m.aboutTheGame;
    if (RICH_HTML_DESC_RE.test(m.detailedDescription || '')) return m.detailedDescription;
    return m.aboutTheGame || m.detailedDescription;
  };
  const gameRichDetailed = RICH_HTML_DESC_RE.test(
    currentGame.enrichedMetadata?.aboutTheGame || ''
  )
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

  const activeReviewGame = useMemo<CanonicalGame>(() => {
    const base = currentGame.id === game.id ? currentGame : game;
    if (
      currentSteamAppId &&
      currentSteamAppId !== base.steamAppId &&
      currentGame.id === game.id
    ) {
      return { ...base, steamAppId: currentSteamAppId };
    }
    return base;
  }, [currentGame, game, currentSteamAppId]);

  const openCriticData = useGameDetailCritic({
    game,
    activeReviewGame,
    currentSteamAppId,
    effectiveSteamId,
    resolvedSteamAppId,
    metadata,
    reviewSummary,
    userOverride,
    overrideTick,
    vaultCritic,
  });

  const syncInlineVideoPlayback = useCallback(() => {
    const root = containerRef.current;
    if (!root || typeof root.querySelectorAll !== 'function') return;
    const shouldHibernateMedia =
      !onlineLifecycleManager.isOnline() ||
      prefersReducedMotion() ||
      isModalOverlayOpen() ||
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
  }, []);

  const syncInlineVideoPlaybackRef = useRef(syncInlineVideoPlayback);
  syncInlineVideoPlaybackRef.current = syncInlineVideoPlayback;

  useEffect(() => {
    const runSync = () => syncInlineVideoPlaybackRef.current();
    runSync();
    const unsubLauncher = launcherService.subscribe(runSync);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('antigravity:modal-overlay-changed', runSync);
      window.addEventListener('antigravity:hibernate-state-changed', runSync);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', runSync);
    }
    return () => {
      unsubLauncher();
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('antigravity:modal-overlay-changed', runSync);
        window.removeEventListener('antigravity:hibernate-state-changed', runSync);
      }
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', runSync);
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
        <StoreDetailBreadcrumb title={game.title} onBackToLibrary={onBackToLibrary} />

        {/* Akamai Edge Cooldown Notice */}
        {isCooldown && (
          <div className="bg-[#1b2838]/90 border border-[#2a475e] text-xs text-steam-subtext rounded px-3.5 py-2.5 flex items-center justify-between shadow-sm">
            <span>
              <strong className="text-steam-accent">Local Library Mode:</strong> Live store web
              requests paused while Akamai CDN edge cooldown clears. Showing official local assets
              &amp; artwork.
            </span>
            <span className="text-[11px] text-[#acb2b8] font-mono">Auto-resumes in ~15m</span>
          </div>
        )}

        {/* Storefront Not Connected Notice Banner */}
        {disconnectedPlatforms.length > 0 && (
          <div className="bg-amber-950/40 border border-amber-500/50 text-xs text-amber-200 rounded px-3.5 py-2.5 flex items-center justify-between gap-3 shadow-sm">
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
              <span>
                <strong className="text-amber-300">
                  {disconnectedPlatforms
                    .map((p) => getStorefrontDisplayName(p.platformId))
                    .join(', ')}{' '}
                  (Not Connected):
                </strong>{' '}
                This title is cataloged in your baseline library. Live purchase sync &amp; cloud
                trophies will resume when reconnected.
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
                      <Activity
                        className="w-3.5 h-3.5 text-emerald-400 animate-pulse shrink-0"
                        aria-hidden="true"
                      />
                      <span>Active Session</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-950/40 border border-emerald-500/30 text-xs font-semibold text-emerald-400">
                      <CheckCircle2
                        className="w-3.5 h-3.5 text-emerald-400 shrink-0"
                        aria-hidden="true"
                      />
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
              {activeStoreNativePlatforms.length > 0 && (
                <div className="inline-flex items-center gap-1.5 ml-2 pl-2.5 border-l border-white/15">
                  <span className="text-xs uppercase tracking-wider text-steam-subtext font-semibold">
                    Native OS:
                  </span>
                  <NativeOsBadges
                    platforms={activeStoreNativePlatforms}
                    variant="detail-pill"
                    onSelectOs={handleSelectNativeOs}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Steam Library Action & Stats Bar */}
        <SteamLibraryActionBar
          game={currentGame}
          metadata={metadata}
          openCriticData={openCriticData}
          collections={collections}
          onManageCollections={onManageCollections}
          onToggleInstallStatus={onToggleInstallStatus}
          onApplyFilter={onApplyFilter}
          connectedStorefronts={connectedStorefronts}
          onFixMatch={onFixMatch}
          onHideGame={onHideGame}
          onViewAchievements={onViewAchievements}
          onSelectedPlatformChange={setActivePlatformId}
        />

        {/* Main Steam Highlight Showcase (1:1 Steam 2-Column Split: Media Player + Details) */}
        <div className="flex flex-col lg:flex-row gap-4 bg-[#16202d]/95 rounded border border-steam-border p-4 shadow-xl">
          {/* Left Column: Media Gallery (Trailers + Screenshots) */}
          <div className="flex-1 min-w-0 lg:max-w-[616px]">
            {isLoading ? (
              <div className="aspect-video w-full bg-black/60 rounded flex flex-col items-center justify-center gap-3 animate-pulse border border-steam-border">
                <Sparkles className="w-8 h-8 text-steam-accent animate-spin" aria-hidden="true" />
                <span className="text-xs text-steam-accent">Loading Steam Media...</span>
              </div>
            ) : (
              <MemoMediaGallery
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
            tagEntries={resolvedTagsResult.entries}
            availableLibraryTags={availableLibraryTags}
            hasUserTagEdits={resolvedTagsResult.hasUserEdits}
            onAddTag={handleAddTag}
            onRemoveTag={handleRemoveTag}
            onResetTags={handleResetTags}
            platforms={currentGame.platforms}
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
          gameId={game.id}
          gameTitle={game.title}
          appId={currentSteamAppId || game.steamAppId}
          genres={game.genres}
          tags={game.tags}
          hltb={vaultHltb ?? undefined}
        />

        {/* Critic Consensus Dashboard (OpenCritic / Metacritic) */}
        <OpenCriticCard gameTitle={game.title} openCritic={openCriticData} />

        {/* Content Section: Description & Technical Specs */}
        <div className="cv-section grid grid-cols-1 lg:grid-cols-12 gap-8 pt-4">
          {/* Main Column: "About This Game" */}
          <div className="lg:col-span-8 space-y-6">
            <div className="cv-store-section bg-[#16202d] rounded border border-steam-border p-6 shadow-md">
              <h2 className="text-sm font-bold tracking-wider text-steam-accent uppercase border-b border-steam-border/60 pb-3 mb-4">
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
                macRequirements={activeStoreSupportsMac ? metadata?.macRequirements : undefined}
                linuxRequirements={
                  activeStoreSupportsLinux ? metadata?.linuxRequirements : undefined
                }
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
              hasAntiCheat={Boolean(
                currentGame.requiresKernelAntiCheat ||
                  metadata?.drmNotice?.toLowerCase().includes('anti-cheat') ||
                  metadata?.drmNotice?.toLowerCase().includes('anticheat')
              )}
              antiCheatName={
                currentGame.antiCheatName ||
                (metadata?.drmNotice?.includes('Javelin')
                  ? 'EA Javelin Anticheat'
                  : metadata?.drmNotice?.includes('Easy')
                  ? 'Easy Anti-Cheat'
                  : 'Anti-Cheat Software')
              }
              hasEula={Boolean(
                metadata?.drmNotice?.toLowerCase().includes('eula') ||
                  metadata?.legalNotice?.toLowerCase().includes('eula')
              )}
              onApplyFilter={onApplyFilter}
            />

            {/* Exact 1:1 Languages Matrix Table */}
            <div className="cv-store-section">
              <MemoSteamLanguagesTable
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
                game={currentGame}
                platforms={currentGame.platforms}
                activePlatformId={activePlatformId}
                drmNotice={metadata?.drmNotice}
                extUserAccountNotice={
                  (metadata as { extUserAccountNotice?: string } | undefined)?.extUserAccountNotice
                }
                onApplyFilter={onApplyFilter}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
