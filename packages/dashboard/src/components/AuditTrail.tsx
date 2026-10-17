'use client';

import { useEffect, useMemo, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { apiErrorText, type ApiAuditEntry, type ApiAuditVerification } from '@/lib/api.ts';
import { ago, ms } from '@/lib/live-map.ts';
import { Card, CardHead, Empty, Loading } from '@/components/ui.tsx';

export const ACTION_LABEL: Record<string, string> = {
  'policy.publish': 'Published policy',
  'policy.assist': 'Asked the policy assistant',
  'endpoint.enroll': 'Machine enrolled',
  'endpoint.revoke': 'Revoked a machine',
  'endpoint.owner': 'Changed a machine’s owner',
  'enrollment_token.create': 'Created an enrollment token',
  'approval.request': 'Agent asked for approval',
  'approval.approve': 'Approved a request',
  'approval.deny': 'Denied a request',
  'notifications.update': 'Changed approval notifications',
  'api_key.create': 'Created an API key',
  'api_key.revoke': 'Revoked an API key',
  'webhook.create': 'Added a webhook',
  'webhook.delete': 'Deleted a webhook',
  'webhook.test': 'Sent a webhook test',
  'exception.create': 'Added a policy exception',
  'exception.delete': 'Removed a policy exception',
  'exception.expire': 'A policy exception expired',
};
export const actionLabel = (a: string) => ACTION_LABEL[a] ?? (a.startsWith('denied.') ? `Denied: ${a.slice(7)}` : a);

/** Filter choices → the API's comma-separated action prefixes / actor kinds. */
const CATEGORIES = [
  { id: '', label: 'All actions' },
  { id: 'policy.', label: 'Policy' },
  { id: 'exception.', label: 'Exceptions' },
  { id: 'approval.', label: 'Approvals' },
  { id: 'endpoint.,enrollment_token.', label: 'Machines & enrollment' },
  { id: 'api_key.,webhook.,notifications.', label: 'Integrations & notifications' },
  { id: 'denied.', label: 'Denied attempts' },
];
const ACTORS = [
  { id: '', label: 'Anyone' },
  { id: 'clerk,admin-token', label: 'People' },
  { id: 'api-key', label: 'API keys' },
  { id: 'endpoint,enrollment-token', label: 'Machines' },
  { id: 'approval-link', label: 'Slack / email buttons' },
  { id: 'system', label: 'Effigent (automatic)' },
];
const PERIODS = [
  { id: '24h', label: 'Last 24 hours', ms: 86_400_000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 86_400_000 },
  { id: '90d', label: 'Last 90 days', ms: 90 * 86_400_000 },
  { id: 'all', label: 'All time', ms: 0 },
];
const SIZES = [25, 50, 100];

interface Page { entries: ApiAuditEntry[]; total: number; next_before: number }

/** "Oct 17, 7:00:51 PM" (the year only when it isn't this one). */
function when(at: number | null): string {
  if (at === null) return '—';
  const d = new Date(at);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });
}

function details(d: Record<string, unknown> | null): string {
  const parts = Object.entries(d ?? {}).filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return parts.length ? parts.join(' · ') : '—';
}

const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
function trailCsv(rows: ApiAuditEntry[]): string {
  const head = ['seq', 'at', 'actor', 'actor_role', 'actor_via', 'action', 'target', 'details', 'ip', 'prev_hash', 'hash'];
  return [head.join(','), ...rows.map((a) => [
    a.seq, a.at, a.actor, a.actor_role, a.actor_via, a.action, a.target, a.details ? JSON.stringify(a.details) : '', a.ip, a.prev_hash, a.hash,
  ].map(esc).join(','))].join('\n');
}

/** The console audit trail, read from the server one page at a time with the
 *  filters applied there (it can hold far more entries than the page fetches). */
