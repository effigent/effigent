import { useState } from 'react';

/**
 * The agent summary — what a person reads first (engine/summary.ts): one headline,
 * the few changes worth making ranked by monthly value, the findings that explain
 * the bill, and the sessions that drove it. Technical detail lives below it, collapsed.
 */

export interface SummaryAction {
  id: string;
  title: string;
  why: string;
  perMonthUsd: { low: number; high: number } | null;
  basis: 'measured' | 'simulated' | 'structural' | 'needs-ab';
  files: { path: string; content: string; note?: string }[];
}
export interface SummaryFinding {
  id: string;
  title: string;
  value: string;
  sentence: string;
  severity: 'high' | 'medium' | 'info';
  perMonthUsd?: number;
}
export interface SummarySession {
  runId: string;
  title?: string;
  startedAt?: string;
  costUsd: number;
  requestsX: number;
  peakContext: number;
  delivered: boolean;
  compactionSavesUsd: number | null;
}
export interface AgentSummaryData {
  window: { from?: string; to?: string; days: number; sessions: number; spendUsd: number; perMonthUsd: number };
  delivered?: { sessions: number; commits: number; pushes: number; prs: number; costPerSessionUsd: number | null } | null;
  headline: string;
  actions: SummaryAction[];
  findings: SummaryFinding[];
  sessions: SummarySession[];
  trend: {
    weeks: { week: string; sessions: number; costUsd: number; costPerRequest: number; baseTokens: number }[];
    costPerRequestChange: number | null;
    baseTokensChange: number | null;
  };
}

const money = (v: number) =>
  v >= 1000 ? `$${Math.round(v).toLocaleString('en-US')}` : v >= 10 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;

const BASIS: Record<SummaryAction['basis'], { label: string; hint: string }> = {
  measured: { label: 'measured', hint: 'Read directly off the recorded spend.' },
  simulated: { label: 'simulated', hint: 'Every recorded session replayed under the change; the replay reproduces the real bill within ~1%.' },
  structural: { label: 'if adopted', hint: 'Holds if the agent follows the change. Effigent checks the sessions after you apply it and reports whether it worked.' },
  'needs-ab': { label: 'needs a trial', hint: 'The effect is real but its size can only be learned by trying it for a week and comparing.' },
};

/** Weekly cost per request — the trend line in the header. */
function Sparkline({ weeks }: { weeks: AgentSummaryData['trend']['weeks'] }) {
  const pts = weeks.filter((w) => w.sessions > 0);
  if (pts.length < 3) return null;
  const W = 96, H = 26, max = Math.max(...pts.map((p) => p.costPerRequest)) || 1;
  const x = (i: number) => 2 + ((W - 4) * i) / (pts.length - 1);
  const y = (v: number) => H - 3 - ((H - 6) * v) / max;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.costPerRequest).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cost per request by week" className="sum-spark">
      <title>{pts.map((p) => `week of ${p.week}: $${p.costPerRequest.toFixed(3)}/request`).join('\n')}</title>
      <path d={`${d} L${x(pts.length - 1)},${H} L${x(0)},${H} Z`} fill="var(--accent-bg)" />
      <path d={d} fill="none" stroke="var(--accent-2)" strokeWidth="1.5" />
      <circle cx={x(pts.length - 1)} cy={y(last.costPerRequest)} r="2.5" fill="var(--accent-2)" />
    </svg>
  );
}

function ActionCard({ a, rank }: { a: SummaryAction; rank: number }) {
  const [open, setOpen] = useState(false);
  const b = BASIS[a.basis];
  return (
    <div className="sum-action">
      <div className="sum-action-top">
        <span className="sum-rank">{rank}</span>
        <span className="sum-action-title">{a.title}</span>
      </div>
      <div className="sum-action-money">
        {a.perMonthUsd ? <><span className="sum-money tnum">{money(a.perMonthUsd.low)}–{money(a.perMonthUsd.high)}</span><span className="sum-per">/month</span></> : <span className="sum-per">not priced</span>}
        <span className={`sum-basis b-${a.basis}`} title={b.hint}>{b.label}</span>
      </div>
      <p className="sum-why">{a.why}</p>
      {a.files.length > 0 && (
        <button type="button" className="sum-link" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide the change' : `What to change · ${a.files.map((f) => f.path.split('/').pop()).join(', ')}`}
        </button>
      )}
      {open && a.files.map((f) => (
        <div key={f.path} className="sum-file">
          <div className="sum-file-path"><code>{f.path}</code>{f.note ? ` — ${f.note}` : ''}</div>
          <pre>{f.content}</pre>
        </div>
      ))}
    </div>
  );
}

