/**
 * Ingestion — parse Claude Code session transcripts (~/.claude/projects/**\/*.jsonl)
 * into Runs. This is the zero-install capture path: Claude Code already writes a
 * complete JSONL transcript per session, including per-message token usage.
 */

import { createHash } from 'node:crypto';
import type { RawStep, Run, RunEvent, StepTokens, TokenUsage } from './types.js';
import { addUsage, emptyUsage, usageCostUsd } from './cost.js';

interface TranscriptLine {
  type?: string;
  uuid?: string;
  requestId?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  /** Claude Code: the compaction summary injected as a user message. */
  isCompactSummary?: boolean;
  /** Claude Code: who produced a user turn — typed | queued | system | sdk. */
  promptSource?: string;
  /** Claude Code: human | task-notification | peer | auto-continuation | … */
  origin?: { kind?: string };
  subtype?: string;
  agentId?: string;
  toolDenialKind?: string;
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number };
  toolUseResult?: {
    gitOperation?: {
      commit?: { sha?: string };
      push?: { branch?: string };
      pr?: { number?: number; action?: string };
    };
  };
  costUSD?: number;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens_details?: { thinking_tokens?: number };
      cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
      /** Per-sampling iterations; `advisor_message` entries are a SECOND model's
       *  usage (the advisor tool) that the top-level totals do not include. */
      iterations?: Array<{
        type?: string;
        model?: string;
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation?: { ephemeral_1h_input_tokens?: number };
      }>;
    };
  };
}

/**
 * Harness-injected user content that is not a real prompt. Measured on 2,400
 * real user turns: `!`-prefixed shell echoes (`<bash-input>`/`<bash-stdout>`)
 * alone were ~15% of all "asks", and every one of them opened a bogus episode.
 */
const META_PREFIXES = [
  '<command-name>', '<command-message>', '<command-args>', '<local-command-stdout>',
  '<local-command-stderr>', '<local-command-caveat>', '<system-reminder>',
  '<task-notification>', '<bash-input>', '<bash-stdout>', '<bash-stderr>',
  '<user-memory-input>', 'Caveat:',
];

function isMetaText(text: string): boolean {
  const t = text.trimStart();
  return META_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * A user line is a real ask only when a human (or an SDK caller) wrote it.
 * Claude Code marks provenance explicitly on newer transcripts; older ones fall
 * back to the text heuristics in `isMetaText`.
 */
function isHarnessTurn(obj: TranscriptLine): boolean {
  if (obj.isCompactSummary) return true;
  if (obj.origin?.kind && obj.origin.kind !== 'human') return true;
  return obj.promptSource === 'system';
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
      .join('\n');
  }
  return '';
}

function toUsage(u: NonNullable<TranscriptLine['message']>['usage']): TokenUsage {
  const usage: TokenUsage = {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheCreationInputTokens: u?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: u?.cache_read_input_tokens ?? 0,
  };
  const h = u?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  if (h > 0) usage.cacheCreation1hInputTokens = h;
  return usage;
}

export interface ParseOptions {
  /** Override the agentId (e.g. from a `effigent run --agent` tag). */
  agentId?: string;
  /** Fallback agent id when cwd is missing. */
  defaultAgentId?: string;
}

/**
 * Parse one session transcript (JSONL text) into a Run, or null when the session
 * contains no assistant activity (empty/aborted sessions carry no signal).
 */
