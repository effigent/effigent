/**
 * Tool synthesis — v3 stages 4–5 (docs/determinism-v3.md). The deferred
 * "W4": turn the deterministic part of an agent's history into an actual tool.
 *
 * SLICE: scan a cluster's aligned columns for maximal contiguous spans where
 * every column is compilable —
 *   tool_use   at D0 (constant call) or D1 (all slots provenance-derived),
 *   tool_result following a compilable call,
 *   model_turn only when D0 (constant chatter),
 *   thinking   always (the tool elides the deliberation — that's the point) —
 * with ≥50% support and clean/moderate dataflow boundaries. side_effect calls
 * are allowed but flagged `guarded` (dry-run + exact-template match required).
 *
 * SYNTHESIZE: each span becomes a deterministic ToolSpec — typed parameters
 * (prompt-sourced or caller-context slots), a body of recorded calls with
 * `${param}` / `${derive(cN.method)}` substitutions, per-step output
 * expectations, and a measured savings estimate that includes the
 * context-carriage tax (intermediate results stop being re-read every turn).
 * No LLM is needed to emit the spec; codegen from the spec is mechanical for
 * mechanical/cacheable steps and LLM-assisted for the rest.
 */

import { createHash } from 'node:crypto';
import type { StepKind } from './types.js';
import { pricingFor } from './cost.js';
import { normalizeWs } from './canonicalize.js';
import type { StepClass } from './taxonomy.js';
import {
  columnTemplate,
  SLOT_MARK,
  tokenize,
  type ClusterAnalysis,
  type NodeAnalysis,
} from './determinism.js';

export interface ToolSpecParam {
  name: string;
  type: 'path' | 'url' | 'number' | 'id' | 'string';
  source: 'prompt' | 'caller';
  examples: string[];
}

export interface ToolSpecSubstitution {
  /** Slot ordinal within the step's template. */
  slot: number;
  kind: 'param' | 'derive';
  /** Param name when kind === 'param'. */
  param?: string;
  /** Source column + extraction when the value is derivable (also kept for
   *  caller params derived from pre-span columns, so replay can verify). */
  sourceColumn?: number;
  method?: string;
}

export interface ToolSpecStep {
  column: number;
  kind: StepKind;
  tool: string;
  /** Display string: constants + ${p1} + ${derive(c12.json:items.0.id)}. */
  argTemplate: string;
  /** Template tokens (slots = '⟨·⟩', join('') = the argument) — replay matches THESE. */
  argTokens: string[];
  substitutions: ToolSpecSubstitution[];
  /** Column index of this call's result, when inside the span. */
  resultColumn?: number;
  /** Slotted template the result must match (⟨·⟩ = anything) — display. */
  expectedOutputTemplate?: string;
  /** Output template tokens — replay matches these. */
  expectedOutputTokens?: string[];
  class: StepClass;
  guarded: boolean;
}

export interface ToolSpec {
  /** Stable across windows: hash(agent | span structLabels | 'compile'). */
  id: string;
  agentId: string;
  name: string;
  clusterKey: string;
  /** Medoid column indexes covered (inclusive range). */
  columns: number[];
  params: ToolSpecParam[];
  body: ToolSpecStep[];
  /** The unit's final output contract. */
  postcondition?: string;
  evidence: {
    runs: number;
    /** min column support ÷ cluster runs. */
    support: number;
    minColumnConfidence: number;
    exampleRunIds: string[];
  };
  savings: {
    /** Measured per-run cost of the span's columns (per-step tokens). */
    perRunUsd: number;
    /** Context-carriage: intermediate results re-read by every later turn. */
    carriagePerRunUsd: number;
    windowUsd: number;
    note: string;
  };
  separability: 'clean' | 'moderate' | 'entangled';
}

export interface SynthesizeOptions {
  /** Column support required, as a share of cluster runs. */
  minSupportShare?: number;
  minColumns?: number;
  minToolUses?: number;
}

