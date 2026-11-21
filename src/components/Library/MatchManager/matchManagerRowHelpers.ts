import React from 'react';
import { CanonicalGame, GamePlatformOwnership } from '../../../contracts/game';
import { toOlMediaUrl } from '../../../contracts/network';
import { UserGameOverride } from '../../../contracts/override';
import { StorefrontId } from '../../../contracts/platform';
import { SuppressedCatalogEntry } from '../../../services/integrations/catalogSanitizer';
import { launcherService } from '../../../services/launcher/launcherService';
import { getUserOverrideForGame } from '../../../services/storage/userOverrideStorage';
import {
  AutoFilteredSubCounts,
  AutoFilteredSubFilter,
  MatchStudioSectionKey,
  UnmatchedSubCounts,
  UnmatchedSubFilter,
} from './matchManagerTypes';

export interface ResetOverrideContext {
  game?: CanonicalGame | null;
  override?: UserGameOverride | null;
}

export interface MatchManagerRowRenderContext {
  toggleSection: (key: MatchStudioSectionKey) => void;
  unmatchedSubFilter: UnmatchedSubFilter;
  setUnmatchedSubFilter: (filter: UnmatchedSubFilter) => void;
  unmatchedSubCounts: UnmatchedSubCounts;
  autoFilteredSubFilter: AutoFilteredSubFilter;
  setAutoFilteredSubFilter: (filter: AutoFilteredSubFilter) => void;
  autoFilteredSubCounts: AutoFilteredSubCounts;
  filteredAutoFilteredEntries: SuppressedCatalogEntry[];
  selectedVisibleEntries: SuppressedCatalogEntry[];
  selectedNonGameIds: Set<string>;
  setSelectedNonGameIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  handleInspect?: (game: CanonicalGame) => void;
  handleReset?: (gameId: string, context?: ResetOverrideContext) => void;
  onFixMatchForGame: (game: CanonicalGame) => void;
  onHideGame?: (game: CanonicalGame, targetPlatformId?: StorefrontId) => void;
  onUnhideEntry?: (entry: SuppressedCatalogEntry) => void;
  onClose: () => void;
  handleOpenExternalUrl: (url?: string) => void;
}

export function getValidPlatforms(game?: Partial<CanonicalGame> | null): GamePlatformOwnership[] {
  if (!game || !Array.isArray(game.platforms)) return [];
  return game.platforms.filter(
    (p): p is GamePlatformOwnership => Boolean(p && typeof p === 'object' && p.platformId)
  );
}

export function resolveStudioRowThumbnailSrc(game: CanonicalGame): string | undefined {
  if (!game) return undefined;
  const override = getUserOverrideForGame(game);
  const rawSrc =
    override?.capsuleImage ||
    game.capsuleImage ||
    override?.headerImage ||
    game.headerImage;
  if (!rawSrc) return undefined;
  const hasCustomOverrideArt = Boolean(override?.capsuleImage || override?.headerImage);
  const platforms = getValidPlatforms(game);
  const gogPlat = platforms.find((p) => p.platformId === 'gog');
  const epicPlat = platforms.find((p) => p.platformId === 'epic');
  const xboxPlat = platforms.find((p) => p.platformId === 'xbox');
  return toOlMediaUrl({
    url: rawSrc,
    gameId: game.id,
    role: override?.capsuleImage || game.capsuleImage ? 'cover' : 'header',
    ordinal: 0,
    steamAppId: game.steamAppId,
    gogId: gogPlat?.platformGameId,
    epicAppName: epicPlat?.platformGameId,
    xboxProductId: xboxPlat?.xboxProductId || xboxPlat?.platformGameId,
    packageFamilyName: xboxPlat?.packageFamilyName,
    xboxTitleId: xboxPlat?.xboxTitleId,
    ov: hasCustomOverrideArt ? override?.updatedAt || '1' : undefined,
  });
}

export interface EntitlementOsBadge {
  label: 'macOS Native' | 'Bottled (Wine/CrossOver)' | 'Windows Native';
  className: string;
  title: string;
}

