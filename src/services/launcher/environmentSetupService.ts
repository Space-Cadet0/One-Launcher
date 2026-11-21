import {
  BOTTLE_CLIENT_COMPONENT_IDS,
  CLIENT_LOGIN_TARGET_CATALOG,
  CLIENT_LOGIN_TARGET_IDS,
  ENVIRONMENT_COMPONENT_CATALOG,
  HOST_CLIENT_COMPONENT_IDS,
  RUNNER_COMPONENT_TO_TYPE,
  TARGET_TO_STOREFRONT_MAP,
  isValidClientLoginTargetId,
  isValidEnvironmentComponentId,
  isValidPreferredRunner,
  resolveComponentScopeForHost,
  resolveScopeForLoginTarget,
  resolveStorefrontForLoginTarget,
  type EnvironmentComponentCatalogEntry,
} from '../../contracts/environmentCatalog';
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
import { isBottleCompatibleWithRunner } from '../../contracts/launchPolicyResolver';
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
  focusComponentId?: EnvironmentComponentId;
}

export interface BuildProvisioningTasksParams {
  snapshot: EnvironmentHealthSnapshot;
  selectedIds: ReadonlySet<EnvironmentComponentId>;
  chosenRunner: Exclude<CompatibilityLayerType, 'native'> | 'skip';
  bottleMode: 'reuse_existing' | 'create_dedicated';
  bottleName: string;
  gptkDmgPath?: string;
  forceRepairIds?: ReadonlySet<EnvironmentComponentId>;
  runnerUpdateOptInIds?: ReadonlySet<EnvironmentComponentId>;
}

export interface ShouldAutoOpenSetupWizardParams {
  wizardState: SetupWizardPersistedState | null;
  connectedStorefrontsCount: number;
  catalogGamesCount: number;
  isElectronRuntime: boolean;
}

export interface ProvisionBottleSteamParams {
  runnerType: CompatibilityLayerType;
  bottleName: string;
  needsInstall: boolean;
  needsSignIn: boolean;
  onPhaseChange?: (message: string) => void;
}

