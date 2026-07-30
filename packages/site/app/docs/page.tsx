import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection } from '../ui';

export const metadata: Metadata = {
  title: 'Documentation — Effigent',
  description:
    'Everything you need to run Effigent: quickstart, capture paths, the determinism engine, synthesized tools and the knowledge graph, redaction, and the machine API.',
};

const SECTIONS = [
  ['Quickstart', '/docs/quickstart', 'From zero to optimized agent in three commands.'],
  ['Capture', '/docs/capture', 'The two capture paths — transcript hook and OpenTelemetry — and exactly what each records.'],
  ['Insights & the engine', '/docs/insights', 'How runs become graphs, how determinism is scored, and what each action means.'],
  ['Tools & knowledge graph', '/docs/tools', 'Synthesized tools, replay validation, the knowledge graph, and injecting them with effigent optimize.'],
  ['Privacy & redaction', '/docs/redaction', 'Built-in filters, workspace rules, and what is (and is not) stored.'],
  ['Run storage', '/docs/storage', 'Effigent-managed storage, or a bucket in your own AWS account — one CloudFormation command.'],
  ['Machine API', '/docs/api', 'The collector endpoints the CLI and your agents talk to.'],
] as const;

export default function DocsIndex() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Documentation"
        title="Run Effigent with your eyes open."
        sub="Short, honest pages: what gets captured, how the engine decides, and how optimizations reach your running agents. For the guided per-harness install, see the developer guide."
      />
      <DocSection>
        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {SECTIONS.map(([title, href, desc]) => (
            <Link key={href} href={href} className="tier-mini" style={{ display: 'block', border: '1px solid var(--line)', borderRadius: 12, padding: '20px 22px', background: 'oklch(0.995 0.002 90)' }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{title}</div>
              <div style={{ fontSize: 13.5, color: 'var(--ink-3)', lineHeight: 1.55 }}>{desc}</div>
            </Link>
          ))}
        </div>
        <div style={{ marginTop: 22, fontSize: 14, color: 'var(--ink-2)' }}>
          Prefer a walkthrough? The <Link href="/developers" style={{ fontWeight: 600, color: 'oklch(0.4 0.14 250)' }}>developer guide</Link> covers
          every harness step by step.
        </div>
      </DocSection>
      <Footer />
    </div>
  );
}
