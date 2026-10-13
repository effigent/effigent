'use client';

import { useMemo, useState } from 'react';
import { agentMeta } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { RANGE_MS, useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { apiErrorText, type ApiAuditEntry, type ApiAuditVerification } from '@/lib/api.ts';
import { ago, dateTime, ms } from '@/lib/live-map.ts';
import type { ConsoleEvent, EventType, Outcome } from '@/types.ts';
import { AgentGlyph, Card, CardHead, Empty, Loading, OutcomePill, PageHead, Seg } from '@/components/ui.tsx';
import { RangeSelect } from '@/components/RangeSelect.tsx';

const TYPE_LABEL: Record<Exclude<EventType, 'approval'>, string> = {
  agent_start: 'Agent start', agent_exit: 'Agent exit', exec: 'Exec', exit: 'Exit', file_open: 'File open', connect: 'Connect',
  blocked: 'Blocked', would_block: 'Would block', policy: 'Policy',
};
const typeLabel = (t: EventType) => (t === 'approval' ? 'Approval' : TYPE_LABEL[t]);

const OUTCOMES: (Outcome | 'all')[] = ['all', 'blocked', 'would_block', 'allowed', 'system'];

const ACTION_LABEL: Record<string, string> = {
  'policy.publish': 'Published policy',
  'endpoint.revoke': 'Revoked endpoint',
  'enrollment_token.create': 'Created enrollment token',
};
const actionLabel = (a: string) => ACTION_LABEL[a] ?? (a.startsWith('denied.') ? `Denied: ${a.slice(7)}` : a);

const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

function eventsCsv(rows: ConsoleEvent[]): string {
  const head = ['id', 'time', 'type', 'severity', 'outcome', 'agent', 'endpoint', 'action', 'target', 'rule', 'via', 'mode'];
  return [head.join(','), ...rows.map((e) => [
    e.id, e.at ? new Date(e.at).toISOString() : e.time, e.type, e.severity, e.outcome, e.agentType ?? '', e.endpointName ?? e.endpoint ?? '',
    e.summary, e.target ?? '', e.rule ?? '', e.via ?? '', e.mode ?? '',
  ].map(esc).join(','))].join('\n');
}

function trailCsv(rows: ApiAuditEntry[]): string {
  const head = ['seq', 'at', 'actor', 'actor_role', 'actor_via', 'action', 'target', 'details', 'ip', 'prev_hash', 'hash'];
  return [head.join(','), ...rows.map((a) => [
    a.seq, a.at, a.actor, a.actor_role, a.actor_via, a.action, a.target, a.details ? JSON.stringify(a.details) : '', a.ip, a.prev_hash, a.hash,
  ].map(esc).join(','))].join('\n');
}

function details(d: Record<string, unknown> | null): string {
  if (!d) return '—';
  return Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ');
}

/** The Verify button (for the card header) and its result (for below it). */
function useVerify(): [React.ReactNode, React.ReactNode] {
  const { api } = useLive();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ApiAuditVerification | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setErr(null);
    try { setRes(await api.get<ApiAuditVerification>('/audit/verify')); } catch (e) { setErr(apiErrorText(e)); } finally { setBusy(false); }
  };
  return [
    <button key="b" className="btn sm" onClick={run} disabled={busy}><Ic n="shieldCheck" size={14} /> {busy ? 'Verifying…' : 'Verify chain'}</button>,
    (res || err) && (
        <div key="r" className={`callout ${err || !res?.ok ? 'bad' : ''}`} style={{ margin: '0 20px 14px' }} role="status">
          <Ic n={err || !res?.ok ? 'alert' : 'checkCircle'} size={16} />
          <span>
            {err ?? (res!.ok
              ? <>Hash chain intact — {res!.entries} entr{res!.entries === 1 ? 'y' : 'ies'}{res!.head && <> · head <code>{res!.head.slice(0, 16)}…</code></>}</>
              : <>Chain broken at entry #{res!.broken_at}: {res!.reason}. Entries from that point may have been altered.</>)}
          </span>
        </div>
    ),
  ];
}

export function Audit({ initialQuery, initialOutcome, initialTab = 'events' }: { initialQuery?: string; initialOutcome?: string; initialTab?: 'events' | 'trail' }) {
  const { range } = useStore();
  const { consoleEvents, audit, loaded, now } = useLive();
  const [tab, setTab] = useState<'events' | 'trail'>(initialTab);
  const [q, setQ] = useState(initialQuery ?? '');
  const [outcome, setOutcome] = useState<Outcome | 'all'>(OUTCOMES.includes(initialOutcome as Outcome) ? (initialOutcome as Outcome) : 'all');
  const [type, setType] = useState<EventType | 'all'>('all');
  const [verifyBtn, verifyResult] = useVerify();

  const since = now - RANGE_MS[range];
  const all = useMemo(() => consoleEvents.filter((e) => (e.at ?? 0) >= since), [consoleEvents, since]);
  const trail = useMemo(() => audit.filter((a) => (ms(a.at) ?? 0) >= since), [audit, since]);
  const needle = q.trim().toLowerCase();

  const rows = useMemo(() => all.filter((e) => {
    if (outcome !== 'all' && e.outcome !== outcome) return false;
    if (type !== 'all' && e.type !== type) return false;
    if (!needle) return true;
    const hay = `${e.title} ${e.summary} ${e.target ?? ''} ${e.rule ?? ''} ${e.via ?? ''} ${agentMeta(e.agentType).label} ${e.agentType ?? ''} ${e.endpointName ?? ''}`;
    return needle.split(/\s+/).every((w) => hay.toLowerCase().includes(w));
  }), [all, outcome, type, needle]);

  const trailRows = useMemo(() => trail.filter((a) => {
    if (!needle) return true;
    const hay = `${a.actor} ${a.actor_role} ${a.action} ${actionLabel(a.action)} ${a.target} ${details(a.details)} ${a.ip}`;
    return needle.split(/\s+/).every((w) => hay.toLowerCase().includes(w));
  }), [trail, needle]);

  const download = () => {
    const blob = new Blob([tab === 'events' ? eventsCsv(rows) : trailCsv(trailRows)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = tab === 'events' ? 'effigent-events.csv' : 'effigent-audit-trail.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="page">
      <PageHead title="Audit & Compliance" sub="Every agent action effigentd reported, and every change made in this console — attributable and tamper-evident.">
        <RangeSelect />
        <button className="btn" onClick={download}><Ic n="download" /> Export CSV</button>
      </PageHead>

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
          </div>
        )}
        <span className="grow" />
        {tab === 'events' && (
          <select className="select" style={{ width: 170 }} value={type} onChange={(e) => setType(e.target.value as EventType | 'all')} aria-label="Event type">
            <option value="all">All event types</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        )}
        <input className="input" style={{ width: 260, maxWidth: '100%' }} placeholder={tab === 'events' ? 'Search agents, targets, rules, hosts…' : 'Search actors, actions, targets…'}
          value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
      </div>

      {tab === 'events' ? (
        <Card>
          <CardHead title="Agent events" sub={`${rows.length} of ${all.length} events`} />
          {!loaded ? <Loading /> : rows.length === 0 ? (
            <Empty icon="search" title={all.length ? 'No matching events' : 'No events in this range'} sub={all.length ? 'Try a different filter.' : 'Enrolled endpoints report agent activity here.'} />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Time</th><th>Event</th><th>Agent</th><th>Endpoint</th><th>Action / target</th><th>Rule</th><th>Result</th></tr></thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.id}>
                      <td className="tnum muted" title={e.at ? dateTime(e.at) : undefined}>{e.time}<span className="cell-sub">{e.ago}</span></td>
                      <td><span className="cell-main" style={{ display: 'block' }}>{typeLabel(e.type)}</span><span className="cell-sub">{e.severity}{e.mode ? ` · ${e.mode}` : ''}</span></td>
                      <td>{e.agentType ? <span className="agent-cell"><AgentGlyph type={e.agentType} size={24} /><span><span className="cell-main">{agentMeta(e.agentType).label}</span>{e.via && <span className="cell-sub">{e.via}</span>}</span></span> : <span className="muted">effigentd</span>}</td>
                      <td><span className="mono-sm">{e.endpointName ?? '—'}</span></td>
                      <td style={{ maxWidth: 340 }}><span className="cell-main" style={{ display: 'block' }}>{e.summary}</span><span className="cell-sub mono-sm" style={{ display: 'block', wordBreak: 'break-all' }}>{e.target}</span></td>
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
        <Card>
          <CardHead title="Console audit trail" sub="Append-only and hash-chained per workspace: each entry commits to the one before it, so edits or deletions break the chain.">
            {verifyBtn}
          </CardHead>
          {verifyResult}
          {!loaded ? <Loading /> : trailRows.length === 0 ? (
            <Empty icon="clipboard" title={trail.length ? 'No matching entries' : 'No console changes in this range'} sub="Policy publishes, endpoint revocations, enrollment tokens and denied attempts are recorded here." />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr></thead>
                <tbody>
                  {trailRows.map((a) => (
                    <tr key={a.seq}>
                      <td className="tnum muted">{a.seq}</td>
                      <td className="muted" title={a.at}>{dateTime(ms(a.at))}<span className="cell-sub">{ago(ms(a.at), now)}</span></td>
                      <td><span className="cell-main mono-sm" style={{ display: 'block' }}>{a.actor}</span><span className="cell-sub">{a.actor_role || '—'} · {a.actor_via}</span></td>
                      <td>{a.action.startsWith('denied.') ? <span className="badge b-red">{actionLabel(a.action)}</span> : <span className="cell-main">{actionLabel(a.action)}</span>}</td>
                      <td className="mono-sm" style={{ wordBreak: 'break-all' }}>{a.target || '—'}</td>
                      <td className="muted" style={{ maxWidth: 320, fontSize: 12.5 }}>{details(a.details)}</td>
                      <td className="mono-sm muted">{a.ip || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <div className="grid-3">
        <Card><CardHead title="Where events come from" sub="effigentd attributes every exec, sensitive file open and outbound connect to the agent that caused it, and ships them to the control plane in batches." /></Card>
        <Card><CardHead title="Tamper evidence" sub="Console actions are hash-chained per workspace. Verify recomputes the chain on the server and reports the first entry that doesn't match." /></Card>
        <Card><CardHead title="Evidence export" sub="CSV of the filtered view — agent events or the console trail — for SOC 2 / ISO 27001 change- and access-control evidence." /></Card>
      </div>
    </div>
  );
}
