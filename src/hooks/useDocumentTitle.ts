import { useEffect } from 'react';

const APP_BASE_TITLE = 'One Launcher';

export interface UseDocumentTitleParams {
  isHibernating: boolean;
  runningGamesCount: number;
  isGridView: boolean;
  selectedGameTitle?: string | null;
  activeFilterLabel?: string | null;
  activeFilterValue?: string | null;
  activeGroupName?: string | null;
}

export function buildDocumentTitle({
  isHibernating,
  runningGamesCount,
  isGridView,
  selectedGameTitle,
  activeFilterLabel,
  activeFilterValue,
  activeGroupName,
}: UseDocumentTitleParams): string {
  if (isHibernating) {
    return runningGamesCount > 0
      ? `In Game — ${APP_BASE_TITLE}`
      : `Hibernating — ${APP_BASE_TITLE}`;
  }
  if (!isGridView && selectedGameTitle?.trim()) {
    return `${selectedGameTitle.trim()} — ${APP_BASE_TITLE}`;
  }
  if (activeFilterLabel && activeFilterValue) {
    return `${activeFilterLabel}: ${activeFilterValue} — ${APP_BASE_TITLE}`;
  }
  if (activeGroupName?.trim()) {
    return `${activeGroupName.trim()} — ${APP_BASE_TITLE}`;
  }
  return `Library — ${APP_BASE_TITLE}`;
}

/**
 * Keeps `document.title` synchronized with the active SPA view (WCAG 2.4.2 Page Titled).
 */
export function useDocumentTitle(params: UseDocumentTitleParams): void {
  const title = buildDocumentTitle(params);
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = title;
    }
  }, [title]);
}
