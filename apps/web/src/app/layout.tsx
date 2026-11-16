import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import './globals.css';
import { SessionProvider } from '@/components/session';
import { Shell } from '@/components/shell';
import { CampaignsProvider } from '@/components/campaigns';
import { I18nProvider } from '@/lib/i18n';
import { THEME_INIT_SCRIPT, ThemeProvider } from '@/lib/theme';

export const metadata: Metadata = {
  title: 'Bingo 251',
  description: 'Live 75-ball and 90-ball bingo for Ethiopia — agent cash-in, cash-out and instant payouts.',
  applicationName: 'Bingo 251',
  icons: { icon: '/icon.svg', apple: '/apple-touch-icon.png' },
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
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-ink font-sans text-text antialiased">
        <Script id="bingo-theme" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
        <Script src="/config.js" strategy="beforeInteractive" />
        <ThemeProvider>
          <SessionProvider>
            <I18nProvider>
              <CampaignsProvider>
                <Shell>{children}</Shell>
              </CampaignsProvider>
            </I18nProvider>
          </SessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
