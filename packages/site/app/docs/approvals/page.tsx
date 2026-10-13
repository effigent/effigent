import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection, CodeBlock, DocsPager, H2 } from '../../ui';

export const metadata: Metadata = {
  title: 'Approvals — Effigent docs',
  description: 'How require-approval rules pause a coding agent’s action, who can approve it, and why an approval is single-use and bound to the exact command and target.',
};

const STATES: Array<[string, string]> = [
  ['paused', 'A require_approval rule matched. The hook holds the tool call; the agent waits.'],
  ['approval_pending', 'The request is in the console inbox of the reviewers the rule names.'],
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
        sub="A require_approval rule pauses the agent and asks a named person. The answer covers that exact command, on that machine, in that session. Nothing else."
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
        <p className="doc-p">The rule&apos;s <code>approval</code> block names reviewers and a time limit:</p>
        <CodeBlock title="rule · approval">{`"approval": {
  "users": ["maya.cohen"],
  "teams": ["payments-leads"],
  "roles": ["approver"],
  "resource_owner": true,     // e.g. the owner of the endpoint the action runs on
  "fallback": "admins",       // used when none of the above resolves to a person
  "ttl_seconds": 900
}`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          A rule with <code>require_approval</code> and no approval block is rejected when you save it. There is no anonymous approve button: every decision carries a console identity.
        </p>
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
        <H2>Limits worth knowing</H2>
        <ul className="doc-list">
          <li>Pausing needs a hook. Claude Code (PreToolUse) and Cursor (beforeShellExecution) have one. For agents without hooks, a <code>require_approval</code> rule is reported as observe-only on that endpoint. See <Link href="/docs/enforcement">coverage</Link>.</li>
          <li>The hook sees the agent&apos;s own tool call, not what a script started by that call does later. Child processes are the kernel&apos;s job, and the kernel can block, not pause.</li>
          <li>If the machine is offline, the request queues until it reconnects. The action stays paused and still expires on time.</li>
        </ul>
      </DocSection>

      <DocsPager current="/docs/approvals" />
      <Footer />
    </div>
  );
}
