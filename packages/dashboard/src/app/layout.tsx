import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import '../theme.css';

export const metadata: Metadata = {
  title: 'Optimizer — Dashboard',
  description: 'Agent optimization dashboard.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body>
        <ClerkProvider>{children}</ClerkProvider>
      </body>
    </html>
  );
}
