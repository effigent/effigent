import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection } from '../ui';
import { CONTACT_EMAIL } from '../config';

export const metadata: Metadata = {
  title: 'Terms of Service — Effigent',
  description: 'The terms that govern use of Effigent — the runtime optimization layer for AI agents.',
};

const SECTIONS: Array<[string, string]> = [
  [
    '1. The service',
    'Effigent captures your AI agents’ execution data (via the effigent CLI, hooks, or OpenTelemetry), analyzes it, and produces optimization insights and tooling intended to reduce your agents’ cost and latency. The service is currently offered as an early-access product; features may change as it matures.',
  ],
  [
    '2. Your account & workspace',
    'You are responsible for the accuracy of your account information, for the security of your credentials, and for the capture keys minted in your workspace. Keys are shown once and stored hashed; treat them as secrets. You are responsible for the actions of users you invite to your workspace.',
  ],
  [
    '3. Your data',
    'You retain all rights to the data your agents upload. You grant us only the license needed to operate the service for you: storing, processing, and analyzing that data to provide features to your workspace. We remove personal and sensitive data before storage and use captured context solely to improve your own agents and reduce your costs — see the Privacy Policy. We never sell your data or use it across customers.',
  ],
  [
    '4. Acceptable use',
    'Don’t attempt to access other workspaces’ data, probe or overload the service, reverse-engineer other customers’ information, upload content you have no right to process, or use the service to build a directly competing data set. Capture only agents and systems you are authorized to observe.',
  ],
  [
    '5. Plans & billing',
    'Free and paid plans are described on the pricing page. Paid plans are billed monthly or annually; annual plans are billed once and equal ten months of the monthly price. Plan limits (such as number of agents and stored data) are enforced by the service. We may adjust pricing with reasonable advance notice; changes never apply retroactively to an already-paid period.',
  ],
  [
    '6. Early-access disclaimer',
    'The service is provided “as is” during early access. We work hard to keep it reliable and accurate, but we do not warrant uninterrupted availability or that every optimization recommendation is correct for your context — validate changes to production agents before enforcing them.',
  ],
  [
    '7. Limitation of liability',
    'To the maximum extent permitted by law, our aggregate liability arising out of the service is limited to the amounts you paid us in the twelve months preceding the claim. We are not liable for indirect, incidental, or consequential damages, including costs incurred by your agents or model providers.',
  ],
  [
    '8. Termination',
    'You may stop using the service and request deletion of your workspace at any time. We may suspend or terminate accounts that materially breach these terms, with notice where practicable. Sections that by their nature should survive (your data rights, liability limits) survive termination.',
  ],
  [
    '9. Changes to these terms',
    'We may update these terms as the product evolves. Material changes will be announced on this page with an updated version and date; continued use after the effective date constitutes acceptance.',
  ],
  [
    '10. Contact',
    `Questions about these terms: ${CONTACT_EMAIL}.`,
  ],
];

export default function TermsPage() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Terms of Service · v1.0 · July 2026"
        title="Plain terms for a focused tool."
        sub="Effigent does one job — observe your agents and make them cheaper. These terms keep that relationship simple: your data stays yours, we use it only to serve your workspace, and the limits of an early-access product are stated plainly."
      />
      <DocSection>
        {SECTIONS.map(([title, body]) => (
          <div key={title} style={{ padding: '20px 0', borderBottom: '1px solid var(--line)' }}>
            <h2 style={{ fontSize: 17, fontWeight: 700, margin: '0 0 8px' }}>{title}</h2>
            <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.7, margin: 0, maxWidth: 720 }}>{body}</p>
          </div>
        ))}
        <p style={{ fontSize: 13.5, color: 'var(--ink-3)', marginTop: 22 }}>
          See also: <Link href="/privacy" style={{ textDecoration: 'underline' }}>Privacy Policy</Link> · <Link href="/security" style={{ textDecoration: 'underline' }}>Security</Link>
        </p>
      </DocSection>
      <Footer />
    </div>
  );
}
