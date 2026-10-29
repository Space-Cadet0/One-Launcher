import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { ActiveGameFilter } from '../contracts/filter';

export interface NavHistoryEntry {
  id: string;
  view: 'game' | 'grid';
  selectedGameId: string | null;
  activeFilter: ActiveGameFilter | null;
  activeGroupId: string | null;
  title: string;
  scrollY?: number;
}

interface HistoryState {
  entries: NavHistoryEntry[];
  index: number;
}

const MAX_SCROLL_HISTORY_ENTRIES = 200;

function setBoundedScrollEntry(map: Map<string, number>, key: string, value: number): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= MAX_SCROLL_HISTORY_ENTRIES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, value);
}

function hasOpenModalDialog(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof document.querySelector === 'function' &&
    Boolean(document.querySelector('dialog[open]'))
  );
}

let nextNavId = 0;
export function createNavEntryId(): string {
  return `nav-${++nextNavId}-${Date.now()}`;
}

export function useNavigationHistory(
  initialEntry: Omit<NavHistoryEntry, 'id'> & { id?: string },
  getCurrentScroll?: () => number
) {
  const scrollMapRef = useRef<Map<string, number>>(new Map());
  const lastAllGamesScrollY = useRef<number>(initialEntry.scrollY ?? 0);

  const [historyState, setHistoryState] = useState<HistoryState>(() => {
    const entryWithId: NavHistoryEntry = {
      ...initialEntry,
      id: initialEntry.id || createNavEntryId(),
      scrollY: initialEntry.scrollY ?? 0,
    };
    setBoundedScrollEntry(scrollMapRef.current, entryWithId.id, entryWithId.scrollY ?? 0);
    return {
      entries: [entryWithId],
      index: 0,
    };
  });

  const historyStateRef = useRef<HistoryState>(historyState);
  historyStateRef.current = historyState;

  const { entries, index } = historyState;
  const rawCurrent = entries[index] || entries[0];

  const currentEntry = useMemo(() => {
    const savedY = scrollMapRef.current.get(rawCurrent.id) ?? rawCurrent.scrollY ?? 0;
    return {
      ...rawCurrent,
      scrollY: savedY,
    };
  }, [rawCurrent]);

  const canGoBack = index > 0;
  const backEntry = canGoBack ? entries[index - 1] : null;
  const backTitle = backEntry ? backEntry.title : null;

  const canGoForward = index < entries.length - 1;
  const forwardEntry = canGoForward ? entries[index + 1] : null;
  const forwardTitle = forwardEntry ? forwardEntry.title : null;

  const saveCurrentScroll = useCallback((scrollY: number) => {
    const cur = historyStateRef.current.entries[historyStateRef.current.index];
    if (cur) {
      setBoundedScrollEntry(scrollMapRef.current, cur.id, scrollY);
      if (cur.view === 'grid' && !cur.activeFilter && !cur.activeGroupId) {
        lastAllGamesScrollY.current = scrollY;
      }
    }
  }, []);

  const pushEntry = useCallback(
    (entry: Omit<NavHistoryEntry, 'id'> & { id?: string }) => {
      const currentScroll = getCurrentScroll ? getCurrentScroll() : 0;
      const prev = historyStateRef.current;
      const current = prev.entries[prev.index];
      if (current) {
        setBoundedScrollEntry(scrollMapRef.current, current.id, currentScroll);
        if (current.view === 'grid' && !current.activeFilter && !current.activeGroupId) {
          lastAllGamesScrollY.current = currentScroll;
        }
      }

      // Do not push identical consecutive state
      if (
        current &&
        current.view === entry.view &&
        current.selectedGameId === entry.selectedGameId &&
        current.activeGroupId === entry.activeGroupId &&
        current.activeFilter?.type === entry.activeFilter?.type &&
        current.activeFilter?.value === entry.activeFilter?.value
      ) {
        return;
      }

      const entryWithId: NavHistoryEntry = {
        ...entry,
        id: entry.id || createNavEntryId(),
        scrollY: entry.scrollY ?? 0,
      };
      setBoundedScrollEntry(scrollMapRef.current, entryWithId.id, entryWithId.scrollY ?? 0);

      const truncated = prev.entries.slice(0, prev.index + 1);
      if (truncated.length > 0) {
        truncated[truncated.length - 1] = {
          ...truncated[truncated.length - 1],
          scrollY: currentScroll,
        };
      }

      const nextEntries = [...truncated, entryWithId];
      const clampedEntries =
        nextEntries.length > 50 ? nextEntries.slice(nextEntries.length - 50) : nextEntries;
      const nextState: HistoryState = {
        entries: clampedEntries,
        index: clampedEntries.length - 1,
      };
      historyStateRef.current = nextState;
      setHistoryState(nextState);
    },
    [getCurrentScroll]
  );

  const goBack = useCallback(() => {
    const currentScroll = getCurrentScroll ? getCurrentScroll() : 0;
    const prev = historyStateRef.current;
    if (prev.index <= 0) return;
    const current = prev.entries[prev.index];
    if (current) {
      setBoundedScrollEntry(scrollMapRef.current, current.id, currentScroll);
    }
    const updatedEntries = [...prev.entries];
    updatedEntries[prev.index] = {
      ...current,
      scrollY: currentScroll,
    };
    const nextState: HistoryState = {
      entries: updatedEntries,
      index: prev.index - 1,
    };
    historyStateRef.current = nextState;
    setHistoryState(nextState);
  }, [getCurrentScroll]);

  const goForward = useCallback(() => {
    const currentScroll = getCurrentScroll ? getCurrentScroll() : 0;
    const prev = historyStateRef.current;
    if (prev.index >= prev.entries.length - 1) return;
    const current = prev.entries[prev.index];
    if (current) {
      setBoundedScrollEntry(scrollMapRef.current, current.id, currentScroll);
    }
    const updatedEntries = [...prev.entries];
    updatedEntries[prev.index] = {
      ...current,
      scrollY: currentScroll,
    };
    const nextState: HistoryState = {
      entries: updatedEntries,
      index: prev.index + 1,
    };
    historyStateRef.current = nextState;
    setHistoryState(nextState);
  }, [getCurrentScroll]);

  // Global keyboard shortcuts (Alt+Left / Cmd+[, Alt+Right / Cmd+], Backspace) and mouse buttons (3 & 4)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || hasOpenModalDialog()) return;

      const activeEl = document.activeElement;
      const isInput =
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.tagName === 'SELECT' ||
          (activeEl as HTMLElement).isContentEditable);

      if (isInput) return;

      // Back: Alt + Left or Cmd + [
      if ((e.altKey && e.key === 'ArrowLeft') || (e.metaKey && e.key === '[')) {
        if (canGoBack) {
          e.preventDefault();
          goBack();
        }
      }
      // Forward: Alt + Right or Cmd + ]
      else if ((e.altKey && e.key === 'ArrowRight') || (e.metaKey && e.key === ']')) {
        if (canGoForward) {
          e.preventDefault();
          goForward();
        }
      }
      // Backspace (only when not editing an input)
      else if (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (canGoBack) {
          e.preventDefault();
          goBack();
        }
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (hasOpenModalDialog()) return;
      if (e.button === 3) {
        // Browser/Mouse Back button
        if (canGoBack) {
          e.preventDefault();
          goBack();
        }
      } else if (e.button === 4) {
        // Browser/Mouse Forward button
        if (canGoForward) {
          e.preventDefault();
          goForward();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [canGoBack, canGoForward, goBack, goForward]);

  const getLastAllGamesScrollY = useCallback(() => {
    return lastAllGamesScrollY.current;
  }, []);

  return {
    currentEntry,
    canGoBack,
    backTitle,
    canGoForward,
    forwardTitle,
    pushEntry,
    goBack,
    goForward,
    saveCurrentScroll,
    getLastAllGamesScrollY,
  };
}
