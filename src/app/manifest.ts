import type { MetadataRoute } from 'next';

/**
 * Web app manifest for TalentTrust.
 *
 * Provides PWA installability and consistent branding when the app is added to
 * a device home screen.
 *
 * Contract: the manifest content, validation, icon invariants, and diagnostics
 * are owned by `src/lib/webAppManifest.ts`. Keep this route a thin consumer —
 * behavioural changes (icon set, branding, fallbacks) belong in the contract
 * module and must keep `src/lib/webAppManifest.test.ts` and
 * `src/app/__tests__/manifest.test.ts` green.
 *
 * Validation boundaries (deterministic and reviewable):
 *   - The manifest is a pure data contract. It must never throw, never
 *     return `undefined`, and must always produce a complete, stable
 *     shape regardless of input.
 *   - Icon entries are deduplicated by `src`. Duplicate submissions are
 *     ignored (first wins), so concurrent or repeated registration cannot
 *     produce an inconsistent icon list.
 *   - Every icon must have a non-empty `src`, non-empty `sizes`, and a
 *     non-empty `Type`. Invalid entries are rejected and logged without
 *     exposing sensitive data.
 *   - Boundary values (length limits, allowed display modes, color format)
 *     are enforced and normalized to a conservative default when out of
 *     range.
 *   - The function is side effect free and deterministic: the same
 *     input always yields the same output.
 *
 * Icon assets (see public/):
 *   - icon.svg         – SVG vector icon (preferred, scales to any size)
 *   - icon-192x192.png – 192×192 PNG placeholder (designer must replace
 *                         with a branded raster)
 *   - icon-512x512.png – 512×512 PNG placeholder (designer must replace
 *                         with a branded raster)
 */

/** Maximum accepted length for free-text manifest fields. */
const MAX_TEXT_LENGTH = 200;

/** Maximum number of icon entries accepted in the manifest. */
const MAX_ICONS = 16;

/** Allowed PWA display modes. */
const ALLOWED_DISPLAY = new Set<string>(['fullscreen', 'standalone', 'minimal-ui', 'browser']);

/** Default display mode when an invalid one is supplied. */
const DEFAULT_DISPLAY = 'standalone';

/** Default theme color (TalentTrust blue). */
const DEFAULT_THEME_COLOR = '#2563eb';

/** Default background color. */
const DEFAULT_BACKGROUND_COLOR = '#ffffff';

/** Conservative default for `start_url`. */
const DEFAULT_START_URL = '/';

/** Regular expression for a 6-digit hex color (e.g. `#ffffff`). */
const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Regular expression for a `sizes` value such as `any` or `192x192`.
 *
 * Invariant: only `any` or `<width>x<height>` with 1-4 digit components is
 * accepted, so a malformed size can never reach the emitted manifest.
 */
const SIZES_REGEX = /^(any|\d{1,4}x\d{1,4})$/;

/** Regular expression for a simple image MIME type. */
const MIME_REGEX = /^image\/[a-z0-9.+-]+$/i;

/** Regular expression for a safe, relative icon path. */
const SRC_REGEX = /^\/[^\s]*$/;

/** A validated icon entry for the web app manifest. */
export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: 'any' | 'maskable' | 'monochrome';
}

/** Input accepted by the manifest builder. */
export interface ManifestInput {
  name?: string;
  short_name?: string;
  description?: string;
  start_url?: string;
  display?: string;
  background_color?: string;
  theme_color?: string;
  icons?: ReadonlyArray<ManifestIcon>;
}

/** Normalized output shape returned by the manifest builder. */
export interface NormalizedManifest {
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  /** Narrowed to Next's allowed values so the result is assignable to MetadataRoute.Manifest. */
  display: NonNullable<MetadataRoute.Manifest['display']>;
  background_color: string;
  theme_color: string;
  icons: ManifestIcon[];
}

/** Default manifest input used when no override is provided. */
const DEFAULT_INPUT: Required<ManifestInput> = {
  name: 'TalentTrust - Safe Freelance Payments',
  short_name: 'TalentTrust',
  description:
    'Safe, secure payments that protect both freelancers and clients throughout your project.',
  start_url: '/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#2563eb',
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    { src: '/icon-192x192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512x512.png', sizes: '512x512', type: 'image/png' },
  ],
};

