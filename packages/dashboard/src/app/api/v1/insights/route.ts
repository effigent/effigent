import { createHash } from 'node:crypto';
import { auth } from '@clerk/nextjs/server';
import { pool } from '@/lib/db.ts';
import { resolveTenant } from '@/lib/tenant.ts';
import { buildRunGraph } from '@/lib/engine/graph.ts';
import { analyzeDeterminism, type ClusterAnalysis, type NodeAnalysis } from '@/lib/engine/determinism.ts';
import { synthesizeTools } from '@/lib/engine/synthesize.ts';
import { replayToolSpec } from '@/lib/engine/replay.ts';
import { detectDrift } from '@/lib/engine/drift.ts';
import { buildKnowledgeGraph } from '@/lib/engine/knowledge.ts';
import { mineSegments, type MinedSegment } from '@/lib/engine/segments.ts';
import { mineSubtrees, type MinedSubtree } from '@/lib/engine/subtrees.ts';
import { computeRunLedger, aggregateLedgers, type AgentLedger } from '@/lib/engine/ledger.ts';
import { suggestTools, type ToolSuggestion } from '@/lib/engine/suggest.ts';
import { segmentEpisodes } from '@/lib/engine/episodes.ts';
import { analyzePredictability } from '@/lib/engine/entropy.ts';
import { loadRun } from '@/lib/storage.ts';
import { runCostUsd } from '@/lib/engine/cost.ts';
import { analyzeAgent, type AgentAnalysis } from '@/lib/engine/plan.ts';
import { summarizeAgent, type AgentSummary } from '@/lib/engine/summary.ts';
import type { RawStep, Run } from '@/lib/engine/types.ts';

export const dynamic = 'force-dynamic';

/**
 * Determinism brain v3 — a thin adapter over the REAL engine (vendored in
 * lib/engine, same files as packages/core). Per agent, over the last
 * `?window=` sessions (default 40):
 *
 *  - clusters runs by ALIGNMENT similarity (sequence + dataflow topology),
 *    not exact shape hashes — one inserted retry no longer shatters a cluster;
 *  - aligns every run to the cluster medoid and scores each COLUMN on the
 *    D0–D5 lattice (constant / derivable / pure / parameterized / routable /
 *    volatile), on full-value hashes of RAW payloads;
 *  - confidence is a Wilson lower bound at the winning detector's honest
 *    sample size, and every action is confidence-gated;
 *  - SYNTHESIZES ToolSpecs for compile units and replay-validates them
 *    against the recorded runs (status: ready | shadow).
 *
 * See packages/core/src/determinism.ts + docs/determinism-v3.md.
 */

/**
 * 40, not 20 — both this file's docstring and CLAUDE.md §5 already documented 40 while
 * the constant said 20. Beyond fixing that mismatch, the window IS the evidence base:
 * at 20 runs every mined subtree for a real agent had just 2 occurrences and a Wilson
 * confidence of 34%, so every finding rendered as "not enough evidence". Widening the
 * window is the only lever that turns those into calls worth acting on.
 */
const DEFAULT_WINDOW = 40;
const MIN_WINDOW = 5;
const MAX_WINDOW = 100;

/**
 * Whole-run clustering similarity (see align.ts: 0.7·sequence + 0.3·dataflow).
 *
 * Exposed as `?threshold=` because the right value is workload-dependent: a
 * programmatic agent replaying one workflow clusters tightly, while long
 * interactive sessions never do. Measured on real interactive traffic, max
 * pairwise similarity per agent peaks ~0.58, and lowering the threshold does NOT
 * help — at 0.40 you get 17 clusters, ~11k analyzed nodes, and ZERO actionable
 * ones, because aligning runs that share under two-thirds of their structure
 * yields columns with no constant, template, or pure value to find. The floor is
 * therefore a guard against paying that cost for nothing, not a tuning range.
 * Repetition in that kind of traffic lives in segments, not whole runs.
 */
const DEFAULT_THRESHOLD = 0.75;
const MIN_THRESHOLD = 0.4;
const MAX_THRESHOLD = 0.95;

