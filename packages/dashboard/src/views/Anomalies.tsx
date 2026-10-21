'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { ApiError, apiErrorText } from '@/lib/api.ts';
import type { ApiAnomalies, ApiAnomaly, ApiAnomalyKind } from '@/lib/api-inventory.ts';
import { AgentCell, Card, CardHead, Empty, InfoTip, Loading, PageGuide, PageHead, Seg } from '@/components/ui.tsx';
import { ago } from '@/views/Inventory.tsx';

const KIND: Record<ApiAnomalyKind, { label: string; one: string; badge: string }> = {
  binary: { label: 'Programs', one: 'program', badge: 'b-orange' },
  host: { label: 'Hosts', one: 'host', badge: 'b-blue' },
  mcp: { label: 'MCP servers', one: 'MCP server', badge: 'b-gold' },
  action: { label: 'Action kinds', one: 'action', badge: 'b-red' },
};
const EVENT: Record<string, string> = {
  exec: 'ran', connect: 'connected', file_open: 'opened a file', blocked: 'blocked', would_block: 'would have been blocked',
  approval_pending: 'paused for approval', approved: 'approved', approval_denied: 'denied',
};
const SINCE = [{ id: '1', label: '24 h' }, { id: '7', label: '7 days' }, { id: '30', label: '30 days' }, { id: '180', label: 'All' }] as const;

/** New behaviour: the first time an agent on a machine ran a program, reached a
 *  host, used an MCP server or hit an action kind (against a 30-day baseline). */
