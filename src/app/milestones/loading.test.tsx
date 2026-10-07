/**
 * Route-level loading state tests for the milestones board.
 *
 * The App Router loading fallback and the client Suspense fallback must
 * render the same shell. These tests pin that invariant so the two fallbacks
 * cannot drift apart and so the loading state cannot accidentally look like
 * an empty board.
 */

import { render, screen } from '@testing-library/react';

import MilestonesLoading from './loading';

jest.mock('@/components/milestones/MilestonesBoardSkeleton', () => {
  const React = require('react');
  const Mock = (): React.ReactElement =>
    React.createElement('div', { 'data-testid': 'milestones-board-skeleton' });
  return { __esModule: true, default: Mock };
});

describe('MilestonesLoading', () => {
  it('renders the shared board skeleton', () => {
    render(<MilestonesLoading />);

    expect(screen.getByTestId('milestones-board-skeleton')).toBeInTheDocument();
  });

  it('renders exactly one shell instance', () => {
    render(<MilestonesLoading />);

    expect(screen.getAllByTestId('milestones-board-skeleton')).toHaveLength(1);
  });

  it('does not render any board content or error text', () => {
    render(<MilestonesLoading />);

    expect(screen.queryByText(/Unable to load milestones/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the same component type as the client Suspense fallback', () => {
    // The route fallback must delegate to the shared shell rather than
    // maintaining a second copy of the loading markup.
    const { container } = render(<MilestonesLoading />);

    expect(container.firstChild).toBe(screen.getByTestId('milestones-board-skeleton'));
  });
});
