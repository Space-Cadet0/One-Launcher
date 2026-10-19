import type { StorefrontReviewAnchor, CriticScoreData, CriticSource } from './critic';
import type { StorefrontId } from './platform';

export interface ReviewScoreRoute {
  mode: 'routed' | 'static' | 'unrated';
  source?: CriticSource;
  url?: string;
  metacriticSlug?: string;
  openCriticId?: number;
  steamAppId?: number;
  gogId?: string;
  epicId?: string;
  targetTitle?: string;
}

export interface MetadataSourceOption {
  id: string; // e.g. 'steam-1966900', 'gog-12345', 'epic-...', 'igdb-...'
  source: 'steam' | 'gog' | 'epic' | 'igdb' | 'original';
  sourceLabel: string; // e.g. 'Steam Store Metadata', 'GOG.com Metadata', 'Epic Games Store', 'IGDB Metadata'
  matchedId: string | number;
  storeUrl?: string;
  steamAppId?: number;
  gogId?: string;
  epicSlug?: string;
  igdbId?: string | number;
  title: string;
  shortDescription?: string;
  detailedDescription?: string;
  availableDescriptions?: { source: string; text: string }[];
  releaseDate?: string;
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  tags?: string[];
  headerImage?: string;
  capsuleImage?: string;
}

export interface MetadataSourceRoute {
  mode?: 'routed' | 'custom';
  source: 'steam' | 'gog' | 'epic' | 'igdb' | 'original' | 'custom';
  matchedId?: string | number;
  steamAppId?: number;
  gogId?: string;
  epicSlug?: string;
  igdbId?: string | number;
  targetTitle?: string;
  customTitleEdited?: boolean;
  customSynopsisEdited?: boolean;
}

export interface SearchMatchCandidate {
  id: string | number;
  source: 'steam' | 'igdb' | 'gog' | 'epic';
  title: string;
  year?: string | number;
  storeUrl?: string;
  capsuleImage?: string;
  headerImage?: string;
  description?: string;
  steamAppId?: number;
  gogId?: string | number;
  igdbId?: string | number;
  confidenceScore?: number;
}

export interface ScrapedCoverOption {
  url: string;
  source: 'steam' | 'igdb' | 'gog' | 'epic' | 'original';
  label: string;
  dimensions?: string;
}

export interface ScrapedMetadataBundle {
  matchedStore: 'steam' | 'gog' | 'epic' | 'igdb';
  matchedId: string | number;
  title: string;
  sortTitle: string;
  steamAppId?: number | null; // null explicitly means NOT on Steam
  igdbId?: number | string;
  capsuleImage: string;
  availableCovers: ScrapedCoverOption[];
  headerImage?: string;
  iconUrl?: string;
  shortDescription?: string;
  detailedDescription?: string;
  availableDescriptions?: { source: string; text: string }[];
  availableMetadataSources?: MetadataSourceOption[];
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  tags?: string[];
  releaseDate?: string;
  storefrontAnchor?: StorefrontReviewAnchor;
  reviewScoreOverride?: CriticScoreData | null;
  reviewRoute?: ReviewScoreRoute;
  metadataRoute?: MetadataSourceRoute;
}

export interface UserGameOverride {
  gameId: string;
  platformId?: string;
  platformGameId?: string;
  originalSourceTitle?: string;
  originalSourcePlatformId?: StorefrontId;
  splitFromMerged?: boolean;
  isHidden?: boolean;
  matchedStore: 'steam' | 'gog' | 'epic' | 'igdb' | 'custom';
  matchedId?: string | number;
  title?: string;
  sortTitle?: string;
  steamAppId?: number | null; // null if explicitly unlinked from Steam
  isExplicitNonSteam?: boolean;
  igdbId?: number | string;
  capsuleImage?: string;
  headerImage?: string;
  iconUrl?: string;
  shortDescription?: string;
  detailedDescription?: string;
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  tags?: string[];
  releaseDate?: string;
  storefrontAnchor?: StorefrontReviewAnchor;
  reviewScoreOverride?: CriticScoreData | null;
  reviewRoute?: ReviewScoreRoute;
  metadataRoute?: MetadataSourceRoute;
  updatedAt: string;
}

export type UserGameOverridesMap = Record<string, UserGameOverride>;

