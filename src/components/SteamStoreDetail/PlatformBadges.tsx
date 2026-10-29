import React from 'react';
import { GamePlatformOwnership, CanonicalGame } from '../../contracts/game';
import { STOREFRONT_REGISTRY, StorefrontId } from '../../contracts/platform';
import { StorefrontIcon, getStorefrontDisplayName } from '../Common/StorefrontIcon';
import { CheckCircle2, Cloud } from 'lucide-react';
import { loadIntegrations } from '../../services/integrations/integrationStorage';

export interface StorefrontUrlOptions {
  storefrontUrl?: string;
  gogSlug?: string;
}

export function getStorefrontUrl(
  platformId: string,
  gameTitle?: string,
  steamAppId?: number,
  platformGameId?: string,
  xboxProductId?: string,
  options?: StorefrontUrlOptions
): string | null {
  const title = (gameTitle || '').trim();

  switch (platformId) {
    case 'steam':
      if (steamAppId) {
        return `https://store.steampowered.com/app/${steamAppId}/`;
      }
      if (platformGameId && /^\d+$/.test(platformGameId)) {
        return `https://store.steampowered.com/app/${platformGameId}/`;
      }
      if (title) {
        return `https://store.steampowered.com/search/?term=${encodeURIComponent(title)}`;
      }
      return 'https://store.steampowered.com/';

    case 'gog': {
      const explicitUrl = (options?.storefrontUrl || '').trim();
      if (/^https:\/\/(?:www\.)?gog\.com\//i.test(explicitUrl)) {
        return explicitUrl;
      }
      const explicitSlug = (options?.gogSlug || '').trim().replace(/^\/+|\/+$/g, '');
      if (explicitSlug && /^[a-z0-9_-]+$/i.test(explicitSlug)) {
        return `https://www.gog.com/en/game/${encodeURIComponent(explicitSlug)}`;
      }
      if (title) {
        return `https://www.gog.com/en/games?search=${encodeURIComponent(title)}`;
      }
      return 'https://www.gog.com';
    }

    case 'epic':
      if (title) {
        return `https://store.epicgames.com/en-US/browse?q=${encodeURIComponent(title)}`;
      }
      return 'https://store.epicgames.com/';

    case 'xbox': {
      const bigId = [xboxProductId, platformGameId]
        .map((v) => String(v || '').trim())
        .find((v) => /^[A-Z0-9]{12}$/i.test(v));
      if (bigId) {
        return `https://www.xbox.com/games/store/-/${bigId.toUpperCase()}`;
      }
      if (title) {
        return `https://www.xbox.com/en-us/search?q=${encodeURIComponent(title)}`;
      }
      return 'https://www.xbox.com/';
    }

    case 'amazon':
      return 'https://gaming.amazon.com/';

    case 'ubisoft':
      if (title) {
        return `https://store.ubisoft.com/search?q=${encodeURIComponent(title)}`;
      }
      return 'https://store.ubisoft.com/';

    case 'ea':
      if (title) {
        return `https://www.ea.com/search?q=${encodeURIComponent(title)}`;
      }
      return 'https://www.ea.com/';

    case 'bnet':
      return 'https://shop.battle.net/';

    case 'itch':
      if (title) {
        return `https://itch.io/search?q=${encodeURIComponent(title)}`;
      }
      return 'https://itch.io/';

    default:
      return null;
  }
}

export function openExternalStorefrontUrl(url: string, e?: React.MouseEvent) {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  if (!url) return;
  if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url);
  } else {
    window.open(url, '_blank', 'noreferrer,noopener');
  }
}

function getXboxOwnershipStatus(p: GamePlatformOwnership) {
  if (p.platformId !== 'xbox') {
    return {
      isXboxActiveGamePass: false,
      isXboxExpiredUnplayable: false,
      isLeavingSoon: false,
      tooltipSuffix: '',
    };
  }
  const isXboxExpiredUnplayable = Boolean(
    p.subscriptionExpired && p.ownershipType === 'subscription'
  );
  const isXboxActiveGamePass = Boolean(
    !p.subscriptionExpired &&
      (p.ownershipType === 'subscription' || p.ownershipType === 'owned_and_subscription')
  );
  const isLeavingSoon = Boolean(isXboxActiveGamePass && p.isLeavingSoon);
  let tooltipSuffix = '';
  if (isXboxExpiredUnplayable) {
    tooltipSuffix = ' • Game Pass Subscription Expired';
  } else if (isXboxActiveGamePass && p.ownershipType === 'owned_and_subscription') {
    tooltipSuffix = ` • Owned + Game Pass${isLeavingSoon ? ' (Leaving Soon)' : ''}`;
  } else if (isXboxActiveGamePass && p.ownershipType === 'subscription') {
    tooltipSuffix = ` • Included with Game Pass${isLeavingSoon ? ' (Leaving Soon)' : ''}`;
  }
  return {
    isXboxActiveGamePass,
    isXboxExpiredUnplayable,
    isLeavingSoon,
    tooltipSuffix,
  };
}

