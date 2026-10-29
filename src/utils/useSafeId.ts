import React from 'react';

let fallbackCounter = 0;

const subscribeNoop = (): (() => void) => () => {};
const getClientSnapshotTrue = (): boolean => true;
const getServerSnapshotFalse = (): boolean => false;

/**
 * Detects whether execution is inside a real React client renderer using only
 * React's public `useSyncExternalStore` hook (returns `false` under SSR or
 * minimal custom test dispatchers without inspecting React private internals).
 */
export function useIsRealClientRenderer(): boolean {
  try {
    return React.useSyncExternalStore(
      subscribeNoop,
      getClientSnapshotTrue,
      getServerSnapshotFalse
    );
  } catch {
    return false;
  }
}

/**
 * Defers high-frequency input updates via `React.useDeferredValue` while falling
 * back synchronously to `value` under minimal custom test dispatchers that omit
 * `useDeferredValue`.
 */
export function useSafeDeferredValue<T>(value: T): T {
  try {
    return React.useDeferredValue(value);
  } catch {
    return value;
  }
}

/**
 * Generates an accessible unique DOM ID using `React.useId()` with a
 * deterministic counter fallback when invoked outside a full React dispatcher.
 */
export function useSafeId(prefix: string): string {
  let fallbackRef: { current: string | null } | null = null;
  try {
    fallbackRef = React.useRef<string | null>(null);
  } catch {
    fallbackRef = null;
  }

  try {
    const reactId = React.useId();
    if (typeof reactId === 'string' && reactId.length > 0) {
      return `${prefix}-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    }
  } catch {
    // Minimal custom test dispatcher without useId — fall back to deterministic counter
  }

  if (fallbackRef) {
    if (!fallbackRef.current) {
      fallbackCounter += 1;
      fallbackRef.current = `${prefix}-${fallbackCounter}`;
    }
    return fallbackRef.current;
  }

  fallbackCounter += 1;
  return `${prefix}-${fallbackCounter}`;
}
