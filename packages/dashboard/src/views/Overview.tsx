'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { agentMeta, MODES } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { RANGE_MS, useLive } from '@/live.tsx';
import { ago, summarizePolicy } from '@/lib/live-map.ts';
import { useStore } from '@/store.tsx';
import { useDemoMode } from '@/demo.tsx';
import type { ConsoleEvent, Mode } from '@/types.ts';
import { GraphCard } from '@/components/GraphCard.tsx';
import { RangeSelect } from '@/components/RangeSelect.tsx';
import { GetStarted } from '@/components/GetStarted.tsx';
import { AgentCell, AgentGlyph, Card, CardHead, Empty, Loading, ModeTag, OutcomePill, PageHead, RiskyTag, StatusPill } from '@/components/ui.tsx';

export const EVENT_ICON: Record<ConsoleEvent['outcome'], { icon: string; cls: string }> = {
  blocked: { icon: 'ban', cls: 'ic-red' },
  pending: { icon: 'shield', cls: 'ic-gold' },
  allowed: { icon: 'hex', cls: 'ic-green' },
  would_block: { icon: 'alert', cls: 'ic-orange' },
  system: { icon: 'file', cls: 'ic-blue' },
};

function Stat({ label, value, delta, deltaDir, deltaGood, foot, icon, tone, href }: {
  label: string; value: number | string; delta?: string; deltaDir?: 'up' | 'down'; deltaGood?: boolean; foot: React.ReactNode;
  icon: string; tone: 'blue' | 'slate' | 'red' | 'gold'; href: string;
}) {
  return (
    <Link href={href} className="stat card">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        <span className={`stat-icon st-${tone}`}><Ic n={icon} size={18} /></span>
      </div>
      <div className="stat-value-row">
        <span className="stat-value tnum">{value}</span>
        {delta && <span className={`stat-delta ${deltaGood ? 'good' : 'bad'}`}><Ic n={deltaDir === 'up' ? 'arrowUp' : 'arrowDown'} size={13} /> {delta}</span>}
      </div>
      <div className="stat-foot">{foot}</div>
    </Link>
  );
}

/** One agent on one endpoint, as seen in the event window. */
interface SeenAgent { key: string; type: string; endpoint: string; endpointName: string; lastAt: number; events: number; blocked: number; exited: boolean }

function RowMenu({ agent }: { agent: SeenAgent }) {
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
          <Link className="pop-opt" href={`/enforcement?endpoint=${encodeURIComponent(agent.endpoint)}`}><Ic n="laptop" size={14} /> Open endpoint</Link>
          <Link className="pop-opt" href={`/audit?q=${encodeURIComponent(`${agentMeta(agent.type).label} ${agent.endpointName}`)}`}><Ic n="clipboard" size={14} /> Events</Link>
        </div>
      )}
    </div>
  );
}

