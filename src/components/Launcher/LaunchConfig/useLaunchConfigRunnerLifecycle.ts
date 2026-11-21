import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type { CanonicalGame } from '../../../contracts/game';
import type {
  CompatibilityLayerInfo,
  CompatibilityLayerType,
  CompatibilityLayerUpdateInfo,
  CompatibilityRunnerDescriptor,
  CompatibilityRunnerProgressEvent,
  StorefrontLaunchProfile,
} from '../../../contracts/launcher';
import type { StorefrontId } from '../../../contracts/platform';
import { isBottleNameCompatibleWithRunner } from '../../../services/launcher/bottleArchitectureUtils';
import {
  COMPATIBILITY_RUNNER_DESCRIPTORS,
  launcherService,
} from '../../../services/launcher/launcherService';

export interface RunnerLifecycleContextSnapshot {
  game: CanonicalGame;
  preferredPlatformId: StorefrontId;
  compatibilityLayer: CompatibilityLayerType;
  wineBottleName: string;
  selectedRunnerDescriptor: CompatibilityRunnerDescriptor;
  activeLayer: CompatibilityLayerInfo | undefined;
  activeUpdateInfo: CompatibilityLayerUpdateInfo | undefined;
}

export interface UseLaunchConfigRunnerLifecycleParams {
  isOpen: boolean;
  gameId: string;
  initialPlatformId?: StorefrontId;
  compatibilityLayer: CompatibilityLayerType;
  contextRef: MutableRefObject<RunnerLifecycleContextSnapshot>;
  formSessionIdRef: MutableRefObject<number>;
  compatEditEpochByPlatformRef: MutableRefObject<Partial<Record<StorefrontId, number>>>;
  userEditedCompatPlatformsRef: MutableRefObject<Set<StorefrontId>>;
  userResetPendingDetectPlatformsRef: MutableRefObject<Set<StorefrontId>>;
  hasDetectedLayersResolvedRef: MutableRefObject<boolean>;
  latestDetectedLayersRef: MutableRefObject<CompatibilityLayerInfo[]>;
  setDetectedLayers: Dispatch<SetStateAction<CompatibilityLayerInfo[]>>;
  setRunnerUpdates: Dispatch<SetStateAction<Record<string, CompatibilityLayerUpdateInfo>>>;
  setCompatibilityLayer: Dispatch<SetStateAction<CompatibilityLayerType>>;
  setWineBottleName: Dispatch<SetStateAction<string>>;
  setDraftsByPlatform: Dispatch<
    SetStateAction<Partial<Record<StorefrontId, StorefrontLaunchProfile>>>
  >;
  setDirtyInactivePlatforms: Dispatch<SetStateAction<StorefrontId[]>>;
}

/**
 * Isolates compatibility runner install/update/archive/rescan operations away from the core
 * launch-config form. Lazily subscribes to `launcherService.onRunnerProgress` ONLY while a
 * runner operation is actively running (eliminating the dead always-active listener on modal open).
 */
