import { useEffect, useState } from 'react';
import { ALL_AGENTS } from '../data.ts';

interface SynthTool {
  id: string;
  name: string;
  steps: number;
  tools: string[];
  params: { name: string; type: string; source: string }[];
  guarded: boolean;
  separability: string;
  evidence: { runs: number; support: number };
  savings: { perRunUsd: number; windowUsd: number };
  replay?: { runsChecked: number; passRate: number; status: string };
}
interface AgentInsight {
  agentId: string;
  tools?: SynthTool[];
}
type Row = SynthTool & { agentId: string };

const usd = (n: number) => `$${n.toFixed(4)}`;

/**
 * Real synthesized tools for the workspace, from the live determinism engine
 * (`/api/v1/insights` → `tools[]`). Read-only catalog across agents; per-agent
 * enable/disable lives in Sessions → an agent (the injected-tool registry).
 * Tools only appear for agents that repeat deterministic steps across runs.
 */
export function ToolSynthesisLive({ agent }: { agent: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const q = agent && agent !== ALL_AGENTS ? `?agent=${encodeURIComponent(agent)}` : '';
    fetch(`/api/v1/insights${q}`)
      .then((r) => (r.ok ? r.json() : { insights: [] }))
      .then((d: { insights?: AgentInsight[] }) => {
        const all: Row[] = (d.insights ?? []).flatMap((i) =>
          (i.tools ?? []).map((t) => ({ ...t, agentId: i.agentId })),
        );
        all.sort((a, b) => (b.savings?.windowUsd ?? 0) - (a.savings?.windowUsd ?? 0));
        setRows(all);
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [agent]);

  const ready = rows.filter((t) => t.replay?.status === 'ready');
  const totalPerRun = rows.reduce((s, t) => s + (t.savings?.perRunUsd ?? 0), 0);

  // Fixed metric-column widths so the header labels line up over the values.
  const COL = { replay: 52, usd: 72, runs: 52 };
  const rightCol = (w: number) => ({ minWidth: w, textAlign: 'right' as const, whiteSpace: 'nowrap' as const });
  const TIP = {
    replay: 'Replay pass rate — the share of recorded runs where the compiled tool reproduces the exact arguments and output it was mined from. ≥95% over ≥10 runs promotes it from "shadow" to "ready".',
    usd: 'Measured LLM cost saved each run by replacing these steps with the compiled tool — includes context-carriage (intermediate results no longer re-read by later turns).',
    runs: 'Support — the share of this agent\'s runs that contain this exact procedure.',
    sideEffect: 'This tool includes a step that changes external state (a file write, a network POST, etc.). It runs guarded: a dry-run plus an exact-template match is required before the real action fires.',
    ready: 'Replay-validated against the recorded runs — active in the injected bundle.',
    shadow: 'Still in shadow validation — informational only, not yet injected.',
  };

  if (loading) return <div className="dag-empty">Synthesizing tools from recent runs…</div>;

  if (rows.length === 0) {
    return (
      <section className="panel panel-pad" style={{ textAlign: 'center', padding: '56px 24px' }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>No synthesized tools yet</h2>
        <p style={{ color: 'var(--txt-2)', maxWidth: '54ch', margin: '0 auto', lineHeight: 1.6 }}>
          Effigent compiles a tool when an agent repeats the same deterministic steps across runs.
          Highly varied work won’t surface tools here, but any repetitive procedure — a scheduled
          check, a scrape, a fixed lookup — will. In-progress candidates show under <b>Insights</b>.
        </p>
      </section>
    );
  }

  return (
    <div className="page-stack">
      <div className="sess-totals">
        <div className="totstat" title="Deterministic procedures the engine has compiled from repeated steps across this workspace's agents.">
          <span className="k">Synthesized tools</span><span className="v tnum">{rows.length}</span>
        </div>
        <div className="totstat" title="Tools that passed replay validation (≥95% over ≥10 runs) and are active in the injected bundle. The rest are in shadow.">
          <span className="k">Replay-validated</span><span className="v tnum">{ready.length}</span>
        </div>
        <div className="totstat" title="Sum of the measured per-run LLM cost these tools remove when injected.">
          <span className="k">Est. saving / run</span><span className="v tnum">{usd(totalPerRun)}</span>
        </div>
      </div>

      <section className="panel panel-pad">
        <div className="ins-head">
          <div>
            <div className="mono-name" style={{ fontSize: 14 }}>Synthesized tools</div>
            <div className="panel-sub">
              Deterministic procedures compiled from repeated steps. Enable/disable per agent in
              Sessions → an agent.
            </div>
          </div>
        </div>
        <div className="ins-list">
          {/* column header — makes the three metric columns self-explanatory */}
          <div className="ins-row" style={{ borderTop: 'none', paddingTop: 0, paddingBottom: 8 }}>
            <div className="ins-main"><span className="ins-kind">Tool · agent · shape</span></div>
            <div className="ins-metrics">
              <span className="ins-kind" style={rightCol(COL.replay)} title={TIP.replay}>replay</span>
              <span className="ins-kind" style={rightCol(COL.usd)} title={TIP.usd}>saved / run</span>
              <span className="ins-kind" style={rightCol(COL.runs)} title={TIP.runs}>in runs</span>
            </div>
          </div>
          {rows.map((t) => (
            <div key={`${t.agentId}-${t.id}`} className="ins-row">
              <div className="ins-main">
                <div className="ins-top">
                  <span
                    className={`ins-act ${t.replay?.status === 'ready' ? 'act-replace' : 'act-route'}`}
                    title={t.replay?.status === 'ready' ? TIP.ready : TIP.shadow}
                  >
                    {t.replay?.status ?? 'shadow'}
                  </span>
                  <span className="mono-name" style={{ fontSize: 12.5 }}>{t.name}</span>
                  <span className="ins-kind">
                    {t.agentId} · {t.steps} steps
                    {t.params.length ? ` · ${t.params.length} param${t.params.length === 1 ? '' : 's'}` : ''}
                  </span>
                  {t.guarded && (
                    <span
                      className="ins-kind"
                      style={{ color: 'var(--gold)', cursor: 'help' }}
                      title={TIP.sideEffect}
                    >
                      ⚠ side-effect
                    </span>
                  )}
                </div>
                {t.tools?.length > 0 && (
                  <div className="ins-preview" title="The recorded step sequence this tool compiles.">
                    {t.tools.join('  →  ')}
                  </div>
                )}
              </div>
              <div className="ins-metrics">
                <span className="ins-conf tnum" style={rightCol(COL.replay)} title={TIP.replay}>
                  {t.replay ? `${Math.round(t.replay.passRate * 100)}%` : '—'}
                </span>
                <span className="ins-usd tnum" style={rightCol(COL.usd)} title={TIP.usd}>
                  {usd(t.savings?.perRunUsd ?? 0)}
                </span>
                <span className="ins-runs tnum" style={rightCol(COL.runs)} title={TIP.runs}>
                  {Math.round((t.evidence?.support ?? 0) * 100)}%
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Always-visible legend so the markers/columns are self-explanatory
            without relying on hover tooltips. */}
        <div className="tool-legend">
          {rows.some((t) => t.guarded) && (
            <div>
              <span className="ins-act act-route" style={{ color: 'var(--gold)', background: 'color-mix(in srgb, var(--gold) 14%, transparent)', borderColor: 'color-mix(in srgb, var(--gold) 32%, transparent)' }}>⚠ side-effect</span>
              {' '}the tool includes a step that changes external state (a file write, a network POST, …). It runs <b>guarded</b> — a dry-run plus an exact-template match are required before the real action fires.
            </div>
          )}
          <div><b>replay</b> = share of recorded runs the compiled tool reproduces exactly · <b>saved / run</b> = measured LLM cost removed per run · <b>in runs</b> = share of this agent’s runs containing the procedure.</div>
          <div><span className="ins-act act-replace">ready</span> replay-validated &amp; injected · <span className="ins-act act-route">shadow</span> still validating, not yet injected.</div>
        </div>
      </section>
    </div>
  );
}
