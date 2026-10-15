import React, { useEffect, useState, useRef, useMemo } from 'react';
import DOMPurify from 'dompurify';
import { CanonicalGame } from '../../contracts/game';
import { SteamEnrichedMetadata } from '../../contracts/steam';
import { StorefrontId } from '../../contracts/platform';
import { getStorefrontDisplayName } from '../Common/StorefrontIcon';
import { steamApi } from '../../services/steam/steamApi';
import { steamMatcher } from '../../services/steam/steamMatcher';
import { fallbackMetadataProvider } from '../../services/steam/fallbackMetadataProvider';
import { loadCurrentCatalog, saveCurrentCatalog, loadIntegrations } from '../../services/integrations/integrationStorage';
import { MediaGallery } from './MediaGallery';
import { SteamHeroDetails } from './SteamHeroDetails';
import { SteamLibraryActionBar } from './SteamLibraryActionBar';
import { HowLongToBeatCard } from './HowLongToBeatCard';
import { getOpenCriticData } from '../../services/opencritic/openCritic';
import { OpenCriticCard } from './OpenCriticCard';
import { SystemRequirements } from './SystemRequirements';
import { PlatformBadges } from './PlatformBadges';
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
} from 'lucide-react';
import { ActiveGameFilter } from '../../contracts/filter';
import { GameCollection } from '../../contracts/collection';

