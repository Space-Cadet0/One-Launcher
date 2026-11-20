import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Plus, RotateCcw, Search, Tag, X } from 'lucide-react';
import type { ResolvedGameTag, TagFacetCount } from '../../contracts/tags';
import { isImeComposing } from '../../utils/keyboardUtils';
import { useSafeId } from '../../utils/useSafeId';
import { normalizeTagKey, sanitizeTagLabel } from '../../services/storage/userTagStorage';

interface PopoverToggleEventLike extends Event {
  newState?: string;
}

export interface TagManagerPopoverProps {
  gameTitle: string;
  entries: ResolvedGameTag[];
  availableLibraryTags?: TagFacetCount[];
  hasUserEdits: boolean;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onResetTags?: () => void;
  triggerClassName?: string;
  triggerTestId?: string;
  popoverTestId?: string;
}

export const TagManagerPopover: React.FC<TagManagerPopoverProps> = ({
  gameTitle,
  entries,
  availableLibraryTags = [],
  hasUserEdits,
  onAddTag,
  onRemoveTag,
  onResetTags,
  triggerClassName,
  triggerTestId = 'hero-tag-manager-trigger',
  popoverTestId = 'tag-manager-popover',
}) => {
  const safeId = useSafeId('tag-mgr');
  const anchorToken = `--${safeId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const popoverId = `${safeId}-popover`;
  const headingId = `${safeId}-heading`;
  const inputId = `${safeId}-search`;

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDialogElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wasOpenOnPointerDownRef = useRef(false);

  const [isOpen, setIsOpen] = useState(false);
  const [usesFallbackMode, setUsesFallbackMode] = useState(false);
  const [query, setQuery] = useState('');
  const [announcedStatus, setAnnouncedStatus] = useState('');

  const appliedByKey = useMemo(() => {
    const map = new Map<string, ResolvedGameTag>();
    for (const entry of entries) {
      map.set(entry.key, entry);
    }
    return map;
  }, [entries]);

  const mergedLibraryTags = useMemo<TagFacetCount[]>(() => {
    const byKey = new Map<string, TagFacetCount>();
    for (const facet of availableLibraryTags) {
      const cleanLabel = sanitizeTagLabel(facet.label);
      const key = facet.key ? facet.key.toLowerCase() : cleanLabel.toLowerCase();
      if (!cleanLabel || !key) continue;
      const existing = byKey.get(key);
      if (!existing || facet.count > existing.count) {
        byKey.set(key, { key, label: cleanLabel, count: Math.max(0, facet.count) });
      }
    }
    for (const entry of entries) {
      if (!byKey.has(entry.key)) {
        byKey.set(entry.key, { key: entry.key, label: entry.label, count: 1 });
      }
    }
    return Array.from(byKey.values());
  }, [availableLibraryTags, entries]);

  const trimmedQuery = useMemo(() => sanitizeTagLabel(query), [query]);
  const lowerQuery = trimmedQuery.toLowerCase();

  const filteredLibraryTags = useMemo<TagFacetCount[]>(() => {
    if (!lowerQuery) {
      return [...mergedLibraryTags].sort(
        (a, b) => b.count - a.count || a.label.localeCompare(b.label)
      );
    }

    return mergedLibraryTags
      .filter((item) => item.label.toLowerCase().includes(lowerQuery))
      .sort((a, b) => {
        const aLower = a.label.toLowerCase();
        const bLower = b.label.toLowerCase();
        const aExact = aLower === lowerQuery ? 0 : 1;
        const bExact = bLower === lowerQuery ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        const aPrefix = aLower.startsWith(lowerQuery) ? 0 : 1;
        const bPrefix = bLower.startsWith(lowerQuery) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        if (b.count !== a.count) return b.count - a.count;
        return a.label.localeCompare(b.label);
      });
  }, [mergedLibraryTags, lowerQuery]);

  const exactLibraryMatch = useMemo(() => {
    if (!lowerQuery) return undefined;
    return mergedLibraryTags.find((item) => item.key === lowerQuery);
  }, [mergedLibraryTags, lowerQuery]);

  const submitTargetLabel = useMemo(() => {
    if (!trimmedQuery) return '';
    if (trimmedQuery === lowerQuery && exactLibraryMatch) {
      return exactLibraryMatch.label;
    }
    return trimmedQuery;
  }, [trimmedQuery, lowerQuery, exactLibraryMatch]);

  const submitTargetKey = normalizeTagKey(submitTargetLabel);
  const existingAppliedForSubmit = submitTargetKey
    ? appliedByKey.get(submitTargetKey)
    : undefined;
  const isAlreadyAppliedExact = Boolean(
    existingAppliedForSubmit && existingAppliedForSubmit.label === submitTargetLabel
  );
  const canSubmit = Boolean(submitTargetLabel && !isAlreadyAppliedExact);

  const focusTrigger = useCallback(() => {
    try {
      triggerRef.current?.focus();
    } catch {
      // Ignore focus errors in headless environments
    }
  }, []);

  const focusInput = useCallback(() => {
    try {
      inputRef.current?.focus();
    } catch {
      // Ignore focus errors in headless environments
    }
  }, []);

  const handleClose = useCallback(() => {
    const el = popoverRef.current;
    if (el && typeof el.hidePopover === 'function') {
      try {
        el.hidePopover();
      } catch {
        // Ignore if already closed
      }
    }
    setIsOpen(false);
    setQuery('');
    focusTrigger();
  }, [focusTrigger]);

  const handleTriggerPointerDown = useCallback(() => {
    const el = popoverRef.current;
    let isDomPopoverOpen = false;
    if (el && typeof el.matches === 'function') {
      try {
        isDomPopoverOpen = el.matches(':popover-open');
      } catch {
        isDomPopoverOpen = false;
      }
    }
    wasOpenOnPointerDownRef.current = isOpen || isDomPopoverOpen;
  }, [isOpen]);

  const handleTriggerPointerCancel = useCallback(() => {
    wasOpenOnPointerDownRef.current = false;
  }, []);

  const handleTriggerKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      wasOpenOnPointerDownRef.current = false;
    }
  }, []);

  const handleTogglePopover = useCallback(() => {
    const wasOpenOnPointerDown = wasOpenOnPointerDownRef.current;
    wasOpenOnPointerDownRef.current = false;

    const el = popoverRef.current;
    const supportsNativePopover = Boolean(
      el && typeof el.showPopover === 'function' && typeof el.hidePopover === 'function'
    );

    if (supportsNativePopover && el) {
      if (isOpen || wasOpenOnPointerDown) {
        handleClose();
      } else {
        try {
          el.showPopover();
        } catch {
          // Ignore if already open
        }
        setUsesFallbackMode(false);
        setIsOpen(true);
        focusInput();
      }
      return;
    }

    // JSDOM / non-Popover fallback
    setUsesFallbackMode(true);
    if (isOpen || wasOpenOnPointerDown) {
      setIsOpen(false);
      setQuery('');
      focusTrigger();
    } else {
      setIsOpen(true);
    }
  }, [isOpen, handleClose, focusInput, focusTrigger]);

  // Sync native `popover="auto"` light-dismiss and Escape toggle events
  useEffect(() => {
    const el = popoverRef.current;
    if (!el || typeof el.addEventListener !== 'function') return;

    const handleNativeToggle = (event: Event) => {
      const toggleEvent = event as PopoverToggleEventLike;
      if (toggleEvent.newState === 'open') {
        setIsOpen(true);
        focusInput();
      } else if (toggleEvent.newState === 'closed') {
        setIsOpen(false);
        setQuery('');
        if (typeof document !== 'undefined') {
          const active = document.activeElement;
          if (!active || active === document.body || el.contains(active)) {
            focusTrigger();
          }
        }
      }
    };

    el.addEventListener('toggle', handleNativeToggle);
    return () => {
      el.removeEventListener('toggle', handleNativeToggle);
    };
  }, [focusInput, focusTrigger]);

  // Fallback outside-click & Escape dismissal when native `showPopover` is unavailable (e.g. JSDOM)
  useEffect(() => {
    if (!usesFallbackMode || !isOpen) return;
    focusInput();

    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
      return;
    }

    const handleDocMouseDown = (event: MouseEvent) => {
      const targetNode = event.target as Node | null;
      if (!targetNode) return;
      if (popoverRef.current?.contains(targetNode)) return;
      if (triggerRef.current?.contains(targetNode)) return;
      handleClose();
    };

    const handleDocKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleClose();
      }
    };

    document.addEventListener('mousedown', handleDocMouseDown);
    document.addEventListener('keydown', handleDocKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleDocMouseDown);
      document.removeEventListener('keydown', handleDocKeyDown);
    };
  }, [usesFallbackMode, isOpen, focusInput, handleClose]);

  // Debounced polite live-region announcement of match counts (`modern-web-guidance` accessibility)
  useEffect(() => {
    if (!isOpen) {
      setAnnouncedStatus('');
      return;
    }

    const timer = setTimeout(() => {
      const count = filteredLibraryTags.length;
      if (!trimmedQuery) {
        setAnnouncedStatus(
          count === 1 ? '1 library tag available.' : `${count} library tags available.`
        );
      } else if (count === 0) {
        setAnnouncedStatus(
          `No matching library tags. Activate Add to create "${submitTargetLabel}".`
        );
      } else {
        setAnnouncedStatus(
          count === 1
            ? `1 matching tag for "${trimmedQuery}".`
            : `${count} matching tags for "${trimmedQuery}".`
        );
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [isOpen, filteredLibraryTags.length, trimmedQuery, submitTargetLabel]);

  const handleSubmitQuery = useCallback(() => {
    if (!canSubmit || !submitTargetLabel) return;
    onAddTag(submitTargetLabel);
    setQuery('');
    focusInput();
  }, [canSubmit, submitTargetLabel, onAddTag, focusInput]);

  const handleFormSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      handleSubmitQuery();
    },
    [handleSubmitQuery]
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        if (isImeComposing(e)) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        handleSubmitQuery();
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (query.length > 0) {
          setQuery('');
          return;
        }
        handleClose();
      }
    },
    [query, handleSubmitQuery, handleClose]
  );

  const handleDialogKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDialogElement>) => {
      if (e.key === 'Escape' && usesFallbackMode) {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
      }
    },
    [usesFallbackMode, handleClose]
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid={triggerTestId}
        aria-label="Manage tags"
        aria-expanded={isOpen}
        aria-controls={popoverId}
        onPointerDown={handleTriggerPointerDown}
        onPointerCancel={handleTriggerPointerCancel}
        onKeyDown={handleTriggerKeyDown}
        onClick={handleTogglePopover}
        style={{ anchorName: anchorToken }}
        className={
          triggerClassName ??
          'inline-flex items-center justify-center min-w-6 min-h-6 px-1.5 bg-[rgba(103,193,245,0.2)] hover:bg-[rgba(103,193,245,0.4)] text-[#67c1f5] hover:text-white rounded-[2px] cursor-pointer text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#66c0f4] focus-visible:outline-offset-1'
        }
        title="Manage tags"
      >
        +
      </button>

      <dialog
        ref={popoverRef}
        id={popoverId}
        data-testid={popoverTestId}
        popover="auto"
        aria-labelledby={headingId}
        open={usesFallbackMode && isOpen ? true : undefined}
        data-fallback-open={usesFallbackMode && isOpen ? 'true' : undefined}
        style={{ positionAnchor: anchorToken }}
        className="ol-tag-popover text-left"
        onKeyDown={handleDialogKeyDown}
      >
        {/* Popover Header */}
        <div className="flex items-center justify-between gap-2 px-3 py-2.5 bg-[#16202d] border-b border-[#2a475e]">
          <div className="flex items-center gap-1.5 min-w-0">
            <Tag aria-hidden="true" className="w-3.5 h-3.5 text-[#67c1f5] shrink-0" />
            <h3
              id={headingId}
              className="text-xs font-bold text-white truncate"
              title={`Manage tags for ${gameTitle}`}
            >
              Manage Tags
            </h3>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {hasUserEdits && onResetTags && (
              <button
                type="button"
                data-testid="tag-manager-reset-btn"
                onClick={onResetTags}
                className="inline-flex items-center gap-1 min-h-6 px-2 rounded text-[11px] font-medium text-[#94a3b8] hover:text-white hover:bg-white/10 transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#66c0f4]"
                title="Reset tags back to synced storefront defaults"
              >
                <RotateCcw aria-hidden="true" className="w-3 h-3" />
                <span>Reset</span>
              </button>
            )}
            <button
              type="button"
              data-testid="tag-manager-close-btn"
              aria-label="Close tag manager"
              onClick={handleClose}
              className="inline-flex items-center justify-center min-w-6 min-h-6 rounded text-[#94a3b8] hover:text-white hover:bg-white/10 transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#66c0f4]"
              title="Close"
            >
              <X aria-hidden="true" className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Active Tags on This Game */}
        <div className="px-3 py-2.5 border-b border-[#2a475e]/60 bg-[#0f1721]">
          <div className="text-[10px] uppercase tracking-wider text-[#94a3b8] font-semibold mb-1.5">
            Current Tags ({entries.length})
          </div>
          {entries.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto overscroll-contain pr-0.5">
              {entries.map((entry) => (
                <span
                  key={entry.key}
                  data-testid={`tag-manager-active-${entry.key}`}
                  data-tag-source={entry.source}
                  className={`inline-flex items-center gap-1 pl-2 pr-0.5 rounded-[3px] text-[11px] ${
                    entry.source === 'user'
                      ? 'bg-[rgba(103,193,245,0.26)] border border-[#67c1f5]/55 text-[#d7efff]'
                      : 'bg-[rgba(103,193,245,0.14)] border border-[#2a475e] text-[#67c1f5]'
                  }`}
                >
                  <span className="truncate max-w-[180px]">{entry.label}</span>
                  <button
                    type="button"
                    data-testid={`tag-manager-remove-${entry.key}`}
                    aria-label={`Remove tag ${entry.label}`}
                    onClick={() => onRemoveTag(entry.label)}
                    className="inline-flex items-center justify-center min-w-6 min-h-6 rounded-[2px] text-[#94a3b8] hover:text-white hover:bg-white/15 transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#66c0f4]"
                    title={`Remove "${entry.label}"`}
                  >
                    <X aria-hidden="true" className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-[#94a3b8] italic">No tags assigned yet.</div>
          )}
        </div>

        {/* Search / Free-Text Add Form (<search> landmark + CSP-safe onSubmit + IME-safe Enter) */}
        <div className="px-3 pt-2.5 pb-2 border-b border-[#2a475e]/60">
          <search>
            <form onSubmit={handleFormSubmit} className="flex flex-col gap-2">
              <label htmlFor={inputId} className="sr-only">
                Search existing tags or create a new tag
              </label>
              <div className="relative flex items-center gap-1.5">
                <div className="relative flex-1 min-w-0">
                  <Search
                    aria-hidden="true"
                    className="w-3.5 h-3.5 text-[#94a3b8] pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
                  />
                  <input
                    ref={inputRef}
                    id={inputId}
                    type="text"
                    data-testid="tag-manager-search-input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleInputKeyDown}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    enterKeyHint="done"
                    maxLength={64}
                    placeholder="Search or add new tag..."
                    className="w-full min-h-7 pl-8 pr-7 py-1 rounded bg-[#0c121a] border border-[#2a475e] text-xs text-white placeholder-[#7f93a8] focus:outline-none focus:border-[#66c0f4]"
                  />
                  {query.length > 0 && (
                    <button
                      type="button"
                      data-testid="tag-manager-clear-search"
                      aria-label="Clear tag search"
                      onClick={() => {
                        setQuery('');
                        focusInput();
                      }}
                      className="inline-flex items-center justify-center min-w-6 min-h-6 absolute right-0.5 top-1/2 -translate-y-1/2 text-[#94a3b8] hover:text-white cursor-pointer rounded"
                    >
                      <X aria-hidden="true" className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <button
                  type="submit"
                  data-testid="tag-manager-submit-btn"
                  disabled={!canSubmit}
                  className={`inline-flex items-center justify-center gap-1 min-h-7 px-2.5 rounded text-[11px] font-semibold shrink-0 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#66c0f4] ${
                    canSubmit
                      ? 'bg-[#67c1f5]/25 hover:bg-[#67c1f5]/40 text-[#a8dcfa] hover:text-white border border-[#67c1f5]/50 cursor-pointer'
                      : 'bg-[#1b2838]/60 text-[#64748b] border border-[#2a475e]/50 cursor-not-allowed'
                  }`}
                >
                  {canSubmit ? (
                    <>
                      <Plus aria-hidden="true" className="w-3 h-3 shrink-0" />
                      <span className="truncate max-w-[110px]">
                        Add &ldquo;{submitTargetLabel}&rdquo;
                      </span>
                    </>
                  ) : isAlreadyAppliedExact ? (
                    <span>Added</span>
                  ) : (
                    <span>Add</span>
                  )}
                </button>
              </div>
            </form>
          </search>
        </div>

        {/* Dynamically Filtered Frequency-Sorted Library Tags List */}
        <div className="px-3 py-2">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-[#94a3b8] font-semibold mb-1.5">
            <span>{trimmedQuery ? 'Matching Library Tags' : 'Popular Library Tags'}</span>
            <span className="font-mono text-[#7f93a8]">{filteredLibraryTags.length}</span>
          </div>
          <div
            data-testid="tag-manager-library-list"
            className="max-h-52 overflow-y-auto overscroll-contain space-y-0.5 pr-0.5"
          >
            {filteredLibraryTags.length > 0 ? (
              filteredLibraryTags.map((item) => {
                const isApplied = appliedByKey.has(item.key);
                return (
                  <button
                    key={item.key}
                    type="button"
                    data-testid={`tag-manager-option-${item.key}`}
                    aria-pressed={isApplied}
                    onClick={() =>
                      isApplied ? onRemoveTag(item.label) : onAddTag(item.label)
                    }
                    className={`w-full min-h-7 px-2 py-1 rounded flex items-center justify-between gap-2 text-xs transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#66c0f4] ${
                      isApplied
                        ? 'bg-[rgba(103,193,245,0.22)] text-white hover:bg-[rgba(103,193,245,0.32)]'
                        : 'text-[#c6d4df] hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        aria-hidden="true"
                        className={`inline-flex items-center justify-center w-4 h-4 rounded shrink-0 ${
                          isApplied
                            ? 'bg-[#66c0f4] text-[#0b0f14]'
                            : 'bg-[#1b2838] border border-[#2a475e] text-[#67c1f5]'
                        }`}
                      >
                        {isApplied ? (
                          <Check className="w-3 h-3" />
                        ) : (
                          <Plus className="w-2.5 h-2.5" />
                        )}
                      </span>
                      <span className="truncate">{item.label}</span>
                    </span>
                    <span className="text-[11px] font-mono text-[#94a3b8] shrink-0">
                      ({item.count})
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="text-[11px] text-[#94a3b8] py-2 px-1">
                {trimmedQuery
                  ? `No existing tag matches "${trimmedQuery}". Press Enter or click Add to create it.`
                  : 'Type above to add your first tag.'}
              </div>
            )}
          </div>
        </div>

        {/* Debounced Polite Live Status Region */}
        <div
          role="status"
          aria-live="polite"
          data-testid="tag-manager-live-status"
          className="sr-only"
        >
          {announcedStatus}
        </div>
      </dialog>
    </>
  );
};
