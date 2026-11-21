import {
  useState,
  useEffect,
  useRef,
  useCallback,
  startTransition,
  type RefObject,
} from 'react';
import type { CanonicalGame } from '../contracts/game';
import type { StorefrontId } from '../contracts/platform';
import type {
  EnvironmentComponentId,
  SetupWizardOpenMode,
  SetupWizardStepId,
} from '../contracts/environmentSetup';
import { loadIntegrations } from '../services/integrations/integrationStorage';
import { launcherService } from '../services/launcher/launcherService';
import {
  environmentSetupService,
  getRemovedComponents,
  OPEN_SYSTEM_SETUP_EVENT,
  shouldAutoOpenSetupWizardOnStartup,
  type OpenSystemSetupEventDetail,
} from '../services/launcher/environmentSetupService';
import { isModalOverlayOpen } from '../utils/modalOverlayLock';

export interface UseAppModalOrchestratorParams {
  selectedGame: CanonicalGame | null;
  gamesRef: RefObject<CanonicalGame[]>;
  connectedStorefrontsRef: RefObject<StorefrontId[]>;
  isCatalogVaultHydrated: boolean;
  isMatchManagerOpen: boolean;
  isFixMatchModalOpen: boolean;
  isManageCollectionsOpen: boolean;
  onSetupStateChanged: () => void;
}

