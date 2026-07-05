/**
 * Tool taxonomy — classify every step by what it fundamentally is, which
 * determines what optimization is safe:
 *
 *   mechanical  — pure lookups (file reads, globs, greps, read-only shell):
 *                 same input + same repo state → same output. A script can do
 *                 this without an LLM; the model only "decides" to call it.
 *   cacheable   — idempotent external fetches (WebFetch, curl GET, WebSearch):
 *                 repeatable, results change slowly → cache with a TTL or
 *                 replace with a precomputed summary.
 *   generative  — model turns, thinking, subagent spawns: the intelligence.
 *                 Only optimizable via model right-sizing / prompt work.
 *   side_effect — writes, edits, mutating shell (git push, rm, deploys):
 *                 must be preserved exactly; automate only with guards.
 *
 * The mechanical ratio of a run/segment is the honest upper bound on "how much
 * of this procedure doesn't need intelligence at all" — the compile headroom.
 */

import type { GraphNode, RawStep, StepKind } from './types.js';

export type StepClass = 'mechanical' | 'cacheable' | 'generative' | 'side_effect';

const MECHANICAL_TOOLS = new Set([
  'read', 'glob', 'grep', 'ls', 'notebookread', 'toolsearch', 'tasklist', 'taskget',
]);
const CACHEABLE_TOOLS = new Set(['webfetch', 'web_fetch', 'websearch', 'web_search']);
const SIDE_EFFECT_TOOLS = new Set([
  'write', 'edit', 'multiedit', 'notebookedit', 'taskcreate', 'taskupdate', 'sendmessage',
]);
const GENERATIVE_TOOLS = new Set(['task', 'agent', 'workflow', 'skill', 'advisor']);

// Read-only shell commands: safe to script, output depends only on inputs + state read.
const RO_BASH =
  /^\s*(ls|cat|head|tail|wc|grep|rg|find|pwd|which|whoami|echo|printf|stat|du|df|ps|env|printenv|jq|yq|sort|uniq|cut|awk|sed -n|tr|diff|cmp|file|basename|dirname|realpath|readlink|md5|shasum|sha256sum|git (status|log|diff|show|branch|remote|rev-parse|describe|blame|ls-files)|npm (ls|view|outdated)|node --version|python3? --version|curl (-s+ )?-?-head|type)\b/i;
// Idempotent network reads
const FETCH_BASH = /^\s*(curl|wget|http)\b(?![^|]*(-X\s*(POST|PUT|DELETE|PATCH)|--data|-d\s))/i;

export function classifyBashCommand(command: string): StepClass {
  // pipelines: classify by the most dangerous stage
  const stages = command.split(/\||&&|;/).map((s) => s.trim()).filter(Boolean);
  let cls: StepClass = 'mechanical';
  for (const stage of stages) {
    if (RO_BASH.test(stage)) continue;
    if (FETCH_BASH.test(stage)) {
      if (cls === 'mechanical') cls = 'cacheable';
      continue;
    }
    return 'side_effect'; // unknown or mutating stage — conservative
  }
  return cls;
}

export function classifyStep(step: Pick<RawStep, 'kind' | 'name' | 'payload'>): StepClass {
  if (step.kind === 'model_turn' || step.kind === 'thinking') return 'generative';
  if (step.kind === 'tool_result') return classifyStep({ ...step, kind: 'tool_use' });
  const name = step.name.toLowerCase();
  if (MECHANICAL_TOOLS.has(name)) return 'mechanical';
  if (CACHEABLE_TOOLS.has(name)) return 'cacheable';
  if (SIDE_EFFECT_TOOLS.has(name)) return 'side_effect';
  if (GENERATIVE_TOOLS.has(name)) return 'generative';
  if (name === 'bash' || name === 'shell') {
    try {
      const input = JSON.parse(step.payload) as { command?: string };
      if (typeof input.command === 'string') return classifyBashCommand(input.command);
    } catch {
      /* raw payload */
    }
    return 'side_effect';
  }
  return 'side_effect'; // unknown tools: conservative
}

export function classifyNode(node: Pick<GraphNode, 'kind' | 'label' | 'raw'>): StepClass {
  const name = node.label.startsWith('tool:')
    ? node.label.slice(5).split(' ')[0]
    : node.label.startsWith('result:')
      ? node.label.slice(7).split(' ')[0]
      : node.label.split(':')[0];
  const kind: StepKind = node.label.startsWith('tool:')
    ? 'tool_use'
    : node.label.startsWith('result:')
      ? 'tool_result'
      : node.label === 'thinking'
        ? 'thinking'
        : 'model_turn';
  return classifyStep({ kind, name, payload: node.raw });
}

export interface ToolProfile {
  total: number;
  mechanical: number;
  cacheable: number;
  generative: number;
  sideEffect: number;
  /** Fraction of tool steps needing no intelligence — the compile headroom. */
  mechanicalRatio: number;
  byClass: Record<string, StepClass>;
}

/** Profile a run's tool_use steps (results/thinking excluded from counts). */
export function toolProfile(steps: Pick<RawStep, 'kind' | 'name' | 'payload'>[]): ToolProfile {
  const byClass: Record<string, StepClass> = {};
  let mechanical = 0, cacheable = 0, generative = 0, sideEffect = 0, total = 0;
  for (const step of steps) {
    if (step.kind !== 'tool_use') continue;
    total++;
    const cls = classifyStep(step);
    byClass[step.name] = cls;
    if (cls === 'mechanical') mechanical++;
    else if (cls === 'cacheable') cacheable++;
    else if (cls === 'generative') generative++;
    else sideEffect++;
  }
  return {
    total, mechanical, cacheable, generative, sideEffect,
    mechanicalRatio: total === 0 ? 0 : Math.round(((mechanical + cacheable) / total) * 100) / 100,
    byClass,
  };
}
