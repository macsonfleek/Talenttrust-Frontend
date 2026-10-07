/**
 * Validation boundaries for contract input.
 *
 * This module defines the single source of truth for what constitutes a
 * valid, duplicate, invalid, or boundary-case contract payload before it is
 * persisted or rendered. The goal is determinism and reviewability: the
 * same input always produces the same outcome, and every failure path is
 * explicit and testable.
 *
 * Invariants enforced here:
 *   1. No field is ever truncated silently. Oversized input is rejected.
 *   2. Numeric fields are finite, non-negative, and within an explicit bound.
 *   3. Currency is normalized to uppercase ISO 4217 and must be in the
 *      allowlist.
 *   4. Dates are valid ISO 8601 strings and not in the future.
 *   5. Duplicates are detected by a normalized name key, not by raw bytes,
 *      so casing and whitespace differences cannot bypass the check.
 */

export const CONTRACT_NAME_MAX_LENGTH = 120;
const PARTICIPANT_NAME_MAX_LENGTH = 120;
const CONTRACT_DESCRIPTION_MAX_LENGTH = 2000;
const PARTICIPANTS_MAX = 20;
const MILESTONES_MAX = 500;
const MILESTONE_TITLE_MAX_LENGTH = 200;
const MILESTONE_DESCRIPTION_MAX_LENGTH = 2000;
const MILESTONE_PAYOUT_MAX_VALUE = 1e12;
const CONTRACT_TOTAL_VALUE_MAX_VALUE = 1e12;

export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD"] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export type ContractStatus =
  | "Draft"
  | "Active"
  | "Complete"
  | "Disputed"
  | "Cancelled";

export const CONTRACT_STATUSES: readonly ContractStatus[] = [
  "Draft",
  "Active",
  "Complete",
  "Disputed",
  "Cancelled",
];

export type ContractInput = {
  name?: unknown;
  description?: unknown;
  totalValue?: unknown;
  currency?: unknown;
  status?: unknown;
  createdAt?: unknown;
  parties?: unknown;
  milestones?: unknown;
};

export type ContractParty = {
  name: string;
  role?: string;
};

export type MilestoneInput = {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  payout?: unknown;
  currency?: unknown;
  dueDate?: unknown;
};

export type ValidationCode =
  | "REQUIRED"
  | "TOO_LONG"
  | "TOO_SHORT"
  | "NOT_AFINITE_NUMBER"
  | "NEGATIVE_NUMBER"
  | "OUT_OF_RANGE"
  | "UNSUPPORTED_CURRENCY"
  | "INVALID_DATE"
  | "DATE_IN_FUTURE"
  | "INVALID_STATUS"
  | "DUPLICATE_NAME"
  | "DUPLICATE_PARTICIPANT"
  | "DUPLICATE_MILESTONE_ID"
  | "INVALID_TYPE"
  | "TOO_MANY_ITEMS"
  | "SUM_EXCEEDES_TOTAL";

export type ValidationIssue = {
  /** Dot-notation path to the offending field (e.g. `parties.0.name`). */
  path: string;
  /** Stable machine-readable code for logging/metrics. */
  code: ValidationCode;
  /** Human-readable message suitable for user display. Never echoes input. */
  message: string;
};

export type NormalizedContract = {
  name: string;
  description?: string;
  totalValue: number;
  currency: SupportedCurrency;
  status: ContractStatus;
  createdAt: string;
  parties: ContractParty[];
  milestones: NormalizedMilestone[];
};

export type NormalizedMilestone = {
  id: string;
  title: string;
  description?: string;
  payout: number;
  currency: SupportedCurrency;
  dueDate?: string;
};

export type ValidationResult =
  | { ok: true; value: NormalizedContract; issues: [] }
  | { ok: false; issues: ValidationIssue[] };

/** Options for validation. */
export type ValidateContractOptions = {
  /** Existing contract names to check for duplicates. Compared case-insensitively. */
  existingNames?: readonly string[];
  /** Id to ignore when checking duplicates (useful for updates). */
  ignoreContractId?: string;
  /** Reference time for future-date checks. Defaults to Date.now(). */
  now?: Date;
};

