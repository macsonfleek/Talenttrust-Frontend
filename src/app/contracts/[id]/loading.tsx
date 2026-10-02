import type { ReactElement } from 'react';
/**
 * loading.tsx – /contracts/[id]
 *
 * App Router Suspense boundary for the contract detail page. Composed to
 * match the exact two-column grid layout of the live page:
 *
 *   Left column (1.6fr):
 *     1. ContractSummarySkeleton  – header, value card, parties card
 *     2. ContractProgressSkeleton – progress bar + paid/outstanding cards
 *     3. MilestonesListSkeleton   – 3 milestone rows
 *
 *   Right column (minmax 320px, 1fr):
 *     4. ActionPanel skeleton     – 3 action buttons
 *
 * Accessibility:
 * - `aria-busy="true"` on <main> conveys the overall page state.
 * - Exactly one visually-hidden `role="status"` announces "Loading contract…".
 * - The complete visual skeleton is hidden from assistive technology so nested
 *   busy regions cannot produce duplicate announcements during overlapping
 *   Suspense renders.
 * - Animation is suppressed for prefers-reduced-motion users via the
 *   globals.css project-wide rule and `motion-reduce:animate-none`.
 *
 * Concurrency invariant:
 * This boundary owns no shared state, effects, timers, or request data. Every
 * render is an isolated, deterministic placeholder, so React may start,
 * discard, retry, or overlap renders without leaving stale contract details or
 * loading announcements behind.
 */

import { ContractSummarySkeleton } from '@/components/ContractSummarySkeleton';
import { ContractProgressSkeleton } from '@/components/ContractProgressSkeleton';
import { MilestonesListSkeleton } from '@/components/MilestonesListSkeleton';

const ACTION_PLACEHOLDERS = ['primary', 'secondary', 'tertiary'] as const;

// ---------------------------------------------------------------------------
// Local sub-skeletons
// ---------------------------------------------------------------------------

/** Mirrors the header card with breadcrumb and back-link button. */
const HeaderCardSkeleton = (): ReactElement => (
  <div
    aria-hidden="true"
    className="flex items-center justify-between gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
  >
    <div className="space-y-2">
      <div className="h-3.5 w-48 rounded bg-slate-200 animate-shimmer motion-reduce:animate-none" />
      <div className="h-8 w-40 rounded-lg bg-slate-200 animate-shimmer motion-reduce:animate-none" />
    </div>
    <div className="h-9 w-36 rounded-2xl bg-slate-200 animate-shimmer motion-reduce:animate-none" />
  </div>
);

/** Mirrors the ActionPanel right-column card with 3 action buttons. */
const ActionPanelSkeleton = (): ReactElement => (
  <div
    aria-hidden="true"
    data-testid="action-panel-skeleton"
    className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm space-y-4"
  >
    <div className="h-5 w-32 rounded-lg bg-slate-200 animate-shimmer motion-reduce:animate-none" />
    <div className="space-y-3">
      {ACTION_PLACEHOLDERS.map((slot) => (
        <div
          key={slot}
          data-skeleton-slot={`contract-action-${slot}`}
          className="h-10 w-full rounded-2xl bg-slate-200 animate-shimmer motion-reduce:animate-none"
        />
      ))}
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Route loading export
// ---------------------------------------------------------------------------

export default function ContractDetailLoading() {
  return (
    <main
      data-testid="contract-detail-loading"
      className="min-h-screen bg-slate-50 px-4 py-8 sm:px-6 lg:px-8"
      aria-busy="true"
    >
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        Loading contract…
      </span>

      <div
        aria-hidden="true"
        data-loading-layout="contract-detail"
        className="mx-auto max-w-screen-2xl space-y-6"
      >
        {/* Header card – breadcrumb + back button */}
        <HeaderCardSkeleton />

        {/* Two-column content grid – matches live page layout */}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
          {/* Left column */}
          <div className="space-y-6">
            <ContractSummarySkeleton />
            <ContractProgressSkeleton />
            <MilestonesListSkeleton />
          </div>

          {/* Right column */}
          <div className="space-y-6">
            <ActionPanelSkeleton />
          </div>
        </div>
      </div>
    </main>
  );
}

