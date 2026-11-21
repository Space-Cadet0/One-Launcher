import { useState, useEffect, useRef } from 'react';
import type { StorefrontId } from '../contracts/platform';
import type { StorefrontIntegration } from '../contracts/integration';
import type { CanonicalGame, XboxGamePassSyncMode } from '../contracts/game';
import type {
  AchievementSummaryEntry,
  SavedStoreTokensMap,
  StorefrontAuthResult,
  StorefrontCredentialsInput,
  StorefrontTokenSummary,
} from '../types/electron';
import {
  reconcileNativeStorefrontAuthSessions,
  sanitizePublicCredentials,
  scrubPersistedIntegrationSecrets,
} from '../services/integrations/storefrontAuthReconciler';
import {
  loadIntegrations,
  saveIntegrations,
  loadCurrentCatalog,
  saveCurrentCatalog,
  mergeStorefrontGames,
  connectSteamIntegration,
  connectGogIntegration,
  connectEpicIntegration,
  connectXboxIntegration,
  disconnectIntegration,
  loadXboxProfileState,
  saveXboxProfileState,
  formatXboxIntegrationStatusMessage,
  type XboxCachedProfileState,
} from '../services/integrations/integrationStorage';
import { xboxIntegration } from '../services/integrations/xboxIntegration';
import { cacheUserXboxAchievements } from '../services/storage/knownGameAchievements';
import { normalizeGogAvatarUrl } from '../services/integrations/gogIntegration';

export interface StoreAuthConfig {
  url: string;
  title: string;
  width: number;
  height: number;
  storeName: string;
}

export const STORE_AUTH_CONFIGS: Record<StorefrontId, StoreAuthConfig> = {
  gog: {
    url: 'https://login.gog.com/auth?client_id=46899977096215655&layout=client2&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient&response_type=code',
    title: 'GOG.com Sign In',
    width: 480,
    height: 680,
    storeName: 'GOG.com',
  },
  steam: {
    url: 'https://steamcommunity.com/login/home/?goto=',
    title: 'Steam Community Sign In',
    width: 600,
    height: 720,
    storeName: 'Steam',
  },
  epic: {
    url: 'https://www.epicgames.com/id/login?redirectUrl=https%3A%2F%2Fwww.epicgames.com%2Fid%2Fapi%2Fredirect%3FclientId%3D34a02cf8f4414e29b15921876da36f9a%26responseType%3Dcode',
    title: 'Epic Games Sign In',
    width: 520,
    height: 720,
    storeName: 'Epic Games Store',
  },
  xbox: {
    url: 'https://login.live.com/oauth20_authorize.srf?client_id=00000000402b5328&response_type=code&scope=service%3A%3Auser.auth.xboxlive.com%3A%3AMBI_SSL&redirect_uri=https%3A%2F%2Flogin.live.com%2Foauth20_desktop.srf',
    title: 'Xbox / Microsoft Sign In',
    width: 500,
    height: 680,
    storeName: 'Xbox Live',
  },
  amazon: {
    url: 'https://gaming.amazon.com/',
    title: 'Amazon Games Sign In',
    width: 500,
    height: 680,
    storeName: 'Amazon Games',
  },
  ubisoft: {
    url: 'https://connect.ubisoft.com/',
    title: 'Ubisoft Connect Sign In',
    width: 500,
    height: 680,
    storeName: 'Ubisoft Connect',
  },
  ea: {
    url: 'https://www.ea.com/',
    title: 'EA App Sign In',
    width: 500,
    height: 680,
    storeName: 'EA App',
  },
  bnet: {
    url: 'https://battle.net/',
    title: 'Battle.net Sign In',
    width: 500,
    height: 680,
    storeName: 'Battle.net',
  },
  itch: {
    url: 'https://itch.io/login',
    title: 'itch.io Sign In',
    width: 500,
    height: 680,
    storeName: 'itch.io',
  },
  rockstar: {
    url: 'https://socialclub.rockstargames.com/',
    title: 'Rockstar Games Sign In',
    width: 500,
    height: 680,
    storeName: 'Rockstar Games',
  },
  humble: {
    url: 'https://www.humblebundle.com/login',
    title: 'Humble Bundle Sign In',
    width: 500,
    height: 680,
    storeName: 'Humble Bundle',
  },
  custom: {
    url: '',
    title: 'Custom Sign In',
    width: 500,
    height: 680,
    storeName: 'Custom',
  },
};

