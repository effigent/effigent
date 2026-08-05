// VENDORED from packages/core/src/brief.ts — re-vendor after core changes (see CLAUDE.md §6)
/**
 * The run brief — a compact, deterministic digest of one run, built for two
 * consumers at once:
 *
 *  1. the SESSION STORYLINE view: episodes as chapters (ask → intent → actions
 *     → cost → errors), so a 1,000-step run reads as a handful of headings;
 *  2. the AI digest prompt: `renderBriefText` serializes the brief plus BOUNDED
 *     content excerpts into a few-thousand-token block an LLM can actually
 *     read — the episode/action IR is the compression, the LLM adds narration.
 *
 * Content policy: payloads reaching this module are already redacted at ingest
 * (the persistRun choke point), and every excerpt is length-capped here again.
 * What ships to a model is the redacted skeleton + excerpts, never raw runs.
 */

import type { Run, RunGraph } from './types.ts';
import { segmentEpisodes, type Episode } from './episodes.ts';

const ASK_CAP = 240;
const EXCERPT_CAP = 600;
const ERROR_CAP = 200;
const MAX_ERRORS = 4;
const MAX_ACTIONS_PER_EPISODE = 6;

export interface EpisodeBrief {
  index: number;
  ask: string;
  intent: Episode['intent'];
  /** Top action tokens with counts, e.g. "edit×9 read×4 pnpm:test×2". */
  actionSummary: string;
  toolCalls: number;
  costUsd: number;
  errors: number;
  interrupted: boolean;
}

export interface RunBrief {
  runId: string;
  agentId: string;
  startedAt?: string;
  costUsd: number;
  models: string[];
  steps: number;
  toolCalls: number;
  errorCount: number;
  interruptions: number;
  episodes: EpisodeBrief[];
  /** The session's opening ask. */
  opener: string;
  /** Tail of the final assistant message — usually the outcome statement. */
  closer: string;
  /** Error result previews, most expensive-looking first (first N). */
  errorPreviews: string[];
  /** URLs the assistant reported (PRs, pipelines, deployed pages…). */
  artifacts: string[];
}

const URL_RE = /https?:\/\/[^\s)"'\]]+/g;
/** Artifact-ish URLs: things the agent DELIVERED, not things it browsed. */
const ARTIFACT_RE = /\/(pull|pr|merge_requests|actions\/runs|releases|commit)\//;

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function summarizeActions(actions: string[]): string {
  const counts = new Map<string, number>();
  for (const a of actions) counts.set(a, (counts.get(a) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ACTIONS_PER_EPISODE)
    .map(([a, n]) => (n > 1 ? `${a}×${n}` : a))
    .join(' ');
}

export function buildRunBrief(run: Run, graph: RunGraph): RunBrief {
  const episodes = segmentEpisodes(graph);

  let closer = '';
  const artifacts = new Set<string>();
  for (const n of graph.nodes) {
    if (n.kind === 'model_turn' && n.structLabel.startsWith('llm:assistant') && n.raw.trim()) {
      closer = n.raw;
      for (const url of n.raw.match(URL_RE) ?? []) {
        if (ARTIFACT_RE.test(url)) artifacts.add(url.slice(0, 120));
      }
    }
  }

  const errorPreviews: string[] = [];
  let errorCount = 0;
  for (const n of graph.nodes) {
    if (n.kind === 'tool_result' && n.isError) {
      errorCount++;
      if (errorPreviews.length < MAX_ERRORS) errorPreviews.push(clip(n.raw, ERROR_CAP));
    }
  }

  return {
    runId: graph.runId,
    agentId: graph.agentId,
    startedAt: graph.startedAt,
    costUsd: graph.costUsd,
    models: graph.models,
    steps: graph.nodes.length,
    toolCalls: graph.nodes.filter((n) => n.kind === 'tool_use').length,
    errorCount,
    interruptions: episodes.filter((e) => e.interrupted).length,
    episodes: episodes.map((e) => ({
      index: e.index,
      ask: clip(e.ask, ASK_CAP),
      intent: e.intent,
      actionSummary: summarizeActions(e.actions),
      toolCalls: e.toolCalls,
      costUsd: e.costUsd,
      errors: e.errors,
      interrupted: e.interrupted,
    })),
    opener: clip(episodes[0]?.ask ?? '', EXCERPT_CAP),
    closer: clip(closer.slice(-EXCERPT_CAP * 2), EXCERPT_CAP),
    errorPreviews,
    artifacts: [...artifacts].slice(0, 5),
  };
}

/** Serialize a brief into the LLM-readable block (bounded, redacted upstream). */
export function renderBriefText(b: RunBrief): string {
  const lines: string[] = [
    `RUN ${b.runId} · agent ${b.agentId} · $${b.costUsd.toFixed(2)} · ${b.steps} steps · ${b.toolCalls} tool calls · ${b.errorCount} errors · models ${b.models.join(',') || 'n/a'}`,
    `OPENING ASK: ${b.opener || '(none)'}`,
    '',
    'EPISODES (user turn → work that followed):',
    ...b.episodes.map((e) =>
      `  [${e.index}] (${e.intent}${e.interrupted ? ', interrupted' : ''}) $${e.costUsd.toFixed(2)} ${e.toolCalls} calls${e.errors ? ` ${e.errors} errors` : ''} · ${e.actionSummary || 'no tools'}` +
      (e.ask ? `\n      ask: ${e.ask}` : ''),
    ),
    '',
  ];
  if (b.errorPreviews.length) {
    lines.push('ERRORS (first few):', ...b.errorPreviews.map((e) => `  - ${e}`), '');
  }
  if (b.artifacts.length) lines.push(`ARTIFACTS REPORTED: ${b.artifacts.join(' ')}`, '');
  if (b.closer) lines.push(`FINAL ASSISTANT MESSAGE (tail): ${b.closer}`);
  return lines.join('\n');
}
