import type { Metadata } from 'next';
import { Nav, Footer, CodeBlock, PageHero, DocSection } from '../ui';

export const metadata: Metadata = {
  title: 'Security & privacy — Effigent',
  description:
    'How Effigent protects agent data: sensitive-data redaction before storage, scoped per-agent keys stored hashed, strict tenant isolation, and passive capture that never sits in your request path.',
};

const PILLARS = [
  {
    hue: '150',
    title: 'Sensitive data is redacted before storage',
    body: 'Every captured payload passes through a redaction layer at the single ingest choke point — before it is stored, indexed, or analyzed. API keys (OpenAI, Anthropic, GitHub, Slack, Google), AWS credentials, JWTs and bearer tokens, database connection strings, private-key blocks, email addresses and card-like numbers are replaced with typed placeholders. The same secret always maps to the same placeholder, so execution graphs stay comparable without the value ever being kept.',
  },
  {
    hue: '250',
    title: 'Scoped, least-privilege capture keys',
    body: 'Each agent gets its own capture key that can do exactly one thing: upload runs for that agent. Keys are stored as SHA-256 hashes — we cannot read them back. On developer machines the key lives in ~/.effigent, never inside your agent’s configuration or repository. Revoke or re-mint a key per agent at any time without touching the others.',
  },
  {
    hue: '290',
    title: 'Strict tenant isolation',
    body: 'Every row of every table is scoped to a tenant, and every query runs through that scope — there is no cross-tenant read path. Workspaces map to your identity provider’s organizations; membership changes take effect immediately.',
  },
  {
    hue: '85',
    title: 'Passive capture — never in your request path',
    body: 'Effigent observes completed executions. It does not proxy your LLM traffic, hold your provider keys, or add latency to a single request. If capture is down, your agents are completely unaffected.',
  },
  {
    hue: '20',
    title: 'Minimal retention, easy deletion',
    body: 'Analysis stores trimmed, redacted step payloads — raw transcripts are compressed and kept only as blobs for replay validation. Delete any agent’s runs, or an entire workspace, at any time.',
  },
];

export default function SecurityPage() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Security & privacy"
        title="Your agents’ data, treated like production data."
        sub="Effigent sees how your agents work — so the pipeline is built to never keep what it doesn’t need: redaction before storage, least-privilege keys, and hard tenant isolation."
      />

      <DocSection>
        {PILLARS.map((p) => (
          <div key={p.title} style={{ display: 'flex', gap: 18, padding: '26px 0', borderBottom: '1px solid var(--line)' }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: `oklch(0.58 0.16 ${p.hue})`, marginTop: 7, flexShrink: 0 }} />
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 8px' }}>{p.title}</h2>
              <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.7, margin: 0, maxWidth: 720 }}>{p.body}</p>
            </div>
          </div>
        ))}
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>What redaction looks like</h2>
        <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.65, margin: '0 0 16px', maxWidth: 680 }}>
          A captured tool output containing credentials is transformed before it ever reaches storage:
        </p>
        <CodeBlock title="ingest — before / after">{`# captured payload
export DATABASE_URL=postgresql://svc:s3cretpw@db.internal/prod
contact: oncall@acme.com   token: Bearer eyJhbGciOiJIUzI1NiJ9...

# what gets stored & analyzed
export DATABASE_URL=[REDACTED:DB_URL]
contact: [REDACTED:EMAIL]   token: [REDACTED:BEARER]`}</CodeBlock>
        <p style={{ fontSize: 13.5, color: 'var(--ink-3)', lineHeight: 1.6, margin: '16px 0 0', maxWidth: 680 }}>
          Redaction is deterministic and pattern-based — no model sees the raw value, and placeholders are typed so the optimization engine can still reason about the shape of an execution.
        </p>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Questions we get asked</h2>
        {[
          ['Do you store our provider API keys?', 'No. Capture is passive — your agents talk to OpenAI/Anthropic directly. The only credential Effigent holds is its own scoped capture key, stored hashed.'],
          ['Can one agent’s key read another agent’s data?', 'No. Capture keys are write-only and bound to a single agent. Dashboard access is a separate, user-level authentication through your identity provider.'],
          ['What happens if the collector is down?', 'Nothing, for your agents — capture is out of the request path. Hook-based uploads retry on the next session; OTel exporters buffer and flush.'],
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
