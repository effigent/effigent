import { useState, useEffect } from 'react';
import { ALL_AGENTS } from '../data.ts';
import { RouteTest } from './RouteTest.tsx';
import { Ic } from '../icons.tsx';
import { AgentSummary, type AgentSummaryData } from './AgentSummary.tsx';

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
  confidence: number;
  distinctValues: number;
  samples: number;
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
interface Ledger {
  runCount: number;
  totalUsd: number;
  slices: {
    deadContextUsd: number;
    carriedUsd: number;
    cacheMissUsd: number;
    errorRecoveryUsd: number;
    redundantUsd: number;
  };
  cacheHitRate: number;
  cacheApparentlyDisabledRuns: number;
  errorCount: number;
  topDeadContext: { runId: string; tool: string; estTokens: number; deadCalls: number; wastedUsd: number; preview: string }[];
  topErrorLoops: { runId: string; tool: string; recoverySteps: number; recoveryUsd: number; preview: string }[];
  topRedundant: { runId: string; structLabel: string; occurrences: number; wastedUsd: number; preview: string }[];
}

interface DeterminismInsight {
  id: string;
  actions: string[];
  support: number;
  runsTotal: number;
  occurrences: number;
  confidence: number;
  totalCostUsd: number;
  avgGlueSteps: number;
  glueCostUsd: number;
  intents: string[];
  exampleAsks: string[];
}

interface Predictability {
  transitions: number;
  predictable: number;
  sharePredictable: number;
  decisionGlueUsd: number;
  mechanicalGlueUsd: number;
  topPredictable: { context: string[]; action: string; p: number; support: number; occurrences: number; glueUsd: number }[];
}

interface TaskMixEntry {
  intent: string;
  episodes: number;
  costUsd: number;
  share: number;
}

interface PlanItem {
  id: string;
  title: string;
  evidence: string;
  savingsUsd: { low: number; high: number } | null;
  basis: 'measured' | 'simulated' | 'structural' | 'needs-ab';
  files: { path: string; content: string; note?: string }[];
}

interface ContextAnalysis {
  costUsd: number;
  spend: { outputUsd: number; thinkingUsd: number; cacheReadUsd: number; cacheWriteUsd: number; uncachedUsd: number; sideModelUsd: number };
  rent: { baseUsd: number; byKind: Record<string, number>; topTools: { tool: string; usd: number }[] };
  calibration: number;
  coldRewrites: { count: number; penaltyUsd: number };
  instructionsTokens: number;
  compaction: { threshold: number | null; calibration: number };
  plan: PlanItem[];
  summary?: AgentSummaryData;
  legacyRuns?: number;
  loops?: {
    patterns: { kind: string; template: string; loops: number; sessions: number; costUsd: number }[];
    verify: { verifier: string; reverifies: number; clean: number; found: number; cleanCostUsd: number }[];
  };
  reasons?: { reason: string; requests: number; costUsd: number; share: number; avgContext: number }[];
  law?: { baseTokens: number; depositPerRequest: number; compactionCostUsd: number; eoqThreshold: number; fitR2: number; aboveThresholdShare: number } | null;
  drivers?: { requests: number; context: number; price: number } | null;
  expensive?: { runId: string; title?: string; startedAt?: string; costUsd: number; requestsX: number; contextX: number; priceX: number; dominant: string; topReason: string; topReasonShare: number; delivered?: boolean }[];
  outcomes?: { commits: number; pushes: number; prs: number; denials: number; deliveringSessions: number; costPerDeliveringSessionUsd: number | null; coverage: number };
  determinism?: Record<'reason' | 'action', { testDecisions: number; testSessions: number; coverage80: number; precision80: number; spendShare80: number; explained: number; reliable: boolean } | null>;
  loop?: { lever: string; adoptedAt: string; before: number; after: number; metric: string; metricBefore: number; metricAfter: number; costPerRequestBefore: number; costPerRequestAfter: number; qualityOk: boolean; status: string; realizedUsd: number }[];
}

