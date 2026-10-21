import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection, CodeBlock, DocsPager, H2 } from '../../ui';

export const metadata: Metadata = {
  title: 'Approvals — Effigent docs',
  description: 'How require-approval rules pause a coding agent’s action, how requests are routed to approver groups, two-person approval, keeping requesters from approving themselves, tickets, approval of policy changes, and why an approval is single-use and bound to the exact command and target.',
};

const STATES: Array<[string, string]> = [
  ['paused', 'A require_approval rule matched. The hook holds the tool call; the agent waits.'],
  ['approval_pending', 'The request reaches the approver group it was routed to: in Slack, by email and in the console. With two approvals required, it stays pending after the first yes.'],
  ['approved / approval_denied', 'A reviewer decided, with an optional note. Both are recorded with their name.'],
  ['expired', 'Nobody decided within the rule’s TTL. The action does not run.'],
  ['cancelled', 'The session ended or was suspended while the request was open.'],
  ['revalidated / revalidation_failed', 'Before resuming, effigentd checks the fingerprint still matches and the current policy still allows an approval.'],
  ['resumed → completed / failed', 'The action ran once. Its outcome is recorded against the approval.'],
];

export default function Approvals() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Docs · Approvals"
        title="One approval, one action."
        sub="A require_approval rule pauses the agent and asks the right people: one approver or two, never the person who asked. The answer covers that exact command, on that machine, in that session. Nothing else."
      />

      <DocSection>
        <H2>What the reviewer sees</H2>
        <CodeBlock title="console · Approvals">{`Claude Code wants to run
$ git push --force origin main

who        alex.wang (OS user alex)
where      alex-mbp · ~/src/payments
session    claude-code · 7f3a9c
rule       Production guardrails › force-push · v42
reviewers  payments-leads        expires in 14:52
fp1:9c3e41d2…b07a

[ Deny ]   [ Approve once ]`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          Meanwhile the developer&apos;s terminal shows the tool call as paused, with the rule and who it is waiting for. If the reviewer denies, the agent gets the reason back as the tool result and can choose another way.
        </p>
      </DocSection>

      <DocSection>
        <H2>What an approval is bound to</H2>
        <p className="doc-p">
          Every action gets a fingerprint: a SHA-256 over who and where (workspace, endpoint, session, agent type, user) and every field a rule can match (class, tool, command, binary, paths, host, port, URL, MCP server and tool, working directory). The approval is stored against that fingerprint.
        </p>
        <ul className="doc-list">
          <li><b>Single-use.</b> It resumes the paused call once. The next identical command asks again.</li>
          <li><b>Exact.</b> <code>git push --force origin main</code> approved does not cover <code>git push --force origin release</code>, the same command in another repo, or the same command in another session.</li>
          <li><b>Secrets stay out.</b> The agent&apos;s raw tool input is redacted on the endpoint and shown for context only; it is never part of matching. A token in a command still changes the fingerprint without being stored.</li>
          <li><b>Re-checked.</b> If the policy changed while the request waited, the approval is revalidated against the new version, or fails.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2>Who can approve</H2>
        <p className="doc-p">
          Requests are routed to <b>approver groups</b>, set up in the console under Team &amp; Approvers. A group is a list of people from your workspace. Routing rules send each request to one group, by:
        </p>
        <ul className="doc-list">
          <li><b>Kind of action:</b> a command, a website, an agent or MCP tool, or a file.</li>
          <li><b>Text patterns</b> over the request, such as <code>*terraform*</code> or <code>*aws*prod*</code>.</li>
          <li><b>Machines</b> and <b>agents</b>.</li>
        </ul>
        <p className="doc-p">
          The first matching rule wins, then the default group, then the workspace admins. Only that group&apos;s members are notified, and they can decide whatever their console role. Admins and security admins can step in on any request, and the record says so. A test panel shows where a sample request would go and who could approve it.
        </p>
        <p className="doc-p">
          There is no anonymous approve button: every decision carries a console identity, an identity checked in Slack, or a signed link sent to one email address.
        </p>
      </DocSection>

      <DocSection>
        <H2>Two people, never yourself, with a ticket</H2>
        <p className="doc-p">Each routing rule, and the default, can ask for more than one yes:</p>
        <ul className="doc-list">
          <li>
            <b>Two-person approval.</b> With <code>approvals_required: 2</code> the action runs only after two different people approve it. Any single deny ends the request. Votes from the same person (the same user, or a shared email) count once. An admin override counts as one vote, never a bypass. The agent keeps waiting until the second approval arrives.
          </li>
          <li>
            <b>Not the requester.</b> <code>exclude_requester</code> is on by default. The person the agent works for can&apos;t approve their own request, and neither can an admin. Effigent works out who that is from:
            <ul>
              <li>the machine&apos;s owner</li>
              <li>the OS user and git emails mapped to people in your workspace</li>
              <li>the git emails that user committed with on that machine</li>
            </ul>
            A refused attempt is written to the audit trail.
          </li>
          <li>
            <b>Ticket required.</b> With <code>require_ticket</code>, approving needs a Jira key such as <code>OPS-1234</code> or an https link. The ticket is stored with the vote and linked through your workspace&apos;s ticket URL template.
          </li>
        </ul>
        <p className="doc-p">The routing page warns when a group is too small for its own rule, for example two approvals needed from a group of two that includes the requester.</p>
      </DocSection>

      <DocSection>
        <H2>Lifecycle</H2>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>State</th><th>Meaning</th></tr></thead>
            <tbody>{STATES.map(([s, d]) => <tr key={s}><td style={{ whiteSpace: 'nowrap' }}><code>{s}</code></td><td>{d}</td></tr>)}</tbody>
          </table>
        </div>
      </DocSection>

      <DocSection>
        <H2>Approving changes to the policy itself</H2>
        <p className="doc-p">
          Turn on <b>policy change approval</b> in the console and every change that would publish a new policy version becomes a proposal:
        </p>
        <ul className="doc-list">
          <li>a policy edit</li>
          <li>adding or removing an exception</li>
          <li>changing a machine&apos;s owner or teams</li>
        </ul>
        <p className="doc-p">
          The change is validated and test-compiled when it is proposed. It is applied only when a different admin or security admin approves it.
        </p>
        <ul className="doc-list">
          <li>The author can&apos;t approve their own proposal. For a proposal made with an API key, the person who created the key can&apos;t approve it either.</li>
          <li>A proposal written against an older version is superseded, so nobody approves a diff that no longer applies.</li>
          <li>Turning the setting off is itself a proposal.</li>
          <li>Every proposal, approval, rejection and refusal is in the audit trail. New proposals are emailed to your notification addresses and sent to webhook <code>policy.proposed</code>.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2>Where approvals run</H2>
        <ul className="doc-list">
          <li>Approvals run in the agent hooks of Claude Code, Codex, Gemini CLI and Cursor, in Kubernetes pods through the hook socket, and in cloud agents through their cloud environment. The agent waits in its own session while the reviewer decides in Slack, by email or in the console.</li>
          <li>The kernel layer treats approval lists as deny lists for everything the agent starts on its own, so a script can&apos;t run what the agent itself would need approval for. See <Link href="/docs/enforcement">Enforcement</Link>.</li>
          <li>If the control plane can&apos;t be reached, a paused action is denied, never silently allowed. The agent gets a message telling it what to do instead.</li>
        </ul>
      </DocSection>

      <DocsPager current="/docs/approvals" />
      <Footer />
    </div>
  );
}
