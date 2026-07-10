import type { Metadata } from 'next';
import { Nav, Footer, PageHero, DocSection, CodeBlock } from '../../ui';

export const metadata: Metadata = {
  title: 'Tools & knowledge graph — Effigent docs',
  description:
    'Synthesized tools with replay validation, the knowledge graph mined from stable lookups, and effigent optimize — how optimizations reach the running agent.',
};

export default function ToolsDocs() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Docs · Tools & knowledge"
        title="From evidence to injection."
        sub="The engine doesn't stop at suggestions: recurring procedures become ToolSpecs, stable lookups become a knowledge graph, and both are validated against history before they ever touch your agent."
      />

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Synthesized tools (ToolSpecs)</h2>
        <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.65, margin: '0 0 12px' }}>
          A compile unit is a recurring chain of steps whose arguments are constant or <em>derivable</em> — traceable to an
          earlier output (&quot;the <code>service</code> field of that config read&quot;) or to the task prompt. Each becomes a
          ToolSpec: typed parameters, the recorded steps with derivations spelled out, and expected outputs.
        </p>
        <CodeBlock title="a ToolSpec step (from bundle.json)">{`{
  "tool": "Bash",
  "argTemplate": "{'command':'curl -s https://internal/health/\${derive(c2.json:service)}'}",
  "expectedOutputTemplate": "status: healthy",
  "class": "cacheable",
  "guarded": false
}`}</CodeBlock>
        <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.65, margin: '12px 0 0' }}>
          <strong>Replay validation:</strong> before a tool may activate, its derivations are re-executed against the recorded
          runs — they must reproduce the exact arguments the agent actually issued. ≥95% over ≥10 runs →{' '}
          <strong>ready</strong>; anything less stays <strong>shadow</strong> and keeps scoring new runs. Side-effect steps are
          flagged <code>guarded</code> and never auto-scripted.
        </p>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>The knowledge graph</h2>
        <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.65, margin: '0 0 12px' }}>
          Agents burn tokens re-learning the same facts every run: the same globs, the same greps, the same config reads.
          Lookups whose <em>question and answer</em> are both stable across runs become typed facts — <code>file</code>,{' '}
          <code>search</code>, <code>listing</code>, <code>fetch</code>, <code>value</code> — each with support, stability
          confidence, and measured cost. Injected, they replace the exploration prelude: the agent <em>reads</em> the fact
          instead of re-running the lookup.
        </p>
        <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.65, margin: 0 }}>
          <strong>The honest gate:</strong> a knowledge graph is only marked worth injecting when its facts cover a meaningful
          share of the agent&apos;s exploration traffic — a KG that answers 3% of lookups just wastes context space, and the
          engine says so.
        </p>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Injection — <code>effigent optimize</code></h2>
        <CodeBlock title="zsh — install the bundle into the running agent">{`effigent optimize billing-agent

# ✓ bundle written: ~/.effigent/bundles/billing-agent/bundle.json
#   2 validated tool(s) · 7 knowledge fact(s) covering 64% of exploration
# ✓ Claude Code skill installed: ~/.claude/skills/effigent-billing-agent`}</CodeBlock>
        <div style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.75, marginTop: 12 }}>
          <p style={{ margin: '0 0 10px' }}>
            <strong>Code, not LLM:</strong> executable tools run as ONE command — <code>effigent tool &lt;agent&gt; &lt;name&gt;</code>{' '}
            executes the whole recorded procedure deterministically (reads, globs, greps, read-only bash, fetches), computes
            every <code>derive()</code> in code, and prints only the final answer. The LLM&apos;s entire involvement: one
            decision and one result — intermediate outputs never enter its context.
          </p>
          <p style={{ margin: '0 0 10px' }}>
            <strong>Automatic:</strong> <code>effigent install claude</code> wires a SessionStart hook that refreshes the
            bundle and skill before each session (throttled, fail-open — a refresh problem never blocks work). SDK / OTel
            agents consume <code>bundle.json</code> programmatically.
          </p>
          <p style={{ margin: 0 }}>
            <strong>Your switch:</strong> clicking an agent in the dashboard shows every injected tool — status, pass rate,
            measured savings — with a per-tool toggle. Disabled tools drop out of the bundle at the next refresh. Drift in the
            agent&apos;s behavior flags the bundle for regeneration.
          </p>
        </div>
      </DocSection>
      <Footer />
    </div>
  );
}