interface RunRow {
  session_id: string;
  agent_id: string;
  started_at: string | null;
  cost_usd: string | number | null;
  blob_path: string | null;
  parsed: Run | null; // legacy inline rows; null for S3-stored runs
}

const KIND_LABEL: Record<string, string> = {
  model_turn: 'LLM step',
  tool_use: 'Tool input',
  tool_result: 'Tool output',
  thinking: 'Reasoning',
};

function displayName(structLabel: string): string {
  if (structLabel.startsWith('tool:')) return structLabel.slice(5).split('(')[0];
  if (structLabel.startsWith('result:')) return structLabel.slice(7).split(':')[0];
  if (structLabel.startsWith('llm:')) return structLabel.slice(4);
  return structLabel;
}

/**
 * Trim mined segments for the wire and label what each one is actually good for.
 *
 * The distinction matters: a segment can recur in most runs and still carry
 * near-zero `determinism` (its inputs/outputs differ every time), which means it
 * is NOT compilable into a deterministic tool. Real data shows exactly that —
 * structurally identical Read→result→thinking paths with determinism ~0.02–0.17.
 * Those are routing/caching candidates, not replacements, and saying so prevents
 * the view from promising a compile that would fail replay validation.
 *
 * `examples` is dropped (run ids + offsets are only useful server-side) and costs
 * are rounded, so a 12-segment payload stays small.
 */
function wireSegments(segments: MinedSegment[]) {
  return segments.map((s) => ({
    segmentId: s.segmentId,
    labels: s.labels,
    length: s.length,
    support: s.support,
    runsTotal: s.runsTotal,
    occurrences: s.occurrences,
    totalCostUsd: Number(s.totalCostUsd.toFixed(2)),
    avgCostPerOccurrenceUsd: Number(s.avgCostPerOccurrenceUsd.toFixed(4)),
    determinism: Number(s.determinism.toFixed(2)),
    mechanicalRatio: Number(s.mechanicalRatio.toFixed(2)),
    separability: s.separability,
    boundaryInputs: s.boundaryInputs,
    boundaryOutputs: s.boundaryOutputs,
    // What to DO with it, gated on the evidence rather than on structure alone.
    action:
      s.determinism >= 0.9 && s.separability === 'clean'
        ? 'compile'
        : s.mechanicalRatio >= 0.5 && s.separability !== 'entangled'
          ? 'route'
          : 'review',
  }));
}


/**
 * Trim mined dataflow subtrees for the wire.
 *
 * Same honesty rule as segments: structural recurrence is not compilability. The
 * thresholds below were validated against real interactive traffic rather than
 * guessed, and on that data they put essentially everything in `review`:
 * mechanicalRatio has median 0 and p75 0 (these subtrees are mostly generative
 * steps), and determinism peaks at 0.50, so `compile` cannot fire at all. That
 * skew is the finding, not a bug — recurring GENERATIVE structure is a
 * sub-agent-extraction candidate, not something code can replace. Relaxing the
 * route cut to 0.3 would only manufacture a distinction the data does not support.
 *
 * Both branches are kept because a programmatic agent replaying one workflow does
 * produce mechanical, value-stable subtrees, and should be told to compile them.
 */
function wireSubtrees(subtrees: MinedSubtree[]) {
  return subtrees.map((s) => ({
    subtreeId: s.subtreeId,
    rootLabel: s.rootLabel,
    labels: s.labels,
    nodes: s.nodes,
    span: s.span,
    depth: s.depth,
    // The drawable tree: per-node stability is what justifies the recommendation,
    // and an aggregate score cannot say WHICH steps were stable.
    tree: s.tree.map((t) => ({
      position: t.position,
      parent: t.parent,
      level: t.level,
      structLabel: t.structLabel,
      class: t.class,
      determinism: t.determinism,
      confidence: t.confidence,
      distinctValues: t.distinctValues,
      samples: t.samples,
    })),
    support: s.support,
    runsTotal: s.runsTotal,
    occurrences: s.occurrences,
    totalCostUsd: Number(s.totalCostUsd.toFixed(2)),
    determinism: Number(s.determinism.toFixed(2)),
    confidence: Number(s.confidence.toFixed(2)),
    mechanicalRatio: Number(s.mechanicalRatio.toFixed(2)),
    // Gate on CONFIDENCE, never raw determinism. Two identical occurrences score
    // determinism 1.0 and would otherwise be told to "compile" — that produced a real
    // false positive here (a 10-node llm:assistant subtree calling AskUserQuestion,
    // seen twice). The Wilson bound at n=2 lands near 0.34 and correctly refuses.
    action:
      s.confidence >= 0.6 && s.determinism >= 0.9
        ? 'compile'
        : s.mechanicalRatio >= 0.5
          ? 'route'
          : 'review',
  }));
}

