import React from 'react';
import { ArrowLeft } from 'lucide-react';

export interface StoreDetailBreadcrumbProps {
  title: string;
  onBackToLibrary?: () => void;
}

const StoreDetailBreadcrumbImpl: React.FC<StoreDetailBreadcrumbProps> = ({
  title,
  onBackToLibrary,
}) => (
  <nav
    aria-label="Breadcrumb"
    className="flex items-center justify-between border-b border-steam-border/40 pb-4"
  >
    <div className="flex items-center gap-2 text-xs text-steam-subtext">
      <button
        type="button"
        onClick={onBackToLibrary}
        className="inline-flex items-center gap-1.5 min-h-6 text-steam-accent hover:text-white hover:underline cursor-pointer uppercase tracking-wider text-[11px] font-bold transition-colors group"
        title="Return to All Games library grid"
      >
        <ArrowLeft
          className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform"
          aria-hidden="true"
        />
        <span>All Games</span>
      </button>
      <span aria-hidden="true">&gt;</span>
      <span className="text-white font-semibold truncate max-w-md" aria-current="page">
        {title}
      </span>
    </div>
  </nav>
);

export const StoreDetailBreadcrumb: React.FC<StoreDetailBreadcrumbProps> = React.memo(
  StoreDetailBreadcrumbImpl
);
