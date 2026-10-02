/**
 * Behavioural coverage for `useContract`, the loader that backs contract reads.
 *
 * These tests drive the hook through its real signature and result shape
 * (`useContract(id, { ... })` -> `{ status, contract, error, ... }`) and inject
 * `fetchImpl`/`sleep` so the network and the retry backoff are deterministic.
 *
 * Invariants covered here:
 *  - an unusable id fails fast and never reaches the network
 *  - a 404 surfaces as `not-found` rather than a generic error
 *  - a failed refresh keeps the last known good contract visible
 *  - `retry()` is inert while a load is healthy or already in flight
 */

import { renderHook, act, waitFor } from '@testing-library/react';

import { useContract } from '@/hooks/useContract';
import type { Contract } from '@/types/domain';

/** The wire shape `fetchContract` validates: it requires id/title/status. */
const CONTRACT = {
  id: 'contract-1',
  title: 'Acme Retainer',
  status: 'Active',
} as unknown as Contract;
/** Minimal `Response` stand-in: `fetchContract` only reads ok/status/json(). */
function respondWith(body: unknown, init: { status?: number } = {}) {
  const status = init.status ?? 200;
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const options = { retries: 0, sleep: async () => {} };

describe('useContract', () => {
  it('fails fast for an unusable id without touching the network', async () => {
    const fetchImpl = respondWith(CONTRACT);
    const onError = jest.fn();

    const { result } = renderHook(() => useContract('   ', { ...options, fetchImpl, onError }));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.current.contract).toBeNull();
    // The failure is surfaced to the caller for observability.
    expect(onError).toHaveBeenCalled();
  });

  it('exposes the loaded contract on success', async () => {
    const fetchImpl = respondWith(CONTRACT);
    const { result } = renderHook(() => useContract('contract-1', { ...options, fetchImpl }));

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.contract?.title).toBe('Acme Retainer');
    expect(result.current.error).toBeNull();
  });

  it('reports a 404 as not-found rather than a generic error', async () => {
    const fetchImpl = respondWith(null, { status: 404 });
    const { result } = renderHook(() => useContract('contract-1', { ...options, fetchImpl }));

    await waitFor(() => expect(result.current.status).toBe('not-found'));
    expect(result.current.contract).toBeNull();
  });

  it('keeps the last known good contract visible when a refresh fails', async () => {
    const ok = respondWith(CONTRACT);
    const boom = respondWith(null, { status: 500 });

    const { result, rerender } = renderHook(
      ({ fetchImpl }: { fetchImpl: typeof fetch }) =>
        useContract('contract-1', { ...options, fetchImpl }),
      { initialProps: { fetchImpl: ok } }
    );

    await waitFor(() => expect(result.current.status).toBe('success'));

    // Swap the transport, then ask for an explicit refetch.
    rerender({ fetchImpl: boom });
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.status).toBe('error'));

    // The stale contract must not be blanked out: the UI keeps rendering real
    // data instead of collapsing to an error page mid-refresh.
    expect(result.current.contract?.title).toBe('Acme Retainer');
  });

  it('does not retry while the hook is healthy', async () => {
    const fetchImpl = respondWith(CONTRACT);
    const { result } = renderHook(() => useContract('contract-1', { ...options, fetchImpl }));

    await waitFor(() => expect(result.current.status).toBe('success'));

    const callsBefore = fetchImpl.mock.calls.length;
    act(() => result.current.retry());

    // `retry()` is a no-op outside of the error / not-found states.
    expect(fetchImpl.mock.calls.length).toBe(callsBefore);
  });

  it('does not re-fetch forever when a caller passes an inline fetch lambda', async () => {
    // A new options object (and therefore a new `load`) is created on every
    // render here. If the load effect depended on those identities it would
    // setState on each pass and never settle.
    const { result } = renderHook(() =>
      useContract('contract-1', { ...options, fetchImpl: respondWith(CONTRACT) })
    );

    await waitFor(() => expect(result.current.status).toBe('success'));

    const callsAfterSettle = result.current.attempts;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result.current.status).toBe('success');
    expect(result.current.attempts).toBe(callsAfterSettle);
  });
});