/**
 * Context rent + the compiled plan (engine/plan.ts, docs/context-rent.md) for the
 * wire: the measured spend anatomy, the rent decomposition with its identity
 * check, and the priced harness changes WITH the files Effigent would write.
 */
function wireAnalysis(a: AgentAnalysis) {
  const usd = (v: number) => Number(v.toFixed(2));
  return {
    costUsd: usd(a.costUsd),
    spend: Object.fromEntries(Object.entries(a.spend).map(([k, v]) => [k, usd(v)])),
    rent: {
      baseUsd: usd(a.rent.baseUsd),
      byKind: Object.fromEntries(Object.entries(a.rent.byKind).map(([k, v]) => [k, usd(v)])),
      topTools: Object.entries(a.rent.byTool).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([tool, v]) => ({ tool, usd: usd(v) })),
    },
    calibration: Number(a.calibration.toFixed(3)),
    coldRewrites: { count: a.coldRewrites.count, penaltyUsd: usd(a.coldRewrites.penaltyUsd) },
    instructionsTokens: a.instructionsTokens,
    compaction: {
      threshold: a.compaction.threshold,
      calibration: Number((a.compaction.calibratedUsd / Math.max(1e-9, a.compaction.observedUsd)).toFixed(3)),
    },
    plan: a.plan.map((p) => ({ ...p, savingsUsd: p.savingsUsd && { low: usd(p.savingsUsd.low), high: usd(p.savingsUsd.high) } })),
    legacyRuns: a.legacyRuns,
    // procedural loops inside sessions + the verify-after-edit rule (engine/loops.ts)
    loops: {
      patterns: a.loops.patterns.slice(0, 5).map((p) => ({ kind: p.kind, template: p.template, loops: p.loops, sessions: p.sessions, costUsd: usd(p.costUsd) })),
      verify: a.loops.verify.slice(0, 4).map((v) => ({ verifier: v.verifier, reverifies: v.reverifies, clean: v.clean, found: v.found, cleanCostUsd: usd(v.cleanCostUsd) })),
    },
    // what the requests were FOR (replaces the keyword task mix)
    reasons: a.laws.reasons.map((r) => ({ reason: r.reason, requests: r.requests, costUsd: usd(r.costUsd), share: Number(r.share.toFixed(3)), avgContext: Math.round(r.avgContext) })),
    law: a.laws.law && { ...a.laws.law, readPricePerToken: undefined, compactionCostUsd: usd(a.laws.law.compactionCostUsd), fitR2: Number(a.laws.law.fitR2.toFixed(2)), aboveThresholdShare: Number(a.laws.law.aboveThresholdShare.toFixed(3)) },
    drivers: a.laws.drivers && Object.fromEntries(Object.entries(a.laws.drivers).map(([k, v]) => [k, Number(v.toFixed(2))])),
    expensive: a.laws.expensive.map((e) => ({ ...e, costUsd: usd(e.costUsd), requestsX: Number(e.requestsX.toFixed(1)), contextX: Number(e.contextX.toFixed(1)), priceX: Number(e.priceX.toFixed(1)), topReasonShare: Number(e.topReasonShare.toFixed(2)) })),
    outcomes: { ...a.laws.outcomes, costPerDeliveringSessionUsd: a.laws.outcomes.costPerDeliveringSessionUsd == null ? null : usd(a.laws.outcomes.costPerDeliveringSessionUsd), coverage: Number(a.laws.outcomes.coverage.toFixed(2)) },
    // determinism, measured on later sessions (engine/predictability.ts)
    determinism: Object.fromEntries((['reason', 'action'] as const).map((k) => {
      const p = a.determinism[k];
      return [k, p && {
        testDecisions: p.testDecisions, testSessions: p.testSessions,
        coverage80: Number(p.coverage80.toFixed(3)), precision80: Number(p.precision80.toFixed(3)),
        spendShare80: Number(p.spendShare80.toFixed(3)), explained: Number(p.explained.toFixed(3)),
        reliable: p.reliable,
      }];
    })),
    loop: a.loop.map((o) => ({ ...o, realizedUsd: usd(o.realizedUsd), metricBefore: Math.round(o.metricBefore), metricAfter: Math.round(o.metricAfter), costPerRequestBefore: Number(o.costPerRequestBefore.toFixed(4)), costPerRequestAfter: Number(o.costPerRequestAfter.toFixed(4)) })),
  };
}

