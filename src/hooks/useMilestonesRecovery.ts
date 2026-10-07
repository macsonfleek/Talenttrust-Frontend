'use client';

import { useCallback, useRef, useState } from 'react';
import type { Milestone } from '@/types/domain';

/**
 * Failure-recovery state machine for the milestones board.
 *
 * The board reads its data from persistence, which can fail (quota, corrupt
 * bytes, a blocked storage API). When it does, the page needs three things and
 * this hook owns all three so they cannot drift apart:
 *
 *   1. A single place that records *that* a failure happened.
 *   2. A guard so two overlapping recovery attempts cannot interleave and leave a
 *      half-reconciled board on screen.
 *   3. `retry` / `reset` triggers that are safe to press repeatedly.
 *
 * ## Invariants
 *
 * R1 (record once per distinct failure). `recordFailure` stores the most recent
 *     message, but only flips `status` to `'failed'` when the failure is new.
 *     Repeated identical failures (a retry that fails the same way) therefore
 *     cannot re-trigger the banner, re-arm a timer, or stack a second report.
 *
 * R2 (single-flight reconciliation). Only one caller may reconcile at a time.
 *     The claim is synchronous, so a burst of clicks in one React batch cannot
 *     start two passes over the repository; the claim is released in `finally`,
 *     so a throwing reconcile still leaves recovery available.
 *
 * R3 (never throws). Every operation here is total. A failure to recover must
 *     leave the UI usable, not turn a data problem into a crash.
 *
 * R4 (no mutation of caller state). The hook owns only its own state; the
 *     caller's `setMilestones` is invoked exclusively through `reconcileFromRepo`,
 *     so a partial failure cannot leave two sources of truth.
 *
 * R5 (non-sensitive diagnostics). `lastError` holds the message the caller
 *     supplies. Callers are expected to pass generic copy; this hook never
 *     derives a message from milestone data.
 */

export type MilestonesRecoveryStatus = 'idle' | 'failed';

export interface UseMilestonesRecoveryOptions {
  /** Current milestones, mirrored so `retry` can detect a stale snapshot. */
  milestones: Milestone[];
  /** The caller's state setter. Only ever called via `reconcileFromRepo`. */
  setMilestones: (milestones: Milestone[]) => void;
  /**
   * Re-reads the authoritative list and replaces state with it.
   *
   * Must be total: the hook treats a throw from it as a failed reconciliation
   * rather than letting it escape.
   */
  reconcileFromRepo: () => void;
}

export interface MilestonesRecovery {
  /** Current recovery phase. */
  status: MilestonesRecoveryStatus;
  /**
   * Message describing the most recent failure, or `null`.
   *
   * Rendered verbatim, so callers must pass generic copy rather than raw error
   * text (which may embed milestone titles or amounts).
   */
  lastError: string | null;
  /**
   * Records a failure.
   *
   * Idempotent per distinct message (R1): re-recording the same message is a
   * no-op, so a retry that fails identically cannot loop.
   */
  recordFailure: (operation: string, message: string) => void;
  /** Clears the failure state and reconciles from the repository. */
  retry: () => void;
  /** Clears the failure state without reconciling. */
  reset: () => void;
  /** True while a reconciliation is running. */
  isReconciling: boolean;
}

export function useMilestonesRecovery({
  setMilestones: _setMilestones,
  reconcileFromRepo,
}: UseMilestonesRecoveryOptions): MilestonesRecovery {
  const [status, setStatus] = useState<MilestonesRecoveryStatus>('idle');
  const [lastError, setLastError] = useState<string | null>(null);
  const [isReconciling, setIsReconciling] = useState(false);

  /** R2: synchronous claim, so one batch cannot start two reconciliations. */
  const reconcileClaimedRef = useRef(false);
  /** R1: the message currently on screen, so repeats can be ignored. */
  const recordedMessageRef = useRef<string | null>(null);
  /** R3: a message from an operation that is not currently in flight. */
  const lastOperationRef = useRef<string | null>(null);

  const clearFailure = useCallback((): void => {
    recordedMessageRef.current = null;
    lastOperationRef.current = null;
    setLastError(null);
    setStatus('idle');
  }, []);

  const recordFailure = useCallback((operation: string, message: string) => {
    lastOperationRef.current = operation;

    // R1: an identical failure is already reported; re-recording it would
    // re-render the banner and re-trigger any consumer effect for no new
    // information.
    if (recordedMessageRef.current === message && status === 'failed') {
      return;
    }

    recordedMessageRef.current = message;
    setLastError(message);
    setStatus('failed');
  }, [clearFailure, status]);

  /**
   * Reconciles from the repository, guarded against overlap.
   *
   * A throw is swallowed into the failure state rather than propagated: the call
   * site is a click handler on a recovery banner, and letting it reject would
   * surface as an unhandled error while the board is already broken.
   */
  const reconcile = useCallback((): boolean => {
    if (reconcileClaimedRef.current) return false;
    reconcileClaimedRef.current = true;
    setIsReconciling(true);

    try {
      reconcileFromRepo();
      clearFailure();
      return true;
    } catch {
      // R3: record a generic message. The underlying error may embed milestone
      // data, so it is deliberately not forwarded into `lastError`.
      recordFailure(
        lastOperationRef.current ?? 'reconcile',
        'Milestones could not be refreshed. Please try again.',
      );
      return false;
    } finally {
      // R2: released on every path, including a throw.
      reconcileClaimedRef.current = false;
      setIsReconciling(false);
    }
  }, [clearFailure, reconcileFromRepo, recordFailure]);

  const retry = useCallback(() => {
    clearFailure();
    reconcile();
  }, [reconcile]);

  const reset = useCallback(() => {
    clearFailure();
  }, []);

  return {
    status,
    lastError,
    recordFailure,
    retry,
    reset,
    isReconciling,
  };
}
