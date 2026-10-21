'use client';

import { useEffect, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { ApiError, apiErrorText, type ApiEventRetention } from '@/lib/api.ts';
import { ago } from '@/lib/live-map.ts';
import { Card, CardHead, ReadOnlyNote, Switch } from '@/components/ui.tsx';
import { HELP } from '@/lib/help.tsx';

const CHOICES = [0, 90, 180, 365, 730, 1095, 2555];
const days = (d: number) => (d % 365 === 0 ? `${d / 365} year${d === 365 ? '' : 's'}` : `${d} days`);

const SYNC: Record<ApiEventRetention['hold_sync']['state'], string> = {
  none: '', no_archive: 'No archive bucket on this control plane: nothing is ever deleted, so the hold only needs the database.',
  pending: 'Applying the hold to the archive objects…', error: 'The archive objects could not be updated yet; retried every few minutes.',
  done: '',
};

/** Settings → Storage: how long agent events stay in the database, and the legal hold. Admins only. */
export function EventRetention() {
  const { api, canWrite, now } = useLive();
  const [v, setV] = useState<ApiEventRetention | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => api.get<ApiEventRetention>('/events/retention').then((r) => { if (live) setV(r); })
      .catch((e) => { if (live) setMsg({ ok: false, text: e instanceof ApiError && e.status === 404 ? 'The control plane does not support retention settings yet — it needs to be updated.' : apiErrorText(e) }); });
    void load();
    const id = setInterval(() => { if (!document.hidden) void load(); }, 15_000); // the archive sync runs in the background
    return () => { live = false; clearInterval(id); };
  }, [api]);

  const save = async (body: Partial<{ retention_days: number; legal_hold: boolean; hold_reason: string }>, done: string) => {
    setBusy(true); setMsg(null);
    try {
      setV(await api.send<ApiEventRetention>('PUT', '/events/retention', body));
      setMsg({ ok: true, text: done }); setReason('');
    } catch (e) { setMsg({ ok: false, text: apiErrorText(e) }); } finally { setBusy(false); }
  };

  const ro = !canWrite;
  const sync = v?.hold_sync;
  return (
    <Card>
      <CardHead info={HELP.retention} title="Event retention & legal hold"
        sub="Agent events stay in the database for this long, then move to the archive (S3, one file per day) and leave the database. Downloads of archived days are in Audit." />
      {!v ? (msg && <div className="callout bad" style={{ margin: '0 20px 14px' }}><Ic n="alert" size={16} /><span>{msg.text}</span></div>) : <>
        <div className="setting-row">
          <div>
            <div className="setting-title">Keep events in the database</div>
            <div className="setting-desc">At least {v.min_days} days. Default on this control plane: {days(v.default_days)}{v.archive_enabled ? '' : ' (no archive bucket: nothing is deleted at all)'}.</div>
          </div>
          <select className="select" style={{ width: 170 }} value={v.retention_override} disabled={ro || busy} aria-label="Retention"
            onChange={(e) => { const d = Number(e.target.value); void save({ retention_days: d }, d ? `Events now stay ${days(d)}.` : 'Back to the default.'); }}>
            {[...new Set([...CHOICES, v.retention_override])].sort((a, b) => a - b).map((d) => <option key={d} value={d}>{d ? days(d) : `Default (${days(v.default_days)})`}</option>)}
          </select>
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-title">Legal hold {v.legal_hold && <span className="badge b-red" style={{ marginLeft: 6 }}>On</span>}</div>
            <div className="setting-desc">
              {v.legal_hold
                ? <>Since {v.hold_set_at ? ago(Date.parse(v.hold_set_at), now) : '—'} by <span className="mono-sm">{v.hold_set_by || '—'}</span> · <b>{v.hold_reason}</b>. No event is deleted and every archive object carries an S3 legal hold until it is released.</>
                : <>Keeps every event and archive object of this workspace until released — for litigation or an investigation. Retention pauses meanwhile.</>}
            </div>
          </div>
          <Switch on={v.legal_hold} label="Legal hold" onChange={(on) => {
            if (ro || busy) return;
            if (on && !reason.trim()) { setMsg({ ok: false, text: 'Give the reason first (the matter or ticket), then turn the hold on.' }); return; }
            if (!on && !window.confirm('Release the legal hold? Retention resumes and events older than the retention period are archived and deleted from the database.')) return;
            void save(on ? { legal_hold: true, hold_reason: reason.trim() } : { legal_hold: false }, on ? 'Legal hold on.' : 'Legal hold released.');
          }} />
        </div>
        {!v.legal_hold && !ro && (
          <div style={{ padding: '0 20px 14px' }}>
            <input className="input" style={{ width: '100%' }} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
              placeholder="Reason for a hold, e.g. Matter 2026-17 or LEGAL-88 (required to turn it on)" aria-label="Legal hold reason" />
          </div>
        )}
        {sync && SYNC[sync.state] && (
          <div className={`callout ${sync.state === 'error' ? 'bad' : ''}`} style={{ margin: '0 20px 14px' }}><Ic n={sync.state === 'error' ? 'alert' : 'clock'} size={16} />
            <span>{SYNC[sync.state]}{sync.state === 'error' && sync.error ? <> <code>{sync.error}</code></> : null}</span></div>
        )}
        {sync?.state === 'done' && v.archive_enabled && sync.synced_at && (
          <div className="muted" style={{ padding: '0 20px 14px', fontSize: 13 }}>
            Archive: {sync.objects} object version{sync.objects === 1 ? '' : 's'} {v.legal_hold ? 'on hold' : 'released'} · {ago(Date.parse(sync.synced_at), now)}
          </div>
        )}
        {msg && <div className={`callout ${msg.ok ? '' : 'bad'}`} style={{ margin: '0 20px 14px' }}><Ic n={msg.ok ? 'checkCircle' : 'alert'} size={16} /><span>{msg.text}</span></div>}
        {ro && <div style={{ padding: '0 20px 14px' }}><ReadOnlyNote what="change retention or the legal hold" /></div>}
      </>}
    </Card>
  );
}
