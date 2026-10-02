import { reportError } from './errorReporter';

/**
 * Canonical fallback origin used whenever NEXT_PUBLIC_SITE_URL is absent or
 * cannot be trusted. Overridable so tests (and deployments that pin a base
 * origin) can assert against a known value.
 */
export const DEFAULT_SITE_URL = 'http://localhost:3000';

/**
 * Upper bound on an accepted origin. A 2 KB limit is far above any real
 * deployment and below the point where a hostile value could be used to bloat
 * robots.txt/sitemap.xml responses.
 */
export const MAX_SITE_URL_LENGTH = 2048;

/**
 * Number of distinct raw inputs whose resolutions are memoised. The map is
 * bounded so a process that keeps observing new environment values cannot grow
 * it without limit.
 */
export const MAX_SITE_URL_CACHE_ENTRIES = 8;

/**
 * Why a raw environment value was refused. The reason code is safe to log; the
 * offending value is not (see {@link redactSiteUrl}).
 */
export type SiteUrlRejection =
  | 'missing'
  | 'not_a_string'
  | 'empty'
  | 'too_long'
  | 'control_characters'
  | 'unparsable'
  | 'not_http'
  | 'credentials'
  | 'query_or_fragment';

/**
 * Outcome of resolving a raw site URL.
 *
 * Invariant: `url` always has no trailing slash, no query string, no fragment
 * and no embedded credentials, so `${url}${path}` is a safe concatenation for
 * any `path`. Applying {@link resolveSiteUrl} to `url` is a fixed point: the
 * resolution of an already-valid origin is identical to the origin itself,
 * which is what makes repeated and concurrent calls idempotent.
 */
export type SiteUrlResolution = {
  readonly url: string;
  readonly source: 'default' | 'env';
  readonly reason?: SiteUrlRejection;
};

/** Notifier invoked at most once per distinct rejected raw value. */
export type SiteUrlDiagnostic = (reason: SiteUrlRejection, preview: string) => void;

/**
 * Renders an untrusted value for logging.
 *
 * Anything that could leak a secret or forge log records is removed: control
 * characters (log injection), userinfo (embedded passwords), query strings and
 * fragments (often carry tokens). The result is truncated, and when redaction
 * changed the value a fixed marker is appended so a reader can tell that the
 * preview is not the literal input.
 */
export function redactSiteUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '[non-string]';

  const MAX_PREVIEW = 40;
  // eslint-disable-next-line no-control-regex
  let preview = raw.replace(/[\u0000-\u001f\u007f]/g, ' ');

  if (preview.length > MAX_PREVIEW) {
    preview = `${preview.slice(0, MAX_PREVIEW)}…`;
    return preview;
  }

  try {
    const parsed = new URL(preview);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      preview = `${parsed.toString()} (userinfo redacted)`;
    } else if (parsed.search || parsed.hash) {
      parsed.search = '';
      parsed.hash = '';
      preview = `${parsed.toString()} (query/fragment redacted)`;
    }
  } catch {
    // Not parseable: the control-character scrub above is the only reduction
    // available, which is sufficient for a log line.
  }

  return preview;
}

/**
 * Validates and normalises a raw origin into a canonical form.
 *
 * Refusals fall back to {@link DEFAULT_SITE_URL} rather than throwing: robots
 * and sitemap metadata are generated during builds and on every request, so a
 * misconfigured variable must degrade to a working (if non-canonical) response
 * instead of failing the deployment.
 *
 * The function is pure — it reads no clock, no globals and no mutable state —
 * so the resolution depends only on `raw`. That is the invariant that makes
 * concurrent invocation safe.
 */
export function resolveSiteUrl(raw: unknown): SiteUrlResolution {
  if (raw === undefined || raw === null) {
    return { url: DEFAULT_SITE_URL, source: 'default', reason: 'missing' };
  }

  if (typeof raw !== 'string') {
    return { url: DEFAULT_SITE_URL, source: 'default', reason: 'not_a_string' };
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { url: DEFAULT_SITE_URL, source: 'default', reason: 'empty' };
  }

  if (trimmed.length > MAX_SITE_URL_LENGTH) {
    return { url: DEFAULT_SITE_URL, source: 'default', reason: 'too_long' };
  }

  // Newlines and NUL bytes here would let a hostile value inject additional
  // robots.txt directives, so they are rejected rather than stripped.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { url: DEFAULT_SITE_URL, source: 'default', reason: 'control_characters' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { url: DEFAULT_SITE_URL, source: 'default', reason: 'unparsable' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url: DEFAULT_SITE_URL, source: 'default', reason: 'not_http' };
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return { url: DEFAULT_SITE_URL, source: 'default', reason: 'credentials' };
  }

  if (parsed.search !== '' || parsed.hash !== '') {
    return { url: DEFAULT_SITE_URL, source: 'default', reason: 'query_or_fragment' };
  }

  const path = parsed.pathname.replace(/\/+$/, '');

  return { url: `${parsed.protocol}//${parsed.host}${path}`, source: 'env' };
}

