import { useState, useCallback, useEffect, Dispatch, SetStateAction } from 'react';
import { CanonicalGame } from '../contracts/game';
import { UserGameOverride } from '../contracts/override';
import { StorefrontId } from '../contracts/platform';
import {
  saveUserOverride,
  removeUserOverride,
  hideStorefrontEntry,
  unhideStorefrontEntry,
} from '../services/storage/userOverrideStorage';
import {
  saveCurrentCatalog,
  flushPendingCatalogSave,
} from '../services/integrations/integrationStorage';
import {
  sanitizeGameCatalog,
  SuppressedCatalogEntry,
} from '../services/integrations/catalogSanitizer';
import {
  applyOverrideToCatalog,
  revertRemovedOverrideInCatalog,
  hideStorefrontEntryFromCatalog,
} from '../utils/catalogMergeUtils';
import { SyncNoticeTone } from './useSyncNotice';

export interface UseCatalogOverrideSyncParams {
  selectedGame: CanonicalGame | null;
  isGridView: boolean;
  navigateHome: () => void;
  setGames: Dispatch<SetStateAction<CanonicalGame[]>>;
  setGameRefreshKey: Dispatch<SetStateAction<number>>;
  showSyncNotice: (
    message: string | null,
    durationMs?: number | null,
    tone?: SyncNoticeTone
  ) => void;
}

export interface UseCatalogOverrideSyncResult {
  isFixMatchModalOpen: boolean;
  setIsFixMatchModalOpen: Dispatch<SetStateAction<boolean>>;
  fixMatchGame: CanonicalGame | null;
  setFixMatchGame: Dispatch<SetStateAction<CanonicalGame | null>>;
  isMatchManagerOpen: boolean;
  setIsMatchManagerOpen: Dispatch<SetStateAction<boolean>>;
  handleOpenFixMatch: (gameToFix?: CanonicalGame) => void;
  handleApplyOverride: (override: UserGameOverride) => void;
  handleResetOverride: (gameId: string) => void;
  handleHideGame: (gameToHide: CanonicalGame, targetPlatformId?: StorefrontId) => void;
  handleUnhideEntry: (entry: SuppressedCatalogEntry) => void;
}

/**
 * Manages Fix Match Wizard / Library Match Studio state, override application/revert/split,
 * and hidden/suppressed storefront entry restoration.
 */
