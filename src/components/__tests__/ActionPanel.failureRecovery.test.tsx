/**
 * @file ActionPanel.failureRecovery.test.tsx
 *
 * Focused tests for the failure-recovery invariants added in issue #1271:
 *
 *   1. In-flight guard — exactly-once execution, no duplicate invocations.
 *   2. Async callback error surfaced via internalError banner and onActionError.
 *   3. Sync callback throw surfaced the same way.
 *   4. internalError cleared when a new action is successfully initiated.
 *   5. onActionStart notified before callback runs.
 *   6. disableMutations race: flipping disableMutations between dialog-open and
 *      dialog-confirm causes confirm to abort cleanly.
 *   7. disableMutations race for the inline dispute form.
 *   8. Retry after failure succeeds and clears the error banner.
 *   9. Non-Error throw produces a generic message.
 *  10. internalError hidden when external errorMessage is also present.
 *  11. Dispute inline form: async rejection surfaces internalError.
 *  12. Dispute inline form: sync throw surfaces internalError.
 *  13. Concurrent submit clicks do not double-invoke the callback (in-flight guard).
 */

import React from 'react';
import {
  render,
  screen,
  waitFor,
  within,
  act,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ActionPanel from '../ActionPanel';
import type { ActionName } from '../ActionPanel';
import { useWallet } from '@/contexts/WalletContext';

// ---------------------------------------------------------------------------
// Mock WalletContext
// ---------------------------------------------------------------------------

jest.mock('@/contexts/WalletContext', () => ({
  useWallet: jest.fn(),
}));

const mockUseWallet = jest.mocked(useWallet);

const CONNECTED_WALLET = {
  address: '0xABC',
  isConnecting: false,
  error: null,
  connect: jest.fn(),
  disconnect: jest.fn(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Opens and confirms the Release Funds dialog.
 * Returns after the confirmation click (awaiting pending state flush).
 */
async function openAndConfirmReleaseFunds(
  user: ReturnType<typeof userEvent.setup>,
) {
  await user.click(
    screen.getByRole('button', { name: /release funds to the contractor/i }),
  );
  const dialog = screen.getByRole('alertdialog', {
    name: /confirm release funds/i,
  });
  await user.click(
    within(dialog).getByRole('button', { name: /^release funds$/i }),
  );
}

/**
 * Opens and confirms the Submit Milestone dialog.
 */
async function openAndConfirmSubmitMilestone(
  user: ReturnType<typeof userEvent.setup>,
) {
  await user.click(
    screen.getByRole('button', { name: /submit milestone for approval/i }),
  );
  const dialog = screen.getByRole('dialog', {
    name: /confirm submit milestone/i,
  });
  await user.click(
    within(dialog).getByRole('button', { name: /submit milestone/i }),
  );
}

/**
 * Opens the inline dispute form, types a reason, and submits it.
 */
async function submitInlineDispute(
  user: ReturnType<typeof userEvent.setup>,
  reason = 'Quality issue',
) {
  await user.click(
    screen.getByRole('button', { name: /open a dispute for this contract/i }),
  );
  const textarea = screen.getByRole('textbox', { name: /reason/i });
  await user.clear(textarea);
  await user.type(textarea, reason);
  await user.click(screen.getByRole('button', { name: /confirm dispute/i }));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockUseWallet.mockReturnValue(CONNECTED_WALLET);
  jest.clearAllMocks();
});

// ===========================================================================
// 1. In-flight guard — concurrent button clicks do not double-invoke
// ===========================================================================

describe('in-flight guard (pendingAction)', () => {
  it('disables Release Funds while an async releaseFunds callback is in flight', async () => {
    const user = userEvent.setup();

    let resolveCallback!: () => void;
    const slowReleaseFunds = jest.fn(
      () => new Promise<void>((res) => { resolveCallback = res; }),
    );

    render(
      <ActionPanel
        status="Active"
        onReleaseFunds={slowReleaseFunds}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
      />,
    );

    await openAndConfirmReleaseFunds(user);

    // While the async callback is running the button must be disabled.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /release funds to the contractor/i }),
      ).toBeDisabled();
    });

    // Settle the callback.
    act(() => resolveCallback());

    await waitFor(() => {
      expect(slowReleaseFunds).toHaveBeenCalledTimes(1);
    });
  });

  it('prevents a second confirmation while an action is in-flight (no double-invoke)', async () => {
    const user = userEvent.setup();

    let resolveFirst!: () => void;
    const slowReleaseFunds = jest.fn(
      () => new Promise<void>((res) => { resolveFirst = res; }),
    );

    render(
      <ActionPanel
        status="Active"
        onReleaseFunds={slowReleaseFunds}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
      />,
    );

    await openAndConfirmReleaseFunds(user);

    // Button is now disabled — trying to open the dialog again must fail.
    expect(
      screen.getByRole('button', { name: /release funds to the contractor/i }),
    ).toBeDisabled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    act(() => resolveFirst());

    await waitFor(() => {
      // Callback fired exactly once — no double-invoke.
      expect(slowReleaseFunds).toHaveBeenCalledTimes(1);
    });
  });

  it('disables Submit Milestone while an async submitMilestone callback is in flight', async () => {
    const user = userEvent.setup();

    let resolve!: () => void;
    const slowSubmit = jest.fn(
      () => new Promise<void>((res) => { resolve = res; }),
    );

    render(
      <ActionPanel
        status="Active"
        onSubmitMilestone={slowSubmit}
        onReleaseFunds={jest.fn()}
        onDispute={jest.fn()}
      />,
    );

    await openAndConfirmSubmitMilestone(user);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /submit milestone for approval/i }),
      ).toBeDisabled();
    });

    act(() => resolve());

    await waitFor(() => {
      expect(slowSubmit).toHaveBeenCalledTimes(1);
    });
  });

  it('disables Dispute button while an async dispute callback is in flight', async () => {
    const user = userEvent.setup();

    let resolve!: () => void;
    const slowDispute = jest.fn(
      () => new Promise<void>((res) => { resolve = res; }),
    );

    render(
      <ActionPanel
        status="Active"
        onDispute={slowDispute}
        onSubmitMilestone={jest.fn()}
        onReleaseFunds={jest.fn()}
      />,
    );

    await submitInlineDispute(user);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /open a dispute for this contract/i }),
      ).toBeDisabled();
    });

    act(() => resolve());

    await waitFor(() => {
      expect(slowDispute).toHaveBeenCalledTimes(1);
    });
  });

  it('re-enables buttons after the in-flight callback resolves', async () => {
    const user = userEvent.setup();

    let resolve!: () => void;
    const slowReleaseFunds = jest.fn(
      () => new Promise<void>((res) => { resolve = res; }),
    );

    render(
      <ActionPanel
        status="Active"
        onReleaseFunds={slowReleaseFunds}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
      />,
    );

    await openAndConfirmReleaseFunds(user);

    // Buttons are disabled in-flight.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /release funds to the contractor/i }),
      ).toBeDisabled();
    });

    // Resolve the callback.
    act(() => resolve());

    // Buttons re-enable.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /release funds to the contractor/i }),
      ).toBeEnabled();
    });
  });
});

