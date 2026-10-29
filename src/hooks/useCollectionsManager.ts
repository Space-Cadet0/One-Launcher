import { useState, useCallback, useRef } from 'react';
import { GameCollection } from '../contracts/collection';
import { CanonicalGame } from '../contracts/game';
import { loadCollections, saveCollections } from '../services/storage/collectionStorage';

/**
 * Custom hook encapsulating user game collections state and CRUD operations.
 * Persistence runs strictly outside React state updaters for React 19 purity.
 */
export function useCollectionsManager() {
  const [collections, setCollections] = useState<GameCollection[]>(() => loadCollections());
  const collectionsRef = useRef<GameCollection[]>(collections);
  collectionsRef.current = collections;

  const [isManageCollectionsOpen, setIsManageCollectionsOpen] = useState(false);
  const [collectionModalGame, setCollectionModalGame] = useState<CanonicalGame | null>(null);

  const commitCollections = useCallback((updated: GameCollection[]) => {
    collectionsRef.current = updated;
    saveCollections(updated);
    setCollections(updated);
  }, []);

  const handleOpenManageCollections = useCallback((game?: CanonicalGame) => {
    setCollectionModalGame(game || null);
    setIsManageCollectionsOpen(true);
  }, []);

  const handleCloseManageCollections = useCallback(() => {
    setIsManageCollectionsOpen(false);
  }, []);

  const handleCreateCollection = useCallback(
    (name: string, icon?: string): string => {
      const id = `col-${Date.now()}`;
      const newCol: GameCollection = {
        id,
        name: name.trim() || 'New Collection',
        icon: icon || 'folder',
        gameIds: collectionModalGame ? [collectionModalGame.id] : [],
      };
      const updated = [...collectionsRef.current, newCol];
      commitCollections(updated);
      return id;
    },
    [collectionModalGame, commitCollections]
  );

  const handleRenameCollection = useCallback(
    (id: string, newName: string, icon?: string) => {
      const trimmedName = newName.trim();
      const updated = collectionsRef.current.map((c) =>
        c.id === id
          ? {
              ...c,
              ...(trimmedName ? { name: trimmedName } : {}),
              ...(icon !== undefined ? { icon } : {}),
            }
          : c
      );
      commitCollections(updated);
    },
    [commitCollections]
  );

  const handleUpdateCollectionIcon = useCallback(
    (id: string, icon: string) => {
      const updated = collectionsRef.current.map((c) => (c.id === id ? { ...c, icon } : c));
      commitCollections(updated);
    },
    [commitCollections]
  );

  const handleDeleteCollection = useCallback(
    (id: string) => {
      const updated = collectionsRef.current.filter((c) => c.id !== id);
      commitCollections(updated);
    },
    [commitCollections]
  );

  const handleToggleGameInCollection = useCallback(
    (collectionId: string, gameId: string) => {
      const updated = collectionsRef.current.map((c) => {
        if (c.id === collectionId) {
          const has = c.gameIds.includes(gameId);
          return {
            ...c,
            gameIds: has ? c.gameIds.filter((id) => id !== gameId) : [...c.gameIds, gameId],
          };
        }
        return c;
      });
      commitCollections(updated);
    },
    [commitCollections]
  );

  const handleReorderCollections = useCallback(
    (fromIndex: number, toIndex: number) => {
      const prev = collectionsRef.current;
      if (
        fromIndex < 0 ||
        fromIndex >= prev.length ||
        toIndex < 0 ||
        toIndex >= prev.length ||
        fromIndex === toIndex
      ) {
        return;
      }
      const updated = [...prev];
      const [moved] = updated.splice(fromIndex, 1);
      updated.splice(toIndex, 0, moved);
      commitCollections(updated);
    },
    [commitCollections]
  );

  return {
    collections,
    isManageCollectionsOpen,
    collectionModalGame,
    handleOpenManageCollections,
    handleCloseManageCollections,
    handleCreateCollection,
    handleRenameCollection,
    handleUpdateCollectionIcon,
    handleDeleteCollection,
    handleToggleGameInCollection,
    handleReorderCollections,
  };
}
