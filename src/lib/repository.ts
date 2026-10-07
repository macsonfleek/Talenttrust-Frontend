/**
 * @file repository.ts
 *
 * Client-side persistence layer for TalentTrust.
 *
 * Provides synchronous read/write access to Contract and Milestone records
 * stored in the browser's localStorage under a single namespaced key.
 *
 * For a complete overview of the API, the AppData shape, update operations,
 * and maintenance helpers, please refer to `docs/data-model.md`.
 *
 * Design principles:
 * - **Pure & synchronous** — no React dependencies; safe to call from any context.
 * - **SSR-safe** — guards every storage access with a `typeof window` check so
 *   Next.js server-side builds never throw.
 * - **Resilient** — all reads are wrapped in try/catch; corrupt or missing data
 *   falls back to `[]` with a report via the central error reporter rather than crashing.
 * - **Non-mutating** — callers own their data; this module never mutates the
 *   objects it receives or returns.
 *
 * Maintenance helpers:
 * - {@link clearAppData} — removes the single `STORAGE_KEY` entry; useful for
 *   testing, demos, and user-initiated "start over" flows.
 * - {@link clearByPrefix} — removes every localStorage key that starts with a
 *   given prefix; iterates a frozen key snapshot to avoid index-shift bugs.
 */

import type { Contract, WalletItem, ReputationEvent } from '@/types/domain';
import type { Milestone } from '@/components/MilestonesList';
import { reportError } from './errorReporter';

// ---------------------------------------------------------------------------
// Storage key & data shape
// ---------------------------------------------------------------------------

/** Single localStorage key that houses all persisted app data. */
export const STORAGE_KEY = 'talenttrust_app_data';

interface AppData {
  contracts: Contract[];
  milestones: Milestone[];
  walletItems: WalletItem[];
  reputationEvents: ReputationEvent[];
}

const EMPTY_DATA: AppData = { contracts: [], milestones: [], walletItems: [], reputationEvents: [] };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when code is running inside a real browser environment.
 * Guards against Next.js SSR / build-time execution where `window` is absent.
 */
/**
 * Returns `true` when code is running inside a real browser environment.
 * Guards against Next.js SSR / build-time execution where `window` is absent.
 *
 * Exported for testing — use `jest.spyOn` in SSR simulation tests.
 */
export function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/**
 * Reads and parses the full persisted data object from localStorage.
 *
 * On failure the error is forwarded to the central `reportError` reporter
 * before falling back to the empty state.
 *
 * @returns The parsed `AppData` object, or `EMPTY_DATA` on any failure
 *          (missing key, unparseable JSON, unexpected shape).
 */
function readStore(): AppData {
  if (!isBrowser()) return { ...EMPTY_DATA };

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_DATA };

    const parsed = JSON.parse(raw) as Partial<AppData>;

    return {
      contracts: Array.isArray(parsed.contracts) ? parsed.contracts : [],
      milestones: Array.isArray(parsed.milestones) ? parsed.milestones : [],
      walletItems: Array.isArray(parsed.walletItems) ? parsed.walletItems : [],
      reputationEvents: Array.isArray(parsed.reputationEvents) ? parsed.reputationEvents : [],
    };
  } catch (err) {
    reportError(err, '[repository] Failed to read from localStorage. Falling back to empty state.');
    return { ...EMPTY_DATA };
  }
}

/**
 * Serialises and writes the full data object back to localStorage.
 *
 * On failure the error is forwarded to the central `reportError` reporter.
 * The call is a no-op in SSR contexts (no `window`).
 *
 * @param data - The complete `AppData` object to persist.
 * @returns `true` when the write succeeds; otherwise `false`.
 */
