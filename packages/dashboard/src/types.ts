/**
 * Console domain types. They deliberately speak effigentd's vocabulary
 * (internal/endpoint/policy, internal/endpoint/event, internal/shared/action)
 * so the demo dataset in `data.ts` can be swapped for the control-plane API
 * without touching the views.
 */

import type { CommandRisk } from './lib/command-risk.ts';

/** policy.Mode */
export type Mode = 'monitor' | 'learn' | 'denylist' | 'allowlist';

/** action.Class */
export type ActionClass = 'exec' | 'file_read' | 'file_write' | 'network' | 'mcp_call' | 'tool_call';

/** event.Type (+ `approval`, a control-plane event) */
export type EventType =
  | 'agent_start' | 'agent_exit' | 'exec' | 'exit' | 'file_open' | 'connect'
  | 'blocked' | 'would_block' | 'policy' | 'approval';

/** event.Event.Severity */
export type Severity = 'info' | 'medium' | 'high';

/** The subset of action.State the console shows as an approval's status. */
export type ApprovalState = 'approval_pending' | 'approved' | 'approval_denied' | 'expired' | 'cancelled';

/** How one action ended, as rendered by the status pills. */
export type Outcome = 'allowed' | 'blocked' | 'pending' | 'would_block' | 'system';

/** Agent names from policy/default.yaml `agents:`. */
export type AgentType = 'claude-code' | 'claude-cowork' | 'cursor-agent' | 'codex' | 'gemini-cli' | 'aider' | 'opencode' | 'goose';

export type Env = 'production' | 'staging' | 'development';

export type ConsoleRole = 'admin' | 'approver' | 'member' | 'viewer';

export interface User {
  id: string; // console handle, e.g. jane.doe
  name: string;
  title: string; // Developer, Product Manager, ...
  role: ConsoleRole;
  team: string;
  osUsers: string[]; // OS accounts mapped to this person (action.Context.os_user)
  isNew?: boolean;
  lastSeen: string;
  mfa: boolean;
}

export interface Endpoint {
  id: string; // action.Context.endpoint_id
  hostname: string;
  os: string;
  platform: 'linux' | 'macos';
  sensor: 'tetragon' | 'eslogger';
  env: Env;
  owner: string; // user id
  version: string; // effigentd
  status: 'online' | 'degraded' | 'offline';
  heartbeat: string;
  policyVersion: number;
}

export interface Agent {
  id: string;
  type: AgentType;
  user: string;
  endpoint: string;
  env: Env;
  status: 'active' | 'idle' | 'offline';
  mode: Mode;
  pid: number;
  sessions24h: number;
  actions24h: number;
  blocked24h: number;
  lastSeen: string;
  mcpServers: string[];
  isNew?: boolean;
}

/** action.Action (display subset). */
export interface Action {
  class: ActionClass;
  tool?: string;
  command?: string;
  binary?: string;
  paths?: string[];
  host?: string;
  port?: number;
  url?: string;
  mcpServer?: string;
  mcpTool?: string;
  cwd?: string;
}

export interface ConsoleEvent {
  id: string;
  at?: number; // epoch ms (control-plane events; demo rows only have pre-rendered strings)
  time: string; // HH:MM
  ago: string;
  type: EventType;
  severity: Severity;
  outcome: Outcome;
  title: string;
  /** effigentd agent name; usually an AgentType, but a tenant's policy can define more (e.g. hermes). */
  agentType: string | null;
  user: string | null;
  endpoint: string | null;
  endpointName?: string; // hostname, when the event came from the control plane
  /** Environments are a demo concept; control-plane events carry none. */
  env: Env | null;
  summary: string; // e.g. "exec: curl"
  target?: string;
  rule?: string; // policy rule that matched
  via?: string; // nearest MCP server, e.g. mcp:github
  mode?: Mode;
  /** Commands only: routine / normal / risky (lib/command-risk.ts). */
  risk?: CommandRisk;
  /** Risky commands: the list entry that matched ("curl", "git push", "sudo"). */
  riskRule?: string;
}

export interface Approval {
  id: string;
  title: string;
  action: Action;
  agentType: AgentType;
  user: string;
  endpoint: string;
  env: Env;
  sessionId: string;
  fingerprint: string; // action.Fingerprint — approval binds to it (FR-32)
  policyId: string;
  ruleId: string;
  reason: string;
  risk: 'low' | 'medium' | 'high';
  requestedAgo: string;
  expiresIn: string;
  state: ApprovalState;
  decidedBy?: string;
  decidedAgo?: string;
  note?: string;
  /** two-person approval and tickets (Demo Mode) */
  approvalsRequired?: number;
  requireTicket?: boolean;
  votes?: { by: string; decision: 'approve' | 'deny'; ticket?: string; ago: string; note?: string }[];
}

export type RuleEffect = 'allow' | 'deny' | 'require_approval' | 'alert';

export interface PolicyRule {
  id: string;
  class: ActionClass;
  match: string;
  effect: RuleEffect;
  description: string;
  hits24h: number;
}

export interface Policy {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'draft' | 'disabled';
  mode: Mode;
  priority: number;
  scope: { envs: Env[]; agentTypes: AgentType[]; users: string[] };
  rules: PolicyRule[];
  version: number;
  updatedAgo: string;
  updatedBy: string;
  endpoints: number;
}

export type ListKind = 'exec' | 'file' | 'network' | 'mcp';

export interface ListEntry {
  id: string;
  list: 'allow' | 'deny';
  kind: ListKind;
  value: string;
  scope: string;
  note: string;
  addedBy: string;
  addedAgo: string;
  hits24h: number;
}

/** A node the agent graph can draw. */
export interface Resource {
  id: string;
  label: string;
  sub: string;
  icon: string;
}

/** One observed edge: who → what, with the outcome the policy produced. */
export interface Flow {
  id: string;
  agentType: AgentType;
  from: string; // user id, agent type, or resource id
  to: string;
  label: string;
  outcome: 'allowed' | 'blocked' | 'flow' | 'pending';
  count24h: number;
  lastSeen: string;
}
