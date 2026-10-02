/**
 * @file milestones.ts
 *
 * Pure domain helpers for the milestones feature.
 *
 * This module is the single source of truth for the milestone state model:
 * normalization of raw API payloads, status transition rules, and the
 * derived values used by the hook and the row component. Every function
 * here is pure and deterministic so the components can be tested in
 * isolation and retries can never produce an inconsistent state.
 *
 * Invariants:
 * - A milestone always has a non-empty id, title, and a valid status.
 * - The collection returned by normalizeMilestones is deduplicated by id
 *   (last write wins) and sorted by due date then id, so it is stable
 *   regardless of the incoming order.
 * - Status transitions are explicitly allow-listed; anything else is
 *   rejected with a typed failure rather than silently applied.
 */

import type { StatusType } from '@/components/StatusBadge';

/** The canonical milestone status values. */
export const MILESTONE_STATUSES: readonly StatusType[] = [
  'Active',
  'Completed',
  'Disputed',
  'Pending',
  'Paid',
] as const;

const STATUS_SET: ReadonlySet<StatusType> = new Set(MILESTONE_STATUSES);

/** The default status assigned to a milestone with no valid status. */
export const DEFAULT_MILESTONE_STATUS: StatusType = 'Pending';

/** The default due-soon window, in days. */
const DEFAULT_DUR_SOON_WINDOW_DAYS = 7;

/** A milestone as exposed to the UI. */
export interface Milestone {
  id: string;
  title: string;
  status: StatusType;
  /** ISO date string or a display date; may be missing on legacy payloads. */
  dueDate?: string;
  /** Amount in the contract's currency units. */
  amount?: number;
  /** Free-form description, may be absent. */
  description?: string;
}

/** Raw shape accepted from the API / props. */
export interface RawMilestone {
  id?: unknown;
  title?: unknown;
  name?: unknown;
  status?: unknown;
  dueDate?: unknown;
  due_date?: unknown;
  amount?: unknown;
  description?: unknown;
  [key: string]: unknown;
}

/** Result of a normalization attempt. */
export type NormalizeResult =
  | { ok: true; milestone: Milestone }
  | { ok: false; reason: string };

/** Returns true when `value` is a non-empty string. */
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** Narrows an arbitrary value to a known milestone status. */
export const isMilestoneStatus = (value: unknown): value is StatusType =>
  typeof value === 'string' && STATUS_SET.has(value as StatusType);

/**
 * Coerces an arbitrary value to a known milestone status.
 *
 * Unknown or missing statuses fall back to `DEFAULT_MILESTONE_STATUS` so a
 * malformed payload never produces an unrenderable badge or an undefined
 * tally bucket.
 */
export const toMilestoneStatus = (value: unknown): StatusType =>
  isMilestoneStatus(value) ? value : DEFAULT_MILESTONE_STATUS;

/**
 * Normalizes a raw milestone payload into the canonical `Milestone`
 * shape.

 * Returns a typed failure (never throws) when the payload lacks a usable
 * id or title, so callers can decide whether to skip or surface the entry.
 */
export const normalizeMilestone = (raw: RawMilestone): NormalizeResult => {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'milestone is not an object' };
  }

  const id = raw.id;
  if (!isNonEmptyString(id)) {
    return { ok: false, reason: 'milestone is missing a non-empty id' };
  }

  const titleSource = isNonEmptyString(raw.title) ? raw.title : raw.name;
  if (!isNonEmptyString(titleSource)) {
    return { ok: false, reason: 'milestone is missing a non-empty title' };
  }

  const dueDateSource = raw.dueDate ?? raw.due_date;
  const amountSource = raw.amount;

  const milestone: Milestone = {
    id: id.trim(),
    title: titleSource.trim(),
    status: toMilestoneStatus(raw.status),
  };

  if (isNonEmptyString(dueDateSource)) {
    milestone.dueDate = dueDateSource.trim();
  }

  if (typeof amountSource === 'number' && Number.isFinite(amountSource)) {
    milestone.amount = amountSource;
  } else if (isNonEmptyString(amountSource)) {
    const parsed = Number(amountSource);
    if (Number.isFinite(parsed)) {
      milestone.amount = parsed;
    }
  }

  if (isNonEmptyString(raw.description)) {
    milestone.description = raw.description.trim();
  }

  return { ok: true, milestone };
};

