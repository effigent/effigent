import { useEffect, useState } from 'react';
import { Ic } from '../icons.tsx';
import { money } from './AgentSummary.tsx';

/**
 * Suggestions & results — every recommendation Effigent made for this agent, and,
 * once applied, whether it actually saved tokens (GET/POST /api/v1/experiments,
 * engine/experiments.ts). The measurement is matched by position in the session,
 * carries a 95% interval, and checks the change's mechanism before its money.
 */

interface Measured { before: number; after: number; changePct: number; ci: [number, number] }
interface Result {
  appliedAt: string;
  before: { sessions: number; requests: number };
  after: { sessions: number; requests: number };
  tokensPerRequest: Measured | null;
  costPerRequest: Measured | null;
  primary: (Measured & { name: string }) | null;
  quality: { ok: boolean };
  verdict: 'collecting' | 'not-in-effect' | 'working' | 'confirmed' | 'regressed' | 'inconclusive';
  inEffect: boolean | null;
  sessionsNeeded: number | null;
  realizedPerMonthUsd: number | null;
}
interface Experiment {
  recId: string;
  title: string;
  basis: string;
  firstSuggestedAt: string;
  predictedPerMonthUsd: { low: number; high: number } | null;
  appliedAt?: string;
  source?: 'marked' | 'detected';
  result: Result | null;
}

