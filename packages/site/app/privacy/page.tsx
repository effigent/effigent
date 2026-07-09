import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection } from '../ui';
import { CONTACT_EMAIL } from '../config';

export const metadata: Metadata = {
  title: 'Privacy Policy — Effigent',
  description:
    'What Effigent collects and why: agent execution data only, personal data redacted before storage, used solely to analyze and optimize your own agents. Never sold, never used across tenants.',
};

const SECTIONS: Array<[string, string | string[]]> = [
  [
    'The short version',
    'Effigent captures how your AI agents execute — model turns, tool calls, token usage, cost — in order to analyze and optimize those same agents for your workspace. Personal and sensitive data is removed before anything is stored. We do not sell data, we do not use one customer’s data for another customer, and we do not train models on your content.',
  ],
  [
    'What we collect',
    [
      'Agent execution data: the structure and content of agent runs your capture keys upload — model turns, tool inputs/outputs, token usage, model names, timing, and computed cost. This is the product; it exists so we can show you your runs and find optimizations.',
      'Account data: your email address and name via our authentication provider (Clerk), used to sign you in and manage workspace membership.',
      'Operational data: standard service logs (request timestamps, status codes) needed to run and secure the service.',
    ],
  ],
  [
    'Personal data is removed before storage',
    'Every captured payload passes through an automated redaction layer at the single point of ingestion — before it is stored, indexed, or analyzed. Removed and replaced with typed placeholders: API keys and platform credentials, cloud access keys, bearer tokens and JWTs, database connection strings, private-key material, email addresses, and card-like numbers. We designed the pipeline so that personal data inside agent payloads is not retained.',
  ],
  [
    'What we use it for — and nothing else',
    'Captured execution data is used exclusively to provide the service to the workspace that uploaded it: rendering your runs, computing costs, and generating optimization recommendations (caching, deterministic replacement, model routing) for your own agents. It is never used to build cross-customer models, never shared between workspaces, and never sold or rented to anyone.',
  ],
  [
    'Tenant isolation',
    'Every record is bound to your workspace. Queries are workspace-scoped end to end; there is no cross-tenant read path. Capture keys are write-only, scoped to a single agent, and stored as one-way hashes.',
  ],
  [
    'Subprocessors',
    'We run on a small set of infrastructure providers who process data on our behalf: Vercel (application hosting), Neon (database), Clerk (authentication), and Amazon Web Services / CloudFront (website delivery). Each processes data only as needed to provide their service.',
  ],
  [
    'Retention & deletion',
    'Execution data is retained while your workspace is active so the optimization engine can learn from history. You may request deletion of any agent’s data or your entire workspace at any time, and we will remove it from live systems promptly.',
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
        eyebrow="Privacy Policy · v1.0 · July 2026"
        title="Your agents’ data works for you. Only for you."
        sub="Effigent exists to make your agents cheaper and faster. That requires seeing how they run — so the pipeline removes personal data before storage and uses what remains for exactly one purpose: optimizing your own agents."
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
