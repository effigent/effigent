/**
 * Which sign-in the console uses, decided on the server at run time:
 *  - `clerk` (default): the SaaS console (app.effigent.ai), Clerk's SDK.
 *  - `oidc`: a self-hosted console (EFFIGENT_AUTH_MODE=oidc) signing people in
 *    with the customer's own OpenID Connect provider (lib/oidc.ts, app/auth/*).
 * The client never decides: layouts pass the result down (RuntimeProvider).
 */
export type AuthMode = 'clerk' | 'oidc';

export function authMode(): AuthMode {
  return process.env.EFFIGENT_AUTH_MODE === 'oidc' ? 'oidc' : 'clerk';
}

/** The control plane's public URL for the browser, from the server's run-time
 *  env (a self-hosted image can't bake NEXT_PUBLIC_* at build time). Unset on
 *  the SaaS console, which keeps NEXT_PUBLIC_EFFIGENT_API_URL. */
export function runtimeApiUrl(): string | undefined {
  const u = process.env.EFFIGENT_API_URL?.trim();
  return u ? u.replace(/\/+$/, '') : undefined;
}
