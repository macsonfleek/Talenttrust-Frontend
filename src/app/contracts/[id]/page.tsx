'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import Breadcrumbs from '@/components/Breadcrumbs';
import ContractSummary from '@/components/ContractSummary';
import MilestonesList from '@/components/MilestonesList';
import ActionPanel from '@/components/ActionPanel';
import ContractProgress from '@/components/ContractProgress';
import { ContractProgressSkeleton } from '@/components/ContractProgressSkeleton';
import { ContractSummarySkeleton } from '@/components/ContractSummarySkeleton';
import { MilestonesListSkeleton } from '@/components/MilestonesListSkeleton';
import ContractStatusAnnouncer from '@/components/ContractStatusAnnouncer';
import SafeBoundary from '@/components/SafeBoundary';
import OfflineIndicator from '@/components/OfflineIndicator';
import { resolveContractData, ContractData } from '@/lib/contractResolver';
import { useToast } from '@/components/toast/toast-provider';
import { reportError } from '@/lib/errorReporter';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import {
  listMilestonesByContract,
  updateMilestone,
} from '@/lib/repository';
import { cacheContractData, getCachedContractData } from '@/lib/contractCache';
import { isValidContractId } from '@/lib/validateContractId';
import { validateMilestonePatch } from '@/lib/validateMilestonePatch';
import {
  useOptimisticContractStatus,
  type BuildPersistedContract,
} from '@/hooks/useOptimisticContractStatus';
import type { Milestone } from '@/types/domain';

/**
 * Per-contract in-flight mutation guard.
 *
 * Prevents duplicate concurrent status transitions for the same contract from
 * racing each other. The first caller acquires the lock; subsequent callers
 * while the lock is held are rejected deterministically instead of producing
 * interleaved optimistic updates or duplicate repository writes.
 */

/**
 * Per-contract in-flight milestone mutation guard, keyed by `contractId`.
 *
 * Ensures that two concurrent milestone patches for the same contract cannot
 * both snapshot the same baseline and then clobber each other on rollback.
 */

/**
 * Validation boundaries for the contract detail route.
 *
 * The route param `id` is untrusted input: it arrives from the URL, may be
 * replayed, duplicated, or crafted adversarially, and is used both as a
 * lookup key and as a persistence key. These constants define the single
 * source of truth for what is considered a valid contract id so that every
 * entry point (initial load, cache lookup, persistence, copy, render)
 * enforces the same invariants.
 *
 * Invariants:
 * - A contract id is a non-empty string of at most {@link MAX_CONTRACT_ID_LENGTH}
 *   characters.
 * - It must match {@link CONTRACT_ID_PATTERN}: alphanumerics, hyphens, and
 *   underscores only. This prevents path traversal, whitespace smuggling,
 *   and control characters from reaching the resolver, cache, or repository.
 * - Validation is pure and side-effect free so it can be reused by tests and
 *   by both the server-rendered boundary and the client content component.
 */
export const MAX_CONTRACT_ID_LENGTH = 128;
export const CONTRACT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Determines whether `id` is a structurally valid contract identifier.
 *
 * This is the canonical boundary check. It rejects:
 * - non-string input (defensive against malformed route params),
 * - empty or whitespace-only ids,
 * - ids longer than {@link MAX_CONTRACT_ID_LENGTH},
 * - ids containing characters outside {@link CONTRACT_ID_PATTERN}.
 *
 * @param id - The candidate contract id from the route.
 * @returns `true` when the id is safe to use as a lookup and persistence key.
 */
export function isValidContractIdBoundary(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > MAX_CONTRACT_ID_LENGTH) return false;
  return CONTRACT_ID_PATTERN.test(id);
}

/**
 * Maximum number of automatic retry attempts for transient load failures.
 * Kept small so recovery stays bounded and deterministic.
 */
const MAX_LOAD_RETRIES = 2;

/**
 * Base delay (ms) for exponential backoff between load retries.
 */
const LOAD_RETRY_BASE_DELAY_MS = 300;

