import {
  CompatibilityLayerInfo,
  CompatibilityLayerType,
  CompatibilityLayerUpdateInfo,
  CrossOverGraphicsBackend,
  InGameLauncherBehavior,
  LauncherPerformanceSettings,
  LaunchMethod,
  StorefrontClientLifecyclePolicy,
} from '../../../contracts/launcher';
import { StorefrontId } from '../../../contracts/platform';
import { COMPATIBILITY_RUNNER_DESCRIPTORS } from '../../../services/launcher/launcherService';

export const LAUNCH_MODES: { value: LaunchMethod; label: string; desc: string }[] = [
  {
    value: 'auto',
    label: 'Auto-Detect (Recommended)',
    desc: 'Uses direct executable or compatibility layer if found, otherwise Storefront URI.',
  },
  {
    value: 'direct',
    label: 'Direct Executable (.exe / Binary)',
    desc: 'Spawns the local game binary directly and tracks live process exit.',
  },
  {
    value: 'compatibility_layer',
    label: 'Custom Compatibility Runner & Bottle',
    desc: 'Pin a specific macOS translation runner (CrossOver, Apple GPTK, or Open-Source Wine), target bottle, and per-game graphics overrides.',
  },
  {
    value: 'storefront_uri',
    label: 'Storefront Client Protocol',
    desc: 'Launches via native Steam, GOG Galaxy, Epic Games, or Xbox / Microsoft Store protocol URI.',
  },
];

export const COMPAT_LAYER_OPTIONS: {
  value: Exclude<CompatibilityLayerType, 'native'>;
  label: string;
}[] = COMPATIBILITY_RUNNER_DESCRIPTORS.map((d) => ({
  value: d.type,
  label: d.label,
}));

export function formatRunnerOptionLabel(
  opt: { value: Exclude<CompatibilityLayerType, 'native'>; label: string },
  layerInfo?: CompatibilityLayerInfo,
  upd?: CompatibilityLayerUpdateInfo
): string {
  if (!layerInfo) {
    return `${opt.label} (Not Installed)`;
  }
  const ver = layerInfo.version || upd?.installedVersion;
  if (!ver) {
    return `${opt.label} ✓ (Installed)`;
  }
  let baseLabel: string;
  switch (opt.value) {
    case 'crossover':
      baseLabel = `CrossOver — v${ver} Installed (Recommended)`;
      break;
    case 'crossover_preview':
      baseLabel = `CrossOver Preview — v${ver} Installed`;
      break;
    case 'gptk':
      baseLabel = `Apple Game Porting Toolkit (GPTK) — v${ver} Installed`;
      break;
    case 'wine':
      baseLabel = `Open-Source Wine (Wine-CrossOver / Wine Stable) — v${ver} Installed`;
      break;
    default:
      baseLabel = `${opt.label} — v${ver} Installed`;
      break;
  }
  if (upd?.updateAvailable && upd.latestVersion) {
    return `${baseLabel} • Update Available (v${upd.latestVersion})`;
  }
  return baseLabel;
}

export const CROSSOVER_BACKEND_OPTIONS: { value: CrossOverGraphicsBackend; label: string }[] = [
  { value: 'auto', label: 'Auto (Recommended — Best backend per game)' },
  { value: 'd3dmetal', label: 'D3DMetal (Apple GPTK — DirectX 11 & 12)' },
  { value: 'dxmt', label: 'DXMT (Metal DirectX 11 layer)' },
  { value: 'dxvk', label: 'DXVK (Vulkan DirectX 10 & 11 layer)' },
  { value: 'wined3d', label: 'WineD3D (OpenGL — DirectX 9 & Legacy)' },
];

export const WINDOWS_QUICK_ENV_TOGGLES: {
  key: string;
  value: string;
  label: string;
  desc: string;
}[] = [{ key: 'DXVK_HUD', value: '1', label: 'DXVK Overlay HUD', desc: 'DXVK_HUD=1' }];

export function stripManagedEnvVars(
  env?: Record<string, string>
): Record<string, string> | undefined {
  if (!env) return undefined;
  const copy = { ...env };
  delete copy.CX_GRAPHICS_BACKEND_VERSION;
  return Object.keys(copy).length > 0 ? copy : undefined;
}

