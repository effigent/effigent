/**
 * Demo Mode's Inventory, New behaviour and Posture report: the same JSON
 * shapes as GET /api/v1/inventory, /anomalies, /report and
 * /report/schedule, in memory only. Machines and people match the sample
 * workspace (data.ts ENDPOINTS, people-fixture.ts).
 */
import { ApiError } from './api.ts';
import type {
  ApiAnomalies, ApiAnomaly, ApiAnomalyKind, ApiInventory, ApiInventoryAgent, ApiMCPMachineUse, ApiMCPServer, ApiPostureReport,
  ApiReportScheduleView, ApiUnmanagedPerson,
} from './api-inventory.ts';

const at = (p: string) => `${p}@acme.example`;

export function createInventoryFixture(now: number) {
  const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const day = 60 * 24;

  const agent = (host: string, id: string, os: string, a: string, owner: string, events: number, firstDays: number, lastMin: number,
    status: ApiInventoryAgent['status'], by: string[] | null, mode = 'denylist', note?: string, hook_state?: string): ApiInventoryAgent => ({
    endpoint_id: id, hostname: host, agent: a, owner: at(owner), person: at(owner), os, first_seen: iso(firstDays * day), last_seen: iso(lastMin),
    events, mode, status, enforced_by: by, note, hook_state,
  });
  const agents: ApiInventoryAgent[] = [
    agent('jane-mbp', 'ep-jane-mbp', 'darwin', 'claude-code', 'jane.doe', 4120, 41, 12, 'enforced', ['hooks'], 'denylist', undefined, 'installed'),
    agent('jane-mbp', 'ep-jane-mbp', 'darwin', 'claude-cowork', 'jane.doe', 6, 9, 60 * 3, 'unmanaged', null, 'unmanaged',
      'runs in its own virtual machine: effigentd sees it start and stop, policy doesn’t reach it'),
    agent('alex-mbp', 'ep-alex-mbp', 'darwin', 'cursor-agent', 'alex.wang', 2210, 33, 40, 'enforced', ['hooks'], 'denylist', undefined, 'installed'),
    agent('alex-mbp', 'ep-alex-mbp', 'darwin', 'gemini-cli', 'alex.wang', 140, 12, 60 * 30, 'hooks_off', null, 'denylist', 'its hook is installed: nothing is enforced', 'installed'),
    agent('sarah-ws', 'ep-sarah-ws', 'linux', 'claude-code', 'sarah.lee', 3876, 52, 8, 'enforced', ['hooks', 'kernel'], 'denylist', undefined, 'installed'),
    { ...agent('raj-ws', 'ep-raj-ws', 'linux', 'claude-code', 'raj.patel', 9934, 60, 3, 'enforced', ['kernel'], 'denylist',
      'kernel only: its hook is missing (commands, tools, MCP and approvals aren’t checked)', 'missing'), observe_only: 'BPF LSM off' },
    agent('mike-mbp', 'ep-mike-mbp', 'darwin', 'codex', 'mike.tan', 1530, 20, 95, 'enforced', ['hooks'], 'monitor'),
    agent('priya-mba', 'ep-priya-mba', 'darwin', 'aider', 'priya.shah', 880, 6, 60 * 5, 'detection_only', null, 'denylist',
      'no hook exists for this agent and the machine has no kernel layer: seen, not controlled'),
    agent('priya-mba', 'ep-priya-mba', 'darwin', 'opencode', 'priya.shah', 210, 2, 60 * 7, 'detection_only', null, 'denylist',
      'no hook exists for this agent and the machine has no kernel layer: seen, not controlled'),
    agent('prod-bastion-01', 'ep-bastion-01', 'linux', 'claude-code', 'omar.haddad', 214, 15, 60 * 30, 'enforced', ['kernel'], 'allowlist'),
    agent('emma-mba', 'ep-emma-mba', 'darwin', 'claude-code', 'emma.brooks', 610, 28, 60 * 20, 'hooks_off', null, 'denylist', 'its hook is missing: nothing is enforced', 'missing'),
    agent('ci-runner-03', 'ep-ci-03', 'linux', 'claude-code', 'tom.weiss', 5022, 44, 60 * 3, 'enforced', ['kernel'], 'denylist'),
    agent('ci-runner-03', 'ep-ci-03', 'linux', 'mcp-filesystem', 'tom.weiss', 77, 3, 60 * 4, 'enforced', ['kernel'], ''),
  ];

  const use = (host: string, id: string, a: string, owner: string, tools: string[], events: number, firstDays: number, lastMin: number,
    allowlist: ApiMCPMachineUse['allowlist'] = 'allowed', unlisted = 0): ApiMCPMachineUse => ({
    endpoint_id: id, hostname: host, agent: a, person: at(owner), os_users: [owner.split('.')[0]], tools, events, unlisted_calls: unlisted,
    first_seen: iso(firstDays * day), last_seen: iso(lastMin), allowlist,
  });
  const server = (name: string, uses: ApiMCPMachineUse[], opts: Partial<ApiMCPServer> = {}): ApiMCPServer => {
    const allow = new Set(uses.map((u) => u.allowlist));
    return {
      server: name, orphan: false, agents: [...new Set(uses.map((u) => u.agent))].sort(), machines: new Set(uses.map((u) => u.endpoint_id)).size,
      people: [...new Set(uses.map((u) => u.person))].sort(), tools: [...new Set(uses.flatMap((u) => u.tools))].sort(), sources: ['hook'],
      events: uses.reduce((n, u) => n + u.events, 0), unlisted_calls: uses.reduce((n, u) => n + u.unlisted_calls, 0),
      first_seen: uses.map((u) => u.first_seen).sort()[0], last_seen: uses.map((u) => u.last_seen).sort().reverse()[0],
      allowlist: allow.size > 1 ? 'mixed' : ([...allow][0] as ApiMCPServer['allowlist']), uses, ...opts,
    };
  };
  const mcp: ApiMCPServer[] = [
    server('github', [
      use('jane-mbp', 'ep-jane-mbp', 'claude-code', 'jane.doe', ['create_pull_request', 'get_issue', 'search_code'], 412, 40, 30),
      use('sarah-ws', 'ep-sarah-ws', 'claude-code', 'sarah.lee', ['get_issue', 'list_commits'], 128, 30, 60 * 2),
      use('alex-mbp', 'ep-alex-mbp', 'cursor-agent', 'alex.wang', ['create_issue'], 19, 12, 60 * 26),
    ]),
    server('linear', [use('jane-mbp', 'ep-jane-mbp', 'claude-code', 'jane.doe', ['get_issue', 'update_issue'], 96, 21, 60)]),
    server('postgres-prod', [use('raj-ws', 'ep-raj-ws', 'claude-code', 'raj.patel', ['query'], 37, 4, 60 * 6, 'not_allowed', 37)]),
    server('browser', [use('sarah-ws', 'ep-sarah-ws', 'claude-code', 'sarah.lee', ['navigate', 'screenshot'], 22, 2, 60 * 9, 'not_allowed', 22)]),
    server('filesystem', [{ ...use('ci-runner-03', 'ep-ci-03', 'mcp-filesystem', 'tom.weiss', [], 77, 3, 60 * 4, 'no_allowlist'), os_users: ['runner'] }],
      { orphan: true, sources: ['kernel'] }),
  ];

  const unmanaged: ApiUnmanagedPerson[] = [
    { person: at('lena.kim'), name: 'Lena Kim', matched: true, reason: 'no_activity', machines: ['lena-mbp'],
      vendors: [{ vendor: 'cursor', identity: at('lena.kim'), seat: true, plan: 'business', usage_cents: 0, requests: 0, active_days: 0, last_active_at: iso(9 * day) }] },
    { person: at('noa.levi'), name: 'Noa Levi', matched: true, reason: 'no_activity', machines: ['noa-mbp'],
      vendors: [{ vendor: 'anthropic', identity: at('noa.levi'), seat: false, usage_cents: 18_400, requests: 2_310, active_days: 14, last_active_at: iso(day) }] },
    { person: at('ben.ortiz'), name: '', matched: true, reason: 'no_machine', machines: [],
      vendors: [
        { vendor: 'copilot', identity: 'bortiz', seat: true, plan: 'business', usage_cents: 0, requests: 0, active_days: 0, last_active_at: iso(2 * day) },
        { vendor: 'cursor', identity: at('ben.ortiz'), seat: true, plan: 'business', usage_cents: 4_100, requests: 640, active_days: 11, last_active_at: iso(3 * day) },
      ] },
    { person: 'github:contractor-77', matched: false, reason: 'no_machine', machines: [],
      vendors: [{ vendor: 'copilot', identity: 'contractor-77', seat: true, plan: 'business', usage_cents: 0, requests: 0, active_days: 0, last_active_at: iso(day) }] },
  ];

  const inventory = (days: number): ApiInventory => {
    const since = now - days * day * 60_000;
    const recent = <T extends { last_seen: string }>(xs: T[]) => xs.filter((x) => Date.parse(x.last_seen) >= since);
    return {
      days, since: new Date(since).toISOString(), generated_at: new Date(now).toISOString(), machines: 13, observe_only_machines: 1,
      agents: recent(agents), mcp_servers: recent(mcp).map((s) => ({ ...s, uses: recent(s.uses) })), unmanaged_people: unmanaged,
      spend_vendors: ['anthropic', 'copilot', 'cursor'], hook_agents: { 'claude-code': 'claude', codex: 'codex', 'gemini-cli': 'gemini', 'cursor-agent': 'cursor' },
    };
  };

  let nextID = 1;
  const sig = (host: string, id: string, owner: string, a: string, kind: ApiAnomalyKind, value: string, minAgo: number, ev: string, prevDays?: number): ApiAnomaly => ({
    id: nextID++, endpoint_id: id, agent: a, kind, value, seen_at: iso(minAgo), event_type: ev, prev_last_at: prevDays ? iso(prevDays * day) : null,
    created_at: iso(minAgo), hostname: host, owner: at(owner), person: at(owner),
  });
  const anomalies: ApiAnomaly[] = [
    sig('raj-ws', 'ep-raj-ws', 'raj.patel', 'claude-code', 'mcp', 'postgres-prod', 60 * 6, 'exec'),
    sig('raj-ws', 'ep-raj-ws', 'raj.patel', 'claude-code', 'action', 'destructive_sql@prod', 60 * 6 - 4, 'approval_pending'),
    sig('jane-mbp', 'ep-jane-mbp', 'jane.doe', 'claude-code', 'host', 'paste.rs', 60 * 9, 'blocked'),
    sig('jane-mbp', 'ep-jane-mbp', 'jane.doe', 'claude-code', 'binary', 'nc', 60 * 9 + 1, 'blocked'),
    sig('sarah-ws', 'ep-sarah-ws', 'sarah.lee', 'claude-code', 'binary', '/usr/bin/socat', 60 * 20, 'exec'),
    sig('sarah-ws', 'ep-sarah-ws', 'sarah.lee', 'claude-code', 'host', '185.199.108.133', 60 * 20 + 2, 'connect'),
    sig('mike-mbp', 'ep-mike-mbp', 'mike.tan', 'codex', 'action', 'force_push', day + 50, 'would_block'),
    sig('mike-mbp', 'ep-mike-mbp', 'mike.tan', 'codex', 'binary', 'terraform', day + 52, 'exec', 44),
    sig('alex-mbp', 'ep-alex-mbp', 'alex.wang', 'cursor-agent', 'host', 'registry.npmjs.org', 2 * day, 'exec', 35),
    sig('ci-runner-03', 'ep-ci-03', 'tom.weiss', 'claude-code', 'action', 'cloud_destroy@prod', 3 * day, 'blocked'),
    sig('sarah-ws', 'ep-sarah-ws', 'sarah.lee', 'claude-code', 'mcp', 'browser', 4 * day, 'would_block'),
    sig('emma-mba', 'ep-emma-mba', 'emma.brooks', 'claude-code', 'binary', 'kubectl', 6 * day, 'exec'),
    sig('prod-bastion-01', 'ep-bastion-01', 'omar.haddad', 'claude-code', 'host', 'api.openai.com', 9 * day, 'connect'),
  ].sort((a, b) => Date.parse(b.seen_at) - Date.parse(a.seen_at) || b.id - a.id);

  const listAnomalies = (qs: URLSearchParams): ApiAnomalies => {
    const kinds = (qs.get('kind') ?? '').split(',').filter(Boolean);
    const words = (qs.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const since = qs.get('since') ? Date.parse(qs.get('since')!) : 0;
    const before = qs.get('before') ? Number(qs.get('before')!.split('_')[1]) : Infinity;
    const limit = Math.min(Number(qs.get('limit')) || 100, 500);
    const match = anomalies.filter((a) => (!kinds.length || kinds.includes(a.kind)) && (!qs.get('agent') || a.agent === qs.get('agent'))
      && (!qs.get('endpoint') || a.endpoint_id === qs.get('endpoint')) && Date.parse(a.seen_at) >= since && a.id !== before
      && words.every((w) => `${a.value} ${a.hostname} ${a.agent} ${a.person}`.toLowerCase().includes(w)));
    const start = Number.isFinite(before) ? anomalies.findIndex((a) => a.id === before) + 1 : 0;
    const rest = match.filter((a) => anomalies.indexOf(a) >= start);
    const page = rest.slice(0, limit);
    const last = page[page.length - 1];
    return {
      anomalies: page, next_before: rest.length > limit && last ? `${Date.parse(last.seen_at) * 1e6}_${last.id}` : '',
      kinds: ['binary', 'host', 'mcp', 'action'], caps: { binary: 2000, host: 1000, mcp: 200, action: 200 }, window_days: 30, warmup_days: 7, daily_signal_cap: 50,
      baselines: [
        { kind: 'action', keys: 14, values: 61, keys_at_cap: 0, overflow: 0, suppressed: 0 },
        { kind: 'binary', keys: 16, values: 1312, keys_at_cap: 0, overflow: 0, suppressed: 0 },
        { kind: 'host', keys: 15, values: 486, keys_at_cap: 0, overflow: 0, suppressed: 0 },
        { kind: 'mcp', keys: 7, values: 9, keys_at_cap: 0, overflow: 0, suppressed: 0 },
      ],
      webhook_event: 'anomaly.first_seen',
    };
  };

  const report = (days: number): ApiPostureReport => {
    const k = days / 30; // scale the 30-day sample
    const n = (v: number) => Math.round(v * k);
    const to = new Date(now); to.setUTCHours(0, 0, 0, 0); to.setUTCDate(to.getUTCDate() + 1);
    const from = new Date(to.getTime() - days * day * 60_000);
    const daily: ApiPostureReport['enforcement']['daily'] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(from.getTime() + i * day * 60_000).toISOString();
      daily.push({ day: d, type: 'blocked', events: 3 + ((i * 7) % 9) }, { day: d, type: 'would_block', events: 1 + ((i * 5) % 4) });
    }
    const blocked = daily.filter((d) => d.type === 'blocked').reduce((s, d) => s + d.events, 0);
    const would = daily.filter((d) => d.type === 'would_block').reduce((s, d) => s + d.events, 0);
    const byKind = [
      { kind: 'command', label: 'Commands and programs', share: 0.31, w: 0.3 }, { kind: 'action:credential_read', label: 'Credential reads', share: 0.17, w: 0.1 },
      { kind: 'network', label: 'Network and websites', share: 0.14, w: 0.15 }, { kind: 'kernel_exec', label: 'Programs (kernel)', share: 0.12, w: 0 },
      { kind: 'action:force_push', label: 'Force push', share: 0.08, w: 0.25 }, { kind: 'action:destructive_sql', label: 'Destructive SQL', share: 0.06, w: 0.05 },
      { kind: 'file', label: 'Files', share: 0.06, w: 0.1 }, { kind: 'action:cloud_destroy', label: 'Cloud deletions', share: 0.04, w: 0.05 },
      { kind: 'package', label: 'Packages', share: 0.02, w: 0 },
    ].map((x) => ({ kind: x.kind, label: x.label, blocked: Math.round(blocked * x.share), would_block: Math.round(would * x.w), approval_requests: x.kind.startsWith('action:') ? n(6) : 0 }));
    return {
      days, from: from.toISOString(), to: to.toISOString(), generated_at: new Date(now).toISOString(),
      machines: { enrolled: 13, enrolled_in_period: days >= 30 ? 2 : 0, seen_in_period: 12, online_now: 11, offline_now: 2, hooks_reporting: 10, hooks_healthy: 8,
        hook_problems: [{ endpoint_id: 'ep-alex-mbp', hostname: 'alex-mbp', agents: ['gemini'] }, { endpoint_id: 'ep-emma-mba', hostname: 'emma-mba', agents: ['claude'] }],
        by_os: { darwin: 8, linux: 5 }, observe_only: 1, observe_only_machines: [{ endpoint_id: 'ep-raj-ws', hostname: 'raj-ws', reason: 'BPF LSM off' }] },
      agents: {
        in_use: [
          { agent: 'claude-code', machines: 8, people: 7, events: n(24_000) }, { agent: 'cursor-agent', machines: 2, people: 2, events: n(6_100) },
          { agent: 'codex', machines: 1, people: 1, events: n(1_530) }, { agent: 'aider', machines: 1, people: 1, events: n(880) },
          { agent: 'opencode', machines: 1, people: 1, events: n(210) }, { agent: 'gemini-cli', machines: 1, people: 1, events: n(140) },
          { agent: 'claude-cowork', machines: 1, people: 1, events: n(6) },
        ],
        by_person: [
          { key: at('raj.patel'), name: 'Raj Patel', matched: true, agents: ['claude-code'], machines: 1, events: n(9_934) },
          { key: at('tom.weiss'), name: 'Tom Weiss', matched: true, agents: ['claude-code'], machines: 2, events: n(5_022) },
          { key: at('jane.doe'), name: 'Jane Doe', matched: true, agents: ['claude-code', 'claude-cowork'], machines: 1, events: n(4_126) },
          { key: at('sarah.lee'), name: 'Sarah Lee', matched: true, agents: ['claude-code', 'cursor-agent'], machines: 1, events: n(3_876) },
          { key: at('alex.wang'), name: 'Alex Wang', matched: true, agents: ['cursor-agent', 'gemini-cli'], machines: 1, events: n(2_350) },
          { key: at('mike.tan'), name: 'Mike Tan', matched: true, agents: ['codex'], machines: 1, events: n(1_530) },
          { key: at('priya.shah'), name: 'Priya Shah', matched: true, agents: ['aider', 'opencode'], machines: 1, events: n(1_090) },
          { key: 'host:dan-dev-vm', agents: ['claude-code'], machines: 1, events: n(320) },
        ],
        by_team: [
          { key: 'Data', agents: ['claude-code'], machines: 2, people: 2, events: n(11_224) },
          { key: 'Platform', agents: ['claude-code', 'claude-cowork', 'cursor-agent'], machines: 2, people: 2, events: n(8_002) },
          { key: 'Ops', agents: ['claude-code'], machines: 3, people: 2, events: n(5_236) },
          { key: 'Payments', agents: ['cursor-agent', 'gemini-cli'], machines: 2, people: 2, events: n(2_670) },
          { key: '', agents: ['aider', 'codex', 'opencode'], machines: 2, people: 2, events: n(2_620) },
        ],
        unmanaged_agents: 5,
      },
      enforcement: { blocked, would_block: would, file_alerts: n(64), by_kind: byKind, blocked_by_agent: { 'claude-code': Math.round(blocked * 0.8), codex: Math.round(blocked * 0.12), 'cursor-agent': Math.round(blocked * 0.08) }, daily },
      approvals: { requested: n(46), approved: n(31), denied: n(7), expired: n(6), pending: 2, median_decide_seconds: 228, self_approval_refused: days >= 30 ? 1 : 0 },
      exceptions: { active: 4, created_in_period: days >= 30 ? 3 : 1, expiring_7d: 1, permanent: 1 },
      policy: { versions_published: days >= 30 ? 3 : 1, proposals: days >= 30 ? { approved: 2, rejected: 1, pending: 1 } : { pending: 1 }, self_approval_refused: 0, change_approval_on: true },
      anomalies: { total: anomalies.filter((a) => Date.parse(a.seen_at) >= from.getTime()).length,
        by_kind: anomalies.filter((a) => Date.parse(a.seen_at) >= from.getTime()).reduce<Record<string, number>>((m, a) => ({ ...m, [a.kind]: (m[a.kind] ?? 0) + 1 }), {}) },
      spend: { connected: ['anthropic', 'copilot', 'cursor'], monthly_cents: 1_284_000, potential_savings_cents: 214_500, at_risk_cents: 96_000,
        open_leaks: { unused_seat: 6, duplicate_tool: 2, shadow_spend: 3, runaway_cost: 2 }, found_in_period: n(5), resolved_in_period: n(3), resolved_savings_cents: n(61_000) },
      break_glass: {
        issued: days >= 30 ? 2 : 1, issued_all_machines: days >= 30 ? 1 : 0, revoked: 0, expired_unused: days >= 30 ? 1 : 0,
        activations: 1, machines: 1, unknown_codes: 0,
        uses: [{ at: new Date(new Date(now).getTime() - 4 * day * 60_000).toISOString(), id: '9f3c2a71d0b84e15', endpoint_id: 'ep-alex-mbp',
          hostname: 'alex-mbp', os_user: 'alex', reason: 'Control plane unreachable during the VPN outage; release hotfix', created_by: 'Lena Kim' }],
      },
      notes: [],
    };
  };

  let schedule: ApiReportScheduleView = {
    schedule: { enabled: false, cadence: 'weekly', emails: [], next_at: null, last_sent_at: null, last_result: null },
    default_emails: [at('lena.kim'), 'security@acme.example'], email_available: true,
  };
  const nextAt = (cadence: 'weekly' | 'monthly') => {
    const d = new Date(now);
    if (cadence === 'monthly') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 8)).toISOString();
    const days = ((8 - d.getUTCDay()) % 7) || 7; // next Monday
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days, 8)).toISOString();
  };
  const days = (qs: URLSearchParams, def: number) => Number(qs.get('days')) || def;

  return {
    get(path: string): unknown {
      const [p, q = ''] = path.split('?');
      const qs = new URLSearchParams(q);
      if (p === '/inventory') return inventory(days(qs, 30));
      if (p === '/anomalies') return listAnomalies(qs);
      if (p === '/report') {
        const d = days(qs, 30);
        if (![7, 30, 90].includes(d)) return new ApiError(400, 'days must be 7, 30 or 90');
        return report(d);
      }
      if (p === '/report/schedule') return schedule;
      return undefined;
    },
    send(method: string, path: string, body: unknown): unknown {
      const b = (body ?? {}) as { enabled?: boolean; cadence?: string; emails?: string[]; days?: number };
      if (method === 'PUT' && path === '/report/schedule') {
        const cadence = b.cadence || 'weekly';
        if (cadence !== 'weekly' && cadence !== 'monthly') return new ApiError(400, 'cadence must be weekly or monthly');
        const emails = [...new Set((b.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
        const bad = emails.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
        if (bad) return new ApiError(400, `"${bad}" is not an email address`);
        if (emails.length > 20) return new ApiError(400, 'at most 20 recipients');
        const was = schedule.schedule;
        schedule = { ...schedule, schedule: { ...was, enabled: !!b.enabled, cadence, emails, updated_by: 'user_demo', updated_at: new Date().toISOString(),
          next_at: !b.enabled ? null : was.enabled && was.cadence === cadence && was.next_at ? was.next_at : nextAt(cadence) } };
        return schedule;
      }
      if (method === 'POST' && path === '/report/send') {
        const n = (schedule.schedule.emails.length || schedule.default_emails.length);
        return { result: { email: `Demo Mode: nothing sent (would go to ${n})` } };
      }
      return undefined;
    },
  };
}
