import { useState, useEffect, useMemo } from 'react';
import { installMethods, installStep1, collectorBase } from '../data.ts';
import { Ic } from '../icons.tsx';

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <div className="code">
      <button className="code-copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      <pre>{code}</pre>
    </div>
  );
}

interface KeyRow { id: string; label: string | null; role: string; created_at: string; agent: string | null }

/** Workspace credentials — where the tenant gets its id and mints its API key.
 *  The plaintext key is shown exactly once (only hashes are stored). */
function Credentials({ onKey }: { onKey: (k: string) => void }) {
  const [tenantId, setTenantId] = useState('');
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [fresh, setFresh] = useState('');
  const [minting, setMinting] = useState(false);
  const [copied, setCopied] = useState<'id' | 'key' | null>(null);

  const load = () =>
    fetch('/api/v1/keys')
      .then((r) => (r.ok ? r.json() : { keys: [] }))
      .then((d: { tenantId?: string; keys?: KeyRow[] }) => {
        if (d.tenantId) setTenantId(d.tenantId);
        setKeys(d.keys ?? []);
      })
      .catch(() => {});
  useEffect(() => { load(); }, []);

  const mint = () => {
    setMinting(true);
    fetch('/api/v1/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'workspace' }) })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { apiKey: string }) => { setFresh(d.apiKey); onKey(d.apiKey); load(); })
      .catch(() => {})
      .finally(() => setMinting(false));
  };
  const copy = (what: 'id' | 'key', v: string) => {
    navigator.clipboard?.writeText(v).then(() => { setCopied(what); setTimeout(() => setCopied(null), 1400); });
  };

  return (
    <section className="panel panel-pad" style={{ marginBottom: 16 }}>
      <div className="step-num">0</div>
      <div className="step-body">
        <div className="panel-title">Your workspace credentials</div>
        <div className="panel-sub" style={{ marginBottom: 14 }}>
          The workspace key is what <span className="mono-name" style={{ fontSize: 12 }}>effigent login</span> takes. Keys are stored hashed — the value is shown once, right here.
        </div>

        <div className="cred-row">
          <span className="cred-k">Tenant ID</span>
          <span className="mono-name cred-v">{tenantId || '…'}</span>
          {tenantId && <button className="btn-ghost cred-btn" onClick={() => copy('id', tenantId)}>{copied === 'id' ? 'Copied' : 'Copy'}</button>}
        </div>

        <div className="cred-row">
          <span className="cred-k">Workspace key</span>
          {fresh ? (
            <>
              <span className="mono-name cred-v" style={{ color: 'var(--green)' }}>{fresh}</span>
              <button className="btn-ghost cred-btn" onClick={() => copy('key', fresh)}>{copied === 'key' ? 'Copied' : 'Copy'}</button>
            </>
          ) : (
            <>
              <span className="cred-v" style={{ color: 'var(--txt-3)' }}>
                {keys.length ? `${keys.length} key${keys.length === 1 ? '' : 's'} exist — values are not retrievable` : 'no keys yet'}
              </span>
              <button className="btn-primary cred-btn" onClick={mint} disabled={minting}>
                {minting ? 'Generating…' : 'Generate key'}
              </button>
            </>
          )}
        </div>
        {fresh && (
          <div className="cred-warn">Save it now — this key can&apos;t be shown again. It&apos;s already filled into step 1 below.</div>
        )}
      </div>
    </section>
  );
}

export function Install({ onClose }: { onClose: () => void }) {
  const [base, setBase] = useState('');
  const [tenantKey, setTenantKey] = useState<string | undefined>(undefined);
  useEffect(() => { setBase(collectorBase()); }, []);

  const methods = useMemo(() => installMethods(base), [base]);
  const step1 = useMemo(() => installStep1(base, tenantKey), [base, tenantKey]);
  const [sel, setSel] = useState(methods[0].key);
  const method = methods.find((m) => m.key === sel)!;

  return (
    <div className="main-inner install-wrap">
      <header className="head">
        <div>
          <div className="install-back" onClick={onClose}><Ic n="arrowRight" style={{ width: 15, height: 15, transform: 'rotate(180deg)' }} /> Back to dashboard</div>
          <h1>Install Effigent on any agent</h1>
          <div className="sub">One scoped key per agent, then pick how it&apos;s captured. The graph/cost engine is the same for every harness.</div>
        </div>
      </header>

      <Credentials onKey={setTenantKey} />

      <section className="panel panel-pad" style={{ marginBottom: 16 }}>
        <div className="step-num">1</div>
        <div className="step-body">
          <div className="panel-title">{step1.label}</div>
          <CodeBlock code={step1.code} />
        </div>
      </section>

      <div className="step-num2">2 · Choose the capture method for your agent</div>
      <div className="install-grid">
        <div className="method-list">
          {methods.map((m) => (
            <button key={m.key} className={`method-item ${m.key === sel ? 'on' : ''}`} onClick={() => setSel(m.key)}>
              <span className="list-ico" style={{ background: `color-mix(in srgb, ${m.tint} 16%, transparent)`, color: m.tint }}>
                <Ic n={m.icon} />
              </span>
              <span className="method-item-txt">
                <span className="t">{m.name}</span>
                <span className="s">{m.tag}</span>
              </span>
            </button>
          ))}
        </div>

        <section className="panel panel-pad method-detail">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="list-ico" style={{ background: `color-mix(in srgb, ${method.tint} 16%, transparent)`, color: method.tint }}>
              <Ic n={method.icon} />
            </span>
            <div>
              <div className="panel-title">{method.name}</div>
              <div className="panel-sub">{method.tag}</div>
            </div>
          </div>
          <p style={{ color: 'var(--txt-2)', maxWidth: '62ch' }}>{method.blurb}</p>
          {method.steps.map((s, i) => (
            <div key={i} style={{ marginTop: 14 }}>
              <div className="step-label">{s.label}</div>
              <CodeBlock code={s.code} />
            </div>
          ))}
        </section>
      </div>

      <div className="foot-note" style={{ marginTop: 18 }}>
        Every method normalizes into the same execution graph — so cost, determinism, and optimizations look identical no matter which harness the agent runs on.
      </div>
    </div>
  );
}
