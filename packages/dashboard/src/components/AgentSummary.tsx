import { useState } from 'react';
import { Ic } from '../icons.tsx';

/**
 * The agent summary — what a person reads first (engine/summary.ts). Layout: a hero
 * card (top change per month, the headline, the cost trend), two top recommendations,
 * four "why it costs what it does" cards, and the sessions that drove the bill.
 * Everything technical lives below it, collapsed, in Insights.
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

export const money = (v: number) =>
  v >= 1000 ? `$${Math.round(v).toLocaleString('en-US')}` : v >= 10 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;

const BASIS: Record<SummaryAction['basis'], { label: string; hint: string }> = {
  measured: { label: 'Measured', hint: 'Read directly off the recorded spend.' },
  simulated: { label: 'Simulated', hint: 'Every recorded session replayed under the change; the replay reproduces the real bill within ~1%.' },
  structural: { label: 'If adopted', hint: 'Holds if the agent follows the change. Effigent checks the sessions after you apply it and reports whether it worked.' },
  'needs-ab': { label: 'Needs a trial', hint: 'The effect is real but its size can only be learned by trying it for a week and comparing.' },
};

const ACTION_ICON: Record<string, string> = {
  'spill-exploration': 'spark', 'ship-skill': 'code', 'compact-earlier': 'layers', 'verify-hook': 'check',
  'compact-before-breaks': 'chat', 'shrink-instructions': 'database', 'advisor-cost': 'percent',
};
const FINDING_STYLE: Record<string, { icon: string; tint: 'red' | 'blue' | 'teal' | 'gold' }> = {
  advisor: { icon: 'percent', tint: 'red' },
  instructions: { icon: 'database', tint: 'blue' },
  'context-creep': { icon: 'database', tint: 'blue' },
  breaks: { icon: 'chat', tint: 'teal' },
  'verify-loop': { icon: 'check', tint: 'teal' },
  concentration: { icon: 'percent', tint: 'gold' },
  'long-sessions': { icon: 'layers', tint: 'gold' },
  exploration: { icon: 'search', tint: 'blue' },
  loops: { icon: 'loop', tint: 'gold' },
  delivery: { icon: 'upload', tint: 'teal' },
};

/** Weekly cost per request as an area chart — the hero's trend. */
function TrendArea({ weeks }: { weeks: AgentSummaryData['trend']['weeks'] }) {
  const pts = weeks.filter((w) => w.sessions > 0);
  if (pts.length < 2) return null;
  const W = 520, H = 120, max = Math.max(...pts.map((p) => p.costPerRequest)) * 1.15 || 1;
  const x = (i: number) => 6 + ((W - 12) * i) / (pts.length - 1);
  const y = (v: number) => H - 8 - ((H - 20) * v) / max;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.costPerRequest).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <figure className="hero-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Cost per request by week">
        <title>{pts.map((p) => `week of ${p.week}: $${p.costPerRequest.toFixed(3)} per request`).join('\n')}</title>
        <defs>
          <linearGradient id="heroFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--green)" stopOpacity="0.32" />
            <stop offset="1" stopColor="var(--green)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${line} L${x(pts.length - 1)},${H} L${x(0)},${H} Z`} fill="url(#heroFill)" />
        <path d={line} fill="none" stroke="var(--green)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <circle cx={x(pts.length - 1)} cy={y(last.costPerRequest)} r="4" fill="var(--green)" />
      </svg>
      <figcaption>Cost per request, by week · now ${last.costPerRequest.toFixed(2)}</figcaption>
    </figure>
  );
}

function RecommendationCard({ a, rank }: { a: SummaryAction; rank: number }) {
  const [open, setOpen] = useState(false);
  const b = BASIS[a.basis];
  return (
    <article className={`rec ${open ? 'open' : ''}`}>
      <div className="rec-side">
        <span className="rec-rank">{rank}</span>
        <span className="rec-icon"><Ic n={ACTION_ICON[a.id] ?? (a.id.startsWith('command-') ? 'terminal' : 'spark')} /></span>
      </div>
      <div className="rec-body">
        <div className="rec-head">
          <h4>{a.title}</h4>
          <span className={`rec-basis b-${a.basis}`} title={b.hint}>{b.label}</span>
        </div>
        {a.perMonthUsd
          ? <div className="rec-money"><span className="tnum">{money(a.perMonthUsd.low)}–{money(a.perMonthUsd.high)}</span><span>/month</span></div>
          : <div className="rec-money muted"><span>Not priced</span></div>}
        <p className="rec-why">{a.why}</p>
        {open && a.files.map((f) => (
          <div key={f.path} className="rec-file">
            <div className="rec-file-path"><Ic n="pencil" /><code>{f.path}</code>{f.note ? <span> — {f.note}</span> : null}</div>
            <pre>{f.content}</pre>
          </div>
        ))}
      </div>
      {a.files.length > 0 && (
        <button type="button" className="rec-toggle" onClick={() => setOpen(!open)} aria-expanded={open}
          aria-label={open ? 'Hide the change' : 'Show what to change'} title={open ? 'Hide the change' : 'What to change'}>
          <Ic n={open ? 'chevronDown' : 'chevronRight'} />
        </button>
      )}
    </article>
  );
}

