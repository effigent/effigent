'use client';

import { HELP } from '@/lib/help.tsx';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { ApiError, apiErrorText, type ApiSpendConnector, type ApiSpendConnectors, type ApiSpendImport } from '@/lib/api.ts';
import { Card, CardHead, Loading, ReadOnlyNote } from '@/components/ui.tsx';

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

export const ago = (iso?: string) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 0) { // the future: the next scheduled sync
    const f = -m;
    return f < 60 ? `in ${f} min` : f < 60 * 36 ? `in ${Math.round(f / 60)} h` : `in ${Math.round(f / 1440)} days`;
  }
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 60 * 36 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** Settings → AI vendors: admin API keys (sealed on the control plane, never
 *  shown again) and CSV imports that feed Pricing Leaks. */
export function SpendVendors() {
  const { api, canWrite, fixture } = useLive();
  const { dispatch } = useStore();
  const [data, setData] = useState<ApiSpendConnectors | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ro = !canWrite;

  const load = useCallback(() => api.get<ApiSpendConnectors>('/pricing-leaks/connectors')
    .then((d) => { setData(d); setErr(null); })
    .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? 'The control plane does not support Pricing Leaks yet — it needs to be updated.' : apiErrorText(e))), [api]);
  useEffect(() => { void load(); }, [load]);
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

  return (
    <Card>
      <CardHead info={HELP.connectors} title="AI vendors" sub="Admin API keys for the AI coding tools you pay for, so Pricing Leaks can compare seats and spend with what effigentd sees. Keys are encrypted on the control plane and never shown again (only their last 4 characters). Each vendor syncs once a day and when you save a key; no API access? Upload the vendor’s CSV export.">
        {ro ? <ReadOnlyNote what="connect vendors" />
          : data?.connectors.some((c) => c.configured) && <button className="btn sm" onClick={syncNow} disabled={syncing}><Ic n="rotate" size={14} /> {syncing ? 'Syncing…' : 'Sync now'}</button>}
      </CardHead>
      {err && <div className="callout bad" style={{ margin: '0 20px 12px' }}><Ic n="alert" size={16} /><span>{err}</span></div>}
      {!data ? (!err && <Loading />) : (
        <>
          {!data.secrets_available && !fixture && (
            <div className="callout warn" style={{ margin: '0 20px 12px' }}><Ic n="lock" size={14} /><span>This control plane has no <code>EFFIGENT_SECRETS_KEY</code>, so it can’t store vendor keys. CSV import works.</span></div>
          )}
          <div className="grid-2" style={{ padding: '0 20px 14px', gap: 12 }}>
            {data.connectors.map((c) => <Connector key={c.vendor} c={c} ro={ro} canStore={data.secrets_available || fixture} onChange={load} onError={setErr} />)}
          </div>
          <div className="muted" style={{ padding: '0 20px 18px', fontSize: 13 }}>
            The leaks, spend and prices are on <Link href="/pricing-leaks" className="view-all">Pricing Leaks</Link>; who is who on <Link href="/identity" className="view-all">People</Link>.
          </div>
        </>
      )}
    </Card>
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
  const next = c.configured && c.next_poll_at && c.sync_status !== 'running'
    ? ` · ${c.failures ? `retrying (${c.failures} failed)` : 'next sync'} ${ago(c.next_poll_at)}` : '';

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b style={{ flex: 1 }}>{c.label}</b>{status}
      </div>
      <div className="muted" style={{ fontSize: 12.5 }}>
        {c.configured ? <>Key ••••{c.key_hint} · synced {ago(c.last_sync_at)}{next}{c.last_counts ? ` · ${c.last_counts.seats ?? 0} seats, ${c.last_counts.usage_rows ?? 0} usage rows` : ''}{c.settings?.org ? ` · org ${c.settings.org}` : ''}</> : help.key}
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
