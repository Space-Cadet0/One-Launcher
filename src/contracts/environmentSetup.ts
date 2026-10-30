import type { CompatibilityLayerInfo, CompatibilityLayerType } from './launcher';
import type { StorefrontId } from './platform';

export type EnvironmentComponentId =
  | 'rosetta2'
  | 'win_vcredist'
  | 'win_webview2'
  | 'runner_crossover'
  | 'runner_crossover_preview'
  | 'runner_wine'
  | 'runner_gptk'
  | 'bottle_default'
  | 'host_steam'
  | 'bottle_steam'
  | 'host_gog'
  | 'bottle_gog'
  | 'host_epic'
  | 'bottle_epic'
  | 'xbox_runtime';

export type EnvironmentComponentCategory =
  | 'os_prerequisite'
  | 'compatibility_runner'
  | 'bottle'
  | 'host_client'
  | 'bottle_client'
  | 'built_in_runtime';

export type EnvironmentComponentStatus =
  | 'ready'
  | 'partially_configured'
  | 'missing'
  | 'update_available'
  | 'not_applicable';

export type RecommendationTier =
  | 'required'
  | 'recommended'
  | 'optional'
  | 'not_needed'
  | 'built_in';

export type ClientLoginTargetId =
  | 'host_steam'
  | 'bottle_steam'
  | 'host_gog'
  | 'bottle_gog'
  | 'host_epic'
  | 'bottle_epic';

export type SetupWizardStepId =
  | 'prerequisites'
  | 'accounts'
  | 'compatibility'
  | 'clients'
  | 'client_logins'
  | 'summary';

export type SetupWizardOpenMode = 'first_launch' | 'health_check' | 'repair';

export interface DiscoveredLocalStoreHint {
  storefrontId: 'steam' | 'gog' | 'epic';
  sourceLabel: string;
  hasReusableSession: boolean;
  /** Non-secret public persona or SteamID hint when locally readable for user convenience */
  publicHandleHint?: string;
  publicSteamId?: string;
}

export interface ClientAuthProbeState {
  targetId: ClientLoginTargetId;
  storefrontId: 'steam' | 'gog' | 'epic';
  scope: 'host' | 'bottle';
  label: string;
  installed: boolean;
  binaryPath?: string;
  bottleName?: string;
  bottlePath?: string;
  authenticated: boolean;
  autoLoginEnabled?: boolean;
  detectedAccountLabel?: string;
  /**
   * `true` when client login matches connected One Launcher account,
   * `false` when logged into a different account than One Launcher,
   * `null` when One Launcher account is unconnected or identity cannot be compared.
   */
  accountMatchesOneLauncher: boolean | null;
  mismatchReason?: string;
  statusSummary: string;
}

export interface EnvironmentComponentState {
  id: EnvironmentComponentId;
  category: EnvironmentComponentCategory;
  storefrontId?: StorefrontId;
  scope?: 'host' | 'bottle' | 'system';
  title: string;
  shortLabel: string;
  status: EnvironmentComponentStatus;
  version?: string;
  latestVersion?: string;
  binaryPath?: string;
  installLocation?: string;
  wasPreviouslyConfigured?: boolean;
  canAutoInstall: boolean;
  requiresExternalDownload?: boolean;
  externalDownloadUrl?: string;
  estimatedDownloadMB?: number;
  recommendationTier: RecommendationTier;
  recommendationBadge: string;
  defaultSelected: boolean;
  whyExplanation: string;
  footprintNote?: string;
  tradeoffNote?: string;
  statusDetail: string;
}

export interface BottleEnvironmentSummary {
  runnerType: Exclude<CompatibilityLayerType, 'native'> | null;
  runnerName?: string;
  runnerInstalled: boolean;
  availableBottles: Array<{
    name: string;
    path: string;
    runnerType: Exclude<CompatibilityLayerType, 'native'>;
    hasSteam: boolean;
    hasGogGalaxy: boolean;
    hasEpicLauncher: boolean;
    isSandboxed: boolean;
  }>;
  recommendedBottleMode: 'reuse_existing' | 'create_dedicated';
  recommendedBottleName: string;
  activeBottlePath?: string;
}

