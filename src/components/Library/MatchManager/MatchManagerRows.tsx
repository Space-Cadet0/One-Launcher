import React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Layers,
  RotateCcw,
  ShieldAlert,
  Wand,
} from 'lucide-react';
import { CanonicalGame } from '../../../contracts/game';
import { UserGameOverride } from '../../../contracts/override';
import { StorefrontId } from '../../../contracts/platform';
import { SuppressedCatalogEntry } from '../../../services/integrations/catalogSanitizer';
import { launcherService } from '../../../services/launcher/launcherService';
import {
  confirmMultipleNonGameStorefrontEntries,
  confirmNonGameStorefrontEntry,
  unconfirmNonGameStorefrontEntry,
} from '../../../services/storage/userOverrideStorage';
import { StorefrontIcon, getStorefrontDisplayName } from '../../Common/StorefrontIcon';
import {
  formatSuppressionBadge,
  resolveOverrideTargetStoreDetails,
} from './matchManagerDiagnostics';
import {
  AutoFilteredSubCounts,
  AutoFilteredSubFilter,
  MatchManagerFlatRow,
  MatchStudioSectionKey,
  UnmatchedDiagnosticReason,
  UnmatchedSubCounts,
  UnmatchedSubFilter,
} from './matchManagerTypes';

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

export interface MatchManagerRowRenderContext {
  toggleSection: (key: MatchStudioSectionKey) => void;
  unmatchedSubFilter: UnmatchedSubFilter;
  setUnmatchedSubFilter: (filter: UnmatchedSubFilter) => void;
  unmatchedSubCounts: UnmatchedSubCounts;
  autoFilteredSubFilter: AutoFilteredSubFilter;
  setAutoFilteredSubFilter: (filter: AutoFilteredSubFilter) => void;
  autoFilteredSubCounts: AutoFilteredSubCounts;
  filteredAutoFilteredEntries: SuppressedCatalogEntry[];
  selectedVisibleEntries: SuppressedCatalogEntry[];
  selectedNonGameIds: Set<string>;
  setSelectedNonGameIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  handleInspect?: (game: CanonicalGame) => void;
  handleReset?: (gameId: string) => void;
  onFixMatchForGame: (game: CanonicalGame) => void;
  onHideGame?: (game: CanonicalGame, targetPlatformId?: StorefrontId) => void;
  onUnhideEntry?: (entry: SuppressedCatalogEntry) => void;
  onClose: () => void;
  handleOpenExternalUrl: (url?: string) => void;
}

interface EntitlementOsBadge {
  label: 'macOS Native' | 'Bottled (Wine/CrossOver)' | 'Windows Native';
  className: string;
  title: string;
}

function getHostPlatform(): 'darwin' | 'win32' | 'other' {
  if (typeof window !== 'undefined' && window.electronAPI?.platform) {
    const p = window.electronAPI.platform;
    if (p === 'darwin') return 'darwin';
    if (p === 'win32') return 'win32';
  }
  if (typeof navigator !== 'undefined') {
    const ua = `${navigator.platform || ''} ${navigator.userAgent || ''}`;
    if (/Mac/i.test(ua)) return 'darwin';
    if (/Win/i.test(ua)) return 'win32';
  }
  if (typeof process !== 'undefined' && process.platform) {
    if (process.platform === 'darwin') return 'darwin';
    if (process.platform === 'win32') return 'win32';
  }
  return 'other';
}

function resolveEntitlementOsBadge(
  game: CanonicalGame,
  p: CanonicalGame['platforms'][number],
  installedRec: ReturnType<typeof launcherService.getInstalledRecordForGame>,
  isPlatInstalled: boolean
): EntitlementOsBadge | null {
  const host = getHostPlatform();
  const osSupport = (
    game as CanonicalGame & {
      osSupport?: { mac?: boolean; windows?: boolean; linux?: boolean };
    }
  ).osSupport;

  if (host === 'darwin') {
    const explicitWinOnMac = installedRec?.isWindowsBinaryOnMac ?? p.isWindowsBinaryOnMac;
    if (explicitWinOnMac === true) {
      return {
        label: 'Bottled (Wine/CrossOver)',
        className: 'bg-amber-950/70 border-amber-500/40 text-amber-300',
        title: 'Windows binary running on macOS via CrossOver / Wine / GPTK bottle',
      };
    }
    if (explicitWinOnMac === false) {
      return {
        label: 'macOS Native',
        className: 'bg-emerald-950/70 border-emerald-500/40 text-emerald-300',
        title: 'Native macOS build',
      };
    }

    const execOrInstallPath =
      installedRec?.executablePath ||
      p.executablePath ||
      installedRec?.installPath ||
      p.installPath ||
      '';
    if (
      execOrInstallPath &&
      (/\.exe$/i.test(execOrInstallPath) ||
        /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(execOrInstallPath))
    ) {
      return {
        label: 'Bottled (Wine/CrossOver)',
        className: 'bg-amber-950/70 border-amber-500/40 text-amber-300',
        title: 'Windows binary running on macOS via CrossOver / Wine / GPTK bottle',
      };
    }
    if (execOrInstallPath && /\.app(?:[\\/]|$)/i.test(execOrInstallPath)) {
      return {
        label: 'macOS Native',
        className: 'bg-emerald-950/70 border-emerald-500/40 text-emerald-300',
        title: 'Native macOS application bundle',
      };
    }

    const hasMacSupport = Boolean(
      p.platforms?.mac ??
        osSupport?.mac ??
        game.nativePlatforms?.includes('mac') ??
        game.worksOn?.mac ??
        game.worksOn?.Mac ??
        game.platforms_os?.mac
    );
    const hasWinSupport = Boolean(
      p.platforms?.windows ??
        osSupport?.windows ??
        game.nativePlatforms?.includes('windows') ??
        game.worksOn?.windows ??
        game.worksOn?.Windows ??
        game.platforms_os?.windows
    );

    if (isPlatInstalled) {
      if (p.platformId === 'xbox' || (!hasMacSupport && hasWinSupport)) {
        return {
          label: 'Bottled (Wine/CrossOver)',
          className: 'bg-amber-950/70 border-amber-500/40 text-amber-300',
          title: 'Windows build installed on macOS (CrossOver / Wine / GPTK)',
        };
      }
      return {
        label: 'macOS Native',
        className: 'bg-emerald-950/70 border-emerald-500/40 text-emerald-300',
        title: 'Installed on macOS',
      };
    }

    if (p.platforms?.mac === true || (hasMacSupport && p.platformId !== 'xbox')) {
      return {
        label: 'macOS Native',
        className: 'bg-emerald-950/50 border-emerald-500/30 text-emerald-300',
        title: 'Supports macOS Native delivery on this storefront',
      };
    }
    if (p.platforms?.windows === true || hasWinSupport) {
      return {
        label: 'Bottled (Wine/CrossOver)',
        className: 'bg-amber-950/50 border-amber-500/30 text-amber-300',
        title: 'Windows-only storefront build (runs via Wine / CrossOver on macOS)',
      };
    }
  } else if (host === 'win32') {
    if (isPlatInstalled) {
      return {
        label: 'Windows Native',
        className: 'bg-sky-950/70 border-sky-500/40 text-sky-300',
        title: 'Installed Windows Native build',
      };
    }
  }

  return null;
}

