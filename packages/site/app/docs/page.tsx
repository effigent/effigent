import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection, DOCS } from '../ui';

export const metadata: Metadata = {
  title: 'Documentation — Effigent',
  description:
    'Run Effigent: install effigentd and enroll a machine, write policies, route approvals, understand per-OS enforcement coverage, and use the local API.',
};

export default function DocsIndex() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Documentation"
        title="How Effigent decides, and where it can’t."
        sub="Short pages: how to put effigentd on a machine, how a policy turns into a decision, what an approval covers, and exactly which actions each OS can block, pause or only observe."
      />
      <DocSection>
        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {DOCS.map(([title, href, desc]) => (
            <Link key={href} href={href} className="tier-mini" style={{ display: 'block', border: '1px solid var(--line)', borderRadius: 12, padding: '20px 22px', background: 'oklch(0.995 0.002 90)' }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{title}</div>
              <div style={{ fontSize: 13.5, color: 'var(--ink-3)', lineHeight: 1.55 }}>{desc}</div>
            </Link>
          ))}
          <Link href="/developers" className="tier-mini" style={{ display: 'block', border: '1px dashed var(--line-2)', borderRadius: 12, padding: '20px 22px' }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Agent setup guide</div>
            <div style={{ fontSize: 13.5, color: 'var(--ink-3)', lineHeight: 1.55 }}>Per agent: how effigentd recognises Claude Code, Cursor, Codex and the rest, and which hooks it uses.</div>
          </Link>
        </div>
      </DocSection>
      <Footer />
    </div>
  );
}