export interface ProvisionBottleSteamResult {
  success: boolean;
  installed: boolean;
  authenticated: boolean;
  cancelled?: boolean;
  message: string;
  error?: string;
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
      if (isValidEnvironmentComponentId(item)) {
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

function buildFallbackBaseFromCatalog(
  entry: EnvironmentComponentCatalogEntry,
  hostPlatform: 'darwin' | 'win32' | 'linux',
  isAppleSiliconMac: boolean
): Pick<
  EnvironmentComponentState,
  | 'id'
  | 'category'
  | 'storefrontId'
  | 'scope'
  | 'title'
  | 'shortLabel'
  | 'canAutoInstall'
  | 'requiresExternalDownload'
  | 'externalDownloadUrl'
  | 'estimatedDownloadMB'
> {
  const isMac = hostPlatform === 'darwin';
  const isWin = hostPlatform === 'win32';
  const archEligible = !entry.requiresAppleSilicon || isAppleSiliconMac;
  const canAutoInstall = isMac
    ? entry.canAutoInstallOnMac && archEligible
    : isWin
      ? entry.canAutoInstallOnWin
      : false;
  const requiresExternalDownload = isMac
    ? entry.requiresExternalDownloadOnMac
    : isWin
      ? entry.requiresExternalDownloadOnWin
      : false;

  return {
    id: entry.id,
    category: entry.category,
    ...(entry.storefrontId ? { storefrontId: entry.storefrontId } : {}),
    scope: resolveComponentScopeForHost(entry.id, hostPlatform),
    title: isMac ? entry.macTitle : entry.title,
    shortLabel: isMac ? entry.macShortLabel : entry.shortLabel,
    canAutoInstall,
    ...(requiresExternalDownload ? { requiresExternalDownload: true } : {}),
    ...(entry.externalDownloadUrl ? { externalDownloadUrl: entry.externalDownloadUrl } : {}),
    ...(entry.estimatedDownloadMB !== undefined
      ? { estimatedDownloadMB: entry.estimatedDownloadMB }
      : {}),
  };
}

/**
 * Deterministic browser/test fallback when `window.electronAPI?.probeEnvironmentHealth` is absent.
 * Sources component & login-target definitions from the canonical 25-component / 15-target
 * Wave 1 `environmentCatalog` so renderer fallback and Electron prober stay 1:1 aligned.
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

  const base = (id: EnvironmentComponentId) =>
    buildFallbackBaseFromCatalog(
      ENVIRONMENT_COMPONENT_CATALOG[id],
      hostPlatform,
      isAppleSiliconMac
    );

  const components: Record<EnvironmentComponentId, EnvironmentComponentState> = {
    rosetta2: {
      ...base('rosetta2'),
      status: isAppleSiliconMac ? 'missing' : 'not_applicable',
      recommendationTier: isAppleSiliconMac ? 'required' : 'not_needed',
      recommendationBadge: isAppleSiliconMac ? 'Required' : 'Not Needed',
      defaultSelected: isAppleSiliconMac,
      whyExplanation: 'Lets your Mac run Windows games and older Mac games.',
      statusDetail: isAppleSiliconMac
        ? 'Checking Rosetta 2...'
        : 'Not needed on this computer.',
    },
    win_vcredist: {
      ...base('win_vcredist'),
      status: isWin ? 'missing' : 'not_applicable',
      recommendationTier: isWin ? 'required' : 'not_needed',
      recommendationBadge: isWin ? 'Required' : 'Not Needed',
      defaultSelected: isWin,
      whyExplanation: 'Needed by most Windows games to start.',
      statusDetail: isWin ? 'Checking Visual C++...' : 'Not needed on Mac.',
    },
    win_webview2: {
      ...base('win_webview2'),
      status: isWin ? 'ready' : 'not_applicable',
      recommendationTier: isWin ? 'built_in' : 'not_needed',
      recommendationBadge: isWin ? 'Built In' : 'Not Needed',
      defaultSelected: false,
      whyExplanation: 'Used for store sign-in windows on Windows.',
      statusDetail: isWin ? 'Included with Windows.' : 'Not needed on Mac.',
    },
    runner_crossover: {
      ...base('runner_crossover'),
      status: isMac ? 'missing' : 'not_applicable',
      recommendationTier: isMac ? 'recommended' : 'not_needed',
      recommendationBadge: isMac ? 'Recommended' : 'Not Needed',
      defaultSelected: isMac,
      whyExplanation:
        'Best compatibility and performance for Windows games on Mac. Paid app with a free 14-day trial.',
      statusDetail: isMac ? 'Not installed yet.' : 'Not needed on Windows.',
    },
    runner_crossover_preview: {
      ...base('runner_crossover_preview'),
      status: isMac ? 'missing' : 'not_applicable',
      recommendationTier: isMac ? 'optional' : 'not_needed',
      recommendationBadge: isMac ? 'Optional' : 'Not Needed',
      defaultSelected: false,
      whyExplanation: 'Early-access version of CrossOver for active subscribers.',
      statusDetail: isMac ? 'Not installed.' : 'Not needed on Windows.',
    },
    runner_crossover_preview_arm64: {
      ...base('runner_crossover_preview_arm64'),
      status: isAppleSiliconMac ? 'missing' : 'not_applicable',
      requiresExternalDownload: !isAppleSiliconMac,
      recommendationTier: isAppleSiliconMac ? 'optional' : 'not_needed',
      recommendationBadge: isAppleSiliconMac ? 'Experimental' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Experimental arm64 Wine + FEX branch of CrossOver Preview with dedicated arm64 bottles on Apple Silicon.',
      statusDetail: isAppleSiliconMac
        ? 'Not installed yet.'
        : isMac
          ? 'Requires Apple Silicon.'
          : 'Not needed on Windows.',
    },
    runner_wine: {
      ...base('runner_wine'),
      status: isMac ? 'missing' : 'not_applicable',
      recommendationTier: isMac ? 'optional' : 'not_needed',
      recommendationBadge: isMac ? 'Free' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Free, open-source way to run Windows games on Mac. Great for older and lighter games.',
      statusDetail: isMac ? 'Not installed yet.' : 'Not needed on Windows.',
    },
    runner_gptk: {
      ...base('runner_gptk'),
      status: isAppleSiliconMac ? 'missing' : 'not_applicable',
      requiresExternalDownload: false,
      recommendationTier: isAppleSiliconMac ? 'optional' : 'not_needed',
      recommendationBadge: isAppleSiliconMac ? 'Advanced' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Apple’s developer tool. Not needed if you use CrossOver, which already includes it.',
      statusDetail: isAppleSiliconMac
        ? 'Not installed yet.'
        : isMac
          ? 'Requires Apple Silicon.'
          : 'Not needed on Windows.',
    },
    bottle_default: {
      ...base('bottle_default'),
      status: isMac ? 'missing' : 'not_applicable',
      recommendationTier: isMac ? 'recommended' : 'not_needed',
      recommendationBadge: isMac ? 'Recommended' : 'Not Needed',
      defaultSelected: isMac,
      whyExplanation:
        'A dedicated folder that keeps your Windows games and saves neatly separated from your Mac files.',
      statusDetail: isMac ? 'Will set up "OneLauncher".' : 'Not needed on Windows.',
    },
    host_steam: {
      ...base('host_steam'),
      status: 'missing',
      recommendationTier: steamRelevant ? 'recommended' : 'optional',
      recommendationBadge: steamRelevant ? 'Recommended' : 'Optional',
      defaultSelected: steamRelevant,
      whyExplanation: 'Needed to download and play your Steam games.',
      statusDetail: 'Not installed yet.',
    },
    bottle_steam: {
      ...base('bottle_steam'),
      status: isMac ? 'missing' : 'not_applicable',
      recommendationTier:
        isMac && steamRelevant ? 'recommended' : isMac ? 'optional' : 'not_needed',
      recommendationBadge:
        isMac && steamRelevant ? 'Recommended' : isMac ? 'Optional' : 'Not Needed',
      defaultSelected: isMac && steamRelevant,
      whyExplanation:
        'Needed to download and play Windows-only Steam games on your Mac.',
      statusDetail: isMac ? 'Not installed yet.' : 'Not needed on Windows.',
    },
    host_gog: {
      ...base('host_gog'),
      status: 'missing',
      recommendationTier: 'optional',
      recommendationBadge: 'Optional — Achievements Only',
      defaultSelected: false,
      whyExplanation:
        'Downloads and cloud saves already work without GOG Galaxy (via built-in gogdl). Only install Galaxy if you want GOG achievements or multiplayer.',
      statusDetail: 'Not installed (optional).',
    },
    bottle_gog: {
      ...base('bottle_gog'),
      status: isMac ? 'missing' : 'not_applicable',
      recommendationTier: isMac ? 'optional' : 'not_needed',
      recommendationBadge: isMac ? 'Optional — Achievements Only' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Downloads and cloud saves already work without GOG Galaxy (via built-in gogdl). Only install Galaxy if you want GOG achievements or multiplayer.',
      statusDetail: isMac ? 'Not installed (optional).' : 'Not needed on Windows.',
    },
    host_epic: {
      ...base('host_epic'),
      status: 'missing',
      recommendationTier: 'not_needed',
      recommendationBadge: 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Downloads, cloud saves, achievements, and multiplayer already work without it (via built-in legendary). Only install if you want the Epic social overlay.',
      statusDetail: 'Not installed (not needed).',
    },
    bottle_epic: {
      ...base('bottle_epic'),
      status: isMac ? 'missing' : 'not_applicable',
      recommendationTier: 'not_needed',
      recommendationBadge: 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Downloads, cloud saves, achievements, and multiplayer already work without it (via built-in legendary). Only install if you want the Epic social overlay.',
      statusDetail: isMac ? 'Not installed (not needed).' : 'Not needed on Windows.',
    },
    host_ubisoft: {
      ...base('host_ubisoft'),
      status: isWin ? 'missing' : 'not_applicable',
      recommendationTier: isWin ? 'optional' : 'not_needed',
      recommendationBadge: isWin ? 'Optional — Delegated Games' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Only needed for Xbox Game Pass or cross-store titles that delegate launch and sign-in through Ubisoft Connect.',
      statusDetail: isWin ? 'Not installed (optional).' : 'Not needed on Mac.',
    },
    bottle_ubisoft: {
      ...base('bottle_ubisoft'),
      status: isMac ? 'missing' : 'not_applicable',
      recommendationTier: isMac ? 'optional' : 'not_needed',
      recommendationBadge: isMac ? 'Optional — Delegated Games' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Only needed on Mac for Windows titles that delegate launch and sign-in through Ubisoft Connect.',
      statusDetail: isMac ? 'Not installed (optional).' : 'Not needed on Windows.',
    },
    host_ea: {
      ...base('host_ea'),
      status: isWin ? 'missing' : 'not_applicable',
      recommendationTier: isWin ? 'optional' : 'not_needed',
      recommendationBadge: isWin ? 'Optional — Delegated Games' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Only needed for EA Play / PC Game Pass or cross-store titles that delegate launch and sign-in through EA App.',
      statusDetail: isWin ? 'Not installed (optional).' : 'Not needed on Mac.',
    },
    bottle_ea: {
      ...base('bottle_ea'),
      status: isMac ? 'missing' : 'not_applicable',
      recommendationTier: isMac ? 'optional' : 'not_needed',
      recommendationBadge: isMac ? 'Optional — Delegated Games' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Only needed on Mac for Windows titles that delegate launch and sign-in through EA App.',
      statusDetail: isMac ? 'Not installed (optional).' : 'Not needed on Windows.',
    },
    host_bnet: {
      ...base('host_bnet'),
      status: isWin || isMac ? 'missing' : 'not_applicable',
      recommendationTier: isWin || isMac ? 'optional' : 'not_needed',
      recommendationBadge: isWin || isMac ? 'Optional — Delegated Games' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Only needed for Activision Blizzard / PC Game Pass titles that delegate launch and sign-in through Battle.net.',
      statusDetail: isWin || isMac ? 'Not installed (optional).' : 'Not needed on this platform.',
    },
    bottle_bnet: {
      ...base('bottle_bnet'),
      status: isMac ? 'missing' : 'not_applicable',
      recommendationTier: isMac ? 'optional' : 'not_needed',
      recommendationBadge: isMac ? 'Optional — Delegated Games' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Only needed on Mac for Windows titles that delegate launch and sign-in through Battle.net.',
      statusDetail: isMac ? 'Not installed (optional).' : 'Not needed on Windows.',
    },
    host_rockstar: {
      ...base('host_rockstar'),
      status: isWin ? 'missing' : 'not_applicable',
      recommendationTier: isWin ? 'optional' : 'not_needed',
      recommendationBadge: isWin ? 'Optional — Delegated Games' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Only needed for Rockstar titles that delegate launch and sign-in through Rockstar Games Launcher.',
      statusDetail: isWin ? 'Not installed (optional).' : 'Not needed on Mac.',
    },
    bottle_rockstar: {
      ...base('bottle_rockstar'),
      status: isMac ? 'missing' : 'not_applicable',
      recommendationTier: isMac ? 'optional' : 'not_needed',
      recommendationBadge: isMac ? 'Optional — Delegated Games' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Only needed on Mac for Windows titles that delegate launch and sign-in through Rockstar Games Launcher.',
      statusDetail: isMac ? 'Not installed (optional).' : 'Not needed on Windows.',
    },
    host_riot: {
      ...base('host_riot'),
      status: isWin ? 'missing' : 'not_applicable',
      recommendationTier: isWin ? 'optional' : 'not_needed',
      recommendationBadge: isWin ? 'Optional — Delegated Games' : 'Not Needed',
      defaultSelected: false,
      whyExplanation:
        'Only needed for Riot Games / PC Game Pass titles that delegate install, sign-in, and launch through Riot Client.',
      statusDetail: isWin ? 'Not installed (optional).' : 'Not needed on Mac.',
    },
    xbox_runtime: {
      ...base('xbox_runtime'),
      status: isWin ? 'ready' : 'not_applicable',
      recommendationTier: isWin ? 'built_in' : 'built_in',
      recommendationBadge: isWin ? 'Built In' : 'Built In',
      defaultSelected: false,
      whyExplanation: isWin
        ? 'Needed on Windows to play PC Game Pass and Microsoft Store games.'
        : 'Xbox and PC Game Pass support is built in.',
      statusDetail: isWin ? 'Installed.' : 'Built in.',
    },
  };

  const clientLogins = {} as Record<ClientLoginTargetId, ClientAuthProbeState>;
  for (const targetId of CLIENT_LOGIN_TARGET_IDS) {
    const entry = CLIENT_LOGIN_TARGET_CATALOG[targetId];
    clientLogins[targetId] = {
      targetId: entry.targetId,
      storefrontId: entry.storefrontId,
      scope: entry.scope,
      label: isMac ? entry.macLabel : entry.label,
      installed: false,
      authenticated: false,
      accountMatchesOneLauncher: null,
      statusSummary: 'Not installed',
    };
  }

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

  // 2. Compatibility runner on macOS (missing/partially_configured auto-selected; update_available stays opt-in)
  if (isMac && !skipRunner) {
    if (chosenRunner) {
      const explicitRunnerEntry = RUNNER_COMPONENT_TO_TYPE.find(
        (entry) => entry.runnerType === chosenRunner
      );
      if (explicitRunnerEntry) {
        const comp = snapshot.components[explicitRunnerEntry.componentId];
        if (
          comp &&
          comp.status !== 'ready' &&
          comp.status !== 'update_available' &&
          comp.status !== 'not_applicable'
        ) {
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
        snapshot.components.runner_crossover.status !== 'update_available' &&
        snapshot.components.runner_crossover.status !== 'not_applicable'
      ) {
        selected.add('runner_crossover');
      }
    }
  }

  const hasRunnerSelected = RUNNER_COMPONENT_TO_TYPE.some(({ componentId }) =>
    selected.has(componentId)
  );
  const chosenRunnerComp =
    isMac && chosenRunner && !skipRunner
      ? snapshot.components[
          RUNNER_COMPONENT_TO_TYPE.find((e) => e.runnerType === chosenRunner)?.componentId ??
            'runner_crossover'
        ]
      : undefined;
  const hasRunnerInstalledOrSelected =
    isMac &&
    !skipRunner &&
    (snapshot.detectedRunners.length > 0 ||
      snapshot.bottleSummary?.runnerInstalled === true ||
      hasRunnerSelected ||
      chosenRunnerComp?.status === 'ready' ||
      chosenRunnerComp?.status === 'update_available');

  const effectiveRunnerForBottle =
    chosenRunner && !skipRunner ? chosenRunner : snapshot.bottleSummary?.runnerType ?? undefined;
  const availBottles = snapshot.bottleSummary?.availableBottles ?? [];
  const hasCompatBottleForRunner =
    effectiveRunnerForBottle === 'crossover_preview_arm64'
      ? availBottles.length > 0
        ? availBottles.some((b) => isBottleCompatibleWithRunner(b, 'crossover_preview_arm64'))
        : snapshot.bottleSummary?.runnerType === 'crossover_preview_arm64' &&
          snapshot.components.bottle_default?.status === 'ready'
      : availBottles.length > 0 && effectiveRunnerForBottle
        ? availBottles.some((b) => isBottleCompatibleWithRunner(b, effectiveRunnerForBottle))
        : snapshot.components.bottle_default?.status === 'ready';

  // 3. Default Windows bottle on macOS when runner is installed or selected
  if (
    hasRunnerInstalledOrSelected &&
    snapshot.components.bottle_default &&
    snapshot.components.bottle_default.status !== 'not_applicable' &&
    (snapshot.components.bottle_default.status !== 'ready' || !hasCompatBottleForRunner)
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
    snapshot.components.bottle_steam &&
    snapshot.components.bottle_steam.status !== 'not_applicable' &&
    (snapshot.components.bottle_steam.status === 'missing' || !hasCompatBottleForRunner)
  ) {
    selected.add('bottle_steam');
  }

  // 5. Re-select any previously configured components that were removed since last setup
  //    (including optional storefront and chained publisher launchers when in repair/health-check
  //    mode; on fresh installs those remain unselected by default).
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

  // 6. Pre-select an explicitly focused component (e.g., when opened from a chained publisher
  //    launcher install/play prompt) while keeping publisher launchers unselected by default.
  const focusedId = options?.focusComponentId;
  if (focusedId) {
    const focusedComp = snapshot.components[focusedId];
    if (
      focusedComp &&
      focusedComp.status !== 'ready' &&
      focusedComp.status !== 'not_applicable'
    ) {
      const requiresMacRunner =
        focusedComp.category === 'compatibility_runner' ||
        focusedComp.category === 'bottle' ||
        focusedComp.category === 'bottle_client';
      if (
        (!requiresMacRunner || (isMac && !skipRunner)) &&
        (focusedComp.category !== 'bottle_client' || hasRunnerInstalledOrSelected)
      ) {
        selected.add(focusedId);
      }
    }
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
    runnerUpdateOptInIds,
  } = params;

  const isMac = snapshot.hostPlatform === 'darwin';
  const isWin = snapshot.hostPlatform === 'win32';
  const skipRunner = chosenRunner === 'skip';
  const defaultRunnerBottle =
    chosenRunner === 'crossover_preview_arm64' ? 'OneLauncher-arm64' : 'OneLauncher';
  const trimmedBottleName =
    bottleName.trim() ||
    (chosenRunner === 'crossover_preview_arm64'
      ? defaultRunnerBottle
      : snapshot.bottleSummary?.recommendedBottleName || defaultRunnerBottle);

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

  const availBottles = snapshot.bottleSummary?.availableBottles ?? [];
  const matchedTargetBottle = availBottles.find((b) => b.name === trimmedBottleName);
  const targetBottleExistsCompatibly = Boolean(
    matchedTargetBottle &&
      isBottleCompatibleWithRunner(matchedTargetBottle, effectiveRunnerType)
  );
  const targetBottleNeedsCreation =
    isMac &&
    !skipRunner &&
    snapshot.components.bottle_default?.status !== 'not_applicable' &&
    !targetBottleExistsCompatibly &&
    (availBottles.length > 0
      ? bottleMode === 'create_dedicated' || chosenRunner === 'crossover_preview_arm64'
      : chosenRunner === 'crossover_preview_arm64' &&
        (snapshot.bottleSummary?.runnerType !== 'crossover_preview_arm64' ||
          snapshot.bottleSummary?.recommendedBottleName !== trimmedBottleName));

  const chosenRunnerComponentId: EnvironmentComponentId | null =
    chosenRunner && chosenRunner !== 'skip'
      ? RUNNER_COMPONENT_TO_TYPE.find((entry) => entry.runnerType === chosenRunner)?.componentId ??
        null
      : null;

  const shouldProvision = (id: EnvironmentComponentId): boolean => {
    const comp = snapshot.components[id];
    if (comp?.status === 'not_applicable') return false;
    const isRunnerComponent = RUNNER_COMPONENT_TO_TYPE.some((entry) => entry.componentId === id);
    if (comp?.status === 'update_available' && isRunnerComponent) {
      if (id !== chosenRunnerComponentId && !selectedIds.has(id)) {
        return false;
      }
      if (runnerUpdateOptInIds) {
        return runnerUpdateOptInIds.has(id);
      }
      const serviceOptIn = environmentSetupService.getRunnerUpdateOptIn(id);
      if (serviceOptIn !== undefined) {
        return serviceOptIn;
      }
    }
    if (!selectedIds.has(id)) {
      return id === 'bottle_default' && targetBottleNeedsCreation;
    }
    if (targetBottleNeedsCreation && (id === 'bottle_default' || id.startsWith('bottle_'))) {
      return true;
    }
    if (comp?.status === 'ready' && !forceRepairIds?.has(id)) {
      return false;
    }
    return true;
  };

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
    const orderedRunnerEntries = RUNNER_COMPONENT_TO_TYPE.toSorted((a, b) => {
      const aChosen = a.runnerType === chosenRunner ? 0 : 1;
      const bChosen = b.runnerType === chosenRunner ? 0 : 1;
      return aChosen - bChosen;
    });

    for (const entry of orderedRunnerEntries) {
      if (shouldProvision(entry.componentId)) {
        const comp = snapshot.components[entry.componentId];
        const runnerTask: EnvironmentSetupTaskRequest = {
          action: 'install_runner',
          componentId: entry.componentId,
          runnerType: entry.runnerType,
        };
        if (comp?.status === 'update_available' || forceRepairIds?.has(entry.componentId)) {
          runnerTask.forceUpdate = true;
        }
        if (entry.componentId === 'runner_gptk' && gptkDmgPath && gptkDmgPath.trim()) {
          const trimmedPath = gptkDmgPath.trim();
          if (/\.dmg$/i.test(trimmedPath)) {
            runnerTask.dmgPath = trimmedPath;
          } else {
            runnerTask.archivePath = trimmedPath;
          }
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
  for (const hostClientId of HOST_CLIENT_COMPONENT_IDS) {
    if (shouldProvision(hostClientId)) {
      tasks.push({
        action: 'install_client',
        componentId: hostClientId,
      });
    }
  }

  // Stage 4b: Bottle storefront clients (macOS)
  if (isMac && !skipRunner) {
    for (const bottleClientId of BOTTLE_CLIENT_COMPONENT_IDS) {
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
      (t) => t.action === 'ensure_bottle' || t.componentId.startsWith('bottle_')
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
  private probeGeneration = 0;
  private activeRunId: string | null = null;
  private activeGuidedLoginTarget: ClientLoginTargetId | null = null;
  private runnerUpdateOptIn: Map<EnvironmentComponentId, boolean> = new Map();
  private runSeq = 0;
  private bottleSteamProvisionSeq = 0;
  private activeBottleSteamProvisionRunToken: number | null = null;
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
    const isManifestSyncEvent =
      event.action === 'sync_first_party_manifests' ||
      /sync.*manifest|installed game folders|local storefront game folders/i.test(
        event.message || ''
      );
    if (
      event.phase === 'completed' &&
      !isManifestSyncEvent &&
      isValidEnvironmentComponentId(event.componentId) &&
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
      this.runnerUpdateOptIn.delete(id);
      const existing = nextComponents[id];
      if (
        existing &&
        (existing.status === 'missing' ||
          existing.status === 'partially_configured' ||
          existing.status === 'update_available')
      ) {
        nextComponents[id] = {
          ...existing,
          status: 'ready',
          ...(existing.status === 'update_available' && existing.latestVersion
            ? { version: existing.latestVersion }
            : {}),
          defaultSelected: false,
          statusDetail: 'Installed.',
        };
        mutated = true;
      }
      if (
        isValidClientLoginTargetId(id) &&
        nextClientLogins[id] &&
        !nextClientLogins[id].installed
      ) {
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

  public getRunnerUpdateOptIn(componentId: EnvironmentComponentId): boolean | undefined {
    return this.runnerUpdateOptIn.get(componentId);
  }

  public setRunnerUpdateOptIn(componentId: EnvironmentComponentId, enabled: boolean): void {
    const prev = this.runnerUpdateOptIn.get(componentId);
    this.runnerUpdateOptIn.set(componentId, enabled);
    if (prev === enabled) {
      return;
    }
    if (this.lastSnapshot) {
      this.lastSnapshot = { ...this.lastSnapshot };
    }
    this.notifyListeners();
  }

  public clearRunnerUpdateOptIn(): void {
    if (this.runnerUpdateOptIn.size === 0) return;
    this.runnerUpdateOptIn.clear();
    if (this.lastSnapshot) {
      this.lastSnapshot = { ...this.lastSnapshot };
    }
    this.notifyListeners();
  }

  public probeHealth(
    connectedStorefronts?: StorefrontId[],
    options?: { forceFresh?: boolean; forceRefreshRunnerUpdates?: boolean }
  ): Promise<EnvironmentHealthSnapshot> {
    this.ensureProgressSubscription();
    const isForced = Boolean(options?.forceFresh || options?.forceRefreshRunnerUpdates);
    if (options?.forceFresh) {
      this.runnerUpdateOptIn.clear();
    }
    if (this.inFlightProbePromise && !isForced) {
      return this.inFlightProbePromise;
    }

    const generation = ++this.probeGeneration;
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
            ...(options?.forceFresh ? { forceFresh: true } : {}),
            ...(options?.forceRefreshRunnerUpdates
              ? { forceRefreshRunnerUpdates: true }
              : {}),
          });
          if (isCompleteHealthSnapshot(snapshot)) {
            if (generation === this.probeGeneration) {
              this.lastSnapshot = snapshot;
              this.notifyListeners();
              return snapshot;
            }
            return this.lastSnapshot ?? snapshot;
          }
        } catch (err) {
          console.warn('[EnvironmentSetupService] probeEnvironmentHealth failed:', err);
        }
        const preservedOrFallback =
          this.lastSnapshot ?? buildFallbackEnvironmentSnapshot(effectiveStorefronts);
        if (generation === this.probeGeneration) {
          this.lastSnapshot = preservedOrFallback;
          this.notifyListeners();
        }
        return preservedOrFallback;
      }

      const fallback = buildFallbackEnvironmentSnapshot(effectiveStorefronts);
      if (generation === this.probeGeneration) {
        this.lastSnapshot = fallback;
        this.notifyListeners();
        return fallback;
      }
      return this.lastSnapshot ?? fallback;
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
        ? patch.configuredComponents.filter(isValidEnvironmentComponentId)
        : current.configuredComponents
    );
    if (Array.isArray(patch.addConfiguredComponents)) {
      for (const id of patch.addConfiguredComponents) {
        if (isValidEnvironmentComponentId(id)) {
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
        const failedIds = new Set(
          normalizedOutcomes
            .filter((o) => o.status === 'failed' || o.status === 'cancelled')
            .map((o) => o.componentId)
        );
        const completedIds = normalizedOutcomes
          .filter(
            (o) =>
              o.action !== 'sync_first_party_manifests' &&
              !failedIds.has(o.componentId) &&
              (o.status === 'completed' || (o.status === 'skipped' && Boolean(o.installedPath)))
          )
          .map((o) => o.componentId);

        let resolvedSnapshot: EnvironmentHealthSnapshot;
        if (isCompleteHealthSnapshot(result?.snapshot)) {
          this.probeGeneration += 1;
          resolvedSnapshot = this.reconcileCompletedComponentsInSnapshot(
            result.snapshot,
            completedIds
          );
          this.lastSnapshot = resolvedSnapshot;
        } else {
          const probedAfterRun = await this.probeHealth(req.connectedStorefronts, {
            forceFresh: true,
          });
          this.probeGeneration += 1;
          resolvedSnapshot = this.reconcileCompletedComponentsInSnapshot(
            probedAfterRun,
            completedIds
          );
          this.lastSnapshot = resolvedSnapshot;
        }

        await Promise.allSettled([
          launcherService.detectCompatibilityLayers(),
          launcherService.detectInstalledStorefrontClients(),
          launcherService.checkCompatibilityLayerUpdates(),
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
          this.probeGeneration += 1;
          const nextClientLogins: Record<ClientLoginTargetId, ClientAuthProbeState> = {
            ...this.lastSnapshot.clientLogins,
            [req.targetId]: result.probeState,
          };
          const impliedReadyIds: EnvironmentComponentId[] = [];
          if (result.probeState.installed) {
            impliedReadyIds.push(req.targetId);
            if (req.targetId.startsWith('bottle_')) {
              impliedReadyIds.push('bottle_default');
              const runnerEntry = RUNNER_COMPONENT_TO_TYPE.find(
                (entry) => entry.runnerType === req.runnerType
              );
              if (runnerEntry) {
                impliedReadyIds.push(runnerEntry.componentId);
              }
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
          await Promise.allSettled([
            launcherService.detectCompatibilityLayers(),
            launcherService.detectInstalledStorefrontClients(),
          ]);
        }
        return result;
      }

      const storefrontId: ClientAuthProbeState['storefrontId'] =
        resolveStorefrontForLoginTarget(req.targetId) ??
        TARGET_TO_STOREFRONT_MAP[req.targetId] ??
        'steam';
      const scope: 'host' | 'bottle' =
        resolveScopeForLoginTarget(req.targetId) ??
        (req.targetId.startsWith('bottle_') ? 'bottle' : 'host');
      const catalogTarget = CLIENT_LOGIN_TARGET_CATALOG[req.targetId];
      const isMac = launcherService.getHostPlatform() === 'darwin';
      return {
        success: false,
        targetId: req.targetId,
        authenticated: false,
        probeState: {
          targetId: req.targetId,
          storefrontId,
          scope,
          label: catalogTarget ? (isMac ? catalogTarget.macLabel : catalogTarget.label) : req.targetId,
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

  public async provisionAndSignInBottleSteam(
    params: ProvisionBottleSteamParams
  ): Promise<ProvisionBottleSteamResult> {
    const trimmedBottle = params.bottleName.trim();
    if (!trimmedBottle || params.runnerType === 'native') {
      const errMsg = 'A compatibility runner and target bottle are required to set up Windows Steam.';
      return {
        success: false,
        installed: false,
        authenticated: false,
        message: errMsg,
        error: errMsg,
      };
    }

    const nonNativeRunnerType: Exclude<CompatibilityLayerType, 'native'> = params.runnerType;
    const token = ++this.bottleSteamProvisionSeq;
    this.activeBottleSteamProvisionRunToken = token;
    const isCancelled = (): boolean => this.activeBottleSteamProvisionRunToken !== token;

    let lastForwardedProgressRef = this.getLatestProgress();
    let lastForwardedProgressMsg = '';
    const unsubscribe = this.subscribe(() => {
      if (isCancelled()) return;
      const latest = this.getLatestProgress();
      if (
        latest &&
        latest !== lastForwardedProgressRef &&
        typeof latest.message === 'string' &&
        latest.message.trim() &&
        latest.message.trim() !== lastForwardedProgressMsg
      ) {
        lastForwardedProgressRef = latest;
        lastForwardedProgressMsg = latest.message.trim();
        params.onPhaseChange?.(lastForwardedProgressMsg);
      }
    });

    let installed = false;
    try {
      const initialMsg = params.needsInstall
        ? `Installing Windows Steam into "${trimmedBottle}"...`
        : params.needsSignIn
          ? `Linking installed Steam games & preparing sign-in in "${trimmedBottle}"...`
          : `Linking installed Steam games into "${trimmedBottle}"...`;
      lastForwardedProgressMsg = initialMsg;
      params.onPhaseChange?.(initialMsg);

      const setupResult = await this.runSetupTasks({
        tasks: [
          {
            componentId: 'bottle_steam',
            action: 'install_client',
            runnerType: nonNativeRunnerType,
            bottleName: trimmedBottle,
          },
        ],
        connectedStorefronts: ['steam'],
      });

      const bottleSteamOutcome = setupResult.outcomes.find((o) => o.componentId === 'bottle_steam');
      const step1Succeeded =
        Boolean(setupResult.success) &&
        bottleSteamOutcome?.status !== 'failed' &&
        bottleSteamOutcome?.status !== 'cancelled' &&
        bottleSteamOutcome?.status !== 'opened_external';

      if (step1Succeeded) {
        installed = true;
      }

      const step1Cancelled =
        Boolean(setupResult.cancelled) ||
        bottleSteamOutcome?.status === 'cancelled' ||
        isCancelled();
      if (step1Cancelled) {
        if (installed) {
          await Promise.allSettled([
            launcherService.detectCompatibilityLayers(),
            launcherService.detectInstalledStorefrontClients(),
          ]);
        }
        return {
          success: false,
          installed,
          authenticated: false,
          cancelled: true,
          message: `Cancelled Steam setup in "${trimmedBottle}".`,
        };
      }

      if (!step1Succeeded) {
        const errMsg =
          bottleSteamOutcome?.error ||
          setupResult.error ||
          bottleSteamOutcome?.message ||
          `Failed to install Windows Steam in "${trimmedBottle}".`;
        return {
          success: false,
          installed: false,
          authenticated: false,
          message: errMsg,
          error: errMsg,
        };
      }

      if (params.needsInstall || params.needsSignIn) {
        const signInPrompt = `Steam opened in "${trimmedBottle}" — sign in once (QR or password) to enable Steam Cloud...`;
        lastForwardedProgressMsg = signInPrompt;
        params.onPhaseChange?.(signInPrompt);

        const loginResult = await this.startGuidedLogin({
          targetId: 'bottle_steam',
          runnerType: nonNativeRunnerType,
          bottleName: trimmedBottle,
          autoCloseOnSuccess: true,
        });

        await Promise.allSettled([
          launcherService.detectCompatibilityLayers(),
          launcherService.detectInstalledStorefrontClients(),
        ]);

        const step2Cancelled = Boolean(loginResult.cancelled) || isCancelled();
        if (step2Cancelled) {
          return {
            success: false,
            installed: true,
            authenticated: Boolean(loginResult.authenticated),
            cancelled: true,
            message: `Windows Steam is installed in "${trimmedBottle}", but sign-in was cancelled.`,
          };
        }

        const authenticated = Boolean(loginResult.authenticated);
        if (!loginResult.success || !authenticated) {
          const errMsg =
            loginResult.error ||
            loginResult.message ||
            `Steam sign-in in "${trimmedBottle}" did not complete.`;
          return {
            success: false,
            installed: true,
            authenticated,
            message: errMsg,
            error: errMsg,
          };
        }

        return {
          success: true,
          installed: true,
          authenticated: true,
          message:
            loginResult.message || `Steam is ready and signed in inside "${trimmedBottle}".`,
        };
      }

      await Promise.allSettled([
        launcherService.detectCompatibilityLayers(),
        launcherService.detectInstalledStorefrontClients(),
      ]);

      return {
        success: true,
        installed: true,
        authenticated: true,
        message:
          bottleSteamOutcome?.message || `Linked installed Steam games into "${trimmedBottle}".`,
      };
    } catch (err: unknown) {
      const errMsg =
        err instanceof Error && err.message
          ? err.message
          : `Could not complete Windows Steam setup in "${trimmedBottle}".`;
      return {
        success: false,
        installed,
        authenticated: false,
        message: errMsg,
        error: errMsg,
      };
    } finally {
      unsubscribe();
      if (this.activeBottleSteamProvisionRunToken === token) {
        this.activeBottleSteamProvisionRunToken = null;
      }
    }
  }

  public async cancelBottleSteamProvisioning(): Promise<void> {
    this.activeBottleSteamProvisionRunToken = null;
    await Promise.allSettled([this.cancelActiveSetup(), this.cancelGuidedLogin('bottle_steam')]);
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

launcherService.registerPostRunnerMutationSyncHook(async () => {
  if (
    typeof window !== 'undefined' &&
    typeof window.electronAPI?.probeEnvironmentHealth === 'function'
  ) {
    await environmentSetupService.probeHealth(undefined, { forceFresh: true });
  }
});
