import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { usePathname, useRouter } from 'next/navigation';
import NotFound from './not-found';
import { setErrorReporter } from '@/lib/errorReporter';
import { MAX_DISPLAY_PATH_LENGTH } from '@/lib/notFoundRecovery';
import {
  DEFAULT_NOT_FOUND_QUICK_LINKS,
  NOT_FOUND_HOME_HREF,
  NOT_FOUND_SUPPORT_HREF,
  getNotFoundQuickLinks,
} from '@/lib/notFoundContent';
import { assertNoA11yViolations } from '@/test-utils/a11y';

jest.mock('next/navigation', () => ({
  usePathname: jest.fn(),
  useRouter: jest.fn(),
}));

const usePathnameMock = usePathname as jest.Mock;
const useRouterMock = useRouter as jest.Mock;

// Capture every reportError call through the sanctioned reporter seam.
let reports: Array<{
  error: unknown;
  context: string;
  level?: string;
  meta?: Record<string, unknown>;
}>;

function makeRouter() {
  const push = jest.fn();
  useRouterMock.mockReturnValue({ push, replace: jest.fn(), prefetch: jest.fn() });
  return push;
}

describe('NotFound page', () => {
  beforeEach(() => {
    reports = [];
    setErrorReporter((error, context, level, meta) => {
      reports.push({ error, context, level, meta });
    });
    usePathnameMock.mockReturnValue('/contracts/missing-id');
    makeRouter();
  });

  afterEach(() => {
    setErrorReporter(null);
    jest.restoreAllMocks();
  });

  describe('stable content (compatibility with existing callers)', () => {
    it('renders the h1 heading', () => {
      render(<NotFound />);
      expect(
        screen.getByRole('heading', { level: 1, name: /page not found/i }),
      ).toBeInTheDocument();
    });

    it('renders the descriptive paragraph', () => {
      render(<NotFound />);
      expect(
        screen.getByText(/this page doesn't exist or the link may have expired/i),
      ).toBeInTheDocument();
    });

    it('renders 404 as decorative and hidden from assistive technology', () => {
      render(<NotFound />);
      expect(screen.getByText('404')).toHaveAttribute('aria-hidden', 'true');
    });

    it('renders the quick links nav with an accessible label', () => {
      render(<NotFound />);
      expect(
        screen.getByRole('navigation', { name: /quick links/i }),
      ).toBeInTheDocument();
    });

    it('renders the three quick links', () => {
      render(<NotFound />);
      expect(screen.getByRole('link', { name: /view contracts/i })).toHaveAttribute(
        'href',
        '/contracts',
      );
      expect(screen.getByRole('link', { name: /track milestones/i })).toHaveAttribute(
        'href',
        '/milestones',
      );
      expect(screen.getByRole('link', { name: /my reputation/i })).toHaveAttribute(
        'href',
        '/reputation',
      );
    });

    it('renders Go Home and Contact Support links', () => {
      render(<NotFound />);
      expect(screen.getByRole('link', { name: /go home/i })).toHaveAttribute('href', '/');
      expect(screen.getByRole('link', { name: /contact support/i })).toHaveAttribute(
        'href',
        'mailto:support@talenttrust.io',
      );
    });

    it('keeps the link count at five (Go Back is a button, not a link)', () => {
      render(<NotFound />);
      const links = screen.getAllByRole('link');
      expect(links.length).toBe(5);
      links.forEach((link) => expect(link.tagName).toBe('A'));
    });
  });

  describe('deterministic path display', () => {
    it('shows the sanitized missing path', () => {
      usePathnameMock.mockReturnValue('/contracts/missing-id');
      render(<NotFound />);
      expect(screen.getByText('/contracts/missing-id')).toBeInTheDocument();
    });

    it('never surfaces the query string (secret containment)', () => {
      usePathnameMock.mockReturnValue('/reset?token=SUPERSECRET');
      render(<NotFound />);
      expect(screen.getByText('/reset')).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/SUPERSECRET/);
    });

    it('shows a stable fallback for unusable paths instead of raw text', () => {
      usePathnameMock.mockReturnValue('relative/not/root//evil?q=1');
      render(<NotFound />);
      expect(
        screen.getByText(/we couldn't identify the page you were looking for/i),
      ).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/relative\/not\/root/);
    });

    it('truncates a pathological path to the display bound', () => {
      usePathnameMock.mockReturnValue(`/${'x'.repeat(MAX_DISPLAY_PATH_LENGTH + 400)}`);
      const { container } = render(<NotFound />);
      const code = container.querySelector('code');
      expect(code).not.toBeNull();
      expect(code!.textContent!.length).toBe(MAX_DISPLAY_PATH_LENGTH);
    });

    it('is idempotent across re-renders with the same path', () => {
      usePathnameMock.mockReturnValue('/a//b?z=1#frag');
      const { rerender } = render(<NotFound />);
      const first = screen.getByText('/a/b').textContent;
      rerender(<NotFound />);
      expect(screen.getByText('/a/b').textContent).toBe(first);
    });
  });

  describe('observability (diagnosable, non-leaking, de-duplicated)', () => {
    it('reports the miss once with the sanitized path as metadata', () => {
      usePathnameMock.mockReturnValue('/gone?q=1');
      render(<NotFound />);
      expect(reports).toHaveLength(1);
      expect(reports[0].context).toBe('not-found');
      expect(reports[0].level).toBe('warn');
      expect(reports[0].meta).toEqual({ path: '/gone' });
    });

    it('never includes the query/token in the report', () => {
      usePathnameMock.mockReturnValue('/reset?token=LEAK');
      render(<NotFound />);
      expect(JSON.stringify(reports[0].meta)).not.toMatch(/LEAK/);
      expect(reports[0].meta).toEqual({ path: '/reset' });
    });

    it('reports "unknown" for an unusable path without throwing', () => {
      usePathnameMock.mockReturnValue('');
      expect(() => render(<NotFound />)).not.toThrow();
      expect(reports[0].meta).toEqual({ path: 'unknown' });
    });

    it('de-duplicates under React StrictMode double-invocation', () => {
      usePathnameMock.mockReturnValue('/strict');
      render(
        <React.StrictMode>
          <NotFound />
        </React.StrictMode>,
      );
      expect(reports).toHaveLength(1);
    });

    it('does not re-report the same path on re-render', () => {
      usePathnameMock.mockReturnValue('/same');
      const { rerender } = render(<NotFound />);
      rerender(<NotFound />);
      rerender(<NotFound />);
      expect(reports).toHaveLength(1);
    });

    it('reports a genuinely different path when it changes', () => {
      usePathnameMock.mockReturnValue('/one');
      const { rerender } = render(<NotFound />);
      usePathnameMock.mockReturnValue('/two');
      rerender(<NotFound />);
      expect(reports).toHaveLength(2);
      expect(reports[1].meta).toEqual({ path: '/two' });
    });
  });

  describe('recovery actions', () => {
    function setHistory(length: number) {
      Object.defineProperty(window.history, 'length', {
        configurable: true,
        get: () => length,
      });
      const back = jest.fn();
      jest.spyOn(window.history, 'back').mockImplementation(back);
      return back;
    }

    it('goes back when there is real history', () => {
      const back = setHistory(3);
      makeRouter();
      render(<NotFound />);
      fireEvent.click(screen.getByRole('button', { name: /go back/i }));
      expect(back).toHaveBeenCalledTimes(1);
    });

    it('falls back to client-side home navigation with no history', () => {
      setHistory(1);
      const push = makeRouter();
      render(<NotFound />);
      fireEvent.click(screen.getByRole('button', { name: /go back/i }));
      expect(push).toHaveBeenCalledWith('/');
    });

    it('goes back in-history without triggering a router reload when history exists', () => {
      setHistory(3);
      const push = makeRouter();
      render(<NotFound />);
      fireEvent.click(screen.getByRole('button', { name: /go back/i }));
      // history.back() restores the prior document; no client-side navigation
      // (and therefore no hard reload that would drop in-memory state) occurs.
      expect(push).not.toHaveBeenCalled();
    });
  });

  it('matches snapshot', () => {
    usePathnameMock.mockReturnValue('/contracts/missing-id');
    const { container } = render(<NotFound />);
    expect(container.firstChild).toMatchSnapshot();
  });
});

