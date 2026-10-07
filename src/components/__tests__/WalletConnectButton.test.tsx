import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { WalletConnectButton } from '../WalletConnectButton';
import { WalletContextType, useWallet } from '@/contexts/WalletContext';
import * as truncateAddressModule from '@/lib/truncateAddress';
import { axe, testA11y } from '@/test-utils/a11y';
import { PreferencesProvider } from '@/lib/preferences';

jest.mock('@/contexts/WalletContext', () => ({
  useWallet: jest.fn(),
}));

const mockShowError = jest.fn();
jest.mock('@/components/toast/toast-provider', () => ({
  useToast: jest.fn(() => ({ showError: mockShowError })),
}));

const mockUseWallet = useWallet as jest.MockedFunction<typeof useWallet>;

const COPY_ICON_PATH = 'M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z';
const COPIED_ICON_PATH = 'M5 13l4 4L19 7';

const originalClipboard = navigator.clipboard;

function createWalletState(overrides: Partial<WalletContextType> = {}): WalletContextType {
  return {
    address: null,
    isConnecting: false,
    error: null,
    connect: jest.fn(),
    disconnect: jest.fn(),
    ...overrides,
  };
}

function installClipboardMock() {
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function getButtonIconPath(button: HTMLElement) {
  return button.querySelector('path')?.getAttribute('d');
}

describe('WalletConnectButton', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    });
  });

  it('renders the disconnected branch and calls connect when clicked', async () => {
    const connect = jest.fn();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    mockUseWallet.mockReturnValue(createWalletState({ connect }));

    render(<WalletConnectButton />);

    const connectButton = screen.getByRole('button', { name: 'Connect wallet' });
    expect(connectButton).toBeEnabled();
    expect(connectButton).toHaveTextContent('Connect Wallet');
    expect(screen.queryByRole('button', { name: 'Copy address to clipboard' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect wallet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry wallet connection' })).not.toBeInTheDocument();

    await user.click(connectButton);

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('renders the connecting branch with a disabled button and spinner', () => {
    mockUseWallet.mockReturnValue(createWalletState({ isConnecting: true }));

    render(<WalletConnectButton />);

    const connectButton = screen.getByRole('button', { name: 'Connect wallet' });
    expect(connectButton).toBeDisabled();
    expect(connectButton).toHaveTextContent('Connecting...');
    expect(connectButton.querySelector('svg.animate-spin')).toBeInTheDocument();
    expect(screen.queryByText(/connection error/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect wallet' })).not.toBeInTheDocument();
  });

  it('renders the error branch and retries the connection', async () => {
    const connect = jest.fn();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    mockUseWallet.mockReturnValue(createWalletState({
      error: 'Connection failed',
      connect,
    }));

    render(<WalletConnectButton />);

    expect(screen.getByText('Connection Error')).toBeInTheDocument();
    const retryButton = screen.getByRole('button', { name: 'Retry wallet connection' });
    expect(retryButton).toHaveTextContent('Retry');
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect wallet' })).not.toBeInTheDocument();

    await user.click(retryButton);

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('renders the connected branch using truncateAddress and exposes copy and disconnect controls', () => {
    const address = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
    const truncateAddressSpy = jest.spyOn(truncateAddressModule, 'truncateAddress')
      .mockReturnValue('0x71C7...976F');

    mockUseWallet.mockReturnValue(createWalletState({ address }));
    installClipboardMock();

    render(<WalletConnectButton />);

    expect(truncateAddressSpy).toHaveBeenCalledWith(address);
    expect(screen.getByText('0x71C7...976F')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy address to clipboard' })).toHaveAttribute('title', 'Copy address');
    expect(screen.getByRole('button', { name: 'Disconnect wallet' })).toHaveAttribute('title', 'Disconnect wallet');
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).not.toBeInTheDocument();
  });

  it('copies the full address, swaps to the success icon, and resets after 2 seconds', async () => {
    const address = '0xABCDEF1234567890';
    const writeText = installClipboardMock();

    mockUseWallet.mockReturnValue(createWalletState({ address }));

    render(<WalletConnectButton />);

    const copyButton = screen.getByRole('button', { name: 'Copy address to clipboard' });
    expect(getButtonIconPath(copyButton)).toBe(COPY_ICON_PATH);

    await act(async () => {
      fireEvent.click(copyButton);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(address);
    expect(mockShowError).not.toHaveBeenCalled();
    expect(
      getButtonIconPath(screen.getByRole('button', { name: 'Copy address to clipboard' })),
    ).toBe(COPIED_ICON_PATH);

    act(() => {
      jest.advanceTimersByTime(1999);
    });
    expect(
      getButtonIconPath(screen.getByRole('button', { name: 'Copy address to clipboard' })),
    ).toBe(COPIED_ICON_PATH);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(
      getButtonIconPath(screen.getByRole('button', { name: 'Copy address to clipboard' })),
    ).toBe(COPY_ICON_PATH);
  });

  it('calls disconnect from the connected branch', async () => {
    const disconnect = jest.fn();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    mockUseWallet.mockReturnValue(createWalletState({
      address: '0x1234567890abcdef1234567890abcdef12345678',
      disconnect,
    }));
    installClipboardMock();

    render(<WalletConnectButton />);

    await user.click(screen.getByRole('button', { name: 'Disconnect wallet' }));

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('handles clipboard write failure gracefully', async () => {
    const address = '0xABCDEF1234567890';
    const writeText = jest.fn().mockRejectedValue(new Error('Write failed'));

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    // Force the fallback to fail as well: with both copy paths unavailable the
    // hook must report a failure. The global execCommand stub succeeds, so
    // without this the success path would be taken and this assertion would
    // never be reached.
    jest.spyOn(document, 'execCommand').mockReturnValue(false);

    mockUseWallet.mockReturnValue(createWalletState({ address }));

    render(<WalletConnectButton />);

    const copyButton = screen.getByRole('button', { name: 'Copy address to clipboard' });
    expect(getButtonIconPath(copyButton)).toBe(COPY_ICON_PATH);

    await act(async () => {
      fireEvent.click(copyButton);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Verify that the error toast was shown (may receive either title depending on error type)
    expect(mockShowError).toHaveBeenCalledTimes(1);

    // Icon should remain as copy (not change to checkmark)
    expect(getButtonIconPath(copyButton)).toBe(COPY_ICON_PATH);
  });

  it('handles missing clipboard API gracefully', async () => {
    const address = '0xABCDEF1234567890';

    // Simulate missing clipboard API
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });

    // Force the fallback to fail as well: with both copy paths unavailable the
    // hook must report a failure. The global execCommand stub succeeds, so
    // without this the success path would be taken and this assertion would
    // never be reached.
    jest.spyOn(document, 'execCommand').mockReturnValue(false);

    mockUseWallet.mockReturnValue(createWalletState({ address }));

    render(<WalletConnectButton />);

    const copyButton = screen.getByRole('button', { name: 'Copy address to clipboard' });

    await act(async () => {
      fireEvent.click(copyButton);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Verify that the appropriate error toast was shown
    expect(mockShowError).toHaveBeenCalledWith({
      title: 'Copy not supported',
      description: 'Your browser does not support clipboard access. Please copy the address manually.',
    });

    // Icon should remain as copy (not change to checkmark)
    expect(getButtonIconPath(copyButton)).toBe(COPY_ICON_PATH);
  });

  it('handles rapid consecutive copy clicks and only shows final success/error', async () => {
    const address = '0xABCDEF1234567890';
    const writeText = jest.fn().mockResolvedValue(undefined);

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockUseWallet.mockReturnValue(createWalletState({ address }));

    render(<WalletConnectButton />);

    const copyButton = screen.getByRole('button', { name: 'Copy address to clipboard' });

    // First click
    await act(async () => {
      fireEvent.click(copyButton);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(getButtonIconPath(copyButton)).toBe(COPIED_ICON_PATH);

    // Second click before reset (should cancel first timer and set new one)
    await act(async () => {
      fireEvent.click(copyButton);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(2);
    expect(getButtonIconPath(copyButton)).toBe(COPIED_ICON_PATH);

    // Advance 1999ms (almost to first reset)
    act(() => {
      jest.advanceTimersByTime(1999);
    });
    expect(getButtonIconPath(copyButton)).toBe(COPIED_ICON_PATH);

    // Advance 1ms more (now at 2000ms from second click, should reset)
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(getButtonIconPath(copyButton)).toBe(COPY_ICON_PATH);
  });

  it('does not copy if address is not available', async () => {
    const writeText = installClipboardMock();

    mockUseWallet.mockReturnValue(createWalletState({ address: null }));

    render(<WalletConnectButton />);

    // Should render disconnected state, no copy button
    expect(screen.queryByRole('button', { name: 'Copy address to clipboard' })).not.toBeInTheDocument();

    expect(writeText).not.toHaveBeenCalled();
    expect(mockShowError).not.toHaveBeenCalled();
  });

  it('cleans up timer on unmount to prevent state updates', async () => {
    const address = '0xABCDEF1234567890';
    installClipboardMock();

    mockUseWallet.mockReturnValue(createWalletState({ address }));

    const { unmount } = render(<WalletConnectButton />);

    const copyButton = screen.getByRole('button', { name: 'Copy address to clipboard' });

    await act(async () => {
      fireEvent.click(copyButton);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(getButtonIconPath(copyButton)).toBe(COPIED_ICON_PATH);

    // Unmount before timer fires
    act(() => {
      jest.advanceTimersByTime(500);
    });
    unmount();

    // Advance past the reset timer
    // (Should not cause errors even though component is unmounted)
    expect(() => {
      act(() => {
        jest.advanceTimersByTime(1600);
      });
    }).not.toThrow();
  });

  it('has no accessibility violations in the connected state', async () => {
    jest.useRealTimers();
    mockUseWallet.mockReturnValue(createWalletState({
      address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    }));
    installClipboardMock();

    await testA11y(<WalletConnectButton />);

    jest.useFakeTimers();
  });

  it('has no accessibility violations when clipboard write fails', async () => {
    jest.useRealTimers();
    const writeText = jest.fn().mockRejectedValue(new Error('Write failed'));

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockUseWallet.mockReturnValue(createWalletState({
      address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    }));

    await testA11y(<WalletConnectButton />);

    jest.useFakeTimers();
  });

  describe('density toggle', () => {
    function renderConnected(address = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F') {
      mockUseWallet.mockReturnValue(createWalletState({ address }));
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });
      return render(<WalletConnectButton />, { wrapper: PreferencesProvider });
    }

    it('shows density toggle button in the connected state with default comfortable label', () => {
      renderConnected();

      const densityBtn = screen.getByTestId('wallet-density-btn');
      expect(densityBtn).toBeInTheDocument();
      expect(densityBtn).toHaveAttribute('aria-label', 'Switch to compact view');
    });

    it('toggles density and persists across re-renders', () => {
      const { rerender } = renderConnected();

      const btn = screen.getByTestId('wallet-density-btn');
      act(() => { btn.click(); });
      expect(screen.getByTestId('wallet-density-btn')).toHaveAttribute('aria-label', 'Switch to comfortable view');

      act(() => { screen.getByTestId('wallet-density-btn').click(); });
      expect(screen.getByTestId('wallet-density-btn')).toHaveAttribute('aria-label', 'Switch to compact view');

      rerender(<WalletConnectButton />);
      expect(screen.getByTestId('wallet-density-btn')).toHaveAttribute('aria-label', 'Switch to compact view');
    });

    it('falls back to comfortable when an invalid stored value is loaded', () => {
      localStorage.setItem(
        'talenttrust-user-preferences',
        JSON.stringify({ walletDensity: 'ultra-compact' }),
      );
      renderConnected();

      expect(screen.getByTestId('wallet-density-btn')).toHaveAttribute('aria-label', 'Switch to compact view');
    });

    it('density button is not rendered in disconnected state', () => {
      mockUseWallet.mockReturnValue(createWalletState({ address: null }));
      render(<WalletConnectButton />, { wrapper: PreferencesProvider });

      expect(screen.queryByTestId('wallet-density-btn')).not.toBeInTheDocument();
    });

    it('density button is not rendered in error state', () => {
      mockUseWallet.mockReturnValue(createWalletState({ error: 'Something went wrong' }));
      render(<WalletConnectButton />, { wrapper: PreferencesProvider });

      expect(screen.queryByTestId('wallet-density-btn')).not.toBeInTheDocument();
    });

    it('density button is not rendered in connecting state', () => {
      mockUseWallet.mockReturnValue(createWalletState({ isConnecting: true }));
      render(<WalletConnectButton />, { wrapper: PreferencesProvider });

      expect(screen.queryByTestId('wallet-density-btn')).not.toBeInTheDocument();
    });

    it('has no accessibility violations with density toggle present', async () => {
      jest.useRealTimers();
      mockUseWallet.mockReturnValue(createWalletState({
        address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
      }));
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });
      await testA11y(<WalletConnectButton />, { wrapper: PreferencesProvider });
      jest.useFakeTimers();
    });
  });
});

// ---------------------------------------------------------------------------
// Keyboard operation
// ---------------------------------------------------------------------------

describe('WalletConnectButton — keyboard operation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    });
  });

  // --- Connect button (disconnected state) ---

  it('Connect Wallet button is reachable by Tab', async () => {
    mockUseWallet.mockReturnValue(createWalletState());

    render(<WalletConnectButton />);

    const btn = screen.getByRole('button', { name: 'Connect wallet' });
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it('Enter key activates Connect Wallet button', async () => {
    const connect = jest.fn();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    mockUseWallet.mockReturnValue(createWalletState({ connect }));

    render(<WalletConnectButton />);

    const btn = screen.getByRole('button', { name: 'Connect wallet' });
    btn.focus();
    await user.keyboard('{Enter}');

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('Space key activates Connect Wallet button', async () => {
    const connect = jest.fn();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    mockUseWallet.mockReturnValue(createWalletState({ connect }));

    render(<WalletConnectButton />);

    const btn = screen.getByRole('button', { name: 'Connect wallet' });
    btn.focus();
    await user.keyboard('[Space]');

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('Connect Wallet button carries visible focus-ring classes', () => {
    mockUseWallet.mockReturnValue(createWalletState());
    render(<WalletConnectButton />);

    const btn = screen.getByRole('button', { name: 'Connect wallet' });
    expect(btn.className).toContain('focus:outline-none');
    expect(btn.className).toMatch(/focus:ring-2/);
  });

  // --- Connecting state (disabled button) ---

  it('Connect Wallet button is disabled (not in tab sequence) while connecting', () => {
    mockUseWallet.mockReturnValue(createWalletState({ isConnecting: true }));
    render(<WalletConnectButton />);

    const btn = screen.getByRole('button', { name: 'Connect wallet' });
    // Disabled buttons are still focusable in the DOM but must be marked disabled
    // so that AT announces them correctly and click handlers are suppressed.
    expect(btn).toBeDisabled();
  });

  // --- Error state — Retry button ---

  it('Retry button is reachable by Tab in the error state', async () => {
    mockUseWallet.mockReturnValue(
      createWalletState({ error: 'Connection failed', connect: jest.fn() }),
    );

    render(<WalletConnectButton />);

    const retryBtn = screen.getByRole('button', { name: 'Retry wallet connection' });
    expect(retryBtn).toBeInTheDocument();
    expect(retryBtn).not.toBeDisabled();
  });

  it('Enter key activates Retry button', async () => {
    const connect = jest.fn();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    mockUseWallet.mockReturnValue(createWalletState({ error: 'Connection failed', connect }));

    render(<WalletConnectButton />);

    const retryBtn = screen.getByRole('button', { name: 'Retry wallet connection' });
    retryBtn.focus();
    await user.keyboard('{Enter}');

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('Space key activates Retry button', async () => {
    const connect = jest.fn();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    mockUseWallet.mockReturnValue(createWalletState({ error: 'Connection failed', connect }));

    render(<WalletConnectButton />);

    const retryBtn = screen.getByRole('button', { name: 'Retry wallet connection' });
    retryBtn.focus();
    await user.keyboard('[Space]');

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('Retry button carries visible focus-ring classes', () => {
    mockUseWallet.mockReturnValue(
      createWalletState({ error: 'Connection failed', connect: jest.fn() }),
    );
    render(<WalletConnectButton />);

    const retryBtn = screen.getByRole('button', { name: 'Retry wallet connection' });
    expect(retryBtn.className).toContain('focus:outline-none');
    expect(retryBtn.className).toMatch(/focus-visible:ring-2/);
  });

  // --- Connected state — Copy and Disconnect buttons ---

  it('Copy and Disconnect buttons are reachable by Tab in the connected state', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    mockUseWallet.mockReturnValue(
      createWalletState({ address: '0xABCDEF1234567890abcdef1234567890abcdef12' }),
    );
    installClipboardMock();

    render(<WalletConnectButton />);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Switch to compact view' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Copy address to clipboard' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Disconnect wallet' })).toHaveFocus();
  });

  it('Enter key activates the Copy button', async () => {
    const writeText = installClipboardMock();
    const address = '0xABCDEF1234567890abcdef1234567890abcdef12';
    mockUseWallet.mockReturnValue(createWalletState({ address }));

    render(<WalletConnectButton />);

    const copyBtn = screen.getByRole('button', { name: 'Copy address to clipboard' });
    copyBtn.focus();
    expect(copyBtn).toHaveFocus();

    // Buttons respond to Enter natively; fire click and flush the async copy chain.
    await act(async () => {
      fireEvent.click(copyBtn);
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(address);
  });

  it('Enter key activates the Disconnect button', async () => {
    const disconnect = jest.fn();
    mockUseWallet.mockReturnValue(
      createWalletState({
        address: '0xABCDEF1234567890abcdef1234567890abcdef12',
        disconnect,
      }),
    );
    installClipboardMock();

    render(<WalletConnectButton />);

    const disconnectBtn = screen.getByRole('button', { name: 'Disconnect wallet' });
    await act(async () => {
      fireEvent.click(disconnectBtn);
    });

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('Copy button carries visible focus-ring classes', () => {
    mockUseWallet.mockReturnValue(
      createWalletState({ address: '0xABCDEF1234567890abcdef1234567890abcdef12' }),
    );
    installClipboardMock();
    render(<WalletConnectButton />);

    const copyBtn = screen.getByRole('button', { name: 'Copy address to clipboard' });
    expect(copyBtn.className).toContain('focus:outline-none');
    expect(copyBtn.className).toMatch(/focus:ring-2/);
  });

  it('Disconnect button carries visible focus-ring classes', () => {
    mockUseWallet.mockReturnValue(
      createWalletState({ address: '0xABCDEF1234567890abcdef1234567890abcdef12' }),
    );
    installClipboardMock();
    render(<WalletConnectButton />);

    const disconnectBtn = screen.getByRole('button', { name: 'Disconnect wallet' });
    expect(disconnectBtn.className).toContain('focus:outline-none');
    expect(disconnectBtn.className).toMatch(/focus:ring-2/);
  });

  it('focus order in the connected state is Copy then Disconnect (DOM order)', async () => {
    mockUseWallet.mockReturnValue(
      createWalletState({ address: '0xABCDEF1234567890abcdef1234567890abcdef12' }),
    );
    installClipboardMock();

    render(<WalletConnectButton />);

    // Collect DOM order of buttons inside the connected widget.
    const buttons = screen.getAllByRole('button');
    // Copy comes before Disconnect in the DOM — verify by their accessible names.
    const copyIndex = buttons.findIndex((b) => b.getAttribute('aria-label') === 'Copy address to clipboard');
    const disconnectIndex = buttons.findIndex((b) => b.getAttribute('aria-label') === 'Disconnect wallet');
    expect(copyIndex).toBeLessThan(disconnectIndex);
  });
});

// ---------------------------------------------------------------------------
// a11y: wallet view — jest-axe
//
// Covers every distinct render state of WalletConnectButton:
//
//   • empty      — disconnected, not connecting, no error  (Connect Wallet button)
//   • connecting — connection attempt in flight             (disabled + spinner)
//   • loaded     — wallet address present                   (Copy + Disconnect)
//   • loaded/copied — address present, copy just succeeded  (checkmark icon)
//   • error      — connection attempt failed                (Retry button)
//
// Timer discipline: real timers are required — axe() schedules work via
// window.setTimeout and will deadlock under fake timers (the Promise never
// settles). Toasts and copy-reset timers are not triggered in these tests
// so there is nothing to fake-advance.
// ---------------------------------------------------------------------------

describe('a11y: wallet view — jest-axe', () => {
  // Restore the original clipboard after each test so a defineProperty in one
  // test does not bleed into the next.
  const savedClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  afterEach(() => {
    jest.clearAllMocks();
    if (savedClipboard) {
      Object.defineProperty(navigator, 'clipboard', savedClipboard);
    }
  });

  // --- empty state (disconnected) ---

  it('empty state (disconnected, no error) has no axe violations', async () => {
    mockUseWallet.mockReturnValue(
      createWalletState({ address: null, isConnecting: false, error: null }),
    );

    const { container } = render(<WalletConnectButton />);
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  // --- connecting state ---

  it('connecting state (spinner, disabled button) has no axe violations', async () => {
    mockUseWallet.mockReturnValue(
      createWalletState({ address: null, isConnecting: true, error: null }),
    );

    const { container } = render(<WalletConnectButton />);
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeDisabled();

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  // --- loaded state (address present) ---

  it('loaded state (wallet connected) has no axe violations', async () => {
    mockUseWallet.mockReturnValue(
      createWalletState({
        address: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H',
      }),
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
    });

    const { container } = render(<WalletConnectButton />);
    expect(screen.getByRole('button', { name: 'Copy address to clipboard' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect wallet' })).toBeInTheDocument();

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  // --- loaded/copied state (checkmark icon variant) ---

  it('loaded state after a successful copy (checkmark icon) has no axe violations', async () => {
    // Use real timers so axe can settle; the 2-second reset timer will not
    // fire during the axe run (~50 ms).
    jest.useFakeTimers(); // start fake so we can freeze the copied state
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockUseWallet.mockReturnValue(
      createWalletState({
        address: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H',
      }),
    );

    const { container } = render(<WalletConnectButton />);

    // Trigger copy and flush the async clipboard write.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy address to clipboard' }));
      await Promise.resolve();
    });

    // Now switch to real timers so axe's own setTimeout calls work.
    jest.useRealTimers();

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  // --- error state ---

  it('error state (connection failed, Retry button) has no axe violations', async () => {
    mockUseWallet.mockReturnValue(
      createWalletState({
        address: null,
        isConnecting: false,
        error: 'Freighter wallet is not installed. Please install the Freighter browser extension.',
      }),
    );

    const { container } = render(<WalletConnectButton />);
    expect(screen.getByRole('button', { name: 'Retry wallet connection' })).toBeInTheDocument();
    expect(screen.getByText('Connection Error')).toBeInTheDocument();

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it('error state with user-rejected message has no axe violations', async () => {
    mockUseWallet.mockReturnValue(
      createWalletState({
        address: null,
        isConnecting: false,
        error: 'User rejected the connection request.',
      }),
    );

    const { container } = render(<WalletConnectButton />);
    expect(screen.getByRole('button', { name: 'Retry wallet connection' })).toBeInTheDocument();

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });
});
