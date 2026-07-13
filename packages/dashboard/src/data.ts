/**
 * Demo dataset — mirrors the product mock so the SPA renders fully standalone
 * (e.g. on S3/CloudFront before login). Live values (cost, agent inventory)
 * come from the effigent API in `api.ts`; the rest are Phase 2/3 signals shown
 * here as the target design. Swap fields for API data as engines land.
 */

export type NodeKind = 'neutral' | 'llm' | 'search' | 'tool' | 'kg';
export interface FlowNode { label: string; sub?: string; kind?: NodeKind }
export interface Flow { name: string; optimized?: boolean; metrics: string[]; levels: FlowNode[][] }

export interface Kpi {
  key: string; label: string; icon: string; tint: string;
  kind: 'pct' | 'usd' | 'int'; value: number;
  delta: string; dir: 'up' | 'down'; tone: 'good' | 'bad' | 'neutral';
  spark: number[];
}

/** Sentinel for the "all agents" filter option. */
export const ALL_AGENTS = '__all__';

/** Demo agents shown in the filter when not signed in (live mode pulls the real list). */
export const demoAgents = ['billing-assistant', 'repo-explorer', 'support-triage', 'ci-fixer', 'docs-writer'];

// [label, icon, routeKey]. Empty routeKey = placeholder (not yet wired).
export const nav = [
  { group: 'Observability', items: [
    ['Home', 'home', 'overview'],
    ['Sessions', 'list', 'sessions'],
  ] },
  { group: 'Optimization', items: [
    ['Insights', 'bulb', 'insights'],
    ['Tool Synthesis', 'wrench', 'tools'],
  ] },
  { group: 'Knowledge', items: [
    ['Knowledge Graph', 'graph', 'kg'],
  ] },
  { group: 'Workspace', items: [
    ['Privacy', 'shield', 'privacy'],
  ] },
] as const;

export const kpis: Kpi[] = [
  { key: 'token', label: 'Token Reduction', icon: 'layers', tint: 'var(--purple)', kind: 'pct', value: 62.4,
    delta: '1.3M tokens', dir: 'down', tone: 'good', spark: [8, 6, 9, 7, 11, 9, 13, 10, 14, 12] },
  { key: 'latency', label: 'Latency Reduction', icon: 'gauge', tint: 'var(--blue)', kind: 'pct', value: 48.7,
    delta: '2.4 min', dir: 'down', tone: 'good', spark: [5, 7, 6, 9, 8, 11, 9, 12, 10, 13] },
  { key: 'cost', label: 'Cost Savings', icon: 'dollar', tint: 'var(--green)', kind: 'usd', value: 18732,
    delta: '62.1%', dir: 'down', tone: 'good', spark: [6, 8, 7, 10, 9, 8, 12, 11, 14, 13] },
  { key: 'det', label: 'Deterministic Ops', icon: 'scale', tint: 'var(--purple)', kind: 'int', value: 1243,
    delta: '245', dir: 'up', tone: 'good', spark: [4, 6, 5, 8, 7, 9, 8, 11, 10, 12] },
  { key: 'ctx', label: 'Context Reduction', icon: 'grid', tint: 'var(--cyan)', kind: 'pct', value: 68.9,
    delta: '2.1M tokens', dir: 'down', tone: 'good', spark: [9, 7, 10, 8, 11, 9, 12, 10, 13, 11] },
];

/** Deterministic per-agent factor so the agent filter visibly rescopes the (demo) metrics. */
export function agentFactor(agent: string): number {
  if (!agent || agent === ALL_AGENTS) return 1;
  let h = 0;
  for (let i = 0; i < agent.length; i++) h = (h * 31 + agent.charCodeAt(i)) >>> 0;
  return 0.18 + (h % 42) / 100; // 0.18 .. 0.59
}

export function formatKpi(kind: Kpi['kind'], value: number): string {
  if (kind === 'pct') return `${value.toFixed(1)}%`;
  if (kind === 'usd') return `$${Math.round(value).toLocaleString('en-US')}`;
  return Math.round(value).toLocaleString('en-US');
}

/** Build a flow with the User Request / Response endpoints added automatically. */
function mkFlow(name: string, optimized: boolean, metrics: string[], mid: FlowNode[][]): Flow {
  return { name, optimized, metrics, levels: [[{ label: 'User Request' }], ...mid, [{ label: 'Response' }]] };
}
const tool = (label: string): FlowNode => ({ label, sub: '(Synthesized Tool)', kind: 'tool' });

interface FlowPair { original: Flow; optimized: Flow }

