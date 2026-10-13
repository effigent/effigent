'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AGENTS, AGENT_TYPES, USERS } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { agoLabel, useStore } from '@/store.tsx';
import type { Agent, ConsoleEvent } from '@/types.ts';
import { GraphCard } from '@/components/GraphCard.tsx';
import { RangeSelect } from '@/components/RangeSelect.tsx';
import { AgentCell, AgentGlyph, Card, CardHead, DemoNote, EnvTag, OutcomePill, PageHead, StatusPill } from '@/components/ui.tsx';

export const EVENT_ICON: Record<ConsoleEvent['outcome'], { icon: string; cls: string }> = {
  blocked: { icon: 'ban', cls: 'ic-red' },
  pending: { icon: 'shield', cls: 'ic-gold' },
  allowed: { icon: 'hex', cls: 'ic-green' },
  would_block: { icon: 'alert', cls: 'ic-orange' },
  system: { icon: 'file', cls: 'ic-blue' },
};

function Stat({ label, value, delta, deltaDir, deltaGood, foot, icon, tone, href }: {
  label: string; value: number; delta: string; deltaDir: 'up' | 'down'; deltaGood: boolean; foot: React.ReactNode;
  icon: string; tone: 'blue' | 'slate' | 'red'; href: string;
}) {
  return (
    <Link href={href} className="stat card">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        <span className={`stat-icon st-${tone}`}><Ic n={icon} size={18} /></span>
      </div>
      <div className="stat-value-row">
        <span className="stat-value tnum">{value}</span>
        <span className={`stat-delta ${deltaGood ? 'good' : 'bad'}`}><Ic n={deltaDir === 'up' ? 'arrowUp' : 'arrowDown'} size={13} /> {delta}</span>
      </div>
      <div className="stat-foot">{foot}</div>
    </Link>
  );
}

function RowMenu({ agent }: { agent: Agent }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="bell-wrap" ref={box}>
      <button className="icon-btn ghost" aria-label="Agent actions" onClick={() => setOpen((o) => !o)}><Ic n="more" size={16} /></button>
      {open && (
        <div className="pop menu-pop">
          <Link className="pop-opt" href={`/graph?agent=${agent.type}`}><Ic n="network" size={14} /> View in graph</Link>
          <Link className="pop-opt" href={`/enforcement?endpoint=${agent.endpoint}`}><Ic n="laptop" size={14} /> Open endpoint</Link>
          <Link className="pop-opt" href={`/audit?q=${encodeURIComponent(AGENT_TYPES[agent.type].label)}`}><Ic n="clipboard" size={14} /> Audit trail</Link>
        </div>
      )}
    </div>
  );
}

