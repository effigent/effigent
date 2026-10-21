import { NextResponse, type NextRequest } from 'next/server';
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { devNoAuth } from '@/lib/dev-auth.ts';
import { authMode } from '@/lib/auth-mode.ts';
import { SESSION_COOKIE } from '@/lib/oidc.ts';

// Everything requires Clerk auth except sign-in/sign-up, the Clerk webhook
// (Svix-signature auth inside the handler) and the liveness probe.
const isPublic = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/v1/webhooks/clerk', // Clerk org.created → provision bucket; Svix-signature auth
  '/healthz', // liveness probe — public, no auth, no DB
]);

const clerk = clerkMiddleware(async (auth, req) => {
  if (!isPublic(req)) await auth.protect();
});

/** Self-hosted (EFFIGENT_AUTH_MODE=oidc): pages need the session cookie; the
 *  console layout checks it properly and the control plane checks every token.
 *  The Clerk-only routes (v1 run storage, Clerk's webhook) don't exist here. */
function oidc(req: NextRequest) {
  const p = req.nextUrl.pathname;
  if (p.startsWith('/api/v1/storage') || p.startsWith('/api/v1/webhooks/clerk') || p.startsWith('/sign-up')) return new NextResponse('Not found', { status: 404 });
  if (p.startsWith('/auth/') || p === '/healthz' || p.startsWith('/sign-in')) return NextResponse.next();
  if (req.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const login = new URL('/auth/login', req.url);
  login.searchParams.set('returnTo', p + req.nextUrl.search);
  return NextResponse.redirect(login);
}

// Dev-only bypass (see lib/dev-auth.ts): `devNoAuth` is a build-time `false`
// in production, so this always resolves to clerkMiddleware there unless the
// server runs self-hosted with EFFIGENT_AUTH_MODE=oidc.
export default devNoAuth ? () => NextResponse.next() : authMode() === 'oidc' ? oidc : clerk;

export const config = {
  matcher: [
    // Skip Next internals and static files, run on everything else.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/:path*',
  ],
};
