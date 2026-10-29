import React, { useState } from 'react';
import { GameCollection } from '../../contracts/collection';
import { CanonicalGame } from '../../contracts/game';
import {
  FolderPlus,
  X,
  Check,
  Trash2,
  Edit2,
  Bookmark,
  ChevronDown,
  ChevronUp,
  GripVertical,
} from 'lucide-react';
import {
  CollectionIcon,
  COLLECTION_ICON_OPTIONS,
  getEffectiveCollectionIconId,
} from '../Common/CollectionIcon';
import { ModalShell } from '../Common/ModalShell';
import { useSafeId } from '../../utils/useSafeId';

interface ManageCollectionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  collections: GameCollection[];
  game?: CanonicalGame | null;
  onCreateCollection: (name: string, icon?: string) => void;
  onRenameCollection: (id: string, newName: string, icon?: string) => void;
  onDeleteCollection: (id: string) => void;
  onToggleGameInCollection: (collectionId: string, gameId: string) => void;
  onReorderCollections?: (fromIndex: number, toIndex: number) => void;
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
  onReorderCollections,
}) => {
  const modalTitleId = useSafeId('manage-collections-modal-title');
  const newColInputId = useSafeId('new-collection-name-input');
  const editColInputId = useSafeId('edit-collection-name-input');

  const [newColName, setNewColName] = useState('');
  const [newCollectionIcon, setNewCollectionIcon] = useState<string>('folder');
  const [showNewIconPicker, setShowNewIconPicker] = useState(false);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingIcon, setEditingIcon] = useState<string>('folder');
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropSlotIndex, setDropSlotIndex] = useState<number | null>(null);

  if (!isOpen) return null;

  const resolveSlotForRowDragOver = (
    rowIndex: number,
    e: React.DragEvent<HTMLDivElement>
  ): number => {
    if (draggedIndex !== null && rowIndex === draggedIndex) {
      return draggedIndex;
    }
    const rect = e.currentTarget?.getBoundingClientRect?.();
    if (rect && rect.height > 0 && typeof e.clientY === 'number' && e.clientY > 0) {
      const isUpperHalf = e.clientY < rect.top + rect.height / 2;
      return isUpperHalf ? rowIndex : rowIndex + 1;
    }
    return draggedIndex !== null && draggedIndex < rowIndex ? rowIndex + 1 : rowIndex;
  };

  const commitDropToSlot = (e: React.DragEvent<HTMLDivElement>, targetSlot: number) => {
    e.preventDefault();
    const rawIdx = e.dataTransfer?.getData('text/plain');
    const fromIdx =
      draggedIndex !== null
        ? draggedIndex
        : rawIdx !== undefined && rawIdx !== ''
          ? Number(rawIdx)
          : NaN;

    if (
      !Number.isNaN(fromIdx) &&
      onReorderCollections &&
      targetSlot !== fromIdx &&
      targetSlot !== fromIdx + 1
    ) {
      const toIdx = fromIdx < targetSlot ? targetSlot - 1 : targetSlot;
      if (toIdx >= 0 && toIdx < collections.length && toIdx !== fromIdx) {
        onReorderCollections(fromIdx, toIdx);
      }
    }
    setDraggedIndex(null);
    setDropSlotIndex(null);
  };

  const renderDropSlot = (slotIdx: number) => {
    if (!onReorderCollections || collections.length <= 1) return null;
    const isNoOpSlot =
      draggedIndex === null || slotIdx === draggedIndex || slotIdx === draggedIndex + 1;
    const isActiveSlot = !isNoOpSlot && dropSlotIndex === slotIdx;

    const prevCol = slotIdx > 0 ? collections[slotIdx - 1] : null;
    const nextCol = slotIdx < collections.length ? collections[slotIdx] : null;
    const slotLabel =
      prevCol && nextCol
        ? `Drop between "${prevCol.name}" & "${nextCol.name}"`
        : nextCol
          ? `Drop at top — before "${nextCol.name}"`
          : prevCol
            ? `Drop at bottom — after "${prevCol.name}"`
            : 'Drop here';

    return (
      <div
        key={`drop-slot-${slotIdx}`}
        data-testid={`collection-drop-slot-${slotIdx}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'move';
          }
          if (dropSlotIndex !== slotIdx) {
            setDropSlotIndex(slotIdx);
          }
        }}
        onDrop={(e) => {
          e.stopPropagation();
          commitDropToSlot(e, slotIdx);
        }}
        className={`transition-all duration-150 ${
          isActiveSlot
            ? 'my-1.5 py-1.5 px-2.5 rounded border border-dashed border-[#66c0f4] bg-[#66c0f4]/15 shadow-[0_0_12px_rgba(102,192,244,0.28)]'
            : draggedIndex !== null && !isNoOpSlot
              ? 'h-2.5 flex items-center'
              : slotIdx === 0 || slotIdx === collections.length
                ? 'h-0.5'
                : 'h-1.5'
        }`}
      >
        {isActiveSlot ? (
          <div
            data-testid={`active-drop-indicator-${slotIdx}`}
            className="flex flex-col gap-1 w-full pointer-events-none"
          >
            <div className="flex items-center w-full">
              <span className="w-2 h-2 rounded-full bg-[#66c0f4] shadow-[0_0_8px_#66c0f4] shrink-0" />
              <div className="h-0.5 flex-1 bg-[#66c0f4] shadow-[0_0_8px_#66c0f4]" />
              <span className="w-2 h-2 rounded-full bg-[#66c0f4] shadow-[0_0_8px_#66c0f4] shrink-0" />
            </div>
            <span className="text-[10px] font-semibold text-[#66c0f4] text-center tracking-wide">
              {slotLabel}
            </span>
          </div>
        ) : null}
      </div>
    );
  };

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
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      ariaLabelledBy={modalTitleId}
      className="w-full max-w-md"
    >
      <div className="bg-[#1b2838] border border-[#2a475e] rounded-lg shadow-2xl w-full max-w-md overflow-hidden text-steam-text">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#121a24] border-b border-[#2a475e] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bookmark className="w-4 h-4 text-steam-accent" />
            <h2
              id={modalTitleId}
              className="text-sm font-bold text-white uppercase tracking-wider"
            >
              {game ? `Collections: ${game.title}` : 'Manage Collections'}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close collections modal"
            onClick={onClose}
            className="min-w-6 min-h-6 flex items-center justify-center rounded text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {game && (
            <p className="text-xs text-slate-300">
              Assign <strong className="text-white">{game.title}</strong> to one or more user
              collections:
            </p>
          )}

          <div className="flex items-center justify-between text-[11px] text-slate-300">
            <span className="font-semibold uppercase tracking-wider text-white/90">
              Your Collections ({collections.length})
            </span>
            {collections.length > 1 && onReorderCollections && (
              <span className="text-[10px] text-slate-300">
                Drag to reorder in sidebar (or use ↑/↓ buttons)
              </span>
            )}
          </div>

          {/* Collections List */}
          <div
            className="max-h-72 overflow-y-auto pr-1"
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDropSlotIndex(null);
              }
            }}
          >
            {renderDropSlot(0)}
            {collections.map((col, index) => {
              const isIncluded = game ? col.gameIds.includes(game.id) : false;
              const isEditing = editingId === col.id;
              const isDragging = draggedIndex === index;
              const isReturningToOrigin =
                isDragging && (dropSlotIndex === index || dropSlotIndex === index + 1);
              const isBeforeTarget =
                draggedIndex !== null &&
                dropSlotIndex === index &&
                index !== draggedIndex &&
                index !== draggedIndex + 1;
              const isAfterTarget =
                draggedIndex !== null &&
                dropSlotIndex === index + 1 &&
                index + 1 !== draggedIndex &&
                index + 1 !== draggedIndex + 1;

              return (
                <React.Fragment key={col.id}>
                  <div
                    data-testid={`collection-row-${col.id}`}
                    draggable={!isEditing && Boolean(onReorderCollections)}
                    onDragStart={(e) => {
                      setDraggedIndex(index);
                      setDropSlotIndex(index);
                      e.dataTransfer?.setData('text/plain', String(index));
                      if (e.dataTransfer) {
                        e.dataTransfer.effectAllowed = 'move';
                      }
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (e.dataTransfer) {
                        e.dataTransfer.dropEffect = 'move';
                      }
                      const nextSlot = resolveSlotForRowDragOver(index, e);
                      if (dropSlotIndex !== nextSlot) {
                        setDropSlotIndex(nextSlot);
                      }
                    }}
                    onDrop={(e) => {
                      if (draggedIndex === index) {
                        e.preventDefault();
                        setDraggedIndex(null);
                        setDropSlotIndex(null);
                        return;
                      }
                      const targetSlot = resolveSlotForRowDragOver(index, e);
                      commitDropToSlot(e, targetSlot);
                    }}
                    onDragEnd={() => {
                      setDraggedIndex(null);
                      setDropSlotIndex(null);
                    }}
                    className={`group flex flex-col px-3 py-2 rounded border transition-all ${
                      isIncluded
                        ? 'bg-[#223547] border-steam-accent/50 text-white'
                        : 'bg-[#16202d] border-[#2a475e]/60 text-steam-text hover:bg-[#1f2d3d]'
                    } ${
                      isReturningToOrigin
                        ? 'opacity-100 border-[#66c0f4] ring-1 ring-[#66c0f4]/60 bg-[#1f3247]'
                        : isDragging
                          ? 'opacity-45 border-[#66c0f4]/60 scale-[0.99]'
                          : ''
                    } ${
                      isBeforeTarget ? 'border-t-2 border-t-[#66c0f4]' : ''
                    } ${isAfterTarget ? 'border-b-2 border-b-[#66c0f4]' : ''}`}
                  >
                    {isEditing ? (
                      <div className="space-y-2.5 w-full">
                        <div className="flex items-center gap-2 w-full">
                          <div className="flex items-center justify-center w-7 h-7 rounded bg-[#0e141b] border border-steam-accent/60 shrink-0">
                            <CollectionIcon iconId={editingIcon} collectionId={col.id} size={15} />
                          </div>
                          <label htmlFor={editColInputId} className="sr-only">
                            Collection name
                          </label>
                          <input
                            id={editColInputId}
                            type="text"
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                handleRenameSubmit(col.id);
                              } else if (e.key === 'Escape') {
                                e.stopPropagation();
                                setEditingId(null);
                              }
                            }}
                            className="bg-[#0e141b] border border-steam-accent text-white text-xs rounded px-2 py-1 flex-1 outline-none"
                            autoFocus
                          />
                          <button
                            type="button"
                            onClick={() => handleRenameSubmit(col.id)}
                            className="min-h-6 px-2.5 py-1 bg-steam-accent hover:bg-sky-400 text-black text-xs rounded font-semibold transition-colors"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="min-h-6 text-xs text-slate-300 hover:text-white px-1.5"
                          >
                            Cancel
                          </button>
                        </div>

                        {/* Edit Collection Icon Picker Grid */}
                        <div
                          className="p-2 rounded bg-[#0e141b]/90 border border-[#2a475e]/80"
                          data-testid={`edit-collection-icon-grid-${col.id}`}
                        >
                          <div className="text-[10px] uppercase tracking-wider text-slate-300 font-semibold mb-1.5">
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
                                  aria-label={`Select ${opt.label} icon`}
                                  aria-pressed={isSelected}
                                  className={`min-w-6 min-h-6 p-1.5 rounded flex items-center justify-center transition-all ${
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
                      <div className="flex items-center justify-between w-full gap-1.5">
                        <div className="flex items-center gap-2 flex-1 min-w-0 select-none">
                          <div
                            data-testid={`drag-handle-${col.id}`}
                            className="text-slate-400 group-hover:text-slate-200 cursor-grab active:cursor-grabbing shrink-0"
                            title="Drag to reorder"
                            aria-hidden="true"
                          >
                            <GripVertical className="w-4 h-4" />
                          </div>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStartEditing(col);
                            }}
                            title="Change collection icon or name"
                            aria-label={`Change icon or name for ${col.name}`}
                            className="min-w-6 min-h-6 p-1 -ml-1 rounded hover:bg-[#2a3c4e]/70 transition-colors flex items-center justify-center shrink-0"
                            data-testid={`collection-row-icon-${col.id}`}
                          >
                            <CollectionIcon iconId={col.icon} collectionId={col.id} size={16} />
                          </button>

                          {game ? (
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={isIncluded}
                              onClick={() => onToggleGameInCollection(col.id, game.id)}
                              className="min-h-6 flex items-center gap-2 flex-1 min-w-0 text-left cursor-pointer"
                            >
                              <span
                                className={`w-4 h-4 rounded border flex items-center justify-center transition-colors shrink-0 ${
                                  isIncluded
                                    ? 'bg-steam-accent border-steam-accent text-black'
                                    : 'border-[#4a5f73] bg-[#0e141b]'
                                }`}
                              >
                                {isIncluded && <Check className="w-3 h-3 stroke-[3]" />}
                              </span>
                              <span className="text-xs font-semibold truncate">{col.name}</span>
                              <span className="text-[10px] text-slate-300 font-normal shrink-0">
                                ({col.gameIds.length}{' '}
                                {col.gameIds.length === 1 ? 'game' : 'games'})
                              </span>
                            </button>
                          ) : (
                            <div className="flex items-center gap-1.5 flex-1 min-w-0">
                              <span className="text-xs font-semibold truncate">{col.name}</span>
                              <span className="text-[10px] text-slate-300 font-normal shrink-0">
                                ({col.gameIds.length}{' '}
                                {col.gameIds.length === 1 ? 'game' : 'games'})
                              </span>
                            </div>
                          )}
                        </div>

                        {/* Management Actions (Keyboard Reorder + Edit + Delete) */}
                        <div className="flex items-center gap-0.5 shrink-0">
                          {isReturningToOrigin ? (
                            <span
                              data-testid={`keep-position-badge-${col.id}`}
                              className="text-[10px] font-semibold text-[#66c0f4] px-1.5 py-0.5 rounded bg-[#66c0f4]/15 border border-[#66c0f4]/40 pointer-events-none"
                            >
                              Keep in current position
                            </span>
                          ) : (
                            <>
                              {onReorderCollections && collections.length > 1 && (
                                <>
                                  <button
                                    type="button"
                                    data-testid={`move-collection-up-${col.id}`}
                                    disabled={index === 0}
                                    onClick={() => onReorderCollections(index, index - 1)}
                                    className="min-w-6 min-h-6 flex items-center justify-center text-slate-300 hover:text-white disabled:opacity-35 disabled:pointer-events-none rounded hover:bg-[#2a3c4e]"
                                    title={`Move ${col.name} up`}
                                    aria-label={`Move ${col.name} up`}
                                  >
                                    <ChevronUp className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    data-testid={`move-collection-down-${col.id}`}
                                    disabled={index === collections.length - 1}
                                    onClick={() => onReorderCollections(index, index + 1)}
                                    className="min-w-6 min-h-6 flex items-center justify-center text-slate-300 hover:text-white disabled:opacity-35 disabled:pointer-events-none rounded hover:bg-[#2a3c4e]"
                                    title={`Move ${col.name} down`}
                                    aria-label={`Move ${col.name} down`}
                                  >
                                    <ChevronDown className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}
                              <button
                                type="button"
                                onClick={() => handleStartEditing(col)}
                                className="min-w-6 min-h-6 flex items-center justify-center text-slate-300 hover:text-white rounded hover:bg-[#2a3c4e]"
                                title="Edit collection name & icon"
                                aria-label={`Edit ${col.name}`}
                              >
                                <Edit2 className="w-3 h-3" />
                              </button>
                              {!col.isDefault && (
                                <button
                                  type="button"
                                  onClick={() => onDeleteCollection(col.id)}
                                  className="min-w-6 min-h-6 flex items-center justify-center text-slate-300 hover:text-red-400 rounded hover:bg-[#2a3c4e]"
                                  title="Delete collection"
                                  aria-label={`Delete ${col.name}`}
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  {renderDropSlot(index + 1)}
                </React.Fragment>
              );
            })}
          </div>

          {/* Create New Collection Inline Form */}
          {isCreatingNew ? (
            <form
              onSubmit={handleCreateSubmit}
              className="pt-2 border-t border-[#2a475e]/60 space-y-2.5"
            >
              <label
                htmlFor={newColInputId}
                className="text-[11px] font-semibold text-white uppercase tracking-wider block"
              >
                New Collection:
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowNewIconPicker((prev) => !prev)}
                  data-testid="new-collection-icon-trigger"
                  title="Choose collection icon"
                  aria-label="Choose collection icon"
                  aria-expanded={showNewIconPicker}
                  className="min-w-6 min-h-6 flex items-center gap-1 px-2 py-1.5 rounded bg-[#0e141b] border border-[#2a475e] hover:border-steam-accent text-white transition-colors"
                >
                  <CollectionIcon iconId={newCollectionIcon} size={15} />
                  <ChevronDown className="w-3 h-3 text-slate-300" />
                </button>
                <input
                  id={newColInputId}
                  type="text"
                  placeholder="e.g. RPGs, Co-Op Favorites, Indie Gems..."
                  value={newColName}
                  onChange={(e) => setNewColName(e.target.value)}
                  className="bg-[#0e141b] border border-[#2a475e] text-white placeholder-slate-400 text-xs rounded px-3 py-1.5 flex-1 focus:border-steam-accent outline-none"
                  autoFocus
                />
                <button
                  type="submit"
                  className="min-h-6 px-3 py-1.5 bg-steam-accent hover:bg-sky-400 text-black font-semibold text-xs rounded transition-colors"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsCreatingNew(false);
                    setShowNewIconPicker(false);
                  }}
                  className="min-h-6 px-2 py-1.5 text-xs text-slate-300 hover:text-white"
                >
                  Cancel
                </button>
              </div>

              {showNewIconPicker && (
                <div
                  className="p-2.5 rounded bg-[#0e141b]/95 border border-[#2a475e]"
                  data-testid="new-collection-icon-grid"
                >
                  <div className="text-[10px] uppercase tracking-wider text-slate-300 font-semibold mb-1.5">
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
                          aria-label={`Select ${opt.label} icon`}
                          aria-pressed={isSelected}
                          className={`min-w-6 min-h-6 p-1.5 rounded flex items-center justify-center transition-all ${
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
              className="w-full min-h-6 py-2 px-3 border border-dashed border-[#2a475e] hover:border-steam-accent/70 rounded text-xs text-steam-accent hover:text-white flex items-center justify-center gap-1.5 transition-colors bg-[#141d27]/50 hover:bg-[#1b2838]"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>Create New Collection</span>
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 bg-[#121a24] border-t border-[#2a475e] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="min-h-6 px-4 py-1.5 bg-steam-accent hover:bg-sky-400 text-black font-semibold text-xs rounded transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </ModalShell>
  );
};
