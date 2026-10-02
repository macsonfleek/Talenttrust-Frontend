'use client';

import React, { Component, type ReactNode } from 'react';
import { reportError } from '@/lib/errorReporter';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MilestonesErrorBoundaryProps {
  /** Content to protect. */
  children: ReactNode;
  /**
   * Optional override for the fallback UI. When provided it replaces the
   * built-in accessible fallback entirely — the consumer is responsible for
   * rendering a retry affordance if desired.
   */
  fallback?: ReactNode;
  /**
   * Optional callback fired after an error is caught, in addition to the
   * internal `reportError` call. Useful for testing or custom instrumentation.
   */
  onError?: (error: Error, info: React.ErrorInfo) => void;
  /** Stable, user-facing name for the isolated board subtree. */
  sectionName?: MilestonesSection;
}

interface State {
  hasError: boolean;
  retryKey: number;
  error?: Error;
}

/** Public error code used by dashboards and tests without exposing internals. */
export const MILESTONES_SECTION_ERROR_CODE = 'MILESTONES_SECTION_FAILED' as const;

export type MilestonesSection = 'milestones' | 'filters' | 'actions' | 'milestone list';

export interface MilestonesSectionErrorMeta extends Record<string, unknown> {
  code: typeof MILESTONES_SECTION_ERROR_CODE;
  section: MilestonesSection;
  componentStack?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * MilestonesErrorBoundary
 *
 * An error boundary scoped to the milestones section. When a descendant
 * throws during render, the boundary:
 *   1. Reports the error via `reportError` (the existing error-reporter seam).
 *   2. Renders an accessible fallback UI with a visible "Try again" button.
 *   3. Resets its own state on retry so the milestones section re-mounts.
 *
 * Accessibility:
 *   - The fallback container uses `role="alert"` so assistive-technology users
 *     are immediately informed that the section failed.
 *   - The "Try again" button receives focus automatically (via `autoFocus`)
 *     when the fallback renders, providing a clear keyboard entry point.
 *   - All interactive elements meet WCAG 2.4.7 focus-visible requirements.
 */
export default class MilestonesErrorBoundary extends Component<
  MilestonesErrorBoundaryProps,
  State
> {
  state: State = { hasError: false, retryKey: 0, error: undefined };

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  static getDerivedStateFromError(_error: Error): Partial<State> {
    // Returns a *partial* update on purpose: React merges it, so `retryKey`
    // survives the catch. The error itself is deliberately not stored — it is
    // reported through `componentDidCatch` and never rendered, so the boundary
    // state stays a small, serialisable pair instead of carrying an Error
    // across renders.
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const metadata: MilestonesSectionErrorMeta = {
      code: MILESTONES_SECTION_ERROR_CODE,
      section: this.props.sectionName ?? 'milestones',
      componentStack: info.componentStack ?? undefined,
    };
    reportError(error, 'MilestonesErrorBoundary', 'error', metadata);
    this.props.onError?.(error, info);
  }

  // ------------------------------------------------------------------
  // Handlers
  // ------------------------------------------------------------------

  /** Clears the error state so the children are re-mounted on the next render. */
  handleRetry = (): void => {
    this.setState((current) => ({
      hasError: false,
      retryKey: current?.retryKey ?? 0,
    }));
  };

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  render(): ReactNode {
    const { hasError, retryKey } = this.state;
    const { children, fallback, sectionName = 'milestones' } = this.props;

    if (!hasError) {
      // A key guarantees a clean subtree after retry, which clears failed
      // child state and re-runs mount-time data reads.
      return <React.Fragment key={retryKey}>{children}</React.Fragment>;
    }

    // Custom fallback supplied by the consumer takes full precedence.
    if (fallback !== undefined) {
      return fallback;
    }

    // ----------------------------------------------------------------
    // Built-in accessible fallback
    // ----------------------------------------------------------------
    return (
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center shadow-sm"
      >
        <p className="text-base font-semibold text-red-800">
          The {sectionName} section couldn&rsquo;t load.
        </p>

        <p className="mt-2 text-sm text-red-700">
          This is likely a temporary issue. Use the button below to try again.
        </p>

        <button
          type="button"
          autoFocus
          onClick={this.handleRetry}
          className={[
            'mt-4 inline-flex items-center gap-2 rounded-xl',
            'bg-red-700 px-4 py-2 text-sm font-semibold text-white',
            'transition hover:bg-red-800',
            'focus-visible:outline focus-visible:outline-4',
            'focus-visible:outline-offset-2 focus-visible:outline-red-600',
          ].join(' ')}
        >
          Try again
        </button>
      </div>
    );
  }
}
