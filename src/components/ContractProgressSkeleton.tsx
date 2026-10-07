/**
 * Stateless placeholder rendered while contract milestones are loading.
 *
 * Mirrors the visual shape of `ContractProgress` with pulsing grey blocks,
 * and declares `aria-busy="true"` plus `aria-label="Loading escrow progress"`
 * so screen readers announce the loading state consistently with the other
 * skeleton components on the contract detail page.
 *
 * State invariants:
 * - This component is a pure, stateless presentational element. It must not
 *   read or mutate escrow domain state, and it must not accept or forward
 *   user input that could affect contract transitions.
 * - The loading announcement must remain deterministic and identical across
 *   renders: aria-busy="true" and a stable aria-label are always present.
 * - The component must not expose sensitive data (addresses, amounts, milestone
 *   names) while loading; all content is decorative and anonymous.
 * - Rendering must be idempotent and safe under concurrent or repeated
 *   renders (e.g. React StrictMode double-invoking), since it holds no mutable
 *   state and performs no side effects.
 */
/**
 * Accessible name announced while escrow progress is loading.
 *
 * Invariant: a single constant so the loading announcement is byte-identical on
 * every render, which is what makes repeated / concurrent renders of this
 * stateless placeholder observably idempotent.
 */
const CONTRACT_PROGRESS_LOADING_LABEL = 'Loading escrow progress';

/**
 * Id of the heading rendered by the live `ContractProgress` component.
 *
 * Referenced (not rendered) by the loading placeholder so the accessible name
 * is derived the same way in both states.
 */
export const CONTRACT_PROGRESS_HEADING_ID = 'contract-progress-title';

/**
 * A single decorative placeholder bar.
 *
 * Mirrors `components/Skeleton.tsx` but takes a raw class string, because this
 * placeholder mirrors fixed shapes from `ContractProgress` (heading row,
 * progress bar, two fund cards) rather than a generic width/height API.
 *
 * Invariants:
 *  - Always `aria-hidden="true"`: the surrounding `<section>` owns the
 *    accessible name, so exposing the blocks would add noise.
 *  - Carries `motion-reduce:animate-none` alongside the project-wide
 *    `prefers-reduced-motion` rule (belt and suspenders).
 */
const SkeletonBlock = ({ className }: { className: string }) => (
  <div
    aria-hidden="true"
    className={['animate-pulse', 'motion-reduce:animate-none', className]
      .filter(Boolean)
      .join(' ')}
  />
);

interface ContractProgressSkeletonProps {
  hasError?: boolean;
  onRetry?: () => void;
}

export const ContractProgressSkeleton = ({
  hasError = false,
  onRetry,
}: ContractProgressSkeletonProps) => {
  if (hasError) {
    return (
      <section
        role="alert"
        aria-labelledby="contract-progress-error-title"
        className="rounded-3xl border border-red-200 bg-red-50 p-6 shadow-sm"
      >
        <h2 id="contract-progress-error-title" className="text-lg font-semibold text-red-900">
          Escrow progress unavailable
        </h2>
        <p className="mt-2 text-sm text-red-700">
          Contract progress could not be loaded. Your saved contract data has not been changed.
        </p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 rounded-lg bg-red-800 px-4 py-2 text-sm font-medium text-white hover:bg-red-900 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
          >
            Retry
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <section
      aria-busy="true"
      // INV-2: `aria-labelledby` points at the id the live `ContractProgress`
      // heading will use, so the region's accessible name is computed the same
      // way before and after the loading → loaded swap. While that element does
      // not exist, the accname algorithm falls back to `aria-label`, so the name
      // is never empty and never changes.
      aria-labelledby={CONTRACT_PROGRESS_HEADING_ID}
      aria-label={CONTRACT_PROGRESS_LOADING_LABEL}
      data-testid="contract-progress-skeleton"
      className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm animate-pulse motion-reduce:animate-none"
    >
      {/* Heading */}
      <SkeletonBlock className="h-7 w-40 rounded-lg bg-slate-200" />

      <div className="mt-6 space-y-6">
        {/* Milestone count row + progress bar */}
        <div>
          <div className="flex items-center justify-between">
            <SkeletonBlock className="h-4 w-36 rounded bg-slate-200" />
            <SkeletonBlock className="h-4 w-12 rounded bg-slate-200" />
          </div>
          <SkeletonBlock className="mt-3 h-3 w-full rounded-full bg-slate-200" />
        </div>

        {/* Paid / Outstanding cards */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl bg-emerald-50 p-4">
            <SkeletonBlock className="h-4 w-10 rounded bg-emerald-200" />
            <SkeletonBlock className="mt-2 h-8 w-24 rounded-lg bg-emerald-200" />
          </div>
          <div className="rounded-2xl bg-amber-50 p-4">
            <SkeletonBlock className="h-4 w-20 rounded bg-amber-200" />
            <SkeletonBlock className="mt-2 h-8 w-24 rounded-lg bg-amber-200" />
          </div>
        </div>
      </div>
    </section>
  );
};
