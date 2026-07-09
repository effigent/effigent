/**
 * OpenTelemetry GenAI → Run normalizer.
 *
 * The Universal Collector's second ingestion shape: OTLP/HTTP JSON traces from
 * OpenLLMetry-instrumented agents (any framework — LangGraph, CrewAI, custom
 * SDK apps). We flatten the span tree, group spans into logical runs, and emit
 * the SAME `Run` model that `parseTranscript` produces, so the graph/cluster
 * engine downstream is untouched.
 *
 * Contract we must satisfy (see transcript.ts): ordered `steps`, tool inputs as
 * JSON strings, `usageByModel` keyed by a model string, `costUsd` via
 * `usageCostUsd`, an `agentId`, and — critically — at least one assistant
 * `model_turn` or a `tool_use` step, or the group is dropped (mirrors
 * `parseTranscript` returning null for a run with no assistant activity).
 */

import type { RawStep, Run, TokenUsage } from './types.js';
import { addUsage, emptyUsage, usageCostUsd } from './cost.js';

// ---- OTLP/HTTP JSON shapes (subset we read) ----

export interface AnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}
export interface KeyValue {
  key: string;
  value?: AnyValue;
}
export interface OtelSpan {
  traceId?: string;
  spanId?: string;
  name?: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: KeyValue[];
  status?: { code?: number; message?: string };
}
export interface ScopeSpans {
  scope?: { name?: string };
  spans?: OtelSpan[];
}
export interface ResourceSpans {
  resource?: { attributes?: KeyValue[] };
  scopeSpans?: ScopeSpans[];
}
export interface OtlpTracesPayload {
  resourceSpans?: ResourceSpans[];
}

export interface OtelToRunOptions {
  /** Force the agentId (e.g. from a scoped agent key). Overrides span/resource attrs. */
  agentId?: string;
  /** Fallback when no agent identity can be resolved. */
  defaultAgentId?: string;
}

type Attrs = Map<string, string | number | boolean>;

function readAttrs(list: KeyValue[] | undefined): Attrs {
  const m: Attrs = new Map();
  for (const kv of list ?? []) {
    const v = kv?.value;
    if (!kv?.key || !v) continue;
    if (v.stringValue !== undefined) m.set(kv.key, v.stringValue);
    else if (v.intValue !== undefined) m.set(kv.key, Number(v.intValue));
    else if (v.doubleValue !== undefined) m.set(kv.key, v.doubleValue);
    else if (v.boolValue !== undefined) m.set(kv.key, v.boolValue);
  }
  return m;
}