interface AgentInsight {
  agentId: string;
  profile?: 'repetitive' | 'interactive';
  runCount: number;
  window: number;
  clusters: number;
  coverage: number;
  steps: number;
  meanScore: number;
  totalEstUsd: number;
  opportunities: Opportunity[];
  ledger?: Ledger;
  analysis?: ContextAnalysis;
  determinism?: DeterminismInsight[];
  taskMix?: TaskMixEntry[];
  predictability?: Predictability;
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


/**
 * Fixed-width metric cell. The width is the whole point: cells only line up into
 * COLUMNS if every row reserves the same space, so this must not size to content.
 * The name lives once in `MetricHead`, not repeated on every row.
 */
const METRIC_W = 82;

function Metric({ value, title }: { value: string; title?: string }) {
  return (
    <span
      title={title}
      className="tnum"
      style={{ width: METRIC_W, flex: 'none', textAlign: 'right', fontSize: 12.5, fontWeight: 600 }}
    >
      {value}
    </span>
  );
}

/**
 * The single header row for a metric table. Mirrors the row layout exactly — same
 * left gutter, same flexible middle, same fixed cells — so the labels sit above the
 * values they describe.
 */
function MetricHead({ cols }: { cols: { label: string; title: string }[] }) {
  return (
    <div className="ins-row" style={{ paddingTop: 0, paddingBottom: 6, borderTop: 'none' }}>
      <span className="ins-step" />
      <div className="ins-main" />
      <div className="ins-metrics">
        {cols.map((c) => (
          <span
            key={c.label}
            title={c.title}
            style={{
              width: METRIC_W, flex: 'none', textAlign: 'right', fontSize: 9.5,
              textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--txt-3)',
              cursor: 'help',
            }}
          >
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}

const SEGMENT_COLS = [
  { label: 'stable', title: 'How often this path carried byte-identical I/O. Low means same shape, different data.' },
  { label: 'mechanical', title: 'Share of steps needing no intelligence (reads, lookups) rather than generation.' },
  { label: 'in runs', title: 'How many of the analysed runs contained it.' },
  { label: 'times', title: 'Total occurrences across those runs.' },
  { label: 'cost', title: 'Measured spend attributed to this path.' },
];

const SUBTREE_COLS = [
  { label: 'stable', title: 'How often the whole subtree carried byte-identical payloads.' },
  { label: 'confidence', title: 'Wilson lower bound on stability at this sample size. Two identical occurrences are not evidence, so a low figure here blocks the compile recommendation.' },
  { label: 'mechanical', title: 'Share of steps needing no intelligence rather than generation.' },
  { label: 'in runs', title: 'How many of the analysed runs contained it.' },
  { label: 'times', title: 'Total occurrences across those runs.' },
  { label: 'cost', title: 'Measured spend attributed to this subtree.' },
];

const OPP_COLS = [
  { label: 'stability', title: 'How consistent this step was across the runs in the cluster.' },
  { label: 'confidence', title: 'Wilson lower bound at this sample size — how far the stability figure can be trusted.' },
  { label: 'in runs', title: 'Runs exhibiting this pattern.' },
  { label: 'removable', title: 'Estimated spend this change would remove.' },
];

/**
 * Per-node colour, gated on CONFIDENCE rather than raw stability.
 *
 * A subtree seen twice makes every node read "100% stable · 1 value" and paints the
 * whole tree green — which said "perfectly deterministic, compile it" directly beside
 * a verdict of "extract as sub-agent, 34% confidence". The picture contradicted the
 * recommendation. Insufficient evidence now renders as its own muted state instead of
 * borrowing the colour of a proven constant.
 */
type Stability = 'proven' | 'partial' | 'volatile' | 'unproven';

function stabilityOf(n: { determinism: number; confidence: number }): Stability {
  if (n.confidence < 0.6) return 'unproven';
  if (n.determinism >= 0.9) return 'proven';
  if (n.determinism >= 0.34) return 'partial';
  return 'volatile';
}

const STABILITY: Record<Stability, { color: string; note: string; legend: string }> = {
  proven: { color: 'var(--green)', note: 'constant', legend: 'constant — same payload every time, on enough samples to trust' },
  partial: { color: 'var(--gold)', note: 'partly stable', legend: 'partly stable' },
  volatile: { color: 'var(--red, #e5484d)', note: 'varies', legend: 'volatile — differs every run' },
  unproven: { color: 'var(--txt-4)', note: 'too few samples', legend: 'not enough evidence — too few occurrences to call' },
};


/**
 * AI explanation of one subtree. Sends STRUCTURE only — labels, counts, stability
 * figures — never payloads, so run content never leaves the org's storage to produce
 * a caption. The server prompt forbids upgrading the verdict when confidence is low.
 */
function ExplainPanel({ agentId, subtree }: { agentId: string; subtree: Subtree }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ask = () => {
    setBusy(true);
    setErr(null);
    fetch('/api/v1/explain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId,
        rootLabel: subtree.rootLabel,
        nodes: subtree.nodes,
        span: subtree.span,
        support: subtree.support,
        runsTotal: subtree.runsTotal,
        occurrences: subtree.occurrences,
        totalCostUsd: subtree.totalCostUsd,
        determinism: subtree.determinism,
        confidence: subtree.confidence,
        mechanicalRatio: subtree.mechanicalRatio,
        action: subtree.action,
        tree: subtree.tree,
      }),
    })
      .then(async (r) => {
        const d = (await r.json()) as { explanation?: string; error?: string };
        if (!r.ok || !d.explanation) throw new Error(d.error ?? `HTTP ${r.status}`);
        setText(d.explanation);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div style={{ marginTop: 10 }}>
      {!text && (
        <button type="button" className="chip" style={{ cursor: busy ? 'default' : 'pointer' }}
          onClick={ask} disabled={busy}
          title="Explain what this chain does, why the verdict is what it is, and what to change. Only step labels and metrics are sent — never payloads.">
          {busy ? 'Explaining…' : 'Explain this subtree'}
        </button>
      )}
      {err && <div className="foot-note" style={{ marginTop: 6 }}>Could not explain: {err}</div>}
      {text && (
        <div className="foot-note" style={{ marginTop: 6, whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
          {text}
          <div style={{ marginTop: 8 }}>
            <button type="button" className="chip" style={{ cursor: 'pointer' }} onClick={ask} disabled={busy}>
              {busy ? 'Explaining…' : 'regenerate'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
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
              style={{
                borderColor: STABILITY[stabilityOf(n)].color,
                borderStyle: stabilityOf(n) === 'unproven' ? 'dashed' : 'solid',
                maxWidth: 210,
              }}
              title={`${n.structLabel}\n${n.class}\n${n.distinctValues} distinct payload(s) over ${n.samples} occurrence(s)\nstability ${Math.round(n.determinism * 100)}%, confidence ${Math.round(n.confidence * 100)}%`}
            >
              <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {n.structLabel.replace(/^(tool:|result:|llm:)/, '')}
              </span>
              <small style={{ color: STABILITY[stabilityOf(n)].color }}>
                {STABILITY[stabilityOf(n)].note} · {n.distinctValues}/{n.samples}
              </small>
            </div>
          ))}
        </div>
      ))}
      <div style={{ marginTop: 10, display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 10, color: 'var(--txt-3)' }}>
        {(['proven', 'partial', 'volatile', 'unproven'] as Stability[]).map((k) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{
              width: 8, height: 8, borderRadius: 2,
              border: `2px ${k === 'unproven' ? 'dashed' : 'solid'} ${STABILITY[k].color}`,
            }} />{STABILITY[k].legend}
          </span>
        ))}
        <span style={{ marginLeft: 'auto' }}>x/y = distinct payloads over occurrences</span>
      </div>
    </div>
  );
}


