import { NextResponse, type NextRequest } from 'next/server';
import { authMode } from '@/lib/auth-mode.ts';
import { cookieOptions, oidcConfig, readSession, sessionCookies, sessionFrom, tokenRequest } from '@/lib/oidc.ts';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * The token the browser sends to the control plane (same origin only: no
 * CORS headers, so another site can't read it). Refreshed with the refresh
 * token when it has under a minute left; 401 means "sign in again".
 */
export async function GET(req: NextRequest) {
  if (authMode() !== 'oidc') return new Response('Not found', { status: 404 });
  if (req.headers.get('sec-fetch-site') && req.headers.get('sec-fetch-site') !== 'same-origin') return json({ error: 'same-origin only' }, 403);
  let cfg;
  try {
    cfg = oidcConfig();
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 503);
  }
  const s = await readSession((n) => req.cookies.get(n)?.value, cfg);
  const now = Date.now() / 1000;
  if (!s) return json({ error: 'not signed in' }, 401);
  if (s.exp - now > 60) return json({ token: s.tok, expires_at: s.exp, name: s.name, email: s.email });
  const clear = async (why: string) => {
    const res = json({ error: why }, 401);
    for (const c of await sessionCookies(null, cfg, (n) => req.cookies.has(n))) res.cookies.set(c.name, c.value, cookieOptions(cfg, 0));
    return res;
  };
  if (!s.rt) return clear('session expired');
  try {
    const t = await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: s.rt });
    const next = sessionFrom(cfg, t, s);
    const res = json({ token: next.tok, expires_at: next.exp, name: next.name, email: next.email });
    for (const c of await sessionCookies(next, cfg, (n) => req.cookies.has(n))) res.cookies.set(c.name, c.value, cookieOptions(cfg, c.maxAge));
    return res;
  } catch (e) {
    console.error('[oidc] refresh:', e);
    return clear('session expired');
  }
}
