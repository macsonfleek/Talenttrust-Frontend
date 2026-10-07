'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { reportError } from '../lib/errorReporter';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * The global error boundary is the last line of defense when the root layout
 * fails. It must not throw while rendering, must not leak error details to the
 * UI, and must not report the same error more than once even under React
 * StrictMode double-invocation or re-renders.
 *
 * Invariants owned by this component:
 *  1. Error reporting is idempotent per error *identity*, not per object
 *     reference: the same failure must produce exactly one report even when
 *     Next.js hands the boundary a fresh `Error` instance carrying the same
 *     `digest` on every attempt.
 *  2. The error message, stack, and digest are never rendered in the UI.
 *  3. Reset is a consumable, single-flight transition: concurrent activations
 *     (a double click, an Enter keypress plus a click, React StrictMode)
 *     dispatch exactly one `reset()`.
 *  4. Reporting failures are swallowed so the fallback UI always renders.
 *
 * ## Concurrency invariants
 *
 * G1 (report once per identity). The identity is the digest when present,
 *     otherwise `name:message`. Reporting is keyed on that identity in a ref,
 *     so re-renders and a re-created-but-equivalent error cannot double-count
 *     one incident.
 *
 * G2 (single-flight reset). A ref, not state, guards the dispatch. State updates
 *     are asynchronous, so two clicks landing in the same tick would both read
 *     a stale `false` and issue two resets; the ref is claimed synchronously
 *     before `reset()` is called and is released only once the transition has
 *     settled, so a recovered boundary can be retried.
 *
 * G3 (no crash from the boundary itself). Every value derived from the props is
 *     re-validated: a missing/non-function `reset`, a non-Error `error`, or a
 *     non-string `digest` degrades to safe defaults. The boundary must never be
 *     the reason the app stays down, so it renders unconditionally and never
 *     throws.
 *
 * G4 (bounded, non-sensitive diagnostics). Reports carry a fixed context and a
 *     stable reason code. Nothing derived from the error's message, stack, or
 *     digest is logged, because those can embed user data.
 */

/** Stable report context for this boundary. */
const REPORT_CONTEXT = 'Global Error Boundary';

/** Report context used when the retry path itself fails. */
const RESET_REPORT_CONTEXT = 'Global Error Boundary reset';

/**
 * Identity used to decide whether an error has already been reported.
 *
 * Prefers `digest` because that is the only identifier Next.js guarantees to be
 * stable across re-serializations of the same server-side failure. Falls back to
 * `name:message` for client-side errors, which have no digest.
 *
 * Values are coerced defensively: a non-string `digest` (or a getter that
 * throws) must not be able to break the boundary's own bookkeeping.
 */
export function getErrorKey(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;

  let digest: unknown;
  try {
    digest = (error as { digest?: unknown }).digest;
  } catch {
    // A hostile `digest` getter must not take the boundary down with it.
    return null;
  }

  if (typeof digest === 'string' && digest.length > 0) {
    return `digest:${digest}`;
  }

  let name: unknown;
  let message: unknown;
  try {
    name = (error as { name?: unknown }).name;
    message = (error as { message?: unknown }).message;
  } catch {
    return null;
  }

  return `${typeof name === 'string' && name ? name : 'Error'}:${
    typeof message === 'string' ? message : ''
  }`;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  /**
   * G2: synchronous single-flight claim for the retry transition.
   *
   * Claimed before `reset()` and released in `finally`, so a rejected reset
   * still frees the control.
   */
  const resetClaimedRef = useRef(false);

  /**
   * G2 (display mirror). Derived rather than tracked separately, so the button's
   * busy state cannot disagree with the guard that actually rejects duplicates.
   */
  const [isPending, setIsPending] = useState(false);

  /** G1: identity of the last reported failure. */
  const lastReportedKeyRef = useRef<string | symbol | null>(null);

  useEffect(() => {
    const key = getErrorKey(error);
    // A failure with no usable identity is still worth reporting exactly once.
    const marker = key ?? Symbol.for('global-error:unidentified');
    if (lastReportedKeyRef.current === marker) return;
    lastReportedKeyRef.current = marker;
    // A new failure re-arms the retry affordance.
    resetClaimedRef.current = false;
    setIsPending(false);
    // G3: an invalid reset handler is a caller bug. Surface it on mount rather
    // than waiting for the user to click, so it is diagnosable from logs alone.
    if (typeof reset !== 'function') {
      reportError(
        new TypeError('Error boundary reset handler is not a function'),
        REPORT_CONTEXT,
      );
    }
    // G4: reportError already swallows reporter failures (invariant 4).
    reportError(error, REPORT_CONTEXT);
  }, [error, reset]);

  /**
   * G2/G3: dispatches at most one reset per settled transition, and never throws.
   *
   * A non-function `reset` (malformed caller, hostile stub) is reported with a
   * fixed message and otherwise ignored — the fallback UI stays usable.
   */
  const handleReset = useCallback(() => {
    if (resetClaimedRef.current) return;

    if (typeof reset !== 'function') {
      reportError(
        new TypeError('Error boundary reset handler is not a function'),
        REPORT_CONTEXT,
      );
      return;
    }

    // Claimed synchronously so two activations in the same tick cannot both pass.
    resetClaimedRef.current = true;
    setIsPending(true);

    try {
      const result: unknown = reset();

      // `reset` may return a promise. Treat it like any other async settlement:
      // the claim is released when it settles, and a rejection is reported
      // rather than becoming an unhandled rejection.
      if (typeof (result as Promise<unknown> | null)?.then === 'function') {
        void (result as Promise<unknown>)
          .catch((err: unknown) => {
            reportError(err, RESET_REPORT_CONTEXT);
          })
          .finally(() => {
            resetClaimedRef.current = false;
            setIsPending(false);
          });
        return;
      }
    } catch (err) {
      reportError(err, RESET_REPORT_CONTEXT);
    }

    // Synchronous path: the transition has already been dispatched, so the
    // affordance is released immediately rather than waiting for a microtask.
    // Next.js unmounts this boundary on success, or re-renders it with a new
    // error, which re-arms the control through the effect above.
    resetClaimedRef.current = false;
    setIsPending(false);
  }, [reset]);

  return (
    <html lang="en">
      <head>
        <title>Critical Error - TalentTrust</title>
      </head>
      <body className="min-h-screen flex flex-col items-center justify-center p-8 bg-gray-50 font-sans">
        <main className="max-w-md w-full text-center space-y-6">
          <div className="text-6xl" role="img" aria-label="critical error">
            🚮
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Critical Error</h1>
          <p className="text-gray-600">
            A critical error occurred. Please try reloading the page.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              onClick={handleReset}
              disabled={isPending}
              aria-disabled={isPending}
              aria-busy={isPending}
              className="px-5 py-2 rounded-lg bg-gray-900 text-white font-medium hover:bg-gray-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {isPending ? 'Trying...' : 'Try Again'}
            </button>
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
        </main>
      </body>
    </html>
  );
}
