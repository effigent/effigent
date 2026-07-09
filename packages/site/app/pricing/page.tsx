import type { Metadata } from 'next';
import { Nav, Footer, PageHero, DocSection } from '../ui';
import { PricingTable } from './table';

export const metadata: Metadata = {
  title: 'Pricing — Optimizer',
  description:
    'Start free with 2 agents. Starter at $15/month (5 agents, 20 GB), Pro at $80/month (20 agents, 100 GB), Enterprise with custom scale, SSO and self-hosted collector.',
};

export default function PricingPage() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Pricing"
        title="Pays for itself, by design."
        sub="Optimizer's job is to cut your agents' token bill — most teams save more in the first month than the subscription costs. Start free, upgrade when your fleet grows."
      />
      <div style={{ maxWidth: 1160, margin: '0 auto', padding: '10px 32px 70px' }}>
        <PricingTable />
      </div>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Pricing questions</h2>
        {[
          ['What counts as an agent?', 'A registered agent identity (one scoped capture key). Ten instances of the same agent in Kubernetes still count as one agent — identity, not replicas.'],
          ['What happens if I hit my storage limit?', 'New runs keep being accepted; the oldest raw transcripts are compacted first. You’ll see a banner in the dashboard well before anything is dropped.'],
          ['Can I switch between monthly and annual?', 'Any time. Annual is billed once and works out to two months free; switching mid-cycle prorates automatically.'],
          ['Do you charge for tokens or savings?', 'No. Flat subscription — we never take a percentage of your model spend or your savings.'],
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