/**
 * ISO-8601 date, optionally with a time and a `Z`/numeric offset.
 *
 * The offset group must spell the zone designator `Z`; anything else makes
 * the pattern reject every timestamped instant, which is why a plain
 * `YYYY-MM-DD` kept working while `YYYY-MM-DDTHH:MM:SS.sssZ` did not.
 */
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length === 0 ? null : trimmed;
}

/** Normalizes a name for duplicate comparison. */
export function normalizeNameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeCurrency(value: unknown): SupportedCurrency | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(upper)
    ? (upper as SupportedCurrency)
    : null;
}

function normalizeIsoDate(value: unknown): { value: string | null; code?: ValidationCode } {
  if (typeof value !== "string") return { value: null, code: "INVALID_TYPE" };
  const trimmed = value.trim();
  if (!ISO_DATE_RE.test(trimmed)) return { value: null, code: "INVALID_DATE" };
  const time = Date.parse(trimmed);
  if (Number.isNaN(time)) return { value: null, code: "INVALID_DATE" };
  return { value: new Date(time).toISOString() };
}

function normalizeNumber(
  value: unknown,
  max: number,
): { value: number | null; code?: ValidationCode } {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { value: null, code: "NOT_AFINITE_NUMBER" };
    if (value < 0) return { value: null, code: "NEGATIVE_NUMBER" };
    if (value > max) return { value: null, code: "OUT_OF_RANGE" };
    return { value };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return { value: null, code: "REQUIRED" };
    if (!/^-?\d+?(?:\.\d+)?$/.test(trimmed)) return { value: null, code: "NOT_AFINITE_NUMBER" };
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return { value: null, code: "NOT_AFINITE_NUMBER" };
    if (parsed < 0) return { value: null, code: "NEGATIVE_NUMBER" };
    if (parsed > max) return { value: null, code: "OUT_OF_RANGE" };
    return { value: parsed };
  }
  return { value: null, code: "INVALID_TYPE" };
}

function pushIssue(
  issues: ValidationIssue[],
  path: string,
  code: ValidationCode,
  message: string,
): void {
  issues.push({ path, code, message });
}

function validateParties(
  parties: unknown,
  issues: ValidationIssue[],
): ContractParty[] {
  if (parties === undefined) return [];
  if (!Array.isArray(parties)) {
    pushIssue(issues, "parties", "INVALID_TYPE", "Parties must be an array.");
    return [];
  }
  if (parties.length > PARTICIPANTS_MAX) {
    pushIssue(
      issues,
      "parties",
      "TOO_MANY_ITEMS",
      `At most ${PARTICIPANTS_MAX} parties are allowed.`,
    );
    return [];
  }

  const out: ContractParty[] = [];
  const seen = new Set<string>();
  parties.forEach((entry, index) => {
    const path = `parties.${index}`;
    if (!isPlainObject(entry)) {
      pushIssue(issues, path, "INVALID_TYPE", "Each party must be an object.");
      return;
    }
    const name = normalizeString(entry.name);
    if (!name) {
      pushIssue(issues, `${path}.name`, "REQUIRED", "Party name is required.");
      return;
    }
    if (name.length > PARTICIPANT_NAME_MAX_LENGTH) {
      pushIssue(
        issues,
        `${path}.name`,
        "TOO_LONG",
        `Party name must be at most ${PARTICIPANT_NAME_MAX_LENGTH} characters.`,
      );
      return;
    }
    const key = normalizeNameKey(name);
    if (seen.has(key)) {
      pushIssue(
        issues,
        `${path}.name`,
        "DUPLICATE_PARTICIPANT",
        "Duplicate party names are not allowed.",
      );
      return;
    }
    seen.add(key);
    const role = normalizeString(entry.role);
    out.push(role ? { name, role } : { name });
  });
  return out;
}

