let activeModalOverlayCount = 0;
let lockedRootWithInert = false;

export function canPortalModalToBody(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof HTMLElement !== 'undefined' &&
    Boolean(document.body) &&
    document.body instanceof HTMLElement
  );
}

export function isModalOverlayOpen(): boolean {
  return activeModalOverlayCount > 0;
}

/**
 * Tracks active modal overlay count and broadcasts `antigravity:modal-overlay-changed`
 * so background trailer players can pause while a modal is open.
 *
 * Only marks `#root` inert when `canPortalModalToBody()` is `true` (meaning modals
 * portal onto `document.body` outside `#root`), preventing any inline `#root[inert]`
 * focus deadlock while preserving background inertness for portaled overlays.
 */
export function acquireModalOverlayLock(): () => void {
  activeModalOverlayCount += 1;
  if (activeModalOverlayCount === 1) {
    if (typeof document !== 'undefined' && document.documentElement?.setAttribute) {
      document.documentElement.setAttribute('data-modal-overlay-open', 'true');
    }
    if (canPortalModalToBody() && typeof document.getElementById === 'function') {
      const rootEl = document.getElementById('root');
      if (rootEl && typeof rootEl.setAttribute === 'function') {
        rootEl.setAttribute('inert', '');
        lockedRootWithInert = true;
      }
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
    if (released) return;
    released = true;
    activeModalOverlayCount = Math.max(0, activeModalOverlayCount - 1);
    if (activeModalOverlayCount === 0) {
      if (typeof document !== 'undefined' && document.documentElement?.removeAttribute) {
        document.documentElement.removeAttribute('data-modal-overlay-open');
      }
      if (
        lockedRootWithInert &&
        typeof document !== 'undefined' &&
        typeof document.getElementById === 'function'
      ) {
        const rootEl = document.getElementById('root');
        if (rootEl && typeof rootEl.removeAttribute === 'function') {
          rootEl.removeAttribute('inert');
        }
      }
      lockedRootWithInert = false;
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
