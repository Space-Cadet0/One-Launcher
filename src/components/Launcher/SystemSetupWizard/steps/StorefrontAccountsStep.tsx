import React, { useEffect, useState } from 'react';
import type { CanonicalGame } from '../../../../contracts/game';
import type { StorefrontCredentials, StorefrontIntegration } from '../../../../contracts/integration';
import type { StorefrontId } from '../../../../contracts/platform';
import type { EnvironmentHealthSnapshot } from '../../../../contracts/environmentSetup';
import type {
  AchievementSummaryEntry,
  ElectronAPI,
  StorefrontAuthResult,
  StorefrontTokenSummary,
} from '../../../../types/electron';
import {
  loadCurrentCatalog,
  loadIntegrations,
  loadXboxProfileState,
  mergeStorefrontGames,
  saveCurrentCatalog,
  saveIntegrations,
  saveXboxProfileState,
  type XboxCachedProfileState,
} from '../../../../services/integrations/integrationStorage';
import { normalizeGogAvatarUrl } from '../../../../services/integrations/gogIntegration';
import { cacheUserXboxAchievements } from '../../../../services/storage/knownGameAchievements';
import { environmentSetupService } from '../../../../services/launcher/environmentSetupService';
import { StorefrontIcon } from '../../../Common/StorefrontIcon';
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  KeyRound,
  Loader2,
  Sparkles,
} from 'lucide-react';

export interface StorefrontAccountsStepProps {
  snapshot: EnvironmentHealthSnapshot;
  connectedStorefronts: StorefrontId[];
  onAccountsChanged: (nextConnected: StorefrontId[]) => void;
  onOpenIntegrationsModal?: () => void;
  onLibraryUpdated?: (games: CanonicalGame[]) => void;
}

type CoreStorefrontId = 'steam' | 'gog' | 'epic' | 'xbox';

type ExtendedAuthBridge = ElectronAPI & {
  openStorefrontAuthWindow?: (storefrontId: string) => Promise<StorefrontAuthResult>;
};

type NativeSyncPayload = Partial<StorefrontAuthResult> & {
  gamerpicUrl?: string;
  hasDeviceContext?: boolean;
  tokenData?: (StorefrontTokenSummary & { expires_at?: string }) | null;
  achievements?: Record<string, AchievementSummaryEntry>;
};

interface CoreStoreCardSpec {
  id: CoreStorefrontId;
  title: string;
  badge: string;
  bridgingNote: string;
}

const CORE_STOREFRONTS: ReadonlyArray<CoreStoreCardSpec> = [
  {
    id: 'steam',
    title: 'Steam',
    badge: 'Library, playtime & achievements',
    bridgingNote: 'Imports your Steam games, playtime, and achievements.',
  },
  {
    id: 'gog',
    title: 'GOG.com',
    badge: 'Downloads & cloud saves built in',
    bridgingNote: 'Downloads games and syncs cloud saves directly — no GOG app needed.',
  },
  {
    id: 'epic',
    title: 'Epic Games',
    badge: 'Downloads, cloud saves & multiplayer built in',
    bridgingNote:
      'Downloads games, syncs cloud saves, and runs multiplayer — no Epic app needed.',
  },
  {
    id: 'xbox',
    title: 'Xbox / PC Game Pass',
    badge: 'Game Pass & Microsoft Store',
    bridgingNote:
      'Imports your Xbox and PC Game Pass library with achievements and cloud saves.',
  },
];

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