// ===========================================================================
// 2 & 3. Async callback rejection — internalError banner + onActionError
// ===========================================================================

describe('async callback rejection', () => {
  it('surfaces an internalError banner when releaseFunds rejects', async () => {
    const user = userEvent.setup();
    const onActionError = jest.fn();
    const failingRelease = jest.fn().mockRejectedValue(new Error('Network timeout'));

    render(
      <ActionPanel
        status="Active"
        onReleaseFunds={failingRelease}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
        onActionError={onActionError}
      />,
    );

    await openAndConfirmReleaseFunds(user);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Network timeout');
    });

    expect(onActionError).toHaveBeenCalledWith('releaseFunds', expect.any(Error));
    expect(onActionError.mock.calls[0][1]).toHaveProperty('message', 'Network timeout');
  });

  it('surfaces an internalError banner when submitMilestone rejects', async () => {
    const user = userEvent.setup();
    const onActionError = jest.fn();
    const failingSubmit = jest.fn().mockRejectedValue(new Error('Submission failed'));

    render(
      <ActionPanel
        status="Active"
        onSubmitMilestone={failingSubmit}
        onReleaseFunds={jest.fn()}
        onDispute={jest.fn()}
        onActionError={onActionError}
      />,
    );

    await openAndConfirmSubmitMilestone(user);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Submission failed');
    });

    expect(onActionError).toHaveBeenCalledWith(
      'submitMilestone',
      expect.objectContaining({ message: 'Submission failed' }),
    );
  });

  it('surfaces an internalError banner when inline dispute callback rejects', async () => {
    const user = userEvent.setup();
    const onActionError = jest.fn();
    const failingDispute = jest.fn().mockRejectedValue(new Error('Dispute failed'));

    render(
      <ActionPanel
        status="Active"
        onDispute={failingDispute}
        onSubmitMilestone={jest.fn()}
        onReleaseFunds={jest.fn()}
        onActionError={onActionError}
      />,
    );

    await submitInlineDispute(user, 'Deliverable not received');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Dispute failed');
    });

    expect(onActionError).toHaveBeenCalledWith(
      'dispute',
      expect.objectContaining({ message: 'Dispute failed' }),
    );
  });

  it('re-enables buttons after an async rejection settles', async () => {
    const user = userEvent.setup();
    const failingRelease = jest.fn().mockRejectedValue(new Error('Network timeout'));

    render(
      <ActionPanel
        status="Active"
        onReleaseFunds={failingRelease}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
      />,
    );

    await openAndConfirmReleaseFunds(user);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /release funds to the contractor/i }),
      ).toBeEnabled();
    });
  });
});

