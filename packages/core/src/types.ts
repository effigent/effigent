/**
 * Core domain types for ccopt — spec §3 (graph engine).
 */

export type StepKind = 'model_turn' | 'tool_use' | 'tool_result' | 'thinking';

/** One step of a run, before canonicalization. */
export interface RawStep {
  kind: StepKind;
  /** Tool name for tool_use/tool_result; role for model turns. */
  name: string;
  /** Raw textual payload: tool input JSON, model text, result text. */
  payload: string;
  /** True when a tool_result carried is_error. */
  isError?: boolean;
  /** IDs linking tool_use ↔ tool_result. */
  toolUseId?: string;
  timestamp?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** A parsed run (one session / one headless invocation). */
export interface Run {
  runId: string;
  /** Logical agent identity — project dir by default, or explicit tag from `ccopt run`. */
  agentId: string;
  cwd?: string;
  gitBranch?: string;
  startedAt?: string;
  endedAt?: string;
  models: string[];
  usageByModel: Record<string, TokenUsage>;
  costUsd: number;
  steps: RawStep[];
  /** First user prompt (raw), for report context. */
  firstPrompt?: string;
  /** Final assistant text (raw), for output-consistency checks. */
  finalOutput?: string;
}

/** A node of the canonical run graph. */
export interface GraphNode {
  index: number;
  kind: StepKind;
  /** Canonical label: tool name + canonicalized input shape, or role + template. */
  label: string;
  /** Canonicalized full I/O value (participates in L0 only). */
  canonicalValue: string;
  isError: boolean;
  /** Raw payload retained for volatile-slot extraction & synthesis. */
  raw: string;
}

export interface GraphEdge {
  from: number;
  to: number;
  type: 'temporal' | 'dataflow';
}

export interface RunGraph {
  runId: string;
  agentId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** L0 — exact: structure + labels + canonical I/O. */
  l0: string;
  /** L1 — shape: structure + labels only. */
  l1: string;
  /** Canonical label sequence used for L1 and L2. */
  labelSequence: string[];
  costUsd: number;
  startedAt?: string;
  models: string[];
  usageByModel: Record<string, TokenUsage>;
  canonicalFinalOutput?: string;
  finalOutputTemplate?: string;
  canonicalFirstPrompt?: string;
  firstPrompt?: string;
}

/** Metrics for one L1 cluster within one agentId — spec §3.4. */
export interface ClusterMetrics {
  nRuns: number;
  totalCostUsd: number;
  costP50Usd: number;
  costP95Usd: number;
  firstSeen?: string;
  lastSeen?: string;
  determinismScore: number;
  failureRate: number;
  retrySubchains: number;
  modelMix: Record<string, number>;
  /** Label positions whose raw values vary across runs → parameters of a compiled script. */
  volatileSlots: VolatileSlot[];
  /** Count of L0-identical duplicate runs (beyond the first of each L0 group). */
  l0DuplicateRuns: number;
  l0DuplicateCostUsd: number;
  cacheReadRatio: number;
}

export interface VolatileSlot {
  nodeIndex: number;
  label: string;
  distinctValues: number;
  examples: string[];
}

export interface Cluster {
  clusterId: string;
  agentId: string;
  l1: string;
  /** L2 family this cluster belongs to. */
  familyId: string;
  labelSequence: string[];
  runIds: string[];
  runs: RunGraph[];
  metrics: ClusterMetrics;
}

export type FindingKind =
  | 'compile'
  | 'cache'
  | 'rightsize'
  | 'fix'
  | 'precompute'
  | 'align';

export interface Finding {
  kind: FindingKind;
  title: string;
  agentId: string;
  clusterIds: string[];
  estMonthlySavingUsd: number;
  /** 0..1 */
  confidence: number;
  /** 1 (trivial) .. 5 (project) */
  effort: number;
  /** estMonthlySavingUsd × confidence ÷ effort — ranking key. */
  score: number;
  recommendation: string;
  evidenceRunIds: string[];
  /** Canonical label sequence to render as the SVG chain. */
  labelSequence: string[];
  details: Record<string, unknown>;
}

export interface WasteReport {
  generatedAt: string;
  agentIds: string[];
  windowDays: number;
  totals: {
    runs: number;
    costUsd: number;
    estMonthlyCostUsd: number;
    clusteredRunRatio: number;
    cacheReadRatio: number;
  };
  findings: Finding[];
  clusters: ClusterSummary[];
  /** Repeated sub-sequences mined across runs — the fine-grained compile units. */
  segments?: unknown[];
}

export interface ClusterSummary {
  clusterId: string;
  agentId: string;
  familyId: string;
  nRuns: number;
  totalCostUsd: number;
  determinismScore: number;
  failureRate: number;
  labelSequence: string[];
  runIds: string[];
  modelMix: Record<string, number>;
}
