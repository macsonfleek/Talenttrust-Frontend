"use client";

import React, { useCallback, useState, useMemo, useRef } from 'react';
import EmptyState from '../../components/EmptyState';
import ContractsList from '../../components/contracts/ContractsList';
import { ContractCreationForm } from '../../components/ContractCreationForm';
import { listContracts, saveContract } from '@/lib/repository';
import { downloadContractsCsv, downloadContractsJson } from '@/lib/exportContracts';
import { useToast } from '@/components/toast/toast-provider';
import { reportError } from '@/lib/errorReporter';
import { usePreferences } from '@/lib/preferences';
import {
  CONTRACT_SORT_OPTIONS,
  DEFAULT_CONTRACT_SORT_ORDER,
  sortContracts,
  toContractSortOrder,
  type ContractSortOrder,
} from '@/lib/sortContracts';
import type { Contract } from '@/types/domain';

/**
 * Upper bound on the search query.
 *
 * Bounds the filter input so a pathological paste cannot drive an unbounded
 * scan or an unbounded history entry, and so the rendered query is always the
 * same value the filter used.
 */
const MAX_SEARCH_LENGTH = 200;

type ContractsFetchState =
  | { status: 'loading'; contracts: Contract[] }
  | { status: 'success'; contracts: Contract[] }
  | { status: 'error'; contracts: Contract[] };

/**
 * Invariants enforced by this page:
 * - `fetchState.contracts` is always a valid array (never undefined).
 * - Contract ids are unique within `fetchState.contracts`; duplicate ids are
 *   rejected before being appended so optimistic updates cannot corrupt state.
 * - Concurrent submissions are serialized via `submissionInFlightRef` so two
 *   rapid submits cannot both optimistically append and race on persistence.
 * - On persistence failure the optimistic append is rolled back by id, and
 *   the rollback is idempotent (safe if the id is already absent).
 * - `status: 'error'` always carries an empty contracts array so the error
 *   UI cannot render stale data.
 */
const getInitialFetchState = (): ContractsFetchState => {
  try {
    return { status: 'success', contracts: listContracts() };
  } catch {
    return { status: 'error', contracts: [] };
  }
};

