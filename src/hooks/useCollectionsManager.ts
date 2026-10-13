import { useState, useCallback } from 'react';
import { GameCollection } from '../contracts/collection';
import { CanonicalGame } from '../contracts/game';
import { loadCollections, saveCollections } from '../services/storage/collectionStorage';

/**
 * Custom hook encapsulating user game collections state and CRUD operations.
 */
export function useCollectionsManager() {
  const [collections, setCollections] = useState<GameCollection[]>(() => loadCollections());
  const [isManageCollectionsOpen, setIsManageCollectionsOpen] = useState(false);
  const [collectionModalGame, setCollectionModalGame] = useState<CanonicalGame | null>(null);

  const handleOpenManageCollections = useCallback((game?: CanonicalGame) => {
    setCollectionModalGame(game || null);
    setIsManageCollectionsOpen(true);
  }, []);

  const handleCloseManageCollections = useCallback(() => {
    setIsManageCollectionsOpen(false);
  }, []);

  const handleCreateCollection = useCallback(
    (name: string) => {
      setCollections((prev) => {
        const newCol: GameCollection = {
          id: `col-${Date.now()}`,
          name,
          gameIds: collectionModalGame ? [collectionModalGame.id] : [],
        };
        const updated = [...prev, newCol];
        saveCollections(updated);
        return updated;
      });
    },
    [collectionModalGame]
  );

  const handleRenameCollection = useCallback((id: string, newName: string) => {
    setCollections((prev) => {
      const updated = prev.map((c) => (c.id === id ? { ...c, name: newName } : c));
      saveCollections(updated);
      return updated;
    });
  }, []);

  const handleDeleteCollection = useCallback((id: string) => {
    setCollections((prev) => {
      const updated = prev.filter((c) => c.id !== id);
      saveCollections(updated);
      return updated;
    });
  }, []);

  const handleToggleGameInCollection = useCallback((collectionId: string, gameId: string) => {
    setCollections((prev) => {
      const updated = prev.map((c) => {
        if (c.id === collectionId) {
          const has = c.gameIds.includes(gameId);
          return {
            ...c,
            gameIds: has ? c.gameIds.filter((id) => id !== gameId) : [...c.gameIds, gameId],
          };
        }
        return c;
      });
      saveCollections(updated);
      return updated;
    });
  }, []);

  return {
    collections,
    isManageCollectionsOpen,
    collectionModalGame,
    handleOpenManageCollections,
    handleCloseManageCollections,
    handleCreateCollection,
    handleRenameCollection,
    handleDeleteCollection,
    handleToggleGameInCollection,
  };
}
