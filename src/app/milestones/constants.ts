import type { Milestone } from '@/types/domain';

/**
 * Persistence key for the user's dismissal of the sample milestone banner.
 *
 * Invariant: this key is stable across releases. Renaming it would silently
 * re-surface the sample banner for users who already dismissed it.
 */
export const SAMPLE_DISMISSED_KEY = 'talenttrust-milestones-sample-dismissed';

/**
 * The canonical set of milestone statuses that the app recognizes.
 * Exported as a readonly tuple so consumers can validate incoming data
 * without being able to mutate the contract at runtime.
 */
export const MILESTONE_STATUSES = [
  'Completed',
  'Paid',
  'Pending',
  'Disputed',
] as const;

export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

const MILESTONE_STATUS_SET: ReadonlySet<string> = new Set(MILESTONE_STATUSES);

export function isMlestoneStatus(value: unknown): value is MilestoneStatus {
  return typeof value === 'string' && MILESTONE_STATUS_SET.has(value);
}

// ---------------------------------------------------------------------------
// Milestone status state machine
//
// These are pure functions over the canonical status set, so every question the
// UI asks ("what can this become?", "is this finished?", "does this payout make
// sense for this status?") has exactly one answer, and repeated or concurrent
// calls can never disagree.
//
//   Invariants:
//     - Nothing here throws and nothing mutates its input.
//     - `Disputed` is a branch state, never part of the linear order, so it has
//       no "next" status and no positional index.
//     - An unknown status is always rejected rather than defaulted, so corrupt
//       data cannot silently appear to be a valid state.
// ---------------------------------------------------------------------------

/**
 * Linear progression order. `Disputed` is deliberately excluded: it is a
 * branch reached from any active state, not a step in the sequence.
 */
export const MILESTONE_STATUS_ORDER = ['Pending', 'Completed', 'Paid'] as const;

/** Every status the app recognises, including the branch state. */
export const VALID_STATUSES = [...MILESTONE_STATUS_ORDER, 'Disputed'] as const;

/**
 * Statuses with no outgoing transition.
 *
 * `Paid` is the only terminal status. `Completed` still advances to `Paid`, and
 * `Disputed` is a branch that must be resolved rather than advanced.
 */
export const TERMINAL_STATUSES = ['Paid'] as const;

/** Type guard: is `value` one of {@link VALID_STATUSES}? */
export function isValidStatus(value: unknown): value is MilestoneStatus {
  return typeof value === 'string' && MILESTONE_STATUS_SET.has(value);
}

/** True when `status` has no outgoing transition. */
export function isTerminalStatus(value: unknown): boolean {
  return isValidStatus(value) && (TERMINAL_STATUSES as readonly string[]).includes(value);
}

/**
 * The status that follows `status` along the linear order.
 *
 * @returns `null` for a terminal status, the branch state, or an unknown value.
 */
export function getNextStatus(value: unknown): MilestoneStatus | null {
  if (!isValidStatus(value)) return null;
  const index = (MILESTONE_STATUS_ORDER as readonly string[]).indexOf(value);
  if (index < 0) return null;
  const next = MILESTONE_STATUS_ORDER[index + 1];
  return next ?? null;
}

/**
 * Position of `status` in the linear order.
 *
 * @returns `-1` for the branch state and for unknown values, so callers cannot
 *   accidentally treat `-1` as a real position.
 */
export function getStatusIndex(value: unknown): number {
  if (!isValidStatus(value)) return -1;
  return (MILESTONE_STATUS_ORDER as readonly string[]).indexOf(value);
}

/**
 * True when `from -> to` is a permitted transition.
 *
 * Invariant: a self-transition is *never* allowed. Treating `x -> x` as allowed
 * would let a replayed action produce a redundant write; treating it as a
 * transition error would surface a scary message for a harmless no-op, so callers
 * short-circuit on equality instead.
 */
export function isAllowedTransition(from: unknown, to: unknown): boolean {
  if (!isValidStatus(from) || !isValidStatus(to)) return false;
  if (from === to) return false;
  return getNextStatus(from) === to;
}

/**
 * True when `payout` is plausible for `status`.
 *
 * Invariant: a Paid milestone must have been paid something, so a zero or
 * negative payout there is inconsistent. Non-Paid statuses legitimately carry a
 * zero payout, but never a negative, non-finite, or non-numeric one.
 */
export function isPayoutConsistentWithStatus(status: unknown, payout: unknown): boolean {
  if (typeof payout !== 'number' || !Number.isFinite(payout) || payout < 0) {
    return false;
  }
  if (status === 'Paid') return payout > 0;
  return true;
}

/**
 * Collects every invariant violation for `milestone`.
 *
 * Invariant: total and non-throwing, and it collects *all* problems rather than
 * failing on the first, so a caller can surface everything at once.
 *
 * @returns An array of human-readable violation messages; empty when valid.
 */