// ===========================================================================
// 4. Synchronous throw — same recovery path as async rejection
// ===========================================================================

describe('synchronous callback throw', () => {
  it('surfaces an internalError banner when releaseFunds throws synchronously', async () => {
    const user = userEvent.setup();
    const onActionError = jest.fn();
    const throwingRelease = jest.fn(() => {
      throw new Error('Sync throw');
    });

    render(
      <ActionPanel
        status="Active"
        onReleaseFunds={throwingRelease}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
        onActionError={onActionError}
      />,
    );

    await openAndConfirmReleaseFunds(user);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Sync throw');
    });

    expect(onActionError).toHaveBeenCalledWith(
      'releaseFunds',
      expect.objectContaining({ message: 'Sync throw' }),
    );
  });

  it('surfaces an internalError banner when submitMilestone throws synchronously', async () => {
    const user = userEvent.setup();
    const throwingSubmit = jest.fn(() => {
      throw new Error('Sync submit throw');
    });

    render(
      <ActionPanel
        status="Active"
        onSubmitMilestone={throwingSubmit}
        onReleaseFunds={jest.fn()}
        onDispute={jest.fn()}
      />,
    );

    await openAndConfirmSubmitMilestone(user);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Sync submit throw');
    });
  });

  it('surfaces an internalError banner when inline dispute callback throws synchronously', async () => {
    const user = userEvent.setup();
    const throwingDispute = jest.fn(() => {
      throw new Error('Sync dispute throw');
    });

    render(
      <ActionPanel
        status="Active"
        onDispute={throwingDispute}
        onSubmitMilestone={jest.fn()}
        onReleaseFunds={jest.fn()}
      />,
    );

    await submitInlineDispute(user, 'Contract issue');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Sync dispute throw');
    });
  });

  it('re-enables buttons after a sync throw is caught', async () => {
    const user = userEvent.setup();
    const throwingRelease = jest.fn(() => {
      throw new Error('Sync throw');
    });

    render(
      <ActionPanel
        status="Active"
        onReleaseFunds={throwingRelease}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
      />,
    );

    await openAndConfirmReleaseFunds(user);

    // After a sync throw, pendingAction is never set (sync callbacks don't
    // set the UI-disabled state). The button should be enabled immediately
    // after the error surfaces.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /release funds to the contractor/i }),
      ).toBeEnabled();
    });
  });
});

// ===========================================================================
// 5. Non-Error throw uses a generic fallback message
// ===========================================================================

