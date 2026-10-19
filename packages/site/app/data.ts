/** Landing-page content + computed geometry. Vocabulary follows effigentd
 *  (internal/endpoint/policy, internal/shared/action, internal/shared/policy). */

export interface Scheme { bg: string; border: string; text: string; dot: string }
export const SCHEMES: Record<string, Scheme> = {
  purple: { bg: 'oklch(0.97 0.02 290)', border: 'oklch(0.85 0.06 290)', text: 'oklch(0.42 0.12 290)', dot: 'oklch(0.55 0.16 290)' },
  blue: { bg: 'oklch(0.97 0.02 250)', border: 'oklch(0.85 0.05 250)', text: 'oklch(0.42 0.12 250)', dot: 'oklch(0.55 0.15 250)' },
  green: { bg: 'oklch(0.97 0.03 150)', border: 'oklch(0.82 0.08 150)', text: 'oklch(0.4 0.13 150)', dot: 'oklch(0.55 0.15 150)' },
  gray: { bg: 'oklch(0.97 0.005 260)', border: 'oklch(0.87 0.005 260)', text: 'oklch(0.4 0.01 260)', dot: 'oklch(0.6 0.01 260)' },
  red: { bg: 'oklch(0.97 0.02 25)', border: 'oklch(0.84 0.07 25)', text: 'oklch(0.48 0.16 25)', dot: 'oklch(0.6 0.18 25)' },
  amber: { bg: 'oklch(0.975 0.03 85)', border: 'oklch(0.86 0.08 85)', text: 'oklch(0.47 0.11 70)', dot: 'oklch(0.72 0.15 75)' },
};

/** Outcome colors shared by the graph, the event list and the coverage matrix. */
export const OUTCOME = {
  allowed: 'oklch(0.6 0.15 150)',
  observed: 'oklch(0.62 0.08 250)',
  pending: 'oklch(0.72 0.15 75)',
  blocked: 'oklch(0.6 0.18 25)',
} as const;
export type Outcome = keyof typeof OUTCOME;

const PROBLEM_HUES = [20, 60, 290, 250, 150, 320];
export const problems = [
  ['01', 'cat ~/.aws/credentials', 'during a “why is the deploy failing” task. The agent has your credentials because it is you.'],
  ['02', 'npm install', 'runs a postinstall script that opens a connection to a host nobody listed. The tool call looked fine.'],
  ['03', 'git push --force origin main', 'because the rebase “looked clean”. Nobody was asked.'],
  ['04', 'mcp:github', 'holds a token with write access to every repo in the org, and the agent picks which tool to call.'],
  ['05', 'sh -c "python3 fix.py"', 'spawns three processes the API gateway never sees. It only saw the model call.'],
  ['06', 'Who ran that?', 'A week later nobody can say which agent, on whose laptop, under which rule.'],
].map(([num, code, text], i) => {
  const hue = PROBLEM_HUES[i % PROBLEM_HUES.length];
  return {
    num, code, text,
    bg: `oklch(0.97 0.025 ${hue})`, border: `oklch(0.87 0.06 ${hue})`, numColor: `oklch(0.5 0.15 ${hue})`,
  };
});

export const engineParts = [
  { name: 'effigentd', desc: 'One daemon per laptop, server or Kubernetes node. Recognises agents by binary and arguments and follows their whole process trees.' },
  { name: 'Kernel enforcement', desc: 'eBPF and BPF LSM via Tetragon. Blocks exec, file opens and connections for the agent and every process it starts.' },
  { name: 'Agent hooks', desc: 'Pre-tool hooks for Claude Code, Codex and Gemini CLI see the full command, file, URL or MCP tool, so they can deny it or pause it for approval.' },
  { name: 'Policy evaluator', desc: 'The same evaluator runs on the endpoint and in the console, so a simulated decision matches the enforced one.' },
  { name: 'Approvals', desc: 'A paused action waits for a named reviewer in Slack, email or the console. The approval is single-use and bound to that exact action.' },
  { name: 'Audit trail', desc: 'Every decision with its policy version, rule, endpoint, OS user and approver. Append-only and hash-chained.' },
  { name: 'Pricing Leaks', desc: 'Joins seat, usage and cost data from AI vendors’ admin APIs with what actually runs on each machine.' },
  { name: 'Control plane', desc: 'Signed policies, endpoints, approvals, spend and audit in one console. Policies keep working offline.' },
];

