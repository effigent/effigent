/**
 * Episode segmentation — the comparable unit of agent work.
 *
 * Whole sessions never align (measured: pairwise similarity peaks ~0.53 on
 * real interactive traffic), because a session is a CONVERSATION: many tasks,
 * unique order. The task — user turn to next user turn — is where repetition
 * lives. An episode carries the user's ask, a deterministic intent class, the
 * action-token string of the work that followed, its cost, and its outcome.
 * Everything downstream (motif mining, tool suggestion, future episode
 * clustering) operates on episodes, not runs.
 */

import type { RunGraph } from './types.js';
import { actionToken } from './actions.js';
import { attributeStepCosts } from './segments.js';

export type EpisodeIntent =
  | 'implement' | 'fix' | 'explore' | 'review' | 'verify' | 'deliver' | 'operate' | 'other';

/** Deterministic keyword taxonomy over the user's ask. First match wins. */
const INTENT_RULES: Array<[EpisodeIntent, RegExp]> = [
  ['review', /\breview\b|look for (issues|bugs)|check .*\bpr\b/i],
  ['deliver', /create (a |the )?pr|open (a |the )?pr|pull request|commit and push|deploy/i],
  ['fix', /\bfix\b|\berror\b|\bbug\b|\bfail(s|ing|ed)?\b|broken|doesn'?t work|can'?t\b/i],
  ['verify', /\btest(s|ing)?\b|verify|make sure|confirm|run (the )?(tests|build)/i],
  ['implement', /\badd\b|implement|creat(e|ing)|build|new feature|support|change|modify|update/i],
  ['explore', /where|why|how|what|find|show me|look (at|into)|explain|check\b/i],
  ['operate', /deploy|prod\b|migration|pipeline|k8s|pod\b|restart|provision/i],
];

export function classifyIntent(ask: string): EpisodeIntent {
  for (const [intent, re] of INTENT_RULES) if (re.test(ask)) return intent;
  return 'other';
}

export interface Episode {
  runId: string;
  /** Ordinal within the run. */
  index: number;
  /** The user turn that opened the episode (trimmed). */
  ask: string;
  intent: EpisodeIntent;
  /** Node index range in the run graph [start, end). */
  start: number;
  end: number;
  /** Action tokens of the episode's tool_use steps, in order. */
  actions: string[];
  /** Graph node index of each entry in `actions` (same length). */
  actionNodes: number[];
  costUsd: number;
  toolCalls: number;
  errors: number;
  /** True when the user cut the episode off (interruption marker). */
  interrupted: boolean;
}

const INTERRUPT = /\[request interrupted by user/i;

/**
 * Split one run into episodes at user turns. Consecutive user turns (or an
 * interruption marker) fold into the next real episode's ask.
 */
export function segmentEpisodes(graph: RunGraph): Episode[] {
  const costs = attributeStepCosts(graph);
  const episodes: Episode[] = [];
  const isUser = (i: number) =>
    graph.nodes[i].kind === 'model_turn' && graph.nodes[i].structLabel.startsWith('llm:user');

  let start: number | null = null;
  let ask = '';
  const flush = (end: number) => {
    if (start === null || end <= start) return;
    const actions: string[] = [];
    const actionNodes: number[] = [];
    let cost = 0;
    let errors = 0;
    for (let i = start; i < end; i++) {
      const n = graph.nodes[i];
      cost += costs[i];
      if (n.kind === 'tool_use') {
        actions.push(actionToken(n));
        actionNodes.push(i);
      }
      if (n.kind === 'tool_result' && n.isError) errors++;
    }
    const trimmedAsk = ask.replace(/\s+/g, ' ').trim().slice(0, 300);
    episodes.push({
      runId: graph.runId,
      index: episodes.length,
      ask: trimmedAsk,
      intent: classifyIntent(trimmedAsk),
      start,
      end,
      actions,
      actionNodes,
      costUsd: cost,
      toolCalls: actions.length,
      errors,
      interrupted: INTERRUPT.test(ask),
    });
  };

  for (let i = 0; i < graph.nodes.length; i++) {
    if (!isUser(i)) continue;
    flush(i);
    start = i + 1;
    ask = graph.nodes[i].raw;
  }
  flush(graph.nodes.length);
  return episodes;
}
