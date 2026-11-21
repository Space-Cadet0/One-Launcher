import { CanonicalGame } from '../../../contracts/game';
import { UserGameOverride } from '../../../contracts/override';
import { SuppressedCatalogEntry } from '../../../services/integrations/catalogSanitizer';
import { MatchManagerFlatRow, UnmatchedDiagnosticReason } from './matchManagerTypes';

export interface BuildMatchManagerFlatRowsParams {
  showUnmatched: boolean;
  showLowConfidence: boolean;
  showUserSuppressed: boolean;
  showSuppressed: boolean;
  showOverrides: boolean;
  showMerged: boolean;
  expandedSections: Record<string, boolean>;
  unmatchedGames: CanonicalGame[];
  filteredUnmatchedItems: Array<{ game: CanonicalGame; reasons: UnmatchedDiagnosticReason[] }>;
  lowConfidenceGames: CanonicalGame[];
  userSuppressedEntries: SuppressedCatalogEntry[];
  unreviewedAutoFilteredEntries: SuppressedCatalogEntry[];
  filteredAutoFilteredEntries: SuppressedCatalogEntry[];
  confirmedAutoFilteredEntries: SuppressedCatalogEntry[];
  overrideItems: Array<{ override: UserGameOverride; matchedGame?: CanonicalGame }>;
  mergedGames: CanonicalGame[];
}

