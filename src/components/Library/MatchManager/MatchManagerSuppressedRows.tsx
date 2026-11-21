import React from 'react';
import { CheckCircle2, RotateCcw, Wand } from 'lucide-react';
import { StorefrontId } from '../../../contracts/platform';
import { ensureSuppressedEntryRawGame } from '../../../services/integrations/catalogSanitizer';
import {
  confirmNonGameStorefrontEntry,
  unconfirmNonGameStorefrontEntry,
} from '../../../services/storage/userOverrideStorage';
import { StorefrontIcon, getStorefrontDisplayName } from '../../Common/StorefrontIcon';
import { formatSuppressionBadge } from './matchManagerDiagnostics';
import { MatchManagerFlatRow } from './matchManagerTypes';
import { MatchManagerRowRenderContext } from './matchManagerRowHelpers';

export function renderUserSuppressedRow(
  row: Extract<MatchManagerFlatRow, { kind: 'user-suppressed-row' }>,
  ctx: MatchManagerRowRenderContext
): React.ReactElement {
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
          onClick={() => ctx.onFixMatchForGame(ensureSuppressedEntryRawGame(entry).rawGame)}
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

export function renderPendingSuppressedRow(
  row: Extract<MatchManagerFlatRow, { kind: 'pending-suppressed-row' }>,
  ctx: MatchManagerRowRenderContext,
  isSelectedOverride?: boolean
): React.ReactElement {
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
          className="mt-0.5 w-6 h-6 rounded border-[#2a475e] bg-[#16202d] text-emerald-500 focus-visible:ring-2 focus-visible:ring-[#66c0f4] cursor-pointer shrink-0"
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
          onClick={() => ctx.onFixMatchForGame(ensureSuppressedEntryRawGame(entry).rawGame)}
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

export function renderConfirmedSuppressedRow(
  row: Extract<MatchManagerFlatRow, { kind: 'confirmed-suppressed-row' }>,
  ctx: MatchManagerRowRenderContext
): React.ReactElement {
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
          onClick={() => ctx.onFixMatchForGame(ensureSuppressedEntryRawGame(entry).rawGame)}
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