/** What Effigent covers, per action: which layer enforces it and the decisions
 *  available. Shared by the home page and /docs/enforcement. */
export type Decision = 'block' | 'approve' | 'audit' | 'attribute';
export const COVERAGE: Array<{ what: string; example: string; by: string; decisions: Decision[] }> = [
  { what: 'Run a program', example: '/usr/bin/curl', by: 'Kernel + agent hooks', decisions: ['block', 'approve', 'audit'] },
  { what: 'A specific command', example: 'git push --force origin main', by: 'Agent hooks', decisions: ['block', 'approve', 'audit'] },
  { what: 'Child processes & scripts', example: 'python3 fix.py → sh → nc', by: 'Kernel (eBPF)', decisions: ['block', 'audit'] },
  { what: 'Open a file', example: '~/.ssh/id_ed25519', by: 'Kernel + agent hooks', decisions: ['block', 'approve', 'audit'] },
  { what: 'Outbound connection', example: 'paste.example.net:443', by: 'Kernel + agent hooks', decisions: ['block', 'approve', 'audit'] },
  { what: 'MCP & agent tool call', example: 'mcp__github__delete_branch', by: 'Agent hooks', decisions: ['block', 'approve', 'audit'] },
  { what: 'Agent session', example: 'claude-code · pid 48211', by: 'effigentd process tree', decisions: ['attribute', 'audit'] },
];
export const DECISION_STYLE: Record<Decision, { label: string; fg: string; bg: string; border: string }> = {
  block: { label: 'Block', fg: 'oklch(0.45 0.16 25)', bg: 'oklch(0.97 0.02 25)', border: 'oklch(0.85 0.07 25)' },
  approve: { label: 'Require approval', fg: 'oklch(0.45 0.11 70)', bg: 'oklch(0.975 0.03 85)', border: 'oklch(0.86 0.08 85)' },
  audit: { label: 'Audit', fg: 'oklch(0.42 0.1 250)', bg: 'oklch(0.97 0.02 250)', border: 'oklch(0.86 0.05 250)' },
  attribute: { label: 'Attribute', fg: 'oklch(0.4 0.13 150)', bg: 'oklch(0.97 0.03 150)', border: 'oklch(0.82 0.08 150)' },
};

export const installTabs = [
  { key: 'linux', label: 'Linux' },
  { key: 'macos', label: 'macOS' },
  { key: 'windows', label: 'Windows' },
  { key: 'kubernetes', label: 'Kubernetes' },
  { key: 'headless', label: 'Headless & CI' },
  { key: 'policy', label: 'Local policy' },
  { key: 'check', label: 'Check it' },
];

export const INSTALL_CODE: Record<string, string> = {
  linux:
    '# Kernel enforcement (eBPF via Tetragon) + agent hooks.\n# Copy the exact line from Console → Enforcement → Install on an endpoint.\ncurl -fsSL https://effigent.ai/install.sh | sudo sh -s -- --token <enrollment-token>\n\neffigentd status        # sensor, policy version, tracked agents',
  macos:
    '# Agent hooks for Claude Code, Codex and Gemini CLI (deny / pause / audit).\n# Copy the exact line from Console → Enforcement → Install on an endpoint.\ncurl -fsSL https://effigent.ai/install.sh | sudo sh -s -- --token <enrollment-token>\n\neffigentd status        # policy version, hooks, tracked agents',
  windows:
    '# Elevated PowerShell. Installs the service and the agent hooks.\niwr https://effigent.ai/install.ps1 -OutFile install.ps1\n.\\install.ps1 -Token <enrollment-token>\n\n# Intune (Win32 app): powershell.exe -ExecutionPolicy Bypass -File install.ps1 -Token eft_…',
  kubernetes:
    '# One effigentd per node (DaemonSet), next to Tetragon.\nhelm repo add effigent https://effigent.ai/charts\nkubectl create namespace effigent\nkubectl -n effigent create secret generic effigent-enrollment --from-literal=token=<enrollment-token>\nhelm install effigent effigent/effigent -n effigent\n\n# Tetragon chart, values and upgrades: /docs/kubernetes',
  headless:
    '# Start the agent only after its kernel policy is live.\n# effigentd waits until the kernel refuses a canary file for this pid,\n# then execs the agent in place — no instruction runs unenforced.\neffigentd run --agent claude-code --strict -- claude -p "fix the failing test"\n\n# --strict   refuse to start if enforcement is not confirmed\n# --timeout  how long to wait for it (default 10s)',
  policy:
    '# What the kernel half of a policy looks like on the machine\ndefaults:\n  mode: denylist          # monitor | learn | denylist | allowlist\n  exec_deny: [/usr/bin/curl, /usr/bin/nc, /usr/bin/socat]\n  file_deny: [/.ssh/id_ed25519, /.aws/credentials]\n  network: true           # report outbound TCP connects\n\nagents:\n  - name: codex\n    binary_names: [codex]\n    args_contains: ["@openai/codex"]\n    mode: learn           # record every binary it runs first',
  check:
    '# effigentd’s local API (read-only unless EFFIGENT_API_TOKEN is set)\ncurl -s 127.0.0.1:7777/health\ncurl -s 127.0.0.1:7777/agents     # tracked agents + their loaded kernel policy\ncurl -s 127.0.0.1:7777/learned    # binaries each agent ran → seed for exec_allow',
};

