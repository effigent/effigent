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
/**
 * A repeated DATAFLOW subtree: a step plus the consumers of its values. Matched
 * order-invariantly, so it still counts when its branches interleave differently —
 * which is exactly the recurrence a linear segment miner cannot see.
 */
/** One step of a mined subtree, with how stable its payload was across occurrences. */
interface SubtreeNode {
  position: number;
  parent: number | null;
  level: number;
  structLabel: string;
  class: 'mechanical' | 'cacheable' | 'generative' | 'side_effect';
  determinism: number;
  distinctValues: number;
}
interface Subtree {
  subtreeId: string;
  rootLabel: string;
  labels: string[];
  nodes: number;
  depth: number;
  support: number;
  runsTotal: number;
  occurrences: number;
  totalCostUsd: number;
  determinism: number;
  mechanicalRatio: number;
  span: number;
  confidence: number;
  tree: SubtreeNode[];
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
  subtrees?: Subtree[];
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

/**
 * Results survive navigation. Analysis is expensive — it loads every run blob in the
 * window from S3, builds a graph per run, then clusters and mines them — so it must
 * not re-run merely because the user visited the page again. Module scope (not state)
 * is deliberate: the cache has to outlive unmount.
 */
const CACHE = new Map<string, { insights: AgentInsight[]; window: number; at: number }>();


/** A metric with its name attached. Bare numbers in a row are unreadable. */
function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span
      title={title}
      style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.25 }}
    >
      <b className="tnum" style={{ fontSize: 12.5 }}>{value}</b>
      <span style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--txt-3)' }}>
        {label}
      </span>
    </span>
  );
}

/** Per-node stability → colour. Green constant, gold partly stable, red volatile. */
function detColor(d: number): string {
  if (d >= 0.9) return 'var(--green)';
  if (d >= 0.34) return 'var(--gold)';
  return 'var(--red, #e5484d)';
}

/**
 * Draw a mined subtree level by level, colouring each step by how stable its payload
 * was across occurrences. This is the "why" behind the recommendation: a tree of all
 * green is compilable, all red is only extractable, and the mix tells you which
 * specific step is the volatile one.
 */
