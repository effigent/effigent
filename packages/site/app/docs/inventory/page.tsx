import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection, CodeBlock, DocsPager, H2 } from '../../ui';

export const metadata: Metadata = {
  title: 'Inventory, reports & alerts — Effigent docs',
  description:
    'Which agents and MCP servers run on which machines and for whom, what an agent did for the first time, the posture report, alerts when hooks are removed or a machine goes quiet, and per-workspace retention with legal hold.',
};

const COVERAGE: Array<[string, string]> = [
  ['enforced', 'Policy applies: the agent’s hook is installed and reporting, the kernel layer covers it, or both.'],
  ['hooks off', 'The agent has a hook, but it was removed, switched off or disabled by the user on this machine.'],
  ['detection only', 'Seen and attributed, with no hook to enforce through and no kernel layer on that machine.'],
  ['unmanaged', 'Runs where policy can’t reach, such as an agent in its own VM. Shown as not under policy.'],
];

const HEALTH: Array<[string, string, string]> = [
  ['Hook missing or switched off', 'endpoint.hooks_missing', 'A hook file removed or edited, the hook set to not block on failure, a user disabling it, or the effigentd binary it calls gone. Reported within about a minute.'],
  ['Offline', 'endpoint.offline', 'No heartbeat for longer than the workspace’s threshold (default 5 minutes, from 2 minutes to 7 days). Says whether effigentd was stopped or the machine went silent.'],
  ['Back online', 'endpoint.online', 'The first heartbeat after an outage. Recorded, never emailed: laptops sleep.'],
  ['Stopped', 'daemon_stop', 'effigentd stopped by a signal, systemd, launchd or the Windows service manager, with how it was run.'],
  ['Unclean restart', 'daemon_unclean_restart', 'effigentd started and found it hadn’t shut down cleanly: kill -9, a crash or power loss.'],
];

export default function Inventory() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Docs · Visibility"
        title="Know what runs, and notice when that changes."
        sub="An inventory of every agent and MCP server across your machines, the things an agent does for the first time, a posture report for the period, and an alert when a machine stops being covered."
      />

      <DocSection>
        <H2>Inventory</H2>
        <p className="doc-p">Monitor → Inventory has three tabs, for any window from a day to a year:</p>
        <ul className="doc-list">
          <li><b>Agents.</b> Every agent on every machine, with when it was first and last seen, its mode, and its coverage.</li>
          <li><b>MCP servers.</b> Each server with the tools called on it, the agents, machines and people using it, and whether it is in the policy&apos;s <code>mcp_allow</code>.</li>
          <li><b>People.</b> People who hold a seat or show usage at an AI vendor (from <Link href="/docs/pricing-leaks">Pricing Leaks</Link>) but have no managed machine running agents: AI use outside your fleet.</li>
        </ul>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>Coverage</th><th>Meaning</th></tr></thead>
            <tbody>{COVERAGE.map(([s, d]) => <tr key={s}><td style={{ whiteSpace: 'nowrap' }}><code>{s}</code></td><td>{d}</td></tr>)}</tbody>
          </table>
        </div>
      </DocSection>

      <DocSection>
        <H2>New behaviour</H2>
        <p className="doc-p">
          For each agent on each machine, Effigent keeps a baseline of what it has done: the programs it ran, the hosts it reached, the MCP servers it called and the kinds of action it took, including the environment (<code>cloud_change@prod</code>). A value it has never seen, or hasn&apos;t seen for 30 days, shows up in Monitor → New behaviour and goes to the webhooks subscribed to <code>anomaly.first_seen</code>.
        </p>
        <CodeBlock title="anomaly.first_seen">{`agent     claude-code
machine   alex-mbp · alex.wang
kind      host
value     paste.example.net
first     2026-10-22 09:14 UTC · Bash: curl -s https://paste.example.net …`}</CodeBlock>
        <ul className="doc-list" style={{ marginTop: 14 }}>
          <li><b>Warm-up.</b> An agent new to a machine learns quietly for its first 7 days.</li>
          <li><b>What it says.</b> A signal says the agent did something new on that machine. Use it to review, to tighten an allowlist, or to start a SIEM workflow.</li>
          <li><b>Bounded.</b> At most 50 signals per agent and machine per day; the rest are counted.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2>Posture report</H2>
        <p className="doc-p">
          Monitor → Posture report covers the last 7, 30 or 90 days in one printable page:
        </p>
        <ul className="doc-list">
          <li>Machines: enrolled, new, active, online now, and hook problems.</li>
          <li>Agents in use, by person and by team.</li>
          <li>Enforcement: blocks and would-blocks per kind of rule, per day.</li>
          <li>Approvals: requested, approved, denied, expired, the median time to decide, and refused self-approvals.</li>
          <li>Policy: versions published, proposals by state, and the exceptions in force.</li>
          <li>New behaviour counts and the Pricing Leaks totals.</li>
        </ul>
        <p className="doc-p">
          Schedule it weekly (Mondays, the last 7 days) or monthly (the 1st, the last 30 days) to up to 20 addresses, or send it now. The email carries the headline numbers and a link to the full report.
        </p>
      </DocSection>

      <DocSection>
        <H2>Machine health alerts</H2>
        <p className="doc-p">
          effigentd reports the state of every agent hook on its machine, and the control plane watches for machines that stop reporting. Each alert goes to webhooks, to the audit trail and, if you choose, by email.
        </p>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>Alert</th><th>Event</th><th>When</th></tr></thead>
            <tbody>{HEALTH.map(([a, e, d]) => <tr key={a}><td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{a}</td><td><code>{e}</code></td><td>{d}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="doc-p" style={{ marginTop: 14 }}>
          Machines in Enforcement show each agent&apos;s hook state, whether the machine is offline, and whether it was stopped or went silent. Set the offline threshold and the emails in the Machine health alerts card.
        </p>
      </DocSection>

      <DocSection>
        <H2>Retention and legal hold</H2>
        <ul className="doc-list">
          <li><b>Per workspace.</b> Keep agent events live for 90 days up to 10 years. Older days are archived to S3, one compressed file per day, before they are deleted.</li>
          <li><b>Legal hold.</b> Turn it on with a reason. Nothing is deleted or archived away while it holds, the database refuses deletes, and every archived file is placed under an S3 Object Lock legal hold.</li>
          <li><b>Recorded.</b> Every change to retention or the hold is in the audit trail, with who made it and why.</li>
        </ul>
      </DocSection>

      <DocsPager current="/docs/inventory" />
      <Footer />
    </div>
  );
}
