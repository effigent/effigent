import type { Metadata } from 'next';
import { Nav, Footer, CodeBlock, PageHero, DocSection, StepBadge } from '../ui';
import { COLLECTOR_URL, TRACES_URL } from '../config';

export const metadata: Metadata = {
  title: 'Developer guide — add Effigent to any AI agent',
  description:
    'Register an agent, wire capture for Claude Code, OpenAI Codex, LangGraph, CrewAI, AutoGen or any OTel-capable agent, and watch every run land in the dashboard — no code changes to your agent.',
};

const HARNESSES = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    tag: 'Hook · zero-touch',
    blurb:
      'One command installs a SessionEnd hook. Every finished session uploads automatically — event-driven, no polling, no changes to your agent. The scoped key stays in ~/.effigent and is never written into your agent configuration.',
    code: `effigent install claude --agent billing-agent

# ✓ SessionEnd hook installed in ~/.claude/settings.json
#   Every finished session now uploads under 'billing-agent'.`,
    title: 'zsh — claude code',
  },
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    tag: 'Native OpenTelemetry · config.toml',
    blurb:
      'Codex reads OTel config only from ~/.codex/config.toml — not from environment variables. `effigent install codex` writes a scoped [otel] block there, with your key filled in, so capture stays local to Codex and never touches your shell profile or other apps.',
    code: `effigent install codex --agent billing-agent

# ✓ wrote a scoped [otel] block to ~/.codex/config.toml:
[otel]
trace_exporter = { otlp-http = { endpoint = "${TRACES_URL}", protocol = "json", headers = { Authorization = "Bearer <scoped-key>" } } }
exporter       = { otlp-http = { endpoint = "${COLLECTOR_URL}/v1/logs", protocol = "json", headers = { Authorization = "Bearer <scoped-key>" } } }

# fully restart Codex (OTel initializes at launch), then:
codex "fix the failing checkout test"`,
    title: 'toml — ~/.codex/config.toml',
  },
  {
    id: 'python',
    name: 'Python agents',
    tag: 'LangGraph · CrewAI · AutoGen · OpenAI Agents',
    blurb:
      'One init() call auto-instruments the openai/anthropic clients and every major Python agent framework via OpenLLMetry. No per-call changes — your agent code stays exactly as it is.',
    code: `pip install traceloop-sdk

# once, at startup:
from traceloop.sdk import Traceloop

Traceloop.init(
    api_endpoint="${COLLECTOR_URL}",
    headers={"Authorization": "Bearer <scoped-key>"},
)`,
    title: 'python — langgraph / crewai / autogen',
  },
  {
    id: 'node',
    name: 'Node / TypeScript agents',
    tag: 'OpenLLMetry',
    blurb:
      'Same one-time initialization for Node. The SDK instruments the openai and anthropic clients automatically; every LLM and tool call is captured as spans. Pass the base URL — the SDK appends /v1/traces itself.',
    code: `npm i @traceloop/node-server-sdk

// before your agent runs:
import * as traceloop from "@traceloop/node-server-sdk";

traceloop.initialize({
  baseUrl: "${COLLECTOR_URL}",
  headers: { Authorization: "Bearer <scoped-key>" },
  disableBatch: true,
});`,
    title: 'node — openai agents / custom',
  },
  {
    id: 'proxy',
    name: 'Proxy fallback',
    tag: 'Any OpenAI-compatible agent · no instrumentation',
    blurb:
      'Can’t add an SDK or OTel? Run the local capturing gateway and point your agent’s OpenAI client at it. It forwards every call to the real upstream — your existing key travels through untouched, never stored — and mirrors each completion to Effigent.',
    code: `effigent proxy --agent billing-agent
# → listening on http://localhost:4319  →  https://api.openai.com

# point the agent at it — no code changes:
export OPENAI_BASE_URL=http://localhost:4319/v1

# only what flows through the LLM endpoint is captured;
# tool executions in the agent aren't visible via the proxy.`,
    title: 'proxy — un-instrumentable agents',
  },
  {
    id: 'anywhere',
    name: 'CI, cron & containers',
    tag: 'EKS · ECS · Lambda · GitHub Actions',
    blurb:
      'Everything above is environment-variable driven, so it works identically in Kubernetes, ECS task definitions, Lambda environment config, and CI. For one-off or scheduled commands, `effigent run` wraps any agent invocation and handles attribution for you.',
    code: `# wrap ANY command — attribution + upload handled automatically
effigent run --agent nightly-etl -- node etl.js
effigent run --agent pr-reviewer -- claude -p "review this diff"

# containers: set the four OTEL_* vars in your task definition / pod spec —
# the scoped key is the only credential the workload needs.`,
    title: 'anywhere — ci / cron / k8s',
  },
];

