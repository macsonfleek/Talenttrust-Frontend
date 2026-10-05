import { act, render, screen, fireEvent } from '@testing-library/react';
import GlobalError from './global-error';
import { setErrorReporter } from '../lib/errorReporter';
import { testA11y } from '../test-utils/a11y';

// Suppress React error boundary noise in test output
beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  setErrorReporter(null);
});

afterEach(() => {
  jest.restoreAllMocks();
  setErrorReporter(null);
});

const testError = new Error('Synthetic root crash');
const mockReset = jest.fn();

describe('GlobalError page', () => {
  it('renders critical error message without leaking error details', () => {
    render(<GlobalError error={testError} reset={mockReset} />);
    expect(screen.getByRole('heading', { name: /critical error/i })).toBeInTheDocument();
    expect(screen.queryByText('Synthetic root crash')).not.toBeInTheDocument();
  });

  it('calls reset when Try Again is clicked', () => {
    render(<GlobalError error={testError} reset={mockReset} />);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it('renders Home, Contact Support links and try again button', () => {
    render(<GlobalError error={testError} reset={mockReset} />);
    expect(screen.getByRole('link', { name: /go home/i })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /contact support/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('logs error to console only in non-production', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // NODE_ENV is 'test' in Jest, which is !== 'production', so logging should fire
    render(<GlobalError error={testError} reset={mockReset} />);
    expect(spy).toHaveBeenCalledWith('[Global Error Boundary]', testError);
  });

  it('does not render error message or stack trace in the UI', () => {
    render(<GlobalError error={testError} reset={mockReset} />);
    expect(screen.queryByText(/synthetic root crash/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/digest/i)).not.toBeInTheDocument();
  });

  it('invokes the pluggable error reporter when rendered', () => {
    const mockReporter = jest.fn();
    setErrorReporter(mockReporter);

    render(<GlobalError error={testError} reset={mockReset} />);

    expect(mockReporter).toHaveBeenCalledTimes(1);
    expect(mockReporter).toHaveBeenCalledWith(
      testError,
      'Global Error Boundary',
      undefined,
      undefined,
    );
  });

  it('is accessible and clean of violations via jest-axe', async () => {
    // Render and check for accessibility violations
    await testA11y(<GlobalError error={testError} reset={mockReset} />);
  });

  it('prevents duplicate reporting of the same error object', () => {
    const error = new Error('Network timeout');
    const report = jest.fn();
    setErrorReporter(report);

    const { rerender } = render(<GlobalError error={error} reset={jest.fn()} />);
    rerender(<GlobalError error={error} reset={jest.fn()} />);
    rerender(<GlobalError error={error} reset={jest.fn()} />);

    expect(report).toHaveBeenCalledTimes(1);

    const newError = new Error('Database disconnected');
    rerender(<GlobalError error={newError} reset={jest.fn()} />);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('prevents duplicate reset dispatches for the same failure when retries race', async () => {
    const reset = jest.fn(() => new Promise<void>((resolve) => {
      // Keep the first transition alive just long enough to let a second click
      // arrive while the claim is held.
      setTimeout(resolve, 0);
    }));

    render(<GlobalError error={new Error('race')} reset={reset} />);
    const button = screen.getByRole('button', { name: /try again/i });

    await act(async () => {
      button.click();
      // A second click while the first transition is still in flight must not
      // start another reset.
      button.click();
      await Promise.resolve();
    });

    expect(reset).toHaveBeenCalledTimes(1);

    await act(async () => {
      // Let the pending transition settle so the affordance is re-armed.
      await Promise.resolve();
      await Promise.resolve();
    });

    // A later attempt on the same failure is still one retry, not a suppressed
    // action.
    await act(async () => {
      button.click();
    });
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('prevents concurrent execution of reset (single-flight claim under bursts)', async () => {
    // A never-settling reset keeps the transition pending, which is the window
    // a real double-click / Enter-then-click lands in.
    const reset = jest.fn(() => new Promise<void>(() => undefined));

    render(<GlobalError error={new Error('burst')} reset={reset} />);
    const button = screen.getByRole('button', { name: /try again/i });

    // Three activations in one batch, before the render that would disable the
    // button. Only the synchronous claim keeps two of them out.
    act(() => {
      button.click();
      button.click();
      button.click();
    });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('reports only once for duplicate concurrent mounts of the same failure identity', () => {
    const reporter = jest.fn();
    setErrorReporter(reporter);

    const error = Object.assign(new Error('serialized root crash'), {
      digest: 'd-1',
    });

    // In StrictMode the boundary can be mounted more than once under the same
    // failure; the identity-based guard must collapse that into one report.
    render(
      <React.StrictMode>
        <GlobalError error={error} reset={jest.fn()} />
      </React.StrictMode>,
    );

    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(
      error,
      'Global Error Boundary',
      undefined,
      undefined,
    );
  });
});
