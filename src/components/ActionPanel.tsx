'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWallet } from '@/contexts/WalletContext';
import { ConfirmDialog } from './ConfirmDialog';
import { DISPUTE_REASON_MAX_LENGTH, validateDisputeReason } from '@/lib/disputeReason';
import { reportError } from '@/lib/errorReporter';
import {
  clampDisputeReason,
  evaluateActionGate,
  getVisibleActions,
  type ActionBlockedDetail,
  type ActionGateResult,
  type ActionId,
} from '@/lib/actionPanelPolicy';

export type { ActionBlockedDetail, ActionBlockCode, ActionId } from '@/lib/actionPanelPolicy';

/**
 * Defines the per-action screen-reader-only disabled reasons.
 * When a reason is provided for an action, the corresponding button is disabled,
 * and the reason text is rendered into a visually hidden `span` that is linked
 * to the button via `aria-describedby` (e.g., `id="action-panel-submitMilestone-reason"`).
 */
export type ActionPanelDisabledReasons = {
  /** Screen-reader description for why "Submit Milestone" is disabled. */
  submitMilestone?: string;
  /** Screen-reader description for why "Release Funds" is disabled. */
  releaseFunds?: string;
  /** Screen-reader description for why "Dispute" is disabled. */
  dispute?: string;
  /** Screen-reader description for why "View Summary" is disabled. */
  viewSummary?: string;
};

/**
 * The action name passed to `onActionError` and `onActionStart`.
 * Identifies which callback failed or was initiated.
 */
export type ActionName = 'submitMilestone' | 'releaseFunds' | 'dispute';

/**
 * Props for the ActionPanel component.
 */
export type ActionPanelProps = {
  /**
   * Current lifecycle status of the contract.
   * Drives which actions are visible and their order (resolved via
   * `getVisibleActions`). Values outside the canonical set degrade to the
   * read-only "View Summary" surface rather than exposing a mutation.
   */
  status: 'Active' | 'Completed' | 'Disputed' | 'Pending';
  /**
   * Callback triggered when the user initiates a milestone submission.
   * May be synchronous or async; errors are caught and surfaced via `onActionError`.
   */
  onSubmitMilestone?: () => void | Promise<void>;
  /**
   * Callback triggered when the user confirms a dispute with a reason.
   * Receives the trimmed, non-empty reason string (max 500 chars).
   * May be synchronous or async; errors are caught and surfaced via `onActionError`.
   */
  onDispute?: (reason: string) => void | Promise<void>;
  /**
   * Callback triggered when the user releases funds to the freelancer.
   * May be synchronous or async; errors are caught and surfaced via `onActionError`.
   */
  onReleaseFunds?: () => void | Promise<void>;
  /** Callback triggered to view the summary of a completed contract. */
  onViewSummary?: () => void;
  /**
   * Disables every visible action button globally and maps their `aria-describedby`
   * to a shared loading reason (`action-panel-loading-reason`). Use this while
   * fetching contract or wallet state.
   */
  isLoading?: boolean;
  /**
   * Render a `role="alert"` region above the actions to announce transient
   * errors (like network failures) to assistive technologies.
   * This is managed externally; ActionPanel also maintains its own `internalError`
   * banner for callback failures that the parent did not handle.
   */
  errorMessage?: string;
  /**
   * Per-action accessible reason for why a specific button is disabled.
   * Useful for wallet-gating, unmet conditions, or missing permissions.
   * Re-checked when a confirmation surface or the inline dispute form is
   * submitted, so revoking a reason mid-flow blocks the mutation instead of
   * silently dispatching it.
   */
  disabledReasons?: ActionPanelDisabledReasons;
  /**
   * Chooses whether Dispute uses the newer inline reason form or the legacy
   * confirmation dialog expected by older page-level flows.
   *
   * Reserved: the inline form is currently the only wired dispute surface, and
   * this value is accepted (and preserved) for backwards compatibility but does
   * not yet select the dialog path. See `CONFIRM_ACTION_ID` for the mapping the
   * confirm path uses, which is guarded by the same action gate as the inline
   * form so it stays safe if it is wired up later.
   */
  disputeFlow?: 'inline' | 'confirm';
  /**
   * When true, disables all mutation actions (submit, release, dispute) to prevent
   * unsafe changes while offline or when viewing stale cached data.
   */
  disableMutations?: boolean;
  /**
   * Optional observer notified whenever the panel refuses to dispatch an action
   * (refused by the status, loading, offline/stale, caller-permission or wallet
   * gate, or rejected as a duplicate submission). The payload carries only the
   * action id and a stable reason code — never the dispute reason, wallet
   * address or contract id — so it is safe to forward to analytics.
   */
  onBlockedAction?: (detail: ActionBlockedDetail) => void;
  /**
   * Optional observer notified once, synchronously, immediately before a mutation
   * callback is dispatched. Used by parents to close optimistic UI as soon as the
   * action is accepted.
   */
  onActionStart?: (action: ActionName) => void;
  /**
   * Optional observer notified when a dispatched mutation callback rejects or
   * throws. Receives the raw error so the parent can log it; ActionPanel itself
   * keeps the user-visible copy generic.
   */
  onActionError?: (action: ActionName, error: unknown) => void;
};