export interface EnvironmentHealthSnapshot {
  probedAt: string;
  probeDurationMs: number;
  hostPlatform: 'darwin' | 'win32' | 'linux';
  hostArch: string;
  isAppleSiliconMac: boolean;
  hasWriteAccessToSystemApplications: boolean;
  preferredMacApplicationsDir: string;
  connectedStorefronts: StorefrontId[];
  bundledHelpers: {
    gogdlReady: boolean;
    gogdlPath?: string;
    legendaryReady: boolean;
    legendaryPath?: string;
    xboxGdkBridgesReady: boolean;
    metalPreloadReady: boolean;
  };
  detectedRunners: CompatibilityLayerInfo[];
  bottleSummary: BottleEnvironmentSummary;
  components: Record<EnvironmentComponentId, EnvironmentComponentState>;
  clientLogins: Record<ClientLoginTargetId, ClientAuthProbeState>;
  localStoreHints: DiscoveredLocalStoreHint[];
  counts: {
    readyCount: number;
    missingRecommendedCount: number;
    removedSinceLastSetupCount: number;
    pendingClientLoginCount: number;
    accountMismatchCount: number;
    updateAvailableCount: number;
  };
}

export interface EnvironmentSetupTaskRequest {
  action:
    | 'install_rosetta2'
    | 'install_win_vcredist'
    | 'install_runner'
    | 'ensure_bottle'
    | 'install_client'
    | 'sync_first_party_manifests';
  componentId: EnvironmentComponentId;
  runnerType?: Exclude<CompatibilityLayerType, 'native'>;
  bottleMode?: 'reuse_existing' | 'create_dedicated';
  bottleName?: string;
  dmgPath?: string;
}

export interface RunEnvironmentSetupRequest {
  runId?: string;
  tasks: EnvironmentSetupTaskRequest[];
  connectedStorefronts?: StorefrontId[];
}

export type EnvironmentSetupPhase =
  | 'queued'
  | 'probing'
  | 'downloading'
  | 'verifying_signature'
  | 'extracting'
  | 'installing'
  | 'configuring_bottle'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'cancelled'
  | 'guided_login_waiting'
  | 'guided_login_detected';

export interface EnvironmentSetupProgressEvent {
  runId: string;
  componentId: EnvironmentComponentId | ClientLoginTargetId;
  stepIndex: number;
  totalSteps: number;
  phase: EnvironmentSetupPhase;
  /** Determinate 0..100 percentage; omit/undefined when indeterminate */
  progressPercent?: number;
  bytesDownloaded?: number;
  totalBytes?: number;
  message: string;
  error?: string;
  openedExternalUrl?: string;
}

export interface EnvironmentSetupTaskOutcome {
  componentId: EnvironmentComponentId;
  action: EnvironmentSetupTaskRequest['action'];
  status: 'completed' | 'skipped' | 'failed' | 'cancelled' | 'opened_external';
  message: string;
  error?: string;
  installedPath?: string;
  openedExternalUrl?: string;
}

export interface RunEnvironmentSetupResult {
  success: boolean;
  runId: string;
  cancelled?: boolean;
  outcomes: EnvironmentSetupTaskOutcome[];
  snapshot: EnvironmentHealthSnapshot;
  error?: string;
}

export interface StartGuidedClientLoginRequest {
  targetId: ClientLoginTargetId;
  runnerType?: Exclude<CompatibilityLayerType, 'native'>;
  bottleName?: string;
  autoCloseOnSuccess?: boolean;
  forceInteractiveLogin?: boolean;
  timeoutMs?: number;
}

export interface GuidedClientLoginResult {
  success: boolean;
  targetId: ClientLoginTargetId;
  authenticated: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
  autoClosedClient?: boolean;
  probeState: ClientAuthProbeState;
  message: string;
  error?: string;
}

export interface SetupWizardPersistedState {
  schemaVersion: 1;
  completedAt: string | null;
  dismissedAt: string | null;
  lastHealthCheckAt: string | null;
  preferredRunnerType?: Exclude<CompatibilityLayerType, 'native'> | 'skip';
  preferredBottleName?: string;
  configuredComponents: EnvironmentComponentId[];
  allowAutoOpenInTest?: boolean;
}
