import React, { useState, useRef, useEffect, useCallback } from 'react';
import type Hls from 'hls.js';
import { SteamScreenshot, SteamMovie } from '../../contracts/steam';
import { toOlMediaUrl } from '../../contracts/network';
import { onlineLifecycleManager } from '../../services/network/onlineLifecycleManager';
import { isModalOverlayOpen } from '../../utils/modalOverlayLock';
import { isNonEnglishRegionalMovieName } from '../../services/steam/steamApi';
import {
  Play,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Image as ImageIcon,
  ExternalLink,
} from 'lucide-react';
import {
  MediaItem,
  normalizeMediaUrl,
  extractYouTubeId,
  setBoundedFlag,
  addBoundedSetEntry,
  prefersReducedMotion,
  isTrustedEmbedHost,
  loadHlsModule,
  shouldSuspendMediaPlayback,
} from './MediaGallery/mediaGalleryUtils';
import { GalleryLightboxModal } from './MediaGallery/GalleryLightboxModal';

export { prefersReducedMotion };

interface MediaGalleryProps {
  screenshots: SteamScreenshot[];
  movies: SteamMovie[];
  headerImage?: string;
  title?: string;
  autoplay?: boolean;
  gameId?: string | null;
  steamAppId?: number | string | null;
  gogId?: string | null;
  epicAppName?: string | null;
  xboxProductId?: string | null;
  packageFamilyName?: string | null;
  xboxTitleId?: string | null;
}

const MAX_HLS_MEDIA_ERROR_RECOVERIES = 2;

