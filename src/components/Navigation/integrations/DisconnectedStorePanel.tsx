import React from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Key,
  Lock,
  Sparkles,
  Unlink,
} from 'lucide-react';
import type { StorefrontId } from '../../../contracts/platform';
import type { StorefrontIntegration } from '../../../contracts/integration';
import { StorefrontIcon } from '../../Common/StorefrontIcon';
import { STORE_AUTH_CONFIGS } from '../../../hooks/useStorefrontAuthFlow';

export interface DisconnectedStorePanelProps {
  selectedTab: StorefrontId;
  currentIntegration: StorefrontIntegration;
  showAdvancedInputs: boolean;
  isSubmitting: boolean;
  steamIdFieldId: string;
  steamKeyFieldId: string;
  gogUserFieldId: string;
  gogTokenFieldId: string;
  epicIdFieldId: string;
  epicTokenFieldId: string;
  xboxTagFieldId: string;
  steamInput: string;
  steamApiKey: string;
  gogInput: string;
  gogToken: string;
  epicInput: string;
  epicToken: string;
  xboxInput: string;
  onChangeSteamInput: (value: string) => void;
  onChangeSteamApiKey: (value: string) => void;
  onChangeGogInput: (value: string) => void;
  onChangeGogToken: (value: string) => void;
  onChangeEpicInput: (value: string) => void;
  onChangeEpicToken: (value: string) => void;
  onChangeXboxInput: (value: string) => void;
  onToggleAdvancedInputs: () => void;
  onRequestDisconnect: (storefrontId: StorefrontId) => void;
  onLaunchSignIn: (storefrontId: StorefrontId) => void;
  onQuickConnect: (storefrontId: StorefrontId) => void;
  onCompleteManualAuth: (storefrontId: StorefrontId) => void;
}

