'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { reportError } from '../lib/errorReporter';

/**
 * Validation boundaries for the root error boundary.
 *
 * Invariants:
 * 1. The component never throws during render, even when `error` or `reset`
 *    are malformed (null, undefined, non-function, non-Error values).
 * 2. A given error object is reported at most once per mount, even if React
 *    re-renders the boundary with the same error reference.
 * 3. The reset callback is invoked at most once per click and failures in
 *    the callback are contained so the UI remains usable.
 * 4. No error message, stack trace, or digest is ever rendered to the DOM.
 */

export interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Maximum number of retry attempts before the "Try Again" button is replaced
 * with a harder recovery path (page reload / go home).
 *
 * Invariant: once `retryCount >= MAX_RETRIES`, no further calls to `reset()`
 * are made — the user is directed to reload or navigate away instead.
 */
const MAX_RETRIES = 3;

/**
 * Route-level error boundary rendered by Next.js App Router when a segment
 * throws during rendering or in a server action.
 *
 * Failure-recovery invariants:
 *   1. Exactly-once reporting — the `error` object is reported once per distinct
 *      error identity. A ref tracks the last-reported error to prevent duplicate
 *      reports when the component re-renders without a new error.
 *   2. Reset guard — `reset()` is only called when no reset is already in
 *      flight (`isResetting` ref). Concurrent clicks cannot stack invocations.
 *   3. Error-in-reset surface — if `reset()` itself throws, the thrown value
 *      is caught, reported via `reportError`, and surfaced to the user as a
 *      "recovery failed" message without exposing raw error details.
 *   4. Retry cap — after `MAX_RETRIES` failed attempts the component stops
 *      calling `reset()` and presents a permanent recovery path (reload / home)
 *      to prevent infinite retry loops and unrecoverable frozen states.
 *   5. Accessible live region — a visually-hidden `aria-live="assertive"` region
 *      announces the current recovery state to assistive technologies so screen
 *      reader users know what is happening after each attempt.
 *   6. No detail leakage — neither the error message nor the stack trace is
 *      rendered in the visible UI.
 */
export function ErrorBoundary({ error, reset }: ErrorProps) {
  /**
   * Tracks how many `reset()` calls have been attempted. Used to cap retries at
   * `MAX_RETRIES` and to decide which recovery UI to present.
   */
  const [retryCount, setRetryCount] = useState(0);

  /**
   * Holds the user-visible recovery status message announced to assistive
   * technology via the `aria-live` region. Empty means no active announcement.
   */
  const [liveMessage, setLiveMessage] = useState('');

  /**
   * Set to a non-null string when `reset()` itself throws, surfacing a
   * "recovery failed" message. Cleared on the next retry attempt.
   */
  const [resetError, setResetError] = useState<string | null>(null);

  /**
   * Synchronous guard: true while a `reset()` call is in flight.
   * Using a ref (not state) ensures the guard is checked and set atomically
   * within the same event handler without an intermediate re-render.
   */
  const isResettingRef = useRef(false);

  /**
   * Tracks the last error identity that was reported so we never fire
   * `reportError` more than once for the same error object.
   */
  const lastReportedErrorRef = useRef<Error | null>(null);

  useEffect(() => {
    if (error !== lastReportedErrorRef.current) {
      lastReportedErrorRef.current = error;
      reportError(error, 'Error Boundary');
    }
  }, [error]);

  /**
   * Handles "Try Again":
   *
   *   1. No-ops if already resetting (concurrent-click guard).
   *   2. No-ops if the retry cap has been reached.
   *   3. Clears any previous reset error.
   *   4. Announces "Retrying…" before calling `reset()`.
   *   5. Catches any synchronous throw from `reset()`, reports it, and shows
   *      a safe "recovery failed" message without leaking error details.
   *   6. Increments `retryCount` unconditionally so the cap is enforced even
   *      when `reset()` throws.
   */
  const handleRetry = () => {
    if (isResettingRef.current) return;
    if (retryCount >= MAX_RETRIES) return;

    isResettingRef.current = true;
    setResetError(null);
    setLiveMessage('Retrying, please wait…');

    try {
      reset();
      // If reset() returns without throwing, Next.js will unmount this component
      // on successful recovery. If the underlying segment still errors the
      // component will be re-rendered with a new error prop, resetting this state.
    } catch (err) {
      reportError(err, 'Error Boundary reset', 'error', { retryCount });
      setResetError(
        'Recovery failed. Please try again or reload the page.',
      );
      setLiveMessage('Recovery failed. Please try reloading the page.');
    } finally {
      isResettingRef.current = false;
      setRetryCount((c) => c + 1);
    }
  };

  const retriesExhausted = retryCount >= MAX_RETRIES;

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8 bg-[var(--background)]">
      {/*
       * Visually-hidden assertive live region.
       * Announces retry state changes to screen reader users immediately.
       * aria-atomic ensures the full message is read rather than just the diff.
       */}
      <div
        role="status"
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
      >
        {liveMessage}
      </div>

      <div className="max-w-md w-full text-center space-y-6">
        <div className="text-6xl" aria-hidden="true">⚠️</div>

        <h1 className="text-2xl font-bold text-gray-900">Unexpected Error</h1>

        <p className="text-gray-600">
          {retriesExhausted
            ? 'We were unable to recover after several attempts. Please reload the page or go home.'
            : 'Something went wrong on our end. Please try again or contact support if the problem persists.'}
        </p>

        {/*
         * resetError is only set when reset() itself threw. It shows a safe,
         * generic message — never the raw error details.
         */}
        {resetError && (
          <p
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
          >
            {resetError}
          </p>
        )}

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          {retriesExhausted ? (
            /*
             * After MAX_RETRIES the "Try Again" button is removed so no further
             * reset() calls can be made. A hard reload is offered instead.
             */
            <button
              onClick={() => window.location.reload()}
              className="px-5 py-2 rounded-lg bg-gray-900 text-white font-medium hover:bg-gray-700 transition-colors"
            >
              Reload Page
            </button>
          ) : (
            <button
              onClick={handleRetry}
              className="px-5 py-2 rounded-lg bg-gray-900 text-white font-medium hover:bg-gray-700 transition-colors"
            >
              Try Again
            </button>
          )}
          <Link
            href="/"
            className="px-5 py-2 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-100 transition-colors"
          >
            Go Home
          </Link>
          <a
            href="mailto:support@talenttrust.io"
            className="px-5 py-2 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-100 transition-colors"
          >
            Contact Support
          </a>
        </div>

        {retriesExhausted && (
          <p className="text-xs text-gray-400">
            If the problem persists, please{' '}
            <a
              href="mailto:support@talenttrust.io"
              className="underline hover:text-gray-600"
            >
              contact support
            </a>
            .
          </p>
        )}
      </div>
    </main>
  );
}

/**
 * Next.js App Router requires a default export for 'use client' route error
 * boundaries. `ErrorBoundary` is the single implementation; the aliases below
 * exist only so existing callers keep compiling.
 */
export const GlobalError = ErrorBoundary;
export const ErrorPage = ErrorBoundary;
export default ErrorBoundary;
