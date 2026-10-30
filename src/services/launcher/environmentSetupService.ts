import type {
  BottleEnvironmentSummary,
  ClientAuthProbeState,
  ClientLoginTargetId,
  EnvironmentComponentId,
  EnvironmentComponentState,
  EnvironmentHealthSnapshot,
  EnvironmentSetupProgressEvent,
  EnvironmentSetupTaskRequest,
  GuidedClientLoginResult,
  RunEnvironmentSetupRequest,
  RunEnvironmentSetupResult,
  SetupWizardOpenMode,
  SetupWizardPersistedState,
  SetupWizardStepId,
  StartGuidedClientLoginRequest,
} from '../../contracts/environmentSetup';
import type { CompatibilityLayerType } from '../../contracts/launcher';
import type { StorefrontId } from '../../contracts/platform';
import { launcherService } from './launcherService';

export const WIZARD_STATE_STORAGE_KEY = 'one_launcher_setup_wizard_state_v1';
export const OPEN_SYSTEM_SETUP_EVENT = 'antigravity:open-system-setup';
export const MAX_SETUP_PROGRESS_HISTORY = 100;

export interface OpenSystemSetupEventDetail {
  mode?: SetupWizardOpenMode;
  initialStep?: SetupWizardStepId;
  focusComponentId?: EnvironmentComponentId;
}

export interface ComputeDefaultSelectedOptions {
  chosenRunner?: Exclude<CompatibilityLayerType, 'native'> | 'skip';
}

export interface BuildProvisioningTasksParams {
  snapshot: EnvironmentHealthSnapshot;
  selectedIds: ReadonlySet<EnvironmentComponentId>;
  chosenRunner: Exclude<CompatibilityLayerType, 'native'> | 'skip';
  bottleMode: 'reuse_existing' | 'create_dedicated';
  bottleName: string;
  gptkDmgPath?: string;
  forceRepairIds?: ReadonlySet<EnvironmentComponentId>;
}

export interface ShouldAutoOpenSetupWizardParams {
  wizardState: SetupWizardPersistedState | null;
  connectedStorefrontsCount: number;
  catalogGamesCount: number;
  isElectronRuntime: boolean;
}

const ALL_ENVIRONMENT_COMPONENT_IDS: ReadonlySet<EnvironmentComponentId> = new Set([
  'rosetta2',
  'win_vcredist',
  'win_webview2',
  'runner_crossover',
  'runner_crossover_preview',
  'runner_wine',
  'runner_gptk',
  'bottle_default',
  'host_steam',
  'bottle_steam',
  'host_gog',
  'bottle_gog',
  'host_epic',
  'bottle_epic',
  'xbox_runtime',
]);

const VALID_PREFERRED_RUNNERS: ReadonlySet<
  Exclude<CompatibilityLayerType, 'native'> | 'skip'
> = new Set(['crossover', 'crossover_preview', 'gptk', 'wine', 'skip']);

const RUNNER_COMPONENT_TO_TYPE: ReadonlyArray<{
  componentId: Extract<
    EnvironmentComponentId,
    'runner_crossover' | 'runner_crossover_preview' | 'runner_wine' | 'runner_gptk'
  >;
  runnerType: Exclude<CompatibilityLayerType, 'native'>;
}> = [
  { componentId: 'runner_crossover', runnerType: 'crossover' },
  { componentId: 'runner_crossover_preview', runnerType: 'crossover_preview' },
  { componentId: 'runner_wine', runnerType: 'wine' },
  { componentId: 'runner_gptk', runnerType: 'gptk' },
];

const HOST_CLIENT_ORDER: ReadonlyArray<
  Extract<EnvironmentComponentId, 'host_steam' | 'host_gog' | 'host_epic'>
> = ['host_steam', 'host_gog', 'host_epic'];

const BOTTLE_CLIENT_ORDER: ReadonlyArray<
  Extract<EnvironmentComponentId, 'bottle_steam' | 'bottle_gog' | 'bottle_epic'>
> = ['bottle_steam', 'bottle_gog', 'bottle_epic'];

const CLIENT_LOGIN_TARGET_IDS: ReadonlySet<ClientLoginTargetId> = new Set([
  'host_steam',
  'bottle_steam',
  'host_gog',
  'bottle_gog',
  'host_epic',
  'bottle_epic',
]);

function isValidComponentId(value: unknown): value is EnvironmentComponentId {
  return (
    typeof value === 'string' &&
    ALL_ENVIRONMENT_COMPONENT_IDS.has(value as EnvironmentComponentId)
  );
}

function isValidClientLoginTarget(value: unknown): value is ClientLoginTargetId {
  return (
    typeof value === 'string' &&
    CLIENT_LOGIN_TARGET_IDS.has(value as ClientLoginTargetId)
  );
}

function isValidPreferredRunner(
  value: unknown
): value is Exclude<CompatibilityLayerType, 'native'> | 'skip' {
  return (
    typeof value === 'string' &&
    VALID_PREFERRED_RUNNERS.has(value as Exclude<CompatibilityLayerType, 'native'> | 'skip')
  );
}

function isVitestRuntime(): boolean {
  if (
    typeof import.meta !== 'undefined' &&
    Boolean(import.meta.env?.VITEST || import.meta.env?.MODE === 'test')
  ) {
    return true;
  }
  if (typeof process !== 'undefined' && process.env) {
    return Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
  }
  return false;
}

export function createDefaultSetupWizardState(): SetupWizardPersistedState {
  return {
    schemaVersion: 1,
    completedAt: null,
    dismissedAt: null,
    lastHealthCheckAt: null,
    configuredComponents: [],
  };
}