interface SteamStorePageProps {
  game: CanonicalGame;
  collections?: GameCollection[];
  onBackToLibrary?: () => void;
  onManageCollections?: () => void;
  onToggleInstallStatus?: () => void;
  onApplyFilter?: (filter: ActiveGameFilter) => void;
  onGameUpdated?: (updated: CanonicalGame) => void;
  connectedStorefronts?: StorefrontId[];
  onOpenIntegrations?: () => void;
  onFixMatch?: () => void;
  onViewAchievements?: (storefrontId?: StorefrontId) => void;
}

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
  onViewAchievements,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [currentGame, setCurrentGame] = useState<CanonicalGame>(game);
  const [metadata, setMetadata] = useState<SteamEnrichedMetadata | null>(
    game.enrichedMetadata || null
  );
  const [currentSteamAppId, setCurrentSteamAppId] = useState<number | undefined>(game.steamAppId);
  const [isLoading, setIsLoading] = useState(!game.enrichedMetadata);
  const isCooldown = steamApi.isStoreRateLimited();
  const activeGameIdRef = useRef<string>(game.id);

  const userOverride = useMemo(() => getUserOverrideForGame(game), [game]);
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
    return new Set<StorefrontId>(['steam', 'gog', 'epic']);
  }, [connectedStorefronts]);

  const disconnectedPlatforms = currentGame.platforms.filter(
    (p) => !connectedSet.has(p.platformId as StorefrontId)
  );

  useEffect(() => {
    setCurrentGame(game);
  }, [game]);

  useEffect(() => {
    let isMounted = true;
    const isNewGame = activeGameIdRef.current !== game.id;
    const isOverrideUpdated = activeOverrideStampRef.current !== userOverride?.updatedAt;
    activeGameIdRef.current = game.id;
    activeOverrideStampRef.current = userOverride?.updatedAt;

    if (isNewGame || isOverrideUpdated) {
      setMetadata(game.enrichedMetadata || null);
      setCurrentSteamAppId(game.steamAppId);
      if (!game.enrichedMetadata) {
        setIsLoading(true);
      }
    }

    async function loadData() {
      const currentOverride = getUserOverrideForGame(game);
      const route = inferMetadataRouteFromOverride(currentOverride);
      const isRoutedToNonSteamStore =
        route?.source === 'gog' || route?.source === 'epic';

      let targetAppId =
        route?.source === 'steam' && route.steamAppId
          ? route.steamAppId
          : game.steamAppId;

      // If user explicitly unlinked from Steam (steamAppId === null) or routed metadata to a non-Steam source
      const isExplicitNonSteam =
        currentOverride?.steamAppId === null ||
        currentOverride?.isExplicitNonSteam === true ||
        isRoutedToNonSteamStore ||
        route?.source === 'igdb';

      // If no Steam App ID is set, intelligently search Steam Store for match
      if (!targetAppId && !isExplicitNonSteam) {
        try {
          const matched = await steamMatcher.matchGameToSteam(game.title);
          if (matched && isMounted) {
            targetAppId = matched;
            setCurrentSteamAppId(matched);

            // Persist the matched Steam App ID to the catalog
            try {
              const catalog = loadCurrentCatalog();
              const idx = catalog.findIndex(
                (g) => g.id === game.id || g.title.toLowerCase().trim() === game.title.toLowerCase().trim()
              );
              if (idx >= 0 && !catalog[idx].steamAppId) {
                catalog[idx].steamAppId = matched;
                saveCurrentCatalog(catalog);
              }
            } catch {
              // Ignore storage errors
            }
          }
        } catch (e) {
          console.warn('Steam matching failed:', e);
        }
      }

      // Case A: User explicitly routed Step 4 metadata to GOG or Epic
      if (isRoutedToNonSteamStore) {
        const [fallbackData, liveAchs] = await Promise.all([
          fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(game, currentOverride),
          game.steamAppId
            ? steamAchievementsService.fetchPlayerGameAchievements(game.steamAppId)
            : Promise.resolve(null),
        ]);

        if (isMounted && fallbackData) {
          setMetadata(fallbackData);
          let updatedPlatforms = game.platforms;
          let hasChanges = !game.enrichedMetadata || isOverrideUpdated;

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
              enrichedMetadata: fallbackData,
            };
            setCurrentGame(updatedGame);
            onGameUpdated?.(updatedGame);
          }
        }
      } else if (targetAppId) {
        // Case B: Matched or routed to Steam
        const [liveData, liveAchs] = await Promise.all([
          steamApi.fetchGameMetadata(targetAppId),
          steamAchievementsService.fetchPlayerGameAchievements(targetAppId),
        ]);

        if (isMounted) {
          let resolvedMetadata: SteamEnrichedMetadata | null = null;
          if (liveData) {
            resolvedMetadata = liveData;
            setMetadata(liveData);
            if (currentOverride && route?.mode === 'routed' && route.source === 'steam') {
              updateRoutedMetadataSnapshot(game.id, {
                title: liveData.name,
                shortDescription: liveData.shortDescription,
                detailedDescription: liveData.detailedDescription || liveData.aboutTheGame,
                headerImage: liveData.headerImage,
                developers: liveData.developers,
                publishers: liveData.publishers,
                genres: liveData.genres,
                tags: liveData.tags,
                releaseDate: liveData.releaseDate,
              });
            }
          } else {
            const fallbackData = await fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(
              game,
              currentOverride
            );
            if (isMounted) {
              resolvedMetadata = fallbackData;
              setMetadata(fallbackData);
            }
          }

          let hasChanges = false;
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

          if (resolvedMetadata && (!game.enrichedMetadata || isOverrideUpdated)) {
            hasChanges = true;
          }

          if (hasChanges && isMounted) {
            const updatedGame: CanonicalGame = {
              ...game,
              platforms: updatedPlatforms,
              steamAppId: targetAppId,
              enrichedMetadata: resolvedMetadata || game.enrichedMetadata,
            };
            setCurrentGame(updatedGame);
            onGameUpdated?.(updatedGame);
          }
        }
      } else {
        // Case C: Non-Steam game (e.g. GOG, Epic, IGDB exclusive)
        const fallbackData = await fallbackMetadataProvider.getEnrichedMetadataForNonSteamGame(
          game,
          currentOverride
        );
        if (isMounted && fallbackData) {
          setMetadata(fallbackData);
          if (!game.enrichedMetadata || isOverrideUpdated) {
            const updatedGame: CanonicalGame = {
              ...game,
              enrichedMetadata: fallbackData,
            };
            setCurrentGame(updatedGame);
            onGameUpdated?.(updatedGame);
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
  ]);

  const isDynamicRouted =
    Boolean(userOverride) &&
    metadataRoute?.mode === 'routed' &&
    (metadataRoute.source === 'steam' ||
      metadataRoute.source === 'gog' ||
      metadataRoute.source === 'epic');

  const screenshots = metadata?.screenshots || [];
  const movies = metadata?.movies || [];
  const reviewSummary = metadata?.reviewSummary || game.reviewSummary;
  const effectiveHeaderImage =
    (isDynamicRouted
      ? metadata?.headerImage || userOverride?.headerImage
      : userOverride?.headerImage || metadata?.headerImage) || game.headerImage;

  const shortDescription =
    isDynamicRouted && !metadataRoute?.customSynopsisEdited
      ? metadata?.shortDescription || userOverride?.shortDescription || game.shortDescription
      : userOverride?.shortDescription || metadata?.shortDescription || game.shortDescription;

  const developers = isDynamicRouted
    ? metadata?.developers?.length
      ? metadata.developers
      : userOverride?.developers?.length
      ? userOverride.developers
      : game.developers || []
    : userOverride?.developers?.length
    ? userOverride.developers
    : metadata?.developers?.length
    ? metadata.developers
    : game.developers || [];

  const publishers = isDynamicRouted
    ? metadata?.publishers?.length
      ? metadata.publishers
      : userOverride?.publishers?.length
      ? userOverride.publishers
      : game.publishers || []
    : userOverride?.publishers?.length
    ? userOverride.publishers
    : metadata?.publishers?.length
    ? metadata.publishers
    : game.publishers || [];

  const releaseDate = isDynamicRouted
    ? (metadata?.releaseDate && metadata.releaseDate !== 'TBA' ? metadata.releaseDate : undefined) ||
      userOverride?.releaseDate ||
      game.releaseDate ||
      'TBA'
    : userOverride?.releaseDate || metadata?.releaseDate || game.releaseDate || 'TBA';

  const tags = isDynamicRouted
    ? metadata?.tags?.length
      ? metadata.tags
      : userOverride?.tags?.length
      ? userOverride.tags
      : game.tags || []
    : userOverride?.tags?.length
    ? userOverride.tags
    : metadata?.tags?.length
    ? metadata.tags
    : game.tags || [];

  const genres = isDynamicRouted
    ? metadata?.genres?.length
      ? metadata.genres
      : userOverride?.genres?.length
      ? userOverride.genres
      : game.genres || []
    : userOverride?.genres?.length
    ? userOverride.genres
    : metadata?.genres?.length
    ? metadata.genres
    : game.genres || [];

  const isOwnedOnSteam = isGameOwnedOnSteam(game.platforms);
  const effectiveTags = getEffectiveTags(tags, isOwnedOnSteam);

  const detailedDescription = isDynamicRouted
    ? metadata?.aboutTheGame ||
      metadata?.detailedDescription ||
      userOverride?.detailedDescription ||
      game.enrichedMetadata?.aboutTheGame ||
      game.enrichedMetadata?.detailedDescription
    : userOverride?.detailedDescription ||
      metadata?.aboutTheGame ||
      metadata?.detailedDescription ||
      game.enrichedMetadata?.aboutTheGame ||
      game.enrichedMetadata?.detailedDescription;

  const effectiveSteamId = steamMatcher.getEffectiveSteamAppId(game);

  const [openCriticData, setOpenCriticData] = useState<any>(() =>
    getOpenCriticData(effectiveSteamId || undefined, game.title, reviewSummary?.positivePercent)
  );

  useEffect(() => {
    setOpenCriticData(getOpenCriticData(effectiveSteamId || undefined, game.title, reviewSummary?.positivePercent));

    const handleCriticUpdate = (e: any) => {
      const detail = e.detail;
      if (
        detail &&
        (detail.title?.toLowerCase() === game.title.toLowerCase() ||
          (detail.steamAppId && (detail.steamAppId === game.steamAppId || detail.steamAppId === effectiveSteamId)))
      ) {
        setOpenCriticData(detail.data);
      }
    };

    window.addEventListener('antigravity_critic_updated', handleCriticUpdate);
    return () => window.removeEventListener('antigravity_critic_updated', handleCriticUpdate);
  }, [game.steamAppId, game.title, reviewSummary?.positivePercent, effectiveSteamId]);

  return (
    <div ref={containerRef} className="w-full min-h-full bg-[#0e141b] text-steam-text pb-24 relative">
      {/* Background Hero Ambient Glow */}
      <div
        className="absolute top-0 left-0 right-0 h-96 opacity-15 pointer-events-none bg-cover bg-center filter blur-3xl"
        style={{
          backgroundImage: `url(${effectiveHeaderImage})`,
        }}
      />

      <div className="relative max-w-6xl mx-auto px-4 md:px-8 pt-6 space-y-6">
        {/* Navigation Breadcrumb */}
        <div className="flex items-center justify-between border-b border-steam-border/40 pb-4">
          <div className="flex items-center gap-2 text-xs text-steam-subtext">
            <button
              onClick={onBackToLibrary}
              className="inline-flex items-center gap-1.5 text-steam-accent hover:text-white hover:underline cursor-pointer uppercase tracking-wider text-[11px] font-bold transition-colors group"
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
            <div className="flex items-center gap-2">
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
          onViewAchievements={onViewAchievements}
        />

        {/* Main Steam Highlight Showcase (1:1 Steam 2-Column Split: Media Player + Details) */}
        <div className="flex flex-col lg:flex-row gap-4 bg-[#16202d]/80 backdrop-blur rounded border border-steam-border p-4 shadow-xl">
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
              />
            )}
          </div>

          {/* Right Column: 1:1 Steam Details (Fixed 324px Width) */}
          <SteamHeroDetails
            headerImage={effectiveHeaderImage}
            title={game.title}
            shortDescription={shortDescription}
            reviewSummary={reviewSummary}
            openCritic={openCriticData}
            releaseDate={releaseDate}
            developers={developers}
            publishers={publishers}
            tags={effectiveTags}
            onApplyFilter={onApplyFilter}
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
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 pt-4">
          {/* Main Column: "About This Game" */}
          <div className="lg:col-span-8 space-y-6">
            <div className="bg-[#16202d] rounded border border-steam-border p-6 shadow-md">
              <h2 className="text-sm font-bold tracking-wider text-steam-accent uppercase border-b border-steam-border/60 pb-3 mb-4 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-steam-accent" />
                About This Game
              </h2>

              {detailedDescription ? (
                <div
                  className="steam-description-content text-sm space-y-3 leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(detailedDescription) }}
                />
              ) : shortDescription ? (
                <div className="steam-description-content text-sm space-y-3 leading-relaxed text-[#acb2b8]">
                  <p className="bb_paragraph">{shortDescription}</p>
                </div>
              ) : (
                <div className="text-sm text-steam-subtext italic">
                  Standard Steam catalog title. Full store page overview will synchronize automatically once the CDN cooldown resets.
                </div>
              )}
            </div>

            {/* System Requirements Section */}
            <SystemRequirements requirements={metadata?.systemRequirements} />
          </div>

          {/* Right Sidebar Details (1:1 Steam Right Column) */}
          <div className="lg:col-span-4 space-y-4">
            <SteamFeaturesList
              categories={metadata?.categories}
              title={game.title}
              isOwnedOnSteam={isOwnedOnSteam}
              hasAntiCheat={Boolean(metadata?.drmNotice?.toLowerCase().includes('anti-cheat'))}
              antiCheatName={metadata?.drmNotice?.includes('Easy') ? 'Easy Anti-Cheat' : 'Anti-Cheat Software'}
              hasEula={Boolean(metadata?.drmNotice?.toLowerCase().includes('eula') || metadata?.legalNotice?.toLowerCase().includes('eula'))}
              onApplyFilter={onApplyFilter}
            />

            {/* Exact 1:1 Languages Matrix Table */}
            <SteamLanguagesTable rawSupportedLanguagesHtml={metadata?.supportedLanguages} />

            {/* Controller Support, Deck Verified, Anti-Cheat, EULA, and Details */}
            <SteamSidebarNotices
              title={game.title}
              steamAppId={game.steamAppId}
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
  );
};
