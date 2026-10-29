import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Unlink,
  Key,
  Sparkles,
  Cloud,
  ShieldCheck,
  Gamepad2,
  ExternalLink,
  Lock,
  ChevronDown,
  ChevronUp,
  HardDrive,
  Trash2,
  Trophy,
} from 'lucide-react';
import { StorefrontId } from '../../contracts/platform';
import { StorefrontCredentials, StorefrontIntegration } from '../../contracts/integration';
import {
  OFFLINE_VAULT_TIER_CAPS,
  type OfflineVaultStats,
  type OfflineVaultTier,
} from '../../contracts/network';
import type {
  AchievementSummaryEntry,
  SavedStoreTokensMap,
  StorefrontAuthResult,
  StorefrontCredentialsInput,
  StorefrontTokenSummary,
} from '../../types/electron';
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
  type XboxCachedProfileState,
} from '../../services/integrations/integrationStorage';
import type { CanonicalGame, XboxGamePassSyncMode } from '../../contracts/game';
import { xboxIntegration } from '../../services/integrations/xboxIntegration';
import { cacheUserXboxAchievements } from '../../services/storage/knownGameAchievements';
import { StorefrontIcon } from '../Common/StorefrontIcon';
import { ModalShell } from '../Common/ModalShell';
import { useSafeId } from '../../utils/useSafeId';
import { normalizeGogAvatarUrl } from '../../services/integrations/gogIntegration';

interface IntegrationsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLibraryUpdated: (games: CanonicalGame[]) => void;
}

interface StoreAuthConfig {
  url: string;
  title: string;
  width: number;
  height: number;
  storeName: string;
}

const STORE_AUTH_CONFIGS: Record<StorefrontId, StoreAuthConfig> = {
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
  amazon: { url: 'https://gaming.amazon.com/', title: 'Amazon Games Sign In', width: 500, height: 680, storeName: 'Amazon Games' },
  ubisoft: { url: 'https://connect.ubisoft.com/', title: 'Ubisoft Connect Sign In', width: 500, height: 680, storeName: 'Ubisoft Connect' },
  ea: { url: 'https://www.ea.com/', title: 'EA App Sign In', width: 500, height: 680, storeName: 'EA App' },
  bnet: { url: 'https://battle.net/', title: 'Battle.net Sign In', width: 500, height: 680, storeName: 'Battle.net' },
  itch: { url: 'https://itch.io/login', title: 'itch.io Sign In', width: 500, height: 680, storeName: 'itch.io' },
  rockstar: { url: 'https://socialclub.rockstargames.com/', title: 'Rockstar Games Sign In', width: 500, height: 680, storeName: 'Rockstar Games' },
  humble: { url: 'https://www.humblebundle.com/login', title: 'Humble Bundle Sign In', width: 500, height: 680, storeName: 'Humble Bundle' },
  custom: { url: '', title: 'Custom Sign In', width: 500, height: 680, storeName: 'Custom' },
};

interface XboxStatusSnapshot {
  connected: boolean;
  accountName?: string;
  gamertag?: string;
  modernGamertag?: string;
  xuid?: string;
  avatarUrl?: string;
  gamerpicUrl?: string;
  gamerscore?: number;
  subscription?: CanonicalGame['platforms'][number] extends never ? never : XboxCachedProfileState['subscription'];
  syncMode?: XboxGamePassSyncMode;
  hasDeviceContext?: boolean;
  error?: string;
}

type NativeSyncResultPayload = Partial<StorefrontAuthResult> & {
  gamerpicUrl?: string;
  hasDeviceContext?: boolean;
  tokenData?: (StorefrontTokenSummary & { expires_at?: string }) | null;
  achievements?: Record<string, AchievementSummaryEntry>;
};

function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  return fallback;
}

/**
 * Strips all secret tokens/keys so renderer localStorage only persists non-secret public identifiers.
 */
function sanitizePublicCredentials(
  storefrontId: StorefrontId,
  creds?: StorefrontCredentials
): StorefrontCredentials {
  if (!creds || storefrontId === 'xbox') return {};
  const next: StorefrontCredentials = {};
  if (creds.steamId) next.steamId = creds.steamId;
  if (creds.profileUrl) next.profileUrl = creds.profileUrl;
  if (creds.vanityUrl) next.vanityUrl = creds.vanityUrl;
  if (creds.gogUsername) next.gogUsername = creds.gogUsername;
  if (creds.epicAccountId) next.epicAccountId = creds.epicAccountId;
  if (creds.epicTokenExpiresAt) next.epicTokenExpiresAt = creds.epicTokenExpiresAt;
  return next;
}

function scrubPersistedIntegrationSecrets(): StorefrontIntegration[] {
  const loaded = loadIntegrations();
  let mutated = false;
  const cleaned = loaded.map((integ) => {
    const raw = integ.credentials;
    if (
      raw &&
      (raw.apiKey ||
        raw.webToken ||
        raw.gogToken ||
        raw.epicToken ||
        raw.epicRefreshToken)
    ) {
      mutated = true;
      return {
        ...integ,
        credentials: sanitizePublicCredentials(integ.storefrontId, raw),
      };
    }
    return integ;
  });
  if (mutated) {
    saveIntegrations(cleaned);
  }
  return cleaned;
}

