'use client';

import React, { Component, type ReactNode } from 'react';
import Link from 'next/link';
import { reportError } from '@/lib/errorReporter';
import ReputationLoading from './loading';

// ---------------------------------------------------------------------------
// Error Codes & Constants
// ---------------------------------------------------------------------------

/** Public error code for render errors caught during reputation loading. */
export const REPUTATION_LOADING_ERROR_CODE = 'REPUTATION_LOADING_FAILED' as const;

/** Public error code when loading exceeds the configured timeout threshold. */
export const REPUTATION_LOADING_TIMEOUT_CODE = 'REPUTATION_LOADING_TIMEOUT' as const;

/** Public error code when a retry operation fails. */
export const REPUTATION_LOADING_RETRY_FAILED_CODE = 'REPUTATION_LOADING_RETRY_FAILED' as const;

/** Public error code when a custom fallback render prop throws. */
export const REPUTATION_LOADING_FALLBACK_FAILED_CODE = 'REPUTATION_LOADING_FALLBACK_FAILED' as const;

/** Default maximum number of retry attempts before entering the exhausted state. */
export const DEFAULT_MAX_RETRIES = 3;

/** Valid state machine statuses for ReputationLoadingClient. */
export type ReputationLoadingStatus = 'loading' | 'error' | 'recovering' | 'exhausted';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReputationLoadingFallbackProps {
  /** Normalized error object, or null. */
  error: Error | null;
  /** Function to trigger a retry. */
  retry: () => void;
  /** Number of retry attempts completed so far. */
  retryCount: number;
  /** Whether the retry limit has been exhausted. */
  isExhausted: boolean;
  /** Whether an asynchronous retry is currently in flight. */
  isRetrying: boolean;
}

export interface ReputationLoadingClientProps {
  /**
   * Optional custom child content to render while in the loading state.
   * Defaults to `<ReputationLoading />`.
   */
  children?: ReactNode;
  /**
   * Optional custom fallback UI. When supplied as a function, receives
   * {@link ReputationLoadingFallbackProps}. When supplied as a ReactNode, replaces
   * the built-in fallback directly.
   */
  fallback?: ReactNode | ((props: ReputationLoadingFallbackProps) => ReactNode);
  /**
   * Accessible heading title displayed in the built-in fallback alert.
   * Defaults to "Unable to load reputation".
   */
  fallbackTitle?: string;
  /**
   * Callback fired whenever an error is encountered (render catch, timeout, or retry error).
   */
  onError?: (error: Error, errorInfo?: React.ErrorInfo) => void;
  /**
   * Callback fired when a retry is initiated. Can be synchronous or return a Promise.
   * While the promise is pending, the component enters the 'recovering' state.
   */
  onRetry?: () => void | Promise<void>;
  /**
   * Callback fired when a retry operation successfully resolves and content is restored.
   */
  onRecover?: () => void;
  /**
   * Maximum allowed retry attempts before entering the exhausted state.
   * Defaults to 3. Must be a non-negative integer.
   */
  maxRetries?: number;
  /**
   * Optional timeout in milliseconds. If loading does not settle within this window,
   * the component transitions deterministically to an error state.
   */
  timeoutMs?: number | null;
  /**
   * Initial error to simulate or propagate an error immediately on mount.
   */
  initialError?: Error | string | null;
  /**
   * Class name for the root `<main>` element.
   * Defaults to "min-h-screen p-8".
   */
  className?: string;
  /**
   * Optional data-testid for the root element.
   */
  'data-testid'?: string;
}

export interface ReputationLoadingClientState {
  status: ReputationLoadingStatus;
  error: Error | null;
  retryCount: number;
  retryKey: number;
  isRetrying: boolean;
}

// ---------------------------------------------------------------------------
// Input Normalization Helpers
// ---------------------------------------------------------------------------

/**
 * Normalizes any caught or passed value into an Error instance.
 * Ensures non-Error throws (strings, objects, null, undefined) produce a safe Error.
 */
export function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === 'string') {
    return new Error(error);
  }
  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string') {
      return new Error(maybeMessage);
    }
    try {
      return new Error(JSON.stringify(error));
    } catch {
      return new Error('Unknown error object');
    }
  }
  return new Error(String(error ?? 'Unknown error occurred'));
}