export function sanitizeSetupWizardPersistedState(
  raw: unknown
): SetupWizardPersistedState {
  const base = createDefaultSetupWizardState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return base;
  }
  const rec = raw as Record<string, unknown>;
  const completedAt =
    typeof rec.completedAt === 'string' && rec.completedAt.trim()
      ? rec.completedAt.trim()
      : null;
  const dismissedAt =
    typeof rec.dismissedAt === 'string' && rec.dismissedAt.trim()
      ? rec.dismissedAt.trim()
      : null;
  const lastHealthCheckAt =
    typeof rec.lastHealthCheckAt === 'string' && rec.lastHealthCheckAt.trim()
      ? rec.lastHealthCheckAt.trim()
      : null;

  const configuredSet = new Set<EnvironmentComponentId>();
  if (Array.isArray(rec.configuredComponents)) {
    for (const item of rec.configuredComponents) {
      if (isValidComponentId(item)) {
        configuredSet.add(item);
      }
    }
  }

  const out: SetupWizardPersistedState = {
    schemaVersion: 1,
    completedAt,
    dismissedAt,
    lastHealthCheckAt,
    configuredComponents: Array.from(configuredSet),
  };

  if (isValidPreferredRunner(rec.preferredRunnerType)) {
    out.preferredRunnerType = rec.preferredRunnerType;
  }
  if (
    typeof rec.preferredBottleName === 'string' &&
    rec.preferredBottleName.trim() &&
    /^[A-Za-z0-9 _.-]{1,64}$/.test(rec.preferredBottleName.trim()) &&
    !rec.preferredBottleName.includes('..')
  ) {
    out.preferredBottleName = rec.preferredBottleName.trim();
  }
  if (typeof rec.allowAutoOpenInTest === 'boolean') {
    out.allowAutoOpenInTest = rec.allowAutoOpenInTest;
  }

  return out;
}

function computeSnapshotCounts(
  components: Record<EnvironmentComponentId, EnvironmentComponentState>,
  clientLogins: Record<ClientLoginTargetId, ClientAuthProbeState>
): EnvironmentHealthSnapshot['counts'] {
  let readyCount = 0;
  let missingRecommendedCount = 0;
  let removedSinceLastSetupCount = 0;
  let updateAvailableCount = 0;

  for (const comp of Object.values(components)) {
    if (!comp) continue;
    if (comp.status === 'ready') {
      readyCount += 1;
    }
    if (
      (comp.status === 'missing' || comp.status === 'partially_configured') &&
      (comp.recommendationTier === 'required' || comp.recommendationTier === 'recommended')
    ) {
      missingRecommendedCount += 1;
    }
    if (comp.wasPreviouslyConfigured === true && comp.status === 'missing') {
      removedSinceLastSetupCount += 1;
    }
    if (comp.status === 'update_available') {
      updateAvailableCount += 1;
    }
  }

  let pendingClientLoginCount = 0;
  let accountMismatchCount = 0;
  for (const login of Object.values(clientLogins)) {
    if (!login) continue;
    if (login.installed && !login.authenticated) {
      pendingClientLoginCount += 1;
    }
    if (login.installed && login.authenticated && login.accountMatchesOneLauncher === false) {
      accountMismatchCount += 1;
    }
  }

  return {
    readyCount,
    missingRecommendedCount,
    removedSinceLastSetupCount,
    pendingClientLoginCount,
    accountMismatchCount,
    updateAvailableCount,
  };
}

/**
 * Strict runtime type guard verifying that an IPC payload is a complete
 * `EnvironmentHealthSnapshot` with populated `components`, `clientLogins`, and `counts`.
 */
export function isCompleteHealthSnapshot(val: unknown): val is EnvironmentHealthSnapshot {
  return Boolean(
    val &&
      typeof val === 'object' &&
      (val as EnvironmentHealthSnapshot).components &&
      typeof (val as EnvironmentHealthSnapshot).components.rosetta2 === 'object' &&
      (val as EnvironmentHealthSnapshot).components.rosetta2 !== null &&
      typeof (val as EnvironmentHealthSnapshot).components.xbox_runtime === 'object' &&
      (val as EnvironmentHealthSnapshot).components.xbox_runtime !== null &&
      (val as EnvironmentHealthSnapshot).clientLogins &&
      typeof (val as EnvironmentHealthSnapshot).clientLogins === 'object' &&
      (val as EnvironmentHealthSnapshot).counts &&
      typeof (val as EnvironmentHealthSnapshot).counts === 'object'
  );
}

/**
 * Return any components that were previously configured in One Launcher but have since been
 * uninstalled/removed (`wasPreviouslyConfigured === true && status === 'missing'`).
 */
export function getRemovedComponents(
  snapshot: EnvironmentHealthSnapshot | null | undefined
): EnvironmentComponentState[] {
  if (!snapshot || !snapshot.components) return [];
  return Object.values(snapshot.components).filter(
    (comp): comp is EnvironmentComponentState =>
      Boolean(comp && comp.wasPreviouslyConfigured === true && comp.status === 'missing')
  );
}

/**
 * Deterministic browser/test fallback when `window.electronAPI?.probeEnvironmentHealth` is absent.
 */