function renderSectionAccentIcons(
  kind: MatchStudioSectionKey,
  expanded: boolean
): React.ReactNode {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  switch (kind) {
    case 'unmatched':
      return (
        <>
          <Chevron aria-hidden="true" className="w-4 h-4 text-amber-400" />
          <AlertTriangle aria-hidden="true" className="w-4 h-4 text-amber-400" />
        </>
      );
    case 'low_confidence':
      return (
        <>
          <Chevron aria-hidden="true" className="w-4 h-4 text-orange-400" />
          <ShieldAlert aria-hidden="true" className="w-4 h-4 text-orange-400" />
        </>
      );
    case 'user_suppressed':
      return (
        <>
          <Chevron aria-hidden="true" className="w-4 h-4 text-indigo-400" />
          <EyeOff aria-hidden="true" className="w-4 h-4 text-indigo-400" />
        </>
      );
    case 'suppressed':
      return (
        <>
          <Chevron aria-hidden="true" className="w-4 h-4 text-rose-400" />
          <EyeOff aria-hidden="true" className="w-4 h-4 text-rose-400" />
        </>
      );
    case 'confirmed_suppressed':
      return (
        <>
          <Chevron aria-hidden="true" className="w-4 h-4 text-emerald-400" />
          <CheckCircle2 aria-hidden="true" className="w-4 h-4 text-emerald-400" />
        </>
      );
    case 'overrides':
      return (
        <>
          <Chevron aria-hidden="true" className="w-4 h-4 text-[#66c0f4]" />
          <Wand aria-hidden="true" className="w-4 h-4 text-[#66c0f4]" />
        </>
      );
    case 'merged':
      return (
        <>
          <Chevron aria-hidden="true" className="w-4 h-4 text-emerald-400" />
          <Layers aria-hidden="true" className="w-4 h-4 text-emerald-400" />
        </>
      );
  }
}

