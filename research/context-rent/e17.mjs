// E17 — context as inventory (EOQ). Per agent: base B, deposit rate d (tokens/request), read price p ($/token/request),
// reorder cost K (one compaction: read-all + summary + prefix rewrite + re-exploration, p50 scenario).
// Holding: carrying x tokens costs p·x per request. Between compactions of length L requests: holding ≈ p(B·L + d·L²/2).
// Minimizing (K + p·d·L²/2)/L → L* = sqrt(2K/(p·d)); threshold T* = B + summary + d·L*.
// Validate against the trace-replay simulator's p50-optimal threshold per agent.
import fs from 'node:fs'; import { simulate } from './sim.mjs'; import { pricingFor } from '../../packages/core/dist/index.js';
const ds = JSON.parse(fs.readFileSync(process.argv[2])); const byP = {}; for (const s of ds) (byP[s.project] ??= []).push(s);
const med = (v) => [...v].sort((a, b) => a - b)[v.length >> 1];
for (const [p, S] of Object.entries(byP)) { if (S.length < 4) continue;
  const B = med(S.map((s) => s.reqs[0].ctx)); const dep = []; for (const s of S) for (let k = 1; k < s.reqs.length; k++) { const d = s.reqs[k].ctx - s.reqs[k - 1].ctx; if (d > 0 && d < 60000) dep.push(d); }
  const d = dep.reduce((a, b) => a + b, 0) / dep.length; const pr = pricingFor(S[0].reqs[0].model); const rp = pr.inputPerM * (pr.cacheReadMult ?? 0.1) / 1e6; const wp = pr.inputPerM * 2 / 1e6, op = pr.outputPerM / 1e6;
  const K = (T) => T * rp + 12000 * op + (B + 12000) * wp + 15000 * wp + 8 * ((B + 12000) * rp + 300 * op); // p50 scenario, as the simulator
  let T = 300e3; for (let i = 0; i < 20; i++) { const L = Math.sqrt(2 * K(T) / (rp * d)); T = B + 12000 + d * L; } // fixed point (K depends on T)
  const base = S.reduce((a, s) => a + simulate(s).cost, 0); const sweep = [150e3, 200e3, 250e3, 300e3, 400e3, 500e3, 700e3].map((t) => ({ t, save: base - S.reduce((a, s) => a + simulate(s, { T: t }).cost, 0) }));
  const best = sweep.sort((a, b) => b.save - a.save)[0];
  const atEoq = base - S.reduce((a, s) => a + simulate(s, { T: Math.round(T) }).cost, 0);
  console.log(`${p.padEnd(32)} B=${Math.round(B / 1e3)}k d=${Math.round(d)} tok/req  K≈$${K(T).toFixed(2)}  EOQ T*=${Math.round(T / 1e3)}k (saves $${atEoq.toFixed(0)})   simulator p50-best=${best.t / 1e3}k (saves $${best.save.toFixed(0)})`); }
