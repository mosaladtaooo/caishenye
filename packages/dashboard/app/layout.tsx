import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: '财神爷 — Mission Control',
  description: 'Code-defined forex trading desk',
};

export default function RootLayout({ children }: { children: ReactNode }): React.ReactElement {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
