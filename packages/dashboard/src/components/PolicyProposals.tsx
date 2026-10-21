'use client';

import { useCallback, useEffect, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { ApiError, apiErrorText, isPending, type ApiPending, type ApiProposal } from '@/lib/api.ts';
import { ago } from '@/lib/live-map.ts';
import { PolicyDiff } from '@/components/PolicyDiff.tsx';
import { Card, CardHead } from '@/components/ui.tsx';
import { HELP } from '@/lib/help.tsx';

/** Fired after a write came back 202 (filed as a proposal), so the list reloads. */
export const PROPOSALS_CHANGED = 'effigent:proposals';

/** After a write: a 202 means it waits for a second admin. Returns true then. */
export function announcePending(r: unknown, toast: (text: string) => void): r is ApiPending {
  if (!isPending(r)) return false;
  toast(r.message || 'Filed for approval — another admin has to approve it before it is published');
  window.dispatchEvent(new Event(PROPOSALS_CHANGED));
  return true;
}

const KIND: Record<ApiProposal['kind'], string> = {
  policy: 'Policy', 'exception.create': 'New exception', 'exception.delete': 'Remove exception',
  'endpoint.owner': 'Machine owner', settings: 'Settings',
};

function ProposalRow({ p, now, onDone }: { p: ApiProposal; now: number; onDone: () => void }) {
  const { api, me, refresh } = useLive();
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const body = typeof p.payload?.body === 'string' ? (p.payload.body as string) : null;
  const mine = me?.user_id === p.author;

  const act = async (decision: 'approve' | 'reject' | 'withdraw') => {
    setBusy(true); setErr(null);
    try {
      if (decision === 'withdraw') await api.send('DELETE', `/policy/proposals/${encodeURIComponent(p.id)}`);
      else await api.send('POST', `/policy/proposals/${encodeURIComponent(p.id)}/decision`, { decision, note: note.trim() });
      dispatch({ t: 'toast', text: decision === 'approve' ? `Approved — ${p.summary}` : decision === 'reject' ? 'Proposal rejected' : 'Proposal withdrawn' });
      onDone(); void refresh();
    } catch (e) {
      setErr(apiErrorText(e));
      if (e instanceof ApiError && e.status === 409) onDone(); // superseded or already decided: show where it stands
    } finally { setBusy(false); }
  };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="badge b-gold">{KIND[p.kind] ?? p.kind}</span>
        <b style={{ flex: '1 1 260px' }}>{p.summary}</b>
        <span className="muted" style={{ fontSize: 13 }}>by {p.author_name || p.author}{p.author_via === 'api-key' ? ' (API key)' : ''} · {ago(Date.parse(p.created_at), now)}</span>
        {body !== null && <button className="btn sm" onClick={() => setOpen((v) => !v)}><Ic n="layers" size={14} /> {open ? 'Hide changes' : 'Show changes'}</button>}
      </div>
      {p.stale && <div className="callout warn" style={{ margin: '10px 0 0' }}><Ic n="alert" size={14} /><span>Written on v{p.base_version}; a newer version has been published since. Approving it marks it superseded — the author proposes again on the current version.</span></div>}
      {open && body !== null && (
        <div style={{ marginTop: 10 }}>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>Left: v{p.base_version || 0}{p.base ? ` — ${p.base.comment || 'no comment'}` : ' (built-in default)'} · right: the proposal</div>
          <PolicyDiff left={p.base?.body ?? ''} right={body} readOnlyRight onlyChanges height={420} />
        </div>
      )}
      {err && <div className="callout bad" style={{ margin: '10px 0 0' }}><Ic n="alert" size={14} /><span>{err}</span></div>}
      <div className="toolbar" style={{ marginTop: 10 }}>
        {p.can_decide ? <>
          <input className="input" style={{ flex: '1 1 240px' }} placeholder="Note (optional, kept in the audit trail)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
          <button className="btn primary sm" disabled={busy} onClick={() => act('approve')}><Ic n="check" size={14} /> Approve & publish</button>
          <button className="btn sm" disabled={busy} onClick={() => act('reject')}><Ic n="x" size={14} /> Reject</button>
        </> : <span className="muted" style={{ fontSize: 13 }}>{p.why || 'Waiting for another admin or security admin.'}</span>}
        <span className="grow" />
        {mine && <button className="btn sm" disabled={busy} onClick={() => act('withdraw')}><Ic n="rotate" size={14} /> Withdraw</button>}
      </div>
    </div>
  );
}

/** Policy changes waiting for a second admin (policy change approval on). */
export function PolicyProposals() {
  const { api, now } = useLive();
  const [list, setList] = useState<ApiProposal[] | null>(null);
  const [on, setOn] = useState<boolean | null>(null);

  const load = useCallback(() => {
    api.get<ApiProposal[]>('/policy/proposals?state=pending').then(setList).catch(() => setList(null));
    api.get<{ policy_change_approval: boolean }>('/policy/settings').then((s) => setOn(s.policy_change_approval)).catch(() => setOn(null));
  }, [api]);
  useEffect(() => {
    load();
    window.addEventListener(PROPOSALS_CHANGED, load);
    const id = setInterval(() => { if (!document.hidden) load(); }, 20_000);
    return () => { window.removeEventListener(PROPOSALS_CHANGED, load); clearInterval(id); };
  }, [load]);

  if (!list || (list.length === 0 && !on)) return null;
  return (
    <Card>
      <CardHead info={HELP.changeApproval} title={<>Waiting for approval {list.length > 0 && <span className="badge b-gold" style={{ marginLeft: 8 }}>{list.length}</span>}</>}
        sub="Policy change approval is on: changes are published once another admin or security admin approves them." />
      <div style={{ padding: '0 20px 10px' }}>
        {list.length === 0 ? <div className="muted" style={{ fontSize: 13, paddingBottom: 8 }}>Nothing waiting.</div>
          : list.map((p) => <ProposalRow key={p.id} p={p} now={now} onDone={load} />)}
      </div>
    </Card>
  );
}
