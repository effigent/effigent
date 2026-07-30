import { useState, useEffect } from 'react';
import { ALL_AGENTS } from '../data.ts';
import { RouteTest } from './RouteTest.tsx';

interface Opportunity {
  index: number;
  kind: string;
  kindLabel: string;
  name: string;
  preview: string;
  template?: string;
  score: number;
  confidence: number;
  action: 'replace' | 'compile' | 'memoize' | 'template' | 'route' | 'cache';
  runs: number;
  estTokens: number;
  estUsd: number;
}
/**
 * A repeated sub-PATH inside otherwise-unique runs. Long interactive sessions
 * never match end-to-end, so whole-run clusters are empty while these are not —
 * this is where the recurrence in real agent traffic actually lives.
 */
interface Segment {
  segmentId: string;
  labels: string[];
  length: number;
  support: number;
  runsTotal: number;
  occurrences: number;
  totalCostUsd: number;
  determinism: number;
  mechanicalRatio: number;
  separability: 'clean' | 'moderate' | 'entangled';
  boundaryInputs: number;
  boundaryOutputs: number;
  action: 'compile' | 'route' | 'review';
}
interface AgentInsight {
  agentId: string;
  runCount: number;
  window: number;
  clusters: number;
  coverage: number;
  steps: number;
  meanScore: number;
  totalEstUsd: number;
  opportunities: Opportunity[];
  segments?: Segment[];
  drift?: {
    changed: boolean;
    changedAt?: string;
    z: number;
    probeMeanDist: number;
  } | null;
}

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ACTION: Record<string, { label: string; cls: string; hint: string }> = {
  replace: { label: 'Replace with tool', cls: 'act-replace', hint: 'Identical output in every run — compile it away.' },
  compile: { label: 'Compile to code', cls: 'act-replace', hint: 'Every argument is constant or provenance-derived from earlier outputs — code can issue this call without the LLM.' },
  memoize: { label: 'Memoize by input', cls: 'act-memoize', hint: 'Same input always produced the same output — cache keyed by input.' },
  template: { label: 'Synthesize template', cls: 'act-template', hint: 'Fixed structure with volatile data slots — generate a parameterized tool.' },
  route: { label: 'Route to smaller model', cls: 'act-route', hint: 'Moderately stable LLM step — a cheaper model can handle it.' },
  cache: { label: 'Cache', cls: 'act-cache', hint: 'Mostly stable — cache with validation.' },
};

/**
 * Segment verdicts are deliberately weaker than the whole-run ones. A path can
 * recur in most runs and still have near-zero determinism (same shape, different
 * data every time) — that is a routing/extraction candidate, never a compile, and
 * promising otherwise would fail replay validation.
 */
const SEGMENT_ACTION: Record<string, { label: string; cls: string; hint: string }> = {
  compile: { label: 'Compile to code', cls: 'act-replace', hint: 'This path produced identical I/O in nearly every occurrence and has a clean boundary — code can run it without the LLM.' },
  route: { label: 'Route to smaller model', cls: 'act-route', hint: 'Mostly mechanical steps (reads, lookups) wrapped around a little reasoning — a cheaper model can carry it.' },
  review: { label: 'Extract as sub-agent', cls: 'act-cache', hint: 'Recurs often but its data differs every time, or it is entangled with surrounding steps — worth extracting behind a narrow interface rather than compiling.' },
};

