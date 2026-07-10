import { useEffect, useState } from 'react';

interface InjectedTool {
  toolId: string;
  name: string;
  status: string;
  enabled: boolean;
  steps: number;
  params: number;
  perRunUsd: number;
  support: number;
  runs: number;
  passRate: number | null;
}

const usd = (n: number) => `$${n.toFixed(4)}`;

/** What Effigent injects into this agent — with the owner's per-tool switch.
 *  Disabling drops the tool from the next bundle refresh (session start /
 *  `effigent optimize`). */
export function AgentTools({ agent }: { agent: string }) {
  const [tools, setTools] = useState<InjectedTool[]>([]);
  const [migrated, setMigrated] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/v1/agent-tools?agent=${encodeURIComponent(agent)}`)
      .then((r) => (r.ok ? r.json() : { tools: [] }))
      .then((d: { tools?: InjectedTool[]; migrated?: boolean }) => {
        setTools(d.tools ?? []);
        setMigrated(d.migrated !== false);
      })
      .catch(() => setTools([]))
      .finally(() => setLoading(false));
  }, [agent]);

  const toggle = (toolId: string, enabled: boolean) => {
    setTools((ts) => ts.map((t) => (t.toolId === toolId ? { ...t, enabled } : t))); // optimistic
    fetch('/api/v1/agent-tools', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent, toolId, enabled }),
    }).catch(() => {
      setTools((ts) => ts.map((t) => (t.toolId === toolId ? { ...t, enabled: !enabled } : t)));
    });
  };

  if (loading || (!migrated && tools.length === 0)) return null;
  if (tools.length === 0) return null;

  return (
    <section className="panel panel-pad">
      <div className="ins-head">
        <div>
          <div className="mono-name" style={{ fontSize: 14 }}>Injected tools</div>
          <div className="panel-sub">
            What Effigent compiles into this agent. Disabled tools drop out of the bundle at the next refresh.
          </div>
        </div>
      </div>
      <div className="ins-list">
        {tools.map((t) => (
          <div key={t.toolId} className="ins-row" style={{ opacity: t.enabled ? 1 : 0.45 }}>
            <div className="ins-main">
              <div className="ins-top">
                <span className={`ins-act ${t.status === 'ready' ? 'act-replace' : 'act-route'}`}
                  title={t.status === 'ready' ? 'replay-validated — active in the bundle' : 'still in shadow validation — informational only'}>
                  {t.status}
                </span>
                <span className="mono-name" style={{ fontSize: 12.5 }}>{t.name}</span>
                <span className="ins-kind">{t.steps} steps{t.params > 0 ? ` · ${t.params} param${t.params === 1 ? '' : 's'}` : ''}</span>
              </div>
            </div>
            <div className="ins-metrics">
              {t.passRate !== null && (
                <span className="ins-conf tnum" title="replay pass rate">{Math.round(t.passRate * 100)}%</span>
              )}
              <span className="ins-usd tnum" title="measured saving per run">{usd(t.perRunUsd)}</span>
              <span className="ins-runs tnum" title="share of runs containing this procedure">{Math.round(t.support * 100)}%</span>
              <label className="tgl" title={t.enabled ? 'Enabled — click to exclude from the bundle' : 'Disabled — click to re-enable'}>
                <input type="checkbox" checked={t.enabled} onChange={(e) => toggle(t.toolId, e.target.checked)} />
                <span className="tgl-track" />
                <span className="tgl-knob" />
              </label>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