/**
 * Compatibility-contract wiring.
 *
 * These tests pin the 404 page to the validated contract module so an upgrade
 * or a malformed/empty upstream list cannot silently change (or drop) the
 * public recovery navigation.
 */
describe('NotFound page compatibility contract', () => {
  it('renders exactly the contract quick links in declaration order', () => {
    render(<NotFound />);

    const rendered = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href')?.startsWith('/'));
    const contract = getNotFoundQuickLinks();

    const quickLinkHrefs = rendered
      .map((link) => link.getAttribute('href'))
      .filter((href) => href !== NOT_FOUND_HOME_HREF);

    expect(quickLinkHrefs).toEqual(contract.map((link) => link.href));
    contract.forEach((link) => {
      expect(
        screen.getByRole('link', { name: new RegExp(link.label, 'i') }),
      ).toHaveAttribute('href', link.href);
    });
  });

  it('renders the documented default links (regression guard)', () => {
    render(<NotFound />);
    DEFAULT_NOT_FOUND_QUICK_LINKS.forEach((link) => {
      expect(screen.getByText(link.label)).toBeInTheDocument();
      expect(screen.getByText(link.description)).toBeInTheDocument();
    });
  });

  it('uses the contract home and support hrefs', () => {
    render(<NotFound />);
    expect(screen.getByRole('link', { name: /go home/i })).toHaveAttribute(
      'href',
      NOT_FOUND_HOME_HREF,
    );
    expect(
      screen.getByRole('link', { name: /contact support/i }),
    ).toHaveAttribute('href', NOT_FOUND_SUPPORT_HREF);
  });

  it('never renders an off-site or protocol-relative anchor', () => {
    render(<NotFound />);
    screen.getAllByRole('link').forEach((link) => {
      const href = link.getAttribute('href') ?? '';
      expect(href.startsWith('//')).toBe(false);
      expect(href.startsWith('http')).toBe(false);
    });
  });

  it('has no detectable accessibility violations', async () => {
    const { container } = render(<NotFound />);
    await assertNoA11yViolations(container);
  });
});
