export interface SearchMatchCandidate {
  id: string | number;
  source: 'steam' | 'igdb' | 'gog' | 'epic';
  title: string;
  year?: string | number;
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
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  tags?: string[];
  releaseDate?: string;
}

export interface UserGameOverride {
  gameId: string;
  platformId?: string;
  platformGameId?: string;
  matchedStore: 'steam' | 'gog' | 'epic' | 'igdb' | 'custom';
  matchedId?: string | number;
  title?: string;
  sortTitle?: string;
  steamAppId?: number | null; // null if explicitly unlinked from Steam
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
  updatedAt: string;
}

export type UserGameOverridesMap = Record<string, UserGameOverride>;
