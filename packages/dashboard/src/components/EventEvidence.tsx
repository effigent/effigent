'use client';

import { useEffect, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { ApiError, apiErrorText } from '@/lib/api.ts';
import { ago, ms } from '@/lib/live-map.ts';
import { Card, CardHead } from '@/components/ui.tsx';

interface Verification {
  ok: boolean; batches: number; events: number; archived_batches: number; endpoints: number;
  legacy_events: number; unbatched_events: number; problems: { batch: number; endpoint_id: string; reason: string }[];
  protected_since?: string;
}
interface Archive { day: string; key: string; sha256: string; size: number; batches: number; events: number; legacy_events: number; archived_at: string }
interface Archives { retention_days: number; archive_enabled: boolean; archives: Archive[] }

const mb = (b: number) => (b < 1 << 20 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / (1 << 20)).toFixed(1)} MB`);

/** Tamper check for agent events and the days archived to S3. */
export function EventEvidence() {
  const { api, now, endpointRows } = useLive();
  const [v, setV] = useState<Verification | null>(null);
  const [verr, setVerr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [arch, setArch] = useState<Archives | null>(null);
  const [aerr, setAerr] = useState<string | null>(null);
  const [opening, setOpening] = useState('');

  useEffect(() => {
    api.get<Archives>('/events/archives').then(setArch).catch((e) => setAerr(e instanceof ApiError && e.status === 404 ? null : apiErrorText(e)));
  }, [api]);

  const verify = async () => {
    setChecking(true); setVerr(null);
    try { setV(await api.get<Verification>('/events/verify')); } catch (e) { setVerr(apiErrorText(e)); } finally { setChecking(false); }
  };
  const download = async (day: string) => {
    setOpening(day); setAerr(null);
    try {
      const r = await api.send<{ url: string }>('POST', `/events/archives/${day}/link`);
      window.location.assign(r.url);
    } catch (e) { setAerr(apiErrorText(e)); } finally { setOpening(''); }
  };
  const host = (id: string) => endpointRows.find((e) => e.id === id)?.hostname ?? id.slice(0, 8);

  return (
    <Card>
      <CardHead title="Evidence" sub={`Agent events are append-only and chained per machine, so an edited, removed or inserted event shows up. After ${arch?.retention_days ?? 90} days they move to an archive in S3 (one file per day) and leave the database.`}>
        <button className="btn sm" onClick={verify} disabled={checking}><Ic n="shieldCheck" size={14} /> {checking ? 'Checking…' : 'Verify events'}</button>
      </CardHead>
      {(v || verr) && (
        <div className={`callout ${verr || !v?.ok ? 'bad' : ''}`} style={{ margin: '0 20px 14px' }} role="status">
          <Ic n={verr || !v?.ok ? 'alert' : 'checkCircle'} size={16} />
          <span>
            {verr ?? (v!.ok
              ? <>Intact — {v!.events.toLocaleString()} events in {v!.batches.toLocaleString()} batches from {v!.endpoints} machine{v!.endpoints === 1 ? '' : 's'} recomputed{v!.archived_batches ? `; ${v!.archived_batches} archived batches still link up` : ''}.{v!.legacy_events ? ` ${v!.legacy_events.toLocaleString()} events from before protection started${v!.protected_since ? ` (${new Date(v!.protected_since).toLocaleDateString()})` : ''} aren't covered.` : ''}</>
              : <>
                  {v!.problems.length} problem{v!.problems.length === 1 ? '' : 's'} found:
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {v!.problems.slice(0, 8).map((p, i) => <li key={i}>{p.batch ? <>batch {p.batch} from <b>{host(p.endpoint_id)}</b>: </> : null}{p.reason}</li>)}
                  </ul>
                </>)}
          </span>
        </div>
      )}
      <div style={{ padding: '0 20px 16px' }}>
        <div className="section-label" style={{ margin: '0 0 6px' }}>Archive</div>
        {aerr && <div className="callout bad" style={{ margin: '0 0 10px' }}><Ic n="alert" size={16} /><span>{aerr}</span></div>}
        {!arch ? <div className="muted" style={{ fontSize: 13 }}>—</div>
          : !arch.archive_enabled ? <div className="muted" style={{ fontSize: 13 }}>Archiving isn't set up on this control plane yet, so events are kept in the database and nothing is deleted.</div>
          : arch.archives.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>Nothing archived yet: every event is still in the database (the oldest move out after {arch.retention_days} days).</div>
          : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Day</th><th>Events</th><th>Size</th><th>SHA-256</th><th>Archived</th><th /></tr></thead>
                <tbody>
                  {arch.archives.map((a) => (
                    <tr key={a.day}>
                      <td className="tnum">{a.day}</td>
                      <td className="tnum">{(a.events + a.legacy_events).toLocaleString()}</td>
                      <td className="tnum muted">{mb(a.size)}</td>
                      <td className="mono-sm muted" title={a.sha256}>{a.sha256.slice(0, 16)}…</td>
                      <td className="muted">{ago(ms(a.archived_at), now)}</td>
                      <td><button className="btn sm" disabled={opening === a.day} onClick={() => download(a.day)}><Ic n="download" size={14} /> {opening === a.day ? 'Opening…' : 'Download'}</button></td>
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