export function buildFallbackEnvironmentSnapshot(
  connectedStorefronts: StorefrontId[] = []
): EnvironmentHealthSnapshot {
  const hostPlatform = launcherService.getHostPlatform();
  const hostArch = launcherService.getHostArch();
  const isMac = hostPlatform === 'darwin';
  const isWin = hostPlatform === 'win32';
  const isAppleSiliconMac = isMac && hostArch === 'arm64';
  const normalizedStorefronts = Array.from(new Set(connectedStorefronts));
  const steamRelevant =
    normalizedStorefronts.includes('steam') || normalizedStorefronts.length === 0;

  const bottleSummary: BottleEnvironmentSummary = {
    runnerType: null,
    runnerInstalled: false,
    availableBottles: [],
    recommendedBottleMode: 'create_dedicated',
    recommendedBottleName: 'OneLauncher',
  };

  const components: Record<EnvironmentComponentId, EnvironmentComponentState> = {
    rosetta2: {
      id: 'rosetta2',
      category: 'os_prerequisite',
      scope: 'system',
      title: 'Apple Rosetta 2',
      shortLabel: 'Rosetta 2',
      status: isAppleSiliconMac ? 'missing' : 'not_applicable',
      canAutoInstall: isAppleSiliconMac,
      recommendationTier: isAppleSiliconMac ? 'required' : 'not_needed',
      recommendationBadge: isAppleSiliconMac ? 'Required' : 'Not Needed',
      defaultSelected: isAppleSiliconMac,
      whyExplanation:
        'Lets your Mac run Windows games and older Mac games.',
      statusDetail: isAppleSiliconMac
        ? 'Checking Rosetta 2...'
        : 'Not needed on this computer.',
    },
    win_vcredist: {
      id: 'win_vcredist',
      category: 'os_prerequisite',
      scope: 'system',
      title: 'Microsoft Visual C++',
      shortLabel: 'Visual C++',
      status: isWin ? 'missing' : 'not_applicable',
      canAutoInstall: isWin,
      recommendationTier: isWin ? 'required' : 'not_needed',
      recommendationBadge: isWin ? 'Required' : 'Not Needed',
      defaultSelected: isWin,
      whyExplanation:
        'Needed by most Windows games to start.',
      statusDetail: isWin
        ? 'Checking Visual C++...'
        : 'Not needed on Mac.',
    },
    win_webview2: {
      id: 'win_webview2',
      category: 'os_prerequisite',
      scope: 'system',
      title: 'Microsoft Edge WebView2',
      shortLabel: 'WebView2',
      status: isWin ? 'ready' : 'not_applicable',
      canAutoInstall: false,
      recommendationTier: isWin ? 'built_in' : 'not_needed',
      recommendationBadge: isWin ? 'Built In' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Used for store sign-in windows on Windows.',
      statusDetail: isWin ? 'Included with Windows.' : 'Not needed on Mac.',
    },
    runner_crossover: {
      id: 'runner_crossover',
      category: 'compatibility_runner',
      scope: 'system',
      title: 'CrossOver',
      shortLabel: 'CrossOver',
      status: isMac ? 'missing' : 'not_applicable',
      canAutoInstall: isMac,
      recommendationTier: isMac ? 'recommended' : 'not_needed',
      recommendationBadge: isMac ? 'Recommended' : 'Not Needed',
      defaultSelected: isMac,
      whyExplanation:
        'Best compatibility and performance for Windows games on Mac. Paid app with a free 14-day trial.',
      statusDetail: isMac ? 'Not installed yet.' : 'Not needed on Windows.',
    },
    runner_crossover_preview: {
      id: 'runner_crossover_preview',
      category: 'compatibility_runner',
      scope: 'system',
      title: 'CrossOver Preview',
      shortLabel: 'CrossOver Preview',
      status: isMac ? 'missing' : 'not_applicable',
      canAutoInstall: false,
      requiresExternalDownload: true,
      externalDownloadUrl: 'https://www.codeweavers.com/preview',
      recommendationTier: isMac ? 'optional' : 'not_needed',
      recommendationBadge: isMac ? 'Optional' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Early-access version of CrossOver for active subscribers.',
      statusDetail: isMac ? 'Not installed.' : 'Not needed on Windows.',
    },
    runner_wine: {
      id: 'runner_wine',
      category: 'compatibility_runner',
      scope: 'system',
      title: 'Wine',
      shortLabel: 'Wine',
      status: isMac ? 'missing' : 'not_applicable',
      canAutoInstall: isMac,
      recommendationTier: isMac ? 'optional' : 'not_needed',
      recommendationBadge: isMac ? 'Free' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Free, open-source way to run Windows games on Mac. Great for older and lighter games.',
      statusDetail: isMac ? 'Not installed yet.' : 'Not needed on Windows.',
    },
    runner_gptk: {
      id: 'runner_gptk',
      category: 'compatibility_runner',
      scope: 'system',
      title: 'Apple Game Porting Toolkit',
      shortLabel: 'GPTK',
      status: isAppleSiliconMac ? 'missing' : 'not_applicable',
      canAutoInstall: false,
      requiresExternalDownload: true,
      externalDownloadUrl: 'https://developer.apple.com/games/game-porting-toolkit/',
      recommendationTier: isAppleSiliconMac ? 'optional' : 'not_needed',
      recommendationBadge: isAppleSiliconMac ? 'Advanced' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Apple’s developer tool. Not needed if you use CrossOver, which already includes it.',
      statusDetail: isAppleSiliconMac
        ? 'Not installed.'
        : isMac
          ? 'Requires Apple Silicon.'
          : 'Not needed on Windows.',
    },
    bottle_default: {
      id: 'bottle_default',
      category: 'bottle',
      scope: 'bottle',
      title: 'Windows Game Bottle ("OneLauncher")',
      shortLabel: 'Windows Bottle',
      status: isMac ? 'missing' : 'not_applicable',
      canAutoInstall: isMac,
      recommendationTier: isMac ? 'recommended' : 'not_needed',
      recommendationBadge: isMac ? 'Recommended' : 'Not Needed',
      defaultSelected: isMac,
      whyExplanation:
        'A dedicated folder that keeps your Windows games and saves neatly separated from your Mac files.',
      statusDetail: isMac ? 'Will set up "OneLauncher".' : 'Not needed on Windows.',
    },
    host_steam: {
      id: 'host_steam',
      category: 'host_client',
      storefrontId: 'steam',
      scope: 'host',
      title: isMac ? 'Steam (Mac)' : 'Steam',
      shortLabel: isMac ? 'Steam (Mac)' : 'Steam',
      status: 'missing',
      canAutoInstall: true,
      recommendationTier: steamRelevant ? 'recommended' : 'optional',
      recommendationBadge: steamRelevant ? 'Recommended' : 'Optional',
      defaultSelected: steamRelevant,
      whyExplanation:
        'Needed to download and play your Steam games.',
      statusDetail: 'Not installed yet.',
    },
    bottle_steam: {
      id: 'bottle_steam',
      category: 'bottle_client',
      storefrontId: 'steam',
      scope: 'bottle',
      title: 'Steam (Windows)',
      shortLabel: 'Steam (Windows)',
      status: isMac ? 'missing' : 'not_applicable',
      canAutoInstall: isMac,
      recommendationTier: isMac && steamRelevant ? 'recommended' : isMac ? 'optional' : 'not_needed',
      recommendationBadge: isMac && steamRelevant ? 'Recommended' : isMac ? 'Optional' : 'Not Needed',
      defaultSelected: isMac && steamRelevant,
      whyExplanation:
        'Needed to download and play Windows-only Steam games on your Mac.',
      statusDetail: isMac ? 'Not installed yet.' : 'Not needed on Windows.',
    },
    host_gog: {
      id: 'host_gog',
      category: 'host_client',
      storefrontId: 'gog',
      scope: 'host',
      title: isMac ? 'GOG Galaxy (Mac)' : 'GOG Galaxy',
      shortLabel: 'GOG Galaxy',
      status: 'missing',
      canAutoInstall: true,
      recommendationTier: 'optional',
      recommendationBadge: 'Optional — Achievements Only',
      defaultSelected: false,
      whyExplanation:
        'Downloads and cloud saves already work without GOG Galaxy (via built-in gogdl). Only install Galaxy if you want GOG achievements or multiplayer.',
      statusDetail: 'Not installed (optional).',
    },
    bottle_gog: {
      id: 'bottle_gog',
      category: 'bottle_client',
      storefrontId: 'gog',
      scope: 'bottle',
      title: 'GOG Galaxy (Windows)',
      shortLabel: 'GOG Galaxy (Windows)',
      status: isMac ? 'missing' : 'not_applicable',
      canAutoInstall: isMac,
      recommendationTier: isMac ? 'optional' : 'not_needed',
      recommendationBadge: isMac ? 'Optional — Achievements Only' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Downloads and cloud saves already work without GOG Galaxy (via built-in gogdl). Only install Galaxy if you want GOG achievements or multiplayer.',
      statusDetail: isMac ? 'Not installed (optional).' : 'Not needed on Windows.',
    },
    host_epic: {
      id: 'host_epic',
      category: 'host_client',
      storefrontId: 'epic',
      scope: 'host',
      title: isMac ? 'Epic Games Launcher (Mac)' : 'Epic Games Launcher',
      shortLabel: 'Epic Launcher',
      status: 'missing',
      canAutoInstall: true,
      recommendationTier: 'not_needed',
      recommendationBadge: 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Downloads, cloud saves, achievements, and multiplayer already work without it (via built-in legendary). Only install if you want the Epic social overlay.',
      statusDetail: 'Not installed (not needed).',
    },
    bottle_epic: {
      id: 'bottle_epic',
      category: 'bottle_client',
      storefrontId: 'epic',
      scope: 'bottle',
      title: 'Epic Games Launcher (Windows)',
      shortLabel: 'Epic Launcher (Windows)',
      status: isMac ? 'missing' : 'not_applicable',
      canAutoInstall: isMac,
      recommendationTier: 'not_needed',
      recommendationBadge: isMac ? 'Not Needed' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Downloads, cloud saves, achievements, and multiplayer already work without it (via built-in legendary). Only install if you want the Epic social overlay.',
      statusDetail: isMac ? 'Not installed (not needed).' : 'Not needed on Windows.',
    },
    xbox_runtime: {
      id: 'xbox_runtime',
      category: 'built_in_runtime',
      storefrontId: 'xbox',
      scope: 'system',
      title: 'Microsoft Gaming Services',
      shortLabel: 'Gaming Services',
      status: isWin ? 'ready' : 'not_applicable',
      canAutoInstall: false,
      recommendationTier: isWin ? 'built_in' : 'not_needed',
      recommendationBadge: isWin ? 'Built In' : 'Windows Only',
      defaultSelected: false,
      whyExplanation: isWin
        ? 'Needed on Windows to play PC Game Pass and Microsoft Store games.'
        : 'Xbox and PC Game Pass support is built in.',
      statusDetail: isWin ? 'Installed.' : 'Built in.',
    },
  };

  const clientLogins: Record<ClientLoginTargetId, ClientAuthProbeState> = {
    host_steam: {
      targetId: 'host_steam',
      storefrontId: 'steam',
      scope: 'host',
      label: isMac ? 'Steam (Mac)' : 'Steam',
      installed: false,
      authenticated: false,
      accountMatchesOneLauncher: null,
      statusSummary: 'Not installed',
    },
    bottle_steam: {
      targetId: 'bottle_steam',
      storefrontId: 'steam',
      scope: 'bottle',
      label: 'Steam (Windows)',
      installed: false,
      authenticated: false,
      accountMatchesOneLauncher: null,
      statusSummary: 'Not installed',
    },
    host_gog: {
      targetId: 'host_gog',
      storefrontId: 'gog',
      scope: 'host',
      label: isMac ? 'GOG Galaxy (Mac)' : 'GOG Galaxy',
      installed: false,
      authenticated: false,
      accountMatchesOneLauncher: null,
      statusSummary: 'Not installed',
    },
    bottle_gog: {
      targetId: 'bottle_gog',
      storefrontId: 'gog',
      scope: 'bottle',
      label: 'GOG Galaxy (Windows)',
      installed: false,
      authenticated: false,
      accountMatchesOneLauncher: null,
      statusSummary: 'Not installed',
    },
    host_epic: {
      targetId: 'host_epic',
      storefrontId: 'epic',
      scope: 'host',
      label: isMac ? 'Epic Games Launcher (Mac)' : 'Epic Games Launcher',
      installed: false,
      authenticated: false,
      accountMatchesOneLauncher: null,
      statusSummary: 'Not installed',
    },
    bottle_epic: {
      targetId: 'bottle_epic',
      storefrontId: 'epic',
      scope: 'bottle',
      label: 'Epic Games Launcher (Windows)',
      installed: false,
      authenticated: false,
      accountMatchesOneLauncher: null,
      statusSummary: 'Not installed',
    },
  };

  return {
    probedAt: new Date().toISOString(),
    probeDurationMs: 0,
    hostPlatform,
    hostArch,
    isAppleSiliconMac,
    hasWriteAccessToSystemApplications: false,
    preferredMacApplicationsDir: isMac ? '/Applications' : '',
    connectedStorefronts: normalizedStorefronts,
    bundledHelpers: {
      gogdlReady: false,
      legendaryReady: false,
      xboxGdkBridgesReady: false,
      metalPreloadReady: false,
    },
    detectedRunners: [],
    bottleSummary,
    components,
    clientLogins,
    localStoreHints: [],
    counts: computeSnapshotCounts(components, clientLogins),
  };
}

