/**
 * Self-hosted sign-in (EFFIGENT_AUTH_MODE=oidc): OpenID Connect authorization
 * code flow with PKCE against the customer's identity provider. Server only.
 *
 *  /auth/login     state + nonce + PKCE verifier in a short-lived sealed cookie → the provider
 *  /auth/callback  code → tokens (server to server), session cookie set
 *  /auth/token     the token the browser sends to the control plane, refreshed
 *                  with the refresh token when it has under a minute left
 *  /auth/logout    clears the session (and ends it at the provider when it can)
 *
 * The session cookie is httpOnly, sealed with AES-256-GCM under
 * EFFIGENT_SESSION_SECRET, and holds the token sent to the control plane plus
 * the refresh token; JavaScript never sees the refresh token. The control
 * plane verifies every token against the provider's keys itself
 * (internal/controlplane/server/oidc.go); the console only checks what the
 * token endpoint returned (iss, aud, nonce, exp), which OIDC allows for a
 * token received directly from the provider over TLS.
 */

export const SESSION_COOKIE = 'effigent_session';
export const TX_COOKIE = 'effigent_oidc_tx';
const CHUNK = 3600; // cookie value chars per chunk (browsers cap a cookie at ~4 KB)
const MAX_CHUNKS = 8;

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string; // "" = public client (PKCE only)
  scopes: string;
  consoleUrl: string; // public URL of this console, e.g. https://effigent.corp.example
  secret: string;
  token: 'id_token' | 'access_token'; // what the control plane receives
  providerName: string;
  sessionHours: number;
  secure: boolean;
}

export function oidcConfig(): OidcConfig {
  const env = (k: string) => (process.env[k] ?? '').trim();
  const missing = ['EFFIGENT_OIDC_ISSUER', 'EFFIGENT_OIDC_CLIENT_ID', 'EFFIGENT_CONSOLE_URL', 'EFFIGENT_SESSION_SECRET'].filter((k) => !env(k));
  if (missing.length) throw new Error(`OIDC sign-in is not configured: set ${missing.join(', ')}`);
  if (env('EFFIGENT_SESSION_SECRET').length < 32) throw new Error('EFFIGENT_SESSION_SECRET must be at least 32 characters');
  const consoleUrl = env('EFFIGENT_CONSOLE_URL').replace(/\/+$/, '');
  return {
    issuer: env('EFFIGENT_OIDC_ISSUER'),
    clientId: env('EFFIGENT_OIDC_CLIENT_ID'),
    clientSecret: env('EFFIGENT_OIDC_CLIENT_SECRET'),
    scopes: env('EFFIGENT_OIDC_SCOPES') || 'openid email profile offline_access',
    consoleUrl,
    secret: env('EFFIGENT_SESSION_SECRET'),
    token: env('EFFIGENT_OIDC_TOKEN') === 'access_token' ? 'access_token' : 'id_token',
    providerName: env('EFFIGENT_OIDC_PROVIDER_NAME') || 'your identity provider',
    sessionHours: Math.min(Math.max(Number(env('EFFIGENT_SESSION_HOURS')) || 12, 1), 24 * 30),
    secure: consoleUrl.startsWith('https://'),
  };
}

// ---- discovery ----

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; end_session_endpoint?: string }
let disc: { at: number; doc: Discovery; issuer: string } | null = null;

export async function discovery(cfg: OidcConfig): Promise<Discovery> {
  if (disc && disc.issuer === cfg.issuer && Date.now() - disc.at < 10 * 60_000) return disc.doc;
  const res = await fetch(`${cfg.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`OIDC discovery answered ${res.status}`);
  const doc = (await res.json()) as Discovery;
  if (doc.issuer !== cfg.issuer) throw new Error(`OIDC discovery: the provider says its issuer is ${doc.issuer}, configured ${cfg.issuer} (they must match exactly)`);
  if (!doc.authorization_endpoint || !doc.token_endpoint) throw new Error('OIDC discovery: no authorization or token endpoint');
  disc = { at: Date.now(), doc, issuer: cfg.issuer };
  return doc;
}

// ---- sealing (AES-256-GCM, Web Crypto: works in Node and edge runtimes) ----

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomString(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256b64url(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
}

async function key(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`effigent-console-session:${secret}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** purpose binds a sealed value to its cookie, so one can't be swapped for another. */
export async function seal(value: unknown, secret: string, purpose: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(purpose) }, await key(secret), enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64url(out);
}

export async function unseal<T>(sealed: string | undefined, secret: string, purpose: string): Promise<T | null> {
  if (!sealed) return null;
  try {
    const b = unb64url(sealed);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), additionalData: enc.encode(purpose) }, await key(secret), b.slice(12));
    return JSON.parse(dec.decode(pt)) as T;
  } catch {
    return null;
  }
}

// ---- the session ----

export interface Session {
  sub: string;
  name: string;
  email: string;
  tok: string; // sent to the control plane as Bearer
  exp: number; // tok's expiry, unix seconds
  rt?: string; // refresh token
  idt?: string; // ID token for the provider's logout (only when tok is the access token)
  iat: number; // sign-in time: the session ends sessionHours later, refresh or not
}

type CookieGet = (name: string) => string | undefined;

