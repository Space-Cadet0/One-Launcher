import React from 'react';
import { AlertTriangle, ChevronRight, ExternalLink, Globe, Link2, ShieldCheck } from 'lucide-react';
import { ActiveGameFilter } from '../../contracts/filter';
import type { CanonicalGame, GamePlatformOwnership } from '../../contracts/game';
import type { StorefrontId } from '../../contracts/platform';
import {
  EA_DRM_BACKGROUND_REQUIRED_RE,
  detectStructuralKernelAntiCheatFromNotices,
  isBattlEyeKernelAntiCheat,
  normalizeChainedHandoffId,
  resolveCanonicalKernelAntiCheatDisplayName,
  type NormalizedChainedHandoffId,
} from '../../services/integrations/catalogSanitizer';
import { launcherService } from '../../services/launcher/launcherService';

function stripNoticeHtml(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/<br\s*\/?>/gi, ' • ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&rsquo;/gi, "'")
    .replace(/\s+/g, ' ')
    .replace(/^(?:\s*•\s*)+|(?:\s*•\s*)+$/g, '')
    .trim();
}

function getSourceStoreLabel(platformId?: string | null): string {
  const pid = String(platformId || '').trim().toLowerCase();
  switch (pid) {
    case 'xbox':
      return 'Xbox';
    case 'epic':
      return 'Epic Games';
    case 'steam':
      return 'Steam';
    default:
      return 'Xbox / Epic / Steam';
  }
}

export function synthesizeChainedLauncherNotice(
  handoffId: NormalizedChainedHandoffId,
  sourcePlatformId?: string | null
): { heading: string; message: string } {
  const storeLabel = getSourceStoreLabel(sourcePlatformId);
  switch (handoffId) {
    case 'ea':
      return {
        heading: 'Requires EA App',
        message: `Requires EA App and an EA Account linked to your ${storeLabel} account.`,
      };
    case 'ubisoft':
      return {
        heading: 'Requires Ubisoft Connect',
        message: `Requires Ubisoft Connect and a Ubisoft Account linked to your ${storeLabel} account.`,
      };
    case 'bnet':
      return {
        heading: 'Requires Battle.net',
        message: `Requires Battle.net and a Battle.net Account linked to your ${storeLabel} account.`,
      };
    case 'rockstar':
      return {
        heading: 'Requires Rockstar Launcher',
        message: `Requires Rockstar Games Launcher and a Rockstar Games account linked to your ${storeLabel} account.`,
      };
    case 'riot':
      return {
        heading: 'Requires Riot Client',
        message: `Requires Riot Client and a Riot Account linked to your ${storeLabel} account.`,
      };
  }
}