function inferType(v: string): ToolSpecParam['type'] {
  if (/^https?:\/\//.test(v)) return 'url';
  if (v.startsWith('/') || v.startsWith('./') || v.startsWith('~/') || /\/[^\s]+\//.test(v)) return 'path';
  if (/^-?\d+(\.\d+)?$/.test(v)) return 'number';
  if (/^[0-9a-fA-F-]{7,}$/.test(v) && /\d/.test(v)) return 'id';
  return 'string';
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}

function toolNameOf(structLabel: string): string {
  if (structLabel.startsWith('tool:')) return structLabel.slice(5).split('(')[0];
  if (structLabel.startsWith('result:')) return structLabel.slice(7).split(':')[0];
  return structLabel;
}

/** Dataflow crossings of the medoid graph relative to [lo, hi] (inclusive). */
function separabilityOf(
  analysis: ClusterAnalysis,
  lo: number,
  hi: number,
): ToolSpec['separability'] {
  let crossings = 0;
  for (const e of analysis.alignment.cluster.medoid.edges) {
    if (e.type !== 'dataflow') continue;
    const fromIn = e.from >= lo && e.from <= hi;
    const toIn = e.to >= lo && e.to <= hi;
    if (fromIn !== toIn) crossings++;
  }
  return crossings <= 2 ? 'clean' : crossings <= 5 ? 'moderate' : 'entangled';
}

interface Span {
  start: number;
  end: number;
  toolUses: number;
}

function extractSpans(analysis: ClusterAnalysis, opts: Required<SynthesizeOptions>): Span[] {
  const { nodes, runCount } = analysis;
  const minSupport = Math.ceil(runCount * opts.minSupportShare);

  const compilable = (n: NodeAnalysis, lastUseCompilable: boolean): boolean => {
    if (n.support < minSupport) return false;
    switch (n.kind) {
      case 'thinking':
        return true;
      case 'tool_use':
        return (n.level === 'D0' || n.level === 'D1') && n.class !== 'generative';
      case 'tool_result':
        return lastUseCompilable;
      default: // model_turn
        return n.level === 'D0';
    }
  };

  const spans: Span[] = [];
  let start = -1;
  let toolUses = 0;
  let lastUseCompilable = false;
  const flush = (end: number) => {
    if (start >= 0 && end - start + 1 >= opts.minColumns && toolUses >= opts.minToolUses) {
      spans.push({ start, end, toolUses });
    }
    start = -1;
    toolUses = 0;
    lastUseCompilable = false;
  };

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'tool_use') lastUseCompilable = compilable(n, false);
    if (compilable(n, n.kind === 'tool_result' ? lastUseCompilable : false)) {
      if (start < 0) start = i;
      if (n.kind === 'tool_use') toolUses++;
    } else {
      flush(i - 1);
    }
  }
  flush(nodes.length - 1);
  return spans;
}

