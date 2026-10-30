import type { CanonicalGame } from './game';
import type { SteamEnrichedMetadata } from './steam';

export type TransientErrorReason =
  | 'offline'
  | 'timeout'
  | 'rate_limited'
  | 'waf_blocked'
  | 'http_5xx'
  | 'circuit_open';

export type FetchOutcome<T> =
  | {
      status: 'ok';
      data: T;
      fromCache?: boolean;
      stale?: boolean;
    }
  | {
      status: 'not_found';
      statusCode?: number;
    }
  | {
      status: 'transient_error';
      reason: TransientErrorReason;
      retryAfterMs?: number;
      statusCode?: number;
    };

export type MetadataQuality =
  | 'authoritative'
  | 'scraped'
  | 'storefront_native'
  | 'local_federated'
  | 'skeleton_fallback';

export type OfflineVaultTier = 'compact' | 'balanced' | 'max_offline' | 'full_archive';

export type OfflineAssetRole =
  | 'cover'
  | 'header'
  | 'icon'
  | 'screenshot_thumb'
  | 'screenshot_full'
  | 'inline_img'
  | 'inline_poster';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface EndpointHealthSnapshot {
  host: string;
  state: CircuitBreakerState;
  consecutiveFailures: number;
  openedUntil: number;
  lastStatusCode?: number;
  lastError?: string;
}

export interface OfflineVaultStats {
  tier: OfflineVaultTier;
  maxBytes: number;
  sqliteBytes: number;
  blobBytes: number;
  totalBytes: number;
  blobCount: number;
  federatedAssetCount: number;
  totalGames: number;
  enrichedGames: number;
  pendingAssets: number;
  isHydrating: boolean;
  isSuspendedInGame: boolean;
}

export interface OfflineVaultGameDetail {
  gameId: string;
  enrichedMetadata?: SteamEnrichedMetadata | null;
  achievements?: Record<string, unknown> | null;
  hltb?: Record<string, unknown> | null;
  criticScore?: Record<string, unknown> | null;
  metadataQuality?: MetadataQuality;
  enrichedAt?: number;
}

export interface OfflineHydrationProgressPayload {
  isHydrating: boolean;
  isSuspendedInGame: boolean;
  completedGames: number;
  totalGames: number;
  pendingAssets: number;
  activeGameId?: string;
}

export const OFFLINE_VAULT_TIER_CAPS: Record<OfflineVaultTier, number> = {
  compact: 150 * 1024 * 1024,
  balanced: 350 * 1024 * 1024,
  max_offline: 1536 * 1024 * 1024,
  full_archive: 1536 * 1024 * 1024,
};

/**
 * Adaptive 404 retry schedule (never Infinity so fixed/re-listed store pages always self-heal):
 * - 1st 404: 6 hours (launch-day CDN propagation lag / publisher upload fix)
 * - 2nd 404: 24 hours
 * - 3rd 404: 7 days
 * - 4th+ 404: 30 days (delisted classics that may be re-listed months later)
 */
export function computeAdaptive404RetryDelayMs(failureCount: number): number {
  const count = Math.max(1, Math.floor(failureCount || 1));
  if (count === 1) return 6 * 60 * 60 * 1000;
  if (count === 2) return 24 * 60 * 60 * 1000;
  if (count === 3) return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

/**
 * Detects WAF / bot-protection challenge responses (Cloudflare, Akamai, PerimeterX, CAPTCHA)
 * so scrapers and JSON APIs never misclassify a bot-protection block as a 404 "not found".
 */
export function isWafOrChallengeResponse(
  status: number | undefined,
  body: unknown,
  headers?: Record<string, unknown> | Headers,
  expectedJson: boolean = false
): boolean {
  let cfMitigated: unknown;
  if (headers && typeof headers === 'object') {
    if ('get' in headers && typeof (headers as Headers).get === 'function') {
      cfMitigated =
        (headers as Headers).get('cf-mitigated') || (headers as Headers).get('CF-Mitigated');
    } else {
      const rec = headers as Record<string, unknown>;
      cfMitigated = rec['cf-mitigated'] || rec['CF-Mitigated'];
    }
  }
  if (cfMitigated) return true;

  if (status === 429) return true;

  if (typeof body === 'string') {
    const sample = body.slice(0, 4096);
    if (
      /cf-chl-bypass|cf-browser-verification|Just a moment\.\.\.|Attention Required! \| Cloudflare|Access Denied.*Reference #\d|PerimeterX|px-captcha|g-recaptcha|hcaptcha/i.test(
        sample
      )
    ) {
      return true;
    }
    if (expectedJson && /^\s*<!doctype html|^\s*<html/i.test(sample)) {
      return true;
    }
  }

  return status === 403;
}

interface NetworkErrorLike {
  isCircuitOpen?: boolean;
  retryAfterMs?: number;
  isRateLimited?: boolean;
  cooldownRemaining?: number;
  status?: number;
  code?: string;
  message?: string;
  response?: {
    status?: number;
    headers?: Record<string, string | string[] | undefined>;
    data?: unknown;
  };
}

/**
 * Classifies an Axios/fetch error into a structured transient or not_found outcome.
 */