export interface SteamSidebarNoticesProps {
  title: string;
  steamAppId?: number;
  genres: string[];
  developers: string[];
  publishers: string[];
  releaseDate?: string;
  franchise?: string;
  legalNotice?: string;
  website?: string;
  deckCompatibility?: 'verified' | 'playable' | 'unsupported' | 'unknown';
  onApplyFilter?: (filter: ActiveGameFilter) => void;
  game?: CanonicalGame;
  platforms?: GamePlatformOwnership[];
  activePlatform?: GamePlatformOwnership | null;
  activePlatformId?: StorefrontId | string | null;
  drmNotice?: string | null;
  extUserAccountNotice?: string | null;
  chainedLauncherHandoff?: string | null;
  externalStorefrontHandoff?: string | null;
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
  website,
  deckCompatibility,
  onApplyFilter,
  game,
  platforms,
  activePlatform,
  activePlatformId,
  drmNotice,
  extUserAccountNotice,
  chainedLauncherHandoff,
  externalStorefrontHandoff,
}) => {
  const validWebsiteUrl =
    typeof website === 'string' && /^https?:\/\//i.test(website.trim())
      ? website.trim()
      : null;

  const candidatePlatforms = platforms || game?.platforms || [];
  const resolvedActivePlat =
    activePlatform ||
    (activePlatformId
      ? candidatePlatforms.find((p) => p?.platformId === activePlatformId)
      : undefined) ||
    candidatePlatforms.find((p) =>
      Boolean(p?.chainedLauncherHandoff || p?.externalStorefrontHandoff)
    ) ||
    candidatePlatforms[0];

  const rawDrmNotice =
    drmNotice ??
    game?.enrichedMetadata?.drmNotice ??
    (game as { drmNotice?: string } | undefined)?.drmNotice ??
    null;
  const plainDrmNotice = stripNoticeHtml(rawDrmNotice);

  const rawExtAccountNotice =
    extUserAccountNotice ?? game?.enrichedMetadata?.extUserAccountNotice ?? null;
  const plainExtAccountNotice = stripNoticeHtml(rawExtAccountNotice);

  const inferredDrmHandoff =
    plainDrmNotice && EA_DRM_BACKGROUND_REQUIRED_RE.test(plainDrmNotice) && resolvedActivePlat?.platformId !== 'gog'
      ? 'ea'
      : undefined;

  const resolvedHandoffId = normalizeChainedHandoffId(
    chainedLauncherHandoff ||
      externalStorefrontHandoff ||
      resolvedActivePlat?.chainedLauncherHandoff ||
      resolvedActivePlat?.externalStorefrontHandoff ||
      inferredDrmHandoff
  );

  const activeSourcePid = resolvedActivePlat?.platformId || activePlatformId || null;
  const shouldShowChainedNotice = Boolean(
    resolvedHandoffId &&
      resolvedHandoffId !== String(activeSourcePid || '').toLowerCase()
  );

  const synthesizedChainedNotice =
    shouldShowChainedNotice && resolvedHandoffId
      ? synthesizeChainedLauncherNotice(resolvedHandoffId, activeSourcePid)
      : null;

  const showSupplementalDrmText = Boolean(
    plainDrmNotice &&
      (!synthesizedChainedNotice ||
        plainDrmNotice.toLowerCase() !== synthesizedChainedNotice.message.toLowerCase()) &&
      !(
        resolvedHandoffId === 'ea' &&
        /^incorporates 3rd-party drm:\s*(?:ea\s+app|origin(?:\s+client)?)\s+software\s+installation\s+and\s+background\s+use\s+required\.?$/i.test(
          plainDrmNotice
        )
      )
  );
  const showSupplementalAccountText = Boolean(
    plainExtAccountNotice &&
      (!synthesizedChainedNotice ||
        !synthesizedChainedNotice.message
          .toLowerCase()
          .includes(plainExtAccountNotice.toLowerCase()))
  );

  const isWindowsHost =
    (typeof (launcherService as { isWindowsHost?: () => boolean }).isWindowsHost === 'function' &&
      (launcherService as { isWindowsHost: () => boolean }).isWindowsHost()) ||
    (typeof window !== 'undefined' && window.electronAPI?.platform === 'win32');

  const hasNativeMacForActiveEntry = Boolean(
    resolvedActivePlat?.isCrossPlatformLauncherRuntime ||
      resolvedActivePlat?.platforms?.mac === true ||
      (!resolvedActivePlat && game?.platforms_os?.mac === true)
  );
  const structuralAntiCheat = detectStructuralKernelAntiCheatFromNotices(
    plainDrmNotice,
    resolvedActivePlat?.xboxBottleCompatibilityReason
  );
  const rawKernelAntiCheatLabel =
    resolvedActivePlat?.kernelAntiCheatName ||
    game?.kernelAntiCheatName ||
    resolvedActivePlat?.antiCheatName ||
    game?.antiCheatName ||
    structuralAntiCheat?.kernelAntiCheatName ||
    (resolvedHandoffId === 'riot' ? 'Riot Vanguard' : undefined);
  const resolvedKernelAntiCheatLabel =
    resolveCanonicalKernelAntiCheatDisplayName(rawKernelAntiCheatLabel) ||
    rawKernelAntiCheatLabel;
  const shouldShowMacKernelAntiCheatNotice = Boolean(
    !isWindowsHost &&
      !hasNativeMacForActiveEntry &&
      (resolvedHandoffId === 'riot' ||
        resolvedActivePlat?.xboxBottleCompatibilityTier === 'tier_c_kernel_anticheat' ||
        resolvedActivePlat?.requiresKernelAntiCheat ||
        game?.requiresKernelAntiCheat ||
        structuralAntiCheat)
  );
  const isBattlEyeNotice = isBattlEyeKernelAntiCheat(resolvedKernelAntiCheatLabel);

  const handleOpenExternalLink = (e: React.MouseEvent<HTMLAnchorElement>, url: string) => {
    if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
      e.preventDefault();
      void window.electronAPI.openExternal(url);
    }
  };

  return (
    <div className="space-y-4">
      {(synthesizedChainedNotice || showSupplementalDrmText || showSupplementalAccountText) && (
        <div
          role="note"
          data-testid="sidebar-chained-launcher-notice"
          className="p-3 bg-[#1b2838] border border-amber-400/55 rounded-sm space-y-1.5"
        >
          {synthesizedChainedNotice && (
            <>
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-amber-200">
                <Link2 aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-amber-300" />
                <span>{synthesizedChainedNotice.heading}</span>
              </div>
              <p className="text-xs text-amber-100 leading-relaxed">
                {synthesizedChainedNotice.message}
              </p>
            </>
          )}
          {showSupplementalDrmText && (
            <p className="text-[11px] text-amber-200 leading-relaxed">{plainDrmNotice}</p>
          )}
          {showSupplementalAccountText && !synthesizedChainedNotice && (
            <p className="text-[11px] text-amber-200 leading-relaxed">
              Requires 3rd-Party Account: {plainExtAccountNotice}
            </p>
          )}
        </div>
      )}

      {shouldShowMacKernelAntiCheatNotice && (
        <div
          role="status"
          data-testid="sidebar-kernel-anticheat-notice"
          className={
            isBattlEyeNotice
              ? 'p-3 bg-[#2b1f0e] border border-amber-400/55 rounded-sm space-y-1.5'
              : 'p-3 bg-[#2a1219] border border-rose-500/50 rounded-sm space-y-1.5'
          }
        >
          <div
            className={`flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider ${
              isBattlEyeNotice ? 'text-amber-200' : 'text-rose-200'
            }`}
          >
            {isBattlEyeNotice ? (
              <AlertTriangle
                aria-hidden="true"
                className="w-3.5 h-3.5 shrink-0 text-amber-300"
              />
            ) : (
              <ShieldCheck
                aria-hidden="true"
                className="w-3.5 h-3.5 shrink-0 text-rose-300"
              />
            )}
            <span>
              {isBattlEyeNotice
                ? 'BattlEye Online Anti-Cheat Notice (macOS Bottle)'
                : `Kernel Anti-Cheat Required (${
                    resolvedKernelAntiCheatLabel || 'Windows Kernel Anti-Cheat'
                  })`}
            </span>
          </div>
          <p
            className={`text-xs leading-relaxed ${
              isBattlEyeNotice ? 'text-amber-100' : 'text-rose-100'
            }`}
          >
            {isBattlEyeNotice
              ? 'Online multiplayer sessions requiring BattlEye (BEDaisy.sys Windows kernel driver) cannot load inside macOS CrossOver / Wine bottles, while offline Story Mode (-nobattleye) remains playable where supported.'
              : `Requires ${
                  resolvedKernelAntiCheatLabel || 'Windows kernel anti-cheat'
                }, whose Windows ring-0 kernel driver cannot load inside macOS CrossOver / Wine bottles.`}
          </p>
        </div>
      )}

      {/* Steam Deck Compatibility Section (Only shown when real compatibility status is known) */}
      {deckCompatibility && deckCompatibility !== 'unknown' && (
        <div className="mb-4">
          <div className="steam-block-title">Steam Deck Compatibility</div>
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
            {deckCompatibility === 'verified' ? (
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
            ) : deckCompatibility === 'playable' ? (
              <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-white bg-[#1b2838]/90 border border-amber-400/50 px-2 py-0.5 rounded-sm">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" />
                <span className="tracking-wide text-amber-300">PLAYABLE</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-white bg-[#1b2838]/90 border border-slate-500/50 px-2 py-0.5 rounded-sm">
                <span className="w-2.5 h-2.5 rounded-full bg-slate-400 inline-block" />
                <span className="tracking-wide text-slate-300">UNSUPPORTED</span>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Steam Details Block (Exact .game_details layout) */}
      <div className="steam-game-details mb-4">
        <div className="space-y-0.5">
          <div>
            <b>Title:</b> <span className="text-white">{title}</span>
          </div>

          {genres.length > 0 && (
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
          )}

          <div>
            <b>Developer:</b>{' '}
            {developers.map((d, idx) => (
              <span key={idx}>
                <button
                  type="button"
                  onClick={() =>
                    onApplyFilter?.({ type: 'developer', label: 'Developer', value: d })
                  }
                  className="hover:underline hover:text-white transition-colors cursor-pointer text-[#67c1f5]"
                  title={`Filter library by developer "${d}"`}
                >
                  {d}
                </button>
                {idx < developers.length - 1 && ', '}
              </span>
            ))}
            {developers.length === 0 && <span className="text-[#94a3b8]">Unknown</span>}
          </div>

          <div>
            <b>Publisher:</b>{' '}
            {publishers.map((p, idx) => (
              <span key={idx}>
                <button
                  type="button"
                  onClick={() =>
                    onApplyFilter?.({ type: 'publisher', label: 'Publisher', value: p })
                  }
                  className="hover:underline hover:text-white transition-colors cursor-pointer text-[#67c1f5]"
                  title={`Filter library by publisher "${p}"`}
                >
                  {p}
                </button>
                {idx < publishers.length - 1 && ', '}
              </span>
            ))}
            {publishers.length === 0 && <span className="text-[#94a3b8]">Unknown</span>}
          </div>

          {franchise && (
            <div>
              <b>Franchise:</b>{' '}
              <button
                type="button"
                onClick={() =>
                  onApplyFilter?.({ type: 'tag', label: 'Franchise', value: franchise })
                }
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

      {/* Community & External Links (Only rendered when real URLs / AppIDs exist) */}
      {(validWebsiteUrl || Boolean(steamAppId && steamAppId > 0)) && (
        <div className="space-y-[2px]">
          {validWebsiteUrl && (
            <a
              href={validWebsiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => handleOpenExternalLink(e, validWebsiteUrl)}
              className="steam-linkbar-row"
            >
              <span className="flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5" />
                <span>Visit the website</span>
              </span>
              <ExternalLink className="w-3 h-3 opacity-60" />
            </a>
          )}

          {Boolean(steamAppId && steamAppId > 0) && (
            <>
              <a
                href={`https://store.steampowered.com/newshub/?appids=${steamAppId}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) =>
                  handleOpenExternalLink(
                    e,
                    `https://store.steampowered.com/newshub/?appids=${steamAppId}`
                  )
                }
                className="steam-linkbar-row"
              >
                <span>View update history</span>
                <ChevronRight className="w-3.5 h-3.5 opacity-60" />
              </a>

              <a
                href={`https://store.steampowered.com/newshub/app/${steamAppId}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) =>
                  handleOpenExternalLink(
                    e,
                    `https://store.steampowered.com/newshub/app/${steamAppId}`
                  )
                }
                className="steam-linkbar-row"
              >
                <span>Read related news</span>
                <ChevronRight className="w-3.5 h-3.5 opacity-60" />
              </a>

              <a
                href={`https://steamcommunity.com/app/${steamAppId}/discussions/`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) =>
                  handleOpenExternalLink(
                    e,
                    `https://steamcommunity.com/app/${steamAppId}/discussions/`
                  )
                }
                className="steam-linkbar-row"
              >
                <span>View discussions</span>
                <ChevronRight className="w-3.5 h-3.5 opacity-60" />
              </a>

              <a
                href={`https://steamcommunity.com/actions/Search?T=ClanAccount&K=${encodeURIComponent(
                  title
                )}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) =>
                  handleOpenExternalLink(
                    e,
                    `https://steamcommunity.com/actions/Search?T=ClanAccount&K=${encodeURIComponent(
                      title
                    )}`
                  )
                }
                className="steam-linkbar-row"
              >
                <span>Find Community Groups</span>
                <ChevronRight className="w-3.5 h-3.5 opacity-60" />
              </a>
            </>
          )}
        </div>
      )}

      {legalNotice && (
        <div className="text-[10px] text-[#94a3b8] leading-normal border-t border-steam-border/30 pt-3">
          {legalNotice}
        </div>
      )}
    </div>
  );
};
