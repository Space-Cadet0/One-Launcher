import React from 'react';
import { HardDrive, Trash2 } from 'lucide-react';
import {
  OFFLINE_VAULT_TIER_CAPS,
  type OfflineVaultStats,
  type OfflineVaultTier,
} from '../../../contracts/network';

export interface OfflineVaultSectionProps {
  vaultStats: OfflineVaultStats | null;
  isUpdatingVault: boolean;
  onSelectTier: (tier: OfflineVaultTier) => void;
  onClearMediaCache: () => void;
}

const VAULT_TIER_OPTIONS: ReadonlyArray<{
  id: OfflineVaultTier;
  label: string;
  capLabel: string;
}> = [
  { id: 'compact', label: 'Compact', capLabel: '250 MB' },
  { id: 'balanced', label: 'Balanced', capLabel: '1 GB' },
  { id: 'full_archive', label: 'Full Archive', capLabel: '2 GB' },
];

function formatVaultBytes(bytes?: number): string {
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
}

export const OfflineVaultSection: React.FC<OfflineVaultSectionProps> = ({
  vaultStats,
  isUpdatingVault,
  onSelectTier,
  onClearMediaCache,
}) => {
  const activeTier: OfflineVaultTier = vaultStats?.tier || 'balanced';
  const usedBytes =
    vaultStats?.totalBytes ?? (vaultStats?.sqliteBytes || 0) + (vaultStats?.blobBytes || 0);
  const maxBytes = vaultStats?.maxBytes || OFFLINE_VAULT_TIER_CAPS[activeTier];
  const usagePct = maxBytes > 0 ? Math.min(100, Math.round((usedBytes / maxBytes) * 100)) : 0;

  return (
    <div
      data-testid="offline-library-vault-section"
      className="bg-[#141d28] border border-steam-border/80 rounded-lg p-4 space-y-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded bg-steam-accent/15 border border-steam-accent/30 text-steam-accent">
            <HardDrive aria-hidden="true" className="w-4 h-4" />
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
          onClick={onClearMediaCache}
          className="px-2.5 py-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 text-steam-subtext hover:text-white text-[11px] font-semibold transition-colors inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
        >
          <Trash2 aria-hidden="true" className="w-3.5 h-3.5" />
          <span>Clear Offline Media Cache</span>
        </button>
      </div>

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
        <div
          aria-hidden="true"
          className="h-1.5 w-full rounded-full bg-black/50 overflow-hidden border border-white/5"
        >
          <div
            className="h-full bg-steam-accent transition-all duration-300"
            style={{ width: `${usagePct}%` }}
          />
        </div>
      </div>

      <div data-testid="offline-vault-tier-selector" className="grid grid-cols-3 gap-2 pt-0.5">
        {VAULT_TIER_OPTIONS.map((opt) => {
          const isSelected = activeTier === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              aria-pressed={isSelected}
              disabled={isUpdatingVault}
              onClick={() => onSelectTier(opt.id)}
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
    </div>
  );
};