interface PlatformBadgesProps {
  platforms: GamePlatformOwnership[];
  game?: CanonicalGame;
  gameTitle?: string;
  steamAppId?: number;
  size?: 'sm' | 'md' | 'lg';
  layout?: 'horizontal' | 'vertical-stacked';
  iconOnly?: boolean;
  connectedStorefronts?: StorefrontId[];
}

export const PlatformBadges: React.FC<PlatformBadgesProps> = ({
  platforms,
  game,
  gameTitle,
  steamAppId,
  size = 'md',
  layout = 'horizontal',
  iconOnly = false,
  connectedStorefronts,
}) => {
  const effectiveTitle = gameTitle || game?.title;
  const effectiveSteamAppId = steamAppId || game?.steamAppId;

  const connectedSet = React.useMemo(() => {
    if (connectedStorefronts && connectedStorefronts.length > 0) {
      return new Set<StorefrontId>(connectedStorefronts);
    }
    try {
      const integrations = loadIntegrations();
      const connected = integrations.filter((i) => i.isConnected).map((i) => i.storefrontId);
      if (connected.length > 0) {
        return new Set<StorefrontId>(connected);
      }
    } catch {
      // Fallback if localStorage or integration system unavailable
    }
    return new Set<StorefrontId>(['steam', 'gog', 'epic', 'xbox']);
  }, [connectedStorefronts]);

  const handleBadgeClick = (url: string | null, e: React.MouseEvent) => {
    if (!url) return;
    openExternalStorefrontUrl(url, e);
  };

  const resolvePlatformUrlOptions = (
    p: GamePlatformOwnership
  ): StorefrontUrlOptions | undefined => {
    const extPlat = p as GamePlatformOwnership & { storefrontUrl?: string; gogSlug?: string };
    const extGame = game as
      | (CanonicalGame & { gogSlug?: string; storefrontUrl?: string })
      | undefined;
    const storefrontUrl = extPlat.storefrontUrl || extGame?.storefrontUrl;
    const gogSlug = extPlat.gogSlug || extGame?.gogSlug;
    return storefrontUrl || gogSlug ? { storefrontUrl, gogSlug } : undefined;
  };

  if (iconOnly) {
    return (
      <div className="flex items-center gap-1.5 flex-nowrap shrink-0">
        {platforms.map((p) => {
          const name = getStorefrontDisplayName(p.platformId);
          const isInstalled = Boolean(p.installed);
          const isPlatConnected = connectedSet.has(p.platformId as StorefrontId);
          const xboxStatus = getXboxOwnershipStatus(p);
          const targetUrl = getStorefrontUrl(
            p.platformId,
            effectiveTitle,
            p.platformId === 'steam' ? effectiveSteamAppId : undefined,
            p.platformGameId,
            p.xboxProductId,
            resolvePlatformUrlOptions(p)
          );

          const badgeClassName = `relative inline-flex items-center justify-center min-w-6 min-h-6 w-6 h-6 rounded border transition-all group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent ${
            targetUrl
              ? 'cursor-pointer hover:scale-110 active:scale-95 shadow-sm'
              : 'cursor-default'
          } ${
            xboxStatus.isXboxExpiredUnplayable
              ? 'border-rose-500/60 bg-rose-950/40 text-rose-300 hover:border-rose-400'
              : isInstalled
              ? 'border-emerald-500/50 bg-emerald-950/40 text-emerald-300 hover:border-emerald-400'
              : isPlatConnected
              ? 'border-[#2a475e] bg-[#16202d] text-slate-300 hover:border-sky-500/60 hover:text-white'
              : 'border-amber-600/50 bg-amber-950/30 text-amber-200 hover:border-amber-500'
          }`;
          const badgeTitle = targetUrl
            ? `Open on ${name} • ${isPlatConnected ? (isInstalled ? 'Installed locally' : 'In Cloud Library') : 'Not Connected'}${xboxStatus.tooltipSuffix}${p.installPath ? ` (${p.installPath})` : ''}`
            : `${name} • ${isPlatConnected ? (isInstalled ? 'Installed locally' : 'In Cloud Library') : 'Not Connected'}${xboxStatus.tooltipSuffix}${p.installPath ? ` (${p.installPath})` : ''}`;

          const badgeInner = (
            <>
              <StorefrontIcon
                storefrontId={p.platformId}
                className="w-3.5 h-3.5 group-hover:scale-110 transition-transform"
              />
              {isInstalled && (
                <span
                  className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 ring-1 ring-[#101822]"
                  title="Installed locally"
                />
              )}
              {!isPlatConnected && (
                <span
                  className="absolute -top-0.5 -left-0.5 w-2 h-2 rounded-full bg-amber-400 ring-1 ring-[#101822]"
                  title="Storefront account not connected"
                />
              )}
              {xboxStatus.isXboxExpiredUnplayable ? (
                <span
                  className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-rose-400 ring-1 ring-[#101822]"
                  title="Game Pass subscription expired"
                />
              ) : xboxStatus.isLeavingSoon ? (
                <span
                  className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400 ring-1 ring-[#101822]"
                  title="Leaving Game Pass soon"
                />
              ) : null}
            </>
          );

          return targetUrl ? (
            <button
              key={p.platformId}
              type="button"
              aria-label={`Open on ${name}`}
              onClick={(e) => handleBadgeClick(targetUrl, e)}
              className={badgeClassName}
              title={badgeTitle}
            >
              {badgeInner}
            </button>
          ) : (
            <div key={p.platformId} className={badgeClassName} title={badgeTitle}>
              {badgeInner}
            </div>
          );
        })}
      </div>
    );
  }

  if (layout === 'vertical-stacked') {
    return (
      <div className="flex flex-wrap items-center gap-2.5">
        {platforms.map((p) => {
          const name = getStorefrontDisplayName(p.platformId);
          const isPlatConnected = connectedSet.has(p.platformId as StorefrontId);
          const xboxStatus = getXboxOwnershipStatus(p);
          const targetUrl = getStorefrontUrl(
            p.platformId,
            effectiveTitle,
            p.platformId === 'steam' ? effectiveSteamAppId : undefined,
            p.platformGameId,
            p.xboxProductId,
            resolvePlatformUrlOptions(p)
          );

          const stackedClassName = `flex flex-col items-center justify-center p-1.5 rounded bg-[#16202d]/90 hover:bg-[#1f2c3d] border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent ${
            xboxStatus.isXboxExpiredUnplayable
              ? 'border-rose-500/60 hover:border-rose-400'
              : isPlatConnected
              ? 'border-steam-border/80 hover:border-steam-accent/70'
              : 'border-amber-500/60'
          } transition-all shadow-sm group min-w-[54px] min-h-6 ${
            targetUrl ? 'cursor-pointer active:scale-95' : 'cursor-default'
          }`;
          const stackedTitle = targetUrl
            ? `Open on ${name} • ${isPlatConnected ? (p.installed ? 'Installed locally' : 'In Cloud Library') : 'Not Connected'}${xboxStatus.tooltipSuffix}`
            : `${name} • ${isPlatConnected ? (p.installed ? 'Installed locally' : 'In Cloud Library') : 'Not Connected'}${xboxStatus.tooltipSuffix}`;

          const stackedInner = (
            <>
              <div className="w-6 h-6 rounded flex items-center justify-center text-white/90 group-hover:text-steam-accent group-hover:scale-110 transition-all">
                <StorefrontIcon storefrontId={p.platformId} className="w-4 h-4" />
              </div>
              <span className="text-[10px] font-semibold text-steam-text/90 group-hover:text-white transition-colors text-center leading-tight mt-0.5">
                {name}
              </span>
              {!isPlatConnected ? (
                <span className="text-[9px] text-amber-400 font-semibold mt-0.5">
                  Not Connected
                </span>
              ) : (
                <div className="flex flex-col items-center gap-0.5 mt-0.5">
                  <div className="flex items-center gap-1">
                    {p.installed ? (
                      <span className="text-[9px] text-emerald-400 font-medium flex items-center gap-0.5">
                        <CheckCircle2 aria-hidden="true" className="w-2.5 h-2.5" /> Installed
                      </span>
                    ) : (
                      <span className="text-[9px] text-sky-400/80 font-medium flex items-center gap-0.5">
                        <Cloud aria-hidden="true" className="w-2.5 h-2.5" /> Cloud
                      </span>
                    )}
                  </div>
                  {xboxStatus.isXboxExpiredUnplayable ? (
                    <span className="text-[8px] px-1 py-0.2 rounded bg-rose-950/80 text-rose-300 border border-rose-500/50 font-bold uppercase tracking-tight">
                      Expired
                    </span>
                  ) : xboxStatus.isLeavingSoon ? (
                    <span className="text-[8px] px-1 py-0.2 rounded bg-amber-950/80 text-amber-300 border border-amber-500/50 font-bold uppercase tracking-tight">
                      Leaving Soon
                    </span>
                  ) : xboxStatus.isXboxActiveGamePass ? (
                    <span className="text-[8px] px-1 py-0.2 rounded bg-emerald-950/80 text-emerald-300 border border-emerald-500/50 font-bold uppercase tracking-tight">
                      Game Pass
                    </span>
                  ) : null}
                </div>
              )}
            </>
          );

          return targetUrl ? (
            <button
              key={p.platformId}
              type="button"
              onClick={(e) => handleBadgeClick(targetUrl, e)}
              className={stackedClassName}
              title={stackedTitle}
            >
              {stackedInner}
            </button>
          ) : (
            <div key={p.platformId} className={stackedClassName} title={stackedTitle}>
              {stackedInner}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {platforms.map((p) => {
        const isPlatConnected = connectedSet.has(p.platformId as StorefrontId);
        const xboxStatus = getXboxOwnershipStatus(p);
        const meta = STOREFRONT_REGISTRY[p.platformId as StorefrontId] || {
          name: p.platformId.toUpperCase(),
          badgeBg: 'bg-zinc-800 border-zinc-700',
          badgeText: 'text-zinc-300',
        };
        const name = getStorefrontDisplayName(p.platformId);
        const targetUrl = getStorefrontUrl(
          p.platformId,
          effectiveTitle,
          p.platformId === 'steam' ? effectiveSteamAppId : undefined,
          p.platformGameId,
          p.xboxProductId,
          resolvePlatformUrlOptions(p)
        );

        const sizeClasses =
          size === 'sm'
            ? 'min-h-6 px-1.5 py-0.5 text-[10px]'
            : size === 'lg'
            ? 'min-h-6 px-3 py-1 text-xs'
            : 'min-h-6 px-2 py-0.5 text-[11px]';

        const pillClassName = `inline-flex items-center gap-1 font-medium border rounded transition-all shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent ${meta.badgeBg} ${meta.badgeText} ${sizeClasses} ${
          targetUrl
            ? 'cursor-pointer hover:brightness-125 hover:border-sky-400/80 active:scale-95'
            : 'cursor-default'
        }`;
        const pillTitle = targetUrl
          ? `Open on ${name} • ${isPlatConnected ? (p.installed ? 'Installed locally' : 'In Cloud Library') : 'Not Connected'}${xboxStatus.tooltipSuffix}${p.installPath ? ` (${p.installPath})` : ''}`
          : `${name} • ${isPlatConnected ? (p.installed ? 'Installed locally' : 'In Cloud Library') : 'Not Connected'}${xboxStatus.tooltipSuffix}${p.installPath ? ` (${p.installPath})` : ''}`;

        const pillInner = (
          <>
            <StorefrontIcon
              storefrontId={p.platformId}
              className="w-3 h-3 group-hover:scale-110 transition-transform"
            />
            <span>{name}</span>
            {xboxStatus.isXboxExpiredUnplayable ? (
              <span className="text-[9px] px-1 py-0.2 rounded bg-rose-950/80 text-rose-300 border border-rose-500/50 font-bold uppercase tracking-tight">
                Expired
              </span>
            ) : xboxStatus.isXboxActiveGamePass ? (
              <>
                <span className="text-[9px] px-1 py-0.2 rounded bg-emerald-950/80 text-emerald-300 border border-emerald-500/50 font-bold uppercase tracking-tight">
                  GP
                </span>
                {xboxStatus.isLeavingSoon && (
                  <span className="text-[9px] px-1 py-0.2 rounded bg-amber-950/80 text-amber-300 border border-amber-500/50 font-semibold">
                    Leaving Soon
                  </span>
                )}
              </>
            ) : null}
            {!isPlatConnected && (
              <span className="text-[9px] px-1 py-0.2 rounded bg-amber-950/70 text-amber-300 border border-amber-500/50 font-semibold">
                Not Connected
              </span>
            )}
            {p.installed ? (
              <span className="flex items-center text-emerald-400" title="Installed">
                <CheckCircle2 aria-hidden="true" className="w-2.5 h-2.5" />
              </span>
            ) : (
              <span className="opacity-50 text-[10px]" title="Cloud Library">
                <Cloud aria-hidden="true" className="w-2.5 h-2.5" />
              </span>
            )}
          </>
        );

        return targetUrl ? (
          <button
            key={p.platformId}
            type="button"
            onClick={(e) => handleBadgeClick(targetUrl, e)}
            className={pillClassName}
            title={pillTitle}
          >
            {pillInner}
          </button>
        ) : (
          <span key={p.platformId} className={pillClassName} title={pillTitle}>
            {pillInner}
          </span>
        );
      })}
    </div>
  );
};
