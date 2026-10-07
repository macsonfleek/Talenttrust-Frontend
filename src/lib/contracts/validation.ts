/**
 * Validation boundaries for contract route parameters and loading state.
 *
 * This module defines the canonical, deterministic validation rules used by
 * `src/app/contracts/[id]/loading.tsx` and any other consumer that needs to
 * decide whether a contract identifier is well-formed before fetching or
 * rendering data.
 *
 * Invariants:
 *   1. A contract id is either valid or invalid; there is no "partially
 *      valid" state. Consumers must never proceed with an invalid id.
 *   2. Validation is pure and deterministic: the same input always produces
 *      the same result, with no I/O, timers, or global mutable state.
 *   3. Validation never throws for any input; it returns a discriminated
 *      result so callers can handle rejection without try/catch.
 *   4. Duplicate ids are detected explicitly and reported as a distinct
 *      reason so the caller can surface an appropriate message.
 *   5. Boundary values (length limits, allowed characters) are enforced
 *      inclusively and documented in the constants below.
 */

/** Minimum accepted length for a contract id. */
export const CONTRACT_ID_MIN_LENGTH = 1;

/** Maximum accepted length for a contract id. */
export const CONTRACT_ID_MAX_LENGTH = 128;

/**
 * Compatibility alias for {@link CONTRACT_ID_MAX_LENGTH}.
 *
 * Two names for one bound existed after two validation designs were merged;
 * both are exported so neither caller breaks. They must stay equal — the
 * boundary tests assert against whichever name their call site uses.
 */
export const MAX_CONTRACT_ID_LENGTH = CONTRACT_ID_MAX_LENGTH;

/**
 * Allowed character set for contract ids. This is deliberately conservative:
 * lowercase letters, digits, hyphens, and underscores. This prevents path
 * traversal, encoding tricks, and accidental URI segment injection.
 */
export const CONTRACT_ID_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Reasons a contract identifier can be rejected.
 *
 * The reason is machine-readable (`reason`) while `message` stays safe to
 * render, so a caller can branch without parsing user-facing text.
 */
export type ContractIdValidationReason =
  | "empty"
  | "too_short"
  | "too_long"
  | "invalid_characters"
  | "duplicate";

export interface ContractIdValidationSuccess {
  readonly ok: true;
  readonly value: string;
}

/**
 * Machine-readable error codes for a rejected contract id.
 *
 * Compatibility surface: callers that compare against a closed enum (rather
 * than reading `reason`) use this. It is a one-to-one mapping of
 * {@link ContractIdValidationReason}, so the two can never disagree.
 */
export const ContractIdValidationError = {
  NOT_A_STRING: "NOT_A_STRING",
  EMPTY: "EMPTY",
  TOO_SHORT: "TOO_SHORT",
  TOO_LONG: "TOO_LONG",
  INVALID_CHARACTERS: "INVALID_CHARACTERS",
  DUPLICATE: "DUPLICATE",
} as const;

export type ContractIdValidationErrorCode =
  (typeof ContractIdValidationError)[keyof typeof ContractIdValidationError];

export interface ContractIdValidationFailure {
  readonly ok: false;
  readonly reason: ContractIdValidationReason;
  /** Same information as `reason`, in the enum form. */
  readonly error: ContractIdValidationErrorCode;
  readonly message: string;
}

export type ContractIdValidationResult =
  | ContractIdValidationSuccess
  | ContractIdValidationFailure;

export interface ValidateContractIdOptions {
  /** Ids already present in the current batch; used to detect duplicates. */
  readonly existingIds?: ReadonlyArray<string> | undefined;
}

/**
 * Maps a reason onto its enum code.
 *
 * Kept as one exhaustive `switch` so adding a reason without adding a code is a
 * compile error rather than a silently `undefined` `error` at runtime.
 */
function toErrorCode(reason: ContractIdValidationReason): ContractIdValidationErrorCode {
  switch (reason) {
    case "empty":
      return ContractIdValidationError.EMPTY;
    case "too_short":
      return ContractIdValidationError.TOO_SHORT;
    case "too_long":
      return ContractIdValidationError.TOO_LONG;
    case "invalid_characters":
      return ContractIdValidationError.INVALID_CHARACTERS;
    case "duplicate":
      return ContractIdValidationError.DUPLICATE;
  }
}

function fail(
  reason: ContractIdValidationReason,
  message: string,
): ContractIdValidationFailure {
  return { ok: false, reason, error: toErrorCode(reason), message };
}

/**
 * Normalizes a raw contract id for comparison without changing its case.
 *
 * Ids are case-sensitive, so only surrounding whitespace is removed. Returns an
 * empty string for non-string input so callers can compare against `""` without
 * a type check.
 */
export function normalizeContractId(rawId: unknown): string {
  return typeof rawId === "string" ? rawId.trim() : "";
}

/**
 * Validate a contract identifier against the canonical boundaries.
 *
 * The function is total: every string input produces a deterministic result,
 * and it never throws. Non-string inputs are treated as empty because the
 * route param is always a string at the boundary, but defensive callers
 * may pass `undefined` or `null`.
 */
export function validateContractId(
  rawId: unknown,
  options: ValidateContractIdOptions = {},
): ContractIdValidationResult {
  if (typeof rawId !== "string") {
    // Distinct from an empty id: the caller passed the wrong type entirely.
    return {
      ok: false,
      reason: "empty",
      error: ContractIdValidationError.NOT_A_STRING,
      message: "Contract id must be a string.",
    };
  }

  const id = rawId.trim();

  if (id.length < CONTRACT_ID_MIN_LENGTH) {
    return fail("empty", "Contract id must not be empty.");
  }

  if (id.length > CONTRACT_ID_MAX_LENGTH) {
    return fail(
      "too_long",
      `Contract id must be at most ${CONTRACT_ID_MAX_LENGTH} characters.`,
    );
  }

  if (!CONTRACT_ID_PATTERN.test(id)) {
    return fail(
      "invalid_characters",
      "Contract id may only contain lowercase letters, digits, hyphens, and underscores.",
    );
  }

  const existingIds = options.existingIds ?? [];
  if (existingIds.includes(id)) {
    return fail("duplicate", "Contract id already exists.");
  }

  return { ok: true, value: id };
}

/**
 * Convenience predicate for callers that only need a boolean. This is
 * equivalent to validateContractId(id).ok and is provided to avoid adhoc
 * duplication of the rules in consumers.
 */
export function isValidContractId(id: unknown): boolean {
  return validateContractId(id).ok;
}
