'use client';

import { useCallback, useRef, useState } from 'react';
import {
  saveWalletItem,
  upsertWalletItem,
  deleteWalletItems,
  getWalletItemVersion,
} from '@/lib/repository';
import type { WalletItem } from '@/types/domain';

/**
 * Result codes returned by optimistic wallet mutation operations.
 */
export type WalletOptimisticErrorCode =
  | 'STALE_VERSION'
  | 'PERSISTENCE_FAILED'
  | 'WALLET_ITEM_NOT_FOUND'
  | 'DELETE_TARGET_NOT_FOUND'
  | 'OPERATION_IN_PROGRESS';

export type WalletOptimisticResult =
  | { ok: true }
  | {
      ok: false;
      code: WalletOptimisticErrorCode;
      stale: boolean;
      error: string;
    };

/**
 * A custom hook that applies wallet item mutations (create, update, delete)
 * optimistically to React state with mutex locking, lockstep ref tracking,
 * and rollback capabilities on persistence failure or concurrent version conflict.
 *
 * Guarantees:
 * - **Concurrency Mutex**: Blocks re-entrant or racing mutations while an operation
 *   is already in flight.
 * - **Lockstep Ref (`itemsRef`)**: Eliminates stale closures when rapid operations
 *   occur before React completes re-rendering.
 * - **Idempotent Deletion & Creation**: Deduplicates incoming IDs and ignores duplicate creations.
 * - **Surgical Rollback**: Restores exact pre-mutation state on persistence failure.
 *
 * @param items - The current wallet items array from React state.
 * @param setItems - State setter to apply optimistic changes and rollbacks.
 */
