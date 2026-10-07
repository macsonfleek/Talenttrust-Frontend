import type { MetadataRoute } from 'next';
import sitemap, {
  buildSitemap,
  resolveSitemapBaseUrl,
  DEFAULT_SITE_URL,
  SITEMAP_MAX_URLS,
  SITEMAP_ROUTES,
  SITEMAP_INVALID_TIMESTAMP_CODE,
  SITEMAP_ROUTE_DROPPED_CODE,
  SITEMAP_SITE_URL_REJECTED_CODE,
  SITEMAP_SITE_URL_SANITIZED_CODE,
  SITEMAP_TRUNCATED_CODE,
} from '../sitemap';
import { setErrorReporter } from '@/lib/errorReporter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-02-03T04:05:06.000Z');

/** Report spy shaped like the central `ErrorReporter`. */
const createReportSpy = () => {
  const fn = jest.fn();
  return {
    fn,
    callsFor: (code: string) => fn.mock.calls.filter((call) => (call[3] as { code?: string })?.code === code),
    reasons: (code: string) =>
      fn.mock.calls
        .filter((call) => (call[3] as { code?: string })?.code === code)
        .map((call) => (call[3] as { reason?: string }).reason),
  };
};

/** Asserts the S1 output invariant over a whole document. */
const expectOnlyAbsoluteHttpUrls = (result: MetadataRoute.Sitemap) => {
  expect(result.length).toBeGreaterThan(0);
  for (const entry of result) {
    const parsed = new URL(entry.url);
    expect(['http:', 'https:']).toContain(parsed.protocol);
    expect(parsed.hostname).not.toBe('');
    expect(parsed.username).toBe('');
    expect(parsed.password).toBe('');
  }
};

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.SOURCE_DATE_EPOCH;
  jest.restoreAllMocks();
});

afterEach(() => {
  process.env = originalEnv;
  setErrorReporter(null);
});

// ---------------------------------------------------------------------------
// Regression: the original contract of sitemap() must not change
// ---------------------------------------------------------------------------

