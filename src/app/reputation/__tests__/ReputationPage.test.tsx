import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReputationPage from '../page';
import {
  REPUTATION_MAX_SCORE,
  validateReputationData,
} from '@/lib/validateReputationData';
import { STORAGE_KEY } from '@/lib/repository';
import { reportError } from '@/lib/errorReporter';

jest.mock('../loading', () => {
  return function MockReputationLoading() {
    return (
      <main aria-busy="true">
        <span role="status">Loading reputation…</span>
      </main>
    );
  };
});

// The route imports both the content component and `shapeReputationData` from
// this module, so the mock has to cover its whole public surface: stubbing only
// the component would leave the shaping helper undefined in the route and fail
// for a reason that has nothing to do with what this suite tests.
// The route imports both the content component and `shapeReputationData` from
// this module, so the mock must cover its whole public surface — stubbing only
// the component leaves the shaping helper undefined inside the route, failing
// for a reason unrelated to what this suite exercises.
//
// `shapeReputationData` is mirrored here rather than pulled in with
// `requireActual`: the content module transitively imports the profile component,
// and re-evaluating it inside the mock factory collides with this file's hoisted
// React bindings. The real implementation is covered directly by
// `__tests__/page-contracts.test.tsx`.
jest.mock('../ReputationPageContent', () => ({
  REPUTATION_DEMO_SCORE: 4.5,
  shapeReputationData: (history: unknown[]) => ({
    score: 4.5,
    level: 'Excellent',
    history,
  }),
  normalizeReputationPageInput: (reputationData: unknown) => ({
    reputationData: reputationData ?? null,
    userName: 'User',
  }),
  ReputationPageContent: ({
    reputationData,
    children,
  }: {
    reputationData: { score?: number | null; history?: unknown[] } | null;
    // `children` carries the route's loading / recovery regions. They must be
    // rendered here, otherwise the stub silently swallows the alert this suite
    // asserts on and every recovery test fails for the wrong reason.
    children?: React.ReactNode;
  }) => (
    <div data-testid="reputation-page-content">
      <span data-testid="content-score">{reputationData?.score ?? 'null'}</span>
      <span data-testid="content-history-length">
        {reputationData?.history?.length ?? 0}
      </span>
      {children}
    </div>
  ),
}));

jest.mock('@/lib/repository', () => ({
  listReputationEvents: jest.fn(),
}));

jest.mock('@/lib/errorReporter', () => ({
  reportError: jest.fn(),
}));

const mockReportError =
  reportError as jest.MockedFunction<typeof reportError>;

const validEvent = {
  id: 'evt-1',
  type: 'Review',
  summary: 'Positive review',
  date: '2026-09-01',
  // version starts at 1: `readReputationHistory` rejects a version below 1 as
  // corrupt, so a 0 here would turn every route case into an invalid-data
  // failure rather than exercising the valid path.
  version: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore();
});

describe('validateReputationData', () => {
  it('accepts the minimum score boundary of 0', () => {
    expect(() =>
      validateReputationData({ score: 0, history: [] }),
    ).not.toThrow();
  });

  it(`accepts the maximum score boundary of ${REPUTATION_MAX_SCORE}`, () => {
    expect(() =>
      validateReputationData({ score: REPUTATION_MAX_SCORE, history: [] }),
    ).not.toThrow();
  });

  it('accepts null or omitted optional score', () => {
    expect(() => validateReputationData({ score: null, history: [] })).not.toThrow();
    expect(() => validateReputationData({ history: [] })).not.toThrow();
  });

  it('rejects negative scores', () => {
    expect(() =>
      validateReputationData({ score: -0.01, history: [] }),
    ).toThrow(/between 0 and 5/);
  });

  it('rejects scores above the maximum', () => {
    expect(() =>
      validateReputationData({ score: REPUTATION_MAX_SCORE + 0.01, history: [] }),
    ).toThrow(/between 0 and 5/);
  });

  it('rejects NaN and infinite scores', () => {
    expect(() => validateReputationData({ score: NaN })).toThrow();
    expect(() => validateReputationData({ score: Infinity })).toThrow();
    expect(() => validateReputationData({ score: -Infinity })).toThrow();
  });

  it('rejects non-numeric scores', () => {
    expect(() => validateReputationData({ score: '4.5' })).toThrow();
    expect(() => validateReputationData({ score: true })).toThrow();
  });

  it('rejects non-array history', () => {
    expect(() =>
      validateReputationData({ history: { id: 'evt-1' } }),
    ).toThrow(/history must be an array/);
  });

  it('accepts a valid reputation event', () => {
    expect(() =>
      validateReputationData({ score: 4.5, history: [validEvent] }),
    ).not.toThrow();
  });

  it('rejects blank event identifiers', () => {
    expect(() =>
      validateReputationData({
        score: 4.5,
        history: [{ ...validEvent, id: '   ' }],
      }),
    ).toThrow(/invalid id/);
  });

  it('rejects blank event type or summary', () => {
    expect(() =>
      validateReputationData({
        score: 4.5,
        history: [{ ...validEvent, type: '   ' }],
      }),
    ).toThrow(/invalid type/);

    expect(() =>
      validateReputationData({
        score: 4.5,
        history: [{ ...validEvent, summary: '' }],
      }),
    ).toThrow(/invalid summary/);
  });

  it('rejects invalid dates', () => {
    expect(() =>
      validateReputationData({
        score: 4.5,
        history: [{ ...validEvent, date: 'not-a-date' }],
      }),
    ).toThrow(/invalid date/);
  });

  it('rejects invalid versions', () => {
    expect(() =>
      validateReputationData({
        score: 4.5,
        history: [{ ...validEvent, version: -1 }],
      }),
    ).toThrow(/invalid version/);

    expect(() =>
      validateReputationData({
        score: 4.5,
        history: [{ ...validEvent, version: 1.5 }],
      }),
    ).toThrow(/invalid version/);
  });

  it('rejects duplicate event IDs deterministically', () => {
    expect(() =>
      validateReputationData({
        score: 4.5,
        history: [
          validEvent,
          { ...validEvent, summary: 'Second event' },
        ],
      }),
    ).toThrow(/duplicate event identifiers/);
  });
});

