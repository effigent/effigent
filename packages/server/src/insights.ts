/**
 * The insights agent — an LLM goes over ALL runs of a tenant's agent (not just
 * cluster statistics) and produces actionable bullets on how to make the agent
 * cost less WITHOUT hurting performance.
 *
 * Per run it sees a digest built from the canonical graph: which tools ran,
 * which files/folders/repos were read, which domains were web-fetched, which
 * commands were executed, prompt sizes, token/cache economics, dataflow and
 * error structure. Every digest links to that run's graph (/g/:sessionId).
 *
 * The engine's clusters (determinism scores, volatile slots) ride along as the
 * safety data: deterministic segments are where scripts/smaller models are safe.
 *
 * Provider-agnostic: uses the LlmProvider abstraction (Anthropic by default,
 * any OpenAI-compatible endpoint via env). See llm.ts.
 */

import { buildRunGraph, mineSegments, toolProfile, type MinedSegment, type Run, type RunGraph, type WasteReport } from '@ccopt/core';
import type { LlmProvider } from './llm.js';

// ─── Per-run digest ───────────────────────────────────────────────────────────

export interface RunDigest {
  sessionId: string;
  graphUrl: string;
  agentId: string;
  costUsd: number;
  models: string[];
  nSteps: number;
  dataflowEdges: number;
  errorSteps: number;
  tokenUsage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cacheReadRatio: number;
  toolCounts: Record<string, number>;
  /** Taxonomy profile: how much of this run needs no intelligence. */
  toolClassProfile: { mechanical: number; cacheable: number; generative: number; sideEffect: number; mechanicalRatio: number };
  /** Semantic signals: what the agent actually spent its steps on. */
  signals: {
    filesRead: string[];
    foldersListed: string[];
    webFetched: string[];
    webSearches: string[];
    bashCommands: string[];
    repoOperations: string[];
  };
  firstPrompt?: string;
  /** Canonical step sequence (truncated) — the run's procedure skeleton. */
  stepSequence: string[];
}

function push(list: string[], value: string, max = 12): void {
  if (value && !list.includes(value) && list.length < max) list.push(value);
}