/**
 * Normalizes maxRetries to a non-negative integer.
 * Falls back to DEFAULT_MAX_RETRIES for invalid inputs (negative, NaN, non-finite).
 */
export function normalizeMaxRetries(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return DEFAULT_MAX_RETRIES;
}

/**
 * Normalizes timeoutMs to a positive number, or null if disabled/invalid.
 */
export function normalizeTimeoutMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Client wrapper for the reputation loading state that manages focus and deterministic
 * failure recovery.
 *
 * State Model:
 *   - 'loading'    : Initial active skeleton state. Timer schedules focus to `<main>`,
 *                    `aria-busy="true"`.
 *   - 'error'      : An error occurred (render throw, timeout, or retry rejection).
 *                    Renders accessible alert with Retry action, `aria-busy="false"`,
 *                    moves focus to the retry button.
 *   - 'recovering' : A retry action is currently executing. Concurrent clicks are ignored.
 *                    `aria-busy="true"`.
 *   - 'exhausted'  : Maximum retry attempts reached. Retry button is disabled/hidden,
 *                    guidance to return home is provided.
 *
 * Invariants:
 *   1. Deterministic transitions: 'recovering' can only transition to 'loading' (success)
 *      or 'error'/'exhausted' (failure).
 *   2. No silent data loss: Errors are routed to central error reporting without leaking
 *      credentials, memory contents, or internal stack traces to the DOM.
 *   3. Concurrency protection: `isRetrying` guards against duplicate/rapid invocations.
 *   4. Subtree reset: Fresh `retryKey` remounts the child subtree cleanly on recovery.
 *   5. Timer safety: All focus and timeout timers are cancelled on state transitions and unmount.
 */
export default class ReputationLoadingClient extends Component<
  ReputationLoadingClientProps,
  ReputationLoadingClientState
