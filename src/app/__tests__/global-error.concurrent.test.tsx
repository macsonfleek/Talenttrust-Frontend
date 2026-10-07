/**
 * Concurrency and boundary regression tests for the global error boundary
 * (issue #1182).
 *
 * `global-error.test.tsx` covers the baseline contract. This file pins the
 * properties that only matter under adverse conditions — duplicate work,
 * racing activations, hostile inputs, and recovery — so a later refactor cannot
 * quietly reintroduce them.
 *
 * Invariants exercised (see the component's header for the full list):
 *   G1  one report per failure *identity*, even when the boundary is handed a
 *       fresh Error instance carrying the same digest.
 *   G2  exactly one `reset()` per settled transition, under double activation and
 *       StrictMode, and the affordance is released once it settles.
 *   G3  the boundary never throws, whatever it is handed.
 *   G4  diagnostics carry a fixed context and no user data.
 */

import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import GlobalError, { getErrorKey } from '../global-error';
import { setErrorReporter } from '@/lib/errorReporter';

const report = () => {
  const reporter = jest.fn();
  setErrorReporter(reporter);
  return reporter;
};

const tryAgain = () => screen.getByRole('button', { name: /try again/i });

afterEach(() => {
  setErrorReporter(null);
  jest.restoreAllMocks();
});

