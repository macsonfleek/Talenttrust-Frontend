'use client';

import { useCallback, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { reportError } from '@/lib/errorReporter';
import {
  NO_PATH_REPORT_KEY,
  planNotFoundRecovery,
  sanitizeMissingPath,
} from '@/lib/notFoundRecovery';

/**
 * Validation boundaries for the 404 page.
 *
 * The 404 page is a recovery surface: every link it renders is a
 * potential navigation target for a user who already landed on a broken
 * URL. A malformed or unsafe link here would compound the failure
 * (silent redirect to an external origin, open redirect, or a second 404),
 * so the link table is validated at module load time and invalid entries
 * are dropped rather than rendered.
 *
 * Invariants:
 *  1. Every rendered href is a non-empty string.
 *  2. Every rendered href is either an internal absolute path (`/`-prefixed,
 *     no protocol, no backslash, no control characters, no dot-dot segments)
 *     or a `mailto:` link with a structurally valid address.
 *  3. Duplicate hrefs are de-duplicated keeping the first occurrence, so
 *     React keys remain stable and unique.
 *  4. Labels and descriptions are non-empty and length-bounded so the
 *     layout cannot be degraded by a bad entry.
 *  5. If every quick link is rejected, the nav is omitted entirely and the
 *     primary recovery actions (Go Home / Contact Support) still render.
 */

export const MAX_LINK_LABEL_LENGTH = 60;
export const MAX_LINK_DESCRIPTION_LENGTH = 120;

// Control characters (C0-C1, the latter including the U+007F DEL boundary)
// and backslashes are never valid in a href we render.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;
const DOT_SEGMENT_RE = /(^|\/)\.\.?(\/|$)/;
const MAILTO_RE = /^mailto:[^\s@"]+@[^\s@"]+\.[^\s@."]+$/;

export interface QuickLink {
  href: string;
  label: string;
  description: string;
}

export interface QuickLinkInput {
  href?: unknown;
  label?: unknown;
  description?: unknown;
}

function normalizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return null;
  }

  if (CONTROL_CHAR_RE.test(trimmed)) {
    return null;
  }

  return trimmed;
}

export function isValidInternalHref(href: string): boolean {
  if (!href.startsWith('/')) {
    return false;
  }

  // `//` would be interpreted as a protocol-relative URL by browsers.
  if (href.startsWith('//')) {
    return false;
  }

  if (href.includes('\\') || href.includes(':')) {
    return false;
  }

  if (CONTROL_CHAR_RE.test(href)) {
    return false;
  }

  // Reject path traversal segments (`..`, `.`) anywhere in the path.
  if (DOT_SEGMENT_RE.test(href)) {
    return false;
  }

  return true;
}

export function isValidMailtoHref(href: string): boolean {
  if (CONTROL_CHAR_RE.test(href)) {
    return false;
  }

  return MAILTO_RE.test(href);
}

export function isValidHref(href: unknown): boolean {
  if (typeof href !== 'string') {
    return false;
  }

  if (href.length === 0 || href.length > 2048) {
    return false;
  }

  if (href !== href.trim()) {
    return false;
  }

  if (href.startsWith('mailto:')) {
    return isValidMailtoHref(href);
  }

  return isValidInternalHref(href);
}

/**
 * Validates and normalizes a single quick-link entry. Returns `null` for
 * any entry that cannot safely be rendered.
 */
export function validateQuickLink(input: QuickLinkInput): QuickLink | null {
  if (input === null || typeof input !== 'object') {
    return null;
  }

  const href = typeof input.href === 'string' ? input.href.trim() : null;
  if (href === null || !isValidHref(href)) {
    return null;
  }

  const label = normalizeText(input.label, MAX_LINK_LABEL_LENGTH);
  if (label === null) {
    return null;
  }

  const description = normalizeText(input.description, MAX_LINK_DESCRIPTION_LENGTH);
  if (description === null) {
    return null;
  }

  return { href, label, description };
}

/**
 * Validates a list of quick links, dropping invalid entries and
 * de-uplicating by `href` (first occurrence wins). The function is pure and
 * deterministic: the same input always yields the same output, and it never
 * throws — malformed input is reported as a dropped entry instead.
 */
export function validateQuickLinks(inputs: unknown): QuickLink[] {
  if (!Array.isArray(inputs)) {
    return [];
  }

  const seen = new Set<string>();
  const valid: QuickLink[] = [];

  for (const candidate of inputs) {
    const link = validateQuickLink(typeof candidate === 'object' && candidate !== null ? (candidate as QuickLinkInput) : {});

    if (link === null) {
      continue;
    }

    if (seen.has(link.href)) {
      continue;
    }

    seen.add(link.href);
    valid.push(link);
  }

  return valid;
}

