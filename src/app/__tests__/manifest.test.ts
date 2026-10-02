/**
 * manifest.test.ts
 *
 * Hardened concurrent-execution test suite for src/app/manifest.ts
 * (issue #1192).
 *
 * manifest() is a pure, synchronous Next.js route handler that returns a
 * fresh MetadataRoute.Manifest object on every call.  The hardening
 * requirements are:
 *
 *  1. **Determinism**: every call — regardless of order, frequency, or
 *     concurrency — returns exactly the same field values.
 *  2. **Object independence**: callers that mutate the returned object must
 *     not affect subsequent calls (no shared mutable state / aliased
 *     references).
 *  3. **Idempotency under retries**: repeated calls are identical to a single
 *     call (idempotent).
 *  4. **Concurrent safety**: N parallel calls all resolve to structurally
 *     identical manifests.
 *  5. **Complete field contract**: every required PWA field is present and
 *     non-empty so callers cannot silently receive a partial manifest.
 *  6. **Icon array integrity**: icon ordering and path structure are pinned
 *     so a toolchain consuming the manifest cannot receive a broken set.
 *
 * These properties are tested in addition to (not instead of) the
 * field-value regression tests that already existed in this file.
 */

import manifest from '../manifest';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Deep equality of two objects produced by manifest(). */
function manifestsEqual(
  a: ReturnType<typeof manifest>,
  b: ReturnType<typeof manifest>,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Simulate N "concurrent" calls by scheduling them as micro-tasks. */
async function callConcurrently(n: number): Promise<ReturnType<typeof manifest>[]> {
  // Promise.all with synchronous bodies models the "racing callers"
  // scenario: all work is queued before any result is consumed.
  return Promise.all(Array.from({ length: n }, () => Promise.resolve(manifest())));
}

// ─── Original regression vectors (preserved) ────────────────────────────────

describe('manifest.ts – field regression', () => {
  it('should return the full application name', () => {
    expect(manifest().name).toBe('TalentTrust - Safe Freelance Payments');
  });

  it('should return the short name', () => {
    expect(manifest().short_name).toBe('TalentTrust');
  });

  it('should have a matching description', () => {
    expect(manifest().description).toBe(
      'Safe, secure payments that protect both freelancers and clients throughout your project.',
    );
  });

  it('should start at root', () => {
    expect(manifest().start_url).toBe('/');
  });

  it('should use standalone display mode', () => {
    expect(manifest().display).toBe('standalone');
  });

  describe('colors', () => {
    it('should use white as background_color (matching globals.css light theme)', () => {
      expect(manifest().background_color).toBe('#ffffff');
    });

    it('should use primary blue as theme_color (matching globals.css --primary)', () => {
      expect(manifest().theme_color).toBe('#2563eb');
    });
  });

  describe('icons', () => {
    it('should have a non-empty icons array', () => {
      const result = manifest();
      expect(Array.isArray(result.icons)).toBe(true);
      expect(result.icons?.length).toBeGreaterThan(0);
    });

    it('each icon should have src, sizes, and type', () => {
      for (const icon of manifest().icons ?? []) {
        expect(icon).toHaveProperty('src');
        expect(icon).toHaveProperty('sizes');
        expect(icon).toHaveProperty('type');
        expect(typeof icon.src).toBe('string');
        expect(icon.src?.length).toBeGreaterThan(0);
        expect(typeof icon.sizes).toBe('string');
        expect(icon.sizes?.length).toBeGreaterThan(0);
        expect(typeof icon.type).toBe('string');
        expect(icon.type?.length).toBeGreaterThan(0);
      }
    });

    it('should include an SVG icon with sizes "any"', () => {
      const svgIcons = manifest().icons?.filter(
        icon => icon.type === 'image/svg+xml',
      );
      expect(svgIcons?.length).toBeGreaterThanOrEqual(1);
      expect(svgIcons?.[0]?.sizes).toBe('any');
    });

    it('should include a 192x192 PNG icon', () => {
      const icon192 = manifest().icons?.find(
        icon => icon.sizes === '192x192' && icon.type === 'image/png',
      );
      expect(icon192).toBeDefined();
      expect(icon192?.src).toBe('/icon-192x192.png');
    });

    it('should include a 512x512 PNG icon', () => {
      const icon512 = manifest().icons?.find(
        icon => icon.sizes === '512x512' && icon.type === 'image/png',
      );
      expect(icon512).toBeDefined();
      expect(icon512?.src).toBe('/icon-512x512.png');
    });

    it('should reference SVG as the first icon (preferred format)', () => {
      expect(manifest().icons?.[0]?.type).toBe('image/svg+xml');
    });

    it('all icon src paths should start with /', () => {
      for (const icon of manifest().icons ?? []) {
        expect(icon.src?.startsWith('/')).toBe(true);
      }
    });

    it('all icon types should be valid MIME types', () => {
      const validTypes = ['image/png', 'image/svg+xml'];
      for (const icon of manifest().icons ?? []) {
        expect(validTypes).toContain(icon.type);
      }
    });
  });
});

// ─── Concurrent-execution hardening (issue #1192) ────────────────────────────

describe('manifest.ts – concurrent-execution hardening', () => {

  // ── 1. Determinism ─────────────────────────────────────────────────────────

  describe('determinism', () => {
    it('returns identical results on two consecutive calls', () => {
      const first = manifest();
      const second = manifest();
      expect(manifestsEqual(first, second)).toBe(true);
    });

    it('returns identical results across 100 sequential calls', () => {
      const baseline = manifest();
      for (let i = 0; i < 100; i++) {
        expect(manifestsEqual(manifest(), baseline)).toBe(true);
      }
    });

    it('name field is identical across repeated calls', () => {
      const name = manifest().name;
      for (let i = 0; i < 20; i++) {
        expect(manifest().name).toBe(name);
      }
    });

    it('theme_color field is identical across repeated calls', () => {
      const color = manifest().theme_color;
      for (let i = 0; i < 20; i++) {
        expect(manifest().theme_color).toBe(color);
      }
    });

    it('icon count is identical across repeated calls', () => {
      const count = manifest().icons?.length;
      for (let i = 0; i < 20; i++) {
        expect(manifest().icons?.length).toBe(count);
      }
    });
  });

  // ── 2. Object independence (no shared mutable state) ──────────────────────

  describe('object independence', () => {
    it('each call returns a distinct object reference', () => {
      const a = manifest();
      const b = manifest();
      // Different object references despite equal contents.
      expect(a).not.toBe(b);
    });

    it('mutating the returned name does not affect subsequent calls', () => {
      const m1 = manifest() as ReturnType<typeof manifest> & { name: string };
      m1.name = 'MUTATED';
      const m2 = manifest();
      expect(m2.name).toBe('TalentTrust - Safe Freelance Payments');
    });

    it('mutating the returned icons array does not affect subsequent calls', () => {
      const m1 = manifest();
      // Wipe the icons array on the first result.
      (m1.icons as unknown as unknown[]).length = 0;
      const m2 = manifest();
      expect(m2.icons?.length).toBeGreaterThan(0);
    });

    it('mutating an icon object in one result does not affect the next', () => {
      const m1 = manifest();
      const firstIcon = m1.icons?.[0];
      if (firstIcon) {
        (firstIcon as { src: string }).src = '/MUTATED.svg';
      }
      const m2 = manifest();
      expect(m2.icons?.[0]?.src).toBe('/icon.svg');
    });

    it('the icons array from each call is a distinct reference', () => {
      const a = manifest();
      const b = manifest();
      expect(a.icons).not.toBe(b.icons);
    });
  });

  // ── 3. Idempotency under retries ───────────────────────────────────────────

  describe('idempotency', () => {
    it('calling manifest() once or N times gives the same result (idempotent)', () => {
      const once = manifest();
      // Simulate N retries from a caller that retries on transient errors.
      let last = manifest();
      for (let i = 0; i < 10; i++) {
        last = manifest();
      }
      expect(manifestsEqual(once, last)).toBe(true);
    });

    it('start_url never changes between retries', () => {
      const urls = Array.from({ length: 50 }, () => manifest().start_url);
      const unique = new Set(urls);
      expect(unique.size).toBe(1);
      expect(unique.has('/')).toBe(true);
    });

    it('display mode never changes between retries', () => {
      const modes = Array.from({ length: 50 }, () => manifest().display);
      const unique = new Set(modes);
      expect(unique.size).toBe(1);
      expect(unique.has('standalone')).toBe(true);
    });
  });

  // ── 4. Concurrent safety ───────────────────────────────────────────────────

  describe('concurrent safety', () => {
    it('2 concurrent calls return structurally identical manifests', async () => {
      const [a, b] = await callConcurrently(2);
      expect(manifestsEqual(a, b)).toBe(true);
    });

    it('10 concurrent calls all return structurally identical manifests', async () => {
      const results = await callConcurrently(10);
      const baseline = results[0];
      for (const r of results.slice(1)) {
        expect(manifestsEqual(r, baseline)).toBe(true);
      }
    });

    it('50 concurrent calls all return the same name', async () => {
      const results = await callConcurrently(50);
      const names = new Set(results.map(r => r.name));
      expect(names.size).toBe(1);
      expect(names.has('TalentTrust - Safe Freelance Payments')).toBe(true);
    });

    it('50 concurrent calls all return the same theme_color', async () => {
      const results = await callConcurrently(50);
      const colors = new Set(results.map(r => r.theme_color));
      expect(colors.size).toBe(1);
      expect(colors.has('#2563eb')).toBe(true);
    });

    it('50 concurrent calls all return the same icon count', async () => {
      const results = await callConcurrently(50);
      const counts = new Set(results.map(r => r.icons?.length));
      expect(counts.size).toBe(1);
    });

    it('concurrent calls return distinct object references (no aliasing)', async () => {
      const [a, b, c] = await callConcurrently(3);
      expect(a).not.toBe(b);
      expect(b).not.toBe(c);
      expect(a).not.toBe(c);
    });

    it('mutating one concurrent result does not corrupt another', async () => {
      const [a, b] = await callConcurrently(2);
      // Mutate first result after both are resolved.
      (a as { name: string }).name = 'CORRUPTED';
      // Second result must be unaffected.
      expect(b.name).toBe('TalentTrust - Safe Freelance Payments');
    });
  });

  // ── 5. Complete field contract ─────────────────────────────────────────────

  describe('complete field contract', () => {
    it('manifest result has all required PWA fields', () => {
      const result = manifest();
      const required: (keyof ReturnType<typeof manifest>)[] = [
        'name',
        'short_name',
        'description',
        'start_url',
        'display',
        'background_color',
        'theme_color',
        'icons',
      ];
      for (const field of required) {
        expect(result).toHaveProperty(field);
        expect(result[field]).not.toBeNull();
        expect(result[field]).not.toBeUndefined();
        // String fields must be non-empty.
        if (typeof result[field] === 'string') {
          expect((result[field] as string).length).toBeGreaterThan(0);
        }
      }
    });

    it('no required field is the empty string', () => {
      const result = manifest();
      expect(result.name).not.toBe('');
      expect(result.short_name).not.toBe('');
      expect(result.description).not.toBe('');
      expect(result.start_url).not.toBe('');
      expect(result.background_color).not.toBe('');
      expect(result.theme_color).not.toBe('');
    });

    it('color values are valid hex strings', () => {
      const hexPattern = /^#[0-9a-fA-F]{3,8}$/;
      const result = manifest();
      expect(result.background_color).toMatch(hexPattern);
      expect(result.theme_color).toMatch(hexPattern);
    });

    it('start_url begins with /', () => {
      expect(manifest().start_url?.startsWith('/')).toBe(true);
    });

    it('name field does not expose internal environment variables or secrets', () => {
      const name = manifest().name ?? '';
      // Must not look like an env-var expansion failure.
      expect(name).not.toMatch(/\$\{/);
      expect(name).not.toMatch(/process\.env/);
      expect(name.length).toBeGreaterThan(0);
    });
  });

  // ── 6. Icon array integrity ────────────────────────────────────────────────

  describe('icon array integrity', () => {
    it('icon ordering is stable: SVG first, 192 second, 512 third', () => {
      const { icons = [] } = manifest();
      expect(icons[0]?.type).toBe('image/svg+xml');
      expect(icons[1]?.sizes).toBe('192x192');
      expect(icons[2]?.sizes).toBe('512x512');
    });

    it('exactly 3 icons are present', () => {
      expect(manifest().icons?.length).toBe(3);
    });

    it('no icon has an undefined src', () => {
      for (const icon of manifest().icons ?? []) {
        expect(icon.src).toBeDefined();
        expect(typeof icon.src).toBe('string');
      }
    });

    it('no icon has a duplicate src', () => {
      const srcs = (manifest().icons ?? []).map(i => i.src);
      const unique = new Set(srcs);
      expect(unique.size).toBe(srcs.length);
    });

    it('PNG icons have the correct MIME type', () => {
      const pngIcons = (manifest().icons ?? []).filter(
        i => i.src?.endsWith('.png'),
      );
      for (const icon of pngIcons) {
        expect(icon.type).toBe('image/png');
      }
    });

    it('SVG icons have the correct MIME type', () => {
      const svgIcons = (manifest().icons ?? []).filter(
        i => i.src?.endsWith('.svg'),
      );
      for (const icon of svgIcons) {
        expect(icon.type).toBe('image/svg+xml');
      }
    });

    it('icon ordering is stable across 20 repeated calls', () => {
      const baseline = (manifest().icons ?? []).map(i => i.src);
      for (let n = 0; n < 20; n++) {
        const srcs = (manifest().icons ?? []).map(i => i.src);
        expect(srcs).toEqual(baseline);
      }
    });

    it('icon ordering is stable across 20 concurrent calls', async () => {
      const baseline = (manifest().icons ?? []).map(i => i.src);
      const results = await callConcurrently(20);
      for (const r of results) {
        const srcs = (r.icons ?? []).map(i => i.src);
        expect(srcs).toEqual(baseline);
      }
    });
  });
});
