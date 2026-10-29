import { useState, useCallback, useEffect, useRef, Dispatch, SetStateAction } from 'react';
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
  sanitizeGameCatalog,
  SuppressedCatalogEntry,
} from '../services/integrations/catalogSanitizer';
import {
  applyOverrideToCatalog,
  revertRemovedOverrideInCatalog,
  hideStorefrontEntryFromCatalog,
} from '../utils/catalogMergeUtils';
import { SyncNoticeTone } from './useSyncNotice';

const NON_GAME_CONFIRMATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'confirmed-non-game',
  'confirmed-non-game-batch',
  'batch-confirmed-non-game',
  'unconfirmed-non-game',
]);

export function isNonGameConfirmationOverrideEvent(detail: unknown): boolean {
  if (!detail || typeof detail !== 'object') return false;
  const typed = detail as { type?: unknown; override?: unknown };
  if ('override' in typed && typed.override && typeof typed.override === 'object') {
    return false;
  }
  return typeof typed.type === 'string' && NON_GAME_CONFIRMATION_EVENT_TYPES.has(typed.type);
}

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
  const internalMutationDepthRef = useRef<number>(0);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

    const handleUserOverrideUpdated = (e: Event) => {
      if (internalMutationDepthRef.current > 0) return;
      const detail = (e as CustomEvent<{
        type?: string;
        override?: UserGameOverride;
        hiddenGameId?: string;
        unhiddenKey?: string;
        isHidden?: boolean;
      }>).detail;
      if (!detail) return;
      // Confirming/unconfirming already-suppressed non-game storefront entries only updates
      // their Studio confirmation badge — never rebuild or mutate active `games`!
      if (isNonGameConfirmationOverrideEvent(detail)) {
        return;
      }
      if ('hiddenGameId' in detail || 'unhiddenKey' in detail || 'isHidden' in detail) {
        return;
      }
      if (detail.override && typeof detail.override === 'object' && detail.override.gameId) {
        const appliedOverride = detail.override;
        setGames((prevGames) =>
          applyOverrideToCatalog(
            prevGames,
            appliedOverride,
            null,
            Boolean(appliedOverride.splitFromMerged)
          )
        );
      }
    };

    const handleUserOverrideRemoved = (e: Event) => {
      if (internalMutationDepthRef.current > 0) return;
      const customEvent = e as CustomEvent<{ gameId?: string; oldOverride?: UserGameOverride }>;
      const removedGameId = customEvent.detail?.gameId;
      const oldOverride = customEvent.detail?.oldOverride;
      if (!removedGameId) return;

      setGames((prevGames) =>
        revertRemovedOverrideInCatalog(prevGames, removedGameId, oldOverride)
      );
      setGameRefreshKey((prev) => prev + 1);
    };

    window.addEventListener('antigravity:user-override-updated', handleUserOverrideUpdated);
    window.addEventListener('antigravity:user-override-removed', handleUserOverrideRemoved);
    return () => {
      window.removeEventListener('antigravity:user-override-updated', handleUserOverrideUpdated);
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
      internalMutationDepthRef.current += 1;
      try {
        saveUserOverride(override);
      } finally {
        internalMutationDepthRef.current = Math.max(0, internalMutationDepthRef.current - 1);
      }

      const isSplitting = Boolean(
        override.splitFromMerged ||
          (fixMatchGame as (CanonicalGame & { isSplittingFromMerged?: boolean }) | null)
            ?.isSplittingFromMerged
      );

      setGames((prevGames) =>
        applyOverrideToCatalog(prevGames, override, fixMatchGame, isSplitting)
      );

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
      internalMutationDepthRef.current += 1;
      try {
        removeUserOverride(gameId);
      } finally {
        internalMutationDepthRef.current = Math.max(0, internalMutationDepthRef.current - 1);
      }
      setGames((prevGames) => sanitizeGameCatalog(prevGames, { allowNewPurchases: true }));

      setGameRefreshKey((prev) => prev + 1);
      showSyncNotice('Reverted game match & metadata to default store settings.', 5000);
    },
    [setGames, setGameRefreshKey, showSyncNotice]
  );

  const handleHideGame = useCallback(
    (gameToHide: CanonicalGame, targetPlatformId?: StorefrontId) => {
      internalMutationDepthRef.current += 1;
      try {
        hideStorefrontEntry(gameToHide, targetPlatformId);
      } finally {
        internalMutationDepthRef.current = Math.max(0, internalMutationDepthRef.current - 1);
      }

      setGames((prevGames) =>
        hideStorefrontEntryFromCatalog(prevGames, gameToHide, targetPlatformId)
      );

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
      let restoredSnapshot: CanonicalGame | undefined;
      internalMutationDepthRef.current += 1;
      try {
        restoredSnapshot = unhideStorefrontEntry(
          entry.id,
          entry.platformId,
          entry.platformGameId
        );
      } finally {
        internalMutationDepthRef.current = Math.max(0, internalMutationDepthRef.current - 1);
      }
      const candidateGame: CanonicalGame = {
        ...(restoredSnapshot || entry.rawGame),
        isVerifiedEntitlement: true,
      };

      setGames((prevGames) =>
        sanitizeGameCatalog([...prevGames, candidateGame], {
          allowNewPurchases: true,
        })
      );

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
