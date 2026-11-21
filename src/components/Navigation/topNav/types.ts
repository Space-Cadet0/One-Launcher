import type { CanonicalGame } from '../../../contracts/game';
import type { StorefrontId } from '../../../contracts/platform';

export type TopMenuId = 'file' | 'edit' | 'view' | 'window';

export const TOP_MENU_ORDER: readonly TopMenuId[] = ['file', 'edit', 'view', 'window'];

export const ALL_NAV_PLATFORMS: readonly StorefrontId[] = [
  'steam',
  'gog',
  'epic',
  'xbox',
  'amazon',
  'ubisoft',
  'ea',
  'bnet',
  'itch',
];

export interface TopNavBarProps {
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  selectedPlatform: StorefrontId | 'all';
  onSelectPlatform: (platform: StorefrontId | 'all') => void;
  installedOnly: boolean;
  onToggleInstalledOnly: () => void;
  totalGamesCount: number;
  filteredCount: number;
  isSyncing: boolean;
  onTriggerSync: () => void;
  onHomeClick?: () => void;
  onOpenIntegrations: () => void;
  canGoBack?: boolean;
  onGoBack?: () => void;
  backTitle?: string | null;
  canGoForward?: boolean;
  onGoForward?: () => void;
  forwardTitle?: string | null;
  connectedStorefronts?: StorefrontId[];
  presentStorefronts?: readonly StorefrontId[];
  games?: CanonicalGame[];
  currentGameTitle?: string;
  canSyncCurrentGame?: boolean;
  isSyncingCurrentGame?: boolean;
  onSyncCurrentGame?: () => void;
  isSyncingAllMedia?: boolean;
  onSyncAllMedia?: () => void;
  isSyncingScores?: boolean;
  onRefreshScores?: () => void;
  isSyncingTrophies?: boolean;
  onSyncTrophies?: () => void;
  onOpenFixMatch?: () => void;
  onOpenLibraryMatchManager?: () => void;
  onOpenSystemSetup?: () => void;
  onOpenSettings?: () => void;
  systemSetupAlertCount?: number;
  defaultMenuOpen?: boolean;
  onOpenAchievements?: () => void;
  onOpenDownloads?: () => void;
}

export interface MenuKeyboardNavOptions {
  onEscape?: () => void;
  onArrowHorizontal?: (direction: 1 | -1) => void;
  onTabOut?: () => void;
}
