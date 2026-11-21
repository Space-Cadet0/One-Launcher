import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  EyeOff,
  Layers,
  ShieldAlert,
  Wand,
} from 'lucide-react';
import { confirmMultipleNonGameStorefrontEntries } from '../../../services/storage/userOverrideStorage';
import { MatchManagerFlatRow, MatchStudioSectionKey } from './matchManagerTypes';
import { MatchManagerRowRenderContext } from './matchManagerRowHelpers';

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

export function renderSectionHeaderRow(
  row: Extract<MatchManagerFlatRow, { kind: 'section-header' }>,
  ctx: MatchManagerRowRenderContext
): React.ReactElement {
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

export function renderUnmatchedSubtoolbar(
  row: Extract<MatchManagerFlatRow, { kind: 'unmatched-subtoolbar' }>,
  ctx: MatchManagerRowRenderContext
): React.ReactElement {
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

export function renderSuppressedSubtoolbar(
  row: Extract<MatchManagerFlatRow, { kind: 'suppressed-subtoolbar' }>,
  ctx: MatchManagerRowRenderContext
): React.ReactElement {
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

export function renderEmptyNoticeRow(
  row: Extract<MatchManagerFlatRow, { kind: 'empty-notice' }>
): React.ReactElement {
  return (
    <div
      key={row.key}
      className="px-4 py-6 border-x border-b border-[#2a475e]/80 rounded-b-lg bg-[#131c27]/70 text-center text-xs text-slate-300 flex flex-col items-center gap-1.5"
    >
      {row.showCheckIcon && <CheckCircle2 aria-hidden="true" className="w-5 h-5 text-emerald-400" />}
      <span>{row.message}</span>
    </div>
  );
}
