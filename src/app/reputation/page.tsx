'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReputationPageContent,
  shapeReputationData,
  type ReputationPageContentProps,
} from './ReputationPageContent';
import {
  readReputationHistory,
  ReputationHistoryReadError,
} from '@/lib/readReputationHistory';
import { reportError } from '@/lib/errorReporter';
import type { Reputation, ReputationEvent } from '@/types/domain';

/**
 * Route contracts for `/reputation`.
 *
 * 1. Rendering goes through `ReputationPageContent`, the only implementation
 *    under test. The route used to carry its own copy of that component, which
 *    silently dropped the `SafeBoundary` and the history `Suspense` wrapper, so
 *    a crash in the profile took the whole route down.
 * 2. `readReputationHistory` is the only data source, and it is a *strict*,
 *    read-only snapshot: it never repairs or clears storage, and it rejects the
 *    whole snapshot rather than dropping individual entries. A rejected read
 *    therefore means the on-screen data cannot be trusted, which is a different
 *    thing from "there is no data".
 * 3. A refresh failure must not destroy data the user can already see. The last
 *    good snapshot is retained and rendered, with the failure surfaced
 *    alongside it, so a transient read failure never blanks a working profile.
 *
 * ## Concurrency invariants
 *
 * C1 (single-flight read). Every read claims a monotonically increasing token
 *     *before* touching storage, and may only commit while it still owns the
 *     newest token. A superseded read — StrictMode double-invocation, a refresh
 *     pressed while another is pending — is discarded, so the committed state is
 *     always a function of the *last requested* read and never of whichever read
 *     happened to settle last. Two clicks in one tick can therefore start at most
 *     one new read.
 *
 * C2 (no writes after unmount). An unmount bumps the token and clears the
 *     "mounted" flag, so a pending read that resolves or rejects afterwards can
 *     neither update state nor emit a diagnostic.
 *
 * C3 (idempotent retry). Refresh and Retry are the same operation: claim a token,
 *     read, commit. Both are safe to press repeatedly, and neither mutates
 *     storage, so a retry can never lose data that was already persisted.
 *
 * C4 (retained snapshot). A failed read keeps the previous successful snapshot.
 *     The failure is reported and shown, but the profile stays mounted with its
 *     unsaved component state intact, so recovery is "click Retry", not "redo all
 *     your work".
 *
 * C5 (determinism). The dataset handed to the content boundary is a pure
 *     function of the committed snapshot, so re-rendering or replaying a read of
 *     the same bytes always produces the same DOM.
 *
 * C6 (bounded, non-sensitive diagnostics). Failures are reported with a fixed
 *     message and a stable reason code. Neither the raw error, the stored bytes,
 *     nor any event payload is ever logged or rendered.
 */

/** Reason codes reported to the error pipeline; never derived from user data. */
type LoadFailureReason = 'storage-unavailable' | 'invalid-data' | 'read-failed';

/**
 * Delay before focus moves to the `<main>` landmark on mount.
 *
 * Gives the route a tick to settle so focus lands on the finished landmark
 * rather than a transient one. Exported so tests can reason about the schedule
 * without duplicating the number.
 */
export const FOCUS_ON_MOUNT_DELAY_MS = 100;

const LOAD_FAILURE_MESSAGE = 'Reputation history read failed';

/** Safe, fixed copy. Kept per-reason so the user gets an actionable next step. */
const FAILURE_COPY: Record<LoadFailureReason, string> = {
  'storage-unavailable':
    'Check browser storage access and retry. Your saved reputation history was not changed.',
  'invalid-data':
    'Saved reputation history is invalid, so it cannot be shown. Your saved data was not changed.',
  'read-failed':
    'Unable to read your reputation data. Please try again.',
};

type ReputationRouteState = {
  /** Phase of the most recent read. */
  status: 'loading' | 'ready' | 'failed';
  /** Last snapshot that validated successfully; retained across failures (C4). */
  snapshot: ReputationEvent[] | null;
  /** Reason for the most recent failure, or `null`. */
  failure: LoadFailureReason | null;
  /**
   * Why we are loading. `'initial'` before anything has ever been read, so a
   * refresh failure can show the profile while `'initial'` cannot.
   */
  pending: 'initial' | 'refresh' | null;
};

const INITIAL_STATE: ReputationRouteState = {
  status: 'loading',
  snapshot: null,
  failure: null,
  pending: 'initial',
};