export function classifyNetworkError(err: unknown): FetchOutcome<never> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { status: 'transient_error', reason: 'offline' };
  }

  const netErr: NetworkErrorLike =
    err && typeof err === 'object' ? (err as NetworkErrorLike) : {};

  if (netErr.isCircuitOpen) {
    return {
      status: 'transient_error',
      reason: 'circuit_open',
      retryAfterMs: typeof netErr.retryAfterMs === 'number' ? netErr.retryAfterMs : undefined,
    };
  }

  const status: number | undefined = netErr.response?.status ?? netErr.status;
  const headers = netErr.response?.headers;
  const body = netErr.response?.data;

  if (netErr.isRateLimited || status === 429) {
    const retryHeader = headers?.['retry-after'] ?? headers?.['Retry-After'];
    const retrySec = Number(Array.isArray(retryHeader) ? retryHeader[0] : retryHeader);
    return {
      status: 'transient_error',
      reason: 'rate_limited',
      statusCode: 429,
      retryAfterMs:
        Number.isFinite(retrySec) && retrySec > 0
          ? retrySec * 1000
          : typeof netErr.cooldownRemaining === 'number' && netErr.cooldownRemaining > 0
          ? netErr.cooldownRemaining * 1000
          : 15 * 60 * 1000,
    };
  }

  if (isWafOrChallengeResponse(status, body, headers)) {
    return {
      status: 'transient_error',
      reason: 'waf_blocked',
      statusCode: status ?? 403,
      retryAfterMs: 15 * 60 * 1000,
    };
  }

  if (status === 404) {
    return { status: 'not_found', statusCode: 404 };
  }

  if (typeof status === 'number' && status >= 500) {
    return {
      status: 'transient_error',
      reason: 'http_5xx',
      statusCode: status,
    };
  }

  const code = String(netErr.code || '');
  const msg = String(netErr.message || '');
  if (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    /timeout|timed out|aborted/i.test(msg)
  ) {
    return { status: 'transient_error', reason: 'timeout' };
  }

  return { status: 'transient_error', reason: 'offline' };
}

export interface OlMediaUrlParams {
  url?: string | null;
  gameId?: string | null;
  role: OfflineAssetRole;
  ordinal?: number;
  steamAppId?: number | string | null;
  gogId?: string | null;
  epicAppName?: string | null;
  xboxProductId?: string | null;
  packageFamilyName?: string | null;
  xboxTitleId?: string | null;
  ov?: boolean | string | null;
}

/**
 * Wraps an upstream http(s) media URL (or local storefront identifier) into a deterministic
 * `ol-media://asset?...` URL when running inside Electron with `offlineVault` active.
 * In pure browser/Vitest environments without `window.electronAPI.offlineVault`, returns
 * the original URL unchanged so existing unit tests remain 100% compatible.
 */
export function toOlMediaUrl(params: OlMediaUrlParams): string {
  const trimmedUrl = typeof params.url === 'string' ? params.url.trim() : '';
  const rawUrl = trimmedUrl.startsWith('//') ? `https:${trimmedUrl}` : trimmedUrl;
  if (rawUrl.startsWith('ol-media://') || rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) {
    return rawUrl;
  }

  const hasVaultBridge =
    typeof window !== 'undefined' &&
    Boolean(window.electronAPI?.isElectron && window.electronAPI?.offlineVault);

  if (!hasVaultBridge) {
    return rawUrl;
  }

  const hasFederationKey = Boolean(
    params.steamAppId ||
      params.gogId ||
      params.epicAppName ||
      params.xboxProductId ||
      params.packageFamilyName ||
      params.xboxTitleId
  );
  if (!rawUrl && !hasFederationKey) {
    return '';
  }

  if (rawUrl && !/^https?:\/\//i.test(rawUrl)) {
    return rawUrl;
  }

  const search = new URLSearchParams();
  if (params.gameId) search.set('gameId', String(params.gameId));
  search.set('role', params.role);
  search.set('ord', String(params.ordinal ?? 0));
  if (rawUrl) search.set('url', rawUrl);
  if (params.steamAppId !== undefined && params.steamAppId !== null && String(params.steamAppId)) {
    search.set('steamAppId', String(params.steamAppId));
  }
  if (params.gogId) search.set('gogId', String(params.gogId));
  if (params.epicAppName) search.set('epicApp', String(params.epicAppName));
  if (params.xboxProductId) search.set('xboxProductId', String(params.xboxProductId));
  if (params.packageFamilyName) search.set('pfn', String(params.packageFamilyName));
  if (params.xboxTitleId) search.set('xboxTitleId', String(params.xboxTitleId));
  if (params.ov) {
    search.set('ov', typeof params.ov === 'string' ? params.ov : '1');
  }

  return `ol-media://asset?${search.toString()}`;
}

/**
 * Extracts the underlying upstream `https://` URL if wrapped inside an `ol-media://` URL.
 */
export function unwrapOlMediaUrl(maybeWrappedUrl?: string | null): string {
  if (!maybeWrappedUrl) return '';
  if (!maybeWrappedUrl.startsWith('ol-media://')) return maybeWrappedUrl;
  try {
    const parsed = new URL(maybeWrappedUrl);
    return parsed.searchParams.get('url') || maybeWrappedUrl;
  } catch {
    return maybeWrappedUrl;
  }
}

export type VaultCatalogSyncItem = Pick<
  CanonicalGame,
  | 'id'
  | 'title'
  | 'steamAppId'
  | 'capsuleImage'
  | 'headerImage'
  | 'iconUrl'
  | 'shortDescription'
  | 'detailedDescription'
  | 'releaseDate'
  | 'developers'
  | 'publishers'
  | 'genres'
  | 'tags'
  | 'platforms'
  | 'enrichedMetadata'
>;