export function useOptimisticWalletMutation(
  items: WalletItem[],
  setItems: React.Dispatch<React.SetStateAction<WalletItem[]>>,
) {
  const rollbackRef = useRef<WalletItem[]>([]);
  const itemsRef = useRef<WalletItem[]>(items);
  itemsRef.current = items;

  const isMutatingRef = useRef<boolean>(false);
  const [isMutating, setIsMutating] = useState<boolean>(false);

  // Keep the ref in lockstep with the queued React update so concurrent or
  // sequential edits do not read from stale closure props.
  const commitItems = useCallback(
    (next: WalletItem[]) => {
      itemsRef.current = next;
      setItems(() => next);
    },
    [setItems],
  );

  const restoreItems = useCallback(
    (snapshot: WalletItem[]) => {
      itemsRef.current = snapshot;
      setItems(snapshot);
    },
    [setItems],
  );

  // ---------------------------------------------------------------------------
  // Optimistic create
  // ---------------------------------------------------------------------------

  const optimisticCreate = useCallback(
    (item: WalletItem): WalletOptimisticResult => {
      if (isMutatingRef.current) {
        return {
          ok: false,
          code: 'OPERATION_IN_PROGRESS',
          stale: false,
          error: 'Another wallet operation is already in progress. Please wait.',
        };
      }

      isMutatingRef.current = true;
      setIsMutating(true);
      rollbackRef.current = itemsRef.current;

      try {
        // Idempotency: if an item with the same ID already exists, do not duplicate
        if (itemsRef.current.some((existing) => existing.id === item.id)) {
          rollbackRef.current = [];
          return { ok: true };
        }

        commitItems([...itemsRef.current, item]);

        const ok = saveWalletItem(item);
        if (!ok) {
          if (rollbackRef.current) {
            restoreItems(rollbackRef.current);
          }
          rollbackRef.current = [];
          return {
            ok: false,
            code: 'PERSISTENCE_FAILED',
            stale: false,
            error: 'The wallet item could not be saved. Please try again.',
          };
        }

        rollbackRef.current = [];
        return { ok: true };
      } finally {
        isMutatingRef.current = false;
        setIsMutating(false);
      }
    },
    [commitItems, restoreItems],
  );

  // ---------------------------------------------------------------------------
  // Optimistic update
  // ---------------------------------------------------------------------------

  const optimisticUpdate = useCallback(
    (id: string, patch: Partial<WalletItem>): WalletOptimisticResult => {
      if (isMutatingRef.current) {
        return {
          ok: false,
          code: 'OPERATION_IN_PROGRESS',
          stale: false,
          error: 'Another wallet operation is already in progress. Please wait.',
        };
      }

      isMutatingRef.current = true;
      setIsMutating(true);
      rollbackRef.current = itemsRef.current;

      try {
        const existing = itemsRef.current.find((m) => m.id === id);
        if (!existing) {
          if (rollbackRef.current) {
            restoreItems(rollbackRef.current);
          }
          rollbackRef.current = [];
          return {
            ok: false,
            code: 'WALLET_ITEM_NOT_FOUND',
            stale: false,
            error: 'Wallet item not found in the current list. Please reload and try again.',
          };
        }

        const storedVersion = typeof getWalletItemVersion === 'function' ? getWalletItemVersion(id) : (existing.version ?? 0);
        const optimisticItem: WalletItem = {
          ...existing,
          ...patch,
          version: storedVersion + 1,
        };

        commitItems(
          itemsRef.current.map((item) => (item.id === id ? optimisticItem : item)),
        );

        // Persist through the versioned upsert so the stale-overwrite guard
        // applies; `updateWalletItem` has no version check and would silently
        // win a race against another session.
        const result = upsertWalletItem(optimisticItem);
        const ok = result.success;
        const isStale = result.stale;

        if (!ok) {
          if (rollbackRef.current) {
            restoreItems(rollbackRef.current);
          }
          rollbackRef.current = [];
          return isStale
            ? {
                ok: false,
                code: 'STALE_VERSION',
                stale: true,
                error: 'This wallet item was updated in another session. Please reload and try again.',
              }
            : {
                ok: false,
                code: 'PERSISTENCE_FAILED',
                stale: false,
                error: 'The wallet item could not be saved. Please try again.',
              };
        }

        rollbackRef.current = [];
        return { ok: true };
      } finally {
        isMutatingRef.current = false;
        setIsMutating(false);
      }
    },
    [commitItems, restoreItems],
  );

  // ---------------------------------------------------------------------------
  // Optimistic delete
  // ---------------------------------------------------------------------------

  const optimisticDelete = useCallback(
    (ids: string[]): WalletOptimisticResult => {
      if (!Array.isArray(ids) || ids.length === 0) {
        return { ok: true };
      }

      if (isMutatingRef.current) {
        return {
          ok: false,
          code: 'OPERATION_IN_PROGRESS',
          stale: false,
          error: 'Another wallet operation is already in progress. Please wait.',
        };
      }

      isMutatingRef.current = true;
      setIsMutating(true);
      rollbackRef.current = itemsRef.current;

      try {
        const uniqueIds = Array.from(new Set(ids));
        const matched = itemsRef.current.filter((item) => uniqueIds.includes(item.id));

        if (matched.length === 0) {
          rollbackRef.current = [];
          return {
            ok: false,
            code: 'DELETE_TARGET_NOT_FOUND',
            stale: false,
            error: 'No wallet items were found to delete. Please reload and try again.',
          };
        }

        commitItems(
          itemsRef.current.filter((item) => !uniqueIds.includes(item.id)),
        );

        const ok = deleteWalletItems(uniqueIds);

        if (!ok) {
          if (rollbackRef.current) {
            restoreItems(rollbackRef.current);
          }
          rollbackRef.current = [];
          return {
            ok: false,
            code: 'PERSISTENCE_FAILED',
            stale: false,
            error: 'Failed to delete wallet items. Changes have been rolled back.',
          };
        }

        rollbackRef.current = [];
        return { ok: true };
      } finally {
        isMutatingRef.current = false;
        setIsMutating(false);
      }
    },
    [commitItems, restoreItems],
  );

  return {
    optimisticCreate,
    optimisticUpdate,
    optimisticDelete,
    isMutating,
  };
}
