import React from 'react';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { ActiveGameFilter } from '../../contracts/filter';

interface SteamSidebarNoticesProps {
  title: string;
  steamAppId?: number;
  genres: string[];
  developers: string[];
  publishers: string[];
  releaseDate?: string;
  franchise?: string;
  legalNotice?: string;
  onApplyFilter?: (filter: ActiveGameFilter) => void;
}

export const SteamSidebarNotices: React.FC<SteamSidebarNoticesProps> = ({
  title,
  steamAppId,
  genres,
  developers,
  publishers,
  releaseDate,
  franchise,
  legalNotice,
  onApplyFilter,
}) => {
  return (
    <div className="space-y-4">
      {/* Steam Deck Compatibility Section */}
      <div className="mb-4">
        <div className="steam-block-title">
          Steam Deck Compatibility
        </div>
        <div className="p-2.5 bg-[#171a21] border border-[#2a475e]/60 rounded-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg
              className="w-5 h-5 text-white shrink-0"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <circle cx="9.5" cy="12" r="4.2" />
              <path d="M9.5 3a9 9 0 0 1 0 18v-2.8a6.2 6.2 0 0 0 0-12.4V3z" />
            </svg>
            <span className="text-xs text-[#acb2b8] font-medium">Steam Deck</span>
          </div>
          <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-white bg-[#1b2838]/90 border border-[#59bf40]/50 px-2 py-0.5 rounded-sm">
            <svg
              className="w-3.5 h-3.5 shrink-0"
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="10" cy="10" r="9" fill="#59bf40" />
              <path
                d="M6 10.3L8.6 12.9L14.2 7.3"
                stroke="#171a21"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="tracking-wide text-[#59bf40]">VERIFIED</span>
          </span>
        </div>
      </div>

      {/* Steam Details Block (Exact .game_details layout) */}
      <div className="steam-game-details mb-4">
        <div className="space-y-0.5">
          <div>
            <b>Title:</b> <span className="text-white">{title}</span>
          </div>

          <div>
            <b>Genre:</b>{' '}
            <span className="space-x-1">
              {genres.map((g, idx) => (
                <span key={idx}>
                  <button
                    type="button"
                    onClick={() => onApplyFilter?.({ type: 'genre', label: 'Genre', value: g })}
                    className="hover:underline hover:text-white transition-colors cursor-pointer text-[#67c1f5]"
                    title={`Filter library by genre "${g}"`}
                  >
                    {g}
                  </button>
                  {idx < genres.length - 1 && ', '}
                </span>
              ))}
            </span>
          </div>

          <div>
            <b>Developer:</b>{' '}
            {developers.map((d, idx) => (
              <span key={idx}>
                <button
                  type="button"
                  onClick={() => onApplyFilter?.({ type: 'developer', label: 'Developer', value: d })}
                  className="hover:underline hover:text-white transition-colors cursor-pointer text-[#67c1f5]"
                  title={`Filter library by developer "${d}"`}
                >
                  {d}
                </button>
                {idx < developers.length - 1 && ', '}
              </span>
            ))}
            {developers.length === 0 && <span className="text-[#8f98a0]">Unknown</span>}
          </div>

          <div>
            <b>Publisher:</b>{' '}
            {publishers.map((p, idx) => (
              <span key={idx}>
                <button
                  type="button"
                  onClick={() => onApplyFilter?.({ type: 'publisher', label: 'Publisher', value: p })}
                  className="hover:underline hover:text-white transition-colors cursor-pointer text-[#67c1f5]"
                  title={`Filter library by publisher "${p}"`}
                >
                  {p}
                </button>
                {idx < publishers.length - 1 && ', '}
              </span>
            ))}
            {publishers.length === 0 && <span className="text-[#8f98a0]">Unknown</span>}
          </div>

          {franchise && (
            <div>
              <b>Franchise:</b>{' '}
              <button
                type="button"
                onClick={() => onApplyFilter?.({ type: 'tag', label: 'Franchise', value: franchise })}
                className="hover:underline hover:text-white transition-colors cursor-pointer text-[#67c1f5]"
                title={`Filter library by franchise "${franchise}"`}
              >
                {franchise}
              </button>
            </div>
          )}

          <div>
            <b>Release Date:</b> <span className="text-white">{releaseDate || 'TBA'}</span>
          </div>
        </div>
      </div>

      {/* Community & External Links (Exact Steam .linkbar styling) */}
      <div className="space-y-[2px]">
        {/* Discord / Official link */}
        <a
          href="https://discord.gg"
          target="_blank"
          rel="noreferrer"
          className="steam-linkbar-row"
        >
          <span className="flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
            </svg>
            <span>Discord</span>
          </span>
          <ExternalLink className="w-3 h-3 opacity-60" />
        </a>

        {steamAppId && (
          <>
            <a
              href={`https://store.steampowered.com/newshub/?appids=${steamAppId}`}
              target="_blank"
              rel="noreferrer"
              className="steam-linkbar-row"
            >
              <span>View update history</span>
              <ChevronRight className="w-3.5 h-3.5 opacity-60" />
            </a>

            <a
              href={`https://store.steampowered.com/newshub/app/${steamAppId}`}
              target="_blank"
              rel="noreferrer"
              className="steam-linkbar-row"
            >
              <span>Read related news</span>
              <ChevronRight className="w-3.5 h-3.5 opacity-60" />
            </a>

            <a
              href={`https://steamcommunity.com/app/${steamAppId}/discussions/`}
              target="_blank"
              rel="noreferrer"
              className="steam-linkbar-row"
            >
              <span>View discussions</span>
              <ChevronRight className="w-3.5 h-3.5 opacity-60" />
            </a>

            <a
              href={`https://steamcommunity.com/actions/Search?T=ClanAccount&K=${encodeURIComponent(title)}`}
              target="_blank"
              rel="noreferrer"
              className="steam-linkbar-row"
            >
              <span>Find Community Groups</span>
              <ChevronRight className="w-3.5 h-3.5 opacity-60" />
            </a>
          </>
        )}
      </div>

      {legalNotice && (
        <div className="text-[10px] text-[#61686d] leading-normal border-t border-steam-border/30 pt-3">
          {legalNotice}
        </div>
      )}
    </div>
  );
};
