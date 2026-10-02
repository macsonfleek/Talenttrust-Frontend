import React from 'react';
import Link from 'next/link';

// ---------------------------------------------------------------------------
// Public types  (stable – do not remove or rename without a migration plan)
// ---------------------------------------------------------------------------

/** A single breadcrumb entry. Omit `href` for the current (final) crumb. */
export type BreadcrumbItem = {
  /** Visible label for this crumb. Must be a non-empty string. */
  label: string;
  /**
   * Navigation target. When provided the crumb renders as a Next.js `<Link>`.
   * Omit (or pass `undefined`) for the final crumb, which renders as plain
   * text with `aria-current="page"`.
   *
   * Invariant: ancestor crumbs (all crumbs except the last) must supply a
   * non-empty `href`. If `href` is omitted for an ancestor, the component
   * falls back to `"/"` and surfaces a console warning in development so the
   * caller can correct the data. This fallback is intentional: it keeps the
   * component operational in production while making the misconfiguration
   * obvious during development.
   */
  href?: string;
  /** Optional unique identifier for stable key assignment under concurrent re-renders. */
  id?: string;
  [key: string]: unknown;
};

export type BreadcrumbsProps = {
  /**
   * Ordered list of crumbs from root to current page.
   * The array is treated as immutable — the component never mutates it.
   * Empty string labels are silently filtered out and a warning is emitted in
   * development so callers can detect data problems without crashing.
   *
   * **Runtime safety**: `null` or `undefined` entries (which can appear when
   * data comes from untyped APIs) are silently dropped before rendering so
   * the component never throws on malformed input.
   */
  items?: ReadonlyArray<BreadcrumbItem>;
  /**
   * Accessible label for the `<nav>` landmark.
   * Defaults to `"Breadcrumb"`. Override when the page mounts multiple
   * `<nav>` elements so each has a unique label (WCAG 2.4.6).
   *
   * @default "Breadcrumb"
   */
  ariaLabel?: string;
  /**
   * Optional CSS class(es) applied to the outer `<nav>` element.
   * Allows layout-level overrides without additional wrapper elements.
   * Internal structural classes are not exposed and may change between
   * minor releases; callers should apply only additive layout classes here.
   */
  className?: string;
  /**
   * Optional route path used to derive the trail when `items` is omitted.
   *
   * Compatibility: `items` always takes precedence, so adding `path` cannot
   * change the output of an existing caller.
   */
  path?: string | null;
  /**
   * Visual separator rendered between crumbs. Purely decorative: it is always
   * `aria-hidden`, so changing it never affects the accessible name.
   *
   * @default "/"
   */
  separator?: React.ReactNode;
  /** Optional `data-testid` forwarded to the `<nav>` element. */
  'data-testid'?: string;
  /**
   * ARIA label override. Takes precedence over `ariaLabel` so callers that
   * spread raw DOM attributes keep working.
   */
  'aria-label'?: string;
};

// ---------------------------------------------------------------------------
// Invariant helpers
// ---------------------------------------------------------------------------

/**
 * Emits a warning in development. Noop in production to avoid log spam.
 *
 * @internal
 */
function warn(message: string): void {
  if (process.env.NODE_ENV !== 'production') {
    console.warn(`[Breadcrumbs] ${message}`);
  }
}

/**
 * Validates and sanitises the items array before render.
 *
 * Invariants enforced:
 *  1. `null` / `undefined` entries are silently dropped (runtime safety for
 *     data arriving from untyped APIs; TypeScript callers should never pass
 *     these but production code must not crash on them).
 *  2. Empty-string labels are removed (they create invisible, non-descriptive
 *     accessible elements). A dev warning is emitted.
 *  3. Ancestor crumbs (not the last item) without an `href` receive a `"/"`
 *     fallback so the DOM is always valid, and a dev warning is emitted.
 *
 * @internal
 */
function sanitiseItems(items: ReadonlyArray<BreadcrumbItem>): BreadcrumbItem[] {
  const filtered: BreadcrumbItem[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    // Guard: null/undefined entries from untyped runtime data.
    if (item == null) {
      warn(
        `items[${i}] is ${String(item)} and will be ignored. ` +
          'Every breadcrumb entry must be a valid BreadcrumbItem object.',
      );
      continue;
    }

    // Guard: empty-string label produces an invisible accessible element.
    if (!item.label.trim()) {
      warn(
        `items[${i}] has an empty label and will be ignored. ` +
          'Every breadcrumb crumb must have a visible, non-empty label.',
      );
      continue;
    }

    filtered.push(item);
  }

  // After filtering, warn about ancestor crumbs that lack an href.
  // The warning fires here (not during render) so it is emitted once per
  // render cycle regardless of list length.
  for (let i = 0; i < filtered.length - 1; i++) {
    if (!filtered[i].href) {
      warn(
        `items[${i}] ("${filtered[i].label}") is an ancestor crumb with no ` +
          'href. Falling back to "/" — pass an explicit href to silence this warning.',
      );
    }
  }

  return filtered;
}

