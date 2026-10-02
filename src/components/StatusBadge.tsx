/**
 * StatusBadge Component
 *
 * A reusable badge component that displays contract and milestone statuses
 * with an icon + label token, ensuring meaning is never conveyed by color alone.
 * Meets WCAG 2.1 AA requirements.
 */

export type StatusType = 'Active' | 'Completed' | 'Disputed' | 'Pending' | 'Paid' | 'Archived';

/**
 * Canonical set of acceptable statuses. Hoisted as a constant so the
 * bundler can inline membership checks and DCE the dev-only warning path.
 */
const KNOWN_STATUSES: ReadonlySet<StatusType> = new Set<StatusType>([
  'Active',
  'Completed',
  'Disputed',
  'Pending',
  'Paid',
  // `Archived` is a canonical StatusType with dedicated colour/icon entries,
  // so it must resolve through the known-status path, not the fallback.
  'Archived',
]);

export interface StatusBadgeProps {
  /** The status value to display */
  status: StatusType;
  /** Additional CSS classes to apply to the badge */
  className?: string;
}

/**
 * Unified color and style map for all status types.
 *
 * a11y/theming-27: previously these were fixed Tailwind pastel pairs
 * (e.g. `bg-emerald-100 text-emerald-800`) which never changed with
 * `data-theme`. Replaced with CSS variables defined in globals.css so
 * both themes get an audited, intentional pair.
 * Ratios recorded in docs/components/Accessibility.md.
 *
 * a11y/wallet-71-contrast: added `Archived` (neutral slate token pair) so
 * the wallet items list can reuse this shared, already-audited badge
 * instead of its own color-only inline pill. Ratios: 9.45:1 (light),
 * 9.85:1 (dark) — both well above WCAG AA's 4.5:1. See
 * docs/components/Accessibility.md.
 */
export const statusColorMap: Record<StatusType, string> = {
  Active: 'bg-[var(--status-success-bg)] text-[var(--status-success-foreground)]',
  Completed: 'bg-[var(--status-info-bg)] text-[var(--status-info-foreground)]',
  Disputed: 'bg-[var(--status-error-bg)] text-[var(--status-error-foreground)]',
  Pending: 'bg-[var(--status-warning-bg)] text-[var(--status-warning-foreground)]',
  Paid: 'bg-[var(--status-success-bg)] text-[var(--status-success-foreground)]',
  Archived: 'bg-[var(--status-neutral-bg)] text-[var(--status-neutral-foreground)]',
};

/** Non-color icon token paired with each status (aria-hidden; label provides text). */
export const statusIconMap: Record<StatusType, string> = {
  Active:    '▶',
  Completed: '✓',
  Disputed:  '⚠',
  Pending:   '⏳',
  Paid:      '✔',
  Archived:  '⊘',
};

/**
 * Fallback styling and icon for any status value that is outside the
 * `StatusType` union. The TypeScript type prevents this at compile time,
 * but runtime data (e.g. unvalidated API values) can still slip through;
 * we render gracefully rather than crashing.
 *
 * Uses the `--status-neutral-*` CSS variables so the fallback respects
 * the active theme. See docs/components/Accessibility.md for ratios.
 */
const FALLBACK_COLOR_CLASS =
  'bg-[var(--status-neutral-bg)] text-[var(--status-neutral-foreground)]';
const FALLBACK_ICON = '?';

/** Compile-time-friendly prod flag so the warning path can be DCE'd in production. */
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Runtime type-guard: returns `true` when the supplied value is one of
 * the five canonical contract/milestone statuses.
 */
export function isKnownStatus(value: unknown): value is StatusType {
  return typeof value === 'string' && KNOWN_STATUSES.has(value as StatusType);
}

/**
 * StatusBadge renders a pill with an icon + label for each status.
 * The icon is decorative (`aria-hidden`); meaning is also carried by the
 * visible label and `aria-label`, so it is never color-only.
 *
 * Unknown status values fall back to a neutral style, a question-mark
 * icon, and an aria-label that explicitly says "Unknown" along with the
 * raw value — preserving data while signalling the value is unrecognised.
 *
 * @example
 * ```tsx
 * <StatusBadge status="Completed" />
 * <StatusBadge status="Pending" className="ml-2" />
 * ```
 */
const StatusBadge = ({ status, className = '' }: StatusBadgeProps) => {
  const known = isKnownStatus(status);
  const rawText = String(status);

  if (!known && !IS_PRODUCTION) {
    // Surface unexpected values in development so callers can fix the
    // upstream data; production runs are intentionally silent.
    console.warn(
      `[StatusBadge] Unknown status value: "${rawText}". Falling back to neutral styling.`,
    );
  }

  const colorClass = known ? statusColorMap[status] : FALLBACK_COLOR_CLASS;
  const icon = known ? statusIconMap[status] : FALLBACK_ICON;
  const ariaLabel = known
    ? `Status: ${status}`
    : `Status: Unknown — value "${rawText}"`;
  const visibleLabel = known ? status : `Unknown (${rawText})`;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-semibold ${colorClass} ${className}`}
      role="status"
      aria-label={ariaLabel}
    >
      <span aria-hidden="true">{icon}</span>
      {visibleLabel}
    </span>
  );
};

export default StatusBadge;
