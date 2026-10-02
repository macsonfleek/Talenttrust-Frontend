import robots, { __resetRobotsResolverForTests } from '../robots';

describe('robots.ts', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    __resetRobotsResolverForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('should use default localhost URL when no NEXT_PUBLIC_SITE_URL is set', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const result = robots();

    expect(result.sitemap).toBe('http://localhost:3000/sitemap.xml');
    expect(result.rules).toEqual({
      userAgent: '*',
      allow: '/',
    });
  });

  it('uses the default URL when NEXT_PUBLIC_SITE_URL is blank', () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation();
    process.env.NEXT_PUBLIC_SITE_URL = '   ';

    expect(robots().sitemap).toBe('http://localhost:3000/sitemap.xml');
    // A blank-but-present variable is a misconfiguration and is reported. The
    // enumerated cases below ("invalid configuration and failure recovery")
    // already require that, so the earlier expectation of silence here
    // contradicted them.
    expect(warning).toHaveBeenCalled();
    expect(warning.mock.calls.flat().join(' ')).toContain('empty');
  });

  it('should use provided NEXT_PUBLIC_SITE_URL when set', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://talenttrust.app';
    const result = robots();

    expect(result.sitemap).toBe('https://talenttrust.app/sitemap.xml');
  });

  it('normalises a trailing slash so the sitemap URL has a single separator', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://talenttrust.app/';
    const result = robots();

    expect(result.sitemap).toBe('https://talenttrust.app/sitemap.xml');
    expect(result.sitemap).not.toContain('//sitemap.xml');
  });

  it('preserves a subpath deployment prefix', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://talenttrust.app/app/';
    const result = robots();

    expect(result.sitemap).toBe('https://talenttrust.app/app/sitemap.xml');
  });

  it('returns an equivalent, independently-owned object on every call', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://talenttrust.app';

    const first = robots();
    const second = robots();

    expect(second).toEqual(first);
    expect(second).not.toBe(first);

    // Mutating one result must not leak into the next invocation.
    (first.rules as { allow: string | string[] }).allow = '/private';
    expect(robots().rules).toEqual({ userAgent: '*', allow: '/' });
  });

  describe('invalid configuration and failure recovery', () => {
    it.each([
      ['', 'empty'],
      ['   ', 'empty'],
      ['talenttrust.app', 'unparsable'],
      ['https://', 'unparsable'],
      ['javascript:alert(1)', 'not_http'],
      ['https://user:pass@talenttrust.app', 'credentials'],
      ['https://talenttrust.app?token=abc', 'query_or_fragment'],
      ['https://talenttrust.app\r\nDisallow: /admin', 'control_characters'],
    ])('falls back to the default origin for %p (%s)', (value, reason) => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.NEXT_PUBLIC_SITE_URL = value;

      const result = robots();

      expect(result.sitemap).toBe('http://localhost:3000/sitemap.xml');
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.flat().join(' ')).toContain(reason);
    });

    it('never emits an attacker-influenced value into robots metadata', () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.NEXT_PUBLIC_SITE_URL = 'https://talenttrust.app\r\nDisallow: /';

      const { sitemap } = robots();

      expect(sitemap).not.toMatch(/[\r\n]/);
      expect(sitemap).toBe('http://localhost:3000/sitemap.xml');
    });

    it('logs a rejected value once, not once per concurrent request', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.NEXT_PUBLIC_SITE_URL = 'javascript:alert(1)';

      const results = await Promise.all(
        Array.from({ length: 20 }, () => Promise.resolve().then(() => robots().sitemap)),
      );

      expect(new Set(results)).toEqual(new Set(['http://localhost:3000/sitemap.xml']));
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('does not leak credentials in the diagnostic output', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.NEXT_PUBLIC_SITE_URL = 'https://user:sup3rsecret@talenttrust.app';

      robots();

      const output = warn.mock.calls.flat().join(' ');
      expect(output).toContain('credentials');
      expect(output).not.toContain('sup3rsecret');
    });
  });

  describe('concurrent and repeated execution', () => {
    it('produces deterministic output across racing invocations', async () => {
      process.env.NEXT_PUBLIC_SITE_URL = 'https://talenttrust.app';

      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          Promise.resolve().then(() => {
            if (i % 2 === 0) return robots();
            return robots();
          }),
        ),
      );

      for (const result of results) {
        expect(result).toEqual({
          rules: { userAgent: '*', allow: '/' },
          sitemap: 'https://talenttrust.app/sitemap.xml',
        });
      }
    });

    it('reflects a configuration change without serving a stale resolution', () => {
      process.env.NEXT_PUBLIC_SITE_URL = 'https://one.app';
      expect(robots().sitemap).toBe('https://one.app/sitemap.xml');

      process.env.NEXT_PUBLIC_SITE_URL = 'https://two.app';
      expect(robots().sitemap).toBe('https://two.app/sitemap.xml');

      process.env.NEXT_PUBLIC_SITE_URL = 'https://one.app';
      expect(robots().sitemap).toBe('https://one.app/sitemap.xml');
    });
  });
});