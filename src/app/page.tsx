'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { ToastDemo } from '@/components/toast/toast-demo';
import { FormField } from '@/components/FormField';
import { ErrorSummary } from '@/components/ErrorSummary';
import { useToast } from '@/components/toast/toast-provider';
import { useFormAnnouncer } from '@/hooks/useFormAnnouncer';
import { reportError } from '@/lib/errorReporter';
import {
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
  validateLogin,
} from '@/lib/validateLogin';
import {
  getRemainingCooldownMs,
  recordAttempt,
  resetThrottle,
} from '@/lib/loginThrottle';

/**
 * How often the cooldown countdown re-reads the authoritative deadline.
 * Small enough that the visible `Wait Ns` label never drifts more than a
 * quarter second behind the real lockout.
 */
const COUNTDOWN_TICK_MS = 250;

export default function Home() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ fieldId: string; message: string }[]>([]);
  const [cooldownRemainingMs, setCooldownRemainingMs] = useState(0);
  const cooldownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Monotonic token identifying the *current* countdown.
   *
   * Every start/stop bumps it. A `tick` closure captures the token it was
   * created with and returns immediately if the token no longer matches, so a
   * timer that is already queued in the task queue can never resurrect a
   * cancelled countdown (the same hazard the wallet context guards against by
   * nulling `timerRef` before clearing it).
   */
  const countdownGenerationRef = useRef(0);

  /**
   * Re-entrancy lock for {@link handleSubmit}.
   *
   * Held only for the duration of the synchronous handler (released in a
   * `finally`), so it can never wedge the form. It exists so that a duplicate
   * or re-entrant dispatch — a double-fired submit, or a callback triggered
   * from within the handler itself — cannot run validation and emit a second
   * toast/announcement for one user action.
   */
  const submitInFlightRef = useRef(false);

  const { showSuccess } = useToast();
  const { politeMessage, assertiveMessage, announce } = useFormAnnouncer();

  const clearCooldownInterval = useCallback(() => {
    // Invalidate in-flight ticks *before* clearing the handle, so a tick that
    // is already queued observes a stale generation and bails out.
    countdownGenerationRef.current += 1;
    if (cooldownIntervalRef.current !== null) {
      clearInterval(cooldownIntervalRef.current);
      cooldownIntervalRef.current = null;
    }
  }, []);

  const startCooldownCountdown = useCallback(() => {
    clearCooldownInterval();
    const generation = countdownGenerationRef.current;
    const tick = () => {
      if (countdownGenerationRef.current !== generation) return;
      const remaining = getRemainingCooldownMs();
      if (remaining <= 0) {
        setCooldownRemainingMs(0);
        clearCooldownInterval();
        return;
      }
      setCooldownRemainingMs(remaining);
    };
    tick();
    cooldownIntervalRef.current = setInterval(tick, COUNTDOWN_TICK_MS);
  }, [clearCooldownInterval]);

  useEffect(() => {
    const remaining = getRemainingCooldownMs();
    if (remaining > 0) {
      startCooldownCountdown();
    }
    return clearCooldownInterval;
  }, [startCooldownCountdown, clearCooldownInterval]);

  /**
   * Clamp a raw input value to the accepted boundaries for a field.
   * This is the single change-path for both typing and pasting, so the
   * validator and the stored state can never disagree on length.
   */
  const clampInput = (value: string, maxLength: number) => {
    if (value.length <= maxLength) return value;
    return value.slice(0, maxLength);
  };

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(clampInput(e.target.value, MAX_EMAIL_LENGTH));
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(clampInput(e.target.value, MAX_PASSWORD_LENGTH));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Guard 1 — re-entrancy. A duplicate dispatch that re-enters the handler
    // while the first one is still running is dropped as a no-op.
    if (submitInFlightRef.current) {
      reportError(
        new Error('duplicate login submission suppressed'),
        'Home.handleSubmit',
        'warn',
        { reason: 'in_flight' },
      );
      return;
    }

    // Guard 2 — the cooldown check reads the *authoritative* deadline from
    // storage, never the `cooldownRemainingMs` render state. React state is
    // not updated synchronously, so two submissions dispatched in the same
    // task would both observe the pre-update value and both slip through.
    // Storage is read synchronously, so the second one is rejected here.
    //
    // The `disabled` submit button is deliberately NOT relied upon: it is a
    // UX affordance, not a security control. `form.requestSubmit()`, implicit
    // submission from a different submit button, and synthetic events all
    // bypass it, so enforcement has to live here.
    const remainingBeforeSubmit = getRemainingCooldownMs();
    if (remainingBeforeSubmit > 0) {
      reportError(
        new Error('login submission rejected during cooldown'),
        'Home.handleSubmit',
        'warn',
        { reason: 'cooldown', remainingMs: remainingBeforeSubmit },
      );
      // Re-sync the view with the authoritative value in case a sibling tab
      // started or extended the lockout after our last tick.
      setCooldownRemainingMs(remainingBeforeSubmit);
      startCooldownCountdown();
      return;
    }

    submitInFlightRef.current = true;
    try {
      const attempt = recordAttempt();

      // Re-read after recording: this is the deadline the user is now subject
      // to, including any extension a concurrent writer applied.
      const remaining = getRemainingCooldownMs();
      if (remaining > 0) {
        startCooldownCountdown();
      } else {
        setCooldownRemainingMs(0);
        clearCooldownInterval();
      }

      const newErrors = validateLogin(email, password);
      setErrors(newErrors);

      if (newErrors.length === 0) {
        // Compare-and-clear: only drop the state we know about. A concurrent
        // attempt recorded by another tab after ours keeps its lockout, so a
        // success can never launder someone else's failed attempt away.
        const cleared = resetThrottle({ revision: attempt.revision });
        // When the clear was skipped a newer concurrent lockout survived, so
        // re-sync the countdown to it rather than showing "Sign In" while a
        // lockout is still in force.
        const surviving = cleared ? 0 : getRemainingCooldownMs();
        if (surviving > 0) {
          startCooldownCountdown();
        } else {
          setCooldownRemainingMs(0);
          clearCooldownInterval();
        }
        showSuccess({
          title: 'Form submitted successfully!',
        });
        announce({
          message: 'Form submitted successfully.',
          type: 'success',
        });
      } else {
        announce({
          message: `Sign in failed. ${newErrors.length} error${newErrors.length > 1 ? 's' : ''} found. Please review the form.`,
          type: 'error',
        });
      }
    } finally {
      // Always released, so a throwing dependency cannot leave the form
      // permanently un-submittable.
      submitInFlightRef.current = false;
    }
  };

  const getError = (fieldId: string) => errors.find((e) => e.fieldId === fieldId)?.message;
  const cooldownSecs = Math.ceil(cooldownRemainingMs / 1000);
  const isCooldown = cooldownRemainingMs > 0;

  return (
    /**
     * ACCESSIBILITY LANDMARK STRUCTURE (WCAG 2.1 AA / issue #383)
     *
     * NOTE: No <main> landmark here — the root layout (src/app/layout.tsx) already
     * provides the single <main id="main-content" tabIndex={-1}> landmark. Per WCAG 2.1 AA,
     * a page should have exactly one main landmark to avoid confusing screen reader users
     * with duplicate navigation targets. Additionally, no <h1> is rendered here; the layout
     * header provides the page title, so this component uses <h2> to maintain a correct
     * heading hierarchy (h1 → h2).
     *
     * This structure ensures that:
     * 1. Screen readers see a single, unambiguous main content region
     * 2. Heading navigation produces a logical outline (h1 first, then h2 for sections)
     * 3. The ErrorSummary component's focus management works reliably (focus can move to
     *    the alert region and screen readers announce it without landmark confusion)
     */
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.18),_transparent_28%),linear-gradient(180deg,_#f8fafc_0%,_#eff6ff_100%)] px-6 py-20">
      <div className="mx-auto flex min-h-[6alc(100vh-3rem)] max-w-3l flex-col items-center justify-center rounded-[2rem] border border-white/70 bg-white/80 p-10 text-center shadow[0_24px_80px_rgba(15,23,42,0.10)] blur">
        {/* Section heading (h2, not h1 — see accessibility note above) */}
        <h2 className="mb-4 text-3xl font-bold text-center text-slate-900 sm:text-5xl">
          TalentTrust
        </h2>

        <p className="max-w-xl text-center text-base text-slate-600 sm:text-lg">
          Decentralized Freelancer Escrow Protocol on Stellar
        </p>
        <p className="mt-4 max-w-lg text-center text-sm text-slate-500 sm:text-base">
          Accessible toast feedback now supports transient success and error states, including screen reader announcements for critical wallet and payout events.
        </p>

        <form onSubmit={handleSubmit} className="mt-8 w-full max-w-md text-left" noValidate aria-label="Sign in">
          <ErrorSummary errors={errors} />

          <div className="space-y-4">
            <FormField
              label="Email"
              id="email"
              error={getError('email')}
              required
            >
              <input
                type="email"
                value={email}
                onChange={handleEmailChange}
                // Security: cap pasted/typed input at MAX_EMAIL_LENGTH so the
                // browser and the validator enforce the same ceiling. See
                // `MAX_EMAIL_LENGTH` in src/lib/validateLogin.ts.
                maxLength={MAX_EMAIL_LENGTH}
                autoComplete="email"
                aria-required="true"
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all shadow-sm"
                placeholder="you@example.com"
              />
            </FormField>

            <FormField
              label="Password"
              id="password"
              error={getError('password')}
              required
            >
              <input
                type="password"
                value={password}
                onChange={handlePasswordChange}
                // Security: cap pasted/typed input at MAX_PASSWORD_LENGTH. Mirrors
                // the validator ceiling and prevents denial-of-service from
                // arbitrarily long pasted secrets.
                maxLength={MAX_PASSWORD_LENGTH}
                autoComplete="current-password"
                aria-required="true"
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all shadow-sm"
                placeholder="••••••••"
              />
            </FormField>
          </div>

          <button
            type="submit"
            disabled={isCooldown}
            className="mt-6 w-full rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400 shadow-md disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isCooldown ? `Wait ${cooldownSecs}s` : 'Sign In'}
          </button>

          {isCooldown && (
            <div
              aria-live="polite"
              aria-atomic="true"
              className="sr-only"
            >
              Please wait {cooldownSecs} seconds before trying to sign in again.
            </div>
          )}

          {/* Form async result live regions — screen-reader only, no visual output */}
          <div
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
            data-testid="form-announcer-polite"
          >
            {politeMessage}
          </div>
          <div
            aria-live="assertive"
            aria-atomic="true"
            className="sr-only"
            data-testid="form-announcer-assertive"
          >
            {assertiveMessage}
          </div>
        </form>

        <ToastDemo />
      </div>
    </div>
  );
}