const pct = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}%`;
const day = (iso: string) => new Date(iso).toLocaleDateString();

const STATUS: Record<Result['verdict'] | 'not-applied', { label: string; cls: string; hint: string }> = {
  'not-applied': { label: 'Not applied', cls: 'st-idle', hint: 'Suggested, not applied yet. Mark it when you make the change.' },
  collecting: { label: 'Collecting data', cls: 'st-wait', hint: 'Needs at least 3 sessions on each side of the change.' },
  'not-in-effect': { label: 'Not in effect', cls: 'st-warn', hint: 'The change was marked applied, but the sessions after it do not show its effect. Check that the file was picked up.' },
  working: { label: 'Working', cls: 'st-go', hint: 'The change took effect; the saving is not yet statistically clear.' },
  confirmed: { label: 'Saving confirmed', cls: 'st-ok', hint: 'The change took effect and the whole 95% interval is a saving, with quality intact.' },
  regressed: { label: 'Got worse', cls: 'st-bad', hint: 'Cost per request rose, or errors / interruptions / denials rose after the change. It may also be unrelated drift.' },
  inconclusive: { label: 'Inconclusive', cls: 'st-idle', hint: 'The 95% interval spans zero — more sessions needed.' },
};

function MarkApplied({ onSave }: { onSave: (date: string) => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  if (!open) return <button type="button" className="chip exp-btn" onClick={() => setOpen(true)}><Ic n="check" /> Mark as applied</button>;
  return (
    <span className="exp-mark">
      <label className="sr-only" htmlFor="exp-date">Applied on</label>
      <input id="exp-date" type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
      <button type="button" className="chip exp-btn" onClick={() => onSave(`${date}T00:00:00Z`)}>Save</button>
      <button type="button" className="sec-link" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}

export function Experiments({ agentId }: { agentId: string }) {
  const [items, setItems] = useState<Experiment[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => fetch(`/api/v1/experiments?agent=${encodeURIComponent(agentId)}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((d: { experiments?: Experiment[]; note?: string }) => { setItems(d.experiments ?? []); setNote(d.note ?? null); })
    .catch((e: Error) => setError(e.message));
  useEffect(() => { load(); }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const post = (body: object, recId: string) => {
    setBusy(recId);
    fetch('/api/v1/experiments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: agentId, recId, ...body }) })
      .then((r) => (r.ok ? load() : r.json().then((d) => setError(d.error ?? `HTTP ${r.status}`))))
      .finally(() => setBusy(null));
  };

  if (error) return <div className="exp-empty">Couldn’t load results: {error}.</div>;
  if (!items) return <div className="exp-empty">Loading suggestions and results…</div>;
  if (!items.length) return <div className="exp-empty">{note ?? 'Nothing recorded yet — results appear after the first analysis run.'}</div>;
  const verified = items.reduce((s, x) => s + (x.result?.realizedPerMonthUsd ?? 0), 0);

  return (
    <section className="exp">
      <div className="sec-head">
        <h3>Suggestions &amp; results</h3>
        <span className="exp-verified" title="Confirmed savings only: matched before/after, 95% interval entirely a saving, quality intact.">
          Verified so far: <b className="tnum">{verified > 0 ? `${money(verified)}/month` : '—'}</b>
        </span>
      </div>
      <div className="sess-table-wrap">
        <table className="sess-tbl exp-tbl">
          <thead><tr><th>Recommendation</th><th className="num">Predicted</th><th>Status</th><th>Measured after applying</th><th className="num">Sessions</th><th aria-label="Action" /></tr></thead>
          <tbody>
            {items.map((x) => {
              const r = x.result;
              const st = STATUS[x.appliedAt ? (r?.verdict ?? 'collecting') : 'not-applied'];
              return (
                <tr key={x.recId}>
                  <td>
                    <div className="sess-title">{x.title}</div>
                    <div className="exp-sub">suggested {day(x.firstSuggestedAt)}{x.appliedAt && <> · applied {day(x.appliedAt)}{x.source === 'detected' ? ' (detected)' : ''}</>}</div>
                  </td>
                  <td className="num tnum">{x.predictedPerMonthUsd ? `${money(x.predictedPerMonthUsd.low)}–${money(x.predictedPerMonthUsd.high)}` : '—'}</td>
                  <td>
                    <span className={`exp-status ${st.cls}`} title={st.hint}>{st.label}</span>
                    {r?.verdict === 'working' && r.sessionsNeeded ? <div className="exp-sub">≈{r.sessionsNeeded} sessions per side to be sure</div> : null}
                  </td>
                  <td>
                    {r?.tokensPerRequest ? (
                      <div className="exp-measure">
                        <span className={`tnum ${r.tokensPerRequest.changePct < 0 ? 'down' : 'up'}`}>{pct(r.tokensPerRequest.changePct)} tokens/request</span>
                        <span className="exp-ci tnum">95% {pct(r.tokensPerRequest.ci[0])} … {pct(r.tokensPerRequest.ci[1])}</span>
                        {r.costPerRequest && <span className="exp-sub tnum">cost/request {pct(r.costPerRequest.changePct)}{r.realizedPerMonthUsd ? ` · ≈${money(r.realizedPerMonthUsd)}/month saved` : ''}</span>}
                        {r.primary && <span className="exp-sub">{r.primary.name}: {r.primary.name.startsWith('share') ? `${(r.primary.before * 100).toFixed(0)}% → ${(r.primary.after * 100).toFixed(0)}%` : `${Math.round(r.primary.before / 1000)}k → ${Math.round(r.primary.after / 1000)}k`}</span>}
                        {!r.quality.ok && <span className="exp-sub bad">errors, interruptions or denials rose</span>}
                      </div>
                    ) : <span className="exp-sub">{x.appliedAt ? 'waiting for sessions after the change' : '—'}</span>}
                  </td>
                  <td className="num tnum">{r ? `${r.before.sessions} / ${r.after.sessions}` : '—'}</td>
                  <td className="exp-act">
                    {busy === x.recId ? <span className="exp-sub">Saving…</span>
                      : x.appliedAt ? <button type="button" className="sec-link" onClick={() => post({ undo: true }, x.recId)}>Undo</button>
                      : <MarkApplied onSave={(date) => post({ appliedAt: date }, x.recId)} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="exp-foot">Before/after is compared at the same point in the session (session cost grows with its length), with a 95% interval from resampling sessions. A saving counts only when the change visibly took effect, the whole interval is a saving, and errors, interruptions and denials did not rise.</p>
    </section>
  );
}