export function AgentSummary({ s }: { s: AgentSummaryData }) {
  const [showAll, setShowAll] = useState(false);
  const priced = s.actions.filter((a) => a.perMonthUsd);
  const rest = s.actions.filter((a) => !a.perMonthUsd);
  const top = showAll ? [...priced, ...rest] : priced.slice(0, 3);
  const hidden = priced.length + rest.length - top.length;
  const change = s.trend.costPerRequestChange;
  const showSaves = s.sessions.some((x) => x.compactionSavesUsd != null);
  return (
    <div className="sum">
      <div className="sum-head">
        <p className="sum-headline">{s.headline}</p>
        <div className="sum-meta">
          <span className="chip">{money(s.window.spendUsd)} · {s.window.sessions} sessions · {s.window.days} days</span>
          <span className="chip">≈{money(s.window.perMonthUsd)}/month</span>
          {change != null && Math.abs(change) >= 0.1 && (
            <span className={`chip ${change > 0 ? 'sum-up' : 'sum-down'}`} title="Cost per request, newer half of these sessions vs the older half">
              {change > 0 ? '▲' : '▼'} {Math.round(Math.abs(change) * 100)}% cost per request
            </span>
          )}
          {s.delivered && s.delivered.sessions > 0 && (
            <span className="chip" title={`${s.delivered.commits} commits, ${s.delivered.pushes} pushes, ${s.delivered.prs} PR actions`}>
              {s.delivered.sessions}/{s.window.sessions} sessions shipped code{s.delivered.costPerSessionUsd != null ? ` · ${money(s.delivered.costPerSessionUsd)} each` : ''}
            </span>
          )}
          <Sparkline weeks={s.trend.weeks} />
        </div>
      </div>

      {top.length > 0 && (
        <section aria-label="Do this first">
          <div className="sum-label">Do this first</div>
          <div className="sum-actions">
            {top.map((a, i) => <ActionCard key={a.id} a={a} rank={i + 1} />)}
          </div>
          {hidden > 0 && (
            <button type="button" className="sum-link" onClick={() => setShowAll(true)}>Show {hidden} more change{hidden === 1 ? '' : 's'}</button>
          )}
        </section>
      )}

      {s.findings.length > 0 && (
        <section aria-label="Why it costs what it does">
          <div className="sum-label">Why it costs what it does</div>
          <div className="sum-findings">
            {s.findings.slice(0, 4).map((f) => (
              <div key={f.id} className={`sum-finding sev-${f.severity}`}>
                <div className="sum-finding-value tnum">{f.value}</div>
                <div className="sum-finding-title">{f.title}</div>
                <p className="sum-finding-text">{f.sentence}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {s.sessions.length > 0 && (
        <section aria-label="Most expensive sessions">
          <div className="sum-label">Most expensive sessions</div>
          <div className="sum-table-wrap">
            <table className="sum-table">
              <thead>
                <tr><th>Session</th><th className="num">Cost</th><th className="num">Length</th><th className="num">Peak context</th><th>Outcome</th>{showSaves && <th className="num">Compacting would have saved</th>}</tr>
              </thead>
              <tbody>
                {s.sessions.map((x) => (
                  <tr key={x.runId}>
                    <td className="sum-sess-title">{x.title ?? <code>{x.runId.slice(0, 8)}</code>}{x.startedAt && <span className="sum-date"> {new Date(x.startedAt).toLocaleDateString()}</span>}</td>
                    <td className="num tnum">{money(x.costUsd)}</td>
                    <td className="num tnum" title="Requests, relative to this agent's median session">{x.requestsX.toFixed(1)}× median</td>
                    <td className="num tnum">{Math.round(x.peakContext / 1000)}k</td>
                    <td>{x.delivered ? <span className="sum-ok">committed / pushed</span> : <span className="sum-muted">no commit or push</span>}</td>
                    {showSaves && <td className="num tnum">{x.compactionSavesUsd != null ? money(x.compactionSavesUsd) : '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
