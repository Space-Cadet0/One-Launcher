import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type Hls from 'hls.js';
import { SteamScreenshot, SteamMovie } from '../../contracts/steam';
import { isNonEnglishRegionalMovieName } from '../../services/steam/steamApi';
import {
  Play,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  X,
  Image as ImageIcon,
  ExternalLink,
} from 'lucide-react';

interface MediaGalleryProps {
  screenshots: SteamScreenshot[];
  movies: SteamMovie[];
  headerImage?: string;
}

type MediaItem =
  | { type: 'movie'; movie: SteamMovie }
  | { type: 'screenshot'; screenshot: SteamScreenshot };

function extractYouTubeId(url?: string): string | null {
  if (!url) return null;
  const match = url.match(
    /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/
  );
  return match && match[1] ? match[1] : null;
}

const VideoPlayer: React.FC<{ movie: SteamMovie }> = ({ movie }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isError, setIsError] = useState(false);

  // Check if it's an iframe embed (YouTube/Wistia/Vimeo from GOG or fallback providers)
  const candidateUrl =
    movie.mp4?.max ||
    movie.mp4?.['480'] ||
    movie.webm?.max ||
    movie.webm?.['480'] ||
    '';
  const ytId = extractYouTubeId(candidateUrl);
  const isEmbed =
    Boolean(ytId) ||
    candidateUrl.includes('youtube.com') ||
    candidateUrl.includes('youtu.be') ||
    candidateUrl.includes('wistia.net') ||
    candidateUrl.includes('player.vimeo.com');

  if (isEmbed) {
    const watchUrl = ytId ? `https://www.youtube.com/watch?v=${ytId}` : candidateUrl;
    const embedSrc = ytId
      ? `https://www.youtube-nocookie.com/embed/${ytId}?autoplay=1&rel=0&modestbranding=1&enablejsapi=1`
      : candidateUrl;

    const handleOpenExternal = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(watchUrl);
      } else {
        window.open(watchUrl, '_blank', 'noopener,noreferrer');
      }
    };

    return (
      <div className="relative w-full h-full bg-black flex items-center justify-center group/embed">
        <iframe
          src={embedSrc}
          title={movie.name}
          className="w-full h-full border-0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />

        {/* Action Pill to Open Trailer Directly in Browser */}
        <button
          type="button"
          onClick={handleOpenExternal}
          className="absolute top-3 right-3 z-30 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/85 hover:bg-[#c4302b] text-white text-xs font-semibold shadow-xl backdrop-blur-sm border border-white/20 transition-all cursor-pointer group/yt"
          title={ytId ? 'Watch on YouTube in browser' : 'Open trailer in browser'}
        >
          {ytId ? (
            <svg
              className="w-3.5 h-3.5 fill-current text-red-500 group-hover/yt:text-white transition-colors"
              viewBox="0 0 24 24"
            >
              <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
            </svg>
          ) : (
            <ExternalLink className="w-3.5 h-3.5" />
          )}
          <span>{ytId ? 'Watch on YouTube' : 'Open in Browser'}</span>
          <ExternalLink className="w-3 h-3 opacity-70 group-hover/yt:opacity-100" />
        </button>
      </div>
    );
  }

  // Determine stream URLs
  const hlsUrl = movie.hls || (movie as any).hls_h264 || '';
  const mp4MaxUrl =
    movie.mp4?.max && !movie.mp4.max.includes('.mpd') && !movie.mp4.max.includes('.m3u8')
      ? movie.mp4.max
      : '';
  const mp4LowUrl =
    movie.mp4?.['480'] && !movie.mp4['480'].includes('.mpd') && !movie.mp4['480'].includes('.m3u8')
      ? movie.mp4['480']
      : '';

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let hlsInstance: Hls | null = null;
    setIsError(false);

    if (hlsUrl) {
      void (async () => {
        try {
          const { default: HlsModule } = await import('hls.js');
          if (cancelled) return;
          if (HlsModule.isSupported()) {
            hlsInstance = new HlsModule({ enableWorker: true, lowLatencyMode: false });
            hlsInstance.loadSource(hlsUrl);
            hlsInstance.attachMedia(video);

            hlsInstance.on(HlsModule.Events.ERROR, (_event, data) => {
              if (data.fatal) {
                switch (data.type) {
                  case HlsModule.ErrorTypes.NETWORK_ERROR:
                    console.warn('HLS network error, attempting recovery...', data);
                    hlsInstance?.startLoad();
                    break;
                  case HlsModule.ErrorTypes.MEDIA_ERROR:
                    console.warn('HLS media error, attempting recovery...', data);
                    hlsInstance?.recoverMediaError();
                    break;
                  default:
                    console.warn('HLS unrecoverable fatal error:', data);
                    hlsInstance?.destroy();
                    hlsInstance = null;
                    if (mp4MaxUrl) {
                      video.src = mp4MaxUrl;
                    } else {
                      setIsError(true);
                    }
                    break;
                }
              }
            });
          } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Native Safari / WebKit HLS
            video.src = hlsUrl;
          } else if (mp4MaxUrl) {
            video.src = mp4MaxUrl;
          } else {
            setIsError(true);
          }
        } catch {
          if (cancelled) return;
          if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = hlsUrl;
          } else if (mp4MaxUrl) {
            video.src = mp4MaxUrl;
          } else {
            setIsError(true);
          }
        }
      })();
    } else if (mp4MaxUrl) {
      video.src = mp4MaxUrl;
    } else {
      setIsError(true);
    }

    return () => {
      cancelled = true;
      if (hlsInstance) {
        hlsInstance.destroy();
      }
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
    };
  }, [movie, hlsUrl, mp4MaxUrl]);

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
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
        poster={movie.thumbnail}
        preload="metadata"
        className="w-full h-full object-contain cursor-pointer"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onError={() => {
          if (!hlsUrl) {
            // If max failed, try low resolution MP4
            if (videoRef.current && mp4LowUrl && videoRef.current.src !== mp4LowUrl) {
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
        <div
          onClick={togglePlay}
          className="absolute inset-0 bg-black/35 flex flex-col items-center justify-center gap-3 cursor-pointer transition-opacity group-hover/video:bg-black/20"
        >
          <div className="w-16 h-16 rounded-full bg-steam-accent/30 border-2 border-steam-accent flex items-center justify-center text-white backdrop-blur shadow-2xl transform group-hover/video:scale-110 transition-transform">
            <Play className="w-7 h-7 fill-white translate-x-0.5" />
          </div>
          <span className="text-sm font-semibold tracking-wide text-white drop-shadow bg-black/60 px-3 py-1 rounded">
            {movie.name}
          </span>
        </div>
      )}

      {isError && (
        <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center gap-3 text-steam-subtext text-xs p-6 text-center backdrop-blur-sm z-20">
          <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center text-red-400">
            <Play className="w-5 h-5 translate-x-0.5 opacity-60" />
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
                if (videoRef.current) {
                  videoRef.current.load();
                }
              }}
              className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-white font-medium text-xs transition-colors cursor-pointer"
            >
              Retry
            </button>
            <a
              href={`https://www.youtube.com/results?search_query=${encodeURIComponent(
                `${movie.name || 'Game Trailer'} official trailer`
              )}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#c4302b]/90 hover:bg-[#c4302b] text-white font-medium text-xs shadow transition-colors cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" />
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
}) => {
  // Filter out regional non-English trailers (e.g. Chinese/Japanese/Italian/French dubs) when English trailers exist, matching official Steam store
  const hasEnglishMovies = movies.some((m) => !isNonEnglishRegionalMovieName(m.name));
  const visibleMovies = hasEnglishMovies
    ? movies.filter((m) => !isNonEnglishRegionalMovieName(m.name))
    : movies;

  // Combine movies and screenshots in typical Steam order (movies first, then screenshots)
  const items: MediaItem[] = [
    ...visibleMovies.map((m) => ({ type: 'movie' as const, movie: m })),
    ...screenshots.map((s) => ({ type: 'screenshot' as const, screenshot: s })),
  ];

  // List of all viewable screenshots for lightbox modal
  const allScreenshots: SteamScreenshot[] =
    screenshots.length > 0
      ? screenshots
      : headerImage
      ? [{ id: 0, pathThumbnail: headerImage, pathFull: headerImage }]
      : [];

  const [activeIndex, setActiveIndex] = useState(0);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [loadedFullUrls, setLoadedFullUrls] = useState<Record<string, boolean>>({});
  const preloadedSetRef = useRef<Set<string>>(new Set());
  const thumbStripRef = useRef<HTMLDivElement>(null);
  const modalThumbStripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveIndex(0);
  }, [screenshots, movies]);

  // Preload only the active screenshot + next 1 adjacent screenshot
  useEffect(() => {
    const preloadFullUrl = (url?: string) => {
      if (!url || preloadedSetRef.current.has(url)) return;
      preloadedSetRef.current.add(url);
      if (typeof Image !== 'undefined') {
        const img = new Image();
        img.onload = () => {
          setLoadedFullUrls((prev) => (prev[url] ? prev : { ...prev, [url]: true }));
        };
        img.src = url;
        if (img.complete) {
          setLoadedFullUrls((prev) => (prev[url] ? prev : { ...prev, [url]: true }));
        }
      }
    };

    const preloadThumbUrl = (url?: string) => {
      if (!url || preloadedSetRef.current.has(`thumb:${url}`)) return;
      preloadedSetRef.current.add(`thumb:${url}`);
      if (typeof Image !== 'undefined') {
        const img = new Image();
        img.src = url;
      }
    };

    // Preload active screenshot + next 1 adjacent screenshot in primary showcase
    for (const offset of [0, 1]) {
      const target = items[activeIndex + offset];
      if (target?.type === 'screenshot') {
        preloadThumbUrl(target.screenshot.pathThumbnail);
        preloadFullUrl(target.screenshot.pathFull);
      }
    }

    // Preload active lightbox screenshot + next 1 adjacent screenshot
    if (lightboxIndex !== null && allScreenshots.length > 0) {
      for (const offset of [0, 1]) {
        const idx = (lightboxIndex + offset + allScreenshots.length) % allScreenshots.length;
        preloadFullUrl(allScreenshots[idx]?.pathFull);
      }
    }
  }, [screenshots, activeIndex, lightboxIndex, items.length, allScreenshots.length]);

  // Keyboard navigation for lightbox
  useEffect(() => {
    if (lightboxIndex === null) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLightboxIndex(null);
      } else if (e.key === 'ArrowLeft') {
        setLightboxIndex((prev) =>
          prev !== null && prev > 0 ? prev - 1 : allScreenshots.length - 1
        );
      } else if (e.key === 'ArrowRight') {
        setLightboxIndex((prev) =>
          prev !== null && prev < allScreenshots.length - 1 ? prev + 1 : 0
        );
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightboxIndex, allScreenshots.length]);

  // Scroll active modal thumbnail into view
  useEffect(() => {
    if (lightboxIndex === null || !modalThumbStripRef.current) return;
    const strip = modalThumbStripRef.current;
    if (strip.children[lightboxIndex]) {
      const child = strip.children[lightboxIndex] as HTMLElement;
      child.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [lightboxIndex]);

  const activeItem = items[activeIndex] || (items.length > 0 ? items[0] : null);

  const selectItem = (index: number) => {
    setActiveIndex(index);
    // Smooth scroll the active thumbnail into view
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

  return (
    <div className="w-full flex flex-col gap-2.5">
      {/* Primary Showcase Viewport */}
      <div className="relative aspect-video w-full bg-black/90 rounded overflow-hidden border border-steam-border shadow-xl group">
        {activeItem?.type === 'movie' ? (
          <VideoPlayer
            movie={activeItem.movie}
            key={`movie-${activeItem.movie.id}-${activeItem.movie.name}-${activeIndex}`}
          />
        ) : activeItem?.type === 'screenshot' ? (
          (() => {
            const thumbSrc = activeItem.screenshot.pathThumbnail || activeItem.screenshot.pathFull;
            const fullSrc = activeItem.screenshot.pathFull;
            const isFullReady = Boolean(loadedFullUrls[fullSrc]) || thumbSrc === fullSrc;
            return (
              <div
                className="relative w-full h-full cursor-pointer overflow-hidden"
                onClick={openLightbox}
              >
                {/* Instant 0ms base layer from cached thumbnail */}
                <img
                  key={`thumb-${activeItem.screenshot.id}-${thumbSrc}`}
                  data-testid="media-gallery-screenshot-thumb-base"
                  src={thumbSrc}
                  alt="Screenshot preview"
                  className="w-full h-full object-cover select-none transition-transform duration-300 group-hover:scale-[1.01]"
                  fetchPriority="high"
                  decoding="async"
                />
                {/* Full-resolution progressive overlay */}
                <img
                  key={`full-${activeItem.screenshot.id}-${fullSrc}`}
                  data-testid="media-gallery-screenshot-full"
                  src={fullSrc}
                  alt="Screenshot"
                  onLoad={() =>
                    setLoadedFullUrls((prev) => (prev[fullSrc] ? prev : { ...prev, [fullSrc]: true }))
                  }
                  className={`absolute inset-0 w-full h-full object-cover select-none transition-all duration-150 group-hover:scale-[1.01] ${
                    isFullReady ? 'opacity-100' : 'opacity-0'
                  }`}
                  loading="eager"
                  fetchPriority="high"
                  decoding="async"
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    openLightbox();
                  }}
                  className="absolute bottom-3 right-3 z-10 p-1.5 bg-black/70 hover:bg-black/90 text-white rounded border border-white/20 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Expand screenshot"
                >
                  <Maximize2 className="w-4 h-4" />
                </button>
              </div>
            );
          })()
        ) : (
          <div
            className={`w-full h-full flex items-center justify-center bg-steam-card ${
              headerImage ? 'cursor-pointer' : ''
            }`}
            onClick={() => {
              if (headerImage) openLightbox();
            }}
          >
            {headerImage ? (
              <img
                src={headerImage}
                alt="Cover"
                className="w-full h-full object-cover"
                fetchPriority="high"
                decoding="async"
              />
            ) : (
              <span className="text-steam-subtext text-sm">No media available</span>
            )}
          </div>
        )}
      </div>

      {/* Steam Thumbnail Strip Carousel */}
      <div className="flex flex-col w-full mt-1">
        <div className="relative flex items-center w-full">
          {/* Left Arrow Button */}
          <button
            onClick={() => selectItem(Math.max(0, activeIndex - 1))}
            disabled={activeIndex === 0}
            className="flex-shrink-0 w-8 h-[65px] bg-black/70 hover:bg-[#67c1f5]/30 disabled:opacity-30 disabled:hover:bg-black/70 text-white flex items-center justify-center transition-all z-10"
            aria-label="Previous thumbnail"
          >
            <ChevronLeft className="w-4 h-4 text-steam-accent" />
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
                  ? item.movie.thumbnail
                  : item.screenshot.pathThumbnail;

              return (
                <button
                  key={idx}
                  onClick={() => selectItem(idx)}
                  className={`relative flex-shrink-0 w-[116px] h-[65px] overflow-hidden transition-all bg-black ${
                    isSelected
                      ? 'border-2 border-white'
                      : 'border border-black/40 opacity-70 hover:opacity-100 hover:border-steam-subtext'
                  }`}
                >
                  <img
                    src={thumbUrl}
                    alt={item.type === 'movie' ? item.movie.name : `Thumbnail ${idx}`}
                    className="w-full h-full object-cover"
                    loading="lazy"
                    decoding="async"
                    fetchPriority="low"
                  />
                  {item.type === 'movie' && (
                    <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                      <div className="p-1 rounded-full bg-black/60 border border-white/40">
                        <Play className="w-3 h-3 fill-white text-white translate-x-0.5" />
                      </div>
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Right Arrow Button */}
          <button
            onClick={() => selectItem(Math.min(items.length - 1, activeIndex + 1))}
            disabled={activeIndex >= items.length - 1}
            className="flex-shrink-0 w-8 h-[65px] bg-black/70 hover:bg-[#67c1f5]/30 disabled:opacity-30 disabled:hover:bg-black/70 text-white flex items-center justify-center transition-all z-10"
            aria-label="Next thumbnail"
          >
            <ChevronRight className="w-4 h-4 text-steam-accent" />
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

      {/* Dedicated Fixed-Size Pop-out Modal for Screenshots (Portaled to document.body) */}
      {lightboxIndex !== null && allScreenshots[lightboxIndex] &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[99999] bg-black/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 select-none animate-in fade-in duration-150"
            onClick={() => setLightboxIndex(null)}
          >
            <div
              className="relative w-[1140px] max-w-[94vw] h-[780px] max-h-[88vh] bg-[#101722] border border-[#2a475e] rounded-xl shadow-2xl flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 bg-[#182333] border-b border-[#2a475e]/70 flex-shrink-0">
                <div className="flex items-center gap-2 text-sm text-steam-light font-medium">
                  <ImageIcon className="w-4 h-4 text-steam-accent" />
                  <span>
                    Screenshot {lightboxIndex + 1} of {allScreenshots.length}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {allScreenshots[lightboxIndex].pathFull && (
                    <a
                      href={allScreenshots[lightboxIndex].pathFull}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-steam-subtext hover:text-white bg-[#212f45] hover:bg-[#2d405e] rounded border border-white/10 transition-colors"
                      title="Open full resolution in browser"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Full Res</span>
                    </a>
                  )}
                  <button
                    onClick={() => setLightboxIndex(null)}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold bg-[#2a384d] hover:bg-[#3d5170] text-white rounded border border-white/10 transition-colors cursor-pointer"
                    title="Close (Esc)"
                  >
                    <X className="w-4 h-4" />
                    <span className="text-[10px] uppercase tracking-wider text-steam-subtext">Esc</span>
                  </button>
                </div>
              </div>

              {/* Main Image Stage */}
              <div className="flex-1 min-h-0 relative flex items-center justify-center bg-black/95 p-3 select-none overflow-hidden">
                {allScreenshots.length > 1 && (
                  <button
                    onClick={() =>
                      setLightboxIndex((prev) =>
                        prev !== null && prev > 0 ? prev - 1 : allScreenshots.length - 1
                      )
                    }
                    className="absolute left-3 top-1/2 -translate-y-1/2 z-20 w-11 h-16 rounded bg-black/60 hover:bg-[#67c1f5]/30 text-white flex items-center justify-center transition-all border border-white/10 hover:border-steam-accent shadow-lg cursor-pointer"
                    title="Previous screenshot (Left arrow)"
                  >
                    <ChevronLeft className="w-7 h-7 text-steam-accent" />
                  </button>
                )}

                {(() => {
                  const currentShot = allScreenshots[lightboxIndex];
                  const thumbSrc = currentShot.pathThumbnail || currentShot.pathFull;
                  const fullSrc = currentShot.pathFull;
                  const isFullReady = Boolean(loadedFullUrls[fullSrc]) || thumbSrc === fullSrc;
                  return (
                    <div className="relative w-full h-full flex items-center justify-center">
                      <img
                        key={`lightbox-thumb-${currentShot.id}-${thumbSrc}`}
                        src={thumbSrc}
                        alt={`Screenshot ${lightboxIndex + 1} preview`}
                        className="max-w-full max-h-full object-contain rounded shadow-2xl"
                        decoding="sync"
                      />
                      <img
                        key={`lightbox-full-${currentShot.id}-${fullSrc}`}
                        src={fullSrc}
                        alt={`Screenshot ${lightboxIndex + 1}`}
                        onLoad={() =>
                          setLoadedFullUrls((prev) =>
                            prev[fullSrc] ? prev : { ...prev, [fullSrc]: true }
                          )
                        }
                        className={`absolute max-w-full max-h-full object-contain rounded shadow-2xl transition-opacity duration-150 ${
                          isFullReady ? 'opacity-100' : 'opacity-0'
                        }`}
                        loading="eager"
                        decoding="async"
                      />
                    </div>
                  );
                })()}

                {allScreenshots.length > 1 && (
                  <button
                    onClick={() =>
                      setLightboxIndex((prev) =>
                        prev !== null && prev < allScreenshots.length - 1 ? prev + 1 : 0
                      )
                    }
                    className="absolute right-3 top-1/2 -translate-y-1/2 z-20 w-11 h-16 rounded bg-black/60 hover:bg-[#67c1f5]/30 text-white flex items-center justify-center transition-all border border-white/10 hover:border-steam-accent shadow-lg cursor-pointer"
                    title="Next screenshot (Right arrow)"
                  >
                    <ChevronRight className="w-7 h-7 text-steam-accent" />
                  </button>
                )}
              </div>

              {/* Bottom Thumbnail Strip */}
              {allScreenshots.length > 1 && (
                <div className="p-2.5 bg-[#141d2b] border-t border-[#2a475e]/70 flex-shrink-0">
                  <div
                    ref={modalThumbStripRef}
                    className="flex items-center gap-2 overflow-x-auto scrollbar-none py-1 px-1 scroll-smooth w-full select-none"
                    style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                  >
                    {allScreenshots.map((shot, idx) => {
                      const isSelected = idx === lightboxIndex;
                      return (
                        <button
                          key={shot.id ?? idx}
                          onClick={() => setLightboxIndex(idx)}
                          className={`relative flex-shrink-0 w-24 h-14 rounded overflow-hidden transition-all bg-black cursor-pointer ${
                            isSelected
                              ? 'border-2 border-steam-accent ring-2 ring-steam-accent/40 scale-105'
                              : 'border border-white/10 opacity-60 hover:opacity-100 hover:border-steam-subtext'
                          }`}
                        >
                          <img
                            src={shot.pathThumbnail || shot.pathFull}
                            alt={`Thumbnail ${idx + 1}`}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