describe('ReputationPage route', () => {
  // The route reads through `readReputationHistory` (a strict, read-only
  // localStorage snapshot) rather than the repository list helper, so these
  // cases seed storage directly. `__tests__/recovery.test.tsx` covers the
  // retention / StrictMode / concurrency matrix in depth; this block pins the
  // boundaries most likely to regress: empty, valid, corrupt, and non-leakage
  // of the underlying error.
  const seed = (history: unknown) =>
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ reputationEvents: history, contracts: [{ id: 'keep' }] }),
    );

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders the empty result through the canonical content boundary', async () => {
    render(<ReputationPage />);

    await waitFor(() => {
      expect(screen.getByTestId('reputation-page-content')).toBeInTheDocument();
    });

    expect(screen.getByTestId('content-score')).toHaveTextContent('4.5');
    expect(screen.getByTestId('content-history-length')).toHaveTextContent('0');
    // An empty store is a successful read, not a failure.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('passes validated history to the canonical content boundary', async () => {
    seed([validEvent]);

    render(<ReputationPage />);

    await waitFor(() => {
      expect(screen.getByTestId('reputation-page-content')).toBeInTheDocument();
    });

    expect(screen.getByTestId('content-score')).toHaveTextContent('4.5');
    expect(screen.getByTestId('content-history-length')).toHaveTextContent('1');
  });

  it('rejects corrupt history into the safe error state', async () => {
    seed([
      { ...validEvent, id: 'evt-1' },
      { ...validEvent, id: 'evt-1', summary: 'Duplicate' },
    ]);

    render(<ReputationPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Saved reputation history is invalid');
    // C3: the corrupt dataset is withheld entirely rather than partially shown.
    expect(screen.queryByTestId('reputation-page-content')).not.toBeInTheDocument();
    // C6: no event payload reaches the UI.
    expect(alert).not.toHaveTextContent('evt-1');
    expect(alert).not.toHaveTextContent('Duplicate');
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError).toHaveBeenCalledWith(
      new Error('Reputation history read failed'),
      'ReputationPage.load',
      'error',
      { reason: 'invalid-data' },
    );
  });

  it('does not expose the raw repository error to the user', async () => {
    jest.spyOn(window.localStorage, 'getItem').mockImplementationOnce(() => {
      throw new Error('sensitive storage failure');
    });

    render(<ReputationPage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    expect(screen.queryByText('sensitive storage failure')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).not.toHaveTextContent('sensitive storage failure');
    expect(mockReportError).toHaveBeenCalledWith(
      new Error('Reputation history read failed'),
      'ReputationPage.load',
      'error',
      { reason: 'storage-unavailable' },
    );
  });

  it('does not update state after the route unmounts during a load', async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    jest
      .spyOn(require('@/lib/readReputationHistory'), 'readReputationHistory')
      .mockReturnValueOnce(pending);

    const { unmount } = render(<ReputationPage />);
    await act(async () => {
      await Promise.resolve();
    });
    unmount();

    await act(async () => finish([validEvent]));

    // C2: neither state nor diagnostics after unmount.
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it('recovers from a failed load when Retry is clicked', async () => {
    jest.spyOn(window.localStorage, 'getItem').mockImplementationOnce(() => {
      throw new Error('temporary storage failure');
    });
    seed([validEvent]);

    render(<ReputationPage />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Retry reputation history' }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry reputation history' }));

    await waitFor(() => {
      expect(screen.getByTestId('reputation-page-content')).toBeInTheDocument();
    });

    expect(screen.getByTestId('content-history-length')).toHaveTextContent('1');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
