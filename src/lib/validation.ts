/**
 * Validation boundaries for the sign-in form (src/app/page.tsx).
 *
 * This module defines the canonical, side-effect-free validation layer for the
 * sign-in form. It is the single source of truth for:
 *
 *   1. Accepted input (valid email + strong enough password).
 *   2. Rejected input (malformed email, weak password, empty fields).
 *   3. Duplicate submissions (identical payloads are deterministically deduped).
 *   4. Boundary values (exact min/max lengths, whitespace only, Unicode length).
*
 * Invariants:
 *   - Pure functions: no DOM, no timers, no network, no global mutable state.
 *   - Deterministic: the same input always produces the same output.
 *   - Normalization is explicit and limited to trimming email whitespace.
 *   - Error messages never echo the raw input (no P-II / X-SS regressions).
 */

/** Maximum accepted email length (characters). */
export const MAX_EMAIL_LENGTH = 254;

/** Minimum accepted password length (characters). */
export const MIN_PASSWORD_LENGTH = 8;

/** Maximum accepted password length (characters). */
export const MAX_PASSWORD_LENGTH = 128;

/** Maximum number of distinct field errors returned for a single submit. */
export const MAX_ERRORS = 2;

/** Canonical field identifiers used by the form and the error summary.
 */
export type ValidationFieldId = 'email' | 'password';

/** A single field-level validation error. */
export interface ValidationError {
  fieldId: ValidationFieldId;
  message: string;
}

/** Result of a full form validation pass. */
export interface ValidationResult {
  /** True when the payload is accepted and no errors exist. */
  valid: boolean;
  /** Ordered, deduped errors (one per field). */
  errors: ValidationError[];
  /** Normalized email (trimmed), safe to display or persist. */
  normalizedEmail: string;
}

/**
 * RfC 5322-like email pattern. Intentionally conservative:
 *   - Exactly one `@`, no leading/trailing dots in the local part.
 *   - Domain labels are alphanumeric with hyphens, not leading/trailing hyphens.
 *   - TLS at least two letters.
 * This is a format gate, not an authority on deliverability.
 */
const EMAIL_PATTERN =
  /^[A-Za-z0-9^!#$%&'*+/=_`{|}~-]+(?:\.[A-Za-z0-9^!#$%&'*+/=_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

/**
 * Normalize an email by trimming surrounding whitespace and lowercasing the
 * domain part only. The local part is case-sensitive per RFC 5322 and is preserved
 * verbatim. No other transformations are applied.
 */
export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex == -1) return trimmed;
  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);
  return `${local}@${domain.toLowerCase()}`;
}

/**
 * Return the Unicode code-point length of a string. Using code points rather
 * than UTF-16 code units means astral symbols (e.g. emoji) count as one
 * character, matching user perception and the browser's maxLength semantics.
 */
export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

/** True when the value is a non-empty string after trimming. */
function hasContent(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validate the email field and return an error message or null. */
export function validateEmailField(raw: unknown): string | null {
  if (!hasContent(raw)) {
    return 'Email is required.';
  }

  const normalized = normalizeEmail(raw);

  if (countCodePoints(normalized) > MAX_EMAIL_LENGTH) {
    return `Email must be at most ${MAX_EMAIL_LENGTH} characters.`;
  }

  if (!EMAIL_PATTERN.test(normalized)) {
    return 'Enter a valid email address.';
  }

  return null;
}

/**
 * Validate the password field and return an error message or null.
 *
 * Note: we do not trim passwords. Whitespace is a legitimate password character,
 * and trimming would silently alter the secret the user intended to submit.
 */
export function validatePasswordField(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return 'Password is required.';
  }

  const length = countCodePoints(raw);

  if (length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  if (length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }

  return null;
}

/**
 * Validate the full sign-in payload.
 *
 * Behavior:
 *   - Returns a deterministic, deduplicated, field-ordered error list.
 *   - Coerces non-string inputs to empty strings so a compromised caller cannot
 *     smuggle objects or nulls through the boundary.
 *   - Never throws; all failure modes are represented as error entries.
 */
export function validateSignInPayload(
  emailInput: unknown,
  passwordInput: unknown,
): ValidationResult {
  const normalizedEmail = normalizeEmail(emailInput);
  const errors: ValidationError[] = [];

  const emailError = validateEmailField(emailInput);
  if (emailError) {
    errors.push({ fieldId: 'email', message: emailError });
  }

  const passwordError = validatePasswordField(passwordInput);
  if (passwordError) {
    errors.push({ fieldId: 'password', message: passwordError });
  }

  // Hard cap on the number of errors returned. This keeps the user-visible
  // surface bounded even if the field set grows in the future.
  const boundedErrors = errors.slice(0, MAX_ERRORS);

  return {
    valid: boundedErrors.length === 0,
    errors: boundedErrors,
    normalizedEmail,
  };
}

/**
 * Stable identity key for a sign-in payload. Used to detect duplicate
 * submissions without exposing the raw password in logs or state.
 *
 * The key is deterministic and collation-resistant enough for dedupe checks:
 * it combines the normalized email with a non-cryptographic fingerprint of
 * the password. The fingerprint is not a security boundary and must not be
 * treated as one.
 */
export function signInPayloadKey(emailInput: unknown, passwordInput: unknown): string {
  // Lowercased across the whole address, not just the domain.
  //
  // `normalizeEmail` deliberately preserves the local part's case, because it also
  // feeds display and the local part is technically case-sensitive. A throttle key
  // has a different requirement: two spellings of the same address must land in
  // the same bucket, or the throttle is bypassed simply by changing case. The
  // fingerprint is non-cryptographic and is never used for authentication.
  const normalizedEmail = normalizeEmail(emailInput).toLowerCase();
  const password = typeof passwordInput === 'string' ? passwordInput : '';
  return `${normalizedEmail}::${fingerprint(password)}`;
}

/** Deterministic, non-cryptographic 32-bit fingerprint (FNV-1a). */
function fingerprint(value: string): string {
  let hash = 0x811c9dc;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Track the most recently submitted payload key so duplicate submissions can
 * be detected without adding global mutable state to the validation module.
 *
 * The tracker is deliberately tiny and pure: it holds at most one key and
 * exposes a single consume operation. Callers own the lifetime of the
 * tracker, which keeps the module testable and free of hidden side effects.
 */
export interface DuplicateTracker {
  /** Return true when the key matches the last consumed key. */
  isDuplicate(key: string): boolean;
  /** Record a key as the latest submission. */
  record(key: string): void;
  /** Forget the last key (e.g. after a successful submit). */
  reset(): void;
}

/** Create a fresh, closure-scoped duplicate tracker. */
export function createDuplicateTracker(): DuplicateTracker {
  let lastKey: string | null = null;
  return {
    isDuplicate(key: string) {
      return lastKey !== null && lastKey === key;
    },
    record(key: string) {
      lastKey = key;
    },
    reset() {
      lastKey = null;
    },
  };
}