export function validateMilestoneInvariants(milestone: unknown): string[] {
  const violations: string[] = [];

  if (!milestone || typeof milestone !== 'object') {
    return ['Milestone must be an object'];
  }

  const candidate = milestone as Partial<Milestone>;

  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
    violations.push('Milestone id must be a non-empty string');
  }
  if (typeof candidate.title !== 'string' || candidate.title.trim() === '') {
    violations.push('Milestone title must be a non-empty string');
  }
  if (!isValidStatus(candidate.status)) {
    violations.push(
      `Unknown milestone status "${String(candidate.status)}"`,
    );
  }
  if (!isPayoutConsistentWithStatus(candidate.status, candidate.payout)) {
    violations.push(
      `Payout ${String(candidate.payout)} is inconsistent with status "${String(candidate.status)}"`,
    );
  }
  if (typeof candidate.currency !== 'string' || candidate.currency.trim() === '') {
    violations.push('Milestone currency must be a non-empty string');
  }

  return violations;
}

/**
 * Applies a status transition, returning a new milestone.
 *
 * Invariant: the input is never mutated. Callers can therefore retry a rejected
 * transition, or keep the previous object for a rollback, without the previous
 * state having been disturbed.
 *
 * @throws when the transition is not permitted, or when the resulting milestone
 *   would violate its invariants (e.g. moving to Paid with no payout). Refusing
 *   here is what stops an inconsistent milestone from ever reaching persistence.
 */
export function applyMilestoneTransition(
  milestone: Milestone,
  nextStatus: MilestoneStatus,
): Milestone {
  if (!isAllowedTransition(milestone.status, nextStatus)) {
    throw new Error(
      `Invalid milestone transition: ${String(milestone.status)} -> ${String(nextStatus)}`,
    );
  }

  const next: Milestone = { ...milestone, status: nextStatus };

  const violations = validateMilestoneInvariants(next);
  if (violations.length > 0) {
    throw new Error(
      `Milestone ${milestone.id} violates invariants after transition to ${nextStatus}: ${violations.join('; ')}`,
    );
  }

  return next;
}

/**
 * Sample milestones used for demo/empty-state rendering.
 *
 * Invariants (preserved across all consumers):
 * - IDs are unique and non-empty.
 * - Every status belongs to MILESTONE_STATUES.
 * - Every payout is a non-negative finite number.
 * - Every dueDate is a valid ISO (year-month-day) date string.
 * - Every currency is a non-empty trimmed string.
 * These invariants are enforced at module load time by assertSampleMilestones.
 */
export const SAMPLE_MILESTONES: Milestone[] = [
  {
    id: '1',
    title: 'Project Kickoff & Discovery',
    status: 'Completed',
    payout: 2500,
    currency: 'USD',
    dueDate: '2026-03-15',
  },
  {
    id: '2',
    title: 'UI/UX Design Handoff',
    status: 'Paid',
    payout: 3500,
    currency: 'USD',
    dueDate: '2026-04-01',
  },
  {
    id: '3',
    title: 'Frontend Development – Sprint 1',
    status: 'Pending',
    payout: 5000,
    currency: 'USD',
    dueDate: '2026-05-01',
  },
  {
    id: '4',
    title: 'API Integration & Testing',
    status: 'Pending',
    payout: 4000,
    currency: 'USD',
    dueDate: '2026-05-15',
  },
  {
    id: '5',
    title: 'Payment Gateway Integration',
    status: 'Disputed',
    payout: 3000,
    currency: 'USD',
    dueDate: '2026-04-20',
  },
];

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  // Reject normalization drift (e.g. 2026-02-30 -> 2026-03-02).
  return parsed.toISOString().slice(0, 10) === value;
}

/**
 * Validates the static sample data against the documented invariants.
 * Throws a deterministic Error on the first violation so breakages are caught
 * at module load rather than silently surfacing in the UI.
 */
export function assertSampleMilestones(
  milestones: readonly Milestone[] = SAMPLE_MILESTONES,
): void {
  const seenIds = new Set<string>();
  for (const [moduleIndex, milestone] of milestones.entries()) {
    const label = `milestones[${moduleIndex}]`;
    if (!milestone || typeof milestone !== 'object') {
      throw new Error(`${label} must be an object`);
    }
    if (typeof milestone.id !== 'string' || milestone.id.trim() === '') {
      throw new Error(`${label} has an empty id`);
    }
    if (seenIds.has(milestone.id)) {
      throw new Error(`${label} duplicates id "${milestone.id}"`);
    }
    seenIds.add(milestone.id);
    if (typeof milestone.title !== 'string' || milestone.title.trim() === '') {
      throw new Error(`${label} has an empty title`);
    }
    if (!isMlestoneStatus(milestone.status)) {
      throw new Error(`${label} has an unknown status "${String(milestone.status)}"`);
    }
    if (
      typeof milestone.payout !== 'number' ||
      !Number.isFinite(milestone.payout) ||
      milestone.payout < 0
    ) {
      throw new Error(`${label} has an invalid payout`);
    }
    if (typeof milestone.currency !== 'string' || milestone.currency.trim() === '') {
      throw new Error(`${label} has an empty currency`);
    }
    if (!isValidIsoDate(milestone.dueDate)) {
      throw new Error(`${label} has an invalid dueDate "${String(milestone.dueDate)}"`);
    }
  }
}

// Fail fast at import time if the shipped sample data ever drifts from the contract.
assertSampleMilestones();
