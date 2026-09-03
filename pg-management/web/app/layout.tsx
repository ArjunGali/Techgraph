import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ThemeProvider, THEME_BOOTSTRAP_SCRIPT } from '@/lib/theme';
import { AuthProvider } from '@/lib/auth';
import { AuthGate } from '@/components/AuthGate';

export const metadata: Metadata = {
  title: 'PG Management',
  description: 'Multi-branch paying-guest operations: tenants, billing, electricity and payments.',
  applicationName: 'PG Management',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Pinch-zoom is left enabled for accessibility; the layout adapts instead of
  // relying on the user zooming out to see content.
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
    { media: '(prefers-color-scheme: dark)', color: '#020617' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the stored theme before the first paint, so a dark-mode
            device never flashes a white screen on launch. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>
            <AuthGate>{children}</AuthGate>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
