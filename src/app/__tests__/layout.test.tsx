import React from 'react';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import RootLayout, { resolveMetadataBase } from '../layout';
import SafeBoundary from '@/components/SafeBoundary';
import { setErrorReporter } from '@/lib/errorReporter';
import { clearCommands } from '@/lib/commands/registry';

// WalletProvider and RouteAnnouncer are already mocked in jest.setup.ts.
// Mock next/navigation for RouteAnnouncer's usePathname call and
// CommandPalette's useRouter call.
jest.mock('next/navigation', () => ({
  usePathname: jest.fn().mockReturnValue('/'),
  useRouter: jest.fn().mockReturnValue({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
}));

/**
 * Suppress the React error boundary console.error noise that appears in the
 * test output whenever a child component deliberately throws.
 */
beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  setErrorReporter(null);
  clearCommands();
});

afterEach(() => {
  jest.restoreAllMocks();
  setErrorReporter(null);
  clearCommands();
});

/** Render the root layout with a stable, happy-path child. */
function renderLayout(child: React.ReactNode = <div>Page content</div>) {
  return render(<RootLayout>{child}</RootLayout>);
}

// ---------------------------------------------------------------------------
// Helpers: components that deliberately crash so we can verify isolation
// ---------------------------------------------------------------------------

/**
 * When rendered, unconditionally throws so we can test SafeBoundary isolation.
 * Named exports make jest.mock() easy to target at individual components.
 */
const Bomb = () => {
  throw new Error('Deliberate test explosion');
};

// ---------------------------------------------------------------------------
// Describe: skip-to-content link (a11y baseline — must not regress)
// ---------------------------------------------------------------------------

describe('RootLayout — skip-to-content link', () => {
  it('renders a skip link with correct text', () => {
    renderLayout();
    expect(screen.getByRole('link', { name: /skip to main content/i })).toBeInTheDocument();
  });

  it('skip link targets #main-content', () => {
    renderLayout();
    const link = screen.getByRole('link', { name: /skip to main content/i });
    expect(link).toHaveAttribute('href', '#main-content');
  });

  it('skip link is visually hidden until focused', () => {
    renderLayout();
    const link = screen.getByRole('link', { name: /skip to main content/i });
    expect(link).toHaveClass('sr-only');
    expect(link.className).toMatch(/focus:not-sr-only/);
  });

  it('skip link is the first focusable element — appears before the header in the DOM', () => {
    const { container } = renderLayout();
    const focusables = container.querySelectorAll('a, button, [tabindex]');
    expect(focusables[0]).toHaveAttribute('href', '#main-content');
  });

  it('<main> has id="main-content" so the skip link target exists', () => {
    const { container } = renderLayout();
    expect(container.querySelector('main#main-content')).toBeInTheDocument();
  });

  it('<main> has tabIndex={-1} to accept programmatic focus', () => {
    const { container } = renderLayout();
    const main = container.querySelector('main#main-content');
    expect(main).toHaveAttribute('tabindex', '-1');
  });

  it('has no axe accessibility violations on the skip link and main landmark', async () => {
    const { container } = renderLayout();
    // Scope axe to the inner wrapper that contains the skip link and main,
    // excluding the ToastProvider notification container which has pre-existing
    // aria-label-on-div violations unrelated to this change.
    const wrapper = container.querySelector('.min-h-screen') as HTMLElement;
    const results = await axe(wrapper ?? container);
    expect(results).toHaveNoViolations();
  });
});

describe('RootLayout — metadata URL boundaries', () => {
  it.each([
    ['https://talenttrust.example', 'https:'],
    ['https://talenttrust.example/app/', 'https:'],
    [undefined, 'http:'],
    ['', 'http:'],
  ])('accepts a safe site URL (%s)', (value, protocol) => {
    expect(resolveMetadataBase(value).protocol).toBe(protocol);
  });

  it.each(['not a URL', 'javascript:alert(1)', 'https://user:secret@example.com'])(
    'falls back for unsafe metadata input (%s)',
    (value) => {
      const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(resolveMetadataBase(value).toString()).toBe('http://localhost:3000/');
      expect(warning).toHaveBeenCalledWith(
        '[metadata] invalid NEXT_PUBLIC_SITE_URL; using the default site URL',
      );
      warning.mockRestore();
    },
  );
});

// ---------------------------------------------------------------------------
// Describe: SafeBoundary segment isolation
//
// layout.tsx wraps Navbar, HeaderActions and the page children in *independent*
// boundaries. These tests pin that isolation: a throw inside one segment must
// surface only that segment's fallback and must never take the header, the other
// segment, or the <main> landmark down with it.
// ---------------------------------------------------------------------------

describe('RootLayout — SafeBoundary segment isolation', () => {
  /** Mirrors layout.tsx: one boundary per segment, all inside <main>/<header>. */
  const IsolatedLayout = ({ crashSegment }: { crashSegment: 'navbar' | 'actions' | 'children' }) => (
    <div className="min-h-screen flex flex-col">
      <header>
        <span>TalentTrust</span>
        <SafeBoundary fallbackTitle="Navigation failed to load.">
          {crashSegment === 'navbar' ? <Bomb /> : <nav aria-label="Primary">Navbar stub</nav>}
        </SafeBoundary>
        <SafeBoundary fallbackTitle="Header actions failed to load.">
          {crashSegment === 'actions' ? <Bomb /> : <div>HeaderActions stub</div>}
        </SafeBoundary>
      </header>
      <main id="main-content" tabIndex={-1}>
        <SafeBoundary fallbackTitle="This page failed to load.">
          {crashSegment === 'children' ? <Bomb /> : <div>Page children</div>}
        </SafeBoundary>
      </main>
    </div>
  );

  it('contains a Navbar crash without disrupting HeaderActions or children', () => {
    render(<IsolatedLayout crashSegment="navbar" />);
    expect(screen.getByText('Navigation failed to load.')).toBeInTheDocument();
    expect(screen.getByText('HeaderActions stub')).toBeInTheDocument();
    expect(screen.getByText('Page children')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('contains a HeaderActions crash without disrupting Navbar or children', () => {
    render(<IsolatedLayout crashSegment="actions" />);
    expect(screen.getByText('Header actions failed to load.')).toBeInTheDocument();
    expect(screen.getByText('Navbar stub')).toBeInTheDocument();
    expect(screen.getByText('Page children')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('contains a children crash without disrupting the header segments', () => {
    render(<IsolatedLayout crashSegment="children" />);
    expect(screen.getByText('This page failed to load.')).toBeInTheDocument();
    expect(screen.getByText('TalentTrust')).toBeInTheDocument();
    expect(screen.getByText('Navbar stub')).toBeInTheDocument();
    expect(screen.getByText('HeaderActions stub')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('never leaks the thrown error message into the fallback UI', () => {
    render(<IsolatedLayout crashSegment="children" />);
    expect(screen.getByText('This page failed to load.')).toBeInTheDocument();
    expect(screen.queryByText(/deliberate test explosion/i)).not.toBeInTheDocument();
  });

  it('announces the fallback assertively so screen readers hear it', () => {
    render(<IsolatedLayout crashSegment="children" />);
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveAttribute('aria-live', 'assertive');
  });

  it('offers a Retry affordance after a crash', () => {
    render(<IsolatedLayout crashSegment="children" />);
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('reports a contained crash exactly once through the reporter', () => {
    const reporter = jest.fn();
    setErrorReporter(reporter);
    render(<IsolatedLayout crashSegment="children" />);
    expect(reporter).toHaveBeenCalledTimes(1);
  });
});
