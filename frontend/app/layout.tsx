import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import './product.css';
import './experience.css';
export const metadata: Metadata = {
  title: 'Samana QMS | Customer Experience',
  description:
    'Samana Developers customer queue management, service routing and operations.',
  robots: { index: false, follow: false },
  // Build time has no environment, so this one read stays tolerant.
  metadataBase: new URL(process.env.APP_ORIGIN || 'http://localhost:3000'),
  openGraph: {
    title: 'SAMANA | Customer Experience',
    description: 'Your visit, thoughtfully connected.',
    images: [
      {
        url: '/images/samana-project-1.jpg',
        width: 1920,
        height: 1080,
        alt: 'SAMANA Ocean Pearl architectural render',
      },
    ],
  },
};
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // The script policy carries a nonce minted per request (proxy.ts). Reading
  // the request headers here renders every page per request, so the nonce
  // Next.js stamps on its bootstrap script is the one the policy allows; a
  // page prerendered at build time would carry a stale nonce and be blocked.
  await headers();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
