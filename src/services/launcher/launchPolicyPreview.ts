import type { CanonicalGame, GamePlatformOwnership } from '../../contracts/game';
import {
  DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS,
  resolveEffectiveLaunchPolicy,
  sanitizeLaunchMethod,
  sanitizeStorefrontLifecyclePolicy,
  type CompatibilityLayerInfo,
  type CompatibilityLayerType,
  type CompatibilityRunnerDescriptor,
  type FastMinimalLaunchAdvisory,
  type GameInstallInfo,
  type GameLaunchConfig,
  type InstalledGameRecord,
  type LaunchMethod,
  type ResolvedLaunchModePreview,
  type StorefrontClientLifecyclePolicy,
  type StorefrontLaunchPolicyView,
  type StorefrontPolicyInfoBox,
  type StorefrontPolicyOptionDescriptor,
} from '../../contracts/launcher';
import type { StorefrontId } from '../../contracts/platform';
import { getStorefrontNativeOsFlags } from '../platform/nativeOsService';
import {
  sanitizeLegacyCompatLayer,
  sanitizeStorefrontLifecycleOverride,
} from './launchConfigStore';

export const COMPATIBILITY_RUNNER_DESCRIPTORS: CompatibilityRunnerDescriptor[] = [
  {
    type: 'crossover',
    label: 'CrossOver (Recommended)',
    shortLabel: 'CrossOver',
    vendor: 'CodeWeavers',
    description:
      'Commercial Windows compatibility layer for macOS with built-in Bottle management, D3DMetal, DXMT, DXVK, and MetalFX DLSS upscaling.',
    bestFor:
      'Best overall compatibility for DirectX 9/10/11/12 Windows games and Windows Steam/GOG/Epic bottles.',
    downloadUrl: 'https://www.codeweavers.com/crossover/download',
    downloadLabel: 'Download CrossOver Installer',
    brewCask: 'crossover',
    brewCommandDisplay: 'brew install --cask crossover',
    canAutoInstallViaBrew: true,
  },
  {
    type: 'crossover_preview',
    label: 'CrossOver Preview',
    shortLabel: 'CrossOver Preview',
    vendor: 'CodeWeavers',
    description:
      'Early-access preview build of CrossOver featuring the latest experimental Wine, D3DMetal, and DXMT updates.',
    bestFor:
      'Testing newly released Windows titles that need bleeding-edge graphics translation fixes.',
    downloadUrl: 'https://www.codeweavers.com/preview/download',
    downloadLabel: 'Open CrossOver Preview Download',
    canAutoInstallViaBrew: false,
  },
  {
    type: 'gptk',
    label: 'Apple Game Porting Toolkit (GPTK / D3DMetal)',
    shortLabel: 'Apple GPTK',
    vendor: 'Apple',
    description:
      'Apple’s DirectX 11/12-to-Metal 3 runtime (D3DMetal), detected from /Applications/Game Porting Toolkit.app or Heroic GPTK tools.',
    bestFor:
      'Running DirectX 12 Windows executables on Apple Silicon using Apple’s standalone D3DMetal runtime.',
    downloadUrl: 'https://developer.apple.com/games/game-porting-toolkit/',
    downloadLabel: 'Open Apple GPTK Downloads',
    brewCask: 'game-porting-toolkit',
    brewCommandDisplay:
      'brew tap apple/apple http://github.com/apple/homebrew-apple && brew install --cask game-porting-toolkit',
    canAutoInstallViaBrew: false,
  },
  {
    type: 'wine',
    label: 'Open-Source Wine (Wine-CrossOver / Wine Stable)',
    shortLabel: 'Open-Source Wine',
    vendor: 'WineHQ / Homebrew / Gcenx',
    description:
      'Free, open-source Windows API translation layer (wine64) installed via Homebrew, WineHQ (.app), or Heroic Wine-CrossOver builds.',
    bestFor:
      'Running DRM-free or standalone DirectX 9/10/11 Windows .exe games without a paid CrossOver license.',
    downloadUrl: 'https://gitlab.winehq.org/wine/wine/-/wikis/MacOS',
    downloadLabel: 'Open Official WineHQ macOS Guide',
    brewCask: 'wine-stable',
    brewCommandDisplay: 'brew install --cask --no-quarantine wine-stable',
    canAutoInstallViaBrew: true,
  },
];

export interface FastMinimalLaunchAdvisoryParams {
  platformId: StorefrontId;
  detectedBuildType: ResolvedLaunchModePreview['detectedBuildType'];
  hostPlatform: 'darwin' | 'win32' | 'linux';
  launchMethod: LaunchMethod;
  storefrontClientLifecycle: 'default' | StorefrontClientLifecyclePolicy;
  globalStorefrontLifecycle?: StorefrontClientLifecyclePolicy;
  isInstalled?: boolean;
  executablePath?: string;
}

export function computeFastMinimalLaunchAdvisory(
  params: FastMinimalLaunchAdvisoryParams,
  fallbackGlobalLifecycle: StorefrontClientLifecyclePolicy = DEFAULT_LAUNCHER_PERFORMANCE_SETTINGS.storefrontClientLifecycle
): FastMinimalLaunchAdvisory {
  const policy = resolveEffectiveLaunchPolicy({
    platformId: params.platformId,
    hostPlatform: params.hostPlatform,
    detectedBuildType: params.detectedBuildType,
    isInstalled: params.isInstalled,
    executablePath: params.executablePath,
    configuredLaunchMethod: params.launchMethod,
    storefrontClientLifecycle: params.storefrontClientLifecycle,
    globalStorefrontLifecycle: params.globalStorefrontLifecycle || fallbackGlobalLifecycle,
  });

  const isBottle =
    params.hostPlatform === 'darwin' && params.detectedBuildType === 'windows_exe_on_mac';

  if (params.platformId === 'steam') {
    const title = isBottle
      ? 'Fast Bottle Direct Launch Active (Bypasses Bottle Steam)'
      : 'Fast Direct Launch Active (Bypasses Steam Client)';
    const footprintBenefit = isBottle
      ? 'Saves ~350–700 MB bottle RAM & 5–12s startup by skipping steam.exe + steamwebhelper.exe'
      : 'Saves ~400–800 MB RAM & instant startup by skipping Steam client & steamwebhelper';
    const warnings = [
      'Bypasses Steam Cloud Sync: Steam Cloud Saves (ISteamRemoteStorage & Auto-Cloud) will NOT sync before launch or after exit unless Steam is already running in the same OS / bottle.',
      'Achievements / Trophies Do NOT Work: Steam Achievements / Trophies, Shift+Tab Overlay, Friends Co-op Invites, Steam Input controller remapping, Workshop mods, and Steam Cloud Playtime are disabled during direct bypass (One Launcher still tracks local playtime).',
      'SteamStub / Denuvo / AuthTicket DRM & Anti-Cheat (EAC / BattlEye / VAC): Games requiring a live Steam session handshake or anti-cheat bootstrapper may refuse to open or reject online matchmaking.',
    ];
    return {
      isActive: policy.isFastDirectBypass,
      title,
      footprintBenefit,
      warnings,
      recommendation: isBottle
        ? 'Recommended only for DRM-free or offline single-player Steam titles. If a game fails to open or needs Steam Cloud Saves / Achievements, switch Bottle Steam Launch Policy to Silent Bottle Steam + Auto-Close on Exit.'
        : 'Recommended only for DRM-free or offline single-player Steam titles. If a game fails to open or needs Steam Cloud Saves / Achievements, switch Launch Mode to Storefront Client Protocol.',
      severity: 'warning',
      badgeLabel: footprintBenefit,
      headline: title,
      consequences: warnings,
    };
  }

  if (params.platformId === 'gog') {
    const title = isBottle
      ? 'Fast Bottle Direct Launch Active (Bypasses GOG Galaxy)'
      : 'Fast Direct Launch Active (Bypasses GOG Galaxy)';
    const footprintBenefit =
      'Saves ~250–400 MB RAM & instant DRM-free startup (0 MB background storefront daemon)';
    const warnings = [
      'Achievements / Trophies Do NOT Work: Live in-game GOG Achievements / Trophies (Galaxy64.dll / libGalaxy64.dylib), Shift+Tab Overlay, Leaderboards, and Galaxy P2P Multiplayer do NOT work when GOG Galaxy is bypassed.',
      'Cloud Saves & Playtime Remain Active: One Launcher still syncs standalone gogdl Cloud Saves both ways (pre-launch download + post-exit upload) and uploads GOG playtime while bypassing GOG Galaxy (0 MB background daemon).',
    ];
    return {
      isActive: policy.isFastDirectBypass,
      title,
      footprintBenefit,
      warnings,
      recommendation:
        'Ideal for single-player DRM-free GOG games when you do not need GOG Achievements / Trophies. Switch GOG Galaxy Launch Policy to Silent Background GOG Galaxy + Auto-Close on Exit if you want live Achievements / Trophies or P2P Multiplayer.',
      severity: 'warning',
      badgeLabel: footprintBenefit,
      headline: title,
      consequences: warnings,
    };
  }

  if (params.platformId === 'epic') {
    const title = isBottle
      ? 'Fast Bottle Direct Launch Active (Clientless EOS Mode)'
      : 'Fast Direct Launch Active (Clientless EOS Mode)';
    const footprintBenefit = 'Saves ~450–900 MB RAM by bypassing Epic Games Launcher completely';
    const warnings = [
      'Cloud Saves, Achievements, Multiplayer & Playtime Remain Active: One Launcher injects a fresh one-time EOS OAuth Exchange Code and syncs standalone legendary Cloud Saves both ways (pre-launch download + post-exit upload) while bypassing Epic Games Launcher.',
      'Epic Social Overlay (Shift+F3) & In-Game Store Checkout UI require Epic Games Launcher / EOS Overlay redistributable.',
    ];
    return {
      isActive: policy.isFastDirectBypass,
      title,
      footprintBenefit,
      warnings,
      recommendation:
        'Safe and recommended for virtually all Epic titles across Windows, macOS, and CrossOver/Wine bottles.',
      severity: 'info',
      badgeLabel: footprintBenefit,
      headline: title,
      consequences: warnings,
    };
  }

  return {
    isActive: false,
    title: 'Standalone Custom Executable',
    footprintBenefit: '0 MB background storefront daemon overhead (runs executable directly)',
    warnings: [],
    recommendation:
      'Launches your custom executable directly without requiring any external storefront client.',
    severity: 'info',
    badgeLabel: '0 MB background storefront daemon overhead (runs executable directly)',
    headline: 'Standalone Custom Executable',
    consequences: [],
  };
}

