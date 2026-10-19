'use client';

import { HELP } from '@/lib/help.tsx';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { ApiError, apiErrorText, type ApiLeak, type ApiLeakType, type ApiPricingLeaks, type ApiSpendConnector, type ApiSpendPrices } from '@/lib/api.ts';
import { Card, CardHead, Empty, Loading, PageGuide, PageHead, ReadOnlyNote, Seg } from '@/components/ui.tsx';
import { SpendTrend } from '@/components/SpendTrend.tsx';
import { SpendAlerts } from '@/components/SpendAlerts.tsx';

const TYPES: { id: ApiLeakType; label: string; icon: string; badge: string; what: string }[] = [
  { id: 'runaway_cost', label: 'Runaway cost', icon: 'burst', badge: 'b-red', what: 'Far above the team’s median, or a sudden daily spike (often an agent looping in CI)' },
  { id: 'unused_seat', label: 'Unused seats', icon: 'user', badge: 'b-gold', what: 'A paid seat with no use in 30 days, by the vendor’s records and by effigentd' },
  { id: 'duplicate_tool', label: 'Duplicate tools', icon: 'layers', badge: 'b-orange', what: 'Paying for several coding tools while really working in one' },
  { id: 'shadow_spend', label: 'Shadow spend', icon: 'eye', badge: 'b-blue', what: 'An agent effigentd sees that isn’t on the company plan: likely a personal plan, expensed' },
];
const TYPE = Object.fromEntries(TYPES.map((t) => [t.id, t])) as Record<ApiLeakType, (typeof TYPES)[number]>;

const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;
const VIA: Record<string, string> = {
  os_user: 'by their OS user', git_email: 'by their git email', owner: 'by machine owner', host: 'by machine (hostname)',
};
/** A person key is a work email, or kind:value when it couldn't be matched (host:, github:, user:…). */
function Who({ leak }: { leak: ApiLeak }) {
  if (!leak.person) return <span className="cell-main">The organisation</span>;
  const matched = leak.person.includes('@') && !leak.person.includes(':');
  return (
    <div style={{ minWidth: 0 }}>
      <div className="cell-main">{leak.name || leak.person}</div>
      <div className="mono-sm" title={matched ? undefined : 'Not matched to a work email: map it on the People page'}>
        {leak.name ? leak.person : matched ? '' : 'not matched to a person'}
      </div>
      {leak.attribution && <div className="muted" style={{ fontSize: 12 }} title="How effigentd's activity was tied to this person">matched {VIA[leak.attribution]}</div>}
    </div>
  );
}

