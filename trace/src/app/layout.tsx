import type { Metadata, Viewport } from 'next';
import './globals.css';
import { RegisterSW } from '@/components/rider/RegisterSW';

export const metadata: Metadata = {
  title: 'TRACE',
  description: 'Delivery tracking and verification.',
  manifest: '/manifest.webmanifest',
  // NFR-SEC-017: no authenticated or token-bearing route is indexable.
  robots: { index: false, follow: false, nocache: true },
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'TRACE' },
};

export const viewport: Viewport = {
  themeColor: '#05070a',
  width: 'device-width',
  initialScale: 1,
  // Riders wear gloves and squint in sunlight. Never block their zoom.
  maximumScale: 5,
  userScalable: true,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-ink-900 antialiased">
        <RegisterSW />
        {children}
      </body>
    </html>
  );
}
