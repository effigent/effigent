import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection, CodeBlock, DocsPager, H2 } from '../../ui';
import { CoverageTable } from '../../coverage';

export const metadata: Metadata = {
  title: 'Enforcement & coverage — Effigent docs',
  description: 'How Effigent enforces policy on coding agents: kernel-level eBPF enforcement across every child process, agent hooks for commands, files, URLs and MCP tools in Claude Code, Codex, Gemini CLI and Cursor, approvals, alerts when protection is switched off, enforcement from the first instruction, offline behaviour and emergency suspend.',
};

const AGENTS: Array<[string, string, string]> = [
  ['Claude Code', 'binary claude · args @anthropic-ai/claude-code', 'Kernel + PreToolUse hook'],
  ['Codex', 'binary codex · args @openai/codex', 'Kernel + PreToolUse hook'],
  ['Gemini CLI', 'binary gemini · args @google/gemini-cli', 'Kernel + BeforeTool hook'],
  ['Cursor', 'binary cursor-agent · the Cursor app', 'Kernel + Cursor hooks'],
  ['Aider', 'binary aider', 'Kernel + process tree'],
  ['OpenCode', 'binary opencode', 'Kernel + process tree'],
  ['Goose', 'binary goose', 'Kernel + process tree'],
  ['Your own agent', 'any binary name or launch argument', 'Kernel + process tree'],
  ['Cloud agents', 'Claude Code on the web, Copilot coding agent, Cursor background agents', 'Repository hooks + cloud environment'],
];

