import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, CodeBlock, PageHero, DocSection } from '../ui';

export const metadata: Metadata = {
  title: 'Security & data — Effigent',
  description:
    'How Effigent handles security: decisions made on the endpoint, what effigentd sends to the control plane and what it never does, a locked local API, enrollment and roles, a tamper-evident audit trail, and stated limits.',
};

const PILLARS = [
  {
    hue: '150',
    title: 'Decisions are made on the machine',
    body: 'effigentd evaluates every action locally against the last policy it received. The control plane distributes policy and collects events; it is not in the path of a decision. If the network or the control plane is down, enforcement continues and events queue until the machine reconnects.',
  },
  {
    hue: '250',
    title: 'Metadata about actions, not your code',
    body: 'effigentd sends what a rule and an audit trail need: which agent, which process, the binary and its arguments, the working directory, file paths, destination host and port, MCP server and tool names, the user and the machine. It does not read or send file contents, and it does not see model prompts or responses. The agent’s raw tool input is redacted on the machine before it leaves, and is only shown for context.',
  },
  {
    hue: '25',
    title: 'Agents can’t lift their own policy',
    body: 'Agents run as the developer; effigentd runs as root. Its local API is read-only unless the daemon was started with a token, because the agents it governs can reach localhost. On Linux, an agent started with effigentd run --strict doesn’t execute a single instruction before its kernel policy is confirmed live.',
  },
  {
    hue: '290',
    title: 'Every decision has an author',
    body: 'Machines join with an enrollment token and are bound to an owner. OS accounts map to people, so an event says alex.wang, not uid 501. Console roles separate admins, approvers, members and viewers. Approvals carry the reviewer’s identity and cover one action.',
  },
  {
    hue: '85',
    title: 'A tamper-evident audit trail',
    body: 'Each decision is recorded with the policy id and version, the rule, the endpoint, the user and, for approvals, who decided and when. The log is append-only and tamper-evident, and can be exported to your own SIEM. effigentd can also write every event as JSON lines to a local file.',
  },
  {
    hue: '200',
    title: 'Hosted, or run it yourself',
    body: 'The hosted control plane isolates every workspace: every record is scoped to a tenant and every query runs through that scope. Enterprise customers can run the control plane in their own infrastructure; effigentd behaves the same against either.',
  },
];

export default function SecurityPage() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Security & data"
        title="A security tool should be clear about its own limits."
        sub="Effigent sits on developer machines with root and sees what agents do there. Here is what it sends, where decisions are made, who can change them, and what it can’t protect against."
      />

      <DocSection>
        {PILLARS.map((p) => (
          <div key={p.title} style={{ display: 'flex', gap: 18, padding: '26px 0', borderBottom: '1px solid var(--line)' }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: `oklch(0.58 0.16 ${p.hue})`, marginTop: 7, flexShrink: 0 }} />
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 8px' }}>{p.title}</h2>
              <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.7, margin: 0, maxWidth: 720 }}>{p.body}</p>
            </div>
          </div>
        ))}
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>What one audit record looks like</h2>
        <p className="doc-p">A blocked exec from a script that an agent&apos;s tool call started. This is the whole record; there is no file content or prompt behind it.</p>
        <CodeBlock title="audit · one event">{`{
  "time": "2026-10-13T14:32:07Z",
  "node": "alex-mbp",
  "type": "blocked",
  "severity": "high",
  "agent": "claude-code",
  "agent_pid": 48211,
  "mode": "denylist",
  "kind": "tool",
  "process": { "pid": 48390, "binary": "/usr/bin/curl",
               "args": "https://paste.example.net", "cwd": "/home/alex/src/payments", "uid": 1000 },
  "target": "/usr/bin/curl",
  "rule": "Global policy › no-raw-http"
}`}</CodeBlock>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Questions we get asked</h2>
        {[
          ['Do you see our source code?', 'No. effigentd records file paths an agent opens, not their contents. It does not proxy model traffic, so prompts and completions never reach us.'],
          ['Command lines can contain secrets. What happens to them?', 'Arguments are sent because rules and the audit trail depend on them, the same way they land in shell history. Keep credentials in environment variables or files, not in arguments. The agent’s raw tool input is redacted on the machine before it leaves.'],
          ['What if the control plane is unreachable?', 'Nothing changes on the machine. The last policy keeps enforcing; events and approval requests queue and are sent when the connection comes back.'],
          ['Can an agent turn effigentd off?', 'Not through its API, which is read-only without a token, and not as the developer user. If the agent can run sudo, it can do what root can, so deny sudo in policy for agents that don’t need it. Anyone with root can stop the daemon; the missing heartbeat shows up in the console.'],
          ['Does it work on macOS?', 'Yes, with less enforcement. On macOS the OS layer observes, and blocking and approvals come from the agents’ hooks. The coverage matrix lists exactly what that means per action.'],
        ].map(([q, a]) => (
          <div key={q} style={{ padding: '18px 0', borderTop: '1px solid var(--line)' }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{q}</div>
            <div style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.65, maxWidth: 700 }}>{a}</div>
          </div>
        ))}
        <p className="doc-p" style={{ marginTop: 18 }}>
          More detail: <Link href="/docs/enforcement">Enforcement &amp; coverage</Link> · <Link href="/privacy">Privacy Policy</Link>
        </p>
      </DocSection>

      <Footer />
    </div>
  );
}
