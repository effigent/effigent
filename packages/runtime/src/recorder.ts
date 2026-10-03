import {
  addUsage,
  anthropicUsage,
  emptyUsage,
  usageCostUsd,
  type ApiMessage,
  type ContentBlock,
  type MessageParam,
  type RawStep,
  type RequestParams,
  type Run,
  type StepTokens,
  type TokenUsage,
} from '@effigent/core';

/**
 * Records one run of an API agent from the Anthropic Messages calls it makes, into
 * the SAME `Run` shape `parseTranscript` produces from a Claude Code session — so
 * every analyzer downstream (episodes, ledger, rent, determinism) reads it unchanged.
 *
 * Conventions mirrored from core/transcript.ts:
 *  - human text → `model_turn`/`user`; assistant text → `model_turn`/`assistant`;
 *    thinking → `thinking` with an empty payload; tool calls → `tool_use` (name =
 *    tool, payload = input JSON, toolUseId).
 *  - tool results arrive in the NEXT request's `messages`; they become `tool_result`
 *    steps (name = the tool that was called), never user turns — episodes.ts splits
 *    runs at user turns, so a misfiled result would cut every run into fragments.
 *  - a request's tokens attach to the FIRST step it emits, so per-step costs sum to
 *    the run cost.
 */

const PAYLOAD_CAP = 20_000;

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content
    .map((b: ContentBlock) => (b?.type === 'text' ? (b.text ?? '') : JSON.stringify(b)))
    .join('\n');
};

const capped = (text: string): Pick<RawStep, 'payload' | 'fullChars'> =>
  text.length > PAYLOAD_CAP ? { payload: text.slice(0, PAYLOAD_CAP), fullChars: text.length } : { payload: text };

export class Recorder {
  readonly runId: string;
  private readonly agentId: string;
  private readonly steps: RawStep[] = [];
  private readonly usageByModel: Record<string, TokenUsage> = {};
  private readonly models = new Set<string>();
  private readonly toolNameById = new Map<string, string>();
  private readonly resultsSeen = new Set<string>();
  /** How many request messages are already accounted for (agents resend history). */
  private consumed = 0;
  private startedAt?: string;
  private endedAt?: string;
  private firstPrompt?: string;
  private finalOutput?: string;

  constructor(runId: string, agentId: string) {
    this.runId = runId;
    this.agentId = agentId;
  }

  /** Nothing the model produced — the transcript parser drops the same case. */
  get empty(): boolean {
    return !this.steps.some((s) => s.kind !== 'model_turn' || s.name === 'assistant');
  }

  /** Before the model call: record the new user turns and tool results it carries. */
  onRequest(params: RequestParams): void {
    const now = new Date().toISOString();
    this.startedAt ??= now;
    this.endedAt = now;
    const messages = Array.isArray(params.messages) ? params.messages : [];
    // History shorter than what we've seen = the agent trimmed or restarted its
    // conversation: only the turns after its last assistant message are new.
    let from = this.consumed;
    if (messages.length < this.consumed) {
      from = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'assistant') { from = i + 1; break; }
      }
    }
    for (const m of messages.slice(from)) {
      if (m?.role === 'user') this.recordUserMessage(m, now);
    }
    this.consumed = messages.length;
  }

  private recordUserMessage(m: MessageParam, timestamp: string): void {
    if (typeof m.content === 'string') {
      if (m.content.trim()) this.userTurn(m.content, timestamp);
      return;
    }
    for (const b of m.content ?? []) {
      if (b?.type === 'text' && b.text?.trim()) this.userTurn(b.text, timestamp);
      else if (b?.type === 'tool_result') this.toolResult(b, timestamp);
    }
  }

  private userTurn(text: string, timestamp: string): void {
    this.firstPrompt ??= text;
    this.steps.push({ kind: 'model_turn', name: 'user', ...capped(text), timestamp });
  }

  private toolResult(b: ContentBlock, timestamp: string): void {
    // Dedupe by id: a trimmed-history agent may resend a result we already have.
    if (b.tool_use_id) {
      if (this.resultsSeen.has(b.tool_use_id)) return;
      this.resultsSeen.add(b.tool_use_id);
    }
    const name = (b.tool_use_id && this.toolNameById.get(b.tool_use_id)) || 'unknown';
    this.steps.push({
      kind: 'tool_result',
      name,
      ...capped(textOf(b.content)),
      isError: b.is_error === true,
      toolUseId: b.tool_use_id,
      timestamp,
    });
  }

  /** After the model call: the assistant's blocks, with the request's usage on the first. */
  onResponse(msg: ApiMessage, durationMs: number): void {
    const timestamp = new Date().toISOString();
    this.endedAt = timestamp;
    const model = msg.model;
    let tokens: StepTokens | undefined;
    if (model && msg.usage) {
      this.models.add(model);
      const u = anthropicUsage(msg.usage);
      this.usageByModel[model] = addUsage(this.usageByModel[model] ?? emptyUsage(), u);
      tokens = {
        input: u.inputTokens,
        output: u.outputTokens,
        cacheCreation: u.cacheCreationInputTokens,
        cacheCreation1h: u.cacheCreation1hInputTokens,
        cacheRead: u.cacheReadInputTokens,
        context: u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens,
      };
    }
    let first = true;
    const push = (step: RawStep) => {
      this.steps.push(first ? { ...step, model, tokens, durationMs } : { ...step, model });
      first = false;
    };
    for (const b of msg.content ?? []) {
      if (b?.type === 'text' && b.text?.trim()) {
        this.finalOutput = b.text;
        push({ kind: 'model_turn', name: 'assistant', ...capped(b.text), timestamp });
      } else if (b?.type === 'thinking' || b?.type === 'redacted_thinking') {
        push({ kind: 'thinking', name: 'assistant', payload: '', timestamp });
      } else if ((b?.type === 'tool_use' || b?.type === 'server_tool_use') && b.name) {
        if (b.id) this.toolNameById.set(b.id, b.name);
        push({ kind: 'tool_use', name: b.name, payload: JSON.stringify(b.input ?? {}), toolUseId: b.id, timestamp });
      } else if (b?.type?.endsWith('_tool_result') && b.tool_use_id) {
        // Server tools (web search, code execution) return their result in the same message.
        this.toolResult(b, timestamp);
      }
    }
    // A billed request with no recordable block still has to carry its tokens.
    if (first && tokens) push({ kind: 'model_turn', name: 'assistant', payload: '', timestamp });
  }

  toRun(): Run {
    let costUsd = 0;
    for (const [model, usage] of Object.entries(this.usageByModel)) costUsd += usageCostUsd(model, usage);
    return {
      runId: this.runId,
      agentId: this.agentId,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      models: [...this.models],
      usageByModel: this.usageByModel,
      costUsd,
      steps: this.steps,
      firstPrompt: this.firstPrompt,
      finalOutput: this.finalOutput,
    };
  }
}
