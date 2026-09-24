// E6 — PREDICTIVE DETERMINISM. An LLM decision is "deterministic" to the extent a cheap model trained on
// the agent's PAST sessions predicts it. Train variable-order Markov (PPM-style backoff) on the first 70%
// of each project's sessions (by time), score on the last 30%. Report precision/coverage at confidence
// thresholds, and the spend of the requests whose decision was predicted.
import fs from 'node:fs';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
const alpha = process.argv[3] ?? 'action'; // action | family | exact
const tok = (t) => alpha === 'family' ? t.action.split('+')[0].split(':')[0] : alpha === 'exact' ? t.name + '|' + t.input : t.action;
// A decision = the SET of tool calls one request emitted (or END if none).
const decision = (r) => (r.tools.length ? r.tools.map(tok).join(' & ') : 'END');
const byP = {}; for (const s of ds) (byP[s.project] ??= []).push(s);
const ORDER = 4; const res = { total: 0, cost: 0 }; const thr = [0.5, 0.7, 0.8, 0.9, 0.95]; const at = thr.map(() => ({ pred: 0, correct: 0, cost: 0 }));
const calib = Array.from({ length: 10 }, () => ({ n: 0, ok: 0 }));
for (const [p, sess] of Object.entries(byP)) { if (sess.length < 4) continue;
  const cut = Math.floor(sess.length * 0.7); const train = sess.slice(0, cut), test = sess.slice(cut);
  const tables = Array.from({ length: ORDER + 1 }, () => new Map());
  const learn = (seq) => { for (let i = 0; i < seq.length; i++) for (let o = 0; o <= ORDER; o++) { if (i - o < 0) break; const ctx = seq.slice(i - o, i).join('⟩'); const m = tables[o].get(ctx) ?? tables[o].set(ctx, new Map()).get(ctx); m.set(seq[i], (m.get(seq[i]) ?? 0) + 1); } };
  const seqOf = (s) => ['START', ...s.reqs.map(decision)];
  for (const s of train) learn(seqOf(s));
  for (const s of test) { const seq = seqOf(s);
    for (let i = 1; i < seq.length; i++) { const r = s.reqs[i - 1]; res.total++; res.cost += r.cost;
      // longest context with enough evidence
      let best = null; for (let o = Math.min(ORDER, i); o >= 1; o--) { const m = tables[o].get(seq.slice(i - o, i).join('⟩')); if (!m) continue; const n = [...m.values()].reduce((a, b) => a + b, 0); if (n < 5) continue; const [top, c] = [...m.entries()].sort((a, b) => b[1] - a[1])[0]; const conf = (c + 1) / (n + 2); best = { top, conf }; break; }
      if (best) { const ok = best.top === seq[i]; const b = Math.min(9, Math.floor(best.conf * 10)); calib[b].n++; if (ok) calib[b].ok++;
        thr.forEach((t, j) => { if (best.conf >= t) { at[j].pred++; if (ok) { at[j].correct++; at[j].cost += r.cost; } } }); }
    }
    learn(seq); // online: the test session becomes history for the next one (still strictly past-only)
  } }
console.log(`alphabet=${alpha}  held-out decisions ${res.total}, spend $${res.cost.toFixed(0)}`);
thr.forEach((t, j) => console.log(`  conf ≥ ${t}: predicted ${(100 * at[j].pred / res.total).toFixed(1)}% of decisions, precision ${(100 * at[j].correct / Math.max(1, at[j].pred)).toFixed(1)}%, correctly-predicted decisions carry ${(100 * at[j].cost / res.cost).toFixed(1)}% of spend`));
console.log('  calibration (stated conf bucket → observed accuracy):', calib.map((c, i) => c.n ? `${i / 10}:${(c.ok / c.n).toFixed(2)}(${c.n})` : null).filter(Boolean).join(' '));
