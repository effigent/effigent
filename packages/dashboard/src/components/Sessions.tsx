import { useState, useEffect, useMemo } from 'react';
import { ALL_AGENTS } from '../data.ts';
import { Ic } from '../icons.tsx';

interface SessionRow {
  session_id: string;
  agent_id: string;
  started_at: string | null;
  cost_usd: string | number;
  n_steps: number;
  models: string[];
}
interface AgentInfo { agent_id: string; optimized: boolean; n_runs: number; total_cost_usd: string | number }

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function Sessions({
  agent,
  agents,
  optimizedAgents,
  onOpen,
  onSelectAgent,
}: {
  agent: string;
  agents: AgentInfo[];
  optimizedAgents: Set<string>;
  onOpen: (sessionId: string, optimized: boolean) => void;
  onSelectAgent: (agent: string) => void;
}) {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');

  useEffect(() => {
    setLoading(true);
    const query = agent && agent !== ALL_AGENTS ? `?agent=${encodeURIComponent(agent)}` : '';
    fetch(`/api/v1/sessions${query}`)
      .then((r) => (r.ok ? r.json() : { sessions: [] }))
      .then((d: { sessions?: SessionRow[] }) => setRows(d.sessions ?? []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [agent]);

  // Totals from the server-aggregated agent list (accurate across all runs).
  const scopedAgents = agent === ALL_AGENTS ? agents : agents.filter((a) => a.agent_id === agent);
  const totalSessions = scopedAgents.reduce((s, a) => s + (a.n_runs ?? 0), 0);
  const totalCost = scopedAgents.reduce((s, a) => s + Number(a.total_cost_usd ?? 0), 0);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? rows.filter((r) => r.session_id.toLowerCase().includes(needle)) : rows;
  }, [rows, q]);

  const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString() : '—');
  const fmtCost = (c: string | number) => `$${Number(c).toFixed(2)}`;

  return (
    <div className="page-stack">
      {/* totals */}
      <div className="sess-totals">
        <div className="totstat">
          <span className="k">{agent === ALL_AGENTS ? 'Agents' : 'Agent'}</span>
          <span className="v tnum">{agent === ALL_AGENTS ? agents.length : 1}</span>
        </div>
        <div className="totstat">
          <span className="k">Sessions</span>
          <span className="v tnum">{totalSessions.toLocaleString('en-US')}</span>
        </div>
        <div className="totstat">
          <span className="k">Total spend</span>
          <span className="v tnum">{usd(totalCost)}</span>
        </div>
      </div>

      {/* per-agent totals (only in the all-agents view) */}
      {agent === ALL_AGENTS && agents.length > 0 && (
        <div className="agent-cards">
          {agents.map((a) => (
            <button key={a.agent_id} className="agent-card" onClick={() => onSelectAgent(a.agent_id)}>
              <div className="agent-card-top">
                <span className="agent-card-name">{a.agent_id}</span>
                {optimizedAgents.has(a.agent_id) && (
                  <span className="opt-badge"><Ic n="spark" style={{ width: 10, height: 10 }} /> Optimized</span>
                )}
              </div>
              <div className="agent-card-stats">
                <span><b className="tnum">{a.n_runs}</b> sessions</span>
                <span><b className="tnum">{fmtCost(a.total_cost_usd)}</b> spent</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* session-id search */}
      <div className="sess-search">
        <Ic n="search" style={{ width: 15, height: 15, opacity: 0.7 }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by session id…"
          spellCheck={false}
        />
        {q && <button className="sess-search-clear" onClick={() => setQ('')} aria-label="clear">×</button>}
        <span className="sess-search-count">{filtered.length} shown</span>
      </div>

      <section className="panel tbl-panel">
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Session</th>
                <th>Agent</th>
                <th>Started</th>
                <th className="num">Steps</th>
                <th className="num">Cost</th>
                <th>Models</th>
                <th aria-label="open" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const opt = optimizedAgents.has(r.agent_id);
                return (
                  <tr key={r.session_id} className="row-click" onClick={() => onOpen(r.session_id, opt)}>
                    <td className="mono-name">{r.session_id}</td>
                    <td>
                      <span className="agent-cell">
                        {r.agent_id}
                        {opt && <span className="opt-badge" title="Effigent has run on this agent"><Ic n="spark" style={{ width: 10, height: 10 }} /> Optimized</span>}
                      </span>
                    </td>
                    <td className="muted">{fmtDate(r.started_at)}</td>
                    <td className="num tnum">{r.n_steps}</td>
                    <td className="num tnum">{fmtCost(r.cost_usd)}</td>
                    <td>
                      <span className="model-chips">
                        {(r.models ?? []).map((m) => <span key={m} className="chip">{m}</span>)}
                      </span>
                    </td>
                    <td className="go"><Ic n="arrowRight" style={{ width: 15, height: 15 }} /></td>
                  </tr>
                );
              })}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="tbl-empty">
                    {rows.length === 0
                      ? 'No sessions yet for this workspace. Install Effigent on an agent (or run the seed) and its runs show up here.'
                      : `No sessions match “${q}”.`}
                  </td>
                </tr>
              )}
              {loading && <tr><td colSpan={7} className="tbl-empty">Loading…</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
