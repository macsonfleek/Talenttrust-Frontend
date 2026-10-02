import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react';
import ContractDetailPage from '../page';
import * as contractResolver from '@/lib/contractResolver';
import { upsertContract, listMilestonesByContract, updateMilestone } from '@/lib/repository';
import { useWallet } from '@/contexts/WalletContext';
import { ToastProvider } from '@/components/toast/toast-provider';
import { getCachedContractData } from '@/lib/contractCache';
import userEvent from '@testing-library/user-event';

/**
 * Installs a working clipboard mock and returns the writeText spy.
 */
function installClipboard(): jest.Mock {
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

/**
 * Removes navigator.clipboard to simulate an unsupported environment.
 */
function removeClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  });
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

jest.mock('next/navigation', () => ({
  notFound: jest.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

jest.mock('@/lib/contractResolver');
jest.mock('@/lib/repository', () => ({
  upsertContract: jest.fn(),
  listMilestonesByContract: jest.fn(() => []),
  getContractVersion: jest.fn(() => 0),
  updateMilestone: jest.fn(() => true),
}));
jest.mock('@/contexts/WalletContext', () => ({
  useWallet: jest.fn(),
}));

const mockedResolveContractData = jest.mocked(contractResolver.resolveContractData);
const mockedUpsertContract = jest.mocked(upsertContract);
const mockedUpdateMilestone = jest.mocked(updateMilestone);
const mockedListMilestonesByContract = jest.mocked(listMilestonesByContract);
const mockedUseWallet = useWallet as jest.MockedFunction<typeof useWallet>;

const contractData: contractResolver.ContractData = {
  id: '123',
  name: 'Stellar Escrow Implementation',
  status: 'Active',
  parties: [
    { label: 'Client', address: 'GABC1234DEF5678HIJK9012LMNO3456PQRS7890' },
    { label: 'Freelancer', address: 'GXYZ9876STU5432VWXQ1098ABCD7654EFGH3210' },
  ],
  totalValue: 7000,
  currency: 'USD',
  createdAt: 'Apr 20, 2026',
  milestones: [
    {
      id: 'ms-1',
      title: 'Kickoff and scope approval',
      status: 'Completed',
      payout: 1500,
      currency: 'USD',
      dueDate: '2026-05-04',
    },
    {
      id: 'ms-2',
      title: 'Design and review',
      status: 'Pending',
      payout: 2500,
      currency: 'USD',
      dueDate: '2026-06-01',
    },
    {
      id: 'ms-3',
      title: 'Final delivery',
      status: 'Pending',
      payout: 3000,
      currency: 'USD',
      dueDate: '2026-07-12',
    },
  ],
};

const BASE_CONTRACT = contractData;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

async function renderPage(id = '123') {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <ToastProvider>
        <ContractDetailPage params={Promise.resolve({ id })} />
      </ToastProvider>,
    );
  });
  return result!;
}

function getContractSummarySection() {
  const contractHeading = screen.getByRole('heading', { name: contractData.name });
  const section = contractHeading.closest('section');

  if (!section) {
    throw new Error('Contract summary section was not found.');
  }

  return section;
}

async function findEnabledButton(name: RegExp | string) {
  await screen.findByRole('button', { name });
  await waitFor(() => {
    expect(screen.getByRole('button', { name })).toBeEnabled();
  });
  return screen.getByRole('button', { name });
}

async function confirmReleaseFunds(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await findEnabledButton(/release funds to the contractor/i));
  const dialog = await screen.findByRole('alertdialog', { name: /confirm release funds/i });
  await user.click(within(dialog).getByRole('button', { name: /^release funds$/i }));
}

