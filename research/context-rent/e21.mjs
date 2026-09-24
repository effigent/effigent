// E21 — candidate plain-language findings: (a) spend concentration in marathon sessions, (b) breaks: returning to a
// long session after the 1h cache expired re-writes the whole context — what would compacting first have saved?
// (c) weekly trend of cost per request.
import fs from 'node:fs'; import { pricingFor } from '../../packages/core/dist/index.js';
const ds = JSON.parse(fs.readFileSync(process.argv[2])); const byP = {}; for (const s of ds) (byP[s.project] ??= []).push(s);
for (const [p, S] of Object.entries(byP)) { if (S.length < 8) continue;
  const costs = S.map((s) => s.reqs.reduce((a, r) => a + r.cost, 0)).sort((a, b) => b - a); const tot = costs.reduce((a, b) => a + b, 0);
  const top10 = costs.slice(0, Math.ceil(S.length * 0.1)).reduce((a, b) => a + b, 0);
  // breaks
  let breaks = 0, paid = 0, avoidable = 0;
  for (const s of S) for (let k = 1; k < s.reqs.length; k++) { const r = s.reqs[k], q = s.reqs[k - 1]; const gap = (new Date(r.ts) - new Date(q.ts)) / 1000;
    if (gap < 3300 || r.model !== q.model || q.ctx < 150000 || r.cw < 0.5 * q.ctx) continue;
    const pr = pricingFor(r.model), rp = pr.inputPerM * (pr.cacheReadMult ?? 0.1) / 1e6, wp = pr.inputPerM * 2 / 1e6, op = pr.outputPerM / 1e6; const B = s.reqs[0].ctx;
    const K = q.ctx * rp + 12000 * op + (B + 12000 + 15000) * wp + 8 * ((B + 12000) * rp + 300 * op);
    breaks++; paid += q.ctx * wp; avoidable += Math.max(0, q.ctx * wp - K - (B + 12000) * wp); }
  // weekly trend
  const wk = {}; for (const s of S) for (const r of s.reqs) { const d = new Date(r.ts); const w = new Date(d - ((d.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10); const x = wk[w] ??= { c: 0, n: 0 }; x.c += r.cost; x.n++; }
  const weeks = Object.entries(wk).sort().map(([w, x]) => `${w.slice(5)} $${(x.c / x.n).toFixed(3)}/req`);
  console.log(`${p.slice(0, 28).padEnd(28)} top 10% of sessions = ${(100 * top10 / tot).toFixed(0)}% of spend · returns after >55min to a ≥150k session: ${breaks}, re-warm paid $${paid.toFixed(0)}, avoidable by compacting first ≈$${avoidable.toFixed(0)} · weeks: ${weeks.join(' → ')}`); }
