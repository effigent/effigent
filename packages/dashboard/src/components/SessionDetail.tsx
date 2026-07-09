import { useState, useEffect } from 'react';
import { Ic } from '../icons.tsx';

interface Usage { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }
interface Step {
  kind: 'model_turn' | 'tool_use' | 'tool_result' | 'thinking';
  name: string;
  payload: string;
  isError?: boolean;
  toolUseId?: string;
  model?: string;
  tokens?: { input: number; output: number };
  ms?: number;
}
interface Parsed {
  models?: string[];
  usageByModel?: Record<string, Usage>;
  costUsd?: number;
  firstPrompt?: string;
  steps?: Step[];
}
interface RunRow {
  session_id: string;
  agent_id: string;
  started_at: string | null;
  ended_at: string | null;
  cost_usd: string | number;
  n_steps: number;
  models: string[];
  parsed: Parsed;
}

const KIND: Record<Step['kind'], { label: string; icon: string; cls: string }> = {
  model_turn: { label: 'LLM turn', icon: 'spark', cls: 'k-llm' },
  tool_use: { label: 'Tool call · input', icon: 'wrench', cls: 'k-tool' },
  tool_result: { label: 'Tool result', icon: 'arrowRight', cls: 'k-result' },
  thinking: { label: 'Reasoning', icon: 'bulb', cls: 'k-think' },
};

const PRICE: Record<string, { in: number; out: number }> = {
  'claude-opus-4': { in: 15, out: 75 }, 'claude-sonnet-4': { in: 3, out: 15 }, 'claude-haiku-4': { in: 0.8, out: 4 },
  'gpt-4o': { in: 2.5, out: 10 }, 'gpt-4o-mini': { in: 0.15, out: 0.6 },
};
const nfmt = (n: number) => n.toLocaleString('en-US');
const modelCost = (m: string, u: Usage) => {
  const p = PRICE[m] ?? PRICE['claude-sonnet-4'];
  return (u.inputTokens * p.in + u.outputTokens * p.out + u.cacheReadInputTokens * p.in * 0.1) / 1e6;
};

