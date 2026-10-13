'use client';

import { useMemo, useState } from 'react';
import { AGENT_TYPES, endpointById } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { useStore } from '@/store.tsx';
import type { ConsoleEvent, EventType, Outcome } from '@/types.ts';
import { AgentGlyph, Card, CardHead, DemoNote, Empty, EnvTag, OutcomePill, PageHead } from '@/components/ui.tsx';
import { RangeSelect } from '@/components/RangeSelect.tsx';

const TYPE_LABEL: Record<EventType, string> = {
  agent_start: 'Agent start', agent_exit: 'Agent exit', exec: 'Exec', file_open: 'File open', connect: 'Connect',
  blocked: 'Blocked', would_block: 'Would block', policy: 'Policy', approval: 'Approval',
};

const OUTCOMES: (Outcome | 'all')[] = ['all', 'blocked', 'pending', 'would_block', 'allowed', 'system'];

function toCsv(rows: ConsoleEvent[]): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['id', 'time', 'type', 'severity', 'outcome', 'agent', 'user', 'endpoint', 'env', 'action', 'target', 'rule'];
  return [head.join(','), ...rows.map((e) => [
    e.id, e.time, e.type, e.severity, e.outcome, e.agentType ?? '', e.user ?? '', endpointById(e.endpoint)?.hostname ?? '', e.env, e.summary, e.target ?? '', e.rule ?? '',
  ].map(esc).join(','))].join('\n');
}

export function Audit({ initialQuery }: { initialQuery?: string }) {
  const { events, inEnv, approvals } = useStore();
  const [q, setQ] = useState(initialQuery ?? '');
  const [outcome, setOutcome] = useState<Outcome | 'all'>('all');
  const [type, setType] = useState<EventType | 'all'>('all');

  const rows = useMemo(() => events.filter((e) => {
    if (!inEnv(e.env)) return false;
    if (outcome !== 'all' && e.outcome !== outcome) return false;
    if (type !== 'all' && e.type !== type) return false;
    if (!q) return true;
    const hay = `${e.title} ${e.summary} ${e.target ?? ''} ${e.rule ?? ''} ${e.user ?? ''} ${e.agentType ? AGENT_TYPES[e.agentType].label : ''} ${endpointById(e.endpoint)?.hostname ?? ''}`;
    return hay.toLowerCase().includes(q.toLowerCase());
  }), [events, inEnv, outcome, type, q]);

  const download = () => {
    const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'effigent-audit.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const all = events.filter((e) => inEnv(e.env));
  return (
    <div className="page">
      <PageHead title="Audit & Compliance" sub="Every agent action, policy decision and approval — attributable to a person, an endpoint and a rule.">
        <DemoNote />
        <RangeSelect />
        <button className="btn" onClick={download}><Ic n="download" /> Export CSV</button>
      </PageHead>

      <div className="grid-4">
        <Card className="mini-stat"><div className="k">Events</div><div className="v">{all.length}</div><div className="s">in the selected range</div></Card>
        <Card className="mini-stat"><div className="k">Blocked</div><div className="v" style={{ color: 'var(--red)' }}>{all.filter((e) => e.outcome === 'blocked').length}</div><div className="s">by kernel or hooks</div></Card>
        <Card className="mini-stat"><div className="k">Approvals decided</div><div className="v">{approvals.filter((a) => a.state !== 'approval_pending').length}</div><div className="s">{approvals.filter((a) => a.state === 'approved').length} approved · {approvals.filter((a) => a.state === 'approval_denied').length} denied</div></Card>
        <Card className="mini-stat"><div className="k">Policy changes</div><div className="v">{all.filter((e) => e.type === 'policy').length}</div><div className="s">versioned, with author</div></Card>
      </div>

      <div className="toolbar">
        <div className="chips">
          {OUTCOMES.map((o) => (
            <button key={o} className={`chip ${outcome === o ? 'on' : ''}`} onClick={() => setOutcome(o)}>
              {o === 'all' ? 'All results' : o === 'would_block' ? 'Would block' : o[0].toUpperCase() + o.slice(1)}
            </button>
          ))}
        </div>
        <span className="grow" />
        <select className="select" style={{ width: 170 }} value={type} onChange={(e) => setType(e.target.value as EventType | 'all')} aria-label="Event type">
          <option value="all">All event types</option>
          {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input className="input" style={{ width: 260 }} placeholder="Search actions, targets, rules…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search audit log" />
      </div>

      <Card>
        <CardHead title="Audit log" sub={`${rows.length} of ${all.length} events`} />
        {rows.length === 0 ? <Empty icon="search" title="No matching events" sub="Try a different filter." /> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Time</th><th>Event</th><th>Agent</th><th>User</th><th>Endpoint</th><th>Action / target</th><th>Rule</th><th>Result</th></tr></thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="tnum muted" title={e.ago}>{e.time}</td>
                    <td><span className="cell-main" style={{ display: 'block' }}>{TYPE_LABEL[e.type]}</span><span className="cell-sub">{e.severity}</span></td>
                    <td>{e.agentType ? <span className="agent-cell"><AgentGlyph type={e.agentType} size={24} /><span className="cell-main">{AGENT_TYPES[e.agentType].label}</span></span> : <span className="muted">Control plane</span>}</td>
                    <td>{e.user ?? '—'}</td>
                    <td>{e.endpoint ? <span className="mono-sm">{endpointById(e.endpoint)?.hostname}</span> : <EnvTag env={e.env} />}</td>
                    <td style={{ maxWidth: 340 }}><span className="cell-main" style={{ display: 'block' }}>{e.summary}</span><span className="cell-sub mono-sm" style={{ display: 'block' }}>{e.target}</span></td>
                    <td className="muted" style={{ maxWidth: 260, fontSize: 12.5 }}>{e.rule ?? '—'}</td>
                    <td><OutcomePill outcome={e.outcome} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid-3">
        <Card><CardHead title="Retention" sub="Kept for the workspace retention period (Settings). Raw tool input is redacted on the endpoint before it leaves the machine." /></Card>
        <Card><CardHead title="Tamper evidence" sub="Every approval binds to an action fingerprint (fp1:…), so a decision can be traced to the exact command it allowed." /></Card>
        <Card><CardHead title="Evidence export" sub="CSV of the filtered log for SOC 2 / ISO 27001 change- and access-control evidence." /></Card>
      </div>
    </div>
  );
}
