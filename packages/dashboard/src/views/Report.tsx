'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { ApiError, apiErrorText } from '@/lib/api.ts';
import type { ApiPostureReport, ApiReportScheduleView } from '@/lib/api-inventory.ts';
import { Card, CardHead, Empty, Loading, PageHead, ReadOnlyNote, Seg, Switch } from '@/components/ui.tsx';

const PERIODS = [{ id: '7', label: '7 days' }, { id: '30', label: '30 days' }, { id: '90', label: '90 days' }] as const;
type Period = (typeof PERIODS)[number]['id'];
const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;
const num = (n: number) => n.toLocaleString('en-US');
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const dur = (s: number | null) => (s == null ? '—' : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const LEAK: Record<string, string> = { unused_seat: 'Unused seats', duplicate_tool: 'Duplicate tools', shadow_spend: 'Shadow spend', runaway_cost: 'Runaway cost' };
const ANOM: Record<string, string> = { binary: 'programs', host: 'hosts', mcp: 'MCP servers', action: 'action kinds' };
const personLabel = (p: string) => (p.startsWith('host:') ? `unattributed (${p.slice(5)})` : p);

/** Posture report: one period's machines, agents, blocks, approvals, policy
 *  and spend, for people who don't open the console every day. Prints to PDF. */
export function Report({ initialDays }: { initialDays?: string }) {
  const { api, canWrite } = useLive();
  const [days, setDays] = useState<Period>(initialDays === '7' || initialDays === '90' ? initialDays : '30');
  const [rep, setRep] = useState<ApiPostureReport | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => { setRep(null); return api.get<ApiPostureReport>(`/report?days=${days}`)
    .then((d) => { setRep(d); setErr(null); })
    .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? 'The control plane does not build posture reports yet — it needs to be updated.' : apiErrorText(e))); }, [api, days]);
  useEffect(() => { void load(); }, [load]);

  const last = rep ? new Date(Date.parse(rep.to) - 86_400_000).toISOString() : '';
  return (
    <div className="page report-page">
      <PageHead title="Posture report" sub="What AI agents did across the workspace in a period, and how policy held: for security reviews, leadership updates and audits.">
        <span className="no-print"><Seg value={days} onChange={setDays} options={PERIODS.map((p) => ({ id: p.id, label: p.label }))} /></span>
        <button className="btn no-print" onClick={() => window.print()} disabled={!rep}><Ic n="download" size={14} /> Print / PDF</button>
      </PageHead>
      {err && <div className="callout bad"><Ic n="alert" size={16} /><span>{err}</span></div>}
      {!rep ? (!err && <Loading label="Building the report…" />) : (
        <>
          <div className="print-only report-title">
            <h1>Effigent posture report</h1>
            <div>{fmtDay(rep.from)} – {fmtDay(last)} · generated {new Date(rep.generated_at).toLocaleString()}</div>
          </div>
          <div className="muted no-print" style={{ marginTop: -8 }}>{fmtDay(rep.from)} – {fmtDay(last)} (UTC days) · generated {new Date(rep.generated_at).toLocaleString()}</div>
          {rep.notes.map((n) => <div key={n} className="callout"><Ic n="clock" size={16} /><span>{n}</span></div>)}

          <div className="grid-4">
            <Stat k="Machines enrolled" v={num(rep.machines.enrolled)} s={`${rep.machines.online_now} online now · ${rep.machines.enrolled_in_period} new in the period`} />
            <Stat k="Agent hooks healthy" v={rep.machines.hooks_reporting ? `${rep.machines.hooks_healthy}/${rep.machines.hooks_reporting}` : '—'}
              s={rep.machines.hooks_reporting ? `${rep.machines.hook_problems.length} machines with a hook missing or off` : 'no machine reports its hooks yet'} warn={rep.machines.hook_problems.length > 0} />
            <Stat k="Actions blocked" v={num(rep.enforcement.blocked)} s={`${num(rep.enforcement.would_block)} more would have been (monitor mode)`} />
            <Stat k="Approvals" v={num(rep.approvals.requested)} s={`${rep.approvals.approved} approved · ${rep.approvals.denied} denied · median ${dur(rep.approvals.median_decide_seconds)}`} />
          </div>

          <div className="grid-2">
            <Card>
              <CardHead title="Machines" sub="Enrolled machines and the state of their agent hooks now." />
              <div className="card-body">
                <KV rows={[
                  ['Enrolled', `${num(rep.machines.enrolled)} (${Object.entries(rep.machines.by_os).map(([os, n]) => `${n} ${os === 'darwin' ? 'macOS' : os === 'linux' ? 'Linux' : os === 'windows' ? 'Windows' : os}`).join(', ') || 'none'})`],
                  ['Seen in the period', num(rep.machines.seen_in_period)],
                  ['Online now / offline', `${rep.machines.online_now} / ${rep.machines.offline_now}`],
                  ['Hooks reporting / healthy', `${rep.machines.hooks_reporting} / ${rep.machines.hooks_healthy}`],
                ]} />
                {rep.machines.hook_problems.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div className="section-label">Hook missing or switched off</div>
                    {rep.machines.hook_problems.map((h) => <div key={h.endpoint_id} className="mono-sm">{h.hostname}: {h.agents.join(', ')}</div>)}
                  </div>
                )}
              </div>
            </Card>
            <Card>
              <CardHead title="Agents in use" sub={`${rep.agents.unmanaged_agents} agent installs aren’t enforced (hook off, no hook, or Claude Cowork) — see Inventory.`} href="/inventory" />
              {rep.agents.in_use.length === 0 ? <Empty icon="laptop" title="No agent activity in the period" /> : (
                <div className="tbl-wrap"><table className="tbl">
                  <thead><tr><th>Agent</th><th className="right">People</th><th className="right">Machines</th><th className="right">Events</th></tr></thead>
                  <tbody>{rep.agents.in_use.map((a) => <tr key={a.agent}><td className="mono-name">{a.agent}</td><td className="right tnum">{a.people}</td><td className="right tnum">{a.machines}</td><td className="right tnum">{num(a.events)}</td></tr>)}</tbody>
                </table></div>
              )}
            </Card>
          </div>

          <Card>
            <CardHead title="Blocked and paused actions by kind" sub={`${num(rep.enforcement.blocked)} blocked, ${num(rep.enforcement.would_block)} would have been blocked in monitor mode, ${num(rep.enforcement.file_alerts)} sensitive file opens reported.`} />
            {rep.enforcement.by_kind.length === 0 ? <Empty icon="shieldCheck" title="Nothing blocked in the period" /> : (
              <div className="tbl-wrap"><table className="tbl">
                <thead><tr><th>Kind</th><th className="right">Blocked</th><th className="right">Would block</th><th className="right">Approval requests</th><th style={{ width: '30%' }} /></tr></thead>
                <tbody>{rep.enforcement.by_kind.map((k) => {
                  const max = Math.max(...rep.enforcement.by_kind.map((x) => x.blocked + x.would_block), 1);
                  return (
                    <tr key={k.kind}><td>{k.label}</td><td className="right tnum">{num(k.blocked)}</td><td className="right tnum">{num(k.would_block)}</td><td className="right tnum">{num(k.approval_requests)}</td>
                      <td><div className="report-bar" aria-hidden><span style={{ width: `${(k.blocked / max) * 100}%` }} /><span className="w" style={{ width: `${(k.would_block / max) * 100}%` }} /></div></td></tr>
                  );
                })}</tbody>
              </table></div>
            )}
          </Card>

          <div className="grid-2">
            <Card>
              <CardHead title="By person" sub="Who ran agents, by the People mapping (unmatched machines show as unattributed)." href="/identity" />
              <Groups rows={rep.agents.by_person.slice(0, 15).map((g) => ({ key: g.key, label: g.name ? `${g.name} · ${g.key}` : personLabel(g.key), agents: g.agents, machines: g.machines, events: g.events }))} />
            </Card>
            <Card>
              <CardHead title="By team" sub="Teams come from each machine’s teams (Machines → owner and teams)." href="/enforcement" />
              <Groups rows={rep.agents.by_team.map((g) => ({ key: g.key || '-', label: g.key || 'No team', agents: g.agents, machines: g.machines, events: g.events, people: g.people }))} />
            </Card>
          </div>

          <div className="grid-3">
            <Card>
              <CardHead title="Approvals" href="/approvals" />
              <div className="card-body"><KV rows={[
                ['Requested', num(rep.approvals.requested)], ['Approved', num(rep.approvals.approved)], ['Denied', num(rep.approvals.denied)],
                ['Expired (no decision)', num(rep.approvals.expired)], ['Still pending', num(rep.approvals.pending)],
                ['Median time to decide', dur(rep.approvals.median_decide_seconds)], ['Self-approvals refused', num(rep.approvals.self_approval_refused)],
              ]} /></div>
            </Card>
            <Card>
              <CardHead title="Policy" href="/policies" />
              <div className="card-body"><KV rows={[
                ['Versions published', num(rep.policy.versions_published)],
                ['Changes proposed', Object.entries(rep.policy.proposals).map(([st, n]) => `${n} ${st}`).join(', ') || '0'],
                ['Change approval', rep.policy.change_approval_on ? 'on (two people)' : 'off'],
                ['Exceptions active', `${rep.exceptions.active} (${rep.exceptions.permanent} without expiry)`],
                ['Exceptions created', num(rep.exceptions.created_in_period)], ['Expiring within 7 days', num(rep.exceptions.expiring_7d)],
              ]} /></div>
            </Card>
            <Card>
              <CardHead title="New behaviour" href="/anomalies" />
              <div className="card-body"><KV rows={[
                ['First-seen signals', num(rep.anomalies.total)],
                ...Object.entries(rep.anomalies.by_kind).map(([k, n]) => [`New ${ANOM[k] ?? k}`, num(n)] as [string, string]),
              ]} /><div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Novelty per agent and machine against a 30-day baseline — not prompt-injection detection.</div></div>
            </Card>
          </div>

          {rep.break_glass != null && (() => {
            const bg = rep.break_glass;
            return (
              <Card>
                <CardHead title="Break-glass" sub="Offline codes that lift approval lists (never deny rules) while the control plane can’t be reached." href="/enforcement#break-glass" />
                <div className="card-body"><KV rows={[
                  ['Codes issued', `${num(bg.issued)}${bg.issued_all_machines ? ` (${bg.issued_all_machines} for all machines)` : ''}`],
                  ['Activations', bg.activations === 0 ? 'none' : `${num(bg.activations)} on ${bg.machines} machine${bg.machines === 1 ? '' : 's'}`],
                  ['Revoked / expired unused', `${bg.revoked} / ${bg.expired_unused}`],
                  ...(bg.unknown_codes ? [['Codes not issued here', num(bg.unknown_codes)] as [string, string]] : []),
                ]} /></div>
                {bg.uses.length > 0 && (
                  <div className="tbl-wrap"><table className="tbl">
                    <thead><tr><th>When</th><th>Machine</th><th>Run by</th><th>Reason</th><th>Issued by</th></tr></thead>
                    <tbody>{bg.uses.map((u) => (
                      <tr key={`${u.id}-${u.endpoint_id}-${u.at}`}><td className="tnum">{fmtDay(u.at)}</td><td className="mono-name">{u.hostname || u.endpoint_id}</td>
                        <td className="mono-sm">{u.os_user || '—'}</td><td>{u.reason || (u.created_by ? '—' : 'not issued by this control plane')}</td><td>{u.created_by || '—'}</td></tr>
                    ))}</tbody>
                  </table></div>
                )}
              </Card>
            );
          })()}

          <Card>
            <CardHead title="AI tool spend" sub="Pricing Leaks as of today, and what changed in the period." href="/pricing-leaks" />
            {!rep.spend ? <Empty icon="database" title="No AI vendors connected" sub="Connect vendors under Settings → AI vendors to include spend and savings." /> : (
              <div className="card-body"><KV rows={[
                ['Vendors', rep.spend.connected.join(', ') || '—'], ['Monthly spend', usd(rep.spend.monthly_cents)],
                ['Potential savings (a month)', usd(rep.spend.potential_savings_cents)], ['At risk (runaway cost)', usd(rep.spend.at_risk_cents)],
                ['Open leaks', Object.entries(rep.spend.open_leaks).map(([t, n]) => `${n} ${LEAK[t] ?? t}`).join(', ') || 'none'],
                ['Found / resolved in the period', `${rep.spend.found_in_period} / ${rep.spend.resolved_in_period} (${usd(rep.spend.resolved_savings_cents)} a month saved)`],
              ]} /></div>
            )}
          </Card>

          <ScheduleCard canWrite={canWrite} />
        </>
      )}
    </div>
  );
}

