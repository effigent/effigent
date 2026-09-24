// E16 — session cost = N (requests) × C̄ (mean context per request) × p (effective $ per context token) + output.
// log(cost_in) = log N + log C̄ + log p exactly (input side). Per agent: which factor explains the variance
// of log session cost (covariance share, sums to 1), and for the top sessions, which factor made them expensive vs the median.
import fs from 'node:fs';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
const byP = {}; for (const s of ds) if (s.reqs.length >= 5) (byP[s.project] ??= []).push(s);
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length; const cov = (a, b) => { const ma = mean(a), mb = mean(b); return mean(a.map((x, i) => (x - ma) * (b[i] - mb))); };
const med = (v) => [...v].sort((a, b) => a - b)[v.length >> 1];
for (const [p, S] of Object.entries(byP)) { if (S.length < 8) continue;
  const rows = S.map((s) => { const N = s.reqs.length; const C = mean(s.reqs.map((r) => r.ctx)); const cost = s.reqs.reduce((a, r) => a + r.cost, 0); return { s, N, C, p: cost / (N * C), cost }; });
  const y = rows.map((r) => Math.log(r.cost)), lN = rows.map((r) => Math.log(r.N)), lC = rows.map((r) => Math.log(r.C)), lp = rows.map((r) => Math.log(r.p));
  const vy = cov(y, y); const sh = [cov(lN, y), cov(lC, y), cov(lp, y)].map((c) => (100 * c / vy).toFixed(0) + '%');
  console.log(`\n${p} (${S.length} sessions, cost p50 $${med(rows.map((r) => r.cost)).toFixed(1)}) — variance of log cost explained by: requests ${sh[0]} · context ${sh[1]} · price ${sh[2]}`);
  const mN = med(rows.map((r) => r.N)), mC = med(rows.map((r) => r.C)), mp = med(rows.map((r) => r.p));
  for (const r of rows.sort((a, b) => b.cost - a.cost).slice(0, 3)) console.log(`   $${r.cost.toFixed(0).padStart(4)}  = ${(r.N / mN).toFixed(1)}× requests · ${(r.C / mC).toFixed(1)}× context · ${(r.p / mp).toFixed(1)}× price   vs median  — "${(r.s.aiTitle ?? '').slice(0, 50)}"`);
}
