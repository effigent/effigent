// E25 — within-session determinism. Same model as predictability.ts (Witten–Bell over last two decisions + last
// call failed), scored on later sessions — but now ALSO learning from the current session as it unfolds (each
// decision is added to the tables right after it is predicted). If loops inside runs are where determinism lives,
// coverage should jump.
import fs from 'node:fs';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
const dec = (r) => (r.tools.length ? r.tools.map((t) => t.action).sort().join('&') : 'respond');
function run(S, withinSession) {
  const sorted = [...S].sort((a, b) => a.start.localeCompare(b.start)); const cut = Math.floor(sorted.length * 0.7);
  const table = new Map(), prior = new Map(); let priorN = 0;
  const rows = (s) => { const d = s.reqs.map(dec); return s.reqs.map((r, k) => ({ y: d[k], keys: [`2|${d[k - 2] ?? 'S'}|${d[k - 1] ?? 'S'}|${s.reqs[k - 1]?.tools.some((t) => t.err) ? 'E' : 'ok'}`, `1|${d[k - 1] ?? 'S'}|${s.reqs[k - 1]?.tools.some((t) => t.err) ? 'E' : 'ok'}`, `0`], cost: r.cost })); };
  const learn1 = (x) => { prior.set(x.y, (prior.get(x.y) ?? 0) + 1); priorN++; for (const k of x.keys) { const m = table.get(k) ?? table.set(k, new Map()).get(k); m.set(x.y, (m.get(x.y) ?? 0) + 1); } };
  for (const s of sorted.slice(0, cut)) rows(s).forEach(learn1);
  let n = 0, c80 = 0, ok80 = 0, cost = 0, cost80 = 0;
  for (const s of sorted.slice(cut)) { const R = rows(s);
    for (const x of R) { const levels = [...x.keys].reverse().map((k) => table.get(k)); const vocab = prior.size || 1;
      const p = (y) => { let q = ((prior.get(y) ?? 0) + 1) / (priorN + vocab + 1); for (const m of levels) { if (!m) continue; const tot = [...m.values()].reduce((a, b) => a + b, 0); const l = tot / (tot + m.size + 5); q = l * ((m.get(y) ?? 0) / tot) + (1 - l) * q; } return q; };
      const cands = new Set(); for (const m of levels) if (m) for (const y of m.keys()) cands.add(y);
      let top = '', pt = 0; for (const y of cands) { const v = p(y); if (v > pt) { pt = v; top = y; } }
      n++; cost += x.cost; if (pt >= 0.8) { c80++; if (top === x.y) { ok80++; cost80 += x.cost; } }
      if (withinSession) learn1(x); }
    if (!withinSession) R.forEach(learn1); }
  return { n, cov: c80 / n, prec: c80 ? ok80 / c80 : 0, spend: cost80 / cost };
}
const byP = {}; for (const s of ds) (byP[s.project] ??= []).push(s);
for (const [p, S] of Object.entries(byP)) { if (S.length < 8) continue; const a = run(S, false), b = run(S, true);
  console.log(`${p.slice(-22).padEnd(22)} history only: ${(100 * a.cov).toFixed(1)}% @ ${(100 * a.prec).toFixed(0)}% (${(100 * a.spend).toFixed(1)}% spend) → + current session: ${(100 * b.cov).toFixed(1)}% @ ${(100 * b.prec).toFixed(0)}% (${(100 * b.spend).toFixed(1)}% spend)`); }
