/**
 * Timer-safe and AbortSignal-safe asynchronous primitives.
 * Guarantees every scheduled timer and abort listener is cleaned up on settle.
 */

export class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const message =
    typeof reason === 'string' && reason.trim() ? reason : 'The operation was aborted.';
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/**
 * Awaits `promise` up to `timeoutMs` milliseconds, rejecting with a `TimeoutError`
 * (or the custom `Error` returned by `messageOrFactory`) if the deadline expires first.
 *
 * Always clears the timer in `finally` to prevent leaked timer handles.
 */
export async function withTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  messageOrFactory?: string | (() => Error)
): Promise<T> {
  if (timeoutMs === Infinity) {
    return await promise;
  }

  const effectiveMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 0;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error =
        typeof messageOrFactory === 'function'
          ? messageOrFactory()
          : new TimeoutError(
              messageOrFactory ?? `Operation timed out after ${effectiveMs}ms`,
              effectiveMs
            );
      reject(error);
    }, effectiveMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Timer-safe timeout wrapper that resolves to `fallback` when `promise` does not settle
 * within `timeoutMs` milliseconds or rejects. Always clears the timeout handle in `finally`.
 */
export async function withTimeoutFallback<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  if (timeoutMs === Infinity) {
    try {
      return await promise;
    } catch {
      return fallback;
    }
  }

  const effectiveMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 0;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), effectiveMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } catch {
    return fallback;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Sleeps for `ms` milliseconds while respecting an optional `AbortSignal`.
 * Cleans up both the timer and the abort event listener upon completion or cancellation.
 */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError(signal.reason));
  }

  const effectiveMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  if (effectiveMs === 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      reject(createAbortError(signal?.reason));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => {
      timer = undefined;
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, effectiveMs);
  });
}
