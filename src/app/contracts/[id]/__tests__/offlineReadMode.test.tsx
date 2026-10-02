import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import ContractDetailPage from '../page';
import * as contractResolver from '@/lib/contractResolver';
import { useWallet } from '@/contexts/WalletContext';
import { ToastProvider } from '@/components/toast/toast-provider';
import {
  cacheContractData,
  clearContractCache,
  CONTRACT_CACHE_KEY,
  STALE_THRESHOLD_MS,
} from '@/lib/contractCache';

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
const mockedUseWallet = useWallet as jest.MockedFunction<typeof useWallet>;

const testContract: contractResolver.ContractData = {
  id: 'contract-offline-123',
  name: 'Offline Test Contract',
  status: 'Active',
  parties: [
    { label: 'Client', address: 'GCLIENT123456789012345678901234567890123456789012' },
    { label: 'Freelancer', address: 'GFREELANCER1234567890123456789012345678901234567890' },
  ],
  totalValue: 12000,
  currency: 'USDC',
  createdAt: '2026-08-15T10:00:00Z',
  updatedAt: '2026-08-15T10:00:00Z',
  milestones: [
    {
      id: 'ms-offline-1',
      title: 'Initial Discovery',
      status: 'Pending',
      payout: 4000,
      currency: 'USDC',
      dueDate: '2026-09-01',
    },
    {
      id: 'ms-offline-2',
      title: 'Implementation',
      status: 'Pending',
      payout: 8000,
      currency: 'USDC',
      dueDate: '2026-10-01',
    },
  ],
};