export function AgentSummary({
  s, agentId, sub, onOpenSession, onViewSessions,
}: {
  s: AgentSummaryData;
  agentId: string;
  sub: string;
  onOpenSession?: (runId: string) => void;
  onViewSessions?: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const priced = s.actions.filter((a) => a.perMonthUsd);
  const all = [...priced, ...s.actions.filter((a) => !a.perMonthUsd)];
  const recs = showAll ? all : priced.slice(0, 2);
  const top = priced[0];
  return (
    <div className="agent-block">
      <section className="hero">
        <div className="hero-main">
          <div className="hero-id">
            <span className="hero-avatar"><Ic n="users" /></span>
            <div>
              <div className="hero-name">{agentId}</div>
              <div className="hero-sub">{sub}</div>
            </div>
          </div>
          {top && (
            <div className="hero-save">
              <span className="hero-money tnum">{money(top.perMonthUsd!.low)}–{money(top.perMonthUsd!.high)}</span>
              <span className="hero-per">per month · top change</span>
              <span className="hero-up" aria-hidden="true"><Ic n="arrowUp" /></span>
            </div>
          )}
          <p className="hero-headline">{s.headline}</p>
        </div>
        <TrendArea weeks={s.trend.weeks} />
      </section>

      {recs.length > 0 && (
        <section>
          <div className="sec-head">
            <h3>Top recommendations</h3>
            {all.length > 2 && (
              <button type="button" className="sec-link" onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Show top 2' : `View all ${all.length}`} <Ic n="arrowRight" />
              </button>
            )}
          </div>
          <div className="recs">
            {recs.map((a, i) => <RecommendationCard key={a.id} a={a} rank={i + 1} />)}
          </div>
        </section>
      )}

      {s.findings.length > 0 && (
        <section>
          <div className="sec-head"><h3>Why it costs what it does</h3></div>
          <div className="whys">
            {s.findings.slice(0, 4).map((f) => {
              const st = FINDING_STYLE[f.id] ?? { icon: 'bulb', tint: 'blue' as const };
              return (
                <article key={f.id} className={`why tint-${st.tint}`}>
                  <span className="why-icon"><Ic n={st.icon} /></span>
                  <div>
                    <div className="why-value tnum">{f.value}</div>
                    <div className="why-title">{f.title}</div>
                    <p className="why-text">{f.sentence}</p>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {s.sessions.length > 0 && (
        <section>
          <div className="sec-head">
            <h3>Most expensive sessions</h3>
            {onViewSessions && <button type="button" className="sec-link" onClick={onViewSessions}>View all sessions <Ic n="arrowRight" /></button>}
          </div>
          <div className="sess-table-wrap">
            <table className="sess-tbl">
              <thead><tr><th>Session</th><th className="num">Cost</th><th className="num">Length</th><th className="num">Peak context</th><th>Outcome</th><th aria-label="Open" /></tr></thead>
              <tbody>
                {s.sessions.map((x) => (
                  <tr key={x.runId} className={onOpenSession ? 'clickable' : ''} onClick={() => onOpenSession?.(x.runId)}
                    tabIndex={onOpenSession ? 0 : undefined} onKeyDown={(e) => { if (e.key === 'Enter') onOpenSession?.(x.runId); }}>
                    <td><span className="sess-title">{x.title ?? x.runId.slice(0, 8)}</span>{x.startedAt && <span className="sess-date">{new Date(x.startedAt).toLocaleDateString()}</span>}</td>
                    <td className="num tnum">{money(x.costUsd)}</td>
                    <td className="num tnum">{x.requestsX.toFixed(1)}× median</td>
                    <td className="num tnum">{Math.round(x.peakContext / 1000)}k</td>
                    <td><span className={`outcome ${x.delivered ? 'ok' : ''}`}>{x.delivered ? 'committed / pushed' : 'no commit or push'}</span>
                      {x.compactionSavesUsd != null && <span className="sess-save">compacting: −{money(x.compactionSavesUsd)}</span>}</td>
                    <td className="chev">{onOpenSession && <Ic n="chevronRight" />}</td>
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
