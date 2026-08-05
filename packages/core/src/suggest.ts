/**
 * Tool suggestion — analysis output, deliberately NOT activation.
 *
 * Mines recurring workflows over the semantic action alphabet (actions.ts)
 * inside episodes (episodes.ts) and emits ranked, human-readable
 * ToolSuggestions with evidence: where the workflow recurred, what its
 * arguments look like (fixed template vs. varying slots → the proposed
 * parameters), how much LLM glue it drags along, and what it cost. A human
 * (or a later synthesis stage) decides what to do with it.
 *
 * Why this finds what the older miners could not: structLabels collapse ~70%
 * of a dev agent's calls into one opaque Bash label, and raw values almost
 * never repeat — but at the action-token altitude (`git:commit`, `pnpm:test`,
 * `gh:pr:create`) real workflows recur verbatim across runs.
 *
 * Anti-overfitting: thresholds fixed a priori and conservative (a workflow
 * must recur in ≥3 distinct runs AND ≥5 times overall); argument templates
 * come from the same columnTemplate machinery the D0–D5 lattice uses;
 * confidence is a Wilson lower bound on support. When unsure, suggest nothing.
 */

import { createHash } from 'node:crypto';
import type { RunGraph } from './types.js';
import { segmentEpisodes, type Episode } from './episodes.js';
import { attributeStepCosts } from './segments.js';
import { columnTemplate, wilsonLower } from './determinism.js';

const MIN_LEN = 3;
const MAX_LEN = 8;
const MIN_RUNS = 3;
const MIN_OCCURRENCES = 5;
const MIN_DISTINCT_ACTIONS = 2;
const MAX_SUGGESTIONS = 8;
/** A shorter motif survives only if it clearly out-occurs every extension. */
const DOMINANCE = 0.9;
/**
 * Vocabulary floor: an action token seen fewer times than this across the whole
 * window collapses to its program FAMILY (`git:stash` → `git`). Standard
 * min-count vocabulary construction — without it, one-off command combinations
 * explode the alphabet (measured: 1,322 tokens over 7,983 calls) and no motif
 * can recur.
 */
const MIN_TOKEN_FREQ = 3;
/**
 * Generic file/shell/editor primitives. A motif made ONLY of these is the
 * agent's inner coding loop (read → edit → edit …) — real recurrence, but there
 * is no tool boundary inside it: you cannot name it, parameterize it, or elide
 * its reasoning. Suggestions must contain at least one specific verb.
 * Measured before this gate, the entire top-8 on two different agents was such
 * churn; the gate is a statement about tool boundaries, not a fitted threshold.
 */
const PRIMITIVE = new Set([
  'read', 'edit', 'write', 'grep', 'glob', 'ls', 'cat', 'sed', 'awk', 'head', 'tail',
  'find', 'echo', 'bash', 'python3', 'python', 'node', 'say', 'think',
  'askuserquestion', 'todowrite', 'toolsearch', 'taskcreate', 'taskupdate', 'tasklist', 'taskget',
]);

/** Program family of a token: first stage's program (`git:add+git:commit` → `git`). */
function familyOf(token: string): string {
  return token.split('+')[0].split(':')[0];
}

function isSpecific(token: string): boolean {
  return !PRIMITIVE.has(token) && !PRIMITIVE.has(familyOf(token));
}

export interface SuggestionParam {
  name: string;
  type: 'path' | 'url' | 'number' | 'id' | 'string';
  /** Which motif steps (position indexes) consume it. */
  usedBy: number[];
  examples: string[];
}

export interface SuggestionStep {
  position: number;
  action: string;
  /** Slotted arg template across occurrences (⟨·⟩ = varies) — null if args never agree. */
  argTemplate: string | null;
  distinctArgs: number;
}

export interface ToolSuggestion {
  /** Stable id: hash of agent + action sequence. */
  id: string;
  /** Suggested tool name derived from the verbs. */
  name: string;
  actions: string[];
  steps: SuggestionStep[];
  params: SuggestionParam[];
  /** Distinct runs it recurred in / window size. */
  support: number;
  runsTotal: number;
  occurrences: number;
  /** Wilson lower bound on support share — how confidently this recurs. */
  confidence: number;
  /** Measured cost of all occurrences (tool steps + interleaved LLM glue). */
  totalCostUsd: number;
  avgCostPerOccurrenceUsd: number;
  /** Avg LLM turns interleaved inside the workflow per occurrence — what a tool would elide. */
  avgGlueSteps: number;
  /** Episode intents the workflow appeared under, most common first. */
  intents: string[];
  /** Up to 3 example asks that led to it. */
  exampleAsks: string[];
}

