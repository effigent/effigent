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
  /** OTLP structured body / nested value (log records carry event fields here). */
  kvlistValue?: { values?: KeyValue[] };
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
      str(f.attrs, 'gen_ai.conversation.id', 'session.id', 'gen_ai.session.id', 'conversation.id') ??
      str(f.resourceAttrs, 'gen_ai.conversation.id', 'session.id', 'gen_ai.session.id', 'conversation.id') ??
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
      const durationMs =
        start > 0 && end > 0 ? Math.max(0, Math.round((end - start) / 1e6)) : undefined;

      if (toolName || op === 'execute_tool') {
        const name = toolName ?? 'tool';
        // Argument attrs vary by instrumentation: OTel GenAI semconv, then
        // OpenLLMetry (traceloop.entity.input), then OpenInference (input.value).
        const args =
          str(
            attrs,
            'gen_ai.tool.call.arguments',
            'gen_ai.tool.arguments',
            'traceloop.entity.input',
            'input.value',
          ) ?? '{}';
        const toolUseId = str(attrs, 'gen_ai.tool.call.id');
        steps.push({
          kind: 'tool_use',
          name,
          payload: args,
          toolUseId,
          timestamp: ts,
          durationMs,
        });
        if (span.status?.code === 2) {
          steps.push({
            kind: 'tool_result',
            name,
            payload: span.status.message ?? '',
            isError: true,
            toolUseId,
            timestamp: nanoToIso(span.endTimeUnixNano),
          });
        } else {
          // Successful tool OUTPUT, when the instrumentation captures it —
          // this is what memoize/provenance/replay feed on downstream.
          const output = str(
            attrs,
            'gen_ai.tool.call.result',
            'traceloop.entity.output',
            'output.value',
          );
          if (output !== undefined) {
            steps.push({
              kind: 'tool_result',
              name,
              payload: output,
              toolUseId,
              timestamp: nanoToIso(span.endTimeUnixNano),
            });
          }
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
        steps.push({
          kind: 'model_turn',
          name: 'assistant',
          payload: completion ?? '',
          timestamp: ts,
          model,
          durationMs,
          tokens: {
            input: usage.inputTokens,
            output: usage.outputTokens,
            cacheCreation: usage.cacheCreationInputTokens,
            cacheRead: usage.cacheReadInputTokens,
          },
        });
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

// ---- OTLP/HTTP JSON logs shapes ----
//
// The THIRD ingestion shape: OTLP log records. OpenAI Codex configures OTel only
// via ~/.codex/config.toml (it ignores OTEL_* env vars) and — unlike the trace
// exporter, which carries structure — emits its token usage as structured LOG
// EVENTS (`codex.sse_event`, `codex.api_request`, `codex.tool_result`, …), keyed
// by `conversation.id`. We fold those into the SAME `Run` contract as traces.
//
// NOTE: the codex.* event/attribute names below follow OpenAI's Codex OTel docs
// (2026). Attribute *keys* (e.g. token fields) should be reconciled against a
// real captured payload — see the spike in the plan. Lookups are aliased so we
// degrade gracefully if a key differs.

export interface OtelLogRecord {
  timeUnixNano?: string | number;
  observedTimeUnixNano?: string | number;
  eventName?: string;
  severityText?: string;
  body?: AnyValue;
  attributes?: KeyValue[];
  traceId?: string;
  spanId?: string;
}
export interface ScopeLogs {
  scope?: { name?: string };
  logRecords?: OtelLogRecord[];
}
export interface ResourceLogs {
  resource?: { attributes?: KeyValue[] };
  scopeLogs?: ScopeLogs[];
}
export interface OtlpLogsPayload {
  resourceLogs?: ResourceLogs[];
}

/** Record attributes plus any fields carried in a structured (kvlist) body. */
function readLogAttrs(rec: OtelLogRecord): Attrs {
  const m = readAttrs(rec.attributes);
  const bodyKv = rec.body?.kvlistValue?.values;
  if (bodyKv) for (const [k, v] of readAttrs(bodyKv)) if (!m.has(k)) m.set(k, v);
  return m;
}

/**
 * Group OTLP log records into runs and normalize each to the `Run` contract.
 * Cost is accumulated once, from the token-bearing streaming events; API-request
 * events supply the call structure. Groups with no assistant/tool activity are
 * dropped (mirrors otelToRuns / parseTranscript).
 */
export function otelLogsToRuns(payload: OtlpLogsPayload, opts: OtelToRunOptions = {}): Run[] {
  interface FlatLog {
    rec: OtelLogRecord;
    attrs: Attrs;
    resourceAttrs: Attrs;
  }
  const flat: FlatLog[] = [];
  for (const rl of payload.resourceLogs ?? []) {
    const resourceAttrs = readAttrs(rl.resource?.attributes);
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        flat.push({ rec, attrs: readLogAttrs(rec), resourceAttrs });
      }
    }
  }
  if (flat.length === 0) return [];

  const groups = new Map<string, FlatLog[]>();
  for (const f of flat) {
    const key =
      str(f.attrs, 'conversation.id', 'gen_ai.conversation.id', 'session.id') ??
      str(f.resourceAttrs, 'conversation.id', 'gen_ai.conversation.id', 'session.id') ??
      f.rec.traceId ??
      'codex-unknown';
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }

  const runs: Run[] = [];
  for (const [key, records] of groups) {
    records.sort((a, b) => Number(a.rec.timeUnixNano ?? 0) - Number(b.rec.timeUnixNano ?? 0));

    const steps: RawStep[] = [];
    const usageByModel: Record<string, TokenUsage> = {};
    const models = new Set<string>();
    let agentId: string | undefined;
    let firstPrompt: string | undefined;
    let runModel: string | undefined;
    let minStart: number | undefined;
    let maxEnd: number | undefined;

    for (const { rec, attrs, resourceAttrs } of records) {
      agentId ??=
        opts.agentId ?? str(resourceAttrs, 'service.name', 'gen_ai.agent.name') ?? str(attrs, 'service.name');
      const t = Number(rec.timeUnixNano ?? rec.observedTimeUnixNano ?? 0);
      if (t > 0) {
        minStart = minStart === undefined ? t : Math.min(minStart, t);
        maxEnd = maxEnd === undefined ? t : Math.max(maxEnd, t);
      }
      const ts = nanoToIso(rec.timeUnixNano ?? rec.observedTimeUnixNano);
      const event = rec.eventName ?? str(attrs, 'event.name') ?? '';
      const model =
        str(attrs, 'model', 'gen_ai.request.model', 'gen_ai.response.model') ?? str(resourceAttrs, 'model');
      if (model) runModel ??= model;

      if (event.includes('tool')) {
        const name = str(attrs, 'tool.name', 'tool_name', 'gen_ai.tool.name', 'name') ?? 'tool';
        if (event.includes('result')) {
          const isError = attrs.get('success') === false || str(attrs, 'status') === 'error';
          steps.push({
            kind: 'tool_result',
            name,
            payload: str(attrs, 'output', 'result', 'output.snippet') ?? '',
            isError: isError || undefined,
            timestamp: ts,
            durationMs: num(attrs, 'duration_ms', 'duration') || undefined,
          });
        } else {
          // tool_decision / tool_call → the invocation
          steps.push({
            kind: 'tool_use',
            name,
            payload: str(attrs, 'arguments', 'tool.arguments', 'input') ?? '{}',
            timestamp: ts,
          });
        }
      } else if (event.includes('user_prompt')) {
        firstPrompt ??=
          str(attrs, 'prompt', 'content') ?? `<prompt ${num(attrs, 'length', 'prompt.length', 'character_count')} chars>`;
      } else if (event.includes('sse_event')) {
        // Token-bearing streaming event: the source of truth for cost.
        const usage = normalizeGenAiUsage(str(attrs, 'gen_ai.provider.name', 'gen_ai.system') ?? 'openai', attrs);
        const merged: TokenUsage = {
          inputTokens: usage.inputTokens || num(attrs, 'input_tokens', 'tokens.input', 'input'),
          outputTokens: usage.outputTokens || num(attrs, 'output_tokens', 'tokens.output', 'output'),
          cacheReadInputTokens:
            usage.cacheReadInputTokens || num(attrs, 'cached_tokens', 'tokens.cached', 'cached', 'reasoning_tokens'),
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
        };
        if (merged.inputTokens || merged.outputTokens || merged.cacheReadInputTokens) {
          const m = model ?? runModel ?? 'unknown';
          models.add(m);
          usageByModel[m] = addUsage(usageByModel[m] ?? emptyUsage(), merged);
        }
      } else if (event.includes('api_request')) {
        // The model call boundary → one assistant turn (structure; cost is summed
        // from sse_event above so we don't double-count).
        const m = model ?? runModel ?? 'unknown';
        steps.push({
          kind: 'model_turn',
          name: 'assistant',
          payload: '',
          timestamp: ts,
          model: m,
          durationMs: num(attrs, 'duration_ms', 'duration') || undefined,
        });
      }
      // conversation_starts / websocket_* → metadata only.
    }

    // Ensure a run with token usage always has at least one assistant turn.
    const hasTurn = steps.some((s) => s.kind === 'model_turn' && s.name === 'assistant');
    if (!hasTurn && Object.keys(usageByModel).length > 0) {
      steps.push({ kind: 'model_turn', name: 'assistant', payload: '', timestamp: nanoToIso(maxEnd), model: runModel ?? 'unknown' });
    }

    const hasActivity = steps.some((s) => s.kind === 'tool_use' || (s.kind === 'model_turn' && s.name === 'assistant'));
    if (!hasActivity) continue;

    const costUsd = Object.entries(usageByModel).reduce((sum, [m, u]) => sum + usageCostUsd(m, u), 0);

    runs.push({
      runId: `codex:${key}`,
      agentId: agentId ?? opts.defaultAgentId ?? 'unknown-agent',
      startedAt: nanoToIso(minStart),
      endedAt: nanoToIso(maxEnd),
      models: [...models],
      usageByModel,
      costUsd,
      steps,
      firstPrompt,
    });
  }

  return runs;
}
