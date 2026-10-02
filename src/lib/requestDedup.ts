/**
 * Duplicate-request deduplication + in-flight concurrency control.
 *
 * Invariants:
 * -  Concurrent calls with the same key share a single in-flight promise.
 * -  A settled entry is always removed from the map (no stale cache, no leaks).
 * -  Callers observe a consistent result even if the underlying work rejects.
 * -  Aborting one caller does not corrupt the shared promise for others.
 */

export interface DedupOptions {
  /** Optional external abort signal. Aborting it only affects this caller. */
  signal?: AbortSignal;
  /** Optional timeout in milliseconds. 0/$undefined disables it. */
  timeoutMs?: number;
}

export class RequestAbortedError extends Error {
  readonly code = 'ER_REQUEST_ABORTED' as const;

  constructor(message = 'Request aborted') {
    super(message);
    this.name = 'RequestAbortedError';
  }
}

export class RequestTimeoutError extends Error {
  readonly code = 'ER_REQUEST_TIMEOUT' as const;

  constructor(message = 'Request timed out') {
    super(message);
    this.name = 'RequestTimeoutError';
  }
}

export interface InFlightEntry<T> {
  promise: Promise<T>;
  controller: AbortController;
  refs: number;
}

/**
 * A small, deterministic in-flight registry.
 *
 * The registry is intentionally framework-agnostic and has no global mutable
 * singleton by itself; callers create one instance and share it.
 */
export class RequestDeduper {
  private readonly inFlight = new Map<string, InFlightEntry<unknown>>();

  /** Number of currently in-flight requests. Useful for tests/metrics. */
  get size(): number {
    return this.inFlight.size;
  }

  has(key: string): boolean {
    return this.inFlight.has(key);
  }

  /**
   * Run `task` under `dedupKey`. Concurrent calls with the same key share the
   * in-flight promise. The first caller owns the underlying `fetch`; later
   * callers attach to the same promise but may add their own abort/signal
   * observation without affecting others.
   */
  async run<T>(
    dedupKey: string,
    task: (signal: AbortSignal) => Promise<T>,
    options: DedupOptions = {},
  ): Promise<T> {
    const existing = this.inFlight.get(dedupKey) as InFlightEntry<T> | undefined;

    if (existing) {
      existing.refs += 1;
      return this.awaitWithSignal(existing.promise, options);
    }

    const controller = new AbortController();
    const entry: InFlightEntry<T> = {
      promise: Promise.resolve() as unknown as Promise<T>,
      controller,
      refs: 1,
    };

    const runPromise = (async () => {
      try {
        return await task(controller.signal);
      } finally {
        // Always release the in-flight slot on settlement so retries are fresh.
        if (this.inFlight.get(dedupKey) === entry) {
          this.inFlight.delete(dedupKey);
        }
      }
    })();

    entry.promise = runPromise;
    this.inFlight.set(dedupKey, entry as InFlightEntry<unknown>);

    return this.awaitWithSignal(runPromise, options);
  }

  /**
   * Await a promise while respecting an optional caller-scoped abort signal and
   * timeout. The shared promise is never cancelled by an individual caller.
   */
  private awaitWithSignal<T>(promise: Promise<T>, options: DedupOptions): Promise<T> {
    const { signal, timeoutMs } = options;

    if (!signal && !timeoutMs) {
      return promise;
    }

    return new Promise<T>((resolve, reject) => {
      let timerId: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const cleanup = () => {
        if (timerId !== undefined) {
          clearTimeout(timerId);
          timerId = undefined;
        }
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new RequestAbortedError());
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      if (timeoutMs && timeoutMs > 0) {
        timerId = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new RequestTimeoutError());
        }, timeoutMs);
      }

      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    });
  }

  /** Abort the shared in-flight request for a key, if any. */
  abort(key: string): void {
    const entry = this.inFlight.get(key);
    if (entry) {
      entry.controller.abort();
    }
  }

  /** Abort every in-flight request. */
  abortAll(): void {
    for (const entry of this.inFlight.values()) {
      entry.controller.abort();
    }
  }
}

/** Process-wide shared deduper for app code. */
export const requestDeduper = new RequestDeduper();