/** Per-agent execution graphs (demo/seed) — grounded in each seed agent's real
 *  tool set so the Overview graph fills out and reacts to the agent filter. */
export const flowsByAgent: Record<string, FlowPair> = {
  'invoice-reconciliation': {
    original: mkFlow('Original Execution', false, ['24 steps', '12.4s', '164K tokens', '$2.10'], [
      [{ label: 'Planner (Claude-Sonnet-4)', kind: 'llm' }],
      [{ label: 'read_file', kind: 'search' }, { label: 'validate_schema', kind: 'search' }, { label: 'LLM Call', kind: 'llm' }],
      [{ label: 'tax_rate', kind: 'llm' }, { label: 'fx_convert', kind: 'llm' }, { label: 'LLM Call', kind: 'llm' }, { label: 'LLM Call', kind: 'llm' }],
      [{ label: 'LLM Call', kind: 'llm' }, { label: 'LLM Call', kind: 'llm' }],
    ]),
    optimized: mkFlow('Optimized Execution', true, ['9 steps', '3.0s', '41K tokens', '$0.36'], [
      [{ label: 'Knowledge Graph Lookup', kind: 'kg' }],
      [tool('reconcileBatch()'), tool('taxRate()'), tool('fxConvert()')],
      [{ label: 'Small Model (Claude-Haiku-4)' }],
    ]),
  },
  'repo-explorer': {
    original: mkFlow('Original Execution', false, ['28 steps', '14.2s', '189K tokens', '$2.31'], [
      [{ label: 'Planner (Claude-Sonnet-4)', kind: 'llm' }],
      [{ label: 'grep', kind: 'search' }, { label: 'read_file', kind: 'search' }, { label: 'LLM Call', kind: 'llm' }, { label: 'read_file', kind: 'search' }],
      [{ label: 'LLM Call', kind: 'llm' }, { label: 'find_refs', kind: 'search' }, { label: 'LLM Call', kind: 'llm' }],
      [{ label: 'LLM Call', kind: 'llm' }],
    ]),
    optimized: mkFlow('Optimized Execution', true, ['9 steps', '3.1s', '45K tokens', '$0.42'], [
      [{ label: 'Knowledge Graph Lookup', kind: 'kg' }],
      [tool('extractImports()'), tool('findRefs()'), tool('analyzeDeps()')],
      [{ label: 'Small Model (GPT-4o-mini)' }],
    ]),
  },
  'support-triage': {
    original: mkFlow('Original Execution', false, ['19 steps', '9.1s', '120K tokens', '$1.42'], [
      [{ label: 'Planner (Claude-Sonnet-4)', kind: 'llm' }],
      [{ label: 'fetch_ticket', kind: 'search' }, { label: 'LLM Call', kind: 'llm' }],
      [{ label: 'classify_tier', kind: 'llm' }, { label: 'search_kb', kind: 'search' }, { label: 'LLM Call', kind: 'llm' }],
      [{ label: 'LLM Call', kind: 'llm' }],
    ]),
    optimized: mkFlow('Optimized Execution', true, ['7 steps', '2.4s', '33K tokens', '$0.31'], [
      [tool('classifyTier()'), { label: 'KB Cache', kind: 'kg' }],
      [{ label: 'Small Model (GPT-4o)' }],
    ]),
  },
  'ci-fixer': {
    original: mkFlow('Original Execution', false, ['17 steps', '21.0s', '98K tokens', '$1.18'], [
      [{ label: 'Planner (Claude-Sonnet-4)', kind: 'llm' }],
      [{ label: 'read_logs', kind: 'search' }, { label: 'LLM Call', kind: 'llm' }],
      [{ label: 'run_tests', kind: 'search' }, { label: 'LLM Call', kind: 'llm' }, { label: 'LLM Call', kind: 'llm' }],
      [{ label: 'apply_patch', kind: 'tool' }],
    ]),
    optimized: mkFlow('Optimized Execution', true, ['11 steps', '8.4s', '52K tokens', '$0.61'], [
      [{ label: 'Planner (Claude-Sonnet-4)', kind: 'llm' }],
      [tool('selectTests()'), { label: 'read_logs', kind: 'search' }],
      [{ label: 'run_tests', kind: 'search' }],
      [tool('proposePatch()')],
    ]),
  },
  'docs-writer': {
    original: mkFlow('Original Execution', false, ['14 steps', '11.2s', '142K tokens', '$1.05'], [
      [{ label: 'Planner (GPT-4o)', kind: 'llm' }],
      [{ label: 'fetch_spec', kind: 'search' }, { label: 'LLM Call', kind: 'llm' }],
      [{ label: 'search_examples', kind: 'search' }, { label: 'LLM Call', kind: 'llm' }, { label: 'LLM Call', kind: 'llm' }],
      [{ label: 'LLM Call', kind: 'llm' }],
    ]),
    optimized: mkFlow('Optimized Execution', true, ['8 steps', '4.6s', '61K tokens', '$0.34'], [
      [{ label: 'Knowledge Graph Lookup', kind: 'kg' }],
      [tool('docTemplate()'), { label: 'search_examples', kind: 'search' }],
      [{ label: 'Small Model (GPT-4o-mini)' }],
    ]),
  },
  'data-pipeline': {
    original: mkFlow('Original Execution', false, ['12 steps', '48.0s', '54K tokens', '$0.72'], [
      [{ label: 'Planner (Claude-Sonnet-4)', kind: 'llm' }],
      [{ label: 'read_schema', kind: 'search' }, { label: 'LLM Call', kind: 'llm' }],
      [{ label: 'transform', kind: 'tool' }, { label: 'LLM Call', kind: 'llm' }],
      [{ label: 'load', kind: 'tool' }, { label: 'verify', kind: 'llm' }],
    ]),
    optimized: mkFlow('Optimized Execution', true, ['6 steps', '39.0s', '8K tokens', '$0.11'], [
      [tool('transformDeterministic()')],
      [{ label: 'load', kind: 'tool' }, tool('verifyCounts()')],
    ]),
  },
};

