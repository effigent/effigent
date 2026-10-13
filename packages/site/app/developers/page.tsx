import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, CodeBlock, PageHero, DocSection, StepBadge } from '../ui';

export const metadata: Metadata = {
  title: 'Agent setup — Effigent for Claude Code, Cursor, Codex and more',
  description:
    'How effigentd recognises Claude Code, Cursor, Codex, Gemini CLI, Aider, opencode and Goose, which hooks it uses for each, how MCP servers are tracked, and how to add your own agent.',
};

const AGENTS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    tag: 'Kernel + PreToolUse hook',
    blurb:
      'The fullest coverage. effigentd registers a PreToolUse hook, so every Bash, Read, Edit, WebFetch and MCP tool call is checked before it runs, with the full command or path. require_approval rules pause the call in the terminal until a reviewer answers. On Linux the kernel layer covers everything the tool call starts afterwards.',
    code: `> push the rebase to main

⏺ Bash(git push --force origin main)
  ⎿  effigent: paused by “Production guardrails › force-push”
     waiting for payments-leads · expires in 15m

# denied → Claude gets the reason as the tool result:
  ⎿  effigent: denied by maya.cohen — "open a PR, main is protected"`,
    title: 'claude — what the developer sees',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    tag: 'Kernel + beforeShellExecution hook',
    blurb:
      'effigentd registers Cursor’s beforeShellExecution hook, so shell commands from the agent are checked, denied or paused with the full command line. File reads, edits and MCP calls in Cursor are covered by the kernel layer on Linux and observed on macOS.',
    code: `cursor-agent → run_terminal_cmd: npm install left-pad-pro@2.1.0
effigent: paused by “Production guardrails › package-installs”
          waiting for payments-leads · expires in 10m`,
    title: 'cursor — a paused shell command',
  },
  {
    id: 'codex',
    name: 'Codex, Gemini CLI, Aider, opencode, Goose',
    tag: 'Kernel only',
    blurb:
      'Recognised by binary or arguments and tracked with their full process trees. effigentd does not hook these agents yet, so there is no pause and no argument-level check: on Linux the kernel blocks by binary and file path, on macOS they are observed. Learn mode is the useful first step here: record what the agent actually runs, then allowlist it.',
    code: `# one week in learn mode, then read what codex really runs
curl -s 127.0.0.1:7777/learned
{ "codex": ["/usr/bin/git", "/usr/bin/node", "/usr/bin/rg", "/usr/bin/python3"] }

# → paste into exec_allow and switch codex to allowlist`,
    title: 'sh — building an allowlist for codex',
  },
];

export default function DevelopersPage() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Agent setup"
        title="What effigentd does for each agent."
        sub="You don’t install anything per agent. effigentd recognises agents by their binary or launch arguments, follows their process trees, and wires up hooks for the agents that have them. This page says what that gets you, agent by agent."
      />

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 28, margin: '0 0 20px' }}>Three ways effigentd sees an agent</h2>
        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
          {[
            ['Process tree', 'Every agent is tracked from its pid down: shells, scripts, package hooks, MCP servers. Agents already running when effigentd starts are picked up from /proc.'],
            ['Hooks', 'Claude Code and Cursor ask a hook before each tool call. That is where commands, arguments and approvals are handled.'],
            ['Kernel (Linux)', 'A policy scoped to the agent’s pids blocks exec by binary and file opens by path, for the agent and all its children.'],
          ].map(([t, d]) => (
            <div key={t} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '18px 20px', background: 'oklch(0.995 0.002 90)' }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 6 }}>{t}</div>
              <div style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.55 }}>{d}</div>
            </div>
          ))}
        </div>
        <p className="doc-p" style={{ marginTop: 18 }}>
          Exactly which actions each layer can block, pause or only observe is in <Link href="/docs/enforcement">Enforcement &amp; coverage</Link>.
        </p>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 28, margin: '0 0 8px' }}>Per agent</h2>
        {AGENTS.map((h) => (
          <div key={h.id} id={h.id} style={{ margin: '30px 0 0' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
              <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{h.name}</h3>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', border: '1px solid var(--line-2)', borderRadius: 12, padding: '3px 10px' }}>{h.tag}</span>
            </div>
            <p style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.65, margin: '0 0 14px', maxWidth: 680 }}>{h.blurb}</p>
            <CodeBlock title={h.title}>{h.code}</CodeBlock>
          </div>
        ))}
      </DocSection>

      <DocSection id="mcp">
        <h2 className="h-serif" style={{ fontSize: 28, margin: '0 0 10px' }}>MCP servers</h2>
        <p className="doc-p">
          An MCP server started by an agent is a child process, so it is in the agent&apos;s tree and under the agent&apos;s rules. effigentd labels it from its command line (<code>@modelcontextprotocol/server-github</code> becomes <code>mcp:github</code>), and every event below it carries that label, so you can tell a <code>git</code> run by the agent from one run by its GitHub server.
        </p>
        <p className="doc-p">
          An MCP server with no known agent above it, for example one started by an editor effigentd doesn&apos;t recognise, becomes its own tracked root and gets the default rules. Tool-level rules such as <code>github.delete_*</code> need a hook, which today means Claude Code.
        </p>
      </DocSection>

      <DocSection id="custom">
        <h2 className="h-serif" style={{ fontSize: 28, margin: '0 0 6px', display: 'flex', alignItems: 'center' }}><StepBadge n={1} />Your own agent</h2>
        <p className="doc-p" style={{ marginTop: 10 }}>
          Anything that runs as a process can be tracked. Add an entry with the binary name, or a substring of the arguments for agents launched through <code>node</code> or <code>python</code>:
        </p>
        <CodeBlock title="policy — agents">{`agents:
  - name: release-bot              # lowercase, digits and '-'
    binary_names: [release-bot]
    args_contains: ["release_bot/main.py"]
    mode: learn                    # start by recording what it runs`}</CodeBlock>
      </DocSection>

      <DocSection id="headless">
        <h2 className="h-serif" style={{ fontSize: 28, margin: '0 0 6px', display: 'flex', alignItems: 'center' }}><StepBadge n={2} />Headless, CI and long-running agents</h2>
        <p className="doc-p" style={{ marginTop: 10 }}>
          Wrap the command in <code>effigentd run</code>. It waits until the kernel policy for its pid is provably live, then execs the agent in place. With <code>--strict</code>, the agent doesn&apos;t start at all if enforcement can&apos;t be confirmed.
        </p>
        <CodeBlock title="sh — CI runner">{`effigentd run --agent claude-code --strict -- claude -p "triage the failing tests"
effigentd run --agent codex --strict --timeout 20s -- codex exec "bump the lockfile"`}</CodeBlock>
      </DocSection>

      <DocSection>
        <div style={{ border: '1px solid oklch(0.85 0.06 150)', background: 'oklch(0.97 0.03 150)', borderRadius: 12, padding: '22px 24px' }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8, color: 'oklch(0.35 0.12 150)' }}>Start with monitor</div>
          <div style={{ fontSize: 14, color: 'oklch(0.35 0.05 150)', lineHeight: 1.65 }}>
            In monitor mode nothing is blocked and every match is reported as <code style={{ fontFamily: 'var(--mono)' }}>would_block</code>. Read a few days of that before you enforce, and your developers won&apos;t meet a rule you didn&apos;t mean. The <Link href="/docs/quickstart" style={{ textDecoration: 'underline' }}>quickstart</Link> walks through it.
          </div>
        </div>
      </DocSection>

      <Footer />
    </div>
  );
}