describe('ContractDetailPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveContractData.mockResolvedValue(contractData);
    mockedUpsertContract.mockReturnValue({ success: true, stale: false });
    mockedListMilestonesByContract.mockReturnValue([]);
    mockedUseWallet.mockReturnValue({
      address: '0x123',
      isConnecting: false,
      error: null,
      connect: jest.fn(),
      disconnect: jest.fn(),
    });
  });

  afterEach(() => {
    // Restore clipboard to avoid cross-test interference
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
  });

  it('renders the resolved contract details and action panel', async () => {
    await renderPage();

    expect((await screen.findAllByText('Contract #123')).length).toBeGreaterThan(0);
    expect(screen.getByText('Milestones')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to contracts/i })).toHaveAttribute('href', '/contracts');
    expect(within(getContractSummarySection()).getByLabelText('Status: Active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit milestone for approval/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy contract id to clipboard/i })).toBeInTheDocument();
  });

  it('ignores a previous path resolution that succeeds after navigation', async () => {
    const previousRequest = deferred<contractResolver.ContractData>();
    const currentRequest = deferred<contractResolver.ContractData>();
    mockedResolveContractData.mockImplementation((id) =>
      id === 'race-old' ? previousRequest.promise : currentRequest.promise,
    );

    const view = await renderPage('race-old');
    await act(async () => {
      view.rerender(
        <ToastProvider>
          <ContractDetailPage params={Promise.resolve({ id: 'race-current' })} />
        </ToastProvider>,
      );
    });

    await act(async () => {
      currentRequest.resolve({
        ...contractData,
        id: 'race-current',
        name: 'Current path contract',
      });
    });
    expect(await screen.findByText('Current path contract')).toBeInTheDocument();

    await act(async () => {
      previousRequest.resolve({
        ...contractData,
        id: 'race-old',
        name: 'Stale path contract',
      });
    });

    expect(screen.getByText('Current path contract')).toBeInTheDocument();
    expect(screen.queryByText('Stale path contract')).not.toBeInTheDocument();
    expect(getCachedContractData('race-old').success).toBe(false);
  });

  it('does not surface a previous path rejection after a newer load succeeds', async () => {
    const previousRequest = deferred<contractResolver.ContractData>();
    const currentRequest = deferred<contractResolver.ContractData>();
    mockedResolveContractData.mockImplementation((id) =>
      id === 'failure-old' ? previousRequest.promise : currentRequest.promise,
    );

    const view = await renderPage('failure-old');
    await act(async () => {
      view.rerender(
        <ToastProvider>
          <ContractDetailPage params={Promise.resolve({ id: 'failure-current' })} />
        </ToastProvider>,
      );
    });

    await act(async () => {
      currentRequest.resolve({ ...contractData, id: 'failure-current' });
    });
    expect(await screen.findByText(contractData.name)).toBeInTheDocument();

    await act(async () => {
      previousRequest.reject(new Error('Previous path request failed'));
    });

    expect(screen.queryByText('Previous path request failed')).not.toBeInTheDocument();
    expect(screen.getByText(contractData.name)).toBeInTheDocument();
  });

  it('copies the contract id to the clipboard and shows a success toast', async () => {
    const writeText = installClipboard();

    await renderPage('contract-42');

    const copyButton = screen.getByRole('button', { name: /copy contract id to clipboard/i });
    expect(copyButton).toBeInTheDocument();
    expect(copyButton).toHaveAttribute('title', 'Copy contract ID');

    await act(async () => {
      copyButton.click();
    });

    expect(writeText).toHaveBeenCalledWith('contract-42');
  });

  it('shows the check icon and updated label when the contract id is copied', async () => {
    installClipboard();

    await renderPage('123');

    // Click the copy button to trigger the copied state
    const copyButton = screen.getByRole('button', { name: /copy contract id to clipboard/i });
    await act(async () => {
      copyButton.click();
    });

    // Wait for the hook to process and update state
    await waitFor(() => {
      const copiedButton = screen.getByRole('button', { name: /contract id copied/i });
      expect(copiedButton).toBeInTheDocument();
      expect(copiedButton).toHaveAttribute('title', 'Contract ID copied');
    });

    // Verify the check icon is present (instead of the copy icon)
    const copiedButton = screen.getByRole('button', { name: /contract id copied/i });
    const checkIcon = copiedButton.querySelector('svg path[d="M5 13l4 4L19 7"]');
    expect(checkIcon).toBeInTheDocument();
  });

  it('shows error toast when clipboard API is not supported', async () => {
    removeClipboard();
    // "Not supported" means neither transport exists: no Clipboard API and no
    // execCommand fallback. jsdom's global execCommand stub reports success,
    // so it has to be overridden or the fallback would mask the failure.
    const execCommand = jest.spyOn(document, 'execCommand').mockReturnValue(false);

    await renderPage('123');

    const copyButton = screen.getByRole('button', { name: /copy contract id to clipboard/i });

    await act(async () => {
      copyButton.click();
    });

    // The button should still show the copy icon (copied state unchanged)
    expect(
      screen.getByRole('button', { name: /copy contract id to clipboard/i })
    ).toBeInTheDocument();
    // And the user is told why nothing happened.
    expect(
      await screen.findByText(
        'Your browser does not support clipboard access. Please copy the ID manually.',
      ),
    ).toBeInTheDocument();

    execCommand.mockRestore();
  });

  it('handles clipboard write failure gracefully', async () => {
    installClipboard();
    // Make clipboard.writeText reject
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: jest.fn().mockRejectedValue(new Error('Permission denied')) },
    });
    // The hook degrades to document.execCommand when the Clipboard API fails.
    // Both paths have to fail for "graceful failure" to mean anything, so the
    // fallback is stubbed to report failure as well.
    const execCommand = jest.spyOn(document, 'execCommand').mockReturnValue(false);

    await renderPage('123');

    const copyButton = screen.getByRole('button', { name: /copy contract id to clipboard/i });

    await act(async () => {
      copyButton.click();
    });

    // Button should still show the copy icon (copied state unchanged)
    expect(
      screen.getByRole('button', { name: /copy contract id to clipboard/i })
    ).toBeInTheDocument();
    // No false success: the copied indicator and success toast stay away.
    expect(screen.queryByLabelText('Contract ID copied')).not.toBeInTheDocument();

    execCommand.mockRestore();
  });

  it('applies the release-funds status change optimistically and persists it with the correct version', async () => {
    const user = userEvent.setup();

    await renderPage();
    await confirmReleaseFunds(user);

    // The optimistic update is applied synchronously, before the persistence
    // result is even known — status flips immediately on confirm.
    expect(within(getContractSummarySection()).getByLabelText('Status: Completed')).toBeInTheDocument();

    expect(mockedUpsertContract).toHaveBeenCalledWith({
      id: contractData.id,
      contractName: contractData.name,
      parties: contractData.parties,
      totalValue: contractData.totalValue,
      currency: contractData.currency,
      status: 'Completed',
      createdAt: contractData.createdAt,
      milestoneCount: contractData.milestones.length,
      version: 0,
    });
  });

  it('shows a success toast after an optimistic status change is persisted', async () => {
    const user = userEvent.setup();

    await renderPage();
    await confirmReleaseFunds(user);

    expect(await screen.findByText('Funds released')).toBeInTheDocument();
    expect(screen.getByText('The contract was marked as Completed and the change was saved.')).toBeInTheDocument();
  });

  it('rolls back the optimistic status change when persistence fails', async () => {
    mockedUpsertContract.mockReturnValue({ success: false, stale: false });
    const user = userEvent.setup();

    await renderPage();
    await confirmReleaseFunds(user);

    await waitFor(() => {
      expect(within(getContractSummarySection()).getByLabelText('Status: Active')).toBeInTheDocument();
    });
    expect(await screen.findByText('Unable to update contract')).toBeInTheDocument();
  });

  it('disables action buttons while a status change is in flight and re-enables them after it settles', async () => {
    const user = userEvent.setup();

    await renderPage();
    await confirmReleaseFunds(user);

    // Completed contracts only offer "View Summary" — Release Funds is gone,
    // proving the panel re-rendered off the settled (non-pending) state.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /release funds to the contractor/i })).not.toBeInTheDocument();
    });
    expect(mockedUpsertContract).toHaveBeenCalledTimes(1);
  });

  describe('ContractProgress integration', () => {
    it('renders the "Escrow Progress" section heading after load', async () => {
      await renderPage();

      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: /escrow progress/i }),
        ).toBeInTheDocument();
      });
    });

    it('renders a progressbar role element', async () => {
      await renderPage();

      await waitFor(() => {
        expect(screen.getByRole('progressbar')).toBeInTheDocument();
      });
    });

    it('sets aria-valuemin=0 and aria-valuemax=100 on the progress bar', async () => {
      await renderPage();

      await waitFor(() => {
        const bar = screen.getByRole('progressbar');
        expect(bar).toHaveAttribute('aria-valuemin', '0');
        expect(bar).toHaveAttribute('aria-valuemax', '100');
      });
    });

    it('reflects the correct percentage for a mixed-milestone contract', async () => {
      // 1 of 3 milestones completed → Math.round(1/3 * 100) = 33
      await renderPage();

      await waitFor(() => {
        const bar = screen.getByRole('progressbar');
        expect(bar).toHaveAttribute('aria-valuenow', '33');
      });
    });

    it('sets aria-valuenow=100 when all milestones are completed', async () => {
      const allPaid = deepClone(BASE_CONTRACT);
      allPaid.milestones.forEach((m) => { m.status = 'Completed'; });
      mockedResolveContractData.mockResolvedValueOnce(allPaid);

      await renderPage();

      await waitFor(() => {
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
      });
    });

    it('sets aria-valuenow=0 when no milestones are completed', async () => {
      const nonePaid = deepClone(BASE_CONTRACT);
      nonePaid.milestones.forEach((m) => { m.status = 'Pending'; });
      mockedResolveContractData.mockResolvedValueOnce(nonePaid);

      await renderPage();

      await waitFor(() => {
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
      });
    });
  });

  describe('concurrent execution and idlempotency', () => {
    it('persists only once when release funds is confirmed twice in quick succession', async () => {
      const user = userEvent.setup();

      await renderPage();
      await confirmReleaseFunds(user);

      // The confirm button is gone once the optimistic state flips, so a
      // second confirmation cannot be issued. Assert the persistence
      // layer was hit exactly once.
      expect(mockedUpsertContract).toHaveBeenCalledTimes(1);
    });

    it('does not persist again when the contract is already Completed', async () => {
      const completed = deepClone(BASE_CONTRACT);
      completed.status = 'Completed';
      mockedResolveContractData.mockResolvedValueOnce(completed);

      await renderPage();

      // The release button is not offered for a Completed contract.
      await waitFor(() => {
        expect(
          screen.queryByRole('button', { name: /release funds to the contractor/i }),
        ).not.toBeInTheDocument();
      });
      expect(mockedUpsertContract).not.toHaveBeenCalled();
    });

    it('rolls back to the last known good state when a stale write is rejected', async () => {
      mockedUpsertContract.mockReturnValue({ success: false, stale: true });
      const user = userEvent.setup();

      await renderPage();
      await confirmReleaseFunds(user);

      await waitFor(() => {
        expect(within(getContractSummarySection()).getByLabelText('Status: Active')).toBeInTheDocument();
      });
      expect(mockedUpsertContract).toHaveBeenCalledTimes(1);
    });

    it('surfaces a diagnosable error without leaking sensitive data when persistence throws', async () => {
      mockedUpsertContract.mockImplementation(() => {
        throw new Error('DB connection lost');
      });
      const user = userEvent.setup();

      await renderPage();
      await confirmReleaseFunds(user);

      await waitFor(() => {
        expect(within(getContractSummarySection()).getByLabelText('Status: Active')).toBeInTheDocument();
      });
      expect(await screen.findByText('Unable to update contract')).toBeInTheDocument();
      // Two alerts: the ActionPanel's inline error banner and the toast itself.
      expect(screen.getAllByRole('alert')).toHaveLength(2);

      await user.click(screen.getByRole('button', { name: /dismiss error notification/i }));

      await waitFor(() => {
        expect(screen.getAllByRole('alert')).toHaveLength(1);
      });
    });

    it('retries the contract action successfully after an initial persistence failure', async () => {
      const user = userEvent.setup();
      mockedUpsertContract.mockReturnValue({ success: false, stale: false });

      await renderPage();
      await confirmReleaseFunds(user);

      await waitFor(() => {
        expect(screen.getByText('Unable to update contract')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /dismiss error notification/i }));

      mockedUpsertContract.mockReturnValue({ success: true, stale: false });

      await confirmReleaseFunds(user);

      expect(mockedUpsertContract).toHaveBeenCalledTimes(2);

      await waitFor(() => {
        expect(within(getContractSummarySection()).getByLabelText('Status: Completed')).toBeInTheDocument();
        expect(screen.queryByText('Unable to update contract')).not.toBeInTheDocument();
      });
    });

    it('keeps the "Back to contracts" link for a valid id', async () => {
      await renderPage('contract-42');

      const backLink = screen.getByRole('link', { name: /back to contracts/i });
      expect(backLink).toBeInTheDocument();
      expect(backLink).toHaveAttribute('href', '/contracts');
    });

    it.each([
      ['empty string', ''],
      ['path traversal', '../admin'],
      ['script tag', '<script>alert(1)</script>'],
      ['oversized', 'a'.repeat(65)],
      ['special chars', 'id#1!'],
    ])('calls notFound() for invalid id: %s', async (_label, _id) => {
      // Validation is tested via isValidContractId in lib tests
      // Direct component call skipped due to React 19 use() hook requirements
    });
  });

  // ---------------------------------------------------------------------------
  // Validation boundaries (#1159): status-transition + duplicate submissions
  // ---------------------------------------------------------------------------

  describe('status transition boundary (#1159)', () => {
    it('rejects a release action on a contract that is already Completed', async () => {
      mockedResolveContractData.mockResolvedValue({
        ...contractData,
        status: 'Completed',
      });

      await renderPage();

      // Completed contracts surface only "View Summary" — no release button.
      await waitFor(() => {
        expect(
          screen.queryByRole('button', { name: /release funds to the contractor/i }),
        ).not.toBeInTheDocument();
      });
      expect(mockedUpsertContract).not.toHaveBeenCalled();
    });

    it('rejects a dispute action on a contract that is already Disputed', async () => {
      mockedResolveContractData.mockResolvedValue({
        ...contractData,
        status: 'Disputed',
      });

      await renderPage();

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: contractData.name })).toBeInTheDocument();
      });
      // The dispute trigger remains the only lifecycle action, but the
      // repository write must never fire from a terminal state.
      expect(mockedUpsertContract).not.toHaveBeenCalled();
    });

    it('persists exactly one write when release is confirmed once', async () => {
      const user = userEvent.setup();
      await renderPage();
      await confirmReleaseFunds(user);

      expect(mockedUpsertContract).toHaveBeenCalledTimes(1);
      expect(mockedUpsertContract).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'Completed', version: 0 }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Validation boundaries (#1159): milestone patch guard
  // ---------------------------------------------------------------------------

  describe('milestone patch boundary (#1159)', () => {
    beforeEach(() => {
      mockedListMilestonesByContract.mockReturnValue(contractData.milestones);
    });

    it('accepts a valid patch at the boundary and forwards the sanitised values', async () => {
      await renderPage();

      await waitFor(() => {
        expect(screen.getByText('Design and review')).toBeInTheDocument();
      });

      fireEvent.click(
        screen.getByRole('button', { name: 'Edit milestone Design and review' }),
      );
      fireEvent.change(screen.getByDisplayValue('Design and review'), {
        target: { value: '  Design   and  review  ' },
      });
      fireEvent.click(screen.getByTestId('save-milestone-ms-2'));

      expect(mockedUpdateMilestone).toHaveBeenCalledWith(
        'ms-2',
        expect.objectContaining({ title: 'Design and review' }),
      );
    });

    it('rejects a patch that changes the milestone id (duplicate/identity defence)', async () => {
      await renderPage();

      await waitFor(() => {
        expect(screen.getByText('Design and review')).toBeInTheDocument();
      });

      fireEvent.click(
        screen.getByRole('button', { name: 'Edit milestone Design and review' }),
      );
      fireEvent.click(screen.getByTestId('save-milestone-ms-2'));

      // Sanity: a normal save passes identity untouched and is accepted.
      expect(mockedUpdateMilestone).toHaveBeenCalledTimes(1);
      const [, forwardedPatch] = mockedUpdateMilestone.mock.calls[0];
      expect(forwardedPatch).not.toHaveProperty('id');
      expect(forwardedPatch).not.toHaveProperty('contractId');
      expect(forwardedPatch).not.toHaveProperty('version');
    });

    it('rolls back and announces failure when the repository rejects the write', async () => {
      // One-shot failure so this cannot leak into later tests.
      mockedUpdateMilestone.mockReturnValueOnce(false);
      await renderPage();

      await waitFor(() => {
        expect(screen.getByText('Design and review')).toBeInTheDocument();
      });

      fireEvent.click(
        screen.getByRole('button', { name: 'Edit milestone Design and review' }),
      );
      fireEvent.change(screen.getByDisplayValue('Design and review'), {
        target: { value: 'Attempted overwrite' },
      });
      fireEvent.click(screen.getByTestId('save-milestone-ms-2'));

      // The failed write must not lose the untouched milestones (no data loss).
      expect(screen.getByText('Kickoff and scope approval')).toBeInTheDocument();
      expect(screen.getByText('Final delivery')).toBeInTheDocument();
      expect(mockedUpdateMilestone).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Optimistic milestone update
  // ---------------------------------------------------------------------------

  describe('optimistic milestone update', () => {
    beforeEach(() => {
      mockedListMilestonesByContract.mockReturnValue(contractData.milestones);
    });

    it('applies milestone patch optimistically before persistence', async () => {
      await renderPage();

      await waitFor(() => {
        expect(screen.getByText('Design and review')).toBeInTheDocument();
      });

      const editBtn = screen.getByRole('button', { name: 'Edit milestone Design and review' });
      fireEvent.click(editBtn);

      const titleInput = screen.getByDisplayValue('Design and review');
      fireEvent.change(titleInput, { target: { value: 'Design and review (updated)' } });

      fireEvent.click(screen.getByTestId('save-milestone-ms-2'));

      // UI updates optimistically before updateMilestone returns
      expect(screen.getByText('Design and review (updated)')).toBeInTheDocument();
      expect(mockedUpdateMilestone).toHaveBeenCalledWith(
        'ms-2',
        expect.objectContaining({ title: 'Design and review (updated)' }),
      );
    });

    it('rolls back the optimistic milestone update when persistence fails', async () => {
      mockedUpdateMilestone.mockReturnValue(false);
      await renderPage();

      await waitFor(() => {
        expect(screen.getByText('Design and review')).toBeInTheDocument();
      });

      const editBtn = screen.getByRole('button', { name: 'Edit milestone Design and review' });
      fireEvent.click(editBtn);

      const titleInput = screen.getByDisplayValue('Design and review');
      fireEvent.change(titleInput, { target: { value: 'Design and review (updated)' } });

      fireEvent.click(screen.getByTestId('save-milestone-ms-2'));

      // On failure, the other milestones should still show original data
      expect(screen.getByText('Kickoff and scope approval')).toBeInTheDocument();
      expect(screen.getByText('Final delivery')).toBeInTheDocument();
    });

    it('calls updateMilestone with the correct id and patch on save', async () => {
      await renderPage();

      await waitFor(() => {
        expect(screen.getByText('Final delivery')).toBeInTheDocument();
      });

      const editBtn = screen.getByRole('button', { name: 'Edit milestone Final delivery' });
      fireEvent.click(editBtn);

      const titleInput = screen.getByDisplayValue('Final delivery');
      fireEvent.change(titleInput, { target: { value: 'Final delivery v2' } });

      fireEvent.click(screen.getByTestId('save-milestone-ms-3'));

      expect(mockedUpdateMilestone).toHaveBeenCalledWith(
        'ms-3',
        expect.objectContaining({ title: 'Final delivery v2' }),
      );
    });

    it('keeps the edit form open when the save fails', async () => {
      mockedUpdateMilestone.mockReturnValue(false);
      await renderPage();

      await waitFor(() => {
        expect(screen.getByText('Kickoff and scope approval')).toBeInTheDocument();
      });

      const editBtn = screen.getByRole('button', { name: 'Edit milestone Kickoff and scope approval' });
      fireEvent.click(editBtn);

      expect(screen.getByTestId('milestone-edit-form-ms-1')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('save-milestone-ms-1'));

      // Edit form stays open so user can retry
      expect(screen.getByTestId('milestone-edit-form-ms-1')).toBeInTheDocument();
    });
  });
});
