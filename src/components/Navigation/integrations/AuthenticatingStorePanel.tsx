import React from 'react';
import { AlertCircle, CheckCircle2, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import type { StorefrontId } from '../../../contracts/platform';
import { StorefrontIcon } from '../../Common/StorefrontIcon';
import {
  STORE_AUTH_CONFIGS,
  extractCodeFromInput,
} from '../../../hooks/useStorefrontAuthFlow';

export interface AuthenticatingStorePanelProps {
  selectedTab: StorefrontId;
  authRedirectFieldId: string;
  authRedirectInput: string;
  isSubmitting: boolean;
  onChangeAuthRedirectInput: (value: string) => void;
  onCompleteAuth: (storefrontId: StorefrontId, explicitCode?: string) => void;
  onRelaunchSignIn: (storefrontId: StorefrontId) => void;
  onCancelAuth: () => void;
}

export const AuthenticatingStorePanel: React.FC<AuthenticatingStorePanelProps> = ({
  selectedTab,
  authRedirectFieldId,
  authRedirectInput,
  isSubmitting,
  onChangeAuthRedirectInput,
  onCompleteAuth,
  onRelaunchSignIn,
  onCancelAuth,
}) => {
  const storeName = STORE_AUTH_CONFIGS[selectedTab]?.storeName;

  return (
    <div className="bg-[#16202d] border border-steam-accent/50 rounded-lg p-6 text-center space-y-5">
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
            <RefreshCw aria-hidden="true" className="w-4 h-4 text-steam-accent animate-spin" />
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-base font-bold text-white">
          Official {storeName} Sign-In Window Open
        </h3>
        <p className="text-xs text-steam-subtext max-w-md mx-auto mt-1 leading-relaxed">
          {selectedTab === 'gog' ? (
            <>
              Please log in on the official GOG sign-in window. Once you authenticate (via Google or
              GOG account), GOG redirects to the confirmation page (
              <code className="text-emerald-300 bg-black/40 px-1 py-0.5 rounded text-[11px]">
                embed.gog.com/on_login_success
              </code>
              ).
            </>
          ) : selectedTab === 'epic' ? (
            <>
              Log in with your Epic Games account. Once authenticated, Epic redirects to confirm the
              launcher token.
            </>
          ) : selectedTab === 'xbox' ? (
            <>
              Sign in with your Microsoft / Xbox Live account. In the desktop app, the redirect
              token is captured automatically to sync your Microsoft Store purchases, Game Pass
              status, and Gamerscore.
            </>
          ) : (
            `Please log in on the official ${storeName} sign-in page in the pop-up window. Once complete, this app will automatically connect and synchronize your owned titles.`
          )}
        </p>
      </div>

      {/* Special callout banner for GOG blank page */}
      {selectedTab === 'gog' && (
        <div className="p-3 bg-amber-950/40 border border-amber-500/50 rounded text-amber-200 text-xs text-left max-w-lg mx-auto flex items-start gap-2.5 shadow-inner">
          <AlertCircle aria-hidden="true" className="w-5 h-5 flex-shrink-0 text-amber-400 mt-0.5" />
          <div className="space-y-1">
            <span className="font-bold text-amber-300">Why GOG displays a blank white screen:</span>
            <p className="text-[11px] leading-relaxed text-amber-200/90">
              GOG&apos;s official OAuth server directs the browser to{' '}
              <code className="bg-black/50 px-1 py-0.5 rounded font-mono text-emerald-300">
                embed.gog.com/on_login_success
              </code>
              . Because this endpoint was built for the native GOG Galaxy desktop client, GOG
              intentionally serves a <strong>blank white page</strong> without auto-closing the
              browser window.
            </p>
            <p className="text-[11px] font-semibold text-emerald-300">
              ✓ Seeing that blank white page confirms your sign-in was 100% successful! Click the
              button below to close the pop-up and sync your library.
            </p>
          </div>
        </div>
      )}

      {/* Special callout banner for Epic Games Store */}
      {selectedTab === 'epic' && (
        <div className="p-3.5 bg-blue-950/40 border border-blue-500/50 rounded text-blue-200 text-xs text-left max-w-lg mx-auto space-y-2 shadow-inner">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 aria-hidden="true" className="w-5 h-5 flex-shrink-0 text-sky-400 mt-0.5" />
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
                    or the page will display JSON with your{' '}
                    <code className="text-emerald-300">&quot;authorizationCode&quot;</code>.
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
            <CheckCircle2
              aria-hidden="true"
              className="w-5 h-5 flex-shrink-0 text-emerald-400 mt-0.5"
            />
            <div className="space-y-1.5">
              <span className="font-bold text-emerald-300">Microsoft / Xbox Live OAuth Sign-In:</span>
              <p className="text-[11px] text-emerald-100/90 leading-relaxed">
                Complete sign-in (including passkeys or 2FA) in the Microsoft window. If signing in
                via an external browser window, copy the final blank redirect URL (
                <code className="bg-black/60 px-1 py-0.5 rounded font-mono text-emerald-300">
                  https://login.live.com/oauth20_desktop.srf?code=M...
                </code>
                ) and paste it below.
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
            onChangeAuthRedirectInput(val);
            const code = extractCodeFromInput(val);
            if (code) {
              onCompleteAuth(selectedTab, code);
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
          className="w-full px-2.5 py-1.5 bg-[#0d1218] border border-steam-border rounded text-xs text-white font-mono placeholder:text-slate-400 focus:outline-none focus:border-steam-accent focus-visible:ring-2 focus-visible:ring-steam-accent"
        />
        <p className="text-[10px] text-steam-subtext">
          Auto-detects and extracts authorization codes from full URLs or JSON strings instantly.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
        <button
          type="button"
          onClick={() =>
            onCompleteAuth(selectedTab, extractCodeFromInput(authRedirectInput) || undefined)
          }
          disabled={isSubmitting}
          className="px-5 py-2.5 rounded bg-steam-accent hover:bg-steam-accentHover text-white text-xs font-bold transition-all shadow-md flex items-center gap-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          {isSubmitting ? (
            <RefreshCw aria-hidden="true" className="w-4 h-4 animate-spin" />
          ) : (
            <ShieldCheck aria-hidden="true" className="w-4 h-4" />
          )}
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
          onClick={() => onRelaunchSignIn(selectedTab)}
          className="px-4 py-2.5 rounded bg-white/5 hover:bg-white/10 text-steam-text hover:text-white text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent"
        >
          <ExternalLink aria-hidden="true" className="w-3.5 h-3.5" />
          Re-open Sign-In Window
        </button>

        <button
          type="button"
          onClick={onCancelAuth}
          className="px-3 py-2.5 text-xs text-steam-subtext hover:text-white transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent rounded"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};
