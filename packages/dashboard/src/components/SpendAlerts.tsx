'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { HELP } from '@/lib/help.tsx';
import { ApiError, apiErrorText, type ApiSpendAlert, type ApiSpendAlerts } from '@/lib/api.ts';
import { Card, CardHead, Empty, Loading, Switch } from '@/components/ui.tsx';

const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Where an alert went: notify_result is channel -> "sent" | "error: …" | "off…". */
function Channels({ a }: { a: ApiSpendAlert }) {
  const r = a.notify_result ?? {};
  if (r.alerts === 'off') return <span className="muted">not sent (alerts off)</span>;
  const parts = Object.entries(r).map(([ch, res]) => (
    <span key={ch} className={`badge ${res === 'sent' ? 'b-green' : res.startsWith('error') ? 'b-red' : 'b-muted'}`} title={res} style={{ marginRight: 4 }}>
      {ch}{res === 'sent' ? '' : res.startsWith('error') ? ' failed' : ' off'}
    </span>
  ));
  return parts.length ? <>{parts}</> : <span className="muted" title="Webhooks subscribed to the event still got it">no email or Slack recipients</span>;
}

/** Pricing Leaks → Alerts: runaway cost is announced as it appears (webhook event, email, Slack). */
export function SpendAlerts({ ro }: { ro: boolean }) {
  const { api } = useLive();
  const { dispatch } = useStore();
  const [data, setData] = useState<ApiSpendAlerts | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [emails, setEmails] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get<ApiSpendAlerts>('/pricing-leaks/alerts?limit=20')
    .then((d) => { setData(d); setEmails(d.emails.join(', ')); setErr(null); })
    .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? 'The control plane does not send spend alerts yet — it needs to be updated.' : apiErrorText(e))), [api]);
  useEffect(() => { void load(); }, [load]);

  const save = async (on: boolean, list: string) => {
    setBusy(true);
    try {
      await api.send('PUT', '/pricing-leaks/settings', { alerts: { runaway_cost: on, emails: list.split(/[,\s]+/).filter(Boolean) } });
      dispatch({ t: 'toast', text: on ? 'Runaway cost alerts are on' : 'Runaway cost alerts are off' });
      void load();
    } catch (e) { setErr(apiErrorText(e)); } finally { setBusy(false); }
  };
  const dirty = !!data && emails.split(/[,\s]+/).filter(Boolean).join(',') !== data.emails.join(',');

  return (
    <Card>
      <CardHead info={HELP.spendAlerts} title="Alerts"
        sub="A runaway cost is announced when it appears, and weekly while it lasts. The other leaks stay on this page.">
        {data && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            {!ro && <Switch on={data.runaway_cost} label="Runaway cost alerts" onChange={(v) => void save(v, emails)} />}
            {ro && <span className={`badge ${data.runaway_cost ? 'b-green' : 'b-muted'}`}>{data.runaway_cost ? 'on' : 'off'}</span>}
            Runaway cost alerts
          </label>
        )}
      </CardHead>
      {err && <div className="callout bad" style={{ margin: '0 20px 16px' }}><Ic n="alert" size={16} /><span>{err}</span></div>}
      {!data ? (!err && <Loading />) : (
        <>
          <div style={{ padding: '0 20px 14px', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="muted" style={{ minWidth: 70 }}>Email to</span>
              <input className="input" style={{ flex: '1 1 320px' }} disabled={ro || busy} value={emails} onChange={(e) => setEmails(e.target.value)}
                aria-label="Alert email recipients"
                placeholder={data.default_emails.length ? `The approval recipients: ${data.default_emails.join(', ')}` : 'finance@yourco.com, platform@yourco.com'} />
              {!ro && <button className="btn sm" disabled={!dirty || busy} onClick={() => void save(data.runaway_cost, emails)}><Ic n="check" size={14} /> Save</button>}
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {!data.email_available && <>This control plane doesn’t send email. </>}
              Empty uses the approval recipients from Settings → Notifications. Webhooks subscribed to <code>{data.webhook_event}</code> get each
              alert as JSON (<Link href="/settings#integrations" className="view-all">Integrations</Link>), and so does Slack where it is connected.
            </div>
          </div>
          {data.alerts.length === 0 ? (
            <Empty icon="checkCircle" title="No runaway cost so far" sub="Alerts appear here with where each one went." />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Alert</th><th>Status</th><th>Announced</th><th className="num">Above usual / month</th></tr></thead>
                <tbody>
                  {data.alerts.map((a) => (
                    <tr key={a.id}>
                      <td style={{ maxWidth: 340 }}>
                        <div className="cell-main" style={{ whiteSpace: 'normal' }}>{a.title}</div>
                        <div className="mono-sm">{a.name || a.person || 'The organisation'}</div>
                      </td>
                      <td>{a.resolved_at
                        ? <span className="badge b-muted">resolved {when(a.resolved_at)}</span>
                        : <span className="badge b-red">open since {when(a.first_seen_at)}</span>}</td>
                      <td>{a.notified_at ? <><div className="muted" style={{ fontSize: 12 }}>{when(a.notified_at)}</div><Channels a={a} /></> : <span className="muted">—</span>}</td>
                      <td className="num tnum"><b>{usd(a.monthly_savings_cents)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
