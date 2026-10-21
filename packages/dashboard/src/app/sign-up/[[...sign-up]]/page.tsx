import { redirect } from 'next/navigation';
import { SignUp } from '@clerk/nextjs';
import { devNoAuth } from '@/lib/dev-auth.ts';
import { authMode } from '@/lib/auth-mode.ts';

export default function Page() {
  // No ClerkProvider under the dev bypass (lib/dev-auth.ts) — go straight in.
  if (devNoAuth) redirect('/');
  if (authMode() === 'oidc') redirect('/sign-in'); // accounts come from the identity provider
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', background: 'var(--bg)' }}>
      <SignUp />
    </div>
  );
}
