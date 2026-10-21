import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { auth } from '@clerk/nextjs/server';
import { AppShell } from '@/components/AppShell.tsx';
import { ClerkUserMenu } from '@/components/ClerkUserMenu.tsx';
import { OidcUserMenu } from '@/components/OidcUserMenu.tsx';
import { devNoAuth } from '@/lib/dev-auth.ts';
import { authMode, runtimeApiUrl } from '@/lib/auth-mode.ts';
import { oidcConfig, readSession } from '@/lib/oidc.ts';
import { RuntimeProvider } from '@/lib/runtime.tsx';

export const dynamic = 'force-dynamic';

// Auth is checked twice: clerkMiddleware → auth.protect(), and here (path
// matching in middleware can diverge from routing). Under the dev bypass
// (lib/dev-auth.ts — never in production builds) Clerk is not running at all,
// so auth() is skipped and the shell shows the fixed dev identity instead.
// Self-hosted (EFFIGENT_AUTH_MODE=oidc): the sealed session cookie instead of
// Clerk (lib/oidc.ts); the control plane still verifies every token.
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  if (!devNoAuth && authMode() === 'oidc') {
    const cfg = oidcConfig();
    const jar = await cookies();
    const s = await readSession((n) => jar.get(n)?.value, cfg);
    if (!s) redirect('/auth/login');
    return (
      <RuntimeProvider value={{ auth: 'oidc', apiUrl: runtimeApiUrl() }}>
        <AppShell dev={false} userMenu={<OidcUserMenu name={s.name} email={s.email} provider={cfg.providerName} />}>
          {children}
        </AppShell>
      </RuntimeProvider>
    );
  }
  if (!devNoAuth) {
    const { userId } = await auth();
    if (!userId) redirect('/sign-in');
  }
  return (
    <RuntimeProvider value={{ auth: 'clerk', apiUrl: runtimeApiUrl() }}>
      <AppShell dev={devNoAuth} userMenu={devNoAuth ? null : <ClerkUserMenu />}>
        {children}
      </AppShell>
    </RuntimeProvider>
  );
}
