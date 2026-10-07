/**
 * Validation boundaries for the milestones board route.
 *
 * The App Router loading state (`src/app/milestones/loading.tsx`)
 * is a pure presentational component, but the board itself accepts
 * navigation parameters (status filters, sort order, cursor pagination)
 * that must be validated before they are used to drive data fetching or
 * state transitions. This module defines the single source of truth
 * for those boundaries so the route loading state, the client suspense
 * fallback, and the resolved board all agree on what constitutes a
 * valid, invalid, duplicate, or boundary-case input.
 *
 * The goal is determinism: given the same input, the validator always
 * returns the same normalized result, and invalid input never silently
 * degrades into a different query than the one the user asked for.
 */

export const MILESTONE_STATUSES = [
  'all',
  'open',
  'in_progress',
  'completed',
  'blocked',
] as const;

export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const MILESTONE_SORT_KEYS = [
  'updated_at',
  'created_at',
  'title',
  'due_date',
] as const;

export type MilestoneSortKey = (typeof MILESTONE_SORT_KEYS)[number];

export const MILESTONE_SORT_DIRECTIONS = ['asc', 'desc'] as const;

export type MilestoneSortDirection =
  (typeof MILESTONE_SORT_DIRECTIONS)[number];

/** Maximum number of distinct status filters a single request may carry. */
export const MAX_STATUS_FILTERS = MILESTONE_STATUSES.length - 1;

/** Maximum length of a free-text search query. */
export const MAX_SEARCH_LENGTH = 120;

/** Maximum number of items a single page may request. */
export const MAX_PAGE_SIZE = 100;

/** Minimum number of items a single page may request. */
export const MIN_PAGE_SIZE = 1;

/** Default page size when the caller does not supply one. */
export const DEFAULT_PAGE_SIZE = 20;

/** Maximum length of an opaque pagination cursor. */
export const MAX_CURSOR_LENGTH = 512;

/**
 * Stable machine-readable codes for validation failures. These are
 * safe to log and are never derived from the raw input value.
 */
export const MILESTONE_VALIDATION_CODES = {
  invalid_status: 'MILESTONES_INVALID_STATUS',
  duplicate_status: 'MILESTONES_DUPLICATE_STATUS',
  too_many_statuses: 'MILESTONES_TOO_MANY_STATUSES',
  invalid_sort_key: 'MILESTONES_INVALID_SORT_KEY',
  invalid_sort_direction: 'MILESTONES_INVALID_SORT_DIRECTION',
  invalid_page_size: 'MILESTONES_INVALID_PAGE_SIZE',
  invalid_cursor: 'MILESTONES_INVALID_CURSOR',
  search_too_long: 'MILESTONES_SEARCH_TOO_LONG',
} as const;

export type MilestoneValidationCode =
  (typeof MILESTONE_VALIDATION_CODES)[keyof typeof MILESTONE_VALIDATION_CODES];

/**
 * A normalized, valid board query. This is the only shape that
 * downstream code may consume. It is frozen at construction time so
 * consumers cannot mutate a validated query after the fact.
 */
export interface MilestoneQuery {
  readonly status: readonly MilestoneStatus[];
  readonly sortKey: MilestoneSortKey;
  readonly sortDirection: MilestoneSortDirection;
  readonly pageSize: number;
  readonly cursor: string | null;
  readonly search: string;
}

/**
 * Raw, untrusted input as it arrives from the URL or a client
 * component. Every field is optional because the board must work with
 * a completely empty query string.
 */
export interface MilestoneQueryInput {
  status?: unknown;
  sortKey?: unknown;
  sortDirection?: unknown;
  pageSize?: unknown;
  cursor?: unknown;
  search?: unknown;
}

export type MilestoneValidationResult =
  | { ok: true; query: MilestoneQuery; warnings: readonly MilestoneValidationCode[] }
  | { ok: false; code: MilestoneValidationCode; message: string };

/**
 * A default query used when the caller provides no input at all.
 * This is a constant so callers can compare against it in tests.
 */