function writeStore(data: AppData): boolean {
  if (!isBrowser()) return false;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (err) {
    reportError(err, '[repository] Failed to write to localStorage.');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API — Contracts
// ---------------------------------------------------------------------------

/**
 * Returns all persisted contracts.
 *
 * Reads from localStorage and returns the stored array. If localStorage is
 * unavailable (SSR) or the stored value is corrupt, returns an empty array
 * `[]` and reports the failure via the central error reporter — it never throws.
 *
 * @returns A new array of `Contract` objects (may be empty).
 *
 * @example
 * ```ts
 * const contracts = listContracts();
 * // → [{ contractName: 'Design Sprint', ... }, ...]
 * ```
 */
export function listContracts(): Contract[] {
  return readStore().contracts;
}

/**
 * Appends a contract to the persisted list.
 *
 * The write is additive — existing milestones and other contracts are
 * preserved. Passing a contract whose `contractName` already exists will
 * result in a duplicate; deduplication is the caller's responsibility.
 *
 * @param contract - The `Contract` record to persist.
 *
 * @example
 * ```ts
 * saveContract({
 *   contractName: 'Design Sprint',
 *   parties: [{ label: 'Client', address: '0xABC...' }],
 *   totalValue: 5000,
 *   currency: 'USD',
 *   status: 'Active',
 *   createdAt: '2025-01-01',
 *   milestoneCount: 3,
 * });
 * ```
 */
export function saveContract(contract: Contract): boolean {
  const store = readStore();
  return writeStore({ ...store, contracts: [...store.contracts, contract] });
}

/**
 * Result returned by {@link upsertContract}.
 */
export type UpsertResult = {
  /** Whether the write succeeded. */
  success: boolean;
  /** When `true`, the write was rejected because a newer version of the same
   *  contract was already persisted. Callers should roll back any optimistic
   *  UI update and surface a clear message. */
  stale: boolean;
};

/**
 * Replaces an existing contract that shares the same `contractName`, or appends
 * the contract when no persisted match exists yet.
 *
 * The helper returns a result object so calling UI code can distinguish between
 * a plain persistence failure and a stale-overwrite rejection, allowing it to
 * surface a more specific message and roll back optimistic updates.
 *
 * **Stale-overwrite guard**
 *
 * Every contract carries an internal `version` field that starts at `1` for
 * new contracts and increments on each successful upsert. Before writing, the
 * function compares the incoming contract's version against the currently stored
 * version. If the stored version is higher, the write is rejected with
 * `{ success: false, stale: true }` — this prevents one tab from silently
 * overwriting a status change made in another tab.
 *
 * @param contract - The full `Contract` record to insert or replace.
 * @returns An `UpsertResult` with `success` indicating whether the write
 *   completed, and `stale` indicating a stale-overwrite rejection.
 *
 * @example
 * ```ts
 * const { success, stale } = upsertContract({
 *   contractName: 'Design Sprint',
 *   parties: [{ label: 'Client', address: '0xABC...' }],
 *   totalValue: 5000,
 *   currency: 'USD',
 *   status: 'Completed',
 *   createdAt: '2025-01-01',
 *   milestoneCount: 3,
 * });
 * if (!success && stale) {
 *   // Optimistic update was rolled back — another tab modified this contract.
 * }
 * ```
 */
export function upsertContract(contract: Contract): UpsertResult {
  const store = readStore();
  const existingIndex = store.contracts.findIndex(
    (existingContract) => existingContract.contractName === contract.contractName,
  );

  if (existingIndex !== -1) {
    const existing = store.contracts[existingIndex];
    const existingVersion = existing.version ?? 0;
    const incomingVersion = contract.version ?? 0;

    if (incomingVersion < existingVersion) {
      return { success: false, stale: true };
    }
  }

  const nextVersion = (contract.version ?? 0) + 1;
  const updatedContract: Contract = { ...contract, version: nextVersion };

  const contracts =
    existingIndex === -1
      ? [...store.contracts, updatedContract]
      : store.contracts.map((existingContract, index) =>
          index === existingIndex ? updatedContract : existingContract,
        );

  const ok = writeStore({ ...store, contracts });
  return { success: ok, stale: false };
}

/**
 * Returns the current persistence-layer version for the contract matching
 * `contractName`, or `0` if the contract has never been persisted or does
 * not carry a version field.
 *
 * Callers use this to build a `Contract` object with the correct base
 * version before calling {@link upsertContract}, ensuring the stale-overwrite
 * guard compares against the right baseline.
 *
 * @param contractName - The name of the contract to look up.
 * @returns The stored version number (`0` if not found).
 */
export function getContractVersion(contractName: string): number {
  const store = readStore();
  const existing = store.contracts.find(
    (existingContract) => existingContract.contractName === contractName,
  );
  return existing?.version ?? 0;
}

/**
 * Replaces the contract currently stored under `originalName` with `updated`.
 *
 * Unlike {@link upsertContract} (which keys on the *new* name), this locates
 * the existing row by its original name first, so an inline edit that also
 * renames the contract updates in place instead of creating a duplicate.
 *
 * @returns `true` on a successful write; `false` when no contract matches
 *   `originalName` or when running without `localStorage`.
 */
export function updateContract(originalName: string, updated: Contract): boolean {
  const store = readStore();
  const index = store.contracts.findIndex(
    (existingContract) => existingContract.contractName === originalName,
  );

  if (index === -1) {
    console.warn(`[repository] updateContract: No contract found with name '${originalName}'.`);
    return false;
  }

  const contracts = store.contracts.map((existingContract, i) =>
    i === index ? updated : existingContract,
  );

  return writeStore({ ...store, contracts });
}

/**
 * Deletes a contract by name from the persisted list.
 *
 * When a contract with the given `contractName` is found, it is removed and
 * the remaining contracts are persisted. If no contract with that name exists,
 * the store remains unchanged.
 *
 * The helper returns a success flag so calling UI code can surface a toast or
 * fallback message when persistence fails.
 *
 * @param contractName - The name of the contract to delete.
 * @returns `true` when the contract is deleted successfully; otherwise `false`.
 *
 * @example
 * ```ts
 * const deleted = deleteContract('Design Sprint');
 * if (!deleted) console.warn('Could not delete contract.');
 * ```
 */
export function deleteContract(contractName: string): boolean {
  const store = readStore();
  const filteredContracts = store.contracts.filter(
    (contract) => contract.contractName !== contractName,
  );

  // If no contracts were removed, return false (nothing to delete)
  if (filteredContracts.length === store.contracts.length) {
    return false;
  }

  return writeStore({ ...store, contracts: filteredContracts });
}

// ---------------------------------------------------------------------------
// Public API — Milestones
// ---------------------------------------------------------------------------

/**
 * Returns all persisted milestones.
 *
 * Reads from localStorage and returns the stored array. If localStorage is
 * unavailable (SSR) or the stored value is corrupt, returns an empty array
 * `[]` and reports the failure via the central error reporter — it never throws.
 *
 * @returns A new array of `Milestone` objects (may be empty).
 *
 * @example
 * ```ts
 * const milestones = listMilestones();
 * // → [{ id: 'ms-1', title: 'Kickoff', status: 'Pending', ... }, ...]
 * ```
 */
export function listMilestones(): Milestone[] {
  return readStore().milestones;
}

/**
 * Returns every persisted milestone whose `contractId` matches the given
 * `contractId`.
 *
 * Milestones saved without a `contractId` (e.g. legacy records, or ones
 * created outside a contract context) are never matched, since `undefined`
 * cannot equal a caller-supplied `contractId` string.
 *
 * @param contractId - The parent contract id to filter milestones by.
 * @returns A new array of `Milestone` objects belonging to `contractId`
 *   (may be empty).
 *
 * @example
 * ```ts
 * const milestones = listMilestonesByContract('contract-123');
 * // → [{ id: 'ms-1', contractId: 'contract-123', ... }, ...]
 * ```
 */
export function listMilestonesByContract(contractId: string): Milestone[] {
  return readStore().milestones.filter((milestone) => milestone.contractId === contractId);
}

/**
 * Appends a milestone to the persisted list.
 *
 * The write is additive — existing contracts and other milestones are
 * preserved. Callers are responsible for ensuring `id` uniqueness.
 *
 * @param milestone - The `Milestone` record to persist.
 *
 * @example
 * ```ts
 * saveMilestone({
 *   id: 'ms-1',
 *   title: 'Project Kickoff',
 *   status: 'Pending',
 *   payout: 1000,
 *   currency: 'USD',
 *   dueDate: 'Jun 1, 2025',
 * });
 * ```
 */
export function saveMilestone(milestone: Milestone): boolean {
  const store = readStore();
  return writeStore({ ...store, milestones: [...store.milestones, milestone] });
}

/**
 * Returns the current persistence-layer version for the milestone matching
 * `id`, or `0` if the milestone has never been persisted or does not carry
 * a version field.
 *
 * Callers use this to build a `Milestone` object with the correct base
 * version before calling {@link upsertMilestone}, ensuring the stale-overwrite
 * guard compares against the right baseline.
 *
 * @param id - The unique identifier of the milestone to look up.
 * @returns The stored version number (`0` if not found).
 */
export function getMilestoneVersion(id: string): number {
  const store = readStore();
  const existing = store.milestones.find((m) => m.id === id);
  return existing?.version ?? 0;
}

/**
 * Result returned by {@link upsertMilestone}.
 */
export type MilestoneUpsertResult = {
  /** Whether the write succeeded. */
  success: boolean;
  /** When `true`, the write was rejected because a newer version of the same
   *  milestone was already persisted. Callers should roll back any optimistic
   *  UI update and surface a clear message. */
  stale: boolean;
};

/**
 * Replaces an existing milestone that shares the same `id`, or appends the
 * milestone when no persisted match exists yet.
 *
 * The helper returns a result object so calling UI code can distinguish between
 * a plain persistence failure and a stale-overwrite rejection, allowing it to
 * surface a more specific message and roll back optimistic updates.
 *
 * **Stale-overwrite guard**
 *
 * Every milestone carries an internal `version` field that starts at `1` for
 * new milestones and increments on each successful upsert. Before writing, the
 * function compares the incoming milestone's version against the currently stored
 * version. If the stored version is higher, the write is rejected with
 * `{ success: false, stale: true }` — this prevents one tab from silently
 * overwriting a change made in another tab.
 *
 * @param milestone - The full `Milestone` object to insert or replace.
 * @returns A `MilestoneUpsertResult` with `success` indicating whether the write
 *   completed, and `stale` indicating a stale-overwrite rejection.
 *
 * @example
 * ```ts
 * const { success, stale } = upsertMilestone({
 *   id: 'ms-1',
 *   title: 'Project Kickoff',
 *   status: 'Completed',
 *   payout: 2500,
 *   currency: 'USD',
 * });
 * if (!success && stale) {
 *   // Optimistic update was rolled back — another tab modified this milestone.
 * }
 * ```
 */
export function upsertMilestone(milestone: Milestone): MilestoneUpsertResult {
  const store = readStore();
  const existingIndex = store.milestones.findIndex(
    (existingMilestone) => existingMilestone.id === milestone.id,
  );

  if (existingIndex !== -1) {
    const existing = store.milestones[existingIndex];
    const existingVersion = existing.version ?? 0;
    const incomingVersion = milestone.version ?? 0;

    if (incomingVersion < existingVersion) {
      return { success: false, stale: true };
    }
  }

  const nextVersion = (milestone.version ?? 0) + 1;
  const updatedMilestone: Milestone = { ...milestone, version: nextVersion };

  const milestones =
    existingIndex === -1
      ? [...store.milestones, updatedMilestone]
      : store.milestones.map((existingMilestone, index) =>
          index === existingIndex ? updatedMilestone : existingMilestone,
        );

  const ok = writeStore({ ...store, milestones });
  return { success: ok, stale: false };
}

/**
 * Updates an existing milestone identified by `id` with the provided `patch`.
 *
 * The operation is pure – it does not mutate the original milestone objects
 * but returns a new array with the updated record. If the `id` cannot be found
 * a warning is emitted via `console.warn` and the store is left unchanged.
 *
 * @param id - The unique identifier of the milestone to update.
 * @param patch - A partial milestone object containing the fields to merge.
 * @returns `true` when the update is persisted successfully; otherwise `false`.
 *
 * @example
 * ```ts
 * updateMilestone('ms-1', { status: 'Completed' });
 * // → true (milestone status persisted)
 * ```
 */
export function updateMilestone(id: string, patch: Partial<Milestone>): boolean {
  const store = readStore();
  const index = store.milestones.findIndex((m) => m.id === id);

  if (index === -1) {
    console.warn(`[repository] updateMilestone: No milestone found with id '${id}'.`);
    return false;
  }

  const updatedMilestones = store.milestones.map((m, i) =>
    i === index ? { ...m, ...patch } : m,
  );

  return writeStore({ ...store, milestones: updatedMilestones });
}

/**
 * Deletes multiple milestones identified by an array of ids.
 *
 * Non-existent ids are silently skipped. The operation is pure – the caller's
 * input array is never mutated.
 *
 * @param ids - Array of milestone ids to delete.
 * @returns The number of milestones actually deleted (may be less than the
 *   length of `ids` when some ids were not found).
 *
 * @example
 * ```ts
 * const removed = deleteMilestones(['ms-1', 'ms-2', 'ms-999']);
 * // → 2 (ms-999 didn't exist)
 * ```
 */
export function deleteMilestones(ids: string[]): number {
  if (!Array.isArray(ids) || ids.length === 0) return 0;

  const store = readStore();
  const idSet = new Set(ids);
  const before = store.milestones.length;
  const remaining = store.milestones.filter((m) => !idSet.has(m.id));
  const removed = before - remaining.length;

  if (removed > 0) {
    writeStore({ ...store, milestones: remaining });
  }

  return removed;
}

/**
 * Updates the `status` field of every milestone whose id appears in `ids`.
 *
 * Missing ids are silently skipped. A single write is performed only when at
 * least one milestone changes.
 *
 * @param ids - Array of milestone ids whose status should be updated.
 * @param status - The new status value to apply.
 * @returns The number of milestones actually updated (may be less than
 *   `ids.length` when ids were not found or already had the target status).
 *
 * @example
 * ```ts
 * const changed = bulkUpdateMilestoneStatus(['ms-1', 'ms-2'], 'Completed');
 * // → 2
 * ```
 */
export function bulkUpdateMilestoneStatus(
  ids: string[],
  status: Milestone['status'],
): number {
  if (!Array.isArray(ids) || ids.length === 0) return 0;

  const store = readStore();
  const idSet = new Set(ids);
  let changed = 0;

  const updatedMilestones = store.milestones.map((m) => {
    if (!idSet.has(m.id)) return m;
    if (m.status === status) return m;
    changed += 1;
    return { ...m, status };
  });

  if (changed > 0) {
    writeStore({ ...store, milestones: updatedMilestones });
  }

  return changed;
}

/**
 * Serialises an array of milestones for export as a JSON string.
 *
 * The output is a pretty-printed JSON array containing the full milestone
 * objects, suitable for downloading via `Blob` + `URL.createObjectURL` or
 * copy-to-clipboard. No side effects – nothing is written to storage.
 *
 * @param milestones - The milestone records to serialise.
 * @returns A pretty-printed JSON string representation of the input array.
 *
 * @example
 * ```ts
 * const json = exportMilestones(selected);
 * navigator.clipboard.writeText(json);
 * ```
 */
export function exportMilestones(milestones: Milestone[]): string {
  return JSON.stringify(milestones, null, 2);
}

// ---------------------------------------------------------------------------
// Public API — Reputation Events
// ---------------------------------------------------------------------------

/**
 * Returns all persisted reputation events.
 */
export function listReputationEvents(): ReputationEvent[] {
  return readStore().reputationEvents;
}

/**
 * Returns the current persistence-layer version for the reputation event matching
 * `id`, or `0` if it has never been persisted.
 */
export function getReputationEventVersion(id: string): number {
  const store = readStore();
  const existing = store.reputationEvents.find((e) => e.id === id);
  return existing?.version ?? 0;
}

/**
 * Replaces an existing reputation event that shares the same `id`, or appends it.
 * Rejects with `stale: true` if an older version is written over a newer one.
 */
export function upsertReputationEvent(event: ReputationEvent): UpsertResult {
  const store = readStore();
  const existingIndex = store.reputationEvents.findIndex(
    (existingEvent) => existingEvent.id === event.id,
  );

  if (existingIndex !== -1) {
    const existing = store.reputationEvents[existingIndex];
    const existingVersion = existing.version ?? 0;
    const incomingVersion = event.version ?? 0;

    if (incomingVersion < existingVersion) {
      return { success: false, stale: true };
    }
  }

  const nextVersion = (event.version ?? 0) + 1;
  const updatedEvent: ReputationEvent = { ...event, version: nextVersion };

  const reputationEvents =
    existingIndex === -1
      ? [...store.reputationEvents, updatedEvent]
      : store.reputationEvents.map((existingEvent, index) =>
          index === existingIndex ? updatedEvent : existingEvent,
        );

  const ok = writeStore({ ...store, reputationEvents });
  return { success: ok, stale: false };
}

/**
 * Deletes multiple reputation events identified by an array of ids.
 */
export function deleteReputationEvents(ids: string[]): number {
  if (!Array.isArray(ids) || ids.length === 0) return 0;

  const store = readStore();
  const idSet = new Set(ids);
  const before = store.reputationEvents.length;
  const remaining = store.reputationEvents.filter((e) => !idSet.has(e.id));
  const removed = before - remaining.length;

  if (removed > 0) {
    if (!writeStore({ ...store, reputationEvents: remaining })) return 0;
  }

  return removed;
}

// ---------------------------------------------------------------------------
// Public API — Wallet Items
// ---------------------------------------------------------------------------

/**
 * Returns all persisted wallet items.
 *
 * @returns A new array of `WalletItem` objects.
 */
export function listWalletItems(): WalletItem[] {
  return readStore().walletItems;
}

/**
 * Returns the current persistence-layer version for the wallet item matching
 * `id`, or `0` if the wallet item has never been persisted or does not carry
 * a version field.
 *
 * Callers use this to build a `WalletItem` object with the correct base
 * version before calling {@link upsertWalletItem}, ensuring the stale-overwrite
 * guard compares against the right baseline.
 *
 * @param id - The unique identifier of the wallet item to look up.
 * @returns The stored version number (`0` if not found).
 */
export function getWalletItemVersion(id: string): number {
  const store = readStore();
  const existing = store.walletItems.find((item) => item.id === id);
  return existing?.version ?? 0;
}

/**
 * Appends a wallet item to the persisted list in an idempotent manner.
 * If an item with the same `id` already exists, it is updated in place.
 *
 * The write is additive — existing contracts and other records are preserved.
 * Callers are responsible for ensuring `id` uniqueness; this helper never
 * mutates the object it receives.
 *
 * @param item - The `WalletItem` record to persist.
 * @returns `true` when the write succeeded; `false` when `localStorage` is
 *   unavailable (SSR) or the write threw (e.g. quota exceeded). Callers that
 *   seed multiple items use this flag to keep the UI consistent with what was
 *   actually persisted and to surface partial-failure diagnostics.
 */
export function saveWalletItem(item: WalletItem): boolean {
  const store = readStore();
  return writeStore({ ...store, walletItems: [...store.walletItems, item] });
}

/**
 * Updates a wallet item identified by `id` with the provided `patch`.
 *
 * @param id - The unique identifier of the wallet item to update.
 * @param patch - A partial `WalletItem` object with the fields to merge.
 * @returns `true` when the update is persisted successfully; `false` if the
 *   id was not found or the write failed.
 */
export function updateWalletItem(id: string, patch: Partial<WalletItem>): boolean {
  const store = readStore();
  const index = store.walletItems.findIndex((item) => item.id === id);

  if (index === -1) {
    console.warn(`[repository] updateWalletItem: No wallet item found with id '${id}'.`);
    return false;
  }

  const current = store.walletItems[index];
  const updatedWalletItems = store.walletItems.map((item, i) =>
    i === index ? { ...item, ...patch, version: (current.version ?? 0) + 1 } : item,
  );

  return writeStore({ ...store, walletItems: updatedWalletItems });
}

/**
 * Inserts or updates a wallet item with stale-overwrite protection.
 *
 * Mirrors {@link upsertContract}: the incoming `version` is compared against
 * the stored version and a write that would clobber a newer record is
 * rejected instead of silently winning. The persisted version is then
 * incremented so the caller can chain another update against the new baseline.
 *
 * This is the persistence path the optimistic wallet mutation relies on;
 * without it every wallet write bypasses the concurrency guard and two tabs
 * editing the same item silently overwrite each other.
 *
 * @param item - The `WalletItem` record to persist.
 * @returns `success` with the record's new version on success, or
 *   `success: false, stale: true` when the write was rejected as stale.
 */
export function upsertWalletItem(item: WalletItem): UpsertResult {
  const store = readStore();
  const index = store.walletItems.findIndex((existing) => existing.id === item.id);

  if (index !== -1) {
    const existingVersion = store.walletItems[index].version ?? 0;
    const incomingVersion = item.version ?? 0;

    if (incomingVersion < existingVersion) {
      return { success: false, stale: true };
    }
  }

  const nextVersion = (item.version ?? 0) + 1;
  const updated: WalletItem = { ...item, version: nextVersion };

  const walletItems =
    index === -1
      ? [...store.walletItems, updated]
      : store.walletItems.map((existing, i) => (i === index ? updated : existing));

  const ok = writeStore({ ...store, walletItems });
  return ok ? { success: true, stale: false } : { success: false, stale: false };
}

/**
 * Deletes wallet items matching the given array of IDs.
 * Deduplicates target IDs to ensure idempotency.
 *
 * @param ids - Array of wallet item IDs to remove.
 * @returns `true` when the operation succeeds; otherwise `false`.
 */
export function deleteWalletItems(ids: string[]): boolean {
  if (!Array.isArray(ids)) return false;
  if (ids.length === 0) return true;

  const store = readStore();
  const idSet = new Set(ids);
  const updatedWalletItems = store.walletItems.filter((item) => !idSet.has(item.id));
  return writeStore({ ...store, walletItems: updatedWalletItems });
}


// ---------------------------------------------------------------------------
// Public API — Maintenance helpers
// ---------------------------------------------------------------------------

/**
 * Removes the single `STORAGE_KEY` entry from `localStorage`, effectively
 * resetting all persisted app data (contracts **and** milestones).
 *
 * This is the recommended path for testing, demo resets, and user-initiated
 * "start over" flows because it routes through the same `isBrowser()` guard
 * and `reportError` plumbing as every other repository operation.
 *
 * @returns `true` when the item was successfully removed; `false` when running
 *   in an SSR context (no `window`) or when `localStorage.removeItem` throws.
 *
 * @example
 * ```ts
 * import { clearAppData } from '@/lib/repository';
 *
 * // User clicks "Reset all data"
 * const ok = clearAppData();
 * if (!ok) console.warn('Could not clear persisted data.');
 * ```
 */
export function clearAppData(): boolean {
  if (!isBrowser()) return false;

  try {
    window.localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch (err) {
    reportError(err, '[repository] Failed to clear app data from localStorage.');
    return false;
  }
}

/**
 * Removes every `localStorage` key whose name starts with the given `prefix`
 * and returns the number of keys that were deleted.
 *
 * Key iteration is performed over a **snapshot** of the current key list so
 * that removing a key while iterating can never cause index-shift bugs.
 * The function never touches keys that do not start with `prefix`, and it
 * never throws — any error from a single `removeItem` call is forwarded to
 * the central `reportError` reporter and the removal counter is **not**
 * incremented for that key.
 *
 * @param prefix - The string prefix to match against every localStorage key.
 *   Passing an empty string (`''`) will match **all** keys — callers should
 *   ensure the prefix is intentionally scoped.
 * @returns The number of keys successfully removed. Returns `0` in an SSR
 *   context (no `window`) or when no keys match the prefix.
 *
 * @example
 * ```ts
 * import { clearByPrefix } from '@/lib/repository';
 *
 * // Remove every key belonging to TalentTrust (e.g. during test teardown)
 * const removed = clearByPrefix('talenttrust_');
 * console.log(`Cleared ${removed} localStorage entries.`);
 * ```
 */
export function clearByPrefix(prefix: string): number {
  if (!isBrowser()) return 0;

  // Snapshot the current keys so that removing entries does not affect
  // the iteration order or length of the live key list.
  // We use the index-based localStorage.key() API instead of Object.keys()
  // because some environments (e.g. jsdom) do not expose storage entries as
  // own enumerable properties on the localStorage object.
  const length = window.localStorage.length;
  const keys: string[] = [];
  for (let i = 0; i < length; i += 1) {
    const k = window.localStorage.key(i);
    if (k !== null) keys.push(k);
  }

  let removed = 0;
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    try {
      window.localStorage.removeItem(key);
      removed += 1;
    } catch (err) {
      reportError(
        err,
        `[repository] Failed to remove localStorage key "${key}" during clearByPrefix.`,
      );
    }
  }

  return removed;
}