/** Agents effigentd recognises out of the box (internal/endpoint/policy/default.yaml).
 *  Drives the "recognised out of the box" count — keep it to that file. hermes is
 *  left out until its matcher there is verified (see the comment on it). */
export const supportedAgents = ['Claude Code', 'Codex', 'Cursor', 'Gemini CLI', 'Aider', 'OpenCode', 'Goose'];
/** Agents shown in the "works with" strips: the recognised set, GitHub Copilot
 *  (Pricing Leaks connector) and any custom agent added in policy. */
export const agentChips = [...supportedAgents, 'GitHub Copilot', 'Any custom agent'];
/** Where effigentd runs. */
export const platforms = ['Linux', 'macOS', 'Windows', 'Kubernetes', 'Docker', 'CI runners'];

/** Pricing Leaks: vendor connectors and the four kinds of finding. */
export const spendVendors = ['Cursor', 'Anthropic · Claude Code', 'GitHub Copilot', 'OpenAI · Codex'];
export const leakKinds: Array<{ title: string; hue: string; text: string; signal: string }> = [
  { title: 'Unused seats', hue: '25', text: 'Licences assigned to people whose machines haven’t run that agent in weeks.', signal: 'seat list × agent activity per machine' },
  { title: 'Duplicate tools', hue: '75', text: 'The same developer paying for several coding agents while really using one.', signal: 'seats across vendors × the agent that actually runs' },
  { title: 'Shadow spend', hue: '290', text: 'Agents running on personal cards or accounts outside your organisation’s plans.', signal: 'agents on machines × no matching org seat' },
  { title: 'Runaway costs', hue: '250', text: 'An agent looping in CI, or one user far above the team median.', signal: 'daily usage × team median × CI activity' },
];

/** Hero graph: one agent session on one machine, edges colored by outcome. */
const RUNTIME_NODES: Array<{ label: string; count: number; outcome: Outcome }> = [
  { label: 'git', count: 41, outcome: 'allowed' },
  { label: '~/src/payments', count: 128, outcome: 'allowed' },
  { label: 'mcp:github', count: 9, outcome: 'allowed' },
  { label: 'git push --force', count: 1, outcome: 'pending' },
  { label: '/usr/bin/curl', count: 2, outcome: 'blocked' },
  { label: 'api.github.com', count: 22, outcome: 'observed' },
  { label: 'npm', count: 12, outcome: 'allowed' },
];
export function buildRuntimeGraph() {
  const cx = 50, cy = 50, R = 38;
  const n = RUNTIME_NODES.length;
  const nodes = RUNTIME_NODES.map((d, i) => {
    const angle = i * (360 / n) - 90;
    const rad = (angle * Math.PI) / 180;
    return {
      label: d.label, count: d.count, outcome: d.outcome,
      left: `${(cx + R * Math.cos(rad)).toFixed(1)}%`,
      top: `${(cy + R * Math.sin(rad)).toFixed(1)}%`,
      color: OUTCOME[d.outcome], glow: d.outcome === 'pending', angle,
    };
  });
  const edges = nodes.map((node, i) => ({
    rot: `${node.angle}deg`, color: node.color, outcome: node.outcome,
    flowDur: `${(1.6 + (i % 3) * 0.5).toFixed(1)}s`,
    flowDelay: `${(i * 0.25).toFixed(2)}s`,
  }));
  return { nodes, edges };
}
