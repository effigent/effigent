/**
 * Shapes of the inventory, first-seen and posture report routes
 * (internal/controlplane/server/inventory.go, report.go), mirroring the Go
 * JSON exactly. Kept beside api.ts so these pages' types stay together.
 */

export type ApiCoverage = 'enforced' | 'hooks_off' | 'detection_only' | 'unmanaged';

/** GET /api/v1/inventory → agents[] */
export interface ApiInventoryAgent {
  endpoint_id: string;
  hostname: string;
  revoked?: boolean;
  agent: string;
  owner: string;
  person: string;
  os: string;
  first_seen: string;
  last_seen: string;
  events: number;
  mode: string;
  status: ApiCoverage;
  enforced_by: string[] | null; // hooks | kernel
  note?: string;
  hook_state?: string;
  /** Why the machine's kernel layer only observes (old kernel, no BTF, BPF LSM off). */
  observe_only?: string;
}

export interface ApiMCPMachineUse {
  endpoint_id: string;
  hostname: string;
  revoked?: boolean;
  agent: string;
  person: string;
  os_users: string[];
  tools: string[];
  events: number;
  unlisted_calls: number;
  first_seen: string;
  last_seen: string;
  allowlist: 'allowed' | 'not_allowed' | 'no_allowlist';
}

export interface ApiMCPServer {
  server: string;
  orphan: boolean;
  agents: string[];
  machines: number;
  people: string[];
  tools: string[];
  sources: string[]; // hook | kernel
  events: number;
  unlisted_calls: number;
  first_seen: string;
  last_seen: string;
  allowlist: 'allowed' | 'not_allowed' | 'no_allowlist' | 'mixed';
  uses: ApiMCPMachineUse[];
}

export interface ApiVendorUse {
  vendor: string;
  identity: string;
  seat: boolean;
  plan?: string;
  usage_cents: number;
  requests: number;
  active_days: number;
  last_active_at?: string | null;
}

export interface ApiUnmanagedPerson {
  person: string;
  name?: string;
  matched: boolean;
  reason: 'no_machine' | 'no_activity';
  machines: string[];
  vendors: ApiVendorUse[];
}

export interface ApiInventory {
  days: number;
  since: string;
  generated_at: string;
  machines: number;
  /** Enrolled machines whose kernel layer only observes (old kernel, no BTF, BPF LSM off). */
  observe_only_machines?: number;
  agents: ApiInventoryAgent[];
  mcp_servers: ApiMCPServer[];
  unmanaged_people: ApiUnmanagedPerson[];
  spend_vendors: string[];
  hook_agents: Record<string, string>;
}

export type ApiAnomalyKind = 'binary' | 'host' | 'mcp' | 'action';

/** GET /api/v1/anomalies → anomalies[] */
export interface ApiAnomaly {
  id: number;
  endpoint_id: string;
  agent: string;
  kind: ApiAnomalyKind;
  value: string;
  seen_at: string;
  event_type: string;
  prev_last_at: string | null; // set when the value was known but not seen for 30+ days
  created_at: string;
  hostname: string;
  owner: string;
  person: string;
}

export interface ApiBaselineStats {
  kind: ApiAnomalyKind;
  keys: number;
  values: number;
  keys_at_cap: number;
  overflow: number;
  suppressed: number;
}

export interface ApiAnomalies {
  anomalies: ApiAnomaly[];
  next_before: string;
  kinds: ApiAnomalyKind[];
  caps: Record<ApiAnomalyKind, number>;
  window_days: number;
  warmup_days: number;
  daily_signal_cap: number;
  baselines: ApiBaselineStats[];
  webhook_event: string;
}

/** GET /api/v1/report?days=7|30|90 */
export interface ApiReportGroup {
  key: string;
  name?: string;
  matched?: boolean;
  agents: string[];
  machines: number;
  people?: number;
  events: number;
}

export interface ApiReportKind {
  kind: string;
  label: string;
  blocked: number;
  would_block: number;
  approval_requests: number;
}

export interface ApiPostureReport {
  days: number;
  from: string;
  to: string;
  generated_at: string;
  machines: {
    enrolled: number;
    enrolled_in_period: number;
    seen_in_period: number;
    online_now: number;
    offline_now: number;
    hooks_reporting: number;
    hooks_healthy: number;
    hook_problems: { endpoint_id: string; hostname: string; agents: string[] }[];
    by_os: Record<string, number>;
    observe_only?: number;
    observe_only_machines?: { endpoint_id: string; hostname: string; reason: string }[];
  };
  agents: {
    in_use: { agent: string; machines: number; people: number; events: number }[];
    by_person: ApiReportGroup[];
    by_team: ApiReportGroup[];
    unmanaged_agents: number;
  };
  enforcement: {
    blocked: number;
    would_block: number;
    file_alerts: number;
    by_kind: ApiReportKind[];
    blocked_by_agent: Record<string, number>;
    daily: { day: string; type: string; events: number }[] | null;
  };
  approvals: {
    requested: number;
    approved: number;
    denied: number;
    expired: number;
    pending: number;
    median_decide_seconds: number | null;
    self_approval_refused: number;
  };
  exceptions: { active: number; created_in_period: number; expiring_7d: number; permanent: number };
  policy: { versions_published: number; proposals: Record<string, number>; self_approval_refused: number; change_approval_on: boolean };
  anomalies: { total: number; by_kind: Record<string, number> };
  spend: {
    connected: string[];
    monthly_cents: number;
    potential_savings_cents: number;
    at_risk_cents: number;
    open_leaks: Record<string, number>;
    found_in_period: number;
    resolved_in_period: number;
    resolved_savings_cents: number;
  } | null;
  /** Break-glass codes and activations in the period; null from a control plane before the section. */
  break_glass: ApiReportBreakGlass | null;
  sections?: Record<string, unknown>;
  notes: string[];
}

export interface ApiReportBreakGlass {
  issued: number;
  issued_all_machines: number;
  revoked: number;
  expired_unused: number;
  /** Activations reported by machines (an all-machines code can be used on several). */
  activations: number;
  machines: number;
  /** Used codes this control plane didn't issue. */
  unknown_codes: number;
  /** Newest first, ≤ 50. */
  uses: { at: string; id: string; endpoint_id: string; hostname: string; os_user: string; reason: string; created_by: string }[];
}

export interface ApiReportSchedule {
  enabled: boolean;
  cadence: 'weekly' | 'monthly';
  emails: string[];
  next_at: string | null;
  last_sent_at: string | null;
  last_result: Record<string, string> | null;
  updated_by?: string;
  updated_at?: string | null;
}

/** GET|PUT /api/v1/report/schedule */
export interface ApiReportScheduleView {
  schedule: ApiReportSchedule;
  default_emails: string[];
  email_available: boolean;
}
