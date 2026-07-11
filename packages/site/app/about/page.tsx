import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection } from '../ui';
import { CONTACT_EMAIL } from '../config';

export const metadata: Metadata = {
  title: 'About — Effigent',
  description:
    'Effigent is the compiler for AI agents: parse every execution into a graph, run optimization passes, validate against history, execute the optimized result.',
};

const PRINCIPLES: Array<[string, string]> = [
  ['Standalone, always', 'Effigent never asks you to change agent code. Capture is a hook or an exporter; optimizations arrive as configuration the agent loads — and can be removed by deleting a folder.'],
  ['Validated before activated', 'Nothing activates on a hunch. Synthesized tools are replayed against the recorded history and must reproduce the agent’s actual behavior before they earn "ready".'],
  ['Private by default', 'Capture is opt-in per agent, secrets and PII are redacted before anything is stored, and capture keys are scoped, hashed, and least-privilege.'],
  ['Honest numbers', 'Savings are measured from per-step token usage, confidence is a statistical lower bound, and when a knowledge graph isn’t worth injecting, the engine says so.'],
];

export default function About() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="About"
        title="The compiler for AI agents."
        sub="Treat an AI agent as a program, not a sequence of prompts. Parse every execution into a universal graph, run compiler-like optimization passes, validate against history, and execute the optimized result."
      />

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Why this exists</h2>
        <div style={{ fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.75, maxWidth: 680 }}>
          <p style={{ margin: '0 0 12px' }}>
            Production agents re-derive the same answers run after run — the same repo exploration, the same lookups, the
            same reasoning over unchanged inputs. That waste is invisible in any single run and enormous across a fleet.
          </p>
          <p style={{ margin: 0 }}>
            Compilers solved this problem for programs decades ago: observe, find what&apos;s invariant, optimize, verify.
            Effigent applies the same discipline at the LLM/tool boundary — progressively converting repeated reasoning into
            deterministic execution, with every optimization validated against the agent&apos;s own history before it
            activates.
          </p>
        </div>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 16px' }}>Principles</h2>
        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {PRINCIPLES.map(([title, desc]) => (
            <div key={title} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '20px 22px', background: 'oklch(0.995 0.002 90)' }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 8 }}>{title}</div>
              <div style={{ fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>{desc}</div>
            </div>
          ))}
        </div>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Who builds it</h2>
        <p style={{ fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.75, maxWidth: 680, margin: 0 }}>
          Effigent is built by engineers who run production agents and got tired of paying them to think twice. The engine is
          dogfooded on our own agents daily — every feature you see shipped because our own runs demanded it. We work closely
          with a small group of design partners; if your agent fleet has a real bill,{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} style={{ fontWeight: 600, color: 'oklch(0.4 0.14 250)' }}>we want to hear about it</a>.
        </p>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Get in touch</h2>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <a href={`mailto:${CONTACT_EMAIL}`} className="btn btn-primary" style={{ padding: '12px 22px', fontSize: 14, display: 'inline-block' }}>Email us</a>
          <Link href="/developers" className="btn btn-ghost" style={{ padding: '12px 20px', fontSize: 14, display: 'inline-block' }}>Install it instead</Link>
        </div>
      </DocSection>
      <Footer />
    </div>
  );
}
