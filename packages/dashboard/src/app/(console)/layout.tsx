import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { AppShell } from '@/components/AppShell.tsx';
import { ClerkUserMenu } from '@/components/ClerkUserMenu.tsx';
import { devNoAuth } from '@/lib/dev-auth.ts';

export const dynamic = 'force-dynamic';

// Auth is checked twice: clerkMiddleware → auth.protect(), and here (path
// matching in middleware can diverge from routing). Under the dev bypass
// (lib/dev-auth.ts — never in production builds) Clerk is not running at all,
// so auth() is skipped and the shell shows the fixed dev identity instead.
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  if (!devNoAuth) {
    const { userId } = await auth();
    if (!userId) redirect('/sign-in');
  }
  return (
    <AppShell dev={devNoAuth} userMenu={devNoAuth ? null : <ClerkUserMenu />}>
      {children}
    </AppShell>
  );
}
