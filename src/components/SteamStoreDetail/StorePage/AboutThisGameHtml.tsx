import React, { useEffect, useRef } from 'react';
import { toOlMediaUrl, unwrapOlMediaUrl } from '../../../contracts/network';
import { onlineLifecycleManager } from '../../../services/network/onlineLifecycleManager';
import { launcherService } from '../../../services/launcher/launcherService';
import { sanitizeSafeDomFragment } from '../../../utils/safeHtmlSanitizer';
import { isModalOverlayOpen } from '../../../utils/modalOverlayLock';
import { prefersReducedMotion } from '../MediaGallery/mediaGalleryUtils';
import {
  normalizeProtocolRelativeUrl,
  normalizeSrcsetUrls,
} from './steamDetailUtils';

export interface AboutThisGameHtmlProps {
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

const AboutThisGameHtmlImpl: React.FC<AboutThisGameHtmlProps> = ({
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
      const validSources: HTMLSourceElement[] = [];
      rawSources.forEach((sourceEl) => {
        const normalizedSourceSrc = normalizeProtocolRelativeUrl(sourceEl.getAttribute('src'));
        if (normalizedSourceSrc) {
          sourceEl.setAttribute('src', normalizedSourceSrc);
          validSources.push(sourceEl);
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
        !isModalOverlayOpen() &&
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
              isModalOverlayOpen() ||
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

export const AboutThisGameHtml: React.FC<AboutThisGameHtmlProps> = React.memo(
  AboutThisGameHtmlImpl
);