/**
 * Classifies an error as retryable (transient) or terminal.
 *
 * Retryable failures are network/abort-like conditions where a bounded retry
 * can plausibly succeed. Terminal failures (validation, not-found, auth) must
 * not be retried because they would produce the same result and could mask
 * authorization or validation invariants.
 *
 * @param error - The thrown value from a load attempt.
 * @returns `true` when a bounded retry is safe.
 */
function isRetryableLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (message.includes('not found') || message.includes('unauthor')) return false;
  if (message.includes('invalid')) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Contract status transition invariants
// ---------------------------------------------------------------------------

/**
 * Allowed status transitions for a contract.
 *
 * Invariant: a contract may only move to a status reachable from its current
 * one. Transitions not listed here are rejected deterministically without a
 * repository write, preventing silent inconsistent state.
 *
 * This table is the single source of truth for `/contracts/[id]`. It is
 * deliberately *not* shared with `validateContractStatusTransition`: that
 * validator treats `Disputed` as terminal, whereas this route supports
 * re-opening a disputed contract to `Active` once the dispute is resolved.
 * Sharing one table would silently break that flow, so the divergence is
 * asserted by `__tests__/compatibilityContracts.test.tsx` instead.
 *
 * State machine:
 *   Active    → Completed | Disputed
 *   Pending   → Active   | Disputed
 *   Disputed  → Active             (re-opens after dispute resolution)
 *   Completed → (terminal — no further transitions)
 */
const ALLOWED_TRANSITIONS: Record<ContractData['status'], ContractData['status'][]> = {
  Active: ['Completed', 'Disputed'],
  Pending: ['Active', 'Disputed'],
  Disputed: ['Active'],
  Completed: [],
};

/**
 * Returns `true` when moving `from` → `to` is a valid state transition.
 *
 * Invariant: duplicate transitions (`from === to`) return `false`, so a caller
 * can short-circuit without producing a persistence round-trip. An unknown
 * `from` (defensive: cached data may be stale or hand-edited) also returns
 * `false`, so bad data can never authorise a transition.
 *
 * @param from - The current contract status.
 * @param to   - The desired next contract status.
 */