export async function readSession(get: CookieGet, cfg: OidcConfig): Promise<Session | null> {
  const head = get(SESSION_COOKIE);
  if (!head) return null;
  let sealed = head;
  const m = /^chunks:(\d)$/.exec(head);
  if (m) {
    const parts: string[] = [];
    for (let i = 0; i < Number(m[1]); i++) {
      const p = get(`${SESSION_COOKIE}.${i}`);
      if (!p) return null;
      parts.push(p);
    }
    sealed = parts.join('');
  }
  const s = await unseal<Session>(sealed, cfg.secret, SESSION_COOKIE);
  if (!s || !s.tok || Date.now() / 1000 - s.iat > cfg.sessionHours * 3600) return null;
  return s;
}

export interface CookieSet { name: string; value: string; maxAge: number }

/** The cookies that store `s` (chunked when large) and clear leftover chunks. */
export async function sessionCookies(s: Session | null, cfg: OidcConfig, present: (name: string) => boolean): Promise<CookieSet[]> {
  const out: CookieSet[] = [];
  const maxAge = s ? Math.max(60, Math.floor(s.iat + cfg.sessionHours * 3600 - Date.now() / 1000)) : 0;
  let n = 0;
  if (s) {
    const sealed = await seal(s, cfg.secret, SESSION_COOKIE);
    if (sealed.length <= CHUNK) out.push({ name: SESSION_COOKIE, value: sealed, maxAge });
    else {
      n = Math.ceil(sealed.length / CHUNK);
      if (n > MAX_CHUNKS) throw new Error('the identity provider\'s tokens are too large for a session cookie');
      out.push({ name: SESSION_COOKIE, value: `chunks:${n}`, maxAge });
      for (let i = 0; i < n; i++) out.push({ name: `${SESSION_COOKIE}.${i}`, value: sealed.slice(i * CHUNK, (i + 1) * CHUNK), maxAge });
    }
  } else out.push({ name: SESSION_COOKIE, value: '', maxAge: 0 });
  for (let i = n; i < MAX_CHUNKS; i++) if (present(`${SESSION_COOKIE}.${i}`)) out.push({ name: `${SESSION_COOKIE}.${i}`, value: '', maxAge: 0 });
  return out;
}

export function cookieOptions(cfg: OidcConfig, maxAge: number, path = '/') {
  return { httpOnly: true, secure: cfg.secure, sameSite: 'lax' as const, path, maxAge };
}

// ---- tokens ----

export interface TokenResponse { id_token?: string; access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }

export async function tokenRequest(cfg: OidcConfig, params: Record<string, string>): Promise<TokenResponse> {
  const d = await discovery(cfg);
  const body = new URLSearchParams({ ...params, client_id: cfg.clientId });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (cfg.clientSecret) headers.Authorization = `Basic ${btoa(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`)}`;
  const res = await fetch(d.token_endpoint, { method: 'POST', headers, body, cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  const j = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || j.error) throw new Error(`token endpoint: ${j.error_description || j.error || `HTTP ${res.status}`}`);
  return j;
}

/** A JWT's payload, unverified (see the header comment for why that is enough here). */
export function jwtPayload(t: string | undefined): Record<string, unknown> | null {
  if (!t) return null;
  const p = t.split('.');
  if (p.length !== 3) return null;
  try {
    return JSON.parse(dec.decode(unb64url(p[1]))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Builds the session from a token response; checks the ID token (iss, aud, nonce, exp). */
export function sessionFrom(cfg: OidcConfig, t: TokenResponse, prev: Session | null, nonce?: string): Session {
  const now = Math.floor(Date.now() / 1000);
  const id = jwtPayload(t.id_token);
  if (id) {
    const aud = Array.isArray(id.aud) ? id.aud : [id.aud];
    if (id.iss !== cfg.issuer) throw new Error('the ID token is from another issuer');
    if (!aud.includes(cfg.clientId)) throw new Error('the ID token is for another client');
    if (nonce !== undefined && id.nonce !== nonce) throw new Error('the ID token\'s nonce does not match this sign-in');
    if (typeof id.exp !== 'number' || id.exp < now - 30) throw new Error('the ID token has expired');
  } else if (!prev) throw new Error('the provider returned no ID token (is the "openid" scope requested?)');
  const tok = cfg.token === 'access_token' ? t.access_token : t.id_token;
  if (!tok) throw new Error(`the provider returned no ${cfg.token}`);
  const tp = jwtPayload(tok);
  const exp = typeof tp?.exp === 'number' ? tp.exp : now + (t.expires_in ?? 300);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    sub: str(id?.sub) || prev?.sub || '',
    name: str(id?.name) || str(id?.preferred_username) || prev?.name || '',
    email: str(id?.email) || prev?.email || '',
    tok,
    exp,
    rt: t.refresh_token || prev?.rt,
    idt: cfg.token === 'access_token' ? t.id_token || prev?.idt : undefined,
    iat: prev?.iat ?? now,
  };
}

/** Only same-site paths: `returnTo` must never send people elsewhere. */
export function safeReturn(p: string | null | undefined): string {
  if (!p || !p.startsWith('/') || p.startsWith('//') || p.startsWith('/\\') || p.startsWith('/auth/')) return '/';
  return p.slice(0, 2000);
}