export function buildMatchManagerFlatRows(
  params: BuildMatchManagerFlatRowsParams
): MatchManagerFlatRow[] {
  const rows: MatchManagerFlatRow[] = [];
  let hasEmittedSection = false;
  const nextFirstSectionFlag = () => {
    const first = !hasEmittedSection;
    hasEmittedSection = true;
    return first;
  };

  if (params.showUnmatched) {
    const expanded = Boolean(params.expandedSections.unmatched);
    rows.push({
      kind: 'section-header',
      key: 'hdr-unmatched',
      sectionKey: 'unmatched',
      isFirstSection: nextFirstSectionFlag(),
      expanded,
      title: 'Unmatched Games',
      badgeText: String(params.unmatchedGames.length),
      badgeClassName: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
      accentIconKind: 'unmatched',
      subtitle: 'Games missing cover artwork or canonical storefront identity',
    });

    if (expanded) {
      if (params.unmatchedGames.length > 0) {
        rows.push({ kind: 'unmatched-subtoolbar', key: 'sub-unmatched' });
      }
      if (params.filteredUnmatchedItems.length === 0) {
        rows.push({
          kind: 'empty-notice',
          key: 'empty-unmatched',
          showCheckIcon: true,
          message:
            params.unmatchedGames.length === 0
              ? 'All active library games have cover artwork and canonical storefront identity!'
              : 'No unmatched games match this specific reason filter.',
        });
      } else {
        params.filteredUnmatchedItems.forEach(({ game, reasons }, idx) => {
          rows.push({
            kind: 'unmatched-row',
            key: `unmatched-${game.id}`,
            game,
            reasons,
            isFirstItem: idx === 0 && params.unmatchedGames.length === 0,
            isLastInSection: idx === params.filteredUnmatchedItems.length - 1,
          });
        });
      }
    }
  }

  if (params.showLowConfidence) {
    const expanded = Boolean(params.expandedSections.low_confidence);
    rows.push({
      kind: 'section-header',
      key: 'hdr-low-confidence',
      sectionKey: 'low_confidence',
      isFirstSection: nextFirstSectionFlag(),
      expanded,
      title: 'Low-Confidence Automatic Matches',
      badgeText: String(params.lowConfidenceGames.length),
      badgeClassName: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
      accentIconKind: 'low_confidence',
      subtitle: 'Heuristic matches or title shifts that may benefit from manual verification',
    });

    if (expanded) {
      if (params.lowConfidenceGames.length === 0) {
        rows.push({
          kind: 'empty-notice',
          key: 'empty-low-confidence',
          showCheckIcon: true,
          message: 'No low-confidence automatic matches requiring verification!',
        });
      } else {
        params.lowConfidenceGames.forEach((game, idx) => {
          rows.push({
            kind: 'low-confidence-row',
            key: `lowconf-${game.id}`,
            game,
            isFirstItem: idx === 0,
            isLastInSection: idx === params.lowConfidenceGames.length - 1,
          });
        });
      }
    }
  }

  if (params.showUserSuppressed) {
    const expanded = Boolean(params.expandedSections.user_suppressed);
    rows.push({
      kind: 'section-header',
      key: 'hdr-user-suppressed',
      sectionKey: 'user_suppressed',
      isFirstSection: nextFirstSectionFlag(),
      expanded,
      title: 'User-Suppressed Titles',
      badgeText: String(params.userSuppressedEntries.length),
      badgeClassName: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40',
      accentIconKind: 'user_suppressed',
      subtitle: 'Games and storefront entries you manually chose to hide from your library',
    });

    if (expanded) {
      if (params.userSuppressedEntries.length === 0) {
        rows.push({
          kind: 'empty-notice',
          key: 'empty-user-suppressed',
          showCheckIcon: false,
          message:
            'No user-suppressed titles found. Right-click any game card or use the game menu to suppress titles you want hidden.',
        });
      } else {
        params.userSuppressedEntries.forEach((entry, idx) => {
          rows.push({
            kind: 'user-suppressed-row',
            key: `usersupp-${entry.id}`,
            entry,
            isFirstItem: idx === 0,
            isLastInSection: idx === params.userSuppressedEntries.length - 1,
          });
        });
      }
    }
  }

  if (params.showSuppressed) {
    const expandedPending = Boolean(params.expandedSections.suppressed);
    rows.push({
      kind: 'section-header',
      key: 'hdr-suppressed-pending',
      sectionKey: 'suppressed',
      isFirstSection: nextFirstSectionFlag(),
      expanded: expandedPending,
      title: 'Suppressed & Filtered Storefront Entries',
      badgeText: `${params.unreviewedAutoFilteredEntries.length} Pending Review`,
      badgeClassName: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
      accentIconKind: 'suppressed',
      subtitle:
        'New & unreviewed auto-filtered betas, prologues, tools/SDKs, soundtracks, and DLCs — confirm items you agree should stay suppressed',
    });

    if (expandedPending) {
      rows.push({ kind: 'suppressed-subtoolbar', key: 'sub-suppressed' });
      if (params.filteredAutoFilteredEntries.length === 0) {
        rows.push({
          kind: 'empty-notice',
          key: 'empty-suppressed-pending',
          showCheckIcon: true,
          message:
            params.unreviewedAutoFilteredEntries.length === 0 &&
            params.confirmedAutoFilteredEntries.length > 0
              ? 'All auto-filtered storefront entries have been reviewed and confirmed! Any newly discovered non-game entries on future library syncs will appear here for review.'
              : 'No auto-filtered storefront entries found matching your filter.',
        });
      } else {
        params.filteredAutoFilteredEntries.forEach((entry, idx) => {
          rows.push({
            kind: 'pending-suppressed-row',
            key: `pendsupp-${entry.id}`,
            entry,
            isFirstItem: idx === 0,
            isLastInSection: idx === params.filteredAutoFilteredEntries.length - 1,
          });
        });
      }
    }

    const expandedConfirmed = Boolean(params.expandedSections.confirmed_suppressed);
    rows.push({
      kind: 'section-header',
      key: 'hdr-suppressed-confirmed',
      sectionKey: 'confirmed_suppressed',
      isFirstSection: nextFirstSectionFlag(),
      expanded: expandedConfirmed,
      title: 'Reviewed & Confirmed Non-Games',
      badgeText: `${params.confirmedAutoFilteredEntries.length} Confirmed`,
      badgeClassName: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
      accentIconKind: 'confirmed_suppressed',
      subtitle:
        'Auto-filtered storefront entries you have reviewed and confirmed to keep suppressed',
    });

    if (expandedConfirmed) {
      if (params.confirmedAutoFilteredEntries.length === 0) {
        rows.push({
          kind: 'empty-notice',
          key: 'empty-suppressed-confirmed',
          showCheckIcon: false,
          message:
            "No confirmed non-game entries yet. Confirm items above once you've verified they should stay suppressed — future library syncs will only show newly added unreviewed items in Pending Review.",
        });
      } else {
        params.confirmedAutoFilteredEntries.forEach((entry, idx) => {
          rows.push({
            kind: 'confirmed-suppressed-row',
            key: `confsupp-${entry.id}`,
            entry,
            isFirstItem: idx === 0,
            isLastInSection: idx === params.confirmedAutoFilteredEntries.length - 1,
          });
        });
      }
    }
  }

  if (params.showOverrides) {
    const expanded = Boolean(params.expandedSections.overrides);
    rows.push({
      kind: 'section-header',
      key: 'hdr-overrides',
      sectionKey: 'overrides',
      isFirstSection: nextFirstSectionFlag(),
      expanded,
      title: 'Manual Matching Overrides (Source → Target)',
      badgeText: String(params.overrideItems.length),
      badgeClassName: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
      accentIconKind: 'overrides',
      subtitle:
        'User-configured metadata routes, split entries, custom cover art, and review score overrides',
    });

    if (expanded) {
      if (params.overrideItems.length === 0) {
        rows.push({
          kind: 'empty-notice',
          key: 'empty-overrides',
          showCheckIcon: false,
          message: 'No manual matching overrides have been configured yet.',
        });
      } else {
        params.overrideItems.forEach(({ override, matchedGame }, idx) => {
          rows.push({
            kind: 'override-row',
            key: `override-${override.gameId}`,
            override,
            matchedGame,
            isFirstItem: idx === 0,
            isLastInSection: idx === params.overrideItems.length - 1,
          });
        });
      }
    }
  }

  if (params.showMerged) {
    const expanded = Boolean(params.expandedSections.merged);
    rows.push({
      kind: 'section-header',
      key: 'hdr-merged',
      sectionKey: 'merged',
      isFirstSection: nextFirstSectionFlag(),
      expanded,
      title: 'Merged Multi-Storefront Listings',
      badgeText: String(params.mergedGames.length),
      badgeClassName: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
      accentIconKind: 'merged',
      subtitle: 'Fix, split, or hide individual storefront entries inside merged canonical listings',
    });

    if (expanded) {
      if (params.mergedGames.length === 0) {
        rows.push({
          kind: 'empty-notice',
          key: 'empty-merged',
          showCheckIcon: false,
          message: 'No multi-storefront merged games found matching your filter.',
        });
      } else {
        params.mergedGames.forEach((game, idx) => {
          rows.push({
            kind: 'merged-row',
            key: `merged-${game.id}`,
            game,
            isFirstItem: idx === 0,
            isLastInSection: idx === params.mergedGames.length - 1,
          });
        });
      }
    }
  }

  return rows;
}
