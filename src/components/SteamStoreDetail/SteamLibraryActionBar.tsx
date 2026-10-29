import React, { useState, useEffect, useRef, useMemo } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { SteamEnrichedMetadata } from '../../contracts/steam';
import { StorefrontIcon, getStorefrontDisplayName } from '../Common/StorefrontIcon';
import { STOREFRONT_REGISTRY, StorefrontId } from '../../contracts/platform';
import {
  Play,
  Square,
  Download,
  HardDrive,
  Clock,
  Calendar,
  Trophy,
  Bookmark,
  Award,
  ChevronDown,
  X,
  ExternalLink,
  Sparkles,
  Wand,
  ChevronRight,
  Settings,
  FolderOpen,
  ShieldCheck,
  Trash2,
  Cpu,
  FileSearch,
  Activity,
  Loader2,
  EyeOff,
} from 'lucide-react';
import { getOpenCriticData } from '../../services/critic/criticScoreService';
import { getTierColor } from '../../services/critic/criticUtils';
import { steamMatcher } from '../../services/steam/steamMatcher';
import { parseTimestampMs, formatLastPlayedDate, formatPlaytime } from '../../utils/dateUtils';
import {
  getKnownAchievementTotal,
  getKnownEpicAchievements,
  getKnownGogAchievements,
  getKnownSteamAchievements,
  getKnownXboxAchievements,
} from '../../services/storage/knownGameAchievements';
import { reconcileAchievementSummaries } from '../../services/storage/achievementReconciliation';
import { steamAchievementsService } from '../../services/steam/steamAchievementsService';
import { ActiveGameFilter } from '../../contracts/filter';
import { GameCollection } from '../../contracts/collection';
import { loadCollections } from '../../services/storage/collectionStorage';
import { launcherService } from '../../services/launcher/launcherService';
import {
  formatByteSize,
  parseStorageRequirementTextClient,
  sanitizeGameInstallSizeBytes,
} from '../../utils/formatBytes';

import { GameInstallModal } from '../Launcher/GameInstallModal';
import { GameLaunchConfigModal } from '../Launcher/GameLaunchConfigModal';

interface PlatformAchievementSummary {
  platformId: StorefrontId;
  platformName: string;
  unlocked: number;
  total: number;
  percentage: number;
  gamerscore?: { earned: number; total: number };
  xp?: { earned: number; total: number };
  isMastered: boolean;
  hasConflict?: boolean;
  conflictDetails?: string;
}

function isXboxStoreHost(rawUrl?: string | null): boolean {
  if (!rawUrl) return false;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'xbox.com' || host.endsWith('.xbox.com');
  } catch {
    return false;
  }
}

interface SteamLibraryActionBarProps {
  game: CanonicalGame;
  metadata?: SteamEnrichedMetadata | null;
  collections?: GameCollection[];
  onManageCollections?: () => void;
  onToggleInstallStatus?: (platformId?: StorefrontId) => void;
  onApplyFilter?: (filter: ActiveGameFilter) => void;
  connectedStorefronts?: StorefrontId[];
  onFixMatch?: () => void;
  onHideGame?: (game: CanonicalGame, targetPlatformId?: StorefrontId) => void;
  onViewAchievements?: (storefrontId?: StorefrontId) => void;
}