export default function DevelopersPage() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Developer guide"
        title="Add Effigent to any agent in two steps."
        sub="Effigent observes your agents from the outside — it never asks you to change agent code. Register the agent to mint a scoped capture key, wire capture for your harness, and every run appears in the dashboard as an execution graph."
      />

      {/* How capture works */}
      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 28, margin: '0 0 20px' }}>How capture works</h2>
        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '20px 22px', background: 'oklch(0.995 0.002 90)' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'oklch(0.52 0.15 290)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Path 1 — Transcript hook</div>
            <div style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--ink-2)' }}>
              For CLI harnesses like Claude Code: a session-end hook uploads the finished transcript. Richest signal — every model turn, tool call and result.
            </div>
          </div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '20px 22px', background: 'oklch(0.995 0.002 90)' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'oklch(0.52 0.15 250)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Path 2 — OpenTelemetry</div>
            <div style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--ink-2)' }}>
              For SDK agents and Codex: standard OTel GenAI spans, exported straight to the collector. Works with anything that speaks OpenTelemetry.
            </div>
          </div>
        </div>
        <div style={{ marginTop: 16, fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.65 }}>
          Both paths normalize into the same execution graph, so the optimization engine doesn&apos;t care which harness your agent runs on. Capture is passive — nothing sits in your agent&apos;s request path, so there is zero added latency.
        </div>
      </DocSection>

      {/* Step 1 */}
      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 28, margin: '0 0 6px', display: 'flex', alignItems: 'center' }}><StepBadge n={1} />Register the agent</h2>
        <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.65, margin: '10px 0 18px' }}>
          Each agent gets its own <strong>scoped capture key</strong> — it can only upload runs for that agent, nothing else. Your workspace key never leaves your machine.
        </p>
        <CodeBlock title="zsh — one time per agent">{`npm i -g effigent
effigent login --key <workspace-key>

effigent agent add billing-agent
# ✓ registered 'billing-agent' — scoped capture key saved to ~/.effigent/config.json`}</CodeBlock>
      </DocSection>

      {/* Step 2 */}
      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 28, margin: '0 0 6px', display: 'flex', alignItems: 'center' }}><StepBadge n={2} />Wire capture for your harness</h2>
        <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.65, margin: '10px 0 8px' }}>
          Pick the one that matches how your agent runs. All of them take under two minutes.
        </p>
        {HARNESSES.map((h) => (
          <div key={h.id} id={h.id} style={{ margin: '34px 0 0' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
              <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{h.name}</h3>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', border: '1px solid var(--line-2)', borderRadius: 12, padding: '3px 10px' }}>{h.tag}</span>
            </div>
            <p style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.65, margin: '0 0 14px', maxWidth: 680 }}>{h.blurb}</p>
            <CodeBlock title={h.title}>{h.code}</CodeBlock>
          </div>
        ))}
      </DocSection>

      {/* Step 3 */}
      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 28, margin: '0 0 6px', display: 'flex', alignItems: 'center' }}><StepBadge n={3} />Watch the runs land</h2>
        <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.65, margin: '10px 0 18px', maxWidth: 680 }}>
          Every captured session appears in the dashboard within seconds of upload: the full execution trace as a navigable graph, per-model token usage and cost, and — once an agent has enough history — the optimization insights: which steps are deterministic enough to replace with tools, memoize by input, or route to a smaller model.
        </p>
        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
          {[
            ['Sessions', 'Every run, filterable by agent and session id, with cost and model breakdown.'],
            ['Execution graphs', 'Step-by-step trace of each run — model turns, tool calls, tokens, latency.'],
            ['Insights', 'Determinism analysis over the last 40 sessions: replace, memoize, template, route.'],
          ].map(([t, d]) => (
            <div key={t} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '18px 20px', background: 'oklch(0.995 0.002 90)' }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 6 }}>{t}</div>
              <div style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.55 }}>{d}</div>
            </div>
          ))}
        </div>
      </DocSection>

      {/* Security note */}
      <DocSection>
        <div style={{ border: '1px solid oklch(0.85 0.06 150)', background: 'oklch(0.97 0.03 150)', borderRadius: 12, padding: '22px 24px' }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8, color: 'oklch(0.35 0.12 150)' }}>Scoped keys & redaction, by default</div>
          <div style={{ fontSize: 14, color: 'oklch(0.35 0.05 150)', lineHeight: 1.65 }}>
            Capture keys are per-agent, least-privilege, and stored hashed. Secrets and PII — API keys, cloud credentials, bearer tokens, connection strings, emails, card numbers — are <strong>redacted before anything is stored or analyzed</strong>. Read the full posture on the <a href="/security" style={{ textDecoration: 'underline' }}>security page</a>.
          </div>
        </div>
      </DocSection>

      <Footer />
    </div>
  );
}
