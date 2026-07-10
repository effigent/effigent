import { useEffect, useState } from 'react';

interface Rule {
  name: string;
  pattern: string;
  enabled: boolean;
}
interface RedactionState {
  rules: Rule[];
  builtins: string[];
  limits: { maxRules: number; maxPatternLength: number };
  canEdit: boolean;
  migrated: boolean;
}

/**
 * Privacy & Redaction — what never leaves raw. Built-ins are always on;
 * org admins add workspace-specific patterns (regex), applied at ingest.
 */
export function Privacy() {
  const [state, setState] = useState<RedactionState | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/v1/redaction')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: RedactionState | null) => {
        if (d) {
          setState(d);
          setRules(d.rules ?? []);
        }
      })
      .catch(() => {});
  }, []);

  const update = (i: number, patch: Partial<Rule>) =>
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch('/api/v1/redaction', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rules }),
      });
      const body = (await res.json()) as { rules?: Rule[]; error?: string; errors?: string[] };
      if (res.ok) {
        setRules(body.rules ?? rules);
        setStatus({ kind: 'ok', text: 'Saved — applied to every new ingest within a minute.' });
      } else {
        setStatus({ kind: 'err', text: body.errors?.join(' · ') ?? body.error ?? `HTTP ${res.status}` });
      }
    } catch {
      setStatus({ kind: 'err', text: 'Network error — not saved.' });
    } finally {
      setSaving(false);
    }
  };

  if (!state) return <div className="dag-empty">Loading redaction settings…</div>;
  const disabled = !state.canEdit;

  return (
    <div className="page-stack">
      <section className="panel panel-pad">
        <div className="mono-name" style={{ fontSize: 14 }}>Built-in filters — always on</div>
        <div className="panel-sub" style={{ marginBottom: 10 }}>
          Applied to every payload before storage or analysis. Values become typed placeholders like{' '}
          <code>[REDACTED:EMAIL]</code>.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {state.builtins.map((b) => (
            <span key={b} className="opt-badge" style={{ opacity: 0.85 }}>{b}</span>
          ))}
        </div>
      </section>

      <section className="panel panel-pad">
        <div className="mono-name" style={{ fontSize: 14 }}>Custom filters</div>
        <div className="panel-sub" style={{ marginBottom: 10 }}>
          Workspace-specific patterns (regular expressions) applied after the built-ins — internal
          ticket ids, hostnames, extra PII formats. Up to {state.limits.maxRules} rules,{' '}
          {state.limits.maxPatternLength} chars each.
          {!state.canEdit && ' Only organization admins can edit.'}
          {!state.migrated && ' (Schema migration pending — ask the workspace owner to run the ownership/redaction script.)'}
        </div>

        {rules.map((r, i) => (
          <div key={i} className="rule-row">
            <input
              className="rule-input"
              value={r.name}
              disabled={disabled}
              placeholder="NAME (e.g. TICKET_ID)"
              onChange={(e) => update(i, { name: e.target.value.toUpperCase() })}
              style={{ width: 190 }}
            />
            <input
              className="rule-input mono"
              value={r.pattern}
              disabled={disabled}
              placeholder={'pattern (e.g. JIRA-\\d+)'}
              onChange={(e) => update(i, { pattern: e.target.value })}
              style={{ flex: 1 }}
            />
            <label className="tgl" title={r.enabled ? 'Rule active — click to disable' : 'Rule disabled — click to enable'}>
              <input
                type="checkbox"
                checked={r.enabled}
                disabled={disabled}
                onChange={(e) => update(i, { enabled: e.target.checked })}
              />
              <span className="tgl-track" />
              <span className="tgl-knob" />
            </label>
            <button
              className="rule-x"
              disabled={disabled}
              onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}
              title="Remove rule"
            >
              ✕
            </button>
          </div>
        ))}

        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button
            className="btn-ghost"
            disabled={disabled || rules.length >= state.limits.maxRules}
            onClick={() => setRules((rs) => [...rs, { name: '', pattern: '', enabled: true }])}
          >
            + Add rule
          </button>
          <button className="btn-primary" disabled={disabled || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save rules'}
          </button>
        </div>
        {status && (
          <div
            className="foot-note"
            style={{ marginTop: 8, color: status.kind === 'err' ? 'var(--warn, #eb6834)' : undefined }}
          >
            {status.text}
          </div>
        )}
      </section>
    </div>
  );
}
