/**
 * Offline replay validation — v3 stage 6 (docs/determinism-v3.md).
 *
 * Before a synthesized tool may activate, prove it against the recorded runs
 * it was mined from — NO live execution: for every run, recompute each body
 * step's arguments from the run's recorded upstream outputs (the same
 * derivations the tool would perform) and check they reproduce the arguments
 * the agent actually issued; check recorded outputs against the spec's output
 * templates. A spec is `ready` at ≥95% pass over ≥10 runs, `shadow` otherwise
 * (keep scoring incoming runs until it earns activation).
 */

import { normalizeWs } from './canonicalize.js';
import { extractByMethod } from './provenance.js';
import { SLOT_MARK, tokenize, type ClusterAnalysis } from './determinism.js';
import type { ToolSpec } from './synthesize.js';

export interface ReplayFailure {
  runId: string;
  column: number;
  reason:
    | 'arg-structure'
    | 'arg-const'
    | 'arg-derive'
    | 'arg-param'
    | 'output-structure'
    | 'output-value';
}

export interface ReplayReport {
  toolId: string;
  runsChecked: number;
  passed: number;
  /** 0–1 over participating runs. */
  passRate: number;
  status: 'ready' | 'shadow';
  /** First few failures, for diagnosis. */
  failures: ReplayFailure[];
}

const READY_PASS_RATE = 0.95;
const READY_MIN_RUNS = 10;
const MAX_FAILURES_REPORTED = 5;

/**
 * Validate one ToolSpec against the alignment it was synthesized from.
 * A run participates iff it has a node in every column the spec covers.
 */
export function replayToolSpec(spec: ToolSpec, analysis: ClusterAnalysis): ReplayReport {
  const { columns } = analysis.alignment;
  const runs = analysis.alignment.cluster.runs;
  const failures: ReplayFailure[] = [];
  let runsChecked = 0;
  let passed = 0;

  for (let ri = 0; ri < runs.length; ri++) {
    if (!spec.columns.every((c) => columns[c]?.nodes[ri])) continue; // gap — didn't exercise the unit
    runsChecked++;
    const prompt = runs[ri].firstPrompt ?? runs[ri].canonicalFirstPrompt ?? '';
    let failure: ReplayFailure | null = null;

    for (const step of spec.body) {
      const node = columns[step.column].nodes[ri]!;
      const recorded = tokenize(normalizeWs(node.raw));
      const templ = step.argTokens;
      if (recorded.length !== templ.length) {
        failure = { runId: runs[ri].runId, column: step.column, reason: 'arg-structure' };
        break;
      }

      let slot = 0;
      for (let t = 0; t < templ.length && !failure; t++) {
        const expected = templ[t];
        const actual = recorded[t];
        const si = expected.indexOf(SLOT_MARK);
        if (si < 0) {
          if (expected !== actual) {
            failure = { runId: runs[ri].runId, column: step.column, reason: 'arg-const' };
          }
          continue;
        }
        // Micro-template token: constant prefix/suffix constrain structure;
        // substitutions reproduce the FULL token (what provenance traced).
        const pre = expected.slice(0, si);
        const post = expected.slice(si + SLOT_MARK.length);
        if (
          !actual.startsWith(pre) ||
          !actual.endsWith(post) ||
          actual.length < pre.length + post.length
        ) {
          failure = { runId: runs[ri].runId, column: step.column, reason: 'arg-const' };
          continue;
        }
        const sub = step.substitutions[slot++];
        if (!sub) continue;
        if (sub.sourceColumn !== undefined && sub.method) {
          const src = columns[sub.sourceColumn]?.nodes[ri];
          if (!src) {
            failure = { runId: runs[ri].runId, column: step.column, reason: 'arg-derive' };
            continue;
          }
          const derived = extractByMethod(src.raw, sub.method);
          const ok = derived === null ? src.raw.includes(actual) : derived === actual;
          if (!ok) {
            failure = { runId: runs[ri].runId, column: step.column, reason: 'arg-derive' };
          }
        } else if (sub.kind === 'param') {
          if (!prompt.includes(actual)) {
            failure = { runId: runs[ri].runId, column: step.column, reason: 'arg-param' };
          }
        }
      }
      if (failure) break;

      if (step.resultColumn !== undefined && step.expectedOutputTokens) {
        const res = columns[step.resultColumn].nodes[ri];
        if (res) {
          const out = tokenize(normalizeWs(res.raw));
          const outTempl = step.expectedOutputTokens;
          if (out.length !== outTempl.length) {
            failure = { runId: runs[ri].runId, column: step.resultColumn, reason: 'output-structure' };
            break;
          }
          for (let t = 0; t < outTempl.length; t++) {
            const si = outTempl[t].indexOf(SLOT_MARK);
            if (si < 0) {
              if (outTempl[t] !== out[t]) {
                failure = { runId: runs[ri].runId, column: step.resultColumn, reason: 'output-value' };
                break;
              }
              continue;
            }
            const pre = outTempl[t].slice(0, si);
            const post = outTempl[t].slice(si + SLOT_MARK.length);
            if (
              !out[t].startsWith(pre) ||
              !out[t].endsWith(post) ||
              out[t].length < pre.length + post.length
            ) {
              failure = { runId: runs[ri].runId, column: step.resultColumn, reason: 'output-value' };
              break;
            }
          }
          if (failure) break;
        }
      }
    }

    if (failure) {
      if (failures.length < MAX_FAILURES_REPORTED) failures.push(failure);
    } else {
      passed++;
    }
  }

  const passRate = runsChecked === 0 ? 0 : passed / runsChecked;
  return {
    toolId: spec.id,
    runsChecked,
    passed,
    passRate: Math.round(passRate * 100) / 100,
    status: passRate >= READY_PASS_RATE && runsChecked >= READY_MIN_RUNS ? 'ready' : 'shadow',
    failures,
  };
}
