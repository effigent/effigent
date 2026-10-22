'use client';

import { useCallback, useEffect, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { apiErrorText, type ApiBreakGlassCode, type ApiBreakGlassCreated } from '@/lib/api.ts';
import { dateTime, type EndpointRow } from '@/lib/live-map.ts';
import { Card, CardHead, CodeBlock, Loading, ReadOnlyNote } from '@/components/ui.tsx';

/** Break-glass (CLAUDE.md 2l): while the control plane can't be reached, calls that need
 *  approval are denied. An admin issues a signed code here and reads it to the person at
 *  the machine, who runs `effigentd break-glass <code>`. It is checked offline and lifts
 *  approval lists only (deny rules keep working) until it expires. */

const DURATIONS: [number, string][] = [[30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [480, '8 hours']];

const STATUS_BADGE: Record<ApiBreakGlassCode['status'], string> = { active: 'b-gold', used: 'b-red', expired: 'b-muted', revoked: 'b-muted' };

export function BreakGlass({ machines }: { machines: EndpointRow[] }) {
  const { api, canWrite, me, refresh } = useLive();
  const { dispatch } = useStore();
  const [codes, setCodes] = useState<ApiBreakGlassCode[] | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<ApiBreakGlassCreated | null>(null);

  const load = useCallback(() => {
    api.get<{ codes: ApiBreakGlassCode[] }>('/break-glass').then((v) => setCodes(v.codes)).catch((e) => setErr(apiErrorText(e)));
  }, [api]);
  useEffect(load, [load]);

  const host = (id: string) => (id ? machines.find((m) => m.id === id)?.hostname ?? id : 'All machines');

  const create = async () => {
    const scope = host(endpoint);
    if (!window.confirm(`Issue a break-glass code for ${scope}, valid ${DURATIONS.find(([m]) => m === minutes)?.[1] ?? `${minutes} minutes`}? Approval-required actions there will run without approval once it is used. Your notification emails and webhooks are alerted now and again when it is used.`)) return;
    setBusy(true); setErr(null);
    try {
      setMade(await api.send<ApiBreakGlassCreated>('POST', '/break-glass', { endpoint_id: endpoint, duration_minutes: minutes, reason: reason.trim() }));
      setReason('');
      load();
      void refresh(); // the audit trail has a break_glass.create entry
    } catch (e) {
      setErr(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (c: ApiBreakGlassCode) => {
    if (!window.confirm(`Revoke this code (${host(c.endpoint_id)})? A machine that is offline and already has it can still use it until ${dateTime(Date.parse(c.expiry))}.`)) return;
    try {
      await api.send('DELETE', `/break-glass/${encodeURIComponent(c.id)}`);
      dispatch({ t: 'toast', text: 'Break-glass code revoked' });
      load();
    } catch (e) {
      setErr(apiErrorText(e));
    }
  };

  return (
    <Card>
      <CardHead title="Break-glass" sub="For an outage: when the control plane can't be reached, actions that need approval are denied. A break-glass code lets them run on a machine for a limited time. Deny rules keep working.">
        {me && !canWrite && <ReadOnlyNote what="issue break-glass codes" />}
      </CardHead>
      <div style={{ padding: '0 20px 20px' }}>
        {made ? (
          <>
            <div className="callout warn" style={{ margin: '0 0 8px' }}>
              <Ic n="key" size={16} />
              <span>
                Code issued for {host(made.endpoint_id)} until {dateTime(Date.parse(made.expiry))}. It is shown only once: read it to the person at the machine, who runs the command below.
                {' '}<button className="btn sm" style={{ marginLeft: 6 }} onClick={() => setMade(null)}>Done</button>
              </span>
            </div>
            <CodeBlock code={`effigentd break-glass ${made.code}`} wrap />
          </>
        ) : (
          <div className="form-row" style={{ padding: 0 }}>
            <div className="field" style={{ flex: '1 1 180px' }}>
              <label htmlFor="bg-machine">Machine</label>
              <select id="bg-machine" className="select" value={endpoint} disabled={!canWrite} onChange={(e) => setEndpoint(e.target.value)}>
                <option value="">All machines</option>
                {machines.map((m) => <option key={m.id} value={m.id}>{m.hostname}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '0 1 140px' }}>
              <label htmlFor="bg-dur">Valid for</label>
              <select id="bg-dur" className="select" value={minutes} disabled={!canWrite} onChange={(e) => setMinutes(Number(e.target.value))}>
                {DURATIONS.map(([m, label]) => <option key={m} value={m}>{label}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '2 1 220px' }}>
              <label htmlFor="bg-reason">Reason</label>
              <input id="bg-reason" className="input" placeholder="e.g. control plane outage, INC-1234" value={reason} maxLength={500} disabled={!canWrite} onChange={(e) => setReason(e.target.value)} />
            </div>
            <button className="btn primary" onClick={create} disabled={!canWrite || busy || !reason.trim()}><Ic n="key" /> {busy ? 'Issuing…' : 'Issue code'}</button>
          </div>
        )}
        {err && <div className="callout bad" style={{ margin: '10px 0 0' }}><Ic n="alert" size={16} /><span>{err}</span></div>}
        <div className="muted" style={{ fontSize: 13, margin: '8px 0 0' }}>
          The machine checks the code offline against the key it pinned at enrollment, and each code works once per machine. Every call it lets through is recorded, and use is reported when the machine reconnects.
          A code never changes policy: with policy change approval on, a policy edit still needs a second admin.
        </div>

        <div className="section-label" style={{ margin: '18px 0 6px' }}>Codes</div>
        {!codes ? (!err && <Loading />) : codes.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>No break-glass codes issued.</div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Scope</th><th>Reason</th><th>Issued</th><th>Until</th><th>Status</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {codes.map((c) => (
                  <tr key={c.id}>
                    <td>{host(c.endpoint_id)}</td>
                    <td>{c.reason}</td>
                    <td>{dateTime(Date.parse(c.created_at))}<span className="cell-sub" style={{ display: 'block' }}>by {c.created_by_name || c.created_by}</span></td>
                    <td>{dateTime(Date.parse(c.expiry))}</td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[c.status]}`}>{c.status}</span>
                      {c.used_at && <span className="cell-sub" style={{ display: 'block' }}>on {host(c.used_on)}{c.used_by ? ` by ${c.used_by}` : ''}, {dateTime(Date.parse(c.used_at))}</span>}
                    </td>
                    <td className="right">
                      {canWrite && (c.status === 'active' || c.status === 'used') && Date.parse(c.expiry) > Date.now() && (
                        <button className="btn sm danger" onClick={() => revoke(c)}><Ic n="ban" size={13} /> Revoke</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
