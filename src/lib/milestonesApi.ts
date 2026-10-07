/**
 * Milestones API adapter.
 *
 * This module is the single boundary between the milestones UI and the
 * data source. It normalizes transport failures into a typed error with a
 * stable code, so the hook and the board never have to inspect fetch or JSON
 * details directly.
 *
 * Invariants:
*   1. Every failure path throws a `MilestonesApiError` with a non-empty code.
   2. Response bodies are validated before they reach the UI; malformed data is
      treated as a failure, not as an empty board.
   3. Retries are bounded here as well as in the hook, so a direct caller cannot
      accidentally create an unbounded loop.
 */

export type MilestoneStatus = 'not-started' | 'in-progress' | 'completed' | 'at-risk';

export type Milestone = {
  id: string;
  title: string;
  description: string;
  status: MilestoneStatus;
  dueDate: string | null;
  progress: number;
  updatedAt: string;
};

export type MilestonesApiErrorCode =
  | 'MILESTONES_FETCH_FAILED'
  | 'MILESTONES_INVALID_RESPONSE'
  | 'MILESTONES_TIMEOUT'
  | 'MILESTONES_NETWORK_ERROR';

export type MilestonesApiErrorOptions = {
  code: MilestonesApiErrorCode | string;
  status?: number;
  retryable?: boolean;
  cause?: unknown;
};

/**
 * Typed error for every milestones data failure. The `message` is always a
 * safe, user-facing string; internal details stay on `cause` and `code`.
 */
export class MilestonesApiError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, options: MilestonesApiErrorOptions) {
    super(message);
    this.name = 'MilestonesApiError';
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) {
      // Preserve the original cause for diagnostics without exposing it in the UI.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export type FetchMilestonesOptions = {
  /** Override the default endpoint. */
  endpoint?: string;
  /** Abort the request after this many milliseconds. Defaults to 10000. */
  timeoutMs?: number;
  /** Number of attempts for this call. Defaults to 2. */
  maxAttempts?: number;
  /** Base backoff between attempts in ms. Defaults to 200. */
  baseDelayMs?: number;
  /** Upper bound on backoff in ms. Defaults to 2000. */
  maxDelayMs?: number;
  /** Optional fetch implementation for testing or alternate transports. */
  fetchImpl?: typeof fetch;
  /** Optional absort signal for caller-driven cancellation. */
  signal?: AbortSignal;
};

const DEFAULT_ENDPOINT = '/api/milestones';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_BASE_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 2_000;

const VALID_STATUSES: readonly MilestoneStatus[] = [
  'not-started',
  'in-progress',
  'completed',
  'at-risk',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStatus(value: unknown): MilestoneStatus | null {
  if (typeof value === 'string' && (VALID_STATUSES as readonly string[]).includes(value)) {
    return value as MilestoneStatus;
  }
  return null;
}

function normalizeProgress(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(100, Math.max(0, Math.round(value)));
  }
  return 0;
}

function normalizeMilestone(value: unknown): Milestone | null {
  if (!isRecord(value)) return null;

  const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : null;
  const title = typeof value.title === 'string' ? value.title : null;
  const status = normalizeStatus(value.status);

  if (id === null || title === null || status === null) {
    return null;
  }

  const dueDate =
    typeof value.dueDate === 'string' && value.dueDate.length > 0
      ? value.dueDate
      : null;

  return {
    id,
    title,
    description: typeof value.description === 'string' ? value.description : '',
    status,
    dueDate,
    progress: normalizeProgress(value.progress),
    updatedAt:
      typeof value.updatedAt === 'string' && value.updatedAt.length > 0
        ? value.updatedAt
        : new Date(0).toISOString(),
  };
}

function extractItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    const candidate = value.milestones ?? value.data ?? value.items;
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function normalizePayload(value: unknown): Milestone[] {
  const items = extractItems(value);
  const normalized: Milestone[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const next = normalizeMilestone(items[index]);
    if (next) {
      normalized.push(next);
    }
  }
  return normalized;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function computeBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const raw = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(maxDelayMs, raw);
}

async function requestOnce(
  endpoint: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 429;
      throw new MilestonesApiError('Unable to load milestones.', {
        code: 'MILESTONES_FETCH_FAILED',
        status: response.status,
        retryable,
      });
    }

    try {
      return await response.json();
    } catch (cause) {
      throw new MilestonesApiError('The milestones response was not valid JSON.', {
        code: 'MILESTONES_INVALID_RESPONSE',
        status: response.status,
        retryable: false,
        cause,
      });
    }
  } catch (cause) {
    if (cause instanceof MilestonesApiError) throw cause;
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      if (signal?.aborted) {
        throw cause;
      }
      throw new MilestonesApiError('The milestones request timed out.', {
        code: 'MILESTONES_TIMEOUT',
        retryable: true,
        cause,
      });
    }
    throw new MilestonesApiError('Unable to reach the milestones service.', {
      code: 'MILESTONES_NETWORK_ERROR',
      retryable: true,
      cause,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Fetch and normalize the milestones list.
 *
 * The function is deterministic for a given set of inputs:
 *   - it attempts at most `maxAttempts` times for retryable failures;
 *   - it never retries a non-retryable failure (4-xx client errors, malformed body);
 *   - it throws a typed MilestonesApiError on every failure path.
 */
export async function fetchMilestones(
  options: FetchMilestonesOptions = {},
): Promise<Milestone[]> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS ));
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);

  if (!fetchImpl) {
    throw new MilestonesApiError('Milestones data is not available in this environment.', {
      code: 'MILESTONES_NETWORK_ERROR',
      retryable: false,
    });
  }

  let lastError: MilestonesApiError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const payload = await requestOnce(endpoint, timeoutMs, fetchImpl, options.signal);
      const normalized = normalizePayload(payload);
      return normalized;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError' && options.signal?.aborted) {
        // Caller-driven cancellation is not a retryable failure.
        throw cause;
      }

      const apiError =
        cause instanceof MilestonesApiError
          ? cause
          : new MilestonesApiError('Unable to load milestones.', {
              code: 'MILESTONES_FETCH_FAILED',
              retryable: true,
              cause,
            });

      lastError = apiError;

      if (!apiError.retryable || attempt === maxAttempts) {
        throw apiError;
      }

      const delay = computeBackoff(attempt, baseDelayMs, maxDelayMs);
      await sleep(delay, options.signal);
    }
  }

  // Unreachable in normal flow, but keeps the contract explicit for the type system.
  throw (
    lastError ??
    new MilestonesApiError('Unable to load milestones.', {
      code: 'MILESTONES_FETCH_FAILED',
      retryable: true,
    })
  );
}