export function SessionDetail({ sessionId, optimized, onBack }: { sessionId: string; optimized: boolean; onBack: () => void }) {
  const [run, setRun] = useState<RunRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    setLoading(true);
    setErr(false);
    setOpen(new Set());
    fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { run: RunRow }) => setRun(d.run))
      .catch(() => setErr(true))
      .finally(() => setLoading(false));
  }, [sessionId]);

  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  const steps = run?.parsed?.steps ?? [];
  const models = run?.models ?? run?.parsed?.models ?? [];
  const usage = run?.parsed?.usageByModel ?? {};
  const totalTok = Object.values(usage).reduce((s, u) => s + u.inputTokens + u.outputTokens, 0);
  const dur =
    run?.started_at && run?.ended_at
      ? `${Math.max(1, Math.round((new Date(run.ended_at).getTime() - new Date(run.started_at).getTime()) / 1000))}s`
      : '—';
  const cost = run ? `$${Number(run.cost_usd).toFixed(4)}` : '—';

  return (
    <section className="dag">
      <div className="dag-bar">
        <button className="btn-ghost" onClick={onBack}>
          <Ic n="arrowRight" style={{ width: 15, height: 15, transform: 'rotate(180deg)' }} /> Sessions
        </button>
      </div>

      <div className="dag-head">
        <div>
          <div className="mono-name" style={{ fontSize: 15 }}>{sessionId}</div>
          <div className="sub" style={{ marginTop: 4 }}>
            {run?.agent_id ?? '…'}
            {optimized && <span className="opt-badge" style={{ marginLeft: 10 }}><Ic n="spark" style={{ width: 11, height: 11 }} /> Optimized</span>}
          </div>
        </div>
        <div className="dag-stats">
          <div className="stat"><span className="v tnum">{steps.length || run?.n_steps || 0}</span><span className="k">Steps</span></div>
          <div className="stat"><span className="v tnum">{nfmt(totalTok)}</span><span className="k">Tokens</span></div>
          <div className="stat"><span className="v tnum">{dur}</span><span className="k">Duration</span></div>
          <div className="stat"><span className="v tnum">{cost}</span><span className="k">Cost</span></div>
        </div>
      </div>

      {/* per-model usage — the real "agent usage" breakdown */}
      {Object.keys(usage).length > 0 && (
        <div className="usage-panel">
          <div className="usage-head">
            <span className="panel-title" style={{ fontSize: 14 }}>Model usage</span>
            {models.length > 1 && <span className="dag-models-note">multi-model — routed across {models.length} models</span>}
          </div>
          <table className="usage-tbl">
            <thead>
              <tr><th>Model</th><th className="num">Input</th><th className="num">Output</th><th className="num">Cached</th><th className="num">Cost</th></tr>
            </thead>
            <tbody>
              {Object.entries(usage).map(([m, u]) => (
                <tr key={m}>
                  <td><span className="chip">{m}</span></td>
                  <td className="num tnum">{nfmt(u.inputTokens)}</td>
                  <td className="num tnum">{nfmt(u.outputTokens)}</td>
                  <td className="num tnum">{nfmt(u.cacheReadInputTokens)}</td>
                  <td className="num tnum">${modelCost(m, u).toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loading && <div className="dag-empty">Loading run…</div>}
      {err && <div className="dag-empty">Couldn’t load this run.</div>}
      {!loading && !err && steps.length === 0 && <div className="dag-empty">This run has no captured steps.</div>}

      {!loading && !err && steps.length > 0 && (
        <div className="dag-trace">
          <div className="dag-trace-bar">
            <span className="dag-trace-title">Execution trace</span>
            <span className="dag-trace-count">{steps.length} steps</span>
            <button
              className="dag-expand"
              onClick={() => setOpen(open.size === steps.length ? new Set() : new Set(steps.map((_, i) => i)))}
            >
              {open.size === steps.length ? 'Collapse all' : 'Expand all'}
            </button>
          </div>
          <ol className="dag-flow dag-scroll">
            {steps.map((s, i) => {
              const meta = KIND[s.kind] ?? KIND.tool_use;
              const isErr = s.isError;
              const paired = s.kind === 'tool_result' && steps[i - 1]?.toolUseId && steps[i - 1].toolUseId === s.toolUseId;
              const long = (s.payload?.length ?? 0) > 140;
              const isOpen = open.has(i);
              return (
                <li
                  key={i}
                  className={`dag-node ${meta.cls} ${isErr ? 'is-error' : ''} ${paired ? 'paired' : ''} ${long ? 'expandable' : ''}`}
                  onClick={() => long && toggle(i)}
                >
                  <span className="dag-node-idx tnum">{i + 1}</span>
                  <span className="dag-node-ico"><Ic n={meta.icon} /></span>
                  <div className="dag-node-body">
                    <div className="dag-node-top">
                      <span className="dag-node-kind">{meta.label}</span>
                      {s.kind !== 'model_turn' && <span className="dag-node-name">{s.name}</span>}
                      {s.model && <span className="chip">{s.model}</span>}
                      {s.tokens && <span className="dag-node-tok tnum">{nfmt(s.tokens.input)} in · {nfmt(s.tokens.output)} out</span>}
                      {typeof s.ms === 'number' && <span className="dag-node-ms tnum">{s.ms >= 1000 ? `${(s.ms / 1000).toFixed(1)}s` : `${s.ms}ms`}</span>}
                      {isErr && <span className="dag-node-err">error</span>}
                      {long && <span className="dag-node-toggle">{isOpen ? 'less' : 'more'}</span>}
                    </div>
                    {s.payload && <div className={`dag-node-payload ${long && !isOpen ? 'clamped' : ''}`}>{s.payload}</div>}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}
