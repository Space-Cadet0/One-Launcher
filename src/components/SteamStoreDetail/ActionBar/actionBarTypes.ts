import { CanonicalGame } from '../../../contracts/game';
import { SteamEnrichedMetadata } from '../../../contracts/steam';
import { CriticScoreData } from '../../../contracts/critic';
import { StorefrontId } from '../../../contracts/platform';
import { ActiveGameFilter } from '../../../contracts/filter';
import { GameCollection } from '../../../contracts/collection';

export interface PlatformAchievementSummary {
  platformId: StorefrontId;
  platformName: string;
  unlocked: number;
  total: number;
  percentage: number;
  gamerscore?: { earned: number; total: number };
  xp?: { earned: number; total: number };
  isMastered: boolean;
  hasConflict?: boolean;
  conflictDetails?: string;
}

export interface SteamLibraryActionBarProps {
  game: CanonicalGame;
  metadata?: SteamEnrichedMetadata | null;
  openCriticData?: CriticScoreData | null;
  collections?: GameCollection[];
  onManageCollections?: () => void;
  onToggleInstallStatus?: (platformId?: StorefrontId) => void;
  onApplyFilter?: (filter: ActiveGameFilter) => void;
  connectedStorefronts?: StorefrontId[];
  onFixMatch?: () => void;
  onHideGame?: (game: CanonicalGame, targetPlatformId?: StorefrontId) => void;
  onViewAchievements?: (storefrontId?: StorefrontId) => void;
  onSelectedPlatformChange?: (platformId: StorefrontId) => void;
}

export function resolvePublisherHandoffLabel(
  handoffKey?: string | null,
  explicitName?: string | null
): string {
  if (explicitName && explicitName.trim()) return explicitName.trim();
  const norm = String(handoffKey || '').trim().toLowerCase();
  if (norm === 'ubisoft') return 'Ubisoft Connect';
  if (norm === 'ea') return 'EA App';
  if (norm === 'bnet') return 'Battle.net';
  if (norm === 'rockstar') return 'Rockstar Games Launcher';
  if (norm === 'riot') return 'Riot Client';
  return norm ? norm.toUpperCase() : 'Publisher Launcher';
}
