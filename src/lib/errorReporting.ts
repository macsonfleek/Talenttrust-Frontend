/**
 * Centralized error reporting for contract data loading.
 *
 * Invariants:
 *  - Reported payloads MUST not contain PCI/PII or auth tokens.
 *  - Reporting must never throw; failures are swallowed and logged locally.
 *  - Every report is deterministic given the same input (no random IDs, no time-based dedupe keys).
 */

export type ErrorSeverity = "debug" | "info" | "warning" | "error" | "fatal";

export interface ErrorContext {
  /** Stable identifier for the operation, e.g. "contracts.fetchById". */
  operation: string;
  /** Correlation id for the user session / request chain. */
  correlationId?: string;
  /** Non-sensitive metadata only. */
  metadata?: Record<string, unknown>;
}

export interface ErrorReport {
  operation: string;
  severity: ErrorSeverity;
  message: string;
  code?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export type ErrorSink = (report: ErrorReport) => void;

const SENSITIVE_KEYS = [
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "authorization",
  "cookie",
  "secret",
  "apiKey",
  "cardNumber",
  "cvc",
  "ssn",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error)
  );
}

/**
 * Recursively redacts sensitive keys from arbitrary metadata.
 * Exported for testing.
 */
export function redactSensitive(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value as object)) {
    return "[Circular]";
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry, seen));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEYS.some((k) => k.toLowerCase() === key.toLowerCase())) {
      out[key] = "[Redacted]";
    } else {
      out[key] = redactSensitive(entry, seen);
    }
  }
  return out;
}

function normalizeError(error: unknown): { message: string; code?: string } {
  if (error instanceof Error) {
    const code = "status" in error ? String() : undefined;
    return { message: error.message || error.name, code };
  }
  if (typeof error === "string") {
    return { message: error };
  }
  try {
    return { message: JSON.stringify(redactSensitive(error)) };
  } catch {
    return { message: "Unknown error" };
  }
}

const sinks: ErrorSink [] = [];

/**
 * Registers a sink (logger, metrics client, etc). Returns an unsubscribe function.
 * Sinks are invoked in registration order for determinism.
 */
export function addErrorSink(sink: ErrorSink): () => void {
  sinks.push(sink);
  return () => {
    const idx = sinks.indexOf(sink);
    if (idx >= 0) sinks.splice(idx, 1);
  };
}

/** Test-only helper to reset sinks between cases. */
export function __resetErrorSinksForTests(): void {
  sinks.length = 0;
}

export function reportError(
  error: unknown,
  context: ErrorContext,
  severity: ErrorSeverity = "error",
): ErrorReport {
  const normalized = normalizeError(error);
  const report: ErrorReport = {
    operation: context.operation,
    severity,
    message: normalized.message,
    code: normalized.code,
    correlationId: context.correlationId,
    metadata: context.metadata
      ? (redactSensitive(context.metadata) as Record<string, unknown>)
      : undefined,
    timestamp: new Date().toISOString(),
  };

  for (const sink of sinks) {
    try {
      sink(report);
    } catch {
      // Error reporting must never crash the caller.
    }
  }

  return report;
}
