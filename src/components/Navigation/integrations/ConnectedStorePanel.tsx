import React from 'react';
import { Gamepad2, RefreshCw, ShieldCheck, Trophy, Unlink } from 'lucide-react';
import type { StorefrontId } from '../../../contracts/platform';
import type { StorefrontIntegration } from '../../../contracts/integration';
import type { XboxGamePassSyncMode } from '../../../contracts/game';
import type { XboxCachedProfileState } from '../../../services/integrations/integrationStorage';
import {
  formatXboxSubscriptionDate,
  resolveXboxSyncModeCatalogCopy,
} from '../../../services/integrations/xboxIntegration';
import { normalizeGogAvatarUrl } from '../../../services/integrations/gogIntegration';
import { StorefrontIcon } from '../../Common/StorefrontIcon';
import { STORE_AUTH_CONFIGS } from '../../../hooks/useStorefrontAuthFlow';

export interface ConnectedStorePanelProps {
  selectedTab: StorefrontId;
  currentIntegration: StorefrontIntegration;
  xboxProfile: XboxCachedProfileState | null;
  avatarImgError: boolean;
  onAvatarImgError: () => void;
  isSubmitting: boolean;
  isUpdatingXboxMode: boolean;
  xboxModePlayedId: string;
  xboxModePlayedDescId: string;
  xboxModeFullId: string;
  xboxModeFullDescId: string;
  xboxModeOwnedId: string;
  xboxModeOwnedDescId: string;
  onRequestDisconnect: (storefrontId: StorefrontId) => void;
  onXboxSyncModeChange: (mode: XboxGamePassSyncMode) => void;
  onResync: (storefrontId: StorefrontId) => void;
}

