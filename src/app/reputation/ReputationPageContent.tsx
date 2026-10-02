'use client';

import React, { Suspense, type ReactNode } from 'react';
import EmptyState from '../../components/EmptyState';
import ReputationProfile, { resolveReputationLevel } from '../../components/ReputationProfile';
import ReputationSummaryCard from '../../components/ReputationSummaryCard';
import SafeBoundary from '../../components/SafeBoundary';
import type { Reputation, ReputationEvent } from '@/types/domain';

/**
 * Seed score for a reputation profile. The only reputation data source today
 * is the local event store; the documented API integration
 * (docs/components/ReputationPage.md → "API Integration (Future)") replaces
 * this seed with a real score. It lives here, next to the shaping helper,
 * rather than inline in a caller.
 */
export const REPUTATION_DEMO_SCORE = 4.5;

/** Scale the documented reputation bands are expressed against. */
const REPUTATION_MAX_SCORE = 5;

/**
 * Shapes persisted reputation events into the page's `Reputation` model.
 *
 * Level is always derived from the score bands (`resolveReputationLevel`)
 * rather than a caller-supplied literal, so score and level cannot disagree.
 * An empty history is still a profile: it renders the documented "partial
 * reputation" state instead of falling back to the empty state.
 */
export function shapeReputationData(history: ReputationEvent[]): Reputation {
  return {
    score: REPUTATION_DEMO_SCORE,
    level: resolveReputationLevel(REPUTATION_DEMO_SCORE, REPUTATION_MAX_SCORE),
    history,
  };
}

export type ReputationPageContentProps = {
  reputationData?: Reputation | null;
  userName?: string;
  /**
   * Route-level status and recovery regions rendered above the profile or
   * empty state, inside the same `<main>` landmark and `SafeBoundary`.
   */
  children?: ReactNode;
};

type ReputationPageInput = {
  reputationData: Reputation | null;
  userName: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidReputationEvent(value: unknown): value is ReputationEvent {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    typeof value.type !== 'string' ||
    !value.type.trim() ||
    typeof value.summary !== 'string' ||
    !value.summary.trim() ||
    typeof value.date !== 'string' ||
    !value.date.trim() ||
    Number.isNaN(Date.parse(value.date))
  ) {
    return false;
  }

  // `version` follows the same rule as the storage reader
  // (`readReputationHistory`): absent, or a safe integer starting at 1.
  // Keeping the two in step guarantees a snapshot the reader accepts is never
  // rejected here, so the route cannot disagree with itself about what counts
  // as valid persisted history.
  return (
    value.version === undefined ||
    (typeof value.version === 'number' &&
      Number.isSafeInteger(value.version) &&
      value.version >= 1)
  );
}

/**
 * Validates and normalizes untrusted reputation input before it reaches child
 * components.
 *
 * Design decision: an invalid dataset is rejected **as a whole**, and the page
 * falls back to the documented "no reputation yet" state. Partially trusting a
 * dataset would be worse than rejecting it, because a dropped history entry is
 * silent data loss the user cannot detect, while a rejected dataset is visible
 * and explainable.
 *
 * Invariants:
 *  - Total: any input produces a result, including malformed ones. The function
 *    never throws, so an untrusted payload can never crash the route.
 *  - Deterministic and idempotent: the result depends only on the arguments, so
 *    repeated or concurrent renders of the same input cannot disagree. Calling it
 *    with its own output is a no-op.
 *  - Rejects negative, `NaN` and `Infinity` scores; `0` is a valid score.
 *  - Rejects a history containing a malformed event or a duplicate `id`, so the
 *    list rendered on screen always matches what was persisted.
 *  - Preserves every optional `Reputation` field it does not itself validate,
 *    so adding a field to the model does not silently drop it at this boundary.
 *
 * @param reputationData - Untrusted reputation dataset, possibly absent.
 * @param userName - Untrusted display name; blank or non-string falls back.
 * @returns The validated dataset (or `null`) plus a safe display name.
 */
