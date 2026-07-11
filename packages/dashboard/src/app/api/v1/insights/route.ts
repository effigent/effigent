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

interface DbStep {
  kind: RawStep['kind'];
  name: string;
  payload: string;
  isError?: boolean;
  toolUseId?: string;
  model?: string;
  tokens?: { input: number; output: number; cacheCreation?: number; cacheRead?: number };
  /** Seed data calls it `ms`; OTLP capture calls it durationMs. */
  ms?: number;
  durationMs?: number;
}

interface RunRow {
  session_id: string;
  agent_id: string;
  started_at: string | null;
  cost_usd: string | number | null;
  steps: DbStep[] | null;
  first_prompt: string | null;
  final_output: string | null;
  models: string[] | null;
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
  const window = Math.max(
    MIN_WINDOW,
    Math.min(MAX_WINDOW, Number(url.searchParams.get('window')) || DEFAULT_WINDOW),
  );

  // Only the last `window` sessions per agent, and only the fields the engine
  // needs — the scan stays bounded no matter how much history exists.
  const { rows } = await pool.query<RunRow>(
    `select session_id, agent_id, started_at, cost_usd, steps, first_prompt, final_output, models from (
       select session_id, agent_id, started_at, cost_usd,
              parsed->'steps' as steps,
              parsed->>'firstPrompt' as first_prompt,
              parsed->>'finalOutput' as final_output,
              parsed->'models' as models,
              row_number() over (partition by agent_id order by started_at desc nulls last) as rn
         from runs where tenant_id = $1 ${agentFilter ? 'and agent_id = $2' : ''}
     ) w where rn <= ${window}`,
    agentFilter ? [tenantId, agentFilter] : [tenantId],
  );

  const runsByAgent = new Map<string, Run[]>();
  for (const r of rows) {
    if (!r.steps?.length) continue;
    const run: Run = {
      runId: r.session_id,
      agentId: r.agent_id,
      startedAt: r.started_at ?? undefined,
      models: r.models ?? [],
      usageByModel: {},
      costUsd: Number(r.cost_usd ?? 0),
      firstPrompt: r.first_prompt ?? undefined,
      finalOutput: r.final_output ?? undefined,
      steps: r.steps.map((s) => ({
        kind: s.kind,
        name: s.name,
        payload: String(s.payload ?? ''),
        isError: s.isError,
        toolUseId: s.toolUseId,
        model: s.model,
        tokens: s.tokens,
        durationMs: s.durationMs ?? s.ms,
      })),
    };
    (runsByAgent.get(r.agent_id) ?? runsByAgent.set(r.agent_id, []).get(r.agent_id)!).push(run);
  }

  const insights = [];
  for (const [agentId, runs] of runsByAgent) {
    const graphs = runs.map(buildRunGraph);

    // "Has this agent changed?" — embedding drift of the newest runs vs the
    // window's baseline. On drift, validated tools should be re-shadowed.
    const drift = detectDrift(graphs);

    const analyses: ClusterAnalysis[] = analyzeDeterminism(graphs);
    if (analyses.length === 0) {
      if (drift?.changed) {
        insights.push({
          agentId, runCount: runs.length, window, clusters: 0, coverage: 0,
          steps: Math.max(...runs.map((r) => r.steps.length)), meanScore: 0, meanSim: 0,
          totalEstUsd: 0, opportunities: [], tools: [], drift,
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
    });
  }
  insights.sort((a, b) => b.totalEstUsd - a.totalEstUsd);
  return Response.json({ insights, window });
}
