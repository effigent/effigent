import { useState } from 'react';

interface Attempt { tier: string; model: string; passRate: number; samplesTried: number; passed: number }
interface RouteResult {
  available: boolean;
  note?: string;
  status?: string;
  originalModel?: string;
  chosen?: { tier: string; model: string; passRate: number };
  attempts?: Attempt[];
  savingsShare?: number | null;
}

const shortModel = (m: string) => m.split('/').pop() ?? m;

/** "Test a smaller model" indicator — initiates a live routing test for this
 *  agent (cheaper same-vendor models on recorded runs) and shows the result. */
export function RouteTest({ agent }: { agent: string }) {
  const [state, setState] = useState<'idle' | 'testing' | 'done'>('idle');
  const [r, setR] = useState<RouteResult | null>(null);

  const run = () => {
    setState('testing');
    setR(null);
    fetch(`/api/v1/route-test?agent=${encodeURIComponent(agent)}`)
      .then((res) => res.json())
      .then((d: RouteResult) => { setR(d); setState('done'); })
      .catch(() => { setR({ available: true, status: 'error', note: 'Request failed.' }); setState('done'); });
  };

  return (
    <div className="route-test">
      <div className="route-test-head">
        <span className="route-test-title"><b>⚡ Smaller-model test</b> — can a cheaper model in the same family run this flow?</span>
        <button className="route-test-btn" onClick={run} disabled={state === 'testing'}>
          {state === 'testing' ? 'Testing…' : state === 'done' ? 'Re-test' : 'Test a smaller model'}
        </button>
      </div>
      {state === 'testing' && <div className="route-test-body">Trying cheaper same-vendor models on recorded runs, cheapest first…</div>}
      {state === 'done' && r && <RouteResultView r={r} />}
    </div>
  );
}

function Ladder({ attempts, chosenTier }: { attempts?: Attempt[]; chosenTier?: string }) {
  if (!attempts?.length) return null;
  return (
    <div className="route-ladder">
      {attempts.map((a) => (
        <span key={a.tier} className={`route-step ${chosenTier === a.tier ? 'ok' : 'fail'}`}>
          {a.tier} · <span className="tnum">{Math.round(a.passRate * 100)}%</span>
        </span>
      ))}
    </div>
  );
}

function RouteResultView({ r }: { r: RouteResult }) {
  if (!r.available || r.status === 'insufficient' || r.status === 'error') {
    return <div className="route-test-body">{r.note}</div>;
  }
  if (r.status === 'validated' && r.chosen) {
    return (
      <div className="route-test-body">
        <div className="route-ok">
          ✓ <b>{r.chosen.tier}</b> ({shortModel(r.chosen.model)}) reproduced the outcome{' '}
          <span className="tnum">{Math.round(r.chosen.passRate * 100)}%</span> of runs
          {r.savingsShare != null && r.savingsShare > 0 && (
            <span className="route-save"> · ~{Math.round(r.savingsShare * 100)}% cheaper per run</span>
          )}
        </div>
        <Ladder attempts={r.attempts} chosenTier={r.chosen.tier} />
      </div>
    );
  }
  if (r.status === 'unfit') {
    return (
      <div className="route-test-body">
        <div className="route-unfit">✗ No smaller model reproduced the outcome — keep {r.originalModel}.</div>
        <Ladder attempts={r.attempts} />
      </div>
    );
  }
  if (r.status === 'no-candidate') return <div className="route-test-body">{r.originalModel} is already the smallest tier in its family.</div>;
  if (r.status === 'unknown-model') return <div className="route-test-body">Couldn’t map {r.originalModel} to a known vendor family.</div>;
  return <div className="route-test-body">{r.note ?? 'No result.'}</div>;
}