/** The plain-language summary for the wire (dollars rounded; files kept — they are what to change). */
function wireSummary(s: AgentSummary) {
  const r = (v: number) => Number(v.toFixed(2));
  return {
    ...s,
    window: { ...s.window, spendUsd: r(s.window.spendUsd), perMonthUsd: r(s.window.perMonthUsd) },
    actions: s.actions.map((a) => ({ ...a, perMonthUsd: a.perMonthUsd && { low: r(a.perMonthUsd.low), high: r(a.perMonthUsd.high) } })),
    findings: s.findings.map((f) => ({ ...f, perMonthUsd: f.perMonthUsd == null ? undefined : r(f.perMonthUsd) })),
    sessions: s.sessions.map((x) => ({ ...x, costUsd: r(x.costUsd), requestsX: Number(x.requestsX.toFixed(1)), compactionSavesUsd: x.compactionSavesUsd == null ? null : r(x.compactionSavesUsd) })),
    trend: { ...s.trend, weeks: s.trend.weeks.map((w) => ({ ...w, costUsd: r(w.costUsd), costPerRequest: Number(w.costPerRequest.toFixed(4)) })) },
  };
}

/** Stable across windows: the same logical opportunity keeps its id. */
/**
 * Trim the waste ledger for the wire. Slices are independent per-class
 * estimates (see engine/ledger.ts) — the UI must present them side by side,
 * never summed into one "total waste" number.
 */
function wireLedger(a: AgentLedger) {
  const usd = (v: number) => Number(v.toFixed(2));
  return {
    runCount: a.runCount,
    totalUsd: usd(a.totalUsd),
    slices: {
      deadContextUsd: usd(a.slices.deadContextUsd),
      carriedUsd: usd(a.slices.carriedUsd),
      cacheMissUsd: usd(a.slices.cacheMissUsd),
      errorRecoveryUsd: usd(a.slices.errorRecoveryUsd),
      redundantUsd: usd(a.slices.redundantUsd),
    },
    cacheHitRate: Number(a.cacheHitRate.toFixed(3)),
    cacheApparentlyDisabledRuns: a.cacheApparentlyDisabledRuns,
    errorCount: a.errorCount,
    topDeadContext: a.topDeadContext.slice(0, 5).map((f) => ({
      runId: f.runId, tool: f.tool, estTokens: f.estTokens, deadCalls: f.deadCalls,
      wastedUsd: Number(f.wastedUsd.toFixed(3)), preview: f.preview.slice(0, 100),
    })),
    topErrorLoops: a.topErrorLoops.slice(0, 5).map((f) => ({
      runId: f.runId, tool: f.tool, recoverySteps: f.recoverySteps,
      recoveryUsd: Number(f.recoveryUsd.toFixed(3)), preview: f.preview.slice(0, 100),
    })),
    topRedundant: a.topRedundant.slice(0, 5).map((f) => ({
      runId: f.runId, structLabel: f.structLabel, occurrences: f.occurrences,
      wastedUsd: Number(f.wastedUsd.toFixed(3)), preview: f.preview.slice(0, 100),
    })),
  };
}

