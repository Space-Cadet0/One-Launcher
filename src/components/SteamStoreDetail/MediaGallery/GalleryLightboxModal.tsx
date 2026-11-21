import React, { useEffect, useRef } from 'react';
import { SteamScreenshot } from '../../../contracts/steam';
import { unwrapOlMediaUrl } from '../../../contracts/network';
import { ModalShell } from '../../Common/ModalShell';
import { ChevronLeft, ChevronRight, X, Image as ImageIcon, ExternalLink } from 'lucide-react';

export interface GalleryLightboxModalProps {
  lightboxIndex: number;
  allScreenshots: SteamScreenshot[];
  isOnline: boolean;
  loadedFullUrls: Record<string, boolean>;
  failedThumbUrls: Record<string, boolean>;
  failedFullUrls: Record<string, boolean>;
  onSelectIndex: React.Dispatch<React.SetStateAction<number | null>>;
  onClose: () => void;
  onMarkFullLoaded: (url: string) => void;
  onMarkThumbFailed: (url: string) => void;
  onMarkFullFailed: (url: string) => void;
}

export const GalleryLightboxModal: React.FC<GalleryLightboxModalProps> = ({
  lightboxIndex,
  allScreenshots,
  isOnline,
  loadedFullUrls,
  failedThumbUrls,
  failedFullUrls,
  onSelectIndex,
  onClose,
  onMarkFullLoaded,
  onMarkThumbFailed,
  onMarkFullFailed,
}) => {
  const modalThumbStripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (allScreenshots.length <= 1) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        onSelectIndex((prev) =>
          prev !== null && prev > 0 ? prev - 1 : allScreenshots.length - 1
        );
      } else if (e.key === 'ArrowRight') {
        onSelectIndex((prev) =>
          prev !== null && prev < allScreenshots.length - 1 ? prev + 1 : 0
        );
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [allScreenshots.length, onSelectIndex]);

  useEffect(() => {
    if (!modalThumbStripRef.current) return;
    const strip = modalThumbStripRef.current;
    if (strip.children[lightboxIndex]) {
      const child = strip.children[lightboxIndex] as HTMLElement;
      child.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [lightboxIndex]);

  const currentShot = allScreenshots[lightboxIndex];
  if (!currentShot) return null;

  const thumbSrc = currentShot.pathThumbnail || currentShot.pathFull;
  const fullSrc = currentShot.pathFull;
  const thumbFailed = Boolean(failedThumbUrls[thumbSrc]);
  const fullFailed = Boolean(failedFullUrls[fullSrc]);
  const isFullReady =
    !fullFailed &&
    (Boolean(loadedFullUrls[fullSrc]) || (thumbSrc === fullSrc && !thumbFailed));

  return (
    <ModalShell
      isOpen={true}
      onClose={onClose}
      ariaLabel={`Screenshot ${lightboxIndex + 1} of ${allScreenshots.length}`}
      testId="screenshot-lightbox-modal"
      className="relative w-[1140px] max-w-[94vw] h-[780px] max-h-[88vh] bg-[#101722] border border-[#2a475e] rounded-xl shadow-2xl flex flex-col overflow-hidden select-none"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-[#182333] border-b border-[#2a475e]/70 flex-shrink-0">
        <div className="flex items-center gap-2 text-sm text-steam-text font-medium">
          <ImageIcon className="w-4 h-4 text-steam-accent" aria-hidden="true" />
          <span>
            Screenshot {lightboxIndex + 1} of {allScreenshots.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isOnline && currentShot.pathFull && (
            <a
              href={unwrapOlMediaUrl(currentShot.pathFull)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 min-h-6 px-2.5 py-1 text-xs font-medium text-steam-subtext hover:text-white bg-[#212f45] hover:bg-[#2d405e] rounded border border-white/10 transition-colors"
              title="Open full resolution in browser"
            >
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Full Res</span>
            </a>
          )}
          <button
            type="button"
            aria-label="Close screenshot viewer"
            onClick={onClose}
            className="flex items-center gap-1.5 min-w-6 min-h-6 px-2.5 py-1 text-xs font-semibold bg-[#2a384d] hover:bg-[#3d5170] text-white rounded border border-white/10 transition-colors cursor-pointer"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" aria-hidden="true" />
            <span className="text-[10px] uppercase tracking-wider text-steam-subtext">
              Esc
            </span>
          </button>
        </div>
      </div>

      {/* Main Image Stage */}
      <div className="flex-1 min-h-0 relative flex items-center justify-center bg-black/95 p-3 select-none overflow-hidden">
        {allScreenshots.length > 1 && (
          <button
            type="button"
            aria-label="Previous screenshot"
            onClick={() =>
              onSelectIndex((prev) =>
                prev !== null && prev > 0 ? prev - 1 : allScreenshots.length - 1
              )
            }
            className="absolute left-3 top-1/2 -translate-y-1/2 z-20 w-11 h-16 rounded bg-black/60 hover:bg-[#67c1f5]/30 text-white flex items-center justify-center transition-all border border-white/10 hover:border-steam-accent shadow-lg cursor-pointer"
            title="Previous screenshot (Left arrow)"
          >
            <ChevronLeft className="w-7 h-7 text-steam-accent" aria-hidden="true" />
          </button>
        )}

        <div className="relative w-full h-full flex items-center justify-center">
          {!thumbFailed && (
            <img
              key={`lightbox-thumb-${currentShot.id}-${thumbSrc}`}
              src={thumbSrc}
              alt={`Screenshot ${lightboxIndex + 1} preview`}
              onError={() => onMarkThumbFailed(thumbSrc)}
              className="max-w-full max-h-full object-contain rounded shadow-2xl"
              decoding="sync"
            />
          )}
          {!fullFailed && (
            <img
              key={`lightbox-full-${currentShot.id}-${fullSrc}`}
              src={fullSrc}
              alt={`Screenshot ${lightboxIndex + 1}`}
              onLoad={() => onMarkFullLoaded(fullSrc)}
              onError={() => onMarkFullFailed(fullSrc)}
              className={`absolute max-w-full max-h-full object-contain rounded shadow-2xl transition-opacity duration-150 ${
                isFullReady ? 'opacity-100' : 'opacity-0'
              }`}
              loading="eager"
              decoding="async"
            />
          )}
        </div>

        {allScreenshots.length > 1 && (
          <button
            type="button"
            aria-label="Next screenshot"
            onClick={() =>
              onSelectIndex((prev) =>
                prev !== null && prev < allScreenshots.length - 1 ? prev + 1 : 0
              )
            }
            className="absolute right-3 top-1/2 -translate-y-1/2 z-20 w-11 h-16 rounded bg-black/60 hover:bg-[#67c1f5]/30 text-white flex items-center justify-center transition-all border border-white/10 hover:border-steam-accent shadow-lg cursor-pointer"
            title="Next screenshot (Right arrow)"
          >
            <ChevronRight className="w-7 h-7 text-steam-accent" aria-hidden="true" />
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
              const shotThumb = shot.pathThumbnail || shot.pathFull;
              const isShotThumbFailed = !shotThumb || Boolean(failedThumbUrls[shotThumb]);
              return (
                <button
                  key={shot.id ?? idx}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => onSelectIndex(idx)}
                  className={`relative flex-shrink-0 w-24 h-14 rounded overflow-hidden transition-all bg-black cursor-pointer ${
                    isSelected
                      ? 'border-2 border-steam-accent ring-2 ring-steam-accent/40 scale-105'
                      : 'border border-white/10 opacity-60 hover:opacity-100 hover:border-steam-subtext'
                  }`}
                >
                  {!isShotThumbFailed ? (
                    <img
                      src={shotThumb}
                      alt={`Thumbnail ${idx + 1}`}
                      onError={() => onMarkThumbFailed(shotThumb)}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-[#16202d]">
                      <ImageIcon className="w-4 h-4 text-steam-subtext/50" aria-hidden="true" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </ModalShell>
  );
};
