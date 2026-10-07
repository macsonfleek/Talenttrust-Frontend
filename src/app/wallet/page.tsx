'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import EmptyState from '../../components/EmptyState';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { WalletBulkToolbar } from '../../components/wallet/WalletBulkToolbar';
import { WalletItemList } from '../../components/wallet/WalletItemList';
import { listWalletItems, saveWalletItem, updateWalletItem, deleteWalletItems } from '@/lib/repository';
import { reportError } from '@/lib/errorReporter';
import { useToast } from '@/components/toast/toast-provider';
import type { WalletItem } from '@/types/domain';
import { getSampleWalletItems } from './constants';

/**
 * State invariants for the Wallet page:
 *
 * I1(Selection subset): `selectedIds == { id | exists in items }`.
 *   Any id in the selection set must correspond to a currently visible item.
 *   Selection is pruned whenever items change (delete, reload, edit reload).
 *
 * I2(Delete targets): `targetDeleteIds == [] ` when the confirm dialog is closed.
 *   Targets are captured at the moment the delete is requested and cleared on
 *   confirm or cancel. The confirm handler is idempotent: a double-click or
 *   concurrent invocation must not delete twice or restore deleted items.
 *
 * I3(Editing): `editingId == null ` or `editingId in items`.
 *   Editing an id that no longer exists is a no-op and the editing state is
 *   cleared.
 *
 * I4(Duplicate ids): `targetDeleteIds` is deduplicated before being applied
 *   so repeated ids in the source set cannot cause double deletion or double
 *   toast counting.
 */

function dedupeIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export default function WalletPage() {
  const [items, setItems] = useState<WalletItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [targetDeleteIds, setTargetDeleteIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isMutating, setIsMutating] = useState<boolean>(false);
  const { showSuccess, showError } = useToast();
  // Guards the one-time repository seed so retries, React StrictMode
  // double-invocation, or a changing `showError` identity can never seed twice
  // and leave duplicate or partially-persisted state.
  const seededRef = useRef(false);

  /**
   * Mirror of `items` for handlers that must observe the latest committed list
   * synchronously.
   *
   * Invariant: updated inside `commitItems`, so a read performed in the same
   * tick as a write (a burst of selection toggles, a double-click delete)
   * always sees the value that write produced instead of the pre-render one.
   */
  const itemsRef = useRef<WalletItem[]>([]);

  /**
   * Synchronous in-flight mutex for every mutating wallet operation.
   *
   * Invariant: set immediately before a repository write and cleared in
   * `finally`, so two rapid confirmations can never issue two deletes / two
   * updates for a single user action, and a failed write still frees the lock
   * so the user can retry.
   */
  const isMutatingRef = useRef(false);

  const commitItems = useCallback((next: WalletItem[]) => {
    itemsRef.current = next;
    setItems(() => next);
  }, []);

  // Load from repository on mount, seeding starter items only when empty.
  // The UI is driven strictly by what actually persisted, so a failed write
  // (e.g. localStorage quota) can never leave phantom items on screen or
  // silently diverge the rendered list from the store.
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;

    // The load runs exactly once per mount (guarded above) and always ends by
    // clearing `isLoading`, so the route can never be left spinning — and never
    // leaves `items` populated from a read that actually failed.
    try {
      const loaded = listWalletItems();

      // Self-heal corrupt legacy state: the repository is the source of truth
      // but may return repeated ids. Deduplicating here keeps the selection,
      // bulk-delete and export invariants (all keyed by id) well-defined.
      if (loaded.length > 0) {
        const seen = new Set<string>();
        const deduped: WalletItem[] = [];
        for (const item of loaded) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          deduped.push(item);
        }
        commitItems(deduped);
        setIsLoading(false);
        return;
      }

      const seed = getSampleWalletItems();
      if (seed.length === 0) {
        commitItems([]);
        setIsLoading(false);
        return;
      }

      const persisted: WalletItem[] = [];
      let failedCount = 0;

      for (const item of seed) {
        const ok = saveWalletItem(item);
        if (ok === false) {
          failedCount += 1;
        } else {
          persisted.push(item);
        }
      }

      commitItems(persisted);
      setIsLoading(false);

      if (failedCount > 0) {
        // Counts only — never log wallet addresses or identifiers.
        reportError(
          new Error(`Failed to persist ${failedCount} of ${seed.length} starter wallet items.`),
          'WalletPage.seed',
          'warn',
          { failedCount, totalCount: seed.length },
        );
        showError({
          title: 'Wallet data partially unavailable',
          description: `Couldn't save ${failedCount} of ${seed.length} starter items. Your existing data is safe.`,
        });
      }
    } catch (err) {
      // Reading or seeding threw: report it, surface a recoverable message, and
      // leave the list empty rather than showing a partially-applied seed.
      reportError(err, '[WalletPage] Failed to initialize wallet items.');
      commitItems([]);
      setLoadError('Wallet items could not be loaded. Please try again.');
      setIsLoading(false);
    }
  }, [commitItems, showError]);

  // ---------------------------------------------------------------------------
  // State Invariant: Prune selectedIds whenever items changes
  // Guarantees: selectedIds ⊆ {item.id | item ∈ items}
  // ---------------------------------------------------------------------------
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(items.map((i) => i.id));
      let hasInvalid = false;
      for (const id of prev) {
        if (!validIds.has(id)) {
          hasInvalid = true;
          break;
        }
      }
      if (!hasInvalid) return prev;
      const pruned = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) {
          pruned.add(id);
        }
      }
      return pruned;
    });
  }, [items]);

  // ---------------------------------------------------------------------------
  // Selection Handlers
  // ---------------------------------------------------------------------------
  // I3: Clear or reconcile editing id when items change.
  useEffect(() => {
    if (editingId === null) return;
    if (!items.some((item) => item.id === editingId)) {
      setEditingId(null);
    }
  }, [items, editingId]);

  const handleToggleSelect = useCallback((id: string) => {
    if (!items.some((item) => item.id === id)) return;
    setSelectedIds((prev) => {
      // Ignore toggles for ids that are not currently visible.
      if (!items.some((item) => item.id === id)) return prev;
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, [items]);

  const handleToggleSelectAll = useCallback(() => {
    if (isMutatingRef.current) return;
    setSelectedIds((prev) => {
      if (items.length === 0) return new Set();
      if (prev.size === items.length) {
        return new Set();
      }
      return new Set(items.map((i) => i.id));
    });
  }, [items]);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // ---------------------------------------------------------------------------
  // Export Handler (Deterministic & Safe under Concurrent Changes)
  // ---------------------------------------------------------------------------
  const handleExportSelected = useCallback(() => {
    if (selectedIds.size === 0) return;
    // Re-verify against live items to avoid exporting concurrently deleted items
    const selectedItems = itemsRef.current.filter((item) => selectedIds.has(item.id));
    if (selectedItems.length === 0) return;

    const jsonStr = JSON.stringify(selectedItems, null, 2);

    try {
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = `wallet-export-${Date.now()}.json`;
        a.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      // Fallback for non-browser or strict CPR environments.
    }

    showSuccess({
      title: 'Export successful',
      description: `Exported ${selectedItems.length} ${
        selectedItems.length === 1 ? 'item' : 'items'
      } to JSON.`,
    });
  }, [selectedIds, showSuccess]);

  // ---------------------------------------------------------------------------
  // Deletion Handlers (Mutex Guarded, Idempotent, and Rollback Protected)
  // ---------------------------------------------------------------------------
  const handleRequestBulkDelete = useCallback(() => {
    if (isMutatingRef.current || selectedIds.size === 0) return;
    const validTargets = Array.from(selectedIds).filter((id) =>
      itemsRef.current.some((item) => item.id === id),
    );
    if (validTargets.length === 0) return;
    setTargetDeleteIds(validTargets);
    setIsDeleteModalOpen(true);
  }, [items, selectedIds]);

  const handleRequestSingleDelete = useCallback((id: string) => {
    if (isMutatingRef.current) return;
    if (!itemsRef.current.some((item) => item.id === id)) return;
    setTargetDeleteIds([id]);
    setIsDeleteModalOpen(true);
  }, [items]);

  const handleConfirmDelete = useCallback(async () => {
    // In-flight mutex guard: reject duplicate clicks or concurrent invocations
    if (isMutatingRef.current || targetDeleteIds.length === 0) return;

    isMutatingRef.current = true;
    setIsMutating(true);

    // I4: the captured target set is deduplicated before it is applied, so a
    // repeated id can never cause a double deletion or double toast counting.
    const deleteIds = dedupeIds(targetDeleteIds);

    // Cancel inline editing if the active item is being deleted
    if (editingId && deleteIds.includes(editingId)) {
      setEditingId(null);
    }

    // Capture snapshot for rollback
    const previousItems = itemsRef.current;
    const remainingItems = previousItems.filter((item) => !deleteIds.includes(item.id));

    // Optimistically apply removal to ref and state
    commitItems(remainingItems);

    // Optimistically prune selection
    setSelectedIds((prev) => {
      const next = new Set(prev);
      deleteIds.forEach((id) => next.delete(id));
      return next;
    });

    try {
      const result = deleteWalletItems(deleteIds);
      const ok = (result as unknown) instanceof Promise ? await result : result;

      if (ok) {
        showSuccess({
          title: 'Items deleted',
          description: `Successfully deleted ${deleteIds.length} ${
            deleteIds.length === 1 ? 'item' : 'items'
          }.`,
        });
      } else {
        // Rollback state on persistence failure
        commitItems(previousItems);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          deleteIds.forEach((id) => next.add(id));
          return next;
        });
        showError({
          title: 'Delete failed',
          description: 'Failed to remove selected wallet items.',
        });
      }
    } catch (err) {
      reportError(err, '[WalletPage] Unexpected error during deleteWalletItems.');
      commitItems(previousItems);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        deleteIds.forEach((id) => next.add(id));
        return next;
      });
      showError({
        title: 'Delete failed',
        description: 'Failed to remove selected wallet items. No changes were applied.',
      });
    } finally {
      isMutatingRef.current = false;
      setIsMutating(false);
      setIsDeleteModalOpen(false);
      setTargetDeleteIds([]);
    }
  }, [targetDeleteIds, editingId, commitItems, showSuccess, showError]);

  const handleCancelDelete = useCallback(() => {
    if (isMutatingRef.current) return;
    setIsDeleteModalOpen(false);
    setTargetDeleteIds([]);
  }, []);

  // ---------------------------------------------------------------------------
  // Inline Editing Handlers (Concurrency Guarded)
  // ---------------------------------------------------------------------------
  const handleEditItem = useCallback((id: string) => {
    if (isMutatingRef.current) return;
    setEditingId(id);
  }, [items]);

  const handleSaveEdit = useCallback(
    async (id: string, updated: WalletItem) => {
      if (isMutatingRef.current) return;

      const existing = itemsRef.current.find((item) => item.id === id);
      if (!existing) {
        setEditingId(null);
        showError({
          title: 'Update failed',
          description: 'The wallet item no longer exists.',
        });
        return;
      }

      isMutatingRef.current = true;
      setIsMutating(true);

      const previousItems = itemsRef.current;
      const updatedItem = { ...existing, ...updated };

      // Optimistically update in lockstep
      const nextItems = previousItems.map((item) => (item.id === id ? updatedItem : item));
      commitItems(nextItems);

      try {
        const result = updateWalletItem(id, updatedItem);
        const ok = (result as unknown) instanceof Promise ? await result : result;

        if (ok) {
          setEditingId(null);
          showSuccess({
            title: 'Item updated',
            description: `"${updated.name}" has been updated successfully.`,
          });
        } else {
          // Rollback on update failure
          commitItems(previousItems);
          showError({
            title: 'Update failed',
            description: 'Failed to save changes to the wallet item.',
          });
        }
      } catch (err) {
        reportError(err, '[WalletPage] Unexpected error during updateWalletItem.');
        commitItems(previousItems);
        showError({
          title: 'Update failed',
          description: 'Failed to save changes to the wallet item.',
        });
      } finally {
        isMutatingRef.current = false;
        setIsMutating(false);
      }
    },
    [commitItems, showSuccess, showError],
  );

  const handleCancelEdit = useCallback((_id: string) => {
    setEditingId(null);
  }, []);

  // ---------------------------------------------------------------------------
  // Modal Labels (Memoized)
  // ---------------------------------------------------------------------------
  const deleteModalTitle = useMemo(() => {
    const count = targetDeleteIds.length;
    return count === 1 ? 'Delete wallet item?' : `Delete ${count} wallet items?`;
  }, [targetDeleteIds]);

  const deleteModalDescription = useMemo(() => {
    const count = targetDeleteIds.length;
    return count === 1
      ? 'Are you sure you want to delete this wallet item? This action cannot be undone.'
      : `Are you sure you want to delete the ${count} selected wallet items? This action cannot be undone.`;
  }, [targetDeleteIds]);

  return (
    <main className="min-h-screen p-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            Wallet Management
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Manage your connected assets, security credentials, and escrow keys.
          </p>
        </div>
      </div>

      {loadError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-900/20">
          <p className="text-sm text-red-800 dark:text-red-200">{loadError}</p>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-slate-500 dark:text-slate-400">Loading wallet items...</p>
        </div>
      ) : items.length > 0 ? (
        <WalletBulkToolbar
          selectedCount={selectedIds.size}
          onClearSelection={handleClearSelection}
          onExport={handleExportSelected}
          onDelete={handleRequestBulkDelete}
        />
      ) : null}

      {isLoading ? null : items.length === 0 ? (
        <EmptyState
          illustration="contracts"
          title="No wallet items"
          description="Your wallet is empty. Items and tokens will appear here once connected."
        />
      ) : (
        <WalletItemList
          items={items}
          selectedIds={selectedIds}
          onToggleSelect={handleToggleSelect}
          onToggleSelectAll={handleToggleSelectAll}
          onDeleteItem={handleRequestSingleDelete}
          editingId={editingId}
          onEditItem={handleEditItem}
          onSaveEdit={handleSaveEdit}
          onCancelEdit={handleCancelEdit}
        />
      )}

      <ConfirmDialog
        isOpen={isDeleteModalOpen}
        title={deleteModalTitle}
        description={deleteModalDescription}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        tone="destructive"
        isLoading={isMutating}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </main>
  );
}