describe('non-Error throw produces a generic message', () => {
  it('shows a generic internalError when a string is thrown from releaseFunds', async () => {
    const user = userEvent.setup();
    const throwingRelease = jest.fn(() => {
      // Deliberate non-Error throw: the component must still surface a
      // generic internalError rather than leaking the raw value.
      throw 'something went wrong';
    });

    render(
      <ActionPanel
        status="Active"
        onReleaseFunds={throwingRelease}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
      />,
    );

    await openAndConfirmReleaseFunds(user);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'An unexpected error occurred. Please try again.',
      );
    });
  });

  it('shows a generic internalError when null is rejected from submitMilestone', async () => {
    const user = userEvent.setup();
    const throwingSubmit = jest.fn().mockRejectedValue(null);

    render(
      <ActionPanel
        status="Active"
        onSubmitMilestone={throwingSubmit}
        onReleaseFunds={jest.fn()}
        onDispute={jest.fn()}
      />,
    );

    await openAndConfirmSubmitMilestone(user);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'An unexpected error occurred. Please try again.',
      );
    });
  });
});

// ===========================================================================
// 6. internalError clears on next successful action start
// ===========================================================================

describe('internalError cleared when a new action is initiated', () => {
  it('clears the internalError banner when the user initiates a new action', async () => {
    const user = userEvent.setup();
    const failThenSucceed = jest
      .fn()
      .mockRejectedValueOnce(new Error('First failure'))
      .mockResolvedValueOnce(undefined);

    render(
      <ActionPanel
        status="Active"
        onReleaseFunds={failThenSucceed}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
      />,
    );

    // First attempt fails → error banner appears.
    await openAndConfirmReleaseFunds(user);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('First failure');
    });

    // Second attempt succeeds → error banner disappears.
    await openAndConfirmReleaseFunds(user);
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    expect(failThenSucceed).toHaveBeenCalledTimes(2);
  });

  it('clears the internalError banner when the inline dispute form is opened again', async () => {
    const user = userEvent.setup();
    const failThenSucceed = jest
      .fn()
      .mockRejectedValueOnce(new Error('Dispute error'))
      .mockResolvedValueOnce(undefined);

    render(
      <ActionPanel
        status="Active"
        onDispute={failThenSucceed}
        onSubmitMilestone={jest.fn()}
        onReleaseFunds={jest.fn()}
      />,
    );

    // First dispute attempt fails → error banner.
    await submitInlineDispute(user, 'First reason');
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Dispute error');
    });

    // Opening the form again clears the previous internal error.
    await submitInlineDispute(user, 'Second reason');
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    expect(failThenSucceed).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// 7. onActionStart — notified before callback runs
// ===========================================================================