async function renderContractPage(id = 'contract-offline-123') {
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

describe('ContractDetailPage - Offline Read Mode Requirements (#1131)', () => {
  const originalOnLine = navigator.onLine;

  beforeEach(() => {
    clearContractCache();
    window.localStorage.clear();
    jest.clearAllMocks();

    mockedUseWallet.mockReturnValue({
      address: 'GCLIENT123456789012345678901234567890123456789012',
      isConnecting: false,
      error: null,
      connect: jest.fn(),
      disconnect: jest.fn(),
    });

    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: originalOnLine,
    });
  });

  // ---------------------------------------------------------------------------
  // Edge Case 1: offline on first load
  // ---------------------------------------------------------------------------
  describe('Edge Case 1: offline on first load', () => {
    it('shows a clear offline error state when visiting an uncached contract while offline', async () => {
      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        value: false,
      });

      mockedResolveContractData.mockRejectedValue(new Error('Network error: offline'));

      await renderContractPage('contract-offline-123');

      // The offline indicator should be present
      expect(
        screen.getByText('You are offline. Showing previously loaded data.'),
      ).toBeInTheDocument();

      // Clear informative error message in the ActionPanel alert
      expect(
        screen.getByText(
          'You are offline and this contract has not been loaded before. Please connect to the internet and try again.',
        ),
      ).toBeInTheDocument();

      // Mutation actions are disabled
      const submitBtn = screen.getByRole('button', { name: /submit milestone/i });
      expect(submitBtn).toBeDisabled();
    });
  });

  // ---------------------------------------------------------------------------
  // Edge Case 2: offline after data loaded
  // ---------------------------------------------------------------------------
  describe('Edge Case 2: offline after data loaded', () => {
    it('serves cached snapshot with offline indicator and disables unsafe mutations when offline', async () => {
      // Pre-seed cache with contract data
      cacheContractData(testContract.id, testContract);

      // Simulate offline environment
      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        value: false,
      });

      await renderContractPage(testContract.id);

      // Verify cached contract data is rendered
      expect(screen.getByRole('heading', { name: testContract.name })).toBeInTheDocument();
      expect(screen.getAllByText('Initial Discovery').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Implementation').length).toBeGreaterThanOrEqual(1);

      // Offline indicator banner is visible
      expect(
        screen.getByText('You are offline. Showing previously loaded data.'),
      ).toBeInTheDocument();

      // Unsafe mutations are disabled
      const submitBtn = screen.getByRole('button', { name: /submit milestone/i });
      const releaseBtn = screen.getByRole('button', { name: /release funds/i });
      const disputeBtn = screen.getByRole('button', { name: /dispute/i });

      expect(submitBtn).toBeDisabled();
      expect(releaseBtn).toBeDisabled();
      expect(disputeBtn).toBeDisabled();
    });

    it('blocks milestone edits with a clear error toast when offline', async () => {
      cacheContractData(testContract.id, testContract);

      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        value: false,
      });

      await renderContractPage(testContract.id);

      // Find the first milestone row and attempt to trigger update
      const editButton = screen.getAllByRole('button', { name: /edit/i })[0];
      if (editButton) {
        await act(async () => {
          fireEvent.click(editButton);
        });

        const saveButton = screen.queryByRole('button', { name: /save/i });
        if (saveButton) {
          await act(async () => {
            fireEvent.click(saveButton);
          });
          expect(
            screen.getByText('Cannot update milestone while offline'),
          ).toBeInTheDocument();
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Edge Case 3: stale snapshot
  // ---------------------------------------------------------------------------
  describe('Edge Case 3: stale snapshot', () => {
    it('marks snapshot as stale when older than threshold and shows cached time', async () => {
      const pastTime = new Date(Date.now() - (STALE_THRESHOLD_MS + 60000)).toISOString();
      const rawStore = {
        schemaVersion: 1,
        entries: [
          {
            contractId: testContract.id,
            data: testContract,
            version: 1,
            cachedAt: pastTime,
          },
        ],
      };
      window.localStorage.setItem(CONTRACT_CACHE_KEY, JSON.stringify(rawStore));

      // Online but network fetch fails, so falls back to stale cache
      mockedResolveContractData.mockRejectedValue(new Error('Network gateway timeout'));

      await renderContractPage(testContract.id);

      // Stale data warning banner is displayed. The page burns its bounded
      // retry budget (300ms + 600ms of backoff) before falling back to cache,
      // so the banner only appears after those attempts have been exhausted.
      await waitFor(
        () => {
          expect(
            screen.getByText('This data may be outdated. Last updated recently.'),
          ).toBeInTheDocument();
        },
        { timeout: 5000 },
      );

      // Mutation buttons disabled due to stale data
      const submitBtn = screen.getByRole('button', { name: /submit milestone/i });
      expect(submitBtn).toBeDisabled();

      // Milestone edit is blocked on stale data
      const editButton = screen.getAllByRole('button', { name: /edit/i })[0];
      if (editButton) {
        await act(async () => {
          fireEvent.click(editButton);
        });

        const saveButton = screen.queryByRole('button', { name: /save/i });
        if (saveButton) {
          await act(async () => {
            fireEvent.click(saveButton);
          });
          expect(
            screen.getByText('Cannot update stale data'),
          ).toBeInTheDocument();
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Edge Case 4: cache corrupt
  // ---------------------------------------------------------------------------
  describe('Edge Case 4: cache corrupt', () => {
    it('handles corrupted localStorage JSON gracefully without crashing', async () => {
      window.localStorage.setItem(CONTRACT_CACHE_KEY, 'corrupt-non-json-data{{');

      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        value: false,
      });

      await renderContractPage(testContract.id);

      // Renders clean offline message instead of crashing
      expect(
        screen.getByText(
          'You are offline and this contract has not been loaded before. Please connect to the internet and try again.',
        ),
      ).toBeInTheDocument();
    });

    it('handles malformed schema structure in localStorage gracefully', async () => {
      window.localStorage.setItem(
        CONTRACT_CACHE_KEY,
        JSON.stringify({ schemaVersion: 999, entries: 'not-an-array' }),
      );

      mockedResolveContractData.mockResolvedValue(testContract);

      await renderContractPage(testContract.id);

      // Loads successfully from resolver online, ignoring corrupted cache
      expect(screen.getByRole('heading', { name: testContract.name })).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Edge Case 5: connection returns
  // ---------------------------------------------------------------------------
  describe('Edge Case 5: connection returns', () => {
    it('automatically re-validates fresh data and re-enables mutations when online event is dispatched', async () => {
      // Start offline with cached data
      cacheContractData(testContract.id, testContract);

      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        value: false,
      });

      const updatedContractOnline: contractResolver.ContractData = {
        ...testContract,
        name: 'Refreshed Online Contract Name',
        totalValue: 15000,
      };
      mockedResolveContractData.mockResolvedValue(updatedContractOnline);

      await renderContractPage(testContract.id);

      // Initially shows cached contract name and offline status
      expect(screen.getByRole('heading', { name: testContract.name })).toBeInTheDocument();
      expect(
        screen.getByText('You are offline. Showing previously loaded data.'),
      ).toBeInTheDocument();

      // Connection is restored
      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        value: true,
      });

      await act(async () => {
        window.dispatchEvent(new Event('online'));
      });

      // Contract details are updated with fresh online data
      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: 'Refreshed Online Contract Name' }),
        ).toBeInTheDocument();
      });

      // Offline indicator is hidden
      expect(
        screen.queryByText('You are offline. Showing previously loaded data.'),
      ).toBeNull();

      // Mutation buttons are enabled again
      const submitBtn = screen.getByRole('button', { name: /submit milestone/i });
      expect(submitBtn).not.toBeDisabled();
    });
  });

  // ---------------------------------------------------------------------------
  // Successful online cache write
  // ---------------------------------------------------------------------------
  describe('online caching behavior', () => {
    it('automatically caches fresh data when resolved successfully online', async () => {
      mockedResolveContractData.mockResolvedValue(testContract);

      await renderContractPage(testContract.id);

      expect(screen.getByRole('heading', { name: testContract.name })).toBeInTheDocument();

      // Storage should now contain the cached contract
      const raw = window.localStorage.getItem(CONTRACT_CACHE_KEY);
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed.entries.some((e: any) => e.contractId === testContract.id)).toBe(true);
    });
  });
});
