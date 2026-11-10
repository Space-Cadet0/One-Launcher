/**
 * IME-safe keyboard utilities following modern-web-guidance (`ime-safe-enter-submit`).
 *
 * Prevents premature Enter actions while an Input Method Editor (Japanese, Chinese,
 * Korean, etc.) is actively confirming character conversion candidates, including
 * WebKit's out-of-order `compositionend` -> `keydown` (`keyCode === 229`) sequence.
 */
export interface ComposableKeyboardEventLike {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
}

export function isImeComposing(event: ComposableKeyboardEventLike | null | undefined): boolean {
  if (!event) return false;
  return Boolean(
    event.nativeEvent?.isComposing ||
      event.isComposing ||
      event.nativeEvent?.keyCode === 229 ||
      event.keyCode === 229
  );
}
