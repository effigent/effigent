import { redirect } from 'next/navigation';
import { SignIn } from '@clerk/nextjs';
import { devNoAuth } from '@/lib/dev-auth.ts';
import { authMode } from '@/lib/auth-mode.ts';

/** Self-hosted (OIDC): one button to the customer's identity provider. */
async function OidcSignIn({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const error = one(q.error).slice(0, 300);
  const provider = (process.env.EFFIGENT_OIDC_PROVIDER_NAME ?? '').trim() || 'your identity provider';
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', background: 'var(--bg)', padding: 16 }}>
      <div className="card" style={{ width: 'min(400px, 100%)', padding: 28, textAlign: 'center' }}>
        <h1 className="card-title" style={{ justifyContent: 'center', marginBottom: 6 }}>Effigent</h1>
        <p className="card-sub" style={{ marginBottom: 20 }}>{one(q.signed_out) ? 'You are signed out.' : 'Sign in to the console.'}</p>
        {error && <div className="callout bad" role="alert" style={{ marginBottom: 16, textAlign: 'left' }}><span>{error}</span></div>}
        <a className="btn primary" href="/auth/login" style={{ width: '100%', justifyContent: 'center' }}>Sign in with {provider}</a>
      </div>
    </div>
  );
}

export default function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // No ClerkProvider under the dev bypass (lib/dev-auth.ts) — go straight in.
  if (devNoAuth) redirect('/');
  if (authMode() === 'oidc') return <OidcSignIn searchParams={searchParams} />;
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', background: 'var(--bg)' }}>
      <SignIn />
    </div>
  );
}