// Static definition of the quick links. Kept as `unknown` so the validator
// is the single source of truth for what is renderable.
const quickLinkInputs: unknown = [
  {
    href: '/contracts',
    label: 'View Contracts',
    description: 'Pick up where you left off',
  },
  {
    href: '/milestones',
    label: 'Track Milestones',
    description: 'See your project checkpoints',
  },
  {
    href: '/reputation',
    label: 'My Reputation',
    description: 'Check your work history',
  },
];

// Validate once at module load time. This is deterministic and avoids re
// validating on every render. Invalid entries are silently dropped.
const quickLinks: QuickLink[] = validateQuickLinks(quickLinkInputs);

// Primary recovery actions. These are fixed and validated at module load time
// so the 404 page always offers at least one working way out.
export const HOME_HREF = '/';
export const SUPPORT_HREF = 'mailto:support@talenttrust.io';

if (!isValidHref(HOME_HREF)) {
  throw new Error('NotFound: invalid home href');
}

if (!isValidHref(SUPPORT_HREF)) {
  throw new Error('NotFound: invalid support href');
}

export default function NotFound() {
  const pathname = usePathname();
  const router = useRouter();

  // Deterministically sanitize the untrusted path: only a safe, rooted,
  // query-free path is ever shown or logged. `null` yields a stable fallback.
  const displayPath = sanitizeMissingPath(pathname);

  // De-duplication guard keyed on the sanitized path. React StrictMode
  // double-invokes effects and transient re-renders must not spam the reporter,
  // but a genuinely different missing route (different key) is still reported.
  const reportKey = displayPath ?? NO_PATH_REPORT_KEY;
  const reportedRef = useRef<string | null>(null);

  useEffect(() => {
    if (reportedRef.current === reportKey) {
      return;
    }
    reportedRef.current = reportKey;
    // Level 'warn': a 404 is an expected adverse condition, not a crash. The
    // sanitized path (never the query) keeps this diagnosable without leaking
    // session tokens or other secrets that live in the URL.
    reportError(new Error('Route not found'), 'not-found', 'warn', {
      path: displayPath ?? 'unknown',
    });
  }, [reportKey, displayPath]);

  const handleGoBack = useCallback(() => {
    // Decide at click time so the behaviour tracks the live history depth
    // rather than a possibly stale render-time snapshot.
    const action = planNotFoundRecovery(window.history.length);
    if (action === 'back') {
      // Return to the previous document; the app router restores it without a
      // full reload, preserving in-memory state.
      window.history.back();
    } else {
      // No history to return to: client-side navigation to the root keeps
      // persisted data and in-memory state intact (no hard reload).
      router.push('/');
    }
  }, [router]);

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8 bg-[var(--background)]">
      <div className="max-w-md w-full text-center space-y-8">
        <div aria-hidden="true" className="text-6xl font-bold text-gray-200">
          404
        </div>

        <div className="space-y-3">
          <h1 className="text-2xl font-bold text-gray-900">Page Not Found</h1>
          <p className="text-gray-600">
            This page doesn&apos;t exist or the link may have expired. Here are
            a few places to get back on track.
          </p>
          {displayPath !== null ? (
            <p className="text-sm text-gray-500">
              We couldn&apos;t find{' '}
              <code className="px-1 py-0.5 rounded bg-gray-100 text-gray-700 break-all">
                {displayPath}
              </code>
              .
            </p>
          ) : (
            <p className="text-sm text-gray-500">
              We couldn&apos;t identify the page you were looking for.
            </p>
          )}
        </div>

        {quickLinks.length > 0 ? (
          <nav aria-label="Quick links">
            <h2 className="sr-only">Where would you like to go?</h2>
            <ul className="flex flex-col gap-3">
              {quickLinks.map(({ href, label, description }) => (
                <li key={href}>
                  <Link
                    href={href}
                    className="flex flex-col items-center sm:flex-row sm:items-center gap-1 sm:gap-3 px-5 py-3 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
                  >
                    <span className="font-medium text-gray-900">{label}</span>
                    <span className="hidden sm:inline text-gray-400">—</span>
                    <span className="text-sm text-gray-500">{description}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button
            type="button"
            onClick={handleGoBack}
            className="px-5 py-2 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
          >
            Go Back
          </button>
          <Link
            href={HOME_HREF}
            className="px-5 py-2 rounded-lg bg-gray-900 text-white font-medium hover:bg-gray-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
          >
            Go Home
          </Link>
          <a
            href={SUPPORT_HREF}
            className="px-5 py-2 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
          >
            Contact Support
          </a>
        </div>
      </div>
    </main>
  );
}