export function buildRunDigest(run: Run, publicBaseUrl: string, graph?: RunGraph): RunDigest {
  graph = graph ?? buildRunGraph(run);
  const profile = toolProfile(run.steps);
  const toolCounts: Record<string, number> = {};
  const signals: RunDigest['signals'] = {
    filesRead: [],
    foldersListed: [],
    webFetched: [],
    webSearches: [],
    bashCommands: [],
    repoOperations: [],
  };

  for (const step of run.steps) {
    if (step.kind !== 'tool_use') continue;
    toolCounts[step.name] = (toolCounts[step.name] ?? 0) + 1;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(step.payload) as Record<string, unknown>;
    } catch {
      /* non-JSON input */
    }
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
    switch (step.name) {
      case 'Read':
      case 'read':
        push(signals.filesRead, str('file_path') || str('path'));
        break;
      case 'Glob':
      case 'glob':
      case 'LS':
        push(signals.foldersListed, str('path') || str('pattern'));
        break;
      case 'WebFetch':
      case 'web_fetch':
        push(signals.webFetched, str('url'));
        break;
      case 'WebSearch':
      case 'web_search':
        push(signals.webSearches, str('query'));
        break;
      case 'Bash':
      case 'bash': {
        const cmd = str('command');
        push(signals.bashCommands, cmd.slice(0, 100));
        if (/\bgit\b|gh |clone|checkout|\bgrep -r|rg /.test(cmd)) {
          push(signals.repoOperations, cmd.slice(0, 100));
        }
        break;
      }
      case 'Grep':
      case 'grep':
        push(signals.repoOperations, `grep: ${str('pattern')}`.slice(0, 100));
        break;
    }
  }

  const usage = Object.values(run.usageByModel).reduce(
    (acc, u) => ({
      input: acc.input + u.inputTokens,
      output: acc.output + u.outputTokens,
      cacheRead: acc.cacheRead + u.cacheReadInputTokens,
      cacheWrite: acc.cacheWrite + u.cacheCreationInputTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  const allInput = usage.input + usage.cacheRead + usage.cacheWrite;

  return {
    sessionId: run.runId,
    graphUrl: `${publicBaseUrl}/g/${run.runId}`,
    agentId: run.agentId,
    costUsd: Math.round(run.costUsd * 100) / 100,
    models: run.models,
    nSteps: run.steps.length,
    dataflowEdges: graph.edges.filter((e) => e.type === 'dataflow').length,
    errorSteps: graph.nodes.filter((n) => n.isError).length,
    tokenUsage: usage,
    cacheReadRatio: allInput === 0 ? 0 : Math.round((usage.cacheRead / allInput) * 100) / 100,
    toolCounts,
    toolClassProfile: {
      mechanical: profile.mechanical,
      cacheable: profile.cacheable,
      generative: profile.generative,
      sideEffect: profile.sideEffect,
      mechanicalRatio: profile.mechanicalRatio,
    },
    signals,
    firstPrompt: run.firstPrompt?.slice(0, 300),
    stepSequence:
      graph.labelSequence.length > 40
        ? [...graph.labelSequence.slice(0, 40).map((l) => l.slice(0, 90)), `… ${graph.labelSequence.length - 40} more`]
        : graph.labelSequence.map((l) => l.slice(0, 90)),
  };
}

// ─── Analysis packet ──────────────────────────────────────────────────────────

export interface InsightsPacketCluster {
  clusterId: string;
  agentId: string;
  nRuns: number;
  totalCostUsd: number;
  determinism: number;
  failureRate: number;
  labelSequence: string[];
  metrics: Record<string, unknown>;
}

export interface InsightsPacket {
  windowDays: number;
  totals: WasteReport['totals'];
  agents: string[];
  runsAnalyzed: number;
  runsTotal: number;
  runs: RunDigest[];
  segments: MinedSegment[];
  clusters: InsightsPacketCluster[];
  engineFindings: { kind: string; title: string; estMonthlySavingUsd: number; recommendation: string }[];
}

export function buildInsightsPacket(
  report: WasteReport,
  clusters: InsightsPacketCluster[],
  digests: RunDigest[],
  runsTotal: number,
  segments: MinedSegment[] = [],
): InsightsPacket {
  return {
    windowDays: report.windowDays,
    totals: report.totals,
    agents: report.agentIds,
    runsAnalyzed: digests.length,
    runsTotal,
    runs: digests,
    segments,
    clusters: clusters
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
      .slice(0, 12)
      .map((c) => ({
        ...c,
        labelSequence:
          c.labelSequence.length > 40
            ? [...c.labelSequence.slice(0, 40), `… ${c.labelSequence.length - 40} more steps`]
            : c.labelSequence,
      })),
    engineFindings: report.findings.map((f) => ({
      kind: f.kind,
      title: f.title,
      estMonthlySavingUsd: f.estMonthlySavingUsd,
      recommendation: f.recommendation,
    })),
  };
}

// ─── LLM analysis ─────────────────────────────────────────────────────────────

export interface Insight {
  title: string;
  category:
    | 'prompt-reduction'
    | 'prompt-caching'
    | 'result-caching'
    | 'knowledge-summary'
    | 'model-rightsizing'
    | 'deterministic-to-script'
    | 'fix-failures'
    | 'precompute-context'
    | 'other';
  est_monthly_saving_usd: number;
  performance_risk: 'none' | 'low' | 'medium' | 'high';
  rationale: string;
  implementation: string;
  evidence_runs: string[];
}

export interface InsightsResult {
  summary: string;
  insights: Insight[];
  provider: string;
  model: string;
  generatedAt: string;
  runsAnalyzed: number;
  /** Freshness gate bookkeeping: what the analysis covered. */
  agentFilter: string | null;
  runsTotalAtGeneration: number;
}

// Schema is dual-compatible: Anthropic structured outputs and OpenAI strict
// json_schema both require additionalProperties:false and full `required`.
const INSIGHTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'insights'],
  properties: {
    summary: {
      type: 'string',
      description: 'Executive summary: where this agent wastes money and the single highest-leverage change.',
    },
    insights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'title',
          'category',
          'est_monthly_saving_usd',
          'performance_risk',
          'rationale',
          'implementation',
          'evidence_runs',
        ],
        properties: {
          title: { type: 'string' },
          category: {
            type: 'string',
            enum: [
              'prompt-reduction',
              'prompt-caching',
              'result-caching',
              'knowledge-summary',
              'model-rightsizing',
              'deterministic-to-script',
              'fix-failures',
              'precompute-context',
              'other',
            ],
          },
          est_monthly_saving_usd: { type: 'number' },
          performance_risk: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
          rationale: { type: 'string' },
          implementation: {
            type: 'string',
            description: 'Concrete steps the agent owner applies — specific to the tools/files/domains in the evidence.',
          },
          evidence_runs: {
            type: 'array',
            items: { type: 'string' },
            description: 'sessionIds from the packet that demonstrate this waste.',
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are ccopt's cost-optimization agent. You are given telemetry for ONE tenant's AI agent: a digest of every analyzed run (tool calls, files read, folders listed, web fetches/searches, bash commands, prompt sizes, token/cache economics, canonical step sequence, error/dataflow structure) plus procedure clusters with determinism scores from a deterministic graph engine.

Your job: produce concrete bullets on how to make this agent cost less WITHOUT hurting its task performance.

Two fields encode what is safe:
- Each run's toolClassProfile and each segment's mechanicalRatio classify steps as mechanical (pure lookups — scriptable with no LLM), cacheable (idempotent fetches), generative (the intelligence), or side_effect (must be preserved; automate only with guards). The mechanicalRatio is the compile/route headroom.
- "segments" are repeated sub-sequences mined ACROSS runs (support = runs containing them), with segment-level determinism (canonical-I/O equality across occurrences) and attributed cost. A high-support, high-determinism, high-mechanicalRatio segment is the safest money in the report: compile it to a script, or route just that segment to a small model. Reference segments by their labels and evidence runs.

What to look for (use the run content, not just aggregates):
- REPEATED LOOKUPS: the same files, folders, repos, or web domains read across many runs → precompute a summary/context artifact (e.g. a knowledge file or CLAUDE.md section) and stop re-discovering. Repeated web searches on stable topics → replace with a cached summary refreshed on a schedule.
- PROMPT WASTE: large first prompts repeated across runs with small variations → shrink the prompt; move the stable part to a cached prefix (prompt cache reads cost ~10% of fresh input). Low cacheReadRatio (<0.5) = the prefix churns; stabilize it.
- DETERMINISTIC SEGMENTS: clusters or step sub-sequences with determinism ≥ 0.9 → compile to a plain script (no LLM at all), or route JUST THAT SEGMENT of the graph to a much smaller model (Haiku ≈ 5-6x cheaper than Sonnet; Sonnet ≈ 5x cheaper than Opus) while the open-ended reasoning stays on the capable model. When you propose this, name the exact segment: the step indexes/labels from stepSequence or the cluster's labelSequence (e.g. "steps #4-#11: the fetch→normalize→upsert chain"), so the owner modifies only that part of the pipeline. Low-determinism work must stay on the capable model — flag risk honestly.
- IDENTICAL RE-RUNS: equal inputs re-executed → serve a cached result (risk: none).
- FAILURE TAX: error steps and retry motifs → root-cause once, add a guard; non-final attempts are pure re-payment.
- BATCHABLE WORK: runs that are not latency-sensitive → 50% off via batch processing.

Rules:
- Every insight cites evidence_runs (sessionIds from the packet) — the reader opens each run's graph to verify.
- Derive est_monthly_saving_usd from the actual costs in the packet (extrapolate by windowDays and say so in the rationale). Never invent spend.
- performance_risk is as important as savings: "none" = mathematically identical output; "high" = could change behavior. Be conservative.
- implementation must be specific to THIS agent's tools/files/domains — name them.
- Order by est_monthly_saving_usd descending. 3-10 insights. If runsAnalyzed < runsTotal, note the sampling in the summary. If the data is too thin, say so and only propose what it supports.`;

export async function generateInsights(
  llm: LlmProvider,
  packet: InsightsPacket,
  agentFilter?: string,
): Promise<InsightsResult> {
  const parsed = (await llm.generateJson({
    system: SYSTEM_PROMPT,
    prompt:
      'Analyze this agent telemetry and produce the cost-reduction bullets.\n\n```json\n' +
      JSON.stringify(packet) +
      '\n```',
    schema: INSIGHTS_SCHEMA,
  })) as { summary: string; insights: Insight[] };

  return {
    summary: parsed.summary,
    insights: parsed.insights,
    provider: llm.name,
    model: llm.model,
    generatedAt: new Date().toISOString(),
    runsAnalyzed: packet.runsAnalyzed,
    agentFilter: agentFilter ?? null,
    runsTotalAtGeneration: packet.runsTotal,
  };
}
