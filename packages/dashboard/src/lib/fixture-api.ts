/**
 * In-memory stand-in for the control-plane API, used by Demo Mode (demo.tsx).
 * It answers the same routes with the same JSON shapes, built from the sample
 * dataset, so every live view runs its real code path on sample data. Writes
 * (publish, revoke, enroll) change only this in-memory copy — nothing here
 * makes a network request.
 */
import { ENDPOINTS, EVENTS } from '@/data.ts';
import { API_BASE, ApiError, type Api, type ApiAuditEntry, type ApiEndpoint, type ApiEvent, type ApiMe, type ApiNotifications, type ApiPolicyVersion } from './api.ts';

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
  let exceptions: { id: string; endpoints: string[]; agents: string[]; list: string; value: string; reason?: string; expires_at: string | null; created_at: string; active: boolean; machines: string[] }[] = [
    { id: 'exc_demo1', endpoints: ['jane-mbp'], agents: ['claude-code'], list: 'exec_deny', value: 'curl', reason: 'API debugging this sprint',
      expires_at: new Date(now + 5 * 86_400_000).toISOString(), created_at: iso(60 * 20), active: true, machines: ['jane-mbp'] },
  ];
  let apiKeys: { id: string; name: string; prefix: string; scopes: string[]; created_by: string; created_at: string; expires_at: null; last_used_at: string | null; revoked: boolean }[] = [
    { id: 'key-1', name: 'windmill', prefix: 'efk_3f9a1c2e', scopes: ['approvals', 'read'], created_by: me.user_id, created_at: iso(60 * 24 * 3), expires_at: null, last_used_at: iso(4), revoked: false },
  ];
  let webhooks: { id: string; name: string; url_hint: string; events: string[]; enabled: boolean; created_at: string; last_status: number | null; last_error: string; last_attempt_at: string | null; dropped: number }[] = [
    { id: 'wh-1', name: 'windmill approvals', url_hint: 'https://app.windmill.dev/…', events: ['approval.requested', 'approval.decided'], enabled: true, created_at: iso(60 * 24 * 3), last_status: 200, last_error: '', last_attempt_at: iso(4), dropped: 0 },
  ];
  let notifications: ApiNotifications = { slack_webhook_set: true, slack_webhook_hint: '…demo', emails: ['security@acme.example'], email_available: true };
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
      if (p === '/audit') {
        const qs = new URLSearchParams(path.split('?')[1] ?? '');
        if (qs.get('paged') !== '1') return delay(audit.slice().reverse()) as Promise<T>;
        // the server's paging and filters, over the sample trail
        const list = (k: string) => (qs.get(k) ?? '').split(',').filter(Boolean);
        const [actions, vias, words] = [list('action'), list('via'), (qs.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean)];
        const since = qs.get('since') ? Date.parse(qs.get('since')!) : 0;
        const match = audit.slice().reverse().filter((a) => (!actions.length || actions.some((x) => a.action.startsWith(x)))
          && (!vias.length || vias.includes(a.actor_via)) && Date.parse(a.at) >= since
          && words.every((w) => `${a.action} ${a.target} ${a.actor} ${JSON.stringify(a.details)} ${a.ip}`.toLowerCase().includes(w)));
        const limit = Number(qs.get('limit')) || 50;
        const before = Number(qs.get('before')) || Infinity;
        const rest = match.filter((a) => a.seq < before);
        const entries = rest.slice(0, limit);
        return delay({ entries, total: match.length, next_before: rest.length > limit ? entries[entries.length - 1].seq : 0 }) as Promise<T>;
      }
      if (p === '/audit/verify') return delay({ ok: true, entries: audit.length, head: audit[audit.length - 1]?.hash }) as Promise<T>;
      if (p === '/approvals') return delay([]) as Promise<T>; // the demo queue reads the sample store
      if (p === '/notifications') return delay(notifications) as Promise<T>;
      if (p === '/api-keys') return delay(apiKeys) as Promise<T>;
      if (p === '/exceptions') return delay(exceptions) as Promise<T>;
      if (p === '/exceptions/options') return delay({ agents: ['claude-code', 'codex', 'gemini-cli'], mode: 'denylist', options: [
        { list: 'exec_deny', value: '/usr/bin/curl', agents: [''] }, { list: 'exec_deny', value: '/usr/bin/nc', agents: [''] },
        { list: 'domain_deny', value: 'pastebin.com', agents: [''] }, { list: 'command_approve', value: 'git push*', agents: [''] }] }) as Promise<T>;
      if (p === '/webhooks') return delay(webhooks) as Promise<T>;
      if (/^\/webhooks\/[^/]+\/deliveries$/.test(p)) return delay([]) as Promise<T>;
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
      if (method === 'PUT' && path === '/notifications') {
        const b = (body ?? {}) as { slack_webhook?: string; emails?: string[] };
        if (b.slack_webhook !== undefined) {
          if (b.slack_webhook && !b.slack_webhook.startsWith('https://hooks.slack.com/services/')) {
            return Promise.reject(new ApiError(400, 'use a Slack incoming webhook URL (https://hooks.slack.com/services/…)'));
          }
          notifications = { ...notifications, slack_webhook_set: !!b.slack_webhook, slack_webhook_hint: b.slack_webhook ? `…${b.slack_webhook.slice(-4)}` : undefined };
        }
        if (b.emails) notifications = { ...notifications, emails: b.emails };
        log('notifications.update', 'approvals', { slack_webhook_set: notifications.slack_webhook_set, emails: notifications.emails });
        return delay(notifications) as Promise<T>;
      }
      if (method === 'POST' && path === '/exceptions') {
        const b = (body ?? {}) as { endpoints?: string[]; agents?: string[]; list: string; value: string; reason?: string; expires_hours?: number };
        const at = new Date();
        const x = { id: `exc_demo${exceptions.length + 1}`, endpoints: b.endpoints ?? [], agents: b.agents ?? [], list: b.list, value: b.value, reason: b.reason,
          expires_at: b.expires_hours ? new Date(at.getTime() + b.expires_hours * 3600_000).toISOString() : null, created_at: at.toISOString(),
          active: true, machines: b.endpoints ?? [] };
        exceptions = [...exceptions, x];
        log('exception.create', x.id, x);
        return delay({ exception: x }) as Promise<T>;
      }
      if (method === 'DELETE' && path.startsWith('/exceptions/')) {
        exceptions = exceptions.filter((x) => x.id !== path.slice(12));
        return delay({ ok: true }) as Promise<T>;
      }
      if (method === 'POST' && path === '/api-keys') {
        const b = (body ?? {}) as { name?: string; scopes?: string[] };
        if (!b.name) return Promise.reject(new ApiError(400, 'give the key a name (e.g. windmill)'));
        const key = `efk_demo_${Math.random().toString(36).slice(2, 14)}`; // not a real key
        const k = { id: `key-${apiKeys.length + 1}`, name: b.name, prefix: key.slice(0, 12), scopes: [...new Set([...(b.scopes ?? []), 'read'])],
          created_by: me.user_id, created_at: new Date().toISOString(), expires_at: null, last_used_at: null, revoked: false };
        apiKeys = [k, ...apiKeys];
        log('api_key.create', k.id, { name: k.name, scopes: k.scopes });
        return delay({ ...k, key }) as Promise<T>;
      }
      if (method === 'DELETE' && path.startsWith('/api-keys/')) {
        apiKeys = apiKeys.map((k) => (k.id === path.slice(10) ? { ...k, revoked: true } : k));
        log('api_key.revoke', path.slice(10), null);
        return delay({ ok: true }) as Promise<T>;
      }
      if (method === 'POST' && path === '/webhooks') {
        const b = (body ?? {}) as { name?: string; url?: string; events?: string[] };
        if (!b.url?.startsWith('https://')) return Promise.reject(new ApiError(400, 'webhooks must use https'));
        const h = { id: `wh-${webhooks.length + 1}`, name: b.name ?? '', url_hint: `https://${new URL(b.url).host}/…`, events: b.events ?? [],
          enabled: true, created_at: new Date().toISOString(), last_status: null, last_error: '', last_attempt_at: null, dropped: 0 };
        webhooks = [...webhooks, h];
        log('webhook.create', h.id, { name: h.name, url: h.url_hint, events: h.events });
        return delay({ ...h, secret: 'whsec_demo_not_a_real_secret' }) as Promise<T>;
      }
      if (method === 'DELETE' && path.startsWith('/webhooks/')) {
        webhooks = webhooks.filter((h) => h.id !== path.slice(10));
        return delay({ ok: true }) as Promise<T>;
      }
      if (method === 'POST' && /^\/webhooks\/[^/]+\/test$/.test(path)) {
        return delay({ ok: true, status: 200 }) as Promise<T>; // Demo Mode: nothing is sent
      }
      if (method === 'POST' && path === '/notifications/test') {
        return delay({ ...(notifications.slack_webhook_set ? { slack: 'sent (Demo Mode: nothing was posted)' } : {}),
          ...(notifications.emails.length ? { email: 'sent (Demo Mode: nothing was sent)' } : {}) }) as Promise<T>;
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
