'use client';

/**
 * Browser side of the self-hosted OIDC sign-in: the token for the control
 * plane comes from this console's own /auth/token (the refresh token stays in
 * the httpOnly session cookie). Cached until 45s before it expires; one
 * request at a time. 401 = the session is gone: back to sign-in.
 */
let cached: { token: string; exp: number } | null = null;
let inflight: Promise<string | null> | null = null;

export function signInAgain() {
  const here = window.location.pathname + window.location.search;
  window.location.assign(`/auth/login?returnTo=${encodeURIComponent(here)}`);
}

export function oidcToken(): Promise<string | null> {
  if (cached && cached.exp * 1000 - Date.now() > 45_000) return Promise.resolve(cached.token);
  inflight ??= fetch('/auth/token', { cache: 'no-store', credentials: 'same-origin' })
    .then(async (r) => {
      if (r.status === 401) {
        cached = null;
        signInAgain();
        return null;
      }
      const j = (await r.json().catch(() => ({}))) as { token?: string; expires_at?: number; error?: string };
      if (!r.ok || !j.token) throw new Error(j.error || `sign-in service answered ${r.status}`);
      cached = { token: j.token, exp: j.expires_at ?? 0 };
      return j.token;
    })
    .finally(() => { inflight = null; });
  return inflight;
}