export function useAppModalOrchestrator({
  selectedGame,
  gamesRef,
  connectedStorefrontsRef,
  isCatalogVaultHydrated,
  isMatchManagerOpen,
  isFixMatchModalOpen,
  isManageCollectionsOpen,
  onSetupStateChanged,
}: UseAppModalOrchestratorParams) {
  const [isIntegrationsModalOpen, setIsIntegrationsModalOpen] = useState(false);
  const [isAchievementsModalOpen, setIsAchievementsModalOpen] = useState(false);
  const [achievementsModalGame, setAchievementsModalGame] = useState<CanonicalGame | null>(null);
  const [achievementsInitialStorefrontId, setAchievementsInitialStorefrontId] = useState<
    StorefrontId | undefined
  >(undefined);
  const [isDownloadDrawerOpen, setIsDownloadDrawerOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<'general' | 'macos_bottle'>(
    'general'
  );
  const [isSystemSetupOpen, setIsSystemSetupOpen] = useState(false);
  const [systemSetupMode, setSystemSetupMode] = useState<SetupWizardOpenMode>('health_check');
  const [systemSetupInitialStep, setSystemSetupInitialStep] = useState<
    SetupWizardStepId | undefined
  >(undefined);
  const [systemSetupFocusComponent, setSystemSetupFocusComponent] = useState<
    EnvironmentComponentId | undefined
  >(undefined);
  const [systemSetupAlertCount, setSystemSetupAlertCount] = useState<number>(
    () => environmentSetupService.getLastSnapshot()?.counts.removedSinceLastSetupCount || 0
  );
  const [hasActiveOverlayLock, setHasActiveOverlayLock] = useState<boolean>(() =>
    isModalOverlayOpen()
  );

  const hasCheckedStartupWizardRef = useRef(false);
  const setupSessionBaselineSigRef = useRef<string>('');
  const pendingSetupDispatchSigRef = useRef<string | null>(null);

  const isInteractiveModalBusy =
    hasActiveOverlayLock ||
    isMatchManagerOpen ||
    isFixMatchModalOpen ||
    isIntegrationsModalOpen ||
    isSystemSetupOpen ||
    isSettingsOpen ||
    isManageCollectionsOpen ||
    isAchievementsModalOpen ||
    isDownloadDrawerOpen;

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return undefined;
    }
    const handleModalOverlayChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ isOpen?: boolean } | undefined>).detail;
      setHasActiveOverlayLock(
        typeof detail?.isOpen === 'boolean' ? detail.isOpen : isModalOverlayOpen()
      );
    };
    window.addEventListener('antigravity:modal-overlay-changed', handleModalOverlayChanged);
    return () => {
      window.removeEventListener('antigravity:modal-overlay-changed', handleModalOverlayChanged);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.offlineVault) return undefined;
    const vault = window.electronAPI.offlineVault as typeof window.electronAPI.offlineVault & {
      setModalBusy?: (busy: boolean) => Promise<unknown> | void;
    };
    const notifyBusy = (busy: boolean) => {
      try {
        const maybePromise = vault.setModalBusy?.(busy);
        if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === 'function') {
          void (maybePromise as Promise<unknown>).catch(() => {});
        }
      } catch {}
    };
    notifyBusy(isInteractiveModalBusy);
    return () => {
      if (isInteractiveModalBusy) {
        notifyBusy(false);
      }
    };
  }, [isInteractiveModalBusy]);

  const handleOpenAchievements = useCallback(
    (gameToView?: CanonicalGame | null, storefrontId?: StorefrontId) => {
      const targetGame = gameToView || selectedGame;
      if (targetGame) {
        setAchievementsModalGame(targetGame);
        setAchievementsInitialStorefrontId(storefrontId);
        setIsAchievementsModalOpen(true);
      }
    },
    [selectedGame]
  );

  const handleCloseAchievementsModal = useCallback(() => {
    setIsAchievementsModalOpen(false);
    setAchievementsModalGame(null);
    setAchievementsInitialStorefrontId(undefined);
  }, []);

  const handleTopNavOpenAchievements = useCallback(() => {
    handleOpenAchievements();
  }, [handleOpenAchievements]);

  const handleOpenIntegrationsModal = useCallback(() => {
    setIsIntegrationsModalOpen(true);
  }, []);

  const handleCloseIntegrationsModal = useCallback(() => {
    setIsIntegrationsModalOpen(false);
  }, []);

  const handleOpenDownloadDrawer = useCallback(() => {
    setIsDownloadDrawerOpen(true);
  }, []);

  const handleCloseDownloadDrawer = useCallback(() => {
    setIsDownloadDrawerOpen(false);
  }, []);

  const computeSetupSessionSignature = useCallback((): string => {
    const ws = environmentSetupService.getWizardState();
    let connectedSig = '';
    try {
      connectedSig = loadIntegrations()
        .filter((i) => i.isConnected)
        .map((i) => i.storefrontId)
        .join(',');
    } catch {}
    return `${ws?.completedAt ?? ''}|${(ws?.configuredComponents ?? []).join(',')}|${connectedSig}`;
  }, []);

  const handleOpenSystemSetup = useCallback(
    (
      mode: SetupWizardOpenMode = 'health_check',
      initialStep?: SetupWizardStepId,
      focusComponentId?: EnvironmentComponentId
    ) => {
      setupSessionBaselineSigRef.current = computeSetupSessionSignature();
      setSystemSetupMode(mode);
      setSystemSetupInitialStep(initialStep);
      setSystemSetupFocusComponent(focusComponentId);
      setIsSystemSetupOpen(true);
    },
    [computeSetupSessionSignature]
  );

  const handleCloseSystemSetup = useCallback(() => {
    pendingSetupDispatchSigRef.current = null;
    const didSetupOrAccountsChange =
      computeSetupSessionSignature() !== setupSessionBaselineSigRef.current;
    setIsSystemSetupOpen(false);
    setSystemSetupInitialStep(undefined);
    setSystemSetupFocusComponent(undefined);
    if (didSetupOrAccountsChange) {
      startTransition(() => {
        onSetupStateChanged();
      });
    }
  }, [computeSetupSessionSignature, onSetupStateChanged]);

  const handleTopNavOpenSystemSetup = useCallback(() => {
    handleOpenSystemSetup('health_check');
  }, [handleOpenSystemSetup]);

  const openGlobalSettings = useCallback((section?: string) => {
    const normalizedSection: 'general' | 'macos_bottle' =
      section === 'macos_bottle' ? 'macos_bottle' : 'general';
    setSettingsInitialSection(normalizedSection);
    setIsSettingsOpen(true);
  }, []);

  const handleTopNavOpenSettings = useCallback(() => {
    openGlobalSettings('general');
  }, [openGlobalSettings]);

  const handleCloseSettingsModal = useCallback(() => {
    setIsSettingsOpen(false);
  }, []);

  const handleOpenIntegrationsFromSettings = useCallback(() => {
    setIsSettingsOpen(false);
    setIsIntegrationsModalOpen(true);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return undefined;
    }

    const handleOpenDrawer = () => setIsDownloadDrawerOpen(true);
    const handleOpenIntegrationsEvent = () => {
      setIsSettingsOpen(false);
      setIsIntegrationsModalOpen(true);
    };
    const handleOpenSettingsEvent = (event: Event) => {
      const detail = (
        event as CustomEvent<{ section?: 'general' | 'macos_bottle' | string } | undefined>
      ).detail;
      openGlobalSettings(detail?.section);
    };
    const handleSettingsKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === ',') {
        event.preventDefault();
        openGlobalSettings('general');
      }
    };

    window.addEventListener('antigravity:open-download-drawer', handleOpenDrawer);
    window.addEventListener('antigravity:open-integrations', handleOpenIntegrationsEvent);
    window.addEventListener('antigravity:open-settings', handleOpenSettingsEvent);
    window.addEventListener('keydown', handleSettingsKeyDown);

    const unsubscribeIpcOpenSettings = window.electronAPI?.onOpenSettings?.((section) => {
      openGlobalSettings(section);
    });

    return () => {
      window.removeEventListener('antigravity:open-download-drawer', handleOpenDrawer);
      window.removeEventListener('antigravity:open-integrations', handleOpenIntegrationsEvent);
      window.removeEventListener('antigravity:open-settings', handleOpenSettingsEvent);
      window.removeEventListener('keydown', handleSettingsKeyDown);
      unsubscribeIpcOpenSettings?.();
    };
  }, [openGlobalSettings]);

  useEffect(() => {
    const syncAlertCount = () => {
      const snap = environmentSetupService.getLastSnapshot();
      const nextCount = snap
        ? getRemovedComponents(snap).filter(
            (comp) => !(snap.hostPlatform === 'darwin' && comp.id === 'rosetta2')
          ).length
        : 0;
      setSystemSetupAlertCount((prev) => (prev === nextCount ? prev : nextCount));
    };
    syncAlertCount();
    return environmentSetupService.subscribe(syncAlertCount);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return undefined;
    }
    const getDefaultCompatOrPrereqStep = (): SetupWizardStepId =>
      launcherService.getHostCapabilities().supportsWindowsTranslation
        ? 'compatibility'
        : 'prerequisites';
    const normalizeWizardStep = (step?: string): SetupWizardStepId | undefined => {
      if (!step) return undefined;
      if (step === 'compatibility_and_bottle' || step === 'compatibility') {
        return getDefaultCompatOrPrereqStep();
      }
      if (
        step === 'prerequisites' ||
        step === 'accounts' ||
        step === 'clients' ||
        step === 'client_logins' ||
        step === 'summary'
      ) {
        return step;
      }
      return undefined;
    };

    const dispatchSetupOpen = (
      mode: SetupWizardOpenMode,
      initialStep: SetupWizardStepId | undefined,
      focusComponentId: EnvironmentComponentId | undefined
    ) => {
      const sig = `${mode}|${initialStep ?? ''}|${focusComponentId ?? ''}`;
      if (pendingSetupDispatchSigRef.current === sig) {
        return;
      }
      pendingSetupDispatchSigRef.current = sig;
      if (typeof queueMicrotask === 'function') {
        queueMicrotask(() => {
          if (pendingSetupDispatchSigRef.current === sig) {
            pendingSetupDispatchSigRef.current = null;
          }
        });
      } else {
        pendingSetupDispatchSigRef.current = null;
      }
      handleOpenSystemSetup(mode, initialStep, focusComponentId);
    };

    const handleOpenEvent = (event: Event) => {
      const detail = (event as CustomEvent<OpenSystemSetupEventDetail | undefined>).detail;
      dispatchSetupOpen(
        detail?.mode || 'health_check',
        normalizeWizardStep(detail?.initialStep),
        detail?.focusComponentId
      );
    };

    // Preserve legacy 'antigravity:open-setup-wizard' inbound alias alongside canonical OPEN_SYSTEM_SETUP_EVENT
    const handleOpenSetupWizardEvent = (event: Event) => {
      const detail = (
        event as CustomEvent<
          | {
              mode?: SetupWizardOpenMode;
              initialStep?: SetupWizardStepId | 'compatibility_and_bottle' | string;
              focusComponentId?: EnvironmentComponentId;
            }
          | undefined
        >
      ).detail;
      dispatchSetupOpen(
        detail?.mode || 'health_check',
        normalizeWizardStep(detail?.initialStep) || getDefaultCompatOrPrereqStep(),
        detail?.focusComponentId
      );
    };

    window.addEventListener(OPEN_SYSTEM_SETUP_EVENT, handleOpenEvent);
    window.addEventListener('antigravity:open-setup-wizard', handleOpenSetupWizardEvent);
    return () => {
      window.removeEventListener(OPEN_SYSTEM_SETUP_EVENT, handleOpenEvent);
      window.removeEventListener('antigravity:open-setup-wizard', handleOpenSetupWizardEvent);
    };
  }, [handleOpenSystemSetup]);

  useEffect(() => {
    if (!isCatalogVaultHydrated || hasCheckedStartupWizardRef.current) return undefined;
    hasCheckedStartupWizardRef.current = true;

    let cancelled = false;
    let idleHandle: number | null = null;
    let timerHandle: ReturnType<typeof setTimeout> | null = null;
    const win =
      typeof window !== 'undefined'
        ? (window as Window & {
            requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
            cancelIdleCallback?: (id: number) => void;
          })
        : undefined;

    void environmentSetupService
      .loadWizardState()
      .then((wizardState) => {
        if (cancelled) return;
        const connected = connectedStorefrontsRef.current ?? [];
        const isElectronRuntime =
          typeof window !== 'undefined' && Boolean(window.electronAPI?.isElectron);
        const shouldAutoOpen = shouldAutoOpenSetupWizardOnStartup({
          wizardState,
          connectedStorefrontsCount: connected.length,
          catalogGamesCount: gamesRef.current?.length ?? 0,
          isElectronRuntime,
        });

        if (shouldAutoOpen) {
          handleOpenSystemSetup('first_launch');
          return;
        }

        if (
          isElectronRuntime &&
          typeof window !== 'undefined' &&
          typeof window.electronAPI?.probeEnvironmentHealth === 'function'
        ) {
          const runIdleProbe = () => {
            if (cancelled) return;
            void environmentSetupService
              .probeHealth(connectedStorefrontsRef.current ?? [])
              .catch(() => {});
          };
          if (win && typeof win.requestIdleCallback === 'function') {
            idleHandle = win.requestIdleCallback(runIdleProbe, { timeout: 4000 });
          } else {
            timerHandle = setTimeout(runIdleProbe, 3000);
          }
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (idleHandle !== null && win && typeof win.cancelIdleCallback === 'function') {
        win.cancelIdleCallback(idleHandle);
      }
      if (timerHandle !== null) {
        clearTimeout(timerHandle);
      }
    };
  }, [connectedStorefrontsRef, gamesRef, handleOpenSystemSetup, isCatalogVaultHydrated]);

  return {
    isInteractiveModalBusy,
    isIntegrationsModalOpen,
    handleOpenIntegrationsModal,
    handleCloseIntegrationsModal,
    isAchievementsModalOpen,
    achievementsModalGame,
    achievementsInitialStorefrontId,
    handleOpenAchievements,
    handleCloseAchievementsModal,
    handleTopNavOpenAchievements,
    isDownloadDrawerOpen,
    handleOpenDownloadDrawer,
    handleCloseDownloadDrawer,
    isSettingsOpen,
    settingsInitialSection,
    handleTopNavOpenSettings,
    handleCloseSettingsModal,
    handleOpenIntegrationsFromSettings,
    isSystemSetupOpen,
    systemSetupMode,
    systemSetupInitialStep,
    systemSetupFocusComponent,
    systemSetupAlertCount,
    handleOpenSystemSetup,
    handleCloseSystemSetup,
    handleTopNavOpenSystemSetup,
  };
}
