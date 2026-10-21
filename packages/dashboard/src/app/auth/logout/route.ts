import { NextResponse, type NextRequest } from 'next/server';
import { authMode } from '@/lib/auth-mode.ts';
import { cookieOptions, discovery, oidcConfig, readSession, sessionCookies } from '@/lib/oidc.ts';

export const dynamic = 'force-dynamic';

/** Sign out (POST from the user menu): clear the session, then end it at the
 *  provider when it offers an end-session endpoint. */
export async function POST(req: NextRequest) {
  if (authMode() !== 'oidc') return new Response('Not found', { status: 404 });
  const cfg = oidcConfig();
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(cfg.consoleUrl).origin) return new Response('Forbidden', { status: 403 });
  const s = await readSession((n) => req.cookies.get(n)?.value, cfg);
  let to = `${cfg.consoleUrl}/sign-in?signed_out=1`;
  try {
    const d = await discovery(cfg);
    if (d.end_session_endpoint) {
      const u = new URL(d.end_session_endpoint);
      const hint = cfg.token === 'id_token' ? s?.tok : s?.idt;
      if (hint) u.searchParams.set('id_token_hint', hint);
      u.searchParams.set('client_id', cfg.clientId);
      u.searchParams.set('post_logout_redirect_uri', to);
      to = u.toString();
    }
  } catch { /* the provider is unreachable: the local session still ends */ }
  const res = NextResponse.redirect(to, 303);
  for (const c of await sessionCookies(null, cfg, (n) => req.cookies.has(n))) res.cookies.set(c.name, c.value, cookieOptions(cfg, 0));
  return res;
}