/**
 * Recurring workflows reframed as DETERMINISM INSIGHTS, not tool blueprints:
 * each row states what the model does mechanically and what the interleaved
 * LLM glue costs — the spend deterministic execution would eliminate.
 */
function wireDeterminism(suggestions: ToolSuggestion[]) {
  return suggestions.map((s) => ({
    id: s.id,
    actions: s.actions,
    support: s.support,
    runsTotal: s.runsTotal,
    occurrences: s.occurrences,
    confidence: s.confidence,
    totalCostUsd: Number(s.totalCostUsd.toFixed(2)),
    avgGlueSteps: s.avgGlueSteps,
    /** The savings claim: LLM-glue spend inside this workflow across the window. */
    glueCostUsd: Number(s.glueCostUsd.toFixed(2)),
    intents: s.intents.slice(0, 3),
    exampleAsks: s.exampleAsks.map((a) => a.slice(0, 120)),
  }));
}

/** What the agent actually does: episode intent mix with measured cost share. */
function taskMixOf(graphs: Parameters<typeof segmentEpisodes>[0][]) {
  const mix = new Map<string, { episodes: number; costUsd: number }>();
  let total = 0;
  for (const g of graphs) {
    for (const e of segmentEpisodes(g)) {
      const m = mix.get(e.intent) ?? { episodes: 0, costUsd: 0 };
      m.episodes++; m.costUsd += e.costUsd; total += e.costUsd;
      mix.set(e.intent, m);
    }
  }
  return [...mix.entries()]
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .map(([intent, m]) => ({
      intent,
      episodes: m.episodes,
      costUsd: Number(m.costUsd.toFixed(2)),
      share: total > 0 ? Number((m.costUsd / total).toFixed(3)) : 0,
    }));
}

function stableId(agentId: string, n: NodeAnalysis): string {
  return createHash('sha256')
    .update(`${agentId}|${n.action}|${n.structLabel}|${n.template ?? ''}`)
    .digest('hex')
    .slice(0, 12);
}

interface Opportunity {
  id: string;
  index: number;
  kind: RawStep['kind'];
  kindLabel: string;
  name: string;
  preview: string;
  template?: string;
  score: number;
  confidence: number;
  action: NodeAnalysis['action'];
  level: NodeAnalysis['level'];
  runs: number;
  estTokens: number;
  estUsd: number;
}

