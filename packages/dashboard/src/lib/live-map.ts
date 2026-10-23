/**
 * Control-plane JSON → the console's view types. Kept pure (no React) so the
 * mapping rules — status thresholds, outcome per event type — live in one place.
 */
import type { ApiEndpoint, ApiEvent, ApiEventBody, ApiToolOutcome } from './api.ts';
import { classify, launchedAs, type Classified } from './live-graph.ts';
import type { ConsoleEvent, EventType, Outcome, Severity } from '@/types.ts';

/** effigentd syncs every 5s by default (-sync-interval), so a minute of silence
 *  is already unusual and five minutes means the endpoint is gone. */
const ONLINE_MS = 60_000;
const DEGRADED_MS = 5 * 60_000;

export type EndpointStatus = 'online' | 'degraded' | 'offline' | 'revoked' | 'idle'; // idle: a cloud environment with no session running

export interface EndpointRow {
  id: string;
  hostname: string;
  os: string;
  arch: string;
  platform: 'linux' | 'macos' | 'other';
  version: string;
  policyVersion: number;
  status: EndpointStatus;
  lastSeenAt: number | null;
  enrolledAt: number;
  revoked: boolean;
  /** Each agent's hook as effigentd last reported it (empty: an effigentd that doesn't report hooks). */
  hooks: HookRow[];
  /** Hooks gone or switched off where it matters (the control plane alerts on the same rule). */
  hookProblems: HookRow[];
  hooksReportedAt: number | null;
  /** Marked offline by the control plane's detector (null while online). */
  offlineAt: number | null;
  /** The last deliberate stop effigentd reported, if it is why the machine went quiet. */
  stopped: { at: number; signal: string; via: string; user: string } | null;
  /** A cloud environment (sessions in a vendor's cloud) rather than a machine. */
  cloud: boolean;
  vendor: string;
}

export interface HookRow {
  agent: string; // claude | codex | gemini | cursor
  label: string;
  present: boolean;
  state: 'installed' | 'missing' | 'modified' | 'unreadable';
  file: string;
  detail: string;
  disabledBy: string[];
}

const HOOK_AGENT: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', cursor: 'Cursor' };

/** Mirrors hookReport.problems in the control plane: a hook that is not installed (or
 *  that users turned off) on a machine relying on hooks where the agent is present, or
 *  where the hook was in place before. */