/**
 * Returns a stable, unique React key for a crumb.
 *
 * Strategy: prefer the item's href when present (typically unique per crumb),
 * combined with the index as a tiebreaker. This ensures that duplicate labels
 * with different hrefs (e.g. two "Home" entries pointing to different routes)
 * do not collide, while the index prevents any remaining collisions.
 *
 * @internal
 */
function crumbKey(item: BreadcrumbItem, index: number): string {
  return `${item.href ?? ''}-${item.label}-${index}`;
}

/**
 * Formats a single path segment into a human-readable crumb label.
 *
 * Invariants:
 *  - A purely numeric segment becomes `#<n>` so contract/milestone ids read
 *    naturally in the trail.
 *  - `-` / `_` become spaces and each word is capitalised.
 *  - Never throws; a segment that cannot be decoded is used verbatim.
 *
 * @internal
 */
export function formatSegmentLabel(segment: string): string {
  if (!segment) return '';
  if (/^\d+$/.test(segment)) {
    return `#${segment}`;
  }
  return segment
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Derives a breadcrumb trail from a route path.
 *
 * Determinism is the contract here: the same `path` always yields the same
 * array, and the result never depends on navigation history or timing, so
 * concurrent prop updates can only ever converge on the trail for the path
 * that is currently rendered.
 *
 * Invariants:
 *  - `null`, `undefined`, blank, and root-only inputs degrade predictably
 *    (`[]` for blank, a single Home crumb for `/`).
 *  - Query strings and hash fragments are stripped before segmentation, so
 *    `?tab=`/`#anchor` can never become part of a label or an href.
 *  - Repeated, leading, and trailing slashes collapse: `///contracts///` and
 *    `/contracts` produce identical output.
 *  - The final crumb never carries an `href` (it is the current page).
 *
 * @param path - Route path, optionally including a query string or hash.
 * @returns A fresh, ordered crumb list rooted at Home.
 */
export function createBreadcrumbsFromPath(path?: string | null): BreadcrumbItem[] {
  if (!path || typeof path !== 'string') return [];

  const cleanPath = path.split(/[?#]/)[0].trim();
  if (!cleanPath) return [];
  if (cleanPath === '/') {
    return [{ label: 'Home', href: '/' }];
  }

  const segments = cleanPath
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return [{ label: 'Home', href: '/' }];
  }

  const items: BreadcrumbItem[] = [{ label: 'Home', href: '/' }];
  let accumulatedPath = '';

  for (let i = 0; i < segments.length; i++) {
    const rawSegment = segments[i];
    let decodedSegment = rawSegment;
    try {
      decodedSegment = decodeURIComponent(rawSegment);
    } catch {
      // Malformed percent-encoding: keep the raw segment rather than throwing,
      // so a bad URL degrades to a slightly ugly label instead of a blank page.
    }

    accumulatedPath += `/${rawSegment}`;
    const isLast = i === segments.length - 1;

    items.push({
      label: formatSegmentLabel(decodedSegment),
      ...(isLast ? {} : { href: accumulatedPath }),
    });
  }

  return items;
}

/**
 * Normalizes caller-supplied items, falling back to `path` when no usable array
 * was given.
 *
 * Invariants:
 *  - Non-objects, and objects with a blank label, are dropped.
 *  - `href` values using an unsafe scheme (`javascript:`, `data:`,
 *    `vbscript:`) are stripped while the crumb itself is preserved, so the user
 *    still sees the trail and can navigate away.
 *  - `items` always wins over `path`; `path` is only consulted when `items` is
 *    absent or not an array. This keeps the two sources from interleaving.
 *
 * @param rawItems - Untrusted caller input.
 * @param path - Optional route path used when `rawItems` is unusable.
 */
export function normalizeBreadcrumbItems(
  rawItems?: unknown,
  path?: string | null,
): BreadcrumbItem[] {
  if (Array.isArray(rawItems)) {
    const normalized: BreadcrumbItem[] = [];
    for (let i = 0; i < rawItems.length; i++) {
      const item = rawItems[i];
      if (!item || typeof item !== 'object') {
        warn(
          `items[${i}] is ${String(item)} and will be ignored. ` +
            'Every breadcrumb entry must be a valid BreadcrumbItem object.',
        );
        continue;
      }
      const rawObj = item as Record<string, unknown>;
      const label =
        typeof rawObj.label === 'string'
          ? rawObj.label.trim()
          : String(rawObj.label ?? '').trim();

      if (!label) {
        warn(
          `items[${i}] has an empty label and will be ignored. ` +
            'Every breadcrumb crumb must have a visible, non-empty label.',
        );
        continue;
      }

      let href =
        typeof rawObj.href === 'string' ? rawObj.href.trim() : undefined;

      // Disallow unsafe URI schemes.
      if (href && /^(javascript|data|vbscript):/i.test(href)) {
        href = undefined;
      }

      const { href: _unusedHref, ...restItem } = rawObj;

      normalized.push({
        ...restItem,
        label,
        ...(href !== undefined ? { href } : {}),
      });
    }
    return normalized;
  }

  if (typeof path === 'string' && path.trim().length > 0) {
    return createBreadcrumbsFromPath(path);
  }

  return [];
}

/**
 * Longest breadcrumb label rendered before the crumb is dropped as malformed.
 * Real labels are far shorter; the cap bounds layout and screen-reader output
 * for hand-edited or hostile input.
 */
const MAX_LABEL_LENGTH = 120;

/**
 * Longest breadcrumb `href` accepted. Keeps navigation targets plausible and
 * prevents oversized URLs from being rendered into the DOM.
 */
const MAX_HREF_LENGTH = 2048;

/** Type guard for a non-empty string. */
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** Result of {@link normalizeBreadcrumbs}. */
export type NormalizedBreadcrumbs = {
  /** Crumbs that survived validation, in display order. */
  items: BreadcrumbItem[];
  /** How many entries were discarded as malformed. */
  droppedInvalidCount: number;
  /** How many consecutive duplicates were collapsed. */
  dedupedCount: number;
};

/**
 * Return true when `href` is a safe, renderable navigation target.
 *
 * We only accept relative paths and http(s) URLs. This blocks dangerous
 * schemes such as `javascript:`, `data:`, `vbscript:`, and `mailto:` from
 * being rendered as a `<Link>`. Control characters and whitespace are
 * rejected because they can be used to obfuscate dangerous schemes.
 */
export const isSafeBreadcrumbHref = (href: unknown): href is string => {
  if (!isNonEmptyString(href)) return false;
  if (href.length > MAX_HREF_LENGTH) return false;
  // Reject control characters and newlines. Matching them is the point: they
  // are how a `javascript:` scheme gets obfuscated past a naive prefix check.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(href)) return false;
  // Reject leading/trailing whitespace.
  if (href !== href.trim()) return false;

  // Relative path (including protocol-relative `//`) is always allowed.
  if (href.startsWith('/')) return true;

  // Absolute URLs: only http and https.
  try {
    const parsed = new URL(href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Normalize and validate a list of breadcrumb items.
 *
 * This function is pure and deterministic: the same input always produces
 * the same output. It is the single source of truth for what the component
 * will render, which makes failure recovery and testing straightforward.
 *
 * Invariants:
 * - Every returned item has a non-empty, trimmed label.
 * - Every returned item has a safe `href` or no `href` at all.
 * - Duplicate consecutive labels are collapsed to a single crumb.
 * - The last item is always treated as the current page (no `href`).
 */
export const normalizeBreadcrumbs = (items: unknown): NormalizedBreadcrumbs => {
  const safeItems = Array.isArray(items) ? items : [];

  const normalized: BreadcrumbItem[] = [];
  let droppedInvalidCount = 0;
  let dedupedCount = 0;

  for (const rawItem of safeItems) {
    if (!rawItem || typeof rawItem !== 'object') {
      droppedInvalidCount += 1;
      continue;
    }

    const candidate = rawItem as { label?: unknown; href?: unknown };
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';

    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
      droppedInvalidCount += 1;
      continue;
    }

    const hasHref = candidate.href !== undefined && candidate.href !== null;
    const href = hasHref && isSafeBreadcrumbHref(candidate.href)
      ? (candidate.href as string)
      : undefined;

    if (hasHref && href === undefined) {
      // Unsafe or malformed href: drop the href but keep the label so the
      // user still sees the trail and can recover via other navigation.
      droppedInvalidCount += 1;
    }

    const previous = normalized[normalized.length - 1];
    if (previous && previous.label === label && previous.href === href) {
      dedupedCount += 1;
      continue;
    }

    normalized.push(href === undefined ? { label } : { label, href });
  }

  // The final crumb is always the current page: drop any `href` on it.
  if (normalized.length > 0) {
    const last = normalized[normalized.length - 1];
    if (last.href !== undefined) {
      normalized[normalized.length - 1] = { label: last.label };
    }
  }

  return { items: normalized, droppedInvalidCount, dedupedCount };
};

/**
 * Accessible breadcrumb navigation component.
 *
 * ## Compatibility contract
 * - **Exports** `BreadcrumbItem`, `BreadcrumbsProps`, and the default export
 *   `Breadcrumbs` are stable public API. Do not remove or rename them.
 * - **`items` prop** is `ReadonlyArray<BreadcrumbItem>` — the component never
 *   mutates the array.
 * - **Empty arrays** render nothing (`null`). Callers may rely on this.
 * - **`null`/`undefined` entries** are silently dropped with a dev warning;
 *   the component never throws on runtime data from untyped APIs.
 * - **Empty-string labels** are silently filtered with a dev warning; callers
 *   should never pass them but will not crash if they do.
 * - **Missing ancestor `href`** falls back to `"/"` with a dev warning.
 * - **`ariaLabel`** defaults to `"Breadcrumb"`. Existing callers that omit
 *   this prop are unaffected.
 * - **`className`** defaults to `undefined`. Existing callers are unaffected.
 * - The focus ring uses `var(--ring)` (theme token) — not a hardcoded colour.
 *
 * ## Render structure
 * ```
 * <nav aria-label="Breadcrumb">
 *   <ol>
 *     <li>                          ← ancestor crumbs
 *       <Link href="…">label</Link>
 *     </li>
 *     …
 *     <li>                          ← current page
 *       <span aria-current="page">label</span>
 *     </li>
 *   </ol>
 * </nav>
 * ```
 *
 * @example
 * ```tsx
 * <Breadcrumbs
 *   items={[
 *     { label: 'Dashboard', href: '/' },
 *     { label: 'Contracts', href: '/contracts' },
 *     { label: 'Contract #42' },
 *   ]}
 * />
 * ```
 *
 * @example Customise the nav label when multiple navigations are on one page:
 * ```tsx
 * <Breadcrumbs
 *   ariaLabel="Contract navigation"
 *   items={[{ label: 'Dashboard', href: '/' }, { label: 'Contract #42' }]}
 * />
 * ```
 *
 * @example Pass a layout class to the nav wrapper:
 * ```tsx
 * <Breadcrumbs className="mb-4" items={[…]} />
 * ```
 */
const Breadcrumbs = ({
  items,
  path,
  separator = '/',
  ariaLabel = 'Breadcrumb',
  'aria-label': ariaLabelAttribute,
  'data-testid': dataTestId,
  className,
}: BreadcrumbsProps): React.ReactElement | null => {
  // Resolve the single source of the trail: explicit `items` when supplied,
  // otherwise derived from `path`. Both go through the same normalisation and
  // sanitisation pipeline, so a path-derived trail can never bypass the
  // unsafe-href or empty-label invariants.
  const resolved = normalizeBreadcrumbItems(items, path);
  // Sanitise once per render; results memoised implicitly by React's reconciler.
  const crumbs = sanitiseItems(resolved);

  // Invariant: empty list (after sanitisation) renders nothing.
  if (crumbs.length === 0) return null;

  // `aria-label` (raw DOM attribute) wins over the `ariaLabel` convenience prop.
  const accessibleName = ariaLabelAttribute ?? ariaLabel;

  return (
    <nav
      aria-label={accessibleName}
      className={className}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
    >
      <ol className="flex flex-wrap items-center gap-1 text-sm text-slate-500">
        {crumbs.map((item, index) => {
          const isLast = index === crumbs.length - 1;

          return (
            <li key={crumbKey(item, index)} className="flex items-center gap-1">
              {/* Separator — hidden from screen readers */}
              {index > 0 && (
                <span aria-hidden="true" className="select-none text-slate-400">
                  {separator}
                </span>
              )}

              {isLast ? (
                // Current page: plain text, no link, aria-current for AT.
                // title exposes the full label when display is truncated.
                <span
                  aria-current="page"
                  title={item.label}
                  className="font-medium text-slate-900 truncate max-w-[16rem]"
                >
                  {item.label}
                </span>
              ) : (
                // Ancestor: linked crumb.
                // href falls back to "/" when absent (see sanitiseItems warning).
                // title exposes the full label when display is truncated.
                <Link
                  href={item.href ?? '/'}
                  title={item.label}
                  className="truncate max-w-[16rem] transition hover:text-slate-900 hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2"
                >
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

// displayName makes the component identifiable in React DevTools and error
// boundary stack traces.
Breadcrumbs.displayName = 'Breadcrumbs';

export default Breadcrumbs;
