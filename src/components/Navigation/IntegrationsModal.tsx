import React, { useState, useEffect, useRef } from 'react';
import { X, CheckCircle2, AlertCircle, Cloud, ShieldCheck } from 'lucide-react';
import type { StorefrontId } from '../../contracts/platform';
import type { OfflineVaultStats, OfflineVaultTier } from '../../contracts/network';
import type { CanonicalGame } from '../../contracts/game';
import { ModalShell } from '../Common/ModalShell';
import { useSafeId } from '../../utils/useSafeId';
import { useStorefrontAuthFlow } from '../../hooks/useStorefrontAuthFlow';
import { StorefrontTabBar } from './integrations/StorefrontTabBar';
import { AuthenticatingStorePanel } from './integrations/AuthenticatingStorePanel';
import { ConnectedStorePanel } from './integrations/ConnectedStorePanel';
import { DisconnectedStorePanel } from './integrations/DisconnectedStorePanel';
import { OfflineVaultSection } from './integrations/OfflineVaultSection';
import { DisconnectStoreConfirmDialog } from './integrations/DisconnectStoreConfirmDialog';

export interface IntegrationsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLibraryUpdated: (games: CanonicalGame[]) => void;
}

export const IntegrationsModal: React.FC<IntegrationsModalProps> = ({
  isOpen,
  onClose,
  onLibraryUpdated,
}) => {
  const [selectedTab, setSelectedTab] = useState<StorefrontId>('steam');
  const [showAdvancedInputs, setShowAdvancedInputs] = useState(false);
  const [confirmDisconnectStore, setConfirmDisconnectStore] = useState<StorefrontId | null>(null);
  const [avatarImgError, setAvatarImgError] = useState(false);
  const [vaultStats, setVaultStats] = useState<OfflineVaultStats | null>(null);
  const [isUpdatingVault, setIsUpdatingVault] = useState(false);
  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const authFlow = useStorefrontAuthFlow({
    isOpen,
    selectedTab,
    onLibraryUpdated,
  });

  const tabIdPrefix = useSafeId('integ-tab');
  const tabPanelId = useSafeId('integ-tabpanel');
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
  }, [selectedTab, authFlow.integrations]);

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

  const {
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
  } = authFlow;

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
      setSuccessMsg(
        'Cleared cached offline media blobs while preserving enriched store metadata.'
      );
    } catch {
      // Ignore clear errors
    } finally {
      setIsUpdatingVault(false);
    }
  };

  const hasOfflineVaultBridge =
    typeof window !== 'undefined' && Boolean(window.electronAPI?.offlineVault);

  const activeTabId = `${tabIdPrefix}-${currentIntegration.storefrontId}`;

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
                <Cloud aria-hidden="true" className="w-5 h-5" />
              </div>
              <div>
                <h2
                  id="integrations-modal-title"
                  className="text-lg font-bold text-white flex items-center gap-2"
                >
                  Storefront Integrations &amp; Cloud Sync
                </h2>
                <p className="text-xs text-steam-subtext">
                  Connect your accounts directly via official web sign in — No desktop launchers
                  required
                </p>
              </div>
            </div>
            <button
              type="button"
              aria-label="Close storefront integrations"
              onClick={onClose}
              className="min-w-6 min-h-6 inline-flex items-center justify-center p-1.5 rounded hover:bg-white/10 text-steam-subtext hover:text-white transition-colors cursor-pointer"
            >
              <X aria-hidden="true" className="w-5 h-5" />
            </button>
          </div>

          {/* Accessible Storefront Navigation Tabs */}
          <StorefrontTabBar
            integrations={integrations}
            selectedTab={selectedTab}
            tabIdPrefix={tabIdPrefix}
            tabPanelId={tabPanelId}
            tabButtonRefs={tabButtonRefs}
            onSelectTab={(storefrontId) => {
              setSelectedTab(storefrontId);
              setErrorMsg(null);
              setSuccessMsg(null);
              setAuthenticatingStore(null);
              setShowAdvancedInputs(false);
            }}
          />

          {/* Modal Body */}
          <div
            id={tabPanelId}
            role="tabpanel"
            aria-labelledby={activeTabId}
            className="p-6 overflow-y-auto space-y-6 flex-1"
          >
            {/* Status / Alert Notifications */}
            {errorMsg && (
              <div
                role="alert"
                className="p-3 bg-red-950/60 border border-red-700/60 rounded text-red-200 text-xs flex items-center gap-2.5"
              >
                <AlertCircle aria-hidden="true" className="w-4 h-4 flex-shrink-0 text-red-400" />
                <span>{errorMsg}</span>
              </div>
            )}

            {successMsg && (
              <div
                role="status"
                aria-live="polite"
                className="p-3 bg-emerald-950/60 border border-emerald-700/60 rounded text-emerald-200 text-xs flex items-center gap-2.5"
              >
                <CheckCircle2
                  aria-hidden="true"
                  className="w-4 h-4 flex-shrink-0 text-emerald-400"
                />
                <span>{successMsg}</span>
              </div>
            )}

            {authenticatingStore === selectedTab ? (
              <AuthenticatingStorePanel
                selectedTab={selectedTab}
                authRedirectFieldId={authRedirectFieldId}
                authRedirectInput={authRedirectInput}
                isSubmitting={isSubmitting}
                onChangeAuthRedirectInput={setAuthRedirectInput}
                onCompleteAuth={completeStoreAuthentication}
                onRelaunchSignIn={handleLaunchStoreSignIn}
                onCancelAuth={() => setAuthenticatingStore(null)}
              />
            ) : currentIntegration.isConnected ? (
              <ConnectedStorePanel
                selectedTab={selectedTab}
                currentIntegration={currentIntegration}
                xboxProfile={xboxProfile}
                avatarImgError={avatarImgError}
                onAvatarImgError={() => setAvatarImgError(true)}
                isSubmitting={isSubmitting}
                isUpdatingXboxMode={isUpdatingXboxMode}
                xboxModePlayedId={xboxModePlayedId}
                xboxModePlayedDescId={xboxModePlayedDescId}
                xboxModeFullId={xboxModeFullId}
                xboxModeFullDescId={xboxModeFullDescId}
                xboxModeOwnedId={xboxModeOwnedId}
                xboxModeOwnedDescId={xboxModeOwnedDescId}
                onRequestDisconnect={setConfirmDisconnectStore}
                onXboxSyncModeChange={handleXboxSyncModeChange}
                onResync={(storeId) => completeStoreAuthentication(storeId)}
              />
            ) : (
              <DisconnectedStorePanel
                selectedTab={selectedTab}
                currentIntegration={currentIntegration}
                showAdvancedInputs={showAdvancedInputs}
                isSubmitting={isSubmitting}
                steamIdFieldId={steamIdFieldId}
                steamKeyFieldId={steamKeyFieldId}
                gogUserFieldId={gogUserFieldId}
                gogTokenFieldId={gogTokenFieldId}
                epicIdFieldId={epicIdFieldId}
                epicTokenFieldId={epicTokenFieldId}
                xboxTagFieldId={xboxTagFieldId}
                steamInput={steamInput}
                steamApiKey={steamApiKey}
                gogInput={gogInput}
                gogToken={gogToken}
                epicInput={epicInput}
                epicToken={epicToken}
                xboxInput={xboxInput}
                onChangeSteamInput={setSteamInput}
                onChangeSteamApiKey={setSteamApiKey}
                onChangeGogInput={setGogInput}
                onChangeGogToken={setGogToken}
                onChangeEpicInput={setEpicInput}
                onChangeEpicToken={setEpicToken}
                onChangeXboxInput={setXboxInput}
                onToggleAdvancedInputs={() => setShowAdvancedInputs((prev) => !prev)}
                onRequestDisconnect={setConfirmDisconnectStore}
                onLaunchSignIn={handleLaunchStoreSignIn}
                onQuickConnect={handleQuickConnect}
                onCompleteManualAuth={(storeId) => completeStoreAuthentication(storeId)}
              />
            )}

            {/* Offline Library Vault Management (Electron Desktop Runtime) */}
            {hasOfflineVaultBridge && (
              <OfflineVaultSection
                vaultStats={vaultStats}
                isUpdatingVault={isUpdatingVault}
                onSelectTier={handleSelectVaultTier}
                onClearMediaCache={handleClearVaultMediaCache}
              />
            )}
          </div>

          {/* Modal Footer */}
          <div className="px-6 py-3 border-t border-steam-border/60 bg-[#16202d] flex items-center justify-between text-xs text-steam-subtext">
            <div className="flex items-center gap-1.5 text-[11px]">
              <ShieldCheck aria-hidden="true" className="w-3.5 h-3.5 text-emerald-400" />
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
      <DisconnectStoreConfirmDialog
        storefrontId={confirmDisconnectStore}
        gamesCount={
          confirmDisconnectStore
            ? integrations.find((i) => i.storefrontId === confirmDisconnectStore)?.gamesCount || 0
            : 0
        }
        onCancel={() => setConfirmDisconnectStore(null)}
        onConfirmDisconnect={(storeToDisconnect) => {
          setConfirmDisconnectStore(null);
          handleDisconnect(storeToDisconnect);
        }}
      />
    </>
  );
};