/**
 * Compute smart default component selections based on host OS, detected runners,
 * connected storefronts, and any previously configured components that were removed.
 */
export function computeDefaultSelectedComponents(
  snapshot: EnvironmentHealthSnapshot,
  connectedStorefronts: StorefrontId[] = snapshot.connectedStorefronts ?? [],
  options?: ComputeDefaultSelectedOptions
): Set<EnvironmentComponentId> {
  const selected = new Set<EnvironmentComponentId>();
  const isMac = snapshot.hostPlatform === 'darwin';
  const isWin = snapshot.hostPlatform === 'win32';
  const chosenRunner = options?.chosenRunner;
  const skipRunner = chosenRunner === 'skip';

  // 1. OS prerequisites
  if (isMac && snapshot.isAppleSiliconMac && snapshot.components.rosetta2?.status === 'missing') {
    selected.add('rosetta2');
  }
  if (isWin && snapshot.components.win_vcredist?.status === 'missing') {
    selected.add('win_vcredist');
  }

  // 2. Compatibility runner on macOS
  if (isMac && !skipRunner) {
    if (chosenRunner) {
      const explicitRunnerEntry = RUNNER_COMPONENT_TO_TYPE.find(
        (entry) => entry.runnerType === chosenRunner
      );
      if (explicitRunnerEntry) {
        const comp = snapshot.components[explicitRunnerEntry.componentId];
        if (comp && comp.status !== 'ready' && comp.status !== 'not_applicable') {
          selected.add(explicitRunnerEntry.componentId);
        }
      }
    } else if (snapshot.detectedRunners.length === 0) {
      const previouslyConfiguredMissingRunner = RUNNER_COMPONENT_TO_TYPE.find(({ componentId }) => {
        const comp = snapshot.components[componentId];
        return comp?.wasPreviouslyConfigured === true && comp.status === 'missing';
      });
      if (previouslyConfiguredMissingRunner) {
        selected.add(previouslyConfiguredMissingRunner.componentId);
      } else if (
        snapshot.components.runner_crossover &&
        snapshot.components.runner_crossover.status !== 'ready' &&
        snapshot.components.runner_crossover.status !== 'not_applicable'
      ) {
        selected.add('runner_crossover');
      }
    }
  }

  const hasRunnerSelected = RUNNER_COMPONENT_TO_TYPE.some(({ componentId }) =>
    selected.has(componentId)
  );
  const hasRunnerInstalledOrSelected =
    isMac &&
    !skipRunner &&
    (snapshot.detectedRunners.length > 0 ||
      snapshot.bottleSummary?.runnerInstalled === true ||
      hasRunnerSelected);

  // 3. Default Windows bottle on macOS when runner is installed or selected
  if (
    hasRunnerInstalledOrSelected &&
    snapshot.components.bottle_default &&
    snapshot.components.bottle_default.status !== 'ready' &&
    snapshot.components.bottle_default.status !== 'not_applicable'
  ) {
    selected.add('bottle_default');
  }

  // 4. Steam clients (host + bottle on Mac) when missing and Steam is relevant
  const steamRelevant =
    connectedStorefronts.includes('steam') || connectedStorefronts.length === 0;
  if (steamRelevant && snapshot.components.host_steam?.status === 'missing') {
    selected.add('host_steam');
  }
  if (
    hasRunnerInstalledOrSelected &&
    steamRelevant &&
    snapshot.components.bottle_steam?.status === 'missing'
  ) {
    selected.add('bottle_steam');
  }

  // 5. Re-select any previously configured components that were removed since last setup
  //    (including host_gog, bottle_gog, host_epic, bottle_epic when in repair/health-check mode;
  //    on fresh installs those remain unselected by default).
  for (const comp of Object.values(snapshot.components)) {
    if (!comp || comp.wasPreviouslyConfigured !== true || comp.status !== 'missing') {
      continue;
    }
    if (
      (comp.category === 'compatibility_runner' ||
        comp.category === 'bottle' ||
        comp.category === 'bottle_client') &&
      (!isMac || skipRunner)
    ) {
      continue;
    }
    if (comp.category === 'bottle_client' && !hasRunnerInstalledOrSelected) {
      continue;
    }
    selected.add(comp.id);
  }

  return selected;
}

