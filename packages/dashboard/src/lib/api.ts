/**
 * Control-plane API client (Go, internal/controlplane/server). Every
 * /api/v1/* call carries the signed-in user's Clerk session token; the server
 * derives the tenant from the token's active org (or the personal workspace)
 * and the role from the org membership — the console never sends either.
 *
 * Shapes below mirror the Go JSON exactly (snake_case), so a field rename on
 * the server shows up here as a type error, not a blank cell.
 */

/** Absolute on purpose: a relative `/api/v1/...` would hit this Next app's own
 *  route handlers (e.g. /api/v1/storage), not the control plane. */
export const API_BASE = (process.env.NEXT_PUBLIC_EFFIGENT_API_URL || 'https://api.effigent.ai').replace(/\/+$/, '');

/** server.Principal — GET /api/v1/me */
export interface ApiMe {
  user_id: string;
  tenant: string; // "org:<id>" | "user:<id>"
  role: string; // org role without the "org:" prefix, e.g. admin | security_admin | member
  via: 'clerk' | 'admin-token';
}

/** store.Endpoint — GET /api/v1/endpoints */
export interface ApiEndpoint {
  id: string;
  hostname: string;
  os: string; // runtime.GOOS: linux | darwin
  arch: string;
  version: string; // effigentd
  enrolled_at: string;
  last_seen: string | null;
  policy_version: number;
  revoked: boolean;
}

/** store.PolicyVersion — GET /api/v1/policy (with body), /policy/history (without) */
export interface ApiPolicyVersion {
  version: number; // 0 = nothing published yet (built-in default shown)
  body?: string;
  comment: string;
  created_by: string;
  created_at: string; // zero time when version is 0
}

/** event.Event — the body of a stored event, as effigentd sent it. */
export interface ApiEventBody {
  time?: string;
  node?: string;
  type?: string;
  severity?: string;
  agent?: string;
  agent_pid?: number;
  mode?: string;
  via?: string;
  kind?: string;
  process?: { pid: number; exec_id?: string; binary?: string; args?: string; cwd?: string; uid: number };
  target?: string;
  rule?: string;
  container?: string;
  message?: string;
}

/** store.Event — GET /api/v1/events */
export interface ApiEvent {
  id: number;
  endpoint_id: string;
  time: string;
  type: string;
  severity: string;
  agent: string;
  body: ApiEventBody | null;
}

/** store.AuditEntry — GET /api/v1/audit */
export interface ApiAuditEntry {
  seq: number;
  at: string;
  actor: string;
  actor_via: string;
  actor_role: string;
  action: string; // e.g. policy.publish, endpoint.revoke, enrollment_token.create, denied.PUT /api/v1/policy
  target: string;
  details: Record<string, unknown> | null;
  ip: string;
  prev_hash: string;
  hash: string;
}

/** store.AuditVerification — GET /api/v1/audit/verify */
export interface ApiAuditVerification {
  ok: boolean;
  entries: number;
  broken_at?: number;
  reason?: string;
  head?: string;
}

/** POST /api/v1/enrollment-tokens */
export interface ApiEnrollment {
  token: { id: string; token: string; label: string; expires_at: string; max_uses: number; uses: number };
  command: string;
}

/** Org admins and security admins may change policy, machines and tokens;
 *  everyone else is read-only (server.Principal.CanWrite). */
export const canWrite = (role: string | undefined) => role === 'admin' || role === 'security_admin';

export class ApiError extends Error {
  constructor(
    readonly status: number, // 0 = network / CORS failure
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A human sentence for a failed call — the server's own message when it sent one. */
export function apiErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
  switch (e.status) {
    case 0: return `Can't reach the control plane at ${API_BASE}. ${e.message}`;
    case 401: return `Your session was not accepted by the control plane (${e.message}). Try signing out and back in.`;
    case 403: return e.message || 'Your role can view but not change this; ask an org admin or security admin.';
    case 429: return `Too many requests — try again${e.retryAfter ? ` in ${e.retryAfter}s` : ' shortly'}.`;
    default: return e.message;
  }
}

export type GetToken = () => Promise<string | null>;

export interface Api {
  get<T>(path: string): Promise<T>;
  send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T>;
}

/** `getToken` is called on every request — Clerk session tokens live ~60s and
 *  the SDK refreshes them, so a cached string would start failing with 401. */
export function createApi(getToken: GetToken): Api {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await getToken();
    if (!token) throw new ApiError(401, 'not signed in');
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch (e) {
      throw new ApiError(0, e instanceof Error ? e.message : 'network error');
    }
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON (proxy error page) */ }
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') ? data.error : `HTTP ${res.status}`;
      const ra = Number(res.headers.get('Retry-After'));
      throw new ApiError(res.status, msg, Number.isFinite(ra) && ra > 0 ? ra : undefined);
    }
    return data as T;
  }
  return {
    get: (path) => call('GET', path),
    send: (method, path, body) => call(method, path, body),
  };
}

/** Used while Clerk is bypassed in local dev: there is no session to send. */
export const unavailableApi: Api = {
  get: () => Promise.reject(new ApiError(401, 'the control-plane API needs a Clerk session (auth is bypassed in this dev build)')),
  send: () => Promise.reject(new ApiError(401, 'the control-plane API needs a Clerk session (auth is bypassed in this dev build)')),
};
