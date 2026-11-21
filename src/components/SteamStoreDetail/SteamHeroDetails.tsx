import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { SteamReviewSummary } from '../../contracts/steam';
import { toOlMediaUrl } from '../../contracts/network';
import { OpenCriticData, getTierColor } from '../../services/opencritic/openCritic';
import { getReviewSourceDisplayMeta } from '../../services/critic/criticUtils';
import { ActiveGameFilter } from '../../contracts/filter';
import type { ResolvedGameTag, TagFacetCount } from '../../contracts/tags';
import { stripHtmlToPlainSynopsis } from '../../services/steam/fallbackMetadataProvider';
import { onlineLifecycleManager } from '../../services/network/onlineLifecycleManager';
import { resolveEffectiveGameTags, type ResolvableTagGame } from '../../services/tags/gameTagResolver';
import {
  USER_TAG_OVERRIDES_UPDATED_EVENT,
  addUserTagForGame,
  normalizeTagKey,
  removeUserTagForGame,
  resetUserTagsForGame,
  sanitizeTagLabel,
  type TagOverrideGameIdentity,
} from '../../services/storage/userTagStorage';
import { TagManagerPopover } from './TagManagerPopover';
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
  headerOverrideToken?: string;
  coverOverrideToken?: string;
  tagEntries?: ResolvedGameTag[];
  availableLibraryTags?: TagFacetCount[];
  hasUserTagEdits?: boolean;
  onAddTag?: (tag: string) => void;
  onRemoveTag?: (tag: string) => void;
  onResetTags?: () => void;
  platforms?: Array<{ platformId: string; platformGameId: string }>;
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
  headerOverrideToken,
  coverOverrideToken,
  tagEntries,
  availableLibraryTags,
  hasUserTagEdits,
  onAddTag,
  onRemoveTag,
  onResetTags,
  platforms,
}) => {
  const [primaryFailed, setPrimaryFailed] = useState(false);
  const [fallbackFailed, setFallbackFailed] = useState(false);
  const [localTagRevision, setLocalTagRevision] = useState(0);

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
        ov: headerOverrideToken,
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
        ov: coverOverrideToken,
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

  useEffect(() => {
    if (tagEntries !== undefined) return;
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const handleTagUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ gameId?: string }>).detail;
      if (!detail?.gameId || !gameId || detail.gameId === gameId) {
        setLocalTagRevision((rev) => rev + 1);
      }
    };
    window.addEventListener(USER_TAG_OVERRIDES_UPDATED_EVENT, handleTagUpdate);
    return () => {
      window.removeEventListener(USER_TAG_OVERRIDES_UPDATED_EVENT, handleTagUpdate);
    };
  }, [tagEntries, gameId]);

  const fallbackGameIdentity = useMemo<TagOverrideGameIdentity | null>(() => {
    if (!gameId) return null;
    const resolvedPlatforms: Array<{ platformId: string; platformGameId: string }> =
      Array.isArray(platforms) && platforms.length > 0 ? [...platforms] : [];
    if (resolvedPlatforms.length === 0) {
      if (gogId) resolvedPlatforms.push({ platformId: 'gog', platformGameId: gogId });
      if (epicAppName) resolvedPlatforms.push({ platformId: 'epic', platformGameId: epicAppName });
      if (xboxProductId) {
        resolvedPlatforms.push({ platformId: 'xbox', platformGameId: xboxProductId });
      }
      const parsedSteam =
        typeof steamAppId === 'number'
          ? steamAppId
          : typeof steamAppId === 'string' && /^\d+$/.test(steamAppId.trim())
            ? Number(steamAppId.trim())
            : undefined;
      if (
        parsedSteam &&
        parsedSteam > 0 &&
        (resolvedPlatforms.length === 0 || /^steam[:_-]/i.test(gameId))
      ) {
        resolvedPlatforms.push({ platformId: 'steam', platformGameId: String(parsedSteam) });
      }
    }
    const parsedSteamId =
      typeof steamAppId === 'number' && Number.isInteger(steamAppId) && steamAppId > 0
        ? steamAppId
        : typeof steamAppId === 'string' && /^\d+$/.test(steamAppId.trim())
          ? Number(steamAppId.trim())
          : undefined;
    return {
      id: gameId,
      ...(parsedSteamId ? { steamAppId: parsedSteamId } : {}),
      platforms: resolvedPlatforms,
    };
  }, [gameId, steamAppId, gogId, epicAppName, xboxProductId, platforms]);

  const fallbackResolvedTags = useMemo(() => {
    if (tagEntries !== undefined) return null;
    if (!fallbackGameIdentity?.id) {
      const entries: ResolvedGameTag[] = [];
      const seen = new Set<string>();
      for (const raw of tags) {
        const label = sanitizeTagLabel(raw);
        const key = normalizeTagKey(label);
        if (!label || !key || seen.has(key)) continue;
        seen.add(key);
        entries.push({ label, key, source: 'synced' });
      }
      return {
        entries,
        syncedTags: entries.map((e) => e.label),
        hasUserEdits: false,
      };
    }

    const resolvableGame: ResolvableTagGame = {
      id: fallbackGameIdentity.id,
      steamAppId:
        typeof fallbackGameIdentity.steamAppId === 'number'
          ? fallbackGameIdentity.steamAppId
          : undefined,
      platforms: (fallbackGameIdentity.platforms || []).map((p) => ({
        platformId: String(p.platformId || ''),
        platformGameId: p.platformGameId ? String(p.platformGameId) : undefined,
      })),
      tags,
    };
    const resolved = resolveEffectiveGameTags(resolvableGame);
    return {
      entries: resolved.entries,
      syncedTags: resolved.syncedTags,
      hasUserEdits: resolved.hasUserEdits,
    };
  }, [tagEntries, fallbackGameIdentity, tags, localTagRevision]);

  const effectiveEntries = useMemo<ResolvedGameTag[]>(() => {
    if (tagEntries !== undefined) {
      return tagEntries;
    }
    return fallbackResolvedTags?.entries ?? [];
  }, [tagEntries, fallbackResolvedTags]);

  const effectiveHasUserEdits = useMemo<boolean>(() => {
    if (typeof hasUserTagEdits === 'boolean') {
      return hasUserTagEdits;
    }
    return Boolean(fallbackResolvedTags?.hasUserEdits);
  }, [hasUserTagEdits, fallbackResolvedTags]);

  const handleAddTag = useCallback(
    (tag: string) => {
      if (onAddTag) {
        onAddTag(tag);
        return;
      }
      if (fallbackGameIdentity) {
        addUserTagForGame(
          fallbackGameIdentity,
          tag,
          fallbackResolvedTags?.syncedTags ?? tags
        );
        setLocalTagRevision((rev) => rev + 1);
      }
    },
    [onAddTag, fallbackGameIdentity, fallbackResolvedTags, tags]
  );

  const handleRemoveTag = useCallback(
    (tag: string) => {
      if (onRemoveTag) {
        onRemoveTag(tag);
        return;
      }
      if (fallbackGameIdentity) {
        removeUserTagForGame(
          fallbackGameIdentity,
          tag,
          fallbackResolvedTags?.syncedTags ?? tags
        );
        setLocalTagRevision((rev) => rev + 1);
      }
    },
    [onRemoveTag, fallbackGameIdentity, fallbackResolvedTags, tags]
  );

  const handleResetTags = useCallback(() => {
    if (onResetTags) {
      onResetTags();
      return;
    }
    if (fallbackGameIdentity) {
      resetUserTagsForGame(fallbackGameIdentity);
      setLocalTagRevision((rev) => rev + 1);
    }
  }, [onResetTags, fallbackGameIdentity]);

  // Determine Steam review text & color
  const getReviewColor = (desc?: string) => {
    if (!desc) return 'text-[#94a3b8]';
    const d = desc.toLowerCase();
    if (d.includes('positive')) return 'text-[#66C0F4]';
    if (d.includes('mixed')) return 'text-[#e2c28b]';
    if (d.includes('negative')) return 'text-[#f87171]';
    return 'text-[#94a3b8]';
  };

  // Prioritize ALL user-added tags first before slicing synced tags
  const displayEntries = useMemo<ResolvedGameTag[]>(() => {
    const userEntries = effectiveEntries.filter((e) => e.source === 'user');
    const syncedEntries = effectiveEntries.filter((e) => e.source === 'synced');
    const syncedLimit = userEntries.length > 0 ? Math.max(7 - userEntries.length, 3) : 7;
    return [...userEntries, ...syncedEntries.slice(0, syncedLimit)];
  }, [effectiveEntries]);

  const hasRealUserReviews = Boolean(
    reviewSummary &&
      (reviewSummary.totalReviews > 0 ||
        (reviewSummary.positivePercent > 0 &&
          reviewSummary.reviewScoreDesc &&
          !/no user reviews/i.test(reviewSummary.reviewScoreDesc)))
  );

  const ocMeta = openCritic ? getReviewSourceDisplayMeta(openCritic) : null;
  const ocColors = openCritic ? getTierColor(openCritic.tier) : null;

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
        {openCritic && ocMeta && ocColors && (
          <div className="flex items-center" data-critic-source={ocMeta.shortTag}>
            <span className="w-[94px] flex-shrink-0 text-[10px] uppercase text-[#94a3b8] font-normal tracking-wider">
              {`${ocMeta.shortLabel}:`}
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
                aria-label={`${ocMeta.ariaLabel}. Filter library for ${openCritic.tier} games`}
                className={`min-h-6 inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-bold border hover:brightness-125 cursor-pointer ${ocColors.badgeBg} ${ocColors.badgeBorder} ${ocColors.badgeText}`}
                title={`Filter library for ${openCritic.tier} games`}
              >
                {ocMeta.shortTag === 'MCU' && openCritic.userScoreRaw !== undefined
                  ? `${openCritic.userScoreRaw}/10`
                  : ocMeta.isStoreRating && openCritic.starRatingRaw !== undefined
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
                aria-label={`Filter library for ${openCritic.tier} games`}
                className={`min-h-6 inline-flex items-center font-bold hover:underline cursor-pointer ${ocColors.accentText}`}
                title={`Filter library for ${openCritic.tier} games`}
              >
                {openCritic.tier}
              </button>
              {openCritic.url && (
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
                  aria-label={`${ocMeta.externalLinkPrefix} ${title}`}
                  title={`${ocMeta.externalLinkPrefix} ${title}`}
                >
                  <ExternalLink className="w-2.5 h-2.5" aria-hidden="true" />
                </a>
              )}
              {openCritic.percentRecommended !== undefined ? (
                <span className="text-[#94a3b8] font-normal text-[11px]">
                  ({openCritic.percentRecommended}%{' '}
                  {ocMeta.shortTag === 'STM' ? 'positive' : 'rec'})
                </span>
              ) : (
                ocMeta.isStoreRating && (
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
        <div className="flex flex-wrap gap-1 items-center">
          {displayEntries.length > 0 ? (
            displayEntries.map((entry) => (
              <button
                key={entry.key}
                type="button"
                data-tag-source={entry.source}
                onClick={() =>
                  onApplyFilter?.({ type: 'tag', label: 'Tag', value: entry.label })
                }
                className={
                  entry.source === 'user'
                    ? 'inline-flex items-center px-2 min-h-6 text-[11px] border border-[#67c1f5]/50 bg-[rgba(103,193,245,0.28)] hover:bg-[rgba(103,193,245,0.45)] text-[#a8dcfa] hover:text-white rounded-[2px] transition-colors cursor-pointer'
                    : 'inline-flex items-center px-2 min-h-6 text-[11px] bg-[rgba(103,193,245,0.2)] hover:bg-[rgba(103,193,245,0.4)] text-[#67c1f5] hover:text-white rounded-[2px] transition-colors cursor-pointer'
                }
                title={`Filter library by tag "${entry.label}"`}
              >
                {entry.label}
              </button>
            ))
          ) : (
            <span className="text-[11px] text-[#94a3b8] italic mr-1">No tags yet</span>
          )}
          <TagManagerPopover
            gameTitle={title}
            entries={effectiveEntries}
            availableLibraryTags={availableLibraryTags}
            hasUserEdits={effectiveHasUserEdits}
            onAddTag={handleAddTag}
            onRemoveTag={handleRemoveTag}
            onResetTags={
              onResetTags || fallbackGameIdentity ? handleResetTags : undefined
            }
          />
        </div>
      </div>
    </div>
  );
};