const defaultFlows: FlowPair = flowsByAgent['repo-explorer'];

/** Flows for the selected agent; a representative pair for "all agents". */
export function flowsForAgent(agent: string): FlowPair {
  if (agent && agent !== ALL_AGENTS && flowsByAgent[agent]) return flowsByAgent[agent];
  return defaultFlows;
}

export const graphLegend = [
  { label: 'LLM Call', color: 'var(--red)' },
  { label: 'Tool Call', color: 'var(--green)' },
  { label: 'Search', color: 'var(--blue)' },
  { label: 'Deterministic', color: 'var(--green)' },
  { label: 'Cache', color: 'var(--cyan)' },
  { label: 'Optimized', color: 'var(--node-neutral-br)' },
];

export const topOptimizations = [
  { icon: 'wrench', tint: 'var(--purple)', t: 'Tool Synthesis', s: '12 new tools generated', v: '↓ 45.2s' },
  { icon: 'layers', tint: 'var(--gold)', t: 'File Selection', s: 'Reduced context by 71%', v: '↓ 892K tokens' },
  { icon: 'route', tint: 'var(--blue)', t: 'Model Routing', s: 'Routed 342 calls to cheaper models', v: '↓ $3,812' },
  { icon: 'database', tint: 'var(--green)', t: 'Caching', s: 'Generated 156 new caches', v: '↓ 1.2M tokens' },
  { icon: 'search', tint: 'var(--cyan)', t: 'Grep Optimization', s: 'Converted 89 searches', v: '↓ 23.1s' },
];

export const recentTools = [
  { icon: 'cpu', tint: 'var(--blue)', name: 'extractImports()', s: 'TypeScript AST parser', v: 'Used 243x' },
  { icon: 'box', tint: 'var(--purple)', name: 'findReactComponents()', s: 'AST + pattern matching', v: 'Used 198x' },
  { icon: 'layers', tint: 'var(--gold)', name: 'analyzeDependencies()', s: 'Dependency analyzer', v: 'Used 156x' },
  { icon: 'route', tint: 'var(--green)', name: 'findApiRoutes()', s: 'Route pattern extractor', v: 'Used 132x' },
];

export const confidence = {
  pct: 87,
  segments: [{ value: 60, color: 'var(--green)' }, { value: 27, color: 'var(--gold)' }, { value: 13, color: 'var(--red)' }],
  legend: [
    { l: 'High (90-100)', color: 'var(--green)', v: '652 (60%)' },
    { l: 'Medium (70-90)', color: 'var(--gold)', v: '289 (27%)' },
    { l: 'Low (<70)', color: 'var(--red)', v: '142 (13%)' },
  ],
};

export const learning = {
  count: '247', unit: 'Executions',
  segments: [{ value: 40, color: 'var(--accent)' }, { value: 38, color: 'var(--blue)' }, { value: 22, color: 'var(--accent-2)' }],
  phases: [
    { l: 'Observation Phase', state: 'done' as const },
    { l: 'Learning Phase', state: 'done' as const },
    { l: 'Optimization Phase', state: 'active' as const },
  ],
  foot: 'Next review in 23 executions',
};

