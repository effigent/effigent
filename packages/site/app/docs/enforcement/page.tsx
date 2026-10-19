import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection, CodeBlock, DocsPager, H2 } from '../../ui';
import { CoverageTable } from '../../coverage';

export const metadata: Metadata = {
  title: 'Enforcement & coverage — Effigent docs',
  description: 'Which coding-agent actions Effigent blocks, pauses or only observes on Linux and macOS, how the kernel and hook layers split the work, fail-closed start, offline behaviour and emergency suspend.',
};

const AGENTS: Array<[string, string, string, string?]> = [
  ['Claude Code', 'binary claude · args @anthropic-ai/claude-code', 'PreToolUse'],
  ['Cursor', 'binary cursor-agent', 'beforeShellExecution'],
  ['Codex', 'binary codex · args @openai/codex', '—'],
  ['Gemini CLI', 'binary gemini · args @google/gemini-cli', '—'],
  ['Aider', 'binary aider', '—'],
  ['opencode', 'binary opencode', '—'],
  ['Goose', 'binary goose', '—'],
  ['Claude Cowork', 'Claude app’s virtual machine (macOS) · reported only', '—', '—'],
];

export default function Enforcement() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Docs · Enforcement & coverage"
        title="What gets blocked, paused, or only watched."
        sub="effigentd enforces in two places on the machine: the agent’s own pre-tool hooks and, on Linux, the kernel. They see different things. This page says exactly which, per OS, so a policy never claims more than the machine can do."
      />

      <DocSection>
        <H2>The two layers</H2>
        <ul className="doc-list">
          <li><b>Agent hooks.</b> Claude Code and Cursor call a hook before each tool runs. The hook sees the full command, file path, URL or MCP tool name, so it can allow, deny, or pause for approval. It only sees the agent&apos;s own tool calls, not what a script started by that call does afterwards.</li>
          <li><b>Kernel (Linux).</b> effigentd loads a policy scoped to each agent&apos;s process tree through eBPF (Tetragon). It sees every exec, file open and outbound connection from the agent and all of its children, including scripts and package hooks. It blocks exec by resolved binary path, file opens by path, and connections by destination address (<code>network_deny</code>, <code>network_allow</code>, and hostnames in <code>domain_deny</code>, which effigentd resolves to addresses). It cannot pause, and it does not match on arguments.</li>
          <li><b>Endpoint Security (macOS).</b> effigentd reads exec, file and network events for agent trees. On macOS the OS layer observes; enforcement comes from hooks.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2>Coverage matrix</H2>
        <CoverageTable />
        <ul className="doc-list" style={{ marginTop: 18 }}>
          <li><b>Block</b>: stopped before it runs. <b>Pause</b>: held until a reviewer approves; hooks can also deny outright. <b>Observe</b>: recorded, and reported as <code>would_block</code> when a rule would have stopped it. <b>—</b>: that layer does not see it.</li>
          <li>Hook cells apply to the agent&apos;s own tool calls (for Claude Code: Bash, Read, Edit, WebFetch and <code>mcp__*</code> tools). Cursor&apos;s hook covers shell commands.</li>
          <li>The kernel blocks connections by destination address, not by name. <code>network_deny</code> and <code>network_allow</code> take IPs and CIDRs. <code>domain_deny</code> takes hostnames: effigentd re-resolves them every 30 seconds through the system resolver and public resolvers, and blocks every address it has seen for each name in the last 15 minutes.</li>
          <li><code>domain_deny</code> has limits. Sites behind a shared CDN share addresses, so blocking one can block unrelated sites on the same address, and the agent can get an address effigentd never saw. Each name is exact: list <code>www.example.com</code> separately, and wildcards are refused. While it is in force, agents can&apos;t reach well-known public resolvers on DNS ports or use DNS over TLS, but a private DoH server, a hard-coded address or a proxy still gets through. For a guarantee, use <code>network_allow</code> so agents can reach only the destinations you list.</li>
          <li>An MCP server shows up in the kernel layer as a process under the agent: its execs, files and connections follow the agent&apos;s rules. Tool-level MCP rules need a hook.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2>Per agent</H2>
        <p className="doc-p">effigentd recognises these out of the box, by binary name or a substring of the arguments (for Node and Python launchers). You can add your own in policy.</p>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>Agent</th><th>Detected by</th><th>Hook</th><th>Linux kernel</th></tr></thead>
            <tbody>
              {AGENTS.map(([a, d, h, k]) => (
                <tr key={a}><td style={{ fontWeight: 600, color: 'var(--ink)' }}>{a}</td><td><code>{d}</code></td><td>{h === '—' ? '—' : <code>{h}</code>}</td><td>{k ?? 'exec · file · network'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="doc-p" style={{ marginTop: 16 }}>
          Agents without a hook get the kernel column on Linux and are observe-only on macOS. That is the honest state today; the console marks it per endpoint. Claude Cowork in the Claude desktop app runs Claude Code inside its own virtual machine, where the Mac&apos;s managed settings and effigentd&apos;s hook don&apos;t exist: effigentd reports each Cowork VM as an agent that is <b>not under policy</b>, but can&apos;t see or stop its commands, web requests or changes to the folders shared with it. Cowork sessions that run in Anthropic&apos;s cloud never touch the machine. Use Cowork&apos;s own admin controls (network egress, or turning Cowork off on managed devices) for those. Details per agent are in the <Link href="/developers">agent setup guide</Link>.
        </p>
      </DocSection>

      <DocSection>
        <H2>No unenforced first second</H2>
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
          Decisions are made on the machine, from the last policy the machine received. Losing the connection to the control plane changes nothing about enforcement. Events and approval requests queue and are sent when the machine reconnects. The console shows each endpoint&apos;s last heartbeat and policy version, so stale machines are visible.
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
              <tr><td><code>requested</code></td><td>Someone pressed Suspend. Nothing has reached the machine yet.</td></tr>
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
        <H2>Known gaps</H2>
        <ul className="doc-list">
          <li>Kernel exec blocking is per binary. <code>python3</code> allowed means every Python script is allowed at that layer.</li>
          <li>macOS cannot block at the OS layer today. On macOS, an agent without hooks is observed, not controlled.</li>
          <li>Anyone with root on the machine can stop effigentd. Its heartbeat going quiet is visible in the console, but it is not tamper-proof against the machine&apos;s own administrator.</li>
          <li>effigentd&apos;s local policy API is read-only unless started with a token, because the agents it governs can reach localhost.</li>
        </ul>
      </DocSection>

      <DocsPager current="/docs/enforcement" />
      <Footer />
    </div>
  );
}