export function parseTranscript(
  jsonl: string,
  options: ParseOptions = {},
): Run | null {
  const steps: RawStep[] = [];
  const toolNameById = new Map<string, string>();
  const usageByModel: Record<string, TokenUsage> = {};
  const seenUsageKeys = new Set<string>();
  const models = new Set<string>();
  const instructions = new Map<string, { path: string; kind: string; chars: number }>();
  let title: string | undefined;
  let customTitle: string | undefined;
  const events: RunEvent[] = [];
  let sideRequests = 0;
  let sideUsd = 0;
  const sideAgents = new Set<string>();

  let sessionId: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let firstPrompt: string | undefined;
  let finalOutput: string | undefined;
  let legacyCostUsd = 0;
  let hasUsage = false;

  for (const rawLine of jsonl.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: TranscriptLine;
    try {
      obj = JSON.parse(line) as TranscriptLine;
    } catch {
      continue; // tolerate truncated/corrupt lines — capture must never fail hard
    }
    sessionId ??= obj.sessionId;
    if (obj.type === 'system' && obj.subtype === 'compact_boundary' && !obj.isSidechain) {
      events.push({ kind: 'compact', timestamp: obj.timestamp, detail: obj.compactMetadata?.trigger, preTokens: obj.compactMetadata?.preTokens, postTokens: obj.compactMetadata?.postTokens });
      continue;
    }
    // Subagent (sidechain) turns: not part of the main conversation, but real spend.
    if (obj.isSidechain && obj.type === 'assistant' && obj.message?.usage && obj.message.model && obj.message.model !== '<synthetic>') {
      const key = `side:${obj.requestId ?? obj.uuid ?? obj.timestamp}`;
      if (!seenUsageKeys.has(key)) {
        seenUsageKeys.add(key);
        const u = toUsage(obj.message.usage);
        usageByModel[obj.message.model] = addUsage(usageByModel[obj.message.model] ?? emptyUsage(), u);
        models.add(obj.message.model);
        hasUsage = true;
        sideRequests++;
        sideUsd += usageCostUsd(obj.message.model, u);
        if (obj.agentId) sideAgents.add(obj.agentId);
      }
      continue;
    }
    if (obj.type === 'ai-title' || obj.type === 'custom-title') {
      // the user's own title wins; otherwise the LATEST ai-title (it is rewritten as the session evolves)
      const o = obj as { aiTitle?: string; customTitle?: string };
      if (obj.type === 'custom-title' && o.customTitle) customTitle = o.customTitle;
      else if (o.aiTitle) title = o.aiTitle;
      continue;
    }
    if (obj.type === 'attachment' && !obj.isSidechain) {
      const a = (obj as { attachment?: { type?: string; files?: { path?: string; type?: string; content?: string }[] } }).attachment;
      if (a?.type === 'instructions') {
        for (const f of a.files ?? []) {
          if (!f.path) continue;
          instructions.set(f.path, { path: f.path, kind: f.type ?? 'unknown', chars: (f.content ?? '').length });
        }
      }
      continue;
    }
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    if (obj.isMeta || obj.isSidechain) continue;

    cwd ??= obj.cwd;
    gitBranch ??= obj.gitBranch;
    if (obj.timestamp) {
      startedAt ??= obj.timestamp;
      endedAt = obj.timestamp;
    }

    const msg = obj.message;
    if (!msg) continue;

    if (obj.type === 'user') {
      const git = obj.toolUseResult?.gitOperation;
      if (git?.commit) events.push({ kind: 'commit', timestamp: obj.timestamp, detail: git.commit.sha?.slice(0, 10) });
      if (git?.push) events.push({ kind: 'push', timestamp: obj.timestamp });
      if (git?.pr) events.push({ kind: 'pr', timestamp: obj.timestamp, detail: `${git.pr.action ?? ''}${git.pr.number != null ? ` #${git.pr.number}` : ''}`.trim() });
      if (obj.toolDenialKind) events.push({ kind: 'deny', timestamp: obj.timestamp, detail: obj.toolDenialKind });
      const content = msg.content;
      const harness = isHarnessTurn(obj);
      if (typeof content === 'string') {
        if (content.trim() && !harness && !isMetaText(content)) {
          firstPrompt ??= content;
          steps.push({ kind: 'model_turn', name: 'user', payload: content, timestamp: obj.timestamp });
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as {
            type?: string;
            text?: string;
            tool_use_id?: string;
            content?: unknown;
            is_error?: boolean;
          };
          if (b.type === 'text' && b.text?.trim() && !harness && !isMetaText(b.text)) {
            firstPrompt ??= b.text;
            steps.push({ kind: 'model_turn', name: 'user', payload: b.text, timestamp: obj.timestamp });
          } else if (b.type === 'tool_result') {
            const toolName = (b.tool_use_id && toolNameById.get(b.tool_use_id)) || 'unknown';
            const text = textOfContent(b.content);
            steps.push({
              kind: 'tool_result',
              name: toolName,
              payload: text.slice(0, 20000),
              ...(text.length > 20000 ? { fullChars: text.length } : {}),
              isError: b.is_error === true,
              toolUseId: b.tool_use_id,
              timestamp: obj.timestamp,
            });
          }
        }
      }
    } else {
      // assistant
      if (typeof obj.costUSD === 'number') legacyCostUsd += obj.costUSD;
      if (msg.model && msg.model !== '<synthetic>') models.add(msg.model);
      // Usage repeats across lines of the same API request — dedupe, and
      // attribute the request's tokens to the FIRST step it emits so per-step
      // costs sum to the run cost (a tool call's cost lands on the tool_use
      // that the model turn issued — exactly where the optimizer charges it).
      let tokensToAttach: StepTokens | undefined;
      // `<synthetic>` messages are harness-generated (API errors, interrupts) —
      // never billed.
      if (msg.usage && msg.model && msg.model !== '<synthetic>') {
        const key = obj.requestId ?? obj.uuid ?? `${obj.timestamp}`;
        if (!seenUsageKeys.has(key)) {
          seenUsageKeys.add(key);
          hasUsage = true;
          const u = toUsage(msg.usage);
          usageByModel[msg.model] = addUsage(usageByModel[msg.model] ?? emptyUsage(), u);
          // Advisor-tool calls run another model inside this request and bill
          // separately (measured: ~$27 on one $500 session, invisible before).
          for (const it of msg.usage.iterations ?? []) {
            if (it.type !== 'advisor_message' || !it.model) continue;
            const au = toUsage(it);
            usageByModel[it.model] = addUsage(usageByModel[it.model] ?? emptyUsage(), au);
            models.add(it.model);
          }
          tokensToAttach = {
            input: u.inputTokens,
            output: u.outputTokens,
            cacheCreation: u.cacheCreationInputTokens,
            cacheCreation1h: u.cacheCreation1hInputTokens,
            cacheRead: u.cacheReadInputTokens,
          };
          const thinking = msg.usage.output_tokens_details?.thinking_tokens ?? 0;
          if (thinking > 0) tokensToAttach.thinking = thinking;
          const iters = (msg.usage.iterations ?? []).filter((it) => it.type === 'message');
          const last = iters[iters.length - 1];
          tokensToAttach.context = last
            ? (last.input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0)
            : u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;
        }
      }
      const pushAssistantStep = (step: RawStep) => {
        steps.push({ ...step, model: msg.model, tokens: tokensToAttach });
        tokensToAttach = undefined;
      };
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; text?: string; name?: string; id?: string; input?: unknown };
          if (b.type === 'text' && b.text?.trim()) {
            finalOutput = b.text;
            pushAssistantStep({ kind: 'model_turn', name: 'assistant', payload: b.text, timestamp: obj.timestamp });
          } else if (b.type === 'thinking') {
            pushAssistantStep({ kind: 'thinking', name: 'assistant', payload: '', timestamp: obj.timestamp });
          } else if (b.type === 'tool_use' && b.name) {
            if (b.id) toolNameById.set(b.id, b.name);
            pushAssistantStep({
              kind: 'tool_use',
              name: b.name,
              payload: JSON.stringify(b.input ?? {}),
              toolUseId: b.id,
              timestamp: obj.timestamp,
            });
          }
        }
      }
    }
  }

  const hasAssistant = steps.some((s) => s.kind !== 'model_turn' || s.name === 'assistant');
  if (!hasAssistant) return null;

  let costUsd = 0;
  if (hasUsage) {
    for (const [model, usage] of Object.entries(usageByModel)) {
      costUsd += usageCostUsd(model, usage);
    }
  } else {
    costUsd = legacyCostUsd;
  }

  const runId =
    sessionId ?? createHash('sha256').update(jsonl.slice(0, 4096)).digest('hex').slice(0, 16);
  const agentId =
    options.agentId ??
    (cwd ? cwd.split('/').filter(Boolean).slice(-1)[0] : undefined) ??
    options.defaultAgentId ??
    'unknown-agent';

  return {
    runId,
    agentId,
    cwd,
    gitBranch,
    startedAt,
    endedAt,
    models: [...models],
    usageByModel,
    costUsd,
    steps,
    firstPrompt,
    finalOutput,
    ...(instructions.size ? { instructions: [...instructions.values()] } : {}),
    ...((customTitle ?? title) ? { title: (customTitle ?? title)!.slice(0, 120) } : {}),
    ...(events.length ? { events } : {}),
    ...(sideRequests ? { subagents: { count: sideAgents.size || 1, requests: sideRequests, costUsd: sideUsd } } : {}),
  };
}
