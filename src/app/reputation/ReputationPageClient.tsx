'use client';

import { useEffect, useRef } from 'react';
import { ReputationPageContent } from './ReputationPageContent';
import { reportError } from '@/lib/errorReporter';
import type { Reputation } from '@/types/domain';

export type ReputationPageClientProps = {
  reputationData?: Reputation | null;
  userName?: string;
  /**
   * Optional override for the focus target selector. Defaults to the first
   * <main> element in the document, falling back to the component's own ref.
   */
  focusSelector?: string;
  /**
   * Optional delay (in ms) before focusing the main content. Defaults to 100.
   */
  focusDelayMs?: number;
};

export const DEFAULT_FOCUS_SELECTOR = 'main';
export const DEFAULT_FOCUS_DELAY_MS = 100;

/**
 * Delay before each focus attempt, giving the route time to settle before the
 * landmark exists or becomes focusable. Exported so tests can reason about the
 * schedule without duplicating the magic number.
 */
export const FOCUS_DELAY_MS = 100;

/**
 * Upper bound on focus attempts. Focus is best-effort and must never trap the
 * page in an unbounded retry loop; after this many attempts (each separated by
 * {@link FOCUS_DELAY_MS}) the failure is reported once and we stop.
 */
export const MAX_FOCUS_ATTEMPTS = 5;

/**
 * Report context used for all diagnostics emitted by this component. Kept
 * free of user data (no name, no score) so failures remain non-sensitive.
 */
const FOCUS_REPORT_CONTEXT = 'ReputationPageClient: focus';

/**
 * A node can receive focus only if it is a connected `HTMLElement` exposing a
 * `focus` method. Guarded for non-DOM environments (SSR, jsdom stubs).
 *
 * Invariant: `resolveFocusTarget` and `applyFocus` never attempt work on a
 * detached, non-element, or focus-less node, so a stale ref from a previous
 * mount can never steal focus.
 */
export function isFocusableElement(node: unknown): node is HTMLElement {
  return (
    typeof HTMLElement !== 'undefined' &&
    node instanceof HTMLElement &&
    node.isConnected === true &&
    typeof (node as HTMLElement).focus === 'function'
  );
}

/**
 * Resolves the focus target deterministically:
 *
 * 1. The wrapper's own `<main ref>` is preferred. This guarantees the focused
 *    landmark is *this* component's, independent of how many `<main>` elements
 *    the surrounding document renders (e.g. the nested `<main>` rendered by
 *    `ReputationPageContent`). This is the determinism fix over a bare
 *    `document.querySelector('main')`.
 * 2. Falling back to the first document `<main>` preserves the legacy behaviour
 *    for callers that render this component without a focusable ref.
 *
 * @returns the element to focus, or `null` when no valid target exists.
 */
export function resolveFocusTarget(ref: HTMLElement | null): HTMLElement | null {
  if (isFocusableElement(ref)) {
    return ref;
  }

  if (typeof document === 'undefined') {
    return null;
  }

  const queried = document.querySelector('main');
  return isFocusableElement(queried) ? queried : null;
}

/**
 * Moves focus to `target` without ever throwing. A rejected/aborted `focus()`
 * call (or a no-op focus) is a recoverable condition, not a crash: the caller
 * retries and, on exhaustion, reports the failure.
 *
 * @returns `true` when focus actually landed on the target.
 */
export function applyFocus(target: HTMLElement | null): boolean {
  if (!isFocusableElement(target)) {
    return false;
  }

  try {
    target.focus();
    // `document.activeElement` is the only reliable signal that the browser
    // accepted the focus request. If it did not, treat the attempt as failed
    // so the bounded retry loop can try again.
    return document.activeElement === target;
  } catch (error) {
    reportError(error, FOCUS_REPORT_CONTEXT, 'warn');
    return false;
  }
}

/**
 * Client wrapper for the reputation page that manages focus on mount.
 *
 * When the reputation page is navigated to, this component:
 * 1. Stores the previously focused element (for potential restoration).
 * 2. Focuses this component's `<main>` landmark for keyboard and
 *    screen-reader users.
 *
 * Failure recovery / determinism invariants:
 * - Target resolution prefers this component's own ref, so the outcome does
 *   not depend on document-wide ordering of `<main>` elements.
 * - Focus is attempted at most {@link MAX_FOCUS_ATTEMPTS} times, one timer per
 *   attempt, so a slow-to-render route recovers without an unbounded loop.
 * - A `cancelled` closure flag plus timer cleanup means an unmounted or
 *   superseded mount can never focus a stale node (concurrent mount/unmount is
 *   safe and cannot produce an inconsistent focus state).
 * - Every failure is observable through the central `reportError` seam and
 *   carries no user data; focus failure is non-fatal to rendering, so no user
 *   data is ever lost.
 */
export default function ReputationPageClient({
  reputationData,
  userName = 'User',
  focusSelector = DEFAULT_FOCUS_SELECTOR,
  focusDelayMs = DEFAULT_FOCUS_DELAY_MS,
}: ReputationPageClientProps) {
  const mainRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Store the previously focused element when the page mounts. Focus
    // restoration on navigation away is deliberately delegated to the global
    // RouteAnnouncer; this ref is informational to avoid double-restoring.
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const attemptFocus = () => {
      // A later attempt from a superseded/unmounted mount must be a no-op.
      if (cancelled) {
        return;
      }

      attempts += 1;

      if (applyFocus(resolveFocusTarget(mainRef.current))) {
        return;
      }

      if (attempts >= MAX_FOCUS_ATTEMPTS) {
        // Observability: one diagnostic per failed mount, no PII, actionable.
        reportError(
          new Error('Unable to focus the reputation main landmark'),
          FOCUS_REPORT_CONTEXT,
          'warn',
          { attempts },
        );
        return;
      }

      timer = setTimeout(attemptFocus, FOCUS_DELAY_MS);
    };

    // Focus after a small delay to ensure the DOM is ready.
    timer = setTimeout(attemptFocus, FOCUS_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimer();
    };
  }, [focusSelector, focusDelayMs]);

  return (
    <main ref={mainRef} className="min-h-screen p-8" tabIndex={-1}>
      <ReputationPageContent reputationData={reputationData} userName={userName} />
    </main>
  );
}