export interface BuildStorefrontLaunchPolicyViewParams {
  platformId: StorefrontId;
  detectedBuildType: ResolvedLaunchModePreview['detectedBuildType'];
  activeDisplayMethod: LaunchMethod;
  effectiveLifecycle: StorefrontClientLifecyclePolicy;
  isInstalled: boolean;
  hostPlatform: 'darwin' | 'win32' | 'linux';
}

export function buildStorefrontLaunchPolicyView(
  params: BuildStorefrontLaunchPolicyViewParams
): StorefrontLaunchPolicyView {
  const {
    platformId,
    detectedBuildType,
    activeDisplayMethod,
    effectiveLifecycle: rawEffectiveLifecycle,
    hostPlatform,
  } = params;

  const cleanLifecycle = sanitizeStorefrontLifecyclePolicy(
    rawEffectiveLifecycle,
    'minimal_and_close_if_started'
  );

  const isBottleContext =
    hostPlatform !== 'win32' &&
    (detectedBuildType === 'windows_exe_on_mac' ||
      activeDisplayMethod === 'compatibility_layer');

  const cardHeading = isBottleContext
    ? platformId === 'steam'
      ? 'Bottle Steam Launch Policy'
      : platformId === 'gog'
        ? 'Bottle GOG Launch Policy'
        : platformId === 'epic'
          ? 'Bottle Epic Games Store Launch Policy'
          : 'Bottle Standalone Launch Policy'
    : platformId === 'steam'
      ? 'Steam Launch Policy'
      : platformId === 'gog'
        ? 'GOG Galaxy Launch Policy'
        : platformId === 'epic'
          ? 'Epic Games Store Launch Policy'
          : 'Standalone Launch Policy';

  const isWinHost = hostPlatform === 'win32';
  const trayOrMenuLabel = isWinHost ? 'System Tray' : 'Menu Bar';

  // Custom / standalone non-storefront game
  if (platformId === 'custom') {
    return {
      cardHeading,
      isBottleContext,
      showDropdown: false,
      dropdownOptions: [],
      selectedDropdownValue: cleanLifecycle,
      infoBox: {
        policyKey: 'fast_direct_bypass',
        cardHeading,
        severity: 'info',
        badgeLabel: '0 MB Storefront Overhead',
        headline: 'Standalone Executable Pipeline',
        footprintSummary:
          'Runs your game binary directly with 0 MB background storefront client overhead.',
        includedFeatures: [
          'Direct process execution with live PID playtime tracking',
          'Full custom launch arguments, working directory & environment overrides',
        ],
        excludedOrTradeoffs: [],
      },
    };
  }

  // Epic Games Store (Native & Bottle)
  if (platformId === 'epic') {
    if (activeDisplayMethod === 'storefront_uri') {
      return {
        cardHeading,
        isBottleContext,
        showDropdown: false,
        dropdownOptions: [],
        selectedDropdownValue: cleanLifecycle,
        infoBox: {
          policyKey: 'protocol_delegated',
          cardHeading,
          severity: 'info',
          badgeLabel: 'Delegated to Epic Games Launcher',
          headline: 'Epic Games Launcher Desktop Client Manages Launch & Sync',
          footprintSummary:
            'Hands launch off via com.epicgames.launcher:// to the official Epic Games Launcher desktop application (~450–900 MB RAM).',
          includedFeatures: [
            'Epic Games Launcher manages Cloud Save Sync, EOS Social Overlay (Shift+F3) & updates',
            'Full in-game Epic Store checkout & Friends overlay support',
          ],
          excludedOrTradeoffs: [
            'Uses ~450–900 MB extra RAM compared to Recommended Clientless Direct mode',
            'Bypasses One Launcher custom executable, launch arguments, HUD & environment overrides',
          ],
        },
      };
    }

    if (isBottleContext) {
      const bottleEpicOptions: StorefrontPolicyOptionDescriptor[] = [
        {
          value: 'default_client',
          label: 'Standard Bottle Epic Games Launcher (Full Window, Keep Running)',
        },
        {
          value: 'minimal_keep_running',
          label: 'Silent Bottle Epic Launcher — Keep Running in Bottle',
        },
        {
          value: 'minimal_and_close_if_started',
          label: 'Silent Bottle Epic Launcher + Auto-Close on Exit (Recommended)',
          isRecommended: true,
        },
        {
          value: 'fast_direct_bypass',
          label: 'Fast Bottle Launch — Bypass Bottle Epic Launcher (Clientless EOS)',
        },
      ];

      const selectedBottleEpicValue: StorefrontClientLifecyclePolicy =
        activeDisplayMethod === 'direct' ? 'fast_direct_bypass' : cleanLifecycle;

      let bottleEpicInfoBox: StorefrontPolicyInfoBox;
      if (selectedBottleEpicValue === 'fast_direct_bypass') {
        bottleEpicInfoBox = {
          policyKey: 'clientless_epic',
          cardHeading,
          severity: 'optimal',
          badgeLabel: 'Clientless EOS Pipeline • 0 MB Epic Launcher',
          headline: 'Fast Bottle Launch Active — Zero-Footprint Clientless Bottle Epic Pipeline',
          footprintSummary:
            'Spawns the Windows .exe directly in Wine/CrossOver without booting EpicGamesLauncher.exe (saves ~450–900 MB bottle RAM & 5–12s cold boot) using EOS OAuth Exchange Code + standalone legendary Cloud Sync.',
          includedFeatures: [
            '0 MB Bottle Epic Games Launcher / Chromium RAM overhead & instant cold bottle .exe startup',
            'Two-way Epic Cloud Save Sync via standalone legendary CLI (pre-launch download + post-exit upload)',
            'Live EOS Achievements, Epic Online Multiplayer & Anti-Cheat via fresh OAuth Exchange Code',
          ],
          excludedOrTradeoffs: [
            'Epic Social Overlay (Shift+F3) & in-game Epic Store checkout UI require Bottle Epic Games Launcher',
          ],
        };
      } else if (selectedBottleEpicValue === 'default_client') {
        bottleEpicInfoBox = {
          policyKey: 'default_client',
          cardHeading,
          severity: 'info',
          badgeLabel: 'Full Bottle Epic UI • Kept Open',
          headline: 'Standard Bottle Epic Games Launcher (Full Window Inside Bottle)',
          footprintSummary:
            'Boots full Windows EpicGamesLauncher.exe inside the Wine/CrossOver bottle (~450–900 MB bottle RAM when installed) and keeps it open alongside legendary Cloud Sync.',
          includedFeatures: [
            'Two-way Epic Cloud Save Sync via standalone legendary CLI + EOS OAuth Exchange Code',
            'Live EOS Achievements, Epic Social Overlay (Shift+F3) & in-game Store UI (when Epic Launcher is installed in bottle)',
            'Access to full Windows Epic Games Launcher UI inside the bottle',
          ],
          excludedOrTradeoffs: [
            'Adds ~5–12 seconds on cold bottle startup while full Windows EpicGamesLauncher.exe & Chromium webhelpers boot (when installed in bottle)',
            'Heavy Chromium RAM & CPU overhead inside Wine/CrossOver (~450–900 MB RAM) while Epic Launcher stays open',
          ],
        };
      } else if (selectedBottleEpicValue === 'minimal_keep_running') {
        bottleEpicInfoBox = {
          policyKey: 'minimal_keep_running',
          cardHeading,
          severity: 'info',
          badgeLabel: 'Silent Bottle Epic • Fast Re-Launch',
          headline: 'Silent Bottle Epic Launcher — Kept Warm Inside Bottle',
          footprintSummary:
            'Runs Windows EpicGamesLauncher.exe in silent background mode (-silent) inside the bottle while keeping standalone legendary Cloud Sync & EOS auth active.',
          includedFeatures: [
            'Two-way Epic Cloud Save Sync via standalone legendary CLI + EOS OAuth Exchange Code',
            'Live EOS Achievements, Multiplayer & Epic Social Overlay (when Epic Launcher is installed in bottle)',
            'Bottle Epic Launcher stays warm for faster subsequent launches in the same session',
          ],
          excludedOrTradeoffs: [
            'Adds ~3–8 seconds on initial cold bottle startup while silent EpicGamesLauncher.exe authenticates (subsequent launches while warm skip cold boot)',
            'Background EpicGamesLauncher.exe remains resident in the bottle between sessions (~300–550 MB RAM)',
          ],
        };
      } else {
        bottleEpicInfoBox = {
          policyKey: 'minimal_and_close_if_started',
          cardHeading,
          severity: 'optimal',
          badgeLabel: 'Recommended • Cloud Sync + EOS + Auto-Close',
          headline: 'Silent Bottle Epic Launcher + Auto-Close on Exit',
          footprintSummary:
            'Syncs Epic Cloud Saves via legendary, injects EOS auth, wakes silent Bottle Epic Launcher when installed in the bottle, and reclaims all bottle RAM on exit.',
          includedFeatures: [
            'Two-way Epic Cloud Save Sync via standalone legendary CLI + Live EOS Achievements & Multiplayer',
            'Wakes silent Bottle Epic Launcher for EOS Social Overlay when installed in bottle (falls back cleanly to 0 MB Clientless EOS if not installed)',
            'Reclaims 100% of Bottle Epic Launcher & wineserver RAM after you quit the game',
          ],
          excludedOrTradeoffs: [
            'Adds ~3–8 seconds on cold bottle startup while silent EpicGamesLauncher.exe authenticates (0s extra overhead if Epic Launcher is not installed in bottle)',
          ],
        };
      }

      return {
        cardHeading,
        isBottleContext: true,
        showDropdown: true,
        dropdownOptions: bottleEpicOptions,
        selectedDropdownValue: selectedBottleEpicValue,
        infoBox: bottleEpicInfoBox,
      };
    }

    return {
      cardHeading,
      isBottleContext: false,
      showDropdown: false,
      dropdownOptions: [],
      selectedDropdownValue: cleanLifecycle,
      infoBox: {
        policyKey: 'clientless_epic',
        cardHeading,
        severity: 'optimal',
        badgeLabel: 'Clientless EOS Pipeline • 0 MB Epic Launcher',
        headline: 'Zero-Footprint Clientless Epic Pipeline',
        footprintSummary:
          'Launches directly without booting Epic Games Launcher (saves ~450–900 MB RAM) using EOS OAuth Exchange Code injection and standalone legendary Cloud Save Sync.',
        includedFeatures: [
          'Two-way Epic Cloud Save Sync via standalone legendary CLI (pre-launch download + post-exit upload)',
          'Live EOS Achievements, Epic Online Multiplayer & Anti-Cheat via fresh OAuth Exchange Code',
          '0 MB Epic Games Launcher background RAM & CPU overhead',
        ],
        excludedOrTradeoffs: [
          'Epic Social Overlay (Shift+F3) & in-game Epic Store checkout UI require launching via Epic Games Launcher',
        ],
      },
    };
  }

  // GOG (Bottle vs Native Protocol vs Native Direct)
  if (platformId === 'gog') {
    if (activeDisplayMethod === 'storefront_uri') {
      return {
        cardHeading,
        isBottleContext,
        showDropdown: false,
        dropdownOptions: [],
        selectedDropdownValue: isBottleContext
          ? cleanLifecycle
          : cleanLifecycle === 'default_client'
            ? 'minimal_keep_running'
            : cleanLifecycle,
        infoBox: {
          policyKey: 'protocol_delegated',
          cardHeading,
          severity: 'info',
          badgeLabel: 'Delegated to GOG Galaxy Client',
          headline: 'GOG Galaxy Desktop Client Manages Launch & Sync',
          footprintSummary:
            'Hands launch off via goggalaxy://launchGame to the official GOG Galaxy desktop application (~250–450 MB RAM).',
          includedFeatures: [
            'GOG Galaxy manages Cloud Save Sync, Achievements / Trophies, Shift+Tab Overlay & updates',
            'Full Galaxy SDK P2P Multiplayer & Friends presence',
          ],
          excludedOrTradeoffs: [
            'Bypasses One Launcher custom executable, launch arguments, HUD & environment overrides',
            'GOG Galaxy desktop window remains managed by GOG Galaxy rather than One Launcher',
          ],
        },
      };
    }

    if (isBottleContext) {
      const bottleGogOptions: StorefrontPolicyOptionDescriptor[] = [
        {
          value: 'default_client',
          label: 'Standard Bottle GOG Galaxy Client (Full Window, Keep Running)',
        },
        {
          value: 'minimal_keep_running',
          label: 'Silent Bottle GOG Galaxy — Keep Running in Bottle',
        },
        {
          value: 'minimal_and_close_if_started',
          label: 'Silent Bottle GOG Galaxy + Auto-Close on Exit (Recommended)',
          isRecommended: true,
        },
        {
          value: 'fast_direct_bypass',
          label: 'Fast Bottle Launch — Bypass Bottle GOG Galaxy (Minimal Footprint)',
        },
      ];

      const selectedBottleGogValue: StorefrontClientLifecyclePolicy =
        activeDisplayMethod === 'direct' ? 'fast_direct_bypass' : cleanLifecycle;

      let bottleGogInfoBox: StorefrontPolicyInfoBox;
      if (selectedBottleGogValue === 'fast_direct_bypass') {
        bottleGogInfoBox = {
          policyKey: 'fast_direct_bypass',
          cardHeading,
          severity: 'warning',
          badgeLabel: 'Saves ~250–450 MB Bottle RAM • No Achievements/Trophies',
          headline: 'Fast Bottle Launch Active — Bypasses Bottle GOG Galaxy',
          footprintSummary:
            'Spawns the DRM-free Windows GOG .exe directly in Wine/CrossOver with 0 MB GOG Galaxy overhead while preserving two-way gogdl Cloud Save Sync.',
          includedFeatures: [
            '0 MB Bottle GOG Galaxy / Chromium RAM overhead & instant cold bottle .exe startup',
            'Two-way GOG Cloud Save Sync mapped into your bottle via standalone gogdl CLI',
            'GOG playtime sync & full CrossOver D3DMetal / DXMT / MetalFX overrides',
          ],
          excludedOrTradeoffs: [
            'GOG Achievements / Trophies DO NOT work when Bottle GOG Galaxy is bypassed',
            'GOG Shift+Tab Overlay, Leaderboards & Galaxy SDK P2P Multiplayer are disabled',
          ],
        };
      } else if (selectedBottleGogValue === 'default_client') {
        bottleGogInfoBox = {
          policyKey: 'default_client',
          cardHeading,
          severity: 'info',
          badgeLabel: 'Full Bottle Galaxy UI • Kept Open',
          headline: 'Standard Bottle GOG Galaxy Client (Full Window Inside Bottle)',
          footprintSummary:
            'Boots Windows GalaxyClient.exe inside the Wine/CrossOver bottle (~250–450 MB bottle RAM when installed) and keeps it open while syncing Cloud Saves via gogdl.',
          includedFeatures: [
            'Two-way GOG Cloud Save Sync mapped directly into your bottle via standalone gogdl CLI',
            'Live GOG Achievements / Trophies, Overlay & Galaxy P2P Multiplayer (when Windows GOG Galaxy is installed in bottle)',
            'Access to full Windows GOG Galaxy UI inside the bottle',
          ],
          excludedOrTradeoffs: [
            'Adds ~5–10 seconds on cold bottle startup while full Windows GalaxyClient.exe & webhelpers boot (when installed in bottle)',
            'Uses ~250–450 MB bottle RAM & CPU overhead while Bottle GOG Galaxy stays open',
          ],
        };
      } else if (selectedBottleGogValue === 'minimal_keep_running') {
        bottleGogInfoBox = {
          policyKey: 'minimal_keep_running',
          cardHeading,
          severity: 'info',
          badgeLabel: 'Silent Bottle Galaxy • Fast Re-Launch',
          headline: 'Silent Bottle GOG Galaxy — Kept Warm Inside Bottle',
          footprintSummary:
            'Runs Windows GalaxyClient.exe silently (/deactivated) inside the bottle for Galaxy SDK features while keeping gogdl Cloud Save Sync active.',
          includedFeatures: [
            'Two-way GOG Cloud Save Sync mapped directly into your bottle via standalone gogdl CLI',
            'Live GOG Achievements / Trophies, Leaderboards & Galaxy P2P Multiplayer (when Windows GOG Galaxy is installed in bottle)',
            'Bottle GOG Galaxy stays warm for faster SDK handshake on subsequent launches',
          ],
          excludedOrTradeoffs: [
            'Adds ~3–8 seconds on initial cold bottle startup while silent GalaxyClient.exe authenticates (subsequent launches while warm skip cold boot)',
            'Background GalaxyClient.exe remains resident in the bottle between sessions (~200–350 MB RAM)',
          ],
        };
      } else {
        bottleGogInfoBox = {
          policyKey: 'minimal_and_close_if_started',
          cardHeading,
          severity: 'optimal',
          badgeLabel: 'Recommended • Cloud Sync + Trophies + Auto-Close',
          headline: 'Silent Bottle GOG Galaxy + Auto-Close on Exit',
          footprintSummary:
            'Syncs GOG Cloud Saves via standalone gogdl, wakes silent Bottle GOG Galaxy for Achievements/Trophies when installed in the bottle, and reclaims all bottle RAM on exit.',
          includedFeatures: [
            'Two-way GOG Cloud Save Sync mapped directly into your bottle via standalone gogdl CLI',
            'Live GOG Achievements / Trophies & Galaxy SDK features when Windows GOG Galaxy is installed in bottle (falls back cleanly to clientless direct launch if not installed)',
            'Reclaims 100% of Bottle GOG Galaxy & wineserver RAM after you quit the game',
          ],
          excludedOrTradeoffs: [
            'Adds ~3–8 seconds on cold bottle startup while silent GalaxyClient.exe authenticates (0s extra overhead if GOG Galaxy is not installed in bottle)',
          ],
        };
      }

      return {
        cardHeading,
        isBottleContext: true,
        showDropdown: true,
        dropdownOptions: bottleGogOptions,
        selectedDropdownValue: selectedBottleGogValue,
        infoBox: bottleGogInfoBox,
      };
    }

    // GOG Native (Direct mode) — 3 options ordered closest-to-standard first -> furthest bypass last
    const gogOptions: StorefrontPolicyOptionDescriptor[] = [
      {
        value: 'minimal_keep_running',
        label: `Silent Background GOG Galaxy — Keep Running in ${trayOrMenuLabel}`,
      },
      {
        value: 'minimal_and_close_if_started',
        label: 'Silent Background GOG Galaxy + Auto-Close on Exit (Recommended)',
        isRecommended: true,
      },
      {
        value: 'fast_direct_bypass',
        label: 'Fast Direct Launch — Bypass GOG Galaxy Client (Minimal Footprint)',
      },
    ];

    const selectedGogValue: StorefrontClientLifecyclePolicy =
      cleanLifecycle === 'default_client' ? 'minimal_keep_running' : cleanLifecycle;

    let gogInfoBox: StorefrontPolicyInfoBox;
    if (selectedGogValue === 'fast_direct_bypass') {
      gogInfoBox = {
        policyKey: 'fast_direct_bypass',
        cardHeading,
        severity: 'warning',
        badgeLabel: 'Saves ~250–400 MB RAM • No Achievements/Trophies',
        headline: 'Fast Direct Launch Active — Bypasses GOG Galaxy Client',
        footprintSummary:
          'Launches the DRM-free GOG binary directly with 0 MB GOG Galaxy background daemon overhead while preserving standalone gogdl Cloud Saves.',
        includedFeatures: [
          '0 MB GOG Galaxy background client RAM overhead & instant DRM-free startup',
          'Two-way GOG Cloud Save Sync remains 100% active via standalone gogdl CLI',
          'GOG playtime sync & full custom launch argument / HUD overrides',
        ],
        excludedOrTradeoffs: [
          'GOG Achievements / Trophies DO NOT work when GOG Galaxy is bypassed',
          'GOG Shift+Tab Overlay, Leaderboards & Galaxy SDK P2P Multiplayer are disabled',
        ],
      };
    } else if (selectedGogValue === 'minimal_keep_running') {
      gogInfoBox = {
        policyKey: 'minimal_keep_running',
        cardHeading,
        severity: 'info',
        badgeLabel: 'Silent GOG Galaxy SDK • Kept Warm',
        headline: `Silent Background GOG Galaxy — Kept Running in ${trayOrMenuLabel}`,
        footprintSummary:
          'Runs GOG Galaxy silently in the background for Galaxy SDK services while One Launcher handles standalone gogdl Cloud Save Sync.',
        includedFeatures: [
          'Two-way GOG Cloud Save Sync via standalone gogdl CLI (pre-launch + post-exit)',
          'Live GOG Achievements / Trophies, Leaderboards & Galaxy P2P Multiplayer (Galaxy SDK)',
          'GOG Galaxy stays warm in the background for instant SDK handshake on next launch',
        ],
        excludedOrTradeoffs: [
          `GOG Galaxy background daemon remains resident in the ${trayOrMenuLabel} (~250–400 MB RAM)`,
        ],
      };
    } else {
      gogInfoBox = {
        policyKey: 'minimal_and_close_if_started',
        cardHeading,
        severity: 'optimal',
        badgeLabel: 'Recommended • Cloud Sync + Trophies + Auto-Close',
        headline: 'Silent Background GOG Galaxy + Auto-Close on Exit',
        footprintSummary:
          'Starts GOG Galaxy silently for live Achievements/Trophies & SDK features, syncs Cloud Saves via gogdl, and closes GOG Galaxy on exit (if started by One Launcher).',
        includedFeatures: [
          'Two-way GOG Cloud Save Sync via standalone gogdl CLI (pre-launch + post-exit)',
          'Live GOG Achievements / Trophies, Leaderboards & Galaxy P2P Multiplayer (Galaxy SDK)',
          '0 MB post-game GOG Galaxy footprint when Galaxy was not already open',
        ],
        excludedOrTradeoffs: [
          'Uses ~250–400 MB background RAM for GOG Galaxy only during gameplay (when Galaxy is installed)',
        ],
      };
    }

    return {
      cardHeading,
      isBottleContext: false,
      showDropdown: true,
      dropdownOptions: gogOptions,
      selectedDropdownValue: selectedGogValue,
      infoBox: gogInfoBox,
    };
  }

  // Steam (Bottle vs Native)
  if (isBottleContext) {
    if (activeDisplayMethod === 'storefront_uri') {
      return {
        cardHeading,
        isBottleContext: true,
        showDropdown: false,
        dropdownOptions: [],
        selectedDropdownValue: cleanLifecycle,
        infoBox: {
          policyKey: 'protocol_delegated',
          cardHeading,
          severity: 'info',
          badgeLabel: 'Delegated to Host Steam Protocol',
          headline: 'Delegated to External Steam Protocol (steam://rungameid)',
          footprintSummary:
            'Hands launch off to the macOS host Steam protocol rather than bottle Steam execution.',
          includedFeatures: [
            'Host Steam client manages launch and Steam Cloud Sync if supported',
          ],
          excludedOrTradeoffs: [
            'Native macOS Steam cannot launch Windows-only .exe builds directly — use Auto-Detect or Compatibility Layer for Bottle Steam',
          ],
        },
      };
    }

    const bottleSteamOptions: StorefrontPolicyOptionDescriptor[] = [
      {
        value: 'default_client',
        label: 'Standard Bottle Steam Client (Full Window, Keep Running)',
      },
      {
        value: 'minimal_keep_running',
        label: 'Silent Bottle Steam — Keep Running in Bottle',
      },
      {
        value: 'minimal_and_close_if_started',
        label: 'Silent Bottle Steam + Auto-Close on Exit (Recommended)',
        isRecommended: true,
      },
      {
        value: 'fast_direct_bypass',
        label: 'Fast Bottle Launch — Bypass Bottle Steam Client (Minimal Footprint)',
      },
    ];

    const selectedBottleSteamValue: StorefrontClientLifecyclePolicy =
      activeDisplayMethod === 'direct' ? 'fast_direct_bypass' : cleanLifecycle;

    let bottleSteamInfoBox: StorefrontPolicyInfoBox;
    if (selectedBottleSteamValue === 'fast_direct_bypass') {
      bottleSteamInfoBox = {
        policyKey: 'fast_direct_bypass',
        cardHeading,
        severity: 'warning',
        badgeLabel: 'Saves ~350–700 MB Bottle RAM • No Cloud or Trophies',
        headline: 'Fast Bottle Launch Active — Bypasses Bottle Steam',
        footprintSummary:
          'Spawns the Windows .exe directly in Wine/CrossOver without starting steam.exe or steamwebhelper.exe (5–12s faster cold boot).',
        includedFeatures: [
          '0 MB bottle Steam / steamwebhelper.exe RAM & CPU overhead',
          'Instant bottle .exe startup with CrossOver D3DMetal / DXMT / MetalFX overrides',
          'Local playtime tracking inside One Launcher',
        ],
        excludedOrTradeoffs: [
          'Steam Achievements / Trophies DO NOT work while bottle Steam is bypassed',
          'Steam Cloud Saves DO NOT sync before launch or after exit',
          'Steam Overlay, Friends Co-op Invites, Steam Input & Workshop Mods are disabled',
          'Games requiring a live SteamStub / AuthTicket DRM handshake will fail to open',
        ],
      };
    } else if (selectedBottleSteamValue === 'default_client') {
      bottleSteamInfoBox = {
        policyKey: 'default_client',
        cardHeading,
        severity: 'info',
        badgeLabel: 'Full Bottle Steam UI • Kept Open',
        headline: 'Standard Bottle Steam Client (Full Window Inside Bottle)',
        footprintSummary:
          'Boots full Windows steam.exe + steamwebhelper.exe inside the Wine/CrossOver bottle (~350–700 MB bottle RAM) and leaves it running.',
        includedFeatures: [
          'Two-way Steam Cloud Save Sync inside the bottle',
          'Live Steam Achievements / Trophies, Steam Overlay, Friends Invites & Steamworks DRM',
          'Access to full Windows Steam UI inside the bottle for Workshop or DLC management',
        ],
        excludedOrTradeoffs: [
          'Adds ~5–12 seconds on cold bottle startup while full Windows steam.exe & steamwebhelper.exe boot (faster only when already open in bottle)',
          'Heavy Chromium steamwebhelper.exe RAM & CPU overhead inside Wine/CrossOver (~350–700 MB RAM)',
          'Bottle Steam stays running until manually closed or bottle shutdown',
        ],
      };
    } else if (selectedBottleSteamValue === 'minimal_keep_running') {
      bottleSteamInfoBox = {
        policyKey: 'minimal_keep_running',
        cardHeading,
        severity: 'info',
        badgeLabel: 'Silent Bottle Steam • Fast Re-Launch',
        headline: 'Silent Bottle Steam — Kept Warm Inside Bottle',
        footprintSummary:
          'Runs Windows steam.exe in silent headless mode (-silent -nochatui -nofriendsui -SuppressBrowser) and keeps it warm in the bottle.',
        includedFeatures: [
          'Two-way Steam Cloud Save Sync inside the bottle',
          'Live Steam Achievements / Trophies, Steam Input & Steamworks DRM handshake',
          'Faster subsequent launches of games in the same bottle',
        ],
        excludedOrTradeoffs: [
          'Adds ~3–8 seconds on initial cold bottle startup while silent steam.exe authenticates (subsequent launches while warm skip cold boot)',
          'Background steam.exe remains running inside the bottle between sessions (~180–350 MB RAM)',
        ],
      };
    } else {
      bottleSteamInfoBox = {
        policyKey: 'minimal_and_close_if_started',
        cardHeading,
        severity: 'optimal',
        badgeLabel: 'Recommended • Cloud Sync + Auto-Shutdown',
        headline: 'Silent Bottle Steam + Auto-Close After Cloud Sync',
        footprintSummary:
          'Runs silent bottle steam.exe for DRM & Cloud Sync, then cleanly shuts down bottle Steam after post-exit Cloud Save upload completes.',
        includedFeatures: [
          'Two-way Steam Cloud Save Sync (pre-launch download + verified post-exit upload)',
          'Live Steam Achievements / Trophies, Steamworks DRM & online authentication',
          'Reclaims 100% of bottle Steam & wineserver RAM after you quit the game',
        ],
        excludedOrTradeoffs: [
          'Adds ~3–8 seconds on cold bottle startup while silent steam.exe authenticates',
        ],
      };
    }

    return {
      cardHeading,
      isBottleContext: true,
      showDropdown: true,
      dropdownOptions: bottleSteamOptions,
      selectedDropdownValue: selectedBottleSteamValue,
      infoBox: bottleSteamInfoBox,
    };
  }

  // Steam Native — 4 options ordered closest-to-standard first -> furthest bypass last
  const nativeSteamOptions: StorefrontPolicyOptionDescriptor[] = [
    {
      value: 'default_client',
      label: 'Standard Steam Desktop Client (Full Window, Keep Open)',
    },
    {
      value: 'minimal_keep_running',
      label: `Silent Background Steam — Keep Running in ${trayOrMenuLabel}`,
    },
    {
      value: 'minimal_and_close_if_started',
      label: 'Silent Background Steam + Auto-Close on Exit (Recommended)',
      isRecommended: true,
    },
    {
      value: 'fast_direct_bypass',
      label: 'Fast Direct Launch — Bypass Steam Client (Minimal Footprint)',
    },
  ];

  const selectedNativeSteamValue: StorefrontClientLifecyclePolicy =
    activeDisplayMethod === 'direct'
      ? 'fast_direct_bypass'
      : cleanLifecycle === 'fast_direct_bypass' && activeDisplayMethod === 'storefront_uri'
        ? 'minimal_and_close_if_started'
        : cleanLifecycle;

  let nativeSteamInfoBox: StorefrontPolicyInfoBox;
  if (selectedNativeSteamValue === 'fast_direct_bypass') {
    nativeSteamInfoBox = {
      policyKey: 'fast_direct_bypass',
      cardHeading,
      severity: 'warning',
      badgeLabel: 'Saves ~400–800 MB RAM • No Cloud or Trophies',
      headline: 'Fast Direct Launch Active — Bypasses Steam Client',
      footprintSummary:
        'Spawns the local game binary directly with 0 MB Steam client / steamwebhelper overhead and instant startup.',
      includedFeatures: [
        '0 MB Steam background daemon & Chromium webhelper RAM overhead',
        'Direct local binary execution with custom launch arguments, Metal HUD & environment overrides',
        'Local playtime tracking inside One Launcher',
      ],
      excludedOrTradeoffs: [
        'Steam Achievements / Trophies DO NOT work while Steam is bypassed',
        'Steam Cloud Saves DO NOT sync before launch or after exit',
        'Shift+Tab Overlay, Friends Co-op Invites, Steam Input & Workshop Mods are disabled',
        'Games with SteamStub / Denuvo DRM or EAC / BattlEye / VAC anti-cheat may refuse to launch',
      ],
    };
  } else if (selectedNativeSteamValue === 'default_client') {
    nativeSteamInfoBox = {
      policyKey: 'default_client',
      cardHeading,
      severity: 'info',
      badgeLabel: 'Standard Footprint • Full Steam UI',
      headline: 'Standard Steam Desktop Client (Full Window Kept Open)',
      footprintSummary:
        'Full Steam desktop client & Chromium webhelpers remain open (~400–800 MB RAM) during and after gameplay.',
      includedFeatures: [
        'Two-way Steam Cloud Save Sync (pre-launch download + post-exit upload)',
        'Live Steam Achievements / Trophies, Shift+Tab Overlay, Friends Co-op Invites & Steam Input',
        'Full Steamworks DRM, Workshop Mods & Anti-Cheat (VAC / EAC / BattlEye) compatibility',
      ],
      excludedOrTradeoffs: [
        'Highest background RAM & Chromium webhelper footprint while playing',
        'Steam desktop window stays open on your desktop after exiting the game',
      ],
    };
  } else if (selectedNativeSteamValue === 'minimal_keep_running') {
    nativeSteamInfoBox = {
      policyKey: 'minimal_keep_running',
      cardHeading,
      severity: 'info',
      badgeLabel: 'Reduced Footprint • Silent Background Steam',
      headline: `Silent Background Steam — Kept Warm in ${trayOrMenuLabel}`,
      footprintSummary: `Boots Steam silently in the ${trayOrMenuLabel} (-silent -nofriendsui -nochatui) and keeps it warm between sessions.`,
      includedFeatures: [
        'Two-way Steam Cloud Save Sync (pre-launch download + post-exit upload)',
        'Live Steam Achievements / Trophies, Steam Input, Workshop Mods & Steamworks DRM',
        'Instant subsequent Steam game launches without cold-booting Steam again',
      ],
      excludedOrTradeoffs: [
        `Background Steam process remains resident in the ${trayOrMenuLabel} after exit (~200–400 MB RAM)`,
      ],
    };
  } else {
    nativeSteamInfoBox = {
      policyKey: 'minimal_and_close_if_started',
      cardHeading,
      severity: 'optimal',
      badgeLabel: 'Recommended • Cloud Sync + Auto-Close',
      headline: 'Silent Background Steam + Auto-Close on Exit',
      footprintSummary:
        'Launches Steam silently with suppressed UI flags and automatically shuts Steam down after Cloud Save upload finishes (if One Launcher started it).',
      includedFeatures: [
        'Two-way Steam Cloud Save Sync (verified post-exit upload before Steam closes)',
        'Live Steam Achievements / Trophies, Steam Input, Workshop Mods & Steamworks DRM',
        '0 MB post-game Steam footprint when Steam was not already running beforehand',
      ],
      excludedOrTradeoffs: [
        'Uses ~200–400 MB background Steam RAM only while the game is actively running',
      ],
    };
  }

  return {
    cardHeading,
    isBottleContext: false,
    showDropdown: true,
    dropdownOptions: nativeSteamOptions,
    selectedDropdownValue: selectedNativeSteamValue,
    infoBox: nativeSteamInfoBox,
  };
}

