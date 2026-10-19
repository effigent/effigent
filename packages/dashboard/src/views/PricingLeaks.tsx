'use client';

import { HELP } from '@/lib/help.tsx';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { ApiError, apiErrorText, type ApiLeak, type ApiLeakType, type ApiPricingLeaks, type ApiSpendConnector, type ApiSpendImport, type ApiSpendPerson, type ApiSpendPrices } from '@/lib/api.ts';
import { Card, CardHead, Empty, Loading, PageGuide, PageHead, ReadOnlyNote, Seg } from '@/components/ui.tsx';

const TYPES: { id: ApiLeakType; label: string; icon: string; badge: string; what: string }[] = [
  { id: 'runaway_cost', label: 'Runaway cost', icon: 'burst', badge: 'b-red', what: 'Far above the team’s median, or a sudden daily spike (often an agent looping in CI)' },
  { id: 'unused_seat', label: 'Unused seats', icon: 'user', badge: 'b-gold', what: 'A paid seat with no use in 30 days, by the vendor’s records and by effigentd' },
  { id: 'duplicate_tool', label: 'Duplicate tools', icon: 'layers', badge: 'b-orange', what: 'Paying for several coding tools while really working in one' },
  { id: 'shadow_spend', label: 'Shadow spend', icon: 'eye', badge: 'b-blue', what: 'An agent effigentd sees that isn’t on the company plan: likely a personal plan, expensed' },
];
const TYPE = Object.fromEntries(TYPES.map((t) => [t.id, t])) as Record<ApiLeakType, (typeof TYPES)[number]>;

const KEY_HELP: Record<string, { key: string; csvSeats: string; csvUsage: string }> = {
  cursor: { key: 'A Cursor Admin API key (team dashboard → Settings → Admin API keys).',
    csvSeats: 'Members export: Email, Name, Role', csvUsage: 'Usage export: Date, Email, Cost (or Requests)' },
  anthropic: { key: 'An Anthropic Admin API key (sk-ant-admin…, Console → Settings → Admin keys). Reads Claude Code usage and the cost report.',
    csvSeats: 'Members: Email, Name', csvUsage: 'Usage: Date, Email (or API key name), Cost' },
  copilot: { key: 'A GitHub token that can read the organisation’s Copilot billing (classic: manage_billing:copilot or read:org), plus the organisation login.',
    csvSeats: 'Seat usage export: Login, Last activity at, Plan', csvUsage: 'Usage: Date, Login, Cost' },
  openai: { key: 'An OpenAI Admin key (Platform → Organization → Admin keys). Per-person cost is estimated from each user’s token share.',
    csvSeats: 'Members: Email, Name', csvUsage: 'Usage: Date, Email, Cost' },
};