export function Anomalies({ initialKind, initialEndpoint }: { initialKind?: string; initialEndpoint?: string }) {
  const { api } = useLive();
  const [kind, setKind] = useState<'all' | ApiAnomalyKind>(initialKind === 'binary' || initialKind === 'host' || initialKind === 'mcp' || initialKind === 'action' ? initialKind : 'all');
  const [endpoint, setEndpoint] = useState(initialEndpoint ?? '');
  const [agent, setAgent] = useState('');
  const [since, setSince] = useState<(typeof SINCE)[number]['id']>('30');
  const [q, setQ] = useState('');
  const [data, setData] = useState<ApiAnomalies | null>(null);
  const [rows, setRows] = useState<ApiAnomaly[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [more, setMore] = useState(false);

  const query = useCallback((before = '') => {
    const p = new URLSearchParams({ limit: '100', since: new Date(Date.now() - Number(since) * 86_400_000).toISOString() });
    if (kind !== 'all') p.set('kind', kind);
    if (endpoint) p.set('endpoint', endpoint);
    if (agent) p.set('agent', agent);
    if (q.trim()) p.set('q', q.trim());
    if (before) p.set('before', before);
    return `/anomalies?${p}`;
  }, [kind, endpoint, agent, since, q]);
  const load = useCallback(() => api.get<ApiAnomalies>(query())
    .then((d) => { setData(d); setRows(d.anomalies); setErr(null); })
    .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? 'The control plane does not record new behaviour yet — it needs to be updated.' : apiErrorText(e))), [api, query]);
  useEffect(() => { const t = setTimeout(() => void load(), 200); return () => clearTimeout(t); }, [load]);
  const loadMore = async () => {
    if (!data?.next_before) return;
    setMore(true);
    try {
      const d = await api.get<ApiAnomalies>(query(data.next_before));
      setRows((r) => [...r, ...d.anomalies]);
      setData(d);
    } catch (e) { setErr(apiErrorText(e)); } finally { setMore(false); }
  };

  const hosts = [...new Map(rows.map((r) => [r.endpoint_id, r.hostname])).entries()];
  const agents = [...new Set(rows.map((r) => r.agent))].sort();
  const stats = data?.baselines ?? [];
  const atCap = stats.reduce((n, s) => n + s.keys_at_cap, 0);
  const suppressed = stats.reduce((n, s) => n + s.suppressed, 0);

  return (
    <div className="page">
      <PageHead title="New behaviour" sub="The first time an agent on a machine ran a program, reached a host, used an MCP server or hit a risky action kind — or did again after 30 days without it.">
        <input className="input" style={{ width: 220 }} placeholder="Search values, machines…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search new behaviour" />
        <Seg value={since} onChange={setSince} options={SINCE.map((s) => ({ id: s.id, label: s.label }))} />
      </PageHead>
      <PageGuide id="anomalies" steps={[
        <>Each row is new for <b>that agent on that machine</b>: open the machine’s activity to see what came before it</>,
        <>Expected? Nothing to do — it is part of the baseline now. Not expected? Add a deny or approval rule on <Link href="/policies" className="view-all">Policies</Link></>,
        <>To get these in your SIEM or chat, subscribe a webhook to <code>anomaly.first_seen</code> (Settings → Integrations)</>,
      ]} />
      <div className="callout"><Ic n="eye" size={16} /><span>
        This is <b>novelty detection</b>, not prompt-injection detection: it tells you an agent did something it hadn’t done on that machine before, not why.
        A new agent on a machine is learned for {data?.warmup_days ?? 7} days before it signals.
      </span></div>
      {err && <div className="callout bad"><Ic n="alert" size={16} /><span>{err}</span></div>}

      <Card>
        <CardHead title="First seen" sub={data ? `${rows.length}${data.next_before ? '+' : ''} signals${endpoint ? ` on ${hosts.find(([id]) => id === endpoint)?.[1] ?? endpoint}` : ''}` : undefined}
          info={data && <>Per machine and agent, effigentd keeps up to {Object.entries(data.caps).map(([k, n]) => `${n.toLocaleString('en-US')} ${KIND[k as ApiAnomalyKind]?.label.toLowerCase() ?? k}`).join(', ')}; past that it stops learning that kind there. At most {data.daily_signal_cap} signals per machine, agent and kind a day; signals are kept 180 days. Programs from hooks are command names (<code>curl</code>), from the kernel full paths (<code>/usr/bin/curl</code>).</>}>
          <Seg value={kind} onChange={setKind} options={[{ id: 'all', label: 'All' }, ...(['binary', 'host', 'mcp', 'action'] as const).map((k) => ({ id: k, label: KIND[k].label }))]} />
          <select className="select" value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
            <option value="">All agents</option>
            {agents.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          {endpoint && <button className="btn sm" onClick={() => setEndpoint('')}><Ic n="x" size={12} /> All machines</button>}
        </CardHead>
        {!data ? (!err && <Loading />) : rows.length === 0 ? (
          <Empty icon="checkCircle" title="Nothing new" sub={stats.length ? 'Every agent stayed within what it had done before on its machine.' : 'Baselines build up as enrolled machines send events. New agents are learned for 7 days before they signal.'} />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>When</th><th>What</th><th>Agent</th><th>Machine</th><th>Person</th><th>How it showed</th></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td className="mono-sm" title={new Date(a.seen_at).toLocaleString()}>{ago(a.seen_at)}</td>
                    <td><span className={`badge ${KIND[a.kind]?.badge ?? 'b-muted'}`}>{KIND[a.kind]?.one ?? a.kind}</span> <span className="mono-name">{a.value}</span>
                      {a.prev_last_at && <div className="muted" style={{ fontSize: 12 }}>last seen {ago(a.prev_last_at)}</div>}</td>
                    <td><AgentCell type={a.agent} /></td>
                    <td><button className="link" style={{ background: 'none', border: 0, padding: 0 }} onClick={() => setEndpoint(a.endpoint_id)} title="Only this machine">{a.hostname}</button></td>
                    <td className="mono-sm">{a.person || a.owner || '—'}</td>
                    <td className="mono-sm"><Link className="link" href={`/audit?q=${encodeURIComponent(a.value.split('@')[0])}`} title="Find the events in Activity & Audit">{EVENT[a.event_type] ?? a.event_type}</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data?.next_before && <div style={{ padding: 12 }}><button className="btn sm" disabled={more} onClick={() => void loadMore()}>{more ? 'Loading…' : 'Load more'}</button></div>}
      </Card>

      {stats.length > 0 && (
        <Card>
          <CardHead title="Baselines" sub="What effigentd has learned per machine and agent." info={<>A baseline at its cap stops learning new values of that kind (and stops signalling them) until old values age out. Suppressed: signals over the daily cap, counted but not listed.</>} />
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Kind</th><th className="right">Machine + agent pairs</th><th className="right">Values kept</th><th className="right">At the cap</th><th className="right">Not kept (cap)</th><th className="right">Signals suppressed</th></tr></thead>
              <tbody>{stats.map((s) => (
                <tr key={s.kind}><td>{KIND[s.kind]?.label ?? s.kind}</td><td className="right tnum">{s.keys}</td><td className="right tnum">{s.values.toLocaleString('en-US')}</td>
                  <td className="right tnum">{s.keys_at_cap}</td><td className="right tnum">{s.overflow.toLocaleString('en-US')}</td><td className="right tnum">{s.suppressed}</td></tr>
              ))}</tbody>
            </table>
          </div>
          {(atCap > 0 || suppressed > 0) && <div className="foot-note" style={{ padding: '0 16px 12px' }}><InfoTip>Caps keep the baseline bounded on busy machines.</InfoTip> {atCap} baselines at their cap, {suppressed} signals suppressed.</div>}
        </Card>
      )}
    </div>
  );
}
