import type { Metadata } from 'next';
import './globals.css';
import { ToastProvider } from '@/components/toast/toast-provider';

const DEFAULT_SITE_URL = 'http://localhost:3000';

/**
 * Metadata must remain buildable even when a deployment supplies a malformed
 * public URL. Only public HTTP(S) origins are accepted; credentials and
 * non-network schemes must never become metadata or social-preview URLs.
 */
export function resolveMetadataBase(value: string | undefined): URL {
  if (!value?.trim()) return new URL(DEFAULT_SITE_URL);

  try {
    const candidate = new URL(value.trim());
    if (
      (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') ||
      !candidate.hostname ||
      candidate.username ||
      candidate.password
    ) {
      throw new Error('unsupported metadata URL');
    }
    return candidate;
  } catch {
    // Do not include the invalid value in logs: it may contain credentials.
    console.warn('[metadata] invalid NEXT_PUBLIC_SITE_URL; using the default site URL');
    return new URL(DEFAULT_SITE_URL);
  }
}

const metadataBase = resolveMetadataBase(process.env.NEXT_PUBLIC_SITE_URL);
const siteUrl = metadataBase.toString().replace(/\/$/, '');
// Social preview image used by Open Graph and Twitter cards lives in public/.
const socialPreviewImage = '/og-preview.svg';

export const metadata: Metadata = {
  title: 'TalentTrust - Safe Freelance Payments',
  description: 'Safe, secure payments that protect both freelancers and clients throughout your project.',
  metadataBase,
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/icon-192x192.png', sizes: '192x192', type: 'image/png' },
    ],
  },
  openGraph: {
    title: 'TalentTrust - Safe Freelance Payments',
    description: 'Safe, secure payments that protect both freelancers and clients throughout your project.',
    type: 'website',
    siteName: 'TalentTrust',
    url: siteUrl,
    images: [
      {
        url: socialPreviewImage,
        width: 1200,
        height: 630,
        alt: 'TalentTrust social preview showing safe freelance payments',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'TalentTrust - Safe Freelance Payments',
    description: 'Safe, secure payments that protect both freelancers and clients throughout your project.',
    images: [socialPreviewImage],
  },
};

import { PreferencesProvider } from '@/lib/preferences';
import { SettingsTrigger } from '@/components/settings/SettingsTrigger';
import { WalletProvider } from '@/contexts/WalletContext';
import CommandPalette, { CommandPaletteProvider } from '@/components/CommandPalette';
import RouteAnnouncer from '@/components/RouteAnnouncer';
import Navbar from '@/components/Navbar';
import HeaderActions from '@/components/HeaderActions';
import SafeBoundary from '@/components/SafeBoundary';
import { registerDefaultCommands } from '@/lib/commands/defaultCommands';
import { getRegisteredCommands } from '@/lib/commands/registry';
import { reportError } from '@/lib/errorReporter';

/**
 * Whether the default command set has been installed at least once in this
 * process. Consulted together with the live registry contents so a consumer
 * (or a test) that clears the registry between renders is repaired rather than
 * left with an empty palette.
 */
let defaultCommandsRegistered = false;

/**
 * Installs the default command palette entries, at most once per process.
 *
 * Invariant: safe to call on every render and under concurrent invocation.
 *  - Idempotent: a populated registry short-circuits, so repeated calls cannot
 *    produce duplicate or half-registered state (`registerCommand` is keyed by
 *    id, so even a forced re-registration is last-write-wins).
 *  - Self-healing: if the registry was emptied after the flag was set, the
 *    commands are re-installed.
 *  - Never throws: a registry failure is reported and swallowed so the root
 *    layout still server-renders. An empty palette is recoverable.
 */
function ensureDefaultCommandsRegistered(): void {
  if (defaultCommandsRegistered && getRegisteredCommands().length > 0) {
    return;
  }

  try {
    registerDefaultCommands();
    defaultCommandsRegistered = true;
  } catch (err) {
    defaultCommandsRegistered = false;
    reportError(err, 'registerDefaultCommands', 'error', {
      location: 'layout command registration',
    });
  }
}

// Install once at module initialisation time so the palette is ready on the
// very first server render, and again per render in case the registry was reset.
ensureDefaultCommandsRegistered();

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Re-assert the invariant on every render. This is a no-op when the
  // flag is already set, and it repairs the state if a consumer (or a
  // test) has reset the registry between renders.
  ensureDefaultCommandsRegistered();

  return (
    <html lang="en">
      <body>
        <PreferencesProvider>
          <ToastProvider>
            <WalletProvider>
              <CommandPaletteProvider>
                {/* Layout shell: header + main are the only focusable
                    landmarks; the skip link below must remain the first
                    focusable element in DOM order. */}
                {/* Skip link must be the first focusable element so keyboard users
                    can bypass the sticky header on every page (WCAG 2.4.1). */}
                <a
                  href="#main-content"
                  className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-blue-600 focus:px-4 focus:py-2 focus:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  Skip to main content
                </a>
                {/* RouteAnnouncer must precede the shell so that route
                    changes are announced before focus moves into main. */}
                <RouteAnnouncer />
                <div className="min-h-screen bg-slate-50 flex flex-col">
                  <header className="sticky top-0 z-40 flex w-full flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-white/80 px-6 py-4 backdrop-blur-md">
                    <div className="flex items-center gap-2">
                      <span className="text-xl font-bold tracking-tight text-slate-900">
                        TalentTrust
                      </span>
                    </div>
                    {/*
                     * Navbar and HeaderActions are wrapped in independent SafeBoundary
                     * instances so that a render failure in one does not cascade to
                     * the other, and neither can kill the surrounding header chrome.
                     *
                     * Invariant: each boundary is independent — a throw inside Navbar
                     * cannot enter the HeaderActions subtree, and vice versa.
                     */}
                    <SafeBoundary fallbackTitle="Navigation failed to load.">
                      <Navbar />
                    </SafeBoundary>
                    <SafeBoundary fallbackTitle="Header actions failed to load.">
                      <HeaderActions />
                    </SafeBoundary>
                  </header>
                  {/*
                   * Page content is isolated in its own SafeBoundary so that a
                   * route-level render crash does not take down the sticky header,
                   * navigation, or wallet controls. The user can still navigate
                   * away after a main-content failure.
                   *
                   * Invariant: SafeBoundary calls reportError via componentDidCatch,
                   * so every caught exception is observable in logs/metrics without
                   * exposing the raw error message in the UI.
                   */}
                  <main className="flex-1 p-6" tabIndex={-1} id="main-content">
                    <SafeBoundary fallbackTitle="This page failed to load.">
                      {children}
                    </SafeBoundary>
                  </main>
                </div>
                <CommandPalette />
                <SettingsTrigger />
              </CommandPaletteProvider>
            </WalletProvider>
          </ToastProvider>
        </PreferencesProvider>
      </body>
    </html>
  );
}
 
/**
 * Layout invariants (concurrency hardening):
 * - `siteUrl`/`metadataBase` are computed once at module load from a
 *   validated, normalized origin; concurrent renders observe the same value.
 * - Default command registration is idempotent across repeated or racing
 *   module evaluation, preventing duplicate palette entries.
 * - Provider nesting order is stable and deterministic; no per-render side
 *   effects are introduced here, so retries and partial failures cannot
 *   leave the tree in an inconsistent state.
 */