/**
 * Sections are capped by default. Twelve segment rows pushed the subtree section —
 * the more valuable finding, and the one with the tree map explaining WHY — clean off
 * the screen, which read as "the feature is missing".
 */
const ROW_CAP = 5;

/**
 * The waste ledger — spend decomposition that exists for EVERY agent from run
 * one (within-run detectors; no clustering precondition). Slices are
 * independent per-class estimates and are deliberately shown side by side,
 * never summed: each answers "how much would fixing THIS class save?".
 */
function LedgerPanel({ ledger }: { ledger: Ledger }) {
  const pct = (v: number) => (ledger.totalUsd > 0 ? ` · ${((v / ledger.totalUsd) * 100).toFixed(1)}%` : '');
  const SLICES: { label: string; value: number; hint: string }[] = [
    { label: 'Error recovery', value: ledger.slices.errorRecoveryUsd, hint: `Spend on the recovery tail after failed tool calls (${ledger.errorCount} errors in the window).` },
    { label: 'Redundant calls', value: ledger.slices.redundantUsd, hint: 'Identical read-only calls repeated within one run with identical answers — the repeats bought nothing.' },
  ];
  return (
    <div style={{ margin: '12px 0' }}>
      <div className="panel-sub" style={{ marginBottom: 6 }}>
        Errors and repeats over {ledger.runCount} runs · cache hit rate{' '}
        <span className="tnum">{(ledger.cacheHitRate * 100).toFixed(1)}%</span>
        {ledger.cacheApparentlyDisabledRuns > 0 && (
          <span style={{ color: 'var(--warn, #eb6834)' }}> · caching looks OFF in {ledger.cacheApparentlyDisabledRuns} run{ledger.cacheApparentlyDisabledRuns === 1 ? '' : 's'}</span>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {SLICES.map((s) => (
          <span key={s.label} className="chip" title={s.hint} style={{ cursor: 'help' }}>
            {s.label}: <span className="tnum" style={{ fontWeight: 700 }}>{usd(s.value)}</span>
            <span style={{ color: 'var(--txt-3)' }}>{pct(s.value)}</span>
          </span>
        ))}
      </div>
      {ledger.topErrorLoops[0] && (
        <div className="foot-note" style={{ marginTop: 6 }}>
          Worst error loop: {usd(ledger.topErrorLoops[0].recoveryUsd)} recovering a failed{' '}
          <code>{ledger.topErrorLoops[0].tool}</code> — “{ledger.topErrorLoops[0].preview.slice(0, 70)}…”
        </div>
      )}
    </div>
  );
}

const LOOP_LABEL: Record<string, string> = {
  paging: 'reading one file in slices', collection: 'same command per item', retry: 'failed command re-run', poll: 'polling',
};

const REASON_LABEL: Record<string, string> = {
  act: 'editing / acting', explore: 'exploring', verify: 'verifying', deliver: 'shipping', respond: 'answering',
  recover: 'recovering from errors', wait: 'waiting / polling', delegate: 'delegating',
};

const BASIS: Record<PlanItem['basis'], { label: string; hint: string; color: string }> = {
  measured: { label: 'measured', hint: 'An identity over observed spend — no model, no assumption.', color: 'var(--ok, #00a37a)' },
  simulated: { label: 'simulated', hint: 'Trace-replay counterfactual, calibrated against observed cost (shown).', color: 'var(--accent, #0b84ff)' },
  structural: { label: 'if adopted', hint: 'A bound that holds if the agent follows the change — confirm with a before/after window.', color: 'var(--warn, #eb6834)' },
  'needs-ab': { label: 'needs A/B', hint: 'The mechanism is real; its size can only be learned live.', color: 'var(--txt-3)' },
};

/**
 * Context rent + the compiled plan. The spend bar is the measured anatomy (what
 * the money physically paid for); the plan is what Effigent would WRITE into the
 * harness — each item priced, labelled by its evidence, with the file attached.
 */
function ContextPanel({ a, showPlan = true }: { a: ContextAnalysis; showPlan?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const allLegacy = (a.legacyRuns ?? 0) > 0 && a.costUsd === 0;
  const s = a.spend;
  const parts = [
    { k: 'Re-reading context', v: s.cacheReadUsd, c: '#7c5cff', hint: 'Cache reads: everything already in the window, re-read on every request.' },
    { k: 'Writing context', v: s.cacheWriteUsd + s.uncachedUsd, c: '#0b84ff', hint: 'New tokens written to the prompt cache (1-hour writes cost 2× input).' },
    { k: 'Side model', v: s.sideModelUsd, c: '#f5a623', hint: 'Usage outside the main requests — on Claude Code, advisor-tool iterations.' },
    { k: 'Generating', v: s.outputUsd + s.thinkingUsd, c: '#00a37a', hint: 'Output + thinking: the only part that is the model actually producing something.' },
  ];
  const total = parts.reduce((t, p) => t + p.v, 0) || 1;
  const rentRows = [
    ['base context', a.rent.baseUsd],
    ...Object.entries(a.rent.byKind).map(([k, v]) => [k.replace('_', ' '), v] as [string, number]),
  ].filter(([, v]) => (v as number) > 0.005).sort((x, y) => (y[1] as number) - (x[1] as number)) as [string, number][];
  return (
    <div style={{ margin: '12px 0' }}>
      {!allLegacy && <>
      <div className="panel-sub" style={{ marginBottom: 6 }}>
        What the money paid for — {usd(a.costUsd)}
        <span style={{ color: 'var(--txt-3)' }} title="Context rent reproduces observed cache-read spend; 1.000 = exact.">
          {' '}· rent identity {a.calibration.toFixed(3)}
        </span>
      </div>
      <div style={{ display: 'flex', height: 14, borderRadius: 4, overflow: 'hidden' }}>
        {parts.map((p) => (
          <div key={p.k} title={`${p.k}: ${usd(p.v)} — ${p.hint}`} style={{ width: `${(100 * p.v) / total}%`, background: p.c }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 6, fontSize: 12 }}>
        {parts.map((p) => (
          <span key={p.k} title={p.hint} style={{ cursor: 'help' }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, background: p.c, borderRadius: 2, marginRight: 4 }} />
            {p.k} <span className="tnum" style={{ fontWeight: 700 }}>{((100 * p.v) / total).toFixed(0)}%</span>
          </span>
        ))}
      </div>
      <div className="foot-note" style={{ marginTop: 6 }}>
        Re-reading, by what it re-reads: {rentRows.map(([k, v]) => `${k} ${usd(v)}`).join(' · ')}
        {a.instructionsTokens > 0 && <> · CLAUDE.md is {Math.round(a.instructionsTokens / 1000)}k tokens</>}
        {a.coldRewrites.count > 0 && <> · {a.coldRewrites.count} cache expiries cost {usd(a.coldRewrites.penaltyUsd)}</>}
      </div>
      </>}

      {(a.reasons?.length ?? 0) > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          <span className="panel-sub" style={{ marginRight: 4 }}>Requests were for:</span>
          {a.reasons!.slice(0, 7).map((r) => (
            <span key={r.reason} className="chip" title={`${r.requests} requests, made from ${Math.round(r.avgContext / 1000)}k tokens of context on average`}>
              {REASON_LABEL[r.reason] ?? r.reason} <span className="tnum" style={{ fontWeight: 700 }}>{(r.share * 100).toFixed(0)}%</span>
              <span style={{ color: 'var(--txt-3)' }}> @{Math.round(r.avgContext / 1000)}k</span>
            </span>
          ))}
        </div>
      )}
      {a.law && (
        <div className="foot-note" style={{ marginTop: 8 }} title="Fitted per agent: cost ≈ read·(B·N + d·N²/2) + write·(B + d·N). EOQ: the compaction point where carrying context stops being cheaper than compacting.">
          Session cost grows with the square of its length here (fit R² {a.law.fitR2.toFixed(2)}): {Math.round(a.law.baseTokens / 1000)}k base
          + {a.law.depositPerRequest.toLocaleString()} tokens per request. {Math.round(a.law.aboveThresholdShare * 100)}% of re-reading happens above
          {' '}{Math.round(a.law.eoqThreshold / 1000)}k, the point where compacting (≈{usd(a.law.compactionCostUsd)}) becomes cheaper than carrying.
          {a.drivers && <> Differences between sessions come {Math.round(a.drivers.requests * 100)}% from length, {Math.round(a.drivers.context * 100)}% from context size.</>}
        </div>
      )}
      {a.determinism?.reason && (
        <div className="foot-note" style={{ marginTop: 8 }} title="A cheap model learns this agent's decisions from its earlier sessions and is scored on later ones. Predicted-at-≥80%-confidence decisions are the ones deterministic code could take.">
          Determinism, measured on {a.determinism.reason.testSessions} later sessions ({a.determinism.reason.testDecisions.toLocaleString()} decisions):
          {' '}{(a.determinism.reason.coverage80 * 100).toFixed(1)}% of next steps are predictable at ≥80% confidence
          ({(a.determinism.reason.precision80 * 100).toFixed(0)}% right), carrying {(a.determinism.reason.spendShare80 * 100).toFixed(1)}% of spend;
          {' '}exact actions {a.determinism.action ? `${(a.determinism.action.coverage80 * 100).toFixed(1)}%` : 'not measurable yet'}.
          {' '}History explains {(a.determinism.reason.explained * 100).toFixed(0)}% of the uncertainty about what comes next.
          {!a.determinism.reason.reliable && <span style={{ color: 'var(--warn, #eb6834)' }}> Too few later sessions to trust yet — the confident predictions were not reliably right.</span>}
        </div>
      )}
      {a.outcomes && a.outcomes.coverage > 0 && (
        <div className="foot-note" style={{ marginTop: 4 }}>
          Delivered: {a.outcomes.commits} commits, {a.outcomes.pushes} pushes, {a.outcomes.prs} PR actions across {a.outcomes.deliveringSessions} sessions
          {a.outcomes.costPerDeliveringSessionUsd != null && <> · {usd(a.outcomes.costPerDeliveringSessionUsd)} per delivering session</>}
          {a.outcomes.denials > 0 && <> · {a.outcomes.denials} tool calls denied</>}.
        </div>
      )}
      {(a.expensive?.length ?? 0) > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="panel-sub" style={{ marginBottom: 4 }}>Why the most expensive sessions cost what they did</div>
          {a.expensive!.map((e) => (
            <div key={e.runId} className="foot-note" style={{ marginTop: 2 }}>
              <span className="tnum" style={{ fontWeight: 700 }}>{usd(e.costUsd)}</span> {e.title ? `“${e.title}”` : <code>{e.runId.slice(0, 8)}</code>} —{' '}
              {e.requestsX.toFixed(1)}× the median session’s requests, {e.contextX.toFixed(1)}× its context; {Math.round(e.topReasonShare * 100)}% spent on {REASON_LABEL[e.topReason] ?? e.topReason}{e.delivered === false ? '; nothing committed or pushed' : e.delivered ? '; delivered (commit/push/PR)' : ''}.
            </div>
          ))}
        </div>
      )}
      {a.loops && (a.loops.patterns.length > 0 || a.loops.verify.length > 0) && (
        <div style={{ marginTop: 8 }}>
          <div className="panel-sub" style={{ marginBottom: 4 }}>Loops inside sessions</div>
          {a.loops.verify.filter((v) => v.reverifies > 0).map((v) => (
            <div key={v.verifier} className="foot-note" style={{ marginTop: 2 }}>
              <b>{v.verifier}</b> re-run {v.reverifies} times after an edit as its own request: {v.clean} clean ({usd(v.cleanCostUsd)}), {v.found} found problems.
            </div>
          ))}
          {a.loops.patterns.map((p) => (
            <div key={p.kind + p.template} className="foot-note" style={{ marginTop: 2 }}>
              <b>{LOOP_LABEL[p.kind] ?? p.kind}</b> ×{p.loops} in {p.sessions} session{p.sessions === 1 ? '' : 's'} · {usd(p.costUsd)} · <code>{p.template.slice(0, 80)}</code>
            </div>
          ))}
        </div>
      )}
      {(a.loop?.length ?? 0) > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="panel-sub" style={{ marginBottom: 4 }}>Changes detected in effect</div>
          {a.loop!.map((o) => (
            <div key={o.lever} className="foot-note" style={{ marginTop: 2 }}>
              <b>{o.lever}</b> since {new Date(o.adoptedAt).toLocaleDateString()} — {o.status}: {o.metric} {o.metricBefore.toLocaleString()} → {o.metricAfter.toLocaleString()},
              {' '}cost/request ${o.costPerRequestBefore.toFixed(3)} → ${o.costPerRequestAfter.toFixed(3)} ({o.before} sessions before, {o.after} after{o.qualityOk ? '' : '; errors or interruptions rose'}).
            </div>
          ))}
        </div>
      )}
      {(a.legacyRuns ?? 0) > 0 && a.costUsd === 0 && (
        <div className="foot-note" style={{ marginTop: 8 }}>
          These sessions were captured before context size was recorded. Run <code>effigent sync --force --days 90</code> on the agent’s machine to re-upload them with the current CLI.
        </div>
      )}

      {showPlan && a.plan.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="panel-sub" style={{ marginBottom: 6 }}>Compiled plan — changes Effigent would write into the harness</div>
          {a.plan.map((p) => {
            const b = BASIS[p.basis];
            return (
              <div key={p.id} style={{ border: '1px solid var(--line, #2a2a33)', borderRadius: 6, padding: '8px 10px', marginBottom: 6 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span title={b.hint} style={{ fontSize: 11, color: b.color, border: `1px solid ${b.color}`, borderRadius: 3, padding: '0 4px', cursor: 'help' }}>{b.label}</span>
                  <span style={{ fontWeight: 600 }}>{p.title}</span>
                  {p.savingsUsd && (
                    <span className="tnum" style={{ marginLeft: 'auto', fontWeight: 700 }}>
                      {usd(p.savingsUsd.low)}–{usd(p.savingsUsd.high)}
                    </span>
                  )}
                </div>
                <div className="foot-note" style={{ marginTop: 4 }}>{p.evidence}</div>
                {p.files.length > 0 && (
                  <button className="chip" style={{ marginTop: 6, cursor: 'pointer' }} onClick={() => setOpen(open === p.id ? null : p.id)}>
                    {open === p.id ? 'Hide' : 'Show'} {p.files.map((f) => f.path).join(', ')}
                  </button>
                )}
                {open === p.id && p.files.map((f) => (
                  <div key={f.path} style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 11, color: 'var(--txt-3)' }}><code>{f.path}</code>{f.note ? ` — ${f.note}` : ''}</div>
                    <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: '4px 0 0', padding: 8, background: 'var(--bg-2, #111)', borderRadius: 4 }}>{f.content}</pre>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** "What this agent does" — the episode intent mix with measured cost share. */
function TaskMixLine({ taskMix }: { taskMix: TaskMixEntry[] }) {
  const shown = taskMix.filter((t) => t.share >= 0.03).slice(0, 6);
  if (shown.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '10px 0' }}>
      {shown.map((t) => (
        <span key={t.intent} className="chip" title={`${t.episodes} episodes · ${usd(t.costUsd)}`}>
          {t.intent}: <span className="tnum" style={{ fontWeight: 700 }}>{Math.round(t.share * 100)}%</span>
          <span style={{ color: 'var(--txt-3)' }}> of spend</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Determinism insights — the token-saving story, not tool blueprints. Each row
 * names a workflow the model performs step-by-step over and over, and prices
 * the interleaved LLM reasoning ("glue") that deterministic execution would
 * eliminate. The header totals the claim across all recurring workflows.
 */
function DeterminismPanel({ insights, predictability }: { insights: DeterminismInsight[]; predictability?: Predictability }) {
  const totalGlue = insights.reduce((s, d) => s + d.glueCostUsd, 0);
  return (
    <div style={{ margin: '14px 0' }}>
      <div className="mono-name" style={{ fontSize: 13, marginBottom: 4 }}>Deterministic savings</div>
      {predictability && (
        <div className="panel-sub" style={{ marginBottom: 4 }}>
          Deciding next steps cost <strong className="tnum">{usd(predictability.decisionGlueUsd)}</strong> of
          LLM usage in this window ({predictability.transitions.toLocaleString()} tool decisions). A
          leave-one-out entropy model finds only{' '}
          <span className="tnum">{(predictability.sharePredictable * 100).toFixed(1)}%</span> of them fully
          predictable from history — this agent's work genuinely varies, so blind compilation would fail.
          The savings that ARE defensible live in the recurring workflows below.
        </div>
      )}
      <div className="panel-sub" style={{ marginBottom: 8 }}>
        Workflows this agent repeats step-by-step through the LLM. The reasoning between those steps
        is mechanical — running them deterministically would save{' '}
        <strong className="tnum">{usd(totalGlue)}</strong> of LLM usage in this window, plus the
        context those turns carry.
      </div>
      {insights.map((d) => (
        <div key={d.id} className="ins-row" style={{ alignItems: 'flex-start' }}>
          <div className="ins-main" style={{ width: '100%' }}>
            <div style={{ fontSize: 13, lineHeight: 1.55 }}>
              In <strong>{d.support} of {d.runsTotal}</strong> runs ({d.occurrences}× total) the model walks{' '}
              <code style={{ fontSize: 11.5 }}>{d.actions.join(' → ')}</code> one LLM turn at a time —{' '}
              ~{d.avgGlueSteps} reasoning turns per pass whose only job is deciding the next step it has
              already performed identically before.
            </div>
            <div className="panel-sub" style={{ marginTop: 3 }}>
              deterministic execution saves ≈ <strong className="tnum">{usd(d.glueCostUsd)}</strong> of{' '}
              {usd(d.totalCostUsd)} spent on this workflow
              {d.exampleAsks[0] && <> · triggered by asks like “{d.exampleAsks[0].slice(0, 70)}”</>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The AI analyst — on request, a model reads the agent's last sessions (as
 * redacted briefs) plus the deterministic measurements and writes the agent
 * story: what it does, where the money goes, what recurs, top changes.
 */
function AnalystPanel({ agentId }: { agentId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = () => {
    setBusy(true); setErr(null);
    fetch(`/api/v1/insights/analyst?agent=${encodeURIComponent(agentId)}`)
      .then(async (r) => {
        const d = (await r.json()) as { analysis?: string; error?: string };
        if (d.analysis) setText(d.analysis);
        else setErr(d.error ?? 'analysis failed');
      })
      .catch(() => setErr('network error'))
      .finally(() => setBusy(false));
  };

  return (
    <div style={{ margin: '12px 0' }}>
      {!text && (
        <button className="btn-ghost" disabled={busy} onClick={run}
          title="An AI model reads this agent's recent sessions (redacted briefs + measurements) and writes the agent story: what it does, where the money goes, what recurs, and the top changes.">
          {busy ? 'Reading the runs…' : '✦ AI analysis of this agent'}
        </button>
      )}
      {err && <div className="foot-note" style={{ color: 'var(--warn, #eb6834)', marginTop: 6 }}>{err}</div>}
      {text && (
        <div className="panel" style={{ padding: '14px 16px', marginTop: 4 }}>
          {text.split('\n').map((line, i) => {
            const h = /^#{1,4}\s+(.*)$/.exec(line.trim());
            if (h) return <div key={i} className="mono-name" style={{ fontSize: 13, margin: '10px 0 4px' }}>{h[1]}</div>;
            if (!line.trim()) return null;
            return (
              <div key={i} style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--txt-2)' }}>
                {line.replace(/\*\*/g, '')}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MoreRows({ shown, total, onClick }: { shown: number; total: number; onClick: () => void }) {
  if (total <= shown) return null;
  return (
    <button
      type="button"
      className="chip"
      style={{ cursor: 'pointer', alignSelf: 'flex-start', marginTop: 8 }}
      onClick={onClick}
    >
      show all {total}
    </button>
  );
}

export function Insights({ agent, onOpenSession, onViewSessions }: { agent: string; onOpenSession?: (runId: string) => void; onViewSessions?: () => void }) {
  const key = agent || ALL_AGENTS;
  const cached = CACHE.get(key);
  const [data, setData] = useState<AgentInsight[]>(cached?.insights ?? []);
  const [windowN, setWindowN] = useState(cached?.window ?? 40);
  const [winSel, setWinSel] = useState(cached?.window ?? 40);
  const [ranAt, setRanAt] = useState<number | null>(cached?.at ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // Which section lists are expanded, keyed `${agentId}:${section}`.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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
    const qs = new URLSearchParams({ window: String(winSel) });
    if (agent && agent !== ALL_AGENTS) qs.set('agent', agent);
    fetch(`/api/v1/insights?${qs}`)
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
  // Context-economics totals: spend, pace, and the best single change per agent (summed
  // across agents — within one agent, changes overlap and are never added together).
  const withSummary = data.filter((a) => a.analysis?.summary);
  const spendTotal = withSummary.reduce((s, a) => s + a.analysis!.summary!.window.spendUsd, 0);
  const monthTotal = withSummary.reduce((s, a) => s + a.analysis!.summary!.window.perMonthUsd, 0);
  const bestTotal = withSummary.reduce((s, a) => {
    const b = a.analysis!.summary!.actions.find((x) => x.perMonthUsd);
    return b ? { low: s.low + b.perMonthUsd!.low, high: s.high + b.perMonthUsd!.high } : s;
  }, { low: 0, high: 0 });

  return (
    <div className="page-stack">
      {withSummary.length > 0 ? (
        <div className="ins-kpis">
          <div className="ins-kpi">
            <span className="ins-kpi-icon"><Ic n="user" /></span>
            <div><div className="ins-kpi-k">Agents analyzed</div><div className="ins-kpi-v tnum">{data.length}</div>
              <div className="ins-kpi-c">{data.map((a) => a.agentId).slice(0, 3).join(', ')}{data.length > 3 ? ` +${data.length - 3}` : ''}</div></div>
          </div>
          <div className="ins-kpi">
            <span className="ins-kpi-icon"><Ic n="database" /></span>
            <div><div className="ins-kpi-k">Spend analyzed</div><div className="ins-kpi-v tnum">≈{usd(monthTotal)}<small>/mo</small></div>
              <div className="ins-kpi-c">{usd(spendTotal)} in the window · at this pace</div></div>
          </div>
          <div className="ins-kpi" title="The top priced change for each agent, added across agents. Within one agent the changes overlap, so they are never summed.">
            <span className="ins-kpi-icon green"><Ic n="tag" /></span>
            <div><div className="ins-kpi-k">Top change per agent</div><div className="ins-kpi-v green tnum">{usd(bestTotal.low)}–{usd(bestTotal.high)}<small>/mo</small></div>
              <div className="ins-kpi-c green">Potential savings</div></div>
          </div>
          <div className="ins-kpi">
            <span className="ins-kpi-icon"><Ic n="trend" /></span>
            <div style={{ flex: 1 }}>
              <div className="ins-kpi-k">Analysis window</div>
              <div className="ins-kpi-row">
                <div className="ins-kpi-v tnum">{windowN} <small>sessions / agent</small></div>
                <button type="button" onClick={run} disabled={loading} className="chip" title="Re-read every run in the window and recompute">{loading ? 'Analysing…' : 'Re-run'}</button>
              </div>
              <div className="ins-kpi-c">
                <label>Window{' '}
                  <select value={winSel} onChange={(e) => setWinSel(Number(e.target.value))} aria-label="Sessions per agent to analyse">
                    {[20, 40, 60, 100].map((n) => <option key={n} value={n}>last {n} sessions</option>)}
                  </select>
                </label>
                {ranAt && <> · last run {new Date(ranAt).toLocaleTimeString()}</>}
              </div>
            </div>
          </div>
        </div>
      ) : (
      <div className="sess-totals">
        <div className="totstat"><span className="k">Agents analyzed</span><span className="v tnum">{data.length}</span></div>
        {withSummary.length > 0 ? <>
          <div className="totstat"><span className="k">Spend analysed</span><span className="v tnum">{usd(spendTotal)}</span></div>
          <div className="totstat"><span className="k">Pace</span><span className="v tnum">≈{usd(monthTotal)}/mo</span></div>
          <div className="totstat" title="The top priced change for each agent, added across agents. Within one agent the changes overlap, so they are never summed.">
            <span className="k">Top change per agent</span><span className="v tnum" style={{ color: 'var(--green)' }}>{usd(bestTotal.low)}–{usd(bestTotal.high)}/mo</span>
          </div>
        </> : <>
          <div className="totstat"><span className="k">Opportunities</span><span className="v tnum">{totalOpps}</span></div>
          <div className="totstat"><span className="k">Est. removable spend</span><span className="v tnum">{usd(totalUsd)}</span></div>
        </>}
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
      )}

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
          No runs to analyze in this window yet — capture a session first, then re-run.
        </div>
      )}

      {!loading && !error && data.map((a) => a.profile === 'interactive' && a.analysis?.summary ? (
        <div key={a.agentId} className="agent-block">
          <AgentSummary
            s={a.analysis.summary}
            agentId={a.agentId}
            sub={`Interactive agent · last ${a.runCount} sessions${a.analysis.determinism?.reason ? ` · ${(a.analysis.determinism.reason.coverage80 * 100).toFixed(1)}% of next steps predictable${a.analysis.determinism.reason.reliable ? '' : ' (low sample)'}` : ''}`}
            onOpenSession={onOpenSession}
            onViewSessions={onViewSessions}
          />
          <details className="ins-details">
            <summary>How this was measured — spend breakdown, request mix, predictability, loops, the cost law, the AI analyst</summary>
            <ContextPanel a={a.analysis} showPlan={false} />
            {a.ledger && <LedgerPanel ledger={a.ledger} />}
            <AnalystPanel agentId={a.agentId} />
            <RouteTest agent={a.agentId} />
          </details>
        </div>
      ) : (
        <section key={a.agentId} className="panel panel-pad">
          <div className="ins-head">
            <div>
              <div className="mono-name" style={{ fontSize: 14 }}>{a.agentId}</div>
              <div className="panel-sub">
                {a.profile === 'interactive' && a.analysis
                  ? <>interactive agent · last {a.runCount} sessions{a.analysis.determinism?.reason ? ` · ${(a.analysis.determinism.reason.coverage80 * 100).toFixed(1)}% of next steps predictable${a.analysis.determinism.reason.reliable ? '' : ' (low sample)'}` : ''}</>
                  : <>last {a.runCount} runs · {a.clusters} pattern{a.clusters === 1 ? '' : 's'} covering {a.coverage}% · determinism {a.meanScore}/100</>}
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
              {a.profile === 'interactive' && a.analysis ? (() => {
                // the best single priced change, per month (changes overlap — never summed)
                const top = a.analysis.summary?.actions.find((x) => x.perMonthUsd);
                return top ? <>
                  <span className="ins-save-v tnum">{usd(top.perMonthUsd!.low)}–{usd(top.perMonthUsd!.high)}</span>
                  <span className="ins-save-k">per month · top change</span>
                </> : <><span className="ins-save-v tnum">—</span><span className="ins-save-k">no priced change yet</span></>;
              })() : <>
              <span className="ins-save-v tnum">{usd(a.totalEstUsd)}</span>
              <span className="ins-save-k">est. removable cost</span>
              </>}
            </div>
          </div>

          <>
          <RouteTest agent={a.agentId} />

          {!a.analysis?.reasons?.length && (a.taskMix?.length ?? 0) > 0 && <TaskMixLine taskMix={a.taskMix!} />}

          {a.analysis && <ContextPanel a={a.analysis} />}

          {a.ledger && <LedgerPanel ledger={a.ledger} />}

          <AnalystPanel agentId={a.agentId} />
          </>

          {/* Shape miners + the determinism lattice apply to REPETITIVE agents only; on
              interactive traffic their verdicts were measured as noise (docs/context-rent.md). */}
          {a.profile !== 'interactive' && (<>
          {(a.determinism?.length ?? 0) > 0 && <DeterminismPanel insights={a.determinism!} predictability={a.predictability} />}

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
              <MetricHead cols={OPP_COLS} />
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
                      <Metric value={`${o.score}%`}
                        title="How consistent this step was across the runs in the cluster" />
                      <Metric value={`±${o.confidence}`}
                        title="Wilson lower bound at this sample size — how much the stability figure can be trusted" />
                      <Metric value={`${o.runs}`} title="Runs exhibiting this pattern" />
                      <Metric value={usd(o.estUsd)}
                        title="Estimated spend this change would remove" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {(a.subtrees?.length ?? 0) > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="panel-sub" style={{ marginBottom: 6 }}>
                Repeated subtrees — a step and the consumers of its values, matched regardless of ordering
              </div>
              <div className="ins-list">
                <MetricHead cols={SUBTREE_COLS} />
                {(expanded[`${a.agentId}:sub`] ? a.subtrees! : a.subtrees!.slice(0, ROW_CAP)).map((s) => {
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
                        <Metric value={`${Math.round(s.determinism * 100)}%`}
                          title="How often the whole subtree carried byte-identical payloads. Low means same shape, different data." />
                        <Metric value={`${Math.round(s.confidence * 100)}%`}
                          title="Wilson lower bound on stability at this sample size. Two identical occurrences are not evidence of determinism, so a low figure here blocks the compile recommendation." />
                        <Metric value={`${Math.round(s.mechanicalRatio * 100)}%`}
                          title="Share of steps needing no intelligence (reads, lookups) rather than generation." />
                        <Metric value={`${s.support}/${s.runsTotal}`}
                          title={`Appeared in ${s.support} of the ${s.runsTotal} runs analysed`} />
                        <Metric value={String(s.occurrences)}
                          title="Total occurrences across those runs" />
                        <Metric value={usd(s.totalCostUsd)}
                          title="Measured spend attributed to this subtree across all its occurrences" />
                      </div>
                      {isOpen && (
                        <div style={{ flexBasis: '100%' }}>
                          <SubtreeMap tree={s.tree} />
                          <ExplainPanel agentId={a.agentId} subtree={s} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {!expanded[`${a.agentId}:sub`] && (
                <MoreRows shown={ROW_CAP} total={a.subtrees!.length}
                  onClick={() => setExpanded((e) => ({ ...e, [`${a.agentId}:sub`]: true }))} />
              )}
            </div>
          )}

          {(a.segments?.length ?? 0) > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="panel-sub" style={{ marginBottom: 6 }}>
                Repeated paths — contiguous sub-sequences recurring inside runs that never match end to end
              </div>
              <div className="ins-list">
                <MetricHead cols={SEGMENT_COLS} />
                {(expanded[`${a.agentId}:seg`] ? a.segments! : a.segments!.slice(0, ROW_CAP)).map((s) => {
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
                        <Metric value={`${Math.round(s.determinism * 100)}%`}
                          title="How often this path carried byte-identical I/O. Low means same shape, different data." />
                        <Metric value={`${Math.round(s.mechanicalRatio * 100)}%`}
                          title="Share of steps needing no intelligence rather than generation." />
                        <Metric value={`${s.support}/${s.runsTotal}`}
                          title={`Appeared in ${s.support} of the ${s.runsTotal} runs analysed`} />
                        <Metric value={String(s.occurrences)} title="Total occurrences" />
                        <Metric value={usd(s.totalCostUsd)}
                          title="Measured spend attributed to this path" />
                      </div>
                    </div>
                  );
                })}
              </div>
              {!expanded[`${a.agentId}:seg`] && (
                <MoreRows shown={ROW_CAP} total={a.segments!.length}
                  onClick={() => setExpanded((e) => ({ ...e, [`${a.agentId}:seg`]: true }))} />
              )}
            </div>
          )}
          </>)}
        </section>
      ))}
    </div>
  );
}