export const SteamLibraryActionBar: React.FC<SteamLibraryActionBarProps> = ({
  game,
  metadata,
  collections,
  onManageCollections,
  onToggleInstallStatus,
  onApplyFilter,
  onFixMatch,
  onHideGame,
  onViewAchievements,
}) => {
  const [showAchievementPopover, setShowAchievementPopover] = useState(false);
  const [showPlaytimePopover, setShowPlaytimePopover] = useState(false);
  const [launcherTick, setLauncherTick] = useState(0);
  const userManuallySelectedPlatformRef = useRef(false);
  const [selectedPlatformId, setSelectedPlatformId] = useState<StorefrontId>(() => {
    const persisted = launcherService.getSelectedStorefrontForGame(game.id);
    const validPersisted =
      persisted && game.platforms.some((p) => p.platformId === persisted) ? persisted : undefined;
    return (
      validPersisted ||
      launcherService.getSelectedStorefrontForGame(game) ||
      launcherService.getEffectivePlatformForGame(game)?.platformId ||
      game.platforms[0]?.platformId ||
      'steam'
    );
  });
  const [isManageMenuOpen, setIsManageMenuOpen] = useState(false);
  const [isInstallModalOpen, setIsInstallModalOpen] = useState(false);
  const [isLaunchConfigModalOpen, setIsLaunchConfigModalOpen] = useState(false);
  const [isLaunchPending, setIsLaunchPending] = useState(false);
  const [isStopPending, setIsStopPending] = useState(false);
  const [collectionStorageTick, setCollectionStorageTick] = useState(0);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [fetchedInstallSize, setFetchedInstallSize] = useState<number | undefined>(undefined);
  const manageMenuRef = useRef<HTMLDivElement | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    userManuallySelectedPlatformRef.current = false;
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    const persisted = launcherService.getSelectedStorefrontForGame(game.id);
    const validPersisted =
      persisted && game.platforms.some((p) => p.platformId === persisted) ? persisted : undefined;
    const eff =
      validPersisted ||
      launcherService.getSelectedStorefrontForGame(game) ||
      launcherService.getEffectivePlatformForGame(game)?.platformId ||
      game.platforms[0]?.platformId ||
      'steam';
    setSelectedPlatformId(eff);
    setIsManageMenuOpen(false);
    setShowPlaytimePopover(false);
    setShowAchievementPopover(false);
    setIsLaunchPending(false);
    setIsStopPending(false);
    setActionFeedback(null);
    return () => {
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
    };
  }, [game.id]);

  useEffect(() => {
    const computeActionBarSignature = () => {
      const sess = launcherService
        .getRunningGames()
        .find(
          (s) => s.gameId === game.id && (!selectedPlatformId || s.platformId === selectedPlatformId)
        );
      const running = launcherService.isGameRunning(game.id, selectedPlatformId) ? '1' : '0';
      const dl = launcherService.getActiveDownload(game.id, selectedPlatformId);
      const persistedPlat = launcherService.getSelectedStorefrontForGame(game.id) || '';
      const rec = launcherService.getInstalledRecordForGame(game, selectedPlatformId);
      const cfg = launcherService.getLaunchConfig(game.id, selectedPlatformId);
      const perPlatInstalled = game.platforms
        .map((p) => `${p.platformId}:${launcherService.isGameInstalled(game, p.platformId) ? '1' : '0'}`)
        .join(',');
      return [
        running,
        sess?.sessionId || '',
        sess?.status || '',
        dl?.taskId || '',
        dl?.status || '',
        dl ? String(Math.round(dl.progressPercent || 0)) : '',
        persistedPlat,
        rec?.platformId || '',
        rec?.installPath || '',
        rec?.executablePath || '',
        String(rec?.installSize || ''),
        cfg?.customExecutablePath || '',
        cfg?.workingDirectory || '',
        cfg?.preferredPlatformId || '',
        perPlatInstalled,
      ].join('|');
    };

    let prevSig = computeActionBarSignature();
    const unsub = launcherService.subscribe(() => {
      const nextSig = computeActionBarSignature();
      if (nextSig !== prevSig) {
        prevSig = nextSig;
        setLauncherTick((t) => t + 1);
      }
    });
    return unsub;
  }, [game, selectedPlatformId]);

  useEffect(() => {
    if (userManuallySelectedPlatformRef.current) return;
    const persisted = launcherService.getSelectedStorefrontForGame(game.id);
    if (persisted && game.platforms.some((p) => p.platformId === persisted)) {
      return;
    }
    const currentPlat = game.platforms.find((p) => p.platformId === selectedPlatformId);
    const currentIsInstalled =
      launcherService.isGameInstalled(game, selectedPlatformId) || Boolean(currentPlat?.installed);
    if (currentIsInstalled) return;

    const effPlat = launcherService.getEffectivePlatformForGame(game);
    if (
      effPlat &&
      effPlat.platformId !== selectedPlatformId &&
      (launcherService.isGameInstalled(game, effPlat.platformId) || Boolean(effPlat.installed))
    ) {
      setSelectedPlatformId(effPlat.platformId);
    }
  }, [game, game.id, game.platforms, launcherTick, selectedPlatformId]);

  useEffect(() => {
    if (collections || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return;
    }
    const handleStorageChange = () => setCollectionStorageTick((t) => t + 1);
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [Boolean(collections)]);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (manageMenuRef.current && !manageMenuRef.current.contains(e.target as Node)) {
        setIsManageMenuOpen(false);
      }
    }
    if (isManageMenuOpen && typeof document !== 'undefined') {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('mousedown', handleOutsideClick);
      }
    };
  }, [isManageMenuOpen]);

  const showTempFeedback = (msg: string, durationMs = 4000) => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }
    setActionFeedback(msg);
    feedbackTimerRef.current = setTimeout(() => {
      feedbackTimerRef.current = null;
      setActionFeedback((prev) => (prev === msg ? null : prev));
    }, durationMs);
  };

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return;
    }
    const handleLaunchError = (e: Event) => {
      const event = e as CustomEvent<{ gameId?: string; error?: string }>;
      if (event.detail?.gameId === game.id && event.detail?.error) {
        showTempFeedback(`Launch failed: ${event.detail.error}`, 6000);
      }
    };
    window.addEventListener('antigravity:game-launch-error', handleLaunchError);
    return () => {
      window.removeEventListener('antigravity:game-launch-error', handleLaunchError);
    };
  }, [game.id]);

  const activePlatform =
    game.platforms.find((p) => p.platformId === selectedPlatformId) ||
    launcherService.getEffectivePlatformForGame(game, selectedPlatformId) ||
    game.platforms[0];

  const installedRecord = launcherService.getInstalledRecordForGame(game, selectedPlatformId);
  const launchConfig = launcherService.getLaunchConfig(game.id, selectedPlatformId);
  const activeSession = launcherService
    .getRunningGames()
    .find(
      (s) => s.gameId === game.id && (!selectedPlatformId || s.platformId === selectedPlatformId)
    );
  const isRunning = launcherService.isGameRunning(game.id, selectedPlatformId);
  const isStartingSession = isLaunchPending || activeSession?.status === 'starting';
  const isStoppingSession = isStopPending || activeSession?.status === 'stopping';
  const activeDownload = launcherService.getActiveDownload(game.id, selectedPlatformId);
  const isInstalled =
    launcherService.isGameInstalled(game, selectedPlatformId) ||
    Boolean(activePlatform?.installed);

  const isWindowsHost =
    (typeof (launcherService as { isWindowsHost?: () => boolean }).isWindowsHost === 'function' &&
      (launcherService as { isWindowsHost: () => boolean }).isWindowsHost()) ||
    (typeof window !== 'undefined' && window.electronAPI?.platform === 'win32');

  const hasLocalFilesPath = Boolean(
    isInstalled &&
      (installedRecord?.installPath ||
        installedRecord?.executablePath ||
        activePlatform?.installPath ||
        activePlatform?.executablePath ||
        (launchConfig?.customExecutablePath &&
          (!launchConfig.preferredPlatformId ||
            launchConfig.preferredPlatformId === selectedPlatformId)) ||
        (launchConfig?.workingDirectory &&
          (!launchConfig.preferredPlatformId ||
            launchConfig.preferredPlatformId === selectedPlatformId)))
  );

  // Determine if game belongs to at least 1 user collection (memoized to avoid localStorage parse per render)
  const allCollections = useMemo(
    () => collections || loadCollections(),
    [collections, collectionStorageTick]
  );
  const targetGameIds = [game.id];
  if (game.steamAppId) {
    targetGameIds.push(`steam-${game.steamAppId}`, String(game.steamAppId));
  }
  const isInCollection = allCollections.some((col) =>
    col.gameIds.some((id) => targetGameIds.includes(id))
  );

  const handleInstallClick = () => {
    setIsInstallModalOpen(true);
  };

  const handlePlayClick = async () => {
    if (isLaunchPending || isRunning) return;
    setIsLaunchPending(true);
    try {
      const res = await launcherService.launchGame(game, selectedPlatformId);
      if (res && !res.success) {
        showTempFeedback(res.error || 'Failed to launch game');
      }
    } finally {
      setIsLaunchPending(false);
    }
  };

  const handleStopClick = async () => {
    if (isStopPending) return;
    setIsStopPending(true);
    try {
      const res = await launcherService.stopGame(game.id);
      if (res.message) {
        showTempFeedback(res.message);
      }
    } finally {
      setIsStopPending(false);
    }
  };

  // Playtime calculation (Total aggregated across all owned storefronts)
  const totalPlaytimeMinutes = game.platforms.reduce((acc, p) => acc + (p.playtimeMinutes || 0), 0);

  // Last played formatting across all owned storefronts
  const formatLastPlayed = () => {
    let latestMs: number | null = null;
    let latestRaw: string | number | undefined = undefined;

    for (const p of game.platforms) {
      const ms = parseTimestampMs(p.lastPlayed);
      if (ms !== null && (latestMs === null || ms > latestMs)) {
        latestMs = ms;
        latestRaw = p.lastPlayed;
      }
    }

    return formatLastPlayedDate(latestRaw || activePlatform?.lastPlayed);
  };

  const formatPlatformLastPlayed = (raw?: string | number) => {
    if (!raw) return null;
    return formatLastPlayedDate(raw);
  };

  const targetSteamAppId = game.steamAppId || metadata?.appId;
  const installedSize = sanitizeGameInstallSizeBytes(installedRecord?.installSize);
  const platformSize = isInstalled
    ? sanitizeGameInstallSizeBytes(activePlatform?.installSize)
    : undefined;
  const fallbackUninstalledPlatformSize = sanitizeGameInstallSizeBytes(activePlatform?.installSize);
  const resolvedFetchedSize = sanitizeGameInstallSizeBytes(fetchedInstallSize);

  useEffect(() => {
    setFetchedInstallSize(undefined);
    if (!Boolean(installedSize || (isInstalled && platformSize))) {
      let cancelled = false;
      const gameWithSteamAppId =
        !game.steamAppId && targetSteamAppId ? { ...game, steamAppId: targetSteamAppId } : game;
      launcherService
        .getGameInstallInfo(gameWithSteamAppId, selectedPlatformId)
        .then((info) => {
          const validBytes = sanitizeGameInstallSizeBytes(info?.estimatedSizeBytes);
          if (!cancelled && validBytes) {
            setFetchedInstallSize(validBytes);
          }
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }
  }, [
    game.id,
    targetSteamAppId,
    selectedPlatformId,
    isInstalled,
    installedSize,
    platformSize,
  ]);

  // Space Required extraction
  const getSpaceRequired = () => {
    const authoritativeOrFallbackBytes = isInstalled
      ? (installedSize ?? platformSize ?? resolvedFetchedSize)
      : (resolvedFetchedSize ?? fallbackUninstalledPlatformSize);
    const realSize = formatByteSize(authoritativeOrFallbackBytes);
    if (realSize) {
      return realSize;
    }

    const extendedMeta = metadata as
      | (SteamEnrichedMetadata & { macRequirementsHtml?: string })
      | null
      | undefined;
    const preferMacSpecs = !isWindowsHost && metadata?.platforms?.mac !== false;
    const candidateRequirementBlocks = preferMacSpecs
      ? [
          metadata?.macRequirements?.minimum,
          metadata?.macRequirements?.recommended,
          extendedMeta?.macRequirementsHtml,
          metadata?.systemRequirements?.minimum,
          metadata?.systemRequirements?.recommended,
          metadata?.pcRequirementsHtml,
        ]
      : [
          metadata?.systemRequirements?.minimum,
          metadata?.systemRequirements?.recommended,
          metadata?.pcRequirementsHtml,
          metadata?.macRequirements?.minimum,
          metadata?.macRequirements?.recommended,
          extendedMeta?.macRequirementsHtml,
        ];

    for (const reqBlock of candidateRequirementBlocks) {
      const parsedText = parseStorageRequirementTextClient(reqBlock);
      if (parsedText) return parsedText;
    }

    return '—';
  };

  // Multi-store achievements evaluation
  const knownTotal = getKnownAchievementTotal(targetSteamAppId, game.id, game.title);
  const steamData = targetSteamAppId
    ? (steamAchievementsService.getCachedAchievements(targetSteamAppId) || getKnownSteamAchievements(targetSteamAppId, game.title))
    : undefined;

  // If verified Steam client data or metadata has achievement count, it takes precedence
  const effectiveTotal =
    steamData?.total ??
    metadata?.achievements?.total ??
    knownTotal ??
    (metadata && !metadata.categories?.some((c) => c.id === 22) ? 0 : 0);

  const platformAchievements: PlatformAchievementSummary[] = game.platforms.map((p) => {
    const reg = STOREFRONT_REGISTRY[p.platformId];
    const name = reg?.name || p.platformId;

    let pAchievements = p.achievements;

    // Check store-specific live scan and verified cache using authority reconciliation
    if (p.platformId === 'steam' && targetSteamAppId) {
      const sData = steamData || (pAchievements ? { unlocked: pAchievements.unlocked, total: pAchievements.total, percentage: pAchievements.percentage } : undefined);
      if (sData) {
        pAchievements = reconcileAchievementSummaries(pAchievements, sData, {
          title: game.title,
          appId: targetSteamAppId,
          store: 'steam',
        }) || pAchievements;
      }
    } else if (p.platformId === 'gog') {
      const gogKnown = getKnownGogAchievements(p.platformGameId || game.id, game.title);
      if (gogKnown) {
        pAchievements = reconcileAchievementSummaries(pAchievements, gogKnown, {
          title: game.title,
          store: 'gog',
        }) || pAchievements;
      }
    } else if (p.platformId === 'epic') {
      const epicKnown = getKnownEpicAchievements(game.id, game.title);
      if (epicKnown) {
        pAchievements = reconcileAchievementSummaries(pAchievements, epicKnown, {
          title: game.title,
          store: 'epic',
        }) || pAchievements;
      }
    } else if (p.platformId === 'xbox') {
      const xboxKnown = getKnownXboxAchievements(
        p.xboxTitleId || p.platformGameId || game.id,
        game.title
      );
      if (xboxKnown) {
        pAchievements = reconcileAchievementSummaries(pAchievements, xboxKnown, {
          title: game.title,
          store: 'xbox',
        }) || pAchievements;
      }
    }

    let platTotal = effectiveTotal ?? 0;
    if (pAchievements && pAchievements.total > 0) {
      platTotal = pAchievements.total;
    } else {
      const known = getKnownAchievementTotal(targetSteamAppId, p.platformGameId || game.id, game.title);
      if (known && known > 0) platTotal = known;
    }

    const unlocked = pAchievements?.unlocked ?? 0;
    const customXp: { earned: number; total: number } | undefined = pAchievements?.xp;

    const percentage = platTotal > 0 ? Math.round((unlocked / platTotal) * 100) : 0;
    const isMastered = (platTotal > 0 && unlocked >= platTotal) || !!pAchievements?.isMastered;

    const res: PlatformAchievementSummary = {
      platformId: p.platformId,
      platformName: name,
      unlocked,
      total: platTotal,
      percentage,
      isMastered,
      hasConflict: pAchievements?.hasConflict,
      conflictDetails: pAchievements?.conflictDetails,
    };

    if (p.platformId === 'epic' && platTotal > 0) {
      res.xp = customXp || { earned: Math.round((percentage / 100) * 1000), total: 1000 };
    }
    if (p.platformId === 'xbox' && platTotal > 0) {
      res.gamerscore = pAchievements?.gamerscore || { earned: Math.round((percentage / 100) * 1000), total: 1000 };
    }

    return res;
  });

  const hasAchievements = platformAchievements.some((p) => p.total > 0);

  // Best platform achievement by highest percentage, then unlocked count, then total
  const bestAchievement = platformAchievements.reduce((best, cur) => {
    if (cur.percentage > best.percentage) return cur;
    if (cur.percentage === best.percentage) {
      if (cur.unlocked > best.unlocked) return cur;
      if (cur.total > best.total) return cur;
      if (cur.platformId === 'steam') return cur;
    }
    return best;
  }, platformAchievements[0] || {
    platformId: 'steam',
    platformName: 'Steam',
    unlocked: 0,
    total: 0,
    percentage: 0,
    isMastered: false,
  });

  const isAnyMastered = platformAchievements.some((p) => p.isMastered || p.percentage >= 100);

  // Critic consensus rating
  const targetSteamId = steamMatcher.getEffectiveSteamAppId(game);
  const openCritic = getOpenCriticData(
    targetSteamId || undefined,
    game.title,
    game.reviewSummary?.positivePercent,
    game.releaseDate
  );
  const ocColors = openCritic ? getTierColor(openCritic.tier) : null;

  const isXboxSubscriptionExpired =
    activePlatform?.platformId === 'xbox' &&
    Boolean(activePlatform.subscriptionExpired) &&
    activePlatform.ownershipType === 'subscription';
  const xboxStoreUrl = useMemo(() => {
    if (activePlatform?.platformId !== 'xbox') return null;
    const rawBigId = (activePlatform.xboxProductId || activePlatform.platformGameId || '').trim();
    if (/^[A-Z0-9]{12}$/i.test(rawBigId)) {
      return `https://www.xbox.com/games/store/-/${rawBigId.toUpperCase()}`;
    }
    return `https://www.xbox.com/Search/Results?q=${encodeURIComponent(game.title)}`;
  }, [activePlatform?.platformId, activePlatform?.xboxProductId, activePlatform?.platformGameId, game.title]);

  return (
    <div className="bg-[#101822] border border-[#2a475e] rounded p-3.5 xl:p-4 shadow-xl text-steam-text select-none">
      <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3 xl:gap-5">
        {/* Left: Action Button & Library Status */}
        <div className="flex items-center gap-2 xl:gap-2.5 shrink-0 flex-wrap sm:flex-nowrap py-0.5">
          {/* Main Action Button (Starting / Running / Stopping / Installing / Play / Install) */}
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
            {isRunning ? (
              <div className="flex items-center gap-1.5">
                {activeSession?.status === 'starting' ? (
                  <span
                    data-testid="actionbar-session-starting"
                    className="inline-flex items-center gap-1.5 px-4 xl:px-5 py-2 xl:py-2.5 rounded bg-sky-950/80 border border-sky-500/60 text-sky-300 font-bold text-xs uppercase tracking-wider shadow-sm"
                  >
                    <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin" />
                    <span>Starting...</span>
                  </span>
                ) : isStoppingSession ? (
                  <>
                    <span
                      data-testid="actionbar-session-stopping"
                      className="inline-flex items-center gap-1.5 px-3 py-2 xl:py-2.5 rounded bg-amber-950/80 border border-amber-500/60 text-amber-300 font-bold text-xs uppercase tracking-wider shadow-sm"
                    >
                      <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                      <span>Stopping...</span>
                    </span>
                    <button
                      type="button"
                      disabled
                      className="inline-flex items-center justify-center gap-1.5 px-4 xl:px-5 py-2 xl:py-2.5 rounded font-bold text-xs xl:text-sm text-white tracking-wider uppercase transition-all shadow-md opacity-50 cursor-not-allowed shrink-0"
                      style={{
                        background: 'linear-gradient(to right, #dc2626 0%, #991b1b 100%)',
                      }}
                      title="Stopping game and syncing cloud saves..."
                    >
                      <Square className="w-3.5 h-3.5 fill-white" />
                      <span>Stop</span>
                    </button>
                  </>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1.5 px-3 py-2 xl:py-2.5 rounded bg-emerald-950/80 border border-emerald-500/60 text-emerald-300 font-bold text-xs uppercase tracking-wider shadow-sm">
                      <Activity className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
                      <span>Running</span>
                    </span>
                    <button
                      type="button"
                      onClick={handleStopClick}
                      disabled={isStopPending}
                      className="inline-flex items-center justify-center gap-1.5 px-4 xl:px-5 py-2 xl:py-2.5 rounded font-bold text-xs xl:text-sm text-white tracking-wider uppercase transition-all shadow-md hover:brightness-110 active:scale-[0.99] shrink-0 cursor-pointer disabled:opacity-50"
                      style={{
                        background: 'linear-gradient(to right, #dc2626 0%, #991b1b 100%)',
                        boxShadow: '0 0 14px rgba(220, 38, 38, 0.45)',
                      }}
                      title={`Stop ${game.title}`}
                    >
                      <Square className="w-3.5 h-3.5 fill-white" />
                      <span>Stop</span>
                    </button>
                  </>
                )}
              </div>
            ) : isStartingSession ? (
              <button
                type="button"
                disabled
                data-testid="actionbar-play-starting"
                className="inline-flex items-center justify-center gap-1.5 xl:gap-2 px-5 xl:px-6 py-2 xl:py-2.5 rounded font-bold text-xs xl:text-sm text-white tracking-wider uppercase transition-all shadow-md opacity-75 cursor-wait shrink-0"
                style={{
                  background: 'linear-gradient(to right, #2f6f18 5%, #1f5110 95%)',
                }}
              >
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Starting...</span>
              </button>
            ) : activeDownload ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => launcherService.openDownloadDrawer()}
                  className="relative overflow-hidden inline-flex items-center justify-center gap-2 px-5 xl:px-6 py-2 xl:py-2.5 rounded font-bold text-xs xl:text-sm text-white tracking-wider uppercase transition-all shadow-md hover:brightness-110 shrink-0 cursor-pointer bg-[#17283b] border border-sky-400/70"
                  title="Click to open Download Manager"
                >
                  <div
                    className="absolute inset-y-0 left-0 bg-sky-500/35 transition-all duration-300 pointer-events-none"
                    style={{ width: `${Math.min(100, Math.max(0, activeDownload.progressPercent))}%` }}
                  />
                  <Loader2 className="w-4 h-4 text-sky-300 animate-spin relative z-10" />
                  <span className="relative z-10">
                    {`Installing ${Math.round(activeDownload.progressPercent)}%`}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await launcherService.cancelDownload(activeDownload.taskId);
                    showTempFeedback('Installation cancelled.');
                  }}
                  aria-label="Cancel Install"
                  title="Cancel active installation"
                  className="min-w-6 min-h-6 p-2 xl:p-2.5 rounded border border-red-500/50 bg-red-950/60 hover:bg-red-900/70 text-red-300 hover:text-white transition-colors shrink-0 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : isInstalled ? (
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  onClick={handlePlayClick}
                  className="inline-flex items-center justify-center gap-1.5 xl:gap-2 px-5 xl:px-6 py-2 xl:py-2.5 rounded font-bold text-xs xl:text-sm text-white tracking-wider uppercase transition-all shadow-md hover:brightness-110 active:scale-[0.99] shrink-0 cursor-pointer"
                  style={{
                    background: isXboxSubscriptionExpired
                      ? 'linear-gradient(to right, #475569 5%, #334155 95%)'
                      : 'linear-gradient(to right, #2f6f18 5%, #1f5110 95%)',
                    boxShadow: isXboxSubscriptionExpired
                      ? 'none'
                      : '0 0 16px rgba(47, 111, 24, 0.5)',
                  }}
                  title={
                    isXboxSubscriptionExpired
                      ? `Launch ${game.title} (Game Pass subscription access expired — purchase or renew if required)`
                      : `Launch ${game.title} (${getStorefrontDisplayName(selectedPlatformId)})`
                  }
                >
                  <Play className="w-4 h-4 fill-white" />
                  <span>Play</span>
                </button>
                {isXboxSubscriptionExpired && xboxStoreUrl && (
                  <a
                    href={xboxStoreUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="xbox-expired-store-cta"
                    onClick={(e) => {
                      e.preventDefault();
                      if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
                        window.electronAPI.openExternal(xboxStoreUrl);
                      } else {
                        window.open(xboxStoreUrl, '_blank', 'noreferrer,noopener');
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-2 xl:py-2.5 rounded bg-rose-950/70 hover:bg-rose-900/80 border border-rose-500/60 text-rose-200 hover:text-white text-[11px] font-bold uppercase tracking-wider transition-colors shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                    title="Game Pass access rotated out or expired. View on Xbox Store to purchase or renew."
                  >
                    <span>Subscription Expired • Xbox Store</span>
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                  </a>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={handleInstallClick}
                className="inline-flex items-center justify-center gap-1.5 xl:gap-2 px-5 xl:px-6 py-2 xl:py-2.5 rounded font-bold text-xs xl:text-sm text-white tracking-wider uppercase transition-all shadow-md hover:brightness-110 active:scale-[0.99] shrink-0 cursor-pointer"
                style={{
                  background: 'linear-gradient(to right, #214b6b 0%, #123049 100%)',
                  border: '1px solid #3878a8',
                  boxShadow: '0 0 12px rgba(33, 75, 107, 0.4)',
                }}
                title={`Install ${game.title} (${getStorefrontDisplayName(selectedPlatformId)})`}
              >
                <Download className="w-4 h-4 text-sky-400" />
                <span>Install</span>
              </button>
            )}

            {/* Storefront Switcher Pill (when owned on >1 storefront) */}
            {game.platforms.length > 1 && (
              <div
                className="relative inline-flex items-center justify-center p-2 xl:p-2.5 rounded bg-[#16202d] hover:bg-[#1f2c3d] border border-steam-border/80 text-white shrink-0 cursor-pointer transition-colors"
                title={`Active Storefront: ${getStorefrontDisplayName(selectedPlatformId)} (Click to switch)`}
              >
                <StorefrontIcon
                  storefrontId={selectedPlatformId}
                  decorative
                  className={`w-4 h-4 shrink-0 pointer-events-none ${
                    selectedPlatformId === 'xbox' ? 'text-[#52d652]' : 'text-sky-400'
                  }`}
                />
                <ChevronDown className="w-3 h-3 text-steam-subtext ml-1 shrink-0 pointer-events-none" />
                <select
                  aria-label="Target Storefront"
                  value={selectedPlatformId}
                  onChange={(e) => {
                    const nextPlat = e.target.value as StorefrontId;
                    userManuallySelectedPlatformRef.current = true;
                    setSelectedPlatformId(nextPlat);
                    launcherService.setSelectedStorefrontForGame(game.id, nextPlat);
                  }}
                  title={`Active Storefront: ${getStorefrontDisplayName(selectedPlatformId)} (Click to switch)`}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                >
                  {game.platforms.map((plat) => {
                    const platInstalled =
                      launcherService.isGameInstalled(game, plat.platformId) ||
                      Boolean(plat.installed);
                    return (
                      <option
                        key={plat.platformId}
                        value={plat.platformId}
                        className="bg-[#131b26] text-white"
                      >
                        {getStorefrontDisplayName(plat.platformId)}{' '}
                        {platInstalled ? '• Installed' : '• Not Installed'}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}

            {/* Gear (Manage Game) Dropdown Button */}
            <div className="relative" ref={manageMenuRef}>
              <button
                type="button"
                onClick={() => setIsManageMenuOpen((prev) => !prev)}
                aria-label="Manage Game"
                title="Manage Game (Files, Launch Settings, Verify, Uninstall)"
                className={`p-2 xl:p-2.5 rounded border transition-colors shrink-0 cursor-pointer ${
                  isManageMenuOpen
                    ? 'bg-steam-accent text-black border-steam-accent'
                    : 'text-steam-subtext hover:text-white bg-[#16202d] hover:bg-[#1f2c3d] border-steam-border/80'
                }`}
              >
                <Settings className="w-4 h-4" />
              </button>

              {isManageMenuOpen && (
                <div className="absolute left-0 top-full mt-2 w-64 rounded-lg bg-[#151f2d] border border-[#2a475e] shadow-2xl z-50 py-1.5 animate-in fade-in zoom-in-95 duration-150">
                  <div className="px-3.5 py-1.5 border-b border-[#2a475e]/60 mb-1 flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-sky-400">
                      Manage Game
                    </span>
                    <span className="text-[10px] text-steam-subtext">
                      {getStorefrontDisplayName(selectedPlatformId)}
                    </span>
                  </div>

                  {/* Group 1: Local Files & Installation */}
                  <div className="px-3.5 pt-1 pb-0.5 text-[9px] font-bold uppercase tracking-wider text-steam-subtext/75">
                    Local Files &amp; Installation
                  </div>

                  {isInstalled ? (
                    <>
                      {/* 1. Browse Local Files */}
                      <button
                        type="button"
                        disabled={!hasLocalFilesPath}
                        onClick={async () => {
                          setIsManageMenuOpen(false);
                          const ok = await launcherService.browseLocalFiles(
                            game,
                            selectedPlatformId
                          );
                          if (!ok) {
                            showTempFeedback('Could not open local game folder.');
                          }
                        }}
                        className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2d40] disabled:opacity-40 disabled:pointer-events-none transition-colors text-left cursor-pointer"
                      >
                        <FolderOpen className="w-4 h-4 text-sky-400 shrink-0" />
                        <span>Browse Local Files</span>
                      </button>

                      {/* 2. Verify / Repair Game Files */}
                      <button
                        type="button"
                        onClick={async () => {
                          setIsManageMenuOpen(false);
                          const res = await launcherService.verifyGameFiles(
                            game,
                            selectedPlatformId
                          );
                          showTempFeedback(res.message || res.error || 'Verification triggered.');
                        }}
                        className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2d40] transition-colors text-left cursor-pointer"
                      >
                        <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span>Verify / Repair Game Files</span>
                      </button>
                    </>
                  ) : (
                    /* 1. Install Game... (shown when not installed) */
                    <button
                      type="button"
                      onClick={() => {
                        setIsManageMenuOpen(false);
                        setIsInstallModalOpen(true);
                      }}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2d40] transition-colors text-left cursor-pointer"
                    >
                      <Download className="w-4 h-4 text-sky-400 shrink-0" />
                      <span>Install Game...</span>
                    </button>
                  )}

                  {/* 3. Locate Installed Game... */}
                  <button
                    type="button"
                    onClick={async () => {
                      setIsManageMenuOpen(false);
                      const exe = await launcherService.locateInstalledGame(
                        game,
                        selectedPlatformId
                      );
                      if (exe) {
                        showTempFeedback(`Linked local executable: ${exe}`);
                      }
                    }}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2d40] transition-colors text-left cursor-pointer"
                  >
                    <FileSearch className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>Locate Installed Game...</span>
                  </button>

                  {/* 4. Mark as Manually Installed / Uninstalled */}
                  <button
                    type="button"
                    onClick={async () => {
                      setIsManageMenuOpen(false);
                      const nextState = !isInstalled;
                      await launcherService.setManualInstallStatus(game, nextState, selectedPlatformId);
                      onToggleInstallStatus?.(selectedPlatformId);
                      showTempFeedback(
                        nextState
                          ? 'Marked as manually installed.'
                          : 'Marked as uninstalled (cloud only).'
                      );
                    }}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2d40] transition-colors text-left cursor-pointer"
                  >
                    <HardDrive className={`w-4 h-4 shrink-0 ${isInstalled ? 'text-emerald-400' : 'text-sky-400'}`} />
                    <span>{isInstalled ? 'Mark as Uninstalled (Cloud Only)' : 'Mark as Manually Installed'}</span>
                  </button>

                  {/* Group 2: Metadata & Launch Configuration */}
                  <div className="mt-1 pt-1.5 border-t border-[#2a475e]/50">
                    <div className="px-3.5 pb-0.5 text-[9px] font-bold uppercase tracking-wider text-steam-subtext/75">
                      Metadata &amp; Settings
                    </div>

                    {/* 5. Match & Metadata Wizard... */}
                    {onFixMatch && (
                      <button
                        type="button"
                        onClick={() => {
                          setIsManageMenuOpen(false);
                          onFixMatch();
                        }}
                        className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2d40] transition-colors text-left cursor-pointer"
                      >
                        <Wand className="w-4 h-4 text-sky-400 shrink-0" />
                        <span>Match &amp; Metadata Wizard...</span>
                      </button>
                    )}

                    {/* 6. Launch & Compatibility Settings... */}
                    <button
                      type="button"
                      onClick={() => {
                        setIsManageMenuOpen(false);
                        setIsLaunchConfigModalOpen(true);
                      }}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-steam-text hover:text-white hover:bg-[#1f2d40] transition-colors text-left cursor-pointer"
                    >
                      <Cpu className="w-4 h-4 text-purple-400 shrink-0" />
                      <span>
                        {isWindowsHost ? 'Launch Settings...' : 'Launch & Compatibility Settings...'}
                      </span>
                    </button>
                  </div>

                  {/* Group 3: Visibility & Removal */}
                  {(onHideGame || activeDownload || isInstalled) && (
                    <div className="mt-1 pt-1 border-t border-[#2a475e]/50">
                      {/* 7. Hide / Suppress Entry or Game */}
                      {onHideGame &&
                        (game.platforms.length > 1 ? (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setIsManageMenuOpen(false);
                                onHideGame(game, selectedPlatformId);
                              }}
                              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-rose-300 hover:text-white hover:bg-rose-950/50 transition-colors text-left cursor-pointer"
                            >
                              <EyeOff className="w-4 h-4 text-rose-400 shrink-0" />
                              <span>
                                Hide {getStorefrontDisplayName(selectedPlatformId)} Entry
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setIsManageMenuOpen(false);
                                onHideGame(game);
                              }}
                              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-rose-300 hover:text-white hover:bg-rose-950/50 transition-colors text-left cursor-pointer"
                            >
                              <EyeOff className="w-4 h-4 text-rose-400 shrink-0" />
                              <span>Hide Entire Game from Library</span>
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setIsManageMenuOpen(false);
                              onHideGame(game);
                            }}
                            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-rose-300 hover:text-white hover:bg-rose-950/50 transition-colors text-left cursor-pointer"
                          >
                            <EyeOff className="w-4 h-4 text-rose-400 shrink-0" />
                            <span>Hide / Suppress Game from Library</span>
                          </button>
                        ))}

                      {/* Cancel Active Install */}
                      {activeDownload && (
                        <button
                          type="button"
                          onClick={async () => {
                            setIsManageMenuOpen(false);
                            await launcherService.cancelDownload(activeDownload.taskId);
                            showTempFeedback('Installation cancelled.');
                          }}
                          className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-red-300 hover:text-red-200 hover:bg-red-950/50 transition-colors text-left cursor-pointer"
                        >
                          <X className="w-4 h-4 text-red-400 shrink-0" />
                          <span>Cancel Install</span>
                        </button>
                      )}

                      {/* 8. Uninstall Game... */}
                      {isInstalled && (
                        <button
                          type="button"
                          onClick={async () => {
                            setIsManageMenuOpen(false);
                            const res = await launcherService.uninstallGame(game, selectedPlatformId);
                            showTempFeedback(res.message || res.error || 'Game uninstalled.');
                          }}
                          className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-red-300 hover:text-red-200 hover:bg-red-950/50 transition-colors text-left cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4 text-red-400 shrink-0" />
                          <span>Uninstall Game...</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Collections Shortcut Button */}
          {onManageCollections && (
            <button
              type="button"
              onClick={onManageCollections}
              aria-label={isInCollection ? 'In Collection (click to manage)' : 'Add to Collections'}
              className={`min-w-6 min-h-6 p-2 xl:p-2.5 rounded transition-all shrink-0 cursor-pointer ${
                isInCollection
                  ? 'bg-[#1b2b3d] text-steam-accent border border-steam-accent/60 shadow-[0_0_8px_rgba(102,192,244,0.3)] hover:brightness-110'
                  : 'text-steam-subtext hover:text-white bg-[#16202d] hover:bg-[#1f2c3d] border border-steam-border/80'
              }`}
              title={isInCollection ? 'In Collection (click to manage)' : 'Add to Collections'}
            >
              <Bookmark
                className={`w-4 h-4 transition-transform active:scale-95 ${
                  isInCollection
                    ? 'text-steam-accent fill-steam-accent drop-shadow-[0_0_4px_rgba(102,192,244,0.6)]'
                    : 'text-steam-subtext hover:text-white'
                }`}
              />
            </button>
          )}
        </div>

        {/* Right: Steam Library Stats Matrix */}
        <div className="flex flex-wrap lg:flex-nowrap items-start justify-start lg:justify-end gap-x-5 xl:gap-x-7 gap-y-3 border-t lg:border-t-0 lg:border-l border-[#2a475e]/60 pt-3 lg:pt-0 pl-0 lg:pl-4 xl:pl-6 flex-1 min-w-0">
          {/* Play Time */}
          {game.platforms.length > 1 ? (
            <div
              className="flex flex-col min-w-0 shrink-0"
              title="Click to view per-store playtime breakdown"
              onClick={() => {
                setShowPlaytimePopover((prev) => {
                  const next = !prev;
                  if (next) setShowAchievementPopover(false);
                  return next;
                });
              }}
            >
              <button
                type="button"
                aria-expanded={showPlaytimePopover}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowPlaytimePopover((prev) => {
                    const next = !prev;
                    if (next) setShowAchievementPopover(false);
                    return next;
                  });
                }}
                className="flex flex-col min-w-0 min-h-6 shrink-0 text-left cursor-pointer group select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent rounded"
              >
                <span
                  className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 whitespace-nowrap transition-colors ${
                    showPlaytimePopover
                      ? 'text-steam-accent'
                      : 'text-[#94a3b8] group-hover:text-white'
                  }`}
                >
                  <Clock className="w-3 h-3 text-sky-400 shrink-0" />
                  <span>Play Time</span>
                  <ChevronDown
                    className={`w-2.5 h-2.5 transition-transform duration-200 text-sky-400/80 group-hover:text-sky-300 ${
                      showPlaytimePopover ? 'rotate-180 text-steam-accent' : ''
                    }`}
                  />
                </span>
                <span className="text-sm font-bold text-white mt-0.5 whitespace-nowrap transition-colors group-hover:text-steam-accent">
                  {formatPlaytime(totalPlaytimeMinutes)}
                </span>
              </button>
            </div>
          ) : (
            <div className="flex flex-col min-w-0 shrink-0">
              <span className="text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 whitespace-nowrap text-[#94a3b8]">
                <Clock className="w-3 h-3 text-sky-400 shrink-0" />
                <span>Play Time</span>
              </span>
              <span className="text-sm font-bold text-white mt-0.5 whitespace-nowrap">
                {formatPlaytime(totalPlaytimeMinutes)}
              </span>
            </div>
          )}

          {/* Last Played */}
          <div className="flex flex-col min-w-0 shrink-0">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#94a3b8] flex items-center gap-1 whitespace-nowrap">
              <Calendar className="w-3 h-3 text-sky-400" />
              Last Played
            </span>
            <span className="text-sm font-bold text-white mt-0.5 whitespace-nowrap">
              {formatLastPlayed()}
            </span>
          </div>

          {/* Space Required */}
          <div className="flex flex-col min-w-0 shrink-0">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#94a3b8] flex items-center gap-1 whitespace-nowrap">
              <HardDrive className="w-3 h-3 text-sky-400" />
              Space Required
            </span>
            <span className="text-sm font-bold text-white mt-0.5 whitespace-nowrap">
              {getSpaceRequired()}
            </span>
          </div>

          {/* Achievements */}
          {(() => {
            const isInteractiveAch =
              Boolean(onViewAchievements && hasAchievements && bestAchievement.total > 0) ||
              platformAchievements.length > 1;
            const achContent = (
              <>
                <div className="flex items-center gap-1.5 whitespace-nowrap">
                  <span
                    className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 transition-colors ${
                      platformAchievements.length > 1
                        ? showAchievementPopover
                          ? 'text-steam-accent'
                          : 'text-[#94a3b8] group-hover:text-white'
                        : 'text-[#94a3b8]'
                    }`}
                  >
                    {isAnyMastered ? (
                      <span
                        className="relative inline-flex items-center justify-center w-3 h-3 shrink-0"
                        title="Mastered (100% Achievements Unlocked)"
                      >
                        <Trophy className="w-3 h-3 text-amber-300 fill-amber-400 drop-shadow-[0_0_4px_rgba(251,191,36,0.95)]" />
                        <Sparkles className="w-2 h-2 text-yellow-200 absolute -top-1 -right-1 drop-shadow-[0_0_2px_rgba(255,255,255,0.9)] animate-pulse pointer-events-none" />
                      </span>
                    ) : (
                      <Trophy
                        className={`w-3 h-3 shrink-0 ${
                          hasAchievements && bestAchievement.total > 0
                            ? 'text-amber-400'
                            : 'text-[#94a3b8]'
                        }`}
                      />
                    )}
                    <span>Achievements</span>
                    {platformAchievements.length > 1 && (
                      <ChevronDown
                        className={`w-2.5 h-2.5 transition-transform duration-200 text-sky-400/80 group-hover:text-sky-300 ${
                          showAchievementPopover ? 'rotate-180 text-steam-accent' : ''
                        }`}
                      />
                    )}
                  </span>
                </div>

                {hasAchievements && bestAchievement.total > 0 ? (
                  <>
                    <div className="flex items-center gap-1.5 mt-0.5 whitespace-nowrap">
                      <span
                        className={`text-sm font-bold text-white transition-colors ${
                          platformAchievements.length > 1
                            ? 'group-hover:text-steam-accent'
                            : ''
                        }`}
                      >
                        {bestAchievement.unlocked} / {bestAchievement.total}
                      </span>
                      <span
                        className={`text-[11px] ${
                          isAnyMastered ? 'text-amber-300 font-semibold' : 'text-[#94a3b8]'
                        }`}
                      >
                        ({bestAchievement.percentage}%)
                      </span>
                      {bestAchievement.platformId === 'xbox' &&
                        bestAchievement.gamerscore &&
                        bestAchievement.gamerscore.total > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-emerald-300 bg-emerald-950/70 border border-emerald-500/40 px-1 py-0.2 rounded font-mono">
                            <span>{bestAchievement.gamerscore.earned}</span>
                            <span>G</span>
                          </span>
                        )}
                    </div>

                    {/* Miniature progress bar */}
                    <div className="w-full bg-[#1b2838] h-1 rounded-full mt-1 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          isAnyMastered
                            ? 'bg-gradient-to-r from-amber-400 to-yellow-300'
                            : 'bg-amber-400'
                        }`}
                        style={{ width: `${Math.min(100, bestAchievement.percentage)}%` }}
                      />
                    </div>
                  </>
                ) : (
                  <span className="text-sm font-medium text-steam-subtext mt-0.5 whitespace-nowrap">
                    No Achievements
                  </span>
                )}
              </>
            );

            if (isInteractiveAch) {
              return (
                <button
                  type="button"
                  aria-expanded={
                    platformAchievements.length > 1 &&
                    !(onViewAchievements && hasAchievements && bestAchievement.total > 0)
                      ? showAchievementPopover
                      : undefined
                  }
                  onClick={() => {
                    if (onViewAchievements && hasAchievements && bestAchievement.total > 0) {
                      onViewAchievements(bestAchievement.platformId);
                    } else if (platformAchievements.length > 1) {
                      setShowAchievementPopover((prev) => {
                        const next = !prev;
                        if (next) setShowPlaytimePopover(false);
                        return next;
                      });
                    }
                  }}
                  className="flex flex-col min-w-0 min-h-6 shrink-0 text-left cursor-pointer group select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent rounded"
                  title={
                    hasAchievements && bestAchievement.total > 0
                      ? 'Click to view full achievements browser, icons & unlock dates'
                      : 'Click to view per-store achievements breakdown'
                  }
                >
                  {achContent}
                </button>
              );
            }

            return <div className="flex flex-col min-w-0 shrink-0">{achContent}</div>;
          })()}

          {/* Critic Score */}
          {openCritic && ocColors && (
            <div className="flex flex-col min-w-0 shrink-0">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[#94a3b8] flex items-center gap-1 whitespace-nowrap">
                <Award className="w-3 h-3 text-purple-400" />
                {openCritic.source === 'metacritic'
                  ? 'Metacritic'
                  : openCritic.source === 'metacritic_user'
                  ? 'MC User Score'
                  : openCritic.source === 'steam'
                  ? 'Steam Community'
                  : openCritic.source === 'gog'
                  ? 'GOG Rating'
                  : openCritic.source === 'epic'
                  ? 'Epic Rating'
                  : String(openCritic.id || '').toLowerCase().startsWith('xbox-') ||
                    isXboxStoreHost(openCritic.url)
                  ? 'Xbox Rating'
                  : 'OpenCritic'}
              </span>
              <div className="flex items-center gap-1.5 mt-0.5 whitespace-nowrap">
                <span className={`text-sm font-black ${ocColors.accentText}`}>
                  {openCritic.source === 'metacritic_user' && openCritic.userScoreRaw !== undefined
                    ? `${openCritic.userScoreRaw}/10`
                    : (openCritic.source === 'gog' ||
                        openCritic.source === 'epic' ||
                        String(openCritic.id || '').toLowerCase().startsWith('xbox-') ||
                        isXboxStoreHost(openCritic.url)) &&
                      openCritic.starRatingRaw !== undefined
                    ? `${openCritic.starRatingRaw}★ (${openCritic.score})`
                    : openCritic.score}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onApplyFilter?.({
                      type: 'rating',
                      label: 'Rating',
                      value: openCritic.tier,
                    })
                  }
                  className={`text-[10px] font-bold px-1.5 py-0.2 min-h-6 inline-flex items-center rounded border hover:underline hover:brightness-125 cursor-pointer ${ocColors.badgeBg} ${ocColors.badgeBorder} ${ocColors.badgeText}`}
                  title={`Filter library for ${openCritic.tier} games`}
                >
                  {openCritic.tier}
                </button>
                <a
                  href={openCritic.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
                      window.electronAPI.openExternal(openCritic.url);
                    } else {
                      window.open(openCritic.url, '_blank', 'noreferrer,noopener');
                    }
                  }}
                  className="inline-flex items-center justify-center min-w-6 min-h-6 text-steam-subtext hover:text-white transition-colors cursor-pointer"
                  title={
                    openCritic.source === 'metacritic'
                      ? `View ${game.title} on Metacritic.com`
                      : openCritic.source === 'metacritic_user'
                      ? `View ${game.title} User Reviews on Metacritic.com`
                      : openCritic.source === 'steam'
                      ? `View ${game.title} on Steam Store`
                      : openCritic.source === 'gog'
                      ? `View ${game.title} on GOG.com`
                      : openCritic.source === 'epic'
                      ? `View ${game.title} on Epic Games Store`
                      : String(openCritic.id || '').toLowerCase().startsWith('xbox-') ||
                        isXboxStoreHost(openCritic.url)
                      ? `View ${game.title} on Xbox Store`
                      : `View ${game.title} on OpenCritic.com`
                  }
                >
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </div>
              <span className="text-[10px] text-[#94a3b8] mt-0.5 truncate">
                {openCritic.percentRecommended !== undefined
                  ? `${openCritic.percentRecommended}% ${openCritic.source === 'steam' ? 'Positive' : 'Recommended'}`
                  : (openCritic.source === 'gog' ||
                      openCritic.source === 'epic' ||
                      String(openCritic.id || '').toLowerCase().startsWith('xbox-') ||
                      isXboxStoreHost(openCritic.url)) &&
                    openCritic.starRatingRaw !== undefined
                  ? `${openCritic.starRatingRaw}/5 Stars (${openCritic.numReviews ? openCritic.numReviews.toLocaleString() : ''} ratings)`
                  : `${openCritic.tier} Consensus`}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Multi-Store Playtime Breakdown Drawer (Expandable Inline) */}
      {showPlaytimePopover && game.platforms.length > 1 && (
        <div className="mt-4 pt-3.5 border-t border-[#2a475e]/70 animate-in fade-in duration-150">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-sky-400" />
              <span className="text-xs font-bold text-white tracking-wide">
                Storefront Playtime Breakdown
              </span>
              <span className="text-[10px] text-steam-subtext font-normal">
                ({game.platforms.length} connected storefronts)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowPlaytimePopover(false)}
              className="text-steam-subtext hover:text-white px-2 py-0.5 rounded hover:bg-white/10 text-xs flex items-center gap-1 cursor-pointer transition-colors"
              title="Close storefront playtime breakdown"
            >
              <span className="text-[11px]">Close</span>
              <X className="w-3.5 h-3.5" />
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
                      <span className="text-xs font-semibold text-sky-400">
                        {sharePct}%
                      </span>
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
      )}

      {/* Multi-Store Achievements Drawer (Expandable Inline to Avoid Obscuring Content Below) */}
      {showAchievementPopover && platformAchievements.length > 1 && (
        <div className="mt-4 pt-3.5 border-t border-[#2a475e]/70 animate-in fade-in duration-150">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Trophy className="w-4 h-4 text-amber-400" />
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
                  <Trophy className="w-3.5 h-3.5 text-amber-400" />
                  <span>View All Achievements...</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowAchievementPopover(false)}
                className="text-steam-subtext hover:text-white px-2 py-0.5 rounded hover:bg-white/10 text-xs flex items-center gap-1 cursor-pointer transition-colors"
                title="Close storefront achievements"
              >
                <span className="text-[11px]">Close</span>
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {platformAchievements.map((plat) => (
              <div key={plat.platformId} className="bg-[#141d28] p-3 rounded border border-steam-border/50 flex flex-col justify-between">
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
                          {plat.unlocked} <span className="text-xs text-steam-subtext font-normal">/ {plat.total}</span>
                        </span>
                        <span className="text-xs font-semibold text-amber-400">
                          {plat.percentage}%
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-steam-subtext">No Achievements</span>
                    )}
                  </div>

                  {/* Extra Gamerscore or XP badges if applicable */}
                  {plat.total > 0 && plat.gamerscore && (
                    <div className="text-[10px] text-emerald-400 font-mono mt-1">
                      Gamerscore: {plat.gamerscore.earned} / {plat.gamerscore.total} G
                    </div>
                  )}
                  {plat.total > 0 && plat.xp && (
                    <div className="text-[10px] text-sky-400 font-mono mt-1">
                      XP: {plat.xp.earned} / {plat.xp.total} XP
                    </div>
                  )}
                </div>

                {/* Progress bar */}
                {plat.total > 0 && (
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

                {/* View Achievements Button */}
                {plat.total > 0 && onViewAchievements && (
                  <button
                    type="button"
                    onClick={() => onViewAchievements(plat.platformId)}
                    className="mt-3 w-full py-1.5 px-2 rounded bg-[#1b2838] hover:bg-[#25394e] text-xs font-semibold text-steam-accent flex items-center justify-center gap-1 transition-colors cursor-pointer border border-[#2a475e]/60"
                  >
                    <span>View Achievements</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action Feedback Toast Banner */}
      {actionFeedback && (
        <div className="mt-3 px-3 py-2 rounded bg-[#162334] border border-sky-500/40 text-xs text-sky-200 flex items-center justify-between gap-2">
          <span>{actionFeedback}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setActionFeedback(null)}
            className="inline-flex items-center justify-center min-w-6 min-h-6 text-steam-subtext hover:text-white cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Universal Game Install Modal */}
      <GameInstallModal
        isOpen={isInstallModalOpen}
        game={game}
        initialPlatformId={selectedPlatformId}
        onClose={() => setIsInstallModalOpen(false)}
        onInstallStarted={(task) => {
          if (task?.platformId) {
            userManuallySelectedPlatformRef.current = true;
            setSelectedPlatformId(task.platformId);
            launcherService.setSelectedStorefrontForGame(game.id, task.platformId);
          }
        }}
      />

      {/* Per-Game Launch & Compatibility Configuration Modal */}
      <GameLaunchConfigModal
        isOpen={isLaunchConfigModalOpen}
        game={game}
        initialPlatformId={selectedPlatformId}
        onClose={() => setIsLaunchConfigModalOpen(false)}
        onSaved={(cfg) => {
          if (cfg.preferredPlatformId) {
            userManuallySelectedPlatformRef.current = true;
            setSelectedPlatformId(cfg.preferredPlatformId);
            launcherService.setSelectedStorefrontForGame(game.id, cfg.preferredPlatformId);
          }
          showTempFeedback(`Saved launch configuration for ${game.title}.`);
        }}
      />
    </div>
  );
};

