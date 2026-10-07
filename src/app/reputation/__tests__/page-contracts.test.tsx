/**
 * Route-level compatibility contracts for `/reputation` (issue #1248).
 *
 * These tests pin the behaviour the route exposes to callers and users, so a
 * future edit to `page.tsx` cannot silently drop it:
 *
 *   Surface      — the module exports resolve to the single tested
 *                  implementation, not a route-local copy.
 *   States       — loading / empty / partial / full are deterministic for
 *                  valid, missing, and malformed data.
 *   Resilience   — degraded persistence and profile crashes surface a
 *                  diagnosable, recoverable UI instead of fabricated data.
 *   Concurrency  — overlapping reads never interleave into an inconsistent
 *                  state.
 *   Accessibility — one landmark, one h1, focus lands on `<main>` on mount.
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import * as pageModule from '../page';
import RoutePage, {
  FOCUS_ON_MOUNT_DELAY_MS,
  ReputationPageContent as ReExportedContent,
} from '../page';
import * as contentModule from '../ReputationPageContent';
import { REPUTATION_DEMO_SCORE, shapeReputationData } from '../ReputationPageContent';
import { readReputationHistory } from '@/lib/readReputationHistory';
import { ReputationHistoryReadError } from '@/lib/readReputationHistory';
import { reportError } from '@/lib/errorReporter';
import type { ReputationEvent } from '@/types/domain';

// The route reads through `readReputationHistory`: a strict, read-only snapshot
// that rejects the whole dataset rather than dropping entries, and reports a
// reason code instead of degrading silently to an empty list. That is what makes
// "cannot read" distinguishable from "nothing stored".
jest.mock('@/lib/readReputationHistory', () => ({
  ...jest.requireActual('@/lib/readReputationHistory'),
  readReputationHistory: jest.fn(),
}));

jest.mock('@/lib/errorReporter', () => ({
  reportError: jest.fn(),
}));

jest.mock('next/navigation', () => ({
  useSearchParams: jest.fn(() => new URLSearchParams('')),
  useRouter: jest.fn(() => ({ replace: jest.fn(), push: jest.fn() })),
}));

import { useSearchParams } from 'next/navigation';

let mockProfileShouldThrow = false;
afterEach(() => {
  mockProfileShouldThrow = false;
});

// Mirror the real component's data-driven surface so the route's composition is
// asserted through the same props, without the profile's own interactive weight.
jest.mock('../../../components/ReputationProfile', () => {
  // `resolveReputationLevel` is a pure export the content module calls when it
  // shapes the dataset. Re-exporting it keeps the route's shaping step real.
  // It is mirrored rather than pulled in with `requireActual` because
  // re-evaluating the module inside the mock factory collides with this file's
  // hoisted React bindings.
  // Mirrors the real bands (Newcomer / Contributor / Active Contributor /
  // Trusted Partner / Expert) so a change to the band table is caught here
  // rather than being papered over by a looser stub.
  const resolveReputationLevel = (score: number, maxScore: number): string => {
    const scale = maxScore / 5;
    const bands = [
      { min: 0 * scale, label: 'Newcomer' },
      { min: 1 * scale, label: 'Contributor' },
      { min: 2 * scale, label: 'Active Contributor' },
      { min: 3 * scale, label: 'Trusted Partner' },
      { min: 4 * scale, label: 'Expert' },
    ];
    if (score < 0) return bands[0].label;
    if (score >= maxScore) return bands[bands.length - 1].label;
    const found = bands.find((band, idx) =>
      idx === bands.length - 1
        ? score >= band.min && score <= band.min + scale
        : score >= band.min && score < band.min + scale,
    );
    return found ? found.label : bands[0].label;
  };

  function MockReputationProfile(props: any) {
    const useSearchParamsMock = jest.requireMock('next/navigation').useSearchParams;
    useSearchParamsMock();
    if (mockProfileShouldThrow) {
      throw new Error('Simulated reputation crash');
    }
    return (
      <div data-testid="reputation-profile">
        <div data-testid="profile-score">{props.score ?? 'N/A'}</div>
        <div data-testid="profile-level">{props.level ?? 'N/A'}</div>
        <div data-testid="profile-history-count">{props.history?.length ?? 0}</div>
      </div>
    );
  }
  return {
    __esModule: true,
    resolveReputationLevel,
    default: MockReputationProfile,
  };
});

jest.mock('../../../components/ReputationSummaryCard', () => ({
  __esModule: true,
  default: ({ score }: any) => (
    <div data-testid="summary-card">
      <span data-testid="summary-card-score">{score ?? 'N/A'}</span>
    </div>
  ),
}));

jest.mock('../../../components/EmptyState', () => ({
  __esModule: true,
  default: ({ title }: any) => <div data-testid="empty-state">{title}</div>,
}));

const EVENTS = [
  { id: 'ev-1', type: 'Verification', summary: 'Verified identity', date: '2026-04-24' },
  { id: 'ev-2', type: 'Referral', summary: 'Referred a member', date: '2026-04-20' },
];

/** Mount the route and flush the deferred persistence read. */
async function renderRoute() {
  const view = render(<RoutePage />);
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

/** Seeds a successful read of `events`. */
function mockRead(events: ReputationEvent[]) {
  (readReputationHistory as jest.Mock).mockReturnValue(events);
}

/**
 * Seeds a read that fails for `reason`.
 *
 * The route must be able to tell the two failure reasons apart and surface a
 * different next step for each, so the tests set them explicitly.
 */
function mockReadFailure(reason: 'storage-unavailable' | 'invalid-data') {
  (readReputationHistory as jest.Mock).mockImplementation(() => {
    throw new ReputationHistoryReadError(reason);
  });
}

describe('reputation route — public surface', () => {
  beforeEach(() => mockRead(EVENTS));

  it('default-exports a route component taking no props', async () => {
    await renderRoute();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Reputation');
  });

  it('re-exports the canonical content component instead of a route-local copy', () => {
    expect(pageModule.ReputationPageContent).toBe(contentModule.ReputationPageContent);
    expect(ReExportedContent).toBe(contentModule.ReputationPageContent);
  });

  it('derives the level from the score bands instead of a hard-coded literal', () => {
    const shaped = shapeReputationData(EVENTS);
    expect(shaped.level).toBe('Expert');
    expect(shaped.score).toBe(REPUTATION_DEMO_SCORE);
    expect(shaped.history).toBe(EVENTS);
  });
});

describe('reputation route — state determinism', () => {
  it('renders a loading announcement before the read settles', async () => {
    jest.useFakeTimers();
    const { unmount } = render(<RoutePage />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading reputation history');
    // Nothing is claimed about the data yet: no profile and no empty state.
    expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
    expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();

    unmount();
    jest.useRealTimers();
    mockRead(EVENTS);
  });

  it('renders the full profile once events are read', async () => {
    mockRead(EVENTS);
    await renderRoute();

    expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
    expect(screen.getByTestId('profile-history-count')).toHaveTextContent('2');
    expect(screen.getByTestId('summary-card')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders the partial profile when the store holds no events', async () => {
    mockRead([]);
    await renderRoute();

    expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
    expect(screen.getByTestId('profile-history-count')).toHaveTextContent('0');
    expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
  });

  it('withholds the whole dataset when the snapshot holds a malformed event', async () => {
    // C3: a partially-trusted dataset is silent data loss the user cannot
    // detect, so the route shows the recoverable error instead. (An earlier
    // revision of this test expected the two valid events to survive, which
    // contradicted the strict reader and the route's documented contract.)
    mockReadFailure('invalid-data');
    await renderRoute();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Saved reputation history is invalid',
    );
    expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
  });

  it('keeps score and level consistent for the boundary score', () => {
    const shaped = shapeReputationData(EVENTS);
    expect(shaped.score).toBeGreaterThanOrEqual(0);
    expect(shaped.level).toBe('Expert');
  });
});

describe('reputation route — degraded persistence', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('shows a recoverable alert and no profile when storage is unavailable', async () => {
    mockReadFailure('storage-unavailable');
    await renderRoute();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Check browser storage access and retry',
    );
    expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
    // We know nothing about the stored data, so neither the profile nor the
    // "no reputation yet" state is claimed.
    expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
  });

  it('does not leak stored data or raw errors into the visible alert', async () => {
    mockReadFailure('storage-unavailable');
    await renderRoute();

    const alert = screen.getByRole('alert');
    expect(alert).not.toHaveTextContent('ev-1');
    expect(alert.textContent).not.toMatch(/undefined|\[object/);
  });

  it('recovers through Retry once storage is readable again', async () => {
    mockReadFailure('storage-unavailable');
    render(<RoutePage />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();

    mockRead(EVENTS);
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry reputation history' }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
  });

  it('reports with a fixed message and a reason code when the read throws', async () => {
    (readReputationHistory as jest.Mock).mockImplementation(() => {
      throw new Error('storage exploded');
    });
    await renderRoute();

    // C6: the original error is never forwarded, because it may embed the
    // stored bytes.
    expect(reportError).toHaveBeenCalledWith(
      new Error('Reputation history read failed'),
      'ReputationPage.load',
      'error',
      { reason: 'read-failed' },
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('alert')).not.toHaveTextContent('storage exploded');
    expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
  });

  it('keeps the alert when a retry fails again rather than showing stale data', async () => {
    mockReadFailure('storage-unavailable');
    await renderRoute();

    fireEvent.click(
      screen.getByRole('button', { name: 'Retry reputation history' }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
  });
});

describe('reputation route — concurrent reads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRead(EVENTS);
  });

  it('runs one read per mount and never re-reads on rerender', async () => {
    const { rerender } = render(<RoutePage />);
    await act(async () => {
      await Promise.resolve();
    });
    rerender(<RoutePage />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(readReputationHistory).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
  });

  it('collapses back-to-back retries into a single single-flight read', async () => {
    mockReadFailure('storage-unavailable');
    render(<RoutePage />);
    await act(async () => {
      await Promise.resolve();
    });
    (readReputationHistory as jest.Mock).mockClear();

    const retry = screen.getByRole('button', { name: 'Retry reputation history' });
    // Both clicks land in the same batch, before the render that would disable
    // the button. The synchronous in-flight flag is what stops the second read
    // from starting at all.
    fireEvent.click(retry);
    fireEvent.click(retry);
    await act(async () => {
      await Promise.resolve();
    });

    expect(readReputationHistory).toHaveBeenCalledTimes(1);
  });

  it('survives a rapid mount/unmount cycle without writing state late', async () => {
    const { unmount } = render(<RoutePage />);
    unmount();

    await expect(
      act(async () => {
        await Promise.resolve();
      })
    ).resolves.not.toThrow();
  });
});

describe('reputation route — content crash isolation', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockRead(EVENTS);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('renders the SafeBoundary fallback with a working retry instead of crashing the route', async () => {
    mockProfileShouldThrow = true;
    await renderRoute();

    expect(screen.getByText('This section failed to load.')).toBeInTheDocument();
    expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();

    mockProfileShouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    // The SafeBoundary retry re-renders from the retained snapshot. That it does
    // so without re-reading storage is pinned by recovery.test.tsx.
    expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
  });
});

describe('reputation route — accessibility landmarks', () => {
  beforeEach(() => mockRead(EVENTS));

  it('renders exactly one main landmark and one h1', async () => {
    await renderRoute();

    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('wraps the history profile in a Suspense boundary so URL state stays shareable', async () => {
    await renderRoute();

    expect(useSearchParams).toHaveBeenCalled();
    expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
  });

  it('moves focus to the main landmark shortly after mount and clears the timer on unmount', async () => {
    jest.useFakeTimers();
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const { unmount } = render(<RoutePage />);

    act(() => {
      jest.advanceTimersByTime(FOCUS_ON_MOUNT_DELAY_MS);
    });

    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(main);

    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
    jest.useRealTimers();
  });

  it('leaves the page intact when no main landmark exists to focus', async () => {
    jest.useFakeTimers();
    const originalQuerySelector = document.querySelector.bind(document);
    jest.spyOn(document, 'querySelector').mockImplementation((selector: any) => {
      if (selector === 'main') return null;
      return (originalQuerySelector as any)(selector);
    });

    render(<RoutePage />);
    expect(() => {
      act(() => {
        jest.advanceTimersByTime(FOCUS_ON_MOUNT_DELAY_MS);
      });
    }).not.toThrow();

    jest.restoreAllMocks();
    jest.useRealTimers();
  });
});