export function renderMatchManagerFlatRow(
  row: MatchManagerFlatRow,
  ctx: MatchManagerRowRenderContext,
  isSelectedOverride?: boolean
): React.ReactNode {
  switch (row.kind) {
    case 'section-header': {
      return (
        <div
          key={row.key}
          className={`${row.isFirstSection ? '' : 'mt-5 '}border border-[#2a475e]/80 ${
            row.expanded ? 'rounded-t-lg' : 'rounded-lg'
          } overflow-hidden bg-[#131c27]/70`}
        >
          <h3 className="m-0 text-base font-normal leading-normal">
            <button
              type="button"
              aria-expanded={row.expanded}
              onClick={() => ctx.toggleSection(row.sectionKey)}
              className="min-h-6 w-full px-4 py-3 bg-[#1b2838]/90 hover:bg-[#1b2838] flex items-center justify-between text-left transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2.5 flex-wrap">
                {renderSectionAccentIcons(row.accentIconKind, row.expanded)}
                <span className="text-xs font-bold uppercase tracking-wider text-white">
                  {row.title}
                </span>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${row.badgeClassName}`}
                >
                  {row.badgeText}
                </span>
              </div>
              <span className="text-[11px] text-slate-300 hidden sm:inline">{row.subtitle}</span>
            </button>
          </h3>
        </div>
      );
    }

    case 'unmatched-subtoolbar': {
      return (
        <div
          key={row.key}
          className="px-4 pt-3 pb-2.5 border-x border-b border-x-[#2a475e]/80 border-b-[#2a475e]/50 bg-[#131c27]/70 flex items-center gap-1.5 flex-wrap"
        >
          <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-300 mr-1">
            Filter by Reason:
          </span>
          <button
            type="button"
            aria-pressed={ctx.unmatchedSubFilter === 'all'}
            onClick={() => ctx.setUnmatchedSubFilter('all')}
            className={`min-h-6 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors cursor-pointer ${
              ctx.unmatchedSubFilter === 'all'
                ? 'bg-amber-400 text-slate-950 shadow'
                : 'bg-[#1b2838] text-slate-200 hover:text-white border border-[#2a475e]'
            }`}
          >
            All ({ctx.unmatchedSubCounts.all})
          </button>
          <button
            type="button"
            aria-pressed={ctx.unmatchedSubFilter === 'artwork'}
            onClick={() => ctx.setUnmatchedSubFilter('artwork')}
            className={`min-h-6 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors cursor-pointer ${
              ctx.unmatchedSubFilter === 'artwork'
                ? 'bg-rose-400 text-slate-950 shadow'
                : 'bg-[#1b2838] text-slate-200 hover:text-white border border-[#2a475e]'
            }`}
          >
            Missing Artwork ({ctx.unmatchedSubCounts.artwork})
          </button>
          <button
            type="button"
            aria-pressed={ctx.unmatchedSubFilter === 'synopsis'}
            onClick={() => ctx.setUnmatchedSubFilter('synopsis')}
            className={`min-h-6 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors cursor-pointer ${
              ctx.unmatchedSubFilter === 'synopsis'
                ? 'bg-orange-400 text-slate-950 shadow'
                : 'bg-[#1b2838] text-slate-200 hover:text-white border border-[#2a475e]'
            }`}
          >
            Missing Synopsis ({ctx.unmatchedSubCounts.synopsis})
          </button>
          <button
            type="button"
            aria-pressed={ctx.unmatchedSubFilter === 'dev_year'}
            onClick={() => ctx.setUnmatchedSubFilter('dev_year')}
            className={`min-h-6 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors cursor-pointer ${
              ctx.unmatchedSubFilter === 'dev_year'
                ? 'bg-sky-400 text-slate-950 shadow'
                : 'bg-[#1b2838] text-slate-200 hover:text-white border border-[#2a475e]'
            }`}
          >
            Missing Dev / Year ({ctx.unmatchedSubCounts.dev_year})
          </button>
        </div>
      );
    }

    case 'suppressed-subtoolbar': {
      const allVisibleSelected =
        ctx.filteredAutoFilteredEntries.length > 0 &&
        ctx.selectedVisibleEntries.length === ctx.filteredAutoFilteredEntries.length;

      return (
        <div
          key={row.key}
          className="px-4 py-2.5 border-x border-b border-x-[#2a475e]/80 border-b-[#2a475e]/50 bg-[#16202d]/90 flex items-center justify-between gap-2 flex-wrap"
        >
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-300 mr-1">
              Category:
            </span>
            <button
              type="button"
              aria-pressed={ctx.autoFilteredSubFilter === 'all'}
              onClick={() => ctx.setAutoFilteredSubFilter('all')}
              className={`min-h-6 px-2.5 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                ctx.autoFilteredSubFilter === 'all'
                  ? 'bg-rose-400 text-slate-950'
                  : 'bg-[#1b2838] text-slate-200 hover:text-white border border-[#2a475e]'
              }`}
            >
              All Non-Games ({ctx.autoFilteredSubCounts.all})
            </button>
            <button
              type="button"
              aria-pressed={ctx.autoFilteredSubFilter === 'beta'}
              onClick={() => ctx.setAutoFilteredSubFilter('beta')}
              className={`min-h-6 px-2.5 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                ctx.autoFilteredSubFilter === 'beta'
                  ? 'bg-amber-400 text-slate-950'
                  : 'bg-[#1b2838] text-slate-200 hover:text-white border border-[#2a475e]'
              }`}
            >
              Betas / Test / Legacy ({ctx.autoFilteredSubCounts.beta})
            </button>
            <button
              type="button"
              aria-pressed={ctx.autoFilteredSubFilter === 'prologue'}
              onClick={() => ctx.setAutoFilteredSubFilter('prologue')}
              className={`min-h-6 px-2.5 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                ctx.autoFilteredSubFilter === 'prologue'
                  ? 'bg-orange-400 text-slate-950'
                  : 'bg-[#1b2838] text-slate-200 hover:text-white border border-[#2a475e]'
              }`}
            >
              Prologues / Demos ({ctx.autoFilteredSubCounts.prologue})
            </button>
            <button
              type="button"
              aria-pressed={ctx.autoFilteredSubFilter === 'tool'}
              onClick={() => ctx.setAutoFilteredSubFilter('tool')}
              className={`min-h-6 px-2.5 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                ctx.autoFilteredSubFilter === 'tool'
                  ? 'bg-rose-400 text-slate-950'
                  : 'bg-[#1b2838] text-slate-200 hover:text-white border border-[#2a475e]'
              }`}
            >
              Tools / SDKs / Servers ({ctx.autoFilteredSubCounts.tool})
            </button>
            <button
              type="button"
              aria-pressed={ctx.autoFilteredSubFilter === 'soundtrack'}
              onClick={() => ctx.setAutoFilteredSubFilter('soundtrack')}
              className={`min-h-6 px-2.5 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                ctx.autoFilteredSubFilter === 'soundtrack'
                  ? 'bg-purple-400 text-slate-950'
                  : 'bg-[#1b2838] text-slate-200 hover:text-white border border-[#2a475e]'
              }`}
            >
              Soundtracks / Goodies ({ctx.autoFilteredSubCounts.soundtrack})
            </button>
            <button
              type="button"
              aria-pressed={ctx.autoFilteredSubFilter === 'dlc'}
              onClick={() => ctx.setAutoFilteredSubFilter('dlc')}
              className={`min-h-6 px-2.5 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                ctx.autoFilteredSubFilter === 'dlc'
                  ? 'bg-sky-400 text-slate-950'
                  : 'bg-[#1b2838] text-slate-200 hover:text-white border border-[#2a475e]'
              }`}
            >
              DLC / Add-ons ({ctx.autoFilteredSubCounts.dlc})
            </button>
          </div>

          {ctx.filteredAutoFilteredEntries.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => {
                  if (allVisibleSelected) {
                    ctx.setSelectedNonGameIds((prev) => {
                      const next = new Set(prev);
                      for (const e of ctx.filteredAutoFilteredEntries) {
                        next.delete(e.id);
                      }
                      return next;
                    });
                  } else {
                    ctx.setSelectedNonGameIds((prev) => {
                      const next = new Set(prev);
                      for (const e of ctx.filteredAutoFilteredEntries) {
                        next.add(e.id);
                      }
                      return next;
                    });
                  }
                }}
                className="min-h-6 px-2.5 py-1 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-[11px] font-semibold text-slate-200 hover:text-white transition-colors cursor-pointer"
              >
                {allVisibleSelected ? 'Clear Selection' : 'Select All Shown'}
              </button>

              {ctx.selectedVisibleEntries.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    confirmMultipleNonGameStorefrontEntries(
                      ctx.selectedVisibleEntries.map((e) => ({
                        platformId: e.platformId,
                        platformGameId: e.platformGameId,
                        gameId: e.id,
                      }))
                    );
                    ctx.setSelectedNonGameIds((prev) => {
                      const next = new Set(prev);
                      for (const e of ctx.selectedVisibleEntries) {
                        next.delete(e.id);
                      }
                      return next;
                    });
                  }}
                  className="min-h-6 px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-[11px] font-bold flex items-center gap-1 transition-colors cursor-pointer shadow"
                >
                  <CheckCircle2 aria-hidden="true" className="w-3.5 h-3.5" />
                  <span>Confirm Selected ({ctx.selectedVisibleEntries.length})</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  confirmMultipleNonGameStorefrontEntries(
                    ctx.filteredAutoFilteredEntries.map((e) => ({
                      platformId: e.platformId,
                      platformGameId: e.platformGameId,
                      gameId: e.id,
                    }))
                  );
                  ctx.setSelectedNonGameIds(new Set());
                }}
                className="min-h-6 px-2.5 py-1 rounded bg-teal-950/80 hover:bg-teal-900 border border-teal-500/40 text-teal-300 hover:text-white text-[11px] font-semibold flex items-center gap-1 transition-colors cursor-pointer"
              >
                <CheckCircle2 aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Confirm All Shown ({ctx.filteredAutoFilteredEntries.length})</span>
              </button>
            </div>
          )}
        </div>
      );
    }

    case 'empty-notice': {
      return (
        <div
          key={row.key}
          className="px-4 py-6 border-x border-b border-[#2a475e]/80 rounded-b-lg bg-[#131c27]/70 text-center text-xs text-slate-300 flex flex-col items-center gap-1.5"
        >
          {row.showCheckIcon && (
            <CheckCircle2 aria-hidden="true" className="w-5 h-5 text-emerald-400" />
          )}
          <span>{row.message}</span>
        </div>
      );
    }

    case 'unmatched-row': {
      const { game, reasons, isLastInSection } = row;
      return (
        <div
          key={row.key}
          className={`ol-studio-row-card px-4 py-3 border-x border-x-[#2a475e]/80 bg-[#131c27]/70 ${
            isLastInSection
              ? 'border-b border-b-[#2a475e]/80 rounded-b-lg pb-4'
              : 'border-b border-b-[#2a475e]/40'
          } flex flex-col sm:flex-row sm:items-center justify-between gap-3`}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 aspect-[2/3] rounded bg-black/60 border border-[#2a475e] overflow-hidden shrink-0 flex items-center justify-center">
              {game.capsuleImage || game.headerImage ? (
                <img
                  src={game.capsuleImage || game.headerImage}
                  alt={game.title}
                  width={40}
                  height={60}
                  loading="lazy"
                  decoding="async"
                  className="w-full h-full object-cover"
                />
              ) : (
                <ImageIcon aria-hidden="true" className="w-4 h-4 text-slate-400" />
              )}
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-sm font-bold text-white truncate mr-0.5">{game.title}</span>
                {reasons.map((reason) => (
                  <span
                    key={reason.code}
                    title={reason.tooltip}
                    className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${reason.colorClass}`}
                  >
                    {reason.label}
                  </span>
                ))}
              </div>

              <div className="flex items-center gap-2 flex-wrap mt-1">
                {game.platforms.map((p) => (
                  <span
                    key={`${p.platformId}-${p.platformGameId}`}
                    className="inline-flex items-center gap-1 text-[11px] text-slate-300 bg-[#16202d] border border-[#2a475e] px-2 py-0.5 rounded"
                  >
                    <StorefrontIcon
                      storefrontId={p.platformId as StorefrontId}
                      className="w-3 h-3"
                    />
                    <span>{getStorefrontDisplayName(p.platformId)}</span>
                    {p.originalTitle && p.originalTitle !== game.title && (
                      <span className="text-slate-300">• &ldquo;{p.originalTitle}&rdquo;</span>
                    )}
                    <span className="text-[10px] font-mono text-slate-300">
                      (ID: {p.platformGameId})
                    </span>
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {ctx.handleInspect && (
              <button
                type="button"
                onClick={() => {
                  ctx.handleInspect!(game);
                  ctx.onClose();
                }}
                className="min-h-6 px-2.5 py-1.5 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-xs font-semibold text-slate-200 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Eye aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Inspect</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => ctx.onFixMatchForGame(game)}
              className="min-h-6 px-3 py-1.5 rounded bg-[#66c0f4] hover:bg-[#4da6db] text-slate-950 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
            >
              <Wand aria-hidden="true" className="w-3.5 h-3.5" />
              <span>Fix Match</span>
            </button>
            {ctx.onHideGame && (
              <button
                type="button"
                onClick={() => ctx.onHideGame!(game)}
                className="min-h-6 px-2.5 py-1.5 rounded bg-rose-950/60 hover:bg-rose-900/80 border border-rose-500/40 text-xs font-semibold text-rose-300 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
                title="Hide / suppress this game from your active library"
              >
                <EyeOff aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Hide</span>
              </button>
            )}
          </div>
        </div>
      );
    }

    case 'low-confidence-row': {
      const { game, isLastInSection } = row;
      const rawConf =
        typeof game.matchConfidence === 'number'
          ? Math.round(
              game.matchConfidence <= 1 ? game.matchConfidence * 100 : game.matchConfidence
            )
          : undefined;
      const sourceTitle =
        game.originalStoreTitle || game.platforms[0]?.originalTitle || game.title;

      return (
        <div
          key={row.key}
          className={`ol-studio-row-card px-4 py-3 border-x border-x-[#2a475e]/80 bg-[#131c27]/70 ${
            isLastInSection
              ? 'border-b border-b-[#2a475e]/80 rounded-b-lg pb-4'
              : 'border-b border-b-[#2a475e]/40'
          } flex flex-col sm:flex-row sm:items-center justify-between gap-3`}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 aspect-[2/3] rounded bg-black/60 border border-[#2a475e] overflow-hidden shrink-0 flex items-center justify-center">
              {game.capsuleImage || game.headerImage ? (
                <img
                  src={game.capsuleImage || game.headerImage}
                  alt={game.title}
                  width={40}
                  height={60}
                  loading="lazy"
                  decoding="async"
                  className="w-full h-full object-cover"
                />
              ) : (
                <ImageIcon aria-hidden="true" className="w-4 h-4 text-slate-400" />
              )}
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-bold text-white truncate">{game.title}</span>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-950/70 border border-orange-500/40 text-orange-300">
                  {typeof rawConf === 'number' && rawConf > 0
                    ? `${rawConf}% Confidence`
                    : 'Heuristic Title Match'}
                </span>
              </div>

              <div className="text-xs text-slate-300 mt-1 flex items-center gap-1.5 flex-wrap">
                <span className="text-slate-300">Store Scrape:</span>
                <span className="font-medium text-white">&ldquo;{sourceTitle}&rdquo;</span>
                <ArrowRight aria-hidden="true" className="w-3 h-3 text-orange-400 shrink-0" />
                <span className="text-slate-300">Matched As:</span>
                <span className="font-semibold text-orange-200">&ldquo;{game.title}&rdquo;</span>
              </div>

              <div className="flex items-center gap-2 flex-wrap mt-1">
                {game.platforms.map((p) => (
                  <span
                    key={`${p.platformId}-${p.platformGameId}`}
                    className="inline-flex items-center gap-1 text-[11px] text-slate-300 bg-[#16202d] border border-[#2a475e] px-2 py-0.5 rounded"
                  >
                    <StorefrontIcon
                      storefrontId={p.platformId as StorefrontId}
                      className="w-3 h-3"
                    />
                    <span>{getStorefrontDisplayName(p.platformId)}</span>
                    <span className="text-[10px] font-mono text-slate-300">
                      (ID: {p.platformGameId})
                    </span>
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {ctx.handleInspect && (
              <button
                type="button"
                onClick={() => {
                  ctx.handleInspect!(game);
                  ctx.onClose();
                }}
                className="min-h-6 px-2.5 py-1.5 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-xs font-semibold text-slate-200 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Eye aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Inspect</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => ctx.onFixMatchForGame(game)}
              className="min-h-6 px-3 py-1.5 rounded bg-[#66c0f4] hover:bg-[#4da6db] text-slate-950 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
            >
              <Wand aria-hidden="true" className="w-3.5 h-3.5" />
              <span>Verify / Fix Match</span>
            </button>
            {ctx.onHideGame && (
              <button
                type="button"
                onClick={() => ctx.onHideGame!(game)}
                className="min-h-6 px-2.5 py-1.5 rounded bg-rose-950/60 hover:bg-rose-900/80 border border-rose-500/40 text-xs font-semibold text-rose-300 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
                title="Hide / suppress this game from your active library"
              >
                <EyeOff aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Hide</span>
              </button>
            )}
          </div>
        </div>
      );
    }

    case 'user-suppressed-row': {
      const { entry, isLastInSection } = row;
      const badge = formatSuppressionBadge(entry);
      return (
        <div
          key={row.key}
          className={`ol-studio-row-card px-4 py-3 border-x border-x-[#2a475e]/80 bg-[#131c27]/70 ${
            isLastInSection
              ? 'border-b border-b-[#2a475e]/80 rounded-b-lg pb-4'
              : 'border-b border-b-[#2a475e]/40'
          } flex flex-col sm:flex-row sm:items-center justify-between gap-3`}
        >
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#16202d] border border-[#2a475e] text-[11px] font-semibold text-sky-300">
                <StorefrontIcon
                  storefrontId={entry.platformId as StorefrontId}
                  className="w-3 h-3"
                />
                <span>{getStorefrontDisplayName(entry.platformId)}</span>
              </span>

              <span className="text-sm font-bold text-white truncate">
                &ldquo;{entry.rawTitle}&rdquo;
              </span>

              <span
                className={`px-2 py-0.5 rounded border text-[10px] font-semibold ${badge.colorClass}`}
              >
                {badge.label}
              </span>
            </div>

            <div className="text-[11px] text-slate-300 font-mono">
              Platform Entitlement ID: {entry.platformGameId}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            {ctx.onUnhideEntry && (
              <button
                type="button"
                onClick={() => ctx.onUnhideEntry!(entry)}
                className="min-h-6 px-3 py-1.5 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#66c0f4]/50 text-[#66c0f4] hover:text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
                title="Unhide and restore this entry directly back to your library"
              >
                <RotateCcw aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Unhide / Restore</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => ctx.onFixMatchForGame(entry.rawGame)}
              className="min-h-6 px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
              title="Manually match this suppressed storefront entitlement to a real game and restore it to your library"
            >
              <Wand aria-hidden="true" className="w-3.5 h-3.5" />
              <span>Match &amp; Restore to Library</span>
            </button>
          </div>
        </div>
      );
    }

    case 'pending-suppressed-row': {
      const { entry, isLastInSection } = row;
      const badge = formatSuppressionBadge(entry);
      const isChecked = isSelectedOverride ?? ctx.selectedNonGameIds.has(entry.id);
      return (
        <div
          key={row.key}
          className={`ol-studio-row-card px-4 py-3 border-x border-x-[#2a475e]/80 bg-[#131c27]/70 ${
            isLastInSection
              ? 'border-b border-b-[#2a475e]/80 rounded-b-lg pb-4'
              : 'border-b border-b-[#2a475e]/40'
          } flex flex-col sm:flex-row sm:items-center justify-between gap-3`}
        >
          <div className="flex items-start gap-3 min-w-0">
            <input
              type="checkbox"
              checked={isChecked}
              onChange={() => {
                ctx.setSelectedNonGameIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(entry.id)) {
                    next.delete(entry.id);
                  } else {
                    next.add(entry.id);
                  }
                  return next;
                });
              }}
              aria-label={`Select ${entry.rawTitle}`}
              className="mt-0.5 w-6 h-6 rounded border-[#2a475e] bg-[#16202d] text-emerald-500 focus:ring-0 cursor-pointer shrink-0"
            />

            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#16202d] border border-[#2a475e] text-[11px] font-semibold text-sky-300">
                  <StorefrontIcon
                    storefrontId={entry.platformId as StorefrontId}
                    className="w-3 h-3"
                  />
                  <span>{getStorefrontDisplayName(entry.platformId)}</span>
                </span>

                <span className="text-sm font-bold text-white truncate">
                  &ldquo;{entry.rawTitle}&rdquo;
                </span>

                <span
                  className={`px-2 py-0.5 rounded border text-[10px] font-semibold ${badge.colorClass}`}
                >
                  {badge.label}
                </span>
              </div>

              <div className="text-[11px] text-slate-300 font-mono">
                Platform Entitlement ID: {entry.platformGameId}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <button
              type="button"
              onClick={() => {
                confirmNonGameStorefrontEntry(entry.platformId, entry.platformGameId, entry.id);
                ctx.setSelectedNonGameIds((prev) => {
                  if (!prev.has(entry.id)) return prev;
                  const next = new Set(prev);
                  next.delete(entry.id);
                  return next;
                });
              }}
              className="min-h-6 px-3 py-1.5 rounded bg-teal-950/70 hover:bg-teal-900 border border-teal-500/40 text-teal-300 hover:text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
              title="Confirm this entry is a non-game item and move it to Reviewed & Confirmed Non-Games"
            >
              <CheckCircle2 aria-hidden="true" className="w-3.5 h-3.5" />
              <span>Confirm Suppressed</span>
            </button>
            {ctx.onUnhideEntry && (
              <button
                type="button"
                onClick={() => ctx.onUnhideEntry!(entry)}
                className="min-h-6 px-3 py-1.5 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#66c0f4]/50 text-[#66c0f4] hover:text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
                title="Restore and include this non-game storefront entry directly in your active library"
              >
                <RotateCcw aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Include in Library</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => ctx.onFixMatchForGame(entry.rawGame)}
              className="min-h-6 px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
              title="Manually match this suppressed storefront entitlement to a real game and restore it to your library"
            >
              <Wand aria-hidden="true" className="w-3.5 h-3.5" />
              <span>Match &amp; Restore to Library</span>
            </button>
          </div>
        </div>
      );
    }

    case 'confirmed-suppressed-row': {
      const { entry, isLastInSection } = row;
      const badge = formatSuppressionBadge(entry);
      return (
        <div
          key={row.key}
          className={`ol-studio-row-card px-4 py-3 border-x border-x-[#2a475e]/80 bg-[#131c27]/70 ${
            isLastInSection
              ? 'border-b border-b-[#2a475e]/80 rounded-b-lg pb-4'
              : 'border-b border-b-[#2a475e]/40'
          } flex flex-col sm:flex-row sm:items-center justify-between gap-3`}
        >
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#16202d] border border-[#2a475e] text-[11px] font-semibold text-sky-300">
                <StorefrontIcon
                  storefrontId={entry.platformId as StorefrontId}
                  className="w-3 h-3"
                />
                <span>{getStorefrontDisplayName(entry.platformId)}</span>
              </span>

              <span className="text-sm font-bold text-white truncate">
                &ldquo;{entry.rawTitle}&rdquo;
              </span>

              <span
                className={`px-2 py-0.5 rounded border text-[10px] font-semibold ${badge.colorClass}`}
              >
                {badge.label}
              </span>

              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-semibold bg-emerald-950/70 border-emerald-500/40 text-emerald-300">
                <CheckCircle2 aria-hidden="true" className="w-3 h-3" />
                <span>Confirmed Suppressed</span>
              </span>
            </div>

            <div className="text-[11px] text-slate-300 font-mono">
              Platform Entitlement ID: {entry.platformGameId}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <button
              type="button"
              onClick={() =>
                unconfirmNonGameStorefrontEntry(entry.platformId, entry.platformGameId, entry.id)
              }
              className="min-h-6 px-2.5 py-1.5 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-slate-200 hover:text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
              title="Move this entry back to Pending Review"
            >
              <RotateCcw aria-hidden="true" className="w-3.5 h-3.5" />
              <span>Move to Pending Review</span>
            </button>
            {ctx.onUnhideEntry && (
              <button
                type="button"
                onClick={() => ctx.onUnhideEntry!(entry)}
                className="min-h-6 px-3 py-1.5 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#66c0f4]/50 text-[#66c0f4] hover:text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
                title="Restore and include this non-game storefront entry directly in your active library"
              >
                <RotateCcw aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Include in Library</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => ctx.onFixMatchForGame(entry.rawGame)}
              className="min-h-6 px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow"
              title="Manually match this suppressed storefront entitlement to a real game and restore it to your library"
            >
              <Wand aria-hidden="true" className="w-3.5 h-3.5" />
              <span>Match &amp; Restore to Library</span>
            </button>
          </div>
        </div>
      );
    }

    case 'override-row': {
      const { override, matchedGame, isLastInSection } = row;
      const sourcePlat =
        matchedGame?.platforms.find(
          (p) => p.platformId === (override.originalSourcePlatformId || override.platformId)
        ) || matchedGame?.platforms[0];

      const sourcePlatformId =
        override.originalSourcePlatformId ||
        override.platformId ||
        sourcePlat?.platformId ||
        'steam';

      const sourceRawTitle =
        override.originalSourceTitle ||
        sourcePlat?.originalTitle ||
        matchedGame?.originalStoreTitle ||
        matchedGame?.title ||
        override.title;

      const sourcePlatformGameId = override.platformGameId || sourcePlat?.platformGameId;

      const { targetUrl, targetStoreLabel } = resolveOverrideTargetStoreDetails(
        override,
        sourceRawTitle || ''
      );

      return (
        <div
          key={row.key}
          className={`ol-studio-row-card px-4 py-3.5 border-x border-x-[#2a475e]/80 bg-[#131c27]/70 ${
            isLastInSection
              ? 'border-b border-b-[#2a475e]/80 rounded-b-lg pb-4'
              : 'border-b border-b-[#2a475e]/40'
          } flex flex-col lg:flex-row lg:items-center justify-between gap-3`}
        >
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 min-w-0 flex-1">
            {/* Left: Original Source Entitlement */}
            <div className="p-2.5 rounded-lg bg-[#16202d] border border-[#2a475e] flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-300 font-semibold">
                  Original Storefront Entitlement
                </span>
                {override.splitFromMerged && (
                  <span className="px-1.5 py-0.5 rounded bg-purple-950/80 border border-purple-500/40 text-[9px] font-bold uppercase text-purple-300">
                    Split Entry
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#1b2838] border border-[#2a475e] text-[10px] font-bold text-sky-300">
                  <StorefrontIcon
                    storefrontId={sourcePlatformId as StorefrontId}
                    className="w-3 h-3"
                  />
                  <span>{getStorefrontDisplayName(sourcePlatformId)}</span>
                </span>
                <span className="text-xs font-bold text-white truncate">
                  &ldquo;{sourceRawTitle}&rdquo;
                </span>
              </div>
              {sourcePlatformGameId && (
                <div className="text-[10px] font-mono text-slate-300 mt-1">
                  Platform ID: {sourcePlatformGameId}
                </div>
              )}
            </div>

            <ArrowRight
              aria-hidden="true"
              className="w-4 h-4 text-amber-400 shrink-0 self-center hidden sm:block"
            />

            {/* Right: Active Target Override */}
            <div className="p-2.5 rounded-lg bg-[#1b2838]/80 border border-amber-500/40 flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[10px] uppercase tracking-wider text-amber-300 font-semibold">
                  Routed Target Metadata
                </span>
                {targetUrl && (
                  <button
                    type="button"
                    onClick={() => ctx.handleOpenExternalUrl(targetUrl)}
                    className="min-h-6 inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#131c27] hover:bg-[#2a475e] border border-[#2a475e] text-[10px] font-semibold text-[#66c0f4] hover:text-white transition-colors cursor-pointer"
                    title={`Open ${targetStoreLabel.toUpperCase()} store page in browser`}
                  >
                    <ExternalLink aria-hidden="true" className="w-2.5 h-2.5" />
                    <span>Store Page</span>
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="px-1.5 py-0.5 rounded bg-amber-950/80 border border-amber-500/40 text-[10px] font-bold uppercase text-amber-300">
                  {targetStoreLabel}
                </span>
                <span className="text-xs font-bold text-amber-100 truncate">
                  &ldquo;{override.title}&rdquo;
                </span>
              </div>
              <div className="text-[10px] font-mono text-slate-300 mt-1">
                Target ID: {override.matchedId}
                {override.steamAppId ? ` • Steam AppID: ${override.steamAppId}` : ''}
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {matchedGame && (
              <button
                type="button"
                onClick={() => ctx.onFixMatchForGame(matchedGame)}
                className="min-h-6 px-2.5 py-1.5 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-xs font-semibold text-[#66c0f4] hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Wand aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Edit Match</span>
              </button>
            )}
            {ctx.handleReset && (
              <button
                type="button"
                onClick={() => ctx.handleReset!(matchedGame?.id || override.gameId)}
                className="min-h-6 px-2.5 py-1.5 rounded bg-rose-950/60 hover:bg-rose-900/80 border border-rose-500/40 text-xs font-semibold text-rose-300 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
                title="Remove manual override and revert to automatic storefront matching"
              >
                <RotateCcw aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
            )}
          </div>
        </div>
      );
    }

    case 'merged-row': {
      const { game, isFirstItem, isLastInSection } = row;
      return (
        <div
          key={row.key}
          className={`ol-studio-row-card px-3.5 ${isFirstItem ? 'pt-3.5 ' : 'pt-2 '}${
            isLastInSection
              ? 'border-b border-b-[#2a475e]/80 rounded-b-lg pb-3.5'
              : 'pb-0'
          } border-x border-x-[#2a475e]/80 bg-[#131c27]/70`}
        >
          <div className="px-3 py-2.5 rounded-lg bg-[#16202d]/90 border border-[#2a475e]/40 hover:border-emerald-500/30 transition-colors flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
            {/* Left / Center section: Cover, Title, Storefronts Badge, and Inline Storefront Entitlement Chips */}
            <div className="flex items-center gap-3 min-w-0 flex-1 flex-wrap">
              <div className="w-8 h-11 rounded bg-black/60 border border-[#2a475e] overflow-hidden shrink-0 flex items-center justify-center">
                {game.capsuleImage || game.headerImage ? (
                  <img
                    src={game.capsuleImage || game.headerImage}
                    alt={game.title}
                    width={32}
                    height={44}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <ImageIcon aria-hidden="true" className="w-3.5 h-3.5 text-slate-400" />
                )}
              </div>

              <div className="flex items-center gap-2 min-w-0 flex-wrap flex-1">
                <span className="text-sm font-semibold text-white truncate">{game.title}</span>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-950/70 border border-emerald-500/40 text-emerald-300 shrink-0">
                  {game.platforms.length} Storefronts
                </span>

                {/* Inline Compact Storefront Entitlement Chips */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  {game.platforms.map((p) => {
                    const installedRec = launcherService.getInstalledRecordForGame(
                      game,
                      p.platformId
                    );
                    const isPlatInstalled = Boolean(
                      installedRec ||
                        launcherService.isGameInstalled(game, p.platformId) ||
                        p.installed
                    );
                    const osBadge = resolveEntitlementOsBadge(
                      game,
                      p,
                      installedRec,
                      isPlatInstalled
                    );
                    const rawPlatTitle =
                      p.originalTitle || game.originalStoreTitle || game.title;

                    return (
                      <div
                        key={`${p.platformId}-${p.platformGameId}`}
                        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-[#0e141b]/90 border border-[#2a475e]/60 text-[11px]"
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            isPlatInstalled ? 'bg-emerald-400' : 'bg-slate-400'
                          }`}
                          title={isPlatInstalled ? 'Installed' : 'Not Installed'}
                        />
                        <span className="sr-only">
                          {isPlatInstalled ? 'Installed' : 'Not Installed'}
                        </span>

                        <StorefrontIcon
                          storefrontId={p.platformId as StorefrontId}
                          className="w-3 h-3 text-sky-400 shrink-0"
                        />
                        <span className="font-semibold text-white">
                          {getStorefrontDisplayName(p.platformId)}
                        </span>

                        {osBadge && (
                          <span
                            title={osBadge.title}
                            className={`px-1.5 py-0.2 rounded border text-[10px] font-semibold shrink-0 ${osBadge.className}`}
                          >
                            {osBadge.label}
                          </span>
                        )}

                        {rawPlatTitle && rawPlatTitle !== game.title && (
                          <span className="text-slate-300 truncate max-w-[160px]">
                            • &ldquo;{rawPlatTitle}&rdquo;
                          </span>
                        )}

                        <span className="text-[10px] font-mono text-slate-300">
                          #{p.platformGameId}
                        </span>

                        <span className="h-3 w-px bg-[#2a475e]/70 mx-0.5 shrink-0" />

                        <button
                          type="button"
                          onClick={() => {
                            const singleStoreGame: CanonicalGame & {
                              isSplittingFromMerged?: boolean;
                            } = {
                              ...game,
                              id: `${p.platformId}-${p.platformGameId}`,
                              title: rawPlatTitle,
                              sortTitle: rawPlatTitle,
                              originalStoreTitle: rawPlatTitle,
                              steamAppId:
                                p.platformId === 'steam' && !isNaN(Number(p.platformGameId))
                                  ? Number(p.platformGameId)
                                  : undefined,
                              platforms: [{ ...p, originalTitle: rawPlatTitle }],
                              isSplittingFromMerged: true,
                            };
                            ctx.onFixMatchForGame(singleStoreGame);
                          }}
                          className="min-h-6 px-2 py-0.5 rounded text-[10px] font-semibold text-[#66c0f4] hover:bg-[#66c0f4] hover:text-slate-950 transition-colors flex items-center gap-1 cursor-pointer"
                          title={`Split this ${getStorefrontDisplayName(p.platformId)} entry from "${game.title}" and match it to its own game`}
                        >
                          <Wand aria-hidden="true" className="w-2.5 h-2.5" />
                          <span>Fix / Split Entry</span>
                        </button>

                        {ctx.onHideGame && (
                          <button
                            type="button"
                            onClick={() => ctx.onHideGame!(game, p.platformId)}
                            className="min-h-6 px-2 py-0.5 rounded text-[10px] font-medium text-rose-300 hover:bg-rose-900/80 hover:text-white transition-colors flex items-center gap-1 cursor-pointer"
                            title={`Hide / suppress only the ${getStorefrontDisplayName(p.platformId)} entry from this merged listing`}
                          >
                            <EyeOff aria-hidden="true" className="w-2.5 h-2.5" />
                            <span>Hide Entry</span>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Right section: Compact Inspect and Edit Merged Match buttons */}
            <div className="flex items-center gap-1.5 shrink-0">
              {ctx.handleInspect && (
                <button
                  type="button"
                  onClick={() => {
                    ctx.handleInspect!(game);
                    ctx.onClose();
                  }}
                  className="min-h-6 px-2.5 py-1 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-[11px] font-semibold text-slate-200 hover:text-white flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <Eye aria-hidden="true" className="w-3 h-3" />
                  <span>Inspect</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => ctx.onFixMatchForGame(game)}
                className="min-h-6 px-2.5 py-1 rounded bg-[#1b2838] hover:bg-[#2a475e] border border-[#2a475e] text-[11px] font-semibold text-[#66c0f4] hover:text-white flex items-center gap-1 transition-colors cursor-pointer"
              >
                <Wand aria-hidden="true" className="w-3 h-3" />
                <span>Edit Merged Match</span>
              </button>
            </div>
          </div>
        </div>
      );
    }
  }
}

export interface MatchManagerVirtualRowProps {
  row: MatchManagerFlatRow;
  isSelected: boolean;
  ctx: MatchManagerRowRenderContext;
}

function areMatchManagerRowPropsEqual(
  prev: MatchManagerVirtualRowProps,
  next: MatchManagerVirtualRowProps
): boolean {
  if (prev.row !== next.row || prev.isSelected !== next.isSelected) {
    return false;
  }
  if (next.row.kind === 'unmatched-subtoolbar') {
    return (
      prev.ctx.unmatchedSubFilter === next.ctx.unmatchedSubFilter &&
      prev.ctx.unmatchedSubCounts === next.ctx.unmatchedSubCounts
    );
  }
  if (next.row.kind === 'suppressed-subtoolbar') {
    return (
      prev.ctx.autoFilteredSubFilter === next.ctx.autoFilteredSubFilter &&
      prev.ctx.autoFilteredSubCounts === next.ctx.autoFilteredSubCounts &&
      prev.ctx.filteredAutoFilteredEntries === next.ctx.filteredAutoFilteredEntries &&
      prev.ctx.selectedVisibleEntries === next.ctx.selectedVisibleEntries
    );
  }
  return (
    prev.ctx.toggleSection === next.ctx.toggleSection &&
    prev.ctx.setSelectedNonGameIds === next.ctx.setSelectedNonGameIds &&
    prev.ctx.handleInspect === next.ctx.handleInspect &&
    prev.ctx.handleReset === next.ctx.handleReset &&
    prev.ctx.onFixMatchForGame === next.ctx.onFixMatchForGame &&
    prev.ctx.onHideGame === next.ctx.onHideGame &&
    prev.ctx.onUnhideEntry === next.ctx.onUnhideEntry &&
    prev.ctx.onClose === next.ctx.onClose &&
    prev.ctx.handleOpenExternalUrl === next.ctx.handleOpenExternalUrl
  );
}

export const MatchManagerVirtualRow = React.memo<MatchManagerVirtualRowProps>(
  function MatchManagerVirtualRow({ row, isSelected, ctx }) {
    return <>{renderMatchManagerFlatRow(row, ctx, isSelected)}</>;
  },
  areMatchManagerRowPropsEqual
);
