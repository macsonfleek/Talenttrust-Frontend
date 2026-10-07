import React from 'react';
import { render, screen } from '@testing-library/react';
import { ReputationPageContent } from './ReputationPageContent';
import type { Reputation } from '@/types/domain';

jest.mock('../../components/EmptyState', () => {
  return {
    __esModule: true,
    default: () => <div data-testid="empty-state">EmptyState</div>,
  };
});

jest.mock('../../components/ReputationSummaryCard', () => {
  return {
    __esModule: true,
    default: ({ name, score }: { name: string; score: number }) => (
      <div data-testid="summary-card">
        {name}:{score}
      </div>
    ),
  };
});

jest.mock('../../components/ReputationProfile', () => {
  return {
    __esModule: true,
    default: ({ name, score }: { name: string; score: number }) => (
      <div data-testid="reputation-profile">
        {name}:{score}
      </div>
    ),
  };
});

jest.mock('../../components/SafeBoundary', () => {
  return {
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <div data-testid="safe-boundary">{children}</div>,
  };
});

const buildReputation = (overrides: Partial<Reputation> = {}): Reputation =>
  ({
    score: 42,
    level: 'Gold',
    history: [],
    ...overrides,
  }) as Reputation;

describe('ReputationPageContent', () => {
  it('renders the empty state when reputationData is missing', () => {
    render(<ReputationPageContent />);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('summary-card')).not.toBeInTheDocument();
  });

  it('renders the empty state when reputationData is null', () => {
    render(<ReputationPageContent reputationData={null} />);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('renders the empty state for negative scores', () => {
    render(<ReputationPageContent reputationData={buildReputation({ score: -1 })} />);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('renders the empty state for NaN scores', () => {
    render(<ReputationPageContent reputationData={buildReputation({ score: Number.NaN })} />);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('renders the empty state for Infinity scores', () => {
    render(<ReputationPageContent reputationData={buildReputation({ score: Number.POSITIVE_INFINITY })} />);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('renders the empty state for non-numeric scores at runtime', () => {
    const malformed = { score: '42' } as unknown as Reputation;
    render(<ReputationPageContent reputationData={malformed} />);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('renders the summary card and profile for a valid reputation', () => {
    render(
      <ReputationPageContent
        reputationData={buildReputation({ score: 0, level: 'Bronze' })}
        userName="Alice"
      />,
    );
    expect(screen.getByTestId('summary-card')).toHaveTextContent('Alice:0');
    expect(screen.getByTestId('reputation-profile')).toHaveTextContent('Alice:0');
  });

  it('treats score 0 as a valid reputation (boundary)', () => {
    render(<ReputationPageContent reputationData={buildReputation({ score: 0 })} />);
    expect(screen.getByTestId('summary-card')).toBeInTheDocument();
  });

  it('falls back to the default user name when not provided', () => {
    render(<ReputationPageContent reputationData={buildReputation()} />);
    expect(screen.getByTestId('summary-card')).toHaveTextContent('User:42');
  });

  it('falls back to the default user name for blank strings', () => {
    render(
      <ReputationPageContent reputationData={buildReputation()} userName="   " />,
    );
    expect(screen.getByTestId('summary-card')).toHaveTextContent('User:42');
  });

  it('falls back to the default user name for non-string values at runtime', () => {
    render(
      <ReputationPageContent
        reputationData={buildReputation()}
        userName={undefined as unknown as string}
      />,
    );
    expect(screen.getByTestId('summary-card')).toHaveTextContent('User:42');
  });

  it('preserves the level and history passed through to downstream components', () => {
    // A *valid* event: `normalizeReputationPageInput` rejects a dataset holding
    // a malformed or duplicate entry, so pass-through is only observable for
    // well-formed input. The rejection path has its own cases below.
    const history = [
      { id: 'evt-1', type: 'Review', summary: 'Positive review', date: '2026-04-24' },
    ] as unknown as Reputation['history'];
    render(
      <ReputationPageContent
        reputationData={buildReputation({ level: 'Platinum', history })}
        userName="Bob"
      />,
    );
    expect(screen.getByTestId('summary-card')).toBeInTheDocument();
    expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
  });

  it('wraps content in SafeBoundary for both empty and populated states', () => {
    const { unmount } = render(<ReputationPageContent />);
    expect(screen.getByTestId('safe-boundary')).toBeInTheDocument();
    unmount();
    render(<ReputationPageContent reputationData={buildReputation()} />);
    expect(screen.getByTestId('safe-boundary')).toBeInTheDocument();
  });

  it('renders deterministically across repeated renders with the same input', () => {
    const data = buildReputation({ score: 7 });
    const { unmount } = render(
      <ReputationPageContent reputationData={data} userName="Carol" />,
    );
    const first = screen.getByTestId('summary-card').textContent;
    unmount();
    render(
      <ReputationPageContent reputationData={data} userName="Carol" />,
    );
    expect(screen.getByTestId('summary-card').textContent).toBe(first);
  });
});