export function AuditTrail({ initialPeriod = 'all' }: { initialPeriod?: string }) {
  const { api, me, endpointRows, now } = useLive();
  const [category, setCategory] = useState('');
  const [actorKind, setActorKind] = useState('');
  const [period, setPeriod] = useState(PERIODS.some((p) => p.id === initialPeriod) ? initialPeriod : 'all');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [size, setSize] = useState(50);
  const [cursors, setCursors] = useState<number[]>([0]); // the `before` of every page up to the current one
  const [page, setPage] = useState<Page | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyNames, setKeyNames] = useState<Map<string, string>>(new Map());
  const [verify, setVerify] = useState<ApiAuditVerification | null>(null);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  // any filter change starts again from the newest entry
  useEffect(() => { setCursors([0]); }, [category, actorKind, period, q, size]);

  const query = useMemo(() => {
    const p = new URLSearchParams({ paged: '1' });
    if (category) p.set('action', category);
    if (actorKind) p.set('via', actorKind);
    if (q) p.set('q', q);
    const span = PERIODS.find((x) => x.id === period)?.ms;
    if (span) p.set('since', new Date(Date.now() - span).toISOString().replace(/\.\d+Z$/, 'Z'));
    return p;
  }, [category, actorKind, period, q]);
  const before = cursors[cursors.length - 1];

  useEffect(() => {
    let live = true;
    const p = new URLSearchParams(query);
    p.set('limit', String(size));
    if (before) p.set('before', String(before));
    setBusy(true);
    api.get<Page | ApiAuditEntry[]>(`/audit?${p}`)
      .then((r) => { if (live) { setPage(Array.isArray(r) ? { entries: r, total: r.length, next_before: 0 } : r); setErr(null); } })
      .catch((e) => { if (live) setErr(apiErrorText(e)); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [api, query, size, before]);

  // names for API-key actors (people-only endpoint; key holders just see ids)
  useEffect(() => {
    api.get<{ id: string; name: string }[]>('/api-keys')
      .then((ks) => setKeyNames(new Map(ks.map((k) => [k.id, k.name]))))
      .catch(() => {});
  }, [api]);

  const actor = (a: ApiAuditEntry): [string, string] => {
    const kind = a.actor_via === 'approval-link' ? 'Slack / email button' : a.actor_role || a.actor_via;
    if (me && a.actor === me.user_id) return ['You', `${kind} · ${a.actor_via}`];
    if (a.actor.startsWith('apikey:')) {
      const name = keyNames.get(a.actor.slice(7));
      return [name ? `API key “${name}”` : a.actor, 'API key'];
    }
    if (a.actor.startsWith('endpoint:')) {
      const host = endpointRows.find((e) => e.id === a.actor.slice(9))?.hostname;
      return [host ?? a.actor, 'machine'];
    }
    if (a.actor.startsWith('link:')) return [a.actor.split(':').slice(2).join(':') || a.actor, `${a.actor.split(':')[1]} button`];
    if (a.actor === 'system') return ['Effigent', 'automatic'];
    return [a.actor, `${kind} · ${a.actor_via}`];
  };

  const runVerify = async () => {
    setVerifying(true); setVerifyErr(null);
    try { setVerify(await api.get<ApiAuditVerification>('/audit/verify')); } catch (e) { setVerifyErr(apiErrorText(e)); } finally { setVerifying(false); }
  };

  // every entry matching the filters, not just this page (max 10,000)
  const exportCsv = async () => {
    setExporting(true); setErr(null);
    try {
      const rows: ApiAuditEntry[] = [];
      let cur = 0;
      do {
        const p = new URLSearchParams(query);
        p.set('limit', '500');
        if (cur) p.set('before', String(cur));
        const r = await api.get<Page>(`/audit?${p}`);
        rows.push(...r.entries);
        cur = r.next_before;
      } while (cur && rows.length < 10_000);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([trailCsv(rows)], { type: 'text/csv' }));
      a.download = 'effigent-audit-trail.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setErr(apiErrorText(e)); } finally { setExporting(false); }
  };

  const filtered = !!(category || actorKind || q || period !== 'all');
  const entries = page?.entries ?? [];
  const from = (cursors.length - 1) * size + 1;
  const reset = () => { setCategory(''); setActorKind(''); setPeriod('all'); setText(''); };

  return (
    <Card>
      <CardHead title="Console audit trail" sub="Append-only and hash-chained per workspace: each entry commits to the one before it, so edits or deletions break the chain.">
        <button className="btn sm" onClick={exportCsv} disabled={exporting || !page?.total}><Ic n="download" size={14} /> {exporting ? 'Exporting…' : 'Export CSV'}</button>
        <button className="btn sm" onClick={runVerify} disabled={verifying}><Ic n="shieldCheck" size={14} /> {verifying ? 'Verifying…' : 'Verify chain'}</button>
      </CardHead>
      {(verify || verifyErr) && (
        <div className={`callout ${verifyErr || !verify?.ok ? 'bad' : ''}`} style={{ margin: '0 20px 14px' }} role="status">
          <Ic n={verifyErr || !verify?.ok ? 'alert' : 'checkCircle'} size={16} />
          <span>
            {verifyErr ?? (verify!.ok
              ? <>Hash chain intact — {verify!.entries} entr{verify!.entries === 1 ? 'y' : 'ies'}{verify!.head && <> · head <code>{verify!.head.slice(0, 16)}…</code></>}</>
              : <>Chain broken at entry #{verify!.broken_at}: {verify!.reason}. Entries from that point may have been altered.</>)}
          </span>
        </div>
      )}

      <div className="toolbar" style={{ padding: '0 20px 14px' }}>
        <select className="select" style={{ flex: '0 1 230px' }} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Action">
          {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <select className="select" style={{ flex: '0 1 200px' }} value={actorKind} onChange={(e) => setActorKind(e.target.value)} aria-label="Who">
          {ACTORS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <select className="select" style={{ flex: '0 1 160px' }} value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period">
          {PERIODS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <input className="input" style={{ flex: '1 1 220px' }} placeholder="Search target, actor, details, IP…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search the audit trail" />
        {filtered && <button className="btn sm" onClick={reset}>Clear filters</button>}
      </div>

      {err && <div className="callout bad" style={{ margin: '0 20px 14px' }}><Ic n="alert" size={16} /><span>{err}</span></div>}
      {!page ? (err ? null : <Loading />) : entries.length === 0 ? (
        <Empty icon="clipboard" title={filtered ? 'No matching entries' : 'No console changes yet'}
          sub={filtered ? 'Try another filter or a longer period.' : 'Policy publishes, approvals, exceptions, machine changes and denied attempts are recorded here.'} />
      ) : (
        <>
          <div className="tbl-wrap" style={{ opacity: busy ? 0.6 : 1, transition: 'opacity .15s' }}>
            <table className="tbl">
              <thead><tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr></thead>
              <tbody>
                {entries.map((a) => {
                  const [who, sub] = actor(a);
                  return (
                    <tr key={a.seq}>
                      <td className="tnum muted">{a.seq}</td>
                      <td className="tnum" title={new Date(a.at).toISOString()} style={{ whiteSpace: 'nowrap' }}>
                        <span className="cell-main" style={{ display: 'block' }}>{when(ms(a.at))}</span>
                        <span className="cell-sub" style={{ display: 'block' }}>{ago(ms(a.at), now)}</span>
                      </td>
                      <td style={{ maxWidth: 240 }}>
                        <span className="cell-main mono-sm" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.actor}>{who}</span>
                        <span className="cell-sub" style={{ display: 'block' }}>{sub}</span>
                      </td>
                      <td>{a.action.startsWith('denied.') ? <span className="badge b-red">{actionLabel(a.action)}</span> : <span className="cell-main">{actionLabel(a.action)}</span>}</td>
                      <td className="mono-sm" style={{ whiteSpace: 'nowrap' }}>{a.target || '—'}</td>
                      <td className="muted" style={{ maxWidth: 360, fontSize: 12.5 }}>{details(a.details)}</td>
                      <td className="mono-sm muted">{a.ip || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="toolbar" style={{ padding: '12px 20px 16px', borderTop: '1px solid var(--border)' }}>
            <span className="muted" style={{ fontSize: 13 }}>
              {from}–{from + entries.length - 1} of {page.total.toLocaleString()} entr{page.total === 1 ? 'y' : 'ies'}{filtered ? ' matching' : ''}
            </span>
            <span className="grow" />
            <label className="muted" style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              Rows
              <select className="select" style={{ width: 84 }} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Rows per page">
                {SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button className="btn sm" disabled={busy || cursors.length === 1} onClick={() => setCursors([0])}>Newest</button>
            <button className="btn sm" disabled={busy || cursors.length === 1} onClick={() => setCursors(cursors.slice(0, -1))}>← Newer</button>
            <button className="btn sm" disabled={busy || !page.next_before} onClick={() => setCursors([...cursors, page.next_before])}>Older →</button>
          </div>
        </>
      )}
    </Card>
  );
}
