import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Topbar } from './_components/topbar';

export const metadata: Metadata = {
  title: '财神爷 — Mission Control',
  description: 'Forex trading desk — code-defined v1',
};

export default function RootLayout({ children }: { children: ReactNode }): React.ReactElement {
  return (
    <html lang="en">
      <body>
        <Topbar />
        {children}
      </body>
    </html>
  );
}
