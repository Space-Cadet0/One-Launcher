import React, { useState, useEffect } from 'react';
import { SteamReviewSummary } from '../../contracts/steam';
import { toOlMediaUrl } from '../../contracts/network';
import { OpenCriticData, getTierColor } from '../../services/opencritic/openCritic';
import { ActiveGameFilter } from '../../contracts/filter';
import { stripHtmlToPlainSynopsis } from '../../services/steam/fallbackMetadataProvider';
import { onlineLifecycleManager } from '../../services/network/onlineLifecycleManager';
import { HelpCircle, ExternalLink } from 'lucide-react';

function isSentinelReleaseDateValue(raw?: string | null): boolean {
  if (!raw) return false;
  const match = raw.match(/\b(\d{4})\b/);
  if (!match) return false;
  const year = Number(match[1]);
  const maxValidYear = new Date().getFullYear() + 10;
  return Number.isFinite(year) && (year < 1975 || year > maxValidYear);
}

interface SteamHeroDetailsProps {
  headerImage?: string;
  fallbackImage?: string;
  title: string;
  shortDescription?: string;
  reviewSummary?: SteamReviewSummary;
  openCritic?: OpenCriticData | null;
  releaseDate?: string;
  developers?: string[];
  publishers?: string[];
  tags?: string[];
  onApplyFilter?: (filter: ActiveGameFilter) => void;
  gameId?: string | null;
  steamAppId?: number | string | null;
  gogId?: string | null;
  epicAppName?: string | null;
  xboxProductId?: string | null;
  packageFamilyName?: string | null;
  xboxTitleId?: string | null;
}