function hookRows(e: ApiEndpoint): { hooks: HookRow[]; problems: HookRow[] } {
  const r = e.hooks;
  if (!r || !r.agents) return { hooks: [], problems: [] };
  const hooks = Object.entries(r.agents)
    .map(([agent, a]) => ({ agent, label: HOOK_AGENT[agent] ?? agent, present: !!a.present, state: a.state, file: a.file, detail: a.detail ?? '', disabledBy: a.disabled_by ?? [] }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const problems = hooks.filter((h) => (h.state !== 'installed' || h.disabledBy.length > 0) && ((h.present && r.sensor === 'hooks') || (r.expected ?? []).includes(h.agent)));
  return { hooks, problems };
}

/** A daemon_stop counts as the reason when it came at (or just before) the last heartbeat. */
const STOP_SLACK_MS = 30_000;

export function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  // Go's zero time (0001-01-01) means "never".
  return Number.isFinite(t) && t > 0 ? t : null;
}

export function ago(at: number | null, now: number): string {
  if (at === null) return 'never';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function dateTime(at: number | null): string {
  if (at === null) return '—';
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function toEndpointRow(e: ApiEndpoint, now: number): EndpointRow {
  const seen = ms(e.last_seen);
  const age = seen === null ? Infinity : now - seen;
  const offlineAt = ms(e.offline_at);
  // The control plane's detector is authoritative once it has marked the machine offline.
  const cloud = e.kind === 'cloud';
  // A cloud environment is only heard from while a session runs: quiet is normal.
  const status: EndpointStatus = e.revoked ? 'revoked' : cloud ? (age < DEGRADED_MS ? 'online' : 'idle') : offlineAt !== null && (seen === null || seen <= offlineAt) ? 'offline'
    : age < ONLINE_MS ? 'online' : age < DEGRADED_MS ? 'degraded' : 'offline';
  const os = e.os.toLowerCase();
  const stoppedAt = ms(e.stopped_at);
  const stopped = stoppedAt !== null && (seen === null || stoppedAt >= seen - STOP_SLACK_MS) && status !== 'online'
    ? { at: stoppedAt, signal: e.stop?.signal ?? '', via: e.stop?.via ?? '', user: e.stop?.os_user ?? '' } : null;
  const { hooks, problems } = hookRows(e);
  return {
    id: e.id, hostname: e.hostname || e.id, os: e.os === 'darwin' ? 'macOS' : e.os === 'linux' ? 'Linux' : e.os, arch: e.arch,
    platform: os === 'linux' ? 'linux' : os === 'darwin' ? 'macos' : 'other',
    version: e.version, policyVersion: e.policy_version, status, lastSeenAt: seen, enrolledAt: ms(e.enrolled_at) ?? 0, revoked: e.revoked,
    hooks, hookProblems: e.revoked ? [] : problems, hooksReportedAt: ms(e.hooks_reported_at), offlineAt, stopped,
    cloud, vendor: e.vendor ?? '',
  };
}

const KNOWN: EventType[] = ['agent_start', 'agent_exit', 'exec', 'exit', 'file_open', 'connect', 'blocked', 'would_block', 'policy', 'tool_result'];
/** Approval-flow events (agent hooks) all show as type "approval". */
const APPROVAL_TYPES = ['approval_pending', 'approved', 'approval_denied'];

const OUTCOME: Record<string, Outcome> = {
  blocked: 'blocked', would_block: 'would_block',
  exec: 'allowed', file_open: 'allowed', connect: 'allowed',
  agent_start: 'system', agent_exit: 'system', exit: 'system', policy: 'system', tool_result: 'system',
  approval_pending: 'pending', approved: 'allowed', approval_denied: 'blocked',
};

const TITLE: Record<string, string> = {
  agent_start: 'Agent started', agent_exit: 'Agent exited', exec: 'Ran a command', exit: 'Process exited',
  file_open: 'Opened a sensitive file', connect: 'Outbound connection', blocked: 'Blocked by policy',
  would_block: 'Would block (monitor mode)', policy: 'Agent policy applied',
  approval_pending: 'Waiting for approval', approved: 'Approved and ran', approval_denied: 'Approval denied',
  tool_result: 'Tool call ended', daemon_stop: 'effigentd stopped', daemon_unclean_restart: 'effigentd restarted after an unclean stop',
};

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

/** A tool call's outcome in a few words: "error · exit 2 · ~1.2s · No such file". */
export function outcomeText(o: ApiToolOutcome): string {
  const parts: string[] = [o.status === 'done' ? 'finished' : o.status];
  if (o.exit_code !== undefined) parts.push(`exit ${o.exit_code}`);
  if (o.duration_ms) {
    const d = o.duration_ms >= 1000 ? `${(o.duration_ms / 1000).toFixed(1)}s` : `${o.duration_ms}ms`;
    parts.push(o.duration_approx ? `~${d}` : d);
  }
  if (o.error) parts.push(o.error);
  return parts.join(' · ');
}

/** An MCP tool call ("mcp__claude-in-chrome__computer: …") → "MCP · claude-in-chrome · computer". */
const mcpCall = (c: Classified | null) => (c?.kind === 'tool' && c.mcp && c.sub === `${c.mcp} tool` ? `MCP · ${c.mcp} · ${c.label}` : null);

/** A command line as a summary: the line itself, or just the program when it starts with a path ("/usr/bin/curl …" → curl). */
const commandText = (c: Classified) => (c.full.startsWith('/') ? c.label : c.full);

/** What a hook-reported tool call did, in the same words as kernel events. */
function toolSummary(c: Classified): string {
  if (c.kind === 'command') return `exec: ${commandText(c)}`;
  if (c.kind === 'file') return `${c.action}: ${c.full}`;
  if (c.kind === 'network') return `${c.action}: ${c.full}`;
  return c.full;
}

/** The action attrs that say where a call pointed (effigentd hooks/cloud.go, sql.go), in display order. */
export const IDENTITY_ATTRS: { key: string; label: string }[] = [
  { key: 'aws_profile', label: 'AWS profile' }, { key: 'aws_account', label: 'AWS account' },
  { key: 'kube_context', label: 'kube context' }, { key: 'gcloud_project', label: 'gcloud project' },
  { key: 'azure_subscription', label: 'Azure subscription' }, { key: 'terraform_workspace', label: 'Terraform workspace' },
  { key: 'pulumi_stack', label: 'Pulumi stack' }, { key: 'db_host', label: 'DB host' },
];

/** The identity attrs of an event's actions, merged (distinct values joined), and their environments. */
export function identityOf(b: ApiEventBody): { identity: { key: string; label: string; value: string }[]; envs: string[] } {
  const acts = b.actions ?? [];
  const identity = IDENTITY_ATTRS.flatMap(({ key, label }) => {
    const vals = [...new Set(acts.map((a) => {
      const v = a.attrs?.[key] ?? '';
      const name = key === 'azure_subscription' ? a.attrs?.azure_subscription_name : '';
      return v && name ? `${name} (${v})` : v;
    }).filter(Boolean))];
    return vals.length ? [{ key, label, value: vals.join(', ') }] : [];
  });
  return { identity, envs: [...new Set(acts.flatMap((a) => a.envs ?? []))] };
}

export function toConsoleEvent(e: ApiEvent, hostById: Map<string, string>): ConsoleEvent {
  const b = e.body ?? {};
  const at = ms(e.time) ?? 0;
  const type: EventType = (KNOWN as string[]).includes(e.type) ? (e.type as EventType) : APPROVAL_TYPES.includes(e.type) ? 'approval' : 'policy';
  const target = b.target || b.process?.args || b.process?.binary || undefined;
  const c = classify(e);
  const mcp = mcpCall(c);
  const hook = b.kind === 'tool' && c;
  let summary: string;
  switch (e.type) {
    case 'exec': summary = mcp ?? (hook ? toolSummary(c) : c?.kind === 'command' ? `exec: ${commandText(c)}` : `exec: ${base(b.target || b.process?.binary || '?')}`); break;
    case 'file_open': summary = `open: ${b.target ?? '?'}`; break;
    case 'connect': summary = `connect: ${b.target ?? '?'}`; break;
    case 'blocked': case 'would_block':
      summary = `${e.type === 'blocked' ? 'blocked' : 'would block'}: ${mcp ?? (c?.kind === 'command' ? c.label : b.target ? (b.target.startsWith('/') ? base(b.target) : b.target) : '?')}`; break;
    case 'approval_pending': case 'approved': case 'approval_denied':
      summary = `${e.type === 'approved' ? 'approved' : e.type === 'approval_denied' ? 'denied' : 'awaiting approval'}: ${mcp ?? (c?.kind === 'command' ? c.label : b.target ?? '?')}`; break;
    case 'agent_start': case 'agent_exit': {
      const la = launchedAs(e);
      summary = la
        ? `${la.declared ? `named “${la.name}” by effigentd run — the command is not ${la.name}` : `started with effigentd run`}: ${la.command}`
        : b.mode === 'unmanaged' && e.type === 'agent_start'
          ? `running in its own virtual machine — not under policy${b.process?.pid ? ` · pid ${b.process.pid}` : ''}`
          : `${e.type}${b.process?.pid ? ` · pid ${b.process.pid}` : ''}`;
      break;
    }
    case 'tool_result': summary = `ended: ${b.target ?? '?'}${b.outcome ? ` — ${outcomeText(b.outcome)}` : ''}`; break;
    default: summary = b.message || e.type;
  }
  const severity: Severity = e.severity === 'high' || e.severity === 'medium' ? e.severity : 'info';
  const { identity, envs } = identityOf(b);
  return {
    id: `ev-${e.id}`, at, time: clock(at), ago: '',
    type, severity, outcome: OUTCOME[e.type] ?? 'system', title: mcp && e.type === 'exec' ? 'Called an MCP tool' : TITLE[e.type] ?? e.type,
    agentType: e.agent || b.agent || null, user: null,
    endpoint: e.endpoint_id, endpointName: hostById.get(e.endpoint_id) ?? e.endpoint_id.slice(0, 8),
    env: null, summary, target: b.process?.args && e.type === 'exec' ? b.process.args : target,
    rule: b.rule || undefined, via: b.via || undefined, mode: (b.mode as ConsoleEvent['mode']) || undefined,
    risk: c?.kind === 'command' ? c.risk : undefined,
    riskRule: c?.kind === 'command' ? c.rule : undefined,
    identity: identity.length ? identity : undefined, targetEnvs: envs.length ? envs : undefined,
  };
}

/** What the console can say about the endpoint policy YAML without a YAML
 *  library: the default mode and the size of each list under `defaults:`. */
export interface PolicySummary {
  mode: string | null;
  lists: Record<string, number>;
  agents: number;
}

export function summarizePolicy(yaml: string): PolicySummary {
  const out: PolicySummary = { mode: null, lists: {}, agents: 0 };
  let section = '';
  let key = '';
  for (const raw of yaml.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (!line.trim()) continue;
    const top = line.match(/^([\w_]+):\s*(.*)$/);
    if (top) { section = top[1]; key = ''; continue; }
    if (section === 'agents' && /^\s*-\s+name:/.test(line)) { out.agents++; continue; }
    if (section !== 'defaults') continue;
    const kv = line.match(/^\s{1,4}([\w_]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      if (key === 'mode') out.mode = v.replace(/['"]/g, '') || null;
      else if (v.startsWith('[')) out.lists[key] = v.replace(/[[\]]/g, '').split(',').filter((x) => x.trim()).length;
      else if (v === '') out.lists[key] = 0;
      continue;
    }
    if (key && /^\s+-\s+/.test(line) && key in out.lists) out.lists[key]++;
  }
  return out;
}
