import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  type CompatibilityLayerInfo,
  type LauncherPerformanceSettings,
} from '../../contracts/launcher';
import {
  getHostCapabilities,
  type HostPlatform,
  type HostPlatformCapabilities,
} from '../../contracts/hostPlatform';
import { sanitizePerformanceSettings } from '../../services/launcher/launchConfigStore';
import { launcherService } from '../../services/launcher/launcherService';
import { environmentSetupService } from '../../services/launcher/environmentSetupService';

export function resolveSettingsHostCapabilities(explicit?: HostPlatform): HostPlatformCapabilities {
  if (typeof launcherService.getHostCapabilities === 'function') {
    return launcherService.getHostCapabilities(explicit);
  }
  return getHostCapabilities(explicit);
}

export function serializeSettingsForDirtyCheck(settings: LauncherPerformanceSettings): string {
  return JSON.stringify({
    inGameLauncherBehavior: settings.inGameLauncherBehavior,
    postGameLauncherBehavior: settings.postGameLauncherBehavior,
    pauseBackgroundSyncInGame: settings.pauseBackgroundSyncInGame,
    pauseDownloadsInGame: settings.pauseDownloadsInGame,
    storefrontClientLifecycle: settings.storefrontClientLifecycle,
    autoShutdownWinePrefixOnExit: settings.autoShutdownWinePrefixOnExit,
    suppressWineDebugLogging: settings.suppressWineDebugLogging,
    defaultBottleDisplayScalingMode: settings.defaultBottleDisplayScalingMode,
    defaultDisplayAspectRatio: settings.defaultDisplayAspectRatio,
    enableFullscreenHotkey: settings.enableFullscreenHotkey,
    defaultPerformanceHud: Boolean(settings.defaultPerformanceHud),
    ignoreLeadingTheWhenSorting: settings.ignoreLeadingTheWhenSorting ?? true,
  });
}

export interface UseSettingsFormStateParams {
  isOpen: boolean;
  onClose: () => void;
  onOpenRunnerSetup?: () => void;
  onOpenIntegrations?: () => void;
  initialSection: 'general' | 'macos_bottle';
  hostPlatform?: HostPlatform;
}

export function useSettingsFormState({
  isOpen,
  onClose,
  onOpenRunnerSetup,
  onOpenIntegrations,
  initialSection,
  hostPlatform,
}: UseSettingsFormStateParams) {
  const hostCapabilities = resolveSettingsHostCapabilities(hostPlatform);
  const isMacHost = hostCapabilities.supportsWindowsTranslation;

  const [draft, setDraft] = useState<LauncherPerformanceSettings>(() =>
    sanitizePerformanceSettings(launcherService.getPerformanceSettings())
  );
  const [baseline, setBaseline] = useState<LauncherPerformanceSettings>(() =>
    sanitizePerformanceSettings(launcherService.getPerformanceSettings())
  );
  const [detectedLayers, setDetectedLayers] = useState<CompatibilityLayerInfo[]>(() =>
    launcherService.getCompatibilityLayers()
  );
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const macSectionRef = useRef<HTMLDivElement | null>(null);
  const discardBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setShowDiscardConfirm(false);
      setSaveError(null);
      return;
    }
    const fresh = sanitizePerformanceSettings(launcherService.getPerformanceSettings());
    setDraft(fresh);
    setBaseline(fresh);
    setShowDiscardConfirm(false);
    setSaveError(null);

    if (isMacHost) {
      setDetectedLayers(launcherService.getCompatibilityLayers());
      let active = true;
      void launcherService
        .detectCompatibilityLayers()
        .then((layers) => {
          if (active && Array.isArray(layers)) {
            setDetectedLayers(layers);
          }
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }
    return undefined;
  }, [isOpen, isMacHost]);

  useEffect(() => {
    if (!isOpen || !isMacHost || initialSection !== 'macos_bottle') return;
    if (macSectionRef.current && typeof macSectionRef.current.scrollIntoView === 'function') {
      macSectionRef.current.scrollIntoView({ block: 'start' });
    }
  }, [isOpen, isMacHost, initialSection]);

  const isDirty = useMemo(
    () => serializeSettingsForDirtyCheck(draft) !== serializeSettingsForDirtyCheck(baseline),
    [draft, baseline]
  );

  useEffect(() => {
    if (!isDirty && showDiscardConfirm) {
      setShowDiscardConfirm(false);
    }
  }, [isDirty, showDiscardConfirm]);

  useEffect(() => {
    if (showDiscardConfirm) {
      discardBtnRef.current?.focus?.({ preventScroll: true });
    }
  }, [showDiscardConfirm]);

  const handleCloseAttemptWhilePrevented = useCallback(() => {
    if (!isSaving && isDirty) {
      setShowDiscardConfirm(true);
    }
  }, [isSaving, isDirty]);

  const handleRequestClose = useCallback(() => {
    if (isSaving) return;
    if (isDirty) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  }, [isSaving, isDirty, onClose]);

  const handleDiscardAndClose = useCallback(() => {
    if (isSaving) return;
    setDraft(baseline);
    setShowDiscardConfirm(false);
    setSaveError(null);
    onClose();
  }, [isSaving, baseline, onClose]);

  const handleResetToDefaults = useCallback(() => {
    if (isSaving) return;
    setDraft({ ...DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS });
    setSaveError(null);
  }, [isSaving]);

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const saved = await launcherService.savePerformanceSettings(draft);
      const cleanSaved = sanitizePerformanceSettings(saved);
      setDraft(cleanSaved);
      setBaseline(cleanSaved);
      setShowDiscardConfirm(false);
      onClose();
    } catch (err: unknown) {
      const msg =
        err instanceof Error && err.message ? err.message : 'Failed to save global settings.';
      setSaveError(msg);
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, draft, onClose]);

  const handleOpenRunnerSetup = useCallback(() => {
    if (onOpenRunnerSetup) {
      onOpenRunnerSetup();
      return;
    }
    const setupStep = hostCapabilities.supportsWindowsTranslation
      ? 'compatibility'
      : 'prerequisites';
    // Dispatch ONLY canonical OPEN_SYSTEM_SETUP_EVENT via environmentSetupService.openWizard
    environmentSetupService.openWizard({
      mode: 'health_check',
      initialStep: setupStep,
    });
  }, [onOpenRunnerSetup, hostCapabilities.supportsWindowsTranslation]);

  const handleOpenIntegrations = useCallback(() => {
    if (onOpenIntegrations) {
      onOpenIntegrations();
      return;
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('antigravity:open-integrations'));
    }
  }, [onOpenIntegrations]);

  const installedRunners = detectedLayers.filter(
    (layer) => layer.type !== 'native' && layer.available !== false
  );
  const totalBottlesCount = installedRunners.reduce(
    (sum, layer) => sum + (layer.availableBottles?.length || 0),
    0
  );

  return {
    hostCapabilities,
    isMacHost,
    draft,
    setDraft,
    isDirty,
    isSaving,
    saveError,
    showDiscardConfirm,
    macSectionRef,
    discardBtnRef,
    installedRunners,
    totalBottlesCount,
    handleCloseAttemptWhilePrevented,
    handleRequestClose,
    handleDiscardAndClose,
    handleResetToDefaults,
    handleSave,
    handleOpenRunnerSetup,
    handleOpenIntegrations,
  };
}
