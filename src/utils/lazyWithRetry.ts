import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

type LazyLoader = Parameters<typeof lazy>[0];

/**
 * Robust retry wrapper around React.lazy for resilient chunk loading.
 * Automatically retries failed dynamic imports with linear backoff,
 * and un-poisons React 19's cached rejection payload upon exhaustion so subsequent
 * remounts or modal reopenings attempt a fresh dynamic fetch rather than failing permanently.
 *
 * Layer 0 utility: Zero dependencies on domain/launcher layers, zero `any` keywords.
 */
export function lazyWithRetry<L extends LazyLoader>(
  factory: L,
  retries = 2,
  intervalMs = 500
): L extends () => Promise<{ default: infer T }>
  ? T extends ComponentType<infer P>
    ? LazyExoticComponent<ComponentType<P>>
    : ReturnType<typeof lazy>
  : ReturnType<typeof lazy> {
  let activeLazyComponent: ReturnType<typeof lazy> | null = null;

  const createCtor = (): Parameters<typeof lazy>[0] => {
    return () =>
      new Promise((resolve, reject) => {
        function attempt(remaining: number): void {
          Promise.resolve()
            .then(() => factory())
            .then(resolve)
            .catch((err: unknown) => {
              if (remaining <= 0) {
                // When retries are exhausted, schedule un-poisoning of the React.lazy payload
                // so subsequent remounts or modal reopenings make a fresh attempt rather than
                // permanently failing with the cached rejection.
                if (
                  activeLazyComponent &&
                  typeof activeLazyComponent === 'object' &&
                  '_payload' in activeLazyComponent
                ) {
                  const payload = (
                    activeLazyComponent as unknown as {
                      _payload: { _status?: number; _result?: unknown };
                    }
                  )._payload;
                  if (payload) {
                    setTimeout(() => {
                      if (payload._status === 2) {
                        payload._status = -1;
                        payload._result = createCtor();
                      }
                    }, 0);
                  }
                }
                reject(err);
                return;
              }
              setTimeout(() => attempt(remaining - 1), intervalMs);
            });
        }
        attempt(retries);
      }) as ReturnType<L>;
  };

  activeLazyComponent = lazy(createCtor());
  return activeLazyComponent as L extends () => Promise<{ default: infer T }>
    ? T extends ComponentType<infer P>
      ? LazyExoticComponent<ComponentType<P>>
      : ReturnType<typeof lazy>
    : ReturnType<typeof lazy>;
}
