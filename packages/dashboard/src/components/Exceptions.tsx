'use client';

import { HELP } from '@/lib/help.tsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { agentMeta } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { ApiError, apiErrorText } from '@/lib/api.ts';
import { ago } from '@/lib/live-map.ts';
import { Card, CardHead, ReadOnlyNote } from '@/components/ui.tsx';
import { announcePending } from '@/components/PolicyProposals.tsx';
import { useStore } from '@/store.tsx';

interface Exception {
  id: string; endpoints?: string[]; owners?: string[]; teams?: string[]; agents?: string[];
  list: string; value: string; reason?: string; expires_at?: string | null; created_by?: string; created_at: string;
  active: boolean; machines: string[];
}
interface Options { options: { list: string; value: string; agents: string[] }[]; agents: string[]; mode: string }

/** What an exception lets the machine do, in words. */
const VERB: Record<string, string> = {
  exec_deny: 'Run', file_deny: 'Open', domain_deny: 'Reach', network_deny: 'Connect to', file_alert: 'No alert for',
  exec_approve: 'Run without approval', file_approve: 'Open without approval', domain_approve: 'Reach without approval',
  network_approve: 'Connect without approval', command_approve: 'Run without approval', tool_approve: 'Use without approval',
  exec_allow: 'Also run (allowlist)', tool_deny: 'Use tool',
};
const describe = (list: string, value: string) => `${VERB[list] ?? list} ${value}`;

const EXPIRY: [number, string][] = [[1, '1 hour'], [8, '8 hours'], [24, '1 day'], [168, '7 days'], [720, '30 days'], [0, 'never']];

function until(at: string | null | undefined, now: number): string {
  if (!at) return 'no expiry';
  const ms = Date.parse(at) - now;
  if (ms <= 0) return 'expired';
  const h = Math.round(ms / 3_600_000);
  return h < 1 ? 'expires within the hour' : h < 48 ? `expires in ${h} h` : `expires in ${Math.round(h / 24)} days`;
}

/** Per-machine exceptions: lift one company-wide entry (a denied program,
 *  site, file, or an approval) for chosen machines, optionally one agent,
 *  optionally for a while. Each change publishes a new policy version. */
