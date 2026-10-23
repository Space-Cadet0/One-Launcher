let activeModalOverlayCount = 0;

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

export function acquireModalOverlayLock(): () => void {
  activeModalOverlayCount += 1;
  if (activeModalOverlayCount === 1) {
    if (canPortalModalToBody()) {
      document.documentElement?.setAttribute('data-modal-overlay-open', 'true');
      const rootEl = document.getElementById('root');
      if (rootEl) {
        rootEl.setAttribute('inert', '');
      }
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(
          new CustomEvent('antigravity:modal-overlay-changed', {
            detail: { isOpen: true },
          })
        );
      } catch {}
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeModalOverlayCount = Math.max(0, activeModalOverlayCount - 1);
    if (activeModalOverlayCount === 0) {
      if (canPortalModalToBody()) {
        document.documentElement?.removeAttribute('data-modal-overlay-open');
        const rootEl = document.getElementById('root');
        if (rootEl) {
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
        } catch {}
      }
    }
  };
}
