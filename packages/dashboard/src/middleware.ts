import { NextResponse } from 'next/server';
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { devNoAuth } from '@/lib/dev-auth.ts';

// Everything requires Clerk auth except sign-in/sign-up, the Clerk webhook
// (Svix-signature auth inside the handler) and the liveness probe.
const isPublic = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/v1/webhooks/clerk', // Clerk org.created → provision bucket; Svix-signature auth
  '/healthz', // liveness probe — public, no auth, no DB
]);

// Dev-only bypass (see lib/dev-auth.ts): `devNoAuth` is a build-time `false`
// in production, so this always resolves to clerkMiddleware there.
export default devNoAuth
  ? () => NextResponse.next()
  : clerkMiddleware(async (auth, req) => {
      if (!isPublic(req)) await auth.protect();
    });

export const config = {
  matcher: [
    // Skip Next internals and static files, run on everything else.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/:path*',
  ],
};