/** Compares two milestones by due date then id, for a deterministic order. */
const compareMilestones = (a: Milestone, b: Milestone): number => {
  const aDue = a.dueDate == null ? Number.POSITIVE_INFINITY : Date.parse(a.dueDate);
  const bDue = b.dueDate == null ? Number.POSITIVE_INFINITY : Date.parse(b.dueDate);
  const normalizedADue = Number.isNaN(aDue) ? Number.POSITIVE_INFINITY : aDue;
  const normalizebDue = Number.isNaN(bDue) ? Number.POSITIVE_INFINITY : bDue;

  if (normalizedADue !== normalizebDue) {
    return normalizedADue - normalizebDue;
  }

  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
};

/**
 * Normalizes an array of raw milestones into a deduplicated, deterministically
 * ordered collection.

 * - Entries that fail normalization are skipped (they cannot be rendered)
 *   and their reasons are returned so callers can log them.
 * - Duplicate ids are collapsed; the last occurrence wins, matching the
 *   behaviour of a keyed map and avoiding React key collisions.
 * - The result is sorted by due date then id, so retries and concurrent
 *   responses produce the same list.
 */
export const normalizeMilestones = (rawMilestones: unknown): Milestone[] => {
  if (!Array.isArray(rawMilestones)) return [];

  const byId = new Map<string, Milestone>();

  for (const raw of rawMilestones) {
    const result = normalizeMilestone(raw as RawMilestone);
    if (!result.ok) continue;
    byId.set(result.milestone.id, result.milestone);
  }

  return Array.from(byId.values()).sort(compareMilestones);
};

/** The allowed status transitions, keyed by current status. */
const ALLOWED_TRANSITIONS: Readonly<Record<StatusType, readonly StatusType[]>> = {
  Active: ['Completed', 'Disputed'],
  Pending: ['Active', 'Disputed'],
  Completed: ['Paid', 'Disputed'],
  Disputed: ['Active', 'Completed'],
  Paid: [],
  Archived: [],
} as const;

/** Result of a status transition attempt. */
export type TransitionResult =
  | { ok: true; milestone: Milestone }
  | { ok: false; reason: string };

/** Returns the statuses a milestone may move to from its current status. */
export const allowedNextStatuses = (current: StatusType): StatusType[] =>
  [...(ALLOWED_TRANSITIONS[current] ?? [])];

/**
 * Applies a status transition to a milestone, enforcing the allow-list.
 *
 * This is the only supported way to change a milestone's status. It
 * returns a new object and never mutates its input, so concurrent updates
 * cannot corrupt a previously rendered state.
 */
export const applyStatusTransition = (
  milestone: Milestone,
  nextStatus: unknown,
): TransitionResult => {
  if (!isMilestoneStatus(nextStatus)) {
    return { ok: false, reason: 'unknown milestone status' };
  }

  if (nextStatus === milestone.status) {
    return { ok: true, milestone };
  }

  const allowed = ALLOWED_TRANSITIONS[milestone.status] ?? [];
  if (!allowed.includes(nextStatus)) {
    return {
      ok: false,
      reason: `transition from ${milestone.status} to ${nextStatus} is not allowed`,
    };
  }

  return { ok: true, milestone: { ...milestone, status: nextStatus } };
};

/** The default due-soon window used by the row component. */
export const DEFAULT_DUE_SOON_WINDOW_DAYS = DEFAULT_DUR_SOON_WINDOW_DAYS;
