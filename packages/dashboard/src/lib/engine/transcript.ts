// VENDORED from packages/core|server (dashboard can't take workspace deps on Vercel).
/**
 * Ingestion — parse Claude Code session transcripts (~/.claude/projects/**\/*.jsonl)
 * into Runs. This is the zero-install capture path: Claude Code already writes a
 * complete JSONL transcript per session, including per-message token usage.
 */

import { createHash } from 'node:crypto';
import type { RawStep, Run, StepTokens, TokenUsage } from './types.ts';
import { addUsage, emptyUsage, usageCostUsd } from './cost.ts';

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
    };
  };
}

/** Harness-injected user content that is not a real prompt. */
function isMetaText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<command-name>') ||
    t.startsWith('<command-message>') ||
    t.startsWith('<local-command-stdout>') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('<task-notification>') ||
    t.startsWith('Caveat:')
  );
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
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheCreationInputTokens: u?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: u?.cache_read_input_tokens ?? 0,
  };
}

export interface ParseOptions {
  /** Override the agentId (e.g. from a `ccopt run --agent` tag). */
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
      const content = msg.content;
      if (typeof content === 'string') {
        if (content.trim() && !isMetaText(content)) {
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
          if (b.type === 'text' && b.text?.trim() && !isMetaText(b.text)) {
            firstPrompt ??= b.text;
            steps.push({ kind: 'model_turn', name: 'user', payload: b.text, timestamp: obj.timestamp });
          } else if (b.type === 'tool_result') {
            const toolName = (b.tool_use_id && toolNameById.get(b.tool_use_id)) || 'unknown';
            steps.push({
              kind: 'tool_result',
              name: toolName,
              payload: textOfContent(b.content).slice(0, 20000),
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
      if (msg.model) models.add(msg.model);
      // Usage repeats across lines of the same API request — dedupe, and
      // attribute the request's tokens to the FIRST step it emits so per-step
      // costs sum to the run cost (a tool call's cost lands on the tool_use
      // that the model turn issued — exactly where the optimizer charges it).
      let tokensToAttach: StepTokens | undefined;
      if (msg.usage && msg.model) {
        const key = obj.requestId ?? obj.uuid ?? `${obj.timestamp}`;
        if (!seenUsageKeys.has(key)) {
          seenUsageKeys.add(key);
          hasUsage = true;
          const u = toUsage(msg.usage);
          usageByModel[msg.model] = addUsage(usageByModel[msg.model] ?? emptyUsage(), u);
          tokensToAttach = {
            input: u.inputTokens,
            output: u.outputTokens,
            cacheCreation: u.cacheCreationInputTokens,
            cacheRead: u.cacheReadInputTokens,
          };
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
  };
}
