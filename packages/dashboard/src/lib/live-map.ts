/**
 * Control-plane JSON → the console's view types. Kept pure (no React) so the
 * mapping rules — status thresholds, outcome per event type — live in one place.
 */
import type { ApiEndpoint, ApiEvent } from './api.ts';
import type { ConsoleEvent, EventType, Outcome, Severity } from '@/types.ts';

/** effigentd syncs every 5s by default (-sync-interval), so a minute of silence
 *  is already unusual and five minutes means the endpoint is gone. */
const ONLINE_MS = 60_000;
const DEGRADED_MS = 5 * 60_000;

export type EndpointStatus = 'online' | 'degraded' | 'offline' | 'revoked';

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
}

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
  const status: EndpointStatus = e.revoked ? 'revoked' : age < ONLINE_MS ? 'online' : age < DEGRADED_MS ? 'degraded' : 'offline';
  const os = e.os.toLowerCase();
  return {
    id: e.id, hostname: e.hostname || e.id, os: e.os === 'darwin' ? 'macOS' : e.os === 'linux' ? 'Linux' : e.os, arch: e.arch,
    platform: os === 'linux' ? 'linux' : os === 'darwin' ? 'macos' : 'other',
    version: e.version, policyVersion: e.policy_version, status, lastSeenAt: seen, enrolledAt: ms(e.enrolled_at) ?? 0, revoked: e.revoked,
  };
}

const KNOWN: EventType[] = ['agent_start', 'agent_exit', 'exec', 'exit', 'file_open', 'connect', 'blocked', 'would_block', 'policy'];

const OUTCOME: Record<string, Outcome> = {
  blocked: 'blocked', would_block: 'would_block',
  exec: 'allowed', file_open: 'allowed', connect: 'allowed',
  agent_start: 'system', agent_exit: 'system', exit: 'system', policy: 'system',
};

const TITLE: Record<string, string> = {
  agent_start: 'Agent started', agent_exit: 'Agent exited', exec: 'Ran a command', exit: 'Process exited',
  file_open: 'Opened a sensitive file', connect: 'Outbound connection', blocked: 'Blocked by policy',
  would_block: 'Would block (monitor mode)', policy: 'Agent policy applied',
};

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

export function toConsoleEvent(e: ApiEvent, hostById: Map<string, string>): ConsoleEvent {
  const b = e.body ?? {};
  const at = ms(e.time) ?? 0;
  const type = (KNOWN as string[]).includes(e.type) ? (e.type as EventType) : 'policy';
  const target = b.target || b.process?.args || b.process?.binary || undefined;
  let summary: string;
  switch (e.type) {
    case 'exec': summary = `exec: ${base(b.target || b.process?.binary || '?')}`; break;
    case 'file_open': summary = `open: ${b.target ?? '?'}`; break;
    case 'connect': summary = `connect: ${b.target ?? '?'}`; break;
    case 'blocked': case 'would_block':
      summary = `${e.type === 'blocked' ? 'blocked' : 'would block'}: ${b.target ? (b.target.startsWith('/') ? base(b.target) : b.target) : '?'}`; break;
    case 'agent_start': case 'agent_exit': summary = `${e.type}${b.process?.pid ? ` · pid ${b.process.pid}` : ''}`; break;
    default: summary = b.message || e.type;
  }
  const severity: Severity = e.severity === 'high' || e.severity === 'medium' ? e.severity : 'info';
  return {
    id: `ev-${e.id}`, at, time: clock(at), ago: '',
    type, severity, outcome: OUTCOME[e.type] ?? 'system', title: TITLE[e.type] ?? e.type,
    agentType: e.agent || b.agent || null, user: null,
    endpoint: e.endpoint_id, endpointName: hostById.get(e.endpoint_id) ?? e.endpoint_id.slice(0, 8),
    env: null, summary, target: b.process?.args && e.type === 'exec' ? b.process.args : target,
    rule: b.rule || undefined, via: b.via || undefined, mode: (b.mode as ConsoleEvent['mode']) || undefined,
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
