/**
 * Milestones data hook.
 *
 * This hook backs the milestones board with a deterministic fetch lifecycle:
 *   - a single in-flight request at a time (latest call wins);
 *   - explicit loading / error / data states that the board can render;
 *   - a bounded retry with exponential backoff and a hard cap on attempts;
 *   - cancellation on unmount so a stale response cannot overwrite fresher state.
 *
 * Invariants:
*   1. Only the latest request id may commit state. Any other response is
      dropped silently.
   2. A failed retry does not clear previously loaded data; the board can
      continue to render the last known-good snapshot while the error is shown.
   3. Retries are bounded; after the cap the hook stops attempting until the
      caller explicitly resets or changes inputs.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchMilestones,
  MilestonesApiError,
  type Milestone,
} from '@/lib/milestonesApi';

export type UseMilestonesStatus = 'idle' | 'loading' | 'success' | 'error';

export type UseMilestonesResult = {
  /** Latest successfully loaded milestones. Never cleared by a failed retry. */
  milestones: Milestone[];
  /** Current lifecycle phase. */
  status: UseMilestonesStatus;
  /** True while a request is in flight. */
  isLoading: boolean;
  /** True once at least one request has settled. */
  isSettled: boolean;
  /** Safe, user-facing message when the latest attempt failed. */
  error: string | null;
  /** Stable machine-readable code for the latest failure. */
  errorCode: string | null;
  /** Number of attempts made for the current input set. */
  attempts: number;
  /** True when the retry budget is exhausted. */
  isExhausted: boolean;
  /** True when a retry is scheduled but not yet in flight. */
  isRetryingWaiting: boolean;
  /** Re-run the fetch from scratch, resetting the retry budget. */
  refetch: () => void;
  /** Retry the last failed request within the retry budget. */
  retry: () => void;
};

export type UseMilestonesOptions = {
  /** Maximum number of attempts for one input set. Defaults to 3. */
  maxAttempts?: number;
  /** Base backoff in ms. Defaults to 250. */
  baseDelayMs?: number;
  /** Upper bound on backoff in ms. Defaults to 4000. */
  maxDelayMs?: number;
  /** Set to false to skip the initial fetch. */
  enabled?: boolean;
  /** Optional callback for telemetry / toasts. */
  onError?: (error: MilestonesApiError, meta: { attempt: number; willRetry: boolean }) => void;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 4000;

function clampAttempts(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_ATTEMPTS;
  return Math.max(1, Math.floor(value));
}

function computeBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const raw = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(maxDelayMs, raw);
}

export function useMilestones(options: UseMilestonesOptions = {}): UseMilestonesResult {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    enabled = true,
    onError,
  } = options;

  const attemptCap = clampAttempts(maxAttempts);

  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [status, setStatus] = useState<UseMilestonesStatus>('success');
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [isRetryingWaiting, setIsRetryingWaiting] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // Monotonic id for the latest request. Only the matching response commits.
  const requestIdRef = useRef(0);
  // True while the effect is still mounted; guards against setState after unmount.
  const mountedRef = useRef(false);
  // Timer for the backoff wait between retries.
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest onError callback without re-triggering the fetch effect.
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    // When disabled, stop any pending retry and mark the hook settled.
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setIsRetryingWaiting(false);
    setStatus('success');
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const requestId = ++requestIdRef.current;

    const run = async () => {
      setStatus('loading');
      setError(null);
      setErrorCode(null);

      try {
        const data = await fetchMilestones();
        if (cancelled || !mountedRef.current || requestId !== requestIdRef.current) {
          return;
        }
        setMilestones(data);
        setStatus('success');
        setAttempts(0);
        setIsRetryingWaiting(false);
      } catch (cause) {
        if (cancelled || !mountedRef.current || requestId !== requestIdRef.current) {
          return;
        }

        const apiError =
          cause instanceof MilestonesApiError
            ? cause
            : new MilestonesApiError('Unable to load milestones.', {
                code: 'MILESTONES_FETCH_FAILED',
                cause,
              });

        setStatus('error');
        setError(apiError.message);
        setErrorCode(apiError.code);

        setAttempts((prev) => {
          const next = prev + 1;
          const willRetry = next < attemptCap;
          try {
            onErrorRef.current?.(apiError, { attempt: next, willRetry });
          } catch {
            // Telemetry must never break the board.
          }

          if (!willRetry) {
            setIsRetryingWaiting(false);
            return next;
          }

          const delay = computeBackoff(next, baseDelayMs, maxDelayMs);
          setIsRetryingWaiting(true);
          if (retryTimerRef.current !== null) {
            clearTimeout(retryTimerRef.current);
          }
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            if (cancelled || !mountedRef.current) return;
            void run();
          }, delay);

          return next;
        });
      }
    }

    void run();

    return () => {
      cancelled = true;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [enabled, reloadToken, attemptCap, baseDelayMs, maxDelayMs]);

  const refetch = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setAttempts(0);
    setIsRetryingWaiting(false);
    setReloadToken((prev) => prev + 1);
  }, []);

  const retry = useCallback(() => {
    if (attempts >= attemptCap) return;
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setIsRetryingWaiting(false);
    setReloadToken((prev) => prev + 1);
  }, [attempts, attemptCap]);

  return {
    milestones,
    status,
    isLoading: status === 'loading',
    isSettled: status === 'success' || status === 'error',
    error,
    errorCode,
    attempts,
    isExhausted: attempts >= attemptCap,
    isRetryingWaiting,
    refetch,
    retry,
  };
}