export const kgCoverage = {
  pct: 78,
  rows: [
    { l: 'Services', color: 'var(--green)', v: '124' },
    { l: 'APIs', color: 'var(--blue)', v: '342' },
    { l: 'Files', color: 'var(--purple)', v: '8,732' },
    { l: 'Functions', color: 'var(--gold)', v: '24,892' },
    { l: 'Dependencies', color: 'var(--cyan)', v: '19,234' },
  ],
  foot: 'Last updated: 2 min ago',
};

/** Install guide — how to put Effigent on any autonomous agent. Grounded in the
 *  real collector: register a scoped key, then pick the capture method.
 *
 *  Endpoints are computed at RUNTIME from a distribution we control:
 *  NEXT_PUBLIC_COLLECTOR_URL when set, else the dashboard's own origin
 *  (window.location.origin — the Vercel URL today, the real domain later).
 *  Never a hardcoded third-party domain. */
export function collectorBase(): string {
  if (process.env.NEXT_PUBLIC_COLLECTOR_URL) return process.env.NEXT_PUBLIC_COLLECTOR_URL;
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}

export interface InstallMethod {
  key: string; name: string; icon: string; tint: string; tag: string; blurb: string;
  steps: { label: string; code: string }[];
}

/** Hosted collector — matches the CLI's built-in default, so we only surface
 *  --server when a self-hosted collector actually differs from it. */
const DEFAULT_SERVER = 'https://collector.effigent.ai';

/** Step 1 — with the user's real key interpolated once they mint one. */
export function installStep1(base: string, tenantKey?: string) {
  const serverFlag = base && base !== DEFAULT_SERVER ? ` --server ${base}` : '';
  return {
    label: 'Log in with your workspace key, then register the agent',
    code: `npm i -g effigent
effigent login${serverFlag} --key ${tenantKey ?? '<workspace-key>'}
effigent agent add my-agent            # → prints a scoped capture key`,
  };
}

export function installMethods(base: string): InstallMethod[] {
  const COLLECTOR = base || '<dashboard-url>';
  const TRACES = `${COLLECTOR}/v1/traces`;
  return [
  {
    key: 'claude', name: 'Claude Code', icon: 'spark', tint: 'var(--purple)', tag: 'Hook · zero-touch',
    blurb: 'Event-driven capture — every finished session uploads automatically. No polling, no code changes, key stays local.',
    steps: [{ label: 'Install the SessionEnd hook', code: `effigent install claude --agent my-agent
# writes a SessionEnd hook into ~/.claude/settings.json (key stays in ~/.effigent)` }],
  },
  {
    key: 'codex', name: 'OpenAI Codex', icon: 'cpu', tint: 'var(--blue)', tag: 'OTel native',
    blurb: 'Codex emits native OpenTelemetry — point it at the collector with your scoped key. `effigent install codex` prints this with the key filled in.',
    steps: [{ label: 'Export before launching Codex', code: `export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${TRACES}
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_COMPRESSION=none
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <scoped-key>"` }],
  },
  {
    key: 'python', name: 'Python agents', icon: 'box', tint: 'var(--green)', tag: 'SDK · LangGraph · CrewAI · AutoGen',
    blurb: 'Auto-instrument any Python agent framework with OpenLLMetry — one init() call, no per-call changes.',
    steps: [
      { label: 'Install', code: `pip install traceloop-sdk` },
      { label: 'Initialize at startup', code: `from traceloop.sdk import Traceloop

Traceloop.init(
    api_endpoint="${TRACES}",
    headers={"Authorization": "Bearer <scoped-key>"},
)` },
    ],
  },
  {
    key: 'node', name: 'Node / TS agents', icon: 'box', tint: 'var(--gold)', tag: 'SDK · OpenAI Agents',
    blurb: 'Same OTel path for Node — instrument the openai / anthropic clients automatically.',
    steps: [
      { label: 'Install', code: `npm i @traceloop/node-server-sdk` },
      { label: 'Initialize before your agent runs', code: `import * as traceloop from "@traceloop/node-server-sdk";

traceloop.initialize({
  baseUrl: "${TRACES}",
  headers: { Authorization: "Bearer <scoped-key>" },
});` },
    ],
  },
  {
    key: 'proxy', name: 'Proxy / Sidecar', icon: 'route', tint: 'var(--cyan)', tag: 'Fallback · local gateway',
    blurb: 'For harnesses you can neither hook nor instrument: run the local capturing gateway and point your model client at it. It forwards to the real provider (your key passes through untouched) and mirrors each call to Effigent.',
    steps: [{ label: 'Run the gateway, then point your client at it', code: `effigent proxy --agent my-agent
# → listening on http://localhost:4319  →  https://api.openai.com
export OPENAI_BASE_URL=http://localhost:4319/v1  # your provider key still authenticates upstream` }],
  },
  ];
}