> {
  private mainRef = React.createRef<HTMLElement>();
  private retryButtonRef = React.createRef<HTMLButtonElement>();
  private alertRef = React.createRef<HTMLDivElement>();
  private previousFocus: HTMLElement | null = null;
  private focusTimer: ReturnType<typeof setTimeout> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private isMountedFlag = false;
  private isRetryingLock = false;

  constructor(props: ReputationLoadingClientProps) {
    super(props);

    const initialErr = props.initialError != null ? normalizeError(props.initialError) : null;
    const maxRetries = normalizeMaxRetries(props.maxRetries);
    const isExhausted = initialErr !== null && maxRetries === 0;

    this.state = {
      status: initialErr !== null ? (isExhausted ? 'exhausted' : 'error') : 'loading',
      error: initialErr,
      retryCount: 0,
      retryKey: 0,
      isRetrying: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle & Error Boundaries
  // ---------------------------------------------------------------------------

  static getDerivedStateFromError(error: unknown): Partial<ReputationLoadingClientState> {
    return {
      status: 'error',
      error: normalizeError(error),
      isRetrying: false,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    const normalized = normalizeError(error);
    const maxRetries = normalizeMaxRetries(this.props.maxRetries);
    const isExhausted = this.state.retryCount >= maxRetries;

    if (isExhausted && this.state.status !== 'exhausted') {
      this.setState({ status: 'exhausted' });
    }

    reportError(normalized, 'ReputationLoadingClient', 'error', {
      code: REPUTATION_LOADING_ERROR_CODE,
      retryCount: this.state.retryCount,
      maxRetries,
      componentStack: errorInfo.componentStack ?? undefined,
    });

    try {
      this.props.onError?.(normalized, errorInfo);
    } catch {
      // Invariant: errors in onError callback must not break the error boundary
    }

    this.clearFocusTimer();
    this.clearTimeoutTimer();
    this.focusAlertOrRetry();
  }

  componentDidMount(): void {
    this.isMountedFlag = true;

    // Store the previously focused element when the page mounts
    this.previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (this.state.status === 'loading') {
      this.scheduleMountFocus();
      this.startTimeoutTimer();
    } else {
      this.focusAlertOrRetry();
    }
  }

  componentDidUpdate(prevProps: ReputationLoadingClientProps): void {
    // If initialError prop changes after mount, handle it deterministically
    if (this.props.initialError !== prevProps.initialError && this.props.initialError != null) {
      const normalized = normalizeError(this.props.initialError);
      const maxRetries = normalizeMaxRetries(this.props.maxRetries);
      const isExhausted = this.state.retryCount >= maxRetries;

      this.clearFocusTimer();
      this.clearTimeoutTimer();

      this.setState(
        {
          status: isExhausted ? 'exhausted' : 'error',
          error: normalized,
          isRetrying: false,
        },
        () => {
          this.focusAlertOrRetry();
        }
      );
    }
  }

  componentWillUnmount(): void {
    this.isMountedFlag = false;
    this.clearFocusTimer();
    this.clearTimeoutTimer();
  }

  // ---------------------------------------------------------------------------
  // Timer & Focus Management
  // ---------------------------------------------------------------------------

  private clearFocusTimer(): void {
    if (this.focusTimer !== null) {
      clearTimeout(this.focusTimer);
      this.focusTimer = null;
    }
  }

  private clearTimeoutTimer(): void {
    if (this.timeoutTimer !== null) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private scheduleMountFocus(): void {
    this.clearFocusTimer();
    this.focusTimer = setTimeout(() => {
      // Compatibility: querySelector('main') is queried first to preserve
      // existing accessibility and unit test contracts
      const main = document.querySelector('main') || this.mainRef.current;
      if (main) {
        main.focus();
      }
    }, 100);
  }

  private focusAlertOrRetry(): void {
    this.clearFocusTimer();
    this.focusTimer = setTimeout(() => {
      const maxRetries = normalizeMaxRetries(this.props.maxRetries);
      const isExhausted =
        this.state.status === 'exhausted' || this.state.retryCount >= maxRetries;

      if (!isExhausted && this.retryButtonRef.current) {
        this.retryButtonRef.current.focus();
      } else if (this.alertRef.current) {
        this.alertRef.current.focus();
      }
    }, 50);
  }

  private startTimeoutTimer(): void {
    this.clearTimeoutTimer();
    const timeout = normalizeTimeoutMs(this.props.timeoutMs);
    if (timeout !== null && this.state.status === 'loading') {
      this.timeoutTimer = setTimeout(() => {
        this.handleTimeout();
      }, timeout);
    }
  }

  private handleTimeout(): void {
    if (!this.isMountedFlag || this.state.status !== 'loading') {
      return;
    }

    const timeoutErr = new Error('Reputation loading timed out');
    const maxRetries = normalizeMaxRetries(this.props.maxRetries);
    const isExhausted = this.state.retryCount >= maxRetries;

    reportError(timeoutErr, 'ReputationLoadingClient', 'warn', {
      code: REPUTATION_LOADING_TIMEOUT_CODE,
      timeoutMs: this.props.timeoutMs,
      retryCount: this.state.retryCount,
      maxRetries,
    });

    try {
      this.props.onError?.(timeoutErr);
    } catch {
      // Invariant: callback errors must not block error state transition
    }

    this.clearFocusTimer();
    this.setState(
      {
        status: isExhausted ? 'exhausted' : 'error',
        error: timeoutErr,
        isRetrying: false,
      },
      () => {
        this.focusAlertOrRetry();
      }
    );
  }

  // ---------------------------------------------------------------------------
  // Retry & Recovery Handler
  // ---------------------------------------------------------------------------

  handleRetry = (): void => {
    const maxRetries = normalizeMaxRetries(this.props.maxRetries);
    if (
      !this.isMountedFlag ||
      this.isRetryingLock ||
      this.state.isRetrying ||
      this.state.status === 'exhausted' ||
      this.state.retryCount >= maxRetries
    ) {
      return;
    }

    this.isRetryingLock = true;
    this.clearFocusTimer();
    this.clearTimeoutTimer();

    this.setState({ status: 'recovering', isRetrying: true });

    const execute = async () => {
      try {
        if (typeof this.props.onRetry === 'function') {
          await this.props.onRetry();
        }

        if (!this.isMountedFlag) {
          this.isRetryingLock = false;
          return;
        }

        const nextRetryCount = this.state.retryCount + 1;
        this.isRetryingLock = false;
        this.setState(
          (prev) => ({
            status: 'loading',
            error: null,
            retryCount: nextRetryCount,
            retryKey: prev.retryKey + 1,
            isRetrying: false,
          }),
          () => {
            try {
              this.props.onRecover?.();
            } catch {
              // Invariant: callback errors must not corrupt recovery state
            }
            this.startTimeoutTimer();
            this.scheduleMountFocus();
          }
        );
      } catch (err) {
        this.isRetryingLock = false;
        if (!this.isMountedFlag) return;

        const normalized = normalizeError(err);
        const nextRetryCount = this.state.retryCount + 1;
        const isExhausted = nextRetryCount >= maxRetries;

        reportError(normalized, 'ReputationLoadingClient', 'error', {
          code: REPUTATION_LOADING_RETRY_FAILED_CODE,
          retryCount: nextRetryCount,
          maxRetries,
        });

        try {
          this.props.onError?.(normalized);
        } catch {
          // protect boundary
        }

        this.setState(
          {
            status: isExhausted ? 'exhausted' : 'error',
            error: normalized,
            retryCount: nextRetryCount,
            isRetrying: false,
          },
          () => {
            this.focusAlertOrRetry();
          }
        );
      }
    };

    void execute();
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  private renderFallback(): ReactNode {
    const { fallback, fallbackTitle } = this.props;
    const { error, retryCount, status } = this.state;
    const maxRetries = normalizeMaxRetries(this.props.maxRetries);
    const isExhausted = status === 'exhausted' || retryCount >= maxRetries;
    const isRetrying = this.state.isRetrying || this.isRetryingLock || status === 'recovering';

    if (fallback !== undefined) {
      if (typeof fallback === 'function') {
        try {
          return fallback({
            error,
            retry: this.handleRetry,
            retryCount,
            isExhausted,
            isRetrying,
          });
        } catch (fallbackError) {
          reportError(fallbackError, 'ReputationLoadingClient', 'error', {
            code: REPUTATION_LOADING_FALLBACK_FAILED_CODE,
          });
          // Gracefully fall through to built-in fallback
        }
      } else {
        return fallback;
      }
    }

    const title =
      typeof fallbackTitle === 'string' && fallbackTitle.trim().length > 0
        ? fallbackTitle.trim()
        : 'Unable to load reputation';

    const description = isExhausted
      ? 'Unable to load reputation after multiple attempts. Please return home or contact support if the problem persists.'
      : 'A problem occurred while loading reputation data. You can try again.';

    return (
      <div
        ref={this.alertRef}
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        tabIndex={-1}
        className="mx-auto my-8 max-w-lg rounded-3xl border border-red-200 bg-red-50 p-6 text-center shadow-sm sm:p-8"
      >
        <h2 className="text-xl font-bold text-red-900">{title}</h2>
        <p className="mt-2 text-sm text-red-700">{description}</p>
        <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
          {!isExhausted && (
            <button
              ref={this.retryButtonRef}
              type="button"
              onClick={this.handleRetry}
              disabled={isRetrying}
              className="rounded-xl bg-red-700 px-4 py-2 font-semibold text-white transition hover:bg-red-800 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRetrying ? 'Retrying…' : 'Try again'}
            </button>
          )}
          <Link
            href="/"
            className="rounded-xl border border-red-300 px-4 py-2 font-semibold text-red-700 transition hover:bg-red-100 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-red-600"
          >
            Go Home
          </Link>
        </div>
      </div>
    );
  }

  render(): ReactNode {
    const { status, retryKey } = this.state;
    const maxRetries = normalizeMaxRetries(this.props.maxRetries);
    const isExhausted = status === 'exhausted' || this.state.retryCount >= maxRetries;
    const isRecovering = status === 'recovering';
    const hasError = status === 'error' || isExhausted;
    const shouldShowFallback = hasError || isRecovering;
    const isBusy = status === 'loading' || isRecovering;

    const childContent =
      this.props.children !== undefined ? (
        this.props.children
      ) : (
        <ReputationLoading />
      );

    return (
      <main
        ref={this.mainRef}
        className={this.props.className ?? 'min-h-screen p-8'}
        tabIndex={-1}
        aria-busy={isBusy ? 'true' : 'false'}
        data-testid={this.props['data-testid']}
      >
        {shouldShowFallback ? (
          this.renderFallback()
        ) : (
          <React.Fragment key={retryKey}>{childContent}</React.Fragment>
        )}
      </main>
    );
  }
}
