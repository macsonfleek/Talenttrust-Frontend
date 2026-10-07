'use client';

import { useCallback, useRef } from 'react';
import { upsertContract, getContractVersion } from '@/lib/repository';
import type { ContractData } from '@/lib/contractResolver';
import type { Contract } from '@/types/domain';

export type BuildPersistedContract = (
  data: ContractData,
  status: ContractData['status'],
  version: number,
) => Contract;

export type PersistResult =
  | { ok: true }
  | { ok: false; stale: boolean; error: string };

export function useOptimisticContractStatus(
  contractData: ContractData | null,
  setContractData: React.Dispatch<React.SetStateAction<ContractData | null>>,
  buildPersistedContract: BuildPersistedContract,
): (nextStatus: ContractData['status']) => PersistResult {
  /**
   * Tracks the last successfully-persisted contract data so that
   * a subsequent concurrent failure rolls back to the latest known
   * good state rather than the initial one.
   */
  const lastPersistedRef = useRef<ContractData | null>(null);

  const persistStatus = useCallback(
    (nextStatus: ContractData['status']): PersistResult => {
      if (!contractData) {
        return {
          ok: false,
          stale: false,
          error: 'Contract details are unavailable, so the status could not be updated.',
        };
      }

      setContractData({ ...contractData, status: nextStatus });

      const version = getContractVersion(contractData.name);
      const persisted = buildPersistedContract(contractData, nextStatus, version);

      let result: ReturnType<typeof upsertContract>;
      try {
        result = upsertContract(persisted);
      } catch {
        // A repository write can throw (network reset, storage failure,
        // constraint violation) instead of returning a failure result. Without
        // this guard the exception escaped the caller's `try` and left the
        // optimistic status committed with no rollback and no user-visible
        // error, i.e. the UI claimed a save that never happened.
        setContractData(lastPersistedRef.current ?? contractData);
        return {
          ok: false,
          stale: false,
          error:
            'The contract status could not be persisted. Please try again.',
        };
      }

      if (!result.success) {
        // Roll back to the last known good state, or the original if none.
        setContractData(lastPersistedRef.current ?? contractData);
        return result.stale
          ? {
              ok: false,
              stale: true,
              error:
                'This contract was updated in another session. Please reload and try again.',
            }
          : {
              ok: false,
              stale: false,
              error:
                'The contract status could not be persisted. Please try again.',
            };
      }

      // Remember this state so a later concurrent failure can roll back to it.
      lastPersistedRef.current = { ...contractData, status: nextStatus };
      return { ok: true };
    },
    [contractData, setContractData, buildPersistedContract],
  );

  return persistStatus;
}
