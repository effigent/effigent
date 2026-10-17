'use client';

import { useMemo, useState } from 'react';
import { agentMeta } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { RANGE_MS, useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { dateTime, ms } from '@/lib/live-map.ts';
import type { ConsoleEvent, EventType, Outcome } from '@/types.ts';
import { AgentGlyph, Card, CardHead, Empty, Loading, OutcomePill, PageGuide, PageHead, RiskyTag, Seg } from '@/components/ui.tsx';
import { RangeSelect } from '@/components/RangeSelect.tsx';
import { AuditTrail } from '@/components/AuditTrail.tsx';

const TYPE_LABEL: Record<Exclude<EventType, 'approval'>, string> = {
  agent_start: 'Agent start', agent_exit: 'Agent exit', exec: 'Exec', exit: 'Exit', file_open: 'File open', connect: 'Connect',
  blocked: 'Blocked', would_block: 'Would block', policy: 'Policy',
};
const typeLabel = (t: EventType) => (t === 'approval' ? 'Approval' : TYPE_LABEL[t]);

const OUTCOMES: (Outcome | 'all')[] = ['all', 'blocked', 'would_block', 'pending', 'allowed', 'system'];

const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

function eventsCsv(rows: ConsoleEvent[]): string {
  const head = ['id', 'time', 'type', 'severity', 'outcome', 'agent', 'endpoint', 'action', 'target', 'rule', 'via', 'mode', 'command_class'];
  return [head.join(','), ...rows.map((e) => [
    e.id, e.at ? new Date(e.at).toISOString() : e.time, e.type, e.severity, e.outcome, e.agentType ?? '', e.endpointName ?? e.endpoint ?? '',
    e.summary, e.target ?? '', e.rule ?? '', e.via ?? '', e.mode ?? '', e.risk ?? '',
  ].map(esc).join(','))].join('\n');
}

export function Audit({ initialQuery, initialOutcome, initialTab = 'events', initialRisky = false }: {
  initialQuery?: string; initialOutcome?: string; initialTab?: 'events' | 'trail'; initialRisky?: boolean;
}) {
  const { range } = useStore();
  const { consoleEvents, audit, loaded, now } = useLive();
  const [tab, setTab] = useState<'events' | 'trail'>(initialTab);
  const [q, setQ] = useState(initialQuery ?? '');
  const [outcome, setOutcome] = useState<Outcome | 'all'>(OUTCOMES.includes(initialOutcome as Outcome) ? (initialOutcome as Outcome) : 'all');
  const [type, setType] = useState<EventType | 'all'>('all');
  const [riskyOnly, setRiskyOnly] = useState(initialRisky);
  const [showRoutine, setShowRoutine] = useState(false);

  const since = now - RANGE_MS[range];
  const all = useMemo(() => consoleEvents.filter((e) => (e.at ?? 0) >= since), [consoleEvents, since]);
  const trail = useMemo(() => audit.filter((a) => (ms(a.at) ?? 0) >= since), [audit, since]);
  const needle = q.trim().toLowerCase();

  // Every filter but the routine one; routine command events are then hidden unless asked for.
  const matched = useMemo(() => all.filter((e) => {
    if (outcome !== 'all' && e.outcome !== outcome) return false;
    if (type !== 'all' && e.type !== type) return false;
    if (riskyOnly && e.risk !== 'risky') return false;
    if (!needle) return true;
    const hay = `${e.title} ${e.summary} ${e.target ?? ''} ${e.rule ?? ''} ${e.via ?? ''} ${agentMeta(e.agentType).label} ${e.agentType ?? ''} ${e.endpointName ?? ''}${e.risk === 'risky' ? ' risky' : ''}`;
    return needle.split(/\s+/).every((w) => hay.toLowerCase().includes(w));
  }), [all, outcome, type, riskyOnly, needle]);
  const routineHidden = showRoutine ? 0 : matched.filter((e) => e.risk === 'routine').length;
  const rows = useMemo(() => (showRoutine ? matched : matched.filter((e) => e.risk !== 'routine')), [matched, showRoutine]);
  const routineTotal = useMemo(() => matched.filter((e) => e.risk === 'routine').length, [matched]);
  const riskyCount = all.filter((e) => e.risk === 'risky').length;

  const download = () => {
    const blob = new Blob([eventsCsv(rows)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'effigent-events.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="page">
      <PageHead title="Activity & Audit" sub="Every agent action effigentd reported, and every change made in this console — attributable and tamper-evident.">
        {tab === 'events' && <RangeSelect />}
        {tab === 'events' && <button className="btn" onClick={download}><Ic n="download" /> Export CSV</button>}
      </PageHead>
      <PageGuide id="audit" steps={[<><b>Agent events</b>: everything agents ran, opened and reached, with what policy did</>, <><b>Admin trail</b>: every policy, approval and setting change — tamper-evident</>, <>Filter by time and result, then <b>Export CSV</b> for compliance</>]} />

      <div className="grid-4">
        <Card className="mini-stat"><div className="k">Agent events</div><div className="v">{all.length}</div><div className="s">in the selected range (latest {consoleEvents.length} fetched)</div></Card>
        <Card className="mini-stat"><div className="k">Blocked</div><div className="v" style={{ color: 'var(--red)' }}>{all.filter((e) => e.outcome === 'blocked').length}</div><div className="s">by the kernel on the endpoint</div></Card>
        <Card className="mini-stat"><div className="k">Would block</div><div className="v" style={{ color: 'var(--orange, var(--gold))' }}>{all.filter((e) => e.outcome === 'would_block').length}</div><div className="s">matched in monitor / learn mode</div></Card>
        <Card className="mini-stat"><div className="k">Console changes</div><div className="v">{trail.length}</div><div className="s">{trail.filter((a) => a.action === 'policy.publish').length} policy publishes · {trail.filter((a) => a.action.startsWith('denied.')).length} denied</div></Card>
      </div>

      <div className="toolbar">
        <Seg value={tab} onChange={setTab} options={[{ id: 'events', label: 'Agent events' }, { id: 'trail', label: 'Console audit trail' }]} />
        {tab === 'events' && (
          <div className="chips">
            {OUTCOMES.map((o) => (
              <button key={o} className={`chip ${outcome === o ? 'on' : ''}`} onClick={() => setOutcome(o)}>
                {o === 'all' ? 'All results' : o === 'would_block' ? 'Would block' : o[0].toUpperCase() + o.slice(1)}
              </button>
            ))}
            <button className={`chip ${riskyOnly ? 'on' : ''}`} aria-pressed={riskyOnly} onClick={() => setRiskyOnly((v) => !v)} title="Only commands classified as risky (rm, sudo, curl, ssh, git push, npm install…)">
              Risky commands <span className="n">{riskyCount}</span>
            </button>
          </div>
        )}
        <span className="grow" />
        {tab === 'events' && (
          <select className="select" style={{ width: 170 }} value={type} onChange={(e) => setType(e.target.value as EventType | 'all')} aria-label="Event type">
            <option value="all">All event types</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        )}
        {tab === 'events' && (
          <input className="input" style={{ width: 260, maxWidth: '100%' }} placeholder="Search agents, targets, rules, hosts…"
            value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        )}
      </div>

      {tab === 'events' ? (
        <Card>
          <CardHead title="Agent events" sub={`${rows.length} of ${all.length} events${routineHidden ? ` · ${routineHidden} routine command${routineHidden === 1 ? '' : 's'} hidden` : ''}`}>
            {routineTotal > 0 && (
              <button className={`chip ${showRoutine ? 'on' : ''}`} aria-pressed={showRoutine} onClick={() => setShowRoutine((v) => !v)}
                title="Routine commands are read-only housekeeping: ls, cat, grep, git status…">
                {showRoutine ? 'Hide routine commands' : `Show routine commands (${routineHidden} hidden)`}
              </button>
            )}
          </CardHead>
          {!loaded ? <Loading /> : rows.length === 0 ? (
            <Empty icon="search" title={all.length ? 'No matching events' : 'No events in this range'}
              sub={!all.length ? 'Enrolled endpoints report agent activity here.' : routineHidden ? `Only routine commands match — ${routineHidden} hidden. Use “Show routine commands” to see them.` : 'Try a different filter.'} />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Time</th><th>Event</th><th>Agent</th><th>Endpoint</th><th>Action / target</th><th>Rule</th><th>Result</th></tr></thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.id}>
                      <td className="tnum muted" title={e.at ? dateTime(e.at) : undefined}>{e.time}<span className="cell-sub" style={{ display: 'block' }}>{e.ago}</span></td>
                      <td><span className="cell-main" style={{ display: 'block' }}>{typeLabel(e.type)}</span><span className="cell-sub">{e.severity}{e.mode ? ` · ${e.mode}` : ''}</span></td>
                      <td>{e.agentType ? <span className="agent-cell"><AgentGlyph type={e.agentType} size={24} /><span><span className="cell-main">{agentMeta(e.agentType).label}</span>{e.via && <span className="cell-sub">{e.via}</span>}</span></span> : <span className="muted">effigentd</span>}</td>
                      <td><span className="mono-sm">{e.endpointName ?? '—'}</span></td>
                      <td style={{ maxWidth: 340 }}><span className="cell-main" style={{ display: 'block' }}>{e.summary}{e.risk === 'risky' && <RiskyTag />}</span><span className="cell-sub mono-sm" style={{ display: 'block', wordBreak: 'break-all' }}>{e.target}</span></td>
                      <td className="muted" style={{ maxWidth: 260, fontSize: 12.5 }}>{e.rule ?? '—'}</td>
                      <td><OutcomePill outcome={e.outcome} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <AuditTrail />
      )}

      <div className="grid-3">
        <Card><CardHead title="Where events come from" sub="effigentd attributes every exec, sensitive file open and outbound connect to the agent that caused it, and ships them to the control plane in batches." /></Card>
        <Card><CardHead title="Tamper evidence" sub="Console actions are hash-chained per workspace. Verify recomputes the chain on the server and reports the first entry that doesn't match." /></Card>
        <Card><CardHead title="Evidence export" sub="CSV of the filtered view — agent events or the console trail — for SOC 2 / ISO 27001 change- and access-control evidence." /></Card>
      </div>
    </div>
  );
}
