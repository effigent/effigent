import { Ic } from '../icons.tsx';

interface AgentInfo { agent_id: string; optimized: boolean; n_runs: number; total_cost_usd: string | number }

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Real-tenant overview — live totals only, no sample numbers. Empty state
 *  points at the install flow until the first run lands. */
export function OverviewLive({
  agents,
  onInstall,
  onSessions,
  onInsights,
}: {
  agents: AgentInfo[];
  onInstall: () => void;
  onSessions: () => void;
  onInsights: () => void;
}) {
  const sessions = agents.reduce((s, a) => s + (a.n_runs ?? 0), 0);
  const spend = agents.reduce((s, a) => s + Number(a.total_cost_usd ?? 0), 0);
  const optimized = agents.filter((a) => a.optimized).length;

  if (agents.length === 0) {
    return (
      <section className="panel panel-pad" style={{ textAlign: 'center', padding: '72px 24px' }}>
        <div style={{ display: 'inline-grid', placeItems: 'center', width: 52, height: 52, borderRadius: 14, background: 'var(--accent-bg)', color: 'var(--accent-2)', marginBottom: 18 }}>
          <Ic n="spark" style={{ width: 24, height: 24 }} />
        </div>
        <h2 style={{ margin: '0 0 8px', fontSize: 20 }}>Connect your first agent</h2>
        <p style={{ color: 'var(--txt-2)', maxWidth: '46ch', margin: '0 auto 22px', lineHeight: 1.6 }}>
          Install Effigent on an agent and every run will land here as an execution graph —
          cost, models, and optimization opportunities included.
        </p>
        <button className="btn-primary" onClick={onInstall} style={{ height: 42, padding: '0 22px' }}>
          <Ic n="spark" style={{ width: 15, height: 15 }} /> Install Effigent
        </button>
      </section>
    );
  }

  return (
    <div className="page-stack">
      <div className="sess-totals">
        <div className="totstat"><span className="k">Agents</span><span className="v tnum">{agents.length}</span></div>
        <div className="totstat"><span className="k">Sessions captured</span><span className="v tnum">{sessions.toLocaleString('en-US')}</span></div>
        <div className="totstat"><span className="k">Observed spend</span><span className="v tnum">{usd(spend)}</span></div>
        <div className="totstat"><span className="k">Agents optimized</span><span className="v tnum">{optimized}/{agents.length}</span></div>
      </div>

      <div className="live-cards">
        <button className="live-card" onClick={onSessions}>
          <Ic n="list" style={{ width: 18, height: 18, color: 'var(--blue)' }} />
          <div>
            <div className="t">Sessions</div>
            <div className="s">Every captured run — trace, cost, and models per session.</div>
          </div>
          <Ic n="arrowRight" style={{ width: 15, height: 15, color: 'var(--txt-4)' }} />
        </button>
        <button className="live-card" onClick={onInsights}>
          <Ic n="bulb" style={{ width: 18, height: 18, color: 'var(--gold)' }} />
          <div>
            <div className="t">Optimization Insights</div>
            <div className="s">Deterministic steps to replace, memoize, template, or route.</div>
          </div>
          <Ic n="arrowRight" style={{ width: 15, height: 15, color: 'var(--txt-4)' }} />
        </button>
        <button className="live-card" onClick={onInstall}>
          <Ic n="spark" style={{ width: 18, height: 18, color: 'var(--accent-2)' }} />
          <div>
            <div className="t">Add another agent</div>
            <div className="s">One scoped key per agent — capture in under two minutes.</div>
          </div>
          <Ic n="arrowRight" style={{ width: 15, height: 15, color: 'var(--txt-4)' }} />
        </button>
      </div>
    </div>
  );
}
