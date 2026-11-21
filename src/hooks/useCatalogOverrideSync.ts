import {
  useState,
  useCallback,
  useEffect,
  useRef,
  Dispatch,
  SetStateAction,
  MutableRefObject,
} from 'react';
import { CanonicalGame } from '../contracts/game';
import { UserGameOverride } from '../contracts/override';
import { StorefrontId } from '../contracts/platform';
import {
  saveUserOverride,
  removeUserOverride,
  getUserOverrideForGame,
  hideStorefrontEntry,
  unhideStorefrontEntry,
} from '../services/storage/userOverrideStorage';
import {
  ensureSuppressedEntryRawGame,
  sanitizeGameCatalog,
  SuppressedCatalogEntry,
} from '../services/integrations/catalogSanitizer';
import { saveCurrentCatalog } from '../services/integrations/integrationStorage';
import {
  applyOverrideToCatalog,
  captureNativeGameBaseline,
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

export interface ResetOverrideContext {
  game?: CanonicalGame | null;
  override?: UserGameOverride | null;
}

interface ExtendedOfflineVaultDeleteBridge {
  deleteGames?: (gameIds: string[]) => Promise<{ success?: boolean; deleted?: number } | void>;
}

export interface UseCatalogOverrideSyncParams {
  selectedGame: CanonicalGame | null;
  isGridView: boolean;
  navigateHome: () => void;
  setGames: Dispatch<SetStateAction<CanonicalGame[]>>;
  gamesRef?: MutableRefObject<CanonicalGame[]>;
  setGameRefreshKey: Dispatch<SetStateAction<number>>;
  onCatalogPersisted?: (catalog: CanonicalGame[]) => void;
  showSyncNotice: (
    message: string | null,
    durationMs?: number | null,
    tone?: SyncNoticeTone
  ) => void;
}

interface LocalRehydrationPatch {
  capsuleImage?: string;
  headerImage?: string;
  iconUrl?: string;
  shortDescription?: string;
  detailedDescription?: string;
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  tags?: string[];
  releaseDate?: string;
}

function applyLocalRehydrationToCatalog(
  catalog: CanonicalGame[],
  revertedId: string,
  patch: LocalRehydrationPatch
): { updated: CanonicalGame[]; changed: boolean } {
  let changed = false;
  const updated = catalog.map((g) => {
    if (g.id !== revertedId) return g;
    // Never overwrite if user just created a brand-new override in the meantime
    if (getUserOverrideForGame(g)) return g;
    changed = true;
    return {
      ...g,
      capsuleImage: g.capsuleImage || patch.capsuleImage,
      headerImage: g.headerImage || patch.headerImage || '',
      iconUrl: g.iconUrl || patch.iconUrl,
      shortDescription: g.shortDescription || patch.shortDescription || '',
      detailedDescription: g.detailedDescription || patch.detailedDescription,
      developers: g.developers?.length ? g.developers : (patch.developers ?? []),
      publishers: g.publishers?.length ? g.publishers : (patch.publishers ?? []),
      genres: g.genres?.length ? g.genres : (patch.genres ?? []),
      tags: g.tags?.length ? g.tags : (patch.tags ?? []),
      releaseDate: g.releaseDate || patch.releaseDate,
    };
  });
  return { updated: changed ? updated : catalog, changed };
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
  handleResetOverride: (gameId: string, context?: ResetOverrideContext) => void;
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
  gamesRef,
  setGameRefreshKey,
  onCatalogPersisted,
  showSyncNotice,
}: UseCatalogOverrideSyncParams): UseCatalogOverrideSyncResult {
  const [isFixMatchModalOpen, setIsFixMatchModalOpen] = useState(false);
  const [fixMatchGame, setFixMatchGame] = useState<CanonicalGame | null>(null);
  const [isMatchManagerOpen, setIsMatchManagerOpen] = useState(false);
  const internalMutationDepthRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

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
        setGames((prevGames) => {
          const next = applyOverrideToCatalog(
            prevGames,
            appliedOverride,
            null,
            Boolean(appliedOverride.splitFromMerged)
          );
          if (gamesRef) {
            gamesRef.current = next;
          }
          return next;
        });
      }
    };

    const handleUserOverrideRemoved = (e: Event) => {
      if (internalMutationDepthRef.current > 0) return;
      const customEvent = e as CustomEvent<{
        gameId?: string;
        removedOverride?: UserGameOverride;
        oldOverride?: UserGameOverride;
        oldGame?: Partial<CanonicalGame>;
      }>;
      const removedGameId = customEvent.detail?.gameId;
      const oldOverride = customEvent.detail?.removedOverride ?? customEvent.detail?.oldOverride;
      const oldGame = customEvent.detail?.oldGame;
      if (!removedGameId) return;

      setGames((prevGames) => {
        const next = revertRemovedOverrideInCatalog(
          prevGames,
          removedGameId,
          oldOverride,
          oldGame
        );
        if (gamesRef) {
          gamesRef.current = next;
        }
        return next;
      });
      setGameRefreshKey((prev) => prev + 1);
    };

    window.addEventListener('antigravity:user-override-updated', handleUserOverrideUpdated);
    window.addEventListener('antigravity:user-override-removed', handleUserOverrideRemoved);
    return () => {
      window.removeEventListener('antigravity:user-override-updated', handleUserOverrideUpdated);
      window.removeEventListener('antigravity:user-override-removed', handleUserOverrideRemoved);
    };
  }, [gamesRef, setGames, setGameRefreshKey]);

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
      const liveCatalog = gamesRef?.current || [];
      const matchedCatalogGame =
        liveCatalog.find(
          (g) =>
            g.id === override.gameId ||
            Boolean(
              override.platformGameId &&
                g.platforms?.some(
                  (p) =>
                    String(p.platformGameId).toLowerCase() ===
                      String(override.platformGameId).toLowerCase() &&
                    (!override.platformId ||
                      String(p.platformId).toLowerCase() ===
                        String(override.platformId).toLowerCase())
                )
            )
        ) || fixMatchGame;

      const existingOv = matchedCatalogGame
        ? getUserOverrideForGame(matchedCatalogGame)
        : undefined;

      const overrideToSave: UserGameOverride = override.nativeBaseline
        ? override
        : {
            ...override,
            ...(existingOv?.nativeBaseline
              ? { nativeBaseline: existingOv.nativeBaseline }
              : matchedCatalogGame
                ? { nativeBaseline: captureNativeGameBaseline(matchedCatalogGame) }
                : {}),
          };

      internalMutationDepthRef.current += 1;
      try {
        saveUserOverride(overrideToSave, matchedCatalogGame ?? undefined);
      } finally {
        internalMutationDepthRef.current = Math.max(0, internalMutationDepthRef.current - 1);
      }

      const isSplitting = Boolean(
        overrideToSave.splitFromMerged ||
          (fixMatchGame as (CanonicalGame & { isSplittingFromMerged?: boolean }) | null)
            ?.isSplittingFromMerged
      );

      // Compute next catalog deterministically outside setGames so React 19 automatic
      // batching never defers/skips catalog persistence.
      if (gamesRef) {
        const baseCatalog = gamesRef.current;
        const nextCatalog = applyOverrideToCatalog(
          baseCatalog,
          overrideToSave,
          fixMatchGame,
          isSplitting
        );
        gamesRef.current = nextCatalog;
        setGames((prevGames) => {
          const next =
            prevGames === baseCatalog
              ? nextCatalog
              : applyOverrideToCatalog(prevGames, overrideToSave, fixMatchGame, isSplitting);
          gamesRef.current = next;
          return next;
        });

        const dirtyIds = new Set<string>([overrideToSave.gameId]);
        if (matchedCatalogGame?.id) dirtyIds.add(matchedCatalogGame.id);
        saveCurrentCatalog(nextCatalog, {
          dirtyGameIds: dirtyIds,
          skipSanitize: true,
        });
        onCatalogPersisted?.(nextCatalog);
      } else {
        setGames((prevGames) =>
          applyOverrideToCatalog(prevGames, overrideToSave, fixMatchGame, isSplitting)
        );
      }

      setGameRefreshKey((prev) => prev + 1);
      showSyncNotice(
        isSplitting
          ? `Split & matched "${overrideToSave.title || 'game'}" as an independent library entry!`
          : `Applied metadata & cover match for "${overrideToSave.title || 'game'}"!`,
        5000
      );
    },
    [fixMatchGame, gamesRef, onCatalogPersisted, setGames, setGameRefreshKey, showSyncNotice]
  );

  const handleResetOverride = useCallback(
    (gameId: string, context?: ResetOverrideContext) => {
      const liveCatalog = gamesRef?.current || [];
      const targetGame: CanonicalGame | null =
        liveCatalog.find(
          (g) =>
            g.id === gameId ||
            (Boolean(context?.game?.id) && g.id === context!.game!.id) ||
            (Boolean(context?.override?.gameId) && g.id === context!.override!.gameId) ||
            Boolean(
              context?.override?.platformGameId &&
                g.platforms?.some(
                  (p) =>
                    String(p.platformGameId).toLowerCase() ===
                      String(context.override!.platformGameId).toLowerCase() &&
                    (!context.override!.platformId ||
                      String(p.platformId).toLowerCase() ===
                        String(context.override!.platformId).toLowerCase())
                )
            )
        ) ||
        context?.game ||
        (selectedGame?.id === gameId ? selectedGame : null);

      const existingOv: UserGameOverride | undefined =
        (targetGame ? getUserOverrideForGame(targetGame) : undefined) ??
        (context?.override ?? undefined);

      // Compute potential orphan SQLite vault IDs (e.g. 'steam-<appId>' when reverting a GOG entitlement back to 'gog-...')
      const preCandidateOrphanIds = new Set<string>();
      const targetHasGenuineSteam = Boolean(
        targetGame?.platforms?.some(
          (p) => p?.platformId === 'steam' && p.platformGameId && !isNaN(Number(p.platformGameId))
        )
      );
      if (!targetHasGenuineSteam) {
        for (const oldCandidateId of [
          gameId,
          targetGame?.id,
          existingOv?.gameId,
          typeof existingOv?.steamAppId === 'number' && existingOv.steamAppId > 0
            ? `steam-${existingOv.steamAppId}`
            : undefined,
        ]) {
          if (!oldCandidateId || !oldCandidateId.startsWith('steam-')) continue;
          const ownedByAnotherEntry = liveCatalog.some(
            (other) => other !== targetGame && other.id === oldCandidateId
          );
          if (!ownedByAnotherEntry) {
            preCandidateOrphanIds.add(oldCandidateId);
          }
        }
      }

      let removedOverride: UserGameOverride | undefined;
      internalMutationDepthRef.current += 1;
      try {
        removedOverride = removeUserOverride(gameId, {
          game: targetGame,
          override: existingOv,
          orphanVaultGameIds:
            preCandidateOrphanIds.size > 0 ? Array.from(preCandidateOrphanIds) : undefined,
        });
      } finally {
        internalMutationDepthRef.current = Math.max(0, internalMutationDepthRef.current - 1);
      }

      const effectiveRemovedOv = removedOverride ?? existingOv;
      // Compute next catalog deterministically outside setGames so React 19 automatic
      // batching never leaves the persistence snapshot null.
      const baseCatalog = gamesRef?.current;
      const finalCatalog: CanonicalGame[] =
        baseCatalog && baseCatalog.length > 0
          ? revertRemovedOverrideInCatalog(baseCatalog, gameId, effectiveRemovedOv, targetGame)
          : [];

      if (gamesRef && baseCatalog) {
        gamesRef.current = finalCatalog;
      }

      setGames((prevGames) => {
        const next =
          baseCatalog && prevGames === baseCatalog
            ? finalCatalog
            : revertRemovedOverrideInCatalog(prevGames, gameId, effectiveRemovedOv, targetGame);
        if (gamesRef) {
          gamesRef.current = next;
        }
        return next;
      });

      // Find the reverted game entry in finalCatalog for immediate persistence & local metadata re-hydration
      const revertedEntry = finalCatalog.find((g) => {
        if (effectiveRemovedOv?.nativeBaseline?.id && g.id === effectiveRemovedOv.nativeBaseline.id) {
          return true;
        }
        if (targetGame?.platforms && targetGame.platforms.length > 0) {
          return g.platforms?.some((p) =>
            targetGame.platforms.some(
              (tp) =>
                tp?.platformId &&
                tp?.platformGameId &&
                String(p.platformId).toLowerCase() === String(tp.platformId).toLowerCase() &&
                String(p.platformGameId).toLowerCase() === String(tp.platformGameId).toLowerCase()
            )
          );
        }
        return g.id === gameId;
      });

      // Purge any confirmed orphan vault game rows that no longer exist in finalCatalog
      const confirmedOrphanIds = Array.from(preCandidateOrphanIds).filter(
        (orphanId) => !finalCatalog.some((g) => g.id === orphanId)
      );
      if (
        confirmedOrphanIds.length > 0 &&
        typeof window !== 'undefined' &&
        window.electronAPI?.offlineVault
      ) {
        const extVault = window.electronAPI.offlineVault as typeof window.electronAPI.offlineVault &
          ExtendedOfflineVaultDeleteBridge;
        if (typeof extVault.deleteGames === 'function') {
          try {
            void extVault.deleteGames(confirmedOrphanIds)?.catch?.(() => {});
          } catch {}
        }
      }

      if (finalCatalog.length > 0) {
        const dirtyIds = new Set<string>();
        if (revertedEntry?.id) dirtyIds.add(revertedEntry.id);
        for (const g of finalCatalog) {
          if (g.id === gameId) dirtyIds.add(g.id);
        }
        saveCurrentCatalog(finalCatalog, {
          dirtyGameIds: dirtyIds,
          removedGameIds: confirmedOrphanIds.length > 0 ? confirmedOrphanIds : undefined,
          skipSanitize: true,
          immediate: true,
        });
        onCatalogPersisted?.(finalCatalog);
      }

      // Non-blocking local storefront metadata re-hydration when reverted game lacks clean default art/synopsis
      if (
        revertedEntry &&
        (!revertedEntry.capsuleImage || !revertedEntry.shortDescription) &&
        typeof window !== 'undefined' &&
        typeof window.electronAPI?.offlineVault?.resolveLocalMetadata === 'function'
      ) {
        const gogPlat = revertedEntry.platforms?.find((p) => p.platformId === 'gog');
        const epicPlat = revertedEntry.platforms?.find((p) => p.platformId === 'epic');
        const xboxPlat = revertedEntry.platforms?.find((p) => p.platformId === 'xbox');
        const revertedId = revertedEntry.id;

        void window.electronAPI.offlineVault
          .resolveLocalMetadata({
            gameId: revertedId,
            title: revertedEntry.title,
            steamAppId: revertedEntry.steamAppId ?? null,
            gogId: gogPlat?.platformGameId ? String(gogPlat.platformGameId) : null,
            epicAppName: epicPlat?.platformGameId ? String(epicPlat.platformGameId) : null,
            xboxProductId:
              xboxPlat?.xboxProductId ||
              (xboxPlat?.platformGameId ? String(xboxPlat.platformGameId) : null),
            packageFamilyName: xboxPlat?.packageFamilyName ?? null,
          })
          .then((res) => {
            if (!isMountedRef.current) return;
            if (!res?.success || !res.metadata || typeof res.metadata !== 'object') return;
            const meta = res.metadata as Record<string, unknown>;
            const nextCapsule =
              typeof meta.capsuleImage === 'string' && meta.capsuleImage.trim()
                ? meta.capsuleImage.trim()
                : typeof meta.posterUrl === 'string' && meta.posterUrl.trim()
                  ? meta.posterUrl.trim()
                  : undefined;
            const nextHeader =
              typeof meta.headerImage === 'string' && meta.headerImage.trim()
                ? meta.headerImage.trim()
                : typeof meta.heroUrl === 'string' && meta.heroUrl.trim()
                  ? meta.heroUrl.trim()
                  : undefined;
            const nextIcon =
              typeof meta.iconUrl === 'string' && meta.iconUrl.trim()
                ? meta.iconUrl.trim()
                : undefined;
            const nextShort =
              typeof meta.shortDescription === 'string' && meta.shortDescription.trim()
                ? meta.shortDescription.trim()
                : undefined;
            const nextDetailed =
              typeof meta.detailedDescription === 'string' && meta.detailedDescription.trim()
                ? meta.detailedDescription.trim()
                : typeof meta.aboutTheGame === 'string' && meta.aboutTheGame.trim()
                  ? meta.aboutTheGame.trim()
                  : undefined;
            const nextDevs = Array.isArray(meta.developers)
              ? meta.developers.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
              : undefined;
            const nextPubs = Array.isArray(meta.publishers)
              ? meta.publishers.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
              : undefined;
            const nextGenres = Array.isArray(meta.genres)
              ? meta.genres.filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
              : undefined;
            const nextTags = Array.isArray(meta.tags)
              ? meta.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
              : undefined;
            const nextRelease =
              typeof meta.releaseDate === 'string' && meta.releaseDate.trim()
                ? meta.releaseDate.trim()
                : undefined;

            if (
              !nextCapsule &&
              !nextHeader &&
              !nextShort &&
              !nextDetailed &&
              !nextDevs?.length &&
              !nextGenres?.length
            ) {
              return;
            }

            const patch: LocalRehydrationPatch = {
              capsuleImage: nextCapsule,
              headerImage: nextHeader,
              iconUrl: nextIcon,
              shortDescription: nextShort,
              detailedDescription: nextDetailed,
              developers: nextDevs,
              publishers: nextPubs,
              genres: nextGenres,
              tags: nextTags,
              releaseDate: nextRelease,
            };

            if (gamesRef) {
              const currBase = gamesRef.current;
              const { updated: hydratedCatalog, changed: didHydrateTarget } =
                applyLocalRehydrationToCatalog(currBase, revertedId, patch);
              if (!didHydrateTarget) return;

              gamesRef.current = hydratedCatalog;
              setGames((currGames) => {
                if (currGames === currBase) {
                  gamesRef.current = hydratedCatalog;
                  return hydratedCatalog;
                }
                const recomputed = applyLocalRehydrationToCatalog(currGames, revertedId, patch);
                if (!recomputed.changed) return currGames;
                gamesRef.current = recomputed.updated;
                return recomputed.updated;
              });

              saveCurrentCatalog(hydratedCatalog, {
                dirtyGameIds: [revertedId],
                skipSanitize: true,
              });
              onCatalogPersisted?.(hydratedCatalog);
              setGameRefreshKey((prev) => prev + 1);
            } else {
              setGames((currGames) => {
                const recomputed = applyLocalRehydrationToCatalog(currGames, revertedId, patch);
                return recomputed.changed ? recomputed.updated : currGames;
              });
              setGameRefreshKey((prev) => prev + 1);
            }
          })
          .catch(() => {});
      }

      setGameRefreshKey((prev) => prev + 1);
      showSyncNotice('Reverted game match & metadata to default store settings.', 5000);
    },
    [gamesRef, onCatalogPersisted, selectedGame, setGames, setGameRefreshKey, showSyncNotice]
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
      if (!entry) return;
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
      const baseStub = restoredSnapshot || ensureSuppressedEntryRawGame(entry).rawGame;
      const candidateGame: CanonicalGame = {
        ...baseStub,
        isVerifiedEntitlement: true,
      };

      setGames((prevGames) =>
        sanitizeGameCatalog([...prevGames, candidateGame], {
          allowNewPurchases: true,
        })
      );

      setGameRefreshKey((prev) => prev + 1);
      const displayTitle = entry.rawTitle || baseStub.title || entry.id;
      showSyncNotice(`Restored "${displayTitle}" back to your library!`, 5000);
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
