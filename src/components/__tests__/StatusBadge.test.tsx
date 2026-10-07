import React from 'react';
import { render, screen } from '@testing-library/react';
import StatusBadge, { isKnownStatus, type StatusType } from '../StatusBadge';

const STATUS_ICONS: Record<StatusType, string> = {
  Active:    '▶',
  Completed: '✓',
  Disputed:  '⚠',
  Pending:   '⏳',
  Paid:      '✔',
};

describe('StatusBadge', () => {
  describe('rendering', () => {
    it('renders the status text', () => {
      render(<StatusBadge status="Completed" />);
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('renders all status types correctly', () => {
      const statuses: StatusType[] = ['Active', 'Completed', 'Disputed', 'Pending', 'Paid'];

      statuses.forEach((status) => {
        const { unmount } = render(<StatusBadge status={status} />);
        expect(screen.getByText(status)).toBeInTheDocument();
        unmount();
      });
    });

    it('renders an icon for each status', () => {
      const statuses: StatusType[] = ['Active', 'Completed', 'Disputed', 'Pending', 'Paid'];

      statuses.forEach((status) => {
        const { container, unmount } = render(<StatusBadge status={status} />);
        const iconSpan = container.querySelector('span[aria-hidden="true"]');
        expect(iconSpan).toBeInTheDocument();
        expect(iconSpan?.textContent).toBe(STATUS_ICONS[status]);
        unmount();
      });
    });

    it('icon span has aria-hidden="true"', () => {
      const { container } = render(<StatusBadge status="Active" />);
      const iconSpan = container.querySelector('span[aria-hidden="true"]');
      expect(iconSpan).toHaveAttribute('aria-hidden', 'true');
    });
  });

  describe('styling', () => {
    // a11y/theming-27: these assertions previously checked for fixed
    // Tailwind pastel classes (e.g. 'bg-emerald-100'), which is exactly
    // what broke dark-mode contrast -- the same literal classes were
    // reused unchanged regardless of [data-theme]. StatusBadge now uses
    // the --status-* CSS variables defined in globals.css, which carry
    // an audited light/dark pair. See docs/components/Accessibility.md.
    it('applies correct themed classes for Active status', () => {
      const { container } = render(<StatusBadge status="Active" />);
      const span = container.querySelector('span');
      expect(span?.className).toContain('bg-[var(--status-success-bg)]');
      expect(span?.className).toContain('text-[var(--status-success-foreground)]');
    });

    it('applies correct themed classes for Completed status', () => {
      const { container } = render(<StatusBadge status="Completed" />);
      const span = container.querySelector('span');
      expect(span?.className).toContain('bg-[var(--status-info-bg)]');
      expect(span?.className).toContain('text-[var(--status-info-foreground)]');
    });

    it('applies correct themed classes for Disputed status', () => {
      const { container } = render(<StatusBadge status="Disputed" />);
      const span = container.querySelector('span');
      expect(span?.className).toContain('bg-[var(--status-error-bg)]');
      expect(span?.className).toContain('text-[var(--status-error-foreground)]');
    });

    it('applies correct themed classes for Pending status', () => {
      const { container } = render(<StatusBadge status="Pending" />);
      const span = container.querySelector('span');
      expect(span?.className).toContain('bg-[var(--status-warning-bg)]');
      expect(span?.className).toContain('text-[var(--status-warning-foreground)]');
    });

    it('applies correct themed classes for Paid status', () => {
      const { container } = render(<StatusBadge status="Paid" />);
      const span = container.querySelector('span');
      expect(span?.className).toContain('bg-[var(--status-success-bg)]');
      expect(span?.className).toContain('text-[var(--status-success-foreground)]');
    });

    it('applies base badge styles consistently', () => {
      const { container } = render(<StatusBadge status="Active" />);
      const span = container.querySelector('span');
      expect(span?.className).toContain('inline-flex');
      expect(span?.className).toContain('items-center');
      expect(span?.className).toContain('rounded-full');
      expect(span?.className).toContain('px-3');
      expect(span?.className).toContain('py-1');
      expect(span?.className).toContain('text-sm');
      expect(span?.className).toContain('font-semibold');
    });

    it('no longer uses fixed Tailwind pastel color classes (regression guard)', () => {
      const statuses: StatusType[] = ['Active', 'Completed', 'Disputed', 'Pending', 'Paid'];

      statuses.forEach((status) => {
        const { container, unmount } = render(<StatusBadge status={status} />);
        const span = container.querySelector('span');
        expect(span?.className).not.toMatch(/bg-(emerald|sky|rose|amber)-100/);
        expect(span?.className).not.toMatch(/text-(emerald|sky|rose|amber)-800/);
        unmount();
      });
    });
  });

  describe('additional className prop', () => {
    it('applies additional className when provided', () => {
      const { container } = render(<StatusBadge status="Completed" className="ml-2 custom-class" />);
      const span = container.querySelector('span');
      expect(span?.className).toContain('ml-2');
      expect(span?.className).toContain('custom-class');
    });

    it('works with empty className prop', () => {
      const { container } = render(<StatusBadge status="Completed" className="" />);
      const span = container.querySelector('span');
      expect(span?.className).toContain('bg-[var(--status-info-bg)]');
    });

    it('defaults to empty string when className is not provided', () => {
      const { container } = render(<StatusBadge status="Completed" />);
      const span = container.querySelector('span');
      expect(span?.className).toContain('bg-[var(--status-info-bg)]');
    });
  });

  describe('accessibility', () => {
    it('has role="status" for screen readers', () => {
      render(<StatusBadge status="Completed" />);
      const badge = screen.getByRole('status');
      expect(badge).toBeInTheDocument();
    });

    it('has appropriate aria-label for each status', () => {
      const statuses: StatusType[] = ['Active', 'Completed', 'Disputed', 'Pending', 'Paid'];

      statuses.forEach((status) => {
        const { unmount } = render(<StatusBadge status={status} />);
        expect(screen.getByLabelText(`Status: ${status}`)).toBeInTheDocument();
        unmount();
      });
    });

    it('is semantically correct with role and label', () => {
      render(<StatusBadge status="Active" />);
      const badge = screen.getByRole('status', { name: 'Status: Active' });
      expect(badge).toHaveTextContent('Active');
    });
  });

  describe('unknown status fallback', () => {
    // StatusBadge is strictly typed for StatusType at the prop boundary,
    // but the runtime needs to handle values that slip through (e.g. data
    // from an API that hasn't been validated). The unknown-status path
    // must be safe, accessible, and visually distinct from the canonical
    // five statuses.

    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('does not throw when status is not in StatusType', () => {
      expect(() =>
        render(
          <StatusBadge status={'Cancelled' as unknown as StatusType} />,
        ),
      ).not.toThrow();
    });

    it('renders neutral styling classes for an unknown status', () => {
      const { container } = render(
        <StatusBadge status={'Cancelled' as unknown as StatusType} />,
      );
      const span = container.querySelector('span');
      expect(span?.className).toContain('bg-[var(--status-neutral-bg)]');
      expect(span?.className).toContain('text-[var(--status-neutral-foreground)]');
    });

    it('renders no known-status colour tokens for an unknown status', () => {
      const { container } = render(
        <StatusBadge status={'OnHold' as unknown as StatusType} />,
      );
      const span = container.querySelector('span');
      expect(span?.className).not.toMatch(/var\(--status-(success|info|error|warning)-/);
    });

    // NOTE: `Archived` is a canonical StatusType, so the fallback path is
    // exercised with a value that is genuinely outside the union instead.
    it('renders the fallback question mark icon for an unknown status', () => {
      const { container } = render(
        <StatusBadge status={'OnHold' as unknown as StatusType} />,
      );
      const iconSpan = container.querySelector('span[aria-hidden="true"]');
      expect(iconSpan?.textContent).toBe('?');
    });

    it('uses a fallback aria-label that names the unknown status', () => {
      render(
        <StatusBadge status={'OnHold' as unknown as StatusType} />,
      );
      const badge = screen.getByRole('status', {
        name: 'Status: Unknown — value "OnHold"',
      });
      expect(badge).toBeInTheDocument();
    });

    it('preserves the raw status string in the visible label', () => {
      const { container } = render(
        <StatusBadge status={'OnHold' as unknown as StatusType} />,
      );
      expect(container).toHaveTextContent('OnHold');
      expect(container).toHaveTextContent('Unknown');
    });

    it('still applies base badge styles with unknown status', () => {
      const { container } = render(
        <StatusBadge status={'OnHold' as unknown as StatusType} />,
      );
      const span = container.querySelector('span');
      expect(span?.className).toContain('inline-flex');
      expect(span?.className).toContain('rounded-full');
      expect(span?.className).toContain('px-3');
      expect(span?.className).toContain('py-1');
      expect(span?.className).toContain('font-semibold');
    });

    it('keeps the fallback neutral styling when additional className is supplied', () => {
      const { container } = render(
        <StatusBadge
          status={'OnHold' as unknown as StatusType}
          className="ml-2"
        />,
      );
      const span = container.querySelector('span');
      expect(span?.className).toContain('bg-[var(--status-neutral-bg)]');
      expect(span?.className).toContain('ml-2');
    });

    it('warns once in development when status is unknown', () => {
      render(<StatusBadge status={'Cancelled' as unknown as StatusType} />);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[StatusBadge] Unknown status value: "Cancelled".'),
      );
    });

    it('handles empty-string status without crashing', () => {
      // Single render covers both the "does not throw" assertion (render
      // throws synchronously when the component throws) and the visible
      // output checks. Visible label is `Unknown ()` for empty-string
      // status so the unknown indicator is still rendered.
      const { container } = render(
        <StatusBadge status={'' as unknown as StatusType} />,
      );
      const span = container.querySelector('span');
      expect(span?.className).toContain('bg-[var(--status-neutral-bg)]');
      expect(container).toHaveTextContent('Unknown ()');
    });

    it('handles numeric status without crashing', () => {
      // Single render: if the component threw, render would itself throw.
      const { container } = render(
        <StatusBadge status={42 as unknown as StatusType} />,
      );
      expect(container).toHaveTextContent('Unknown (42)');
    });
  });

  describe('isKnownStatus type-guard', () => {
    it('returns true for each canonical status', () => {
      (['Active', 'Completed', 'Disputed', 'Pending', 'Paid'] as StatusType[])
        .forEach((status) => {
          expect(isKnownStatus(status)).toBe(true);
        });
    });

    it('returns false for unknown strings', () => {
      expect(isKnownStatus('Cancelled')).toBe(false);
      expect(isKnownStatus('OnHold')).toBe(false);
      expect(isKnownStatus('')).toBe(false);
    });

    it('returns false for non-string values', () => {
      expect(isKnownStatus(undefined)).toBe(false);
      expect(isKnownStatus(null)).toBe(false);
      expect(isKnownStatus(42)).toBe(false);
      expect(isKnownStatus({})).toBe(false);
    });
  });

  describe('snapshot tests', () => {
    it('matches snapshot for Active status', () => {
      const { container } = render(<StatusBadge status="Active" />);
      expect(container.firstChild).toMatchSnapshot();
    });

    it('matches snapshot for Completed status', () => {
      const { container } = render(<StatusBadge status="Completed" />);
      expect(container.firstChild).toMatchSnapshot();
    });

    it('matches snapshot for Disputed status', () => {
      const { container } = render(<StatusBadge status="Disputed" />);
      expect(container.firstChild).toMatchSnapshot();
    });

    it('matches snapshot for Pending status', () => {
      const { container } = render(<StatusBadge status="Pending" />);
      expect(container.firstChild).toMatchSnapshot();
    });

    it('matches snapshot for Paid status', () => {
      const { container } = render(<StatusBadge status="Paid" />);
      expect(container.firstChild).toMatchSnapshot();
    });

    it('matches snapshot with additional className', () => {
      const { container } = render(<StatusBadge status="Active" className="ml-2" />);
      expect(container.firstChild).toMatchSnapshot();
    });
  });
});