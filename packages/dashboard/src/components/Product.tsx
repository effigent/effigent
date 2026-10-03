import { useEffect, useState } from 'react';

export type ProductChoice = 'insights' | 'runtime' | 'both';

interface ProductState {
  product: ProductChoice;
  canEdit: boolean;
  migrated: boolean;
}

const OPTIONS: Array<{ key: ProductChoice; title: string; blurb: string }> = [
  {
    key: 'insights',
    title: 'Insights',
    blurb:
      'Capture runs from Claude Code, Codex or any OTel agent and read where the spend goes. Read-only — nothing in your agent changes.',
  },
  {
    key: 'runtime',
    title: 'Runtime',
    blurb:
      'Effigent at the model call: wrap your API agent’s client with @effigent/runtime, or start Claude Code with “effigent claude”. Policies run in shadow first and change nothing until you approve them.',
  },
  { key: 'both', title: 'Both', blurb: 'Insights on every captured session, plus the runtime for your API agents and Claude Code (“effigent claude”), in one workspace.' },
];

/**
 * Workspace → Product: which Effigent product this workspace uses. It decides which
 * views show and whether runtime uploads / the policies endpoint are accepted. It
 * never drops CLI captures. Org admins only.
 */
export function Product({ onSaved }: { onSaved: (p: ProductChoice) => void }) {
  const [state, setState] = useState<ProductState | null>(null);
  const [choice, setChoice] = useState<ProductChoice>('insights');
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/v1/product')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ProductState | null) => {
        if (d) {
          setState(d);
          setChoice(d.product);
        }
      })
      .catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch('/api/v1/product', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ product: choice }),
      });
      const body = (await res.json()) as { product?: ProductChoice; error?: string };
      if (res.ok && body.product) {
        setState((s) => (s ? { ...s, product: body.product! } : s));
        onSaved(body.product);
        setStatus({ kind: 'ok', text: 'Saved. Uploads pick up the change within a minute.' });
      } else {
        setStatus({ kind: 'err', text: body.error ?? `HTTP ${res.status}` });
      }
    } catch {
      setStatus({ kind: 'err', text: 'Network error — not saved.' });
    } finally {
      setSaving(false);
    }
  };

  if (!state) return <div className="dag-empty">Loading product settings…</div>;
  const disabled = !state.canEdit || !state.migrated;

  return (
    <div className="page-stack">
      <section className="panel panel-pad">
        <div className="mono-name" style={{ fontSize: 14 }}>Which Effigent does this workspace use?</div>
        <div className="panel-sub" style={{ marginBottom: 12 }}>
          You can change this at any time. Captured sessions are kept whatever you choose.
          {!state.canEdit && ' Only organization admins can change it.'}
          {!state.migrated && ' (Schema migration pending — ask the workspace owner to run scripts/apply-tenant-product.mjs.)'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {OPTIONS.map((o) => (
            <label
              key={o.key}
              className="panel panel-pad"
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
                cursor: disabled ? 'default' : 'pointer',
                borderColor: choice === o.key ? 'var(--accent-line)' : undefined,
              }}
            >
              <input
                type="radio"
                name="product"
                value={o.key}
                checked={choice === o.key}
                disabled={disabled}
                onChange={() => setChoice(o.key)}
                style={{ marginTop: 3 }}
              />
              <div>
                <div className="mono-name" style={{ fontSize: 13 }}>
                  {o.title}
                  {state.product === o.key && (
                    <span className="opt-badge" style={{ marginLeft: 8, opacity: 0.85 }}>current</span>
                  )}
                </div>
                <div className="panel-sub">{o.blurb}</div>
              </div>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn-primary" disabled={disabled || saving || choice === state.product} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {status && (
          <div className="foot-note" style={{ marginTop: 8, color: status.kind === 'err' ? 'var(--warn, #eb6834)' : undefined }}>
            {status.text}
          </div>
        )}
      </section>
    </div>
  );
}
