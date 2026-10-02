import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, jest } from '@jest/globals';
import {
  ContractStateError,
  canTransition,
  isTerminalStatus,
  validateContract,
} from '../../lib/contractsState';
import { useContracts } from '../../hooks/useContracts';

function makeContract(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'c-1',
    title: 'Service agreement',
    status: 'draft' as const,
    revision: 0,
    updatedAt: 1,
    ...overrides,
  };
}

describe('contractsState pure helpers', () => {
  it('enforces the allowed transition graph', () => {
    expect(canTransition('draft', 'active')).toBe(true);
    expect(canTransition('draft', 'cancelled')).toBe(true);
    expect(canTransition('active', 'completed')).toBe(true);
    expect(canTransition('active', 'cancelled')).toBe(true);
    expect(canTransition('draft', 'completed')).toBe(false);
    expect(canTransition('completed', 'active')).toBe(false);
    expect(canTransition('cancelled', 'draft')).toBe(false);
    // Idempotent no-op.
    expect(canTransition('draft', 'draft')).toBe(true);
  });

  it('marks terminal states correctly', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('draft')).toBe(false);
    expect(isTerminalStatus('active')).toBe(false);
  });

  it('rejects invalid payloads', () => {
    expect(() => validateContract(null)).toThrow(ContractStateError);
    expect(() => validateContract({})).toThrow(ContractStateError);
    expect(() => validateContract(makeContract({ status: 'bogus' }))).toThrow(ContractStateError);
    expect(() => validateContract(makeContract({ revision: -1 }))).toThrow(ContractStateError);
  });

  it('accepts valid payloads and normalizes optional fields', () => {
    const c = validateContract(makeContract());
    expect(c.id).toBe('c-1');
    expect(c.status).toBe('draft');
    expect(typeof c.updatedAt).toBe('number');
  });
});

describe('useContracts hook', () => {
  it('hydrates and dedupes by id keeping the newest revision', () => {
    const { result } = renderHook(() => useContracts());
    act(() => {
      result.current.hydrate([
        makeContract({ id: 'a', revision: 1 }),
        makeContract({ id: 'a' , revision: 3, title: 'Newest' }),
        makeContract({ id: 'b', revision: 2 }),
      ]);
    });
    expect(result.current.contracts.map((c) => c.id)).toEqual(['a', 'b']);
    expect(result.current.contracts.find((c) => c.id === 'a')?.title).toBe('Newest');
  });

  it('skips invalid entries during hydration and reports them', () => {
    const onError = jest.fn();
    const { result } = renderHook(() => useContracts({ onError }));
    act(() => {
      result.current.hydrate([makeContract(), null, { id: 'bad' }]);
    });
    expect(result.current.contracts).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate adds as a no-op', () => {
    const { result } = renderHook(() => useContracts());
    act(() => {
      result.current.add(makeContract());
      result.current.add(makeContract());
    });
    expect(result.current.contracts).toHaveLength(1);
  });

  it('transitions along allowed graph and confirms on success', async () => {
    const mutateStatus = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useContracts({ mutateStatus }));
    act(() => {
      result.current.add(makeContract());
    });

    await act(async () => {
      await result.current.transition('c-1', 'active');
    });

    // The optimistic revision is committed and the single mutation is awaited.
    expect(mutateStatus).toHaveBeenCalledTimes(1);
    expect(mutateStatus).toHaveBeenCalledWith('c-1', 'active');
    expect(result.current.contracts[0].status).toBe('active');
    expect(result.current.isInFlight('c-1')).toBe(false);
  });

  it('serializes concurrent transitions for the same id instead of racing', async () => {
    // One pending mutation per call, released explicitly so the test controls
    // exactly how far the chain advances.
    const releases: Array<() => void> = [];
    const mutateStatus = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const { result } = renderHook(() => useContracts({ mutateStatus }));
    act(() => {
      result.current.add(makeContract());
    });

    let first!: Promise<void>;
    let second!: Promise<void>;
    // Both dispatches happen inside one act() so they land in the same batch,
    // which is the window a double click / double tap produces.
    act(() => {
      first = result.current.transition('c-1', 'active');
      second = result.current.transition('c-1', 'cancelled');
    });

    // Let the lock chain start the first write.
    await act(async () => {
      await Promise.resolve();
    });

    // Exactly one write so far: the second call queued behind the first rather
    // than issuing its own mutation.
    expect(mutateStatus).toHaveBeenCalledTimes(1);
    expect(mutateStatus).toHaveBeenCalledWith('c-1', 'active');
    expect(result.current.isInFlight('c-1')).toBe(true);

    await act(async () => {
      releases[0]();
      await Promise.all([first]);
      await Promise.resolve();
    });

    // Releasing the lock lets the queued call run, still exactly one write at a
    // time — the ids never interleave.
    expect(mutateStatus).toHaveBeenCalledTimes(2);
    expect(mutateStatus).toHaveBeenLastCalledWith('c-1', 'cancelled');

    await act(async () => {
      releases[1]();
      await Promise.allSettled([first, second]);
    });

    // The lock is free afterwards, so a later transition is never blocked.
    expect(result.current.isInFlight('c-1')).toBe(false);
  });

  it('reports a failed mutation and releases the in-flight lock', async () => {
    const onError = jest.fn();
    const mutateStatus = jest.fn().mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useContracts({ mutateStatus, onError }));
    act(() => {
      result.current.add(makeContract());
    });

    // `transition` rethrows so callers can react to the failure; the test only
    // asserts the hook's own recovery, so the rejection is captured here.
    await act(async () => {
      await result.current.transition('c-1', 'active').catch(() => undefined);
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(result.current.isInFlight('c-1')).toBe(false);
  });
});
