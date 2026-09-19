import type { Metadata } from 'next';
import './globals.css';
import './product.css';
export const metadata: Metadata = {
  title: 'Samana QMS | Customer Experience',
  description:
    'Samana Developers customer queue management, service routing and operations.',
  robots: { index: false, follow: false },
  metadataBase: new URL('https://samana-qms.jolly-hippo-1106.chatgpt.site'),
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
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
