import React from 'react';
import { CanonicalGame } from '../../contracts/game';
import { PlatformBadges } from '../SteamStoreDetail/PlatformBadges';
import { ReviewSentimentBadge } from '../SteamStoreDetail/ReviewSentimentBadge';

import { StorefrontId } from '../../contracts/platform';

interface GameCardProps {
  game: CanonicalGame;
  onSelect: (game: CanonicalGame) => void;
  connectedStorefronts?: StorefrontId[];
}

export const GameCard: React.FC<GameCardProps> = ({ game, onSelect, connectedStorefronts }) => {
  const isInstalled = game.platforms.some((p) => p.installed);

  return (
    <div
      onClick={() => onSelect(game)}
      className="group relative bg-[#16202d] hover:bg-[#1f2d3d] rounded border border-steam-border/60 hover:border-steam-accent/80 transition-all duration-200 cursor-pointer overflow-hidden shadow-lg hover:shadow-2xl hover:-translate-y-1 flex flex-col"
    >
      {/* Capsule Banner Image */}
      <div className="relative aspect-[16/9] w-full overflow-hidden bg-black/60">
        <img
          src={game.headerImage || game.capsuleImage}
          alt={game.title}
          className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          loading="lazy"
          onError={(e) => {
            if (game.capsuleImage && e.currentTarget.src !== game.capsuleImage) {
              e.currentTarget.src = game.capsuleImage;
            }
          }}
        />

        {/* Installed indicator pill */}
        {isInstalled && (
          <span className="absolute top-2 left-2 px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-950/80 text-emerald-400 border border-emerald-500/40 rounded backdrop-blur shadow-sm">
            Installed
          </span>
        )}
      </div>

      {/* Card Content Body */}
      <div className="p-3.5 flex flex-col flex-1 justify-between gap-3">
        <div className="space-y-1.5">
          <h3 className="font-bold text-sm text-white group-hover:text-steam-accent transition-colors line-clamp-1">
            {game.title}
          </h3>

          <div className="flex items-center justify-between text-xs">
            <ReviewSentimentBadge summary={game.reviewSummary} compact />
            <span className="text-[11px] text-steam-subtext font-normal">
              {game.releaseDate || 'TBA'}
            </span>
          </div>
        </div>

        {/* Multi-Store Ownership Badges */}
        <div className="pt-2 border-t border-steam-border/40">
          <PlatformBadges platforms={game.platforms} game={game} size="sm" connectedStorefronts={connectedStorefronts} />
        </div>
      </div>
    </div>
  );
};
