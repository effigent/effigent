import { useEffect, useState } from 'react';
import { ALL_AGENTS, collectorBase } from '../data.ts';

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <div className="code">
      <button className="code-copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      <pre>{code}</pre>
    </div>
  );
}

const LIFECYCLE: Array<[string, string]> = [
  ['Candidate', 'The analyzer found a repeated pattern in your runs and priced it.'],
  ['Shadow', 'The runtime computes the policy’s answer next to the real model and records whether they agree.'],
  ['Approved', 'A person approves it, with the agreement and outcome evidence attached.'],
  ['Enforced', 'The runtime answers instead of the model. It moves back to shadow on its own if live metrics drop.'],
];

interface ShadowSummary {
  sessions: number;
  costUsd: number;
  subagents: number;
  subagentCostUsd: number;
  premiumSubagents: number;
  wouldRoute: number;
  estimatedSavingsUsd: number;
  estimatedSavingsShare: number;
  lastAt?: string;
}
interface ShadowSessionRow {
  sessionId: string;
  endedAt?: string;
  requests: number;
  costUsd: number;
  subagents: Array<{ agentId: string; model: string; requests: number; costUsd: number; wouldRouteTo?: string; counterfactualUsd?: number }>;
  wouldRoute: number;
  estimatedSavingsUsd: number;
}
interface ShadowResponse {
  policy: { status: string; params?: { to?: string } };
  summary: ShadowSummary;
  sessions: ShadowSessionRow[];
  note?: string;
}

const usd = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

