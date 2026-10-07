/**
 * @file Breadcrumbs.test.tsx
 *
 * Covers:
 *  - Structure and ARIA
 *  - Link generation
 *  - aria-current
 *  - Separators
 *  - Focus ring (theme-token, not hardcoded)
 *  - Dynamic labels
 *  - Boundary and adversarial inputs (empty labels, null/undefined entries,
 *    duplicate labels, very long labels, special characters, large arrays)
 *  - Key-collision regression (duplicate label + different href)
 *  - ariaLabel prop override (backwards-compatible default)
 *  - className prop passthrough (backwards-compatible default)
 *  - title attribute on truncated labels
 *  - ReadonlyArray compatibility
 *  - displayName
 *  - Dev warnings for missing ancestor href, empty labels, null/undefined
 *  - Re-render / prop-change stability
 *  - Compatibility: existing callers (contracts/[id] page scenario)
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import Breadcrumbs, { BreadcrumbItem, BreadcrumbsProps } from '../Breadcrumbs';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const THREE_CRUMBS: BreadcrumbItem[] = [
  { label: 'Dashboard', href: '/' },
  { label: 'Contracts', href: '/contracts' },
  { label: 'Contract #42' },
];

const TWO_CRUMBS: BreadcrumbItem[] = [
  { label: 'Home', href: '/' },
  { label: 'Settings' },
];

const ONE_CRUMB: BreadcrumbItem[] = [{ label: 'Dashboard', href: '/' }];

// ----------------------------------------------------------------------------
// Structure & ARIA
// ----------------------------------------------------------------------------

describe('Breadcrumbs — structure and ARIA', () => {
  it('renders a <nav> with aria-label="Breadcrumb"', () => {
    render(<Breadcrumbs items={THREE_CRUMBS} />);
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
  });

  it('contains an ordered list (<ol>) inside the nav', () => {
    const { container } = render(<Breadcrumbs items={THREE_CRUMBS} />);
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav.querySelector('ol')).toBeInTheDocument();
    expect(container.querySelector('nav > ol')).toBeInTheDocument();
  });

  it('renders one <li> per breadcrumb item', () => {
    const { container } = render(<Breadcrumbs items={THREE_CRUMBS} />);
    const ol = container.querySelector('ol') as HTMLOListElement;
    expect(ol.querySelectorAll(':scope > li')).toHaveLength(THREE_CRUMBS.length);
  });

  it('renders nothing when items array is empty', () => {
    const { container } = render(<Breadcrumbs items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when every item has an empty label', () => {
    const { container } = render(<Breadcrumbs items={[{ label: '' }, { label: '   ' }]} />);
    expect(container.firstChild).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// Link generation
// ----------------------------------------------------------------------------

describe('Breadcrumbs — link generation', () => {
  it('renders ancestor crumbs as links with correct hrefs', () => {
    render(<Breadcrumbs items={THREE_CRUMBS} />);

    const dashboardLink = screen.getByRole('link', { name: 'Dashboard' });
    const contractsLink = screen.getByRole('link', { name: 'Contracts' });

    expect(dashboardLink).toBeInTheDocument();
    expect(dashboardLink).toHaveAttribute('href', '/');

    expect(contractsLink).toBeInTheDocument();
    expect(contractsLink).toHaveAttribute('href', '/contracts');
  });

  it('does not render the final crumb as a link', () => {
    render(<Breadcrumbs items={THREE_CRUMBS} />);
    expect(screen.queryByRole('link', { name: /Contract #42/i })).not.toBeInTheDocument();
    expect(screen.getByText('Contract #42')).toBeInTheDocument();
  });

  it('renders all links with their labels for two-crumb trail', () => {
    render(<Breadcrumbs items={TWO_CRUMBS} />);
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('single-crumb list renders the sole crumb without a link', () => {
    render(<Breadcrumbs items={ONE_CRUMB} />);
    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });
});

// ----------------------------------------------------------------------------
// aria-current
// ----------------------------------------------------------------------------

describe('Breadcrumbs — aria-current', () => {
  it('applies aria-current="page" only to the final crumb', () => {
    render(<Breadcrumbs items={THREE_CRUMBS} />);
    expect(screen.getByText('Contract #42')).toHaveAttribute('aria-current', 'page');
  });

  it('does not apply aria-current to any ancestor crumb', () => {
    render(<Breadcrumbs items={THREE_CRUMBS} />);
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Contracts' })).not.toHaveAttribute('aria-current');
  });

  it('applies aria-current="page" correctly in a two-crumb trail', () => {
    render(<Breadcrumbs items={TWO_CRUMBS} />);
    expect(screen.getByText('Settings')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('applies aria-current="page" to a single-crumb list', () => {
    render(<Breadcrumbs items={ONE_CRUMB} />);
    expect(screen.getByText('Dashboard')).toHaveAttribute('aria-current', 'page');
  });
});

// ----------------------------------------------------------------------------
// Separators
// ----------------------------------------------------------------------------

describe('Breadcrumbs — separators', () => {
  it('renders aria-hidden separators between crumbs', () => {
    const { container } = render(<Breadcrumbs items={THREE_CRUMBS} />);
    const separators = container.querySelectorAll('[aria-hidden="true"]');
    expect(separators).toHaveLength(2);
  });

  it('renders no separator before the first crumb', () => {
    const { container } = render(<Breadcrumbs items={THREE_CRUMBS} />);
    const firstLi = container.querySelector('ol > li:first-child');
    expect(firstLi?.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// Focus ring
// ----------------------------------------------------------------------------

describe('Breadcrumbs — focus ring', () => {
  it('applies the theme-token focus ring to ancestor links', () => {
    render(<Breadcrumbs items={THREE_CRUMBS} />);
    const dashboardLink = screen.getByRole('link', { name: 'Dashboard' });
    expect(dashboardLink.className).toContain('focus-visible:ring-2');
    expect(dashboardLink.className).toContain('focus-visible:ring-[var(--ring)]');
    expect(dashboardLink.className).toContain('focus-visible:ring-offset-2');
  });

  it('does not use a hardcoded outline color for the focus ring', () => {
    render(<Breadcrumbs items={THREE_CRUMBS} />);
    const dashboardLink = screen.getByRole('link', { name: 'Dashboard' });
    expect(dashboardLink.className).not.toContain('outline-blue-500');
  });

  it('applies the focus ring to every ancestor link, not just the first', () => {
    render(<Breadcrumbs items={THREE_CRUMBS} />);
    const contractsLink = screen.getByRole('link', { name: 'Contracts' });
    expect(contractsLink.className).toContain('focus-visible:ring-[var(--ring)]');
  });
});

// ----------------------------------------------------------------------------
// Dynamic label (contract id interpolation)
// ----------------------------------------------------------------------------

describe('Breadcrumbs — dynamic labels', () => {
  it('reflects the contract id in the final crumb label', () => {
    const id = 'abc-123';
    render(
      <Breadcrumbs
        items={[
          { label: 'Dashboard', href: '/' },
          { label: 'Contracts', href: '/contracts' },
          { label: `Contract #${id}` },
        ]}
      />,
    );

    const currentEl = screen.getByText(`Contract #${id}`);
    expect(currentEl).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: `Contract #${id}` })).not.toBeInTheDocument();
  });

  it('renders all three crumbs from the contract detail page scenario', () => {
    render(
      <Breadcrumbs
        items={[
          { label: 'Dashboard', href: '/' },
          { label: 'Contracts', href: '/contracts' },
          { label: 'Contract #99' },
        ]}
      />,
    );

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Contracts' })).toBeInTheDocument();
    expect(within(nav).getByText('Contract #99')).toHaveAttribute('aria-current', 'page');
  });

  it('falls back to "/" for an ancestor crumb with no href', () => {
    render(
      <Breadcrumbs
        items={[
          { label: 'Untitled' },
          { label: 'Current' },
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Untitled' })).toHaveAttribute('href', '/');
  });
});

// ---------------------------------------------------------------------------
// Boundary and adversarial inputs
// ---------------------------------------------------------------------------

describe('Breadcrumbs — boundary and adversarial inputs', () => {
  // Spy on console.warn to assert dev warnings without polluting test output.
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // ── Empty-string label filtering ──────────────────────────────────────────

  it('filters out an empty-string label and emits a dev warning', () => {
    render(
      <Breadcrumbs
        items={[
          { label: '', href: '/bad' },
          { label: 'Current' },
        ]}
      />,
    );
    // Only the "Current" crumb should render
    expect(screen.getByText('Current')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Breadcrumbs]'),
    );
  });

  it('filters out whitespace-only labels and emits a dev warning', () => {
    render(
      <Breadcrumbs
        items={[
          { label: '   ', href: '/spaces' },
          { label: 'Page' },
        ]}
      />,
    );
    expect(screen.getByText('Page')).toHaveAttribute('aria-current', 'page');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('renders nothing and warns when all labels are empty strings', () => {
    const { container } = render(
      <Breadcrumbs items={[{ label: '' }, { label: '' }]} />,
    );
    expect(container.firstChild).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  // ── Missing ancestor href ─────────────────────────────────────────────────

  it('falls back to "/" when an ancestor crumb has no href and warns in dev', () => {
    render(
      <Breadcrumbs
        items={[
          { label: 'Orphan' },   // no href on an ancestor
          { label: 'Child' },
        ]}
      />,
    );
    const link = screen.getByRole('link', { name: 'Orphan' });
    expect(link).toHaveAttribute('href', '/');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ancestor crumb with no href'),
    );
  });

  it('falls back to "/" for an ancestor crumb with href=undefined', () => {
    render(
      <Breadcrumbs
        items={[
          { label: 'Ancestor', href: undefined },
          { label: 'Current' },
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Ancestor' })).toHaveAttribute('href', '/');
  });

  it('does NOT warn when an ancestor crumb has a valid href', () => {
    render(
      <Breadcrumbs
        items={[
          { label: 'Home', href: '/' },
          { label: 'Current' },
        ]}
      />,
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn when the final (current) crumb has no href', () => {
    render(<Breadcrumbs items={[{ label: 'Dashboard', href: '/' }, { label: 'Current' }]} />);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // ── Null / undefined entries (runtime safety) ─────────────────────────────

  it('silently drops null entries and still renders valid items', () => {
    // TypeScript would flag this, but runtime data from APIs can bypass types.
    const items = [
      { label: 'Dashboard', href: '/' },
      null,
      { label: 'Current' },
    ] as unknown as BreadcrumbItem[];

    const { container } = render(<Breadcrumbs items={items} />);
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Current')).toHaveAttribute('aria-current', 'page');
    // 2 valid items → 1 separator
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });

  it('silently drops undefined entries and still renders valid items', () => {
    const items = [
      undefined,
      { label: 'Contracts', href: '/contracts' },
      undefined,
      { label: 'Contract #42' },
    ] as unknown as BreadcrumbItem[];

    render(<Breadcrumbs items={items} />);
    expect(screen.getByRole('link', { name: 'Contracts' })).toBeInTheDocument();
    // The trailing crumb has no href, so it is the current page.
    expect(screen.getByText('Contract #42')).toHaveAttribute('aria-current', 'page');
  });

  it('returns null when every entry is null or undefined', () => {
    const items = [null, undefined, null] as unknown as BreadcrumbItem[];
    const { container } = render(<Breadcrumbs items={items} />);
    expect(container.firstChild).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  // ── Duplicate labels ──────────────────────────────────────────────────────

  it('renders duplicate labels without React key collision', () => {
    // Two crumbs with identical labels but different hrefs should both render.
    const { container } = render(
      <Breadcrumbs
        items={[
          { label: 'Home', href: '/home' },
          { label: 'Home', href: '/home-alt' },
          { label: 'Current' },
        ]}
      />,
    );
    const links = screen.getAllByRole('link', { name: 'Home' });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', '/home');
    expect(links[1]).toHaveAttribute('href', '/home-alt');

    // Exactly two separators for three crumbs
    const separators = container.querySelectorAll('[aria-hidden="true"]');
    expect(separators).toHaveLength(2);
  });

  it('renders duplicate labels where both are ancestor crumbs with different hrefs', () => {
    render(
      <Breadcrumbs
        items={[
          { label: 'Section', href: '/a' },
          { label: 'Section', href: '/b' },
          { label: 'Page' },
        ]}
      />,
    );
    const links = screen.getAllByRole('link', { name: 'Section' });
    expect(links[0]).toHaveAttribute('href', '/a');
    expect(links[1]).toHaveAttribute('href', '/b');
  });

  // ── Very long labels ──────────────────────────────────────────────────────

  it('renders a very long label without crashing', () => {
    const longLabel = 'A'.repeat(500);
    render(
      <Breadcrumbs
        items={[
          { label: 'Home', href: '/' },
          { label: longLabel },
        ]}
      />,
    );
    const currentEl = screen.getByText(longLabel);
    expect(currentEl).toHaveAttribute('aria-current', 'page');
  });

  it('applies title attribute to the current-page span so truncated text is discoverable', () => {
    const longLabel = 'Very Long Contract Name '.repeat(10).trim();
    render(
      <Breadcrumbs
        items={[
          { label: 'Home', href: '/' },
          { label: longLabel },
        ]}
      />,
    );
    const currentEl = screen.getByText(longLabel);
    expect(currentEl).toHaveAttribute('title', longLabel);
  });

  it('applies title attribute to ancestor links so truncated text is discoverable', () => {
    const longAncestorLabel = 'Very Long Ancestor '.repeat(10).trim();
    render(
      <Breadcrumbs
        items={[
          { label: longAncestorLabel, href: '/ancestor' },
          { label: 'Current' },
        ]}
      />,
    );
    const link = screen.getByRole('link', { name: longAncestorLabel });
    expect(link).toHaveAttribute('title', longAncestorLabel);
  });

  it('applies truncation class to both link and current-page crumbs', () => {
    const { container } = render(
      <Breadcrumbs
        items={[
          { label: 'A'.repeat(300), href: '/' },
          { label: 'B'.repeat(300) },
        ]}
      />,
    );

    const link = container.querySelector('a');
    const current = container.querySelector('[aria-current="page"]');
    expect(link?.className).toContain('truncate');
    expect(current?.className).toContain('truncate');
  });

  // ── Special characters ────────────────────────────────────────────────────

  it('renders labels containing HTML-special characters safely', () => {
    const specialLabel = '<script>alert("xss")</script>';
    render(
      <Breadcrumbs
        items={[
          { label: 'Home', href: '/' },
          { label: specialLabel },
        ]}
      />,
    );
    // The text must appear as-is (React escapes it automatically).
    expect(screen.getByText(specialLabel)).toBeInTheDocument();
    // No actual <script> element should exist in the DOM.
    expect(document.querySelector('script')).toBeNull();
  });

  it('renders labels with angle brackets as literal text', () => {
    render(
      <Breadcrumbs
        items={[
          { label: 'Home', href: '/' },
          { label: 'A > B & C' },
        ]}
      />,
    );
    expect(screen.getByText('A > B & C')).toHaveAttribute('aria-current', 'page');
  });

  it('does not use dangerouslySetInnerHTML for label rendering', () => {
    const { container } = render(
      <Breadcrumbs
        items={[
          { label: 'Safe', href: '/' },
          { label: '<b>Bold</b>' },
        ]}
      />,
    );
    // If dangerouslySetInnerHTML were used, a <b> element would appear
    expect(container.querySelector('b')).toBeNull();
  });

  it('renders labels with Unicode and emoji without crashing', () => {
    render(
      <Breadcrumbs
        items={[
          { label: '🏠 Home', href: '/' },
          { label: '日本語ページ' },
        ]}
      />,
    );
    expect(screen.getByText('🏠 Home')).toBeInTheDocument();
    expect(screen.getByText('日本語ページ')).toHaveAttribute('aria-current', 'page');
  });

  // ── Large arrays ──────────────────────────────────────────────────────────

  it('renders a trail of 20 crumbs without crashing', () => {
    const items: BreadcrumbItem[] = Array.from({ length: 20 }, (_, i) =>
      i < 19
        ? { label: `Level ${i + 1}`, href: `/level-${i + 1}` }
        : { label: 'Current' },
    );
    const { container } = render(<Breadcrumbs items={items} />);
    const ol = container.querySelector('ol') as HTMLOListElement;
    expect(ol.querySelectorAll(':scope > li')).toHaveLength(20);

    // 19 separators for 20 crumbs
    const separators = container.querySelectorAll('[aria-hidden="true"]');
    expect(separators).toHaveLength(19);
  });
});

// ---------------------------------------------------------------------------
// ariaLabel prop (backwards-compatible new prop)
// ---------------------------------------------------------------------------

describe('Breadcrumbs — ariaLabel prop', () => {
  it('defaults to "Breadcrumb" when ariaLabel is not provided', () => {
    render(<Breadcrumbs items={TWO_CRUMBS} />);
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
  });

  it('uses the supplied ariaLabel on the <nav> element', () => {
    render(<Breadcrumbs items={TWO_CRUMBS} ariaLabel="Contract navigation" />);
    expect(
      screen.getByRole('navigation', { name: 'Contract navigation' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument();
  });

  it('does not break any existing behaviour when ariaLabel is omitted', () => {
    render(<Breadcrumbs items={THREE_CRUMBS} />);
    // Verify all existing behaviour is intact when the new prop is unused.
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/');
    expect(screen.getByText('Contract #42')).toHaveAttribute('aria-current', 'page');
  });
});

// ---------------------------------------------------------------------------
// className prop (backwards-compatible new prop)
// ---------------------------------------------------------------------------

describe('Breadcrumbs — className prop', () => {
  it('applies the supplied className to the <nav> element', () => {
    render(<Breadcrumbs items={TWO_CRUMBS} className="mb-4 custom-class" />);
    const nav = screen.getByRole('navigation');
    expect(nav.className).toContain('mb-4');
    expect(nav.className).toContain('custom-class');
  });

  it('does not apply any className to the <nav> when omitted', () => {
    render(<Breadcrumbs items={TWO_CRUMBS} />);
    const nav = screen.getByRole('navigation');
    // className should be absent or empty — not have a leftover undefined/null value
    expect(nav.getAttribute('class')).toBeFalsy();
  });

  it('does not break any existing behaviour when className is omitted', () => {
    render(<Breadcrumbs items={THREE_CRUMBS} />);
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// displayName
// ---------------------------------------------------------------------------

describe('Breadcrumbs — displayName', () => {
  it('exposes a displayName of "Breadcrumbs"', () => {
    expect(Breadcrumbs.displayName).toBe('Breadcrumbs');
  });
});

// ---------------------------------------------------------------------------
// ReadonlyArray compatibility
// ---------------------------------------------------------------------------

describe('Breadcrumbs — ReadonlyArray items prop', () => {
  it('accepts a ReadonlyArray without TypeScript errors', () => {
    // This is primarily a compile-time contract; at runtime we verify the
    // component renders correctly when given an explicitly frozen (readonly) array.
    const items: ReadonlyArray<BreadcrumbItem> = Object.freeze([
      { label: 'Home', href: '/' },
      { label: 'Current' },
    ]);
    render(<Breadcrumbs items={items} />);
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText('Current')).toHaveAttribute('aria-current', 'page');
  });

  it('accepts a plain mutable array (backwards-compatible)', () => {
    const items: BreadcrumbItem[] = [
      { label: 'Home', href: '/' },
      { label: 'Current' },
    ];
    render(<Breadcrumbs items={items} />);
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });

  it('does not mutate the original items array', () => {
    const items: BreadcrumbItem[] = [
      { label: 'Home', href: '/' },
      { label: 'Current' },
    ];
    const originalLength = items.length;
    const originalFirst = { ...items[0] };
    render(<Breadcrumbs items={items} />);
    expect(items).toHaveLength(originalLength);
    expect(items[0]).toEqual(originalFirst);
  });
});

// ---------------------------------------------------------------------------
// Public type exports — contract stability
// ---------------------------------------------------------------------------

describe('Breadcrumbs — public type exports', () => {
  it('exports BreadcrumbItem type (shape: label + optional href)', () => {
    // Verify the shape by constructing a valid object — TypeScript would error
    // at compile time if the shape changed, but this test documents the contract.
    const item: BreadcrumbItem = { label: 'Test' };
    expect(item.label).toBe('Test');
    expect(item.href).toBeUndefined();

    const itemWithHref: BreadcrumbItem = { label: 'Test', href: '/test' };
    expect(itemWithHref.href).toBe('/test');
  });

  it('exports BreadcrumbsProps type (shape: items + optional ariaLabel + optional className)', () => {
    const props: BreadcrumbsProps = {
      items: [{ label: 'Test', href: '/test' }, { label: 'Current' }],
    };
    expect(props.items).toHaveLength(2);
    expect(props.ariaLabel).toBeUndefined();
    expect(props.className).toBeUndefined();
  });

  it('default export is Breadcrumbs component', () => {
    expect(typeof Breadcrumbs).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Regression — separator count after empty-label filtering
// ---------------------------------------------------------------------------

describe('Breadcrumbs — regression: separator count with filtered items', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('has N-1 separators after empty labels are filtered out', () => {
    // 4 items, 1 with empty label → 3 rendered crumbs → 2 separators
    const { container } = render(
      <Breadcrumbs
        items={[
          { label: 'Home', href: '/' },
          { label: '', href: '/bad' },   // filtered
          { label: 'Section', href: '/section' },
          { label: 'Current' },
        ]}
      />,
    );
    const separators = container.querySelectorAll('[aria-hidden="true"]');
    expect(separators).toHaveLength(2);

    const ol = container.querySelector('ol') as HTMLOListElement;
    expect(ol.querySelectorAll(':scope > li')).toHaveLength(3);
  });

  it('has exactly (n - 1) separators for n valid items after filtering nulls', () => {
    const items = [
      { label: 'A', href: '/a' },
      null,
      { label: 'B', href: '/b' },
      null,
      { label: 'C' },
    ] as unknown as BreadcrumbItem[];

    const { container } = render(<Breadcrumbs items={items} />);
    // 3 valid items → 2 separators
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
  });

  it('has exactly (n - 1) separators for n items after whitespace filtering', () => {
    const { container } = render(
      <Breadcrumbs
        items={[
          { label: 'A', href: '/a' },
          { label: '   ' },
          { label: 'B', href: '/b' },
          { label: '' },
          { label: 'C' },
        ]}
      />,
    );
    // 3 valid items → 2 separators
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Prop-change stability (re-render without remount)
// ---------------------------------------------------------------------------

describe('Breadcrumbs — re-render stability', () => {
  it('updates correctly when items prop changes', () => {
    const { rerender } = render(
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Page A' }]} />,
    );
    expect(screen.getByText('Page A')).toHaveAttribute('aria-current', 'page');

    rerender(
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Page B' }]} />,
    );
    expect(screen.queryByText('Page A')).not.toBeInTheDocument();
    expect(screen.getByText('Page B')).toHaveAttribute('aria-current', 'page');
  });

  it('transitions from non-empty to empty items array (renders null)', () => {
    const { rerender, container } = render(
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Current' }]} />,
    );
    expect(container.firstChild).not.toBeNull();

    rerender(<Breadcrumbs items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('transitions from empty to non-empty items array', () => {
    const { rerender, container } = render(<Breadcrumbs items={[]} />);
    expect(container.firstChild).toBeNull();

    rerender(<Breadcrumbs items={[{ label: 'Dashboard', href: '/' }, { label: 'Current' }]} />);
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByText('Current')).toHaveAttribute('aria-current', 'page');
  });

  it('collapses to null when items prop changes to an empty array', () => {
    const { rerender, container } = render(
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Page' }]} />,
    );
    expect(screen.getByRole('navigation')).toBeInTheDocument();

    rerender(<Breadcrumbs items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('recovers and renders correctly when items prop changes from empty to valid', () => {
    const { rerender } = render(<Breadcrumbs items={[]} />);

    rerender(
      <Breadcrumbs
        items={[
          { label: 'Dashboard', href: '/' },
          { label: 'Recovered' },
        ]}
      />,
    );
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    expect(screen.getByText('Recovered')).toHaveAttribute('aria-current', 'page');
  });
});

// ---------------------------------------------------------------------------
// Compatibility — existing caller contract (contracts/[id] page)
// ---------------------------------------------------------------------------

describe('Breadcrumbs — contracts page caller compatibility', () => {
  it('renders the standard contracts detail breadcrumb trail unchanged', () => {
    const id = 'contract-xyz';
    render(
      <Breadcrumbs
        items={[
          { label: 'Dashboard', href: '/' },
          { label: 'Contracts', href: '/contracts' },
          { label: `#${id}` },
        ]}
      />,
    );

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/');
    expect(within(nav).getByRole('link', { name: 'Contracts' })).toHaveAttribute(
      'href',
      '/contracts',
    );
    expect(within(nav).getByText(`#${id}`)).toHaveAttribute('aria-current', 'page');
    expect(within(nav).queryByRole('link', { name: `#${id}` })).not.toBeInTheDocument();
  });
});
