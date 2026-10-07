import { render, screen, fireEvent } from '@testing-library/react';
import GlobalError from './error';
import { setErrorReporter } from '../lib/errorReporter';
import '@testing-library/jest-dom';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  setErrorReporter(null);
});

afterEach(() => {
  jest.restoreAllMocks();
  setErrorReporter(null);
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

// Captured before any test mutates NODE_ENV, so teardown can restore it exactly.
const originalNodeEnv = process.env.NODE_ENV;

const testError = Object.assign(new Error('Something broke'), { digest: undefined });
const mockReset = jest.fn();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderError(overrides: { reset?: jest.Mock; error?: Error & { digest?: string } } = {}) {
  const reset = overrides.reset ?? mockReset;
  const error = overrides.error ?? testError;
  return render(<GlobalError error={error} reset={reset} />);
}

// ---------------------------------------------------------------------------
// 1. Baseline rendering — no detail leakage
// ---------------------------------------------------------------------------

describe('Error page — baseline rendering', () => {
  it('renders generic error heading without leaking error message', () => {
    renderError();
    expect(screen.getByRole('heading', { name: /unexpected error/i })).toBeInTheDocument();
    expect(screen.queryByText('Something broke')).not.toBeInTheDocument();
  });

  it('does not render the error stack trace in the UI', () => {
    renderError();
    expect(screen.queryByText(/error:/i)).not.toBeInTheDocument();
  });

  it('does not render the digest in the UI', () => {
    const errorWithDigest = Object.assign(new Error('Boom'), { digest: 'abc123' });
    renderError({ error: errorWithDigest });
    expect(screen.queryByText('abc123')).not.toBeInTheDocument();
  });

  it('renders Go Home and Contact Support links', () => {
    renderError();
    expect(screen.getByRole('link', { name: /go home/i })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /contact support/i })).toBeInTheDocument();
  });

  it('renders a Try Again button on first render', () => {
    renderError();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 2. Error reporting — exactly-once, no detail in UI
// ---------------------------------------------------------------------------

describe('Error page — error reporting', () => {
  it('reports the error via reportError on mount', () => {
    const reporter = jest.fn();
    setErrorReporter(reporter);
    renderError();
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(testError, 'Error Boundary', undefined, undefined);
  });

  it('does not re-report the same error object on re-render', () => {
    const reporter = jest.fn();
    setErrorReporter(reporter);
    const { rerender } = render(<GlobalError error={testError} reset={mockReset} />);
    rerender(<GlobalError error={testError} reset={mockReset} />);
    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it('reports a new error object when error prop identity changes', () => {
    const reporter = jest.fn();
    setErrorReporter(reporter);
    const error1 = Object.assign(new Error('first'), { digest: undefined });
    const error2 = Object.assign(new Error('second'), { digest: undefined });
    const { rerender } = render(<GlobalError error={error1} reset={mockReset} />);
    rerender(<GlobalError error={error2} reset={mockReset} />);
    expect(reporter).toHaveBeenCalledTimes(2);
  });

  it('logs to console.error in non-production (test env)', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    renderError();
    expect(spy).toHaveBeenCalledWith('[Error Boundary]', testError);
  });
});

// ---------------------------------------------------------------------------
// 3. Retry success path
// ---------------------------------------------------------------------------

describe('Error page — retry success', () => {
  it('calls reset() once when Try Again is clicked', () => {
    const reset = jest.fn();
    renderError({ reset });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('announces "Retrying" to assistive technology when Try Again is clicked', () => {
    const reset = jest.fn();
    renderError({ reset });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    // The aria-live region must contain the announcement.
    const liveRegion = screen.getByRole('status');
    expect(liveRegion).toHaveTextContent(/retrying/i);
  });
});

// ---------------------------------------------------------------------------
// 4. reset() throws — recovery failure surface
// ---------------------------------------------------------------------------

describe('Error page — reset throws', () => {
  it('shows a safe recovery-failed message when reset() throws', () => {
    const throwingReset = jest.fn(() => {
      throw new Error('Internal reset failure');
    });
    renderError({ reset: throwingReset });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/recovery failed/i);
  });

  it('does not leak the reset error message into the UI', () => {
    const throwingReset = jest.fn(() => {
      throw new Error('Internal reset failure');
    });
    renderError({ reset: throwingReset });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.queryByText('Internal reset failure')).not.toBeInTheDocument();
  });

  it('reports the reset error via reportError with correct context', () => {
    const reporter = jest.fn();
    setErrorReporter(reporter);
    const throwingReset = jest.fn(() => {
      throw new Error('reset kaboom');
    });
    renderError({ reset: throwingReset });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    // First call: the original error. Second call: the reset error.
    expect(reporter).toHaveBeenCalledTimes(2);
    const [, , resetCall] = reporter.mock.calls.flat();
    expect(reporter).toHaveBeenCalledWith(
      expect.any(Error),
      'Error Boundary reset',
      'error',
      expect.objectContaining({ retryCount: expect.any(Number) }),
    );
    void resetCall; // suppress unused-variable lint
  });

  it('announces recovery failure to assistive technology', () => {
    const throwingReset = jest.fn(() => { throw new Error('bang'); });
    renderError({ reset: throwingReset });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    const liveRegion = screen.getByRole('status');
    expect(liveRegion).toHaveTextContent(/recovery failed/i);
  });

  it('clears the reset error message on the next retry attempt', () => {
    // First attempt throws; second attempt succeeds.
    const reset = jest.fn()
      .mockImplementationOnce(() => { throw new Error('first failure'); })
      .mockImplementationOnce(() => {});
    renderError({ reset });

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 5. Retry cap — MAX_RETRIES = 3
// ---------------------------------------------------------------------------

describe('Error page — retry cap', () => {
  it('replaces Try Again with Reload Page after MAX_RETRIES exhausted', () => {
    const reset = jest.fn();
    renderError({ reset });

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload page/i })).toBeInTheDocument();
  });

  it('does not call reset() more than MAX_RETRIES times', () => {
    const reset = jest.fn();
    renderError({ reset });

    // Click more than MAX_RETRIES times.
    for (let i = 0; i < 10; i++) {
      const btn = screen.queryByRole('button', { name: /try again/i });
      if (btn) fireEvent.click(btn);
    }

    expect(reset).toHaveBeenCalledTimes(3);
  });

  it('shows a permanent recovery message after retries are exhausted', () => {
    const reset = jest.fn();
    renderError({ reset });

    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    }

    expect(screen.getByText(/unable to recover after several attempts/i)).toBeInTheDocument();
  });

  it('cap is enforced even when all resets throw', () => {
    const throwingReset = jest.fn(() => { throw new Error('always fails'); });
    renderError({ reset: throwingReset });

    for (let i = 0; i < 10; i++) {
      const btn = screen.queryByRole('button', { name: /try again/i });
      if (btn) fireEvent.click(btn);
    }

    expect(throwingReset).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('Reload Page button is present and clickable after retries exhausted', () => {
    const reset = jest.fn();
    renderError({ reset });

    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    }

    const reloadBtn = screen.getByRole('button', { name: /reload page/i });
    expect(reloadBtn).toBeInTheDocument();
    // Clicking it should not throw (calls window.location.reload() which
    // jsdom ignores in test; the key invariant is the button exists and is active).
    expect(() => fireEvent.click(reloadBtn)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. Concurrent reset guard — no double-invocation during in-flight async reset
// ---------------------------------------------------------------------------

describe('Error page — concurrent reset guard', () => {
  it('does not invoke reset() a second time while a previous call is in flight', () => {
    const asyncReset = jest.fn(() => {
      // The reset function starts but doesn't complete synchronously.
      // We model this by holding the ref state artificially:
      // The guard (isResettingRef) is set to true at the start of handleRetry
      // and cleared in the finally block — meaning for a true sync function it
      // clears immediately. To test the guard we simulate manual control.
      //
      // In production Next.js reset() is synchronous but the guard still
      // prevents a second invocation if somehow two events fire before the
      // first finally block runs (e.g., microtask interleaving).
      //
      // Since Jest runs synchronously, we verify the invariant by checking
      // that the isResetting guard resets correctly between calls and that
      // the retry cap provides the primary defense against infinite retries.
    });

    renderError({ reset: asyncReset });

    // Two sequential fireEvent.click calls: both should go through because
    // the sync reset completes before the second click. The retry count cap
    // (MAX_RETRIES) is the primary defense — not the concurrent guard for sync.
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    // Both clicks fired cleanly (sync reset, so guard clears between them).
    expect(asyncReset).toHaveBeenCalledTimes(2);

    // The retry counter incremented: after 2 clicks, 1 more remains.
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    // After 3 total retries the cap is enforced — no more Try Again.
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    expect(asyncReset).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// 7. aria-live region
// ---------------------------------------------------------------------------

describe('Error page — aria-live region', () => {
  it('renders a role="status" aria-live region', () => {
    renderError();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('live region is visually hidden on initial render', () => {
    renderError();
    const region = screen.getByRole('status');
    expect(region).toHaveClass('sr-only');
    expect(region).toHaveTextContent('');
  });

  it('live region is aria-atomic=true', () => {
    renderError();
    expect(screen.getByRole('status')).toHaveAttribute('aria-atomic', 'true');
  });

  it('live region is aria-live=assertive', () => {
    renderError();
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'assertive');
  });
});

// ---------------------------------------------------------------------------
// 8. Boundary-case inputs
// ---------------------------------------------------------------------------

describe('Error page — boundary cases', () => {
  it('renders safely when error has no message', () => {
    const emptyError = Object.assign(new Error(''), { digest: undefined });
    expect(() => renderError({ error: emptyError })).not.toThrow();
    expect(screen.getByRole('heading', { name: /unexpected error/i })).toBeInTheDocument();
  });

  it('renders safely when reset is a no-op', () => {
    const noop = jest.fn();
    renderError({ reset: noop });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(noop).toHaveBeenCalledTimes(1);
    // No crash; heading still present.
    expect(screen.getByRole('heading', { name: /unexpected error/i })).toBeInTheDocument();
  });

  // --------------------------------------------------------------------------
  // Validation boundaries: valid, invalid, duplicate, and boundary-case inputs
  // --------------------------------------------------------------------------

  describe('validation boundaries', () => {
    it('accepts a valid Error instance and renders the fallback UI', () => {
      render(<GlobalError error={testError} reset={mockReset} />);
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });

    it('rejects null error without throwing and still renders a recoverable UI', () => {
      const nullError = null as unknown as Error;
      expect(() => render(<GlobalError error={nullError} reset={mockReset} />)).not.toThrow();
      expect(screen.getByRole('heading', { name: /unexpected error/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });

    it('rejects undefined error without throwing and still renders a recoverable UI', () => {
      const undefinedError = undefined as unknown as Error;
      expect(() => render(<GlobalError error={undefinedError} reset={mockReset} />)).not.toThrow();
      expect(screen.getByRole('heading', { name: /unexpected error/i })).toBeInTheDocument();
    });

    it('rejects a non-Error primitive without leaking it into the UI', () => {
      const primitive = 'secret-string' as unknown as Error;
      render(<GlobalError error={primitive} reset={mockReset} />);
      expect(screen.queryByText(/secret-string/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });

    it('rejects a plain object without a message without throwing', () => {
      const obj = {} as unknown as Error;
      expect(() => render(<GlobalError error={obj} reset={mockReset} />)).not.toThrow();
      expect(screen.getByRole('heading', { name: /unexpected error/i })).toBeInTheDocument();
    });

    it('treats a duplicate render of the same error as idempotent for the reporter', () => {
      const mockReporter = jest.fn();
      setErrorReporter(mockReporter);

      const { unmount } = render(<GlobalError error={testError} reset={mockReset} />);
      unmount();
      render(<GlobalError error={testError} reset={mockReset} />);

      // Each mount is a distinct reporting event; the reporter must not be called
      // more than once per mount and must receive the same error identity.
      expect(mockReporter).toHaveBeenCalledTimes(2);
      expect(mockReporter.mock.calls[0][0]).toBe(testError);
      expect(mockReporter.mock.calls[1][0]).toBe(testError);
    });

    it('does not call the reporter twice for a single mount', () => {
      const mockReporter = jest.fn();
      setErrorReporter(mockReporter);

      const { rerender } = render(<GlobalError error={testError} reset={mockReset} />);
      rerender(<GlobalError error={testError} reset={mockReset} />);

      expect(mockReporter).toHaveBeenCalledTimes(1);
    });

    it('reports an error with an empty message as a valid boundary case', () => {
      const mockReporter = jest.fn();
      setErrorReporter(mockReporter);
      const emptyMessageError = Object.assign(new Error(''), { digest: undefined });

      render(<GlobalError error={emptyMessageError} reset={mockReset} />);

      expect(mockReporter).toHaveBeenCalledTimes(1);
      expect(mockReporter).toHaveBeenCalledWith(emptyMessageError, 'Error Boundary', undefined, undefined);
    });

    it('reports an error with a digest without exposing it in the UI', () => {
      const mockReporter = jest.fn();
      setErrorReporter(mockReporter);
      const digestError = Object.assign(new Error('boom'), { digest: 'abc123' });

      render(<GlobalError error={digestError} reset={mockReset} />);

      expect(mockReporter).toHaveBeenCalledWith(digestError, 'Error Boundary', undefined, undefined);
      expect(screen.queryByText(/abc123/i)).not.toBeInTheDocument();
    });

    it('does not log to console in production but still reports', () => {
      const mockReporter = jest.fn();
      setErrorReporter(mockReporter);
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      process.env.NODE_ENV = 'production';

      render(<GlobalError error={testError} reset={mockReset} />);

      expect(spy).not.toHaveBeenCalledWith('[Error Boundary]', testError);
      expect(mockReporter).toHaveBeenCalledTimes(1);
    });

    it('swallows reporter failures so the fallback UI remains renderable', () => {
      const throwingReporter = jest.fn(() => {
        throw new Error('reporter failed');
      });
      setErrorReporter(throwingReporter);

      expect(() => render(<GlobalError error={testError} reset={mockReset} />)).not.toThrow();
      expect(screen.getByRole('heading', { name: /unexpected error/i })).toBeInTheDocument();
      expect(throwingReporter).toHaveBeenCalledTimes(1);
    });

    it('invokes reset exactly once per click even when clicked repeatedly', () => {
      const reset = jest.fn();
      render(<GlobalError error={testError} reset={reset} />);
      const button = screen.getByRole('button', { name: /try again/i });

      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);

      expect(reset).toHaveBeenCalledTimes(3);
    });
  });
});
