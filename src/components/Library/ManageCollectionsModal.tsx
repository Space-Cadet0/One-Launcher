import React, { useState } from 'react';
import { GameCollection } from '../../contracts/collection';
import { CanonicalGame } from '../../contracts/game';
import { FolderPlus, X, Check, Trash2, Edit2, Bookmark, ChevronDown } from 'lucide-react';
import {
  CollectionIcon,
  COLLECTION_ICON_OPTIONS,
  getEffectiveCollectionIconId,
} from '../Common/CollectionIcon';

interface ManageCollectionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  collections: GameCollection[];
  game?: CanonicalGame | null;
  onCreateCollection: (name: string, icon?: string) => void;
  onRenameCollection: (id: string, newName: string, icon?: string) => void;
  onDeleteCollection: (id: string) => void;
  onToggleGameInCollection: (collectionId: string, gameId: string) => void;
}

export const ManageCollectionsModal: React.FC<ManageCollectionsModalProps> = ({
  isOpen,
  onClose,
  collections,
  game,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection,
  onToggleGameInCollection,
}) => {
  const [newColName, setNewColName] = useState('');
  const [newCollectionIcon, setNewCollectionIcon] = useState<string>('folder');
  const [showNewIconPicker, setShowNewIconPicker] = useState(false);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingIcon, setEditingIcon] = useState<string>('folder');

  if (!isOpen) return null;

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newColName.trim()) return;
    onCreateCollection(newColName.trim(), newCollectionIcon);
    setNewColName('');
    setNewCollectionIcon('folder');
    setShowNewIconPicker(false);
    setIsCreatingNew(false);
  };

  const handleStartEditing = (col: GameCollection) => {
    setEditingId(col.id);
    setEditingName(col.name);
    setEditingIcon(getEffectiveCollectionIconId(col));
  };

  const handleRenameSubmit = (id: string) => {
    if (!editingName.trim()) return;
    onRenameCollection(id, editingName.trim(), editingIcon);
    setEditingId(null);
    setEditingName('');
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#1b2838] border border-[#2a475e] rounded-lg shadow-2xl w-full max-w-md overflow-hidden text-steam-text">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#121a24] border-b border-[#2a475e] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bookmark className="w-4 h-4 text-steam-accent" />
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">
              {game ? `Collections: ${game.title}` : 'Manage Collections'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-steam-subtext hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {game && (
            <p className="text-xs text-[#8f98a0]">
              Assign <strong className="text-white">{game.title}</strong> to one or more user collections:
            </p>
          )}

          {/* Collections List */}
          <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
            {collections.map((col) => {
              const isIncluded = game ? col.gameIds.includes(game.id) : false;
              const isEditing = editingId === col.id;

              return (
                <div
                  key={col.id}
                  className={`flex flex-col px-3 py-2 rounded border transition-colors ${
                    isIncluded
                      ? 'bg-[#223547] border-steam-accent/50 text-white'
                      : 'bg-[#16202d] border-[#2a475e]/60 text-steam-text hover:bg-[#1f2d3d]'
                  }`}
                >
                  {isEditing ? (
                    <div className="space-y-2.5 w-full">
                      <div className="flex items-center gap-2 w-full">
                        <div className="flex items-center justify-center w-7 h-7 rounded bg-[#0e141b] border border-steam-accent/60 shrink-0">
                          <CollectionIcon iconId={editingIcon} collectionId={col.id} size={15} />
                        </div>
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleRenameSubmit(col.id);
                            } else if (e.key === 'Escape') {
                              setEditingId(null);
                            }
                          }}
                          className="bg-[#0e141b] border border-steam-accent text-white text-xs rounded px-2 py-1 flex-1 outline-none"
                          autoFocus
                        />
                        <button
                          type="button"
                          onClick={() => handleRenameSubmit(col.id)}
                          className="px-2.5 py-1 bg-steam-accent hover:bg-sky-400 text-white text-xs rounded font-semibold transition-colors"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="text-xs text-steam-subtext hover:text-white px-1"
                        >
                          Cancel
                        </button>
                      </div>

                      {/* Edit Collection Icon Picker Grid */}
                      <div
                        className="p-2 rounded bg-[#0e141b]/90 border border-[#2a475e]/80"
                        data-testid={`edit-collection-icon-grid-${col.id}`}
                      >
                        <div className="text-[10px] uppercase tracking-wider text-steam-subtext font-semibold mb-1.5">
                          Choose Icon
                        </div>
                        <div className="grid grid-cols-8 gap-1">
                          {COLLECTION_ICON_OPTIONS.map((opt) => {
                            const isSelected = editingIcon === opt.id;
                            return (
                              <button
                                key={opt.id}
                                type="button"
                                onClick={() => setEditingIcon(opt.id)}
                                data-icon-option={opt.id}
                                title={opt.label}
                                className={`p-1.5 rounded flex items-center justify-center transition-all ${
                                  isSelected
                                    ? 'bg-steam-accent/25 border border-steam-accent ring-1 ring-steam-accent/50 scale-105'
                                    : 'bg-[#16202d] border border-transparent hover:border-[#2a475e] hover:bg-[#1f2d3d]'
                                }`}
                              >
                                <CollectionIcon iconId={opt.id} size={14} />
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between w-full">
                      <div
                        onClick={() => game && onToggleGameInCollection(col.id, game.id)}
                        className="flex items-center gap-2.5 flex-1 cursor-pointer select-none"
                      >
                        {game && (
                          <div
                            className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                              isIncluded
                                ? 'bg-steam-accent border-steam-accent text-white'
                                : 'border-[#4a5f73] bg-[#0e141b]'
                            }`}
                          >
                            {isIncluded && <Check className="w-3 h-3 stroke-[3]" />}
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStartEditing(col);
                          }}
                          title="Change collection icon or name"
                          className="p-1 -ml-1 rounded hover:bg-[#2a3c4e]/70 transition-colors flex items-center justify-center"
                          data-testid={`collection-row-icon-${col.id}`}
                        >
                          <CollectionIcon iconId={col.icon} collectionId={col.id} size={16} />
                        </button>
                        <span className="text-xs font-semibold flex items-center gap-1.5">
                          {col.name}
                        </span>
                        <span className="text-[10px] text-[#6b7b8c] font-normal">
                          ({col.gameIds.length} {col.gameIds.length === 1 ? 'game' : 'games'})
                        </span>
                      </div>

                      {/* Management Actions */}
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleStartEditing(col)}
                          className="p-1 text-steam-subtext hover:text-white rounded hover:bg-[#2a3c4e]"
                          title="Edit collection name & icon"
                        >
                          <Edit2 className="w-3 h-3" />
                        </button>
                        {!col.isDefault && (
                          <button
                            type="button"
                            onClick={() => onDeleteCollection(col.id)}
                            className="p-1 text-steam-subtext hover:text-red-400 rounded hover:bg-[#2a3c4e]"
                            title="Delete collection"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Create New Collection Inline Form */}
          {isCreatingNew ? (
            <form onSubmit={handleCreateSubmit} className="pt-2 border-t border-[#2a475e]/60 space-y-2.5">
              <label className="text-[11px] font-semibold text-white uppercase tracking-wider block">
                New Collection:
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowNewIconPicker((prev) => !prev)}
                  data-testid="new-collection-icon-trigger"
                  title="Choose collection icon"
                  className="flex items-center gap-1 px-2 py-1.5 rounded bg-[#0e141b] border border-[#2a475e] hover:border-steam-accent text-white transition-colors"
                >
                  <CollectionIcon iconId={newCollectionIcon} size={15} />
                  <ChevronDown className="w-3 h-3 text-steam-subtext" />
                </button>
                <input
                  type="text"
                  placeholder="e.g. RPGs, Co-Op Favorites, Indie Gems..."
                  value={newColName}
                  onChange={(e) => setNewColName(e.target.value)}
                  className="bg-[#0e141b] border border-[#2a475e] text-white text-xs rounded px-3 py-1.5 flex-1 focus:border-steam-accent outline-none"
                  autoFocus
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 bg-steam-accent hover:bg-sky-400 text-white font-semibold text-xs rounded transition-colors"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsCreatingNew(false);
                    setShowNewIconPicker(false);
                  }}
                  className="px-2 py-1.5 text-xs text-steam-subtext hover:text-white"
                >
                  Cancel
                </button>
              </div>

              {showNewIconPicker && (
                <div
                  className="p-2.5 rounded bg-[#0e141b]/95 border border-[#2a475e]"
                  data-testid="new-collection-icon-grid"
                >
                  <div className="text-[10px] uppercase tracking-wider text-steam-subtext font-semibold mb-1.5">
                    Select Collection Icon
                  </div>
                  <div className="grid grid-cols-8 gap-1">
                    {COLLECTION_ICON_OPTIONS.map((opt) => {
                      const isSelected = newCollectionIcon === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setNewCollectionIcon(opt.id)}
                          data-icon-option={opt.id}
                          title={opt.label}
                          className={`p-1.5 rounded flex items-center justify-center transition-all ${
                            isSelected
                              ? 'bg-steam-accent/25 border border-steam-accent ring-1 ring-steam-accent/50 scale-105'
                              : 'bg-[#16202d] border border-transparent hover:border-[#2a475e] hover:bg-[#1f2d3d]'
                          }`}
                        >
                          <CollectionIcon iconId={opt.id} size={14} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </form>
          ) : (
            <button
              type="button"
              onClick={() => {
                setIsCreatingNew(true);
                setShowNewIconPicker(true);
              }}
              className="w-full py-2 px-3 border border-dashed border-[#2a475e] hover:border-steam-accent/70 rounded text-xs text-steam-accent hover:text-white flex items-center justify-center gap-1.5 transition-colors bg-[#141d27]/50 hover:bg-[#1b2838]"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>Create New Collection</span>
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 bg-[#121a24] border-t border-[#2a475e] flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-steam-accent hover:bg-sky-400 text-white font-semibold text-xs rounded transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

