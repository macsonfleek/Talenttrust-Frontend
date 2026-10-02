import { render, screen } from '@testing-library/react';

import ContractsLoading, {
  MAX_SKELETON_COUNT,
  MIN_SKELETON_COUNT,
  normalizeSkeletonCount,
} from './loading';
import { CONTRACTS_LOADING_SKELETON_ROWS } from './ContractsLoadingBoundary';

/**
 * `normalizeSkeletonCount` is total and deterministic: every input maps to a
 * bounded integer, so repeated or concurrent calls can never disagree and the
 * rendered row count can never vary for the same request.
 */
describe('normalizeSkeletonCount', () => {
  it('returns the module default when no candidate is provided', () => {
    expect(normalizeSkeletonCount()).toBe(
      normalizeSkeletonCount(undefined),
    );
    expect(normalizeSkeletonCount(undefined)).toBeGreaterThanOrEqual(
      MIN_SKELETON_COUNT,
    );
  });

  it('accepts valid integer values within range', () => {
    expect(normalizeSkeletonCount(MIN_SKELETON_COUNT)).toBe(MIN_SKELETON_COUNT);
    expect(normalizeSkeletonCount(3)).toBe(3);
    expect(normalizeSkeletonCount(MAX_SKELETON_COUNT)).toBe(MAX_SKELETON_COUNT);
  });

  it('truncates fractional values towards zero', () => {
    expect(normalizeSkeletonCount(3.9)).toBe(3);
    expect(normalizeSkeletonCount(2.99)).toBe(2);
  });

  it('clamps out-of-range values to the documented bounds', () => {
    expect(normalizeSkeletonCount(-1)).toBe(MIN_SKELETON_COUNT);
    expect(normalizeSkeletonCount(10_000)).toBe(MAX_SKELETON_COUNT);
  });

  it('falls back to the same default for non-finite and non-numeric values', () => {
    const fallback = normalizeSkeletonCount(undefined);
    expect(normalizeSkeletonCount(Number.NaN)).toBe(fallback);
    expect(normalizeSkeletonCount(Number.POSITIVE_INFINITY)).toBe(fallback);
    expect(normalizeSkeletonCount(Number.NEGATIVE_INFINITY)).toBe(fallback);
    expect(normalizeSkeletonCount('abc' as unknown as number)).toBe(fallback);
    expect(normalizeSkeletonCount(null as unknown as number)).toBe(fallback);
  });

  it('is idempotent for duplicate invocations', () => {
    for (const value of [1, 2, 3, 5, 10]) {
      expect(normalizeSkeletonCount(value)).toBe(value);
      expect(normalizeSkeletonCount(value)).toBe(value);
    }
  });

  it('always returns an integer inside the bounds, for any input', () => {
    const hostile: unknown[] = [
      undefined, null, '', 'x', Number.NaN, Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY, -0.5, 0.5, 1e9, [], {},
    ];
    for (const value of hostile) {
      const result = normalizeSkeletonCount(value as number);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(MIN_SKELETON_COUNT);
      expect(result).toBeLessThanOrEqual(MAX_SKELETON_COUNT);
    }
  });
});

/**
 * Public entry-point contract: zero arguments, a fixed row count, and no second
 * `<main>` landmark (the root layout already owns one).
 */
describe('ContractsLoading', () => {
  it('renders the documented skeleton row count', () => {
    const { container } = render(<ContractsLoading />);

    const list = container.querySelector('ul[aria-label="Loading contract list"]');
    expect(list!.querySelectorAll('li')).toHaveLength(CONTRACTS_LOADING_SKELETON_ROWS);
  });

  it('announces loading state to assistive technology and marks the region busy', () => {
    const { container } = render(<ContractsLoading />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading contracts');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('is idempotent across repeated renders', () => {
    const first = render(<ContractsLoading />).container.innerHTML;
    const second = render(<ContractsLoading />).container.innerHTML;

    expect(second).toBe(first);
  });
});
