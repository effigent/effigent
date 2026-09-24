import fs from 'node:fs'; import { simulate } from './sim.mjs';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
const obs = ds.reduce((a, s) => a + s.reqs.reduce((b, r) => b + r.cost, 0), 0);
const base = ds.reduce((a, s) => a + simulate(s).cost, 0);
console.log(`observed $${obs.toFixed(0)}  simulator @ observed policy $${base.toFixed(0)}  (calibration ${(100 * base / obs).toFixed(1)}%)`);
for (const [label, prm] of [['p50 re-acquisition (15k tok / 8 req)', { reacqTok: 15000, reacqReqs: 8 }], ['p90 re-acquisition (37k tok / 17 req)', { reacqTok: 37000, reacqReqs: 17 }], ['3× p90 (pessimistic)', { reacqTok: 110000, reacqReqs: 50, summaryOut: 30000 }]]) {
  console.log('\n' + label);
  for (const T of [150e3, 200e3, 300e3, 400e3, 500e3, 700e3]) { let c = 0, n = 0; for (const s of ds) { const r = simulate(s, { T, ...prm }); c += r.cost; n += r.compactions; }
    console.log(`  compact at ${(T / 1e3).toFixed(0).padStart(4)}k: $${c.toFixed(0)}  saves $${(base - c).toFixed(0)} (${(100 * (base - c) / base).toFixed(1)}%)  compactions ${n}`); }
}
