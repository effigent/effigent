import { useEffect, useState } from 'react';
import { ALL_AGENTS } from '../data.ts';

interface KnowledgeEntry {
  id: string;
  kind: 'file' | 'search' | 'listing' | 'fetch' | 'value';
  tool: string;
  key: string;
  value: string;
  support: number;
  confidence: number;
  estUsdPerRun: number;
}
interface Knowledge {
  entries: KnowledgeEntry[];
  coverage: number;
  explorationSteps: number;
  coveredSteps: number;
  estUsdPerRun: number;
  worthIt: boolean;
  runCount: number;
}
interface AgentInsight { agentId: string; knowledge?: Knowledge | null }

const KIND_HINT: Record<string, string> = {
  file: 'stable file content the agent keeps re-reading',
  search: 'a search whose matches never change',
  listing: 'a directory/glob listing that is stable',
  fetch: 'an idempotent fetch with a stable response',
  value: 'a stable computed value',
};

const usd = (n: number) => `$${n.toFixed(4)}`;

/** Live knowledge graph — the stable facts mined from each agent's runs.
 *  Injected via `effigent optimize <agent>` so the agent reads facts instead
 *  of re-running the lookups. */
export function KnowledgeLive({ agent }: { agent: string }) {
  const [data, setData] = useState<AgentInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const q = agent && agent !== ALL_AGENTS ? `?agent=${encodeURIComponent(agent)}` : '';
    fetch(`/api/v1/insights${q}`)
      .then((r) => (r.ok ? r.json() : { insights: [] }))
      .then((d: { insights?: AgentInsight[] }) => setData((d.insights ?? []).filter((a) => a.knowledge)))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [agent]);

  if (loading) return <div className="dag-empty">Mining stable facts from recent runs…</div>;
  if (data.length === 0) {
    return (
      <div className="dag-empty">
        No stable knowledge yet — facts appear once an agent repeats the same lookups
        (globs, greps, file reads) with the same answers across runs.
      </div>
    );
  }

  return (
    <div className="page-stack">
      {/* Always-visible key for the fact kinds and metric columns. */}
      <div className="tool-legend" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
        <div>
          <b>Fact kinds:</b>{' '}
          <b>file</b> stable file content re-read · <b>search</b> a grep whose matches don’t change ·{' '}
          <b>listing</b> a stable dir/glob listing · <b>fetch</b> an idempotent fetch ·{' '}
          <b>value</b> a stable computed value.
        </div>
        <div>
          <b>±N</b> = answer stability (Wilson lower bound) · <b>$ / run</b> = exploration cost saved per run ·{' '}
          <b>N×</b> = times the fact recurred across runs. Click a fact to see its value.
        </div>
      </div>
      {data.map((a) => {
        const k = a.knowledge!;
        return (
          <section key={a.agentId} className="panel panel-pad">
            <div className="ins-head">
              <div>
                <div className="mono-name" style={{ fontSize: 14 }}>{a.agentId}</div>
                <div className="panel-sub">
                  {k.entries.length} stable fact{k.entries.length === 1 ? '' : 's'} · covers {Math.round(k.coverage * 100)}% of
                  exploration lookups over {k.runCount} runs
                  {k.worthIt
                    ? ' · worth injecting'
                    : ' · below the injection bar (needs more stable coverage)'}
                </div>
              </div>
              <div className="ins-save">
                <span className="ins-save-v tnum">{usd(k.estUsdPerRun)}</span>
                <span className="ins-save-k">exploration cost / run</span>
              </div>
            </div>

            {k.entries.length > 0 && (
              <div className="ins-list">
                {k.entries.map((e) => (
                  <div key={e.id} className="ins-row" style={{ cursor: 'pointer' }} onClick={() => setOpen(open === e.id ? null : e.id)}>
                    <div className="ins-main">
                      <div className="ins-top">
                        <span className="ins-act act-memoize" title={KIND_HINT[e.kind]}>{e.kind}</span>
                        <span className="ins-kind">{e.tool}</span>
                        <span className="mono-name" style={{ fontSize: 12, opacity: 0.85 }}>{e.key.slice(0, 90)}</span>
                      </div>
                      {open === e.id && (
                        <div className="ins-preview" style={{ whiteSpace: 'pre-wrap' }}>{e.value}</div>
                      )}
                    </div>
                    <div className="ins-metrics">
                      <span className="ins-conf tnum" title="answer stability (Wilson lower bound)">±{e.confidence}</span>
                      <span className="ins-usd tnum">{usd(e.estUsdPerRun)}</span>
                      <span className="ins-runs tnum">{e.support}×</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="foot-note" style={{ marginTop: 12 }}>
              Inject with <code>effigent optimize {a.agentId}</code> — the agent reads these facts instead of re-running the lookups.
            </div>
          </section>
        );
      })}
    </div>
  );
}