function validateMilestones(
  milestones: unknown,
  contractCurrency: SupportedCurrency,
  totalValue: number,
  issues: ValidationIssue[],
  now: Date,
): NormalizedMilestone[] {
  if (milestones === undefined) return [];
  if (!Array.isArray(milestones)) {
    pushIssue(issues, "milestones", "INVALID_TYPE", "Milestones must be an array.");
    return [];
  }
  if (milestones.length > MILESTONES_MAX) {
    pushIssue(
      issues,
      "milestones",
      "TOO_MANY_ITEMS",
      `At most ${MILESTONES_MAX} milestones are allowed.`,
    );
    return [];
  }

  const out: NormalizedMilestone[] = [];
  const seenIds = new Set<string>();
  let sum = 0;
  milestones.forEach((entry, index) => {
    const path = `milestones.${index}`;
    if (!isPlainObject(entry)) {
      pushIssue(issues, path, "INVALID_TYPE", "Each milestone must be an object.");
      return;
    }
    const title = normalizeString(entry.title);
    if (!title) {
      pushIssue(issues, `${path}.title`, "REQUIRED", "Milestone title is required.");
      return;
    }
    if (title.length > MILESTONE_TITLE_MAX_LENGTH) {
      pushIssue(
        issues,
        `${path}.title`,
        "TOO_LONG",
        `Milestone title must be at most ${MILESTONE_TITLE_MAX_LENGTH} characters.`,
      );
      return;
    }
    const description = normalizeString(entry.description);
    if (description && description.length > MILESTONE_DESCRIPTION_MAX_LENGTH) {
      pushIssue(
        issues,
        `${path}.description`,
        "TOO_LONG",
        `Milestone description must be at most ${MILESTONE_DESCRIPTION_MAX_LENGTH} characters.`,
      );
      return;
    }
    const payoutResult = normalizeNumber(entry.payout, MILESTONE_PAYOUT_MAX_VALUE);
    if (payoutResult.value === null) {
      pushIssue(
        issues,
        `${path}.payout`,
        payoutResult.code ?? "REQUIRED",
        "Milestone payout must be a non-negative number.",
      );
      return;
    }
    const currency = entry.currency === undefined
      ? contractCurrency
      : normalizeCurrency(entry.currency);
    if (!currency) {
      pushIssue(
        issues,
        `${path}.currency`,
        "UNSUPPORTED_CURRENCY",
        `Currency must be one of ${SUPPORTED_CURRENCIES.join(", ")}.`,
      );
      return;
    }
    let dueDate: string | undefined;
    if (entry.dueDate !== undefined && entry.dueDate !== null && entry.dueDate !== "") {
      const dateResult = normalizeIsoDate(entry.dueDate);
      if (dateResult.value === null) {
        pushIssue(
          issues,
          `${path}.dueDate`,
          dateResult.code ?? "INVALID_DATE",
          "Milestone due date must be a valid ISO date.",
        );
        return;
      }
      if (Date.parse(dateResult.value) > now.getTime()) {
        pushIssue(
          issues,
          `${path}.dueDate`,
          "DATE_IN_FUTURE_NOT_ALLOWED" as ValidationCode,
          "Milestone due date cannot be in the future.",
        );
        return;
      }
      dueDate = dateResult.value;
    }
    const rawId = normalizeString(entry.id);
    const id = rawId ?? `milestone-${index}-${now.getTime()}`;
    if (seenIds.has(id)) {
      pushIssue(
        issues,
        `${path}.id`,
        "DUPLICATE_MILESTONE_ID",
        "Duplicate milestone identifiers are not allowed.",
      );
      return;
    }
    seenIds.add(id);
    sum += payoutResult.value;
    out.push({
      id,
      title,
      ...(description ? { description } : {}),
      payout: payoutResult.value,
      currency,
      ...(dueDate ? { dueDate } : {}),
    });
  });

  if (out.length > 0 && sum > totalValue + Number.EPSILON) {
    pushIssue(
      issues,
      "milestones",
      "SUM_EXCEEDES_TOTAL",
      "Milestone payouts cannot exceed the contract total value.",
    );
  }

  return out;
}

