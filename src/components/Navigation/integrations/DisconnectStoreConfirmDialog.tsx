import React from 'react';
import { AlertCircle, CheckCircle2, Unlink } from 'lucide-react';
import type { StorefrontId } from '../../../contracts/platform';
import { ModalShell } from '../../Common/ModalShell';
import { STORE_AUTH_CONFIGS } from '../../../hooks/useStorefrontAuthFlow';

export interface DisconnectStoreConfirmDialogProps {
  storefrontId: StorefrontId | null;
  gamesCount: number;
  onCancel: () => void;
  onConfirmDisconnect: (storefrontId: StorefrontId) => void;
}

export const DisconnectStoreConfirmDialog: React.FC<DisconnectStoreConfirmDialogProps> = ({
  storefrontId,
  gamesCount,
  onCancel,
  onConfirmDisconnect,
}) => {
  if (!storefrontId) return null;
  const storeName = STORE_AUTH_CONFIGS[storefrontId]?.storeName || storefrontId.toUpperCase();

  return (
    <ModalShell
      isOpen={Boolean(storefrontId)}
      onClose={onCancel}
      ariaLabelledBy="disconnect-store-confirm-title"
      className="w-full max-w-md"
    >
      <div className="bg-[#1b2838] border border-red-500/60 rounded-lg shadow-2xl max-w-md w-full overflow-hidden text-steam-text p-6 space-y-4">
        <div className="flex items-start gap-3.5">
          <div className="p-2.5 rounded-full bg-red-950/80 border border-red-500/60 text-red-400 shrink-0">
            <AlertCircle aria-hidden="true" className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h2 id="disconnect-store-confirm-title" className="text-base font-bold text-white">
              Disconnect {storeName}?
            </h2>
            <p className="text-xs text-steam-subtext leading-relaxed">
              Please confirm before removing these titles from your One Launcher library.
            </p>
          </div>
        </div>

        <div className="p-3.5 bg-[#121922] border border-steam-border/60 rounded text-xs space-y-2 text-steam-subtext leading-relaxed">
          <p className="text-white font-medium">What this means:</p>
          <ul className="list-disc list-inside space-y-1.5 text-slate-300 text-[11px]">
            <li>
              All titles ({gamesCount} games) from <strong className="text-white">{storeName}</strong>{' '}
              will be removed from your local catalog.
            </li>
            <li>
              Any locally stored authentication tokens or credentials for this store will be
              cleared.
            </li>
          </ul>
          <div className="pt-2 border-t border-steam-border/40 text-[11px] text-emerald-400 font-semibold flex items-center gap-1.5">
            <CheckCircle2 aria-hidden="true" className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>Your purchases on {storeName} are 100% safe and unaffected.</span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2.5 pt-2">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="px-4 py-2 rounded bg-white/5 hover:bg-white/10 text-steam-text hover:text-white text-xs font-semibold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-accent"
          >
            Cancel (Keep Games)
          </button>
          <button
            type="button"
            onClick={() => onConfirmDisconnect(storefrontId)}
            className="px-4 py-2 rounded bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition-all shadow-md flex items-center gap-1.5 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
          >
            <Unlink aria-hidden="true" className="w-3.5 h-3.5" />
            Yes, Disconnect &amp; Remove Games
          </button>
        </div>
      </div>
    </ModalShell>
  );
};