const ContractsPage: React.FC = () => {
  const [fetchState, setFetchState] = useState<ContractsFetchState>(getInitialFetchState);
  const [showForm, setShowForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<ContractSortOrder>(DEFAULT_CONTRACT_SORT_ORDER);
  const { showError } = useToast();
  const { preferences, updatePreference } = usePreferences();
  const { contracts } = fetchState;

  // Synchronous in-flight guard. Prevents overlapping submissions from
  // interleaving their optimistic updates and persistence calls.
  const submissionInFlightRef = useRef(false);
  // Tracks ids already accepted in this session so a replayed submission
  // cannot slip past the duplicate check after the list has been mutated.
  const acceptedIdsRef = useRef<Set<string>>(new Set());

  const contractsDensity = preferences.contractsDensity;

  /** Toggles between compact and comfortable density and persists the choice. */
  const handleToggleDensity = useCallback(() => {
    const next = contractsDensity === 'compact' ? 'comfortable' : 'compact';
    updatePreference('contractsDensity', next);
  }, [contractsDensity, updatePreference]);

  /** Re-reads persisted contracts after a recoverable load failure. */
  const loadContracts = useCallback(() => {
    setFetchState((current) => ({ ...current, status: 'loading' }));

    // A reload invalidates the session-level accepted-id cache because the
    // source of truth is being re-read from persistence.
    acceptedIdsRef.current = new Set();

    // Defer the synchronous local-storage read so the loading state is
    // announced before the result replaces it.
    queueMicrotask(() => {
      try {
        setFetchState({ status: 'success', contracts: listContracts() });
      } catch {
        setFetchState({ status: 'error', contracts: [] });
      }
    });
  }, []);

  /**
   * Opens the contract creation form modal.
   */
  const handleCreateContract = useCallback(() => {
    setShowForm(true);
  }, []);

  /**
   * Applies the new contract to the list immediately, then persists it.
   * Rolls back the optimistic update and surfaces an error toast if the
   * write fails.
   *
   * Validation boundaries:
   *  - Rejects invalid contracts (missing id / name) before any state change.
   *  - Rejects duplicates against both the current list and the session
   *    accepted-id set, so replayed or double-clicked submissions are no-ops.
   *  - Serializes concurrent submissions via a synchronous in-flight guard;
   *    overlapping calls are rejected without mutating state.
   */
  const handleSubmitContract = useCallback(
    (contract: Contract) => {
      // Synchronous in-flight guard. Claimed before any state update so two
      // submissions landing in the same React batch cannot both pass.
      if (submissionInFlightRef.current) return;
      submissionInFlightRef.current = true;

      // Structural validation first: an id or name that is missing (or not a
      // string) cannot be persisted or matched, so it is rejected before it
      // reaches the optimistic append.
      if (
        !contract ||
        typeof contract.id !== 'string' ||
        contract.id.length === 0 ||
        typeof contract.contractName !== 'string' ||
        contract.contractName.length === 0
      ) {
        submissionInFlightRef.current = false;
        reportError(
          new Error('Rejected a contract submission with no usable id or name.'),
          'ContractsPage.submit',
          'warn',
        );
        showError({
          title: 'Unable to create contract',
          description: 'A contract needs an id and a name. Please try again.',
        });
        return;
      }

      // Duplicate rejection against both the rendered list and the
      // session-level accepted-id set, so a replayed or double-dispatched
      // submission cannot append the same id twice.
      const duplicate =
        contracts.some((item) => item.id === contract.id) ||
        acceptedIdsRef.current.has(contract.id);
      if (duplicate) {
        submissionInFlightRef.current = false;
        return;
      }

      acceptedIdsRef.current.add(contract.id);
      setFetchState((current) => ({
        status: 'success',
        contracts: [...current.contracts, contract],
      }));
      setShowForm(false);
      setSearchQuery('');

      const persisted = saveContract(contract);
      if (!persisted) {
        // Roll back by id. Idempotent: if the id is already absent the filter is
        // a no-op, so a double rollback cannot corrupt the list.
        acceptedIdsRef.current.delete(contract.id);
        setFetchState((current) => ({
          status: 'success',
          contracts: current.contracts.filter((item) => item.id !== contract.id),
        }));
        showError({
          title: "Unable to create contract",
          description: "Your contract could not be saved. Please try again.",
        });
      }

      submissionInFlightRef.current = false;
    },
    [contracts, showError],
  );

  /**
   * Closes the contract creation form modal.
   */
  const handleCancelForm = useCallback(() => {
    setShowForm(false);
  }, []);

  /**
   * Bounds the search query to a deterministic maximum length so filtering
   * remains predictable and cannot be driven by unbounded input.
   */
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value.slice(0, MAX_SEARCH_LENGTH));
  }, []);

  const filteredContracts = useMemo(() => {
    if (!searchQuery.trim()) return contracts;
    const lowerQuery = searchQuery.toLowerCase();
    return contracts.filter((c) => {
      const matchName = c.contractName.toLowerCase().includes(lowerQuery);
      const matchParty = c.parties.some((p) => p.label.toLowerCase().includes(lowerQuery));
      return matchName || matchParty;
    });
  }, [contracts, searchQuery]);

  // Ordering is applied on top of the search results, so the two combine.
  const sortedContracts = useMemo(
    () => sortContracts(filteredContracts, sortOrder),
    [filteredContracts, sortOrder],
  );

  return (
    <main className="min-h-screen p-8 pb-24">
      <h1 className="text-2xl font-bold mb-6">Contracts</h1>

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {fetchState.status === 'loading'
          ? 'Loading contracts'
          : fetchState.status === 'error'
            ? 'Unable to load contracts'
            : contracts.length === 0
              ? 'No contracts found'
              : `${sortedContracts.length} ${sortedContracts.length === 1 ? 'contract' : 'contracts'} found`}
      </p>

      {fetchState.status === 'loading' && !showForm && (
        <div
          role="status"
          aria-label="Loading contracts"
          aria-busy="true"
          className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600"
        >
          Loading contracts…
        </div>
      )}

      {fetchState.status === 'error' && !showForm && (
        <section
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          className="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-900"
        >
          <h2 className="text-lg font-semibold">Unable to load contracts</h2>
          <p className="mt-2 text-sm">Please check your connection and try again.</p>
          <button
            type="button"
            onClick={loadContracts}
            className="mt-4 rounded-md bg-red-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-800 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-red-900"
          >
            Retry loading contracts
          </button>
        </section>
      )}

      {fetchState.status === 'success' && !showForm && contracts.length === 0 && (
        <EmptyState
          illustration="contracts"
          title="No contracts found"
          description="You haven't created any contracts yet. Start by creating your first contract to begin freelancing securely."
          actionLabel="Create Contract"
          onAction={handleCreateContract}
        />
      )}

      {fetchState.status === 'success' && !showForm && contracts.length > 0 && (
        <>
          <div className="mb-4 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-1 items-center gap-4">
              <div className="relative flex-1 max-w-sm">
                <input
                  type="search"
                  placeholder="Search contracts or parties..."
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="w-full rounded-2xl border border-slate-300 pl-10 pr-4 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  aria-label="Search contracts"
                />
                <svg
                  className="absolute left-3 top-2.5 h-4 w-4 text-slate-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <label htmlFor="contracts-sort" className="sr-only">Sort by</label>
              <select
                id="contracts-sort"
                value={sortOrder}
                onChange={(e) => setSortOrder(toContractSortOrder(e.target.value))}
                className="rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {CONTRACT_SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-500 hidden md:inline-block">
                {sortedContracts.length}{" "}
                {sortedContracts.length === 1 ? "result" : "results"}
              </span>
              <button
                type="button"
                onClick={() => downloadContractsCsv(sortedContracts)}
                className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:border-slate-400 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                aria-label="Export contracts as CSV"
              >
                CSV
              </button>
              <button
                type="button"
                onClick={() => downloadContractsJson(sortedContracts)}
                className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:border-slate-400 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                aria-label="Export contracts as JSON"
              >
                JSON
              </button>
              <button
                type="button"
                onClick={handleCreateContract}
                className="rounded-2xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
              >
                Create Contract
              </button>
            </div>
          </div>

          {sortedContracts.length === 0 ? (
            <EmptyState
              illustration="contracts"
              title="No contracts match your search"
              description="We couldn't find any contracts matching your current search terms. Try adjusting your query or clearing the search."
              actionLabel="Clear Search"
              onAction={() => setSearchQuery('')}
            />
          ) : (
            <ContractsList
              contracts={sortedContracts}
              density={contractsDensity}
              onToggleDensity={handleToggleDensity}
            />
          )}
        </>
      )}

      {showForm && (
        <ContractCreationForm
          onSubmit={handleSubmitContract}
          onCancel={handleCancelForm}
        />
      )}
    </main>
  );
};

export default ContractsPage;