export function Overview() {
  const { env, range, pending, decide } = useStore();
  const { demo } = useDemoMode();
  const { consoleEvents, endpointRows, policy, latestPolicy, updatedAt, now, loaded, approvals } = useLive();
  const livePending = approvals.filter((a) => a.state === 'pending' && Date.parse(a.expires_at) > now);

  const since = now - RANGE_MS[range];
  const evs = consoleEvents.filter((e) => (e.at ?? 0) >= since);
  const eps = endpointRows.filter((e) => !e.revoked);
  const online = eps.filter((e) => e.status === 'online').length;

  // Agents = distinct (agent, endpoint) pairs with events in the range.
  const agents = useMemo(() => {
    const m = new Map<string, SeenAgent>();
    for (const e of evs) { // newest first
      if (!e.agentType || !e.endpoint) continue;
      const key = `${e.agentType}@${e.endpoint}`;
      let a = m.get(key);
      if (!a) {
        a = { key, type: e.agentType, endpoint: e.endpoint, endpointName: e.endpointName ?? e.endpoint, lastAt: e.at ?? 0, events: 0, blocked: 0, exited: e.type === 'agent_exit' };
        m.set(key, a);
      }
      a.events++;
      if (e.outcome === 'blocked') a.blocked++;
    }
    return [...m.values()];
  }, [evs]);
  const status = (a: SeenAgent): 'active' | 'idle' => (!a.exited && now - a.lastAt < 10 * 60_000 ? 'active' : 'idle');
  const active = agents.filter((a) => status(a) === 'active').length;
  const blocked = evs.filter((e) => e.outcome === 'blocked').length;
  const wouldBlock = evs.filter((e) => e.outcome === 'would_block').length;
  const risky = evs.filter((e) => e.risk === 'risky');
  const riskyTop = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of risky) { const k = e.riskRule ?? '?'; m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  }, [risky]);
  // Routine commands (ls, cat, git status…) stay in Audit; the overview feeds show what matters.
  const notable = evs.filter((e) => e.risk !== 'routine');

  const summary = policy?.body ? summarizePolicy(policy.body) : null;
  const mode = summary?.mode && summary.mode in MODES ? (summary.mode as Mode) : null;
  const n = (k: string) => summary?.lists[k] ?? 0;
  const onLatest = eps.filter((e) => latestPolicy > 0 && e.policyVersion === latestPolicy).length;
  const rangeLabel = { '1h': 'last hour', '24h': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days', '90d': 'last 90 days' }[range];

  const activeAgents = [...agents].sort((a, b) => b.lastAt - a.lastAt).slice(0, 5);
  const activity = notable.filter((e) => e.agentType).slice(0, 5);

  return (
    <div className="page">
      <PageHead title="Overview" sub="Control, secure, and monitor your AI agents — across every endpoint, every action.">
        <span className="updated"><span className="dot" /> {updatedAt ? `Last updated ${ago(updatedAt, now)}` : 'Connecting…'}</span>
        <RangeSelect />
      </PageHead>
      <GetStarted />

      <div className="ov-grid">
        <div className="ov-main">
          <div className="stat-row">
            <Stat label="Agents Seen" value={agents.length} icon="users" tone="blue" href="/audit"
              foot={<>{active} active <i className="sep">•</i> {agents.length - active} idle <i className="sep">•</i> {rangeLabel}</>} />
            <Stat label="Endpoints Online" value={`${online}/${eps.length}`} icon="laptop" tone="slate" href="/enforcement"
              foot={<>{onLatest} on policy {latestPolicy > 0 ? `v${latestPolicy}` : '(none published)'}</>} />
            <Stat label="Actions Blocked" value={blocked} icon="ban" tone="red" href="/audit?outcome=blocked"
              foot={<>{wouldBlock} would block in monitor mode <i className="sep">•</i> {rangeLabel}</>} />
            <Stat label="Risky Commands" value={risky.length} icon="alert" tone="gold" href="/audit?risk=risky"
              foot={<>{riskyTop.length ? riskyTop.join(', ') : 'none'} <i className="sep">•</i> {rangeLabel}</>} />
          </div>

          <GraphCard env={env} />

          <div className="ov-bottom">
            <Card>
              <CardHead title="Agents" href="/enforcement" />
              {!loaded ? <Loading /> : activeAgents.length === 0 ? <Empty icon="users" title="No agent activity" sub={`Nothing reported in the ${rangeLabel}.`} /> : (
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead><tr><th>Agent</th><th>Endpoint</th><th>Status</th><th>Last event</th><th aria-label="Actions" /></tr></thead>
                    <tbody>
                      {activeAgents.map((a) => (
                        <tr key={a.key}>
                          <td><AgentCell type={a.type} sub={`${a.events} events${a.blocked ? ` · ${a.blocked} blocked` : ''}`} /></td>
                          <td className="cell-main mono-sm">{a.endpointName}</td>
                          <td><StatusPill status={status(a)} /></td>
                          <td className="muted">{ago(a.lastAt, now)}</td>
                          <td className="right"><RowMenu agent={a} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <Card>
              <CardHead title="Recent Activity" href="/audit" />
              {!loaded ? <Loading /> : activity.length === 0 ? <Empty icon="activity" title="No activity yet" sub="Events appear here as enrolled endpoints report them." /> : (
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead><tr><th>Time</th><th>Agent</th><th>Action</th><th>Result</th></tr></thead>
                    <tbody>
                      {activity.map((e) => (
                        <tr key={e.id}>
                          <td className="tnum muted" title={e.ago}>{e.time}</td>
                          <td><span className="agent-cell"><AgentGlyph type={e.agentType!} size={24} /><span className="cell-main">{agentMeta(e.agentType).label}</span></span></td>
                          <td className="mono-sm">{e.summary}{e.risk === 'risky' && <RiskyTag />}</td>
                          <td><OutcomePill outcome={e.outcome} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </div>

        <aside className="ov-rail">
          <Card>
            <CardHead title="Live Events" href="/audit" />
            {notable.length === 0 ? <div className="rail-empty"><Ic n="activity" size={18} /> {loaded ? (evs.length ? 'Only routine commands in this range.' : 'No events in this range.') : 'Loading…'}</div> : (
              <ul className="feed">
                {notable.slice(0, 5).map((e) => {
                  const ic = EVENT_ICON[e.outcome];
                  return (
                    <li key={e.id} className="feed-row">
                      <span className={`feed-ic ${ic.cls}`}><Ic n={ic.icon} size={16} /></span>
                      <div className="feed-body">
                        <div className="feed-title">{e.title}</div>
                        <div className="feed-meta">{e.agentType ? agentMeta(e.agentType).label : 'effigentd'} <i className="sep">•</i> {e.endpointName ?? '—'} <i className="sep">•</i> {e.ago}</div>
                      </div>
                      <OutcomePill outcome={e.outcome} />
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHead title="Waiting for approval" href="/approvals" />
            {demo ? (pending.length === 0 ? (
              <div className="rail-empty"><Ic n="checkCircle" size={18} /> All caught up — nothing waiting.</div>
            ) : (
              <ul className="feed">
                {pending.slice(0, 3).map((a) => (
                  <li key={a.id} className="feed-row appr-row">
                    <span className={`feed-ic ${a.risk === 'high' ? 'ic-red' : a.risk === 'medium' ? 'ic-gold' : 'ic-green'}`}>
                      <Ic n={a.action.class === 'network' || a.action.class === 'mcp_call' ? 'globe' : a.action.class === 'exec' ? 'shield' : 'hex'} size={16} />
                    </span>
                    <Link href={`/approvals?id=${a.id}`} className="feed-body">
                      <div className="feed-title">{a.title}</div>
                      <div className="feed-meta">{agentMeta(a.agentType).label} <i className="sep">•</i> {a.user}</div>
                      <div className="feed-meta">{a.requestedAgo}</div>
                    </Link>
                    <div className="appr-btns">
                      <button className="btn-approve" onClick={() => decide(a.id, 'approved')}>Approve</button>
                      <button className="btn-deny" onClick={() => decide(a.id, 'approval_denied')}>Deny</button>
                    </div>
                  </li>
                ))}
              </ul>
            )) : livePending.length === 0 ? (
              <div className="rail-empty"><Ic n="checkCircle" size={18} /> Nothing waiting. Agents pause here when a policy rule asks for approval.</div>
            ) : (
              <ul className="feed">
                {livePending.slice(0, 3).map((a) => (
                  <li key={a.id} className="feed-row">
                    <span className="feed-ic ic-gold"><Ic n="clock" size={16} /></span>
                    <Link href={`/approvals?id=${a.id}`} className="feed-body">
                      <div className="feed-title mono-sm">{a.summary}</div>
                      <div className="feed-meta">{agentMeta(a.agent).label} <i className="sep">•</i> {a.os_user || a.hostname} <i className="sep">•</i> {ago(Date.parse(a.requested_at), now)}</div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHead title="Endpoint Policy" href="/policies">{mode && <ModeTag mode={mode} />}</CardHead>
            <ul className="feed">
              <li className="feed-row">
                <span className="feed-ic ic-green"><Ic n="shield" size={16} /></span>
                <Link href="/policies" className="feed-body">
                  <div className="feed-title">{latestPolicy > 0 ? `Version ${latestPolicy}` : 'Built-in default'}</div>
                  <div className="feed-meta">{latestPolicy > 0 ? `${policy?.comment || 'no comment'}` : 'Nothing published yet'}</div>
                </Link>
              </li>
              <li className="feed-row">
                <span className="feed-ic ic-red"><Ic n="ban" size={16} /></span>
                <Link href="/policies" className="feed-body"><div className="feed-title">Denied</div><div className="feed-meta">{n('exec_deny')} binaries <i className="sep">•</i> {n('file_deny')} file paths <i className="sep">•</i> {n('network_deny')} networks</div></Link>
              </li>
              <li className="feed-row">
                <span className="feed-ic ic-teal"><Ic n="check" size={16} /></span>
                <Link href="/policies" className="feed-body"><div className="feed-title">Allowed</div><div className="feed-meta">{n('exec_allow')} binaries <i className="sep">•</i> {n('network_allow')} networks</div></Link>
              </li>
              <li className="feed-row">
                <span className="feed-ic ic-blue"><Ic n="alert" size={16} /></span>
                <Link href="/policies" className="feed-body"><div className="feed-title">Alerts</div><div className="feed-meta">{n('file_alert')} sensitive file paths <i className="sep">•</i> {summary?.agents ?? 0} agent definitions</div></Link>
              </li>
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}