const VideoPlayer: React.FC<{ movie: SteamMovie; autoplay?: boolean }> = ({
  movie,
  autoplay = false,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const wasSuspendedRef = useRef<boolean>(shouldSuspendMediaPlayback());
  const pausedForModalRef = useRef<boolean>(false);
  const userInitiatedPlayRef = useRef<boolean>(false);
  const [hasRequestedPlay, setHasRequestedPlay] = useState<boolean>(
    () => Boolean(autoplay) && !prefersReducedMotion()
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [isError, setIsError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [posterFailed, setPosterFailed] = useState(false);
  const [isSuspendedInGame, setIsSuspendedInGame] = useState<boolean>(() =>
    shouldSuspendMediaPlayback()
  );

  // Check if it's an iframe embed (YouTube/Wistia/Vimeo from GOG or fallback providers)
  const candidateUrl = normalizeMediaUrl(
    movie.mp4?.max ||
      movie.mp4?.['480'] ||
      movie.webm?.max ||
      movie.webm?.['480'] ||
      ''
  );
  const ytId = extractYouTubeId(candidateUrl);
  const isEmbed = Boolean(ytId) || isTrustedEmbedHost(candidateUrl);

  // Determine stream URLs
  const extendedMovie = movie as SteamMovie & { hls_h264?: string };
  const hlsUrl = normalizeMediaUrl(movie.hls || extendedMovie.hls_h264 || '');
  const rawMp4Max = normalizeMediaUrl(movie.mp4?.max);
  const mp4MaxUrl =
    rawMp4Max && !rawMp4Max.includes('.mpd') && !rawMp4Max.includes('.m3u8')
      ? rawMp4Max
      : '';
  const rawMp4Low = normalizeMediaUrl(movie.mp4?.['480']);
  const mp4LowUrl =
    rawMp4Low && !rawMp4Low.includes('.mpd') && !rawMp4Low.includes('.m3u8')
      ? rawMp4Low
      : '';
  const moviePosterUrl = normalizeMediaUrl(movie.thumbnail);

  useEffect(() => {
    userInitiatedPlayRef.current = false;
    setHasRequestedPlay(Boolean(autoplay) && !prefersReducedMotion());
    setIsPlaying(false);
    setIsError(false);
    setPosterFailed(false);
  }, [movie, autoplay]);

  useEffect(() => {
    const syncSuspensionState = () => {
      const suspended = shouldSuspendMediaPlayback();
      const prevSuspended = wasSuspendedRef.current;
      wasSuspendedRef.current = suspended;
      if (suspended) {
        pausedForModalRef.current = false;
        videoRef.current?.pause();
        hlsRef.current?.stopLoad();
        setIsSuspendedInGame(true);
      } else {
        setIsSuspendedInGame(false);
        if (prevSuspended && hasRequestedPlay && onlineLifecycleManager.isOnline()) {
          hlsRef.current?.startLoad();
        }
      }
    };

    const syncModalOverlayPause = () => {
      const video = videoRef.current;
      if (!video) return;
      if (isModalOverlayOpen()) {
        if (!video.paused) {
          pausedForModalRef.current = true;
          video.pause();
        }
      } else if (pausedForModalRef.current) {
        pausedForModalRef.current = false;
        if (!shouldSuspendMediaPlayback() && onlineLifecycleManager.isOnline()) {
          void video.play().catch(() => {});
        }
      }
    };

    syncSuspensionState();
    syncModalOverlayPause();

    window.addEventListener('antigravity:launcher-state-changed', syncSuspensionState);
    window.addEventListener('antigravity:hibernate-state-changed', syncSuspensionState);
    window.addEventListener('antigravity:modal-overlay-changed', syncModalOverlayPause);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', syncSuspensionState);
    }

    return () => {
      window.removeEventListener('antigravity:launcher-state-changed', syncSuspensionState);
      window.removeEventListener('antigravity:hibernate-state-changed', syncSuspensionState);
      window.removeEventListener('antigravity:modal-overlay-changed', syncModalOverlayPause);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', syncSuspensionState);
      }
    };
  }, [movie, hasRequestedPlay]);

  useEffect(() => {
    if (isEmbed || !hasRequestedPlay) return;
    const video = videoRef.current;
    if (!video) return;

    if (!onlineLifecycleManager.isOnline()) {
      setIsError(true);
      return;
    }

    let cancelled = false;
    let hlsInstance: Hls | null = null;
    let networkRetryCount = 0;
    let mediaErrorRecoveries = 0;
    setIsError(false);

    const startPlaybackIfAllowed = () => {
      if (!cancelled && !shouldSuspendMediaPlayback() && !isModalOverlayOpen()) {
        void video.play().catch(() => {});
      }
    };

    const fallbackToDirectMp4OrError = () => {
      if (cancelled) return;
      if (mp4MaxUrl && onlineLifecycleManager.isOnline()) {
        video.src = mp4MaxUrl;
        startPlaybackIfAllowed();
      } else if (mp4LowUrl && onlineLifecycleManager.isOnline()) {
        video.src = mp4LowUrl;
        startPlaybackIfAllowed();
      } else {
        setIsError(true);
      }
    };

    const teardownHlsAndFallback = () => {
      hlsInstance?.stopLoad();
      hlsInstance?.detachMedia();
      hlsInstance?.destroy();
      hlsInstance = null;
      hlsRef.current = null;
      fallbackToDirectMp4OrError();
    };

    if (hlsUrl) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native Safari / WebKit HLS — skip downloading 372 kB hls.js bundle
        video.src = hlsUrl;
        startPlaybackIfAllowed();
      } else {
        void (async () => {
          try {
            const HlsModule = await loadHlsModule();
            if (cancelled) return;
            if (HlsModule.isSupported()) {
              hlsInstance = new HlsModule({
                enableWorker: true,
                lowLatencyMode: false,
                maxBufferLength: 15,
                maxMaxBufferLength: 30,
                backBufferLength: 10,
              });
              hlsRef.current = hlsInstance;
              hlsInstance.loadSource(hlsUrl);
              hlsInstance.attachMedia(video);
              hlsInstance.on(HlsModule.Events.MANIFEST_PARSED, () => {
                startPlaybackIfAllowed();
              });
              if (shouldSuspendMediaPlayback()) {
                hlsInstance.stopLoad();
                video.pause();
              }

              hlsInstance.on(HlsModule.Events.ERROR, (_event, data) => {
                if (!data.fatal) return;
                switch (data.type) {
                  case HlsModule.ErrorTypes.NETWORK_ERROR:
                    if (
                      networkRetryCount < 1 &&
                      onlineLifecycleManager.isOnline() &&
                      !shouldSuspendMediaPlayback()
                    ) {
                      networkRetryCount += 1;
                      console.warn('HLS network error, attempting single recovery...', data);
                      hlsInstance?.startLoad();
                    } else {
                      console.warn('HLS fatal network error, stopping stream...', data);
                      teardownHlsAndFallback();
                    }
                    break;
                  case HlsModule.ErrorTypes.MEDIA_ERROR:
                    if (mediaErrorRecoveries < MAX_HLS_MEDIA_ERROR_RECOVERIES) {
                      mediaErrorRecoveries += 1;
                      if (mediaErrorRecoveries === 2) {
                        console.warn(
                          'HLS media error, swapping audio codec & recovering (2/2)...',
                          data
                        );
                        hlsInstance?.swapAudioCodec();
                      } else {
                        console.warn('HLS media error, attempting recovery (1/2)...', data);
                      }
                      hlsInstance?.recoverMediaError();
                    } else {
                      console.warn(
                        'HLS fatal media error exceeded recovery cap, falling back...',
                        data
                      );
                      teardownHlsAndFallback();
                    }
                    break;
                  default:
                    console.warn('HLS unrecoverable fatal error:', data);
                    teardownHlsAndFallback();
                    break;
                }
              });
            } else {
              fallbackToDirectMp4OrError();
            }
          } catch {
            if (cancelled) return;
            fallbackToDirectMp4OrError();
          }
        })();
      }
    } else if (mp4MaxUrl) {
      video.src = mp4MaxUrl;
      startPlaybackIfAllowed();
    } else if (mp4LowUrl) {
      video.src = mp4LowUrl;
      startPlaybackIfAllowed();
    } else {
      setIsError(true);
    }

    return () => {
      cancelled = true;
      if (hlsInstance) {
        hlsInstance.stopLoad();
        hlsInstance.detachMedia();
        hlsInstance.destroy();
      }
      hlsRef.current = null;
      if (video) {
        video.pause();
        video.removeAttribute('src');
        if (typeof video.querySelectorAll === 'function') {
          video.querySelectorAll('source').forEach((s) => {
            s.removeAttribute('src');
            s.remove();
          });
        }
        video.load?.();
      }
    };
  }, [isEmbed, hasRequestedPlay, movie, hlsUrl, mp4MaxUrl, mp4LowUrl, retryNonce]);

  if (isEmbed) {
    const watchUrl = ytId ? `https://www.youtube.com/watch?v=${ytId}` : candidateUrl;
    const allowEmbedAutoplay = userInitiatedPlayRef.current || !prefersReducedMotion();
    const embedSrc = ytId
      ? `https://www.youtube-nocookie.com/embed/${ytId}?autoplay=${allowEmbedAutoplay ? '1' : '0'}&rel=0&modestbranding=1&enablejsapi=1`
      : candidateUrl;
    const posterThumb =
      moviePosterUrl || (ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : '');

    const handleOpenExternal = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(watchUrl);
      } else {
        window.open(watchUrl, '_blank', 'noopener,noreferrer');
      }
    };

    const showPosterGate = isSuspendedInGame || !hasRequestedPlay;

    return (
      <div className="relative w-full h-full bg-black flex items-center justify-center group/embed">
        {showPosterGate ? (
          <button
            type="button"
            data-testid={isSuspendedInGame ? 'suspended-embed-poster' : 'deferred-embed-poster'}
            aria-label={`Play trailer: ${movie.name}`}
            onClick={() => {
              userInitiatedPlayRef.current = true;
              setIsSuspendedInGame(false);
              setHasRequestedPlay(true);
            }}
            className="relative w-full h-full bg-black flex items-center justify-center cursor-pointer group/video border-0 p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent"
          >
            {posterThumb && !posterFailed && (
              <img
                src={posterThumb}
                alt={movie.name}
                onError={() => setPosterFailed(true)}
                className="w-full h-full object-contain select-none opacity-80"
                decoding="async"
              />
            )}
            <div className="absolute inset-0 bg-black/45 flex flex-col items-center justify-center gap-3 transition-opacity group-hover/video:bg-black/30">
              <div className="w-16 h-16 rounded-full bg-steam-accent/30 border-2 border-steam-accent flex items-center justify-center text-white shadow-2xl transform group-hover/video:scale-110 transition-transform">
                <Play className="w-7 h-7 fill-white translate-x-0.5" aria-hidden="true" />
              </div>
              <span className="text-sm font-semibold tracking-wide text-white drop-shadow bg-black/70 px-3 py-1 rounded">
                {movie.name}
              </span>
              {isSuspendedInGame && (
                <span className="text-[11px] text-steam-subtext bg-black/70 px-2.5 py-0.5 rounded">
                  Paused for In-Game Performance — Click to Play
                </span>
              )}
            </div>
          </button>
        ) : (
          <iframe
            src={embedSrc}
            title={movie.name}
            className="w-full h-full border-0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        )}

        {/* Action Pill to Open Trailer Directly in Browser */}
        <a
          href={watchUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleOpenExternal}
          className="absolute top-3 right-3 z-30 flex items-center gap-1.5 min-h-6 px-3 py-1.5 rounded-full bg-black/90 hover:bg-[#c4302b] text-white text-xs font-semibold shadow-xl border border-white/20 transition-all cursor-pointer group/yt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent"
          title={ytId ? 'Watch on YouTube in browser' : 'Open trailer in browser'}
        >
          {ytId ? (
            <svg
              aria-hidden="true"
              className="w-3.5 h-3.5 fill-current text-red-500 group-hover/yt:text-white transition-colors"
              viewBox="0 0 24 24"
            >
              <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
            </svg>
          ) : (
            <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
          )}
          <span>{ytId ? 'Watch on YouTube' : 'Open in Browser'}</span>
          <ExternalLink className="w-3 h-3 opacity-70 group-hover/yt:opacity-100" aria-hidden="true" />
        </a>
      </div>
    );
  }

  // Click-to-play gate: render static poster with 0 MB stream/XHR segment traffic until requested
  if (!hasRequestedPlay) {
    return (
      <button
        type="button"
        data-testid="video-poster-gate"
        aria-label={`Play trailer: ${movie.name}`}
        onClick={() => {
          userInitiatedPlayRef.current = true;
          setIsSuspendedInGame(false);
          setHasRequestedPlay(true);
        }}
        className="relative w-full h-full bg-black flex items-center justify-center cursor-pointer group/video border-0 p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent"
      >
        {moviePosterUrl && !posterFailed && (
          <img
            src={moviePosterUrl}
            alt={movie.name}
            onError={() => setPosterFailed(true)}
            className="w-full h-full object-contain select-none"
            fetchPriority="high"
            decoding="async"
          />
        )}
        <div className="absolute inset-0 bg-black/35 flex flex-col items-center justify-center gap-3 transition-opacity group-hover/video:bg-black/20">
          <div className="w-16 h-16 rounded-full bg-steam-accent/35 border-2 border-steam-accent flex items-center justify-center text-white shadow-2xl transform group-hover/video:scale-110 transition-transform">
            <Play className="w-7 h-7 fill-white translate-x-0.5" aria-hidden="true" />
          </div>
          <span className="text-sm font-semibold tracking-wide text-white drop-shadow bg-black/60 px-3 py-1 rounded">
            {movie.name}
          </span>
        </div>
      </button>
    );
  }

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      setIsSuspendedInGame(false);
      if (onlineLifecycleManager.isOnline()) {
        hlsRef.current?.startLoad();
      }
      videoRef.current.play().catch((err) => {
        console.warn('Playback error:', err);
      });
    } else {
      videoRef.current.pause();
    }
  };

  return (
    <div className="relative w-full h-full bg-black flex items-center justify-center group/video">
      <video
        ref={videoRef}
        controls
        playsInline
        poster={moviePosterUrl || undefined}
        preload="metadata"
        className="w-full h-full object-contain cursor-pointer"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onError={() => {
          if (!hlsUrl) {
            // If max failed, try low resolution MP4 when online
            if (
              onlineLifecycleManager.isOnline() &&
              videoRef.current &&
              mp4LowUrl &&
              videoRef.current.src !== mp4LowUrl
            ) {
              videoRef.current.src = mp4LowUrl;
            } else {
              setIsError(true);
            }
          }
        }}
      >
        {!hlsUrl && mp4MaxUrl && <source src={mp4MaxUrl} type="video/mp4" />}
        {!hlsUrl && mp4LowUrl && <source src={mp4LowUrl} type="video/mp4" />}
      </video>

      {/* Prominent Play Overlay when Paused */}
      {!isPlaying && !isError && (
        <button
          type="button"
          aria-label={`Play ${movie.name}`}
          onClick={togglePlay}
          className="absolute inset-0 bg-black/35 flex flex-col items-center justify-center gap-3 cursor-pointer transition-opacity group-hover/video:bg-black/20 border-0 p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent"
        >
          <div className="w-16 h-16 rounded-full bg-steam-accent/35 border-2 border-steam-accent flex items-center justify-center text-white shadow-2xl transform group-hover/video:scale-110 transition-transform">
            <Play className="w-7 h-7 fill-white translate-x-0.5" aria-hidden="true" />
          </div>
          <span className="text-sm font-semibold tracking-wide text-white drop-shadow bg-black/60 px-3 py-1 rounded">
            {movie.name}
          </span>
        </button>
      )}

      {isError && (
        <div className="absolute inset-0 bg-black/90 flex flex-col items-center justify-center gap-3 text-steam-subtext text-xs p-6 text-center z-20">
          <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center text-red-400">
            <Play className="w-5 h-5 translate-x-0.5 opacity-60" aria-hidden="true" />
          </div>
          <div className="flex flex-col gap-1 max-w-sm">
            <span className="font-semibold text-sm text-white">Trailer Stream Unavailable</span>
            <span className="text-steam-subtext text-xs">
              Direct video playback encountered a network or codec issue.
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsError(false);
                setRetryNonce((n) => n + 1);
                if (!hlsUrl && videoRef.current) {
                  videoRef.current.load();
                }
              }}
              className="min-h-6 px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-white font-medium text-xs transition-colors cursor-pointer"
            >
              Retry
            </button>
            <a
              href={`https://www.youtube.com/results?search_query=${encodeURIComponent(
                `${movie.name || 'Game Trailer'} official trailer`
              )}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 min-h-6 px-3 py-1.5 rounded bg-[#c4302b]/90 hover:bg-[#c4302b] text-white font-medium text-xs shadow transition-colors cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              Watch on YouTube
            </a>
          </div>
        </div>
      )}
    </div>
  );
};

export const MediaGallery: React.FC<MediaGalleryProps> = ({
  screenshots,
  movies,
  headerImage,
  title,
  autoplay,
  gameId,
  steamAppId,
  gogId,
  epicAppName,
  xboxProductId,
  packageFamilyName,
  xboxTitleId,
}) => {
  const resolvedAutoplay = prefersReducedMotion()
    ? false
    : (autoplay ?? (screenshots.length === 0 && !gameId && !title));
  const [isOnline, setIsOnline] = useState<boolean>(() => onlineLifecycleManager.isOnline());
  const [activeIndex, setActiveIndex] = useState(0);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [loadedFullUrls, setLoadedFullUrls] = useState<Record<string, boolean>>({});
  const [failedThumbUrls, setFailedThumbUrls] = useState<Record<string, boolean>>({});
  const [failedFullUrls, setFailedFullUrls] = useState<Record<string, boolean>>({});
  const [headerFallbackFailed, setHeaderFallbackFailed] = useState<boolean>(false);

  const preloadedSetRef = useRef<Set<string>>(new Set());
  const thumbStripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIsOnline(onlineLifecycleManager.isOnline());
    const offConn = onlineLifecycleManager.onConnectivityChange((online) => {
      setIsOnline(online);
    });
    const offOnline = onlineLifecycleManager.onOnline(() => {
      preloadedSetRef.current.clear();
      setFailedThumbUrls({});
      setFailedFullUrls({});
      setHeaderFallbackFailed(false);
    });
    return () => {
      offConn();
      offOnline();
    };
  }, []);

  // Filter out regional non-English trailers when English trailers exist, matching official Steam store
  const hasEnglishMovies = movies.some((m) => !isNonEnglishRegionalMovieName(m.name));
  const visibleMovies = hasEnglishMovies
    ? movies.filter((m) => !isNonEnglishRegionalMovieName(m.name))
    : movies;

  // EXPLICIT OFFLINE POLICY: Omit video trailer slides cleanly when offline so the gallery opens directly onto Screenshot #1
  const effectiveMovies = isOnline ? visibleMovies : [];

  const resolvedScreenshots: SteamScreenshot[] = screenshots.map((s, idx) => ({
    ...s,
    pathThumbnail: toOlMediaUrl({
      url: s.pathThumbnail || s.pathFull,
      gameId,
      role: 'screenshot_thumb',
      ordinal: idx,
      steamAppId,
      gogId,
      epicAppName,
      xboxProductId,
      packageFamilyName,
      xboxTitleId,
    }),
    pathFull: toOlMediaUrl({
      url: s.pathFull || s.pathThumbnail,
      gameId,
      role: 'screenshot_full',
      ordinal: idx,
      steamAppId,
      gogId,
      epicAppName,
      xboxProductId,
      packageFamilyName,
      xboxTitleId,
    }),
  }));

  const resolvedHeaderImage = headerImage
    ? toOlMediaUrl({
        url: headerImage,
        gameId,
        role: 'header',
        ordinal: 0,
        steamAppId,
        gogId,
        epicAppName,
        xboxProductId,
        packageFamilyName,
        xboxTitleId,
      })
    : undefined;

  // Combine movies and screenshots in typical Steam order (movies first when online, then screenshots)
  const items: MediaItem[] = [
    ...effectiveMovies.map((m) => ({ type: 'movie' as const, movie: m })),
    ...resolvedScreenshots.map((s) => ({ type: 'screenshot' as const, screenshot: s })),
  ];

  // List of all viewable screenshots for lightbox modal
  const allScreenshots: SteamScreenshot[] =
    resolvedScreenshots.length > 0
      ? resolvedScreenshots
      : resolvedHeaderImage && !headerFallbackFailed
      ? [{ id: 0, pathThumbnail: resolvedHeaderImage, pathFull: resolvedHeaderImage }]
      : [];

  // Reset carousel ONLY when switching to a different gameId (never on live metadata/launcher updates!)
  useEffect(() => {
    setActiveIndex(0);
    setLightboxIndex(null);
    setHeaderFallbackFailed(false);
  }, [gameId]);

  // Clamp activeIndex cleanly if the media list shrinks for the same game
  useEffect(() => {
    if (items.length === 0) {
      if (activeIndex !== 0) {
        setActiveIndex(0);
      }
    } else if (activeIndex >= items.length) {
      setActiveIndex(items.length - 1);
    }
  }, [items.length, activeIndex]);

  // Preload only the active screenshot + next 1 adjacent screenshot
  useEffect(() => {
    if (shouldSuspendMediaPlayback()) return;

    const preloadFullUrl = (url?: string) => {
      if (!url || preloadedSetRef.current.has(url)) return;
      addBoundedSetEntry(preloadedSetRef.current, url);
      if (typeof Image !== 'undefined') {
        const img = new Image();
        img.onload = () => {
          setLoadedFullUrls((prev) => setBoundedFlag(prev, url));
        };
        img.src = url;
        if (img.complete) {
          setLoadedFullUrls((prev) => setBoundedFlag(prev, url));
        }
      }
    };

    const preloadThumbUrl = (url?: string) => {
      if (!url || preloadedSetRef.current.has(`thumb:${url}`)) return;
      addBoundedSetEntry(preloadedSetRef.current, `thumb:${url}`);
      if (typeof Image !== 'undefined') {
        const img = new Image();
        img.src = url;
      }
    };

    for (const offset of [0, 1]) {
      const target = items[activeIndex + offset];
      if (target?.type === 'screenshot') {
        preloadThumbUrl(target.screenshot.pathThumbnail);
        preloadFullUrl(target.screenshot.pathFull);
      }
    }

    if (lightboxIndex !== null && allScreenshots.length > 0) {
      for (const offset of [0, 1]) {
        const idx = (lightboxIndex + offset + allScreenshots.length) % allScreenshots.length;
        preloadFullUrl(allScreenshots[idx]?.pathFull);
      }
    }
  }, [
    screenshots,
    activeIndex,
    lightboxIndex,
    items.length,
    allScreenshots.length,
    isOnline,
    gameId,
  ]);

  const activeItem = items[activeIndex] || (items.length > 0 ? items[0] : null);

  const selectItem = (index: number) => {
    setActiveIndex(index);
    const strip = thumbStripRef.current;
    if (strip && strip.children[index]) {
      const child = strip.children[index] as HTMLElement;
      child.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  };

  const openLightbox = () => {
    if (activeItem?.type === 'screenshot') {
      const idx = allScreenshots.findIndex(
        (s) => s.id === activeItem.screenshot.id || s.pathFull === activeItem.screenshot.pathFull
      );
      setLightboxIndex(idx >= 0 ? idx : 0);
    } else if (allScreenshots.length > 0) {
      setLightboxIndex(0);
    }
  };

  const handleMarkFullLoaded = useCallback((url: string) => {
    setLoadedFullUrls((prev) => setBoundedFlag(prev, url));
  }, []);

  const handleMarkThumbFailed = useCallback((url: string) => {
    setFailedThumbUrls((prev) => setBoundedFlag(prev, url));
  }, []);

  const handleMarkFullFailed = useCallback((url: string) => {
    setFailedFullUrls((prev) => setBoundedFlag(prev, url));
  }, []);

  const handleCloseLightbox = useCallback(() => {
    setLightboxIndex(null);
  }, []);

  return (
    <div className="w-full flex flex-col gap-2.5">
      {/* Primary Showcase Viewport */}
      <div className="relative aspect-video w-full bg-black/90 rounded overflow-hidden border border-steam-border shadow-xl group">
        {activeItem?.type === 'movie' ? (
          <VideoPlayer
            movie={activeItem.movie}
            autoplay={resolvedAutoplay}
            key={`movie-${activeItem.movie.id}-${activeItem.movie.name}-${activeIndex}`}
          />
        ) : activeItem?.type === 'screenshot' ? (
          (() => {
            const thumbSrc = activeItem.screenshot.pathThumbnail || activeItem.screenshot.pathFull;
            const fullSrc = activeItem.screenshot.pathFull;
            const thumbFailed = Boolean(failedThumbUrls[thumbSrc]);
            const fullFailed = Boolean(failedFullUrls[fullSrc]);
            const isFullReady =
              !fullFailed &&
              (Boolean(loadedFullUrls[fullSrc]) || (thumbSrc === fullSrc && !thumbFailed));
            const bothFailed = thumbFailed && (fullFailed || thumbSrc === fullSrc);

            return (
              <div
                className="relative w-full h-full cursor-pointer overflow-hidden"
                onClick={() => {
                  if (!bothFailed) openLightbox();
                }}
              >
                {/* Instant 0ms base layer from cached thumbnail */}
                {!thumbFailed && (
                  <img
                    key={`thumb-${activeItem.screenshot.id}-${thumbSrc}`}
                    data-testid="media-gallery-screenshot-thumb-base"
                    src={thumbSrc}
                    alt="Screenshot preview"
                    onError={() => handleMarkThumbFailed(thumbSrc)}
                    className="w-full h-full object-cover select-none transition-transform duration-300 group-hover:scale-[1.01]"
                    decoding="async"
                  />
                )}
                {/* Full-resolution progressive overlay */}
                {!fullFailed && (
                  <img
                    key={`full-${activeItem.screenshot.id}-${fullSrc}`}
                    data-testid="media-gallery-screenshot-full"
                    src={fullSrc}
                    alt="Screenshot"
                    onLoad={() => handleMarkFullLoaded(fullSrc)}
                    onError={() => handleMarkFullFailed(fullSrc)}
                    className={`absolute inset-0 w-full h-full object-cover select-none transition-all duration-150 group-hover:scale-[1.01] ${
                      isFullReady ? 'opacity-100' : 'opacity-0'
                    }`}
                    loading="eager"
                    fetchPriority="high"
                    decoding="async"
                  />
                )}
                {bothFailed ? (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-[#16202d] to-[#0e141d] px-6 text-center select-none">
                    <ImageIcon className="w-7 h-7 text-steam-subtext/60" aria-hidden="true" />
                    {title && (
                      <span className="text-sm font-semibold text-steam-text tracking-wide">
                        {title}
                      </span>
                    )}
                    <span className="text-xs text-steam-subtext">
                      {isOnline
                        ? 'Screenshot preview unavailable'
                        : 'Screenshot will cache automatically when online'}
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-label="Expand screenshot"
                    onClick={(e) => {
                      e.stopPropagation();
                      openLightbox();
                    }}
                    className="absolute bottom-3 right-3 z-10 inline-flex items-center justify-center min-w-7 min-h-7 p-1.5 bg-black/70 hover:bg-black/90 text-white rounded border border-white/20 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer"
                    title="Expand screenshot"
                  >
                    <Maximize2 className="w-4 h-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          })()
        ) : (
          <div
            className={`w-full h-full flex items-center justify-center bg-steam-card ${
              resolvedHeaderImage && !headerFallbackFailed ? 'cursor-pointer' : ''
            }`}
            onClick={() => {
              if (resolvedHeaderImage && !headerFallbackFailed) openLightbox();
            }}
          >
            {resolvedHeaderImage && !headerFallbackFailed ? (
              <img
                src={resolvedHeaderImage}
                alt={title || 'Cover'}
                onError={() => setHeaderFallbackFailed(true)}
                className="w-full h-full object-cover"
                fetchPriority="high"
                decoding="async"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-[#16202d] to-[#0e141d] px-6 text-center select-none">
                <ImageIcon className="w-7 h-7 text-steam-subtext/60" aria-hidden="true" />
                {title && (
                  <span className="text-sm font-semibold text-steam-text tracking-wide">
                    {title}
                  </span>
                )}
                <span className="text-steam-subtext text-xs">
                  {isOnline ? 'No media available' : 'Screenshots pending online sync'}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Steam Thumbnail Strip Carousel */}
      {items.length > 0 && (
        <div className="flex flex-col w-full mt-1">
          <div className="relative flex items-center w-full">
            {/* Left Arrow Button */}
            <button
              type="button"
              onClick={() => selectItem(Math.max(0, activeIndex - 1))}
              disabled={activeIndex === 0}
              className="flex-shrink-0 w-8 h-[65px] bg-black/70 hover:bg-[#67c1f5]/30 disabled:opacity-30 disabled:hover:bg-black/70 text-white flex items-center justify-center transition-all z-10 cursor-pointer"
              aria-label="Previous thumbnail"
            >
              <ChevronLeft className="w-4 h-4 text-steam-accent" aria-hidden="true" />
            </button>

            {/* Scrollable Thumbnails List */}
            <div
              ref={thumbStripRef}
              className="flex items-center gap-[4px] overflow-x-auto scrollbar-none py-0.5 px-1 scroll-smooth w-full select-none bg-black/40"
              style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
            >
              {items.map((item, idx) => {
                const isSelected = idx === activeIndex;
                const thumbUrl =
                  item.type === 'movie'
                    ? normalizeMediaUrl(item.movie.thumbnail)
                    : item.screenshot.pathThumbnail;
                const isThumbFailed = !thumbUrl || Boolean(failedThumbUrls[thumbUrl]);

                return (
                  <button
                    key={idx}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => selectItem(idx)}
                    className={`relative flex-shrink-0 w-[116px] h-[65px] overflow-hidden transition-all bg-black cursor-pointer ${
                      isSelected
                        ? 'border-2 border-white'
                        : 'border border-black/40 opacity-70 hover:opacity-100 hover:border-steam-subtext'
                    }`}
                  >
                    {!isThumbFailed ? (
                      <img
                        src={thumbUrl}
                        alt={item.type === 'movie' ? item.movie.name : `Thumbnail ${idx + 1}`}
                        onError={() => handleMarkThumbFailed(thumbUrl)}
                        className="w-full h-full object-cover"
                        loading="lazy"
                        decoding="async"
                        fetchPriority="low"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-[#16202d]">
                        <ImageIcon className="w-4 h-4 text-steam-subtext/50" aria-hidden="true" />
                      </div>
                    )}
                    {item.type === 'movie' && (
                      <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                        <div className="p-1 rounded-full bg-black/60 border border-white/40">
                          <Play className="w-3 h-3 fill-white text-white translate-x-0.5" aria-hidden="true" />
                        </div>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Right Arrow Button */}
            <button
              type="button"
              onClick={() => selectItem(Math.min(items.length - 1, activeIndex + 1))}
              disabled={activeIndex >= items.length - 1}
              className="flex-shrink-0 w-8 h-[65px] bg-black/70 hover:bg-[#67c1f5]/30 disabled:opacity-30 disabled:hover:bg-black/70 text-white flex items-center justify-center transition-all z-10 cursor-pointer"
              aria-label="Next thumbnail"
            >
              <ChevronRight className="w-4 h-4 text-steam-accent" aria-hidden="true" />
            </button>
          </div>

          {/* Steam Trackbar Slider under thumbnails */}
          {items.length > 1 && (
            <div className="w-full h-[9px] bg-black/60 rounded-none relative mt-1 overflow-hidden">
              <div
                className="h-full bg-[#3d4450] hover:bg-[#5c6576] rounded-none transition-all cursor-pointer"
                style={{
                  width: `${Math.max(15, (5 / Math.max(5, items.length)) * 100)}%`,
                  marginLeft: `${(activeIndex / Math.max(1, items.length - 1)) * (100 - Math.max(15, (5 / Math.max(5, items.length)) * 100))}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* Dedicated Top-Layer Modal for Screenshots via ModalShell */}
      {lightboxIndex !== null && allScreenshots[lightboxIndex] && (
        <GalleryLightboxModal
          lightboxIndex={lightboxIndex}
          allScreenshots={allScreenshots}
          isOnline={isOnline}
          loadedFullUrls={loadedFullUrls}
          failedThumbUrls={failedThumbUrls}
          failedFullUrls={failedFullUrls}
          onSelectIndex={setLightboxIndex}
          onClose={handleCloseLightbox}
          onMarkFullLoaded={handleMarkFullLoaded}
          onMarkThumbFailed={handleMarkThumbFailed}
          onMarkFullFailed={handleMarkFullFailed}
        />
      )}
    </div>
  );
};