/**
 * Maps any thrown value onto a bounded reason code.
 *
 * Invariant: total and non-throwing, and never derives the reason from the
 * message, so a dependency that throws a string (as some storage shims do)
 * cannot smuggle user data into the report.
 */
function classifyReadFailure(error: unknown): LoadFailureReason {
  if (error instanceof ReputationHistoryReadError) {
    return error.reason;
  }
  return 'read-failed';
}

/**
 * Reads the snapshot for the given token and commits it if still current.
 *
 * Kept outside render so the only place that touches storage is one auditable
 * function. It never writes storage, which is what makes C3 hold.
 *
 * The read is awaited because the storage seam is allowed to be asynchronous
 * (tests and future API-backed readers both rely on that). Every `await` is
 * followed by a fresh currency check, because that is the only moment at which a
 * superseded read can be recognised.
 */
async function performRead(
  token: number,
  context: {
    isCurrent: () => boolean;
    commit: (snapshot: ReputationEvent[]) => void;
    fail: (reason: LoadFailureReason) => void;
  },
): Promise<void> {
  let events: ReputationEvent[];
  try {
    events = await readReputationHistory();
  } catch (error) {
    const reason = classifyReadFailure(error);
    // C2: nothing is reported for a read that has already been superseded or
    // unmounted, so an obsolete failure cannot raise a false alarm.
    if (!context.isCurrent()) return;
    // C6: fixed message + stable code. The original error is deliberately not
    // forwarded, because it may embed storage contents.
    reportError(new Error(LOAD_FAILURE_MESSAGE), 'ReputationPage.load', 'error', {
      reason,
    });
    context.fail(reason);
    return;
  }

  if (!context.isCurrent()) return;
  context.commit([...events]);
}

