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
  { name: 'effigentd', desc: 'One daemon per machine. Recognises agents by binary and arguments and follows their process trees.' },
  { name: 'Kernel sensor (Linux)', desc: 'eBPF via Tetragon. Blocks exec by resolved path and file opens by path, scoped to the agent’s pids.' },
  { name: 'Endpoint Security (macOS)', desc: 'Sees exec, file and network events from agent trees. Observes; it does not block.' },
  { name: 'Agent hooks', desc: 'Claude Code PreToolUse and Cursor beforeShellExecution see the full command, so they can deny or pause it.' },
  { name: 'Policy evaluator', desc: 'The same evaluator runs on the endpoint and in the console, so a simulated decision matches the enforced one.' },
  { name: 'Approvals', desc: 'A paused action waits for a named reviewer. The approval is single-use and bound to that exact action.' },
  { name: 'Audit trail', desc: 'Every decision with its policy version, rule, endpoint, OS user and approver. Tamper-evident.' },
  { name: 'Control plane', desc: 'Policies, endpoints, approvals and audit in one console. Hosted, or run it yourself.' },
];

/** What each layer can do per action type. Matches /docs/enforcement. */
export type Cover = 'block' | 'pause' | 'observe' | 'none';
export const COVERAGE_COLS = ['Linux kernel', 'macOS', 'Claude Code hook', 'Cursor hook'] as const;
export const COVERAGE: Array<{ what: string; example: string; cells: [Cover, Cover, Cover, Cover] }> = [
  { what: 'Run a binary', example: '/usr/bin/curl', cells: ['block', 'observe', 'pause', 'pause'] },
  { what: 'Specific arguments', example: 'git push --force origin main', cells: ['observe', 'observe', 'pause', 'pause'] },
  { what: 'Child processes & scripts', example: 'postinstall → sh → nc', cells: ['block', 'observe', 'none', 'none'] },
  { what: 'Open a file', example: '~/.ssh/id_ed25519', cells: ['block', 'observe', 'pause', 'none'] },
  { what: 'Outbound connection', example: 'paste.example.net:443', cells: ['observe', 'observe', 'pause', 'none'] },
  { what: 'MCP tool call', example: 'github.delete_branch', cells: ['observe', 'observe', 'pause', 'none'] },
];
export const COVER_STYLE: Record<Cover, { label: string; fg: string; bg: string; border: string }> = {
  block: { label: 'Block', fg: 'oklch(0.45 0.16 25)', bg: 'oklch(0.97 0.02 25)', border: 'oklch(0.85 0.07 25)' },
  pause: { label: 'Pause', fg: 'oklch(0.45 0.11 70)', bg: 'oklch(0.975 0.03 85)', border: 'oklch(0.86 0.08 85)' },
  observe: { label: 'Observe', fg: 'oklch(0.42 0.1 250)', bg: 'oklch(0.97 0.02 250)', border: 'oklch(0.86 0.05 250)' },
  none: { label: '—', fg: 'oklch(0.6 0.01 260)', bg: 'transparent', border: 'transparent' },
};

export const installTabs = [
  { key: 'linux', label: 'Linux' },
  { key: 'macos', label: 'macOS' },
  { key: 'headless', label: 'Headless & CI' },
  { key: 'policy', label: 'Local policy' },
  { key: 'check', label: 'Check it' },
];

export const INSTALL_CODE: Record<string, string> = {
  linux:
    '# Kernel enforcement (eBPF via Tetragon) + agent hooks.\n# Copy the exact line from Console → Enforcement → Install on an endpoint.\ncurl -fsSL <install-url> | sudo sh -s -- --enroll <enrollment-token>\n\neffigentd status        # sensor, policy version, tracked agents',
  macos:
    '# Endpoint Security (observe) + agent hooks (deny / pause).\n# Copy the exact line from Console → Enforcement → Install on an endpoint.\ncurl -fsSL <install-url> | sudo sh -s -- --enroll <enrollment-token>\n\neffigentd status        # sensor, policy version, tracked agents',
  headless:
    '# Start the agent only after its kernel policy is live.\n# effigentd waits until the kernel refuses a canary file for this pid,\n# then execs the agent in place — no instruction runs unenforced.\neffigentd run --agent claude-code --strict -- claude -p "fix the failing test"\n\n# --strict   refuse to start if enforcement is not confirmed\n# --timeout  how long to wait for it (default 10s)',
  policy:
    '# What the kernel half of a policy looks like on the machine\ndefaults:\n  mode: denylist          # monitor | learn | denylist | allowlist\n  exec_deny: [/usr/bin/curl, /usr/bin/nc, /usr/bin/socat]\n  file_deny: [/.ssh/id_ed25519, /.aws/credentials]\n  network: true           # report outbound TCP connects\n\nagents:\n  - name: codex\n    binary_names: [codex]\n    args_contains: ["@openai/codex"]\n    mode: learn           # record every binary it runs first',
  check:
    '# effigentd’s local API (read-only unless EFFIGENT_API_TOKEN is set)\ncurl -s 127.0.0.1:7777/health\ncurl -s 127.0.0.1:7777/agents     # tracked agents + their loaded kernel policy\ncurl -s 127.0.0.1:7777/learned    # binaries each agent ran → seed for exec_allow',
};

/** Agents effigentd recognises out of the box (policy/default.yaml). */
export const supportedAgents = ['Claude Code', 'Cursor', 'Codex', 'Gemini CLI', 'Aider', 'opencode', 'Goose'];

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