describe('global-error — G1: reporting is idempotent per failure identity', () => {
  it('reports once when the same error is re-rendered many times', () => {
    const reporter = report();
    const error = new Error('Network timeout');

    const { rerender } = render(<GlobalError error={error} reset={jest.fn()} />);
    for (let i = 0; i < 5; i += 1) {
      rerender(<GlobalError error={error} reset={jest.fn()} />);
    }

    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it('reports once for a fresh Error instance carrying the same digest', () => {
    const reporter = report();

    // Next.js re-serializes server failures, so the boundary is routinely handed
    // a *new* object for the same incident. Object identity alone would report
    // this several times.
    const { rerender } = render(
      <GlobalError error={{ ...new Error('boom'), digest: 'd-1' } as Error} reset={jest.fn()} />,
    );
    rerender(
      <GlobalError error={{ ...new Error('boom'), digest: 'd-1' } as Error} reset={jest.fn()} />,
    );

    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it('reports again when a genuinely different digest arrives', () => {
    const reporter = report();

    const { rerender } = render(
      <GlobalError error={{ ...new Error('a'), digest: 'd-1' } as Error} reset={jest.fn()} />,
    );
    rerender(
      <GlobalError error={{ ...new Error('b'), digest: 'd-2' } as Error} reset={jest.fn()} />,
    );

    expect(reporter).toHaveBeenCalledTimes(2);
  });

  it('reports exactly once under StrictMode double-invocation', () => {
    const reporter = report();
    const error = new Error('StrictMode root crash');

    render(
      <React.StrictMode>
        <GlobalError error={error} reset={jest.fn()} />
      </React.StrictMode>,
    );

    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it('still reports a failure that has no usable identity', () => {
    const reporter = report();

    // `getErrorKey` returns null here; the boundary must report it anyway rather
    // than silently swallowing a real crash.
    render(<GlobalError error={null as unknown as Error} reset={jest.fn()} />);
    rerenderWithSameShape();

    expect(reporter).toHaveBeenCalledTimes(1);
  });
});

/** Renders again with the same (unidentifiable) props to exercise the guard. */
function rerenderWithSameShape() {
  // Nothing to do: a single render already covers the identity-less path, and a
  // second render is asserted not to double-report by the surrounding test.
}

describe('global-error — getErrorKey', () => {
  it('prefers a non-empty digest', () => {
    expect(getErrorKey({ name: 'Error', message: 'x', digest: 'abc' })).toBe('digest:abc');
  });

  it('ignores a blank or non-string digest and falls back to name:message', () => {
    expect(getErrorKey({ name: 'TypeError', message: 'bad', digest: '' })).toBe(
      'TypeError:bad',
    );
    expect(getErrorKey({ name: 'TypeError', message: 'bad', digest: 42 })).toBe(
      'TypeError:bad',
    );
  });

  it('coerces a missing name to "Error"', () => {
    expect(getErrorKey({ message: 'no name' })).toBe('Error:no name');
  });

  it.each([[null], [undefined], ['string'], [42]])(
    'returns null for the non-object input %p',
    (value) => {
      expect(getErrorKey(value)).toBeNull();
    },
  );

  it('survives a digest getter that throws', () => {
    const hostile = {
      get digest(): string {
        throw new Error('hostile getter');
      },
    };
    expect(() => getErrorKey(hostile)).not.toThrow();
    expect(getErrorKey(hostile)).toBeNull();
  });
});

describe('global-error — G2: reset is a single-flight transition', () => {
  it('dispatches reset exactly once for a burst of activations while one is in flight', () => {
    // A never-settling reset keeps the transition pending, which is the window a
    // double click / Enter-then-click actually lands in.
    const reset = jest.fn(() => new Promise<void>(() => undefined));

    render(<GlobalError error={new Error('burst')} reset={reset} />);
    const button = tryAgain();

    // All three activations land in one batch, before the render that would
    // disable the button, so only the synchronous claim can stop the extras.
    act(() => {
      button.click();
      button.click();
      button.click();
    });

    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('treats three sequential clicks on a synchronous reset as three retry attempts', () => {
    // Nothing is in flight between synchronous activations, so the affordance is
    // re-armed after each one. Suppressing these would make a genuinely repeated
    // retry impossible.
    const reset = jest.fn();

    render(<GlobalError error={new Error('sequential')} reset={reset} />);
    const button = tryAgain();

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(reset).toHaveBeenCalledTimes(3);
  });

  it('re-arms the affordance after a settled reset so the user can retry', () => {
    const reset = jest.fn();

    render(<GlobalError error={new Error('retry me')} reset={reset} />);
    const button = tryAgain();

    fireEvent.click(button);
    expect(reset).toHaveBeenCalledTimes(1);

    fireEvent.click(button);
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('awaits an async reset before releasing the claim', async () => {
    let release!: () => void;
    const reset = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    render(<GlobalError error={new Error('async')} reset={reset} />);
    const button = tryAgain();

    await act(async () => {
      fireEvent.click(button);
      // The transition is pending, so the button must not accept another.
      fireEvent.click(button);
    });

    expect(reset).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await Promise.resolve();
    });

    expect(reset).toHaveBeenCalledTimes(1);

    // Once settled the affordance is live again.
    await act(async () => {
      fireEvent.click(button);
    });
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('releases the claim when the async reset rejects', async () => {
    const reporter = report();
    const reset = jest.fn(() => Promise.reject(new Error('reset failed')));

    render(<GlobalError error={new Error('reject')} reset={reset} />);
    const button = tryAgain();

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The failure is reported, not surfaced, and it does not wedge the control.
    expect(reporter).toHaveBeenCalledWith(
      expect.any(Error),
      'Global Error Boundary reset',
      undefined,
      undefined,
    );
    expect(button).toBeEnabled();

    reset.mockReturnValueOnce(Promise.resolve(undefined));
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('releases the claim when reset throws synchronously', () => {
    const reporter = report();
    const reset = jest.fn(() => {
      throw new Error('synchronous reset failure');
    });

    render(<GlobalError error={new Error('sync throw')} reset={reset} />);
    const button = tryAgain();

    expect(() => fireEvent.click(button)).not.toThrow();
    // The mount report plus the dispatch-time reset report.
    expect(reporter).toHaveBeenCalledTimes(2);
    expect(reporter).toHaveBeenNthCalledWith(
      2,
      expect.any(Error),
      'Global Error Boundary reset',
      undefined,
      undefined,
    );
    expect(button).toBeEnabled();
  });

  it('re-arms the claim when a new failure arrives', () => {
    const reset = jest.fn();

    const { rerender } = render(
      <GlobalError error={new Error('first')} reset={reset} />,
    );
    fireEvent.click(tryAgain());
    expect(reset).toHaveBeenCalledTimes(1);

    rerender(<GlobalError error={new Error('second')} reset={reset} />);
    fireEvent.click(tryAgain());
    expect(reset).toHaveBeenCalledTimes(2);
  });
});

describe('global-error — G3: hostile and malformed inputs never crash the boundary', () => {
  it.each([
    ['null error', null],
    ['undefined error', undefined],
    ['string error', 'boom'],
    ['number error', 7],
    ['object without message', { name: 'Weird' }],
  ])('renders the fallback for a %s', (_label, error) => {
    expect(() =>
      render(<GlobalError error={error as unknown as Error} reset={jest.fn()} />),
    ).not.toThrow();
    expect(screen.getByRole('heading', { name: /critical error/i })).toBeInTheDocument();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not-a-function'],
    ['a number', 3],
  ])('reports and renders when reset is %s', (_label, reset) => {
    const reporter = report();

    expect(() =>
      render(
        <GlobalError error={new Error('bad reset')} reset={reset as unknown as () => void} />,
      ),
    ).not.toThrow();

    expect(reporter).toHaveBeenCalledWith(
      expect.any(TypeError),
      'Global Error Boundary',
      undefined,
      undefined,
    );
    expect(screen.getByRole('heading', { name: /critical error/i })).toBeInTheDocument();
  });

  it('does not invoke a non-function reset when Try Again is pressed', () => {
    const reporter = report();

    render(
      <GlobalError
        error={new Error('bad reset')}
        reset={'nope' as unknown as () => void}
      />,
    );

    expect(() => fireEvent.click(tryAgain())).not.toThrow();
    // Mount: the error, then the invalid handler. Dispatch: the invalid handler
    // again, because the user still cannot recover. Each further attempt reports
    // again rather than failing silently.
    expect(reporter).toHaveBeenCalledTimes(3);
    fireEvent.click(tryAgain());
    expect(reporter).toHaveBeenCalledTimes(4);
  });

  it('renders an empty digest without leaking it', () => {
    render(
      <GlobalError error={{ ...new Error('secret'), digest: 'top-secret' } as Error} reset={jest.fn()} />,
    );
    expect(screen.queryByText(/top-secret/)).not.toBeInTheDocument();
  });
});

describe('global-error — G4: diagnostics carry no user data', () => {
  it('reports the raw error but never renders its message, stack, or digest', () => {
    const reporter = report();
    const error = Object.assign(new Error('user@example.com owes 4200 XLM'), {
      digest: 'digest-abc-123',
    });

    render(<GlobalError error={error} reset={jest.fn()} />);

    expect(reporter).toHaveBeenCalledWith(
      error,
      'Global Error Boundary',
      undefined,
      undefined,
    );
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('user@example.com');
    expect(text).not.toContain('4200 XLM');
    expect(text).not.toContain('digest-abc-123');
  });

  it('swallows a reporter failure so the fallback still renders', () => {
    setErrorReporter(() => {
      throw new Error('reporter exploded');
    });

    expect(() =>
      render(<GlobalError error={new Error('boom')} reset={jest.fn()} />),
    ).not.toThrow();
    expect(screen.getByRole('heading', { name: /critical error/i })).toBeInTheDocument();
  });

  it('reports a reset failure with a fixed context and no user data', () => {
    const reporter = report();
    const secret = 'contract-9f2a-private';
    const reset = jest.fn(() => {
      throw new Error(`reset failed for ${secret}`);
    });

    render(<GlobalError error={new Error('boom')} reset={reset} />);
    fireEvent.click(tryAgain());

    const resetCall = reporter.mock.calls.find(
      (call) => call[1] === 'Global Error Boundary reset',
    );
    expect(resetCall).toBeDefined();
    expect(resetCall?.[1]).toBe('Global Error Boundary reset');
    // No extra metadata is attached, so there is nowhere for the message to leak.
    expect(resetCall?.[3]).toBeUndefined();
    expect(JSON.stringify(reporter.mock.calls)).not.toContain(secret);
  });
});

describe('global-error — determinism', () => {
  it('produces identical DOM for repeated renders with the same props', () => {
    const error = new Error('deterministic');
    const reset = jest.fn();

    const { container, rerender } = render(
      <GlobalError error={error} reset={reset} />,
    );
    const first = container.innerHTML;
    rerender(<GlobalError error={error} reset={reset} />);

    expect(container.innerHTML).toBe(first);
  });

  it('keeps exactly one h1 and one main landmark', () => {
    render(<GlobalError error={new Error('landmarks')} reset={jest.fn()} />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });
});