function Stat({ k, v, s, warn }: { k: string; v: string; s: string; warn?: boolean }) {
  return <Card className="mini-stat"><div className="k">{k}</div><div className="v" style={{ color: warn ? 'var(--gold)' : undefined }}>{v}</div><div className="s">{s}</div></Card>;
}

function KV({ rows }: { rows: [string, string][] }) {
  return (
    <table className="tbl report-kv"><tbody>
      {rows.map(([k, v]) => <tr key={k}><td className="muted">{k}</td><td className="right">{v}</td></tr>)}
    </tbody></table>
  );
}

function Groups({ rows }: { rows: { key: string; label: string; agents: string[]; machines: number; events: number; people?: number }[] }) {
  if (rows.length === 0) return <Empty icon="users" title="No activity in the period" />;
  return (
    <div className="tbl-wrap"><table className="tbl">
      <thead><tr><th>Who</th><th>Agents</th><th className="right">Machines</th>{rows.some((r) => r.people != null) && <th className="right">People</th>}<th className="right">Events</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.key}><td className="mono-sm">{r.label}</td><td className="mono-sm">{r.agents.join(', ')}</td><td className="right tnum">{r.machines}</td>
          {r.people != null && <td className="right tnum">{r.people}</td>}<td className="right tnum">{num(r.events)}</td></tr>
      ))}</tbody>
    </table></div>
  );
}