/**
 * Build an ordered array of provisioning tasks from the user's component selection:
 * 1. OS prerequisites (`rosetta2`, `win_vcredist`)
 * 2. Compatibility runner (`runner_*`)
 * 3. Bottle creation / verification (`bottle_default`)
 * 4. Host & bottle storefront clients (`host_*`, `bottle_*`)
 * 5. `sync_first_party_manifests`
 *
 * Components already in `status === 'ready'` are skipped unless `forceRepairIds` includes them.
 */
export function buildProvisioningTasksFromSelection(
  params: BuildProvisioningTasksParams
): EnvironmentSetupTaskRequest[] {
  const {
    snapshot,
    selectedIds,
    chosenRunner,
    bottleMode,
    bottleName,
    gptkDmgPath,
    forceRepairIds,
  } = params;

  const isMac = snapshot.hostPlatform === 'darwin';
  const isWin = snapshot.hostPlatform === 'win32';
  const skipRunner = chosenRunner === 'skip';
  const trimmedBottleName = bottleName.trim() || snapshot.bottleSummary?.recommendedBottleName || 'OneLauncher';

  const shouldProvision = (id: EnvironmentComponentId): boolean => {
    if (!selectedIds.has(id)) return false;
    const comp = snapshot.components[id];
    if (comp?.status === 'not_applicable') return false;
    if (comp?.status === 'ready' && !forceRepairIds?.has(id)) {
      return false;
    }
    return true;
  };

  let effectiveRunnerType: Exclude<CompatibilityLayerType, 'native'> | undefined;
  if (!skipRunner) {
    effectiveRunnerType = chosenRunner;
  } else if (snapshot.bottleSummary?.runnerType) {
    effectiveRunnerType = snapshot.bottleSummary.runnerType;
  } else {
    const firstDetected = snapshot.detectedRunners.find(
      (r): r is typeof r & { type: Exclude<CompatibilityLayerType, 'native'> } =>
        r.type !== 'native'
    );
    effectiveRunnerType = firstDetected?.type;
  }

  const tasks: EnvironmentSetupTaskRequest[] = [];

  // Stage 1: OS prerequisites
  if (isMac && shouldProvision('rosetta2')) {
    tasks.push({
      action: 'install_rosetta2',
      componentId: 'rosetta2',
    });
  }
  if (isWin && shouldProvision('win_vcredist')) {
    tasks.push({
      action: 'install_win_vcredist',
      componentId: 'win_vcredist',
    });
  }

  // Stage 2: Compatibility runner (macOS)
  if (isMac && !skipRunner) {
    const orderedRunnerEntries = [...RUNNER_COMPONENT_TO_TYPE].sort((a, b) => {
      const aChosen = a.runnerType === chosenRunner ? 0 : 1;
      const bChosen = b.runnerType === chosenRunner ? 0 : 1;
      return aChosen - bChosen;
    });

    for (const entry of orderedRunnerEntries) {
      if (shouldProvision(entry.componentId)) {
        const runnerTask: EnvironmentSetupTaskRequest = {
          action: 'install_runner',
          componentId: entry.componentId,
          runnerType: entry.runnerType,
        };
        if (entry.componentId === 'runner_gptk' && gptkDmgPath && gptkDmgPath.trim()) {
          runnerTask.dmgPath = gptkDmgPath.trim();
        }
        tasks.push(runnerTask);
      }
    }
  }

  // Stage 3: Bottle creation / verification (macOS)
  if (isMac && !skipRunner && shouldProvision('bottle_default')) {
    tasks.push({
      action: 'ensure_bottle',
      componentId: 'bottle_default',
      ...(effectiveRunnerType ? { runnerType: effectiveRunnerType } : {}),
      bottleMode,
      bottleName: trimmedBottleName,
    });
  }

  // Stage 4a: Host storefront clients
  for (const hostClientId of HOST_CLIENT_ORDER) {
    if (shouldProvision(hostClientId)) {
      tasks.push({
        action: 'install_client',
        componentId: hostClientId,
      });
    }
  }

  // Stage 4b: Bottle storefront clients (macOS)
  if (isMac && !skipRunner) {
    for (const bottleClientId of BOTTLE_CLIENT_ORDER) {
      if (shouldProvision(bottleClientId)) {
        tasks.push({
          action: 'install_client',
          componentId: bottleClientId,
          ...(effectiveRunnerType ? { runnerType: effectiveRunnerType } : {}),
          bottleMode,
          bottleName: trimmedBottleName,
        });
      }
    }
  }

  // Stage 5: Sync first-party manifests after provisioning tasks
  if (tasks.length > 0) {
    const anchorTask = tasks[tasks.length - 1];
    const hasBottleScopeTask = tasks.some(
      (t) =>
        t.action === 'ensure_bottle' ||
        t.componentId === 'bottle_steam' ||
        t.componentId === 'bottle_gog' ||
        t.componentId === 'bottle_epic'
    );
    tasks.push({
      action: 'sync_first_party_manifests',
      componentId: anchorTask.componentId,
      ...(hasBottleScopeTask && effectiveRunnerType ? { runnerType: effectiveRunnerType } : {}),
      ...(hasBottleScopeTask ? { bottleName: trimmedBottleName } : {}),
    });
  }

  return tasks;
}

