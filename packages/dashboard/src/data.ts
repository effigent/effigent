/**
 * Demo dataset — mirrors the product mock so the SPA renders fully standalone
 * (e.g. on S3/CloudFront before login). Live values (cost, agent inventory)
 * come from the ccopt API in `api.ts`; the rest are Phase 2/3 signals shown
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
    ['Tool Synthesis', 'wrench', ''],
  ] },
  { group: 'Knowledge', items: [
    ['Knowledge Graph', 'graph', ''], ['Repository Map', 'map', ''],
  ] },
] as const;

export const kpis: Kpi[] = [
  { key: 'token', label: 'Token Reduction', icon: 'layers', tint: 'var(--purple)', kind: 'pct', value: 62.4,
    delta: '1.3M tokens', dir: 'down', tone: 'good', spark: [8, 6, 9, 7, 11, 9, 13, 10, 14, 12] },
  { key: 'latency', label: 'Latency Reduction', icon: 'gauge', tint: 'var(--blue)', kind: 'pct', value: 48.7,
    delta: '2.4 min', dir: 'down', tone: 'good', spark: [5, 7, 6, 9, 8, 11, 9, 12, 10, 13] },
  { key: 'cost', label: 'Cost Savings', icon: 'dollar', tint: 'var(--green)', kind: 'usd', value: 18732,
    delta: '62.1%', dir: 'down', tone: 'good', spark: [6, 8, 7, 10, 9, 8, 12, 11, 14, 13] },
  { key: 'cache', label: 'Cache Hit Rate', icon: 'database', tint: 'var(--gold)', kind: 'pct', value: 73.8,
    delta: '12.4%', dir: 'up', tone: 'good', spark: [7, 9, 8, 11, 10, 14, 12, 16, 13, 15] },
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

export const flowOriginal: Flow = {
  name: 'Original Execution',
  metrics: ['28 steps', '14.2s', '189K tokens', '$2.31'],
  levels: [
    [{ label: 'User Request' }],
    [{ label: 'Planner (Claude-3.5)' }],
    [{ label: 'File Search', kind: 'search' }, { label: 'LLM Call', kind: 'llm' }, { label: 'File Search', kind: 'search' }],
    [{ label: 'LLM Call', kind: 'llm' }, { label: 'File Search', kind: 'search' }, { label: 'LLM Call', kind: 'llm' },
     { label: 'File Search', kind: 'search' }, { label: 'LLM Call', kind: 'llm' }],
    [{ label: 'LLM Call', kind: 'llm' }, { label: 'LLM Call', kind: 'llm' }, { label: 'LLM Call', kind: 'llm' },
     { label: 'File Search', kind: 'search' }],
    [{ label: 'Response' }],
  ],
};

export const flowOptimized: Flow = {
  name: 'Optimized Execution',
  optimized: true,
  metrics: ['9 steps', '3.1s', '45K tokens', '$0.42'],
  levels: [
    [{ label: 'User Request' }],
    [{ label: 'Planner (Claude-3.5)' }],
    [{ label: 'Knowledge Graph Lookup', kind: 'kg' }],
    [{ label: 'extractImports()', sub: '(Synthesized Tool)', kind: 'tool' },
     { label: 'findRoutes()', sub: '(Synthesized Tool)', kind: 'tool' },
     { label: 'analyzeDeps()', sub: '(Synthesized Tool)', kind: 'tool' }],
    [{ label: 'Small Model (GPT-4o-mini)' }],
    [{ label: 'Response' }],
  ],
};

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

/** Install guide — how to put Optimizer on any autonomous agent. Grounded in the
 *  real collector: register a scoped key, then pick the capture method. */
export interface InstallMethod {
  key: string; name: string; icon: string; tint: string; tag: string; blurb: string;
  steps: { label: string; code: string }[];
}

export const installStep1 = {
  label: 'Register the agent — one scoped key per agent',
  code: `# install the CLI, then register (owner/tenant key from your workspace)
curl -fsSL https://optimizer.ai/install | sh
ccopt login --server https://app.optimizer.ai --key <tenant-key>
ccopt agent add my-agent            # → prints a scoped capture key`,
};

export const installMethods: InstallMethod[] = [
  {
    key: 'claude', name: 'Claude Code', icon: 'spark', tint: 'var(--purple)', tag: 'Hook · zero-touch',
    blurb: 'Event-driven capture — every finished session uploads automatically. No polling, no code changes, key stays local.',
    steps: [{ label: 'Install the SessionEnd hook', code: `ccopt install claude --agent my-agent
# writes a SessionEnd hook into ~/.claude/settings.json (key stays in ~/.ccopt)` }],
  },
  {
    key: 'codex', name: 'OpenAI Codex', icon: 'cpu', tint: 'var(--blue)', tag: 'OTel native',
    blurb: 'Codex emits native OpenTelemetry — point it at the collector with your scoped key.',
    steps: [{ label: 'Export before launching Codex', code: `export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://app.optimizer.ai/v1/traces
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
    api_endpoint="https://app.optimizer.ai/v1/traces",
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
  baseUrl: "https://app.optimizer.ai/v1/traces",
  headers: { Authorization: "Bearer <scoped-key>" },
});` },
    ],
  },
  {
    key: 'proxy', name: 'Proxy / Sidecar', icon: 'route', tint: 'var(--cyan)', tag: 'Fallback · roadmap',
    blurb: 'For closed harnesses you can neither instrument nor read: route the provider base URL through Optimizer. (Fallback path — on the roadmap.)',
    steps: [{ label: 'Point the provider base URL at Optimizer', code: `export ANTHROPIC_BASE_URL=https://app.optimizer.ai/proxy
export OPENAI_BASE_URL=https://app.optimizer.ai/proxy/v1
export OPTIMIZER_KEY=<scoped-key>` }],
  },
];

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
