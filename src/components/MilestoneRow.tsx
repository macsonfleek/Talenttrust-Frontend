/**
 * @file MilestoneRow.tsx
 *
 * Renders a single milestone row in the milestones list.
 *
 * The row is purely presentational and derives everything it shows from
 * its props. It never mutates the milestone object it receives, and it gracefully
 * handles missing due dates and amounts so a partial payload cannot crash the
 * list.
 */

'use client';

import { memo } from 'react';

import StatusBadge from '@/components/StatusBadge';
import { allowedNextStatuses, type Milestone } from '@/lib/milestones';
import { isDueSoon } from '@/lib/dueSoon';

export interface MilestoneRowProps {
  milestone: Milestone;
  /** Called with the milestone id and the desired next status. */
  onStatusChange?: (id: string, nextStatus: unknown) => void;
  /** Reference date for the due-soon calculation. Defaults to now. */
  today?: Date;
  /** Number of days before a due date is considered soon. */
  dueSoonWindowDays?: number;
}

/** Formats a numeric amount for display, or a dash when missing. */
const formatAmount = (amount: number | undefined): string => {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
  return amount.toLocaleString();
};

const MilestoneRowImpl = ({
  milestone,
  onStatusChange,
  today,
  dueSoonWindowDays = 7,
}: MilestoneRowProps) => {
  const referenceDate = today ?? new Date();
  const dueSoon = isDueSoon(milestone.dueDate, referenceDate, dueSoonWindowDays);
  const nextStatuses = allowedNextStatuses(milestone.status);

  return (
    <div className="flex items-center justify-between gap-4 border-b border-gray-200 py-4 dark:border-gray-800">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium" title={milestone.title}>
          {milestone.title}
        </p>
        {milestone.description ? (
          <p className="truncate text-sm text-gray-500">{milestone.description}</p>
        ) : null}
        <p className="text-sm text-gray-500">
          {milestone.dueDate ? `Due ${milestone.dueDate}` : 'No due date'}
          {dueSoon ? (
            <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
              Due soon
            </span>
          ) : null}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-sm tabular-nums">{formatAmount(milestone.amount)}</span>
        <StatusBadge status={milestone.status} />

        {onStatusChange && nextStatuses.length > 0 ? (
          <select
            aria-label={`Change status for ${milestone.title}`}
            className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
            value=""
            onChange={(event) => {
              const next = event.target.value;
              if (!next) return;
              onStatusChange(milestone.id, next);
            }}
          >
            <option value="" disabled>
              Change status&#8230;
            </option>
            {nextStatuses.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </div>
  );
};

export const MilestoneRow = memo(MilestoneRowImpl);
