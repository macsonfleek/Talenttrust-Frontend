import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ContractRow } from '../ContractRow';
import type { Contract } from '@/types/domain';

const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();

jest.mock('@/components/toast/toast-provider', () => ({
  useToast: () => ({
    showSuccess: mockShowSuccess,
    showError: mockShowError,
  }),
}));

const mockContract: Contract = {
  id: 'contract-id-12345',
  contractName: 'Test Contract',
  status: 'Pending',
  createdAt: 'Jan 1, 2026',
  parties: [],
  totalValue: 1000,
  currency: 'USD',
  milestoneCount: 0,
};

describe('ContractRow', () => {
  let originalClipboard: any;

  beforeAll(() => {
    originalClipboard = global.navigator.clipboard;
  });

  afterAll(() => {
    Object.defineProperty(global.navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders contract details correctly', () => {
    render(<ContractRow contract={mockContract} />);
    expect(screen.getByText('Test Contract')).toBeInTheDocument();
    expect(screen.getByText(/Pending · Created Jan 1, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/contra...2345/)).toBeInTheDocument();
  });

  it('copies the ID to the clipboard on success and shows success toast', async () => {
    const writeTextMock = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(global.navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
    });

    render(<ContractRow contract={mockContract} />);
    const copyButton = screen.getByRole('button', { name: `Copy contract ID ${mockContract.id}` });
    
    fireEvent.click(copyButton);
    
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(mockContract.id);
      expect(mockShowSuccess).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'ID copied' })
      );
    });

    // Check accessible name changed
    expect(screen.getByRole('button', { name: 'Contract ID copied' })).toBeInTheDocument();
  });

  it('shows error toast when clipboard throws (fallback)', async () => {
    const writeTextMock = jest.fn().mockRejectedValue(new Error('clipboard error'));
    Object.defineProperty(global.navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
    });

    // Force the fallback to fail as well: with both copy paths unavailable the
    // hook must report a failure. The global execCommand stub succeeds, so
    // without this the success path would be taken and this assertion would
    // never be reached.
    jest.spyOn(document, 'execCommand').mockReturnValue(false);

    render(<ContractRow contract={mockContract} />);
    const copyButton = screen.getByRole('button', { name: `Copy contract ID ${mockContract.id}` });
    
    fireEvent.click(copyButton);
    
    await waitFor(() => {
      expect(mockShowError).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Copy failed' })
      );
    });
  });

  it('shows error toast when clipboard API is missing (fallback)', async () => {
    Object.defineProperty(global.navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });

    render(<ContractRow contract={mockContract} />);
    const copyButton = screen.getByRole('button', { name: `Copy contract ID ${mockContract.id}` });
        // Force the fallback to fail as well: with both copy paths unavailable the
    // hook must report a failure. The global execCommand stub succeeds, so
    // without this the success path would be taken and this assertion would
    // never be reached.
    jest.spyOn(document, 'execCommand').mockReturnValue(false);

    fireEvent.click(copyButton);
    
    await waitFor(() => {
      expect(mockShowError).toHaveBeenCalled();
    });
  });

  it('falls back to contractName if id is missing', async () => {
    const contractWithoutId = { ...mockContract, id: undefined } as unknown as Contract;
    
    const writeTextMock = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(global.navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
    });

    render(<ContractRow contract={contractWithoutId} />);
    
    const copyButton = screen.getByRole('button', { name: `Copy contract ID ${contractWithoutId.contractName}` });
    fireEvent.click(copyButton);
    
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(contractWithoutId.contractName);
    });
  });
});