export const buildStorefrontLaunchPolicyConfig = buildStorefrontLaunchPolicyView;

export interface BuildEffectiveLaunchModePreviewParams {
  game: CanonicalGame;
  hostPlatform: 'darwin' | 'win32' | 'linux';
  preferredPlatformId?: StorefrontId;
  baseConfig?: GameLaunchConfig;
  savedConfig?: GameLaunchConfig;
  draftConfig?: Partial<GameLaunchConfig>;
  installedRecord?: InstalledGameRecord;
  effPlatform?: GamePlatformOwnership;
  layers: CompatibilityLayerInfo[];
  cachedInstallInfo?: GameInstallInfo;
  globalStorefrontLifecycle: StorefrontClientLifecyclePolicy;
  installedStorefrontClients?: Partial<Record<StorefrontId, boolean>>;
}

export type BuildLaunchModePreviewParams = BuildEffectiveLaunchModePreviewParams;

export function buildEffectiveLaunchModePreview(
  params: BuildEffectiveLaunchModePreviewParams
): ResolvedLaunchModePreview {
  const {
    game,
    hostPlatform,
    preferredPlatformId,
    baseConfig,
    savedConfig,
    draftConfig,
    installedRecord,
    effPlatform,
    layers,
    cachedInstallInfo,
    globalStorefrontLifecycle,
    installedStorefrontClients,
  } = params;

  const targetPlatformId =
    preferredPlatformId ||
    draftConfig?.preferredPlatformId ||
    baseConfig?.preferredPlatformId;
  const mergedDraft = { ...savedConfig, ...draftConfig };

  const hasCustomExecKeyInDraft =
    draftConfig !== undefined && 'customExecutablePath' in draftConfig;
  const effectiveRecordExec =
    installedRecord?.runner === 'custom' &&
    hasCustomExecKeyInDraft &&
    !draftConfig?.customExecutablePath
      ? undefined
      : installedRecord?.executablePath;
  const effectiveRecordInstallPath =
    installedRecord?.runner === 'custom' &&
    hasCustomExecKeyInDraft &&
    !draftConfig?.customExecutablePath
      ? undefined
      : installedRecord?.installPath;

  const customExecPath =
    (draftConfig?.customExecutablePath?.trim() || undefined) ||
    (!hasCustomExecKeyInDraft ? savedConfig?.customExecutablePath : undefined);

  const executablePath =
    customExecPath ||
    effectiveRecordExec ||
    effPlatform?.executablePath;

  const installPath =
    effectiveRecordInstallPath || effPlatform?.installPath;

  const isInstalled = Boolean(
    executablePath || installPath || effPlatform?.installed
  );

  const platformId: StorefrontId =
    targetPlatformId ||
    installedRecord?.platformId ||
    effPlatform?.platformId ||
    (game?.steamAppId ? 'steam' : 'custom');

  const storeName =
    platformId === 'steam'
      ? 'Steam'
      : platformId === 'epic'
        ? 'Epic Games'
        : platformId === 'gog'
          ? 'GOG Galaxy'
          : 'Storefront';
  const storeProtocol =
    platformId === 'steam'
      ? 'steam://'
      : platformId === 'epic'
        ? 'com.epicgames.launcher://'
        : platformId === 'gog'
          ? 'goggalaxy://'
          : 'storefront URI';

  const isClientInstalled: boolean | undefined =
    platformId !== 'custom' ? installedStorefrontClients?.[platformId] : undefined;
  const missingClientDisabledReason =
    isClientInstalled === false
      ? platformId === 'epic'
        ? 'Epic Games Launcher is not installed on this system.'
        : platformId === 'gog'
          ? 'GOG Galaxy is not installed on this system.'
          : 'Steam desktop client is not installed on this system.'
      : undefined;

  const selectedLayerType = sanitizeLegacyCompatLayer(mergedDraft.compatibilityLayer);
  const activeLayer =
    (selectedLayerType && selectedLayerType !== 'native'
      ? layers.find((l) => l.type === selectedLayerType)
      : undefined) ||
    layers.find(
      (l) => l.type === 'crossover' || l.type === 'crossover_preview'
    ) ||
    layers[0];
  const layerName =
    activeLayer?.name ||
    (selectedLayerType && selectedLayerType !== 'native'
      ? COMPATIBILITY_RUNNER_DESCRIPTORS.find((d) => d.type === selectedLayerType)?.shortLabel ||
        selectedLayerType
      : 'CrossOver / Wine');
  const bottleName =
    mergedDraft.wineBottleName || activeLayer?.availableBottles?.[0];

  let hasMacInstaller = false;
  let hasWinInstaller = true;
  if (
    cachedInstallInfo?.availableInstallers &&
    cachedInstallInfo.availableInstallers.length > 0
  ) {
    hasMacInstaller = cachedInstallInfo.availableInstallers.some((i) => i.os === 'mac');
    hasWinInstaller = cachedInstallInfo.availableInstallers.some((i) => i.os === 'windows');
  } else {
    const storeFlags = game
      ? getStorefrontNativeOsFlags(game, platformId)
      : { windows: true, mac: false, isExplicit: false };
    hasMacInstaller = storeFlags.mac;
    hasWinInstaller = storeFlags.windows;
  }
  const hasDualMacAndWinBuild = hasMacInstaller && hasWinInstaller;
  const isKnownMacOnly = hasMacInstaller && !hasWinInstaller;
  const isKnownWinOnlyOnMac = hasWinInstaller && !hasMacInstaller;

  let detectedBuildType: ResolvedLaunchModePreview['detectedBuildType'] =
    'not_installed';
  let detectedBuildLabel = 'Not Installed Locally';
  let detectedBuildDetail =
    'Install this game first or link an existing executable below.';

  if (!isInstalled) {
    detectedBuildType = 'not_installed';
    if (hostPlatform !== 'win32') {
      if (hasDualMacAndWinBuild) {
        detectedBuildLabel =
          'Not Installed Locally • Native macOS (Recommended) & Windows Builds Available';
        detectedBuildDetail = `Both a Native macOS build (Recommended) and a Windows build (via ${layerName} translation) are available on ${storeName}.`;
      } else if (isKnownWinOnlyOnMac) {
        detectedBuildLabel = 'Not Installed Locally • Windows Build (CrossOver / Wine)';
        detectedBuildDetail =
          'Install this Windows build via One Launcher (or pre-configure CrossOver / Wine below) or link an existing executable.';
      } else if (isKnownMacOnly) {
        detectedBuildLabel = 'Not Installed Locally • Native macOS Build';
        detectedBuildDetail =
          'Install this native macOS build via One Launcher or link an existing .app bundle below.';
      } else {
        detectedBuildLabel = 'Not Installed Locally';
        detectedBuildDetail =
          'Install this game first or link an existing executable below.';
      }
    } else {
      detectedBuildLabel = 'Not Installed Locally';
      detectedBuildDetail =
        'Install this game first or link an existing executable below.';
    }
  } else if (hostPlatform === 'win32') {
    detectedBuildType = 'windows_native';
    detectedBuildLabel = 'Windows Native Build (.exe)';
    detectedBuildDetail =
      executablePath || installPath || 'Installed on Windows';
  } else {
    const isExplicitAppBundle = Boolean(
      (executablePath && /\.app(\/|$)/i.test(executablePath)) ||
        (!executablePath && installPath && /\.app(\/|$)/i.test(installPath))
    );
    const isBottlePath = /(?:^|[\\/])(Bottles|drive_c)(?:[\\/]|$)/i.test(
      String(executablePath || installPath || '')
    );
    const hasExplicitWinFlag =
      installedRecord?.isWindowsBinaryOnMac !== undefined
        ? installedRecord.isWindowsBinaryOnMac
        : effPlatform?.isWindowsBinaryOnMac;
    const isExeOnMac =
      Boolean(executablePath && /\.(exe|bat|msi)$/i.test(executablePath)) ||
      (!isExplicitAppBundle &&
        (Boolean(hasExplicitWinFlag) ||
          isBottlePath ||
          (!executablePath && hasExplicitWinFlag !== false && isKnownWinOnlyOnMac)));

    if (isExeOnMac) {
      detectedBuildType = 'windows_exe_on_mac';
      detectedBuildLabel = 'Windows Build (.exe) on macOS';
      detectedBuildDetail =
        'Requires CrossOver / Wine translation layer on Apple Silicon';
    } else if (isExplicitAppBundle) {
      detectedBuildType = 'mac_native_app';
      detectedBuildLabel = 'macOS Native App Bundle (.app)';
      detectedBuildDetail =
        'Runs natively on macOS without translation layers';
    } else {
      detectedBuildType = 'mac_native_bin';
      detectedBuildLabel = 'macOS Native Binary';
      detectedBuildDetail = 'Runs natively on macOS';
    }
  }

  const rawConfiguredLaunchMethod: LaunchMethod = sanitizeLaunchMethod(
    draftConfig?.launchMethod || savedConfig?.launchMethod || 'auto'
  );
  const isBottlePreviewContext =
    hostPlatform !== 'win32' &&
    (detectedBuildType === 'windows_exe_on_mac' ||
      rawConfiguredLaunchMethod === 'compatibility_layer');
  const rawLifecycleOverride = sanitizeStorefrontLifecycleOverride(
    draftConfig?.storefrontClientLifecycle ?? savedConfig?.storefrontClientLifecycle,
    isBottlePreviewContext ? undefined : platformId
  );

  const isNativeBuild =
    detectedBuildType === 'mac_native_app' ||
    detectedBuildType === 'mac_native_bin' ||
    detectedBuildType === 'windows_native';

  let availableModes: LaunchMethod[];
  let defaultLaunchMethod: LaunchMethod;

  if (isNativeBuild) {
    if (platformId === 'custom') {
      availableModes = ['direct'];
      defaultLaunchMethod = 'direct';
    } else if (platformId === 'steam') {
      availableModes = ['storefront_uri', 'direct'];
      defaultLaunchMethod = 'storefront_uri';
    } else {
      availableModes = ['direct', 'storefront_uri'];
      defaultLaunchMethod = 'direct';
    }
  } else if (detectedBuildType === 'windows_exe_on_mac') {
    availableModes = ['auto', 'compatibility_layer'];
    defaultLaunchMethod = 'auto';
  } else {
    // not_installed
    defaultLaunchMethod = 'auto';
    if (hostPlatform === 'win32') {
      availableModes =
        rawConfiguredLaunchMethod === 'direct' ? ['auto', 'direct'] : ['auto'];
    } else if (isKnownMacOnly) {
      availableModes =
        rawConfiguredLaunchMethod === 'direct' ? ['auto', 'direct'] : ['auto'];
    } else {
      availableModes =
        rawConfiguredLaunchMethod === 'direct'
          ? ['auto', 'compatibility_layer', 'direct']
          : ['auto', 'compatibility_layer'];
    }
  }

  let activeMode: LaunchMethod =
    rawConfiguredLaunchMethod !== 'auto' &&
    availableModes.includes(rawConfiguredLaunchMethod)
      ? rawConfiguredLaunchMethod
      : availableModes.includes(rawConfiguredLaunchMethod) && !isNativeBuild
        ? rawConfiguredLaunchMethod
        : defaultLaunchMethod;

  if (
    activeMode === 'storefront_uri' &&
    isClientInstalled === false &&
    (platformId === 'gog' || platformId === 'epic')
  ) {
    activeMode = 'direct';
  }

  const policyConfiguredLaunchMethod: LaunchMethod = isNativeBuild
    ? activeMode
    : rawConfiguredLaunchMethod;

  const resolvedPolicy = resolveEffectiveLaunchPolicy({
    platformId,
    hostPlatform,
    detectedBuildType,
    isInstalled,
    hasExecutable: Boolean(executablePath),
    hasCustomExecutable: Boolean(customExecPath),
    executablePath,
    installPath,
    configuredLaunchMethod: policyConfiguredLaunchMethod,
    storefrontClientLifecycle: rawLifecycleOverride,
    globalStorefrontLifecycle,
  });

  const isLifecycleFastBypass = resolvedPolicy.effectiveLifecycle === 'fast_direct_bypass';
  const isFastDirectActive = resolvedPolicy.isFastDirectBypass;
  const effectiveCompatLayer: CompatibilityLayerType =
    sanitizeLegacyCompatLayer(draftConfig?.compatibilityLayer) ||
    sanitizeLegacyCompatLayer(savedConfig?.compatibilityLayer) ||
    layers[0]?.type ||
    'crossover';

  const isStorefrontUriMode = activeMode === 'storefront_uri';

  let visibleSections: ResolvedLaunchModePreview['visibleSections'];
  if (hostPlatform === 'win32') {
    visibleSections = {
      compatibilityLayer: false,
      crossoverRendering: false,
      nativeMacMetalHud: false,
      executableAndArgs: !isStorefrontUriMode || !isInstalled,
      environmentAndHooks: !isStorefrontUriMode && isInstalled,
    };
  } else if (
    detectedBuildType === 'mac_native_app' ||
    detectedBuildType === 'mac_native_bin'
  ) {
    visibleSections = {
      compatibilityLayer: false,
      crossoverRendering: false,
      nativeMacMetalHud: !isStorefrontUriMode,
      executableAndArgs: !isStorefrontUriMode,
      environmentAndHooks: !isStorefrontUriMode,
    };
  } else if (detectedBuildType === 'windows_exe_on_mac') {
    visibleSections = {
      compatibilityLayer: true,
      crossoverRendering:
        effectiveCompatLayer === 'crossover' ||
        effectiveCompatLayer === 'crossover_preview',
      nativeMacMetalHud: false,
      executableAndArgs: true,
      environmentAndHooks: true,
    };
  } else {
    const showCompatForUninstalled = activeMode === 'compatibility_layer';
    const showNativeMacForUninstalled =
      !showCompatForUninstalled &&
      hasDualMacAndWinBuild &&
      activeMode === 'auto';
    visibleSections = {
      compatibilityLayer: showCompatForUninstalled,
      crossoverRendering:
        showCompatForUninstalled &&
        (effectiveCompatLayer === 'crossover' ||
          effectiveCompatLayer === 'crossover_preview'),
      nativeMacMetalHud: showNativeMacForUninstalled,
      executableAndArgs: true,
      environmentAndHooks: showCompatForUninstalled,
    };
  }

  const storefrontUriDelegationDesc =
    platformId === 'steam'
      ? 'Launches via Steam protocol (steam://rungameid) with silent background Steam, two-way Steam Cloud Save Sync (pre-launch download + post-exit upload), Achievements/Trophies, and Steamworks DRM support (governed by Steam Launch Policy below).'
      : platformId === 'gog'
        ? 'Delegates launch, Cloud Saves, and in-game Overlay directly to the GOG Galaxy desktop client (goggalaxy://launchGame).'
        : platformId === 'epic'
          ? "Delegates launch and Cloud Save Sync to the Epic Games Launcher desktop client (com.epicgames.launcher://) rather than One Launcher's standalone legendary CLI pipeline."
          : `Delegates launch to ${storeName} (${storeProtocol}).`;

  const storefrontUriUninstalledDesc =
    platformId === 'steam'
      ? 'Opens the Steam desktop client (steam://rungameid) and delegates install, launch, and Steam Cloud Sync to Steam.'
      : platformId === 'gog'
        ? "Opens the official GOG Galaxy desktop client (goggalaxy://) and delegates install, launch, and Cloud Save Sync rather than One Launcher's standalone CLI Cloud Save engine."
        : platformId === 'epic'
          ? "Opens the official Epic Games Launcher desktop client (com.epicgames.launcher://) and delegates install, launch, and Cloud Save Sync rather than One Launcher's standalone CLI Cloud Save engine."
          : `Opens ${storeName} (${storeProtocol}) to install or launch the game.`;

  const formatDirectBypassCloudNote = (targetSubject: string, viaContext?: string): string => {
    const viaClause = viaContext ? ` ${viaContext}` : '';
    if (platformId === 'steam') {
      return `Fast Direct Binary Bypass (Minimal Footprint): spawns ${targetSubject} directly${viaClause} without Steam — bypasses Steam Cloud Sync, overlay, and achievements.`;
    }
    if (platformId === 'gog') {
      return `Fast Direct Binary Bypass (Minimal Footprint): spawns ${targetSubject} directly${viaClause} while bypassing GOG Galaxy — still syncs Cloud Saves both ways (pre-launch download + post-exit upload) via One Launcher's standalone gogdl CLI (GOG Achievements/Trophies disabled).`;
    }
    if (platformId === 'epic') {
      return `Clientless EOS Direct Mode: spawns ${targetSubject} directly${viaClause} while bypassing Epic Games Launcher — syncs Cloud Saves both ways (pre-launch download + post-exit upload) via One Launcher's standalone legendary CLI.`;
    }
    return `Spawns ${targetSubject} directly${viaClause} with minimal footprint.`;
  };

  if (detectedBuildType === 'windows_exe_on_mac') {
    const bottleSuffix = bottleName ? ` (Bottle: "${bottleName}")` : '';
    const targetExeLabel = executablePath
      ? executablePath.split(/[\\/]/).pop() || 'the game executable'
      : 'the game executable';

    const bottleAutoDesc =
      platformId === 'custom'
        ? `Automatically runs this Windows (.exe) build through ${layerName}${bottleSuffix} with your configured graphics and bottle settings.`
        : isFastDirectActive
          ? formatDirectBypassCloudNote(targetExeLabel, `via ${layerName}${bottleSuffix}`)
          : platformId === 'steam'
            ? `Silent Client + Cloud Sync: runs via ${layerName}${bottleSuffix} using silent bottle Steam (steam.exe -silent -applaunch) — syncs Steam Cloud Saves both ways (two-stage pre-launch download + post-exit upload) with Achievements & DRM support.`
            : platformId === 'gog'
              ? `Bottle GOG + Cloud Sync: runs via ${layerName}${bottleSuffix} with Bottle GOG Galaxy SDK support (governed by Bottle GOG Launch Policy below) and syncs Cloud Saves both ways (pre-launch download + post-exit upload) via One Launcher's standalone gogdl CLI.`
              : `Bottle Epic + Cloud Sync: runs via ${layerName}${bottleSuffix} with EOS Exchange Code auth, Bottle Epic Launcher support (governed by Bottle Epic Games Store Launch Policy below), and two-way Cloud Save Sync via One Launcher's standalone legendary CLI.`;

    const bottleCompatDesc =
      platformId === 'custom'
        ? `Explicitly pin a specific compatibility runner (${layerName}), target bottle / WinePrefix, and per-game graphics overrides.`
        : isFastDirectActive
          ? platformId === 'steam'
            ? `Pin ${layerName}${bottleSuffix} and graphics overrides using Fast Bottle Direct Bypass — skips bottle Steam and bypasses Steam Cloud Sync, overlay, and achievements.`
            : platformId === 'gog'
              ? `Pin ${layerName}${bottleSuffix} and graphics overrides — bypasses GOG Galaxy while syncing Cloud Saves both ways via standalone gogdl CLI.`
              : `Pin ${layerName}${bottleSuffix} and graphics overrides — bypasses Epic Games Launcher while syncing Cloud Saves both ways via standalone legendary CLI.`
          : platformId === 'steam'
            ? `Pin ${layerName}${bottleSuffix} and graphics overrides with Silent Bottle Steam + Cloud Sync — syncs Steam Cloud Saves both ways (pre-launch download + post-exit upload) via silent bottle Steam.`
            : platformId === 'gog'
              ? `Pin ${layerName}${bottleSuffix} and graphics overrides — syncs Cloud Saves both ways (pre-launch download + post-exit upload) via One Launcher's standalone gogdl CLI.`
              : `Pin ${layerName}${bottleSuffix} and graphics overrides — syncs Cloud Saves both ways (pre-launch download + post-exit upload) via One Launcher's standalone legendary CLI.`;

    const bottleAutoSummary =
      platformId === 'custom'
        ? `Launches Windows executable (.exe) via ${layerName}${bottleSuffix}.`
        : isFastDirectActive
          ? platformId === 'steam'
            ? `Launches Windows executable (.exe) via ${layerName}${bottleSuffix} using Fast Direct Binary Bypass (bypasses bottle Steam & Steam Cloud Sync).`
            : platformId === 'gog'
              ? `Launches Windows executable (.exe) via ${layerName}${bottleSuffix} using Fast Direct Binary Bypass (syncs Cloud Saves both ways via standalone gogdl CLI).`
              : `Launches Windows executable (.exe) via ${layerName}${bottleSuffix} in clientless EOS mode (syncs Cloud Saves both ways via standalone legendary CLI).`
          : platformId === 'steam'
            ? `Launches Windows executable (.exe) via ${layerName}${bottleSuffix} — syncs Steam Cloud Saves both ways (pre-launch download + post-exit upload) via silent bottle Steam.`
            : platformId === 'gog'
              ? `Launches Windows executable (.exe) via ${layerName}${bottleSuffix} — syncs Cloud Saves both ways (pre-launch download + post-exit upload) via standalone gogdl CLI.`
              : `Launches Windows executable (.exe) via ${layerName}${bottleSuffix} — syncs Cloud Saves both ways (pre-launch download + post-exit upload) via standalone legendary CLI.`;

    return {
      isInstalled,
      hostPlatform,
      platformId,
      installPath,
      executablePath,
      detectedBuildType,
      detectedBuildLabel,
      detectedBuildDetail,
      hasDualMacAndWinBuild,
      autoResolvedMethod: resolvedPolicy.autoResolvedMethod,
      autoResolvedSummary: bottleAutoSummary,
      defaultLaunchMethod,
      recommendedModes: ['auto', 'compatibility_layer'],
      availableModes,
      resolvedPolicy,
      visibleSections,
      modeNotes: {
        auto: {
          badge: 'Recommended',
          badgeTone: 'emerald',
          dynamicDesc: bottleAutoDesc,
        },
        custom: {
          badge: 'Legacy',
          badgeTone: 'slate',
          dynamicDesc: bottleAutoDesc,
        },
        compatibility_layer: {
          badge: 'Custom Runner & Bottle',
          badgeTone: 'sky',
          dynamicDesc: bottleCompatDesc,
        },
        direct: {
          badge: 'Requires Translation',
          badgeTone: 'amber',
          dynamicDesc: formatDirectBypassCloudNote(
            targetExeLabel,
            `inside ${layerName}${bottleSuffix}`
          ),
          warning: `macOS cannot execute Windows .exe binaries natively without Wine/CrossOver, so One Launcher will automatically invoke ${layerName} in Fast Direct Binary Bypass mode if selected.`,
        },
        storefront_uri: {
          badge: isClientInstalled === false ? 'Client Not Installed' : 'Caution on macOS',
          badgeTone: isClientInstalled === false ? 'slate' : 'amber',
          dynamicDesc: storefrontUriDelegationDesc,
          warning: `Native macOS storefront clients (such as macOS Steam) cannot launch Windows-only .exe builds directly. Use Auto-Detect or Compatibility Layer instead.`,
          ...(isClientInstalled === false
            ? { disabled: true, disabledReason: missingClientDisabledReason }
            : {}),
        },
      },
    };
  }

  if (
    detectedBuildType === 'mac_native_app' ||
    detectedBuildType === 'mac_native_bin'
  ) {
    const targetName =
      executablePath
        ?.split(/[\\/]/)
        .find((part) => /\.app$/i.test(part)) ||
      executablePath?.split(/[\\/]/).pop() ||
      'native macOS binary';
    const macSubject = `the local macOS ${detectedBuildType === 'mac_native_app' ? '.app bundle' : 'binary'} (${targetName})`;

    const macDirectNote: ResolvedLaunchModePreview['modeNotes']['direct'] =
      platformId === 'steam'
        ? {
            badge: 'Native macOS',
            badgeTone: 'amber',
            dynamicDesc: `Fast Direct Launch: spawns ${macSubject} directly without Steam — enables custom launch arguments, Apple Metal HUD, and environment overrides, but bypasses Steam Cloud Save Sync, Achievements/Trophies, and Steamworks DRM.`,
          }
        : platformId === 'epic'
          ? {
              badge: 'Recommended',
              badgeTone: 'emerald',
              dynamicDesc: `Launches ${macSubject} directly in clientless EOS Exchange Code mode with two-way Cloud Save Sync (pre-launch download + post-exit upload) via standalone legendary CLI and 0 MB Epic Launcher overhead.`,
            }
          : platformId === 'gog'
            ? {
                badge: 'Recommended',
                badgeTone: 'emerald',
                dynamicDesc: isFastDirectActive
                  ? `Launches ${macSubject} directly with Fast Direct Bypass — preserves two-way gogdl Cloud Save Sync while skipping GOG Galaxy (Achievements/Trophies disabled; governed by GOG Galaxy Launch Policy below).`
                  : `Launches ${macSubject} directly while preserving two-way gogdl Cloud Save Sync and silent GOG Galaxy SDK Trophies/Achievements (governed by GOG Galaxy Launch Policy below).`,
              }
            : {
                badge: 'Recommended',
                badgeTone: 'emerald',
                dynamicDesc: `Spawns ${macSubject} directly with minimal footprint and zero background storefront overhead.`,
              };

    const macStorefrontUriNote: ResolvedLaunchModePreview['modeNotes']['storefront_uri'] =
      platformId === 'steam'
        ? {
            badge: isClientInstalled === false ? 'Client Not Installed' : 'Recommended',
            badgeTone: isClientInstalled === false ? 'slate' : 'emerald',
            dynamicDesc: storefrontUriDelegationDesc,
            ...(isClientInstalled === false
              ? { disabled: true, disabledReason: missingClientDisabledReason }
              : {}),
          }
        : platformId === 'gog'
          ? {
              badge: isClientInstalled === false ? 'Client Not Installed' : 'GOG Galaxy Client',
              badgeTone: isClientInstalled === false ? 'slate' : 'sky',
              dynamicDesc: storefrontUriDelegationDesc,
              disabled: isClientInstalled === false,
              disabledReason: missingClientDisabledReason,
            }
          : {
              badge: isClientInstalled === false ? 'Client Not Installed' : 'Store Client',
              badgeTone: isClientInstalled === false ? 'slate' : 'sky',
              dynamicDesc: storefrontUriDelegationDesc,
              disabled: isClientInstalled === false,
              disabledReason: missingClientDisabledReason,
            };

    const macAutoResolvedSummary =
      activeMode === 'storefront_uri'
        ? platformId === 'steam'
          ? 'Launches via Steam protocol (steam://rungameid) with silent background Steam and bidirectional Steam Cloud Sync.'
          : platformId === 'gog'
            ? 'Delegates launch and Cloud Save Sync to the GOG Galaxy desktop client (goggalaxy://launchGame).'
            : `Delegates launch and Cloud Save Sync to ${storeName} (${storeProtocol}).`
        : platformId === 'steam'
          ? `Launches native macOS ${detectedBuildType === 'mac_native_app' ? `app bundle (${targetName})` : `binary (${targetName})`} directly (Fast Direct Bypass — bypasses Steam Cloud Sync & Achievements).`
          : platformId === 'gog'
            ? isFastDirectActive
              ? `Launches native macOS ${detectedBuildType === 'mac_native_app' ? `app bundle (${targetName})` : `binary (${targetName})`} directly (Fast Direct Bypass — syncs Cloud Saves both ways via standalone gogdl CLI).`
              : `Launches native macOS ${detectedBuildType === 'mac_native_app' ? `app bundle (${targetName})` : `binary (${targetName})`} directly with bidirectional standalone gogdl Cloud Save Sync.`
            : platformId === 'epic'
              ? `Launches native macOS ${detectedBuildType === 'mac_native_app' ? `app bundle (${targetName})` : `binary (${targetName})`} directly in clientless EOS mode with bidirectional standalone legendary Cloud Save Sync.`
              : detectedBuildType === 'mac_native_app'
                ? `Launches native macOS app bundle (${targetName}) directly via macOS LaunchServices (open -a).`
                : `Launches native macOS binary (${targetName}) directly without translation layers.`;

    return {
      isInstalled,
      hostPlatform,
      platformId,
      installPath,
      executablePath,
      detectedBuildType,
      detectedBuildLabel,
      detectedBuildDetail,
      hasDualMacAndWinBuild,
      autoResolvedMethod: resolvedPolicy.autoResolvedMethod,
      autoResolvedSummary: macAutoResolvedSummary,
      defaultLaunchMethod,
      recommendedModes: [defaultLaunchMethod],
      availableModes,
      resolvedPolicy,
      visibleSections,
      modeNotes: {
        auto: {
          badge: 'Recommended',
          badgeTone: 'emerald',
          dynamicDesc:
            defaultLaunchMethod === 'storefront_uri'
              ? macStorefrontUriNote.dynamicDesc
              : macDirectNote.dynamicDesc,
        },
        custom: {
          badge: 'Legacy',
          badgeTone: 'slate',
          dynamicDesc: macDirectNote.dynamicDesc,
        },
        direct: macDirectNote,
        compatibility_layer: {
          badge: 'Not Needed',
          badgeTone: 'amber',
          dynamicDesc: `Routes execution through Wine / CrossOver translation (${isFastDirectActive ? 'Fast Direct Binary Bypass' : 'Silent Client + Cloud Sync'}).`,
          warning: `This is already a native macOS build and does not need Wine/CrossOver translation unless you explicitly override the executable to a Windows .exe.`,
        },
        storefront_uri: macStorefrontUriNote,
      },
    };
  }

  if (detectedBuildType === 'windows_native') {
    const exeName = executablePath?.split(/[\\/]/).pop();
    const winTargetLabel = exeName || 'the native Windows executable';

    const winDirectNote: ResolvedLaunchModePreview['modeNotes']['direct'] =
      platformId === 'steam'
        ? {
            badge: 'Direct Binary',
            badgeTone: 'amber',
            dynamicDesc: `Fast Direct Launch: spawns ${winTargetLabel} directly without Steam — enables custom launch arguments and environment overrides, but bypasses Steam Cloud Save Sync, Achievements/Trophies, and Steamworks DRM.`,
          }
        : platformId === 'epic'
          ? {
              badge: 'Recommended',
              badgeTone: 'emerald',
              dynamicDesc: `Launches ${winTargetLabel} directly in clientless EOS Exchange Code mode with two-way Cloud Save Sync (pre-launch download + post-exit upload) via standalone legendary CLI and 0 MB Epic Launcher overhead.`,
            }
          : platformId === 'gog'
            ? {
                badge: 'Recommended',
                badgeTone: 'emerald',
                dynamicDesc: isFastDirectActive
                  ? `Launches ${winTargetLabel} directly with Fast Direct Bypass — preserves two-way gogdl Cloud Save Sync while skipping GOG Galaxy (Achievements/Trophies disabled; governed by GOG Galaxy Launch Policy below).`
                  : `Launches ${winTargetLabel} directly while preserving two-way gogdl Cloud Save Sync and silent GOG Galaxy SDK Trophies/Achievements (governed by GOG Galaxy Launch Policy below).`,
              }
            : {
                badge: 'Recommended',
                badgeTone: 'emerald',
                dynamicDesc: `Directly spawns ${winTargetLabel} with custom launch arguments and environment variables.`,
              };

    const winStorefrontUriNote: ResolvedLaunchModePreview['modeNotes']['storefront_uri'] =
      platformId === 'steam'
        ? {
            badge: isClientInstalled === false ? 'Client Not Installed' : 'Recommended',
            badgeTone: isClientInstalled === false ? 'slate' : 'emerald',
            dynamicDesc: storefrontUriDelegationDesc,
            ...(isClientInstalled === false
              ? { disabled: true, disabledReason: missingClientDisabledReason }
              : {}),
          }
        : platformId === 'gog'
          ? {
              badge: isClientInstalled === false ? 'Client Not Installed' : 'GOG Galaxy Client',
              badgeTone: isClientInstalled === false ? 'slate' : 'sky',
              dynamicDesc: storefrontUriDelegationDesc,
              disabled: isClientInstalled === false,
              disabledReason: missingClientDisabledReason,
            }
          : {
              badge: isClientInstalled === false ? 'Client Not Installed' : 'Store Client',
              badgeTone: isClientInstalled === false ? 'slate' : 'sky',
              dynamicDesc: storefrontUriDelegationDesc,
              disabled: isClientInstalled === false,
              disabledReason: missingClientDisabledReason,
            };

    const winAutoResolvedSummary =
      activeMode === 'storefront_uri' || !executablePath
        ? platformId === 'steam'
          ? 'Launches via Steam protocol (steam://rungameid) with silent background Steam and bidirectional Steam Cloud Sync.'
          : platformId === 'gog'
            ? 'Delegates launch and Cloud Save Sync to the GOG Galaxy desktop client (goggalaxy://launchGame).'
            : `Launches via ${storeName} client protocol (${storeProtocol}).`
        : platformId === 'steam'
          ? `Launches native Windows executable (${exeName}) directly (Fast Direct Bypass — bypasses Steam Cloud Sync & Achievements).`
          : platformId === 'gog'
            ? isFastDirectActive
              ? `Launches native Windows executable (${exeName}) directly (Fast Direct Bypass — syncs Cloud Saves both ways via standalone gogdl CLI).`
              : `Launches native Windows executable (${exeName}) directly with bidirectional standalone gogdl Cloud Save Sync.`
            : platformId === 'epic'
              ? `Launches native Windows executable (${exeName}) directly in clientless EOS mode with bidirectional standalone legendary Cloud Save Sync.`
              : `Launches native Windows executable (${exeName}) directly.`;

    return {
      isInstalled,
      hostPlatform,
      platformId,
      installPath,
      executablePath,
      detectedBuildType,
      detectedBuildLabel,
      detectedBuildDetail,
      hasDualMacAndWinBuild,
      autoResolvedMethod: resolvedPolicy.autoResolvedMethod,
      autoResolvedSummary: winAutoResolvedSummary,
      defaultLaunchMethod,
      recommendedModes: [defaultLaunchMethod],
      availableModes,
      resolvedPolicy,
      visibleSections,
      modeNotes: {
        auto: {
          badge: 'Recommended',
          badgeTone: 'emerald',
          dynamicDesc:
            defaultLaunchMethod === 'storefront_uri'
              ? winStorefrontUriNote.dynamicDesc
              : winDirectNote.dynamicDesc,
        },
        custom: {
          badge: 'Legacy',
          badgeTone: 'slate',
          dynamicDesc: winDirectNote.dynamicDesc,
        },
        direct: winDirectNote,
        compatibility_layer: {
          badge: 'Not Needed',
          badgeTone: 'slate',
          dynamicDesc: `Wine / CrossOver translation layer for non-Windows hosts (${isFastDirectActive ? 'Fast Direct Binary Bypass' : 'Silent Client + Cloud Sync'}).`,
          warning: `Compatibility layers are not required on native Windows hosts.`,
        },
        storefront_uri: winStorefrontUriNote,
      },
    };
  }

  // not_installed
  const isDualBuildMacPreview = hostPlatform !== 'win32' && hasDualMacAndWinBuild;
  const preInstallCloudDesc =
    platformId === 'steam'
      ? isLifecycleFastBypass
        ? 'Fast Direct Binary Bypass (bypasses Steam Cloud Sync)'
        : 'bidirectional Steam Cloud Sync (pre-launch download + post-exit upload)'
      : platformId === 'gog'
        ? 'bidirectional standalone gogdl Cloud Save Sync (pre-launch download + post-exit upload)'
        : platformId === 'epic'
          ? 'bidirectional standalone legendary Cloud Save Sync (pre-launch download + post-exit upload)'
          : 'Silent Client + Cloud Sync';

  return {
    isInstalled: false,
    hostPlatform,
    platformId,
    installPath,
    executablePath,
    detectedBuildType: 'not_installed',
    detectedBuildLabel,
    detectedBuildDetail,
    hasDualMacAndWinBuild,
    autoResolvedMethod: resolvedPolicy.autoResolvedMethod,
    autoResolvedSummary:
      'Game is not installed locally yet. Install via One Launcher or link an existing executable below.',
    defaultLaunchMethod,
    recommendedModes: ['auto', 'storefront_uri'],
    availableModes,
    resolvedPolicy,
    visibleSections,
    modeNotes: {
      auto: isDualBuildMacPreview
        ? {
            badge: 'Recommended • Native macOS',
            badgeTone: 'emerald',
            dynamicDesc: isLifecycleFastBypass
              ? `Installs the official Native macOS build and launches via Fast Direct Binary Bypass with ${preInstallCloudDesc} and zero translation overhead.`
              : `Installs and launches the official Native macOS build automatically with ${preInstallCloudDesc} and zero translation overhead.`,
          }
        : {
            badge: 'Recommended',
            badgeTone: 'emerald',
            dynamicDesc: isLifecycleFastBypass
              ? `Automatically selects the optimal native or CrossOver pipeline using Fast Direct Binary Bypass with ${preInstallCloudDesc} once installed or linked.`
              : `Automatically selects the optimal native or CrossOver pipeline with ${preInstallCloudDesc} once installed or linked.`,
          },
      custom: {
        badge: 'Legacy',
        badgeTone: 'slate',
        dynamicDesc: `Automatically selects the optimal launch pipeline with ${preInstallCloudDesc} once installed or linked.`,
      },
      direct: {
        badge: 'Requires Executable',
        badgeTone: 'amber',
        dynamicDesc: formatDirectBypassCloudNote('a local game binary'),
        warning:
          'No local installation detected yet. Link a custom executable path below to use Direct Executable mode.',
      },
      compatibility_layer: isDualBuildMacPreview
        ? {
            badge: 'Windows Translation',
            badgeTone: 'sky',
            dynamicDesc: `Use the Windows (.exe) build via ${layerName} with ${preInstallCloudDesc} instead of the native macOS build — pre-configure runner, bottle, and graphics settings.`,
          }
        : {
            badge: 'Pre-Configure',
            badgeTone: 'sky',
            dynamicDesc: `Pre-configure ${layerName} bottle, CrossOver 26 graphics backend, and ${preInstallCloudDesc} before installing or linking a Windows .exe.`,
          },
      storefront_uri: {
        badge: isClientInstalled === false ? 'Client Not Installed' : 'Store Fallback',
        badgeTone: isClientInstalled === false ? 'slate' : 'sky',
        dynamicDesc: storefrontUriUninstalledDesc,
        ...(isClientInstalled === false
          ? { disabled: true, disabledReason: missingClientDisabledReason }
          : {}),
      },
    },
  };
}