const ReputationPage: React.FC = () => {
  const [state, setState] = useState<ReputationRouteState>(INITIAL_STATE);

  /**
   * C1: one token per read; only the newest may commit. Bumped synchronously so
   * two reads landing in the same React batch cannot both pass the check.
   */
  const readTokenRef = useRef(0);
  /** C2: cleared on unmount so late completions are inert. */
  const mountedRef = useRef(true);

  /**
   * Synchronous single-flight flag.
   *
   * C1 needs both halves. The token guard decides *which* read may commit, but it
   * cannot stop a second read from being *started* within the same tick, because
   * the state update that would disable the button has not been rendered yet.
   * This ref closes that window, so a burst of clicks in one batch can start at
   * most one read.
   *
   * Cleared in a `finally`, so a read that fails still frees the affordance.
   */
  const readInFlightRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Invalidate any read still in flight: bumping the token makes every
      // pending completion obsolete, so it can neither commit nor report.
      readTokenRef.current += 1;
      // Release the single-flight flag. The read it was guarding is already
      // obsolete (the token bump above guarantees that), so leaving it claimed
      // would permanently deadlock the next mount — which is exactly what React
      // StrictMode double-invocation does on every mount.
      readInFlightRef.current = false;
    };
  }, []);

  /**
   * Claims a token and performs one read.
   *
   * @param mode `'initial'` before the first successful read, `'refresh'` after.
   *   Only an `'initial'` load may replace the loading state with a failure;
   *   a refresh failure keeps the previous snapshot on screen (C4).
   */
  const runRead = useCallback((mode: 'initial' | 'refresh') => {
    // C1 (single-flight): the token guard decides *which* read may commit, but it
    // cannot stop a second read from being *started* inside the same tick,
    // because the render that would disable the button has not happened yet. This
    // ref closes that window so a burst of clicks in one batch starts at most one
    // read.
    if (readInFlightRef.current) return;
    readInFlightRef.current = true;

    const token = ++readTokenRef.current;

    setState((current) => ({
      ...current,
      status: 'loading',
      pending: mode,
    }));

    const isCurrent = () => token === readTokenRef.current && mountedRef.current;

    const commit = (snapshot: ReputationEvent[]) => {
      setState({ status: 'ready', snapshot, failure: null, pending: null });
    };

    const fail = (reason: LoadFailureReason) => {
      setState((current) => ({
        // C4: keep the last good snapshot; a read failure is not data loss.
        status: 'failed',
        snapshot: current.snapshot,
        failure: reason,
        pending: null,
      }));
    };

    // Deferred by one microtask so the `loading` state is committed and
    // announced before the read resolves. Combined with the currency checks
    // inside `performRead`, a read superseded while queued is dropped rather than
    // racing its replacement.
    void Promise.resolve()
      .then(() => performRead(token, { isCurrent, commit, fail }))
      .finally(() => {
        readInFlightRef.current = false;
      });
  }, []);

  // The only read per mount. Persistence is a browser side effect, so it lives
  // in the effect rather than in the initial state (which would also run during
  // SSR and cannot be sequenced on the client).
  useEffect(() => {
    runRead('initial');
  }, [runRead]);

  /**
   * Focus-on-mount contract (see header note 4).
   *
   * Invariant: exactly one timer, always cleared on cleanup, so an unmount or a
   * route change can never fire a stale focus request against a landmark that has
   * already been replaced. A missing landmark is a no-op rather than a throw.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      const main = document.querySelector<HTMLElement>('main');
      if (!main) return;
      main.tabIndex = -1;
      main.focus();
    }, FOCUS_ON_MOUNT_DELAY_MS);

    return () => clearTimeout(timer);
  }, []);

  // C5: the dataset handed to the content boundary is a pure derivation of the
  // committed snapshot. A copy is taken so the array identity is stable across
  // re-renders and history rows keep their keys.
  const reputationData: Reputation | null =
    state.snapshot !== null ? shapeReputationData([...state.snapshot]) : null;

  /** C3: identical to the initial read; safe to press repeatedly. */
  const handleRetry = useCallback(() => {
    runRead('refresh');
  }, [runRead]);

  const isLoading = state.status === 'loading';

  /**
   * Whether there is anything trustworthy to show.
   *
   * A failure with no retained snapshot means we know nothing about the stored
   * data, so the profile and the "no reputation yet" empty state are both
   * withheld: presenting either would be a claim we cannot support. The recovery
   * affordance below is the whole UI in that state.
   */
  const canShowContent = state.snapshot !== null || (state.failure === null && state.status !== 'loading');

  if (!canShowContent) {
    return (
      <main className="min-h-screen p-8" aria-busy={isLoading}>
        <h1 className="mb-6 text-2xl font-bold">Reputation</h1>
        {isLoading ? (
          <div className="flex items-center gap-3">
            <p role="status" aria-live="polite" aria-atomic="true">
              Loading reputation history
            </p>
            {/* Present but inert while a read is in flight: the affordance is
                announced up front and cannot be double-activated. */}
            <button
              type="button"
              onClick={handleRetry}
              disabled
              className="rounded-md bg-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 disabled:cursor-not-allowed"
            >
              Retry reputation history
            </button>
          </div>
        ) : null}
        {state.failure !== null ? (
          <div
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
            className="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-900"
          >
            <p className="text-sm">{FAILURE_COPY[state.failure]}</p>
            <button
              type="button"
              onClick={handleRetry}
              className="mt-4 rounded-md bg-red-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-800 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-red-900"
            >
              Retry reputation history
            </button>
          </div>
        ) : null}
      </main>
    );
  }

  return (
    <ReputationPageContent reputationData={reputationData}>
      {isLoading ? (
        <div className="mb-6 flex items-center gap-3">
          <p role="status" aria-live="polite" aria-atomic="true">
            Loading reputation history
          </p>
          <button
            type="button"
            onClick={handleRetry}
            disabled={isLoading}
            className="rounded-md bg-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 disabled:cursor-not-allowed"
          >
            Retry reputation history
          </button>
        </div>
      ) : null}

      {state.failure !== null ? (
        <div
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          className="mb-6 rounded-2xl border border-red-200 bg-red-50 p-6 text-red-900"
        >
          <p className="text-sm">{FAILURE_COPY[state.failure]}</p>
          <button
            type="button"
            onClick={handleRetry}
            className="mt-4 rounded-md bg-red-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-800 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-red-900"
          >
            Retry reputation history
          </button>
        </div>
      ) : null}

      {/*
        Explicit refresh, available once a snapshot is on screen. Disabled while
        a read is in flight so a burst of clicks cannot start concurrent reads
        (C1); the token guard is the backstop if the click still lands.
      */}
      {state.snapshot !== null && !isLoading ? (
        <div className="mb-6">
          <button
            type="button"
            onClick={handleRetry}
            className="rounded-md border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2"
          >
            Refresh reputation history
          </button>
        </div>
      ) : null}
    </ReputationPageContent>
  );
};

export { ReputationPageContent, type ReputationPageContentProps };

export default ReputationPage;
