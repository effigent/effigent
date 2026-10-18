import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection } from '../ui';
import { CONTACT_EMAIL } from '../config';

export const metadata: Metadata = {
  title: 'Privacy Policy — Effigent',
  description:
    'What Effigent collects and why: metadata about AI coding agents’ actions on enrolled machines, used only to enforce and audit your own policies. No file contents, no model prompts. Never sold, never used across tenants.',
};

const SECTIONS: Array<[string, string | string[]]> = [
  [
    'The short version',
    'effigentd records what AI coding agents do on machines you enroll (which programs they run, which files they open, which hosts they connect to, which MCP tools they call) so your team can enforce policy and keep an audit trail. It does not collect file contents or model prompts and responses. We do not sell data, we do not use one customer’s data for another customer, and we do not train models on your data.',
  ],
  [
    'What we collect',
    [
      'Agent activity metadata from enrolled endpoints: agent type and process ids, executed binaries with their arguments and working directory, file paths opened, destination hosts and ports, MCP server and tool names, the OS user, the machine name, and the policy decision with the rule that made it. The agent’s raw tool input is redacted on the machine before it is sent.',
      'Approval and audit records: who requested, who approved or denied, notes they added, and timestamps.',
      'Endpoint data: hostname, operating system, effigentd version, sensor type, policy version and heartbeat.',
      'Account data: your name and email address via our authentication provider (Clerk), used to sign you in, manage workspace membership and identify approvers.',
      'Operational data: standard service logs (request timestamps, status codes) needed to run and secure the service.',
    ],
  ],
  [
    'What we don’t collect',
    'File contents, source code, model prompts and completions, keystrokes, screen contents, and activity of processes that are not part of an AI agent’s process tree. effigentd tracks agent process trees, not everything the developer does.',
  ],
  [
    'Command lines',
    'Arguments are part of what a rule matches and what the audit trail must show, so they are collected as they appear. If a secret is passed as an argument, it will be in the record, the same way it would be in shell history. We recommend keeping credentials in environment variables or files.',
  ],
  [
    'What we use it for, and nothing else',
    'Data from your endpoints is used only to provide the service to your workspace: evaluating and enforcing your policies, routing approvals, showing the agent graph and events, and keeping your audit trail. It is never used to build cross-customer models, never shared between workspaces, and never sold or rented.',
  ],
  [
    'Your obligations to the people on those machines',
    'Your organisation decides which machines to enroll. Developers whose machines are enrolled should know that agent activity on them is recorded. Effigent is designed to record agent activity, not to monitor people, and the data it collects reflects that.',
  ],
  [
    'Tenant isolation',
    'Every record is bound to your workspace and every query is workspace-scoped; there is no cross-tenant read path. Enterprise customers can run the control plane in their own infrastructure, in which case endpoint data does not reach us at all.',
  ],
  [
    'Subprocessors',
    'We run on a small set of infrastructure providers who process data on our behalf, all in the United States: Amazon Web Services (control plane hosting, event archive, approval email and website delivery), Neon (database), Vercel (console hosting), Clerk (authentication), and Anthropic (the optional policy assistant, only when an admin uses it: the policy text and the request; not used for training). Each processes data only as needed to provide their service. The current list is on our Security page.',
  ],
  [
    'Retention & deletion',
    'Agent events are kept in the database for 90 days, then moved to an encrypted archive where they are locked for one year and then deleted. Console audit records, policies and approvals are kept for the life of the workspace. You may request deletion of an endpoint’s data or your entire workspace at any time, and we will remove it from live systems promptly; archived copies are deleted when their one-year lock ends.',
  ],
  [
    'Cookies',
    'We use only the cookies required for authentication and session management. No advertising or cross-site tracking cookies.',
  ],
  [
    'Changes & contact',
    `We will update this policy as the product evolves and note material changes on this page. Questions or deletion requests: ${CONTACT_EMAIL}.`,
  ],
];

export default function PrivacyPage() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Privacy Policy · v2.0 · October 2026"
        title="We record what agents do. Not what’s in your files."
        sub="Enforcing policy on coding agents means seeing what they run, open and connect to. This page lists exactly what that is, what we never collect, and the one thing we use it for: your own policies and audit trail."
      />
      <DocSection>
        {SECTIONS.map(([title, body]) => (
          <div key={title as string} style={{ padding: '22px 0', borderBottom: '1px solid var(--line)' }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 10px' }}>{title}</h2>
            {Array.isArray(body) ? (
              <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {body.map((b) => <li key={b.slice(0, 24)} style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.7 }}>{b}</li>)}
              </ul>
            ) : (
              <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.7, margin: 0, maxWidth: 720 }}>{body}</p>
            )}
          </div>
        ))}
        <p style={{ fontSize: 13.5, color: 'var(--ink-3)', marginTop: 22 }}>
          See also: <Link href="/security" style={{ textDecoration: 'underline' }}>Security</Link> · <Link href="/terms" style={{ textDecoration: 'underline' }}>Terms of Service</Link>
        </p>
      </DocSection>
      <Footer />
    </div>
  );
}
