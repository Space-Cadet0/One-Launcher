import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  type CompatibilityLayerInfo,
  type GlobalBottleDisplayScalingMode,
  type GlobalDisplayAspectRatioMode,
  type InGameLauncherBehavior,
  type LauncherPerformanceSettings,
  type PostGameLauncherBehavior,
  type StorefrontClientLifecyclePolicy,
} from '../../contracts/launcher';
import {
  getHostCapabilities,
  type HostPlatform,
  type HostPlatformCapabilities,
} from '../../contracts/hostPlatform';
import { sanitizePerformanceSettings } from '../../services/launcher/launchConfigStore';
import { launcherService } from '../../services/launcher/launcherService';
import { environmentSetupService } from '../../services/launcher/environmentSetupService';
import { ModalShell } from '../Common/ModalShell';
import {
  LAUNCH_BUTTON_FOCUS_CLASSES,
  SegmentedRadioGroup,
  SwitchControl,
  type SegmentedRadioOption,
} from '../Launcher/LaunchConfig/LaunchConfigControls';
import { useSafeId } from '../../utils/useSafeId';
import {
  Activity,
  AlertTriangle,
  ArrowDownAZ,
  Cloud,
  Cpu,
  Gauge,
  Maximize2,
  Monitor,
  RotateCcw,
  Save,
  Settings,
  Wrench,
  X,
} from 'lucide-react';

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenRunnerSetup?: () => void;
  onOpenIntegrations?: () => void;
  initialSection?: 'general' | 'macos_bottle';
  hostPlatform?: HostPlatform;
}

function resolveSettingsHostCapabilities(explicit?: HostPlatform): HostPlatformCapabilities {
  if (typeof launcherService.getHostCapabilities === 'function') {
    return launcherService.getHostCapabilities(explicit);
  }
  return getHostCapabilities(explicit);
}