/** Weekly / monthly email of this report. */
function ScheduleCard({ canWrite }: { canWrite: boolean }) {
  const { api } = useLive();
  const { dispatch } = useStore();
  const [v, setV] = useState<ApiReportScheduleView | null>(null);
  const [draft, setDraft] = useState<{ enabled: boolean; cadence: 'weekly' | 'monthly'; emails: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const take = (d: ApiReportScheduleView) => { setV(d); setDraft({ enabled: d.schedule.enabled, cadence: d.schedule.cadence, emails: d.schedule.emails.join(', ') }); };
  useEffect(() => {
    api.get<ApiReportScheduleView>('/report/schedule').then(take)
      .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? 'The control plane does not email reports yet — it needs to be updated.' : apiErrorText(e)));
  }, [api]);
  const emails = (draft?.emails ?? '').split(/[\s,;]+/).filter(Boolean);
  const dirty = !!(v && draft) && (draft.enabled !== v.schedule.enabled || draft.cadence !== v.schedule.cadence || emails.join(',') !== v.schedule.emails.join(','));
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try { take(await api.send<ApiReportScheduleView>('PUT', '/report/schedule', { enabled: draft.enabled, cadence: draft.cadence, emails })); setErr(null); dispatch({ t: 'toast', text: 'Report schedule saved' }); }
    catch (e) { setErr(apiErrorText(e)); } finally { setBusy(false); }
  };
  const sendNow = async () => {
    setBusy(true);
    try { const r = await api.send<{ result: Record<string, string> }>('POST', '/report/send', { days: draft?.cadence === 'monthly' ? 30 : 7 }); dispatch({ t: 'toast', text: `Report: ${r.result.email}` }); }
    catch (e) { setErr(apiErrorText(e)); } finally { setBusy(false); }
  };
  const s = v?.schedule;
  return (
    <Card className="no-print">
      <CardHead title="Email this report" sub="Weekly (Mondays 08:00 UTC, the last 7 days) or monthly (the 1st, 08:00 UTC, the last 30 days), to the addresses below — or to the approval notification emails when empty.">
        {!canWrite && <ReadOnlyNote what="change the schedule" />}
      </CardHead>
      <div className="card-body">
        {err && <div className="callout bad"><Ic n="alert" size={16} /><span>{err}</span></div>}
        {!v || !draft ? (!err && <Loading />) : (
          <>
            {!v.email_available && <div className="callout"><Ic n="alert" size={16} /><span>This control plane has no email configured (SMTP or SES): scheduled reports are recorded as not sent.</span></div>}
            <div className="setting-row">
              <div><div className="setting-title">Send on a schedule</div><div className="setting-desc">{s?.next_at ? `Next: ${new Date(s.next_at).toLocaleString()}` : 'Off'}{s?.last_sent_at ? ` · last: ${new Date(s.last_sent_at).toLocaleString()} (${s.last_result?.email ?? '—'})` : ''}</div></div>
              <Switch on={draft.enabled} onChange={(on) => canWrite && setDraft({ ...draft, enabled: on })} label="Send on a schedule" />
            </div>
            <div className="form-row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <Seg value={draft.cadence} onChange={(c) => canWrite && setDraft({ ...draft, cadence: c })} options={[{ id: 'weekly', label: 'Weekly' }, { id: 'monthly', label: 'Monthly' }]} />
              <input className="input" style={{ flex: 1, minWidth: 260 }} disabled={!canWrite} value={draft.emails} onChange={(e) => setDraft({ ...draft, emails: e.target.value })}
                placeholder={v.default_emails.length ? `Empty: ${v.default_emails.join(', ')}` : 'ciso@company.com, security@company.com'} aria-label="Recipients" />
              {canWrite && <button className="btn primary sm" disabled={!dirty || busy} onClick={() => void save()}><Ic n="check" size={14} /> {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}</button>}
              {canWrite && <button className="btn sm" disabled={busy || dirty} onClick={() => void sendNow()} title={dirty ? 'Save first' : 'Email the report now to these recipients'}><Ic n="upload" size={14} /> Send now</button>}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>The email carries the headline numbers and a link here; open it to print the full report. <Link className="link" href="/settings">Notification emails</Link></div>
          </>
        )}
      </div>
    </Card>
  );
}