export const SteamHeroDetails: React.FC<SteamHeroDetailsProps> = ({
  headerImage,
  fallbackImage,
  title,
  shortDescription,
  reviewSummary,
  openCritic,
  releaseDate = 'TBA',
  developers = [],
  publishers = [],
  tags = [],
  onApplyFilter,
  gameId,
  steamAppId,
  gogId,
  epicAppName,
  xboxProductId,
  packageFamilyName,
  xboxTitleId,
}) => {
  const [primaryFailed, setPrimaryFailed] = useState(false);
  const [fallbackFailed, setFallbackFailed] = useState(false);

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

  const resolvedFallbackImage = fallbackImage
    ? toOlMediaUrl({
        url: fallbackImage,
        gameId,
        role: 'cover',
        ordinal: 0,
        steamAppId,
        gogId,
        epicAppName,
        xboxProductId,
        packageFamilyName,
        xboxTitleId,
      })
    : undefined;

  const displayReleaseDate =
    !releaseDate || isSentinelReleaseDateValue(releaseDate) ? 'TBA' : releaseDate;

  useEffect(() => {
    setPrimaryFailed(false);
    setFallbackFailed(false);
  }, [resolvedHeaderImage, resolvedFallbackImage]);

  useEffect(() => {
    return onlineLifecycleManager.onOnline(() => {
      setPrimaryFailed(false);
      setFallbackFailed(false);
    });
  }, []);

  // Determine Steam review text & color
  const getReviewColor = (desc?: string) => {
    if (!desc) return 'text-[#94a3b8]';
    const d = desc.toLowerCase();
    if (d.includes('positive')) return 'text-[#66C0F4]';
    if (d.includes('mixed')) return 'text-[#e2c28b]';
    if (d.includes('negative')) return 'text-[#f87171]';
    return 'text-[#94a3b8]';
  };

  const displayTags = tags.length > 0 ? tags.slice(0, 7) : [];

  const hasRealUserReviews = Boolean(
    reviewSummary &&
      (reviewSummary.totalReviews > 0 ||
        (reviewSummary.positivePercent > 0 &&
          reviewSummary.reviewScoreDesc &&
          !/no user reviews/i.test(reviewSummary.reviewScoreDesc)))
  );

  const activeHeaderSrc =
    resolvedHeaderImage && !primaryFailed
      ? resolvedHeaderImage
      : resolvedFallbackImage && resolvedFallbackImage !== resolvedHeaderImage && !fallbackFailed
      ? resolvedFallbackImage
      : '';

  return (
    <div className="w-full lg:w-[324px] lg:flex-shrink-0 flex flex-col justify-start text-steam-text select-none text-[12px]">
      {/* Header Capsule Artwork (324 x 151) */}
      <div className="w-full h-[151px] overflow-hidden bg-black/40 mb-2.5 rounded-sm border border-[#2a475e]/40">
        {activeHeaderSrc ? (
          <img
            src={activeHeaderSrc}
            alt={title}
            fetchPriority="high"
            decoding="async"
            onError={() => {
              if (activeHeaderSrc === resolvedHeaderImage) {
                setPrimaryFailed(true);
              } else {
                setFallbackFailed(true);
              }
            }}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-[#1b2838] via-[#131d29] to-[#0d141d] flex items-center justify-center px-4 text-center">
            <span className="text-sm font-bold text-white/90 line-clamp-2 tracking-tight drop-shadow">
              {title}
            </span>
          </div>
        )}
      </div>

      {/* Short Synopsis Description */}
      <div className="text-[13px] leading-[18px] text-[#c6d4df] mb-3 line-clamp-4 min-h-[54px]">
        {stripHtmlToPlainSynopsis(shortDescription, 360) || 'No overview available for this title.'}
      </div>

      {/* Reviews Summary Block (Steam + OpenCritic) */}
      <div className="border-t border-b border-black/50 py-2 mb-2.5 space-y-1.5">
        {(hasRealUserReviews || !openCritic) && (
          <div className="flex items-center">
            <span className="w-[94px] flex-shrink-0 text-[10px] uppercase text-[#94a3b8] font-normal tracking-wider">
              All Reviews:
            </span>
            {hasRealUserReviews && reviewSummary ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() =>
                    onApplyFilter?.({
                      type: 'review',
                      label: 'Reviews',
                      value: reviewSummary.reviewScoreDesc,
                    })
                  }
                  className={`min-h-6 inline-flex items-center font-bold hover:underline cursor-pointer text-left ${getReviewColor(
                    reviewSummary.reviewScoreDesc
                  )}`}
                  title={`Filter library for other "${reviewSummary.reviewScoreDesc}" games`}
                >
                  {reviewSummary.reviewScoreDesc}
                </button>
                {reviewSummary.totalReviews > 0 && (
                  <span className="text-[#94a3b8] font-normal">
                    ({reviewSummary.totalReviews.toLocaleString()})
                  </span>
                )}
                <HelpCircle aria-hidden="true" className="w-3 h-3 text-[#94a3b8] ml-0.5" />
              </div>
            ) : (
              <span className="text-[#94a3b8]">No user reviews</span>
            )}
          </div>
        )}

        {/* Critic Consensus Rating Row */}
        {openCritic && (
          <div className="flex items-center">
            <span className="w-[94px] flex-shrink-0 text-[10px] uppercase text-[#94a3b8] font-normal tracking-wider">
              {openCritic.source === 'metacritic'
                ? 'Metacritic:'
                : openCritic.source === 'metacritic_user'
                ? 'MC User Score:'
                : openCritic.source === 'steam'
                ? 'Steam Rating:'
                : openCritic.source === 'gog'
                ? 'GOG Rating:'
                : openCritic.source === 'epic'
                ? 'Epic Rating:'
                : 'OpenCritic:'}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() =>
                  onApplyFilter?.({
                    type: 'rating',
                    label: 'Rating',
                    value: openCritic.tier,
                  })
                }
                className={`min-h-6 inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-bold border hover:brightness-125 cursor-pointer ${
                  getTierColor(openCritic.tier).badgeBg
                } ${getTierColor(openCritic.tier).badgeBorder} ${
                  getTierColor(openCritic.tier).badgeText
                }`}
                title={`Filter library for ${openCritic.tier} games`}
              >
                {openCritic.source === 'metacritic_user' && openCritic.userScoreRaw !== undefined
                  ? `${openCritic.userScoreRaw}/10`
                  : (openCritic.source === 'gog' || openCritic.source === 'epic') &&
                    openCritic.starRatingRaw !== undefined
                  ? `${openCritic.starRatingRaw}★`
                  : openCritic.score}
              </button>
              <button
                type="button"
                onClick={() =>
                  onApplyFilter?.({
                    type: 'rating',
                    label: 'Rating',
                    value: openCritic.tier,
                  })
                }
                className={`min-h-6 inline-flex items-center font-bold hover:underline cursor-pointer ${
                  getTierColor(openCritic.tier).accentText
                }`}
                title={`Filter library for ${openCritic.tier} games`}
              >
                {openCritic.tier}
              </button>
              <a
                href={openCritic.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
                    window.electronAPI.openExternal(openCritic.url);
                  } else {
                    window.open(openCritic.url, '_blank', 'noreferrer,noopener');
                  }
                }}
                className="inline-flex items-center justify-center min-w-6 min-h-6 text-[#94a3b8] hover:text-[#c6d4df] transition-colors ml-0.5 cursor-pointer"
                title={
                  openCritic.source === 'metacritic'
                    ? `View ${title} on Metacritic.com`
                    : openCritic.source === 'metacritic_user'
                    ? `View ${title} User Reviews on Metacritic.com`
                    : openCritic.source === 'steam'
                    ? `View ${title} on Steam Store`
                    : openCritic.source === 'gog'
                    ? `View ${title} on GOG.com`
                    : openCritic.source === 'epic'
                    ? `View ${title} on Epic Games Store`
                    : `View ${title} on OpenCritic.com`
                }
              >
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
              {openCritic.percentRecommended !== undefined ? (
                <span className="text-[#94a3b8] font-normal text-[11px]">
                  ({openCritic.percentRecommended}%{' '}
                  {openCritic.source === 'steam' ? 'positive' : 'rec'})
                </span>
              ) : (
                (openCritic.source === 'gog' || openCritic.source === 'epic') && (
                  <span className="text-[#94a3b8] font-normal text-[11px]">
                    ({openCritic.score}/100)
                  </span>
                )
              )}
            </div>
          </div>
        )}
      </div>

      {/* Key Details Rows (Release Date, Developer, Publisher) */}
      <div className="space-y-1 mb-3">
        {/* Release Date */}
        <div className="flex items-center">
          <span className="w-[94px] flex-shrink-0 text-[10px] uppercase text-[#94a3b8] font-normal tracking-wider">
            Release Date:
          </span>
          <span className="text-[#94a3b8]">{displayReleaseDate}</span>
        </div>

        {/* Developer */}
        <div className="flex items-center">
          <span className="w-[94px] flex-shrink-0 text-[10px] uppercase text-[#94a3b8] font-normal tracking-wider">
            Developer:
          </span>
          <div className="truncate space-x-1">
            {developers.map((dev, idx) => (
              <span key={idx}>
                <button
                  type="button"
                  onClick={() =>
                    onApplyFilter?.({ type: 'developer', label: 'Developer', value: dev })
                  }
                  className="min-h-6 inline-flex items-center text-[#67c1f5] hover:underline cursor-pointer hover:text-white transition-colors"
                  title={`Filter library by developer "${dev}"`}
                >
                  {dev}
                </button>
                {idx < developers.length - 1 && <span className="text-[#94a3b8]">, </span>}
              </span>
            ))}
            {developers.length === 0 && <span className="text-[#94a3b8]">Unknown</span>}
          </div>
        </div>

        {/* Publisher */}
        <div className="flex items-center">
          <span className="w-[94px] flex-shrink-0 text-[10px] uppercase text-[#94a3b8] font-normal tracking-wider">
            Publisher:
          </span>
          <div className="truncate space-x-1">
            {publishers.map((pub, idx) => (
              <span key={idx}>
                <button
                  type="button"
                  onClick={() =>
                    onApplyFilter?.({ type: 'publisher', label: 'Publisher', value: pub })
                  }
                  className="min-h-6 inline-flex items-center text-[#67c1f5] hover:underline cursor-pointer hover:text-white transition-colors"
                  title={`Filter library by publisher "${pub}"`}
                >
                  {pub}
                </button>
                {idx < publishers.length - 1 && <span className="text-[#94a3b8]">, </span>}
              </span>
            ))}
            {publishers.length === 0 && <span className="text-[#94a3b8]">Unknown</span>}
          </div>
        </div>
      </div>

      {/* Popular User-Defined Tags (.glance_tags_ctn) */}
      <div className="pt-1">
        <div className="text-[11px] text-[#94a3b8] mb-1.5">
          Popular user-defined tags for this product:
        </div>
        {displayTags.length > 0 ? (
          <div className="flex flex-wrap gap-1 items-center">
            {displayTags.map((tag, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onApplyFilter?.({ type: 'tag', label: 'Tag', value: tag })}
                className="inline-flex items-center px-2 min-h-6 text-[11px] bg-[rgba(103,193,245,0.2)] hover:bg-[rgba(103,193,245,0.4)] text-[#67c1f5] hover:text-white rounded-[2px] transition-colors cursor-pointer"
                title={`Filter library by tag "${tag}"`}
              >
                {tag}
              </button>
            ))}
            {/* Steam Plus Tag Button */}
            <button
              type="button"
              aria-label="View more tags"
              onClick={() =>
                displayTags[0] &&
                onApplyFilter?.({ type: 'tag', label: 'Tag', value: displayTags[0] })
              }
              className="inline-flex items-center justify-center min-w-6 min-h-6 bg-[rgba(103,193,245,0.2)] hover:bg-[rgba(103,193,245,0.4)] text-[#67c1f5] hover:text-white rounded-[2px] cursor-pointer text-xs transition-colors"
              title="Browse tags"
            >
              +
            </button>
          </div>
        ) : (
          <div className="text-[11px] text-[#94a3b8] italic">Tags pending online sync</div>
        )}
      </div>
    </div>
  );
};
