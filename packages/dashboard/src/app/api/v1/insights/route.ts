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
import { loadRun } from '@/lib/storage.ts';
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

const DEFAULT_WINDOW = 20;
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
    depth: s.depth,
    support: s.support,
    runsTotal: s.runsTotal,
    occurrences: s.occurrences,
    totalCostUsd: Number(s.totalCostUsd.toFixed(2)),
    determinism: Number(s.determinism.toFixed(2)),
    mechanicalRatio: Number(s.mechanicalRatio.toFixed(2)),
    action:
      s.determinism >= 0.9
        ? 'compile'
        : s.mechanicalRatio >= 0.5
          ? 'route'
          : 'review',
  }));
}

/** Stable across windows: the same logical opportunity keeps its id. */
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
      costUsd: Number(r.cost_usd ?? run.costUsd ?? 0),
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

    const analyses: ClusterAnalysis[] = analyzeDeterminism(graphs, { threshold });
    if (analyses.length === 0) {
      // No whole-run cluster is not "nothing to analyze". Emit the agent whenever
      // repeated sub-paths (or drift) carry signal — otherwise the agents burning
      // the most spend are exactly the ones the view stays silent about.
      if (segments.length > 0 || subtrees.length > 0 || drift?.changed) {
        insights.push({
          agentId, runCount: runs.length, window, clusters: 0, coverage: 0,
          steps: Math.max(...runs.map((r) => r.steps.length)), meanScore: 0, meanSim: 0,
          totalEstUsd: 0, opportunities: [], tools: [], drift,
          segments: wireSegments(segments),
          subtrees: wireSubtrees(subtrees),
        });
      }
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
  insights.sort((a, b) => b.totalEstUsd - a.totalEstUsd);
  return Response.json({ insights, window, threshold });
}