export const ConnectedStorePanel: React.FC<ConnectedStorePanelProps> = ({
  selectedTab,
  currentIntegration,
  xboxProfile,
  avatarImgError,
  onAvatarImgError,
  isSubmitting,
  isUpdatingXboxMode,
  xboxModePlayedId,
  xboxModePlayedDescId,
  xboxModeFullId,
  xboxModeFullDescId,
  xboxModeOwnedId,
  xboxModeOwnedDescId,
  onRequestDisconnect,
  onXboxSyncModeChange,
  onResync,
}) => {
  const avatarSrc =
    selectedTab === 'gog'
      ? normalizeGogAvatarUrl(currentIntegration.avatarUrl) || currentIntegration.avatarUrl
      : selectedTab === 'xbox'
        ? xboxProfile?.avatarUrl || currentIntegration.avatarUrl
        : currentIntegration.avatarUrl;

  const accountIdDisplay =
    selectedTab === 'xbox'
      ? xboxProfile?.xuid || currentIntegration.accountId
      : currentIntegration.accountId;

  const renderXboxSubscriptionPill = () => {
    const sub = xboxProfile?.subscription;
    const endLabel = formatXboxSubscriptionDate(sub?.earliestActivePassEndDate || sub?.endDate);
    if (sub?.hasActiveSubscription && sub.hasPcCatalogAccess) {
      const displayTier = sub.tierDisplayName || 'PC Game Pass';
      const showTrialSuffix = Boolean(sub.isTrial) && !/\btrial\b/i.test(displayTier);
      return (
        <span
          data-testid="xbox-subscription-pill"
          className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-950/85 text-emerald-200 border border-emerald-500/45 inline-flex items-center gap-1.5"
        >
          <Trophy aria-hidden="true" className="w-3 h-3 text-emerald-300" />
          <span>
            {displayTier}
            {showTrialSuffix ? ' (Trial)' : ''}
          </span>
          {endLabel && (
            <span className="text-emerald-200/90 font-normal">
              • {sub.autoRenew ? `Renews ${endLabel}` : `Expires ${endLabel}`}
            </span>
          )}
        </span>
      );
    }
    if (sub?.hasActiveSubscription && !sub.hasPcCatalogAccess) {
      return (
        <span
          data-testid="xbox-subscription-pill"
          className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-950/85 text-amber-200 border border-amber-500/45 inline-flex items-center gap-1.5"
        >
          <span>
            {sub.tierDisplayName || 'Xbox Game Pass for Console'} (Owned PC Games Only)
          </span>
          {endLabel && (
            <span className="text-amber-200/90 font-normal">
              • {sub.autoRenew ? `Renews ${endLabel}` : `Expires ${endLabel}`}
            </span>
          )}
        </span>
      );
    }
    return (
      <span
        data-testid="xbox-subscription-pill"
        className="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-800/90 text-slate-200 border border-slate-600/60 inline-flex items-center gap-1"
      >
        <span>No Active Game Pass (Owned Games Only)</span>
      </span>
    );
  };

  const renderXboxSyncModeFieldset = () => {
    const activeSyncMode: XboxGamePassSyncMode = xboxProfile?.syncMode || 'owned_and_played';
    const hasExplicitNoPcCatalog = Boolean(
      xboxProfile?.subscription &&
        (!xboxProfile.subscription.hasActiveSubscription ||
          !xboxProfile.subscription.hasPcCatalogAccess)
    );
    const disableFullCatalogOption =
      hasExplicitNoPcCatalog && activeSyncMode !== 'full_pc_game_pass';
    const syncCopy = resolveXboxSyncModeCatalogCopy(xboxProfile?.subscription);

    return (
      <fieldset
        data-testid="xbox-sync-mode-fieldset"
        disabled={isUpdatingXboxMode || isSubmitting}
        className="bg-[#111923] border border-steam-border/60 rounded-lg p-3.5 space-y-2.5 disabled:opacity-60"
      >
        <legend className="px-1.5 text-[11px] font-bold uppercase tracking-wider text-emerald-300">
          {syncCopy.legendLabel}
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
              onChange={() => onXboxSyncModeChange('owned_and_played')}
              className="mt-0.5 h-3.5 w-3.5 accent-emerald-500 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-1 focus-visible:ring-offset-[#111923]"
            />
            <div className="min-w-0 flex-1">
              <label
                htmlFor={xboxModePlayedId}
                className="block text-xs font-semibold text-white cursor-pointer"
              >
                {syncCopy.playedModeLabel}
              </label>
              <p
                id={xboxModePlayedDescId}
                className="text-[11px] text-steam-subtext leading-snug mt-0.5"
              >
                {syncCopy.playedModeDescription}
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
              onChange={() => onXboxSyncModeChange('full_pc_game_pass')}
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
                {syncCopy.fullCatalogLabel}
              </label>
              <p
                id={xboxModeFullDescId}
                className="text-[11px] text-steam-subtext leading-snug mt-0.5"
              >
                {syncCopy.fullCatalogDescription}
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
              onChange={() => onXboxSyncModeChange('owned_only')}
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
                Syncs only permanent Microsoft Store / Xbox Play Anywhere purchases; excludes
                subscription-only titles.
              </p>
            </div>
          </div>
        </div>
      </fieldset>
    );
  };

  return (
    <div className="bg-[#16202d] border border-steam-border/80 rounded-lg p-5 space-y-4">
      <div className="flex items-start justify-between gap-4 pb-4 border-b border-steam-border/40">
        <div className="flex items-center gap-4 min-w-0">
          {avatarSrc && !avatarImgError ? (
            <img
              src={avatarSrc}
              alt="Avatar"
              onError={onAvatarImgError}
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
            {accountIdDisplay && (
              <p className="text-xs text-steam-subtext font-mono mt-0.5">ID: {accountIdDisplay}</p>
            )}
            {selectedTab === 'xbox' && (
              <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                {renderXboxSubscriptionPill()}
              </div>
            )}
            <p className="text-xs text-steam-accent mt-1.5 flex items-center gap-1.5 font-medium">
              <Gamepad2 aria-hidden="true" className="w-3.5 h-3.5" />
              {currentIntegration.gamesCount}{' '}
              {selectedTab === 'xbox'
                ? xboxProfile?.subscription?.hasActiveSubscription &&
                  xboxProfile.subscription.hasPcCatalogAccess
                  ? `Xbox & ${(xboxProfile.subscription.tierDisplayName || 'Game Pass').replace(/^Xbox\s+/i, '')} Titles Cataloged`
                  : 'Owned & Installed Xbox Titles Cataloged'
                : 'Owned Titles Cataloged'}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => onRequestDisconnect(selectedTab)}
          className="px-3 py-1.5 rounded bg-red-950/40 hover:bg-red-900/60 border border-red-700/50 text-red-300 text-xs font-semibold transition-colors flex items-center gap-1.5 cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
        >
          <Unlink aria-hidden="true" className="w-3.5 h-3.5" />
          Disconnect
        </button>
      </div>

      {selectedTab === 'xbox' && renderXboxSyncModeFieldset()}

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
          onClick={() => onResync(selectedTab)}
          disabled={isSubmitting || isUpdatingXboxMode}
          className="px-3 py-1.5 rounded bg-steam-accent hover:bg-sky-300 text-black text-xs font-semibold transition-all flex items-center gap-1.5 shadow-md disabled:opacity-50 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#16202d]"
        >
          <RefreshCw
            aria-hidden="true"
            className={`w-3.5 h-3.5 ${isSubmitting || isUpdatingXboxMode ? 'animate-spin' : ''}`}
          />
          {isSubmitting || isUpdatingXboxMode ? 'Syncing...' : 'Re-sync Library Now'}
        </button>
      </div>
    </div>
  );
};