const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;
const ago = (iso?: string) => {
  if (!iso) return 'never';
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 60 * 36 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
/** A person key is a work email, or kind:value when it couldn't be matched (host:, github:, user:…). */
function Who({ leak }: { leak: ApiLeak }) {
  if (!leak.person) return <span className="cell-main">The organisation</span>;
  const matched = leak.person.includes('@') && !leak.person.includes(':');
  return (
    <div style={{ minWidth: 0 }}>
      <div className="cell-main">{leak.name || leak.person}</div>
      <div className="mono-sm" title={matched ? undefined : 'Not matched to a work email: set a machine owner or add a People alias'}>
        {leak.name ? leak.person : matched ? '' : 'not matched to a person'}
      </div>
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

  return (
    <div className="page">
      <PageHead info={HELP.pricingLeaks} title="Pricing Leaks" sub="Where your AI coding tools cost more than they should: unused seats, duplicate tools, spend off the company plan and runaway usage.">
        {ro && <ReadOnlyNote what="connect vendors" />}
        {!ro && data?.connectors.some((c) => c.configured) && <button className="btn" onClick={syncNow} disabled={syncing}><Ic n="rotate" size={14} /> {syncing ? 'Syncing…' : 'Sync now'}</button>}
      </PageHead>
      <PageGuide id="pricing-leaks" steps={[
        <>Connect your AI vendors’ <b>admin APIs</b> (or upload their CSV exports) below</>,
        <>Give each machine an <b>owner</b> in <Link href="/enforcement" className="view-all">Machines</Link>, or add People aliases, so spend and agents meet on one person</>,
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
                sub={anyData ? 'Spend matches what effigentd sees.' : 'Add an admin API key or upload a CSV export below. effigentd’s view of the agents on each machine is joined automatically.'} />
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Leak</th><th>Who</th><th>Evidence</th><th className="num">Saves / month</th></tr></thead>
                  <tbody>
                    {shown.map((l) => (
                      <tr key={l.id}>
                        <td style={{ verticalAlign: 'top', minWidth: 200 }}>
                          <span className={`badge ${TYPE[l.type]?.badge ?? 'b-muted'}`}><Ic n={TYPE[l.type]?.icon ?? 'alert'} size={12} /> {TYPE[l.type]?.label ?? l.type}</span>
                          <div className="cell-main" style={{ marginTop: 6, whiteSpace: 'normal' }}>{l.title}</div>
                          <div className="muted" style={{ fontSize: 12 }}>{l.confidence} confidence</div>
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
                <span>Not linked to a person: <b>{rep!.unattributed.join(', ')}</b>. Set an owner in <Link href="/enforcement" className="view-all">Machines</Link> or add the hostname as a People alias below.</span>
              </div>
            )}
          </Card>

          <Card>
            <CardHead title="Spend by vendor" sub={`Seats per month plus usage in the last ${rep!.window_days} days. Seat prices come from the vendor where it reports them, otherwise from the price table below.`} />
            {!anyData ? <Empty icon="database" title="No spend data yet" sub="Connect a vendor or upload a CSV below." /> : (
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

          <Card>
            <CardHead info={HELP.connectors} title="Vendors" sub="Admin API keys are encrypted on the control plane and never shown again (only their last 4 characters). Each vendor syncs once a day and when you save a key. No API access? Upload the vendor’s CSV export instead." />
            {!data.secrets_available && !fixture && (
              <div className="callout warn" style={{ margin: '0 20px 12px' }}><Ic n="lock" size={14} /><span>This control plane has no <code>EFFIGENT_SECRETS_KEY</code>, so it can’t store vendor keys. CSV import works.</span></div>
            )}
            <div className="grid-2" style={{ padding: '0 20px 18px', gap: 12 }}>
              {data.connectors.map((c) => <Connector key={c.vendor} c={c} ro={ro} canStore={data.secrets_available || fixture} onChange={load} onError={setErr} />)}
            </div>
          </Card>

          <Directory key={data.settings.updated_at ?? 'none'} people={data.settings.people ?? []} prices={data.settings.prices} defaults={data.default_prices} ro={ro} onSaved={load} onError={setErr} />
          {dev && !fixture && <div className="muted" style={{ fontSize: 12.5 }}>Dev bypass: point the console at a local control plane to see real data.</div>}
        </>
      )}
    </div>
  );
}

function Connector({ c, ro, canStore, onChange, onError }: { c: ApiSpendConnector; ro: boolean; canStore: boolean; onChange: () => void; onError: (e: string) => void }) {
  const { api } = useLive();
  const { dispatch } = useStore();
  const [key, setKey] = useState('');
  const [org, setOrg] = useState(c.settings?.org ?? '');
  const [kind, setKind] = useState<'seats' | 'usage'>(c.vendor === 'copilot' ? 'seats' : 'usage');
  const [busy, setBusy] = useState(false);
  const help = KEY_HELP[c.vendor];

  const run = async (f: () => Promise<void>) => { setBusy(true); try { await f(); onChange(); } catch (e) { onError(apiErrorText(e)); } finally { setBusy(false); } };
  const save = () => run(async () => {
    await api.send('PUT', `/pricing-leaks/connectors/${c.vendor}`, { key, org });
    setKey('');
    dispatch({ t: 'toast', text: `${c.label} connected — syncing the last 30 days` });
  });
  const disconnect = () => run(async () => {
    if (!confirm(`Disconnect ${c.label}? Its key and synced data are deleted; CSV imports stay.`)) return;
    await api.send('DELETE', `/pricing-leaks/connectors/${c.vendor}`);
  });
  const upload = (file: File) => run(async () => {
    if (file.size > 20 << 20) throw new Error('That file is over 20 MB: split the export.');
    const r = await api.send<ApiSpendImport>('POST', '/pricing-leaks/import', { vendor: c.vendor, kind, csv: await file.text() });
    dispatch({ t: 'toast', text: `Imported ${r.seats || r.usage_rows} ${kind === 'seats' ? 'seats' : 'usage rows'}${r.skipped ? ` (${r.skipped} skipped)` : ''}` });
  });
  const clearCSV = () => run(async () => { await api.send('DELETE', `/pricing-leaks/import/${c.vendor}`); });

  const status = c.sync_status === 'running' ? <span className="badge b-blue">syncing…</span>
    : c.sync_status === 'error' ? <span className="badge b-red">sync failed</span>
    : c.configured ? <span className="badge b-green">connected</span>
    : c.csv_seats || c.csv_usage_rows ? <span className="badge b-gold">CSV</span>
    : <span className="badge b-muted">not connected</span>;

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b style={{ flex: 1 }}>{c.label}</b>{status}
      </div>
      <div className="muted" style={{ fontSize: 12.5 }}>
        {c.configured ? <>Key ••••{c.key_hint} · synced {ago(c.last_sync_at)}{c.last_counts ? ` · ${c.last_counts.seats ?? 0} seats, ${c.last_counts.usage_rows ?? 0} usage rows` : ''}{c.settings?.org ? ` · org ${c.settings.org}` : ''}</> : help.key}
      </div>
      {c.last_error && <div className="callout bad" style={{ margin: 0, fontSize: 12.5 }}><Ic n="alert" size={14} /><span>{c.last_error}</span></div>}
      {!ro && canStore && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="input mono" type="password" autoComplete="off" style={{ flex: '2 1 200px' }} value={key} onChange={(e) => setKey(e.target.value)}
            placeholder={c.configured ? 'Paste a new key to replace it' : 'Admin API key'} aria-label={`${c.label} admin API key`} />
          {c.vendor === 'copilot' && <input className="input mono" style={{ flex: '1 1 110px' }} value={org} onChange={(e) => setOrg(e.target.value)} placeholder="GitHub org" aria-label="GitHub organisation" />}
          <button className="btn primary sm" disabled={busy || !key.trim()} onClick={save}><Ic n="plug" size={14} /> {c.configured ? 'Replace' : 'Connect'}</button>
          {c.configured && <button className="btn sm" disabled={busy} onClick={disconnect} title="Disconnect"><Ic n="trash" size={14} /></button>}
        </div>
      )}
      {!ro && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5 }}>
          <span className="muted">CSV</span>
          <select className="select" style={{ flex: '0 1 110px' }} value={kind} onChange={(e) => setKind(e.target.value as 'seats' | 'usage')} aria-label="CSV kind">
            <option value="seats">Seats</option><option value="usage">Usage</option>
          </select>
          <label className="btn sm" style={{ cursor: busy ? 'default' : 'pointer' }}>
            <Ic n="upload" size={14} /> Upload
            <input type="file" accept=".csv,text/csv" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
          </label>
          <span className="muted" title={kind === 'seats' ? help.csvSeats : help.csvUsage} style={{ flex: 1, minWidth: 140 }}>{kind === 'seats' ? help.csvSeats : help.csvUsage}</span>
          {(c.csv_seats > 0 || c.csv_usage_rows > 0) && <button className="btn sm" disabled={busy} onClick={clearCSV} title="Delete imported CSV data">{c.csv_seats} seats · {c.csv_usage_rows} rows <Ic n="x" size={12} /></button>}
        </div>
      )}
    </div>
  );
}

