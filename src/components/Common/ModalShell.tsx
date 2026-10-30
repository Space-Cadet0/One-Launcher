import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { acquireModalOverlayLock, canPortalModalToBody } from '../../utils/modalOverlayLock';
import { useIsRealClientRenderer } from '../../utils/useSafeId';

export interface ModalShellProps {
  isOpen: boolean;
  onClose: () => void;
  preventClose?: boolean;
  ariaLabelledBy?: string;
  ariaLabel?: string;
  className?: string;
  testId?: string;
  closeOnBackdrop?: boolean;
  lockOverlay?: boolean;
  children: React.ReactNode;
}

/**
 * Native HTML `<dialog>` Top-Layer modal container following modern-web-guidance:
 * - Calls `dialog.showModal()` so the browser places the modal in the Top Layer,
 *   traps Tab focus natively, makes background content inert without mutating
 *   `#root.inert`, and restores focus to the invoker automatically on close.
 * - Guards `close` and `cancel` listeners with `e.target === dialog` so nested
 *   pickers/popovers/selects firing `close`/`cancel` never dismiss the parent modal.
 * - Honors `preventClose` on both native `cancel` (`Escape`) and backdrop interactions.
 * - Uses pointer-origin verification (`onPointerDown` + `onClick`) so text-selection
 *   drags starting inside the modal and releasing on the backdrop never dismiss it.
 */
export const ModalShell: React.FC<ModalShellProps> = ({
  isOpen,
  onClose,
  preventClose = false,
  ariaLabelledBy,
  ariaLabel,
  className = '',
  testId,
  closeOnBackdrop = true,
  lockOverlay = true,
  children,
}) => {
  // Keep dialogRef at hook slot 0 for unit-test harness compatibility
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const preventCloseRef = useRef(preventClose);
  preventCloseRef.current = preventClose;
  const pointerStartedOnBackdropRef = useRef<boolean | null>(null);

  const isRealClientRenderer = useIsRealClientRenderer();
  const useDialogSyncEffect = isRealClientRenderer ? useLayoutEffect : useEffect;

  useEffect(() => {
    if (!isOpen || !lockOverlay) return undefined;
    return acquireModalOverlayLock();
  }, [isOpen, lockOverlay]);

  useDialogSyncEffect(() => {
    if (!isOpen) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) {
        try {
          dialog.showModal();
        } catch {
          dialog.setAttribute('open', '');
        }
      }
    } else {
      dialog.setAttribute('open', '');
    }

    const handleClose = (event?: Event) => {
      if (event && event.target && event.target !== dialog) return;
      onCloseRef.current();
    };
    const handleCancel = (event: Event) => {
      if (event && event.target && event.target !== dialog) return;
      event.preventDefault();
      if (preventCloseRef.current) return;
      onCloseRef.current();
    };

    dialog.addEventListener('close', handleClose);
    dialog.addEventListener('cancel', handleCancel);

    return () => {
      dialog.removeEventListener('close', handleClose);
      dialog.removeEventListener('cancel', handleCancel);
      if (dialog.open) {
        if (typeof dialog.close === 'function') {
          try {
            dialog.close();
          } catch {
            dialog.removeAttribute('open');
          }
        } else {
          dialog.removeAttribute('open');
        }
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleDialogPointerDown = (event: React.PointerEvent<HTMLDialogElement>) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    pointerStartedOnBackdropRef.current = event.target === dialog;
  };

  const handleDialogClick = (event: React.MouseEvent<HTMLDialogElement>) => {
    const startedOnBackdrop = pointerStartedOnBackdropRef.current;
    pointerStartedOnBackdropRef.current = null;

    if (preventClose || !closeOnBackdrop) return;
    if (startedOnBackdrop === false) return;

    const dialog = dialogRef.current;
    if (!dialog || event.target !== dialog) return;
    if (
      typeof HTMLDialogElement !== 'undefined' &&
      'closedBy' in HTMLDialogElement.prototype
    ) {
      return;
    }
    const rect = dialog.getBoundingClientRect();
    const isInDialog =
      rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width;
    if (!isInDialog) {
      if (typeof dialog.close === 'function' && dialog.open) {
        dialog.close();
      } else {
        onCloseRef.current();
      }
    }
  };

  const dialogExtraProps: Record<string, string | undefined> = {
    closedby: preventClose ? 'none' : closeOnBackdrop ? 'any' : 'closerequest',
  };

  const dialogNode = (
    <dialog
      ref={dialogRef}
      {...dialogExtraProps}
      aria-labelledby={ariaLabelledBy}
      aria-label={!ariaLabelledBy ? ariaLabel : undefined}
      data-testid={testId}
      onPointerDown={handleDialogPointerDown}
      onClick={handleDialogClick}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className={`ol-modal-dialog modal-shell app-no-drag ${className}`.trim()}
    >
      {children}
    </dialog>
  );

  const shouldPortal = canPortalModalToBody() && isRealClientRenderer;
  return shouldPortal ? createPortal(dialogNode, document.body) : dialogNode;
};
