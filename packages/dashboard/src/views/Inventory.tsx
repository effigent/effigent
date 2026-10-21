'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { ApiError, apiErrorText } from '@/lib/api.ts';
import type { ApiCoverage, ApiInventory, ApiInventoryAgent, ApiMCPServer, ApiUnmanagedPerson } from '@/lib/api-inventory.ts';
import { AgentCell, Card, CardHead, Empty, Loading, PageGuide, PageHead, Seg } from '@/components/ui.tsx';

export const COVERAGE: Record<ApiCoverage, { label: string; badge: string; what: string }> = {
  enforced: { label: 'Enforced', badge: 'b-green', what: 'Its hook answers, or the machine’s kernel layer enforces policy on it' },
  hooks_off: { label: 'Hook off', badge: 'b-red', what: 'It has a hook, but the hook is missing or switched off and there is no kernel layer: nothing is enforced' },
  detection_only: { label: 'Seen only', badge: 'b-gold', what: 'No hook exists for this agent and the machine has no kernel layer: effigentd sees it, policy doesn’t reach it' },
  unmanaged: { label: 'Not under policy', badge: 'b-muted', what: 'Runs where effigentd can’t enforce (Claude Cowork’s own VM): seen starting and stopping only' },
};
const ALLOW: Record<string, { label: string; badge: string }> = {
  allowed: { label: 'In mcp_allow', badge: 'b-green' },
  not_allowed: { label: 'Not in mcp_allow', badge: 'b-red' },
  mixed: { label: 'Allowed on some agents', badge: 'b-gold' },
  no_allowlist: { label: 'No allowlist', badge: 'b-muted' },
};
const PERIODS = [{ id: '7', label: '7 days' }, { id: '30', label: '30 days' }, { id: '90', label: '90 days' }] as const;
type Tab = 'agents' | 'mcp' | 'people';

export const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 60 * 36 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;
const personLabel = (p: string) => (!p ? '—' : p.startsWith('host:') ? `unattributed (${p.slice(5)})` : p);

/** Inventory: every agent and MCP server effigentd saw, how it's controlled,
 *  and who pays for an AI coding tool without being seen on an enrolled machine. */
export function Inventory({ initialTab }: { initialTab?: string }) {
  const { api } = useLive();
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const [tab, setTab] = useState<Tab>(initialTab === 'mcp' || initialTab === 'people' ? initialTab : 'agents');
  const [data, setData] = useState<ApiInventory | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const load = useCallback(() => api.get<ApiInventory>(`/inventory?days=${days}`)
    .then((d) => { setData(d); setErr(null); })
    .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? 'The control plane does not serve the inventory yet — it needs to be updated.' : apiErrorText(e))), [api, days]);
  useEffect(() => { void load(); }, [load]);

  const needle = q.trim().toLowerCase();
  const agents = useMemo(() => (data?.agents ?? []).filter((a) => !needle || `${a.hostname} ${a.agent} ${a.person} ${a.owner}`.toLowerCase().includes(needle)), [data, needle]);
  const servers = useMemo(() => (data?.mcp_servers ?? []).filter((m) => !needle
    || `${m.server} ${(m.agents ?? []).join(' ')} ${(m.people ?? []).join(' ')} ${(m.tools ?? []).join(' ')} ${m.uses.map((u) => u.hostname).join(' ')}`.toLowerCase().includes(needle)), [data, needle]);
  const people = useMemo(() => (data?.unmanaged_people ?? []).filter((p) => !needle || `${p.person} ${p.name ?? ''} ${p.vendors.map((v) => `${v.vendor} ${v.identity}`).join(' ')}`.toLowerCase().includes(needle)), [data, needle]);

  const count = (s: ApiCoverage) => (data?.agents ?? []).filter((a) => a.status === s).length;
  const notCovered = data ? data.agents.length - count('enforced') : 0;

  return (
    <div className="page">
      <PageHead title="Inventory" sub="Every AI agent and MCP server effigentd has seen, how each one is controlled, and who uses an AI coding tool away from an enrolled machine.">
        <input className="input" style={{ width: 240 }} placeholder="Filter machines, agents, people…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter the inventory" />
        <Seg value={days} onChange={setDays} options={PERIODS.map((p) => ({ id: p.id, label: p.label }))} />
      </PageHead>
      <PageGuide id="inventory" steps={[
        <>Check <b>Agents</b> for anything not marked Enforced: a missing hook, an agent with no hook, Claude Cowork</>,
        <>Review <b>MCP servers</b>: what each one is used for, by whom, and whether your <code>mcp_allow</code> list names it</>,
        <>Follow up on <b>Unmanaged people</b>: a vendor seat or API usage, but no agent of theirs on an enrolled machine</>,
      ]} />
      {err && <div className="callout bad"><Ic n="alert" size={16} /><span>{err}</span></div>}

      {!data ? (!err && <Loading />) : (
        <>
          <div className="grid-4">
            <Card className="mini-stat"><div className="k">Agents on machines</div><div className="v">{data.agents.length}</div>
              <div className="s">{new Set(data.agents.map((a) => a.agent)).size} kinds on {new Set(data.agents.map((a) => a.endpoint_id)).size} of {data.machines} machines</div></Card>
            <Card className="mini-stat"><div className="k">Not enforced</div><div className="v" style={{ color: notCovered ? 'var(--gold)' : undefined }}>{notCovered}</div>
              <div className="s">{count('hooks_off')} hook off · {count('detection_only')} seen only · {count('unmanaged')} not under policy</div></Card>
            <Card className="mini-stat"><div className="k">MCP servers</div><div className="v">{data.mcp_servers.length}</div>
              <div className="s">{data.mcp_servers.filter((m) => m.allowlist === 'not_allowed' || m.unlisted_calls > 0).length} outside mcp_allow · {data.mcp_servers.filter((m) => m.orphan).length} without an agent</div></Card>
            <Card className="mini-stat"><div className="k">Unmanaged people</div><div className="v" style={{ color: data.unmanaged_people.length ? 'var(--gold)' : undefined }}>{data.unmanaged_people.length}</div>
              <div className="s">{data.spend_vendors.length ? `from ${data.spend_vendors.join(', ')}` : 'connect AI vendors to see them'}</div></Card>
          </div>

          <Seg value={tab} onChange={setTab} options={[
            { id: 'agents', label: `Agents (${agents.length})` }, { id: 'mcp', label: `MCP servers (${servers.length})` }, { id: 'people', label: `Unmanaged people (${people.length})` },
          ]} />

          {tab === 'agents' && <AgentsCard agents={agents} days={data.days} filtered={!!needle} />}
          {tab === 'mcp' && <MCPCard servers={servers} days={data.days} filtered={!!needle} />}
          {tab === 'people' && <PeopleCard people={people} vendors={data.spend_vendors} days={data.days} filtered={!!needle} />}
        </>
      )}
    </div>
  );
}