const LOADING_REASON = 'Action is disabled while contract data is loading.';
const LOADING_DESCRIPTION_ID = 'action-panel-loading-reason';

const DISPUTE_REASON_ERROR_ID = 'dispute-reason-error';
const DISPUTE_REASON_HINT_ID = 'dispute-reason-hint';
const DISPUTE_REASON_COUNTER_ID = 'dispute-reason-counter';
const DISPUTE_REASON_ASSERTIVE_THRESHOLD = 50;

/**
 * Reason emitted when a dispute is confirmed through the (currently unwired)
 * `disputeFlow="confirm"` path. It is still run through
 * `validateDisputeReason` before dispatch so `onDispute` can never receive an
 * unvalidated string from any code path.
 */
const DEFAULT_DISPUTE_REASON = 'Dispute opened from action panel.';

/**
 * Gate result used when a surface tries to dispatch a second time. It carries
 * no user-facing message on purpose: the surface is already closing, so
 * flashing an error would only be noise. The refusal is still reported.
 */
const DUPLICATE_DISPATCH: ActionGateResult = Object.freeze({
  allowed: false,
  code: 'duplicate_submission',
  message: null,
});

type ConfirmAction = keyof typeof CONFIRM_COPY | null;

/** Maps a confirmation dialog target onto its canonical action id. */
const CONFIRM_ACTION_ID: Record<Exclude<ConfirmAction, null>, ActionId> = {
  submit: 'submitMilestone',
  release: 'releaseFunds',
  dispute: 'dispute',
};

const CONFIRM_COPY = {
  submit: {
    title: 'Confirm Submit Milestone',
    description: 'Are you sure you want to submit this milestone for approval? This action cannot be undone.',
    confirmLabel: 'Submit Milestone',
  },
  release: {
    title: 'Confirm Release Funds',
    description: 'Are you sure you want to release funds? This action cannot be undone.',
    confirmLabel: 'Release Funds',
  },
  dispute: {
    title: 'Confirm Dispute',
    description: 'Are you sure you want to open a dispute for this contract? This action cannot be undone.',
    confirmLabel: 'Dispute',
  },
} as const;

/**
 * Contract action panel.
 *
 * ## Validation boundaries
 *
 * Three input boundaries cross this component, and each one is validated here
 * rather than trusted:
 *
 * 1. **Props (untrusted at runtime).** `status` may arrive from the network or
 *    `localStorage`, so it is normalised: an unrecognised status degrades to the
 *    read-only "View Summary" surface and can never expose a mutation.
 *    `disabledReasons`, `isLoading`, `disableMutations` and the wallet address
 *    are session/authorization inputs.
 * 2. **User input.** The dispute reason is clamped to
 *    `DISPUTE_REASON_MAX_LENGTH`, rejected when empty/whitespace-only, and the
 *    *trimmed* value that reaches `onDispute` is the only value that ever
 *    passed `validateDisputeReason`.
 * 3. **Callbacks.** No callback is invoked unless the action gate allows it at
 *    dispatch time, and each opened surface dispatches at most once.
 *
 * The gate from {@link evaluateActionGate} is evaluated twice — once for the
 * `disabled` attribute and once inside the dispatching handler — because a
 * `disabled` attribute is a rendering hint, not an authorization control: a
 * surface opened while a wallet was connected can still be open after the
 * wallet drops, and a parent can revoke `disabledReasons` mid-flow.
 *
 * Refusals are non-destructive: the surface stays open with the user's input
 * intact and a `role="alert"` explanation, and are reported to
 * `reportError`/`onBlockedAction` with only the action id and a stable code.
 */
