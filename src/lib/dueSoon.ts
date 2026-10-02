/**
 * Parses a date string into a local Date object (setting the time to midnight local time)
 * while guarding against UTC timezone shifts.
 *
 * Invariants:
* - Returns null for any non-string, empty, or whitespace-only input.
 * - Strict `YYYY-MM-DD` inputs are validated as real calendar dates and constructed
 *   in local time to avoid UTC-to-local day shifts.
 * - Non-strict inputs fall back to `Date.parse` and are normalized to local midnight.
 * - Never throws; always returns either a valid Date or null.
 */
export function parseLocalDate(dateStr: string): Date | null {
  if (!dateStr || typeof dateStr !== 'string') return null;

  const trimmed = dateStr.trim();
  if (!trimmed) return null;

  // Handle YYYY-MM-DD specifically to prevent UTC-to-local shift
  const isoRegex = /^(\d{4})-(\d{2})-(\d{2})$/;
  const match = trimmed.match(isoRegex);
  if (match) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1; // 0-indexed month
    const day = parseInt(match[3], 10);
    const date = new Date(year, month, day);
    if (
      !isNaN(date.getTime()) &&
      date.getFullYear() === year &&
      date.getMonth() === month &&
      date.getDate() === day
    ) {
      return date;
    }
    // Matched the strict YYYY-MM-DD format but is not a real calendar date
    // (e.g. Feb 30th rolls over to March). Reject rather than loosely reparse.
    return null;
  }

  // Fallback to standard parsing
  const timestamp = Date.parse(trimmed);
  if (isNaN(timestamp)) return null;

  const date = new Date(trimmed);
  if (isNaN(date.getTime())) return null;

  // Normalize parsed date to local midnight
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Checks if a milestone's due date is soon (today or within windowDays from today).
 *
 * Invariants:
 * - Returns false for missing, malformed, or unparseable due dates.
 * - Returns false for negative or non-finite windows (preserves caller contract
 *   without silently widening the window).
 * - Comparison is inclusive of both endpoints (0 ... windowDays).
 * - Never throws; always returns a boolean.
 */
export function isDueSoon(dueDateStr: string | undefined, today: Date, windowDays: number): boolean {
  if (!dueDateStr) return false;

  // Guard against invalid windows so adverse inputs cannot widen or invert the
  // comparison window.
  if (typeof windowDays !== 'number' || !Number.isFinite(windowDays) || windowDays < 0) {
    return false;
  }

  // Guard against an invalid `today` reference so we do not silently compare
  // against NaN and return a deterministic false.
  if (!(today instanceof Date) || isNaN(today.getTime())) return false;

  const due = parseLocalDate(dueDateStr);
  if (!due) return false;

  // Normalize today's date to local midnight
  const current = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  // Difference in milliseconds
  const diffTime = due.getTime() - current.getTime();
  // Difference in days
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

  // Within the window (inclusive of 0 and windowDays)
  return diffDays >= 0 && diffDays <= windowDays;
}
