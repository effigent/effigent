import { useState, useEffect, useMemo } from 'react';
import { installMethods, installStep1, collectorBase, agentInstallPrompt } from '../data.ts';
import { Ic } from '../icons.tsx';

function CodeBlock({ code, wrap }: { code: string; wrap?: boolean }) {
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
      <pre className={wrap ? 'wrap' : undefined}>{code}</pre>
    </div>
  );
}

interface KeyRow { id: string; label: string | null; role: string; created_at: string; agent: string | null }

/** Step 1 — get the workspace key. Plainly framed: it links the agent to this
 *  workspace and auto-fills the rest. The plaintext key is shown exactly once. */
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
      <div className="step-num">1</div>
      <div className="step-body">
        <div className="panel-title">Get your key</div>
        <div className="panel-sub" style={{ marginBottom: 14 }}>
          This one key links your agent to this workspace. Click <b>Generate</b> — it&apos;s shown only once and fills itself into the steps below automatically.
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
                {keys.length ? `${keys.length} key${keys.length === 1 ? '' : 's'} already exist — for security, their values can't be shown again, so generate a new one` : 'no key yet'}
              </span>
              <button className="btn-primary cred-btn" onClick={mint} disabled={minting}>
                {minting ? 'Generating…' : 'Generate'}
              </button>
            </>
          )}
        </div>
        {fresh && (
          <div className="cred-warn">Copy it somewhere safe now — it can&apos;t be shown again. (It&apos;s already filled into the steps below.)</div>
        )}
        {tenantId && (
          <div className="foot-note" style={{ marginTop: 10 }}>
            Workspace ID: <span className="mono-name" style={{ fontSize: 11.5 }}>{tenantId}</span>{' '}
            <button className="link" style={{ background: 'none', border: 'none', padding: 0 }} onClick={() => copy('id', tenantId)}>{copied === 'id' ? 'copied' : 'copy'}</button>
            {' '}— only needed for advanced setups.
          </div>
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
          <div className="sub">About two minutes. Get your key, pick the tool your agent runs in, then let your agent install it for you — or run a few commands yourself.</div>
        </div>
      </header>

      <Credentials onKey={setTenantKey} />

      <div className="step-num2">2 · Which tool runs your agent?</div>
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

          {/* Recommended, no-terminal path — front and center. */}
          <div className="install-option recommended">
            <div className="install-option-head">
              <span className="opt-tag">Easiest</span>
              <Ic n="spark" style={{ width: 15, height: 15, color: 'var(--accent-2)' }} />
              Let your agent install it for you
            </div>
            <div className="panel-sub" style={{ marginBottom: 10, maxWidth: '62ch' }}>
              No terminal needed. Copy this, paste it to your agent ({method.name}), and it sets everything up on its own — then confirms it worked.
            </div>
            <CodeBlock code={agentInstallPrompt(method.key, base, tenantKey)} wrap />
            <div className="foot-note" style={{ marginTop: 8 }}>
              {tenantKey
                ? 'This includes your workspace key — only paste it into an agent you trust.'
                : 'Generate your key in step 1 above and it fills in here automatically.'}
            </div>
          </div>

          {/* Manual path — collapsed so it doesn't scare anyone off. */}
          <details className="install-manual">
            <summary>Prefer to run the commands yourself?</summary>
            <div className="panel-sub" style={{ margin: '10px 0' }}>
              Paste these into a terminal, in order. You&apos;ll need <b>Node.js</b> installed first (nodejs.org).
            </div>
            <div className="step-label">1 · Install Effigent and connect it to your workspace</div>
            <CodeBlock code={step1.code} />
            {method.steps.map((s, i) => (
              <div key={i} style={{ marginTop: 14 }}>
                <div className="step-label">{i + 2} · {s.label}</div>
                <CodeBlock code={s.code} />
              </div>
            ))}
          </details>
        </section>
      </div>

      <div className="foot-note" style={{ marginTop: 18 }}>
        However you install it, every run shows up here the same way — same graphs, same cost, same optimizations, whatever tool your agent runs on.
      </div>
    </div>
  );
}
