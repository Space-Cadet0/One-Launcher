export interface SteamScreenshot {
  id: number;
  pathThumbnail: string;
  pathFull: string;
}

export interface SteamMovie {
  id: number;
  name: string;
  thumbnail: string;
  hls?: string;
  webm?: {
    480?: string;
    max?: string;
  };
  mp4?: {
    480?: string;
    max?: string;
  };
}

export interface SteamReviewSummary {
  reviewScore: number;
  reviewScoreDesc: string;
  totalPositive: number;
  totalNegative: number;
  totalReviews: number;
  positivePercent: number;
}

export interface SteamSystemRequirements {
  minimum?: string;
  recommended?: string;
}

export interface SteamCategory {
  id: number;
  description: string;
  icon?: string;
}

export type LanguageTableSchema = 'steam' | 'audio_text';

export interface SteamLanguageOption {
  name: string;
  hasInterface: boolean;
  hasAudio: boolean;
  hasSubtitles: boolean;
}

export interface SteamEnrichedMetadata {
  appId: number;
  name: string;
  shortDescription: string;
  detailedDescription: string;
  aboutTheGame: string;
  headerImage: string;
  capsuleImage?: string;
  iconUrl?: string;
  developers: string[];
  publishers: string[];
  releaseDate: string;
  genres: string[];
  tags: string[];
  categories: SteamCategory[];
  screenshots: SteamScreenshot[];
  movies: SteamMovie[];
  systemRequirements: SteamSystemRequirements;
  reviewSummary: SteamReviewSummary;
  supportedLanguages?: string;
  languageOptions?: SteamLanguageOption[];
  languageTableSchema?: LanguageTableSchema;
  legalNotice?: string;
  drmNotice?: string;
  controllerSupport?: string;
  pcRequirementsHtml?: string;
  achievements?: {
    total: number;
    highlighted?: Array<{
      name: string;
      path: string;
    }>;
  };
  metacritic?: {
    score: number;
    url: string;
  };
  platforms?: {
    windows?: boolean;
    mac?: boolean;
    linux?: boolean;
  };
}