function extractAuthCodeFromUrlCandidate(candidate: string): string | null {
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

export const IntegrationsModal: React.FC<IntegrationsModalProps> = ({
  isOpen,
  onClose,
  onLibraryUpdated,
}) => {
  const [integrations, setIntegrations] = useState<StorefrontIntegration[]>(() =>
    loadIntegrations()
  );
  const [selectedTab, setSelectedTab] = useState<StorefrontId>('steam');

  // Active external authentication tracking
  const [authenticatingStore, setAuthenticatingStore] = useState<StorefrontId | null>(null);
  const [authRedirectInput, setAuthRedirectInput] = useState('');
  const authRedirectInputRef = useRef('');
  const popupRef = useRef<Window | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const authStartTimeRef = useRef<number>(0);

  // Advanced manual inputs toggle
  const [showAdvancedInputs, setShowAdvancedInputs] = useState(false);

  // Disconnect confirmation modal state
  const [confirmDisconnectStore, setConfirmDisconnectStore] = useState<StorefrontId | null>(null);

  // Manual Form States
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
  const [avatarImgError, setAvatarImgError] = useState(false);
  const [vaultStats, setVaultStats] = useState<OfflineVaultStats | null>(null);
  const [isUpdatingVault, setIsUpdatingVault] = useState(false);

  const authRedirectFieldId = useSafeId('integ-auth-redirect');
  const steamIdFieldId = useSafeId('integ-steam-id');
  const steamKeyFieldId = useSafeId('integ-steam-key');
  const gogUserFieldId = useSafeId('integ-gog-user');
  const gogTokenFieldId = useSafeId('integ-gog-token');
  const epicIdFieldId = useSafeId('integ-epic-id');
  const epicTokenFieldId = useSafeId('integ-epic-token');
  const xboxTagFieldId = useSafeId('integ-xbox-tag');
  const xboxModePlayedId = useSafeId('integ-xbox-mode-played');
  const xboxModePlayedDescId = useSafeId('integ-xbox-mode-played-desc');
  const xboxModeFullId = useSafeId('integ-xbox-mode-full');
  const xboxModeFullDescId = useSafeId('integ-xbox-mode-full-desc');
  const xboxModeOwnedId = useSafeId('integ-xbox-mode-owned');
  const xboxModeOwnedDescId = useSafeId('integ-xbox-mode-owned-desc');

  useEffect(() => {
    setAvatarImgError(false);
  }, [selectedTab, integrations]);

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

  const extractCodeFromInput = (input: string): string | null => {
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
  };

  useEffect(() => {
    // Sync integrations from storage and Electron native token store when modal opens
    if (isOpen) {
      setXboxProfile(loadXboxProfileState());
      if (typeof window !== 'undefined' && window.electronAPI?.getSavedTokens) {
        Promise.all([
          window.electronAPI.getSavedTokens().catch((): SavedStoreTokensMap => ({})),
          window.electronAPI.getXboxStatus
            ? window.electronAPI.getXboxStatus({ refreshSubscription: false }).catch(() => null)
            : Promise.resolve(null),
        ])
          .then(([savedTokens, xboxStatus]: [SavedStoreTokensMap, XboxStatusSnapshot | null]) => {
            let updatedIntegrations = scrubPersistedIntegrationSecrets();
            let integrationsChanged = false;
            const activeCatalog = loadCurrentCatalog();

            // 1. Reconcile Steam saved token (non-secret profile state only)
            const steamSaved = savedTokens?.steam;
            if (
              steamSaved?.steamId ||
              steamSaved?.hasAccessToken ||
              steamSaved?.access_token ||
              steamSaved?.connected
            ) {
              const steamInteg = updatedIntegrations.find((i) => i.storefrontId === 'steam');
              const steamId =
                steamSaved.steamId || steamInteg?.credentials?.steamId || steamInteg?.accountId;
              const accountName =
                steamSaved.accountName || steamInteg?.accountName || 'Steam User';
              if (
                !steamInteg ||
                !steamInteg.isConnected ||
                (steamId && steamInteg.credentials?.steamId !== steamId) ||
                steamInteg.accountName !== accountName
              ) {
                const count =
                  (Array.isArray(steamSaved.games) && steamSaved.games.length) ||
                  steamInteg?.gamesCount ||
                  activeCatalog.filter((g) => g.platforms.some((p) => p.platformId === 'steam')).length;
                updatedIntegrations = updatedIntegrations.map((i) =>
                  i.storefrontId === 'steam'
                    ? {
                        ...i,
                        isConnected: true,
                        accountName,
                        accountId: steamId,
                        avatarUrl: steamSaved.avatarUrl || i.avatarUrl,
                        gamesCount: count,
                        lastSyncedAt: steamSaved.updatedAt || new Date().toISOString(),
                        authMethod: 'oauth' as const,
                        credentials: sanitizePublicCredentials('steam', {
                          ...i.credentials,
                          steamId,
                        }),
                        statusMessage: `Connected as ${accountName} (${count} titles synced)`,
                      }
                    : i
                );
                integrationsChanged = true;
              }
            }

            // 2. Reconcile GOG saved token (never persist access/refresh tokens in localStorage)
            const gogSaved = savedTokens?.gog;
            if (
              gogSaved?.hasAccessToken ||
              gogSaved?.access_token ||
              gogSaved?.connected ||
              gogSaved?.user_id
            ) {
              const gogInteg = updatedIntegrations.find((i) => i.storefrontId === 'gog');
              const gogUserId = gogSaved.user_id || gogInteg?.accountId;
              const resolvedGogAvatar =
                normalizeGogAvatarUrl(gogSaved.avatarUrl) ||
                normalizeGogAvatarUrl(gogInteg?.avatarUrl) ||
                gogInteg?.avatarUrl;
              const resolvedGogName =
                gogSaved.username ||
                (gogInteg?.accountName && gogInteg.accountName !== 'GOG User'
                  ? gogInteg.accountName
                  : undefined) ||
                'GOG User';
              if (
                !gogInteg ||
                !gogInteg.isConnected ||
                (resolvedGogAvatar && gogInteg.avatarUrl !== resolvedGogAvatar) ||
                (gogSaved.username && gogInteg.accountName !== gogSaved.username)
              ) {
                const count =
                  gogInteg?.gamesCount && gogInteg.gamesCount > 0
                    ? gogInteg.gamesCount
                    : activeCatalog.filter((g) => g.platforms.some((p) => p.platformId === 'gog')).length;
                const accountName = resolvedGogName;
                updatedIntegrations = updatedIntegrations.map((i) =>
                  i.storefrontId === 'gog'
                    ? {
                        ...i,
                        isConnected: true,
                        accountName,
                        accountId: gogUserId,
                        avatarUrl: resolvedGogAvatar || i.avatarUrl,
                        gamesCount: count,
                        lastSyncedAt: gogSaved.updatedAt || new Date().toISOString(),
                        authMethod: 'oauth' as const,
                        credentials: sanitizePublicCredentials('gog', {
                          ...i.credentials,
                          gogUsername: accountName,
                        }),
                        statusMessage: `Connected as ${accountName} (${count} titles synced)`,
                      }
                    : i
                );
                integrationsChanged = true;
              }
            }

            // 3. Reconcile Epic saved token (never persist access/refresh tokens in localStorage)
            const epicSaved = savedTokens?.epic;
            if (
              epicSaved?.hasAccessToken ||
              epicSaved?.access_token ||
              epicSaved?.connected ||
              epicSaved?.account_id
            ) {
              const epicInteg = updatedIntegrations.find((i) => i.storefrontId === 'epic');
              const displayName = epicSaved.displayName || epicInteg?.accountName || 'Epic User';
              const expiresAtStr =
                epicSaved.expiresAt !== undefined ? String(epicSaved.expiresAt) : undefined;
              if (
                !epicInteg ||
                !epicInteg.isConnected ||
                epicInteg.accountName !== displayName
              ) {
                const count =
                  epicInteg?.gamesCount && epicInteg.gamesCount > 0
                    ? epicInteg.gamesCount
                    : activeCatalog.filter((g) => g.platforms.some((p) => p.platformId === 'epic')).length;
                updatedIntegrations = updatedIntegrations.map((i) =>
                  i.storefrontId === 'epic'
                    ? {
                        ...i,
                        isConnected: true,
                        accountName: displayName,
                        accountId: epicSaved.account_id || i.accountId,
                        gamesCount: count,
                        lastSyncedAt: epicSaved.updatedAt || new Date().toISOString(),
                        authMethod: 'oauth' as const,
                        credentials: sanitizePublicCredentials('epic', {
                          epicAccountId: epicSaved.account_id || i.credentials?.epicAccountId,
                          epicTokenExpiresAt: expiresAtStr || i.credentials?.epicTokenExpiresAt,
                        }),
                        statusMessage: `Connected as ${displayName} (${count} titles synced)`,
                      }
                    : i
                );
                integrationsChanged = true;
              }
            }

            // 4. Reconcile Xbox saved session & Game Pass status (strictly non-secret state)
            const xboxSaved = savedTokens?.xbox as
              | (StorefrontTokenSummary & {
                  gamerpicUrl?: string;
                  gamerscore?: number;
                })
              | undefined;
            const hasSavedXbox = Boolean(
              xboxStatus?.connected ||
                xboxSaved?.connected ||
                xboxSaved?.hasAccessToken ||
                xboxSaved?.hasRefreshToken ||
                xboxSaved?.xuid ||
                xboxSaved?.gamertag ||
                xboxSaved?.access_token
            );
            if (hasSavedXbox) {
              const cachedProfile = loadXboxProfileState();
              const xboxInteg = updatedIntegrations.find((i) => i.storefrontId === 'xbox');
              const gamertag =
                xboxStatus?.modernGamertag ||
                xboxStatus?.gamertag ||
                xboxStatus?.accountName ||
                xboxSaved?.modernGamertag ||
                xboxSaved?.gamertag ||
                cachedProfile?.modernGamertag ||
                cachedProfile?.gamertag ||
                xboxInteg?.accountName ||
                'Xbox Live User';
              const xuid =
                xboxStatus?.xuid ||
                xboxSaved?.xuid ||
                cachedProfile?.xuid ||
                xboxInteg?.accountId;
              const avatarUrl =
                xboxStatus?.avatarUrl ||
                xboxStatus?.gamerpicUrl ||
                xboxSaved?.avatarUrl ||
                xboxSaved?.gamerpicUrl ||
                cachedProfile?.avatarUrl ||
                xboxInteg?.avatarUrl;
              const nextProfile: XboxCachedProfileState = {
                connected: true,
                gamertag:
                  xboxStatus?.gamertag ||
                  xboxSaved?.gamertag ||
                  cachedProfile?.gamertag ||
                  gamertag,
                modernGamertag: gamertag,
                xuid,
                avatarUrl,
                gamerscore:
                  typeof xboxStatus?.gamerscore === 'number'
                    ? xboxStatus.gamerscore
                    : typeof xboxSaved?.gamerscore === 'number'
                      ? xboxSaved.gamerscore
                      : cachedProfile?.gamerscore,
                subscription:
                  xboxStatus?.subscription !== undefined
                    ? xboxStatus.subscription
                    : xboxSaved?.subscription !== undefined
                      ? xboxSaved.subscription
                      : cachedProfile?.subscription ?? null,
                syncMode:
                  xboxStatus?.syncMode ||
                  xboxSaved?.syncMode ||
                  cachedProfile?.syncMode ||
                  'owned_and_played',
                hasDeviceContext:
                  typeof xboxStatus?.hasDeviceContext === 'boolean'
                    ? xboxStatus.hasDeviceContext
                    : cachedProfile?.hasDeviceContext,
                lastSyncedAt:
                  xboxSaved?.updatedAt ||
                  cachedProfile?.lastSyncedAt ||
                  xboxInteg?.lastSyncedAt ||
                  new Date().toISOString(),
              };
              saveXboxProfileState(nextProfile);
              setXboxProfile(nextProfile);

              if (
                !xboxInteg ||
                !xboxInteg.isConnected ||
                xboxInteg.accountName !== gamertag ||
                (avatarUrl && xboxInteg.avatarUrl !== avatarUrl)
              ) {
                const count =
                  xboxInteg?.gamesCount && xboxInteg.gamesCount > 0
                    ? xboxInteg.gamesCount
                    : activeCatalog.filter((g) => g.platforms.some((p) => p.platformId === 'xbox')).length;
                updatedIntegrations = updatedIntegrations.map((i) =>
                  i.storefrontId === 'xbox'
                    ? {
                        ...i,
                        isConnected: true,
                        accountName: gamertag,
                        accountId: xuid,
                        avatarUrl: avatarUrl || i.avatarUrl,
                        gamesCount: count,
                        lastSyncedAt: nextProfile.lastSyncedAt,
                        authMethod: 'oauth' as const,
                        credentials: {},
                        statusMessage: `Connected as ${gamertag} (${count} titles synced)`,
                      }
                    : i
                );
                integrationsChanged = true;
              }
            }

            if (integrationsChanged) {
              saveIntegrations(updatedIntegrations);
            }
            setIntegrations(updatedIntegrations);
          })
          .catch(() => setIntegrations(scrubPersistedIntegrationSecrets()));
      } else {
        setIntegrations(scrubPersistedIntegrationSecrets());
      }
      setAuthenticatingStore(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || typeof window === 'undefined' || !window.electronAPI?.offlineVault) {
      return;
    }
    let active = true;
    const vaultApi = window.electronAPI.offlineVault;
    vaultApi
      .getStats()
      .then((stats) => {
        if (active && stats) setVaultStats(stats);
      })
      .catch(() => {});

    let unsubProgress: (() => void) | undefined;
    if (typeof vaultApi.onHydrationProgress === 'function') {
      unsubProgress = vaultApi.onHydrationProgress(() => {
        vaultApi
          .getStats()
          .then((stats) => {
            if (active && stats) setVaultStats(stats);
          })
          .catch(() => {});
      });
    }

    return () => {
      active = false;
      unsubProgress?.();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const currentIntegration =
    integrations.find((i) => i.storefrontId === selectedTab) || integrations[0];

  /**
   * Common handler for native synchronization success
   */
  const handleNativeSyncSuccess = (storefrontId: StorefrontId, res: NativeSyncResultPayload) => {
    const hasExplicitGamesArray = Array.isArray(res.games);
    const rawGamesList: CanonicalGame[] = hasExplicitGamesArray ? res.games! : [];
    const gamesList = rawGamesList.map((g) => ({
      ...g,
      isVerifiedEntitlement: true,
    }));
    const current = loadCurrentCatalog();
    const shouldMergeGames =
      gamesList.length > 0 || (storefrontId === 'xbox' && hasExplicitGamesArray);
    const merged = shouldMergeGames
      ? mergeStorefrontGames(current, gamesList, storefrontId)
      : current;
    const count = shouldMergeGames
      ? merged.filter((g) => g.platforms.some((p) => p.platformId === storefrontId)).length
      : current.filter((g) => g.platforms.some((p) => p.platformId === storefrontId)).length;

    const normalizedAvatarUrl =
      storefrontId === 'gog'
        ? normalizeGogAvatarUrl(res.avatarUrl) || res.avatarUrl
        : res.avatarUrl || res.gamerpicUrl;

    const resolvedAccountName =
      storefrontId === 'xbox'
        ? res.modernGamertag || res.gamertag || res.accountName || 'Xbox Live User'
        : res.accountName || 'Connected User';

    if (storefrontId === 'xbox') {
      if (res.achievements && typeof res.achievements === 'object') {
        cacheUserXboxAchievements(res.achievements);
      }
      const prevXboxProfile = loadXboxProfileState();
      const nextXboxProfile: XboxCachedProfileState = {
        connected: true,
        gamertag: res.gamertag || resolvedAccountName,
        modernGamertag: res.modernGamertag || res.gamertag || resolvedAccountName,
        xuid: res.xuid || res.accountId || prevXboxProfile?.xuid,
        avatarUrl: normalizedAvatarUrl || prevXboxProfile?.avatarUrl,
        gamerscore:
          typeof res.gamerscore === 'number' ? res.gamerscore : prevXboxProfile?.gamerscore,
        subscription:
          res.subscription !== undefined ? res.subscription : prevXboxProfile?.subscription ?? null,
        syncMode: res.syncMode || prevXboxProfile?.syncMode || 'owned_and_played',
        hasDeviceContext:
          typeof res.hasDeviceContext === 'boolean'
            ? res.hasDeviceContext
            : prevXboxProfile?.hasDeviceContext,
        lastSyncedAt: new Date().toISOString(),
      };
      saveXboxProfileState(nextXboxProfile);
      setXboxProfile(nextXboxProfile);
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
      statusMessage: `Connected as ${resolvedAccountName} (${count} titles synced)`,
      credentials: sanitizePublicCredentials(storefrontId, {
        steamId:
          storefrontId === 'steam'
            ? res.accountId || res.tokenData?.steamId || steamInput.trim() || undefined
            : undefined,
        epicAccountId:
          storefrontId === 'epic'
            ? res.accountId || res.tokenData?.account_id || epicInput.trim() || undefined
            : undefined,
        epicTokenExpiresAt:
          storefrontId === 'epic' && expiresAtRaw !== undefined
            ? String(expiresAtRaw)
            : undefined,
        gogUsername: storefrontId === 'gog' ? resolvedAccountName : undefined,
      }),
    };

    const updatedIntegrations = scrubPersistedIntegrationSecrets().map((i) =>
      i.storefrontId === storefrontId ? integration : i
    );
    saveIntegrations(updatedIntegrations);
    if (shouldMergeGames) {
      saveCurrentCatalog(merged);
    }
    setIntegrations(updatedIntegrations);
    setSteamApiKey('');
    setGogToken('');
    setEpicToken('');
    setAuthRedirectInput('');
    setSuccessMsg(
      `Successfully connected as ${resolvedAccountName}! Synced ${count} titles from ${
        STORE_AUTH_CONFIGS[storefrontId]?.storeName || storefrontId.toUpperCase()
      }.`
    );
    if (shouldMergeGames) {
      onLibraryUpdated(merged);
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
        const syncRes = await window.electronAPI.syncStore('xbox', { syncMode: nextMode });
        if (syncRes?.success) {
          handleNativeSyncSuccess('xbox', {
            ...syncRes,
            achievements: syncRes.achievements as Record<string, AchievementSummaryEntry> | undefined,
            syncMode: syncRes.syncMode || nextMode,
          });
          return;
        }
      }

      const { games } = await connectXboxIntegration({ syncMode: nextMode });
      setIntegrations(scrubPersistedIntegrationSecrets());
      setXboxProfile(loadXboxProfileState());
      setSuccessMsg('Updated Game Pass catalog sync mode and refreshed Xbox library.');
      onLibraryUpdated(games);
    } catch (err: unknown) {
      setErrorMsg(getErrorMessage(err, 'Failed to update Game Pass sync mode.'));
    } finally {
      setIsUpdatingXboxMode(false);
    }
  };

  /**
   * Launch real storefront sign-in in a focused popup window or native Electron window
   */
  const handleLaunchStoreSignIn = (storefrontId: StorefrontId) => {
    const config = STORE_AUTH_CONFIGS[storefrontId];
    if (!config || !config.url) return;

    setErrorMsg(null);
    setSuccessMsg(null);

    // Native Electron Desktop Environment Support (Playnite/Heroic style)
    if (typeof window !== 'undefined' && window.electronAPI?.isElectron) {
      setAuthenticatingStore(storefrontId);
      setIsSubmitting(true);
      window.electronAPI
        .loginStore(storefrontId)
        .then(async (res: StorefrontAuthResult) => {
          if (res.success) {
            if (res.games && res.games.length > 0) {
              handleNativeSyncSuccess(storefrontId, {
                ...res,
                achievements: res.achievements as Record<string, AchievementSummaryEntry> | undefined,
              });
              return;
            } else if (res.code) {
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
          setErrorMsg(getErrorMessage(err, 'Native authentication failed.'));
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

    // Watch for popup closure
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

  /**
   * Complete connection once user has signed in on the official store page
   */
  const completeStoreAuthentication = async (storefrontId: StorefrontId, explicitCode?: string) => {
    // Automatically close the popup window if open
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
      (storefrontId === 'epic' ? extractCodeFromInput(epicToken) || epicToken.trim() || undefined : undefined) ||
      undefined;

    // In Electron Desktop App: route secrets exclusively via IPC to main-process safeStorage vault
    if (typeof window !== 'undefined' && window.electronAPI?.isElectron) {
      if (tokenOrCode) {
        try {
          const res = await window.electronAPI.exchangeCode(storefrontId, tokenOrCode);
          if (res?.success) {
            handleNativeSyncSuccess(storefrontId, {
              ...res,
              achievements: res.achievements as Record<string, AchievementSummaryEntry> | undefined,
            });
            return;
          } else if (res?.error) {
            setErrorMsg(res.error);
            setIsSubmitting(false);
            return;
          }
        } catch (err: unknown) {
          setErrorMsg(getErrorMessage(err, 'Failed to exchange authorization code.'));
          setIsSubmitting(false);
          return;
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
      } else if (storefrontId === 'xbox' && xboxProfile?.syncMode) {
        manualCredsPayload.syncMode = xboxProfile.syncMode;
      }
      const hasManualCreds = Object.keys(manualCredsPayload).length > 0;

      // Sync via Electron safeStorage vault (passing manual credentials over IPC when entered)
      try {
        const res = hasManualCreds
          ? await window.electronAPI.syncStore(storefrontId, manualCredsPayload)
          : await window.electronAPI.syncStore(storefrontId);
        if (res?.success) {
          handleNativeSyncSuccess(storefrontId, {
            ...res,
            achievements: res.achievements as Record<string, AchievementSummaryEntry> | undefined,
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
        const hasExistingToken = Boolean(
          epicToken.trim() || currentIntegration.isConnected
        );
        if (!tokenOrCode && !hasExistingToken) {
          setErrorMsg('To sync live Epic purchases, please copy the authorization URL or code from the Epic pop-up window and paste it here.');
          setIsSubmitting(false);
          return;
        }

        const { integration, games } = await connectEpicIntegration({
          epicAccountId: epicInput.trim() || currentIntegration.credentials?.epicAccountId || undefined,
          epicToken: tokenOrCode || epicToken.trim() || undefined,
          epicTokenExpiresAt: currentIntegration.credentials?.epicTokenExpiresAt,
        });
        resultGames = games;
        accountName = integration.accountName || 'Epic Games User';
      } else if (storefrontId === 'xbox') {
        const { integration, games } = await connectXboxIntegration({
          webToken: tokenOrCode || xboxInput.trim() || undefined,
          syncMode: xboxProfile?.syncMode,
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
      setSuccessMsg(`Successfully connected as ${accountName} to ${STORE_AUTH_CONFIGS[storefrontId]?.storeName || storefrontId.toUpperCase()}! Synced owned library.`);
      onLibraryUpdated(resultGames);
    } catch (err: unknown) {
      setErrorMsg(getErrorMessage(err, `Failed to complete ${storefrontId} connection.`));
      setAuthenticatingStore(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Quick Connect helper for manual credential test
   */
  const handleQuickConnect = async (storefrontId: StorefrontId) => {
    setIsSubmitting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    if (typeof window !== 'undefined' && window.electronAPI?.isElectron && window.electronAPI.syncStore) {
      try {
        const credsPayload: StorefrontCredentialsInput = {};
        if (storefrontId === 'steam') {
          if (steamInput.trim()) credsPayload.steamId = steamInput.trim();
          if (steamApiKey.trim()) credsPayload.steamApiKey = steamApiKey.trim();
        } else if (storefrontId === 'epic' && epicInput.trim()) {
          credsPayload.epicAccountId = epicInput.trim();
        } else if (storefrontId === 'xbox' && xboxProfile?.syncMode) {
          credsPayload.syncMode = xboxProfile.syncMode;
        }
        const syncRes = await window.electronAPI.syncStore(storefrontId, credsPayload);
        if (syncRes?.success) {
          handleNativeSyncSuccess(storefrontId, {
            ...syncRes,
            achievements: syncRes.achievements as Record<string, AchievementSummaryEntry> | undefined,
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
        const { games } = await connectGogIntegration({ gogUsername: gogInput.trim() || undefined });
        resultGames = games;
      } else if (storefrontId === 'epic') {
        const { games } = await connectEpicIntegration({ epicAccountId: epicInput.trim() || undefined });
        resultGames = games;
      } else if (storefrontId === 'xbox') {
        const { games } = await connectXboxIntegration({
          webToken: xboxInput.trim() || undefined,
          syncMode: xboxProfile?.syncMode,
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
      setErrorMsg(getErrorMessage(err, 'Connect failed.'));
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

  const formatVaultBytes = (bytes?: number): string => {
    const safeBytes = Math.max(0, Number(bytes || 0));
    if (safeBytes >= 1024 * 1024 * 1024) {
      return `${(safeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    if (safeBytes >= 1024 * 1024) {
      return `${(safeBytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (safeBytes >= 1024) {
      return `${Math.round(safeBytes / 1024)} KB`;
    }
    return `${safeBytes} B`;
  };

  const resolveVaultStatsPayload = async (
    res: { stats?: OfflineVaultStats } | OfflineVaultStats | null | undefined
  ): Promise<OfflineVaultStats | null> => {
    if (res && typeof res === 'object') {
      if ('stats' in res && res.stats) return res.stats;
      if ('tier' in res) return res as OfflineVaultStats;
    }
    try {
      return (await window.electronAPI?.offlineVault?.getStats()) ?? null;
    } catch {
      return null;
    }
  };

  const handleSelectVaultTier = async (tier: OfflineVaultTier) => {
    if (typeof window === 'undefined' || !window.electronAPI?.offlineVault) return;
    setIsUpdatingVault(true);
    try {
      const res = await window.electronAPI.offlineVault.setTier(tier);
      const nextStats = await resolveVaultStatsPayload(res);
      if (nextStats) setVaultStats(nextStats);
    } catch {
      // Ignore tier update errors
    } finally {
      setIsUpdatingVault(false);
    }
  };

  const handleClearVaultMediaCache = async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.offlineVault) return;
    setIsUpdatingVault(true);
    try {
      const res = await window.electronAPI.offlineVault.clear({ preserveMetadata: true });
      const nextStats = await resolveVaultStatsPayload(res);
      if (nextStats) setVaultStats(nextStats);
      setSuccessMsg('Cleared cached offline media blobs while preserving enriched store metadata.');
    } catch {
      // Ignore clear errors
    } finally {
      setIsUpdatingVault(false);
    }
  };

  const hasOfflineVaultBridge =
    typeof window !== 'undefined' && Boolean(window.electronAPI?.offlineVault);

  return (
    <>
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      ariaLabelledBy="integrations-modal-title"
      className="w-full max-w-2xl"
    >
      <div className="bg-[#1b2838] border border-steam-border rounded-lg shadow-2xl max-w-2xl w-full overflow-hidden text-steam-text flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-steam-border/60 bg-[#16202d]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded bg-steam-accent/15 border border-steam-accent/30 text-steam-accent">
              <Cloud className="w-5 h-5" />
            </div>
            <div>
              <h2 id="integrations-modal-title" className="text-lg font-bold text-white flex items-center gap-2">
                Storefront Integrations & Cloud Sync
              </h2>
              <p className="text-xs text-steam-subtext">
                Connect your accounts directly via official web sign in — No desktop launchers required
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close storefront integrations"
            onClick={onClose}
            className="min-w-6 min-h-6 inline-flex items-center justify-center p-1.5 rounded hover:bg-white/10 text-steam-subtext hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Storefront Navigation Tabs */}
        <div className="flex border-b border-steam-border/40 bg-[#121922] px-6 pt-3 gap-2">
          {integrations.map((integ) => {
            const isActive = selectedTab === integ.storefrontId;
            return (
              <button
                key={integ.storefrontId}
                type="button"
                onClick={() => {
                  setSelectedTab(integ.storefrontId);
                  setErrorMsg(null);
                  setSuccessMsg(null);
                  setAuthenticatingStore(null);
                  setShowAdvancedInputs(false);
                }}
                className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t border-t border-x transition-colors relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent ${
                  isActive
                    ? 'bg-[#1b2838] border-steam-border text-white border-b-transparent shadow-md'
                    : 'bg-black/20 border-transparent text-steam-subtext hover:text-white hover:bg-white/5'
                }`}
              >
                <span>{integ.name}</span>
                {integ.isConnected ? (
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
                ) : (
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-600" />
                )}
              </button>
            );
          })}
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
          {/* Notifications */}
          {errorMsg && (
            <div className="p-3 bg-red-950/60 border border-red-700/60 rounded text-red-200 text-xs flex items-center gap-2.5">
              <AlertCircle className="w-4 h-4 flex-shrink-0 text-red-400" />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div className="p-3 bg-emerald-950/60 border border-emerald-700/60 rounded text-emerald-200 text-xs flex items-center gap-2.5">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-400" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* If actively authenticating via popup window */}
          {authenticatingStore === selectedTab ? (
            <div className="bg-[#16202d] border border-steam-accent/50 rounded-lg p-6 text-center space-y-5 animate-in fade-in duration-200">
              <div className="flex justify-center">
                <div className="relative">
                  <div
                    className={`w-16 h-16 rounded-full border-2 flex items-center justify-center animate-pulse ${
                      selectedTab === 'xbox'
                        ? 'bg-[#107c10]/20 border-[#52d652]'
                        : 'bg-steam-accent/10 border-steam-accent'
                    }`}
                  >
                    <StorefrontIcon
                      storefrontId={selectedTab}
                      decorative
                      className={`w-8 h-8 ${
                        selectedTab === 'xbox' ? 'text-[#52d652]' : 'text-steam-accent'
                      }`}
                    />
                  </div>
                  <div className="absolute -bottom-1 -right-1 bg-[#16202d] rounded-full p-1 border border-steam-border">
                    <RefreshCw className="w-4 h-4 text-steam-accent animate-spin" />
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-base font-bold text-white">
                  Official {STORE_AUTH_CONFIGS[selectedTab]?.storeName} Sign-In Window Open
                </h3>
                <p className="text-xs text-steam-subtext max-w-md mx-auto mt-1 leading-relaxed">
                  {selectedTab === 'gog' ? (
                    <>
                      Please log in on the official GOG sign-in window. Once you authenticate (via Google or GOG account), GOG redirects to the confirmation page (<code className="text-emerald-300 bg-black/40 px-1 py-0.5 rounded text-[11px]">embed.gog.com/on_login_success</code>).
                    </>
                  ) : selectedTab === 'epic' ? (
                    <>
                      Log in with your Epic Games account. Once authenticated, Epic redirects to confirm the launcher token.
                    </>
                  ) : selectedTab === 'xbox' ? (
                    <>
                      Sign in with your Microsoft / Xbox Live account. In the desktop app, the redirect token is captured automatically to sync your Microsoft Store purchases, Game Pass status, and Gamerscore.
                    </>
                  ) : (
                    `Please log in on the official ${STORE_AUTH_CONFIGS[selectedTab]?.storeName} sign-in page in the pop-up window. Once complete, this app will automatically connect and synchronize your owned titles.`
                  )}
                </p>
              </div>

              {/* Special callout banner for GOG blank page */}
              {selectedTab === 'gog' && (
                <div className="p-3 bg-amber-950/40 border border-amber-500/50 rounded text-amber-200 text-xs text-left max-w-lg mx-auto flex items-start gap-2.5 shadow-inner">
                  <AlertCircle className="w-5 h-5 flex-shrink-0 text-amber-400 mt-0.5" />
                  <div className="space-y-1">
                    <span className="font-bold text-amber-300">Why GOG displays a blank white screen:</span>
                    <p className="text-[11px] leading-relaxed text-amber-200/90">
                      GOG's official OAuth server directs the browser to <code className="bg-black/50 px-1 py-0.5 rounded font-mono text-emerald-300">embed.gog.com/on_login_success</code>. Because this endpoint was built for the native GOG Galaxy desktop client, GOG intentionally serves a <strong>blank white page</strong> without auto-closing the browser window.
                    </p>
                    <p className="text-[11px] font-semibold text-emerald-300">
                      ✓ Seeing that blank white page confirms your sign-in was 100% successful! Click the button below to close the pop-up and sync your library.
                    </p>
                  </div>
                </div>
              )}

              {/* Special callout banner for Epic Games Store */}
              {selectedTab === 'epic' && (
                <div className="p-3.5 bg-blue-950/40 border border-blue-500/50 rounded text-blue-200 text-xs text-left max-w-lg mx-auto space-y-2 shadow-inner">
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-sky-400 mt-0.5" />
                    <div className="space-y-1.5">
                      <span className="font-bold text-sky-300">How to link your live Epic Games session:</span>
                      <ol className="list-decimal list-inside space-y-1 text-[11px] text-blue-200/90 leading-relaxed">
                        <li>Log into your Epic Games account in the pop-up window.</li>
                        <li>
                          After login, Epic redirects to the launcher authorization endpoint.
                          <div className="mt-1 pl-4 text-[10px] text-blue-300/80">
                            The pop-up address bar will show:
                            <code className="block mt-0.5 bg-black/60 px-1.5 py-1 rounded font-mono text-emerald-300 break-all select-all">
                              https://localhost/launcher/authorized?code=...
                            </code>
                            or the page will display JSON with your <code className="text-emerald-300">"authorizationCode"</code>.
                          </div>
                        </li>
                        <li>Copy the address bar URL or the JSON text and paste it into the box below.</li>
                      </ol>
                    </div>
                  </div>
                </div>
              )}

              {/* Special callout banner for Xbox / Microsoft Live OAuth */}
              {selectedTab === 'xbox' && (
                <div className="p-3.5 bg-emerald-950/35 border border-emerald-500/40 rounded text-emerald-100 text-xs text-left max-w-lg mx-auto space-y-2 shadow-inner">
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 aria-hidden="true" className="w-5 h-5 flex-shrink-0 text-emerald-400 mt-0.5" />
                    <div className="space-y-1.5">
                      <span className="font-bold text-emerald-300">Microsoft / Xbox Live OAuth Sign-In:</span>
                      <p className="text-[11px] text-emerald-100/90 leading-relaxed">
                        Complete sign-in (including passkeys or 2FA) in the Microsoft window. If signing in via an external browser window, copy the final blank redirect URL (<code className="bg-black/60 px-1 py-0.5 rounded font-mono text-emerald-300">https://login.live.com/oauth20_desktop.srf?code=M...</code>) and paste it below.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="max-w-md mx-auto text-left space-y-1.5 bg-[#121922] p-3 rounded border border-steam-border/60">
                <label htmlFor={authRedirectFieldId} className="block text-[11px] font-semibold text-white">
                  Paste Pop-Up Address Bar URL or Authorization Text:
                </label>
                <input
                  id={authRedirectFieldId}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={authRedirectInput}
                  onChange={(e) => {
                    const val = e.target.value;
                    setAuthRedirectInput(val);
                    const code = extractCodeFromInput(val);
                    if (code) {
                      completeStoreAuthentication(selectedTab, code);
                    }
                  }}
                  placeholder={
                    selectedTab === 'gog'
                      ? 'e.g. https://embed.gog.com/on_login_success?origin=client&code=...'
                      : selectedTab === 'epic'
                      ? 'e.g. https://localhost/launcher/authorized?code=... or {"authorizationCode":"..."}'
                      : selectedTab === 'xbox'
                      ? 'e.g. https://login.live.com/oauth20_desktop.srf?code=M.C507...'
                      : 'Paste URL or code here...'
                  }
                  className="w-full px-2.5 py-1.5 bg-[#0d1218] border border-steam-border rounded text-xs text-white font-mono placeholder:text-slate-400 focus:outline-none focus:border-steam-accent"
                />
                <p className="text-[10px] text-steam-subtext">
                  Auto-detects and extracts authorization codes from full URLs or JSON strings instantly.
                </p>
              </div>

              <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => completeStoreAuthentication(selectedTab, extractCodeFromInput(authRedirectInput) || undefined)}
                  disabled={isSubmitting}
                  className="px-5 py-2.5 rounded bg-steam-accent hover:bg-steam-accent-hover text-white text-xs font-bold transition-all shadow-md flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  {isSubmitting ? <RefreshCw aria-hidden="true" className="w-4 h-4 animate-spin" /> : <ShieldCheck aria-hidden="true" className="w-4 h-4" />}
                  {isSubmitting
                    ? 'Syncing Live Library...'
                    : selectedTab === 'gog'
                    ? 'Close Pop-Up & Connect GOG Now'
                    : selectedTab === 'epic'
                    ? 'Link Epic Account & Sync Live Games'
                    : "I've Completed Sign In — Sync Now"}
                </button>

                <button
                  type="button"
                  onClick={() => handleLaunchStoreSignIn(selectedTab)}
                  className="px-4 py-2.5 rounded bg-white/5 hover:bg-white/10 text-steam-text hover:text-white text-xs font-medium transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent"
                >
                  <ExternalLink aria-hidden="true" className="w-3.5 h-3.5" />
                  Re-open Sign-In Window
                </button>

                <button
                  type="button"
                  onClick={() => setAuthenticatingStore(null)}
                  className="px-3 py-2.5 text-xs text-steam-subtext hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent rounded"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : currentIntegration.isConnected ? (
            /* Connected State Card */
            <div className="bg-[#16202d] border border-steam-border/80 rounded-lg p-5 space-y-4">
              <div className="flex items-start justify-between gap-4 pb-4 border-b border-steam-border/40">
                <div className="flex items-center gap-4 min-w-0">
                  {(selectedTab === 'xbox' ? xboxProfile?.avatarUrl || currentIntegration.avatarUrl : currentIntegration.avatarUrl) && !avatarImgError ? (
                    <img
                      src={
                        selectedTab === 'gog'
                          ? normalizeGogAvatarUrl(currentIntegration.avatarUrl) || currentIntegration.avatarUrl
                          : selectedTab === 'xbox'
                          ? xboxProfile?.avatarUrl || currentIntegration.avatarUrl
                          : currentIntegration.avatarUrl
                      }
                      alt="Avatar"
                      onError={() => setAvatarImgError(true)}
                      className="w-14 h-14 rounded border border-steam-border shadow-md object-cover shrink-0"
                    />
                  ) : (
                    <div className="w-14 h-14 rounded bg-[#101721] border border-steam-border flex items-center justify-center text-white font-bold text-xl shadow-md shrink-0">
                      <StorefrontIcon
                        storefrontId={selectedTab}
                        decorative
                        className={`w-7 h-7 ${
                          selectedTab === 'xbox' ? 'text-[#52d652]' : 'text-steam-accent'
                        }`}
                      />
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-bold text-white truncate">
                        {(selectedTab === 'xbox' && xboxProfile?.modernGamertag) ||
                          currentIntegration.accountName ||
                          `${STORE_AUTH_CONFIGS[selectedTab]?.storeName} User`}
                      </h3>
                      <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                        <ShieldCheck aria-hidden="true" className="w-3 h-3" /> Connected
                      </span>
                      {selectedTab === 'xbox' && typeof xboxProfile?.gamerscore === 'number' && (
                        <span
                          data-testid="xbox-gamerscore-badge"
                          className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-950/80 text-emerald-200 border border-emerald-500/40 inline-flex items-center gap-1"
                          title="Xbox Live Gamerscore"
                        >
                          <span
                            aria-hidden="true"
                            className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-emerald-500 text-[#09150e] text-[9px] font-black leading-none"
                          >
                            G
                          </span>
                          <span>{xboxProfile.gamerscore.toLocaleString()} G</span>
                        </span>
                      )}
                    </div>
                    {(selectedTab === 'xbox' ? xboxProfile?.xuid || currentIntegration.accountId : currentIntegration.accountId) && (
                      <p className="text-xs text-steam-subtext font-mono mt-0.5">
                        ID: {selectedTab === 'xbox' ? xboxProfile?.xuid || currentIntegration.accountId : currentIntegration.accountId}
                      </p>
                    )}
                    {selectedTab === 'xbox' && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        {(() => {
                          const sub = xboxProfile?.subscription;
                          if (sub?.hasActiveSubscription && sub.hasPcCatalogAccess) {
                            const parsedEnd = sub.endDate ? new Date(sub.endDate) : null;
                            const endLabel =
                              parsedEnd && !Number.isNaN(parsedEnd.getTime())
                                ? parsedEnd.toLocaleDateString(undefined, {
                                    month: 'short',
                                    day: 'numeric',
                                    year: 'numeric',
                                  })
                                : null;
                            return (
                              <span
                                data-testid="xbox-subscription-pill"
                                className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 inline-flex items-center gap-1.5"
                              >
                                <Trophy aria-hidden="true" className="w-3 h-3 text-emerald-400" />
                                <span>{sub.tierDisplayName || 'PC Game Pass'}</span>
                                {endLabel && (
                                  <span className="text-emerald-200/80 font-normal">
                                    • {sub.autoRenew ? `Renews ${endLabel}` : `Ends ${endLabel}`}
                                  </span>
                                )}
                              </span>
                            );
                          }
                          if (sub?.hasActiveSubscription && !sub.hasPcCatalogAccess) {
                            return (
                              <span
                                data-testid="xbox-subscription-pill"
                                className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 inline-flex items-center gap-1"
                              >
                                <span>{sub.tierDisplayName || 'Xbox Game Pass'} (No PC Catalog)</span>
                              </span>
                            );
                          }
                          return (
                            <span
                              data-testid="xbox-subscription-pill"
                              className="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-800/80 text-slate-300 border border-slate-600/50 inline-flex items-center gap-1"
                            >
                              <span>No Active Game Pass</span>
                            </span>
                          );
                        })()}
                      </div>
                    )}
                    <p className="text-xs text-steam-accent mt-1.5 flex items-center gap-1.5 font-medium">
                      <Gamepad2 aria-hidden="true" className="w-3.5 h-3.5" />
                      {currentIntegration.gamesCount}{' '}
                      {selectedTab === 'xbox' ? 'Xbox & Game Pass Titles Cataloged' : 'Owned Titles Cataloged'}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setConfirmDisconnectStore(selectedTab)}
                  className="px-3 py-1.5 rounded bg-red-950/40 hover:bg-red-900/60 border border-red-700/50 text-red-300 text-xs font-semibold transition-colors flex items-center gap-1.5 cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                >
                  <Unlink aria-hidden="true" className="w-3.5 h-3.5" />
                  Disconnect
                </button>
              </div>

              {selectedTab === 'xbox' && (() => {
                const activeSyncMode: XboxGamePassSyncMode =
                  xboxProfile?.syncMode || 'owned_and_played';
                const hasExplicitNoPcCatalog = Boolean(
                  xboxProfile?.subscription &&
                    (!xboxProfile.subscription.hasActiveSubscription ||
                      !xboxProfile.subscription.hasPcCatalogAccess)
                );
                const disableFullCatalogOption =
                  hasExplicitNoPcCatalog && activeSyncMode !== 'full_pc_game_pass';

                return (
                  <fieldset
                    data-testid="xbox-sync-mode-fieldset"
                    disabled={isUpdatingXboxMode || isSubmitting}
                    className="bg-[#111923] border border-steam-border/60 rounded-lg p-3.5 space-y-2.5 disabled:opacity-60"
                  >
                    <legend className="px-1.5 text-[11px] font-bold uppercase tracking-wider text-emerald-300">
                      Game Pass &amp; Library Sync Mode
                    </legend>

                    <div className="space-y-2">
                      <div
                        className={`flex items-start gap-2.5 p-2.5 rounded border transition-colors ${
                          activeSyncMode === 'owned_and_played'
                            ? 'bg-emerald-950/25 border-emerald-500/50'
                            : 'bg-[#0d131b] border-steam-border/40 hover:border-steam-border'
                        }`}
                      >
                        <input
                          id={xboxModePlayedId}
                          type="radio"
                          name="xboxGamePassSyncMode"
                          value="owned_and_played"
                          checked={activeSyncMode === 'owned_and_played'}
                          aria-describedby={xboxModePlayedDescId}
                          onChange={() => handleXboxSyncModeChange('owned_and_played')}
                          className="mt-0.5 h-3.5 w-3.5 accent-emerald-500 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-1 focus-visible:ring-offset-[#111923]"
                        />
                        <div className="min-w-0 flex-1">
                          <label
                            htmlFor={xboxModePlayedId}
                            className="block text-xs font-semibold text-white cursor-pointer"
                          >
                            Owned + Played Game Pass (Recommended)
                          </label>
                          <p
                            id={xboxModePlayedDescId}
                            className="text-[11px] text-steam-subtext leading-snug mt-0.5"
                          >
                            Syncs permanent Microsoft Store purchases plus Game Pass titles you have played or installed locally.
                          </p>
                        </div>
                      </div>

                      <div
                        className={`flex items-start gap-2.5 p-2.5 rounded border transition-colors ${
                          activeSyncMode === 'full_pc_game_pass'
                            ? 'bg-emerald-950/25 border-emerald-500/50'
                            : disableFullCatalogOption
                            ? 'bg-[#0d131b]/60 border-steam-border/30 opacity-65'
                            : 'bg-[#0d131b] border-steam-border/40 hover:border-steam-border'
                        }`}
                      >
                        <input
                          id={xboxModeFullId}
                          type="radio"
                          name="xboxGamePassSyncMode"
                          value="full_pc_game_pass"
                          checked={activeSyncMode === 'full_pc_game_pass'}
                          disabled={disableFullCatalogOption}
                          aria-describedby={xboxModeFullDescId}
                          onChange={() => handleXboxSyncModeChange('full_pc_game_pass')}
                          className="mt-0.5 h-3.5 w-3.5 accent-emerald-500 cursor-pointer disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-1 focus-visible:ring-offset-[#111923]"
                        />
                        <div className="min-w-0 flex-1">
                          <label
                            htmlFor={xboxModeFullId}
                            className={`block text-xs font-semibold ${
                              disableFullCatalogOption
                                ? 'text-slate-400 cursor-not-allowed'
                                : 'text-white cursor-pointer'
                            }`}
                          >
                            Full PC Game Pass Catalog
                          </label>
                          <p
                            id={xboxModeFullDescId}
                            className="text-[11px] text-steam-subtext leading-snug mt-0.5"
                          >
                            Includes the entire active PC Game Pass catalog alongside your permanent purchases.
                            {disableFullCatalogOption
                              ? ' Requires an active PC Game Pass or Game Pass Ultimate subscription.'
                              : ''}
                          </p>
                        </div>
                      </div>

                      <div
                        className={`flex items-start gap-2.5 p-2.5 rounded border transition-colors ${
                          activeSyncMode === 'owned_only'
                            ? 'bg-emerald-950/25 border-emerald-500/50'
                            : 'bg-[#0d131b] border-steam-border/40 hover:border-steam-border'
                        }`}
                      >
                        <input
                          id={xboxModeOwnedId}
                          type="radio"
                          name="xboxGamePassSyncMode"
                          value="owned_only"
                          checked={activeSyncMode === 'owned_only'}
                          aria-describedby={xboxModeOwnedDescId}
                          onChange={() => handleXboxSyncModeChange('owned_only')}
                          className="mt-0.5 h-3.5 w-3.5 accent-emerald-500 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-1 focus-visible:ring-offset-[#111923]"
                        />
                        <div className="min-w-0 flex-1">
                          <label
                            htmlFor={xboxModeOwnedId}
                            className="block text-xs font-semibold text-white cursor-pointer"
                          >
                            Owned Games Only
                          </label>
                          <p
                            id={xboxModeOwnedDescId}
                            className="text-[11px] text-steam-subtext leading-snug mt-0.5"
                          >
                            Syncs only permanent Microsoft Store / Xbox Play Anywhere purchases; excludes subscription-only titles.
                          </p>
                        </div>
                      </div>
                    </div>
                  </fieldset>
                );
              })()}

              <div className="flex items-center justify-between pt-1">
                <div className="text-[11px] text-steam-subtext">
                  Sync Method:{' '}
                  <span className="text-white font-medium">
                    {selectedTab === 'xbox'
                      ? 'Xbox Live XSTS + Store Entitlements (SafeStorage)'
                      : selectedTab === 'epic'
                      ? 'Live Cloud OAuth (Auto-renewing)'
                      : 'Cloud Web API'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => completeStoreAuthentication(selectedTab)}
                  disabled={isSubmitting || isUpdatingXboxMode}
                  className="px-3 py-1.5 rounded bg-steam-accent hover:bg-steam-accent-hover text-white text-xs font-semibold transition-all flex items-center gap-1.5 shadow-md disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={`w-3.5 h-3.5 ${isSubmitting || isUpdatingXboxMode ? 'animate-spin' : ''}`}
                  />
                  {isSubmitting || isUpdatingXboxMode ? 'Syncing...' : 'Re-sync Library Now'}
                </button>
              </div>
            </div>
          ) : (
            /* Disconnected / Ready to Sign In State */
            <div className="space-y-5">
              {/* Baseline library notice if titles exist while disconnected */}
              {currentIntegration.gamesCount > 0 && (
                <div className="bg-amber-950/30 border border-amber-500/50 rounded-lg p-3.5 flex items-center justify-between gap-3 shadow-inner">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                    <div className="text-xs">
                      <span className="font-bold text-amber-300">
                        {currentIntegration.gamesCount} {STORE_AUTH_CONFIGS[selectedTab]?.storeName} titles
                      </span>{' '}
                      <span className="text-amber-200/90">
                        are cached in your library (Not Connected).
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setConfirmDisconnectStore(selectedTab)}
                    className="px-2.5 py-1 rounded bg-red-950/50 hover:bg-red-900/70 border border-red-700/60 text-red-300 text-xs font-semibold transition-colors flex items-center gap-1.5 shrink-0 cursor-pointer"
                    title="Remove storefront titles from library"
                  >
                    <Unlink className="w-3 h-3" />
                    <span>Disconnect & Remove</span>
                  </button>
                </div>
              )}

              {/* Official Store Sign-In Primary Action Card */}
              <div className="bg-[#16202d] border border-steam-border rounded-lg p-6 space-y-4 shadow-lg text-center">
                <div className="w-12 h-12 rounded-full bg-[#1b2838] border border-steam-border flex items-center justify-center mx-auto text-white">
                  <StorefrontIcon
                    storefrontId={selectedTab}
                    decorative
                    className={`w-6 h-6 ${
                      selectedTab === 'xbox' ? 'text-[#52d652]' : 'text-steam-accent'
                    }`}
                  />
                </div>

                <div>
                  <h3 className="text-base font-bold text-white">
                    Sign in with {STORE_AUTH_CONFIGS[selectedTab]?.storeName}
                  </h3>
                  <p className="text-xs text-steam-subtext max-w-sm mx-auto mt-1 leading-relaxed">
                    Click below to open the official {STORE_AUTH_CONFIGS[selectedTab]?.storeName} sign-in page.
                    Zero manual configuration — authenticate through your browser and we'll sync your owned licenses.
                  </p>
                </div>

                {/* Big Store Sign In Button */}
                <div className="pt-2 flex flex-col items-center gap-3">
                  <button
                    type="button"
                    onClick={() => handleLaunchStoreSignIn(selectedTab)}
                    className={`w-full max-w-xs py-3 px-5 rounded font-bold text-xs text-white transition-all shadow-lg flex items-center justify-center gap-2.5 ${
                      selectedTab === 'gog'
                        ? 'bg-purple-600 hover:bg-purple-500 shadow-purple-900/30'
                        : selectedTab === 'steam'
                        ? 'bg-steam-accent hover:bg-steam-accent-hover shadow-sky-900/30'
                        : selectedTab === 'epic'
                        ? 'bg-blue-600 hover:bg-blue-500 shadow-blue-900/30'
                        : 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-900/30'
                    }`}
                  >
                    <Lock className="w-4 h-4" />
                    <span>Sign In to {STORE_AUTH_CONFIGS[selectedTab]?.storeName}</span>
                    <ExternalLink className="w-3.5 h-3.5 opacity-80" />
                  </button>

                  <button
                    type="button"
                    onClick={() => handleQuickConnect(selectedTab)}
                    disabled={isSubmitting}
                    className="text-xs text-steam-subtext hover:text-white transition-colors flex items-center gap-1.5 pt-1"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                    <span>Or 1-click Quick Connect & Sync Catalog</span>
                  </button>
                </div>
              </div>

              {/* Advanced Manual Connection Accordion */}
              <div className="border border-steam-border/60 rounded-lg bg-[#141b24] overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowAdvancedInputs(!showAdvancedInputs)}
                  className="w-full px-4 py-2.5 text-xs text-steam-subtext hover:text-white flex items-center justify-between transition-colors"
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    <Key className="w-3.5 h-3.5" />
                    Advanced: Manual ID or Custom Profile Connect
                  </span>
                  {showAdvancedInputs ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>

                {showAdvancedInputs && (
                  <div className="p-4 border-t border-steam-border/40 space-y-3 bg-[#111720]">
                    {selectedTab === 'steam' && (
                      <div className="space-y-3">
                        <div>
                          <label htmlFor={steamIdFieldId} className="block text-[11px] font-semibold text-white mb-1">Steam ID or Profile URL</label>
                          <input
                            id={steamIdFieldId}
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            value={steamInput}
                            onChange={(e) => setSteamInput(e.target.value)}
                            placeholder="76561198000000000"
                            className="w-full px-3 py-1.5 bg-[#0d1218] border border-steam-border rounded text-xs text-white font-mono"
                          />
                        </div>
                        <div>
                          <label htmlFor={steamKeyFieldId} className="block text-[11px] font-semibold text-white mb-1">Web API Key (Optional)</label>
                          <input
                            id={steamKeyFieldId}
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            value={steamApiKey}
                            onChange={(e) => setSteamApiKey(e.target.value)}
                            placeholder="Optional Steam Web API Key"
                            className="w-full px-3 py-1.5 bg-[#0d1218] border border-steam-border rounded text-xs text-white font-mono"
                          />
                        </div>
                      </div>
                    )}

                    {selectedTab === 'gog' && (
                      <div className="space-y-3">
                        <div>
                          <label htmlFor={gogUserFieldId} className="block text-[11px] font-semibold text-white mb-1">GOG Username</label>
                          <input
                            id={gogUserFieldId}
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            value={gogInput}
                            onChange={(e) => setGogInput(e.target.value)}
                            placeholder="GOG Username"
                            className="w-full px-3 py-1.5 bg-[#0d1218] border border-steam-border rounded text-xs text-white font-mono"
                          />
                        </div>
                        <div>
                          <label htmlFor={gogTokenFieldId} className="block text-[11px] font-semibold text-white mb-1">GOG OAuth Bearer Token (Optional)</label>
                          <input
                            id={gogTokenFieldId}
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            value={gogToken}
                            onChange={(e) => setGogToken(e.target.value)}
                            placeholder="Optional OAuth token"
                            className="w-full px-3 py-1.5 bg-[#0d1218] border border-steam-border rounded text-xs text-white font-mono"
                          />
                        </div>
                      </div>
                    )}

                    {selectedTab === 'epic' && (
                      <div className="space-y-3">
                        <div>
                          <label htmlFor={epicIdFieldId} className="block text-[11px] font-semibold text-white mb-1">Epic Account ID or Public Profile URL</label>
                          <input
                            id={epicIdFieldId}
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            value={epicInput}
                            onChange={(e) => setEpicInput(e.target.value)}
                            placeholder="e.g. a1b2c3d4e5f60718293a4b5c6d7e8f90 or https://store.epicgames.com/u/..."
                            className="w-full px-3 py-1.5 bg-[#0d1218] border border-steam-border rounded text-xs text-white font-mono"
                          />
                        </div>
                        <div>
                          <label htmlFor={epicTokenFieldId} className="block text-[11px] font-semibold text-white mb-1">Epic Exchange / Auth Token (Optional)</label>
                          <input
                            id={epicTokenFieldId}
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            value={epicToken}
                            onChange={(e) => setEpicToken(e.target.value)}
                            placeholder="Optional OAuth or Exchange token"
                            className="w-full px-3 py-1.5 bg-[#0d1218] border border-steam-border rounded text-xs text-white font-mono"
                          />
                        </div>
                      </div>
                    )}

                    {selectedTab === 'xbox' && (
                      <div className="space-y-3">
                        <div>
                          <label htmlFor={xboxTagFieldId} className="block text-[11px] font-semibold text-white mb-1">Xbox Gamertag</label>
                          <input
                            id={xboxTagFieldId}
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            value={xboxInput}
                            onChange={(e) => setXboxInput(e.target.value)}
                            placeholder="Xbox Gamertag"
                            className="w-full px-3 py-1.5 bg-[#0d1218] border border-steam-border rounded text-xs text-white font-mono"
                          />
                        </div>
                      </div>
                    )}

                    <div className="pt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => completeStoreAuthentication(selectedTab)}
                        disabled={isSubmitting}
                        className="px-4 py-1.5 rounded bg-white/10 hover:bg-white/15 text-white text-xs font-semibold transition-colors"
                      >
                        {isSubmitting ? 'Connecting...' : 'Connect with Manual Credentials'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Offline Library Vault Management (Electron Desktop Runtime) */}
          {hasOfflineVaultBridge && (
            <div
              data-testid="offline-library-vault-section"
              className="bg-[#141d28] border border-steam-border/80 rounded-lg p-4 space-y-3.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="p-1.5 rounded bg-steam-accent/15 border border-steam-accent/30 text-steam-accent">
                    <HardDrive className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-white">
                      Offline Library Vault
                    </h3>
                    <p className="text-[11px] text-steam-subtext">
                      Local SQLite store metadata &amp; artwork cache for instant offline browsing
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  data-testid="clear-offline-media-cache-btn"
                  disabled={isUpdatingVault}
                  onClick={handleClearVaultMediaCache}
                  className="px-2.5 py-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 text-steam-subtext hover:text-white text-[11px] font-semibold transition-colors inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear Offline Media Cache</span>
                </button>
              </div>

              {(() => {
                const activeTier: OfflineVaultTier = vaultStats?.tier || 'balanced';
                const usedBytes =
                  vaultStats?.totalBytes ??
                  (vaultStats?.sqliteBytes || 0) + (vaultStats?.blobBytes || 0);
                const maxBytes = vaultStats?.maxBytes || OFFLINE_VAULT_TIER_CAPS[activeTier];
                const usagePct =
                  maxBytes > 0 ? Math.min(100, Math.round((usedBytes / maxBytes) * 100)) : 0;

                const tierOptions: Array<{ id: OfflineVaultTier; label: string; capLabel: string }> = [
                  { id: 'compact', label: 'Compact', capLabel: '250 MB' },
                  { id: 'balanced', label: 'Balanced', capLabel: '1 GB' },
                  { id: 'full_archive', label: 'Full Archive', capLabel: '2 GB' },
                ];

                return (
                  <>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-steam-subtext">
                          {vaultStats
                            ? `${vaultStats.enrichedGames} of ${vaultStats.totalGames} titles enriched`
                            : 'Vault ready'}
                          {vaultStats?.isHydrating ? ' • Caching in background...' : ''}
                        </span>
                        <span className="font-mono text-white">
                          {formatVaultBytes(usedBytes)} / {formatVaultBytes(maxBytes)}
                        </span>
                      </div>
                      <progress
                        className="sr-only"
                        value={usedBytes}
                        max={Math.max(1, maxBytes)}
                        aria-label="Offline Library Vault storage usage"
                      >
                        {usagePct}%
                      </progress>
                      <div aria-hidden="true" className="h-1.5 w-full rounded-full bg-black/50 overflow-hidden border border-white/5">
                        <div
                          className="h-full bg-steam-accent transition-all duration-300"
                          style={{ width: `${usagePct}%` }}
                        />
                      </div>
                    </div>

                    <div
                      data-testid="offline-vault-tier-selector"
                      className="grid grid-cols-3 gap-2 pt-0.5"
                    >
                      {tierOptions.map((opt) => {
                        const isSelected = activeTier === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            disabled={isUpdatingVault}
                            onClick={() => handleSelectVaultTier(opt.id)}
                            className={`px-2.5 py-2 rounded border text-left transition-colors cursor-pointer disabled:opacity-50 ${
                              isSelected
                                ? 'bg-[#1b2b3d] border-steam-accent text-white shadow-sm'
                                : 'bg-[#101720] border-steam-border/50 text-steam-subtext hover:text-white hover:border-steam-border'
                            }`}
                          >
                            <div className="text-[11px] font-bold">{opt.label}</div>
                            <div className="text-[10px] font-mono opacity-80">{opt.capLabel}</div>
                          </button>
                        );
                      })}
                    </div>
                  </>
                );
              })()}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 border-t border-steam-border/60 bg-[#16202d] flex items-center justify-between text-xs text-steam-subtext">
          <div className="flex items-center gap-1.5 text-[11px]">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span>Store authentication occurs directly via official storefront web services</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-6 px-4 py-1.5 rounded bg-white/10 hover:bg-white/15 text-white text-xs font-semibold transition-colors cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </ModalShell>

    {/* Disconnect Confirmation Warning Dialog */}
    {confirmDisconnectStore && (
      <ModalShell
        isOpen={Boolean(confirmDisconnectStore)}
        onClose={() => setConfirmDisconnectStore(null)}
        ariaLabel="Confirm Storefront Disconnect"
        className="w-full max-w-md"
      >
        <div className="bg-[#1b2838] border border-red-500/60 rounded-lg shadow-2xl max-w-md w-full overflow-hidden text-steam-text p-6 space-y-4 animate-in zoom-in-95 duration-150">
            <div className="flex items-start gap-3.5">
              <div className="p-2.5 rounded-full bg-red-950/80 border border-red-500/60 text-red-400 shrink-0">
                <AlertCircle className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-bold text-white">
                  Disconnect {STORE_AUTH_CONFIGS[confirmDisconnectStore]?.storeName || confirmDisconnectStore.toUpperCase()}?
                </h3>
                <p className="text-xs text-steam-subtext leading-relaxed">
                  Please confirm before removing these titles from your One Launcher library.
                </p>
              </div>
            </div>

            <div className="p-3.5 bg-[#121922] border border-steam-border/60 rounded text-xs space-y-2 text-steam-subtext leading-relaxed">
              <p className="text-white font-medium">
                What this means:
              </p>
              <ul className="list-disc list-inside space-y-1.5 text-slate-300 text-[11px]">
                <li>
                  All titles ({integrations.find((i) => i.storefrontId === confirmDisconnectStore)?.gamesCount || 0} games) from{' '}
                  <strong className="text-white">{STORE_AUTH_CONFIGS[confirmDisconnectStore]?.storeName}</strong> will be removed from your local catalog.
                </li>
                <li>
                  Any locally stored authentication tokens or credentials for this store will be cleared.
                </li>
              </ul>
              <div className="pt-2 border-t border-steam-border/40 text-[11px] text-emerald-400 font-semibold flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Your purchases on {STORE_AUTH_CONFIGS[confirmDisconnectStore]?.storeName} are 100% safe and unaffected.</span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setConfirmDisconnectStore(null)}
                className="px-4 py-2 rounded bg-white/5 hover:bg-white/10 text-steam-text hover:text-white text-xs font-semibold transition-colors cursor-pointer"
              >
                Cancel (Keep Games)
              </button>
              <button
                type="button"
                onClick={() => {
                  const storeToDisconnect = confirmDisconnectStore;
                  setConfirmDisconnectStore(null);
                  handleDisconnect(storeToDisconnect);
                }}
                className="px-4 py-2 rounded bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition-all shadow-md flex items-center gap-1.5 cursor-pointer"
              >
                <Unlink className="w-3.5 h-3.5" />
                Yes, Disconnect & Remove Games
              </button>
            </div>
          </div>
      </ModalShell>
    )}
    </>
  );
};