export async function GET(req: Request) {
  const { userId, orgId } = await auth();
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const tenantId = await resolveTenant({ userId, orgId: orgId ?? null });
  const url = new URL(req.url);
  const agentFilter = url.searchParams.get('agent') || undefined;
  const threshold = Math.max(
    MIN_THRESHOLD,
    Math.min(MAX_THRESHOLD, Number(url.searchParams.get('threshold')) || DEFAULT_THRESHOLD),
  );
  const window = Math.max(
    MIN_WINDOW,
    Math.min(MAX_WINDOW, Number(url.searchParams.get('window')) || DEFAULT_WINDOW),
  );

  // Only the last `window` sessions per agent, and only the fields the engine
  // needs — the scan stays bounded no matter how much history exists.
  const { rows } = await pool.query<RunRow>(
    `select session_id, agent_id, started_at, cost_usd, blob_path, parsed from (
       select session_id, agent_id, started_at, cost_usd, blob_path, parsed,
              row_number() over (partition by agent_id order by started_at desc nulls last) as rn
         from runs where tenant_id = $1 ${agentFilter ? 'and agent_id = $2' : ''}
     ) w where rn <= ${window}`,
    agentFilter ? [tenantId, agentFilter] : [tenantId],
  );

  // Run content lives in the org's S3 bucket — load the window in parallel.
  // (Legacy pre-S3 rows carry inline `parsed`; loadRun handles both.)
  const loaded = await Promise.all(rows.map((r) => loadRun(tenantId, r.blob_path, r.parsed)));

  const runsByAgent = new Map<string, Run[]>();
  rows.forEach((r, i) => {
    const run = loaded[i];
    if (!run?.steps?.length) return;
    // pg returns timestamps as Date; the engine sorts startedAt as an ISO string.
    const normalized: Run = {
      ...run,
      runId: r.session_id,
      agentId: r.agent_id,
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : run.startedAt,
      usageByModel: run.usageByModel ?? {},
      // Re-priced from the run's own usage — rows written before the 2026-09 pricing
      // fix store a ~2.3×-high cost_usd; the stored value is only a fallback.
      costUsd: runCostUsd(run) || Number(r.cost_usd ?? run.costUsd ?? 0),
    };
    (runsByAgent.get(r.agent_id) ?? runsByAgent.set(r.agent_id, []).get(r.agent_id)!).push(normalized);
  });

  const insights = [];
  for (const [agentId, runs] of runsByAgent) {
    // One malformed agent's run set must not 500 the whole Insights view.
    try {
    const graphs = runs.map(buildRunGraph);

    // "Has this agent changed?" — embedding drift of the newest runs vs the
    // window's baseline. On drift, validated tools should be re-shadowed.
    const drift = detectDrift(graphs);

    // Whole-run clustering asks "are two runs the same shape?". Long interactive
    // sessions never are — measured on real data, max pairwise similarity per agent
    // tops out ~0.58 against the 0.75 threshold, so every agent scored 0 clusters
    // and the view rendered empty. Segment mining asks the weaker, more useful
    // question: does the same PATH recur INSIDE otherwise-unique runs? That is
    // where the repetition actually lives, so mine it for every agent.
    const segments = mineSegments(graphs);
    // Segments read the run as a flat sequence; subtrees read the dataflow graph,
    // so a motif whose branches interleave differently still matches. Different
    // structure, genuinely different findings — mine both.
    const subtrees = mineSubtrees(graphs);

    // The waste ledger is within-run and deterministic — it has something
    // quantified to say for EVERY agent from the very first run, so no branch
    // below is ever silent again.
    const ledger = wireLedger(aggregateLedgers(runs.map((r, i) => computeRunLedger(r, graphs[i]))));

    // Workflow mining over the semantic action alphabet (episodes, not sessions),
    // reframed as determinism insights: what the model does mechanically, and the
    // LLM-glue spend deterministic execution would save. Analysis only.
    const determinism = wireDeterminism(suggestTools(graphs));
    const taskMix = taskMixOf(graphs);
    // Leave-one-out entropy model: how much of the agent's decision glue was
    // information-free? Honest hierarchy for the UI — total decision glue is
    // the ceiling, workflow glue the actionable middle, this the strict floor.
    const p9 = analyzePredictability(graphs);
    const predictability = {
      transitions: p9.transitions,
      predictable: p9.predictable,
      sharePredictable: Number(p9.sharePredictable.toFixed(4)),
      decisionGlueUsd: Number(p9.totalGlueUsd.toFixed(2)),
      mechanicalGlueUsd: Number(p9.mechanicalGlueUsd.toFixed(2)),
      topPredictable: p9.topPredictable.slice(0, 5).map((t) => ({
        context: t.context, action: t.action, p: Number(t.p.toFixed(2)),
        support: t.support, occurrences: t.occurrences, glueUsd: Number(t.glueUsd.toFixed(2)),
      })),
    };
    const agentAnalysis = analyzeAgent(agentId, runs);
    const analysis = { ...wireAnalysis(agentAnalysis), summary: wireSummary(summarizeAgent(agentAnalysis, runs)) };

    const analyses: ClusterAnalysis[] = analyzeDeterminism(graphs, { threshold });
    // Which engine applies. Repetitive agents (runs cluster) get the determinism
    // lattice + shape miners; interactive agents get context economics only —
    // measured on interactive traffic, shape verdicts were ~all noise.
    const clusteredShare = analyses.reduce((s, a) => s + a.runCount, 0) / Math.max(1, runs.length);
    const profile: 'repetitive' | 'interactive' = clusteredShare >= 0.5 ? 'repetitive' : 'interactive';
    if (analyses.length === 0) {
      insights.push({
        agentId, profile, runCount: runs.length, window, clusters: 0, coverage: 0,
        steps: Math.max(...runs.map((r) => r.steps.length)), meanScore: 0, meanSim: 0,
        totalEstUsd: 0, opportunities: [], tools: [], drift,
        ledger,
        analysis,
        determinism,
        taskMix,
        predictability,
        segments: wireSegments(segments),
        subtrees: wireSubtrees(subtrees),
      });
      continue;
    }

    // Merge opportunities across clusters by stable id.
    const merged = new Map<string, Opportunity>();
    let scoreSum = 0;
    let scored = 0;
    let clusteredRuns = 0;
    for (const a of analyses) {
      clusteredRuns += a.runCount;
      scoreSum += a.meanScore * a.runCount;
      scored += a.runCount;
      const medoid = a.alignment.cluster.medoid;
      for (const n of a.nodes) {
        if (n.action === 'keep') continue;
        const id = stableId(agentId, n);
        const estUsd = n.estUsdPerRun * n.support;
        const prev = merged.get(id);
        if (prev) {
          prev.runs += n.support;
          prev.estUsd += estUsd;
          prev.estTokens += n.estTokens;
          if (n.confidence > prev.confidence) {
            prev.score = n.score;
            prev.confidence = n.confidence;
          }
        } else {
          merged.set(id, {
            id,
            index: n.index,
            kind: n.kind,
            kindLabel: KIND_LABEL[n.kind] ?? n.kind,
            name: displayName(n.structLabel),
            preview: (medoid.nodes[n.index]?.raw ?? '').slice(0, 120),
            template: n.template?.slice(0, 160),
            score: n.score,
            confidence: n.confidence,
            action: n.action,
            level: n.level,
            runs: n.support,
            estTokens: n.estTokens,
            estUsd,
          });
        }
      }
    }

    // Synthesize + replay-validate compile units (lean projection only).
    const tools = synthesizeTools(analyses).map((spec) => {
      const analysis = analyses.find((a) => a.l1 === spec.clusterKey);
      const replay = analysis ? replayToolSpec(spec, analysis) : undefined;
      return {
        id: spec.id,
        name: spec.name,
        steps: spec.body.length,
        tools: [...new Set(spec.body.map((b) => b.tool))],
        params: spec.params.map((p) => ({ name: p.name, type: p.type, source: p.source })),
        argPreviews: spec.body.map((b) => b.argTemplate.slice(0, 100)),
        postcondition: spec.postcondition?.slice(0, 120),
        guarded: spec.body.some((b) => b.guarded),
        separability: spec.separability,
        evidence: spec.evidence,
        savings: spec.savings,
        replay: replay
          ? { runsChecked: replay.runsChecked, passRate: replay.passRate, status: replay.status }
          : undefined,
      };
    });

    const opportunities = [...merged.values()]
      .map((o) => ({ ...o, estUsd: Number(o.estUsd.toFixed(4)) }))
      .sort((a, b) => b.estUsd - a.estUsd || b.score - a.score);

    insights.push({
      agentId,
      profile,
      runCount: runs.length,
      window,
      clusters: analyses.length,
      coverage: Math.round((clusteredRuns / runs.length) * 100),
      steps: Math.max(...runs.map((r) => r.steps.length)),
      meanScore: scored ? Math.round(scoreSum / scored) : 0,
      meanSim: analyses[0].meanSim,
      totalEstUsd: Number(opportunities.reduce((s, o) => s + o.estUsd, 0).toFixed(4)),
      opportunities,
      tools,
      drift,
      ledger,
      analysis,
      determinism,
      taskMix,
      predictability,
      knowledge: buildKnowledgeGraph(analyses).find((k) => k.agentId === agentId) ?? null,
      segments: wireSegments(segments),
      subtrees: wireSubtrees(subtrees),
    });
    } catch (err) {
      console.error(
        `[insights] agent analysis failed tenant=${tenantId} agent=${agentId} runs=${runs.length}:`,
        err,
      );
    }
  }
  // Spend first: totalEstUsd is 0 for every interactive agent, so it cannot order the list.
  insights.sort((a, b) => (b.analysis?.costUsd ?? 0) - (a.analysis?.costUsd ?? 0) || b.totalEstUsd - a.totalEstUsd);
  return Response.json({ insights, window, threshold });
}
