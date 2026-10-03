import type { TokenUsage } from './types.js';

/**
 * The Anthropic Messages wire format, the parts Effigent reads: usage → TokenUsage
 * and a streaming accumulator (SSE events in, the final message out). Pure — shared
 * by the runtime SDK (wrapped client) and the CLI's Claude Code gateway, which both
 * see raw Messages traffic rather than a transcript.
 */

export interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}
export interface MessageParam {
  role?: string;
  content?: string | ContentBlock[];
}
export interface RequestParams {
  model?: string;
  messages?: MessageParam[];
  stream?: boolean;
}
export interface ApiUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
}
export interface ApiMessage {
  model?: string;
  content?: ContentBlock[];
  usage?: ApiUsage;
}

/** Same mapping as transcript.ts (incl. the 1h cache-write split). */
export function anthropicUsage(u: ApiUsage | undefined): TokenUsage {
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

/** Streaming events in, the final message out — enough to record usage and blocks. */
export class StreamAccumulator {
  private message: ApiMessage | undefined;
  private readonly blocks: ContentBlock[] = [];
  private readonly partialJson = new Map<number, string>();

  add(ev: { type?: string; index?: number; message?: ApiMessage; content_block?: ContentBlock; delta?: Record<string, unknown>; usage?: ApiUsage }): void {
    switch (ev.type) {
      case 'message_start':
        this.message = { model: ev.message?.model, usage: { ...ev.message?.usage } };
        break;
      case 'content_block_start':
        if (ev.index != null && ev.content_block) this.blocks[ev.index] = { ...ev.content_block };
        break;
      case 'content_block_delta': {
        const block = ev.index != null ? this.blocks[ev.index] : undefined;
        const d = ev.delta ?? {};
        if (!block) break;
        if (d.type === 'text_delta') block.text = (block.text ?? '') + String(d.text ?? '');
        else if (d.type === 'input_json_delta') {
          this.partialJson.set(ev.index!, (this.partialJson.get(ev.index!) ?? '') + String(d.partial_json ?? ''));
        }
        break;
      }
      case 'message_delta':
        // Usage on message_delta is cumulative; later non-null fields win.
        if (this.message && ev.usage) {
          for (const [k, v] of Object.entries(ev.usage)) {
            if (v != null) (this.message.usage as Record<string, unknown>)[k] = v;
          }
        }
        break;
    }
  }

  /** Null when the stream ended before `message_start` (nothing was billed to record). */
  result(): ApiMessage | null {
    if (!this.message) return null;
    for (const [i, json] of this.partialJson) {
      const block = this.blocks[i];
      if (!block) continue;
      try {
        block.input = JSON.parse(json);
      } catch {
        block.input = json; // cut-off stream: keep the raw fragment
      }
    }
    return { ...this.message, content: this.blocks.filter(Boolean) };
  }
}