function str(a: Attrs, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = a.get(k);
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function num(a: Attrs, ...keys: string[]): number {
  for (const k of keys) {
    const v = a.get(k);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return 0;
}

/** nanoseconds (string/number) → ISO timestamp, or undefined. */
function nanoToIso(n: string | number | undefined): string | undefined {
  if (n === undefined) return undefined;
  const ms = Number(BigInt(typeof n === 'number' ? Math.round(n) : n) / 1_000_000n);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

/**
 * Provider-aware token normalization to Anthropic-style *uncached-remainder*
 * TokenUsage (the shape cost.ts + the rest of the engine assume).
 *
 * Anthropic: input_tokens already EXCLUDES cache — map 1:1.
 * OpenAI/Azure: prompt/input tokens INCLUDE cached — subtract to avoid
 *   double-counting, and there is no cache-write token concept.
 * Unknown: default to the additive (Anthropic) interpretation.
 */
export function normalizeGenAiUsage(provider: string | undefined, a: Attrs): TokenUsage {
  const inputRaw = num(a, 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'llm.usage.prompt_tokens');
  const output = num(a, 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'llm.usage.completion_tokens');
  const cacheRead = num(
    a,
    'gen_ai.usage.cache_read_input_tokens',
    'gen_ai.usage.cached_input_tokens',
    'gen_ai.usage.cached_tokens',
  );
  const cacheCreation = num(a, 'gen_ai.usage.cache_creation_input_tokens');

  const p = (provider ?? '').toLowerCase();
  const inclusive = p.includes('openai') || p.includes('azure');
  if (inclusive) {
    return {
      inputTokens: Math.max(0, inputRaw - cacheRead),
      outputTokens: output,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: 0,
    };
  }
  return {
    inputTokens: inputRaw,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
  };
}

interface FlatSpan {
  span: OtelSpan;
  attrs: Attrs;
  resourceAttrs: Attrs;
}

/** True when a span represents an LLM generation call. */
function isLlmSpan(op: string | undefined, a: Attrs): boolean {
  if (op && ['chat', 'text_completion', 'generate_content', 'completion'].includes(op)) return true;
  // Fall back to the presence of model/usage signals.
  return (
    str(a, 'gen_ai.response.model', 'gen_ai.request.model') !== undefined ||
    num(a, 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens') > 0
  );
}

/**
 * Group GenAI spans into runs and normalize each to the `Run` contract.
 * Groups with no assistant/tool activity are dropped.
 */
export function otelToRuns(payload: OtlpTracesPayload, opts: OtelToRunOptions = {}): Run[] {
  const flat: FlatSpan[] = [];
  for (const rs of payload.resourceSpans ?? []) {
    const resourceAttrs = readAttrs(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        flat.push({ span, attrs: readAttrs(span.attributes), resourceAttrs });
      }
    }
  }
  if (flat.length === 0) return [];

  // Group by logical session/run key.
  const groups = new Map<string, FlatSpan[]>();
  for (const f of flat) {
    const key =
      str(f.attrs, 'gen_ai.conversation.id', 'session.id', 'gen_ai.session.id') ??
      str(f.resourceAttrs, 'gen_ai.conversation.id', 'session.id', 'gen_ai.session.id') ??
      f.span.traceId ??
      'otel-unknown';
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }

  const runs: Run[] = [];
  for (const [key, spans] of groups) {
    spans.sort((x, y) => Number(x.span.startTimeUnixNano ?? 0) - Number(y.span.startTimeUnixNano ?? 0));

    const steps: RawStep[] = [];
    const usageByModel: Record<string, TokenUsage> = {};
    const models = new Set<string>();
    let agentId: string | undefined;
    let firstPrompt: string | undefined;
    let finalOutput: string | undefined;
    let minStart: number | undefined;
    let maxEnd: number | undefined;

    for (const { span, attrs, resourceAttrs } of spans) {
      agentId ??=
        opts.agentId ?? str(resourceAttrs, 'gen_ai.agent.name', 'service.name') ?? str(attrs, 'gen_ai.agent.name');

      const start = Number(span.startTimeUnixNano ?? 0);
      const end = Number(span.endTimeUnixNano ?? 0);
      if (start > 0) minStart = minStart === undefined ? start : Math.min(minStart, start);
      if (end > 0) maxEnd = maxEnd === undefined ? end : Math.max(maxEnd, end);

      const op = str(attrs, 'gen_ai.operation.name');
      const ts = nanoToIso(span.startTimeUnixNano);
      const toolName = str(attrs, 'gen_ai.tool.name');

      if (toolName || op === 'execute_tool') {
        const name = toolName ?? 'tool';
        const args = str(attrs, 'gen_ai.tool.call.arguments', 'gen_ai.tool.arguments') ?? '{}';
        steps.push({
          kind: 'tool_use',
          name,
          payload: args,
          toolUseId: str(attrs, 'gen_ai.tool.call.id'),
          timestamp: ts,
        });
        if (span.status?.code === 2) {
          steps.push({
            kind: 'tool_result',
            name,
            payload: span.status.message ?? '',
            isError: true,
            timestamp: nanoToIso(span.endTimeUnixNano),
          });
        }
      } else if (isLlmSpan(op, attrs)) {
        const provider = str(attrs, 'gen_ai.provider.name', 'gen_ai.system');
        const model = str(attrs, 'gen_ai.response.model', 'gen_ai.request.model') ?? 'unknown';
        models.add(model);
        const usage = normalizeGenAiUsage(provider, attrs);
        usageByModel[model] = addUsage(usageByModel[model] ?? emptyUsage(), usage);

        const prompt = str(attrs, 'gen_ai.prompt', 'gen_ai.prompt.0.content', 'gen_ai.input.messages');
        const completion = str(attrs, 'gen_ai.completion', 'gen_ai.completion.0.content', 'gen_ai.output.messages');
        firstPrompt ??= prompt;
        if (completion) finalOutput = completion;
        steps.push({ kind: 'model_turn', name: 'assistant', payload: completion ?? '', timestamp: ts });
      }
      // Spans that are neither tool nor LLM (workflow/task wrappers) contribute
      // timing/identity only — no step.
    }

    // Mirror parseTranscript's null rule: drop groups with no assistant/tool activity.
    const hasActivity = steps.some((s) => s.kind === 'tool_use' || (s.kind === 'model_turn' && s.name === 'assistant'));
    if (!hasActivity) continue;

    const hasUsage = Object.keys(usageByModel).length > 0;
    const costUsd = hasUsage
      ? Object.entries(usageByModel).reduce((sum, [m, u]) => sum + usageCostUsd(m, u), 0)
      : 0;

    runs.push({
      runId: `otel:${key}`,
      agentId: agentId ?? opts.defaultAgentId ?? 'unknown-agent',
      startedAt: nanoToIso(minStart),
      endedAt: nanoToIso(maxEnd),
      models: [...models],
      usageByModel,
      costUsd,
      steps,
      firstPrompt,
      finalOutput,
    });
  }

  return runs;
}