export function Insights({ agent }: { agent: string }) {
  const [data, setData] = useState<AgentInsight[]>([]);
  const [windowN, setWindowN] = useState(40);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const q = agent && agent !== ALL_AGENTS ? `?agent=${encodeURIComponent(agent)}` : '';
    fetch(`/api/v1/insights${q}`)
      .then((r) => (r.ok ? r.json() : { insights: [] }))
      .then((d: { insights?: AgentInsight[]; window?: number }) => {
        setData(d.insights ?? []);
        if (d.window) setWindowN(d.window);
      })
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [agent]);

  const totalUsd = data.reduce((s, a) => s + a.totalEstUsd, 0);
  const totalOpps = data.reduce((s, a) => s + a.opportunities.length, 0);

  return (
    <div className="page-stack">
      <div className="sess-totals">
        <div className="totstat"><span className="k">Agents analyzed</span><span className="v tnum">{data.length}</span></div>
        <div className="totstat"><span className="k">Opportunities</span><span className="v tnum">{totalOpps}</span></div>
        <div className="totstat"><span className="k">Est. removable spend</span><span className="v tnum">{usd(totalUsd)}</span></div>
        <div className="totstat"><span className="k">Analysis window</span><span className="v tnum">{windowN} runs</span></div>
      </div>

      {loading && <div className="dag-empty">Analyzing the last {windowN} sessions per agent…</div>}
      {!loading && data.length === 0 && (
        <div className="dag-empty">
          No repetition found yet. Analysis needs either two runs of the same overall shape,
          or one repeated path recurring inside several runs — agents with a single run, or
          only long one-off sessions, produce neither.
        </div>
      )}

      {!loading && data.map((a) => (
        <section key={a.agentId} className="panel panel-pad">
          <div className="ins-head">
            <div>
              <div className="mono-name" style={{ fontSize: 14 }}>{a.agentId}</div>
              <div className="panel-sub">
                last {a.runCount} runs · {a.clusters} pattern{a.clusters === 1 ? '' : 's'} covering {a.coverage}% · determinism {a.meanScore}/100
                {a.drift?.changed && (
                  <span
                    style={{ color: 'var(--warn, #eb6834)', marginLeft: 8 }}
                    title={`Recent runs moved away from this agent's baseline behavior (z=${a.drift.z}). Synthesized tools validated on the old behavior should be re-shadowed.`}
                  >
                    ⚠ behavior changed{a.drift.changedAt ? ` ~${new Date(a.drift.changedAt).toLocaleDateString()}` : ''}
                  </span>
                )}
              </div>
            </div>
            <div className="ins-save">
              <span className="ins-save-v tnum">{usd(a.totalEstUsd)}</span>
              <span className="ins-save-k">est. removable cost</span>
            </div>
          </div>

          <RouteTest agent={a.agentId} />

          {a.opportunities.length === 0 && (a.segments?.length ?? 0) > 0 && (
            <div className="foot-note" style={{ marginTop: 10 }}>
              No two runs share an overall shape, so there are no whole-run patterns —
              but the paths below recur inside them.
            </div>
          )}
          {a.opportunities.length === 0 && (a.segments?.length ?? 0) === 0 ? (
            <div className="foot-note" style={{ marginTop: 10 }}>No deterministic patterns found — this agent’s work varies run to run.</div>
          ) : a.opportunities.length === 0 ? null : (
            <div className="ins-list">
              {a.opportunities.map((o) => {
                const act = ACTION[o.action] ?? ACTION.cache;
                return (
                  <div key={`${o.action}-${o.index}`} className="ins-row">
                    <span className="ins-step tnum">#{o.index + 1}</span>
                    <div className="ins-main">
                      <div className="ins-top">
                        <span className={`ins-act ${act.cls}`} title={act.hint}>{act.label}</span>
                        <span className="ins-kind">{o.kindLabel}</span>
                        {o.name && o.name !== 'assistant' && <span className="mono-name" style={{ fontSize: 12 }}>{o.name}</span>}
                      </div>
                      {(o.template ?? o.preview) && (
                        <div className="ins-preview" title={o.template ? 'volatile slots marked ⟨·⟩' : undefined}>
                          {o.template ?? o.preview}
                        </div>
                      )}
                    </div>
                    <div className="ins-metrics">
                      <span className="ins-score" title="pattern stability"><b className="tnum">{o.score}</b>%</span>
                      <span className="ins-conf tnum" title="confidence (Wilson lower bound at this sample size)">±{o.confidence}</span>
                      {o.estUsd > 0 && <span className="ins-usd tnum">{usd(o.estUsd)}</span>}
                      <span className="ins-runs tnum">{o.runs}×</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {(a.segments?.length ?? 0) > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="panel-sub" style={{ marginBottom: 6 }}>
                Repeated paths — sub-sequences recurring inside runs that never match end to end
              </div>
              <div className="ins-list">
                {a.segments!.map((s) => {
                  const act = SEGMENT_ACTION[s.action];
                  return (
                    <div key={s.segmentId} className="ins-row">
                      <span className="ins-step tnum">{s.length}×</span>
                      <div className="ins-main">
                        <div className="ins-top">
                          <span className={`ins-act ${act.cls}`} title={act.hint}>{act.label}</span>
                          <span className="ins-kind">{s.separability}</span>
                          <span className="ins-kind" title="values crossing the segment boundary — few means a clean contract">
                            in {s.boundaryInputs} / out {s.boundaryOutputs}
                          </span>
                        </div>
                        <div className="ins-preview">{s.labels.join('  →  ')}</div>
                      </div>
                      <div className="ins-metrics">
                        <span className="ins-score" title="I/O identical across occurrences (low = same shape, different data)">
                          <b className="tnum">{Math.round(s.determinism * 100)}</b>%
                        </span>
                        <span className="ins-conf tnum" title="share of steps needing no intelligence">
                          mech {Math.round(s.mechanicalRatio * 100)}%
                        </span>
                        {s.totalCostUsd > 0 && <span className="ins-usd tnum">{usd(s.totalCostUsd)}</span>}
                        <span className="ins-runs tnum" title={`${s.occurrences} occurrences across ${s.support} of ${s.runsTotal} runs`}>
                          {s.support}/{s.runsTotal} runs
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
