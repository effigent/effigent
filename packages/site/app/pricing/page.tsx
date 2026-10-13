import type { Metadata } from 'next';
import { Nav, Footer, PageHero, DocSection } from '../ui';
import { PricingTable } from './table';

export const metadata: Metadata = {
  title: 'Pricing — Effigent',
  description:
    'Effigent pricing by seats and endpoints. Free for one developer, Starter for small teams, Pro for teams enforcing policy across machines, Enterprise with SSO and a self-hosted control plane.',
};

export default function PricingPage() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Pricing"
        title="Priced by people and machines."
        sub="You pay for the people who use Effigent and the machines it runs on. Not per agent, not per event, not per approval. Start free on your own laptop."
      />
      <div style={{ maxWidth: 1160, margin: '0 auto', padding: '10px 32px 70px' }}>
        <PricingTable />
      </div>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Pricing questions</h2>
        {[
          ['What counts as an endpoint?', 'One machine running effigentd: a laptop, a workstation, a VM or a CI runner. Agents on that machine are not counted separately; run as many as you like. If you use short-lived CI runners, tell us how you run them and we will count them in a way that makes sense.'],
          ['What counts as a seat?', 'A person: someone who signs in to the console (to write policy or approve) or who owns enrolled machines. One developer with a laptop and a dev VM is one seat and two endpoints.'],
          ['What happens when we go over a limit?', 'Enforcement never stops because of billing. New machines past the limit can’t enroll until you upgrade or remove one, and the console tells you before that happens.'],
          ['Can we run the control plane ourselves?', 'Yes, on Enterprise. effigentd works the same against the hosted or a self-hosted control plane.'],
          ['Can I switch between monthly and annual?', 'Any time. Annual is billed once and works out to two months free; switching mid-cycle prorates automatically.'],
        ].map(([q, a]) => (
          <div key={q} style={{ padding: '18px 0', borderTop: '1px solid var(--line)' }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{q}</div>
            <div style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.65, maxWidth: 700 }}>{a}</div>
          </div>
        ))}
      </DocSection>

      <Footer />
    </div>
  );
}