interface Occurrence {
  graph: RunGraph;
  episode: Episode;
  /** Graph node index per motif position. */
  nodes: number[];
}

const H = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

function inferType(v: string): SuggestionParam['type'] {
  if (/^https?:\/\//.test(v)) return 'url';
  if (v.startsWith('/') || v.startsWith('./') || v.startsWith('~/')) return 'path';
  if (/^-?\d+(\.\d+)?$/.test(v)) return 'number';
  if (/^[0-9a-fA-F-]{7,}$/.test(v) && /\d/.test(v)) return 'id';
  return 'string';
}

function suggestionName(actions: string[]): string {
  const verbs = actions
    .map((a) => a.split('+').pop()!.replace(/[^a-z0-9:]/gi, '').replace(/:/g, '_'))
    .filter(Boolean);
  const uniq: string[] = [];
  for (const v of verbs) if (uniq[uniq.length - 1] !== v) uniq.push(v);
  return uniq.slice(0, 4).join('_then_').slice(0, 60) || 'workflow';
}

/**
 * Mine recurring action n-grams across episodes and turn the survivors into
 * ranked tool suggestions.
 */
export function suggestTools(graphs: RunGraph[], maxSuggestions = MAX_SUGGESTIONS): ToolSuggestion[] {
  if (graphs.length < MIN_RUNS) return [];
  const episodes = graphs.flatMap(segmentEpisodes);
  const costsByRun = new Map(graphs.map((g) => [g.runId, attributeStepCosts(g)]));
  const graphById = new Map(graphs.map((g) => [g.runId, g]));

  // ---- vocabulary floor: collapse rare tokens to their family -------------------
  const freq = new Map<string, number>();
  for (const ep of episodes) for (const a of ep.actions) freq.set(a, (freq.get(a) ?? 0) + 1);
  const canon = (a: string) => ((freq.get(a) ?? 0) >= MIN_TOKEN_FREQ ? a : familyOf(a));
  const epActions = new Map<Episode, string[]>(episodes.map((ep) => [ep, ep.actions.map(canon)]));

  // ---- count n-grams (non-overlapping within an episode) ----------------------
  const motifs = new Map<string, { actions: string[]; occ: Occurrence[]; runs: Set<string> }>();
  for (const ep of episodes) {
    const g = graphById.get(ep.runId)!;
    const acts = epActions.get(ep)!;
    for (let len = MIN_LEN; len <= MAX_LEN; len++) {
      for (let i = 0; i + len <= acts.length; ) {
        const actions = acts.slice(i, i + len);
        if (new Set(actions).size < MIN_DISTINCT_ACTIONS) { i++; continue; }
        if (!actions.some(isSpecific)) { i++; continue; } // primitive churn — no tool boundary
        const key = actions.join('→');
        const rec = motifs.get(key) ?? { actions, occ: [], runs: new Set<string>() };
        rec.occ.push({ graph: g, episode: ep, nodes: ep.actionNodes.slice(i, i + len) });
        rec.runs.add(ep.runId);
        motifs.set(key, rec);
        i += 1; // slide by one for counting; occurrence overlap is resolved below
      }
    }
  }

  // ---- gates + de-overlap ------------------------------------------------------
  const candidates = [...motifs.entries()]
    .filter(([, m]) => m.runs.size >= MIN_RUNS)
    .map(([key, m]) => {
      // Drop overlapping occurrences (same episode, overlapping node ranges).
      const kept: Occurrence[] = [];
      let lastEnd = new Map<string, number>();
      for (const o of m.occ) {
        const epKey = `${o.episode.runId}:${o.episode.index}`;
        const from = o.nodes[0];
        if ((lastEnd.get(epKey) ?? -1) >= from) continue;
        kept.push(o);
        lastEnd.set(epKey, o.nodes[o.nodes.length - 1]);
      }
      return { key, actions: m.actions, occ: kept, runs: m.runs };
    })
    .filter((m) => m.occ.length >= MIN_OCCURRENCES);

  // ---- maximality: prefer the longest motif that keeps the occurrences ---------
  const dominated = new Set<string>();
  for (const a of candidates) {
    for (const b of candidates) {
      if (a === b || a.actions.length >= b.actions.length) continue;
      const bKey = b.actions.join('→');
      if (!bKey.includes(a.key)) continue; // a not a contiguous sub-sequence of b
      if (b.occ.length >= a.occ.length * DOMINANCE) { dominated.add(a.key); break; }
    }
  }

  const survivors = candidates.filter((m) => !dominated.has(m.key));

  // ---- score + argument analysis ------------------------------------------------
  const out: ToolSuggestion[] = survivors.map((m) => {
    // Cost: motif tool steps + their results + interleaved LLM glue.
    let cost = 0;
    let glue = 0;
    for (const o of m.occ) {
      const costs = costsByRun.get(o.graph.runId)!;
      const first = o.nodes[0];
      const last = o.nodes[o.nodes.length - 1];
      for (let i = first; i <= last; i++) {
        cost += costs[i];
        const k = o.graph.nodes[i].kind;
        if (k === 'model_turn' || k === 'thinking') glue++;
      }
    }

    // Per-position argument templates + volatile slots → proposed params.
    const steps: SuggestionStep[] = [];
    const params: SuggestionParam[] = [];
    for (let p = 0; p < m.actions.length; p++) {
      const values = m.occ.map((o) => o.graph.nodes[o.nodes[p]].raw);
      const distinct = new Set(values).size;
      const tpl = columnTemplate(values);
      steps.push({
        position: p,
        action: m.actions[p],
        argTemplate: tpl ? tpl.template.slice(0, 160) : null,
        distinctArgs: distinct,
      });
      if (tpl) {
        for (let s = 0; s < tpl.slots; s++) {
          const slotVals = tpl.slotValues.map((sv) => sv?.[s]).filter((v): v is string => v != null);
          const examples = [...new Set(slotVals)].slice(0, 3);
          if (examples.length === 0) continue;
          // The same value list appearing at another position = the same parameter.
          const sig = examples.join('|');
          const existing = params.find((pp) => pp.examples.join('|') === sig);
          if (existing) existing.usedBy.push(p);
          else params.push({
            name: `p${params.length + 1}`,
            type: inferType(examples[0] ?? ''),
            usedBy: [p],
            examples,
          });
        }
      }
    }

    const intentCounts = new Map<string, number>();
    for (const o of m.occ) intentCounts.set(o.episode.intent, (intentCounts.get(o.episode.intent) ?? 0) + 1);

    return {
      id: H(`${graphs[0]?.agentId ?? ''}|${m.key}`),
      name: suggestionName(m.actions),
      actions: m.actions,
      steps,
      params: params.slice(0, 6),
      support: m.runs.size,
      runsTotal: graphs.length,
      occurrences: m.occ.length,
      confidence: Math.round(wilsonLower(m.runs.size, graphs.length) * 100) / 100,
      totalCostUsd: cost,
      avgCostPerOccurrenceUsd: cost / Math.max(1, m.occ.length),
      avgGlueSteps: Math.round((glue / Math.max(1, m.occ.length)) * 10) / 10,
      intents: [...intentCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k),
      exampleAsks: [...new Set(m.occ.map((o) => o.episode.ask).filter(Boolean))].slice(0, 3),
    };
  });

  // ---- family dedupe: one suggestion per set of specific verbs ------------------
  // read→edit variants of the same workflow at different lengths are the same
  // proposition to a human; keep the most expensive representative.
  const byVerbSet = new Map<string, ToolSuggestion>();
  for (const s of out.sort((a, b) => b.totalCostUsd - a.totalCostUsd)) {
    const sig = [...new Set(s.actions.filter(isSpecific))].sort().join('|');
    if (!byVerbSet.has(sig)) byVerbSet.set(sig, s);
  }

  return [...byVerbSet.values()]
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
    .slice(0, maxSuggestions);
}
