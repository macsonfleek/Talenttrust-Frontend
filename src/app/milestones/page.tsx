'use client';

import React, {
  useReducer,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Suspense,
} from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import EmptyState from '../../components/EmptyState';
import MilestonesList from '../../components/MilestonesList';
import MilestoneFilter, {
  type MilestoneStatusFilter,
} from '../../components/milestones/MilestoneFilter';
import { MilestoneCreationForm } from '../../components/milestones/MilestoneCreationForm';
import { listMilestones } from '@/lib/repository';
import { getItem, setItem } from '@/lib/safeStorage';
import { useToast } from '@/components/toast/toast-provider';
import { reportError } from '@/lib/errorReporter';
import SafeBoundary from '@/components/SafeBoundary';
import MilestonesErrorBoundary from '@/components/milestones/MilestonesErrorBoundary';
import MilestonesBoardSkeleton from '@/components/milestones/MilestonesBoardSkeleton';
import { downloadMilestonesICS } from '@/lib/icsExport';
import { useOfflineMilestones } from '@/hooks/useOfflineMilestones';
import { SAMPLE_MILESTONES, SAMPLE_DISMISSED_KEY } from './constants';
import type { Milestone } from '@/types/domain';
import { useOptimisticMilestoneMutation } from '@/hooks/useOptimisticMilestoneMutation';
import { useMilestonesRecovery } from '@/hooks/useMilestonesRecovery';

const UNPAGINATED_LIST_SIZE = 9999;

/**
 * Identity of the initial data load for this mount.
 *
 * `loadEpochRef` starts on this value, so a reconcile is permitted until the
 * user dismisses the sample data (which swaps in a new symbol).
 */
const MILESTONE_LOAD_EPOCH = Symbol('milestone-load-epoch');

const VALID_STATUSES: MilestoneStatusFilter[] = [
  'All',
  'Pending',
  'Completed',
  'Paid',
  'Disputed',
];

/**
 * Canonical mapping from a stored milestone status onto a filter value.
 *
 * Invariant: total and idempotent. A status the store may hold but the filter
 * does not expose (e.g. a legacy value) resolves to `'All'` rather than being
 * dropped, so no milestone can disappear from the board because of a casing or
 * vocabulary mismatch. The canonical values pass through unchanged.
 */
function normalizeMilestoneStatus(status: unknown): MilestoneStatusFilter {
  if (typeof status !== 'string') return 'All';
  return (VALID_STATUSES as readonly string[]).includes(status)
    ? (status as MilestoneStatusFilter)
    : 'All';
}

function getUniqueQueryParam(query: string, key: string): string | null {
  const values = new URLSearchParams(query).getAll(key);
  // Repeated keys are ambiguous, so treat them like any other invalid value.
  return values.length === 1 ? values[0] : null;
}

const MAX_STATUS_PARAM_LENGTH = 32;

function getValidStatus(param: string | null): MilestoneStatusFilter {
  return param && (VALID_STATUSES as string[]).includes(param)
    ? (param as MilestoneStatusFilter)
    : 'All';
}

/**
 * Compatibility contract: the `status` query parameter is a public
 * interface. Unknown or legacy values (including casing differences and
 * whitespace) must resolve deterministically to a valid filter rather than
 * throwing or silently dropping the user's selection. See
 * `normalizeMilestoneStatus` for the canonical mapping.
 */
const CANONICAL_STATUS_PARAM = 'status';

type MilestoneSortOption = 'newest' | 'oldest';
const VALID_SORT_OPTIONS: MilestoneSortOption[] = ['newest', 'oldest'];

const MAX_SORT_PARAM_LENGTH = 16;

function getValidSortOption(param: string | null): MilestoneSortOption {
  return param && (VALID_SORT_OPTIONS as string[]).includes(param)
    ? (param as MilestoneSortOption)
    : 'newest';
}

/**
 * Compatibility contract: `sort` is a public query parameter. Unknown values
 * must fall back to the default (`newest`) so that deep links from older
 * versions of the app continue to render a stable, sorted list.
 */