export function useLaunchConfigRunnerLifecycle({
  isOpen,
  gameId,
  initialPlatformId,
  compatibilityLayer,
  contextRef,
  formSessionIdRef,
  compatEditEpochByPlatformRef,
  userEditedCompatPlatformsRef,
  userResetPendingDetectPlatformsRef,
  hasDetectedLayersResolvedRef,
  latestDetectedLayersRef,
  setDetectedLayers,
  setRunnerUpdates,
  setCompatibilityLayer,
  setWineBottleName,
  setDraftsByPlatform,
  setDirtyInactivePlatforms,
}: UseLaunchConfigRunnerLifecycleParams) {
  const [isInstallingRunner, setIsInstallingRunner] = useState<boolean>(false);
  const [isRescanningRunners, setIsRescanningRunners] = useState<boolean>(false);
  const [runnerActionFeedback, setRunnerActionFeedback] = useState<{
    tone: 'emerald' | 'amber' | 'sky';
    text: string;
  } | null>(null);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState<boolean>(false);
  const [isUpdatingRunner, setIsUpdatingRunner] = useState<boolean>(false);
  const [activeRunnerOpType, setActiveRunnerOpType] = useState<Exclude<
    CompatibilityLayerType,
    'native'
  > | null>(null);
  const [runnerUpdateFeedback, setRunnerUpdateFeedback] = useState<string | null>(null);
  const [runnerProgressByType, setRunnerProgressByType] = useState<
    Partial<Record<Exclude<CompatibilityLayerType, 'native'>, CompatibilityRunnerProgressEvent>>
  >(() => launcherService.getActiveRunnerOperations());

  const activeRunnerOpTypeRef = useRef<Exclude<CompatibilityLayerType, 'native'> | null>(null);

  const activeRunnerProgress =
    compatibilityLayer !== 'native' ? runnerProgressByType[compatibilityLayer] : undefined;
  const isActiveOpOnSelectedRunner =
    !activeRunnerOpType || activeRunnerOpType === compatibilityLayer;
  const isAnotherRunnerOperationActive = Boolean(
    (isInstallingRunner || isUpdatingRunner) &&
      activeRunnerOpType &&
      activeRunnerOpType !== compatibilityLayer
  );
  const effectiveIsInstallingRunner =
    (isInstallingRunner && isActiveOpOnSelectedRunner) ||
    activeRunnerProgress?.operation === 'install';
  const effectiveIsUpdatingRunner =
    (isUpdatingRunner && isActiveOpOnSelectedRunner) ||
    activeRunnerProgress?.operation === 'update';

  const statusRef = useRef({
    isCheckingUpdates,
    isUpdatingRunner: effectiveIsUpdatingRunner,
    isInstallingRunner: effectiveIsInstallingRunner,
    isAnotherRunnerOperationActive,
  });
  statusRef.current = {
    isCheckingUpdates,
    isUpdatingRunner: effectiveIsUpdatingRunner,
    isInstallingRunner: effectiveIsInstallingRunner,
    isAnotherRunnerOperationActive,
  };

  const resetRunnerLifecycleFlags = useCallback(() => {
    setIsUpdatingRunner(false);
    setIsInstallingRunner(false);
    activeRunnerOpTypeRef.current = null;
    setActiveRunnerOpType(null);
    setIsRescanningRunners(false);
    setIsCheckingUpdates(false);
  }, []);

  const clearRunnerFeedback = useCallback(() => {
    setRunnerActionFeedback(null);
    setRunnerUpdateFeedback(null);
  }, []);

  // Snapshot any pre-existing active operations when opening; only subscribe to onRunnerProgress
  // while an active runner operation actually exists (zero dead listener on normal modal opens).
  const hasTrackedActiveProgress =
    activeRunnerOpType !== null || Object.keys(runnerProgressByType).length > 0;

  useEffect(() => {
    if (!isOpen) return;
    const activeOps = launcherService.getActiveRunnerOperations();
    if (Object.keys(activeOps).length > 0) {
      setRunnerProgressByType(activeOps);
    } else {
      setRunnerProgressByType((prev) => (Object.keys(prev).length > 0 ? {} : prev));
    }
  }, [isOpen, gameId, initialPlatformId]);

  useEffect(() => {
    if (!isOpen || !hasTrackedActiveProgress) return undefined;
    let active = true;
    const sessionId = formSessionIdRef.current;
    const unsubscribe = launcherService.onRunnerProgress((event) => {
      if (!active || formSessionIdRef.current !== sessionId) return;
      const isTerminal =
        event.phase === 'completed' || event.phase === 'failed' || event.phase === 'cancelled';
      if (isTerminal) {
        setRunnerProgressByType((prev) => {
          if (!prev[event.runnerType]) return prev;
          const next = { ...prev };
          delete next[event.runnerType];
          return next;
        });
        if (event.phase === 'completed') {
          void launcherService.detectCompatibilityLayers().then((layers) => {
            if (!active || formSessionIdRef.current !== sessionId) return;
            if (Array.isArray(layers)) {
              hasDetectedLayersResolvedRef.current = true;
              latestDetectedLayersRef.current = layers;
              setDetectedLayers(layers);
            }
          });
          void launcherService.checkCompatibilityLayerUpdates().then((updates) => {
            if (!active || formSessionIdRef.current !== sessionId) return;
            if (updates && typeof updates === 'object') {
              setRunnerUpdates(updates);
            }
          });
        }
      } else {
        setRunnerProgressByType((prev) => ({
          ...prev,
          [event.runnerType]: event,
        }));
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [
    isOpen,
    gameId,
    initialPlatformId,
    hasTrackedActiveProgress,
    formSessionIdRef,
    hasDetectedLayersResolvedRef,
    latestDetectedLayersRef,
    setDetectedLayers,
    setRunnerUpdates,
  ]);

  const clearRunnerProgressEntry = useCallback(
    (runnerKey: Exclude<CompatibilityLayerType, 'native'>) => {
      setRunnerProgressByType((prev) => {
        if (!prev[runnerKey]) return prev;
        const next = { ...prev };
        delete next[runnerKey];
        return next;
      });
    },
    []
  );

  const applyStableCrossOverSwitch = useCallback(
    (targetPlatformId: StorefrontId, refreshedLayers: CompatibilityLayerInfo[]) => {
      const crossoverLayer = refreshedLayers.find((l) => l.type === 'crossover');
      const crossoverAvailable = crossoverLayer?.availableBottles || [];
      const isBottleValidForCrossover = (bottleValue: string): boolean => {
        if (!bottleValue) return true;
        const isInAvailable =
          crossoverAvailable.length === 0 || crossoverAvailable.includes(bottleValue);
        const isCompatible = isBottleNameCompatibleWithRunner(bottleValue, 'crossover', {
          allLayers: refreshedLayers,
        });
        return isInAvailable && isCompatible;
      };
      userEditedCompatPlatformsRef.current.add(targetPlatformId);
      userResetPendingDetectPlatformsRef.current.delete(targetPlatformId);
      if (contextRef.current.preferredPlatformId === targetPlatformId) {
        setCompatibilityLayer('crossover');
        const currentBottle = contextRef.current.wineBottleName.trim();
        if (currentBottle && !isBottleValidForCrossover(currentBottle)) {
          setWineBottleName('');
        }
      } else {
        setDraftsByPlatform((prev) => {
          const baseDraft =
            prev[targetPlatformId] ??
            launcherService.getLaunchConfig(contextRef.current.game.id, targetPlatformId);
          const draftBottle = baseDraft?.wineBottleName?.trim() || '';
          const shouldClearDraftBottle =
            Boolean(draftBottle) && !isBottleValidForCrossover(draftBottle);
          return {
            ...prev,
            [targetPlatformId]: {
              ...(baseDraft || {}),
              compatibilityLayer: 'crossover',
              ...(shouldClearDraftBottle ? { wineBottleName: undefined } : {}),
            },
          };
        });
        setDirtyInactivePlatforms((prev) =>
          prev.includes(targetPlatformId) ? prev : [...prev, targetPlatformId]
        );
      }
    },
    [
      contextRef,
      setCompatibilityLayer,
      setDirtyInactivePlatforms,
      setDraftsByPlatform,
      setWineBottleName,
      userEditedCompatPlatformsRef,
      userResetPendingDetectPlatformsRef,
    ]
  );

  const handleRescanLayers = useCallback(async () => {
    const sessionId = formSessionIdRef.current;
    setIsRescanningRunners(true);
    setRunnerActionFeedback(null);
    try {
      const refreshed = await launcherService.detectCompatibilityLayers();
      if (formSessionIdRef.current !== sessionId) return;
      hasDetectedLayersResolvedRef.current = true;
      latestDetectedLayersRef.current = refreshed;
      setDetectedLayers(refreshed);
      const cur = contextRef.current;
      const matched = refreshed.find((l) => l.type === cur.compatibilityLayer);
      if (matched) {
        setRunnerActionFeedback({
          tone: 'emerald',
          text: `Detected ${matched.name}${matched.version ? ` (${matched.version})` : ''} at ${matched.binaryPath}.`,
        });
      } else {
        setRunnerActionFeedback({
          tone: 'amber',
          text: `Scan complete (${refreshed.length} runner${refreshed.length === 1 ? '' : 's'} found). ${cur.selectedRunnerDescriptor.shortLabel} is still not detected.`,
        });
      }
    } finally {
      if (formSessionIdRef.current === sessionId) {
        setIsRescanningRunners(false);
      }
    }
  }, [
    contextRef,
    formSessionIdRef,
    hasDetectedLayersResolvedRef,
    latestDetectedLayersRef,
    setDetectedLayers,
  ]);

  const handleCheckRunnerUpdates = useCallback(async () => {
    if (statusRef.current.isCheckingUpdates) return;
    const sessionId = formSessionIdRef.current;
    setIsCheckingUpdates(true);
    setRunnerUpdateFeedback(null);
    try {
      const [updates, refreshedLayers] = await Promise.all([
        launcherService.checkCompatibilityLayerUpdates(),
        launcherService.detectCompatibilityLayers(),
      ]);
      if (formSessionIdRef.current !== sessionId) return;
      if (updates && typeof updates === 'object') {
        setRunnerUpdates(updates);
      }
      if (Array.isArray(refreshedLayers)) {
        hasDetectedLayersResolvedRef.current = true;
        latestDetectedLayersRef.current = refreshedLayers;
        setDetectedLayers(refreshedLayers);
      }
      const cur = contextRef.current;
      const targetUpd = updates?.[cur.compatibilityLayer];
      if (targetUpd?.updateAvailable && targetUpd.latestVersion) {
        setRunnerUpdateFeedback(
          `Update available for ${cur.selectedRunnerDescriptor.shortLabel}: v${targetUpd.latestVersion}.`
        );
      } else if (targetUpd?.statusMessage) {
        setRunnerUpdateFeedback(targetUpd.statusMessage);
      } else {
        setRunnerUpdateFeedback(
          `${cur.selectedRunnerDescriptor.shortLabel} is up to date${
            targetUpd?.installedVersion ? ` (v${targetUpd.installedVersion})` : ''
          }.`
        );
      }
    } catch (err: unknown) {
      if (formSessionIdRef.current !== sessionId) return;
      const errMsg =
        err instanceof Error && err.message
          ? err.message
          : `Could not check for ${contextRef.current.selectedRunnerDescriptor.shortLabel} updates.`;
      setRunnerUpdateFeedback(errMsg);
    } finally {
      if (formSessionIdRef.current === sessionId) {
        setIsCheckingUpdates(false);
      }
    }
  }, [
    contextRef,
    formSessionIdRef,
    hasDetectedLayersResolvedRef,
    latestDetectedLayersRef,
    setDetectedLayers,
    setRunnerUpdates,
  ]);

  const handleUpdateRunner = useCallback(async () => {
    const cur = contextRef.current;
    const status = statusRef.current;
    if (
      status.isUpdatingRunner ||
      status.isInstallingRunner ||
      status.isAnotherRunnerOperationActive ||
      cur.compatibilityLayer === 'native'
    ) {
      return;
    }
    const sessionId = formSessionIdRef.current;
    const runnerKey = cur.compatibilityLayer as Exclude<CompatibilityLayerType, 'native'>;
    const targetPlatformId = cur.preferredPlatformId;
    const targetCompatEpoch = compatEditEpochByPlatformRef.current[targetPlatformId] ?? 0;
    activeRunnerOpTypeRef.current = runnerKey;
    setActiveRunnerOpType(runnerKey);
    setIsUpdatingRunner(true);
    setRunnerUpdateFeedback(null);
    setRunnerActionFeedback(null);
    try {
      const isPreviewBranch =
        runnerKey === 'crossover_preview' || runnerKey === 'crossover_preview_arm64';
      const shouldSwitchPreviewToStable =
        runnerKey === 'crossover_preview' &&
        Boolean(cur.activeUpdateInfo?.stableSurpassesPreview) &&
        !cur.activeUpdateInfo?.canAutoUpdate;
      const shouldAuthenticateOnly =
        isPreviewBranch &&
        !shouldSwitchPreviewToStable &&
        Boolean(cur.activeUpdateInfo?.authRequired) &&
        !cur.activeUpdateInfo?.updateAvailable;

      const res = shouldSwitchPreviewToStable
        ? await launcherService.updateCompatibilityLayer('crossover_preview', {
            switchToStableCrossOver: true,
          })
        : shouldAuthenticateOnly
          ? await launcherService.updateCompatibilityLayer(runnerKey, { authenticateOnly: true })
          : await launcherService.updateCompatibilityLayer(runnerKey);
      if (formSessionIdRef.current !== sessionId) return;
      const refreshedLayers =
        res.detectedLayers || (await launcherService.detectCompatibilityLayers());
      if (formSessionIdRef.current !== sessionId) return;
      hasDetectedLayersResolvedRef.current = true;
      latestDetectedLayersRef.current = refreshedLayers;
      setDetectedLayers(refreshedLayers);
      if (res.updateInfo) {
        const latestFromService = launcherService.getRunnerUpdates();
        const targetInfoKey =
          res.updateInfo.runnerType || res.runnerType || cur.compatibilityLayer;
        setRunnerUpdates((prev) => ({
          ...prev,
          ...latestFromService,
          [targetInfoKey]: res.updateInfo!,
        }));
      } else {
        setRunnerUpdates({ ...launcherService.getRunnerUpdates() });
      }
      if (
        shouldSwitchPreviewToStable &&
        res.success &&
        refreshedLayers.some((l) => l.type === 'crossover') &&
        formSessionIdRef.current === sessionId &&
        (compatEditEpochByPlatformRef.current[targetPlatformId] ?? 0) === targetCompatEpoch
      ) {
        applyStableCrossOverSwitch(targetPlatformId, refreshedLayers);
      }
      setRunnerUpdateFeedback(res.message || res.error || null);
    } catch (err: unknown) {
      if (formSessionIdRef.current !== sessionId) return;
      const errMsg =
        err instanceof Error && err.message
          ? err.message
          : `Could not update ${cur.selectedRunnerDescriptor.shortLabel}.`;
      setRunnerUpdateFeedback(errMsg);
      setRunnerActionFeedback({ tone: 'amber', text: errMsg });
    } finally {
      if (activeRunnerOpTypeRef.current === runnerKey) {
        activeRunnerOpTypeRef.current = null;
      }
      if (formSessionIdRef.current === sessionId) {
        clearRunnerProgressEntry(runnerKey);
        setActiveRunnerOpType((prev) => (prev === runnerKey ? null : prev));
        setIsUpdatingRunner(false);
      }
    }
  }, [
    applyStableCrossOverSwitch,
    clearRunnerProgressEntry,
    compatEditEpochByPlatformRef,
    contextRef,
    formSessionIdRef,
    hasDetectedLayersResolvedRef,
    latestDetectedLayersRef,
    setDetectedLayers,
    setRunnerUpdates,
  ]);

  const handleInstallRunnerViaBrew = useCallback(async () => {
    const cur = contextRef.current;
    const status = statusRef.current;
    if (
      status.isInstallingRunner ||
      status.isUpdatingRunner ||
      status.isAnotherRunnerOperationActive ||
      cur.compatibilityLayer === 'native'
    ) {
      return;
    }
    const sessionId = formSessionIdRef.current;
    const runnerKey = cur.compatibilityLayer as Exclude<CompatibilityLayerType, 'native'>;
    activeRunnerOpTypeRef.current = runnerKey;
    setActiveRunnerOpType(runnerKey);
    setIsInstallingRunner(true);
    setRunnerActionFeedback(null);
    try {
      const res = await launcherService.installCompatibilityLayer(runnerKey, 'auto');
      if (formSessionIdRef.current !== sessionId) return;
      const refreshed = res.layers || (await launcherService.detectCompatibilityLayers());
      if (formSessionIdRef.current !== sessionId) return;
      hasDetectedLayersResolvedRef.current = true;
      latestDetectedLayersRef.current = refreshed;
      setDetectedLayers(refreshed);
      setRunnerUpdates({ ...launcherService.getRunnerUpdates() });
      if (res.success) {
        setRunnerActionFeedback({
          tone: 'emerald',
          text:
            res.message ||
            `${cur.selectedRunnerDescriptor.shortLabel} downloaded, installed, and ready to use.`,
        });
      } else {
        setRunnerActionFeedback({
          tone: 'amber',
          text:
            res.error ||
            res.message ||
            `Could not install ${cur.selectedRunnerDescriptor.shortLabel}. Please check your internet connection and try again.`,
        });
      }
    } catch (err: unknown) {
      if (formSessionIdRef.current !== sessionId) return;
      const errMsg =
        err instanceof Error && err.message
          ? err.message
          : `Could not install ${cur.selectedRunnerDescriptor.shortLabel}. Please check your internet connection and try again.`;
      setRunnerActionFeedback({
        tone: 'amber',
        text: errMsg,
      });
    } finally {
      if (activeRunnerOpTypeRef.current === runnerKey) {
        activeRunnerOpTypeRef.current = null;
      }
      if (formSessionIdRef.current === sessionId) {
        clearRunnerProgressEntry(runnerKey);
        setActiveRunnerOpType((prev) => (prev === runnerKey ? null : prev));
        setIsInstallingRunner(false);
      }
    }
  }, [
    clearRunnerProgressEntry,
    contextRef,
    formSessionIdRef,
    hasDetectedLayersResolvedRef,
    latestDetectedLayersRef,
    setDetectedLayers,
    setRunnerUpdates,
  ]);

  const handleInstallRunnerFromArchive = useCallback(async () => {
    const cur = contextRef.current;
    const status = statusRef.current;
    if (
      status.isInstallingRunner ||
      status.isUpdatingRunner ||
      status.isAnotherRunnerOperationActive ||
      cur.compatibilityLayer === 'native'
    ) {
      return;
    }
    const sessionId = formSessionIdRef.current;
    const runnerKey = cur.compatibilityLayer as Exclude<CompatibilityLayerType, 'native'>;
    const isUpdatingMode = Boolean(cur.activeLayer);
    activeRunnerOpTypeRef.current = runnerKey;
    setActiveRunnerOpType(runnerKey);
    try {
      const archivePath = await launcherService.selectRunnerArchive();
      if (!archivePath || formSessionIdRef.current !== sessionId) return;

      const isDmg = archivePath.toLowerCase().endsWith('.dmg');
      const archiveOpts = {
        archivePath,
        ...(isDmg ? { dmgPath: archivePath } : {}),
      };

      if (cur.activeLayer) {
        setIsUpdatingRunner(true);
        setRunnerUpdateFeedback(null);
        const res = await launcherService.updateCompatibilityLayer(runnerKey, archiveOpts);
        if (formSessionIdRef.current !== sessionId) return;
        const refreshedLayers =
          res.detectedLayers || (await launcherService.detectCompatibilityLayers());
        if (formSessionIdRef.current !== sessionId) return;
        hasDetectedLayersResolvedRef.current = true;
        latestDetectedLayersRef.current = refreshedLayers;
        setDetectedLayers(refreshedLayers);
        if (res.updateInfo) {
          const latestFromService = launcherService.getRunnerUpdates();
          const targetInfoKey = res.updateInfo.runnerType || res.runnerType || runnerKey;
          setRunnerUpdates((prev) => ({
            ...prev,
            ...latestFromService,
            [targetInfoKey]: res.updateInfo!,
          }));
        } else {
          setRunnerUpdates({ ...launcherService.getRunnerUpdates() });
        }
        setRunnerUpdateFeedback(res.message || res.error || null);
      } else {
        setIsInstallingRunner(true);
        setRunnerActionFeedback(null);
        const res = await launcherService.installCompatibilityLayer(
          runnerKey,
          'direct',
          archiveOpts
        );
        if (formSessionIdRef.current !== sessionId) return;
        const refreshed = res.layers || (await launcherService.detectCompatibilityLayers());
        if (formSessionIdRef.current !== sessionId) return;
        hasDetectedLayersResolvedRef.current = true;
        latestDetectedLayersRef.current = refreshed;
        setDetectedLayers(refreshed);
        setRunnerUpdates({ ...launcherService.getRunnerUpdates() });
        setRunnerActionFeedback({
          tone: res.success ? 'emerald' : 'amber',
          text:
            res.message ||
            res.error ||
            (res.success
              ? `${cur.selectedRunnerDescriptor.shortLabel} installed from local archive.`
              : `Could not install ${cur.selectedRunnerDescriptor.shortLabel} from archive.`),
        });
      }
    } catch (err: unknown) {
      if (formSessionIdRef.current !== sessionId) return;
      const errMsg =
        err instanceof Error && err.message
          ? err.message
          : isUpdatingMode
            ? `Could not update ${cur.selectedRunnerDescriptor.shortLabel} from archive.`
            : `Could not install ${cur.selectedRunnerDescriptor.shortLabel} from archive.`;
      if (isUpdatingMode) {
        setRunnerUpdateFeedback(errMsg);
      }
      setRunnerActionFeedback({ tone: 'amber', text: errMsg });
    } finally {
      if (activeRunnerOpTypeRef.current === runnerKey) {
        activeRunnerOpTypeRef.current = null;
      }
      if (formSessionIdRef.current === sessionId) {
        clearRunnerProgressEntry(runnerKey);
        setActiveRunnerOpType((prev) => (prev === runnerKey ? null : prev));
        setIsUpdatingRunner(false);
        setIsInstallingRunner(false);
      }
    }
  }, [
    clearRunnerProgressEntry,
    contextRef,
    formSessionIdRef,
    hasDetectedLayersResolvedRef,
    latestDetectedLayersRef,
    setDetectedLayers,
    setRunnerUpdates,
  ]);

  const handleCancelRunnerOperation = useCallback(async () => {
    const cur = contextRef.current;
    const trackedRunnerKey = activeRunnerOpTypeRef.current;
    if (!trackedRunnerKey && cur.compatibilityLayer === 'native') return;
    const sessionId = formSessionIdRef.current;
    const runnerKey =
      trackedRunnerKey ||
      (cur.compatibilityLayer as Exclude<CompatibilityLayerType, 'native'>);
    const opDescriptor =
      COMPATIBILITY_RUNNER_DESCRIPTORS.find((d) => d.type === runnerKey) ||
      cur.selectedRunnerDescriptor;
    await launcherService.cancelCompatibilityLayerOperation(runnerKey);
    if (formSessionIdRef.current !== sessionId) return;
    activeRunnerOpTypeRef.current = null;
    setActiveRunnerOpType(null);
    clearRunnerProgressEntry(runnerKey);
    setIsInstallingRunner(false);
    setIsUpdatingRunner(false);
    setRunnerActionFeedback({
      tone: 'amber',
      text: `${opDescriptor.shortLabel} operation cancelled.`,
    });
  }, [clearRunnerProgressEntry, contextRef, formSessionIdRef]);

  const handleSwitchToStableCrossOver = useCallback(async () => {
    const cur = contextRef.current;
    const status = statusRef.current;
    if (status.isUpdatingRunner || status.isInstallingRunner || status.isAnotherRunnerOperationActive) {
      return;
    }
    const sessionId = formSessionIdRef.current;
    const targetPlatformId = cur.preferredPlatformId;
    const targetCompatEpoch = compatEditEpochByPlatformRef.current[targetPlatformId] ?? 0;
    activeRunnerOpTypeRef.current = 'crossover_preview';
    setActiveRunnerOpType('crossover_preview');
    setIsUpdatingRunner(true);
    setRunnerUpdateFeedback(null);
    try {
      const res = await launcherService.updateCompatibilityLayer('crossover_preview', {
        switchToStableCrossOver: true,
      });
      if (formSessionIdRef.current !== sessionId) return;
      const refreshedLayers =
        res.detectedLayers || (await launcherService.detectCompatibilityLayers());
      if (formSessionIdRef.current !== sessionId) return;
      hasDetectedLayersResolvedRef.current = true;
      latestDetectedLayersRef.current = refreshedLayers;
      setDetectedLayers(refreshedLayers);
      setRunnerUpdates({ ...launcherService.getRunnerUpdates() });
      if (
        res.success &&
        refreshedLayers.some((l) => l.type === 'crossover') &&
        formSessionIdRef.current === sessionId &&
        (compatEditEpochByPlatformRef.current[targetPlatformId] ?? 0) === targetCompatEpoch
      ) {
        applyStableCrossOverSwitch(targetPlatformId, refreshedLayers);
      }
      setRunnerUpdateFeedback(
        res.message ||
          res.error ||
          (res.success ? 'Switched to CrossOver Stable.' : 'Could not switch to CrossOver Stable.')
      );
    } catch (err: unknown) {
      if (formSessionIdRef.current !== sessionId) return;
      const errMsg =
        err instanceof Error && err.message
          ? err.message
          : 'Could not switch to CrossOver Stable.';
      setRunnerUpdateFeedback(errMsg);
    } finally {
      if (activeRunnerOpTypeRef.current === 'crossover_preview') {
        activeRunnerOpTypeRef.current = null;
      }
      if (formSessionIdRef.current === sessionId) {
        clearRunnerProgressEntry('crossover_preview');
        clearRunnerProgressEntry('crossover');
        setActiveRunnerOpType((prev) => (prev === 'crossover_preview' ? null : prev));
        setIsUpdatingRunner(false);
      }
    }
  }, [
    applyStableCrossOverSwitch,
    clearRunnerProgressEntry,
    compatEditEpochByPlatformRef,
    contextRef,
    formSessionIdRef,
    hasDetectedLayersResolvedRef,
    latestDetectedLayersRef,
    setDetectedLayers,
    setRunnerUpdates,
  ]);

  const handleDownloadRunner = useCallback(async () => {
    const cur = contextRef.current;
    if (cur.compatibilityLayer === 'native') return;
    const sessionId = formSessionIdRef.current;
    const res = await launcherService.installCompatibilityLayer(
      cur.compatibilityLayer as Exclude<CompatibilityLayerType, 'native'>,
      'download'
    );
    if (formSessionIdRef.current !== sessionId) return;
    setRunnerActionFeedback({
      tone: 'sky',
      text:
        res.message ||
        `Opened official ${cur.selectedRunnerDescriptor.shortLabel} download page. Click Re-Scan after installing.`,
    });
  }, [contextRef, formSessionIdRef]);

  return {
    isInstallingRunner: effectiveIsInstallingRunner,
    isAnotherRunnerOperationActive,
    isRescanningRunners,
    runnerActionFeedback,
    isCheckingUpdates,
    setIsCheckingUpdates,
    isUpdatingRunner: effectiveIsUpdatingRunner,
    runnerUpdateFeedback,
    runnerProgressByType,
    activeRunnerProgress,
    resetRunnerLifecycleFlags,
    clearRunnerFeedback,
    handleRescanLayers,
    handleCheckRunnerUpdates,
    handleUpdateRunner,
    handleInstallRunnerViaBrew,
    handleInstallRunnerFromArchive,
    handleCancelRunnerOperation,
    handleSwitchToStableCrossOver,
    handleDownloadRunner,
  };
}
