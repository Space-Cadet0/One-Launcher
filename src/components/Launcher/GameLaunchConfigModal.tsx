import React, { useState, useEffect } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { StorefrontId } from '../../contracts/platform';
import {
  CompatibilityLayerInfo,
  CompatibilityLayerType,
  CrossOverGraphicsBackend,
  GameLaunchConfig,
  LaunchMethod,
  StorefrontLaunchProfile,
} from '../../contracts/launcher';
import { launcherService } from '../../services/launcher/launcherService';
import { StorefrontIcon, getStorefrontDisplayName } from '../Common/StorefrontIcon';
import {
  Settings,
  FolderOpen,
  FileCode,
  Terminal,
  Cpu,
  X,
  Save,
  RotateCcw,
  CheckCircle2,
  Sliders,
  AlertTriangle,
  Sparkles,
  Monitor,
  Activity,
} from 'lucide-react';

export interface GameLaunchConfigModalProps {
  isOpen: boolean;
  game: CanonicalGame;
  initialPlatformId?: StorefrontId;
  onClose: () => void;
  onSaved?: (config: GameLaunchConfig) => void;
}

const LAUNCH_MODES: { value: LaunchMethod; label: string; desc: string }[] = [
  {
    value: 'auto',
    label: 'Auto-Detect (Recommended)',
    desc: 'Uses direct executable or compatibility layer if found, otherwise Storefront URI.',
  },
  {
    value: 'direct',
    label: 'Direct Executable (.app / binary)',
    desc: 'Spawns the local game binary directly and tracks live process exit.',
  },
  {
    value: 'compatibility_layer',
    label: 'macOS Compatibility Layer (CrossOver / Wine / GPTK)',
    desc: 'Runs Windows .exe builds through CrossOver, Whisky, Apple GPTK, or Wine.',
  },
  {
    value: 'storefront_uri',
    label: 'Storefront Client Protocol',
    desc: 'Launches via native Steam, GOG Galaxy, or Epic Games client protocol URI.',
  },
];

const COMPAT_LAYER_OPTIONS: { value: CompatibilityLayerType; label: string }[] = [
  { value: 'crossover', label: 'CrossOver macOS' },
  { value: 'crossover_preview', label: 'CrossOver Preview' },
  { value: 'whisky', label: 'Whisky (Wine / GPTK)' },
  { value: 'gptk', label: 'Apple Game Porting Toolkit (GPTK)' },
  { value: 'wine', label: 'Standard Wine / Homebrew Wine' },
  { value: 'native', label: 'macOS Native' },
];

const CROSSOVER_BACKEND_OPTIONS: { value: CrossOverGraphicsBackend; label: string }[] = [
  { value: 'auto', label: 'Auto (Recommended — Best backend per game)' },
  { value: 'd3dmetal', label: 'D3DMetal (Apple GPTK — DirectX 11 & 12)' },
  { value: 'dxmt', label: 'DXMT (Metal DirectX 11 layer)' },
  { value: 'dxvk', label: 'DXVK (Vulkan DirectX 10 & 11 layer)' },
  { value: 'wined3d', label: 'WineD3D (OpenGL — DirectX 9 & Legacy)' },
];

const WINDOWS_QUICK_ENV_TOGGLES: { key: string; value: string; label: string; desc: string }[] = [
  { key: 'DXVK_HUD', value: '1', label: 'DXVK Overlay HUD', desc: 'DXVK_HUD=1' },
];

function serializeEnvVars(env?: Record<string, string>): string {
  if (!env) return '';
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function parseEnvVars(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim();
      if (k) result[k] = v;
    }
  }
  return result;
}

function getBadgeToneClasses(tone?: 'emerald' | 'sky' | 'amber' | 'slate'): string {
  switch (tone) {
    case 'emerald':
      return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
    case 'sky':
      return 'bg-sky-500/20 text-sky-300 border-sky-500/40';
    case 'amber':
      return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
    default:
      return 'bg-slate-500/20 text-slate-300 border-slate-500/40';
  }
}