const PRICE_LABEL: Record<string, string> = {
  cursor: 'Cursor', anthropic: 'Anthropic', copilot: 'GitHub Copilot', openai: 'OpenAI', google: 'Google (Gemini)', byok: 'Bring-your-own-key',
  'copilot/business': 'Copilot Business', 'copilot/enterprise': 'Copilot Enterprise',
};

function Directory({ people: initial, prices: initialPrices, defaults, ro, onSaved, onError }: {
  people: ApiSpendPerson[]; prices: ApiSpendPrices | null; defaults: ApiSpendPrices; ro: boolean; onSaved: () => void; onError: (e: string) => void;
}) {
  const { api } = useLive();
  const { dispatch } = useStore();
  const [people, setPeople] = useState(initial.map((p) => ({ email: p.email, name: p.name ?? '', aliases: (p.aliases ?? []).join(', ') })));
  const [prices, setPrices] = useState<ApiSpendPrices>({ seat: { ...(initialPrices?.seat ?? {}) }, personal: { ...(initialPrices?.personal ?? {}) } });
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const touch = () => setDirty(true);

  const save = async () => {
    setBusy(true);
    try {
      await api.send('PUT', '/pricing-leaks/settings', {
        people: people.filter((p) => p.email.trim()).map((p) => ({ email: p.email.trim(), name: p.name.trim(), aliases: p.aliases.split(',').map((a) => a.trim()).filter(Boolean) })),
        prices,
      });
      dispatch({ t: 'toast', text: 'Saved — the report uses the new people and prices' });
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
          touch();
        }} />
    );
  };

  return (
    <>
    <div className="grid-2">
      <Card>
        <CardHead info={HELP.spendPeople} title="People & aliases" sub="Joins vendor accounts and machines to one person. A machine’s owner (Machines) is used first; aliases cover the rest: a hostname, an OS user, github:login, or the name of a shared API key." />
        <div style={{ padding: '0 20px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {people.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No one yet. Most people match by their work email without an entry here.</div>}
          {people.map((p, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <input className="input mono" style={{ flex: '2 1 170px' }} placeholder="work email" value={p.email} disabled={ro} aria-label="Work email"
                onChange={(e) => { setPeople((ps) => ps.map((x, j) => (j === i ? { ...x, email: e.target.value } : x))); touch(); }} />
              <input className="input" style={{ flex: '1 1 110px' }} placeholder="name" value={p.name} disabled={ro} aria-label="Name"
                onChange={(e) => { setPeople((ps) => ps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x))); touch(); }} />
              <input className="input mono" style={{ flex: '3 1 220px' }} placeholder="dana-mbp, github:dana-k" value={p.aliases} disabled={ro} aria-label="Aliases"
                onChange={(e) => { setPeople((ps) => ps.map((x, j) => (j === i ? { ...x, aliases: e.target.value } : x))); touch(); }} />
              {!ro && <button className="btn sm" title="Remove" onClick={() => { setPeople((ps) => ps.filter((_, j) => j !== i)); touch(); }}><Ic n="trash" size={14} /></button>}
            </div>
          ))}
          {!ro && <div><button className="btn sm" onClick={() => setPeople((ps) => [...ps, { email: '', name: '', aliases: '' }])}><Ic n="plus" size={14} /> Add person</button></div>}
        </div>
      </Card>
      <Card>
        <CardHead info={HELP.spendPrices} title="Prices" sub="Monthly list prices used when a vendor doesn’t report one. Empty = the default shown. Personal plan prices size shadow spend." />
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
    </div>
    {!ro && (
      <div className="toolbar" style={{ position: 'sticky', bottom: 0, padding: '12px 0', background: 'var(--bg)' }}>
        <span className="muted" style={{ fontSize: 13 }}>{dirty ? 'Unsaved changes to people and prices.' : 'People and prices are saved.'}</span>
        <span className="grow" />
        <button className="btn primary" disabled={!dirty || busy} onClick={save}><Ic n="check" /> {busy ? 'Saving…' : 'Save people & prices'}</button>
      </div>
    )}
    </>
  );
}