const CANONICAL_SORT_PARAM = 'sort';


type UrlSyncState = {
  status: MilestoneStatusFilter;
  sort: MilestoneSortOption;
};

type UrlSyncAction =
  | { type: 'status'; value: MilestoneStatusFilter }
  | { type: 'sort'; value: MilestoneSortOption }
  | { type: 'sync'; value: UrlSyncState };

/**
 * Invariant: the URL sync state is the single source of truth for the
 * `status` and `sort` query parameters. Transitions are pure and
 * deterministic so concurrent updates (user interaction + navigation)
 * cannot produce an inconsistent URL.
 */
function urlSyncReducer(
  state: UrlSyncState,
  action: UrlSyncAction,
): UrlSyncState {
  switch (action.type) {
    case 'status':
      return state.status === action.value
        ? state
        : { ...state, status: action.value };
    case 'sort':
      return state.sort === action.value
        ? state
        : { ...state, sort: action.value };
    case 'sync':
      return state.status === action.value.status &&
        state.sort === action.value.sort
        ? state
        : action.value;
    default:
      return state;
  }
}

/**
 * Normalizes a raw query parameter into a bounded, validated value.
 * Rejects oversized, empty, or unknown inputs by returning `null`.
 */
function normalizeParam(
  raw: string | null,
  maxLength: number,
): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

/**
 * Reads a single query parameter under one rule: a key that appears more than
 * once is ambiguous and is therefore rejected.
 *
 * Invariant: the decision is made from the full query string when the key is
 * present there, so `?status=A&status=B` can never silently resolve to one of
 * them. `params.get()` is consulted only when the key is absent from the query
 * string entirely, which keeps adapters that implement `get()` but return an
 * empty `toString()` working without weakening the repeated-key rule.
 */
function readQueryParam(params: URLSearchParams, key: string): string | null {
  const query = typeof params?.toString === 'function' ? params.toString() : '';

  if (new URLSearchParams(query).has(key)) {
    return getUniqueQueryParam(query, key);
  }

  // `get()` on a real ReadonlyURLSearchParams always yields a string or null,
  // but adapters and test doubles may return `undefined`, so the value is
  // normalized here rather than being trusted.
  const fallback = typeof params?.get === 'function' ? params.get(key) : null;
  return typeof fallback === 'string' ? fallback : null;
}

/**
 * Parses the canonical `status` / `sort` pair out of the current query.
 *
 * Pure and total: the same query object always yields the same state, so a
 * concurrent render cannot observe two different parses of one URL.
 */
function parseUrlSyncState(params: URLSearchParams): UrlSyncState {
  const statusParam = normalizeParam(
    readQueryParam(params, CANONICAL_STATUS_PARAM),
    MAX_STATUS_PARAM_LENGTH,
  );
  const sortParam = normalizeParam(
    readQueryParam(params, CANONICAL_SORT_PARAM),
    MAX_SORT_PARAM_LENGTH,
  );
  return {
    status: getValidStatus(statusParam),
    sort: getValidSortOption(sortParam),
  };
}

/**
 * Builds the canonical query string for `state`, preserving every parameter
 * this route does not own.
 *
 * Invariant: the result is a function of `(state, query)` alone. Ownership of
 * `status` / `sort` is exclusive to this route — they are deleted before being
 * re-set, so a user-supplied duplicate can never survive the normalization and
 * leave the URL disagreeing with the rendered state.
 */
function buildUrlSyncQuery(state: UrlSyncState, query: string): string {
  const params = new URLSearchParams(query);
  params.delete(CANONICAL_STATUS_PARAM);
  params.delete(CANONICAL_SORT_PARAM);
  if (state.status !== 'All') {
    params.set(CANONICAL_STATUS_PARAM, state.status);
  }
  if (state.sort !== 'newest') {
    params.set(CANONICAL_SORT_PARAM, state.sort);
  }
  return params.toString();
}



