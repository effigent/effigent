import { useState, useEffect } from 'react';
import { ALL_AGENTS } from '../data.ts';
import { Ic } from '../icons.tsx';
import { AgentTools } from './AgentTools.tsx';

interface SessionRow {
  session_id: string;
  agent_id: string;
  started_at: string | null;
  cost_usd: string | number;
  n_steps: number;
  models: string[];
}
interface AgentInfo { agent_id: string; optimized: boolean; n_runs: number; total_cost_usd: string | number; added_by?: string | null }

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
  const PAGE = 50;
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [qDebounced, setQDebounced] = useState('');

  // Debounce the search box; search runs server-side so it spans every page.
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  // New filter → back to page 1.
  useEffect(() => { setPage(0); }, [agent, qDebounced]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (agent && agent !== ALL_AGENTS) params.set('agent', agent);
    if (qDebounced) params.set('q', qDebounced);
    params.set('limit', String(PAGE));
    params.set('offset', String(page * PAGE));
    fetch(`/api/v1/sessions?${params}`)
      .then((r) => (r.ok ? r.json() : { sessions: [], total: 0 }))
      .then((d: { sessions?: SessionRow[]; total?: number }) => {
        setRows(d.sessions ?? []);
        setTotal(d.total ?? 0);
      })
      .catch(() => { setRows([]); setTotal(0); })
      .finally(() => setLoading(false));
  }, [agent, qDebounced, page]);
  const pages = Math.max(1, Math.ceil(total / PAGE));

  // Totals from the server-aggregated agent list (accurate across all runs).
  const scopedAgents = agent === ALL_AGENTS ? agents : agents.filter((a) => a.agent_id === agent);
  const totalSessions = scopedAgents.reduce((s, a) => s + (a.n_runs ?? 0), 0);
  const totalCost = scopedAgents.reduce((s, a) => s + Number(a.total_cost_usd ?? 0), 0);


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

      {/* injected-tool registry for the selected agent (per-tool disable) */}
      {agent !== ALL_AGENTS && <AgentTools agent={agent} />}

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
                {a.added_by && <span title="who registered this agent">added by <b>{a.added_by}</b></span>}
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
        <span className="sess-search-count tnum">{total.toLocaleString()} match{total === 1 ? '' : 'es'}</span>
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
              {rows.map((r) => {
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
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="tbl-empty">
                    {qDebounced
                      ? `No sessions match “${qDebounced}”.`
                      : 'No sessions yet for this workspace. Install Effigent on an agent and its runs show up here.'}
                  </td>
                </tr>
              )}
              {loading && <tr><td colSpan={7} className="tbl-empty">Loading…</td></tr>}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="pager">
            <button className="btn-ghost pager-btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              ← Prev
            </button>
            <span className="pager-info tnum">
              {page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total.toLocaleString()}
            </span>
            <button className="btn-ghost pager-btn" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
              Next →
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