function scrubLoadedIntegrations(): StorefrontIntegration[] {
  const loaded = loadIntegrations();
  let mutated = false;
  const cleaned = loaded.map((integ) => {
    const raw = integ.credentials;
    if (
      raw &&
      (raw.apiKey || raw.webToken || raw.gogToken || raw.epicToken || raw.epicRefreshToken)
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

function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  return fallback;
}

export const StorefrontAccountsStep: React.FC<StorefrontAccountsStepProps> = ({
  snapshot,
  connectedStorefronts,
  onAccountsChanged,
  onOpenIntegrationsModal,
  onLibraryUpdated,
}) => {
  const [integrations, setIntegrations] = useState<StorefrontIntegration[]>(() =>
    scrubLoadedIntegrations()
  );
  const [xboxProfile, setXboxProfile] = useState<XboxCachedProfileState | null>(() =>
    loadXboxProfileState()
  );
  const [signingInStore, setSigningInStore] = useState<CoreStorefrontId | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: 'emerald' | 'rose';
    message: string;
  } | null>(null);

  useEffect(() => {
    setIntegrations(scrubLoadedIntegrations());
    setXboxProfile(loadXboxProfileState());
  }, [connectedStorefronts]);

  const applyNativeAuthSuccess = async (
    storefrontId: CoreStorefrontId,
    storeTitle: string,
    res: NativeSyncPayload
  ) => {
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
        ? res.modernGamertag || res.gamertag || res.accountName || 'Xbox User'
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
          res.subscription !== undefined
            ? res.subscription
            : (prevXboxProfile?.subscription ?? null),
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
      name: storeTitle,
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
      statusMessage: `Connected as ${resolvedAccountName} (${count} games)`,
      credentials: sanitizePublicCredentials(storefrontId, {
        steamId:
          storefrontId === 'steam'
            ? res.accountId || res.tokenData?.steamId || undefined
            : undefined,
        epicAccountId:
          storefrontId === 'epic'
            ? res.accountId || res.tokenData?.account_id || undefined
            : undefined,
        epicTokenExpiresAt:
          storefrontId === 'epic' && expiresAtRaw !== undefined
            ? String(expiresAtRaw)
            : undefined,
        gogUsername: storefrontId === 'gog' ? resolvedAccountName : undefined,
      }),
    };

    const existingList = scrubLoadedIntegrations();
    const hasEntry = existingList.some((i) => i.storefrontId === storefrontId);
    const updatedIntegrations = hasEntry
      ? existingList.map((i) => (i.storefrontId === storefrontId ? integration : i))
      : [...existingList, integration];

    saveIntegrations(updatedIntegrations);
    setIntegrations(updatedIntegrations);

    if (shouldMergeGames) {
      saveCurrentCatalog(merged);
      onLibraryUpdated?.(merged);
    }

    const nextConnected = updatedIntegrations
      .filter((i) => i.isConnected)
      .map((i) => i.storefrontId);
    onAccountsChanged(nextConnected);
    await environmentSetupService.probeHealth(nextConnected, { forceFresh: true });

    setFeedback({
      tone: 'emerald',
      message: `Connected to ${storeTitle} as ${resolvedAccountName} (${count} games).`,
    });
  };

  const handleSignInStore = async (spec: CoreStoreCardSpec) => {
    if (signingInStore) return;
    setFeedback(null);

    const api = (typeof window !== 'undefined' ? window.electronAPI : undefined) as
      | ExtendedAuthBridge
      | undefined;
    const authLauncher =
      typeof api?.openStorefrontAuthWindow === 'function'
        ? api.openStorefrontAuthWindow.bind(api)
        : typeof api?.loginStore === 'function'
          ? api.loginStore.bind(api)
          : null;

    if (!authLauncher) {
      if (onOpenIntegrationsModal) {
        onOpenIntegrationsModal();
        return;
      }
      setFeedback({
        tone: 'rose',
        message: 'Store sign-in is only available inside the One Launcher app.',
      });
      return;
    }

    setSigningInStore(spec.id);
    try {
      const authRes = await authLauncher(spec.id);
      if (!authRes?.success) {
        if (authRes?.error) {
          setFeedback({ tone: 'rose', message: authRes.error });
        }
        return;
      }

      let finalPayload: NativeSyncPayload = {
        ...authRes,
        achievements: authRes.achievements as Record<string, AchievementSummaryEntry> | undefined,
      };

      if (!Array.isArray(authRes.games) || authRes.games.length === 0) {
        if (authRes.code && typeof api?.exchangeCode === 'function') {
          const exchanged = await api.exchangeCode(spec.id, authRes.code);
          if (exchanged?.success) {
            finalPayload = {
              ...exchanged,
              achievements: exchanged.achievements as
                | Record<string, AchievementSummaryEntry>
                | undefined,
            };
          } else if (exchanged?.error) {
            setFeedback({ tone: 'rose', message: exchanged.error });
            return;
          }
        } else if (
          !authRes.accountName &&
          !authRes.gamertag &&
          typeof api?.syncStore === 'function'
        ) {
          const synced = await api.syncStore(spec.id);
          if (synced?.success) {
            finalPayload = {
              ...authRes,
              ...synced,
              achievements: synced.achievements as
                | Record<string, AchievementSummaryEntry>
                | undefined,
            };
          }
        }
      }

      await applyNativeAuthSuccess(spec.id, spec.title, finalPayload);
    } catch (err: unknown) {
      setFeedback({
        tone: 'rose',
        message: getErrorMessage(err, `Could not sign in to ${spec.title}.`),
      });
    } finally {
      setSigningInStore(null);
    }
  };

  const connectedSet = new Set<StorefrontId>([
    ...connectedStorefronts,
    ...integrations.filter((i) => i.isConnected).map((i) => i.storefrontId),
  ]);

  return (
    <div className="space-y-4" data-testid="setup-step-accounts">
      <div className="p-3 rounded-lg bg-[#131c27] border border-[#2a475e]/80 text-xs text-slate-200 leading-relaxed">
        Sign in to import your games. GOG, Epic, and Xbox games can download and sync cloud saves
        right away without installing their store apps.
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div
          role={feedback.tone === 'rose' ? 'alert' : 'status'}
          aria-live="polite"
          className={`rounded-lg border px-3.5 py-2.5 text-xs flex items-center gap-2 ${
            feedback.tone === 'emerald'
              ? 'bg-emerald-950/50 border-emerald-500/45 text-emerald-200'
              : 'bg-rose-950/55 border-rose-500/50 text-rose-200'
          }`}
        >
          {feedback.tone === 'emerald' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
          ) : (
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" aria-hidden="true" />
          )}
          <span>{feedback.message}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
          Game Store Accounts ({CORE_STOREFRONTS.length})
        </span>
        <span className="text-[11px] text-slate-300">Connect only the stores you use</span>
      </div>

      {/* Storefront Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {CORE_STOREFRONTS.map((spec) => {
          const integ = integrations.find((i) => i.storefrontId === spec.id);
          const isConnected = connectedSet.has(spec.id) || Boolean(integ?.isConnected);
          const localHints = (snapshot.localStoreHints || []).filter(
            (h) => h.storefrontId === spec.id
          );
          const isSigningIn = signingInStore === spec.id;
          const accountLabel =
            spec.id === 'xbox'
              ? xboxProfile?.modernGamertag || xboxProfile?.gamertag || integ?.accountName
              : integ?.accountName;

          return (
            <div
              key={spec.id}
              data-testid={`setup-account-card-${spec.id}`}
              className={`rounded-lg border p-3.5 flex flex-col justify-between gap-3 transition-all ${
                isConnected
                  ? 'bg-[#16202d] border-emerald-500/45'
                  : 'bg-[#16202d] border-[#2a475e]/80 hover:border-[#66c0f4]/60'
              }`}
            >
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-[#1b2838] border border-[#2a475e] flex items-center justify-center shrink-0">
                      <StorefrontIcon
                        storefrontId={spec.id}
                        decorative
                        className={`w-4 h-4 ${
                          spec.id === 'xbox' ? 'text-[#52d652]' : 'text-[#66c0f4]'
                        }`}
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-white truncate">{spec.title}</div>
                      <div className="text-[10px] text-sky-300 font-medium truncate">
                        {spec.badge}
                      </div>
                    </div>
                  </div>

                  {isConnected ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-[10px] font-bold text-emerald-300 shrink-0">
                      <CheckCircle2 className="w-3 h-3 text-emerald-400" aria-hidden="true" />
                      <span>Connected</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded bg-[#1b2838] border border-[#2a475e] text-[10px] font-semibold text-slate-300 shrink-0">
                      Not Connected
                    </span>
                  )}
                </div>

                {isConnected && accountLabel && (
                  <div className="rounded bg-[#131c27] border border-emerald-500/25 px-2.5 py-1.5 text-[11px] text-emerald-200 flex items-center justify-between gap-2">
                    <span className="truncate">
                      Signed in as <strong className="text-white">{accountLabel}</strong>
                    </span>
                    {typeof integ?.gamesCount === 'number' && integ.gamesCount > 0 && (
                      <span className="text-[10px] font-mono text-slate-300 shrink-0">
                        {integ.gamesCount} games
                      </span>
                    )}
                  </div>
                )}

                {localHints.length > 0 && (
                  <div
                    data-testid={`setup-local-hint-${spec.id}`}
                    className="rounded bg-[#131c27] border border-[#66c0f4]/35 px-2.5 py-1.5 text-[11px] text-sky-200 space-y-0.5"
                  >
                    {localHints.map((hint, idx) => (
                      <div key={`${hint.sourceLabel}-${idx}`} className="flex items-center gap-1.5">
                        <Sparkles className="w-3 h-3 text-[#66c0f4] shrink-0" aria-hidden="true" />
                        <span className="truncate">
                          Found on this computer: {hint.sourceLabel}
                          {hint.publicHandleHint ? ` (${hint.publicHandleHint})` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <p className="text-[11px] text-slate-300 leading-relaxed">{spec.bridgingNote}</p>
              </div>

              <div className="pt-1 flex items-center justify-between gap-2">
                {!isConnected ? (
                  <button
                    type="button"
                    data-testid={`setup-connect-${spec.id}`}
                    disabled={signingInStore !== null}
                    onClick={() => void handleSignInStore(spec)}
                    className="min-h-6 w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-[#66c0f4] text-slate-950 font-bold hover:brightness-110 text-xs shadow transition-all cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
                  >
                    {isSigningIn ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 ol-guided-spinner" aria-hidden="true" />
                        <span>Signing In to {spec.title}...</span>
                      </>
                    ) : (
                      <>
                        <Cloud className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Sign In to {spec.title}</span>
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid={`setup-connect-${spec.id}`}
                    disabled={signingInStore !== null}
                    onClick={() => void handleSignInStore(spec)}
                    className="min-h-6 w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1b2838] hover:bg-[#24354a] border border-[#2a475e] hover:border-[#66c0f4] text-xs font-semibold text-slate-200 hover:text-white transition-colors cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
                  >
                    {isSigningIn ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 ol-guided-spinner" aria-hidden="true" />
                        <span>Refreshing {spec.title}...</span>
                      </>
                    ) : (
                      <span>Refresh {spec.title}</span>
                    )}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Advanced / Manual Account Settings Footer Card */}
      {onOpenIntegrationsModal && (
        <div className="rounded-lg bg-[#131c27] border border-[#2a475e]/80 p-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <KeyRound className="w-4 h-4 text-[#66c0f4] shrink-0" aria-hidden="true" />
            <div className="text-xs text-slate-300">
              Need manual API keys or offline library settings?
            </div>
          </div>
          <button
            type="button"
            data-testid="setup-open-advanced-accounts-btn"
            onClick={onOpenIntegrationsModal}
            className="min-h-6 px-3 py-1.5 rounded-md bg-[#1b2838] hover:bg-[#24354a] border border-[#2a475e] hover:border-[#66c0f4] text-xs font-semibold text-[#66c0f4] hover:text-white transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#66c0f4]"
          >
            Advanced Settings...
          </button>
        </div>
      )}
    </div>
  );
};
