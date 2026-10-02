/**
 * Stellar address validation and normalization utilities.
 *
 * This module is the single source of truth for determining whether a
 * user-supplied string is a valid Stellar public account address (G-address)
 * or a valid Stellar contract address (C-address). It is used by the
 * wallet UI to validate input before submitting any state transition.
 *
 * Invariants:
 *   1. A valid address is exactly 56 characters long.
 *   2. A valid address uses only base32 alphabet characters (A-Z, 2-7).
 *   3. A valid address begins with `G` for accounts, `C` for contracts.
 *   4. Validation is pure and deterministic — no I/O, no side effects.
 *   5. Normalization is idempotent: normalize(normalize(x)) === normalize(x).
 */

/** Stellar addresses are always 56 characters long. */
export const STELLAR_ADDRESS_LENGTH = 56;

/** Base32 alphabet used by Stellar addresses (Crockford base32). */
const BASE32_ALPHABET = /^[A-Z2-7]+$/;

/** Stellar account addresses start with `G`. */
const ACCOUNT_PREFIX = 'G';

/** Stellar contract addresses start with `C`. */
const CONTRACT_PREFIX = 'C';

/**
 * Result of a detailed address validation check.
 */
export interface StellarAddressValidationResult {
  /** Whether the input is a valid Stellar address. */
  valid: boolean;
  /** Human-readable reason when `valid` is false, `null` otherwise. */
  error: string | null;
  /** The normalized (uppercase, trimmed) address. */
  normalized: string;
  /** Whether the address is a contract (C...) address. */
  isContract: boolean;
}

/**
 * Normalize a user-supplied address string.
 *
 * Trims surrounding whitespace and uppercases the result to match the
 * on-chain representation. This is idempotent and safe to call repeatedly.
 *
 * @param value - Raw input string.
 * @returns The normalized address string.
 */
export function normalizeStellarAddress(value: string): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toUpperCase();
}

/**
 * Check whether a string is a valid Stellar address (G-address or C-address).
 *
 * Validation rules:
 *   - Must be a string.
 *   - Must be exactly 56 characters after trimming.
 *   - Must only contain base32 characters (A-Z, 2-7).
 *   - Must start with `G` (account) or `C` (contract).
 *
 * @param value - Raw input string.
 * @returns `true` if the value is a valid Stellar address.
 */
export function isValidStellarAddress(value: unknown): boolean {
  return validateStellarAddress(value).valid;
}

/**
 * Validate a Stellar address and return a detailed result with an error
 * message when invalid. This is the canonical entry point for all
 * address validation in the application.
 *
 * The function never throws and never returns a partially-valid result:
 * either `valid` is `true` and `error` is `null`, or `valid` is `false`
 * and `error` is a non-empty string.
 *
 * @param value - Raw input value of any type.
 * @returns A `StellarAddressValidationResult`.
 */
export function validateStellarAddress(value: unknown): StellarAddressValidationResult {
  const normalized = normalizeStellarAddress(typeof value === 'string' ? value : '');

  if (normalized.length === 0) {
    return {
      valid: false,
      error: 'Address is required.',
      normalized,
      isContract: false,
    };
  }

  if (normalized.length !== STELLAR_ADDRESS_LENGTH) {
    return {
      valid: false,
      error: `Address must be exactly ${STELLAR_ADDRESS_LENGTH} characters long.`,
      normalized,
      isContract: false,
    };
  }

  if (!BASE32_ALPHABET.test(normalized)) {
    return {
      valid: false,
      error: 'Address contains invalid characters. Only base32 (A-Z, 2-7) is allowed.',
      normalized,
      isContract: false,
    };
  }

  const isContract = normalized.startsWith(CONTRACT_PREFIX);
  const isAccount = normalized.startsWith(ACCOUNT_PREFIX);

  if (!isContract && !isAccount) {
    return {
      valid: false,
      error: 'Address must start with "G" (account) or "C" (contract).',
      normalized,
      isContract: false,
    };
  }

  return {
    valid: true,
    error: null,
    normalized,
    isContract,
  };
}

/**
 * Assert that a value is a valid Stellar address, throwing a descriptive
 * error otherwise. Use this in code paths where an invalid address is a
 * programming error rather than user input (e.g. at a repository boundary).
 *
 * @param value - Value to assert.
 * @param label - Optional label for the error message.
 * @returns The normalized address.
 * @throws Error when the value is not a valid Stellar address.
 */
export function assertStellarAddress(value: unknown, label = 'Address'): string {
  const result = validateStellarAddress(value);
  if (!result.valid) {
    throw new Error(`${label} is invalid: ${result.error}`);
  }
  return result.normalized;
}
