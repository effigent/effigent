// E1 — anatomy of spend: which physical quantity is the money?
import fs from 'node:fs'; import { pricingFor } from '../../packages/core/dist/index.js';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
const A = { out: 0, think: 0, read: 0, write5: 0, write1h: 0, fresh: 0, advisor: 0 }; let total = 0;
let idleWriteUsd = 0, idleEvents = 0, idleGaps = []; let growth = [];
for (const s of ds) { let prev = null;
  for (const r of s.reqs) { const p = pricingFor(r.model); const rm = p.cacheReadMult ?? 0.1;
    const parts = { out: (r.out - r.think) * p.outputPerM / 1e6, think: r.think * p.outputPerM / 1e6, read: r.cr * p.inputPerM * rm / 1e6, write5: (r.cw - r.cw1h) * p.inputPerM * 1.25 / 1e6, write1h: r.cw1h * p.inputPerM * 2 / 1e6, fresh: r.in * p.inputPerM / 1e6 };
    const base = Object.values(parts).reduce((a, b) => a + b, 0); parts.advisor = Math.max(0, r.cost - base);
    for (const k in parts) A[k] += parts[k]; total += r.cost;
    const ctx = r.in + r.cw + r.cr;
    if (prev) { const gap = (new Date(r.ts) - new Date(prev.ts)) / 1000; const prevCtx = prev.in + prev.cw + prev.cr;
      // a cold rewrite: most of the previous prefix came back as a WRITE, not a read
      if (r.cw > 0.5 * prevCtx && prevCtx > 20000 && prev.model === r.model) { idleEvents++; idleWriteUsd += Math.min(r.cw, prevCtx) * p.inputPerM * ((r.cw1h > 0 ? 2 : 1.25) - rm) / 1e6; idleGaps.push(gap); } }
    prev = r; }
}
console.log('total $', total.toFixed(0)); for (const [k, v] of Object.entries(A)) console.log(k.padEnd(8), ('$' + v.toFixed(0)).padStart(7), (100 * v / total).toFixed(1) + '%');
idleGaps.sort((a, b) => a - b); const q = (x) => idleGaps[Math.floor(idleGaps.length * x)];
console.log('\ncold prefix rewrites', idleEvents, 'penalty $', idleWriteUsd.toFixed(0), 'gap before rewrite (s): p10', q(.1)?.toFixed(0), 'p50', q(.5)?.toFixed(0), 'p90', q(.9)?.toFixed(0));
console.log('rewrites after gap > 1h:', idleGaps.filter((g) => g > 3600).length, ' 5m-1h:', idleGaps.filter((g) => g > 300 && g <= 3600).length, ' <5m:', idleGaps.filter((g) => g <= 300).length);
// per-session: cost/turn vs ctx elasticity (log-log slope) — pooled
const xs = [], ys = []; for (const s of ds) for (const r of s.reqs) { const ctx = r.in + r.cw + r.cr; if (ctx > 1e4 && r.cost > 0) { xs.push(Math.log(ctx)); ys.push(Math.log(r.cost)); } }
const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
console.log('\nelasticity d log(cost/request) / d log(context) =', (sxy / sxx).toFixed(2), ' r=', (sxy / Math.sqrt(sxx * syy)).toFixed(2), ' n=', xs.length);
// how big do sessions get? max context and #requests
const maxC = ds.map((s) => Math.max(...s.reqs.map((r) => r.in + r.cw + r.cr))).sort((a, b) => a - b); console.log('max ctx per session p50', maxC[maxC.length >> 1], 'p90', maxC[Math.floor(maxC.length * .9)]);
const ev = {}; for (const s of ds) for (const e of s.ev) ev[e.t] = (ev[e.t] || 0) + 1; console.log('events', ev);