const ActionPanel = ({
  status,
  onSubmitMilestone,
  onDispute,
  onReleaseFunds,
  onViewSummary,
  isLoading = false,
  errorMessage,
  disabledReasons,
  disputeFlow: _disputeFlow = 'inline',
  disableMutations = false,
  onBlockedAction,
  onActionStart,
  onActionError,
}: ActionPanelProps) => {
  const visibleActions = getVisibleActions(status);
  const { address } = useWallet();
  const isWalletConnected = !!address;
  const noWalletMsg = 'Connect wallet to perform this action';
  const mutationsDisabledMsg = disableMutations ? 'Actions disabled while offline or viewing stale data' : undefined;
  const panelRef = useRef<HTMLElement | null>(null);

  /**
   * The action currently dispatched, mirrored for rendering.
   *
   * Invariant: written only after `pendingActionRef` has been claimed and cleared
   * in the same tick the callback settles, so the UI's busy state can never claim
   * an action is in flight after `pendingActionRef` has already released it. It is
   * the *display* mirror only — `pendingActionRef` remains the authority for
   * duplicate-submission rejection.
   */
  const [pendingAction, setPendingAction] = useState<ActionName | null>(null);

  /**
   * Synchronous duplicate-submission guard.
   *
   * Invariant: set synchronously before the callback is invoked and cleared in
   * every terminal path (resolve and reject). Two clicks landing in the same tick
   * therefore produce exactly one dispatch, and a rejected callback still releases
   * the claim so the action remains retryable.
   */
  const pendingActionRef = useRef<ActionName | null>(null);

  /**
   * Rendering mirror of "a mutation is in flight".
   *
   * Derived from `pendingAction` rather than tracked separately, so the busy
   * affordances (disabled Cancel, `isConfirming` on the dialog) and the
   * duplicate-submission guard can never drift apart. `pendingActionRef` remains
   * the synchronous authority; this is display only.
   */
  const mutationInFlight = pendingAction !== null;


  const describedBy = (perActionId: string | undefined) =>
    isLoading ? LOADING_DESCRIPTION_ID : perActionId;
  const describedById = (key: keyof ActionPanelDisabledReasons) =>
    disabledReasons?.[key] ? `action-panel-${key}-reason` : undefined;

  const focusRingClass =
    'focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-blue-500';

  /**
   * Single source of truth for "may this action run right now?".
   *
   * The result drives both the `disabled` attribute and the guard inside the
   * handler that performs the mutation, so a click that slips past the DOM
   * attribute (stale render, scripted event, a surface that was open when the
   * wallet dropped or a permission was revoked) is still refused.
   */
  const gateFor = (
    action: ActionId,
    options?: { disputeFormOpen?: boolean },
  ): ActionGateResult =>
    evaluateActionGate({
      action,
      status,
      isLoading,
      disableMutations,
      isWalletConnected,
      disabledReasons,
      disputeFormOpen: options?.disputeFormOpen ?? false,
    });

  /**
   * Reports a refusal to both the app's error reporter and the optional
   * `onBlockedAction` observer.
   *
   * Only the action id and the enum code are emitted — never the dispute
   * reason, the wallet address or any contract identifier — so blocked actions
   * stay diagnosable without leaking user input.
   */
  const reportBlocked = (action: ActionId, gate: ActionGateResult) => {
    if (gate.allowed || !gate.code) return;
    reportError(gate.code, 'ActionPanel.actionBlocked', 'warn', { action, code: gate.code });
    onBlockedAction?.({ action, code: gate.code });
  };

  // Inline dispute form state.
  const [disputeFormOpen, setDisputeFormOpen] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');
  const [disputeReasonError, setDisputeReasonError] = useState('');
  const [liveAnnouncement, setLiveAnnouncement] = useState('');

  const gates = {
    submitMilestone: gateFor('submitMilestone'),
    releaseFunds: gateFor('releaseFunds'),
    dispute: gateFor('dispute'),
    // Trigger-side gate: the Dispute button is refused while its own form is
    // open. The submit handler deliberately re-evaluates the gate *without*
    // this flag so submitting an open form is never blocked by it.
    disputeTrigger: gateFor('dispute', { disputeFormOpen }),
    viewSummary: gateFor('viewSummary'),
  };

  // Submit / Release confirmation dialog state.
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  /** Reason a confirm was refused, surfaced inside the dialog as `role="alert"`. */
  const [confirmBlockError, setConfirmBlockError] = useState<string | null>(null);

  /**
   * The gates as rendered, with the in-flight clause applied.
   *
   * Invariant: while an async mutation is pending, every mutating gate is
   * refused with `duplicate_submission`. This is the *display* half of the
   * duplicate-submission guard — `pendingActionRef` is the authority that
   * actually rejects a second dispatch, so the two can never disagree about
   * whether an action was attempted twice. `viewSummary` is deliberately left
   * open: it is read-only and cancelling an in-flight mutation must stay
   * possible.
   */
  const renderedGates = {
    submitMilestone:
      pendingAction !== null || disputeFormOpen
        ? DUPLICATE_DISPATCH
        : gates.submitMilestone,
    releaseFunds:
      pendingAction !== null || disputeFormOpen
        ? DUPLICATE_DISPATCH
        : gates.releaseFunds,
    // I1 mutual exclusion: while a confirmation dialog is open the dispute
    // trigger is refused, so the panel can never have two competing mutation
    // surfaces at once.
    disputeTrigger:
      pendingAction !== null || confirmAction !== null
        ? DUPLICATE_DISPATCH
        : gates.disputeTrigger,
    dispute: pendingAction === null ? gates.dispute : DUPLICATE_DISPATCH,
    viewSummary: gates.viewSummary,
  };


  /**
   * Failure of a mutation callback ActionPanel dispatched itself.
   *
   * Invariant: it is cleared at the start of every new attempt (see the
   * dispatch path), so a recovered action cannot keep showing a stale failure.
   * It renders only when the parent supplies no `errorMessage`, which keeps a
   * single authoritative banner instead of two contradicting ones.
   */
  const [internalError, setInternalError] = useState<string | null>(null);

  /**
   * Duplicate-submission guard.
   *
   * Every opened surface (confirmation dialog or inline dispute form) takes a
   * monotonically increasing token. The token is consumed synchronously —
   * before the React state update that closes the surface flushes — at the
   * moment the action is dispatched, so a double click, an Enter keypress plus
   * a click, or any other re-entrant dispatch inside the same tick emits
   * exactly one mutation.
   *
   * Tokens are strictly increasing and never reused, so a consumed token can
   * never match a later surface: closing a surface deliberately does *not*
   * clear the marker, and re-opening mints a fresh token. A refused attempt
   * never consumes its token either, so the user can fix the problem and retry
   * on the same surface. Cross-surface duplicates (dispatching again after the
   * surface closed) remain the caller's responsibility — it owns the status
   * state machine and the `isLoading` flag.
   */
  const surfaceTokenRef = useRef(0);
  const consumedTokenRef = useRef(-1);
  const openSurface = () => {
    // Defensive wrap so the counter can never collide with a consumed value.
    if (surfaceTokenRef.current >= Number.MAX_SAFE_INTEGER - 1) {
      surfaceTokenRef.current = 0;
      consumedTokenRef.current = -1;
    }
    surfaceTokenRef.current += 1;
  };
  const isSurfaceConsumed = () => consumedTokenRef.current === surfaceTokenRef.current;
  const consumeSurface = () => {
    consumedTokenRef.current = surfaceTokenRef.current;
  };

  /**
   * Holds a reference to the button that opened the confirmation dialog or the
   * dispute form. After closing, focus is restored here to satisfy WCAG 2.1
   * SC 3.2.2 and the APG dialog pattern.
   */
  const triggerElementRef = useRef<HTMLButtonElement | null>(null);

  const handleOpenConfirm = (
    action: Exclude<ConfirmAction, null>,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    const actionId = CONFIRM_ACTION_ID[action];
    const gate = gateFor(actionId);
    if (!gate.allowed) {
      reportBlocked(actionId, gate);
      return;
    }
    triggerElementRef.current = event.currentTarget;
    setConfirmBlockError(null);
    openSurface();
    setConfirmAction(action);
  };

  /**
   * Executes the callback for the confirmed action.
   *
   * Guards:
   *   1. disableMutations is re-checked at execution time (handles the window
   *      between dialog-open and dialog-confirm where the prop may have flipped).
   *   2. A ref-based synchronous guard (`pendingActionRef`) prevents duplicate
   *      invocations even before the state update has propagated.
   *   3. Both synchronous throws and async rejections are caught; sync throws
   *      are wrapped in a rejected Promise so they do not escape React's event
   *      system unhandled.
   *   4. `pendingAction` state (for UI) is set only when the callback returns a
   *      Promise (i.e., the operation is async), so synchronous callers do not
   *      see a flash of disabled buttons.
   */
  const handleConfirm = () => {
    // Nothing is open: nothing to confirm.
    if (confirmAction === null) return;

    const actionId = CONFIRM_ACTION_ID[confirmAction];

    if (isSurfaceConsumed()) {
      reportBlocked(actionId, DUPLICATE_DISPATCH);
      return;
    }

    const gate = gateFor(actionId);
    if (!gate.allowed) {
      reportBlocked(actionId, gate);
      // Keep the dialog open with a diagnosable explanation and leave Cancel
      // reachable, so the user is never trapped and can either fix the
      // condition (reconnect the wallet, wait for the load) or dismiss the
      // dialog. Auto-closing here would silently discard the user's decision to
      // confirm, and would race any condition that clears on its own.
      setConfirmBlockError(gate.message);
      return;
    }

    // The reserved `disputeFlow="confirm"` path still routes its canned reason
    // through the shared validator, so `onDispute` can never be handed an
    // unvalidated string from any code path.
    if (confirmAction === 'dispute') {
      const validation = validateDisputeReason(DEFAULT_DISPUTE_REASON);
      if (!validation.valid) {
        setConfirmBlockError(validation.error ?? null);
        return;
      }
    }

    // Consume before dispatch so a synchronous re-entrant confirm is refused.
    consumeSurface();

    // Single dispatch point for the confirm flow: `actionId` is derived from
    // `confirmAction` through CONFIRM_ACTION_ID, so the inline and confirm paths
    // can never drift apart on which callback runs (or on which id is reported).
    const action = actionId as ActionName;
    onActionStart?.(action);
    // Set the ref immediately (synchronous re-entrance guard).
    pendingActionRef.current = action;

    /**
     * Invokes the action callback and always returns a Promise.
     * Synchronous throws are caught here and converted to rejected Promises
     * so they never escape to React's event system as uncaught exceptions.
     */
    const invokeCallback = (): { promise: Promise<void>; isAsync: boolean } => {
      let returnValue: void | Promise<void>;
      try {
        if (action === 'submitMilestone') {
          returnValue = onSubmitMilestone?.();
        } else if (action === 'releaseFunds') {
          returnValue = onReleaseFunds?.();
        } else {
          // action === 'dispute'. The reason was validated above, so
          // `onDispute` is never handed an unvalidated string on this path.
          returnValue = onDispute?.(DEFAULT_DISPUTE_REASON);
        }
      } catch (syncErr) {
        return { promise: Promise.reject(syncErr), isAsync: false };
      }
      const isAsync = returnValue instanceof Promise;
      return { promise: Promise.resolve(returnValue), isAsync };
    };

    const { promise, isAsync } = invokeCallback();

    // Close the dialog immediately: the action has been dispatched, so leaving
    // it open would let the user re-confirm what is already running.
    setConfirmBlockError(null);
    setConfirmAction(null);
    // Clear any previous internal error; a new attempt is being made.
    setInternalError(null);

    // Only show the in-flight UI (disabled buttons) for genuinely async callbacks.
    // For sync callbacks: clear the ref immediately so subsequent synchronous
    // interactions are not blocked by a stale ref that would only clear after a
    // microtask. The promise .then still clears it again (idempotently) for safety.
    if (isAsync) {
      setPendingAction(action);
    } else {
      pendingActionRef.current = null;
    }

    promise.then(
      () => {
        pendingActionRef.current = null;
        setPendingAction(null);
      },
      (err: unknown) => {
        pendingActionRef.current = null;
        setPendingAction(null);
        const message =
          err instanceof Error ? err.message : 'An unexpected error occurred. Please try again.';
        setInternalError(message);
        onActionError?.(action, err);
      },
    );
  };

  const handleCancel = () => {
    setConfirmBlockError(null);
    setConfirmAction(null);
  };

  // Inline dispute form state (refs and derived announcements).
  const disputeTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const previousConfirmActionRef = useRef<ConfirmAction>(null);
  const disputeTriggerRef = useRef<HTMLButtonElement | null>(null);

  /** Opens the inline dispute form and moves focus to the textarea. */
  const handleOpenDisputeForm = (event: React.MouseEvent<HTMLButtonElement>) => {
    // Re-use the trigger-side gate that drives this button's `disabled`
    // attribute. `disputeFormOpen` is still false at click time, so the
    // `form_open` rule only refuses a re-entrant open (see the policy module).
    // `renderedGates` rather than `gates` so the handler cannot disagree with
    // what the user sees: I1 mutual exclusion (a confirm dialog or an in-flight
    // mutation already owns the panel) refuses the open here too.
    const gate = renderedGates.disputeTrigger;
    if (!gate.allowed) {
      reportBlocked('dispute', gate);
      return;
    }
    triggerElementRef.current = event.currentTarget;
    disputeTriggerRef.current = event.currentTarget;
    setDisputeReason('');
    setDisputeReasonError('');
    // Re-opening the form is a fresh attempt: a stale failure banner from the
    // previous one must not survive, or the user sees an error for an action
    // they have not retried yet.
    setInternalError(null);
    // With disputeFlow="confirm" the inline form is never rendered, so opening
    // it here left the trigger inert: no dialog appeared and no dispute could
    // be raised. Route to the confirmation dialog instead, which supplies its
    // own canned (still validated) reason.
    if (_disputeFlow === 'confirm') {
      setConfirmAction('dispute');
      openSurface();
      return;
    }
    openSurface();
    setDisputeFormOpen(true);
  };

  const previousDisputeFormOpenRef = useRef(false);

  // Move focus into the textarea when the form becomes visible, or restore focus when it closes.
  useLayoutEffect(() => {
    if (disputeFormOpen) {
      disputeTextareaRef.current?.focus();
    } else if (previousDisputeFormOpenRef.current) {
      // Form was closed, restore focus to the button that opened it.
      const triggerButton = disputeTriggerRef.current;
      if (triggerButton && document.contains(triggerButton) && !triggerButton.disabled) {
        triggerButton.focus();
      } else {
        panelRef.current?.focus();
      }
    }
    previousDisputeFormOpenRef.current = disputeFormOpen;
  }, [disputeFormOpen]);

  // Manage debounced/throttled screen reader announcements for character count
  useEffect(() => {
    if (!disputeFormOpen) {
      setLiveAnnouncement('');
      return;
    }

    const remaining = DISPUTE_REASON_MAX_LENGTH - disputeReason.length;
    const announcement = `${disputeReason.length} of ${DISPUTE_REASON_MAX_LENGTH} characters`;

    const isBoundary = (chars: number) => {
      if (chars <= 0) return true;
      if (chars <= 10) return true;
      if (chars <= 50) return chars % 10 === 0;
      return chars % 50 === 0;
    };

    if (isBoundary(remaining)) {
      setLiveAnnouncement(announcement);
      return;
    }

    const timeoutId = setTimeout(() => {
      setLiveAnnouncement(announcement);
    }, 1000);

    return () => clearTimeout(timeoutId);
  }, [disputeReason, disputeFormOpen]);

  useLayoutEffect(() => {
    const wasDialogOpen = previousConfirmActionRef.current !== null;

    if (!wasDialogOpen || confirmAction !== null || isLoading) {
      previousConfirmActionRef.current = confirmAction;
      return;
    }

    const triggerButton = triggerElementRef.current;
    if (triggerButton && document.contains(triggerButton) && !triggerButton.disabled) {
      triggerButton.focus();
    } else {
      panelRef.current?.focus();
    }

    previousConfirmActionRef.current = confirmAction;
  }, [confirmAction, isLoading]);

  /** Closes the inline form and returns focus to the button that opened it. */
  const closeDisputeForm = () => {
    setDisputeFormOpen(false);
    setDisputeReason('');
    setDisputeReasonError('');
  };

  const handleDisputeReasonChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // Hard clamp in the handler as a safety net in addition to the `maxLength`
    // attribute. Input is *truncated* rather than discarded so an over-long
    // paste (or an IME/autofill commit that bypasses `maxLength`) still yields
    // a usable reason instead of silently emptying the field; the character
    // counter communicates the limit.
    const value = clampDisputeReason(e.target.value, DISPUTE_REASON_MAX_LENGTH);
    setDisputeReason(value);
    // Clear the validation error as soon as the user starts correcting input.
    if (disputeReasonError && value.trim().length > 0) {
      setDisputeReasonError('');
    }
  };

  /** Guards the read-only summary navigation with the same action gate. */
  const handleViewSummary = () => {
    const gate = gates.viewSummary;
    if (!gate.allowed) {
      reportBlocked('viewSummary', gate);
      return;
    }
    onViewSummary?.();
  };

  /**
   * Validates and submits the dispute reason.
   *
   * Checks run in a fixed order so the surfaced error is deterministic:
   *   1. The form must still be open (guards stale/duplicate submit events).
   *   2. This surface must not have already dispatched (`duplicate_submission`).
   *   3. The action gate must still allow `dispute` — re-checked at submit time
   *      so a wallet drop, an offline/stale session or a revoked
   *      `disabledReasons.dispute` cannot slip a mutation through a form that
   *      was opened while it was still allowed.
   *   4. The reason itself must satisfy `validateDisputeReason`
   *      (non-empty after trim, at most 500 characters).
   *
   * On success the trimmed reason is forwarded to `onDispute` and the form is
   * closed; focus returns to the originating "Dispute" button. A refused
   * attempt never consumes the surface token and never clears the typed
   * reason, so the user can fix the problem and retry.
   */
  const handleDisputeSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!disputeFormOpen) return;

    if (isSurfaceConsumed()) {
      reportBlocked('dispute', DUPLICATE_DISPATCH);
      return;
    }

    const gate = gateFor('dispute');
    if (!gate.allowed) {
      reportBlocked('dispute', gate);
      if (gate.message) {
        setDisputeReasonError(gate.message);
        disputeTextareaRef.current?.focus();
      }
      return;
    }

    const validation = validateDisputeReason(disputeReason);
    if (!validation.valid) {
      setDisputeReasonError(validation.error || '');
      disputeTextareaRef.current?.focus();
      return;
    }

    consumeSurface();
    closeDisputeForm();

    // Set the ref immediately (synchronous re-entrance guard).
    pendingActionRef.current = 'dispute';
    onActionStart?.('dispute');

    let returnValue: void | Promise<void> = undefined;
    let invokeError: unknown;
    let didThrow = false;
    try {
      // `disputeReason` was already validated above; trimming here keeps the
      // value handed to `onDispute` identical to the one the user typed minus
      // surrounding whitespace, and is computed exactly once.
      const trimmedReason = disputeReason.trim();
      returnValue = onDispute?.(trimmedReason);
    } catch (syncErr) {
      invokeError = syncErr;
      didThrow = true;
    }

    const isAsync = returnValue instanceof Promise;

    // Only show in-flight UI for async callbacks; clear ref immediately for sync.
    if (isAsync) {
      setPendingAction('dispute');
    } else {
      pendingActionRef.current = null;
    }

    const promise: Promise<void> = didThrow
      ? Promise.reject(invokeError)
      : Promise.resolve(returnValue);

    promise.then(
      () => {
        pendingActionRef.current = null;
        setPendingAction(null);
      },
      (err: unknown) => {
        pendingActionRef.current = null;
        setPendingAction(null);
        const message =
          err instanceof Error ? err.message : 'An unexpected error occurred. Please try again.';
        setInternalError(message);
        onActionError?.('dispute', err);
      },
    );
  };

  const remainingChars = DISPUTE_REASON_MAX_LENGTH - disputeReason.length;
  const isOverLimit = disputeReason.length >= DISPUTE_REASON_MAX_LENGTH;

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby="action-panel-heading"
      className="sticky top-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <div className="mb-6">
        <p className="text-sm text-slate-500 uppercase tracking-[0.24em]">Action Panel</p>
        <h2 id="action-panel-heading" className="mt-2 text-xl font-semibold text-slate-900">
          What would you like to do?
        </h2>
        {!isWalletConnected && (
          <p className="mt-2 rounded-lg border border-red-100 bg-red-50 p-2 text-sm text-red-500">
            {noWalletMsg}
          </p>
        )}
        {errorMessage && (
          <p role="alert" className="mt-2 rounded-lg border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700">
            {errorMessage}
          </p>
        )}
        {/* Internal error banner: surfaces callback failures that the parent did not handle.
            Shown only when there is no external errorMessage to avoid a double banner. */}
        {internalError && !errorMessage && (
          <p role="alert" className="mt-2 rounded-lg border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700">
            {internalError}
          </p>
        )}
        {isLoading && (
          <span id={LOADING_DESCRIPTION_ID} className="sr-only">
            {LOADING_REASON}
          </span>
        )}
        {disabledReasons?.submitMilestone && (
          <span id="action-panel-submitMilestone-reason" className="sr-only">
            {disabledReasons.submitMilestone}
          </span>
        )}
        {disabledReasons?.releaseFunds && (
          <span id="action-panel-releaseFunds-reason" className="sr-only">
            {disabledReasons.releaseFunds}
          </span>
        )}
        {disabledReasons?.dispute && (
          <span id="action-panel-dispute-reason" className="sr-only">
            {disabledReasons.dispute}
          </span>
        )}
        {disabledReasons?.viewSummary && (
          <span id="action-panel-viewSummary-reason" className="sr-only">
            {disabledReasons.viewSummary}
          </span>
        )}
      </div>

      <div className="space-y-3">
        {visibleActions.includes('submitMilestone') && (
          <button
            type="button"
            onClick={(e) => handleOpenConfirm('submit', e)}
            disabled={!renderedGates.submitMilestone.allowed}
            title={!isWalletConnected ? noWalletMsg : mutationsDisabledMsg}
            aria-label="Submit milestone for approval"
            aria-describedby={describedBy(describedById('submitMilestone'))}
            className={`w-full rounded-2xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 ${focusRingClass}`}
          >
            Submit Milestone
          </button>
        )}

        {visibleActions.includes('releaseFunds') && (
          <button
            type="button"
            onClick={(event) => handleOpenConfirm('release', event)}
            disabled={!renderedGates.releaseFunds.allowed}
            title={!isWalletConnected ? noWalletMsg : mutationsDisabledMsg}
            aria-label="Release funds to the contractor"
            aria-describedby={describedBy(describedById('releaseFunds'))}
            className={`w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-900 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50 ${focusRingClass}`}
          >
            Release Funds
          </button>
        )}

        {visibleActions.includes('dispute') && (
          <>
            <button
              ref={disputeTriggerRef}
              type="button"
              onClick={handleOpenDisputeForm}
              disabled={!renderedGates.disputeTrigger.allowed}
              title={!isWalletConnected ? noWalletMsg : mutationsDisabledMsg}
              aria-label="Open a dispute for this contract"
              aria-expanded={_disputeFlow === 'inline' ? disputeFormOpen : undefined}
              aria-controls={_disputeFlow === 'inline' && disputeFormOpen ? 'dispute-reason-form' : undefined}
              aria-describedby={describedBy(describedById('dispute'))}
              className={`w-full rounded-2xl bg-rose-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed ${focusRingClass}`}
            >
              Dispute
            </button>

            {/* Inline dispute reason form — rendered below the trigger button,
                visible only when the user clicks "Dispute". The form is not a
                modal so the rest of the page remains accessible. */}
            {_disputeFlow === 'inline' && disputeFormOpen && (
              <div
                id="dispute-reason-form"
                role="group"
                aria-labelledby="dispute-form-heading"
                className="rounded-2xl border border-rose-200 bg-rose-50 p-4 space-y-3"
              >
                <p
                  id="dispute-form-heading"
                  className="text-sm font-semibold text-rose-900"
                >
                  Describe the reason for this dispute
                </p>

                {/* Screen-reader hint linked via aria-describedby */}
                <span id={DISPUTE_REASON_HINT_ID} className="sr-only">
                  Enter a reason between 1 and {DISPUTE_REASON_MAX_LENGTH} characters.
                  This cannot be undone.
                </span>

                <form onSubmit={handleDisputeSubmit} noValidate>
                  <label
                    htmlFor="dispute-reason-textarea"
                    className="block text-xs font-medium text-rose-800 mb-1"
                  >
                    Reason{' '}
                    <span aria-hidden="true" className="text-rose-600">
                      *
                    </span>
                  </label>

                  <textarea
                    ref={disputeTextareaRef}
                    id="dispute-reason-textarea"
                    name="disputeReason"
                    rows={4}
                    maxLength={DISPUTE_REASON_MAX_LENGTH}
                    value={disputeReason}
                    onChange={handleDisputeReasonChange}
                    aria-required="true"
                    aria-describedby={
                      disputeReasonError
                        ? `${DISPUTE_REASON_ERROR_ID} ${DISPUTE_REASON_HINT_ID} ${DISPUTE_REASON_COUNTER_ID}`
                        : `${DISPUTE_REASON_HINT_ID} ${DISPUTE_REASON_COUNTER_ID}`
                    }
                    aria-invalid={disputeReasonError ? 'true' : undefined}
                    placeholder="Explain why you are opening this dispute…"
                    className={`w-full resize-y rounded-xl border px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-rose-500 ${
                      disputeReasonError
                        ? 'border-rose-500 bg-white'
                        : 'border-slate-300 bg-white'
                    }`}
                  />

                  {/* Visual character counter - not a live region to avoid double reading */}
                  <p
                    aria-hidden="true"
                    className={`mt-1 text-xs text-right ${
                      isOverLimit ? 'text-rose-600 font-semibold' : 'text-slate-500'
                    }`}
                  >
                    {disputeReason.length} of {DISPUTE_REASON_MAX_LENGTH} characters
                  </p>

                  {/* Visually hidden live region for screen readers */}
                  <div
                    id={DISPUTE_REASON_COUNTER_ID}
                    aria-live={remainingChars <= DISPUTE_REASON_ASSERTIVE_THRESHOLD ? 'assertive' : 'polite'}
                    aria-atomic="true"
                    className="sr-only"
                  >
                    {liveAnnouncement}
                  </div>

                  {/* Validation error — linked to the textarea via aria-describedby */}
                  {disputeReasonError && (
                    <p
                      id={DISPUTE_REASON_ERROR_ID}
                      role="alert"
                      className="mt-1 text-xs font-medium text-rose-700"
                    >
                      {disputeReasonError}
                    </p>
                  )}

                  <div className="flex gap-2 mt-3">
                    <button
                      type="submit"
                      disabled={pendingAction !== null}
                      className={`flex-1 rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed ${focusRingClass}`}
                    >
                      Confirm Dispute
                    </button>
                    <button
                      type="button"
                      onClick={closeDisputeForm}
                      disabled={mutationInFlight}
                      className={`flex-1 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:border-slate-400 ${focusRingClass}`}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            )}
          </>
        )}

        {visibleActions.includes('viewSummary') && (
          <button
            type="button"
            onClick={handleViewSummary}
            disabled={!renderedGates.viewSummary.allowed}
            aria-label="View contract summary details"
            aria-describedby={describedBy(describedById('viewSummary'))}
            className={`w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-900 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50 ${focusRingClass}`}
          >
            View Summary
          </button>
        )}
      </div>

      {/* Confirmation Dialog: used for Submit Milestone and Release Funds only.
          Dispute is handled by the inline form above. `error` surfaces a refused
          confirm (e.g. the wallet disconnected while the dialog was open) as a
          `role="alert"` without closing the dialog. */}
      <ConfirmDialog
        isOpen={confirmAction !== null}
        title={confirmAction && confirmAction in CONFIRM_COPY ? CONFIRM_COPY[confirmAction as keyof typeof CONFIRM_COPY].title : ''}
        description={confirmAction && confirmAction in CONFIRM_COPY ? CONFIRM_COPY[confirmAction as keyof typeof CONFIRM_COPY].description : ''}
        confirmLabel={confirmAction && confirmAction in CONFIRM_COPY ? CONFIRM_COPY[confirmAction as keyof typeof CONFIRM_COPY].confirmLabel : 'Confirm'}
        cancelLabel="Cancel"
        tone={confirmAction === 'release' || confirmAction === 'dispute' ? 'destructive' : 'default'}
        error={confirmBlockError ?? undefined}
        onConfirm={handleConfirm}
        isLoading={mutationInFlight}
        onCancel={handleCancel}
      />
    </aside>
  );
};

export default ActionPanel;
