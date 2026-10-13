/**
 * In-memory stand-in for the control-plane API, used by Demo Mode (demo.tsx).
 * It answers the same routes with the same JSON shapes, built from the sample
 * dataset, so every live view runs its real code path on sample data. Writes
 * (publish, revoke, enroll) change only this in-memory copy — nothing here
 * makes a network request.
 */
import { ENDPOINTS, EVENTS } from '@/data.ts';
import { API_BASE, ApiError, type Api, type ApiAuditEntry, type ApiEndpoint, type ApiEvent, type ApiMe, type ApiPolicyVersion } from './api.ts';

const DEMO_POLICY = `# effigentd policy (Demo Mode — sample workspace, not published anywhere)
defaults:
  mode: denylist
  exec_deny:
    - /usr/bin/curl
    - /usr/bin/wget
    - /usr/bin/nc
  file_alert:
    - /.env
    - /.ssh/id_ed25519
    - /.aws/credentials
  file_deny:
    - /etc/shadow
  network: true

agents:
  - name: claude-code
    binary_names: [claude]
  - name: codex
    binary_names: [codex]
`;

const AGO_MIN: Record<string, number> = {};
function minutesAgo(label: string): number {
  if (label in AGO_MIN) return AGO_MIN[label];
  const m = label.match(/(\d+)\s*(s|min|h)/);
  const v = !m ? 0 : m[2] === 's' ? Number(m[1]) / 60 : m[2] === 'h' ? Number(m[1]) * 60 : Number(m[1]);
  return (AGO_MIN[label] = v);
}

export function createFixtureApi(): Api {
  const now = Date.now();
  const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const me: ApiMe = { user_id: 'user_demo', tenant: 'org:demo', role: 'admin', via: 'clerk' };
  let version = 3;
  let policy: ApiPolicyVersion = { version, body: DEMO_POLICY, comment: 'deny curl/wget/nc for every agent', created_by: me.user_id, created_at: iso(240) };
  const history: ApiPolicyVersion[] = [
    { version: 3, comment: policy.comment, created_by: me.user_id, created_at: iso(240) },
    { version: 2, comment: 'alert on cloud credentials', created_by: me.user_id, created_at: iso(60 * 26) },
    { version: 1, comment: 'initial policy', created_by: me.user_id, created_at: iso(60 * 72) },
  ];
  const endpoints: ApiEndpoint[] = ENDPOINTS.map((e, i) => ({
    id: `0000000${i}-dem0-4000-8000-${e.id.padEnd(12, '0').slice(-12)}`, hostname: e.hostname,
    os: e.platform === 'linux' ? 'linux' : 'darwin', arch: e.platform === 'linux' ? 'amd64' : 'arm64', version: e.version,
    enrolled_at: iso(60 * 24 * (10 + i)), last_seen: e.status === 'online' ? iso(0.1) : e.status === 'degraded' ? iso(2) : iso(90),
    policy_version: e.policyVersion >= 42 ? 3 : 2, revoked: false,
  }));
  const epId = new Map(ENDPOINTS.map((e, i) => [e.id, endpoints[i].id]));
  const events: ApiEvent[] = EVENTS.filter((e) => e.type !== 'approval' && e.endpoint && e.agentType).map((e, i) => ({
    id: 1000 - i, endpoint_id: epId.get(e.endpoint!) ?? endpoints[0].id, time: iso(minutesAgo(e.ago)), type: e.type,
    severity: e.severity, agent: e.agentType!,
    body: { type: e.type, severity: e.severity, agent: e.agentType!, target: e.target, rule: e.rule, via: e.via, mode: e.mode },
  }));
  const audit: ApiAuditEntry[] = history.slice().reverse().map((h, i) => ({
    seq: i + 1, at: h.created_at, actor: h.created_by, actor_via: 'clerk', actor_role: 'admin', action: 'policy.publish', target: `v${h.version}`,
    details: { version: h.version, comment: h.comment }, ip: '127.0.0.1', prev_hash: '', hash: `demo${i}`,
  }));
  const log = (action: string, target: string, details: Record<string, unknown> | null) =>
    audit.push({ seq: audit.length + 1, at: new Date().toISOString(), actor: me.user_id, actor_via: 'clerk', actor_role: me.role, action, target, details, ip: '127.0.0.1', prev_hash: '', hash: `demo${audit.length}` });

  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(clone(v)), 120));

  return {
    get<T>(path: string): Promise<T> {
      const p = path.split('?')[0];
      if (p === '/me') return delay(me) as Promise<T>;
      if (p === '/endpoints') return delay(endpoints) as Promise<T>;
      if (p === '/policy') return delay(policy) as Promise<T>;
      if (p === '/policy/history') return delay(history) as Promise<T>;
      if (p === '/events') return delay(events) as Promise<T>;
      if (p === '/audit') return delay(audit.slice().reverse()) as Promise<T>;
      if (p === '/audit/verify') return delay({ ok: true, entries: audit.length, head: audit[audit.length - 1]?.hash }) as Promise<T>;
      return Promise.reject(new ApiError(404, 'not found'));
    },
    send<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (method === 'PUT' && path === '/policy') {
        const b = body as { body: string; comment: string };
        if (!/^\s*defaults:/m.test(b.body)) return Promise.reject(new ApiError(400, 'policy: missing `defaults:` (Demo Mode check)'));
        version++;
        policy = { version, body: b.body, comment: b.comment, created_by: me.user_id, created_at: new Date().toISOString() };
        history.unshift({ version, comment: b.comment, created_by: me.user_id, created_at: policy.created_at });
        log('policy.publish', `v${version}`, { version, comment: b.comment, bytes: b.body.length });
        return delay({ version }) as Promise<T>;
      }
      if (method === 'DELETE' && path.startsWith('/endpoints/')) {
        const ep = endpoints.find((e) => e.id === path.slice('/endpoints/'.length) && !e.revoked);
        if (!ep) return Promise.reject(new ApiError(404, 'no such endpoint'));
        ep.revoked = true;
        log('endpoint.revoke', ep.id, null);
        return delay({ ok: true }) as Promise<T>;
      }
      if (method === 'POST' && path === '/enrollment-tokens') {
        const b = (body ?? {}) as { label?: string; ttl_hours?: number; max_uses?: number };
        const token = `eft_demo_${Math.random().toString(36).slice(2, 14)}`; // not a real token
        const t = { id: `tok-${audit.length}`, token, label: b.label ?? '', expires_at: new Date(Date.now() + (b.ttl_hours || 24) * 3600_000).toISOString(), max_uses: b.max_uses || 1, uses: 0 };
        log('enrollment_token.create', t.id, { label: t.label, max_uses: t.max_uses, expires_at: t.expires_at });
        return delay({ token: t, command: `sudo effigentd enroll --server https://api.demo.invalid --token ${token}` /* demo: unroutable host */ }) as Promise<T>;
      }
      return Promise.reject(new ApiError(404, 'not found'));
    },
  };
}