/** Shadow results of the Claude Code subagent routing policy (effigent claude). */
function ShadowRouting({ agent }: { agent: string }) {
  const [data, setData] = useState<ShadowResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (agent === ALL_AGENTS) return;
    setData(null);
    setError(null);
    fetch(`/api/v1/policies/shadow?agent=${encodeURIComponent(agent)}`)
      .then(async (r) => (r.ok ? setData((await r.json()) as ShadowResponse) : setError(((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}`)))
      .catch(() => setError('Network error'));
  }, [agent]);

  if (agent === ALL_AGENTS) return <div className="dag-empty" style={{ padding: 16 }}>Pick an agent above to see its shadow results.</div>;
  if (error) return <div className="dag-empty" style={{ padding: 16 }}>{error}</div>;
  if (!data) return <div className="dag-empty" style={{ padding: 16 }}>Loading…</div>;
  const s = data.summary;
  if (!s.sessions) {
    return (
      <div className="dag-empty" style={{ padding: 16 }}>
        No sessions through the gateway yet for <span className="mono-name">{agent}</span>. Start Claude Code with{' '}
        <code>effigent claude</code> in this project.{data.note ? ` ${data.note}` : ''}
      </div>
    );
  }
  const target = data.policy.params?.to ?? 'Sonnet';
  return (
    <>
      <div className="sess-totals">
        <div className="totstat"><span className="k">Sessions seen</span><span className="v tnum">{s.sessions}</span></div>
        <div className="totstat"><span className="k">Spend seen</span><span className="v tnum">{usd(s.costUsd)}</span></div>
        <div className="totstat"><span className="k">Subagent spend</span><span className="v tnum">{usd(s.subagentCostUsd)}</span></div>
        <div className="totstat"><span className="k">Would route</span><span className="v tnum">{s.wouldRoute} / {s.premiumSubagents}</span></div>
        <div className="totstat"><span className="k">Estimated saving</span><span className="v tnum">{usd(s.estimatedSavingsUsd)} ({(s.estimatedSavingsShare * 100).toFixed(1)}%)</span></div>
      </div>
      <div className="foot-note" style={{ margin: '8px 0' }}>
        Estimate: the same tokens priced at {target}. The cheaper model may need more turns, and answer quality is not measured
        until a sample is actually routed. Nothing has been changed — every request went to the model Claude Code chose.
      </div>
      <div className="tbl-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th>Session</th>
              <th>Ended</th>
              <th className="num">Requests</th>
              <th className="num">Cost</th>
              <th className="num">Subagents</th>
              <th className="num">Would route</th>
              <th className="num">Est. saving</th>
            </tr>
          </thead>
          <tbody>
            {data.sessions.map((r) => (
              <tr key={r.sessionId}>
                <td className="mono-name">{r.sessionId.slice(0, 8)}</td>
                <td>{when(r.endedAt)}</td>
                <td className="num tnum">{r.requests}</td>
                <td className="num tnum">{usd(r.costUsd)}</td>
                <td className="num tnum">{r.subagents.length}</td>
                <td className="num tnum">{r.wouldRoute}</td>
                <td className="num tnum">{r.estimatedSavingsUsd > 0 ? usd(r.estimatedSavingsUsd) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Runtime — Effigent at the model call: @effigent/runtime inside an API agent
 * (records only), and the `effigent claude` gateway for Claude Code, which runs
 * the first policy (subagent model routing) in shadow. Analyzer-produced
 * policies wait on a prefix matcher (see core/policy.ts).
 */
export function Runtime({ agent }: { agent: string }) {
  // Resolved after mount, as Install.tsx does: the page origin is only known in the browser.
  const [resolved, setResolved] = useState('');
  useEffect(() => setResolved(collectorBase()), []);
  const base = resolved || '<collector-url>';
  const env = `EFFIGENT_API_KEY=eff_…            # an agent key from Install Effigent\nEFFIGENT_SERVER=${base}`;
  const code = `npm install @effigent/runtime

import Anthropic from '@anthropic-ai/sdk';
import { createRuntime } from '@effigent/runtime';

const effigent = createRuntime({ agent: 'my-agent' });
const client = effigent.wrap(new Anthropic());

await effigent.run(async () => {
  // your agent loop, unchanged — one run = one session here
});`;

  return (
    <div className="page-stack">
      <section className="panel panel-pad">
        <div className="mono-name" style={{ fontSize: 14 }}>Add the runtime to an API agent</div>
        <div className="panel-sub" style={{ marginBottom: 10 }}>
          Wrap your Anthropic client. Your agent loop does not change. Every model call is recorded and appears under
          Sessions. If Effigent is unreachable, your agent carries on as normal.
        </div>
        <CodeBlock code={env} />
        <div style={{ height: 8 }} />
        <CodeBlock code={code} />
        <div className="foot-note">
          Supported now: <code>messages.create</code> (plain and streaming) and <code>messages.stream()</code> in the
          Anthropic TypeScript SDK.
        </div>
      </section>

      <section className="panel panel-pad">
        <div className="mono-name" style={{ fontSize: 14 }}>Claude Code</div>
        <div className="panel-sub" style={{ marginBottom: 10 }}>
          Start Claude Code through the Effigent gateway. It runs on your machine and sends every request unchanged to
          Anthropic — with your own login (Pro/Max or API key), which Effigent never sees or stores. Only model names and
          token counts are recorded.
        </div>
        <CodeBlock code={`npm install -g effigent\neffigent login\ncd your-project && effigent claude    # same arguments as claude`} />
      </section>

      <section className="panel panel-pad">
        <div className="mono-name" style={{ fontSize: 14 }}>Policies</div>
        <div className="panel-sub" style={{ marginBottom: 10 }}>
          A policy replaces work the model keeps repeating. Nothing runs without your approval.
        </div>
        <div className="panel panel-pad" style={{ marginBottom: 10 }}>
          <div className="mono-name" style={{ fontSize: 13 }}>
            Subagent model routing <span className="opt-badge" style={{ marginLeft: 8 }}>shadow</span>
          </div>
          <div className="panel-sub" style={{ marginBottom: 10 }}>
            Claude Code subagents that run on Opus or Fable would run on Sonnet instead. Decided once per subagent, so the
            prompt cache stays intact. In shadow, the gateway only records what it would have routed.
          </div>
          <ShadowRouting agent={agent} />
        </div>
        <div className="dag-empty" style={{ padding: 20 }}>
          Policies found in your recorded runs will appear here as candidates once there are enough runs to find repeated
          patterns.
        </div>
        <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
          {LIFECYCLE.map(([step, text], i) => (
            <div key={step} className="panel-sub">
              <span className="mono-name" style={{ fontSize: 12 }}>{i + 1}. {step}</span> — {text}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
