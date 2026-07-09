import { kgCoverage, agentFactor, ALL_AGENTS } from '../data.ts';
import { Donut } from '../charts.tsx';

/** Knowledge Graph the agents retrieve against instead of re-deriving context
 *  with LLM calls. Scoped to the selected agent. (Demo-backed until the KG engine lands.) */
export function KnowledgeGraph({ agent }: { agent: string }) {
  const scoped = agent !== ALL_AGENTS;
  const f = scoped ? agentFactor(agent) : 1;
  const pct = scoped ? Math.round(kgCoverage.pct * (0.75 + f * 0.4)) : kgCoverage.pct;
  const rows = kgCoverage.rows.map((r) => {
    const raw = Number(r.v.replace(/,/g, ''));
    const v = scoped ? Math.max(1, Math.round(raw * f)) : raw;
    return { ...r, v: v.toLocaleString('en-US') };
  });

  return (
    <div className="page-stack">
      <section className="panel panel-pad">
        <div className="panel-title" style={{ marginBottom: 4 }}>
          Knowledge Graph coverage {scoped ? <span className="kg-scope">· {agent}</span> : <span className="kg-scope">· all agents</span>}
        </div>
        <div className="panel-sub" style={{ marginBottom: 18 }}>
          Entities Effigent indexed from {scoped ? `${agent}'s` : 'your agents’'} runs, retrieved deterministically in place of LLM lookups.
        </div>
        <div className="kg-layout">
          <div className="kg-donut">
            <Donut segments={[{ value: pct, color: 'var(--cyan)' }, { value: 100 - pct, color: 'transparent' }]} size={148} thickness={14}>
              <div style={{ textAlign: 'center' }}>
                <div className="tnum" style={{ fontSize: 30, fontWeight: 750, lineHeight: 1 }}>{pct}%</div>
                <div style={{ fontSize: 11, color: 'var(--txt-3)', marginTop: 2 }}>indexed</div>
              </div>
            </Donut>
          </div>
          <div className="kg-entities">
            {rows.map((r) => (
              <div key={r.l} className="kg-entity">
                <span className="k"><i className="dot" style={{ background: r.color, boxShadow: 'none' }} /> {r.l}</span>
                <span className="v tnum">{r.v}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="foot-note" style={{ marginTop: 16 }}>
          {scoped ? 'Scoped to the selected agent. Switch the agent filter to compare.' : 'Select an agent to see its own graph.'}
        </div>
      </section>
    </div>
  );
}
