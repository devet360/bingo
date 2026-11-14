import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import './globals.css';
import { SessionProvider } from '@/components/session';
import { Shell } from '@/components/shell';
import { I18nProvider } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Bingo Hall',
  description: 'Live 75-ball and 90-ball bingo with agent cash-in and cash-out.',
  applicationName: 'Bingo Hall',
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#050d0b',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-ink font-sans text-text antialiased">
        <Script src="/config.js" strategy="beforeInteractive" />
        <SessionProvider>
          <I18nProvider>
            <Shell>{children}</Shell>
          </I18nProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