export function Exceptions() {
  const { api, canWrite, endpointRows, now, refresh } = useLive();
  const { dispatch } = useStore();
  const toast = (text: string) => dispatch({ t: 'toast', text });
  const [list, setList] = useState<Exception[] | null>(null);
  const [opts, setOpts] = useState<Options | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [machines, setMachines] = useState<string[]>([]);
  const [agent, setAgent] = useState('');
  const [what, setWhat] = useState('');
  const [allowPath, setAllowPath] = useState('');
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(24);
  const eps = endpointRows.filter((e) => !e.revoked);

  const load = useCallback(async () => {
    try {
      const [l, o] = await Promise.all([api.get<Exception[]>('/exceptions'), api.get<Options>('/exceptions/options')]);
      setList(l); setOpts(o); setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 404 ? 'The control plane does not support exceptions yet — it needs to be updated.' : apiErrorText(e));
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  // the choices: what the policy blocks or asks approval for (for the chosen agent)
  const choices = useMemo(() => (opts?.options ?? []).filter((o) => !agent || o.agents.includes(agent) || o.agents.includes('')), [opts, agent]);
  const [list0, value0] = what === 'exec_allow' ? ['exec_allow', allowPath.trim()] : what.split('\u0000');

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      announcePending(await api.send('POST', '/exceptions', { endpoints: machines, agents: agent ? [agent] : [], list: list0, value: value0, reason, expires_hours: hours }), toast);
      setWhat(''); setAllowPath(''); setReason(''); setMachines([]);
      await load(); void refresh();
    } catch (e) { setErr(apiErrorText(e)); } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setBusy(true); setErr(null);
    try { announcePending(await api.send('DELETE', `/exceptions/${encodeURIComponent(id)}`), toast); await load(); void refresh(); }
    catch (e) { setErr(apiErrorText(e)); } finally { setBusy(false); }
  };

  const who = (x: Exception) => [...(x.endpoints ?? []), ...(x.owners ?? []), ...(x.teams ?? []).map((t) => `team ${t}`)].join(', ');
  return (
    <Card>
      <CardHead info={HELP.exceptions} title="Exceptions" sub="Allow something the company policy blocks — for specific machines, one agent or all, for a while or for good. Each change publishes a new policy version." />
      {err && <div className="callout bad" style={{ margin: '0 20px 14px' }}><Ic n="alert" size={16} /><span>{err}</span></div>}
      <div style={{ padding: '0 20px' }}>
        {list?.length === 0 && <div className="muted" style={{ fontSize: 13, padding: '0 0 10px' }}>No exceptions: every machine gets the company policy.</div>}
        {list?.map((x) => (
          <div key={x.id} className="setting-row" style={{ padding: '8px 0', opacity: x.active ? 1 : 0.55 }}>
            <div style={{ minWidth: 0 }}>
              <div className="setting-title"><span className="mono-sm">{describe(x.list, x.value)}</span> <span className="muted">· {x.agents?.length ? x.agents.map((a) => agentMeta(a).label).join(', ') : 'every agent'}</span></div>
              <div className="setting-desc">
                {who(x)}{x.machines.length > 0 && x.machines.join(', ') !== who(x) ? ` (${x.machines.join(', ')})` : ''} · {until(x.expires_at, now)}
                {x.reason ? ` · “${x.reason}”` : ''} · added {ago(Date.parse(x.created_at), now)}
              </div>
            </div>
            <button className="btn sm" disabled={!canWrite || busy} onClick={() => remove(x.id)}>Remove</button>
          </div>
        ))}
      </div>
      <div style={{ padding: '10px 20px 16px', borderTop: '1px solid var(--border)' }}>
        <div className="section-label" style={{ margin: '0 0 6px' }}>Add an exception</div>
        <div className="muted" style={{ fontSize: 12, margin: '0 0 4px' }}>Machines</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginBottom: 8 }}>
          {eps.length === 0 && <span className="muted" style={{ fontSize: 13 }}>No machines enrolled.</span>}
          {eps.map((e) => (
            <label key={e.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" disabled={!canWrite} checked={machines.includes(e.hostname)}
                onChange={(ev) => setMachines(ev.target.checked ? [...machines, e.hostname] : machines.filter((m) => m !== e.hostname))} />
              {e.hostname}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="select" style={{ flex: '0 1 170px' }} value={agent} disabled={!canWrite} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
            <option value="">Every agent</option>
            {(opts?.agents ?? []).map((a) => <option key={a} value={a}>{agentMeta(a).label}</option>)}
          </select>
          <select className="select" style={{ flex: '1 1 260px' }} value={what} disabled={!canWrite} onChange={(e) => setWhat(e.target.value)} aria-label="What to allow">
            <option value="">Choose what to allow…</option>
            {choices.map((o) => <option key={o.list + o.value} value={`${o.list}\u0000${o.value}`}>{describe(o.list, o.value)}</option>)}
            {opts?.mode === 'allowlist' && <option value="exec_allow">Also run a program (allowlist)…</option>}
          </select>
          {what === 'exec_allow' && <input className="input mono" style={{ flex: '1 1 200px' }} placeholder="/usr/bin/curl" value={allowPath} onChange={(e) => setAllowPath(e.target.value)} aria-label="Program path" />}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <input className="input" style={{ flex: '1 1 240px' }} placeholder="Why (kept in the audit trail)" value={reason} disabled={!canWrite} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
          <select className="select" style={{ flex: '0 1 130px' }} value={hours} disabled={!canWrite} onChange={(e) => setHours(Number(e.target.value))} aria-label="Expires after">
            {EXPIRY.map(([h, l]) => <option key={h} value={h}>{h ? `for ${l}` : 'no expiry'}</option>)}
          </select>
          <button className="btn primary sm" disabled={!canWrite || busy || machines.length === 0 || !what || (what === 'exec_allow' && !allowPath.trim())} onClick={create}>
            <Ic n="check" /> Add exception
          </button>
        </div>
        {!canWrite && <div style={{ marginTop: 8 }}><ReadOnlyNote what="add exceptions" /></div>}
      </div>
    </Card>
  );
}