export const DEFAULT_MILESTONE_QUERY: MilestoneQuery = Object.freeze({
  status: Object.freeze(['all'] as MilestoneStatus[]),
  sortKey: 'updated_at',
  sortDirection: 'desc',
  pageSize: DEFAULT_PAGE_SIZE,
  cursor: null,
  search: '',
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is MilestoneStatus {
  return (
    typeof value === 'string' &&
    (MILESTONE_STATUSES as readonly string[]).includes(value)
  );
}

function isSortKey(value: unknown): value is MilestoneSortKey {
  return (
    typeof value === 'string' &&
    (MILESTONE_SORT_KEYS as readonly string[]).includes(value)
  );
}

function isSortDirection(value: unknown): value is MilestoneSortDirection {
  return (
    typeof value === 'string' &&
    (MILESTONE_SORT_DIRECTIONS as readonly string[]).includes(value)
  );
}

/**
 * Normalize a single status value into a list of distinct, valid
 * statuses. Accepts a string, an array of strings, or nothing. The
 * special value `all` collapses to a single `all` entry and any other
 * values are dropped because they are redundant when `all` is present.
 */
function normalizeStatuses(value: unknown): {
  statuses: MilestoneStatus[];
  duplicates: boolean;
  invalid: boolean;
} {
  if (value === undefined || value === null) {
    return { statuses: ['all'], duplicates: false, invalid: false };
  }

  const raw = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const statuses: MilestoneStatus[] = [];
  let duplicates = false;
  let invalid = false;

  for (const entry of raw) {
    if (!isStatus(entry)) {
      invalid = true;
      continue;
    }
    if (seen.has(entry)) {
      duplicates = true;
      continue;
    }
    seen.add(entry);
    statuses.push(entry);
  }

  if (statuses.length === 0) {
    return { statuses: ['all'], duplicates, invalid };
  }

  if (statuses.includes('all')) {
    return { statuses: ['all'], duplicates, invalid };
  }

  return { statuses, duplicates, invalid };
}

function normalizePageSize(value: unknown): {
  pageSize: number;
  invalid: boolean;
  tooLarge: boolean;
} {
  if (value === undefined || value === null || value === '') {
    return { pageSize: DEFAULT_PAGE_SIZE, invalid: false, tooLarge: false };
  }

  const numeric = typeof value === 'number' ? value : Number(value);

  // A page size must be a finite whole number. `Number.isInteger` is the only
  // correct test here: a fractional value would otherwise be forwarded to the
  // repository and produce an unpredictable slice boundary, and the boundary
  // cases (NaN, Infinity) must not reach the range clamps below.
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
    return { pageSize: DEFAULT_PAGE_SIZE, invalid: true, tooLarge: false };
  }

  if (numeric < MIN_PAGE_SIZE) {
    return { pageSize: MIN_PAGE_SIZE, invalid: true, tooLarge: false };
  }

  if (numeric > MAX_PAGE_SIZE) {
    return { pageSize: MAX_PAGE_SIZE, invalid: true, tooLarge: true };
  }

  return { pageSize: numeric, invalid: false, tooLarge: false };
}

function normalizeCursor(value: unknown): {
  cursor: string | null;
  invalid: boolean;
} {
  if (value === undefined || value === null || value === '') {
    return { cursor: null, invalid: false };
  }

  if (typeof value !== 'string') {
    return { cursor: null, invalid: true };
  }

  const trimmed = value.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_CURSOR_LENGTH) {
    return { cursor: null, invalid: true };
  }

  // Cursors are opaque tokens. Reject control characters and whitespace
  // so a malicious or corrupted cursor cannot inject headers or log
  // entries downstream.
  // Matching control characters is the intent — they are what allow header
  // or log injection through an otherwise opaque token.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\s]/.test(trimmed)) {
    return { cursor: null, invalid: true };
  }

  return { cursor: trimmed, invalid: false };
}

function normalizeSearch(value: unknown): {
  search: string;
  invalid: boolean;
  tooLong: boolean;
} {
  if (value === undefined || value === null) {
    return { search: '', invalid: false, tooLong: false };
  }

  if (typeof value !== 'string') {
    return { search: '', invalid: true, tooLong: false };
  }

  const trimmed = value.trim();

  if (trimmed.length > MAX_SEARCH_LENGTH) {
    return { search: '', invalid: true, tooLong: true };
  }

  return { search: trimmed, invalid: false, tooLong: false };
}

