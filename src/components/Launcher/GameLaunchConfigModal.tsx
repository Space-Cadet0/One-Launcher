import React, { useState, useEffect } from 'react';
import { CanonicalGame } from '../../contracts/game';
import { StorefrontId } from '../../contracts/platform';
import {
  CompatibilityLayerInfo,
  CompatibilityLayerType,
  GameLaunchConfig,
  LaunchMethod,
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
} from 'lucide-react';

export interface GameLaunchConfigModalProps {
  isOpen: boolean;
  game: CanonicalGame;
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
    value: 'storefront_uri',
    label: 'Storefront Client Protocol',
    desc: 'Launches via native Steam, GOG Galaxy, or Epic Games client protocol URI.',
  },
  {
    value: 'compatibility_layer',
    label: 'macOS Compatibility Layer (CrossOver / Wine / GPTK)',
    desc: 'Runs Windows .exe builds through CrossOver, Whisky, Apple GPTK, or Wine.',
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

const QUICK_ENV_TOGGLES: { key: string; value: string; label: string; desc: string }[] = [
  { key: 'MTL_HUD_ENABLED', value: '1', label: 'Metal Performance HUD', desc: 'MTL_HUD_ENABLED=1' },
  { key: 'DXVK_HUD', value: '1', label: 'DXVK Overlay HUD', desc: 'DXVK_HUD=1' },
  { key: 'WINEDEBUG', value: '-all', label: 'Suppress Wine Debug Logs', desc: 'WINEDEBUG=-all' },
  { key: 'WINEESYNC', value: '1', label: 'Enable Wine Esync', desc: 'WINEESYNC=1' },
  { key: 'WINEMSYNC', value: '1', label: 'Enable Wine Msync', desc: 'WINEMSYNC=1' },
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

export const GameLaunchConfigModal: React.FC<GameLaunchConfigModalProps> = ({
  isOpen,
  game,
  onClose,
  onSaved,
}) => {
  const [preferredPlatformId, setPreferredPlatformId] = useState<StorefrontId>('steam');
  const [launchMethod, setLaunchMethod] = useState<LaunchMethod>('auto');
  const [customExecutablePath, setCustomExecutablePath] = useState<string>('');
  const [workingDirectory, setWorkingDirectory] = useState<string>('');
  const [launchArguments, setLaunchArguments] = useState<string>('');
  const [compatibilityLayer, setCompatibilityLayer] = useState<CompatibilityLayerType>('crossover');
  const [wineBottleName, setWineBottleName] = useState<string>('');
  const [winePrefixPath, setWinePrefixPath] = useState<string>('');
  const [envText, setEnvText] = useState<string>('');
  const [preLaunchCommand, setPreLaunchCommand] = useState<string>('');
  const [postExitCommand, setPostExitCommand] = useState<string>('');
  const [detectedLayers, setDetectedLayers] = useState<CompatibilityLayerInfo[]>([]);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  useEffect(() => {
    if (!isOpen) return;

    const existing = launcherService.getLaunchConfig(game.id);
    const effPlat = launcherService.getEffectivePlatformForGame(game);
    const installedRec = launcherService.getInstalledRecordForGame(game);

    setPreferredPlatformId(
      existing?.preferredPlatformId ||
        effPlat?.platformId ||
        game.platforms[0]?.platformId ||
        'steam'
    );
    setLaunchMethod(existing?.launchMethod || 'auto');
    setCustomExecutablePath(
      existing?.customExecutablePath || installedRec?.executablePath || ''
    );
    setWorkingDirectory(existing?.workingDirectory || installedRec?.installPath || '');
    setLaunchArguments(existing?.launchArguments || '');
    setCompatibilityLayer(existing?.compatibilityLayer || 'crossover');
    setWineBottleName(existing?.wineBottleName || '');
    setWinePrefixPath(existing?.winePrefixPath || '');
    setEnvText(serializeEnvVars(existing?.environmentVariables));
    setPreLaunchCommand(existing?.preLaunchCommand || '');
    setPostExitCommand(existing?.postExitCommand || '');

    const initialLayers = launcherService.getCompatibilityLayers();
    setDetectedLayers(initialLayers);

    launcherService.detectCompatibilityLayers().then((layers) => {
      setDetectedLayers(layers);
      if (!existing?.compatibilityLayer && layers.length > 0) {
        setCompatibilityLayer(layers[0].type);
        if (!existing?.wineBottleName && layers[0].availableBottles?.length) {
          setWineBottleName(layers[0].availableBottles[0]);
        }
      }
    });
  }, [isOpen, game]);

  if (!isOpen) return null;

  const activeLayerInfo = detectedLayers.find((l) => l.type === compatibilityLayer);
  const availableBottles = activeLayerInfo?.availableBottles || [];

  const isWindowsHost =
    (typeof (launcherService as any).isWindowsHost === 'function' &&
      (launcherService as any).isWindowsHost()) ||
    (typeof window !== 'undefined' && (window as any)?.electronAPI?.platform === 'win32') ||
    /^[A-Za-z]:\\/.test(workingDirectory || customExecutablePath || '');

  const visibleLaunchModes = isWindowsHost
    ? [
        {
          value: 'auto' as LaunchMethod,
          label: 'Auto-Detect (Recommended)',
          desc: 'Launches the local game executable (.exe) directly if found, otherwise Storefront URI.',
        },
        {
          value: 'direct' as LaunchMethod,
          label: 'Direct Executable (.exe)',
          desc: 'Spawns the game binary directly and tracks PID & exact playtime.',
        },
        {
          value: 'storefront_uri' as LaunchMethod,
          label: 'Storefront Client Protocol',
          desc: 'Delegates launch to Steam (steam://), GOG Galaxy (goggalaxy://), or Epic Launcher.',
        },
      ]
    : LAUNCH_MODES;

  const visibleEnvToggles = isWindowsHost
    ? QUICK_ENV_TOGGLES.filter(
        (item) =>
          !['MTL_HUD_ENABLED', 'WINEDEBUG', 'WINEESYNC', 'WINEMSYNC'].includes(item.key)
      )
    : QUICK_ENV_TOGGLES;

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

  const handleResetDefaults = () => {
    setPreferredPlatformId(game.platforms[0]?.platformId || 'steam');
    setLaunchMethod('auto');
    setCustomExecutablePath('');
    setWorkingDirectory('');
    setLaunchArguments('');
    setCompatibilityLayer(detectedLayers[0]?.type || 'crossover');
    setWineBottleName('');
    setWinePrefixPath('');
    setEnvText('');
    setPreLaunchCommand('');
    setPostExitCommand('');
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const envVars = parseEnvVars(envText);
      const config: GameLaunchConfig = {
        gameId: game.id,
        preferredPlatformId,
        launchMethod:
          isWindowsHost && launchMethod === 'compatibility_layer' ? 'direct' : launchMethod,
        customExecutablePath: customExecutablePath.trim() || undefined,
        workingDirectory: workingDirectory.trim() || undefined,
        launchArguments: launchArguments.trim() || undefined,
        environmentVariables: Object.keys(envVars).length > 0 ? envVars : undefined,
        compatibilityLayer: isWindowsHost
          ? undefined
          : launchMethod === 'compatibility_layer' ||
            customExecutablePath.toLowerCase().endsWith('.exe')
          ? compatibilityLayer
          : undefined,
        wineBottleName: isWindowsHost ? undefined : wineBottleName.trim() || undefined,
        winePrefixPath: isWindowsHost ? undefined : winePrefixPath.trim() || undefined,
        preLaunchCommand: preLaunchCommand.trim() || undefined,
        postExitCommand: postExitCommand.trim() || undefined,
      };

      await launcherService.saveLaunchConfig(config);

      if (config.customExecutablePath && typeof window !== 'undefined') {
        const platGameId =
          game.platforms.find((p) => p.platformId === preferredPlatformId)?.platformGameId ||
          game.id;
        window.dispatchEvent(
          new CustomEvent('antigravity:game-installed', {
            detail: {
              gameId: game.id,
              platformId: preferredPlatformId,
              platformGameId: platGameId,
              installPath: config.workingDirectory || config.customExecutablePath,
              executablePath: config.customExecutablePath,
              installed: true,
            },
          })
        );
      }

      onSaved?.(config);
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

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
                {isWindowsHost ? 'Launch Settings' : 'Launch & Compatibility Settings'}
              </h2>
              <p className="text-xs text-steam-subtext truncate">
                {isWindowsHost
                  ? 'Configure execution mode, custom executable & launch parameters for '
                  : 'Configure execution mode, CrossOver/Wine bottles & launch parameters for '}
                <strong className="text-white">{game.title}</strong>
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
          {/* Preferred Storefront Selector */}
          {game.platforms.length > 0 && (
            <div className="space-y-1.5">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext">
                Preferred Storefront
              </label>
              <div className="flex flex-wrap gap-2">
                {game.platforms.map((plat) => {
                  const isSelected = plat.platformId === preferredPlatformId;
                  return (
                    <button
                      key={plat.platformId}
                      type="button"
                      onClick={() => setPreferredPlatformId(plat.platformId)}
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
                      {plat.installed && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                          Installed
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Launch Mode */}
          <div className="space-y-1.5">
            <label className="block text-[11px] font-bold uppercase tracking-wider text-steam-subtext">
              Launch Mode
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {visibleLaunchModes.map((mode) => {
                const isSelected = launchMethod === mode.value;
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
                      {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-sky-400 shrink-0" />}
                    </div>
                    <p className="text-[10px] text-steam-subtext mt-1 leading-relaxed">
                      {mode.desc}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Custom Executable Path & Working Directory */}
          <div className="grid grid-cols-1 gap-3.5 bg-[#0e151f] border border-[#223447] rounded-lg p-3.5">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-bold uppercase tracking-wider text-steam-subtext flex items-center gap-1.5">
                  <FileCode className="w-3.5 h-3.5 text-sky-400" />
                  <span>
                    {isWindowsHost
                      ? 'Executable Path (.exe)'
                      : 'Executable Path (.app, binary, or Windows .exe)'}
                  </span>
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

          {/* macOS Compatibility Layer & Bottle Configuration (hidden on Windows host) */}
          {!isWindowsHost && (
            <div className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-3">
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
            </div>
          )}

          {/* Environment Variables & Quick Toggles */}
          <div className="rounded-lg bg-[#0e151f] border border-[#223447] p-3.5 space-y-2.5">
            <div className="flex items-center gap-2">
              <Sliders className="w-4 h-4 text-sky-400" />
              <span className="text-xs font-bold text-white uppercase tracking-wider">
                Environment Variables
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {visibleEnvToggles.map((item) => {
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

            <textarea
              rows={2}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={
                isWindowsHost
                  ? 'KEY=VALUE (one per line, e.g. DXVK_HUD=1)'
                  : 'KEY=VALUE (one per line, e.g. MTL_HUD_ENABLED=1)'
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