describe('onActionStart prop', () => {
  it('calls onActionStart with "releaseFunds" before the callback fires', async () => {
    const user = userEvent.setup();
    const callOrder: string[] = [];
    const onActionStart = jest.fn((action: ActionName) => callOrder.push(`start:${action}`));
    const onReleaseFunds = jest.fn(() => { callOrder.push('callback'); });

    render(
      <ActionPanel
        status="Active"
        onReleaseFunds={onReleaseFunds}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
        onActionStart={onActionStart}
      />,
    );

    await openAndConfirmReleaseFunds(user);

    await waitFor(() => {
      expect(onReleaseFunds).toHaveBeenCalledTimes(1);
    });
    expect(callOrder).toEqual(['start:releaseFunds', 'callback']);
  });

  it('calls onActionStart with "submitMilestone" before the callback fires', async () => {
    const user = userEvent.setup();
    const callOrder: string[] = [];
    const onActionStart = jest.fn((action: ActionName) => callOrder.push(`start:${action}`));
    const onSubmitMilestone = jest.fn(() => { callOrder.push('callback'); });

    render(
      <ActionPanel
        status="Active"
        onSubmitMilestone={onSubmitMilestone}
        onReleaseFunds={jest.fn()}
        onDispute={jest.fn()}
        onActionStart={onActionStart}
      />,
    );

    await openAndConfirmSubmitMilestone(user);

    await waitFor(() => {
      expect(onSubmitMilestone).toHaveBeenCalledTimes(1);
    });
    expect(callOrder).toEqual(['start:submitMilestone', 'callback']);
  });

  it('calls onActionStart with "dispute" before the inline dispute callback fires', async () => {
    const user = userEvent.setup();
    const callOrder: string[] = [];
    const onActionStart = jest.fn((action: ActionName) => callOrder.push(`start:${action}`));
    const onDispute = jest.fn(() => { callOrder.push('callback'); });

    render(
      <ActionPanel
        status="Active"
        onDispute={onDispute}
        onSubmitMilestone={jest.fn()}
        onReleaseFunds={jest.fn()}
        onActionStart={onActionStart}
      />,
    );

    await submitInlineDispute(user, 'Reason');

    await waitFor(() => {
      expect(onDispute).toHaveBeenCalledTimes(1);
    });
    expect(callOrder).toEqual(['start:dispute', 'callback']);
  });

  it('uses onActionStart to clear a stale external errorMessage', async () => {
    const user = userEvent.setup();
    let currentError: string | undefined = 'Stale error from previous attempt';

    const { rerender } = render(
      <ActionPanel
        status="Active"
        onReleaseFunds={jest.fn()}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
        errorMessage={currentError}
        onActionStart={() => {
          currentError = undefined;
          // Simulate the parent updating its error state.
          rerender(
            <ActionPanel
              status="Active"
              onReleaseFunds={jest.fn()}
              onDispute={jest.fn()}
              onSubmitMilestone={jest.fn()}
              errorMessage={undefined}
              onActionStart={jest.fn()}
            />,
          );
        }}
      />,
    );

    // External error is visible.
    expect(screen.getByRole('alert')).toHaveTextContent('Stale error from previous attempt');

    // Initiating a new action calls onActionStart which clears the error.
    await openAndConfirmReleaseFunds(user);

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('does not call onActionStart when the action is blocked by disableMutations', async () => {
    const onActionStart = jest.fn();

    render(
      <ActionPanel
        status="Active"
        onReleaseFunds={jest.fn()}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
        disableMutations
        onActionStart={onActionStart}
      />,
    );

    // All mutation buttons are disabled; no click can reach handleOpenConfirm.
    expect(
      screen.getByRole('button', { name: /release funds to the contractor/i }),
    ).toBeDisabled();
    expect(onActionStart).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 8. disableMutations race — flips between dialog-open and confirm
// ===========================================================================

describe('disableMutations race between dialog-open and dialog-confirm', () => {
  it('aborts cleanly when disableMutations flips true before Release Funds confirm', async () => {
    const user = userEvent.setup();
    const onReleaseFunds = jest.fn();

    const { rerender } = render(
      <ActionPanel
        status="Active"
        onReleaseFunds={onReleaseFunds}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
        disableMutations={false}
      />,
    );

    // Open the dialog while disableMutations is false.
    await user.click(
      screen.getByRole('button', { name: /release funds to the contractor/i }),
    );
    expect(
      screen.getByRole('alertdialog', { name: /confirm release funds/i }),
    ).toBeInTheDocument();

    // Flip disableMutations to true before the user clicks Confirm.
    rerender(
      <ActionPanel
        status="Active"
        onReleaseFunds={onReleaseFunds}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
        disableMutations={true}
      />,
    );

    // Confirm the dialog — handleConfirm should abort because disableMutations is now true.
    const dialog = screen.getByRole('alertdialog', {
      name: /confirm release funds/i,
    });
    await user.click(within(dialog).getByRole('button', { name: /^release funds$/i }));

    // Callback must NOT have been invoked.
    expect(onReleaseFunds).not.toHaveBeenCalled();
    // The dialog survives and explains the refusal; Cancel stays reachable so
    // the user is never trapped. (An earlier revision asserted auto-close here;
    // that contradicted the validation suite and discarded the user's decision
    // to confirm for a condition that clears on its own.)
    expect(screen.getByRole('alertdialog', { name: /confirm release funds/i })).toBeInTheDocument();
    await user.click(
      within(screen.getByRole('alertdialog', { name: /confirm release funds/i })).getByRole(
        'button',
        { name: /cancel/i },
      ),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('aborts cleanly when disableMutations flips true before Submit Milestone confirm', async () => {
    const user = userEvent.setup();
    const onSubmitMilestone = jest.fn();

    const { rerender } = render(
      <ActionPanel
        status="Active"
        onSubmitMilestone={onSubmitMilestone}
        onReleaseFunds={jest.fn()}
        onDispute={jest.fn()}
        disableMutations={false}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: /submit milestone for approval/i }),
    );
    expect(
      screen.getByRole('dialog', { name: /confirm submit milestone/i }),
    ).toBeInTheDocument();

    rerender(
      <ActionPanel
        status="Active"
        onSubmitMilestone={onSubmitMilestone}
        onReleaseFunds={jest.fn()}
        onDispute={jest.fn()}
        disableMutations={true}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: /confirm submit milestone/i });
    await user.click(within(dialog).getByRole('button', { name: /submit milestone/i }));

    expect(onSubmitMilestone).not.toHaveBeenCalled();
    // Survives the refusal with a visible explanation; Cancel still dismisses it.
    expect(screen.getByRole('dialog', { name: /confirm submit milestone/i })).toBeInTheDocument();
    await user.click(
      within(screen.getByRole('dialog', { name: /confirm submit milestone/i })).getByRole(
        'button',
        { name: /cancel/i },
      ),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

// ===========================================================================
// 9. disableMutations race — flips between form-open and form-submit (dispute)
// ===========================================================================

describe('disableMutations race for inline dispute form', () => {
  it('aborts cleanly when disableMutations flips true before Confirm Dispute', async () => {
    const user = userEvent.setup();
    const onDispute = jest.fn();

    const { rerender } = render(
      <ActionPanel
        status="Active"
        onDispute={onDispute}
        onSubmitMilestone={jest.fn()}
        onReleaseFunds={jest.fn()}
        disableMutations={false}
      />,
    );

    // Open the dispute form.
    await user.click(
      screen.getByRole('button', { name: /open a dispute for this contract/i }),
    );
    await user.type(screen.getByRole('textbox', { name: /reason/i }), 'Reason text');

    // Flip disableMutations before the user clicks Confirm.
    rerender(
      <ActionPanel
        status="Active"
        onDispute={onDispute}
        onSubmitMilestone={jest.fn()}
        onReleaseFunds={jest.fn()}
        disableMutations={true}
      />,
    );

    await user.click(screen.getByRole('button', { name: /confirm dispute/i }));

    // Callback must NOT have been invoked.
    expect(onDispute).not.toHaveBeenCalled();
    // The form stays open with its text intact. `disableMutations` clears on
    // its own (reconnect, or a fresh fetch), so auto-closing here would throw
    // away the user's words for a condition that resolves in a moment. The
    // typed reason is preserved and the refusal is shown instead.
    expect(
      screen.getByRole('group', { name: /describe the reason for this dispute/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /reason/i })).toHaveValue('Reason text');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Actions are disabled while offline or viewing stale data.',
    );

    // Recovery is not sticky: once the condition clears the same input submits.
    rerender(
      <ActionPanel
        status="Active"
        onDispute={onDispute}
        onSubmitMilestone={jest.fn()}
        onReleaseFunds={jest.fn()}
        disableMutations={false}
      />,
    );
    await user.click(screen.getByRole('button', { name: /confirm dispute/i }));
    expect(onDispute).toHaveBeenCalledTimes(1);
    expect(onDispute).toHaveBeenCalledWith('Reason text');
  });
});

// ===========================================================================
// 10. internalError hidden when external errorMessage is also present
// ===========================================================================

describe('internalError vs external errorMessage coexistence', () => {
  it('shows only the external errorMessage when both are present (no double-banner)', async () => {
    const user = userEvent.setup();
    const failingRelease = jest
      .fn()
      .mockRejectedValue(new Error('Callback failure'));

    render(
      <ActionPanel
        status="Active"
        onReleaseFunds={failingRelease}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
        errorMessage="External error from parent"
      />,
    );

    // External error is visible from the start.
    expect(screen.getByRole('alert')).toHaveTextContent('External error from parent');

    await openAndConfirmReleaseFunds(user);

    await waitFor(() => {
      expect(failingRelease).toHaveBeenCalledTimes(1);
    });

    // Still only one alert — the external message takes precedence.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('External error from parent');
  });

  it('shows internalError when there is no external errorMessage', async () => {
    const user = userEvent.setup();
    const failingRelease = jest
      .fn()
      .mockRejectedValue(new Error('Internal failure'));

    render(
      <ActionPanel
        status="Active"
        onReleaseFunds={failingRelease}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
      />,
    );

    await openAndConfirmReleaseFunds(user);

    await waitFor(() => {
      const alerts = screen.getAllByRole('alert');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toHaveTextContent('Internal failure');
    });
  });
});

// ===========================================================================
// 11. Retry after failure — succeeds and clears error
// ===========================================================================

describe('retry after failure', () => {
  it('clears the internalError and completes successfully on retry for releaseFunds', async () => {
    const user = userEvent.setup();
    const failThenSucceed = jest
      .fn()
      .mockRejectedValueOnce(new Error('Transient failure'))
      .mockResolvedValueOnce(undefined);

    render(
      <ActionPanel
        status="Active"
        onReleaseFunds={failThenSucceed}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
      />,
    );

    // First attempt fails.
    await openAndConfirmReleaseFunds(user);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Transient failure');
    });

    // Second attempt succeeds → error clears.
    await openAndConfirmReleaseFunds(user);
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    expect(failThenSucceed).toHaveBeenCalledTimes(2);
  });

  it('clears the internalError and completes successfully on retry for submitMilestone', async () => {
    const user = userEvent.setup();
    const failThenSucceed = jest
      .fn()
      .mockRejectedValueOnce(new Error('Submit failure'))
      .mockResolvedValueOnce(undefined);

    render(
      <ActionPanel
        status="Active"
        onSubmitMilestone={failThenSucceed}
        onReleaseFunds={jest.fn()}
        onDispute={jest.fn()}
      />,
    );

    await openAndConfirmSubmitMilestone(user);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Submit failure');
    });

    await openAndConfirmSubmitMilestone(user);
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    expect(failThenSucceed).toHaveBeenCalledTimes(2);
  });

  it('clears the internalError and completes successfully on retry for inline dispute', async () => {
    const user = userEvent.setup();
    const failThenSucceed = jest
      .fn()
      .mockRejectedValueOnce(new Error('Dispute failure'))
      .mockResolvedValueOnce(undefined);

    render(
      <ActionPanel
        status="Active"
        onDispute={failThenSucceed}
        onSubmitMilestone={jest.fn()}
        onReleaseFunds={jest.fn()}
      />,
    );

    await submitInlineDispute(user, 'First try');
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Dispute failure');
    });

    await submitInlineDispute(user, 'Second try');
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    expect(failThenSucceed).toHaveBeenCalledTimes(2);
    expect(failThenSucceed).toHaveBeenNthCalledWith(2, 'Second try');
  });
});

// ===========================================================================
// 12. Backward-compatibility — omitting new props does not break existing usage
// ===========================================================================

describe('backward compatibility', () => {
  it('renders and functions normally without onActionStart or onActionError', async () => {
    const user = userEvent.setup();
    const onReleaseFunds = jest.fn();

    render(
      <ActionPanel
        status="Active"
        onReleaseFunds={onReleaseFunds}
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
        // onActionStart and onActionError are intentionally omitted.
      />,
    );

    await openAndConfirmReleaseFunds(user);

    await waitFor(() => {
      expect(onReleaseFunds).toHaveBeenCalledTimes(1);
    });
  });

  it('does not throw when a callback is omitted and the confirm path is taken', async () => {
    const user = userEvent.setup();

    render(
      <ActionPanel
        status="Active"
        // onReleaseFunds intentionally omitted.
        onDispute={jest.fn()}
        onSubmitMilestone={jest.fn()}
      />,
    );

    // Should not throw — callback is optional.
    await expect(openAndConfirmReleaseFunds(user)).resolves.not.toThrow();
  });

  it('does not throw when onDispute is omitted and the inline form is submitted', async () => {
    const user = userEvent.setup();

    render(
      <ActionPanel
        status="Active"
        // onDispute intentionally omitted.
        onSubmitMilestone={jest.fn()}
        onReleaseFunds={jest.fn()}
      />,
    );

    // Should not throw.
    await expect(submitInlineDispute(user, 'Reason')).resolves.not.toThrow();
  });
});