describe('sitemap.ts', () => {
  /** Warnings captured from the injected reporter for the current test. */
  let warnings: string[] = [];

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    warnings = [];
    setErrorReporter((error, _context, level) => {
      if (level === 'warn') warnings.push(String(error));
    });
    // Freeze time for consistent lastModified testing
    jest.useFakeTimers().setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    process.env = originalEnv;
    setErrorReporter(null);
    jest.useRealTimers();
  });

  it('should generate sitemap with all public static routes', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const result = sitemap();

    expect(result).toHaveLength(4);
    expect(result.map(entry => entry.url)).toEqual([
      'http://localhost:3000',
      'http://localhost:3000/contracts',
      'http://localhost:3000/milestones',
      'http://localhost:3000/reputation',
    ]);

    result.forEach(entry => {
      expect(entry.lastModified).toEqual(new Date('2024-01-01T00:00:00.000Z'));
    });
  });

  it('should use custom NEXT_PUBLIC_SITE_URL when provided', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://talenttrust.app';
    const result = sitemap();

    expect(result[0].url).toBe('https://talenttrust.app');
    expect(result[1].url).toBe('https://talenttrust.app/contracts');
  });

  it('keeps a zero-argument default export and a frozen route list (interface stability)', () => {
    expect(typeof sitemap).toBe('function');
    expect(sitemap.length).toBe(0);
    expect(Object.isFrozen(SITEMAP_ROUTES)).toBe(true);
    expect(SITEMAP_ROUTES[0]).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// Base URL resolution
// ---------------------------------------------------------------------------

describe('sitemap base URL resolution', () => {
  it('accepts an absolute https origin', () => {
    expect(resolveSitemapBaseUrl('https://talenttrust.app')).toEqual({
      base: 'https://talenttrust.app',
      usedFallback: false,
      sanitised: [],
    });
  });

  it('accepts an origin with a port and a trailing slash', () => {
    expect(resolveSitemapBaseUrl('http://localhost:3000/').base).toBe('http://localhost:3000');
  });

  it('keeps a configured base path in front of every route', () => {
    const { fn: report } = createReportSpy();
    const result = buildSitemap({ siteUrl: 'https://talenttrust.app/docs', report });

    expect(result.map(entry => entry.url)).toEqual([
      'https://talenttrust.app/docs',
      'https://talenttrust.app/docs/contracts',
      'https://talenttrust.app/docs/milestones',
      'https://talenttrust.app/docs/reputation',
    ]);
    expect(report).not.toHaveBeenCalled();
  });

  it('never emits a double slash for a trailing-slash base', () => {
    const { fn: report } = createReportSpy();
    const result = buildSitemap({ siteUrl: 'https://talenttrust.app/', report });

    expect(result.map(entry => entry.url)).not.toContain('https://talenttrust.app//contracts');
  });

  it('normalises a single-slash or scheme-only https value instead of rejecting it', () => {
    // `https:/host` and `https:host` are normalised by the URL parser to the
    // same origin, so a sloppy-but-recoverable value keeps working.
    for (const value of ['https:/talenttrust.app', 'https:talenttrust.app']) {
      const resolved = resolveSitemapBaseUrl(value);
      expect(resolved.base).toBe('https://talenttrust.app');
      expect(resolved.usedFallback).toBe(false);
    }
  });

  it('treats an unset or blank value as unconfigured, without reporting a fault', () => {
    const { fn: report, callsFor } = createReportSpy();

    for (const value of [undefined, '', '   ']) {
      const resolved = resolveSitemapBaseUrl(value);
      expect(resolved.base).toBe(DEFAULT_SITE_URL);
      expect(resolved.usedFallback).toBe(true);
      expect(resolved.rejection).toBeUndefined();
    }

    buildSitemap({ siteUrl: undefined, report });
    expect(callsFor(SITEMAP_SITE_URL_REJECTED_CODE)).toHaveLength(0);
  });

  it.each([
    ['not a url at all', 'unparsable'],
    ['https://', 'unparsable'],
    ['//talenttrust.app', 'unparsable'],
    ['javascript:alert(1)', 'unsupported-protocol'],
    ['data:text/html,<script>', 'unsupported-protocol'],
    ['file:///etc/passwd', 'unsupported-protocol'],
    ['ftp://talenttrust.app', 'unsupported-protocol'],
    ['https://talenttrust.app/has space', 'invalid-characters'],
    ['https://talenttrust.app/tab\there', 'invalid-characters'],
    ['https://talenttrust.app/new\nline', 'invalid-characters'],
  ])('rejects %s and falls back to the default origin (%s)', (value, rejection) => {
    const resolved = resolveSitemapBaseUrl(value);

    expect(resolved.base).toBe(DEFAULT_SITE_URL);
    expect(resolved.usedFallback).toBe(true);
    expect(resolved.rejection).toBe(rejection);
  });

  it('percent-encodes rather than rejects a path containing markup characters', () => {
    // S1 only requires an absolute http(s) URL; `%3C` is a well-formed URL that
    // simply 404s, which is preferable to discarding the whole site origin.
    const resolved = resolveSitemapBaseUrl('https://talenttrust.app/<script>');

    expect(resolved.base).toBe('https://talenttrust.app/%3Cscript%3E');
    expect(resolved.usedFallback).toBe(false);

    const result = buildSitemap({ siteUrl: 'https://talenttrust.app/<script>', report: jest.fn() });
    expectOnlyAbsoluteHttpUrls(result);
  });

  it('reports a rejected base URL with the reason and never the offending value', () => {
    const report = createReportSpy();
    buildSitemap({ siteUrl: 'https://user:sup3rs3cret@internal-host.example', report: report.fn });

    // Credentials are stripped, so this one is *not* a rejection – see below.
    expect(report.callsFor(SITEMAP_SITE_URL_REJECTED_CODE)).toHaveLength(0);

    const rejected = createReportSpy();
    buildSitemap({ siteUrl: 'javascript:steal(document.cookie)', report: rejected.fn });

    const [call] = rejected.callsFor(SITEMAP_SITE_URL_REJECTED_CODE);
    expect(call[2]).toBe('warn');
    expect(call[3]).toEqual({
      code: SITEMAP_SITE_URL_REJECTED_CODE,
      reason: 'unsupported-protocol',
      protocol: 'javascript',
      fallback: DEFAULT_SITE_URL,
    });
    expect(JSON.stringify(call)).not.toContain('steal');
  });

  it('strips credentials, query and hash instead of emitting them', () => {
    // The safety property is structural, not incidental: `URL.origin` cannot
    // represent userinfo, a query or a fragment, so the composed base cannot
    // carry them regardless of how the value was parsed.
    expect(new URL('https://user:pw@talenttrust.app/?a=1#b').origin).toBe('https://talenttrust.app');

    const report = createReportSpy();
    const result = buildSitemap({
      siteUrl: 'https://user:sup3rs3cret@talenttrust.app/?token=abc#frag',
      report: report.fn,
    });

    expectOnlyAbsoluteHttpUrls(result);
    for (const entry of result) {
      expect(entry.url).not.toContain('sup3rs3cret');
      expect(entry.url).not.toContain('token');
      expect(entry.url).not.toContain('frag');
    }
    expect(result[0].url).toBe('https://talenttrust.app');
    expect(report.callsFor(SITEMAP_SITE_URL_SANITIZED_CODE)).toHaveLength(1);
    expect((report.callsFor(SITEMAP_SITE_URL_SANITIZED_CODE)[0][3] as { sanitised: string[] }).sanitised)
      .toEqual(['credentials', 'query', 'hash']);
  });

  it('still produces a usable document when the base URL is rejected (S2, S3)', () => {
    const { fn: report } = createReportSpy();
    const result = buildSitemap({ siteUrl: 'ftp://talenttrust.app', report });

    expect(result).toHaveLength(SITEMAP_ROUTES.length);
    expectOnlyAbsoluteHttpUrls(result);
    expect(result[1].url).toBe('http://localhost:3000/contracts');
  });
});

// ---------------------------------------------------------------------------
// Entry invariants
// ---------------------------------------------------------------------------

describe('sitemap entry invariants', () => {
  it('collapses duplicates and preserves declaration order (S4)', () => {
    const { fn: report } = createReportSpy();
    const result = buildSitemap({
      siteUrl: 'https://talenttrust.app',
      routes: ['/', '/contracts', '/contracts', 'contracts/', '//', '/contracts'],
      report,
    });

    expect(result.map(entry => entry.url)).toEqual([
      'https://talenttrust.app',
      'https://talenttrust.app/contracts',
    ]);
  });

  it('always emits at least the base entry, even for an empty route list (S3)', () => {
    const { fn: report } = createReportSpy();
    const result = buildSitemap({ siteUrl: 'https://talenttrust.app', routes: [], report });

    expect(result).toEqual([{ url: 'https://talenttrust.app', lastModified: expect.any(Date) }]);
  });

  it('drops unusable routes and keeps the valid ones (partial completion)', () => {
    const report = createReportSpy();
    const result = buildSitemap({
      siteUrl: 'https://talenttrust.app',
      routes: [
        '/',
        '/contracts',
        '/con tracts',
        '/../etc/passwd',
        '/nested/../escape',
        '/a//b',
        '/reputation?admin=1',
        '/milestones#top',
        '/[id]',
        '/wallet',
      ],
      report: report.fn,
    });

    expect(result.map(entry => entry.url)).toEqual([
      'https://talenttrust.app',
      'https://talenttrust.app/contracts',
      'https://talenttrust.app/wallet',
    ]);
    expect(report.reasons(SITEMAP_ROUTE_DROPPED_CODE)).toEqual(
      new Array(7).fill('invalid-route'),
    );
    // The dropped route strings are not echoed into the report (S6).
    expect(JSON.stringify(report.fn.mock.calls)).not.toContain('passwd');
    expect(JSON.stringify(report.fn.mock.calls)).not.toContain('admin=1');
  });

  it('normalises leading slashes and whitespace around a route', () => {
    const { fn: report } = createReportSpy();
    const result = buildSitemap({
      siteUrl: 'https://talenttrust.app',
      routes: ['  /contracts  '],
      report,
    });

    expect(result.map(entry => entry.url)).toEqual(['https://talenttrust.app/contracts']);
  });

  it('treats a sub-1 or non-finite cap as the protocol limit, never as "unbounded" (S4)', () => {
    const { fn: report } = createReportSpy();
    const routes = ['/', '/contracts', '/milestones', '/reputation', '/wallet'];

    for (const maxUrls of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = buildSitemap({ siteUrl: 'https://talenttrust.app', routes, maxUrls, report });
      expect(result).toHaveLength(routes.length);
    }
    expect(report).not.toHaveBeenCalled();
  });

  it('caps the document at the configured limit and reports truncation (S4)', () => {
    const report = createReportSpy();
    const result = buildSitemap({
      siteUrl: 'https://talenttrust.app',
      routes: ['/', '/contracts', '/milestones', '/reputation', '/wallet'],
      maxUrls: 3,
      report: report.fn,
    });

    expect(result.map(entry => entry.url)).toEqual([
      'https://talenttrust.app',
      'https://talenttrust.app/contracts',
      'https://talenttrust.app/milestones',
    ]);
    expect(report.callsFor(SITEMAP_TRUNCATED_CODE)).toHaveLength(1);
    expect(report.callsFor(SITEMAP_TRUNCATED_CODE)[0][3]).toEqual({
      code: SITEMAP_TRUNCATED_CODE,
      limit: 3,
      dropped: 2,
    });
  });

  it('documents the protocol limit and does not truncate a small document', () => {
    // The 50,000-entry build is not exercised inline: `new URL` costs ~70µs per
    // call under jsdom, which would add ~8s to the suite for a case the
    // injectable `maxUrls` seam already covers. The default is asserted here,
    // and the truncation path is covered by the test above.
    expect(SITEMAP_MAX_URLS).toBe(50_000);

    const report = createReportSpy();
    const routes = ['/', '/contracts', '/milestones', '/reputation'];

    const clock = () => FIXED_NOW;
    const withDefault = buildSitemap({
      siteUrl: 'https://talenttrust.app',
      routes,
      now: clock,
      report: report.fn,
    });
    const withExplicitLimit = buildSitemap({
      siteUrl: 'https://talenttrust.app',
      routes,
      maxUrls: SITEMAP_MAX_URLS,
      now: clock,
      report: jest.fn(),
    });

    expect(withDefault).toEqual(withExplicitLimit);
    expect(report.callsFor(SITEMAP_TRUNCATED_CODE)).toHaveLength(0);
  });

  it('isolates a throwing resolver to the affected route (S2)', () => {
    const report = createReportSpy();
    const result = buildSitemap({
      siteUrl: 'https://talenttrust.app',
      report: report.fn,
      resolveUrl: (path, base) => {
        if (path === 'milestones') throw new Error('URL parser unavailable');
        return new URL(path, base);
      },
    });

    expect(result.map(entry => entry.url)).toEqual([
      'https://talenttrust.app',
      'https://talenttrust.app/contracts',
      'https://talenttrust.app/reputation',
    ]);
    expect(report.reasons(SITEMAP_ROUTE_DROPPED_CODE)).toEqual(['unresolvable-route']);
    expectOnlyAbsoluteHttpUrls(result);
  });

  it('rejects a resolver that returns a non-http URL (S1 is enforced, not assumed)', () => {
    const report = createReportSpy();
    const result = buildSitemap({
      siteUrl: 'https://talenttrust.app',
      report: report.fn,
      resolveUrl: (path, base) =>
        path === 'contracts'
          ? new URL('javascript:alert(1)')
          : new URL(path, base),
    });

    expect(result.map(entry => entry.url)).toEqual([
      'https://talenttrust.app',
      'https://talenttrust.app/milestones',
      'https://talenttrust.app/reputation',
    ]);
    expect(report.reasons(SITEMAP_ROUTE_DROPPED_CODE)).toEqual(['not-absolute-http']);
    expect(JSON.stringify(report.fn.mock.calls)).not.toContain('alert');
  });

  it('rejects a resolver that leaks credentials into the output', () => {
    const report = createReportSpy();
    const result = buildSitemap({
      siteUrl: 'https://talenttrust.app',
      routes: ['/', '/contracts'],
      report: report.fn,
      resolveUrl: (path, base) => new URL(`https://leak:token@${new URL(base).host}/${path}`),
    });

    // Home is emitted from the configured base, so it survives; the leaky
    // resolver output is rejected outright.
    expect(result).toEqual([{ url: 'https://talenttrust.app', lastModified: expect.any(Date) }]);
    expect(report.reasons(SITEMAP_ROUTE_DROPPED_CODE)).toEqual(['not-absolute-http']);
  });

  it('never throws for any combination of hostile inputs', () => {
    const hostile = [
      undefined,
      '',
      '://',
      'javascript:alert(1)',
      'https://',
      'https://user:pw@host.example/base?a=1#b',
      'https://host.example/%0A%0D',
    ];

    for (const siteUrl of hostile) {
      expect(() => buildSitemap({ siteUrl, report: jest.fn() })).not.toThrow();
    }

    expect(() =>
      buildSitemap({
        siteUrl: 'https://host.example',
        routes: ['', '///', '../../etc', '/a b', '/x?y'],
        report: jest.fn(),
        resolveUrl: () => {
          throw new Error('resolver down');
        },
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

describe('sitemap timestamps', () => {
  it('shares one timestamp across the whole document (S5)', () => {
    const result = buildSitemap({ siteUrl: 'https://talenttrust.app', now: () => FIXED_NOW });

    for (const entry of result) {
      expect(entry.lastModified).toEqual(FIXED_NOW);
    }
  });

  it('honours SOURCE_DATE_EPOCH for reproducible builds', () => {
    process.env.SOURCE_DATE_EPOCH = '1700000000';
    const { fn: report } = createReportSpy();

    const result = buildSitemap({ siteUrl: 'https://talenttrust.app', now: () => FIXED_NOW, report });

    expect(result[0].lastModified).toEqual(new Date('2023-11-14T22:13:20.000Z'));
    expect(report).not.toHaveBeenCalled();
  });

  it.each(['abc', '-1', '1e30', 'Infinity', 'NaN'])(
    'falls back to the current time and reports an unusable SOURCE_DATE_EPOCH (%s)',
    (value) => {
      process.env.SOURCE_DATE_EPOCH = value;
      const report = createReportSpy();

      const result = buildSitemap({ siteUrl: 'https://talenttrust.app', now: () => FIXED_NOW, report: report.fn });

      expect(result[0].lastModified).toEqual(FIXED_NOW);
      expect(report.callsFor(SITEMAP_INVALID_TIMESTAMP_CODE)).toHaveLength(1);
      expect((report.callsFor(SITEMAP_INVALID_TIMESTAMP_CODE)[0][3] as { source: string }).source)
        .toBe('SOURCE_DATE_EPOCH');
    },
  );

  it('recovers from a clock that yields an Invalid Date', () => {
    const report = createReportSpy();

    const result = buildSitemap({
      siteUrl: 'https://talenttrust.app',
      now: () => new Date('not-a-date'),
      report: report.fn,
    });

    expect(result[0].lastModified).toBeInstanceOf(Date);
    expect(Number.isFinite((result[0].lastModified as Date).getTime())).toBe(true);
    expect((report.callsFor(SITEMAP_INVALID_TIMESTAMP_CODE)[0][3] as { source: string }).source).toBe('clock');
  });

  it('is byte-stable for identical inputs (deterministic)', () => {
    const options = { siteUrl: 'https://talenttrust.app', now: () => FIXED_NOW };
    const first = buildSitemap({ ...options, report: jest.fn() });
    const second = buildSitemap({ ...options, report: jest.fn() });

    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// Report hygiene at the Next.js entry point
// ---------------------------------------------------------------------------

describe('sitemap() reporting', () => {
  /**
   * The dedupe memo is module state, so each case needs its own module
   * instance. `jest.doMock` is used (rather than `setErrorReporter`) because an
   * isolated module registry also isolates the real `errorReporter` instance
   * the statically imported helper would otherwise patch.
   */
  const loadFresh = (
    env: Record<string, string | undefined>,
    onReport: (...args: unknown[]) => void,
  ) => {
    process.env = { ...originalEnv };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    let freshModule: typeof import('../sitemap') | undefined;
    jest.isolateModules(() => {
      jest.doMock('@/lib/errorReporter', () => ({
        reportError: onReport,
        setErrorReporter: jest.fn(),
      }));
      freshModule = require('../sitemap');
    });
    return freshModule;
  };

  afterEach(() => {
    jest.dontMock('@/lib/errorReporter');
  });

  it('stays silent when the site URL is valid', () => {
    const reporter = jest.fn();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fresh = loadFresh({ NEXT_PUBLIC_SITE_URL: 'https://talenttrust.app' }, reporter);

    expect(fresh.default()).toHaveLength(4);
    expect(reporter).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a misconfigured site URL once per process, not once per request (S7)', () => {
    const reporter = jest.fn();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fresh = loadFresh({ NEXT_PUBLIC_SITE_URL: 'javascript:alert(1)' }, reporter);

    fresh.default();
    fresh.default();
    fresh.default();

    const rejections = reporter.mock.calls.filter(
      call => (call[3] as { code?: string })?.code === SITEMAP_SITE_URL_REJECTED_CODE,
    );
    expect(rejections).toHaveLength(1);
    // Production visibility: the default reporter is a no-op under
    // NODE_ENV=production, so the deployment misconfiguration is also logged.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('unsupported-protocol');
    expect(warn.mock.calls[0][0]).not.toContain('alert');
  });

  it('distinguishes distinct conditions so neither is swallowed', () => {
    const reporter = jest.fn();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fresh = loadFresh({ NEXT_PUBLIC_SITE_URL: 'https://talenttrust.app' }, reporter);

    // First condition, then a different one inside the same process.
    process.env.NEXT_PUBLIC_SITE_URL = 'https://talenttrust.app/has space';
    fresh.default();
    process.env.NEXT_PUBLIC_SITE_URL = 'ftp://talenttrust.app';
    fresh.default();

    const reasons = reporter.mock.calls
      .filter(call => (call[3] as { code?: string })?.code === SITEMAP_SITE_URL_REJECTED_CODE)
      .map(call => (call[3] as { reason: string }).reason);
    expect(reasons).toEqual(['invalid-characters', 'unsupported-protocol']);
  });

  it('always returns a usable document even when every condition is bad', () => {
    const reporter = jest.fn();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fresh = loadFresh(
      { NEXT_PUBLIC_SITE_URL: 'ftp://talenttrust.app', SOURCE_DATE_EPOCH: 'not-a-number' },
      reporter,
    );

    const result = fresh.default();

    expectOnlyAbsoluteHttpUrls(result);
    expect(result[0].url).toBe(DEFAULT_SITE_URL);
    expect(result).toHaveLength(4);
  });
});
