import { reportError } from "./errorReporting";

export interface Contract {
  id: string;
  title: string;
  description?: string;
  status: "draft" | "active" | "completed" | "cancelled";
  amount?: number;
  currency?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export class ContractsApiError extends Error {
  readonly kind: "network" | "http" | "parse" | "not-found" | "aborted";
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    kind: ContractsApiError["kind"],
    options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ContractsApiError";
    this.kind = kind;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export interface FetchContractOptions {
  /** Abort signal for concurrent/stale requests. */
  signal?: AbortSignal;
  /** Number of additional retries for retryable failures. */
  retries?: number;
  /** Base delay between retries in ms. */
  retryDelayMs?: number;
  /** Injectable fetch for testing. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for testing. */
  sleep?: (ms: number) => Promise<void>;
  /** Correlation id for observability. */
  correlationId?: string;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 4000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string; name?: string }).code !== undefined &&
    ((error as { code?: string }).code === "ABORT_ERROR" ||
      (error as { name?: string }).name === "AbortError")
  );
}

function computeBackoff(attempt: number, baseDelayMs: number): number {
  // Deterministic exponential backoff (no jitter) so retries are reproducible.
  const delay = baseDelayMs * 2 ** attempt;
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

function buildUrl(id: string): string {
  const base =
    (typeof process !== "undefined" &&
      process.env &&
      (process.env.NEXT_PUBLIC_CONTRACTS_API_BASE_URL || process.env.CONTRACTS_API_BASE_URL)) ||
    "/api";
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/contracts/${encodeURIComponent(id)}`;
}

function validateId(id: unknown): string {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new ContractsApiError("Contract id must be a non-empty string", "http", {
      status: 400,
      retryable: false,
    });
  }
  return id.trim();
}

function isContract(value: unknown): value is Contract {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.title === "string" &&
    typeof candidate.status === "string"
  );
}

async function fetchContractOnce(
  id: string,
  options: FetchContractOptions,
): Promise<Contract> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = buildUrl(id);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: options.signal,
      credentials: "same-origin",
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new ContractsApiError("Request aborted", "aborted", {
        retryable: false,
        cause: error,
      });
    }
    throw new ContractsApiError("Network request failed", "network", {
      retryable: true,
      cause: error,
    });
  }

  if (response.status === 404) {
    throw new ContractsApiError("Contract not found", "not-found", {
      status: 404,
      retryable: false,
    });
  }

  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 429;
    throw new ContractsApiError(
      `Failed to load contract (${response.status})`,
      "http",
      { status: response.status, retryable },
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    throw new ContractsApiError("Malformed contract response", "parse", {
      status: response.status,
      retryable: false,
      cause: error,
    });
  }

  if (!isContract(parsed)) {
    throw new ContractsApiError("Contract payload failed validation", "parse", {
      status: response.status,
      retryable: false,
    });
  }

  if (parsed.id !== id) {
    // Defensive: mismatched id means the response is not trustworthy.
    throw new ContractsApiError("Contract id mismatch in response", "parse", {
      status: response.status,
      retryable: false,
    });
  }

  return parsed as Contract;
}

/**
 * Fetches a contract by id with deterministic retry behavior.
 *
 * Invariants:
 *  - Only retryable errors are retried; validation, 404, and aborts fail fast.
 *  - Aborts propagate immediately and are never retried.
 *  - Retries use deterministic exponential backoff (no jitter).
 *  - The attempt count is bounded by `options.retries`.
 */
export async function fetchContract(
  id: string,
  options: FetchContractOptions = {},
): Promise<Contract> {
  const normalizedId = validateId(id);
  const maxRetries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const baseDelay = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown = new ContractsApiError(
    "Unknown contracts API failure",
    "network",
    { retryable: true },
  );

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (options.signal?.aborted) {
      throw new ContractsApiError("Request aborted", "aborted", {
        retryable: false,
      });
    }

    try {
      return await fetchContractOnce(normalizedId, options);
    } catch (error) {
      lastError = error;
      const apiError =
        error instanceof ContractsApiError ? error : undefined;

      if (apiError && !apiError.retryable) {
        throw apiError;
      }

      if (attempt === maxRetries) {
        break;
      }

      const delay = computeBackoff(attempt, baseDelay);
      if (delay > 0) {
        await sleep(delay);
      }
    }
  }

  reportError(lastError, {
    operation: "contracts.fetchContract",
    correlationId: options.correlationId,
    metadata: { id: normalizedId, retries: maxRetries },
  }, "error");

  throw lastError instanceof ContractsApiError
    ? lastError
    : new ContractsApiError("Contract load failed", "network", { retryable: true });
}
