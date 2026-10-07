import { act, render, cleanup } from '@testing-library/react';
import ReputationLoadingClient from './ReputationLoadingClient';

// `__esModule` matters: without it the default import resolves to the module
// object itself, React rejects it as an element type, and the boundary correctly
// renders its error fallback instead of the loading state.
jest.mock('./loading', () => ({
  __esModule: true,
  default: () => <div data-testid="reputation-loading">loading</div>,
}));

describe('ReputationLoadingClient', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders the loading state inside a main landmark with aria-busy', () => {
    const { getByTestId, container } = render(<ReputationLoadingClient />);
    expect(getByTestId('reputation-loading')).toBeInTheDocument();
    const main = container.querySelector('main');
    expect(main).not.toBeNull();
    expect(main!.getAttribute('aria-busy')).toBe('true');
    expect(main!.getAttribute('tabindex')).toBe('-1');
  });

  it('focuses the main element after the scheduled delay', () => {
    const { container } = render(<ReputationLoadingClient />);
    const main = container.querySelector('main') as HTMLElement;
    const focusSpy = jest.spyOn(Object.getPrototypeOf(main), 'focus');

    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('does not focus when unmounted before the timer fires', () => {
    const { container, unmount } = render(<ReputationLoadingClient />);
    const main = container.querySelector('main') as HTMLElement;
    const focusSpy = jest.spyOn(Object.getPrototypeOf(main), 'focus');

    unmount();
    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('clears the pending timer on unmount to avoid leaks', () => {
    const clearSpy = jest.spyOn(globalThis, 'clearTimeout');
    const { unmount } = render(<ReputationLoadingClient />);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });

  it('focuses only once even if extra time passes', () => {
    const { container } = render(<ReputationLoadingClient />);
    const main = container.querySelector('main') as HTMLElement;
    const focusSpy = jest.spyOn(Object.getPrototypeOf(main), 'focus');

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(focusSpy).toHaveBeenCalledTimes(1);
  });
});
