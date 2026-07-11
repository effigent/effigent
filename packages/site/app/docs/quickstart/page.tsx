import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection, CodeBlock, StepBadge } from '../../ui';
import { COLLECTOR_URL } from '../../config';

export const metadata: Metadata = {
  title: 'Quickstart — Effigent docs',
  description: 'Install Effigent, capture your first runs, and inject the first optimization bundle — in three commands.',
};

export default function Quickstart() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Docs · Quickstart"
        title="Three commands to an optimized agent."
        sub="Register the agent, wire capture, let history accumulate — then inject the validated bundle. Nothing in your agent's code changes at any point."
      />

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 6px', display: 'flex', alignItems: 'center' }}><StepBadge n={1} />Install & register</h2>
        <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.65, margin: '10px 0 14px' }}>
          The workspace key comes from the dashboard; each agent gets its own least-privilege capture key.
        </p>
        <CodeBlock title="zsh — once per workspace / agent">{`npm i -g effigent
effigent login --key <workspace-key>
effigent agent add billing-agent`}</CodeBlock>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 6px', display: 'flex', alignItems: 'center' }}><StepBadge n={2} />Wire capture</h2>
        <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.65, margin: '10px 0 14px' }}>
          Claude Code gets an event-driven session hook; SDK agents and Codex export OpenTelemetry. Details per harness in{' '}
          <Link href="/docs/capture" style={{ fontWeight: 600, color: 'oklch(0.4 0.14 250)' }}>Capture</Link>.
        </p>
        <CodeBlock title="zsh — pick your harness">{`# Claude Code (hook — zero polling):
effigent install claude --agent billing-agent

# Python / Node / Codex (OpenTelemetry) — prints a ready-to-paste block:
effigent install otel --agent billing-agent --harness python`}</CodeBlock>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 6px', display: 'flex', alignItems: 'center' }}><StepBadge n={3} />Let it learn, then inject</h2>
        <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.65, margin: '10px 0 14px' }}>
          After ~10 runs the Insights view shows what is deterministic. When tools validate and the knowledge graph clears its
          coverage bar, install the bundle into the running agent:
        </p>
        <CodeBlock title="zsh — the injection">{`effigent optimize billing-agent

# ✓ bundle written: ~/.effigent/bundles/billing-agent/bundle.json
#   2 validated tool(s) · 7 knowledge fact(s) covering 64% of exploration
# ✓ Claude Code skill installed: ~/.claude/skills/effigent-billing-agent`}</CodeBlock>
        <p style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.65, marginTop: 14 }}>
          The agent now reads known facts instead of re-exploring, and follows replay-validated recipes for its recurring
          procedures. How that bundle is built — and why it can be trusted — is in{' '}
          <Link href="/docs/tools" style={{ fontWeight: 600, color: 'oklch(0.4 0.14 250)' }}>Tools &amp; knowledge graph</Link>.
        </p>
      </DocSection>
      <Footer />
    </div>
  );
}
