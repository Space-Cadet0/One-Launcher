export interface EpicCodenameMapping {
  title: string;
  steamAppId?: number;
  developer?: string;
  description?: string;
  headerImage?: string;
  capsuleImage?: string;
  iconUrl?: string;
}

export const KNOWN_EPIC_APP_NAMES: Record<string, EpicCodenameMapping> = {};
