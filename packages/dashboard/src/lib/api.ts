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
  /** effigentd ≥ the hook-state release: each agent's hook as last reported (null before). */
  hooks?: ApiHookReport | null;
  hooks_reported_at?: string | null;
  hooks_changed_at?: string | null;
  /** Set by the control plane's offline detector; cleared on the next heartbeat. */
  offline_at?: string | null;
  /** The last daemon_stop effigentd sent: when, and the signal / service manager / user. */
  stopped_at?: string | null;
  stop?: { signal?: string; via?: string; os_user?: string } | null;
}

export type ApiHookState = 'installed' | 'missing' | 'modified' | 'unreadable';

/** hookstate.Report as stored (plus `expected`: agents whose hook was once seen in place). */
export interface ApiHookReport {
  sensor: string; // tetragon | hooks
  agents: Record<string, { present: boolean; state: ApiHookState; file: string; detail?: string; disabled_by?: string[] }>;
  expected?: string[];
}

/** GET|PUT /api/v1/endpoint-health */
export interface ApiEndpointHealth {
  offline_after_minutes: number;
  email_offline: boolean;
  email_hooks: boolean;
  default_minutes: number;
  min_minutes: number;
  tick_seconds: number;
  emails: string[];
  email_available: boolean;
  webhook_events: string[];
  updated_by?: string;
  updated_at?: string;
  saved: boolean;
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

/** An approval request (cp.approvals): an agent hook paused a tool call that
 *  matched an approval list. `used` = approved and acted on by the endpoint. */
export interface ApiApproval {
  id: string;
  endpoint_id: string;
  fingerprint: string;
  agent: string;
  session_id: string;
  tool: string;
  summary: string; // redacted on the endpoint
  cwd: string;
  rule: string; // exec_approve | command_approve | tool_approve | file_approve | domain_approve | network_approve
  reason: string;
  hostname: string;
  os_user: string;
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'used';
  requested_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string;
  decided_by_name: string;
  note: string;
  used_at: string | null;
  notified?: Record<string, string>;
  /** Approval routing: the group it was routed to ("" = workspace admins). */
  group_id?: string;
  group_name?: string;
  can_decide?: boolean; // the signed-in person may decide it
  decide_is_override?: boolean; // ...as an admin stepping in for the group
}

/** Where approval requests are announced. The webhook URL itself is never returned. */
export interface ApiNotifications {
  slack_webhook_set: boolean;
  slack_webhook_hint?: string;
  emails: string[];
  email_available: boolean; // the control plane has SMTP configured
  updated_by?: string;
  updated_at?: string;
  /** this control plane posts approvals to Slack (EFFIGENT_SLACK); off = email only */
  slack_enabled?: boolean;
  /** the workspace's own Slack app (absent on control planes before it) */
  slack_app?: ApiSlackApp;
}

/** server.slackAppView */
export interface ApiSlackApp {
  connected: boolean;
  team_id?: string;
  team_name?: string;
  channel?: string;
  approvers: 'members' | 'workspace';
  interactions_url?: string;
  available: boolean; // the control plane can store Slack credentials (EFFIGENT_SECRETS_KEY)
  directory_available: boolean; // it can match Slack users to approvers (CLERK_SECRET_KEY)
}

/** Pricing Leaks (GET /pricing-leaks): spend.Report + the connectors and settings. Money is in US cents. */
export type ApiSpendVendor = 'cursor' | 'anthropic' | 'copilot' | 'openai';
export type ApiLeakType = 'unused_seat' | 'duplicate_tool' | 'shadow_spend' | 'runaway_cost';
export interface ApiLeak {
  id: string;
  type: ApiLeakType;
  vendor: string; // a connector vendor, or google / byok for shadow spend
  person: string; // work email, or kind:value when it can't be matched ("" = the organisation)
  name?: string;
  title: string;
  evidence: string[];
  monthly_savings_cents: number;
  at_risk_cents: number; // shadow spend: a likely personal plan, not a saving
  confidence: 'high' | 'medium' | 'low';
  /** How effigentd's activity was tied to the person (absent: vendor data only). */
  attribution?: ApiVia;
}
/** os_user / git_email: the person's own identity; owner / host: their machine; '' = not matched. */
export type ApiVia = 'os_user' | 'git_email' | 'owner' | 'host' | '';
export interface ApiVendorSpend {
  vendor: string; label: string; seats: number; active_seats: number;
  seat_cents: number; usage_cents: number; monthly_cents: number; estimated?: boolean; connected: boolean;
}
export interface ApiToolUse {
  vendor: string; seat: boolean; seat_cents?: number; agents?: string[]; effigent_days: number; vendor_days: number;
  last_seen?: string; last_vendor_activity?: string; cost_cents: number;
}
export interface ApiPersonUsage { person: string; name?: string; matched: boolean; via?: ApiVia; machines?: string[]; tools: ApiToolUse[] }
export interface ApiSpendReport {
  generated_at: string; window_days: number; vendors: ApiVendorSpend[]; total_monthly_cents: number;
  leaks: ApiLeak[]; total_savings_cents: number; total_at_risk_cents: number; people: ApiPersonUsage[]; unattributed: string[];
}
export interface ApiSpendConnector {
  vendor: ApiSpendVendor; label: string; configured: boolean; key_hint?: string; settings: Record<string, string>;
  sync_status: '' | 'running' | 'ok' | 'error'; last_sync_at?: string; last_error?: string; last_counts?: Record<string, number>;
  updated_by?: string; csv_seats: number; csv_usage_rows: number;
  next_poll_at?: string; failures?: number; // the poller: next scheduled sync, failed syncs in a row
}
/** GET /pricing-leaks/connectors (Settings → AI vendors). */
export interface ApiSpendConnectors { connectors: ApiSpendConnector[]; secrets_available: boolean }
export interface ApiSpendPrices { seat: Record<string, number>; personal: Record<string, number> }
/** Runaway cost alerts: on unless runaway_cost is false; emails empty = the approval notification recipients. */
export interface ApiSpendAlertSettings { runaway_cost?: boolean; emails: string[] }
export interface ApiSpendSettings { prices: ApiSpendPrices; alerts?: ApiSpendAlertSettings; updated_by?: string; updated_at?: string }
export interface ApiPricingLeaks {
  report: ApiSpendReport;
  connectors: ApiSpendConnector[];
  settings: ApiSpendSettings;
  default_prices: ApiSpendPrices;
  secrets_available: boolean; // EFFIGENT_SECRETS_KEY is set: vendor keys can be stored
  first_seen?: Record<string, string>; // leak id -> when it was first seen (the rollup's leak log)
  email_available?: boolean; // this control plane sends email
}
/** GET /pricing-leaks/metrics: Spend over time. Days are UTC dates (RFC 3339 midnight). */
export interface ApiUsagePoint { day: string; vendor: string; cost_cents: number; requests: number; tokens: number; people: number; estimated?: boolean }
export interface ApiActivityPoint { day: string; vendor: string; events: number; machines: number; agents: string[] }
export interface ApiSpendReportDay {
  day: string; vendor: string; seats: number; active_seats: number; seat_cents: number; usage_cents: number; monthly_cents: number; estimated?: boolean; connected: boolean;
}
export interface ApiSpendLeakDay { day: string; type: ApiLeakType; vendor: string; leaks: number; savings_cents: number; at_risk_cents: number }
export interface ApiSpendMetrics {
  days: number; from: string; to: string;
  usage: ApiUsagePoint[]; activity: ApiActivityPoint[]; report: ApiSpendReportDay[]; leaks: ApiSpendLeakDay[];
}
/** A logged leak (GET /pricing-leaks/alerts lists the runaway cost ones and where each alert went). */
export interface ApiSpendAlert {
  id: string; type: ApiLeakType; vendor: string; person: string; name?: string; title: string; evidence: string[]; confidence: string;
  monthly_savings_cents: number; at_risk_cents: number; first_seen_at: string; last_seen_at: string;
  resolved_at?: string; notified_at?: string; notify_result?: Record<string, string>;
}
export interface ApiSpendAlerts {
  alerts: ApiSpendAlert[]; runaway_cost: boolean; emails: string[]; default_emails: string[]; email_available: boolean; webhook_event: string;
}
/** People (GET /people): who is who, by work email, and the identities each goes by. */
export type ApiIdentityKind = 'os_user' | 'git_email' | 'host' | 'github' | 'email' | 'api_key';
export interface ApiPersonIdentity { kind: ApiIdentityKind; value: string; email: string; source: 'manual' | 'suggestion'; created_by?: string; created_at: string }
export interface ApiPerson { email: string; name: string; identities: ApiPersonIdentity[]; updated_by?: string; updated_at: string }
/** An identity effigentd saw on a machine (last 30 days) and who it resolves to now. */
export interface ApiSighting {
  endpoint_id: string; hostname: string; owner?: string; os_user?: string; git_email?: string; agents: string[]; events: number; last_seen: string;
  person?: string; via?: ApiVia;
}
/** kind "person": add email to People (a vendor seat that isn't there yet). */
export interface ApiSuggestion { kind: ApiIdentityKind | 'person'; value: string; email: string; name?: string; reason: string; confidence: 'high' | 'medium' | 'low' }
export interface ApiPeople { people: ApiPerson[]; suggestions: ApiSuggestion[]; sightings: ApiSighting[]; unattributed: string[]; kinds: ApiIdentityKind[]; window_days: number }
export interface ApiSpendImport { vendor: string; kind: 'seats' | 'usage'; rows: number; seats: number; usage_rows: number; skipped: number; warnings?: string[] }

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
export function createApi(getToken: GetToken, headers: Record<string, string> = {}): Api {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await getToken();
    if (!token) throw new ApiError(401, 'not signed in');
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/v1${path}`, {
        method,
        headers: { ...headers, Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
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
