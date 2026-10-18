'use client';

import { HELP } from '@/lib/help.tsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { agentMeta } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { RANGE_MS, useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { apiErrorText, type ApiEvent } from '@/lib/api.ts';
import { classify } from '@/lib/live-graph.ts';
import { ago, dateTime, toConsoleEvent } from '@/lib/live-map.ts';
import type { ConsoleEvent, EventType } from '@/types.ts';
import { AgentGlyph, Card, CardHead, Empty, InfoTip, Loading, OutcomePill, RiskyTag } from '@/components/ui.tsx';

/** Result = what policy did. Each maps to the event types the server filters on. */
const RESULTS = [
  { id: 'all', label: 'All results', types: [] as string[] },
  { id: 'allowed', label: 'Allowed', types: ['exec', 'file_open', 'connect', 'approved'] },
  { id: 'blocked', label: 'Blocked', types: ['blocked', 'approval_denied'] },
  { id: 'would_block', label: 'Would block', types: ['would_block'] },
  { id: 'waiting', label: 'Waiting for approval', types: ['approval_pending'] },
] as const;
type ResultId = (typeof RESULTS)[number]['id'];

/** What happened = what the agent touched (read from each event). */
const WHAT = [
  { id: 'all', label: 'All activity' },
  { id: 'command', label: 'Commands' },
  { id: 'file', label: 'Files' },
  { id: 'network', label: 'Network' },
  { id: 'tool', label: 'Agent tools & MCP' },
  { id: 'session', label: 'Sessions & policy' },
] as const;
type WhatId = (typeof WHAT)[number]['id'];
const SESSION_TYPES = ['agent_start', 'agent_exit', 'exit', 'policy'];

const TYPE_LABEL: Record<Exclude<EventType, 'approval'>, string> = {
  agent_start: 'Agent start', agent_exit: 'Agent exit', exec: 'Exec', exit: 'Exit', file_open: 'File open', connect: 'Connect',
  blocked: 'Blocked', would_block: 'Would block', policy: 'Policy',
};
const typeLabel = (t: EventType) => (t === 'approval' ? 'Approval' : TYPE_LABEL[t]);

const PAGE = 200;
/** Housekeeping that ran (ls, git status…) can be hidden; anything policy stopped or paused never is. */
const routine = (e: ConsoleEvent) => e.risk === 'routine' && (e.outcome === 'allowed' || e.outcome === 'system');
interface Page { events: ApiEvent[]; next_before: string; retention_days?: number }
interface Row { raw: ApiEvent; ce: ConsoleEvent; what: WhatId }

const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
function eventsCsv(rows: Row[]): string {
  const head = ['id', 'time', 'type', 'severity', 'outcome', 'agent', 'endpoint', 'action', 'target', 'rule', 'via', 'mode', 'command_class'];
  return [head.join(','), ...rows.map(({ ce: e }) => [
    e.id, e.at ? new Date(e.at).toISOString() : e.time, e.type, e.severity, e.outcome, e.agentType ?? '', e.endpointName ?? e.endpoint ?? '',
    e.summary, e.target ?? '', e.rule ?? '', e.via ?? '', e.mode ?? '', e.risk ?? '',
  ].map(esc).join(','))].join('\n');
}

/** Agent events, read from the server a page at a time: result, agent, machine,
 *  period and text filter on the server; what-was-touched, risky and routine
 *  are read from each event here. */
