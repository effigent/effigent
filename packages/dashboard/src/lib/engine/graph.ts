// VENDORED from packages/core|server (dashboard can't take workspace deps on Vercel).
/**
 * Run → canonical graph — spec §3.1/§3.3.
 *
 * Nodes are steps with canonical labels; edges are temporal (always) plus
 * dataflow (output of node i appears in input of node j). Fingerprints:
 *   L0 = hash(structure + labels + canonical I/O)  → "literally the same thing"
 *   L1 = hash(structure + labels)                  → "same procedure, different data"
 *
 * Serialization is the canonical topological order of the near-linear chain
 * (temporal order, with parallel tool calls kept in emission order). Exact for
 * the near-linear reality; documented limitation for true DAG fan-out.
 */

import { createHash } from 'node:crypto';
import type { GraphEdge, GraphNode, Run, RunGraph, StepTokens } from './types.ts';
import {
  canonicalizeText,
  modelTurnLabel,
  normalizeWs,
  outputShape,
  structLabelOf,
  templateOf,
  toolLabel,
} from './canonicalize.ts';
import { usageCostUsd } from './cost.ts';

function stepCostUsd(model: string | undefined, tokens: StepTokens | undefined): number {
  if (!model || !tokens) return 0;
  return usageCostUsd(model, {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheCreationInputTokens: tokens.cacheCreation ?? 0,
    cacheReadInputTokens: tokens.cacheRead ?? 0,
  });
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Tokens of an output that are distinctive enough to witness dataflow. */
function significantTokens(text: string, max = 40): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of text.split(/[\s"'`,;()[\]{}<>]+/)) {
    if (tok.length < 12 || tok.length > 200) continue;
    if (/^[<>-]+$/.test(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= max) break;
  }
  return out;
}

export function buildRunGraph(run: Run): RunGraph {
  const nodes: GraphNode[] = [];

  for (const step of run.steps) {
    let label: string;
    let canonicalValue: string;
    switch (step.kind) {
      case 'tool_use': {
        let input: unknown = step.payload;
        try {
          input = JSON.parse(step.payload);
        } catch {
          /* keep raw string */
        }
        label = toolLabel(step.name, input);
        canonicalValue = canonicalizeText(step.payload).slice(0, 4000);
        break;
      }
      case 'tool_result': {
        label = `result:${step.name} ${step.isError ? 'error' : 'ok'} ${outputShape(step.payload).split(':')[0]}`;
        canonicalValue = canonicalizeText(step.payload).slice(0, 4000);
        break;
      }
      case 'thinking': {
        label = 'thinking';
        canonicalValue = '';
        break;
      }
      default: {
        label = modelTurnLabel(step.name, step.payload);
        canonicalValue = canonicalizeText(step.payload).slice(0, 4000);
      }
    }
    nodes.push({
      index: nodes.length,
      kind: step.kind,
      label,
      structLabel: structLabelOf(step.kind, step.name, step.payload, step.isError),
      canonicalValue,
      // Hash of the FULL stored payload (whitespace-normalized only): value
      // agreement must not be blind to numbers or to bytes past a display slice.
      valueHash: sha256(normalizeWs(step.payload)),
      isError: step.isError === true,
      raw: step.payload.slice(0, 4000),
      toolUseId: step.toolUseId,
      model: step.model,
      costUsd: stepCostUsd(step.model, step.tokens),
      tokensIn: step.tokens?.input,
      tokensOut: step.tokens?.output,
    });
  }

  const edges: GraphEdge[] = [];
  for (let i = 1; i < nodes.length; i++) {
    edges.push({ from: i - 1, to: i, type: 'temporal' });
  }

  // Dataflow: outputs of results/model turns flowing into later tool inputs.
  const WINDOW = 12; // near-linear chains: dataflow is local in practice
  for (let i = 0; i < nodes.length; i++) {
    const src = nodes[i];
    if (src.kind !== 'tool_result' && src.kind !== 'model_turn') continue;
    const tokens = significantTokens(src.raw);
    if (tokens.length === 0) continue;
    for (let j = i + 1; j < Math.min(nodes.length, i + 1 + WINDOW); j++) {
      const dst = nodes[j];
      if (dst.kind !== 'tool_use' && dst.kind !== 'model_turn') continue;
      if (tokens.some((t) => dst.raw.includes(t))) {
        edges.push({ from: i, to: j, type: 'dataflow' });
      }
    }
  }

  const labelSequence = nodes.map((n) => n.label);
  const l1 = sha256(labelSequence.join('␞'));
  const l0 = sha256(
    nodes.map((n) => `${n.label}␟${n.canonicalValue}`).join('␞'),
  );

  return {
    runId: run.runId,
    agentId: run.agentId,
    nodes,
    edges,
    l0,
    l1,
    labelSequence,
    costUsd: run.costUsd,
    startedAt: run.startedAt,
    models: run.models,
    usageByModel: run.usageByModel,
    canonicalFinalOutput: run.finalOutput ? canonicalizeText(run.finalOutput).slice(0, 4000) : undefined,
    finalOutputTemplate: run.finalOutput ? templateOf(run.finalOutput) : undefined,
    canonicalFirstPrompt: run.firstPrompt ? canonicalizeText(run.firstPrompt).slice(0, 2000) : undefined,
    firstPrompt: run.firstPrompt?.slice(0, 500),
  };
}
