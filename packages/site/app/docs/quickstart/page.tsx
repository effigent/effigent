import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection, CodeBlock, DocsPager, H2 } from '../../ui';
import { API_URL, DASHBOARD_URL } from '../../config';

export const metadata: Metadata = {
  title: 'Quickstart — Effigent docs',
  description: 'Install effigentd on a Linux or macOS machine, enroll it with your workspace, and see your first coding-agent session in monitor mode.',
};

export default function Quickstart() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Docs · Quickstart"
        title="Enroll one machine, watch one session."
        sub="Install effigentd, enroll the machine with your workspace, run a coding agent as you normally would, and look at what it did. Nothing in the agent changes."
      />

      <DocSection>
        <H2>Before you start</H2>
        <ul className="doc-list">
          <li><b>Linux</b> for kernel enforcement. effigentd uses eBPF through Tetragon to block exec and file opens per agent process.</li>
          <li><b>macOS</b> works too. The OS layer observes (Endpoint Security); blocking and approvals come from the agent hooks. See <Link href="/docs/enforcement">coverage</Link> for exactly what that means.</li>
          <li>Root (<code>sudo</code>) to install the daemon.</li>
          <li>Outbound HTTPS from the machine to <code>{API_URL}</code>. effigentd uses it to fetch policy and send events.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2 n={1}>Get an enrollment token</H2>
        <p className="doc-p">
          In the <a href={DASHBOARD_URL}>console</a>, open <b>Settings → Endpoint enrollment</b>. The token ties the machine to your workspace; the person who enrolls it becomes the machine&apos;s owner. Rotate the token if it leaks. Machines that are already enrolled keep working.
        </p>
      </DocSection>

      <DocSection>
        <H2 n={2}>Install effigentd and enroll</H2>
        <p className="doc-p">
          Copy the install line from <b>Enforcement → Install on an endpoint</b> in the console; it already has the right install URL. It looks like this:
        </p>
        <CodeBlock title="sh — on the developer machine">{`curl -fsSL <install-url> | sudo sh -s -- --enroll <enrollment-token>`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          effigentd starts as a system service, downloads your workspace&apos;s policy, scans running processes for agents that are already up, and installs the pre-tool hooks for agents that support them (Claude Code, Cursor).
        </p>
      </DocSection>

      <DocSection>
        <H2 n={3}>Check it</H2>
        <CodeBlock title="sh — verify">{`effigentd status                      # sensor, policy version, tracked agents

# the local API answers on 127.0.0.1:7777
curl -s 127.0.0.1:7777/health
{ "ok": true, "agents": 1 }

curl -s 127.0.0.1:7777/agents          # each tracked agent and its loaded kernel policy`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          The machine shows up under <b>Enforcement</b> with its sensor (Tetragon on Linux, Endpoint Security on macOS), its effigentd version and the policy version it has.
        </p>
      </DocSection>

      <DocSection>
        <H2 n={4}>Run an agent, then look</H2>
        <p className="doc-p">
          Use Claude Code, Cursor or Codex the way you normally do. The <b>Agent graph</b> fills in with the agent, the processes it started, the MCP servers under it, and the files, repos and hosts it touched. <b>Events</b> lists every exec, file open and connection with the rule that decided it.
        </p>
        <p className="doc-p">
          Start in <code>monitor</code> mode. Nothing is blocked; anything a rule would have stopped is reported as <code>would_block</code>. Run it for a few days and read those events before you enforce.
        </p>
        <CodeBlock title="what monitor mode reports">{`14:21  would_block  codex        exec /usr/bin/wget https://…   rule: Global › no-raw-http
14:18  observed     claude-code  file ~/src/payments/.env       rule: file_alert`}</CodeBlock>
      </DocSection>

      <DocSection>
        <H2 n={5}>Turn on a rule</H2>
        <p className="doc-p">
          Pick one rule you are sure about, for example <i>force-pushes need a lead&apos;s approval</i>, scope it to one team, and switch that policy from monitor to enforcing. Every enrolled machine in scope picks up the new version. How rules are written and evaluated is in <Link href="/docs/policies">Policies</Link>; what happens when one pauses an action is in <Link href="/docs/approvals">Approvals</Link>.
        </p>
      </DocSection>

      <DocsPager current="/docs/quickstart" />
      <Footer />
    </div>
  );
}
