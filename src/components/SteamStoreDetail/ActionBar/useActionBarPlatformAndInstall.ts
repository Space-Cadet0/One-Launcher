import { useState, useEffect, useRef, useMemo } from 'react';
import { CanonicalGame } from '../../../contracts/game';
import { SteamEnrichedMetadata } from '../../../contracts/steam';
import { StorefrontId } from '../../../contracts/platform';
import { GameCollection } from '../../../contracts/collection';
import { loadCollections } from '../../../services/storage/collectionStorage';
import { launcherService } from '../../../services/launcher/launcherService';
import { getStorefrontNativeOsFlags } from '../../../services/platform/nativeOsService';
import { parseTimestampMs, formatLastPlayedDate } from '../../../utils/dateUtils';
import {
  formatByteSize,
  parseStorageRequirementTextClient,
  sanitizeGameInstallSizeBytes,
} from '../../../utils/formatBytes';

export interface UseActionBarPlatformParams {
  game: CanonicalGame;
  metadata?: SteamEnrichedMetadata | null;
  collections?: GameCollection[];
  onSelectedPlatformChange?: (platformId: StorefrontId) => void;
  onResetUiStateForNewGame: () => void;
}

export function resolveInitialActionBarPlatform(game: CanonicalGame): StorefrontId {
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
}

export function useActionBarPlatformAndInstall({
  game,
  metadata,
  collections,
  onSelectedPlatformChange,
  onResetUiStateForNewGame,
}: UseActionBarPlatformParams) {
  const [launcherTick, setLauncherTick] = useState(0);
  const userManuallySelectedPlatformRef = useRef(false);
  const [selectedPlatformId, setSelectedPlatformId] = useState<StorefrontId>(() =>
    resolveInitialActionBarPlatform(game)
  );
  const [collectionStorageTick, setCollectionStorageTick] = useState(0);
  const [fetchedInstallSize, setFetchedInstallSize] = useState<number | undefined>(undefined);

  useEffect(() => {
    userManuallySelectedPlatformRef.current = false;
    setSelectedPlatformId(resolveInitialActionBarPlatform(game));
    onResetUiStateForNewGame();
  }, [game.id]);

  useEffect(() => {
    onSelectedPlatformChange?.(selectedPlatformId);
  }, [selectedPlatformId, onSelectedPlatformChange]);

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
        sess?.isBottledSession === true ? '1' : sess?.isBottledSession === false ? '0' : '',
        sess?.fullscreenActive ? '1' : '0',
        sess?.displayAspectRatio || '',
        dl?.taskId || '',
        dl?.status || '',
        dl ? String(Math.round(dl.progressPercent || 0)) : '',
        dl?.statusMessage || '',
        dl && dl.speedBytesPerSec > 0 ? (dl.speedBytesPerSec / (1024 * 1024)).toFixed(1) : '',
        persistedPlat,
        rec?.platformId || '',
        rec?.installPath || '',
        rec?.executablePath || '',
        rec?.isWindowsBinaryOnMac ? '1' : '0',
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
  const activeDownload = launcherService.getActiveDownload(game.id, selectedPlatformId);
  const isInstalled =
    launcherService.isGameInstalled(game, selectedPlatformId) ||
    Boolean(activePlatform?.installed);

  const isWindowsHost =
    typeof launcherService.getHostCapabilities === 'function'
      ? launcherService.getHostCapabilities().isWindows
      : typeof window !== 'undefined' && window.electronAPI?.platform === 'win32';

  const isBottledRunningSession = useMemo(() => {
    if (!isRunning || isWindowsHost) return false;
    if (activeSession?.isBottledSession === true) return true;
    if (activeSession?.isBottledSession === false) return false;
    if (installedRecord?.isWindowsBinaryOnMac) return true;
    if (activeSession?.launchMethod === 'compatibility_layer') return true;
    const candidateExe =
      activeSession?.executablePath ||
      installedRecord?.executablePath ||
      activePlatform?.executablePath ||
      launchConfig?.customExecutablePath ||
      '';
    if (/\.exe$/i.test(candidateExe)) return true;
    if (typeof launcherService.resolveEffectiveLaunchModePreview === 'function') {
      const modePreview = launcherService.resolveEffectiveLaunchModePreview(
        game,
        selectedPlatformId
      );
      if (modePreview?.detectedBuildType === 'windows_exe_on_mac') return true;
    }
    return false;
  }, [
    isRunning,
    isWindowsHost,
    activeSession?.isBottledSession,
    activeSession?.launchMethod,
    activeSession?.executablePath,
    installedRecord?.isWindowsBinaryOnMac,
    installedRecord?.executablePath,
    activePlatform?.executablePath,
    launchConfig?.customExecutablePath,
    game,
    selectedPlatformId,
  ]);

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

  const totalPlaytimeMinutes = game.platforms.reduce((acc, p) => acc + (p.playtimeMinutes || 0), 0);

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
    const activeStoreFlags = getStorefrontNativeOsFlags(game, selectedPlatformId);
    const preferMacSpecs = !isWindowsHost && activeStoreFlags.mac;
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
  }, [
    activePlatform?.platformId,
    activePlatform?.xboxProductId,
    activePlatform?.platformGameId,
    game.title,
  ]);

  return {
    selectedPlatformId,
    setSelectedPlatformId,
    userManuallySelectedPlatformRef,
    activePlatform,
    activeSession,
    activeDownload,
    isRunning,
    isInstalled,
    isWindowsHost,
    isBottledRunningSession,
    hasLocalFilesPath,
    isInCollection,
    totalPlaytimeMinutes,
    formatLastPlayed,
    formatPlatformLastPlayed,
    targetSteamAppId,
    getSpaceRequired,
    isXboxSubscriptionExpired,
    xboxStoreUrl,
  };
}
