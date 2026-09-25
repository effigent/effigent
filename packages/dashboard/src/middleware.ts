import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

// Everything requires Clerk auth except sign-in/sign-up and the machine
// (collector) endpoints, which authenticate with Bearer cck_ keys inside the
// route handlers themselves.
const isPublic = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/v1/ingest',
  '/v1/traces',
  '/v1/logs', // OTLP logs (Codex token usage) — Bearer keys inside the handler
  '/api/v1/webhooks/clerk', // Clerk org.created → provision bucket; Svix-signature auth
  '/api/v1/agents', // GET uses Clerk auth() internally; POST uses Bearer keys
  '/api/v1/reports',
  '/api/v1/optimize', // CLI activation bundle — Bearer keys inside the handler
  '/api/v1/recommendations', // `effigent recommendations` — Bearer keys or Clerk, inside the handler
  '/api/v1/experiments', // `effigent applied` — Bearer keys or Clerk, inside the handler (lib/caller.ts)
  '/healthz', // liveness probe (effigent doctor) — public, no auth, no DB
]);

export default clerkMiddleware(async (auth, req) => {
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
