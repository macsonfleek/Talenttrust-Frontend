import { useCallback, useMemo, useReducer, useRef } from 'react';
import {
  Contract,
  ContractStateError,
  ContractStatus,
  ContractsState,
  contractsReducer,
  initialContractsState,
  isTerminalStatus,
  validateContract,
} from '../lib/contractsState';

export interface UseContractsResult {
  contracts: Contract[];
  inFlight: Record<string, number>;
  hydrate: (contracts: unknown[]) => void;
  add: (contract: unknown) => Contract;
  remove: (id: string) => void;
  transition: (id: string, to: ContractStatus) => Promise<void>;
  isInFlight: (id: string) => boolean;
}

export interface UseContractsOptions {
  /**
   * Performs the actual server mutation. Resolves on success, rejects on failure.
   * The hook guarantees this is never called concurrently for the same id.
   */
  mutateStatus?: (id: string, to: ContractStatus) => Promise<void>;
  /** Optional observability sink. Must not receive sensitive data. */
  onError?: (error: ContractStateError) => void;
  /** Monotonic clock for revisions; overridable for tests. */
  now?: () => number;
}

function toError(err: unknown, id: string): ContractStateError {
  if (err instanceof ContractStateError) return err;
  const message = err instanceof Error ? err.message : 'Unknown error';
  return new ContractStateError(`Mutation failed for ${id}: ${message}`, 'mutation_failed');
}

/**
 * State hook for the contracts list.
 *
 * Guarantees:
 *  - Only validated contracts enter state.
  *  - Status transitions follow the allowed graph defined in contractsState.
  *  - Concurrent transitions on the same id are serialized via a per-id lock.
 *  - Optimistic updates roll back on failure and are ignored if stale.
 */
export function useContracts(utils: UseContractsOptions = {}): UseContractsResult {
  const [state, dispatch] = useReducer(contractsReducer, initialContractsState);
  /**
   * Per-id serialization chains for `transition`.
   *
   * Invariant: the entry for an id is always a promise that never rejects
   * (`run.catch(...)` below), so a failed mutation cannot poison the chain and
   * wedge every later transition for that id. A new id costs one entry; the map
   * is keyed by contract id so two different contracts never block each other.
   */
  const locks = useRef<Record<string, Promise<void>>>({});
  const revisionCounter = useRef(0);
  const now = utils.now ?? (() => Date.now());

  const nextRevision = useCallback(() => {
    revisionCounter.current += 1;
    return revisionCounter.current;
  }, []);

  const hydrate = useCallback((contracts: unknown[]) => {
    const validated: Contract[] = [];
    for (const raw of contracts) {
      try {
        validated.push(validateContract(raw));
      } catch (err) {
        const e = toError(err, 'unknown');
        utils.onError?.(e);
      }
    }
    dispatch({ type: 'hydrate', contracts: validated });
  }, [utils]);

  const add = useCallback((contract: unknown): Contract => {
    const validated = validateContract(contract);
    dispatch({ type: 'add', contract: validated });
    return validated;
  }, []);

  const remove = useCallback((id: string) => {
    dispatch({ type: 'remove', id });
  }, []);

  const transition = useCallback(
    async (id: string, to: ContractStatus): Promise<void> => {
      const current = state.contracts.find((c) => c.id === id);
      if (!current) {
        const e = new ContractStateError(`Unknown contract ${id}`, 'not_found');
        utils.onError?.(e);
        throw e;
      }
      if (isTerminalStatus(current.status)) {
        const e = new ContractStateError(
          `Contract ${id} is in terminal state ${current.status}`,
          'terminal_state',
        );
        utils.onError?.(e);
        throw e;
      }

      // Serialize concurrent transitions for the same id.
      const prev = locks.current[id] ?? Promise.resolve();
      const run = prev.then(async () => {
        const revision = nextRevision();
        dispatch({ type: 'status/optimistic', id, status: to, revision });
        try {
          if (utils.mutateStatus) {
            await utils.mutateStatus(id, to);
          }
          dispatch({ type: 'status/confirm', id, status: to, revision });
        } catch (err) {
          dispatch({ type: 'status/rollback', id, revision });
          const e = toError(err, id);
          utils.onError?.(e);
          throw e;
        }
      });
      // Ensure the lock chain does not reject for the next waiter.
      locks.current[id] = run.catch(() => undefined);
      return run;
    },
    [state.contracts, nextRevision, utils, now],
  );

  const isInFlight = useCallback((id: string) => Boolean(state.inFlight[id]), [state.inFlight]);

  return useMemo(
    () => ({ contracts: state.contracts, inFlight: state.inFlight, hydrate, add, remove, transition, isInFlight }),
    [state.contracts, state.inFlight, hydrate, add, remove, transition, isInFlight],
  );
}

export type { Contract, ContractStatus, ContractsState };
