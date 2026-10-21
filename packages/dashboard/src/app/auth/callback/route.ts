import { NextResponse, type NextRequest } from 'next/server';
import { authMode } from '@/lib/auth-mode.ts';
import { TX_COOKIE, cookieOptions, oidcConfig, sessionCookies, sessionFrom, tokenRequest, unseal } from '@/lib/oidc.ts';

export const dynamic = 'force-dynamic';

interface Tx { v: string; s: string; n: string; r: string; t: number }

/** The provider sends people back here with a code; exchange it and start the session. */
export async function GET(req: NextRequest) {
  if (authMode() !== 'oidc') return new Response('Not found', { status: 404 });
  let cfg;
  try {
    cfg = oidcConfig();
  } catch (e) {
    return new Response(String(e instanceof Error ? e.message : e), { status: 503 });
  }
  const back = (err: string) => {
    const res = NextResponse.redirect(`${cfg.consoleUrl}/sign-in?error=${encodeURIComponent(err)}`);
    res.cookies.set(TX_COOKIE, '', cookieOptions(cfg, 0, '/auth'));
    return res;
  };
  const q = req.nextUrl.searchParams;
  if (q.get('error')) return back(q.get('error_description') || q.get('error') || 'sign-in failed');
  const tx = await unseal<Tx>(req.cookies.get(TX_COOKIE)?.value, cfg.secret, TX_COOKIE);
  if (!tx || Date.now() - tx.t > 10 * 60_000) return back('The sign-in took too long or started in another browser. Try again.');
  const code = q.get('code');
  if (!code || q.get('state') !== tx.s) return back('The sign-in response did not match this browser\'s request. Try again.');
  try {
    const t = await tokenRequest(cfg, { grant_type: 'authorization_code', code, redirect_uri: `${cfg.consoleUrl}/auth/callback`, code_verifier: tx.v });
    const s = sessionFrom(cfg, t, null, tx.n);
    const res = NextResponse.redirect(`${cfg.consoleUrl}${tx.r}`);
    res.headers.set('Cache-Control', 'no-store');
    for (const c of await sessionCookies(s, cfg, (n) => req.cookies.has(n))) res.cookies.set(c.name, c.value, cookieOptions(cfg, c.maxAge));
    res.cookies.set(TX_COOKIE, '', cookieOptions(cfg, 0, '/auth'));
    return res;
  } catch (e) {
    console.error('[oidc] callback:', e);
    return back(e instanceof Error ? e.message : 'sign-in failed');
  }
}