export const DisconnectedStorePanel: React.FC<DisconnectedStorePanelProps> = ({
  selectedTab,
  currentIntegration,
  showAdvancedInputs,
  isSubmitting,
  steamIdFieldId,
  steamKeyFieldId,
  gogUserFieldId,
  gogTokenFieldId,
  epicIdFieldId,
  epicTokenFieldId,
  xboxTagFieldId,
  steamInput,
  steamApiKey,
  gogInput,
  gogToken,
  epicInput,
  epicToken,
  xboxInput,
  onChangeSteamInput,
  onChangeSteamApiKey,
  onChangeGogInput,
  onChangeGogToken,
  onChangeEpicInput,
  onChangeEpicToken,
  onChangeXboxInput,
  onToggleAdvancedInputs,
  onRequestDisconnect,
  onLaunchSignIn,
  onQuickConnect,
  onCompleteManualAuth,
}) => {
  const storeName = STORE_AUTH_CONFIGS[selectedTab]?.storeName;

  return (
    <div className="space-y-5">
      {/* Baseline library notice if titles exist while disconnected */}
      {currentIntegration.gamesCount > 0 && (
        <div className="bg-amber-950/30 border border-amber-500/50 rounded-lg p-3.5 flex items-center justify-between gap-3 shadow-inner">
          <div className="flex items-center gap-2.5 min-w-0">
            <AlertCircle aria-hidden="true" className="w-4 h-4 text-amber-400 shrink-0" />
            <div className="text-xs">
              <span className="font-bold text-amber-300">
                {currentIntegration.gamesCount} {storeName} titles
              </span>{' '}
              <span className="text-amber-200/90">
                are cached in your library (Not Connected).
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onRequestDisconnect(selectedTab)}
            className="px-2.5 py-1 rounded bg-red-950/50 hover:bg-red-900/70 border border-red-700/60 text-red-300 text-xs font-semibold transition-colors flex items-center gap-1.5 shrink-0 cursor-pointer"
            title="Remove storefront titles from library"
          >
            <Unlink aria-hidden="true" className="w-3 h-3" />
            <span>Disconnect &amp; Remove</span>
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
          <h3 className="text-base font-bold text-white">Sign in with {storeName}</h3>
          <p className="text-xs text-steam-subtext max-w-sm mx-auto mt-1 leading-relaxed">
            Click below to open the official {storeName} sign-in page. Zero manual configuration —
            authenticate through your browser and we&apos;ll sync your owned licenses.
          </p>
        </div>

        {/* Big Store Sign In Button */}
        <div className="pt-2 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => onLaunchSignIn(selectedTab)}
            className={`w-full max-w-xs py-3 px-5 rounded font-bold text-xs transition-all shadow-lg flex items-center justify-center gap-2.5 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#16202d] ${
              selectedTab === 'gog'
                ? 'bg-purple-600 hover:bg-purple-700 text-white shadow-purple-900/30'
                : selectedTab === 'steam'
                  ? 'bg-steam-accent hover:bg-sky-300 text-black shadow-sky-900/30'
                  : selectedTab === 'epic'
                    ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-900/30'
                    : 'bg-emerald-700 hover:bg-emerald-800 text-white shadow-emerald-900/30'
            }`}
          >
            <Lock aria-hidden="true" className="w-4 h-4" />
            <span>Sign In to {storeName}</span>
            <ExternalLink aria-hidden="true" className="w-3.5 h-3.5 opacity-80" />
          </button>

          <button
            type="button"
            onClick={() => onQuickConnect(selectedTab)}
            disabled={isSubmitting}
            className="text-xs text-steam-subtext hover:text-white transition-colors flex items-center gap-1.5 pt-1 cursor-pointer"
          >
            <Sparkles aria-hidden="true" className="w-3.5 h-3.5 text-amber-400" />
            <span>Or 1-click Quick Connect &amp; Sync Catalog</span>
          </button>
        </div>
      </div>

      {/* Advanced Manual Connection Accordion */}
      <div className="border border-steam-border/60 rounded-lg bg-[#141b24] overflow-hidden">
        <button
          type="button"
          aria-expanded={showAdvancedInputs}
          onClick={onToggleAdvancedInputs}
          className="w-full px-4 py-2.5 text-xs text-steam-subtext hover:text-white flex items-center justify-between transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-1.5 font-medium">
            <Key aria-hidden="true" className="w-3.5 h-3.5" />
            Advanced: Manual ID or Custom Profile Connect
          </span>
          {showAdvancedInputs ? (
            <ChevronUp aria-hidden="true" className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown aria-hidden="true" className="w-3.5 h-3.5" />
          )}
        </button>

        {showAdvancedInputs && (
          <div className="p-4 border-t border-steam-border/40 space-y-3 bg-[#111720]">
            {selectedTab === 'steam' && (
              <div className="space-y-3">
                <div>
                  <label
                    htmlFor={steamIdFieldId}
                    className="block text-[11px] font-semibold text-white mb-1"
                  >
                    Steam ID or Profile URL
                  </label>
                  <input
                    id={steamIdFieldId}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={steamInput}
                    onChange={(e) => onChangeSteamInput(e.target.value)}
                    placeholder="76561198000000000"
                    className="w-full px-3 py-1.5 bg-[#0d1218] border border-steam-border rounded text-xs text-white font-mono"
                  />
                </div>
                <div>
                  <label
                    htmlFor={steamKeyFieldId}
                    className="block text-[11px] font-semibold text-white mb-1"
                  >
                    Web API Key (Optional)
                  </label>
                  <input
                    id={steamKeyFieldId}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={steamApiKey}
                    onChange={(e) => onChangeSteamApiKey(e.target.value)}
                    placeholder="Optional Steam Web API Key"
                    className="w-full px-3 py-1.5 bg-[#0d1218] border border-steam-border rounded text-xs text-white font-mono"
                  />
                </div>
              </div>
            )}

            {selectedTab === 'gog' && (
              <div className="space-y-3">
                <div>
                  <label
                    htmlFor={gogUserFieldId}
                    className="block text-[11px] font-semibold text-white mb-1"
                  >
                    GOG Username
                  </label>
                  <input
                    id={gogUserFieldId}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={gogInput}
                    onChange={(e) => onChangeGogInput(e.target.value)}
                    placeholder="GOG Username"
                    className="w-full px-3 py-1.5 bg-[#0d1218] border border-steam-border rounded text-xs text-white font-mono"
                  />
                </div>
                <div>
                  <label
                    htmlFor={gogTokenFieldId}
                    className="block text-[11px] font-semibold text-white mb-1"
                  >
                    GOG OAuth Bearer Token (Optional)
                  </label>
                  <input
                    id={gogTokenFieldId}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={gogToken}
                    onChange={(e) => onChangeGogToken(e.target.value)}
                    placeholder="Optional OAuth token"
                    className="w-full px-3 py-1.5 bg-[#0d1218] border border-steam-border rounded text-xs text-white font-mono"
                  />
                </div>
              </div>
            )}

            {selectedTab === 'epic' && (
              <div className="space-y-3">
                <div>
                  <label
                    htmlFor={epicIdFieldId}
                    className="block text-[11px] font-semibold text-white mb-1"
                  >
                    Epic Account ID or Public Profile URL
                  </label>
                  <input
                    id={epicIdFieldId}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={epicInput}
                    onChange={(e) => onChangeEpicInput(e.target.value)}
                    placeholder="e.g. a1b2c3d4e5f60718293a4b5c6d7e8f90 or https://store.epicgames.com/u/..."
                    className="w-full px-3 py-1.5 bg-[#0d1218] border border-steam-border rounded text-xs text-white font-mono"
                  />
                </div>
                <div>
                  <label
                    htmlFor={epicTokenFieldId}
                    className="block text-[11px] font-semibold text-white mb-1"
                  >
                    Epic Exchange / Auth Token (Optional)
                  </label>
                  <input
                    id={epicTokenFieldId}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={epicToken}
                    onChange={(e) => onChangeEpicToken(e.target.value)}
                    placeholder="Optional OAuth or Exchange token"
                    className="w-full px-3 py-1.5 bg-[#0d1218] border border-steam-border rounded text-xs text-white font-mono"
                  />
                </div>
              </div>
            )}

            {selectedTab === 'xbox' && (
              <div className="space-y-3">
                <div>
                  <label
                    htmlFor={xboxTagFieldId}
                    className="block text-[11px] font-semibold text-white mb-1"
                  >
                    Xbox Gamertag
                  </label>
                  <input
                    id={xboxTagFieldId}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={xboxInput}
                    onChange={(e) => onChangeXboxInput(e.target.value)}
                    placeholder="Xbox Gamertag"
                    className="w-full px-3 py-1.5 bg-[#0d1218] border border-steam-border rounded text-xs text-white font-mono"
                  />
                </div>
              </div>
            )}

            <div className="pt-2 flex justify-end">
              <button
                type="button"
                onClick={() => onCompleteManualAuth(selectedTab)}
                disabled={isSubmitting}
                className="px-4 py-1.5 rounded bg-white/10 hover:bg-white/15 text-white text-xs font-semibold transition-colors cursor-pointer"
              >
                {isSubmitting ? 'Connecting...' : 'Connect with Manual Credentials'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