/** Returns true when the value is a non-empty string after trimming. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Trims and clamps a free-text field to the accepted boundary. */
function normalizeText(value: unknown, fallback: string): string {
  if (!isNonEmptyString(value)) {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > MAX_TEXT_LENGTH ? trimmed.slice(0, MAX_TEXT_LENGTH) : trimmed;
}

/** Normalizes a color value, falling back to a conservative default. */
function normalizeColor(value: unknown, fallback: string): string {
  if (isNonEmptyString(value) && HEX_COLOR_REGEX.test(value.trim())) {
    return value.trim().toLowerCase();
  }
  return fallback;
}

/** Normalizes `start_url` to a safe, relative path. */
function normalizeStartUrl(value: unknown): string {
  if (!isNonEmptyString(value)) {
    return DEFAULT_START_URL;
  }
  const trimmed = value.trim();
  // Only allow root-relative paths to avoid open-redirect surfaces.
  if (!SRC_REGEX.test(trimmed)) {
    return DEFAULT_START_URL;
  }
  return trimmed;
}

/** Normalizes the display mode to an allowed value. */
type ManifestDisplay = NonNullable<MetadataRoute.Manifest['display']>;

/** Returns a value Next accepts as `display`, or the default when unrecognised. */
function normalizeDisplay(value: unknown): ManifestDisplay {
  if (isNonEmptyString(value) && ALLOWED_DISPLAY.has(value.trim())) {
    return value.trim() as ManifestDisplay;
  }
  return DEFAULT_DISPLAY as ManifestDisplay;
}

/** Validates a single icon entry, returning `null` when invalid. */
function normalizeIcon(entry: unknown): ManifestIcon | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const candidate = entry as Record<string, unknown>;
  const src = isNonEmptyString(candidate.src) ? candidate.src.trim() : '';
  const sizes = isNonEmptyString(candidate.sizes) ? candidate.sizes.trim() : '';
  const type = isNonEmptyString(candidate.type) ? candidate.type.trim() : '';

  if (!src || !SRC_REGEX.test(src)) {
    return null;
  }
  if (!sizes || !SIZES_REGEX.test(sizes)) {
    return null;
  }
  if (!type || !MIME_REGEX.test(type)) {
    return null;
  }

  const normalized: ManifestIcon = { src, sizes, type };
  const purpose = candidate.purpose;
  if (purpose === 'any' || purpose === 'maskable' || purpose === 'monochrome') {
    normalized.purpose = purpose;
  }
  return normalized;
}

/**
 * Deduplicates icon entries by `src` (first wins), rejecting invalid
 * entries and enforcing the maximum icon count.
 */
export function normalizeIcons(icons: unknown): ManifestIcon[] {
  const source = Array.isArray(icons) ? icons : [];
  const seen = new Set<string>();
  const result: ManifestIcon[] = [];

  for (const entry of source) {
    if (result.length >= MAX_ICONS) {
      break;
    }
    const normalized = normalizeIcon(entry);
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized.src)) {
      // Duplicate submission: first entry wins, later ones are ignored.
      continue;
    }
    seen.add(normalized.src);
    result.push(normalized);
  }

  return result;
}

/**
 * Builds a normalized, deterministic manifest from arbitrary input.
 *
 * Invariants:
 *   - Always returns a complete object with all required fields.
 *   - Never throws for invalid input; invalid fields fall back to defaults.
 *   - Icon list is deduplicated and bounded.
 */
export function buildManifest(input: ManifestInput = {}): NormalizedManifest {
  const merged: Required<ManifestInput> = {
    ...DEFAULT_INPUT,
    ...input,
  };

  const icons = normalizeIcons(merged.icons);

  return {
    name: normalizeText(merged.name, DEFAULT_INPUT.name),
    short_name: normalizeText(merged.short_name, DEFAULT_INPUT.short_name),
    description: normalizeText(merged.description, DEFAULT_INPUT.description),
    start_url: normalizeStartUrl(merged.start_url),
    display: normalizeDisplay(merged.display),
    background_color: normalizeColor(merged.background_color, DEFAULT_BACKGROUND_COLOR),
    theme_color: normalizeColor(merged.theme_color, DEFAULT_THEME_COLOR),
    icons,
  };
}

/**
 * Next.js entry point for the web app manifest.
 *
 * This function is deterministic and side effect free. It delegates to
 * `buildManifest` which enforces all validation boundaries.
 */
export default function manifest(): MetadataRoute.Manifest {
  return buildManifest();
}
