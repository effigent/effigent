import { useState, useEffect } from 'react';
import { ALL_AGENTS } from '../data.ts';

interface SessionRow {
  session_id: string;
  agent_id: string;
  started_at: string | null;
  cost_usd: string | number;
  n_steps: number;
  models: string[];
}

export function Sessions({ agent }: { agent: string }) {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const q = agent && agent !== ALL_AGENTS ? `?agent=${encodeURIComponent(agent)}` : '';
    fetch(`/api/v1/sessions${q}`)
      .then((r) => (r.ok ? r.json() : { sessions: [] }))
      .then((d: { sessions?: SessionRow[] }) => setRows(d.sessions ?? []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [agent]);

  const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString() : '—');
  const fmtCost = (c: string | number) => `$${Number(c).toFixed(2)}`;

  return (
    <section className="panel" style={{ overflow: 'hidden' }}>
      <div className="tbl-scroll">
        <table>
          <thead>
            <tr>
              <th>Session</th><th>Agent</th><th>Started</th><th>Steps</th><th>Cost</th><th>Models</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.session_id}>
                <td className="mono-name">{r.session_id}</td>
                <td>{r.agent_id}</td>
                <td style={{ color: 'var(--txt-2)' }}>{fmtDate(r.started_at)}</td>
                <td className="tnum">{r.n_steps}</td>
                <td className="tnum">{fmtCost(r.cost_usd)}</td>
                <td style={{ color: 'var(--txt-2)', fontSize: 12 }}>{(r.models ?? []).join(', ')}</td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={6} style={{ color: 'var(--txt-3)', padding: '28px 16px', textAlign: 'center' }}>
                No sessions yet for this workspace. Install Optimizer on an agent (or run the seed) and its runs show up here.
              </td></tr>
            )}
            {loading && (
              <tr><td colSpan={6} style={{ color: 'var(--txt-3)', padding: '28px 16px', textAlign: 'center' }}>Loading…</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
