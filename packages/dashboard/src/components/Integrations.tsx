'use client';

import { useCallback, useEffect, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { ApiError, apiErrorText } from '@/lib/api.ts';
import { ago } from '@/lib/live-map.ts';
import { Card, CardHead, CodeBlock, ReadOnlyNote } from '@/components/ui.tsx';

interface ApiKey {
  id: string; name: string; prefix: string; scopes: string[]; created_by: string; created_at: string;
  expires_at: string | null; last_used_at: string | null; revoked: boolean; key?: string;
}
interface Webhook {
  id: string; name: string; url_hint: string; events: string[]; enabled: boolean; created_at: string;
  last_status: number | null; last_error: string; last_attempt_at: string | null; dropped: number; secret?: string;
}
interface Delivery { id: number; event_type: string; attempts: number; state: string; last_status: number | null; last_error: string; created_at: string }

const SCOPES: { id: string; label: string }[] = [
  { id: 'approvals', label: 'Decide approvals' },
  { id: 'endpoints', label: 'Enroll & revoke machines' },
  { id: 'policy', label: 'Publish policy' },
];
const EVENTS: { id: string; label: string }[] = [
  { id: 'approval.requested', label: 'Approval requested' },
  { id: 'approval.decided', label: 'Approval decided' },
  { id: 'action.blocked', label: 'Action blocked (busy: max 60/min)' },
  { id: 'endpoint.enrolled', label: 'Machine enrolled' },
  { id: 'endpoint.revoked', label: 'Machine revoked' },
  { id: 'policy.published', label: 'Policy published' },
];

const OLD_CP = 'The control plane does not support integrations yet — it needs to be updated.';
const errText = (e: unknown) => (e instanceof ApiError && e.status === 404 ? OLD_CP : apiErrorText(e));

function Checks({ items, value, onChange, disabled }: { items: { id: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; disabled: boolean }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
      {items.map((i) => (
        <label key={i.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={value.includes(i.id)} disabled={disabled}
            onChange={(e) => onChange(e.target.checked ? [...value, i.id] : value.filter((x) => x !== i.id))} />
          {i.label}
        </label>
      ))}
    </div>
  );
}

/** API keys and outbound webhooks: how Windmill, Tines, Torq or a script
 *  drive Effigent and hear from it. Managed by people only. */
export function Integrations() {
  const { api, canWrite, now } = useLive();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ kind: 'key' | 'webhook'; text: string } | null>(null);
  const [keyName, setKeyName] = useState('');
  const [keyScopes, setKeyScopes] = useState<string[]>(['approvals']);
  const [hookName, setHookName] = useState('');
  const [hookURL, setHookURL] = useState('');
  const [hookEvents, setHookEvents] = useState<string[]>(['approval.requested', 'approval.decided']);
  const [open, setOpen] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [testRes, setTestRes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [k, h] = await Promise.all([api.get<ApiKey[]>('/api-keys'), api.get<Webhook[]>('/webhooks')]);
      setKeys(k); setHooks(h); setErr(null);
    } catch (e) { setErr(errText(e)); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const run = async (f: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await f(); await load(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const createKey = () => run(async () => {
    const k = await api.send<ApiKey>('POST', '/api-keys', { name: keyName.trim(), scopes: keyScopes });
    setMade({ kind: 'key', text: k.key ?? '' }); setKeyName('');
  });
  const createHook = () => run(async () => {
    const h = await api.send<Webhook>('POST', '/webhooks', { name: hookName.trim(), url: hookURL.trim(), events: hookEvents });
    setMade({ kind: 'webhook', text: h.secret ?? '' }); setHookName(''); setHookURL('');
  });
  const test = (id: string) => run(async () => {
    const r = await api.send<{ ok: boolean; status: number; error?: string }>('POST', `/webhooks/${id}/test`);
    setTestRes((t) => ({ ...t, [id]: r.ok ? `Delivered (HTTP ${r.status})` : `Failed: ${r.error ?? r.status}` }));
  });
  const showDeliveries = async (id: string) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    try { setDeliveries(await api.get<Delivery[]>(`/webhooks/${id}/deliveries?limit=10`)); } catch (e) { setErr(errText(e)); }
  };
  const t = (s: string | null) => (s ? ago(Date.parse(s), now) : 'never');

  return (
    <Card>
      <CardHead title="Integrations" sub="Let Windmill, Tines, Torq or your own scripts act on Effigent (API keys) and react to it (webhooks)." />
      {made && (
        <div style={{ padding: '0 20px 14px' }}>
          <div className="callout warn" style={{ margin: '0 0 8px' }}><Ic n="key" size={16} />
            <span>{made.kind === 'key' ? 'Your API key — copy it now, it is shown once.' : 'Signing secret — copy it now; use it to verify X-Effigent-Signature.'}
              {' '}<button className="btn sm" onClick={() => setMade(null)}>Done</button></span>
          </div>
          <CodeBlock code={made.text} />
        </div>
      )}
      {err && <div className="callout bad" style={{ margin: '0 20px 14px' }}><Ic n="alert" size={16} /><span>{err}</span></div>}

      <div className="section-label" style={{ margin: '4px 20px 6px' }}>API keys</div>
      <div style={{ padding: '0 20px' }}>
        {keys?.filter((k) => !k.revoked).map((k) => (
          <div key={k.id} className="setting-row" style={{ padding: '8px 0' }}>
            <div>
              <div className="setting-title">{k.name} <code className="mono-sm muted">{k.prefix}…</code></div>
              <div className="setting-desc">{k.scopes.join(', ')} · used {t(k.last_used_at)} · created {t(k.created_at)}</div>
            </div>
            <button className="btn sm" disabled={!canWrite || busy} onClick={() => run(async () => { await api.send('DELETE', `/api-keys/${k.id}`); })}>Revoke</button>
          </div>
        ))}
        {keys && keys.filter((k) => !k.revoked).length === 0 && <div className="muted" style={{ fontSize: 13, padding: '4px 0 8px' }}>No API keys yet.</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '6px 0 4px' }}>
          <input className="input" style={{ flex: '1 1 180px' }} placeholder="Name, e.g. windmill" value={keyName} disabled={!canWrite} onChange={(e) => setKeyName(e.target.value)} aria-label="API key name" />
          <button className="btn sm" disabled={!canWrite || busy || !keyName.trim()} onClick={createKey}><Ic n="key" /> Create key</button>
        </div>
        <div style={{ padding: '4px 0 14px' }}><Checks items={SCOPES} value={keyScopes} onChange={setKeyScopes} disabled={!canWrite} /><div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Every key can read. Keys can never create keys or webhooks.</div></div>
      </div>

      <div className="section-label" style={{ margin: '4px 20px 6px' }}>Webhooks</div>
      <div style={{ padding: '0 20px' }}>
        {hooks?.map((h) => (
          <div key={h.id} style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
            <div className="setting-row" style={{ padding: 0 }}>
              <div style={{ minWidth: 0 }}>
                <div className="setting-title">{h.name || 'Webhook'} <code className="mono-sm muted">{h.url_hint}</code></div>
                <div className="setting-desc">
                  {h.events.join(', ')} · last {h.last_attempt_at ? <>{t(h.last_attempt_at)}: <span style={h.last_error ? { color: 'var(--red)' } : undefined}>{h.last_error || `HTTP ${h.last_status}`}</span></> : 'never sent'}
                  {h.dropped > 0 && <> · {h.dropped} blocked events over the cap</>}
                </div>
                {testRes[h.id] && <div className="setting-desc">{testRes[h.id]}</div>}
              </div>
              <span style={{ display: 'flex', gap: 6 }}>
                <button className="btn sm" disabled={!canWrite || busy} onClick={() => test(h.id)}>Send test</button>
                <button className="btn sm" onClick={() => showDeliveries(h.id)}>{open === h.id ? 'Hide' : 'Deliveries'}</button>
                <button className="btn sm" disabled={!canWrite || busy} onClick={() => run(async () => { await api.send('DELETE', `/webhooks/${h.id}`); })}>Delete</button>
              </span>
            </div>
            {open === h.id && (
              <div className="muted" style={{ fontSize: 12, padding: '6px 0 0' }}>
                {deliveries.length === 0 ? 'No deliveries yet.' : deliveries.map((d) => (
                  <div key={d.id}>{t(d.created_at)} · {d.event_type} · {d.state}{d.last_status ? ` (HTTP ${d.last_status})` : ''}{d.attempts > 1 ? ` · ${d.attempts} attempts` : ''}{d.last_error && d.state !== 'delivered' ? ` · ${d.last_error}` : ''}</div>
                ))}
              </div>
            )}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 0 4px', borderTop: hooks?.length ? '1px solid var(--border)' : undefined }}>
          <input className="input" style={{ flex: '0 1 140px' }} placeholder="Name" value={hookName} disabled={!canWrite} onChange={(e) => setHookName(e.target.value)} aria-label="Webhook name" />
          <input className="input mono" style={{ flex: '1 1 260px' }} placeholder="https://… (e.g. a Windmill route or webhook URL)" value={hookURL} disabled={!canWrite} onChange={(e) => setHookURL(e.target.value)} aria-label="Webhook URL" />
          <button className="btn sm" disabled={!canWrite || busy || !hookURL.trim() || hookEvents.length === 0} onClick={createHook}><Ic n="plus" /> Add webhook</button>
        </div>
        <div style={{ padding: '4px 0 14px' }}><Checks items={EVENTS} value={hookEvents} onChange={setHookEvents} disabled={!canWrite} /></div>
      </div>
      {!canWrite && <div style={{ padding: '0 20px 14px' }}><ReadOnlyNote what="manage integrations" /></div>}
      <div className="muted" style={{ padding: '0 20px 18px', fontSize: 13 }}>
        Each webhook POSTs JSON <code>{'{ id, type, created_at, tenant, data }'}</code>, signed <code>X-Effigent-Signature: t=…,v1=HMAC-SHA256(secret, &quot;t.body&quot;)</code>; failed deliveries are retried for about 9 hours. The URL is stored but never shown again — it can carry the receiver&apos;s token.
      </div>
    </Card>
  );
}