/**
 * Validates and normalizes a contract input payload.
 *
 * Returns a discriminated union: on success `{ ok: true, value }` with a
normalized contract; on failure `{ ok: false, issues }` with every detected
 * problem. Validation is pure and deterministic given the same inputs and
 * options.
 */
export function validateContract(
  input: unknown,
  options: ValidateContractOptions = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const now = options.now ?? new Date();

  if (!isPlainObject(input)) {
    pushIssue(issues, "", "INVALID_TYPE", "Contract payload must be an object.");
    return { ok: false, issues };
  }

  const name = normalizeString(input.name);
  if (!name) {
    pushIssue(issues, "name", "REQUIRED", "Contract name is required.");
  } else if (name.length > CONTRACT_NAME_MAX_LENGTH) {
    pushIssue(
      issues,
      "name",
      "TOO_LONG",
      `Contract name must be at most ${CONTRACT_NAME_MAX_LENGTH} characters.`,
    );
  } else if (options.existingNames) {
    const key = normalizeNameKey(name);
    const collision = options.existingNames.some(
      (existing) => normalizeNameKey(existing) === key,
    );
    if (collision) {
      pushIssue(
        issues,
        "name",
        "DUPLICATE_NAME",
        "A contract with this name already exists.",
      );
    }
  }

  const description = normalizeString(input.description);
  if (description && description.length > CONTRACT_DESCRIPTION_MAX_LENGTH) {
    pushIssue(
      issues,
      "description",
      "TOO_LONG",
      `Contract description must be at most ${CONTRACT_DESCRIPTION_MAX_LENGTH} characters.`,
    );
  }

  const totalResult = normalizeNumber(input.totalValue, CONTRACT_TOTAL_VALUE_MAX_VALUE);
  if (totalResult.value === null) {
    pushIssue(
      issues,
      "totalValue",
      totalResult.code ?? "REQUIRED",
      "Total value must be a non-negative number.",
    );
  }

  const currency = normalizeCurrency(input.currency);
  if (!currency) {
    pushIssue(
      issues,
      "currency",
      "UNSUPPORTED_CURRENCY",
      `Currency must be one of ${SUPPORTED_CURRENCIES.join(", ")}.`,
    );
  }

  const statusRaw = input.status === undefined ? "Draft" : input.status;
  const status =
    typeof statusRaw === "string" &&
    (CONTRACT_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as ContractStatus)
      : null;
  if (!status) {
    pushIssue(
      issues,
      "status",
      "INVALID_STATUS",
      `Status must be one of ${CONTRACT_STATUSES.join(", ")}.`,
    );
  }

  const createdAtRaw = input.createdAt === undefined ? now.toISOString() : input.createdAt;
  const createdAtResult = normalizeIsoDate(createdAtRaw);
  if (createdAtResult.value === null) {
    pushIssue(
      issues,
      "createdAt",
      createdAtResult.code ?? "INVALID_DATE",
      "Creation date must be a valid ISO date.",
    );
  } else if (Date.parse(createdAtResult.value) > now.getTime()) {
    pushIssue(
      issues,
      "createdAt",
      "DATE_IN_FUTURE",
      "Creation date cannot be in the future.",
    );
  }

  const parties = validateParties(input.parties, issues);

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  // By this point all required fields are present and valid.
  const totalValue = totalResult.value as number;
  const milestones = validateMilestones(
    input.milestones,
    currency as SupportedCurrency,
    totalValue,
    issues,
    now,
  );

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    issues: [],
    value: {
      name: name as string,
      ...(description ? { description } : {}),
      totalValue,
      currency: currency as SupportedCurrency,
      status: status as ContractStatus,
      createdAt: createdAtResult.value as string,
      parties,
      milestones,
    },
  };
}

/**
 * Checks whether a contract name is a duplicate of an existing name.
 * Exposed separately for inline form validation and testing.
 */
export function isDuplicateContractName(
  name: string,
  existingNames: readonly string[],
): boolean {
  const key = normalizeNameKey(name);
  if (!key) return false;
  return existingNames.some((existing) => normalizeNameKey(existing) === key);
}