export function resolveEntitlementOsBadge(
  game: CanonicalGame,
  p: CanonicalGame['platforms'][number],
  installedRec: ReturnType<typeof launcherService.getInstalledRecordForGame>,
  isPlatInstalled: boolean
): EntitlementOsBadge | null {
  const hostCaps = launcherService.getHostCapabilities();
  const osSupport = (
    game as CanonicalGame & {
      osSupport?: { mac?: boolean; windows?: boolean; linux?: boolean };
    }
  ).osSupport;

  if (hostCaps.supportsWindowsTranslation) {
    const explicitWinOnMac = installedRec?.isWindowsBinaryOnMac ?? p.isWindowsBinaryOnMac;
    if (explicitWinOnMac === true) {
      return {
        label: 'Bottled (Wine/CrossOver)',
        className: 'bg-amber-950/70 border-amber-500/40 text-amber-300',
        title: 'Windows binary running on macOS via CrossOver / Wine / GPTK bottle',
      };
    }
    if (explicitWinOnMac === false) {
      return {
        label: 'macOS Native',
        className: 'bg-emerald-950/70 border-emerald-500/40 text-emerald-300',
        title: 'Native macOS build',
      };
    }

    const execOrInstallPath =
      installedRec?.executablePath ||
      p.executablePath ||
      installedRec?.installPath ||
      p.installPath ||
      '';
    if (
      execOrInstallPath &&
      (/\.exe$/i.test(execOrInstallPath) ||
        /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(execOrInstallPath))
    ) {
      return {
        label: 'Bottled (Wine/CrossOver)',
        className: 'bg-amber-950/70 border-amber-500/40 text-amber-300',
        title: 'Windows binary running on macOS via CrossOver / Wine / GPTK bottle',
      };
    }
    if (execOrInstallPath && /\.app(?:[\\/]|$)/i.test(execOrInstallPath)) {
      return {
        label: 'macOS Native',
        className: 'bg-emerald-950/70 border-emerald-500/40 text-emerald-300',
        title: 'Native macOS application bundle',
      };
    }

    const hasMacSupport = Boolean(
      p.platforms?.mac ??
        osSupport?.mac ??
        game.nativePlatforms?.includes('mac') ??
        game.worksOn?.mac ??
        game.worksOn?.Mac ??
        game.platforms_os?.mac
    );
    const hasWinSupport = Boolean(
      p.platforms?.windows ??
        osSupport?.windows ??
        game.nativePlatforms?.includes('windows') ??
        game.worksOn?.windows ??
        game.worksOn?.Windows ??
        game.platforms_os?.windows
    );

    if (isPlatInstalled) {
      if (p.platformId === 'xbox' || (!hasMacSupport && hasWinSupport)) {
        return {
          label: 'Bottled (Wine/CrossOver)',
          className: 'bg-amber-950/70 border-amber-500/40 text-amber-300',
          title: 'Windows build installed on macOS (CrossOver / Wine / GPTK)',
        };
      }
      return {
        label: 'macOS Native',
        className: 'bg-emerald-950/70 border-emerald-500/40 text-emerald-300',
        title: 'Installed on macOS',
      };
    }

    if (p.platforms?.mac === true || (hasMacSupport && p.platformId !== 'xbox')) {
      return {
        label: 'macOS Native',
        className: 'bg-emerald-950/50 border-emerald-500/30 text-emerald-300',
        title: 'Supports macOS Native delivery on this storefront',
      };
    }
    if (p.platforms?.windows === true || hasWinSupport) {
      return {
        label: 'Bottled (Wine/CrossOver)',
        className: 'bg-amber-950/50 border-amber-500/30 text-amber-300',
        title: 'Windows-only storefront build (runs via Wine / CrossOver on macOS)',
      };
    }
  } else if (hostCaps.isWindows) {
    if (isPlatInstalled) {
      return {
        label: 'Windows Native',
        className: 'bg-sky-950/70 border-sky-500/40 text-sky-300',
        title: 'Installed Windows Native build',
      };
    }
  }

  return null;
}
