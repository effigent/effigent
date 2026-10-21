import { NextResponse, type NextRequest } from 'next/server';
import { authMode } from '@/lib/auth-mode.ts';
import { TX_COOKIE, cookieOptions, discovery, oidcConfig, randomString, safeReturn, seal, sha256b64url } from '@/lib/oidc.ts';

export const dynamic = 'force-dynamic';

/** Starts an OIDC sign-in (authorization code + PKCE). Self-hosted only. */
export async function GET(req: NextRequest) {
  if (authMode() !== 'oidc') return new Response('Not found', { status: 404 });
  let cfg;
  try {
    cfg = oidcConfig();
    const d = await discovery(cfg);
    const verifier = randomString(32);
    const tx = { v: verifier, s: randomString(16), n: randomString(16), r: safeReturn(req.nextUrl.searchParams.get('returnTo')), t: Date.now() };
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: `${cfg.consoleUrl}/auth/callback`,
      scope: cfg.scopes,
      state: tx.s,
      nonce: tx.n,
      code_challenge: await sha256b64url(verifier),
      code_challenge_method: 'S256',
    }).toString();
    const res = NextResponse.redirect(url);
    res.headers.set('Cache-Control', 'no-store');
    res.cookies.set(TX_COOKIE, await seal(tx, cfg.secret, TX_COOKIE), cookieOptions(cfg, 600, '/auth'));
    return res;
  } catch (e) {
    console.error('[oidc] login:', e);
    return new Response(`Sign-in is unavailable: ${e instanceof Error ? e.message : String(e)}`, { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}
