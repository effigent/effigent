import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { devNoAuth } from '@/lib/dev-auth.ts';
import { authMode } from '@/lib/auth-mode.ts';
import { THEME_SCRIPT } from '@/lib/theme-script.ts';
import '../theme.css';

export const metadata: Metadata = {
  title: { default: 'Effigent · AI Agent Control Plane', template: '%s · Effigent' },
  description: 'Discover AI coding agents on your endpoints, enforce allow/deny policies locally, route risky actions to human approvers, and keep an audit trail.',
};

/** Clerk's sign-in, user and org widgets follow the console theme through its tokens (theme.css). */
const clerkAppearance = {
  variables: {
    colorPrimary: 'var(--accent)',
    colorPrimaryForeground: 'var(--on-accent)',
    colorBackground: 'var(--panel)',
    colorForeground: 'var(--txt)',
    colorMutedForeground: 'var(--txt-2)',
    colorMuted: 'var(--panel-2)',
    colorNeutral: 'var(--txt)',
    colorBorder: 'var(--border)',
    colorInput: 'var(--inset)',
    colorInputForeground: 'var(--txt)',
    colorDanger: 'var(--red)',
    colorSuccess: 'var(--green)',
    colorWarning: 'var(--gold)',
    colorRing: 'var(--accent-line)',
    colorShadow: 'rgba(0, 0, 0, 0.25)',
    colorModalBackdrop: 'var(--overlay)',
    fontFamily: 'var(--sans)',
    borderRadius: '10px',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-theme is rewritten before first paint by THEME_SCRIPT (Light / Dark / System).
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{devNoAuth || authMode() === 'oidc' ? children : <ClerkProvider appearance={clerkAppearance}>{children}</ClerkProvider>}</body>
    </html>
  );
}
