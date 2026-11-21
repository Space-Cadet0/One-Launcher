import React from 'react';
import { MatchManagerFlatRow } from './matchManagerTypes';
import {
  buildMatchManagerFlatRows,
  BuildMatchManagerFlatRowsParams,
} from './matchManagerRowBuilder';
import {
  MatchManagerRowRenderContext,
  ResetOverrideContext,
} from './matchManagerRowHelpers';
import {
  renderEmptyNoticeRow,
  renderSectionHeaderRow,
  renderSuppressedSubtoolbar,
  renderUnmatchedSubtoolbar,
} from './MatchManagerSubToolbars';
import {
  renderConfirmedSuppressedRow,
  renderPendingSuppressedRow,
  renderUserSuppressedRow,
} from './MatchManagerSuppressedRows';
import {
  renderLowConfidenceRow,
  renderMergedRow,
  renderOverrideRow,
  renderUnmatchedRow,
} from './MatchManagerGameRows';

export { buildMatchManagerFlatRows };
export type {
  BuildMatchManagerFlatRowsParams,
  MatchManagerRowRenderContext,
  ResetOverrideContext,
};

export function renderMatchManagerFlatRow(
  row: MatchManagerFlatRow,
  ctx: MatchManagerRowRenderContext,
  isSelectedOverride?: boolean
): React.ReactNode {
  switch (row.kind) {
    case 'section-header':
      return renderSectionHeaderRow(row, ctx);
    case 'unmatched-subtoolbar':
      return renderUnmatchedSubtoolbar(row, ctx);
    case 'suppressed-subtoolbar':
      return renderSuppressedSubtoolbar(row, ctx);
    case 'empty-notice':
      return renderEmptyNoticeRow(row);
    case 'unmatched-row':
      return renderUnmatchedRow(row, ctx);
    case 'low-confidence-row':
      return renderLowConfidenceRow(row, ctx);
    case 'user-suppressed-row':
      return renderUserSuppressedRow(row, ctx);
    case 'pending-suppressed-row':
      return renderPendingSuppressedRow(row, ctx, isSelectedOverride);
    case 'confirmed-suppressed-row':
      return renderConfirmedSuppressedRow(row, ctx);
    case 'override-row':
      return renderOverrideRow(row, ctx);
    case 'merged-row':
      return renderMergedRow(row, ctx);
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
