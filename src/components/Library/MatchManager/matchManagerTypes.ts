import { CanonicalGame } from '../../../contracts/game';
import { UserGameOverride } from '../../../contracts/override';
import { StorefrontId } from '../../../contracts/platform';
import { SuppressedCatalogEntry } from '../../../services/integrations/catalogSanitizer';

export interface LibraryMatchManagerModalProps {
  isOpen: boolean;
  games: CanonicalGame[];
  initialTab?: FilterTab;
  onClose: () => void;
  onFixMatchForGame: (game: CanonicalGame) => void;
  onResetOverride?: (gameId: string) => void;
  onResetOverrideForGame?: (gameId: string) => void;
  onInspectGame?: (game: CanonicalGame) => void;
  onSelectGame?: (game: CanonicalGame) => void;
  onHideGame?: (game: CanonicalGame, targetPlatformId?: StorefrontId) => void;
  onUnhideEntry?: (entry: SuppressedCatalogEntry) => void;
  onGameUpdated?: (game: CanonicalGame) => void;
  onGamesBatchUpdated?: (updatedGames: CanonicalGame[]) => void;
  isSuspended?: boolean;
}

export type FilterTab =
  | 'needs_attention'
  | 'user_suppressed'
  | 'suppressed'
  | 'overrides'
  | 'merged';

export type UnmatchedSubFilter = 'all' | 'artwork' | 'synopsis' | 'dev_year';
export type AutoFilteredSubFilter = 'all' | 'beta' | 'prologue' | 'tool' | 'soundtrack' | 'dlc';

export type MatchStudioSectionKey =
  | 'unmatched'
  | 'low_confidence'
  | 'user_suppressed'
  | 'suppressed'
  | 'confirmed_suppressed'
  | 'overrides'
  | 'merged';

export type UnmatchedReasonCode =
  | 'missing_all_art'
  | 'missing_vertical_cover'
  | 'unresolved_codename'
  | 'missing_synopsis'
  | 'missing_dev_year';

export interface UnmatchedDiagnosticReason {
  code: UnmatchedReasonCode;
  label: string;
  tooltip: string;
  colorClass: string;
}

export interface GogCachedMetadataEntry {
  shortDescription?: string;
  description?: string;
  aboutTheGame?: string;
  detailedDescription?: string;
}

export interface UnmatchedSubCounts {
  all: number;
  artwork: number;
  synopsis: number;
  dev_year: number;
}

export interface AutoFilteredSubCounts {
  all: number;
  beta: number;
  prologue: number;
  tool: number;
  soundtrack: number;
  dlc: number;
}

export type MatchManagerFlatRow =
  | {
      kind: 'section-header';
      key: string;
      sectionKey: MatchStudioSectionKey;
      isFirstSection: boolean;
      expanded: boolean;
      title: string;
      badgeText: string;
      badgeClassName: string;
      accentIconKind: MatchStudioSectionKey;
      subtitle: string;
    }
  | {
      kind: 'unmatched-subtoolbar';
      key: string;
    }
  | {
      kind: 'suppressed-subtoolbar';
      key: string;
    }
  | {
      kind: 'empty-notice';
      key: string;
      showCheckIcon: boolean;
      message: string;
    }
  | {
      kind: 'unmatched-row';
      key: string;
      game: CanonicalGame;
      reasons: UnmatchedDiagnosticReason[];
      isFirstItem: boolean;
      isLastInSection: boolean;
    }
  | {
      kind: 'low-confidence-row';
      key: string;
      game: CanonicalGame;
      isFirstItem: boolean;
      isLastInSection: boolean;
    }
  | {
      kind: 'user-suppressed-row';
      key: string;
      entry: SuppressedCatalogEntry;
      isFirstItem: boolean;
      isLastInSection: boolean;
    }
  | {
      kind: 'pending-suppressed-row';
      key: string;
      entry: SuppressedCatalogEntry;
      isFirstItem: boolean;
      isLastInSection: boolean;
    }
  | {
      kind: 'confirmed-suppressed-row';
      key: string;
      entry: SuppressedCatalogEntry;
      isFirstItem: boolean;
      isLastInSection: boolean;
    }
  | {
      kind: 'override-row';
      key: string;
      override: UserGameOverride;
      matchedGame?: CanonicalGame;
      isFirstItem: boolean;
      isLastInSection: boolean;
    }
  | {
      kind: 'merged-row';
      key: string;
      game: CanonicalGame;
      isFirstItem: boolean;
      isLastInSection: boolean;
    };

export function estimateMatchManagerRowSize(row: MatchManagerFlatRow): number {
  switch (row.kind) {
    case 'section-header':
      return row.isFirstSection ? 48 : 68;
    case 'unmatched-subtoolbar':
      return 52;
    case 'suppressed-subtoolbar':
      return 64;
    case 'empty-notice':
      return 84;
    case 'override-row':
      return 104;
    case 'merged-row':
      return 72;
    case 'unmatched-row':
    case 'low-confidence-row':
    case 'user-suppressed-row':
    case 'pending-suppressed-row':
    case 'confirmed-suppressed-row':
    default:
      return 84;
  }
}
