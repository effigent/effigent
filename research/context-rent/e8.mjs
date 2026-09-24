import fs from 'node:fs'; import { pricingFor } from '../../packages/core/dist/index.js';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
// (1) simulator assumption: deposit rate (tokens/request) in requests 13..60 after a compaction vs the 48 before it
const pre = [], post = [];
for (const s of ds) for (const e of s.ev.filter((x) => x.t === 'compact')) { const k = s.reqs.findIndex((r) => r.ts > e.ts); if (k < 50 || k + 60 > s.reqs.length) continue;
  const rate = (a, b) => { let d = 0, n = 0; for (let j = a; j < b; j++) { const x = s.reqs[j + 1].ctx - s.reqs[j].ctx; if (x > 0 && x < 60000) { d += x; n++; } } return d / Math.max(1, n); };
  pre.push(rate(k - 49, k - 1)); post.push(rate(k + 12, k + 59)); }
const med = (v) => [...v].sort((a, b) => a - b)[v.length >> 1];
console.log(`(1) deposit tokens/request: before compaction median ${med(pre)?.toFixed(0)}, after (excl. re-acq window) median ${med(post)?.toFixed(0)}  n=${pre.length}`);
// (2) TTL counterfactual: 5m cache (1.25× writes) vs 1h (2×). Under 5m, any gap in (5m,1h] becomes a cold rewrite.
let cost1h = 0, cost5m = 0;
for (const s of ds) for (let k = 0; k < s.reqs.length; k++) { const r = s.reqs[k], p = pricingFor(r.model), ip = p.inputPerM / 1e6, rp = ip * (p.cacheReadMult ?? 0.1);
  const gap = k ? (new Date(r.ts) - new Date(s.reqs[k - 1].ts)) / 1000 : 0; const prevCtx = k ? s.reqs[k - 1].ctx : 0;
  const cold1h = k && gap > 3600, cold5m = k && gap > 300;
  const newTok = k ? Math.max(0, r.ctx - prevCtx) : r.ctx; const carried = r.ctx - newTok;
  cost1h += cold1h ? r.ctx * ip * 2 : carried * rp + newTok * ip * 2;
  cost5m += cold5m ? r.ctx * ip * 1.25 : carried * rp + newTok * ip * 1.25; }
console.log(`(2) input-side cost with 1h TTL $${cost1h.toFixed(0)}  vs 5m TTL $${cost5m.toFixed(0)}  → ${cost5m < cost1h ? '5m cheaper by' : '1h cheaper by'} $${Math.abs(cost1h - cost5m).toFixed(0)}`);
const gaps = []; for (const s of ds) for (let k = 1; k < s.reqs.length; k++) gaps.push((new Date(s.reqs[k].ts) - new Date(s.reqs[k - 1].ts)) / 1000);
console.log(`    inter-request gaps: ${(100 * gaps.filter((g) => g > 300 && g <= 3600).length / gaps.length).toFixed(1)}% in (5m,1h], ${(100 * gaps.filter((g) => g > 3600).length / gaps.length).toFixed(1)}% > 1h`);
// (3) advisor calls