/** Build ToolSpecs for every compile unit found across the analyzed clusters. */
export function synthesizeTools(
  analyses: ClusterAnalysis[],
  opts: SynthesizeOptions = {},
): ToolSpec[] {
  const options: Required<SynthesizeOptions> = {
    minSupportShare: opts.minSupportShare ?? 0.5,
    minColumns: opts.minColumns ?? 3,
    minToolUses: opts.minToolUses ?? 2,
  };

  const specs: ToolSpec[] = [];
  for (const analysis of analyses) {
    const { alignment, nodes } = analysis;
    const medoid = alignment.cluster.medoid;

    for (const span of extractSpans(analysis, options)) {
      const separability = separabilityOf(analysis, span.start, span.end);
      if (separability === 'entangled') continue;

      const spanNodes = nodes.slice(span.start, span.end + 1);
      const params: ToolSpecParam[] = [];
      const body: ToolSpecStep[] = [];
      let minConf = 100;
      let perRunUsd = 0;

      const addParam = (source: ToolSpecParam['source'], examples: string[]): string => {
        const name = `p${params.length + 1}`;
        params.push({
          name,
          type: inferType(examples[0] ?? ''),
          source,
          examples: examples.slice(0, 3),
        });
        return name;
      };

      for (const n of spanNodes) {
        perRunUsd += n.estUsdPerRun;
        if (n.action !== 'keep') minConf = Math.min(minConf, n.confidence);
        if (n.kind !== 'tool_use') continue;

        const substitutions: ToolSpecSubstitution[] = [];
        let argTokens: string[];
        let argTemplate: string;
        if (n.level === 'D0' || !n.templateTokens) {
          argTokens = tokenize(normalizeWs(medoid.nodes[n.index].raw));
          argTemplate = argTokens.join('');
        } else {
          // Fill the k-th ⟨·⟩ with a derive() or a parameter, per provenance.
          argTokens = n.templateTokens;
          let slot = 0;
          argTemplate = argTokens
            .map((tok) => {
              if (!tok.includes(SLOT_MARK)) return tok;
              const trace = n.provenance?.[slot];
              const s = slot++;
              // Substitutions produce the FULL token (that's what provenance
              // traced), so the marker replaces the whole token in the display.
              if (trace?.kind === 'derived' && trace.sourceColumn !== undefined) {
                if (trace.sourceColumn >= span.start) {
                  substitutions.push({
                    slot: s,
                    kind: 'derive',
                    sourceColumn: trace.sourceColumn,
                    method: trace.method,
                  });
                  return `\${derive(c${trace.sourceColumn}.${trace.method})}`;
                }
                // Derived from BEFORE the span — the caller has it; parameterize,
                // but keep provenance so replay can still verify it.
                const p = addParam('caller', trace.examples);
                substitutions.push({
                  slot: s,
                  kind: 'param',
                  param: p,
                  sourceColumn: trace.sourceColumn,
                  method: trace.method,
                });
                return `\${${p}}`;
              }
              const p = addParam('prompt', trace?.examples ?? []);
              substitutions.push({ slot: s, kind: 'param', param: p });
              return `\${${p}}`;
            })
            .join('');
        }

        // Result expectation, when the call's result column sits inside the span.
        const next = nodes[n.index + 1];
        let resultColumn: number | undefined;
        let expectedOutputTemplate: string | undefined;
        let expectedOutputTokens: string[] | undefined;
        if (next && next.kind === 'tool_result' && next.index <= span.end) {
          resultColumn = next.index;
          const col = alignment.columns[next.index];
          const t = columnTemplate(col.nodes.map((x) => (x ? normalizeWs(x.raw) : null)));
          expectedOutputTokens = t?.tokens ?? tokenize(normalizeWs(medoid.nodes[next.index].raw));
          expectedOutputTemplate = expectedOutputTokens.join('');
        }

        body.push({
          column: n.index,
          kind: n.kind,
          tool: toolNameOf(n.structLabel),
          argTemplate,
          argTokens,
          substitutions,
          resultColumn,
          expectedOutputTemplate,
          expectedOutputTokens,
          class: n.class,
          guarded: n.class === 'side_effect',
        });
      }

      if (body.length === 0) continue;

      // Context-carriage: every intermediate result is re-read by each later
      // turn (cache reads at ~10% of input price — a floor, and raw is a
      // truncated floor too, so this UNDERestimates).
      const model = medoid.models[0] ?? 'claude-sonnet-4';
      const inputPerM = pricingFor(model).inputPerM;
      const turnsAfter = nodes.filter(
        (n) => n.index > span.end && n.kind === 'model_turn' && n.support > 0,
      ).length;
      let carriagePerRunUsd = 0;
      for (const n of spanNodes) {
        if (n.kind !== 'tool_result' || n.index === span.end) continue;
        const col = alignment.columns[n.index];
        const nonGap = col.nodes.filter((x): x is NonNullable<typeof x> => x !== null);
        if (nonGap.length === 0) continue;
        const meanChars = nonGap.reduce((s, x) => s + x.raw.length, 0) / nonGap.length;
        carriagePerRunUsd += ((meanChars / 4) * turnsAfter * inputPerM * 0.1) / 1_000_000;
      }

      const spanLabels = spanNodes.map((n) => n.structLabel).join('>');
      const toolNames = [...new Set(body.map((b) => b.tool))].slice(0, 3);
      const supportShare =
        Math.min(...spanNodes.map((n) => n.support)) / Math.max(1, analysis.runCount);

      specs.push({
        id: createHash('sha256')
          .update(`${analysis.agentId}|${spanLabels}|compile`)
          .digest('hex')
          .slice(0, 16),
        agentId: analysis.agentId,
        name: slug(`${analysis.agentId}_${toolNames.join('_')}`),
        clusterKey: analysis.l1,
        columns: spanNodes.map((n) => n.index),
        params,
        body,
        postcondition: [...body].reverse().find((b) => b.expectedOutputTemplate)
          ?.expectedOutputTemplate,
        evidence: {
          runs: analysis.runCount,
          support: Math.round(supportShare * 100) / 100,
          minColumnConfidence: minConf === 100 ? 0 : minConf,
          exampleRunIds: analysis.runIds.slice(0, 5),
        },
        savings: {
          perRunUsd: Math.round(perRunUsd * 10000) / 10000,
          carriagePerRunUsd: Math.round(carriagePerRunUsd * 10000) / 10000,
          windowUsd:
            Math.round((perRunUsd + carriagePerRunUsd) * analysis.runCount * 100) / 100,
          note: 'generation cost of the span + intermediate results re-read by later turns (cache-read floor; payloads truncated at capture, so this underestimates)',
        },
        separability,
      });
    }
  }

  return specs.sort((a, b) => b.savings.windowUsd - a.savings.windowUsd);
}