function CoverageBadge({ s }: { s: ApiCoverage }) {
  const c = COVERAGE[s];
  return <span className={`badge ${c.badge}`} title={c.what}>{c.label}</span>;
}

function AgentsCard({ agents, days, filtered }: { agents: ApiInventoryAgent[]; days: number; filtered: boolean }) {
  const order: ApiCoverage[] = ['hooks_off', 'detection_only', 'unmanaged', 'enforced'];
  const sorted = [...agents].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.hostname.localeCompare(b.hostname) || a.agent.localeCompare(b.agent));
  return (
    <Card>
      <CardHead title="Agents per machine" sub={`Each agent effigentd saw in the last ${days} days, and what enforces policy on it. Hooks check commands, tools, MCP and approvals; the kernel layer (Linux) blocks programs, files and connections.`} />
      {sorted.length === 0 ? (
        <Empty icon="laptop" title={filtered ? 'Nothing matches the filter' : 'No agents seen yet'} sub={filtered ? undefined : 'Agents appear here once an enrolled machine reports one running.'} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Agent</th><th>Machine</th><th>Person</th><th>Status</th><th>Enforced by</th><th>First seen</th><th>Last seen</th><th className="right">Events</th></tr></thead>
            <tbody>
              {sorted.map((a) => (
                <tr key={`${a.endpoint_id}/${a.agent}`}>
                  <td><AgentCell type={a.agent} sub={a.mode && a.mode !== 'unmanaged' ? `mode: ${a.mode}` : undefined} /></td>
                  <td><Link className="link" href="/enforcement">{a.hostname}</Link><div className="mono-sm">{a.os}</div></td>
                  <td className="mono-sm">{personLabel(a.person)}</td>
                  <td><CoverageBadge s={a.status} />{a.note && <div className="muted" style={{ fontSize: 12, maxWidth: 320 }}>{a.note}</div>}</td>
                  <td className="mono-sm">{(a.enforced_by ?? []).join(' + ') || '—'}</td>
                  <td className="mono-sm">{ago(a.first_seen)}</td>
                  <td className="mono-sm">{ago(a.last_seen)}</td>
                  <td className="right tnum">{a.events.toLocaleString('en-US')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function MCPCard({ servers, days, filtered }: { servers: ApiMCPServer[]; days: number; filtered: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card>
      <CardHead title="MCP servers" sub={`Every MCP server an agent used in the last ${days} days. Tool names come from agent hooks; the kernel layer sees the server process, not its tools. “Outside mcp_allow” counts the calls the hook flagged on each machine.`} />
      {servers.length === 0 ? (
        <Empty icon="plug" title={filtered ? 'Nothing matches the filter' : 'No MCP servers seen'} sub={filtered ? undefined : 'MCP calls from Claude Code, Codex and Gemini CLI hooks, and MCP server processes the kernel layer sees, show up here.'} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Server</th><th>Allowlist</th><th>Tools used</th><th>Agents</th><th>Machines</th><th>People</th><th>First seen</th><th>Last seen</th><th className="right">Calls</th></tr></thead>
            <tbody>
              {servers.map((m) => (
                <Fragment key={m.server}>
                  <tr onClick={() => setOpen(open === m.server ? null : m.server)} style={{ cursor: 'pointer' }}>
                    <td><div className="cell-main mono-name"><Ic n={open === m.server ? 'chevronDown' : 'chevronRight'} size={12} /> {m.server}</div>
                      {m.orphan && <div className="muted" style={{ fontSize: 12 }} title="track_orphan_mcp: the server runs with no known agent above it">no agent above it</div>}</td>
                    <td><span className={`badge ${ALLOW[m.allowlist]?.badge ?? 'b-muted'}`}>{ALLOW[m.allowlist]?.label ?? m.allowlist}</span>
                      {m.unlisted_calls > 0 && <div className="muted" style={{ fontSize: 12 }}>{m.unlisted_calls} calls flagged outside mcp_allow</div>}</td>
                    <td className="mono-sm" style={{ maxWidth: 280 }}>{(m.tools ?? []).length ? (m.tools ?? []).join(', ') : (m.sources ?? []).includes('hook') ? '—' : 'not visible (kernel only)'}</td>
                    <td className="mono-sm">{(m.agents ?? []).join(', ')}</td>
                    <td className="tnum">{m.machines}</td>
                    <td className="mono-sm">{(m.people ?? []).map(personLabel).join(', ') || '—'}</td>
                    <td className="mono-sm">{ago(m.first_seen)}</td>
                    <td className="mono-sm">{ago(m.last_seen)}</td>
                    <td className="right tnum">{m.events.toLocaleString('en-US')}</td>
                  </tr>
                  {open === m.server && m.uses.map((u) => (
                    <tr key={`${m.server}/${u.endpoint_id}/${u.agent}`} style={{ background: 'var(--bg-2, transparent)' }}>
                      <td className="mono-sm" style={{ paddingLeft: 28 }}>{u.hostname}</td>
                      <td><span className={`badge ${ALLOW[u.allowlist]?.badge ?? 'b-muted'}`}>{ALLOW[u.allowlist]?.label ?? u.allowlist}</span></td>
                      <td className="mono-sm">{(u.tools ?? []).join(', ') || '—'}</td>
                      <td className="mono-sm">{u.agent}</td>
                      <td />
                      <td className="mono-sm">{personLabel(u.person)}{(u.os_users ?? []).length ? <div className="muted">OS user {(u.os_users ?? []).join(', ')}</div> : null}</td>
                      <td className="mono-sm">{ago(u.first_seen)}</td>
                      <td className="mono-sm">{ago(u.last_seen)}</td>
                      <td className="right tnum">{u.events.toLocaleString('en-US')}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function PeopleCard({ people, vendors, days, filtered }: { people: ApiUnmanagedPerson[]; vendors: string[]; days: number; filtered: boolean }) {
  return (
    <Card>
      <CardHead title="Unmanaged people" sub={`People with a vendor seat or vendor usage whom no agent activity on an enrolled machine was attributed to in the last ${days} days. Accuracy depends on the People mapping and the vendors connected.`}>
        <Link className="btn sm" href="/identity"><Ic n="idcard" size={14} /> People</Link>
      </CardHead>
      {vendors.length === 0 ? (
        <Empty icon="plug" title="No AI vendors connected" sub="Connect Cursor, Anthropic, GitHub Copilot or OpenAI (Settings → AI vendors), or import a seats CSV on Pricing Leaks, to see who uses them off an enrolled machine." />
      ) : people.length === 0 ? (
        <Empty icon="checkCircle" title={filtered ? 'Nothing matches the filter' : 'Everyone with a seat or usage was seen on an enrolled machine'} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Person</th><th>Why</th><th>Vendors</th><th>Machines</th></tr></thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.person}>
                  <td><div className="cell-main">{p.name || p.person}</div>
                    <div className="mono-sm">{p.name ? p.person : p.matched ? '' : 'not matched to a person: map it on People'}</div></td>
                  <td>{p.reason === 'no_machine'
                    ? <span className="badge b-gold" title="No enrolled machine is owned by or attributed to them">No enrolled machine</span>
                    : <span className="badge b-orange" title="A machine of theirs is enrolled, but no agent ran on it in the period: they likely work elsewhere">No agent activity</span>}</td>
                  <td>{p.vendors.map((v) => (
                    <div key={v.vendor} className="mono-sm">{v.vendor}{v.seat ? ` seat${v.plan ? ` (${v.plan})` : ''}` : ''}{v.usage_cents || v.requests ? ` · ${usd(v.usage_cents)}, ${v.requests.toLocaleString('en-US')} requests on ${v.active_days} days` : ''}
                      {v.last_active_at ? <span className="muted"> · active {ago(v.last_active_at)}</span> : null}</div>
                  ))}</td>
                  <td className="mono-sm">{p.machines.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