/** Pricing Leaks: AI tool spend from the vendors' admin APIs, joined with what effigentd sees on each machine. */
export function PricingLeaks({ dev }: { dev: boolean }) {
  const { api, canWrite, fixture } = useLive();
  const { dispatch } = useStore();
  const [data, setData] = useState<ApiPricingLeaks | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | ApiLeakType>('all');
  // ?leak=<id>: opened from an alert (email, Slack, webhook review_url)
  // (the table renders after the data loads, so reading the URL here can't mismatch the server HTML)
  const [focus] = useState<string | null>(() => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('leak')));
  const ro = !canWrite;

  const load = useCallback(() => api.get<ApiPricingLeaks>('/pricing-leaks')
    .then((d) => { setData(d); setErr(null); })
    .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? 'The control plane does not support Pricing Leaks yet — it needs to be updated.' : apiErrorText(e))), [api]);
  useEffect(() => { void load(); }, [load]);
  // a sync runs in the background on the control plane: refresh until it's done
  const syncing = data?.connectors.some((c) => c.sync_status === 'running') ?? false;
  useEffect(() => {
    if (!syncing) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [syncing, load]);

  const syncNow = async () => {
    try {
      const r = await api.send<{ started: string[]; already_running: string[] }>('POST', '/pricing-leaks/sync', {});
      dispatch({ t: 'toast', text: r.started.length ? `Syncing ${r.started.length} vendor${r.started.length > 1 ? 's' : ''}…` : 'A sync is already running' });
      void load();
    } catch (e) { setErr(apiErrorText(e)); }
  };

  const rep = data?.report;
  const leaks = useMemo(() => rep?.leaks ?? [], [rep]);
  const shown = filter === 'all' ? leaks : leaks.filter((l) => l.type === filter);
  const anyData = (rep?.vendors ?? []).length > 0;
  const maxMonthly = Math.max(1, ...(rep?.vendors ?? []).map((v) => v.monthly_cents));
  const savings = (t: ApiLeakType) => leaks.filter((l) => l.type === t).reduce((s, l) => s + l.monthly_savings_cents, 0);
  const focused = !!focus && leaks.some((l) => l.id === focus);
  useEffect(() => {
    if (focused) document.getElementById(`leak-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [focused, focus]);
  const since = (id: string) => data?.first_seen?.[id];

  return (
    <div className="page">
      <PageHead info={HELP.pricingLeaks} title="Pricing Leaks" sub="Where your AI coding tools cost more than they should: unused seats, duplicate tools, spend off the company plan and runaway usage.">
        {ro && <ReadOnlyNote what="connect vendors" />}
        {!ro && data?.connectors.some((c) => c.configured) && <button className="btn" onClick={syncNow} disabled={syncing}><Ic n="rotate" size={14} /> {syncing ? 'Syncing…' : 'Sync now'}</button>}
      </PageHead>
      <PageGuide id="pricing-leaks" steps={[
        <>Connect your AI vendors’ <b>admin APIs</b> (or upload their CSV exports) in <Link href="/settings#ai-vendors" className="view-all">Settings → AI vendors</Link></>,
        <>Map OS users, git emails and machines to people on <Link href="/identity" className="view-all">People</Link> (it suggests the matches), so spend and agents meet on one person</>,
        <>Act on the leaks: each shows its evidence and the monthly saving</>,
      ]} />
      {err && <div className="callout bad"><Ic n="alert" size={16} /><span>{err}</span></div>}

      {!data ? (!err && <Loading />) : (
        <>
          <div className="grid-4">
            <div className="stat card">
              <div className="stat-top"><span className="stat-label">Potential savings</span><span className="stat-icon st-gold"><Ic n="spark" size={18} /></span></div>
              <div className="stat-value-row"><span className="stat-value tnum">{usd(rep!.total_savings_cents)}</span></div>
              <div className="stat-foot">per month, from {leaks.filter((l) => l.monthly_savings_cents > 0).length} leaks</div>
            </div>
            <div className="stat card">
              <div className="stat-top"><span className="stat-label">AI tool spend</span><span className="stat-icon st-blue"><Ic n="database" size={18} /></span></div>
              <div className="stat-value-row"><span className="stat-value tnum">{usd(rep!.total_monthly_cents)}</span></div>
              <div className="stat-foot">per month: seats + the last {rep!.window_days} days of usage</div>
            </div>
            <div className="stat card">
              <div className="stat-top"><span className="stat-label">Leaks found</span><span className="stat-icon st-red"><Ic n="alert" size={18} /></span></div>
              <div className="stat-value-row"><span className="stat-value tnum">{leaks.length}</span></div>
              <div className="stat-foot">{TYPES.map((t) => `${leaks.filter((l) => l.type === t.id).length} ${t.label.toLowerCase()}`).join(' · ')}</div>
            </div>
            <div className="stat card">
              <div className="stat-top"><span className="stat-label">Off the company plan</span><span className="stat-icon st-slate"><Ic n="eye" size={18} /></span></div>
              <div className="stat-value-row"><span className="stat-value tnum">{usd(rep!.total_at_risk_cents)}</span></div>
              <div className="stat-foot">per month in likely personal plans (shadow spend)</div>
            </div>
          </div>

          <Card>
            <CardHead info={HELP.leaks} title="Leaks" sub="Each with who, the evidence from the vendor and from effigentd, and what fixing it saves per month.">
              <Seg value={filter} onChange={setFilter} options={[{ id: 'all', label: `All ${leaks.length}` }, ...TYPES.map((t) => ({ id: t.id, label: `${t.label} ${leaks.filter((l) => l.type === t.id).length}` }))]} />
            </CardHead>
            {filter !== 'all' && <div className="muted" style={{ fontSize: 13, padding: '0 20px 10px' }}>{TYPE[filter].what}{savings(filter) > 0 && <> · <b>{usd(savings(filter))}/month</b></>}</div>}
            {shown.length === 0 ? (
              <Empty icon={anyData ? 'checkCircle' : 'plug'} title={anyData ? 'No leaks of this kind' : 'Connect a vendor to find leaks'}
                sub={anyData ? 'Spend matches what effigentd sees.' : 'Add an admin API key or upload a CSV export in Settings → AI vendors. effigentd’s view of the agents on each machine is joined automatically.'} />
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Leak</th><th>Who</th><th>Evidence</th><th className="num">Saves / month</th></tr></thead>
                  <tbody>
                    {shown.map((l) => (
                      <tr key={l.id} id={`leak-${l.id}`} style={l.id === focus ? { background: 'var(--accent-bg)' } : undefined}>
                        <td style={{ verticalAlign: 'top', minWidth: 200 }}>
                          <span className={`badge ${TYPE[l.type]?.badge ?? 'b-muted'}`}><Ic n={TYPE[l.type]?.icon ?? 'alert'} size={12} /> {TYPE[l.type]?.label ?? l.type}</span>
                          {data.first_seen && isNew(since(l.id), rep!.generated_at) && <span className="badge b-blue" style={{ marginLeft: 6 }}>new</span>}
                          <div className="cell-main" style={{ marginTop: 6, whiteSpace: 'normal' }}>{l.title}</div>
                          <div className="muted" style={{ fontSize: 12 }}>{l.confidence} confidence{since(l.id) && <> · since {new Date(since(l.id)!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</>}</div>
                        </td>
                        <td style={{ verticalAlign: 'top', maxWidth: 220 }}><Who leak={l} /></td>
                        <td style={{ verticalAlign: 'top' }}>
                          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13, lineHeight: 1.5 }}>{l.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
                        </td>
                        <td className="num tnum" style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                          {l.monthly_savings_cents > 0 ? <b>{usd(l.monthly_savings_cents)}</b> : <span className="muted">—</span>}
                          {l.at_risk_cents > 0 && <div className="muted" style={{ fontSize: 12 }}>{usd(l.at_risk_cents)} off-plan</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(rep!.unattributed ?? []).length > 0 && (
              <div className="callout warn" style={{ margin: '0 20px 16px' }}><Ic n="alert" size={14} />
                <span>Not linked to a person: <b>{rep!.unattributed.join(', ')}</b>. Map their OS users, git emails or the machine on <Link href="/identity" className="view-all">People</Link>.</span>
              </div>
            )}
          </Card>

          <Card>
            <CardHead title="Spend by vendor" sub={`Seats per month plus usage in the last ${rep!.window_days} days. Seat prices come from the vendor where it reports them, otherwise from the price table below.`}>
              <span className="muted" style={{ fontSize: 12.5 }}>{connectedNote(data.connectors)}</span>
              <Link className="btn sm" href="/settings#ai-vendors"><Ic n="plug" size={14} /> AI vendors</Link>
            </CardHead>
            {!anyData ? <Empty icon="database" title="No spend data yet" sub="Connect a vendor or upload a CSV in Settings → AI vendors." /> : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Vendor</th><th className="num">Seats in use</th><th className="num">Seats / month</th><th className="num">Usage ({rep!.window_days} d)</th><th className="num">Total / month</th><th style={{ width: '28%' }} /></tr></thead>
                  <tbody>
                    {rep!.vendors.map((v) => (
                      <tr key={v.vendor}>
                        <td className="cell-main">{v.label}{v.estimated && <span className="badge b-muted" style={{ marginLeft: 8 }} title="Per-person cost estimated from token share">estimated</span>}</td>
                        <td className="num tnum">{v.seats ? `${v.active_seats} of ${v.seats}` : '—'}</td>
                        <td className="num tnum">{v.seat_cents ? usd(v.seat_cents) : '—'}</td>
                        <td className="num tnum">{v.usage_cents ? usd(v.usage_cents) : '—'}</td>
                        <td className="num tnum"><b>{usd(v.monthly_cents)}</b></td>
                        <td><div style={{ height: 8, borderRadius: 4, background: 'var(--panel-3)' }}><div style={{ height: 8, borderRadius: 4, width: `${(100 * v.monthly_cents) / maxMonthly}%`, background: 'var(--accent-2)' }} /></div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <SpendTrend />
          <SpendAlerts ro={ro} />
          <Prices key={data.settings.updated_at ?? 'none'} prices={data.settings.prices} defaults={data.default_prices} ro={ro} onSaved={load} onError={setErr} />
          {dev && !fixture && <div className="muted" style={{ fontSize: 12.5 }}>Dev bypass: point the console at a local control plane to see real data.</div>}
        </>
      )}
    </div>
  );
}

/** First seen in the last day (or not rolled up yet: just found). */
function isNew(firstSeen: string | undefined, now: string) {
  return !firstSeen || Date.parse(now) - Date.parse(firstSeen) < 86_400_000;
}

function connectedNote(cs: ApiSpendConnector[]) {
  const on = cs.filter((c) => c.configured || c.csv_seats || c.csv_usage_rows);
  const failed = cs.filter((c) => c.sync_status === 'error').length;
  if (!on.length) return 'No vendor connected';
  return `${on.map((c) => c.label.replace(/ \(.*\)$/, '')).join(', ')}${failed ? ` · ${failed} sync failed` : ''}`;
}

const PRICE_LABEL: Record<string, string> = {
  cursor: 'Cursor', anthropic: 'Anthropic', copilot: 'GitHub Copilot', openai: 'OpenAI', google: 'Google (Gemini)', byok: 'Bring-your-own-key',
  'copilot/business': 'Copilot Business', 'copilot/enterprise': 'Copilot Enterprise',
};

function Prices({ prices: initialPrices, defaults, ro, onSaved, onError }: {
  prices: ApiSpendPrices | null; defaults: ApiSpendPrices; ro: boolean; onSaved: () => void; onError: (e: string) => void;
}) {
  const { api } = useLive();
  const { dispatch } = useStore();
  const [prices, setPrices] = useState<ApiSpendPrices>({ seat: { ...(initialPrices?.seat ?? {}) }, personal: { ...(initialPrices?.personal ?? {}) } });
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.send('PUT', '/pricing-leaks/settings', { prices });
      dispatch({ t: 'toast', text: 'Saved — the report uses the new prices' });
      setDirty(false);
      onSaved();
    } catch (e) { onError(apiErrorText(e)); } finally { setBusy(false); }
  };
  const priceInput = (table: 'seat' | 'personal', k: string) => {
    const v = prices[table][k];
    return (
      <input className="input tnum" style={{ width: 90 }} inputMode="decimal" disabled={ro} aria-label={`${PRICE_LABEL[k] ?? k} ${table} price`}
        placeholder={`$${((defaults[table][k] ?? 0) / 100).toFixed(0)}`} defaultValue={v === undefined ? '' : String(v / 100)}
        onBlur={(e) => {
          const raw = e.target.value.replace(/[$,\s]/g, '');
          setPrices((p) => {
            const t = { ...p[table] };
            if (raw === '' || !Number.isFinite(Number(raw))) delete t[k]; else t[k] = Math.round(Number(raw) * 100);
            return { ...p, [table]: t };
          });
          setDirty(true);
        }} />
    );
  };

  return (
    <Card>
      <CardHead info={HELP.spendPrices} title="Prices" sub="Monthly list prices used when a vendor doesn’t report one. Empty = the default shown. Personal plan prices size shadow spend.">
        {!ro && <button className="btn primary sm" disabled={!dirty || busy} onClick={save}><Ic n="check" size={14} /> {busy ? 'Saving…' : dirty ? 'Save prices' : 'Saved'}</button>}
      </CardHead>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Seat price</th><th>$ / month</th><th>Personal plan</th><th>$ / month</th></tr></thead>
          <tbody>
            {Array.from({ length: Math.max(Object.keys(defaults.seat).length, Object.keys(defaults.personal).length) }, (_, i) => {
              const s = Object.keys(defaults.seat)[i]; const pp = Object.keys(defaults.personal)[i];
              return (
                <tr key={i}>
                  <td>{s ? PRICE_LABEL[s] ?? s : ''}</td><td>{s && priceInput('seat', s)}</td>
                  <td>{pp ? PRICE_LABEL[pp] ?? pp : ''}</td><td>{pp && priceInput('personal', pp)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
