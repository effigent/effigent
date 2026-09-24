// E13 — spill exploration to a subagent. A burst = ≥B consecutive requests whose tools are all exploratory.
// Counterfactual: the burst runs in an isolated subagent (fresh context: subBase + its own growth, model M),
// and only a summary (ratio ρ of the burst's deposits) enters the main context. Main-context savings = the
// burst deposits' rent minus the summary's rent, plus the main-thread requests the burst no longer spends.
import fs from 'node:fs'; import { isExplore, readPrice } from './lib.mjs';
import { pricingFor } from '../../packages/core/dist/index.js';
const ds = JSON.parse(fs.readFileSync(process.argv[2]));
function run({ B = 3, rho = 0.2, subModel = 'claude-sonnet-5' }) {
  let saved = 0, subCost = 0, bursts = 0, burstReqs = 0;
  for (const s of ds) { const R = s.reqs; const suffix = new Array(R.length + 1).fill(0); for (let k = R.length - 1; k >= 0; k--) suffix[k] = suffix[k + 1] + readPrice(R[k].model);
    // reset boundaries: carry stops at a reset; approximate by stopping at the next big drop
    const nextReset = new Array(R.length).fill(R.length); for (let k = R.length - 2; k >= 0; k--) nextReset[k] = R[k + 1].ctx < 0.6 * R[k].ctx ? k + 1 : nextReset[k + 1];
    let k = 0; while (k < R.length) { let e = k; while (e < R.length && R[e].tools.length && R[e].tools.every((t) => isExplore(t.action))) e++;
      if (e - k >= B && e < R.length) { bursts++; burstReqs += e - k; const end = nextReset[k];
        const dep = Math.max(0, R[e].ctx - R[k].ctx); // what the burst added to main context
        const carryAfter = suffix[Math.min(e + 1, end)] - suffix[end];
        // main thread: burst requests vanish (their own read of the growing context) and deposits shrink to ρ
        let burstMain = 0; for (let j = k; j < e; j++) burstMain += R[j].cost;
        const p = pricingFor(R[k].model); const oneCall = R[k].ctx * readPrice(R[k].model) + dep * rho * p.inputPerM * 2 / 1e6 + 600 * p.outputPerM / 1e6; // the Agent call + summary written
        saved += burstMain + dep * (1 - rho) * carryAfter - oneCall;
        // subagent: fresh context grows from subBase by the same deposits, on subModel
        const sp = pricingFor(subModel); let ctx = R[0].ctx; /* a subagent loads the same CLAUDE.md/tools base */
        subCost += dep * rho * sp.outputPerM / 1e6; /* and GENERATES the summary it returns */ for (let j = k; j < e; j++) { const d = Math.max(0, R[j + 1].ctx - R[j].ctx); subCost += (ctx * sp.inputPerM * (sp.cacheReadMult ?? 0.1) + d * sp.inputPerM * 2 + R[j].out * sp.outputPerM) / 1e6; ctx += d; } }
      k = Math.max(e, k + 1); } }
  return { bursts, burstReqs, saved, subCost, net: saved - subCost };
}
const total = ds.reduce((a, s) => a + s.reqs.reduce((b, r) => b + r.cost, 0), 0);
for (const cfg of [{ B: 3, rho: 0.2 }, { B: 3, rho: 0.4 }, { B: 5, rho: 0.2 }, { B: 5, rho: 0.4 }, { B: 3, rho: 0.2, subModel: 'claude-opus-5' }, { B: 3, rho: 0.4, subModel: 'claude-haiku-4-5' }]) {
  const r = run(cfg); console.log(`burst≥${cfg.B} summary=${cfg.rho * 100}% sub=${cfg.subModel ?? 'claude-sonnet-5'}: ${r.bursts} bursts (${r.burstReqs} requests) main saves $${r.saved.toFixed(0)} − subagent $${r.subCost.toFixed(0)} = net $${r.net.toFixed(0)} (${(100 * r.net / total).toFixed(1)}%)`); }
console.log('--- at the MEASURED live-out (E13b) ---');
for (const cfg of [{ B: 3, rho: 0.55 }, { B: 3, rho: 0.8 }, { B: 5, rho: 0.55 }, { B: 5, rho: 0.8 }, { B: 3, rho: 1.0 }]) { const r = run(cfg); console.log(`burst≥${cfg.B} summary=${cfg.rho * 100}%: net $${r.net.toFixed(0)} (${(100 * r.net / total).toFixed(1)}%)  [main saves $${r.saved.toFixed(0)}, subagent $${r.subCost.toFixed(0)}]`); }