export default function Enforcement() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Docs · Enforcement & coverage"
        title="Enforcement on the machine, down to the kernel."
        sub="effigentd enforces in two places on the machine: the agent’s own pre-tool hooks, which see exactly what the agent asks for, and the kernel, which sees every process the agent starts. Together they cover every kind of agent action."
      />

      <DocSection>
        <H2>The two layers</H2>
        <ul className="doc-list">
          <li><b>Agent hooks.</b> Claude Code, Codex, Gemini CLI and Cursor call a hook before each tool runs, on Linux, macOS and Windows. effigentd installs it in the agents&apos; machine-wide settings (<code>effigentd install-hooks</code>; the macOS and Windows installers run it). The hook sees the full command, file path, URL or MCP tool name, so it can allow, deny, or pause the call for approval. It also reads what the call does: a push to a protected branch, a destructive SQL statement, a cloud change in production, a package install (see <Link href="/docs/actions">Actions</Link>). One policy covers all four agents, because their tools are mapped onto the same names. Agents in Kubernetes pods reach it through the node&apos;s <Link href="/docs/kubernetes#hooks">hook socket</Link>, and agents in a vendor&apos;s cloud through a <Link href="/docs/cloud-agents">cloud environment</Link>.</li>
          <li><b>Kernel (eBPF, Linux).</b> effigentd loads a policy scoped to each agent&apos;s process tree through eBPF and BPF LSM (Tetragon). It sees every exec, file open and outbound connection from the agent and all of its children, including scripts the agent wrote, package hooks and MCP servers. It blocks exec by resolved binary path, file opens by path, and connections by destination (<code>network_deny</code>, <code>network_allow</code>, and hostnames in <code>domain_deny</code>, which effigentd resolves to addresses).</li>
          <li><b>Process tree.</b> effigentd recognises each agent by binary or launch arguments, follows every process it starts, and attributes each event to that agent, user and machine.</li>
          <li><b>Model gateway.</b> Optionally, Claude Code and Codex send their model calls through effigentd on the machine. That is where models are allowed or refused and tokens are counted for each call. See <Link href="/docs/model-gateway">Model gateway</Link>.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2>What Effigent covers</H2>
        <CoverageTable />
        <ul className="doc-list" style={{ marginTop: 18 }}>
          <li><b>Block</b>: stopped before it runs. <b>Require approval</b>: held until a named reviewer approves; hooks can also deny outright. <b>Audit</b>: recorded with the rule and policy version. In <code>monitor</code> mode every match is reported as <code>would_block</code> instead.</li>
          <li>Hook checks apply to the agent&apos;s own tool calls: shell commands, file reads and edits, web fetches and <code>mcp__*</code> tools. Commands are read through pipes, <code>&amp;&amp;</code>, <code>$( )</code>, <code>sh -c</code> and sudo/env/xargs wrappers.</li>
          <li><code>network_deny</code> and <code>network_allow</code> take IPs and CIDRs. <code>domain_deny</code> takes hostnames: effigentd re-resolves them every 30 seconds through the system resolver and public resolvers, and blocks every address it has seen for each name in the last 15 minutes. While it is in force, agents are kept off well-known public DNS resolvers and DNS over TLS, so their lookups go through the resolvers you run. List each hostname exactly (<code>www.example.com</code> separately).</li>
          <li>For the tightest egress control, combine <code>domain_deny</code> with <code>network_allow</code>, so agents reach only the destinations you list.</li>
          <li>An MCP server shows up in the kernel layer as a process under the agent: its execs, files and connections follow the agent&apos;s rules. Tool-level MCP rules (<code>tool_deny</code>, <code>tool_approve</code>) run in the agent hooks.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2>Per agent</H2>
        <p className="doc-p">effigentd recognises these out of the box, by binary name or a substring of the arguments (for Node and Python launchers). You can add your own in policy.</p>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>Agent</th><th>Detected by</th><th>Enforced by</th></tr></thead>
            <tbody>
              {AGENTS.map(([a, d, h]) => (
                <tr key={a}><td style={{ fontWeight: 600, color: 'var(--ink)' }}>{a}</td><td><code>{d}</code></td><td>{h}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="doc-p" style={{ marginTop: 16 }}>
          On Linux, every agent gets the kernel layer for itself and every process it starts: exec, file and network rules, attribution and audit. Add any other agent in policy by binary name or launch arguments and it is governed the same way. Details per agent are in the <Link href="/developers">agent setup guide</Link>.
        </p>
      </DocSection>

      <DocSection>
        <H2>Enforced from the first instruction</H2>
        <p className="doc-p">
          effigentd notices a new agent process and loads its kernel policy within about a second. For headless runs where that second matters, start the agent through <code>effigentd run</code>: it waits until the kernel refuses a canary file for its own pid, which proves the policy is live, then execs the agent in place under the same pid.
        </p>
        <CodeBlock title="sh — CI or a long-running agent">{`effigentd run --agent claude-code --strict -- claude -p "fix the failing test"

#  --agent    which agent rule applies
#  --strict   refuse to start if enforcement isn’t confirmed
#  --timeout  how long to wait for it (default 10s)`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          When effigentd stops, it removes the kernel policies it loaded. Start it with <code>-keep-policies-on-exit</code> to leave them in place instead (fail-closed); they are reconciled on the next start.
        </p>
      </DocSection>

      <DocSection>
        <H2>Offline</H2>
        <p className="doc-p">
          Decisions are made on the machine, from the last policy the machine received. Losing the connection to the control plane changes nothing about enforcement. Events wait on the machine&apos;s disk and are sent when it reconnects. An action that needs an approval is denied until an approver can be reached, never silently allowed. The console shows each endpoint&apos;s last heartbeat and policy version, and a machine that stays silent raises an offline alert.
        </p>
      </DocSection>

      <DocSection>
        <H2>Emergency suspend</H2>
        <p className="doc-p">
          From the console you can suspend one agent session or a whole process tree. The request has three states, and the console shows which one it is in:
        </p>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>State</th><th>Meaning</th></tr></thead>
            <tbody>
              <tr><td><code>requested</code></td><td>Someone pressed Suspend. The request is on its way to the machine.</td></tr>
              <tr><td><code>delivered</code></td><td>effigentd on the endpoint received the request.</td></tr>
              <tr><td><code>confirmed</code></td><td>The processes are stopped and the endpoint reported back.</td></tr>
            </tbody>
          </table>
        </div>
        <p className="doc-p" style={{ marginTop: 14 }}>
          An asleep or offline laptop stays in <code>requested</code> until it reconnects. The console never shows a suspend as done before the machine says so.
        </p>
      </DocSection>

      <DocSection>
        <H2>When protection is switched off</H2>
        <p className="doc-p">
          Someone with admin rights on a machine can edit its files or stop its services. Effigent makes sure you know when that happens:
        </p>
        <ul className="doc-list">
          <li><b>Hook health.</b> Every machine reports, for each agent, whether its hook is installed. It flags a hook that was removed, switched off in the agent&apos;s settings, edited to fail open, disabled by a user, or pointing at an effigentd binary that is gone. A new problem on a machine where that agent is installed raises an alert. You see it in the console, by email and on webhook <code>endpoint.hooks_missing</code>.</li>
          <li><b>Stopped or silent.</b> A clean stop sends <code>daemon_stop</code> with the signal and how effigentd was run. A kill or crash shows up as <code>daemon_unclean_restart</code> at the next start. A machine silent longer than your threshold (default five minutes) goes offline, with webhook <code>endpoint.offline</code>. Offline emails are off by default; turn them on in Enforcement settings with a repeat interval (every hour to once a week), and a machine is emailed about at most once per interval, however often it sleeps and wakes. The alert tells a stop apart from a machine that went silent.</li>
          <li><b>Hooks fail closed.</b> If effigentd isn&apos;t running, the agents&apos; hooks deny the call rather than letting it through.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2>Hardening recommendations</H2>
        <ul className="doc-list">
          <li>Pair exec rules with file and network rules. Kernel exec rules match the resolved binary, so <code>file_deny</code> and <code>network_allow</code> constrain what any interpreter an agent runs can reach.</li>
          <li>Use <code>require_launcher: true</code> for CI and headless agents, so the policy is live before the first instruction.</li>
          <li>Deny <code>sudo</code> to agents that don&apos;t need it. Turn on the machine health alerts (Machines → Machine health alerts), so a removed hook or a stopped daemon reaches you by email or webhook.</li>
          <li>Keep effigentd&apos;s local policy API read-only (the default). Set a token only on machines you run standalone.</li>
        </ul>
      </DocSection>

      <DocsPager current="/docs/enforcement" />
      <Footer />
    </div>
  );
}