/**
 * Determine whether the System & Account Setup Wizard should open automatically on startup.
 */
export function shouldAutoOpenSetupWizardOnStartup(
  params: ShouldAutoOpenSetupWizardParams
): boolean {
  const { wizardState, connectedStorefrontsCount, catalogGamesCount, isElectronRuntime } = params;
  const isVitestEnv = isVitestRuntime();
  return (
    wizardState !== null &&
    wizardState.completedAt === null &&
    wizardState.dismissedAt === null &&
    connectedStorefrontsCount === 0 &&
    catalogGamesCount === 0 &&
    isElectronRuntime === true &&
    (!isVitestEnv || wizardState.allowAutoOpenInTest === true)
  );
}

function readWizardStateFromLocalStorage(): SetupWizardPersistedState | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(WIZARD_STATE_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return sanitizeSetupWizardPersistedState(parsed);
  } catch {
    return null;
  }
}

function writeWizardStateToLocalStorage(state: SetupWizardPersistedState): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(WIZARD_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota or private mode errors
  }
}

export class EnvironmentSetupService {
  private lastSnapshot: EnvironmentHealthSnapshot | null = null;
  private wizardState: SetupWizardPersistedState | null = null;
  private latestProgress: EnvironmentSetupProgressEvent | null = null;
  private progressHistory: EnvironmentSetupProgressEvent[] = [];
  private listeners: Set<() => void> = new Set();
  private inFlightProbePromise: Promise<EnvironmentHealthSnapshot> | null = null;
  private activeRunId: string | null = null;
  private activeGuidedLoginTarget: ClientLoginTargetId | null = null;
  private runSeq = 0;
  private boundElectronApiRef: unknown = null;
  private unsubscribeProgress: (() => void) | null = null;

  constructor() {
    const cached = readWizardStateFromLocalStorage();
    if (cached) {
      this.wizardState = cached;
    }
  }

  private ensureProgressSubscription(): void {
    const currentApi = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (currentApi === this.boundElectronApiRef) {
      return;
    }

    if (this.unsubscribeProgress) {
      try {
        this.unsubscribeProgress();
      } catch {
        // Ignore cleanup errors on stale preload mock
      }
      this.unsubscribeProgress = null;
    }

    this.boundElectronApiRef = currentApi;

    if (currentApi && typeof currentApi.onEnvironmentSetupProgress === 'function') {
      this.unsubscribeProgress = currentApi.onEnvironmentSetupProgress(
        (event: EnvironmentSetupProgressEvent) => {
          this.handleProgressEvent(event);
        }
      );
    }
  }

  private handleProgressEvent(event: EnvironmentSetupProgressEvent): void {
    if (!event || typeof event !== 'object') return;
    this.latestProgress = event;
    this.progressHistory.push(event);
    if (this.progressHistory.length > MAX_SETUP_PROGRESS_HISTORY) {
      this.progressHistory = this.progressHistory.slice(-MAX_SETUP_PROGRESS_HISTORY);
    }
    if (
      event.phase === 'completed' &&
      isValidComponentId(event.componentId) &&
      this.lastSnapshot
    ) {
      this.lastSnapshot = this.reconcileCompletedComponentsInSnapshot(this.lastSnapshot, [
        event.componentId,
      ]);
    }
    this.notifyListeners();
  }

