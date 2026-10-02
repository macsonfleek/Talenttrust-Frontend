
import type { StatusType } from '@/components/StatusBadge';

export const STATUS_ORDER: StatusType[] = ['Active', 'Completed', 'Disputed', 'Pending', 'Paid'];

export interface StatusTally {
  status: StatusType;
  count: number;
}

/**
 * Canonical set of status values that the tally may report.
 * Used to guard against unknown/stale status values at the boundary.
 */

/**
 * Compute a deterministic tally of milestone statuses.
 *
 * Invariants:
 - The result is a pure function of the input array; repeated or concurrent
 *   calls with the same input always produce the same output (no shared mutable
 *   state, no time-dependent behavior).
 * - Output order is deterministic and follows STATUS_ORDER, independent of input
 *   ordering.
 * - Only known status values are counted; unknown/stale values are ignored rather
 *   than corrupting the tally or throwing. This keeps the function totally
 *   safe under concurrent execution and partial failure of upstream data.
 * - Zero-count statuses are omitted from the output to preserve the existing
 *   public contract.
 */
export function milestoneStatusTally(
  milestones: readonly { status: StatusType }[],
): StatusTally[] {
  const counts: Record<StatusType, number> = {
    Active: 0,
    Completed: 0,
    Disputed: 0,
    Pending: 0,
    Paid: 0,
    // Present so the map satisfies `Record<StatusType, number>`; Archived is
    // intentionally excluded from STATUS_ORDER and therefore never emitted.
    Archived: 0,
  };

  // Invariant: tolerate malformed/empty input without throwing. Non-array
  // inputs and entries with unknown or missing statuses are ignored so that
  // callers relying on the previous public contract keep working.
  if (!Array.isArray(milestones)) {
    return [];
  }

  for (const m of milestones) {
    if (m == null) continue;
    const status = m.status;
    if (typeof status !== 'string') continue;
    if (!Object.prototype.hasOwnProperty.call(counts, status)) continue;
    counts[status as StatusType]++;
  }

  return STATUS_ORDER
    .filter((s) => counts[s] > 0)
    .map((s) => ({ status: s, count: counts[s] }));
}
