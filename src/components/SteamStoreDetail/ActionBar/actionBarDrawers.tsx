import React from 'react';
import { CanonicalGame, GamePlatformOwnership } from '../../../contracts/game';
import { SteamEnrichedMetadata } from '../../../contracts/steam';
import { STOREFRONT_REGISTRY, StorefrontId } from '../../../contracts/platform';
import { StorefrontIcon, getStorefrontDisplayName } from '../../Common/StorefrontIcon';
import { formatPlaytime } from '../../../utils/dateUtils';
import { launcherService } from '../../../services/launcher/launcherService';
import { getStorefrontNativeOsFlags } from '../../../services/platform/nativeOsService';
import {
  detectStructuralKernelAntiCheatFromNotices,
  isBattlEyeKernelAntiCheat,
  normalizeChainedHandoffId,
  resolveCanonicalKernelAntiCheatDisplayName,
} from '../../../services/integrations/catalogSanitizer';
import {
  Clock,
  Trophy,
  X,
  ChevronRight,
  ShieldCheck,
  AlertTriangle,
  Cpu,
} from 'lucide-react';
import {
  PlatformAchievementSummary,
  resolvePublisherHandoffLabel,
} from './actionBarTypes';

export function renderPlaytimeBreakdownDrawer(params: {
  game: CanonicalGame;
  totalPlaytimeMinutes: number;
  formatPlatformLastPlayed: (raw?: string | number) => string | null;
  onClose: () => void;
}): React.ReactElement {
  const { game, totalPlaytimeMinutes, formatPlatformLastPlayed, onClose } = params;
  return (
    <div className="mt-4 pt-3.5 border-t border-[#2a475e]/70">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-sky-400" aria-hidden="true" />
          <span className="text-xs font-bold text-white tracking-wide">
            Storefront Playtime Breakdown
          </span>
          <span className="text-[10px] text-steam-subtext font-normal">
            ({game.platforms.length} connected storefronts)
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-steam-subtext hover:text-white px-2 py-0.5 rounded hover:bg-white/10 text-xs flex items-center gap-1 cursor-pointer transition-colors"
          title="Close storefront playtime breakdown"
        >
          <span className="text-[11px]">Close</span>
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {game.platforms.map((plat) => {
          const reg = STOREFRONT_REGISTRY[plat.platformId];
          const platMinutes = plat.playtimeMinutes || 0;
          const sharePct =
            totalPlaytimeMinutes > 0
              ? Math.round((platMinutes / totalPlaytimeMinutes) * 100)
              : 0;
          const platLastPlayed = formatPlatformLastPlayed(plat.lastPlayed);

          return (
            <div
              key={plat.platformId}
              className="bg-[#141d28] p-3 rounded border border-steam-border/50 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <div className="flex items-center gap-1.5 font-semibold text-white">
                    <StorefrontIcon
                      storefrontId={plat.platformId}
                      decorative
                      className={`w-3.5 h-3.5 ${
                        plat.platformId === 'xbox' ? 'text-[#52d652]' : 'text-steam-accent'
                      }`}
                    />
                    <span>{reg?.name || plat.platformId}</span>
                  </div>
                  {plat.installed && (
                    <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-1.5 py-0.2 rounded">
                      Installed
                    </span>
                  )}
                </div>

                <div className="flex items-baseline justify-between mt-1">
                  <span className="text-sm font-bold text-white">
                    {formatPlaytime(platMinutes)}
                  </span>
                  <span className="text-xs font-semibold text-sky-400">{sharePct}%</span>
                </div>

                {platLastPlayed && platLastPlayed !== 'Never' && (
                  <div className="text-[10px] text-[#94a3b8] mt-1">
                    Last played: {platLastPlayed}
                  </div>
                )}
              </div>

              <div className="w-full bg-[#1b2838] h-1.5 rounded-full mt-2 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all bg-sky-400"
                  style={{ width: `${Math.min(100, sharePct)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function renderAchievementsBreakdownDrawer(params: {
  platformAchievements: PlatformAchievementSummary[];
  onViewAchievements?: (storefrontId?: StorefrontId) => void;
  onClose: () => void;
}): React.ReactElement {
  const { platformAchievements, onViewAchievements, onClose } = params;
  return (
    <div className="mt-4 pt-3.5 border-t border-[#2a475e]/70">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-amber-400" aria-hidden="true" />
          <span className="text-xs font-bold text-white tracking-wide">
            Storefront Achievements Breakdown
          </span>
          <span className="text-[10px] text-steam-subtext font-normal">
            ({platformAchievements.length} connected storefronts)
          </span>
        </div>
        <div className="flex items-center gap-2">
          {onViewAchievements && (
            <button
              type="button"
              onClick={() => onViewAchievements()}
              className="px-2.5 py-1 rounded bg-[#1b2838] hover:bg-[#25394e] text-xs font-semibold text-steam-accent border border-steam-accent/40 flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Trophy className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
              <span>View All Achievements...</span>
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-steam-subtext hover:text-white px-2 py-0.5 rounded hover:bg-white/10 text-xs flex items-center gap-1 cursor-pointer transition-colors"
            title="Close storefront achievements"
          >
            <span className="text-[11px]">Close</span>
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {platformAchievements.map((plat) => (
          <div
            key={plat.platformId}
            className="bg-[#141d28] p-3 rounded border border-steam-border/50 flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <div className="flex items-center gap-1.5 font-semibold text-white">
                  <StorefrontIcon
                    storefrontId={plat.platformId}
                    decorative
                    className={`w-3.5 h-3.5 ${
                      plat.platformId === 'xbox' ? 'text-[#52d652]' : 'text-steam-accent'
                    }`}
                  />
                  <span>{plat.platformName}</span>
                </div>
                {plat.isMastered && (
                  <span className="text-[10px] font-black text-amber-300 bg-amber-400/15 border border-amber-400/40 px-1.5 py-0.2 rounded">
                    ★ Mastered
                  </span>
                )}
              </div>

              <div className="flex items-baseline justify-between mt-1">
                {plat.total > 0 ? (
                  <>
                    <span className="text-sm font-bold text-white">
                      {plat.unlocked}{' '}
                      <span className="text-xs text-steam-subtext font-normal">/ {plat.total}</span>
                    </span>
                    <span className="text-xs font-semibold text-amber-400">{plat.percentage}%</span>
                  </>
                ) : plat.unlocked > 0 || (plat.gamerscore && plat.gamerscore.total > 0) ? (
                  <span className="text-sm font-bold text-white">{plat.unlocked} Unlocked</span>
                ) : (
                  <span className="text-xs text-steam-subtext">No Achievements</span>
                )}
              </div>

              {plat.gamerscore && plat.gamerscore.total > 0 && (
                <div className="text-[10px] text-emerald-400 font-mono mt-1">
                  Gamerscore: {plat.gamerscore.earned} / {plat.gamerscore.total} G
                </div>
              )}
              {plat.xp && plat.xp.total > 0 && (
                <div className="text-[10px] text-sky-400 font-mono mt-1">
                  XP: {plat.xp.earned} / {plat.xp.total} XP
                </div>
              )}
            </div>

            {(plat.total > 0 || (plat.gamerscore && plat.gamerscore.total > 0)) && (
              <div className="w-full bg-[#1b2838] h-1.5 rounded-full mt-2.5 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    plat.isMastered || plat.percentage >= 100
                      ? 'bg-gradient-to-r from-amber-400 to-yellow-300'
                      : 'bg-amber-400'
                  }`}
                  style={{ width: `${Math.min(100, plat.percentage)}%` }}
                />
              </div>
            )}

            {(plat.total > 0 ||
              plat.unlocked > 0 ||
              (plat.gamerscore && plat.gamerscore.total > 0)) &&
              onViewAchievements && (
                <button
                  type="button"
                  onClick={() => onViewAchievements(plat.platformId)}
                  className="mt-3 w-full py-1.5 px-2 rounded bg-[#1b2838] hover:bg-[#25394e] text-xs font-semibold text-steam-accent flex items-center justify-center gap-1 transition-colors cursor-pointer border border-[#2a475e]/60"
                >
                  <span>View Achievements</span>
                  <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function renderMacCompatHandoffBanner(params: {
  game: CanonicalGame;
  metadata?: SteamEnrichedMetadata | null;
  activePlatform?: GamePlatformOwnership;
  selectedPlatformId: StorefrontId;
}): React.ReactElement | null {
  const { game, metadata, activePlatform, selectedPlatformId } = params;
  const cachedInfo = launcherService.getCachedInstallInfo(game.id, selectedPlatformId);
  const rawHandoffKey =
    activePlatform?.chainedLauncherHandoff ||
    activePlatform?.externalStorefrontHandoff ||
    cachedInfo?.chainedLauncherHandoff ||
    cachedInfo?.externalStorefrontHandoff ||
    cachedInfo?.xboxCompatibility?.chainedLauncherHandoff ||
    cachedInfo?.xboxCompatibility?.externalStorefrontHandoff ||
    activePlatform?.externalLauncher ||
    cachedInfo?.externalLauncher ||
    '';
  const normalizedHandoff = normalizeChainedHandoffId(rawHandoffKey);
  const handoffKey =
    normalizedHandoff && normalizedHandoff !== String(selectedPlatformId).toLowerCase()
      ? normalizedHandoff
      : '';
  const compatTier =
    activePlatform?.xboxBottleCompatibilityTier || cachedInfo?.xboxCompatibility?.tier;
  const isCrossPlatformLauncher = Boolean(activePlatform?.isCrossPlatformLauncherRuntime);
  const storeOsFlags = getStorefrontNativeOsFlags(game, selectedPlatformId);
  const hasNativeMacForSelectedStore = Boolean(
    isCrossPlatformLauncher ||
      activePlatform?.platforms?.mac === true ||
      (!handoffKey && storeOsFlags.mac)
  );

  if (hasNativeMacForSelectedStore) return null;

  const structuralNotice = detectStructuralKernelAntiCheatFromNotices(
    metadata?.drmNotice,
    game.enrichedMetadata?.drmNotice,
    (game as { drmNotice?: string }).drmNotice,
    activePlatform?.xboxBottleCompatibilityReason,
    cachedInfo?.xboxBottleCompatibilityReason
  );
  const rawAntiCheatLabel =
    activePlatform?.kernelAntiCheatName ||
    cachedInfo?.kernelAntiCheatName ||
    game.kernelAntiCheatName ||
    activePlatform?.antiCheatName ||
    cachedInfo?.antiCheatName ||
    cachedInfo?.xboxCompatibility?.antiCheatName ||
    game.antiCheatName ||
    structuralNotice?.kernelAntiCheatName ||
    (handoffKey === 'riot' ? 'Riot Vanguard' : undefined);
  const resolvedAntiCheatLabel =
    resolveCanonicalKernelAntiCheatDisplayName(rawAntiCheatLabel) ||
    rawAntiCheatLabel ||
    'Windows Kernel Anti-Cheat';

  const hasKernelAntiCheat = Boolean(
    handoffKey === 'riot' ||
      compatTier === 'tier_c_kernel_anticheat' ||
      activePlatform?.requiresKernelAntiCheat ||
      cachedInfo?.requiresKernelAntiCheat ||
      cachedInfo?.xboxCompatibility?.antiCheatDetected ||
      game.requiresKernelAntiCheat ||
      structuralNotice
  );

  if (hasKernelAntiCheat) {
    if (isBattlEyeKernelAntiCheat(resolvedAntiCheatLabel)) {
      const launcherContextLabel = handoffKey
        ? resolvePublisherHandoffLabel(
            handoffKey,
            activePlatform?.externalLauncher ||
              cachedInfo?.externalLauncher ||
              cachedInfo?.xboxCompatibility?.externalLauncher ||
              cachedInfo?.xboxCompatibility?.externalStorefront
          )
        : null;
      return (
        <div
          data-testid="actionbar-compat-handoff-banner"
          role="status"
          className="mt-3 px-3.5 py-2.5 rounded-lg bg-[#2b1f0e] border border-amber-400/55 text-xs text-amber-100 flex items-start gap-2.5"
        >
          <AlertTriangle
            className="w-4 h-4 text-amber-300 shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <div className="space-y-0.5 leading-relaxed">
            <div className="font-bold text-amber-200 uppercase tracking-wider text-[10px]">
              Kernel Anti-Cheat Notice • BattlEye (Online Multiplayer Blocked on macOS)
            </div>
            <p className="text-amber-100">
              Online multiplayer sessions requiring BattlEye (BEDaisy.sys Windows kernel driver)
              cannot load inside macOS CrossOver / Wine bottles, while offline single-player Story
              Mode (-nobattleye) remains playable where supported.
              {launcherContextLabel && selectedPlatformId === 'xbox'
                ? ` Xbox Game Pass unlocks this title inside ${launcherContextLabel} via a linked Xbox account.`
                : ''}
            </p>
          </div>
        </div>
      );
    }

    return (
      <div
        data-testid="actionbar-compat-handoff-banner"
        role="status"
        className="mt-3 px-3.5 py-2.5 rounded-lg bg-[#2a1219] border border-rose-500/50 text-xs text-rose-100 flex items-start gap-2.5"
      >
        <ShieldCheck className="w-4 h-4 text-rose-300 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-0.5 leading-relaxed">
          <div className="font-bold text-rose-200 uppercase tracking-wider text-[10px]">
            Windows Kernel Anti-Cheat Required ({resolvedAntiCheatLabel})
          </div>
          <p className="text-rose-100">
            This Windows title requires {resolvedAntiCheatLabel}, whose Windows ring-0 kernel driver
            cannot load inside a macOS CrossOver / Wine bottle. Play on native Windows instead.
          </p>
        </div>
      </div>
    );
  }

  if (handoffKey || compatTier === 'tier_c_external_launcher') {
    const launcherLabel = resolvePublisherHandoffLabel(
      handoffKey,
      activePlatform?.externalLauncher ||
        cachedInfo?.externalLauncher ||
        cachedInfo?.xboxCompatibility?.externalLauncher ||
        cachedInfo?.xboxCompatibility?.externalStorefront
    );
    return (
      <div
        data-testid="actionbar-compat-handoff-banner"
        role="status"
        className="mt-3 px-3.5 py-2.5 rounded-lg bg-[#101e2e] border border-sky-500/40 text-xs text-slate-100 flex items-start gap-2.5"
      >
        <Cpu className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-0.5 leading-relaxed">
          <div className="font-bold text-sky-300 uppercase tracking-wider text-[10px]">
            Windows Game • Chained Compatibility Bottle ({launcherLabel})
          </div>
          <p className="text-slate-200">
            This is a Windows build distributed via {getStorefrontDisplayName(selectedPlatformId)}.
            One Launcher automatically sets up {launcherLabel} inside your CrossOver / Wine bottle
            so you can sign in with
            {selectedPlatformId === 'xbox'
              ? ` the ${launcherLabel} account linked to your Xbox profile to download and play.`
              : ' your linked account to download and play.'}
          </p>
        </div>
      </div>
    );
  }

  return null;
}