export function normalizeReputationPageInput(
  reputationData: Reputation | null | undefined,
  userName: string | undefined,
): ReputationPageInput {
  const safeUserName = typeof userName === 'string' && userName.trim() ? userName : 'User';

  if (!isRecord(reputationData)) {
    return { reputationData: null, userName: safeUserName };
  }

  const score = reputationData.score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) {
    return { reputationData: null, userName: safeUserName };
  }

  const rawHistory = reputationData.history;
  if (rawHistory !== undefined && !Array.isArray(rawHistory)) {
    return { reputationData: null, userName: safeUserName };
  }

  const history = rawHistory ?? [];
  const seenIds = new Set<string>();
  for (const event of history) {
    if (!isValidReputationEvent(event) || seenIds.has(event.id)) {
      // Reject the whole dataset rather than silently dropping user history.
      return { reputationData: null, userName: safeUserName };
    }
    seenIds.add(event.id);
  }

  const level = reputationData.level;
  if (level !== undefined && (typeof level !== 'string' || !level.trim())) {
    return { reputationData: null, userName: safeUserName };
  }

  return {
    reputationData: {
      // Spread first so fields this boundary does not validate (maxScore,
      // lastUpdated, …) survive; the fields validated above are then
      // overwritten with their sanitized values.
      ...reputationData,
      score,
      level,
      history,
    },
    userName: safeUserName,
  };
}

/**
 * Renders the reputation route's body.
 *
 * Invariant: untrusted input is normalized exactly once, before any JSX is
 * built. Because `normalizeReputationPageInput` is a pure function of its
 * inputs, this is also the concurrency guard: any number of concurrent renders
 * (React StrictMode double-invocation, a retried render, a suspense replay)
 * computes the identical dataset, so no render can observe a partially
 * normalized view. Referencing an un-normalized prop here — as this component
 * previously did — made the route throw mid-render and take the whole page down.
 *
 * The empty state and the profile are mutually exclusive: exactly one `<h1>`
 * and exactly one `<main>` are mounted in either branch.
 */
export function ReputationPageContent({
  reputationData,
  userName,
  children = null,
}: ReputationPageContentProps) {
  const { reputationData: safeReputationData, userName: safeUserName } =
    normalizeReputationPageInput(reputationData, userName);

  const score = safeReputationData?.score;
  const hasReputation =
    typeof score === 'number' && Number.isFinite(score) && score >= 0;
  const suppliedMaxScore = safeReputationData?.maxScore;
  const maxScore =
    typeof suppliedMaxScore === 'number' &&
    Number.isFinite(suppliedMaxScore) &&
    suppliedMaxScore > 0
      ? suppliedMaxScore
      : undefined;

  // `!safeReputationData` narrows the type for the profile branch; `hasReputation`
  // is already implied by normalization, but is kept explicit so the empty state
  // can never be skipped if the normalizer's rules are relaxed later.
  return (
    <SafeBoundary>
      {!safeReputationData || !hasReputation ? (
        <main className="min-h-screen p-8">
          <h1 className="text-2xl font-bold mb-6">Reputation</h1>
          {children}
          <EmptyState
            illustration="reputation"
            title="No reputation yet"
            description="Your reputation will be built as you complete contracts and receive feedback from clients. Start by creating and fulfilling your first contract."
          />
        </main>
      ) : (
        <main className="min-h-screen p-8">
          <h1 className="text-2xl font-bold mb-6">Reputation</h1>
          {children}
          <ReputationSummaryCard
            name={safeUserName}
            score={score}
            maxScore={maxScore}
            level={safeReputationData.level}
            history={safeReputationData.history}
          />
          <Suspense fallback={null}>
            <ReputationProfile
              name={safeUserName}
              score={score}
              maxScore={maxScore}
              level={safeReputationData.level}
              history={safeReputationData.history}
              lastUpdated={safeReputationData.lastUpdated}
            />
          </Suspense>
        </main>
      )}
    </SafeBoundary>
  );
}