function SubtreeMap({ tree }: { tree: SubtreeNode[] }) {
  const levels: SubtreeNode[][] = [];
  for (const n of tree) (levels[n.level] ??= []).push(n);
  return (
    <div className="flow-col" style={{ padding: '12px 10px', marginTop: 8 }}>
      {levels.map((row, i) => (
        <div key={i} className="level">
          {row.map((n) => (
            <div
              key={n.position}
              className={`node ${n.class === 'generative' ? 'llm' : 'tool'}`}
              style={{ borderColor: detColor(n.determinism), maxWidth: 210 }}
              title={`${n.structLabel}\n${n.class} · ${n.distinctValues} distinct payload(s) across occurrences · ${Math.round(n.determinism * 100)}% stable`}
            >
              <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {n.structLabel.replace(/^(tool:|result:|llm:)/, '')}
              </span>
              <small style={{ color: detColor(n.determinism) }}>
                {Math.round(n.determinism * 100)}% stable · {n.distinctValues} value{n.distinctValues === 1 ? '' : 's'}
              </small>
            </div>
          ))}
        </div>
      ))}
      <div style={{ marginTop: 10, display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 10, color: 'var(--txt-3)' }}>
        {[['var(--green)', 'constant — same payload every time'],
          ['var(--gold)', 'partly stable'],
          ['var(--red, #e5484d)', 'volatile — differs every run']].map(([c, t]) => (
          <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, border: `2px solid ${c}` }} />{t}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Insights({ agent }: { agent: string }) {
  const key = agent || ALL_AGENTS;
  const cached = CACHE.get(key);
  const [data, setData] = useState<AgentInsight[]>(cached?.insights ?? []);
  const [windowN, setWindowN] = useState(cached?.window ?? 40);
  const [ranAt, setRanAt] = useState<number | null>(cached?.at ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  // Show whatever was already computed for this agent; never fetch on mount.
  useEffect(() => {
    const hit = CACHE.get(key);
    setData(hit?.insights ?? []);
    setWindowN(hit?.window ?? 40);
    setRanAt(hit?.at ?? null);
    setError(null);
  }, [key]);

  const run = () => {
    setLoading(true);
    setError(null);
    const q = agent && agent !== ALL_AGENTS ? `?agent=${encodeURIComponent(agent)}` : '';
    fetch(`/api/v1/insights${q}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { insights?: AgentInsight[]; window?: number }) => {
        const insights = d.insights ?? [];
        const win = d.window ?? 40;
        const at = Date.now();
        CACHE.set(key, { insights, window: win, at });
        setData(insights);
        setWindowN(win);
        setRanAt(at);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  const totalUsd = data.reduce((s, a) => s + a.totalEstUsd, 0);
  const totalOpps = data.reduce((s, a) => s + a.opportunities.length, 0);

  return (
    <div className="page-stack">
      <div className="sess-totals">
        <div className="totstat"><span className="k">Agents analyzed</span><span className="v tnum">{data.length}</span></div>
        <div className="totstat"><span className="k">Opportunities</span><span className="v tnum">{totalOpps}</span></div>
        <div className="totstat"><span className="k">Est. removable spend</span><span className="v tnum">{usd(totalUsd)}</span></div>
        <div className="totstat"><span className="k">Analysis window</span><span className="v tnum">{windowN} runs</span></div>
        <div className="totstat">
          <span className="k">{ranAt ? 'Last analysed' : 'Not analysed yet'}</span>
          <span className="v" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {ranAt && <span style={{ fontSize: 12, color: 'var(--txt-3)' }}>{new Date(ranAt).toLocaleTimeString()}</span>}
            <button
              type="button"
              onClick={run}
              disabled={loading}
              className="chip"
              style={{ cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1 }}
              title="Analysis reads every run in the window from storage and re-mines it, so it runs only when you ask."
            >
              {loading ? 'Analysing…' : ranAt ? 'Re-run' : 'Run analysis'}
            </button>
          </span>
        </div>
      </div>

      {loading && <div className="dag-empty">Analysing the last {windowN} sessions per agent…</div>}
      {error && !loading && <div className="dag-empty">Analysis failed: {error}. Try again.</div>}
      {!loading && !error && ranAt === null && (
        <div className="dag-empty">
          Analysis has not run for this selection. It reads every run in the window from
          storage and re-mines it, so it runs on request rather than on page load —
          press <strong>Run analysis</strong> above.
        </div>
      )}
      {!loading && !error && ranAt !== null && data.length === 0 && (
        <div className="dag-empty">
          No repetition found yet. Analysis needs either two runs of the same overall shape,
          one repeated path inside several runs, or one repeated dataflow subtree — agents
          with a single run, or only long one-off sessions, produce none of the three.
        </div>
      )}

      {!loading && !error && data.map((a) => (
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

          {a.opportunities.length === 0 && ((a.segments?.length ?? 0) > 0 || (a.subtrees?.length ?? 0) > 0) && (
            <div className="foot-note" style={{ marginTop: 10 }}>
              No two runs share an overall shape, so there are no whole-run patterns —
              but the paths below recur inside them.
            </div>
          )}
          {a.opportunities.length === 0 && (a.segments?.length ?? 0) === 0 && (a.subtrees?.length ?? 0) === 0 ? (
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
                    <div className="ins-metrics" style={{ gap: 14 }}>
                      <Metric label="stability" value={`${o.score}%`}
                        title="How consistent this step was across the runs in the cluster" />
                      <Metric label="confidence" value={`±${o.confidence}`}
                        title="Wilson lower bound at this sample size — how much the stability figure can be trusted" />
                      <Metric label="in runs" value={`${o.runs}`} title="Runs exhibiting this pattern" />
                      <Metric label="removable" value={usd(o.estUsd)}
                        title="Estimated spend this change would remove" />
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
                      <div className="ins-metrics" style={{ gap: 14 }}>
                        <Metric label="stable" value={`${Math.round(s.determinism * 100)}%`}
                          title="How often this path carried byte-identical I/O. Low means same shape, different data." />
                        <Metric label="mechanical" value={`${Math.round(s.mechanicalRatio * 100)}%`}
                          title="Share of steps needing no intelligence rather than generation." />
                        <Metric label="in runs" value={`${s.support}/${s.runsTotal}`}
                          title={`Appeared in ${s.support} of the ${s.runsTotal} runs analysed`} />
                        <Metric label="times" value={String(s.occurrences)} title="Total occurrences" />
                        <Metric label="cost" value={usd(s.totalCostUsd)}
                          title="Measured spend attributed to this path" />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {(a.subtrees?.length ?? 0) > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="panel-sub" style={{ marginBottom: 6 }}>
                Repeated subtrees — a step and the consumers of its values, matched regardless of ordering
              </div>
              <div className="ins-list">
                {a.subtrees!.map((s) => {
                  const act = SEGMENT_ACTION[s.action];
                  const isOpen = open === s.subtreeId;
                  return (
                    <div key={s.subtreeId} className="ins-row" style={{ flexWrap: 'wrap' }}>
                      <span className="ins-step tnum" title={`${s.nodes} nodes, longest chain ${s.span} edges`}>
                        {s.nodes}n
                      </span>
                      <div className="ins-main">
                        <div className="ins-top">
                          <span className={`ins-act ${act.cls}`} title={act.hint}>{act.label}</span>
                          <span className="mono-name" style={{ fontSize: 12 }}>{s.rootLabel}</span>
                          <button
                            type="button"
                            className="chip"
                            style={{ cursor: 'pointer' }}
                            onClick={() => setOpen(isOpen ? null : s.subtreeId)}
                            title="Show the subtree, with each step coloured by how stable its payload was"
                          >
                            {isOpen ? 'hide tree' : 'show tree'}
                          </button>
                        </div>
                        <div className="ins-preview" title="the chain of steps, root first">
                          {s.labels.join('  →  ')}
                        </div>
                      </div>
                      <div className="ins-metrics" style={{ gap: 14 }}>
                        <Metric label="stable" value={`${Math.round(s.determinism * 100)}%`}
                          title="How often the whole subtree carried byte-identical payloads. Low means same shape, different data." />
                        <Metric label="confidence" value={`${Math.round(s.confidence * 100)}%`}
                          title="Wilson lower bound on stability at this sample size. Two identical occurrences are not evidence of determinism, so a low figure here blocks the compile recommendation." />
                        <Metric label="mechanical" value={`${Math.round(s.mechanicalRatio * 100)}%`}
                          title="Share of steps needing no intelligence (reads, lookups) rather than generation." />
                        <Metric label="in runs" value={`${s.support}/${s.runsTotal}`}
                          title={`Appeared in ${s.support} of the ${s.runsTotal} runs analysed`} />
                        <Metric label="times" value={String(s.occurrences)}
                          title="Total occurrences across those runs" />
                        <Metric label="cost" value={usd(s.totalCostUsd)}
                          title="Measured spend attributed to this subtree across all its occurrences" />
                      </div>
                      {isOpen && <div style={{ flexBasis: '100%' }}><SubtreeMap tree={s.tree} /></div>}
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