/**
 * "Let the agent install itself" — a ready-to-paste prompt that a coding agent
 * (Claude Code, Codex, Cursor, …) runs on its own machine to install Effigent.
 * Tailored per harness: Claude Code is a genuine one-shot self-install via the
 * SessionEnd hook; OTel harnesses can only arm capture for their NEXT launch
 * (instrumentation happens at process start, not mid-run) — the prompts say so
 * honestly. Pre-filled with the collector URL and the workspace key when the
 * user has minted one.
 */
export function agentInstallPrompt(methodKey: string, base: string, tenantKey?: string): string {
  const COLLECTOR = base || '<dashboard-url>';
  const KEY = tenantKey ?? '<workspace-key>';
  const A = 'my-agent';

  const head = `You have shell access to the machine you run on. Install Effigent on yourself — a passive layer that captures this agent's runs so they can be analyzed for cost and turned into optimizations. It does NOT change how you answer and adds no latency to your responses. Work non-interactively and stop on the first error.

Common setup:
1. npm i -g effigent
2. effigent login${base && base !== DEFAULT_SERVER ? ` --server ${COLLECTOR}` : ''} --key ${KEY}
3. effigent agent add ${A}`;

  const tail: Record<string, string> = {
    claude: `4. effigent install claude --agent ${A}   (writes a SessionEnd hook into ~/.claude/settings.json; the key stays in ~/.effigent)
5. Verify: effigent doctor

From your next finished session onward, every run uploads automatically. Paste the output of \`effigent doctor\` back to me. If any step fails, show the exact error and do not retry destructively.`,
    codex: `4. effigent install codex --agent ${A}   (writes a scoped [otel] block into ~/.codex/config.toml — Codex reads OTel config only from there; NEVER add global OTEL_* env vars to a shell profile)
5. Fully restart Codex so it loads the new config — OpenTelemetry initializes at launch, not mid-run.

Report the path the installer wrote and confirm Codex restarted cleanly. Capture begins on your next run.`,
    python: `4. pip install traceloop-sdk   (then run \`effigent install python --agent ${A}\` to get your scoped key)
5. At startup, before any model call, add:
   from traceloop.sdk import Traceloop
   Traceloop.init(api_endpoint="${COLLECTOR}", headers={"Authorization": "Bearer <scoped-key>"})

Tell me which file you edited. Capture begins on your next run.`,
    node: `4. npm i @traceloop/node-server-sdk   (then run \`effigent install node --agent ${A}\` to get your scoped key)
5. Before your agent runs, add:
   import * as traceloop from "@traceloop/node-server-sdk";
   traceloop.initialize({ baseUrl: "${COLLECTOR}", headers: { Authorization: "Bearer <scoped-key>" } });

Tell me which file you edited. Capture begins on your next run.`,
    proxy: `4. effigent proxy --agent ${A}   (starts a local OpenAI-compatible gateway that forwards to the real upstream and mirrors each call to Effigent)
5. Point your model client at it: export OPENAI_BASE_URL=http://localhost:4319/v1  (your existing provider key still authenticates upstream)

Confirm the proxy is listening and the base URL is set. Only calls that flow through the proxy are captured.`,
  };

  return `${head}\n${tail[methodKey] ?? tail.claude}`;
}

export const routing = {
  rows: [
    { l: 'GPT-4o', pct: 23, color: 'var(--purple)', delta: '↓ 35%', tone: 'bad' as const },
    { l: 'Claude-3.5', pct: 31, color: 'var(--accent)', delta: '↓ 18%', tone: 'bad' as const },
    { l: 'GPT-4o-mini', pct: 28, color: 'var(--blue)', delta: '↑ 42%', tone: 'good' as const },
    { l: 'Claude-3-haiku', pct: 12, color: '#4aa8ff', delta: '↑ 8%', tone: 'good' as const },
    { l: 'Custom/Other', pct: 6, color: 'var(--cyan)', delta: '→ 0%', tone: 'neutral' as const },
  ],
  foot: '42% of calls routed to smaller models',
};