export function ActivityEvents({ initialQuery, initialOutcome, initialRisky = false }: { initialQuery?: string; initialOutcome?: string; initialRisky?: boolean }) {
  const { api, endpointRows, now, loaded } = useLive();
  const { range } = useStore();
  const [result, setResult] = useState<ResultId>(() => {
    const o = initialOutcome === 'pending' ? 'waiting' : initialOutcome;
    return (RESULTS.find((r) => r.id === o)?.id ?? 'all') as ResultId;
  });
  const [what, setWhat] = useState<WhatId>('all');
  const [agent, setAgent] = useState('');
  const [machine, setMachine] = useState('');
  const [text, setText] = useState(initialQuery ?? '');
  const [q, setQ] = useState(initialQuery ?? '');
  const [riskyOnly, setRiskyOnly] = useState(initialRisky);
  const [showRoutine, setShowRoutine] = useState(false);
  const [raw, setRaw] = useState<ApiEvent[]>([]);
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [first, setFirst] = useState(true);
  const [retention, setRetention] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const gen = useRef(0);
  const autoFills = useRef(0);

  useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  const hostById = useMemo(() => new Map(endpointRows.map((e) => [e.id, e.hostname])), [endpointRows]);

  // server-side filters
  const params = useMemo(() => {
    const p = new URLSearchParams({ paged: '1', limit: String(PAGE) });
    let types: string[] = [...RESULTS.find((r) => r.id === result)!.types];
    if (what === 'session') types = result === 'all' ? SESSION_TYPES : ['none'];
    if (types.length) p.set('type', types.join(','));
    if (agent) p.set('agent', agent);
    if (machine) p.set('endpoint', machine);
    if (q) p.set('q', q);
    p.set('since', new Date(Date.now() - RANGE_MS[range]).toISOString().replace(/\.\d+Z$/, 'Z'));
    return p;
  }, [result, what, agent, machine, q, range]);

  const fetchPage = useCallback(async (before: string, g: number) => {
    setBusy(true); setErr(null);
    try {
      const p = new URLSearchParams(params);
      if (before) p.set('before', before);
      const r = await api.get<Page | ApiEvent[]>(`/events?${p}`);
      if (g !== gen.current) return;
      const page: Page = Array.isArray(r) ? { events: r, next_before: '' } : r; // an older control plane: the newest events only
      setRaw((cur) => (before ? [...cur, ...page.events] : page.events));
      setNext(page.next_before);
      if (page.retention_days) setRetention(page.retention_days);
    } catch (e) {
      if (g === gen.current) setErr(apiErrorText(e));
    } finally {
      if (g === gen.current) { setBusy(false); setFirst(false); }
    }
  }, [api, params]);

  // any server filter change starts again from the newest event
  useEffect(() => { gen.current++; autoFills.current = 0; setRaw([]); setNext(''); void fetchPage('', gen.current); }, [fetchPage]);

  const rows: Row[] = useMemo(() => raw.map((e) => {
    const c = classify(e);
    const w: WhatId = SESSION_TYPES.includes(e.type) ? 'session' : (c?.kind as WhatId) ?? 'command';
    return { raw: e, ce: { ...toConsoleEvent(e, hostById), ago: ago(Date.parse(e.time), now) }, what: w };
  }), [raw, hostById, now]);
  const matched = useMemo(() => rows.filter((r) => (what === 'all' || r.what === what) && (!riskyOnly || r.ce.risk === 'risky')), [rows, what, riskyOnly]);
  const shown = useMemo(() => (showRoutine ? matched : matched.filter((r) => !routine(r.ce))), [matched, showRoutine]);
  const routineHidden = matched.length - shown.length;

  // a page that is mostly routine (or filtered out here) would look empty: read a few more
  useEffect(() => {
    if (!busy && next && shown.length < 50 && autoFills.current < 5) {
      autoFills.current++;
      void fetchPage(next, gen.current);
    }
  }, [busy, next, shown.length, fetchPage]);

  const loadOlder = () => { autoFills.current = 0; void fetchPage(next, gen.current); };

  // CSV: every matching event in the period (up to 20,000), not just what is loaded
  const exportCsv = async () => {
    setExporting(true); setErr(null);
    try {
      const all: ApiEvent[] = [];
      let before = '';
      do {
        const p = new URLSearchParams(params);
        p.set('limit', '1000');
        if (before) p.set('before', before);
        const r = await api.get<Page | ApiEvent[]>(`/events?${p}`);
        const page: Page = Array.isArray(r) ? { events: r, next_before: '' } : r;
        all.push(...page.events);
        before = page.next_before;
      } while (before && all.length < 20_000);
      const out = all.map((e) => {
        const c = classify(e);
        return { raw: e, ce: toConsoleEvent(e, hostById), what: (SESSION_TYPES.includes(e.type) ? 'session' : c?.kind ?? 'command') as WhatId };
      }).filter((r) => (what === 'all' || r.what === what) && (!riskyOnly || r.ce.risk === 'risky') && (showRoutine || !routine(r.ce)));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([eventsCsv(out)], { type: 'text/csv' }));
      a.download = 'effigent-events.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setErr(apiErrorText(e)); } finally { setExporting(false); }
  };

  const agents = useMemo(() => [...new Set(['claude-code', 'codex', 'gemini-cli', 'cursor-agent', ...raw.map((e) => e.agent).filter(Boolean)])], [raw]);
  const filtered = result !== 'all' || what !== 'all' || agent || machine || q || riskyOnly;
  const reset = () => { setResult('all'); setWhat('all'); setAgent(''); setMachine(''); setText(''); setRiskyOnly(false); };

  return (
    <>
      <div className="toolbar">
        <div className="chips" role="group" aria-label="Result">
          {RESULTS.map((r) => (
            <button key={r.id} className={`chip ${result === r.id ? 'on' : ''}`} aria-pressed={result === r.id} onClick={() => setResult(r.id)}>{r.label}</button>
          ))}
        </div>
      </div>
      <div className="toolbar">
        <select className="select" style={{ flex: '0 1 190px' }} value={what} onChange={(e) => setWhat(e.target.value as WhatId)} aria-label="What happened">
          {WHAT.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
        </select>
        <select className="select" style={{ flex: '0 1 170px' }} value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
          <option value="">Every agent</option>
          {agents.map((a) => <option key={a} value={a}>{agentMeta(a).label}</option>)}
        </select>
        <select className="select" style={{ flex: '0 1 220px' }} value={machine} onChange={(e) => setMachine(e.target.value)} aria-label="Machine">
          <option value="">Every machine</option>
          {endpointRows.map((m) => <option key={m.id} value={m.id}>{m.hostname}</option>)}
        </select>
        <button className={`chip ${riskyOnly ? 'on' : ''}`} aria-pressed={riskyOnly} onClick={() => setRiskyOnly((v) => !v)} title="Only commands classified as risky (rm, sudo, curl, ssh, git push, npm install…)">
          Risky commands only
        </button>
        <input className="input" style={{ flex: '1 1 220px' }} placeholder="Search commands, files, hosts, rules…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search events" />
        {filtered && <button className="btn sm" onClick={reset}>Clear filters</button>}
      </div>

      <Card>
        <CardHead info={HELP.agentEvents} title="Agent events" sub={
          first ? 'Loading…' : `${shown.length.toLocaleString()} shown${next ? ' · older events available' : ''}${routineHidden ? ` · ${routineHidden} routine command${routineHidden === 1 ? '' : 's'} hidden` : ''}`
        }>
          {routineHidden > 0 || showRoutine ? (
            <button className={`chip ${showRoutine ? 'on' : ''}`} aria-pressed={showRoutine} onClick={() => setShowRoutine((v) => !v)}
              title="Routine commands are read-only housekeeping: ls, cat, grep, git status…">
              {showRoutine ? 'Hide routine commands' : `Show routine commands (${routineHidden})`}
            </button>
          ) : null}
          {(routineHidden > 0 || showRoutine) && <InfoTip align="right" label="About routine commands">{HELP.routine}</InfoTip>}
          <button className="btn sm" onClick={exportCsv} disabled={exporting || first}><Ic n="download" size={14} /> {exporting ? 'Exporting…' : 'Export CSV'}</button>
        </CardHead>
        {err && <div className="callout bad" style={{ margin: '0 20px 14px' }}><Ic n="alert" size={16} /><span>{err}</span></div>}
        {first || !loaded ? <Loading /> : shown.length === 0 ? (
          <Empty icon="search" title={raw.length || filtered ? 'No matching events' : 'No events in this period'}
            sub={routineHidden ? `Only routine commands match — ${routineHidden} hidden. Use “Show routine commands” to see them.` : next ? 'Nothing in the newest events; load older ones below.' : filtered ? 'Try another filter or a longer period.' : 'Enrolled machines report agent activity here.'} />
        ) : (
          <div className="tbl-wrap" style={{ opacity: busy ? 0.7 : 1 }}>
            <table className="tbl">
              <thead><tr><th>Time</th><th>Event</th><th>Agent</th><th>Machine</th><th>Action / target</th><th>Rule</th><th>Result</th></tr></thead>
              <tbody>
                {shown.map(({ ce: e }) => (
                  <tr key={e.id}>
                    <td className="tnum" title={e.at ? dateTime(e.at) : undefined} style={{ whiteSpace: 'nowrap' }}>
                      <span className="cell-main" style={{ display: 'block' }}>{e.time}</span><span className="cell-sub" style={{ display: 'block' }}>{e.ago}</span>
                    </td>
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
        <div className="toolbar" style={{ padding: '12px 20px 16px', borderTop: '1px solid var(--border)' }}>
          <span className="muted" style={{ fontSize: 13 }}>
            {raw.length.toLocaleString()} events read{retention ? ` · events older than ${retention} days are archived (below)` : ''}
          </span>
          <span className="grow" />
          <button className="btn sm" disabled={busy || !next} onClick={loadOlder}>{busy && !first ? 'Loading…' : next ? 'Load older' : 'No older events in this period'}</button>
        </div>
      </Card>
    </>
  );
}
