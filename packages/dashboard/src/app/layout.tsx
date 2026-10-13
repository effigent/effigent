import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { devNoAuth } from '@/lib/dev-auth.ts';
import '../theme.css';

export const metadata: Metadata = {
  title: { default: 'Effigent · AI Agent Control Plane', template: '%s · Effigent' },
  description: 'Discover AI coding agents on your endpoints, enforce allow/deny policies locally, route risky actions to human approvers, and keep an audit trail.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body>{devNoAuth ? children : <ClerkProvider>{children}</ClerkProvider>}</body>
    </html>
  );
}