export const GameLaunchConfigModal: React.FC<GameLaunchConfigModalProps> = ({
  isOpen,
  game,
  initialPlatformId,
  onClose,
  onSaved,
}) => {
  const [preferredPlatformId, setPreferredPlatformId] = useState<StorefrontId>('steam');
  const [draftsByPlatform, setDraftsByPlatform] = useState<
    Partial<Record<StorefrontId, StorefrontLaunchProfile>>
  >({});
  const [launchMethod, setLaunchMethod] = useState<LaunchMethod>('auto');
  const [customExecutablePath, setCustomExecutablePath] = useState<string>('');
  const [workingDirectory, setWorkingDirectory] = useState<string>('');
  const [launchArguments, setLaunchArguments] = useState<string>('');
  const [compatibilityLayer, setCompatibilityLayer] = useState<CompatibilityLayerType>('crossover');
  const [wineBottleName, setWineBottleName] = useState<string>('');
  const [winePrefixPath, setWinePrefixPath] = useState<string>('');
  const [crossoverGraphicsBackend, setCrossoverGraphicsBackend] =
    useState<CrossOverGraphicsBackend>('auto');
  const [crossoverHighResolutionMode, setCrossoverHighResolutionMode] = useState<
    boolean | undefined
  >(undefined);
  const [crossoverDlss, setCrossoverDlss] = useState<boolean>(false);
  const [wineMsync, setWineMsync] = useState<boolean>(true);
  const [wineEsync, setWineEsync] = useState<boolean>(false);
  const [metalHud, setMetalHud] = useState<boolean>(false);
  const [dxvkHud, setDxvkHud] = useState<boolean>(false);
  const [envText, setEnvText] = useState<string>('');
  const [preLaunchCommand, setPreLaunchCommand] = useState<string>('');
  const [postExitCommand, setPostExitCommand] = useState<string>('');
  const [detectedLayers, setDetectedLayers] = useState<CompatibilityLayerInfo[]>([]);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  const loadFormFieldsForPlatform = (
    targetPlatId: StorefrontId,
    drafts?: Partial<Record<StorefrontId, StorefrontLaunchProfile>>,
    layersOverride?: CompatibilityLayerInfo[]
  ) => {
    const source = drafts?.[targetPlatId] ?? launcherService.getLaunchConfig(game.id, targetPlatId);
    const activeLayers = layersOverride || detectedLayers;

    setLaunchMethod(source?.launchMethod || 'auto');
    setCustomExecutablePath(source?.customExecutablePath || '');
    setWorkingDirectory(source?.workingDirectory || '');
    setLaunchArguments(source?.launchArguments || '');
    setCompatibilityLayer(source?.compatibilityLayer || activeLayers[0]?.type || 'crossover');
    setWineBottleName(source?.wineBottleName || activeLayers[0]?.availableBottles?.[0] || '');
    setWinePrefixPath(source?.winePrefixPath || '');
    setCrossoverGraphicsBackend(source?.crossoverGraphicsBackend || 'auto');
    setCrossoverHighResolutionMode(source?.crossoverHighResolutionMode);
    setCrossoverDlss(Boolean(source?.crossoverDlss));
    const loadedMsync =
      source?.wineMsync !== undefined
        ? source.wineMsync
        : source?.environmentVariables?.WINEMSYNC === '0'
          ? false
          : true;
    let loadedEsync =
      source?.wineEsync !== undefined
        ? source.wineEsync
        : source?.environmentVariables?.WINEESYNC === '1'
          ? true
          : false;
    if (loadedMsync && loadedEsync) {
      loadedEsync = false;
    }
    setWineMsync(loadedMsync);
    setWineEsync(loadedEsync);
    setMetalHud(
      source?.metalHud !== undefined
        ? source.metalHud
        : source?.environmentVariables?.MTL_HUD_ENABLED === '1'
    );
    setDxvkHud(
      source?.dxvkHud !== undefined
        ? source.dxvkHud
        : Boolean(source?.environmentVariables?.DXVK_HUD)
    );
    setEnvText(serializeEnvVars(source?.environmentVariables));
    setPreLaunchCommand(source?.preLaunchCommand || '');
    setPostExitCommand(source?.postExitCommand || '');
  };

  useEffect(() => {
    if (!isOpen) return;

    const existingBase = launcherService.getLaunchConfig(game.id);
    const effPlat = launcherService.getEffectivePlatformForGame(game);
    const startPlatId: StorefrontId =
      initialPlatformId ||
      existingBase?.preferredPlatformId ||
      effPlat?.platformId ||
      game.platforms[0]?.platformId ||
      'steam';

    const initialDrafts: Partial<Record<StorefrontId, StorefrontLaunchProfile>> = {
      ...(existingBase?.platformConfigs || {}),
    };

    setDraftsByPlatform(initialDrafts);
    setPreferredPlatformId(startPlatId);

    const initialLayers = launcherService.getCompatibilityLayers();
    setDetectedLayers(initialLayers);
    loadFormFieldsForPlatform(startPlatId, initialDrafts, initialLayers);

    launcherService.detectCompatibilityLayers().then((layers) => {
      setDetectedLayers(layers);
      const activeSource =
        initialDrafts[startPlatId] ?? launcherService.getLaunchConfig(game.id, startPlatId);
      if (!activeSource?.compatibilityLayer && layers.length > 0) {
        setCompatibilityLayer(layers[0].type);
        if (!activeSource?.wineBottleName && layers[0].availableBottles?.length) {
          setWineBottleName(layers[0].availableBottles[0]);
        }
      }
    });
  }, [isOpen, game.id, initialPlatformId]);

  if (!isOpen) return null;

  const activeLayerInfo = detectedLayers.find((l) => l.type === compatibilityLayer);
  const availableBottles = activeLayerInfo?.availableBottles || [];

  const installedRecord = launcherService.getInstalledRecordForGame(game, preferredPlatformId);

  const isWindowsHost =
    (typeof (launcherService as any).isWindowsHost === 'function' &&
      (launcherService as any).isWindowsHost()) ||
    (typeof window !== 'undefined' && (window as any)?.electronAPI?.platform === 'win32') ||
    /^[A-Za-z]:\\/.test(
      workingDirectory ||
        customExecutablePath ||
        installedRecord?.installPath ||
        installedRecord?.executablePath ||
        game.platforms.find((p) => p.platformId === preferredPlatformId)?.installPath ||
        game.platforms[0]?.installPath ||
        ''
    );

  const isDlssSupportedBackend =
    crossoverGraphicsBackend === 'auto' ||
    crossoverGraphicsBackend === 'd3dmetal' ||
    crossoverGraphicsBackend === 'dxmt';

  const preview = launcherService.resolveEffectiveLaunchModePreview(
    game,
    preferredPlatformId,
    {
      launchMethod,
      compatibilityLayer,
      wineBottleName: wineBottleName.trim() || undefined,
      winePrefixPath: winePrefixPath.trim() || undefined,
      customExecutablePath: customExecutablePath.trim() || undefined,
      workingDirectory: workingDirectory.trim() || undefined,
    }
  );

  const isMacNativeBuild =
    preview.detectedBuildType === 'mac_native_app' ||
    preview.detectedBuildType === 'mac_native_bin';

  const buildProfileFromCurrentState = (): StorefrontLaunchProfile => {
    const parsedEnv = parseEnvVars(envText);
    const includeCompatSettings = !isWindowsHost && preview.visibleSections.compatibilityLayer;
    const includeCrossoverOnly =
      includeCompatSettings && preview.visibleSections.crossoverRendering;
    const includeMetalHud =
      !isWindowsHost &&
      (preview.visibleSections.compatibilityLayer || preview.visibleSections.nativeMacMetalHud);

    return {
      launchMethod:
        isWindowsHost && launchMethod === 'compatibility_layer' ? 'direct' : launchMethod,
      customExecutablePath: customExecutablePath.trim() || undefined,
      workingDirectory: workingDirectory.trim() || undefined,
      launchArguments: launchArguments.trim() || undefined,
      compatibilityLayer: includeCompatSettings ? compatibilityLayer : undefined,
      wineBottleName: includeCompatSettings ? wineBottleName.trim() || undefined : undefined,
      winePrefixPath: includeCompatSettings ? winePrefixPath.trim() || undefined : undefined,
      crossoverGraphicsBackend: includeCrossoverOnly ? crossoverGraphicsBackend : undefined,
      crossoverHighResolutionMode: includeCompatSettings ? crossoverHighResolutionMode : undefined,
      crossoverDlss: includeCrossoverOnly
        ? isDlssSupportedBackend
          ? crossoverDlss
          : false
        : undefined,
      wineMsync: includeCompatSettings ? wineMsync : undefined,
      wineEsync: includeCompatSettings ? wineEsync : undefined,
      metalHud: includeMetalHud ? (metalHud ? true : undefined) : undefined,
      dxvkHud: includeCompatSettings ? (dxvkHud ? true : undefined) : undefined,
      environmentVariables: Object.keys(parsedEnv).length > 0 ? parsedEnv : undefined,
      preLaunchCommand: preLaunchCommand.trim() || undefined,
      postExitCommand: postExitCommand.trim() || undefined,
    };
  };

  const handleSelectStorefront = (nextPlatId: StorefrontId) => {
    if (nextPlatId === preferredPlatformId) return;
    const currentProfile = buildProfileFromCurrentState();
    const nextDrafts: Partial<Record<StorefrontId, StorefrontLaunchProfile>> = {
      ...draftsByPlatform,
      [preferredPlatformId]: currentProfile,
    };
    setDraftsByPlatform(nextDrafts);
    setPreferredPlatformId(nextPlatId);
    loadFormFieldsForPlatform(nextPlatId, nextDrafts);
  };

  const visibleLaunchModes = LAUNCH_MODES.filter((m) =>
    preview.availableModes.includes(m.value)
  ).map((m) => {
    if (isWindowsHost && m.value === 'direct') {
      return {
        ...m,
        label: 'Direct Executable (.exe)',
        desc: 'Spawn native Windows game binary directly and track PID session time',
      };
    }
    if (!isWindowsHost && isMacNativeBuild && m.value === 'direct') {
      return {
        ...m,
        label: 'Direct Application (.app / binary)',
        desc: 'Launch native macOS application bundle or Mach-O binary directly with PID tracking',
      };
    }
    return m;
  });

  const currentEnvMap = parseEnvVars(envText);

  const handleToggleQuickEnv = (key: string, val: string) => {
    const next = { ...currentEnvMap };
    if (next[key] === val) {
      delete next[key];
    } else {
      next[key] = val;
    }
    setEnvText(serializeEnvVars(next));
  };

  const handleBrowseExecutable = async () => {
    const selected = await launcherService.selectExecutable(
      customExecutablePath || workingDirectory || undefined
    );
    if (selected) {
      setCustomExecutablePath(selected);
      if (!workingDirectory.trim()) {
        const lastSep = Math.max(selected.lastIndexOf('/'), selected.lastIndexOf('\\'));
        if (lastSep > 0) {
          setWorkingDirectory(selected.slice(0, lastSep));
        }
      }
      if (isWindowsHost) {
        if (launchMethod === 'storefront_uri' || launchMethod === 'compatibility_layer') {
          setLaunchMethod('direct');
        }
      } else if (launchMethod === 'auto') {
        if (selected.toLowerCase().endsWith('.exe')) {
          setLaunchMethod('compatibility_layer');
        } else {
          setLaunchMethod('direct');
        }
      }
    }
  };

  const handleBrowseWorkingDir = async () => {
    const selected = await launcherService.selectFolder(workingDirectory || undefined);
    if (selected) {
      setWorkingDirectory(selected);
    }
  };

  const handleBrowseWinePrefix = async () => {
    const selected = await launcherService.selectFolder(winePrefixPath || undefined);
    if (selected) {
      setWinePrefixPath(selected);
    }
  };

  const handleResetDefaults = async () => {
    await launcherService.resetLaunchConfig(game.id, preferredPlatformId);
    setDraftsByPlatform((prev) => {
      const next = { ...prev };
      delete next[preferredPlatformId];
      return next;
    });
    setLaunchMethod('auto');
    setCustomExecutablePath('');
    setWorkingDirectory('');
    setLaunchArguments('');
    setCompatibilityLayer(detectedLayers[0]?.type || 'crossover');
    setWineBottleName(detectedLayers[0]?.availableBottles?.[0] || '');
    setWinePrefixPath('');
    setCrossoverGraphicsBackend('auto');
    setCrossoverHighResolutionMode(undefined);
    setCrossoverDlss(false);
    setWineMsync(true);
    setWineEsync(false);
    setMetalHud(false);
    setDxvkHud(false);
    setEnvText('');
    setPreLaunchCommand('');
    setPostExitCommand('');
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const activeProfile = buildProfileFromCurrentState();
      const allPlatformConfigs: Partial<Record<StorefrontId, StorefrontLaunchProfile>> = {
        ...draftsByPlatform,
        [preferredPlatformId]: activeProfile,
      };
      const config: GameLaunchConfig = {
        gameId: game.id,
        preferredPlatformId,
        launchMethod: activeProfile.launchMethod || 'auto',
        ...activeProfile,
        platformConfigs: allPlatformConfigs,
      };

      await launcherService.saveLaunchConfig(config, preferredPlatformId);

      if (typeof window !== 'undefined') {
        for (const [platId, prof] of Object.entries(allPlatformConfigs)) {
          if (prof?.customExecutablePath) {
            const platGameId =
              game.platforms.find((p) => p.platformId === platId)?.platformGameId || game.id;
            window.dispatchEvent(
              new CustomEvent('antigravity:game-installed', {
                detail: {
                  gameId: game.id,
                  platformId: platId as StorefrontId,
                  platformGameId: platGameId,
                  installPath: prof.workingDirectory || prof.customExecutablePath,
                  executablePath: prof.customExecutablePath,
                  installed: true,
                },
              })
            );
          }
        }
      }

      onSaved?.(config);
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  const buildBadgeTone: 'emerald' | 'sky' | 'amber' | 'slate' =
    preview.detectedBuildType === 'mac_native_app' ||
    preview.detectedBuildType === 'mac_native_bin' ||
    preview.detectedBuildType === 'windows_native'
      ? 'emerald'
      : preview.detectedBuildType === 'windows_exe_on_mac'
        ? 'amber'
        : 'slate';

  const activeModeNote =
    isWindowsHost && launchMethod === 'compatibility_layer'
      ? undefined
      : preview.modeNotes[launchMethod];
  const activeModeWarning = activeModeNote?.warning;
  const discoveredTargetPath = preview.executablePath || preview.installPath;

  const executablePathLabel = isWindowsHost
    ? 'Executable Path (.exe)'
    : isMacNativeBuild
      ? 'Application Bundle or Binary Path (.app / Mach-O)'
      : preview.detectedBuildType === 'windows_exe_on_mac'
        ? 'Windows Executable Path (.exe)'
        : 'Executable Path (.app, binary, or Windows .exe)';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-150 select-none"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl rounded-xl bg-[#131b26] border border-[#2a475e] shadow-[0_20px_60px_rgba(0,0,0,0.9)] overflow-hidden text-steam-text flex flex-col max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 bg-[#0e151f] border-b border-[#223447] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 rounded-lg bg-sky-500/15 border border-sky-400/30 text-sky-400 shrink-0">
              <Settings className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-white truncate">
                {isWindowsHost
                  ? 'Launch Settings'
                  : isMacNativeBuild && !preview.visibleSections.compatibilityLayer
                    ? 'Launch Settings (macOS Native)'
                    : 'Launch & Compatibility Settings'}
              </h2>
              <p className="text-xs text-steam-subtext truncate">
                {isWindowsHost
                  ? 'Configure execution mode, custom executable & launch parameters for '
                  : isMacNativeBuild && !preview.visibleSections.compatibilityLayer
                    ? 'Configure native macOS execution mode, Metal HUD & launch parameters for '
                    : 'Configure execution mode, Wine/CrossOver bottles & launch parameters for '}
                <span className="font-semibold text-white">{game.title}</span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-steam-subtext hover:text-white transition-colors cursor-pointer"
            aria-label="Close launch settings modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-5 space-y-5 overflow-y-auto flex-1">
          {/* Detected Installation & Active Pipeline Banner */}
          <div className="rounded-lg bg-[#0e151f] border border-[#26384d] p-3.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext">
                  Detected Installation
                </span>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded border font-bold ${getBadgeToneClasses(
                    buildBadgeTone
                  )}`}
                >
                  {preview.detectedBuildLabel}
                </span>
              </div>
              <span className="text-[11px] text-steam-subtext">
                {preview.detectedBuildDetail}
              </span>
            </div>

            {discoveredTargetPath && (
              <div className="text-[11px] font-mono text-sky-300/90 bg-[#141d2b] border border-[#223447] rounded px-2.5 py-1 truncate">
                {discoveredTargetPath}
              </div>
            )}

            <div className="flex items-start gap-2 text-xs text-steam-text pt-0.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-white">Auto-Detect Pipeline: </span>
                <span className="text-steam-subtext">{preview.autoResolvedSummary}</span>
              </div>
            </div>
          </div>

          {/* Storefront Installation Profile Selector */}
          {game.platforms.length >= 1 && (
            <div className="space-y-1.5">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext">
                {game.platforms.length > 1
                  ? 'Storefront Installation Profile — Settings apply per storefront'
                  : 'Storefront Installation Profile'}
              </label>
              <div className="flex flex-wrap gap-2">
                {game.platforms.map((plat) => {
                  const isSelected = plat.platformId === preferredPlatformId;
                  const isPlatInstalled =
                    launcherService.isGameInstalled(game, plat.platformId) ||
                    Boolean(plat.installed);
                  const hasCustomProfile = Boolean(
                    draftsByPlatform[plat.platformId] ||
                      launcherService.getLaunchConfig(game.id, plat.platformId)
                  );
                  return (
                    <button
                      key={plat.platformId}
                      type="button"
                      data-storefront-pill={plat.platformId}
                      aria-pressed={isSelected}
                      onClick={() => handleSelectStorefront(plat.platformId)}
                      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all cursor-pointer ${
                        isSelected
                          ? 'bg-sky-500/20 border-sky-400 text-white shadow-sm'
                          : 'bg-[#17212e] border-[#26384d] text-steam-subtext hover:text-white'
                      }`}
                    >
                      <StorefrontIcon
                        storefrontId={plat.platformId}
                        className={`w-3.5 h-3.5 ${isSelected ? 'text-sky-400' : 'text-steam-subtext'}`}
                      />
                      <span>{getStorefrontDisplayName(plat.platformId)}</span>
                      {isPlatInstalled ? (
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                          Installed
                        </span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-500/15 text-steam-subtext border border-slate-500/30">
                          Not Installed
                        </span>
                      )}
                      {hasCustomProfile && (
                        <span
                          className="text-[9px] px-1.5 py-0.2 rounded bg-sky-500/20 text-sky-300 border border-sky-500/40"
                          title="Custom launch profile configured for this storefront"
                        >
                          Configured
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Launch Mode */}
          <div className="space-y-2">
            <label className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext">
              Launch Mode
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {visibleLaunchModes.map((mode) => {
                const isSelected = launchMethod === mode.value;
                const modeNote = preview.modeNotes[mode.value];
                const dynamicDesc =
                  isWindowsHost && modeNote?.dynamicDesc && /CrossOver/i.test(modeNote.dynamicDesc)
                    ? mode.desc
                    : modeNote?.dynamicDesc || mode.desc;
                return (
                  <button
                    key={mode.value}
                    type="button"
                    onClick={() => setLaunchMethod(mode.value)}
                    className={`p-3 rounded-lg border text-left transition-all cursor-pointer flex flex-col justify-between ${
                      isSelected
                        ? 'bg-sky-500/15 border-sky-400 text-white shadow-[0_0_12px_rgba(56,189,248,0.15)]'
                        : 'bg-[#17212e] border-[#26384d] text-steam-subtext hover:text-white hover:bg-[#1c2838]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-white">{mode.label}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {modeNote?.badge && (
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${getBadgeToneClasses(
                              modeNote.badgeTone
                            )}`}
                          >
                            {modeNote.badge}
                          </span>
                        )}
                        {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-sky-400 shrink-0" />}
                      </div>
                    </div>
                    <p className="text-[10px] text-steam-subtext mt-1.5 leading-relaxed">
                      {dynamicDesc}
                    </p>
                  </button>
                );
              })}
            </div>

            {activeModeWarning && (
              <div className="flex items-start gap-2.5 rounded-lg bg-amber-950/50 border border-amber-500/40 px-3 py-2.5 text-xs text-amber-200">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <span className="leading-relaxed">{activeModeWarning}</span>
              </div>
            )}
          </div>

          {/* Custom Executable Path & Working Directory */}
          <div className="grid grid-cols-1 gap-3.5 bg-[#0e151f] border border-[#223447] rounded-lg p-3.5">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1.5">
                  <FileCode className="w-3.5 h-3.5 text-sky-400" />
                  <span>{executablePathLabel}</span>
                </label>
                <span className="text-[10px] text-steam-subtext">
                  Also links existing local installations
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={customExecutablePath}
                  onChange={(e) => setCustomExecutablePath(e.target.value)}
                  placeholder="Auto-detected from storefront manifest or select manually..."
                  className="flex-1 rounded-lg bg-[#141d2b] border border-[#2a475e] px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                />
                <button
                  type="button"
                  onClick={handleBrowseExecutable}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-xs font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer shrink-0"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>Browse Executable...</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Working Directory */}
              <div className="space-y-1">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext">
                  Working Directory
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={workingDirectory}
                    onChange={(e) => setWorkingDirectory(e.target.value)}
                    placeholder="Default game folder"
                    className="flex-1 min-w-0 rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                  />
                  <button
                    type="button"
                    onClick={handleBrowseWorkingDir}
                    className="px-2.5 py-1.5 rounded-lg bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-xs font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer shrink-0"
                  >
                    Browse...
                  </button>
                </div>
              </div>

              {/* Command-Line Arguments */}
              <div className="space-y-1">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext">
                  Launch Arguments
                </label>
                <input
                  type="text"
                  value={launchArguments}
                  onChange={(e) => setLaunchArguments(e.target.value)}
                  placeholder="e.g. -windowed -skipintro -dx11"
                  className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                />
              </div>
            </div>
          </div>

          {/* Native macOS Performance & Overlay Card (shown for native macOS .app / Mach-O builds) */}
          {!isWindowsHost && preview.visibleSections.nativeMacMetalHud && (
            <div
              data-section="native-mac-settings"
              className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-2.5"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-bold text-white uppercase tracking-wider">
                    macOS Native Performance & Overlay
                  </span>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-semibold">
                  Apple Silicon / Metal Native
                </span>
              </div>

              <div className="flex items-center justify-between gap-3 rounded-lg bg-[#141d2b] border border-[#26384d] px-3 py-2">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-white">
                    Apple Metal Performance HUD (MTL_HUD_ENABLED=1)
                  </div>
                  <div className="text-[10px] text-steam-subtext">
                    Displays real-time Apple Metal FPS, frame timing, and GPU memory overlay
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setMetalHud((prev) => !prev)}
                  className={`px-3 py-1 rounded-md text-xs font-bold border transition-all shrink-0 cursor-pointer ${
                    metalHud
                      ? 'bg-sky-500/20 border-sky-400 text-sky-300'
                      : 'bg-[#0e151f] border-[#26384d] text-steam-subtext hover:text-white'
                  }`}
                >
                  {metalHud ? 'ON' : 'OFF'}
                </button>
              </div>
            </div>
          )}

          {/* macOS Compatibility Layer & CrossOver 26 Configuration (shown only when relevant) */}
          {!isWindowsHost && preview.visibleSections.compatibilityLayer && (
            <div
              data-section="compatibility-layer-settings"
              className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-amber-400" />
                  <span className="text-xs font-bold text-white uppercase tracking-wider">
                    macOS Compatibility Layer (CrossOver / Whisky / Wine / GPTK)
                  </span>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 font-semibold">
                  {detectedLayers.length} Detected on System
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* Layer Type */}
                <div className="space-y-1">
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext">
                    Compatibility Runner
                  </label>
                  <select
                    aria-label="Compatibility Runner"
                    value={compatibilityLayer}
                    onChange={(e) =>
                      setCompatibilityLayer(e.target.value as CompatibilityLayerType)
                    }
                    className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-400"
                  >
                    {COMPAT_LAYER_OPTIONS.map((opt) => {
                      const isInstalled = detectedLayers.some((l) => l.type === opt.value);
                      return (
                        <option key={opt.value} value={opt.value}>
                          {opt.label} {isInstalled ? '✓ (Installed)' : ''}
                        </option>
                      );
                    })}
                  </select>
                </div>

                {/* Bottle Selector or Name */}
                <div className="space-y-1">
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext">
                    Target Bottle Name
                  </label>
                  {availableBottles.length > 0 ? (
                    <select
                      aria-label="Target Bottle Name"
                      value={wineBottleName}
                      onChange={(e) => setWineBottleName(e.target.value)}
                      className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-400"
                    >
                      <option value="">Default Bottle ({availableBottles[0]})</option>
                      {availableBottles.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      aria-label="Target Bottle Name"
                      value={wineBottleName}
                      onChange={(e) => setWineBottleName(e.target.value)}
                      placeholder="e.g. Steam, GOG, Default"
                      className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                    />
                  )}
                </div>
              </div>

              {/* Custom Wine Prefix Path */}
              <div className="space-y-1">
                <label className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext">
                  Custom WINEPREFIX Path (Optional Override)
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={winePrefixPath}
                    onChange={(e) => setWinePrefixPath(e.target.value)}
                    placeholder="~/Library/Application Support/CrossOver/Bottles/..."
                    className="flex-1 rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                  />
                  <button
                    type="button"
                    onClick={handleBrowseWinePrefix}
                    className="px-2.5 py-1.5 rounded-lg bg-[#1b2838] hover:bg-[#25374d] border border-[#2a475e] text-xs font-semibold text-sky-300 hover:text-white transition-colors cursor-pointer shrink-0"
                  >
                    Browse...
                  </button>
                </div>
              </div>

              {/* Rendering & Display Settings Sub-Panel (CrossOver 26 vs Wine/GPTK) */}
              <div className="rounded-lg bg-[#141d2b] border border-[#26384d] p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-sky-400" />
                    <span className="text-[11px] font-bold uppercase tracking-wider text-white">
                      {preview.visibleSections.crossoverRendering
                        ? 'CrossOver 26 Rendering & Display Settings'
                        : 'Wine / GPTK Display & Synchronization Settings'}
                    </span>
                  </div>
                  <span className="text-[10px] text-steam-subtext">
                    {preview.visibleSections.crossoverRendering
                      ? 'Per-game bottle & graphics overrides'
                      : 'Per-game prefix display & sync overrides'}
                  </span>
                </div>

                <div
                  className={`grid grid-cols-1 ${
                    preview.visibleSections.crossoverRendering ? 'sm:grid-cols-2' : ''
                  } gap-3`}
                >
                  {/* Graphics Backend (CrossOver only) */}
                  {preview.visibleSections.crossoverRendering && (
                    <div className="space-y-1">
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-steam-subtext">
                        Graphics Backend
                      </label>
                      <select
                        aria-label="Graphics Backend"
                        value={crossoverGraphicsBackend}
                        onChange={(e) =>
                          setCrossoverGraphicsBackend(e.target.value as CrossOverGraphicsBackend)
                        }
                        className="w-full rounded-lg bg-[#0e151f] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-400"
                      >
                        {CROSSOVER_BACKEND_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* High Resolution Mode (Retina 192 DPI) */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1">
                      <Monitor className="w-3 h-3 text-sky-400" />
                      <span>High Resolution Mode (Retina 192 DPI)</span>
                    </label>
                    <select
                      aria-label="High Resolution Mode"
                      value={
                        crossoverHighResolutionMode === undefined
                          ? ''
                          : crossoverHighResolutionMode
                            ? 'true'
                            : 'false'
                      }
                      onChange={(e) => {
                        const val = e.target.value;
                        setCrossoverHighResolutionMode(
                          val === '' ? undefined : val === 'true'
                        );
                      }}
                      className="w-full rounded-lg bg-[#0e151f] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-400"
                    >
                      <option value="">Bottle Default</option>
                      <option value="true">Enabled (192 DPI Retina — Crisp UI/Text)</option>
                      <option value="false">Disabled (96 DPI Standard — Higher FPS)</option>
                    </select>
                  </div>
                </div>

                {/* DLSS (MetalFX Upscaling) — CrossOver only */}
                {preview.visibleSections.crossoverRendering && (
                  <div className="flex items-center justify-between gap-3 rounded-lg bg-[#0e151f] border border-[#223447] px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-white">
                        DLSS (MetalFX Upscaling)
                      </div>
                      <div className="text-[10px] text-steam-subtext">
                        {isDlssSupportedBackend
                          ? 'Exposes NVIDIA DLSS to the game (powered by Apple MetalFX) for D3DMetal & DXMT — select Quality / Balanced / Performance inside the game’s graphics settings.'
                          : 'Not available with DXVK or WineD3D'}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={!isDlssSupportedBackend}
                      onClick={() => setCrossoverDlss((prev) => !prev)}
                      className={`px-3 py-1 rounded-md text-xs font-bold border transition-all shrink-0 ${
                        !isDlssSupportedBackend
                          ? 'bg-[#17212e] border-[#26384d] text-steam-subtext/40 cursor-not-allowed'
                          : crossoverDlss
                            ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300 cursor-pointer'
                            : 'bg-[#17212e] border-[#26384d] text-steam-subtext hover:text-white cursor-pointer'
                      }`}
                    >
                      {!isDlssSupportedBackend
                        ? 'Unavailable'
                        : crossoverDlss
                          ? 'Enabled'
                          : 'Disabled'}
                    </button>
                  </div>
                )}

                {/* Synchronization & HUD Overlays */}
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1">
                    <Activity className="w-3 h-3 text-sky-400" />
                    <span>Synchronization & HUD Overlays</span>
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setWineMsync((prev) => {
                          const next = !prev;
                          if (next) setWineEsync(false);
                          return next;
                        });
                      }}
                      className={`px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-all cursor-pointer flex items-center justify-between ${
                        wineMsync
                          ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                          : 'bg-[#0e151f] border-[#26384d] text-steam-subtext hover:text-white'
                      }`}
                    >
                      <span>MSync</span>
                      <span className="text-[10px] font-bold">{wineMsync ? 'ON' : 'OFF'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setWineEsync((prev) => {
                          const next = !prev;
                          if (next) setWineMsync(false);
                          return next;
                        });
                      }}
                      className={`px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-all cursor-pointer flex items-center justify-between ${
                        wineEsync
                          ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                          : 'bg-[#0e151f] border-[#26384d] text-steam-subtext hover:text-white'
                      }`}
                    >
                      <span>ESync</span>
                      <span className="text-[10px] font-bold">{wineEsync ? 'ON' : 'OFF'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setMetalHud((prev) => !prev)}
                      className={`px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-all cursor-pointer flex items-center justify-between ${
                        metalHud
                          ? 'bg-sky-500/20 border-sky-400 text-sky-300'
                          : 'bg-[#0e151f] border-[#26384d] text-steam-subtext hover:text-white'
                      }`}
                    >
                      <span>Metal HUD</span>
                      <span className="text-[10px] font-bold">{metalHud ? 'ON' : 'OFF'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setDxvkHud((prev) => !prev)}
                      className={`px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-all cursor-pointer flex items-center justify-between ${
                        dxvkHud
                          ? 'bg-sky-500/20 border-sky-400 text-sky-300'
                          : 'bg-[#0e151f] border-[#26384d] text-steam-subtext hover:text-white'
                      }`}
                    >
                      <span>DXVK HUD</span>
                      <span className="text-[10px] font-bold">{dxvkHud ? 'ON' : 'OFF'}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Environment Variables & Custom Overrides */}
          <div className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-sky-400" />
                <span className="text-xs font-bold text-white uppercase tracking-wider">
                  Environment Variables
                </span>
              </div>
              <span className="text-[10px] text-steam-subtext">
                Custom KEY=VALUE process overrides
              </span>
            </div>

            {isWindowsHost && (
              <div className="flex flex-wrap gap-1.5">
                {WINDOWS_QUICK_ENV_TOGGLES.map((item) => {
                  const isActive = currentEnvMap[item.key] === item.value;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => handleToggleQuickEnv(item.key, item.value)}
                      className={`px-2.5 py-1 rounded text-[11px] font-semibold border transition-all cursor-pointer ${
                        isActive
                          ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                          : 'bg-[#141d2b] border-[#26384d] text-steam-subtext hover:text-white'
                      }`}
                      title={item.desc}
                    >
                      {item.label} ({item.key}={item.value})
                    </button>
                  );
                })}
              </div>
            )}

            <textarea
              rows={2}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={
                isWindowsHost
                  ? 'KEY=VALUE (one per line, e.g. DXVK_HUD=1)'
                  : 'KEY=VALUE (one per line, e.g. MANGOHUD=1)'
              }
              className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
            />
          </div>

          {/* Pre-Launch & Post-Exit Shell Commands */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-[#0e151f] border border-[#223447] rounded-lg p-3.5">
            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1">
                <Terminal className="w-3 h-3 text-sky-400" />
                <span>Pre-Launch Command</span>
              </label>
              <input
                type="text"
                value={preLaunchCommand}
                onChange={(e) => setPreLaunchCommand(e.target.value)}
                placeholder="Optional shell script before launch"
                className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1">
                <Terminal className="w-3 h-3 text-sky-400" />
                <span>Post-Exit Command</span>
              </label>
              <input
                type="text"
                value={postExitCommand}
                onChange={(e) => setPostExitCommand(e.target.value)}
                placeholder="Optional shell script after game exits"
                className="w-full rounded-lg bg-[#141d2b] border border-[#2a475e] px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#0e151f] border-t border-[#223447] flex items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            onClick={handleResetDefaults}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#17212e] hover:bg-[#223144] border border-[#2a475e] text-xs font-semibold text-steam-subtext hover:text-white transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset to Auto-Detect</span>
          </button>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-[#1b2838] hover:bg-[#24354a] text-xs font-semibold text-steam-text hover:text-white transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg font-bold text-xs text-white uppercase tracking-wider transition-all shadow-lg hover:brightness-110 disabled:opacity-50 cursor-pointer"
              style={{
                background: 'linear-gradient(to right, #10b981 0%, #059669 100%)',
                boxShadow: '0 0 16px rgba(16, 185, 129, 0.35)',
              }}
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isSaving ? 'Saving...' : 'Save Configuration'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
