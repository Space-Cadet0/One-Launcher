/**
 * Pure bottle architecture compatibility and resolution helpers consolidating the
 * 5x duplicated UI logic across SystemSetupWizardModal, GameInstallModal,
 * useGameLaunchConfigForm, CompatibilityLayerSection, and CompatibilityAndBottleStep.
 *
 * Layer 2 (`services-launcher`) — imports only from Layer 0 contracts.
 */

import {
  isRunnerSupportedOnHost,
  resolveDefaultBottleForLayer,
  type CompatibilityLayerInfo,
  type CompatibilityLayerType,
} from '../../contracts/launcher';
import type { EnvironmentHealthSnapshot } from '../../contracts/environmentSetup';

export type BottleArchitecture = 'win64' | 'arm64';
export type BottleRunnerCandidate = CompatibilityLayerType | 'skip' | string;

export interface BottleArchDescriptor {
  name: string;
  wineArch?: BottleArchitecture;
  bottleArch?: BottleArchitecture;
}

export type LayerWithBottleDetails = Pick<CompatibilityLayerInfo, 'type' | 'bottleDetails'>;

export const DEFAULT_WIN64_BOTTLE_NAME = 'OneLauncher';
export const DEFAULT_ARM64_BOTTLE_NAME = 'OneLauncher-arm64';

const ARM64_BOTTLE_SUFFIX_RE = /-arm64$/i;
const DEFAULT_WIN64_BOTTLE_RE = /^OneLauncher$/i;
const BOTTLE_PATH_SEGMENT_RE = /(?:^|[\\/])Bottles[\\/]([^\\/]+)(?:[\\/]|$)/i;

/**
 * Extracts the CrossOver / Wine bottle folder name from a POSIX or Windows path
 * pointing inside `/.../Bottles/<BottleName>/...` (or ending at `/.../Bottles/<BottleName>`).
 */
export function extractBottleNameFromPath(p?: string | null): string | null {
  if (typeof p !== 'string') return null;
  const trimmed = p.trim();
  if (!trimmed) return null;
  const match = BOTTLE_PATH_SEGMENT_RE.exec(trimmed);
  const candidate = match?.[1]?.trim() || '';
  if (!candidate || candidate === '.' || candidate === '..') {
    return null;
  }
  return candidate;
}

function lookupBottleArchCaseInsensitive(
  bottleName: string,
  layers: ReadonlyArray<LayerWithBottleDetails | undefined>
): BottleArchitecture | undefined {
  const lower = bottleName.toLowerCase();
  for (const layer of layers) {
    const details = layer?.bottleDetails;
    if (!details) continue;
    const direct = details[bottleName]?.wineArch;
    if (direct) return direct;
    for (const [key, value] of Object.entries(details)) {
      if (key.toLowerCase() === lower && value?.wineArch) {
        return value.wineArch;
      }
    }
  }
  return undefined;
}