/**
 * Validate and normalize a raw milestones board query.
 *
 * The function is total: every input shape is accepted and either
 * produces a frozen normalized query or a deterministic rejection.
 * It never throws and never returns undefined.
 *
 * Rejection is reserved for inputs that cannot be safely coerced:
 * - an unknown status value,
 * - an unknown sort key or direction,
 * - a non-integer or out-of-range page size,
 * - a cursor that is not a safe opaque token,
 * - a search string that exceeds the maximum length.
 *
 * Deduplication and `all` collapsing are not rejections. They are
 * recorded as warnings so callers can observe that a non-canonical
 * request was normalized without failing the request.
 */
export function validateMilestoneQuery(
  input: MilestoneQueryInput | unknown = {},
): MilestoneValidationResult {
  const candidate = isPlainObject(input) ? input : {};

  const statusResult = normalizeStatuses(candidate.status);
  if (statusResult.invalid) {
    return {
      ok: false,
      code: MILESTONE_VALIDATION_CODES.invalid_status,
      message: 'Unrecognized milestone status filter.',
    };
  }

  if (statusResult.statuses.length > MAX_STATUS_FILTERS) {
    return {
      ok: false,
      code: MILESTONE_VALIDATION_CODES.too_many_statuses,
      message: 'Too many milestone status filters were requested.',
    };
  }

  const sortKey = candidate.sortKey ?? 'updated_at';
  if (!isSortKey(sortKey)) {
    return {
      ok: false,
      code: MILESTONE_VALIDATION_CODES.invalid_sort_key,
      message: 'Unrecognized milestone sort key.',
    };
  }

  const sortDirection = candidate.sortDirection ?? 'desc';
  if (!isSortDirection(sortDirection)) {
    return {
      ok: false,
      code: MILESTONE_VALIDATION_CODES.invalid_sort_direction,
      message: 'Unrecognized milestone sort direction.',
    };
  }

  const pageSizeResult = normalizePageSize(candidate.pageSize);
  if (pageSizeResult.invalid) {
    return {
      ok: false,
      code: MILESTONE_VALIDATION_CODES.invalid_page_size,
      message: 'Milestone page size must be a whole number between 1 and 100.',
    };
  }

  const cursorResult = normalizeCursor(candidate.cursor);
  if (cursorResult.invalid) {
    return {
      ok: false,
      code: MILESTONE_VALIDATION_CODES.invalid_cursor,
      message: 'Milestone pagination cursor is not a valid token.',
    };
  }

  const searchResult = normalizeSearch(candidate.search);
  if (searchResult.invalid) {
    return {
      ok: false,
      code: MILESTONE_VALIDATION_CODES.search_too_long,
      message: 'Milestone search query is too long.',
    };
  }

  const warnings: MilestoneValidationCode[] = [];
  if (statusResult.duplicates) {
    warnings.push(MILESTONE_VALIDATION_CODES.duplicate_status);
  }

  const query: MilestoneQuery = Object.freeze({
    status: Object.freeze(statusResult.statuses.slice()),
    sortKey,
    sortDirection,
    pageSize: pageSizeResult.pageSize,
    cursor: cursorResult.cursor,
    search: searchResult.search,
  });

  return { ok: true, query, warnings: Object.freeze(warnings) };
}

/**
 * Convenience wrapper for callers that only need the normalized query.
 * Returns the default query when the input is invalid. This is safe for
 * the route loading state, which must always render a stable skeleton
 * even when the URL parameters are malformed.
 */
export function safeMilestoneQuery(
  input: MilestoneQueryInput | unknown = {},
): MilestoneQuery {
  const result = validateMilestoneQuery(input);
  return result.ok ? result.query : DEFAULT_MILESTONE_QUERY;
}

/**
 * Type guard for consumers that want to narrow a validation result
 * without checking the discriminant manually.
 */
export function isValidMilestoneQueryResult(
  result: MilestoneValidationResult,
): result is { ok: true; query: MilestoneQuery; warnings: readonly MilestoneValidationCode[] } {
  return result.ok;
}