function serializeSettingsForDirtyCheck(settings: LauncherPerformanceSettings): string {
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

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  onOpenRunnerSetup,
  onOpenIntegrations,
  initialSection = 'general',
  hostPlatform,
}) => {
  const idPrefix = useSafeId('global-settings');
  const hostCapabilities = resolveSettingsHostCapabilities(hostPlatform);
  const isMacHost = hostCapabilities.supportsWindowsTranslation;
  const isWindowsHost = hostCapabilities.isWindows;

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
        err instanceof Error && err.message
          ? err.message
          : 'Failed to save global settings.';
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
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('antigravity:open-setup-wizard', {
          detail: { initialStep: setupStep },
        })
      );
    }
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

  if (!isOpen) return null;

  const installedRunners = detectedLayers.filter(
    (layer) => layer.type !== 'native' && layer.available !== false
  );
  const totalBottlesCount = installedRunners.reduce(
    (sum, layer) => sum + (layer.availableBottles?.length || 0),
    0
  );

  const inGameBehaviorOptions: readonly SegmentedRadioOption<InGameLauncherBehavior>[] = [
    {
      value: 'hide_tray_hibernate',
      label: 'Hibernate',
      badge: 'Recommended',
      description: isWindowsHost
        ? 'Hide to system tray & pause UI GPU rendering'
        : 'Hide to menu bar & pause UI GPU rendering',
      testId: 'settings-ingame-hibernate',
    },
    {
      value: 'minimize_taskbar',
      label: 'Minimize',
      description: isWindowsHost
        ? 'Minimize One Launcher to the taskbar'
        : 'Minimize One Launcher to the Dock',
      testId: 'settings-ingame-minimize',
    },
    {
      value: 'keep_open',
      label: 'Keep Open',
      description: 'Keep the One Launcher window open behind the game',
      testId: 'settings-ingame-keep-open',
    },
    ...(draft.inGameLauncherBehavior === 'zero_renderer_daemon'
      ? [
          {
            value: 'zero_renderer_daemon' as const,
            label: 'Zero-Renderer',
            description: 'Unload renderer window while playing (~45 MB RAM)',
            testId: 'settings-ingame-zero-renderer',
          },
        ]
      : []),
  ];

  const postGameOptions: readonly SegmentedRadioOption<PostGameLauncherBehavior>[] = [
    {
      value: 'restore_window',
      label: 'Restore Window',
      testId: 'settings-postgame-restore',
    },
    {
      value: 'stay_minimized',
      label: 'Keep Hidden',
      testId: 'settings-postgame-hidden',
    },
    {
      value: 'exit_launcher',
      label: 'Quit Launcher',
      testId: 'settings-postgame-quit',
    },
  ];

  const storefrontLifecycleOptions: readonly SegmentedRadioOption<StorefrontClientLifecyclePolicy>[] = [
    {
      value: 'minimal_and_close_if_started',
      label: 'Silent & Auto-Close',
      badge: 'Recommended',
      description: 'Minimal client for cloud saves & achievements, then closes after exit',
      testId: 'settings-lifecycle-minimal-close',
    },
    {
      value: 'minimal_keep_running',
      label: 'Minimal & Keep Warm',
      description: 'Runs silently and stays ready in background for faster next launch',
      testId: 'settings-lifecycle-minimal-keep',
    },
    {
      value: 'default_client',
      label: 'Standard Client',
      description: 'Uses the storefront desktop client with its full UI and overlays',
      testId: 'settings-lifecycle-default-client',
    },
    ...(draft.storefrontClientLifecycle === 'fast_direct_bypass'
      ? [
          {
            value: 'fast_direct_bypass' as const,
            label: 'Fast Direct Bypass',
            description: 'Skips launching storefront clients when possible',
            testId: 'settings-lifecycle-fast-bypass',
          },
        ]
      : []),
  ];

  const displayScalingOptions: readonly SegmentedRadioOption<GlobalBottleDisplayScalingMode>[] = [
    {
      value: 'auto_fullscreen',
      label: 'Auto Fullscreen',
      badge: 'Recommended',
      description: 'Native Retina passthrough for 64-bit games & automatic upscaling for legacy games',
      testId: 'settings-display-auto-fullscreen',
    },
    {
      value: 'windowed',
      label: 'Windowed',
      description: 'Keep bottled Windows games inside a standard movable macOS window',
      testId: 'settings-display-windowed',
    },
    {
      value: 'force_fullscreen',
      label: 'Force Fullscreen',
      description: 'Promote even small fixed-size windowed titles into notch-safe fullscreen',
      testId: 'settings-display-force-fullscreen',
    },
    ...(draft.defaultBottleDisplayScalingMode === 'virtual_desktop'
      ? [
          {
            value: 'virtual_desktop' as const,
            label: 'Wine Virtual Desktop',
            description: 'Isolate games inside a Wine virtual desktop container',
            testId: 'settings-display-virtual-desktop',
          },
        ]
      : []),
    ...(draft.defaultBottleDisplayScalingMode === 'native_driver'
      ? [
          {
            value: 'native_driver' as const,
            label: 'Native Wine Driver',
            description: 'Delegate window sizing directly to the Wine Mac Driver',
            testId: 'settings-display-native-driver',
          },
        ]
      : []),
  ];

  const aspectRatioOptions: readonly SegmentedRadioOption<GlobalDisplayAspectRatioMode>[] = [
    {
      value: 'preserve_aspect',
      label: 'Preserve Aspect Ratio',
      testId: 'settings-aspect-preserve',
    },
    {
      value: 'integer',
      label: 'Integer Scale',
      testId: 'settings-aspect-integer',
    },
    {
      value: 'stretch',
      label: 'Stretch',
      testId: 'settings-aspect-stretch',
    },
  ];

  const ignoreLeadingTheLabelId = `${idPrefix}-ignore-leading-the-label`;
  const ignoreLeadingTheHintId = `${idPrefix}-ignore-leading-the-hint`;
  const pauseSyncLabelId = `${idPrefix}-pause-sync-label`;
  const pauseSyncHintId = `${idPrefix}-pause-sync-hint`;
  const pauseDownloadsLabelId = `${idPrefix}-pause-downloads-label`;
  const pauseDownloadsHintId = `${idPrefix}-pause-downloads-hint`;
  const defaultHudLabelId = `${idPrefix}-default-hud-label`;
  const defaultHudHintId = `${idPrefix}-default-hud-hint`;
  const hotkeyLabelId = `${idPrefix}-hotkey-label`;
  const hotkeyHintId = `${idPrefix}-hotkey-hint`;
  const autoShutdownLabelId = `${idPrefix}-auto-shutdown-label`;
  const autoShutdownHintId = `${idPrefix}-auto-shutdown-hint`;

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      preventClose={isSaving || isDirty}
      closeOnBackdrop={!isSaving}
      onCloseAttemptWhilePrevented={handleCloseAttemptWhilePrevented}
      ariaLabelledBy="global-settings-modal-title"
      testId="global-settings-modal"
      className="w-full max-w-2xl"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
        onClick={(e) => e.stopPropagation()}
        className="relative z-10 w-full max-w-2xl rounded-xl bg-[#131b26] border border-[#2a475e] shadow-2xl overflow-hidden text-steam-text flex flex-col max-h-[88vh] select-none overscroll-contain"
      >
        {/* Header */}
        <div className="px-5 py-4 bg-[#0e151f] border-b border-[#223447] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 rounded-lg bg-sky-500/15 border border-sky-400/30 text-sky-400 shrink-0">
              <Settings className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2
                id="global-settings-modal-title"
                className="text-base font-bold text-white truncate"
              >
                Settings
              </h2>
              <p className="text-xs text-steam-subtext truncate">
                {isWindowsHost
                  ? 'Global library sorting, gameplay footprint & launch defaults for all games'
                  : 'Global library sorting, gameplay footprint, performance HUD & platform defaults for all games'}
              </p>
            </div>
          </div>

          <button
            type="button"
            data-testid="settings-close-btn"
            onClick={handleRequestClose}
            disabled={isSaving}
            className={`min-w-6 min-h-6 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-steam-subtext hover:text-white transition-colors cursor-pointer disabled:opacity-50 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
            aria-label="Close settings"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="p-5 space-y-5 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] flex-1 bg-[#131b26] modal-scroll-body">
          {/* Library Sorting */}
          <div
            data-testid="settings-section-library"
            className="rounded-lg bg-[#0e151f] border border-[#223447] p-4 space-y-3"
          >
            <div className="flex items-center gap-2">
              <ArrowDownAZ className="w-4 h-4 text-sky-400 shrink-0" aria-hidden="true" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-white">
                Library Sorting
              </h3>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5">
              <div className="min-w-0 space-y-0.5">
                <span
                  id={ignoreLeadingTheLabelId}
                  className="block text-xs font-semibold text-white"
                >
                  Ignore Leading &quot;The&quot; When Sorting Alphabetically
                </span>
                <p
                  id={ignoreLeadingTheHintId}
                  className="text-[10px] text-steam-subtext leading-snug"
                >
                  When on (default), titles starting with &quot;The&quot; are sorted by the next
                  word (for example, &quot;The Witcher 3&quot; appears under W). Turn off to sort
                  strictly from the first word (under T).
                </p>
              </div>
              <SwitchControl
                dataTestId="settings-toggle-ignore-leading-the"
                checked={draft.ignoreLeadingTheWhenSorting ?? true}
                ariaLabelledBy={ignoreLeadingTheLabelId}
                ariaDescribedBy={ignoreLeadingTheHintId}
                onChange={() =>
                  setDraft((prev) => ({
                    ...prev,
                    ignoreLeadingTheWhenSorting: !(prev.ignoreLeadingTheWhenSorting ?? true),
                  }))
                }
                tone="sky"
              />
            </div>
          </div>

          {/* General & Gameplay Footprint */}
          <div
            data-testid="settings-section-general"
            className="rounded-lg bg-[#0e151f] border border-[#223447] p-4 space-y-4"
          >
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-white">
                General &amp; Gameplay Footprint
              </h3>
            </div>

            <SegmentedRadioGroup
              name={`${idPrefix}-ingame-behavior`}
              legend="While Playing (In-Game Behavior)"
              value={draft.inGameLauncherBehavior}
              options={inGameBehaviorOptions}
              onChange={(val) =>
                setDraft((prev) => ({ ...prev, inGameLauncherBehavior: val }))
              }
              columns={inGameBehaviorOptions.length === 4 ? 2 : 3}
              variant="cards"
              testId="settings-ingame-behavior-group"
            />

            <SegmentedRadioGroup
              name={`${idPrefix}-postgame-behavior`}
              legend="After Game Exits"
              value={draft.postGameLauncherBehavior}
              options={postGameOptions}
              onChange={(val) =>
                setDraft((prev) => ({ ...prev, postGameLauncherBehavior: val }))
              }
              variant="pills"
              testId="settings-postgame-behavior-group"
            />

            <SegmentedRadioGroup
              name={`${idPrefix}-storefront-lifecycle`}
              legend="Default Storefront Client Lifecycle"
              value={draft.storefrontClientLifecycle}
              options={storefrontLifecycleOptions}
              onChange={(val) =>
                setDraft((prev) => ({ ...prev, storefrontClientLifecycle: val }))
              }
              columns={storefrontLifecycleOptions.length === 4 ? 2 : 3}
              variant="cards"
              testId="settings-storefront-lifecycle-group"
            />

            <div className="space-y-2.5 pt-1 border-t border-[#223447]/80">
              <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5">
                <div className="min-w-0 space-y-0.5">
                  <span id={defaultHudLabelId} className="flex items-center gap-1.5 text-xs font-semibold text-white">
                    <Gauge className="w-3.5 h-3.5 text-sky-400 shrink-0" aria-hidden="true" />
                    <span>
                      {isWindowsHost ? 'DXVK Performance HUD' : 'Performance HUD Overlay'}
                    </span>
                  </span>
                  <p id={defaultHudHintId} className="text-[10px] text-steam-subtext leading-snug">
                    {isWindowsHost
                      ? 'Shows FPS & frametime overlay on Vulkan / DXVK-wrapped games'
                      : 'Shows FPS & GPU frametime overlay (Apple Metal HUD with automatic DXVK fallback)'}
                  </p>
                </div>
                <SwitchControl
                  dataTestId="settings-toggle-default-performance-hud"
                  checked={Boolean(draft.defaultPerformanceHud)}
                  ariaLabelledBy={defaultHudLabelId}
                  ariaDescribedBy={defaultHudHintId}
                  onChange={() =>
                    setDraft((prev) => ({
                      ...prev,
                      defaultPerformanceHud: !prev.defaultPerformanceHud,
                    }))
                  }
                  tone="sky"
                />
              </div>

              <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5">
                <div className="min-w-0 space-y-0.5">
                  <span id={pauseSyncLabelId} className="block text-xs font-semibold text-white">
                    Pause Background Store Artwork &amp; Review Scans While Playing
                  </span>
                  <p id={pauseSyncHintId} className="text-[10px] text-steam-subtext leading-snug">
                    Suspends library metadata and critic crawlers during gameplay (Cloud Saves are
                    unaffected).
                  </p>
                </div>
                <SwitchControl
                  dataTestId="settings-toggle-pause-sync"
                  checked={draft.pauseBackgroundSyncInGame}
                  ariaLabelledBy={pauseSyncLabelId}
                  ariaDescribedBy={pauseSyncHintId}
                  onChange={() =>
                    setDraft((prev) => ({
                      ...prev,
                      pauseBackgroundSyncInGame: !prev.pauseBackgroundSyncInGame,
                    }))
                  }
                  tone="emerald"
                />
              </div>

              <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5">
                <div className="min-w-0 space-y-0.5">
                  <span
                    id={pauseDownloadsLabelId}
                    className="block text-xs font-semibold text-white"
                  >
                    Pause Active Game Downloads While Playing
                  </span>
                  <p
                    id={pauseDownloadsHintId}
                    className="text-[10px] text-steam-subtext leading-snug"
                  >
                    Frees network bandwidth and disk I/O during gameplay, then resumes on exit.
                  </p>
                </div>
                <SwitchControl
                  dataTestId="settings-toggle-pause-downloads"
                  checked={draft.pauseDownloadsInGame}
                  ariaLabelledBy={pauseDownloadsLabelId}
                  ariaDescribedBy={pauseDownloadsHintId}
                  onChange={() =>
                    setDraft((prev) => ({
                      ...prev,
                      pauseDownloadsInGame: !prev.pauseDownloadsInGame,
                    }))
                  }
                  tone="emerald"
                />
              </div>
            </div>
          </div>

          {/* Windows Games on macOS (Defaults) — macOS only */}
          {isMacHost && (
            <div
              ref={macSectionRef}
              data-testid="settings-section-macos-bottle"
              className="rounded-lg bg-[#0e151f] border border-[#223447] p-4 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-white">
                    Windows Games on macOS (Defaults)
                  </h3>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-sky-300 font-semibold">
                  Applied to Bottled Games
                </span>
              </div>

              {/* Compact Runners & Bottles Summary Card */}
              <div
                data-testid="settings-runners-summary-card"
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="text-xs font-semibold text-white">
                    Compatibility Runners &amp; Bottles
                  </div>
                  <p className="text-[10px] text-steam-subtext leading-snug">
                    {installedRunners.length > 0
                      ? `${installedRunners.map((r) => (r.version ? `${r.name} v${r.version}` : r.name)).join(' · ')}${totalBottlesCount > 0 ? ` (${totalBottlesCount} ${totalBottlesCount === 1 ? 'bottle' : 'bottles'})` : ''}`
                      : 'No Windows compatibility runners detected yet.'}
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="settings-manage-runners-btn"
                  onClick={handleOpenRunnerSetup}
                  className={`min-h-[28px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 border border-sky-400/40 text-xs font-semibold text-sky-200 hover:text-white transition-colors cursor-pointer shrink-0 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
                >
                  <Wrench className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Manage Runners &amp; Bottles…</span>
                </button>
              </div>

              <SegmentedRadioGroup
                name={`${idPrefix}-default-display-mode`}
                legend={
                  <>
                    <Maximize2 className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                    <span>Default Bottle Display Mode</span>
                  </>
                }
                value={draft.defaultBottleDisplayScalingMode ?? 'auto_fullscreen'}
                options={displayScalingOptions}
                onChange={(val) =>
                  setDraft((prev) => ({ ...prev, defaultBottleDisplayScalingMode: val }))
                }
                columns={displayScalingOptions.length >= 4 ? 2 : 3}
                variant="cards"
                testId="settings-default-display-mode"
              />

              <SegmentedRadioGroup
                name={`${idPrefix}-default-aspect-ratio`}
                legend={
                  <>
                    <Monitor className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                    <span>Default Legacy Aspect Ratio</span>
                  </>
                }
                value={draft.defaultDisplayAspectRatio ?? 'preserve_aspect'}
                options={aspectRatioOptions}
                onChange={(val) =>
                  setDraft((prev) => ({ ...prev, defaultDisplayAspectRatio: val }))
                }
                variant="pills"
                testId="settings-default-aspect-ratio"
              />

              <div className="space-y-2.5 pt-1 border-t border-[#223447]/80">
                <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5">
                  <div className="min-w-0 space-y-0.5">
                    <span id={hotkeyLabelId} className="block text-xs font-semibold text-white">
                      In-Game Fullscreen &amp; Aspect Hotkeys (Ctrl+Option+F / Ctrl+Option+A)
                    </span>
                    <p id={hotkeyHintId} className="text-[10px] text-steam-subtext leading-snug">
                      Enables <kbd className="font-mono text-sky-300">Ctrl+Option+F</kbd>{' '}
                      (Fullscreen) and <kbd className="font-mono text-sky-300">Ctrl+Option+A</kbd>{' '}
                      (Aspect Ratio) inside display-scaled legacy Windows games.
                    </p>
                  </div>
                  <SwitchControl
                    dataTestId="settings-toggle-fullscreen-hotkey"
                    checked={draft.enableFullscreenHotkey ?? true}
                    ariaLabelledBy={hotkeyLabelId}
                    ariaDescribedBy={hotkeyHintId}
                    onChange={() =>
                      setDraft((prev) => ({
                        ...prev,
                        enableFullscreenHotkey: !(prev.enableFullscreenHotkey ?? true),
                      }))
                    }
                    tone="emerald"
                  />
                </div>

                <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2.5">
                  <div className="min-w-0 space-y-0.5">
                    <span
                      id={autoShutdownLabelId}
                      className="block text-xs font-semibold text-white"
                    >
                      Close Idle Bottle Background Daemons After Exit
                    </span>
                    <p
                      id={autoShutdownHintId}
                      className="text-[10px] text-steam-subtext leading-snug"
                    >
                      Waits for Cloud Save uploads and active Bottle downloads to finish, then
                      terminates leftover wineserver / winedevice processes.
                    </p>
                  </div>
                  <SwitchControl
                    dataTestId="settings-toggle-auto-shutdown-wine"
                    checked={draft.autoShutdownWinePrefixOnExit}
                    ariaLabelledBy={autoShutdownLabelId}
                    ariaDescribedBy={autoShutdownHintId}
                    onChange={() =>
                      setDraft((prev) => ({
                        ...prev,
                        autoShutdownWinePrefixOnExit: !prev.autoShutdownWinePrefixOnExit,
                      }))
                    }
                    tone="emerald"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Library & Setup Quick Shortcuts */}
          <div className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 flex flex-wrap items-center justify-between gap-2.5">
            <span className="text-[11px] font-semibold text-steam-subtext">
              Accounts, Offline Vault &amp; Environment Setup
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="settings-open-integrations-btn"
                onClick={handleOpenIntegrations}
                className={`min-h-[28px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#17212e] hover:bg-[#223144] border border-[#2a475e] text-xs font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
              >
                <Cloud className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Storefront Integrations &amp; Vault…</span>
              </button>
              <button
                type="button"
                data-testid="settings-open-runner-setup-btn"
                onClick={handleOpenRunnerSetup}
                className={`min-h-[28px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#17212e] hover:bg-[#223144] border border-[#2a475e] text-xs font-semibold text-emerald-300 hover:text-white transition-colors cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
              >
                <Wrench className="w-3.5 h-3.5" aria-hidden="true" />
                <span>
                  {hostCapabilities.supportsWindowsTranslation
                    ? 'Runner & Bottle Setup…'
                    : 'System Setup Wizard…'}
                </span>
              </button>
            </div>
          </div>
        </div>

        {saveError && (
          <div
            data-testid="settings-save-error"
            role="alert"
            className="mx-5 mb-2 rounded-lg bg-red-950/70 border border-red-500/50 px-3 py-2 text-xs text-red-200 flex items-center gap-2 shrink-0"
          >
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" aria-hidden="true" />
            <span>{saveError}</span>
          </div>
        )}

        {/* Reserved-space unsaved-changes confirmation bar (zero layout shift, always-exposed live region!) */}
        <div
          data-testid="settings-unsaved-confirm-bar"
          className={`min-h-[34px] px-5 py-2 border-t flex items-center gap-2 text-xs shrink-0 transition-colors ${
            showDiscardConfirm
              ? 'bg-amber-950/55 border-amber-500/40 text-amber-200'
              : 'bg-transparent border-transparent text-transparent'
          }`}
        >
          <AlertTriangle
            className="w-3.5 h-3.5 text-amber-400 shrink-0"
            style={{ visibility: showDiscardConfirm ? 'visible' : 'hidden' }}
            aria-hidden="true"
          />
          <span role="status" aria-live="polite" className="text-amber-200">
            {showDiscardConfirm
              ? 'You have unsaved changes. Save settings or discard changes to close.'
              : ''}
          </span>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#0e151f] border-t border-[#223447] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            data-testid="settings-reset-defaults-btn"
            onClick={handleResetToDefaults}
            disabled={isSaving}
            className={`inline-flex items-center gap-1.5 min-h-[28px] px-3 py-2 rounded-lg bg-[#17212e] hover:bg-[#223144] border border-[#2a475e] text-xs font-semibold text-steam-subtext hover:text-white transition-colors cursor-pointer disabled:opacity-50 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Reset to Defaults</span>
          </button>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              data-testid="settings-discard-changes-btn"
              onClick={handleDiscardAndClose}
              disabled={!showDiscardConfirm || isSaving}
              tabIndex={showDiscardConfirm ? 0 : -1}
              aria-hidden={!showDiscardConfirm}
              style={{ visibility: showDiscardConfirm ? 'visible' : 'hidden' }}
              className={`min-h-[28px] px-3.5 py-2 rounded-lg bg-rose-950/75 hover:bg-rose-900/80 border border-rose-500/50 text-xs font-semibold text-rose-200 hover:text-white transition-colors cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
            >
              Discard Changes
            </button>
            <button
              type="button"
              data-testid="settings-cancel-btn"
              onClick={handleRequestClose}
              disabled={isSaving}
              className={`min-h-[28px] px-4 py-2 rounded-lg bg-[#1b2838] hover:bg-[#24354a] text-xs font-semibold text-steam-text hover:text-white transition-colors cursor-pointer disabled:opacity-50 ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="settings-save-btn"
              data-has-unsaved-changes={isDirty ? 'true' : 'false'}
              disabled={isSaving}
              className={`inline-flex items-center gap-1.5 min-h-[28px] px-5 py-2 rounded-lg font-bold text-xs text-white uppercase tracking-wider transition-opacity shadow-lg hover:brightness-110 disabled:opacity-50 cursor-pointer ${LAUNCH_BUTTON_FOCUS_CLASSES}`}
              style={{
                background: 'linear-gradient(to right, #059669 0%, #047857 100%)',
                boxShadow: '0 0 16px rgba(16, 185, 129, 0.35)',
              }}
            >
              <Save className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{isSaving ? 'Saving...' : 'Save Settings'}</span>
            </button>
          </div>
        </div>
      </form>
    </ModalShell>
  );
};
