import React from 'react';
import { CanonicalGame } from '../../../contracts/game';
import {
  MetadataSourceOption,
  MetadataSourceRoute,
  ScrapedMetadataBundle,
  UserGameOverride,
} from '../../../contracts/override';
import { isXboxStoreCandidateId } from '../../../services/scraper/metadataScraperService';

export type WizardStep = 1 | 2 | 3 | 4;
export type SourceFilterTab = 'All' | 'Steam' | 'IGDB' | 'GOG' | 'Epic' | 'Xbox';

export const SOURCE_FILTER_TABS: readonly SourceFilterTab[] = [
  'All',
  'Steam',
  'IGDB',
  'GOG',
  'Epic',
  'Xbox',
];

export interface GameWithSplitContext {
  isSplittingFromMerged?: boolean;
}

export function isGameSplittingFromMerged(
  game: CanonicalGame | null | undefined,
  existingOverride?: UserGameOverride
): boolean {
  return Boolean(
    (game as (CanonicalGame & GameWithSplitContext) | null | undefined)?.isSplittingFromMerged ||
      existingOverride?.splitFromMerged
  );
}

/**
 * Formats a match confidence score into a clean percentage string (0% - 100%).
 * Safely handles both normalized 0..1 floating point scores and 0..100 integer scores.
 */
export function formatMatchPercentage(score?: number): string | null {
  if (score === undefined || score === null || isNaN(score) || score <= 0) return null;
  const raw = score <= 1.0 ? score * 100 : score;
  const clamped = Math.min(100, Math.max(0, Math.round(raw)));
  return `${clamped}% Match`;
}

export function openExternalStoreUrl(url?: string, e?: React.MouseEvent): void {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  if (!url) return;
  if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
    void window.electronAPI.openExternal(url);
  } else if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export function resolveWizardMatchedStore(
  scrapedBundle: ScrapedMetadataBundle
): UserGameOverride['matchedStore'] {
  if (isXboxStoreCandidateId(scrapedBundle.matchedId)) {
    return 'custom';
  }
  const store = String(scrapedBundle.matchedStore);
  if (store === 'steam' || store === 'gog' || store === 'epic' || store === 'igdb') {
    return store;
  }
  return 'custom';
}

export function resolveWizardMetadataRouteSource(
  activeMetaOpt: MetadataSourceOption | undefined,
  scrapedBundle: ScrapedMetadataBundle
): MetadataSourceRoute['source'] {
  const isXboxMatchedBundle = isXboxStoreCandidateId(scrapedBundle.matchedId);
  const isXboxMetaOpt = activeMetaOpt
    ? isXboxStoreCandidateId(activeMetaOpt.id, activeMetaOpt.storeUrl)
    : isXboxMatchedBundle;
  if (isXboxMetaOpt) {
    return 'custom';
  }
  const activeSource = String(activeMetaOpt?.source || scrapedBundle.matchedStore);
  if (
    activeSource === 'steam' ||
    activeSource === 'gog' ||
    activeSource === 'epic' ||
    activeSource === 'igdb' ||
    activeSource === 'original'
  ) {
    return activeSource;
  }
  return 'custom';
}
