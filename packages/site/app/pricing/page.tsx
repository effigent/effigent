import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection } from '../ui';
import { PricingTable } from './table';

export const metadata: Metadata = {
  title: 'Pricing — Effigent',
  description:
    'Effigent pricing by seats and endpoints. Free for one developer, Starter for small teams, Pro for teams enforcing policy across machines with Pricing Leaks to cut wasted AI spend, Enterprise with SSO and a self-hosted control plane.',
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
        <div style={{ border: '1px solid oklch(0.85 0.06 150)', background: 'oklch(0.97 0.03 150)', borderRadius: 14, padding: '24px 26px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap' }}>
          <div style={{ maxWidth: 560 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'oklch(0.42 0.13 150)', fontWeight: 650, marginBottom: 6 }}>Pricing Leaks</div>
            <div style={{ fontSize: 18, fontWeight: 720, marginBottom: 6, color: 'oklch(0.3 0.08 150)' }}>Effigent can pay for itself.</div>
            <div style={{ fontSize: 14, color: 'oklch(0.35 0.05 150)', lineHeight: 1.6 }}>
              Connect the admin and billing APIs of Cursor, Anthropic (Claude Code), GitHub Copilot and OpenAI. Effigent joins seats, usage and cost with what actually runs on each machine and flags unused seats, duplicate tools, shadow spend and runaway agent costs, each with an estimated monthly saving.
            </div>
          </div>
          <Link href="/#pricing-leaks" className="btn btn-primary" style={{ padding: '11px 20px', fontSize: 14, display: 'inline-block', whiteSpace: 'nowrap' }}>See how it works</Link>
        </div>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Pricing questions</h2>
        {[
          ['What counts as an endpoint?', 'One machine running effigentd: a laptop, a workstation, a VM or a CI runner. Agents on that machine are not counted separately; run as many as you like. If you use short-lived CI runners, tell us how you run them and we will count them in a way that makes sense.'],
          ['What counts as a seat?', 'A person: someone who signs in to the console (to write policy or approve) or who owns enrolled machines. One developer with a laptop and a dev VM is one seat and two endpoints.'],
          ['What happens when we go over a limit?', 'Enforcement never stops because of billing. New machines past the limit can’t enroll until you upgrade or remove one, and the console tells you before that happens.'],
          ['What is Pricing Leaks?', 'A report that joins what you pay AI coding tool vendors (seats, usage and cost from their admin APIs) with what effigentd sees running on each machine. It lists unused seats, developers paying for several agents but using one, agents running outside your organisation’s accounts, and agents far above the team median, each with an estimated monthly saving.'],
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