export function serializeEnvVars(env?: Record<string, string>): string {
  if (!env) return '';
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export function parseEnvVars(text: string): Record<string, string> {
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

export function getBadgeToneClasses(tone?: 'emerald' | 'sky' | 'amber' | 'slate'): string {
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

export function formatGlobalStorefrontLifecycleDefaultLabel(
  policy: StorefrontClientLifecyclePolicy,
  preferredPlatformId?: StorefrontId
): string {
  switch (policy) {
    case 'fast_direct_bypass':
      return preferredPlatformId === 'gog'
        ? 'Use Global Default — Fast Direct Launch (Skip GOG Galaxy, Keep gogdl Cloud Sync)'
        : 'Use Global Default — Fast Direct Launch (Bypass Storefront Client)';
    case 'minimal_keep_running':
      return preferredPlatformId === 'gog'
        ? 'Use Global Default — Silent GOG Galaxy SDK + Cloud Sync, Keep Warm'
        : 'Use Global Default — Minimal Flags & Keep Client Running';
    case 'default_client':
      return preferredPlatformId === 'gog'
        ? 'Use Global Default — Standard GOG Galaxy Client Behavior'
        : 'Use Global Default — Standard Storefront Client Behavior';
    case 'minimal_and_close_if_started':
    default:
      return preferredPlatformId === 'gog'
        ? 'Use Global Default — Silent GOG Galaxy SDK + Cloud Sync & Auto-Close'
        : 'Use Global Default — Silent Client + Cloud Sync & Auto-Close';
  }
}

export function formatGlobalInGameBehaviorDefaultLabel(behavior: InGameLauncherBehavior): string {
  switch (behavior) {
    case 'zero_renderer_daemon':
      return 'Use Global Default — Zero-Renderer Background Mode';
    case 'minimize_taskbar':
      return 'Use Global Default — Minimize Window';
    case 'keep_open':
      return 'Use Global Default — Keep Launcher Window Open';
    case 'hide_tray_hibernate':
    default:
      return 'Use Global Default — Hide & Hibernate UI';
  }
}

export interface InGameFootprintBadgeInput {
  preferredPlatformId: StorefrontId;
  activeDisplayMethod: LaunchMethod;
  inGameLauncherBehavior: 'default' | InGameLauncherBehavior;
  storefrontClientLifecycle: 'default' | StorefrontClientLifecyclePolicy;
  perfSettings: LauncherPerformanceSettings;
  isBottleContext?: boolean;
}

export interface InGameFootprintBadgeResult {
  label: string;
  tone: 'emerald' | 'sky' | 'amber' | 'slate';
}

export function resolveEffectiveUiStorefrontLifecycle(params: {
  preferredPlatformId: StorefrontId;
  isBottleContext: boolean;
  storefrontClientLifecycle: 'default' | StorefrontClientLifecyclePolicy;
  fallbackGlobalLifecycle: StorefrontClientLifecyclePolicy;
}): StorefrontClientLifecyclePolicy {
  if (params.storefrontClientLifecycle !== 'default') {
    return params.storefrontClientLifecycle;
  }
  if (
    (params.preferredPlatformId === 'epic' || params.preferredPlatformId === 'xbox') &&
    params.isBottleContext
  ) {
    return 'fast_direct_bypass';
  }
  return params.fallbackGlobalLifecycle;
}

export function computeInGameFootprintBadge({
  preferredPlatformId,
  activeDisplayMethod,
  inGameLauncherBehavior,
  storefrontClientLifecycle,
  perfSettings,
  isBottleContext = false,
}: InGameFootprintBadgeInput): InGameFootprintBadgeResult {
  const effectiveBehavior: InGameLauncherBehavior =
    inGameLauncherBehavior === 'default'
      ? perfSettings.inGameLauncherBehavior
      : inGameLauncherBehavior;
  const rawEffectiveLifecycle: StorefrontClientLifecyclePolicy =
    resolveEffectiveUiStorefrontLifecycle({
      preferredPlatformId,
      isBottleContext,
      storefrontClientLifecycle,
      fallbackGlobalLifecycle: perfSettings.storefrontClientLifecycle,
    });

  const isStorefrontUri = activeDisplayMethod === 'storefront_uri';

  const effectiveLifecycle: StorefrontClientLifecyclePolicy =
    preferredPlatformId === 'gog' && !isBottleContext && rawEffectiveLifecycle === 'default_client'
      ? 'minimal_keep_running'
      : preferredPlatformId === 'steam' &&
          !isBottleContext &&
          isStorefrontUri &&
          rawEffectiveLifecycle === 'fast_direct_bypass'
        ? 'minimal_and_close_if_started'
        : rawEffectiveLifecycle;

  if (
    isStorefrontUri &&
    (preferredPlatformId !== 'steam' ||
      isBottleContext ||
      effectiveLifecycle === 'default_client')
  ) {
    return {
      label: 'Desktop Client Managed • Standard Footprint',
      tone: 'sky',
    };
  }

  const isAlwaysClientlessStorefront =
    !isStorefrontUri && preferredPlatformId === 'epic' && !isBottleContext;
  const hasManageableStorefrontClient =
    preferredPlatformId !== 'custom' &&
    !isAlwaysClientlessStorefront &&
    (!isStorefrontUri || (preferredPlatformId === 'steam' && !isBottleContext));

  const isFastBypass =
    hasManageableStorefrontClient &&
    !isStorefrontUri &&
    (effectiveLifecycle === 'fast_direct_bypass' ||
      ((preferredPlatformId === 'steam' || isBottleContext) &&
        activeDisplayMethod === 'direct'));
  const bypassesSteamCloud = isFastBypass && preferredPlatformId === 'steam';

  if (effectiveBehavior === 'keep_open') {
    if (bypassesSteamCloud) {
      return {
        label: 'Launcher Open • Fast Bypass (No Steam Cloud)',
        tone: 'amber',
      };
    }
    if (isFastBypass) {
      return {
        label: 'Launcher Open • Storefront Bypassed',
        tone: 'sky',
      };
    }
    if (hasManageableStorefrontClient && effectiveLifecycle === 'default_client') {
      return {
        label: 'Full Desktop Footprint • UI & Store Active',
        tone: 'slate',
      };
    }
    return {
      label: 'Standard Footprint • Launcher UI Active',
      tone: 'slate',
    };
  }

  if (effectiveBehavior === 'minimize_taskbar') {
    if (bypassesSteamCloud) {
      return {
        label: 'Minimized UI • Fast Bypass (No Steam Cloud)',
        tone: 'amber',
      };
    }
    if (isFastBypass) {
      return {
        label: 'Low Footprint • Minimized UI + Fast Launch',
        tone: 'sky',
      };
    }
    if (hasManageableStorefrontClient && effectiveLifecycle === 'default_client') {
      return {
        label: 'Moderate Footprint • Minimized UI + Full Client',
        tone: 'slate',
      };
    }
    return {
      label: 'Reduced Footprint • UI Minimized',
      tone: 'sky',
    };
  }

  if (effectiveBehavior === 'zero_renderer_daemon') {
    if (bypassesSteamCloud) {
      return {
        label: 'Max Speed (~45 MB) • Steam Cloud Bypassed',
        tone: 'amber',
      };
    }
    if (isFastBypass || isAlwaysClientlessStorefront) {
      return {
        label: 'Ultra-Low RAM (~45 MB) • 0% GPU • Clientless',
        tone: 'emerald',
      };
    }
    if (
      hasManageableStorefrontClient &&
      (effectiveLifecycle === 'default_client' || effectiveLifecycle === 'minimal_keep_running')
    ) {
      return {
        label: 'Ultra-Low App RAM (~45 MB) • Client Warm',
        tone: 'sky',
      };
    }
    return {
      label: 'Ultra-Low RAM (~45 MB) • Zero-GPU + Cloud Sync',
      tone: 'emerald',
    };
  }

  // Default: hide_tray_hibernate
  if (bypassesSteamCloud) {
    return {
      label: 'Fast Direct Bypass • Zero-GPU (No Steam Cloud)',
      tone: 'amber',
    };
  }
  if (isFastBypass) {
    return {
      label: 'Max Savings • Zero-GPU + Fast Launch',
      tone: 'emerald',
    };
  }
  if (hasManageableStorefrontClient && effectiveLifecycle === 'default_client') {
    return {
      label: 'Zero-GPU Hibernation • Full Store Client',
      tone: 'sky',
    };
  }
  if (hasManageableStorefrontClient && effectiveLifecycle === 'minimal_keep_running') {
    return {
      label: 'Low-RAM / Zero-GPU • Silent Client Kept Warm',
      tone: 'sky',
    };
  }
  if (!perfSettings.pauseBackgroundSyncInGame && !perfSettings.pauseDownloadsInGame) {
    return {
      label: 'Low-RAM / Zero-GPU • Background Tasks Active',
      tone: 'sky',
    };
  }
  return {
    label: 'Low-RAM / Zero-GPU Overhead Mode',
    tone: 'emerald',
  };
}
