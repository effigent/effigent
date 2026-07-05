/**
 * AI insights — an LLM reviews the deterministic engine's output (clusters,
 * graphs, findings, cost data) and reasons about *semantic* cost reductions the
 * rule engine can't see: refetching static content, prompts that defeat the
 * cache, retries rooted in a missing flag, steps a cheaper model could own.
 *
 * The engine finds structure; Claude judges meaning. Output is structured JSON
 * (schema-enforced) so it renders in the dashboard and is diffable over time.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ClusterSummary, Finding, WasteReport } from '@ccopt/core';

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

export interface Insight {
  title: string;
  category:
    | 'prompt-caching'
    | 'model-rightsizing'
    | 'result-caching'
    | 'compile-procedure'
    | 'fix-failures'
    | 'precompute-context'
    | 'prompt-engineering'
    | 'other';
  est_monthly_saving_usd: number;
  performance_risk: 'none' | 'low' | 'medium' | 'high';
  rationale: string;
  implementation: string;
  evidence: string;
}

export interface InsightsResult {
  summary: string;
  insights: Insight[];
  model: string;
  generatedAt: string;
}

const INSIGHTS_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['summary', 'insights'],
  properties: {
    summary: {
      type: 'string',
      description: 'Two-to-four sentence executive summary of where this agent wastes money and the single highest-leverage change.',
    },
    insights: {
      type: 'array',
      items: {
        type: 'object' as const,
        additionalProperties: false,
        required: [
          'title',
          'category',
          'est_monthly_saving_usd',
          'performance_risk',
          'rationale',
          'implementation',
          'evidence',
        ],
        properties: {
          title: { type: 'string' },
          category: {
            type: 'string',
            enum: [
              'prompt-caching',
              'model-rightsizing',
              'result-caching',
              'compile-procedure',
              'fix-failures',
              'precompute-context',
              'prompt-engineering',
              'other',
            ],
          },
          est_monthly_saving_usd: { type: 'number' },
          performance_risk: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
          rationale: { type: 'string' },
          implementation: { type: 'string' },
          evidence: { type: 'string', description: 'Which clusters/steps/metrics in the packet support this.' },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are ccopt's cost-optimization analyst. You review telemetry from AI agents built on Claude (canonical run graphs, procedure clusters, token/cost metrics) and identify how to reduce the agent's spend WITHOUT hurting its task performance.

Ground rules:
- Only propose changes justified by the data given. Cite the specific clusters, steps, or metrics (the "evidence" field).
- Quantify honestly: derive savings from the cluster costs and run counts provided; when extrapolating, say so in the rationale. Never invent spend that isn't in the packet.
- Performance risk is as important as savings. "none" = mathematically equivalent output (e.g. serving a cached identical result); "high" = could change agent behavior (e.g. swapping models on a low-determinism procedure). Deterministic procedures (determinism ≥ 0.9) are safe to compile/cache; low-determinism ones are not.
- Claude-specific levers you may reason about: prompt caching (cache reads cost ~10% of fresh input; cache-read ratios below ~50% signal prefix churn), model right-sizing (Haiku ≈ 5-6x cheaper than Sonnet, Sonnet ≈ 5x cheaper than Opus per token), batch API (50% off for non-latency-sensitive work), shorter/stable system prompts, fewer retries via guards, precomputing shared exploration context (e.g. CLAUDE.md), compiling deterministic tool sequences into plain scripts that skip the LLM entirely.
- Order insights by est_monthly_saving_usd descending. 3-7 insights. If the data is too thin for a recommendation (few runs, one cluster), say so in the summary and only propose what the data supports.`;

export interface InsightsPacket {
  windowDays: number;
  totals: WasteReport['totals'];
  agents: string[];
  clusters: InsightsPacketCluster[];
  engineFindings: Pick<Finding, 'kind' | 'title' | 'estMonthlySavingUsd' | 'recommendation'>[];
}

export function buildInsightsPacket(
  report: WasteReport,
  clusters: InsightsPacketCluster[],
): InsightsPacket {
  return {
    windowDays: report.windowDays,
    totals: report.totals,
    agents: report.agentIds,
    // biggest spenders first, bounded so the packet stays compact
    clusters: clusters
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
      .slice(0, 12)
      .map((c) => ({
        ...c,
        labelSequence:
          c.labelSequence.length > 60
            ? [...c.labelSequence.slice(0, 60), `… ${c.labelSequence.length - 60} more steps`]
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

export async function generateInsights(packet: InsightsPacket): Promise<InsightsResult> {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: INSIGHTS_SCHEMA } },
    messages: [
      {
        role: 'user',
        content:
          `Analyze this agent telemetry and produce cost-reduction insights that do not hurt agent performance.\n\n` +
          '```json\n' +
          JSON.stringify(packet) +
          '\n```',
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('analysis was refused by the model');
  }
  const text = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === 'text',
  )?.text;
  if (!text) throw new Error('model returned no analysis text');
  const parsed = JSON.parse(text) as { summary: string; insights: Insight[] };

  return {
    summary: parsed.summary,
    insights: parsed.insights,
    model: response.model,
    generatedAt: new Date().toISOString(),
  };
}

export type { ClusterSummary };