export function isAllowedTransition(
  from: ContractData['status'],
  to: ContractData['status'],
): boolean {
  if (from === to) return false;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

// ---------------------------------------------------------------------------
// Milestone merge helper
// ---------------------------------------------------------------------------

/**
 * Merges the contract's resolved milestones with any milestones persisted in
 * the repository under the same `contractId`, de-duplicating by `id`.
 *
 * Persisted records take precedence over resolver records that share an id,
 * since the repository holds the most recently edited state.
 *
 * @param baseMilestones - Milestones returned by `resolveContractData`.
 * @param contractId - The contract id to filter persisted milestones by.
 * @returns The merged, de-duplicated milestone list for this contract.
 */
function mergeContractMilestones(
  baseMilestones: Milestone[],
  contractId: string,
): Milestone[] {
  const merged = new Map<string, Milestone>();
  baseMilestones.forEach((milestone) => merged.set(milestone.id, milestone));
  listMilestonesByContract(contractId).forEach((milestone) =>
    merged.set(milestone.id, milestone),
  );
  return Array.from(merged.values());
}

// ---------------------------------------------------------------------------
// Page content component
// ---------------------------------------------------------------------------

interface ContractDetailPageProps {
  params: Promise<{ id: string }>;
}

const ContractDetailPageContent = ({ id }: { id: string }) => {
  const [contractData, setContractData] = useState<ContractData | null>(null);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPersistingStatus, setIsPersistingStatus] = useState(false);
  const [isUsingCachedData, setIsUsingCachedData] = useState(false);
  const [cachedAt, setCachedAt] = useState<string | undefined>(undefined);
  const [isDataStale, setIsDataStale] = useState(false);
  const milestonesRef = useRef(milestones);
  milestonesRef.current = milestones;

  /**
   * Monotonic token for the newest load.
   *
   * Invariant: every effect run and every user-requested retry bumps this, and a
   * completion may only touch state when its own token is still the newest. That
   * is what makes overlapping loads (a retry fired while the first is still
   * awaiting, a navigation to another contract, React StrictMode
   * double-invocation) unable to commit a stale snapshot.
   */
  /** True while the component is mounted; suppresses post-unmount writes. */
  const isMountedRef = useRef(true);

  /** Aborts the in-flight resolver so a superseded load stops early. */
  const loadAbortRef = useRef<AbortController | null>(null);

  /**
   * Automatic retries consumed by the current load.
   *
   * Invariant: reset to 0 at the start of every `loadContract` call, including
   * each recursive retry, so the budget is per-attempt-chain and can never grow
   * without bound across a long-lived component.
   */
  const loadAttemptRef = useRef(0);

  /**
   * Retry counter for this contract.
   *
   * Invariant: state, not a ref, because the effect that owns the load lists it
   * as a dependency — a retry must schedule a *new* effect run. Reset to 0
   * whenever `id` changes so a new contract never inherits the previous
   * contract's retry budget.
   */
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      // Mark unmounted and abort the in-flight load, so a resolution that lands
      // after teardown cannot write to state or touch the cache.
      isMountedRef.current = false;
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    setLoadAttempt(0);
  }, [id]);

  /**
   * Synchronous duplicate-submission guard for the *status* mutation.
   *
   * Invariant: claimed before `persistStatus` is called and released in
   * `finally`, so two rapid confirmations produce exactly one repository write
   * and a failed write still frees the slot for a retry. `isPersistingStatus`
   * state is the display mirror only.
   */
  const isPersistingStatusRef = useRef(false);

  /**
   * Ids with a milestone write currently in flight.
   *
   * Invariant: an id is added immediately before the repository write and
   * removed in `finally`, so a re-entrant call (double-invoke, a listener that
   * fires inside `updateMilestone`) is rejected instead of issuing a second
   * write, and a throwing write still frees the slot for a retry. Never left
   * populated across renders.
   */
  const inFlightMilestoneMutations = useRef(new Set<string>());

  const { showError, showSuccess } = useToast();
  const isOnline = useOnlineStatus();

  const { copied, copy } = useCopyToClipboard({
    delay: 2000,
    onSuccess: () => {
      /* istanbul ignore next -- toast side effect */
      showSuccess({
        title: 'Contract ID copied',
        description: 'The contract identifier has been copied to your clipboard.',
      });
    },
    onError: (err) => {
      if (err instanceof Error && err.message.includes('supported')) {
        showError({
          title: 'Copy not supported',
          description: 'Your browser does not support clipboard access. Please copy the ID manually.',
        });
      } else {
        showError({
          title: 'Copy failed',
          description: 'Unable to copy the contract ID to your clipboard. Please try again.',
        });
      }
    },
  });

  /**
   * Maps the resolved contract detail shape into the repository contract shape.
   *
   * The repository stores summary-friendly contract records, so the detail page
   * narrows `ContractData` into the fields that persistence already expects.
   * `version` is threaded through from {@link useOptimisticContractStatus} so
   * the repository's stale-overwrite guard compares against the correct baseline.
   *
   * Invariant: all fields are derived from the already-resolved `data`; no
   * defaults are silently injected so the shape is always deterministic.
   */
  const buildPersistedContract: BuildPersistedContract = useCallback(
    (data, status, version) => ({
      id: data.id,
      contractName: data.name,
      // NOTE: `parties` is copied by reference; callers must not mutate it.
      parties: data.parties,
      totalValue: data.totalValue,
      currency: data.currency,
      status,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      milestoneCount: data.milestones.length,
      version,
    }),
    [],
  );

  const persistStatus = useOptimisticContractStatus(
    contractData,
    setContractData,
    buildPersistedContract,
  );
  const persistStatusRef = useRef(persistStatus);
  persistStatusRef.current = persistStatus;

  /**
   * Applies a contract status transition optimistically, then persists it.
   *
   * Invariants enforced before any side-effect:
   *  1. Mutations are rejected when the device is offline.
   *  2. Mutations are rejected when serving stale cached data.
   *  3. The transition must be allowed by the {@link ALLOWED_TRANSITIONS} table.
   *     Duplicate transitions (same status → same status) are silently ignored.
   *     Invalid transitions surface a clear error.
   *
   * On failure — including a stale-overwrite rejection — the optimistic change
   * is rolled back and a specific error is surfaced via both the inline
   * `ActionPanel` banner and a dismissible toast. Sensitive identifiers are
   * never included in user-visible messages.
   *
   * @param nextStatus - The status to persist to the repository.
   * @param successTitle - The toast title shown after a successful write.
   * @param successDescription - The toast description shown after success.
   */
  const persistContractStatus = useCallback(
    (
      nextStatus: ContractData['status'],
      successTitle: string,
      successDescription: string,
    ) => {
      // Guard 1: offline
      if (!isOnline) {
        showError({
          title: 'Cannot update contract while offline',
          description: 'Please connect to the internet to make changes to this contract.',
        });
        return;
      }

      // Guard 2: stale cached data
      if (isUsingCachedData && isDataStale) {
        showError({
          title: 'Cannot update stale data',
          description: 'Please refresh the page to load the latest data before making changes.',
        });
        return;
      }

      // Guard 3: validate transition deterministically before any side-effect
      if (contractData) {
        const currentStatus = contractData.status;

        // Duplicate transition — no-op (idempotent)
        if (currentStatus === nextStatus) {
          return;
        }

        // Invalid transition — surface a clear, safe error without touching the
        // repository. The message names the statuses but never the contract id,
        // so it is safe to render and to log.
        if (!isAllowedTransition(currentStatus, nextStatus)) {
          const error = `Cannot transition from '${currentStatus}' to '${nextStatus}'.`;
          setErrorMessage(error);
          showError({
            title: 'Invalid status transition',
            description: error,
          });
          return;
        }
      }

      // Duplicate-submission guard: ignore re-entrant calls while a status
      // write is already in flight. Without this, a double-invocation could
      // issue two repository writes for one user action.
      if (isPersistingStatusRef.current) {
        return;
      }

      setIsPersistingStatus(true);
      isPersistingStatusRef.current = true;
      setErrorMessage(null);

      try {
        const persistStatus = persistStatusRef.current;
        const result = persistStatus(nextStatus);

        if (!result.ok) {
          setErrorMessage(result.error);
          showError({
            title: 'Unable to update contract',
            description: result.error,
          });
          return;
        }

        setErrorMessage(null);
        showSuccess({
          title: successTitle,
          description: successDescription,
        });
      } finally {
        // Released on every path, including a throwing repository, so a failed
        // write can never leave the control permanently disabled.
        isPersistingStatusRef.current = false;
        setIsPersistingStatus(false);
      }
    },
    [persistStatus, showError, showSuccess, isOnline, isUsingCachedData, isDataStale, contractData],
  );

  /**
   * Loads contract data from the network or falls back to the cache.
   *
   * The function is extracted from the effect body so it can be called both on
   * mount and whenever `isOnline` flips from `false` → `true`, enabling
   * automatic re-validation when connectivity is restored.
   *
   * Concurrency safety: an `AbortController` is created each time the effect
   * runs. All state updates are guarded by `isMountedRef.current`, so a
   * stale promise that resolves after the component unmounts or the effect
   * re-fires cannot produce an inconsistent state update.
   */
  useEffect(() => {
    let isCurrentRequest = true;

    const loadContract = async () => {
      // The retry budget is per *chain*, so it is reset exactly once here.
      // The recursive retry below must re-enter this function without the
      // reset, otherwise every attempt restarts the counter and a persistently
      // failing contract retries forever instead of falling back to cache.
      loadAttemptRef.current = 0;
      return runLoadAttempt();
    };

    const runLoadAttempt = async (): Promise<void> => {
      // Abort any in-flight load from a previous effect run so concurrent
      // executions cannot race and clobber newer state. Declared outside the
      // try so the retry path can observe the abort signal too.
      loadAbortRef.current?.abort();
      const abortController = new AbortController();
      loadAbortRef.current = abortController;
      const isAborted = () => abortController.signal.aborted;

      try {
        setIsLoading(true);
        setErrorMessage(null);

        // Boundary check: never touch cache, resolver, or repository with an
        // invalid id. This guards against malformed params that bypass the
        // server-side notFound() boundary (e.g. programmatic navigation).
        if (!isValidContractIdBoundary(id)) {
          if (isMountedRef.current) {
            setErrorMessage('Invalid contract identifier.');
            setIsLoading(false);
          }
          return;
        }

        // If offline, try to load from cache first
        if (!isOnline) {
          const cachedResult = getCachedContractData(id);
          if (cachedResult.success && cachedResult.data) {
            if (isCurrentRequest) {
              setContractData(cachedResult.data);
              setMilestones(mergeContractMilestones(cachedResult.data.milestones, id));
              setIsUsingCachedData(true);
              setIsDataStale(cachedResult.stale || false);
              setCachedAt(cachedResult.data.updatedAt);
              setIsLoading(false);
            }
            return;
          }
          // No cache available when offline - show error
          if (isCurrentRequest) {
            setErrorMessage(
              'You are offline and this contract has not been loaded before. Please connect to the internet and try again.',
            );
            setIsLoading(false);
          }
          return;
        }

        // Online — fetch fresh data from the network
        const data = await resolveContractData(id);

        if (isCurrentRequest) {
          setContractData(data);
          setMilestones(mergeContractMilestones(data.milestones, id));
          setIsUsingCachedData(false);
          setIsDataStale(false);
          setCachedAt(undefined);

          // Cache the successfully loaded data for offline use
          cacheContractData(id, data);
        }
      } catch (error) {
        if (!isCurrentRequest) return;

        // Bounded retry for transient failures only. Terminal failures
        // (validation / not-found / authorization) are never retried: a retry
        // would deterministically produce the same refusal while masking the
        // invariant that produced it.
        //
        // The attempt counter lives in this closure, so a superseded effect run
        // (newer loadRequestId, aborted controller, unmount) cannot keep
        // retrying or commit anything.
        if (
          isRetryableLoadError(error) &&
          loadAttemptRef.current < MAX_LOAD_RETRIES &&
          !isAborted()
        ) {
          loadAttemptRef.current += 1;
          const delay =
            LOAD_RETRY_BASE_DELAY_MS * 2 ** (loadAttemptRef.current - 1);
          reportError(error, 'contracts/[id].load', 'warn', {
            contractId: id,
            attempt: loadAttemptRef.current,
            maxAttempts: MAX_LOAD_RETRIES,
          });
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            abortController.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
          // Re-check after the backoff: the request may have been superseded or
          // aborted while we waited, and a superseded load must not proceed.
          if (!isCurrentRequest || isAborted()) return;
          return runLoadAttempt();
        }

        // On error, try to fall back to cache
        const cachedResult = getCachedContractData(id);
        if (cachedResult.success && cachedResult.data) {
          if (isCurrentRequest) {
            setContractData(cachedResult.data);
            setMilestones(mergeContractMilestones(cachedResult.data.milestones, id));
            setIsUsingCachedData(true);
            setIsDataStale(cachedResult.stale || false);
            setCachedAt(cachedResult.data.updatedAt);
            setErrorMessage(
              'Unable to load fresh data. Showing cached version which may be outdated.',
            );
          }
        } else if (isCurrentRequest) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : 'Failed to load contract. Please try again.',
          );
        }
      } finally {
        if (isCurrentRequest) {
          setIsLoading(false);
        }
      }
    };

    loadContract();

    return () => {
      // A completion may update UI/cache only while its path and online state are active.
      isCurrentRequest = false;
    };
  }, [id, isOnline, loadAttempt]);

  const retryContractLoad = () => {
    setLoadAttempt((attempt) => attempt + 1);
  };

  /**
   * Placeholder for the future milestone-submission workflow.
   *
   * Invariant: this is intentionally a no-op until the submission API is
   * integrated. The action button remains visible so the UI surface contract
   * is preserved for future callers.
   */
  const handleSubmitMilestone = () => {
    // Replace with real milestone submission flow.
  };

  /**
   * Persists the confirmed release-funds action as a completed contract.
   *
   * Transition: Active → Completed
   * Allowed by the ALLOWED_TRANSITIONS table; enforced inside
   * {@link persistContractStatus} before any repository write.
   */
  const handleReleaseFunds = useCallback(() => {
    persistContractStatus(
      'Completed',
      'Funds released',
      'The contract was marked as Completed and the change was saved.',
    );
  }, [persistContractStatus]);

  /**
   * Persists the confirmed dispute action as a disputed contract.
   *
   * Transition: Active → Disputed
   * Allowed by the ALLOWED_TRANSITIONS table; enforced inside
   * {@link persistContractStatus} before any repository write.
   */
  const handleDispute = useCallback(() => {
    persistContractStatus(
      'Disputed',
      'Dispute opened',
      'The contract was marked as Disputed and the change was saved.',
    );
  }, [persistContractStatus]);

  const handleViewSummary = () => {
    // Replace with summary navigation.
  };

  /**
   * Optimistically applies a milestone field patch to the local state, then
   * persists the change to the repository.
   *
   * Invariants:
   *  - Mutations are rejected when offline to prevent divergence.
   *  - Mutations are rejected when serving stale cached data.
   *  - On persistence failure the original milestone list is restored from
   *    `milestonesRef` (the snapshot taken before the optimistic update).
   *
   * @param milestoneId - The id of the milestone to patch.
   * @param patch - Partial milestone fields to merge onto the existing record.
   * @returns `true` when the persistence succeeds; `false` on failure.
   */
  const handleUpdateMilestone = useCallback((milestoneId: string, patch: Partial<Milestone>) => {
    // Guard 1: offline
    if (!isOnline) {
      /* istanbul ignore next -- toast side effect */
      showError({
        title: 'Cannot update milestone while offline',
        description: 'Please connect to the internet to make changes to milestones.',
      });
      return false;
    }

    // Guard 2: stale cached data
    if (isUsingCachedData && isDataStale) {
      /* istanbul ignore next -- toast side effect */
      showError({
        title: 'Cannot update stale data',
        description: 'Please refresh the page to load the latest data before making changes.',
      });
      return false;
    }

    // Guard 3: at most one milestone mutation in flight per contract id. The
    // first caller wins; a re-entrant call is a deterministic no-op rather
    // than a second repository write for one user action.
    if (inFlightMilestoneMutations.current.has(id)) {
      return false;
    }

    // Guard 4: validate the patch at the persistence boundary. The *sanitised*
    // patch — not the raw one — is what reaches both state and the
    // repository, so a forbidden field, an over-long title or a lowercase
    // currency can never be committed and rendered state cannot drift from what
    // was actually persisted.
    const validation = validateMilestonePatch(milestoneId, patch);
    if (!validation.ok) {
      const notice =
        validation.errors[0]?.message ??
        'Milestone update could not be applied. Please try again.';
      // Field ids and ids only — never the submitted values.
      reportError(
        new Error('Rejected a milestone patch that failed boundary validation.'),
        'contracts/[id].milestonePatch',
        'warn',
        { milestoneId, fieldIds: validation.errors.map((e) => e.fieldId) },
      );
      setErrorMessage(notice);
      showError({ title: 'Unable to update milestone', description: notice });
      return false;
    }
    const sanitizedPatch = validation.sanitized;

    // Capture the current list before the optimistic update for rollback
    const snapshot = milestonesRef.current;

    inFlightMilestoneMutations.current.add(id);
    try {
      // Apply the optimistic update synchronously so the UI responds immediately
      setMilestones((current) =>
        current.map((item) =>
          item.id === milestoneId ? { ...item, ...sanitizedPatch } : item,
        ),
      );

      // Persist to the repository
      const persisted = updateMilestone(milestoneId, sanitizedPatch);

      if (!persisted) {
        // Roll back to the pre-mutation snapshot
        setMilestones(snapshot);
        return false;
      }

      return true;
    } finally {
      // Released on every path — including a throwing repository — so a failed
      // or rolled-back write can never permanently block a retry.
      inFlightMilestoneMutations.current.delete(id);
    }
  }, [id, isOnline, isUsingCachedData, isDataStale, showError]);

  const status = contractData?.status || 'Active';

  // Deterministic derived flag: mutations are unsafe when offline or when
  // showing stale cached data. Kept in one place so ActionPanel and handlers
  // cannot drift out of sync.
  const disableMutations = useMemo(
    () => !isOnline || (isUsingCachedData && isDataStale),
    [isOnline, isUsingCachedData, isDataStale],
  );

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 sm:px-6 lg:px-8">
      {contractData ? <ContractStatusAnnouncer status={contractData.status} /> : null}
      {/*
        Invariants enforced on this page:
        - Only the newest load token may commit contract/milestone state.
        - At most one status mutation and one milestone mutation may be
          in-flight per contract id at any time.
        - Optimistic updates are always rolled back on persistence failure.
      */}
      <div className="mx-auto max-w-screen-2xl space-y-6">
        {/* Offline/stale data indicator */}
        <OfflineIndicator isStale={isDataStale} cachedAt={cachedAt} />

        <div className="flex items-center justify-between gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div>
            <Breadcrumbs
              items={[
                { label: 'Dashboard', href: '/' },
                { label: 'Contracts', href: '/contracts' },
                { label: `#${id}` },
              ]}
            />
            <div className="flex items-center gap-3">
              <h1 className="mt-2 text-3xl font-semibold text-slate-900">Contract #{id}</h1>
              <button
                onClick={() => copy(id)}
                className="mt-2 flex-shrink-0 rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
                aria-label={copied ? 'Contract ID copied' : 'Copy contract ID to clipboard'}
                title={copied ? 'Contract ID copied' : 'Copy contract ID'}
              >
                {copied ? (
                  <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
              </button>
            </div>
          </div>
          <Link
            href="/contracts"
            className="inline-flex items-center rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 transition hover:border-slate-400"
          >
            Back to contracts
          </Link>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
          <div className="space-y-6">
            <SafeBoundary>
              {isLoading ? (
                <ContractSummarySkeleton />
              ) : contractData ? (
                <ContractSummary
                  contractName={contractData.name}
                  parties={contractData.parties}
                  totalValue={contractData.totalValue}
                  currency={contractData.currency}
                  status={contractData.status}
                  createdAt={contractData.createdAt}
                  updatedAt={contractData.updatedAt}
                  milestoneCount={milestones.length}
                />
              ) : null}
            </SafeBoundary>

            <SafeBoundary>
              {isLoading ? (
                <ContractProgressSkeleton />
              ) : contractData ? (
                <ContractProgress milestones={milestones} />
              ) : errorMessage ? (
                <ContractProgressSkeleton hasError onRetry={retryContractLoad} />
              ) : null}
            </SafeBoundary>

            <SafeBoundary>
              {isLoading ? (
                <MilestonesListSkeleton />
              ) : contractData ? (
                <MilestonesList
                  milestones={milestones}
                  contractCurrency={contractData.currency}
                  onUpdateMilestone={handleUpdateMilestone}
                />
              ) : null}
            </SafeBoundary>
          </div>

          <div className="space-y-6">
            <ActionPanel
              status={status}
              onSubmitMilestone={handleSubmitMilestone}
              onReleaseFunds={handleReleaseFunds}
              onDispute={handleDispute}
              onViewSummary={handleViewSummary}
              isLoading={isLoading || isPersistingStatus}
              errorMessage={errorMessage || undefined}
              disputeFlow="confirm"
              disableMutations={disableMutations}
            />
          </div>
        </div>
      </div>
    </main>
  );
};

// ---------------------------------------------------------------------------
// Route entry point
// ---------------------------------------------------------------------------

/**
 * Contract detail page.
 *
 * Entry-point invariants:
 *  1. The `id` route parameter is validated by {@link isValidContractId}
 *     before any data fetching. Invalid ids call `notFound()` deterministically,
 *     never reaching the data layer.
 *  2. The validated `id` is passed to `ContractDetailPageContent` as a plain
 *     string — callers cannot supply an arbitrary object or null.
 *
 * @param params - A promise resolving to the Next.js dynamic route params.
 */
const ContractDetailPage = ({ params }: ContractDetailPageProps) => {
  const { id } = use(params);

  if (!isValidContractIdBoundary(id) || !isValidContractId(id)) {
    notFound();
  }

  return <ContractDetailPageContent key={id} id={id} />;
};

export default ContractDetailPage;
