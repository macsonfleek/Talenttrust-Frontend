'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMilestonesRouteError } from '@/hooks/useMilestonesRouteError';

type MilestonesErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

/**
 * Route-level error boundary for `/milestones`.
 *
 * State invariants for this boundary:
 *
 * 1. Reporting is idempotent per error identity. The same error object (or the
 *    same digest) must not be reported more than once, even if React
 *    re-renders or Strict Mode double-invokes effects. This prevents duplicate
 *    telemetry and alert fatigue.
 * 2. Reset is guarded against concurrent/repeated invocation. A double click or
 *    a rapid retry must not dispatch multiple resets that could corrupt the
 *    parent state transition.
 * 3. Reporting must never throw. A failure in the observability path must not
 *    cause the error boundary itself to crash or block recovery.
 * 4. No sensitive data is rendered to the user; only a stable digest is
 *    exposed for correlation with server logs.
 *
 * Invariants 1-3 are owned by {@link useMilestonesRouteError}, which is the
 * single state machine for this boundary. Keeping the guard there (rather than
 * re-deriving it inline) means the component below cannot drift from the
 * behaviour the hook's own tests pin, and there is exactly one implementation
 * of "one reset per failure cycle".
 *
 * Invariant 4 is enforced here: neither the error message, the stack, nor the
 * digest is rendered. The only diagnostic surface is the sanitized notice the
 * hook produces when `reset()` itself throws.
 */
export default function MilestonesError({ error, reset }: MilestonesErrorProps) {
  const { status, isRetryDisabled, recoveryNotice, handleRetry } =
    useMilestonesRouteError(error, reset, error?.digest);

  /**
   * Attempted retries for the failure currently on screen.
   *
   * Invariant: reset to 0 whenever a *new* failure arrives, so the count always
   * describes the attempts for the error the user is looking at rather than
   * accumulating across unrelated failures. Resetting on the identity (rather
   * than on every render) keeps repeated renders idempotent.
   */
  const [retryCount, setRetryCount] = useState(0);
  const [lastErrorIdentity, setLastErrorIdentity] = useState<unknown>(error);

  if (lastErrorIdentity !== error) {
    // Render-phase reset of derived view state. React discards this render's
    // output and re-renders immediately, so no stale count is ever painted.
    setLastErrorIdentity(error);
    setRetryCount(0);
  }

  const isRecovering = status === 'recovering';

  return (
    <main className="min-h-screen p-8" aria-labelledby="milestones-error-title">
      <section className="mx-auto max-w-md rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h1 id="milestones-error-title" className="text-2xl font-bold text-slate-900">
          Unable to load milestones
        </h1>
        <p className="mt-3 text-slate-600">
          Please try again. Contact support if the problem continues.
        </p>

{/*
          Single status region for everything this boundary needs to announce.

          Invariant: exactly one `role="status"` is rendered at any time, so a
          screen reader announces one coherent message per change instead of
          racing two live regions. Content is either the hook's static notice
          (the thrown reset error is reported, never rendered) or the attempt
          count, and they cannot both be shown at once because a thrown reset
          re-arms the retry and resets the count for the next attempt.
        */}
        {(recoveryNotice || retryCount > 0) && (
          <p className="mt-2 text-sm text-slate-500" role="status">
            {recoveryNotice ?? `Retry attempts: ${retryCount}`}
          </p>
        )}

        <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
          <button
            type="button"
            onClick={() => {
              // Counted here so the visible number matches the dispatches the
              // hook actually performs, including ones it refuses as duplicates
              // (the guard below only forwards the first).
              if (!isRetryDisabled) {
                setRetryCount((count) => count + 1);
              }
              handleRetry();
            }}
            disabled={isRetryDisabled}
            aria-disabled={isRetryDisabled}
            aria-describedby="milestones-retry-status"
            className="rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
          >
            {isRecovering ? 'Retrying…' : 'Try again'}
          </button>
          <Link
            href="/"
            className="rounded-xl border border-slate-300 px-4 py-2 font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
          >
            Go home
          </Link>
        </div>
        <p id="milestones-retry-status" className="sr-only" aria-live="polite">
          {isRecovering ? 'Retrying milestones.' : ''}
        </p>
      </section>
    </main>
  );
}