  private reconcileCompletedComponentsInSnapshot(
    snapshot: EnvironmentHealthSnapshot,
    completedIds: ReadonlyArray<EnvironmentComponentId>
  ): EnvironmentHealthSnapshot {
    if (completedIds.length === 0) return snapshot;
    let mutated = false;
    const nextComponents: Record<EnvironmentComponentId, EnvironmentComponentState> = {
      ...snapshot.components,
    };
    const nextClientLogins: Record<ClientLoginTargetId, ClientAuthProbeState> = {
      ...snapshot.clientLogins,
    };

    for (const id of completedIds) {
      const existing = nextComponents[id];
      if (
        existing &&
        (existing.status === 'missing' || existing.status === 'partially_configured')
      ) {
        nextComponents[id] = {
          ...existing,
          status: 'ready',
          defaultSelected: false,
          statusDetail: 'Installed.',
        };
        mutated = true;
      }
      if (isValidClientLoginTarget(id) && nextClientLogins[id] && !nextClientLogins[id].installed) {
        nextClientLogins[id] = {
          ...nextClientLogins[id],
          installed: true,
        };
        mutated = true;
      }
    }

    if (!mutated) return snapshot;
    return {
      ...snapshot,
      components: nextComponents,
      clientLogins: nextClientLogins,
      counts: computeSnapshotCounts(nextComponents, nextClientLogins),
    };
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber errors
      }
    }
  }

  public subscribe(listener: () => void): () => void {
    this.ensureProgressSubscription();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getLastSnapshot(): EnvironmentHealthSnapshot | null {
    return this.lastSnapshot;
  }

  public getWizardState(): SetupWizardPersistedState | null {
    return this.wizardState;
  }

  public getLatestProgress(): EnvironmentSetupProgressEvent | null {
    return this.latestProgress;
  }

  public getProgressHistory(): EnvironmentSetupProgressEvent[] {
    return [...this.progressHistory];
  }

  public clearProgressHistory(): void {
    this.latestProgress = null;
    this.progressHistory = [];
    this.notifyListeners();
  }

  public isSetupRunning(): boolean {
    return this.activeRunId !== null;
  }

  public getActiveRunId(): string | null {
    return this.activeRunId;
  }

  public getActiveGuidedLoginTarget(): ClientLoginTargetId | null {
    return this.activeGuidedLoginTarget;
  }

  public getRemovedComponents(): EnvironmentComponentState[] {
    return getRemovedComponents(this.lastSnapshot);
  }

  public probeHealth(
    connectedStorefronts?: StorefrontId[],
    options?: { forceFresh?: boolean }
  ): Promise<EnvironmentHealthSnapshot> {
    this.ensureProgressSubscription();
    if (this.inFlightProbePromise) {
      if (!options?.forceFresh) {
        return this.inFlightProbePromise;
      }
      const prior = this.inFlightProbePromise;
      return prior
        .catch(() => undefined)
        .then(() => this.probeHealth(connectedStorefronts, { forceFresh: false }));
    }

    const effectiveStorefronts =
      connectedStorefronts ?? this.lastSnapshot?.connectedStorefronts ?? [];

    const probeTask = (async (): Promise<EnvironmentHealthSnapshot> => {
      if (
        typeof window !== 'undefined' &&
        typeof window.electronAPI?.probeEnvironmentHealth === 'function'
      ) {
        try {
          const snapshot = await window.electronAPI.probeEnvironmentHealth({
            connectedStorefronts: effectiveStorefronts,
          });
          if (isCompleteHealthSnapshot(snapshot)) {
            this.lastSnapshot = snapshot;
            this.notifyListeners();
            return snapshot;
          }
        } catch (err) {
          console.warn('[EnvironmentSetupService] probeEnvironmentHealth failed:', err);
        }
        const preservedOrFallback =
          this.lastSnapshot ?? buildFallbackEnvironmentSnapshot(effectiveStorefronts);
        this.lastSnapshot = preservedOrFallback;
        this.notifyListeners();
        return preservedOrFallback;
      }

      const fallback = buildFallbackEnvironmentSnapshot(effectiveStorefronts);
      this.lastSnapshot = fallback;
      this.notifyListeners();
      return fallback;
    })();

    const trackedPromise = probeTask.finally(() => {
      if (this.inFlightProbePromise === trackedPromise) {
        this.inFlightProbePromise = null;
      }
    });
    this.inFlightProbePromise = trackedPromise;

    return trackedPromise;
  }

  public async loadWizardState(): Promise<SetupWizardPersistedState> {
    this.ensureProgressSubscription();
    const localMirror = readWizardStateFromLocalStorage();

    if (
      typeof window !== 'undefined' &&
      typeof window.electronAPI?.getSetupWizardState === 'function'
    ) {
      try {
        const remote = await window.electronAPI.getSetupWizardState();
        if (remote && typeof remote === 'object') {
          const sanitized = sanitizeSetupWizardPersistedState(remote);
          this.wizardState = sanitized;
          writeWizardStateToLocalStorage(sanitized);
          this.notifyListeners();
          return sanitized;
        }
      } catch (err) {
        console.warn('[EnvironmentSetupService] getSetupWizardState failed:', err);
      }
    }

    const resolved = localMirror ?? this.wizardState ?? createDefaultSetupWizardState();
    this.wizardState = resolved;
    writeWizardStateToLocalStorage(resolved);
    this.notifyListeners();
    return resolved;
  }

  public async saveWizardState(
    patch: Partial<SetupWizardPersistedState> & {
      addConfiguredComponents?: EnvironmentComponentId[];
    }
  ): Promise<SetupWizardPersistedState> {
    this.ensureProgressSubscription();
    const current =
      this.wizardState ?? readWizardStateFromLocalStorage() ?? createDefaultSetupWizardState();

    const mergedComponents = new Set<EnvironmentComponentId>(
      Array.isArray(patch.configuredComponents)
        ? patch.configuredComponents.filter(isValidComponentId)
        : current.configuredComponents
    );
    if (Array.isArray(patch.addConfiguredComponents)) {
      for (const id of patch.addConfiguredComponents) {
        if (isValidComponentId(id)) {
          mergedComponents.add(id);
        }
      }
    }

    const optimisticNext = sanitizeSetupWizardPersistedState({
      ...current,
      ...patch,
      configuredComponents: Array.from(mergedComponents),
    });

    // Commit optimistic state synchronously so immediate wizard re-entry never sees stale state
    this.wizardState = optimisticNext;
    writeWizardStateToLocalStorage(optimisticNext);
    this.notifyListeners();

    if (
      typeof window !== 'undefined' &&
      typeof window.electronAPI?.saveSetupWizardState === 'function'
    ) {
      try {
        const res = await window.electronAPI.saveSetupWizardState(patch);
        if (res?.state && typeof res.state === 'object') {
          const remoteState = sanitizeSetupWizardPersistedState(res.state);
          this.wizardState = remoteState;
          writeWizardStateToLocalStorage(remoteState);
          this.notifyListeners();
          return remoteState;
        }
      } catch (err) {
        console.warn('[EnvironmentSetupService] saveSetupWizardState failed:', err);
      }
    }

    return optimisticNext;
  }

  public async runSetupTasks(
    req: RunEnvironmentSetupRequest
  ): Promise<RunEnvironmentSetupResult> {
    this.ensureProgressSubscription();
    const runId =
      typeof req.runId === 'string' && req.runId.trim()
        ? req.runId.trim()
        : `setup-${Date.now()}-${++this.runSeq}`;

    this.activeRunId = runId;
    this.notifyListeners();

    try {
      if (
        typeof window !== 'undefined' &&
        typeof window.electronAPI?.runEnvironmentSetupTasks === 'function'
      ) {
        let result: RunEnvironmentSetupResult;
        try {
          result = await window.electronAPI.runEnvironmentSetupTasks({
            ...req,
            runId,
          });
        } catch (err) {
          const fallbackSnapshot =
            this.lastSnapshot ??
            buildFallbackEnvironmentSnapshot(req.connectedStorefronts ?? []);
          const errMessage =
            err instanceof Error && err.message
              ? err.message
              : 'Environment setup tasks failed.';
          return {
            success: false,
            runId,
            outcomes: [],
            snapshot: fallbackSnapshot,
            error: errMessage,
          };
        }

        const normalizedOutcomes = Array.isArray(result?.outcomes) ? result.outcomes : [];
        const completedIds = normalizedOutcomes
          .filter(
            (o) =>
              o.status === 'completed' || (o.status === 'skipped' && Boolean(o.installedPath))
          )
          .map((o) => o.componentId);

        let resolvedSnapshot: EnvironmentHealthSnapshot;
        if (isCompleteHealthSnapshot(result?.snapshot)) {
          resolvedSnapshot = this.reconcileCompletedComponentsInSnapshot(
            result.snapshot,
            completedIds
          );
          this.lastSnapshot = resolvedSnapshot;
        } else {
          const probedAfterRun = await this.probeHealth(req.connectedStorefronts, {
            forceFresh: true,
          });
          resolvedSnapshot = this.reconcileCompletedComponentsInSnapshot(
            probedAfterRun,
            completedIds
          );
          this.lastSnapshot = resolvedSnapshot;
        }

        await Promise.allSettled([
          launcherService.detectCompatibilityLayers(),
          launcherService.detectInstalledStorefrontClients(),
        ]);

        return {
          ...result,
          runId: typeof result?.runId === 'string' && result.runId ? result.runId : runId,
          outcomes: normalizedOutcomes,
          snapshot: resolvedSnapshot,
        };
      }

      const fallbackSnapshot =
        this.lastSnapshot ??
        buildFallbackEnvironmentSnapshot(req.connectedStorefronts ?? []);
      return {
        success: false,
        runId,
        outcomes: [],
        snapshot: fallbackSnapshot,
        error: 'Environment setup requires the One Launcher desktop runtime.',
      };
    } finally {
      if (this.activeRunId === runId) {
        this.activeRunId = null;
      }
      this.notifyListeners();
    }
  }

  public async cancelActiveSetup(runId?: string): Promise<void> {
    const targetRunId = (typeof runId === 'string' && runId.trim()) || this.activeRunId;
    if (!targetRunId) {
      return;
    }

    try {
      if (
        typeof window !== 'undefined' &&
        typeof window.electronAPI?.cancelEnvironmentSetup === 'function'
      ) {
        await window.electronAPI.cancelEnvironmentSetup(targetRunId);
      }
    } catch (err) {
      console.warn('[EnvironmentSetupService] cancelEnvironmentSetup failed:', err);
    } finally {
      if (this.activeRunId === targetRunId) {
        this.activeRunId = null;
      }
      this.notifyListeners();
    }
  }

  public async startGuidedLogin(
    req: StartGuidedClientLoginRequest
  ): Promise<GuidedClientLoginResult> {
    this.ensureProgressSubscription();
    this.activeGuidedLoginTarget = req.targetId;
    this.notifyListeners();

    try {
      if (
        typeof window !== 'undefined' &&
        typeof window.electronAPI?.startGuidedClientLogin === 'function'
      ) {
        const result = await window.electronAPI.startGuidedClientLogin(req);
        if (result?.probeState && this.lastSnapshot) {
          const nextClientLogins: Record<ClientLoginTargetId, ClientAuthProbeState> = {
            ...this.lastSnapshot.clientLogins,
            [req.targetId]: result.probeState,
          };
          const impliedReadyIds: EnvironmentComponentId[] = [];
          if (result.probeState.installed) {
            impliedReadyIds.push(req.targetId);
            if (req.targetId.startsWith('bottle_')) {
              impliedReadyIds.push('bottle_default');
              if (req.runnerType === 'crossover') impliedReadyIds.push('runner_crossover');
              if (req.runnerType === 'crossover_preview') {
                impliedReadyIds.push('runner_crossover_preview');
              }
              if (req.runnerType === 'wine') impliedReadyIds.push('runner_wine');
              if (req.runnerType === 'gptk') impliedReadyIds.push('runner_gptk');
            }
          }
          const reconciledBase = this.reconcileCompletedComponentsInSnapshot(
            this.lastSnapshot,
            impliedReadyIds
          );
          this.lastSnapshot = {
            ...reconciledBase,
            clientLogins: nextClientLogins,
            counts: computeSnapshotCounts(reconciledBase.components, nextClientLogins),
          };
        }
        if (result?.authenticated || result?.probeState?.installed) {
          await launcherService.detectInstalledStorefrontClients().catch(() => {});
        }
        return result;
      }

      const storefrontId: 'steam' | 'gog' | 'epic' = req.targetId.includes('gog')
        ? 'gog'
        : req.targetId.includes('epic')
          ? 'epic'
          : 'steam';
      const scope: 'host' | 'bottle' = req.targetId.startsWith('bottle_') ? 'bottle' : 'host';
      return {
        success: false,
        targetId: req.targetId,
        authenticated: false,
        probeState: {
          targetId: req.targetId,
          storefrontId,
          scope,
          label: req.targetId,
          installed: false,
          authenticated: false,
          accountMatchesOneLauncher: null,
          statusSummary: 'Guided client sign-in requires the One Launcher desktop runtime.',
        },
        message: 'Guided client sign-in requires the One Launcher desktop runtime.',
        error: 'Guided client sign-in requires the One Launcher desktop runtime.',
      };
    } finally {
      if (this.activeGuidedLoginTarget === req.targetId) {
        this.activeGuidedLoginTarget = null;
      }
      this.notifyListeners();
    }
  }

  public async cancelGuidedLogin(targetId: ClientLoginTargetId): Promise<void> {
    if (this.activeGuidedLoginTarget === targetId) {
      this.activeGuidedLoginTarget = null;
      this.notifyListeners();
    }
    try {
      if (
        typeof window !== 'undefined' &&
        typeof window.electronAPI?.cancelGuidedClientLogin === 'function'
      ) {
        await window.electronAPI.cancelGuidedClientLogin(targetId);
      }
    } catch (err) {
      console.warn('[EnvironmentSetupService] cancelGuidedClientLogin failed:', err);
    } finally {
      if (this.activeGuidedLoginTarget === targetId) {
        this.activeGuidedLoginTarget = null;
      }
      this.notifyListeners();
    }
  }

  public openWizard(options?: OpenSystemSetupEventDetail): void {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent<OpenSystemSetupEventDetail>(OPEN_SYSTEM_SETUP_EVENT, {
          detail: options || {},
        })
      );
    }
  }
}

export const environmentSetupService = new EnvironmentSetupService();