const MilestonesContent: React.FC = () => {
  const [milestones, setMilestones] = useState<Milestone[]>(SAMPLE_MILESTONES);
  const milestoneIdsRef = useRef(new Set(milestones.map(({ id }) => id)));
  const [isDismissed, setIsDismissed] = useState<boolean>(false);
  const [recoveryKey, setRecoveryKey] = useState(0);
  const searchParams = useSearchParams();
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const startFromScratchRef = useRef<HTMLButtonElement | null>(null);
  // Guards against overlapping recovery attempts so a burst of failures
  // cannot interleave and produce a non-deterministic final state.
  const recoveryInFlightRef = useRef<boolean>(false);

  /**
   * Token identifying the current mount's data load.
   *
   * Invariant: it holds a fresh `Symbol` for the lifetime of a mount and is only
   * replaced deliberately. Reconciling from the repository is refused once the
   * token has moved on, so a recovery attempt issued before the user dismissed
   * the sample data cannot repopulate a list they deliberately cleared.
   */
  const loadEpochRef = useRef<typeof MILESTONE_LOAD_EPOCH>(MILESTONE_LOAD_EPOCH);

  /**
   * True while mounted; guards the deferred focus handoff so a timeout that fires
   * after unmount (or after a navigation) cannot focus a detached node.
   */
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [urlSyncState, dispatchUrlSync] = useReducer(
    urlSyncReducer,
    parseUrlSyncState(searchParams),
  );
  const { status: statusFilter, sort: sortOrder } = urlSyncState;
  const [showForm, setShowForm] = useState(false);
  const { showError } = useToast();
  const reconcileFromRepo = useCallback(() => {
    if (loadEpochRef.current !== MILESTONE_LOAD_EPOCH) return;
    setMilestones(listMilestones());
  }, []);

  /**
   * Deterministic failure recovery.
   *
   * Invariants:
   *  - Only one recovery may run at a time (recoveryInFlightRef).
   *  - Recovery always reconciles from the repository, which is the source
   *    of truth, so partial in-memory mutations cannot survive a failure.
   *  - Failures are reported (observable) without leaking milestone payloads.
   *  - Recovery never throws; callers receive a boolean outcome.
   */
  const recoverFromFailure = useCallback(
    (operation: string, error: unknown): boolean => {
      if (recoveryInFlightRef.current) {
        reportError(error, 'milestones.recovery', 'warn', { operation, outcome: 'recovery_skipped_in_flight' });
        return false;
      }
      recoveryInFlightRef.current = true;
      try {
        reconcileFromRepo();
        reportError(error, 'milestones.recovery', 'warn', { operation, outcome: 'recovered' });
        return true;
      } catch (recoveryError) {
        reportError(recoveryError, 'milestones.recovery', 'error', { operation, outcome: 'recovery_failed' });
        return false;
      } finally {
        recoveryInFlightRef.current = false;
      }
    },
    [reconcileFromRepo],
  );
  const offline = useOfflineMilestones(reconcileFromRepo);
  const { optimisticCreate, optimisticUpdate } = useOptimisticMilestoneMutation(
    milestones,
    setMilestones,
  );
  const recovery = useMilestonesRecovery({
    milestones,
    setMilestones,
    reconcileFromRepo,
  });

  // Track the last reconciled snapshot so we can detect silent data loss.
  const lastReconciledRef = useRef<Milestone[] | null>(null);

  const setStatusFilter = useCallback(
    (value: MilestoneStatusFilter) => {
      dispatchUrlSync({ type: 'status', value });
    },
    [],
  );

  const setSortOrder = useCallback((value: MilestoneSortOption) => {
    dispatchUrlSync({ type: 'sort', value });
  }, []);

  useEffect(() => {
    milestoneIdsRef.current = new Set(milestones.map(({ id }) => id));
  }, [milestones]);

  // Adopt external navigation (back/forward, a shared deep link) into the
  // reducer. The reducer returns the identical object when nothing changed, so
  // this cannot loop against the write effect below.
  useEffect(() => {
    dispatchUrlSync({ type: 'sync', value: parseUrlSyncState(searchParams) });
  }, [searchParams]);

  // Write state back to the URL, debounced so a burst of filter clicks produces
  // exactly one history entry. The comparison is on the canonical query string
  // (not on parsed state) so a non-canonical URL — unknown value, repeated key,
  // stale sort — is always normalized even when it happens to parse to the
  // current state.
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const currentQuery = searchParams.toString();
      const canonicalQuery = buildUrlSyncQuery(urlSyncState, currentQuery);
      if (canonicalQuery === currentQuery) {
        return;
      }

      router.replace(canonicalQuery ? `?${canonicalQuery}` : '?');
    }, 150);

    return () => window.clearTimeout(timeoutId);
  }, [urlSyncState, router, searchParams]);

  // Initial load for this mount, and again on every `recoveryKey` bump (a retry
  // or reset from the recovery banner).
  //
  // Invariant: this effect only *reads* the repository. \`reconcileFromRepo\` is
  // the only writer that honours the load epoch, so the sample-dismissal epoch
  // can never be undone by a load racing the click.
  useEffect(() => {
    const persisted = listMilestones();
    if (persisted.length > 0) {
      setMilestones(persisted);
      lastReconciledRef.current = persisted;
      setIsDismissed(true);
    } else {
      try {
        const dismissed = getItem(SAMPLE_DISMISSED_KEY) === 'true';
        setIsDismissed(dismissed);
      } catch {
        setIsDismissed(true);
      }
      // The sample set is kept by reference, not copied. \`isUsingSampleData\` is
      // an identity check against the module constant, so copying here would make
      // the sample banner unreachable and permanently hide the "start from
      // scratch" escape hatch. Every mutation path replaces the array rather than
      // editing it in place, so the constant is never mutated.
      setMilestones(SAMPLE_MILESTONES);
    }
  }, [recoveryKey]);

  const handleDismissSampleBanner = useCallback(() => {
    try {
      setItem(SAMPLE_DISMISSED_KEY, 'true');
    } catch {
      // safeStorage resilience
    }
    loadEpochRef.current = Symbol('milestone-load-epoch-dismissed') as typeof MILESTONE_LOAD_EPOCH;
    setIsDismissed(true);
    setMilestones([]);
    lastReconciledRef.current = [];
    setTimeout(() => {
      // Guard against the component unmounting between scheduling and
      // execution of this timeout (concurrent rendering / navigation).
      if (mountedRef.current) {
        headingRef.current?.focus();
      }
    }, 0);
  }, []);

  const handleRetryRecovery = useCallback(() => {
    recovery.retry();
    setRecoveryKey((key) => key + 1);
  }, [recovery]);

  const handleResetRecovery = useCallback(() => {
    recovery.reset();
    setRecoveryKey((key) => key + 1);
  }, [recovery]);

  const isUsingSampleData = milestones === SAMPLE_MILESTONES;
  const showSampleBanner = isUsingSampleData && !isDismissed;
  const displayMilestones = isUsingSampleData && isDismissed ? [] : milestones;

  const filtered = useMemo(() => {
    if (statusFilter === 'All') return displayMilestones;
    return displayMilestones.filter((m) => normalizeMilestoneStatus(m.status) === statusFilter);
  }, [displayMilestones, statusFilter]);

  const sortedMilestones = useMemo(() => {
    const nextMilestones = [...filtered];

    if (sortOrder === 'oldest') {
      nextMilestones.sort((left, right) => {
        const leftTime = left.dueDate ? Date.parse(left.dueDate) : Number.POSITIVE_INFINITY;
        const rightTime = right.dueDate ? Date.parse(right.dueDate) : Number.POSITIVE_INFINITY;
        const delta = leftTime - rightTime;
        if (delta !== 0) return delta;
        return left.id.localeCompare(right.id);
      });
    } else {
      nextMilestones.sort((left, right) => {
        const leftTime = left.dueDate ? Date.parse(left.dueDate) : Number.NEGATIVE_INFINITY;
        const rightTime = right.dueDate ? Date.parse(right.dueDate) : Number.NEGATIVE_INFINITY;
        const delta = rightTime - leftTime;
        if (delta !== 0) return delta;
        return left.id.localeCompare(right.id);
      });
    }

    return nextMilestones;
  }, [filtered, sortOrder]);

  const handleAddMilestone = useCallback(() => {
    setShowForm(true);
  }, []);

  const handleStatusFilterChange = useCallback(
    (value: MilestoneStatusFilter) => {
      setStatusFilter(value);
    },
    [setStatusFilter],
  );

  const handleSubmitMilestone = useCallback((milestone: Milestone) => {
    if (milestoneIdsRef.current.has(milestone.id)) {
      showError({
        title: 'Unable to create milestone',
        description: 'A milestone with this identifier already exists.',
      });
      return;
    }

    // Reserve the id before touching the repository. Two submits inside one React
    // batch both see an id that is not yet on screen, so the reservation is
    // what makes "persist once" deterministic.
    milestoneIdsRef.current.add(milestone.id);

    const result = optimisticCreate(milestone);
    if (!result.ok) {
      // Release the reservation so a retry is not permanently blocked.
      milestoneIdsRef.current.delete(milestone.id);
      recoverFromFailure('create', result.error);
      showError({
        title: 'Unable to create milestone',
        description: result.stale
          ? 'This milestone was updated in another session. Please reload and try again.'
          : 'Your milestone could not be saved. Please try again.',
        action: result.stale ? undefined : {
          label: 'Retry',
          onClick: () => handleSubmitMilestone(milestone),
        },
      });
      return;
    }

    setShowForm(false);
    setIsDismissed(true);
  }, [optimisticCreate, recoverFromFailure, showError]);

  const handleCancelForm = useCallback(() => {
    setShowForm(false);
  }, []);

  const handleUpdateMilestone = useCallback(
    (id: string, patch: Partial<Milestone>): boolean => {
      const result = optimisticUpdate(id, patch);
      if (!result.ok) {
        recoverFromFailure('update', result.error);
        showError({
          title: 'Unable to update milestone',
          description: result.stale
            ? 'This milestone was updated in another session. Please reload and try again.'
            : 'Your milestone could not be saved. Please try again.',
          action: result.stale ? undefined : {
            label: 'Retry',
            onClick: () => handleUpdateMilestone(id, patch),
          },
        });
        return false;
      }
      return true;
    },
    [optimisticUpdate, recoverFromFailure, showError],
  );

  return (
    <div className="min-h-screen p-8">
      <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold mb-6 focus:outline-none">
        Milestones
      </h1>

      {recovery.status === 'failed' && (
        <div
          data-testid="milestones-recovery-banner"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          className="mb-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 shadow-sm dark:border-red-500/20 dark:bg-red-500/5 dark:text-red-200"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold">Milestones failed to load</p>
              <p className="mt-1 text-red-700 dark:text-red-300">
                {recovery.lastError ?? 'An unexpected error occurred while loading your milestones.'}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={handleRetryRecovery}
                className="rounded-xl bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-700 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-red-500"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={handleResetRecovery}
                className="rounded-xl border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-50 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-red-500"
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      )}

      {(offline.isFlushing || offline.notice || offline.pendingCount > 0) && (
        <div
          data-testid="offline-status-banner"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 shadow-sm dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-200"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium">
              {!offline.isOnline
                ? 'You’re offline — milestone changes are saved on this device and will sync automatically when you reconnect.'
                : offline.isFlushing
                  ? 'Synchronizing your pending milestones…'
                  : offline.notice}
            </p>
            {!offline.isOnline && offline.pendingCount > 0 && (
              <span className="ml-2 shrink-0 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-900 dark:bg-amber-500/20 dark:text-amber-200">
                {offline.pendingCount} pending
              </span>
            )}
          </div>
        </div>
      )}

      {showSampleBanner && (
        <div
          data-testid="sample-data-banner"
          role="status"
          aria-label="Sample data notice"
          className="mb-6 rounded-2xl border border-blue-100 bg-blue-50 p-4 shadow-sm"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-blue-900">
                You're viewing sample data
              </p>
              <p className="mt-1 text-sm text-blue-700">
                These are example milestones to help you get started.
              </p>
              <button
                ref={startFromScratchRef}
                data-testid="start-from-scratch-btn"
                type="button"
                onClick={handleDismissSampleBanner}
                className="mt-3 rounded-xl bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-700 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
              >
                Start from scratch
              </button>
            </div>
            <button
              type="button"
              onClick={handleDismissSampleBanner}
              aria-label="Dismiss sample data notice"
              className="rounded-sm text-blue-500 hover:text-blue-700 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {displayMilestones.length === 0 ? (
        <EmptyState
          illustration="milestones"
          title="No milestones tracked"
          description="Track your progress by adding milestones to your contracts. Milestones help you stay organized and ensure timely delivery."
          actionLabel="Add Milestone"
          onAction={handleAddMilestone}
        />
      ) : (
        <>
          <div className="mb-4 flex min-h-[42px] flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <MilestonesErrorBoundary sectionName="filters">
              <MilestoneFilter
                selected={statusFilter}
                onChange={handleStatusFilterChange}
                resultCount={sortedMilestones.length}
              />
            </MilestonesErrorBoundary>
            <MilestonesErrorBoundary sectionName="actions">
              <div className="flex min-h-[42px] flex-wrap items-center gap-3">
                <label
                  htmlFor="milestone-sort"
                  className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 shadow-sm"
                >
                  <span className="font-medium text-slate-700">Sort</span>
                  <select
                    id="milestone-sort"
                    aria-label="Sort milestones"
                    value={sortOrder}
                    onChange={(event) =>
                      setSortOrder(getValidSortOption(event.target.value))
                    }
                    className="rounded-xl border border-slate-200 bg-transparent px-2 py-1 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  >
                    <option value="newest">Newest first</option>
                    <option value="oldest">Oldest first</option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => downloadMilestonesICS(sortedMilestones)}
                  aria-label="Add to calendar"
                  className="flex-shrink-0 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-100 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                >
                  <span aria-hidden="true" className="mr-1">📅</span>
                  Add to Calendar
                </button>
                <button
                  type="button"
                  aria-label="Add Milestone"
                  onClick={handleAddMilestone}
                  className="flex-shrink-0 rounded-2xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                >
                  Add Milestone
                </button>
              </div>
            </MilestonesErrorBoundary>
          </div>

          <MilestonesErrorBoundary sectionName="milestone list">
            {sortedMilestones.length === 0 ? (
              <EmptyState
                illustration="milestones"
                title="No milestones match this filter"
                description={`There are no ${statusFilter.toLowerCase()} milestones at the moment. Try a different filter or add a new milestone.`}
                actionLabel="Add Milestone"
                onAction={handleAddMilestone}
              />
            ) : (
              <MilestonesList
                milestones={sortedMilestones}
                onUpdateMilestone={handleUpdateMilestone}
                pageSize={UNPAGINATED_LIST_SIZE}
              />
            )}
          </MilestonesErrorBoundary>
        </>
      )}

      {showForm && (
        <MilestoneCreationForm
          onSubmit={handleSubmitMilestone}
          onCancel={handleCancelForm}
        />
      )}
    </div>
  );
};

const MilestonesPage: React.FC = () => (
  <SafeBoundary fallbackTitle="Milestones failed to load.">
    <Suspense fallback={<MilestonesBoardSkeleton />}>
      <MilestonesContent />
    </Suspense>
  </SafeBoundary>
);

export default MilestonesPage;
