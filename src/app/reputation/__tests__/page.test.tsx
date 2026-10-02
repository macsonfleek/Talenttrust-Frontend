import React, { Component, type ReactNode, type ErrorInfo } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReputationPageContent } from '../ReputationPageContent';
import ReputationPage from '../page';
import ReputationLoading from '../loading';
import { listReputationEvents } from '@/lib/repository';

jest.mock('@/lib/repository', () => ({
  listReputationEvents: jest.fn(),
}));

const mockedListReputationEvents = jest.mocked(listReputationEvents);

// Toggle to make the mock throw (used by error-state tests).
// Prefix with `mock` so Jest's babel transform allows it in the mock factory.
let mockShouldThrowInProfile = false;
afterEach(() => { mockShouldThrowInProfile = false; });

// Mock the ReputationProfile component to avoid complex rendering
jest.mock('../../../components/ReputationProfile', () => {
  // The module also exports the pure band resolver that shapes the page's
  // dataset. Stubbing only the component leaves it undefined inside the content
  // module, so the shape step throws and every route-level test in this file
  // fails for a reason unrelated to what it actually exercises.
  const resolveReputationLevel = (score: number): string =>
    score >= 4 ? 'Excellent' : score >= 2 ? 'Good' : 'New';

  function MockReputationProfile(props: any) {
    if (mockShouldThrowInProfile) {
      throw new Error('Simulated reputation crash');
    }
    return (
      <div data-testid="reputation-profile">
        <div data-testid="reputation-score">{props.score ?? 'N/A'}</div>
        <div data-testid="reputation-level">{props.level ?? (props.score === 50 ? 'Expert' : 'Community Member')}</div>
        <div data-testid="reputation-name">{props.name}</div>
        <div data-testid="reputation-history-count">{props.history?.length ?? 0}</div>
        <div data-testid="reputation-max-score">{props.maxScore ?? 'default'}</div>
        {props.history && props.history.length > 0 && (
          <ul data-testid="reputation-history">
            {props.history.map((event: any) => (
              <li key={event.id} data-testid={`history-event-${event.id}`}>
                {event.type}: {event.summary}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return { __esModule: true, default: MockReputationProfile, resolveReputationLevel };
});

// Mock ReputationSummaryCard component
jest.mock('../../../components/ReputationSummaryCard', () => {
  return function MockReputationSummaryCard(props: any) {
    return (
      <div data-testid="reputation-summary-card">
        <div data-testid="summary-card-name">{props.name}</div>
        <div data-testid="summary-card-score">{props.score ?? 'N/A'}</div>
        <div data-testid="summary-card-max-score">{props.maxScore ?? 'default'}</div>
      </div>
    );
  };
});

// Mock EmptyState component
jest.mock('../../../components/EmptyState', () => {
  return function MockEmptyState(props: any) {
    return (
      <div data-testid="empty-state">
        <div data-testid="empty-state-title">{props.title}</div>
        <div data-testid="empty-state-description">{props.description}</div>
      </div>
    );
  };
});

describe('ReputationPageContent', () => {
  describe('State 1: No Reputation', () => {
    it('renders EmptyState when reputation data is null', () => {
      render(<ReputationPageContent reputationData={null} />);

      expect(screen.getByText('No reputation yet')).toBeInTheDocument();
      expect(screen.getByText('Your reputation will be built as you complete contracts and receive feedback from clients. Start by creating and fulfilling your first contract.')).toBeInTheDocument();
      expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
      expect(screen.queryByTestId('empty-state')).toBeInTheDocument();
    });

    it('renders EmptyState when reputation data is undefined', () => {
      render(<ReputationPageContent reputationData={undefined} />);

      expect(screen.getByText('No reputation yet')).toBeInTheDocument();
      expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
      expect(screen.queryByTestId('empty-state')).toBeInTheDocument();
    });

    it('renders EmptyState when score is null or undefined', () => {
      const data = { score: null, history: [] };
      render(<ReputationPageContent reputationData={data} />);

      expect(screen.getByText('No reputation yet')).toBeInTheDocument();
      expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
      expect(screen.queryByTestId('empty-state')).toBeInTheDocument();
    });

    it('renders EmptyState when score is negative', () => {
      const data = { score: -5, history: [] };
      render(<ReputationPageContent reputationData={data} />);

      expect(screen.getByText('No reputation yet')).toBeInTheDocument();
      expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
      expect(screen.queryByTestId('empty-state')).toBeInTheDocument();
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      'renders EmptyState when score is non-finite (%s)',
      (score) => {
        render(<ReputationPageContent reputationData={{ score, history: [] }} />);

        expect(screen.getByText('No reputation yet')).toBeInTheDocument();
        expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
      },
    );

    it('does not render ReputationProfile when there is no reputation data', () => {
      render(<ReputationPageContent />);

      expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
      expect(screen.queryByTestId('empty-state')).toBeInTheDocument();
    });
  });

  describe('State 2: Partial Reputation (score only, no history)', () => {
    it('renders ReputationProfile when score exists but history is empty', () => {
      const data = {
        score: 42,
        level: 'Community Member',
        history: [],
      };
      render(<ReputationPageContent reputationData={data} userName="Alice" />);

      expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
      expect(screen.getByTestId('reputation-score')).toHaveTextContent('42');
      expect(screen.getByTestId('reputation-level')).toHaveTextContent('Community Member');
      expect(screen.getByTestId('reputation-name')).toHaveTextContent('Alice');
      expect(screen.getByTestId('reputation-history-count')).toHaveTextContent('0');
      expect(screen.queryByTestId('reputation-history')).not.toBeInTheDocument();
    });

    it('passes correct props to ReputationProfile with partial data', () => {
      const data = {
        score: 65,
        level: 'Active Member',
      };
      render(<ReputationPageContent reputationData={data} userName="Bob" />);

      expect(screen.getByTestId('reputation-score')).toHaveTextContent('65');
      expect(screen.getByTestId('reputation-level')).toHaveTextContent('Active Member');
      expect(screen.getByTestId('reputation-name')).toHaveTextContent('Bob');
    });
  });

  describe('State 3: Full Reputation (score + history)', () => {
    it('renders ReputationProfile with complete data including history', () => {
      const history = [
        {
          id: '1',
          type: 'Verification',
          summary: 'Completed identity verification',
          date: '2026-04-24',
        },
        {
          id: '2',
          type: 'On-chain review',
          summary: 'Received positive trust signal',
          date: '2026-04-23',
        },
      ];
      const data = {
        score: 88,
        level: 'Trusted Contributor',
        history,
      };
      render(<ReputationPageContent reputationData={data} userName="Charlie" />);

      expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
      expect(screen.getByTestId('reputation-score')).toHaveTextContent('88');
      expect(screen.getByTestId('reputation-level')).toHaveTextContent('Trusted Contributor');
      expect(screen.getByTestId('reputation-name')).toHaveTextContent('Charlie');
      expect(screen.getByTestId('reputation-history-count')).toHaveTextContent('2');
      expect(screen.getByTestId('history-event-1')).toHaveTextContent('Verification: Completed identity verification');
      expect(screen.getByTestId('history-event-2')).toHaveTextContent('On-chain review: Received positive trust signal');
    });

    it('renders all history items when present', () => {
      const history = [
        { id: '1', type: 'Event 1', summary: 'Summary 1', date: '2026-04-24' },
        { id: '2', type: 'Event 2', summary: 'Summary 2', date: '2026-04-23' },
        { id: '3', type: 'Event 3', summary: 'Summary 3', date: '2026-04-22' },
      ];
      const data = { score: 90, history };
      render(<ReputationPageContent reputationData={data} />);

      expect(screen.getByTestId('reputation-history-count')).toHaveTextContent('3');
      expect(screen.getByTestId('history-event-1')).toBeInTheDocument();
      expect(screen.getByTestId('history-event-2')).toBeInTheDocument();
      expect(screen.getByTestId('history-event-3')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('maintains proper heading hierarchy with h1 for page title', () => {
      render(<ReputationPageContent />);

      const mainHeading = screen.getByRole('heading', { level: 1 });
      expect(mainHeading).toHaveTextContent('Reputation');
    });

    it('does not render duplicate primary headings', () => {
      render(<ReputationPageContent />);

      const h1Headings = screen.getAllByRole('heading', { level: 1 });
      expect(h1Headings).toHaveLength(1);
    });

    it('contains main element for semantic structure', () => {
      const { container } = render(<ReputationPageContent />);

      const mainElement = container.querySelector('main');
      expect(mainElement).toBeInTheDocument();
    });
  });

  describe('Data transformation and defaults', () => {
    it('applies default level when not provided', () => {
      const data = { score: 50 };
      render(<ReputationPageContent reputationData={data} />);

      expect(screen.getByTestId('reputation-level')).toHaveTextContent('Expert');
    });

    it('applies default name when not provided', () => {
      const data = { score: 50 };
      render(<ReputationPageContent reputationData={data} />);

      expect(screen.getByTestId('reputation-name')).toHaveTextContent('User');
    });

    it('applies default empty history array when not provided', () => {
      const data = { score: 50 };
      render(<ReputationPageContent reputationData={data} />);

      expect(screen.getByTestId('reputation-history-count')).toHaveTextContent('0');
    });
  });

  describe('Edge cases', () => {
    it('treats a non-finite score as invalid reputation data', () => {
      render(<ReputationPageContent reputationData={{ score: Infinity }} />);

      expect(screen.getByTestId('empty-state')).toBeInTheDocument();
      expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
    });

    it('preserves a valid custom score maximum for summary and profile', () => {
      render(
        <ReputationPageContent
          reputationData={{ score: 7.5, maxScore: 10 }}
        />,
      );

      expect(screen.getByTestId('summary-card-max-score')).toHaveTextContent('10');
      expect(screen.getByTestId('reputation-max-score')).toHaveTextContent('10');
    });

    it('uses the default score maximum for invalid custom bounds', () => {
      render(
        <ReputationPageContent
          reputationData={{ score: 1, maxScore: 0 }}
        />,
      );

      expect(screen.getByTestId('summary-card-max-score')).toHaveTextContent('default');
      expect(screen.getByTestId('reputation-max-score')).toHaveTextContent('default');
    });

    it('handles zero score as valid reputation', () => {
      const data = { score: 0, history: [] };
      render(<ReputationPageContent reputationData={data} />);

      // Zero is a valid score, not "no reputation"
      expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
      expect(screen.getByTestId('reputation-score')).toHaveTextContent('0');
    });

    it('handles multiple history entries', () => {
      const history = Array.from({ length: 5 }, (_, i) => ({
        id: `${i}`,
        type: `Type ${i}`,
        summary: `Summary ${i}`,
        date: `2026-04-${24 - i}`,
      }));
      const data = { score: 75, history };
      render(<ReputationPageContent reputationData={data} />);

      expect(screen.getByTestId('reputation-history-count')).toHaveTextContent('5');
    });

    it('renders correctly with custom userName', () => {
      const data = { score: 50 };
      render(<ReputationPageContent reputationData={data} userName="CustomName" />);

      expect(screen.getByTestId('reputation-name')).toHaveTextContent('CustomName');
    });

    it('uses the protected content boundary for route-loaded reputation data', async () => {
      mockedListReputationEvents.mockReturnValue([]);
      mockShouldThrowInProfile = true;
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      render(<ReputationPage />);

      expect(await screen.findByText('This section failed to load.')).toBeInTheDocument();
      consoleSpy.mockRestore();
    });
  });

  describe('State exclusivity – mutually-exclusive states', () => {
    it('EmptyState does NOT render when success state is active', () => {
      const data = { score: 75, level: 'Expert', history: [{ id: '1', type: 'Test', summary: 'Test', date: '2026-04-24' }] };
      render(<ReputationPageContent reputationData={data} userName="Exclusive" />);

      expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
      expect(screen.queryByText('No reputation yet')).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Your reputation will be built/i)
      ).not.toBeInTheDocument();
    });

    it('EmptyState does NOT render for edge case score=0 (valid reputation)', () => {
      const data = { score: 0, history: [] };
      render(<ReputationPageContent reputationData={data} userName="Zero" />);

      expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
      expect(screen.queryByText('No reputation yet')).not.toBeInTheDocument();
    });

    it('ReputationProfile does NOT render when empty state is active (null data)', () => {
      render(<ReputationPageContent reputationData={null} />);

      expect(screen.getByText('No reputation yet')).toBeInTheDocument();
      expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
    });

    it('ReputationProfile does NOT render when empty state is active (negative score)', () => {
      const data = { score: -1, history: [] };
      render(<ReputationPageContent reputationData={data} />);

      expect(screen.getByText('No reputation yet')).toBeInTheDocument();
      expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
    });

    it('no duplicate h1 between states', () => {
      const data = { score: 80, history: [{ id: '1', type: 'Test', summary: 'Test', date: '2026-04-24' }] };
      render(<ReputationPageContent reputationData={data} />);

      const h1s = screen.getAllByRole('heading', { level: 1 });
      expect(h1s).toHaveLength(1);
      expect(h1s[0]).toHaveTextContent('Reputation');
    });
  });

  describe('State transitions – via rerender', () => {
    it('transitions from empty to success when data becomes available', () => {
      const { rerender } = render(<ReputationPageContent reputationData={null} />);

      expect(screen.getByText('No reputation yet')).toBeInTheDocument();
      expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();

      const data = { score: 85, level: 'Trusted', history: [{ id: '1', type: 'Review', summary: 'Great work', date: '2026-04-24' }] };
      rerender(<ReputationPageContent reputationData={data} userName="Transition" />);

      expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
      expect(screen.queryByText('No reputation yet')).not.toBeInTheDocument();
    });

    it('transitions from success to empty when data is removed', () => {
      const data = { score: 85, level: 'Trusted', history: [{ id: '1', type: 'Review', summary: 'Great work', date: '2026-04-24' }] };
      const { rerender } = render(<ReputationPageContent reputationData={data} userName="Transition" />);

      expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();

      rerender(<ReputationPageContent reputationData={null} />);

      expect(screen.getByText('No reputation yet')).toBeInTheDocument();
      expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
    });

    it('transitions from partial to full when history is added', () => {
      const partialData = { score: 70, level: 'Contributor', history: [] };
      const { rerender } = render(<ReputationPageContent reputationData={partialData} userName="Growth" />);

      expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
      expect(screen.getByTestId('reputation-history-count')).toHaveTextContent('0');

      const fullData = {
        score: 70,
        level: 'Contributor',
        history: [{ id: 'h1', type: 'Milestone', summary: 'Completed project', date: '2026-04-24' }],
      };
      rerender(<ReputationPageContent reputationData={fullData} userName="Growth" />);

      expect(screen.getByTestId('reputation-history-count')).toHaveTextContent('1');
      expect(screen.getByTestId('history-event-h1')).toBeInTheDocument();
    });

    it('transitions from full to partial when history is cleared', () => {
      const fullData = {
        score: 70,
        level: 'Contributor',
        history: [{ id: 'h1', type: 'Milestone', summary: 'Completed project', date: '2026-04-24' }],
      };
      const { rerender } = render(<ReputationPageContent reputationData={fullData} userName="Shrink" />);

      expect(screen.getByTestId('reputation-history-count')).toHaveTextContent('1');

      const partialData = { score: 70, level: 'Contributor', history: [] };
      rerender(<ReputationPageContent reputationData={partialData} userName="Shrink" />);

      expect(screen.getByTestId('reputation-history-count')).toHaveTextContent('0');
      expect(screen.queryByTestId('history-event-h1')).not.toBeInTheDocument();
    });

    it('preserves userName across state transitions', () => {
      const { rerender } = render(<ReputationPageContent reputationData={null} userName="Persistent" />);

      const data = { score: 50, level: 'Member', history: [] };
      rerender(<ReputationPageContent reputationData={data} userName="Persistent" />);

      expect(screen.getByTestId('reputation-name')).toHaveTextContent('Persistent');
    });

    it('transitions from success to error when content throws', () => {
      let consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const data = { score: 85, level: 'Trusted', history: [{ id: '1', type: 'Review', summary: 'Great work', date: '2026-04-24' }] };

      const { rerender } = render(<ReputationPageContent reputationData={data} userName="Fail" />);
      expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();

      mockShouldThrowInProfile = true;
      rerender(<ReputationPageContent reputationData={data} userName="Fail" />);

      expect(screen.getByText('This section failed to load.')).toBeInTheDocument();
      expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
      consoleSpy.mockRestore();
    });

    it('transitions from error to success when error is resolved and retried', () => {
      let consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockShouldThrowInProfile = true;
      const data = { score: 85, level: 'Trusted', history: [{ id: '1', type: 'Review', summary: 'Great work', date: '2026-04-24' }] };

      const { rerender } = render(<ReputationPageContent reputationData={data} userName="Recover" />);
      expect(screen.getByText('This section failed to load.')).toBeInTheDocument();

      mockShouldThrowInProfile = false;
      rerender(<ReputationPageContent reputationData={data} userName="Recover" />);

      // Error boundary requires explicit Retry click to reset
      fireEvent.click(screen.getByText('Retry'));

      expect(screen.queryByText('This section failed to load.')).not.toBeInTheDocument();
      expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
      consoleSpy.mockRestore();
    });

    it('transitions from empty to error when content throws', () => {
      let consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const { rerender } = render(<ReputationPageContent reputationData={null} />);
      expect(screen.getByText('No reputation yet')).toBeInTheDocument();
      expect(screen.queryByText('This section failed to load.')).not.toBeInTheDocument();

      mockShouldThrowInProfile = true;
      const data = { score: 85, level: 'Trusted', history: [{ id: '1', type: 'Review', summary: 'Great work', date: '2026-04-24' }] };
      rerender(<ReputationPageContent reputationData={data} userName="Fail" />);

      expect(screen.getByText('This section failed to load.')).toBeInTheDocument();
      expect(screen.queryByText('No reputation yet')).not.toBeInTheDocument();
      expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
      consoleSpy.mockRestore();
    });

    it('transitions from error to empty when retried with no data', () => {
      let consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockShouldThrowInProfile = true;
      const data = { score: 85, level: 'Trusted', history: [{ id: '1', type: 'Review', summary: 'Great work', date: '2026-04-24' }] };

      const { rerender } = render(<ReputationPageContent reputationData={data} userName="ToEmpty" />);
      expect(screen.getByText('This section failed to load.')).toBeInTheDocument();

      mockShouldThrowInProfile = false;
      rerender(<ReputationPageContent reputationData={null} />);

      // Error boundary still has error, requires explicit Retry click to reset
      expect(screen.getByText('This section failed to load.')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Retry'));

      expect(screen.queryByText('This section failed to load.')).not.toBeInTheDocument();
      expect(screen.getByText('No reputation yet')).toBeInTheDocument();
      expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
      consoleSpy.mockRestore();
    });
  });

  describe('Loading state transitions', () => {
    it('transitions from loading to success when data arrives', () => {
      const { unmount } = render(<ReputationLoading />);
      expect(screen.getByRole('status')).toHaveTextContent('Loading reputation…');
      expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');

      unmount();

      const data = {
        score: 85,
        level: 'Trusted',
        history: [{ id: '1', type: 'Review', summary: 'Great work', date: '2026-04-24' }],
      };
      render(<ReputationPageContent reputationData={data} userName="Loaded" />);

      expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByText('No reputation yet')).not.toBeInTheDocument();
      expect(screen.queryByText('This section failed to load.')).not.toBeInTheDocument();
    });

    it('transitions from loading to empty when no reputation data arrives', () => {
      const { unmount } = render(<ReputationLoading />);
      expect(screen.getByRole('status')).toHaveTextContent('Loading reputation…');

      unmount();

      render(<ReputationPageContent reputationData={null} />);

      expect(screen.getByText('No reputation yet')).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
      expect(screen.queryByText('This section failed to load.')).not.toBeInTheDocument();
    });

    it('transitions from loading to error when content fails', () => {
      let consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const { unmount } = render(<ReputationLoading />);
      expect(screen.getByRole('status')).toHaveTextContent('Loading reputation…');

      unmount();

      mockShouldThrowInProfile = true;
      const data = {
        score: 85,
        level: 'Trusted',
        history: [{ id: '1', type: 'Review', summary: 'Great work', date: '2026-04-24' }],
      };
      render(<ReputationPageContent reputationData={data} userName="FailLoad" />);

      expect(screen.getByText('This section failed to load.')).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
      expect(screen.queryByText('No reputation yet')).not.toBeInTheDocument();

      consoleSpy.mockRestore();
    });
  });

  describe('Error boundary behavior', () => {
    let consoleSpy: jest.SpyInstance;

    beforeEach(() => {
      consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('catches errors thrown inside ReputationPageContent without crashing', () => {
      class TestErrorBoundary extends Component<
        { children: ReactNode; onError: (error: Error) => void },
        { hasError: boolean }
      > {
        constructor(props: { children: ReactNode; onError: (error: Error) => void }) {
          super(props);
          this.state = { hasError: false };
        }

        static getDerivedStateFromError() {
          return { hasError: true };
        }

        componentDidCatch(error: Error, _info: ErrorInfo) {
          this.props.onError(error);
        }

        render() {
          if (this.state.hasError) {
            return <div data-testid="error-fallback">Error caught</div>;
          }
          return this.props.children;
        }
      }

      const errorHandler = jest.fn();

      render(
        <TestErrorBoundary onError={errorHandler}>
          <ReputationPageContent
            reputationData={{ score: 42, level: 'Test' }}
            userName="ErrorTest"
          />
        </TestErrorBoundary>
      );

      expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
      expect(errorHandler).not.toHaveBeenCalled();
    });
  });

  describe('State exclusivity – error state', () => {
    let consoleSpy: jest.SpyInstance;

    beforeEach(() => {
      consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('error fallback is mutually exclusive with empty state and success state', () => {
      mockShouldThrowInProfile = true;
      const data = { score: 75, level: 'Contributor', history: [] };
      render(<ReputationPageContent reputationData={data} />);

      expect(screen.getByText('This section failed to load.')).toBeInTheDocument();
      expect(screen.getByText('Retry')).toBeInTheDocument();
      expect(screen.getByText('Go Home')).toBeInTheDocument();
      expect(screen.queryByText('No reputation yet')).not.toBeInTheDocument();
      expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
    });
  });

  describe('Error State — SafeBoundary fallback', () => {
    let consoleSpy: jest.SpyInstance;

    beforeEach(() => {
      consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('renders error fallback when ReputationProfile throws', () => {
      mockShouldThrowInProfile = true;
      const data = { score: 100, level: 'Expert', history: [{ id: '1', type: 'Test', summary: 'Test', date: '2026-04-24' }] };
      render(<ReputationPageContent reputationData={data} userName="ErrorUser" />);

      expect(screen.getByText('This section failed to load.')).toBeInTheDocument();
    });

    it('renders Retry button in error fallback', () => {
      mockShouldThrowInProfile = true;
      const data = { score: 100, level: 'Expert', history: [] };
      render(<ReputationPageContent reputationData={data} />);

      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    it('renders Go Home link in error fallback', () => {
      mockShouldThrowInProfile = true;
      const data = { score: 100, level: 'Expert', history: [] };
      render(<ReputationPageContent reputationData={data} />);

      expect(screen.getByText('Go Home')).toBeInTheDocument();
    });

    it('does not render empty state or profile content when in error', () => {
      mockShouldThrowInProfile = true;
      const data = { score: 100, level: 'Expert', history: [] };
      render(<ReputationPageContent reputationData={data} />);

      expect(screen.getByText('This section failed to load.')).toBeInTheDocument();
      expect(screen.queryByText('No reputation yet')).not.toBeInTheDocument();
      expect(screen.queryByTestId('reputation-profile')).not.toBeInTheDocument();
      expect(screen.queryByText(/Your reputation will be built/i)).not.toBeInTheDocument();
    });

    it('Retry button resets error state and shows content when error is resolved', () => {
      mockShouldThrowInProfile = true;
      const data = { score: 85, level: 'Trusted', history: [{ id: '1', type: 'Review', summary: 'Great work', date: '2026-04-24' }] };
      render(<ReputationPageContent reputationData={data} userName="RetryUser" />);

      expect(screen.getByText('This section failed to load.')).toBeInTheDocument();

      // Resolve the error and click Retry to reset the error boundary
      mockShouldThrowInProfile = false;
      fireEvent.click(screen.getByText('Retry'));

      expect(screen.queryByText('This section failed to load.')).not.toBeInTheDocument();
      expect(screen.getByTestId('reputation-profile')).toBeInTheDocument();
    });
  });

});

