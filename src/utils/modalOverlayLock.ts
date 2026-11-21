let activeModalOverlayCount = 0;
let lockGeneration = 0;

export function canPortalModalToBody(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof HTMLElement !== 'undefined' &&
    Boolean(document.body) &&
    document.body instanceof HTMLElement
  );
}

/**
 * Checks whether any modal dialog or shell is actively open in the DOM.
 * If activeModalOverlayCount leaked (e.g. from an uncaught error in a child dialog),
 * triggers self-healing reset to restore DOM interactivity.
 */
export function checkModalOverlaySelfHealing(): boolean {
  if (
    activeModalOverlayCount > 0 &&
    typeof document !== 'undefined' &&
    typeof document.querySelectorAll === 'function'
  ) {
    const openModals = document.querySelectorAll(
      'dialog[open], [data-modal-shell="true"], [data-modal-open="true"]'
    );
    if (openModals.length === 0) {
      emergencyResetModalOverlayLock();
      return false;
    }
  }
  return activeModalOverlayCount > 0;
}

export function isModalOverlayOpen(): boolean {
  checkModalOverlaySelfHealing();
  return activeModalOverlayCount > 0;
}

/**
 * Emergency reset to clear `data-modal-overlay-open`, invalidate any stale
 * `release()` closures from earlier modal lifecycles, and defensively clear any
 * stray `#root[inert]` attribute in case an unhandled crash aborted unmount cleanup.
 */
export function emergencyResetModalOverlayLock(): void {
  lockGeneration += 1;
  activeModalOverlayCount = 0;
  if (typeof document !== 'undefined') {
    if (document.documentElement?.removeAttribute) {
      document.documentElement.removeAttribute('data-modal-overlay-open');
    }
    const rootEl = document.getElementById?.('root');
    if (rootEl && typeof rootEl.removeAttribute === 'function') {
      rootEl.removeAttribute('inert');
    }
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(
        new CustomEvent('antigravity:modal-overlay-changed', {
          detail: { isOpen: false },
        })
      );
    } catch {
      // Ignore CustomEvent dispatch errors in restricted test environments
    }
  }
}

/**
 * Tracks active modal overlay count and broadcasts `antigravity:modal-overlay-changed`
 * so background trailer players, warmup jobs, and drag regions react cleanly while
 * a modal is open.
 *
 * Intentionally does NOT set `#root[inert]`: native `<dialog>.showModal()` already
 * places modals in the top layer and makes outside DOM inert while guaranteeing
 * browser focus restoration back to the invoker on `dialog.close()`.
 */
export function acquireModalOverlayLock(): () => void {
  const acquiredGeneration = lockGeneration;
  activeModalOverlayCount += 1;
  if (activeModalOverlayCount === 1) {
    if (typeof document !== 'undefined' && document.documentElement?.setAttribute) {
      document.documentElement.setAttribute('data-modal-overlay-open', 'true');
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(
          new CustomEvent('antigravity:modal-overlay-changed', {
            detail: { isOpen: true },
          })
        );
      } catch {
        // Ignore CustomEvent dispatch errors in restricted test environments
      }
    }
  }

  let released = false;
  return () => {
    if (released || acquiredGeneration !== lockGeneration) return;
    released = true;
    activeModalOverlayCount = Math.max(0, activeModalOverlayCount - 1);
    if (activeModalOverlayCount === 0) {
      if (typeof document !== 'undefined' && document.documentElement?.removeAttribute) {
        document.documentElement.removeAttribute('data-modal-overlay-open');
      }
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try {
          window.dispatchEvent(
            new CustomEvent('antigravity:modal-overlay-changed', {
              detail: { isOpen: false },
            })
          );
        } catch {
          // Ignore CustomEvent dispatch errors in restricted test environments
        }
      }
    }
  };
}