export function useCatalogOverrideSync({
  selectedGame,
  isGridView,
  navigateHome,
  setGames,
  setGameRefreshKey,
  showSyncNotice,
}: UseCatalogOverrideSyncParams): UseCatalogOverrideSyncResult {
  const [isFixMatchModalOpen, setIsFixMatchModalOpen] = useState(false);
  const [fixMatchGame, setFixMatchGame] = useState<CanonicalGame | null>(null);
  const [isMatchManagerOpen, setIsMatchManagerOpen] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

    const handleUserOverrideRemoved = (e: Event) => {
      const customEvent = e as CustomEvent<{ gameId?: string; oldOverride?: UserGameOverride }>;
      const removedGameId = customEvent.detail?.gameId;
      const oldOverride = customEvent.detail?.oldOverride;
      if (!removedGameId) return;

      setGames((prevGames) => {
        const sanitized = revertRemovedOverrideInCatalog(prevGames, removedGameId, oldOverride);
        try {
          saveCurrentCatalog(sanitized, { skipSanitize: true });
          flushPendingCatalogSave();
        } catch {}
        return sanitized;
      });
      setGameRefreshKey((prev) => prev + 1);
    };

    window.addEventListener('antigravity:user-override-removed', handleUserOverrideRemoved);
    return () => {
      window.removeEventListener('antigravity:user-override-removed', handleUserOverrideRemoved);
    };
  }, [setGames, setGameRefreshKey]);

  const handleOpenFixMatch = useCallback(
    (gameToFix?: CanonicalGame) => {
      const targetGame = gameToFix || selectedGame;
      if (targetGame) {
        setFixMatchGame(targetGame);
        setIsFixMatchModalOpen(true);
      }
    },
    [selectedGame]
  );

  const handleApplyOverride = useCallback(
    (override: UserGameOverride) => {
      saveUserOverride(override);

      const isSplitting = Boolean(
        override.splitFromMerged || (fixMatchGame as any)?.isSplittingFromMerged
      );

      setGames((prevGames) => {
        const sanitized = applyOverrideToCatalog(prevGames, override, fixMatchGame, isSplitting);
        try {
          saveCurrentCatalog(sanitized, { skipSanitize: true });
          flushPendingCatalogSave();
        } catch (err) {
          console.error('Failed to save updated catalog after override:', err);
        }
        return sanitized;
      });

      setGameRefreshKey((prev) => prev + 1);
      showSyncNotice(
        isSplitting
          ? `Split & matched "${override.title || 'game'}" as an independent library entry!`
          : `Applied metadata & cover match for "${override.title || 'game'}"!`,
        5000
      );
    },
    [fixMatchGame, setGames, setGameRefreshKey, showSyncNotice]
  );

  const handleResetOverride = useCallback(
    (gameId: string) => {
      removeUserOverride(gameId);
      setGames((prevGames) => {
        const sanitized = sanitizeGameCatalog(prevGames, { allowNewPurchases: true });
        try {
          saveCurrentCatalog(sanitized, { skipSanitize: true });
          flushPendingCatalogSave();
        } catch {}
        return sanitized;
      });

      setGameRefreshKey((prev) => prev + 1);
      showSyncNotice('Reverted game match & metadata to default store settings.', 5000);
    },
    [setGames, setGameRefreshKey, showSyncNotice]
  );

  const handleHideGame = useCallback(
    (gameToHide: CanonicalGame, targetPlatformId?: StorefrontId) => {
      hideStorefrontEntry(gameToHide, targetPlatformId);

      setGames((prevGames) => {
        const sanitized = hideStorefrontEntryFromCatalog(prevGames, gameToHide, targetPlatformId);
        try {
          saveCurrentCatalog(sanitized, { skipSanitize: true });
          flushPendingCatalogSave();
        } catch {}
        return sanitized;
      });

      if (
        !isGridView &&
        selectedGame?.id === gameToHide.id &&
        (!targetPlatformId || gameToHide.platforms.length <= 1)
      ) {
        navigateHome();
      }

      setGameRefreshKey((prev) => prev + 1);
      showSyncNotice(
        `Hidden "${gameToHide.title}"${
          targetPlatformId ? ` (${targetPlatformId.toUpperCase()})` : ''
        } — restore anytime in Library Match Studio > Suppressed & Filtered.`,
        5000
      );
    },
    [isGridView, selectedGame, navigateHome, setGames, setGameRefreshKey, showSyncNotice]
  );

  const handleUnhideEntry = useCallback(
    (entry: SuppressedCatalogEntry) => {
      const restoredSnapshot = unhideStorefrontEntry(
        entry.id,
        entry.platformId,
        entry.platformGameId
      );
      const candidateGame: CanonicalGame = {
        ...(restoredSnapshot || entry.rawGame),
        isVerifiedEntitlement: true,
      };

      setGames((prevGames) => {
        const sanitized = sanitizeGameCatalog([...prevGames, candidateGame], {
          allowNewPurchases: true,
        });
        try {
          saveCurrentCatalog(sanitized, { skipSanitize: true });
          flushPendingCatalogSave();
        } catch {}
        return sanitized;
      });

      setGameRefreshKey((prev) => prev + 1);
      showSyncNotice(`Restored "${entry.rawTitle || entry.rawGame.title}" back to your library!`, 5000);
    },
    [setGames, setGameRefreshKey, showSyncNotice]
  );

  return {
    isFixMatchModalOpen,
    setIsFixMatchModalOpen,
    fixMatchGame,
    setFixMatchGame,
    isMatchManagerOpen,
    setIsMatchManagerOpen,
    handleOpenFixMatch,
    handleApplyOverride,
    handleResetOverride,
    handleHideGame,
    handleUnhideEntry,
  };
}