export function Overview() {
  const { env, inEnv, pending, events, approvals, policies, lists, updatedSec, decide } = useStore();

  const agents = AGENTS.filter((a) => inEnv(a.env));
  const active = agents.filter((a) => a.status === 'active').length;
  const idle = agents.filter((a) => a.status === 'idle').length;
  const offline = agents.filter((a) => a.status === 'offline').length;
  const userIds = new Set(agents.filter((a) => a.status === 'active').map((a) => a.user));
  const newUsers = USERS.filter((u) => u.isNew && userIds.has(u.id)).length;
  const newAgents = agents.filter((a) => a.isNew).length;
  const pend = pending.filter((a) => inEnv(a.env));
  const evs = events.filter((e) => inEnv(e.env));

  const global = policies.find((p) => p.id === 'pol-global');
  const approvalRules = policies.filter((p) => p.status === 'active').flatMap((p) => p.rules).filter((r) => r.effect === 'require_approval').length;
  const allowN = lists.filter((l) => l.list === 'allow').length;
  const denyN = lists.filter((l) => l.list === 'deny').length;
  const decided24 = approvals.filter((a) => a.state !== 'approval_pending').length;

  const activeAgents = [...agents].sort((a, b) => (a.status === b.status ? b.actions24h - a.actions24h : a.status === 'active' ? -1 : 1)).slice(0, 5);
  const activity = evs.filter((e) => e.agentType).slice(0, 5);

  return (
    <div className="page">
      <PageHead title="Overview" sub="Control, secure, and monitor your AI agents — across every environment, every action, every user.">
        <DemoNote />
        <span className="updated"><span className="dot" /> Last updated {agoLabel(updatedSec)}</span>
        <RangeSelect />
      </PageHead>

      <div className="ov-grid">
        <div className="ov-main">
          <div className="stat-row">
            <Stat label="Total Agents" value={agents.length} delta={`${newAgents} new`} deltaDir="up" deltaGood icon="users" tone="blue" href="/graph?view=list"
              foot={<>{active} active <i className="sep">•</i> {idle} idle <i className="sep">•</i> {offline} offline</>} />
            <Stat label="Active Users" value={userIds.size} delta={`${newUsers} new`} deltaDir="up" deltaGood icon="user" tone="slate" href="/identity"
              foot={<span className="strong">Developers, PMs, Ops</span>} />
            <Stat label="Actions Requiring Approval" value={pend.length} delta={`${Math.round((1 - pend.length / 12) * 100)}%`} deltaDir="down" deltaGood icon="ban" tone="red" href="/approvals"
              foot={<>In the last 24 hours · {decided24} decided</>} />
          </div>

          <GraphCard env={env} />

          <div className="ov-bottom">
            <Card>
              <CardHead title="Active Agents" href="/graph?view=list" />
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Agent</th><th>User</th><th>Status</th><th>Environment</th><th aria-label="Actions" /></tr></thead>
                  <tbody>
                    {activeAgents.map((a) => (
                      <tr key={a.id}>
                        <td><AgentCell type={a.type} /></td>
                        <td className="cell-main">{a.user}</td>
                        <td><StatusPill status={a.status} /></td>
                        <td><EnvTag env={a.env} /></td>
                        <td className="right"><RowMenu agent={a} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card>
              <CardHead title="Recent Activity" href="/audit" />
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Time</th><th>Agent</th><th>Action</th><th>Result</th></tr></thead>
                  <tbody>
                    {activity.map((e) => (
                      <tr key={e.id}>
                        <td className="tnum muted">{e.time}</td>
                        <td><span className="agent-cell"><AgentGlyph type={e.agentType!} size={24} /><span className="cell-main">{AGENT_TYPES[e.agentType!].label}</span></span></td>
                        <td className="mono-sm">{e.summary}</td>
                        <td><OutcomePill outcome={e.outcome} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </div>

        <aside className="ov-rail">
          <Card>
            <CardHead title="Live Events" href="/audit" />
            <ul className="feed">
              {evs.slice(0, 5).map((e) => {
                const ic = EVENT_ICON[e.outcome];
                return (
                  <li key={e.id} className="feed-row">
                    <span className={`feed-ic ${ic.cls}`}><Ic n={ic.icon} size={16} /></span>
                    <div className="feed-body">
                      <div className="feed-title">{e.title}</div>
                      <div className="feed-meta">{e.agentType ? AGENT_TYPES[e.agentType].label : (e.target ?? 'Control plane')} <i className="sep">•</i> {e.ago}</div>
                    </div>
                    <OutcomePill outcome={e.outcome} />
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card>
            <CardHead title="Recent Approval Requests" href="/approvals" />
            {pend.length === 0 ? (
              <div className="rail-empty"><Ic n="checkCircle" size={18} /> All caught up — nothing waiting.</div>
            ) : (
              <ul className="feed">
                {pend.slice(0, 3).map((a) => (
                  <li key={a.id} className="feed-row appr-row">
                    <span className={`feed-ic ${a.risk === 'high' ? 'ic-red' : a.risk === 'medium' ? 'ic-gold' : 'ic-green'}`}>
                      <Ic n={a.action.class === 'network' || a.action.class === 'mcp_call' ? 'globe' : a.action.class === 'exec' ? 'shield' : 'hex'} size={16} />
                    </span>
                    <Link href={`/approvals?id=${a.id}`} className="feed-body">
                      <div className="feed-title">{a.title}</div>
                      <div className="feed-meta">{AGENT_TYPES[a.agentType].label} <i className="sep">•</i> {a.user}</div>
                      <div className="feed-meta">{a.requestedAgo}</div>
                    </Link>
                    <div className="appr-btns">
                      <button className="btn-approve" onClick={() => decide(a.id, 'approved')}>Approve</button>
                      <button className="btn-deny" onClick={() => decide(a.id, 'approval_denied')}>Deny</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHead title="Policy Summary" href="/policies" />
            <ul className="feed">
              <li className="feed-row">
                <span className="feed-ic ic-green"><Ic n="shield" size={16} /></span>
                <Link href="/policies/pol-global" className="feed-body">
                  <div className="feed-title">Global Policy</div>
                  <div className="feed-meta">{global?.status === 'active' ? 'Active' : 'Inactive'} <i className="sep">•</i> {global?.rules.length ?? 0} rules</div>
                </Link>
              </li>
              <li className="feed-row">
                <span className="feed-ic ic-teal"><Ic n="check" size={16} /></span>
                <Link href="/lists?list=allow" className="feed-body"><div className="feed-title">Allowlist</div><div className="feed-meta">{allowN} items</div></Link>
              </li>
              <li className="feed-row">
                <span className="feed-ic ic-red"><Ic n="ban" size={16} /></span>
                <Link href="/lists?list=deny" className="feed-body"><div className="feed-title">Denylist</div><div className="feed-meta">{denyN} items</div></Link>
              </li>
              <li className="feed-row">
                <span className="feed-ic ic-blue"><Ic n="user" size={16} /></span>
                <Link href="/approvals" className="feed-body"><div className="feed-title">Approval Rules</div><div className="feed-meta">{approvalRules} active</div></Link>
              </li>
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}

