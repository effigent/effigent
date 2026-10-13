import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection } from '../ui';
import { CONTACT_EMAIL } from '../config';

export const metadata: Metadata = {
  title: 'Terms of Service — Effigent',
  description: 'The terms that govern use of Effigent, the control plane for coding agents.',
};

const SECTIONS: Array<[string, string]> = [
  [
    '1. The service',
    'Effigent consists of effigentd, a daemon you install on machines you control, and a control plane (hosted by us, or self-hosted on Enterprise) where you manage policies, approvals, endpoints and the audit trail. effigentd observes AI coding agents on those machines and enforces the policies you set. The service is offered as an early-access product; features may change as it matures.',
  ],
  [
    '2. Your account & workspace',
    'You are responsible for the accuracy of your account information, for the security of your credentials, enrollment tokens and API tokens, and for the actions of users you invite to your workspace, including the approvals they grant. Rotate an enrollment token if it may have leaked.',
  ],
  [
    '3. Your data',
    'You retain all rights to the data your endpoints send. You grant us only the license needed to operate the service for you: storing and processing events, policies, approvals and audit records to provide features to your workspace. See the Privacy Policy for what is collected. We never sell your data or use it across customers.',
  ],
  [
    '4. Acceptable use',
    'Don’t attempt to access other workspaces’ data, probe or overload the service, or reverse-engineer other customers’ information. Install effigentd only on machines you are authorized to monitor, and tell the people who use those machines that agent activity on them is recorded, as your employment and privacy obligations require.',
  ],
  [
    '5. Plans & billing',
    'Free and paid plans are described on the pricing page. Paid plans are billed monthly or annually; annual plans are billed once and equal ten months of the monthly price. Plan limits (such as seats, endpoints and audit retention) are enforced by the service. We may adjust pricing with reasonable advance notice; changes never apply retroactively to an already-paid period.',
  ],
  [
    '6. Early-access disclaimer',
    'The service is provided “as is” during early access. Effigent reduces risk; it does not eliminate it. Coverage differs by operating system and agent, as described in the documentation, and no policy can stop actions taken by someone with administrative access to the machine. Test policies in monitor mode before enforcing them. We do not warrant uninterrupted availability or that the service will prevent every unwanted action.',
  ],
  [
    '7. Limitation of liability',
    'To the maximum extent permitted by law, our aggregate liability arising out of the service is limited to the amounts you paid us in the twelve months preceding the claim. We are not liable for indirect, incidental, or consequential damages, including damage caused by actions of your agents or by actions a policy blocked or delayed.',
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
        eyebrow="Terms of Service · v2.0 · October 2026"
        title="Plain terms for a security tool."
        sub="Effigent observes coding agents on your machines and enforces the policies you set. Your data stays yours, we use it only to serve your workspace, and the limits of an early-access product are stated plainly."
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