export interface XboxStatusSnapshot {
  connected: boolean;
  accountName?: string;
  gamertag?: string;
  modernGamertag?: string;
  xuid?: string;
  avatarUrl?: string;
  gamerpicUrl?: string;
  gamerscore?: number;
  subscription?: XboxCachedProfileState['subscription'];
  syncMode?: XboxGamePassSyncMode;
  hasDeviceContext?: boolean;
  error?: string;
}

export type NativeSyncResultPayload = Partial<StorefrontAuthResult> & {
  gamerpicUrl?: string;
  hasDeviceContext?: boolean;
  authoritativeComplete?: boolean;
  transientOffline?: boolean;
  tokenData?: StorefrontTokenSummary | null;
  achievements?: Record<string, AchievementSummaryEntry>;
};

export function getAuthErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  return fallback;
}

export function extractAuthCodeFromUrlCandidate(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  try {
    const parsedUrl = new URL(
      /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
    );
    const code = parsedUrl.searchParams.get('code');
    if (code && code.trim().length >= 8) {
      return code.trim();
    }
    if (parsedUrl.hash) {
      const hashParams = new URLSearchParams(parsedUrl.hash.replace(/^#/, ''));
      const hashCode = hashParams.get('code');
      if (hashCode && hashCode.trim().length >= 8) {
        return hashCode.trim();
      }
    }
  } catch {
    // Not a full URL; caller falls back to query/token pattern matching
  }
  return null;
}

export function extractCodeFromInput(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();

  // Check for JSON response format e.g. {"authorizationCode": "..."}
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.authorizationCode === 'string' && parsed.authorizationCode.trim()) {
        return parsed.authorizationCode.trim();
      }
      if (typeof parsed.code === 'string' && parsed.code.trim()) {
        return parsed.code.trim();
      }
      if (typeof parsed.redirectUrl === 'string') {
        const fromRedirect = extractAuthCodeFromUrlCandidate(parsed.redirectUrl);
        if (fromRedirect) return fromRedirect;
      }
    } catch {
      // Fall through to regex
    }
  }

  // Direct JSON substring match
  const authCodeJsonMatch = trimmed.match(/"authorizationCode"\s*:\s*"([a-zA-Z0-9_\-.!*]+)"/i);
  if (authCodeJsonMatch) return authCodeJsonMatch[1];

  const urlCode = extractAuthCodeFromUrlCandidate(trimmed);
  if (urlCode && urlCode.length >= 16) {
    return urlCode;
  }

  const queryMatch =
    trimmed.match(/[?&]code=([^&#\s]{16,})/i) ||
    trimmed.match(/(?:^|\s)code=([a-zA-Z0-9._\-!*]{16,})/i);
  if (queryMatch) {
    try {
      return decodeURIComponent(queryMatch[1]);
    } catch {
      return queryMatch[1];
    }
  }

  // Microsoft Live OAuth authorization code (e.g. M.C507_BAY.2.U.... or M.R3_BAY....)
  if (/^M\.[A-Za-z0-9._\-!*]{16,}$/.test(trimmed)) {
    return trimmed;
  }

  // Epic 32-character hex authorization code
  const hex32Match = trimmed.match(/\b([a-fA-F0-9]{32})\b/);
  if (hex32Match) {
    return hex32Match[1];
  }

  // Pure authorization code (GOG codes or other alphanumeric tokens)
  if (/^[a-zA-Z0-9_\-]{28,64}$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

export function shouldRefreshXboxSubscription(
  cachedXbox: XboxCachedProfileState | null,
  nowMs = Date.now()
): boolean {
  const cachedSub = cachedXbox?.subscription;
  const cachedEndIso = cachedSub?.earliestActivePassEndDate || cachedSub?.endDate;
  const cachedCheckedMs = cachedSub?.checkedAt ? Date.parse(cachedSub.checkedAt) : Number.NaN;
  const cachedEndMs = cachedEndIso ? Date.parse(cachedEndIso) : Number.NaN;
  return Boolean(
    !cachedSub ||
      !cachedSub.subscriptionFingerprint?.startsWith('v2|') ||
      !Number.isFinite(cachedCheckedMs) ||
      nowMs - cachedCheckedMs > 15 * 60 * 1000 ||
      (Number.isFinite(cachedEndMs) && nowMs >= cachedEndMs)
  );
}

export interface CommitNativeSyncOutput {
  updatedIntegrations: StorefrontIntegration[];
  mergedCatalog: CanonicalGame[];
  shouldMergeGames: boolean;
  count: number;
  resolvedAccountName: string;
  nextXboxProfile?: XboxCachedProfileState;
}

/**
 * Pure persistence helper shared by storefront auth surfaces (`IntegrationsModal`,
 * setup wizard steps) to merge synced games, update Xbox profile/achievements, and
 * persist sanitized integration metadata.
 */
export function commitNativeStorefrontSyncResult(
  storefrontId: StorefrontId,
  res: NativeSyncResultPayload,
  fallbackInputs?: { steamInput?: string; epicInput?: string }
): CommitNativeSyncOutput {
  const hasExplicitGamesArray = Array.isArray(res.games);
  const rawGamesList: CanonicalGame[] = hasExplicitGamesArray ? res.games! : [];
  const gamesList = rawGamesList.map((g) => ({
    ...g,
    isVerifiedEntitlement: true,
  }));
  const current = loadCurrentCatalog();
  const shouldMergeGames =
    gamesList.length > 0 ||
    ((storefrontId === 'xbox' || Boolean(res.authoritativeComplete)) && hasExplicitGamesArray);
  const resolvedAuthoritativeComplete =
    res.authoritativeComplete !== undefined
      ? Boolean(res.authoritativeComplete)
      : storefrontId === 'xbox';
  const mergedCatalog = shouldMergeGames
    ? mergeStorefrontGames(current, gamesList, storefrontId, {
        authoritativeComplete: resolvedAuthoritativeComplete,
      })
    : current;
  const count = shouldMergeGames
    ? mergedCatalog.filter((g) => g.platforms.some((p) => p.platformId === storefrontId)).length
    : current.filter((g) => g.platforms.some((p) => p.platformId === storefrontId)).length;

  const normalizedAvatarUrl =
    storefrontId === 'gog'
      ? normalizeGogAvatarUrl(res.avatarUrl) || res.avatarUrl
      : res.avatarUrl || res.gamerpicUrl;

  const resolvedAccountName =
    storefrontId === 'xbox'
      ? res.modernGamertag || res.gamertag || res.accountName || 'Xbox Live User'
      : res.accountName || 'Connected User';

  let nextXboxProfile: XboxCachedProfileState | undefined;
  let nextXboxSubscription: XboxCachedProfileState['subscription'] = null;
  if (storefrontId === 'xbox') {
    if (res.achievements && typeof res.achievements === 'object') {
      cacheUserXboxAchievements(res.achievements);
    }
    const prevXboxProfile = loadXboxProfileState();
    nextXboxProfile = {
      connected: true,
      gamertag: res.gamertag || resolvedAccountName,
      modernGamertag: res.modernGamertag || res.gamertag || resolvedAccountName,
      xuid: res.xuid || res.accountId || prevXboxProfile?.xuid,
      avatarUrl: normalizedAvatarUrl || prevXboxProfile?.avatarUrl,
      gamerscore:
        typeof res.gamerscore === 'number' ? res.gamerscore : prevXboxProfile?.gamerscore,
      subscription:
        res.subscription !== undefined ? res.subscription : (prevXboxProfile?.subscription ?? null),
      syncMode: res.syncMode || prevXboxProfile?.syncMode || 'owned_and_played',
      hasDeviceContext:
        typeof res.hasDeviceContext === 'boolean'
          ? res.hasDeviceContext
          : prevXboxProfile?.hasDeviceContext,
      lastSyncedAt: new Date().toISOString(),
    };
    nextXboxSubscription = nextXboxProfile.subscription;
    saveXboxProfileState(nextXboxProfile);
  }

  const expiresAtRaw = res.tokenData?.expires_at ?? res.tokenData?.expiresAt;
  const integration: StorefrontIntegration = {
    storefrontId,
    name: STORE_AUTH_CONFIGS[storefrontId]?.storeName || storefrontId.toUpperCase(),
    isConnected: true,
    accountName: resolvedAccountName,
    accountId:
      res.xuid ||
      res.accountId ||
      res.tokenData?.account_id ||
      res.tokenData?.steamId ||
      res.tokenData?.user_id,
    avatarUrl: normalizedAvatarUrl,
    gamesCount: count,
    lastSyncedAt: new Date().toISOString(),
    authMethod: 'oauth',
    statusMessage:
      storefrontId === 'xbox'
        ? formatXboxIntegrationStatusMessage(resolvedAccountName, count, nextXboxSubscription)
        : `Connected as ${resolvedAccountName} (${count} titles synced)`,
    credentials: sanitizePublicCredentials(storefrontId, {
      steamId:
        storefrontId === 'steam'
          ? res.accountId || res.tokenData?.steamId || fallbackInputs?.steamInput?.trim() || undefined
          : undefined,
      epicAccountId:
        storefrontId === 'epic'
          ? res.accountId ||
            res.tokenData?.account_id ||
            fallbackInputs?.epicInput?.trim() ||
            undefined
          : undefined,
      epicTokenExpiresAt:
        storefrontId === 'epic' && expiresAtRaw !== undefined ? String(expiresAtRaw) : undefined,
      gogUsername: storefrontId === 'gog' ? resolvedAccountName : undefined,
    }),
  };

  const updatedIntegrations = scrubPersistedIntegrationSecrets().map((i) =>
    i.storefrontId === storefrontId ? integration : i
  );
  saveIntegrations(updatedIntegrations);
  if (shouldMergeGames) {
    saveCurrentCatalog(mergedCatalog);
  }

  return {
    updatedIntegrations,
    mergedCatalog,
    shouldMergeGames,
    count,
    resolvedAccountName,
    nextXboxProfile,
  };
}

export interface UseStorefrontAuthFlowParams {
  isOpen: boolean;
  selectedTab: StorefrontId;
  onLibraryUpdated: (games: CanonicalGame[]) => void;
}

export function useStorefrontAuthFlow({
  isOpen,
  selectedTab,
  onLibraryUpdated,
}: UseStorefrontAuthFlowParams) {
  const [integrations, setIntegrations] = useState<StorefrontIntegration[]>(() =>
    loadIntegrations()
  );
  const [authenticatingStore, setAuthenticatingStore] = useState<StorefrontId | null>(null);
  const [authRedirectInput, setAuthRedirectInput] = useState('');
  const authRedirectInputRef = useRef('');
  const popupRef = useRef<Window | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const authStartTimeRef = useRef<number>(0);

  const [steamInput, setSteamInput] = useState('');
  const [steamApiKey, setSteamApiKey] = useState('');
  const [gogInput, setGogInput] = useState('');
  const [gogToken, setGogToken] = useState('');
  const [epicInput, setEpicInput] = useState('');
  const [epicToken, setEpicToken] = useState('');
  const [xboxInput, setXboxInput] = useState('');
  const [xboxProfile, setXboxProfile] = useState<XboxCachedProfileState | null>(() =>
    loadXboxProfileState()
  );
  const [isUpdatingXboxMode, setIsUpdatingXboxMode] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    authRedirectInputRef.current = authRedirectInput;
  }, [authRedirectInput]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const cachedXboxOnOpen = loadXboxProfileState();
    setXboxProfile(cachedXboxOnOpen);

    if (typeof window !== 'undefined' && window.electronAPI?.getSavedTokens) {
      const refreshSub = shouldRefreshXboxSubscription(cachedXboxOnOpen);
      Promise.all([
        window.electronAPI.getSavedTokens().catch((): SavedStoreTokensMap => ({})),
        window.electronAPI.getXboxStatus
          ? window.electronAPI.getXboxStatus({ refreshSubscription: refreshSub }).catch(() => null)
          : Promise.resolve(null),
      ])
        .then(([savedTokens, xboxStatus]: [SavedStoreTokensMap, XboxStatusSnapshot | null]) => {
          if (cancelled) return;
          const { integrations: updatedIntegrations, xboxProfile: nextXboxProfile } =
            reconcileNativeStorefrontAuthSessions({
              savedTokens,
              xboxStatus,
              persistIfChanged: true,
            });
          if (nextXboxProfile) {
            setXboxProfile(nextXboxProfile);
          }
          setIntegrations(updatedIntegrations);
        })
        .catch(() => {
          if (!cancelled) {
            setIntegrations(scrubPersistedIntegrationSecrets());
          }
        });
    } else {
      setIntegrations(scrubPersistedIntegrationSecrets());
    }
    setAuthenticatingStore(null);

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const currentIntegration =
    integrations.find((i) => i.storefrontId === selectedTab) || integrations[0];

  const handleNativeSyncSuccess = (storefrontId: StorefrontId, res: NativeSyncResultPayload) => {
    const result = commitNativeStorefrontSyncResult(storefrontId, res, {
      steamInput,
      epicInput,
    });
    if (result.nextXboxProfile) {
      setXboxProfile(result.nextXboxProfile);
    }
    setIntegrations(result.updatedIntegrations);
    setSteamApiKey('');
    setGogToken('');
    setEpicToken('');
    setAuthRedirectInput('');
    setSuccessMsg(
      `Successfully connected as ${result.resolvedAccountName}! Synced ${result.count} titles from ${
        STORE_AUTH_CONFIGS[storefrontId]?.storeName || storefrontId.toUpperCase()
      }.`
    );
    if (result.shouldMergeGames) {
      onLibraryUpdated(result.mergedCatalog);
    }
    setIsSubmitting(false);
    setAuthenticatingStore(null);
  };

  const handleXboxSyncModeChange = async (nextMode: XboxGamePassSyncMode) => {
    const currentMode: XboxGamePassSyncMode = xboxProfile?.syncMode || 'owned_and_played';
    if (nextMode === currentMode || isUpdatingXboxMode || isSubmitting) return;

    setIsUpdatingXboxMode(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const modeRes = await xboxIntegration.updateXboxSyncMode(nextMode);
      if (modeRes && modeRes.success === false) {
        throw new Error(modeRes.error || 'Failed to update Game Pass sync mode.');
      }
      const prevProfile = loadXboxProfileState();
      const optimisticProfile: XboxCachedProfileState = {
        ...(prevProfile || { connected: true }),
        connected: true,
        syncMode: nextMode,
      };
      saveXboxProfileState(optimisticProfile);
      setXboxProfile(optimisticProfile);

      if (typeof window !== 'undefined' && window.electronAPI?.syncStore) {
        const syncRes = await window.electronAPI.syncStore('xbox', {
          syncMode: nextMode,
          forceRefresh: true,
        });
        if (syncRes?.success) {
          handleNativeSyncSuccess('xbox', {
            ...syncRes,
            achievements: syncRes.achievements as
              | Record<string, AchievementSummaryEntry>
              | undefined,
            syncMode: syncRes.syncMode || nextMode,
          });
          return;
        }
      }

      const { games } = await connectXboxIntegration({ syncMode: nextMode, forceRefresh: true });
      setIntegrations(scrubPersistedIntegrationSecrets());
      setXboxProfile(loadXboxProfileState());
      setSuccessMsg('Updated Game Pass catalog sync mode and refreshed Xbox library.');
      onLibraryUpdated(games);
    } catch (err: unknown) {
      setErrorMsg(getAuthErrorMessage(err, 'Failed to update Game Pass sync mode.'));
    } finally {
      setIsUpdatingXboxMode(false);
    }
  };

  const completeStoreAuthentication = async (
    storefrontId: StorefrontId,
    explicitCode?: string
  ) => {
    if (popupRef.current && !popupRef.current.closed) {
      try {
        popupRef.current.close();
      } catch {
        // Safe cross-origin close catch
      }
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    const tokenOrCode =
      explicitCode ||
      extractCodeFromInput(authRedirectInput) ||
      (storefrontId === 'epic'
        ? extractCodeFromInput(epicToken) || epicToken.trim() || undefined
        : undefined) ||
      undefined;

    if (typeof window !== 'undefined' && window.electronAPI?.isElectron) {
      if (tokenOrCode && tokenOrCode !== 'xbox_token_broker') {
        if (storefrontId === 'xbox' && !explicitCode) {
          // Skip exchanging stale authRedirectInput when no explicit code was provided
        } else {
          try {
            const res = await window.electronAPI.exchangeCode(storefrontId, tokenOrCode);
            if (res?.success) {
              handleNativeSyncSuccess(storefrontId, {
                ...res,
                achievements: res.achievements as
                  | Record<string, AchievementSummaryEntry>
                  | undefined,
              });
              return;
            } else if (res?.error) {
              setErrorMsg(res.error);
              setIsSubmitting(false);
              return;
            }
          } catch (err: unknown) {
            setErrorMsg(getAuthErrorMessage(err, 'Failed to exchange authorization code.'));
            setIsSubmitting(false);
            return;
          }
        }
      }

      const manualCredsPayload: StorefrontCredentialsInput = {};
      if (storefrontId === 'steam') {
        if (steamInput.trim()) manualCredsPayload.steamId = steamInput.trim();
        if (steamApiKey.trim()) manualCredsPayload.steamApiKey = steamApiKey.trim();
      } else if (storefrontId === 'gog') {
        if (gogToken.trim()) manualCredsPayload.gogToken = gogToken.trim();
      } else if (storefrontId === 'epic') {
        if (epicInput.trim()) manualCredsPayload.epicAccountId = epicInput.trim();
        if (epicToken.trim()) manualCredsPayload.epicToken = epicToken.trim();
      } else if (storefrontId === 'xbox') {
        if (xboxProfile?.syncMode) {
          manualCredsPayload.syncMode = xboxProfile.syncMode;
        }
        manualCredsPayload.forceRefresh = true;
      }
      const hasManualCreds = Object.keys(manualCredsPayload).length > 0;

      try {
        const res = hasManualCreds
          ? await window.electronAPI.syncStore(storefrontId, manualCredsPayload)
          : await window.electronAPI.syncStore(storefrontId);
        if (res?.success) {
          handleNativeSyncSuccess(storefrontId, {
            ...res,
            achievements: res.achievements as
              | Record<string, AchievementSummaryEntry>
              | undefined,
          });
          return;
        } else if (res?.error && (!currentIntegration.isConnected || hasManualCreds)) {
          setErrorMsg(res.error);
          setIsSubmitting(false);
          return;
        }
      } catch (err: unknown) {
        console.warn('Native store sync error:', err);
      }
    }

    try {
      let resultGames: CanonicalGame[] = [];
      let accountName = 'Verified User';

      if (storefrontId === 'gog') {
        const { integration, games } = await connectGogIntegration({
          gogUsername: gogInput.trim() || undefined,
          gogToken: tokenOrCode || gogToken.trim() || undefined,
        });
        resultGames = games;
        accountName = integration.accountName || 'GOG Account';
      } else if (storefrontId === 'steam') {
        const { integration, games } = await connectSteamIntegration({
          steamId: steamInput.trim() || undefined,
          apiKey: steamApiKey.trim() || undefined,
        });
        resultGames = games;
        accountName = integration.accountName || 'Steam User';
      } else if (storefrontId === 'epic') {
        const hasExistingToken = Boolean(epicToken.trim() || currentIntegration.isConnected);
        if (!tokenOrCode && !hasExistingToken) {
          setErrorMsg(
            'To sync live Epic purchases, please copy the authorization URL or code from the Epic pop-up window and paste it here.'
          );
          setIsSubmitting(false);
          return;
        }

        const { integration, games } = await connectEpicIntegration({
          epicAccountId:
            epicInput.trim() || currentIntegration.credentials?.epicAccountId || undefined,
          epicToken: tokenOrCode || epicToken.trim() || undefined,
          epicTokenExpiresAt: currentIntegration.credentials?.epicTokenExpiresAt,
        });
        resultGames = games;
        accountName = integration.accountName || 'Epic Games User';
      } else if (storefrontId === 'xbox') {
        const { integration, games } = await connectXboxIntegration({
          webToken: tokenOrCode || xboxInput.trim() || undefined,
          syncMode: xboxProfile?.syncMode,
          forceRefresh: true,
        });
        resultGames = games;
        accountName = integration.accountName || 'Xbox Live User';
        setXboxProfile(loadXboxProfileState());
      }

      setIntegrations(scrubPersistedIntegrationSecrets());
      setSteamApiKey('');
      setGogToken('');
      setEpicToken('');
      setAuthRedirectInput('');
      setAuthenticatingStore(null);
      setSuccessMsg(
        `Successfully connected as ${accountName} to ${
          STORE_AUTH_CONFIGS[storefrontId]?.storeName || storefrontId.toUpperCase()
        }! Synced owned library.`
      );
      onLibraryUpdated(resultGames);
    } catch (err: unknown) {
      setErrorMsg(getAuthErrorMessage(err, `Failed to complete ${storefrontId} connection.`));
      setAuthenticatingStore(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLaunchStoreSignIn = (storefrontId: StorefrontId) => {
    const config = STORE_AUTH_CONFIGS[storefrontId];
    if (!config || !config.url) return;

    setErrorMsg(null);
    setSuccessMsg(null);

    if (typeof window !== 'undefined' && window.electronAPI?.isElectron) {
      setAuthenticatingStore(storefrontId);
      setIsSubmitting(true);
      window.electronAPI
        .loginStore(storefrontId)
        .then(async (res: StorefrontAuthResult) => {
          if (res.success) {
            if (
              storefrontId === 'xbox' ||
              res.code === 'xbox_token_broker' ||
              (res.games && res.games.length > 0) ||
              (Array.isArray(res.games) &&
                (Boolean(res.authoritativeComplete) || Boolean(res.tokenData)))
            ) {
              handleNativeSyncSuccess(storefrontId, {
                ...res,
                achievements: res.achievements as
                  | Record<string, AchievementSummaryEntry>
                  | undefined,
              });
              return;
            } else if (res.code && res.code !== 'xbox_token_broker') {
              await completeStoreAuthentication(storefrontId, res.code);
            } else {
              await completeStoreAuthentication(storefrontId);
            }
          } else if (res.error) {
            setErrorMsg(res.error);
            setIsSubmitting(false);
            setAuthenticatingStore(null);
          }
        })
        .catch((err: unknown) => {
          setErrorMsg(getAuthErrorMessage(err, 'Native authentication failed.'));
          setIsSubmitting(false);
          setAuthenticatingStore(null);
        });
      return;
    }

    setAuthenticatingStore(storefrontId);
    authStartTimeRef.current = Date.now();

    const left = window.screenX + Math.max(0, (window.outerWidth - config.width) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - config.height) / 2);

    const popup = window.open(
      config.url,
      config.title,
      `width=${config.width},height=${config.height},left=${left},top=${top},status=no,menubar=no,toolbar=no`
    );
    popupRef.current = popup;

    if (popup) {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
      }
      pollTimerRef.current = window.setInterval(async () => {
        try {
          if (popup.closed) {
            if (pollTimerRef.current !== null) {
              window.clearInterval(pollTimerRef.current);
              pollTimerRef.current = null;
            }
            if (authRedirectInputRef.current.trim()) {
              await completeStoreAuthentication(storefrontId);
            }
          }
        } catch {
          // Cross-origin read boundary
        }
      }, 350);
    }
  };

  const handleQuickConnect = async (storefrontId: StorefrontId) => {
    setIsSubmitting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    if (
      typeof window !== 'undefined' &&
      window.electronAPI?.isElectron &&
      window.electronAPI.syncStore
    ) {
      try {
        const credsPayload: StorefrontCredentialsInput = {};
        if (storefrontId === 'steam') {
          if (steamInput.trim()) credsPayload.steamId = steamInput.trim();
          if (steamApiKey.trim()) credsPayload.steamApiKey = steamApiKey.trim();
        } else if (storefrontId === 'epic' && epicInput.trim()) {
          credsPayload.epicAccountId = epicInput.trim();
        } else if (storefrontId === 'xbox') {
          if (xboxProfile?.syncMode) {
            credsPayload.syncMode = xboxProfile.syncMode;
          }
          credsPayload.forceRefresh = true;
        }
        const syncRes = await window.electronAPI.syncStore(storefrontId, credsPayload);
        if (syncRes?.success) {
          handleNativeSyncSuccess(storefrontId, {
            ...syncRes,
            achievements: syncRes.achievements as
              | Record<string, AchievementSummaryEntry>
              | undefined,
          });
          return;
        }
      } catch {
        // Fall through to renderer quick connect fallback
      }
    }

    try {
      let resultGames: CanonicalGame[] = [];
      if (storefrontId === 'steam') {
        const { games } = await connectSteamIntegration({
          steamId: steamInput.trim() || undefined,
          apiKey: steamApiKey.trim() || undefined,
        });
        resultGames = games;
      } else if (storefrontId === 'gog') {
        const { games } = await connectGogIntegration({
          gogUsername: gogInput.trim() || undefined,
        });
        resultGames = games;
      } else if (storefrontId === 'epic') {
        const { games } = await connectEpicIntegration({
          epicAccountId: epicInput.trim() || undefined,
        });
        resultGames = games;
      } else if (storefrontId === 'xbox') {
        const { games } = await connectXboxIntegration({
          webToken: xboxInput.trim() || undefined,
          syncMode: xboxProfile?.syncMode,
          forceRefresh: true,
        });
        resultGames = games;
        setXboxProfile(loadXboxProfileState());
      }

      setIntegrations(scrubPersistedIntegrationSecrets());
      setSteamApiKey('');
      setGogToken('');
      setEpicToken('');
      setSuccessMsg(`Connected ${STORE_AUTH_CONFIGS[storefrontId]?.storeName}! Library synchronized.`);
      onLibraryUpdated(resultGames);
    } catch (err: unknown) {
      setErrorMsg(getAuthErrorMessage(err, 'Connect failed.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDisconnect = (storefrontId: StorefrontId) => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      try {
        window.electronAPI.clearTokens?.(storefrontId);
        window.electronAPI.disconnectStore?.(storefrontId)?.catch?.(() => {});
      } catch (err) {
        console.warn(`Failed to clear tokens for ${storefrontId}:`, err);
      }
    }
    const { integrations: updated, games: remaining } = disconnectIntegration(storefrontId);
    if (storefrontId === 'xbox') {
      setXboxProfile(null);
    }
    setIntegrations(updated);
    setSuccessMsg(`Disconnected ${storefrontId.toUpperCase()} integration.`);
    onLibraryUpdated(remaining);
  };

  return {
    integrations,
    currentIntegration,
    authenticatingStore,
    setAuthenticatingStore,
    authRedirectInput,
    setAuthRedirectInput,
    steamInput,
    setSteamInput,
    steamApiKey,
    setSteamApiKey,
    gogInput,
    setGogInput,
    gogToken,
    setGogToken,
    epicInput,
    setEpicInput,
    epicToken,
    setEpicToken,
    xboxInput,
    setXboxInput,
    xboxProfile,
    isUpdatingXboxMode,
    isSubmitting,
    errorMsg,
    setErrorMsg,
    successMsg,
    setSuccessMsg,
    handleLaunchStoreSignIn,
    completeStoreAuthentication,
    handleQuickConnect,
    handleXboxSyncModeChange,
    handleDisconnect,
  };
}
