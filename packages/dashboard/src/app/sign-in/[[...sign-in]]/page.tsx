import { redirect } from 'next/navigation';
import { SignIn } from '@clerk/nextjs';
import { devNoAuth } from '@/lib/dev-auth.ts';

export default function Page() {
  // No ClerkProvider under the dev bypass (lib/dev-auth.ts) — go straight in.
  if (devNoAuth) redirect('/');
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', background: 'var(--bg)' }}>
      <SignIn />
    </div>
  );
}