function layerKnowsBottle(layer: CompatibilityLayerInfo, bottleNameLower: string): boolean {
  if (layer.availableBottles?.some((b) => b.trim().toLowerCase() === bottleNameLower)) {
    return true;
  }
  if (layer.bottleDetails) {
    for (const key of Object.keys(layer.bottleDetails)) {
      if (key.trim().toLowerCase() === bottleNameLower) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Picks the best installed, host-supported compatibility runner for `bottleName`,
 * checking `bottleDetails[bottleName]?.wineArch` (falling back to bottle name suffix)
 * and preferring `crossover` -> `crossover_preview` -> `gptk` -> `wine` for `win64`
 * (matching `detectCompatibilityLayers` stability order) and `crossover_preview_arm64` for `arm64`.
 */
export function findCompatibleRunnerForBottle(
  bottleName: string,
  detectedLayers: CompatibilityLayerInfo[],
  options?: { hostPlatform?: string; hostArch?: string }
): CompatibilityLayerInfo | null {
  const trimmed = typeof bottleName === 'string' ? bottleName.trim() : '';
  if (!trimmed || !Array.isArray(detectedLayers) || detectedLayers.length === 0) {
    return null;
  }

  const trimmedLower = trimmed.toLowerCase();
  const detectedArch = lookupBottleArchCaseInsensitive(trimmed, detectedLayers);
  const targetArch: BottleArchitecture =
    detectedArch ?? (isArm64NamedBottle(trimmed) ? 'arm64' : 'win64');

  const hostPlatform = options?.hostPlatform || 'darwin';
  const fallbackHostArch =
    options?.hostArch || detectedLayers.find((layer) => Boolean(layer?.hostArch))?.hostArch;

  const compatibleCandidates = detectedLayers.filter((layer) => {
    if (!layer || layer.available === false || layer.type === 'native') {
      return false;
    }
    const runnerHostArch = options?.hostArch ?? layer.hostArch ?? fallbackHostArch;
    if (!isRunnerSupportedOnHost(layer.type, hostPlatform, runnerHostArch).supported) {
      return false;
    }
    if (Array.isArray(layer.supportedBottleArches) && layer.supportedBottleArches.length > 0) {
      return layer.supportedBottleArches.includes(targetArch);
    }
    if (targetArch === 'arm64') {
      return layer.type === 'crossover_preview_arm64';
    }
    return isBottleRecordCompatibleWithRunner(
      { name: trimmed, wineArch: targetArch },
      layer.type,
      { strictArm64NameMatch: false }
    );
  });

  if (compatibleCandidates.length === 0) {
    return null;
  }

  const preferenceOrder: readonly CompatibilityLayerType[] =
    targetArch === 'arm64'
      ? ['crossover_preview_arm64']
      : ['crossover', 'crossover_preview', 'gptk', 'wine'];

  const rankOf = (type: CompatibilityLayerType): number => {
    const idx = preferenceOrder.indexOf(type);
    return idx === -1 ? preferenceOrder.length : idx;
  };

  const candidatesWithBottle = compatibleCandidates.filter((layer) =>
    layerKnowsBottle(layer, trimmedLower)
  );
  const pool = candidatesWithBottle.length > 0 ? candidatesWithBottle : compatibleCandidates;

  const sorted = [...pool].sort((a, b) => rankOf(a.type) - rankOf(b.type));
  return sorted[0] ?? null;
}

/**
 * Returns the required bottle architecture for a CrossOver runner, or `null` when
 * the runner accepts any bottle architecture (e.g. Wine, GPTK, native, skip).
 */
export function getExpectedBottleArchForRunner(
  runnerType: BottleRunnerCandidate
): BottleArchitecture | null {
  if (runnerType === 'crossover_preview_arm64') {
    return 'arm64';
  }
  if (runnerType === 'crossover' || runnerType === 'crossover_preview') {
    return 'win64';
  }
  return null;
}

/**
 * Returns the canonical default bottle name for a given compatibility runner.
 */
export function getDefaultBottleNameForRunner(runnerType: BottleRunnerCandidate): string {
  return runnerType === 'crossover_preview_arm64'
    ? DEFAULT_ARM64_BOTTLE_NAME
    : DEFAULT_WIN64_BOTTLE_NAME;
}

export function isArm64NamedBottle(bottleName: string | undefined | null): boolean {
  if (!bottleName || typeof bottleName !== 'string') return false;
  return ARM64_BOTTLE_SUFFIX_RE.test(bottleName.trim());
}

export function isDefaultWin64NamedBottle(bottleName: string | undefined | null): boolean {
  if (!bottleName || typeof bottleName !== 'string') return false;
  return DEFAULT_WIN64_BOTTLE_RE.test(bottleName.trim());
}

/**
 * Looks up a bottle's detected `wineArch` across detected compatibility layers,
 * preferring the matching runner layer when provided.
 */
export function resolveBottleArchitectureFromLayers(
  bottleName: string | undefined | null,
  layers: ReadonlyArray<LayerWithBottleDetails | undefined>,
  preferredRunnerType?: BottleRunnerCandidate
): BottleArchitecture | undefined {
  const trimmed = typeof bottleName === 'string' ? bottleName.trim() : '';
  if (!trimmed) return undefined;

  if (preferredRunnerType) {
    const preferredLayer = layers.find((l) => l && l.type === preferredRunnerType);
    const preferredArch = preferredLayer?.bottleDetails?.[trimmed]?.wineArch;
    if (preferredArch) {
      return preferredArch;
    }
  }

  for (const layer of layers) {
    const arch = layer?.bottleDetails?.[trimmed]?.wineArch;
    if (arch) {
      return arch;
    }
  }

  return undefined;
}

/**
 * Checks whether an existing discovered bottle descriptor is compatible with `runnerType`.
 *
 * When explicit `wineArch` / `bottleArch` metadata is absent:
 * - For `crossover_preview_arm64`: requires `-arm64` suffix by default (`strictArm64NameMatch: true`)
 *   so untagged existing win64 bottles are not accidentally reused, or allows any non-`OneLauncher`
 *   name when `strictArm64NameMatch: false`.
 * - For `crossover` / `crossover_preview`: rejects `-arm64` suffixed bottles.
 */
export function isBottleRecordCompatibleWithRunner(
  bottle: BottleArchDescriptor,
  runnerType: BottleRunnerCandidate,
  options?: { strictArm64NameMatch?: boolean }
): boolean {
  const strictArm64NameMatch = options?.strictArm64NameMatch ?? true;
  const arch = bottle.wineArch || bottle.bottleArch;
  if (runnerType === 'crossover_preview_arm64') {
    if (arch) return arch === 'arm64';
    return strictArm64NameMatch
      ? isArm64NamedBottle(bottle.name)
      : !isDefaultWin64NamedBottle(bottle.name);
  }
  if (runnerType === 'crossover' || runnerType === 'crossover_preview') {
    if (arch) return arch === 'win64';
    return !isArm64NamedBottle(bottle.name);
  }
  return true;
}

export interface BottleNameCompatibilityOptions {
  bottleArch?: BottleArchitecture;
  layer?: LayerWithBottleDetails;
  allLayers?: ReadonlyArray<LayerWithBottleDetails | undefined>;
  allowEmpty?: boolean;
  strictArm64NameMatch?: boolean;
}

/**
 * Checks whether a bottle name (with optional layer metadata) is compatible with `runnerType`.
 * Covers `GameInstallModal`, `useGameLaunchConfigForm`, and `CompatibilityLayerSection`.
 */
export function isBottleNameCompatibleWithRunner(
  bottleName: string | undefined | null,
  runnerType: BottleRunnerCandidate,
  options?: BottleNameCompatibilityOptions
): boolean {
  const trimmed = typeof bottleName === 'string' ? bottleName.trim() : '';
  if (!trimmed) {
    return options?.allowEmpty ?? true;
  }

  const layersToInspect: Array<LayerWithBottleDetails | undefined> = [];
  if (options?.layer) layersToInspect.push(options.layer);
  if (options?.allLayers) layersToInspect.push(...options.allLayers);

  const arch =
    options?.bottleArch ??
    resolveBottleArchitectureFromLayers(trimmed, layersToInspect, runnerType);

  return isBottleRecordCompatibleWithRunner(
    { name: trimmed, wineArch: arch },
    runnerType,
    { strictArm64NameMatch: options?.strictArm64NameMatch ?? false }
  );
}

/**
 * Returns `true` when a non-empty selected bottle conflicts with the architecture required
 * by `runnerType` (matching `CompatibilityLayerSection`'s mismatch banner semantics).
 */
export function hasBottleArchitectureMismatch(
  bottleName: string | undefined | null,
  runnerType: BottleRunnerCandidate,
  options?: Omit<BottleNameCompatibilityOptions, 'allowEmpty'>
): boolean {
  const trimmed = typeof bottleName === 'string' ? bottleName.trim() : '';
  if (!trimmed) return false;
  return !isBottleNameCompatibleWithRunner(trimmed, runnerType, {
    ...options,
    allowEmpty: true,
  });
}

/**
 * Validates whether a persisted bottle name from wizard state is compatible with `runnerType`
 * given the current `EnvironmentHealthSnapshot`.
 */
export function isPersistedBottleCompatibleWithRunner(
  bottleName: string,
  runnerType: Exclude<CompatibilityLayerType, 'native'> | 'skip',
  snap: Pick<EnvironmentHealthSnapshot, 'bottleSummary'>
): boolean {
  if (runnerType === 'skip') return true;
  const avail = snap.bottleSummary?.availableBottles ?? [];
  const existing = avail.find((b) => b.name === bottleName);
  if (existing) {
    return isBottleRecordCompatibleWithRunner(existing, runnerType, {
      strictArm64NameMatch: true,
    });
  }
  return isBottleNameCompatibleWithRunner(bottleName, runnerType, {
    strictArm64NameMatch: false,
  });
}

/**
 * Resolves the default bottle name for `runnerType` from an `EnvironmentHealthSnapshot`,
 * preferring an existing architecture-compatible bottle before falling back to canonical names.
 */
export function resolveDefaultBottleForRunner(
  runnerType: Exclude<CompatibilityLayerType, 'native'> | 'skip',
  snap: Pick<EnvironmentHealthSnapshot, 'bottleSummary'>
): string {
  const avail = snap.bottleSummary?.availableBottles ?? [];
  const compatMatch = avail.find((b) =>
    isBottleRecordCompatibleWithRunner(b, runnerType, { strictArm64NameMatch: true })
  );
  if (compatMatch) {
    return compatMatch.name;
  }

  const recommended = snap.bottleSummary?.recommendedBottleName;
  if (runnerType === 'crossover_preview_arm64') {
    return recommended && isArm64NamedBottle(recommended)
      ? recommended
      : DEFAULT_ARM64_BOTTLE_NAME;
  }
  return recommended && !isArm64NamedBottle(recommended)
    ? recommended
    : DEFAULT_WIN64_BOTTLE_NAME;
}

export interface ResolveInstallBottleForRunnerParams {
  savedBottleName?: string;
  savedRunner?: string;
  resolvedRunner: string;
  hostLayers: CompatibilityLayerInfo[];
  allLayers?: CompatibilityLayerInfo[];
  hostArch?: string;
}

/**
 * Resolves the effective bottle name for `GameInstallModal` when a saved bottle/runner pair
 * may have been downgraded or orphaned on the current host architecture.
 */
export function resolveInstallBottleForRunner(
  params: ResolveInstallBottleForRunnerParams
): string {
  const { savedBottleName, savedRunner, resolvedRunner, hostLayers, allLayers, hostArch } = params;
  const trimmedBottle = savedBottleName?.trim() || '';
  if (!trimmedBottle) return '';

  const resolvedLayer = hostLayers.find((l) => l.type === resolvedRunner) || hostLayers[0];
  const availableBottles = resolvedLayer?.availableBottles || [];
  const compatibleBottles = availableBottles.filter((b) =>
    isBottleNameCompatibleWithRunner(b, resolvedRunner, {
      layer: resolvedLayer,
      allLayers,
    })
  );

  const fallbackBottle =
    compatibleBottles.length > 0
      ? resolveDefaultBottleForLayer(
          {
            type: resolvedRunner as CompatibilityLayerType,
            availableBottles: compatibleBottles,
            bottleDetails: resolvedLayer?.bottleDetails,
          },
          resolvedRunner
        ) || ''
      : '';

  if (!availableBottles.includes(trimmedBottle)) {
    return fallbackBottle;
  }

  const bottleArch = resolveBottleArchitectureFromLayers(
    trimmedBottle,
    [resolvedLayer, ...(allLayers || [])],
    resolvedRunner
  );

  const isCompatibleWithResolved =
    isBottleNameCompatibleWithRunner(trimmedBottle, resolvedRunner, {
      bottleArch,
      layer: resolvedLayer,
      allLayers,
    }) &&
    !(
      (resolvedRunner === 'crossover' || resolvedRunner === 'crossover_preview') &&
      bottleArch === 'arm64'
    ) &&
    !(resolvedRunner === 'crossover_preview_arm64' && bottleArch === 'win64');

  const wasRunnerRejectedOrDowngraded = Boolean(
    savedRunner && savedRunner !== 'native' && savedRunner !== resolvedRunner
  );

  if (!isCompatibleWithResolved && (wasRunnerRejectedOrDowngraded || hostArch !== 'arm64')) {
    return fallbackBottle;
  }

  return trimmedBottle;
}