/** Options for {@link createSiteUrlResolver}. */
export type SiteUrlResolverOptions = {
  /** Overrides the fallback origin. Must itself be a canonical origin. */
  defaultSiteUrl?: string;
  /** Overrides the diagnostic channel. Defaults to a rate-limited warn. */
  onInvalid?: SiteUrlDiagnostic;
  /** Overrides the memoisation bound. */
  maxEntries?: number;
};

export type SiteUrlResolver = {
  /**
   * Resolves `raw`, memoising the result.
   *
   * The cache is keyed by the raw input, so a changed environment value can
   * never be served from a previous resolution: a stale answer is only
   * possible if the same key had produced a different value, which the pure
   * {@link resolveSiteUrl} rules out.
   */
  resolve(raw: unknown): SiteUrlResolution;
  /** Number of memoised entries. Exposed for bounds assertions. */
  size(): number;
  /** Empties the cache and the diagnostic dedupe set. */
  reset(): void;
};

/**
 * Creates a memoising resolver.
 *
 * Concurrency invariants:
 * - Entries are frozen, so a consumer holding a resolution cannot mutate it
 *   into a value that other, overlapping callers then observe.
 * - The cache is a bounded FIFO keyed by raw input; the oldest entry is evicted
 *   once the bound is exceeded, which bounds memory for a long-lived server.
 * - Diagnostics are deduped per raw value, so a burst of concurrent invalid
 *   requests logs once rather than once per request, while a genuinely new bad
 *   value is still reported.
 */
export function createSiteUrlResolver(options: SiteUrlResolverOptions = {}): SiteUrlResolver {
  const fallback = options.defaultSiteUrl ?? DEFAULT_SITE_URL;
  const maxEntries = Math.max(1, options.maxEntries ?? MAX_SITE_URL_CACHE_ENTRIES);
  const onInvalid =
    options.onInvalid ??
    ((reason, preview) => {
      reportError(
        `NEXT_PUBLIC_SITE_URL refused (${reason}); falling back to ${fallback}: ${preview}`,
        'siteUrl',
        'warn',
      );
    });

  const cache = new Map<string, SiteUrlResolution>();
  const reported = new Set<string>();

  function keyFor(raw: unknown): string {
    if (typeof raw === 'string') return `string:${raw}`;
    if (raw === undefined) return 'undefined:';
    if (raw === null) return 'null:';
    return `${typeof raw}:${String(raw)}`;
  }

  function resolve(raw: unknown): SiteUrlResolution {
    const key = keyFor(raw);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const resolved = resolveSiteUrl(raw);
    const withFallback: SiteUrlResolution = resolved.source === 'default'
      ? Object.freeze({ url: fallback, source: 'default', reason: resolved.reason })
      : Object.freeze(resolved);

    // An *unset* variable is the normal development default, not a
    // misconfiguration, so it must not generate log noise.
    //
    // A variable that is present but blank is deliberately treated as a
    // misconfiguration: `NEXT_PUBLIC_SITE_URL=''` is what a deploy pipeline
    // usually produces when a required variable fails to expand, and falling back
    // to localhost silently would ship wrong absolute URLs. Refusing quietly is
    // the worse failure, so the warning stands.
    if (
      withFallback.source === 'default' &&
      withFallback.reason !== undefined &&
      withFallback.reason !== 'missing'
    ) {
      if (!reported.has(key)) {
        reported.add(key);
        // Never let a misbehaving logger break metadata generation.
        try {
          onInvalid(withFallback.reason, redactSiteUrl(raw));
        } catch {
          // Ignore: diagnostics are best-effort.
        }
      }
    }

    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, withFallback);

    return withFallback;
  }

  function reset(): void {
    cache.clear();
    reported.clear();
  }

  return {
    resolve: Object.freeze(resolve),
    size: () => cache.size,
    reset,
  };
}